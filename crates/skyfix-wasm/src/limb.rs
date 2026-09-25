//! WASM exports: the lunar limb, from the optional `lunar-limb` pack.
//!
//! OWNER: eclipselimb agent (expansion programme P12). Wire format:
//! `docs/EXPLORER_API.md`, "Expansion programme P12 — the lunar limb"; TypeScript mirror:
//! `EclipseLocalOptions`, `SolarEclipseLimb` and `LimbEngine` in
//! `web/src/next/engine/types.ts`; definitions: CONVENTIONS 15.6 and
//! `skyfix_almanac::eclipses::limb`.
//!
//! The decoded ring lives in this module once the pack is installed, for the page
//! session (CONVENTIONS 15.5):
//!
//! - [`install_lunar_limb`] is the producer function the pack dispatcher calls
//!   (`packs::PRODUCERS`, entry `lunar-limb`) with a payload whose header and CRC-32 it
//!   has checked. A malformed payload changes nothing; a second install replaces the first.
//! - `eclipse_local_limb(id, observer_json)` is `eclipse_local` with the limb-corrected
//!   block `limb` in a solar eclipse's result: corrected when the pack is loaded, else
//!   the mean-limb results and a note that the pack refines them. `eclipse_local` itself
//!   is unchanged.
//! - `lunar_limb_profile(observer_json, jd_utc)` draws the limb at any instant (throws
//!   `pack_not_loaded: …` without the pack); `lunar_limb_info()` says what is loaded.

use std::sync::{Arc, RwLock};

use serde::Serialize;
use skyfix_almanac::eclipses::LimbRing;
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

static RING: RwLock<Option<Arc<LimbRing>>> = RwLock::new(None);

/// What `lunar_limb_info` reports about the installed ring.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LimbPackInfo {
    pub name: &'static str,
    pub version: String,
    pub source: String,
    pub step_deg: f64,
    pub resolution_km: f64,
    pub reference_radius_km: f64,
    /// The ring's extent from the mean limb, degrees.
    pub delta_min_deg: f64,
    pub delta_max_deg: f64,
    pub min_height_m: f64,
    pub max_height_m: f64,
}

/// The native layer: plain arguments in, serde types out, `String` errors.
pub mod native {
    use super::*;
    use skyfix_almanac::eclipses::limb::PACK_NAME;
    use skyfix_almanac::eclipses::{EclipseLocal, Eclipses, LimbProfile, profile_at};
    use skyfix_ephemeris::moon::MoonProvider;
    use skyfix_ephemeris::sun::SunProvider;

    use crate::explorer::native::parse_observer;

    /// The sentence every query that needs the pack throws without it.
    pub fn pack_not_loaded() -> String {
        "pack_not_loaded: the lunar limb profile needs the lunar-limb pack (LRO LOLA \
         topography), which is not loaded"
            .to_string()
    }

    /// The installed ring, if any.
    pub fn installed() -> Option<Arc<LimbRing>> {
        RING.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn info(ring: &LimbRing) -> LimbPackInfo {
        let (lo, hi) = ring.delta_range_deg();
        let (hmin, hmax) = ring.height_range_m();
        LimbPackInfo {
            name: PACK_NAME,
            version: ring.version().to_string(),
            source: ring.source().to_string(),
            step_deg: ring.step_deg(),
            resolution_km: ring.step_deg().to_radians() * ring.reference_radius_km(),
            reference_radius_km: ring.reference_radius_km(),
            delta_min_deg: lo,
            delta_max_deg: hi,
            min_height_m: hmin,
            max_height_m: hmax,
        }
    }

    /// Parse and install a `lunar-limb` payload (the dispatcher has checked the header).
    pub fn install_payload(payload: &[u8]) -> Result<LimbPackInfo, String> {
        let ring = LimbRing::parse(payload)?;
        let i = info(&ring);
        *RING.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(ring));
        Ok(i)
    }

    /// The installed ring's summary, or `None`.
    pub fn pack_info() -> Option<LimbPackInfo> {
        installed().map(|r| info(&r))
    }

    /// `eclipse_local` with the limb block, from `ring` when given.
    pub fn eclipse_local_limb_in(
        ring: Option<&LimbRing>,
        id: &str,
        observer_json: &str,
    ) -> Result<EclipseLocal, String> {
        let site = parse_observer(observer_json)?;
        Eclipses::with_user_dut1(crate::timescale::user_dut1())
            .local_with_limb(id, &site, ring)
            .map_err(|e| e.to_string())
    }

    /// The Moon's outline as the observer sees it at `jd_utc`, from `ring`.
    pub fn lunar_limb_profile_in(
        ring: Option<&LimbRing>,
        observer_json: &str,
        jd_utc: f64,
    ) -> Result<LimbProfile, String> {
        let ring = ring.ok_or_else(pack_not_loaded)?;
        if !jd_utc.is_finite() {
            return Err("jd_utc must be a finite Julian date".into());
        }
        let site = parse_observer(observer_json)?;
        let dut1 = skyfix_core::time::dut1_s(jd_utc, crate::timescale::user_dut1());
        profile_at(
            ring,
            &MoonProvider::with_dut1_s(dut1),
            &SunProvider::with_dut1_s(dut1),
            &site,
            jd_utc,
        )
        .map_err(|e| e.to_string())
    }
}

