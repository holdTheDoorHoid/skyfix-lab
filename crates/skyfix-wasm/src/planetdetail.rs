//! WASM exports for the explorer: planet detail (expansion programme P9).
//!
//! OWNER: planetdetail agent. Wire format: `docs/EXPLORER_API.md`, "Planet detail";
//! TypeScript mirror: `PlanetDetailEngine` in `web/src/next/engine/types.ts`. The
//! engines are `skyfix_almanac::{discs, rings, satellites, transits, conjunctions,
//! earth_apsides, orbits}`; everything here is argument parsing and serialisation
//! (`Serializer::json_compatible`, so `None` is `null`), except `sample_custom_bodies`,
//! whose arrays are real `Float64Array`s as `sample_bodies`' are.
//!
//! [`native`] holds the same calls with JSON strings in and serde types out, so they are
//! tested natively.

use js_sys::{Array, Float64Array, Object, Reflect};
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: JSON in, serde types out, `String` errors.
pub mod native {
    use serde::Serialize;
    use skyfix_almanac::conjunctions::{self, ConjunctionList, ConjunctionOptions, StationList};
    use skyfix_almanac::discs::{PlanetDisc, planet_disc as disc};
    use skyfix_almanac::earth_apsides::{self, EarthApsides};
    use skyfix_almanac::orbits::{self, OrbitalElements};
    use skyfix_almanac::rings::{self, SaturnRings};
    use skyfix_almanac::satellites::{self, GalileanEvents, GalileanMoons};
    use skyfix_almanac::sky::BodyError;
    use skyfix_almanac::transits::{self, TransitList};
    use skyfix_core::time::format_utc;
    use skyfix_ephemeris::planets::{Planet, PlanetProvider};

    use crate::explorer::native::parse_observer;

    pub fn galilean_moons(jd_utc: f64) -> Result<GalileanMoons, String> {
        satellites::galilean_moons(jd_utc).map_err(|e| e.to_string())
    }

    pub fn galilean_events(jd_start: f64, jd_end: f64) -> Result<GalileanEvents, String> {
        satellites::galilean_events(jd_start, jd_end).map_err(|e| e.to_string())
    }

    pub fn saturn_rings(jd_utc: f64) -> Result<SaturnRings, String> {
        rings::saturn_rings(&PlanetProvider::new(), jd_utc).map_err(|e| e.to_string())
    }

    pub fn planet_disc(body: &str, jd_utc: f64) -> Result<PlanetDisc, String> {
        let planet = Planet::from_name(body).ok_or_else(|| {
            format!("planet_disc: {body:?} is not a planet (Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune)")
        })?;
        disc(&PlanetProvider::new(), planet, jd_utc).map_err(|e| e.to_string())
    }

    /// `observer_json` may be empty or `null` for the geocentric circumstances only.
    pub fn transits(
        jd_start: f64,
        jd_end: f64,
        observer_json: &str,
    ) -> Result<TransitList, String> {
        let o = observer_json.trim();
        let site = if o.is_empty() || o == "null" || o == "undefined" {
            None
        } else {
            Some(parse_observer(o)?)
        };
        transits::transits(&PlanetProvider::new(), jd_start, jd_end, site.as_ref())
            .map_err(|e| e.to_string())
    }

    /// `options_json`: `ConjunctionOptions`; `""`, `null` or `{}` for every default.
    pub fn conjunctions(
        jd_start: f64,
        jd_end: f64,
        options_json: &str,
    ) -> Result<ConjunctionList, String> {
        let o = options_json.trim();
        let opts: ConjunctionOptions = if o.is_empty() || o == "null" {
            ConjunctionOptions::default()
        } else {
            serde_json::from_str(o).map_err(|e| format!("conjunctions options: {e}"))?
        };
        conjunctions::conjunctions(jd_start, jd_end, &opts).map_err(|e| e.to_string())
    }

    pub fn stations(jd_start: f64, jd_end: f64) -> Result<StationList, String> {
        conjunctions::stations(jd_start, jd_end).map_err(|e| e.to_string())
    }

