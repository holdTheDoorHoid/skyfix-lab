//! Index-error and watch logs in the session (CONVENTIONS section 10): the value at a
//! sight's time is interpolated from the log instead of the single correction, the
//! reduction says which value it used, and older files are unchanged.

use skyfix_core::reduce::{SuppliedOnly, reduce_observation};
use skyfix_core::session::{from_csv, parse_session, to_csv};
use skyfix_core::time::parse_utc;
use skyfix_core::types::{
    AltitudeKind, CorrectionKind, LogMethod, Observation, ReducedSight, Session, Warning,
};

const BASE: &str = r#"{
  "schema": "skyfix.session/1",
  "observer": {"height_of_eye_m": 2.0},
  "instrument": {"index_correction_arcmin": 0.0, "horizon": "sea"},
  "clock": {"uncertainty_s": 1.0, "correction_s": 0.0},
  "observations": [
    {"id": "a", "body": "Vega", "utc": "2026-09-04T00:00:00Z", "altitude_deg": 45.0,
     "altitude_kind": "sextant_hs", "geocentric": {"gha_deg": 100.0, "dec_deg": 38.8}},
    {"id": "b", "body": "Vega", "utc": "2026-09-12T12:00:00Z", "altitude_deg": 45.0,
     "altitude_kind": "sextant_hs", "geocentric": {"gha_deg": 100.0, "dec_deg": 38.8}}
  ]
}"#;

fn with_logs() -> Session {
    let mut v: serde_json::Value = serde_json::from_str(BASE).unwrap();
    v["instrument"]["index_error_log"] = serde_json::json!([
        {"utc": "2026-09-10T00:00:00Z", "ic_arcmin": -1.5, "note": "after the gale"},
        {"utc": "2026-09-01T00:00:00Z", "ic_arcmin": -1.2}
    ]);
    v["clock"]["watch_log"] = serde_json::json!([
        {"utc": "2026-09-01T00:00:00Z", "correction_s": 3.0, "note": "WWV"},
        {"utc": "2026-09-11T00:00:00Z", "correction_s": -2.0}
    ]);
    parse_session(&v.to_string()).unwrap().0
}

fn reduce(s: &Session, id: &str) -> ReducedSight {
    let obs = s.observations.iter().find(|o| o.id == id).unwrap();
    reduce_observation(s, obs, &SuppliedOnly).unwrap()
}

#[test]
fn the_logs_are_interpolated_at_the_sights_time_and_reported() {
    let s = with_logs();
    let r = reduce(&s, "a");
    // Index error: 3 days into the 9-day span from -1.2' to -1.5'.
    let ic = r.index_correction_from_log.as_ref().unwrap();
    assert_eq!(ic.method, LogMethod::Interpolated);
    // Read at the corrected time: the recorded time plus the 1.5 s watch correction.
    let expected_ic = -1.2 + (-1.5 + 1.2) * (3.0 + 1.5 / 86_400.0) / 9.0;
    assert!((ic.value - expected_ic).abs() < 1e-9, "{}", ic.value);
    let step = &r.corrections.steps[0];
    assert_eq!(step.kind, CorrectionKind::IndexCorrection);
    assert!((step.delta_arcmin - ic.value).abs() < 1e-9);
    assert!(
        step.note.contains("interpolated from the index-error log"),
        "{}",
        step.note
    );
    // Watch: 3 days into the 10-day span from +3 s to -2 s, at the recorded time.
    let w = r.clock_correction_from_log.as_ref().unwrap();
    assert!((w.value - 1.5).abs() < 1e-9, "{}", w.value);
    let recorded = parse_utc("2026-09-04T00:00:00Z").unwrap();
    assert!(((r.jd_utc - recorded) * 86_400.0 - 1.5).abs() < 1e-4);
    assert!(
        r.warnings
            .iter()
            .all(|w| !matches!(w, Warning::ErrorLogOutsideSpan { .. }))
    );

    // The same sight with the single values set to those numbers reduces identically.
    let mut single = s.clone();
    single.instrument.index_error_log.clear();
    single.clock.watch_log.clear();
    single.instrument.index_correction_arcmin = ic.value;
    single.clock.correction_s = w.value;
    let plain = reduce(&single, "a");
    assert_eq!(plain.ho_deg, r.ho_deg);
    assert_eq!(plain.jd_utc, r.jd_utc);
    assert!(plain.index_correction_from_log.is_none());
}

#[test]
fn a_sight_outside_a_log_holds_its_nearest_entry_and_says_so() {
    let s = with_logs();
    let r = reduce(&s, "b");
    let ic = r.index_correction_from_log.as_ref().unwrap();
    assert_eq!(ic.method, LogMethod::HeldAfterLast);
    assert_eq!(ic.value, -1.5);
    let outside: Vec<&Warning> = r
        .warnings
        .iter()
        .filter(|w| matches!(w, Warning::ErrorLogOutsideSpan { .. }))
        .collect();
    assert_eq!(outside.len(), 2, "{outside:?}");
    assert!(outside.iter().any(|w| matches!(
        w,
        Warning::ErrorLogOutsideSpan { log, held_value, hours_outside, .. }
            if log == "watch_log" && *held_value == -2.0 && (*hours_outside - 36.0).abs() < 0.01
    )));
}

