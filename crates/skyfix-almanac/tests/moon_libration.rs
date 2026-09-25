//! The Moon's orientation against Skyfield with JPL's DE440 lunar orientation
//! (`fixtures/reference/moon_libration.json`, `tools/moon/gen_reference.py`) and against
//! Meeus's worked example 53.a. Target (EXPANSION_PLAN P8): 0.05°.
//!
//! Three checks, each printing its worst case for `docs/ACCURACY.md`:
//!
//! - Meeus 53.a: the printed optical and physical librations, `ρ σ τ`, the total, the
//!   position angle of the axis and the Sun's selenographic place;
//! - `frame_cases`: Skyfield's own apparent places of the Moon and the Sun fed to
//!   [`MoonFrame`], 1550-2650, so the orientation model is tested alone over the whole
//!   validated span whatever the ephemeris coverage of this build;
//! - `observer_cases`: the whole chain (`moon_orientation`) for the Earth's centre and six
//!   observers, 1990-2060, UT1 = UTC.

use std::path::PathBuf;

use skyfix_almanac::libration::{
    FIGURE_TO_MEAN_POLE_ARCSEC, MoonFrame, fundamental_arguments, meeus_libration,
    moon_orientation, physical_libration,
};
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::Site;

fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn f(v: &serde_json::Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} missing in {v}"))
}

fn unit_radec(ra: f64, dec: f64) -> [f64; 3] {
    let (sa, ca) = ra.to_radians().sin_cos();
    let (sd, cd) = dec.to_radians().sin_cos();
    [cd * ca, cd * sa, sd]
}

/// Angle between two selenographic places, degrees.
fn arc_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let a = unit_radec(lon1, lat1);
    let b = unit_radec(lon2, lat2);
    let c = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    s.atan2(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
        .to_degrees()
}

fn unit_of(v: [f64; 3]) -> [f64; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / n, v[1] / n, v[2] / n]
}

fn wrap(d: f64) -> f64 {
    (d + 540.0).rem_euclid(360.0) - 180.0
}

fn position_angle(u: [f64; 3], p: [f64; 3]) -> f64 {
    let e = [-u[1], u[0], 0.0];
    let ne = (e[0] * e[0] + e[1] * e[1]).sqrt();
    let e = [e[0] / ne, e[1] / ne, 0.0];
    let n = [
        u[1] * e[2] - u[2] * e[1],
        u[2] * e[0] - u[0] * e[2],
        u[0] * e[1] - u[1] * e[0],
    ];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    dot(p, e).atan2(dot(p, n)).to_degrees().rem_euclid(360.0)
}