    pub fn earth_apsides(year: f64) -> Result<EarthApsides, String> {
        if !year.is_finite() || year.fract() != 0.0 || year.abs() > 1e6 {
            return Err(format!(
                "earth_apsides: year must be a whole number (got {year})"
            ));
        }
        earth_apsides::earth_apsides(year as i32).map_err(|e| e.to_string())
    }

    pub fn parse_orbits(text: &str) -> Result<Vec<OrbitalElements>, String> {
        orbits::parse_orbits(text)
    }

    /// One custom body as the explorer shows it: `BodyState`'s fields (kind `"comet"`
    /// or `"asteroid"`, `custom: true`) and the orbit's own.
    #[derive(Debug, Clone, Serialize)]
    pub struct CustomBodyStates {
        pub jd_utc: f64,
        pub utc: String,
        pub bodies: Vec<serde_json::Value>,
        pub errors: Vec<BodyError>,
    }

    fn custom_list(json: &str) -> Result<Vec<OrbitalElements>, String> {
        let t = json.trim();
        if t.is_empty() || t == "[]" {
            return Ok(Vec::new());
        }
        orbits::parse_orbits(t)
    }

    fn state_json(
        el: &OrbitalElements,
        site: &skyfix_ephemeris::topocentric::Site,
        jd_utc: f64,
    ) -> Result<serde_json::Value, String> {
        let c = orbits::custom_body_state(el, site, jd_utc).map_err(|e| e.to_string())?;
        let mut v = serde_json::to_value(&c.state).map_err(|e| e.to_string())?;
        let obj = v
            .as_object_mut()
            .expect("BodyState serialises to an object");
        let kind = match el.class {
            orbits::OrbitClass::Comet => "comet",
            orbits::OrbitClass::Asteroid => "asteroid",
        };
        obj.insert("kind".into(), kind.into());
        obj.insert("custom".into(), true.into());
        obj.insert(
            "constellation".into(),
            skyfix_starfield::constellation_at(c.state.ra_deg, c.state.dec_deg, jd_utc)
                .ok()
                .map_or(serde_json::Value::Null, |s| s.into()),
        );
        let p = &c.position;
        obj.insert("distance_au".into(), p.distance_au.into());
        obj.insert(
            "heliocentric_distance_au".into(),
            p.heliocentric_distance_au.into(),
        );
        obj.insert("elements_age_days".into(), p.elements_age_days.into());
        obj.insert(
            "warnings".into(),
            serde_json::to_value(&p.warnings).map_err(|e| e.to_string())?,
        );
        Ok(v)
    }

    /// `sky_state` for custom bodies (EXPLORER_API.md `custom_body_states`).
    pub fn custom_body_states(
        observer_json: &str,
        jd_utc: f64,
        custom_bodies_json: &str,
    ) -> Result<CustomBodyStates, String> {
        let site = parse_observer(observer_json)?;
        let list = custom_list(custom_bodies_json)?;
        let mut out = CustomBodyStates {
            jd_utc,
            utc: format_utc(jd_utc),
            bodies: Vec::with_capacity(list.len()),
            errors: Vec::new(),
        };
        for el in &list {
            match state_json(el, &site, jd_utc) {
                Ok(v) => out.bodies.push(v),
                Err(message) => out.errors.push(BodyError {
                    body: el.name.clone(),
                    message,
                }),
            }
        }
        Ok(out)
    }

    /// Most samples per body `sample_custom_bodies` returns.
    pub const MAX_CUSTOM_SAMPLES: usize = 5_000;

    /// One custom body's samples.
    #[derive(Debug, Clone, Serialize)]
    pub struct CustomSampled {
        pub body: String,
        pub alt_deg: Vec<f64>,
        pub alt_apparent_deg: Vec<f64>,
        pub az_deg: Vec<f64>,
        pub gha_deg: Vec<f64>,
        pub dec_deg: Vec<f64>,
    }

