//! Every eclipse of 1990-2060 against NASA's *Five Millennium Canon*
//! (`fixtures/reference/eclipses_nasa_canon.json`, parsed verbatim from the catalogue
//! pages by `tools/reference/gen_eclipses.py`).
//!
//! **How time is compared.** The canon lists greatest eclipse in Dynamical Time (TD) with
//! its own Delta-T (an extrapolation after about 2006: 74 s in 2024, about 113 s in
//! 2060). Our engine works in UTC with TT - UT1 = 32.184 s + (TAI - UTC) and DUT1 = 0,
//! exact to 0.9 s for the past and frozen at 69.184 s for the future. Greatest eclipse,
//! gamma, magnitudes and type are geocentric and do not depend on Earth rotation, so
//! they are compared in TT = TD, where Delta-T cancels. Only geographic positions (the
//! point of greatest eclipse, the Moon's zenith point) depend on it; those are rotated
//! by `1.0027379 * 15"/s * (Delta-T_NASA - Delta-T_ours)` before comparing, which is
//! exact for a pure clock difference.
//!
//! Run with `-- --nocapture` for the measured worst cases.

use std::collections::HashSet;

use serde::Deserialize;
use skyfix_almanac::eclipses::{Eclipse, Eclipses, LunarType, SolarType};
use skyfix_core::time::civil_to_jd;

const FIXTURE: &str = "fixtures/reference/eclipses_nasa_canon.json";
/// Earth rotation, degrees of longitude per second of UT1.
const DEG_PER_S: f64 = 1.002_737_811_911_354_5 * 360.0 / 86_400.0;

#[derive(Debug, Deserialize)]
struct Canon {
    schema: String,
    generator: Generator,
    solar: Vec<SolarRow>,
    lunar: Vec<LunarRow>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    tolerances: Tolerances,
}

#[derive(Debug, Deserialize)]
struct Tolerances {
    greatest_eclipse_td_s: f64,
    gamma: f64,
    magnitude: f64,
}

#[derive(Debug, Deserialize)]
struct SolarRow {
    date: String,
    jd_td: f64,
    delta_t_s: f64,
    lunation: i64,
    saros: i64,
    #[serde(rename = "type")]
    kind: String,
    gamma: f64,
    magnitude: f64,
    lat_deg: f64,
    lon_deg: f64,
    sun_alt_deg: f64,
    path_width_km: Option<f64>,
    central_duration_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct LunarRow {
    date: String,
    jd_td: f64,
    delta_t_s: f64,
    lunation: i64,
    saros: i64,
    #[serde(rename = "type")]
    kind: String,
    gamma: f64,
    penumbral_magnitude: f64,
    umbral_magnitude: f64,
    penumbral_duration_min: Option<f64>,
    partial_duration_min: Option<f64>,
    total_duration_min: Option<f64>,
    zenith_lat_deg: f64,
    zenith_lon_deg: f64,
}

fn load() -> Canon {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is committed: {e}", path.display()));
    let c: Canon = serde_json::from_str(&text).expect("fixture parses");
    assert_eq!(c.schema, "skyfix.reference/1");
    c
}

/// Great-circle angle between two points, degrees.
fn angle_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dl = (lon2 - lon1).to_radians();
    (p1.sin() * p2.sin() + p1.cos() * p2.cos() * dl.cos())
        .clamp(-1.0, 1.0)
        .acos()
        .to_degrees()
}

/// Our longitude as NASA's Delta-T would have put it.
fn lon_at_nasa_delta_t(lon: f64, ours_dt: f64, nasa_dt: f64) -> f64 {
    let l = lon + DEG_PER_S * (nasa_dt - ours_dt);
    (l + 540.0).rem_euclid(360.0) - 180.0
}

#[derive(Default)]
struct Worst {
    v: f64,
    at: String,
}

impl Worst {
    fn see(&mut self, v: f64, at: &str) {
        if v.abs() > self.v.abs() {
            self.v = v;
            self.at = at.to_string();
        }
    }
}

