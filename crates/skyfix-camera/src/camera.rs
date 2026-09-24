//! Pinhole camera with optional radial distortion (OpenCV convention).
//!
//! # Pixel convention
//!
//! Pixel `(i, j)` — column `i`, row `j` — has its **centre** at `(u, v) = (i, j)`. The
//! sensor therefore spans `u in [-0.5, width - 0.5]` and `v in [-0.5, height - 0.5]`,
//! and a centred principal point is `cx = (width - 1) / 2`. This is OpenCV's convention
//! and the one every centroid in this crate reports in.
//!
//! # Projection
//!
//! ```text
//! (X, Y, Z) in the camera frame, Z > 0
//! x = X / Z,  y = Y / Z
//! r2 = x^2 + y^2
//! radial = 1 + k1 r2 + k2 r2^2
//! u = fx (x radial) + cx
//! v = fy (y radial) + cy
//! ```
//!
//! Only the two radial terms are modelled. No tangential (decentring) terms, no
//! thin-prism terms, no rolling shutter: a real lens needs all of those calibrated from
//! images of a target, and `docs/CAMERA.md` lists that as backlog. Two radial
//! coefficients are enough to show that the undistortion loop closes and that the
//! pipeline does not silently assume a perfect lens.
//!
//! Unprojection inverts the radial polynomial by fixed-point iteration. The iteration
//! contracts with factor `|d(radial)/d(r) * r / radial|`, which is well under 1 for any
//! distortion a navigation lens would have; [`Intrinsics::unproject`] iterates to
//! machine precision or 64 steps, whichever comes first.

use crate::frames::{Vec3, normalize};
use serde::{Deserialize, Serialize};

/// Pinhole intrinsics in pixels, plus the image size the projection is clipped to.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Intrinsics {
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
    pub width: usize,
    pub height: usize,
    /// First radial distortion coefficient. Zero for an ideal pinhole.
    #[serde(default)]
    pub k1: f64,
    /// Second radial distortion coefficient.
    #[serde(default)]
    pub k2: f64,
}

impl Intrinsics {
    /// Square pixels, centred principal point, given **horizontal** field of view
    /// (radians, full angle across the sensor width).
    pub fn from_horizontal_fov(width: usize, height: usize, fov_rad: f64) -> Self {
        let f = (width as f64 / 2.0) / (fov_rad / 2.0).tan();
        Intrinsics::new(f, f, width, height)
    }

    /// Square pixels, centred principal point, given **diagonal** field of view.
    pub fn from_diagonal_fov(width: usize, height: usize, fov_rad: f64) -> Self {
        let diag = (width as f64).hypot(height as f64);
        let f = (diag / 2.0) / (fov_rad / 2.0).tan();
        Intrinsics::new(f, f, width, height)
    }

    /// Explicit focal lengths, centred principal point, no distortion.
    pub fn new(fx: f64, fy: f64, width: usize, height: usize) -> Self {
        Intrinsics {
            fx,
            fy,
            cx: (width as f64 - 1.0) / 2.0,
            cy: (height as f64 - 1.0) / 2.0,
            width,
            height,
            k1: 0.0,
            k2: 0.0,
        }
    }

    /// The same intrinsics with radial distortion coefficients.
    pub fn with_distortion(mut self, k1: f64, k2: f64) -> Self {
        self.k1 = k1;
        self.k2 = k2;
        self
    }

    /// Horizontal field of view, radians (ignores distortion).
    pub fn horizontal_fov_rad(&self) -> f64 {
        2.0 * ((self.width as f64 / 2.0) / self.fx).atan()
    }

    /// Vertical field of view, radians (ignores distortion).
    pub fn vertical_fov_rad(&self) -> f64 {
        2.0 * ((self.height as f64 / 2.0) / self.fy).atan()
    }

    /// Diagonal field of view, radians (ignores distortion).
    pub fn diagonal_fov_rad(&self) -> f64 {
        let hx = (self.width as f64 / 2.0) / self.fx;
        let hy = (self.height as f64 / 2.0) / self.fy;
        2.0 * hx.hypot(hy).atan()
    }

    /// Nominal angular size of one pixel at the image centre, radians.
    pub fn nominal_ifov_rad(&self) -> f64 {
        1.0 / (self.fx * self.fy).sqrt()
    }

    /// True when `(u, v)` lies on the sensor, pixel centres at integer coordinates.
    pub fn contains(&self, u: f64, v: f64) -> bool {
        u >= -0.5 && v >= -0.5 && u <= self.width as f64 - 0.5 && v <= self.height as f64 - 0.5
    }

