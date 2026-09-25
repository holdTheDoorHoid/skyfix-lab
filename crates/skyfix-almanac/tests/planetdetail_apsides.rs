//! The Earth's perihelion and aphelion against USNO (1990-2060, UT to the minute),
//! Meeus's table 38.C (1991-2010, TD to 0.01 h, computed with the complete VSOP87) and
//! Skyfield + JPL DE440s (`fixtures/reference/planetdetail_apsides.json`).

mod pd_common;

use pd_common::{Worst, planet_coverage, read};
use serde::Deserialize;
use skyfix_almanac::earth_apsides::{ApsisKind, earth_apsides};
use skyfix_core::time::jd_tt;

#[derive(Debug, Deserialize)]
struct File {
    usno: Vec<Usno>,
    meeus_38c: Vec<Meeus>,
    skyfield: Vec<Sky>,
}

#[derive(Debug, Deserialize)]
struct Usno {
    kind: String,
    year: i32,
    jd_ut: f64,
}

#[derive(Debug, Deserialize)]
struct Meeus {
    kind: String,
    jd_tt: f64,
    distance_au: f64,
}

#[derive(Debug, Deserialize)]
struct Sky {
    kind: String,
    jd_utc: f64,
    distance_au: f64,
}

fn kind_name(k: ApsisKind) -> &'static str {
    match k {
        ApsisKind::Perihelion => "perihelion",
        ApsisKind::Aphelion => "aphelion",
    }
}

/// Ours for every year the fixture covers inside the providers' coverage.
fn ours(years: impl Iterator<Item = i32>) -> Vec<(String, f64, f64)> {
    let (lo, hi) = planet_coverage();
    let mut out = Vec::new();
    for y in years {
        if skyfix_core::time::civil_to_jd(y, 1, 1) < lo
            || skyfix_core::time::civil_to_jd(y + 1, 1, 1) > hi + 1.0
        {
            continue;
        }
        for e in earth_apsides(y).unwrap().events {
            out.push((kind_name(e.kind).to_string(), e.jd_utc, e.distance_au));
        }
    }
    out
}

fn nearest<'a>(list: &'a [(String, f64, f64)], kind: &str, jd: f64) -> &'a (String, f64, f64) {
    list.iter()
        .filter(|o| o.0 == kind)
        .min_by(|a, b| (a.1 - jd).abs().total_cmp(&(b.1 - jd).abs()))
        .unwrap()
}

#[test]
fn apsides_match_skyfield_usno_and_meeus() {
    let f = file();
    let ours = ours(1990..=2060);
    assert!(ours.len() >= 140, "{}", ours.len());
    // Skyfield + DE440s: the physical reference.
    let (mut dt, mut dr) = (Worst::default(), Worst::default());
    for s in &f.skyfield {
        if s.jd_utc < ours[0].1 - 5.0 || s.jd_utc > ours.last().unwrap().1 + 5.0 {
            continue;
        }
        let o = nearest(&ours, &s.kind, s.jd_utc);
        dt.add((o.1 - s.jd_utc) * 1440.0, || {
            format!("{} {}", s.kind, s.jd_utc)
        });
        dr.add(o.2 - s.distance_au, || format!("{} {}", s.kind, s.jd_utc));
    }
    // USNO, UT to the minute.
    let mut du = Worst::default();
    for u in &f.usno {
        let o = nearest(&ours, &u.kind, u.jd_ut);
        du.add((o.1 - u.jd_ut) * 1440.0, || {
            format!("{} {}", u.kind, u.year)
        });
    }
    // Meeus 38.C, TD.
    let (mut dm, mut dmr) = (Worst::default(), Worst::default());
    for m in &f.meeus_38c {
        let o = nearest(&ours, &m.kind, m.jd_tt - 64.0 / 86_400.0);
        dm.add((jd_tt(o.1) - m.jd_tt) * 1440.0, || {
            format!("{} {}", m.kind, m.jd_tt)
        });
        dmr.add(o.2 - m.distance_au, || format!("{} {}", m.kind, m.jd_tt));
    }
    println!(
        "vs Skyfield: {} (min), {} (au)\nvs USNO: {} (min)\nvs Meeus 38.C: {} (min), {} (au)",
        fmt(&dt),
        fmt(&dr),
        fmt(&du),
        fmt(&dm),
        fmt(&dmr)
    );
    assert!(dt.count >= 140 && du.count >= 140 && dm.count == 40);
    // The brief's target is 10 minutes; measured 1.1 (DE440s), 1.6 (USNO's minute) and
    // 0.5 (Meeus).
    assert!(dt.value.abs() < 2.0, "{dt:?}");
    assert!(du.value.abs() < 3.0, "{du:?}");
    assert!(dm.value.abs() < 2.0, "{dm:?}");
    // Meeus prints the radius vector to 1e-6 au.
    assert!(
        dr.value.abs() < 1e-7 && dmr.value.abs() < 1e-6,
        "{dr:?} {dmr:?}"
    );
}

fn fmt(w: &Worst) -> String {
    format!("worst {:+.3e} at {} ({} cases)", w.value, w.label, w.count)
}

fn file() -> File {
    serde_json::from_str(&read("fixtures/reference/planetdetail_apsides.json")).unwrap()
}
