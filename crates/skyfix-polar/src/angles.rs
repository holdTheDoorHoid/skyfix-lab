//! Modulo-180-degree angle arithmetic for the angle of linear polarization.
//!
//! The angle of linear polarization (AoLP) describes the orientation of a
//! *line* (the E-vector axis), not of an arrow. 179 deg and -1 deg are the same
//! physical state, and 179 deg and 1 deg are 2 deg apart, not 178 deg. Every
//! comparison, mean and residual in this crate goes through these helpers so
//! that no two modules can disagree about the wrap.
//!
//! CONVENTIONS section 1: internal maths is in radians (`*_rad`), every I/O
//! boundary is in degrees (`*_deg`). Both flavours are provided here because
//! AoLP is computed in radians and reported in degrees.

use std::f64::consts::PI;

/// Wrap to `[0, m)`.
#[inline]
fn wrap_mod(x: f64, m: f64) -> f64 {
    let r = x.rem_euclid(m);
    if r >= m { 0.0 } else { r }
}

/// Signed difference `a - b` folded into `(-m/2, m/2]`.
#[inline]
fn diff_mod(a: f64, b: f64, m: f64) -> f64 {
    let d = wrap_mod(a - b, m);
    if d > m / 2.0 { d - m } else { d }
}

/// Double-angle (circular) mean over the modulus `m`.
///
/// Returns `None` for an empty slice or when the resultant vector is
/// numerically zero (e.g. the mean of 0 and 90 deg modulo 180, which has no
/// well-defined answer).
fn mean_mod(xs: &[f64], m: f64) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let k = 2.0 * PI / m;
    let (mut sc, mut ss) = (0.0f64, 0.0f64);
    for &x in xs {
        let (s, c) = (k * x).sin_cos();
        ss += s;
        sc += c;
    }
    let n = xs.len() as f64;
    if (ss / n).hypot(sc / n) < 1e-12 {
        return None;
    }
    Some(wrap_mod(ss.atan2(sc) / k, m))
}

/// Wrap an AoLP in degrees to `[0, 180)`.
#[inline]
pub fn wrap180_deg(x: f64) -> f64 {
    wrap_mod(x, 180.0)
}

/// Wrap an AoLP in radians to `[0, pi)`.
#[inline]
pub fn wrap180_rad(x: f64) -> f64 {
    wrap_mod(x, PI)
}

/// Wrap a heading or azimuth in degrees to `[0, 360)`.
#[inline]
pub fn wrap360_deg(x: f64) -> f64 {
    wrap_mod(x, 360.0)
}

/// Signed modulo-180 difference of two AoLP values in degrees, in `(-90, 90]`.
///
/// `diff180_deg(179.0, 1.0) == -2.0`: the two angles differ by 2 deg.
#[inline]
pub fn diff180_deg(a: f64, b: f64) -> f64 {
    diff_mod(a, b, 180.0)
}

/// Signed modulo-pi difference of two AoLP values in radians, in `(-pi/2, pi/2]`.
#[inline]
pub fn diff180_rad(a: f64, b: f64) -> f64 {
    diff_mod(a, b, PI)
}

/// Signed difference of two headings in degrees, folded into `(-180, 180]`.
#[inline]
pub fn diff360_deg(a: f64, b: f64) -> f64 {
    diff_mod(a, b, 360.0)
}

/// Double-angle mean of AoLP values in degrees. `mean180_deg(&[179.0, 1.0]) == 0`.
pub fn mean180_deg(xs: &[f64]) -> Option<f64> {
    mean_mod(xs, 180.0)
}

/// Double-angle mean of AoLP values in radians.
pub fn mean180_rad(xs: &[f64]) -> Option<f64> {
    mean_mod(xs, PI)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn wrapping_lands_in_the_half_open_range() {
        assert_relative_eq!(wrap180_deg(180.0), 0.0, epsilon = 1e-12);
        assert_relative_eq!(wrap180_deg(-1.0), 179.0, epsilon = 1e-12);
        assert_relative_eq!(wrap180_deg(270.0), 90.0, epsilon = 1e-12);
        assert_relative_eq!(wrap360_deg(-90.0), 270.0, epsilon = 1e-12);
        assert_relative_eq!(wrap180_rad(PI), 0.0, epsilon = 1e-12);
        assert_relative_eq!(wrap180_rad(-0.25), PI - 0.25, epsilon = 1e-12);
    }

    #[test]
    fn one_seven_nine_and_one_differ_by_two() {
        // Independent numbers: the whole point of modulo-180 arithmetic.
        assert_relative_eq!(diff180_deg(179.0, 1.0), -2.0, epsilon = 1e-12);
        assert_relative_eq!(diff180_deg(1.0, 179.0), 2.0, epsilon = 1e-12);
        assert_relative_eq!(diff180_deg(179.0, 1.0).abs(), 2.0, epsilon = 1e-12);
        // 0 and 90 are maximally separated under modulo 180.
        assert_relative_eq!(diff180_deg(90.0, 0.0), 90.0, epsilon = 1e-12);
        assert_relative_eq!(diff180_deg(0.0, 90.0), 90.0, epsilon = 1e-12);
        // Radians agree with degrees.
        assert_relative_eq!(
            diff180_rad(179f64.to_radians(), 1f64.to_radians()).to_degrees(),
            -2.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn mean_of_one_seven_nine_and_one_is_zero() {
        assert_relative_eq!(mean180_deg(&[179.0, 1.0]).unwrap(), 0.0, epsilon = 1e-12);
        // Not 90: a naive arithmetic mean would give 90.
        assert!((mean180_deg(&[179.0, 1.0]).unwrap() - 90.0).abs() > 89.0);
        // A plain cluster averages the plain way.
        assert_relative_eq!(
            mean180_deg(&[40.0, 50.0, 45.0]).unwrap(),
            45.0,
            epsilon = 1e-9
        );
        // 170, 10, 0 -> resultant of 2*angle = 340, 20, 0 -> mean 0.
        assert_relative_eq!(
            mean180_deg(&[170.0, 10.0, 0.0]).unwrap(),
            0.0,
            epsilon = 1e-9
        );
        assert_relative_eq!(
            mean180_rad(&[179f64.to_radians(), 1f64.to_radians()])
                .unwrap()
                .to_degrees(),
            0.0,
            epsilon = 1e-9
        );
    }

    #[test]
    fn mean_is_undefined_for_orthogonal_pairs_and_empty_input() {
        assert!(mean180_deg(&[]).is_none());
        // 0 and 90 modulo 180 cancel exactly under the double-angle map.
        assert!(mean180_deg(&[0.0, 90.0]).is_none());
    }

    #[test]
    fn heading_difference_folds_to_plus_minus_180() {
        assert_relative_eq!(diff360_deg(350.0, 10.0), -20.0, epsilon = 1e-12);
        assert_relative_eq!(diff360_deg(10.0, 350.0), 20.0, epsilon = 1e-12);
        assert_relative_eq!(diff360_deg(180.0, 0.0), 180.0, epsilon = 1e-12);
    }
}
