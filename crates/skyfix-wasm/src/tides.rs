//! WASM exports: tide predictions from the optional `tides-us` pack.
//!
//! OWNER: tides agent (expansion programme, work package P5). Wire format:
//! `docs/EXPLORER_API.md`, "Tides (tides agent)"; TypeScript mirror: `TidesEngine` in
//! `web/src/next/engine/types.ts`; definitions: CONVENTIONS 13.10 and `skyfix_tides`.
//!
//! The station database lives in this module once a pack is installed, for the page
//! session (CONVENTIONS 15.5). Every query throws `pack_not_loaded: …` until then.
//!
//! - [`install_tides_us`] is the producer function the pack dispatcher
//!   (`packs::install`, the packs agent's) calls with the verified payload.
//! - [`load_pack_tides_us`] takes a whole pack file (header, payload, CRC). It is
//!   **temporary**, for as long as `packs.rs` is not on main; once `load_pack` exists it
//!   can go (the web engine prefers `load_pack` when present).

use std::sync::{Arc, RwLock};

use js_sys::{Float64Array, Object, Reflect};
use serde::Serialize;
use skyfix_tides::TideDb;
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

static DB: RwLock<Option<Arc<TideDb>>> = RwLock::new(None);

/// What installing the pack reports: the contract's `PackInfo` fields (`name`,
/// `version`, `bytes`, `provides`) and the station counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TidesPackInfo {
    pub name: &'static str,
    pub version: String,
    /// Payload bytes.
    pub bytes: usize,
    pub provides: Vec<&'static str>,
    pub stations: usize,
    pub harmonic: usize,
    pub subordinate: usize,
}

/// The native layer: plain arguments in, serde types out, `String` errors.
pub mod native {
    use super::*;
    use skyfix_tides::api::{self, TideCurve, TideExtremes, TideNow, TideStation, TideStationNear};
    use skyfix_tides::pack;

    fn info(db: &TideDb, bytes: usize) -> TidesPackInfo {
        let harmonic = db.harmonic_count();
        TidesPackInfo {
            name: pack::PACK_NAME,
            version: db.version.clone(),
            bytes,
            provides: vec!["tides:us-noaa"],
            stations: db.stations.len(),
            harmonic,
            subordinate: db.stations.len() - harmonic,
        }
    }

    fn set(db: TideDb) {
        let mut slot = DB.write().unwrap_or_else(|p| p.into_inner());
        *slot = Some(Arc::new(db));
    }

