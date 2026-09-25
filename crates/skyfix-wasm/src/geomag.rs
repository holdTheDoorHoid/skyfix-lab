//! WASM exports for the Earth's magnetic field and compass error.
//!
//! OWNER: geomag agent (expansion programme). Wire format: docs/EXPLORER_API.md,
//! "Expansion programme — magnetic field and compass error"; TypeScript mirror:
//! `GeomagEngine` in `web/src/next/engine/types.ts`. Normative: CONVENTIONS 14.1-14.2.
//!
//! - `magnetic_field`: `skyfix_geomag` (WMM2025, IGRF-14) at one place and instant. A date
//!   no model covers is not an error: the answer is `{available: false, reason}`.
//! - `magnetic_grid`: declination and horizontal intensity on a latitude-longitude grid,
//!   as typed arrays, for isogonic lines on the map.
//! - `compass_error`: `skyfix_core::methods::compass` with the bodies of
//!   [`crate::auto_provider`] (so a bearing and a sight can never disagree about where a
//!   body is) and, for a magnetic compass without a chart variation, the model's
//!   variation at the observer and the instant.
//!
//! Each export is a thin wrapper over a plain function with an `_impl` suffix, which the
//! native tests call.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use skyfix_core::methods::compass::{CompassErrorResult, CompassRequest, VariationUsed};
use skyfix_ephemeris::ProviderSource;
use skyfix_geomag::{FieldError, MagneticField, ModelChoice};

use crate::{err, to_js};

/// `magnetic_field` when a model answers: every field of [`MagneticField`] plus the
/// instant and the sentences.
#[derive(Debug, Clone, Serialize)]
pub struct AvailableField {
    /// Always `true`.
    pub available: bool,
    pub jd_utc: f64,
    pub utc: String,
    #[serde(flatten)]
    pub field: MagneticField,
    /// `11.5° W`.
    pub variation_text: String,
    /// `5.1′ E a year`.
    pub annual_change_text: String,
    /// `Variation 11.5° W ±0.4° (WMM2025), changing 5.1′ E a year.`
    pub sentence: String,
}

/// `magnetic_field` when no model answers (before 1900, after 2030, or a height outside
/// -1 km to 850 km).
#[derive(Debug, Clone, Serialize)]
pub struct UnavailableField {
    /// Always `false`.
    pub available: bool,
    pub jd_utc: f64,
    pub utc: String,
    pub decimal_year: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub height_m: f64,
    pub reason: String,
}

/// The answer of `magnetic_field`: a discriminated union on `available`.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum MagneticFieldWire {
    Available(Box<AvailableField>),
    Unavailable(UnavailableField),
}

fn parse_model(model: Option<&str>) -> Result<ModelChoice, String> {
    model.unwrap_or("").parse::<ModelChoice>()
}

pub fn magnetic_field_impl(
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
    jd_utc: f64,
    model: Option<&str>,
) -> Result<MagneticFieldWire, String> {
    let choice = parse_model(model)?;
    match skyfix_geomag::field_at_jd(lat_deg, lon_deg, height_m, jd_utc, choice) {
        Ok(field) => Ok(MagneticFieldWire::Available(Box::new(AvailableField {
            available: true,
            jd_utc,
            utc: skyfix_core::time::format_utc(jd_utc),
            variation_text: field.variation_text(),
            annual_change_text: field.annual_change_text(),
            sentence: field.sentence(),
            field,
        }))),
        Err(FieldError::Unavailable(reason)) => {
            Ok(MagneticFieldWire::Unavailable(UnavailableField {
                available: false,
                jd_utc,
                utc: skyfix_core::time::format_utc(jd_utc),
                decimal_year: skyfix_geomag::decimal_year(jd_utc),
                lat_deg,
                lon_deg,
                height_m,
                reason,
            }))
        }
        Err(FieldError::Invalid(message)) => Err(format!("magnetic_field: {message}")),
    }
}

