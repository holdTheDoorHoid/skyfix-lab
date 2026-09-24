//! WASM exports for the explorer: explorer.
//!
//! OWNER: events agent (wave 1). Wire format: docs/EXPLORER_API.md, "Wave 1 — explorer
//! core"; numeric definitions: CONVENTIONS section 13.
//!
//! Two layers:
//!
//! - [`native`]: plain Rust functions taking the same JSON strings and numbers as the
//!   exports and returning serde types (or a `String` error). Everything testable
//!   lives here, and the tests run natively, without a browser.
//! - the `#[wasm_bindgen]` exports below: parse nothing themselves, call [`native`],
//!   and serialise with `Serializer::json_compatible` (`None` is `null`), except
//!   `sample_bodies`, whose arrays are real `Float64Array`s built with `js_sys`.
//!
//! The astronomy is always [`skyfix_ephemeris::body::Sky`] with DUT1 = 0 (CONVENTIONS
//! section 6): the Sun, Moon, planets and the 58 stars behind one provider. The Moon and
//! planet providers are stubs until their agents land; until then those bodies come back
//! in `errors`, never as invented positions.

use js_sys::{Array, Float64Array, Object, Reflect};
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: JSON in, serde types out, `String` errors.
pub mod native {
    use serde::{Deserialize, Serialize};
    use skyfix_almanac::events::{
        self, AltitudeCrossing, DayEvents, EventOptions, PhaseEvent, SeasonEvent, Sidereal,
    };
    use skyfix_almanac::sky::{self, BodyInfo, Sampled, SkyState};
    use skyfix_core::time::parse_utc;
    use skyfix_ephemeris::body::Sky;
    use skyfix_ephemeris::moon::MoonProvider;
    use skyfix_ephemeris::planets::PlanetProvider;
    use skyfix_ephemeris::stars::StarProvider;
    use skyfix_ephemeris::sun::SunProvider;
    use skyfix_ephemeris::{AstroProvider, Coverage};

    /// The explorer's astronomy: every body, DUT1 = 0.
    pub fn sky() -> Sky {
        Sky::new()
    }

    // -----------------------------------------------------------------------
    // Inputs
    // -----------------------------------------------------------------------

    /// `observer_json`: only `lat_deg` and `lon_deg` are required. A missing or `null`
    /// optional field takes its default (EXPLORER_API.md "Common rules").
    #[derive(Debug, Clone, Deserialize)]
    struct ObserverJson {
        lat_deg: f64,
        lon_deg: f64,
        #[serde(default)]
        height_m: Option<f64>,
        #[serde(default)]
        pressure_hpa: Option<f64>,
        #[serde(default)]
        temperature_c: Option<f64>,
    }

    /// Parse and check `observer_json` (longitude normalised to `(-180, 180]`).
    pub fn parse_observer(
        observer_json: &str,
    ) -> Result<skyfix_ephemeris::topocentric::Site, String> {
        let o: ObserverJson =
            serde_json::from_str(observer_json.trim()).map_err(|e| format!("observer: {e}"))?;
        let d = skyfix_ephemeris::topocentric::Site::default();
        let site = skyfix_ephemeris::topocentric::Site {
            lat_deg: o.lat_deg,
            lon_deg: o.lon_deg,
            height_m: o.height_m.unwrap_or(d.height_m),
            pressure_hpa: o.pressure_hpa.unwrap_or(d.pressure_hpa),
            temperature_c: o.temperature_c.unwrap_or(d.temperature_c),
        };
        sky::checked_site(&site).map_err(|e| e.to_string())
    }

