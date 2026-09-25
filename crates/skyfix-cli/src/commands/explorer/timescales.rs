//! Time scales and calendars as the site's engine answers them: `time-info` and
//! `calendar-convert`. OWNER: cli3 agent.
//!
//! The WASM exports `time_info` and `calendar_convert` (`skyfix_wasm::timescale::native`;
//! EXPLORER_API.md "`time_info`" and "Time scales, Delta-T and calendars"; CONVENTIONS
//! 15.2-15.3). `time_info` is `skyfix_core::time::time_info` with the coverage tier the
//! adapter adds; `--dut1` is the site's DUT1 field (`set_dut1`). `skyfix calendar` prints
//! the same facts for a person in one report; these two print each export's own document.

use anyhow::{Result, anyhow};
use serde_json::json;
use skyfix_core::calendar::{CalendarConversion, CivilDateTime};
use skyfix_core::time::{ClockScale, Dut1Source};
use skyfix_wasm::timescale::native::{self as wasm_time, TimeInfoWire};

use super::args::{Dut1Args, FormatArgs, parse_date};
use super::calendar::{civil_line, display_name, seconds_text, sigma_text};
use super::wire::{call, emit_json, set_explorer_dut1};
use crate::exit;
use crate::report;

/// `DATE | --jd JD`, as `skyfix calendar` takes it.
#[derive(clap::Args, Debug)]
pub struct WhenArg {
    /// A date (`2026-09-24`, `-0584-05-28`) or an instant (`2026-09-24T12:00:00Z`), in the
    /// calendar --calendar names (default: Julian up to 1582-10-04, Gregorian from
    /// 1582-10-15). A date means 00:00 that day.
    #[arg(
        value_name = "DATE",
        allow_hyphen_values = true,
        required_unless_present = "jd",
        conflicts_with = "jd"
    )]
    pub date: Option<String>,
    /// A Julian date on the app's clock (UTC 1972-2035, UT outside) instead of a date.
    #[arg(long, value_name = "JD", allow_negative_numbers = true)]
    pub jd: Option<f64>,
}

impl WhenArg {
    fn jd(&self) -> Result<f64> {
        super::calendar::the_jd(&super::calendar::Args {
            date: self.date.clone(),
            jd: self.jd,
            format: FormatArgs {
                format: crate::cli::OutputFormat::Text,
                json: false,
            },
        })
    }
}

