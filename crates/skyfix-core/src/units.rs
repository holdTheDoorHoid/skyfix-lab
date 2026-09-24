//! CONVENTIONS section 1: units, constants, angle normalisation.

use std::f64::consts::PI;

/// Metres per nautical mile, exact.
pub const NM_M: f64 = 1852.0;
/// Reference-sphere radius such that one arcminute of arc is exactly one nautical mile.
pub const EARTH_RADIUS_M: f64 = NM_M * 10800.0 / PI;
pub const DEG: f64 = PI / 180.0;
pub const ARCMIN: f64 = PI / 10800.0;
pub const ARCSEC: f64 = PI / 648000.0;
/// Sidereal rate of GHA change, degrees per hour (stars).
pub const SIDEREAL_RATE_DEG_PER_HOUR: f64 = 15.041_068_64;
/// Mean solar rate of GHA change, degrees per hour (Sun, first order).
pub const SOLAR_RATE_DEG_PER_HOUR: f64 = 15.0;
/// Mean lunar rate of GHA change, degrees per hour: the sidereal rate less the Moon's
/// mean motion in right ascension (360 deg per 27.321 661 d = 0.549 015 deg/h). The real
/// rate runs from about 14.1 to 14.9 deg/h; this is used only where no ephemeris can be
/// asked for the true one (CONVENTIONS 13.1).
pub const MEAN_LUNAR_RATE_DEG_PER_HOUR: f64 = 14.492_054;
/// chi-square 95 % quantile with 2 degrees of freedom (nominal 95 % ellipse scale).
pub const CHI2_95_2DOF: f64 = 5.991_464_547;

#[inline]
pub fn deg_to_rad(d: f64) -> f64 {
    d * DEG
}
#[inline]
pub fn rad_to_deg(r: f64) -> f64 {
    r / DEG
}
#[inline]
pub fn arcmin_to_rad(a: f64) -> f64 {
    a * ARCMIN
}
#[inline]
pub fn rad_to_arcmin(r: f64) -> f64 {
    r / ARCMIN
}
/// Radians of great-circle arc to metres on the reference sphere.
#[inline]
pub fn rad_to_m(r: f64) -> f64 {
    r * EARTH_RADIUS_M
}
#[inline]
pub fn m_to_rad(m: f64) -> f64 {
    m / EARTH_RADIUS_M
}
#[inline]
pub fn rad_to_nm(r: f64) -> f64 {
    r * EARTH_RADIUS_M / NM_M
}
#[inline]
pub fn nm_to_rad(nm: f64) -> f64 {
    nm * NM_M / EARTH_RADIUS_M
}

/// Normalise to `[0, 360)`.
pub fn norm_360(d: f64) -> f64 {
    let x = d.rem_euclid(360.0);
    if x >= 360.0 { 0.0 } else { x }
}
/// Normalise to `(-180, 180]`.
pub fn norm_180(d: f64) -> f64 {
    let x = norm_360(d);
    if x > 180.0 { x - 360.0 } else { x }
}
/// Normalise to `[0, 2 pi)`.
pub fn norm_2pi(r: f64) -> f64 {
    let x = r.rem_euclid(2.0 * PI);
    if x >= 2.0 * PI { 0.0 } else { x }
}
/// Normalise to `(-pi, pi]`.
pub fn norm_pi(r: f64) -> f64 {
    let x = norm_2pi(r);
    if x > PI { x - 2.0 * PI } else { x }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn one_arcminute_is_one_nautical_mile() {
        assert_relative_eq!(rad_to_m(ARCMIN), 1852.0, epsilon = 1e-9);
        assert_relative_eq!(rad_to_nm(ARCMIN), 1.0, epsilon = 1e-12);
        assert_relative_eq!(EARTH_RADIUS_M, 6_366_707.02, epsilon = 0.01);
    }

    #[test]
    fn normalisation_edges() {
        assert_eq!(norm_360(360.0), 0.0);
        assert_eq!(norm_360(-1.0), 359.0);
        assert_eq!(norm_180(180.0), 180.0);
        assert_eq!(norm_180(-180.0), 180.0);
        assert_eq!(norm_180(190.0), -170.0);
        assert_relative_eq!(norm_pi(PI), PI);
        assert_relative_eq!(norm_pi(-PI), PI);
        assert_relative_eq!(norm_pi(3.0 * PI), PI, epsilon = 1e-12);
    }
}
