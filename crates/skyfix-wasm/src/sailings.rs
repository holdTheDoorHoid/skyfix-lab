//! WASM exports for passage planning and sight extras: the sailings, dead reckoning,
//! routes, star identification and the star finder.
//!
//! OWNER: sailings agent (expansion programme). Wire format: docs/EXPLORER_API.md,
//! "Expansion programme — sailings, dead reckoning, star identification, star finder";
//! TypeScript mirror: `SailingsEngine` in `web/src/next/engine/types.ts`; the methods:
//! docs/NAVIGATION_METHODS.md sections 9-11.
//!
//! Each export is a thin wrapper over a plain Rust function of the same name with an
//! `_impl` suffix, which the native tests call. Malformed input throws a string.
//!
//! Star identification asks `skyfix_ephemeris::body::Sky` for the candidates — the
//! catalogue stars, the naked-eye planets Mercury to Saturn and the Moon — the same
//! positions the explorer shows (the planets at their geometric centres, which differs
//! from a sight's centre of light by under 0.1′, nothing to an identification).

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use skyfix_core::methods::starfinder::{self, AriesTick, Side, Template};
use skyfix_core::methods::starid::{
    CandidateKind, StarIdCandidate, StarIdRequest, StarIdResult, StarIdSource,
    star_identify as identify,
};
use skyfix_core::sailings::{
    DrReport, DrRequest, PassageReport, PassageRequest, RouteReport, RouteRequest,
};
use skyfix_core::types::GeocentricDirection;
use skyfix_ephemeris::body::{BodyEphemeris, MOON, SUN, Sky};

use crate::{err, to_js};

fn parse<T: for<'de> Deserialize<'de>>(json: &str, what: &str) -> Result<T, String> {
    serde_json::from_str(json.trim()).map_err(|e| format!("{what}: {e}"))
}

// ---------------------------------------------------------------------------
// sailing, dr_advance, route_positions
// ---------------------------------------------------------------------------

pub fn sailing_impl(request_json: &str) -> Result<PassageReport, String> {
    let req: PassageRequest = parse(request_json, "sailing")?;
    skyfix_core::sailings::passage(&req).map_err(|e| e.to_string())
}

/// Every sailing between two points: `PassageReport` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn sailing(request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&sailing_impl(request_json).map_err(err)?)
}

pub fn dr_advance_impl(request_json: &str) -> Result<DrReport, String> {
    let req: DrRequest = parse(request_json, "dr_advance")?;
    skyfix_core::sailings::dead_reckoning(&req).map_err(|e| e.to_string())
}

/// One leg of dead reckoning: `DrReport` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn dr_advance(request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&dr_advance_impl(request_json).map_err(err)?)
}

pub fn route_positions_impl(request_json: &str) -> Result<RouteReport, String> {
    let req: RouteRequest = parse(request_json, "route_positions")?;
    skyfix_core::sailings::route_positions(&req).map_err(|e| e.to_string())
}

/// Positions along a route of legs: `RouteReport` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn route_positions(request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&route_positions_impl(request_json).map_err(err)?)
}

// ---------------------------------------------------------------------------
// star_identify
// ---------------------------------------------------------------------------

/// The naked-eye planets an identification considers (Uranus and Neptune never reach
/// magnitude 5.5 and are left out).
pub const IDENTIFY_PLANETS: [&str; 5] = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"];

/// The candidates of star identification, from the explorer's sky.
pub struct SkyStarIdSource {
    sky: Sky,
}

impl SkyStarIdSource {
    pub fn new() -> Self {
        SkyStarIdSource { sky: Sky::new() }
    }
}

impl Default for SkyStarIdSource {
    fn default() -> Self {
        Self::new()
    }
}

impl StarIdSource for SkyStarIdSource {
    fn name(&self) -> &str {
        Sky::NAME
    }

