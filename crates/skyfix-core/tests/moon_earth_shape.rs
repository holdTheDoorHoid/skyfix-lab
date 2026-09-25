//! The Moon's Earth-shape term in every model altitude (CONVENTIONS 15.4).
//!
//! The chain reduces a Moon sight to the sphere's geocentric altitude; on the real
//! (WGS84) Earth a perfect sight then differs from the sphere's `Hc` by the Earth-shape
//! term, up to 0.24'. The term is therefore part of the model altitude wherever one is
//! evaluated: the solver, the intercept at the assumed position, predicted readings,
//! the noon and averaging methods, the misfit grid and the circles of position. Every
//! sight here is built on the real Earth: its `Ho` is `Hc_sphere + term` at the truth,
//! exactly what the chain gives for a perfect sextant reading there
//! (`crates/skyfix-ephemeris/tests/moon_planet_sights.rs` checks that against Skyfield).

use skyfix_core::geometry::{
    Point, altitude_azimuth, angular_distance, apply_tangent_step, geographic_position, tangent_row,
};
use skyfix_core::methods::{averaging, noon};
use skyfix_core::misfit::{self, MisfitOptions};
use skyfix_core::reduce::{DirectionSource, reduce_session_partitioned, to_sights};
use skyfix_core::sights::predict::predict_sextant;
use skyfix_core::sights::wgs84::{EarthShape, earth_shape_arcmin};
use skyfix_core::solver::solve;
use skyfix_core::types::{
    AltitudeKind, AveragingOptions, Clock, DrPosition, FixResult, GeocentricDirection, HorizonMode,
    Instrument, LatLon, Limb, NoonMethod, NoonSightOptions, Observation, Observer, SESSION_SCHEMA,
    Session, SessionMeta, SightObserver, SingleAltitudeMode, SolveOptions, Warning,
};
use skyfix_core::units::{SIDEREAL_RATE_DEG_PER_HOUR, norm_360, rad_to_m};

const T0: f64 = 2_461_314.5; // 2026-10-01T00:00:00Z
const MOON_HP: f64 = 58.0;

/// A synthetic sky: a Moon that moves as the Moon does (14.5 deg/h of GHA, 0.2 deg/h of
/// declination, HP 58') and three stars at the sidereal rate. Exact by construction, so
/// every miss below is the method's own.
struct Sky;

impl Sky {
    fn moon(jd: f64) -> GeocentricDirection {
        let h = (jd - T0) * 24.0;
        GeocentricDirection {
            gha_deg: norm_360(20.0 + 14.5 * h),
            dec_deg: 5.0 + 0.2 * h,
            semidiameter_arcmin: 15.8,
            horizontal_parallax_arcmin: MOON_HP,
        }
    }
    fn star(jd: f64, gha0: f64, dec: f64) -> GeocentricDirection {
        GeocentricDirection {
            gha_deg: norm_360(gha0 + SIDEREAL_RATE_DEG_PER_HOUR * (jd - T0) * 24.0),
            dec_deg: dec,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        }
    }
}

impl DirectionSource for Sky {
    fn name(&self) -> &str {
        "synthetic"
    }
    fn direction(&self, body: &str, jd: f64) -> Result<GeocentricDirection, String> {
        match body {
            "Moon" => Ok(Sky::moon(jd)),
            "Vega" => Ok(Sky::star(jd, 110.0, 38.8)),
            "Capella" => Ok(Sky::star(jd, 250.0, 46.0)),
            "Fomalhaut" => Ok(Sky::star(jd, 20.0, -29.6)),
            _ => Err(format!("{body} is not in this synthetic sky")),
        }
    }
    fn gha_rate_deg_per_hour(&self, body: &str) -> f64 {
        if body == "Moon" {
            14.5
        } else {
            SIDEREAL_RATE_DEG_PER_HOUR
        }
    }
}

/// The model altitude, degrees: the sphere's plus, for the Moon, the Earth-shape term.
fn model_altitude_deg(p: Point, d: &GeocentricDirection, moon: bool) -> f64 {
    let (h, _) = altitude_azimuth(p, d.gha_deg.to_radians(), d.dec_deg.to_radians());
    let term = if moon {
        earth_shape_arcmin(
            p.lat_deg(),
            p.lon_deg(),
            d.gha_deg,
            d.dec_deg,
            d.horizontal_parallax_arcmin,
        )
    } else {
        0.0
    };
    h.to_degrees() + term / 60.0
}

