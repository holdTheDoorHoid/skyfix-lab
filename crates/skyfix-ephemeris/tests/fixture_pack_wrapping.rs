//! Interpolating GHA across the 360/0 seam.
//!
//! This is the failure the brief calls out by name: "interpolate angles correctly
//! across wrapping". A table that reads 359, 1, 3 must interpolate to 0, not to 180.

use std::collections::BTreeMap;

use skyfix_core::time::parse_utc;
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::fixture_pack::{
    ALMANAC_PACK_SCHEMA, AlmanacPack, BodyTable, FixturePackProvider,
};

const START: &str = "2026-10-01T00:00:00Z";

/// A body whose GHA is exactly `gha0 + rate * hours`, sampled hourly for `n` hours.
fn linear_pack(
    gha0: f64,
    rate_deg_per_h: f64,
    dec0: f64,
    dec_rate: f64,
    n: u32,
) -> FixturePackProvider {
    let mut bodies = BTreeMap::new();
    bodies.insert(
        "Moon".to_string(),
        BodyTable {
            step_s: 3600.0,
            start_utc: START.to_string(),
            rows: (0..n)
                .map(|i| {
                    let t = f64::from(i);
                    [
                        norm_360(gha0 + rate_deg_per_h * t),
                        dec0 + dec_rate * t,
                        15.0,
                        55.0,
                    ]
                })
                .collect(),
        },
    );
    let pack = AlmanacPack {
        schema: ALMANAC_PACK_SCHEMA.to_string(),
        provider: "wrap-test".to_string(),
        generator: serde_json::Value::Null,
        bodies,
        notes: String::new(),
    };
    FixturePackProvider::from_json(&serde_json::to_string(&pack).unwrap()).unwrap()
}

/// Exact answer for the table above, before normalisation.
fn truth(gha0: f64, rate: f64, hours: f64) -> f64 {
    norm_360(gha0 + rate * hours)
}

/// The seam sits inside an interpolation interval and inside a 4-point stencil. Both
/// paths must cross it without a 180 deg excursion.
#[test]
fn gha_interpolates_through_the_360_seam() {
    // Start at 350 deg and advance 14.4921 deg/h (a lunar rate), so the seam is crossed
    // in the interval [0, 1] and again, further in, well inside the cubic region.
    let rate = 14.4921;
    let p = linear_pack(350.0, rate, 10.0, 0.2, 40);
    let start = parse_utc(START).unwrap();

    let mut worst = 0.0f64;
    let mut worst_at = 0.0;
    for i in 0..(39 * 20) {
        let hours = f64::from(i) / 20.0;
        let jd = start + hours / 24.0;
        let got = p.geocentric("Moon", jd).unwrap().gha_deg;
        let want = truth(350.0, rate, hours);
        let d = norm_180(got - want).abs();
        if d > worst {
            worst = d;
            worst_at = hours;
        }
        assert!(
            (0.0..360.0).contains(&got),
            "GHA {got} left [0, 360) at hour {hours}"
        );
    }
    // The signal is exactly linear, so both linear and cubic interpolation reproduce it
    // to rounding. Anything near 180 deg would mean the seam was averaged through.
    assert!(
        worst * 3600.0 < 0.01,
        "worst GHA error {worst:.9} deg at hour {worst_at}; \
         a value near 180 deg means the 360 seam was interpolated through"
    );
}

/// The specific numbers from the brief: a table containing 359 and 1 must not produce
/// anything near 180.
#[test]
fn three_fifty_nine_and_one_never_average_to_one_eighty() {
    let p = linear_pack(359.0, 2.0, 0.0, 0.0, 8);
    let start = parse_utc(START).unwrap();
    // Rows are 359, 1, 3, 5, ... The first interval is linear, later ones cubic.
    let mid = p.geocentric("Moon", start + 0.5 / 24.0).unwrap().gha_deg;
    assert!(
        (mid - 0.0).abs() < 1e-6 || (mid - 360.0).abs() < 1e-6,
        "the midpoint of 359 and 1 is 0, got {mid}"
    );
    assert!(
        (mid - 180.0).abs() > 179.0,
        "{mid} is the wrong-way average of 359 and 1"
    );
    // And a cubic-region sample between rows 3 and 5.
    let q = p.geocentric("Moon", start + 2.5 / 24.0).unwrap().gha_deg;
    assert!((q - 4.0).abs() < 1e-6, "expected 4 deg, got {q}");
}

