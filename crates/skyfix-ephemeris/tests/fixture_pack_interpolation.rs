//! How much the pack's interpolation costs, measured rather than asserted.
//!
//! Two questions:
//!
//! 1. Does the interpolation actually achieve its textbook error bounds? Measured on a
//!    pure sinusoid, where both bounds are exact and known in closed form.
//! 2. What does that mean for **the Moon at 1-hour steps**, the worst case an almanac
//!    pack has to carry? Measured on a synthetic signal built from the Moon's real
//!    dominant frequencies and amplitudes.
//!
//! The synthetic Moon below is NOT a lunar ephemeris and must never be used as one. It
//! exists only to put realistic frequency content and curvature into a smooth function
//! whose exact value is available at every instant, so the interpolation error can be
//! isolated from every other error.
//!
//! ## Analytic bounds
//!
//! For equally spaced nodes with spacing `h`:
//!
//! - cubic Lagrange, central interval: `|error| <= max|(x-x0)(x-x1)(x-x2)(x-x3)| / 4!`
//!   times `max|f''''|`. The product peaks at `0.5625 h^4` in the middle of the
//!   central interval, so `|error| <= h^4 max|f''''| / 42.67`.
//! - linear: `|error| <= h^2 max|f''| / 8`.

use std::collections::BTreeMap;
use std::f64::consts::PI;

use skyfix_core::time::parse_utc;
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::fixture_pack::{
    ALMANAC_PACK_SCHEMA, AlmanacPack, BodyTable, FixturePackProvider,
};

const START: &str = "2026-10-01T00:00:00Z";

fn pack_from<F: Fn(f64) -> [f64; 4]>(f: F, step_s: f64, n: u32) -> FixturePackProvider {
    let mut bodies = BTreeMap::new();
    bodies.insert(
        "Moon".to_string(),
        BodyTable {
            step_s,
            start_utc: START.to_string(),
            rows: (0..n).map(|i| f(f64::from(i) * step_s / 3600.0)).collect(),
        },
    );
    let pack = AlmanacPack {
        schema: ALMANAC_PACK_SCHEMA.to_string(),
        provider: "interp-test".to_string(),
        generator: serde_json::Value::Null,
        bodies,
        notes: String::new(),
    };
    FixturePackProvider::from_json(&serde_json::to_string(&pack).unwrap()).unwrap()
}

/// Worst interpolation error over the whole table, split into the cubic interior and
/// the linear end intervals. Returns `(cubic_arcmin, linear_arcmin)` for the GHA column.
fn measure_gha<F: Fn(f64) -> [f64; 4]>(
    f: F,
    step_s: f64,
    n: u32,
    samples_per_interval: u32,
) -> (f64, f64) {
    let p = pack_from(&f, step_s, n);
    let start = parse_utc(START).unwrap();
    let step_h = step_s / 3600.0;
    let (mut cubic, mut linear) = (0.0f64, 0.0f64);
    for i in 0..((n - 1) * samples_per_interval) {
        let hours = f64::from(i) / f64::from(samples_per_interval) * step_h;
        let jd = start + hours / 24.0;
        let got = p.geocentric("Moon", jd).unwrap().gha_deg;
        let want = norm_360(f(hours)[0]);
        let err = norm_180(got - want).abs() * 60.0;
        if p.uses_cubic("Moon", jd) {
            cubic = cubic.max(err);
        } else {
            linear = linear.max(err);
        }
    }
    (cubic, linear)
}

/// A pure sinusoid is the cleanest check: `f'''' = A w^4` and `f'' = A w^2` exactly, so
/// both textbook bounds are known numbers and the measured error must sit under them.
#[test]
fn interpolation_meets_its_textbook_bounds_on_a_sinusoid() {
    // Amplitude 6.3 deg at a 14.77-day period: the Moon's largest short-period term.
    let amp_deg = 6.3;
    let period_h = 14.765 * 24.0;
    let w = 2.0 * PI / period_h; // rad per hour
    let step_h = 1.0;
    let signal = |t: f64| [180.0 + amp_deg * (w * t).sin(), 0.0, 15.0, 55.0];

    let (cubic, linear) = measure_gha(signal, step_h * 3600.0, 60, 25);

    let bound_cubic_arcmin = step_h.powi(4) * amp_deg * w.powi(4) / 42.67 * 60.0;
    let bound_linear_arcmin = step_h.powi(2) * amp_deg * w.powi(2) / 8.0 * 60.0;

    println!(
        "sinusoid A={amp_deg} deg P={period_h} h h={step_h} h: \
         cubic {cubic:.3e}' (bound {bound_cubic_arcmin:.3e}'), \
         linear {linear:.3e}' (bound {bound_linear_arcmin:.3e}')"
    );
    assert!(
        cubic <= bound_cubic_arcmin,
        "cubic error {cubic:.3e}' exceeds the analytic bound {bound_cubic_arcmin:.3e}'"
    );
    assert!(
        linear <= bound_linear_arcmin,
        "linear error {linear:.3e}' exceeds the analytic bound {bound_linear_arcmin:.3e}'"
    );
    // The bounds are not loose by orders of magnitude: the measured error should be a
    // decent fraction of them, or the interpolator is not actually doing its job.
    assert!(
        cubic > 0.1 * bound_cubic_arcmin,
        "cubic error {cubic:.3e}' is suspiciously far under the bound"
    );
    assert!(
        linear > 0.1 * bound_linear_arcmin,
        "linear error {linear:.3e}' is suspiciously far under the bound"
    );
}

