//! Rigil Kentaurus (alpha Centauri A) against measured positions (verify2, 2026-09-25).
//!
//! The Nautical Almanac and USNO's celnav extrapolate A's 1991 Hipparcos place in a
//! straight line; this provider follows A's orbit about the A-B barycentre instead
//! (`catalog::StarEntry::barycentric_direction`). Which is closer to the sky? ALMA
//! measured A's absolute ICRS position, phase-referenced to quasars, nine times in
//! 2018-2019 (Akeson et al. 2021, *AJ* 162, 14, Table 2 "Measured positions in ICRS";
//! 0.4-7 mas; arXiv:2104.10086). Those positions are astrometric: A's direction from the
//! Earth with annual parallax, without aberration or deflection, which cancel against
//! the quasars. So the test adds only annual parallax to the provider's barycentric
//! direction, and compares in the frame of date (a rotation leaves separations alone).
//!
//! Measured on 2026-09-25: the orbit model is 0.10-0.13" from ALMA at every epoch; the
//! straight line is 4.4-4.6" off. The remaining 0.1" is the barycentre (the catalogue's
//! 1991 place and proper motion of A less its orbital velocity; Akeson et al.'s own
//! barycentre moves 5 mas/yr differently).

use skyfix_core::time::{civil_to_jd, jd_tt};
use skyfix_core::units::ARCSEC;
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::frames::{
    apply_annual_parallax, bias_precession_nutation_matrix, earth_state_of_date,
    unit_vector_from_radec,
};

/// (UTC year, month, day, hour, minute, second), RA and Dec of A (degrees, ICRS),
/// from Akeson et al. (2021) Table 2.
const ALMA: [((i32, u32, u32, f64, f64, f64), f64, f64); 9] = [
    (
        (2018, 10, 14, 13.0, 38.0, 19.0),
        219.860_763_250,
        -60.832_171_539,
    ),
    (
        (2019, 7, 15, 23.0, 14.0, 41.3),
        219.858_859_933,
        -60.832_264_944,
    ),
    (
        (2019, 7, 16, 1.0, 15.0, 31.1),
        219.858_854_542,
        -60.832_262_378,
    ),
    (
        (2019, 7, 19, 23.0, 31.0, 14.5),
        219.858_829_571,
        -60.832_252_293,
    ),
    (
        (2019, 7, 20, 1.0, 2.0, 29.9),
        219.858_827_083,
        -60.832_253_354,
    ),
    (
        (2019, 8, 12, 23.0, 10.0, 35.2),
        219.858_667_583,
        -60.832_185_858,
    ),
    (
        (2019, 8, 13, 0.0, 44.0, 57.6),
        219.858_669_208,
        -60.832_186_997,
    ),
    (
        (2019, 8, 25, 23.0, 33.0, 45.5),
        219.858_615_833,
        -60.832_153_722,
    ),
    (
        (2019, 8, 26, 20.0, 7.0, 30.6),
        219.858_613_375,
        -60.832_152_358,
    ),
];

fn mul(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn separation_arcsec(a: [f64; 3], b: [f64; 3]) -> f64 {
    let c = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    s.atan2(d) / ARCSEC
}

#[test]
fn rigil_kentaurus_on_its_orbit_matches_alma_and_the_straight_line_does_not() {
    let a = catalog::find("Rigil Kentaurus").expect("alpha Cen A");
    // The Almanac's model: the catalogue's own proper motion in a straight line.
    let mut line = a.clone();
    line.orbit = None;
    line.bary_pm_ra_cosdec_mas_per_year = a.pm_ra_cosdec_mas_per_year;
    line.bary_pm_dec_mas_per_year = a.pm_dec_mas_per_year;

    let (mut worst_orbit, mut best_line) = (0.0_f64, f64::INFINITY);
    for ((y, mo, d, h, mi, s), ra, dec) in ALMA {
        let jd_utc = civil_to_jd(y, mo, d) + (h + mi / 60.0 + s / 3600.0) / 24.0;
        let t = jd_tt(jd_utc);
        let m = bias_precession_nutation_matrix(t);
        let earth = earth_state_of_date(t).pos_au;
        let seen = |p: [f64; 3]| apply_annual_parallax(mul(&m, p), a.parallax_mas, earth);
        let alma = mul(&m, unit_vector_from_radec(ra, dec));
        let orbit = separation_arcsec(seen(a.barycentric_direction(t)), alma);
        let straight = separation_arcsec(seen(line.barycentric_direction(t)), alma);
        println!("{y}-{mo:02}-{d:02}: orbit {orbit:.3}\", straight line {straight:.3}\"");
        worst_orbit = worst_orbit.max(orbit);
        best_line = best_line.min(straight);
    }
    // 0.13" measured; the bound leaves room for a better barycentre, not for a model
    // that has lost the orbit (4.4" and more).
    assert!(
        worst_orbit < 0.25,
        "orbit model {worst_orbit:.3}\" from ALMA"
    );
    assert!(best_line > 4.0, "straight line {best_line:.3}\" from ALMA");
}
