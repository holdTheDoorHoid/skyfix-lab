//! The three frames module A uses, and the rotations between them.
//!
//! Everything in this file is radians and unit vectors. Angles that reach JSON or a
//! screen are converted at the boundary (CONVENTIONS section 1).
//!
//! # 1. Frame C — Earth-fixed of date
//!
//! The reference frame for star directions. A body with apparent geocentric
//! `GHA`/`Dec` of date (CONVENTIONS section 7) has its *geographic position* at
//! `lat = Dec`, `lon_east = -GHA` (section 2), and the unit vector of that point is
//! exactly the unit vector toward the body:
//!
//! ```text
//! x  through (lat 0, lon 0)   -- the Greenwich meridian on the equator
//! y  through (lat 0, lon 90E)
//! z  through the north celestial pole
//! ```
//!
//! This is [`skyfix_core::geometry::Point::to_unit`] applied to
//! [`skyfix_core::geometry::geographic_position`], so module A and the core solver
//! cannot disagree about where a star is.
//!
//! **This frame rotates with the Earth.** It is not an inertial or equinox-fixed frame:
//! its x axis is tied to the Greenwich meridian, so a star's coordinates in it change by
//! about 15.04 degrees per hour. An attitude expressed relative to frame C is therefore
//! only meaningful together with the instant it was measured at, and [`crate::attitude::Attitude`]
//! carries that instant in its `frame` string for exactly this reason. Two attitudes
//! taken an hour apart in the same physical orientation differ by 15 degrees in this
//! frame, and that is correct, not a bug.
//!
//! The alternative — an equinox-of-date frame with x toward the equinox — differs from
//! frame C by a rotation of `GAST` about z. Frame C was chosen because the whole
//! workspace already speaks GHA/Dec, and adding a second convention would add a sign
//! error and nothing else.
//!
//! # 2. Frame E — local ENU at the observer
//!
//! East, North, Up, right-handed, at a specific latitude and longitude:
//!
//! ```text
//! East  = (-sin lambda,            cos lambda,           0      )
//! North = (-sin phi cos lambda,   -sin phi sin lambda,   cos phi)
//! Up    = ( cos phi cos lambda,    cos phi sin lambda,   sin phi)
//! ```
//!
//! A direction at altitude `h` and true azimuth `Zn` (clockwise from north,
//! CONVENTIONS section 2) is `(cos h sin Zn, cos h cos Zn, sin h)`. Applying the ENU
//! rows above to a star's frame-C vector reproduces
//! [`skyfix_core::geometry::altitude_azimuth`] term for term; a test asserts it.
//!
//! # 3. Frame K — camera, OpenCV convention
//!
//! ```text
//! x  right across the image  (+u)
//! y  down the image          (+v)
//! z  along the optical axis, out of the lens
//! ```
//!
//! Right-handed. A direction behind the camera has `z < 0` and does not project.
//!
//! # Naming
//!
//! A rotation is named `<to>_from_<in>`: `camera_from_enu` takes an ENU vector and
//! returns a camera vector. Composition reads right to left, like the matrices.

use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{Point, geographic_position};
use std::f64::consts::TAU;

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

/// A 3-vector. Direction vectors in this crate are unit length unless stated otherwise.
pub type Vec3 = [f64; 3];

pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

/// Unit vector in the direction of `a`. A zero (or non-finite) vector is returned
/// unchanged rather than turned into `NaN`; callers that care check [`norm`] first.
pub fn normalize(a: Vec3) -> Vec3 {
    let n = norm(a);
    if n > 0.0 && n.is_finite() {
        scale(a, 1.0 / n)
    } else {
        a
    }
}

/// Angle between two vectors, radians, by `atan2(|a x b|, a . b)`. Accurate for both
/// tiny and near-180-degree angles, where `acos` of the dot product is not.
pub fn angle_between(a: Vec3, b: Vec3) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b))
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/// A proper rotation, stored as a 3x3 matrix in row-major order.
///
/// `rotate(v)[i] = rows[i] . v`. The rows of a `b_from_a` rotation are the basis
/// vectors of frame `b` written in frame `a`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rotation {
    pub rows: [[f64; 3]; 3],
}