/// The same body seen as a geographic position: GHA near 180 puts the GP's longitude
/// on the date line, where `lon_gp_east = normalise(-GHA)` flips sign
/// (CONVENTIONS section 2). Nothing in the GHA table wraps there, so the interpolation
/// must stay smooth straight through it.
#[test]
fn the_geographic_position_crosses_the_date_line_smoothly() {
    let rate = 14.4921;
    let p = linear_pack(170.0, rate, -20.0, 0.3, 12);
    let start = parse_utc(START).unwrap();

    let mut prev_lon: Option<f64> = None;
    let mut crossings = 0;
    for i in 0..(11 * 20) {
        let hours = f64::from(i) / 20.0;
        let got = p.geocentric("Moon", start + hours / 24.0).unwrap().gha_deg;
        let want = truth(170.0, rate, hours);
        assert!(
            norm_180(got - want).abs() * 3600.0 < 0.01,
            "GHA error {:.6}\" at hour {hours}",
            norm_180(got - want) * 3600.0
        );
        // GP longitude, east positive.
        let lon = norm_180(-got);
        if let Some(prev) = prev_lon {
            // A date-line crossing is a jump in the *reported* longitude, but the step
            // the short way round must stay small: the body moved 0.72 deg in 3 min.
            let step = norm_180(lon - prev).abs();
            assert!(
                step < 1.0,
                "GP longitude jumped {step} deg between samples at hour {hours}"
            );
            if (lon - prev).abs() > 180.0 {
                crossings += 1;
            }
        }
        prev_lon = Some(lon);
    }
    assert!(
        crossings >= 1,
        "this table was built to cross the date line at least once"
    );
}

/// Declination, semidiameter and parallax must NOT be unwrapped: they are not angles
/// on a circle. A table whose declination goes +80, -80 is a real 160 deg change and
/// must interpolate straight through zero, not the short way round the sphere.
#[test]
fn declination_is_never_unwrapped() {
    let mut bodies = BTreeMap::new();
    bodies.insert(
        "Moon".to_string(),
        BodyTable {
            step_s: 3600.0,
            start_utc: START.to_string(),
            rows: vec![
                [0.0, 80.0, 15.0, 55.0],
                [10.0, -80.0, 15.0, 55.0],
                [20.0, 80.0, 15.0, 55.0],
            ],
        },
    );
    let pack = AlmanacPack {
        schema: ALMANAC_PACK_SCHEMA.to_string(),
        provider: "dec-test".to_string(),
        generator: serde_json::Value::Null,
        bodies,
        notes: String::new(),
    };
    let p = FixturePackProvider::from_json(&serde_json::to_string(&pack).unwrap()).unwrap();
    let start = parse_utc(START).unwrap();
    let mid = p.geocentric("Moon", start + 0.5 / 24.0).unwrap().dec_deg;
    assert!(
        mid.abs() < 1e-6,
        "the midpoint of +80 and -80 declination is 0, got {mid}; \
         unwrapping would have produced +100"
    );
}

/// GHA is renormalised to `[0, 360)` on the way out even when the unwrapped
/// interpolation ran negative or past a turn.
#[test]
fn output_is_always_normalised() {
    for gha0 in [0.0, 179.0, 180.0, 181.0, 359.9] {
        for rate in [-14.4921, -0.1, 0.1, 14.4921] {
            let p = linear_pack(gha0, rate, 0.0, 0.0, 10);
            let start = parse_utc(START).unwrap();
            for i in 0..(9 * 7) {
                let jd = start + f64::from(i) / 7.0 / 24.0;
                let g = p.geocentric("Moon", jd).unwrap().gha_deg;
                assert!(
                    (0.0..360.0).contains(&g),
                    "GHA {g} outside [0, 360) for start {gha0} rate {rate}"
                );
            }
        }
    }
}
