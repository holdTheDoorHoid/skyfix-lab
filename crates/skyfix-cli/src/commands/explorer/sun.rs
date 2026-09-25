//! The sun tools: golden and blue hour, the azimuth search, the alignment finder, rise
//! and set bearings through the year, the analemma, the sun path, the equation of time,
//! the clear-sky solar estimate and the galactic centre's dark-sky windows.
//! OWNER: cli3 agent.
//!
//! Engine: `skyfix_almanac::sun_tools` through the WASM adapter's native layer
//! (`skyfix_wasm::suntools::native`); wire format EXPLORER_API.md "Expansion programme —
//! sun tools"; definitions CONVENTIONS 13.10. `--format json` is the export's result.
//! The astronomy is the explorer's with DUT1 = 0, as the site's sun tools use it.

use anyhow::{Result, bail};
use skyfix_almanac::events::EventOptions;
use skyfix_almanac::sun_tools::alignment::{
    AlignedKind, AlignmentEvent, AlignmentMatch, AlignmentRequest, AlignmentResult,
};
use skyfix_almanac::sun_tools::analemma::{Analemma, AnalemmaRequest, ClockKind};
use skyfix_almanac::sun_tools::azimuth::{AltitudeBand, AzimuthCrossing};
use skyfix_almanac::sun_tools::eot::{EquationOfTime, ExtremeKind};
use skyfix_almanac::sun_tools::galactic::{GalacticCentreWindows, GalacticOptions};
use skyfix_almanac::sun_tools::hours::{LightKind, LightPeriod, SunHours};
use skyfix_almanac::sun_tools::solar::{Panel, SolarDay, SolarModel, SolarYear, SolarYearRequest};
use skyfix_almanac::sun_tools::sunpath::{PathDay, RiseSetAzimuths, RiseSetRequest, SunPath};
use skyfix_wasm::suntools::native;

use super::args::{Date, FormatArgs, When, parse_date, parse_when, window};
use super::events::{HorizonChoice, day_window, event_options, kind_words};
use super::sky::phase_words;
use super::text;
use super::wire::{
    Align, ClockFlag, SiteAirArgs, SiteArgs, Table, ZoneFlag, call, clock_cells, emit_json,
    observer_line, push_field, push_note, push_tier_note, shown_in, when_cells, when_headers,
};
use super::zone::ResolvedZone;
use crate::exit;
use crate::report;

// ---------------------------------------------------------------------------
// Shared flags
// ---------------------------------------------------------------------------

/// `--date` for a question about one local day.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct DayFlag {
    /// The day, YYYY-MM-DD (or -0584-05-28), from local midnight to local midnight in
    /// --zone.
    #[arg(long, value_name = "YYYY-MM-DD", value_parser = parse_date, allow_hyphen_values = true)]
    pub date: Date,
}

/// `--from --to`: a window, a date or an instant at each end.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct WindowFlags {
    /// Start: YYYY-MM-DD (local midnight that day in --zone) or an RFC 3339 instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when, allow_hyphen_values = true)]
    pub from: When,
    /// End: YYYY-MM-DD (through the END of that day in --zone) or an RFC 3339 instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when, allow_hyphen_values = true)]
    pub to: When,
}

impl WindowFlags {
    pub fn resolve(&self, zone: &ResolvedZone) -> Result<(f64, f64)> {
        window(self.from, self.to, zone.offset_minutes)
    }
}

/// `--year`.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct YearFlag {
    /// The year (astronomical: 0 is 1 BC, -584 is 585 BC).
    #[arg(long, value_name = "YEAR", allow_negative_numbers = true)]
    pub year: i32,
}

/// `--body`, the Sun by default.
#[derive(clap::Args, Debug, Clone)]
pub struct SunBody {
    /// The body: the Sun (default), the Moon, a planet or a navigational star.
    #[arg(long, value_name = "NAME", default_value = "Sun")]
    pub body: String,
}

/// `--horizon standard|dip [--height-of-eye M]`, for rise and set.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct RiseSetHorizon {
    /// The horizon rise and set are measured against (CONVENTIONS 13.3).
    #[arg(long, value_enum, default_value_t = HorizonChoice::Standard, value_name = "HORIZON")]
    pub horizon: HorizonChoice,
    /// Height of eye above the sea, metres; needed by --horizon dip, refused otherwise.
    #[arg(long = "height-of-eye", value_name = "M")]
    pub height_of_eye: Option<f64>,
}

impl RiseSetHorizon {
    /// `None` for the standard horizon, as the site sends it.
    fn options(&self) -> Result<Option<EventOptions>> {
        let o = event_options(self.horizon, self.height_of_eye)?;
        Ok((o != EventOptions::default()).then_some(o))
    }
}

fn head(title: &str, site: &skyfix_ephemeris::topocentric::Site) -> String {
    format!("{title}\nObserver   {}\n", observer_line(site))
}

fn hm(minutes: f64) -> String {
    text::duration_s(minutes * 60.0)
}

