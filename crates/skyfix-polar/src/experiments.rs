//! Seeded, deterministic comparison of the image sensor against the
//! few-channel sensor.
//!
//! One row per (Sun altitude, noise level, tilt error, sensor). Everything is
//! synthetic and everything is reproducible from [`ExperimentConfig::seed`]:
//! running the same config twice produces byte-identical output.
//!
//! **What the table is and is not.** It measures how two estimator geometries
//! behave against the *ideal Rayleigh model* under parametric defects. It is
//! not a field trial, it says nothing about cloud, haze, or twilight, and the
//! numbers must never be quoted as an accuracy specification.

use crate::camera::{
    Camera, DEFAULT_ANALYZERS_DEG, Degradations, Extrinsics, FisheyeIntrinsics, PixelRegion,
    RadianceModel, Scene, render,
};
use crate::heading::{
    AolpSample, HeadingConfig, HeadingEstimate, SampleOptions, Tilt, estimate, samples_from_stokes,
    samples_from_views,
};
use crate::sensor::{FewChannelSensor, SensorDegradations};
use crate::sky::{Dir, RayleighSky};
use crate::stokes::{StokesThresholds, recover};
use serde::{Deserialize, Serialize};

/// What to sweep.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExperimentConfig {
    pub sun_alt_deg: Vec<f64>,
    pub sun_az_deg: f64,
    pub true_heading_deg: f64,
    pub true_pitch_deg: f64,
    pub true_roll_deg: f64,
    /// Additive Gaussian noise standard deviations, as a fraction of `I0`.
    pub noise_sigmas: Vec<f64>,
    /// Degrees of pitch the estimator is *told wrongly*: the camera really has
    /// `true_pitch_deg`, the estimator assumes `true_pitch_deg - tilt_error`.
    pub tilt_errors_deg: Vec<f64>,
    pub image_size: usize,
    pub fov_deg: f64,
    pub sample_stride: usize,
    /// Few-channel geometry: `sensor_ring` lines of sight at `sensor_alt_deg`,
    /// plus the body zenith when `sensor_with_zenith`.
    pub sensor_ring: usize,
    pub sensor_alt_deg: f64,
    pub sensor_with_zenith: bool,
    pub analyzers_deg: [f64; 4],
    pub d_max: f64,
    pub gains: [f64; 4],
    pub radiance: RadianceModel,
    pub use_radiance_hint: bool,
    /// Optional missing-sky region, image sensor only: a few-channel sensor has
    /// no image plane to mask (see [`crate::sensor::MASK_NOT_REPRESENTABLE`]).
    pub mask: Option<PixelRegion>,
    pub thresholds: StokesThresholds,
    pub seed: u64,
}

impl Default for ExperimentConfig {
    fn default() -> Self {
        ExperimentConfig {
            sun_alt_deg: vec![10.0, 30.0, 50.0, 70.0],
            sun_az_deg: 135.0,
            true_heading_deg: 123.0,
            true_pitch_deg: 0.0,
            true_roll_deg: 0.0,
            noise_sigmas: vec![0.0, 0.01, 0.02],
            tilt_errors_deg: vec![0.0, 2.0],
            image_size: 81,
            fov_deg: 180.0,
            sample_stride: 1,
            sensor_ring: 4,
            sensor_alt_deg: 45.0,
            sensor_with_zenith: true,
            analyzers_deg: DEFAULT_ANALYZERS_DEG,
            d_max: 1.0,
            gains: [1.0; 4],
            radiance: RadianceModel::Uniform { i0: 1.0 },
            use_radiance_hint: false,
            mask: None,
            thresholds: StokesThresholds::default(),
            seed: 20_260_923,
        }
    }
}

