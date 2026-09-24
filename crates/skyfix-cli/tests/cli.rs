//! End-to-end tests of the `skyfix` binary. OWNER: cli agent.
//!
//! Everything here runs the real executable through `std::process::Command`, so what is
//! being tested is the thing a user runs: argument parsing, the text on stdout, the
//! diagnostics on stderr, and the exit code, which scripts depend on.
//!
//! The fixtures under `tests/data/` are truth-consistent by construction (see
//! `tests/support/mod.rs` and `tests/fixtures.rs`), which is what lets these tests make
//! the brief's claim: "clean, well-conditioned synthetic geometry should recover its
//! truth within 10 metres".

mod support;

use serde_json::Value;
use skyfix_core::types::{LatLon, Truth};
use support::{PHL, data_file, distance_m, skyfix};

/// The brief's numerical regression target. Not a field-accuracy claim.
const RECOVERY_TOLERANCE_M: f64 = 10.0;

fn truth_position() -> LatLon {
    let text = std::fs::read_to_string(data_file("phl.truth.json")).expect("the truth fixture");
    let truth: Truth = serde_json::from_str(&text).expect("truth is a skyfix.truth/1 document");
    truth.position
}

fn fixture(name: &str) -> String {
    data_file(name).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

#[test]
fn validate_accepts_a_good_session() {
    skyfix(["validate", &fixture("phl_four_star.session.json")])
        .expect_code(0)
        .expect_stdout("is a valid skyfix.session/1 session: 4 observation(s)")
        .expect_stdout("No warnings.");
}

#[test]
fn validate_reports_warnings_as_sentences_without_failing() {
    skyfix(["validate", &fixture("every_field.session.json")])
        .expect_code(0)
        .expect_stdout("Warnings")
        .expect_stdout("is recorded as observed_ho")
        .expect_stdout_flat("rather than applied a second time");
}

#[test]
fn validate_rejects_a_bad_session_with_a_readable_reason() {
    let path = support::write_tmp(
        "bad_sigma.session.json",
        r#"{"schema":"skyfix.session/1","observations":[
             {"id":"obs-1","body":"Vega","utc":"2026-10-01T01:30:00Z","altitude_deg":61.2,
              "altitude_kind":"observed_ho","sigma_arcmin":0.0,
              "geocentric":{"gha_deg":123.4,"dec_deg":38.8}}]}"#,
    );
    skyfix(["validate", path.to_str().unwrap()])
        .expect_code(1)
        .expect_stdout("is not a valid session")
        .expect_stdout("sigma_arcmin")
        .expect_stdout("infinite weight");
}

#[test]
fn validate_rejects_an_unknown_body_and_says_what_to_do() {
    let path = support::write_tmp(
        "unknown_body.session.json",
        r#"{"schema":"skyfix.session/1","observations":[
             {"id":"obs-1","body":"Krypton","utc":"2026-10-01T01:30:00Z","altitude_deg":61.2,
              "altitude_kind":"observed_ho"}]}"#,
    );
    skyfix(["validate", path.to_str().unwrap()])
        .expect_code(1)
        .expect_stdout("skyfix catalog")
        .expect_stdout("geocentric");
}