// ---------------------------------------------------------------------------
// sun-hours
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct HoursArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    #[command(flatten)]
    pub day: DayFlag,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_hours(a: &HoursArgs) -> Result<u8> {
    let zone = a.zone.resolve(a.site.position.lon);
    let (s, e) = day_window(a.day.date, &zone);
    let r = call(native::sun_hours(&a.site.json(), s, e))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_hours(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn light_words(k: LightKind) -> &'static str {
    match k {
        LightKind::Golden => "golden hour",
        LightKind::Blue => "blue hour",
    }
}

fn period_words(p: LightPeriod) -> &'static str {
    match p {
        LightPeriod::Morning => "morning",
        LightPeriod::Evening => "evening",
        LightPeriod::Midday => "midday",
        LightPeriod::Midnight => "midnight",
        LightPeriod::AllDay => "all day",
    }
}

fn render_hours(r: &SunHours, a: &HoursArgs, zone: &ResolvedZone) -> String {
    let mut out = head("GOLDEN AND BLUE HOUR", &a.site.site());
    out.push_str(&format!(
        "Day        {} in {}: {} to {}\n\n",
        a.day.date,
        zone.label,
        text::utc(r.jd_start),
        text::utc(r.jd_end)
    ));
    let mut cols = vec![("light", Align::Left), ("period", Align::Left)];
    for h in when_headers(zone) {
        cols.push((if h.0 == "UTC" { "from UTC" } else { "from" }, h.1));
    }
    cols.push(("until", Align::Left));
    cols.push(("lasts", Align::Right));
    let mut t = Table::new(&cols);
    for w in &r.windows {
        let mut row = vec![
            light_words(w.kind).to_string(),
            period_words(w.period).to_string(),
        ];
        row.extend(clock_cells(w.jd_start, zone));
        let until = if zone.is_utc() {
            text::utc(w.jd_end)
        } else {
            text::clock(w.jd_end, zone.offset_minutes)
        };
        row.push(until);
        row.push(hm(w.duration_min));
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  no golden or blue hour in this day\n");
    } else {
        out.push_str(&t.render("  "));
    }
    let events: Vec<String> = r
        .sun
        .events
        .iter()
        .map(|e| {
            let at = if zone.is_utc() {
                text::clock(e.jd_utc, 0)
            } else {
                text::clock(e.jd_utc, zone.offset_minutes)
            };
            format!("{} {at}", kind_words(e.kind))
        })
        .collect();
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "The Sun this day ({}): {}.",
            zone.label,
            if events.is_empty() {
                "no events".to_string()
            } else {
                events.join(", ")
            }
        ),
    );
    let phases: Vec<String> = r
        .phases
        .iter()
        .map(|p| {
            format!(
                "{} from {}",
                phase_words(p.phase),
                text::clock(p.jd_start, zone.offset_minutes)
            )
        })
        .collect();
    push_note(&mut out, &format!("Sky phases: {}.", phases.join(", ")));
    out.push('\n');
    push_note(
        &mut out,
        "Golden hour: the Sun's centre between -4 and +6 degrees of geometric altitude; blue \
         hour: between -6 and -4, so it ends exactly at civil dusk (CONVENTIONS 13.10). A \
         window cut by the day's edge runs to midnight; --format json says so (open_start, \
         open_end) and carries every crossing of the three altitudes.",
    );
    push_tier_note(&mut out, r.jd_start, r.jd_end);
    out
}

// ---------------------------------------------------------------------------
// find-azimuth
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct FindAzimuthArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub body: SunBody,
    /// The bearing, degrees true (0 to 360).
    #[arg(long, value_name = "DEG")]
    pub azimuth: f64,
    #[command(flatten)]
    pub window: WindowFlags,
    /// Lowest apparent altitude of the centre, degrees. Default: above the horizon (the
    /// upper limb above the sea-level horizon).
    #[arg(long = "min-alt", value_name = "DEG", allow_negative_numbers = true)]
    pub min_alt: Option<f64>,
    /// Highest apparent altitude, degrees. Default: no limit.
    #[arg(long = "max-alt", value_name = "DEG", allow_negative_numbers = true)]
    pub max_alt: Option<f64>,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_find_azimuth(a: &FindAzimuthArgs) -> Result<u8> {
    let zone = a.zone.resolve(a.site.site.position.lon);
    let (s, e) = a.window.resolve(&zone)?;
    let band = AltitudeBand {
        min_deg: a.min_alt,
        max_deg: a.max_alt,
    };
    let band_json = if band == AltitudeBand::default() {
        String::new()
    } else {
        serde_json::to_string(&band)?
    };
    let r = call(native::find_azimuth(
        &a.site.json(),
        &a.body.body,
        s,
        e,
        a.azimuth,
        &band_json,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_find_azimuth(&r, a, &zone, s, e))?;
    }
    Ok(exit::OK)
}

