//! `SunProvider` against the independently generated reference fixtures
//! (`skyfix.reference/1`, CONVENTIONS section 11).
//!
//! `fixtures/reference/geocentric_sun_stars.json` is produced by `tools/reference/`
//! (Python + Skyfield + JPL DE421/DE440s) and is the only genuinely independent check
//! of this crate's astronomy — a different ephemeris, a different implementation and a
//! different language. Everything is judged at the `generator.tolerance_arcmin` the
//! file itself records; never at a tolerance chosen to make the test pass.
//!
//! # Which GHA column
//!
//! Each body carries two: `gha_deg` uses Skyfield's UT1 (so it applies the epoch's
//! DUT1), and `gha_deg_dut1_zero` recomputes it with UT1 = UTC, which is the
//! CONVENTIONS section 6 assumption. `SunProvider::new()` assumes DUT1 = 0, so it is
//! compared against `gha_deg_dut1_zero`. The file's own DUT1 runs to -3.52 s, worth
//! 0.88' of GHA — well over the tolerance — so this test *also* re-runs every case
//! with `SunProvider::with_dut1_s(case.dut1_s)` against `gha_deg`, which checks that
//! the DUT1 input is wired up correctly rather than merely unused.
//!
//! Declination, right ascension, semidiameter, horizontal parallax and the radius
//! vector do not depend on UT1 and compare directly.
//!
//! The file is optional: if it has not been generated, this test prints a note and
//! passes, so the ephemeris work is not blocked on the fixtures agent. The comparator
//! is exercised below on synthetic documents with deliberately wrong values, so a
//! missing fixture cannot become a silent pass.
//!
//! Run with `-- --nocapture` to see the per-quantity worst deviations.

use std::collections::BTreeMap;

use serde::Deserialize;
use skyfix_core::time::parse_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::sun::SunProvider;

const FIXTURE: &str = "fixtures/reference/geocentric_sun_stars.json";
const BODY: &str = "Sun";

#[derive(Debug, Deserialize)]
struct ReferenceFile {
    schema: String,
    #[serde(default)]
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Default, Deserialize)]
struct Generator {
    /// Tolerance every case is judged at, arcminutes. Required by CONVENTIONS 11.
    #[serde(default)]
    tolerance_arcmin: Option<f64>,
}

/// One epoch. `bodies` is keyed by Nautical Almanac name.
#[derive(Debug, Deserialize)]
struct Case {
    utc: String,
    #[serde(default)]
    jd_utc: Option<f64>,
    /// UT1 - UTC the generator used, seconds.
    #[serde(default)]
    dut1_s: Option<f64>,
    bodies: BTreeMap<String, Body>,
}

#[derive(Debug, Deserialize)]
struct Body {
    /// GHA with the generator's DUT1 applied.
    #[serde(default)]
    gha_deg: Option<f64>,
    /// GHA recomputed with UT1 = UTC. This is the column to test a DUT1 = 0 model on.
    #[serde(default)]
    gha_deg_dut1_zero: Option<f64>,
    dec_deg: f64,
    #[serde(default)]
    ra_deg: Option<f64>,
    #[serde(default)]
    semidiameter_arcmin: Option<f64>,
    #[serde(default)]
    horizontal_parallax_arcmin: Option<f64>,
    /// Light-time corrected geocentric distance, au.
    #[serde(default)]
    distance_au: Option<f64>,
}

/// Worst deviation seen for one quantity, and where.
#[derive(Debug, Default, Clone)]
struct Worst {
    value: f64,
    at: String,
}

impl Worst {
    fn see(&mut self, v: f64, at: &str) {
        if v > self.value {
            self.value = v;
            self.at = at.to_string();
        }
    }
}

#[derive(Debug, Default)]
struct Report {
    checked: usize,
    /// Arcminutes, against `gha_deg_dut1_zero` with `SunProvider::new()`.
    gha: Worst,
    /// Arcminutes, against `gha_deg` with the case's own DUT1 supplied.
    gha_with_dut1: Worst,
    dut1_cases: usize,
    dec: Worst,
    ra: Worst,
    sd: Worst,
    hp: Worst,
    /// Astronomical units, the VSOP87A Earth against the JPL kernel.
    distance_au: Worst,
    failures: Vec<String>,
}

