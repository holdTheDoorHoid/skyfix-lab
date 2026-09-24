//! CONVENTIONS section 8: weighted nonlinear least squares on the sphere.
//!
//! OWNER: core-solver agent. Uses only `geometry` for the model and `uncertainty` for
//! covariance/ellipse/conditioning. Never reads a `Truth`.
//!
//! # The model
//!
//! Unknowns are the observer position `(phi, lambda)` and, optionally, a shared altitude
//! bias `b`:
//!
//! ```text
//! Ho_i = Hc_i(phi, lambda) + b + e_i,   e_i ~ N(0, sigma_i^2), independent
//! ```
//!
//! `Hc` and `Zn` come from [`crate::geometry::altitude_azimuth`]; the Jacobian row is
//! [`crate::geometry::tangent_row`] (`[cos Zn, sin Zn]`) in tangent-plane displacements
//! `(dN, dE)`, plus a column of ones for `b`. Each iteration solves the damped normal
//! equations in that tangent plane, steps with [`crate::geometry::apply_tangent_step`]
//! (along the great circle, so a 3000 NM step is as valid as a 3 m one) and re-linearises
//! with the exact spherical model.
//!
//! # Damping
//!
//! Levenberg-Marquardt with uniform damping scaled by the largest diagonal of
//! `J^T W J`: the trial matrix is `A + lambda * max_i(A_ii) I`. `lambda` starts at 1e-8
//! (essentially Gauss-Newton), is multiplied by 10 on a rejected trial and divided by 5 on
//! an accepted one. Trials inside one iteration reuse the same linearisation, so the
//! reported `iterations` counts re-linearisations, not trial steps. A single position step
//! is capped at 1 radian (about 3400 NM) so an early over-shoot cannot jump the far side
//! of the sphere on a whim; the cap is a trial like any other and is accepted only if the
//! cost falls.
//!
//! # chi2 versus cost
//!
//! `chi2` is always the plain data misfit `sum (r_i / sigma_i)^2`. The value that
//! multistart clusters and ranks by is the *cost*, which additionally carries robust
//! weights and the prior term when those are in use. With neither (the default) the two
//! are identical, which is why `FixCandidate::delta_chi2_from_best` and the ambiguity
//! margin behave exactly as section 8 describes.

use crate::geometry::{
    self, CircleIntersection, Point, altitude_azimuth, angular_distance, apply_tangent_step,
    geographic_position, tangent_offset, two_circle_intersections,
};
use crate::linalg;
use crate::types::{
    CircleOfPosition, Conditioning, Fix, FixCandidate, FixResult, LatLon, PosteriorScaled,
    PriorReport, Residual, RobustOptions, RobustReport, Sight, SolveOptions, Warning,
};
use crate::uncertainty;
use crate::units::{EARTH_RADIUS_M, nm_to_rad, rad_to_arcmin, rad_to_deg, rad_to_m, rad_to_nm};
use std::cmp::Ordering;
use std::f64::consts::{FRAC_PI_2, PI};

