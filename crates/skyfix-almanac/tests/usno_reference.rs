//! Events against the US Naval Observatory, the independent check of CONVENTIONS 13.7.
//!
//! `fixtures/reference/events_usno.json` stores USNO API answers verbatim in the parts
//! that matter: Sun and Moon rise, set, upper transit and civil twilight for one UTC day
//! at 14 places, and the Moon phases and equinoxes/solstices of five years. USNO
//! publishes to the minute, so the target is **within 1 minute**. The Moon comparisons
//! use the real Moon provider (a provider that refuses fails the test).
//!
//! Two USNO conventions differ from ours and are handled explicitly, not hidden:
//!
//! - USNO lists a body's upper transit only when the body is up at that moment; we
//!   report every `LHA = 0` (CONVENTIONS 13.3). Our transits below the horizon are
//!   left out of the comparison.
//! - For **future** years USNO gives the instant of an equinox or a Moon phase in
//!   predicted UT (TT minus a predicted Delta-T), while this project counts UTC with no
//!   leap seconds after 2017 (TT - UTC = 69.184 s, CONVENTIONS 6). The instant is fixed
//!   in TT, so the two clocks read differently by the difference of the Delta-T
//!   assumptions: measured here as about +20 s in 2045 and +30 s in 2060 (Skyfield with
//!   our convention agrees with us to seconds). Rise and set are unaffected, being
//!   fixed by the Earth's rotation. Up to 2026 the 1-minute bound is asserted as it
//!   stands; for later years the check is that our instants sit in a one-minute band
//!   about a constant offset — i.e. they agree with USNO up to its rounding once the
//!   clock convention is taken out — and the offset is printed.

mod common;

use common::{load_fixture, site_of, skip_if_stub};
use serde_json::Value;
use skyfix_almanac::events::{EventOptions, day_events, moon_phases, seasons};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::topocentric::Site;

const SEC: f64 = 1.0 / 86_400.0;
const USNO_KINDS: [&str; 5] = ["civil_dawn", "rise", "transit", "set", "civil_dusk"];

/// `"YYYY-MM-DDTHH:MMZ"` (USNO's minute precision) to `jd_utc`.
fn jd_of(s: &str) -> f64 {
    let n = |a: usize, b: usize| s[a..b].parse::<u32>().unwrap();
    civil_to_jd(n(0, 4) as i32, n(5, 7), n(8, 10))
        + (f64::from(n(11, 13)) * 60.0 + f64::from(n(14, 16))) / 1440.0
}

fn site_named(doc: &Value, name: &str) -> Site {
    // The USNO file carries no site list: use the Sun fixture's.
    let sun = load_fixture("events_sun.json");
    let s = sun["generator"]["sites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .unwrap_or_else(|| panic!("site {name} not in events_sun.json ({})", doc["name"]))
        .clone();
    // USNO computes for sea level; the heights only move parallax by milliarcseconds.
    Site {
        height_m: 0.0,
        ..site_of(&s)
    }
}

/// Worst |ours - USNO| in seconds for one body over the stored UTC days.
fn compare_oneday(body: &str, key: &str) -> (usize, f64, String) {
    let doc = load_fixture("events_usno.json");
    let sky = Sky::new();
    let (mut n, mut worst, mut at) = (0, 0.0f64, String::new());
    for case in doc["oneday"].as_array().unwrap() {
        let site = site_named(&doc, case["site"].as_str().unwrap());
        let t0 = case["jd_start"].as_f64().unwrap();
        let what = format!("{body} {} {}", case["site"], case["date"]);
        let d = day_events(&sky, &site, t0, t0 + 1.0, &[body], &EventOptions::default())
            .unwrap_or_else(|e| panic!("{what}: {e}"));
        let ours: Vec<(String, f64)> = d.bodies[0]
            .events
            .iter()
            // USNO lists an upper transit only while the body is up.
            .filter(|e| e.kind != skyfix_almanac::events::EventKind::Transit || e.alt_deg > -0.9)
            .map(|e| {
                let k = serde_json::to_value(e.kind).unwrap();
                (k.as_str().unwrap().to_string(), e.jd_utc)
            })
            .filter(|(k, _)| USNO_KINDS.contains(&k.as_str()))
            .collect();
        let usno: Vec<(String, f64)> = case[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let hhmm = e[1].as_str().unwrap();
                let mins =
                    hhmm[..2].parse::<f64>().unwrap() * 60.0 + hhmm[3..].parse::<f64>().unwrap();
                (e[0].as_str().unwrap().to_string(), t0 + mins / 1440.0)
            })
            .collect();
        for kind in USNO_KINDS {
            let a: Vec<f64> = ours.iter().filter(|e| e.0 == kind).map(|e| e.1).collect();
            let b: Vec<f64> = usno.iter().filter(|e| e.0 == kind).map(|e| e.1).collect();
            assert_eq!(
                a.len(),
                b.len(),
                "{what} {kind}: ours {:?} USNO {:?}",
                a.iter().map(|&t| format_utc(t)).collect::<Vec<_>>(),
                b.iter().map(|&t| format_utc(t)).collect::<Vec<_>>()
            );
            for (x, y) in a.iter().zip(&b) {
                let d = (x - y).abs() / SEC;
                n += 1;
                if d > worst {
                    worst = d;
                    at = format!(
                        "{what} {kind}: ours {} USNO {}",
                        format_utc(*x),
                        format_utc(*y)
                    );
                }
            }
        }
    }
    (n, worst, at)
}