    /// The installed database, if any.
    pub fn installed() -> Option<Arc<TideDb>> {
        DB.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Parse and install a `tides-us` payload (the dispatcher has checked the header).
    /// Idempotent: a second install replaces the first.
    pub fn install_payload(payload: &[u8]) -> Result<TidesPackInfo, String> {
        let db = pack::decode_payload(payload).map_err(|e| e.to_string())?;
        let i = info(&db, payload.len());
        set(db);
        Ok(i)
    }

    /// Parse and install a whole pack file (header, payload, CRC-32).
    pub fn install_file(bytes: &[u8]) -> Result<TidesPackInfo, String> {
        let (name, payload) = pack::parse_file(bytes).map_err(|e| e.to_string())?;
        if name != pack::PACK_NAME {
            return Err(format!(
                "this is the {name:?} pack, not {:?}",
                pack::PACK_NAME
            ));
        }
        install_payload(payload)
    }

    /// The installed pack's summary, or `None`.
    pub fn pack_info() -> Option<TidesPackInfo> {
        installed().map(|db| {
            let bytes = pack::encode_payload(&db).map(|p| p.len()).unwrap_or(0);
            info(&db, bytes)
        })
    }

    fn with<T>(
        db: Option<&TideDb>,
        f: impl FnOnce(&TideDb) -> Result<T, String>,
    ) -> Result<T, String> {
        match db {
            Some(db) => f(db),
            None => Err(api::pack_not_loaded()),
        }
    }

    pub fn stations_near_in(
        db: Option<&TideDb>,
        lat_deg: f64,
        lon_deg: f64,
        n: u32,
    ) -> Result<Vec<TideStationNear>, String> {
        with(db, |db| api::stations_near(db, lat_deg, lon_deg, n))
    }

    pub fn station_in(db: Option<&TideDb>, id: &str) -> Result<TideStation, String> {
        with(db, |db| api::station_by_id(db, id))
    }

    pub fn predict_in(
        db: Option<&TideDb>,
        id: &str,
        jd_start: f64,
        jd_end: f64,
        step_min: f64,
        datum: &str,
    ) -> Result<TideCurve, String> {
        with(db, |db| {
            api::predict(db, id, jd_start, jd_end, step_min, datum)
        })
    }

    pub fn extremes_in(
        db: Option<&TideDb>,
        id: &str,
        jd_start: f64,
        jd_end: f64,
        datum: &str,
    ) -> Result<TideExtremes, String> {
        with(db, |db| api::extremes(db, id, jd_start, jd_end, datum))
    }

    pub fn now_in(db: Option<&TideDb>, id: &str, jd: f64, datum: &str) -> Result<TideNow, String> {
        with(db, |db| api::now(db, id, jd, datum))
    }
}

/// The producer function for the pack dispatcher: `packs::install("tides-us", payload)`
/// calls this with the payload the common header wraps.
pub fn install_tides_us(payload: &[u8]) -> Result<TidesPackInfo, String> {
    native::install_payload(payload)
}

/// TEMPORARY (until `load_pack` from `packs.rs` is on main): install a whole `tides-us`
/// pack file. Returns `TidesPackInfo`; throws when the magic, version, name, length or
/// CRC is wrong. Idempotent.
#[wasm_bindgen]
pub fn load_pack_tides_us(bytes: &[u8]) -> Result<JsValue, JsValue> {
    to_js(&native::install_file(bytes).map_err(err)?)
}

/// The installed pack's `TidesPackInfo`, or `null` when none is loaded.
#[wasm_bindgen]
pub fn tide_pack_info() -> Result<JsValue, JsValue> {
    to_js(&native::pack_info())
}

/// The `n` stations (1 to 100) nearest to a place, nearest first: `TideStationNear[]`.
#[wasm_bindgen]
pub fn tide_stations_near(lat_deg: f64, lon_deg: f64, n: u32) -> Result<JsValue, JsValue> {
    let db = native::installed();
    to_js(&native::stations_near_in(db.as_deref(), lat_deg, lon_deg, n).map_err(err)?)
}

/// One station by NOAA id: `TideStation`.
#[wasm_bindgen]
pub fn tide_station(station_id: &str) -> Result<JsValue, JsValue> {
    let db = native::installed();
    to_js(&native::station_in(db.as_deref(), station_id).map_err(err)?)
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value).map(|_| ())
}

/// Heights every `step_min` minutes: `TideCurve`, with `jd_utc` and `height_m` as real
/// `Float64Array`s. `datum` `""` means the station's default (MLLW where published).
#[wasm_bindgen]
pub fn tide_predict(
    station_id: &str,
    jd_start: f64,
    jd_end: f64,
    step_min: f64,
    datum: &str,
) -> Result<JsValue, JsValue> {
    let db = native::installed();
    let c = native::predict_in(db.as_deref(), station_id, jd_start, jd_end, step_min, datum)
        .map_err(err)?;
    let out = Object::new();
    set(&out, "station", &to_js(&c.station)?)?;
    set(&out, "datum", &JsValue::from_str(c.datum))?;
    set(&out, "method", &JsValue::from_str(c.method))?;
    set(&out, "jd_start", &JsValue::from_f64(c.jd_start))?;
    set(&out, "jd_end", &JsValue::from_f64(c.jd_end))?;
    set(&out, "step_min", &JsValue::from_f64(c.step_min))?;
    set(&out, "jd_utc", &Float64Array::from(c.jd_utc.as_slice()))?;
    set(&out, "height_m", &Float64Array::from(c.height_m.as_slice()))?;
    set(&out, "label", &JsValue::from_str(c.label))?;
    set(&out, "notes", &to_js(&c.notes)?)?;
    Ok(out.into())
}

/// High and low water in the window (at most 400 days): `TideExtremes`.
#[wasm_bindgen]
pub fn tide_extremes(
    station_id: &str,
    jd_start: f64,
    jd_end: f64,
    datum: &str,
) -> Result<JsValue, JsValue> {
    let db = native::installed();
    to_js(&native::extremes_in(db.as_deref(), station_id, jd_start, jd_end, datum).map_err(err)?)
}

