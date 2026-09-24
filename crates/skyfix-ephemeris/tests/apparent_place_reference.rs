//! The apparent-place chain, against two independent published worked examples.
//!
//! - Meeus, *Astronomical Algorithms* 2nd ed., example 23.a (p. 152): theta Persei on
//!   2028 November 13.19 TD. Meeus works in FK5/IAU 1976/IAU 1980; this module is
//!   ICRS/IAU 2006/IAU 2000B, so the published answer is reproduced to about 0.1",
//!   not exactly. The task's tolerance for this case is 1".
//! - ERFA 2.0 `t_erfa_c.c`, `t_atci13`: a full ICRS-to-apparent reduction with proper
//!   motion, parallax, radial velocity, light deflection and aberration, computed with
//!   IAU 2000A nutation and the JPL-grade `eraEpv00` Earth ephemeris. Converting its
//!   CIRS result to the equinox of date gives an independent check of everything this
//!   crate does, at a precision the Meeus example cannot reach.
//!
//! Sources and licences: `docs/THIRD_PARTY.md`.

// Published reference values are transcribed verbatim, digits and all.
#![allow(clippy::excessive_precision)]

use skyfix_ephemeris::frames::apparent_radec_of_date;

const DEG: f64 = std::f64::consts::PI / 180.0;

/// Great-circle separation between two (ra, dec) pairs, arcseconds.
fn separation_arcsec(a: (f64, f64), b: (f64, f64)) -> f64 {
    let v = |(ra, dec): (f64, f64)| {
        let (sa, ca) = (ra * DEG).sin_cos();
        let (sd, cd) = (dec * DEG).sin_cos();
        [cd * ca, cd * sa, sd]
    };
    let (p, q) = (v(a), v(b));
    let d = (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]).clamp(-1.0, 1.0);
    d.acos() / DEG * 3600.0
}

/// Meeus example 23.a: theta Persei, ICRS/FK5 J2000 place 2h44m11.986s +49d13'42.48",
/// proper motion +0.03425 s/yr in RA and -0.0895"/yr in declination, at
/// 2028 November 13.19 TD (JDE 2462088.69). Published apparent place:
/// 2h46m14.390s, +49d21'07.45".
#[test]
fn meeus_example_23a_apparent_place_within_one_arcsecond() {
    let jd_tt = 2_462_088.69;
    let ra0 = (2.0 + 44.0 / 60.0 + 11.986 / 3600.0) * 15.0;
    let dec0 = 49.0 + 13.0 / 60.0 + 42.48 / 3600.0;
    // Meeus tabulates dRA/dt in seconds of time per year, not mu_alpha*.
    let pm_ra_cosdec_mas_yr = 0.034_25 * 15.0 * (dec0 * DEG).cos() * 1000.0;
    let pm_dec_mas_yr = -0.0895 * 1000.0;
    // Meeus's worked example does not apply annual parallax.
    let got = apparent_radec_of_date(ra0, dec0, pm_ra_cosdec_mas_yr, pm_dec_mas_yr, 0.0, jd_tt);

    let want = (
        (2.0 + 46.0 / 60.0 + 14.390 / 3600.0) * 15.0,
        49.0 + 21.0 / 60.0 + 7.45 / 3600.0,
    );
    let sep = separation_arcsec(got, want);
    let d_ra_s = (got.0 - want.0) / 15.0 * 3600.0;
    let d_dec_as = (got.1 - want.1) * 3600.0;
    println!("Meeus 23.a agreement: {sep:.4} arcsec (dRA {d_ra_s:+.4}s, dDec {d_dec_as:+.3}\")");
    assert!(
        sep < 1.0,
        "apparent place off by {sep:.3}\" (dRA {d_ra_s:+.4}s, dDec {d_dec_as:+.3}\"); \
         got {:.6} {:.6}, published {:.6} {:.6}",
        got.0,
        got.1,
        want.0,
        want.1
    );
}

