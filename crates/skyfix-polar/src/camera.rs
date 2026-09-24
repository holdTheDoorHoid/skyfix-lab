//! Upward-looking fisheye polarization camera: projection, extrinsics, and the
//! synthesis of four analyzer images.
//!
//! **Everything this module produces is synthetic.** The sky it photographs is
//! the ideal single-scattering model in [`crate::sky`], which is a stress model
//! rather than validated atmosphere physics. The degradations below are
//! parametric stand-ins for real defects, not measurements of any real lens,
//! sensor or cloud field.
//!
//! # Frames, in one place
//!
//! **World frame** — right-handed `(east, north, up)`. A direction is
//! `(altitude, azimuth)` with azimuth clockwise from north, as in
//! `docs/CONVENTIONS.md` section 2.
//!
//! **Camera body frame** — right-handed `(x, y, z)` =
//! `(image right, image up, optical axis)`. The optical axis points *out of the
//! lens at the sky*, so `x cross y = z` holds with `z` toward the scene.
//!
//! **Image plane** — a pixel at column `c`, row `r` has
//! `x_img = c - center_x` (to the right) and `y_img = center_y - r` (upward;
//! row 0 is the top row). Its polar angle is
//!
//! ```text
//! phi = atan2(x_img, y_img)
//! ```
//!
//! measured **from image up toward image right**. That is the same sense in
//! which azimuth is measured from north toward east, which is what makes a
//! zero-tilt camera at heading 0 map image-up to north and image-right to east.
//!
//! **Analyzer angles** use the same zero and the same sense: an analyzer at
//! 0 deg transmits light polarized along image up, at 90 deg along image right.
//!
//! # Projection
//!
//! Equidistant fisheye, `r_px = f * theta` with `f = radius_px / (fov/2)`. The
//! angle from the optical axis is therefore linear in image radius. Pixels
//! outside the image circle are not sky.
//!
//! # Extrinsic rotation order
//!
//! ```text
//! v_world = R_yaw(heading) * R_pitch(pitch) * R_roll(roll) * v_camera
//! ```
//!
//! Tilt first, then heading, as three right-handed factors:
//!
//! * `R_roll(roll)` rotates about the optical axis `z`. Positive roll turns the
//!   camera body counter-clockwise about its own line of sight, which makes the
//!   scene appear to rotate clockwise in the image.
//! * `R_pitch(pitch)` rotates about `x` such that **positive pitch tips the
//!   optical axis toward image up**, i.e. toward the heading direction. A
//!   levelled upward-looking camera at pitch `p` and heading `h` has its
//!   optical axis at altitude `90 - p` and azimuth `h`.
//! * `R_yaw(heading)` rotates about the world vertical; heading is clockwise
//!   from north, so image up points at azimuth `heading`.
//!
//! # The transform that actually matters
//!
//! The camera-frame polarization field depends on the Sun **only** through the
//! Sun direction expressed in the camera body frame:
//!
//! ```text
//! n_cam = R^T (s x R c) = (R^T s) x c
//! ```
//!
//! because a rotation commutes with the cross product. `heading.rs` uses this
//! to evaluate a whole trial heading with one 3x3 multiply. It is also why
//! getting this rotation wrong is invisible in a zenith-only test and obvious
//! over a wide field: most real bugs in polarization compasses live here.

use crate::angles::wrap180_rad;
use crate::rng::Rng;
use crate::sky::{Dir, RayleighSky, relative_radiance, yaw_matrix};
use crate::vec3::{Mat3, Vec3, cross, dot, mat_mul, mat_vec, norm, transpose};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// The conventional four analyzer angles, degrees in the pixel frame.
pub const DEFAULT_ANALYZERS_DEG: [f64; 4] = [0.0, 45.0, 90.0, 135.0];

// ---------------------------------------------------------------------------
// View geometry, shared with the few-channel sensor
// ---------------------------------------------------------------------------

