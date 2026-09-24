//! Compare `StarProvider` against the independently generated reference fixture, when
//! one is present.
//!
//! `fixtures/reference/geocentric_sun_stars.json` (schema `skyfix.reference/1`) is
//! produced by `tools/reference/` with Python + Skyfield, by a different agent, from a
//! JPL ephemeris — never from this crate's output (CONVENTIONS section 11). It does not
//! exist yet. Until it does this test **skips with a printed note** rather than
//! failing, so the suite stays green; the moment the file is dropped in, this becomes
//! the authoritative accuracy check and will fail if the models are wrong.
//!
//! Expected shape:
//!
//! ```json
//! {"schema": "skyfix.reference/1",
//!  "generator": {...},
//!  "tolerance_arcmin": 0.05,
//!  "cases": [{"utc": "2026-10-01T01:30:00Z", "body": "Vega",
//!             "gha_deg": ..., "dec_deg": ..., "sha_deg": ..., "gha_aries_deg": ...}]}
//! ```
//!
//! `"Sun"` cases carry `semidiameter_arcmin` and `horizontal_parallax_arcmin` and are
//! skipped here: this provider does not do the Sun.

use std::path::PathBuf;

use serde::Deserialize;
use skyfix_core::time::parse_utc;
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::stars::StarProvider;

#[derive(Deserialize)]
struct ReferenceFile {
    #[serde(default)]
    schema: String,
    generator: Generator,
    cases: Vec<Epoch>,
}

#[derive(Deserialize)]
struct Generator {
    /// Arcminutes. The fixture states the tolerance it was generated to meet.
    tolerance_arcmin: f64,
}

/// One epoch: every body at one instant. `gha_deg` includes Skyfield's IERS DUT1;
/// `gha_deg_dut1_zero` treats the UTC instant as UT1, which is this project's
/// convention (CONVENTIONS section 6) and the one the USNO almanac service follows.
#[derive(Deserialize)]
struct Epoch {
    utc: String,
    #[serde(default)]
    dut1_s: f64,
    #[serde(default)]
    gha_aries_deg_dut1_zero: Option<f64>,
    bodies: std::collections::BTreeMap<String, Body>,
}

#[derive(Deserialize)]
struct Body {
    gha_deg: f64,
    gha_deg_dut1_zero: f64,
    dec_deg: f64,
    #[serde(default)]
    sha_deg: Option<f64>,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference/geocentric_sun_stars.json")
}

/// Great-circle separation between two geographic positions expressed as
/// (GHA, Dec), in arcminutes. This is the physically meaningful comparison: a GHA
/// difference near the pole is a large angle but a small displacement, and Polaris is
/// in the catalogue. The per-coordinate differences are reported alongside it.
fn separation_arcmin(a: (f64, f64), b: (f64, f64)) -> f64 {
    let v = |(gha, dec): (f64, f64)| {
        let (sg, cg) = gha.to_radians().sin_cos();
        let (sd, cd) = dec.to_radians().sin_cos();
        [cd * cg, cd * sg, sd]
    };
    let (p, q) = (v(a), v(b));
    let d = (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]).clamp(-1.0, 1.0);
    d.acos().to_degrees() * 60.0
}

/// Shortest signed difference between two angles in degrees.
fn wrap180(d: f64) -> f64 {
    (d + 180.0).rem_euclid(360.0) - 180.0
}

#[test]
fn star_directions_match_the_independent_reference_fixture() {
    let path = fixture_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            println!(
                "SKIPPED: no reference fixture at {} ({e}). \
                 This test becomes the authoritative accuracy check once \
                 tools/reference/ emits geocentric_sun_stars.json.",
                path.display()
            );
            return;
        }
    };

    let file: ReferenceFile = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} is not a valid reference file: {e}", path.display()));
    assert_eq!(
        file.schema,
        skyfix_core::types::REFERENCE_SCHEMA,
        "{} has the wrong schema",
        path.display()
    );
    let provider = StarProvider::new();
    let tolerance = file.generator.tolerance_arcmin;
    assert!(
        tolerance > 0.0,
        "{} does not state a usable tolerance_arcmin",
        path.display()
    );
    let mut checked = 0usize;
    let mut skipped_sun = 0usize;
    let mut worst = (0.0f64, String::new());
    let mut worst_dut1 = 0.0f64;
    let mut failures: Vec<String> = Vec::new();

    for epoch in &file.cases {
        let jd_utc = parse_utc(&epoch.utc)
            .unwrap_or_else(|e| panic!("epoch {}: bad timestamp: {e}", epoch.utc));
        // Second provider configured with the fixture's own DUT1: it must reproduce the
        // DUT1-inclusive column, which proves the UT1 path is wired, not just ignored.
        let provider_dut1 = StarProvider::with_dut1(epoch.dut1_s);

        if let Some(aries) = epoch.gha_aries_deg_dut1_zero {
            let d = wrap180(provider.gha_aries_deg(jd_utc) - aries) * 60.0;
            if d.abs() > tolerance {
                failures.push(format!("at {}: GHA Aries differs by {d:+.4}'", epoch.utc));
            }
        }

        for (body, c) in &epoch.bodies {
            if body.eq_ignore_ascii_case("sun") {
                skipped_sun += 1;
                continue;
            }
            let got = match provider.geocentric(body, jd_utc) {
                Ok(d) => d,
                Err(e) => {
                    failures.push(format!("{body} at {}: provider refused: {e}", epoch.utc));
                    continue;
                }
            };
            let sep =
                separation_arcmin((got.gha_deg, got.dec_deg), (c.gha_deg_dut1_zero, c.dec_deg));
            let d_dec = (got.dec_deg - c.dec_deg) * 60.0;
            let d_gha = wrap180(got.gha_deg - c.gha_deg_dut1_zero) * 60.0;
            if sep > worst.0 {
                worst = (sep, format!("{body} at {}", epoch.utc));
            }
            if sep > tolerance || d_dec.abs() > tolerance {
                failures.push(format!(
                    "{body} at {}: separation {sep:.4}' (dGHA {d_gha:+.4}', dDec {d_dec:+.4}') \
                     exceeds tolerance {tolerance:.4}'",
                    epoch.utc
                ));
            }
            if let Ok(with_dut1) = provider_dut1.geocentric(body, jd_utc) {
                let d = wrap180(with_dut1.gha_deg - c.gha_deg) * 60.0;
                worst_dut1 = worst_dut1.max(d.abs());
                if d.abs() > tolerance {
                    failures.push(format!(
                        "{body} at {}: GHA with DUT1 {:+.3} s differs by {d:+.4}'",
                        epoch.utc, epoch.dut1_s
                    ));
                }
            }
            if let Some(sha) = c.sha_deg {
                let ours = provider.sha_deg(body, jd_utc).unwrap();
                let d = wrap180(ours - sha) * 60.0;
                if d.abs() > tolerance {
                    failures.push(format!("{body} at {}: SHA differs by {d:+.4}'", epoch.utc));
                }
            }
            checked += 1;
        }
    }
    println!("worst GHA disagreement with the fixture's own DUT1 applied: {worst_dut1:.5}'");

    println!(
        "reference fixture: {checked} star cases checked ({skipped_sun} Sun cases \
         skipped), tolerance {:.4}', worst separation {:.4}' at {}",
        tolerance, worst.0, worst.1
    );
    assert!(checked > 0, "{} contained no star cases", path.display());
    assert!(
        failures.is_empty(),
        "{} case(s) outside tolerance:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