// ---------------------------------------------------------------------------
// time-info
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct TimeInfoArgs {
    #[command(flatten)]
    pub when: WhenArg,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_time_info(a: &TimeInfoArgs) -> Result<u8> {
    let jd = a.when.jd()?;
    set_explorer_dut1(a.dut1.dut1)?;
    let t = call(wasm_time::time_info(jd))?;
    if a.format.is_json() {
        emit_json(&t)?;
    } else {
        report::emit(&render_time_info(&t))?;
    }
    Ok(exit::OK)
}

/// `Label        text` with the label in 13 columns, as `skyfix calendar` lays it out.
fn line(out: &mut String, label: &str, text: &str) {
    let indent = " ".repeat(13);
    for (i, l) in crate::report::wrap(text, 75, &indent)
        .into_iter()
        .enumerate()
    {
        if i == 0 {
            out.push_str(&format!("{label:<13}{}\n", l.trim_start()));
        } else {
            out.push_str(&format!("{l}\n"));
        }
    }
}

fn render_time_info(t: &TimeInfoWire) -> String {
    let mut out = String::from("TIME\n");
    line(
        &mut out,
        "Instant",
        &format!("{} (JD {:.6} on the app's clock)", t.utc, t.jd_utc),
    );
    line(
        &mut out,
        "Clock",
        match t.scale {
            ClockScale::Utc => "UTC, Coordinated Universal Time (the clock from 1972 to 2035)",
            ClockScale::Ut => "UT, Universal Time (UT1): outside the UTC years 1972-2035",
        },
    );
    line(&mut out, "Tier", &t.tier);
    let source = match t.delta_t_source {
        skyfix_core::deltat::DeltaTSource::Iers => "observed by the IERS",
        skyfix_core::deltat::DeltaTSource::Smh2016 => {
            "Stephenson, Morrison & Hohenkerk 2016, 2020 revision"
        }
        skyfix_core::deltat::DeltaTSource::Parabola => "the long-term parabola",
        skyfix_core::deltat::DeltaTSource::Prediction => "predicted",
    };
    line(
        &mut out,
        "Delta-T",
        &format!(
            "{}, standard uncertainty {}: {source} (TT - UT1)",
            seconds_text(t.delta_t_s),
            sigma_text(t.delta_t_sigma_s)
        ),
    );
    line(&mut out, "TT - clock", &seconds_text(t.tt_minus_clock_s));
    let dut1 = match t.dut1_source {
        Dut1Source::Iers => format!(
            "{:+.4} s, standard uncertainty {} (IERS)",
            t.dut1_s,
            sigma_text(t.dut1_sigma_s)
        ),
        Dut1Source::User => format!(
            "{:+.4} s, given (standard uncertainty {})",
            t.dut1_s,
            sigma_text(t.dut1_sigma_s)
        ),
        Dut1Source::Model => "none: the clock is UT1".to_string(),
        Dut1Source::Assumed => "unknown: 0 s, standard uncertainty 0.9 s".to_string(),
    };
    line(&mut out, "UT1 - UTC", &dut1);
    line(
        &mut out,
        "Calendar",
        &format!(
            "{} (the calendar the explorer shows for this date)",
            display_name(t.calendar)
        ),
    );
    out.push_str(&format!("{:<13}{}\n", "Date", civil_line(&t.civil)));
    out.push_str(&format!(
        "{:<13}{}\n",
        "Julian",
        civil_line(&t.julian_civil)
    ));
    for n in &t.notes {
        line(&mut out, "Note", n);
    }
    out
}

// ---------------------------------------------------------------------------
// calendar-convert
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct CalendarConvertArgs {
    #[command(flatten)]
    pub when: WhenArg,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// The request the site's date entry sends: the civil date as typed (in its calendar)
/// for a DATE, the Julian date for `--jd`.
pub fn convert_request(when: &WhenArg) -> Result<serde_json::Value> {
    if let Some(jd) = when.jd {
        if !jd.is_finite() {
            return Err(anyhow!("--jd {jd} is not a finite number"));
        }
        return Ok(json!({ "jd_utc": jd }));
    }
    let s = when
        .date
        .as_deref()
        .ok_or_else(|| anyhow!("give a date or --jd"))?;
    let date_part = s.trim().split('T').next().unwrap_or_default();
    // The calendar the date was typed in: --calendar, else the display rule.
    let date = parse_date(date_part).map_err(|e| anyhow!(e))?;
    let cal = date.calendar;
    let (hour, minute, second) = if s.contains('T') {
        let jd = when.jd()?;
        let c = CivilDateTime::from_jd(jd, cal)
            .ok_or_else(|| anyhow!("{s:?} cannot be written as a civil date"))?;
        (c.hour, c.minute, c.second)
    } else {
        (0, 0, 0.0)
    };
    Ok(json!({"civil": {
        "calendar": cal,
        "year": date.year,
        "month": date.month,
        "day": date.day,
        "hour": hour,
        "minute": minute,
        "second": second,
    }}))
}

pub fn run_calendar_convert(a: &CalendarConvertArgs) -> Result<u8> {
    let req = convert_request(&a.when)?;
    let c = call(wasm_time::calendar_convert(&req.to_string()))?;
    if a.format.is_json() {
        emit_json(&c)?;
    } else {
        report::emit(&render_convert(&c))?;
    }
    Ok(exit::OK)
}

fn render_convert(c: &CalendarConversion) -> String {
    let mut out = String::from("CALENDAR CONVERSION\n");
    out.push_str(&format!(
        "{:<13}{:.6}  (MJD {:.6})\n",
        "Julian date",
        c.jd_utc,
        c.jd_utc - 2_400_000.5
    ));
    out.push_str(&format!(
        "{:<13}{}\n",
        "Gregorian",
        civil_line(&c.gregorian)
    ));
    out.push_str(&format!("{:<13}{}\n", "Julian", civil_line(&c.julian)));
    out
}