const LM_LAMBDA_INIT: f64 = 1e-8;
const LM_LAMBDA_MIN: f64 = 1e-14;
const LM_LAMBDA_MAX: f64 = 1e12;
const LM_LAMBDA_UP: f64 = 10.0;
const LM_LAMBDA_DOWN: f64 = 5.0;
const LM_MAX_TRIALS: usize = 30;
/// Largest position step accepted from one linearisation, radians of arc (~3400 NM).
const MAX_POSITION_STEP_RAD: f64 = 1.0;
/// Condition number at or above which the 95 % ellipse is suppressed (section 9).
const ELLIPSE_CONDITION_LIMIT: f64 = 1e6;
/// Tangency tolerance handed to [`two_circle_intersections`], radians.
const INTERSECTION_TOL_RAD: f64 = 1e-9;
const MAX_LISTED_CANDIDATES: usize = 16;
const MAX_LISTED_ALTERNATIVES: usize = 8;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Solve for a stationary observer position from reduced sights.
pub fn solve(sights: &[Sight], options: &SolveOptions) -> FixResult {
    let mut warnings: Vec<Warning> = Vec::new();

    let (usable, dropped) = partition_usable(sights);
    if !dropped.is_empty() {
        warnings.push(Warning::Other {
            message: format!(
                "ignored {} sight(s) with a non-finite value or sigma <= 0: {}",
                dropped.len(),
                dropped.join(", ")
            ),
        });
    }
    let circles = circles_of_position(&usable);
    if let Some(ids) = duplicate_ids(&usable) {
        warnings.push(Warning::DuplicateObservation { ids });
    }

    let n_params = if options.estimate_shared_bias { 3 } else { 2 };

    if usable.len() < 2 {
        return underdetermined(
            circles,
            format!(
                "{} usable sight(s): one altitude constrains the observer to a circle of \
                 position, not to a point",
                usable.len()
            ),
            warnings,
        );
    }
    if usable.len() < n_params {
        return underdetermined(
            circles,
            format!(
                "{} usable sight(s) for {} unknowns (position and a shared altitude bias): \
                 the bias cannot be separated from position",
                usable.len(),
                n_params
            ),
            warnings,
        );
    }
    // Exactly two sights: the analytic geometry decides, so a pair whose circles miss or
    // merely touch can never be polished into a confident-looking point fix.
    if usable.len() == 2
        && n_params == 2
        && let Some(reason) = two_sight_degeneracy(usable[0], usable[1])
    {
        return underdetermined(circles, reason, warnings);
    }

    let prior = match options.prior {
        Some(p) => {
            if p.sigma_nm.is_finite()
                && p.sigma_nm > 0.0
                && p.center.lat_deg.is_finite()
                && p.center.lon_deg.is_finite()
            {
                Some((
                    Point::from_deg(p.center.lat_deg, p.center.lon_deg),
                    nm_to_rad(p.sigma_nm),
                ))
            } else {
                warnings.push(Warning::Other {
                    message: "prior ignored: sigma_nm must be finite and positive and the centre \
                              must be a finite position"
                        .to_string(),
                });
                None
            }
        }
        None => None,
    };

    let model = Model {
        sights: usable.clone(),
        weights: vec![1.0; usable.len()],
        n_params,
        prior,
    };

    let search = multistart(&model, options);
    if search.clusters.is_empty() {
        warnings.push(Warning::NotConverged {
            iterations: options.max_iterations,
        });
        let detail = match search.best_unconverged {
            Some(c) => format!("best unconverged cost was {c:.6}"),
            None => "no start produced a finite cost".to_string(),
        };
        return FixResult::Failed {
            reason: format!(
                "no start converged: {} starts tried, {} iterations each, {detail}",
                search.starts, options.max_iterations
            ),
            warnings,
        };
    }

    let best = search.clusters[0].clone();

    // Rank at the best minimum. Tangent or disjoint circles land on a ridge where every
    // azimuth row is parallel, which is exactly what a rank test detects.
    let eval = model.eval(best.p, best.b);
    let (jw, az) = weighted_jacobian(&model, &eval);
    let cond = uncertainty::conditioning(&jw, &az);
    if cond.rank < n_params {
        return underdetermined(
            circles,
            format!(
                "the sight geometry determines only {} of {} unknowns (singular values {}): \
                 the observations fix a line, not a point",
                cond.rank,
                n_params,
                format_singular_values(&cond)
            ),
            warnings,
        );
    }

    let margin = if options.multistart.ambiguity_delta_chi2.is_finite() {
        options.multistart.ambiguity_delta_chi2
    } else {
        crate::units::CHI2_95_2DOF
    };
    let ambiguous = search
        .clusters
        .get(1)
        .is_some_and(|second| second.cost - best.cost <= margin);

    if ambiguous {
        let candidates: Vec<FixCandidate> = search
            .clusters
            .iter()
            .take(MAX_LISTED_CANDIDATES)
            .map(|m| candidate(m, best.cost, n_params))
            .collect();
        let reason = format!(
            "{} minima within delta chi2 {:.3}: no candidate is promoted",
            candidates
                .iter()
                .filter(|c| c.delta_chi2_from_best <= margin)
                .count(),
            margin
        );
        warnings.push(Warning::EllipseSuppressed { reason });
        return FixResult::Ambiguous {
            candidates,
            circles,
            warnings,
        };
    }

    let alternatives: Vec<FixCandidate> = search
        .clusters
        .iter()
        .skip(1)
        .take(MAX_LISTED_ALTERNATIVES)
        .map(|m| candidate(m, best.cost, n_params))
        .collect();

    match build_fix(&model, &best, options, &mut warnings) {
        Some(fix) => FixResult::Unique {
            fix,
            alternatives,
            warnings,
        },
        None => FixResult::Failed {
            reason: "the normal equations at the best minimum are not positive definite, so no \
                     covariance can be reported"
                .to_string(),
            warnings,
        },
    }
}

