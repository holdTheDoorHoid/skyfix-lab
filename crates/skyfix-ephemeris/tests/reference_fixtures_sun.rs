//! `SunProvider` against the independently generated reference fixtures
//! (`skyfix.reference/1`, CONVENTIONS section 11).
//!
//! The fixture file is produced by `tools/reference/` (Python + Skyfield) and is the
//! only genuinely independent check of this crate's astronomy. It is optional: if it
//! has not been generated yet, this test prints a note and passes, so the ephemeris
//! work is not blocked on the fixtures agent. When it *is* present, the comparison is
//! made at the tolerance the file itself records — never at a tolerance chosen to make
//! the test pass.
//!
//! The comparator itself is exercised below on synthetic documents with deliberately
//! wrong values, so a missing fixture cannot turn into a silent pass and a bug in the
//! loader cannot hide a real disagreement.
//!
//! Run `cargo test -p skyfix-ephemeris --test reference_fixtures_sun -- --nocapture`
//! to see the per-case deviations.

use serde::Deserialize;
use skyfix_core::time::parse_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::sun::SunProvider;

const FIXTURE: &str = "fixtures/reference/geocentric_sun_stars.json";

#[derive(Debug, Deserialize)]
struct ReferenceFile {
    schema: String,
    #[serde(default)]
    generator: Generator,
    /// Tolerance every case is judged at, arcminutes. Required by CONVENTIONS 11.
    #[serde(default)]
    tolerance_arcmin: Option<f64>,
    cases: Vec<Case>,
}