#[test]
fn meeus_example_53a() {
    let fx = fixture("moon_libration.json");
    let m = &fx["meeus_53a"];
    let jd_tt = f(m, "jd_tt");
    let a = fundamental_arguments(jd_tt);
    let p = physical_libration(&a);
    // Meeus prints rho, sigma, tau to 0.00001 degree.
    assert!((p.rho_deg - f(m, "rho_deg")).abs() < 6e-6, "{p:?}");
    assert!((p.sigma_deg - f(m, "sigma_deg")).abs() < 6e-6, "{p:?}");
    assert!((p.tau_deg - f(m, "tau_deg")).abs() < 6e-6, "{p:?}");
    // With Meeus's own lambda, beta and Delta-psi, the closed formulas reproduce his
    // printed librations to their last digit.
    let l = meeus_libration(
        f(m, "lambda_deg"),
        f(m, "beta_deg"),
        f(m, "dpsi_deg"),
        &a,
        &p,
    );
    assert!(
        (l.optical_lon_deg - f(m, "optical_lon_deg")).abs() < 6e-4,
        "{l:?}"
    );
    assert!(
        (l.optical_lat_deg - f(m, "optical_lat_deg")).abs() < 6e-4,
        "{l:?}"
    );
    assert!(
        (l.physical_lon_deg - f(m, "physical_lon_deg")).abs() < 6e-4,
        "{l:?}"
    );
    assert!(
        (l.physical_lat_deg - f(m, "physical_lat_deg")).abs() < 6e-4,
        "{l:?}"
    );

    // The whole chain at the same instant, from this project's own Moon and Sun (whose
    // lambda differs from Meeus's chapter-47 value by 0.0005 degree): every printed
    // total to its rounding.
    // TT - UTC is the same few tens of seconds at both instants.
    let jd_utc = jd_tt - (skyfix_core::time::jd_tt(jd_tt) - jd_tt);
    let o = moon_orientation(&MoonProvider::new(), &SunProvider::new(), None, jd_utc).unwrap();
    let close = |got: f64, want: f64, tol: f64, what: &str| {
        assert!(
            (got - want).abs() < tol,
            "{what}: {got:.4} against Meeus's {want}"
        );
    };
    // Meeus's totals are in the figure frame of his chapter (Eckhardt's principal-axis
    // pole); the explorer reports the mean Earth/polar axis frame, 78.7 arcseconds away.
    let mp = MoonProvider::new().position(jd_utc).unwrap();
    let frame = MoonFrame::at(mp.jd_tt - mp.light_time_s / 86_400.0);
    let back = [-mp.apparent_km[0], -mp.apparent_km[1], -mp.apparent_km[2]];
    let fig = frame.figure_selenographic(back);
    close(fig.lon_deg, f(m, "total_lon_deg"), 0.006, "l");
    close(fig.lat_deg, f(m, "total_lat_deg"), 0.006, "b");
    let tilt = FIGURE_TO_MEAN_POLE_ARCSEC / 3600.0;
    close(
        o.libration.lat_deg,
        fig.lat_deg - tilt,
        0.001,
        "b in the mean-Earth frame",
    );
    close(
        position_angle(unit_of(mp.apparent_km), frame.figure_pole()),
        f(m, "axis_position_angle_deg"),
        0.006,
        "P (figure pole)",
    );
    close(
        o.libration.optical_lon_deg,
        f(m, "optical_lon_deg"),
        0.0015,
        "l'",
    );
    close(
        o.libration.optical_lat_deg,
        f(m, "optical_lat_deg"),
        0.0015,
        "b'",
    );
    close(
        o.libration.physical_lon_deg,
        f(m, "physical_lon_deg"),
        0.0006,
        "l''",
    );
    close(
        o.libration.physical_lat_deg,
        f(m, "physical_lat_deg"),
        0.0006,
        "b''",
    );
    close(
        o.axis_position_angle_deg,
        f(m, "axis_position_angle_deg"),
        0.03,
        "P (mean rotation pole)",
    );
    let sp = SunProvider::new().position(jd_utc).unwrap();
    let us = unit_radec(sp.ra_deg, sp.dec_deg);
    let ds = sp.radius_au * skyfix_ephemeris::body::AU_KM;
    let sun_from_moon = [
        us[0] * ds - mp.apparent_km[0],
        us[1] * ds - mp.apparent_km[1],
        us[2] * ds - mp.apparent_km[2],
    ];
    let fig_sun = frame.figure_selenographic(sun_from_moon);
    close(fig_sun.lon_deg, f(m, "sub_solar_lon_deg"), 0.006, "l0");
    close(fig_sun.lat_deg, f(m, "sub_solar_lat_deg"), 0.006, "b0");
    // In the mean-Earth frame the Sun's latitude moves by the tilt times cos l0.
    close(
        o.sub_solar.lat_deg,
        fig_sun.lat_deg - tilt * fig_sun.lon_deg.to_radians().cos(),
        0.0005,
        "b0 in the mean-Earth frame",
    );
    close(o.colongitude_deg, f(m, "colongitude_deg"), 0.006, "c0");
    // Geocentric: no diurnal part.
    assert_eq!(o.libration.diurnal_lon_deg, 0.0);
    assert!(!o.topocentric && o.alt_deg.is_none());
}

