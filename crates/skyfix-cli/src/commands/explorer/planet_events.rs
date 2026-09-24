//! `skyfix planet-events`: the planets' big moments in a window. OWNER: cli agent.
//!
//! `skyfix_almanac::planet_events::planet_events` (EXPLORER_API.md "Wave 2 — planet
//! events"; definitions and validation in docs/ACCURACY.md section 13), called as the WASM
//! export calls it (DUT1 = 0): every opposition, conjunction with the Sun (with the
//! engine's transit flag on inferior conjunctions), greatest elongation of Mercury and
//! Venus, and closest approach of Mercury to Neptune. The events are geocentric, the same
//! for every observer. `--body` keeps the planets asked for.
//!
//! `--format json` is the engine's `PlanetEventList`, its `events` filtered by `--body`,
//! with `bodies`, the planets kept.

use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use skyfix_almanac::planet_events::{PlanetEvent, PlanetEventKind, PlanetEventList, planet_events};
use skyfix_ephemeris::planets::{Planet, PlanetProvider};

use super::args::{FormatArgs, When, parse_when, window};
use super::text;
use crate::exit;
use crate::report;

/// A resolved `--body` list: planets in the engine's order, no duplicates.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanetList(pub Vec<Planet>);

/// `Mercury,venus, MARS` or `all`: planet names, matched without regard to case.
pub fn parse_planets(s: &str) -> Result<PlanetList, String> {
    let mut wanted = Vec::new();
    for item in s.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err(format!("--body {s:?} has an empty name in it"));
        }
        if item.eq_ignore_ascii_case("all") {
            wanted.extend(Planet::ALL);
            continue;
        }
        match Planet::from_name(item) {
            Some(p) => wanted.push(p),
            None => {
                return Err(format!(
                    "{item:?} is not a planet: planet events are for Mercury, Venus, Mars, \
                     Jupiter, Saturn, Uranus and Neptune (or all)"
                ));
            }
        }
    }
    Ok(PlanetList(
        Planet::ALL
            .into_iter()
            .filter(|p| wanted.contains(p))
            .collect(),
    ))
}

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Start: YYYY-MM-DD (00:00 UTC that day) or an RFC 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub from: When,
    /// End: YYYY-MM-DD (through the END of that day, UTC) or an RFC 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub to: When,
    /// The planets, comma-separated (Mercury, Venus, Mars, Jupiter, Saturn, Uranus,
    /// Neptune), or `all` (the default).
    #[arg(long, alias = "bodies", value_name = "NAME,...", default_value = "all", value_parser = parse_planets)]
    pub body: PlanetList,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `--format json`: the engine's list, filtered, with the planets kept.
#[derive(Serialize)]
struct EventsJson<'a> {
    #[serde(flatten)]
    list: &'a PlanetEventList,
    bodies: Vec<&'static str>,
}

/// The engine's events in `[start, end]` for the planets asked for. A window wholly
/// outside the coverage is a usage error; one that reaches past it is clipped, and the
/// list says so (`truncated`).
pub fn events(start: f64, end: f64, planets: &PlanetList) -> Result<PlanetEventList> {
    let mut list = planet_events(&PlanetProvider::new(), start, end).map_err(|e| anyhow!("{e}"))?;
    if list.jd_start > list.jd_end {
        bail!(
            "{} to {} is outside the planets' coverage, {} to {}",
            text::utc(start),
            text::utc(end),
            list.coverage_start_utc,
            list.coverage_end_utc
        );
    }
    let names: Vec<&str> = planets.0.iter().map(|p| p.name()).collect();
    list.events.retain(|e| names.contains(&e.body.as_str()));
    Ok(list)
}

pub fn run(a: &Args) -> Result<u8> {
    let (start, end) = window(a.from, a.to, 0)?;
    let list = events(start, end, &a.body)?;
    if list.truncated {
        eprintln!(
            "note: the window was clipped to the planets' coverage, {} to {}",
            list.coverage_start_utc, list.coverage_end_utc
        );
    }
    if a.format.is_json() {
        let doc = EventsJson {
            list: &list,
            bodies: a.body.0.iter().map(|p| p.name()).collect(),
        };
        report::emit_line(&serde_json::to_string_pretty(&doc)?)?;
    } else {
        report::emit(&render(&list, &a.body))?;
    }
    Ok(exit::OK)
}