#[derive(Debug, Default, Deserialize)]
struct Generator {
    /// DUT1 = UT1 - UTC in seconds that the generator applied, when it records one.
    /// Absent means this crate's DUT1 = 0 assumption is used, which is worth up to
    /// 0.23' of GHA on its own.
    #[serde(default)]
    dut1_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct Case {
    utc: String,
    body: String,
    gha_deg: f64,
    dec_deg: f64,
    #[serde(default)]
    semidiameter_arcmin: Option<f64>,
    #[serde(default)]
    horizontal_parallax_arcmin: Option<f64>,
    /// Per-case override of the file-level tolerance.
    #[serde(default)]
    tolerance_arcmin: Option<f64>,
}

#[derive(Debug)]
struct Report {
    checked: usize,
    worst_gha_arcmin: f64,
    worst_dec_arcmin: f64,
    failures: Vec<String>,
    dut1_recorded: bool,
}

/// Compare every `body == "Sun"` case in a `skyfix.reference/1` document against
/// `SunProvider`. Returns the report; malformed documents are an `Err`, disagreements
/// are collected in `report.failures`.
fn compare_sun_cases(text: &str, label: &str) -> Result<Report, String> {
    let file: ReferenceFile = serde_json::from_str(text)
        .map_err(|e| format!("{label} is not valid skyfix.reference/1 JSON: {e}"))?;
    if file.schema != skyfix_core::types::REFERENCE_SCHEMA {
        return Err(format!("{label} declares schema {:?}", file.schema));
    }
    let default_tol = file.tolerance_arcmin.ok_or_else(|| {
        format!(
            "{label} records no `tolerance_arcmin`. CONVENTIONS section 11 requires every \
             reference file to state the tolerance it is to be judged at; this test will \
             not invent one."
        )
    })?;
    if !(default_tol.is_finite() && default_tol > 0.0) {
        return Err(format!(
            "{label} tolerance_arcmin must be positive and finite, got {default_tol}"
        ));
    }

    let provider = match file.generator.dut1_s {
        Some(d) => SunProvider::with_dut1_s(d),
        None => SunProvider::new(),
    };

    let mut report = Report {
        checked: 0,
        worst_gha_arcmin: 0.0,
        worst_dec_arcmin: 0.0,
        failures: Vec::new(),
        dut1_recorded: file.generator.dut1_s.is_some(),
    };

    for case in file.cases.iter().filter(|c| c.body == "Sun") {
        let tol = case.tolerance_arcmin.unwrap_or(default_tol);
        let jd = parse_utc(&case.utc)
            .map_err(|e| format!("{label} case {} has an unusable timestamp: {e}", case.utc))?;
        let got = provider
            .geocentric("Sun", jd)
            .map_err(|e| format!("{label} case {}: {e}", case.utc))?;

        // GHA wraps; compare the short way round. No cos(dec) factor: the tolerance is
        // stated on GHA itself, which is the stricter reading.
        let d_gha = norm_180(got.gha_deg - case.gha_deg).abs() * 60.0;
        let d_dec = (got.dec_deg - case.dec_deg).abs() * 60.0;
        report.worst_gha_arcmin = report.worst_gha_arcmin.max(d_gha);
        report.worst_dec_arcmin = report.worst_dec_arcmin.max(d_dec);
        report.checked += 1;

        println!(
            "{}  dGHA {d_gha:.4}'  dDec {d_dec:.4}'  (tolerance {tol}')",
            case.utc
        );
        if d_gha > tol {
            report.failures.push(format!(
                "{}: GHA off by {d_gha:.4}' (tolerance {tol}'); expected {:.6}, got {:.6}",
                case.utc, case.gha_deg, got.gha_deg
            ));
        }
        if d_dec > tol {
            report.failures.push(format!(
                "{}: Dec off by {d_dec:.4}' (tolerance {tol}'); expected {:.6}, got {:.6}",
                case.utc, case.dec_deg, got.dec_deg
            ));
        }
        if let Some(sd) = case.semidiameter_arcmin {
            let d = (got.semidiameter_arcmin - sd).abs();
            if d > tol {
                report.failures.push(format!(
                    "{}: semidiameter off by {d:.4}' (tolerance {tol}'); expected {sd:.4}, got {:.4}",
                    case.utc, got.semidiameter_arcmin
                ));
            }
        }
        if let Some(hp) = case.horizontal_parallax_arcmin {
            let d = (got.horizontal_parallax_arcmin - hp).abs();
            if d > tol {
                report.failures.push(format!(
                    "{}: horizontal parallax off by {d:.4}' (tolerance {tol}'); expected {hp:.4}, got {:.4}",
                    case.utc, got.horizontal_parallax_arcmin
                ));
            }
        }
    }
    Ok(report)
}

#[test]
fn sun_matches_the_reference_fixtures() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        println!(
            "SKIPPED: {FIXTURE} does not exist yet ({}). The Sun model is unverified \
             against Skyfield until it does; the Meeus worked examples in \
             tests/sun_meeus_examples.rs are the fallback evidence.",
            path.display()
        );
        return;
    };

    let report = compare_sun_cases(&text, FIXTURE).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        report.checked > 0,
        "{FIXTURE} contains no cases with body == \"Sun\"; the Sun model is unverified \
         against the independent reference"
    );
    println!(
        "checked {} Sun cases: worst dGHA {:.4}', worst dDec {:.4}'",
        report.checked, report.worst_gha_arcmin, report.worst_dec_arcmin
    );

    if !report.failures.is_empty() {
        let dut1_note = if report.dut1_recorded {
            ""
        } else {
            "\n\nNOTE: the fixture records no `generator.dut1_s`, so this comparison used \
             DUT1 = 0 (CONVENTIONS section 6). If the generator applied a real DUT1, GHA can \
             differ by up to 0.23' for that reason alone. Record `dut1_s` in the fixture's \
             `generator` block and this test will use it. Declination, semidiameter and \
             horizontal parallax do not depend on DUT1, so a failure there is a real model \
             disagreement."
        };
        panic!(
            "{} of the {} Sun cases in {FIXTURE} are outside tolerance:\n  {}{dut1_note}",
            report.failures.len(),
            report.checked,
            report.failures.join("\n  ")
        );
    }
}

// ---------------------------------------------------------------------------
// The comparator itself. These documents are NOT reference fixtures: the values in
// them are chosen to be wrong by a known amount, so that a comparator which quietly
// passes everything is caught.
// ---------------------------------------------------------------------------

fn doc(tolerance: &str, cases: &str) -> String {
    format!(
        r#"{{"schema":"skyfix.reference/1","generator":{{"tool":"synthetic"}},
            {tolerance} "cases":[{cases}]}}"#
    )
}

