//! `skyfix events`: one day's rise, set, transit and twilight, and the sky phases.
//! OWNER: cli agent.
//!
//! `skyfix_almanac::events::day_events` (EXPLORER_API.md `day_events`; definitions in
//! CONVENTIONS 13.3-13.4) over one day: local midnight to local midnight in `--zone`,
//! the way the web UI takes the day in its display zone. `--format json` prints the
//! engine's `DayEvents` with the day it asked for alongside (`date`, `zone`,
//! `utc_offset_minutes`); every instant in it is UTC.

use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use skyfix_almanac::events::{self, DayEvents, EventKind, EventOptions, Horizon};
use skyfix_core::types::LatLon;
use skyfix_ephemeris::topocentric::Site;

use super::args::{BodyList, Date, FormatArgs, PositionArgs, parse_bodies, parse_date};
use super::sky::phase_words;
use super::text;
use super::zone::{ResolvedZone, Zone, parse_zone};
use crate::exit;
use crate::report;

/// `--horizon` for rise and set (CONVENTIONS 13.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum HorizonChoice {
    /// The sea-level horizon: -50' for the Sun, -34' - SD for the Moon, -34' otherwise.
    #[default]
    Standard,
    /// The sea horizon seen from --height-of-eye: every rise and set altitude lowered by
    /// the dip, 1.76' x sqrt(metres). Twilight never uses dip.
    Dip,
}

#[derive(clap::Args, Debug)]
pub struct Args {
    #[command(flatten)]
    pub position: PositionArgs,
    /// Height of the site above the WGS84 ellipsoid, metres (the Moon's parallax); not
    /// the height of eye.
    #[arg(
        long,
        value_name = "M",
        default_value_t = 0.0,
        allow_negative_numbers = true
    )]
    pub height: f64,
    /// The day, YYYY-MM-DD, from local midnight to local midnight in --zone.
    #[arg(long, value_name = "YYYY-MM-DD", value_parser = parse_date, allow_hyphen_values = true)]
    pub date: Date,
    /// `utc` (default), a fixed offset such as -04:00, or `nautical` for the zone time of
    /// the longitude. Named zones (America/New_York) need a tz database this offline tool
    /// does not carry; see docs/CLI.md.
    #[arg(long, value_name = "ZONE", default_value = "utc", value_parser = parse_zone, allow_hyphen_values = true)]
    pub zone: Zone,
    /// `all`, `solar_system`, `navigational`, or a comma-separated list of names.
    #[arg(long, value_name = "LIST", default_value = "Sun,Moon", value_parser = parse_bodies)]
    pub bodies: BodyList,
    /// The horizon rise and set are measured against.
    #[arg(long, value_enum, default_value_t = HorizonChoice::Standard, value_name = "HORIZON")]
    pub horizon: HorizonChoice,
    /// Height of eye above the sea, metres; needed by --horizon dip, refused otherwise.
    #[arg(long = "height-of-eye", value_name = "M")]
    pub height_of_eye: Option<f64>,
    #[command(flatten)]
    pub dut1: super::args::Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `--format json`: the engine's `DayEvents`, with the day it was asked for.
#[derive(Serialize)]
struct EventsJson<'a> {
    date: String,
    zone: &'a str,
    utc_offset_minutes: i32,
    #[serde(flatten)]
    day: &'a DayEvents,
}

/// The options the flags ask for, or why they contradict each other. A height of eye
/// with the standard horizon would silently do nothing, and dip without one would be the
/// standard horizon under another name, so both are refused.
pub fn event_options(horizon: HorizonChoice, height_of_eye: Option<f64>) -> Result<EventOptions> {
    match (horizon, height_of_eye) {
        (HorizonChoice::Standard, None) => Ok(EventOptions::default()),
        (HorizonChoice::Standard, Some(_)) => bail!(
            "--height-of-eye only applies with --horizon dip: the standard horizon is sea \
             level, and twilight never uses dip"
        ),
        (HorizonChoice::Dip, Some(h)) => Ok(EventOptions {
            horizon: Horizon::Dip,
            height_of_eye_m: h,
        }),
        (HorizonChoice::Dip, None) => bail!(
            "--horizon dip lowers rise and set by the dip of the sea horizon, which needs \
             --height-of-eye M"
        ),
    }
}

