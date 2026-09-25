//! WASM exports for the explorer: the Moon in detail (libration and orientation, named
//! features on the terminator, perigee and apogee with supermoons, lunar occultations).
//!
//! OWNER: moondetail agent (expansion programme P8). Wire format: `docs/EXPLORER_API.md`,
//! "Moon in detail"; TypeScript mirror: `MoonDetailEngine` in
//! `web/src/next/engine/types.ts`. The engines are `skyfix_almanac::{libration,
//! lunar_features, apsides, occultations}`.
//!
//! Two layers, as in `explorer.rs`: [`native`] takes the same JSON strings and numbers as
//! the exports and returns serde types (tested natively), the exports serialise them with
//! `Serializer::json_compatible` (`None` is `null`).
//!
//! The one join with display-only data (CONVENTIONS 13.6 and 13.12): `occultations` adds
//! the Bright Star Catalogue's stars brighter than `max_magnitude` (from
//! `skyfix-starfield`) to the 58 navigational stars. An occultation is an event, not a
//! sight, so display positions are enough; `skyfix-almanac` itself never sees the star
//! field, only the catalogue places passed to it.

use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The native layer: JSON in, serde types out, `String` errors.
pub mod native {
    use std::collections::HashSet;

    use serde::Deserialize;
    use skyfix_almanac::apsides::{MoonApsides, moon_apsides as find_apsides};
    use skyfix_almanac::libration::{MoonOrientation, moon_orientation as orientation};
    use skyfix_almanac::lunar_features::{MoonFeatures, moon_features as features};
    use skyfix_almanac::occultations::{
        OccultationList, OccultationOptions, OccultationTarget, StarTarget,
        navigational_star_targets, occultations as find_occultations, planet_targets,
    };
    use skyfix_ephemeris::body::Sky;
    use skyfix_ephemeris::moon::MoonProvider;
    use skyfix_ephemeris::planets::PlanetProvider;
    use skyfix_ephemeris::sun::SunProvider;
    use skyfix_ephemeris::topocentric::Site;

    use crate::explorer::native::parse_observer;

    /// The faintest `max_magnitude` accepted: the Bright Star Catalogue's own limit.
    pub const FAINTEST_MAGNITUDE: f64 = 6.5;
    /// The default: the navigational stars plus every catalogue star brighter than this.
    pub const DEFAULT_MAX_MAGNITUDE: f64 = 3.5;

    /// The explorer's astronomy for this module: DUT1 = 0, as `explorer::native::sky`.
    fn providers() -> (MoonProvider, SunProvider, PlanetProvider) {
        (
            MoonProvider::new(),
            SunProvider::new(),
            PlanetProvider::new(),
        )
    }

    /// `observer_json`, or `null` (or empty) for the Earth's centre.
    pub fn parse_optional_observer(observer_json: &str) -> Result<Option<Site>, String> {
        let t = observer_json.trim();
        if t.is_empty() || t == "null" {
            return Ok(None);
        }
        parse_observer(t).map(Some)
    }

    pub fn moon_orientation(observer_json: &str, jd_utc: f64) -> Result<MoonOrientation, String> {
        let site = parse_optional_observer(observer_json)?;
        let (m, s, _) = providers();
        orientation(&m, &s, site.as_ref(), jd_utc).map_err(|e| e.to_string())
    }

    pub fn moon_features(observer_json: &str, jd_utc: f64) -> Result<MoonFeatures, String> {
        let site = parse_optional_observer(observer_json)?;
        let (m, s, _) = providers();
        features(&m, &s, site.as_ref(), jd_utc).map_err(|e| e.to_string())
    }

    pub fn moon_apsides(jd_start: f64, jd_end: f64) -> Result<MoonApsides, String> {
        let (m, _, _) = providers();
        find_apsides(&m, &Sky::new(), jd_start, jd_end).map_err(|e| e.to_string())
    }

    /// `options_json` of `occultations` (EXPLORER_API.md "Moon in detail").
    #[derive(Debug, Clone, Deserialize)]
    #[serde(default, deny_unknown_fields)]
    pub struct OccultationRequest {
        /// Catalogue stars brighter than this join the 58 navigational stars.
        pub max_magnitude: f64,
        pub stars: bool,
        pub planets: bool,
        pub include_below_horizon: bool,
        pub include_near_misses: bool,
        /// Only these bodies (names as the result spells them), when given.
        pub bodies: Option<Vec<String>>,
    }