/// The geometry of one line of sight in the camera body frame.
///
/// Shared by [`FisheyeIntrinsics::pixel_geom`] and by
/// [`crate::sensor`], so that a photodiode aimed at the direction of a pixel,
/// carrying the same analyzer angle, records exactly that pixel's intensity.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewGeom {
    /// Angle from the optical axis `+z`, radians.
    pub theta_rad: f64,
    /// Image polar angle, radians, from `+y` (image up) toward `+x`
    /// (image right). Defined as 0 on the optical axis.
    pub phi_rad: f64,
    /// Unit line of sight in the body frame.
    pub dir: Vec3,
    /// Unit tangent along increasing `theta` (outward radial in the image).
    pub t_theta: Vec3,
    /// Unit tangent along increasing `phi` (tangential in the image).
    pub t_phi: Vec3,
}

impl ViewGeom {
    pub fn from_theta_phi(theta_rad: f64, phi_rad: f64) -> Self {
        let (st, ct) = theta_rad.sin_cos();
        let (sp, cp) = phi_rad.sin_cos();
        ViewGeom {
            theta_rad,
            phi_rad,
            dir: [st * sp, st * cp, ct],
            t_theta: [ct * sp, ct * cp, -st],
            t_phi: [cp, -sp, 0.0],
        }
    }

    /// A line of sight given as a body-frame `(altitude, azimuth)` pair:
    /// `theta = 90 deg - altitude`, `phi = azimuth`.
    pub fn from_body_dir(d: Dir) -> Self {
        Self::from_theta_phi(PI / 2.0 - d.alt_rad, d.az_rad)
    }

    /// Scattering angle for a Sun direction already expressed in the body
    /// frame (unit vector).
    pub fn gamma_rad(&self, sun_body: Vec3) -> f64 {
        norm(cross(sun_body, self.dir)).atan2(dot(sun_body, self.dir))
    }

    /// AoLP in the **pixel frame**, radians in `[0, pi)`, for a Sun direction
    /// already expressed in the body frame.
    ///
    /// Derivation: the E-vector in the body frame is `n = sun_body x dir`. Its
    /// components on `(t_theta, t_phi)` map to the image-plane directions
    /// `(sin phi, cos phi)` (outward radial) and `(cos phi, -sin phi)`
    /// (tangential), and the sum collapses to
    ///
    /// ```text
    /// psi_pixel = phi + atan2(n . t_phi, n . t_theta)   (mod 180 deg)
    /// ```
    ///
    /// `None` at a neutral point, where `n` vanishes.
    pub fn aolp_rad(&self, sun_body: Vec3) -> Option<f64> {
        let n = cross(sun_body, self.dir);
        if norm(n) < crate::sky::NEUTRAL_TOL {
            return None;
        }
        Some(wrap180_rad(
            self.phi_rad + dot(n, self.t_phi).atan2(dot(n, self.t_theta)),
        ))
    }
}

// ---------------------------------------------------------------------------
// Intrinsics
// ---------------------------------------------------------------------------

/// Equidistant fisheye intrinsics on a `width x height` pixel grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FisheyeIntrinsics {
    pub width: usize,
    pub height: usize,
    /// Full field of view in degrees, `(0, 180]`.
    pub fov_deg: f64,
    /// Image radius in pixels that corresponds to `fov_deg / 2`.
    pub radius_px: f64,
    pub center_x: f64,
    pub center_y: f64,
}

impl FisheyeIntrinsics {
    /// Centred image circle inscribed in the grid. `fov_deg` is clamped to
    /// `(0, 180]`: the model has no sky below the horizon.
    pub fn new(width: usize, height: usize, fov_deg: f64) -> Self {
        FisheyeIntrinsics {
            width,
            height,
            fov_deg: fov_deg.clamp(1e-6, 180.0),
            radius_px: width.min(height) as f64 / 2.0,
            center_x: (width as f64 - 1.0) / 2.0,
            center_y: (height as f64 - 1.0) / 2.0,
        }
    }

    pub fn pixel_count(&self) -> usize {
        self.width * self.height
    }

    #[inline]
    pub fn index(&self, col: usize, row: usize) -> usize {
        row * self.width + col
    }

    /// Image-plane offset of a pixel centre: `(x_img right, y_img up)`.
    #[inline]
    pub fn image_offset(&self, col: usize, row: usize) -> (f64, f64) {
        (col as f64 - self.center_x, self.center_y - row as f64)
    }