impl Default for Rotation {
    fn default() -> Self {
        Rotation::IDENTITY
    }
}

impl Rotation {
    pub const IDENTITY: Rotation = Rotation {
        rows: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    };

    /// From three rows. The caller is trusted; [`Rotation::orthonormality_error`]
    /// measures how far the result is from a rotation.
    pub fn from_rows(x: Vec3, y: Vec3, z: Vec3) -> Self {
        Rotation { rows: [x, y, z] }
    }

    /// From three basis vectors of the *target* frame expressed in the source frame,
    /// re-orthonormalised by modified Gram-Schmidt so that rounding in the caller's
    /// construction cannot leak a non-rotation into the pipeline.
    pub fn from_basis_orthonormalized(x: Vec3, y: Vec3, z: Vec3) -> Self {
        let ex = normalize(x);
        let ey = normalize(sub(y, scale(ex, dot(ex, y))));
        let mut ez = sub(z, scale(ex, dot(ex, z)));
        ez = normalize(sub(ez, scale(ey, dot(ey, ez))));
        Rotation { rows: [ex, ey, ez] }
    }

    /// Rotation by `angle` radians about a (not necessarily unit) `axis`, right-handed.
    pub fn about_axis(axis: Vec3, angle: f64) -> Self {
        let k = normalize(axis);
        let (s, c) = angle.sin_cos();
        let t = 1.0 - c;
        let [x, y, z] = k;
        Rotation {
            rows: [
                [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
            ],
        }
    }

    /// `M v`.
    pub fn rotate(&self, v: Vec3) -> Vec3 {
        [
            dot(self.rows[0], v),
            dot(self.rows[1], v),
            dot(self.rows[2], v),
        ]
    }

    /// Inverse, which for a rotation is the transpose.
    pub fn inverse(&self) -> Self {
        let m = &self.rows;
        Rotation {
            rows: [
                [m[0][0], m[1][0], m[2][0]],
                [m[0][1], m[1][1], m[2][1]],
                [m[0][2], m[1][2], m[2][2]],
            ],
        }
    }

    /// `self . other`: apply `other` first, then `self`.
    /// `self.compose(&other).rotate(v) == self.rotate(other.rotate(v))`.
    pub fn compose(&self, other: &Rotation) -> Self {
        let mut rows = [[0.0f64; 3]; 3];
        for (i, row) in rows.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| self.rows[i][k] * other.rows[k][j]).sum();
            }
        }
        Rotation { rows }
    }

    /// Unit quaternion `[w, x, y, z]` with `w >= 0`, by Shepperd's branch selection
    /// (the largest of the four candidate denominators), which is numerically stable
    /// for every rotation including 180 degrees.
    pub fn to_quaternion(&self) -> [f64; 4] {
        let m = &self.rows;
        let trace = m[0][0] + m[1][1] + m[2][2];
        let q = if trace > 0.0 {
            let s = (trace + 1.0).sqrt() * 2.0;
            [
                0.25 * s,
                (m[2][1] - m[1][2]) / s,
                (m[0][2] - m[2][0]) / s,
                (m[1][0] - m[0][1]) / s,
            ]
        } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
            let s = (1.0 + m[0][0] - m[1][1] - m[2][2]).sqrt() * 2.0;
            [
                (m[2][1] - m[1][2]) / s,
                0.25 * s,
                (m[0][1] + m[1][0]) / s,
                (m[0][2] + m[2][0]) / s,
            ]
        } else if m[1][1] > m[2][2] {
            let s = (1.0 + m[1][1] - m[0][0] - m[2][2]).sqrt() * 2.0;
            [
                (m[0][2] - m[2][0]) / s,
                (m[0][1] + m[1][0]) / s,
                0.25 * s,
                (m[1][2] + m[2][1]) / s,
            ]
        } else {
            let s = (1.0 + m[2][2] - m[0][0] - m[1][1]).sqrt() * 2.0;
            [
                (m[1][0] - m[0][1]) / s,
                (m[0][2] + m[2][0]) / s,
                (m[1][2] + m[2][1]) / s,
                0.25 * s,
            ]
        };
        // q and -q are the same rotation; pin the sign so the value is reproducible.
        let s = if q[0] < 0.0 { -1.0 } else { 1.0 };
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        let k = if n > 0.0 { s / n } else { 1.0 };
        [q[0] * k, q[1] * k, q[2] * k, q[3] * k]
    }

    /// From a quaternion `[w, x, y, z]`, normalised on the way in.
    pub fn from_quaternion(q: [f64; 4]) -> Self {
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        if n == 0.0 || !n.is_finite() {
            return Rotation::IDENTITY;
        }
        let (w, x, y, z) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
        Rotation {
            rows: [
                [
                    1.0 - 2.0 * (y * y + z * z),
                    2.0 * (x * y - w * z),
                    2.0 * (x * z + w * y),
                ],
                [
                    2.0 * (x * y + w * z),
                    1.0 - 2.0 * (x * x + z * z),
                    2.0 * (y * z - w * x),
                ],
                [
                    2.0 * (x * z - w * y),
                    2.0 * (y * z + w * x),
                    1.0 - 2.0 * (x * x + y * y),
                ],
            ],
        }
    }

    /// Rotation angle of `self^-1 . other`, radians in `[0, pi]`: how far apart two
    /// orientations are. This is the number an attitude accuracy claim must quote.
    pub fn angle_to(&self, other: &Rotation) -> f64 {
        let d = self.inverse().compose(other);
        let trace = d.rows[0][0] + d.rows[1][1] + d.rows[2][2];
        // acos loses precision near 0; recover the angle from the skew part instead.
        let axis = [
            d.rows[2][1] - d.rows[1][2],
            d.rows[0][2] - d.rows[2][0],
            d.rows[1][0] - d.rows[0][1],
        ];
        (0.5 * norm(axis)).atan2(0.5 * (trace - 1.0))
    }

    /// `max |M^T M - I|`, a health check on a matrix that claims to be a rotation.
    pub fn orthonormality_error(&self) -> f64 {
        let p = self.inverse().compose(self);
        let mut worst = 0.0f64;
        for i in 0..3 {
            for j in 0..3 {
                let target = if i == j { 1.0 } else { 0.0 };
                worst = worst.max((p.rows[i][j] - target).abs());
            }
        }
        worst
    }

    /// Determinant. `+1` for a proper rotation, `-1` for a reflection.
    pub fn determinant(&self) -> f64 {
        let m = &self.rows;
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    }
}