/// `[jd_start, jd_end]` of `date` in `zone`: local midnight to local midnight.
pub fn day_window(date: Date, zone: &ResolvedZone) -> (f64, f64) {
    let start = date.jd0() - f64::from(zone.offset_minutes) / 1440.0;
    (start, start + 1.0)
}

pub fn run(a: &Args) -> Result<u8> {
    let options = event_options(a.horizon, a.height_of_eye)?;
    let zone = a.zone.resolve(a.position.lon);
    let (jd_start, jd_end) = day_window(a.date, &zone);
    let site = Site {
        lat_deg: a.position.lat,
        lon_deg: a.position.lon,
        height_m: a.height,
        ..Site::default()
    };
    // The site's Earth rotation: `--dut1` (the site's DUT1 field), else the IERS history,
    // taken at the middle of the day, as the WASM `day_events` does.
    super::wire::set_explorer_dut1(a.dut1.dut1)?;
    let sky = skyfix_wasm::explorer::native::sky_at(0.5 * (jd_start + jd_end));
    let day = events::day_events(&sky, &site, jd_start, jd_end, &a.bodies.0, &options)
        .map_err(|e| anyhow!("{e}"))?;

    if a.format.is_json() {
        let doc = EventsJson {
            date: a.date.to_string(),
            zone: &zone.label,
            utc_offset_minutes: zone.offset_minutes,
            day: &day,
        };
        report::emit_line(&serde_json::to_string_pretty(&doc)?)?;
    } else {
        report::emit(&render(&day, &site, a.date, &zone, &options))?;
    }
    for e in &day.errors {
        eprintln!("not computed: {}: {}", e.body, e.message);
    }
    Ok(if day.errors.is_empty() {
        exit::OK
    } else {
        exit::SIGHTS_REJECTED
    })
}

pub fn kind_words(k: EventKind) -> &'static str {
    match k {
        EventKind::AstronomicalDawn => "astronomical dawn",
        EventKind::NauticalDawn => "nautical dawn",
        EventKind::CivilDawn => "civil dawn",
        EventKind::Rise => "rise",
        EventKind::Transit => "transit",
        EventKind::Set => "set",
        EventKind::CivilDusk => "civil dusk",
        EventKind::NauticalDusk => "nautical dusk",
        EventKind::AstronomicalDusk => "astronomical dusk",
        EventKind::LowerTransit => "lower transit",
    }
}

/// `local  UTC` or just `UTC`, for one instant.
fn when(jd: f64, zone: &ResolvedZone) -> String {
    if zone.is_utc() {
        text::utc(jd)
    } else {
        format!(
            "{}  {}",
            text::clock(jd, zone.offset_minutes),
            text::utc(jd)
        )
    }
}

/// The headings over [`when`] and the two spaces after it; the clock's word is the one
/// the day's times are printed on (UTC, or UT outside 1972-2035).
fn when_header(zone: &ResolvedZone, jd: f64) -> String {
    let clock = text::scale_word(jd);
    if zone.is_utc() {
        report::pad(clock, 22)
    } else {
        format!("{}{}", report::pad("local", 10), report::pad(clock, 22))
    }
}