/// One estimation run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComparisonRow {
    pub sensor: String,
    pub sun_alt_deg: f64,
    pub sun_az_deg: f64,
    pub true_heading_deg: f64,
    pub noise_sigma: f64,
    pub tilt_error_deg: f64,
    pub samples_used: usize,
    pub n_candidates: usize,
    pub best_heading_deg: Option<f64>,
    /// Error of the candidate nearest the truth. `None` when no candidate was
    /// returned, which is itself the result.
    pub nearest_error_deg: Option<f64>,
    pub best_residual_rms_deg: f64,
    /// Nominal, from the cost curvature. Not a field accuracy.
    pub sigma_deg: Option<f64>,
    pub anti_heading_deg: Option<f64>,
    pub anti_cost: Option<f64>,
    pub ambiguity_flagged: bool,
    pub ambiguity: String,
    /// Image sensor only: fraction of in-field pixels the thresholds rejected.
    /// Always `None` for the few-channel sensor, which has no image plane and
    /// therefore cannot measure how much sky it lost.
    pub rejected_fraction: Option<f64>,
}

/// The table plus the configuration that produced it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComparisonTable {
    pub rows: Vec<ComparisonRow>,
    pub config: ExperimentConfig,
    pub caveat: String,
}

fn fmt_opt(v: Option<f64>, dp: usize) -> String {
    match v {
        Some(x) if x.is_finite() => format!("{x:.dp$}"),
        _ => String::new(),
    }
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

impl ComparisonTable {
    pub const HEADER: &'static str = "sensor,sun_alt_deg,sun_az_deg,true_heading_deg,noise_sigma,\
tilt_error_deg,samples_used,n_candidates,best_heading_deg,nearest_error_deg,\
best_residual_rms_deg,sigma_deg,anti_heading_deg,anti_cost,ambiguity_flagged,\
rejected_fraction,ambiguity";

    /// RFC 4180 CSV. Written by hand: this crate adds no dependencies.
    pub fn to_csv(&self) -> String {
        let mut out = String::from(Self::HEADER);
        out.push('\n');
        for r in &self.rows {
            out.push_str(&format!(
                "{},{:.1},{:.1},{:.3},{:.4},{:.2},{},{},{},{},{:.5},{},{},{},{},{},{}\n",
                csv_field(&r.sensor),
                r.sun_alt_deg,
                r.sun_az_deg,
                r.true_heading_deg,
                r.noise_sigma,
                r.tilt_error_deg,
                r.samples_used,
                r.n_candidates,
                fmt_opt(r.best_heading_deg, 4),
                fmt_opt(r.nearest_error_deg, 4),
                r.best_residual_rms_deg,
                fmt_opt(r.sigma_deg, 5),
                fmt_opt(r.anti_heading_deg, 4),
                fmt_opt(r.anti_cost, 3),
                r.ambiguity_flagged,
                fmt_opt(r.rejected_fraction, 4),
                csv_field(&r.ambiguity),
            ));
        }
        out
    }

    /// A compact human-readable table for a report. Drops the long ambiguity
    /// prose, which `to_csv` keeps.
    pub fn to_text(&self) -> String {
        let mut out = String::from(
            "sensor        sun_alt  noise  tilt_err  n_samp  err_deg   sigma_deg  amb\n",
        );
        for r in &self.rows {
            out.push_str(&format!(
                "{:<13} {:>7.1} {:>6.3} {:>9.2} {:>7} {:>8} {:>10} {:>4}\n",
                r.sensor,
                r.sun_alt_deg,
                r.noise_sigma,
                r.tilt_error_deg,
                r.samples_used,
                fmt_opt(r.nearest_error_deg, 4),
                fmt_opt(r.sigma_deg, 5),
                if r.ambiguity_flagged { "yes" } else { "no" },
            ));
        }
        out
    }
}

fn row_seed(base: u64, index: usize) -> u64 {
    base ^ (index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

fn summarise(
    est: &HeadingEstimate,
    sensor: &str,
    cfg: &ExperimentConfig,
    sun_alt: f64,
    noise: f64,
    tilt_err: f64,
    rejected: Option<f64>,
) -> ComparisonRow {
    let best = est.best();
    let anti = best.and_then(|b| {
        est.candidates
            .iter()
            .find(|c| crate::angles::diff360_deg(c.heading_deg, b.heading_deg + 180.0).abs() < 2.0)
            .copied()
    });
    ComparisonRow {
        sensor: sensor.to_string(),
        sun_alt_deg: sun_alt,
        sun_az_deg: cfg.sun_az_deg,
        true_heading_deg: cfg.true_heading_deg,
        noise_sigma: noise,
        tilt_error_deg: tilt_err,
        samples_used: est.samples_used,
        n_candidates: est.candidates.len(),
        best_heading_deg: best.map(|b| b.heading_deg),
        nearest_error_deg: est.nearest_error_deg(cfg.true_heading_deg),
        best_residual_rms_deg: est.residual_rms_deg,
        sigma_deg: best.map(|b| b.sigma_deg),
        anti_heading_deg: anti.map(|a| a.heading_deg),
        anti_cost: anti.map(|a| a.cost),
        ambiguity_flagged: est.ambiguity_flagged(),
        ambiguity: est.ambiguity.clone(),
        rejected_fraction: rejected,
    }
}

/// Run the sweep. Deterministic: same config, same table.
pub fn compare_sensors(cfg: &ExperimentConfig) -> ComparisonTable {
    let mut rows = Vec::new();
    let mut index = 0usize;
    let hcfg = HeadingConfig {
        use_radiance_hint: cfg.use_radiance_hint,
        ..Default::default()
    };
    let intr = FisheyeIntrinsics::new(cfg.image_size, cfg.image_size, cfg.fov_deg);
    let true_extr = Extrinsics::new(cfg.true_heading_deg, cfg.true_pitch_deg, cfg.true_roll_deg);

    for &alt in &cfg.sun_alt_deg {
        let sun = Dir::from_deg(alt, cfg.sun_az_deg);
        let scene = Scene {
            sky: RayleighSky::new(cfg.d_max),
            sun,
            radiance: cfg.radiance,
        };
        for &noise in &cfg.noise_sigmas {
            for &tilt_err in &cfg.tilt_errors_deg {
                // The estimator is told a pitch that is wrong by `tilt_err`.
                let assumed = Tilt::new(cfg.true_pitch_deg - tilt_err, cfg.true_roll_deg);

                // --- image sensor ------------------------------------------
                index += 1;
                let mut deg = Degradations::seeded(row_seed(cfg.seed, index))
                    .with_noise(noise)
                    .with_gains(cfg.gains);
                deg.mask = cfg.mask;
                let r = render(
                    &Camera::new(intr, true_extr),
                    &scene,
                    cfg.analyzers_deg,
                    &deg,
                );
                let field = recover(&r.images, &cfg.thresholds);
                let samples: Vec<AolpSample> = samples_from_stokes(
                    &intr,
                    &field,
                    &SampleOptions {
                        stride: cfg.sample_stride,
                        weight_by_dolp: false,
                    },
                );
                let est = estimate(&samples, sun, assumed, &hcfg);
                rows.push(summarise(
                    &est,
                    "image",
                    cfg,
                    alt,
                    noise,
                    tilt_err,
                    Some(field.rejected_fraction(&r.images.in_fov)),
                ));

                // --- few-channel sensor ------------------------------------
                index += 1;
                let sensor = FewChannelSensor::ring(
                    cfg.sensor_ring,
                    cfg.sensor_alt_deg,
                    cfg.sensor_with_zenith,
                    &cfg.analyzers_deg,
                    true_extr,
                );
                let channels = sensor.channel_count();
                let sdeg = SensorDegradations::seeded(row_seed(cfg.seed, index))
                    .with_noise(noise)
                    .with_uniform_gains(&cfg.gains, channels);
                let readings = crate::sensor::read(&sensor, &scene, &sdeg);
                let views = crate::sensor::recover_views(&sensor, &readings, &cfg.thresholds);
                let samples = samples_from_views(&views);
                let est = estimate(&samples, sun, assumed, &hcfg);
                rows.push(summarise(
                    &est,
                    "few-channel",
                    cfg,
                    alt,
                    noise,
                    tilt_err,
                    None,
                ));
            }
        }
    }

    ComparisonTable {
        rows,
        config: cfg.clone(),
        caveat: "Synthetic. Ideal single-scattering Rayleigh sky, a stress model rather than \
                 validated atmosphere physics. sigma_deg is nominal (cost-curve curvature). \
                 Nothing here is a field accuracy, an all-weather claim, or a position fix."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small() -> ExperimentConfig {
        ExperimentConfig {
            sun_alt_deg: vec![30.0],
            noise_sigmas: vec![0.0, 0.02],
            tilt_errors_deg: vec![0.0],
            image_size: 41,
            sensor_ring: 4,
            ..Default::default()
        }
    }

    #[test]
    fn the_sweep_is_deterministic() {
        let cfg = small();
        let a = compare_sensors(&cfg);
        let b = compare_sensors(&cfg);
        assert_eq!(a, b);
        assert_eq!(a.to_csv(), b.to_csv());
        assert_eq!(a.rows.len(), 4); // 1 alt x 2 noise x 1 tilt x 2 sensors
    }

    #[test]
    fn csv_has_one_header_and_one_line_per_row_and_quotes_prose() {
        let t = compare_sensors(&small());
        let csv = t.to_csv();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), t.rows.len() + 1);
        assert_eq!(lines[0], ComparisonTable::HEADER);
        assert_eq!(lines[0].split(',').count(), 17);
        // The ambiguity prose contains commas and must be quoted.
        assert!(lines[1].contains('"'), "{}", lines[1]);
        assert!(!t.to_text().is_empty());
    }

    #[test]
    fn the_table_round_trips_through_json() {
        let t = compare_sensors(&small());
        let s = serde_json::to_string(&t).unwrap();
        let back: ComparisonTable = serde_json::from_str(&s).unwrap();
        assert_eq!(t.rows.len(), back.rows.len());
        assert_eq!(t.config, back.config);
        assert_eq!(t.caveat, back.caveat);
        for (a, b) in t.rows.iter().zip(&back.rows) {
            assert_eq!(a.sensor, b.sensor);
            assert_eq!(a.ambiguity, b.ambiguity);
            assert_eq!(a.samples_used, b.samples_used);
            assert_eq!(a.ambiguity_flagged, b.ambiguity_flagged);
            // Floats: the JSON writer emits a shortest representation that can
            // lose the last unit in the last place on subnormal-scale values
            // such as a zero-residual sigma. Compare numerically, not by bits.
            let close = |x: Option<f64>, y: Option<f64>| match (x, y) {
                (Some(x), Some(y)) => (x - y).abs() <= 1e-9 * x.abs().max(1.0),
                (None, None) => true,
                _ => false,
            };
            assert!(close(a.best_heading_deg, b.best_heading_deg));
            assert!(close(a.nearest_error_deg, b.nearest_error_deg));
            assert!(close(a.sigma_deg, b.sigma_deg));
            assert!(close(a.anti_heading_deg, b.anti_heading_deg));
        }
        // The rendered CSV, which is what a report quotes, is exact.
        assert_eq!(t.to_csv(), back.to_csv());
    }

    #[test]
    fn the_few_channel_sensor_cannot_see_an_image_mask() {
        // The image rows change when a mask is applied; the few-channel rows
        // are bit-identical, because the mask is not representable for them.
        let plain = compare_sensors(&small());
        let masked_cfg = ExperimentConfig {
            mask: Some(PixelRegion::Rect {
                x0: 0.0,
                y0: 0.0,
                x1: 40.0,
                y1: 15.0,
            }),
            ..small()
        };
        let masked = compare_sensors(&masked_cfg);
        for (a, b) in plain.rows.iter().zip(&masked.rows) {
            if a.sensor == "few-channel" {
                assert_eq!(a, b, "the mask reached the few-channel sensor");
                assert!(a.rejected_fraction.is_none());
            } else {
                assert!(b.samples_used < a.samples_used, "the mask did nothing");
                assert!(b.rejected_fraction.unwrap() > a.rejected_fraction.unwrap());
            }
        }
    }
}