/// Halving the step must cut the cubic error by about 16 and the linear error by
/// about 4. That is the signature of the two methods' orders and would not hold if the
/// wrong stencil were being used.
///
/// Both measurements are **phase-locked**: the interval under test always begins at
/// the peak of a cosine, where the second and fourth derivatives are largest. Without
/// that, halving the step also moves the end intervals to a different part of the
/// wave, and the ratio measures the phase rather than the order.
///
/// The period is 24 hours, much faster than anything in the sky, so that even the
/// halved-step cubic error stays clear of the floor described in
/// [`halving_the_moon_step_buys_nothing_useful`].
#[test]
fn error_falls_at_the_expected_order_when_the_step_is_halved() {
    const AMP_DEG: f64 = 6.3;
    const PERIOD_H: f64 = 24.0;

    /// Worst error over one interval of a table built so that interval starts at the
    /// cosine peak. `rows` is 2 (a pure linear table) or 4 (one central cubic interval).
    fn interval_error(step_h: f64, rows: u32) -> f64 {
        let w = 2.0 * PI / PERIOD_H;
        // Row index at which the interval under test begins.
        let i0 = if rows == 2 { 0.0 } else { 1.0 };
        let signal = move |t: f64| {
            [
                180.0 + AMP_DEG * (w * (t - i0 * step_h)).cos(),
                0.0,
                15.0,
                55.0,
            ]
        };
        let p = pack_from(signal, step_h * 3600.0, rows);
        let start = parse_utc(START).unwrap();
        let mut worst = 0.0f64;
        for k in 1..200 {
            let hours = (i0 + f64::from(k) / 200.0) * step_h;
            let jd = start + hours / 24.0;
            assert_eq!(
                p.uses_cubic("Moon", jd),
                rows == 4,
                "the interval under test must use the stencil this measurement assumes"
            );
            let got = p.geocentric("Moon", jd).unwrap().gha_deg;
            worst = worst.max(norm_180(got - norm_360(signal(hours)[0])).abs() * 60.0);
        }
        worst
    }

    let (c1, c2) = (interval_error(1.0, 4), interval_error(0.5, 4));
    let (l1, l2) = (interval_error(1.0, 2), interval_error(0.5, 2));
    println!(
        "cubic:  h=1h {c1:.4e}'  h=0.5h {c2:.4e}'  ratio {:.2}",
        c1 / c2
    );
    println!(
        "linear: h=1h {l1:.4e}'  h=0.5h {l2:.4e}'  ratio {:.2}",
        l1 / l2
    );

    assert!(
        (13.0..19.0).contains(&(c1 / c2)),
        "cubic error should fall as h^4 (x16), ratio was {:.2}",
        c1 / c2
    );
    assert!(
        (3.5..4.5).contains(&(l1 / l2)),
        "linear error should fall as h^2 (x4), ratio was {:.2}",
        l1 / l2
    );
    // And the cubic stencil must be dramatically better than the linear one at the
    // same step: that is the whole reason for the 4-point interior. For a sinusoid the
    // ratio of the two bounds is 42.67 / (8 (h w)^2) = 5.33 / (h w)^2, which is 77.8
    // for this deliberately fast signal and thousands for anything in the sky.
    let advantage = l1 / c1;
    let predicted = 5.33 / (2.0 * PI / PERIOD_H).powi(2);
    println!("cubic advantage at h=1h: {advantage:.1}x (predicted {predicted:.1}x)");
    assert!(
        (0.8 * predicted..1.25 * predicted).contains(&advantage),
        "cubic {c1:.3e}' vs linear {l1:.3e}' is {advantage:.1}x, \
         predicted {predicted:.1}x for this signal"
    );
}

