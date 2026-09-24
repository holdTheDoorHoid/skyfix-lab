//! Linear Stokes recovery from four analyzer images.
//!
//! # The inversion
//!
//! With an ideal analyzer at angle `t` in front of partially linearly polarized
//! light of total intensity `S0`, degree `p` and angle `psi`,
//!
//! ```text
//! I(t) = S0/2 * (1 + p cos(2 (t - psi)))
//! ```
//!
//! so for the four conventional angles
//!
//! ```text
//! S0 = (I0 + I45 + I90 + I135) / 2
//! S1 = I0  - I90
//! S2 = I45 - I135
//! p    = sqrt(S1^2 + S2^2) / S0
//! psi  = 0.5 * atan2(S2, S1)        (mod 180 deg)
//! ```
//!
//! `S3` (circular polarization) is not measurable with linear analyzers and is
//! not modelled anywhere in this crate.
//!
//! # What the recovered numbers are worth
//!
//! The inversion above is exact for the ideal measurement it describes. It is
//! *not* robust to the defects `camera.rs` can inject: a per-channel gain
//! mismatch or an analyzer misalignment violates the model that produced these
//! four formulas, and the recovered `psi` then carries a **bias**, not just
//! noise. Averaging more pixels does not remove it. See
//! `docs/POLARIZATION.md`.
//!
//! # Masking
//!
//! Two thresholds, both configurable, both applied per pixel:
//!
//! * `min_s0` — a pixel with too little total intensity carries no usable
//!   angle. This is how a missing-sky mask is *discovered*: the estimator is
//!   never handed the mask.
//! * `min_dolp` — a weakly polarized pixel has a numerically ill-conditioned
//!   angle (near the neutral points, `atan2` of two small noisy numbers).
//!
//! Pixels outside the lens' image circle are invalid regardless.

use crate::angles::wrap180_rad;
use crate::camera::AnalyzerImages;
use serde::{Deserialize, Serialize};

/// Closed-form linear Stokes vector from the four conventional intensities.
#[inline]
pub fn stokes_from_four(i0: f64, i45: f64, i90: f64, i135: f64) -> (f64, f64, f64) {
    ((i0 + i45 + i90 + i135) / 2.0, i0 - i90, i45 - i135)
}

/// Degree and angle of linear polarization from a linear Stokes vector.
/// Returns `(dolp, aolp_rad)` with `aolp_rad` in `[0, pi)`.
/// `dolp` is 0 when `S0 <= 0`.
#[inline]
pub fn dolp_aolp(s0: f64, s1: f64, s2: f64) -> (f64, f64) {
    let dolp = if s0 > 0.0 { s1.hypot(s2) / s0 } else { 0.0 };
    (dolp, wrap180_rad(0.5 * s2.atan2(s1)))
}

/// Forward model: the intensity an ideal analyzer at `axis_rad` records.
/// The exact inverse of [`stokes_from_four`] for the conventional four angles.
#[inline]
pub fn analyzer_intensity(s0: f64, dolp: f64, aolp_rad: f64, axis_rad: f64) -> f64 {
    s0 / 2.0 * (1.0 + dolp * (2.0 * (axis_rad - aolp_rad)).cos())
}

/// Validity thresholds. Both are in the intensity units of the images.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StokesThresholds {
    /// Minimum total intensity `S0` for a pixel to be usable.
    pub min_s0: f64,
    /// Minimum degree of linear polarization for a pixel to be usable.
    pub min_dolp: f64,
}

impl Default for StokesThresholds {
    fn default() -> Self {
        // Defaults for an `I0 = 1` scene.
        //
        // `min_s0 = 0.05` rejects pixels a mask zeroed.
        //
        // `min_dolp = 0.10` is the more consequential choice. Propagating
        // additive noise of standard deviation `sigma` through the closed-form
        // inversion gives an AoLP standard deviation of roughly
        //
        //     sigma_psi = 0.5 * sigma * sqrt(2) / (S0 * p)   radians
        //              ~= 0.81 / p degrees   at sigma = 0.02, S0 = 1
        //
        // so a pixel at `p = 0.02` carries an angle uncertain by about 40 deg:
        // it is not a weak measurement, it is noise. At `p = 0.10` it is about
        // 8 deg, which is a genuine if poor sample. Admitting the junk does not
        // bias the estimate, but it inflates its variance by roughly an order
        // of magnitude and makes the curvature-derived `sigma_deg` optimistic,
        // because the residuals are then wildly non-identically distributed.
        // Raise the threshold for a cleaner estimate at the cost of sky; lower
        // it to study exactly that failure.
        StokesThresholds {
            min_s0: 0.05,
            min_dolp: 0.10,
        }
    }
}

