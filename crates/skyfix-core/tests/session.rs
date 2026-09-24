//! CONVENTIONS section 10: session validation and the CSV round-trip.

use skyfix_core::SkyfixError;
use skyfix_core::session::{from_csv, parse_session, to_csv, validate};
use skyfix_core::types::{
    AltitudeKind, AssumedPositionRole, Clock, CorrectionKind, GeocentricDirection, HorizonMode,
    Instrument, LatLon, Limb, Observation, Observer, SESSION_SCHEMA, Session, SessionKind,
    SessionMeta, Warning,
};

/// A session that exercises every field of the model, including both optional blocks.
const EVERY_FIELD_JSON: &str = include_str!("data/every_field.session.json");
/// The same session as CSV. A format snapshot: if the dialect changes, this file changes
/// with it, in one obvious place.
const EVERY_FIELD_CSV: &str = include_str!("data/every_field.session.csv");

const KNOWN: [&str; 3] = ["Vega", "Sun", "Polaris"];

fn observation(id: &str, body: &str, utc: &str, altitude_deg: f64) -> Observation {
    Observation {
        id: id.to_string(),
        body: body.to_string(),
        utc: utc.to_string(),
        altitude_deg,
        altitude_kind: AltitudeKind::SextantHs,
        sigma_arcmin: 1.0,
        limb: Limb::Center,
        horizon: None,
        geocentric: None,
        notes: String::new(),
    }
}

fn with_direction(mut obs: Observation) -> Observation {
    obs.geocentric = Some(GeocentricDirection {
        gha_deg: 120.0,
        dec_deg: 20.0,
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: 0.0,
    });
    obs
}

fn session(observations: Vec<Observation>) -> Session {
    Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta::default(),
        observer: Observer::default(),
        instrument: Instrument::default(),
        clock: Clock::default(),
        observations,
    }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

#[test]
fn parses_the_every_field_fixture() {
    let (s, warnings) = parse_session(EVERY_FIELD_JSON).unwrap();
    assert_eq!(s.schema, SESSION_SCHEMA);
    assert_eq!(s.meta.kind, SessionKind::Real);
    assert_eq!(s.observer.height_of_eye_m, 2.5);
    assert_eq!(
        s.observer.assumed_position,
        Some(LatLon {
            lat_deg: 39.9526,
            lon_deg: -75.1652
        })
    );
    assert_eq!(
        s.observer.assumed_position_role,
        AssumedPositionRole::Prior { sigma_nm: 20.0 }
    );
    assert_eq!(s.instrument.index_correction_arcmin, -2.0);
    assert_eq!(s.clock.correction_s, -1.25);
    assert_eq!(s.observations.len(), 3);
    assert_eq!(s.observations[1].limb, Limb::Lower);
    assert_eq!(
        s.observations[1].horizon,
        Some(HorizonMode::ArtificialReflected)
    );
    assert_eq!(s.observations[2].geocentric, None);

    // obs-3 is observed_ho while the instrument carries an index correction: that
    // parameter has to be ignored, and saying so is a warning, not a rejection.
    let already: Vec<&Warning> = warnings
        .iter()
        .filter(|w| matches!(w, Warning::AlreadyCorrected { .. }))
        .collect();
    assert_eq!(already.len(), 1, "{warnings:?}");
    match already[0] {
        Warning::AlreadyCorrected { id, kind, ignored } => {
            assert_eq!(id, "obs-3");
            assert_eq!(*kind, AltitudeKind::ObservedHo);
            assert_eq!(ignored, &vec![CorrectionKind::IndexCorrection]);
        }
        other => panic!("{other:?}"),
    }

    // A HIP designation is a legal body name even without a catalogue entry.
    assert!(validate(&s, &KNOWN).is_ok());
}

#[test]
fn an_unknown_schema_is_named_not_guessed() {
    let json = EVERY_FIELD_JSON.replace("skyfix.session/1", "skyfix.session/2");
    match parse_session(&json) {
        Err(SkyfixError::UnsupportedSchema(s)) => assert_eq!(s, "skyfix.session/2"),
        other => panic!("expected UnsupportedSchema, got {other:?}"),
    }
    match parse_session("{}") {
        Err(SkyfixError::UnsupportedSchema(s)) => assert_eq!(s, ""),
        other => panic!("expected UnsupportedSchema, got {other:?}"),
    }
}

