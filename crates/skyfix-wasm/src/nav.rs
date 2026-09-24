//! WASM exports for the explorer: navigation methods.
//!
//! OWNER: navigation agents (wave 1: noon sight, Polaris latitude, averaging a run,
//! running fix; wave 2 adds Moon/planet sights and lunar distance). Wire format:
//! docs/EXPLORER_API.md, "Wave 1 — navigation methods"; the TypeScript mirror is the
//! `NavEngine` section of web/src/next/engine/types.ts; the methods themselves are
//! docs/NAVIGATION_METHODS.md.
//!
//! Every export takes a `skyfix.session/1` document holding the sights, a method
//! document (options, or the running fix's request), and an `ephemeris_mode` —
//! `"auto"` or `"supplied"`, exactly as `reduce` and `solve` take it. Each export has a
//! plain-Rust `*_json` twin that returns the result or the error message, so every path
//! is tested natively without a JavaScript runtime. Errors throw a string.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use skyfix_core::methods::polaris::PolarisTableSource;
use skyfix_core::methods::{averaging, noon, polaris};
use skyfix_core::reduce::{DirectionSource, SuppliedOnly, reduce_session_partitioned, to_sights};
use skyfix_core::time::{format_utc, parse_utc};
use skyfix_core::types::{
    AveragedSight, AveragingOptions, FixResult, GeocentricDirection, LatLon, NoonSightOptions,
    NoonSightResult, PolarisOptions, PolarisResult, ReducedSight, Session, SolveOptions, Warning,
};
use skyfix_ephemeris::{AstroProvider, ProviderSource};
use skyfix_motion::running_fix::{TimedSight, running_fix_report};
use skyfix_motion::track::{Leg, MotionUncertainty, Track};