/// ERFA `eraAtci13(rc=2.71, dc=0.174, pr=1e-5, pd=5e-6, px=0.1, rv=55.0,
/// 2456165.5, 0.401182685)` gives CIRS `ri = 2.710121572968696744`,
/// `di = 0.1729371367219539137` and the equation of the origins
/// `eo = -0.002900618712657375647` (all radians).
///
/// The equation of the origins is `ERA - GST`, and the hour angle of a body is both
/// `GST - RA(equinox)` and `ERA - RA(CIRS)`, so `RA(equinox) = RA(CIRS) - eo`. That
/// turns this published CIO-based value into a direct check of the equinox-based
/// apparent place this crate computes.
///
/// Remaining differences are the deliberate model choices, and this test pins how big
/// they are: IAU 2000B instead of 2000A nutation, a Keplerian Earth velocity instead
/// of `eraEpv00`, and no radial velocity in the space motion.
#[test]
fn full_chain_matches_erfa_atci13() {
    let jd_tt = 2_456_165.5 + 0.401_182_685;
    let ra_icrs = 2.71 / DEG;
    let dec_icrs = 0.174 / DEG;
    // ERFA's `pr` is dRA/dt, not mu_alpha*; convert, and radians/yr -> mas/yr.
    let mas_per_rad = 1.0 / DEG * 3600.0 * 1000.0;
    let pm_ra_cosdec_mas_yr = 1e-5 * 0.174f64.cos() * mas_per_rad;
    let pm_dec_mas_yr = 5e-6 * mas_per_rad;
    let parallax_mas = 0.1 * 1000.0;

    let got = apparent_radec_of_date(
        ra_icrs,
        dec_icrs,
        pm_ra_cosdec_mas_yr,
        pm_dec_mas_yr,
        parallax_mas,
        jd_tt,
    );

    let ri = 2.710_121_572_968_696_744;
    let di = 0.172_937_136_721_953_914;
    let eo = -0.002_900_618_712_657_375_6;
    let want = ((ri - eo) / DEG, di / DEG);

    let sep = separation_arcsec(got, want);
    assert!(
        sep < 0.05,
        "apparent place differs from eraAtci13 by {sep:.4}\"; got {:.9} {:.9}, \
         expected {:.9} {:.9}",
        got.0,
        got.1,
        want.0,
        want.1
    );
    // Record the achieved agreement so a regression is visible in the test output.
    println!(
        "eraAtci13 agreement: {sep:.4} arcsec ({:.6} arcmin)",
        sep / 60.0
    );
}

/// Aberration is the largest of the small corrections; removing it must move the place
/// by up to 20.5" and no more. This guards against the correction silently vanishing.
#[test]
fn the_small_corrections_are_actually_applied() {
    use skyfix_ephemeris::frames::{
        apply_annual_aberration, apply_annual_parallax, apply_solar_light_deflection,
        bias_precession_nutation_matrix, earth_state_of_date, proper_motion_from_j2000,
        radec_from_vector,
    };
    let jd_tt = 2_460_000.5;
    // Rigil Kentaurus: the largest parallax in the catalogue, 742 mas.
    let star = skyfix_ephemeris::catalog::find("Rigil Kentaurus").unwrap();
    let p = proper_motion_from_j2000(
        star.ra_j2000_deg,
        star.dec_j2000_deg,
        star.pm_ra_cosdec_mas_per_year,
        star.pm_dec_mas_per_year,
        jd_tt,
    );
    let m = bias_precession_nutation_matrix(jd_tt);
    let rotate = |v: [f64; 3]| {
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    };
    let base = rotate(p);
    let earth = earth_state_of_date(jd_tt);

    let with_parallax = apply_annual_parallax(base, star.parallax_mas, earth.pos_au);
    let dp = separation_arcsec(radec_from_vector(base), radec_from_vector(with_parallax));
    assert!(
        dp > 0.1 && dp < 0.80,
        "parallax moved Rigil Kentaurus {dp}\", expected up to 0.74\""
    );

    let with_deflection = apply_solar_light_deflection(with_parallax, earth.pos_au);
    let dd = separation_arcsec(
        radec_from_vector(with_parallax),
        radec_from_vector(with_deflection),
    );
    assert!(dd < 0.3, "light deflection moved the star {dd}\"");

    let with_aberration = apply_annual_aberration(with_deflection, earth.vel_c);
    let da = separation_arcsec(
        radec_from_vector(with_deflection),
        radec_from_vector(with_aberration),
    );
    assert!(
        da > 1.0 && da <= 20.6,
        "aberration moved the star {da}\", expected up to 20.5\""
    );
}