// ---------------------------------------------------------------------------
// The least-squares model
// ---------------------------------------------------------------------------

struct Eval {
    hc: Vec<f64>,
    zn: Vec<f64>,
    /// `Ho_i - Hc_i - b`, radians.
    r: Vec<f64>,
    /// Plain data misfit `sum (r_i / sigma_i)^2`.
    chi2: f64,
    /// What the iteration minimises: data misfit with robust weights, plus the prior.
    cost: f64,
}

#[derive(Clone)]
struct Minimum {
    p: Point,
    b: f64,
    cost: f64,
    chi2: f64,
    iterations: u32,
    converged: bool,
}

struct Model<'a> {
    sights: Vec<&'a Sight>,
    /// Robust multipliers on `1 / sigma_i^2`; all 1.0 unless Huber IRLS is running.
    weights: Vec<f64>,
    n_params: usize,
    /// Gaussian position prior: centre and 1-sigma radius in radians of arc.
    prior: Option<(Point, f64)>,
}

impl Model<'_> {
    fn eval(&self, p: Point, b: f64) -> Eval {
        let n = self.sights.len();
        let mut hc = Vec::with_capacity(n);
        let mut zn = Vec::with_capacity(n);
        let mut r = Vec::with_capacity(n);
        let mut chi2 = 0.0;
        let mut cost = 0.0;
        for (k, s) in self.sights.iter().enumerate() {
            let (h, z) = altitude_azimuth(p, s.gha_rad, s.dec_rad);
            let ri = s.ho_rad - h - b;
            let u = ri / s.sigma_rad;
            chi2 += u * u;
            cost += self.weights[k] * u * u;
            hc.push(h);
            zn.push(z);
            r.push(ri);
        }
        if let Some((centre, sigma)) = self.prior {
            let (qn, qe) = tangent_offset(centre, p);
            cost += (qn * qn + qe * qe) / (sigma * sigma);
        }
        Eval {
            hc,
            zn,
            r,
            chi2,
            cost,
        }
    }

    /// Normal equations `A dx = g` with `A = J^T W J` and `g = J^T W r` (plus the prior).
    fn normal(&self, p: Point, e: &Eval) -> (Vec<Vec<f64>>, Vec<f64>) {
        let m = self.n_params;
        let mut a = vec![vec![0.0f64; m]; m];
        let mut g = vec![0.0f64; m];
        for (k, s) in self.sights.iter().enumerate() {
            let w = self.weights[k] / (s.sigma_rad * s.sigma_rad);
            let (cn, ce) = geometry::tangent_row(e.zn[k]);
            let row = [cn, ce, 1.0];
            for i in 0..m {
                g[i] += w * row[i] * e.r[k];
                for j in 0..m {
                    a[i][j] += w * row[i] * row[j];
                }
            }
        }
        if let Some((centre, sigma)) = self.prior {
            let info = 1.0 / (sigma * sigma);
            a[0][0] += info;
            a[1][1] += info;
            let (qn, qe) = tangent_offset(centre, p);
            g[0] -= info * qn;
            g[1] -= info * qe;
        }
        (a, g)
    }

    /// Levenberg-Marquardt from one start. `None` when the start itself is not evaluable.
    fn refine(&self, start: Point, b0: f64, max_iterations: u32, tol: f64) -> Option<Minimum> {
        let mut p = start;
        let mut b = b0;
        let mut e = self.eval(p, b);
        if !e.cost.is_finite() {
            return None;
        }
        let mut lambda = LM_LAMBDA_INIT;
        let mut iterations = 0u32;
        let mut converged = false;

        while iterations < max_iterations {
            iterations += 1;
            let (a, g) = self.normal(p, &e);
            let dmax = (0..self.n_params).fold(0.0f64, |m, i| m.max(a[i][i]));
            if !dmax.is_finite() || dmax <= 0.0 {
                break;
            }
            let mut accepted = false;
            for _trial in 0..LM_MAX_TRIALS {
                let mut ad = a.clone();
                for (i, row) in ad.iter_mut().enumerate() {
                    row[i] = a[i][i] + lambda * dmax;
                }
                let Some(dx) = linalg::solve_sym_pd(&ad, &g) else {
                    lambda *= LM_LAMBDA_UP;
                    if lambda > LM_LAMBDA_MAX {
                        break;
                    }
                    continue;
                };
                let (mut dn, mut de) = (dx[0], dx[1]);
                let raw = dn.hypot(de);
                if !raw.is_finite() {
                    lambda *= LM_LAMBDA_UP;
                    if lambda > LM_LAMBDA_MAX {
                        break;
                    }
                    continue;
                }
                if raw > MAX_POSITION_STEP_RAD {
                    let f = MAX_POSITION_STEP_RAD / raw;
                    dn *= f;
                    de *= f;
                }
                let db = if self.n_params == 3 { dx[2] } else { 0.0 };
                let trial_p = apply_tangent_step(p, dn, de);
                let trial_b = b + db;
                let trial_e = self.eval(trial_p, trial_b);
                if trial_e.cost.is_finite() && trial_e.cost <= e.cost {
                    let step = dn.hypot(de).hypot(db.abs());
                    p = trial_p;
                    b = trial_b;
                    e = trial_e;
                    lambda = (lambda / LM_LAMBDA_DOWN).max(LM_LAMBDA_MIN);
                    accepted = true;
                    converged = step < tol;
                    break;
                }
                lambda *= LM_LAMBDA_UP;
                if lambda > LM_LAMBDA_MAX {
                    break;
                }
            }
            if converged {
                break;
            }
            if !accepted {
                // No damped step of any size lowers the cost: this is a minimum to
                // floating-point precision, not a failure to converge.
                converged = true;
                break;
            }
        }

        Some(Minimum {
            p,
            b,
            cost: e.cost,
            chi2: e.chi2,
            iterations,
            converged,
        })
    }
}

