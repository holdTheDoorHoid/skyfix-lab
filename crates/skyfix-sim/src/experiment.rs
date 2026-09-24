//! Comparing the error a solver actually made with the uncertainty it predicted.
//!
//! One [`Experiment`] is a scenario, a set of solver options and a repetition count.
//! Each repetition re-simulates with a fresh seed, solves, and records two numbers that
//! ought to agree: how far the fix really is from the truth, and how far the reported
//! covariance said it might be. Over many repetitions the fraction of runs whose truth
//! falls inside the nominal 95 % ellipse should be about 0.95 — **if** the model the
//! ellipse assumes is the model the data obeys.
//!
//! That "if" is the point of the whole module. The brief calls for correlated-error
//! scenarios as explicit failures of the independent-noise model: `shared_bias` should
//! produce a coverage fraction near zero with residuals that look perfectly healthy, and
//! `clock_offset` should move the fix without widening the ellipse at all. A runner that
//! only ever reports 0.95 is not testing anything.
//!
//! Nothing here passes a truth value into `SolveOptions`. [`Experiment::check`] refuses
//! to run if the options have been pointed at the answer.

use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{self, Point};
use skyfix_core::reduce::{self, DirectionSource, SuppliedOnly};
use skyfix_core::solver;
use skyfix_core::types::{FixResult, GeocentricDirection, LatLon, SolveOptions, Truth};
use skyfix_core::units::{
    CHI2_95_2DOF, EARTH_RADIUS_M, NM_M, SIDEREAL_RATE_DEG_PER_HOUR, SOLAR_RATE_DEG_PER_HOUR,
    rad_to_m,
};
use skyfix_ephemeris::AstroProvider;

use crate::generate::{self, TruthSight};
use crate::scenario::Scenario;

/// Z for a 95 % two-sided normal interval, used for the coverage confidence interval.
const Z_95: f64 = 1.959_963_985;

/// A scenario run many times and scored against its own predicted uncertainty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Experiment {
    pub scenario: Scenario,
    #[serde(default)]
    pub solve_options: SolveOptions,
    /// Repetition `r` uses seed `scenario.seed + r`.
    pub repetitions: u32,
}

impl Experiment {
    pub fn new(scenario: Scenario, repetitions: u32) -> Self {
        Experiment {
            scenario,
            solve_options: SolveOptions::default(),
            repetitions,
        }
    }

    /// Refuse experiments whose solver options have been handed the answer.
    pub fn check(&self) -> Result<(), String> {
        self.scenario.check()?;
        if self.repetitions == 0 {
            return Err("repetitions must be at least 1".to_string());
        }
        let truth = self.scenario.truth;
        let same = |p: LatLon| {
            (p.lat_deg - truth.lat_deg).abs() < 1e-12 && (p.lon_deg - truth.lon_deg).abs() < 1e-12
        };
        if self.solve_options.initializer.is_some_and(same) {
            return Err(
                "solve_options.initializer is the truth position: an experiment that starts \
                 the solver at the answer measures nothing. Use the session's assumed \
                 position, or no initializer at all."
                    .to_string(),
            );
        }
        if self.solve_options.prior.is_some_and(|p| same(p.center)) {
            return Err(
                "solve_options.prior is centred on the truth position: the reported \
                 uncertainty would then be a statement about the prior, not about the sights."
                    .to_string(),
            );
        }
        Ok(())
    }
}

/// One repetition's outcome. Every metric is `None` when the solver did not return a
/// unique fix, and `result_kind` says why.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RunRecord {
    pub repetition: u32,
    pub seed: u64,
    /// `unique`, `ambiguous`, `underdetermined`, `failed`, or `simulation_error`.
    pub result_kind: String,
    pub converged: bool,
    pub sights_used: usize,
    /// Great-circle distance from the truth to the fix, metres.
    pub error_m: Option<f64>,
    /// Tangent-plane components of that error at the truth, metres.
    pub error_north_m: Option<f64>,
    pub error_east_m: Option<f64>,
    pub sigma_north_m: Option<f64>,
    pub sigma_east_m: Option<f64>,
    /// East-west 1-sigma the solver attributed to the clock (already inside sigma_east).
    pub clock_sigma_east_m: Option<f64>,
    pub ellipse_semi_major_m: Option<f64>,
    pub ellipse_semi_minor_m: Option<f64>,
    pub ellipse_orientation_deg: Option<f64>,
    /// `sqrt((x - truth)^T Cov^-1 (x - truth))`, dimensionless.
    pub mahalanobis: Option<f64>,
    /// `mahalanobis <= sqrt(5.991)`: the truth is inside the nominal 95 % ellipse.
    pub inside_ellipse95: Option<bool>,
    pub residual_rms_arcmin: Option<f64>,
    pub max_abs_residual_arcmin: Option<f64>,
    pub chi2: Option<f64>,
    pub dof: Option<i64>,
    pub shared_bias_arcmin: Option<f64>,
    pub note: String,
}

/// Everything the repetitions add up to.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Aggregate {
    pub repetitions: u32,
    /// Repetitions that produced a unique fix with a usable covariance.
    pub evaluated: u32,
    /// `(kind, count)` over every repetition, sorted by kind.
    pub result_kind_counts: Vec<(String, u32)>,
    /// Fraction of evaluated runs whose truth lay inside the nominal 95 % ellipse.
    pub coverage_fraction: Option<f64>,
    /// Binomial standard error `sqrt(p (1 - p) / n)`. It collapses to zero at p = 0 and
    /// p = 1, which is exactly where a naive reader most needs an interval, so the
    /// Wilson interval below is reported alongside it.
    pub coverage_stderr: Option<f64>,
    /// Wilson score 95 % interval for the coverage fraction.
    pub coverage_ci95: Option<(f64, f64)>,
    pub mean_error_m: Option<f64>,
    pub rms_error_m: Option<f64>,
    /// Mean signed components: a shared bias or a clock offset shows up here as a
    /// non-zero mean, where `mean_error_m` alone could not tell bias from scatter.
    pub mean_error_north_m: Option<f64>,
    pub mean_error_east_m: Option<f64>,
    /// Mean of `sqrt(sigma_north^2 + sigma_east^2)` over the evaluated runs.
    pub mean_predicted_sigma_m: Option<f64>,
    pub rms_predicted_sigma_m: Option<f64>,
    /// `rms_error_m / rms_predicted_sigma_m`. About 1 when the model is right; large
    /// when an unmodelled shared effect is moving the fix.
    pub error_to_sigma_ratio: Option<f64>,
    pub mean_residual_rms_arcmin: Option<f64>,
}

/// The serialisable result of [`run`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ExperimentSummary {
    pub name: String,
    /// The scenario's own plain-language description, carried through for the report.
    pub description: String,
    pub runs: Vec<RunRecord>,
    pub aggregate: Aggregate,
    /// Setup problems and anything that stopped a repetition. Never silently empty.
    pub notes: Vec<String>,
}

