//! The six packaged scenarios (a)-(f), with fixed seeds.
//!
//! `docs/MOTION.md` section "Results" carries the numbers these produce. Every scenario
//! builds its own synthetic sky: a body at a chosen altitude and azimuth from a chosen
//! observer fixes the geographic position exactly, so no ephemeris is needed and the
//! truth is exact by construction.
//!
//! # What these scenarios do and do not prove
//!
//! They exercise this crate against `skyfix_core::geometry` and
//! `skyfix_core::solver::solve`. The simulator and the solver share the same altitude
//! formula, so a round trip shows the two are **consistent**, not that either is
//! **correct** — the independent Skyfield fixtures in `fixtures/reference/` establish
//! that. What these scenarios do establish is the motion modelling on top: that a
//! stationary solve on sights taken under way is wrong by the size of the run, that the
//! running fix removes that error, that the disagreement statistic fires when it should,
//! and — scenario (d) — that it fires identically for a cause it cannot see.
//!
//! Truth lives in the `*Truth` structs and is never passed to the solver as a prior. It
//! reaches `SolveOptions::initializer` only where a real navigator would have a dead
//! reckoning position to start from, which is what an initializer is for (CONVENTIONS
//! section 8: an initializer is never a prior).

use crate::compare::{
    AbsoluteHeading, AbsolutePosition, Disagreement, HeadingDisagreement, RelativeDisplacement,
    ScaleAnchor, ScaleError, ScaleEstimate, disagreement, heading_disagreement, integrate_odometry,
    integrate_odometry_with_anchor,
};
use crate::rng::Rng;
use crate::running_fix::{TimedSight, prepare, running_fix};
use crate::track::{MotionUncertainty, Track};
use crate::{to_latlon, to_point};
use skyfix_core::geometry::{Point, altitude, angular_distance, apply_tangent_step, destination};
use skyfix_core::solver::solve;
use skyfix_core::types::{FixResult, LatLon, MultistartOptions, Sight, SolveOptions, Warning};
use skyfix_core::units::{
    NM_M, SIDEREAL_RATE_DEG_PER_HOUR, arcmin_to_rad, m_to_rad, nm_to_rad, norm_2pi, rad_to_arcmin,
    rad_to_m, rad_to_nm,
};

/// 2026-10-01T00:00:00Z.
pub const EPOCH_JD: f64 = 2_461_314.5;
/// One hour as a fraction of a Julian day.
pub const HOUR_JD: f64 = 1.0 / 24.0;
/// Truth position for the under-way scenarios: 40 N 70 W, offshore of Philadelphia.
pub const TRUTH: LatLon = LatLon {
    lat_deg: 40.0,
    lon_deg: -70.0,
};
/// Sidereal GHA rate in radians per second (CONVENTIONS section 6).
pub fn sidereal_rate_rad_per_s() -> f64 {
    SIDEREAL_RATE_DEG_PER_HOUR.to_radians() / 3600.0
}

/// A star sight synthesised from a truth observer, altitude and azimuth. The geographic
/// position is the point at zenith distance `90 - altitude` on that bearing, which makes
/// the sight exact by construction with no ephemeris involved.
pub fn synthetic_sight(
    id: &str,
    body: &str,
    observer: Point,
    altitude_deg: f64,
    azimuth_deg: f64,
    sigma_arcmin: f64,
) -> Sight {
    let gp = destination(
        observer,
        azimuth_deg.to_radians(),
        (90.0 - altitude_deg).to_radians(),
    );
    Sight {
        id: id.to_string(),
        body: body.to_string(),
        gha_rad: norm_2pi(-gp.lon),
        dec_rad: gp.lat,
        ho_rad: altitude_deg.to_radians(),
        sigma_rad: arcmin_to_rad(sigma_arcmin),
        gha_rate_rad_per_s: sidereal_rate_rad_per_s(),
    }
}

/// Shift a sight's GHA as a clock error of `seconds` would: every star's GHA grows at the
/// sidereal rate, so a chronometer fast by `dt` makes every recorded GHA too large by
/// `omega dt` (CONVENTIONS section 6).
pub fn with_clock_error(sight: &Sight, seconds: f64) -> Sight {
    let mut s = sight.clone();
    s.gha_rad = norm_2pi(s.gha_rad + sidereal_rate_rad_per_s() * seconds);
    s
}