pub fn kind_words(k: PlanetEventKind) -> &'static str {
    match k {
        PlanetEventKind::Opposition => "opposition",
        PlanetEventKind::Conjunction => "conjunction",
        PlanetEventKind::InferiorConjunction => "inferior conjunction",
        PlanetEventKind::SuperiorConjunction => "superior conjunction",
        PlanetEventKind::GreatestElongationEast => "greatest elongation east",
        PlanetEventKind::GreatestElongationWest => "greatest elongation west",
        PlanetEventKind::Perigee => "closest approach",
    }
}

/// The transit column: `yes` or `no` for an inferior conjunction, `-` for every other
/// kind, which can never be one.
fn transit(e: &PlanetEvent) -> &'static str {
    match (e.kind, e.transit) {
        (PlanetEventKind::InferiorConjunction, true) => "yes",
        (PlanetEventKind::InferiorConjunction, false) => "no",
        _ => "-",
    }
}

pub fn render(list: &PlanetEventList, planets: &PlanetList) -> String {
    let mut out = format!(
        "PLANET EVENTS  {} to {}\n",
        text::utc(list.jd_start),
        text::utc(list.jd_end)
    );
    if list.truncated {
        out.push_str(&format!(
            "Coverage       the window was clipped to the planets' coverage, {} to {}\n",
            list.coverage_start_utc, list.coverage_end_utc
        ));
    }
    let names: Vec<&str> = planets.0.iter().map(|p| p.name()).collect();
    out.push_str(&format!(
        "Planets        {}\n               geocentric: the same instants for every observer\n\n",
        names.join(", ")
    ));
    if list.events.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&format!(
            "  {}{}{}{:>9}{:>7}{:>9}{:>9}\n",
            report::pad("UTC", 22),
            report::pad("planet", 9),
            report::pad("event", 24),
            "elong.",
            "mag",
            "dist au",
            "transit"
        ));
    }
    for e in &list.events {
        out.push_str(&format!(
            "  {}  {}{}{:>9}{}{:>9.4}{:>9}\n",
            text::utc(e.jd_utc),
            report::pad(&e.body, 9),
            report::pad(kind_words(e.kind), 24),
            text::dm360(e.elongation_deg),
            text::opt(e.magnitude, 7, 2),
            e.distance_au,
            transit(e)
        ));
    }
    let transits: Vec<&PlanetEvent> = list.events.iter().filter(|e| e.transit).collect();
    out.push('\n');
    out.push_str(&format!(
        "{} event{} in the window",
        list.events.len(),
        if list.events.len() == 1 { "" } else { "s" }
    ));
    if transits.is_empty() {
        out.push_str(".\n");
    } else {
        let t: Vec<String> = transits
            .iter()
            .map(|e| format!("{} on {}", e.body, &text::utc(e.jd_utc)[..10]))
            .collect();
        out.push_str(&format!(
            ", with a transit across the Sun's disc: {}.\n",
            t.join(", ")
        ));
    }
    out.push('\n');
    for line in report::wrap(
        "elong. is the angle between the planet and the Sun seen from the Earth's centre (at a \
         conjunction, the planet's distance from the Sun's centre); at a greatest elongation \
         east the planet is in the evening sky after sunset, west in the morning sky before \
         sunrise. mag is the apparent visual magnitude (- where the model does not cover the \
         geometry); at a conjunction the planet is lost in the Sun's glare whatever its \
         magnitude. dist is the geocentric distance in astronomical units (--format json also \
         has kilometres). transit: an inferior conjunction of Mercury or Venus in which the \
         planet crosses the Sun's disc as seen from the Earth's centre; whether and when a \
         transit can be seen from a place is not computed. An outer planet's closest approach \
         comes within days of its opposition, and Mercury's and Venus's within days of their \
         inferior conjunctions: separate events with separate instants. Times are UTC to the \
         nearest second (--format json carries the milliseconds); against JPL DE440s they are \
         within 3 s for the conjunctions of Mercury and Venus, and 68 s at worst, for the \
         slowest outer planet (docs/ACCURACY.md section 13).",
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planets_parse_in_any_case_into_the_engines_order() {
        assert_eq!(
            parse_planets(" jupiter,MARS,Mars").unwrap().0,
            vec![Planet::Mars, Planet::Jupiter]
        );
        assert_eq!(parse_planets("all").unwrap().0.len(), 7);
        for bad in ["Moon", "Pluto", "Mars,,Venus", "Sun"] {
            assert!(parse_planets(bad).is_err(), "{bad}");
        }
        assert!(parse_planets("Pluto").unwrap_err().contains("Neptune"));
    }
}