/// Compare every `Sun` entry in a `skyfix.reference/1` document against `SunProvider`.
/// Malformed documents are an `Err`; disagreements land in `report.failures`.
fn compare_sun_cases(text: &str, label: &str) -> Result<Report, String> {
    let file: ReferenceFile = serde_json::from_str(text)
        .map_err(|e| format!("{label} is not valid skyfix.reference/1 JSON: {e}"))?;
    if file.schema != skyfix_core::types::REFERENCE_SCHEMA {
        return Err(format!("{label} declares schema {:?}", file.schema));
    }
    let tol = file.generator.tolerance_arcmin.ok_or_else(|| {
        format!(
            "{label} records no `generator.tolerance_arcmin`. CONVENTIONS section 11 \
             requires every reference file to state the tolerance it is to be judged at; \
             this test will not invent one."
        )
    })?;
    if !(tol.is_finite() && tol > 0.0) {
        return Err(format!(
            "{label} generator.tolerance_arcmin must be positive and finite, got {tol}"
        ));
    }

    let mut r = Report::default();
    let plain = SunProvider::new();

    for case in &file.cases {
        let Some(sun) = case.bodies.get(BODY) else {
            continue;
        };
        let jd = parse_utc(&case.utc)
            .map_err(|e| format!("{label} case {} has an unusable timestamp: {e}", case.utc))?;
        // The file's own jd_utc must agree with its own timestamp.
        if let Some(recorded) = case.jd_utc
            && (recorded - jd).abs() > 1e-6
        {
            return Err(format!(
                "{label} case {}: jd_utc {recorded} does not match the timestamp ({jd})",
                case.utc
            ));
        }
        let got = plain
            .position(jd)
            .map_err(|e| format!("{label} case {}: {e}", case.utc))?;
        r.checked += 1;

        let mut check = |what: &str, d: f64, worst: &mut Worst| {
            worst.see(d.abs(), &case.utc);
            if d.abs() > tol {
                r.failures.push(format!(
                    "{}: {what} off by {:.4}' (tolerance {tol}')",
                    case.utc,
                    d.abs()
                ));
            }
        };

        // GHA, DUT1 = 0. No cos(dec) factor: the tolerance is stated on GHA itself,
        // which is the stricter reading.
        let gha_ref = sun.gha_deg_dut1_zero.ok_or_else(|| {
            format!(
                "{label} case {}: the Sun has no `gha_deg_dut1_zero`. This crate assumes \
                 DUT1 = 0 (CONVENTIONS section 6) and cannot be compared against a GHA \
                 that carries the generator's DUT1.",
                case.utc
            )
        })?;
        check(
            "GHA (DUT1 = 0)",
            norm_180(got.gha_deg - gha_ref) * 60.0,
            &mut r.gha,
        );

        check("Dec", (got.dec_deg - sun.dec_deg) * 60.0, &mut r.dec);
        if let Some(ra) = sun.ra_deg {
            check("RA", norm_180(got.ra_deg - ra) * 60.0, &mut r.ra);
        }
        if let Some(sd) = sun.semidiameter_arcmin {
            check("semidiameter", got.semidiameter_arcmin - sd, &mut r.sd);
        }
        if let Some(hp) = sun.horizontal_parallax_arcmin {
            check(
                "horizontal parallax",
                got.horizontal_parallax_arcmin - hp,
                &mut r.hp,
            );
        }
        if let Some(dist) = sun.distance_au {
            // Not an angle: recorded in au and judged by the effect on semidiameter,
            // which the SD check above already covers.
            r.distance_au.see((got.radius_au - dist).abs(), &case.utc);
        }

        // Second pass: hand the provider the generator's own DUT1 and compare against
        // the other column. This is what proves `with_dut1_s` is actually applied.
        if let (Some(dut1), Some(gha_dut1)) = (case.dut1_s, sun.gha_deg) {
            let with = SunProvider::with_dut1_s(dut1)
                .position(jd)
                .map_err(|e| format!("{label} case {}: {e}", case.utc))?;
            let d = norm_180(with.gha_deg - gha_dut1) * 60.0;
            r.dut1_cases += 1;
            r.gha_with_dut1.see(d.abs(), &case.utc);
            if d.abs() > tol {
                r.failures.push(format!(
                    "{}: GHA with DUT1 = {dut1:+.6} s off by {:.4}' (tolerance {tol}')",
                    case.utc,
                    d.abs()
                ));
            }
        }
    }
    Ok(r)
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

    let r = compare_sun_cases(&text, FIXTURE).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        r.checked > 0,
        "{FIXTURE} contains no {BODY} entry in any case; the Sun model is unverified \
         against the independent reference"
    );

    println!("{FIXTURE}: {} epochs with a Sun", r.checked);
    for (what, w, unit) in [
        ("GHA (DUT1 = 0)", &r.gha, "'"),
        ("GHA (DUT1 supplied)", &r.gha_with_dut1, "'"),
        ("Dec", &r.dec, "'"),
        ("RA", &r.ra, "'"),
        ("semidiameter", &r.sd, "'"),
        ("horizontal parallax", &r.hp, "'"),
    ] {
        println!(
            "  worst {what:<21} {:.5}{unit} ({:.3}\")  at {}",
            w.value,
            w.value * 60.0,
            w.at
        );
    }
    println!(
        "  worst radius vector   {:.3e} au  at {}  (the VSOP87A Earth vs the JPL kernel)",
        r.distance_au.value, r.distance_au.at
    );
    println!(
        "  {} of those epochs also checked with their own DUT1",
        r.dut1_cases
    );

    assert!(
        r.failures.is_empty(),
        "{} of the {} {BODY} cases in {FIXTURE} are outside tolerance:\n  {}",
        r.failures.len(),
        r.checked,
        r.failures.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// The comparator itself. These documents are NOT reference fixtures: the values in
// them are chosen to be wrong by a known amount, so that a comparator which quietly
// passes everything is caught.
// ---------------------------------------------------------------------------

fn doc(generator: &str, cases: &str) -> String {
    format!(r#"{{"schema":"skyfix.reference/1","generator":{generator},"cases":[{cases}]}}"#)
}

#[test]
fn comparator_flags_values_that_are_wrong() {
    // Deliberately absurd: no ephemeris puts the Sun at Dec +45 at an equinox.
    let d = doc(
        r#"{"tool":"synthetic","tolerance_arcmin":0.05}"#,
        r#"{"utc":"2026-03-20T14:46:00Z","bodies":{"Sun":{
            "gha_deg_dut1_zero":40.0,"dec_deg":45.0,"ra_deg":123.0,
            "semidiameter_arcmin":99.0,"horizontal_parallax_arcmin":9.0}}}"#,
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert_eq!(r.checked, 1);
    assert_eq!(
        r.failures.len(),
        5,
        "GHA, Dec, RA, SD and HP should all be flagged: {:?}",
        r.failures
    );
}