pub fn render(
    day: &DayEvents,
    site: &Site,
    date: Date,
    zone: &ResolvedZone,
    options: &EventOptions,
) -> String {
    let p = LatLon {
        lat_deg: site.lat_deg,
        lon_deg: site.lon_deg,
    };
    let mut out = String::from("EVENTS\n");
    out.push_str(&format!(
        "Observer   {} ({})\n",
        report::format_position(p),
        report::format_position_decimal(p)
    ));
    out.push_str(&format!(
        "Day        {date} in {}: {} to {}\n",
        zone.label,
        text::utc(day.jd_start),
        text::utc(day.jd_end)
    ));
    let horizon = match options.horizon {
        Horizon::Standard => "standard: rise and set when the centre is at -50' for the Sun, \
                              -34' - SD for the Moon and -34' for planets and stars"
            .to_string(),
        Horizon::Dip => format!(
            "dip for {} m height of eye: every rise and set altitude lowered by a further \
             {:.1}' (twilight never uses dip)",
            options.height_of_eye_m,
            options.dip_deg() * 60.0
        ),
    };
    for (i, line) in report::wrap(&horizon, 78, "           ")
        .into_iter()
        .enumerate()
    {
        if i == 0 {
            out.push_str(&format!("Horizon    {}\n", line.trim_start()));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }

    out.push_str("\nSky phases\n");
    out.push_str(&format!("  {}phase\n", when_header(zone, day.jd_start)));
    for ph in &day.phases {
        let until = if ph.jd_end >= day.jd_end {
            "the end of the day".to_string()
        } else if zone.is_utc() {
            text::utc(ph.jd_end)
        } else {
            text::clock(ph.jd_end, zone.offset_minutes)
        };
        out.push_str(&format!(
            "  {}  {} until {until}\n",
            when(ph.jd_start, zone),
            phase_words(ph.phase),
        ));
    }

    for b in &day.bodies {
        out.push('\n');
        let mut title = b.body.clone();
        if let Some(h) = b.day_length_h {
            title.push_str(&format!("   day length {}", text::hours_minutes(h)));
        }
        if b.always_above {
            title.push_str("   above the horizon all day: no rise or set");
        } else if b.always_below {
            title.push_str("   below the horizon all day: no rise or set");
        }
        out.push_str(&title);
        out.push('\n');
        if b.events.is_empty() {
            out.push_str("  no events in this day\n");
            continue;
        }
        out.push_str(&format!(
            "  {}{}{:>9}{:>10}\n",
            when_header(zone, day.jd_start),
            report::pad("event", 19),
            "alt",
            "Az"
        ));
        for e in &b.events {
            out.push_str(&format!(
                "  {}  {}{:>9}{:>10}\n",
                when(e.jd_utc, zone),
                report::pad(kind_words(e.kind), 19),
                text::alt(e.alt_deg),
                text::dm360(e.az_deg)
            ));
        }
    }
    if !day.errors.is_empty() {
        out.push_str("\nNot computed\n");
        for e in &day.errors {
            out.push_str(&format!("  - {}: {}\n", e.body, e.message));
        }
    }
    out.push('\n');
    for line in report::wrap(
        "Times are to the nearest second, and --format json carries the milliseconds. alt is \
         the geometric altitude of the centre (no refraction; at a rise or set it is the \
         threshold used) and Az is true. Rise and set assume the standard 34' of refraction \
         at the horizon; the real air changes it, and with it the times, by a minute or more \
         (CONVENTIONS 13.3).",
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
    super::wire::push_tier_note(&mut out, day.jd_start, day.jd_end);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_height_of_eye_and_the_dip_horizon_go_together() {
        assert_eq!(
            event_options(HorizonChoice::Standard, None).unwrap(),
            EventOptions::default()
        );
        let dip = event_options(HorizonChoice::Dip, Some(4.0)).unwrap();
        assert_eq!((dip.horizon, dip.height_of_eye_m), (Horizon::Dip, 4.0));
        assert!(event_options(HorizonChoice::Dip, None).is_err());
        assert!(event_options(HorizonChoice::Standard, Some(4.0)).is_err());
    }

    #[test]
    fn the_day_runs_from_local_midnight_to_local_midnight() {
        let date = super::super::args::parse_date("2026-09-24").unwrap();
        let (s, e) = day_window(date, &Zone::Fixed(-240).resolve(0.0));
        assert_eq!(text::utc(s), "2026-09-24T04:00:00Z");
        assert_eq!(text::utc(e), "2026-09-25T04:00:00Z");
        let (s, _) = day_window(date, &Zone::Utc.resolve(0.0));
        assert_eq!(text::utc(s), "2026-09-24T00:00:00Z");
    }
}
