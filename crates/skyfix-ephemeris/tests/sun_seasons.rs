//! Sanity checks that do not depend on any single published worked example: the
//! equinoxes and solstices, the annual march of the semidiameter, and the rate at
//! which the Sun's hour angle grows.
//!
//! The 2026 equinox and solstice instants used here are the published ones; they are
//! *inputs*, not outputs, and each one independently pins a different part of the
//! model (longitude at the equinox, obliquity at the solstice).

use skyfix_core::time::{format_utc, parse_utc};
use skyfix_core::units::norm_180;
use skyfix_ephemeris::sun::{SunProvider, declination_deg};

/// Published 2026 season instants (UTC).
const MARCH_EQUINOX: &str = "2026-03-20T14:46:00Z";
const JUNE_SOLSTICE: &str = "2026-06-21T08:24:00Z";
const SEPTEMBER_EQUINOX: &str = "2026-09-23T00:05:00Z";
const DECEMBER_SOLSTICE: &str = "2026-12-21T20:50:00Z";

/// At the March equinox the Sun's apparent longitude is 0 by definition, so its
/// apparent declination is `beta cos(eps)`, under an arcsecond.
///
/// The declination moves 0.0166 deg per hour there, so a published instant good to a
/// minute pins the declination to 0.0003 deg. The tolerance below is 0.005 deg
/// (0.3'), which absorbs a several-minute error in the published instant while still
/// catching any real error in the model.
#[test]
fn declination_is_zero_at_the_equinoxes() {
    for s in [MARCH_EQUINOX, SEPTEMBER_EQUINOX] {
        let jd = parse_utc(s).unwrap();
        let dec = declination_deg(jd).unwrap();
        assert!(
            dec.abs() < 0.005,
            "declination at the equinox {s} is {dec:.6} deg, expected ~0"
        );
        // And the apparent longitude is 0 or 180 to within a few arcseconds, which is
        // a much tighter statement than the declination check above.
        let lambda = SunProvider::new()
            .position(jd)
            .unwrap()
            .apparent_longitude_deg;
        let target = if s == MARCH_EQUINOX { 0.0 } else { 180.0 };
        assert!(
            norm_180(lambda - target).abs() * 3600.0 < 30.0,
            "apparent longitude at {s} is {lambda:.6} deg, expected {target}"
        );
    }
}

/// At a solstice the apparent longitude is 90 or 270 deg, so `sin(dec) = sin(eps)` and
/// the declination equals the true obliquity, about 23.437 deg in 2026. Declination is
/// stationary there, so this is insensitive to an error in the published instant and
/// is a direct check on the obliquity.
#[test]
fn declination_reaches_the_obliquity_at_the_solstices() {
    for (s, sign) in [(JUNE_SOLSTICE, 1.0), (DECEMBER_SOLSTICE, -1.0)] {
        let p = SunProvider::new().position(parse_utc(s).unwrap()).unwrap();
        assert!(
            (23.43..23.45).contains(&p.dec_deg.abs()),
            "declination at the solstice {s} is {:.6} deg, expected ~{sign}23.44",
            p.dec_deg
        );
        assert!(
            p.dec_deg * sign > 0.0,
            "declination at {s} has the wrong sign: {:.6}",
            p.dec_deg
        );
        // Declination equals the true obliquity at a solstice, to the arcsecond.
        assert!(
            (p.dec_deg.abs() - p.true_obliquity_deg).abs() * 3600.0 < 2.0,
            "|dec| {:.7} and true obliquity {:.7} should coincide at a solstice",
            p.dec_deg.abs(),
            p.true_obliquity_deg
        );
    }
}

/// Declination sweeps the whole `+/-23.44 deg` band once a year and never leaves it.
#[test]
fn declination_stays_inside_the_obliquity_band() {
    let start = parse_utc("2026-01-01T00:00:00Z").unwrap();
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for i in 0..(365 * 8) {
        let dec = declination_deg(start + f64::from(i) / 8.0).unwrap();
        lo = lo.min(dec);
        hi = hi.max(dec);
    }
    assert!(
        (-23.45..-23.42).contains(&lo),
        "annual minimum declination {lo}"
    );
    assert!(
        (23.42..23.45).contains(&hi),
        "annual maximum declination {hi}"
    );
}

