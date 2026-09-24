//! The local vertical: the one thing the star field cannot tell you.
//!
//! # Why this module exists
//!
//! Identifying stars in a frame fixes the camera's orientation with respect to the
//! sky. It says nothing about gravity. To turn a star's direction into an *altitude* —
//! the angle above the observer's horizon, which is what the core solver consumes — you
//! need to know which way is up, in camera coordinates, from a source outside the
//! image's star content. That is a [`LocalVertical`], and [`crate::sights`] will not
//! produce an observation without one.
//!
//! Three sources are modelled, and each is honest about what it assumes:
//!
//! | source | what it really measures | what it assumes |
//! |---|---|---|
//! | [`VerticalSource::SimulatedInclinometer`] | the specific force on a proof mass | that the platform is **stationary**, so specific force is gravity |
//! | [`VerticalSource::HorizonLine`] | the sea horizon in the same image | a clear, unobstructed sea horizon and a known height of eye |
//! | [`VerticalSource::Supplied`] | whatever the caller measured | that the caller knows what they did |
//!
//! # The accelerating-platform caveat (BRIEF, non-negotiable item 4)
//!
//! An accelerometer measures specific force, `a - g`, not gravity. On a moving vehicle
//! the two are indistinguishable in a single sample: a boat heeling, a car cornering, a
//! plane turning, all tilt the apparent vertical by `atan(a / g)`. One milli-g of
//! horizontal acceleration is 3.4 arcminutes of apparent tilt, which is three and a half
//! nautical miles of position error. [`simulated_inclinometer`] models a **stationary
//! calibrated instrument**: it adds noise and an optional fixed bias to the true
//! vertical and nothing else. It does not model, and this crate makes no claim about,
//! a vertical taken while moving. That needs an IMU, a motion model, and a filter, and
//! it is out of scope for module A by design.
//!
//! # Who may read the truth
//!
//! [`simulated_inclinometer`] takes the true vertical as an explicit argument, because
//! that is what a simulator does. It is a separate function, named so that a call site
//! cannot be mistaken for an estimator, and it is the **only** thing in this crate that
//! touches simulated truth outside [`crate::render`] itself.
//! [`vertical_from_horizon_line`] takes an image and intrinsics and nothing else.

use crate::camera::Intrinsics;
use crate::error::CameraError;
use crate::frames::{Rotation, Vec3, angle_between, cross, dot, norm, normalize, scale, sub};
use crate::render::{Image, dip_arcmin};
use crate::rng::Rng;
use serde::{Deserialize, Serialize};
use skyfix_core::linalg::jacobi_eigen_sym;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerticalSource {
    /// A simulated stationary, calibrated inclinometer. See the module caveat.
    SimulatedInclinometer,
    /// Fitted to a sea horizon in the image and corrected for dip.
    HorizonLine,
    /// Handed in by the caller from somewhere this crate knows nothing about.
    Supplied,
}

/// The local vertical in camera coordinates, with its uncertainty and its provenance.
///
/// `up_camera` is a unit vector; constructors normalise. `sigma_arcmin` is the 1-sigma
/// tilt error, in arcminutes, and it propagates straight into every altitude built from
/// it — an arcminute of tilt is a nautical mile of position.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LocalVertical {
    pub up_camera: Vec3,
    pub sigma_arcmin: f64,
    pub source: VerticalSource,
}

impl LocalVertical {
    /// From a vector the caller measured elsewhere.
    pub fn supplied(up_camera: Vec3, sigma_arcmin: f64) -> Result<Self, CameraError> {
        Self::new(up_camera, sigma_arcmin, VerticalSource::Supplied)
    }

    fn new(
        up_camera: Vec3,
        sigma_arcmin: f64,
        source: VerticalSource,
    ) -> Result<Self, CameraError> {
        if !up_camera.iter().all(|c| c.is_finite()) || norm(up_camera) < 1e-12 {
            return Err(CameraError::invalid(
                "vertical.up_camera",
                "must be a finite, non-degenerate direction",
            ));
        }
        if !sigma_arcmin.is_finite() || sigma_arcmin <= 0.0 {
            return Err(CameraError::invalid(
                "vertical.sigma_arcmin",
                "must be a positive, finite 1-sigma tilt uncertainty in arcminutes",
            ));
        }
        Ok(LocalVertical {
            up_camera: normalize(up_camera),
            sigma_arcmin,
            source,
        })
    }