/// The magnetic field at a place and instant: `MagneticField` (EXPLORER_API.md), or
/// `{available: false, reason}` when no model covers it. `model` is optional:
/// `"auto"` (default), `"wmm2025"` or `"igrf14"`. Throws a string for malformed input.
#[wasm_bindgen]
pub fn magnetic_field(
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
    jd_utc: f64,
    model: Option<String>,
) -> Result<JsValue, JsValue> {
    let r =
        magnetic_field_impl(lat_deg, lon_deg, height_m, jd_utc, model.as_deref()).map_err(err)?;
    to_js(&r)
}

// ---------------------------------------------------------------------------
// magnetic_grid
// ---------------------------------------------------------------------------

/// Declination and horizontal intensity on a grid, row by row from `lat_min` (the first
/// `n_lon` values are the southernmost row, west to east).
#[derive(Debug, Clone, PartialEq)]
pub struct MagneticGrid {
    pub model: String,
    pub decimal_year: f64,
    pub lat_deg: Vec<f64>,
    pub lon_deg: Vec<f64>,
    pub declination_deg: Vec<f64>,
    pub horizontal_nt: Vec<f64>,
}

/// Most grid points one call computes (a 1-degree global grid is 65 341).
pub const MAX_GRID_POINTS: usize = 70_000;

#[allow(clippy::too_many_arguments)]
pub fn magnetic_grid_impl(
    jd_utc: f64,
    lat_min: f64,
    lat_max: f64,
    n_lat: u32,
    lon_min: f64,
    lon_max: f64,
    n_lon: u32,
    height_m: f64,
) -> Result<Option<MagneticGrid>, String> {
    for (name, v) in [
        ("jd_utc", jd_utc),
        ("lat_min", lat_min),
        ("lat_max", lat_max),
        ("lon_min", lon_min),
        ("lon_max", lon_max),
        ("height_m", height_m),
    ] {
        if !v.is_finite() {
            return Err(format!("magnetic_grid: {name} must be a finite number"));
        }
    }
    if !(-90.0..=90.0).contains(&lat_min) || !(-90.0..=90.0).contains(&lat_max) || lat_max < lat_min
    {
        return Err("magnetic_grid: need -90 <= lat_min <= lat_max <= 90".into());
    }
    if lon_max < lon_min {
        return Err("magnetic_grid: lon_max must not be below lon_min".into());
    }
    let (nl, nm) = (n_lat as usize, n_lon as usize);
    if nl < 1 || nm < 1 || nl * nm > MAX_GRID_POINTS {
        return Err(format!(
            "magnetic_grid: n_lat and n_lon must be at least 1 and their product at most \
             {MAX_GRID_POINTS}"
        ));
    }
    let step = |min: f64, max: f64, n: usize, i: usize| {
        if n == 1 {
            min
        } else {
            min + (max - min) * i as f64 / (n - 1) as f64
        }
    };
    let lats: Vec<f64> = (0..nl).map(|i| step(lat_min, lat_max, nl, i)).collect();
    let lons: Vec<f64> = (0..nm).map(|i| step(lon_min, lon_max, nm, i)).collect();
    let t = skyfix_geomag::decimal_year(jd_utc);
    match skyfix_geomag::grid(t, ModelChoice::Auto, &lats, &lons, height_m) {
        Ok(g) => Ok(Some(MagneticGrid {
            model: g.model.label().to_string(),
            decimal_year: t,
            lat_deg: lats,
            lon_deg: lons,
            declination_deg: g.declination_deg,
            horizontal_nt: g.horizontal_nt,
        })),
        Err(FieldError::Unavailable(_)) => Ok(None),
        Err(FieldError::Invalid(m)) => Err(format!("magnetic_grid: {m}")),
    }
}

