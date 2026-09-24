//! Few-channel polarization sensor: `N` photodiodes, each with its own line of
//! sight and its own analyzer angle.
//!
//! This is the architecture most insect-inspired and most fielded polarization
//! compasses use: a handful of photodiodes rather than a megapixel imager. The
//! point of having it here is the **comparison** with the image sensor, not a
//! claim that either one works outdoors.
//!
//! # Same conventions as the camera, deliberately
//!
//! A photodiode's line of sight is a body-frame `(altitude, azimuth)` pair, and
//! its analyzer angle uses the same zero and the same sense as a camera pixel's
//! (see `camera.rs`). The consequence is a property worth testing: a photodiode
//! pointed at the direction a pixel sees, carrying that pixel's analyzer angle,
//! records that pixel's intensity exactly. `sensor_channel_matches_pixel` in
//! the integration tests pins it down.
//!
//! # What a few-channel sensor structurally cannot do
//!
//! It has no image plane, so **an image-plane mask has no meaning for it**. A
//! cloud is not "40 % of the pixels"; it is either in front of a photodiode or
//! it is not. [`SensorDegradations`] therefore has no mask field at all, only
//! an all-or-nothing `blocked` flag per view. It also cannot report how much
//! sky it lost, because it never had a spatial sample of the sky to lose. See
//! [`MASK_NOT_REPRESENTABLE`].
//!
//! # Stokes recovery
//!
//! With three or more distinct analyzer angles on one line of sight,
//! `I_k = S0/2 + (S1 cos 2t_k + S2 sin 2t_k)/2` is linear in `(S0, S1, S2)` and
//! is solved by least squares. With exactly the conventional four angles the
//! least-squares solution equals the closed form in `stokes.rs`.

use crate::camera::{Extrinsics, Scene, ViewGeom};
use crate::rng::Rng;
use crate::sky::Dir;
use crate::stokes::{StokesThresholds, analyzer_intensity, dolp_aolp};
use crate::vec3::{Vec3, mat_vec};
use serde::{Deserialize, Serialize};

/// Why a few-channel sensor cannot be given the image sensor's mask.
pub const MASK_NOT_REPRESENTABLE: &str =
    "few-channel sensor: an image-plane mask is not representable. It has no image plane, \
     so missing sky is all-or-nothing per photodiode (`blocked`), and the sensor cannot \
     report what fraction of the sky it lost.";

/// One line of sight with the analyzer angles measured along it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensorView {
    /// Line of sight in the sensor body frame (altitude from the plane
    /// perpendicular to the body `+z` axis, azimuth from body `+y`).
    pub dir_body: Dir,
    /// Analyzer angles in degrees. Three or more distinct values are needed for
    /// a solvable view.
    pub analyzers_deg: Vec<f64>,
}

/// `N` photodiodes grouped by line of sight, plus the body attitude.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FewChannelSensor {
    pub views: Vec<SensorView>,
    pub extrinsics: Extrinsics,
}

impl FewChannelSensor {
    /// A single line of sight at the body's zenith.
    ///
    /// This is the textbook polarization compass, and the case where the
    /// 180 deg heading ambiguity is **exact**: the E-vector at the zenith is
    /// perpendicular to the solar meridian, which is a line, so it fixes
    /// heading only modulo 180 deg no matter how good the photodiodes are.
    pub fn zenith_only(analyzers_deg: &[f64], extrinsics: Extrinsics) -> Self {
        FewChannelSensor {
            views: vec![SensorView {
                dir_body: Dir::from_deg(90.0, 0.0),
                analyzers_deg: analyzers_deg.to_vec(),
            }],
            extrinsics,
        }
    }

    /// `n` lines of sight evenly spaced in body azimuth at one altitude, plus
    /// optionally the body zenith.
    pub fn ring(
        n: usize,
        alt_deg: f64,
        with_zenith: bool,
        analyzers_deg: &[f64],
        extrinsics: Extrinsics,
    ) -> Self {
        let mut views = Vec::with_capacity(n + usize::from(with_zenith));
        if with_zenith {
            views.push(SensorView {
                dir_body: Dir::from_deg(90.0, 0.0),
                analyzers_deg: analyzers_deg.to_vec(),
            });
        }
        for i in 0..n {
            views.push(SensorView {
                dir_body: Dir::from_deg(alt_deg, 360.0 * i as f64 / n as f64),
                analyzers_deg: analyzers_deg.to_vec(),
            });
        }
        FewChannelSensor { views, extrinsics }
    }

