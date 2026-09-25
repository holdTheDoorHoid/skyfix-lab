//! Compass error by azimuth and amplitude (CONVENTIONS 14.2) against Bowditch's worked
//! examples and against the engine's own geometry.
//!
//! Source of the examples: The American Practical Navigator (Bowditch), NGA Pub. No. 9,
//! 2019 edition, vol. 1, ch. 15 "Azimuths and Amplitudes", sections 1501-1506; a U.S.
//! Government work. The numbers are in `fixtures/reference/bowditch_compass_examples.json`
//! with provenance. The book works to 0.1 degree with its tables, so "reproduced" means
//! within 0.1 degree; each test prints both numbers
//! (`cargo test -p skyfix-core --test compass_reference -- --nocapture`).

use serde_json::Value;
use skyfix_core::geometry::{Point, altitude_azimuth};
use skyfix_core::methods::compass::{
    AmplitudeHorizon, CompassKind, CompassMethod, CompassObserver, CompassRequest, RiseSet,
    VariationUsed, bearing_at_altitude_deg, celestial_amplitude_deg, compass_error,
    topocentric_alt_az,
};
use skyfix_core::reduce::DirectionSource;
use skyfix_core::time::parse_utc;
use skyfix_core::types::{GeocentricDirection, Limb};
use skyfix_core::units::norm_180;
use skyfix_ephemeris::ProviderSource;
use skyfix_ephemeris::fixture_pack::CompositeProvider;

const BOOK: &str = include_str!("../../../fixtures/reference/bowditch_compass_examples.json");

