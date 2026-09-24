//! The navigation methods against independent truth: `fixtures/reference/nav_methods.json`
//! (tools/reference/gen_nav_methods.py; Skyfield + JPL DE421, UT1 = UTC).
//!
//! Every sight goes in as a raw sextant reading with no supplied direction, so the whole
//! chain runs: our ephemeris, the CONVENTIONS 5 corrections, the method. The truth was
//! computed without any of it. Noise-free, so the tolerances are the ephemeris'
//! (Sun 0.003', stars 0.001' against this reference, docs/ACCURACY.md) plus rounding.
//!
//! `cargo test -p skyfix-core --test nav_methods_reference -- --nocapture` prints the
//! numbers docs/NAVIGATION_METHODS.md quotes.

mod nav_support;

use nav_support::{EphemerisTable, f, nav_fixture, provider, s, sextant_observation};
use serde_json::Value;
use skyfix_core::methods::averaging::average_sights;
use skyfix_core::methods::noon::noon_sight;
use skyfix_core::methods::polaris::polaris_latitude;
use skyfix_core::time::parse_utc;
use skyfix_core::types::{
    AltitudeKind, AveragingOptions, DrPosition, GeocentricDirection, Limb, MeridianSide,
    NoonCurvature, NoonMethod, NoonSightOptions, Observation, PolarisOptions, VesselMotion,
    Warning,
};
use skyfix_core::units::norm_180;

fn vessel(case: &Value) -> Option<VesselMotion> {
    if case["vessel"].is_null() {
        None
    } else {
        Some(VesselMotion {
            course_deg: f(&case["vessel"]["course_deg"]),
            speed_kn: f(&case["vessel"]["speed_kn"]),
        })
    }
}

fn dr(case: &Value, sigma_nm: Option<f64>) -> DrPosition {
    DrPosition {
        lat_deg: f(&case["dr"]["lat_deg"]),
        lon_deg: f(&case["dr"]["lon_deg"]),
        sigma_nm,
    }
}