#[test]
fn validate_json_is_the_documented_shape() {
    let run = skyfix(["validate", &fixture("every_field.session.json"), "--json"]).expect_code(0);
    let v = run.json();
    assert_eq!(v["ok"], Value::Bool(true));
    assert_eq!(v["errors"].as_array().expect("errors is an array").len(), 0);
    assert!(
        !v["warnings"]
            .as_array()
            .expect("warnings is an array")
            .is_empty(),
        "{v}"
    );

    let path = support::write_tmp("not_a_session.json", r#"{"schema":"nope/1"}"#);
    let run = skyfix(["validate", path.to_str().unwrap(), "--json"]).expect_code(1);
    let v = run.json();
    assert_eq!(v["ok"], Value::Bool(false));
    assert_eq!(v["errors"].as_array().expect("errors").len(), 1);
    assert!(
        v["errors"][0]
            .as_str()
            .expect("a message")
            .contains("schema")
    );
}

#[test]
fn validate_reads_csv_as_readily_as_json() {
    let csv = support::tmp_dir().join("valid_round.csv");
    skyfix([
        "convert",
        &fixture("phl_four_star.session.json"),
        csv.to_str().unwrap(),
    ])
    .expect_code(0);
    skyfix(["validate", csv.to_str().unwrap()])
        .expect_code(0)
        .expect_stdout("read as csv");
}

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

#[test]
fn reduce_prints_every_correction_step_with_its_sign() {
    let run = skyfix(["reduce", &fixture("phl_sextant.session.json")]).expect_code(0);
    for kind in [
        "index_correction",
        "dip",
        "artificial_horizon_halving",
        "refraction",
        "semidiameter",
        "parallax",
    ] {
        assert!(
            run.stdout.contains(kind),
            "{kind} is missing from the table"
        );
    }
    // The table's own columns, and the identity of the sight above them.
    assert!(run.stdout.contains("before deg"), "{}", run.stdout);
    assert!(run.stdout.contains("delta '"), "{}", run.stdout);
    assert!(
        run.stdout
            .contains("obs-1  Schedar  2026-10-01T01:30:00Z  direction: supplied"),
        "{}",
        run.stdout
    );
    // Index error 2.0' on the arc is a -2.0' correction (CONVENTIONS section 5).
    assert!(run.stdout.contains("-2.00"), "{}", run.stdout);
    // Ho, sigma, and the reduction against the assumed position.
    assert!(
        run.stdout.contains("Ho 51.978993 deg   sigma 1.00'"),
        "{}",
        run.stdout
    );
    assert!(run.stdout.contains("intercept"), "{}", run.stdout);
    assert!(
        run.stdout.contains("NM A (away)") || run.stdout.contains("NM T (toward)"),
        "an intercept needs its toward/away letter:\n{}",
        run.stdout
    );
}

#[test]
fn reduce_at_the_truth_position_gives_zero_intercepts() {
    // The fixture's own assumed position is 45 NM away, so a zero intercept here would
    // be a bug. Pointing it at the truth is the check that the fixture means what it says.
    let text = std::fs::read_to_string(data_file("phl_four_star.session.json")).expect("fixture");
    let mut session: skyfix_core::types::Session =
        serde_json::from_str(&text).expect("valid session");
    session.observer.assumed_position = Some(PHL);
    let path = support::write_tmp(
        "at_truth.session.json",
        &serde_json::to_string(&session).expect("serialises"),
    );

    let run = skyfix(["reduce", path.to_str().unwrap(), "--csv"]).expect_code(0);
    let mut rows = 0;
    for line in run.stdout.lines().skip(1) {
        let intercept: f64 = line
            .rsplit(',')
            .next()
            .expect("a last column")
            .parse()
            .expect("the intercept column is numeric");
        assert!(intercept.abs() < 1e-3, "{line}");
        rows += 1;
    }
    assert_eq!(rows, 4);
}

#[test]
fn reduce_csv_has_one_row_per_sight_and_the_numeric_columns() {
    let run = skyfix(["reduce", &fixture("phl_four_star.session.json"), "--csv"]).expect_code(0);
    let lines: Vec<&str> = run.stdout.trim_end().lines().collect();
    assert_eq!(lines.len(), 5, "header plus four sights:\n{}", run.stdout);
    assert_eq!(
        lines[0],
        "id,body,utc,direction_source,gha_deg,dec_deg,ho_deg,sigma_arcmin,hc_deg,zn_deg,\
         intercept_nm"
    );
    for line in &lines[1..] {
        assert_eq!(line.split(',').count(), 11, "{line}");
    }
}

#[test]
fn reduce_json_is_the_reduced_sight_shape() {
    let run = skyfix(["reduce", &fixture("phl_four_star.session.json"), "--json"]).expect_code(0);
    let v = run.json();
    let sights = v.as_array().expect("an array of reduced sights");
    assert_eq!(sights.len(), 4);
    let first = &sights[0];
    assert_eq!(first["id"], "obs-1");
    assert_eq!(first["body"], "Schedar");
    assert_eq!(first["direction_source"], "supplied");
    assert_eq!(
        first["corrections"]["steps"]
            .as_array()
            .expect("six steps")
            .len(),
        6
    );
    assert!(first["hc_deg"].is_number(), "{first}");
    assert!(first["zn_deg"].is_number(), "{first}");
    assert!(first["intercept_nm"].is_number(), "{first}");
}

#[test]
fn reduce_reports_a_rejected_sight_and_still_prints_the_rest() {
    // `--ephemeris supplied` refuses anything without its own direction; the star here
    // has one and the Sun does not, so exactly one sight is lost.
    let path = support::write_tmp(
        "half_supplied.session.json",
        r#"{"schema":"skyfix.session/1","observations":[
             {"id":"obs-1","body":"Vega","utc":"2026-10-01T01:30:00Z","altitude_deg":61.2,
              "altitude_kind":"observed_ho",
              "geocentric":{"gha_deg":123.4,"dec_deg":38.8}},
             {"id":"obs-2","body":"Sun","utc":"2026-10-01T15:00:00Z","altitude_deg":40.0,
              "altitude_kind":"observed_ho"}]}"#,
    );
    let run = skyfix(["reduce", path.to_str().unwrap(), "--ephemeris", "supplied"])
        .expect_code(2)
        .expect_stdout("obs-1")
        .expect_stdout("obs-2  Sun  REJECTED")
        .expect_stderr("1 of 2 sight(s) were rejected");
    assert!(run.stdout.contains("Ho 61.200000"), "{}", run.stdout);
}

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