/// Semidiameter stays inside `[15.7', 16.3']` and peaks at perihelion in early January.
#[test]
fn semidiameter_range_and_january_maximum() {
    let start = parse_utc("2026-01-01T00:00:00Z").unwrap();
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    let (mut lo_at, mut hi_at) = (0.0, 0.0);
    for i in 0..(365 * 24) {
        let p = SunProvider::new()
            .position(start + f64::from(i) / 24.0)
            .unwrap();
        if p.semidiameter_arcmin < lo {
            lo = p.semidiameter_arcmin;
            lo_at = start + f64::from(i) / 24.0;
        }
        if p.semidiameter_arcmin > hi {
            hi = p.semidiameter_arcmin;
            hi_at = start + f64::from(i) / 24.0;
        }
        // Horizontal parallax tracks the same 1/R: 8.794" / 60 / R, so it runs from
        // 0.14416' at aphelion (R = 1.01671) to 0.14906' at perihelion (R = 0.98329).
        assert!(
            (0.1441..0.1491).contains(&p.horizontal_parallax_arcmin),
            "horizontal parallax {:.6}' at R = {:.6} au",
            p.horizontal_parallax_arcmin,
            p.radius_au
        );
    }
    assert!(
        (15.7..16.3).contains(&lo) && (15.7..16.3).contains(&hi),
        "semidiameter range [{lo:.4}', {hi:.4}'] leaves [15.7', 16.3']"
    );
    // Perihelion is 2 - 5 January; aphelion is early July.
    let hi_utc = format_utc(hi_at);
    let lo_utc = format_utc(lo_at);
    assert!(
        hi_utc.starts_with("2026-01-0"),
        "semidiameter maximum {hi:.4}' fell on {hi_utc}, expected early January"
    );
    assert!(
        lo_utc.starts_with("2026-07-0"),
        "semidiameter minimum {lo:.4}' fell on {lo_utc}, expected early July"
    );
}

/// The Sun's GHA grows by about 15 deg/h — that is what "mean solar time" means. The
/// spread about 15 deg is the equation of time's rate of change, a few hundredths of a
/// degree per hour.
#[test]
fn gha_increases_by_about_fifteen_degrees_per_hour() {
    let start = parse_utc("2026-01-01T00:00:00Z").unwrap();
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for i in 0..(365 * 24) {
        let jd = start + f64::from(i) / 24.0;
        let a = SunProvider::new().position(jd).unwrap().gha_deg;
        let b = SunProvider::new()
            .position(jd + 1.0 / 24.0)
            .unwrap()
            .gha_deg;
        let rate = (b - a).rem_euclid(360.0);
        lo = lo.min(rate);
        hi = hi.max(rate);
    }
    assert!(
        (14.98..15.02).contains(&lo) && (14.98..15.02).contains(&hi),
        "hourly GHA increase ranged over [{lo:.5}, {hi:.5}] deg, expected ~15"
    );
    // Over a whole mean solar day the Sun's GHA returns to where it started.
    let a = SunProvider::new().position(start).unwrap().gha_deg;
    let b = SunProvider::new().position(start + 1.0).unwrap().gha_deg;
    assert!(
        norm_180(b - a).abs() < 0.5,
        "GHA moved {:.4} deg in one mean solar day",
        norm_180(b - a)
    );
}

/// GHA and declination must stay inside their declared ranges (CONVENTIONS section 1)
/// at every sampled instant across the whole coverage window, including the endpoints.
#[test]
fn outputs_stay_normalised_across_the_whole_coverage_window() {
    let start = skyfix_ephemeris::sun::JD_COVERAGE_START;
    let end = skyfix_ephemeris::sun::JD_COVERAGE_END;
    let n = 20_000;
    for i in 0..=n {
        let jd = start + (end - start) * f64::from(i) / f64::from(n);
        let p = SunProvider::new().position(jd).unwrap();
        assert!(
            (0.0..360.0).contains(&p.gha_deg),
            "GHA {} outside [0, 360) at jd {jd}",
            p.gha_deg
        );
        assert!((0.0..360.0).contains(&p.ra_deg));
        assert!((0.0..360.0).contains(&p.gast_deg));
        assert!(p.dec_deg.abs() <= 90.0);
        assert!(p.radius_au > 0.98 && p.radius_au < 1.02);
        assert!(p.semidiameter_arcmin.is_finite() && p.semidiameter_arcmin > 0.0);
        assert!(p.equation_of_time_min.abs() < 20.0);
    }
}