fn case(name: &str) -> Value {
    let doc: Value = serde_json::from_str(BOOK).unwrap();
    doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no case {name}"))
        .clone()
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

/// The astronomy the WASM adapter's `auto` mode uses.
fn engine() -> ProviderSource<CompositeProvider> {
    ProviderSource(
        CompositeProvider::new("skyfix-auto (Sun, Moon, planets, stars)")
            .with(skyfix_ephemeris::sun::SunProvider::new())
            .with(skyfix_ephemeris::moon::MoonProvider::new())
            .with(skyfix_ephemeris::sights::SightPlanetProvider::new())
            .with(skyfix_ephemeris::stars::StarProvider::new()),
    )
}

/// A body fixed on the celestial sphere (a table's GHA and declination).
struct Fixed(GeocentricDirection);

impl DirectionSource for Fixed {
    fn name(&self) -> &str {
        "fixed"
    }
    fn direction(&self, _body: &str, _jd: f64) -> Result<GeocentricDirection, String> {
        Ok(self.0)
    }
    fn gha_rate_deg_per_hour(&self, _body: &str) -> f64 {
        15.0
    }
}

fn request(
    method: CompassMethod,
    body: &str,
    utc: &str,
    lat: f64,
    lon: f64,
    bearing: f64,
) -> CompassRequest {
    CompassRequest {
        method,
        body: body.into(),
        utc: Some(utc.into()),
        jd_utc: None,
        observer: CompassObserver {
            lat_deg: lat,
            lon_deg: lon,
            height_m: 0.0,
        },
        compass_bearing_deg: bearing,
        compass: CompassKind::Gyro,
        variation_deg: None,
        variation_sigma_deg: None,
        bearing_sigma_deg: None,
        horizon: AmplitudeHorizon::Visible,
        height_of_eye_m: 0.0,
        limb: Limb::Center,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
        event: None,
        magnetic_model: None,
    }
}

#[test]
fn bowditch_1501_gyro_error_by_the_suns_azimuth() {
    let c = case("bowditch-1501-azimuth-sun");
    let (i, e) = (&c["input"], &c["expected"]);
    // On the Greenwich meridian GHA = LHA; the direction is the table's.
    let src = Fixed(GeocentricDirection {
        gha_deg: f(&i["lha_deg"]),
        dec_deg: f(&i["dec_deg"]),
        semidiameter_arcmin: 16.0,
        horizontal_parallax_arcmin: 0.0,
    });
    let req = request(
        CompassMethod::Azimuth,
        "Sun",
        "2016-01-01T00:00:00Z",
        f(&i["lat_deg"]),
        0.0,
        f(&i["gyro_bearing_deg"]),
    );
    let r = compass_error(&req, &src, None).unwrap();
    println!(
        "1501: Zn {:.3} (book {}), gyro error {:+.3} (book {})",
        r.true_bearing_deg, e["zn_deg"], r.compass_error_deg, e["gyro_error_deg"]
    );
    assert!((r.true_bearing_deg - f(&e["zn_deg"])).abs() < 0.05);
    assert!((r.compass_error_deg - f(&e["gyro_error_deg"])).abs() < 0.05);
    assert_eq!(r.sentence, "Gyro error 0.8° W.");
    // The spherical Zn of CONVENTIONS 3 is the same number for a body at infinity.
    let a = r.azimuth.unwrap();
    assert!((a.zn_spherical_deg - r.true_bearing_deg).abs() < 1e-9);
}

#[test]
fn bowditch_1502_gyro_error_by_polaris_through_the_engine() {
    let c = case("bowditch-1502-azimuth-polaris");
    let (i, e) = (&c["input"], &c["expected"]);
    let req = request(
        CompassMethod::Azimuth,
        "Polaris",
        i["utc"].as_str().unwrap(),
        f(&i["lat_deg"]),
        f(&i["lon_deg"]),
        f(&i["gyro_bearing_deg"]),
    );
    let r = compass_error(&req, &engine(), None).unwrap();
    println!(
        "1502: Polaris Zn {:.3} (Almanac table {}), gyro error {:+.3} (book {})",
        r.true_bearing_deg, e["zn_deg"], r.compass_error_deg, e["gyro_error_deg"]
    );
    // The Almanac's Polaris table gives the azimuth to 0.1 degree: 359.2 is anything from
    // 359.15 to 359.25, and the engine's 359.25 sits at the edge of that (so its sentence
    // rounds the error to 0.6° W where the book, from the table, has 0.7° W).
    assert!((r.true_bearing_deg - f(&e["zn_deg"])).abs() <= 0.05 + 1e-3);
    assert!((r.compass_error_deg - f(&e["gyro_error_deg"])).abs() <= 0.05 + 1e-3);
    assert!(r.sentence.starts_with("Gyro error 0.") && r.sentence.ends_with("° W."));
    let lha_aries = norm_180(
        skyfix_ephemeris::sidereal::gha_aries_deg(
            parse_utc(i["utc"].as_str().unwrap()).unwrap(),
            0.0,
        ) + f(&i["lon_deg"])
            - f(&e["lha_aries_deg"]),
    );
    assert!(
        lha_aries.abs() < 0.1 / 60.0 + 1e-6,
        "LHA Aries off by {lha_aries}"
    );
}

#[test]
fn bowditch_1504_to_1506_amplitudes() {
    let c = case("bowditch-1504-amplitude-celestial");
    let (i, e) = (&c["input"], &c["expected"]);
    let (lat, dec) = (f(&i["lat_deg"]), f(&i["dec_deg"]));
    let a = celestial_amplitude_deg(lat, dec).unwrap();
    let zn = bearing_at_altitude_deg(lat, dec, 0.0, RiseSet::Setting).unwrap();
    let err = norm_180(zn - f(&i["gyro_bearing_deg"]));
    println!(
        "1504: amplitude {a:.3} (book {}), Zn {zn:.3} (book {}), error {err:+.3} (book {})",
        e["amplitude_deg"], e["zn_deg"], e["gyro_error_deg"]
    );
    assert!((a - f(&e["amplitude_deg"])).abs() < 0.1);
    assert!((zn - f(&e["zn_deg"])).abs() < 0.1);
    assert!((err - f(&e["gyro_error_deg"])).abs() < 0.1);

    let c = case("bowditch-1505-amplitude-visible");
    let (i, e) = (&c["input"], &c["expected"]);
    let (lat, dec) = (f(&i["lat_deg"]), f(&i["dec_deg"]));
    let a = celestial_amplitude_deg(lat, dec).unwrap();
    let celestial = bearing_at_altitude_deg(lat, dec, 0.0, RiseSet::Rising).unwrap();
    // Table 23 is tabulated for the Sun's centre on the visible horizon, Hc = -0.7
    // (section 1506); computed exactly at that altitude.
    let visible = bearing_at_altitude_deg(lat, dec, -0.7, RiseSet::Rising).unwrap();
    let table23 = celestial - visible;
    let corrected = f(&i["gyro_bearing_deg"]) + table23;
    let err = norm_180(celestial - corrected);
    println!(
        "1505: amplitude {a:.3} (book {}), celestial Zn {celestial:.3} (book {}), Table 23 \
         {table23:+.3} (book {}), corrected bearing {corrected:.3} (book {}), error {err:+.3} (book {})",
        e["amplitude_deg"],
        e["celestial_zn_deg"],
        e["table23_correction_deg"],
        e["corrected_bearing_deg"],
        e["gyro_error_deg"]
    );
    assert!((a - f(&e["amplitude_deg"])).abs() < 0.1);
    assert!((celestial - f(&e["celestial_zn_deg"])).abs() < 0.1);
    assert!((table23 - f(&e["table23_correction_deg"])).abs() < 0.1);
    assert!((corrected - f(&e["corrected_bearing_deg"])).abs() < 0.1);
    assert!((err - f(&e["gyro_error_deg"])).abs() < 0.1);

    let c = case("bowditch-1506-amplitude-by-calculation");
    let (i, e) = (&c["input"], &c["expected"]);
    let zn = bearing_at_altitude_deg(
        f(&i["lat_deg"]),
        f(&i["dec_deg"]),
        f(&i["hc_deg"]),
        RiseSet::Rising,
    )
    .unwrap();
    let err = norm_180(zn - f(&i["gyro_bearing_deg"]));
    println!(
        "1506: Zn {zn:.3} (book {}), error {err:+.3} (book {})",
        e["zn_deg"], e["gyro_error_deg"]
    );
    assert!((zn - f(&e["zn_deg"])).abs() < 0.1);
    assert!((90.0 - zn - f(&e["amplitude_deg"])).abs() < 0.1);
    assert!((err - f(&e["gyro_error_deg"])).abs() < 0.1);
}

#[test]
fn a_sunset_amplitude_through_the_engine_is_the_suns_own_bearing_at_that_moment() {
    // Philadelphia, midsummer sunset, eye 3 m, the lower limb on the sea horizon.
    let mut req = request(
        CompassMethod::Amplitude,
        "Sun",
        "2026-06-21T00:20:00Z",
        39.9526,
        -75.1652,
        300.0,
    );
    req.height_of_eye_m = 3.0;
    req.limb = Limb::Lower;
    let src = engine();
    let r = compass_error(&req, &src, None).unwrap();
    let a = r.amplitude.clone().unwrap();
    assert_eq!(a.event, RiseSet::Setting);
    // The crossing is at the chain's altitude on the engine's own track ...
    let d = src.direction("Sun", r.jd_utc).unwrap();
    let (h, _) = altitude_azimuth(
        Point::from_deg(39.9526, -75.1652),
        d.gha_deg.to_radians(),
        d.dec_deg.to_radians(),
    );
    assert!(
        (h.to_degrees() - a.altitude_deg).abs() < 1e-5,
        "{} vs {}",
        h.to_degrees(),
        a.altitude_deg
    );
    // ... and the bearing is the topocentric azimuth there.
    let (_, az) = topocentric_alt_az(&req.observer, &d);
    println!(
        "sunset: {} bearing {:.4}, topocentric {az:.4}, amplitude {:?}, correction {:+.3}, altitude {:.3}",
        r.utc,
        r.true_bearing_deg,
        a.amplitude_text,
        a.visible_horizon_correction_deg,
        a.altitude_deg
    );
    // verify2: ACCURACY.md says 0.0000 deg for the Sun (measured under 0.00005).
    assert!((r.true_bearing_deg - az).abs() < 1e-4);
    // Lower limb on the horizon from 3 m: dip 3.0', refraction 34.5' at -0.05 deg, the
    // centre a semidiameter higher: about -0.35 deg, so it sets a little north of the
    // celestial-horizon bearing (dec north, north latitude).
    assert!(
        a.altitude_deg > -0.45 && a.altitude_deg < -0.25,
        "{}",
        a.altitude_deg
    );
    assert!(a.visible_horizon_correction_deg > 0.0 && a.visible_horizon_correction_deg < 0.5);
    assert!(a.minutes_from_given_time.abs() < 30.0);
}

#[test]
fn a_moonrise_amplitude_has_the_moon_above_the_celestial_horizon() {
    let mut req = request(
        CompassMethod::Amplitude,
        "Moon",
        "2026-09-26T22:00:00Z",
        39.9526,
        -75.1652,
        100.0,
    );
    req.event = Some(RiseSet::Rising);
    req.height_of_eye_m = 2.0;
    let src = engine();
    let r = compass_error(&req, &src, None).unwrap();
    let a = r.amplitude.clone().unwrap();
    let d = src.direction("Moon", r.jd_utc).unwrap();
    let (_, az) = topocentric_alt_az(&req.observer, &d);
    println!(
        "moonrise: {} bearing {:.4}, topocentric {az:.4}, altitude {:.3}, parallax {:.2}'",
        r.utc, r.true_bearing_deg, a.altitude_deg, a.parallax_arcmin
    );
    // Parallax (about 55-61') lifts the centre above the celestial horizon on the sea
    // horizon; the ellipsoid moves the Moon's azimuth by under 0.02 degree.
    assert!(a.altitude_deg > 0.15 && a.altitude_deg < 0.35);
    assert!(a.parallax_arcmin > 53.0 && a.parallax_arcmin < 62.0);
    assert!((r.true_bearing_deg - az).abs() < 0.02);
    assert!(a.visible_horizon_correction_deg.abs() < 0.5);
}

#[test]
fn the_sentence_splits_the_error_into_variation_and_deviation() {
    // The brief's example: compass error 3.2 W, variation 11.5 W, deviation 8.3 E.
    let src = Fixed(GeocentricDirection {
        gha_deg: 300.0,
        dec_deg: 10.0,
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: 0.0,
    });
    let mut req = request(
        CompassMethod::Azimuth,
        "Vega",
        "2026-09-24T02:00:00Z",
        40.0,
        0.0,
        0.0,
    );
    let truth = compass_error(&req, &src, None).unwrap().true_bearing_deg;
    req.compass = CompassKind::Magnetic;
    req.compass_bearing_deg = (truth + 3.2).rem_euclid(360.0);
    let model = |_jd: f64| -> Result<VariationUsed, String> {
        Ok(VariationUsed {
            deg: -11.5,
            sigma_deg: Some(0.4),
            source: "WMM2025".into(),
            text: "11.5° W".into(),
            notes: vec![],
        })
    };
    let r = compass_error(&req, &src, Some(&model)).unwrap();
    assert_eq!(
        r.sentence,
        "Compass error 3.2° W; variation 11.5° W; deviation 8.3° E."
    );
    assert!((r.deviation_deg.unwrap() - 8.3).abs() < 1e-9);
    assert_eq!(r.deviation_sigma_deg, Some(0.4));
    // A chart's variation wins over the model, and the bearing's own sigma is combined.
    req.variation_deg = Some(-12.0);
    req.bearing_sigma_deg = Some(0.3);
    let r = compass_error(&req, &src, Some(&model)).unwrap();
    assert_eq!(r.variation.as_ref().unwrap().source, "given");
    assert_eq!(
        r.sentence,
        "Compass error 3.2° W; variation 12.0° W; deviation 8.8° E."
    );
    assert_eq!(r.deviation_sigma_deg, Some(0.3));
    // Without any variation the sentence says only what is known, and a note says why.
    let model_fails = |_jd: f64| -> Result<VariationUsed, String> { Err("after 2030".into()) };
    req.variation_deg = None;
    let r = compass_error(&req, &src, Some(&model_fails)).unwrap();
    assert_eq!(r.sentence, "Compass error 3.2° W.");
    assert!(r.deviation_deg.is_none());
    assert!(r.notes.iter().any(|n| n.contains("after 2030")));
}

#[test]
fn bad_requests_are_refused_with_the_field_named() {
    let src = engine();
    let good = request(
        CompassMethod::Azimuth,
        "Sun",
        "2026-09-24T12:00:00Z",
        40.0,
        -75.0,
        180.0,
    );
    for (edit, field) in [
        (
            Box::new(|r: &mut CompassRequest| r.compass_bearing_deg = 360.0)
                as Box<dyn Fn(&mut CompassRequest)>,
            "compass_bearing_deg",
        ),
        (
            Box::new(|r: &mut CompassRequest| r.observer.lat_deg = 91.0),
            "observer.lat_deg",
        ),
        (
            Box::new(|r: &mut CompassRequest| r.height_of_eye_m = -1.0),
            "height_of_eye_m",
        ),
        (Box::new(|r: &mut CompassRequest| r.utc = None), "utc"),
        (
            Box::new(|r: &mut CompassRequest| r.jd_utc = Some(2_461_000.0)),
            "utc",
        ),
        (
            Box::new(|r: &mut CompassRequest| r.bearing_sigma_deg = Some(0.0)),
            "bearing_sigma_deg",
        ),
        (
            Box::new(|r: &mut CompassRequest| r.variation_deg = Some(f64::NAN)),
            "variation_deg",
        ),
    ] {
        let mut r = good.clone();
        edit(&mut r);
        let e = compass_error(&r, &src, None).unwrap_err().to_string();
        assert!(e.contains(field), "{field}: {e}");
    }
    // A body the engine cannot answer for says why.
    let mut r = good.clone();
    r.body = "Vulcan".into();
    assert!(compass_error(&r, &src, None).is_err());
    // A Sun that never sets at 80 N in June: no amplitude, a reason.
    let mut r = request(
        CompassMethod::Amplitude,
        "Sun",
        "2026-06-21T12:00:00Z",
        80.0,
        0.0,
        0.0,
    );
    r.event = Some(RiseSet::Setting);
    let e = compass_error(&r, &src, None).unwrap_err().to_string();
    assert!(e.contains("does not set"), "{e}");
}