    impl Default for OccultationRequest {
        fn default() -> Self {
            let o = OccultationOptions::default();
            OccultationRequest {
                max_magnitude: DEFAULT_MAX_MAGNITUDE,
                stars: true,
                planets: true,
                include_below_horizon: o.include_below_horizon,
                include_near_misses: o.include_near_misses,
                bodies: None,
            }
        }
    }

    pub fn parse_occultation_options(options_json: &str) -> Result<OccultationRequest, String> {
        let t = options_json.trim();
        let r = if t.is_empty() || t == "null" {
            OccultationRequest::default()
        } else {
            serde_json::from_str::<OccultationRequest>(t).map_err(|e| format!("options: {e}"))?
        };
        if !r.max_magnitude.is_finite() || !(-2.0..=FAINTEST_MAGNITUDE).contains(&r.max_magnitude) {
            return Err(format!(
                "options: max_magnitude {} is outside -2 .. {FAINTEST_MAGNITUDE}",
                r.max_magnitude
            ));
        }
        Ok(r)
    }

    /// The Bright Star Catalogue's stars brighter than `max_magnitude` that are not among
    /// the 58 navigational stars, as occultation targets (display data, CONVENTIONS 13.6).
    pub fn catalogue_star_targets(max_magnitude: f64) -> Result<Vec<OccultationTarget>, String> {
        let sf = skyfix_starfield::starfield().map_err(|e| e.to_string())?;
        let nav: HashSet<usize> = sf.navigational.iter().map(|m| m.index).collect();
        let c = &sf.catalog;
        let mut out = Vec::new();
        for i in 0..c.len() {
            if f64::from(c.vmag[i]) >= max_magnitude || nav.contains(&i) {
                continue;
            }
            let designation = (!c.designations[i].is_empty()).then(|| c.designations[i].clone());
            let name = c
                .name_of(i)
                .map(str::to_string)
                .or_else(|| designation.clone())
                .unwrap_or_else(|| format!("HR {}", c.hr[i]));
            out.push(OccultationTarget::Star(StarTarget {
                name,
                designation,
                hr: u32::try_from(c.hr[i]).ok(),
                magnitude: f64::from(c.vmag[i]),
                ra_j2000_deg: c.ra_j2000_deg[i],
                dec_j2000_deg: c.dec_j2000_deg[i],
                pm_ra_cosdec_mas_yr: c.pm_ra_cosdec_mas_yr[i],
                pm_dec_mas_yr: c.pm_dec_mas_yr[i],
                parallax_mas: c.parallax_mas[i],
                navigational: false,
            }));
        }
        Ok(out)
    }

    /// The bodies a request searches.
    pub fn targets(r: &OccultationRequest) -> Result<Vec<OccultationTarget>, String> {
        let mut t = Vec::new();
        if r.stars {
            t.extend(navigational_star_targets());
            t.extend(catalogue_star_targets(r.max_magnitude)?);
        }
        if r.planets {
            t.extend(planet_targets());
        }
        if let Some(names) = &r.bodies {
            let want: Vec<String> = names.iter().map(|n| n.trim().to_lowercase()).collect();
            for (n, w) in names.iter().zip(&want) {
                if !t.iter().any(|x| x.name().to_lowercase() == *w) {
                    return Err(format!(
                        "options: bodies: {n:?} is not a body this search knows"
                    ));
                }
            }
            t.retain(|x| want.contains(&x.name().to_lowercase()));
        }
        Ok(t)
    }

    pub fn occultations(
        observer_json: &str,
        jd_start: f64,
        jd_end: f64,
        options_json: &str,
    ) -> Result<OccultationList, String> {
        let site = parse_observer(observer_json)?;
        let r = parse_occultation_options(options_json)?;
        let t = targets(&r)?;
        let (m, s, p) = providers();
        let options = OccultationOptions {
            include_below_horizon: r.include_below_horizon,
            include_near_misses: r.include_near_misses,
        };
        find_occultations(&m, &s, &p, &site, jd_start, jd_end, &t, &options)
            .map_err(|e| e.to_string())
    }
}

/// How the Moon is turned and lit at `jd_utc` for an observer, or for the Earth's centre
/// when `observer_json` is `null`: `MoonOrientation`.
#[wasm_bindgen]
pub fn moon_orientation(observer_json: &str, jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::moon_orientation(observer_json, jd_utc).map_err(err)?)
}