fn fix_of(result: &FixResult) -> Option<(LatLon, [[f64; 2]; 2])> {
    match result {
        FixResult::Unique { fix, .. } => Some((fix.position, fix.covariance_ne_m2)),
        _ => None,
    }
}

fn residual_rms_arcmin(result: &FixResult) -> f64 {
    match result {
        FixResult::Unique { fix, .. } => {
            if fix.residuals.is_empty() {
                return 0.0;
            }
            let sum: f64 = fix
                .residuals
                .iter()
                .map(|r| r.residual_arcmin * r.residual_arcmin)
                .sum();
            (sum / fix.residuals.len() as f64).sqrt()
        }
        _ => f64::NAN,
    }
}

/// Mahalanobis distance of `estimate` from `truth` under `covariance` (metres^2, N/E).
pub fn mahalanobis_from_truth(
    estimate: LatLon,
    covariance_ne_m2: [[f64; 2]; 2],
    truth: LatLon,
) -> f64 {
    let a = AbsolutePosition::new(0.0, estimate, covariance_ne_m2, "estimate");
    let b = AbsolutePosition::new(0.0, truth, [[0.0, 0.0], [0.0, 0.0]], "truth");
    disagreement(&a, &b).mahalanobis
}

/// Solver options a navigator under way really has: a DR position to start from, no
/// global grid (the DR is good to a few miles), nothing that acts as a prior.
fn under_way_options(dr: LatLon) -> SolveOptions {
    SolveOptions {
        initializer: Some(dr),
        multistart: MultistartOptions {
            enabled: false,
            ..Default::default()
        },
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// (a) Three star sights taken under way
// ---------------------------------------------------------------------------

/// Everything scenario (a) generated, truth kept separate from what the solver saw.
#[derive(Debug, Clone)]
pub struct UnderWayScenario {
    /// The vessel's true position at the reference instant.
    pub truth: LatLon,
    /// What the navigator believes: 10 kn on 045.
    pub dr_track: Track,
    /// What the vessel actually did.
    pub true_track: Track,
    pub reference_utc_jd: f64,
    pub sights: Vec<TimedSight>,
    pub motion_uncertainty: MotionUncertainty,
    /// The DR position the navigator would start the solve from.
    pub dr_position: LatLon,
}

/// Build scenario (a): a vessel making 10 knots on course 045 takes three star sights at
/// T-3 h, T-1.5 h and T, from three well-spread azimuths.
///
/// With `perturb_track = true` the vessel's *true* speed and course are drawn from the
/// modelled 1-sigma values, so the navigator's dead reckoning is wrong by exactly as much
/// as the model says it might be. With `noise = true` each altitude carries independent
/// 1-arcminute noise.
pub fn under_way(seed: u64, perturb_track: bool, noise: bool) -> UnderWayScenario {
    let mut rng = Rng::new(seed);
    let reference = EPOCH_JD + 3.0 * HOUR_JD;
    let motion = MotionUncertainty::new(0.5, 2.0, 0.0);

    let dr_track = Track::constant(EPOCH_JD, 45.0, 10.0);
    let true_track = if perturb_track {
        Track::constant(
            EPOCH_JD,
            rng.normal_with(45.0, motion.course_sigma_deg),
            rng.normal_with(10.0, motion.speed_sigma_kn),
        )
    } else {
        dr_track.clone()
    };

    let truth_point = to_point(TRUTH);
    // Azimuths 120 degrees apart: no common translation can absorb the run.
    let plan = [
        (EPOCH_JD, 42.0, 45.0, "Alkaid"),
        (EPOCH_JD + 1.5 * HOUR_JD, 38.0, 165.0, "Altair"),
        (reference, 55.0, 285.0, "Arcturus"),
    ];
    let mut sights = Vec::new();
    for (i, &(t, alt, az, body)) in plan.iter().enumerate() {
        let at = true_track.advance(truth_point, reference, t);
        let mut s = synthetic_sight(&format!("s{i}"), body, at, alt, az, 1.0);
        if noise {
            s.ho_rad += arcmin_to_rad(rng.normal());
        }
        sights.push(TimedSight::new(s, t));
    }

    // The navigator's DR position at the reference instant, started from the truth at the
    // first sight: a real DR is anchored on the last known fix, not on the answer.
    let dr_position = to_latlon(dr_track.advance(
        true_track.advance(truth_point, reference, EPOCH_JD),
        EPOCH_JD,
        reference,
    ));

    UnderWayScenario {
        truth: TRUTH,
        dr_track,
        true_track,
        reference_utc_jd: reference,
        sights,
        motion_uncertainty: motion,
        dr_position,
    }
}

/// What scenario (a) produced.
#[derive(Debug, Clone)]
pub struct UnderWayResult {
    /// Solving the raw sights as if the observer had been stationary.
    pub stationary: FixResult,
    pub stationary_residual_rms_arcmin: f64,
    pub stationary_error_nm: f64,
    /// The running fix at the reference instant.
    pub running: FixResult,
    pub running_error_m: f64,
    pub running_mahalanobis: f64,
    /// Largest sigma the dead reckoning added to any sight, arcminutes.
    pub largest_sigma_inflation_arcmin: f64,
}

pub fn run_under_way(scenario: &UnderWayScenario) -> UnderWayResult {
    let options = under_way_options(scenario.dr_position);
    let raw: Vec<Sight> = scenario.sights.iter().map(|t| t.sight.clone()).collect();
    let stationary = solve(&raw, &options);
    let stationary_error_nm = fix_of(&stationary).map_or(f64::NAN, |(p, _)| {
        rad_to_nm(angular_distance(to_point(p), to_point(scenario.truth)))
    });

    let running = running_fix(
        &scenario.sights,
        &scenario.dr_track,
        &scenario.motion_uncertainty,
        scenario.reference_utc_jd,
        &options,
    );
    let (running_error_m, running_mahalanobis) = match fix_of(&running) {
        Some((p, cov)) => (
            rad_to_m(angular_distance(to_point(p), to_point(scenario.truth))),
            mahalanobis_from_truth(p, cov, scenario.truth),
        ),
        None => (f64::NAN, f64::NAN),
    };

    let prepared = prepare(
        &scenario.sights,
        &scenario.dr_track,
        &scenario.motion_uncertainty,
        scenario.reference_utc_jd,
        &options,
    );
    let largest_sigma_inflation_arcmin = prepared
        .inflations
        .iter()
        .map(|i| i.sigma_motion_arcmin)
        .fold(0.0f64, f64::max);

    UnderWayResult {
        stationary_residual_rms_arcmin: residual_rms_arcmin(&stationary),
        stationary,
        stationary_error_nm,
        running,
        running_error_m,
        running_mahalanobis,
        largest_sigma_inflation_arcmin,
    }
}

/// Fraction of `reps` seeded repetitions whose running fix lands inside its own nominal
/// 95 % ellipse (Mahalanobis <= sqrt(5.991)).
///
/// This is the number that shows the warning is not decorative: because the solver treats
/// the inflated sigmas as independent while the same speed and course bias drives all of
/// them, coverage comes out **below** 95 %.
pub fn running_fix_coverage(reps: u32, first_seed: u64) -> (f64, f64) {
    let limit = skyfix_core::units::CHI2_95_2DOF.sqrt();
    let mut inside = 0u32;
    let mut sum = 0.0;
    let mut counted = 0u32;
    for i in 0..reps {
        let scenario = under_way(first_seed + u64::from(i), true, true);
        let result = run_under_way(&scenario);
        if result.running_mahalanobis.is_finite() {
            counted += 1;
            sum += result.running_mahalanobis;
            if result.running_mahalanobis <= limit {
                inside += 1;
            }
        }
    }
    if counted == 0 {
        return (f64::NAN, f64::NAN);
    }
    (
        f64::from(inside) / f64::from(counted),
        sum / f64::from(counted),
    )
}

// ---------------------------------------------------------------------------
// (b) What the motion uncertainty does to the sigmas
// ---------------------------------------------------------------------------

/// One sight's sigma before and after the dead reckoning is folded in.
#[derive(Debug, Clone, PartialEq)]
pub struct InflationRow {
    pub label: String,
    pub run_nm: f64,
    pub zn_deg: f64,
    pub sigma_sight_arcmin: f64,
    pub sigma_motion_arcmin: f64,
    pub sigma_total_arcmin: f64,
}

/// Scenario (b): a 3-hour 10-knot run on 045 with speed sigma 0.5 kn and course sigma
/// 2 deg, projected onto four representative azimuths.
pub fn sigma_inflation_table() -> Vec<InflationRow> {
    let track = Track::constant(EPOCH_JD, 45.0, 10.0);
    let motion = MotionUncertainty::new(0.5, 2.0, 0.0);
    let reference = EPOCH_JD + 3.0 * HOUR_JD;
    let cov = motion.displacement_covariance_rad2(&track, EPOCH_JD, reference);
    let run_nm = 30.0;
    [
        ("along track (Zn 045)", 45.0f64),
        ("cross track (Zn 135)", 135.0),
        ("due north (Zn 000)", 0.0),
        ("astern (Zn 225)", 225.0),
    ]
    .iter()
    .map(|&(label, zn_deg)| {
        let sigma_motion = crate::running_fix::motion_sigma_rad(cov, zn_deg.to_radians());
        let sigma_sight = arcmin_to_rad(1.0);
        InflationRow {
            label: label.to_string(),
            run_nm,
            zn_deg,
            sigma_sight_arcmin: rad_to_arcmin(sigma_sight),
            sigma_motion_arcmin: rad_to_arcmin(sigma_motion),
            sigma_total_arcmin: rad_to_arcmin(sigma_sight.hypot(sigma_motion)),
        }
    })
    .collect()
}

// ---------------------------------------------------------------------------
// (c) and (d): two causes, one statement
// ---------------------------------------------------------------------------

/// Scenario (c): a celestial fix and a GNSS position 2 NM apart.
///
/// The celestial fix carries a 0.5 NM isotropic sigma and the GNSS 9 m, so the separation
/// is four combined sigmas.
pub fn gnss_offset_scenario() -> (AbsolutePosition, AbsolutePosition, Disagreement) {
    let t = EPOCH_JD + 3.0 * HOUR_JD;
    let celestial = AbsolutePosition::isotropic(t, TRUTH, 0.5 * NM_M, "celestial fix");
    let displaced = to_latlon(apply_tangent_step(to_point(TRUTH), nm_to_rad(2.0), 0.0));
    let gnss = AbsolutePosition::isotropic(t, displaced, 9.0, "GNSS receiver");
    let d = disagreement(&celestial, &gnss);
    (celestial, gnss, d)
}

/// What scenario (d) produced.
#[derive(Debug, Clone)]
pub struct ClockErrorResult {
    pub celestial: AbsolutePosition,
    pub gnss: AbsolutePosition,
    pub disagreement: Disagreement,
    /// `cos(lat) * omega * dt` converted to metres: what the degeneracy predicts.
    pub predicted_separation_m: f64,
    pub clock_error_s: f64,
}

/// Scenario (d): the celestial side's chronometer is 30 seconds fast; the GNSS is right.
///
/// For a star-only session a clock offset is *exactly* a longitude offset (CONVENTIONS
/// section 6), so the fix slides `omega dt` of longitude west with **zero residuals** —
/// nothing in the sights themselves reveals it. The resulting disagreement statement is
/// identical in form to scenario (c)'s. That is the point.
pub fn clock_error_scenario(clock_error_s: f64) -> ClockErrorResult {
    let t = EPOCH_JD + 3.0 * HOUR_JD;
    let truth_point = to_point(TRUTH);
    let raw: Vec<Sight> = [(42.0, 45.0), (38.0, 165.0), (55.0, 285.0)]
        .iter()
        .enumerate()
        .map(|(i, &(alt, az))| {
            let s = synthetic_sight(&format!("s{i}"), "star", truth_point, alt, az, 1.0);
            with_clock_error(&s, clock_error_s)
        })
        .collect();
    let result = solve(&raw, &under_way_options(TRUTH));
    let (position, covariance) =
        fix_of(&result).unwrap_or((TRUTH, [[f64::NAN, 0.0], [0.0, f64::NAN]]));

    // Use the same sigma the GNSS-offset scenario uses, so the two statements differ only
    // in their numbers.
    let celestial = AbsolutePosition::isotropic(t, position, 0.5 * NM_M, "celestial fix");
    let gnss = AbsolutePosition::isotropic(t, TRUTH, 9.0, "GNSS receiver");
    let _ = covariance;

    let omega_deg = SIDEREAL_RATE_DEG_PER_HOUR * clock_error_s / 3600.0;
    let predicted_separation_m = TRUTH.lat_deg.to_radians().cos() * omega_deg * 60.0 * NM_M;

    ClockErrorResult {
        disagreement: disagreement(&celestial, &gnss),
        celestial,
        gnss,
        predicted_separation_m,
        clock_error_s,
    }
}

/// Replace every run of digits with `#`, so two statements can be compared for *form*
/// rather than content. Scenarios (c) and (d) must produce identical skeletons.
pub fn statement_skeleton(statement: &str) -> String {
    let mut out = String::with_capacity(statement.len());
    let mut in_number = false;
    for ch in statement.chars() {
        if ch.is_ascii_digit() || (in_number && (ch == '.' || ch == '-' || ch == '+')) {
            if !in_number {
                out.push('#');
                in_number = true;
            }
        } else {
            in_number = false;
            out.push(ch);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// (e) Monocular odometry
// ---------------------------------------------------------------------------

/// What scenario (e) generated.
#[derive(Debug, Clone)]
pub struct OdometryScenario {
    pub start: AbsolutePosition,
    pub legs: Vec<RelativeDisplacement>,
    pub anchor: ScaleAnchor,
    /// The scale the legs were generated with, metres per sensor unit.
    pub true_scale: f64,
}

/// Scenario (e): five monocular optic-flow legs with an unknown scale, and a GNSS anchor
/// pair bracketing them.
///
/// `anchor_noise = true` perturbs the anchor's end position by its own 1-sigma, so the
/// recovered scale is a genuine estimate rather than an arithmetic identity.
pub fn monocular_odometry(seed: u64, anchor_noise: bool) -> OdometryScenario {
    let mut rng = Rng::new(seed);
    let true_scale = 37.5;
    let anchor_sigma_m = 5.0;
    let leg_sigma_units = 0.02;

    let start = AbsolutePosition::isotropic(EPOCH_JD, TRUTH, anchor_sigma_m, "GNSS receiver");
    // A track that goes somewhere: the anchor can only measure the scale of the net
    // displacement, so a closed loop would carry no information (and is refused).
    let steps = [(2.0, 0.5), (1.5, 1.0), (1.0, 1.5), (0.5, 2.0), (1.0, 1.0)];
    let mut legs = Vec::new();
    let (mut sum_n, mut sum_e) = (0.0, 0.0);
    for (i, &(n, e)) in steps.iter().enumerate() {
        sum_n += n;
        sum_e += e;
        legs.push(RelativeDisplacement::unscaled(
            EPOCH_JD + f64::from(i as u32) * HOUR_JD,
            EPOCH_JD + f64::from(i as u32 + 1) * HOUR_JD,
            n,
            e,
            [
                [leg_sigma_units * leg_sigma_units, 0.0],
                [0.0, leg_sigma_units * leg_sigma_units],
            ],
            // The pipeline's working guess, deliberately 20 % off. It is provenance, not
            // a measurement, and nothing in this crate promotes it to a scale.
            30.0,
            10.0,
            "monocular optic flow",
        ));
    }

    let mut end = apply_tangent_step(
        to_point(TRUTH),
        m_to_rad(true_scale * sum_n),
        m_to_rad(true_scale * sum_e),
    );
    if anchor_noise {
        end = apply_tangent_step(
            end,
            m_to_rad(rng.normal_with(0.0, anchor_sigma_m)),
            m_to_rad(rng.normal_with(0.0, anchor_sigma_m)),
        );
    }
    let anchor = ScaleAnchor::new(
        start.clone(),
        AbsolutePosition::isotropic(
            EPOCH_JD + 5.0 * HOUR_JD,
            to_latlon(end),
            anchor_sigma_m,
            "GNSS receiver",
        ),
    );

    OdometryScenario {
        start,
        legs,
        anchor,
        true_scale,
    }
}

/// What scenario (e) produced.
#[derive(Debug, Clone)]
pub struct OdometryResult {
    /// Always an error: there is no metric scale without a scale source.
    pub without_anchor: ScaleError,
    pub with_anchor: ScaleEstimate,
    pub scale_error: f64,
    /// `|scale - true_scale| / sigma`.
    pub scale_error_sigmas: f64,
    pub end_position: AbsolutePosition,
    pub note: String,
}

pub fn run_monocular_odometry(scenario: &OdometryScenario) -> OdometryResult {
    let without_anchor = integrate_odometry(&scenario.start, &scenario.legs)
        .expect_err("unknown-scale legs must not integrate");
    let integration =
        integrate_odometry_with_anchor(&scenario.start, &scenario.legs, &scenario.anchor)
            .expect("an anchor pair is a scale source");
    let estimate = integration
        .scale
        .clone()
        .expect("a scale must be reported when one was estimated");
    let scale_error = estimate.scale - scenario.true_scale;
    OdometryResult {
        scale_error_sigmas: if estimate.sigma > 0.0 {
            scale_error.abs() / estimate.sigma
        } else {
            f64::INFINITY
        },
        scale_error,
        with_anchor: estimate,
        without_anchor,
        end_position: integration.position,
        note: integration.note,
    }
}

// ---------------------------------------------------------------------------
// (f) Heading across the wrap
// ---------------------------------------------------------------------------

/// Scenario (f): a gyro reading 359.2 against a celestial azimuth of 1.4, and the same
/// pair written in other representatives of the same angles.
pub fn heading_wrap_scenario() -> Vec<(AbsoluteHeading, AbsoluteHeading, HeadingDisagreement)> {
    let t = EPOCH_JD + 3.0 * HOUR_JD;
    [
        (359.2, 1.4, 1.0, 0.8),
        (719.2, -358.6, 1.0, 0.8),
        (10.0, 190.0, 1.0, 0.8),
        (0.0, 3.5, 0.5, 0.5),
    ]
    .iter()
    .map(|&(a_deg, b_deg, a_sigma, b_sigma)| {
        let a = AbsoluteHeading::new(t, a_deg, a_sigma, "gyro compass");
        let b = AbsoluteHeading::new(t, b_deg, b_sigma, "celestial azimuth");
        let d = heading_disagreement(&a, &b);
        (a, b, d)
    })
    .collect()
}

// ---------------------------------------------------------------------------
// Warning inspection, used by tests and by any caller that wants the caveats
// ---------------------------------------------------------------------------

/// Every warning on a result, flattened to one string.
pub fn warnings_text(result: &FixResult) -> String {
    let warnings: &[Warning] = match result {
        FixResult::Underdetermined { warnings, .. }
        | FixResult::Ambiguous { warnings, .. }
        | FixResult::Unique { warnings, .. }
        | FixResult::Failed { warnings, .. } => warnings,
    };
    warnings
        .iter()
        .map(|w| match w {
            Warning::Other { message } => message.clone(),
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Altitude of a body at a point, for tests that need the exact model.
pub fn altitude_at(observer: Point, sight: &Sight) -> f64 {
    altitude(observer, sight.gha_rad, sight.dec_rad)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn synthetic_sights_are_exact_by_construction() {
        let p = Point::from_deg(40.0, -70.0);
        for alt in [5.0, 30.0, 60.0, 88.0] {
            for az in [0.0, 73.0, 180.0, 299.0] {
                let s = synthetic_sight("x", "star", p, alt, az, 1.0);
                assert_relative_eq!(altitude_at(p, &s).to_degrees(), alt, epsilon = 1e-9);
            }
        }
    }

    #[test]
    fn a_clock_error_shifts_gha_at_the_sidereal_rate() {
        let p = Point::from_deg(40.0, -70.0);
        let s = synthetic_sight("x", "star", p, 45.0, 90.0, 1.0);
        let shifted = with_clock_error(&s, 3600.0);
        let delta = (shifted.gha_rad - s.gha_rad).to_degrees();
        assert_relative_eq!(delta, SIDEREAL_RATE_DEG_PER_HOUR, epsilon = 1e-9);
    }

    #[test]
    fn statement_skeletons_erase_numbers_but_not_words() {
        assert_eq!(
            statement_skeleton("disagree by 3704.0 m, 4.00 times"),
            "disagree by # m, # times"
        );
        // A digit run and the separators inside it collapse to a single `#`, so a whole
        // date field becomes one token. That is what makes two statements comparable by
        // form alone.
        assert_eq!(statement_skeleton("2026-10-01T03:00:00.000Z"), "#T#:#:#Z");
        assert_eq!(statement_skeleton("no numbers here"), "no numbers here");
    }
}