    /// Project a camera-frame direction to pixels.
    ///
    /// `None` when the direction is behind the camera (`z <= 0`), when the vector is
    /// degenerate or non-finite, or when the projected point falls outside the sensor.
    pub fn project(&self, dir_camera: Vec3) -> Option<(f64, f64)> {
        let [x, y, z] = dir_camera;
        if !x.is_finite() || !y.is_finite() || !z.is_finite() || z <= 0.0 {
            return None;
        }
        let (xn, yn) = (x / z, y / z);
        let r2 = xn * xn + yn * yn;
        let radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2;
        let u = self.fx * xn * radial + self.cx;
        let v = self.fy * yn * radial + self.cy;
        if !u.is_finite() || !v.is_finite() || !self.contains(u, v) {
            return None;
        }
        Some((u, v))
    }

    /// Project without clipping to the sensor. Still `None` behind the camera.
    /// Used by the renderer to place the PSF of a star whose centre is just off the
    /// edge but whose wings are not.
    pub fn project_unclipped(&self, dir_camera: Vec3) -> Option<(f64, f64)> {
        let [x, y, z] = dir_camera;
        if !x.is_finite() || !y.is_finite() || !z.is_finite() || z <= 0.0 {
            return None;
        }
        let (xn, yn) = (x / z, y / z);
        let r2 = xn * xn + yn * yn;
        let radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2;
        let u = self.fx * xn * radial + self.cx;
        let v = self.fy * yn * radial + self.cy;
        if u.is_finite() && v.is_finite() {
            Some((u, v))
        } else {
            None
        }
    }

    /// Unit direction in the camera frame for a pixel coordinate, undistorted.
    ///
    /// Always succeeds: every pixel has a ray. Off-sensor coordinates are accepted so
    /// that gradients and windows can run past the edge.
    pub fn unproject(&self, u: f64, v: f64) -> Vec3 {
        let xd = (u - self.cx) / self.fx;
        let yd = (v - self.cy) / self.fy;
        let (x, y) = self.undistort_normalized(xd, yd);
        normalize([x, y, 1.0])
    }

    /// Invert the radial polynomial: given distorted normalised coordinates, return the
    /// ideal pinhole ones. Exact (and free) when `k1 = k2 = 0`.
    fn undistort_normalized(&self, xd: f64, yd: f64) -> (f64, f64) {
        if self.k1 == 0.0 && self.k2 == 0.0 {
            return (xd, yd);
        }
        let (mut x, mut y) = (xd, yd);
        for _ in 0..64 {
            let r2 = x * x + y * y;
            let radial = 1.0 + self.k1 * r2 + self.k2 * r2 * r2;
            if !(radial.abs() > 1e-12) {
                // A distortion this strong folds the image over; give up on refining
                // and return the last sane iterate rather than an infinity.
                break;
            }
            let nx = xd / radial;
            let ny = yd / radial;
            let moved = (nx - x).abs().max((ny - y).abs());
            x = nx;
            y = ny;
            if moved == 0.0 {
                break;
            }
        }
        (x, y)
    }

    /// Angular size of one pixel at `(u, v)`, radians: the larger of the angles
    /// subtended by a one-pixel step in `u` and in `v`. Measured through
    /// [`Intrinsics::unproject`], so it includes distortion.
    ///
    /// This is the number that turns a centroid uncertainty in pixels into an angular
    /// uncertainty, which is how [`crate::sights`] builds `sigma_arcmin`.
    pub fn angular_scale_at(&self, u: f64, v: f64) -> f64 {
        let c = self.unproject(u, v);
        let du = crate::frames::angle_between(c, self.unproject(u + 0.5, v))
            + crate::frames::angle_between(c, self.unproject(u - 0.5, v));
        let dv = crate::frames::angle_between(c, self.unproject(u, v + 0.5))
            + crate::frames::angle_between(c, self.unproject(u, v - 0.5));
        du.max(dv)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{Vec3, angle_between, norm};
    use approx::assert_relative_eq;
    use std::f64::consts::PI;

    fn sample_pixels(k: &Intrinsics) -> Vec<(f64, f64)> {
        let mut out = Vec::new();
        for i in 0..7 {
            for j in 0..5 {
                let u = i as f64 * (k.width as f64 - 1.0) / 6.0;
                let v = j as f64 * (k.height as f64 - 1.0) / 4.0;
                out.push((u, v));
            }
        }
        out.push((k.cx, k.cy));
        out.push((123.25, 456.75));
        out
    }

    #[test]
    fn project_unproject_round_trip_is_exact_for_a_pinhole() {
        let k = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians());
        for (u, v) in sample_pixels(&k) {
            let d = k.unproject(u, v);
            assert_relative_eq!(norm(d), 1.0, epsilon = 1e-15);
            let (u2, v2) = k.project(d).expect("forward ray must project back");
            assert_relative_eq!(u2, u, epsilon = 1e-9);
            assert_relative_eq!(v2, v, epsilon = 1e-9);
        }
    }