#[test]
fn a_four_star_fix_recovers_the_truth_within_ten_metres() {
    let run = skyfix(["solve", &fixture("phl_four_star.session.json")]).expect_code(0);
    assert!(
        run.stdout.contains("\nUNIQUE FIX\n"),
        "the result kind must lead the report:\n{}",
        run.stdout
    );
    let fix = solved_position(&fixture("phl_four_star.session.json"), &[]);
    let d = distance_m(fix, truth_position());
    assert!(
        d < RECOVERY_TOLERANCE_M,
        "fix {fix:?} is {d:.3} m from the truth, over the {RECOVERY_TOLERANCE_M} m target"
    );

    // Both spellings of the position, the uncertainty in both units, the ellipse with
    // its model string verbatim, the residual table and the conditioning line.
    assert!(
        run.stdout.contains("39.952600, -75.165200"),
        "{}",
        run.stdout
    );
    assert!(
        run.stdout.contains("39 57.16' N, 075 09.91' W"),
        "{}",
        run.stdout
    );
    assert!(run.stdout.contains("sigma north"), "{}", run.stdout);
    assert!(run.stdout.contains("NM)"), "{}", run.stdout);
    assert!(
        run.stdout
            .contains("model: nominal 95 %, independent-noise model"),
        "the ellipse's model string must appear verbatim:\n{}",
        run.stdout
    );
    assert!(run.stdout.contains("Residuals"), "{}", run.stdout);
    assert!(run.stdout.contains("intercept NM"), "{}", run.stdout);
    assert!(run.stdout.contains("condition number"), "{}", run.stdout);
    assert!(run.stdout.contains("max azimuth gap"), "{}", run.stdout);
    assert!(run.stdout.contains("dilution"), "{}", run.stdout);
    assert!(
        support::flatten(&run.stdout).contains("Each arcminute of altitude error moves this fix"),
        "the conditioning needs its plain sentence:\n{}",
        run.stdout
    );
}

#[test]
fn raw_sextant_readings_reach_the_same_fix_as_corrected_altitudes() {
    let from_hs = solved_position(&fixture("phl_sextant.session.json"), &[]);
    let d = distance_m(from_hs, truth_position());
    assert!(
        d < RECOVERY_TOLERANCE_M,
        "reducing raw sextant readings landed {d:.3} m from the truth"
    );
}

#[test]
fn a_two_star_session_is_ambiguous_and_says_what_would_settle_it() {
    let run = skyfix(["solve", &fixture("phl_two_star.session.json")]).expect_code(0);
    assert!(
        run.stdout.contains("\nAMBIGUOUS: 2 CANDIDATES\n"),
        "{}",
        run.stdout
    );
    assert!(run.stdout.contains("Candidate 1"), "{}", run.stdout);
    assert!(run.stdout.contains("Candidate 2"), "{}", run.stdout);
    assert!(
        support::flatten(&run.stdout).contains("cannot distinguish"),
        "{}",
        run.stdout
    );
    assert!(
        run.stdout.contains("azimuth"),
        "the remedy must name a different azimuth:\n{}",
        run.stdout
    );
    // Candidates are formatted exactly like a fix: decimal degrees and degrees+minutes.
    assert!(
        run.stdout.contains("39 57.16' N, 075 09.91' W"),
        "{}",
        run.stdout
    );
    assert!(run.stdout.contains("Circles of position"), "{}", run.stdout);
}

#[test]
fn require_unique_turns_an_ambiguous_result_into_exit_three() {
    skyfix([
        "solve",
        &fixture("phl_two_star.session.json"),
        "--require-unique",
    ])
    .expect_code(3)
    .expect_stdout("AMBIGUOUS")
    .expect_stderr("not a unique fix");
}

