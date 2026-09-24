//! WASM adapter. OWNER: web agent. Thin: parse JSON in, call core, JSON out.
//!
//! Every exported function's *signature and JSON shape is final*. The bodies that need
//! a numerical core that is still `todo!()` are compiled out behind cargo features so
//! that a stub build can never panic inside `todo!()` (wasm32 panics abort; there is no
//! `catch_unwind` to save us). Each feature is a one-line flip in `Cargo.toml`:
//!
//! | feature           | turns on                                      | needed by |
//! |-------------------|-----------------------------------------------|-----------|
//! | `core-ready`      | `parse_session`, `reduce`, `solve`            | core-reduce + core-solver agents |
//! | `ephemeris-ready` | ephemeris-backed `reduce`, real `coverage()`  | ephemeris agent |
//! | `sim-ready`       | `simulate`                                    | sim agent |
//!
//! Until a feature is on, the corresponding export returns
//! `Err("not implemented: <name> (build skyfix-wasm with --features <feature>)")`.
//!
//! `core-ready` already compiles against today's `skyfix-core` signatures: switching it
//! on is all that is needed once the `todo!()`s are filled. The other two also need
//! their crate to export symbols that do not exist yet:
//!
//! - `sim-ready` needs `skyfix_sim::simulate(&Scenario) -> Result<(Session, Truth), E>`
//!   where `E: Display`. `Scenario` is defined below and is a PROPOSAL: if the sim agent
//!   prefers a different shape, change it here and in `web/src/api/adapter.ts` together.
//! - `ephemeris-ready` needs `skyfix_ephemeris::catalog::body_names() -> &[&str]`,
//!   `skyfix_ephemeris::fixture_pack::default_provider() -> impl AstroProvider`, and
//!   `skyfix_ephemeris::providers() -> &[&dyn AstroProvider]`.
//!
//! Verify with `cargo check -p skyfix-wasm --features <feature>` before switching a
//! default on.
//! `version()`, `circle_points()` and `catalog()` are real in every build.
//!
//! JSON crossing this boundary is exactly `serde_json`'s encoding of
//! `skyfix_core::types` (`Serializer::json_compatible`, so `None` is `null`, not
//! `undefined`). CONVENTIONS section 1: degrees / arcminutes / metres on the wire.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Boundary helpers
// ---------------------------------------------------------------------------

/// Serialise with JSON-compatible semantics: `Option::None` -> `null`, maps -> objects.
/// Without this, `serde_wasm_bindgen` emits `undefined` for `None` and the UI cannot
/// tell "suppressed ellipse" from "field absent".
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let ser = serde_wasm_bindgen::Serializer::json_compatible();
    value
        .serialize(&ser)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[allow(dead_code)]
fn err(msg: impl AsRef<str>) -> JsValue {
    JsValue::from_str(msg.as_ref())
}

#[allow(dead_code)]
fn not_implemented(name: &str, feature: &str) -> JsValue {
    JsValue::from_str(&format!(
        "not implemented: {name} (build skyfix-wasm with --features {feature})"
    ))
}

/// Install the panic hook. Call once, before anything else. Idempotent.
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// `skyfix-core` crate version.
#[wasm_bindgen]
pub fn version() -> String {
    skyfix_core::VERSION.to_string()
}

// ---------------------------------------------------------------------------
// Wire shapes owned by this adapter (everything else comes from skyfix_core::types)
// ---------------------------------------------------------------------------

/// `parse_session` result: `{ "session": Session, "warnings": [Warning] }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedSession {
    pub session: skyfix_core::types::Session,
    pub warnings: Vec<skyfix_core::types::Warning>,
}

/// One element of the `reduce` array. A rejected sight does not abort the batch.
///
/// `{"status":"ok","sight":{...ReducedSight}}` or
/// `{"status":"error","id":"obs-3","message":"..."}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReduceEntry {
    Ok {
        sight: Box<skyfix_core::types::ReducedSight>,
    },
    Error {
        id: String,
        message: String,
    },
}

/// `simulate` result. Truth is a *sibling* of the session, never inside it
/// (CONVENTIONS section 11; BRIEF "Simulator").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationOutput {
    pub session: skyfix_core::types::Session,
    pub truth: skyfix_core::types::Truth,
}

/// What `coverage()` reports: one entry per offline astronomy provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageReport {
    pub providers: Vec<ProviderCoverage>,
    /// Which `ephemeris_mode` strings `reduce` accepts in this build.
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCoverage {
    pub provider: String,
    pub start_utc: String,
    pub end_utc: String,
    pub bodies: Vec<String>,
    pub notes: String,
    pub accuracy_arcmin: f64,
}

