//! Perigees, apogees and supermoons against Skyfield + JPL DE440s
//! (`fixtures/reference/moon_apsides.json`, `tools/moon/gen_reference.py`) and Meeus's
//! example 50.a. Target (EXPANSION_PLAN P8): 2 minutes and 10 km.
//!
//! Instants are compared in TT, so no UT1 assumption enters. Three windows of the
//! coverage are searched in full (the whole 1990-2060 run takes minutes in a debug
//! build); every fixture event inside them must be found, and nothing else.

use std::path::PathBuf;

use skyfix_almanac::apsides::{ApsisKind, SyzygyKind, find_apsides, moon_apsides};
use skyfix_core::time::{civil_to_jd, jd_tt};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::moon::{MoonProvider, elp82b_ecliptic_j2000_km};

fn fixture() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference/moon_apsides.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

const WINDOWS: [(i32, i32); 3] = [(1990, 1993), (2024, 2027), (2057, 2060)];

#[test]
fn apsides_match_skyfield_to_seconds_and_metres() {
    let fx = fixture();
    let rows = fx["apsides"].as_array().unwrap();
    let moon = MoonProvider::new();
    let sky = Sky::new();
    let (mut worst_s, mut worst_km, mut n) = (0.0f64, 0.0f64, 0);
    for (y0, y1) in WINDOWS {
        let (a, b) = (civil_to_jd(y0, 1, 1), civil_to_jd(y1 + 1, 1, 1));
        let r = moon_apsides(&moon, &sky, a, b).unwrap();
        // The fixture's events in the same window (its instants are TT).
        let want: Vec<(&str, f64, f64)> = rows
            .iter()
            .map(|e| {
                (
                    e[0].as_str().unwrap(),
                    e[1].as_f64().unwrap(),
                    e[2].as_f64().unwrap(),
                )
            })
            .filter(|e| e.1 > jd_tt(a) + 1.0 && e.1 < jd_tt(b) - 1.0)
            .collect();
        let got: Vec<_> = r
            .apsides
            .iter()
            .filter(|e| jd_tt(e.jd_utc) > jd_tt(a) + 1.0 && jd_tt(e.jd_utc) < jd_tt(b) - 1.0)
            .collect();
        assert_eq!(got.len(), want.len(), "{y0}-{y1}: one event per event");
        for (g, w) in got.iter().zip(&want) {
            let kind = match g.kind {
                ApsisKind::Perigee => "perigee",
                ApsisKind::Apogee => "apogee",
            };
            assert_eq!(kind, w.0);
            let ds = (jd_tt(g.jd_utc) - w.1) * 86_400.0;
            let dkm = g.distance_km - w.2;
            worst_s = worst_s.max(ds.abs());
            worst_km = worst_km.max(dkm.abs());
            n += 1;
        }
    }
    eprintln!(
        "apsides vs Skyfield + DE440s, {n} events in {WINDOWS:?}: worst instant \
         {worst_s:.1} s, worst distance {worst_km:.3} km"
    );
    assert!(n > 200);
    assert!(worst_s < 120.0, "{worst_s} s");
    assert!(worst_km < 10.0, "{worst_km} km");
}

#[test]
fn supermoons_micromoons_and_the_years_extremes_agree() {
    let fx = fixture();
    let rows = fx["syzygies"].as_array().unwrap();
    let moon = MoonProvider::new();
    let sky = Sky::new();
    let (mut n, mut flags_checked, mut borderline) = (0, 0, 0);
    let (mut worst_km, mut worst_fraction) = (0.0f64, 0.0f64);
    for (y0, y1) in WINDOWS {
        let (a, b) = (civil_to_jd(y0, 1, 1), civil_to_jd(y1 + 1, 1, 1));
        let r = moon_apsides(&moon, &sky, a, b).unwrap();
        for s in &r.syzygies {
            let t = jd_tt(s.jd_utc);
            let w = rows
                .iter()
                .min_by(|x, y| {
                    (x[1].as_f64().unwrap() - t)
                        .abs()
                        .total_cmp(&(y[1].as_f64().unwrap() - t).abs())
                })
                .unwrap();
            assert!((w[1].as_f64().unwrap() - t).abs() * 1440.0 < 1.0, "{s:?}");
            let kind = if s.kind == SyzygyKind::FullMoon {
                "full"
            } else {
                "new"
            };
            assert_eq!(w[0].as_str().unwrap(), kind);
            n += 1;
            worst_km = worst_km.max((s.distance_km - w[2].as_f64().unwrap()).abs());
            let fraction = w[7].as_f64().unwrap();
            worst_fraction = worst_fraction.max((s.perigee_fraction - fraction).abs());
            let flags = w[8].as_str().unwrap();
            // A syzygy within 0.001 of a threshold may fall either side.
            if (fraction - 0.9).abs() < 1e-3 || (fraction - 0.1).abs() < 1e-3 {
                borderline += 1;
            } else {
                assert_eq!(s.supermoon, flags.contains('S'), "{s:?} vs {w}");
                assert_eq!(s.micromoon, flags.contains('M'), "{s:?} vs {w}");
                flags_checked += 1;
            }
            assert_eq!(s.largest_of_year, flags.contains('L'), "{s:?} vs {w}");
            assert_eq!(s.smallest_of_year, flags.contains('s'), "{s:?} vs {w}");
        }
    }
    eprintln!(
        "new and full Moons vs Skyfield, {n} in {WINDOWS:?}: distance at the phase \
         {worst_km:.3} km, perigee fraction {worst_fraction:.5}; supermoon and \
         micromoon flags agree on all {flags_checked} away from a threshold \
         ({borderline} within 0.001 of one), largest and smallest of the year on all"
    );
    assert!(n > 250);
    assert!(worst_km < 10.0 && worst_fraction < 0.002);
}

#[test]
fn meeus_example_50a_apogee_of_october_1988() {
    // 1988 is outside this build's Moon coverage, so the search runs on the embedded
    // lunar theory itself (the same series the provider evaluates).
    let fx = fixture();
    let m = &fx["meeus_50a"];
    let dist = |jd_utc: f64| -> Result<f64, skyfix_almanac::sky::AlmanacError> {
        let p = elp82b_ecliptic_j2000_km(jd_tt(jd_utc)).unwrap();
        Ok((p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt())
    };
    let a = civil_to_jd(1988, 10, 1);
    let found = find_apsides(dist, a, a + 14.0).unwrap();
    let apogee = found
        .iter()
        .find(|e| e.0 == ApsisKind::Apogee)
        .expect("the apogee of 1988 October 7");
    let t = jd_tt(apogee.1);
    let vs_skyfield_s = (t - m["skyfield_jd_tt"].as_f64().unwrap()) * 86_400.0;
    let vs_skyfield_km = apogee.2 - m["skyfield_distance_km"].as_f64().unwrap();
    let vs_meeus_s = (t - m["meeus_jde"].as_f64().unwrap()) * 86_400.0;
    eprintln!(
        "Meeus 50.a (apogee 1988-10-07): {vs_skyfield_s:+.1} s and {vs_skyfield_km:+.3} km \
         from Skyfield + DE440s; {vs_meeus_s:+.1} s from Meeus's chapter-50 series"
    );
    assert!(vs_skyfield_s.abs() < 120.0 && vs_skyfield_km.abs() < 10.0);
    assert!(vs_meeus_s.abs() < 120.0);
}