fn render_find_azimuth(
    r: &[AzimuthCrossing],
    a: &FindAzimuthArgs,
    zone: &ResolvedZone,
    s: f64,
    e: f64,
) -> String {
    let mut out = head(
        &format!("WHEN IS IT AT {}", text::dm360(a.azimuth).trim_start()),
        &a.site.site(),
    );
    out.push_str(&format!(
        "Body       {}\nWindow     {} to {}{}\n",
        skyfix_ephemeris::body::canonical(&a.body.body).unwrap_or(&a.body.body),
        text::utc(s),
        text::utc(e),
        shown_in(zone)
    ));
    let band = match (a.min_alt, a.max_alt) {
        (None, None) => "above the horizon".to_string(),
        (Some(lo), None) => format!("apparent altitude at least {lo} degrees"),
        (None, Some(hi)) => format!("above the horizon and at most {hi} degrees"),
        (Some(lo), Some(hi)) => format!("apparent altitude {lo} to {hi} degrees"),
    };
    out.push_str(&format!("Band       {band}\n\n"));
    let mut cols = when_headers(zone);
    cols.extend([
        ("Az", Align::Right),
        ("alt", Align::Right),
        ("app. alt", Align::Right),
        ("", Align::Left),
    ]);
    let mut t = Table::new(&cols);
    for c in r {
        let mut row = when_cells(c.jd_utc, zone);
        row.extend([
            text::dm360(c.az_deg),
            text::alt(c.alt_deg),
            text::alt(c.alt_apparent_deg),
            format!(
                "{}, {}",
                if c.rising { "rising" } else { "setting" },
                if c.clockwise {
                    "moving clockwise"
                } else {
                    "moving anticlockwise"
                }
            ),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  never on that bearing inside the band in this window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        "Az is the topocentric azimuth of the centre, true; alt the geometric altitude and \
         app. alt the apparent one with the display refraction (CONVENTIONS 13.2), which the \
         band is on. A body passing through the zenith has no azimuth there.",
    );
    push_tier_note(&mut out, s, e);
    out
}

// ---------------------------------------------------------------------------
// alignment-days
// ---------------------------------------------------------------------------

/// `--event` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum AlignEventArg {
    /// The rise: the upper limb on the sea-level horizon.
    Rise,
    /// The set.
    Set,
    /// The centre at the apparent altitude --altitude, rising and setting.
    AtAltitude,
}

#[derive(clap::Args, Debug)]
pub struct AlignmentArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub body: SunBody,
    #[command(flatten)]
    pub year: YearFlag,
    /// The bearing, degrees true.
    #[arg(long, value_name = "DEG")]
    pub azimuth: f64,
    /// Which moment: rise, set, or at-altitude with --altitude.
    #[arg(long, value_enum, value_name = "EVENT")]
    pub event: AlignEventArg,
    /// The apparent altitude of the centre, degrees, for --event at-altitude.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true)]
    pub altitude: Option<f64>,
    /// How far from the bearing still counts, degrees. Default 0.5.
    #[arg(long, value_name = "DEG")]
    pub tolerance: Option<f64>,
    #[command(flatten)]
    pub clock: ClockFlag,
    #[command(flatten)]
    pub horizon: RiseSetHorizon,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn alignment_request(a: &AlignmentArgs) -> Result<AlignmentRequest> {
    let event = match (a.event, a.altitude) {
        (AlignEventArg::Rise, None) => AlignmentEvent::Rise,
        (AlignEventArg::Set, None) => AlignmentEvent::Set,
        (AlignEventArg::AtAltitude, Some(h)) => AlignmentEvent::AtAltitude { altitude_deg: h },
        (AlignEventArg::AtAltitude, None) => {
            bail!("--event at-altitude needs --altitude DEG (the centre's apparent altitude)")
        }
        (_, Some(_)) => bail!("--altitude only goes with --event at-altitude"),
    };
    let options = a.horizon.options()?;
    if options.is_some() && matches!(event, AlignmentEvent::AtAltitude { .. }) {
        bail!("--horizon dip applies to rise and set only, not to --event at-altitude");
    }
    Ok(AlignmentRequest {
        body: a.body.body.clone(),
        year: a.year.year,
        azimuth_deg: a.azimuth,
        tolerance_deg: a.tolerance.unwrap_or(0.5),
        event,
        utc_offset_hours: a.clock.utc_offset_hours(a.site.site.position.lon),
        options,
    })
}

pub fn run_alignment(a: &AlignmentArgs) -> Result<u8> {
    let req = alignment_request(a)?;
    let r = call(native::alignment_days(
        &a.site.json(),
        &serde_json::to_string(&req)?,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_alignment(&r, a))?;
    }
    Ok(exit::OK)
}

fn aligned_words(k: AlignedKind) -> &'static str {
    match k {
        AlignedKind::Rise => "rise",
        AlignedKind::Set => "set",
        AlignedKind::Rising => "rising",
        AlignedKind::Setting => "setting",
    }
}

fn local_clock(jd: f64, offset_hours: f64) -> String {
    text::clock(jd, (offset_hours * 60.0).round() as i32)
}

