//! Published reference values for the Earth-orientation chain.
//!
//! Every expected value in this file is a *published* number, not something this
//! workspace produced. Sources:
//!
//! - ERFA 2.0.1 validation suite `src/t_erfa_c.c` (BSD 3-clause; the values are those
//!   of the IAU SOFA `t_sofa_c.c` test program, which ERFA reproduces exactly).
//!   Retrieved 2026-09-23; see `docs/THIRD_PARTY.md`.
//! - USNO / SOFA: GMST at 2000-01-01 12:00 UT1 = 18h 41m 50.548s.
//!
//! ERFA's two-part Julian dates carry more precision than the single `f64` this
//! workspace uses, so tolerances here are 1e-11 rad (0.002") rather than the 1e-12 rad
//! the published suite asserts. All the epochs below are exactly representable.

// The expected values below are transcribed digit-for-digit from the published
// reference suite so they can be diffed against it; some carry more digits than an
// `f64` holds, which is exactly what `excessive_precision` complains about.
#![allow(clippy::excessive_precision)]

use skyfix_ephemeris::frames::{
    equation_of_equinoxes_rad, fukushima_williams_2006, mean_obliquity_rad, nutation_2000b,
};
use skyfix_ephemeris::sidereal::{era_deg, gast_deg, gmst_deg};

/// Radians per degree.
const DEG: f64 = std::f64::consts::PI / 180.0;
const ARCSEC: f64 = std::f64::consts::PI / 648_000.0;

/// MJD 53736 -> JD 2453736.5 (2005-12-31), the epoch of most ERFA test values.
const JD_53736: f64 = 2_400_000.5 + 53_736.0;
/// MJD 54388 -> JD 2454388.5 (2007-10-13).
const JD_54388: f64 = 2_400_000.5 + 54_388.0;
/// The `eraPfw06` test epoch, JD 2450123.9999 (1996-02-10).
const JD_PFW: f64 = 2_400_000.5 + 50_123.999_9;

fn assert_close(got: f64, want: f64, tol: f64, what: &str) {
    let d = got - want;
    assert!(
        d.abs() <= tol,
        "{what}: got {got:.18}, want {want:.18}, diff {d:.3e} > {tol:.1e}"
    );
}

/// `eraEra00(2400000.5, 54388.0) = 0.4022837240028158102 rad`.
#[test]
fn earth_rotation_angle_matches_erfa() {
    assert_close(
        era_deg(JD_54388) * DEG,
        0.402_283_724_002_815_81,
        1e-11,
        "ERA",
    );
}

/// `eraGmst06(2400000.5, 53736.0, 2400000.5, 53736.0) = 1.754174971870091203 rad`.
#[test]
fn gmst_matches_erfa_gmst06() {
    assert_close(
        gmst_deg(JD_53736, JD_53736) * DEG,
        1.754_174_971_870_091_2,
        1e-11,
        "GMST06",
    );
}

/// `eraGst06a(2400000.5, 53736.0, 2400000.5, 53736.0) = 1.754166137675019159 rad`.
///
/// `eraGst06a` uses IAU 2000A nutation and the CIO-based route; this implementation
/// uses IAU 2000B and the equinox-based route. Both differences are deliberate. The
/// 2000A/2000B difference in `dpsi` at this epoch is 1.6e-9 rad, so the tolerance here
/// is 5e-9 rad (0.001") — and the assertion is that nothing *else* differs.
#[test]
fn gast_matches_erfa_gst06a_to_the_2000a_2000b_difference() {
    assert_close(
        gast_deg(JD_53736, JD_53736) * DEG,
        1.754_166_137_675_019_2,
        5e-9,
        "GAST vs eraGst06a",
    );
}

/// `eraNut00b(2400000.5, 53736.0)` = dpsi -0.9632552291148362783e-5 rad,
/// deps 0.4063197106621159367e-4 rad.
///
/// `eraNut00b` evaluates the 77 terms with the *linear* fundamental arguments that
/// IAU 2000B is published with; `frames::nutation_2000b` uses the full Simon et al.
/// polynomials (so that the series stays within 3 mas of IAU 2000A over 2000 BC to
/// AD 3000, CONVENTIONS section 7). Six years from J2000 the two argument sets differ
/// by 1.1" in l and move `dpsi` by 1.0e-11 rad (2 microarcseconds); the tolerance is
/// that deliberate difference with margin, 5e-11 rad (10 microarcseconds), and
/// anything else would still show.
#[test]
fn nutation_2000b_matches_erfa() {
    let n = nutation_2000b(JD_53736);
    assert_close(
        n.dpsi_rad,
        -0.963_255_229_114_836_3e-5,
        5e-11,
        "nut00b dpsi",
    );
    assert_close(
        n.deps_rad,
        0.406_319_710_662_115_94e-4,
        5e-11,
        "nut00b deps",
    );
}

/// `eraObl06(2400000.5, 54388.0) = 0.4090749229387258204 rad`.
#[test]
fn mean_obliquity_matches_erfa_obl06() {
    assert_close(
        mean_obliquity_rad(JD_54388),
        0.409_074_922_938_725_82,
        1e-14,
        "obl06",
    );
}

/// `eraPfw06(2400000.5, 50123.9999)`:
/// gamb -0.2243387670997995690e-5, phib 0.4091014602391312808,
/// psib -0.9501954178013031895e-3, epsa 0.4091014316587367491 (radians).
#[test]
fn fukushima_williams_angles_match_erfa_pfw06() {
    let fw = fukushima_williams_2006(JD_PFW);
    assert_close(
        fw.gamma_bar_rad,
        -0.224_338_767_099_799_57e-5,
        1e-16,
        "pfw06 gamb",
    );
    assert_close(
        fw.phi_bar_rad,
        0.409_101_460_239_131_28,
        1e-12,
        "pfw06 phib",
    );
    assert_close(
        fw.psi_bar_rad,
        -0.950_195_417_801_303_19e-3,
        1e-14,
        "pfw06 psib",
    );
    assert_close(fw.eps_a_rad, 0.409_101_431_658_736_75, 1e-12, "pfw06 epsa");
}

/// The equation of the equinoxes is `dpsi cos(eps_A)` plus `eraEect00`, which at
/// MJD 53736 is 0.2046085004885125264e-8 rad. Checking the composite against that
/// decomposition verifies the complementary terms are in and correctly signed.
#[test]
fn equation_of_equinoxes_includes_the_complementary_terms() {
    let ee = equation_of_equinoxes_rad(JD_53736);
    let classical = nutation_2000b(JD_53736).dpsi_rad * mean_obliquity_rad(JD_53736).cos();
    let complementary = ee - classical;
    // The truncated series must reproduce eraEect00 to better than 1e-11 rad (2e-6").
    assert_close(
        complementary,
        0.204_608_500_488_512_53e-8,
        1e-11,
        "eect00 complementary terms",
    );
    // Sanity: the whole complementary contribution is tiny compared with the budget.
    assert!(complementary.abs() / ARCSEC < 0.005);
}

/// GAST - GMST must be the equation of the equinoxes and nothing else.
#[test]
fn gast_minus_gmst_is_the_equation_of_the_equinoxes() {
    for jd in [2_447_892.5, 2_451_545.0, 2_460_000.5, 2_473_459.5] {
        let d = (gast_deg(jd, jd) - gmst_deg(jd, jd)) * DEG;
        assert_close(d, equation_of_equinoxes_rad(jd), 1e-15, "GAST - GMST");
    }
}
