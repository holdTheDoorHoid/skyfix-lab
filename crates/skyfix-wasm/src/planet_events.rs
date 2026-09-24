//! WASM export for the explorer: planet events.
//!
//! OWNER: eclipse agent (sky events). Wire format: `docs/EXPLORER_API.md`, "Wave 2 —
//! planet events"; TypeScript mirror: `PlanetEventsEngine` in
//! `web/src/next/engine/types.ts`. The finder is `skyfix_almanac::planet_events`.

use skyfix_almanac::planet_events::planet_events as find;
use skyfix_ephemeris::planets::PlanetProvider;
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// Every opposition, conjunction with the Sun, greatest elongation (Mercury, Venus) and
/// closest approach of Mercury to Neptune with its instant in `[jd_start, jd_end]` (UTC
/// Julian dates), clipped to the coverage: `PlanetEventList`. About 30 ms per year
/// natively.
#[wasm_bindgen]
pub fn planet_events(jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    let list = find(&PlanetProvider::new(), jd_start, jd_end).map_err(|e| err(e.to_string()))?;
    to_js(&list)
}

#[cfg(test)]
mod tests {
    use skyfix_core::time::civil_to_jd;

    use super::*;

    #[test]
    fn the_wire_shape_carries_the_documented_fields() {
        let list = find(
            &PlanetProvider::new(),
            civil_to_jd(2024, 12, 1),
            civil_to_jd(2024, 12, 31),
        )
        .unwrap();
        let v = serde_json::to_value(&list).unwrap();
        let e = v["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["body"] == "Jupiter" && e["kind"] == "opposition")
            .expect("Jupiter's opposition of 2024-12-07");
        for key in [
            "kind",
            "body",
            "jd_utc",
            "utc",
            "elongation_deg",
            "distance_au",
            "distance_km",
            "magnitude",
            "ra_deg",
            "dec_deg",
            "transit",
        ] {
            assert!(e.get(key).is_some(), "planet event lacks {key}");
        }
        assert_eq!(v["truncated"], false);
    }
}
