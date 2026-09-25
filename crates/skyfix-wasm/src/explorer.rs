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
//! The astronomy is always [`skyfix_ephemeris::body::Sky`]: the Sun, Moon, planets and
//! the 58 stars behind one provider, built per request by [`native::sky_at`] with DUT1
//! from `skyfix_core::time::dut1_s` at the request's instant (the explorer-wide
//! `set_dut1` value, else the IERS history, else 0; CONVENTIONS 15.2). A window uses the
//! DUT1 of its middle: DUT1 drifts by a few milliseconds a day, so only a window across
//! a leap second is off, by at most 1 s of UT1 (15") on one side. A body the
//! provider cannot answer for (outside its coverage) comes back in `errors`, never as an
//! invented position. `BodyState.constellation` is the one value joined in from the
//! display-only star field (`skyfix_starfield::constellation_at`), here and not in
//! `skyfix-almanac` (CONVENTIONS 13.6).

use js_sys::{Array, Float64Array, Object, Reflect};
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: JSON in, serde types out, `String` errors.
pub mod native {
    use serde::Deserialize;
    use skyfix_almanac::events::{
        self, AltitudeCrossing, DayEvents, EventOptions, PhaseEvent, SeasonEvent, Sidereal,
    };
    use skyfix_almanac::sky::{self, BodyInfo, Sampled, SkyState};
    use skyfix_ephemeris::body::Sky;
    use skyfix_ephemeris::tiers::TierPolicy;

    /// The explorer's astronomy with DUT1 = 0: for results that do not depend on the
    /// Earth's rotation (Moon phases, seasons). It answers both coverage tiers
    /// (deeptime agent, CONVENTIONS 15.1): the explorer displays 2000 BC to AD 3000,
    /// the labelled tier marked by `tier_at`; sights and plans use their own providers,
    /// which refuse it.
    pub fn sky() -> Sky {
        Sky::new().with_policy(TierPolicy::WithLabelled)
    }

    /// The explorer's astronomy at `jd_utc`: DUT1 from `skyfix_core::time::dut1_s` with
    /// the explorer-wide user value (`timescale::set_dut1`), the IERS history, or 0.
    /// Both tiers, as [`sky`].
    pub fn sky_at(jd_utc: f64) -> Sky {
        Sky::with_dut1_s(dut1_at(jd_utc)).with_policy(TierPolicy::WithLabelled)
    }

