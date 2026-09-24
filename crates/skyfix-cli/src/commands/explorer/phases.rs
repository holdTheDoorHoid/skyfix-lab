//! `skyfix phases` and `skyfix seasons`. OWNER: cli agent.
//!
//! `skyfix_almanac::events::moon_phases` and `::seasons` (EXPLORER_API.md; definitions in
//! CONVENTIONS 13.5): the instants when the Moon's apparent geocentric ecliptic longitude
//! minus the Sun's is 0, 90, 180 and 270 degrees, and when the Sun's own is. `--format
//! json` prints the engine's list exactly; every instant is UTC.

use anyhow::{Result, anyhow, bail};
use skyfix_almanac::events::{self, MoonPhaseKind, SeasonKind};
use skyfix_ephemeris::body::Sky;

use super::args::{FormatArgs, When, parse_when};
use super::text;
use crate::exit;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct PhasesArgs {
    /// Start: YYYY-MM-DD (00:00 UTC that day) or an RFC 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub from: When,
    /// End: YYYY-MM-DD (through the END of that day, UTC) or an RFC 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub to: When,
    #[command(flatten)]
    pub format: FormatArgs,
}

#[derive(clap::Args, Debug)]
pub struct SeasonsArgs {
    /// The calendar year, inside the Sun's coverage (1990 to 2060).
    #[arg(long, value_name = "YEAR")]
    pub year: i32,
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
    let (start, end) = (a.from.start_jd(), a.to.end_jd());
    if end <= start {
        bail!(
            "--to must come after --from (a date as --to means the end of that day): {} is not \
             after {}",
            text::utc(end),
            text::utc(start)
        );
    }
    let phases = events::moon_phases(&Sky::new(), start, end).map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&phases)?)?;
        return Ok(exit::OK);
    }
    let mut out = format!("MOON PHASES  {} to {}\n", text::utc(start), text::utc(end));
    if phases.is_empty() {
        out.push_str("  none in this window\n");
    }
    for p in &phases {
        out.push_str(&format!(
            "  {}  {}\n",
            text::utc(p.jd_utc),
            phase_words(p.kind)
        ));
    }
    out.push('\n');
    for line in report::wrap(
        "The instants at which the Moon's apparent geocentric ecliptic longitude minus the \
         Sun's is 0, 90, 180 and 270 degrees (CONVENTIONS 13.5), to the nearest second; \
         --format json carries the milliseconds.",
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
    report::emit(&out)?;
    Ok(exit::OK)
}

pub fn run_seasons(a: &SeasonsArgs) -> Result<u8> {
    let seasons = events::seasons(&Sky::new(), a.year).map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&seasons)?)?;
        return Ok(exit::OK);
    }
    let mut out = format!("SEASONS {}\n", a.year);
    for s in &seasons {
        out.push_str(&format!(
            "  {}  {}\n",
            text::utc(s.jd_utc),
            season_words(s.kind)
        ));
    }
    out.push('\n');
    for line in report::wrap(
        "The instants at which the Sun's apparent geocentric ecliptic longitude is 0, 90, 180 \
         and 270 degrees (CONVENTIONS 13.5), to the nearest second; --format json carries the \
         milliseconds.",
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
    report::emit(&out)?;
    Ok(exit::OK)
}