// ---------------------------------------------------------------------------
// Frame C: Earth-fixed of date
// ---------------------------------------------------------------------------

/// Unit vector toward a body with apparent geocentric `gha`/`dec` of date, radians,
/// in frame C. Identical to the unit vector of the body's geographic position.
pub fn earth_fixed_from_gha_dec(gha: f64, dec: f64) -> Vec3 {
    geographic_position(gha, dec).to_unit()
}

/// The inverse: GHA and declination (radians, GHA in `[0, 2 pi)`) of a frame-C direction.
pub fn gha_dec_from_earth_fixed(v: Vec3) -> (f64, f64) {
    let p = Point::from_unit(v);
    (skyfix_core::units::norm_2pi(-p.lon), p.lat)
}

// ---------------------------------------------------------------------------
// Frame E: local ENU
// ---------------------------------------------------------------------------

/// `enu_from_earth_fixed` at the given observer: rows are East, North, Up in frame C.
pub fn enu_from_earth_fixed(observer: Point) -> Rotation {
    let (sphi, cphi) = observer.lat.sin_cos();
    let (slam, clam) = observer.lon.sin_cos();
    Rotation::from_rows(
        [-slam, clam, 0.0],
        [-sphi * clam, -sphi * slam, cphi],
        [cphi * clam, cphi * slam, sphi],
    )
}