// ---------------------------------------------------------------------------
// A synthetic signal with the Moon's frequency content
// ---------------------------------------------------------------------------

/// Not an ephemeris. A smooth analytic function with the Moon's dominant periodic
/// terms, used only to give the interpolator realistic curvature.
///
/// Ecliptic longitude carries the six largest terms of the classical lunar theory
/// (equation of the centre 6.289 deg at the anomalistic month, evection 1.274 deg,
/// variation 0.658 deg, and three smaller ones); latitude carries the 5.128 deg
/// principal term and three others. The mean motions are the real ones, so the
/// frequency content — which is all that matters for an interpolation bound — is
/// right.
fn synthetic_moon(hours: f64) -> (f64, f64) {
    let d = hours / 24.0; // days from the epoch
    let deg = |x: f64| x * PI / 180.0;
    let l = deg(218.316 + 13.176_396 * d); // mean longitude
    let m = deg(134.963 + 13.064_993 * d); // Moon's mean anomaly
    let ms = deg(357.529 + 0.985_600_28 * d); // Sun's mean anomaly
    let dd = deg(297.850 + 12.190_749 * d); // mean elongation
    let f = deg(93.272 + 13.229_350 * d); // argument of latitude

    let lambda = l.to_degrees()
        + 6.289 * m.sin()
        + 1.274 * (2.0 * dd - m).sin()
        + 0.658 * (2.0 * dd).sin()
        + 0.214 * (2.0 * m).sin()
        - 0.186 * ms.sin()
        - 0.114 * (2.0 * f).sin();
    let beta = 5.128 * f.sin() + 0.281 * (m + f).sin()
        - 0.278 * (f - m).sin()
        - 0.173 * (2.0 * dd - f).sin();
    (lambda, beta)
}

/// The synthetic Moon's `[gha, dec, sd, hp]` at `hours` after the epoch.
///
/// GHA is `GAST - RA` with GAST taken as exactly linear in time, which it is to well
/// under an arcsecond: all the curvature in a lunar GHA comes from the Moon's own
/// right ascension, so this is the right function to interpolate.
fn synthetic_moon_row(hours: f64) -> [f64; 4] {
    let (lambda_deg, beta_deg) = synthetic_moon(hours);
    let eps = 23.4393_f64.to_radians();
    let (lam, bet) = (lambda_deg.to_radians(), beta_deg.to_radians());
    let (sl, cl) = lam.sin_cos();
    let (sb, cb) = bet.sin_cos();
    let (se, ce) = eps.sin_cos();
    let ra = (sl * ce - (sb / cb) * se).atan2(cl).to_degrees();
    let dec = (sb * ce + cb * se * sl).asin().to_degrees();
    let gast = 280.46 + 15.041_068_64 * hours;
    // Semidiameter and horizontal parallax vary with the Moon's distance, which runs
    // over 14.6' - 16.7' and 54' - 61.5' once an anomalistic month.
    let m = (134.963 + 13.064_993 * hours / 24.0).to_radians();
    let hp = 57.25 + 3.06 * m.cos();
    [norm_360(gast - ra), dec, hp * 0.2725, hp]
}