#[test]
fn a_one_star_session_is_underdetermined_and_returns_its_circle() {
    let run = skyfix(["solve", &fixture("phl_one_star.session.json")]).expect_code(0);
    assert!(run.stdout.contains("\nUNDERDETERMINED\n"), "{}", run.stdout);
    assert!(
        run.stdout
            .contains("one sight constrains you to a circle, not a point"),
        "the required sentence is missing:\n{}",
        run.stdout
    );
    assert!(run.stdout.contains("Circles of position"), "{}", run.stdout);
    assert!(run.stdout.contains("Vega"), "{}", run.stdout);
    assert!(run.stdout.contains("zenith distance"), "{}", run.stdout);
    assert!(run.stdout.contains("radius"), "{}", run.stdout);
    assert!(run.stdout.contains("NM"), "{}", run.stdout);
    // No position anywhere: an underdetermined result must not offer one.
    assert!(
        !run.stdout.contains("UNIQUE"),
        "no fix may be reported:\n{}",
        run.stdout
    );

    skyfix([
        "solve",
        &fixture("phl_one_star.session.json"),
        "--require-unique",
    ])
    .expect_code(3);
}

#[test]
fn solve_json_is_the_fix_result_exactly_as_serde_emits_it() {
    let run = skyfix(["solve", &fixture("phl_four_star.session.json"), "--json"]).expect_code(0);
    let v = run.json();
    assert_eq!(v["kind"], "unique");
    assert!(v["fix"]["position"]["lat_deg"].is_number(), "{v}");
    assert_eq!(
        v["fix"]["ellipse95"]["model"],
        "nominal 95 %, independent-noise model"
    );
    assert_eq!(
        v["fix"]["residuals"].as_array().expect("residuals").len(),
        4
    );
    // It must deserialise back into the core type, not merely look like it.
    let _: skyfix_core::types::FixResult =
        serde_json::from_str(&run.stdout).expect("round-trips through the core type");
}

#[test]
fn a_prior_is_reported_rather_than_folded_in_silently() {
    let run = skyfix([
        "solve",
        &fixture("phl_four_star.session.json"),
        "--prior",
        "40.5,-75.8,20",
    ])
    .expect_code(0);
    assert!(run.stdout.contains("Prior"), "{}", run.stdout);
    assert!(
        support::flatten(&run.stdout).contains("the prior moved the fix"),
        "the prior's effect must be stated:\n{}",
        run.stdout
    );
    assert!(
        support::flatten(&run.stdout).contains("without the prior"),
        "the fix without the prior must be shown:\n{}",
        run.stdout
    );
    // A 20 NM prior 45 NM away drags the answer off the truth: that is the point.
    let with_prior = solved_position(
        &fixture("phl_four_star.session.json"),
        &["--prior", "40.5,-75.8,20"],
    );
    assert!(
        distance_m(with_prior, truth_position()) > RECOVERY_TOLERANCE_M,
        "a prior that disagrees with the sights has to move the fix"
    );
}

#[test]
fn robust_weighting_is_visible_in_the_report() {
    let run = skyfix(["solve", &fixture("phl_four_star.session.json"), "--robust"]).expect_code(0);
    assert!(run.stdout.contains("Robust weighting"), "{}", run.stdout);
    assert!(run.stdout.contains("Huber k = 1.5"), "{}", run.stdout);
}

#[test]
fn a_shared_bias_is_named_when_it_is_estimated() {
    let run = skyfix(["solve", &fixture("phl_four_star.session.json"), "--bias"]).expect_code(0);
    assert!(run.stdout.contains("Shared bias"), "{}", run.stdout);
    assert!(
        run.stdout.contains("rank 3 of 3") || run.stdout.contains("shared bias"),
        "the conditioning must include the bias column:\n{}",
        run.stdout
    );
}

#[test]
fn clock_uncertainty_is_propagated_east_west_and_never_estimated() {
    let run = skyfix([
        "solve",
        &fixture("phl_four_star.session.json"),
        "--clock-sigma",
        "60",
    ])
    .expect_code(0);
    assert!(
        run.stdout.contains("clock contribution to east"),
        "{}",
        run.stdout
    );
    assert!(
        support::flatten(&run.stdout).contains("Clock error and longitude are the same quantity"),
        "the degeneracy has to be stated:\n{}",
        run.stdout
    );
}

// ---------------------------------------------------------------------------
// The provider path
// ---------------------------------------------------------------------------