    /// Total number of photodiodes.
    pub fn channel_count(&self) -> usize {
        self.views.iter().map(|v| v.analyzers_deg.len()).sum()
    }

    /// The Sun expressed in the sensor body frame.
    pub fn sun_in_body(&self, sun: Dir) -> Vec3 {
        mat_vec(&self.extrinsics.rotation_inverse(), sun.to_unit())
    }
}

/// Optional, seeded defects. Empty vectors mean "no defect on any channel".
///
/// **There is no mask field.** See [`MASK_NOT_REPRESENTABLE`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SensorDegradations {
    pub seed: u64,
    pub noise_sigma: f64,
    /// Per-channel gain, flattened in view order then analyzer order.
    pub gains: Vec<f64>,
    /// Per-channel analyzer misalignment in degrees; the estimator is told only
    /// the nominal angle.
    pub analyzer_offsets_deg: Vec<f64>,
    /// Per-view DoLP multiplier (depolarization). **Stress model, not cloud
    /// physics.**
    pub depolarization: Vec<f64>,
    /// Per-view all-or-nothing obstruction.
    pub blocked: Vec<bool>,
}

impl SensorDegradations {
    pub fn seeded(seed: u64) -> Self {
        SensorDegradations {
            seed,
            ..Default::default()
        }
    }

    pub fn with_noise(mut self, sigma: f64) -> Self {
        self.noise_sigma = sigma;
        self
    }

    /// Repeat a short gain pattern across `channels` photodiodes.
    pub fn with_uniform_gains(mut self, gains: &[f64], channels: usize) -> Self {
        if !gains.is_empty() {
            self.gains = (0..channels).map(|i| gains[i % gains.len()]).collect();
        }
        self
    }

    fn gain(&self, channel: usize) -> f64 {
        self.gains.get(channel).copied().unwrap_or(1.0)
    }

    fn offset_rad(&self, channel: usize) -> f64 {
        self.analyzer_offsets_deg
            .get(channel)
            .copied()
            .unwrap_or(0.0)
            .to_radians()
    }

    fn depol(&self, view: usize) -> f64 {
        self.depolarization.get(view).copied().unwrap_or(1.0)
    }

    fn blocked(&self, view: usize) -> bool {
        self.blocked.get(view).copied().unwrap_or(false)
    }
}

/// Raw photodiode intensities, flattened in view order then analyzer order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensorReadings {
    pub intensities: Vec<f64>,
    /// Per view: the photodiodes that saw nothing.
    pub blocked: Vec<bool>,
}

/// Read the sensor against a scene.
pub fn read(sensor: &FewChannelSensor, scene: &Scene, deg: &SensorDegradations) -> SensorReadings {
    let s_body = sensor.sun_in_body(scene.sun);
    let mut rng = Rng::new(deg.seed);
    let mut intensities = Vec::with_capacity(sensor.channel_count());
    let mut blocked = Vec::with_capacity(sensor.views.len());
    let mut channel = 0usize;
    for (vi, view) in sensor.views.iter().enumerate() {
        let g = ViewGeom::from_body_dir(view.dir_body);
        let gamma = g.gamma_rad(s_body);
        let dolp = scene.sky.dolp(gamma) * deg.depol(vi);
        let psi = g.aolp_rad(s_body).unwrap_or(0.0);
        let i0 = scene.radiance.i0(gamma);
        let hidden = deg.blocked(vi);
        blocked.push(hidden);
        for nominal_deg in &view.analyzers_deg {
            let axis = nominal_deg.to_radians() + deg.offset_rad(channel);
            let noise = rng.normal_sigma(deg.noise_sigma);
            let value = if hidden {
                0.0
            } else {
                deg.gain(channel) * analyzer_intensity(i0, dolp, psi, axis) + noise
            };
            intensities.push(value);
            channel += 1;
        }
    }
    SensorReadings {
        intensities,
        blocked,
    }
}

/// Stokes parameters recovered for one line of sight.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ViewStokes {
    pub view_index: usize,
    pub dir_body: Dir,
    pub s0: f64,
    pub s1: f64,
    pub s2: f64,
    pub dolp: f64,
    /// AoLP in this view's own pixel-frame-equivalent basis, radians `[0, pi)`.
    pub aolp_rad: f64,
    pub valid: bool,
    /// RMS of the least-squares residual, in intensity units. With exactly
    /// three analyzer angles this is 0 by construction (no redundancy).
    pub residual_rms: f64,
}

