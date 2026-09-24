//! WASM exports for Moon and planet sights: predicted sextant readings, lunar distance
//! and the twilight sight planner.
//!
//! OWNER: navigation-Moon agent (wave 2). Wire format: docs/EXPLORER_API.md, "Wave 2 —
//! Moon and planet sights"; TypeScript mirror: `NavSkyEngine` in
//! `web/src/next/engine/types.ts`.
//!
//! Every direction comes from [`crate::auto_provider`] — the Sun, the Moon, the four
//! navigational planets (Venus at its centre of light) and the stars — so these tools and
//! `reduce`/`solve` with ephemeris `"auto"` can never disagree. Malformed input throws a
//! string; a body that cannot be computed throws the provider's own sentence.
//!
//! Each export is a thin wrapper over a plain Rust function of the same name with an
//! `_impl` suffix, which the native tests call.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use skyfix_core::types::{
    Instrument, Limb, LunarDistanceInput, LunarDistanceResult, PredictedSight, SightObserver,
    SightPlan,
};
use skyfix_ephemeris::{AstroProvider, ProviderSource};

use crate::{auto_provider, err, to_js};

/// A JSON document or an empty string (meaning "all defaults").
fn parse_or_default<T: for<'de> Deserialize<'de> + Default>(
    json: &str,
    what: &str,
) -> Result<T, String> {
    let t = json.trim();
    if t.is_empty() {
        Ok(T::default())
    } else {
        serde_json::from_str(t).map_err(|e| format!("{what}: {e}"))
    }
}

fn parse_observer(json: &str) -> Result<SightObserver, String> {
    serde_json::from_str(json.trim()).map_err(|e| format!("observer: {e}"))
}

fn parse_limb(limb: &str) -> Result<Limb, String> {
    match limb.trim().to_ascii_lowercase().as_str() {
        "" | "center" | "centre" => Ok(Limb::Center),
        "lower" => Ok(Limb::Lower),
        "upper" => Ok(Limb::Upper),
        other => Err(format!(
            "unknown limb {other:?}: expected \"lower\", \"upper\" or \"center\""
        )),
    }
}

/// The canonical name of a body the auto provider can answer for, or the reason not.
fn canonical_body(body: &str) -> Result<&'static str, String> {
    skyfix_ephemeris::body::canonical(body).ok_or_else(|| format!("unknown body {body:?}"))
}

// ---------------------------------------------------------------------------
// predict_sextant
// ---------------------------------------------------------------------------

pub fn predict_sextant_impl(
    observer_json: &str,
    instrument_json: &str,
    body: &str,
    limb: &str,
    jd_utc: f64,
) -> Result<PredictedSight, String> {
    let observer = parse_observer(observer_json)?;
    let instrument: Instrument = parse_or_default(instrument_json, "instrument")?;
    let limb = parse_limb(limb)?;
    let name = canonical_body(body)?;
    let provider = auto_provider();
    let direction = provider
        .geocentric(name, jd_utc)
        .map_err(|e| e.to_string())?;
    skyfix_core::sights::predict::predict_sextant(
        &observer,
        &instrument,
        name,
        limb,
        jd_utc,
        direction,
        provider.name(),
    )
    .map_err(|e| e.to_string())
}

/// The sextant reading a navigator would see: `PredictedSight` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn predict_sextant(
    observer_json: &str,
    instrument_json: &str,
    body: &str,
    limb: &str,
    jd_utc: f64,
) -> Result<JsValue, JsValue> {
    let p =
        predict_sextant_impl(observer_json, instrument_json, body, limb, jd_utc).map_err(err)?;
    to_js(&p)
}

// ---------------------------------------------------------------------------
// lunar_distance
// ---------------------------------------------------------------------------

pub fn lunar_distance_impl(input_json: &str) -> Result<LunarDistanceResult, String> {
    let mut input: LunarDistanceInput =
        serde_json::from_str(input_json.trim()).map_err(|e| format!("lunar distance: {e}"))?;
    input.body = canonical_body(&input.body)?.to_string();
    let source = ProviderSource(auto_provider());
    skyfix_core::sights::lunar::lunar_distance(&input, &source).map_err(|e| e.to_string())
}

/// Clear a lunar distance and find the UTC: `LunarDistanceResult` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn lunar_distance(input_json: &str) -> Result<JsValue, JsValue> {
    let r = lunar_distance_impl(input_json).map_err(err)?;
    to_js(&r)
}

// ---------------------------------------------------------------------------
// plan_sights
// ---------------------------------------------------------------------------

pub fn plan_sights_impl(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    instrument_json: &str,
) -> Result<SightPlan, String> {
    let observer = parse_observer(observer_json)?;
    let instrument: Instrument = parse_or_default(instrument_json, "instrument")?;
    let sky = skyfix_ephemeris::body::Sky::new();
    let provider = auto_provider();
    let bodies: Vec<&str> = skyfix_ephemeris::sights::sight_bodies()
        .into_iter()
        .filter(|b| *b != skyfix_ephemeris::body::SUN)
        .collect();
    skyfix_ephemeris::visibility::plan_sights(
        &sky,
        &provider,
        &bodies,
        &observer,
        jd_start,
        jd_end,
        &instrument,
        &skyfix_core::planner::PlanOptions::default(),
    )
    .map_err(|e| e.to_string())
}