/// Run every repetition and score it. Never panics on a simulation failure: a
/// repetition that could not be generated is recorded as `simulation_error`.
///
/// Requires `skyfix_core::reduce` and `skyfix_core::solver`.
pub fn run(experiment: &Experiment, provider: Option<&dyn AstroProvider>) -> ExperimentSummary {
    let mut summary = ExperimentSummary {
        name: experiment.scenario.name.clone(),
        description: experiment.scenario.description.clone(),
        ..Default::default()
    };
    if let Err(e) = experiment.check() {
        summary.notes.push(format!("experiment refused: {e}"));
        summary.aggregate.repetitions = 0;
        return summary;
    }

    for rep in 0..experiment.repetitions {
        let mut scenario = experiment.scenario.clone();
        scenario.seed = experiment.scenario.seed.wrapping_add(rep as u64);
        let record = match generate::simulate_detailed(&scenario, provider) {
            Ok(sim) => score_one(rep, scenario.seed, &sim, experiment, provider),
            Err(e) => RunRecord {
                repetition: rep,
                seed: scenario.seed,
                result_kind: "simulation_error".to_string(),
                note: e,
                ..Default::default()
            },
        };
        if !record.note.is_empty() {
            summary
                .notes
                .push(format!("repetition {rep}: {}", record.note));
        }
        summary.runs.push(record);
    }
    summary.aggregate = aggregate(&summary.runs);
    summary
}

fn score_one(
    rep: u32,
    seed: u64,
    sim: &generate::Simulation,
    experiment: &Experiment,
    provider: Option<&dyn AstroProvider>,
) -> RunRecord {
    let mut record = RunRecord {
        repetition: rep,
        seed,
        ..Default::default()
    };

    let supplied = SuppliedOnly;
    let dynamic;
    let source: &dyn DirectionSource = match provider {
        Some(p) => {
            dynamic = DynProviderSource(p);
            &dynamic
        }
        None => &supplied,
    };

    let mut reduced = Vec::new();
    let mut rejected = Vec::new();
    for r in reduce::reduce_session(&sim.session, source) {
        match r {
            Ok(rs) => reduced.push(rs),
            Err(e) => rejected.push(e.to_string()),
        }
    }
    if !rejected.is_empty() {
        record.note = format!(
            "{} sight(s) rejected: {}",
            rejected.len(),
            rejected.join("; ")
        );
    }
    let sights = reduce::to_sights(&reduced, source);
    record.sights_used = sights.len();

    let result = solver::solve(&sights, &experiment.solve_options);
    match result {
        FixResult::Unique { fix, .. } => {
            record.result_kind = "unique".to_string();
            record.converged = fix.converged;
            let truth = Point::from_deg(sim.truth.position.lat_deg, sim.truth.position.lon_deg);
            let got = Point::from_deg(fix.position.lat_deg, fix.position.lon_deg);
            let (dn, de) = geometry::tangent_offset(truth, got);
            let (dn_m, de_m) = (rad_to_m(dn), rad_to_m(de));
            record.error_north_m = Some(dn_m);
            record.error_east_m = Some(de_m);
            record.error_m = Some(rad_to_m(geometry::angular_distance(truth, got)));
            record.sigma_north_m = Some(fix.sigma_north_m);
            record.sigma_east_m = Some(fix.sigma_east_m);
            record.clock_sigma_east_m = Some(fix.clock_sigma_east_m);
            if let Some(e) = &fix.ellipse95 {
                record.ellipse_semi_major_m = Some(e.semi_major_m);
                record.ellipse_semi_minor_m = Some(e.semi_minor_m);
                record.ellipse_orientation_deg = Some(e.orientation_deg);
            } else if let Some(r) = &fix.ellipse_suppressed_reason {
                record.note = join_note(&record.note, &format!("no ellipse: {r}"));
            }
            if let Some(d) = mahalanobis(fix.covariance_ne_m2, dn_m, de_m) {
                record.mahalanobis = Some(d);
                record.inside_ellipse95 = Some(d <= CHI2_95_2DOF.sqrt());
            } else {
                record.note = join_note(
                    &record.note,
                    "covariance is singular: no Mahalanobis distance",
                );
            }
            if !fix.residuals.is_empty() {
                let n = fix.residuals.len() as f64;
                let sum2: f64 = fix
                    .residuals
                    .iter()
                    .map(|r| r.residual_arcmin.powi(2))
                    .sum();
                record.residual_rms_arcmin = Some((sum2 / n).sqrt());
                record.max_abs_residual_arcmin = Some(
                    fix.residuals
                        .iter()
                        .map(|r| r.residual_arcmin.abs())
                        .fold(0.0, f64::max),
                );
            }
            record.chi2 = Some(fix.chi2);
            record.dof = Some(fix.dof);
            record.shared_bias_arcmin = fix.shared_bias_arcmin;
        }
        FixResult::Ambiguous { candidates, .. } => {
            record.result_kind = "ambiguous".to_string();
            record.note = join_note(
                &record.note,
                &format!("{} candidate positions, none promoted", candidates.len()),
            );
        }
        FixResult::Underdetermined { reason, .. } => {
            record.result_kind = "underdetermined".to_string();
            record.note = join_note(&record.note, &reason);
        }
        FixResult::Failed { reason, .. } => {
            record.result_kind = "failed".to_string();
            record.note = join_note(&record.note, &reason);
        }
    }
    record
}

fn join_note(a: &str, b: &str) -> String {
    if a.is_empty() {
        b.to_string()
    } else {
        format!("{a}; {b}")
    }
}

