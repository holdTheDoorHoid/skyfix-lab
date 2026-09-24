//! Running fix: sights taken while under way, reduced to one reference instant.
//!
//! CONVENTIONS sections 3, 8, 9 and 12. `docs/MOTION.md` section "Advancing the
//! geographic position" is normative for the approximation and its measured error.
//!
//! # What this module does, and what it refuses to do
//!
//! `skyfix_core::solver::solve` solves for a **stationary** observer. This module does
//! not modify it and does not reimplement it. It converts each sight into the equivalent
//! stationary sight *at a common reference instant* and hands the result to `solve`
//! unchanged.
//!
//! # Advancing the geographic position
//!
//! An altitude depends only on the angular distance between the observer and the body's
//! geographic position (GP): `Hc = 90 deg - dist(P, G)`. So moving the observer by `D` is
//! the same as moving the GP by `-D`:
//!
//! ```text
//! h(P + D, G)  ==  h(P, G - D)
//! ```
//!
//! Let `D_i` be the vessel's displacement **from the reference instant to the sight
//! instant** (so the observer at the sight was at `P_ref + D_i`). The equivalent
//! stationary sight at `P_ref` keeps the measured `Ho` and moves the GP by `-D_i` — which
//! is the classic "advance the line of position along the run", since `-D_i` points the
//! way the vessel is going when the sight is older than the fix.
//!
//! **`-D_i` cannot be applied by reusing its (north, east) components at the GP.** The GP
//! is tens of degrees away; between the observer and the GP the meridians converge, and
//! the reciprocal-components shortcut errs by **tens of kilometres** (pinned in
//! `naive_component_move_is_catastrophically_wrong`). Instead the run is applied as a
//! *rigid rotation of the sphere*: `R` is the rotation that carries the estimated
//! reference position to the estimated sight position, and the GP is moved by `R^-1`.
//! Because a rotation is an isometry,
//!
//! ```text
//! dist(P, R^-1 G)  ==  dist(R P, G)      exactly, for every P
//! ```
//!
//! so the advanced sight is **exact** at the position the rotation was built from, and
//! the whole approximation reduces to one statement: *the run is treated as the same
//! rigid rotation wherever the vessel actually was*. The true run "course 045 for 30 NM"
//! is not a rotation — the direction "045" itself turns as you move — so `R P` and the
//! true advanced position drift apart as `P` leaves the linearisation point, at roughly
//! `run x offset / earth radius`. [`approximation_error_m`] measures it; the figures are
//! in `docs/MOTION.md`, and it is why [`prepare`] re-linearises when the estimate moves.
//!
//! # Folding in the dead-reckoning uncertainty
//!
//! A sight's Jacobian row in tangent-plane displacement is `[cos Zn, sin Zn]`
//! (CONVENTIONS section 3), so an uncertain run of covariance `C_i` (radians of arc
//! squared) adds
//!
//! ```text
//! sigma_motion_i^2 = [cos Zn_i, sin Zn_i] C_i [cos Zn_i, sin Zn_i]^T
//! sigma_i'^2       = sigma_i^2 + sigma_motion_i^2
//! ```
//!
//! to that sight's altitude variance, with `Zn_i` taken at the current estimate of the
//! reference position. Only the component of the run uncertainty **along the line of
//! sight** matters: a run error at right angles to the body slides the observer along its
//! own line of position and changes no altitude.
//!
//! # The caveat that travels with every running fix
//!
//! `C_i` for different sights share the same speed and course bias, so the inflated
//! sigmas are **correlated**. `solve` treats sigmas as independent. The reported
//! covariance is therefore **optimistic** — a lower bound on the true uncertainty — and
//! every [`FixResult`] this module returns carries a `Warning::Other` saying so.