use crate::{apply_session_position, auto_provider, err, to_js};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Noon sight: latitude, time of meridian passage and a (weak) longitude from a run of
/// altitudes of one body. `options_json` is a `NoonSightOptions` (`"{}"` for defaults).
/// Returns a `NoonSightResult`.
#[wasm_bindgen]
pub fn noon_sight(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<JsValue, JsValue> {
    to_js(&noon_sight_json(session_json, options_json, ephemeris_mode).map_err(err)?)
}

/// Latitude by Polaris from the session's Polaris sights (others are ignored with a
/// warning). `options_json` is a `PolarisOptions`. Returns a `PolarisResult`, with the
/// Nautical Almanac a0/a1/a2 terms for each sight.
#[wasm_bindgen]
pub fn polaris_latitude(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<JsValue, JsValue> {
    to_js(&polaris_latitude_json(session_json, options_json, ephemeris_mode).map_err(err)?)
}

/// Average a run of sights of one body into one sight. `options_json` is an
/// `AveragingOptions`. Returns an `AveragedSight`, whose `observation` can be put
/// straight into a session.
#[wasm_bindgen]
pub fn average_sights(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<JsValue, JsValue> {
    to_js(&average_sights_json(session_json, options_json, ephemeris_mode).map_err(err)?)
}

/// Running fix for a moving vessel: the session's sights advanced along the
/// dead-reckoning track to one instant and solved (skyfix-motion, docs/MOTION.md).
/// `request_json` is a [`RunningFixRequest`]. Returns a [`RunningFixOutput`], whose
/// `result` is the same `FixResult` `solve` returns.
#[wasm_bindgen]
pub fn running_fix(
    session_json: &str,
    request_json: &str,
    ephemeris_mode: &str,
) -> Result<JsValue, JsValue> {
    to_js(&running_fix_json(session_json, request_json, ephemeris_mode).map_err(err)?)
}

// ---------------------------------------------------------------------------
// The same, in plain Rust
// ---------------------------------------------------------------------------

pub fn noon_sight_json(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<NoonSightResult, String> {
    let session = session_from(session_json)?;
    let options: NoonSightOptions = document(options_json, "noon sight options")?;
    let source = source_for(ephemeris_mode)?;
    noon::noon_sight(&session, source.as_ref(), &options).map_err(|e| e.to_string())
}

pub fn polaris_latitude_json(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<PolarisResult, String> {
    let session = session_from(session_json)?;
    let options: PolarisOptions = document(options_json, "Polaris options")?;
    let source = source_for(ephemeris_mode)?;
    polaris::polaris_latitude(
        &session,
        source.as_ref(),
        Some(&EphemerisPolarisTable),
        &options,
    )
    .map_err(|e| e.to_string())
}

pub fn average_sights_json(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<AveragedSight, String> {
    let session = session_from(session_json)?;
    let options: AveragingOptions = document(options_json, "averaging options")?;
    let source = source_for(ephemeris_mode)?;
    averaging::average_sights(&session, source.as_ref(), &options).map_err(|e| e.to_string())
}

pub fn running_fix_json(
    session_json: &str,
    request_json: &str,
    ephemeris_mode: &str,
) -> Result<RunningFixOutput, String> {
    let session = session_from(session_json)?;
    let request: RunningFixRequest = document(request_json, "running fix request")?;
    let source = source_for(ephemeris_mode)?;
    let (reduced, rejected) = reduce_session_partitioned(&session, source.as_ref());
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

    let mut options = request.options.clone();
    apply_session_position(&session, &mut options);
    if options.clock_uncertainty_s == 0.0 {
        options.clock_uncertainty_s = session.clock.uncertainty_s;
    }
    let timed: Vec<TimedSight> = to_sights(&reduced, source.as_ref())
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
    let track = build_track(&request, first.min(reference))?;
    let mu = request.motion_uncertainty.to_motion()?;

    let (mut result, prepared) = running_fix_report(&timed, &track, &mu, reference, &options);
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

// ---------------------------------------------------------------------------
// Wire shapes owned by this module
// ---------------------------------------------------------------------------

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
    /// Solver options, exactly as `solve` takes them.
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

/// `skyfix_motion::track::MotionUncertainty` with every field defaulting to zero.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MotionUncertaintyInput {
    pub speed_sigma_kn: f64,
    pub course_sigma_deg: f64,
    pub random_walk_nm_per_sqrt_hour: f64,
}

impl MotionUncertaintyInput {
    fn to_motion(self) -> Result<MotionUncertainty, String> {
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

/// What the dead reckoning did to one sight's sigma (skyfix-motion `SigmaInflation`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SigmaInflationReport {
    pub id: String,
    /// Hours from the sight to the reference instant, `reference - sight`: positive when
    /// the sight was taken first (the usual running fix), negative when after.
    pub hours_to_reference: f64,
    pub run_nm: f64,
    pub zn_deg: f64,
    pub sigma_sight_arcmin: f64,
    pub sigma_motion_arcmin: f64,
    pub sigma_total_arcmin: f64,
}

/// `running_fix` result: the fix itself (the same `FixResult` `solve` returns) and the
/// workings of the advance.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// GHA Aries and Polaris from `skyfix-ephemeris` (DUT1 = 0, CONVENTIONS 6) for the
/// Almanac-style teaching terms. They are display only: the Polaris latitude itself uses
/// the session's direction source.
pub struct EphemerisPolarisTable;

impl PolarisTableSource for EphemerisPolarisTable {
    fn gha_aries_deg(&self, jd_utc: f64) -> f64 {
        skyfix_ephemeris::sidereal::gha_aries_deg(jd_utc, 0.0)
    }
    fn polaris(&self, jd_utc: f64) -> Result<GeocentricDirection, String> {
        skyfix_ephemeris::stars::StarProvider::new()
            .geocentric("Polaris", jd_utc)
            .map_err(|e| e.to_string())
    }
}

/// The direction source for an `ephemeris_mode`, as `lib.rs` defines the modes, but
/// with a plain error so the `*_json` functions run natively.
fn source_for(mode: &str) -> Result<Box<dyn DirectionSource>, String> {
    match mode {
        "supplied" => Ok(Box::new(SuppliedOnly)),
        "auto" | "" => Ok(Box::new(ProviderSource(auto_provider()))),
        other => Err(format!(
            "unknown ephemeris_mode {other:?}: expected \"supplied\" or \"auto\""
        )),
    }
}

fn session_from(json: &str) -> Result<Session, String> {
    skyfix_core::session::parse_session(json)
        .map(|(session, _warnings)| session)
        .map_err(|e| e.to_string())
}

/// A method document; empty means "all defaults".
fn document<T: DeserializeOwned + Default>(json: &str, what: &str) -> Result<T, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(trimmed).map_err(|e| format!("{what}: {e}"))
}

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
    use serde_json::{Value, json};
    use skyfix_core::geometry::{Point, angular_distance};
    use skyfix_core::units::rad_to_m;

    const FIXTURE: &str = include_str!("../../../fixtures/reference/nav_methods.json");
    const BOOK: &str = include_str!("../../../fixtures/reference/bowditch_worked_examples.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    /// A session document from a fixture case's sights, as raw sextant readings.
    fn session_json(sights: &[Value], body: Option<&str>) -> String {
        let doc = fixture();
        let o = &doc["generator"]["observer_for_sextant_readings"];
        let observations: Vec<Value> = sights
            .iter()
            .map(|s| {
                json!({
                    "id": s["id"],
                    "body": body.map_or_else(|| s["body"].clone(), |b| json!(b)),
                    "utc": s["utc"],
                    "altitude_deg": s["hs_deg"],
                    "altitude_kind": "sextant_hs",
                    "sigma_arcmin": 0.5,
                    "limb": s["limb"],
                })
            })
            .collect();
        json!({
            "schema": "skyfix.session/1",
            "observer": {
                "height_of_eye_m": o["height_of_eye_m"],
                "pressure_hpa": o["pressure_hpa"],
                "temperature_c": o["temperature_c"],
            },
            "instrument": {"index_correction_arcmin": o["index_correction_arcmin"], "horizon": "sea"},
            "observations": observations,
        })
        .to_string()
    }

    fn running_case(name: &str) -> Value {
        fixture()["running_fix"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap()
            .clone()
    }

    /// The running-fix fixture's star sights, each named: the case stores the star name
    /// only implicitly, so recover it from the sight's own direction via the catalogue.
    fn running_session(case: &Value) -> String {
        let sights = case["sights"].as_array().unwrap();
        let named: Vec<Value> = sights
            .iter()
            .map(|s| {
                let mut s = s.clone();
                s["body"] = json!(star_for(&s));
                s
            })
            .collect();
        session_json(&named, None)
    }

    /// Which catalogue star has this sight's declination (to 0.01 deg).
    fn star_for(sight: &Value) -> String {
        let dec = sight["dec_deg"].as_f64().unwrap();
        let jd = sight["jd_utc"].as_f64().unwrap();
        let stars = skyfix_ephemeris::stars::StarProvider::new();
        skyfix_ephemeris::catalog::names()
            .into_iter()
            .find(|n| {
                stars
                    .geocentric(n, jd)
                    .is_ok_and(|d| (d.dec_deg - dec).abs() < 0.01)
            })
            .expect("a catalogue star")
            .to_string()
    }

    fn position(result: &FixResult) -> LatLon {
        match result {
            FixResult::Unique { fix, .. } => fix.position,
            other => panic!("expected a unique fix, got {other:?}"),
        }
    }

    #[test]
    fn a_running_fix_due_north_recovers_the_truth() {
        let case = running_case("due-north-12kn");
        let request = json!({
            "legs": [{"course_deg": 0.0, "speed_kn": 12.0}],
            "motion_uncertainty": {"speed_sigma_kn": 0.5, "course_sigma_deg": 2.0},
        });
        let out = running_fix_json(&running_session(&case), &request.to_string(), "auto").unwrap();
        assert!(out.applied);
        assert_eq!(out.inflations.len(), 3);
        assert!((out.inflations[0].run_nm - 36.0).abs() < 1e-3);
        // The first sight was taken three hours before the reference: +3, as documented
        // (the field comment used to say a sight taken first is negative).
        assert!((out.inflations[0].hours_to_reference - 3.0).abs() < 1e-9);
        assert_eq!(
            out.reference_utc,
            case["truth"]["reference_utc"].as_str().unwrap()
        );
        let p = position(&out.result);
        let truth = &case["truth"];
        let err_m = rad_to_m(angular_distance(
            Point::from_deg(p.lat_deg, p.lon_deg),
            Point::from_deg(
                truth["lat_deg"].as_f64().unwrap(),
                truth["lon_deg"].as_f64().unwrap(),
            ),
        ));
        println!("running fix due north, 36 NM run: {err_m:.1} m from the truth");
        assert!(err_m < 10.0, "{err_m} m");
        // The sigmas behind it are not the instrument's, and the result says so.
        let FixResult::Unique { warnings, .. } = &out.result else {
            unreachable!()
        };
        let text = format!("{warnings:?}");
        assert!(text.contains("RUNNING FIX"), "{text}");
        assert!(text.contains("OPTIMISTIC"), "{text}");
    }

    #[test]
    fn a_running_fix_on_a_rhumb_line_carries_the_great_circle_leg_error() {
        // The vessel really held 045 (a rhumb line); skyfix-motion models each leg as a
        // great circle on its initial course (docs/MOTION.md). Over the first sight's
        // 36 NM at 40 N the two curves part by about 200 m; the fix, which combines
        // three lines of position, inherits a few tens of metres of it (36 m here).
        let case = running_case("northeast-12kn-rhumb");
        let request = json!({
            "legs": [{"course_deg": 45.0, "speed_kn": 12.0}],
            "motion_uncertainty": {"speed_sigma_kn": 0.5, "course_sigma_deg": 2.0},
        });
        let out = running_fix_json(&running_session(&case), &request.to_string(), "auto").unwrap();
        let p = position(&out.result);
        let truth = &case["truth"];
        let err_m = rad_to_m(angular_distance(
            Point::from_deg(p.lat_deg, p.lon_deg),
            Point::from_deg(
                truth["lat_deg"].as_f64().unwrap(),
                truth["lon_deg"].as_f64().unwrap(),
            ),
        ));
        println!("running fix on 045 as a rhumb line, 36 NM run: {err_m:.1} m from the truth");
        assert!(err_m < 100.0, "{err_m} m");
    }

    #[test]
    fn a_running_fix_without_motion_sigmas_says_so() {
        let case = running_case("due-north-12kn");
        let request = json!({"legs": [{"course_deg": 0.0, "speed_kn": 12.0}]});
        let out = running_fix_json(&running_session(&case), &request.to_string(), "auto").unwrap();
        let text = serde_json::to_string(&out.result).unwrap();
        assert!(
            text.contains("no dead-reckoning uncertainty was stated"),
            "{text}"
        );
    }

    #[test]
    fn running_fix_requests_are_checked() {
        let case = running_case("due-north-12kn");
        let s = running_session(&case);
        let e = running_fix_json(&s, r#"{"legs": []}"#, "auto").unwrap_err();
        assert!(e.contains("at least one dead-reckoning leg"), "{e}");
        let e = running_fix_json(
            &s,
            r#"{"legs": [{"course_deg": 0, "speed_kn": 5}, {"course_deg": 90, "speed_kn": 5}]}"#,
            "auto",
        )
        .unwrap_err();
        assert!(e.contains("needs a start_utc"), "{e}");
        let e = running_fix_json(
            &s,
            r#"{"legs": [{"course_deg": 0, "speed_kn": 5}], "motion_uncertainty": {"speed_sigma_kn": -1}}"#,
            "auto",
        )
        .unwrap_err();
        assert!(e.contains("speed_sigma_kn"), "{e}");
        let e = running_fix_json(&s, "{not json", "auto").unwrap_err();
        assert!(e.starts_with("running fix request:"), "{e}");
        let e = running_fix_json(
            &s,
            r#"{"legs": [{"course_deg": 0, "speed_kn": 5}]}"#,
            "moon",
        )
        .unwrap_err();
        assert!(e.contains("ephemeris_mode"), "{e}");
    }

    #[test]
    fn the_noon_export_matches_the_core_and_speaks_snake_case_json() {
        let doc = fixture();
        let case = doc["noon"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "philadelphia-equinox-sun")
            .unwrap();
        let sights = case["sights"].as_array().unwrap();
        let options = json!({"dr": {"lat_deg": case["dr"]["lat_deg"], "lon_deg": case["dr"]["lon_deg"], "sigma_nm": 10}});
        let r = noon_sight_json(
            &session_json(sights, Some("Sun")),
            &options.to_string(),
            "auto",
        )
        .unwrap();
        let truth_lat = case["truth"]["lat_deg"].as_f64().unwrap();
        assert!((r.latitude.lat_deg - truth_lat).abs() * 60.0 < 0.01);
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["method"], "curve_fit");
        assert_eq!(v["side"], "south");
        assert!(v["meridian_passage"]["sigma_s"].is_number());
        assert!(v["longitude"]["sigma_nm"].is_number());
        assert!(v["longitude_caveat"].as_str().unwrap().contains("HIGH"));
        assert!(
            v["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w["code"] == "flat_peak_longitude")
        );
        // "{}" and "" both mean defaults, but then the session must carry the DR.
        let e = noon_sight_json(&session_json(sights, Some("Sun")), "", "auto").unwrap_err();
        assert!(e.contains("DR position"), "{e}");
        let e = noon_sight_json(
            &session_json(sights, Some("Sun")),
            r#"{"curvature": "wobbly"}"#,
            "auto",
        )
        .unwrap_err();
        assert!(e.starts_with("noon sight options:"), "{e}");
    }

    #[test]
    fn the_polaris_export_reproduces_bowditch_1912_with_the_almanac_terms() {
        let book: Value = serde_json::from_str(BOOK).unwrap();
        let case = book["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "bowditch-1912-polaris")
            .unwrap();
        let i = &case["input"];
        let session = json!({
            "schema": "skyfix.session/1",
            "observer": {"assumed_position": {"lat_deg": i["dr_lat_deg"], "lon_deg": i["dr_lon_deg"]}},
            "observations": [{"id": "p", "body": "Polaris", "utc": i["utc"],
                              "altitude_deg": i["ho_deg"], "altitude_kind": "observed_ho",
                              "sigma_arcmin": 0.2}],
        });
        let r = polaris_latitude_json(&session.to_string(), "{}", "auto").unwrap();
        let expected = case["expected"]["latitude_deg"].as_f64().unwrap();
        assert!((r.latitude.lat_deg - expected).abs() * 60.0 < 0.15);
        let terms = r.polaris[0].almanac.as_ref().unwrap();
        assert!((terms.a0_arcmin - 54.9).abs() < 0.1);
        let v = serde_json::to_value(&r).unwrap();
        assert!(
            v["polaris"][0]["almanac"]["within_printed_table"]
                .as_bool()
                .unwrap()
        );
    }

    #[test]
    fn the_averaging_export_returns_a_ready_observation() {
        let doc = fixture();
        let case = doc["averaging"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "vega-run-philadelphia")
            .unwrap();
        let sights = case["sights"].as_array().unwrap();
        let options = json!({"dr": case["dr"]});
        let a = average_sights_json(
            &session_json(sights, Some("Vega")),
            &options.to_string(),
            "auto",
        )
        .unwrap();
        let truth = case["truth"]["ho_at_reference_deg"].as_f64().unwrap();
        assert!((a.ho_deg - truth).abs() * 60.0 < 0.01);
        let v = serde_json::to_value(&a.observation).unwrap();
        assert_eq!(v["altitude_kind"], "observed_ho");
        assert_eq!(v["body"], "Vega");
        // The averaged observation is a valid session observation.
        let session = json!({"schema": "skyfix.session/1", "observations": [v]});
        assert!(skyfix_core::session::parse_session(&session.to_string()).is_ok());
    }
}
