//! Lunar distances against Skyfield's sky (docs/NAVIGATION_SKY.md, "Lunar distance").
//!
//! `fixtures/reference/lunar_distances.json` (tools/reference/gen_moon_sights.py) holds
//! sextant readings of the Moon's distance from the Sun, ten stars and four planets,
//! measured on the WGS84 Earth between refracted limbs found numerically, with the
//! observed altitudes and the true UTC. From exact inputs the UTC must come back within
//! the file's 5 seconds, with the altitudes computed from the (true) DR position and
//! with the altitudes as observed.

use serde::Deserialize;
use skyfix_core::sights::lunar::lunar_distance;
use skyfix_core::time::parse_utc;
use skyfix_core::types::{
    HorizonMode, Instrument, Limb, LunarAltitudeObservation, LunarDistanceInput, LunarLimb,
    SightObserver,
};
use skyfix_ephemeris::ProviderSource;
use skyfix_ephemeris::fixture_pack::CompositeProvider;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sights::SightPlanetProvider;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::sun::SunProvider;

const FIXTURE: &str = "fixtures/reference/lunar_distances.json";

#[derive(Debug, Deserialize)]
struct File {
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    time_tolerance_s: f64,
}

#[derive(Debug, Deserialize)]
struct Site {
    lat_deg: f64,
    lon_deg: f64,
}

#[derive(Debug, Deserialize)]
struct Alt {
    altitude_deg: f64,
    limb: Limb,
}

#[derive(Debug, Deserialize)]
struct Truth {
    geocentric_distance_deg: f64,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    utc: String,
    watch_utc: String,
    site: Site,
    body: String,
    moon_limb: LunarLimb,
    body_limb: LunarLimb,
    height_of_eye_m: f64,
    index_correction_arcmin: f64,
    pressure_hpa: f64,
    temperature_c: f64,
    sextant_distance_deg: f64,
    moon_altitude: Alt,
    body_altitude: Alt,
    truth: Truth,
}

fn source() -> ProviderSource<CompositeProvider> {
    ProviderSource(
        CompositeProvider::new("test-auto")
            .with(SunProvider::new())
            .with(MoonProvider::new())
            .with(SightPlanetProvider::new())
            .with(StarProvider::new()),
    )
}

fn input(c: &Case, observed: bool) -> LunarDistanceInput {
    let obs = |a: &Alt| LunarAltitudeObservation {
        altitude_deg: a.altitude_deg,
        altitude_kind: skyfix_core::types::AltitudeKind::SextantHs,
        limb: a.limb,
        sigma_arcmin: 1.0,
    };
    LunarDistanceInput {
        observer: SightObserver {
            lat_deg: c.site.lat_deg,
            lon_deg: c.site.lon_deg,
            height_of_eye_m: c.height_of_eye_m,
            pressure_hpa: c.pressure_hpa,
            temperature_c: c.temperature_c,
        },
        instrument: Instrument {
            name: String::new(),
            index_correction_arcmin: c.index_correction_arcmin,
            horizon: HorizonMode::Sea,
        },
        body: c.body.clone(),
        utc_estimate: c.watch_utc.clone(),
        distance_deg: c.sextant_distance_deg,
        moon_limb: c.moon_limb,
        body_limb: Some(c.body_limb),
        moon_altitude: observed.then(|| obs(&c.moon_altitude)),
        body_altitude: observed.then(|| obs(&c.body_altitude)),
        sigma_arcmin: 0.2,
        search_hours: 3.0,
        dr_uncertainty_nm: 0.0,
    }
}

#[test]
fn every_lunar_distance_gives_back_its_utc_within_five_seconds() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let f: File = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(f.cases.len() >= 20);
    let src = source();
    let mut worst = [0.0f64; 2];
    for c in &f.cases {
        let truth = parse_utc(&c.utc).unwrap();
        for (k, observed) in [false, true].into_iter().enumerate() {
            let r = lunar_distance(&input(c, observed), &src)
                .unwrap_or_else(|e| panic!("{} {}: {e}", c.id, c.body));
            let err_s = (r.jd_utc - truth) * 86_400.0;
            let cleared_err = (r.cleared_distance_deg - c.truth.geocentric_distance_deg) * 60.0;
            println!(
                "{} {:<9} {:<8} {}: UTC error {err_s:+6.2} s, sigma {:5.1} s, cleared {cleared_err:+.4}', rate {:+.3}'/min",
                c.id,
                c.body,
                if observed { "observed" } else { "computed" },
                r.utc,
                r.sigma_s,
                r.distance_rate_arcmin_per_min
            );
            assert!(
                err_s.abs() <= f.generator.time_tolerance_s,
                "{} {} ({}): {err_s:+.2} s",
                c.id,
                c.body,
                if observed {
                    "observed altitudes"
                } else {
                    "computed altitudes"
                }
            );
            worst[k] = worst[k].max(err_s.abs());
            // The honest sigma: 0.2' of measurement is about 25 s at 0.5'/min.
            assert!(
                r.sigma_s > 10.0 && r.sigma_s < 120.0,
                "{}: {}",
                c.id,
                r.sigma_s
            );
            assert!(r.alternatives.is_empty(), "{}: {:?}", c.id, r.alternatives);
        }
    }
    println!(
        "worst UTC error: {:.2} s with computed altitudes, {:.2} s with observed altitudes",
        worst[0], worst[1]
    );
}