#[test]
fn every_eclipse_of_1990_2060_matches_the_canon() {
    let canon = load();
    let tol = &canon.generator.tolerances;
    assert_eq!((canon.solar.len(), canon.lunar.len()), (158, 162));

    let t0 = std::time::Instant::now();
    let list = Eclipses::new()
        .find(civil_to_jd(1990, 1, 1), civil_to_jd(2061, 1, 1))
        .unwrap();
    let elapsed = t0.elapsed();
    assert!(list.truncated, "the request runs past 2060-12-31T23:59:59Z");
    let solar: Vec<_> = list
        .eclipses
        .iter()
        .filter_map(|e| match e {
            Eclipse::Solar(s) => Some(s),
            Eclipse::Lunar(_) => None,
        })
        .collect();
    let lunar: Vec<_> = list
        .eclipses
        .iter()
        .filter_map(|e| match e {
            Eclipse::Lunar(l) => Some(l),
            Eclipse::Solar(_) => None,
        })
        .collect();
    assert_eq!(solar.len(), canon.solar.len(), "solar eclipse count");
    assert_eq!(lunar.len(), canon.lunar.len(), "lunar eclipse count");
    let ids: HashSet<&str> = list.eclipses.iter().map(|e| e.id()).collect();
    assert_eq!(ids.len(), list.eclipses.len(), "ids are unique");

    // ---- solar ----
    let (mut dt, mut dg, mut dm) = (Worst::default(), Worst::default(), Worst::default());
    let (mut dpos, mut dalt) = (Worst::default(), Worst::default());
    let (mut dwidth, mut dwidth_high, mut ddur) =
        (Worst::default(), Worst::default(), Worst::default());
    let mut types = [0usize; 4];
    for row in &canon.solar {
        let e = solar
            .iter()
            .min_by(|a, b| {
                (a.greatest.jd_tt - row.jd_td)
                    .abs()
                    .total_cmp(&(b.greatest.jd_tt - row.jd_td).abs())
            })
            .unwrap();
        let at = &row.date;
        let t_err = (e.greatest.jd_tt - row.jd_td) * 86_400.0;
        assert!(t_err.abs() < 43_200.0, "{at}: no eclipse near it");
        let want = match &row.kind[..1] {
            "T" => SolarType::Total,
            "A" => SolarType::Annular,
            "H" => SolarType::Hybrid,
            "P" => SolarType::Partial,
            other => panic!("{at}: unknown type {other}"),
        };
        assert_eq!(e.eclipse_type, want, "{at}: type {}", row.kind);
        types[want as usize] += 1;
        let noncentral = matches!(row.kind.chars().nth(1), Some('+') | Some('-'));
        assert_eq!(
            e.central,
            want != SolarType::Partial && !noncentral,
            "{at}: central ({})",
            row.kind
        );
        assert_eq!(e.saros, row.saros, "{at}: saros");
        assert_eq!(e.lunation, row.lunation, "{at}: lunation");
        dt.see(t_err, at);
        dg.see(e.gamma - row.gamma, at);
        dm.see(e.magnitude - row.magnitude, at);
        let lon = lon_at_nasa_delta_t(e.greatest.lon_deg, e.delta_t_s, row.delta_t_s);
        dpos.see(
            angle_deg(e.greatest.lat_deg, lon, row.lat_deg, row.lon_deg),
            at,
        );
        dalt.see(e.greatest.sun_alt_deg - row.sun_alt_deg, at);
        match (row.path_width_km, e.path_width_km) {
            (Some(w), Some(ours)) => {
                if row.sun_alt_deg >= 20.0 {
                    // NASA rounds to a kilometre; wide paths also differ by 0.3 %.
                    dwidth.see((ours - w) / w.max(300.0) * 300.0, at);
                } else {
                    dwidth_high.see((ours - w) / w, at);
                }
            }
            (None, None) => {}
            (w, ours) => panic!("{at}: path width {w:?} vs ours {ours:?}"),
        }
        if let (Some(d), Some(ours)) = (row.central_duration_s, e.central_duration_s) {
            ddur.see(ours - d, at);
        }
        assert_eq!(e.id, format!("{}-solar", &e.greatest.utc[..10]));
    }

    // ---- lunar ----
    let (mut lt, mut lg, mut lum, mut lpm) = (
        Worst::default(),
        Worst::default(),
        Worst::default(),
        Worst::default(),
    );
    let (mut lpd, mut lud, mut ltd, mut lzen) = (
        Worst::default(),
        Worst::default(),
        Worst::default(),
        Worst::default(),
    );
    for row in &canon.lunar {
        let e = lunar
            .iter()
            .min_by(|a, b| {
                (a.greatest.jd_tt - row.jd_td)
                    .abs()
                    .total_cmp(&(b.greatest.jd_tt - row.jd_td).abs())
            })
            .unwrap();
        let at = &row.date;
        let t_err = (e.greatest.jd_tt - row.jd_td) * 86_400.0;
        assert!(t_err.abs() < 43_200.0, "{at}: no eclipse near it");
        let want = match &row.kind[..1] {
            "T" => LunarType::Total,
            "P" => LunarType::Partial,
            "N" => LunarType::Penumbral,
            other => panic!("{at}: unknown type {other}"),
        };
        assert_eq!(e.eclipse_type, want, "{at}: type {}", row.kind);
        assert_eq!(e.saros, row.saros, "{at}: saros");
        assert_eq!(e.lunation, row.lunation, "{at}: lunation");
        lt.see(t_err, at);
        lg.see(e.gamma - row.gamma, at);
        lum.see(e.umbral_magnitude - row.umbral_magnitude, at);
        lpm.see(e.penumbral_magnitude - row.penumbral_magnitude, at);
        let dur = |s: Option<f64>, m: Option<f64>, w: &mut Worst, what: &str| match (s, m) {
            (Some(s), Some(m)) => w.see(s / 60.0 - m, at),
            (None, None) => {}
            (s, m) => panic!("{at}: {what} duration {m:?} min vs ours {s:?} s"),
        };
        dur(
            e.penumbral_duration_s,
            row.penumbral_duration_min,
            &mut lpd,
            "penumbral",
        );
        dur(
            e.partial_duration_s,
            row.partial_duration_min,
            &mut lud,
            "partial",
        );
        dur(
            e.total_duration_s,
            row.total_duration_min,
            &mut ltd,
            "total",
        );
        let lon = lon_at_nasa_delta_t(e.greatest.lon_deg, e.delta_t_s, row.delta_t_s);
        lzen.see(
            angle_deg(
                e.greatest.lat_deg,
                lon,
                row.zenith_lat_deg,
                row.zenith_lon_deg,
            ),
            at,
        );
        assert_eq!(e.id, format!("{}-lunar", &e.greatest.utc[..10]));
    }

    println!(
        "{} solar ({} total, {} annular, {} hybrid, {} partial) and {} lunar eclipses in {:?}",
        solar.len(),
        types[0],
        types[1],
        types[2],
        types[3],
        lunar.len(),
        elapsed
    );
    println!(
        "solar: greatest eclipse (TT vs TD) {:+.2} s at {}",
        dt.v, dt.at
    );
    println!(
        "       gamma {:+.5} at {}, magnitude {:+.5} at {}",
        dg.v, dg.at, dm.v, dm.at
    );
    println!(
        "       point of greatest eclipse {:.2} deg at {} (NASA rounds to whole degrees), Sun altitude {:+.2} deg at {}",
        dpos.v, dpos.at, dalt.v, dalt.at
    );
    println!(
        "       path width {:+.2} km per 300 km at {} (Sun >= 20 deg), {:+.1} % at {} (lower Sun)",
        dwidth.v,
        dwidth.at,
        100.0 * dwidth_high.v,
        dwidth_high.at
    );
    println!("       central duration {:+.2} s at {}", ddur.v, ddur.at);
    println!("lunar: greatest eclipse {:+.2} s at {}", lt.v, lt.at);
    println!(
        "       gamma {:+.5} at {}, umbral magnitude {:+.5} at {}, penumbral {:+.5} at {}",
        lg.v, lg.at, lum.v, lum.at, lpm.v, lpm.at
    );
    println!(
        "       durations: penumbral {:+.2} min at {}, partial {:+.2} min at {}, total {:+.2} min at {}",
        lpd.v, lpd.at, lud.v, lud.at, ltd.v, ltd.at
    );
    println!(
        "       Moon's zenith point {:.2} deg at {}",
        lzen.v, lzen.at
    );

    // The targets (docs/EXPLORER_PLAN.md work package K and the fixture's tolerances).
    assert!(dt.v.abs() <= tol.greatest_eclipse_td_s && lt.v.abs() <= tol.greatest_eclipse_td_s);
    assert!(dg.v.abs() <= tol.gamma && lg.v.abs() <= tol.gamma);
    assert!(dm.v.abs() <= tol.magnitude);
    assert!(lum.v.abs() <= tol.magnitude && lpm.v.abs() <= tol.magnitude);
    // What docs/ACCURACY.md, "Eclipses", records: regressions show up here first.
    assert!(dt.v.abs() < 5.0, "solar TD {}", dt.v);
    assert!(lt.v.abs() < 20.0, "lunar TD {}", lt.v);
    assert!(dg.v.abs() < 3e-4 && lg.v.abs() < 3e-4);
    assert!(dm.v.abs() < 1e-3 && lum.v.abs() < 1e-3 && lpm.v.abs() < 1e-3);
    // Positions: NASA rounds to whole degrees (0.71 deg at worst on the sphere).
    assert!(dpos.v < 0.8 && lzen.v < 0.8, "{} {}", dpos.v, lzen.v);
    assert!(dalt.v.abs() < 0.8);
    // NASA rounds widths to a kilometre and durations to a second.
    assert!(dwidth.v.abs() < 1.5, "{}", dwidth.v);
    assert!(dwidth_high.v.abs() < 0.05, "{}", dwidth_high.v);
    assert!(ddur.v.abs() < 1.5, "{}", ddur.v);
    // Durations to 0.1 min; the penumbral phase of a grazing eclipse is ill-conditioned
    // (2027-07-18 has penumbral magnitude 0.0014).
    assert!(
        lud.v.abs() < 0.5 && ltd.v.abs() < 0.5,
        "{} {}",
        lud.v,
        ltd.v
    );
    assert!(lpd.v.abs() < 1.5, "{}", lpd.v);
}