#[test]
fn noon_sights_recover_latitude_passage_and_longitude() {
    let doc = nav_fixture();
    println!(
        "{:<26} {:>10} {:>10} {:>10} {:>9} {:>9} {:>9}",
        "noon case", "dlat '", "dlon '", "dT s", "sigmaT s", "k '/min2", "peak s"
    );
    for case in doc["noon"].as_array().unwrap() {
        let name = s(&case["name"]);
        let body = s(&case["body"]);
        let truth = &case["truth"];
        let obs: Vec<Observation> = case["sights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sight| sextant_observation(sight, &body, 0.5))
            .collect();
        let session = nav_support::fixture_session(obs);
        for curvature in [NoonCurvature::Predicted, NoonCurvature::Fitted] {
            let options = NoonSightOptions {
                dr: Some(dr(case, Some(10.0))),
                vessel: vessel(case),
                curvature,
                ..Default::default()
            };
            let r = noon_sight(&session, &provider(), &options)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let expected_method = match curvature {
                NoonCurvature::Predicted => NoonMethod::CurveFit,
                NoonCurvature::Fitted => NoonMethod::CurveFitFreeCurvature,
            };
            assert_eq!(r.method, expected_method, "{name}");
            let dlat = (r.latitude.lat_deg - f(&truth["lat_deg"])) * 60.0;
            let lon = r.longitude.as_ref().unwrap();
            let dlon = norm_180(lon.lon_deg - f(&truth["lon_deg"])) * 60.0;
            let passage = r.meridian_passage.as_ref().unwrap();
            let dt = (passage.jd_utc - f(&truth["passage_jd_utc"])) * 86_400.0;
            let dh0 = (r.meridian_altitude_deg - f(&truth["meridian_altitude_deg"])) * 60.0;
            let ddec = (r.declination_deg - f(&truth["declination_deg"])) * 60.0;
            if curvature == NoonCurvature::Predicted {
                println!(
                    "{name:<26} {dlat:>10.4} {dlon:>10.4} {dt:>10.3} {:>9.1} {:>9.5} {:>9.1}",
                    passage.sigma_s,
                    r.curvature.predicted_arcmin_per_min2,
                    r.maximum.as_ref().unwrap().seconds_after_passage
                );
            }
            // The ephemeris' own error (Sun 0.003', stars 0.001') bounds these.
            assert!(
                dlat.abs() < 0.01,
                "{name} {curvature:?}: latitude off {dlat}'"
            );
            assert!(dh0.abs() < 0.01, "{name} {curvature:?}: H0 off {dh0}'");
            assert!(ddec.abs() < 0.01, "{name} {curvature:?}: dec off {ddec}'");
            assert!(
                dlon.abs() < 0.02,
                "{name} {curvature:?}: longitude off {dlon}'"
            );
            assert!(dt.abs() < 0.1, "{name} {curvature:?}: passage off {dt} s");
            // Zn 0/360 at passage: the body was north of the zenith; 180: south.
            let zn = f(&truth["azimuth_at_passage_deg"]).to_radians();
            let side_truth = if zn.cos() > 0.0 {
                MeridianSide::North
            } else {
                MeridianSide::South
            };
            assert_eq!(r.side, side_truth, "{name}");
            // Noise-free: the fitted curvature agrees with the prediction.
            assert_eq!(
                r.curvature.consistent,
                Some(true),
                "{name}: {:?}",
                r.curvature
            );
            assert!(
                r.warnings
                    .iter()
                    .any(|w| matches!(w, Warning::FlatPeakLongitude { .. })),
                "{name}: the longitude must carry its caveat"
            );
            let near_zenith = r
                .warnings
                .iter()
                .any(|w| matches!(w, Warning::MeridianNearZenith { .. }));
            assert_eq!(
                near_zenith,
                f(&truth["meridian_altitude_deg"]) > 85.0,
                "{name}: near-zenith warning"
            );
        }
    }
}

#[test]
fn a_vessel_running_away_from_the_sun_peaks_before_meridian_passage() {
    let doc = nav_fixture();
    let case = doc["noon"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "moving-north-15kn-sun")
        .unwrap();
    let obs: Vec<Observation> = case["sights"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sight| sextant_observation(sight, "Sun", 0.5))
        .collect();
    let session = nav_support::fixture_session(obs.clone());
    let options = NoonSightOptions {
        dr: Some(dr(case, None)),
        vessel: vessel(case),
        ..Default::default()
    };
    let r = noon_sight(&session, &provider(), &options).unwrap();
    let peak = r.maximum.as_ref().unwrap();
    // 15 kn on 010 is 14.8 kn north, away from a Sun that bears south: the meridian
    // altitude falls about 14.8'/h and the peak comes a/(2k) before passage.
    println!(
        "moving vessel: a = {:.4}'/min, k = {:.5}'/min2, peak {:.1} s after passage",
        r.curvature.rate_at_passage_arcmin_per_min,
        r.curvature.predicted_arcmin_per_min2,
        peak.seconds_after_passage
    );
    assert!(r.curvature.rate_at_passage_arcmin_per_min < -0.2);
    assert!(peak.seconds_after_passage < -60.0);

    // Ignoring the vessel's motion takes the peak for the passage: the longitude goes
    // wrong by the peak's 2 minutes of time, far beyond its sigma, while the latitude
    // (the height of the peak) moves only a fraction of an arcminute.
    let stationary = NoonSightOptions {
        dr: Some(dr(case, None)),
        ..Default::default()
    };
    let wrong = noon_sight(&session, &provider(), &stationary).unwrap();
    let dlat = (wrong.latitude.lat_deg - f(&case["truth"]["lat_deg"])) * 60.0;
    let lon = wrong.longitude.as_ref().unwrap();
    let dlon = norm_180(lon.lon_deg - f(&case["truth"]["lon_deg"])) * 60.0;
    println!(
        "  same sights solved as if stationary: latitude off {dlat:.2}' (sigma {:.2}'), \
         longitude off {dlon:.1}' (sigma {:.1}')",
        wrong.latitude.sigma_arcmin, lon.sigma_arcmin
    );
    assert!(dlon.abs() > 3.0 * lon.sigma_arcmin);
    assert!(dlon.abs() > 20.0);
    assert!(dlat.abs() < 0.5);
}

#[test]
fn polaris_latitudes_from_1_to_89_8_degrees_north() {
    let doc = nav_fixture();
    println!(
        "{:<18} {:>9} {:>10} {:>10} {:>10} {:>9}",
        "polaris case", "Zn deg", "dlat '", "dLHA_A '", "table-rig", "sens '/NM"
    );
    for case in doc["polaris"].as_array().unwrap() {
        let name = s(&case["name"]);
        let lat = f(&case["true_lat_deg"]);
        let lon = f(&case["true_lon_deg"]);
        let obs = Observation {
            id: "p".into(),
            body: "Polaris".into(),
            utc: s(&case["utc"]),
            altitude_deg: f(&case["ho_deg"]),
            altitude_kind: AltitudeKind::ObservedHo,
            sigma_arcmin: 0.5,
            limb: Limb::Center,
            horizon: None,
            geocentric: None,
            notes: String::new(),
        };
        let session = nav_support::fixture_session(vec![obs]);
        let options = PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: (lat - 0.1).min(89.9),
                lon_deg: lon,
                sigma_nm: Some(10.0),
            }),
            ..Default::default()
        };
        let r = polaris_latitude(&session, &provider(), Some(&EphemerisTable), &options)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let p = &r.polaris[0];
        let a = p.almanac.as_ref().unwrap();
        let dlat = (r.latitude.lat_deg - lat) * 60.0;
        let dlha = norm_180(a.lha_aries_deg - f(&case["lha_aries_deg"])) * 60.0;
        println!(
            "{name:<18} {:>9.3} {dlat:>10.5} {dlha:>10.5} {:>10.3} {:>9.4}",
            p.azimuth_deg, a.difference_arcmin, p.longitude_sensitivity_arcmin_per_nm
        );
        assert!(dlat.abs() < 0.01, "{name}: latitude off {dlat}'");
        assert!(dlha.abs() < 0.01, "{name}: LHA Aries off {dlha}'");
        let zn = norm_180(p.azimuth_deg - f(&case["azimuth_deg"])).abs() * 60.0;
        assert!(zn < 0.5, "{name}: azimuth off {zn}'");
        let near_pole = r
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::PolarisNearPole { .. }));
        assert_eq!(near_pole, lat > 88.0, "{name}: near-pole warning");
        assert_eq!(a.within_printed_table, lat <= 68.0, "{name}");
        if a.within_printed_table {
            // Inside the printed table's range the Almanac formula is good to a few
            // hundredths of an arcminute; the rigorous answer is what is reported.
            assert!(a.difference_arcmin.abs() < 0.1, "{name}: {a:?}");
        }
    }
}

