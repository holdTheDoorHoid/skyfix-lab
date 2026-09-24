//! Do the navigation methods' stated sigmas mean what they say?
//!
//! Seeded Monte Carlo on the independent sights of `fixtures/reference/nav_methods.json`:
//! Gaussian noise of the stated sigma is added, the method runs, and the error against
//! the fixture's truth is divided by the sigma the method reported. Honest sigmas put
//! 95 % of those inside 1.96 and make their mean square 1; [`nav_support::assert_honest`]
//! allows three binomial / chi-square standard deviations around both.
//!
//! The noon and averaging runs supply the fixture's own directions, which keeps each
//! repetition cheap and leaves our ephemeris out of a test about statistics. The Polaris
//! runs look the direction up at the (deliberately wrong) recorded time, which is
//! exactly the navigator's situation when the clock is off.
//!
//! `cargo test -p skyfix-core --test nav_methods_coverage -- --nocapture` prints the
//! coverage table docs/NAVIGATION_METHODS.md quotes.

mod nav_support;

use nav_support::{
    Normal, assert_honest, coverage, f, nav_fixture, observed_with_direction, provider, s,
};
use serde_json::Value;
use skyfix_core::geometry::Point;
use skyfix_core::methods::averaging::average_sights;
use skyfix_core::methods::hc_zn;
use skyfix_core::methods::noon::noon_sight;
use skyfix_core::methods::polaris::polaris_latitude;
use skyfix_core::reduce::DirectionSource;
use skyfix_core::time::{format_utc, parse_utc};
use skyfix_core::types::{
    AltitudeKind, AveragingOptions, DrPosition, Limb, NoonCurvature, NoonSightOptions, Observation,
    PolarisOptions,
};
use skyfix_core::units::norm_180;

fn case<'a>(doc: &'a Value, group: &str, name: &str) -> &'a Value {
    doc[group]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no {group} case {name}"))
}

#[test]
fn noon_sigmas_cover_the_truth() {
    let doc = nav_fixture();
    let c = case(&doc, "noon", "philadelphia-equinox-sun");
    let truth = &c["truth"];
    let sights = c["sights"].as_array().unwrap();
    let sigma = 0.5;
    let reps = 400;
    for curvature in [NoonCurvature::Predicted, NoonCurvature::Fitted] {
        let mut rng = Normal::new(20260924);
        let (mut zlat, mut zt, mut zlon) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..reps {
            let obs: Vec<Observation> = sights
                .iter()
                .map(|x| observed_with_direction(x, "Sun", sigma, sigma * rng.next()))
                .collect();
            let session = nav_support::fixture_session(obs);
            let options = NoonSightOptions {
                dr: Some(DrPosition {
                    lat_deg: f(&c["dr"]["lat_deg"]),
                    lon_deg: f(&c["dr"]["lon_deg"]),
                    sigma_nm: None,
                }),
                curvature,
                ..Default::default()
            };
            let r = noon_sight(&session, &provider(), &options).unwrap();
            zlat.push((r.latitude.lat_deg - f(&truth["lat_deg"])) * 60.0 / r.latitude.sigma_arcmin);
            let p = r.meridian_passage.as_ref().unwrap();
            zt.push((p.jd_utc - f(&truth["passage_jd_utc"])) * 86_400.0 / p.sigma_s);
            let lon = r.longitude.as_ref().unwrap();
            zlon.push(norm_180(lon.lon_deg - f(&truth["lon_deg"])) * 60.0 / lon.sigma_arcmin);
        }
        let label = format!("noon {curvature:?}");
        assert_honest(&format!("{label} latitude"), &coverage(&zlat));
        assert_honest(&format!("{label} passage time"), &coverage(&zt));
        assert_honest(&format!("{label} longitude"), &coverage(&zlon));
    }
}