/// Aggregate statistics over the repetitions. Public so a caller that assembled runs
/// some other way (a resumed batch, say) can score them the same way.
pub fn aggregate(runs: &[RunRecord]) -> Aggregate {
    let mut agg = Aggregate {
        repetitions: runs.len() as u32,
        ..Default::default()
    };

    let mut kinds: Vec<(String, u32)> = Vec::new();
    for r in runs {
        match kinds.iter_mut().find(|(k, _)| *k == r.result_kind) {
            Some((_, c)) => *c += 1,
            None => kinds.push((r.result_kind.clone(), 1)),
        }
    }
    kinds.sort_by(|a, b| a.0.cmp(&b.0));
    agg.result_kind_counts = kinds;

    let scored: Vec<&RunRecord> = runs
        .iter()
        .filter(|r| r.error_m.is_some() && r.sigma_north_m.is_some())
        .collect();
    agg.evaluated = scored.len() as u32;
    if scored.is_empty() {
        return agg;
    }
    let n = scored.len() as f64;

    let mean = |f: &dyn Fn(&RunRecord) -> f64| scored.iter().map(|r| f(r)).sum::<f64>() / n;
    let rms = |f: &dyn Fn(&RunRecord) -> f64| {
        (scored.iter().map(|r| f(r).powi(2)).sum::<f64>() / n).sqrt()
    };

    agg.mean_error_m = Some(mean(&|r| r.error_m.unwrap()));
    agg.rms_error_m = Some(rms(&|r| r.error_m.unwrap()));
    agg.mean_error_north_m = Some(mean(&|r| r.error_north_m.unwrap_or(0.0)));
    agg.mean_error_east_m = Some(mean(&|r| r.error_east_m.unwrap_or(0.0)));
    let predicted = |r: &RunRecord| {
        r.sigma_north_m
            .unwrap_or(0.0)
            .hypot(r.sigma_east_m.unwrap_or(0.0))
    };
    agg.mean_predicted_sigma_m = Some(mean(&predicted));
    let rms_sigma = rms(&predicted);
    agg.rms_predicted_sigma_m = Some(rms_sigma);
    if rms_sigma > 0.0 {
        agg.error_to_sigma_ratio = Some(agg.rms_error_m.unwrap() / rms_sigma);
    }

    let with_residuals: Vec<f64> = scored
        .iter()
        .filter_map(|r| r.residual_rms_arcmin)
        .collect();
    if !with_residuals.is_empty() {
        agg.mean_residual_rms_arcmin =
            Some(with_residuals.iter().sum::<f64>() / with_residuals.len() as f64);
    }

    let covered: Vec<bool> = scored.iter().filter_map(|r| r.inside_ellipse95).collect();
    if !covered.is_empty() {
        let k = covered.iter().filter(|c| **c).count() as f64;
        let m = covered.len() as f64;
        let p = k / m;
        agg.coverage_fraction = Some(p);
        agg.coverage_stderr = Some((p * (1.0 - p) / m).sqrt());
        agg.coverage_ci95 = Some(wilson_interval(k, m));
    }
    agg
}

/// Wilson score 95 % interval for `k` successes in `m` trials. Unlike the plain binomial
/// standard error it stays informative at 0 and 1: 0/20 gives roughly (0, 0.16).
pub fn wilson_interval(k: f64, m: f64) -> (f64, f64) {
    if m <= 0.0 {
        return (0.0, 1.0);
    }
    let p = k / m;
    let z2 = Z_95 * Z_95;
    let denom = 1.0 + z2 / m;
    let centre = (p + z2 / (2.0 * m)) / denom;
    let half = Z_95 * (p * (1.0 - p) / m + z2 / (4.0 * m * m)).sqrt() / denom;
    ((centre - half).max(0.0), (centre + half).min(1.0))
}

/// Mahalanobis distance of a tangent-plane offset under a 2x2 covariance (metres^2).
/// `None` when the covariance is not invertible or not positive definite.
pub fn mahalanobis(cov_ne_m2: [[f64; 2]; 2], dn_m: f64, de_m: f64) -> Option<f64> {
    let [[a, b], [c, d]] = cov_ne_m2;
    if ![a, b, c, d, dn_m, de_m].iter().all(|x| x.is_finite()) {
        return None;
    }
    let det = a * d - b * c;
    if det <= 0.0 || a <= 0.0 || d <= 0.0 {
        return None;
    }
    // inverse = [[d, -b], [-c, a]] / det
    let q = (d * dn_m * dn_m - (b + c) * dn_m * de_m + a * de_m * de_m) / det;
    if q < 0.0 { None } else { Some(q.sqrt()) }
}

// ---------------------------------------------------------------------------
// Closed-form predictions: what the solver *should* do
// ---------------------------------------------------------------------------

/// The position shift a shared altitude bias produces in a weighted least-squares fix.
///
/// With the tangent-plane model of CONVENTIONS section 3 the Jacobian row for a sight is
/// `(cos Zn, sin Zn)` and a shared bias `b` adds `b` to every measurement, so the fitted
/// shift solves `(A^T W A) x = b A^T W 1`. Angles in arcminutes come out as nautical
/// miles; this returns metres, north and east.
///
/// It is a *prediction*, not a solve: it never touches `skyfix_core::solver`, so the
/// solver can be checked against it. It is exact for a linear model, and the model is
/// linear to well under a metre over the shifts these demos produce.
///
/// `None` when the geometry is singular (all sights on one azimuth line).
pub fn bias_shift_ne_m(
    azimuths_deg: &[f64],
    sigmas_arcmin: &[f64],
    bias_arcmin: f64,
) -> Option<(f64, f64)> {
    if azimuths_deg.is_empty() || azimuths_deg.len() != sigmas_arcmin.len() {
        return None;
    }
    let (mut m00, mut m01, mut m11) = (0.0, 0.0, 0.0);
    let (mut v0, mut v1) = (0.0, 0.0);
    let mut scale = 0.0f64;
    for (z, s) in azimuths_deg.iter().zip(sigmas_arcmin) {
        if !(s.is_finite() && *s > 0.0) || !z.is_finite() {
            return None;
        }
        let w = 1.0 / (s * s);
        let (sn, cs) = z.to_radians().sin_cos();
        m00 += w * cs * cs;
        m01 += w * cs * sn;
        m11 += w * sn * sn;
        v0 += w * cs * bias_arcmin;
        v1 += w * sn * bias_arcmin;
        scale += w;
    }
    let det = m00 * m11 - m01 * m01;
    // Scale-free singularity test: the determinant of a rank-1 geometry is zero.
    if scale <= 0.0 || det <= 1e-12 * scale * scale {
        return None;
    }
    let dn_arcmin = (m11 * v0 - m01 * v1) / det;
    let de_arcmin = (m00 * v1 - m01 * v0) / det;
    // One arcminute of arc is one nautical mile (CONVENTIONS section 1).
    Some((dn_arcmin * NM_M, de_arcmin * NM_M))
}

/// The same prediction for a whole scenario, using the true azimuths of the sights it
/// will emit. Evaluation only: it reads the truth.
pub fn predicted_bias_shift_m(
    scenario: &Scenario,
    provider: Option<&dyn AstroProvider>,
) -> Result<(f64, f64), String> {
    let sim = generate::simulate_detailed(scenario, provider)?;
    let azimuths: Vec<f64> = sim.sights.iter().map(|s| s.true_azimuth_deg).collect();
    let sigmas: Vec<f64> = sim
        .session
        .observations
        .iter()
        .map(|o| o.sigma_arcmin)
        .collect();
    bias_shift_ne_m(&azimuths, &sigmas, scenario.shared_altitude_bias_arcmin).ok_or_else(|| {
        format!(
            "scenario {:?}: the sight geometry is singular; a bias shift is not defined",
            scenario.name
        )
    })
}