#[test]
fn malformed_json_reports_the_parse_error() {
    match parse_session("{not json") {
        Err(SkyfixError::InvalidField { field, message }) => {
            assert_eq!(field, "session");
            assert!(message.contains("not valid JSON"), "{message}");
        }
        other => panic!("expected InvalidField, got {other:?}"),
    }
    // Right schema, wrong shape.
    let json = r#"{"schema":"skyfix.session/1","observations":[{"id":"a"}]}"#;
    assert!(matches!(
        parse_session(json),
        Err(SkyfixError::InvalidField { .. })
    ));
}

// ---------------------------------------------------------------------------
// validation: rejections
// ---------------------------------------------------------------------------

#[test]
fn duplicate_ids_are_rejected() {
    let s = session(vec![
        with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 45.0)),
        with_direction(observation("obs-1", "Vega", "2026-10-01T01:40:00Z", 46.0)),
    ]);
    match validate(&s, &KNOWN) {
        Err(SkyfixError::DuplicateId(id)) => assert_eq!(id, "obs-1"),
        other => panic!("expected DuplicateId, got {other:?}"),
    }
}

#[test]
fn an_unknown_body_needs_a_supplied_direction() {
    let s = session(vec![observation(
        "obs-1",
        "Test body",
        "2026-10-01T01:30:00Z",
        45.0,
    )]);
    match validate(&s, &KNOWN) {
        Err(SkyfixError::UnknownBody(b)) => assert_eq!(b, "Test body"),
        other => panic!("expected UnknownBody, got {other:?}"),
    }
    // Supplying the direction makes any name acceptable: the fixture no longer needs
    // the body to exist in a catalogue.
    let s = session(vec![with_direction(observation(
        "obs-1",
        "Test body",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    assert!(validate(&s, &KNOWN).is_ok());
    // Case does not matter for a catalogued name.
    let s = session(vec![observation(
        "obs-1",
        "vega",
        "2026-10-01T01:30:00Z",
        45.0,
    )]);
    assert!(validate(&s, &KNOWN).is_ok());
}

#[test]
fn a_zero_or_negative_sigma_is_rejected() {
    for sigma in [0.0, -1.0] {
        let mut obs = with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 45.0));
        obs.sigma_arcmin = sigma;
        let s = session(vec![obs]);
        match validate(&s, &KNOWN) {
            Err(SkyfixError::InvalidField { field, message }) => {
                assert!(field.contains("sigma_arcmin"), "{field}");
                assert!(message.contains("infinite weight"), "{message}");
            }
            other => panic!("expected InvalidField for sigma {sigma}, got {other:?}"),
        }
    }
}

#[test]
fn non_finite_values_are_rejected_wherever_they_appear() {
    let mut obs = with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 45.0));
    obs.altitude_deg = f64::NAN;
    let s = session(vec![obs]);
    match validate(&s, &KNOWN) {
        Err(SkyfixError::NonFinite { field }) => {
            assert_eq!(field, "observations[0].altitude_deg");
        }
        other => panic!("expected NonFinite, got {other:?}"),
    }

    let mut s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    s.observer.height_of_eye_m = f64::INFINITY;
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::NonFinite { field }) if field == "observer.height_of_eye_m"
    ));

    let mut s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    s.observations[0].geocentric.as_mut().unwrap().gha_deg = f64::NAN;
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::NonFinite { field }) if field == "observations[0].geocentric.gha_deg"
    ));
}

