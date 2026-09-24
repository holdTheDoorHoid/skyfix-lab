//! Ideal single-scattering Rayleigh sky.
//!
//! **This is a stress model, not validated atmosphere physics.** It contains one
//! scattering event off molecules in a non-absorbing, horizontally uniform,
//! plane-free atmosphere. It has no multiple scattering, no aerosol, no ground
//! albedo, no ozone, no cloud, and no wavelength dependence. Real skies deviate
//! from it everywhere and most strongly near the horizon, near the Sun, and
//! whenever there is haze. Any number produced by this module is a statement
//! about *this model*, never about the sky over your head. Nothing here
//! supports a claim about all-weather compass accuracy.
//!
//! # Geometry
//!
//! A direction is `(altitude, azimuth)`: altitude up from the horizon,
//! azimuth clockwise from north, matching `docs/CONVENTIONS.md` section 2
//! (`Zn`). The unit vector is written in the right-handed triad
//! `(east, north, up)`:
//!
//! ```text
//! v = [cos(alt) sin(az), cos(alt) cos(az), sin(alt)]
//! ```
//!
//! # The model
//!
//! With the Sun at unit vector `s` and the sky point at unit vector `v`, the
//! scattering angle is `gamma = acos(s . v)` and
//!
//! ```text
//! DoLP(gamma) = d_max * sin^2(gamma) / (1 + cos^2(gamma))
//! ```
//!
//! The E-vector of the scattered light is perpendicular to the scattering plane
//! spanned by `s` and `v`, i.e. along `n = s x v`. `n` is automatically
//! perpendicular to `v`, so it lies in the tangent plane of the sky at `v`.

use crate::angles::wrap180_rad;
use crate::vec3::{Mat3, Vec3, cross, dot, mat_vec, normalize, scale};
use serde::{Deserialize, Serialize};

/// Below this cross-product magnitude the scattering plane is undefined: the
/// sky point coincides with the Sun or the anti-Sun. These are the only two
/// neutral points the ideal model has.
pub const NEUTRAL_TOL: f64 = 1e-12;

/// Degree of linear polarization actually observed in a clear real sky at
/// `gamma = 90 deg`: roughly 0.75, not 1.0. Multiple scattering and aerosol
/// depolarize the maximum. Provided as documentation, not as a validated value.
pub const TYPICAL_CLEAR_SKY_D_MAX: f64 = 0.75;

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

/// Serde shadow so that `Dir` stores radians internally and serialises in
/// degrees (CONVENTIONS section 1: radians never appear in JSON).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct DirDeg {
    alt_deg: f64,
    az_deg: f64,
}

/// A direction in a horizon-type frame. Altitude up from the horizon, azimuth
/// clockwise from the frame's reference axis (north, in the world frame).
///
/// Stored in radians; serialises as `{"alt_deg": .., "az_deg": ..}`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "DirDeg", into = "DirDeg")]
pub struct Dir {
    pub alt_rad: f64,
    pub az_rad: f64,
}

impl From<DirDeg> for Dir {
    fn from(d: DirDeg) -> Self {
        Dir::from_deg(d.alt_deg, d.az_deg)
    }
}

impl From<Dir> for DirDeg {
    fn from(d: Dir) -> Self {
        DirDeg {
            alt_deg: d.alt_deg(),
            az_deg: d.az_deg(),
        }
    }
}

impl Dir {
    pub fn new(alt_rad: f64, az_rad: f64) -> Self {
        Dir { alt_rad, az_rad }
    }

    pub fn from_deg(alt_deg: f64, az_deg: f64) -> Self {
        Dir::new(alt_deg.to_radians(), az_deg.to_radians())
    }

    pub fn alt_deg(&self) -> f64 {
        self.alt_rad.to_degrees()
    }

    pub fn az_deg(&self) -> f64 {
        self.az_rad.to_degrees()
    }

    /// Unit vector in the right-handed `(east, north, up)` triad.
    pub fn to_unit(&self) -> Vec3 {
        let (sa, ca) = self.alt_rad.sin_cos();
        let (sz, cz) = self.az_rad.sin_cos();
        [ca * sz, ca * cz, sa]
    }

