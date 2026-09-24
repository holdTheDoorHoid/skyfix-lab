//! Venus's centre of light and the Moon's altitude corrections against USNO.
//!
//! `fixtures/reference/usno_celnav_venus_phase.json` (tools/reference/gen_usno_sights.py)
//! stores USNO "Celestial Navigation Data" responses. USNO tabulates Venus at its centre
//! of light, as the Nautical Almanac does, and evaluates Solar System bodies about
//! 10.36 s late (ACCURACY.md, Moon); the providers are therefore evaluated at
//! t + 10.36 s and compared in right ascension and declination, with the Earth's
//! orientation (GAST) taken at t exactly as USNO takes it.

use serde::Deserialize;
use skyfix_core::corrections::{limb_to_centre, rigorous_parallax_in_altitude_arcmin};
use skyfix_core::time::{jd_tt, parse_utc};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::body::{ApparentState, BodyKind};
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::planets::PlanetProvider;
use skyfix_ephemeris::sidereal::gast_deg;
use skyfix_ephemeris::sights::SightPlanetProvider;
use skyfix_ephemeris::topocentric::{Site, horizontal};

const FIXTURE: &str = "fixtures/reference/usno_celnav_venus_phase.json";
const LAG_S: f64 = 10.36;

#[derive(Debug, Deserialize)]
struct File {
    generator: Generator,
    venus: Vec<PlanetCase>,
    mars: Vec<PlanetCase>,
    moon: Vec<MoonCase>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    tolerance_arcmin: f64,
}

#[derive(Debug, Deserialize)]
struct Usno {
    gha_deg: f64,
    dec_deg: f64,
}

#[derive(Debug, Deserialize)]
struct PlanetCase {
    utc: String,
    usno: Usno,
}

#[derive(Debug, Deserialize)]
struct LatLon {
    lat_deg: f64,
    lon_deg: f64,
}

#[derive(Debug, Deserialize)]
struct UsnoMoon {
    hc_deg: f64,
    pa_deg: f64,
    sd_deg: f64,
}

#[derive(Debug, Deserialize)]
struct MoonCase {
    utc: String,
    site: LatLon,
    usno: UsnoMoon,
}

fn load() -> File {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture present")).expect("parses")
}

/// USNO minus ours, arcminutes on the sky: (RA x cos Dec, Dec).
fn difference(case: &PlanetCase, provider: &dyn AstroProvider, body: &str) -> (f64, f64) {
    let jd = parse_utc(&case.utc).unwrap();
    let late = jd + LAG_S / 86_400.0;
    let d = provider.geocentric(body, late).unwrap();
    let ra_ours = gast_deg(late, jd_tt(late)) - d.gha_deg;
    let ra_usno = gast_deg(jd, jd_tt(jd)) - case.usno.gha_deg;
    let d_ra = ((ra_usno - ra_ours + 540.0).rem_euclid(360.0) - 180.0) * 60.0;
    (
        d_ra * case.usno.dec_deg.to_radians().cos(),
        (case.usno.dec_deg - d.dec_deg) * 60.0,
    )
}

#[test]
fn venus_is_at_its_centre_of_light_as_usno_and_the_almanac_have_it() {
    let f = load();
    assert_eq!(f.venus.len(), 12);
    let sights = SightPlanetProvider::new();
    let geometric = PlanetProvider::new();
    let (mut worst_light, mut worst_centre) = (0.0f64, 0.0f64);
    for case in &f.venus {
        let (a, b) = difference(case, &sights, "Venus");
        let light = a.hypot(b);
        let (c, d) = difference(case, &geometric, "Venus");
        let centre = c.hypot(d);
        println!(
            "{} centre of light {light:.4}', geometric centre {centre:.4}'",
            case.utc
        );
        assert!(
            light <= f.generator.tolerance_arcmin,
            "{}: {light:.4}' from USNO",
            case.utc
        );
        worst_light = worst_light.max(light);
        worst_centre = worst_centre.max(centre);
    }
    println!("worst: centre of light {worst_light:.4}', geometric {worst_centre:.4}'");
    // The test can tell the two apart: the geometric centre misses by 0.4'.
    assert!(worst_centre > 0.35, "{worst_centre}");
}