fn render_alignment(r: &AlignmentResult, a: &AlignmentArgs) -> String {
    let lon = a.site.site.position.lon;
    let mut out = head(&format!("ALIGNMENT DAYS {}", r.year), &a.site.site());
    let event = match r.event {
        AlignmentEvent::Rise => "rises".to_string(),
        AlignmentEvent::Set => "sets".to_string(),
        AlignmentEvent::AtAltitude { altitude_deg } => {
            format!("stands at an apparent altitude of {altitude_deg} degrees")
        }
    };
    out.push_str(&format!(
        "Question   the days {} {event} within {} degrees of {} true\n",
        r.body,
        r.tolerance_deg,
        text::dm360(r.azimuth_deg).trim_start()
    ));
    out.push_str(&format!("Clock      {}\n", a.clock.words(lon)));
    out.push_str(&format!(
        "Searched   {} {}(s) from {} to {}{}\n\n",
        r.events_considered,
        match r.event {
            AlignmentEvent::Rise => "rise",
            AlignmentEvent::Set => "set",
            AlignmentEvent::AtAltitude { .. } => "crossing",
        },
        text::utc(r.jd_start),
        text::utc(r.jd_end),
        if r.truncated {
            ", clipped to the coverage"
        } else {
            ""
        }
    ));
    let row = |m: &AlignmentMatch| -> Vec<String> {
        vec![
            m.date.clone(),
            aligned_words(m.kind).to_string(),
            local_clock(m.jd_utc, r.utc_offset_hours),
            text::utc(m.jd_utc),
            text::dm360(m.az_deg),
            format!("{:+.2}", m.offset_deg),
            text::alt(m.alt_deg),
            if m.best { "best of its run" } else { "" }.to_string(),
        ]
    };
    let cols = [
        ("date", Align::Left),
        ("event", Align::Left),
        ("local", Align::Left),
        ("UTC", Align::Left),
        ("Az", Align::Right),
        ("off deg", Align::Right),
        ("alt", Align::Right),
        ("", Align::Left),
    ];
    let mut t = Table::new(&cols);
    for m in &r.matches {
        t.row(row(m));
    }
    if t.is_empty() {
        out.push_str("  no day in the year matches\n");
    } else {
        out.push_str(&t.render("  "));
    }
    match &r.closest {
        Some(c) => {
            out.push_str("\nClosest of the year\n");
            let mut t = Table::new(&cols);
            t.row(row(c));
            out.push_str(&t.render("  "));
        }
        None => out.push_str(&format!(
            "\n{} has no such event all year from here.\n",
            r.body
        )),
    }
    out.push('\n');
    push_note(
        &mut out,
        "Rise and set are the upper limb on the sea-level horizon with the standard 34' of \
         refraction (CONVENTIONS 13.3); an at-altitude event is the centre at that apparent \
         altitude. Az is true; off deg is Az minus the bearing; alt is geometric. A skyline \
         raises the horizon, and with it moves the bearing a body rises or sets on.",
    );
    push_tier_note(&mut out, r.jd_start, r.jd_end);
    out
}

// ---------------------------------------------------------------------------
// rise-set-azimuths
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct RiseSetArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    #[command(flatten)]
    pub body: SunBody,
    #[command(flatten)]
    pub year: YearFlag,
    #[command(flatten)]
    pub clock: ClockFlag,
    #[command(flatten)]
    pub horizon: RiseSetHorizon,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_rise_set(a: &RiseSetArgs) -> Result<u8> {
    let req = RiseSetRequest {
        body: a.body.body.clone(),
        year: a.year.year,
        utc_offset_hours: a.clock.utc_offset_hours(a.site.position.lon),
        options: a.horizon.options()?,
    };
    let r = call(native::rise_set_azimuths(
        &a.site.json(),
        &serde_json::to_string(&req)?,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_rise_set(&r, a))?;
    }
    Ok(exit::OK)
}