// ---------------------------------------------------------------------------
// Multistart
// ---------------------------------------------------------------------------

struct Search {
    clusters: Vec<Minimum>,
    starts: usize,
    best_unconverged: Option<f64>,
}

fn multistart(model: &Model<'_>, options: &SolveOptions) -> Search {
    let starts = build_starts(model, options);
    let max_iterations = options.max_iterations.max(1);
    let tol = if options.step_tolerance_rad.is_finite() && options.step_tolerance_rad > 0.0 {
        options.step_tolerance_rad
    } else {
        1e-9
    };
    let radius = if options.multistart.cluster_radius_nm.is_finite()
        && options.multistart.cluster_radius_nm > 0.0
    {
        nm_to_rad(options.multistart.cluster_radius_nm)
    } else {
        nm_to_rad(10.0)
    };

    let mut converged: Vec<Minimum> = Vec::new();
    let mut best_unconverged: Option<f64> = None;
    for s in &starts {
        let Some(m) = model.refine(*s, 0.0, max_iterations, tol) else {
            continue;
        };
        if !m.cost.is_finite() {
            continue;
        }
        if m.converged {
            converged.push(m);
        } else {
            best_unconverged = Some(best_unconverged.map_or(m.cost, |c: f64| c.min(m.cost)));
        }
    }

    converged.sort_by(|a, b| a.cost.partial_cmp(&b.cost).unwrap_or(Ordering::Equal));
    let mut clusters: Vec<Minimum> = Vec::new();
    for m in converged {
        if clusters.iter().any(|k| angular_distance(k.p, m.p) < radius) {
            continue;
        }
        clusters.push(m);
    }

    Search {
        clusters,
        starts: starts.len(),
        best_unconverged,
    }
}

