//! `skyfix phases` and `skyfix seasons`. OWNER: cli agent.
//!
//! The astronomy is the explorer's display sky (`skyfix_wasm::explorer::native::sky`,
//! both coverage tiers, CONVENTIONS 15.1), as the exports use it: 585 BC's phases and
//! seasons are answered, in the labelled tier.
//!
//! `skyfix_almanac::events::moon_phases` and `::seasons` (EXPLORER_API.md; definitions in
//! CONVENTIONS 13.5): the instants when the Moon's apparent geocentric ecliptic longitude
//! minus the Sun's is 0, 90, 180 and 270 degrees, and when the Sun's own is. `--format
//! json` prints the engine's list exactly; every instant is UTC.
//!
//! `--zone` works as it does for `events` (see `zone.rs`): a date given to `--from` or
//! `--to` is a date in that zone, from local midnight to local midnight, and the text
//! shows each instant's local date and time beside UTC. The instants themselves are the
//! same everywhere on Earth, so the zone never changes one; with no observer, the nautical
//! zone takes its longitude from `--lon`. The JSON stays the engine's list of UTC instants
//! whatever the zone, as the engine's results always are (CONVENTIONS 13.8).

use anyhow::{Result, anyhow};
use skyfix_almanac::events::{self, MoonPhaseKind, SeasonKind};

use super::args::{FormatArgs, When, parse_when, window};
use super::text;
use super::zone::{ResolvedZone, ZoneArgs};
use crate::exit;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct PhasesArgs {
    /// Start: YYYY-MM-DD (local midnight that day in --zone, UTC by default) or an RFC
    /// 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when, allow_hyphen_values = true)]
    pub from: When,
    /// End: YYYY-MM-DD (through the END of that day in --zone) or an RFC 3339 UTC
    /// instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when, allow_hyphen_values = true)]
    pub to: When,
    #[command(flatten)]
    pub zone: ZoneArgs,
    #[command(flatten)]
    pub format: FormatArgs,
}

#[derive(clap::Args, Debug)]
pub struct SeasonsArgs {
    // The span comes from the engine (`explorer_coverage`), not a literal.
    #[arg(
        long,
        value_name = "YEAR",
        allow_negative_numbers = true,
        help = format!(
            "The calendar year (astronomical: 0 is 1 BC, -584 is 585 BC), inside the \
             coverage: {}",
            super::wire::display_span()
        )
    )]
    pub year: i32,
    #[command(flatten)]
    pub zone: ZoneArgs,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn phase_words(k: MoonPhaseKind) -> &'static str {
    match k {
        MoonPhaseKind::NewMoon => "new moon",
        MoonPhaseKind::FirstQuarter => "first quarter",
        MoonPhaseKind::FullMoon => "full moon",
        MoonPhaseKind::LastQuarter => "last quarter",
    }
}

pub fn season_words(k: SeasonKind) -> &'static str {
    match k {
        SeasonKind::MarchEquinox => "March equinox",
        SeasonKind::JuneSolstice => "June solstice",
        SeasonKind::SeptemberEquinox => "September equinox",
        SeasonKind::DecemberSolstice => "December solstice",
    }
}

pub fn run_phases(a: &PhasesArgs) -> Result<u8> {
    let zone = a.zone.resolve()?;
    // A date is a date in the zone: local midnight to local midnight.
    let (start, end) = window(a.from, a.to, zone.offset_minutes)?;
    let phases = events::moon_phases(&skyfix_wasm::explorer::native::sky(), start, end)
        .map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&phases)?)?;
        return Ok(exit::OK);
    }
    let rows: Vec<(f64, &str)> = phases
        .iter()
        .map(|p| (p.jd_utc, phase_words(p.kind)))
        .collect();
    let mut out = format!("MOON PHASES  {} to {}", text::utc(start), text::utc(end));
    out.push_str(&shown_in(&zone));
    out.push('\n');
    out.push_str(&table(&rows, &zone, "phase", "  none in this window\n"));
    out.push('\n');
    let mut note = String::from(
        "The instants at which the Moon's apparent geocentric ecliptic longitude minus the \
         Sun's is 0, 90, 180 and 270 degrees (CONVENTIONS 13.5), to the nearest second; \
         --format json carries the milliseconds.",
    );
    note.push_str(&zone_note(&zone, true));
    push_wrapped(&mut out, &note);
    super::wire::push_tier_note(&mut out, start, end);
    report::emit(&out)?;
    Ok(exit::OK)
}

pub fn run_seasons(a: &SeasonsArgs) -> Result<u8> {
    let zone = a.zone.resolve()?;
    let seasons = events::seasons(&skyfix_wasm::explorer::native::sky(), a.year)
        .map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&seasons)?)?;
        return Ok(exit::OK);
    }
    let rows: Vec<(f64, &str)> = seasons
        .iter()
        .map(|s| (s.jd_utc, season_words(s.kind)))
        .collect();
    let mut out = format!("SEASONS {}", a.year);
    out.push_str(&shown_in(&zone));
    out.push('\n');
    out.push_str(&table(&rows, &zone, "season", ""));
    out.push('\n');
    let mut note = String::from(
        "The instants at which the Sun's apparent geocentric ecliptic longitude is 0, 90, 180 \
         and 270 degrees (CONVENTIONS 13.5), to the nearest second; --format json carries the \
         milliseconds.",
    );
    note.push_str(&zone_note(&zone, false));
    push_wrapped(&mut out, &note);
    if let (Some(first), Some(last)) = (seasons.first(), seasons.last()) {
        super::wire::push_tier_note(&mut out, first.jd_utc, last.jd_utc);
    }
    report::emit(&out)?;
    Ok(exit::OK)
}

/// `, shown in UTC-04:00` after a title, or nothing for UTC.
fn shown_in(zone: &ResolvedZone) -> String {
    if zone.is_utc() {
        String::new()
    } else {
        format!(", shown in {}", zone.label)
    }
}

/// One row per instant: `UTC  words` in UTC, `local  UTC  words` in any other zone, with
/// a heading over the two time columns so they cannot be confused.
fn table(rows: &[(f64, &str)], zone: &ResolvedZone, what: &str, empty: &str) -> String {
    let mut out = String::new();
    if !zone.is_utc() && !rows.is_empty() {
        out.push_str(&format!(
            "  {}{}{what}\n",
            report::pad("local", 21),
            report::pad(text::scale_word(rows[0].0), 22)
        ));
    }
    if rows.is_empty() {
        out.push_str(empty);
    }
    for (jd, words) in rows {
        if zone.is_utc() {
            out.push_str(&format!("  {}  {words}\n", text::utc(*jd)));
        } else {
            out.push_str(&format!(
                "  {}  {}  {words}\n",
                text::local_datetime(*jd, zone.offset_minutes),
                text::utc(*jd)
            ));
        }
    }
    out
}

/// What the zone did, for the note under the table; nothing in UTC.
fn zone_note(zone: &ResolvedZone, window: bool) -> String {
    if zone.is_utc() {
        return String::new();
    }
    let mut s = format!(
        " The local column is the date and time in {}; the instants themselves are the same \
         everywhere on Earth, and --format json keeps them in UTC.",
        zone.label
    );
    if window {
        s.push_str(" A date given to --from or --to is a date in that zone, from local midnight.");
    }
    s
}

fn push_wrapped(out: &mut String, text: &str) {
    for line in report::wrap(text, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
}