fn render_rise_set(r: &RiseSetAzimuths, a: &RiseSetArgs) -> String {
    let lon = a.site.position.lon;
    let mut out = head(
        &format!("RISE AND SET BEARINGS {} {}", r.body.to_uppercase(), r.year),
        &a.site.site(),
    );
    out.push_str(&format!("Clock      {}\n", a.clock.words(lon)));
    if r.truncated {
        out.push_str("Coverage   the year reaches outside the coverage and was clipped\n");
    }
    out.push('\n');
    let mut t = Table::new(&[
        ("date", Align::Left),
        ("rise", Align::Left),
        ("Az", Align::Right),
        ("transit", Align::Left),
        ("alt", Align::Right),
        ("set", Align::Left),
        ("Az", Align::Right),
    ]);
    for d in &r.days {
        let ev = |v: &[skyfix_almanac::sun_tools::sunpath::EventRef]| -> (String, String) {
            if v.is_empty() {
                ("-".into(), "-".into())
            } else {
                (
                    v.iter()
                        .map(|e| local_clock(e.jd_utc, r.utc_offset_hours))
                        .collect::<Vec<_>>()
                        .join(" "),
                    v.iter()
                        .map(|e| text::dm360(e.az_deg).trim_start().to_string())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            }
        };
        let (rt, raz) = ev(&d.rises);
        let (st, saz) = ev(&d.sets);
        let (tt, talt) = match &d.transit {
            Some(e) => (
                local_clock(e.jd_utc, r.utc_offset_hours),
                text::alt(e.alt_deg),
            ),
            None => ("-".into(), "-".into()),
        };
        let mut row = vec![d.date.clone(), rt, raz, tt, talt, st, saz];
        if d.always_above {
            row[1] = "up all day".into();
        } else if d.always_below {
            row[1] = "down all day".into();
        }
        t.row(row);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "Times are on the clock above; Az is true, the bearing of the centre at the rise or \
         set (the upper limb on the sea-level horizon, CONVENTIONS 13.3); alt is the \
         geometric altitude at the upper transit.",
    );
    push_tier_note(&mut out, r.jd_start, r.jd_end);
    out
}

// ---------------------------------------------------------------------------
// analemma
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct AnalemmaArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub year: YearFlag,
    /// The clock time of day, HH:MM or hours (12 = noon). Default 12:00.
    #[arg(long, value_name = "HH:MM", default_value = "12:00", value_parser = parse_time_of_day)]
    pub time: f64,
    #[command(flatten)]
    pub clock: ClockFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `HH:MM`, `HH:MM:SS` or decimal hours, in `[0, 24)`.
pub fn parse_time_of_day(s: &str) -> Result<f64, String> {
    let bad = || format!("{s:?} is not a time of day: give HH:MM (12:00) or hours (12.5)");
    let t = s.trim();
    let h = if t.contains(':') {
        let parts: Vec<&str> = t.split(':').collect();
        if parts.len() > 3 {
            return Err(bad());
        }
        let mut hours = 0.0;
        for (i, p) in parts.iter().enumerate() {
            let v: f64 = p.parse().map_err(|_| bad())?;
            if v < 0.0 || (i > 0 && v >= 60.0) {
                return Err(bad());
            }
            hours += v / 60f64.powi(i as i32);
        }
        hours
    } else {
        t.parse::<f64>().map_err(|_| bad())?
    };
    if (0.0..24.0).contains(&h) {
        Ok(h)
    } else {
        Err(format!(
            "{s:?} is not a time of day between 00:00 and 24:00"
        ))
    }
}

pub fn run_analemma(a: &AnalemmaArgs) -> Result<u8> {
    let lon = a.site.site.position.lon;
    let req = match a.clock.utc_offset_hours(lon) {
        None => AnalemmaRequest {
            year: a.year.year,
            time_h: a.time,
            clock: ClockKind::Lmt,
            utc_offset_hours: None,
        },
        Some(h) => AnalemmaRequest {
            year: a.year.year,
            time_h: a.time,
            clock: ClockKind::Zone,
            utc_offset_hours: Some(h),
        },
    };
    let r = call(native::analemma(
        &a.site.json(),
        &serde_json::to_string(&req)?,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_analemma(&r, a))?;
    }
    Ok(exit::OK)
}

fn eot_text(s: f64) -> String {
    let sign = if s < 0.0 { '-' } else { '+' };
    let a = s.abs().round() as i64;
    format!("{sign}{}m {:02}s", a / 60, a % 60)
}

fn render_analemma(r: &Analemma, a: &AnalemmaArgs) -> String {
    let lon = a.site.site.position.lon;
    let mut out = head(&format!("ANALEMMA {}", r.year), &a.site.site());
    let h = (r.time_h * 3600.0).round() as i64;
    out.push_str(&format!(
        "Time       {:02}:{:02}:{:02} every day on {}\n\n",
        h / 3600,
        h / 60 % 60,
        h % 60,
        a.clock.words(lon)
    ));
    let mut t = Table::new(&[
        ("date", Align::Left),
        ("UTC", Align::Left),
        ("alt", Align::Right),
        ("app. alt", Align::Right),
        ("Az", Align::Right),
        ("Dec", Align::Right),
        ("EoT", Align::Right),
    ]);
    for p in &r.points {
        t.row(vec![
            p.date.clone(),
            text::utc(p.jd_utc),
            text::alt(p.alt_deg),
            text::alt(p.alt_apparent_deg),
            text::dm360(p.az_deg),
            text::dec(p.dec_deg),
            eot_text(p.eot_s),
        ]);
    }
    out.push_str(&t.render("  "));
    for e in &r.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.body, e.message));
    }
    out.push('\n');
    push_note(
        &mut out,
        "The analemma's axes are the Sun's declination against the equation of time (EoT, \
         apparent minus mean solar time: positive when the sundial is fast). alt is \
         geometric, app. alt with the display refraction; Az is true.",
    );
    push_tier_note(
        &mut out,
        r.points.first().map_or(f64::NAN, |p| p.jd_utc),
        r.points.last().map_or(f64::NAN, |p| p.jd_utc),
    );
    out
}