use crate::track::{MotionUncertainty, Track};
use crate::{to_latlon, to_point};
use skyfix_core::geometry::{
    Point, altitude, altitude_azimuth, angular_distance, geographic_position, tangent_row,
};
use skyfix_core::solver::solve;
use skyfix_core::types::{FixResult, LatLon, Sight, SolveOptions, Warning};
use skyfix_core::units::{norm_2pi, rad_to_arcmin, rad_to_deg, rad_to_m, rad_to_nm};

/// Re-linearise the advance when the solved reference position moves more than this from
/// the point the rotations were built at.
pub const RELINEARISE_THRESHOLD_NM: f64 = 1.0;

/// Maximum number of advance/solve passes. One pass is the plain "advance the LOP";
/// the extra passes are the "iterate if the estimate moves a lot" rule.
pub const MAX_PASSES: u32 = 3;

/// A sight together with the instant it was taken. `utc_jd` is CONVENTIONS section 6's
/// `jd_utc`; `Sight` itself carries no time because the stationary solver does not need
/// one.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedSight {
    pub sight: Sight,
    pub utc_jd: f64,
}

impl TimedSight {
    pub fn new(sight: Sight, utc_jd: f64) -> Self {
        TimedSight { sight, utc_jd }
    }
}

/// What the dead reckoning did to one sight's sigma. Reported so the inflation is never
/// invisible: the sigma the solver saw is *not* the instrument sigma.
#[derive(Debug, Clone, PartialEq)]
pub struct SigmaInflation {
    pub id: String,
    /// Hours from the sight to the reference instant, signed (negative = sight first).
    pub hours_to_reference: f64,
    /// Straight-line displacement over that interval, nautical miles.
    pub run_nm: f64,
    /// Azimuth of the advanced GP at the reference estimate, degrees.
    pub zn_deg: f64,
    pub sigma_sight_arcmin: f64,
    /// Projection of the run covariance onto this sight's line of position, arcminutes.
    pub sigma_motion_arcmin: f64,
    pub sigma_total_arcmin: f64,
}

/// The equivalent stationary problem, before it is handed to the core solver.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedRunningFix {
    /// Sights with advanced GPs and inflated sigmas, in the input order.
    pub sights: Vec<Sight>,
    /// The position the advance was linearised at.
    pub reference_estimate: Option<LatLon>,
    pub inflations: Vec<SigmaInflation>,
    /// Advance/solve passes actually run (1 unless the estimate moved).
    pub passes: u32,
    /// `false` when no reference-position estimate could be formed, in which case
    /// `sights` are the raw sights and no advance was applied.
    pub applied: bool,
    pub warnings: Vec<Warning>,
}

/// Solve a running fix at `reference_utc_jd`.
///
/// Every sight is converted to the equivalent stationary sight at that instant and the
/// result is `skyfix_core::solver::solve` on those sights, with extra `Warning::Other`
/// entries describing the conversion. The returned covariance is optimistic; see the
/// module docs.
pub fn running_fix(
    sights: &[TimedSight],
    track: &Track,
    motion_uncertainty: &MotionUncertainty,
    reference_utc_jd: f64,
    options: &SolveOptions,
) -> FixResult {
    let prepared = prepare(sights, track, motion_uncertainty, reference_utc_jd, options);
    let mut opts = options.clone();
    if let Some(estimate) = prepared.reference_estimate {
        // An initializer is never a prior (CONVENTIONS section 8): this only saves the
        // final solve from rediscovering a basin the preparation already found.
        opts.initializer = Some(estimate);
    }
    let mut result = solve(&prepared.sights, &opts);
    push_warnings(&mut result, prepared.warnings);
    result
}