    /// Body-frame geometry of a pixel, or `None` when the pixel falls outside
    /// the image circle (not sky).
    pub fn pixel_geom(&self, col: usize, row: usize) -> Option<ViewGeom> {
        let (x, y) = self.image_offset(col, row);
        let r = x.hypot(y);
        if r > self.radius_px {
            return None;
        }
        let theta = (r / self.radius_px) * (self.fov_deg.to_radians() / 2.0);
        // atan2(0, 0) == 0, which is the documented convention on axis.
        Some(ViewGeom::from_theta_phi(theta, x.atan2(y)))
    }
}

// ---------------------------------------------------------------------------
// Extrinsics
// ---------------------------------------------------------------------------

/// Camera attitude. Degrees, because this is an I/O boundary
/// (CONVENTIONS section 1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Extrinsics {
    /// Yaw, clockwise from north.
    pub heading_deg: f64,
    /// Tips the optical axis toward image up, i.e. toward the heading.
    pub pitch_deg: f64,
    /// Rotation about the optical axis.
    pub roll_deg: f64,
}

impl Default for Extrinsics {
    fn default() -> Self {
        Extrinsics {
            heading_deg: 0.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
        }
    }
}

impl Extrinsics {
    pub fn new(heading_deg: f64, pitch_deg: f64, roll_deg: f64) -> Self {
        Extrinsics {
            heading_deg,
            pitch_deg,
            roll_deg,
        }
    }

    pub fn level(heading_deg: f64) -> Self {
        Extrinsics::new(heading_deg, 0.0, 0.0)
    }

    /// Rotation about the optical axis `z`, right-handed.
    pub fn roll_matrix(roll_rad: f64) -> Mat3 {
        let (s, c) = roll_rad.sin_cos();
        [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
    }

    /// Rotation about `x` that tips the optical axis toward `+y` (image up).
    pub fn pitch_matrix(pitch_rad: f64) -> Mat3 {
        let (s, c) = pitch_rad.sin_cos();
        [[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]]
    }

    /// `R = R_yaw * R_pitch * R_roll`: body frame to world frame.
    pub fn rotation(&self) -> Mat3 {
        Self::tilt_then_yaw(
            self.heading_deg.to_radians(),
            self.pitch_deg.to_radians(),
            self.roll_deg.to_radians(),
        )
    }

    pub fn tilt_then_yaw(heading_rad: f64, pitch_rad: f64, roll_rad: f64) -> Mat3 {
        mat_mul(
            &yaw_matrix(heading_rad),
            &mat_mul(
                &Self::pitch_matrix(pitch_rad),
                &Self::roll_matrix(roll_rad),
            ),
        )
    }

    /// World frame to body frame.
    pub fn rotation_inverse(&self) -> Mat3 {
        transpose(&self.rotation())
    }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/// Intrinsics plus attitude.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    pub intrinsics: FisheyeIntrinsics,
    pub extrinsics: Extrinsics,
}

impl Camera {
    pub fn new(intrinsics: FisheyeIntrinsics, extrinsics: Extrinsics) -> Self {
        Camera {
            intrinsics,
            extrinsics,
        }
    }

    /// World direction seen by a pixel, or `None` outside the image circle.
    pub fn pixel_to_world(&self, col: usize, row: usize) -> Option<Dir> {
        let g = self.intrinsics.pixel_geom(col, row)?;
        Some(Dir::from_unit(mat_vec(&self.extrinsics.rotation(), g.dir)))
    }

    /// The Sun direction expressed in the camera body frame. Every prediction
    /// in this crate goes through this one vector.
    pub fn sun_in_body(&self, sun: Dir) -> Vec3 {
        mat_vec(&self.extrinsics.rotation_inverse(), sun.to_unit())
    }
}

// ---------------------------------------------------------------------------
// Scene and degradations
// ---------------------------------------------------------------------------

/// Radiance (total intensity `I0`) model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RadianceModel {
    /// Constant radiance everywhere. The honest default: this crate makes no
    /// claim to model sky brightness.
    Uniform { i0: f64 },
    /// `i0 * (1 + k (1 + cos gamma) / 2)`: brighter toward the Sun.
    /// **Simplified, not validated** (see [`relative_radiance`]).
    SunGradient { i0: f64, k: f64 },
}

