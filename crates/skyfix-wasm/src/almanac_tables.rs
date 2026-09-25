//! WASM exports for the almanac's tables and three-day openings.
//!
//! OWNER: almanac2 agent (expansion programme Q7). Wire format: docs/EXPLORER_API.md,
//! "Expansion programme — almanac tables and three-day pages"; definitions: CONVENTIONS
//! 13.9.1, `skyfix_almanac::tables` and `skyfix_almanac::opening`.
//!
//! Same two layers as `almanac.rs`: [`native`] takes the export's arguments and returns
//! the serde type (tested natively), and each `#[wasm_bindgen]` export serialises it with
//! `Serializer::json_compatible`. The astronomy is the almanac pages' own provider
//! ([`native::sky`]): DUT1 = 0 because the pages' argument is UT1 (CONVENTIONS 15.2).

use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: plain arguments in, serde types out, `String` errors.
pub mod native {
    use skyfix_almanac::opening::{AlmanacOpening, almanac_opening};
    use skyfix_almanac::tables::{
        AltitudeTables, ArcToTime, Conditions, IncrementsMinute, PlanetCorrections, PolarisTable,
        altitude_tables, arc_to_time, increments, planet_corrections, polaris_table,
    };
    use skyfix_core::calendar::Calendar;
    use skyfix_ephemeris::body::Sky;
    use skyfix_ephemeris::tiers::TierPolicy;

    /// The provider of the almanac pages and tables: the explorer's display sky, answering
    /// the labelled tier too (2001 BC to AD 3000; polish2, after the deeptime merge): an
    /// almanac is for display, never a sight, and the interface puts the ±ΔT chip and the
    /// estimate's note on a labelled page. DUT1 = 0: the pages' argument is UT1.
    pub fn sky() -> Sky {
        Sky::new().with_policy(TierPolicy::WithLabelled)
    }

    /// `""` or `"auto"`: the display calendar (Julian before 1582-10-15); else
    /// `"julian"` or `"gregorian"`.
    pub fn parse_calendar(text: &str) -> Result<Option<Calendar>, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(None),
            other => other.parse::<Calendar>().map(Some),
        }
    }

    /// A whole year in −100 000..=100 000 from a JS number.
    fn parse_year(year: f64) -> Result<i64, String> {
        if !year.is_finite() || year.fract() != 0.0 || year.abs() > 100_000.0 {
            return Err(format!("year must be a whole number, got {year}"));
        }
        Ok(year as i64)
    }

    /// The calendar a year's table is in: the named one, or Julian up to 1582.
    fn year_calendar(year: i64, text: &str) -> Result<Calendar, String> {
        Ok(parse_calendar(text)?.unwrap_or(if year <= 1582 {
            Calendar::Julian
        } else {
            Calendar::Gregorian
        }))
    }

    /// The opening (three dates, two facing pages) containing the UT date `date`.
    pub fn opening(date: &str, calendar: &str) -> Result<AlmanacOpening, String> {
        almanac_opening(&sky(), date, parse_calendar(calendar)?).map_err(|e| e.to_string())
    }

    pub fn increments_minute(minute: u32) -> Result<IncrementsMinute, String> {
        increments(minute)
    }

    /// The same from a JS number: a whole minute 0 to 59, else an error. (verify2: the
    /// export took a `u32`, and wasm-bindgen's number conversion turned 58.7 into 58 and
    /// NaN into 0 without a word.)
    pub fn increments_minute_number(minute: f64) -> Result<IncrementsMinute, String> {
        if !(minute.is_finite() && minute.fract() == 0.0 && (0.0..=59.0).contains(&minute)) {
            return Err(format!(
                "minute must be a whole number from 0 to 59, got {minute}"
            ));
        }
        increments(minute as u32)
    }

    pub fn arc_time() -> ArcToTime {
        arc_to_time()
    }

    /// `conditions_json`: `""`, `"null"`, or `{"temperature_c": .., "pressure_hpa": ..}`.
    pub fn altitude(conditions_json: &str) -> Result<AltitudeTables, String> {
        let text = conditions_json.trim();
        let conditions: Option<Conditions> = if text.is_empty() || text == "null" {
            None
        } else {
            Some(serde_json::from_str(text).map_err(|e| {
                format!(
                    "conditions must be {{\"temperature_c\": number, \"pressure_hpa\": \
                     number}} or null: {e}"
                )
            })?)
        };
        altitude_tables(conditions)
    }

    pub fn planets(year: f64, calendar: &str) -> Result<PlanetCorrections, String> {
        let y = parse_year(year)?;
        planet_corrections(&sky(), y, year_calendar(y, calendar)?).map_err(|e| e.to_string())
    }

    pub fn polaris(year: f64, calendar: &str) -> Result<PolarisTable, String> {
        let y = parse_year(year)?;
        // The validated tier only: the a0, a1, a2 method holds while Polaris is near the pole
        // (2.9 degrees from it in 1550, 0.45 in 2100); in 1000 it was 6 degrees off and by
        // 2000 BC Thuban was the pole star, so the labelled tier gets no Polaris tables.
        polaris_table(&Sky::new(), y, year_calendar(y, calendar)?).map_err(|e| e.to_string())
    }
}

/// The printed almanac's two facing pages for the three UT dates containing `date`
/// (`YYYY-MM-DD`, proleptic Gregorian, expanded years allowed), grouped in `calendar`
/// (`""`/`"auto"`, `"julian"` or `"gregorian"`). About three `almanac_day` calls.
#[wasm_bindgen]
pub fn almanac_opening(date: &str, calendar: &str) -> Result<JsValue, JsValue> {
    to_js(&native::opening(date, calendar).map_err(err)?)
}