#[test]
fn older_files_and_their_reductions_are_unchanged() {
    let (s, warnings) = parse_session(BASE).unwrap();
    assert!(warnings.is_empty());
    let json = serde_json::to_string(&s).unwrap();
    assert!(
        !json.contains("index_error_log") && !json.contains("watch_log"),
        "{json}"
    );
    let r = reduce(&s, "a");
    let json = serde_json::to_string(&r).unwrap();
    assert!(!json.contains("from_log"), "{json}");
}

#[test]
fn logs_round_trip_through_json_and_csv() {
    let s = with_logs();
    let back: Session = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(back, s);
    let csv = to_csv(&s);
    assert!(csv.contains("# instrument.index_error_log=["), "{csv}");
    assert!(csv.contains("# clock.watch_log=["), "{csv}");
    assert_eq!(from_csv(&csv).unwrap(), s);
}

#[test]
fn validation_names_a_bad_entry_and_notes_a_value_the_log_replaces() {
    let mut v: serde_json::Value = serde_json::from_str(BASE).unwrap();
    v["instrument"]["index_error_log"] =
        serde_json::json!([{"utc": "2026-09-01 00:00", "ic_arcmin": 0.3}]);
    let e = parse_session(&v.to_string()).unwrap_err();
    assert!(
        e.to_string().contains("instrument.index_error_log[0].utc"),
        "{e}"
    );
    let mut v: serde_json::Value = serde_json::from_str(BASE).unwrap();
    v["instrument"]["index_correction_arcmin"] = serde_json::json!(-2.0);
    v["instrument"]["index_error_log"] =
        serde_json::json!([{"utc": "2026-09-01T00:00:00Z", "ic_arcmin": 0.3}]);
    let (_, warnings) = parse_session(&v.to_string()).unwrap();
    assert!(warnings.iter().any(|w| matches!(
        w,
        Warning::Other { message } if message.contains("index_correction_arcmin (-2.000') is not used")
    )));
}

#[test]
fn a_predicted_reading_uses_the_logged_index_correction() {
    use skyfix_core::sights::predict::predict_sextant;
    use skyfix_core::types::{GeocentricDirection, Limb, SightObserver};
    let s = with_logs();
    let observer = SightObserver {
        lat_deg: 40.0,
        lon_deg: -70.0,
        height_of_eye_m: 2.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
    };
    let direction = GeocentricDirection {
        gha_deg: 100.0,
        dec_deg: 38.8,
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: 0.0,
    };
    let jd = parse_utc("2026-09-04T00:00:00Z").unwrap();
    let p = predict_sextant(
        &observer,
        &s.instrument,
        "Vega",
        Limb::Center,
        jd,
        direction,
        "test",
    )
    .unwrap();
    // Reduce the predicted reading in the session at that instant: it lands on Hc.
    let mut session = s.clone();
    session.clock.watch_log.clear();
    session.observer.assumed_position = None;
    session.observations = vec![Observation {
        id: "p".to_string(),
        body: "Vega".to_string(),
        utc: skyfix_core::time::format_utc(jd),
        altitude_deg: p.hs_deg,
        altitude_kind: AltitudeKind::SextantHs,
        sigma_arcmin: 1.0,
        limb: Limb::Center,
        horizon: None,
        geocentric: Some(direction),
        notes: String::new(),
    }];
    let r = reduce(&session, "p");
    assert!(
        (r.ho_deg - p.hc_deg).abs() < 1e-9,
        "{} vs {}",
        r.ho_deg,
        p.hc_deg
    );
    assert!(r.index_correction_from_log.is_some());
}

#[test]
fn an_averaged_sight_is_written_on_the_logged_watch() {
    use skyfix_core::methods::averaging::average_sights;
    use skyfix_core::types::AveragingOptions;
    let mut s = with_logs();
    // Five sights a minute apart of a body rising 10' a minute (supplied directions).
    s.observer.assumed_position = Some(skyfix_core::types::LatLon {
        lat_deg: 40.0,
        lon_deg: -70.0,
    });
    s.observations = (0..5)
        .map(|k| Observation {
            id: format!("r{k}"),
            body: "Vega".to_string(),
            utc: format!("2026-09-04T00:0{k}:00Z"),
            altitude_deg: 45.0 + k as f64 / 6.0,
            altitude_kind: AltitudeKind::ObservedHo,
            sigma_arcmin: 0.5,
            limb: skyfix_core::types::Limb::Center,
            horizon: None,
            geocentric: Some(skyfix_core::types::GeocentricDirection {
                gha_deg: 60.0 + k as f64 * 0.25,
                dec_deg: 38.8,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            }),
            notes: String::new(),
        })
        .collect();
    let avg = average_sights(&s, &SuppliedOnly, &AveragingOptions::default()).unwrap();
    // Reduced in the same session, the averaged observation lands on its instant.
    let mut again = s.clone();
    again.observations = vec![avg.observation.clone()];
    let r = reduce(&again, &avg.observation.id);
    assert!(
        (r.jd_utc - avg.jd_utc).abs() * 86_400.0 < 1e-3,
        "{} vs {}",
        r.utc,
        avg.utc
    );
}