pub const SCENARIO_SCHEMA: &str = "skyfix.scenario/1";

/// Simulator input. PROPOSED CONTRACT — `skyfix-sim` owns the semantics; this struct
/// exists so the UI and the simulator agree on field names before either lands.
/// Angles in degrees, small angles in arcminutes, times in seconds (section 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario {
    pub schema: String,
    #[serde(default)]
    pub name: String,
    pub seed: u64,
    /// The position the sights are generated from. Never copied into the session.
    pub truth_position: skyfix_core::types::LatLon,
    /// RFC 3339 UTC of the first sight.
    pub utc: String,
    pub geometry: GeometryPreset,
    /// Used when `geometry` is `custom`; otherwise the preset picks the bodies.
    #[serde(default)]
    pub bodies: Vec<String>,
    /// How many sights the preset should produce (ignored by fixed-size presets).
    #[serde(default = "default_sight_count")]
    pub sight_count: u32,
    /// The sigma written into each observation (what the solver is told).
    #[serde(default = "default_one")]
    pub sigma_arcmin: f64,
    /// Independent per-sight noise actually injected, 1-sigma arcminutes.
    #[serde(default)]
    pub noise_arcmin: f64,
    /// A common offset added to every altitude. Averaging cannot remove it.
    #[serde(default)]
    pub shared_altitude_bias_arcmin: f64,
    /// A common error added to every recorded time, seconds.
    #[serde(default)]
    pub clock_offset_s: f64,
    /// Written into `session.clock.uncertainty_s` for propagation.
    #[serde(default)]
    pub clock_uncertainty_s: f64,
    /// Fraction of generated sights dropped, `[0, 1)`.
    #[serde(default)]
    pub missing_fraction: f64,
    /// One deliberately wrong sight.
    #[serde(default)]
    pub wrong_sight: Option<WrongSight>,
    #[serde(default)]
    pub height_of_eye_m: f64,
    #[serde(default)]
    pub index_correction_arcmin: f64,
    #[serde(default)]
    pub horizon: skyfix_core::types::HorizonMode,
}