/// Build the equivalent stationary problem without solving it. Exposed so a caller can
/// inspect the advanced GPs and the sigma inflation, and so tests can assert them.
pub fn prepare(
    sights: &[TimedSight],
    track: &Track,
    motion_uncertainty: &MotionUncertainty,
    reference_utc_jd: f64,
    options: &SolveOptions,
) -> PreparedRunningFix {
    let raw: Vec<Sight> = sights.iter().map(|t| t.sight.clone()).collect();
    let mut warnings = Vec::new();

    if !reference_utc_jd.is_finite() {
        warnings.push(Warning::Other {
            message: "running fix NOT applied: the reference instant is not a finite Julian \
                      date, so the sights were solved as if the observer had been stationary"
                .to_string(),
        });
        return not_applied(raw, warnings);
    }

    let Some(mut estimate) = initial_estimate(&raw, options) else {
        warnings.push(Warning::Other {
            message: "running fix NOT applied: no reference-position estimate could be formed \
                      (the raw sights did not yield a unique or ambiguous fix and no \
                      initializer was supplied), and the geographic positions cannot be \
                      advanced without one. The sights were solved as if the observer had \
                      been stationary."
                .to_string(),
        });
        return not_applied(raw, warnings);
    };

    warn_track_coverage(sights, track, reference_utc_jd, &mut warnings);

    let mut passes = 0;
    let mut built = build(
        sights,
        track,
        motion_uncertainty,
        reference_utc_jd,
        estimate,
    );
    loop {
        passes += 1;
        if passes >= MAX_PASSES {
            break;
        }
        let mut opts = options.clone();
        opts.initializer = Some(to_latlon(estimate));
        let Some(next) = position_of(&solve(&built.0, &opts)) else {
            break;
        };
        let moved_nm = rad_to_nm(angular_distance(estimate, to_point(next)));
        if moved_nm <= RELINEARISE_THRESHOLD_NM {
            break;
        }
        estimate = to_point(next);
        built = build(
            sights,
            track,
            motion_uncertainty,
            reference_utc_jd,
            estimate,
        );
    }

    let (advanced, inflations) = built;
    warnings.push(summary_warning(
        reference_utc_jd,
        estimate,
        passes,
        &inflations,
        motion_uncertainty,
    ));
    warnings.push(correlation_warning());

    PreparedRunningFix {
        sights: advanced,
        reference_estimate: Some(to_latlon(estimate)),
        inflations,
        passes,
        applied: true,
        warnings,
    }
}

/// Move `gp` by the inverse of the rigid rotation that carries `observer_from` to
/// `observer_to`. This is the "advance the GP by the negative of the run" step; see the
/// module docs for why it is a rotation and not a reuse of the (north, east) components.
pub fn advance_geographic_position(gp: Point, observer_from: Point, observer_to: Point) -> Point {
    let delta = angular_distance(observer_from, observer_to);
    if !delta.is_finite() || delta == 0.0 {
        return gp;
    }
    let a = observer_from.to_unit();
    let b = observer_to.to_unit();
    let axis = cross(a, b);
    let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return gp;
    }
    let n = [axis[0] / norm, axis[1] / norm, axis[2] / norm];
    // Rotating `observer_from` about n by +delta gives `observer_to`, so the inverse of
    // the run is a rotation by -delta.
    Point::from_unit(rotate_about(gp.to_unit(), n, -delta))
}

/// The altitude variance a run of covariance `cov_rad2` adds to a sight at azimuth
/// `zn_rad`, as a standard deviation in radians: `sqrt(row C row^T)` with
/// `row = [cos Zn, sin Zn]`.
pub fn motion_sigma_rad(cov_rad2: [[f64; 2]; 2], zn_rad: f64) -> f64 {
    let (cn, ce) = tangent_row(zn_rad);
    let v = cn * (cov_rad2[0][0] * cn + cov_rad2[0][1] * ce)
        + ce * (cov_rad2[1][0] * cn + cov_rad2[1][1] * ce);
    if v.is_finite() {
        v.max(0.0).sqrt()
    } else {
        0.0
    }
}