fn observation(id: &str, body: &str, jd: f64, ho_deg: f64) -> Observation {
    Observation {
        id: id.to_string(),
        body: body.to_string(),
        utc: skyfix_core::time::format_utc(jd),
        altitude_deg: ho_deg,
        altitude_kind: AltitudeKind::ObservedHo,
        sigma_arcmin: 0.2,
        limb: Limb::Center,
        horizon: None,
        geocentric: None,
        notes: String::new(),
    }
}

fn session(observations: Vec<Observation>, assumed: Option<LatLon>) -> Session {
    Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta::default(),
        observer: Observer {
            assumed_position: assumed,
            ..Observer::default()
        },
        instrument: Instrument::default(),
        clock: Clock::default(),
        observations,
    }
}

/// A Moon and three stars observed without error from `truth` on the real Earth.
fn real_earth_session(truth: Point, jd: f64) -> Session {
    let mut obs = Vec::new();
    for (i, body) in ["Moon", "Vega", "Capella", "Fomalhaut"].iter().enumerate() {
        let d = Sky.direction(body, jd).unwrap();
        let ho = model_altitude_deg(truth, &d, *body == "Moon");
        assert!(ho > 10.0, "{body} is too low at the truth: {ho}");
        obs.push(observation(&format!("obs-{}", i + 1), body, jd, ho));
    }
    session(
        obs,
        Some(LatLon {
            lat_deg: truth.lat_deg() + 0.3,
            lon_deg: truth.lon_deg() - 0.4,
        }),
    )
}

fn miss_m(a: LatLon, b: Point) -> f64 {
    rad_to_m(angular_distance(Point::from_deg(a.lat_deg, a.lon_deg), b))
}