    /// Inverse of [`Dir::to_unit`]. Azimuth is arbitrary (0) at the zenith.
    pub fn from_unit(v: Vec3) -> Self {
        let horiz = v[0].hypot(v[1]);
        Dir::new(v[2].atan2(horiz), v[0].atan2(v[1]))
    }

    /// The point diametrically opposite on the celestial sphere.
    pub fn antipode(&self) -> Self {
        Dir::new(-self.alt_rad, self.az_rad + std::f64::consts::PI)
    }
}

/// The local tangent basis at a sky point: `(e_alt, e_az)`.
///
/// * `e_alt` points along the local meridian in the direction of *increasing
///   altitude*, i.e. toward the zenith along the vertical circle through the
///   point. This is the AoLP zero direction (see [`aolp_local_rad`]).
/// * `e_az` points along the direction of *increasing azimuth*.
///
/// `(e_alt, e_az, v)` is right-handed. The basis is **singular at the zenith
/// and the nadir**, where azimuth is undefined; `None` is returned there. The
/// camera path never uses it: `camera.rs` projects the E-vector straight into
/// the pixel frame, which has no such singularity at the image centre.
pub fn local_frame(view: Dir) -> Option<(Vec3, Vec3)> {
    let v = view.to_unit();
    let e_az = normalize(cross(v, [0.0, 0.0, 1.0]), 1e-9)?;
    let e_alt = cross(e_az, v);
    Some((e_alt, e_az))
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/// Ideal single-scattering Rayleigh sky.
///
/// **Stress model, not validated atmosphere physics** (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RayleighSky {
    /// Peak degree of linear polarization at `gamma = 90 deg`. The ideal model
    /// has 1.0; a clear real sky reaches roughly
    /// [`TYPICAL_CLEAR_SKY_D_MAX`] (0.75) and a hazy one much less.
    pub d_max: f64,
}

impl Default for RayleighSky {
    fn default() -> Self {
        RayleighSky { d_max: 1.0 }
    }
}

/// One evaluation of the model at a sky point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SkySample {
    /// Scattering angle Sun-observer-sky point, radians, `[0, pi]`.
    pub gamma_rad: f64,
    /// Degree of linear polarization, `[0, d_max]`.
    pub dolp: f64,
    /// AoLP in the local frame of the sky point, radians in `[0, pi)`.
    /// `None` at a neutral point (Sun or anti-Sun) and at the zenith/nadir,
    /// where the local frame itself is undefined.
    pub aolp_local_rad: Option<f64>,
    /// True at a neutral point of the ideal model: the Sun or the anti-Sun,
    /// and nowhere else.
    pub neutral: bool,
}

impl RayleighSky {
    pub fn new(d_max: f64) -> Self {
        RayleighSky { d_max }
    }

    /// `DoLP(gamma) = d_max sin^2(gamma) / (1 + cos^2(gamma))`.
    ///
    /// Symmetric about `gamma = 90 deg`: `dolp(gamma) == dolp(pi - gamma)`
    /// exactly, because only `sin^2` and `cos^2` appear. That symmetry is the
    /// root of the Sun/anti-Sun degeneracy documented on
    /// [`sun_antisun_degenerate`].
    pub fn dolp(&self, gamma_rad: f64) -> f64 {
        let (s, c) = gamma_rad.sin_cos();
        self.d_max * s * s / (1.0 + c * c)
    }

    /// Evaluate the model at `view` for a Sun at `sun`.
    pub fn sample(&self, sun: Dir, view: Dir) -> SkySample {
        let gamma_rad = scattering_angle_rad(sun, view);
        let neutral = is_neutral(sun, view);
        SkySample {
            gamma_rad,
            dolp: if neutral { 0.0 } else { self.dolp(gamma_rad) },
            aolp_local_rad: aolp_local_rad(sun, view),
            neutral,
        }
    }
}

/// Scattering angle between the Sun direction and a sky direction, `[0, pi]`.
pub fn scattering_angle_rad(sun: Dir, view: Dir) -> f64 {
    let s = sun.to_unit();
    let v = view.to_unit();
    // atan2 of |s x v| against s . v keeps full precision near 0 and pi.
    let c = cross(s, v);
    crate::vec3::norm(c).atan2(dot(s, v))
}

