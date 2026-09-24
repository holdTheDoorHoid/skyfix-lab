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
use wasm_bindgen::prelude::*;

use skyfix_core::methods::{averaging, noon, polaris};
use skyfix_core::reduce::{DirectionSource, SuppliedOnly};
use skyfix_core::types::{
    AveragedSight, AveragingOptions, NoonSightOptions, NoonSightResult, PolarisOptions,
    PolarisResult, Session,
};
use skyfix_ephemeris::ProviderSource;

use crate::{apply_session_position, auto_provider, err, to_js};

// The running fix's wire shapes and the whole of its work live in `skyfix-motion`, and
// the Almanac-style Polaris terms' GHA of Aries in `skyfix-ephemeris`, so the command
// line (`skyfix running-fix`, `skyfix polaris`) runs exactly this code. Re-exported
// here unchanged: EXPLORER_API.md's `running_fix` shapes are these types.
pub use skyfix_ephemeris::stars::EphemerisPolarisTable;
pub use skyfix_motion::request::{
    MotionUncertaintyInput, RunningFixLeg, RunningFixOutput, RunningFixRequest,
    SigmaInflationReport,
};

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
    let mut request: RunningFixRequest = document(request_json, "running fix request")?;
    let source = source_for(ephemeris_mode)?;
    // The session's assumed position and clock uncertainty fill the options exactly as
    // they do for `solve`; `running_fix_session` then uses them as given.
    apply_session_position(&session, &mut request.options);
    if request.options.clock_uncertainty_s == 0.0 {
        request.options.clock_uncertainty_s = session.clock.uncertainty_s;
    }
    skyfix_motion::request::running_fix_session(&session, &request, source.as_ref())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use skyfix_core::geometry::{Point, angular_distance};
    use skyfix_core::types::{FixResult, LatLon};
    use skyfix_core::units::rad_to_m;
    use skyfix_ephemeris::AstroProvider;

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