#[test]
fn the_orientation_model_matches_de440_from_1550_to_2650() {
    let fx = fixture("moon_libration.json");
    let cases = fx["frame_cases"].as_array().unwrap();
    assert!(cases.len() >= 300);
    let (mut worst_earth, mut worst_sun, mut worst_pa) = (0.0f64, 0.0f64, 0.0f64);
    let (mut worst_lon, mut worst_lat) = (0.0f64, 0.0f64);
    for c in cases {
        let jd_tt = f(c, "jd_tt");
        let lt = f(c, "moon_light_time_s") / 86_400.0;
        let frame = MoonFrame::at(jd_tt - lt);
        let um = unit_radec(f(c, "moon_ra_deg"), f(c, "moon_dec_deg"));
        let dm = f(c, "moon_distance_km");
        let us = unit_radec(f(c, "sun_ra_deg"), f(c, "sun_dec_deg"));
        let ds = f(c, "sun_distance_km");
        let moon = [um[0] * dm, um[1] * dm, um[2] * dm];
        let sun_from_moon = [
            us[0] * ds - moon[0],
            us[1] * ds - moon[1],
            us[2] * ds - moon[2],
        ];
        let e = frame.selenographic([-moon[0], -moon[1], -moon[2]]);
        let s = frame.selenographic(sun_from_moon);
        let d_earth = arc_deg(
            e.lat_deg,
            e.lon_deg,
            f(c, "sub_earth_lat_deg"),
            f(c, "sub_earth_lon_deg"),
        );
        let d_sun = arc_deg(
            s.lat_deg,
            s.lon_deg,
            f(c, "sub_solar_lat_deg"),
            f(c, "sub_solar_lon_deg"),
        );
        let pa = position_angle(um, frame.pole());
        let d_pa = wrap(pa - f(c, "pole_position_angle_deg")).abs();
        worst_lon = worst_lon.max(wrap(e.lon_deg - f(c, "sub_earth_lon_deg")).abs());
        worst_lat = worst_lat.max((e.lat_deg - f(c, "sub_earth_lat_deg")).abs());
        worst_earth = worst_earth.max(d_earth);
        worst_sun = worst_sun.max(d_sun);
        worst_pa = worst_pa.max(d_pa);
    }
    eprintln!(
        "orientation model vs DE440, {} instants 1550-2650: sub-Earth point {:.4} deg \
         (longitude {:.4}, latitude {:.4}), sub-solar point {:.4} deg, axis position \
         angle {:.4} deg",
        cases.len(),
        worst_earth,
        worst_lon,
        worst_lat,
        worst_sun,
        worst_pa
    );
    assert!(worst_earth < 0.05, "{worst_earth}");
    assert!(worst_sun < 0.05, "{worst_sun}");
    assert!(worst_pa < 0.05, "{worst_pa}");
}

#[test]
fn the_whole_chain_matches_skyfield_for_observers() {
    let fx = fixture("moon_libration.json");
    let cases = fx["observer_cases"].as_array().unwrap();
    let moon = MoonProvider::new();
    let sun = SunProvider::new();
    let mut checked = 0;
    let (mut w_obs, mut w_sun, mut w_pa, mut w_colong, mut w_km, mut w_sd) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut worst_diurnal = 0.0f64;
    for c in cases {
        let jd_utc = f(c, "jd_utc");
        let site = if c["observer"].is_null() {
            None
        } else {
            let o = &c["observer"];
            Some(Site {
                height_m: f(o, "height_m"),
                ..Site::new(f(o, "lat_deg"), f(o, "lon_deg"))
            })
        };
        let o = match moon_orientation(&moon, &sun, site.as_ref(), jd_utc) {
            Ok(o) => o,
            // Outside this build's Moon coverage: nothing to compare.
            Err(_) => continue,
        };
        checked += 1;
        w_obs = w_obs.max(arc_deg(
            o.sub_observer.lat_deg,
            o.sub_observer.lon_deg,
            f(c, "sub_observer_lat_deg"),
            f(c, "sub_observer_lon_deg"),
        ));
        w_sun = w_sun.max(arc_deg(
            o.sub_solar.lat_deg,
            o.sub_solar.lon_deg,
            f(c, "sub_solar_lat_deg"),
            f(c, "sub_solar_lon_deg"),
        ));
        w_pa = w_pa.max(wrap(o.axis_position_angle_deg - f(c, "pole_position_angle_deg")).abs());
        w_colong = w_colong.max(wrap(o.colongitude_deg - f(c, "colongitude_deg")).abs());
        w_km = w_km.max((o.distance_km - f(c, "distance_km")).abs());
        w_sd = w_sd.max((o.semidiameter_arcmin - f(c, "semidiameter_arcmin")).abs());
        worst_diurnal = worst_diurnal.max(
            o.libration
                .diurnal_lon_deg
                .abs()
                .max(o.libration.diurnal_lat_deg.abs()),
        );
        // The displayed libration is the sub-observer point.
        assert_eq!(o.libration.lon_deg, o.sub_observer.lon_deg);
        assert_eq!(o.topocentric, site.is_some());
    }
    eprintln!(
        "moon_orientation vs Skyfield + DE440 orientation, {checked} cases 1990-2060: \
         sub-observer point {w_obs:.4} deg, sub-solar point {w_sun:.4} deg, colongitude \
         {w_colong:.4} deg, axis position angle {w_pa:.4} deg, distance {w_km:.3} km, \
         semidiameter {w_sd:.5}'; largest diurnal libration seen {worst_diurnal:.3} deg"
    );
    assert!(checked >= 250, "only {checked} cases inside the coverage");
    assert!(w_obs < 0.05 && w_sun < 0.05 && w_pa < 0.05 && w_colong < 0.05);
    assert!(w_km < 1.0 && w_sd < 0.001, "{w_km} km, {w_sd}'");
    assert!(
        worst_diurnal > 0.5,
        "the diurnal libration must show up: {worst_diurnal}"
    );
}