/// Tonight's sights: `SightPlan` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn plan_sights(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    instrument_json: &str,
) -> Result<JsValue, JsValue> {
    let p = plan_sights_impl(observer_json, jd_start, jd_end, instrument_json).map_err(err)?;
    to_js(&p)
}

// ---------------------------------------------------------------------------
// sight_bodies
// ---------------------------------------------------------------------------

/// One body offered for sights.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SightBodyInfo {
    pub body: String,
    /// `"sun"`, `"moon"`, `"planet"` or `"star"`.
    pub kind: String,
}

pub fn sight_bodies_impl() -> Vec<SightBodyInfo> {
    skyfix_ephemeris::sights::sight_bodies()
        .into_iter()
        .map(|b| SightBodyInfo {
            body: b.to_string(),
            kind: match skyfix_core::corrections::sight_body(b) {
                skyfix_core::corrections::SightBody::Sun => "sun",
                skyfix_core::corrections::SightBody::Moon => "moon",
                skyfix_core::corrections::SightBody::Planet => "planet",
                skyfix_core::corrections::SightBody::Star => "star",
            }
            .to_string(),
        })
        .collect()
}

/// The bodies offered for sights: navigational and validated (CONVENTIONS 13.1, 13.7).
#[wasm_bindgen]
pub fn sight_bodies() -> JsValue {
    to_js(&sight_bodies_impl()).unwrap_or(JsValue::NULL)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHL: &str = r#"{"lat_deg": 39.9526, "lon_deg": -75.1652, "height_of_eye_m": 2.5}"#;

    fn jd(s: &str) -> f64 {
        skyfix_core::time::parse_utc(s).unwrap()
    }

    #[test]
    fn a_predicted_moon_reading_carries_its_corrections_and_lands_on_hc() {
        let p = predict_sextant_impl(PHL, "", "moon", "lower", jd("2026-10-01T03:00:00Z")).unwrap();
        assert_eq!(p.body, "Moon");
        assert_eq!(p.corrections.steps.len(), 6);
        assert!((p.corrections.ho_deg - p.hc_deg).abs() < 1e-9);
        assert!(p.direction_source.starts_with("skyfix-auto"));
        let json = serde_json::to_value(&p).unwrap();
        for key in [
            "hs_deg",
            "hc_deg",
            "zn_deg",
            "ha_deg",
            "corrections",
            "warnings",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }

    #[test]
    fn bad_input_and_non_sight_bodies_are_refused_with_a_reason() {
        let t = jd("2026-10-01T03:00:00Z");
        assert!(predict_sextant_impl("not json", "", "Vega", "center", t).is_err());
        assert!(predict_sextant_impl(PHL, "", "Vega", "sideways", t).is_err());
        assert!(predict_sextant_impl(PHL, "", "Vulcan", "center", t).is_err());
        let e = predict_sextant_impl(PHL, "", "Mercury", "center", t).unwrap_err();
        assert!(e.contains("not offered for sights"), "{e}");
        let e = predict_sextant_impl(PHL, r#"{"horizon": "sideways"}"#, "Vega", "", t).unwrap_err();
        assert!(e.starts_with("instrument"), "{e}");
    }

    #[test]
    fn the_sight_plan_and_body_list_come_through() {
        let start = jd("2026-10-01T12:00:00Z");
        let plan = plan_sights_impl(PHL, start, start + 1.0, "").unwrap();
        assert_eq!(plan.windows.len(), 2);
        let bodies = sight_bodies_impl();
        assert_eq!(bodies[1].body, "Moon");
        assert_eq!(bodies[1].kind, "moon");
        assert!(bodies.iter().all(|b| b.body != "Mercury"));
    }

    #[test]
    fn a_lunar_distance_document_goes_through_the_wire_types() {
        // The Skyfield validation is in skyfix-ephemeris/tests/lunar_distance_reference.rs;
        // this checks the JSON shape, the defaults and the canonical body name.
        let doc = r#"{
            "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652},
            "body": "jupiter",
            "utc_estimate": "2026-10-01T03:00:00Z",
            "distance_deg": 40.0
        }"#;
        // Whether 40 degrees is reachable depends on the sky; the call must either find
        // a time or explain why not, never panic.
        match lunar_distance_impl(doc) {
            Ok(r) => assert_eq!(r.body, "Jupiter"),
            Err(e) => assert!(
                e.contains("never equals") || e.contains("below the horizon"),
                "{e}"
            ),
        }
        assert!(lunar_distance_impl("{}").is_err());
    }
}

#[cfg(test)]
mod api_example {
    /// The `lunar_distance` example in docs/EXPLORER_API.md parses and gives the answer
    /// the document states.
    #[test]
    fn the_documented_lunar_distance_example_works() {
        let doc = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/EXPLORER_API.md"),
        )
        .unwrap();
        let start = doc
            .find("\"utc_estimate\": \"2029-10-17T01:05:43Z\"")
            .unwrap();
        let open = doc[..start].rfind("```json").unwrap() + "```json".len();
        let close = open + doc[open..].find("```").unwrap();
        let r = super::lunar_distance_impl(&doc[open..close]).unwrap();
        let truth = skyfix_core::time::parse_utc("2029-10-17T01:15:25Z").unwrap();
        assert!((r.jd_utc - truth).abs() * 86_400.0 < 5.0, "{}", r.utc);
        assert!(doc.contains("9 min 42 s after the watch's estimate"));
        assert!((r.utc_minus_estimate_s - 582.0).abs() < 5.0);
    }
}