#[test]
fn comparator_ignores_bodies_that_are_not_the_sun() {
    let d = doc(
        r#"{"tolerance_arcmin":0.05}"#,
        r#"{"utc":"2026-03-20T14:46:00Z","bodies":{"Vega":{
            "gha_deg_dut1_zero":1.0,"dec_deg":38.8}}}"#,
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert_eq!(r.checked, 0);
    assert!(r.failures.is_empty());
}

#[test]
fn comparator_refuses_a_file_that_does_not_say_what_it_expects() {
    let case = r#"{"utc":"2026-03-20T14:46:00Z","bodies":{"Sun":{
        "gha_deg_dut1_zero":40.0,"dec_deg":0.0}}}"#;

    let e = compare_sun_cases(&doc(r#"{"tool":"x"}"#, case), "synthetic").unwrap_err();
    assert!(e.contains("tolerance_arcmin"), "{e}");

    let e = compare_sun_cases(
        r#"{"schema":"skyfix.reference/2","generator":{"tolerance_arcmin":1.0},"cases":[]}"#,
        "synthetic",
    )
    .unwrap_err();
    assert!(e.contains("schema"), "{e}");

    for tol in ["0.0", "-1.0"] {
        let bad = doc(&format!(r#"{{"tolerance_arcmin":{tol}}}"#), case);
        assert!(compare_sun_cases(&bad, "synthetic").is_err());
    }

    // A Sun with only the DUT1-applied column cannot be judged by a DUT1 = 0 model.
    let only_dut1 = doc(
        r#"{"tolerance_arcmin":0.05}"#,
        r#"{"utc":"2026-03-20T14:46:00Z","dut1_s":0.4,
            "bodies":{"Sun":{"gha_deg":40.0,"dec_deg":0.0}}}"#,
    );
    let e = compare_sun_cases(&only_dut1, "synthetic").unwrap_err();
    assert!(e.contains("gha_deg_dut1_zero"), "{e}");

    // A jd_utc that disagrees with its own timestamp is a generator bug.
    let bad_jd = doc(
        r#"{"tolerance_arcmin":0.05}"#,
        r#"{"utc":"2026-03-20T14:46:00Z","jd_utc":2461000.0,
            "bodies":{"Sun":{"gha_deg_dut1_zero":40.0,"dec_deg":0.0}}}"#,
    );
    let e = compare_sun_cases(&bad_jd, "synthetic").unwrap_err();
    assert!(e.contains("jd_utc"), "{e}");
}

/// The GHA comparison must go the short way round 360: a case written as 359.99 when
/// the provider says 0.01 is 0.02 deg apart, not 359.98.
#[test]
fn comparator_compares_gha_across_the_360_seam() {
    let jd = parse_utc("2026-03-20T14:46:00Z").unwrap();
    let p = SunProvider::new().position(jd).unwrap();
    // Restate the same hour angle 360 deg away, plus 0.02' (well inside the tolerance).
    let restated = p.gha_deg - 360.0 + 0.02 / 60.0;
    let d = doc(
        r#"{"tolerance_arcmin":0.05}"#,
        &format!(
            r#"{{"utc":"2026-03-20T14:46:00Z","bodies":{{"Sun":{{
                "gha_deg_dut1_zero":{restated},"dec_deg":{}}}}}}}"#,
            p.dec_deg
        ),
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert!(
        (r.gha.value - 0.02).abs() < 1e-6,
        "expected a 0.02' GHA difference across the seam, got {:.6}'",
        r.gha.value
    );
    assert!(r.failures.is_empty(), "{:?}", r.failures);
}