    /// Parse `bodies_json`: a JSON array of names, or one of the strings `"all"`,
    /// `"solar_system"`, `"navigational"` (with or without the JSON quotes), or a single
    /// body name. Canonical spellings, request order, no duplicates. An unknown name is
    /// an error.
    pub fn parse_bodies(bodies_json: &str) -> Result<Vec<&'static str>, String> {
        let t = bodies_json.trim();
        if t.is_empty() {
            return Err(
                "bodies: empty; pass a JSON array of names or one of \"all\", \
                 \"solar_system\", \"navigational\""
                    .to_string(),
            );
        }
        let one = |name: &str| -> Result<Vec<&'static str>, String> {
            match sky::body_group(name) {
                Some(v) => Ok(v),
                None => sky::resolve_bodies(&[name]).map_err(|e| format!("bodies: {e}")),
            }
        };
        match serde_json::from_str::<serde_json::Value>(t) {
            Ok(serde_json::Value::String(s)) => one(&s),
            Ok(serde_json::Value::Array(items)) => {
                let mut names = Vec::with_capacity(items.len());
                for (i, v) in items.iter().enumerate() {
                    match v.as_str() {
                        Some(s) => names.push(s.to_string()),
                        None => return Err(format!("bodies[{i}] is not a string: {v}")),
                    }
                }
                sky::resolve_bodies(&names).map_err(|e| format!("bodies: {e}"))
            }
            Ok(other) => Err(format!(
                "bodies: expected an array of names or a group name, got {other}"
            )),
            // Not JSON at all: accept a bare group or body name, e.g. `all`.
            Err(_) => one(t),
        }
    }

    /// Parse `options_json`; empty means the defaults.
    pub fn parse_options(options_json: &str) -> Result<EventOptions, String> {
        let t = options_json.trim();
        if t.is_empty() || t == "null" {
            return Ok(EventOptions::default());
        }
        serde_json::from_str::<EventOptions>(t).map_err(|e| format!("options: {e}"))
    }

    // -----------------------------------------------------------------------
    // Coverage
    // -----------------------------------------------------------------------

    /// One provider group of `explorer_coverage`.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct CoverageGroup {
        pub name: String,
        pub provider: String,
        /// The provider's documented accuracy; `null` when it has none (a stub).
        pub accuracy_arcmin: Option<f64>,
        /// `accuracy_arcmin` is finite and at most 0.1' (CONVENTIONS 13.7): only then is
        /// the group offered for sights.
        pub validated: bool,
        pub notes: String,
        /// Canonical names of the bodies this group covers.
        pub bodies: Vec<String>,
    }

    /// `explorer_coverage` result.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ExplorerCoverage {
        /// The range every group covers (the intersection of the groups' ranges).
        pub start_utc: String,
        pub end_utc: String,
        pub groups: Vec<CoverageGroup>,
    }

    /// The largest `accuracy_arcmin` a group may declare and still be offered for
    /// sights: the 0.1' target of CONVENTIONS 13.7.
    pub const VALIDATED_ACCURACY_ARCMIN: f64 = 0.1;

    fn group(name: &str, provider: &str, c: Coverage) -> CoverageGroup {
        let a = c.accuracy_arcmin;
        CoverageGroup {
            name: name.to_string(),
            provider: provider.to_string(),
            accuracy_arcmin: a.is_finite().then_some(a),
            validated: a.is_finite() && a <= VALIDATED_ACCURACY_ARCMIN,
            notes: c.notes,
            bodies: c.bodies,
        }
    }

    pub fn explorer_coverage() -> ExplorerCoverage {
        let sun = SunProvider::new();
        let moon = MoonProvider::new();
        let planets = PlanetProvider::new();
        let stars = StarProvider::new();
        let parts = [
            ("Sun", sun.name().to_string(), sun.coverage()),
            ("Moon", moon.name().to_string(), moon.coverage()),
            ("Planets", planets.name().to_string(), planets.coverage()),
            ("Stars", stars.name().to_string(), stars.coverage()),
        ];
        // Intersection of the ranges; a range that does not parse is ignored.
        let mut start: Option<(f64, String)> = None;
        let mut end: Option<(f64, String)> = None;
        for (_, _, c) in &parts {
            if let Ok(s) = parse_utc(&c.start_utc) {
                if start.as_ref().is_none_or(|(v, _)| s > *v) {
                    start = Some((s, c.start_utc.clone()));
                }
            }
            if let Ok(e) = parse_utc(&c.end_utc) {
                if end.as_ref().is_none_or(|(v, _)| e < *v) {
                    end = Some((e, c.end_utc.clone()));
                }
            }
        }
        ExplorerCoverage {
            start_utc: start.map(|s| s.1).unwrap_or_default(),
            end_utc: end.map(|e| e.1).unwrap_or_default(),
            groups: parts.into_iter().map(|(n, p, c)| group(n, &p, c)).collect(),
        }
    }

    // -----------------------------------------------------------------------
    // Calls
    // -----------------------------------------------------------------------

    pub fn explorer_bodies() -> Vec<BodyInfo> {
        sky::body_catalogue()
    }

    pub fn sky_state(
        observer_json: &str,
        jd_utc: f64,
        bodies_json: &str,
    ) -> Result<SkyState, String> {
        let site = parse_observer(observer_json)?;
        let bodies = parse_bodies(bodies_json)?;
        sky::sky_state(&sky(), &site, jd_utc, &bodies).map_err(|e| e.to_string())
    }

    pub fn sample_bodies(
        observer_json: &str,
        bodies_json: &str,
        jd_start: f64,
        jd_end: f64,
        step_minutes: f64,
    ) -> Result<Sampled, String> {
        let site = parse_observer(observer_json)?;
        let bodies = parse_bodies(bodies_json)?;
        sky::sample_bodies(&sky(), &site, &bodies, jd_start, jd_end, step_minutes)
            .map_err(|e| e.to_string())
    }

    pub fn day_events(
        observer_json: &str,
        jd_start: f64,
        jd_end: f64,
        bodies_json: &str,
        options_json: &str,
    ) -> Result<DayEvents, String> {
        let site = parse_observer(observer_json)?;
        let bodies = parse_bodies(bodies_json)?;
        let options = parse_options(options_json)?;
        events::day_events(&sky(), &site, jd_start, jd_end, &bodies, &options)
            .map_err(|e| e.to_string())
    }

    pub fn day_events_batch(
        observer_json: &str,
        windows_json: &str,
        bodies_json: &str,
        options_json: &str,
    ) -> Result<Vec<DayEvents>, String> {
        let site = parse_observer(observer_json)?;
        let bodies = parse_bodies(bodies_json)?;
        let options = parse_options(options_json)?;
        let windows: Vec<(f64, f64)> = serde_json::from_str(windows_json.trim())
            .map_err(|e| format!("windows: expected [[jd_start, jd_end], ...]: {e}"))?;
        events::day_events_batch(&sky(), &site, &windows, &bodies, &options)
            .map_err(|e| e.to_string())
    }

    pub fn find_altitude(
        observer_json: &str,
        body: &str,
        jd_start: f64,
        jd_end: f64,
        altitude_deg: f64,
    ) -> Result<Vec<AltitudeCrossing>, String> {
        let site = parse_observer(observer_json)?;
        events::find_altitude(&sky(), &site, body, jd_start, jd_end, altitude_deg)
            .map_err(|e| e.to_string())
    }

    pub fn moon_phases(jd_start: f64, jd_end: f64) -> Result<Vec<PhaseEvent>, String> {
        events::moon_phases(&sky(), jd_start, jd_end).map_err(|e| e.to_string())
    }

    /// `year` arrives as a JS number: it must be a whole number.
    pub fn seasons(year: f64) -> Result<Vec<SeasonEvent>, String> {
        if !(year.is_finite() && year.fract() == 0.0 && year.abs() < 1.0e6) {
            return Err(format!("year must be a whole number, got {year}"));
        }
        events::seasons(&sky(), year as i32).map_err(|e| e.to_string())
    }

    pub fn sidereal(jd_utc: f64) -> Result<Sidereal, String> {
        events::sidereal(jd_utc).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Exports (EXPLORER_API.md "Wave 1 — explorer core")
// ---------------------------------------------------------------------------

/// Every body the explorer knows: `[{body, kind, navigational, magnitude}]`.
#[wasm_bindgen]
pub fn explorer_bodies() -> Result<JsValue, JsValue> {
    to_js(&native::explorer_bodies())
}

/// Coverage and validation per provider group:
/// `{start_utc, end_utc, groups: [{name, provider, accuracy_arcmin, validated, notes}]}`.
#[wasm_bindgen]
pub fn explorer_coverage() -> Result<JsValue, JsValue> {
    to_js(&native::explorer_coverage())
}

/// The whole sky from one place at one instant (`SkyState`).
#[wasm_bindgen]
pub fn sky_state(observer_json: &str, jd_utc: f64, bodies_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::sky_state(observer_json, jd_utc, bodies_json).map_err(err)?)
}