/// Declination on a grid for isogonic lines: `{model, decimal_year, lat_deg, lon_deg,
/// declination_deg, horizontal_nt}` with Float64Arrays (EXPLORER_API.md), or `null` when
/// no model covers the date. Throws a string for malformed input.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn magnetic_grid(
    jd_utc: f64,
    lat_min: f64,
    lat_max: f64,
    n_lat: u32,
    lon_min: f64,
    lon_max: f64,
    n_lon: u32,
    height_m: f64,
) -> Result<JsValue, JsValue> {
    let g = magnetic_grid_impl(
        jd_utc, lat_min, lat_max, n_lat, lon_min, lon_max, n_lon, height_m,
    )
    .map_err(err)?;
    let Some(g) = g else {
        return Ok(JsValue::NULL);
    };
    let out = js_sys::Object::new();
    let set = |k: &str, v: JsValue| js_sys::Reflect::set(&out, &JsValue::from_str(k), &v);
    set("model", JsValue::from_str(&g.model))?;
    set("decimal_year", JsValue::from_f64(g.decimal_year))?;
    set("lat_deg", js_sys::Float64Array::from(&g.lat_deg[..]).into())?;
    set("lon_deg", js_sys::Float64Array::from(&g.lon_deg[..]).into())?;
    set(
        "declination_deg",
        js_sys::Float64Array::from(&g.declination_deg[..]).into(),
    )?;
    set(
        "horizontal_nt",
        js_sys::Float64Array::from(&g.horizontal_nt[..]).into(),
    )?;
    Ok(out.into())
}

// ---------------------------------------------------------------------------
// compass_error
// ---------------------------------------------------------------------------

pub fn compass_error_impl(request_json: &str) -> Result<CompassErrorResult, String> {
    let mut req: CompassRequest =
        serde_json::from_str(request_json.trim()).map_err(|e| format!("compass_error: {e}"))?;
    req.body = skyfix_ephemeris::body::canonical(&req.body)
        .ok_or_else(|| format!("compass_error: unknown body {:?}", req.body))?
        .to_string();
    let choice =
        parse_model(req.magnetic_model.as_deref()).map_err(|e| format!("compass_error: {e}"))?;
    let obs = req.observer;
    let model = move |jd: f64| -> Result<VariationUsed, String> {
        let f = skyfix_geomag::field_at_jd(obs.lat_deg, obs.lon_deg, obs.height_m, jd, choice)
            .map_err(|e| e.to_string())?;
        Ok(VariationUsed {
            deg: f.declination_deg,
            sigma_deg: Some(f.uncertainty.declination_deg),
            source: f.model.label().to_string(),
            text: f.variation_text(),
            notes: f.notes.clone(),
        })
    };
    // The explorer's own Earth rotation (DUT1 at the instant: the explorer-wide user
    // value, else the IERS history, else 0; CONVENTIONS 15.2), so a bearing and the Sky
    // view never disagree about where a body is.
    let jd_utc = match (req.jd_utc, req.utc.as_deref()) {
        (Some(jd), _) => jd,
        (None, Some(utc)) => {
            skyfix_core::time::parse_utc(utc).map_err(|e| format!("compass_error: utc: {e}"))?
        }
        (None, None) => return Err("compass_error: give utc or jd_utc".to_string()),
    };
    let source = ProviderSource(crate::nav::auto_provider_with_dut1(
        crate::explorer::native::dut1_at(jd_utc),
    ));
    skyfix_core::methods::compass::compass_error(&req, &source, Some(&model))
        .map_err(|e| format!("compass_error: {e}"))
}