/// Least-squares Stokes recovery, one solve per line of sight.
///
/// Reuses `skyfix_core::linalg::solve_sym_pd` for the 3x3 normal equations so
/// that no second linear solver exists in the workspace.
pub fn recover_views(
    sensor: &FewChannelSensor,
    readings: &SensorReadings,
    thresholds: &StokesThresholds,
) -> Vec<ViewStokes> {
    let mut out = Vec::with_capacity(sensor.views.len());
    let mut channel = 0usize;
    for (vi, view) in sensor.views.iter().enumerate() {
        let k = view.analyzers_deg.len();
        let rows: Vec<[f64; 3]> = view
            .analyzers_deg
            .iter()
            .map(|t| {
                let (s2t, c2t) = (2.0 * t.to_radians()).sin_cos();
                [0.5, 0.5 * c2t, 0.5 * s2t]
            })
            .collect();
        let obs: Vec<f64> = readings.intensities[channel..channel + k].to_vec();
        channel += k;

        // Normal equations A^T A x = A^T b, 3x3.
        let mut ata = vec![vec![0.0f64; 3]; 3];
        let mut atb = vec![0.0f64; 3];
        for (r, y) in rows.iter().zip(&obs) {
            for a in 0..3 {
                atb[a] += r[a] * y;
                for b in 0..3 {
                    ata[a][b] += r[a] * r[b];
                }
            }
        }
        let solution = skyfix_core::linalg::solve_sym_pd(&ata, &atb);
        let solved = solution.is_some();
        let (s0, s1, s2) = match &solution {
            Some(x) => (x[0], x[1], x[2]),
            None => (0.0, 0.0, 0.0),
        };
        let (dolp, aolp) = dolp_aolp(s0, s1, s2);
        let residual_rms = if obs.is_empty() {
            0.0
        } else {
            let ss: f64 = rows
                .iter()
                .zip(&obs)
                .map(|(r, y)| {
                    let pred = r[0] * s0 + r[1] * s1 + r[2] * s2;
                    (pred - y) * (pred - y)
                })
                .sum();
            (ss / obs.len() as f64).sqrt()
        };
        out.push(ViewStokes {
            view_index: vi,
            dir_body: view.dir_body,
            s0,
            s1,
            s2,
            dolp,
            aolp_rad: aolp,
            valid: solved
                && k >= 3
                && s0 >= thresholds.min_s0
                && dolp >= thresholds.min_dolp,
            residual_rms,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::angles::diff180_deg;
    use crate::camera::{
        Camera, DEFAULT_ANALYZERS_DEG, Degradations, FisheyeIntrinsics, render,
    };
    use crate::stokes::stokes_from_four;
    use approx::assert_relative_eq;

    fn scene() -> Scene {
        Scene::new(Dir::from_deg(35.0, 215.0))
    }

    #[test]
    fn least_squares_reproduces_the_closed_form_for_four_angles() {
        let sensor = FewChannelSensor::ring(
            4,
            45.0,
            true,
            &DEFAULT_ANALYZERS_DEG,
            Extrinsics::new(72.0, 5.0, -3.0),
        );
        assert_eq!(sensor.channel_count(), 20);
        let r = read(&sensor, &scene(), &SensorDegradations::default());
        let views = recover_views(&sensor, &r, &StokesThresholds::default());
        assert_eq!(views.len(), 5);
        for (vi, v) in views.iter().enumerate() {
            let base = vi * 4;
            let (s0, s1, s2) = stokes_from_four(
                r.intensities[base],
                r.intensities[base + 1],
                r.intensities[base + 2],
                r.intensities[base + 3],
            );
            assert_relative_eq!(v.s0, s0, epsilon = 1e-10);
            assert_relative_eq!(v.s1, s1, epsilon = 1e-10);
            assert_relative_eq!(v.s2, s2, epsilon = 1e-10);
            // Four ideal angles are exactly consistent: no residual.
            assert!(v.residual_rms < 1e-12, "residual {}", v.residual_rms);
            assert!(v.valid);
        }
    }

    #[test]
    fn three_angles_are_enough_and_two_are_not() {
        let three = FewChannelSensor::zenith_only(&[0.0, 60.0, 120.0], Extrinsics::level(40.0));
        let r = read(&three, &scene(), &SensorDegradations::default());
        let v = recover_views(&three, &r, &StokesThresholds::default());
        assert!(v[0].valid);
        // Compare against the truth the scene implies for that line of sight.
        let g = ViewGeom::from_body_dir(three.views[0].dir_body);
        let s_body = three.sun_in_body(scene().sun);
        let truth_dolp = scene().sky.dolp(g.gamma_rad(s_body));
        let truth_psi = g.aolp_rad(s_body).unwrap().to_degrees();
        assert_relative_eq!(v[0].dolp, truth_dolp, epsilon = 1e-10);
        assert!(diff180_deg(v[0].aolp_rad.to_degrees(), truth_psi).abs() < 1e-8);

        let two = FewChannelSensor::zenith_only(&[0.0, 90.0], Extrinsics::level(40.0));
        let r2 = read(&two, &scene(), &SensorDegradations::default());
        let v2 = recover_views(&two, &r2, &StokesThresholds::default());
        assert!(!v2[0].valid, "two analyzer angles cannot determine S0, S1, S2");
    }

    #[test]
    fn a_photodiode_records_exactly_what_the_matching_pixel_records() {
        // The structural claim that keeps the two sensor models comparable.
        let intr = FisheyeIntrinsics::new(101, 101, 180.0);
        let extr = Extrinsics::new(123.0, 7.0, -4.0);
        let cam = Camera::new(intr, extr);
        let sc = scene();
        let r = render(&cam, &sc, DEFAULT_ANALYZERS_DEG, &Degradations::default());
        for (col, row) in [(50usize, 50usize), (60, 40), (20, 70), (50, 5)] {
            let g = intr.pixel_geom(col, row).unwrap();
            let dir = Dir::from_unit(g.dir);
            let sensor = FewChannelSensor {
                views: vec![SensorView {
                    dir_body: dir,
                    analyzers_deg: DEFAULT_ANALYZERS_DEG.to_vec(),
                }],
                extrinsics: extr,
            };
            let sr = read(&sensor, &sc, &SensorDegradations::default());
            let i = r.images.index(col, row);
            for k in 0..4 {
                assert_relative_eq!(sr.intensities[k], r.images.planes[k][i], epsilon = 1e-9);
            }
        }
    }

    #[test]
    fn degradations_and_blocking_behave() {
        let sensor = FewChannelSensor::ring(
            4,
            45.0,
            true,
            &DEFAULT_ANALYZERS_DEG,
            Extrinsics::level(15.0),
        );
        let n = sensor.channel_count();
        let clean = read(&sensor, &scene(), &SensorDegradations::default());

        // Noise is seeded and reproducible.
        let d = SensorDegradations::seeded(3).with_noise(0.02);
        assert_eq!(read(&sensor, &scene(), &d), read(&sensor, &scene(), &d));
        assert_ne!(
            read(&sensor, &scene(), &d),
            read(&sensor, &scene(), &SensorDegradations::seeded(4).with_noise(0.02))
        );

        // Gains scale their own channel only.
        let d = SensorDegradations::default().with_uniform_gains(&[1.0, 1.03, 0.98, 1.01], n);
        let gained = read(&sensor, &scene(), &d);
        for i in 0..n {
            let g = [1.0, 1.03, 0.98, 1.01][i % 4];
            assert_relative_eq!(gained.intensities[i], g * clean.intensities[i], epsilon = 1e-12);
        }

        // A blocked view reads zero and is rejected; the others are untouched.
        let d = SensorDegradations {
            blocked: vec![false, true, false, false, false],
            ..Default::default()
        };
        let blocked = read(&sensor, &scene(), &d);
        assert!(blocked.blocked[1]);
        for k in 4..8 {
            assert_eq!(blocked.intensities[k], 0.0);
        }
        let v = recover_views(&sensor, &blocked, &StokesThresholds::default());
        assert!(!v[1].valid);
        assert!(v[0].valid && v[2].valid);

        // Depolarization reduces DoLP on its view alone.
        let d = SensorDegradations {
            depolarization: vec![0.2, 1.0, 1.0, 1.0, 1.0],
            ..Default::default()
        };
        let depol = recover_views(&sensor, &read(&sensor, &scene(), &d), &StokesThresholds::default());
        let base = recover_views(&sensor, &clean, &StokesThresholds::default());
        assert_relative_eq!(depol[0].dolp, 0.2 * base[0].dolp, epsilon = 1e-10);
        assert_relative_eq!(depol[1].dolp, base[1].dolp, epsilon = 1e-12);
    }

    #[test]
    fn the_mask_note_is_available_and_says_why() {
        assert!(MASK_NOT_REPRESENTABLE.contains("no image plane"));
        // Structural: SensorDegradations has no mask field, so there is no way
        // to express an image-plane mask here at all.
        let d = SensorDegradations::default();
        assert!(d.blocked.is_empty());
    }
}