fn f64_array(v: &[f64]) -> Float64Array {
    Float64Array::from(v)
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value).map(|_| ())
}

/// Sampled paths: `{jd_utc: Float64Array, bodies: [{body, alt_deg, alt_apparent_deg,
/// az_deg, gha_deg, dec_deg}], errors}`, every array a real `Float64Array`.
#[wasm_bindgen]
pub fn sample_bodies(
    observer_json: &str,
    bodies_json: &str,
    jd_start: f64,
    jd_end: f64,
    step_minutes: f64,
) -> Result<JsValue, JsValue> {
    let s = native::sample_bodies(observer_json, bodies_json, jd_start, jd_end, step_minutes)
        .map_err(err)?;
    let out = Object::new();
    set(&out, "jd_utc", &f64_array(&s.jd_utc))?;
    let bodies = Array::new();
    for b in &s.bodies {
        let o = Object::new();
        set(&o, "body", &JsValue::from_str(&b.body))?;
        set(&o, "alt_deg", &f64_array(&b.alt_deg))?;
        set(&o, "alt_apparent_deg", &f64_array(&b.alt_apparent_deg))?;
        set(&o, "az_deg", &f64_array(&b.az_deg))?;
        set(&o, "gha_deg", &f64_array(&b.gha_deg))?;
        set(&o, "dec_deg", &f64_array(&b.dec_deg))?;
        bodies.push(&o);
    }
    set(&out, "bodies", &bodies)?;
    set(&out, "errors", &to_js(&s.errors)?)?;
    Ok(out.into())
}