fn unique(result: &FixResult) -> &skyfix_core::types::Fix {
    match result {
        FixResult::Unique { fix, .. } => fix,
        other => panic!("expected a unique fix, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

/// The apparent geocentric GHA and Dec, radians, of the direction with altitude `h_deg`
/// and azimuth `z_deg` at `p` (the sphere's, CONVENTIONS 3).
fn direction_at(p: Point, h_deg: f64, z_deg: f64) -> (f64, f64) {
    use skyfix_core::sights::wgs84::{Site, enu_from_alt_az};
    let u = Site::new(p.lat_deg(), p.lon_deg()).from_enu(enu_from_alt_az(h_deg, z_deg));
    (
        norm_360((-u[1]).atan2(u[0]).to_degrees()).to_radians(),
        u[2].clamp(-1.0, 1.0).asin(),
    )
}

#[test]
fn the_jacobian_row_stays_the_spheres() {
    // CONVENTIONS 15.4 and `solver::Model::normal`: the analytic row `[cos Zn, sin Zn]`
    // is kept for the Moon. Against a central difference of the full model altitude it is
    // out by what the term's own slope adds: 1.4 HP f (8.7e-5 of the main term's slope)
    // up to 45 deg of altitude and 2.9 HP f (1.8e-4) up to 70 deg, growing as tan h
    // toward the zenith (7e-4 at 85 deg), where the term's dependence on the Moon's
    // bearing turns quickly. The sphere alone matches its row to rounding.
    let shape = EarthShape::new(61.5).unwrap();
    let hp_f = (61.5f64 / 60.0).to_radians() * skyfix_core::sights::wgs84::WGS84_F;
    let d = 1e-6; // radians of arc, 6 m
    let bands = [(5.0, 45.0), (45.0, 70.0), (70.0, 80.0), (80.0, 85.0)];
    let mut worst = [0.0f64; 4];
    let mut worst_sphere = 0.0f64;
    for lat in (-80..=80).step_by(5) {
        for z in (0..360).step_by(10) {
            for h in (5..=85).step_by(5) {
                let p = Point::from_deg(lat as f64, -30.0);
                let (gha, dec) = direction_at(p, h as f64, z as f64);
                let (_, zn) = altitude_azimuth(p, gha, dec);
                let full = |q: Point| {
                    altitude_azimuth(q, gha, dec).0 + shape.term_rad(q.lat, q.lon, gha, dec)
                };
                let sphere = |q: Point| altitude_azimuth(q, gha, dec).0;
                let (cn, ce) = tangent_row(zn);
                let slope = |f: &dyn Fn(Point) -> f64| {
                    let n = (f(apply_tangent_step(p, d, 0.0)) - f(apply_tangent_step(p, -d, 0.0)))
                        / (2.0 * d);
                    let e = (f(apply_tangent_step(p, 0.0, d)) - f(apply_tangent_step(p, 0.0, -d)))
                        / (2.0 * d);
                    (n - cn).abs().max((e - ce).abs())
                };
                worst_sphere = worst_sphere.max(slope(&sphere));
                let band = bands
                    .iter()
                    .position(|(lo, hi)| (h as f64) >= *lo && (h as f64) <= *hi)
                    .unwrap();
                worst[band] = worst[band].max(slope(&full));
            }
        }
    }
    for ((lo, hi), w) in bands.iter().zip(&worst) {
        println!(
            "altitude {lo}-{hi} deg: analytic row vs numerical {w:.2e} = {:.2} HP f",
            w / hp_f
        );
    }
    println!("sphere alone: {worst_sphere:.1e}");
    assert!(worst_sphere < 1e-8, "{worst_sphere}");
    // Up to 45 deg within 1.5 HP f, up to 70 deg within 3 HP f (1.8e-4 of the main
    // term); above, the bearing term grows as tan h, still under a thousandth at 85 deg.
    assert!(worst[0] <= 1.5 * hp_f, "{worst:?}");
    assert!(worst[1] <= 3.0 * hp_f, "{worst:?}");
    assert!(worst[3] < 1e-3, "{worst:?}");
    assert!(
        worst[0] > 0.5 * hp_f,
        "the term should be visible: {worst:?}"
    );
}

#[test]
fn a_moon_and_star_fix_on_the_real_earth_lands_on_the_truth() {
    let truth = Point::from_deg(50.0, -30.0);
    let jd = T0 + 0.25 / 24.0;
    let s = real_earth_session(truth, jd);
    let (reduced, rejected) = reduce_session_partitioned(&s, &Sky);
    assert!(rejected.is_empty(), "{rejected:?}");
    let sights = to_sights(&reduced, &Sky);
    let moon: Vec<_> = sights.iter().map(|x| x.moon_hp_arcmin).collect();
    assert_eq!(moon, vec![Some(MOON_HP), None, None, None]);
    let options = SolveOptions {
        initializer: s.observer.assumed_position,
        ..SolveOptions::default()
    };
    let with = solve(&sights, &options);
    let fix = unique(&with);
    let miss = miss_m(fix.position, truth);
    // The Moon's residual is the full model's: zero.
    let moon_residual = fix.residuals[0].residual_arcmin;
    println!("real-Earth fix: {miss:.4} m from the truth, Moon residual {moon_residual:.2e}'");
    assert!(miss < 0.05, "{miss} m");
    assert!(moon_residual.abs() < 1e-6);

    // On the sphere alone (the term switched off) the same sights miss by the term.
    let mut sphere = sights.clone();
    sphere[0].moon_hp_arcmin = None;
    let without = unique(&solve(&sphere, &options)).position;
    let term = earth_shape_arcmin(
        50.0,
        -30.0,
        Sky::moon(jd).gha_deg,
        Sky::moon(jd).dec_deg,
        MOON_HP,
    );
    let miss_sphere = miss_m(without, truth);
    println!("sphere-only fix: {miss_sphere:.1} m (term at the truth {term:+.4}')");
    assert!(term.abs() > 0.05, "{term}");
    assert!(miss_sphere > 50.0, "{miss_sphere}");
}

#[test]
fn the_moons_circle_of_position_passes_through_the_fix() {
    let truth = Point::from_deg(50.0, -30.0);
    let jd = T0 + 0.25 / 24.0;
    let s = real_earth_session(truth, jd);
    let (reduced, _) = reduce_session_partitioned(&s, &Sky);
    let sights = to_sights(&reduced, &Sky);
    let result = solve(
        &sights,
        &SolveOptions {
            initializer: s.observer.assumed_position,
            ..SolveOptions::default()
        },
    );
    let FixResult::Unique { fix, circles, .. } = &result else {
        panic!("{result:?}")
    };
    let at = Point::from_deg(fix.position.lat_deg, fix.position.lon_deg);
    for (c, sight) in circles.iter().zip(&sights) {
        let gp = geographic_position(sight.gha_rad, sight.dec_rad);
        let off = (angular_distance(at, gp).to_degrees() - c.zenith_distance_deg) * 60.0;
        assert!(
            off.abs() < 1e-5,
            "{}: the fix is {off}' off its circle",
            c.id
        );
    }
    // The Moon's radius is not the sphere's `90 - Ho`: it carries the term.
    let moon = &circles[0];
    let sphere_z = 90.0 - sights[0].ho_rad.to_degrees();
    assert!(((moon.zenith_distance_deg - sphere_z) * 60.0).abs() > 0.05);
}

// ---------------------------------------------------------------------------
// The reduction at the assumed position, and the prediction
// ---------------------------------------------------------------------------

#[test]
fn the_intercept_at_the_assumed_position_includes_the_term() {
    let truth = Point::from_deg(50.0, -30.0);
    let jd = T0 + 0.25 / 24.0;
    let mut s = real_earth_session(truth, jd);
    // At the truth itself every intercept is zero, the Moon's included.
    s.observer.assumed_position = Some(LatLon {
        lat_deg: 50.0,
        lon_deg: -30.0,
    });
    let (reduced, _) = reduce_session_partitioned(&s, &Sky);
    let moon = &reduced[0];
    let d = Sky::moon(jd);
    let term = earth_shape_arcmin(50.0, -30.0, d.gha_deg, d.dec_deg, MOON_HP);
    assert_eq!(moon.horizontal_parallax_arcmin, MOON_HP);
    assert!((moon.earth_shape_arcmin.unwrap() - term).abs() < 1e-12);
    let (h, _) = altitude_azimuth(truth, d.gha_deg.to_radians(), d.dec_deg.to_radians());
    assert!((moon.hc_deg.unwrap() - (h.to_degrees() + term / 60.0)).abs() < 1e-12);
    for r in &reduced {
        assert!(
            r.intercept_nm.unwrap().abs() < 1e-7,
            "{}: {:?}",
            r.id,
            r.intercept_nm
        );
    }
    // Stars carry no term; without an assumed position nothing is computed.
    assert_eq!(reduced[1].earth_shape_arcmin, None);
    assert_eq!(reduced[1].horizontal_parallax_arcmin, 0.0);
    s.observer.assumed_position = None;
    let (reduced, _) = reduce_session_partitioned(&s, &Sky);
    assert_eq!(reduced[0].earth_shape_arcmin, None);
    assert_eq!(reduced[0].hc_deg, None);
}

#[test]
fn a_moon_direction_without_parallax_is_reduced_on_the_sphere_and_says_so() {
    let jd = T0;
    let mut d = Sky::moon(jd);
    d.horizontal_parallax_arcmin = 0.0;
    let mut obs = observation("m", "Moon", jd, 40.0);
    obs.geocentric = Some(d);
    let s = session(
        vec![obs],
        Some(LatLon {
            lat_deg: 40.0,
            lon_deg: -20.0,
        }),
    );
    let (reduced, _) = reduce_session_partitioned(&s, &Sky);
    assert_eq!(reduced[0].earth_shape_arcmin, None);
    assert!(
        reduced[0].warnings.iter().any(|w| matches!(
            w,
            Warning::Other { message } if message.contains("Earth-shape term")
        )),
        "{:?}",
        reduced[0].warnings
    );
    assert_eq!(to_sights(&reduced, &Sky)[0].moon_hp_arcmin, None);
}

#[test]
fn a_predicted_moon_reading_is_the_real_earths_and_reduces_back() {
    let observer = SightObserver {
        lat_deg: 54.7,
        lon_deg: 0.0,
        height_of_eye_m: 3.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
    };
    let jd = T0;
    let d = Sky::moon(jd);
    for limb in [Limb::Lower, Limb::Upper] {
        let p = predict_sextant(
            &observer,
            &Instrument::default(),
            "Moon",
            limb,
            jd,
            d,
            "synthetic",
        )
        .unwrap();
        let term = earth_shape_arcmin(54.7, 0.0, d.gha_deg, d.dec_deg, MOON_HP);
        assert!((p.earth_shape_arcmin - term).abs() < 1e-12);
        let (h, _) = altitude_azimuth(
            Point::from_deg(54.7, 0.0),
            d.gha_deg.to_radians(),
            d.dec_deg.to_radians(),
        );
        assert!((p.hc_deg - (h.to_degrees() + term / 60.0)).abs() < 1e-12);
        // Reducing the reading lands on this Hc, as it always has.
        assert!((p.corrections.ho_deg - p.hc_deg).abs() < 1e-11);
    }
    // A star has no term.
    let star = predict_sextant(
        &observer,
        &Instrument {
            horizon: HorizonMode::Sea,
            ..Instrument::default()
        },
        "Vega",
        Limb::Center,
        jd,
        Sky::star(jd, 10.0, 38.8),
        "synthetic",
    )
    .unwrap();
    assert_eq!(star.earth_shape_arcmin, 0.0);
}

// ---------------------------------------------------------------------------
// The misfit grid
// ---------------------------------------------------------------------------

#[test]
fn the_misfit_grid_maps_the_same_model_as_the_solver() {
    let truth = Point::from_deg(50.0, -30.0);
    let jd = T0 + 0.25 / 24.0;
    let s = real_earth_session(truth, jd);
    let (reduced, _) = reduce_session_partitioned(&s, &Sky);
    let sights = to_sights(&reduced, &Sky);
    let options = MisfitOptions::default();
    // At the truth the misfit is zero; one mile north it is the solver's chi2 there.
    let at_truth = misfit::value_at(
        &sights,
        &options,
        LatLon {
            lat_deg: 50.0,
            lon_deg: -30.0,
        },
    )
    .unwrap();
    assert!(at_truth < 1e-12, "{at_truth}");
    let north = Point::from_deg(50.0 + 1.0 / 60.0, -30.0);
    let by_hand: f64 = sights
        .iter()
        .map(|x| {
            let d = GeocentricDirection {
                gha_deg: x.gha_rad.to_degrees(),
                dec_deg: x.dec_rad.to_degrees(),
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: x.moon_hp_arcmin.unwrap_or(0.0),
            };
            let r = (x.ho_rad.to_degrees()
                - model_altitude_deg(north, &d, x.moon_hp_arcmin.is_some()))
            .to_radians()
                / x.sigma_rad;
            r * r
        })
        .sum();
    let node = misfit::value_at(
        &sights,
        &options,
        LatLon {
            lat_deg: north.lat_deg(),
            lon_deg: north.lon_deg(),
        },
    )
    .unwrap();
    assert!(
        (node - by_hand).abs() < 1e-9 * by_hand.max(1.0),
        "{node} vs {by_hand}"
    );
    // A grid round the truth has its best point there.
    let bounds = misfit::GridBounds {
        south_deg: 49.9,
        north_deg: 50.1,
        west_deg: -30.15,
        east_deg: -29.85,
    };
    let g = misfit::grid(&sights, &options, &bounds, 41, 41).unwrap();
    let best = Point::from_deg(g.min.lat_deg, g.min.lon_deg);
    assert!(rad_to_m(angular_distance(best, truth)) < 0.05);
}

// ---------------------------------------------------------------------------
// The noon sight and averaging
// ---------------------------------------------------------------------------

/// The instant the synthetic Moon crosses the meridian of `lon_deg`.
fn moon_passage(lon_deg: f64) -> f64 {
    // LHA = 20 + 14.5 h + lon = 0 (mod 360).
    let h = norm_360(-(20.0 + lon_deg)) / 14.5;
    T0 + h / 24.0
}

fn moon_run(truth: Point, minutes: &[f64]) -> (Session, f64) {
    let t_pass = moon_passage(truth.lon_deg());
    let obs = minutes
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let jd = t_pass + m / 1440.0;
            observation(
                &format!("m{i}"),
                "Moon",
                jd,
                model_altitude_deg(truth, &Sky::moon(jd), true),
            )
        })
        .collect();
    (session(obs, None), t_pass)
}

fn dr_near(truth: Point) -> Option<DrPosition> {
    Some(DrPosition {
        lat_deg: truth.lat_deg() + 4.0 / 60.0,
        lon_deg: truth.lon_deg() - 3.0 / 60.0,
        sigma_nm: Some(10.0),
    })
}

#[test]
fn a_moon_noon_latitude_on_the_real_earth_is_exact() {
    // On the meridian the Earth-shape term is the whole of a sphere-reduced latitude's
    // error: 0.21' at 50 N with the Moon 45 deg high toward the equator.
    let truth = Point::from_deg(50.0, -30.0);
    let minutes: Vec<f64> = (-10..=10).map(|k| k as f64 * 1.5).collect();
    let (s, t_pass) = moon_run(truth, &minutes);
    let d = Sky::moon(t_pass);
    let term = earth_shape_arcmin(50.0, -30.0, d.gha_deg, d.dec_deg, MOON_HP);
    println!("Earth-shape term on the meridian: {term:+.4}'");
    assert!(term > 0.2, "{term}");
    let r = noon::noon_sight(
        &s,
        &Sky,
        &NoonSightOptions {
            dr: dr_near(truth),
            ..NoonSightOptions::default()
        },
    )
    .unwrap();
    assert_eq!(r.method, NoonMethod::CurveFit);
    let err = (r.latitude.lat_deg - 50.0) * 60.0;
    println!("Moon noon curve fit: latitude off by {err:.2e}'");
    assert!(err.abs() < 0.001, "{err}'");
    // The meridian altitude is an Ho: the sphere's plus the term. The rule says so, and
    // the zenith distance that gives the latitude is the sphere's.
    let sphere_h0 = 90.0 - (50.0 - r.declination_deg);
    assert!(((r.meridian_altitude_deg - sphere_h0) * 60.0 - term).abs() < 0.001);
    assert!(
        ((r.zenith_distance_deg - (r.latitude.lat_deg - r.declination_deg)) * 60.0).abs() < 1e-9
    );
    assert!(
        r.latitude_rule.contains("Earth's-shape term"),
        "{}",
        r.latitude_rule
    );
    assert!(r.residuals.iter().all(|x| x.residual_arcmin.abs() < 1e-4));

    // One altitude taken at the peak (found to a tenth of a second), with the DR on the
    // right meridian: the single-maximum rule takes the declination at the passage the
    // DR predicts, so a DR 3' off in longitude would cost 0.04' here on its own.
    let h_at = |m: f64| model_altitude_deg(truth, &Sky::moon(t_pass + m / 1440.0), true);
    let peak = (-6000..=6000)
        .map(|k| k as f64 / 600.0)
        .max_by(|a, b| h_at(*a).total_cmp(&h_at(*b)))
        .unwrap();
    let (one, _) = moon_run(truth, &[peak]);
    let max = noon::noon_sight(
        &one,
        &Sky,
        &NoonSightOptions {
            dr: Some(DrPosition {
                lat_deg: 50.1,
                lon_deg: -30.0,
                sigma_nm: Some(5.0),
            }),
            ..NoonSightOptions::default()
        },
    )
    .unwrap();
    assert_eq!(max.method, NoonMethod::MaximumAltitude);
    let err_max = (max.latitude.lat_deg - 50.0) * 60.0;
    let (one_off, _) = moon_run(truth, &[-8.0]);
    let ex = noon::noon_sight(
        &one_off,
        &Sky,
        &NoonSightOptions {
            dr: Some(DrPosition {
                lat_deg: 50.1,
                lon_deg: -30.0,
                sigma_nm: Some(5.0),
            }),
            single_altitude: SingleAltitudeMode::ExMeridian,
            ..NoonSightOptions::default()
        },
    )
    .unwrap();
    let err_ex = (ex.latitude.lat_deg - 50.0) * 60.0;
    println!("single maximum off by {err_max:.2e}', ex-meridian off by {err_ex:.2e}'");
    // The single maximum's remaining 0.001' is its own: the peak-to-meridian step a^2/4k
    // is taken from the curve at the DR, 6' north of the truth.
    assert!(err_max.abs() < 0.005, "{err_max}'");
    assert!(err_ex.abs() < 0.001, "{err_ex}'");
    for r in [&max, &ex] {
        assert!(
            r.latitude_rule.contains("Earth's-shape term"),
            "{}",
            r.latitude_rule
        );
    }
}

#[test]
fn a_moon_run_averages_to_the_real_earths_altitude() {
    let truth = Point::from_deg(50.0, -30.0);
    let t_mid = T0 + 3.0 / 24.0;
    let obs: Vec<Observation> = (0..7)
        .map(|k| {
            let jd = t_mid + (k as f64 - 3.0) * 0.5 / 1440.0;
            observation(
                &format!("a{k}"),
                "Moon",
                jd,
                model_altitude_deg(truth, &Sky::moon(jd), true),
            )
        })
        .collect();
    let s = session(obs, None);
    let a = averaging::average_sights(
        &s,
        &Sky,
        &AveragingOptions {
            dr: Some(DrPosition {
                lat_deg: 50.0,
                lon_deg: -30.0,
                sigma_nm: None,
            }),
            ..AveragingOptions::default()
        },
    )
    .unwrap();
    let truth_h = model_altitude_deg(truth, &Sky::moon(a.jd_utc), true);
    let err = (a.ho_deg - truth_h) * 60.0;
    println!("Moon run averaged: {err:.2e}' from the model altitude at the truth");
    assert!(err.abs() < 1e-4, "{err}'");
}

#[test]
fn a_misfit_grid_with_moon_sights_keeps_its_budget() {
    // The Earth-shape term is evaluated at every node for a Moon sight. Ten sights round
    // Philadelphia, one of them the Moon on the real Earth, 200 x 200 nodes: the 30 ms
    // budget of the misfit grid holds in an optimised build (`cargo test --release -p
    // skyfix-core --test moon_earth_shape -- --nocapture`); a debug build prints only.
    use skyfix_core::types::Sight;
    let truth = Point::from_deg(39.9526, -75.1652);
    let sights: Vec<Sight> = (0..10)
        .map(|k| {
            let zn = (17.0 + 36.0 * k as f64).to_radians();
            let alt = 25.0 + (k * 37 % 41) as f64;
            let gp = skyfix_core::geometry::destination(truth, zn, (90.0 - alt).to_radians());
            let (gha, dec) = (norm_360(-gp.lon_deg()).to_radians(), gp.lat);
            let moon = k == 0;
            let hp = moon.then_some(58.0);
            let term = hp.map_or(0.0, |hp| {
                EarthShape::new(hp)
                    .unwrap()
                    .term_rad(truth.lat, truth.lon, gha, dec)
            });
            Sight {
                id: format!("s{k}"),
                body: if moon { "Moon" } else { "star" }.to_string(),
                gha_rad: gha,
                dec_rad: dec,
                ho_rad: alt.to_radians() + term,
                sigma_rad: (1.0f64 / 60.0).to_radians(),
                gha_rate_rad_per_s: 0.0,
                moon_hp_arcmin: hp,
            }
        })
        .collect();
    let options = SolveOptions::default();
    let result = solve(&sights, &options);
    assert!(miss_m(unique(&result).position, truth) < 0.05);
    let bounds = misfit::default_bounds(&sights, &result, None)
        .unwrap()
        .bounds;
    let time = |sights: &[Sight]| {
        let mut ms: Vec<f64> = (0..9)
            .map(|_| {
                let t = std::time::Instant::now();
                let g = misfit::grid_for_solve(sights, &options, &result, Some(bounds), 200, 200)
                    .unwrap();
                std::hint::black_box(&g);
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        ms.sort_by(f64::total_cmp);
        ms[0]
    };
    let with_moon = time(&sights);
    let mut plain = sights.clone();
    for s in &mut plain {
        s.moon_hp_arcmin = None;
    }
    let without = time(&plain);
    println!(
        "misfit grid 200 x 200, 10 sights of which one the Moon: {with_moon:.2} ms with the \
         term, {without:.2} ms without ({} build)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    if !cfg!(debug_assertions) {
        assert!(with_moon <= 30.0, "{with_moon} ms");
    }
}