fn default_sight_count() -> u32 {
    4
}
fn default_one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeometryPreset {
    /// Well spread azimuths: the reference "good geometry" demo.
    Good,
    /// All bodies within a narrow azimuth sector: ill-conditioned.
    Clustered,
    /// Exactly two sights, chosen so both circle intersections are plausible.
    TwoBody,
    /// Exactly one sight: underdetermined by construction.
    SingleSight,
    /// Use `bodies` verbatim.
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WrongSight {
    /// Index into the generated sights, 0-based.
    pub index: u32,
    /// Altitude error added to that one sight, arcminutes.
    pub error_arcmin: f64,
}

// ---------------------------------------------------------------------------
// Exports backed by the core
// ---------------------------------------------------------------------------

/// Parse + validate a session document. Returns `{session, warnings}`.
#[wasm_bindgen]
pub fn parse_session(json: &str) -> Result<JsValue, JsValue> {
    #[cfg(feature = "core-ready")]
    {
        let (session, warnings) =
            skyfix_core::session::parse_session(json).map_err(|e| err(e.to_string()))?;
        to_js(&ParsedSession { session, warnings })
    }
    #[cfg(not(feature = "core-ready"))]
    {
        let _ = json;
        Err(not_implemented("parse_session", "core-ready"))
    }
}

/// Reduce every observation in a session.
///
/// `ephemeris_mode` selects the direction source:
/// - `"supplied"` — only `observation.geocentric` is honoured (the "first numerical
///   slice"); a sight without one is reported as an error entry.
/// - `"auto"` — supplied direction wins, otherwise the bundled offline provider.
///
/// Returns an array of [`ReduceEntry`], one per observation, in input order.
#[wasm_bindgen]
pub fn reduce(session_json: &str, ephemeris_mode: &str) -> Result<JsValue, JsValue> {
    #[cfg(feature = "core-ready")]
    {
        let (session, _warnings) =
            skyfix_core::session::parse_session(session_json).map_err(|e| err(e.to_string()))?;
        let source = direction_source(ephemeris_mode)?;
        let entries: Vec<ReduceEntry> = skyfix_core::reduce::reduce_session(&session, &*source)
            .into_iter()
            .zip(session.observations.iter())
            .map(|(result, obs)| match result {
                Ok(sight) => ReduceEntry::Ok {
                    sight: Box::new(sight),
                },
                Err(e) => ReduceEntry::Error {
                    id: obs.id.clone(),
                    message: e.to_string(),
                },
            })
            .collect();
        to_js(&entries)
    }
    #[cfg(not(feature = "core-ready"))]
    {
        let _ = (session_json, ephemeris_mode);
        Err(not_implemented("reduce", "core-ready"))
    }
}

/// Solve a fix. `options_json` is a `skyfix_core::types::SolveOptions` document;
/// an empty string or `"{}"`-with-defaults is not accepted by serde today, so the UI
/// sends every field (see web/README.md). Returns a `FixResult`.
#[wasm_bindgen]
pub fn solve(session_json: &str, options_json: &str) -> Result<JsValue, JsValue> {
    #[cfg(feature = "core-ready")]
    {
        let (session, _warnings) =
            skyfix_core::session::parse_session(session_json).map_err(|e| err(e.to_string()))?;
        let options: skyfix_core::types::SolveOptions = serde_json::from_str(options_json)
            .map_err(|e| err(format!("solve options: {e}")))?;
        let source = direction_source("auto")?;
        let reduced: Vec<skyfix_core::types::ReducedSight> =
            skyfix_core::reduce::reduce_session(&session, &*source)
                .into_iter()
                .filter_map(Result::ok)
                .collect();
        let sights = skyfix_core::reduce::to_sights(&reduced, &*source);
        let result = skyfix_core::solver::solve(&sights, &options);
        to_js(&result)
    }
    #[cfg(not(feature = "core-ready"))]
    {
        let _ = (session_json, options_json);
        Err(not_implemented("solve", "core-ready"))
    }
}

#[cfg(feature = "core-ready")]
fn direction_source(
    mode: &str,
) -> Result<Box<dyn skyfix_core::reduce::DirectionSource>, JsValue> {
    match mode {
        "supplied" => Ok(Box::new(skyfix_core::reduce::SuppliedOnly)),
        #[cfg(feature = "ephemeris-ready")]
        "auto" | "" => Ok(Box::new(skyfix_ephemeris::ProviderSource(
            skyfix_ephemeris::fixture_pack::default_provider(),
        ))),
        #[cfg(not(feature = "ephemeris-ready"))]
        "auto" | "" => Ok(Box::new(skyfix_core::reduce::SuppliedOnly)),
        other => Err(err(format!(
            "unknown ephemeris_mode {other:?}: expected \"supplied\" or \"auto\""
        ))),
    }
}

/// `n` points around the circle of position of angular radius `zenith_distance_deg`
/// about the body's geographic position, as `[[lat_deg, lon_deg], ...]`, starting due
/// north of the GP and running clockwise. Longitudes are in `(-180, 180]`, so a circle
/// crossing the antimeridian produces a jump the caller must split on.
///
/// Real in every build: `skyfix_core::geometry` is not stubbed.
#[wasm_bindgen]
pub fn circle_points(lat_gp: f64, lon_gp: f64, zenith_distance_deg: f64, n: usize) -> JsValue {
    let gp = skyfix_core::geometry::Point::from_deg(lat_gp, lon_gp);
    let points: Vec<[f64; 2]> =
        skyfix_core::geometry::circle_of_position(gp, zenith_distance_deg.to_radians(), n.max(3))
            .into_iter()
            .map(|p| [p.lat_deg(), p.lon_deg()])
            .collect();
    to_js(&points).unwrap_or(JsValue::NULL)
}

/// Generate a simulated session and its truth. Returns `{session, truth}`.
/// The truth is never written into the session (BRIEF "Simulator").
#[wasm_bindgen]
pub fn simulate(scenario_json: &str) -> Result<JsValue, JsValue> {
    #[cfg(feature = "sim-ready")]
    {
        let scenario: Scenario =
            serde_json::from_str(scenario_json).map_err(|e| err(format!("scenario: {e}")))?;
        let (session, truth) =
            skyfix_sim::simulate(&scenario).map_err(|e| err(e.to_string()))?;
        to_js(&SimulationOutput { session, truth })
    }
    #[cfg(not(feature = "sim-ready"))]
    {
        let _ = scenario_json;
        Err(not_implemented("simulate", "sim-ready"))
    }
}

/// Body names the UI offers: `"Sun"` then the 57 Nautical Almanac navigational stars
/// in almanac order, then `"Polaris"`. Nautical Almanac spellings (CONVENTIONS
/// section 10). Real in every build; the ephemeris agent's catalogue replaces the
/// constant once `ephemeris-ready` is on.
#[wasm_bindgen]
pub fn catalog() -> JsValue {
    #[cfg(feature = "ephemeris-ready")]
    {
        let names: Vec<String> = skyfix_ephemeris::catalog::body_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        return to_js(&names).unwrap_or(JsValue::NULL);
    }
    #[cfg(not(feature = "ephemeris-ready"))]
    to_js(&BODY_NAMES.as_slice()).unwrap_or(JsValue::NULL)
}

/// `"Sun"` + 57 navigational stars + `"Polaris"` = 59 names.
pub const BODY_NAMES: [&str; 59] = [
    "Sun",
    "Alpheratz",
    "Ankaa",
    "Schedar",
    "Diphda",
    "Achernar",
    "Hamal",
    "Acamar",
    "Menkar",
    "Mirfak",
    "Aldebaran",
    "Rigel",
    "Capella",
    "Bellatrix",
    "Elnath",
    "Alnilam",
    "Betelgeuse",
    "Canopus",
    "Sirius",
    "Adhara",
    "Procyon",
    "Pollux",
    "Avior",
    "Suhail",
    "Miaplacidus",
    "Alphard",
    "Regulus",
    "Dubhe",
    "Denebola",
    "Gienah",
    "Acrux",
    "Gacrux",
    "Alioth",
    "Spica",
    "Alkaid",
    "Hadar",
    "Menkent",
    "Arcturus",
    "Rigil Kentaurus",
    "Zubenelgenubi",
    "Kochab",
    "Alphecca",
    "Antares",
    "Atria",
    "Sabik",
    "Shaula",
    "Rasalhague",
    "Eltanin",
    "Kaus Australis",
    "Vega",
    "Nunki",
    "Altair",
    "Peacock",
    "Deneb",
    "Enif",
    "Al Na'ir",
    "Fomalhaut",
    "Markab",
    "Polaris",
];

/// Offline astronomy coverage, verbatim for the About view. No network, ever.
#[wasm_bindgen]
pub fn coverage() -> JsValue {
    #[cfg(feature = "ephemeris-ready")]
    {
        let providers: Vec<ProviderCoverage> = skyfix_ephemeris::providers()
            .iter()
            .map(|p| {
                let c = p.coverage();
                ProviderCoverage {
                    provider: p.name().to_string(),
                    start_utc: c.start_utc,
                    end_utc: c.end_utc,
                    bodies: c.bodies,
                    notes: c.notes,
                    accuracy_arcmin: c.accuracy_arcmin,
                }
            })
            .collect();
        return to_js(&CoverageReport {
            providers,
            modes: vec!["supplied".into(), "auto".into()],
        })
        .unwrap_or(JsValue::NULL);
    }
    #[cfg(not(feature = "ephemeris-ready"))]
    to_js(&CoverageReport {
        providers: vec![ProviderCoverage {
            provider: "supplied".into(),
            start_utc: "".into(),
            end_utc: "".into(),
            bodies: vec![],
            notes: "No ephemeris provider is compiled in. Every observation must carry \
                    its own apparent geocentric gha_deg/dec_deg."
                .into(),
            accuracy_arcmin: 0.0,
        }],
        modes: vec!["supplied".into()],
    })
    .unwrap_or(JsValue::NULL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sun_plus_57_stars_plus_polaris() {
        assert_eq!(BODY_NAMES.len(), 59);
        assert_eq!(BODY_NAMES[0], "Sun");
        assert_eq!(BODY_NAMES[58], "Polaris");
        let mut sorted = BODY_NAMES.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), before, "duplicate body name in catalog");
    }

    #[test]
    fn scenario_round_trips_with_defaults() {
        let json = r#"{"schema":"skyfix.scenario/1","seed":7,
            "truth_position":{"lat_deg":39.9526,"lon_deg":-75.1652},
            "utc":"2026-10-01T01:30:00Z","geometry":"good"}"#;
        let s: Scenario = serde_json::from_str(json).unwrap();
        assert_eq!(s.sight_count, 4);
        assert_eq!(s.sigma_arcmin, 1.0);
        assert_eq!(s.geometry, GeometryPreset::Good);
        assert!(s.wrong_sight.is_none());
    }

    #[test]
    fn reduce_entry_is_tagged_by_status() {
        let e = ReduceEntry::Error {
            id: "obs-1".into(),
            message: "boom".into(),
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"status":"error","id":"obs-1","message":"boom"}"#
        );
    }
}
