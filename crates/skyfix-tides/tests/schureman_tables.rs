//! Node factors and equilibrium arguments against Schureman's printed tables (U.S. Coast
//! and Geodetic Survey Special Publication 98, 1958, public domain), typed from the
//! scanned pages:
//!
//! - Table 14, "Node factor f for middle of each year, 1850 to 1999" (page 203), years
//!   1990-1999, printed to 0.001;
//! - Table 15, "Equilibrium argument (V0 + u) for meridian of Greenwich at beginning of
//!   each calendar year, 1850 to 2000" (page 211), years 1990-1997, printed to 0.1°.
//!
//! These are the tables NOAA's predictions were built on, so they pin the convention
//! (V0 at 0 h GMT on January 1, f and u at mid-year) as well as the formulas.

use skyfix_tides::predict::jd_year_start;
use skyfix_tides::schureman::{constituent, elements, node_args};

/// (row label, NOAA constituents it covers, f for 1990..=1999)
const TABLE_14: &[(&str, &[&str], [f64; 10])] = &[
    (
        "J1",
        &["J1"],
        [
            1.120, 1.080, 1.030, 0.972, 0.914, 0.864, 0.833, 0.829, 0.852, 0.896,
        ],
    ),
    (
        "K1",
        &["K1"],
        [
            1.079, 1.051, 1.015, 0.976, 0.937, 0.905, 0.886, 0.883, 0.897, 0.926,
        ],
    ),
    (
        "K2",
        &["K2"],
        [
            1.203, 1.115, 1.016, 0.922, 0.842, 0.785, 0.754, 0.750, 0.772, 0.821,
        ],
    ),
    (
        "L2",
        &["L2"],
        [
            1.216, 1.248, 0.898, 0.801, 1.077, 1.208, 1.107, 0.921, 0.893, 1.096,
        ],
    ),
    (
        "M1",
        &["M1"],
        [
            1.334, 1.156, 1.778, 1.829, 1.282, 0.800, 1.083, 1.487, 1.560, 1.214,
        ],
    ),
    (
        "M2, N2, 2N, λ2, μ2, ν2 (and MS, 2SM, MSf)",
        &[
            "M2", "N2", "2N2", "LAM2", "MU2", "NU2", "MS4", "2SM2", "MSF",
        ],
        [
            0.977, 0.988, 1.000, 1.013, 1.024, 1.032, 1.037, 1.038, 1.034, 1.027,
        ],
    ),
    (
        "M3",
        &["M3"],
        [
            0.966, 0.982, 1.000, 1.019, 1.036, 1.048, 1.056, 1.057, 1.051, 1.040,
        ],
    ),
    (
        "M4, MN",
        &["M4", "MN4"],
        [
            0.955, 0.976, 1.000, 1.025, 1.048, 1.065, 1.075, 1.076, 1.069, 1.054,
        ],
    ),
    (
        "M6",
        &["M6"],
        [
            0.932, 0.964, 1.000, 1.038, 1.072, 1.099, 1.115, 1.117, 1.105, 1.082,
        ],
    ),
    (
        "M8",
        &["M8"],
        [
            0.911, 0.952, 1.000, 1.051, 1.098, 1.134, 1.156, 1.159, 1.143, 1.111,
        ],
    ),
    (
        "O1, Q1, 2Q, ρ1",
        &["O1", "Q1", "2Q1", "RHO"],
        [
            1.128, 1.081, 1.024, 0.960, 0.897, 0.844, 0.812, 0.808, 0.832, 0.879,
        ],
    ),
    (
        "OO",
        &["OO1"],
        [
            1.505, 1.296, 1.072, 0.863, 0.688, 0.565, 0.498, 0.489, 0.538, 0.643,
        ],
    ),
    (
        "MK",
        &["MK3"],
        [
            1.054, 1.038, 1.015, 0.988, 0.959, 0.934, 0.918, 0.916, 0.928, 0.950,
        ],
    ),
    (
        "2MK",
        &["2MK3"],
        [
            1.030, 1.025, 1.015, 1.000, 0.982, 0.964, 0.952, 0.951, 0.959, 0.976,
        ],
    ),
    (
        "Mf",
        &["MF"],
        [
            1.303, 1.184, 1.048, 0.910, 0.786, 0.691, 0.636, 0.629, 0.669, 0.752,
        ],
    ),
    (
        "Mm",
        &["MM"],
        [
            0.918, 0.956, 0.998, 1.042, 1.081, 1.110, 1.128, 1.130, 1.117, 1.091,
        ],
    ),
];