    /// Samples at `jd_start + k step` (EXPLORER_API.md `sample_custom_bodies`).
    #[allow(clippy::type_complexity)]
    pub fn sample_custom_bodies(
        observer_json: &str,
        custom_bodies_json: &str,
        jd_start: f64,
        jd_end: f64,
        step_minutes: f64,
    ) -> Result<(Vec<f64>, Vec<CustomSampled>, Vec<BodyError>), String> {
        let site = parse_observer(observer_json)?;
        let list = custom_list(custom_bodies_json)?;
        if !(jd_start.is_finite() && jd_end.is_finite() && jd_end >= jd_start)
            || !(step_minutes.is_finite() && step_minutes > 0.0)
        {
            return Err(
                "sample_custom_bodies needs jd_end >= jd_start and step_minutes > 0".into(),
            );
        }
        let step = step_minutes / 1440.0;
        let n = ((jd_end - jd_start) / step + 1e-9).floor() as usize + 1;
        if n > MAX_CUSTOM_SAMPLES {
            return Err(format!(
                "sample_custom_bodies: {n} samples asked for; at most {MAX_CUSTOM_SAMPLES} per body"
            ));
        }
        let times: Vec<f64> = (0..n).map(|k| jd_start + step * k as f64).collect();
        let mut bodies = Vec::new();
        let mut errors = Vec::new();
        'body: for el in &list {
            let mut s = CustomSampled {
                body: el.name.clone(),
                alt_deg: Vec::with_capacity(n),
                alt_apparent_deg: Vec::with_capacity(n),
                az_deg: Vec::with_capacity(n),
                gha_deg: Vec::with_capacity(n),
                dec_deg: Vec::with_capacity(n),
            };
            for &t in &times {
                match orbits::custom_body_state(el, &site, t) {
                    Ok(c) => {
                        s.alt_deg.push(c.state.alt_deg);
                        s.alt_apparent_deg.push(c.state.alt_apparent_deg);
                        s.az_deg.push(c.state.az_deg);
                        s.gha_deg.push(c.state.gha_deg);
                        s.dec_deg.push(c.state.dec_deg);
                    }
                    Err(e) => {
                        errors.push(BodyError {
                            body: el.name.clone(),
                            message: e.to_string(),
                        });
                        continue 'body;
                    }
                }
            }
            bodies.push(s);
        }
        Ok((times, bodies, errors))
    }
}

/// The four Galilean moons at `jd_utc`: `GalileanMoons`.
#[wasm_bindgen]
pub fn galilean_moons(jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::galilean_moons(jd_utc).map_err(err)?)
}

/// Transits, shadow transits, occultations and eclipses of the Galilean moons
/// overlapping the window: `GalileanEvents`.
#[wasm_bindgen]
pub fn galilean_events(jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    to_js(&native::galilean_events(jd_start, jd_end).map_err(err)?)
}

/// Saturn's rings at `jd_utc`: `SaturnRings`.
#[wasm_bindgen]
pub fn saturn_rings(jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::saturn_rings(jd_utc).map_err(err)?)
}

/// A planet's disc at `jd_utc`: `PlanetDisc`.
#[wasm_bindgen]
pub fn planet_disc(body: &str, jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::planet_disc(body, jd_utc).map_err(err)?)
}

/// Transits of Mercury and Venus in the window, local circumstances when
/// `observer_json` is an observer (`""` or `"null"` for none): `TransitList`.
#[wasm_bindgen]
pub fn transits(jd_start: f64, jd_end: f64, observer_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::transits(jd_start, jd_end, observer_json).map_err(err)?)
}

/// Closest approaches in the window: `ConjunctionList`.
#[wasm_bindgen]
pub fn conjunctions(jd_start: f64, jd_end: f64, options_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::conjunctions(jd_start, jd_end, options_json).map_err(err)?)
}

/// Stations of Mercury to Neptune in the window: `StationList`.
#[wasm_bindgen]
pub fn stations(jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    to_js(&native::stations(jd_start, jd_end).map_err(err)?)
}

/// The Earth's perihelion and aphelion in a calendar year: `EarthApsides`.
#[wasm_bindgen]
pub fn earth_apsides(year: f64) -> Result<JsValue, JsValue> {
    to_js(&native::earth_apsides(year).map_err(err)?)
}

/// Orbital elements from MPC lines or JSON: `OrbitalElements[]`.
#[wasm_bindgen]
pub fn parse_orbits(text: &str) -> Result<JsValue, JsValue> {
    to_js(&native::parse_orbits(text).map_err(err)?)
}

