//! Custom bodies from MPC elements against Skyfield's `skyfield.data.mpc` two-body orbits
//! observed with DE440s (`fixtures/reference/planetdetail_orbits.json`): six minor
//! planets (MPCORB lines: Ceres, Vesta, Eros, Icarus, Apophis, Bennu) and six comets
//! (`CometEls.txt` lines: 2P, 12P, 29P, C/2023 A3, C/2024 G3, C/1995 O1 — elliptic,
//! near-parabolic and hyperbolic), at the elements' epoch -60, 0, +30 and +200 days.
//! Both sides are unperturbed two-body orbits from the same elements, so they must agree
//! far better than either agrees with the real sky (MPC source stated in the fixture).

mod pd_common;

use pd_common::{Worst, jd_utc_from_tt, planet_coverage, read};
use serde::Deserialize;
use skyfix_almanac::orbits::{OrbitClass, orbit_position, parse_orbits};

#[derive(Debug, Deserialize)]
struct File {
    mpcorb_lines: Vec<String>,
    comet_lines: Vec<String>,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    source: String,
    name: String,
    line: String,
    positions: Vec<Pos>,
}

#[derive(Debug, Deserialize)]
struct Pos {
    jd_tt: f64,
    ra_deg: f64,
    dec_deg: f64,
    distance_au: f64,
}

#[test]
fn mpc_lines_parse_and_propagate_as_skyfield_does() {
    let f: File =
        serde_json::from_str(&read("fixtures/reference/planetdetail_orbits.json")).unwrap();
    // The whole files parse as they are, several bodies at once.
    let all = parse_orbits(&f.mpcorb_lines.join("\n")).unwrap();
    assert_eq!(all.len(), 6);
    assert!(all.iter().all(|e| e.class == OrbitClass::Asteroid));
    let comets = parse_orbits(&f.comet_lines.join("\n")).unwrap();
    assert_eq!(comets.len(), 6);
    assert!(
        comets.iter().any(|e| e.eccentricity > 1.0),
        "a hyperbolic comet is included"
    );
    let (lo, hi) = planet_coverage();
    let (mut sky, mut dist) = (Worst::default(), Worst::default());
    let mut n = 0;
    for case in &f.cases {
        let el = parse_orbits(&case.line).unwrap().remove(0);
        assert!(
            case.name
                .contains(el.name.trim_start_matches('(').split(')').next().unwrap())
                || el.name.contains(&case.name),
            "{} parsed as {}",
            case.name,
            el.name
        );
        assert_eq!(
            el.class,
            if case.source == "mpcorb" {
                OrbitClass::Asteroid
            } else {
                OrbitClass::Comet
            }
        );
        for p in &case.positions {
            let jd = jd_utc_from_tt(p.jd_tt);
            if jd < lo || jd > hi {
                continue;
            }
            let got = orbit_position(&el, jd).unwrap();
            let dra = pd_common::wrap(got.ra_deg, p.ra_deg) * p.dec_deg.to_radians().cos();
            let ddec = got.dec_deg - p.dec_deg;
            let err = dra.hypot(ddec) * 3600.0;
            sky.add(err, || format!("{} jd_tt {}", case.name, p.jd_tt));
            dist.add(got.distance_au / p.distance_au - 1.0, || {
                format!("{} jd_tt {}", case.name, p.jd_tt)
            });
            n += 1;
        }
    }
    println!("{n} positions: on the sky {sky:?} (arcsec)\ndistance {dist:?} (relative)");
    assert!(n >= 40, "{n}");
    assert!(sky.value < 1.0, "{sky:?}");
    assert!(dist.value.abs() < 1e-6, "{dist:?}");
}

#[test]
fn stale_elements_are_flagged() {
    let f: File =
        serde_json::from_str(&read("fixtures/reference/planetdetail_orbits.json")).unwrap();
    let el = parse_orbits(&f.mpcorb_lines[2]).unwrap().remove(0);
    let epoch = el.epoch_jd_tt.unwrap();
    let fresh = orbit_position(&el, jd_utc_from_tt(epoch + 5.0)).unwrap();
    assert!(fresh.warnings.is_empty());
    let old = orbit_position(&el, jd_utc_from_tt(epoch + 200.0)).unwrap();
    assert_eq!(old.warnings.len(), 1);
    assert!((old.elements_age_days - 200.0).abs() < 0.01);
    assert!(old.magnitude.is_some());
}
