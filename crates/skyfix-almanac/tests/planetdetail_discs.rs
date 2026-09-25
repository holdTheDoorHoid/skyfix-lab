//! Planet discs and Saturn's rings against JPL Horizons
//! (`fixtures/reference/planetdetail_horizons.json`): sub-Earth and sub-solar points,
//! central meridians, pole position angles, diameters, illumination and the defect of
//! illumination of Mercury to Neptune, and B, B' and P of Saturn's rings. Epochs outside
//! the planet provider's coverage are skipped (they are there for the deep-time tiers).

mod pd_common;

use pd_common::{Worst, jd_utc_from_tt, planet_coverage, read, wrap};
use serde::Deserialize;
use skyfix_almanac::discs::planet_disc;
use skyfix_ephemeris::planets::{Planet, PlanetProvider};

#[derive(Debug, Deserialize)]
struct File {
    planets: std::collections::BTreeMap<String, PlanetRows>,
}

#[derive(Debug, Deserialize)]
struct PlanetRows {
    radii_km: [f64; 2],
    rows: Vec<Row>,
}

#[derive(Debug, Deserialize)]
struct Row {
    jd_tt: f64,
    illuminated_percent: f64,
    defect_arcsec: f64,
    angular_diameter_arcsec: f64,
    obs_sub_lon_deg: f64,
    obs_sub_lat_graphic_deg: f64,
    sun_sub_lon_deg: f64,
    sun_sub_lat_graphic_deg: f64,
    np_ang_deg: f64,
    phase_angle_deg: f64,
}

/// Worst residuals for one planet, and the tolerance each is held to.
#[derive(Debug, Default)]
struct Residuals {
    sub_lon: Worst,
    sub_lat: Worst,
    sun_lon: Worst,
    sun_lat: Worst,
    pole_pa: Worst,
    diameter_rel: Worst,
    illum_pct: Worst,
    defect: Worst,
    phase: Worst,
}

fn file() -> File {
    serde_json::from_str(&read("fixtures/reference/planetdetail_horizons.json")).unwrap()
}

#[test]
fn discs_match_horizons() {
    let provider = PlanetProvider::new();
    let (lo, hi) = planet_coverage();
    let f = file();
    let mut total = 0;
    for (name, pr) in &f.planets {
        let planet = Planet::from_name(name).unwrap();
        assert!(
            (pr.radii_km[0] - planet.equatorial_radius_km()).abs() < 1e-9,
            "{name}: the fixture's reference ellipsoid is the provider's"
        );
        let mut r = Residuals::default();
        for row in &pr.rows {
            let jd = jd_utc_from_tt(row.jd_tt);
            if jd < lo || jd > hi {
                continue;
            }
            let d = planet_disc(&provider, planet, jd).unwrap();
            let at = || format!("{name} jd_tt {}", row.jd_tt);
            // Longitudes on the sky: a longitude error at latitude B is cos B as wide.
            let cos_b = d.sub_earth_lat_deg.to_radians().cos();
            r.sub_lon
                .add(wrap(d.sub_earth_lon_deg, row.obs_sub_lon_deg) * cos_b, at);
            r.sub_lat.add(
                d.sub_earth_lat_graphic_deg - row.obs_sub_lat_graphic_deg,
                at,
            );
            let cos_s = d.sub_solar_lat_deg.to_radians().cos();
            r.sun_lon
                .add(wrap(d.sub_solar_lon_deg, row.sun_sub_lon_deg) * cos_s, at);
            r.sun_lat.add(
                d.sub_solar_lat_graphic_deg - row.sun_sub_lat_graphic_deg,
                at,
            );
            r.pole_pa
                .add(wrap(d.pole_position_angle_deg, row.np_ang_deg), at);
            r.diameter_rel.add(
                d.equatorial_diameter_arcsec / row.angular_diameter_arcsec - 1.0,
                at,
            );
            r.illum_pct
                .add(100.0 * d.illuminated_fraction - row.illuminated_percent, at);
            r.defect
                .add(d.defect_of_illumination_arcsec - row.defect_arcsec, at);
            r.phase.add(d.phase_angle_deg - row.phase_angle_deg, at);
            total += 1;
        }
        println!("{name}: {r:#?}");
        // Tolerances: the planet's direction is good to 0.03' (Uranus) and 0.04'
        // (Neptune), 0.006' for the others (ACCURACY.md "Planets"); a direction error
        // moves the sub-Earth point by the same angle.
        let dir = match planet {
            Planet::Uranus | Planet::Neptune => 0.001,
            _ => 0.0003,
        };
        assert!(
            r.sub_lon.value.abs() < dir,
            "{name} sub-Earth longitude {:?}",
            r.sub_lon
        );
        assert!(
            r.sub_lat.value.abs() < dir,
            "{name} sub-Earth latitude {:?}",
            r.sub_lat
        );
        assert!(
            r.sun_lon.value.abs() < dir,
            "{name} sub-solar longitude {:?}",
            r.sun_lon
        );
        assert!(
            r.sun_lat.value.abs() < dir,
            "{name} sub-solar latitude {:?}",
            r.sun_lat
        );
        // A direction error turns the projected pole by that error over the sine of the
        // pole's angle from the line of sight: Uranus's pole points within 30 degrees of
        // the Earth in these years, so its 1.8" becomes up to 9".
        let pa_tol = match planet {
            Planet::Uranus | Planet::Neptune => 0.005,
            _ => 0.001,
        };
        assert!(
            r.pole_pa.value.abs() < pa_tol,
            "{name} pole PA {:?}",
            r.pole_pa
        );
        assert!(
            r.diameter_rel.value.abs() < 1e-5,
            "{name} diameter {:?}",
            r.diameter_rel
        );
        // The provider's phase angle is geometric (as Skyfield's and Mallama's); Horizons'
        // S-T-O uses apparent vectors, aberration included: up to 0.009 deg apart (Mars,
        // Mercury), which moves the illuminated percentage by up to 0.01 and the defect
        // by that fraction of the diameter (0.002" for Venus's 60" crescent).
        assert!(
            r.illum_pct.value.abs() < 0.015,
            "{name} illumination {:?}",
            r.illum_pct
        );
        assert!(r.defect.value.abs() < 0.005, "{name} defect {:?}", r.defect);
        assert!(r.phase.value.abs() < 0.012, "{name} phase {:?}", r.phase);
    }
    assert!(total > 150, "{total} rows compared");
}