#[test]
fn comparator_flags_values_that_are_wrong() {
    // Deliberately absurd: no ephemeris puts the Sun at Dec +45 at an equinox.
    let d = doc(
        r#""tolerance_arcmin": 0.5,"#,
        r#"{"utc":"2026-03-20T14:46:00Z","body":"Sun","gha_deg":40.0,"dec_deg":45.0,
            "semidiameter_arcmin":99.0,"horizontal_parallax_arcmin":9.0}"#,
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert_eq!(r.checked, 1);
    assert_eq!(
        r.failures.len(),
        4,
        "GHA, Dec, SD and HP should all be flagged: {:?}",
        r.failures
    );
}

#[test]
fn comparator_ignores_bodies_that_are_not_the_sun() {
    let d = doc(
        r#""tolerance_arcmin": 0.5,"#,
        r#"{"utc":"2026-03-20T14:46:00Z","body":"Vega","gha_deg":1.0,"dec_deg":38.8}"#,
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert_eq!(r.checked, 0);
    assert!(r.failures.is_empty());
}

#[test]
fn comparator_refuses_a_file_with_no_tolerance_or_a_bad_schema() {
    let no_tol = doc(
        "",
        r#"{"utc":"2026-03-20T14:46:00Z","body":"Sun","gha_deg":40.0,"dec_deg":0.0}"#,
    );
    let e = compare_sun_cases(&no_tol, "synthetic").unwrap_err();
    assert!(e.contains("tolerance_arcmin"), "{e}");

    let bad_schema = r#"{"schema":"skyfix.reference/2","tolerance_arcmin":1.0,"cases":[]}"#;
    let e = compare_sun_cases(bad_schema, "synthetic").unwrap_err();
    assert!(e.contains("schema"), "{e}");

    for tol in ["0.0", "-1.0"] {
        let bad = doc(&format!(r#""tolerance_arcmin": {tol},"#), "");
        assert!(compare_sun_cases(&bad, "synthetic").is_err());
    }
}

/// The GHA comparison must go the short way round 360: a case written as 359.99 when
/// the provider says 0.01 is 0.02 deg apart, not 359.98.
#[test]
fn comparator_compares_gha_across_the_360_seam() {
    let jd = parse_utc("2026-03-20T14:46:00Z").unwrap();
    let gha = SunProvider::new().position(jd).unwrap().gha_deg;
    // Restate the same hour angle 360 deg away, plus 0.2' (= 0.00333 deg).
    let restated = gha - 360.0 + 0.2 / 60.0;
    let d = doc(
        r#""tolerance_arcmin": 0.5,"#,
        &format!(
            r#"{{"utc":"2026-03-20T14:46:00Z","body":"Sun","gha_deg":{restated},"dec_deg":0.0}}"#
        ),
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert!(
        (r.worst_gha_arcmin - 0.2).abs() < 1e-6,
        "expected a 0.2' GHA difference across the seam, got {:.6}'",
        r.worst_gha_arcmin
    );
    // Dec 0.0 is right at an equinox, so only the (0.2' < 0.5') GHA passes and nothing
    // is flagged.
    assert!(r.failures.is_empty(), "{:?}", r.failures);
}

/// A recorded `generator.dut1_s` must actually be used, otherwise the comparison
/// silently carries up to 0.23' of avoidable GHA error.
#[test]
fn comparator_applies_a_recorded_dut1() {
    let jd = parse_utc("2026-03-20T14:46:00Z").unwrap();
    let with_dut1 = SunProvider::with_dut1_s(0.8).position(jd).unwrap();
    let text = format!(
        r#"{{"schema":"skyfix.reference/1","generator":{{"dut1_s":0.8}},
            "tolerance_arcmin":0.01,
            "cases":[{{"utc":"2026-03-20T14:46:00Z","body":"Sun","gha_deg":{},"dec_deg":{}}}]}}"#,
        with_dut1.gha_deg, with_dut1.dec_deg
    );
    let r = compare_sun_cases(&text, "synthetic").unwrap();
    assert_eq!(r.checked, 1);
    assert!(r.dut1_recorded);
    assert!(
        r.failures.is_empty() && r.worst_gha_arcmin < 1e-9,
        "the recorded DUT1 was not applied: worst dGHA {:.6}'",
        r.worst_gha_arcmin
    );
}