/// The 150 named features at `jd_utc`: lit or not, near the terminator, on the disc:
/// `MoonFeatures`.
#[wasm_bindgen]
pub fn moon_features(observer_json: &str, jd_utc: f64) -> Result<JsValue, JsValue> {
    to_js(&native::moon_features(observer_json, jd_utc).map_err(err)?)
}

/// Perigees, apogees, new and full Moons with supermoon and micromoon flags in the window
/// (clipped to the coverage): `MoonApsides`.
#[wasm_bindgen]
pub fn moon_apsides(jd_start: f64, jd_end: f64) -> Result<JsValue, JsValue> {
    to_js(&native::moon_apsides(jd_start, jd_end).map_err(err)?)
}

/// Lunar occultations of bright stars and planets for an observer, at most 400 days:
/// `OccultationList`.
#[wasm_bindgen]
pub fn occultations(
    observer_json: &str,
    jd_start: f64,
    jd_end: f64,
    options_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(&native::occultations(observer_json, jd_start, jd_end, options_json).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use skyfix_core::time::civil_to_jd;

    use super::native::*;

    const PHILADELPHIA: &str = r#"{"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 10}"#;

    fn keys(v: &serde_json::Value, want: &[&str]) {
        for k in want {
            assert!(v.get(*k).is_some(), "missing {k} in {v}");
        }
    }

    #[test]
    fn orientation_has_the_documented_shape_with_and_without_an_observer() {
        let jd = civil_to_jd(2026, 9, 25) + 0.1;
        for obs in [PHILADELPHIA, "null", ""] {
            let o = moon_orientation(obs, jd).unwrap();
            let v = serde_json::to_value(&o).unwrap();
            keys(
                &v,
                &[
                    "jd_utc",
                    "utc",
                    "topocentric",
                    "libration",
                    "sub_observer",
                    "sub_earth",
                    "sub_solar",
                    "colongitude_deg",
                    "axis_position_angle_deg",
                    "geocentric_axis_position_angle_deg",
                    "bright_limb_angle_deg",
                    "illuminated_fraction",
                    "phase_angle_deg",
                    "waxing",
                    "terminator",
                    "distance_km",
                    "semidiameter_arcmin",
                    "apparent_diameter_arcmin",
                    "diameter_vs_mean_percent",
                    "geocentric_distance_km",
                    "geocentric_semidiameter_arcmin",
                    "alt_deg",
                    "az_deg",
                    "parallactic_angle_deg",
                    "north_pole_disc",
                    "sub_solar_disc",
                ],
            );
            keys(
                &v["libration"],
                &[
                    "lon_deg",
                    "lat_deg",
                    "optical_lon_deg",
                    "optical_lat_deg",
                    "physical_lon_deg",
                    "physical_lat_deg",
                    "diurnal_lon_deg",
                    "diurnal_lat_deg",
                ],
            );
            keys(
                &v["terminator"],
                &[
                    "pole",
                    "morning_lon_deg",
                    "evening_lon_deg",
                    "points",
                    "disc",
                ],
            );
            keys(
                &v["north_pole_disc"],
                &["east", "north", "x", "y", "visible"],
            );
            assert_eq!(v["terminator"]["points"].as_array().unwrap().len(), 72);
            let topo = obs == PHILADELPHIA;
            assert_eq!(v["topocentric"], topo);
            assert_eq!(v["alt_deg"].is_null(), !topo);
        }
        assert!(moon_orientation(r#"{"lat_deg": 95, "lon_deg": 0}"#, 2_461_000.0).is_err());
        assert!(moon_orientation("null", f64::NAN).is_err());
    }

    #[test]
    fn features_list_every_feature_with_its_state() {
        let r = moon_features(PHILADELPHIA, civil_to_jd(2026, 1, 26) + 0.2).unwrap();
        let v = serde_json::to_value(&r).unwrap();
        keys(
            &v,
            &[
                "tonight",
                "features",
                "colongitude_deg",
                "terminator_band_deg",
                "source",
            ],
        );
        let f = &v["features"][0];
        keys(
            f,
            &[
                "name",
                "kind",
                "lat_deg",
                "lon_deg",
                "diameter_km",
                "rank",
                "description",
                "sun_altitude_deg",
                "lit",
                "morning",
                "near_terminator",
                "visible",
                "angle_from_disc_centre_deg",
                "disc",
            ],
        );
        assert_eq!(v["features"].as_array().unwrap().len(), 150);
        assert!(!r.tonight.is_empty());
    }

    #[test]
    fn apsides_have_the_documented_shape() {
        let r = moon_apsides(civil_to_jd(2026, 1, 1), civil_to_jd(2026, 3, 1)).unwrap();
        let v = serde_json::to_value(&r).unwrap();
        keys(
            &v,
            &[
                "jd_start",
                "jd_end",
                "truncated",
                "coverage_start_utc",
                "coverage_end_utc",
                "apsides",
                "syzygies",
                "definitions",
            ],
        );
        keys(
            &v["apsides"][0],
            &[
                "kind",
                "jd_utc",
                "utc",
                "distance_km",
                "semidiameter_arcmin",
                "diameter_arcmin",
                "diameter_vs_mean_percent",
            ],
        );
        keys(
            &v["syzygies"][0],
            &[
                "kind",
                "distance_km",
                "perigee",
                "apogee",
                "hours_from_perigee",
                "perigee_fraction",
                "supermoon",
                "micromoon",
                "largest_of_year",
                "smallest_of_year",
            ],
        );
        assert!(moon_apsides(2_461_000.0, 2_460_000.0).is_err());
    }

    #[test]
    fn occultation_options_default_and_refuse_nonsense() {
        let d = parse_occultation_options("").unwrap();
        assert_eq!(d.max_magnitude, DEFAULT_MAX_MAGNITUDE);
        assert!(d.stars && d.planets && !d.include_below_horizon && d.include_near_misses);
        assert!(parse_occultation_options(r#"{"max_magnitude": 9}"#).is_err());
        assert!(parse_occultation_options(r#"{"colour": "red"}"#).is_err());
        let r = parse_occultation_options(r#"{"bodies": ["regulus", "Mars"]}"#).unwrap();
        let t = targets(&r).unwrap();
        assert_eq!(t.len(), 2);
        let r = parse_occultation_options(r#"{"bodies": ["Vulcan"]}"#).unwrap();
        assert!(targets(&r).is_err());
    }

    #[test]
    fn the_catalogue_adds_bright_ecliptic_stars_but_not_the_navigational_ones() {
        let t = catalogue_star_targets(3.5).unwrap();
        let names: Vec<&str> = t.iter().map(|x| x.name()).collect();
        // Alcyone (eta Tauri, V 2.87) is in; Regulus (a navigational star) is not.
        assert!(names.contains(&"Alcyone"), "{names:?}");
        assert!(!names.contains(&"Regulus"));
        assert!(t.len() > 100 && t.len() < 400, "{}", t.len());
    }

    #[test]
    fn occultations_have_the_documented_shape() {
        // Mars, 2025-01-14, seen from Philadelphia.
        let a = civil_to_jd(2025, 1, 13);
        let r = occultations(PHILADELPHIA, a, a + 2.0, r#"{"bodies": ["Mars"]}"#).unwrap();
        assert_eq!(r.events.len(), 1, "{r:?}");
        let v = serde_json::to_value(&r).unwrap();
        keys(
            &v,
            &[
                "jd_start",
                "jd_end",
                "truncated",
                "coverage_start_utc",
                "coverage_end_utc",
                "limb_note",
                "bodies_searched",
                "events",
                "errors",
            ],
        );
        let e = &v["events"][0];
        keys(
            e,
            &[
                "body",
                "kind",
                "designation",
                "hr",
                "magnitude",
                "navigational",
                "occulted",
                "graze",
                "disappearance",
                "reappearance",
                "closest",
                "duration_s",
                "body_semidiameter_arcsec",
                "moon_illuminated_fraction",
                "waxing",
                "visible",
            ],
        );
        keys(
            &e["disappearance"],
            &[
                "kind",
                "jd_utc",
                "utc",
                "position_angle_deg",
                "vertex_angle_deg",
                "cusp_angle_deg",
                "cusp",
                "limb",
                "moon_alt_deg",
                "moon_az_deg",
                "moon_above_horizon",
                "sun_alt_deg",
                "sky_phase",
                "crossing_s",
            ],
        );
        assert_eq!(e["kind"], "planet");
        assert_eq!(e["disappearance"]["limb"], "bright");
        assert!(e["disappearance"]["crossing_s"].as_f64().unwrap() > 5.0);
    }
}
