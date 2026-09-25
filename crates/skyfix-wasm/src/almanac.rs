//! WASM exports for the explorer: almanac.
//!
//! OWNER: almanac agent (wave 2). Wire format: docs/EXPLORER_API.md, "Wave 2 — almanac
//! pages"; definitions: CONVENTIONS 13.9 and `skyfix_almanac::pages`.
//!
//! Same two layers as `explorer.rs`: [`native`] takes the export's arguments and returns
//! the serde type (tested natively), and the `#[wasm_bindgen]` export serialises it with
//! `Serializer::json_compatible` (`None` is `null`). The astronomy is
//! [`skyfix_ephemeris::body::Sky`] with DUT1 = 0, and here that is not an assumption:
//! the page's argument is UT1, as in the printed Nautical Almanac, which a navigator
//! enters with UTC + DUT1 (CONVENTIONS 15.2). A provider with DUT1 = 0 makes the clock
//! instant of each row its UT1; TT is then off by DUT1 (under 0.9 s: 0.5" of the Moon,
//! a tenth of the printed precision). The explorer's `set_dut1` value and the IERS
//! history therefore do not apply to the page; they apply to `sky_state` and the rest.

use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: plain arguments in, serde types out, `String` errors.
pub mod native {
    use skyfix_almanac::pages::{self, AlmanacDay};
    use skyfix_ephemeris::body::Sky;

    /// The daily page for one UT date, `YYYY-MM-DD`. Errors: a malformed date, a date
    /// outside the ephemeris coverage (1990-01-01 to 2060-12-31), or no Sun. DUT1 = 0 on
    /// purpose: the argument is UT1 (module docs).
    pub fn almanac_day(date: &str) -> Result<AlmanacDay, String> {
        pages::almanac_day(&Sky::new(), date).map_err(|e| e.to_string())
    }
}

/// Everything the two facing daily pages of the Nautical Almanac give for one UT date
/// `YYYY-MM-DD` (`AlmanacDay`). Throws for a malformed date or one outside the coverage.
#[wasm_bindgen]
pub fn almanac_day(date: &str) -> Result<JsValue, JsValue> {
    to_js(&native::almanac_day(date).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::native::*;

    fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).unwrap()
    }

    #[test]
    fn a_page_has_the_documented_shape() {
        let v = json(&almanac_day("2026-09-24").unwrap());
        for k in [
            "date",
            "weekday",
            "jd_utc",
            "noon_jd_utc",
            "hours",
            "aries",
            "sun",
            "moon",
            "planets",
            "stars",
            "rise_set",
            "notes",
            "errors",
        ] {
            assert!(v.get(k).is_some(), "AlmanacDay missing {k}");
        }
        assert_eq!(v["date"], "2026-09-24");
        assert_eq!(v["weekday"], "Thursday");
        assert_eq!(v["hours"].as_array().unwrap().len(), 24);
        let h = &v["hours"][0];
        for k in ["hour", "jd_utc", "utc", "aries", "sun", "moon", "planets"] {
            assert!(h.get(k).is_some(), "HourRow missing {k}");
        }
        assert_eq!(h["utc"], "2026-09-24T00:00:00.000Z");
        assert!(h["aries"]["printed"]["gha"].is_string());
        for k in ["gha", "v", "dec", "d", "hp"] {
            assert!(h["moon"]["printed"][k].is_string(), "moon printed {k}");
        }
        for k in ["gha_deg", "dec_deg", "v_arcmin", "d_arcmin", "hp_arcmin"] {
            assert!(h["moon"][k].is_number(), "moon {k}");
        }
        let planets: Vec<&str> = v["planets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["body"].as_str().unwrap())
            .collect();
        assert_eq!(planets, ["Venus", "Mars", "Jupiter", "Saturn"]);
        assert_eq!(h["planets"][2]["body"], "Jupiter");
        for k in ["magnitude", "v", "d", "sha"] {
            assert!(
                v["planets"][0]["printed"][k].is_string(),
                "planet printed {k}"
            );
        }
        let t = &v["sun"]["mer_pass"];
        for k in ["kind", "jd_utc", "utc", "hours", "printed"] {
            assert!(t.get(k).is_some(), "TableTime missing {k}");
        }
        assert_eq!(t["kind"], "time");
        assert_eq!(v["stars"].as_array().unwrap().len(), 58);
        assert_eq!(v["stars"][57]["body"], "Polaris");
        let rs = &v["rise_set"];
        assert_eq!(
            rs["moon_dates"],
            serde_json::json!(["2026-09-24", "2026-09-25"])
        );
        assert_eq!(rs["rows"].as_array().unwrap().len(), 31);
        assert_eq!(rs["rows"][0]["label"], "N 72");
        assert_eq!(rs["rows"][0]["moonrise"].as_array().unwrap().len(), 2);
        assert!(v["moon"]["phase"].is_null());
        assert!(v["errors"].as_array().unwrap().is_empty());
        assert_eq!(v["notes"].as_array().unwrap().len(), 7);
    }

    #[test]
    fn bad_dates_are_refused_with_the_reason() {
        let e = almanac_day("24/09/2026").unwrap_err();
        assert!(e.contains("YYYY-MM-DD"), "{e}");
        // Outside the validated tier (1550-01-01 to 2650-01-22, deeptime agent).
        let e = almanac_day("1549-12-31").unwrap_err();
        assert!(e.contains("coverage"), "{e}");
        let e = almanac_day("2650-01-23").unwrap_err();
        assert!(e.contains("coverage"), "{e}");
        assert!(almanac_day("2026-02-29").is_err());
    }

    /// The first and last dates of the coverage still make a page; what needs instants
    /// outside it is `n/a`, and the page says why.
    #[test]
    fn the_coverage_edges_make_pages_with_honest_gaps() {
        // deeptime agent: the validated tier, 1550-01-01T00:00Z to 2650-01-22T00:00Z;
        // 2650-01-21 is the last date with all its hours.
        let first = almanac_day("1550-01-01").unwrap();
        assert!(first.moon.as_ref().unwrap().age_days.is_none());
        assert_eq!(first.moon.as_ref().unwrap().printed.age, "--");
        assert!(!first.errors.is_empty());
        let last = almanac_day("2650-01-21").unwrap();
        assert_eq!(last.hours.len(), 24);
        for row in &last.rise_set.rows {
            assert_eq!(row.moonrise[1].printed, "n/a", "{}", row.label);
        }
        assert!(last.errors.iter().any(|e| e.message.contains("n/a")));
        // The last hour's v and d are still computed (up to the coverage end).
        let m = last.hours[23].moon.as_ref().unwrap();
        assert!(m.v_arcmin > 0.0 && m.v_arcmin < 20.0, "{}", m.v_arcmin);
    }
}
