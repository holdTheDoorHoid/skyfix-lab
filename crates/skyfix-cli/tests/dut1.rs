//! `--dut1` and a session's `clock.dut1_s` (expansion programme, moonshape): UT1 - UTC
//! from the time signal, on every command that reduces, predicts or plans.
//!
//! DUT1 turns the Earth under the sky: every Greenwich hour angle moves by DUT1 times
//! the Earth's rotation rate, 15.041" of arc per second of time, whatever the body
//! (the Sun's, the Moon's and the planets' own motion does not enter, since only the
//! Earth's orientation changes). The flag wins over the file; without either the
//! engine's own value is used (0 s until the timescales work adds the IERS history).

mod support;

use serde_json::Value;
use support::{data_file, skyfix, tmp_dir};

/// Arcseconds of GHA per second of DUT1: the Earth's rotation rate.
const EARTH_RATE_ARCSEC_PER_S: f64 = 15.041_068_64;

fn fixture(name: &str) -> String {
    data_file(name).to_string_lossy().into_owned()
}

fn json(run: &support::Run) -> Value {
    serde_json::from_str(&run.stdout).unwrap_or_else(|e| panic!("{e}: {}", run.stdout))
}

/// GHA shift in arcseconds between two JSON values at `pointer`.
fn gha_shift_arcsec(a: &Value, b: &Value, pointer: &str) -> f64 {
    let (x, y) = (
        a.pointer(pointer).and_then(Value::as_f64).unwrap(),
        b.pointer(pointer).and_then(Value::as_f64).unwrap(),
    );
    ((y - x + 540.0).rem_euclid(360.0) - 180.0) * 3600.0
}

#[test]
fn every_command_that_reduces_predicts_or_plans_takes_dut1() {
    let runs: Vec<Vec<String>> = vec![
        vec!["reduce".into(), fixture("average_vega.session.json")],
        vec![
            "solve".into(),
            fixture("running_fix_north.session.json"),
            "--no-init".into(),
        ],
        vec![
            "noon".into(),
            fixture("noon_equinox_sun.session.json"),
            "--dr".into(),
            "39.8,-75.3,10".into(),
        ],
        vec![
            "polaris".into(),
            fixture("polaris_bowditch_1912.session.json"),
        ],
        vec![
            "average".into(),
            fixture("average_vega.session.json"),
            "--dr".into(),
            "40.1,-75.0".into(),
        ],
        vec![
            "running-fix".into(),
            fixture("running_fix_north.session.json"),
            "--leg".into(),
            "0,12".into(),
        ],
        vec![
            "predict".into(),
            "--lat".into(),
            "39.9526".into(),
            "--lon".into(),
            "-75.1652".into(),
            "--utc".into(),
            "2026-10-01T03:00:00Z".into(),
            "--body".into(),
            "Moon".into(),
            "--limb".into(),
            "lower".into(),
        ],
        vec!["lunar".into(), fixture("lunar_19.input.json")],
        vec![
            "plan-sights".into(),
            "--lat".into(),
            "39.9526".into(),
            "--lon".into(),
            "-75.1652".into(),
            "--from".into(),
            "2026-09-24T16:00:00Z".into(),
            "--to".into(),
            "2026-09-25T16:00:00Z".into(),
        ],
        vec![
            "plan".into(),
            "--position".into(),
            "39.9526,-75.1652".into(),
            "--utc".into(),
            "2026-10-01T01:30:00Z".into(),
        ],
    ];
    for args in runs {
        let mut with = args.clone();
        with.extend(["--dut1".to_string(), "-0.3".to_string()]);
        let run = skyfix(&with);
        assert_eq!(run.code, 0, "{with:?} exited {}: {}", run.code, run.stderr);
        // Nonsense is refused before anything runs.
        let mut bad = args.clone();
        bad.extend(["--dut1".to_string(), "300".to_string()]);
        skyfix(&bad).expect_code(1).expect_stderr("--dut1");
    }
}