/// Polaris latitudes from `reps` sights with altitude, DR and clock errors drawn from
/// their stated sigmas; returns the normalised errors.
fn polaris_z(doc: &Value, name: &str, sigma_nm: f64, reps: usize) -> Vec<f64> {
    let src = provider();
    let c = case(doc, "polaris", name);
    let lat = f(&c["true_lat_deg"]);
    let lon = f(&c["true_lon_deg"]);
    let jd_true = f(&c["jd_utc"]);
    let sigma_h = 1.0;
    let sigma_clock_s = 5.0;
    let mut rng = Normal::new(7_777);
    let mut z = Vec::new();
    for _ in 0..reps {
        // The watch is wrong by dt: the sight is recorded at jd_true + dt, and the
        // almanac is (correctly) looked up at that wrong time.
        let dt = sigma_clock_s * rng.next();
        let recorded = format_utc(jd_true + dt / 86_400.0);
        let ho = f(&c["ho_deg"]) + sigma_h * rng.next() / 60.0;
        let dn = sigma_nm * rng.next();
        let de = sigma_nm * rng.next();
        let mut session = nav_support::fixture_session(vec![Observation {
            id: "p".into(),
            body: "Polaris".into(),
            utc: recorded,
            altitude_deg: ho,
            altitude_kind: AltitudeKind::ObservedHo,
            sigma_arcmin: sigma_h,
            limb: Limb::Center,
            horizon: None,
            geocentric: None,
            notes: String::new(),
        }]);
        session.clock.uncertainty_s = sigma_clock_s;
        let options = PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: (lat + dn / 60.0).min(89.95),
                lon_deg: lon + de / 60.0 / lat.to_radians().cos(),
                sigma_nm: Some(sigma_nm),
            }),
            ..Default::default()
        };
        let r = polaris_latitude(&session, &src, None, &options).unwrap();
        z.push((r.latitude.lat_deg - lat) * 60.0 / r.latitude.sigma_arcmin);
    }
    z
}

#[test]
fn polaris_sigmas_cover_altitude_dr_longitude_and_clock_errors() {
    let doc = nav_fixture();
    for (name, sigma_nm) in [
        ("polaris-lat-55", 30.0),
        ("polaris-lat-75", 30.0),
        ("polaris-lat-88.5", 5.0),
    ] {
        let z = polaris_z(&doc, name, sigma_nm, 400);
        assert_honest(
            &format!("Polaris {name}, DR +/-{sigma_nm} NM"),
            &coverage(&z),
        );
    }
}

#[test]
fn near_the_pole_a_large_dr_error_makes_the_polaris_sigma_approximate() {
    // 30 NM at 88.5 N is 19 degrees of longitude: the latitude's error is bounded and
    // lopsided, not Gaussian, and no sigma evaluated at the (wrong) DR covers it
    // exactly. Measured and documented rather than hidden (NAVIGATION_METHODS.md 3.3);
    // the result carries Warning::PolarisNearPole whenever this can happen.
    let doc = nav_fixture();
    let c = coverage(&polaris_z(&doc, "polaris-lat-88.5", 30.0, 400));
    println!(
        "Polaris 88.5 N, DR +/-30 NM (19 deg of longitude): inside 95 % = {:.1} %, mean \
         (e/sigma)^2 = {:.3} -- the documented near-pole shortfall",
        100.0 * c.inside_95,
        c.mean_square
    );
    assert!(c.inside_95 > 0.86 && c.inside_95 < 0.95, "{}", c.inside_95);
    assert!(c.mean_square < 1.8, "{}", c.mean_square);
}