#[test]
fn saturns_rings_match_horizons() {
    use skyfix_almanac::rings::saturn_rings;
    let provider = PlanetProvider::new();
    let (lo, hi) = planet_coverage();
    let f = file();
    let saturn = &f.planets["Saturn"];
    // Horizons prints planetodetic latitudes; B and B' are planetocentric.
    let k = (saturn.radii_km[1] / saturn.radii_km[0]).powi(2);
    let centric = |graphic: f64| (k * graphic.to_radians().tan()).atan().to_degrees();
    let (mut b, mut b_sun, mut p) = (Worst::default(), Worst::default(), Worst::default());
    for row in &saturn.rows {
        let jd = jd_utc_from_tt(row.jd_tt);
        if jd < lo || jd > hi {
            continue;
        }
        let r = saturn_rings(&provider, jd).unwrap();
        let at = || format!("jd_tt {}", row.jd_tt);
        b.add(
            r.earth_latitude_deg - centric(row.obs_sub_lat_graphic_deg),
            at,
        );
        b_sun.add(
            r.sun_latitude_deg - centric(row.sun_sub_lat_graphic_deg),
            at,
        );
        p.add(wrap(r.position_angle_deg, row.np_ang_deg), at);
    }
    println!("B {b:?}\nB' {b_sun:?}\nP {p:?}");
    assert!(b.count >= 30, "{b:?}");
    assert!(
        b.value.abs() < 0.0003 && b_sun.value.abs() < 0.0003,
        "{b:?} {b_sun:?}"
    );
    assert!(p.value.abs() < 0.001, "{p:?}");
}

#[test]
fn saturns_rings_reproduce_meeus_example_45a_up_to_the_pole_and_ring_size() {
    // Meeus, Astronomical Algorithms, example 45.a, 1992 December 16 at 0h UT (JDE
    // 2448972.50068): B = 16.442, B' = 14.679, delta U = 4.198, P = 6.741 degrees,
    // a = 35.87", b = 10.15". Meeus's ring pole (i, Omega of the 1980s) differs from the
    // IAU 2015 pole by enough to move P by 0.026 deg and B by 0.005 deg (Horizons agrees
    // with ours to 0.0001 deg, `saturns_rings_match_horizons`); his outer edge is 136,117
    // km, NASA's 136,780.
    use skyfix_almanac::rings::saturn_rings;
    let r = saturn_rings(&PlanetProvider::new(), jd_utc_from_tt(2_448_972.500_68)).unwrap();
    println!("{r:#?}");
    assert!((r.earth_latitude_deg - 16.442).abs() < 0.01, "{r:?}");
    assert!((r.sun_latitude_deg - 14.679).abs() < 0.01, "{r:?}");
    assert!((r.delta_u_deg - 4.198).abs() < 0.01, "{r:?}");
    assert!((r.position_angle_deg - 6.741).abs() < 0.03, "{r:?}");
    let meeus_scale = 136_117.0 / 136_780.0;
    assert!(
        (r.major_axis_arcsec * meeus_scale - 35.87).abs() < 0.01,
        "{r:?}"
    );
    assert!(
        (r.minor_axis_arcsec * meeus_scale - 10.15).abs() < 0.01,
        "{r:?}"
    );
}

#[test]
fn jupiters_central_meridians_reproduce_meeus_example_43a() {
    // Meeus, Astronomical Algorithms, example 43.a, 1992 December 16 at 0h UT: DE =
    // -2.48, P = 24.80, omega I = 268.06 and omega II = 72.74 degrees. Meeus's omegas
    // are the central meridians of the illuminated disc: the geometric ones (ours, and
    // Horizons' sub-observer point) plus the phase correction 57.3 sin^2(i/2) degrees,
    // added with Jupiter west of the Sun, as it was (0.43 deg at i = 9.9 deg). His own
    // geometric low-accuracy values are 267.69 and 72.36.
    let d = planet_disc(&PlanetProvider::new(), Planet::Jupiter, 2_448_972.5).unwrap();
    assert!((d.sub_earth_lat_deg - -2.48).abs() < 0.01, "{d:?}");
    assert!((d.pole_position_angle_deg - 24.80).abs() < 0.01, "{d:?}");
    let phase = 57.3 * (d.phase_angle_deg.to_radians() / 2.0).sin().powi(2);
    let cm = |system: &str| {
        d.central_meridians
            .iter()
            .find(|c| c.system == system)
            .unwrap()
            .longitude_deg
    };
    assert!((cm("I") + phase - 268.06).abs() < 0.1, "{d:?}");
    assert!((cm("II") + phase - 72.74).abs() < 0.1, "{d:?}");
}