/// A recorded `dut1_s` must actually reach the provider, otherwise the second pass is
/// comparing a DUT1 = 0 model against a column that carries one.
#[test]
fn comparator_applies_the_recorded_dut1() {
    let jd = parse_utc("2026-03-20T14:46:00Z").unwrap();
    let plain = SunProvider::new().position(jd).unwrap();
    let shifted = SunProvider::with_dut1_s(0.8).position(jd).unwrap();
    let d = doc(
        r#"{"tolerance_arcmin":0.05}"#,
        &format!(
            r#"{{"utc":"2026-03-20T14:46:00Z","dut1_s":0.8,"bodies":{{"Sun":{{
                "gha_deg":{},"gha_deg_dut1_zero":{},"dec_deg":{}}}}}}}"#,
            shifted.gha_deg, plain.gha_deg, plain.dec_deg
        ),
    );
    let r = compare_sun_cases(&d, "synthetic").unwrap();
    assert_eq!(r.dut1_cases, 1);
    assert!(
        r.failures.is_empty() && r.gha_with_dut1.value < 1e-9 && r.gha.value < 1e-9,
        "both columns should match exactly: DUT1 = 0 {:.3e}', DUT1 = 0.8 {:.3e}', {:?}",
        r.gha.value,
        r.gha_with_dut1.value,
        r.failures
    );

    // And swapping the columns must fail, so the two passes are genuinely distinct.
    let swapped = doc(
        r#"{"tolerance_arcmin":0.05}"#,
        &format!(
            r#"{{"utc":"2026-03-20T14:46:00Z","dut1_s":0.8,"bodies":{{"Sun":{{
                "gha_deg":{},"gha_deg_dut1_zero":{},"dec_deg":{}}}}}}}"#,
            plain.gha_deg, shifted.gha_deg, plain.dec_deg
        ),
    );
    let r = compare_sun_cases(&swapped, "synthetic").unwrap();
    assert_eq!(r.failures.len(), 2, "{:?}", r.failures);
}