impl Default for RadianceModel {
    fn default() -> Self {
        RadianceModel::Uniform { i0: 1.0 }
    }
}

impl RadianceModel {
    pub fn i0(&self, gamma_rad: f64) -> f64 {
        match *self {
            RadianceModel::Uniform { i0 } => i0,
            RadianceModel::SunGradient { i0, k } => i0 * relative_radiance(gamma_rad, k),
        }
    }

    /// True when the model carries a Sun/anti-Sun asymmetry that an estimator
    /// could exploit.
    pub fn has_sun_gradient(&self) -> bool {
        matches!(self, RadianceModel::SunGradient { k, .. } if *k != 0.0)
    }
}

/// What the camera is pointed at.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    pub sky: RayleighSky,
    /// True Sun direction in the world frame.
    pub sun: Dir,
    pub radiance: RadianceModel,
}

impl Scene {
    pub fn new(sun: Dir) -> Self {
        Scene {
            sky: RayleighSky::default(),
            sun,
            radiance: RadianceModel::default(),
        }
    }
}

/// A region of the image plane, in pixel coordinates (column, row; row 0 is the
/// top row). Bounds are inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "snake_case")]
pub enum PixelRegion {
    Circle { cx: f64, cy: f64, radius_px: f64 },
    Rect { x0: f64, y0: f64, x1: f64, y1: f64 },
}

impl PixelRegion {
    pub fn contains(&self, col: usize, row: usize) -> bool {
        let (c, r) = (col as f64, row as f64);
        match *self {
            PixelRegion::Circle { cx, cy, radius_px } => (c - cx).hypot(r - cy) <= radius_px,
            PixelRegion::Rect { x0, y0, x1, y1 } => c >= x0 && c <= x1 && r >= y0 && r <= y1,
        }
    }
}

/// Reduce DoLP inside a region by a constant factor.
///
/// **A stress model, not cloud physics.** A real cloud changes radiance,
/// spectrum, the angular distribution of the scattered light and the
/// *direction* of the residual polarization; none of that is modelled. This
/// exists to ask "what happens to the estimator when a patch of the field
/// loses its polarization signal", and answers nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Depolarization {
    pub region: PixelRegion,
    /// Multiplies DoLP inside the region. 0 removes the signal entirely.
    pub factor: f64,
}

/// Optional, seeded instrument defects. All default to off.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Degradations {
    pub seed: u64,
    /// Additive Gaussian noise standard deviation, in the same units as `I0`.
    pub noise_sigma: f64,
    /// Per-analyzer-channel multiplicative gain, e.g. `[1.0, 1.03, 0.98, 1.01]`.
    pub gains: [f64; 4],
    /// Per-channel analyzer misalignment in degrees. The *true* transmission
    /// axis is `nominal + offset`; the estimator is only ever told `nominal`.
    pub analyzer_offsets_deg: [f64; 4],
    /// Missing sky: obstruction or cloud. **A stress model, not cloud physics.**
    /// Pixels inside the region are set to `masked_value` in every channel, so
    /// the estimator must discover them through its own `S0` threshold rather
    /// than being handed the mask.
    pub mask: Option<PixelRegion>,
    pub masked_value: f64,
    pub depolarization: Option<Depolarization>,
}

impl Default for Degradations {
    fn default() -> Self {
        Degradations {
            seed: 0,
            noise_sigma: 0.0,
            gains: [1.0; 4],
            analyzer_offsets_deg: [0.0; 4],
            mask: None,
            masked_value: 0.0,
            depolarization: None,
        }
    }
}

impl Degradations {
    /// The representative gain mismatch called out in the brief.
    pub const EXAMPLE_GAINS: [f64; 4] = [1.0, 1.03, 0.98, 1.01];

    pub fn seeded(seed: u64) -> Self {
        Degradations {
            seed,
            ..Default::default()
        }
    }

    pub fn with_noise(mut self, sigma: f64) -> Self {
        self.noise_sigma = sigma;
        self
    }

    pub fn with_gains(mut self, gains: [f64; 4]) -> Self {
        self.gains = gains;
        self
    }