// ---------------------------------------------------------------------------
// sun-path
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct SunPathArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub day: DayFlag,
    #[command(flatten)]
    pub zone: ZoneFlag,
    /// Minutes between points, 1 to 60.
    #[arg(long, value_name = "MIN", default_value_t = 10.0)]
    pub step: f64,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_sun_path(a: &SunPathArgs) -> Result<u8> {
    let zone = a.zone.resolve(a.site.site.position.lon);
    let (s, e) = day_window(a.day.date, &zone);
    let r = call(native::sun_path(&a.site.json(), s, e, a.step))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_sun_path(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn path_day_words(d: PathDay) -> &'static str {
    match d {
        PathDay::Day => "this day",
        PathDay::MarchEquinox => "March equinox",
        PathDay::JuneSolstice => "June solstice",
        PathDay::SeptemberEquinox => "September equinox",
        PathDay::DecemberSolstice => "December solstice",
    }
}

fn render_sun_path(r: &SunPath, a: &SunPathArgs, zone: &ResolvedZone) -> String {
    let mut out = head("SUN PATH", &a.site.site());
    out.push_str(&format!(
        "Day        {} in {}, every {} min\n\n",
        a.day.date, zone.label, r.step_minutes
    ));
    let mut cols = if zone.is_utc() {
        vec![("UTC", Align::Left)]
    } else {
        vec![("local", Align::Left), ("UTC", Align::Left)]
    };
    cols.extend([
        ("alt", Align::Right),
        ("app. alt", Align::Right),
        ("Az", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for p in r.path.points.iter().filter(|p| p.alt_apparent_deg > -1.0) {
        let mut row = clock_cells(p.jd_utc, zone);
        row.extend([
            text::alt(p.alt_deg),
            text::alt(p.alt_apparent_deg),
            text::dm360(p.az_deg),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  the Sun stays below the horizon all day\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push_str(
        "\nThe year's envelope: the same local day moved to the equinoxes and solstices\n",
    );
    let mut t = Table::new(&[
        ("day", Align::Left),
        ("date", Align::Left),
        ("highest", Align::Right),
        ("Az at rise", Align::Right),
        ("Az at set", Align::Right),
    ]);
    for d in &r.envelope {
        let high = d
            .points
            .iter()
            .map(|p| p.alt_deg)
            .fold(f64::NEG_INFINITY, f64::max);
        let crossing = |rising: bool| -> String {
            d.points
                .windows(2)
                .find(|w| {
                    if rising {
                        w[0].alt_apparent_deg < 0.0 && w[1].alt_apparent_deg >= 0.0
                    } else {
                        w[0].alt_apparent_deg >= 0.0 && w[1].alt_apparent_deg < 0.0
                    }
                })
                .map_or_else(
                    || "-".to_string(),
                    |w| text::dm360(w[1].az_deg).trim_start().to_string(),
                )
        };
        t.row(vec![
            path_day_words(d.day).to_string(),
            text::local_datetime(d.jd_start, zone.offset_minutes)
                .split(' ')
                .next()
                .unwrap_or_default()
                .to_string(),
            text::alt(high),
            crossing(true),
            crossing(false),
        ]);
    }
    out.push_str(&t.render("  "));
    for e in &r.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.body, e.message));
    }
    out.push('\n');
    push_note(
        &mut out,
        "Points with the Sun above an apparent altitude of -1 degree are listed; --format json \
         has every point of the day and of the four envelope days. alt is geometric, app. \
         alt with the display refraction; Az is true. The envelope's bearings are the first \
         point above and below the horizon, to the step.",
    );
    // The envelope's days are the window's year's seasons: the report's times run over both.
    let days = || std::iter::once(&r.path).chain(&r.envelope);
    push_tier_note(
        &mut out,
        days().map(|d| d.jd_start).fold(f64::INFINITY, f64::min),
        days().map(|d| d.jd_end).fold(f64::NEG_INFINITY, f64::max),
    );
    out
}

// ---------------------------------------------------------------------------
// equation-of-time
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct EotArgs {
    #[command(flatten)]
    pub year: YearFlag,
    /// The hour of each UTC date the values are for (the almanac page's is 12).
    #[arg(long, value_name = "H", default_value_t = 12.0)]
    pub hour: f64,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_eot(a: &EotArgs) -> Result<u8> {
    let r = call(native::equation_of_time(f64::from(a.year.year), a.hour))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_eot(&r))?;
    }
    Ok(exit::OK)
}

fn render_eot(r: &EquationOfTime) -> String {
    let mut out = format!(
        "EQUATION OF TIME {}\nTime       {:.2} h UT each date; the same for every observer\n\n",
        r.year, r.utc_hour
    );
    out.push_str("Extremes\n");
    let mut t = Table::new(&[
        ("date", Align::Left),
        ("", Align::Left),
        ("EoT", Align::Right),
    ]);
    for e in &r.extremes {
        t.row(vec![
            e.date.clone(),
            match e.kind {
                ExtremeKind::Minimum => "least: the sundial furthest behind the clock",
                ExtremeKind::Maximum => "greatest: the sundial furthest ahead",
            }
            .to_string(),
            eot_text(e.eot_s),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push_str("\nEvery date\n");
    let mut t = Table::new(&[
        ("date", Align::Left),
        ("EoT", Align::Right),
        ("seconds", Align::Right),
        ("Dec", Align::Right),
    ]);
    for p in &r.points {
        t.row(vec![
            p.date.clone(),
            eot_text(p.eot_s),
            format!("{:+.1}", p.eot_s),
            text::dec(p.dec_deg),
        ]);
    }
    out.push_str(&t.render("  "));
    for e in &r.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.body, e.message));
    }
    out.push('\n');
    push_note(
        &mut out,
        "The equation of time is apparent minus mean solar time: positive when a sundial is \
         ahead of the clock. Dec is the Sun's apparent declination. The extremes are to the \
         day.",
    );
    push_tier_note(
        &mut out,
        r.points.first().map_or(f64::NAN, |p| p.jd_utc),
        r.points.last().map_or(f64::NAN, |p| p.jd_utc),
    );
    out
}

// ---------------------------------------------------------------------------
// solar-day and solar-year
// ---------------------------------------------------------------------------

/// The panel.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct PanelArgs {
    /// Tilt from horizontal, degrees: 0 (flat, the default) to 90 (vertical).
    #[arg(long, value_name = "DEG", default_value_t = 0.0)]
    pub tilt: f64,
    /// The direction the panel faces, degrees true. Default: toward the equator.
    #[arg(long = "panel-azimuth", value_name = "DEG")]
    pub panel_azimuth: Option<f64>,
    /// Ground reflectance, 0 to 1. Default 0.2.
    #[arg(long, value_name = "A")]
    pub albedo: Option<f64>,
}

impl PanelArgs {
    fn panel(&self) -> Panel {
        Panel {
            tilt_deg: self.tilt,
            azimuth_deg: self.panel_azimuth,
            albedo: self.albedo,
        }
    }
}

#[derive(clap::Args, Debug)]
pub struct SolarDayArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub day: DayFlag,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub panel: PanelArgs,
    /// Minutes between samples, 1 to 60.
    #[arg(long, value_name = "MIN", default_value_t = 10.0)]
    pub step: f64,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_solar_day(a: &SolarDayArgs) -> Result<u8> {
    let zone = a.zone.resolve(a.site.site.position.lon);
    let (s, e) = day_window(a.day.date, &zone);
    let panel = a.panel.panel();
    let panel_json = if panel == Panel::default() {
        String::new()
    } else {
        serde_json::to_string(&panel)?
    };
    let r = call(native::solar_day(&a.site.json(), s, e, &panel_json, a.step))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_solar_day(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn model_note(out: &mut String, m: &SolarModel) {
    push_note(
        out,
        &format!(
            "Model: a {}, the sunlight on a clean panel under a cloudless sky.",
            m.label
        ),
    );
    for (name, text) in [
        ("clear sky", &m.clear_sky),
        ("beam and diffuse", &m.diffuse_split),
        ("on the panel", &m.transposition),
        ("typical error", &m.typical_error),
        ("not modelled", &m.not_modelled),
    ] {
        for (i, line) in report::wrap(&format!("{name}: {text}"), 86, "    ")
            .into_iter()
            .enumerate()
        {
            if i == 0 {
                out.push_str(&format!("  {}\n", line.trim_start()));
            } else {
                out.push_str(&format!("{line}\n"));
            }
        }
    }
}

fn render_solar_day(r: &SolarDay, a: &SolarDayArgs, zone: &ResolvedZone) -> String {
    let mut out = head("CLEAR-SKY SOLAR ESTIMATE, ONE DAY", &a.site.site());
    out.push_str(&format!(
        "Day        {} in {}\nPanel      tilt {} deg, facing {} deg true, albedo {}\n",
        a.day.date, zone.label, r.panel.tilt_deg, r.panel.azimuth_deg, r.panel.albedo
    ));
    push_field(
        &mut out,
        "Energy",
        &format!(
            "{:.3} kWh/m2 on the panel (peak {:.1} W/m2), {:.3} on the ground (GHI) and {:.3} \
             toward the Sun (DNI)",
            r.poa_kwh_m2, r.peak_poa_w_m2, r.ghi_kwh_m2, r.dni_kwh_m2
        ),
    );
    out.push('\n');
    let mut cols = if zone.is_utc() {
        vec![("UTC", Align::Left)]
    } else {
        vec![("local", Align::Left), ("UTC", Align::Left)]
    };
    cols.extend([
        ("Sun app. alt", Align::Right),
        ("Az", Align::Right),
        ("GHI", Align::Right),
        ("DNI", Align::Right),
        ("DHI", Align::Right),
        ("panel", Align::Right),
        ("incidence", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for s in r.samples.iter().filter(|s| s.incidence_deg.is_some()) {
        let mut row = clock_cells(s.jd_utc, zone);
        row.extend([
            text::alt(s.sun_alt_apparent_deg),
            text::dm360(s.sun_az_deg),
            format!("{:.1}", s.ghi_w_m2),
            format!("{:.1}", s.dni_w_m2),
            format!("{:.1}", s.dhi_w_m2),
            format!("{:.1}", s.poa_w_m2),
            super::wire::opt_fixed(s.incidence_deg, 1),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  the Sun is down all day\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        "Irradiances in W/m2 while the Sun is up: GHI on the ground, DNI toward the Sun, DHI \
         from the sky, panel the plane of the panel; incidence is the angle between the Sun \
         and the panel's normal, degrees.",
    );
    model_note(&mut out, &r.model);
    push_tier_note(&mut out, r.jd_start, r.jd_end);
    out
}

#[derive(clap::Args, Debug)]
pub struct SolarYearArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub year: YearFlag,
    #[command(flatten)]
    pub clock: ClockFlag,
    #[command(flatten)]
    pub panel: PanelArgs,
    /// Integration step, minutes. Default 10.
    #[arg(long, value_name = "MIN")]
    pub step: Option<f64>,
    /// Also search the tilt that collects the most in the year, for the panel's azimuth.
    #[arg(long = "optimise-tilt", alias = "optimize-tilt")]
    pub optimise_tilt: bool,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_solar_year(a: &SolarYearArgs) -> Result<u8> {
    let req = SolarYearRequest {
        year: a.year.year,
        panel: a.panel.panel(),
        utc_offset_hours: a.clock.utc_offset_hours(a.site.site.position.lon),
        step_minutes: a.step,
        optimise_tilt: a.optimise_tilt,
    };
    let r = call(native::solar_year(
        &a.site.json(),
        &serde_json::to_string(&req)?,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_solar_year(&r, a))?;
    }
    Ok(exit::OK)
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn render_solar_year(r: &SolarYear, a: &SolarYearArgs) -> String {
    let lon = a.site.site.position.lon;
    let mut out = head(
        &format!("CLEAR-SKY SOLAR ESTIMATE {}", r.year),
        &a.site.site(),
    );
    out.push_str(&format!(
        "Panel      tilt {} deg, facing {} deg true, albedo {}\nClock      {}, every {} min\n",
        r.panel.tilt_deg,
        r.panel.azimuth_deg,
        r.panel.albedo,
        a.clock.words(lon),
        r.step_minutes
    ));
    out.push_str(&format!(
        "Energy     {:.1} kWh/m2 on the panel in the year, {:.1} on the ground (GHI)\n",
        r.poa_kwh_m2, r.ghi_kwh_m2
    ));
    if let Some(o) = &r.optimal {
        out.push_str(&format!(
            "Best tilt  {:.1} deg facing {} deg: {:.1} kWh/m2\n",
            o.tilt_deg, o.azimuth_deg, o.poa_kwh_m2
        ));
    }
    if r.truncated {
        out.push_str("Coverage   the year reaches outside the coverage: days were left out\n");
    }
    out.push('\n');
    let mut t = Table::new(&[
        ("month", Align::Left),
        ("days", Align::Right),
        ("panel kWh/m2", Align::Right),
        ("GHI kWh/m2", Align::Right),
        ("panel a day", Align::Right),
    ]);
    for m in &r.months {
        t.row(vec![
            MONTHS
                .get(m.month as usize - 1)
                .copied()
                .unwrap_or("?")
                .to_string(),
            m.days.to_string(),
            format!("{:.1}", m.poa_kwh_m2),
            format!("{:.1}", m.ghi_kwh_m2),
            if m.days > 0 {
                format!("{:.2}", m.poa_kwh_m2 / f64::from(m.days))
            } else {
                "-".into()
            },
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "--format json has every local day's energy as well.",
    );
    model_note(&mut out, &r.model);
    push_tier_note(&mut out, r.jd_start, r.jd_end);
    out
}

// ---------------------------------------------------------------------------
// galactic-centre
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct GalacticArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub window: WindowFlags,
    /// Lowest apparent altitude of the galactic centre, degrees. Default 10.
    #[arg(long = "min-alt", value_name = "DEG", allow_negative_numbers = true)]
    pub min_alt: Option<f64>,
    /// Highest geometric altitude of the Sun, degrees. Default -18 (astronomical night).
    #[arg(
        long = "sun-max-alt",
        value_name = "DEG",
        allow_negative_numbers = true
    )]
    pub sun_max_alt: Option<f64>,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_galactic(a: &GalacticArgs) -> Result<u8> {
    let zone = a.zone.resolve(a.site.site.position.lon);
    let (s, e) = a.window.resolve(&zone)?;
    let options = GalacticOptions {
        min_altitude_deg: a.min_alt,
        sun_max_altitude_deg: a.sun_max_alt,
    };
    let options_json = if options == GalacticOptions::default() {
        String::new()
    } else {
        serde_json::to_string(&options)?
    };
    let r = call(native::galactic_centre_windows(
        &a.site.json(),
        s,
        e,
        &options_json,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_galactic(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn render_galactic(r: &GalacticCentreWindows, a: &GalacticArgs, zone: &ResolvedZone) -> String {
    let mut out = head("THE GALACTIC CENTRE IN A DARK SKY", &a.site.site());
    out.push_str(&format!(
        "Window     {} to {}{}\nRule       the centre at least {} deg up (apparent), the Sun at \
         most {} deg (geometric)\n\n",
        text::utc(r.jd_start),
        text::utc(r.jd_end),
        shown_in(zone),
        r.min_altitude_deg,
        r.sun_max_altitude_deg
    ));
    let mut cols = vec![];
    for (h, al) in when_headers(zone) {
        cols.push((if h == "UTC" { "from UTC" } else { "from" }, al));
    }
    cols.extend([
        ("hours", Align::Right),
        ("Moon", Align::Left),
        ("best", Align::Left),
        ("alt", Align::Right),
        ("Az", Align::Right),
        ("arch top Az", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for w in &r.windows {
        let mut row = when_cells(w.jd_start, zone);
        row.extend([
            format!("{:.2}", w.duration_h),
            format!(
                "{} {:.0}%",
                if w.moon_up { "up" } else { "down" },
                w.moon_illuminated_fraction * 100.0
            ),
            if zone.is_utc() {
                text::clock(w.best.jd_utc, 0)
            } else {
                text::clock(w.best.jd_utc, zone.offset_minutes)
            },
            text::alt(w.best.alt_apparent_deg),
            text::dm360(w.best.az_deg),
            text::dm360(w.best.arch_top_az_deg),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  no window: the centre is never that high in a dark enough sky\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        "Each window is split where the Moon rises or sets (Moon: up or down throughout, and \
         its illuminated fraction at the window's middle). best is the centre at its highest \
         in the window, alt apparent and Az true; arch top Az is where the Milky Way's arch \
         (the galactic equator) stands highest then. --format json adds the arch's ends and \
         the altitudes.",
    );
    push_tier_note(&mut out, r.jd_start, r.jd_end);
    out
}