/// ENU unit vector at altitude `alt` and true azimuth `az` (radians, azimuth clockwise
/// from north): `(cos h sin Zn, cos h cos Zn, sin h)`.
pub fn enu_from_alt_az(alt: f64, az: f64) -> Vec3 {
    let (sa, ca) = alt.sin_cos();
    let (sz, cz) = az.sin_cos();
    [ca * sz, ca * cz, sa]
}

/// Altitude and true azimuth (radians, azimuth in `[0, 2 pi)`) of an ENU direction.
/// `atan2` on the horizontal magnitude, so it keeps full precision at the zenith.
pub fn alt_az_from_enu(v: Vec3) -> (f64, f64) {
    let alt = v[2].atan2(v[0].hypot(v[1]));
    let az = skyfix_core::units::norm_2pi(v[0].atan2(v[1]));
    (alt, az)
}

// ---------------------------------------------------------------------------
// Frame K: camera
// ---------------------------------------------------------------------------

/// Camera attitude from a pointing: boresight at `alt`/`az`, rotated by `roll` about
/// its own optical axis. Radians.
///
/// At `roll = 0` the image's `+y` (down) is the direction of steepest descent in
/// altitude, so the horizon is level and below the centre — the orientation a tripod
/// gives you. Positive `roll` turns the image content counter-clockwise on screen.
///
/// Degenerate only when the boresight is exactly at the zenith or nadir, where "down in
/// the image" has no altitude meaning; there the north direction is used as the
/// reference instead and the result is continuous in `roll`.
pub fn camera_from_enu(alt: f64, az: f64, roll: f64) -> Rotation {
    let z = enu_from_alt_az(alt, az);
    let up: Vec3 = [0.0, 0.0, 1.0];
    // Component of "down" perpendicular to the boresight: (up.z) z - up.
    let mut y = sub(scale(z, dot(up, z)), up);
    if norm(y) < 1e-12 {
        // Boresight at the zenith/nadir: fall back to north as the image-down reference.
        let north: Vec3 = [0.0, 1.0, 0.0];
        y = sub(north, scale(z, dot(north, z)));
    }
    let y = normalize(y);
    let x = cross(y, z);
    let unrolled = Rotation::from_basis_orthonormalized(x, y, z);
    // Rz(roll) applied in the camera frame.
    let (s, c) = roll.sin_cos();
    let rz = Rotation::from_rows([c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]);
    rz.compose(&unrolled)
}

/// Boresight altitude, azimuth and roll (radians) of a `camera_from_enu` rotation.
/// The inverse of [`camera_from_enu`] away from the zenith.
pub fn pointing_of_camera_from_enu(r: &Rotation) -> (f64, f64, f64) {
    let inv = r.inverse();
    let z_enu = inv.rotate([0.0, 0.0, 1.0]);
    let (alt, az) = alt_az_from_enu(z_enu);
    let unrolled = camera_from_enu(alt, az, 0.0);
    // r = Rz(roll) . unrolled  =>  Rz(roll) = r . unrolled^-1.
    let rz = r.compose(&unrolled.inverse());
    let roll = skyfix_core::units::norm_pi(rz.rows[0][1].atan2(rz.rows[0][0]));
    (alt, az, roll)
}