    /// Altitude of a camera-frame direction above the horizon defined by this vertical,
    /// radians. This is the *apparent* altitude `Ha` when the direction came from an
    /// image, because the camera saw the refracted sky (CONVENTIONS section 4).
    pub fn altitude_of(&self, dir_camera: Vec3) -> f64 {
        dot(normalize(dir_camera), self.up_camera)
            .clamp(-1.0, 1.0)
            .asin()
    }

    /// Angle between this vertical and another direction, arcminutes. Used by tests to
    /// state accuracy in the units the rest of the workspace reports in.
    pub fn tilt_from_arcmin(&self, other: Vec3) -> f64 {
        angle_between(self.up_camera, other).to_degrees() * 60.0
    }
}

// ---------------------------------------------------------------------------
// Simulated inclinometer -- the one function that reads the truth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct InclinometerSim {
    /// 1-sigma random tilt error per axis, arcminutes. A good MEMS tilt sensor after
    /// averaging is a few arcminutes; a surveyor's bubble level is well under one.
    pub sigma_arcmin: f64,
    /// Fixed, unmodelled tilt, arcminutes. A calibration residual, a warped mount, or
    /// a levelling error. Unlike the noise, this does **not** average away over frames,
    /// and it moves the fix by one nautical mile per arcminute.
    pub bias_arcmin: f64,
    /// Direction of the bias in the camera's image plane, radians, measured from the
    /// image `+x` axis. Fixing it makes the bias reproducible rather than random.
    pub bias_direction_rad: f64,
    /// The sigma this instrument *reports*. `None` means it reports `sigma_arcmin`
    /// honestly. Setting it models an instrument that lies about its own accuracy,
    /// which is what makes a fix's error ellipse disagree with its actual error.
    pub reported_sigma_arcmin: Option<f64>,
}

impl Default for InclinometerSim {
    fn default() -> Self {
        InclinometerSim {
            sigma_arcmin: 0.5,
            bias_arcmin: 0.0,
            bias_direction_rad: 0.0,
            reported_sigma_arcmin: None,
        }
    }
}

