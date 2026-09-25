//! `skyfix calendar`: a date in both calendars, its Julian date, weekday, time scale and
//! Delta-T. OWNER: timescales agent (expansion programme, wave 1).
//!
//! The engine functions are `skyfix_core::calendar::calendar_convert` and
//! `skyfix_core::time::time_info` (EXPLORER_API.md, `calendar_convert` and `time_info`);
//! definitions in CONVENTIONS 15.2-15.3. `--format json` prints `CalendarConversion` with
//! the weekday and `time_info` beside it.

use anyhow::{Result, anyhow};
use serde::Serialize;
use skyfix_core::calendar::{CalendarConversion, CivilDate, CivilDateTime, Era, calendar_convert};
use skyfix_core::calendar::{CalendarConvertRequest, format_year};
use skyfix_core::deltat::DeltaTSource;
use skyfix_core::time::{self, ClockScale, Dut1Source, TimeInfo};

use super::args::{FormatArgs, parse_date, parse_instant};
use crate::exit;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// A date (`2026-09-24`, `-0584-05-28`) or an instant (`2026-09-24T12:00:00Z`), in the
    /// calendar `--calendar` names (default: Julian up to 1582-10-04, Gregorian from
    /// 1582-10-15). A date means 00:00 that day.
    #[arg(
        value_name = "DATE",
        allow_hyphen_values = true,
        required_unless_present = "jd",
        conflicts_with = "jd"
    )]
    pub date: Option<String>,
    /// A Julian date instead of a date (on the app's clock: UTC 1972-2035, UT outside).
    #[arg(long, value_name = "JD", allow_negative_numbers = true)]
    pub jd: Option<f64>,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `--format json`.
#[derive(Debug, Serialize)]
struct Output {
    #[serde(flatten)]
    conversion: CalendarConversion,
    weekday: &'static str,
    time_info: TimeInfo,
}

const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// The weekday of the day that contains `jd` (JD 0.5, the start of JDN 1, was a Tuesday).
fn weekday(jd: f64) -> &'static str {
    let jdn = (jd + 0.5).floor() as i64;
    WEEKDAYS[(jdn + 1).rem_euclid(7) as usize]
}

fn the_jd(a: &Args) -> Result<f64> {
    match (&a.date, a.jd) {
        (_, Some(jd)) if jd.is_finite() => Ok(jd),
        (_, Some(jd)) => Err(anyhow!("--jd {jd} is not a finite number")),
        (Some(s), None) if s.contains('T') => parse_instant(s).map_err(|e| anyhow!(e)),
        (Some(s), None) => Ok(parse_date(s).map_err(|e| anyhow!(e))?.jd0()),
        (None, None) => Err(anyhow!("give a date or --jd")),
    }
}

pub fn run(a: &Args) -> Result<u8> {
    let jd = the_jd(a)?;
    let conversion = calendar_convert(&CalendarConvertRequest {
        jd_utc: Some(jd),
        civil: None,
    })
    .map_err(|e| anyhow!(e))?;
    let info = time::time_info(jd, None).map_err(|e| anyhow!(e))?;
    let out = Output {
        conversion,
        weekday: weekday(jd),
        time_info: info,
    };
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&out)?)?;
    } else {
        report::emit(&render(&out))?;
    }
    Ok(exit::OK)
}

fn civil_line(c: &CivilDate) -> String {
    let dt = CivilDateTime {
        calendar: c.calendar,
        year: c.year,
        month: c.month,
        day: c.day,
        hour: c.hour,
        minute: c.minute,
        second: c.second,
    };
    let astro = if c.era == Era::BC {
        format!(", astronomical year {}", format_year(c.year))
    } else {
        String::new()
    };
    format!(
        "{}  {}{astro}  {:02}:{:02}:{:06.3}",
        dt.date_string(),
        dt.human_date(),
        c.hour,
        c.minute,
        c.second
    )
}

fn seconds_text(s: f64) -> String {
    if s.abs() < 120.0 {
        format!("{s:.3} s")
    } else {
        let a = s.abs().round() as i64;
        let (h, m, sec) = (a / 3600, a / 60 % 60, a % 60);
        let sign = if s < 0.0 { "-" } else { "" };
        if h > 0 {
            format!("{s:.1} s ({sign}{h} h {m:02} min {sec:02} s)")
        } else {
            format!("{s:.1} s ({sign}{m} min {sec:02} s)")
        }
    }
}

fn sigma_text(s: f64) -> String {
    if s < 1.0 {
        format!("{s:.3} s")
    } else if s < 120.0 {
        format!("{s:.1} s")
    } else if s < 5400.0 {
        format!("{:.0} min", s / 60.0)
    } else {
        format!("{:.1} h", s / 3600.0)
    }
}