#[test]
fn mars_gets_no_phase_correction_from_usno_or_from_us() {
    let f = load();
    let sights = SightPlanetProvider::new();
    for case in &f.mars {
        let (a, b) = difference(case, &sights, "Mars");
        let miss = a.hypot(b);
        println!("{} Mars {miss:.4}'", case.utc);
        assert!(
            miss <= f.generator.tolerance_arcmin,
            "{}: {miss:.4}'",
            case.utc
        );
    }
}

#[test]
fn the_moons_semidiameter_and_parallax_beside_usnos() {
    // USNO's corrections are for the lower limb at its own Hc. The topocentric altitude
    // of the centre is Hc - PA; from there the augmented semidiameter and both
    // parallaxes are compared.
    let f = load();
    let moon = MoonProvider::new();
    for case in &f.moon {
        let jd = parse_utc(&case.utc).unwrap() + LAG_S / 86_400.0;
        let p = moon.position(jd).unwrap();
        let h_centre = case.usno.hc_deg - case.usno.pa_deg;
        let sd_usno = case.usno.sd_deg * 60.0;
        // The lower limb is SD' below the centre; the chain goes from the limb up.
        let (sd_ours, _) = limb_to_centre(
            h_centre - sd_usno / 60.0,
            1.0,
            p.semidiameter_arcmin,
            p.horizontal_parallax_arcmin,
        );
        // USNO's SD rests on k = 0.2724 (the Almanac's), this project's on the IAU
        // 0.2725076: 0.006' at most.
        assert!(
            (sd_ours - sd_usno).abs() < 0.012,
            "{}: SD {sd_ours:.4}' vs USNO {sd_usno:.4}'",
            case.utc
        );
        // The spherical Earth's parallax (CONVENTIONS section 5) against USNO's, which
        // is computed for the real Earth at the position: up to 0.22' apart.
        let pa_sphere =
            rigorous_parallax_in_altitude_arcmin(p.horizontal_parallax_arcmin, h_centre);
        let pa_usno = case.usno.pa_deg * 60.0;
        assert!(
            (pa_sphere - pa_usno).abs() < 0.23,
            "{}: sphere {pa_sphere:.4}' vs USNO {pa_usno:.4}'",
            case.utc
        );
        // The explorer's WGS84 topocentric model reproduces USNO's parallax: the
        // difference really is the Earth's shape.
        let state = ApparentState {
            body: "Moon".into(),
            kind: BodyKind::Moon,
            jd_utc: jd,
            ra_deg: p.ra_deg,
            dec_deg: p.dec_deg,
            // The Earth's orientation at t, the body's position at t + lag.
            gha_deg: gast_deg(jd - LAG_S / 86_400.0, jd_tt(jd - LAG_S / 86_400.0)) - p.ra_deg,
            distance_km: Some(p.distance_km),
            semidiameter_arcmin: p.semidiameter_arcmin,
            horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
            magnitude: None,
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        };
        let topo = horizontal(&state, &Site::new(case.site.lat_deg, case.site.lon_deg));
        let pa_wgs84 = (case.usno.hc_deg - topo.alt_deg) * 60.0;
        println!(
            "{}: PA sphere {pa_sphere:.4}', WGS84 {pa_wgs84:.4}', USNO {pa_usno:.4}'; SD ours {sd_ours:.4}', USNO {sd_usno:.4}'",
            case.utc
        );
        assert!(
            (pa_wgs84 - pa_usno).abs() < 0.005,
            "{}: WGS84 {pa_wgs84:.4}' vs USNO {pa_usno:.4}'",
            case.utc
        );
    }
}