#[test]
fn dut1_moves_every_hour_angle_by_the_earths_rotation() {
    let base = [
        "predict",
        "--lat",
        "39.9526",
        "--lon",
        "-75.1652",
        "--utc",
        "2026-10-01T03:00:00Z",
        "--format",
        "json",
    ];
    for body in ["Vega", "Moon", "Saturn"] {
        let args = |extra: &[&str]| {
            let mut a: Vec<&str> = base.to_vec();
            a.extend(["--body", body]);
            a.extend_from_slice(extra);
            json(&skyfix(a).expect_code(0))
        };
        let zero = args(&["--dut1", "0"]);
        let plus = args(&["--dut1", "0.5"]);
        let shift = gha_shift_arcsec(&zero, &plus, "/gha_deg");
        println!("{body}: --dut1 0.5 moves GHA by {shift:.4}\"");
        assert!(
            (shift - 0.5 * EARTH_RATE_ARCSEC_PER_S).abs() < 0.01,
            "{body}: {shift}\""
        );
        // The declination does not move.
        assert_eq!(zero["dec_deg"], plus["dec_deg"]);
        // Without the flag the engine's own value applies (the IERS history, CONVENTIONS
        // 15.2): the same output as naming that value.
        let automatic = skyfix_core::time::dut1_s(
            skyfix_core::time::parse_utc("2026-10-01T03:00:00Z").unwrap(),
            None,
        );
        let none = args(&[]);
        let named = args(&["--dut1", &format!("{automatic}")]);
        let drift = gha_shift_arcsec(&none, &named, "/gha_deg");
        assert!(
            drift.abs() < 1e-6,
            "{body}: automatic {automatic} s vs named: {drift}\""
        );
    }
}

#[test]
fn the_flag_wins_over_the_session_and_the_session_over_the_default() {
    // A provider-derived session (no supplied directions): its GHAs follow its DUT1.
    let text = std::fs::read_to_string(data_file("average_vega.session.json")).unwrap();
    let mut doc: Value = serde_json::from_str(&text).unwrap();
    doc["clock"]["dut1_s"] = Value::from(0.4);
    let with_file = tmp_dir().join("dut1_average_vega.session.json");
    std::fs::write(&with_file, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    let with_file = with_file.to_string_lossy().into_owned();

    let reduce = |file: &str, extra: &[&str]| {
        let mut a = vec!["reduce", file, "--json"];
        a.extend_from_slice(extra);
        json(&skyfix(a).expect_code(0))
    };
    // The baseline names DUT1 = 0: without a flag or a file value the engine's own
    // history applies, which is what the last assertion checks.
    let plain = reduce(&fixture("average_vega.session.json"), &["--dut1", "0"]);
    let from_file = reduce(&with_file, &[]);
    let from_flag = reduce(&fixture("average_vega.session.json"), &["--dut1", "0.4"]);
    let flag_over_file = reduce(&with_file, &["--dut1", "-0.2"]);
    let file_shift = gha_shift_arcsec(&plain, &from_file, "/0/gha_deg");
    let flag_shift = gha_shift_arcsec(&plain, &from_flag, "/0/gha_deg");
    let over_shift = gha_shift_arcsec(&plain, &flag_over_file, "/0/gha_deg");
    println!("file {file_shift:.4}\", flag {flag_shift:.4}\", flag over file {over_shift:.4}\"");
    assert!((file_shift - 0.4 * EARTH_RATE_ARCSEC_PER_S).abs() < 0.01);
    assert!((flag_shift - file_shift).abs() < 1e-6);
    assert!((over_shift + 0.2 * EARTH_RATE_ARCSEC_PER_S).abs() < 0.01);

    // A session that says more than the IERS allows is used, with a warning.
    doc["clock"]["dut1_s"] = Value::from(1.5);
    let loud = tmp_dir().join("dut1_loud.session.json");
    std::fs::write(&loud, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    skyfix(["validate", &loud.to_string_lossy()])
        .expect_code(0)
        .expect_stdout("0.9 s");
}

#[test]
fn a_lunar_documents_observer_may_carry_dut1_and_the_flag_wins() {
    let text = std::fs::read_to_string(data_file("lunar_19.input.json")).unwrap();
    let mut doc: Value = serde_json::from_str(&text).unwrap();
    let run = |doc: &Value, extra: &[&str]| {
        let path = tmp_dir().join("dut1_lunar.input.json");
        std::fs::write(&path, serde_json::to_string(doc).unwrap()).unwrap();
        let mut a = vec![
            "lunar".to_string(),
            path.to_string_lossy().into_owned(),
            "--format".to_string(),
            "json".to_string(),
        ];
        a.extend(extra.iter().map(|s| s.to_string()));
        json(&skyfix(a).expect_code(0))
    };
    let plain = run(&doc, &[]);
    doc["observer"]["dut1_s"] = Value::from(0.8);
    let from_doc = run(&doc, &[]);
    let from_flag = run(&doc, &["--dut1", "0"]);
    let az = |v: &Value| v["altitudes"]["moon_azimuth_deg"].as_f64().unwrap();
    // The document's DUT1 turns the Earth under the DR, so the computed azimuths move;
    // the flag puts it back.
    assert!((az(&plain) - az(&from_doc)).abs() > 1e-5);
    assert_eq!(az(&plain), az(&from_flag));
}