    pub fn with_analyzer_offsets(mut self, offsets_deg: [f64; 4]) -> Self {
        self.analyzer_offsets_deg = offsets_deg;
        self
    }

    pub fn with_mask(mut self, region: PixelRegion) -> Self {
        self.mask = Some(region);
        self
    }

    pub fn with_depolarization(mut self, region: PixelRegion, factor: f64) -> Self {
        self.depolarization = Some(Depolarization { region, factor });
        self
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The four analyzer images. This is the **estimator's** input: it carries the
/// nominal analyzer angles, never the true ones, and never the mask.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalyzerImages {
    pub width: usize,
    pub height: usize,
    /// Nominal analyzer angles in degrees, in the pixel frame.
    pub analyzer_deg: [f64; 4],
    /// Row-major intensity planes, one per analyzer angle.
    pub planes: [Vec<f64>; 4],
    /// Pixels inside the image circle. This is lens geometry, known to anyone
    /// holding the camera, so the estimator may use it.
    pub in_fov: Vec<bool>,
}

impl AnalyzerImages {
    #[inline]
    pub fn index(&self, col: usize, row: usize) -> usize {
        row * self.width + col
    }

    pub fn len(&self) -> usize {
        self.width * self.height
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Ground truth for evaluation only. Kept in a separate struct from
/// [`AnalyzerImages`] so that no estimator can reach it by accident.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TruthField {
    pub width: usize,
    pub height: usize,
    /// True DoLP after any depolarization region was applied.
    pub dolp: Vec<f64>,
    /// True AoLP in the pixel frame, degrees in `[0, 180)`.
    pub aolp_pixel_deg: Vec<f64>,
    /// True scattering angle, degrees.
    pub gamma_deg: Vec<f64>,
    /// Pixels the mask removed.
    pub masked: Vec<bool>,
    /// Pixels inside the image circle.
    pub in_fov: Vec<bool>,
    pub extrinsics: Extrinsics,
    pub sun: Dir,
}

impl TruthField {
    /// Fraction of in-field pixels removed by the mask.
    pub fn masked_fraction(&self) -> f64 {
        let n = self.in_fov.iter().filter(|b| **b).count();
        if n == 0 {
            return 0.0;
        }
        let m = self
            .in_fov
            .iter()
            .zip(&self.masked)
            .filter(|(f, m)| **f && **m)
            .count();
        m as f64 / n as f64
    }
}

/// Images plus the separately-held truth.
#[derive(Debug, Clone, PartialEq)]
pub struct Render {
    pub images: AnalyzerImages,
    pub truth: TruthField,
}

/// Synthesise the four analyzer images for a scene.
///
/// The noise stream is drawn for every pixel and every channel in row-major
/// order regardless of field of view or mask, so that turning the mask on or
/// changing the field of view does not reshuffle the noise on the pixels that
/// survive.
pub fn render(
    camera: &Camera,
    scene: &Scene,
    analyzer_deg: [f64; 4],
    deg: &Degradations,
) -> Render {
    let intr = camera.intrinsics;
    let n = intr.pixel_count();
    let s_body = camera.sun_in_body(scene.sun);
    let mut rng = Rng::new(deg.seed);

    let mut planes = [
        vec![0.0f64; n],
        vec![0.0f64; n],
        vec![0.0f64; n],
        vec![0.0f64; n],
    ];
    let mut in_fov = vec![false; n];
    let mut masked = vec![false; n];
    let mut dolp_out = vec![0.0f64; n];
    let mut aolp_out = vec![0.0f64; n];
    let mut gamma_out = vec![0.0f64; n];

    let true_axis_rad: [f64; 4] =
        std::array::from_fn(|k| (analyzer_deg[k] + deg.analyzer_offsets_deg[k]).to_radians());

    for row in 0..intr.height {
        for col in 0..intr.width {
            let i = intr.index(col, row);
            let noise: [f64; 4] = [
                rng.normal_sigma(deg.noise_sigma),
                rng.normal_sigma(deg.noise_sigma),
                rng.normal_sigma(deg.noise_sigma),
                rng.normal_sigma(deg.noise_sigma),
            ];
            let Some(g) = intr.pixel_geom(col, row) else {
                continue;
            };
            in_fov[i] = true;

            let gamma = g.gamma_rad(s_body);
            let depol_factor = deg
                .depolarization
                .filter(|d| d.region.contains(col, row))
                .map_or(1.0, |d| d.factor);
            let dolp = scene.sky.dolp(gamma) * depol_factor;
            let psi = g.aolp_rad(s_body).unwrap_or(0.0);
            let i0 = scene.radiance.i0(gamma);
            gamma_out[i] = gamma.to_degrees();
            dolp_out[i] = dolp;
            aolp_out[i] = psi.to_degrees();

            let hidden = deg.mask.is_some_and(|m| m.contains(col, row));
            masked[i] = hidden;
            for (k, plane) in planes.iter_mut().enumerate() {
                plane[i] = if hidden {
                    deg.masked_value
                } else {
                    deg.gains[k]
                        * (i0 / 2.0)
                        * (1.0 + dolp * (2.0 * (true_axis_rad[k] - psi)).cos())
                        + noise[k]
                };
            }
        }
    }

    Render {
        images: AnalyzerImages {
            width: intr.width,
            height: intr.height,
            analyzer_deg,
            planes,
            in_fov: in_fov.clone(),
        },
        truth: TruthField {
            width: intr.width,
            height: intr.height,
            dolp: dolp_out,
            aolp_pixel_deg: aolp_out,
            gamma_deg: gamma_out,
            masked,
            in_fov,
            extrinsics: camera.extrinsics,
            sun: scene.sun,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::angles::{diff180_deg, wrap360_deg};
    use approx::assert_relative_eq;

    fn intr() -> FisheyeIntrinsics {
        FisheyeIntrinsics::new(101, 101, 180.0)
    }

    #[test]
    fn zero_tilt_centre_is_the_zenith_and_image_up_is_north() {
        let cam = Camera::new(intr(), Extrinsics::level(0.0));
        // Image centre -> zenith.
        let c = cam.pixel_to_world(50, 50).unwrap();
        assert_relative_eq!(c.alt_deg(), 90.0, epsilon = 1e-12);
        // Image up (same column, smaller row) -> due north, low in the sky.
        let up = cam.pixel_to_world(50, 0).unwrap();
        assert_relative_eq!(wrap360_deg(up.az_deg()), 0.0, epsilon = 1e-9);
        // 50 px of a 50.5 px radius at a 90 deg half-angle -> theta 89.1 deg.
        assert_relative_eq!(up.alt_deg(), 90.0 - 50.0 / 50.5 * 90.0, epsilon = 1e-9);
        // Image right -> due east; image down -> south; image left -> west.
        assert_relative_eq!(
            wrap360_deg(cam.pixel_to_world(100, 50).unwrap().az_deg()),
            90.0,
            epsilon = 1e-9
        );
        assert_relative_eq!(
            wrap360_deg(cam.pixel_to_world(50, 100).unwrap().az_deg()),
            180.0,
            epsilon = 1e-9
        );
        assert_relative_eq!(
            wrap360_deg(cam.pixel_to_world(0, 50).unwrap().az_deg()),
            270.0,
            epsilon = 1e-9
        );
    }

    #[test]
    fn heading_turns_the_image_and_pitch_tips_the_axis() {
        // At heading 37, image up points at azimuth 37.
        let cam = Camera::new(intr(), Extrinsics::level(37.0));
        assert_relative_eq!(
            wrap360_deg(cam.pixel_to_world(50, 0).unwrap().az_deg()),
            37.0,
            epsilon = 1e-9
        );
        assert_relative_eq!(cam.pixel_to_world(50, 50).unwrap().alt_deg(), 90.0, epsilon = 1e-12);
        // Pitch 10 at heading 37 tips the optical axis to altitude 80, azimuth 37.
        let tilted = Camera::new(intr(), Extrinsics::new(37.0, 10.0, 0.0));
        let axis = tilted.pixel_to_world(50, 50).unwrap();
        assert_relative_eq!(axis.alt_deg(), 80.0, epsilon = 1e-9);
        assert_relative_eq!(wrap360_deg(axis.az_deg()), 37.0, epsilon = 1e-9);
        // Roll leaves the optical axis alone and turns the pattern in the image.
        let rolled = Camera::new(intr(), Extrinsics::new(0.0, 0.0, 25.0));
        assert_relative_eq!(
            rolled.pixel_to_world(50, 50).unwrap().alt_deg(),
            90.0,
            epsilon = 1e-12
        );
        // Positive roll about +z sends image-up toward azimuth -25.
        assert_relative_eq!(
            crate::angles::diff360_deg(rolled.pixel_to_world(50, 0).unwrap().az_deg(), -25.0),
            0.0,
            epsilon = 1e-9
        );
    }

    #[test]
    fn projection_is_linear_in_the_angle_from_the_axis() {
        let i = FisheyeIntrinsics::new(201, 201, 120.0);
        // radius 100.5 px maps to 60 deg, so 50.25 px maps to 30 deg.
        let g = i.pixel_geom(100 + 50, 100).unwrap();
        assert_relative_eq!(g.theta_rad.to_degrees(), 50.0 / 100.5 * 60.0, epsilon = 1e-9);
        let h = i.pixel_geom(100 + 100, 100).unwrap();
        assert_relative_eq!(h.theta_rad.to_degrees(), 100.0 / 100.5 * 60.0, epsilon = 1e-9);
        // Outside the image circle is not sky.
        assert!(i.pixel_geom(0, 0).is_none());
        assert!(i.pixel_geom(200, 200).is_none());
    }

    #[test]
    fn view_geom_tangents_are_orthonormal_and_transverse() {
        for (t, p) in [(0.0, 0.0), (0.3, 1.1), (1.5, -2.0), (PI / 2.0, 3.0)] {
            let g = ViewGeom::from_theta_phi(t, p);
            assert_relative_eq!(norm(g.dir), 1.0, epsilon = 1e-15);
            assert_relative_eq!(norm(g.t_theta), 1.0, epsilon = 1e-15);
            assert_relative_eq!(norm(g.t_phi), 1.0, epsilon = 1e-15);
            assert_relative_eq!(dot(g.dir, g.t_theta), 0.0, epsilon = 1e-15);
            assert_relative_eq!(dot(g.dir, g.t_phi), 0.0, epsilon = 1e-15);
            assert_relative_eq!(dot(g.t_theta, g.t_phi), 0.0, epsilon = 1e-15);
        }
    }

    #[test]
    fn pixel_frame_aolp_agrees_with_the_world_frame_at_zero_tilt() {
        // At heading 0 and zero tilt the pixel frame and the world frame share
        // an origin, and the derivation in the module docs gives
        //     psi_pixel = azimuth - psi_world   (mod 180).
        let cam = Camera::new(intr(), Extrinsics::level(0.0));
        let sun = Dir::from_deg(35.0, 200.0);
        let s_body = cam.sun_in_body(sun);
        let mut checked = 0;
        for row in (2..99).step_by(7) {
            for col in (2..99).step_by(7) {
                let Some(g) = cam.intrinsics.pixel_geom(col, row) else {
                    continue;
                };
                if g.theta_rad < 1e-6 {
                    continue; // world local frame is singular at the zenith
                }
                let world = cam.pixel_to_world(col, row).unwrap();
                let Some(psi_world) = crate::sky::aolp_local_rad(sun, world) else {
                    continue;
                };
                let psi_pix = g.aolp_rad(s_body).unwrap().to_degrees();
                let expect = wrap360_deg(world.az_deg()) - psi_world.to_degrees();
                assert_relative_eq!(diff180_deg(psi_pix, expect), 0.0, epsilon = 1e-8);
                checked += 1;
            }
        }
        assert!(checked > 100, "only {checked} pixels checked");
    }

    #[test]
    fn rendering_reproduces_the_truth_when_undegraded() {
        let cam = Camera::new(intr(), Extrinsics::new(123.0, 4.0, -6.0));
        let scene = Scene::new(Dir::from_deg(28.0, 250.0));
        let r = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &Degradations::default());
        assert_eq!(r.images.len(), 101 * 101);
        assert_relative_eq!(r.truth.masked_fraction(), 0.0, epsilon = 1e-15);
        // Closed-form Stokes inversion of the four ideal intensities.
        for i in 0..r.images.len() {
            if !r.images.in_fov[i] {
                continue;
            }
            let p: Vec<f64> = (0..4).map(|k| r.images.planes[k][i]).collect();
            let s0 = (p[0] + p[1] + p[2] + p[3]) / 2.0;
            let s1 = p[0] - p[2];
            let s2 = p[1] - p[3];
            assert_relative_eq!(s0, 1.0, epsilon = 1e-12);
            assert_relative_eq!(s1.hypot(s2) / s0, r.truth.dolp[i], epsilon = 1e-12);
            if r.truth.dolp[i] > 1e-6 {
                let psi = 0.5 * s2.atan2(s1);
                assert_relative_eq!(
                    diff180_deg(psi.to_degrees(), r.truth.aolp_pixel_deg[i]),
                    0.0,
                    epsilon = 1e-8
                );
            }
        }
    }

    #[test]
    fn degradations_do_what_they_say() {
        let cam = Camera::new(intr(), Extrinsics::level(10.0));
        let scene = Scene::new(Dir::from_deg(40.0, 150.0));
        let clean = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &Degradations::default());

        // Mask: every channel takes masked_value inside the region.
        let d = Degradations::default().with_mask(PixelRegion::Rect {
            x0: 0.0,
            y0: 60.0,
            x1: 100.0,
            y1: 100.0,
        });
        let masked = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &d);
        let i = masked.images.index(50, 80);
        assert!(masked.truth.masked[i]);
        for k in 0..4 {
            assert_eq!(masked.images.planes[k][i], 0.0);
        }
        assert!(masked.truth.masked_fraction() > 0.2);

        // Depolarization: DoLP scaled inside the region, untouched outside.
        let d = Degradations::default().with_depolarization(
            PixelRegion::Circle {
                cx: 30.0,
                cy: 30.0,
                radius_px: 10.0,
            },
            0.25,
        );
        let depol = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &d);
        let j = depol.images.index(30, 30);
        assert_relative_eq!(depol.truth.dolp[j], 0.25 * clean.truth.dolp[j], epsilon = 1e-12);
        let k = depol.images.index(70, 70);
        assert_relative_eq!(depol.truth.dolp[k], clean.truth.dolp[k], epsilon = 1e-15);