/// The headline number: what 1-hour tabulation costs for the Moon.
#[test]
fn the_moon_at_one_hour_steps() {
    let start = parse_utc(START).unwrap();
    // Four weeks, so a whole anomalistic and draconic month are covered.
    let n = 24 * 28 + 1;
    let p = pack_from(synthetic_moon_row, 3600.0, n);

    let (mut cubic, mut linear) = ([0.0f64; 4], [0.0f64; 4]);
    for i in 0..((n - 1) * 12) {
        let hours = f64::from(i) / 12.0;
        let jd = start + hours / 24.0;
        let got = p.geocentric("Moon", jd).unwrap();
        let want = synthetic_moon_row(hours);
        let errs = [
            norm_180(got.gha_deg - want[0]).abs() * 60.0,
            (got.dec_deg - want[1]).abs() * 60.0,
            (got.semidiameter_arcmin - want[2]).abs(),
            (got.horizontal_parallax_arcmin - want[3]).abs(),
        ];
        let target = if p.uses_cubic("Moon", jd) {
            &mut cubic
        } else {
            &mut linear
        };
        for (t, e) in target.iter_mut().zip(errs) {
            *t = t.max(e);
        }
    }

    println!(
        "synthetic Moon, 1-hour steps, worst interpolation error in arcminutes\n  \
         cubic interior: GHA {:.6} Dec {:.6} SD {:.6} HP {:.6}\n  \
         linear ends:    GHA {:.6} Dec {:.6} SD {:.6} HP {:.6}",
        cubic[0], cubic[1], cubic[2], cubic[3], linear[0], linear[1], linear[2], linear[3]
    );

    // Recorded bounds. These are the numbers quoted in the fixture_pack module docs
    // and they are what a caller should add to a pack's own accuracy.
    assert!(
        cubic[0] < 0.001,
        "cubic GHA error {:.6}' should be well under 0.001'",
        cubic[0]
    );
    assert!(
        cubic[1] < 0.001,
        "cubic Dec error {:.6}' should be well under 0.001'",
        cubic[1]
    );
    assert!(cubic[2] < 0.001 && cubic[3] < 0.001);

    // The two end intervals are linear and cost two orders of magnitude more. This is
    // the reason `uses_cubic` is public.
    assert!(
        linear[0] < 0.05,
        "linear GHA error {:.6}' should be under 0.05'",
        linear[0]
    );
    assert!(
        linear[0] > cubic[0] * 20.0,
        "the linear ends must be visibly worse than the cubic interior: \
         linear {:.6}' vs cubic {:.6}'",
        linear[0],
        cubic[0]
    );
    assert!(
        linear[1] < 0.05,
        "linear Dec error {:.6}' should be under 0.05'",
        linear[1]
    );
}

/// Halving the Moon's tabulation step to 30 minutes buys nothing: at 1-hour steps the
/// cubic error is already **below the floor set by holding a Julian date in one f64**,
/// so the finer grid measures rounding, not interpolation.
///
/// Near JD 2.46e6 an `f64` resolves about 4e-5 s. At the Moon's 14.49 deg/h that is
/// 1.6e-7 deg = 1e-5 arcminutes, and the measured cubic errors below sit at half of
/// that and barely move when the step is halved. `skyfix_core::time` and
/// `crate::sidereal` record the same limit. Recorded here so nobody doubles a pack's
/// size for nothing.
#[test]
fn halving_the_moon_step_buys_nothing_useful() {
    let (c1, _) = measure_gha(synthetic_moon_row, 3600.0, 24 * 14, 12);
    let (c2, _) = measure_gha(synthetic_moon_row, 1800.0, 48 * 14, 12);
    println!("Moon cubic GHA error: 1 h {c1:.3e}'  0.5 h {c2:.3e}'");
    // The f64 Julian-date floor at the Moon's rate, arcminutes.
    let jd_floor = 14.49 * (4.0e-5 / 3600.0) * 60.0;
    println!("f64 Julian-date resolution floor at the Moon's rate: {jd_floor:.3e}'");
    assert!(c1 < 0.001, "1-hour cubic error {c1:.3e}'");
    assert!(
        c1 < jd_floor,
        "the 1-hour cubic error {c1:.3e}' should already be under the f64 floor \
         {jd_floor:.3e}'; if it is not, the interpolation really is the limit here"
    );
    assert!(
        c2 / c1 > 0.25,
        "halving the step improved the error by more than 4x ({c1:.3e}' -> {c2:.3e}'), \
         so it is no longer floor-limited and this test's premise has changed"
    );
    // Both are negligible against the 0.1' the ephemeris aims at and the 1.0' default
    // sight sigma.
    assert!(c1 < 0.01 && c2 < 0.01);
}

/// The Sun changes far more slowly than the Moon, so a 1-hour pack is exact for it to
/// well under a thousandth of an arcminute. Recorded so a pack author can size the
/// Sun's rows with the same evidence.
#[test]
fn a_slow_body_at_one_hour_steps_is_essentially_exact() {
    // The Sun's GHA: 15 deg/h plus the equation of time, a 16-minute annual wobble.
    let sun = |hours: f64| {
        let d = hours / 24.0;
        let m = (357.529 + 0.985_600_28 * d).to_radians();
        let eot_deg = -0.0334 * m.sin() - 0.0533 * (2.0 * (280.46 + 0.9856 * d).to_radians()).sin();
        [norm_360(15.0 * hours + eot_deg), 0.0, 16.0, 0.146]
    };
    let (cubic, linear) = measure_gha(sun, 3600.0, 24 * 30, 12);
    println!("synthetic Sun, 1-hour steps: cubic {cubic:.3e}' linear {linear:.3e}'");
    assert!(cubic < 1e-4, "cubic {cubic:.3e}'");
    assert!(linear < 1e-2, "linear {linear:.3e}'");
}
