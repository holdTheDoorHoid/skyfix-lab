//! Equinoxes, solstices and Moon phases (CONVENTIONS 13.5) against Skyfield + DE440s
//! over 1990-2060, and the Moon-phase algorithm on the synthetic Moon.
//!
//! Target (CONVENTIONS 13.7): within 1 minute. The seasons use the real Sun and run
//! now; the Moon phases need the real Moon provider and **skip loudly** while it is a
//! stub, but the algorithm itself (every quarter found once, in order, the right kind)
//! is proven here on the synthetic Moon against the same reference, loosely.

mod common;

use common::{SyntheticSky, load_fixture, skip_if_stub};
use skyfix_almanac::events::{MoonPhaseKind, moon_phases, seasons};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_ephemeris::body::{BodyEphemeris, Sky};

const SEC: f64 = 1.0 / 86_400.0;

fn reference(name: &str) -> Vec<(String, f64)> {
    load_fixture(name)["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e[0].as_str().unwrap().to_string(), e[1].as_f64().unwrap()))
        .collect()
}

fn kind_name<T: serde::Serialize>(k: T) -> String {
    serde_json::to_value(k)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn equinoxes_and_solstices_1990_2060_match_skyfield_within_a_minute() {
    let want = reference("events_seasons.json");
    assert_eq!(want.len(), 71 * 4);
    let sky = Sky::new();
    let mut worst = (0.0f64, String::new());
    for year in 1990..=2060 {
        let got = seasons(&sky, year).unwrap();
        assert_eq!(got.len(), 4, "{year}");
        let t0 = civil_to_jd(year, 1, 1);
        let t1 = civil_to_jd(year + 1, 1, 1);
        let refs: Vec<&(String, f64)> = want.iter().filter(|e| e.1 >= t0 && e.1 < t1).collect();
        assert_eq!(refs.len(), 4, "{year}");
        for (g, r) in got.iter().zip(refs) {
            assert_eq!(kind_name(g.kind), r.0, "{year}");
            let d = (g.jd_utc - r.1).abs() / SEC;
            if d > worst.0 {
                worst = (d, format!("{} {}", r.0, format_utc(r.1)));
            }
        }
    }
    eprintln!(
        "seasons 1990-2060 vs Skyfield/DE440s: 284 events, worst {:.2} s ({})",
        worst.0, worst.1
    );
    assert!(worst.0 < 60.0, "{worst:?}");
}

/// Match our phases to the reference inside `[t0, t1)`; returns the worst |dt| (s).
fn compare_phases(eph: &dyn BodyEphemeris, want: &[(String, f64)], t0: f64, t1: f64) -> f64 {
    let got = moon_phases(eph, t0, t1).unwrap();
    let refs: Vec<&(String, f64)> = want.iter().filter(|e| e.1 > t0 && e.1 < t1).collect();
    assert_eq!(
        got.len(),
        refs.len(),
        "{} to {}: {got:?}",
        format_utc(t0),
        format_utc(t1)
    );
    let mut worst = 0.0f64;
    for (g, r) in got.iter().zip(refs) {
        assert_eq!(kind_name(g.kind), r.0, "at {}", format_utc(r.1));
        worst = worst.max((g.jd_utc - r.1).abs() / SEC);
    }
    worst
}

#[test]
fn moon_phases_1990_2060_match_skyfield_within_a_minute() {
    let want = reference("events_moon_phases.json");
    if skip_if_stub(
        "Moon",
        want[0].1,
        "moon_phases_1990_2060_match_skyfield_within_a_minute",
    ) {
        return;
    }
    let sky = Sky::new();
    let mut worst = 0.0f64;
    for year in 1990..=2060 {
        let (t0, t1) = (
            civil_to_jd(year, 1, 1),
            civil_to_jd(year + 1, 1, 1).min(
                // The star-coverage end is the explorer's; the Moon may stop there too.
                civil_to_jd(2060, 12, 31) + 0.999,
            ),
        );
        worst = worst.max(compare_phases(&sky, &want, t0, t1));
    }
    eprintln!(
        "Moon phases 1990-2060 vs Skyfield/DE440s: {} events, worst {worst:.2} s",
        want.len()
    );
    assert!(worst < 60.0, "worst {worst} s");
}

/// The algorithm on the synthetic Moon: every quarter of 2020-2029 found exactly once,
/// in order and of the right kind, near the reference instant (the synthetic Moon is
/// only good to a few hundredths of a degree, i.e. several minutes of phase time).
#[test]
fn the_phase_finder_finds_every_quarter_once_on_the_synthetic_moon() {
    let want = reference("events_moon_phases.json");
    let eph = SyntheticSky::new();
    let worst = compare_phases(
        &eph,
        &want,
        civil_to_jd(2020, 1, 1),
        civil_to_jd(2030, 1, 1),
    );
    eprintln!(
        "synthetic Moon phases 2020-2029 vs DE440s: worst {:.1} min",
        worst / 60.0
    );
    assert!(worst < 30.0 * 60.0, "{worst} s");
    // Short windows: nothing at the edges, one event when one quarter falls inside.
    let p = moon_phases(&eph, civil_to_jd(2026, 9, 20), civil_to_jd(2026, 9, 30)).unwrap();
    assert_eq!(p.len(), 1, "{p:?}");
    assert_eq!(p[0].kind, MoonPhaseKind::FullMoon);
}

#[test]
fn seasons_and_phases_refuse_what_they_cannot_answer() {
    assert!(seasons(&Sky::new(), 1989).is_err());
    assert!(seasons(&Sky::new(), 2061).is_err());
    let e = moon_phases(
        &Sky::new(),
        civil_to_jd(2026, 1, 1),
        civil_to_jd(2026, 2, 1),
    );
    if let Err(e) = e {
        assert!(e.to_string().contains("Moon"), "{e}");
    }
    assert!(moon_phases(&SyntheticSky::new(), 10.0, 5.0).is_err());
    assert!(moon_phases(&SyntheticSky::new(), f64::NAN, 5.0).is_err());
}