/// Simulate a stationary, calibrated inclinometer reading.
///
/// **This function reads simulation truth, on purpose.** `true_up_camera` comes from
/// [`crate::render::RenderTruth::up_camera`] and must be passed explicitly; there is no
/// overload that goes and finds it. Everything else in the estimation chain is denied
/// that argument by its signature.
///
/// The model is: take the true vertical, tilt it by a fixed `bias_arcmin` in a fixed
/// direction, then tilt it again by a Gaussian random amount with 1-sigma
/// `sigma_arcmin` in a uniformly random direction. That is a stationary instrument.
/// It is **not** a model of gravity sensing on a moving platform; see the module docs.
pub fn simulated_inclinometer(
    true_up_camera: Vec3,
    sim: &InclinometerSim,
    rng: &mut Rng,
) -> Result<LocalVertical, CameraError> {
    if !sim.sigma_arcmin.is_finite() || sim.sigma_arcmin < 0.0 {
        return Err(CameraError::invalid(
            "inclinometer.sigma_arcmin",
            "must be finite and non-negative",
        ));
    }
    let up = normalize(true_up_camera);
    if norm(true_up_camera) < 1e-12 {
        return Err(CameraError::invalid(
            "inclinometer.true_up_camera",
            "degenerate direction",
        ));
    }
    // Two orthonormal directions perpendicular to `up`, to tilt within.
    let seed: Vec3 = if up[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let e1 = normalize(sub(seed, scale(up, dot(seed, up))));
    let e2 = cross(up, e1);

    let mut tilted = up;
    if sim.bias_arcmin != 0.0 {
        let (s, c) = sim.bias_direction_rad.sin_cos();
        let axis = cross(
            up,
            [
                c * e1[0] + s * e2[0],
                c * e1[1] + s * e2[1],
                c * e1[2] + s * e2[2],
            ],
        );
        tilted = Rotation::about_axis(axis, (sim.bias_arcmin / 60.0).to_radians()).rotate(tilted);
    }
    if sim.sigma_arcmin > 0.0 {
        // A 2-D Gaussian tilt: independent normal components along e1 and e2, which is
        // a Rayleigh-distributed magnitude in a uniformly random direction.
        let t1 = rng.normal_with(0.0, sim.sigma_arcmin);
        let t2 = rng.normal_with(0.0, sim.sigma_arcmin);
        let magnitude = t1.hypot(t2);
        if magnitude > 0.0 {
            let dir = [
                (t1 * e1[0] + t2 * e2[0]) / magnitude,
                (t1 * e1[1] + t2 * e2[1]) / magnitude,
                (t1 * e1[2] + t2 * e2[2]) / magnitude,
            ];
            let axis = cross(tilted, dir);
            if norm(axis) > 1e-15 {
                tilted =
                    Rotation::about_axis(axis, -(magnitude / 60.0).to_radians()).rotate(tilted);
            }
        }
    }
    // Per axis sigma is sigma_arcmin; the reported 1-sigma *tilt* of a 2-D Gaussian is
    // the same per-axis number, which is what the core's altitude sigma wants.
    let reported = sim.reported_sigma_arcmin.unwrap_or(sim.sigma_arcmin);
    LocalVertical::new(
        tilted,
        reported.max(1e-6),
        VerticalSource::SimulatedInclinometer,
    )
}

// ---------------------------------------------------------------------------
// Horizon line
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HorizonFitOptions {
    /// Height of eye, metres. Sets the dip the fit is corrected for.
    pub height_of_eye_m: f64,
    /// Columns are sampled every `column_step` pixels.
    pub column_step: usize,
    /// Smallest sky-to-sea contrast, in counts, that counts as an edge.
    pub min_contrast: f64,
    /// Half-width of the window the derivative centroid is taken over, pixels.
    pub edge_window_px: usize,
    /// Reject columns whose edge is further than this many pixels from the fitted line,
    /// then refit. Zero disables the rejection pass.
    pub outlier_clip_px: f64,
    /// Fraction of the dip to add to the reported sigma in quadrature, as an allowance
    /// for **anomalous dip**.
    ///
    /// The `1.76' sqrt(h)` formula assumes a standard temperature gradient over the
    /// water. A real air-sea temperature difference bends the ray differently and moves
    /// the visible horizon by a sizeable fraction of the dip; navigators have measured
    /// departures of tens of per cent, and much more over ice or a warm current. The
    /// default 0.1 is a conservative token of that, not a validated model.
    pub dip_uncertainty_fraction: f64,
    /// Floor on the reported sigma, arcminutes. A fitted line through a real sea
    /// horizon is never better than this: swell, haze and the horizon's own
    /// irregularity are not in the residual scatter of a synthetic step edge.
    pub sigma_floor_arcmin: f64,
}

impl Default for HorizonFitOptions {
    fn default() -> Self {
        HorizonFitOptions {
            height_of_eye_m: 0.0,
            column_step: 1,
            min_contrast: 20.0,
            edge_window_px: 2,
            outlier_clip_px: 3.0,
            dip_uncertainty_fraction: 0.1,
            sigma_floor_arcmin: 0.2,
        }
    }
}

/// What the horizon fit found, alongside the vertical it implies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HorizonFit {
    /// Image row of the edge as `v = slope * u + intercept`.
    pub slope: f64,
    pub intercept: f64,
    pub columns_used: usize,
    pub columns_rejected: usize,
    /// RMS of the column edge positions about the fitted line, pixels.
    pub residual_rms_px: f64,
    /// Dip removed, arcminutes: `1.76' sqrt(height_of_eye_m)`.
    pub dip_arcmin: f64,
    /// 1-sigma tilt uncertainty of the recovered vertical, arcminutes.
    ///
    /// The statistical part of it — [`HorizonFit::statistical_sigma_arcmin`] — comes
    /// from the fit's own residual scatter and is *optimistic on its own*: measured
    /// against the truth on a synthetic noisy frame it under-states the real tilt error
    /// by a factor of several, because the scatter of the edge samples says nothing
    /// about where the horizon actually was. The reported figure adds an anomalous-dip
    /// allowance and a floor on top; see [`HorizonFitOptions`].
    pub sigma_arcmin: f64,
    /// The scatter-only part, before the dip allowance and the floor. Reported so the
    /// two can be told apart rather than silently merged.
    pub statistical_sigma_arcmin: f64,
}