/// The producer function of the `lunar-limb` entry in `packs::PRODUCERS`: the dispatcher
/// has checked the common header and the CRC-32 and calls this with the payload.
pub fn install_lunar_limb(payload: &[u8]) -> Result<crate::packs::PackInfo, String> {
    let info = native::install_payload(payload)?;
    Ok(crate::packs::PackInfo {
        name: info.name.to_string(),
        version: info.version,
        bytes: 0,
        provides: vec!["eclipses:lunar-limb".to_string()],
    })
}

/// Local circumstances of eclipse `id` for an observer, as `eclipse_local`, with the
/// limb-corrected block `limb` for a solar eclipse: `EclipseLocal`.
#[wasm_bindgen]
pub fn eclipse_local_limb(id: &str, observer_json: &str) -> Result<JsValue, JsValue> {
    let ring = native::installed();
    to_js(&native::eclipse_local_limb_in(ring.as_deref(), id, observer_json).map_err(err)?)
}

/// The Moon's limb profile as the observer sees it at `jd_utc`: `LimbProfile`. Throws
/// `pack_not_loaded: …` until the lunar-limb pack is installed.
#[wasm_bindgen]
pub fn lunar_limb_profile(observer_json: &str, jd_utc: f64) -> Result<JsValue, JsValue> {
    let ring = native::installed();
    to_js(&native::lunar_limb_profile_in(ring.as_deref(), observer_json, jd_utc).map_err(err)?)
}

/// The installed lunar-limb pack's `LimbPackInfo`, or `null` when none is loaded.
#[wasm_bindgen]
pub fn lunar_limb_info() -> Result<JsValue, JsValue> {
    to_js(&native::pack_info())
}

#[cfg(test)]
mod tests {
    use super::native::*;

    /// The pack committed to the site, decoded (every test here uses its own copy, so the
    /// module-wide slot is not shared between parallel tests).
    fn committed_ring() -> Option<skyfix_almanac::eclipses::LimbRing> {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs");
        let entry = std::fs::read_dir(&dir).ok()?.find_map(|e| {
            let e = e.ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            (name.starts_with("lunar-limb-") && name.ends_with(".bin")).then(|| e.path())
        })?;
        let bytes = std::fs::read(entry).unwrap();
        let h = crate::packs::parse(&bytes).unwrap();
        Some(skyfix_almanac::eclipses::LimbRing::parse(h.payload).unwrap())
    }

    #[test]
    fn without_the_pack_the_mean_limb_comes_with_a_note_and_the_profile_throws() {
        let obs = r#"{"lat_deg": 32.7767, "lon_deg": -96.797, "height_m": 150}"#;
        let l = serde_json::to_value(eclipse_local_limb_in(None, "2024-04-08-solar", obs).unwrap())
            .unwrap();
        assert_eq!(l["kind"], "solar");
        assert_eq!(l["limb"]["loaded"], false);
        assert!(
            l["limb"]["note"]
                .as_str()
                .unwrap()
                .contains("Lunar limb data pack")
        );
        assert!(l["limb"]["contacts"].as_array().unwrap().is_empty());
        // The mean-limb fields are eclipse_local's.
        let plain = crate::eclipses::parse_observer(obs).unwrap();
        let mean = skyfix_almanac::eclipses::Eclipses::with_user_dut1(None)
            .local("2024-04-08-solar", &plain)
            .unwrap();
        let mean = serde_json::to_value(mean).unwrap();
        assert_eq!(l["events"], mean["events"]);
        assert!(
            mean.get("limb").is_none(),
            "eclipse_local grew a limb field"
        );
        let e = lunar_limb_profile_in(None, obs, 2_460_409.28).unwrap_err();
        assert!(e.starts_with("pack_not_loaded:"), "{e}");
    }

    #[test]
    fn with_the_pack_a_total_eclipse_gets_corrected_contacts_and_a_lunar_eclipse_none() {
        let Some(ring) = committed_ring() else {
            return;
        };
        let obs = r#"{"lat_deg": 39.7684, "lon_deg": -86.1581, "height_m": 220}"#;
        let l = serde_json::to_value(
            eclipse_local_limb_in(Some(&ring), "2024-04-08-solar", obs).unwrap(),
        )
        .unwrap();
        let limb = &l["limb"];
        assert_eq!(limb["loaded"], true);
        assert_eq!(limb["local_type"], "total");
        let kinds: Vec<&str> = limb["contacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["c1", "c2", "c3", "c4"]);
        // The eclipse's drawing is every 1/8 degree; lunar_limb_profile every 1/16.
        assert_eq!(
            limb["profile"]["height_arcsec"].as_array().unwrap().len(),
            2880
        );
        // A lunar eclipse has no limb block.
        let lunar = serde_json::to_value(
            eclipse_local_limb_in(Some(&ring), "2025-03-14-lunar", obs).unwrap(),
        )
        .unwrap();
        assert_eq!(lunar["kind"], "lunar");
        assert!(lunar.get("limb").is_none());
        let p = lunar_limb_profile_in(Some(&ring), obs, 2_460_409.30).unwrap();
        assert_eq!(p.height_arcsec.len(), 5760);
    }

    #[test]
    fn a_damaged_payload_is_refused_and_leaves_nothing_installed() {
        // install_payload writes the module-wide slot; the refused payload never reaches
        // it, whatever another test installed.
        let before = installed().map(|r| r.version().to_string());
        assert!(install_payload(b"LIMB\x02\x00").is_err());
        assert_eq!(installed().map(|r| r.version().to_string()), before);
    }
}