/// A session naming real stars with no supplied directions, so the CLI has to ask the
/// provider. The altitudes come from the provider first, in this test, because there is
/// no other way to know what a real star's altitude was — which is exactly why the
/// supplied-direction fixtures above exist as the independent check on the solver.
fn named_star_session() -> String {
    use skyfix_core::types::{AssumedPositionRole, Observer, SESSION_SCHEMA, Session, SessionMeta};
    let mut builder = support::SessionBuilder::new(
        "Philadelphia four-star, named bodies",
        "No geocentric blocks: the CLI must resolve every body through its own provider.",
    )
    .observer(Observer {
        assumed_position: Some(LatLon {
            lat_deg: 40.5,
            lon_deg: -75.8,
        }),
        assumed_position_role: AssumedPositionRole::Initializer,
        ..Observer::default()
    });
    for (i, name) in ["Schedar", "Markab", "Altair", "Eltanin"]
        .iter()
        .enumerate()
    {
        builder = builder.observed_ho(&format!("obs-{}", i + 1), name, PHL, 1.0);
    }
    let with_directions: Session = builder.build();
    // Strip them: the whole point is that the provider has to supply them again.
    let stripped = support::without_directions(&with_directions);
    assert_eq!(stripped.schema, SESSION_SCHEMA);
    assert!(stripped.observations.iter().all(|o| o.geocentric.is_none()));
    let _ = SessionMeta::default();
    support::to_json(&stripped)
}

#[test]
fn the_provider_resolves_named_stars_and_the_fix_still_lands_on_the_truth() {
    let path = support::write_tmp("named_stars.session.json", &named_star_session());
    let file = path.to_str().expect("utf-8 path");

    let reduced = skyfix(["reduce", file]).expect_code(0);
    assert!(
        reduced.stdout.contains("direction: skyfix-auto"),
        "the reduction must name the provider it used:\n{}",
        reduced.stdout
    );
    assert!(
        reduced.stdout.contains("Ho 51.978993 deg"),
        "the provider must reproduce the altitude the session was built from:\n{}",
        reduced.stdout
    );
    reduced.expect_stderr("covers only");

    skyfix(["solve", file])
        .expect_code(0)
        .expect_stdout("UNIQUE FIX");
    let fix = solved_position(file, &[]);
    assert!(
        distance_m(fix, truth_position()) < RECOVERY_TOLERANCE_M,
        "provider-resolved fix {fix:?} missed the truth"
    );
}

#[test]
fn ephemeris_supplied_refuses_a_session_that_has_no_directions() {
    let path = support::write_tmp("named_stars_2.session.json", &named_star_session());
    // Every sight is lost, so the run earns exit 2 ("sights rejected") and still
    // reports, correctly, that nothing is left to fix a position with.
    skyfix(["solve", path.to_str().unwrap(), "--ephemeris", "supplied"])
        .expect_code(2)
        .expect_stderr("supply gha_deg/dec_deg")
        .expect_stderr("4 of 4 sight(s) were rejected")
        .expect_stdout("UNDERDETERMINED");
    skyfix([
        "solve",
        path.to_str().unwrap(),
        "--ephemeris",
        "supplied",
        "--require-unique",
    ])
    .expect_code(3);
}

#[test]
fn the_sun_resolves_through_the_provider_too() {
    let path = support::write_tmp(
        "sun_only.session.json",
        r#"{"schema":"skyfix.session/1",
            "observer":{"assumed_position":{"lat_deg":39.9526,"lon_deg":-75.1652}},
            "observations":[
             {"id":"obs-1","body":"Sun","utc":"2026-10-01T15:00:00Z","altitude_deg":40.0,
              "altitude_kind":"observed_ho"}]}"#,
    );
    let run = skyfix(["reduce", path.to_str().unwrap()]).expect_code(0);
    assert!(run.stdout.contains("obs-1  Sun"), "{}", run.stdout);
    assert!(
        run.stdout.contains("direction: skyfix-auto"),
        "{}",
        run.stdout
    );
    // The Sun has a disc and a measurable parallax; a star has neither.
    assert!(run.stdout.contains("Hc "), "{}", run.stdout);
}

// ---------------------------------------------------------------------------
// catalog, coverage, convert
// ---------------------------------------------------------------------------