/// (NOAA name, V0 + u for 1990..=1997)
const TABLE_15: &[(&str, [f64; 8])] = &[
    ("J1", [314.4, 45.2, 135.2, 237.9, 325.0, 50.2, 134.0, 231.1]),
    ("K1", [16.7, 18.0, 18.7, 19.4, 18.0, 15.6, 12.2, 9.5]),
    (
        "K2",
        [213.9, 216.6, 217.6, 218.5, 215.4, 210.3, 204.0, 199.2],
    ),
    ("L2", [2.2, 212.4, 49.0, 205.8, 30.4, 229.4, 66.7, 242.7]),
    ("M2", [259.4, 0.5, 101.3, 177.6, 278.0, 18.2, 118.3, 194.0]),
    ("M3", [29.1, 0.7, 332.0, 266.4, 237.0, 207.3, 177.4, 110.9]),
    ("M4", [158.7, 0.9, 202.7, 355.2, 196.0, 36.4, 236.6, 27.9]),
    ("M6", [58.1, 1.4, 304.0, 172.8, 114.0, 54.6, 354.9, 221.9]),
    ("M8", [317.5, 1.9, 45.3, 350.3, 31.9, 72.8, 113.2, 55.8]),
    (
        "N2",
        [324.3, 336.7, 348.8, 323.3, 334.9, 346.4, 357.8, 331.7],
    ),
    (
        "2N2",
        [29.2, 312.8, 236.3, 108.9, 31.9, 314.6, 237.3, 109.4],
    ),
    (
        "O1",
        [240.1, 339.0, 78.7, 154.0, 256.1, 359.7, 104.8, 185.2],
    ),
    (
        "OO1",
        [338.4, 243.8, 146.6, 73.2, 327.7, 217.2, 102.3, 12.5],
    ),
    (
        "P1",
        [349.6, 349.8, 350.1, 349.3, 349.6, 349.8, 350.1, 349.3],
    ),
    (
        "Q1",
        [305.0, 315.2, 326.1, 299.7, 313.0, 327.9, 344.3, 322.9],
    ),
    ("2Q1", [9.9, 291.4, 213.6, 85.4, 10.0, 296.2, 223.8, 100.6]),
    (
        "R2",
        [177.6, 177.4, 177.1, 177.8, 177.6, 177.3, 177.1, 177.8],
    ),
    (
        "S1",
        [180.0, 180.0, 180.0, 180.0, 180.0, 180.0, 180.0, 180.0],
    ),
    ("S2", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    ("S4", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    ("S6", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    ("T2", [2.4, 2.6, 2.9, 2.2, 2.4, 2.7, 2.9, 2.2]),
    (
        "LAM2",
        [246.6, 158.2, 69.6, 327.7, 238.6, 149.4, 60.0, 317.5],
    ),
    (
        "MU2",
        [157.1, 358.9, 200.5, 353.2, 194.3, 35.3, 236.1, 28.2],
    ),
    ("NU2", [92.2, 22.7, 313.1, 207.5, 137.4, 67.0, 356.6, 250.4]),
    ("RHO", [72.9, 1.3, 290.4, 183.9, 115.4, 48.6, 343.1, 241.6]),
    (
        "MK3",
        [276.0, 18.5, 120.0, 197.0, 296.0, 33.8, 130.5, 203.4],
    ),
    (
        "2MK3",
        [142.1, 342.9, 184.0, 335.8, 177.9, 20.8, 224.4, 18.4],
    ),
    ("MN4", [223.6, 337.1, 90.1, 140.8, 252.9, 4.6, 116.1, 165.6]),
    ("MS4", [259.4, 0.5, 101.3, 177.6, 278.0, 18.2, 118.3, 194.0]),
    (
        "2SM2",
        [100.6, 359.5, 258.7, 182.4, 82.0, 341.8, 241.7, 166.0],
    ),
    ("MF", [319.2, 222.4, 124.0, 49.6, 305.9, 198.8, 88.8, 3.7]),
    (
        "MSF",
        [100.6, 359.5, 258.7, 182.4, 82.0, 341.8, 241.7, 166.0],
    ),
    ("MM", [295.1, 23.8, 112.5, 214.3, 303.0, 31.8, 120.5, 222.3]),
    (
        "SA",
        [280.4, 280.2, 279.9, 280.7, 280.4, 280.2, 279.9, 280.7],
    ),
    (
        "SSA",
        [200.8, 200.3, 199.8, 201.3, 200.8, 200.4, 199.9, 201.4],
    ),
];

fn mid_year_node(year: i32) -> skyfix_tides::schureman::NodeArgs {
    let jd_mid = 0.5 * (jd_year_start(year) + jd_year_start(year + 1));
    let e = elements(jd_mid);
    node_args(e.n, e.p)
}

fn wrap180(x: f64) -> f64 {
    let r = x.rem_euclid(360.0);
    if r > 180.0 { r - 360.0 } else { r }
}

#[test]
fn node_factors_match_table_14() {
    let mut worst = (0.0f64, String::new());
    for (label, names, values) in TABLE_14 {
        for (k, want) in values.iter().enumerate() {
            let year = 1990 + k as i32;
            let nod = mid_year_node(year);
            for name in *names {
                let c = constituent(name).unwrap();
                let (f, _) = c.node(&nod);
                let d = f - want;
                if d.abs() > worst.0.abs() {
                    worst = (d, format!("{name} ({label}) {year}: {f:.4} vs {want}"));
                }
                // Printed to 0.001. Schureman built the 1951-1999 columns from tables of
                // log F per 0.1° of I (Tables 12 and 13), so the rarer composite factors
                // differ by up to 0.3 % (M1, whose factor also depends on P, by 1 %):
                // under 0.2 mm of height at any NOAA station.
                let tol = match *name {
                    "M1" => 0.009,
                    "K2" | "L2" | "OO1" => 0.004,
                    _ => 0.0011,
                };
                assert!(
                    d.abs() <= tol,
                    "{name} ({label}) {year}: f = {f:.4}, Table 14 {want}"
                );
            }
        }
    }
    eprintln!("Table 14 worst: {:+.4} at {}", worst.0, worst.1);
}

#[test]
fn equilibrium_arguments_match_table_15() {
    let mut worst = (0.0f64, String::new());
    for (name, values) in TABLE_15 {
        let c = constituent(name).unwrap();
        for (k, want) in values.iter().enumerate() {
            let year = 1990 + k as i32;
            let e0 = elements(jd_year_start(year));
            let (_, u) = c.node(&mid_year_node(year));
            let got = (c.v_deg(&e0) + u.to_degrees()).rem_euclid(360.0);
            let d = wrap180(got - want);
            if d.abs() > worst.0.abs() {
                worst = (d, format!("{name} {year}: {got:.2} vs {want}"));
            }
            // Printed to 0.1°; the table's elements are Schureman's, as ours are.
            assert!(
                d.abs() <= 0.16,
                "{name} {year}: V0 + u = {got:.2}, Table 15 {want}"
            );
        }
    }
    eprintln!("Table 15 worst: {:+.3}° at {}", worst.0, worst.1);
}

/// M1: Table 15 prints V0 + u of formula 201 (V = T − s + h − 90°, u = ξ − ν + Q), which
/// is the V0 + u this crate uses (advanced at NOAA's speed 14.4966939°/h, formula 194's).
#[test]
fn m1_matches_table_15() {
    let values = [85.9, 33.5, 305.0, 184.1, 79.3, 4.9, 293.5, 176.9];
    let c = constituent("M1").unwrap();
    for (k, want) in values.iter().enumerate() {
        let year = 1990 + k as i32;
        let e0 = elements(jd_year_start(year));
        let (_, u) = c.node(&mid_year_node(year));
        let got = (c.v_deg(&e0) + u.to_degrees()).rem_euclid(360.0);
        let d = wrap180(got - want);
        // Within 0.5°: Table 10's Q is tabulated per degree of P (0.07 mm of height at
        // NOAA's largest M1).
        assert!(d.abs() <= 0.5, "M1 {year}: {got:.2} vs Table 15 {want}");
    }
}
