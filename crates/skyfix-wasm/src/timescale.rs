//! WASM exports for time scales: `time_info`, `set_dut1`, `calendar_convert`.
//!
//! OWNER: timescales agent (expansion programme, wave 1). Wire format:
//! docs/EXPLORER_API.md, "Expansion programme" (`time_info`, dates and years on the
//! wire, and the timescales section after it); definitions: CONVENTIONS 15.2-15.3 and
//! `skyfix_core::{time, deltat, calendar}`.
//!
//! The explorer-wide user DUT1 lives here ([`user_dut1`]). The explorer's `Sky` (built
//! per request in `explorer.rs`, `native::sky_at`) and the eclipse engine
//! (`eclipses.rs`) read it; the almanac page does not, because its argument is UT1 as
//! in the printed almanac (see `almanac.rs`). A session's `clock.dut1_s` overrides it
//! for that session (the navigation exports, moonshape agent).

use std::cell::Cell;

use wasm_bindgen::prelude::*;

use crate::{err, to_js};

thread_local! {
    static USER_DUT1: Cell<Option<f64>> = const { Cell::new(None) };
}

/// The explorer-wide DUT1 set with [`set_dut1`], seconds, or `None`.
pub fn user_dut1() -> Option<f64> {
    USER_DUT1.with(Cell::get)
}

/// The native layer: plain arguments in, serde types out, `String` errors.
pub mod native {
    use serde::{Deserialize, Serialize};
    use skyfix_core::calendar::Calendar;
    use skyfix_core::calendar::{self, CalendarConversion, CalendarConvertRequest, CivilDate};
    use skyfix_core::deltat::DeltaTSource;
    use skyfix_core::time::{self, ClockScale, Dut1Source};

    /// Largest |DUT1| accepted: UT1 - UTC stays within 0.9 s while leap seconds last.
    pub const MAX_USER_DUT1_S: f64 = 1.0;

    /// Store (or clear, with `None`) the explorer-wide DUT1.
    pub fn set_dut1(seconds: Option<f64>) -> Result<(), String> {
        if let Some(v) = seconds
            && !(v.is_finite() && v.abs() <= MAX_USER_DUT1_S)
        {
            return Err(format!(
                "DUT1 {v} s: UT1 - UTC stays within +-0.9 s while leap seconds last \
                 (the time signal's DUT1 code); give a value within +-{MAX_USER_DUT1_S} s, or \
                 null for the IERS history"
            ));
        }
        super::USER_DUT1.with(|c| c.set(seconds));
        Ok(())
    }

    /// `time_info`'s wire shape (EXPLORER_API.md): `skyfix_core::time::TimeInfo` plus the
    /// coverage tier.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct TimeInfoWire {
        pub jd_utc: f64,
        pub utc: String,
        pub scale: ClockScale,
        pub tier: String,
        pub delta_t_s: f64,
        pub delta_t_sigma_s: f64,
        pub delta_t_source: DeltaTSource,
        pub tt_minus_clock_s: f64,
        pub dut1_s: f64,
        pub dut1_sigma_s: f64,
        pub dut1_source: Dut1Source,
        pub calendar: Calendar,
        pub civil: CivilDate,
        pub julian_civil: CivilDate,
        pub notes: Vec<String>,
    }

    /// The coverage tier of an instant: `crate::coverage::native::tier_at` (deeptime
    /// agent), `validated`, `labelled` or `outside`.
    pub fn tier_at(jd_utc: f64) -> &'static str {
        crate::coverage::native::tier_at(jd_utc)
    }

    /// Everything the interface needs to label `jd_utc` (EXPLORER_API.md, `time_info`).
    pub fn time_info(jd_utc: f64) -> Result<TimeInfoWire, String> {
        let t = time::time_info(jd_utc, super::user_dut1()).map_err(|e| e.to_string())?;
        Ok(TimeInfoWire {
            jd_utc: t.jd_utc,
            utc: t.utc,
            scale: t.scale,
            tier: tier_at(jd_utc).to_string(),
            delta_t_s: t.delta_t_s,
            delta_t_sigma_s: t.delta_t_sigma_s,
            delta_t_source: t.delta_t_source,
            tt_minus_clock_s: t.tt_minus_clock_s,
            dut1_s: t.dut1_s,
            dut1_sigma_s: t.dut1_sigma_s,
            dut1_source: t.dut1_source,
            calendar: t.calendar,
            civil: t.civil,
            julian_civil: t.julian_civil,
            notes: t.notes,
        })
    }

    /// Convert between a JD and civil dates in either calendar (EXPLORER_API.md).
    pub fn calendar_convert(request_json: &str) -> Result<CalendarConversion, String> {
        let req: CalendarConvertRequest = serde_json::from_str(request_json.trim())
            .map_err(|e| format!("calendar_convert request: {e}"))?;
        calendar::calendar_convert(&req).map_err(|e| e.to_string())
    }
}

/// Store the explorer-wide DUT1 = UT1 - UTC in seconds (from the time signal), or clear
/// it with `null`/`undefined` to return to the IERS history and the model. It applies on
/// the UTC scale (1972-2035); a session's own `clock.dut1_s` overrides it for that
/// session. Throws for a non-finite value or one beyond +-1 s.
#[wasm_bindgen]
pub fn set_dut1(seconds: Option<f64>) -> Result<(), JsValue> {
    native::set_dut1(seconds).map_err(err)
}