/// Starts, in the order section 8 prescribes: the supplied initializer (never a prior),
/// the analytic circle intersections, then a coarse global grid.
fn build_starts(model: &Model<'_>, options: &SolveOptions) -> Vec<Point> {
    let mut starts: Vec<Point> = Vec::new();
    if let Some(ll) = options.initializer
        && ll.lat_deg.is_finite()
        && ll.lon_deg.is_finite()
    {
        starts.push(Point::from_deg(ll.lat_deg, ll.lon_deg));
    }
    if let Some((centre, _)) = model.prior {
        starts.push(centre);
    }

    let n = model.sights.len();
    let pairs: &[(usize, usize)] = if n == 2 {
        &[(0, 1)]
    } else {
        // For n > 2 the first three pairs are cheap and, between them, cover every basin
        // the analytic geometry can reach.
        &[(0, 1), (0, 2), (1, 2)]
    };
    for &(i, j) in pairs {
        if i >= n || j >= n {
            continue;
        }
        match analytic_pair(model.sights[i], model.sights[j]) {
            Some(CircleIntersection::Two(a, b)) => {
                starts.push(a);
                starts.push(b);
            }
            Some(CircleIntersection::Tangent(a)) => starts.push(a),
            _ => {}
        }
    }

    if options.multistart.enabled {
        starts.extend(global_grid(options.multistart.grid_step_deg));
    }
    starts
}

/// Coarse global grid over both hemispheres and all longitudes.
///
/// Latitudes are sampled at `grid_step_deg` (cell centres, so the poles themselves, where
/// longitude is meaningless, are never used as a start). The number of longitude samples
/// on each parallel is scaled by `cos(lat)` so the spacing *on the sphere* stays near
/// `grid_step_deg` instead of crowding hundreds of near-identical starts around the poles:
/// at the default 10 degrees that is 413 starts rather than 648, for strictly better
/// coverage.
fn global_grid(grid_step_deg: f64) -> Vec<Point> {
    let step = if grid_step_deg.is_finite() && grid_step_deg > 0.0 {
        grid_step_deg.clamp(1.0, 60.0)
    } else {
        10.0
    };
    let n_lat = ((180.0 / step).ceil() as usize).max(2);
    let mut out = Vec::new();
    for i in 0..n_lat {
        let lat = -90.0 + (i as f64 + 0.5) * 180.0 / n_lat as f64;
        let n_lon = (((360.0 * lat.to_radians().cos()) / step).round() as i64).max(1) as usize;
        for j in 0..n_lon {
            let lon = -180.0 + (j as f64 + 0.5) * 360.0 / n_lon as f64;
            out.push(Point::from_deg(lat, lon));
        }
    }
    out
}

fn analytic_pair(a: &Sight, b: &Sight) -> Option<CircleIntersection> {
    let z1 = FRAC_PI_2 - a.ho_rad;
    let z2 = FRAC_PI_2 - b.ho_rad;
    if !(z1 > 0.0 && z1 < PI && z2 > 0.0 && z2 < PI) {
        return None;
    }
    Some(two_circle_intersections(
        geographic_position(a.gha_rad, a.dec_rad),
        z1,
        geographic_position(b.gha_rad, b.dec_rad),
        z2,
        INTERSECTION_TOL_RAD,
    ))
}

/// For exactly two sights: the reason there is no point fix, or `None` when the circles
/// genuinely cross (which is the ambiguous two-intersection case, not a unique fix).
fn two_sight_degeneracy(a: &Sight, b: &Sight) -> Option<String> {
    match analytic_pair(a, b)? {
        CircleIntersection::Two(..) => None,
        CircleIntersection::Tangent(p) => Some(format!(
            "the two circles of position only touch, at {:.4} deg, {:.4} deg (gap 0.00 NM): \
             the position is undetermined along the tangent, so no point fix is reported",
            p.lat_deg(),
            p.lon_deg()
        )),
        CircleIntersection::None { gap } => Some(format!(
            "the two circles of position do not meet: gap {:.2} NM. No position satisfies \
             both sights, and the least-squares point between the circles would be a fake fix",
            rad_to_nm(gap)
        )),
        CircleIntersection::Coincident => Some(
            "the two sights describe the same circle of position: every point on that circle \
             fits both observations"
                .to_string(),
        ),
    }
}

// ---------------------------------------------------------------------------
// Building the reported fix
// ---------------------------------------------------------------------------