#[test]
fn averaged_runs_match_the_true_altitude_and_rate() {
    let doc = nav_fixture();
    println!(
        "{:<24} {:>9} {:>9} {:>12} {:>12} {:>8}",
        "averaging case", "dHo '", "sigma '", "slope '/min", "truth '/min", "free z"
    );
    for case in doc["averaging"].as_array().unwrap() {
        let name = s(&case["name"]);
        let body = s(&case["body"]);
        let truth = &case["truth"];
        let obs: Vec<Observation> = case["sights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sight| sextant_observation(sight, &body, 0.5))
            .collect();
        let n = obs.len() as f64;
        let session = nav_support::fixture_session(obs);
        let options = AveragingOptions {
            dr: Some(dr(case, Some(10.0))),
            vessel: vessel(case),
            ..Default::default()
        };
        let a = average_sights(&session, &provider(), &options)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let t_ref = parse_utc(&s(&truth["reference_utc"])).unwrap();
        assert!(
            (a.jd_utc - t_ref).abs() * 86_400.0 < 0.01,
            "{name}: reference instant"
        );
        let dho = (a.ho_deg - f(&truth["ho_at_reference_deg"])) * 60.0;
        let slope_truth = f(&truth["rate_at_dr_arcmin_per_min"]);
        let free = a.free_slope.as_ref().unwrap();
        println!(
            "{name:<24} {dho:>9.4} {:>9.4} {:>12.4} {slope_truth:>12.4} {:>8.2}",
            a.sigma_arcmin, a.predicted_slope_arcmin_per_min, free.z
        );
        assert!(dho.abs() < 0.01, "{name}: averaged Ho off {dho}'");
        assert!(
            (a.predicted_slope_arcmin_per_min - slope_truth).abs() < 0.002,
            "{name}: slope {} vs {slope_truth}",
            a.predicted_slope_arcmin_per_min
        );
        assert!(
            (a.sigma_arcmin - 0.5 / n.sqrt()).abs() < 1e-9,
            "{name}: sigma/sqrt(N)"
        );
        assert!(a.outliers.is_empty(), "{name}: {:?}", a.outliers);
        assert!(free.consistent, "{name}: {free:?}");
        // The averaged observation is ready for a fix: fully corrected, never again.
        assert_eq!(a.observation.altitude_kind, AltitudeKind::ObservedHo);
        assert!(a.observation.geocentric.is_none());
    }
}

#[test]
fn a_supplied_run_and_a_provider_run_agree() {
    // The same Vega run, once with the fixture's own (Skyfield) directions supplied
    // and fully corrected altitudes, once as raw readings through our ephemeris.
    let doc = nav_fixture();
    let case = doc["averaging"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "vega-run-philadelphia")
        .unwrap();
    let sights = case["sights"].as_array().unwrap();
    let supplied: Vec<Observation> = sights
        .iter()
        .map(|x| nav_support::observed_with_direction(x, "Vega", 0.5, 0.0))
        .collect();
    let raw: Vec<Observation> = sights
        .iter()
        .map(|x| sextant_observation(x, "Vega", 0.5))
        .collect();
    let options = AveragingOptions {
        dr: Some(dr(case, None)),
        ..Default::default()
    };
    let a = average_sights(
        &nav_support::fixture_session(supplied),
        &provider(),
        &options,
    )
    .unwrap();
    let b = average_sights(&nav_support::fixture_session(raw), &provider(), &options).unwrap();
    assert!((a.ho_deg - b.ho_deg).abs() * 60.0 < 0.005);
    // A supplied run hands its direction on to the averaged observation.
    let g: GeocentricDirection = a.observation.geocentric.unwrap();
    assert!((g.dec_deg - f(&sights[3]["dec_deg"])).abs() * 60.0 < 0.01);
}