/// Per-pixel recovered Stokes parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StokesField {
    pub width: usize,
    pub height: usize,
    pub s0: Vec<f64>,
    pub s1: Vec<f64>,
    pub s2: Vec<f64>,
    pub dolp: Vec<f64>,
    /// AoLP in the **pixel frame**, radians in `[0, pi)`.
    pub aolp_rad: Vec<f64>,
    /// Passed both thresholds and lies inside the image circle.
    pub valid: Vec<bool>,
    pub thresholds: StokesThresholds,
}

impl StokesField {
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

    pub fn valid_count(&self) -> usize {
        self.valid.iter().filter(|b| **b).count()
    }

    /// Fraction of pixels that were inside the image circle but were rejected.
    /// This is the estimator's own view of how much sky it lost; it is derived
    /// from the thresholds, never from the truth mask.
    pub fn rejected_fraction(&self, in_fov: &[bool]) -> f64 {
        let n = in_fov.iter().filter(|b| **b).count();
        if n == 0 {
            return 0.0;
        }
        let bad = in_fov
            .iter()
            .zip(&self.valid)
            .filter(|(f, v)| **f && !**v)
            .count();
        bad as f64 / n as f64
    }

    /// AoLP values of the valid pixels, degrees.
    pub fn valid_aolp_deg(&self) -> Vec<f64> {
        self.aolp_rad
            .iter()
            .zip(&self.valid)
            .filter(|(_, v)| **v)
            .map(|(a, _)| a.to_degrees())
            .collect()
    }
}