    fn candidates(&self, jd_utc: f64) -> Result<Vec<StarIdCandidate>, String> {
        let mut out = Vec::with_capacity(64);
        let mut add = |name: &str, kind: CandidateKind, navigational: bool| -> Result<(), String> {
            let st = self
                .sky
                .apparent_state(name, jd_utc)
                .map_err(|e| e.to_string())?;
            out.push(StarIdCandidate {
                body: st.body.clone(),
                kind,
                direction: st.direction(),
                magnitude: st.magnitude,
                navigational,
            });
            Ok(())
        };
        for name in skyfix_ephemeris::catalog::names() {
            add(name, CandidateKind::Star, true)?;
        }
        for name in IDENTIFY_PLANETS {
            add(
                name,
                CandidateKind::Planet,
                skyfix_ephemeris::body::is_navigational(name),
            )?;
        }
        add(MOON, CandidateKind::Moon, true)?;
        Ok(out)
    }

    fn sun(&self, jd_utc: f64) -> Result<GeocentricDirection, String> {
        self.sky
            .apparent_state(SUN, jd_utc)
            .map(|s| s.direction())
            .map_err(|e| e.to_string())
    }
}

pub fn star_identify_impl(request_json: &str) -> Result<StarIdResult, String> {
    let req: StarIdRequest = parse(request_json, "star_identify")?;
    identify(&req, &SkyStarIdSource::new()).map_err(|e| e.to_string())
}

/// Which body was shot, from its altitude and bearing: `StarIdResult` (EXPLORER_API.md).
#[wasm_bindgen]
pub fn star_identify(request_json: &str) -> Result<JsValue, JsValue> {
    to_js(&star_identify_impl(request_json).map_err(err)?)
}

// ---------------------------------------------------------------------------
// star_finder_geometry
// ---------------------------------------------------------------------------

/// One star on the base plate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StarFinderStar {
    pub name: String,
    pub sha_deg: f64,
    pub dec_deg: f64,
    pub magnitude: f64,
    /// On the north side and on the south side of the base.
    pub north: [f64; 2],
    pub south: [f64; 2],
}

/// Everything a star finder needs drawn (docs/NAVIGATION_METHODS.md section 11).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StarFinderGeometry {
    pub requested_latitude_deg: f64,
    /// The template used: the 10-degree band's centre, 5 to 85, signed.
    pub template_latitude_deg: f64,
    pub side: Side,
    /// Turn the template anticlockwise by `rotation_sign * LHA Aries` degrees (north +1,
    /// south -1) to set its arrow on the Aries index.
    pub rotation_sign: f64,
    /// The celestial equator's radius on the base (the rim is the opposite pole).
    pub equator_radius: f64,
    /// The star places plotted: `"J2000.0 catalogue place"` or the apparent place's date.
    pub epoch: String,
    pub stars: Vec<StarFinderStar>,
    pub aries_index: Vec<AriesTick>,
    pub template: Template,
    pub notes: Vec<String>,
}