/// True when the sky point coincides with the Sun or the anti-Sun, the only
/// two neutral points of the ideal single-scattering model.
///
/// Real skies additionally show the Babinet, Brewster and Arago neutral points.
/// **Those do not exist here**: they are produced by multiple scattering and
/// ground reflection, which this model omits entirely. Finding only two neutral
/// points is therefore a property of the model, not a finding about the sky.
pub fn is_neutral(sun: Dir, view: Dir) -> bool {
    crate::vec3::norm(cross(sun.to_unit(), view.to_unit())) < NEUTRAL_TOL
}

/// The E-vector direction in world coordinates: a unit vector along `s x v`,
/// perpendicular to the scattering plane and tangent to the sky at `view`.
///
/// `None` at a neutral point, where the scattering plane is undefined. The sign
/// carries no physical meaning: the E-vector is an axis, so `n` and `-n` are
/// the same state.
pub fn evector_world(sun: Dir, view: Dir) -> Option<Vec3> {
    normalize(cross(sun.to_unit(), view.to_unit()), NEUTRAL_TOL)
}

/// AoLP expressed in the local frame of the sky point, radians in `[0, pi)`.
///
/// **Convention.** Zero is the local meridian direction `e_alt` (toward the
/// zenith along the vertical circle through the point). The angle increases
/// toward `e_az` (increasing azimuth). Because `(e_alt, e_az, v)` is
/// right-handed and the observer looks *outward* along `+v`, increasing AoLP
/// appears **clockwise to an observer facing that patch of sky**. The value is
/// taken modulo 180 deg.
///
/// `None` at a neutral point and at the zenith/nadir (see [`local_frame`]).
pub fn aolp_local_rad(sun: Dir, view: Dir) -> Option<f64> {
    let n = evector_world(sun, view)?;
    let (e_alt, e_az) = local_frame(view)?;
    Some(wrap180_rad(dot(n, e_az).atan2(dot(n, e_alt))))
}

/// Simple radiance proxy: relative sky brightness at a scattering angle.
///
/// **Not validated, and deliberately not the Rayleigh phase function.** The
/// Rayleigh phase function `(1 + cos^2 gamma)` is symmetric about
/// `gamma = 90 deg`, so it is *equally* bright toward the Sun and the anti-Sun
/// and cannot break the Sun/anti-Sun degeneracy. Real skies are brighter toward
/// the Sun because of aerosol forward scattering. This function is a monotone
/// stand-in for that asymmetry and nothing more:
///
/// ```text
/// L(gamma) = 1 + k * (1 + cos gamma) / 2
/// ```
///
/// It exists only to let the optional heading disambiguator be exercised. Any
/// heading resolved with it inherits its lack of validation.
pub fn relative_radiance(gamma_rad: f64, k: f64) -> f64 {
    1.0 + k * (1.0 + gamma_rad.cos()) / 2.0
}

// ---------------------------------------------------------------------------
// Symmetries, as callable facts
// ---------------------------------------------------------------------------

/// Reflect a direction across the solar meridian (the vertical plane through
/// the Sun and the zenith): altitude unchanged, azimuth mirrored about the
/// Sun's azimuth.
pub fn mirror_about_solar_meridian(sun: Dir, view: Dir) -> Dir {
    Dir::new(view.alt_rad, 2.0 * sun.az_rad - view.az_rad)
}

/// The ideal pattern is mirror-symmetric about the solar meridian: DoLP is
/// invariant and AoLP changes sign (modulo 180 deg).
///
/// Returns `(dolp_here, dolp_mirrored, aolp_here, aolp_mirrored)` in radians,
/// or `None` if either point is neutral or at the zenith.
pub fn mirror_symmetry_check(
    sky: &RayleighSky,
    sun: Dir,
    view: Dir,
) -> Option<(f64, f64, f64, f64)> {
    let m = mirror_about_solar_meridian(sun, view);
    let a = aolp_local_rad(sun, view)?;
    let b = aolp_local_rad(sun, m)?;
    Some((
        sky.dolp(scattering_angle_rad(sun, view)),
        sky.dolp(scattering_angle_rad(sun, m)),
        a,
        b,
    ))
}

