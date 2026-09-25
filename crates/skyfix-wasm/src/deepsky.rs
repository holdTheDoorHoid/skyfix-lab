//! WASM exports for the explorer: deep sky (deep-sky objects, meteor showers, the Milky
//! Way outline, search, extinction and the "tonight" ranking).
//!
//! OWNER: deepsky agent (expansion programme). Wire format: docs/EXPLORER_API.md,
//! "Expansion programme — deep sky". Everything here is display-only (CONVENTIONS
//! 13.6): `skyfix-starfield` never feeds `reduce`, `solve`, the planner or an accuracy
//! claim. Two layers, as in `explorer.rs`: [`native`] takes the same JSON strings and
//! numbers as the exports and returns serde types (tested natively); the exports
//! serialise, with the Milky Way rings and the extinction table as real typed arrays.

use js_sys::{Array, Float64Array, Object, Reflect};
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: JSON in, serde types out, `String` errors.
pub mod native {
    use serde::Deserialize;
    use skyfix_ephemeris::body::Sky;
    use skyfix_ephemeris::topocentric::Site;
    use skyfix_starfield::extinction::{self, Conditions, ExtinctionTable, SkyConditions};
    use skyfix_starfield::{dso, milkyway, search, showers, tonight};

    use crate::explorer::native::parse_observer;

    fn blank(s: &str) -> bool {
        let t = s.trim();
        t.is_empty() || t == "null" || t == "undefined"
    }

    /// An observer that may be absent (`""` or `null`).
    pub fn optional_observer(observer_json: &str) -> Result<Option<Site>, String> {
        if blank(observer_json) {
            Ok(None)
        } else {
            parse_observer(observer_json).map(Some)
        }
    }

    /// `conditions_json`: `{"bortle": 1..9, "nelm": 1..8, "k": 0.2..0.4}`, all optional.
    pub fn conditions(conditions_json: &str) -> Result<Conditions, String> {
        let c: SkyConditions = if blank(conditions_json) {
            SkyConditions::default()
        } else {
            serde_json::from_str(conditions_json.trim()).map_err(|e| format!("conditions: {e}"))?
        };
        c.resolve().map_err(|e| format!("conditions: {e}"))
    }

    fn check_jd(name: &str, jd: f64) -> Result<(), String> {
        if jd.is_finite() {
            Ok(())
        } else {
            Err(format!("{name} must be a finite Julian date, got {jd}"))
        }
    }

    pub fn dso_catalog() -> Result<&'static [dso::Dso], String> {
        dso::catalog().map_err(|e| e.to_string())
    }

    pub fn dso_list(
        observer_json: &str,
        jd_utc: f64,
        options_json: &str,
    ) -> Result<dso::DsoPositions, String> {
        check_jd("jd_utc", jd_utc)?;
        let site = optional_observer(observer_json)?;
        let options: dso::ListOptions = if blank(options_json) {
            dso::ListOptions::default()
        } else {
            serde_json::from_str(options_json.trim()).map_err(|e| format!("options: {e}"))?
        };
        dso::list(site.as_ref(), jd_utc, &options)
    }

    pub fn dso_visibility(
        id: &str,
        observer_json: &str,
        jd_utc: f64,
        conditions_json: &str,
    ) -> Result<dso::DsoVisibility, String> {
        check_jd("jd_utc", jd_utc)?;
        let site = parse_observer(observer_json)?;
        dso::visibility(
            &Sky::new(),
            id,
            &site,
            jd_utc,
            &conditions(conditions_json)?,
        )
    }

    pub fn meteor_showers(
        year: f64,
        observer_json: &str,
        conditions_json: &str,
    ) -> Result<showers::ShowerYear, String> {
        if !(year.is_finite() && year.fract() == 0.0 && year.abs() < 1.0e6) {
            return Err(format!("year must be a whole number, got {year}"));
        }
        let site = optional_observer(observer_json)?;
        showers::year(
            &Sky::new(),
            year as i32,
            site.as_ref(),
            &conditions(conditions_json)?,
        )
    }

    pub fn milky_way_outline() -> Result<&'static milkyway::Outline, String> {
        milkyway::outline().map_err(|e| e.to_string())
    }

    pub fn sky_search(
        query: &str,
        observer_json: &str,
        jd_utc: Option<f64>,
        limit: Option<u32>,
    ) -> Result<search::SearchResult, String> {
        if let Some(jd) = jd_utc {
            check_jd("jd_utc", jd)?;
        }
        let site = optional_observer(observer_json)?;
        if site.is_some() && jd_utc.is_none() {
            return Err("an observer needs a time (jd_utc) to place the hits".to_string());
        }
        search::search(
            &Sky::new(),
            query,
            site.as_ref(),
            jd_utc,
            limit.map(|l| l as usize),
        )
    }

    /// `options_json` of `tonight`: the sky conditions and how many deep-sky objects.
    #[derive(Debug, Clone, Default, Deserialize)]
    #[serde(default, deny_unknown_fields)]
    struct TonightOptions {
        bortle: Option<u8>,
        nelm: Option<f64>,
        k: Option<f64>,
        limit: Option<usize>,
    }

    pub fn tonight(
        observer_json: &str,
        jd_utc: f64,
        options_json: &str,
    ) -> Result<tonight::Tonight, String> {
        check_jd("jd_utc", jd_utc)?;
        let site = parse_observer(observer_json)?;
        let o: TonightOptions = if blank(options_json) {
            TonightOptions::default()
        } else {
            serde_json::from_str(options_json.trim()).map_err(|e| format!("options: {e}"))?
        };
        let c = SkyConditions {
            bortle: o.bortle,
            nelm: o.nelm,
            k: o.k,
        }
        .resolve()
        .map_err(|e| format!("options: {e}"))?;
        tonight::tonight(&Sky::new(), &site, jd_utc, &c, o.limit)
    }

    pub fn extinction_table(conditions_json: &str) -> Result<ExtinctionTable, String> {
        Ok(extinction::table(&conditions(conditions_json)?))
    }
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value).map(|_| ())
}