/// Fit the sea horizon in an image and turn it into a local vertical.
///
/// # Method
///
/// 1. In each sampled column, differentiate down the column and take the **centroid of
///    the derivative** over a small window around its strongest negative excursion.
///    For any symmetric edge profile that centroid is the sub-pixel edge position
///    exactly — for the box-filtered step the renderer draws, provably so.
/// 2. Least-squares a straight line through the column edges, optionally clipping
///    outliers once and refitting.
/// 3. Unproject the line's points to camera-frame directions. Every one of them is a
///    direction at altitude `-dip`, so the vertical `u` satisfies `d_k . u = -sin(dip)`.
///    Solve that for a unit `u` by Gauss-Newton on the sphere, started from the
///    smallest eigenvector of `sum d d^T`.
///
/// Step 3 is where the dip correction happens, and doing it as a constrained fit rather
/// than as an after-the-fact nudge matters: the horizon is a small circle, not a great
/// circle, and a plain plane-through-the-origin fit to an arc of it is biased by about
/// one whole dip (`1.02 * dip` for a 40-degree arc) in the direction the camera faces.
/// At 9 metres of height of eye that is 5.4 arcminutes, or five and a half nautical
/// miles of position.
///
/// # What this does not model
///
/// A real sea horizon is not a clean step: haze softens it, swell makes it ragged, a
/// coastline or a ship is not it at all, and at night there may be no contrast to find.
/// This fit will happily lock onto any strong horizontal edge. It has no notion of
/// whether what it found is the sea.
pub fn vertical_from_horizon_line(
    image: &Image,
    intrinsics: &Intrinsics,
    options: &HorizonFitOptions,
) -> Result<(LocalVertical, HorizonFit), CameraError> {
    if !options.height_of_eye_m.is_finite() || options.height_of_eye_m < 0.0 {
        return Err(CameraError::invalid(
            "horizon.height_of_eye_m",
            "must be a non-negative height in metres",
        ));
    }
    if image.width < 2 || image.height < 4 {
        return Err(CameraError::HorizonFit(
            "image is too small to hold a horizon".to_string(),
        ));
    }

    // --- 1. per-column sub-pixel edges --------------------------------------
    let step = options.column_step.max(1);
    let win = options.edge_window_px.max(1) as i64;
    let mut points: Vec<(f64, f64)> = Vec::new();
    for x in (0..image.width).step_by(step) {
        // d[y] is the downward gradient across the boundary between rows y and y+1.
        let mut best = 0usize;
        let mut best_d = f64::NEG_INFINITY;
        for y in 0..(image.height - 1) {
            let d = image.at(x, y) - image.at(x, y + 1);
            if d > best_d {
                best_d = d;
                best = y;
            }
        }
        if best_d < options.min_contrast {
            continue;
        }
        let lo = (best as i64 - win).max(0);
        let hi = (best as i64 + win).min(image.height as i64 - 2);
        let mut sum = 0.0;
        let mut weighted = 0.0;
        for y in lo..=hi {
            let d = (image.at(x, y as usize) - image.at(x, y as usize + 1)).max(0.0);
            sum += d;
            weighted += d * (y as f64 + 0.5);
        }
        if sum > 0.0 {
            points.push((x as f64, weighted / sum));
        }
    }
    if points.len() < 3 {
        return Err(CameraError::HorizonFit(format!(
            "only {} column(s) showed an edge of at least {} counts; there is no \
             horizon in this image, or it has no contrast",
            points.len(),
            options.min_contrast
        )));
    }

    // --- 2. least-squares line, with one clipping pass ------------------------
    let (mut slope, mut intercept) = fit_line(&points)?;
    let mut rejected = 0usize;
    if options.outlier_clip_px > 0.0 {
        let kept: Vec<(f64, f64)> = points
            .iter()
            .copied()
            .filter(|(u, v)| (v - (slope * u + intercept)).abs() <= options.outlier_clip_px)
            .collect();
        rejected = points.len() - kept.len();
        if kept.len() >= 3 && rejected > 0 {
            points = kept;
            let refit = fit_line(&points)?;
            slope = refit.0;
            intercept = refit.1;
        }
    }
    let residual_rms_px = (points
        .iter()
        .map(|(u, v)| (v - (slope * u + intercept)).powi(2))
        .sum::<f64>()
        / points.len() as f64)
        .sqrt();

    // --- 3. line -> plane normal -> vertical, correcting for dip -------------
    let dip = dip_arcmin(options.height_of_eye_m);
    let sin_dip = (dip / 60.0).to_radians().sin();
    let dirs: Vec<Vec3> = points
        .iter()
        .map(|&(u, _)| intrinsics.unproject(u, slope * u + intercept))
        .collect();

    // Start from the plane through the origin: the smallest eigenvector of sum d d^T.
    let mut scatter = vec![vec![0.0f64; 3]; 3];
    for d in &dirs {
        for i in 0..3 {
            for j in 0..3 {
                scatter[i][j] += d[i] * d[j];
            }
        }
    }
    let (values, vectors) = jacobi_eigen_sym(&scatter);
    if values.len() != 3 {
        return Err(CameraError::HorizonFit(
            "the 3x3 scatter eigen-decomposition failed".to_string(),
        ));
    }
    let mut up: Vec3 = [vectors[0][2], vectors[1][2], vectors[2][2]];
    // Orient it toward the sky: the sky is at smaller `v`, i.e. camera -y side.
    let sky = intrinsics.unproject(
        intrinsics.cx,
        (slope * intrinsics.cx + intercept) - 0.25 * image.height as f64,
    );
    if dot(up, sky) < 0.0 {
        up = scale(up, -1.0);
    }

    // Gauss-Newton on the sphere: minimise sum (d_k . u + sin_dip)^2 over unit u.
    for _ in 0..12 {
        let seed: Vec3 = if up[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let e1 = normalize(sub(seed, scale(up, dot(seed, up))));
        let e2 = cross(up, e1);
        let (mut a11, mut a12, mut a22) = (0.0, 0.0, 0.0);
        let (mut b1, mut b2) = (0.0, 0.0);
        for d in &dirs {
            let r = dot(*d, up) + sin_dip;
            let (j1, j2) = (dot(*d, e1), dot(*d, e2));
            a11 += j1 * j1;
            a12 += j1 * j2;
            a22 += j2 * j2;
            b1 -= j1 * r;
            b2 -= j2 * r;
        }
        let det = a11 * a22 - a12 * a12;
        if det.abs() <= 1e-18 || !det.is_finite() {
            break;
        }
        let d1 = (b1 * a22 - b2 * a12) / det;
        let d2 = (b2 * a11 - b1 * a12) / det;
        let next = normalize([
            up[0] + d1 * e1[0] + d2 * e2[0],
            up[1] + d1 * e1[1] + d2 * e2[1],
            up[2] + d1 * e1[2] + d2 * e2[2],
        ]);
        let moved = angle_between(up, next);
        up = next;
        if moved < 1e-14 {
            break;
        }
    }

    // Uncertainty: the edge scatter carried through the same Jacobian. The residual
    // scatter is in pixels; one pixel is `angular_scale_at` radians.
    let scale_rad = intrinsics.angular_scale_at(intrinsics.cx, slope * intrinsics.cx + intercept);
    let n = points.len() as f64;
    // Across-arc precision is sigma/sqrt(n); the tilt about the arc's own axis is worse
    // by 1/sin(half the arc's angular length), which is the geometry that matters.
    let arc = dirs
        .first()
        .zip(dirs.last())
        .map(|(a, b)| angle_between(*a, *b))
        .unwrap_or(0.0);
    let across = residual_rms_px.max(0.05) * scale_rad / n.sqrt();
    let about = across / (arc / 2.0).sin().max(1e-6);
    let statistical_sigma_arcmin = across.max(about).to_degrees() * 60.0;
    let sigma_arcmin = statistical_sigma_arcmin
        .hypot(options.dip_uncertainty_fraction.max(0.0) * dip)
        .max(options.sigma_floor_arcmin.max(1e-6));

    let fit = HorizonFit {
        slope,
        intercept,
        columns_used: points.len(),
        columns_rejected: rejected,
        residual_rms_px,
        dip_arcmin: dip,
        sigma_arcmin,
        statistical_sigma_arcmin,
    };
    let vertical = LocalVertical::new(up, sigma_arcmin.max(1e-6), VerticalSource::HorizonLine)?;
    Ok((vertical, fit))
}

fn fit_line(points: &[(f64, f64)]) -> Result<(f64, f64), CameraError> {
    let n = points.len() as f64;
    let su: f64 = points.iter().map(|p| p.0).sum();
    let sv: f64 = points.iter().map(|p| p.1).sum();
    let suu: f64 = points.iter().map(|p| p.0 * p.0).sum();
    let suv: f64 = points.iter().map(|p| p.0 * p.1).sum();
    let det = n * suu - su * su;
    if det.abs() <= 1e-12 || !det.is_finite() {
        return Err(CameraError::HorizonFit(
            "every edge sample is in the same column; a line cannot be fitted".to_string(),
        ));
    }
    Ok(((n * suv - su * sv) / det, (suu * sv - su * suv) / det))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::camera_from_enu;
    use crate::render::{RenderOptions, SeaHorizon, render};
    use approx::assert_relative_eq;
    use skyfix_core::geometry::Point;
    use skyfix_ephemeris::stars::StarProvider;

    const UTC: &str = "2026-10-01T05:30:00Z";
    fn philadelphia() -> Point {
        Point::from_deg(39.9526, -75.1652)
    }

    #[test]
    fn a_supplied_vertical_is_normalised_and_validated() {
        let v = LocalVertical::supplied([0.0, 0.0, 3.0], 0.5).unwrap();
        assert_relative_eq!(norm(v.up_camera), 1.0, epsilon = 1e-15);
        assert_eq!(v.source, VerticalSource::Supplied);
        // Altitude of a direction 30 degrees off the vertical is 60 degrees.
        let d = [0.5, 0.0, 3.0f64.sqrt() / 2.0];
        assert_relative_eq!(v.altitude_of(d).to_degrees(), 60.0, epsilon = 1e-12);
        assert_relative_eq!(
            v.altitude_of([0.0, 0.0, 1.0]).to_degrees(),
            90.0,
            epsilon = 1e-9
        );
        assert_relative_eq!(v.tilt_from_arcmin([0.0, 0.0, 1.0]), 0.0, epsilon = 1e-9);
        // Refusals.
        assert!(LocalVertical::supplied([0.0, 0.0, 0.0], 1.0).is_err());
        assert!(LocalVertical::supplied([f64::NAN, 0.0, 1.0], 1.0).is_err());
        assert!(LocalVertical::supplied([0.0, 0.0, 1.0], 0.0).is_err());
        assert!(LocalVertical::supplied([0.0, 0.0, 1.0], -1.0).is_err());
        assert!(LocalVertical::supplied([0.0, 0.0, 1.0], f64::NAN).is_err());
    }

    #[test]
    fn the_simulated_inclinometer_has_the_scatter_it_advertises() {
        let truth: Vec3 = normalize([0.1, -0.9, 0.42]);
        let sim = InclinometerSim {
            sigma_arcmin: 2.0,
            ..InclinometerSim::default()
        };
        let mut rng = Rng::new(17);
        let mut sumsq = 0.0;
        let n = 4000;
        for _ in 0..n {
            let v = simulated_inclinometer(truth, &sim, &mut rng).unwrap();
            assert_eq!(v.source, VerticalSource::SimulatedInclinometer);
            assert_relative_eq!(v.sigma_arcmin, 2.0);
            let t = v.tilt_from_arcmin(truth);
            sumsq += t * t;
        }
        // A 2-D Gaussian tilt with per-axis sigma s has E[tilt^2] = 2 s^2.
        let rms = (sumsq / n as f64).sqrt();
        assert_relative_eq!(rms, 2.0 * std::f64::consts::SQRT_2, max_relative = 0.05);
        // Zero noise reproduces the truth exactly.
        let clean = simulated_inclinometer(
            truth,
            &InclinometerSim {
                sigma_arcmin: 0.0,
                ..InclinometerSim::default()
            },
            &mut rng,
        )
        .unwrap();
        assert!(clean.tilt_from_arcmin(truth) < 1e-9);
        // Determinism.
        let a = simulated_inclinometer(truth, &sim, &mut Rng::new(5)).unwrap();
        let b = simulated_inclinometer(truth, &sim, &mut Rng::new(5)).unwrap();
        assert_eq!(a, b);
        assert_ne!(
            a,
            simulated_inclinometer(truth, &sim, &mut Rng::new(6)).unwrap()
        );
        // Refusals.
        assert!(simulated_inclinometer([0.0, 0.0, 0.0], &sim, &mut rng).is_err());
        assert!(
            simulated_inclinometer(
                truth,
                &InclinometerSim {
                    sigma_arcmin: -1.0,
                    ..sim
                },
                &mut rng
            )
            .is_err()
        );
    }

    #[test]
    fn a_bias_does_not_average_away_and_a_lying_sigma_is_possible() {
        // BRIEF non-negotiable item 6, in the vertical: noise averages, bias does not.
        let truth: Vec3 = [0.0, 0.0, 1.0];
        let sim = InclinometerSim {
            sigma_arcmin: 1.0,
            bias_arcmin: 4.0,
            bias_direction_rad: 0.0,
            reported_sigma_arcmin: None,
        };
        let mut rng = Rng::new(31);
        let mut mean: Vec3 = [0.0, 0.0, 0.0];
        let n = 2000;
        for _ in 0..n {
            let v = simulated_inclinometer(truth, &sim, &mut rng).unwrap();
            for (k, m) in mean.iter_mut().enumerate() {
                *m += v.up_camera[k];
            }
        }
        let mean = normalize(mean);
        let residual = angle_between(mean, truth).to_degrees() * 60.0;
        assert_relative_eq!(residual, 4.0, max_relative = 0.05);
        // An instrument that under-reports its own sigma.
        let liar = simulated_inclinometer(
            truth,
            &InclinometerSim {
                sigma_arcmin: 5.0,
                reported_sigma_arcmin: Some(0.2),
                ..sim
            },
            &mut rng,
        )
        .unwrap();
        assert_relative_eq!(liar.sigma_arcmin, 0.2);
    }

    #[test]
    fn the_horizon_line_recovers_the_vertical() {
        // Render a sea horizon with no stars, fit it, and compare with the truth the
        // fitter was never given.
        let k = Intrinsics::from_horizontal_fov(640, 480, 40f64.to_radians());
        for (alt_deg, az_deg, roll_deg, height_m) in [
            (0.0f64, 180.0f64, 0.0f64, 0.0f64),
            (2.0, 270.0, 0.0, 9.0),
            (-3.0, 45.0, 6.0, 4.0),
            (5.0, 100.0, -11.0, 25.0),
        ] {
            let att = camera_from_enu(
                alt_deg.to_radians(),
                az_deg.to_radians(),
                roll_deg.to_radians(),
            );
            let opts = RenderOptions {
                sea_horizon: Some(SeaHorizon {
                    height_of_eye_m: height_m,
                    sea_level: 20.0,
                }),
                background_level: 400.0,
                magnitude_limit: -10.0,
                ..RenderOptions::default().noiseless()
            };
            let (image, truth) =
                render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
            let (v, fit) = vertical_from_horizon_line(
                &image,
                &k,
                &HorizonFitOptions {
                    height_of_eye_m: height_m,
                    ..HorizonFitOptions::default()
                },
            )
            .unwrap();
            assert_eq!(v.source, VerticalSource::HorizonLine);
            assert_eq!(fit.columns_used, 640);
            // The residual is the horizon's own curvature, not edge noise: the sea
            // horizon is a SMALL circle at altitude -dip, which a pinhole lens images
            // as a slightly curved conic, and a straight line cannot follow it. At
            // zero height of eye the dip is zero, the horizon is a great circle, and
            // the line fits to machine precision. The sagitta grows with the dip.
            if height_m == 0.0 {
                assert!(
                    fit.residual_rms_px < 1e-9,
                    "a great circle must image as a straight line: {fit:?}"
                );
            } else {
                assert!(fit.residual_rms_px < 0.05, "line residual {fit:?}");
                assert!(
                    fit.residual_rms_px > 1e-6,
                    "a small circle is not straight; the fit should see that: {fit:?}"
                );
            }
            assert_relative_eq!(fit.dip_arcmin, dip_arcmin(height_m), epsilon = 1e-12);
            let err = v.tilt_from_arcmin(truth.up_camera);
            assert!(
                err < 0.2,
                "height {height_m} m, roll {roll_deg} deg: vertical off by {err:.4}' \
                 (fit {fit:?})"
            );
            assert!(v.sigma_arcmin > 0.0 && v.sigma_arcmin.is_finite());
        }
    }

    #[test]
    fn the_dip_correction_is_worth_its_own_size() {
        // Skipping the dip correction -- or getting its sign wrong -- costs about one
        // whole dip, which at 25 m of height of eye is 8.8 arcminutes and nearly nine
        // nautical miles. This test measures that rather than asserting it.
        let k = Intrinsics::from_horizontal_fov(640, 480, 40f64.to_radians());
        let att = camera_from_enu(0.0, 200f64.to_radians(), 0.0);
        let height_m = 25.0;
        let opts = RenderOptions {
            sea_horizon: Some(SeaHorizon {
                height_of_eye_m: height_m,
                sea_level: 20.0,
            }),
            background_level: 400.0,
            magnitude_limit: -10.0,
            ..RenderOptions::default().noiseless()
        };
        let (image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        let correct = vertical_from_horizon_line(
            &image,
            &k,
            &HorizonFitOptions {
                height_of_eye_m: height_m,
                ..HorizonFitOptions::default()
            },
        )
        .unwrap()
        .0;
        let ignored = vertical_from_horizon_line(
            &image,
            &k,
            &HorizonFitOptions {
                height_of_eye_m: 0.0,
                ..HorizonFitOptions::default()
            },
        )
        .unwrap()
        .0;
        let good = correct.tilt_from_arcmin(truth.up_camera);
        let bad = ignored.tilt_from_arcmin(truth.up_camera);
        assert!(good < 0.2, "corrected vertical off by {good:.4}'");
        let dip = dip_arcmin(height_m);
        assert!(
            (bad - dip).abs() < 0.3 * dip,
            "ignoring an {dip:.2}' dip should cost about one dip; it cost {bad:.2}'"
        );
    }

    #[test]
    fn the_horizon_fit_survives_noise_and_refuses_an_empty_sky() {
        let k = Intrinsics::from_horizontal_fov(640, 480, 40f64.to_radians());
        let att = camera_from_enu(1f64.to_radians(), 200f64.to_radians(), 4f64.to_radians());
        let opts = RenderOptions {
            sea_horizon: Some(SeaHorizon {
                height_of_eye_m: 4.0,
                sea_level: 60.0,
            }),
            background_level: 900.0,
            read_noise: 12.0,
            shot_noise: true,
            magnitude_limit: -10.0,
            seed: 12,
            ..RenderOptions::default()
        };
        let (image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        let (v, fit) = vertical_from_horizon_line(
            &image,
            &k,
            &HorizonFitOptions {
                height_of_eye_m: 4.0,
                min_contrast: 200.0,
                ..HorizonFitOptions::default()
            },
        )
        .unwrap();
        let err = v.tilt_from_arcmin(truth.up_camera);
        assert!(
            err < 1.0,
            "noisy horizon vertical off by {err:.4}' ({fit:?})"
        );
        // The reported sigma must COVER the error actually made. The scatter-only
        // figure does not -- that is the point of the dip allowance and the floor.
        assert!(
            v.sigma_arcmin >= err,
            "reported sigma {:.4}' under-states the actual tilt error {err:.4}'",
            v.sigma_arcmin
        );
        assert!(v.sigma_arcmin < 5.0, "sigma {:.4}'", v.sigma_arcmin);
        assert!(
            fit.statistical_sigma_arcmin < v.sigma_arcmin,
            "the scatter-only sigma should be the smaller of the two: {fit:?}"
        );

        // No horizon at all: a star field with no sea in it.
        let starry = RenderOptions::default();
        let att2 = camera_from_enu(25f64.to_radians(), 100f64.to_radians(), 0.0);
        let (sky, _) = render(
            UTC,
            philadelphia(),
            &att2,
            &k,
            &StarProvider::new(),
            &starry,
        )
        .unwrap();
        assert!(matches!(
            vertical_from_horizon_line(
                &sky,
                &k,
                &HorizonFitOptions {
                    min_contrast: 5_000.0,
                    ..HorizonFitOptions::default()
                }
            ),
            Err(CameraError::HorizonFit(_))
        ));
        // Degenerate inputs.
        assert!(
            vertical_from_horizon_line(&Image::new(1, 1, 0.0), &k, &HorizonFitOptions::default())
                .is_err()
        );
        assert!(
            vertical_from_horizon_line(
                &image,
                &k,
                &HorizonFitOptions {
                    height_of_eye_m: -1.0,
                    ..HorizonFitOptions::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn outlier_columns_are_clipped() {
        let k = Intrinsics::from_horizontal_fov(640, 480, 40f64.to_radians());
        let att = camera_from_enu(0.0, 200f64.to_radians(), 0.0);
        let opts = RenderOptions {
            sea_horizon: Some(SeaHorizon {
                height_of_eye_m: 4.0,
                sea_level: 20.0,
            }),
            background_level: 400.0,
            magnitude_limit: -10.0,
            ..RenderOptions::default().noiseless()
        };
        let (mut image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        // A headland: a dark mass standing 40 px above the true horizon in 30 columns,
        // so those columns report an edge that is real but is not the sea horizon.
        for x in 100..130 {
            for y in (image.height / 2 - 40)..image.height {
                image.set(x, y, 20.0);
            }
        }
        let fit_opts = HorizonFitOptions {
            height_of_eye_m: 4.0,
            ..HorizonFitOptions::default()
        };
        let (v, fit) = vertical_from_horizon_line(&image, &k, &fit_opts).unwrap();
        assert!(fit.columns_rejected >= 25, "{fit:?}");
        let err = v.tilt_from_arcmin(truth.up_camera);
        assert!(err < 0.3, "clipped fit off by {err:.4}' ({fit:?})");
        // Without clipping the obstruction drags the line.
        let (v_bad, _) = vertical_from_horizon_line(
            &image,
            &k,
            &HorizonFitOptions {
                outlier_clip_px: 0.0,
                ..fit_opts
            },
        )
        .unwrap();
        assert!(
            v_bad.tilt_from_arcmin(truth.up_camera) > 3.0 * err.max(0.01),
            "clipping should have mattered"
        );
    }
}