#[test]
fn catalog_lists_every_body_and_the_provider_that_answers_for_it() {
    let run = skyfix(["catalog"]).expect_code(0);
    assert!(run.stdout.contains("Sun"), "{}", run.stdout);
    assert!(run.stdout.contains("Vega"), "{}", run.stdout);
    assert!(run.stdout.contains("Polaris"), "{}", run.stdout);
    assert!(run.stdout.contains("HIP <number>"), "{}", run.stdout);

    let run = skyfix(["catalog", "--json"]).expect_code(0);
    let v = run.json();
    let bodies = v["bodies"].as_array().expect("a bodies array");
    assert!(bodies.len() > 50, "{}", bodies.len());
    let sun = bodies
        .iter()
        .find(|b| b["body"] == "Sun")
        .expect("the Sun is listed");
    assert_eq!(sun["available"], Value::Bool(true));
    assert!(sun["provider"].is_string(), "{sun}");
}

#[test]
fn coverage_prints_each_providers_own_declaration() {
    let run = skyfix(["coverage"]).expect_code(0);
    assert!(run.stdout.contains("dates"), "{}", run.stdout);
    assert!(run.stdout.contains("accuracy"), "{}", run.stdout);
    assert!(run.stdout.contains("arcmin"), "{}", run.stdout);
    assert!(
        run.stdout.contains("1990-01-01T00:00:00Z"),
        "{}",
        run.stdout
    );

    let run = skyfix(["coverage", "--json"]).expect_code(0);
    let v = run.json();
    let providers = v.as_array().expect("an array of providers");
    assert!(providers.len() >= 2, "Sun and stars at least: {v}");
    for p in providers {
        assert!(p["name"].is_string(), "{p}");
        assert!(p["coverage"]["start_utc"].is_string(), "{p}");
        assert!(p["coverage"]["accuracy_arcmin"].is_number(), "{p}");
        assert!(!p["coverage"]["notes"].as_str().expect("notes").is_empty());
    }
}

#[test]
fn convert_round_trips_json_to_csv_and_back_without_loss() {
    let csv = support::tmp_dir().join("round_trip.csv");
    let json = support::tmp_dir().join("round_trip.json");
    let original = fixture("phl_sextant.session.json");

    skyfix(["convert", &original, csv.to_str().unwrap()])
        .expect_code(0)
        .expect_stderr("(json) to");
    skyfix(["convert", csv.to_str().unwrap(), json.to_str().unwrap()]).expect_code(0);

    let before: skyfix_core::types::Session =
        serde_json::from_str(&std::fs::read_to_string(&original).expect("read")).expect("parse");
    let after: skyfix_core::types::Session =
        serde_json::from_str(&std::fs::read_to_string(&json).expect("read")).expect("parse");
    assert_eq!(before, after, "the CSV round trip lost or changed a field");
}

#[test]
fn convert_to_stdout_flips_the_format() {
    let run = skyfix(["convert", &fixture("phl_one_star.session.json"), "-"]).expect_code(0);
    assert!(
        run.stdout.starts_with("# schema=skyfix.session/1"),
        "{}",
        run.stdout
    );
    assert!(run.stdout.contains("id,body,utc,"), "{}", run.stdout);
}

#[test]
fn convert_refuses_an_output_it_cannot_name() {
    skyfix([
        "convert",
        &fixture("phl_one_star.session.json"),
        "/tmp/skyfix-should-not-exist.txt",
    ])
    .expect_code(1)
    .expect_stderr(".json or .csv");
}

// ---------------------------------------------------------------------------
// simulate, experiment, demos
// ---------------------------------------------------------------------------

#[test]
fn demos_lists_all_ten_packaged_scenarios() {
    let run = skyfix(["demos"]).expect_code(0);
    for name in [
        "philadelphia-stars",
        "philadelphia-stars-real",
        "philadelphia-stars-sextant",
        "good-geometry",
        "clustered-geometry",
        "one-bad-sight",
        "clock-offset",
        "shared-bias",
        "single-sight",
        "two-sight-ambiguous",
    ] {
        assert!(
            run.stdout.contains(name),
            "{name} is missing from `skyfix demos`"
        );
    }
    assert!(
        run.stdout.contains("10 packaged scenarios"),
        "{}",
        run.stdout
    );

    let run = skyfix(["demos", "--json"]).expect_code(0);
    assert_eq!(run.json().as_array().expect("an array").len(), 10);
}

