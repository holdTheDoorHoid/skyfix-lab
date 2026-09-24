//! Heading estimation from a recovered AoLP field, and its ambiguities.
//!
//! # What the caller supplies
//!
//! * the Sun's altitude and azimuth, from time and an approximate position —
//!   this module never computes them, see [`crate::ephem`];
//! * the **assumed** tilt of the instrument;
//! * a set of AoLP samples in the instrument body frame: either every valid
//!   pixel of an image ([`samples_from_stokes`]) or a handful of photodiode
//!   groups ([`samples_from_views`]).
//!
//! # Method
//!
//! For a trial heading, predict the AoLP at every sample and sum the squared
//! modulo-180-degree residuals:
//!
//! ```text
//! C(h) = sum_i w_i * diff180(psi_pred_i(h), psi_obs_i)^2      [deg^2]
//! ```
//!
//! evaluated on a 1-degree grid over `[0, 360)`, then every local minimum is
//! refined by golden section. The whole cost curve is returned, because the
//! shape of it is the honest answer: a single sharp minimum, two equal minima
//! and a flat curve are three different physical situations, and only the curve
//! distinguishes them.
//!
//! The prediction is cheap because a rotation commutes with the cross product:
//! the entire camera-frame field depends on the heading only through the Sun
//! direction expressed in the body frame, so one trial heading costs one 3x3
//! multiply plus one cross product per sample.
//!
//! An analytic alternative exists — fit the symmetry axis of the pattern, which
//! is the solar meridian — and [`heading_from_zenith_aolp`] implements its
//! degenerate one-sample case in closed form. It is not the default: a
//! symmetry-axis fit returns an *axis*, so it can never do better than modulo
//! 180 degrees, and it throws away the cost curve.
//!
//! # The 180-degree question, stated precisely
//!
//! Two separate facts get conflated in the literature, and this module keeps
//! them apart.
//!
//! 1. **Sun/anti-Sun is an exact symmetry of the field.** For any sky point,
//!    replacing the Sun by the anti-Sun leaves DoLP and AoLP unchanged
//!    ([`crate::sky::sun_antisun_degenerate`]). No polarization measurement
//!    anywhere can break it.
//! 2. **That does not automatically make heading ambiguous by 180 degrees.**
//!    Turning the instrument by 180 degrees about the *vertical* maps the Sun
//!    to `(altitude, azimuth + 180)`, which is the anti-Sun only when the Sun
//!    is on the horizon. So:
//!    * a **zenith-only** sensor (or any sensor whose samples cluster near the
//!      zenith) is ambiguous by exactly 180 degrees, always;
//!    * a **wide-field** sensor sees a field that is genuinely different at
//!      `h + 180`, and the difference grows with Sun altitude. The separation
//!      is real *within this ideal model*, but it is produced by the model's
//!      own Sun-above-horizon asymmetry and it collapses as the Sun nears the
//!      horizon or the field of view narrows.
//!
//! This estimator therefore **always returns the `h + 180` candidate with its
//! cost** and says in [`HeadingEstimate::ambiguity`] whether the costs actually
//! separate it. It never silently drops the alternative.
//!
//! # Unobservable cases
//!
//! With the Sun within [`HeadingConfig::zenith_sun_limit_deg`] of the zenith,
//! the whole pattern is rotationally symmetric about the vertical and heading
//! is **not observable from polarization at all**. No candidates are returned.

use crate::angles::{diff180_deg, diff360_deg, wrap360_deg};
use crate::camera::{Extrinsics, FisheyeIntrinsics, ViewGeom};
use crate::sensor::ViewStokes;
use crate::sky::{Dir, relative_radiance};
use crate::stokes::StokesField;
use crate::vec3::{Mat3, Vec3, mat_mul, mat_vec, transpose};
use serde::{Deserialize, Serialize};

/// Standing caveat attached to every estimate.
pub const MODEL_CAVEAT: &str =
    "ideal single-scattering Rayleigh sky: a stress model, not validated atmosphere physics. \
     These numbers describe the model, not the sky.";

/// Standing caveat attached to every `sigma_deg`.
pub const SIGMA_CAVEAT: &str =
    "sigma_deg is nominal: the curvature of this cost curve under an independent-residual \
     assumption. It is not a validated field accuracy.";

/// Note emitted whenever the optional radiance disambiguator is used.
pub const RADIANCE_HINT_CAVEAT: &str =
    "radiance hint: uses a simplified radiance model, not validated. The true Rayleigh phase \
     function is symmetric about 90 degrees of scattering angle and would resolve nothing; \
     this hint stands in for aerosol forward scattering and is not a measurement of it.";

/// The instrument tilt the estimator is told to assume. Degrees, matching
/// [`Extrinsics`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Tilt {
    pub pitch_deg: f64,
    pub roll_deg: f64,
}