fn build_fix(
    base: &Model<'_>,
    best: &Minimum,
    options: &SolveOptions,
    warnings: &mut Vec<Warning>,
) -> Option<Fix> {
    let mut model = Model {
        sights: base.sights.clone(),
        weights: base.weights.clone(),
        n_params: base.n_params,
        prior: base.prior,
    };
    let mut current = best.clone();
    let mut robust = None;

    if let Some(ro) = options.robust {
        let (m, downweighted_ids, huber_k) = huber_irls(&mut model, &current, &ro, options);
        current = m;
        warnings.push(Warning::RobustWeightsApplied {
            downweighted_ids: downweighted_ids.clone(),
        });
        robust = Some(RobustReport {
            huber_k,
            downweighted_ids,
            note: format!(
                "Huber IRLS, k = {huber_k} on normalised residuals. The reported covariance is \
                 APPROXIMATE: the final weights are treated as if they had been known in \
                 advance, so the uncertainty contributed by the down-weighting decision itself \
                 is not propagated."
            ),
        });
    }

    let eval = model.eval(current.p, current.b);
    let (jw, az) = weighted_jacobian(&model, &eval);
    let conditioning = uncertainty::conditioning(&jw, &az);
    if uncertainty::is_poor_geometry(&conditioning) {
        warnings.push(Warning::PoorGeometry {
            condition_number: conditioning.condition_number,
            max_azimuth_gap_deg: conditioning.max_azimuth_gap_deg,
        });
    }

    let (a, _) = model.normal(current.p, &eval);
    let inv = linalg::invert_sym_pd(&a)?;
    let r2 = EARTH_RADIUS_M * EARTH_RADIUS_M;
    let mut covariance_ne_m2 = [
        [inv[0][0] * r2, inv[0][1] * r2],
        [inv[1][0] * r2, inv[1][1] * r2],
    ];

    // Clock uncertainty: a shared time error is exactly a longitude error (section 6).
    let omega = mean_gha_rate(&model.sights);
    let sigma_t = if options.clock_uncertainty_s.is_finite() {
        options.clock_uncertainty_s.max(0.0)
    } else {
        0.0
    };
    let clock_sigma_east_m = if sigma_t > 0.0 && omega.is_finite() {
        rad_to_m((current.p.lat.cos() * omega * sigma_t).abs())
    } else {
        0.0
    };
    covariance_ne_m2[1][1] += clock_sigma_east_m * clock_sigma_east_m;
    if sigma_t > 0.0 {
        warnings.push(Warning::ClockDegenerateWithLongitude {
            sigma_east_m: clock_sigma_east_m,
        });
    }

    let sigma_north_m = covariance_ne_m2[0][0].max(0.0).sqrt();
    let sigma_east_m = covariance_ne_m2[1][1].max(0.0).sqrt();

    let suppressed = ellipse_suppression(&current, &conditioning, model.n_params);
    let (ellipse95, ellipse_suppressed_reason) = match suppressed {
        Some(reason) => {
            warnings.push(Warning::EllipseSuppressed {
                reason: reason.clone(),
            });
            (None, Some(reason))
        }
        None => match uncertainty::ellipse_95(covariance_ne_m2) {
            Some(e) => (Some(e), None),
            None => {
                let reason =
                    "the covariance is not positive definite, so no ellipse is defined".to_string();
                warnings.push(Warning::EllipseSuppressed {
                    reason: reason.clone(),
                });
                (None, Some(reason))
            }
        },
    };

    let dof = model.sights.len() as i64 - model.n_params as i64;
    let posterior_scaled = if options.posterior_scaling {
        if dof >= 3 {
            let s2 = eval.chi2 / dof as f64;
            let scaled = [
                [covariance_ne_m2[0][0] * s2, covariance_ne_m2[0][1] * s2],
                [covariance_ne_m2[1][0] * s2, covariance_ne_m2[1][1] * s2],
            ];
            Some(PosteriorScaled {
                scale_factor_s2: s2,
                covariance_ne_m2: scaled,
                ellipse95: if ellipse95.is_some() {
                    uncertainty::ellipse_95(scaled)
                } else {
                    None
                },
            })
        } else {
            // Two or three sights cannot establish their own noise level (section 9).
            warnings.push(Warning::PosteriorScalingSkipped { dof });
            None
        }
    } else {
        None
    };

    let residuals: Vec<Residual> = model
        .sights
        .iter()
        .enumerate()
        .map(|(k, s)| Residual {
            id: s.id.clone(),
            body: s.body.clone(),
            hc_deg: rad_to_deg(eval.hc[k]),
            zn_deg: rad_to_deg(eval.zn[k]),
            residual_arcmin: rad_to_arcmin(eval.r[k]),
            normalized: eval.r[k] / s.sigma_rad,
            weight: model.weights[k],
            // Classic intercept `Ho - Hc`, i.e. the residual before any shared bias is
            // removed; it differs from `residual_arcmin` by exactly that bias.
            intercept_nm: rad_to_nm(s.ho_rad - eval.hc[k]),
        })
        .collect();

    let prior = prior_report(&model, options, &current, warnings);

    Some(Fix {
        position: latlon(current.p),
        shared_bias_arcmin: if model.n_params == 3 {
            Some(rad_to_arcmin(current.b))
        } else {
            None
        },
        covariance_ne_m2,
        sigma_north_m,
        sigma_east_m,
        clock_sigma_east_m,
        ellipse95,
        ellipse_suppressed_reason,
        posterior_scaled,
        residuals,
        chi2: eval.chi2,
        dof,
        conditioning,
        iterations: current.iterations,
        converged: current.converged,
        prior,
        robust,
    })
}

