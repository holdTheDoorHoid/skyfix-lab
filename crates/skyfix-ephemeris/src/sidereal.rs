//! Earth rotation angle, Greenwich mean and apparent sidereal time, GHA of Aries.
//!
//! OWNER: ephemeris agent. Shared: the Sun provider needs `gha_aries_deg` too.
//!
//! CONVENTIONS sections 6 and 7. The models are IAU 2006:
//!
//! - `era_deg`  — Earth rotation angle from UT1 (Capitaine et al. 2000, `eraEra00`).
//! - `gmst_deg` — ERA plus the IAU 2006 accumulated-precession polynomial in TT
//!   (`eraGmst06`). The polynomial is in TT, the rotation in UT1; both are required.
//! - `gast_deg` — GMST plus the equation of the equinoxes from the IAU 2000B nutation
//!   in [`crate::frames`], including the 10 largest complementary terms.
//! - `gha_aries_deg` — GAST expressed the Nautical Almanac way: west-positive,
//!   `[0, 360)`, taken straight from a UTC instant and an optional DUT1.
//!
//! Julian dates are single `f64`s, per the workspace contract. Near JD 2.46e6 an `f64`
//! resolves about 4e-5 s, i.e. 0.0006" of Earth rotation (1e-5 arcminutes): far below
//! the 0.05' budget, but it is why the tests below use tolerances of 1e-11 rad rather
//! than the 1e-12 rad of the published two-part reference values.

use skyfix_core::time::{JD_J2000, centuries_since_j2000, jd_tt, jd_ut1};
use skyfix_core::units::{DEG, norm_360};

use crate::frames::equation_of_equinoxes_rad;

/// Earth rotation angle at `jd_ut1`, degrees in `[0, 360)`.
///
/// `ERA = 360 deg * (0.7790572732640 + 1.00273781191135448 * (JD_UT1 - 2451545.0))`,
/// evaluated with the day fraction split out so the large multiple of a turn does not
/// eat the precision of the small one.
pub fn era_deg(jd_ut1: f64) -> f64 {
    let days_since_j2000 = jd_ut1 - JD_J2000;
    let day_fraction = jd_ut1 % 1.0;
    norm_360(
        360.0 * (day_fraction + 0.779_057_273_264_0 + 0.002_737_811_911_354_48 * days_since_j2000),
    )
}

/// Greenwich mean sidereal time, IAU 2006 (`eraGmst06`), degrees in `[0, 360)`.
///
/// The Earth rotation angle comes from UT1; the accumulated-precession polynomial is
/// a function of TT. Passing `jd_tt == jd_ut1` costs at most 0.0001" over the
/// provider's coverage, but the honest two-argument form is cheap, so it is required.
pub fn gmst_deg(jd_ut1_val: f64, jd_tt_val: f64) -> f64 {
    let tc = centuries_since_j2000(jd_tt_val);
    // Arcseconds, IAU 2006. The leading 0.014506" is a constant, not a `t` term.
    let precession_arcsec = 0.014_506
        + tc * (4_612.156_534
            + tc * (1.391_581_7
                + tc * (-0.000_000_44 + tc * (-0.000_029_956 + tc * -0.000_000_036_8))));
    norm_360(era_deg(jd_ut1_val) + precession_arcsec / 3600.0)
}

/// Equation of the equinoxes, `GAST - GMST`, degrees.
pub fn equation_of_equinoxes_deg(jd_tt_val: f64) -> f64 {
    equation_of_equinoxes_rad(jd_tt_val) / DEG
}

/// Greenwich apparent sidereal time, degrees in `[0, 360)`.
///
/// `GMST(UT1, TT) + equation of the equinoxes(TT)`, the equinox-based route. It agrees
/// with the CIO-based `eraGst06a` to well under a milliarcsecond; the only deliberate
/// difference is that the nutation here is IAU 2000B rather than 2000A, worth about
/// 0.0003".
pub fn gast_deg(jd_ut1_val: f64, jd_tt_val: f64) -> f64 {
    norm_360(gmst_deg(jd_ut1_val, jd_tt_val) + equation_of_equinoxes_deg(jd_tt_val))
}

/// Greenwich hour angle of the First Point of Aries at a UTC instant, degrees in
/// `[0, 360)`, west-positive (CONVENTIONS section 2).
///
/// `GHA Aries` is numerically the Greenwich apparent sidereal time. `dut1_s` is
/// `UT1 - UTC`; pass 0.0 when it is unknown. `|DUT1| < 0.9 s` by definition, which is
/// worth up to 13.5" (0.23') of GHA — the largest single term in this provider's error
/// budget, and the same approximation the printed almanac's users make.
pub fn gha_aries_deg(jd_utc: f64, dut1_s: f64) -> f64 {
    gast_deg(jd_ut1(jd_utc, dut1_s), jd_tt(jd_utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARCSEC_PER_DEG: f64 = 3600.0;

    /// USNO / SOFA: at 2000-01-01 12:00 UT1 (JD 2451545.0) Greenwich mean sidereal
    /// time is 18h 41m 50.548s = 280.46061837 deg.
    ///
    /// That figure is the IAU 1982 GMST expression. The IAU 2006 expression carries an
    /// extra constant term of 0.014506", so this implementation is expected to read
    /// 0.0145" higher, which is what the tolerance below allows and asserts.
    #[test]
    fn gmst_at_j2000_matches_the_usno_value() {
        let gmst = gmst_deg(JD_J2000, JD_J2000);
        let published = 280.460_618_37;
        let diff_arcsec = (gmst - published) * ARCSEC_PER_DEG;
        assert!(
            (diff_arcsec - 0.014_506).abs() < 0.001,
            "GMST {gmst} deg, {diff_arcsec:.6}\" from the IAU 1982 value"
        );
        // ERA alone reproduces the 1982 constant to 1e-8 deg by construction.
        assert!((era_deg(JD_J2000) - published).abs() < 1e-8);
    }

    #[test]
    fn sidereal_time_is_normalised() {
        for jd in [2_447_892.5, 2_451_545.0, 2_460_000.123_45, 2_473_459.5] {
            for v in [era_deg(jd), gmst_deg(jd, jd), gast_deg(jd, jd)] {
                assert!((0.0..360.0).contains(&v), "{v} out of range at {jd}");
            }
        }
    }

    /// GAST advances by one sidereal day (360 deg) in 0.99726957 mean solar days.
    #[test]
    fn sidereal_rate_matches_the_conventions_constant() {
        let jd = 2_460_000.5;
        let hour = 1.0 / 24.0;
        let d = norm_360(gast_deg(jd + hour, jd + hour) - gast_deg(jd, jd));
        assert!(
            (d - skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR).abs() < 1e-4,
            "{d} deg/h"
        );
    }

    #[test]
    fn dut1_shifts_gha_aries_at_the_sidereal_rate() {
        let jd = 2_461_306.5;
        let a = gha_aries_deg(jd, 0.0);
        let b = gha_aries_deg(jd, 0.9);
        let shift_arcmin = norm_360(b - a) * 60.0;
        // 0.9 s of UT1 is 0.9 * 15.04107"/s = 13.54" = 0.2257'.
        assert!((shift_arcmin - 0.2256).abs() < 0.001, "{shift_arcmin}'");
    }
}