/// The ideal field is **exactly** invariant when the Sun is replaced by the
/// anti-Sun.
///
/// `gamma -> pi - gamma`, and `DoLP` depends on `gamma` only through `sin^2`
/// and `cos^2`, so DoLP is unchanged. `(-s) x v = -(s x v)` is the same *axis*,
/// so AoLP is unchanged modulo 180 deg. There is no measurement of DoLP or
/// AoLP anywhere in the sky that can tell a Sun at `(alt, az)` from one at
/// `(-alt, az + 180)`.
///
/// Returns the largest `(dolp, aolp)` discrepancy found over `views`, which is
/// numerical noise only.
pub fn sun_antisun_degenerate(sky: &RayleighSky, sun: Dir, views: &[Dir]) -> (f64, f64) {
    let anti = sun.antipode();
    let (mut dd, mut da) = (0.0f64, 0.0f64);
    for &v in views {
        let a = sky.sample(sun, v);
        let b = sky.sample(anti, v);
        dd = dd.max((a.dolp - b.dolp).abs());
        if let (Some(x), Some(y)) = (a.aolp_local_rad, b.aolp_local_rad) {
            da = da.max(crate::angles::diff180_rad(x, y).abs());
        }
    }
    (dd, da)
}

/// Rotate a world vector by `yaw` radians clockwise about the vertical.
///
/// Columns are the images of `(east, north, up)`. Shared with `camera.rs`,
/// which builds the full extrinsic rotation from it.
pub fn yaw_matrix(yaw_rad: f64) -> Mat3 {
    let (s, c) = yaw_rad.sin_cos();
    [[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// Convenience: the Sun direction expressed in a frame obtained from the world
/// by the rotation `r` (columns are the frame's axes in world coordinates).
pub fn sun_in_frame(sun: Dir, r_transpose: &Mat3) -> Vec3 {
    mat_vec(r_transpose, sun.to_unit())
}

/// Scale a direction's unit vector. Used by tests that need a non-unit input.
pub fn scaled_unit(d: Dir, k: f64) -> Vec3 {
    scale(d.to_unit(), k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::angles::diff180_rad;
    use approx::assert_relative_eq;
    use std::f64::consts::PI;

    fn hemisphere(step_alt: usize, step_az: usize) -> Vec<Dir> {
        let mut out = Vec::new();
        for i in 0..=step_alt {
            let alt = 89.0 * i as f64 / step_alt as f64;
            for j in 0..step_az {
                let az = 360.0 * j as f64 / step_az as f64;
                out.push(Dir::from_deg(alt, az));
            }
        }
        out
    }

    #[test]
    fn unit_vectors_follow_the_stated_convention() {
        // North, east, zenith by hand.
        let n = Dir::from_deg(0.0, 0.0).to_unit();
        assert_relative_eq!(n[0], 0.0, epsilon = 1e-15);
        assert_relative_eq!(n[1], 1.0, epsilon = 1e-15);
        let e = Dir::from_deg(0.0, 90.0).to_unit();
        assert_relative_eq!(e[0], 1.0, epsilon = 1e-15);
        assert_relative_eq!(e[1], 0.0, epsilon = 1e-15);
        let z = Dir::from_deg(90.0, 123.0).to_unit();
        assert_relative_eq!(z[2], 1.0, epsilon = 1e-15);
        // Round trip.
        let d = Dir::from_deg(37.5, 212.25);
        let r = Dir::from_unit(d.to_unit());
        assert_relative_eq!(r.alt_deg(), 37.5, epsilon = 1e-12);
        assert_relative_eq!(crate::angles::wrap360_deg(r.az_deg()), 212.25, epsilon = 1e-12);
    }

    #[test]
    fn dolp_hand_computed_values() {
        let sky = RayleighSky::default();
        // gamma = 90: sin^2 = 1, cos^2 = 0 -> 1.0.
        assert_relative_eq!(sky.dolp(PI / 2.0), 1.0, epsilon = 1e-15);
        // gamma = 60: 0.75 / (1 + 0.25) = 0.6 exactly.
        assert_relative_eq!(sky.dolp(60f64.to_radians()), 0.6, epsilon = 1e-15);
        // gamma = 45: 0.5 / 1.5 = 1/3.
        assert_relative_eq!(sky.dolp(45f64.to_radians()), 1.0 / 3.0, epsilon = 1e-15);
        // gamma = 0 and 180: no polarization.
        assert_relative_eq!(sky.dolp(0.0), 0.0, epsilon = 1e-15);
        assert_relative_eq!(sky.dolp(PI), 0.0, epsilon = 1e-15);
        // d_max scales linearly.
        assert_relative_eq!(
            RayleighSky::new(TYPICAL_CLEAR_SKY_D_MAX).dolp(PI / 2.0),
            0.75,
            epsilon = 1e-15
        );
    }

    #[test]
    fn dolp_is_symmetric_about_ninety_degrees() {
        let sky = RayleighSky::new(0.9);
        for g in [0.0f64, 5.0, 17.5, 33.0, 60.0, 89.9, 90.0] {
            let a = sky.dolp(g.to_radians());
            let b = sky.dolp((180.0 - g).to_radians());
            assert_relative_eq!(a, b, epsilon = 1e-15);
        }
    }

    #[test]
    fn evector_is_perpendicular_to_the_scattering_plane() {
        let sun = Dir::from_deg(35.0, 135.0);
        for v in hemisphere(9, 12) {
            if is_neutral(sun, v) {
                continue;
            }
            let n = evector_world(sun, v).unwrap();
            assert_relative_eq!(crate::vec3::norm(n), 1.0, epsilon = 1e-12);
            assert_relative_eq!(dot(n, sun.to_unit()), 0.0, epsilon = 1e-12);
            assert_relative_eq!(dot(n, v.to_unit()), 0.0, epsilon = 1e-12);
        }
    }

    #[test]
    fn zenith_evector_is_perpendicular_to_the_solar_meridian() {
        // Sun due north at 30 deg. Looking just short of the zenith, the
        // E-vector must lie east-west: the solar meridian is north-south.
        let sun = Dir::from_deg(30.0, 0.0);
        let near_zenith = Dir::from_deg(89.999, 0.0);
        let n = evector_world(sun, near_zenith).unwrap();
        assert_relative_eq!(n[1].abs(), 0.0, epsilon = 1e-6); // no north component
        assert_relative_eq!(n[2].abs(), 0.0, epsilon = 1e-4); // no vertical component
        assert_relative_eq!(n[0].abs(), 1.0, epsilon = 1e-6); // purely east-west
    }

    #[test]
    fn aolp_local_convention_worked_by_hand() {
        // Sun at altitude 30 due north; look at the eastern horizon.
        // s = (0, cos30, sin30), v = (1, 0, 0).
        // n = s x v = (0, 0.5, -cos30) = (0, 0.5, -0.8660254).
        // At v, e_az = normalize(v x up) = (0, -1, 0), e_alt = e_az x v = (0, 0, 1).
        // n . e_alt = -0.8660254, n . e_az = -0.5 -> atan2 = -150 deg = 30 deg mod 180.
        let sun = Dir::from_deg(30.0, 0.0);
        let view = Dir::from_deg(0.0, 90.0);
        let (e_alt, e_az) = local_frame(view).unwrap();
        assert_relative_eq!(e_alt[2], 1.0, epsilon = 1e-15);
        assert_relative_eq!(e_az[1], -1.0, epsilon = 1e-15);
        let psi = aolp_local_rad(sun, view).unwrap().to_degrees();
        assert_relative_eq!(psi, 30.0, epsilon = 1e-9);
    }

    #[test]
    fn local_frame_is_right_handed_and_singular_at_the_zenith() {
        let v = Dir::from_deg(23.0, 47.0);
        let (e_alt, e_az) = local_frame(v).unwrap();
        let u = v.to_unit();
        let c = cross(e_alt, e_az);
        for i in 0..3 {
            assert_relative_eq!(c[i], u[i], epsilon = 1e-12);
        }
        assert!(local_frame(Dir::from_deg(90.0, 0.0)).is_none());
        assert!(local_frame(Dir::from_deg(-90.0, 0.0)).is_none());
        assert!(aolp_local_rad(Dir::from_deg(30.0, 0.0), Dir::from_deg(90.0, 0.0)).is_none());
    }

    #[test]
    fn pattern_is_mirror_symmetric_about_the_solar_meridian() {
        let sky = RayleighSky::new(0.8);
        let sun = Dir::from_deg(42.0, 200.0);
        let mut checked = 0;
        for v in hemisphere(8, 16) {
            let Some((d1, d2, a1, a2)) = mirror_symmetry_check(&sky, sun, v) else {
                continue;
            };
            // DoLP invariant under the mirror.
            assert_relative_eq!(d1, d2, epsilon = 1e-12);
            // AoLP changes sign: a2 == -a1 modulo 180.
            assert_relative_eq!(diff180_rad(a2, -a1), 0.0, epsilon = 1e-9);
            checked += 1;
        }
        assert!(checked > 100, "only {checked} points checked");
    }

    #[test]
    fn the_only_neutral_points_are_the_sun_and_the_antisun() {
        // Scan the hemisphere and confirm DoLP falls below 1e-3 only within a
        // couple of degrees of the Sun or the anti-Sun. Babinet, Brewster and
        // Arago are absent by construction: the model has one scattering event.
        let sky = RayleighSky::default();
        let sun = Dir::from_deg(20.0, 100.0);
        let anti = sun.antipode();
        let mut low = 0usize;
        for i in 0..=180 {
            for j in 0..360 {
                let v = Dir::from_deg(-90.0 + i as f64, j as f64);
                if sky.sample(sun, v).dolp >= 1e-3 {
                    continue;
                }
                low += 1;
                let near_sun = scattering_angle_rad(sun, v).to_degrees() < 3.7;
                let near_anti = scattering_angle_rad(anti, v).to_degrees() < 3.7;
                assert!(
                    near_sun || near_anti,
                    "low DoLP at alt {} az {}: gamma {}",
                    v.alt_deg(),
                    v.az_deg(),
                    scattering_angle_rad(sun, v).to_degrees()
                );
            }
        }
        assert!(low > 0, "expected some low-DoLP points near the neutral points");
        // Exactly at the two neutral points DoLP is zero and AoLP undefined.
        for p in [sun, anti] {
            assert!(is_neutral(sun, p));
            assert_relative_eq!(sky.sample(sun, p).dolp, 0.0, epsilon = 1e-15);
            assert!(sky.sample(sun, p).aolp_local_rad.is_none());
        }
    }

    #[test]
    fn sun_and_antisun_give_an_identical_field() {
        let sky = RayleighSky::new(0.9);
        for sun in [
            Dir::from_deg(10.0, 135.0),
            Dir::from_deg(45.0, 0.0),
            Dir::from_deg(70.0, 271.0),
        ] {
            let (dd, da) = sun_antisun_degenerate(&sky, sun, &hemisphere(12, 24));
            assert!(dd < 1e-12, "DoLP differs by {dd}");
            assert!(da < 1e-9, "AoLP differs by {da} rad");
        }
    }

    #[test]
    fn radiance_proxy_is_brighter_toward_the_sun() {
        // Monotone in gamma, and asymmetric about 90 deg unlike the Rayleigh
        // phase function. That asymmetry is the only thing the optional
        // disambiguator has to work with, and it is not validated.
        let toward = relative_radiance(10f64.to_radians(), 1.0);
        let side = relative_radiance(90f64.to_radians(), 1.0);
        let away = relative_radiance(170f64.to_radians(), 1.0);
        assert!(toward > side && side > away);
        assert_relative_eq!(side, 1.5, epsilon = 1e-15);
        // The true Rayleigh phase function would be symmetric here:
        let phase = |g: f64| 1.0 + g.cos() * g.cos();
        assert_relative_eq!(
            phase(10f64.to_radians()),
            phase(170f64.to_radians()),
            epsilon = 1e-15
        );
    }

    #[test]
    fn yaw_matrix_turns_north_into_the_heading() {
        // The camera's "forward" axis (0, 1, 0) at yaw h points at azimuth h.
        let r = yaw_matrix(30f64.to_radians());
        let v = mat_vec(&r, [0.0, 1.0, 0.0]);
        let d = Dir::from_unit(v);
        assert_relative_eq!(d.az_deg(), 30.0, epsilon = 1e-12);
        assert_relative_eq!(d.alt_deg(), 0.0, epsilon = 1e-12);
        // And the transpose maps world back into the frame.
        let s = sun_in_frame(Dir::from_deg(0.0, 30.0), &crate::vec3::transpose(&r));
        assert_relative_eq!(s[1], 1.0, epsilon = 1e-12);
        assert_relative_eq!(crate::vec3::norm(scaled_unit(Dir::from_deg(0.0, 0.0), 3.0)), 3.0, epsilon = 1e-12);
    }
}