fn f64_array(v: &[f64]) -> Float64Array {
    Float64Array::from(v)
}

/// The deep-sky table, once: `{objects: Dso[], source}` (`DsoCatalog`).
#[wasm_bindgen]
pub fn dso_catalog() -> Result<JsValue, JsValue> {
    let out = Object::new();
    set(
        &out,
        "objects",
        &to_js(&native::dso_catalog().map_err(err)?)?,
    )?;
    set(
        &out,
        "source",
        &JsValue::from_str(skyfix_starfield::dso::SOURCE),
    )?;
    Ok(out.into())
}

/// Every deep-sky object (filtered by `options_json`) at `jd_utc`: `{jd_utc, index:
/// Int32Array, ra_deg, dec_deg: Float64Array, alt_deg, az_deg, alt_apparent_deg:
/// Float64Array | null}` (`DsoPositions`), `index` into `dso_catalog().objects`. With no
/// observer (`""` or `null`) the three horizon arrays are `null`.
#[wasm_bindgen]
pub fn dso_list(observer_json: &str, jd_utc: f64, options_json: &str) -> Result<JsValue, JsValue> {
    let p = native::dso_list(observer_json, jd_utc, options_json).map_err(err)?;
    let out = Object::new();
    set(&out, "jd_utc", &JsValue::from_f64(p.jd_utc))?;
    set(&out, "index", &js_sys::Int32Array::from(p.index.as_slice()))?;
    set(&out, "ra_deg", &f64_array(&p.ra_deg))?;
    set(&out, "dec_deg", &f64_array(&p.dec_deg))?;
    let [alt, az, app] = match &p.horizon {
        Some([a, z, h]) => [
            f64_array(a).into(),
            f64_array(z).into(),
            f64_array(h).into(),
        ],
        None => [JsValue::NULL, JsValue::NULL, JsValue::NULL],
    };
    set(&out, "alt_deg", &alt)?;
    set(&out, "az_deg", &az)?;
    set(&out, "alt_apparent_deg", &app)?;
    Ok(out.into())
}

/// One deep-sky object through the night `jd_utc` belongs to (`DsoVisibility`).
#[wasm_bindgen]
pub fn dso_visibility(
    id: &str,
    observer_json: &str,
    jd_utc: f64,
    conditions_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(&native::dso_visibility(id, observer_json, jd_utc, conditions_json).map_err(err)?)
}

/// Every shower's dates in `year`, with an observer the night nearest each peak
/// (`ShowerYear`).
#[wasm_bindgen]
pub fn meteor_showers(
    year: f64,
    observer_json: &str,
    conditions_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(&native::meteor_showers(year, observer_json, conditions_json).map_err(err)?)
}

/// The Milky Way outline: `{levels: number[], rings: [{level, ra_deg: Float64Array,
/// dec_deg: Float64Array}], source}`, closed oriented rings at J2000.
#[wasm_bindgen]
pub fn milky_way_outline() -> Result<JsValue, JsValue> {
    let o = native::milky_way_outline().map_err(err)?;
    let out = Object::new();
    set(&out, "levels", &to_js(&o.levels)?)?;
    let rings = Array::new();
    for r in &o.rings {
        let ring = Object::new();
        set(&ring, "level", &JsValue::from(u32::from(r.level)))?;
        set(&ring, "ra_deg", &f64_array(&r.ra_deg))?;
        set(&ring, "dec_deg", &f64_array(&r.dec_deg))?;
        rings.push(&ring);
    }
    set(&out, "rings", &rings)?;
    set(
        &out,
        "source",
        &JsValue::from_str(skyfix_starfield::milkyway::SOURCE),
    )?;
    Ok(out.into())
}

/// Search stars, deep-sky objects, constellations, planets and radiants
/// (`SearchResult`). `jd_utc` and the observer are optional; an observer needs a time.
#[wasm_bindgen]
pub fn sky_search(
    query: &str,
    observer_json: &str,
    jd_utc: Option<f64>,
    limit: Option<u32>,
) -> Result<JsValue, JsValue> {
    to_js(&native::sky_search(query, observer_json, jd_utc, limit).map_err(err)?)
}