#[test]
fn well_known_eclipses_by_id() {
    let e = Eclipses::new();
    match e.by_id("2024-04-08-solar").unwrap() {
        Eclipse::Solar(s) => {
            assert_eq!(s.eclipse_type, SolarType::Total);
            assert_eq!(s.saros, 139);
            assert!((s.gamma - 0.3431).abs() < 5e-4, "{}", s.gamma);
            assert!(
                s.greatest.utc.starts_with("2024-04-08T18:17"),
                "{}",
                s.greatest.utc
            );
        }
        other => panic!("{other:?}"),
    }
    match e.by_id("2025-03-14-lunar").unwrap() {
        Eclipse::Lunar(l) => {
            assert_eq!(l.eclipse_type, LunarType::Total);
            assert_eq!(l.saros, 123);
            assert_eq!(l.contacts.len(), 6);
        }
        other => panic!("{other:?}"),
    }
    // Danjon's rule makes these two no eclipse at all (Chauvenet's gives penumbral
    // magnitudes 0.0165 and 0.0077): NASA's canon agrees.
    for date in ["2016-08-18", "2042-10-28"] {
        assert!(e.by_id(&format!("{date}-lunar")).is_err(), "{date}");
    }
    // And 2042-09-29 is penumbral, not partial.
    match e.by_id("2042-09-29-lunar").unwrap() {
        Eclipse::Lunar(l) => {
            assert_eq!(l.eclipse_type, LunarType::Penumbral);
            assert!(
                (-0.01..0.0).contains(&l.umbral_magnitude),
                "{}",
                l.umbral_magnitude
            );
        }
        other => panic!("{other:?}"),
    }
}

/// Timing in a release build (`cargo test --release -p skyfix-almanac --test
/// eclipse_canon -- --ignored --nocapture`): the budget is well under a second for the
/// whole of 1990-2060, and eclipse lookups by id are a few milliseconds.
#[test]
#[ignore]
fn scan_timing_release() {
    let e = Eclipses::new();
    let mut best = f64::INFINITY;
    for _ in 0..3 {
        let t0 = std::time::Instant::now();
        let list = e
            .find(civil_to_jd(1990, 1, 1), civil_to_jd(2061, 1, 1))
            .unwrap();
        best = best.min(t0.elapsed().as_secs_f64());
        assert_eq!(list.eclipses.len(), 320);
    }
    let t0 = std::time::Instant::now();
    for id in ["2024-04-08-solar", "2025-03-14-lunar", "2045-08-12-solar"] {
        e.by_id(id).unwrap();
    }
    let by_id = t0.elapsed().as_secs_f64() / 3.0;
    println!(
        "1990-2060: {:.0} ms (best of 3); by id: {:.1} ms",
        best * 1e3,
        by_id * 1e3
    );
    assert!(best < 1.0, "{best} s");
}
