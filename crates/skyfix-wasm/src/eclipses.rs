//! WASM exports for the explorer: eclipses.
//!
//! OWNER: eclipse agent (wave 2). Wire format: `docs/EXPLORER_API.md`, "Wave 2 —
//! eclipses"; TypeScript mirror: `EclipseEngine` in `web/src/next/engine/types.ts`.
//!
//! Thin: parse the arguments, call `skyfix_almanac::eclipses`, serialise its types as
//! they are (JSON-compatible: `None` is `null`). The model, its validation and its
//! conventions live in that module. DUT1 is the explorer-wide value of
//! `timescale::set_dut1`, else the IERS history (`Eclipses::with_user_dut1`).

use skyfix_almanac::eclipses::Eclipses;
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// `observer_json` as EXPLORER_API.md "Common rules" defines it, read by the one parser
/// every explorer export shares (longitude normalised to `(-180, 180]`, every field
/// range-checked).
pub use crate::explorer::native::parse_observer;

/// The engine with the explorer-wide DUT1 (`timescale::set_dut1`), else the history.
fn engine() -> Eclipses {
    Eclipses::with_user_dut1(crate::timescale::user_dut1())
}

/// Every solar and lunar eclipse with greatest eclipse in `[jd_start, jd_end]` (UTC
/// Julian dates), clipped to the coverage: `EclipseList`.
#[wasm_bindgen]
pub fn eclipses(jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    let list = engine()
        .find(jd_start, jd_end)
        .map_err(|e| err(e.to_string()))?;
    to_js(&list)
}

/// Local circumstances of eclipse `id` (`"2024-04-08-solar"`) for an observer:
/// `EclipseLocal`.
#[wasm_bindgen]
pub fn eclipse_local(id: &str, observer_json: &str) -> Result<JsValue, JsValue> {
    let site = parse_observer(observer_json).map_err(err)?;
    let local = engine().local(id, &site).map_err(|e| err(e.to_string()))?;
    to_js(&local)
}

/// Paths of solar eclipse `id` on the map, or the sub-lunar points of a lunar one:
/// `EclipsePath`.
#[wasm_bindgen]
pub fn eclipse_path(id: &str) -> Result<JsValue, JsValue> {
    let path = engine().path(id).map_err(|e| err(e.to_string()))?;
    to_js(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observers_parse_with_defaults_and_are_range_checked() {
        let s = parse_observer(r#"{"lat_deg": 39.95, "lon_deg": -75.17}"#).unwrap();
        assert_eq!((s.lat_deg, s.lon_deg, s.height_m), (39.95, -75.17, 0.0));
        assert_eq!((s.pressure_hpa, s.temperature_c), (1010.0, 10.0));
        let s = parse_observer(r#"{"lat_deg": 0, "lon_deg": 180, "height_m": 1500}"#).unwrap();
        assert_eq!(s.height_m, 1500.0);
        for bad in [
            r#"{"lon_deg": 10}"#,
            r#"{"lat_deg": 91, "lon_deg": 0}"#,
            r#"{"lat_deg": 0, "lon_deg": 0, "height_m": 1e6}"#,
            "not json",
        ] {
            assert!(parse_observer(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_wire_shapes_carry_the_documented_fields() {
        // What `eclipses`, `eclipse_local` and `eclipse_path` serialise, checked as
        // JSON natively (the exports themselves need a JS host).
        let e = Eclipses::new();
        let list = e
            .find(
                skyfix_core::time::civil_to_jd(2024, 1, 1),
                skyfix_core::time::civil_to_jd(2025, 1, 1),
            )
            .unwrap();
        let v = serde_json::to_value(&list).unwrap();
        let ids: Vec<&str> = v["eclipses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "2024-03-25-lunar",
                "2024-04-08-solar",
                "2024-09-18-lunar",
                "2024-10-02-solar"
            ]
        );
        let solar = &v["eclipses"][1];
        for key in [
            "kind",
            "id",
            "type",
            "central",
            "greatest",
            "magnitude",
            "gamma",
            "saros",
            "lunation",
            "contacts",
            "path_width_km",
            "central_duration_s",
            "delta_t_s",
        ] {
            assert!(solar.get(key).is_some(), "solar summary lacks {key}");
        }
        assert_eq!(solar["kind"], "solar");
        assert_eq!(solar["type"], "total");
        let lunar = &v["eclipses"][0];
        assert_eq!(lunar["kind"], "lunar");
        assert_eq!(lunar["type"], "penumbral");
        assert!(lunar["total_duration_s"].is_null());

        let site =
            parse_observer(r#"{"lat_deg": 32.78, "lon_deg": -96.8, "height_m": 150}"#).unwrap();
        let local = serde_json::to_value(e.local("2024-04-08-solar", &site).unwrap()).unwrap();
        assert_eq!(local["kind"], "solar");
        assert_eq!(local["visibility"], "visible");
        assert_eq!(local["local_type"], "total");
        let kinds: Vec<&str> = local["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["c1", "c2", "max", "c3", "c4"]);

        let path = serde_json::to_value(e.path("2024-04-08-solar").unwrap()).unwrap();
        let seg = &path["central_line"]["segments"][0];
        assert!(seg[0].as_array().unwrap().len() == 2, "[lon, lat] pairs");
        assert_eq!(
            path["central_line"]["jd_utc"][0].as_array().unwrap().len(),
            seg.as_array().unwrap().len()
        );
        let lunar_path = serde_json::to_value(e.path("2024-03-25-lunar").unwrap()).unwrap();
        assert_eq!(lunar_path["kind"], "lunar");
        assert!(lunar_path["sublunar"].as_array().unwrap().len() >= 3);
        assert!(e.local("2024-04-09-solar", &site).is_err());
        assert!(e.path("2024-04-08-eclipse").is_err());
    }
}