fn display_name(c: skyfix_core::calendar::Calendar) -> &'static str {
    match c {
        skyfix_core::calendar::Calendar::Julian => "Julian",
        skyfix_core::calendar::Calendar::Gregorian => "Gregorian",
    }
}

fn render(o: &Output) -> String {
    let t = &o.time_info;
    let c = &o.conversion;
    let mut out = String::from("CALENDAR\n");
    let shown = match super::args::calendar_choice() {
        Some(cal) => format!("{cal}, as --calendar asks"),
        None => format!(
            "{}: the Julian calendar before 1582-10-15, the Gregorian from it",
            display_name(t.calendar)
        ),
    };
    out.push_str(&format!(
        "Julian date  {:.6}  (MJD {:.6}); a {}\n",
        c.jd_utc,
        c.jd_utc - 2_400_000.5,
        o.weekday
    ));
    out.push_str(&format!("Julian       {}\n", civil_line(&c.julian)));
    out.push_str(&format!(
        "Gregorian    {}{}\n",
        civil_line(&c.gregorian),
        if t.calendar == skyfix_core::calendar::Calendar::Julian {
            " (proleptic)"
        } else {
            ""
        }
    ));
    out.push_str(&format!("Shown as     {shown}\n"));
    out.push_str(&format!("Wire         {} (proleptic Gregorian)\n", t.utc));
    let scale = match t.scale {
        ClockScale::Utc => "UTC (Coordinated Universal Time, 1972-2035)".to_string(),
        ClockScale::Ut => "UT (Universal Time, UT1: outside the UTC years 1972-2035)".to_string(),
    };
    out.push_str(&format!("Clock        {scale}\n"));
    out.push_str(&format!(
        "TT - clock   {}\n",
        seconds_text(t.tt_minus_clock_s)
    ));
    let source = match t.delta_t_source {
        DeltaTSource::Iers => "observed by the IERS",
        DeltaTSource::Smh2016 => "Stephenson, Morrison & Hohenkerk 2016, 2020 revision",
        DeltaTSource::Parabola => "the long-term parabola",
        DeltaTSource::Prediction => "predicted",
    };
    out.push_str(&format!(
        "Delta-T      {}, standard uncertainty {}: {source}\n",
        seconds_text(t.delta_t_s),
        sigma_text(t.delta_t_sigma_s)
    ));
    let dut1 = match t.dut1_source {
        Dut1Source::Iers => format!(
            "{:+.4} s +- {} (IERS)",
            t.dut1_s,
            sigma_text(t.dut1_sigma_s)
        ),
        Dut1Source::User => format!("{:+.4} s (given)", t.dut1_s),
        Dut1Source::Model => "none: the clock is UT1".to_string(),
        Dut1Source::Assumed => "unknown: 0 s +- 0.9 s".to_string(),
    };
    out.push_str(&format!("UT1 - UTC    {dut1}\n"));
    for n in &t.notes {
        out.push_str(&format!("Note         {n}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekdays() {
        // 2000-01-01 was a Saturday; 1582-10-15 a Friday; JD 0 (Julian -4712-01-01) a Monday.
        assert_eq!(weekday(2_451_544.5), "Saturday");
        assert_eq!(weekday(2_299_160.5), "Friday");
        assert_eq!(weekday(0.0), "Monday");
        assert_eq!(weekday(-0.5), "Monday");
        assert_eq!(weekday(-0.6), "Sunday");
    }

    #[test]
    fn the_text_names_both_calendars() {
        let jd = 1_507_900.0; // 585 BC May 28 (Julian), noon
        let o = Output {
            conversion: calendar_convert(&CalendarConvertRequest {
                jd_utc: Some(jd),
                civil: None,
            })
            .unwrap(),
            weekday: weekday(jd),
            time_info: time::time_info(jd, None).unwrap(),
        };
        let text = render(&o);
        assert!(
            text.contains("Julian       -0584-05-28  28 May 585 BC, astronomical year -0584"),
            "{text}"
        );
        assert!(
            text.contains("Gregorian    -0584-05-22  22 May 585 BC"),
            "{text}"
        );
        assert!(text.contains("(proleptic)"), "{text}");
        assert!(text.contains("Clock        UT"), "{text}");
        assert!(
            text.contains("Wire         -0584-05-22T12:00:00.000Z"),
            "{text}"
        );
        let json = serde_json::to_value(&o).unwrap();
        assert_eq!(json["julian"]["era"], "BC");
        assert_eq!(json["time_info"]["scale"], "ut");
        assert_eq!(json["jd_utc"], 1_507_900.0);
    }
}
