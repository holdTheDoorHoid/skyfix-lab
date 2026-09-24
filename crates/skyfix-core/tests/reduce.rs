//! CONVENTIONS sections 3-6: observation -> reduced sight -> solver input.

use approx::assert_relative_eq;
use skyfix_core::SkyfixError;
use skyfix_core::geometry::{self, Point};
use skyfix_core::reduce::{
    DirectionSource, SuppliedOnly, reduce_observation, reduce_session, to_sights,
};
use skyfix_core::time;
use skyfix_core::types::{
    AltitudeKind, GeocentricDirection, HorizonMode, Instrument, LatLon, Limb, Observation,
    Observer, SESSION_SCHEMA, Session, Warning,
};
use skyfix_core::units;
use std::cell::RefCell;

const UTC: &str = "2026-10-01T01:30:00Z";

fn session(observations: Vec<Observation>) -> Session {
    Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: Default::default(),
        observer: Observer {
            height_of_eye_m: 2.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
            assumed_position: Some(LatLon {
                lat_deg: 39.9526,
                lon_deg: -75.1652,
            }),
            assumed_position_role: Default::default(),
        },
        instrument: Instrument {
            name: "test".to_string(),
            index_correction_arcmin: -2.0,
            horizon: HorizonMode::Sea,
        },
        clock: Default::default(),
        observations,
    }
}

fn observation(
    id: &str,
    body: &str,
    altitude_deg: f64,
    direction: Option<GeocentricDirection>,
) -> Observation {
    Observation {
        id: id.to_string(),
        body: body.to_string(),
        utc: UTC.to_string(),
        altitude_deg,
        altitude_kind: AltitudeKind::SextantHs,
        sigma_arcmin: 1.0,
        limb: Limb::Center,
        horizon: None,
        geocentric: direction,
        notes: String::new(),
    }
}

fn direction(gha_deg: f64, dec_deg: f64) -> Option<GeocentricDirection> {
    Some(GeocentricDirection {
        gha_deg,
        dec_deg,
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: 0.0,
    })
}

/// A provider that answers for one body and records the Julian dates it was asked about.
struct FakeProvider {
    body: &'static str,
    dir: GeocentricDirection,
    asked: RefCell<Vec<f64>>,
}