#[test]
fn simulate_writes_two_files_and_keeps_the_truth_out_of_the_session() {
    let session = support::tmp_dir().join("sim.session.json");
    let truth = support::tmp_dir().join("sim.truth.json");
    skyfix([
        "simulate",
        "--demo",
        "philadelphia-stars",
        "--out-session",
        session.to_str().unwrap(),
        "--out-truth",
        truth.to_str().unwrap(),
    ])
    .expect_code(0)
    .expect_stdout("Session written to")
    .expect_stdout("Truth written to")
    .expect_stdout("INITIALIZER");

    let session_text = std::fs::read_to_string(&session).expect("the session was written");
    for secret in ["39.9526", "75.1652", "2026100101"] {
        assert!(
            !session_text.contains(secret),
            "the session leaks {secret}, which only the truth document may hold"
        );
    }
    let truth_doc: Truth =
        serde_json::from_str(&std::fs::read_to_string(&truth).expect("truth")).expect("parse");
    assert_eq!(truth_doc.position, PHL);
    assert_eq!(truth_doc.schema, skyfix_core::types::TRUTH_SCHEMA);
}

#[test]
fn simulate_never_prints_the_truth_unless_it_is_asked_to() {
    let session = support::tmp_dir().join("quiet.session.json");
    let quiet = skyfix([
        "simulate",
        "--demo",
        "clock-offset",
        "--out-session",
        session.to_str().unwrap(),
    ])
    .expect_code(0);
    assert!(
        !quiet.stdout.contains("39.9526") && !quiet.stdout.contains("TRUTH"),
        "the truth reached stdout without --show-truth:\n{}",
        quiet.stdout
    );
    quiet.expect_stderr("the truth for this run was discarded");

    let loud = skyfix([
        "simulate",
        "--demo",
        "clock-offset",
        "--out-session",
        session.to_str().unwrap(),
        "--show-truth",
    ])
    .expect_code(0);
    assert!(loud.stdout.contains("TRUTH"), "{}", loud.stdout);
    assert!(loud.stdout.contains("39 57.16' N"), "{}", loud.stdout);
    assert!(
        loud.stdout.contains("recorded times are +60 s"),
        "the clock offset belongs in the truth block:\n{}",
        loud.stdout
    );
}

#[test]
fn a_simulated_clock_offset_moves_longitude_and_leaves_no_residual() {
    // docs/SIMULATOR.md section 2: 60 s at the sidereal rate is 0.2507 degrees west.
    let session = support::tmp_dir().join("clock.session.json");
    skyfix([
        "simulate",
        "--demo",
        "clock-offset",
        "--out-session",
        session.to_str().unwrap(),
    ])
    .expect_code(0);
    let file = session.to_str().expect("utf-8");

    let run = skyfix(["solve", file]).expect_code(0);
    assert!(run.stdout.contains("UNIQUE FIX"), "{}", run.stdout);

    let fix = solved_position(file, &[]);
    let shift = fix.lon_deg - PHL.lon_deg;
    assert!(
        (shift + 0.2507).abs() < 1e-3,
        "longitude moved {shift:.4} deg, expected -0.2507"
    );
    assert!(
        (fix.lat_deg - PHL.lat_deg).abs() < 1e-6,
        "latitude should be untouched, moved to {}",
        fix.lat_deg
    );

    // The dangerous part: nothing in the data shows the error.
    let v: Value = serde_json::from_str(&skyfix(["solve", file, "--json"]).expect_code(0).stdout)
        .expect("json");
    for r in v["fix"]["residuals"].as_array().expect("residuals") {
        let resid = r["residual_arcmin"].as_f64().expect("a number");
        assert!(resid.abs() < 1e-6, "residual {resid} should be zero: {r}");
    }

    // Declaring the clock's uncertainty is the honest response, and it widens the east.
    let widened = skyfix(["solve", file, "--clock-sigma", "60"]).expect_code(0);
    assert!(
        support::flatten(&widened.stdout)
            .contains("Clock error and longitude are the same quantity"),
        "{}",
        widened.stdout
    );
}

#[test]
fn a_shared_bias_defeats_the_independent_noise_ellipse() {
    let run = skyfix(["experiment", "--demo", "shared-bias", "--repetitions", "20"]).expect_code(0);
    assert!(
        run.stdout.contains("EXPERIMENT shared-bias"),
        "{}",
        run.stdout
    );
    assert!(
        run.stdout
            .contains("coverage of the nominal 95 % ellipse  0.000"),
        "a shared bias must put the truth outside the ellipse every time:\n{}",
        run.stdout
    );
    assert!(run.stdout.contains("Wilson"), "{}", run.stdout);
    assert!(
        support::flatten(&run.stdout).contains("meant to fail this test"),
        "the report has to say the failure is the point:\n{}",
        run.stdout
    );
    // The error is tens of times the predicted sigma, not a few percent off.
    let ratio = run
        .stdout
        .lines()
        .find(|l| l.contains("RMS error / RMS predicted sigma"))
        .and_then(|l| l.split_whitespace().last().map(str::to_string))
        .and_then(|s| s.parse::<f64>().ok())
        .expect("the ratio is printed");
    assert!(ratio > 10.0, "error-to-sigma ratio was only {ratio}");
}