fn ellipse_suppression(m: &Minimum, c: &Conditioning, n_params: usize) -> Option<String> {
    if !m.converged {
        return Some("the iteration did not converge".to_string());
    }
    if c.rank < n_params {
        return Some(format!(
            "the Jacobian has rank {} for {} unknowns",
            c.rank, n_params
        ));
    }
    if c.condition_number.is_nan() || c.condition_number >= ELLIPSE_CONDITION_LIMIT {
        return Some(format!(
            "condition number {:.3e} is at or beyond 1e6: the geometry is effectively singular",
            c.condition_number
        ));
    }
    None
}

fn huber_irls(
    model: &mut Model<'_>,
    start: &Minimum,
    ro: &RobustOptions,
    options: &SolveOptions,
) -> (Minimum, Vec<String>, f64) {
    let k = if ro.huber_k.is_finite() && ro.huber_k > 0.0 {
        ro.huber_k
    } else {
        1.5
    };
    let max_iterations = options.max_iterations.max(1);
    let tol = if options.step_tolerance_rad.is_finite() && options.step_tolerance_rad > 0.0 {
        options.step_tolerance_rad
    } else {
        1e-9
    };
    let mut current = start.clone();
    for _ in 0..ro.max_reweight_iterations.max(1) {
        let e = model.eval(current.p, current.b);
        let mut changed = false;
        for (i, s) in model.sights.iter().enumerate() {
            let u = (e.r[i] / s.sigma_rad).abs();
            let w = if u <= k || !u.is_finite() { 1.0 } else { k / u };
            if (w - model.weights[i]).abs() > 1e-12 {
                changed = true;
            }
            model.weights[i] = w;
        }
        let Some(next) = model.refine(current.p, current.b, max_iterations, tol) else {
            break;
        };
        let moved = angular_distance(next.p, current.p);
        current = next;
        if !changed && moved < tol {
            break;
        }
    }
    let ids = model
        .sights
        .iter()
        .enumerate()
        .filter(|(i, _)| model.weights[*i] < 1.0 - 1e-9)
        .map(|(_, s)| s.id.clone())
        .collect();
    (current, ids, k)
}