/// Longitude shift a clock offset produces in a star fix, degrees. Negative is west.
///
/// A clock that reads `dt` seconds late makes the almanac give a GHA that is
/// `omega * dt` too large, and only `LHA = GHA + lon_east` enters the altitude, so the
/// fitted longitude must fall by the same amount. Latitude is untouched. For a star-only
/// session this is exact, not an approximation: the clock offset and longitude are the
/// same unknown (CONVENTIONS section 6, and the brief's non-negotiable distinction 3).
pub fn clock_longitude_shift_deg(gha_rate_deg_per_hour: f64, clock_offset_s: f64) -> f64 {
    -gha_rate_deg_per_hour * clock_offset_s / 3600.0
}

/// That longitude shift expressed as an east-west distance at a given latitude, metres.
pub fn clock_shift_east_m(lat_deg: f64, gha_rate_deg_per_hour: f64, clock_offset_s: f64) -> f64 {
    clock_longitude_shift_deg(gha_rate_deg_per_hour, clock_offset_s).to_radians()
        * lat_deg.to_radians().cos()
        * EARTH_RADIUS_M
}

/// Where a clock offset puts the fix, for a star-only session with supplied directions.
/// Latitude is unchanged; longitude moves by [`clock_longitude_shift_deg`].
pub fn clock_shifted_position(
    truth: LatLon,
    gha_rate_deg_per_hour: f64,
    clock_offset_s: f64,
) -> LatLon {
    LatLon {
        lat_deg: truth.lat_deg,
        lon_deg: skyfix_core::units::norm_180(
            truth.lon_deg + clock_longitude_shift_deg(gha_rate_deg_per_hour, clock_offset_s),
        ),
    }
}

