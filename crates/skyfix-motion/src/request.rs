//! The running fix as a request: a session of sights, the dead-reckoning legs, their
//! uncertainty and the solver options in; the fix and its workings out.
//!
//! This is the whole of what `skyfix running-fix` (the command line) and the WASM export
//! `running_fix` (docs/EXPLORER_API.md, "running_fix") do between parsing their input and
//! printing the result, so the two can never disagree. It moved here from
//! `skyfix-wasm::nav`, which now re-exports these types unchanged; the wire shapes are
//! the ones EXPLORER_API.md documents.
//!
//! [`running_fix_session`] reduces the session (CONVENTIONS sections 4-5), builds the
//! [`Track`] from the request's legs and the [`MotionUncertainty`] from its three sigmas,
//! and hands everything to [`crate::running_fix::running_fix_report`]; `docs/MOTION.md`
//! is normative for what happens there. A sight the reducer rejects becomes a warning on
//! the result, never a silent drop, and unstated motion sigmas are said to be unstated
//! rather than guessed.

use serde::{Deserialize, Serialize};
use skyfix_core::reduce::{DirectionSource, reduce_session_partitioned, to_sights};
use skyfix_core::time::{format_utc, parse_utc};
use skyfix_core::types::{FixResult, LatLon, ReducedSight, Session, SolveOptions, Warning};

use crate::running_fix::{TimedSight, running_fix_report};
use crate::track::{Leg, MotionUncertainty, Track};

/// The running fix's request: the dead-reckoning track, its uncertainty, the instant,
/// and the solver options. Every field defaults except `legs`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RunningFixRequest {
    /// The instant the fix is for, RFC 3339 UTC. Default: the last sight (after the
    /// session's chronometer correction).
    pub reference_utc: Option<String>,
    /// Constant course-and-speed legs, in time order. The first leg's `start_utc` may be
    /// left out: it then starts at the earliest sight (or the reference, if earlier).
    pub legs: Vec<RunningFixLeg>,
    /// When the track stops; after it the vessel is treated as stationary.
    pub end_utc: Option<String>,
    /// 1-sigma dead-reckoning errors. All zero (the default) means "not stated", and
    /// the result says so rather than inventing values (docs/MOTION.md section 1).
    pub motion_uncertainty: MotionUncertaintyInput,
    /// Solver options, exactly as `solve` takes them. [`running_fix_session`] uses them
    /// as given: the caller fills in the session's assumed position and clock
    /// uncertainty first, by the same rules it uses for a stationary fix.
    pub options: SolveOptions,
}

/// One dead-reckoning leg (docs/MOTION.md section 1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunningFixLeg {
    #[serde(default)]
    pub start_utc: Option<String>,
    /// Course over the ground, degrees true.
    pub course_deg: f64,
    /// Speed over the ground, knots.
    pub speed_kn: f64,
}

/// [`MotionUncertainty`] with every field defaulting to zero.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MotionUncertaintyInput {
    pub speed_sigma_kn: f64,
    pub course_sigma_deg: f64,
    pub random_walk_nm_per_sqrt_hour: f64,
}

impl MotionUncertaintyInput {
    /// The model's uncertainty, refusing a negative or non-finite sigma.
    pub fn to_motion(self) -> Result<MotionUncertainty, String> {
        for (name, v) in [
            ("speed_sigma_kn", self.speed_sigma_kn),
            ("course_sigma_deg", self.course_sigma_deg),
            (
                "random_walk_nm_per_sqrt_hour",
                self.random_walk_nm_per_sqrt_hour,
            ),
        ] {
            if !v.is_finite() || v < 0.0 {
                return Err(format!(
                    "motion_uncertainty.{name} must be finite and >= 0 (got {v})"
                ));
            }
        }
        Ok(MotionUncertainty::new(
            self.speed_sigma_kn,
            self.course_sigma_deg,
            self.random_walk_nm_per_sqrt_hour,
        ))
    }
}

/// What the dead reckoning did to one sight's sigma
/// ([`crate::running_fix::SigmaInflation`], in wire form).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SigmaInflationReport {
    pub id: String,
    /// Hours from the sight to the reference instant, `reference - sight`: positive when
    /// the sight was taken first, negative when it was taken after the reference.
    pub hours_to_reference: f64,
    pub run_nm: f64,
    pub zn_deg: f64,
    pub sigma_sight_arcmin: f64,
    pub sigma_motion_arcmin: f64,
    pub sigma_total_arcmin: f64,
}