/// `TimeInfo` for an instant on the app's clock: its scale (UTC or UT), coverage tier,
/// Delta-T and DUT1 with their uncertainties and sources, and the civil date in the
/// displayed calendar and in the Julian calendar.
#[wasm_bindgen]
pub fn time_info(jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::time_info(jd_utc).map_err(err)?)
}

/// `CalendarConversion` for `{"jd_utc": …}` or `{"civil": {calendar, year, month, day,
/// hour?, minute?, second?}}`: the instant and its date in both calendars.
#[wasm_bindgen]
pub fn calendar_convert(request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::calendar_convert(request_json).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::native::*;

    fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn time_info_has_the_documented_shape() {
        set_dut1(None).unwrap();
        let v = json(&time_info(2_461_308.0).unwrap());
        for k in [
            "jd_utc",
            "utc",
            "scale",
            "tier",
            "delta_t_s",
            "delta_t_sigma_s",
            "delta_t_source",
            "tt_minus_clock_s",
            "dut1_s",
            "dut1_sigma_s",
            "dut1_source",
            "calendar",
            "civil",
            "julian_civil",
            "notes",
        ] {
            assert!(v.get(k).is_some(), "missing {k}: {v}");
        }
        assert_eq!(v["utc"], "2026-09-24T12:00:00.000Z");
        assert_eq!(v["scale"], "utc");
        assert_eq!(v["tier"], "validated");
        assert_eq!(v["delta_t_source"], "iers");
        assert_eq!(v["dut1_source"], "iers");
        assert_eq!(v["calendar"], "gregorian");
        for k in [
            "calendar", "year", "month", "day", "hour", "minute", "second", "era_year", "era",
        ] {
            assert!(
                v["civil"].get(k).is_some() && v["julian_civil"].get(k).is_some(),
                "{k}"
            );
        }
        assert_eq!(v["julian_civil"]["day"], 11);
        assert!((v["tt_minus_clock_s"].as_f64().unwrap() - 69.184).abs() < 1e-6);
    }

    #[test]
    fn set_dut1_is_explorer_wide_and_checked() {
        set_dut1(Some(-0.25)).unwrap();
        assert_eq!(super::user_dut1(), Some(-0.25));
        let v = json(&time_info(2_461_308.0).unwrap());
        assert_eq!(v["dut1_source"], "user");
        assert_eq!(v["dut1_s"], -0.25);
        // Outside the UTC scale the clock is UT: the value does not apply.
        let old = json(&time_info(1_507_900.0).unwrap());
        assert_eq!(old["dut1_source"], "model");
        assert_eq!(old["scale"], "ut");
        assert!(set_dut1(Some(3.0)).is_err() && set_dut1(Some(f64::NAN)).is_err());
        assert_eq!(
            super::user_dut1(),
            Some(-0.25),
            "a refused value changes nothing"
        );
        set_dut1(None).unwrap();
        assert_eq!(super::user_dut1(), None);
    }

    #[test]
    fn far_dates_are_labelled() {
        set_dut1(None).unwrap();
        // 585 BC May 28 (Julian), noon: UT, Julian calendar, Delta-T about 5.1 h +- 2.6 min.
        let v = json(&time_info(1_507_900.0).unwrap());
        assert_eq!(v["utc"], "-0584-05-22T12:00:00.000Z");
        assert_eq!(v["calendar"], "julian");
        assert_eq!(v["civil"]["year"], -584);
        assert_eq!(v["civil"]["day"], 28);
        assert_eq!(v["civil"]["era_year"], 585);
        assert_eq!(v["civil"]["era"], "BC");
        // deeptime agent: 585 BC is in the labelled tier (2000 BC to AD 3000).
        assert_eq!(v["tier"], "labelled");
        assert_eq!(json(&time_info(990_000.0).unwrap())["tier"], "outside");
        assert_eq!(v["delta_t_source"], "smh2016");
        let dt = v["delta_t_s"].as_f64().unwrap();
        assert!((18_000.0..18_500.0).contains(&dt), "{dt}");
        let sigma = v["delta_t_sigma_s"].as_f64().unwrap();
        assert!((150.0..170.0).contains(&sigma), "{sigma}");
        assert!(time_info(f64::NAN).is_err());
    }

    #[test]
    fn calendar_convert_both_ways() {
        let r = json(&calendar_convert(r#"{"jd_utc": 2299160.5}"#).unwrap());
        assert_eq!(r["gregorian"]["day"], 15);
        assert_eq!(r["julian"]["day"], 5);
        let r = json(
            &calendar_convert(
                r#"{"civil": {"calendar": "julian", "year": 1582, "month": 10, "day": 4, "hour": 12}}"#,
            )
            .unwrap(),
        );
        assert_eq!(r["jd_utc"], 2_299_160.0);
        assert_eq!(r["gregorian"]["month"], 10);
        assert_eq!(r["gregorian"]["day"], 14);
        assert!(calendar_convert("{}").is_err());
        assert!(
            calendar_convert(
                r#"{"jd_utc": 1, "civil": {"calendar": "julian", "year": 1, "month": 1, "day": 1}}"#
            )
            .is_err()
        );
        assert!(
            calendar_convert(
                r#"{"civil": {"calendar": "mayan", "year": 1, "month": 1, "day": 1}}"#
            )
            .is_err()
        );
        assert!(calendar_convert("not json").is_err());
    }
}