impl Tilt {
    pub fn new(pitch_deg: f64, roll_deg: f64) -> Self {
        Tilt {
            pitch_deg,
            roll_deg,
        }
    }

    pub fn from_extrinsics(e: &Extrinsics) -> Self {
        Tilt::new(e.pitch_deg, e.roll_deg)
    }
}

/// One measured AoLP with the body-frame geometry it was measured along.
///
/// The geometry is fixed by the instrument, not by the heading: that is what
/// lets a single sample set be scored against every trial heading.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AolpSample {
    pub geom: ViewGeom,
    /// Measured AoLP in the pixel frame, radians.
    pub aolp_rad: f64,
    pub weight: f64,
    /// Recovered total intensity `S0`, used only by the optional radiance hint.
    pub radiance: f64,
}

/// How to turn a recovered field into samples.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SampleOptions {
    /// Take every `stride`-th pixel in each direction. 1 keeps them all.
    pub stride: usize,
    /// Weight each residual by its DoLP. Off by default: the brief's cost is a
    /// plain sum of squared modulo-180 differences.
    pub weight_by_dolp: bool,
}

impl Default for SampleOptions {
    fn default() -> Self {
        SampleOptions {
            stride: 1,
            weight_by_dolp: false,
        }
    }
}

/// Samples from an image: one per valid pixel.
pub fn samples_from_stokes(
    intrinsics: &FisheyeIntrinsics,
    field: &StokesField,
    options: &SampleOptions,
) -> Vec<AolpSample> {
    let stride = options.stride.max(1);
    let mut out = Vec::new();
    for row in (0..intrinsics.height).step_by(stride) {
        for col in (0..intrinsics.width).step_by(stride) {
            let i = intrinsics.index(col, row);
            if !field.valid[i] {
                continue;
            }
            let Some(geom) = intrinsics.pixel_geom(col, row) else {
                continue;
            };
            out.push(AolpSample {
                geom,
                aolp_rad: field.aolp_rad[i],
                weight: if options.weight_by_dolp {
                    field.dolp[i]
                } else {
                    1.0
                },
                radiance: field.s0[i],
            });
        }
    }
    out
}

/// Samples from a few-channel sensor: one per valid line of sight.
pub fn samples_from_views(views: &[ViewStokes]) -> Vec<AolpSample> {
    views
        .iter()
        .filter(|v| v.valid)
        .map(|v| AolpSample {
            geom: ViewGeom::from_body_dir(v.dir_body),
            aolp_rad: v.aolp_rad,
            weight: 1.0,
            radiance: v.s0,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// One heading hypothesis and what it costs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HeadingCandidate {
    pub heading_deg: f64,
    /// Sum of squared modulo-180 residuals, in degrees squared.
    pub cost: f64,
    /// Nominal 1-sigma from the cost curvature. See [`SIGMA_CAVEAT`].
    pub sigma_deg: f64,
}

/// One point of the returned cost curve.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CostPoint {
    pub heading_deg: f64,
    pub cost: f64,
}

/// Every unresolved candidate, with the evidence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingEstimate {
    /// Sorted by cost, best first. Empty when heading is unobservable.
    pub candidates: Vec<HeadingCandidate>,
    /// What is and is not resolved, in words, with the numbers that say so.
    pub ambiguity: String,
    pub method: String,
    pub notes: Vec<String>,
    /// The coarse grid cost curve, always returned.
    pub cost_curve: Vec<CostPoint>,
    pub samples_used: usize,
    /// RMS modulo-180 residual at the best candidate, degrees.
    pub residual_rms_deg: f64,
}

impl HeadingEstimate {
    pub fn best(&self) -> Option<HeadingCandidate> {
        self.candidates.first().copied()
    }

    /// Error of the candidate nearest a known truth, degrees. Evaluation only.
    pub fn nearest_error_deg(&self, truth_deg: f64) -> Option<f64> {
        self.candidates
            .iter()
            .map(|c| diff360_deg(c.heading_deg, truth_deg).abs())
            .fold(None, |acc: Option<f64>, e| Some(acc.map_or(e, |a| a.min(e))))
    }

    /// True when a candidate within `tol` of `best + 180` is present.
    pub fn has_anti_candidate(&self, tol_deg: f64) -> bool {
        let Some(b) = self.best() else { return false };
        self.candidates
            .iter()
            .skip(1)
            .any(|c| diff360_deg(c.heading_deg, b.heading_deg + 180.0).abs() <= tol_deg)
    }

    /// True when the 180-degree alternative could not be separated by cost.
    pub fn ambiguity_flagged(&self) -> bool {
        self.ambiguity.starts_with("unresolved-180")
            || self.ambiguity.starts_with("unobservable")
    }
}