/// Custom bodies seen from an observer: `CustomBodyStates`.
#[wasm_bindgen]
pub fn custom_body_states(
    observer_json: &str,
    jd_utc: f64,
    custom_bodies_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(&native::custom_body_states(observer_json, jd_utc, custom_bodies_json).map_err(err)?)
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value).map(|_| ())
}

/// Sampled tracks of custom bodies, the shape of `sample_bodies`.
#[wasm_bindgen]
pub fn sample_custom_bodies(
    observer_json: &str,
    custom_bodies_json: &str,
    jd_start: f64,
    jd_end: f64,
    step_minutes: f64,
) -> Result<JsValue, JsValue> {
    let (times, bodies, errors) = native::sample_custom_bodies(
        observer_json,
        custom_bodies_json,
        jd_start,
        jd_end,
        step_minutes,
    )
    .map_err(err)?;
    let out = Object::new();
    set(&out, "jd_utc", &Float64Array::from(times.as_slice()))?;
    let arr = Array::new();
    for b in &bodies {
        let o = Object::new();
        set(&o, "body", &JsValue::from_str(&b.body))?;
        set(&o, "alt_deg", &Float64Array::from(b.alt_deg.as_slice()))?;
        set(
            &o,
            "alt_apparent_deg",
            &Float64Array::from(b.alt_apparent_deg.as_slice()),
        )?;
        set(&o, "az_deg", &Float64Array::from(b.az_deg.as_slice()))?;
        set(&o, "gha_deg", &Float64Array::from(b.gha_deg.as_slice()))?;
        set(&o, "dec_deg", &Float64Array::from(b.dec_deg.as_slice()))?;
        arr.push(&o);
    }
    set(&out, "bodies", &arr)?;
    set(&out, "errors", &to_js(&errors)?)?;
    Ok(out.into())
}

#[cfg(test)]
mod tests {
    use super::native;
    use skyfix_core::time::civil_to_jd;

    fn keys(v: &serde_json::Value, want: &[&str]) {
        for k in want {
            assert!(v.get(*k).is_some(), "missing {k} in {v}");
        }
    }