#[test]
fn sun_rise_set_transit_and_civil_twilight_are_within_a_minute_of_usno() {
    let (n, worst, at) = compare_oneday("Sun", "sun");
    eprintln!("Sun vs USNO: {n} events, worst {worst:.1} s ({at})");
    assert!(n >= 50, "{n}");
    assert!(worst <= 60.0, "{at}");
}

#[test]
fn moon_rise_set_and_transit_are_within_a_minute_of_usno() {
    if skip_if_stub(
        "Moon",
        civil_to_jd(2026, 9, 24),
        "moon_rise_set_and_transit_are_within_a_minute_of_usno",
    ) {
        return;
    }
    let (n, worst, at) = compare_oneday("Moon", "moon");
    eprintln!("Moon vs USNO: {n} events, worst {worst:.1} s ({at})");
    assert!(worst <= 60.0, "{at}");
}

fn usno_list(key: &str) -> Vec<(String, f64)> {
    load_fixture("events_usno.json")[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e[0].as_str().unwrap().to_string(),
                jd_of(e[1].as_str().unwrap()),
            )
        })
        .collect()
}

/// `ours - USNO` in seconds, grouped by year, checked as the module docs describe.
fn check_by_year(what: &str, diffs: &[(i32, f64)]) {
    let mut years: Vec<i32> = diffs.iter().map(|d| d.0).collect();
    years.sort_unstable();
    years.dedup();
    let mut lines = Vec::new();
    for y in years {
        let d: Vec<f64> = diffs.iter().filter(|d| d.0 == y).map(|d| d.1).collect();
        let (lo, hi) = d
            .iter()
            .fold((f64::MAX, f64::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)));
        let offset = 0.5 * (lo + hi);
        lines.push(format!(
            "{y}: {} events, ours - USNO {lo:+.1} .. {hi:+.1} s (band centre {offset:+.1} s)",
            d.len()
        ));
        if y <= 2026 {
            assert!(lo >= -60.0 && hi <= 60.0, "{what} {y}: {lo} .. {hi} s");
        } else {
            // Minute rounding around the Delta-T offset: a band at most 61 s wide.
            assert!(hi - lo <= 61.0, "{what} {y}: {lo} .. {hi} s");
            assert!(offset.abs() < 60.0, "{what} {y}: offset {offset} s");
        }
    }
    eprintln!("{what} vs USNO:\n  {}", lines.join("\n  "));
}

#[test]
fn equinoxes_and_solstices_are_within_a_minute_of_usno() {
    let usno = usno_list("seasons");
    assert!(usno.len() >= 20);
    let sky = Sky::new();
    let mut diffs = Vec::new();
    for (kind, t) in &usno {
        let year = format_utc(*t)[..4].parse::<i32>().unwrap();
        let ours = seasons(&sky, year).unwrap();
        let o = ours
            .iter()
            .find(|e| serde_json::to_value(e.kind).unwrap() == kind.as_str())
            .unwrap();
        diffs.push((year, (o.jd_utc - t) / SEC));
    }
    check_by_year("seasons", &diffs);
}

#[test]
fn moon_phases_are_within_a_minute_of_usno() {
    let usno = usno_list("moon_phases");
    if skip_if_stub("Moon", usno[0].1, "moon_phases_are_within_a_minute_of_usno") {
        return;
    }
    let sky = Sky::new();
    // The Moon provider stops at 2060-12-31T23:59:59Z.
    let end = civil_to_jd(2060, 12, 31) + 86_399.0 / 86_400.0;
    let mut diffs = Vec::new();
    for (kind, t) in &usno {
        let ours = moon_phases(&sky, t - 2.0, (t + 2.0).min(end)).unwrap();
        let o = ours
            .iter()
            .find(|e| serde_json::to_value(e.kind).unwrap() == kind.as_str())
            .unwrap_or_else(|| panic!("no {kind} near {}", format_utc(*t)));
        let year = format_utc(*t)[..4].parse::<i32>().unwrap();
        diffs.push((year, (o.jd_utc - t) / SEC));
    }
    check_by_year("Moon phases", &diffs);
}