#[test]
fn a_healthy_experiment_covers_about_ninety_five_percent() {
    let out = support::tmp_dir().join("healthy.csv");
    let run = skyfix([
        "experiment",
        "--demo",
        "philadelphia-stars",
        "--repetitions",
        "60",
        "--out",
        out.to_str().unwrap(),
    ])
    .expect_code(0);
    let coverage = run
        .stdout
        .lines()
        .find(|l| l.contains("coverage of the nominal 95 %"))
        .and_then(|l| l.split_whitespace().nth(7).map(str::to_string))
        .and_then(|s| s.parse::<f64>().ok())
        .expect("coverage is printed");
    assert!(
        (0.80..=1.0).contains(&coverage),
        "coverage {coverage} is nowhere near the nominal 0.95"
    );
    let csv = std::fs::read_to_string(&out).expect("the table was written");
    assert!(csv.contains("# experiment: philadelphia-stars"), "{csv}");
    assert_eq!(
        csv.lines()
            .filter(|l| l.starts_with("0,") || l.starts_with("59,"))
            .count(),
        2,
        "the first and last repetition should both have a row"
    );
}

#[test]
fn an_underdetermined_scenario_scores_nothing_and_says_so() {
    skyfix(["experiment", "--demo", "single-sight", "--repetitions", "3"])
        .expect_code(3)
        .expect_stdout("underdetermined")
        .expect_stdout("Nothing was scored")
        .expect_stderr("no repetition produced a unique fix");
}

#[test]
fn an_experiment_pointed_at_the_answer_is_refused() {
    skyfix([
        "experiment",
        "--demo",
        "philadelphia-stars",
        "--repetitions",
        "2",
        "--init",
        "39.9526,-75.1652",
    ])
    .expect_code(1)
    .expect_stderr("measures nothing");
}

// ---------------------------------------------------------------------------
// exit codes and usage
// ---------------------------------------------------------------------------

#[test]
fn plan_is_not_wired_and_exits_four() {
    skyfix([
        "plan",
        "--position",
        "39.9526,-75.1652",
        "--utc",
        "2026-10-01T01:30:00Z",
    ])
    .expect_code(4)
    .expect_stderr("not yet wired in this build");
}

#[test]
fn usage_errors_exit_one_not_claps_default_two() {
    // Clap's own default for a usage error is 2, which is this tool's "sights rejected".
    skyfix(["solve"]).expect_code(1);
    skyfix(["no-such-command"]).expect_code(1);
    skyfix(["solve", "x.json", "--init", "40,-75", "--no-init"]).expect_code(1);
    skyfix(["reduce", "x.json", "--json", "--csv"]).expect_code(1);
    skyfix(["solve", "x.json", "--init", "not-a-position"]).expect_code(1);
    skyfix(["solve", "x.json", "--prior", "40,-75"]).expect_code(1);
}

#[test]
fn help_and_version_exit_zero() {
    skyfix(["--help"])
        .expect_code(0)
        .expect_stdout("Usage: skyfix");
    skyfix(["--version"]).expect_code(0);
    skyfix(["solve", "--help"])
        .expect_code(0)
        .expect_stdout("--require-unique");
}

#[test]
fn a_missing_file_is_a_usage_error_with_the_path_in_it() {
    skyfix(["solve", "/no/such/session.json"])
        .expect_code(1)
        .expect_stderr("/no/such/session.json");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// The position a solve produced, read out of its JSON so the text format is free to
/// change without breaking the numerical assertions.
fn solved_position(file: &str, extra: &[&str]) -> LatLon {
    let mut args = vec!["solve", file, "--json"];
    args.extend_from_slice(extra);
    let run = skyfix(&args);
    let v: Value = serde_json::from_str(&run.stdout)
        .unwrap_or_else(|e| panic!("solve --json did not emit JSON ({e}):\n{}", run.stdout));
    assert_eq!(v["kind"], "unique", "expected a unique fix, got:\n{v}");
    LatLon {
        lat_deg: v["fix"]["position"]["lat_deg"].as_f64().expect("lat"),
        lon_deg: v["fix"]["position"]["lon_deg"].as_f64().expect("lon"),
    }
}
