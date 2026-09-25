//! WASM exports for the sun tools: golden and blue hour, the azimuth search, the
//! alignment finder, the analemma, the sun path, rise and set azimuths through the year,
//! the equation of time, the clear-sky solar-energy estimate and the galactic centre's
//! dark-sky windows.
//!
//! OWNER: suntools agent (expansion programme P7). Wire format: `docs/EXPLORER_API.md`,
//! "Expansion programme — sun tools"; definitions: CONVENTIONS 13.10; TypeScript mirror:
//! `SunToolsEngine` in `web/src/next/engine/types.ts`. The engine is
//! `skyfix_almanac::sun_tools`.
//!
//! Two layers, as in `explorer.rs`: [`native`] parses the JSON arguments and returns
//! serde types or a `String` error (tested natively); the `#[wasm_bindgen]` exports call
//! it and serialise with `Serializer::json_compatible` (`None` is `null`). The astronomy
//! is the explorer's (`explorer::native::sky()`, DUT1 = 0) and observers are parsed by the
//! explorer's own `parse_observer`, so every number agrees with `sky_state`.

use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: JSON in, serde types out, `String` errors.
pub mod native {
    use serde::de::DeserializeOwned;
    use skyfix_almanac::sun_tools::alignment::{self, AlignmentRequest, AlignmentResult};
    use skyfix_almanac::sun_tools::analemma::{self, Analemma, AnalemmaRequest};
    use skyfix_almanac::sun_tools::azimuth::{self, AltitudeBand, AzimuthCrossing};
    use skyfix_almanac::sun_tools::eot::{self, EquationOfTime};
    use skyfix_almanac::sun_tools::galactic::{self, GalacticCentreWindows, GalacticOptions};
    use skyfix_almanac::sun_tools::hours::{self, SunHours};
    use skyfix_almanac::sun_tools::solar::{self, Panel, SolarDay, SolarYear, SolarYearRequest};
    use skyfix_almanac::sun_tools::sunpath::{self, RiseSetAzimuths, RiseSetRequest, SunPath};

    use crate::explorer::native::{parse_observer, sky};

    /// Parse an optional JSON argument: empty text or `null` is the type's default.
    fn optional<T: DeserializeOwned + Default>(what: &str, json: &str) -> Result<T, String> {
        let t = json.trim();
        if t.is_empty() || t == "null" {
            return Ok(T::default());
        }
        serde_json::from_str(t).map_err(|e| format!("{what}: {e}"))
    }

    fn required<T: DeserializeOwned>(what: &str, json: &str) -> Result<T, String> {
        serde_json::from_str(json.trim()).map_err(|e| format!("{what}: {e}"))
    }

    pub fn sun_hours(observer_json: &str, jd_start: f64, jd_end: f64) -> Result<SunHours, String> {
        let site = parse_observer(observer_json)?;
        hours::sun_hours(&sky(), &site, jd_start, jd_end).map_err(|e| e.to_string())
    }

    pub fn find_azimuth(
        observer_json: &str,
        body: &str,
        jd_start: f64,
        jd_end: f64,
        azimuth_deg: f64,
        band_json: &str,
    ) -> Result<Vec<AzimuthCrossing>, String> {
        let site = parse_observer(observer_json)?;
        let band: AltitudeBand = optional("band", band_json)?;
        azimuth::find_azimuth(&sky(), &site, body, jd_start, jd_end, azimuth_deg, &band)
            .map_err(|e| e.to_string())
    }

    pub fn alignment_days(
        observer_json: &str,
        request_json: &str,
    ) -> Result<AlignmentResult, String> {
        let site = parse_observer(observer_json)?;
        let request: AlignmentRequest = required("request", request_json)?;
        alignment::alignment_days(&sky(), &site, &request).map_err(|e| e.to_string())
    }

    pub fn analemma(observer_json: &str, request_json: &str) -> Result<Analemma, String> {
        let site = parse_observer(observer_json)?;
        let request: AnalemmaRequest = required("request", request_json)?;
        analemma::analemma(&sky(), &site, &request).map_err(|e| e.to_string())
    }

    pub fn sun_path(
        observer_json: &str,
        jd_start: f64,
        jd_end: f64,
        step_minutes: f64,
    ) -> Result<SunPath, String> {
        let site = parse_observer(observer_json)?;
        sunpath::sun_path(&sky(), &site, jd_start, jd_end, step_minutes).map_err(|e| e.to_string())
    }

    pub fn rise_set_azimuths(
        observer_json: &str,
        request_json: &str,
    ) -> Result<RiseSetAzimuths, String> {
        let site = parse_observer(observer_json)?;
        let request: RiseSetRequest = required("request", request_json)?;
        sunpath::rise_set_azimuths(&sky(), &site, &request).map_err(|e| e.to_string())
    }