#[test]
fn angles_outside_their_ranges_are_rejected() {
    // Altitude.
    let s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        95.0,
    ))]);
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::AngleOutOfRange { value, .. }) if value == 95.0
    ));

    // GHA must be in [0, 360); 360 is out.
    for gha in [-0.5, 360.0, 400.0] {
        let mut s = session(vec![with_direction(observation(
            "obs-1",
            "Vega",
            "2026-10-01T01:30:00Z",
            45.0,
        ))]);
        s.observations[0].geocentric.as_mut().unwrap().gha_deg = gha;
        assert!(
            matches!(
                validate(&s, &KNOWN),
                Err(SkyfixError::AngleOutOfRange { .. })
            ),
            "gha {gha} should be out of range"
        );
    }

    // Declination.
    let mut s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    s.observations[0].geocentric.as_mut().unwrap().dec_deg = 90.5;
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::AngleOutOfRange { .. })
    ));

    // Assumed position.
    let mut s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    s.observer.assumed_position = Some(LatLon {
        lat_deg: 91.0,
        lon_deg: 0.0,
    });
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::AngleOutOfRange { .. })
    ));
}

#[test]
fn a_reflected_artificial_horizon_reading_may_exceed_ninety_degrees() {
    // It is the DOUBLE angle (section 5), so up to 180 deg is legitimate.
    let mut obs = with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 150.0));
    obs.horizon = Some(HorizonMode::ArtificialReflected);
    let s = session(vec![obs]);
    assert!(validate(&s, &KNOWN).is_ok());

    // But not once it is declared as an already-halved apparent altitude.
    let mut obs = with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 150.0));
    obs.horizon = Some(HorizonMode::ArtificialReflected);
    obs.altitude_kind = AltitudeKind::ApparentHa;
    let s = session(vec![obs]);
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::AngleOutOfRange { .. })
    ));
}

#[test]
fn bad_timestamps_and_heights_and_priors_are_rejected() {
    let s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00+00:00",
        45.0,
    ))]);
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::InvalidTimestamp(_))
    ));

    let mut s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    s.observer.height_of_eye_m = -1.0;
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::InvalidField { field, .. }) if field == "observer.height_of_eye_m"
    ));

    // A prior with no radius, or with no position to centre on, is not a prior.
    let mut s = session(vec![with_direction(observation(
        "obs-1",
        "Vega",
        "2026-10-01T01:30:00Z",
        45.0,
    ))]);
    s.observer.assumed_position = Some(LatLon {
        lat_deg: 40.0,
        lon_deg: -75.0,
    });
    s.observer.assumed_position_role = AssumedPositionRole::Prior { sigma_nm: 0.0 };
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::InvalidField { .. })
    ));
    s.observer.assumed_position = None;
    s.observer.assumed_position_role = AssumedPositionRole::Prior { sigma_nm: 10.0 };
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::InvalidField { .. })
    ));
}

// ---------------------------------------------------------------------------
// validation: warnings
// ---------------------------------------------------------------------------

#[test]
fn a_limb_on_a_star_is_a_warning_not_an_error() {
    let mut obs = with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 45.0));
    obs.limb = Limb::Upper;
    let s = session(vec![obs]);
    let warnings = validate(&s, &KNOWN).unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| matches!(w, Warning::LimbIgnoredForStar { id } if id == "obs-1")),
        "{warnings:?}"
    );
}