/// Verifier regression: an altitude observed for one body and computed for the other.
///
/// At trial instants away from the truth the fixed observed altitude and the moving
/// computed one stop forming a triangle with the measured distance. The clearing used to
/// clamp the azimuth difference there, which discarded the measured distance, folded the
/// search function over within minutes of the truth and hid the true root from the
/// 10-minute scan: with only the Moon's altitude observed, 7 of these 22 cases came back
/// 4 minutes to 10 hours from the truth, each with a sigma of 4 to 10 seconds.
#[test]
fn one_observed_altitude_and_one_computed_give_back_the_utc_too() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let f: File = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let src = source();
    let mut worst = 0.0f64;
    for c in &f.cases {
        let truth = parse_utc(&c.utc).unwrap();
        let both = input(c, true);
        for which in ["Moon", "body"] {
            let mut one = both.clone();
            one.search_hours = 12.0;
            if which == "Moon" {
                one.body_altitude = None;
            } else {
                one.moon_altitude = None;
            }
            let r = lunar_distance(&one, &src)
                .unwrap_or_else(|e| panic!("{} {} ({which} observed): {e}", c.id, c.body));
            let err_s = (r.jd_utc - truth) * 86_400.0;
            println!(
                "{} {:<9} only the {which} observed: UTC error {err_s:+6.2} s",
                c.id, c.body
            );
            assert!(
                err_s.abs() <= f.generator.time_tolerance_s,
                "{} {} ({which} observed): {err_s:+.1} s, sigma {:.1} s",
                c.id,
                c.body,
                r.sigma_s
            );
            worst = worst.max(err_s.abs());
        }
    }
    println!("worst UTC error with one altitude observed: {worst:.2} s");
}

#[test]
fn a_wrong_dr_position_moves_the_time_about_as_the_reported_sensitivity_says() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let f: File = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let src = source();
    for c in f.cases.iter().take(6) {
        let truth = parse_utc(&c.utc).unwrap();
        let exact = lunar_distance(&input(c, false), &src).unwrap();
        // 30 NM east of the true position, altitudes computed there.
        let mut off = input(c, false);
        off.observer.lon_deg += 0.5 / off.observer.lat_deg.to_radians().cos();
        off.dr_uncertainty_nm = 30.0;
        let r = lunar_distance(&off, &src).unwrap();
        let err_s = (r.jd_utc - truth) * 86_400.0;
        // Predicted from the exact solution's sensitivity: 3 x (per 10 NM east).
        let per_s = exact.error_budget[0].distance_arcmin / exact.error_budget[0].time_s;
        let predicted = exact.dr_sensitivity_arcmin_per_10nm[1] * 3.0 / per_s;
        println!(
            "{} {}: 30 NM east of the truth moves the UTC {err_s:+.1} s (sensitivity predicts {:.1} s); sigma {:.1} s",
            c.id,
            c.body,
            predicted.abs(),
            r.sigma_s
        );
        assert!(
            (err_s.abs() - predicted.abs()).abs() < 0.2 * predicted.abs() + 3.0,
            "{}: {err_s} vs {predicted}",
            c.id
        );
        // With the DR uncertainty declared, the reported sigma covers the error.
        assert!(
            err_s.abs() < 2.0 * r.sigma_s,
            "{}: {err_s} vs {}",
            c.id,
            r.sigma_s
        );
        assert!(r.error_budget.iter().any(|t| t.name == "DR position"));
    }
}

#[test]
fn nonsense_is_refused_and_an_impossible_distance_is_explained() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let f: File = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let src = source();
    let c = &f.cases[0];
    let mut moon = input(c, false);
    moon.body = "Moon".into();
    assert!(lunar_distance(&moon, &src).is_err());
    let mut centre = input(c, false);
    centre.moon_limb = LunarLimb::Center;
    assert!(lunar_distance(&centre, &src).is_err());
    // Ten degrees more than the Moon ever gets from the Sun in three hours.
    let mut far = input(c, false);
    far.distance_deg += 10.0;
    let e = lunar_distance(&far, &src).unwrap_err().to_string();
    assert!(e.contains("never equals"), "{e}");
}