    /// `year` arrives as a JS number: it must be a whole number.
    pub fn equation_of_time(year: f64, utc_hour: f64) -> Result<EquationOfTime, String> {
        if !(year.is_finite() && year.fract() == 0.0 && year.abs() < 1.0e6) {
            return Err(format!("year must be a whole number, got {year}"));
        }
        eot::equation_of_time(&sky(), year as i32, utc_hour).map_err(|e| e.to_string())
    }

    pub fn solar_day(
        observer_json: &str,
        jd_start: f64,
        jd_end: f64,
        panel_json: &str,
        step_minutes: f64,
    ) -> Result<SolarDay, String> {
        let site = parse_observer(observer_json)?;
        let panel: Panel = optional("panel", panel_json)?;
        solar::solar_day(&sky(), &site, jd_start, jd_end, &panel, step_minutes)
            .map_err(|e| e.to_string())
    }

    pub fn solar_year(observer_json: &str, request_json: &str) -> Result<SolarYear, String> {
        let site = parse_observer(observer_json)?;
        let request: SolarYearRequest = required("request", request_json)?;
        solar::solar_year(&sky(), &site, &request).map_err(|e| e.to_string())
    }

    pub fn galactic_centre_windows(
        observer_json: &str,
        jd_start: f64,
        jd_end: f64,
        options_json: &str,
    ) -> Result<GalacticCentreWindows, String> {
        let site = parse_observer(observer_json)?;
        let options: GalacticOptions = optional("options", options_json)?;
        galactic::galactic_centre_windows(&sky(), &site, jd_start, jd_end, &options)
            .map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Exports (EXPLORER_API.md "Expansion programme — sun tools")
// ---------------------------------------------------------------------------

/// Golden and blue hours over a window (one local day), with the Sun's events and the
/// sky phases: `SunHours`.
#[wasm_bindgen]
pub fn sun_hours(observer_json: &str, jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    to_js(&native::sun_hours(observer_json, jd_start, jd_end).map_err(err)?)
}

/// The instants a body crosses a bearing inside an altitude band: `AzimuthCrossing[]`.
/// `band_json` may be empty or `null` (above the horizon).
#[wasm_bindgen]
pub fn find_azimuth(
    observer_json: &str,
    body: &str,
    jd_start: f64,
    jd_end: f64,
    azimuth_deg: f64,
    band_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(
        &native::find_azimuth(
            observer_json,
            body,
            jd_start,
            jd_end,
            azimuth_deg,
            band_json,
        )
        .map_err(err)?,
    )
}

/// The days of a year a body rises, sets or stands at an altitude along a bearing:
/// `AlignmentResult`.
#[wasm_bindgen]
pub fn alignment_days(observer_json: &str, request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::alignment_days(observer_json, request_json).map_err(err)?)
}

/// The Sun at one clock time on every day of a year: `Analemma`.
#[wasm_bindgen]
pub fn analemma(observer_json: &str, request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::analemma(observer_json, request_json).map_err(err)?)
}

/// A day's sun path and the solstice and equinox envelope: `SunPath`.
#[wasm_bindgen]
pub fn sun_path(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    step_minutes: f64,
) -> Result<JsValue, JsValue> {
    to_js(&native::sun_path(observer_json, jd_start, jd_end, step_minutes).map_err(err)?)
}

/// Daily rise and set azimuths of a body over a local year: `RiseSetAzimuths`.
#[wasm_bindgen]
pub fn rise_set_azimuths(observer_json: &str, request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::rise_set_azimuths(observer_json, request_json).map_err(err)?)
}

/// The equation of time and the Sun's declination on every UTC date of a year:
/// `EquationOfTime`.
#[wasm_bindgen]
pub fn equation_of_time(year: f64, utc_hour: f64) -> Result<JsValue, JsValue> {
    to_js(&native::equation_of_time(year, utc_hour).map_err(err)?)
}

/// Clear-sky irradiance on a panel through a day, and the day's energy: `SolarDay`.
/// `panel_json` may be empty or `null` (a flat panel).
#[wasm_bindgen]
pub fn solar_day(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    panel_json: &str,
    step_minutes: f64,
) -> Result<JsValue, JsValue> {
    to_js(
        &native::solar_day(observer_json, jd_start, jd_end, panel_json, step_minutes)
            .map_err(err)?,
    )
}

/// Clear-sky energy on a panel for every local day of a year, by month and in total,
/// and optionally the best tilt: `SolarYear`.
#[wasm_bindgen]
pub fn solar_year(observer_json: &str, request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::solar_year(observer_json, request_json).map_err(err)?)
}