    /// DUT1 at `jd_utc` as the explorer uses it.
    pub fn dut1_at(jd_utc: f64) -> f64 {
        if jd_utc.is_finite() {
            skyfix_core::time::dut1_s(jd_utc, crate::timescale::user_dut1())
        } else {
            0.0
        }
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
    // Coverage (deeptime agent: `crate::coverage`, with the tiers)
    // -----------------------------------------------------------------------

    pub use crate::coverage::native::{
        CoverageGroup, ExplorerCoverage, VALIDATED_ACCURACY_ARCMIN, explorer_coverage,
    };

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
        let mut s =
            sky::sky_state(&sky_at(jd_utc), &site, jd_utc, &bodies).map_err(|e| e.to_string())?;
        // The constellation comes from the display-only star field, joined here and
        // only here: skyfix-almanac must not depend on it (CONVENTIONS 13.6). A
        // direction the boundaries cannot place stays `null`.
        for b in &mut s.bodies {
            b.constellation = skyfix_starfield::constellation_at(b.ra_deg, b.dec_deg, jd_utc)
                .ok()
                .map(str::to_string);
        }
        Ok(s)
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
        let sky = sky_at(0.5 * (jd_start + jd_end));
        sky::sample_bodies(&sky, &site, &bodies, jd_start, jd_end, step_minutes)
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
        let sky = sky_at(0.5 * (jd_start + jd_end));
        events::day_events(&sky, &site, jd_start, jd_end, &bodies, &options)
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
        let mid = match (windows.first(), windows.last()) {
            (Some(a), Some(b)) => 0.5 * (a.0 + b.1),
            _ => f64::NAN,
        };
        events::day_events_batch(&sky_at(mid), &site, &windows, &bodies, &options)
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
        let sky = sky_at(0.5 * (jd_start + jd_end));
        events::find_altitude(&sky, &site, body, jd_start, jd_end, altitude_deg)
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

    /// GHA Aries with the same DUT1 as `sky_state` at that instant.
    pub fn sidereal(jd_utc: f64) -> Result<Sidereal, String> {
        let s = events::sidereal(jd_utc).map_err(|e| e.to_string())?;
        let dut1 = dut1_at(jd_utc);
        if dut1 == 0.0 {
            return Ok(s);
        }
        Ok(Sidereal {
            gha_aries_deg: skyfix_ephemeris::sidereal::gha_aries_deg(jd_utc, dut1),
        })
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

/// Coverage and validation per provider group, with the tiers (deeptime agent):
/// `{start_utc, end_utc, validated_start_utc, validated_end_utc, packs_loaded,
/// groups: [{name, provider, accuracy_arcmin, validated, notes, bodies, tiers}]}`.
#[wasm_bindgen]
pub fn explorer_coverage() -> Result<JsValue, JsValue> {
    crate::coverage::explorer_coverage_js()
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
        // deeptime agent: both tiers are in the core; the validated one is named apart.
        assert_eq!(v["start_utc"], "-2000-01-01T00:00:00Z");
        assert_eq!(v["end_utc"], "3000-12-31T23:59:59Z");
        assert_eq!(v["validated_start_utc"], "1550-01-01T00:00:00Z");
        assert_eq!(v["validated_end_utc"], "2650-01-22T00:00:00Z");
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
        // Every group is a real provider now: the Moon (0.02') and the planets (0.03',
        // deeptime agent's fitted series) are validated too, so the UI offers the Moon
        // and the four planets for sights.
        assert!(c.groups[1].validated && c.groups[1].accuracy_arcmin == Some(0.02));
        assert!(c.groups[2].validated && c.groups[2].accuracy_arcmin == Some(0.03));
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
    fn sky_state_has_every_documented_field_and_the_constellations() {
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
        assert!(sun["gp"]["lat_deg"].is_number() && sun["gp"]["lon_deg"].is_number());
        // Constellations come from the star field's IAU boundaries: the Sun is in
        // Virgo in late September, and the stars are where their names say.
        assert_eq!(sun["constellation"], "Vir");
        let con = |name: &str| {
            s.bodies
                .iter()
                .find(|b| b.body == name)
                .and_then(|b| b.constellation.clone())
        };
        for (star, abbr) in [
            ("Vega", "Lyr"),
            ("Sirius", "CMa"),
            ("Polaris", "UMi"),
            ("Acrux", "Cru"),
            ("Rigil Kentaurus", "Cen"),
            ("Al Na'ir", "Gru"),
        ] {
            assert_eq!(con(star).as_deref(), Some(abbr), "{star}");
        }
        assert!(s.bodies.iter().all(|b| b.constellation.is_some()));
        // Inside coverage every body is computed: the Moon and the planets are real
        // providers, so an error here is a regression, not a stub (verifier: this used
        // to accept the Moon and every planet failing).
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert_eq!(s.bodies.len(), 67);
        assert!(sky_state(PHILLY, jd, "[\"Vulcan\"]").is_err());
        assert!(sky_state(PHILLY, f64::NAN, "\"all\"").is_err());
        // Outside the Sun's coverage there is no sky phase: the call fails (deeptime
        // agent: the explorer answers 2000 BC to AD 3000, so the test goes past 3000).
        let e = sky_state(PHILLY, civil_to_jd(3001, 6, 1), "[\"Vega\"]").unwrap_err();
        assert!(e.contains("Sun"), "{e}");
        // Inside the labelled tier the explorer shows the sky.
        let old = sky_state(PHILLY, civil_to_jd(-584, 5, 28), "[\"Sun\", \"Moon\"]").unwrap();
        assert!(old.errors.is_empty(), "{:?}", old.errors);
    }

    #[test]
    fn sampled_paths_have_one_value_per_instant() {
        let t0 = civil_to_jd(2026, 9, 24);
        let s = sample_bodies(PHILLY, "[\"Sun\", \"Vega\", \"Moon\"]", t0, t0 + 1.0, 10.0).unwrap();
        assert_eq!(s.jd_utc.len(), 145);
        // Every body is sampled: the Moon is a real provider (this used to accept it
        // failing, from when it was a stub).
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert_eq!(s.bodies.len(), 3);
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
        // A body outside its coverage cannot be searched: that throws (past AD 3000).
        let e = find_altitude(PHILLY, "Vega", 2_900_000.5, 2_900_001.5, 30.0).unwrap_err();
        assert!(e.contains("Vega"), "{e}");

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
        assert!(seasons(3001.0).is_err());
        // The labelled tier: the equinoxes of 1000 AD are found, for display.
        assert_eq!(seasons(1000.0).unwrap().len(), 4);

        // Thirty days hold three or four principal phases.
        let p = moon_phases(t0, t0 + 30.0).unwrap();
        assert!((3..=5).contains(&p.len()), "{p:?}");
        // Outside the Moon's coverage the call says why.
        let e = moon_phases(2_900_000.5, 2_900_030.5).unwrap_err();
        assert!(e.contains("Moon"), "{e}");
        let g = sidereal(t0).unwrap();
        assert!((0.0..360.0).contains(&g.gha_aries_deg));
        assert!(sidereal(f64::INFINITY).is_err());
    }
}