/// Compass error by azimuth or amplitude: `CompassError` (EXPLORER_API.md). Throws a
/// string for malformed input, an unknown body, or a body the engine cannot place.
#[wasm_bindgen]
pub fn compass_error(request_json: &str) -> Result<JsValue, JsValue> {
    let r = compass_error_impl(request_json).map_err(err)?;
    to_js(&r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jd(s: &str) -> f64 {
        skyfix_core::time::parse_utc(s).unwrap()
    }

    #[test]
    fn the_field_comes_through_with_its_sentence_and_every_documented_key() {
        let r =
            magnetic_field_impl(39.9526, -75.1652, 0.0, jd("2026-09-24T12:00:00Z"), None).unwrap();
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["model"], "WMM2025");
        for key in [
            "jd_utc",
            "utc",
            "decimal_year",
            "lat_deg",
            "lon_deg",
            "height_m",
            "declination_deg",
            "inclination_deg",
            "horizontal_nt",
            "north_nt",
            "east_nt",
            "down_nt",
            "total_nt",
            "annual_change",
            "uncertainty",
            "zone",
            "forecast",
            "notes",
            "variation_text",
            "annual_change_text",
            "sentence",
        ] {
            assert!(json.get(key).is_some(), "{key} missing: {json}");
        }
        assert_eq!(json["zone"], "normal");
        assert!(
            json["uncertainty"]["basis"]
                .as_str()
                .unwrap()
                .contains("WMM2025")
        );
        assert!(
            json["sentence"]
                .as_str()
                .unwrap()
                .starts_with("Variation 1")
        );
        // 1950 is IGRF-14's.
        let old =
            magnetic_field_impl(39.9526, -75.1652, 0.0, jd("1950-06-01T00:00:00Z"), None).unwrap();
        assert_eq!(serde_json::to_value(&old).unwrap()["model"], "IGRF-14");
    }

    #[test]
    fn outside_1900_to_2030_the_answer_is_a_reason_not_an_error() {
        for utc in ["1850-01-01T00:00:00Z", "2045-01-01T00:00:00Z"] {
            let r = magnetic_field_impl(40.0, -75.0, 0.0, jd(utc), None).unwrap();
            let json = serde_json::to_value(&r).unwrap();
            assert_eq!(json["available"], false, "{utc}");
            assert!(
                json["reason"]
                    .as_str()
                    .unwrap()
                    .contains("No magnetic variation")
            );
            assert!(json.get("declination_deg").is_none());
        }
        // Explicitly WMM2025 before 2025 is unavailable too; malformed input throws.
        let r = magnetic_field_impl(
            40.0,
            -75.0,
            0.0,
            jd("2020-01-01T00:00:00Z"),
            Some("wmm2025"),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap()["available"], false);
        assert!(magnetic_field_impl(95.0, 0.0, 0.0, jd("2026-01-01T00:00:00Z"), None).is_err());
        assert!(
            magnetic_field_impl(40.0, 0.0, 0.0, jd("2026-01-01T00:00:00Z"), Some("chaos")).is_err()
        );
    }

    #[test]
    fn the_grid_matches_single_points_and_refuses_uncovered_dates() {
        let t = jd("2026-01-01T00:00:00Z");
        let g = magnetic_grid_impl(t, -60.0, 60.0, 5, -180.0, 180.0, 7, 0.0)
            .unwrap()
            .unwrap();
        assert_eq!(g.model, "WMM2025");
        assert_eq!(g.declination_deg.len(), 35);
        let one = skyfix_geomag::field(
            g.lat_deg[2],
            g.lon_deg[3],
            0.0,
            g.decimal_year,
            ModelChoice::Auto,
        )
        .unwrap();
        assert_eq!(g.declination_deg[2 * 7 + 3], one.declination_deg);
        assert!(
            magnetic_grid_impl(jd("2040-01-01T00:00:00Z"), 0.0, 1.0, 2, 0.0, 1.0, 2, 0.0)
                .unwrap()
                .is_none()
        );
        assert!(magnetic_grid_impl(t, 0.0, 1.0, 1000, 0.0, 1.0, 1000, 0.0).is_err());
        assert!(magnetic_grid_impl(t, 10.0, 0.0, 2, 0.0, 1.0, 2, 0.0).is_err());
    }

    /// The brief's acceptance: the azimuth method matches the engine's own Zn to 0.01 deg.
    /// `sky_state`'s `az_deg` is the explorer's topocentric azimuth (CONVENTIONS 13.2).
    /// Venus differs by up to 0.006 deg by design: a compass bearing, like a sight, is of
    /// its centre of light (CONVENTIONS 7), `sky_state` shows its geometric centre.
    #[test]
    fn the_azimuth_method_is_the_engines_own_azimuth() {
        let mut worst: Vec<(String, f64)> = Vec::new();
        let places = [
            (39.9526, -75.1652),
            (-33.87, 151.21),
            (64.13, -21.9),
            (0.5, 100.0),
        ];
        let times = [
            "2026-09-24T21:15:00Z",
            "2031-03-02T06:40:00Z",
            "1995-12-21T15:00:00Z",
            "2049-06-30T11:11:11Z",
        ];
        for (lat, lon) in places {
            for utc in times {
                let observer = format!(r#"{{"lat_deg": {lat}, "lon_deg": {lon}, "height_m": 30}}"#);
                let sky = crate::explorer::native::sky_state(
                    &observer,
                    jd(utc),
                    r#"["Sun","Moon","Venus","Jupiter","Vega","Sirius","Polaris"]"#,
                )
                .unwrap();
                for b in &sky.bodies {
                    let req = format!(
                        r#"{{"method": "azimuth", "body": "{}", "utc": "{utc}",
                            "observer": {{"lat_deg": {lat}, "lon_deg": {lon}, "height_m": 30}},
                            "compass_bearing_deg": 0, "compass": "gyro"}}"#,
                        b.body
                    );
                    let r = compass_error_impl(&req).unwrap();
                    let d = skyfix_core::units::norm_180(r.true_bearing_deg - b.az_deg).abs();
                    // Near the zenith an azimuth is ill-defined; compare where it is not.
                    if b.alt_deg < 85.0 {
                        match worst.iter_mut().find(|(n, _)| *n == b.body) {
                            Some((_, w)) => *w = w.max(d),
                            None => worst.push((b.body.clone(), d)),
                        }
                        assert!(d < 0.01, "{} at {utc} from {lat},{lon}: {d}", b.body);
                    }
                }
            }
        }
        println!("azimuth method against sky_state az_deg, worst per body (deg):");
        for (b, w) in &worst {
            println!("  {b:<8} {w:.5}");
            if b != "Venus" {
                assert!(*w < 0.001, "{b}: {w}");
            }
        }
    }

    #[test]
    fn a_magnetic_compass_gets_the_models_variation_and_its_sentence() {
        let req = r#"{"method": "azimuth", "body": "sun", "utc": "2026-09-24T21:15:00Z",
                      "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652},
                      "compass_bearing_deg": 275.0}"#;
        let r = compass_error_impl(req).unwrap();
        assert_eq!(r.body, "Sun");
        let v = r.variation.as_ref().unwrap();
        assert_eq!(v.source, "WMM2025");
        assert!(v.deg < -10.0 && v.deg > -13.0);
        assert!(r.sentence.starts_with("Compass error ") && r.sentence.contains("; variation 1"));
        assert!(r.sentence.contains("; deviation "));
        // Before 2025 the variation is IGRF-14's; a chart variation wins over both.
        let r = compass_error_impl(&req.replace("2026-09-24", "2016-02-23")).unwrap();
        assert_eq!(r.variation.as_ref().unwrap().source, "IGRF-14");
        let given = req.replace(
            r#""compass_bearing_deg""#,
            r#""variation_deg": -12.5, "compass_bearing_deg""#,
        );
        let r = compass_error_impl(&given).unwrap();
        assert_eq!(r.variation.as_ref().unwrap().source, "given");
        // An amplitude: the Sun setting that evening, on the visible horizon from 2.5 m.
        let amp = r#"{"method": "amplitude", "body": "Sun", "utc": "2026-09-24T22:50:00Z",
                      "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652},
                      "compass_bearing_deg": 285.0, "height_of_eye_m": 2.5}"#;
        let r = compass_error_impl(amp).unwrap();
        let a = r.amplitude.as_ref().unwrap();
        assert!(a.amplitude_text.as_ref().unwrap().starts_with("W "));
        assert!(r.explanation.contains("set bearing"));
        // Malformed input and unknown bodies throw.
        assert!(compass_error_impl("{}").is_err());
        assert!(compass_error_impl(&req.replace("\"sun\"", "\"Vulcan\"")).is_err());
    }
}

#[cfg(test)]
mod api_example {
    /// The `compass_error` example in docs/EXPLORER_API.md parses and gives the answer the
    /// document states.
    #[test]
    fn the_documented_compass_error_example_works() {
        let doc = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/EXPLORER_API.md"),
        )
        .unwrap();
        let start = doc.find("\"compass_bearing_deg\": 272.0").unwrap();
        let open = doc[..start].rfind("```json").unwrap() + "```json".len();
        let close = open + doc[open..].find("```").unwrap();
        let r = super::compass_error_impl(&doc[open..close]).unwrap();
        println!("{}", r.sentence);
        assert!(
            doc.contains(&r.sentence),
            "the document should quote {:?}",
            r.sentence
        );
    }
}