/// The running fix's result: the fix itself (the same `FixResult` `solve` returns) and
/// the workings of the advance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunningFixOutput {
    pub result: FixResult,
    pub reference_utc: String,
    pub reference_jd_utc: f64,
    /// `false` when no reference-position estimate could be formed and the sights were
    /// solved as if the vessel had been stationary (the result's warnings say so).
    pub applied: bool,
    pub passes: u32,
    /// Where the advance was linearised.
    pub reference_estimate: Option<LatLon>,
    pub inflations: Vec<SigmaInflationReport>,
    /// Every sight through the correction chain, with its workings.
    pub sights: Vec<ReducedSight>,
}

/// Reduce `session`, advance its sights along the request's dead-reckoning track to the
/// reference instant, and solve (docs/MOTION.md; EXPLORER_API.md "running_fix").
///
/// `request.options` are used exactly as given; see [`RunningFixRequest::options`].
/// Errors are plain sentences: no observation survived the reduction, a malformed
/// instant, no legs, a leg after the first without a start, or a negative sigma.
pub fn running_fix_session(
    session: &Session,
    request: &RunningFixRequest,
    source: &dyn DirectionSource,
) -> Result<RunningFixOutput, String> {
    let (reduced, rejected) = reduce_session_partitioned(session, source);
    if reduced.is_empty() {
        return Err(if rejected.is_empty() {
            "a running fix needs at least one observation".to_string()
        } else {
            format!(
                "every observation was rejected before the running fix: {}",
                rejected
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        });
    }

    let timed: Vec<TimedSight> = to_sights(&reduced, source)
        .into_iter()
        .zip(&reduced)
        .map(|(s, r)| TimedSight::new(s, r.jd_utc))
        .collect();
    let last = reduced
        .iter()
        .map(|r| r.jd_utc)
        .fold(f64::NEG_INFINITY, f64::max);
    let first = reduced
        .iter()
        .map(|r| r.jd_utc)
        .fold(f64::INFINITY, f64::min);
    let reference = match &request.reference_utc {
        Some(u) => parse_utc(u).map_err(|e| format!("reference_utc: {e}"))?,
        None => last,
    };
    let track = build_track(request, first.min(reference))?;
    let mu = request.motion_uncertainty.to_motion()?;

    let (mut result, prepared) =
        running_fix_report(&timed, &track, &mu, reference, &request.options);
    let mut extra: Vec<Warning> = rejected
        .iter()
        .map(|e| Warning::Other {
            message: format!("{e}. This sight was not used in the fix."),
        })
        .collect();
    if mu.is_zero() {
        extra.push(Warning::Other {
            message: "no dead-reckoning uncertainty was stated (speed, course and random-walk \
                      sigmas are all zero), so the running fix treats the run between the \
                      sights as exact; state them to have the fix's sigma include it"
                .to_string(),
        });
    }
    let warnings = match &mut result {
        FixResult::Underdetermined { warnings, .. }
        | FixResult::Ambiguous { warnings, .. }
        | FixResult::Unique { warnings, .. }
        | FixResult::Failed { warnings, .. } => warnings,
    };
    warnings.extend(extra);

    Ok(RunningFixOutput {
        result,
        reference_utc: format_utc(reference),
        reference_jd_utc: reference,
        applied: prepared.applied,
        passes: prepared.passes,
        reference_estimate: prepared.reference_estimate,
        inflations: prepared
            .inflations
            .iter()
            .map(|i| SigmaInflationReport {
                id: i.id.clone(),
                hours_to_reference: i.hours_to_reference,
                run_nm: i.run_nm,
                zn_deg: i.zn_deg,
                sigma_sight_arcmin: i.sigma_sight_arcmin,
                sigma_motion_arcmin: i.sigma_motion_arcmin,
                sigma_total_arcmin: i.sigma_total_arcmin,
            })
            .collect(),
        sights: reduced,
    })
}

/// The request's legs as a [`Track`]. Only the first leg may leave out its start, which
/// is then `default_start`.
fn build_track(request: &RunningFixRequest, default_start: f64) -> Result<Track, String> {
    if request.legs.is_empty() {
        return Err(
            "a running fix needs at least one dead-reckoning leg (course_deg and speed_kn)"
                .to_string(),
        );
    }
    let mut legs = Vec::with_capacity(request.legs.len());
    for (i, leg) in request.legs.iter().enumerate() {
        if !leg.course_deg.is_finite() || !leg.speed_kn.is_finite() {
            return Err(format!("legs[{i}]: course_deg and speed_kn must be finite"));
        }
        let start = match (&leg.start_utc, i) {
            (Some(u), _) => parse_utc(u).map_err(|e| format!("legs[{i}].start_utc: {e}"))?,
            (None, 0) => default_start,
            (None, _) => {
                return Err(format!(
                    "legs[{i}] needs a start_utc: only the first leg may leave it out"
                ));
            }
        };
        legs.push(Leg::new(start, leg.course_deg, leg.speed_kn));
    }
    Ok(match &request.end_utc {
        Some(u) => Track::with_end(legs, parse_utc(u).map_err(|e| format!("end_utc: {e}"))?),
        None => Track::new(legs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leg(start: Option<&str>, course: f64, speed: f64) -> RunningFixLeg {
        RunningFixLeg {
            start_utc: start.map(str::to_string),
            course_deg: course,
            speed_kn: speed,
        }
    }

    #[test]
    fn the_first_leg_may_start_at_the_earliest_sight_and_no_other_may() {
        let request = RunningFixRequest {
            legs: vec![leg(None, 45.0, 12.0)],
            ..Default::default()
        };
        let t = build_track(&request, 2_461_314.5).unwrap();
        assert_eq!(t.legs()[0].start_utc_jd, 2_461_314.5);

        let request = RunningFixRequest {
            legs: vec![leg(None, 45.0, 12.0), leg(None, 90.0, 10.0)],
            ..Default::default()
        };
        let e = build_track(&request, 2_461_314.5).unwrap_err();
        assert!(e.contains("legs[1] needs a start_utc"), "{e}");

        let e = build_track(&RunningFixRequest::default(), 2_461_314.5).unwrap_err();
        assert!(e.contains("at least one dead-reckoning leg"), "{e}");

        let request = RunningFixRequest {
            legs: vec![leg(None, f64::NAN, 12.0)],
            ..Default::default()
        };
        assert!(build_track(&request, 2_461_314.5).is_err());
    }

    #[test]
    fn a_track_end_is_honoured_and_checked() {
        let request = RunningFixRequest {
            legs: vec![leg(Some("2026-10-01T00:00:00Z"), 0.0, 12.0)],
            end_utc: Some("2026-10-01T02:00:00Z".to_string()),
            ..Default::default()
        };
        let t = build_track(&request, 0.0).unwrap();
        assert!(t.end_utc_jd().is_some());
        let request = RunningFixRequest {
            end_utc: Some("tomorrow".to_string()),
            ..request
        };
        assert!(
            build_track(&request, 0.0)
                .unwrap_err()
                .starts_with("end_utc")
        );
    }

    #[test]
    fn motion_sigmas_must_be_finite_and_not_negative() {
        let ok = MotionUncertaintyInput {
            speed_sigma_kn: 0.5,
            course_sigma_deg: 2.0,
            random_walk_nm_per_sqrt_hour: 0.0,
        };
        assert!(!ok.to_motion().unwrap().is_zero());
        assert!(
            MotionUncertaintyInput::default()
                .to_motion()
                .unwrap()
                .is_zero()
        );
        let e = MotionUncertaintyInput {
            course_sigma_deg: -1.0,
            ..ok
        }
        .to_motion()
        .unwrap_err();
        assert!(e.contains("course_sigma_deg"), "{e}");
    }

    #[test]
    fn the_request_document_defaults_everything_but_the_legs() {
        let r: RunningFixRequest =
            serde_json::from_str(r#"{"legs": [{"course_deg": 45, "speed_kn": 12}]}"#).unwrap();
        assert_eq!(r.legs.len(), 1);
        assert!(r.reference_utc.is_none() && r.end_utc.is_none());
        assert_eq!(r.motion_uncertainty, MotionUncertaintyInput::default());
        assert_eq!(r.options, SolveOptions::default());
    }
}