/// Error of the advance-the-GP model, in metres of equivalent position.
///
/// `linearised_at` is the position the rotation is built from; `truth` is where the
/// vessel really was at the reference instant. The result is
/// `|h(truth, advanced GP) - h(advance(truth), GP)|` converted at one arcminute per
/// nautical mile. It is zero to machine precision when `truth == linearised_at`.
pub fn approximation_error_m(
    gp: Point,
    track: &Track,
    reference_utc_jd: f64,
    sight_utc_jd: f64,
    linearised_at: Point,
    truth: Point,
) -> f64 {
    let est_at_sight = track.advance(linearised_at, reference_utc_jd, sight_utc_jd);
    let advanced_gp = advance_geographic_position(gp, linearised_at, est_at_sight);
    let truth_at_sight = track.advance(truth, reference_utc_jd, sight_utc_jd);
    let approximate = altitude(truth, -advanced_gp.lon, advanced_gp.lat);
    let exact = altitude(truth_at_sight, -gp.lon, gp.lat);
    rad_to_m((approximate - exact).abs())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Built = (Vec<Sight>, Vec<SigmaInflation>);

fn build(
    sights: &[TimedSight],
    track: &Track,
    motion_uncertainty: &MotionUncertainty,
    reference_utc_jd: f64,
    estimate: Point,
) -> Built {
    let mut advanced = Vec::with_capacity(sights.len());
    let mut inflations = Vec::with_capacity(sights.len());
    for timed in sights {
        let s = &timed.sight;
        if !timed.utc_jd.is_finite() {
            // An untimed sight cannot be advanced; pass it through untouched so the
            // solver's own "ignored sight" reporting stays the single place that decides.
            advanced.push(s.clone());
            continue;
        }
        let gp = geographic_position(s.gha_rad, s.dec_rad);
        let at_sight = track.advance(estimate, reference_utc_jd, timed.utc_jd);
        let moved_gp = advance_geographic_position(gp, estimate, at_sight);

        let cov =
            motion_uncertainty.displacement_covariance_rad2(track, reference_utc_jd, timed.utc_jd);
        let (_, zn) = altitude_azimuth(estimate, -moved_gp.lon, moved_gp.lat);
        let sigma_motion = motion_sigma_rad(cov, zn);
        let sigma_total = s.sigma_rad.hypot(sigma_motion);

        inflations.push(SigmaInflation {
            id: s.id.clone(),
            hours_to_reference: (reference_utc_jd - timed.utc_jd) * 24.0,
            run_nm: rad_to_nm(angular_distance(estimate, at_sight)),
            zn_deg: rad_to_deg(zn),
            sigma_sight_arcmin: rad_to_arcmin(s.sigma_rad),
            sigma_motion_arcmin: rad_to_arcmin(sigma_motion),
            sigma_total_arcmin: rad_to_arcmin(sigma_total),
        });
        advanced.push(Sight {
            id: s.id.clone(),
            body: s.body.clone(),
            gha_rad: norm_2pi(-moved_gp.lon),
            dec_rad: moved_gp.lat,
            ho_rad: s.ho_rad,
            sigma_rad: sigma_total,
            gha_rate_rad_per_s: s.gha_rate_rad_per_s,
        });
    }
    (advanced, inflations)
}

fn initial_estimate(raw: &[Sight], options: &SolveOptions) -> Option<Point> {
    if let Some(ll) = options.initializer
        && ll.lat_deg.is_finite()
        && ll.lon_deg.is_finite()
    {
        return Some(to_point(ll));
    }
    // No initializer: solve the raw sights as if stationary. That fix is wrong by the
    // size of the run, which is exactly the error the advance then removes; it is used
    // only to linearise, never as a prior and never as an answer.
    position_of(&solve(raw, options)).map(to_point)
}

fn position_of(result: &FixResult) -> Option<LatLon> {
    match result {
        FixResult::Unique { fix, .. } => Some(fix.position),
        FixResult::Ambiguous { candidates, .. } => candidates.first().map(|c| c.position),
        _ => None,
    }
}

fn not_applied(raw: Vec<Sight>, warnings: Vec<Warning>) -> PreparedRunningFix {
    PreparedRunningFix {
        sights: raw,
        reference_estimate: None,
        inflations: Vec::new(),
        passes: 0,
        applied: false,
        warnings,
    }
}

fn warn_track_coverage(
    sights: &[TimedSight],
    track: &Track,
    reference_utc_jd: f64,
    warnings: &mut Vec<Warning>,
) {
    let uncovered: Vec<String> = sights
        .iter()
        .filter(|t| t.utc_jd.is_finite() && !track.covers(t.utc_jd, reference_utc_jd))
        .map(|t| t.sight.id.clone())
        .collect();
    if !uncovered.is_empty() {
        warnings.push(Warning::Other {
            message: format!(
                "the dead-reckoning track does not cover the interval between the reference \
                 instant and {} sight(s) ({}); outside the track the vessel is treated as \
                 STATIONARY, so those sights were advanced by less than the real run",
                uncovered.len(),
                uncovered.join(", ")
            ),
        });
    }
}

fn summary_warning(
    reference_utc_jd: f64,
    estimate: Point,
    passes: u32,
    inflations: &[SigmaInflation],
    motion_uncertainty: &MotionUncertainty,
) -> Warning {
    let longest = inflations.iter().map(|i| i.run_nm).fold(0.0f64, f64::max);
    let largest = inflations
        .iter()
        .map(|i| i.sigma_motion_arcmin)
        .fold(0.0f64, f64::max);
    Warning::Other {
        message: format!(
            "RUNNING FIX at {}: {} sight(s) were converted to equivalent stationary sights by \
             advancing each geographic position along the dead-reckoning run (longest run \
             {longest:.2} NM), linearised at {:.4}, {:.4} in {passes} pass(es). The \
             dead-reckoning uncertainty (speed {:.2} kn, course {:.2} deg, random walk {:.2} \
             NM/sqrt(h), 1 sigma) is folded into the sights' sigmas, adding up to \
             {largest:.2} arcmin: the sigmas behind this fix are NOT the instrument sigmas.",
            skyfix_core::time::format_utc(reference_utc_jd),
            inflations.len(),
            estimate.lat_deg(),
            estimate.lon_deg(),
            motion_uncertainty.speed_sigma_kn,
            motion_uncertainty.course_sigma_deg,
            motion_uncertainty.random_walk_nm_per_sqrt_hour,
        ),
    }
}

fn correlation_warning() -> Warning {
    Warning::Other {
        message: "RUNNING FIX uncertainty is OPTIMISTIC: every sight's inflated sigma carries \
                  the same speed and course error, so those inflations are correlated across \
                  sights, but skyfix_core::solver::solve models sight errors as INDEPENDENT \
                  and no off-diagonal term is passed to it. Treat the reported covariance and \
                  95 % ellipse as a lower bound on the true uncertainty of a running fix."
            .to_string(),
    }
}

fn push_warnings(result: &mut FixResult, extra: Vec<Warning>) {
    let target = match result {
        FixResult::Underdetermined { warnings, .. }
        | FixResult::Ambiguous { warnings, .. }
        | FixResult::Unique { warnings, .. }
        | FixResult::Failed { warnings, .. } => warnings,
    };
    target.extend(extra);
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Rodrigues' rotation of `v` about the unit vector `axis` by `angle` radians.
fn rotate_about(v: [f64; 3], axis: [f64; 3], angle: f64) -> [f64; 3] {
    let (s, c) = angle.sin_cos();
    let k = cross(axis, v);
    let d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    [
        v[0] * c + k[0] * s + axis[0] * d * (1.0 - c),
        v[1] * c + k[1] * s + axis[1] * d * (1.0 - c),
        v[2] * c + k[2] * s + axis[2] * d * (1.0 - c),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track::Leg;
    use approx::assert_relative_eq;
    use skyfix_core::geometry::destination;
    use skyfix_core::units::{SIDEREAL_RATE_DEG_PER_HOUR, arcmin_to_rad};

    const T0: f64 = 2_461_314.5;
    const HOUR: f64 = 1.0 / 24.0;

    fn sight_at(id: &str, observer: Point, altitude_deg: f64, azimuth_deg: f64) -> Sight {
        let z = (90.0 - altitude_deg).to_radians();
        let gp = destination(observer, azimuth_deg.to_radians(), z);
        Sight {
            id: id.to_string(),
            body: "test".to_string(),
            gha_rad: norm_2pi(-gp.lon),
            dec_rad: gp.lat,
            ho_rad: altitude_deg.to_radians(),
            sigma_rad: arcmin_to_rad(1.0),
            gha_rate_rad_per_s: SIDEREAL_RATE_DEG_PER_HOUR.to_radians() / 3600.0,
        }
    }

    #[test]
    fn advancing_the_gp_is_exact_at_the_linearisation_point() {
        let track = Track::constant(T0, 45.0, 10.0);
        let reference = T0 + 3.0 * HOUR;
        let p = Point::from_deg(40.0, -70.0);
        for altitude_deg in [10.0, 35.0, 60.0, 85.0] {
            for azimuth_deg in [0.0, 47.0, 135.0, 213.0, 300.0] {
                let s = sight_at("s", p, altitude_deg, azimuth_deg);
                let gp = geographic_position(s.gha_rad, s.dec_rad);
                let err = approximation_error_m(gp, &track, reference, T0, p, p);
                assert!(err < 1e-6, "{altitude_deg}/{azimuth_deg}: {err} m");
            }
        }
    }

    #[test]
    fn naive_component_move_is_catastrophically_wrong() {
        // Reusing the run's (north, east) components at the GP ignores the convergence
        // of the meridians over the tens of degrees between observer and GP.
        let track = Track::constant(T0, 45.0, 10.0);
        let reference = T0 + 3.0 * HOUR;
        let p = Point::from_deg(40.0, -70.0);
        let s = sight_at("s", p, 50.0, 90.0);
        let gp = geographic_position(s.gha_rad, s.dec_rad);

        let (n_nm, e_nm) = track.position_offset(reference, T0);
        let naive = skyfix_core::geometry::apply_tangent_step(
            gp,
            -skyfix_core::units::nm_to_rad(n_nm),
            -skyfix_core::units::nm_to_rad(e_nm),
        );
        let exact_h = altitude(track.advance(p, reference, T0), -gp.lon, gp.lat);
        let naive_h = altitude(p, -naive.lon, naive.lat);
        let naive_err_m = rad_to_m((naive_h - exact_h).abs());
        println!(
            "reusing the run's north/east components at the GP: {naive_err_m:.0} m of \
             altitude-equivalent error on a 30 NM run at 40 N"
        );
        assert!(
            naive_err_m > 10_000.0,
            "the component shortcut should be tens of km wrong, was {naive_err_m} m"
        );

        // The rotation construction on the same case is exact.
        let rotated_err = approximation_error_m(gp, &track, reference, T0, p, p);
        assert!(rotated_err < 1e-6, "rotation construction: {rotated_err} m");
    }

    /// Metres of altitude-equivalent error per (NM of run) x (NM of estimate error) x
    /// tan(latitude). The advance is a rigid rotation built at the estimate; the true run
    /// holds a compass course, and the two directions differ by the meridian convergence
    /// `d(lambda) sin(phi) = (offset / cos phi) sin phi = offset tan(phi)`. Multiplying by
    /// the run and converting to metres gives `NM_M^2 / EARTH_RADIUS_M = 0.5388 m`.
    const CONVERGENCE_M_PER_NM2: f64 =
        skyfix_core::units::NM_M * skyfix_core::units::NM_M / skyfix_core::units::EARTH_RADIUS_M;

    #[test]
    fn approximation_error_is_the_meridian_convergence_over_the_run() {
        let reference = T0 + 3.0 * HOUR;
        let max_lat = 55.0f64;
        let max_run_nm = 30.0;
        let mut max_by_offset = Vec::new();
        for offset_nm in [0.0, 1.0, 5.0, 10.0] {
            let mut worst: f64 = 0.0;
            for lat in [25.0, 40.0, max_lat] {
                for course in [0.0, 45.0, 135.0, 225.0] {
                    for speed in [10.0 / 3.0, 10.0] {
                        // 3 h at these speeds is a 10 NM and a 30 NM run.
                        let track = Track::constant(T0, course, speed);
                        let est = Point::from_deg(lat, -70.0);
                        for altitude_deg in [15.0, 45.0, 75.0] {
                            for azimuth_deg in [0.0, 90.0, 180.0, 270.0] {
                                let s = sight_at("s", est, altitude_deg, azimuth_deg);
                                let gp = geographic_position(s.gha_rad, s.dec_rad);
                                for dir in [0.0f64, 90.0, 180.0, 270.0] {
                                    let truth = destination(
                                        est,
                                        dir.to_radians(),
                                        skyfix_core::units::nm_to_rad(offset_nm),
                                    );
                                    worst = worst.max(approximation_error_m(
                                        gp, &track, reference, T0, est, truth,
                                    ));
                                }
                            }
                        }
                    }
                }
            }
            max_by_offset.push((offset_nm, worst));
        }
        for (offset, worst) in &max_by_offset {
            let predicted =
                max_run_nm * offset * max_lat.to_radians().tan() * CONVERGENCE_M_PER_NM2;
            println!(
                "estimate offset {offset:4.1} NM -> max error {worst:8.3} m \
                 (closed form {predicted:8.3} m)"
            );
        }
        // Exact where the rotation was built.
        assert!(
            max_by_offset[0].1 < 1e-6,
            "not exact at the linearisation point: {} m",
            max_by_offset[0].1
        );
        // Everywhere else the error is the closed form above, to better than 5 %. This is
        // the number docs/MOTION.md quotes; the bound is a formula, not a magic constant.
        for (offset, worst) in max_by_offset.iter().skip(1) {
            let predicted =
                max_run_nm * offset * max_lat.to_radians().tan() * CONVERGENCE_M_PER_NM2;
            assert!(
                (worst - predicted).abs() < 0.05 * predicted,
                "offset {offset} NM: measured {worst} m, closed form {predicted} m"
            );
        }
        // 30 NM of run and 1 NM of estimate error at 55 N is under 24 m.
        assert!(max_by_offset[1].1 < 24.0, "1 NM: {} m", max_by_offset[1].1);
        assert!(max_by_offset[3].1 > max_by_offset[1].1);
    }

    #[test]
    fn sigma_inflation_matches_the_documented_projection() {
        let track = Track::constant(T0, 45.0, 10.0);
        let mu = MotionUncertainty::new(0.5, 2.0, 0.0);
        let cov = mu.displacement_covariance_rad2(&track, T0, T0 + 3.0 * HOUR);

        // Along track (Zn = 045): sigma_v * T = 1.5 NM.
        let along = rad_to_nm(motion_sigma_rad(cov, 45f64.to_radians()));
        assert_relative_eq!(along, 1.5, epsilon = 1e-6);
        // Cross track (Zn = 135): d * sigma_c = 30 * 2 deg = 1.047198 NM.
        let cross_nm = rad_to_nm(motion_sigma_rad(cov, 135f64.to_radians()));
        assert_relative_eq!(cross_nm, 30.0 * 2f64.to_radians(), epsilon = 1e-6);
        // Due north: sqrt((along^2 + cross^2) / 2).
        let north = rad_to_nm(motion_sigma_rad(cov, 0.0));
        assert_relative_eq!(north, 1.293_565_757_3, epsilon = 1e-6);
        // A sight at the reference instant is not inflated at all.
        let zero = mu.displacement_covariance_rad2(&track, T0 + 3.0 * HOUR, T0 + 3.0 * HOUR);
        assert_eq!(motion_sigma_rad(zero, 1.0), 0.0);
    }

    #[test]
    fn prepare_advances_every_sight_and_reports_the_inflation() {
        let reference = T0 + 3.0 * HOUR;
        let truth = Point::from_deg(40.0, -70.0);
        let track = Track::constant(T0, 45.0, 10.0);
        let timed: Vec<TimedSight> = [(T0, 0.0), (T0 + 1.5 * HOUR, 120.0), (reference, 240.0)]
            .iter()
            .enumerate()
            .map(|(i, &(t, az))| {
                let at = track.advance(truth, reference, t);
                TimedSight::new(sight_at(&format!("s{i}"), at, 45.0, az), t)
            })
            .collect();

        let options = SolveOptions {
            initializer: Some(to_latlon(truth)),
            ..Default::default()
        };
        let mu = MotionUncertainty::new(0.5, 2.0, 0.0);
        let prep = prepare(&timed, &track, &mu, reference, &options);
        assert!(prep.applied);
        assert_eq!(prep.inflations.len(), 3);
        // Runs of 30, 15 and 0 NM.
        assert_relative_eq!(prep.inflations[0].run_nm, 30.0, epsilon = 1e-5);
        assert_relative_eq!(prep.inflations[1].run_nm, 15.0, epsilon = 1e-5);
        assert_relative_eq!(prep.inflations[2].run_nm, 0.0, epsilon = 1e-9);
        // The last sight is at the reference instant: sigma untouched.
        assert_relative_eq!(prep.inflations[2].sigma_motion_arcmin, 0.0, epsilon = 1e-12);
        assert_relative_eq!(prep.inflations[2].sigma_total_arcmin, 1.0, epsilon = 1e-12);
        // The earlier sights are inflated.
        assert!(prep.inflations[0].sigma_total_arcmin > 1.0);
        assert!(prep.inflations[1].sigma_total_arcmin > 1.0);
        // Advancing reproduces the exact altitude at the truth position.
        for (advanced, original) in prep.sights.iter().zip(timed.iter()) {
            let h = altitude(truth, advanced.gha_rad, advanced.dec_rad);
            assert_relative_eq!(h, original.sight.ho_rad, epsilon = 1e-12);
        }
        // Both mandatory warnings are present.
        let text: String = prep
            .warnings
            .iter()
            .map(|w| format!("{w:?}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("RUNNING FIX at"));
        assert!(text.contains("OPTIMISTIC"));
        assert!(text.contains("INDEPENDENT"));
    }

    #[test]
    fn a_sight_outside_the_track_is_flagged() {
        let reference = T0 + 3.0 * HOUR;
        let truth = Point::from_deg(40.0, -70.0);
        // The track only begins an hour after the first sight.
        let track = Track::new(vec![Leg::new(T0 + 1.0 * HOUR, 45.0, 10.0)]);
        let timed = vec![
            TimedSight::new(sight_at("early", truth, 45.0, 0.0), T0),
            TimedSight::new(sight_at("late", truth, 45.0, 120.0), reference),
        ];
        let options = SolveOptions {
            initializer: Some(to_latlon(truth)),
            ..Default::default()
        };
        let prep = prepare(
            &timed,
            &track,
            &MotionUncertainty::new(0.5, 2.0, 0.0),
            reference,
            &options,
        );
        let text: String = prep
            .warnings
            .iter()
            .map(|w| format!("{w:?}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("does not cover"), "{text}");
        assert!(text.contains("early"), "{text}");
    }

    #[test]
    fn a_non_finite_reference_instant_falls_back_and_says_so() {
        let truth = Point::from_deg(40.0, -70.0);
        let track = Track::constant(T0, 45.0, 10.0);
        let timed = vec![TimedSight::new(sight_at("a", truth, 45.0, 0.0), T0)];
        let prep = prepare(
            &timed,
            &track,
            &MotionUncertainty::default(),
            f64::NAN,
            &SolveOptions::default(),
        );
        assert!(!prep.applied);
        assert_eq!(prep.sights.len(), 1);
        assert!(prep.reference_estimate.is_none());
        let text = format!("{:?}", prep.warnings);
        assert!(text.contains("running fix NOT applied"), "{text}");
    }
}