/// The Increments and Corrections table for one minute of time (0 to 59).
#[wasm_bindgen]
pub fn almanac_increments(minute: f64) -> Result<JsValue, JsValue> {
    to_js(&native::increments_minute_number(minute).map_err(err)?)
}

/// Conversion of Arc to Time.
#[wasm_bindgen]
pub fn almanac_arc_to_time() -> Result<JsValue, JsValue> {
    to_js(&native::arc_time())
}

/// The altitude correction tables (Sun, stars and planets, dip, non-standard
/// conditions, the Moon); `conditions_json` adds the exact corrections for one
/// temperature and pressure.
#[wasm_bindgen]
pub fn almanac_altitude_tables(conditions_json: &str) -> Result<JsValue, JsValue> {
    to_js(&native::altitude(conditions_json).map_err(err)?)
}

/// The additional corrections for Venus and Mars through `year`.
#[wasm_bindgen]
pub fn almanac_planet_corrections(year: f64, calendar: &str) -> Result<JsValue, JsValue> {
    to_js(&native::planets(year, calendar).map_err(err)?)
}

/// The Polaris tables for `year`.
#[wasm_bindgen]
pub fn almanac_polaris(year: f64, calendar: &str) -> Result<JsValue, JsValue> {
    to_js(&native::polaris(year, calendar).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::native::*;

    fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn the_opening_has_the_documented_shape() {
        let v = json(&opening("2016-03-08", "").unwrap());
        for k in [
            "date",
            "calendar",
            "index",
            "dates",
            "days",
            "moon_dates",
            "moon_rows",
            "planet_sha_00h",
            "notes",
            "errors",
        ] {
            assert!(v.get(k).is_some(), "AlmanacOpening missing {k}");
        }
        assert_eq!(v["calendar"], "gregorian");
        assert_eq!(v["index"], 1);
        assert_eq!(v["dates"][0]["date"], "2016-03-07");
        assert_eq!(v["dates"][0]["era"], "AD");
        assert_eq!(v["days"].as_array().unwrap().len(), 3);
        assert_eq!(v["moon_rows"][0]["moonrise"].as_array().unwrap().len(), 4);
        assert!(v["planet_sha_00h"][0]["printed"]["gha"].is_string());
        // Julian grouping is named and reported.
        let j = json(&opening("2016-03-08", "julian").unwrap());
        assert_eq!(j["calendar"], "julian");
        assert!(opening("2016-03-08", "mayan").is_err());
        assert!(
            opening("08/03/2016", "")
                .unwrap_err()
                .contains("YYYY-MM-DD")
        );
    }

    #[test]
    fn a_minute_must_be_whole_and_conditions_have_two_keys() {
        // verify2: 58.7 and NaN reached the table as 58 and 0 through the u32 export.
        assert!(increments_minute_number(58.0).is_ok());
        for bad in [58.7, -1.0, 60.0, f64::NAN, f64::INFINITY] {
            assert!(increments_minute_number(bad).is_err(), "{bad}");
        }
        assert!(altitude(r#"{"temperature_c": 30, "pressure_hpa": 1000}"#).is_ok());
        let e = altitude(r#"{"temperature_c": 30, "pressure_hpa": 1000, "limit": 5}"#).unwrap_err();
        assert!(e.contains("limit"), "{e}");
    }

    #[test]
    fn the_tables_have_the_documented_shape() {
        let inc = json(&increments_minute(58).unwrap());
        assert_eq!(inc["rows"][27]["aries"]["printed"], "14 39.2");
        assert_eq!(inc["corrections"].as_array().unwrap().len(), 181);
        assert!(increments_minute(60).is_err());
        let at = json(&arc_time());
        assert_eq!(at["arcminutes"][27]["printed"][0], "1 48");
        let alt = json(&altitude("").unwrap());
        for k in [
            "sun_oct_mar",
            "sun_apr_sep",
            "stars_planets",
            "low",
            "dip",
            "additional",
            "moon",
            "examples",
            "notes",
        ] {
            assert!(alt.get(k).is_some(), "AltitudeTables missing {k}");
        }
        assert!(alt["additional"]["conditions"].is_null());
        let c = json(&altitude(r#"{"temperature_c": 31, "pressure_hpa": 982}"#).unwrap());
        assert_eq!(c["additional"]["conditions"]["zone"], "M");
        assert!(altitude(r#"{"temperature_c": 31}"#).is_err());
        assert!(altitude("{").is_err());
        let p = json(&polaris(2016.0, "").unwrap());
        assert_eq!(p["calendar"], "gregorian");
        assert_eq!(p["columns"].as_array().unwrap().len(), 36);
        assert_eq!(p["columns"][12]["a1"][4]["printed"], "0.5");
        assert!(polaris(2016.5, "").is_err());
        let pl = json(&planets(2024.0, "").unwrap());
        assert!(!pl["venus"].as_array().unwrap().is_empty());
    }

    #[test]
    fn years_outside_the_ephemeris_are_refused_or_reported() {
        // Polaris: the validated tier only (the method needs the star near the pole).
        let e = polaris(1000.0, "").unwrap_err();
        assert!(e.contains("Polaris"), "{e}");
        // Venus and Mars: the display sky's labelled tier (polish2), in the Julian calendar.
        let pl = planets(1000.0, "").unwrap();
        assert_eq!(pl.calendar, skyfix_core::calendar::Calendar::Julian);
        assert!(
            !pl.venus.is_empty() && !pl.mars.is_empty(),
            "{:?}",
            pl.errors
        );
        // Beyond the labelled tier nothing is computed, and the table says why.
        let far = planets(-2500.0, "").unwrap();
        assert!(!far.errors.is_empty());
        assert!(far.venus.is_empty() && far.mars.is_empty());
    }
}