/// Search settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingConfig {
    pub coarse_step_deg: f64,
    pub refine_tol_deg: f64,
    /// Heading is declared unobservable when the Sun is this close to the
    /// zenith. 5 degrees per the brief.
    pub zenith_sun_limit_deg: f64,
    /// The 180-degree alternative counts as separated when
    /// `(cost_anti - cost_best) / s^2` exceeds this, with
    /// `s^2 = cost_best / (n - 1)` the residual variance. Same machinery as
    /// `docs/CONVENTIONS.md` section 8, one degree of freedom: 3.841 is the
    /// chi-square 95 % point for 1 dof.
    pub ambiguity_delta_chi2: f64,
    /// Floor on the residual RMS used for `s`, in degrees. Without it, a
    /// synthetic case with an exactly zero residual would declare every
    /// alternative infinitely well separated.
    pub ambiguity_floor_deg: f64,
    /// Opt-in radiance-gradient disambiguator. See [`RADIANCE_HINT_CAVEAT`].
    pub use_radiance_hint: bool,
    pub max_candidates: usize,
    pub method: String,
}

impl Default for HeadingConfig {
    fn default() -> Self {
        HeadingConfig {
            coarse_step_deg: 1.0,
            refine_tol_deg: 1e-4,
            zenith_sun_limit_deg: 5.0,
            ambiguity_delta_chi2: 3.841,
            ambiguity_floor_deg: 0.10,
            use_radiance_hint: false,
            max_candidates: 8,
            method: "AoLP field grid search (1 deg) + golden-section refinement".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/// Maps a trial heading to the Sun direction in the instrument body frame.
///
/// `R = R_yaw(h) R_pitch R_roll`, so `s_body = R_roll^T R_pitch^T R_yaw(h)^T s`.
/// Only the last factor depends on the heading, and it is a 2-D rotation of the
/// horizontal components.
#[derive(Debug, Clone, Copy)]
struct Predictor {
    tilt_inverse: Mat3,
    sun_world: Vec3,
}

impl Predictor {
    fn new(tilt: Tilt, sun: Dir) -> Self {
        let tilt_m = mat_mul(
            &Extrinsics::pitch_matrix(tilt.pitch_deg.to_radians()),
            &Extrinsics::roll_matrix(tilt.roll_deg.to_radians()),
        );
        Predictor {
            tilt_inverse: transpose(&tilt_m),
            sun_world: sun.to_unit(),
        }
    }

    fn sun_body(&self, heading_deg: f64) -> Vec3 {
        let (s, c) = heading_deg.to_radians().sin_cos();
        let w = self.sun_world;
        let yawed = [c * w[0] - s * w[1], s * w[0] + c * w[1], w[2]];
        mat_vec(&self.tilt_inverse, yawed)
    }
}

/// `(cost, samples used)` for one trial heading.
fn cost_at(samples: &[AolpSample], sun_body: Vec3) -> (f64, usize) {
    let mut cost = 0.0;
    let mut used = 0usize;
    for s in samples {
        if let Some(pred) = s.geom.aolp_rad(sun_body) {
            let d = diff180_deg(pred.to_degrees(), s.aolp_rad.to_degrees());
            cost += s.weight * d * d;
            used += 1;
        }
    }
    (cost, used)
}

/// Pearson correlation between the measured radiance and the simplified
/// brightness proxy under a trial heading. Positive means the bright half of
/// the sky sits where this heading puts the Sun.
fn radiance_correlation(samples: &[AolpSample], sun_body: Vec3) -> f64 {
    let n = samples.len();
    if n < 3 {
        return 0.0;
    }
    let mut mx = 0.0;
    let mut my = 0.0;
    let model: Vec<f64> = samples
        .iter()
        .map(|s| relative_radiance(s.geom.gamma_rad(sun_body), 1.0))
        .collect();
    for (s, m) in samples.iter().zip(&model) {
        mx += s.radiance;
        my += m;
    }
    mx /= n as f64;
    my /= n as f64;
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (s, m) in samples.iter().zip(&model) {
        let dx = s.radiance - mx;
        let dy = m - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx <= 0.0 || syy <= 0.0 {
        0.0
    } else {
        sxy / (sxx * syy).sqrt()
    }
}

/// Golden-section minimisation of a unimodal function on `[a, b]`.
fn golden_min<F: Fn(f64) -> f64>(f: F, mut a: f64, mut b: f64, tol: f64) -> (f64, f64) {
    const INV_PHI: f64 = 0.618_033_988_749_894_9;
    let mut c = b - (b - a) * INV_PHI;
    let mut d = a + (b - a) * INV_PHI;
    let (mut fc, mut fd) = (f(c), f(d));
    // 200 iterations is a hard stop; the tolerance normally ends it far sooner.
    for _ in 0..200 {
        if (b - a).abs() < tol {
            break;
        }
        if fc < fd {
            b = d;
            d = c;
            fd = fc;
            c = b - (b - a) * INV_PHI;
            fc = f(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + (b - a) * INV_PHI;
            fd = f(d);
        }
    }
    let x = (a + b) / 2.0;
    (x, f(x))
}

/// Nominal 1-sigma from the curvature of the cost curve.
///
/// `C(h) = sum_i d_i(h)^2` in degrees squared; with an independent-residual
/// assumption and `s^2 = C(h*) / (n - 1)`, the curvature gives
/// `sigma^2 = 2 s^2 / C''(h*)`. Returns 180 degrees (i.e. "no information")
/// when the curvature is not positive.
fn sigma_from_curvature<F: Fn(f64) -> f64>(f: F, h: f64, c_min: f64, n: usize, delta: f64) -> f64 {
    let second = (f(h + delta) - 2.0 * c_min + f(h - delta)) / (delta * delta);
    if !(second.is_finite() && second > 0.0) || n < 2 {
        return 180.0;
    }
    let s2 = c_min / (n as f64 - 1.0);
    (2.0 * s2 / second).sqrt().min(180.0)
}

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

/// Estimate heading, returning every unresolved candidate.
pub fn estimate(
    samples: &[AolpSample],
    sun: Dir,
    assumed_tilt: Tilt,
    cfg: &HeadingConfig,
) -> HeadingEstimate {
    let mut notes = vec![MODEL_CAVEAT.to_string(), SIGMA_CAVEAT.to_string()];
    let method = cfg.method.clone();

    // Unobservable: the pattern is rotationally symmetric about the vertical.
    let zenith_gap = 90.0 - sun.alt_deg();
    if zenith_gap.abs() < cfg.zenith_sun_limit_deg {
        notes.push(format!(
            "Sun is {:.2} deg from the zenith, inside the {:.1} deg limit.",
            zenith_gap.abs(),
            cfg.zenith_sun_limit_deg
        ));
        return HeadingEstimate {
            candidates: Vec::new(),
            ambiguity: format!(
                "unobservable: with the Sun {:.2} deg from the zenith the polarization pattern \
                 is (near-)rotationally symmetric about the vertical, so heading does not enter \
                 the measurement. No candidate is returned; this is a property of the geometry, \
                 not a failure of the search.",
                zenith_gap.abs()
            ),
            method,
            notes,
            cost_curve: Vec::new(),
            samples_used: 0,
            residual_rms_deg: f64::NAN,
        };
    }

    if samples.is_empty() {
        notes.push("no valid samples were supplied".to_string());
        return HeadingEstimate {
            candidates: Vec::new(),
            ambiguity: "unobservable: no valid samples. Every pixel or channel was rejected by \
                        the signal thresholds or the mask."
                .to_string(),
            method,
            notes,
            cost_curve: Vec::new(),
            samples_used: 0,
            residual_rms_deg: f64::NAN,
        };
    }

    let predictor = Predictor::new(assumed_tilt, sun);
    let cost = |h: f64| cost_at(samples, predictor.sun_body(h)).0;

    // Coarse grid over the full circle.
    let step = if cfg.coarse_step_deg > 0.0 {
        cfg.coarse_step_deg
    } else {
        1.0
    };
    let n_grid = ((360.0 / step).round() as usize).max(4);
    let grid_h: Vec<f64> = (0..n_grid).map(|i| 360.0 * i as f64 / n_grid as f64).collect();
    let costs: Vec<f64> = grid_h.iter().map(|h| cost(*h)).collect();
    let cost_curve: Vec<CostPoint> = grid_h
        .iter()
        .zip(&costs)
        .map(|(h, c)| CostPoint {
            heading_deg: *h,
            cost: *c,
        })
        .collect();

    let used = cost_at(samples, predictor.sun_body(grid_h[0])).1;

    // Every strict local minimum on the cyclic grid, refined.
    let mut local: Vec<usize> = (0..n_grid)
        .filter(|&i| {
            let prev = costs[(i + n_grid - 1) % n_grid];
            let next = costs[(i + 1) % n_grid];
            costs[i] < prev && costs[i] <= next
        })
        .collect();
    if local.is_empty() {
        // A perfectly flat curve: take the global argmin so something is said.
        let mut best = 0usize;
        for i in 1..n_grid {
            if costs[i] < costs[best] {
                best = i;
            }
        }
        local.push(best);
        notes.push(
            "the cost curve has no strict local minimum: it is flat to numerical precision"
                .to_string(),
        );
    }

    let refine = |centre: f64| -> HeadingCandidate {
        let (h, c) = golden_min(cost, centre - step, centre + step, cfg.refine_tol_deg);
        HeadingCandidate {
            heading_deg: wrap360_deg(h),
            cost: c,
            sigma_deg: sigma_from_curvature(cost, h, c, used, (step / 4.0).max(1e-3)),
        }
    };

    let mut candidates: Vec<HeadingCandidate> = local.iter().map(|&i| refine(grid_h[i])).collect();
    candidates.sort_by(|a, b| a.cost.total_cmp(&b.cost));
    let best = candidates[0];

    // The 180-degree alternative is always evaluated and always reported.
    let anti_target = wrap360_deg(best.heading_deg + 180.0);
    let anti = match candidates
        .iter()
        .skip(1)
        .find(|c| diff360_deg(c.heading_deg, anti_target).abs() <= 2.0)
    {
        // A genuine local minimum sits opposite: that is the alternative.
        Some(c) => *c,
        // Otherwise report the hypothesis at *exactly* best + 180 with the cost
        // it actually incurs. Refining it would be meaningless (it is not a
        // minimum) and would hide the very thing being reported: what it costs
        // to assume the instrument is pointing the other way.
        None => {
            let c = cost(anti_target);
            HeadingCandidate {
                heading_deg: anti_target,
                cost: c,
                sigma_deg: sigma_from_curvature(
                    cost,
                    anti_target,
                    c,
                    used,
                    (step / 4.0).max(1e-3),
                ),
            }
        }
    };

    // Keep the best and the alternative, then the next-best distinct minima.
    let mut kept = vec![best, anti];
    for c in &candidates {
        if kept.len() >= cfg.max_candidates.max(2) {
            break;
        }
        if kept
            .iter()
            .all(|k| diff360_deg(k.heading_deg, c.heading_deg).abs() > 0.5)
        {
            kept.push(*c);
        }
    }
    kept.sort_by(|a, b| a.cost.total_cmp(&b.cost));

    let residual_rms_deg = if used > 0 {
        (best.cost / used as f64).sqrt()
    } else {
        f64::NAN
    };
    let mean_best = best.cost / used.max(1) as f64;
    let mean_anti = anti.cost / used.max(1) as f64;
    // Delta chi-square against the best candidate's own residual variance,
    // one degree of freedom (heading). CONVENTIONS section 8 uses the same
    // machinery with 2 dof for a position fix.
    let s2 = (best.cost / (used.max(2) as f64 - 1.0))
        .max(cfg.ambiguity_floor_deg * cfg.ambiguity_floor_deg);
    let delta_chi2 = (anti.cost - best.cost) / s2;
    let separated = delta_chi2 > cfg.ambiguity_delta_chi2;

    notes.push(format!(
        "{used} of {} samples entered the cost; best residual RMS {:.4} deg, \
         alternative at {:.3} deg has residual RMS {:.4} deg, delta chi-square {:.3}.",
        samples.len(),
        residual_rms_deg,
        anti.heading_deg,
        mean_anti.sqrt(),
        delta_chi2
    ));
    if best.cost == 0.0 {
        notes.push(
            "the best candidate has exactly zero residual, so its nominal sigma is 0. That is a \
             statement about the synthetic data matching the model exactly, not an accuracy claim."
                .to_string(),
        );
    }

    let mut ambiguity = if separated {
        format!(
            "180-separated-by-field-asymmetry: the {:.3} deg alternative has residual RMS \
             {:.4} deg against {:.4} deg at {:.3} deg (delta chi-square {:.1}). The separation \
             comes from the ideal Rayleigh field's Sun-above-horizon asymmetry over a wide field \
             of view, not from any measurement that distinguishes the Sun from the anti-Sun. It \
             vanishes at BOTH ends: with the Sun on the horizon (where a 180 deg turn is exactly \
             the Sun/anti-Sun symmetry) and with the Sun at the zenith (where heading leaves the \
             pattern unchanged). It also vanishes for a zenith-only sensor at any Sun altitude. \
             Both candidates are returned.",
            anti.heading_deg,
            mean_anti.sqrt(),
            mean_best.sqrt(),
            best.heading_deg,
            delta_chi2
        )
    } else {
        format!(
            "unresolved-180: the {:.3} deg alternative fits as well as {:.3} deg \
             (residual RMS {:.4} deg against {:.4} deg, delta chi-square {:.3}). AoLP alone \
             cannot choose between them: the Rayleigh field is exactly invariant under \
             Sun <-> anti-Sun. Both candidates are returned; resolving them needs an \
             independent input.",
            anti.heading_deg,
            best.heading_deg,
            mean_anti.sqrt(),
            mean_best.sqrt(),
            delta_chi2
        )
    };

    // Optional, opt-in radiance disambiguator.
    if cfg.use_radiance_hint {
        let r_best = radiance_correlation(samples, predictor.sun_body(best.heading_deg));
        let r_anti = radiance_correlation(samples, predictor.sun_body(anti.heading_deg));
        notes.push(RADIANCE_HINT_CAVEAT.to_string());
        notes.push(format!(
            "radiance correlation {:.4} at {:.3} deg against {:.4} at {:.3} deg.",
            r_best, best.heading_deg, r_anti, anti.heading_deg
        ));
        if (r_best - r_anti).abs() < 1e-6 {
            notes.push(
                "the radiance hint is uninformative here: the two hypotheses correlate equally \
                 (a uniform-radiance scene carries no gradient to exploit)."
                    .to_string(),
            );
        } else {
            let winner = if r_best >= r_anti { best } else { anti };
            kept.sort_by(|a, b| {
                let ka = diff360_deg(a.heading_deg, winner.heading_deg).abs() > 0.5;
                let kb = diff360_deg(b.heading_deg, winner.heading_deg).abs() > 0.5;
                ka.cmp(&kb).then(a.cost.total_cmp(&b.cost))
            });
            ambiguity = format!(
                "180-preferred-by-radiance-hint: {:.3} deg is preferred over {:.3} deg by a \
                 radiance correlation of {:.4} against {:.4}. {RADIANCE_HINT_CAVEAT} Both \
                 candidates remain in the list.",
                winner.heading_deg,
                if winner.heading_deg == best.heading_deg {
                    anti.heading_deg
                } else {
                    best.heading_deg
                },
                r_best.max(r_anti),
                r_best.min(r_anti)
            );
        }
    }

    HeadingEstimate {
        candidates: kept,
        ambiguity,
        method,
        notes,
        cost_curve,
        samples_used: used,
        residual_rms_deg,
    }
}

// ---------------------------------------------------------------------------
// Tilt sensitivity
// ---------------------------------------------------------------------------

/// How far the solution moves when the *assumed* tilt moves, evaluated at the
/// solution by central differences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TiltSensitivity {
    pub heading_deg: f64,
    /// Degrees of heading per degree of assumed pitch.
    pub d_heading_d_pitch: f64,
    /// Degrees of heading per degree of assumed roll.
    pub d_heading_d_roll: f64,
    pub delta_deg: f64,
    pub note: String,
}

impl TiltSensitivity {
    /// First-order predicted heading error for a tilt the estimator got wrong
    /// by `(pitch_err, roll_err)` degrees.
    pub fn predicted_heading_error_deg(&self, pitch_err_deg: f64, roll_err_deg: f64) -> f64 {
        (self.d_heading_d_pitch * pitch_err_deg + self.d_heading_d_roll * roll_err_deg).abs()
    }
}

/// Numerical `d(heading)/d(tilt)` at the solution.
///
/// Re-runs the estimator with the assumed pitch and roll perturbed by
/// `delta_deg` and follows the candidate nearest the unperturbed solution, so
/// that a branch jump to the 180-degree alternative cannot masquerade as a huge
/// sensitivity. Returns `None` when the base estimate has no candidates.
pub fn tilt_sensitivity(
    samples: &[AolpSample],
    sun: Dir,
    assumed_tilt: Tilt,
    cfg: &HeadingConfig,
    delta_deg: f64,
) -> Option<TiltSensitivity> {
    let base = estimate(samples, sun, assumed_tilt, cfg).best()?.heading_deg;
    let at = |t: Tilt| -> Option<f64> {
        let e = estimate(samples, sun, t, cfg);
        e.candidates
            .iter()
            .map(|c| c.heading_deg)
            .min_by(|a, b| {
                diff360_deg(*a, base)
                    .abs()
                    .total_cmp(&diff360_deg(*b, base).abs())
            })
    };
    let pp = at(Tilt::new(
        assumed_tilt.pitch_deg + delta_deg,
        assumed_tilt.roll_deg,
    ))?;
    let pm = at(Tilt::new(
        assumed_tilt.pitch_deg - delta_deg,
        assumed_tilt.roll_deg,
    ))?;
    let rp = at(Tilt::new(
        assumed_tilt.pitch_deg,
        assumed_tilt.roll_deg + delta_deg,
    ))?;
    let rm = at(Tilt::new(
        assumed_tilt.pitch_deg,
        assumed_tilt.roll_deg - delta_deg,
    ))?;
    Some(TiltSensitivity {
        heading_deg: base,
        d_heading_d_pitch: diff360_deg(pp, pm) / (2.0 * delta_deg),
        d_heading_d_roll: diff360_deg(rp, rm) / (2.0 * delta_deg),
        delta_deg,
        note: "central difference of the estimator's own solution against its assumed tilt. \
               First order only: it predicts the error from a small unmodelled tilt, and it \
               under-predicts once the tilt error is large enough for the field to change shape."
            .to_string(),
    })
}

// ---------------------------------------------------------------------------
// The analytic zenith case
// ---------------------------------------------------------------------------

/// Closed-form heading from a single **zenith** AoLP measurement on a
/// **levelled** instrument, returning both candidates.
///
/// At the body zenith the E-vector is perpendicular to the solar meridian, so
/// the measured pixel-frame AoLP is `psi = 90 deg + (sun_azimuth - heading)`
/// modulo 180 degrees, and
///
/// ```text
/// heading = sun_azimuth + 90 deg - psi      (mod 180 deg)
/// ```
///
/// Two headings 180 degrees apart satisfy it. This is the exact ambiguity, and
/// no amount of photodiode quality removes it: the measurement determines a
/// line, and a line has two directions. Only valid at zero tilt; tilt breaks
/// the closed form and the search in [`estimate`] must be used instead.
pub fn heading_from_zenith_aolp(aolp_pixel_rad: f64, sun: Dir) -> [f64; 2] {
    let h = wrap360_deg(sun.az_deg() + 90.0 - aolp_pixel_rad.to_degrees());
    [h, wrap360_deg(h + 180.0)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{
        Camera, DEFAULT_ANALYZERS_DEG, Degradations, FisheyeIntrinsics, Scene, render,
    };
    use crate::sensor::{FewChannelSensor, SensorDegradations};
    use crate::stokes::{StokesThresholds, recover};
    use approx::assert_relative_eq;

    fn image_samples(heading: f64, sun: Dir, size: usize) -> (Vec<AolpSample>, FisheyeIntrinsics) {
        let intr = FisheyeIntrinsics::new(size, size, 180.0);
        let cam = Camera::new(intr, Extrinsics::level(heading));
        let r = render(
            &cam,
            &Scene::new(sun),
            DEFAULT_ANALYZERS_DEG,
            &Degradations::default(),
        );
        let f = recover(&r.images, &StokesThresholds::default());
        (
            samples_from_stokes(&intr, &f, &SampleOptions::default()),
            intr,
        )
    }

    #[test]
    fn predictor_matches_a_directly_built_camera() {
        let sun = Dir::from_deg(28.0, 143.0);
        for (h, p, r) in [(0.0, 0.0, 0.0), (77.0, 6.0, -4.0), (300.0, -3.0, 11.0)] {
            let cam = Camera::new(FisheyeIntrinsics::new(31, 31, 180.0), Extrinsics::new(h, p, r));
            let direct = cam.sun_in_body(sun);
            let pred = Predictor::new(Tilt::new(p, r), sun).sun_body(h);
            for i in 0..3 {
                assert_relative_eq!(direct[i], pred[i], epsilon = 1e-14);
            }
        }
    }

    #[test]
    fn clean_image_recovers_the_truth_and_reports_the_alternative() {
        let truth = 123.0;
        let sun = Dir::from_deg(30.0, 135.0);
        let (samples, _) = image_samples(truth, sun, 81);
        let est = estimate(&samples, sun, Tilt::default(), &HeadingConfig::default());
        let best = est.best().unwrap();
        assert!(
            diff360_deg(best.heading_deg, truth).abs() < 0.1,
            "best {} vs truth {truth}",
            best.heading_deg
        );
        assert!(est.has_anti_candidate(0.5), "{:?}", est.candidates);
        assert!(!est.ambiguity.is_empty());
        assert_eq!(est.cost_curve.len(), 360);
        assert!(est.samples_used > 3000);
    }

    #[test]
    fn a_zenith_only_sensor_is_exactly_ambiguous_by_180() {
        // The textbook case: the cost curve has period 180 and the two
        // candidates are numerically indistinguishable.
        let truth = 47.0;
        let sun = Dir::from_deg(35.0, 210.0);
        let sensor =
            FewChannelSensor::zenith_only(&DEFAULT_ANALYZERS_DEG, Extrinsics::level(truth));
        let readings = crate::sensor::read(
            &sensor,
            &Scene::new(sun),
            &SensorDegradations::default(),
        );
        let views = crate::sensor::recover_views(&sensor, &readings, &StokesThresholds::default());
        let samples = samples_from_views(&views);
        assert_eq!(samples.len(), 1);
        let est = estimate(&samples, sun, Tilt::default(), &HeadingConfig::default());
        assert!(est.ambiguity.starts_with("unresolved-180"), "{}", est.ambiguity);
        assert!(est.ambiguity_flagged());
        let b = est.best().unwrap();
        assert!(est.has_anti_candidate(0.5));
        // One of the two candidates is the truth.
        assert!(est.nearest_error_deg(truth).unwrap() < 0.05);
        // The cost curve is 180-periodic to floating-point precision.
        for i in 0..180 {
            assert_relative_eq!(
                est.cost_curve[i].cost,
                est.cost_curve[i + 180].cost,
                max_relative = 1e-11
            );
        }
        // The closed form agrees with the search.
        let analytic = heading_from_zenith_aolp(views[0].aolp_rad, sun);
        assert!(
            analytic
                .iter()
                .any(|a| diff360_deg(*a, b.heading_deg).abs() < 0.05),
            "analytic {analytic:?} vs search {}",
            b.heading_deg
        );
        assert!(analytic.iter().any(|a| diff360_deg(*a, truth).abs() < 1e-9));
    }

    /// Residual RMS of the 180-degree alternative, degrees.
    fn anti_residual_rms(truth: f64, sun: Dir, size: usize) -> f64 {
        let (samples, _) = image_samples(truth, sun, size);
        let est = estimate(&samples, sun, Tilt::default(), &HeadingConfig::default());
        let b = est.best().unwrap();
        let anti = est
            .candidates
            .iter()
            .find(|c| diff360_deg(c.heading_deg, b.heading_deg + 180.0).abs() < 2.0)
            .expect("the 180 deg alternative is always reported");
        (anti.cost / est.samples_used as f64).sqrt()
    }

    #[test]
    fn the_wide_field_180_separation_vanishes_at_both_ends() {
        // The finding this module exists to make precise. The wide-field image
        // *does* separate the 180-degree alternative, but only through the
        // ideal model's Sun-above-horizon asymmetry, and that asymmetry is zero
        // at both extremes: with the Sun on the horizon a 180-degree turn IS
        // the exact Sun/anti-Sun symmetry, and with the Sun at the zenith the
        // pattern does not depend on heading at all. In between it peaks near
        // 40 degrees of Sun altitude.
        let truth = 60.0;
        let mut curve = Vec::new();
        for alt in [1.0, 5.0, 20.0, 40.0, 60.0, 80.0, 84.0] {
            curve.push((alt, anti_residual_rms(truth, Dir::from_deg(alt, 200.0), 61)));
        }
        // Rising limb toward the interior maximum.
        for w in curve[..4].windows(2) {
            assert!(w[0].1 < w[1].1, "rising limb broken: {curve:?}");
        }
        // Falling limb toward the zenith.
        for w in curve[3..].windows(2) {
            assert!(w[0].1 > w[1].1, "falling limb broken: {curve:?}");
        }
        // Both ends are small: a couple of degrees of residual, which any real
        // noise would swamp.
        assert!(curve[0].1 < 3.0, "horizon end {curve:?}");
        assert!(curve.last().unwrap().1 < 15.0, "zenith end {curve:?}");
        // The interior maximum is large in this noiseless model.
        assert!(curve[3].1 > 50.0, "interior maximum {curve:?}");
    }

    #[test]
    fn a_narrow_field_loses_the_separation_the_wide_field_had() {
        // Same Sun, same truth: only the field of view changes. Narrowing
        // toward the zenith walks the sensor back toward the exact ambiguity.
        let truth = 60.0;
        let sun = Dir::from_deg(40.0, 200.0);
        let wide = anti_residual_rms(truth, sun, 61);
        let narrow = {
            let intr = FisheyeIntrinsics::new(61, 61, 20.0);
            let cam = Camera::new(intr, Extrinsics::level(truth));
            let r = render(
                &cam,
                &Scene::new(sun),
                DEFAULT_ANALYZERS_DEG,
                &Degradations::default(),
            );
            let f = recover(&r.images, &StokesThresholds::default());
            let s = samples_from_stokes(&intr, &f, &SampleOptions::default());
            let est = estimate(&s, sun, Tilt::default(), &HeadingConfig::default());
            let b = est.best().unwrap();
            let anti = est
                .candidates
                .iter()
                .find(|c| diff360_deg(c.heading_deg, b.heading_deg + 180.0).abs() < 2.0)
                .unwrap();
            (anti.cost / est.samples_used as f64).sqrt()
        };
        assert!(
            narrow < wide / 5.0,
            "narrow {narrow:.3} deg vs wide {wide:.3} deg"
        );
    }

    #[test]
    fn the_zenith_sun_case_returns_no_candidates() {
        let sun = Dir::from_deg(88.0, 135.0);
        let (samples, _) = image_samples(20.0, sun, 41);
        let est = estimate(&samples, sun, Tilt::default(), &HeadingConfig::default());
        assert!(est.candidates.is_empty());
        assert!(est.ambiguity.starts_with("unobservable"), "{}", est.ambiguity);
        assert!(est.ambiguity_flagged());
        assert!(est.best().is_none());
        assert!(est.nearest_error_deg(20.0).is_none());
        // Just outside the limit it works again.
        let sun = Dir::from_deg(84.0, 135.0);
        let (samples, _) = image_samples(20.0, sun, 41);
        let est = estimate(&samples, sun, Tilt::default(), &HeadingConfig::default());
        assert!(!est.candidates.is_empty());
    }

    #[test]
    fn empty_samples_are_reported_not_guessed() {
        let est = estimate(
            &[],
            Dir::from_deg(30.0, 100.0),
            Tilt::default(),
            &HeadingConfig::default(),
        );
        assert!(est.candidates.is_empty());
        assert!(est.ambiguity.starts_with("unobservable"));
    }

    #[test]
    fn golden_section_finds_a_known_minimum() {
        let (x, y) = golden_min(|x: f64| (x - 2.5) * (x - 2.5) + 1.0, 0.0, 5.0, 1e-9);
        assert_relative_eq!(x, 2.5, epsilon = 1e-6);
        assert_relative_eq!(y, 1.0, epsilon = 1e-9);
    }
}