/// The tide at one instant, with the high and low waters around it: `TideNow`.
#[wasm_bindgen]
pub fn tide_now(station_id: &str, jd_utc: f64, datum: &str) -> Result<JsValue, JsValue> {
    let db = native::installed();
    to_js(&native::now_in(db.as_deref(), station_id, jd_utc, datum).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::native::*;
    use std::path::PathBuf;

    fn pack_file() -> Vec<u8> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs");
        let f = std::fs::read_dir(&dir)
            .expect("web/public/data/packs")
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                let n = p.file_name().unwrap().to_string_lossy().to_string();
                n.starts_with("tides-us-") && n.ends_with(".bin")
            })
            .expect("a tides-us pack");
        std::fs::read(f).unwrap()
    }

    fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn every_query_says_pack_not_loaded_without_the_pack() {
        let jd = 2_461_308.0;
        for e in [
            stations_near_in(None, 37.8, -122.4, 5).unwrap_err(),
            station_in(None, "9414290").unwrap_err(),
            predict_in(None, "9414290", jd, jd + 1.0, 6.0, "").unwrap_err(),
            extremes_in(None, "9414290", jd, jd + 1.0, "").unwrap_err(),
            now_in(None, "9414290", jd, "").unwrap_err(),
        ] {
            assert!(e.starts_with("pack_not_loaded:"), "{e}");
        }
    }

    #[test]
    fn the_real_pack_installs_and_answers() {
        let bytes = pack_file();
        let info = install_file(&bytes).unwrap();
        assert_eq!(info.name, "tides-us");
        assert_eq!(info.stations, info.harmonic + info.subordinate);
        assert!(info.harmonic > 1200 && info.subordinate > 2200, "{info:?}");
        // Idempotent.
        assert_eq!(install_file(&bytes).unwrap(), info);
        let db = installed().unwrap();
        let db = Some(db.as_ref());

        let near = json(&stations_near_in(db, 37.8063, -122.4659, 3).unwrap());
        assert_eq!(near[0]["id"], "9414290");
        for k in [
            "id",
            "name",
            "state",
            "lat_deg",
            "lon_deg",
            "kind",
            "reference_id",
            "reference_name",
            "tide_type",
            "form_number",
            "datums",
            "default_datum",
            "curve",
            "flags",
            "notes",
            "distance_km",
            "distance_nm",
            "bearing_deg",
        ] {
            assert!(near[0].get(k).is_some(), "TideStationNear lacks {k}");
        }
        assert!(near[0]["distance_km"].as_f64().unwrap() < 0.1);

        // 2026-09-24 to 2026-09-25 UTC at San Francisco.
        let jd = 2_461_307.5;
        let ex = json(&extremes_in(db, "9414290", jd, jd + 1.0, "").unwrap());
        assert_eq!(ex["datum"], "MLLW");
        assert_eq!(ex["method"], "harmonic");
        let list = ex["extremes"].as_array().unwrap();
        assert!((3..=4).contains(&list.len()), "{list:?}");
        for k in ["kind", "jd_utc", "utc", "height_m"] {
            assert!(list[0].get(k).is_some(), "TideEvent lacks {k}");
        }
        assert!(ex["label"].as_str().unwrap().contains("NOAA"));

        let c = predict_in(db, "9414290", jd, jd + 1.0, 6.0, "MSL").unwrap();
        assert_eq!(c.jd_utc.len(), 241);
        assert_eq!(c.height_m.len(), 241);
        assert_eq!(c.datum, "MSL");

        let now = json(&now_in(db, "9414290", jd + 0.3, "").unwrap());
        for k in [
            "station",
            "datum",
            "method",
            "jd_utc",
            "utc",
            "height_m",
            "rate_m_per_h",
            "state",
            "previous",
            "next",
            "next_high",
            "next_low",
            "label",
            "notes",
        ] {
            assert!(now.get(k).is_some(), "TideNow lacks {k}");
        }
        assert!(now["state"] == "rising" || now["state"] == "falling");

        let e = extremes_in(db, "nope", jd, jd + 1.0, "").unwrap_err();
        assert!(e.starts_with("unknown_station:"), "{e}");
    }

    #[test]
    fn a_damaged_pack_is_refused() {
        let mut bytes = pack_file();
        let n = bytes.len();
        bytes[n / 2] ^= 0x40;
        let e = install_file(&bytes).unwrap_err();
        assert!(e.contains("CRC"), "{e}");
    }
}