#[test]
fn averaging_sigmas_cover_the_truth_at_and_away_from_the_middle() {
    let doc = nav_fixture();
    let c = case(&doc, "averaging", "vega-run-philadelphia");
    let truth = &c["truth"];
    let sights = c["sights"].as_array().unwrap();
    let truth_point = Point::from_deg(f(&truth["lat_deg"]), f(&truth["lon_deg"]));
    let t_mid = parse_utc(&s(&truth["reference_utc"])).unwrap();
    let src = provider();
    let sigma = 1.0;
    let sigma_nm = 15.0;
    for minutes_off in [0.0, 3.0] {
        let t_ref = t_mid + minutes_off / 1440.0;
        let truth_h = if minutes_off == 0.0 {
            f(&truth["ho_at_reference_deg"])
        } else {
            let d = src.direction("Vega", t_ref).unwrap();
            hc_zn(truth_point, &d).0.to_degrees()
        };
        let mut rng = Normal::new(4242);
        let mut z = Vec::new();
        for _ in 0..400 {
            let obs: Vec<Observation> = sights
                .iter()
                .map(|x| observed_with_direction(x, "Vega", sigma, sigma * rng.next()))
                .collect();
            // A DR drawn from its own stated uncertainty, so the slope's sigma is
            // tested too when the reference is away from the middle.
            let dn = sigma_nm * rng.next();
            let de = sigma_nm * rng.next();
            let session = nav_support::fixture_session(obs);
            let options = AveragingOptions {
                reference_utc: Some(format_utc(t_ref)),
                dr: Some(DrPosition {
                    lat_deg: f(&truth["lat_deg"]) + dn / 60.0,
                    lon_deg: f(&truth["lon_deg"])
                        + de / 60.0 / f(&truth["lat_deg"]).to_radians().cos(),
                    sigma_nm: Some(sigma_nm),
                }),
                ..Default::default()
            };
            let a = average_sights(&session, &src, &options).unwrap();
            z.push((a.ho_deg - truth_h) * 60.0 / a.sigma_arcmin);
        }
        assert_honest(
            &format!("averaging, reference {minutes_off} min from the middle"),
            &coverage(&z),
        );
    }
}

#[test]
fn outliers_are_rare_on_clean_runs_and_found_when_they_are_real() {
    let doc = nav_fixture();
    let c = case(&doc, "averaging", "vega-run-philadelphia");
    let sights = c["sights"].as_array().unwrap();
    let src = provider();
    let options = AveragingOptions {
        dr: Some(DrPosition {
            lat_deg: f(&c["dr"]["lat_deg"]),
            lon_deg: f(&c["dr"]["lon_deg"]),
            sigma_nm: None,
        }),
        ..Default::default()
    };
    let reps = 500;
    let mut rng = Normal::new(99);
    let mut false_alarms = 0;
    let mut found = 0;
    let mut clean_otherwise = 0;
    let mut slope_z = Vec::new();
    for rep in 0..reps {
        let noise: Vec<f64> = sights.iter().map(|_| rng.next()).collect();
        let obs: Vec<Observation> = sights
            .iter()
            .zip(&noise)
            .map(|(x, e)| observed_with_direction(x, "Vega", 1.0, *e))
            .collect();
        let a = average_sights(&nav_support::fixture_session(obs.clone()), &src, &options).unwrap();
        if !a.outliers.is_empty() {
            false_alarms += 1;
        }
        slope_z.push(a.free_slope.as_ref().unwrap().z);
        // The same run with one 6-sigma blunder.
        let k = rep % obs.len();
        let mut bad = obs;
        bad[k].altitude_deg += 6.0 / 60.0 * if rep % 2 == 0 { 1.0 } else { -1.0 };
        let a = average_sights(&nav_support::fixture_session(bad), &src, &options).unwrap();
        let id = format!("a{k:02}");
        if a.outliers.contains(&id) {
            found += 1;
            if a.outliers.len() == 1 {
                clean_otherwise += 1;
            }
        }
    }
    let fa = false_alarms as f64 / reps as f64;
    let power = found as f64 / reps as f64;
    let clean = clean_otherwise as f64 / reps as f64;
    println!(
        "outliers: false alarms on clean 7-sight runs {:.1} % (about 2 % expected), \
         a 6-sigma blunder found {:.1} %, and alone {:.1} %",
        100.0 * fa,
        100.0 * power,
        100.0 * clean
    );
    assert!(fa < 0.05, "false alarm rate {fa}");
    assert!(power > 0.95, "detection {power}");
    assert!(clean > 0.9, "clean detection {clean}");
    // Under the null the free-slope statistic is standard normal.
    assert_honest("free-slope z on clean runs", &coverage(&slope_z));
}