/// Rise, set, transits, twilight and the sky phases over one window (`DayEvents`).
#[wasm_bindgen]
pub fn day_events(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    bodies_json: &str,
    options_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(
        &native::day_events(observer_json, jd_start, jd_end, bodies_json, options_json)
            .map_err(err)?,
    )
}

/// `day_events` for up to 400 windows `[[jd_start, jd_end], ...]` (`DayEvents[]`).
#[wasm_bindgen]
pub fn day_events_batch(
    observer_json: &str,
    windows_json: &str,
    bodies_json: &str,
    options_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(
        &native::day_events_batch(observer_json, windows_json, bodies_json, options_json)
            .map_err(err)?,
    )
}

/// Every instant the body's apparent altitude crosses `altitude_deg`
/// (`[{jd_utc, utc, alt_deg, az_deg, rising}]`).
#[wasm_bindgen]
pub fn find_altitude(
    observer_json: &str,
    body: &str,
    jd_start: f64,
    jd_end: f64,
    altitude_deg: f64,
) -> Result<JsValue, JsValue> {
    to_js(&native::find_altitude(observer_json, body, jd_start, jd_end, altitude_deg).map_err(err)?)
}

/// New moon, first quarter, full moon and last quarter in the window.
#[wasm_bindgen]
pub fn moon_phases(jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    to_js(&native::moon_phases(jd_start, jd_end).map_err(err)?)
}