/// Solve again without the prior, so the report can show what the data alone said.
fn prior_report(
    model: &Model<'_>,
    options: &SolveOptions,
    current: &Minimum,
    warnings: &mut Vec<Warning>,
) -> Option<PriorReport> {
    let supplied = options.prior?;
    let (centre, _) = model.prior?;
    let plain = Model {
        sights: model.sights.clone(),
        weights: vec![1.0; model.sights.len()],
        n_params: model.n_params,
        prior: None,
    };
    let search = multistart(&plain, options);
    let (fix_without_prior, shift_m) = match search.clusters.first() {
        Some(m) => (
            Some(latlon(m.p)),
            rad_to_m(angular_distance(m.p, current.p)),
        ),
        None => (None, 0.0),
    };
    warnings.push(Warning::PriorUsed {
        sigma_nm: supplied.sigma_nm,
        shift_m,
    });
    Some(PriorReport {
        center: latlon(centre),
        sigma_nm: supplied.sigma_nm,
        fix_without_prior,
        shift_m,
    })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// An underdetermined result, which by section 9 also means no ellipse: the suppression
/// is recorded as a warning so a consumer never has to infer it from the variant.
fn underdetermined(
    circles: Vec<CircleOfPosition>,
    reason: String,
    mut warnings: Vec<Warning>,
) -> FixResult {
    warnings.push(Warning::EllipseSuppressed {
        reason: format!("no point fix: {reason}"),
    });
    FixResult::Underdetermined {
        circles,
        reason,
        warnings,
    }
}

fn partition_usable(sights: &[Sight]) -> (Vec<&Sight>, Vec<String>) {
    let mut usable = Vec::new();
    let mut dropped = Vec::new();
    for s in sights {
        let finite = s.gha_rad.is_finite()
            && s.dec_rad.is_finite()
            && s.ho_rad.is_finite()
            && s.sigma_rad.is_finite();
        if finite && s.sigma_rad > 0.0 {
            usable.push(s);
        } else {
            dropped.push(s.id.clone());
        }
    }
    (usable, dropped)
}

fn circles_of_position(sights: &[&Sight]) -> Vec<CircleOfPosition> {
    sights
        .iter()
        .map(|s| CircleOfPosition {
            id: s.id.clone(),
            body: s.body.clone(),
            gp: latlon(geographic_position(s.gha_rad, s.dec_rad)),
            zenith_distance_deg: 90.0 - rad_to_deg(s.ho_rad),
        })
        .collect()
}

/// Ids of sights that repeat another sight exactly. Repeats are legitimate input (they
/// raise the degrees of freedom and shrink the covariance) but they add no geometry, so
/// the report names them.
fn duplicate_ids(sights: &[&Sight]) -> Option<Vec<String>> {
    let mut flagged: Vec<String> = Vec::new();
    for (i, a) in sights.iter().enumerate() {
        for b in sights.iter().skip(i + 1) {
            if a.gha_rad == b.gha_rad
                && a.dec_rad == b.dec_rad
                && a.ho_rad == b.ho_rad
                && a.sigma_rad == b.sigma_rad
            {
                for id in [&a.id, &b.id] {
                    if !flagged.contains(id) {
                        flagged.push(id.clone());
                    }
                }
            }
        }
    }
    if flagged.is_empty() {
        None
    } else {
        Some(flagged)
    }
}

/// `W^(1/2) J` and the azimuths, as [`uncertainty::conditioning`] wants them.
fn weighted_jacobian(model: &Model<'_>, e: &Eval) -> (Vec<Vec<f64>>, Vec<f64>) {
    let mut rows = Vec::with_capacity(model.sights.len());
    let mut az = Vec::with_capacity(model.sights.len());
    for (k, s) in model.sights.iter().enumerate() {
        let (cn, ce) = geometry::tangent_row(e.zn[k]);
        let w = model.weights[k].max(0.0).sqrt() / s.sigma_rad;
        let mut row = vec![cn * w, ce * w];
        if model.n_params == 3 {
            row.push(w);
        }
        rows.push(row);
        az.push(e.zn[k]);
    }
    (rows, az)
}

fn mean_gha_rate(sights: &[&Sight]) -> f64 {
    let mut sum = 0.0;
    let mut n = 0usize;
    for s in sights {
        if s.gha_rate_rad_per_s.is_finite() {
            sum += s.gha_rate_rad_per_s;
            n += 1;
        }
    }
    if n == 0 { 0.0 } else { sum / n as f64 }
}

fn candidate(m: &Minimum, best_cost: f64, n_params: usize) -> FixCandidate {
    FixCandidate {
        position: latlon(m.p),
        chi2: m.chi2,
        delta_chi2_from_best: m.cost - best_cost,
        converged: m.converged,
        iterations: m.iterations,
        shared_bias_arcmin: if n_params == 3 {
            Some(rad_to_arcmin(m.b))
        } else {
            None
        },
    }
}

fn latlon(p: Point) -> LatLon {
    LatLon {
        lat_deg: p.lat_deg(),
        lon_deg: p.lon_deg(),
    }
}

fn format_singular_values(c: &Conditioning) -> String {
    c.singular_values
        .iter()
        .map(|s| format!("{s:.3e}"))
        .collect::<Vec<_>>()
        .join(", ")
}