pub fn star_finder_geometry_impl(
    lat_band: f64,
    jd_utc: Option<f64>,
) -> Result<StarFinderGeometry, String> {
    if !lat_band.is_finite() || lat_band.abs() > 90.0 {
        return Err(format!(
            "lat_band must be a latitude in degrees (got {lat_band})"
        ));
    }
    let lat = starfinder::template_latitude(lat_band);
    let side = starfinder::side_of(lat);
    let stars_provider = skyfix_ephemeris::stars::StarProvider::new();
    let mut stars = Vec::with_capacity(58);
    for s in skyfix_ephemeris::catalog::navigational_stars() {
        let (ra, dec) = match jd_utc {
            Some(jd) => stars_provider
                .apparent_radec_deg(&s.name, jd)
                .map_err(|e| e.to_string())?,
            None => (s.ra_j2000_deg, s.dec_j2000_deg),
        };
        stars.push(StarFinderStar {
            name: s.name.clone(),
            sha_deg: skyfix_core::units::norm_360(360.0 - ra),
            dec_deg: dec,
            magnitude: s.magnitude,
            north: starfinder::base_xy(Side::North, ra, dec),
            south: starfinder::base_xy(Side::South, ra, dec),
        });
    }
    Ok(StarFinderGeometry {
        requested_latitude_deg: lat_band,
        template_latitude_deg: lat,
        side,
        rotation_sign: starfinder::template_rotation_deg(side, 1.0),
        equator_radius: 0.5,
        epoch: match jd_utc {
            Some(jd) => format!("apparent place of {}", skyfix_core::time::format_utc(jd)),
            None => "J2000.0 catalogue place".to_string(),
        },
        stars,
        aries_index: starfinder::aries_index(),
        template: starfinder::template(lat).map_err(|e| e.to_string())?,
        notes: vec![
            "Azimuthal equidistant projection centred on the celestial pole of the observer's \
             hemisphere, the opposite pole at the rim, seen from outside the sphere; like the \
             printed star finder the grid has no refraction and no dip."
                .to_string(),
            format!(
                "The template for {:.0}° {} serves latitudes {:.0}° to {:.0}°; within the band \
                 altitudes and azimuths are good to a few degrees.",
                lat.abs(),
                if lat >= 0.0 { "N" } else { "S" },
                lat.abs() - 5.0,
                lat.abs() + 5.0
            ),
        ],
    })
}