/// What the night `jd_utc` belongs to offers at the observer (`Tonight`).
#[wasm_bindgen]
pub fn tonight(observer_json: &str, jd_utc: f64, options_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::tonight(observer_json, jd_utc, options_json).map_err(err)?)
}

/// The extinction and limiting-magnitude model and its table every degree of altitude
/// (`ExtinctionTable`, arrays as `Float64Array`).
#[wasm_bindgen]
pub fn extinction_table(conditions_json: &str) -> Result<JsValue, JsValue> {
    let t = native::extinction_table(conditions_json).map_err(err)?;
    let out = Object::new();
    set(&out, "conditions", &to_js(&t.conditions)?)?;
    set(&out, "alt_deg", &f64_array(&t.alt_deg))?;
    set(&out, "airmass", &f64_array(&t.airmass))?;
    set(&out, "extinction_mag", &f64_array(&t.extinction_mag))?;
    set(&out, "limiting_mag", &f64_array(&t.limiting_mag))?;
    set(&out, "model", &JsValue::from_str(t.model))?;
    Ok(out.into())
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
    fn the_catalogue_and_positions_have_the_documented_shape() {
        let v = json(&dso_catalog().unwrap());
        let objs = v.as_array().unwrap();
        assert_eq!(objs.len(), 213);
        let m31 = objs.iter().find(|o| o["id"] == "M31").unwrap();
        for k in [
            "id",
            "label",
            "name",
            "type",
            "category",
            "constellation",
            "ra_j2000_deg",
            "dec_j2000_deg",
            "magnitude",
            "major_arcmin",
            "minor_arcmin",
            "description",
            "cross_ids",
        ] {
            assert!(m31.get(k).is_some(), "missing {k}");
        }
        assert_eq!(m31["type"], "spiral_galaxy");
        assert_eq!(m31["category"], "galaxy");

        let jd = civil_to_jd(2026, 9, 24) + 0.1;
        let p = dso_list(PHILLY, jd, "").unwrap();
        assert_eq!(p.index.len(), 213);
        assert_eq!(p.ra_deg.len(), 213);
        assert!(p.horizon.as_ref().unwrap().iter().all(|v| v.len() == 213));
        // No observer: no horizon arrays, the same objects.
        let q = dso_list("", jd, "null").unwrap();
        assert!(q.horizon.is_none() && q.index.len() == 213);
        // Filters.
        let g = dso_list(PHILLY, jd, r#"{"kinds": ["galaxy"], "max_magnitude": 8.0}"#).unwrap();
        let cat = dso_catalog().unwrap();
        assert!(!g.index.is_empty());
        assert!(g.index.iter().all(|&i| {
            let d = &cat[i as usize];
            d.category == "galaxy" && d.magnitude.unwrap() <= 8.0
        }));
        let up = dso_list(PHILLY, jd, r#"{"above_horizon": true}"#).unwrap();
        assert!(up.horizon.unwrap()[2].iter().all(|&h| h > 0.0));
        assert!(dso_list(PHILLY, jd, r#"{"colour": 1}"#).is_err());
        assert!(dso_list(PHILLY, f64::NAN, "").is_err());
    }

    #[test]
    fn visibility_showers_search_tonight_and_extinction() {
        let jd = civil_to_jd(2026, 9, 24) + 0.9;
        let v = json(&dso_visibility("m31", PHILLY, jd, r#"{"bortle": 4}"#).unwrap());
        assert_eq!(v["object"]["id"], "M31");
        assert!(v["visibility"]["best"]["alt_deg"].as_f64().unwrap() > 60.0);
        assert_eq!(v["track"]["jd_utc"].as_array().unwrap().len(), 145);
        assert_eq!(v["conditions"]["bortle"], 4);
        assert!(dso_visibility("M999", PHILLY, jd, "").is_err());

        let y = json(&meteor_showers(2026.0, "", "").unwrap());
        assert_eq!(y["showers"].as_array().unwrap().len(), 32);
        assert!(y["showers"][0]["at_site"].is_null());
        assert!(meteor_showers(2026.5, "", "").is_err());

        let s = json(&sky_search("vega", PHILLY, Some(jd), Some(3)).unwrap());
        assert_eq!(s["hits"][0]["label"], "Vega");
        assert!(s["hits"][0]["alt_deg"].is_number());
        assert!(sky_search("vega", PHILLY, None, None).is_err());
        assert!(sky_search("vega", "", None, None).is_ok());

        let t = json(&tonight(PHILLY, jd, r#"{"bortle": 3, "limit": 5}"#).unwrap());
        assert_eq!(t["deep_sky"].as_array().unwrap().len(), 5);
        assert!(t["summary"].as_str().unwrap().contains("{jd:"));
        assert!(tonight(PHILLY, jd, r#"{"k": 0.9}"#).is_err());

        let e = extinction_table(r#"{"nelm": 6.2, "k": 0.3}"#).unwrap();
        assert_eq!(e.alt_deg.len(), 91);
        assert!((e.limiting_mag[90] - 6.2).abs() < 1e-3);
        assert!(extinction_table(r#"{"bortle": 11}"#).is_err());
        assert!(milky_way_outline().unwrap().rings.len() > 10);
    }
}