/// Normalise an angle to `[0, 2 pi)`; re-exported for callers building pointings.
pub fn norm_tau(a: f64) -> f64 {
    let r = a % TAU;
    if r < 0.0 { r + TAU } else { r }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use skyfix_core::geometry::altitude_azimuth;
    use std::f64::consts::PI;

    const D: f64 = PI / 180.0;

    #[test]
    fn enu_of_a_star_reproduces_the_core_altitude_azimuth() {
        // The single most important consistency check in this crate: if frame E and
        // frame C disagree with skyfix_core, every altitude module A produces is wrong.
        let observer = Point::from_deg(39.9526, -75.1652);
        let e_from_c = enu_from_earth_fixed(observer);
        for (gha_deg, dec_deg) in [
            (100.0, 20.0),
            (0.0, -35.0),
            (275.3, 62.1),
            (180.0, 0.0),
            (359.9, 89.0),
        ] {
            let (gha, dec) = (gha_deg * D, dec_deg * D);
            let v_enu = e_from_c.rotate(earth_fixed_from_gha_dec(gha, dec));
            let (alt, az) = alt_az_from_enu(v_enu);
            let (alt_core, az_core) = altitude_azimuth(observer, gha, dec);
            assert_relative_eq!(alt, alt_core, epsilon = 1e-12);
            assert_relative_eq!(az, az_core, epsilon = 1e-11);
            // And the ENU vector rebuilt from alt/az is the same vector.
            let back = enu_from_alt_az(alt, az);
            for k in 0..3 {
                assert_relative_eq!(back[k], v_enu[k], epsilon = 1e-12);
            }
        }
    }

    #[test]
    fn enu_basis_is_right_handed_and_points_where_it_says() {
        let observer = Point::from_deg(0.0, 0.0);
        let r = enu_from_earth_fixed(observer);
        assert_relative_eq!(r.determinant(), 1.0, epsilon = 1e-14);
        // At (0,0): Up is +x of frame C, North is +z, East is +y.
        assert_relative_eq!(r.rows[2][0], 1.0, epsilon = 1e-15); // Up  = x
        assert_relative_eq!(r.rows[1][2], 1.0, epsilon = 1e-15); // N   = z
        assert_relative_eq!(r.rows[0][1], 1.0, epsilon = 1e-15); // E   = y
        // Frame C round trip.
        let (gha, dec) = gha_dec_from_earth_fixed(earth_fixed_from_gha_dec(200.0 * D, -12.0 * D));
        assert_relative_eq!(gha, 200.0 * D, epsilon = 1e-12);
        assert_relative_eq!(dec, -12.0 * D, epsilon = 1e-12);
    }

    #[test]
    fn alt_az_round_trip_including_the_zenith() {
        for alt_deg in [-89.0, -10.0, 0.0, 12.5, 45.0, 89.999] {
            for az_deg in [0.0, 37.0, 180.0, 250.0, 359.5] {
                let v = enu_from_alt_az(alt_deg * D, az_deg * D);
                assert_relative_eq!(norm(v), 1.0, epsilon = 1e-15);
                let (a, z) = alt_az_from_enu(v);
                assert_relative_eq!(a, alt_deg * D, epsilon = 1e-12);
                assert_relative_eq!(z, az_deg * D, epsilon = 1e-10);
            }
        }
        // Exactly at the zenith the azimuth is undefined but the altitude is not.
        let (a, _) = alt_az_from_enu([0.0, 0.0, 1.0]);
        assert_relative_eq!(a, PI / 2.0, epsilon = 1e-15);
    }

    #[test]
    fn rotation_algebra() {
        let a = Rotation::about_axis([0.0, 0.0, 1.0], 30.0 * D);
        let b = Rotation::about_axis([1.0, 2.0, 3.0], -67.0 * D);
        let v: Vec3 = [0.3, -0.5, 0.81];
        // compose applies the right-hand factor first.
        let lhs = a.compose(&b).rotate(v);
        let rhs = a.rotate(b.rotate(v));
        for k in 0..3 {
            assert_relative_eq!(lhs[k], rhs[k], epsilon = 1e-14);
        }
        // inverse, determinant, orthonormality.
        let id = a.compose(&a.inverse());
        assert!(id.angle_to(&Rotation::IDENTITY) < 1e-14);
        assert_relative_eq!(b.determinant(), 1.0, epsilon = 1e-14);
        assert!(b.orthonormality_error() < 1e-14);
        // Rotating preserves length and angles.
        assert_relative_eq!(norm(b.rotate(v)), norm(v), epsilon = 1e-14);
        let w: Vec3 = [-0.2, 0.9, 0.1];
        assert_relative_eq!(
            angle_between(b.rotate(v), b.rotate(w)),
            angle_between(v, w),
            epsilon = 1e-13
        );
    }

    #[test]
    fn quaternion_round_trip_and_angle_between_rotations() {
        let cases = [
            Rotation::IDENTITY,
            Rotation::about_axis([0.0, 0.0, 1.0], 179.999 * D),
            Rotation::about_axis([1.0, 0.0, 0.0], 180.0 * D),
            Rotation::about_axis([0.3, -0.7, 0.2], 121.0 * D),
            Rotation::about_axis([0.0, 1.0, 0.0], 1e-9),
        ];
        for r in cases {
            let q = r.to_quaternion();
            assert_relative_eq!(
                (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt(),
                1.0,
                epsilon = 1e-14
            );
            assert!(q[0] >= 0.0, "quaternion sign is not pinned: {q:?}");
            let back = Rotation::from_quaternion(q);
            assert!(
                r.angle_to(&back) < 1e-13,
                "quaternion round trip lost {} rad",
                r.angle_to(&back)
            );
        }
        // angle_to measures the relative rotation, in both directions.
        let a = Rotation::about_axis([0.0, 0.0, 1.0], 10.0 * D);
        let b = Rotation::about_axis([0.0, 0.0, 1.0], 47.0 * D);
        assert_relative_eq!(a.angle_to(&b), 37.0 * D, epsilon = 1e-13);
        assert_relative_eq!(b.angle_to(&a), 37.0 * D, epsilon = 1e-13);
        assert_relative_eq!(a.angle_to(&a), 0.0, epsilon = 1e-15);
        // Tiny angles survive: acos(trace) would round this to zero.
        let tiny = Rotation::about_axis([0.0, 1.0, 0.0], 1e-9);
        assert_relative_eq!(Rotation::IDENTITY.angle_to(&tiny), 1e-9, epsilon = 1e-15);
    }

    #[test]
    fn camera_pointing_round_trip_and_image_down_is_toward_the_horizon() {
        for (alt_deg, az_deg, roll_deg) in [
            (45.0, 250.0, 0.0),
            (10.0, 5.0, 12.0),
            (70.0, 180.0, -95.0),
            (0.0, 90.0, 179.0),
        ] {
            let r = camera_from_enu(alt_deg * D, az_deg * D, roll_deg * D);
            assert_relative_eq!(r.determinant(), 1.0, epsilon = 1e-13);
            assert!(r.orthonormality_error() < 1e-13);
            let (a, z, roll) = pointing_of_camera_from_enu(&r);
            assert_relative_eq!(a, alt_deg * D, epsilon = 1e-11);
            assert_relative_eq!(z, az_deg * D, epsilon = 1e-11);
            assert_relative_eq!(
                roll,
                skyfix_core::units::norm_pi(roll_deg * D),
                epsilon = 1e-11
            );
            // The boresight is the camera's +z.
            let bore = r.inverse().rotate([0.0, 0.0, 1.0]);
            let want = enu_from_alt_az(alt_deg * D, az_deg * D);
            for k in 0..3 {
                assert_relative_eq!(bore[k], want[k], epsilon = 1e-13);
            }
        }
        // At roll 0 the image's +y axis has a negative Up component: down is down.
        let r = camera_from_enu(45.0 * D, 250.0 * D, 0.0);
        let y_enu = r.inverse().rotate([0.0, 1.0, 0.0]);
        assert!(y_enu[2] < 0.0, "image +y should point toward the horizon");
        // ... and +x is horizontal (no Up component) when the roll is zero.
        let x_enu = r.inverse().rotate([1.0, 0.0, 0.0]);
        assert_relative_eq!(x_enu[2], 0.0, epsilon = 1e-14);
    }

    #[test]
    fn a_star_straight_up_the_boresight_lands_on_the_optical_axis() {
        let observer = Point::from_deg(39.9526, -75.1652);
        let e_from_c = enu_from_earth_fixed(observer);
        // Pick a direction, point the camera at it, and confirm it is the camera +z.
        let (gha, dec) = (100.0 * D, 20.0 * D);
        let v_enu = e_from_c.rotate(earth_fixed_from_gha_dec(gha, dec));
        let (alt, az) = alt_az_from_enu(v_enu);
        let k_from_e = camera_from_enu(alt, az, 25.0 * D);
        let v_cam = k_from_e.rotate(v_enu);
        assert_relative_eq!(v_cam[0], 0.0, epsilon = 1e-14);
        assert_relative_eq!(v_cam[1], 0.0, epsilon = 1e-14);
        assert_relative_eq!(v_cam[2], 1.0, epsilon = 1e-14);
    }

    #[test]
    fn frame_c_rotates_with_the_earth_by_about_fifteen_degrees_an_hour() {
        // Documented in the module header; asserted here so the claim cannot rot.
        // A fixed physical orientation an hour later differs by one hour of rotation.
        let observer = Point::from_deg(39.9526, -75.1652);
        let e_from_c = enu_from_earth_fixed(observer);
        let k_from_e = camera_from_enu(45.0 * D, 250.0 * D, 0.0);
        let k_from_c_now = k_from_e.compose(&e_from_c);
        // One sidereal hour later the same stars sit where the Earth-fixed frame has
        // turned SIDEREAL_RATE degrees about the pole; the camera has not moved.
        let turn = Rotation::about_axis(
            [0.0, 0.0, 1.0],
            -skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR * D,
        );
        let k_from_c_later = k_from_c_now.compose(&turn);
        let moved = k_from_c_now.angle_to(&k_from_c_later).to_degrees();
        assert_relative_eq!(
            moved,
            skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR,
            epsilon = 1e-9
        );
    }

    #[test]
    fn normalize_and_angle_helpers_are_defensive() {
        assert_eq!(normalize([0.0, 0.0, 0.0]), [0.0, 0.0, 0.0]);
        assert_relative_eq!(angle_between([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]), 0.0);
        assert_relative_eq!(
            angle_between([1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]),
            PI,
            epsilon = 1e-15
        );
        // Near-antiparallel: acos(dot) would return exactly pi and lose the difference.
        let eps = 1e-8;
        let a: Vec3 = [1.0, 0.0, 0.0];
        let b: Vec3 = normalize([-1.0, eps, 0.0]);
        assert_relative_eq!(angle_between(a, b), PI - eps, epsilon = 1e-15);
        assert_relative_eq!(norm_tau(-0.5), TAU - 0.5, epsilon = 1e-15);
        // add/sub/scale are used all over the crate; check them once.
        assert_eq!(add([1.0, 2.0, 3.0], [4.0, 5.0, 6.0]), [5.0, 7.0, 9.0]);
        assert_eq!(sub([1.0, 2.0, 3.0], [4.0, 5.0, 6.0]), [-3.0, -3.0, -3.0]);
        assert_eq!(scale([1.0, 2.0, 3.0], 2.0), [2.0, 4.0, 6.0]);
        assert_relative_eq!(dot([1.0, 2.0, 3.0], [4.0, 5.0, 6.0]), 32.0);
        assert_eq!(cross([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]), [0.0, 0.0, 1.0]);
        assert_eq!(Rotation::default(), Rotation::IDENTITY);
        assert_eq!(
            Rotation::from_quaternion([0.0, 0.0, 0.0, 0.0]),
            Rotation::IDENTITY
        );
    }
}