/// Recover `S0, S1, S2, DoLP, AoLP` per pixel and apply the thresholds.
pub fn recover(images: &AnalyzerImages, thresholds: &StokesThresholds) -> StokesField {
    let n = images.len();
    let mut f = StokesField {
        width: images.width,
        height: images.height,
        s0: vec![0.0; n],
        s1: vec![0.0; n],
        s2: vec![0.0; n],
        dolp: vec![0.0; n],
        aolp_rad: vec![0.0; n],
        valid: vec![false; n],
        thresholds: *thresholds,
    };
    for i in 0..n {
        if !images.in_fov[i] {
            continue;
        }
        let (s0, s1, s2) = stokes_from_four(
            images.planes[0][i],
            images.planes[1][i],
            images.planes[2][i],
            images.planes[3][i],
        );
        let (dolp, aolp) = dolp_aolp(s0, s1, s2);
        f.s0[i] = s0;
        f.s1[i] = s1;
        f.s2[i] = s2;
        f.dolp[i] = dolp;
        f.aolp_rad[i] = aolp;
        f.valid[i] = s0 >= thresholds.min_s0 && dolp >= thresholds.min_dolp;
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::angles::diff180_deg;
    use crate::camera::{
        Camera, DEFAULT_ANALYZERS_DEG, Degradations, Extrinsics, FisheyeIntrinsics, PixelRegion,
        Scene, render,
    };
    use crate::sky::Dir;
    use approx::assert_relative_eq;

    #[test]
    fn round_trip_to_one_part_in_a_billion() {
        // Independent numbers: synthesise from a known (S0, DoLP, AoLP) with
        // the forward model, then invert with the closed form.
        let angles: Vec<f64> = DEFAULT_ANALYZERS_DEG.iter().map(|a| a.to_radians()).collect();
        for &s0_true in &[0.25_f64, 1.0, 7.5] {
            for &p_true in &[0.0_f64, 0.137, 0.5, 0.75, 1.0] {
                for psi_deg in (0..180).step_by(7) {
                    let psi_true = (psi_deg as f64).to_radians();
                    let i: Vec<f64> = angles
                        .iter()
                        .map(|t| analyzer_intensity(s0_true, p_true, psi_true, *t))
                        .collect();
                    let (s0, s1, s2) = stokes_from_four(i[0], i[1], i[2], i[3]);
                    let (p, psi) = dolp_aolp(s0, s1, s2);
                    assert_relative_eq!(s0, s0_true, epsilon = 1e-9);
                    assert_relative_eq!(p, p_true, epsilon = 1e-9);
                    if p_true > 1e-9 {
                        assert!(
                            diff180_deg(psi.to_degrees(), psi_deg as f64).abs() < 1e-9,
                            "psi {} vs {}",
                            psi.to_degrees(),
                            psi_deg
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn hand_computed_single_case() {
        // Fully polarized along the pixel-frame zero direction: the 0 deg
        // channel sees everything, the 90 deg channel nothing, and the two
        // diagonals split it evenly.
        let (i0, i45, i90, i135) = (1.0, 0.5, 0.0, 0.5);
        let (s0, s1, s2) = stokes_from_four(i0, i45, i90, i135);
        assert_relative_eq!(s0, 1.0, epsilon = 1e-15);
        assert_relative_eq!(s1, 1.0, epsilon = 1e-15);
        assert_relative_eq!(s2, 0.0, epsilon = 1e-15);
        let (p, psi) = dolp_aolp(s0, s1, s2);
        assert_relative_eq!(p, 1.0, epsilon = 1e-15);
        assert_relative_eq!(psi.to_degrees(), 0.0, epsilon = 1e-15);
        // Rotate by 45 deg: now the diagonals carry the signal.
        let (s0, s1, s2) = stokes_from_four(0.5, 1.0, 0.5, 0.0);
        let (p, psi) = dolp_aolp(s0, s1, s2);
        assert_relative_eq!(p, 1.0, epsilon = 1e-15);
        assert_relative_eq!(psi.to_degrees(), 45.0, epsilon = 1e-12);
        // Unpolarized light: equal everywhere, DoLP zero.
        let (s0, s1, s2) = stokes_from_four(0.5, 0.5, 0.5, 0.5);
        assert_relative_eq!(dolp_aolp(s0, s1, s2).0, 0.0, epsilon = 1e-15);
    }

    #[test]
    fn a_rendered_image_inverts_back_to_its_truth() {
        let cam = Camera::new(
            FisheyeIntrinsics::new(81, 81, 180.0),
            Extrinsics::new(61.0, 3.0, -2.0),
        );
        let scene = Scene::new(Dir::from_deg(33.0, 140.0));
        let r = render(&cam, &scene, DEFAULT_ANALYZERS_DEG, &Degradations::default());
        let f = recover(&r.images, &StokesThresholds::default());
        let mut checked = 0;
        for i in 0..f.len() {
            if !f.valid[i] {
                continue;
            }
            assert_relative_eq!(f.s0[i], 1.0, epsilon = 1e-12);
            assert_relative_eq!(f.dolp[i], r.truth.dolp[i], epsilon = 1e-12);
            assert!(
                diff180_deg(f.aolp_rad[i].to_degrees(), r.truth.aolp_pixel_deg[i]).abs() < 1e-8
            );
            checked += 1;
        }
        assert!(checked > 3000, "only {checked} valid pixels");
    }

    #[test]
    fn thresholds_reject_the_mask_and_the_neutral_points() {
        let cam = Camera::new(
            FisheyeIntrinsics::new(81, 81, 180.0),
            Extrinsics::level(0.0),
        );
        let scene = Scene::new(Dir::from_deg(30.0, 90.0));
        let mask = PixelRegion::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: 80.0,
            y1: 31.0,
        };
        let r = render(
            &cam,
            &scene,
            DEFAULT_ANALYZERS_DEG,
            &Degradations::default().with_mask(mask),
        );
        let f = recover(&r.images, &StokesThresholds::default());
        // Every truly masked pixel is rejected: S0 collapsed to zero there.
        for i in 0..f.len() {
            if r.truth.masked[i] && r.truth.in_fov[i] {
                assert!(!f.valid[i], "masked pixel {i} survived");
                assert_relative_eq!(f.s0[i], 0.0, epsilon = 1e-15);
            }
        }
        // The estimator's own rejected fraction is at least the true masked
        // fraction (it also drops the low-DoLP neighbourhood of the Sun).
        let seen = f.rejected_fraction(&r.truth.in_fov);
        let truth = r.truth.masked_fraction();
        assert!(truth > 0.2, "mask covered only {truth}");
        assert!(seen >= truth, "seen {seen} < truth {truth}");
        assert!(f.valid_count() > 0);
        assert_eq!(f.valid_aolp_deg().len(), f.valid_count());
        // Raising min_dolp throws away more.
        let strict = recover(
            &r.images,
            &StokesThresholds {
                min_s0: 0.05,
                min_dolp: 0.5,
            },
        );
        assert!(strict.valid_count() < f.valid_count());
    }
}