#[test]
fn identical_body_time_and_altitude_is_flagged_as_a_duplicate_observation() {
    let s = session(vec![
        with_direction(observation("obs-1", "Vega", "2026-10-01T01:30:00Z", 45.0)),
        with_direction(observation("obs-2", "vega", "2026-10-01T01:30:00Z", 45.0)),
        with_direction(observation("obs-3", "Vega", "2026-10-01T01:30:00Z", 45.001)),
    ]);
    let warnings = validate(&s, &KNOWN).unwrap();
    let dupes: Vec<&Warning> = warnings
        .iter()
        .filter(|w| matches!(w, Warning::DuplicateObservation { .. }))
        .collect();
    assert_eq!(dupes.len(), 1, "{warnings:?}");
    match dupes[0] {
        Warning::DuplicateObservation { ids } => assert_eq!(ids, &vec!["obs-1", "obs-2"]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn implausible_weather_and_an_empty_session_warn_without_rejecting() {
    let mut s = session(vec![]);
    s.observer.pressure_hpa = 700.0;
    s.observer.temperature_c = 85.0;
    let warnings = validate(&s, &KNOWN).unwrap();
    let messages: Vec<&str> = warnings
        .iter()
        .filter_map(|w| match w {
            Warning::Other { message } => Some(message.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        messages.iter().any(|m| m.contains("pressure_hpa")),
        "{messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.contains("temperature_c")),
        "{messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.contains("no observations")),
        "{messages:?}"
    );

    // Physically impossible values are still errors.
    let mut s = session(vec![]);
    s.observer.pressure_hpa = 0.0;
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::InvalidField { .. })
    ));
    let mut s = session(vec![]);
    s.observer.temperature_c = -300.0;
    assert!(matches!(
        validate(&s, &KNOWN),
        Err(SkyfixError::InvalidField { .. })
    ));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

#[test]
fn csv_round_trips_a_session_that_uses_every_field() {
    let (s, _) = parse_session(EVERY_FIELD_JSON).unwrap();
    let csv = to_csv(&s);
    let back = from_csv(&csv).unwrap();
    assert_eq!(s, back, "CSV round trip changed the session");
    // And the CSV itself is stable: writing the re-read session gives the same text.
    assert_eq!(csv, to_csv(&back));
    // Format snapshot, so a change to the dialect shows up as a diff in one file.
    assert_eq!(csv, EVERY_FIELD_CSV);
}

#[test]
fn csv_round_trips_through_json_without_loss() {
    // CONVENTIONS section 10: "The CSV path must round-trip through JSON without loss."
    let (s, _) = parse_session(EVERY_FIELD_JSON).unwrap();
    let json = serde_json::to_string(&from_csv(&to_csv(&s)).unwrap()).unwrap();
    let (again, _) = parse_session(&json).unwrap();
    assert_eq!(s, again);
}

#[test]
fn csv_quotes_commas_quotes_newlines_and_padding() {
    let mut s = session(vec![Observation {
        id: "obs, one".to_string(),
        body: "He said \"Vega\"".to_string(),
        utc: "2026-10-01T01:30:00Z".to_string(),
        altitude_deg: 45.0,
        altitude_kind: AltitudeKind::ApparentHa,
        sigma_arcmin: 0.75,
        limb: Limb::Upper,
        horizon: Some(HorizonMode::ElectronicVertical),
        geocentric: Some(GeocentricDirection {
            gha_deg: 359.999,
            dec_deg: -89.5,
            semidiameter_arcmin: 16.25,
            horizontal_parallax_arcmin: 0.146,
        }),
        notes: " two\nlines, and a \"quote\" ".to_string(),
    }]);
    s.meta.name = "name, with a comma".to_string();
    s.meta.notes = "first line\nsecond line\\with a backslash".to_string();
    s.instrument.name = "sextant \"Bob\", #1".to_string();

    let csv = to_csv(&s);
    assert_eq!(from_csv(&csv).unwrap(), s);
}

#[test]
fn csv_round_trips_session_text_with_awkward_whitespace() {
    // A name or note that ends in a space must survive: header values carry the rest of
    // the line verbatim, and the '#' block is not trimmed into them.
    let mut s = session(vec![]);
    s.meta.name = " padded name ".to_string();
    s.meta.notes = "ends with a space ".to_string();
    s.instrument.name = "\ttabbed\t".to_string();
    assert_eq!(from_csv(&to_csv(&s)).unwrap(), s);
}

#[test]
fn a_session_with_no_observations_round_trips() {
    let s = session(vec![]);
    let csv = to_csv(&s);
    assert_eq!(from_csv(&csv).unwrap(), s);
    // The column row is still written, so the file documents its own shape.
    assert!(csv.contains("id,body,utc,altitude_deg"), "{csv}");
}

#[test]
fn empty_cells_mean_absent_or_default() {
    let csv = "# schema=skyfix.session/1\n\
               id,body,utc,altitude_deg,altitude_kind,sigma_arcmin,limb,horizon,gha_deg,dec_deg,semidiameter_arcmin,horizontal_parallax_arcmin,notes\n\
               obs-1,Vega,2026-10-01T01:30:00Z,45,,,,,,,,,\n";
    let s = from_csv(csv).unwrap();
    let o = &s.observations[0];
    assert_eq!(o.altitude_kind, AltitudeKind::SextantHs);
    assert_eq!(o.sigma_arcmin, 1.0);
    assert_eq!(o.limb, Limb::Center);
    assert_eq!(o.horizon, None);
    assert_eq!(o.geocentric, None);
    assert_eq!(o.notes, "");
    // Session-level defaults survive too.
    assert_eq!(s.observer.pressure_hpa, 1010.0);
    assert_eq!(s.observer.temperature_c, 10.0);
    assert_eq!(s.instrument.horizon, HorizonMode::Sea);
    assert_eq!(s.observer.assumed_position, None);
}

#[test]
fn csv_columns_may_be_reordered_and_short_rows_are_padded() {
    let csv = "# schema=skyfix.session/1\n\
               # instrument.horizon=artificial_reflected\n\
               body,utc,id,altitude_deg\n\
               Vega,2026-10-01T01:30:00Z,obs-1,90\n";
    let s = from_csv(csv).unwrap();
    assert_eq!(s.observations[0].id, "obs-1");
    assert_eq!(s.observations[0].body, "Vega");
    assert_eq!(s.observations[0].altitude_deg, 90.0);
    assert_eq!(s.instrument.horizon, HorizonMode::ArtificialReflected);
}

#[test]
fn csv_errors_name_the_offending_cell() {
    let header = "# schema=skyfix.session/1\n";
    let columns = "id,body,utc,altitude_deg,altitude_kind\n";

    // Missing schema.
    assert!(matches!(
        from_csv("id,body,utc,altitude_deg\na,b,c,1\n"),
        Err(SkyfixError::UnsupportedSchema(_))
    ));
    // Unknown session header key.
    assert!(matches!(
        from_csv(&format!("{header}# observer.hight_of_eye_m=2\n{columns}")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("hight_of_eye_m")
    ));
    // Header line without '='.
    assert!(matches!(
        from_csv(&format!("{header}# nonsense\n{columns}")),
        Err(SkyfixError::InvalidField { .. })
    ));
    // Unknown column.
    assert!(matches!(
        from_csv(&format!("{header}id,body,utc,altitude_deg,height\n")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("height")
    ));
    // Missing required column.
    assert!(matches!(
        from_csv(&format!("{header}body,utc,altitude_deg\n")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("id")
    ));
    // Unparsable number and unknown enum values.
    assert!(matches!(
        from_csv(&format!("{header}{columns}obs-1,Vega,2026-10-01T01:30:00Z,high,sextant_hs\n")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("altitude_deg")
    ));
    assert!(matches!(
        from_csv(&format!("{header}{columns}obs-1,Vega,2026-10-01T01:30:00Z,45,raw\n")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("altitude_kind")
    ));
    // A direction needs both gha and dec.
    let half = "id,body,utc,altitude_deg,gha_deg\nobs-1,Vega,2026-10-01T01:30:00Z,45,120\n";
    assert!(matches!(
        from_csv(&format!("{header}{half}")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("gha_deg/dec_deg")
    ));
    // Too many cells for the header.
    assert!(matches!(
        from_csv(&format!("{header}{columns}obs-1,Vega,2026-10-01T01:30:00Z,45,sextant_hs,extra\n")),
        Err(SkyfixError::InvalidField { field, .. }) if field.contains("csv row 1")
    ));
    // Unterminated quote.
    assert!(matches!(
        from_csv(&format!("{header}{columns}\"obs-1,Vega\n")),
        Err(SkyfixError::InvalidField { .. })
    ));
}

#[test]
fn a_csv_session_validates_like_a_json_one() {
    let s = from_csv(EVERY_FIELD_CSV).unwrap();
    let (json_session, json_warnings) = parse_session(EVERY_FIELD_JSON).unwrap();
    assert_eq!(s, json_session);
    let csv_warnings = skyfix_core::session::validate_without_body_catalog(&s).unwrap();
    assert_eq!(csv_warnings, json_warnings);
}