impl DirectionSource for FakeProvider {
    fn name(&self) -> &str {
        "fake-provider"
    }
    fn direction(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, String> {
        self.asked.borrow_mut().push(jd_utc);
        if body.eq_ignore_ascii_case(self.body) {
            Ok(self.dir)
        } else {
            Err(format!(
                "fake-provider covers {:?} only (coverage: one body, one instant)",
                self.body
            ))
        }
    }
    fn gha_rate_deg_per_hour(&self, body: &str) -> f64 {
        if body.eq_ignore_ascii_case("sun") {
            units::SOLAR_RATE_DEG_PER_HOUR
        } else {
            units::SIDEREAL_RATE_DEG_PER_HOUR
        }
    }
}

// ---------------------------------------------------------------------------

/// Worked reduction. Assumed position 39.9526 N, 75.1652 W; Vega supplied at
/// GHA 122.7, Dec 20.0; Hs 45 00.0' with IC -2.0' and 2 m of height of eye.
///
/// ```text
/// Ho  = 44.908 559 040 215 49 deg   (see tests/corrections.rs, same chain)
/// LHA = GHA + lon_east = 122.7 - 75.1652 = 47.534 8 deg
/// Hc  = asin(sin 39.9526 sin 20 + cos 39.9526 cos 20 cos 47.534 8) = 44.907 587 277 466 8 deg
/// Zn  = atan2(-cos 20 sin LHA, cos 39.9526 sin 20 - sin 39.9526 cos 20 cos LHA) = 258.168 501 3 deg
/// a   = (Ho - Hc) * 60 = +0.058 305 764 9 NM, toward the body
/// ```
#[test]
fn worked_reduction_at_an_assumed_position() {
    let s = session(vec![observation(
        "obs-1",
        "Vega",
        45.0,
        direction(122.7, 20.0),
    )]);
    let r = reduce_observation(&s, &s.observations[0], &SuppliedOnly).unwrap();

    assert_eq!(r.id, "obs-1");
    assert_eq!(r.body, "Vega");
    assert_eq!(r.utc, UTC);
    assert_eq!(r.direction_source, "supplied");
    assert_relative_eq!(r.jd_utc, time::parse_utc(UTC).unwrap(), epsilon = 1e-12);
    assert_relative_eq!(r.gha_deg, 122.7, epsilon = 1e-12);
    assert_relative_eq!(r.dec_deg, 20.0, epsilon = 1e-12);
    assert_relative_eq!(r.ho_deg, 44.908_559_040_215_49, epsilon = 1e-12);
    assert_eq!(r.sigma_arcmin, 1.0);

    // Hand-computed values.
    assert_relative_eq!(r.hc_deg.unwrap(), 44.907_587_277_466_796, epsilon = 1e-9);
    assert_relative_eq!(r.zn_deg.unwrap(), 258.168_501_302_450_35, epsilon = 1e-9);
    assert_relative_eq!(
        r.intercept_nm.unwrap(),
        0.058_305_764_921_868_79,
        epsilon = 1e-7
    );

    // The same numbers straight out of the shared kernel, and again from raw spherical
    // trigonometry written out here, so the reducer cannot quietly use its own formula.
    let (hc_rad, zn_rad) = geometry::altitude_azimuth(
        Point::from_deg(39.9526, -75.1652),
        122.7f64.to_radians(),
        20.0f64.to_radians(),
    );
    assert_relative_eq!(r.hc_deg.unwrap(), hc_rad.to_degrees(), epsilon = 1e-12);
    assert_relative_eq!(r.zn_deg.unwrap(), zn_rad.to_degrees(), epsilon = 1e-12);

    let (phi, dec, lha) = (
        39.9526f64.to_radians(),
        20.0f64.to_radians(),
        (122.7f64 - 75.1652).to_radians(),
    );
    let hc = (phi.sin() * dec.sin() + phi.cos() * dec.cos() * lha.cos()).asin();
    let zn = (-dec.cos() * lha.sin())
        .atan2(phi.cos() * dec.sin() - phi.sin() * dec.cos() * lha.cos())
        .to_degrees()
        .rem_euclid(360.0);
    assert_relative_eq!(r.hc_deg.unwrap(), hc.to_degrees(), epsilon = 1e-12);
    assert_relative_eq!(r.zn_deg.unwrap(), zn, epsilon = 1e-12);

    // Intercept is (Ho - Hc) in arcminutes, 1' = 1 NM, positive toward the body.
    assert_relative_eq!(
        r.intercept_nm.unwrap(),
        (r.ho_deg - r.hc_deg.unwrap()) * 60.0,
        epsilon = 1e-12
    );
    assert!(
        r.intercept_nm.unwrap() > 0.0,
        "Ho above Hc means toward the body"
    );
}

#[test]
fn a_sight_further_from_the_body_gives_a_negative_intercept() {
    // Same geometry, 10.0' less altitude: the intercept must move 10 NM away.
    let a = session(vec![observation("a", "Vega", 45.0, direction(122.7, 20.0))]);
    let b = session(vec![observation(
        "b",
        "Vega",
        45.0 - 10.0 / 60.0,
        direction(122.7, 20.0),
    )]);
    let ra = reduce_observation(&a, &a.observations[0], &SuppliedOnly).unwrap();
    let rb = reduce_observation(&b, &b.observations[0], &SuppliedOnly).unwrap();
    assert!(rb.intercept_nm.unwrap() < 0.0);
    // Refraction changes slightly with altitude, so allow a hundredth of a mile.
    assert_relative_eq!(
        ra.intercept_nm.unwrap() - rb.intercept_nm.unwrap(),
        10.0,
        epsilon = 0.01
    );
}

#[test]
fn without_an_assumed_position_there_is_no_hc_zn_or_intercept() {
    let mut s = session(vec![observation(
        "obs-1",
        "Vega",
        45.0,
        direction(122.7, 20.0),
    )]);
    s.observer.assumed_position = None;
    let r = reduce_observation(&s, &s.observations[0], &SuppliedOnly).unwrap();
    assert!(r.hc_deg.is_none());
    assert!(r.zn_deg.is_none());
    assert!(r.intercept_nm.is_none());
    // The correction chain still ran.
    assert_relative_eq!(r.ho_deg, 44.908_559_040_215_49, epsilon = 1e-12);
}

#[test]
fn a_supplied_direction_wins_over_the_provider_and_says_so() {
    let provider = FakeProvider {
        body: "Vega",
        dir: GeocentricDirection {
            gha_deg: 1.0,
            dec_deg: 2.0,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        },
        asked: RefCell::new(Vec::new()),
    };
    let s = session(vec![observation(
        "obs-1",
        "Vega",
        45.0,
        direction(122.7, 20.0),
    )]);
    let r = reduce_observation(&s, &s.observations[0], &provider).unwrap();
    assert_eq!(r.direction_source, "supplied");
    assert_relative_eq!(r.gha_deg, 122.7, epsilon = 1e-12);
    assert!(
        provider.asked.borrow().is_empty(),
        "the provider must not even be consulted"
    );
    assert!(
        r.warnings
            .iter()
            .any(|w| matches!(w, Warning::SuppliedDirectionUsed { id } if id == "obs-1")),
        "{:?}",
        r.warnings
    );
}

#[test]
fn the_provider_is_used_and_named_when_the_record_has_no_direction() {
    let provider = FakeProvider {
        body: "Vega",
        dir: GeocentricDirection {
            gha_deg: 122.7,
            dec_deg: 20.0,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        },
        asked: RefCell::new(Vec::new()),
    };
    let s = session(vec![observation("obs-1", "Vega", 45.0, None)]);
    let r = reduce_observation(&s, &s.observations[0], &provider).unwrap();
    assert_eq!(r.direction_source, "fake-provider");
    assert_relative_eq!(r.gha_deg, 122.7, epsilon = 1e-12);
    assert!(
        !r.warnings
            .iter()
            .any(|w| matches!(w, Warning::SuppliedDirectionUsed { .. }))
    );
}

#[test]
fn the_chronometer_correction_shifts_the_time_the_provider_is_asked_about() {
    let provider = FakeProvider {
        body: "Vega",
        dir: GeocentricDirection {
            gha_deg: 122.7,
            dec_deg: 20.0,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        },
        asked: RefCell::new(Vec::new()),
    };
    let mut s = session(vec![observation("obs-1", "Vega", 45.0, None)]);
    s.clock.correction_s = 30.0;
    let r = reduce_observation(&s, &s.observations[0], &provider).unwrap();

    let expected = time::parse_utc(UTC).unwrap() + 30.0 / 86_400.0;
    assert_relative_eq!(r.jd_utc, expected, epsilon = 1e-12);
    assert_relative_eq!(provider.asked.borrow()[0], expected, epsilon = 1e-12);
    // The recorded timestamp is reported unchanged; only the derived jd moves.
    assert_eq!(r.utc, UTC);
}

#[test]
fn a_body_with_no_direction_is_rejected_with_the_providers_reason() {
    let s = session(vec![observation("obs-1", "Betelgeuse", 45.0, None)]);
    match reduce_observation(&s, &s.observations[0], &SuppliedOnly) {
        Err(SkyfixError::NoDirection { id, reason }) => {
            assert_eq!(id, "obs-1");
            assert!(reason.contains("supply gha_deg/dec_deg"), "{reason}");
        }
        other => panic!("expected NoDirection, got {other:?}"),
    }

    let provider = FakeProvider {
        body: "Vega",
        dir: GeocentricDirection {
            gha_deg: 0.0,
            dec_deg: 0.0,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        },
        asked: RefCell::new(Vec::new()),
    };
    match reduce_observation(&s, &s.observations[0], &provider) {
        Err(SkyfixError::NoDirection { reason, .. }) => {
            assert!(reason.contains("coverage"), "{reason}");
        }
        other => panic!("expected NoDirection, got {other:?}"),
    }
}

#[test]
fn a_bad_timestamp_is_rejected_before_anything_else() {
    let mut obs = observation("obs-1", "Vega", 45.0, direction(122.7, 20.0));
    obs.utc = "2026-10-01 01:30:00".to_string();
    let s = session(vec![obs]);
    match reduce_observation(&s, &s.observations[0], &SuppliedOnly) {
        Err(SkyfixError::InvalidTimestamp(t)) => assert_eq!(t, "2026-10-01 01:30:00"),
        other => panic!("expected InvalidTimestamp, got {other:?}"),
    }
}

#[test]
fn a_non_finite_or_out_of_range_direction_is_rejected() {
    let s = session(vec![observation(
        "obs-1",
        "X",
        45.0,
        direction(f64::NAN, 20.0),
    )]);
    assert!(matches!(
        reduce_observation(&s, &s.observations[0], &SuppliedOnly),
        Err(SkyfixError::NonFinite { .. })
    ));

    let s = session(vec![observation("obs-1", "X", 45.0, direction(10.0, 95.0))]);
    match reduce_observation(&s, &s.observations[0], &SuppliedOnly) {
        Err(SkyfixError::AngleOutOfRange { field, value, .. }) => {
            assert!(field.contains("dec_deg"), "{field}");
            assert_eq!(value, 95.0);
        }
        other => panic!("expected AngleOutOfRange, got {other:?}"),
    }
}

#[test]
fn an_unnormalised_gha_from_a_provider_is_normalised_for_the_report() {
    // 482.7 deg and -237.3 deg are both 122.7 deg; the report uses [0, 360).
    for gha in [482.7, -237.3] {
        let provider = FakeProvider {
            body: "Vega",
            dir: GeocentricDirection {
                gha_deg: gha,
                dec_deg: 20.0,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            },
            asked: RefCell::new(Vec::new()),
        };
        let s = session(vec![observation("obs-1", "Vega", 45.0, None)]);
        let r = reduce_observation(&s, &s.observations[0], &provider).unwrap();
        assert_relative_eq!(r.gha_deg, 122.7, epsilon = 1e-9);
        assert_relative_eq!(r.hc_deg.unwrap(), 44.907_587_277_466_796, epsilon = 1e-9);
    }
}

#[test]
fn one_rejected_sight_does_not_discard_the_others() {
    let mut bad = observation("obs-bad", "Vega", 45.0, direction(122.7, 20.0));
    bad.sigma_arcmin = 0.0;
    let s = session(vec![
        observation("obs-1", "Vega", 45.0, direction(122.7, 20.0)),
        bad,
        observation("obs-3", "Vega", 30.0, direction(122.7, 20.0)),
    ]);
    let results = reduce_session(&s, &SuppliedOnly);
    assert_eq!(results.len(), 3);
    assert!(results[0].is_ok());
    assert!(matches!(results[1], Err(SkyfixError::InvalidField { .. })));
    assert!(results[2].is_ok());
    // Results stay in observation order so the caller can line them up with the input.
    assert_eq!(results[0].as_ref().unwrap().id, "obs-1");
    assert_eq!(results[2].as_ref().unwrap().id, "obs-3");
}

#[test]
fn to_sights_converts_to_radians_and_carries_the_gha_rate() {
    let s = session(vec![
        observation("obs-1", "Vega", 45.0, direction(122.7, 20.0)),
        observation("obs-2", "Sun", 30.0, direction(10.0, -5.0)),
    ]);
    let reduced: Vec<_> = reduce_session(&s, &SuppliedOnly)
        .into_iter()
        .map(|r| r.unwrap())
        .collect();
    let sights = to_sights(&reduced, &SuppliedOnly);
    assert_eq!(sights.len(), 2);

    assert_eq!(sights[0].id, "obs-1");
    assert_relative_eq!(sights[0].gha_rad, 122.7f64.to_radians(), epsilon = 1e-15);
    assert_relative_eq!(sights[0].dec_rad, 20.0f64.to_radians(), epsilon = 1e-15);
    assert_relative_eq!(
        sights[0].ho_rad,
        reduced[0].ho_deg.to_radians(),
        epsilon = 1e-15
    );
    assert_relative_eq!(sights[0].sigma_rad, units::ARCMIN, epsilon = 1e-18);

    // Sidereal for a star, mean solar for the Sun, both per second.
    assert_relative_eq!(
        sights[0].gha_rate_rad_per_s,
        units::SIDEREAL_RATE_DEG_PER_HOUR.to_radians() / 3600.0,
        epsilon = 1e-18
    );
    assert_relative_eq!(
        sights[1].gha_rate_rad_per_s,
        units::SOLAR_RATE_DEG_PER_HOUR.to_radians() / 3600.0,
        epsilon = 1e-18
    );
    // One arcminute of altitude noise is one nautical mile of position noise.
    assert_relative_eq!(units::rad_to_nm(sights[0].sigma_rad), 1.0, epsilon = 1e-12);
}

#[test]
fn the_per_observation_horizon_overrides_the_instrument() {
    let mut obs = observation("obs-1", "Vega", 80.0, direction(122.7, 20.0));
    obs.horizon = Some(HorizonMode::ArtificialReflected);
    let s = session(vec![obs]);
    let r = reduce_observation(&s, &s.observations[0], &SuppliedOnly).unwrap();
    // Halved despite the session instrument saying "sea", and no dip taken.
    assert!(r.ho_deg < 40.0, "Ho = {}", r.ho_deg);
    let halving = r
        .corrections
        .steps
        .iter()
        .find(|s| s.kind == skyfix_core::types::CorrectionKind::ArtificialHorizonHalving)
        .unwrap();
    assert!(halving.applied);
    assert_eq!(r.sigma_arcmin, 0.5);
}

#[test]
fn the_sun_is_reduced_with_semidiameter_and_parallax() {
    let mut obs = observation(
        "obs-sun",
        "sun",
        30.0,
        Some(GeocentricDirection {
            gha_deg: 45.0,
            dec_deg: -3.0,
            semidiameter_arcmin: 16.0,
            horizontal_parallax_arcmin: 0.15,
        }),
    );
    obs.limb = Limb::Lower;
    let mut s = session(vec![obs]);
    s.observer.height_of_eye_m = 0.0;
    s.instrument.index_correction_arcmin = 0.0;
    let r = reduce_observation(&s, &s.observations[0], &SuppliedOnly).unwrap();
    // Same chain as tests/corrections.rs: 30 deg lower limb -> 30.240 209 894 616 91.
    assert_relative_eq!(r.ho_deg, 30.240_209_894_616_91, epsilon = 1e-12);
}

#[test]
fn reduction_warnings_include_the_correction_warnings() {
    let s = session(vec![observation(
        "obs-1",
        "Vega",
        3.0,
        direction(122.7, 20.0),
    )]);
    let r = reduce_observation(&s, &s.observations[0], &SuppliedOnly).unwrap();
    assert!(
        r.warnings
            .iter()
            .any(|w| matches!(w, Warning::LowAltitudeRefraction { .. })),
        "{:?}",
        r.warnings
    );
    assert!(
        r.corrections
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::LowAltitudeRefraction { .. }))
    );
    assert!(
        r.sigma_arcmin > 1.0,
        "sigma should be inflated: {}",
        r.sigma_arcmin
    );
}