    #[test]
    fn the_wire_shapes_carry_the_documented_fields() {
        let jd = civil_to_jd(2026, 1, 10);
        let m = serde_json::to_value(native::galilean_moons(jd).unwrap()).unwrap();
        keys(
            &m,
            &[
                "jd_utc",
                "utc",
                "jupiter",
                "moons",
                "theory",
                "accuracy_arcsec",
            ],
        );
        keys(
            &m["moons"][0],
            &[
                "name",
                "x_rj",
                "y_rj",
                "z_rj",
                "offset_east_arcsec",
                "offset_north_arcsec",
                "ra_deg",
                "dec_deg",
                "in_front",
                "in_transit",
                "occulted",
                "eclipsed",
                "shadow_on_disc",
                "shadow_x_rj",
                "shadow_y_rj",
            ],
        );
        let ev = serde_json::to_value(native::galilean_events(jd, jd + 2.0).unwrap()).unwrap();
        keys(
            &ev,
            &[
                "jd_start",
                "jd_end",
                "truncated",
                "phenomena",
                "conventions",
            ],
        );
        keys(
            &ev["phenomena"][0],
            &["moon", "kind", "start", "end", "jupiter_elongation_deg"],
        );
        let r = serde_json::to_value(native::saturn_rings(jd).unwrap()).unwrap();
        keys(
            &r,
            &[
                "earth_latitude_deg",
                "sun_latitude_deg",
                "delta_u_deg",
                "position_angle_deg",
                "major_axis_arcsec",
                "minor_axis_arcsec",
                "edges",
                "magnitude_aa1984",
                "magnitude",
                "north_face_visible",
                "lit_face_visible",
            ],
        );
        let d = serde_json::to_value(native::planet_disc(" mars ", jd).unwrap()).unwrap();
        assert_eq!(d["body"], "Mars");
        keys(
            &d,
            &[
                "equatorial_diameter_arcsec",
                "polar_diameter_arcsec",
                "defect_of_illumination_arcsec",
                "pole_position_angle_deg",
                "sub_earth_lat_deg",
                "sub_earth_lon_deg",
                "central_meridians",
                "longitude_positive",
                "notes",
            ],
        );
        assert!(native::planet_disc("Pluto", jd).is_err());
        let t = serde_json::to_value(
            native::transits(
                civil_to_jd(2012, 6, 1),
                civil_to_jd(2012, 6, 10),
                r#"{"lat_deg": 35.69, "lon_deg": 139.69}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(t["transits"][0]["id"], "2012-06-06-venus");
        keys(
            &t["transits"][0]["local"],
            &["observer", "visibility", "events", "path"],
        );
        let geo = native::transits(civil_to_jd(2012, 6, 1), civil_to_jd(2012, 6, 10), "").unwrap();
        assert!(geo.transits[0].local.is_none());
        let c = serde_json::to_value(
            native::conjunctions(
                civil_to_jd(2020, 12, 1),
                civil_to_jd(2021, 1, 1),
                r#"{"moon": false, "stars": [], "planets": ["Jupiter", "Saturn"],
                    "observer": {"lat_deg": 39.95, "lon_deg": -75.17}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        keys(
            &c["conjunctions"][0],
            &[
                "kind",
                "body",
                "other",
                "separation_deg",
                "position_angle_deg",
                "visible",
                "local",
                "body_elongation_deg",
                "other_elongation_deg",
            ],
        );
        assert!(!c["conjunctions"][0]["local"].is_null());
        assert!(native::conjunctions(0.0, 1.0, r#"{"bogus": 1}"#).is_err());
        let s = serde_json::to_value(
            native::stations(civil_to_jd(2024, 11, 1), civil_to_jd(2025, 3, 1)).unwrap(),
        )
        .unwrap();
        assert_eq!(s["ui_coordinate"], "ecliptic_longitude");
        let a = serde_json::to_value(native::earth_apsides(2026.0).unwrap()).unwrap();
        assert_eq!(a["events"][0]["kind"], "perihelion");
        assert!(native::earth_apsides(2026.5).is_err());
    }

    #[test]
    fn custom_bodies_come_back_as_body_states() {
        let eros = "00433   10.39  0.15 K2669  62.51145  178.91814  304.26797   10.82855  0.2228780  0.55970463   1.4582437  0 E2026-S80 18063  59 1893-2026 0.61 M-v 3Ek MPCORBFIT  1804    (433) Eros               20260919";
        let els = native::parse_orbits(eros).unwrap();
        assert_eq!(els[0].name, "(433) Eros");
        let json = serde_json::to_string(&els).unwrap();
        let jd = civil_to_jd(2026, 6, 9);
        let s = native::custom_body_states(r#"{"lat_deg": 39.95, "lon_deg": -75.17}"#, jd, &json)
            .unwrap();
        assert!(s.errors.is_empty());
        let b = &s.bodies[0];
        assert_eq!(b["kind"], "asteroid");
        assert_eq!(b["custom"], true);
        for k in [
            "alt_deg",
            "az_deg",
            "ra_deg",
            "gha_deg",
            "magnitude",
            "elements_age_days",
            "warnings",
            "constellation",
        ] {
            assert!(b.get(k).is_some(), "{k}");
        }
        let (t, bodies, errors) = native::sample_custom_bodies(
            r#"{"lat_deg": 39.95, "lon_deg": -75.17}"#,
            &json,
            jd,
            jd + 1.0,
            60.0,
        )
        .unwrap();
        assert_eq!(t.len(), 25);
        assert!(errors.is_empty() && bodies[0].alt_deg.len() == 25);
        // Manual elements, and a helpful refusal.
        let manual = r#"{"name": "Test comet", "q_au": 0.5, "e": 1.0, "i_deg": 30, "node_deg": 40,
                         "peri_deg": 50, "tp_tt": "2026-06-01T00:00:00Z", "m1": 8, "k1": 10}"#;
        let m = native::custom_body_states(r#"{"lat_deg": 0, "lon_deg": 0}"#, jd, manual).unwrap();
        assert_eq!(m.bodies[0]["kind"], "comet");
        assert!(
            native::parse_orbits(
                r#"{"name": "x", "e": 0.1, "i_deg": 1, "node_deg": 1, "peri_deg": 1}"#
            )
            .is_err()
        );
    }
}