        // Gains scale each channel; the same seed gives the same noise twice.
        let d = Degradations::seeded(11)
            .with_noise(0.02)
            .with_gains(Degradations::EXAMPLE_GAINS);
        let a = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &d);
        let b = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &d);
        assert_eq!(a.images, b.images);
        let c = render(
            &cam,
            &scene,
            DEFAULT_ANALYZERS_DEG,
            &Degradations::seeded(12).with_noise(0.02),
        );
        assert_ne!(a.images, c.images);

        // Analyzer misalignment shifts the modulation, not the total.
        let d = Degradations::default().with_analyzer_offsets([0.0, 0.0, 3.0, 0.0]);
        let mis = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &d);
        let m = mis.images.index(40, 45);
        assert!((mis.images.planes[2][m] - clean.images.planes[2][m]).abs() > 1e-6);
        assert_relative_eq!(
            mis.images.planes[0][m],
            clean.images.planes[0][m],
            epsilon = 1e-15
        );
    }

    #[test]
    fn radiance_model_only_varies_when_asked() {
        assert!(!RadianceModel::default().has_sun_gradient());
        assert!(RadianceModel::SunGradient { i0: 1.0, k: 1.0 }.has_sun_gradient());
        assert!(!RadianceModel::SunGradient { i0: 1.0, k: 0.0 }.has_sun_gradient());
        let u = RadianceModel::Uniform { i0: 2.0 };
        assert_relative_eq!(u.i0(0.3), 2.0, epsilon = 1e-15);
        assert_relative_eq!(u.i0(2.9), 2.0, epsilon = 1e-15);
        let g = RadianceModel::SunGradient { i0: 1.0, k: 1.0 };
        assert!(g.i0(0.0) > g.i0(PI));
        assert_relative_eq!(g.i0(0.0), 2.0, epsilon = 1e-15);
        assert_relative_eq!(g.i0(PI), 1.0, epsilon = 1e-15);
    }
}