/// Star-finder geometry for a latitude: `StarFinderGeometry` (EXPLORER_API.md). `jd_utc`
/// (optional) plots the stars' apparent places of that date instead of J2000.0.
#[wasm_bindgen]
pub fn star_finder_geometry(lat_band: f64, jd_utc: Option<f64>) -> Result<JsValue, JsValue> {
    to_js(&star_finder_geometry_impl(lat_band, jd_utc).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::methods::starid::limiting_magnitude;
    use skyfix_core::sights::predict::predict_sextant;
    use skyfix_core::types::{HorizonMode, Instrument, Limb, SightObserver};
    use skyfix_ephemeris::AstroProvider;

    /// A small deterministic generator (xorshift64*): no `rand` in this workspace.
    struct Rng(u64);
    impl Rng {
        fn f(&mut self) -> f64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
        }
        /// Approximately standard normal (sum of twelve uniforms).
        fn normal(&mut self) -> f64 {
            (0..12).map(|_| self.f()).sum::<f64>() - 6.0
        }
    }

    fn jd(s: &str) -> f64 {
        skyfix_core::time::parse_utc(s).unwrap()
    }

    /// The predicted sextant reading and bearing of `star` somewhere and sometime it is
    /// between 10 and 80 degrees high, and the observer and instrument used.
    fn a_sight_of(star: &str, rng: &mut Rng) -> (f64, SightObserver, Instrument, f64, f64) {
        let provider = crate::auto_provider();
        let instrument = Instrument {
            index_correction_arcmin: -1.2,
            horizon: HorizonMode::Sea,
            ..Instrument::default()
        };
        loop {
            let t = jd("2026-01-01T00:00:00Z") + rng.f() * 4.0 * 365.25;
            let observer = SightObserver {
                lat_deg: rng.f() * 130.0 - 65.0,
                lon_deg: rng.f() * 360.0 - 180.0,
                height_of_eye_m: 3.0,
                pressure_hpa: 1010.0,
                temperature_c: 10.0,
            };
            let d = provider.geocentric(star, t).unwrap();
            let Ok(p) = predict_sextant(&observer, &instrument, star, Limb::Center, t, d, "auto")
            else {
                continue;
            };
            if (10.0..80.0).contains(&p.hc_deg) {
                return (t, observer, instrument, p.hs_deg, p.zn_deg);
            }
        }
    }

    fn request(t: f64, o: &SightObserver, i: &Instrument, hs: f64, zn: f64) -> String {
        serde_json::json!({
            "utc": skyfix_core::time::format_utc(t),
            "observer": o,
            "instrument": i,
            "altitude_deg": hs,
            "altitude_kind": "sextant_hs",
            "bearing_deg": zn,
        })
        .to_string()
    }

    #[test]
    fn every_navigational_star_is_recovered_from_its_own_predicted_hs_and_zn() {
        let mut rng = Rng(0x57a2_1d00_0000_0058);
        let names = skyfix_ephemeris::catalog::names();
        assert_eq!(names.len(), 58);
        let mut worst: f64 = 0.0;
        for name in &names {
            for _ in 0..5 {
                let (t, o, i, hs, zn) = a_sight_of(name, &mut rng);
                let r = star_identify_impl(&request(t, &o, &i, hs, zn)).unwrap();
                assert_eq!(r.best.as_deref(), Some(*name), "{}: {}", name, r.message);
                assert_eq!(r.candidates[0].rank, 1);
                worst = worst.max(r.candidates[0].separation_deg);
            }
        }
        println!(
            "58 stars x 5 random places and times: all first, worst separation {worst:.2e} deg"
        );
        // The chain inverts exactly; what is left is the sphere vs the explorer's star
        // places. ACCURACY.md claims under 0.00001 deg (verify2: this asserted 0.01, a
        // thousand times the claim).
        assert!(worst < 1e-5, "{worst}");
    }

    #[test]
    fn with_realistic_errors_the_true_star_is_always_a_match() {
        // A sextant altitude to 1' (1 sigma), a hand-bearing compass to 1.5 deg, and a DR
        // 10 NM out: the true star must be within the default tolerances every time, and
        // is ranked first nearly always (reported).
        let mut rng = Rng(0x0e44_0e44_0e44_0001);
        let names = skyfix_ephemeris::catalog::names();
        let (mut n, mut first, mut matched) = (0, 0, 0);
        for k in 0..400 {
            let name = names[k % names.len()];
            let (t, mut o, i, hs, zn) = a_sight_of(name, &mut rng);
            o.lat_deg += rng.normal() * 10.0 / 60.0 / std::f64::consts::SQRT_2;
            o.lon_deg += rng.normal() * 10.0
                / 60.0
                / std::f64::consts::SQRT_2
                / o.lat_deg.to_radians().cos();
            let hs = hs + rng.normal() / 60.0;
            let zn = zn + rng.normal() * 1.5;
            let r = star_identify_impl(&request(t, &o, &i, hs, zn)).unwrap();
            n += 1;
            if r.candidates
                .iter()
                .any(|m| m.body == name && m.within_tolerance)
            {
                matched += 1;
            }
            if r.best.as_deref() == Some(name) {
                first += 1;
            }
        }
        println!(
            "{n} noisy sights: the true star within tolerance {matched}, ranked first {first} ({:.1} %)",
            100.0 * first as f64 / n as f64
        );
        assert_eq!(matched, n);
        // ACCURACY.md: first in all 400 (verify2: this asserted 90 %).
        assert_eq!(first, n);
    }

    #[test]
    fn the_moon_and_planets_are_candidates_too() {
        let t = jd("2026-10-01T03:00:00Z");
        let src = SkyStarIdSource::new();
        let c = src.candidates(t).unwrap();
        assert_eq!(c.len(), 58 + 5 + 1);
        assert!(
            c.iter()
                .any(|x| x.body == "Moon" && x.direction.horizontal_parallax_arcmin > 50.0)
        );
        assert!(c.iter().any(|x| x.body == "Mercury" && !x.navigational));
        // The Moon from its own predicted lower-limb reading.
        let provider = crate::auto_provider();
        let o = SightObserver {
            lat_deg: 39.95,
            lon_deg: -75.17,
            height_of_eye_m: 2.5,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        };
        let d = provider.geocentric("Moon", t).unwrap();
        let p = predict_sextant(
            &o,
            &Instrument::default(),
            "Moon",
            Limb::Lower,
            t,
            d,
            "auto",
        )
        .unwrap();
        if p.hc_deg > 5.0 {
            let r = star_identify_impl(&request(t, &o, &Instrument::default(), p.hs_deg, p.zn_deg))
                .unwrap();
            assert_eq!(r.best.as_deref(), Some("Moon"), "{}", r.message);
        }
    }

    #[test]
    fn the_brightness_rule_is_the_planners_in_nautical_twilight() {
        for k in 0..=60 {
            let h = -6.0 - k as f64 * 0.1;
            let ours = limiting_magnitude(h);
            let planner = skyfix_ephemeris::visibility::twilight_limiting_magnitude(h);
            assert!((ours - planner).abs() < 1e-12, "{h}: {ours} vs {planner}");
        }
    }

    #[test]
    fn a_great_circle_route_is_the_running_fixs_track() {
        // skyfix-motion's Track::advance is the running fix's DR; a route with
        // method great_circle must put the vessel in the same place.
        use skyfix_motion::track::{Leg, Track};
        let start = "2026-10-01T00:00:00Z";
        let doc = serde_json::json!({
            "start": {"lat_deg": 40.0, "lon_deg": -70.0},
            "start_utc": start,
            "legs": [
                {"course_deg": 45.0, "speed_kn": 10.0},
                {"start_utc": "2026-10-01T02:00:00Z", "course_deg": 120.0, "speed_kn": 8.0},
                {"start_utc": "2026-10-01T05:30:00Z", "course_deg": 300.0, "speed_kn": 14.0}
            ],
            "method": "great_circle",
            "times_utc": ["2026-10-01T01:00:00Z", "2026-10-01T04:00:00Z", "2026-10-01T09:00:00Z"]
        });
        let r = route_positions_impl(&doc.to_string()).unwrap();
        let track = Track::new(vec![
            Leg::new(jd(start), 45.0, 10.0),
            Leg::new(jd("2026-10-01T02:00:00Z"), 120.0, 8.0),
            Leg::new(jd("2026-10-01T05:30:00Z"), 300.0, 14.0),
        ]);
        let p0 = skyfix_core::geometry::Point::from_deg(40.0, -70.0);
        for p in &r.points {
            let q = track.advance(p0, jd(start), p.jd_utc);
            let d = skyfix_core::geometry::angular_distance(
                q,
                skyfix_core::geometry::Point::from_deg(p.lat_deg, p.lon_deg),
            );
            assert!(
                skyfix_core::units::rad_to_m(d) < 1e-3,
                "{}: {} m",
                p.utc,
                skyfix_core::units::rad_to_m(d)
            );
        }
    }

    #[test]
    fn the_star_finder_places_stars_where_the_template_reads_them() {
        let t = jd("2026-10-01T02:00:00Z");
        let g = star_finder_geometry_impl(39.95, Some(t)).unwrap();
        assert_eq!(g.template_latitude_deg, 35.0);
        assert_eq!(g.side, Side::North);
        assert_eq!(g.stars.len(), 58);
        assert_eq!(g.aries_index.len(), 360);
        // At 35 N and this time, each star above the horizon lies on the rotated grid at
        // its computed altitude and azimuth (to the grid's own geometry, exactly).
        let stars = skyfix_ephemeris::stars::StarProvider::new();
        let lha_aries = skyfix_core::units::norm_360(stars.gha_aries_deg(t) + (-75.0));
        for s in &g.stars {
            let (h, z) = skyfix_core::geometry::altitude_azimuth(
                skyfix_core::geometry::Point::from_deg(35.0, -75.0),
                skyfix_core::units::norm_360(stars.gha_aries_deg(t) + s.sha_deg).to_radians(),
                s.dec_deg.to_radians(),
            );
            if h <= 0.0 {
                continue;
            }
            let p = starfinder::rotate(
                starfinder::template_xy(35.0, h.to_degrees(), z.to_degrees()),
                starfinder::template_rotation_deg(Side::North, lha_aries),
            );
            assert!(
                (p[0] - s.north[0]).hypot(p[1] - s.north[1]) < 1e-9,
                "{}",
                s.name
            );
        }
        let south = star_finder_geometry_impl(-33.9, None).unwrap();
        assert_eq!(south.template_latitude_deg, -35.0);
        assert_eq!(south.rotation_sign, -1.0);
        assert_eq!(south.epoch, "J2000.0 catalogue place");
        assert!(star_finder_geometry_impl(f64::NAN, None).is_err());
        // The whole payload is small enough to fetch at once.
        let json = serde_json::to_string(&g).unwrap();
        assert!(json.len() < 150_000, "{}", json.len());
    }

    #[test]
    fn the_request_documents_parse_and_bad_ones_say_why() {
        let p = sailing_impl(
            r#"{"from": {"lat_deg": 40, "lon_deg": -70}, "to": {"lat_deg": 50, "lon_deg": -5}}"#,
        )
        .unwrap();
        assert!(p.great_circle.distance_nm > 2600.0);
        assert!(sailing_impl("{}").unwrap_err().starts_with("sailing:"));
        assert!(
            dr_advance_impl(
                r#"{"from": {"lat_deg": 0, "lon_deg": 0}, "course_deg": 90, "speed_kn": 6}"#
            )
            .unwrap_err()
            .contains("hours")
        );
        assert!(
            route_positions_impl("[]")
                .unwrap_err()
                .starts_with("route_positions:")
        );
        assert!(star_identify_impl(r#"{"utc": "2026-10-01T00:00:00Z"}"#).is_err());
    }
}

#[cfg(test)]
mod api_examples {
    /// The first ```json block after `heading` in docs/EXPLORER_API.md.
    fn example(heading: &str) -> String {
        let doc = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/EXPLORER_API.md"),
        )
        .unwrap();
        let at = doc
            .find(heading)
            .unwrap_or_else(|| panic!("no heading {heading}"));
        let open = at + doc[at..].find("```json").unwrap() + "```json".len();
        let close = open + doc[open..].find("```").unwrap();
        doc[open..close].to_string()
    }

    #[test]
    fn the_documented_requests_give_the_documented_answers() {
        let p =
            super::sailing_impl(&example("### `sailing(request_json) -> PassageReport`")).unwrap();
        assert!((p.great_circle.distance_nm - 3264.54).abs() < 0.005);
        assert!((p.rhumb_line.distance_nm - 3376.90).abs() < 0.005);
        let c = p.composite.unwrap();
        assert!(c.applies && (c.distance_nm - 3271.27).abs() < 0.005);
        assert_eq!(
            p.great_circle.arrival.unwrap().utc.as_deref(),
            Some("2026-10-12T20:12:21.898Z")
        );
        let d =
            super::dr_advance_impl(&example("### `dr_advance(request_json) -> DrReport`")).unwrap();
        assert!((d.to.lon_deg + 33.095819).abs() < 1e-6);
        assert_eq!(d.arrival_utc.as_deref(), Some("2026-10-01T20:00:00.000Z"));
        let r = super::route_positions_impl(&example(
            "### `route_positions(request_json) -> RouteReport`",
        ))
        .unwrap();
        assert!((r.points[0].lon_deg + 69.564864).abs() < 1e-6);
        assert!((r.made_good.unwrap().distance_nm - 42.348).abs() < 0.001);
        let s = super::star_identify_impl(&example(
            "### `star_identify(request_json) -> StarIdResult`",
        ))
        .unwrap();
        assert_eq!(s.best.as_deref(), Some("Vega"));
        assert_eq!(
            s.message,
            "Vega (1.2′ away: the sight is 0.1′ higher and its bearing 4.0′ less)."
        );
    }
}