/// Equinoxes and solstices of a calendar year.
#[wasm_bindgen]
pub fn seasons(year: f64) -> Result<JsValue, JsValue> {
    to_js(&native::seasons(year).map_err(err)?)
}

/// `{gha_aries_deg}` at `jd_utc`. Cheap: the Sky view calls it every frame.
#[wasm_bindgen]
pub fn sidereal(jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::sidereal(jd_utc).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::native::*;
    use skyfix_core::time::civil_to_jd;

    const PHILLY: &str = r#"{"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12}"#;

    fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn observers_need_only_latitude_and_longitude() {
        let s = parse_observer(r#"{"lat_deg": 10, "lon_deg": 200}"#).unwrap();
        assert_eq!(
            (s.lon_deg, s.height_m, s.pressure_hpa, s.temperature_c),
            (-160.0, 0.0, 1010.0, 10.0)
        );
        let s = parse_observer(
            r#"{"lat_deg": 1, "lon_deg": 2, "height_m": null, "pressure_hpa": 900, "name": "x"}"#,
        )
        .unwrap();
        assert_eq!((s.height_m, s.pressure_hpa), (0.0, 900.0));
        for bad in [
            r#"{"lon_deg": 2}"#,
            r#"{"lat_deg": 95, "lon_deg": 2}"#,
            r#"{"lat_deg": "north", "lon_deg": 2}"#,
            "",
        ] {
            assert!(parse_observer(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn body_lists_accept_groups_names_and_arrays() {
        assert_eq!(parse_bodies("\"all\"").unwrap().len(), 67);
        assert_eq!(parse_bodies("all").unwrap().len(), 67);
        assert_eq!(parse_bodies(" \"Solar_System\" ").unwrap().len(), 9);
        assert_eq!(parse_bodies("\"navigational\"").unwrap().len(), 64);
        assert_eq!(
            parse_bodies(r#"[" vega", "SUN", "Vega", "hip 32349"]"#).unwrap(),
            vec!["Vega", "Sun", "Sirius"]
        );
        assert_eq!(parse_bodies("\"moon\"").unwrap(), vec!["Moon"]);
        assert!(parse_bodies("[\"Vulcan\"]").unwrap_err().contains("Vulcan"));
        assert!(parse_bodies("[1, 2]").is_err());
        assert!(parse_bodies("").is_err());
        assert!(parse_bodies("{}").is_err());
    }

    #[test]
    fn options_default_and_refuse_nonsense() {
        assert_eq!(parse_options("").unwrap(), Default::default());
        assert_eq!(parse_options("{}").unwrap(), Default::default());
        assert!(parse_options(r#"{"horizon": "dip", "height_of_eye_m": 3}"#).is_ok());
        assert!(parse_options(r#"{"horizon": "sea"}"#).is_err());
        assert!(parse_options(r#"{"height_of_eye": 3}"#).is_err());
    }

    #[test]
    fn coverage_validates_only_groups_within_a_tenth_of_an_arcminute() {
        let c = explorer_coverage();
        let v = json(&c);
        assert_eq!(v["start_utc"], "1990-01-01T00:00:00Z");
        assert_eq!(v["end_utc"], "2060-12-31T23:59:59Z");
        let names: Vec<&str> = c.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["Sun", "Moon", "Planets", "Stars"]);
        for g in &c.groups {
            let want = g.accuracy_arcmin.is_some_and(|a| a <= 0.1);
            assert_eq!(g.validated, want, "{}", g.name);
            assert!(!g.provider.is_empty() && !g.notes.is_empty());
        }
        let sun = &c.groups[0];
        assert!(sun.validated && sun.accuracy_arcmin == Some(0.01));
        assert!(c.groups[3].validated);
        // Each group names its bodies; together they are exactly explorer_bodies().
        assert_eq!(sun.bodies, vec!["Sun"]);
        assert_eq!(c.groups[1].bodies, vec!["Moon"]);
        assert_eq!(c.groups[2].bodies.len(), 7);
        assert_eq!(c.groups[3].bodies.len(), 58);
        let mut all: Vec<String> = c.groups.iter().flat_map(|g| g.bodies.clone()).collect();
        let mut listed: Vec<String> = explorer_bodies().into_iter().map(|b| b.body).collect();
        all.sort();
        listed.sort();
        assert_eq!(all, listed);
        assert!(v["groups"][3]["bodies"].is_array());
        // The stubs: no accuracy (null on the wire, not Infinity), not validated.
        let moon = &v["groups"][1];
        if moon["provider"]
            .as_str()
            .unwrap()
            .contains("not yet implemented")
        {
            assert!(moon["accuracy_arcmin"].is_null());
            assert_eq!(moon["validated"], false);
        }
    }

    #[test]
    fn the_body_list_has_the_documented_shape() {
        let v = json(&explorer_bodies());
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 67);
        assert_eq!(
            arr[1],
            serde_json::json!({"body": "Moon", "kind": "moon", "navigational": true,
                               "magnitude": null})
        );
        let mercury = arr.iter().find(|b| b["body"] == "Mercury").unwrap();
        assert_eq!(mercury["navigational"], false);
        assert_eq!(mercury["kind"], "planet");
        let vega = arr.iter().find(|b| b["body"] == "Vega").unwrap();
        assert!(vega["magnitude"].as_f64().unwrap().abs() < 0.2);
    }

    #[test]
    fn sky_state_has_every_documented_field_and_lists_stubs_as_errors() {
        let jd = civil_to_jd(2026, 9, 24) + 0.5;
        let s = sky_state(PHILLY, jd, "\"all\"").unwrap();
        let v = json(&s);
        for k in [
            "jd_utc",
            "utc",
            "gha_aries_deg",
            "sun_altitude_deg",
            "sky_phase",
            "bodies",
            "errors",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["utc"], "2026-09-24T12:00:00.000Z");
        assert_eq!(v["sky_phase"], "day");
        let sun = &v["bodies"][0];
        for k in [
            "body",
            "kind",
            "gha_deg",
            "dec_deg",
            "sha_deg",
            "ra_deg",
            "gp",
            "alt_deg",
            "az_deg",
            "alt_apparent_deg",
            "hc_deg",
            "zn_deg",
            "above_horizon",
            "distance_km",
            "semidiameter_arcmin",
            "horizontal_parallax_arcmin",
            "magnitude",
            "phase_angle_deg",
            "illuminated_fraction",
            "elongation_deg",
            "bright_limb_angle_deg",
            "parallactic_angle_deg",
            "constellation",
        ] {
            assert!(sun.get(k).is_some(), "BodyState missing {k}");
        }
        assert_eq!(sun["kind"], "sun");
        assert!(sun["constellation"].is_null());
        assert!(sun["gp"]["lat_deg"].is_number() && sun["gp"]["lon_deg"].is_number());
        // 1 Sun + 58 stars; the Moon and 7 planets are stubs in this build.
        let n_ok = s.bodies.len();
        let n_err = s.errors.len();
        assert_eq!(n_ok + n_err, 67);
        for e in &s.errors {
            assert!(e.body == "Moon" || skyfix_ephemeris::body::PLANETS.contains(&e.body.as_str()));
        }
        assert!(sky_state(PHILLY, jd, "[\"Vulcan\"]").is_err());
        assert!(sky_state(PHILLY, f64::NAN, "\"all\"").is_err());
        // Outside the Sun's coverage there is no sky phase: the call fails.
        let e = sky_state(PHILLY, civil_to_jd(1985, 1, 1), "[\"Vega\"]").unwrap_err();
        assert!(e.contains("Sun"), "{e}");
    }

    #[test]
    fn sampled_paths_have_one_value_per_instant() {
        let t0 = civil_to_jd(2026, 9, 24);
        let s = sample_bodies(PHILLY, "[\"Sun\", \"Vega\", \"Moon\"]", t0, t0 + 1.0, 10.0).unwrap();
        assert_eq!(s.jd_utc.len(), 145);
        assert_eq!(s.bodies.len(), 2);
        for b in &s.bodies {
            for v in [
                &b.alt_deg,
                &b.alt_apparent_deg,
                &b.az_deg,
                &b.gha_deg,
                &b.dec_deg,
            ] {
                assert_eq!(v.len(), 145, "{}", b.body);
            }
        }
        assert_eq!(s.errors[0].body, "Moon");
        let e = sample_bodies(PHILLY, "\"Sun\"", t0, t0 + 20.0, 1.0).unwrap_err();
        assert!(e.contains("20000"), "{e}");
    }

    #[test]
    fn day_events_serialise_to_the_documented_shape() {
        let t0 = civil_to_jd(2026, 9, 24);
        let d = day_events(PHILLY, t0, t0 + 1.0, "[\"Sun\", \"Vega\"]", "").unwrap();
        let v = json(&d);
        assert_eq!(v["jd_start"], t0);
        assert_eq!(v["phases"][0]["phase"], "astronomical");
        let sun = &v["bodies"][0];
        assert_eq!(sun["body"], "Sun");
        assert_eq!(sun["always_above"], false);
        assert!(sun["day_length_h"].as_f64().unwrap() > 12.0);
        let e = &sun["events"][0];
        for k in ["kind", "jd_utc", "utc", "alt_deg", "az_deg"] {
            assert!(e.get(k).is_some(), "event missing {k}");
        }
        assert!(v["bodies"][1]["day_length_h"].is_null());
        let kinds: Vec<&str> = sun["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"civil_dawn") && kinds.contains(&"rise"),
            "{kinds:?}"
        );

        let windows = format!("[[{t0}, {}], [{}, {}]]", t0 + 1.0, t0 + 1.0, t0 + 2.0);
        let b = day_events_batch(PHILLY, &windows, "\"Sun\"", "{}").unwrap();
        assert_eq!(b.len(), 2);
        let too_many = format!(
            "[{}]",
            (0..401)
                .map(|i| format!("[{}, {}]", t0 + f64::from(i), t0 + f64::from(i) + 1.0))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(day_events_batch(PHILLY, &too_many, "\"Sun\"", "").is_err());
        assert!(day_events_batch(PHILLY, "[[1, 2, 3]]", "\"Sun\"", "").is_err());
    }

    #[test]
    fn find_altitude_seasons_phases_and_sidereal() {
        let t0 = civil_to_jd(2026, 9, 24);
        let v = find_altitude(PHILLY, "sun", t0, t0 + 1.0, 30.0).unwrap();
        assert_eq!(v.len(), 2);
        assert!(v[0].rising && !v[1].rising);
        assert!(find_altitude(PHILLY, "Moon", t0, t0 + 1.0, 30.0).is_err());

        let s = json(&seasons(2026.0).unwrap());
        assert_eq!(s[0]["kind"], "march_equinox");
        assert_eq!(s[3]["kind"], "december_solstice");
        assert!(
            s[2]["utc"]
                .as_str()
                .unwrap()
                .starts_with("2026-09-23T00:05")
        );
        assert!(seasons(2026.5).is_err());
        assert!(seasons(1980.0).is_err());

        // The Moon provider is a stub in this build: phases need it.
        match moon_phases(t0, t0 + 30.0) {
            Ok(p) => assert!(p.len() >= 3),
            Err(e) => assert!(e.contains("Moon"), "{e}"),
        }
        let g = sidereal(t0).unwrap();
        assert!((0.0..360.0).contains(&g.gha_aries_deg));
        assert!(sidereal(f64::INFINITY).is_err());
    }
}
