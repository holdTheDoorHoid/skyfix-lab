//! The equation of time: its annual shape, and the fact that the value this crate
//! reports is consistent with the hour angle it reports.

use skyfix_core::time::{format_utc, parse_utc};
use skyfix_ephemeris::sun::{SunProvider, equation_of_time_min};

/// Apparent solar time minus mean solar time, derived from this crate's own GHA:
/// `E = GHA_sun / 15 + 12 h - UT1`, in minutes.
fn eot_from_hour_angle_min(jd_utc: f64) -> f64 {
    let p = SunProvider::new().position(jd_utc).unwrap();
    // DUT1 = 0, so UT1 hours-of-day come straight from the UTC Julian date.
    let ut_hours = (jd_utc + 0.5).rem_euclid(1.0) * 24.0;
    // Wrap into (-12 h, +12 h]: the difference is near zero, not near noon.
    ((p.gha_deg / 15.0 + 12.0 - ut_hours + 12.0).rem_euclid(24.0) - 12.0) * 60.0
}

/// The equation of time has its familiar two-humped annual shape: about -14.2 min in
/// mid-February and +16.4 min in early November, with four zeros a year.
#[test]
fn annual_extrema_and_zero_crossings() {
    let start = parse_utc("2026-01-01T00:00:00Z").unwrap();
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    let (mut lo_at, mut hi_at) = (0.0, 0.0);
    let mut crossings = 0;
    let mut prev = equation_of_time_min(start).unwrap();
    for i in 1..(365 * 24) {
        let jd = start + f64::from(i) / 24.0;
        let e = equation_of_time_min(jd).unwrap();
        if e < lo {
            lo = e;
            lo_at = jd;
        }
        if e > hi {
            hi = e;
            hi_at = jd;
        }
        if (prev < 0.0) != (e < 0.0) {
            crossings += 1;
        }
        prev = e;
    }
    assert!(
        (-14.4..-14.0).contains(&lo),
        "annual minimum {lo:.3} min, expected about -14.2"
    );
    assert!(
        (16.3..16.6).contains(&hi),
        "annual maximum {hi:.3} min, expected about +16.4"
    );
    assert!(
        format_utc(lo_at).starts_with("2026-02-1"),
        "minimum fell on {}, expected mid-February",
        format_utc(lo_at)
    );
    assert!(
        format_utc(hi_at).starts_with("2026-11-0"),
        "maximum fell on {}, expected early November",
        format_utc(hi_at)
    );
    assert_eq!(
        crossings, 4,
        "the equation of time crosses zero four times a year"
    );
}

/// The reported equation of time and the reported hour angle must describe the same
/// Sun. They are computed by completely separate routes — one from the Sun's mean
/// longitude, the other through sidereal time — so agreement is a real check on the
/// whole GAST chain.
///
/// They do *not* agree exactly, and the residual is the point of this test. The two
/// routes use different mean suns: Meeus (28.1) uses the Sun's mean longitude from the
/// VSOP87 fit, while `GHA / 15 + 12 h - UT1` uses the mean sun that the GMST-to-UT1
/// relation was built on. The offset is +0.0034 min (+3.1" of arc, +0.21 s of time),
/// essentially constant, and it is documented on `equation_of_time_min`.
#[test]
fn equation_of_time_agrees_with_the_hour_angle_chain() {
    let start = parse_utc("2026-01-01T00:00:00Z").unwrap();
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for i in 0..(365 * 4) {
        let jd = start + f64::from(i) / 4.0;
        let r = equation_of_time_min(jd).unwrap() - eot_from_hour_angle_min(jd);
        lo = lo.min(r);
        hi = hi.max(r);
    }
    assert!(
        (0.003..0.004).contains(&lo) && (0.003..0.004).contains(&hi),
        "mean-sun offset drifted out of [0.003, 0.004] min: [{lo:.6}, {hi:.6}]"
    );
    assert!(
        hi - lo < 0.0001,
        "the offset should be a constant, but it varied by {:.6} min over 2026",
        hi - lo
    );
}

/// The offset above stays put over the whole coverage window: it is a definitional
/// constant, not a drift that would grow into the error budget.
#[test]
fn the_mean_sun_offset_is_stable_across_the_coverage_window() {
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for year in 1990..=2060 {
        let jd = parse_utc(&format!("{year}-03-15T12:00:00Z")).unwrap();
        let r = equation_of_time_min(jd).unwrap() - eot_from_hour_angle_min(jd);
        lo = lo.min(r);
        hi = hi.max(r);
    }
    assert!(
        (0.0030..0.0036).contains(&lo) && (0.0030..0.0036).contains(&hi),
        "mean-sun offset over 1990-2060 ranged [{lo:.6}, {hi:.6}] min"
    );
    // 0.0006 min = 0.036 s of time = 0.54" of arc, far under the 0.1' target.
    assert!(hi - lo < 0.0006);
}
