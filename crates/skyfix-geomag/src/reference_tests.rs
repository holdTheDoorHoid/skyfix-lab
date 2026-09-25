//! Checks that need the crate's internals: the WMM2025 technical report's numerical
//! example step by step (Tables 3a-3b), and IAGA's own IGRF-14 test values, which are
//! geocentric (colatitude, longitude, radius) rather than geodetic. The fixtures are
//! `fixtures/reference/geomag_{wmm2025,igrf14}.json` (tools/geomag/gen_fixtures.py).

use crate::models::{igrf14_at, wmm2025_at};
use crate::sh::{Spherical, geodetic_to_spherical, synthesize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/reference/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn num(v: &Value, k: &str) -> f64 {
    v[k].as_f64()
        .unwrap_or_else(|| panic!("{k} missing in {v}"))
}

#[test]
fn the_numerical_example_matches_step_by_step() {
    let fx = fixture("geomag_wmm2025.json");
    let e = &fx["numerical_example"];
    // Step 1: geodetic to geocentric (Table 3b rows 5-6).
    let at = geodetic_to_spherical(
        num(e, "phi_rad"),
        num(e, "lambda_rad"),
        num(e, "height_km") * 1000.0,
    );
    assert!((at.lat_rad() - num(e, "phi_prime_rad")).abs() < 1e-10);
    assert!((at.r_m - num(e, "r_m")).abs() < 1e-6, "{}", at.r_m);
    // Step 2: the coefficients at 2027.5 (rows 7-16).
    let g = wmm2025_at(num(e, "year"));
    for (key, v) in [
        ("g10_nt", g.g[1][0]),
        ("g11_nt", g.g[1][1]),
        ("g20_nt", g.g[2][0]),
        ("g21_nt", g.g[2][1]),
        ("g22_nt", g.g[2][2]),
        ("h11_nt", g.h[1][1]),
        ("h21_nt", g.h[2][1]),
        ("h22_nt", g.h[2][2]),
    ] {
        assert!((v - num(e, key)).abs() < 1e-9, "{key}: {v}");
    }
    // Step 3: geocentric components and their rates (rows 17-22).
    let (v, v_dot) = synthesize(&g, &at);
    for (k, ours) in [
        ("xprime_nt", v[0]),
        ("yprime_nt", v[1]),
        ("zprime_nt", v[2]),
        ("xprime_dot_nt_per_year", v_dot[0]),
        ("yprime_dot_nt_per_year", v_dot[1]),
        ("zprime_dot_nt_per_year", v_dot[2]),
    ] {
        assert!(
            (ours - num(e, k)).abs() < 1e-6,
            "{k}: {ours} vs {}",
            num(e, k)
        );
    }
}

#[test]
fn iagas_own_igrf14_test_values_are_reproduced() {
    // pyIGRF14/tests/tests_igrf14.py (IAGA V-MOD): geocentric X = -B_theta, Y = B_phi,
    // Z = -B_r at a radius in km, to 0.01 nT, from 1900 to 2030 (2030 = 2025 + 5 years of
    // the predictive secular variation). The package's SHC file holds exactly the numbers
    // of igrf14coeffs.txt (checked at development time).
    let fx = fixture("geomag_igrf14.json");
    let cases = fx["iaga_pyigrf14"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    let mut worst: f64 = 0.0;
    for c in cases {
        let at = Spherical::from_colatitude(
            num(c, "colatitude_deg"),
            num(c, "lon_deg"),
            num(c, "radius_km") * 1000.0,
        );
        let (v, _) = synthesize(&igrf14_at(num(c, "year")), &at);
        for (i, k) in ["x_nt", "y_nt", "z_nt"].iter().enumerate() {
            let d = v[i] - num(c, k);
            worst = worst.max(d.abs());
            // Printed to 0.01 nT: rounded for 1900-2005, cut off (truncated) for
            // 2010-2030 (17529.4899 is printed 17529.48), so every digit agrees when the
            // difference is under 0.01 nT. IAGA's own test allows 1 % or 0.01 nT.
            assert!(d.abs() < 0.01, "{c}: {k} {} vs {}", v[i], num(c, k));
        }
    }
    println!("IGRF-14 against IAGA's twelve test values: worst |diff| {worst:.4} nT");
}