    #[test]
    fn project_unproject_round_trip_with_distortion() {
        let k = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians())
            .with_distortion(-0.08, 0.012);
        for (u, v) in sample_pixels(&k) {
            let d = k.unproject(u, v);
            let (u2, v2) = k.project(d).expect("forward ray must project back");
            assert_relative_eq!(u2, u, epsilon = 1e-9);
            assert_relative_eq!(v2, v, epsilon = 1e-9);
        }
        // And the other way round: direction -> pixels -> direction.
        for (u, v) in sample_pixels(&k) {
            let d = k.unproject(u, v);
            let (uu, vv) = k.project(d).unwrap();
            let back = k.unproject(uu, vv);
            assert!(
                angle_between(d, back) < 1e-12,
                "direction round trip lost {} rad",
                angle_between(d, back)
            );
        }
        // Distortion is actually doing something: without it the pixels would differ.
        let ideal = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians());
        let corner: Vec3 = ideal.unproject(0.0, 0.0);
        let (ud, _) = k.project(corner).unwrap();
        assert!(
            (ud - 0.0).abs() > 5.0,
            "k1 = -0.08 should move the corner by many pixels, moved {ud}"
        );
    }

    #[test]
    fn projection_rejects_what_it_must() {
        let k = Intrinsics::from_horizontal_fov(64, 48, 40f64.to_radians());
        assert_eq!(k.project([0.0, 0.0, -1.0]), None, "behind the camera");
        assert_eq!(k.project([0.0, 0.0, 0.0]), None, "in the lens plane");
        assert_eq!(k.project([f64::NAN, 0.0, 1.0]), None);
        assert_eq!(k.project([0.0, f64::INFINITY, 1.0]), None);
        // Far off to the side: on the sensor's plane but outside the sensor.
        assert_eq!(k.project([10.0, 0.0, 1.0]), None);
        assert!(k.project_unclipped([10.0, 0.0, 1.0]).is_some());
        assert_eq!(k.project_unclipped([0.0, 0.0, -1.0]), None);
        // The extreme corners are inside, one pixel further out is not.
        assert!(k.contains(-0.5, -0.5));
        assert!(k.contains(63.5, 47.5));
        assert!(!k.contains(-0.5001, 0.0));
        assert!(!k.contains(0.0, 47.5001));
    }

    #[test]
    fn field_of_view_helpers_agree_with_the_constructors() {
        let k = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians());
        assert_relative_eq!(k.horizontal_fov_rad().to_degrees(), 40.0, epsilon = 1e-12);
        // 768/1024 of the tangent, not of the angle.
        let want_v = 2.0 * ((384.0 / k.fx).atan()).to_degrees();
        assert_relative_eq!(k.vertical_fov_rad().to_degrees(), want_v, epsilon = 1e-12);
        assert!(k.diagonal_fov_rad() > k.horizontal_fov_rad());
        let d = Intrinsics::from_diagonal_fov(1024, 768, 40f64.to_radians());
        assert_relative_eq!(d.diagonal_fov_rad().to_degrees(), 40.0, epsilon = 1e-12);
        assert!(d.horizontal_fov_rad() < d.diagonal_fov_rad());
        // The ray through the exact centre of the sensor is the optical axis.
        let axis = k.unproject(k.cx, k.cy);
        assert_relative_eq!(axis[2], 1.0, epsilon = 1e-15);
        // A pixel at the half-FOV edge is at half the FOV from the axis.
        let edge = k.unproject(k.width as f64 - 0.5, k.cy);
        assert_relative_eq!(
            angle_between(axis, edge),
            20f64.to_radians(),
            epsilon = 1e-12
        );
    }

    #[test]
    fn angular_scale_matches_the_focal_length_at_the_centre() {
        let k = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians());
        let s = k.angular_scale_at(k.cx, k.cy);
        assert_relative_eq!(s, 1.0 / k.fx, epsilon = 1e-9);
        assert_relative_eq!(k.nominal_ifov_rad(), 1.0 / k.fx, epsilon = 1e-15);
        // Off axis a pixel subtends LESS angle (the tangent plane stretches).
        let corner = k.angular_scale_at(0.0, 0.0);
        assert!(corner < s, "off-axis pixel should subtend less: {corner} vs {s}");
        // Sanity in familiar units: 40 deg over 1024 px is about 2.44 arcmin/px.
        assert_relative_eq!(s.to_degrees() * 60.0, 2.444, max_relative = 0.01);
    }

    #[test]
    fn a_pathological_distortion_does_not_produce_nan() {
        // Folded-over lens: the radial polynomial has a zero inside the image.
        let k = Intrinsics::from_horizontal_fov(64, 48, 90f64.to_radians())
            .with_distortion(-4.0, 0.0);
        let d = k.unproject(0.0, 0.0);
        assert!(d.iter().all(|c| c.is_finite()), "unproject produced {d:?}");
        assert_relative_eq!(norm(d), 1.0, epsilon = 1e-12);
        // 180-degree FOV pixel rays stay in front of the camera by construction.
        assert!(d[2] > 0.0);
        assert!(k.horizontal_fov_rad() < PI);
    }
}