/// The galactic centre's dark-sky windows over a window of nights:
/// `GalacticCentreWindows`. `options_json` may be empty or `null` (defaults).
#[wasm_bindgen]
pub fn galactic_centre_windows(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    options_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(
        &native::galactic_centre_windows(observer_json, jd_start, jd_end, options_json)
            .map_err(err)?,
    )
}

#[cfg(test)]
mod tests {
    use skyfix_core::time::civil_to_jd;

    use super::native;

    const PHL: &str = r#"{"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12}"#;

    fn keys(v: &serde_json::Value, want: &[&str]) {
        for k in want {
            assert!(v.get(*k).is_some(), "missing {k} in {v}");
        }
    }

    #[test]
    fn every_export_answers_in_the_documented_shape() {
        let d0 = civil_to_jd(2026, 9, 24) + 4.0 / 24.0;
        let h = serde_json::to_value(native::sun_hours(PHL, d0, d0 + 1.0).unwrap()).unwrap();
        keys(
            &h,
            &[
                "jd_start",
                "jd_end",
                "windows",
                "boundaries",
                "sun",
                "phases",
            ],
        );
        keys(
            &h["windows"][0],
            &[
                "kind",
                "period",
                "jd_start",
                "utc_start",
                "jd_end",
                "utc_end",
                "duration_min",
                "open_start",
                "open_end",
            ],
        );
        assert_eq!(h["windows"][0]["kind"], "blue");
        assert_eq!(h["windows"][0]["period"], "morning");
        keys(
            &h["boundaries"][0],
            &["altitude_deg", "crossings", "always_above", "always_below"],
        );

        let az = native::find_azimuth(PHL, "sun", d0, d0 + 1.0, 180.0, "").unwrap();
        let az = serde_json::to_value(&az).unwrap();
        keys(
            &az[0],
            &[
                "jd_utc",
                "utc",
                "az_deg",
                "alt_deg",
                "alt_apparent_deg",
                "rising",
                "clockwise",
            ],
        );
        assert_eq!(
            native::find_azimuth(PHL, "sun", d0, d0 + 1.0, 0.0, "null")
                .unwrap()
                .len(),
            0,
            "due north is below the horizon"
        );
        let low = native::find_azimuth(PHL, "sun", d0, d0 + 1.0, 0.0, r#"{"min_deg": -90}"#);
        assert_eq!(low.unwrap().len(), 1);

        let al = native::alignment_days(
            PHL,
            r#"{"year": 2026, "azimuth_deg": 270, "tolerance_deg": 0.5, "event": {"kind": "set"},
                "utc_offset_hours": -5}"#,
        )
        .unwrap();
        let al = serde_json::to_value(&al).unwrap();
        keys(
            &al,
            &[
                "body",
                "year",
                "azimuth_deg",
                "tolerance_deg",
                "event",
                "utc_offset_hours",
                "jd_start",
                "jd_end",
                "truncated",
                "events_considered",
                "matches",
                "closest",
            ],
        );
        keys(
            &al["matches"][0],
            &[
                "date",
                "kind",
                "jd_utc",
                "utc",
                "az_deg",
                "offset_deg",
                "alt_deg",
                "best",
            ],
        );
        assert_eq!(al["event"]["kind"], "set");

        let an = native::analemma(PHL, r#"{"year": 2026, "time_h": 12, "clock": "lmt"}"#).unwrap();
        let an = serde_json::to_value(&an).unwrap();
        keys(
            &an,
            &[
                "year",
                "time_h",
                "clock",
                "utc_offset_hours",
                "points",
                "errors",
            ],
        );
        keys(
            &an["points"][0],
            &[
                "date",
                "jd_utc",
                "utc",
                "alt_deg",
                "alt_apparent_deg",
                "az_deg",
                "dec_deg",
                "eot_s",
            ],
        );

        let sp = serde_json::to_value(native::sun_path(PHL, d0, d0 + 1.0, 10.0).unwrap()).unwrap();
        keys(&sp, &["step_minutes", "path", "envelope", "errors"]);
        keys(
            &sp["path"],
            &["day", "jd_start", "jd_end", "season_jd_utc", "points"],
        );
        assert_eq!(sp["envelope"][1]["day"], "june_solstice");

        let rs = native::rise_set_azimuths(PHL, r#"{"year": 2026}"#).unwrap();
        let rs = serde_json::to_value(&rs).unwrap();
        keys(
            &rs,
            &[
                "body",
                "year",
                "utc_offset_hours",
                "jd_start",
                "jd_end",
                "truncated",
                "days",
            ],
        );
        keys(
            &rs["days"][0],
            &[
                "date",
                "jd_start",
                "jd_end",
                "rises",
                "sets",
                "transit",
                "always_above",
                "always_below",
            ],
        );

        let e = serde_json::to_value(native::equation_of_time(2026.0, 12.0).unwrap()).unwrap();
        keys(&e, &["year", "utc_hour", "points", "extremes", "errors"]);
        keys(
            &e["points"][0],
            &["date", "jd_utc", "utc", "eot_s", "dec_deg"],
        );
        assert!(native::equation_of_time(2026.5, 12.0).is_err());

        let sd = native::solar_day(PHL, d0, d0 + 1.0, r#"{"tilt_deg": 30}"#, 10.0).unwrap();
        let sd = serde_json::to_value(&sd).unwrap();
        keys(
            &sd,
            &[
                "jd_start",
                "jd_end",
                "step_minutes",
                "panel",
                "samples",
                "poa_kwh_m2",
                "ghi_kwh_m2",
                "dni_kwh_m2",
                "peak_poa_w_m2",
                "model",
            ],
        );
        assert_eq!(sd["panel"]["azimuth_deg"], 180.0);
        assert_eq!(sd["model"]["label"], "clear-sky estimate");
        keys(
            &sd["samples"][0],
            &[
                "jd_utc",
                "sun_alt_apparent_deg",
                "sun_az_deg",
                "ghi_w_m2",
                "dni_w_m2",
                "dhi_w_m2",
                "poa_w_m2",
                "incidence_deg",
            ],
        );
        assert!(native::solar_day(PHL, d0, d0 + 1.0, "", 10.0).is_ok());

        let sy = native::solar_year(
            PHL,
            r#"{"year": 2026, "panel": {"tilt_deg": 35}, "optimise_tilt": true}"#,
        )
        .unwrap();
        let sy = serde_json::to_value(&sy).unwrap();
        keys(
            &sy,
            &[
                "year",
                "utc_offset_hours",
                "step_minutes",
                "panel",
                "jd_start",
                "jd_end",
                "truncated",
                "days",
                "months",
                "poa_kwh_m2",
                "ghi_kwh_m2",
                "optimal",
                "model",
            ],
        );
        keys(&sy["optimal"], &["tilt_deg", "azimuth_deg", "poa_kwh_m2"]);

        let n0 = civil_to_jd(2026, 6, 15) + 2.0 / 24.0;
        let sso = r#"{"lat_deg": -31.2733, "lon_deg": 149.0617, "height_m": 1165}"#;
        let g = native::galactic_centre_windows(sso, n0, n0 + 1.0, "").unwrap();
        let g = serde_json::to_value(&g).unwrap();
        keys(
            &g,
            &[
                "jd_start",
                "jd_end",
                "min_altitude_deg",
                "sun_max_altitude_deg",
                "galactic_centre",
                "galactic_pole",
                "windows",
            ],
        );
        keys(
            &g["windows"][0],
            &[
                "jd_start",
                "utc_start",
                "jd_end",
                "utc_end",
                "duration_h",
                "moon_up",
                "moon_illuminated_fraction",
                "best",
            ],
        );
        keys(
            &g["windows"][0]["best"],
            &[
                "jd_utc",
                "utc",
                "alt_deg",
                "alt_apparent_deg",
                "az_deg",
                "arch_top_alt_deg",
                "arch_top_az_deg",
                "arch_ends_az_deg",
            ],
        );
    }

    #[test]
    fn malformed_arguments_are_refused_with_their_name() {
        let d0 = civil_to_jd(2026, 9, 24);
        let e = native::find_azimuth(PHL, "Sun", d0, d0 + 1.0, 90.0, "{\"low\": 3}").unwrap_err();
        assert!(e.starts_with("band:"), "{e}");
        let e = native::alignment_days(PHL, "{}").unwrap_err();
        assert!(e.starts_with("request:"), "{e}");
        let e = native::solar_day(PHL, d0, d0 + 1.0, "{\"tilt\": 3}", 10.0).unwrap_err();
        assert!(e.starts_with("panel:"), "{e}");
        let e = native::galactic_centre_windows(PHL, d0, d0 + 1.0, "{\"moon\": 0}").unwrap_err();
        assert!(e.starts_with("options:"), "{e}");
        let e = native::sun_hours("{\"lat_deg\": 95, \"lon_deg\": 0}", d0, d0 + 1.0).unwrap_err();
        assert!(e.contains("lat_deg"), "{e}");
        assert!(native::analemma(PHL, r#"{"year": 2026, "time_h": 12, "clock": "zone"}"#).is_err());
    }
}