/// The total altitude error of each emitted sight, for the evaluation view.
pub fn sight_errors_arcmin(sights: &[TruthSight]) -> Vec<f64> {
    sights.iter().map(|s| s.total_error_arcmin()).collect()
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_HEADER: &str = "repetition,seed,result_kind,converged,sights_used,error_m,\
error_north_m,error_east_m,sigma_north_m,sigma_east_m,clock_sigma_east_m,\
ellipse_semi_major_m,ellipse_semi_minor_m,ellipse_orientation_deg,mahalanobis,\
inside_ellipse95,residual_rms_arcmin,max_abs_residual_arcmin,chi2,dof,\
shared_bias_arcmin,note";

/// One row per repetition, with the aggregate in a `#`-prefixed header block so the
/// file is still a valid CSV for a spreadsheet that skips comment lines.
pub fn to_csv(summary: &ExperimentSummary) -> String {
    let a = &summary.aggregate;
    let mut s = String::new();
    s.push_str(&format!("# experiment: {}\n", summary.name));
    if !summary.description.is_empty() {
        s.push_str(&format!("# description: {}\n", summary.description));
    }
    s.push_str(&format!(
        "# repetitions: {}, evaluated: {}\n",
        a.repetitions, a.evaluated
    ));
    s.push_str(&format!(
        "# coverage_fraction: {}, coverage_stderr: {}, coverage_ci95: {}\n",
        opt(a.coverage_fraction),
        opt(a.coverage_stderr),
        a.coverage_ci95
            .map(|(lo, hi)| format!("{lo:.6}..{hi:.6}"))
            .unwrap_or_else(|| "n/a".to_string())
    ));
    s.push_str(&format!(
        "# mean_error_m: {}, rms_error_m: {}, mean_error_north_m: {}, mean_error_east_m: {}\n",
        opt(a.mean_error_m),
        opt(a.rms_error_m),
        opt(a.mean_error_north_m),
        opt(a.mean_error_east_m)
    ));
    s.push_str(&format!(
        "# mean_predicted_sigma_m: {}, rms_predicted_sigma_m: {}, error_to_sigma_ratio: {}\n",
        opt(a.mean_predicted_sigma_m),
        opt(a.rms_predicted_sigma_m),
        opt(a.error_to_sigma_ratio)
    ));
    for (k, c) in &a.result_kind_counts {
        s.push_str(&format!("# result_kind {k}: {c}\n"));
    }
    for n in &summary.notes {
        s.push_str(&format!("# note: {}\n", n.replace('\n', " ")));
    }
    s.push_str(CSV_HEADER);
    s.push('\n');
    for r in &summary.runs {
        let fields = [
            r.repetition.to_string(),
            r.seed.to_string(),
            r.result_kind.clone(),
            r.converged.to_string(),
            r.sights_used.to_string(),
            opt(r.error_m),
            opt(r.error_north_m),
            opt(r.error_east_m),
            opt(r.sigma_north_m),
            opt(r.sigma_east_m),
            opt(r.clock_sigma_east_m),
            opt(r.ellipse_semi_major_m),
            opt(r.ellipse_semi_minor_m),
            opt(r.ellipse_orientation_deg),
            opt(r.mahalanobis),
            r.inside_ellipse95
                .map(|b| b.to_string())
                .unwrap_or_default(),
            opt(r.residual_rms_arcmin),
            opt(r.max_abs_residual_arcmin),
            opt(r.chi2),
            r.dof.map(|d| d.to_string()).unwrap_or_default(),
            opt(r.shared_bias_arcmin),
            r.note.clone(),
        ];
        s.push_str(
            &fields
                .iter()
                .map(|f| csv_field(f))
                .collect::<Vec<_>>()
                .join(","),
        );
        s.push('\n');
    }
    s
}

fn opt(v: Option<f64>) -> String {
    match v {
        Some(x) if x.is_finite() => format!("{x:.6}"),
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

/// Pretty JSON for a summary, the other half of the brief's "CSV/JSON experiment
/// summaries".
pub fn to_json(summary: &ExperimentSummary) -> Result<String, String> {
    serde_json::to_string_pretty(summary).map_err(|e| e.to_string())
}

/// Pretty JSON for a truth document, so `fixtures/expected/<name>.truth.json` can be
/// written by the CLI without the simulator knowing about files.
pub fn truth_to_json(truth: &Truth) -> Result<String, String> {
    serde_json::to_string_pretty(truth).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

/// `skyfix_ephemeris::ProviderSource` is generic and takes its provider by value; the
/// experiment runner only has a `&dyn AstroProvider`, so it carries its own adapter.
struct DynProviderSource<'a>(&'a dyn AstroProvider);

impl DirectionSource for DynProviderSource<'_> {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn direction(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, String> {
        self.0.geocentric(body, jd_utc).map_err(|e| e.to_string())
    }
    fn gha_rate_deg_per_hour(&self, body: &str) -> f64 {
        if body.eq_ignore_ascii_case("sun") {
            SOLAR_RATE_DEG_PER_HOUR
        } else {
            SIDEREAL_RATE_DEG_PER_HOUR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::demos;
    use crate::scenario::{BodySource, Ordering, Schedule, body_at};
    use skyfix_core::types::{PositionPrior, TRUTH_SCHEMA};

    const PHL: LatLon = LatLon {
        lat_deg: 39.9526,
        lon_deg: -75.1652,
    };

    // ---- things that need no solver ------------------------------------------

    #[test]
    fn bias_shift_is_zero_for_a_symmetric_triangle() {
        // Three azimuths 120 degrees apart: the bias cancels exactly and shows up as
        // three equal residuals instead. This is the case people wrongly generalise from.
        let az = [0.0, 120.0, 240.0];
        let sig = [1.0, 1.0, 1.0];
        let (dn, de) = bias_shift_ne_m(&az, &sig, 3.0).unwrap();
        assert!(dn.abs() < 1e-9 && de.abs() < 1e-9, "({dn}, {de})");
    }

    #[test]
    fn bias_shift_matches_the_hand_calculation_for_a_lopsided_triangle() {
        // Azimuths all on the eastern side: the bias is largely absorbed into position.
        let az = [45.0, 95.0, 145.0];
        let sig = [1.0, 1.0, 1.0];
        let (dn, de) = bias_shift_ne_m(&az, &sig, 3.0).unwrap();
        // Hand calculation with M = sum (cos, sin)(cos, sin)^T and v = sum (cos, sin):
        // M^-1 v = (-0.1090704, 1.2466809) nautical miles per arcminute of bias.
        assert!((dn / NM_M / 3.0 + 0.109_070_445).abs() < 1e-8, "dn {dn}");
        assert!((de / NM_M / 3.0 - 1.246_680_890).abs() < 1e-8, "de {de}");
        // In metres: 606 m south and 6 927 m east for a 3 arcminute bias.
        assert!((dn + 605.995).abs() < 0.01 && (de - 6_926.559).abs() < 0.01);
        // Scaling in the bias is exactly linear.
        let (dn2, de2) = bias_shift_ne_m(&az, &sig, 6.0).unwrap();
        assert!((dn2 - 2.0 * dn).abs() < 1e-9 && (de2 - 2.0 * de).abs() < 1e-9);
        // A zero bias moves nothing.
        assert_eq!(bias_shift_ne_m(&az, &sig, 0.0).unwrap(), (0.0, 0.0));
    }

    #[test]
    fn bias_shift_for_two_sights_reproduces_them_exactly() {
        // With two sights and two unknowns the fit is exact: every residual is zero and
        // the whole bias goes into position. Two perpendicular sights, bias b, move the
        // fix by b along each azimuth: |shift| = b * sqrt(2) nautical miles.
        let (dn, de) = bias_shift_ne_m(&[0.0, 90.0], &[1.0, 1.0], 2.0).unwrap();
        assert!((dn - 2.0 * NM_M).abs() < 1e-6, "dn {dn}");
        assert!((de - 2.0 * NM_M).abs() < 1e-6, "de {de}");
    }

    #[test]
    fn bias_shift_weights_by_sigma() {
        let az = [0.0, 90.0];
        // Tighten the northern sight: the fit leans on it, but with two sights and two
        // unknowns the solution is exact either way, so the weights cannot change it.
        let a = bias_shift_ne_m(&az, &[1.0, 1.0], 1.0).unwrap();
        let b = bias_shift_ne_m(&az, &[0.1, 1.0], 1.0).unwrap();
        assert!((a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6);
        // Three sights: now the weights matter.
        let az3 = [0.0, 90.0, 45.0];
        let even = bias_shift_ne_m(&az3, &[1.0, 1.0, 1.0], 1.0).unwrap();
        let uneven = bias_shift_ne_m(&az3, &[1.0, 1.0, 0.1], 1.0).unwrap();
        assert!((even.0 - uneven.0).abs() > 1.0, "{even:?} vs {uneven:?}");
    }

    #[test]
    fn bias_shift_refuses_singular_and_malformed_geometry() {
        // All sights on one line of position: rank 1.
        assert!(bias_shift_ne_m(&[30.0, 30.0, 210.0], &[1.0; 3], 3.0).is_none());
        assert!(bias_shift_ne_m(&[], &[], 3.0).is_none());
        assert!(bias_shift_ne_m(&[0.0, 90.0], &[1.0], 3.0).is_none());
        assert!(bias_shift_ne_m(&[0.0, 90.0], &[1.0, 0.0], 3.0).is_none());
        assert!(bias_shift_ne_m(&[0.0, f64::NAN], &[1.0, 1.0], 3.0).is_none());
    }

    #[test]
    fn clock_offset_moves_longitude_west_and_leaves_latitude_alone() {
        let shift = clock_longitude_shift_deg(SIDEREAL_RATE_DEG_PER_HOUR, 60.0);
        assert!((shift + 0.250_684_477_333).abs() < 1e-9, "shift {shift}");
        assert!(shift < 0.0, "a fast clock must move the fix WEST");
        // A slow clock moves it east by the same amount.
        assert!(
            (clock_longitude_shift_deg(SIDEREAL_RATE_DEG_PER_HOUR, -60.0) + shift).abs() < 1e-15
        );
        // The Sun's rate is slightly slower.
        assert!(
            clock_longitude_shift_deg(SOLAR_RATE_DEG_PER_HOUR, 60.0).abs()
                < clock_longitude_shift_deg(SIDEREAL_RATE_DEG_PER_HOUR, 60.0).abs()
        );
        // Distance at Philadelphia's latitude.
        let east_m = clock_shift_east_m(PHL.lat_deg, SIDEREAL_RATE_DEG_PER_HOUR, 60.0);
        assert!((east_m + 21_353.785).abs() < 0.01, "east {east_m} m");
        let moved = clock_shifted_position(PHL, SIDEREAL_RATE_DEG_PER_HOUR, 60.0);
        assert_eq!(moved.lat_deg, PHL.lat_deg);
        assert!((moved.lon_deg - (PHL.lon_deg + shift)).abs() < 1e-12);
    }

    #[test]
    fn mahalanobis_matches_the_chi_square_threshold() {
        // A circular covariance of sigma^2 = 100 m^2: the 95 % radius is
        // sqrt(5.991) * 10 m = 24.478 m.
        let cov = [[100.0, 0.0], [0.0, 100.0]];
        let edge = CHI2_95_2DOF.sqrt() * 10.0;
        assert!((mahalanobis(cov, edge, 0.0).unwrap() - CHI2_95_2DOF.sqrt()).abs() < 1e-12);
        assert!(mahalanobis(cov, edge * 0.999, 0.0).unwrap() < CHI2_95_2DOF.sqrt());
        assert!(mahalanobis(cov, edge * 1.001, 0.0).unwrap() > CHI2_95_2DOF.sqrt());
        assert!((mahalanobis(cov, 0.0, 0.0).unwrap()).abs() < 1e-15);
        // An elongated covariance: 3 sigma north is inside, 3 sigma east is not.
        let cov = [[900.0, 0.0], [0.0, 4.0]];
        assert!((mahalanobis(cov, 30.0, 0.0).unwrap() - 1.0).abs() < 1e-12);
        assert!((mahalanobis(cov, 0.0, 6.0).unwrap() - 3.0).abs() < 1e-12);
        // Correlation is honoured.
        let cov = [[100.0, 90.0], [90.0, 100.0]];
        let along = mahalanobis(cov, 10.0, 10.0).unwrap();
        let across = mahalanobis(cov, 10.0, -10.0).unwrap();
        assert!(across > along * 4.0, "along {along} across {across}");
        // Degenerate matrices are refused, not fudged.
        assert!(mahalanobis([[0.0, 0.0], [0.0, 0.0]], 1.0, 1.0).is_none());
        assert!(mahalanobis([[1.0, 2.0], [2.0, 1.0]], 1.0, 1.0).is_none());
        assert!(mahalanobis([[f64::NAN, 0.0], [0.0, 1.0]], 1.0, 1.0).is_none());
    }

    #[test]
    fn wilson_interval_stays_informative_at_the_edges() {
        let (lo, hi) = wilson_interval(0.0, 20.0);
        assert_eq!(lo, 0.0);
        assert!(hi > 0.1 && hi < 0.2, "0/20 upper bound {hi}");
        let (lo, hi) = wilson_interval(20.0, 20.0);
        assert!(lo > 0.8 && lo < 0.9, "20/20 lower bound {lo}");
        assert_eq!(hi, 1.0);
        let (lo, hi) = wilson_interval(95.0, 100.0);
        assert!(lo < 0.95 && hi > 0.95);
        assert!(hi - lo < 0.12);
        assert_eq!(wilson_interval(0.0, 0.0), (0.0, 1.0));
    }

    fn fake_runs() -> Vec<RunRecord> {
        (0..4)
            .map(|i| RunRecord {
                repetition: i,
                seed: 100 + i as u64,
                result_kind: "unique".to_string(),
                converged: true,
                sights_used: 5,
                error_m: Some(100.0 + 10.0 * i as f64),
                error_north_m: Some(60.0),
                error_east_m: Some(80.0),
                sigma_north_m: Some(90.0),
                sigma_east_m: Some(120.0),
                clock_sigma_east_m: Some(0.0),
                ellipse_semi_major_m: Some(250.0),
                ellipse_semi_minor_m: Some(180.0),
                ellipse_orientation_deg: Some(35.0),
                mahalanobis: Some(if i == 3 { 3.0 } else { 1.0 }),
                inside_ellipse95: Some(i != 3),
                residual_rms_arcmin: Some(0.5),
                max_abs_residual_arcmin: Some(0.9),
                chi2: Some(2.5),
                dof: Some(3),
                shared_bias_arcmin: None,
                note: if i == 2 {
                    "a note, with a comma".to_string()
                } else {
                    String::new()
                },
            })
            .collect()
    }

    #[test]
    fn aggregate_computes_coverage_and_the_error_to_sigma_ratio() {
        let a = aggregate(&fake_runs());
        assert_eq!(a.repetitions, 4);
        assert_eq!(a.evaluated, 4);
        assert_eq!(a.result_kind_counts, vec![("unique".to_string(), 4)]);
        assert_eq!(a.coverage_fraction, Some(0.75));
        // sqrt(0.75 * 0.25 / 4) = 0.2165.
        assert!((a.coverage_stderr.unwrap() - 0.216_506_35).abs() < 1e-8);
        assert!((a.mean_error_m.unwrap() - 115.0).abs() < 1e-9);
        // RMS of 100, 110, 120, 130.
        let want =
            ((100f64.powi(2) + 110f64.powi(2) + 120f64.powi(2) + 130f64.powi(2)) / 4.0).sqrt();
        assert!((a.rms_error_m.unwrap() - want).abs() < 1e-9);
        // Predicted radial sigma is hypot(90, 120) = 150.
        assert!((a.mean_predicted_sigma_m.unwrap() - 150.0).abs() < 1e-9);
        assert!((a.rms_predicted_sigma_m.unwrap() - 150.0).abs() < 1e-9);
        assert!((a.error_to_sigma_ratio.unwrap() - want / 150.0).abs() < 1e-9);
        assert_eq!(a.mean_error_north_m, Some(60.0));
        assert_eq!(a.mean_error_east_m, Some(80.0));
        assert!((a.mean_residual_rms_arcmin.unwrap() - 0.5).abs() < 1e-12);
    }

    #[test]
    fn aggregate_survives_runs_with_no_fix() {
        let mut runs = fake_runs();
        runs.push(RunRecord {
            repetition: 4,
            result_kind: "ambiguous".to_string(),
            ..Default::default()
        });
        runs.push(RunRecord {
            repetition: 5,
            result_kind: "failed".to_string(),
            ..Default::default()
        });
        let a = aggregate(&runs);
        assert_eq!(a.repetitions, 6);
        assert_eq!(a.evaluated, 4);
        assert_eq!(
            a.result_kind_counts,
            vec![
                ("ambiguous".to_string(), 1),
                ("failed".to_string(), 1),
                ("unique".to_string(), 4),
            ]
        );
        // Nothing at all to score.
        let a = aggregate(&[RunRecord {
            result_kind: "failed".to_string(),
            ..Default::default()
        }]);
        assert_eq!(a.evaluated, 0);
        assert!(a.coverage_fraction.is_none());
        assert!(a.error_to_sigma_ratio.is_none());
        assert_eq!(aggregate(&[]).repetitions, 0);
    }

    #[test]
    fn csv_has_one_row_per_repetition_and_quotes_commas() {
        let summary = ExperimentSummary {
            name: "demo".to_string(),
            description: "what it shows".to_string(),
            runs: fake_runs(),
            aggregate: aggregate(&fake_runs()),
            notes: vec!["a setup note".to_string()],
        };
        let csv = to_csv(&summary);
        let lines: Vec<&str> = csv.lines().collect();
        let header_rows = lines.iter().filter(|l| l.starts_with('#')).count();
        assert!(
            header_rows >= 5,
            "expected a comment block, got {header_rows}"
        );
        let data: Vec<&&str> = lines
            .iter()
            .filter(|l| !l.starts_with('#') && !l.starts_with("repetition,"))
            .collect();
        assert_eq!(data.len(), 4, "one row per repetition");
        assert!(lines.iter().any(|l| **l == *CSV_HEADER));
        assert_eq!(CSV_HEADER.split(',').count(), 22);
        for row in &data {
            // Quoted commas must not add fields.
            let mut fields = 1;
            let mut in_quotes = false;
            for c in row.chars() {
                match c {
                    '"' => in_quotes = !in_quotes,
                    ',' if !in_quotes => fields += 1,
                    _ => {}
                }
            }
            assert_eq!(fields, 22, "row {row}");
        }
        assert!(csv.contains("\"a note, with a comma\""));
        assert!(csv.contains("# coverage_fraction: 0.750000"));
        assert!(csv.contains("# description: what it shows"));
        // Missing values are empty, not NaN or 0.
        let bare = ExperimentSummary {
            name: "x".to_string(),
            runs: vec![RunRecord {
                result_kind: "failed".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let csv = to_csv(&bare);
        assert!(csv.contains("0,0,failed,false,0,,,,"), "{csv}");
        assert!(!csv.contains("NaN"));
    }

    #[test]
    fn summary_round_trips_through_json() {
        let summary = ExperimentSummary {
            name: "demo".to_string(),
            description: String::new(),
            runs: fake_runs(),
            aggregate: aggregate(&fake_runs()),
            notes: vec![],
        };
        let json = to_json(&summary).unwrap();
        let back: ExperimentSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(summary, back);
    }

    #[test]
    fn truth_serialises_for_the_expected_fixture() {
        let (_, truth) = generate::simulate(&demos::philadelphia_stars(), None).unwrap();
        let json = truth_to_json(&truth).unwrap();
        assert!(json.contains(TRUTH_SCHEMA));
        let back: Truth = serde_json::from_str(&json).unwrap();
        assert_eq!(back, truth);
    }

    #[test]
    fn experiment_refuses_to_start_the_solver_at_the_answer() {
        let mut e = Experiment::new(demos::philadelphia_stars(), 3);
        e.solve_options.initializer = Some(e.scenario.truth);
        let err = e.check().unwrap_err();
        assert!(err.contains("initializer is the truth"), "{err}");
        // And the runner reports it rather than producing numbers.
        let s = run(&e, None);
        assert!(s.runs.is_empty());
        assert!(s.notes[0].contains("experiment refused"));

        let mut e = Experiment::new(demos::philadelphia_stars(), 3);
        e.solve_options.prior = Some(PositionPrior {
            center: e.scenario.truth,
            sigma_nm: 5.0,
        });
        assert!(
            e.check()
                .unwrap_err()
                .contains("prior is centred on the truth")
        );

        // An offset initializer is fine: that is what a DR position is.
        let mut e = Experiment::new(demos::philadelphia_stars(), 3);
        e.solve_options.initializer = Some(LatLon {
            lat_deg: 40.5,
            lon_deg: -75.9,
        });
        e.check().unwrap();

        // Zero repetitions is a setup error, not an empty success.
        let e = Experiment::new(demos::philadelphia_stars(), 0);
        assert!(e.check().unwrap_err().contains("repetitions"));
    }

    #[test]
    fn predicted_bias_shift_uses_the_scenarios_own_geometry() {
        let s = demos::shared_bias();
        let (dn, de) = predicted_bias_shift_m(&s, None).unwrap();
        let magnitude = dn.hypot(de);
        // A 3 arcminute bias on this geometry moves the fix kilometres, not metres.
        assert!(magnitude > 3_000.0, "bias shift {magnitude} m");
        // No bias, no shift.
        let mut clean = s.clone();
        clean.shared_altitude_bias_arcmin = 0.0;
        let (dn, de) = predicted_bias_shift_m(&clean, None).unwrap();
        assert!(dn.abs() < 1e-9 && de.abs() < 1e-9);
    }

    #[test]
    fn experiment_round_trips_through_json() {
        let e = Experiment::new(demos::one_bad_sight(), 25);
        let json = serde_json::to_string(&e).unwrap();
        let back: Experiment = serde_json::from_str(&json).unwrap();
        assert_eq!(back.scenario.name, e.scenario.name);
        assert_eq!(back.scenario.seed, e.scenario.seed);
        assert_eq!(back.repetitions, e.repetitions);
        assert_eq!(back.scenario.wrong_sight, e.scenario.wrong_sight);
        assert_eq!(back.scenario.schedule, e.scenario.schedule);
        assert_eq!(back.scenario.assumed_position, e.scenario.assumed_position);
        assert_eq!(back.scenario.sources.len(), e.scenario.sources.len());
        // NOT bit-exact: serde_json parses floats with a fast algorithm that can be one
        // unit in the last place out unless its `float_roundtrip` feature is enabled,
        // which this workspace does not turn on. One ULP of a GHA is 1e-14 degrees, or
        // about a nanometre of position, so it changes nothing numerically; it does mean
        // `assert_eq!` on a round-tripped struct is the wrong test to write, here or in
        // the session CSV/JSON path.
        for (a, b) in e.scenario.sources.iter().zip(&back.scenario.sources) {
            match (a, b) {
                (
                    BodySource::Supplied {
                        name: n1,
                        gha_deg_at_start: g1,
                        dec_deg: d1,
                        gha_rate_deg_per_hour: r1,
                    },
                    BodySource::Supplied {
                        name: n2,
                        gha_deg_at_start: g2,
                        dec_deg: d2,
                        gha_rate_deg_per_hour: r2,
                    },
                ) => {
                    assert_eq!(n1, n2);
                    assert!((g1 - g2).abs() < 1e-12, "{g1} vs {g2}");
                    assert!((d1 - d2).abs() < 1e-12);
                    assert_eq!(r1, r2);
                }
                _ => panic!("source kind changed across the round trip"),
            }
        }
    }

    // ---- things that need the solver -----------------------------------------

    #[ignore = "needs solver merge"]
    #[test]
    fn a_clean_scenario_recovers_its_truth_within_ten_metres() {
        // The brief's numerical regression target: clean, well-conditioned synthetic
        // geometry must land on its own truth.
        let mut s = demos::philadelphia_stars();
        s.altitude_noise_arcmin = 0.0;
        s.reported_sigma_arcmin = Some(1.0);
        let summary = run(&Experiment::new(s, 1), None);
        let r = &summary.runs[0];
        assert_eq!(r.result_kind, "unique", "{:?}", summary.notes);
        assert!(r.converged);
        assert!(r.error_m.unwrap() < 10.0, "error {:?} m", r.error_m);
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn coverage_of_the_nominal_ellipse_is_near_95_percent_under_its_own_model() {
        // Independent noise, honest sigma, good geometry: the ellipse should mean what
        // it says. 200 repetitions give a standard error of about 0.015.
        let mut s = demos::philadelphia_stars();
        s.altitude_noise_arcmin = 1.0;
        s.reported_sigma_arcmin = None;
        let summary = run(&Experiment::new(s, 200), None);
        let a = &summary.aggregate;
        assert_eq!(a.evaluated, 200, "{:?}", summary.notes);
        let (lo, hi) = a.coverage_ci95.unwrap();
        assert!(
            lo <= 0.95 && hi >= 0.95,
            "coverage {:?} CI ({lo}, {hi}) excludes 0.95",
            a.coverage_fraction
        );
        // The predicted sigma should also be the right size, not merely the right shape.
        let ratio = a.error_to_sigma_ratio.unwrap();
        assert!((0.85..1.18).contains(&ratio), "error/sigma ratio {ratio}");
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn a_shared_bias_breaks_coverage_while_the_residuals_stay_small() {
        // The brief's requirement: many repeated sights, small residuals, wrong answer.
        let summary = run(&Experiment::new(demos::shared_bias(), 40), None);
        let a = &summary.aggregate;
        assert!(a.evaluated > 0, "{:?}", summary.notes);
        assert!(
            a.coverage_fraction.unwrap() < 0.2,
            "a 3 arcminute shared bias must fall outside the ellipse: {:?}",
            a.coverage_fraction
        );
        assert!(
            a.error_to_sigma_ratio.unwrap() > 5.0,
            "error/sigma ratio {:?}",
            a.error_to_sigma_ratio
        );
        // ...and the residuals give no hint of it: they stay within a few times the
        // 0.3 arcminute noise, not the 3 arcminute bias.
        assert!(
            a.mean_residual_rms_arcmin.unwrap() < 1.5,
            "residual RMS {:?}",
            a.mean_residual_rms_arcmin
        );
        // The predicted shift from the closed form must match what the solver did.
        let (dn, de) = predicted_bias_shift_m(&demos::shared_bias(), None).unwrap();
        let mn = a.mean_error_north_m.unwrap();
        let me = a.mean_error_east_m.unwrap();
        assert!(
            (mn - dn).hypot(me - de) < 60.0,
            "solver moved to ({mn}, {me}), closed form predicts ({dn}, {de})"
        );
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn a_clock_offset_moves_the_fix_west_by_the_predicted_amount() {
        let s = demos::clock_offset();
        let summary = run(&Experiment::new(s.clone(), 1), None);
        let r = &summary.runs[0];
        assert_eq!(r.result_kind, "unique", "{:?}", summary.notes);
        let want = clock_shift_east_m(
            s.truth.lat_deg,
            SIDEREAL_RATE_DEG_PER_HOUR,
            s.clock_offset_s,
        );
        assert!(
            (r.error_east_m.unwrap() - want).abs() < 50.0,
            "east error {:?} m, predicted {want} m",
            r.error_east_m
        );
        assert!(
            r.error_north_m.unwrap().abs() < 50.0,
            "latitude must be untouched: {:?}",
            r.error_north_m
        );
        // Nothing in the data reveals it: the residuals are at the noise level.
        assert!(r.residual_rms_arcmin.unwrap() < 0.1);
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn clustered_geometry_is_worse_than_spread_geometry() {
        let good = run(&Experiment::new(demos::good_geometry(), 30), None);
        let bad = run(&Experiment::new(demos::clustered_geometry(), 30), None);
        assert!(good.aggregate.evaluated > 0 && bad.aggregate.evaluated > 0);
        assert!(
            bad.aggregate.rms_error_m.unwrap() > 2.0 * good.aggregate.rms_error_m.unwrap(),
            "clustered {:?} vs good {:?}",
            bad.aggregate.rms_error_m,
            good.aggregate.rms_error_m
        );
        // And the solver must SAY so: the predicted sigma grows too, so coverage holds.
        assert!(
            bad.aggregate.rms_predicted_sigma_m.unwrap()
                > 2.0 * good.aggregate.rms_predicted_sigma_m.unwrap()
        );
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn one_bad_sight_shows_up_in_the_residuals() {
        let summary = run(&Experiment::new(demos::one_bad_sight(), 1), None);
        let r = &summary.runs[0];
        assert_eq!(r.result_kind, "unique", "{:?}", summary.notes);
        // The blunder is 8 arcminutes; least squares spreads it, but the worst residual
        // must still stand well clear of the 0.5 arcminute noise.
        assert!(
            r.max_abs_residual_arcmin.unwrap() > 2.0,
            "worst residual {:?}",
            r.max_abs_residual_arcmin
        );
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn one_sight_is_underdetermined_and_two_are_ambiguous() {
        let one = run(&Experiment::new(demos::single_sight(), 1), None);
        assert_eq!(one.runs[0].result_kind, "underdetermined");
        assert!(one.runs[0].error_m.is_none(), "no point may be reported");
        let two = run(&Experiment::new(demos::two_sight_ambiguous(), 1), None);
        assert_eq!(two.runs[0].result_kind, "ambiguous");
        assert!(two.runs[0].error_m.is_none());
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn sextant_readings_solve_to_the_same_place_as_corrected_ones() {
        // The reverse correction chain and the reducer's forward chain must agree well
        // enough that the fix does not move.
        let mut ho = Scenario::new(
            "ho",
            5150,
            PHL,
            "2026-10-01T01:30:00Z",
            vec![
                body_at("sim-A", PHL, 58.0, 35.0),
                body_at("sim-B", PHL, 44.0, 105.0),
                body_at("sim-C", PHL, 39.0, 240.0),
                body_at("sim-D", PHL, 62.0, 310.0),
            ],
            Schedule::new(4, 60.0, Ordering::RoundRobin),
        );
        ho.reported_sigma_arcmin = Some(1.0);
        let mut hs = ho.clone();
        hs.name = "hs".to_string();
        hs.altitude_kind = crate::scenario::EmittedAltitude::SextantHs {
            height_of_eye_m: 2.0,
            index_correction_arcmin: -1.5,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        };
        let a = run(&Experiment::new(ho, 1), None);
        let b = run(&Experiment::new(hs, 1), None);
        assert_eq!(a.runs[0].result_kind, "unique");
        assert_eq!(b.runs[0].result_kind, "unique");
        let da = a.runs[0].error_m.unwrap();
        let db = b.runs[0].error_m.unwrap();
        assert!((da - db).abs() < 1.0, "Ho fix {da} m vs Hs fix {db} m");
    }

    #[ignore = "needs solver merge"]
    #[test]
    fn every_demo_runs_end_to_end() {
        for s in demos::all() {
            let name = s.name.clone();
            let summary = run(&Experiment::new(s, 2), None);
            assert_eq!(
                summary.aggregate.repetitions, 2,
                "{name}: {:?}",
                summary.notes
            );
            assert!(
                !summary
                    .runs
                    .iter()
                    .any(|r| r.result_kind == "simulation_error"),
                "{name}: {:?}",
                summary.notes
            );
            // Both output formats must always work.
            assert!(to_csv(&summary).lines().count() > 2);
            to_json(&summary).unwrap();
        }
    }
}
