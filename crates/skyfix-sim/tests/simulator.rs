//! Integration tests for the simulator's public surface.
//!
//! These exercise `skyfix_sim` the way the CLI, the WASM adapter and the packaging step
//! will: build a scenario, generate a session and a truth, and check the properties the
//! brief and `docs/SIMULATOR.md` promise. The unit tests inside each module check the
//! pieces; these check the promises.
//!
//! Anything that needs `skyfix_core::solver` or `skyfix_core::reduce` lives in
//! `experiment.rs` behind `#[ignore = "needs solver merge"]`; nothing here calls them.

use skyfix_core::geometry::{self, Point};
use skyfix_core::time;
use skyfix_core::types::{
    AltitudeKind, AssumedPositionRole, LatLon, SESSION_SCHEMA, Session, SessionKind, TRUTH_SCHEMA,
};
use skyfix_core::units::{SIDEREAL_RATE_DEG_PER_HOUR, rad_to_deg};
use skyfix_sim::demos;
use skyfix_sim::experiment::{self, Experiment, ExperimentSummary, RunRecord};
use skyfix_sim::generate::{simulate, simulate_detailed};
use skyfix_sim::optics;
use skyfix_sim::rng::Rng;
use skyfix_sim::scenario::{
    AssumedPositionMode, AssumedPositionSpec, EmittedAltitude, Ordering, Scenario, Schedule,
    WrongSight, body_at, gha_dec_for,
};

const PHL: LatLon = LatLon {
    lat_deg: 39.9526,
    lon_deg: -75.1652,
};

/// The structural half of CONVENTIONS section 10, until `skyfix_core::session::validate`
/// lands. Deliberately duplicated rather than imported: a validator that shares code
/// with the thing it validates proves nothing.
fn validate_structure(session: &Session) -> Result<(), String> {
    if session.schema != SESSION_SCHEMA {
        return Err(format!("schema is {:?}", session.schema));
    }
    if session.observations.is_empty() {
        return Err("a session with no observations".into());
    }
    let mut ids: Vec<&str> = session.observations.iter().map(|o| o.id.as_str()).collect();
    let n = ids.len();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != n {
        return Err("duplicate observation ids".into());
    }
    for o in &session.observations {
        if o.id.is_empty() {
            return Err("an observation has an empty id".into());
        }
        if o.body.is_empty() {
            return Err(format!("observation {}: empty body name", o.id));
        }
        time::parse_utc(&o.utc).map_err(|e| format!("observation {}: {e}", o.id))?;
        if !o.altitude_deg.is_finite() || !(-90.0..=90.0).contains(&o.altitude_deg) {
            return Err(format!("observation {}: altitude {}", o.id, o.altitude_deg));
        }
        if !(o.sigma_arcmin.is_finite() && o.sigma_arcmin > 0.0) {
            return Err(format!("observation {}: sigma {}", o.id, o.sigma_arcmin));
        }
        match o.geocentric {
            Some(g) => {
                if !(0.0..360.0).contains(&g.gha_deg) {
                    return Err(format!("observation {}: gha {}", o.id, g.gha_deg));
                }
                if !(-90.0..=90.0).contains(&g.dec_deg) {
                    return Err(format!("observation {}: dec {}", o.id, g.dec_deg));
                }
            }
            None => {
                // Allowed only when a provider is expected to resolve the body.
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

#[test]
fn the_same_seed_gives_byte_identical_sessions() {
    for scenario in demos::all() {
        let name = scenario.name.clone();
        let a = serde_json::to_string(&simulate(&scenario, None).unwrap().0).unwrap();
        let b = serde_json::to_string(&simulate(&scenario, None).unwrap().0).unwrap();
        assert_eq!(a, b, "{name} is not deterministic");
    }
}

#[test]
fn a_different_seed_gives_different_data_but_the_same_shape() {
    let base = demos::philadelphia_stars();
    let mut other = base.clone();
    other.seed += 1;
    let (sa, _) = simulate(&base, None).unwrap();
    let (sb, _) = simulate(&other, None).unwrap();
    assert_eq!(sa.observations.len(), sb.observations.len());
    let differing = sa
        .observations
        .iter()
        .zip(&sb.observations)
        .filter(|(a, b)| a.altitude_deg != b.altitude_deg)
        .count();
    assert_eq!(
        differing,
        sa.observations.len(),
        "every sight should differ"
    );
    // The timestamps and the bodies are schedule properties, not random ones.
    for (a, b) in sa.observations.iter().zip(&sb.observations) {
        assert_eq!(a.utc, b.utc);
        assert_eq!(a.body, b.body);
        assert_eq!(a.id, b.id);
    }
}

#[test]
fn the_rng_stream_is_stable_for_a_pinned_seed() {
    // A second guard on the same contract as the unit test: if this changes, every
    // packaged session file changes with it.
    let mut r = Rng::new(2_026_100_101);
    let first: Vec<f64> = (0..3).map(|_| r.normal()).collect();
    let mut again = Rng::new(2_026_100_101);
    let second: Vec<f64> = (0..3).map(|_| again.normal()).collect();
    assert_eq!(first, second);
    assert!(first.iter().all(|z| z.is_finite() && z.abs() < 6.0));
}

// ---------------------------------------------------------------------------
// Truth separation
// ---------------------------------------------------------------------------

#[test]
fn no_packaged_demo_leaks_its_truth_into_the_session() {
    let mut scenarios = demos::all();
    scenarios.push(demos::philadelphia_stars_sextant());
    for scenario in scenarios {
        let name = scenario.name.clone();
        let (session, truth) = simulate(&scenario, None).unwrap();
        let json = serde_json::to_string_pretty(&session).unwrap();
        // The truth coordinates, as they are written anywhere in this project.
        for needle in ["39.9526", "75.1652"] {
            assert!(!json.contains(needle), "{name} leaks {needle}:\n{json}");
        }
        // The seed. Demo seeds are ten digits, so a coincidental match is impossible.
        assert!(
            !json.contains(&scenario.seed.to_string()),
            "{name} leaks its seed {}",
            scenario.seed
        );
        // The truth document has what the session does not.
        assert_eq!(truth.schema, TRUTH_SCHEMA);
        assert_eq!(truth.position, demos::PHILADELPHIA);
        assert_eq!(truth.seed, scenario.seed);
        assert_eq!(truth.session_name, name);
    }
}

#[test]
fn the_assumed_position_is_never_the_truth_unless_asked_for() {
    for scenario in demos::all() {
        let name = scenario.name.clone();
        let (session, _) = simulate(&scenario, None).unwrap();
        let ap = session
            .observer
            .assumed_position
            .unwrap_or_else(|| panic!("{name} has no assumed position"));
        let d = geometry::angular_distance(
            Point::from_deg(ap.lat_deg, ap.lon_deg),
            Point::from_deg(PHL.lat_deg, PHL.lon_deg),
        );
        assert!(
            skyfix_core::units::rad_to_nm(d) > 1.0,
            "{name}: the assumed position is on top of the truth"
        );
        assert_eq!(
            session.observer.assumed_position_role,
            AssumedPositionRole::Initializer,
            "{name}: an initializer must not become a prior"
        );
    }

    // Asking for the truth explicitly is allowed, and must announce itself.
    let mut s = demos::philadelphia_stars();
    s.assumed_position = AssumedPositionSpec {
        mode: AssumedPositionMode::Truth,
        role: AssumedPositionRole::Initializer,
    };
    let (session, _) = simulate(&s, None).unwrap();
    assert_eq!(session.observer.assumed_position.unwrap(), PHL);
    assert!(session.meta.notes.contains("TRUE POSITION"));
    assert!(session.meta.notes.contains("not a blind experiment"));
}

#[test]
fn session_notes_name_the_knobs_without_giving_their_values() {
    let mut s = demos::philadelphia_stars();
    s.shared_altitude_bias_arcmin = 3.0;
    s.clock_offset_s = 60.0;
    s.wrong_sight = Some(WrongSight {
        index: 1,
        error_arcmin: 8.0,
    });
    let (session, _) = simulate(&s, None).unwrap();
    let notes = &session.meta.notes;
    assert!(notes.contains("shared altitude bias"));
    assert!(notes.contains("deliberate blunder"));
    assert!(notes.contains("recorded timestamps"));
    // No numeric truth before the assumed-position sentence, which discloses its own
    // offset distance on purpose.
    let head = notes.split("Assumed position").next().unwrap();
    assert!(!head.chars().any(|c| c.is_ascii_digit()), "{head}");
}

// ---------------------------------------------------------------------------
// Noise statistics
// ---------------------------------------------------------------------------

#[test]
fn per_sight_noise_has_the_requested_mean_and_sigma_and_no_memory() {
    // Zero spacing puts every sight at the same instant, which is unphysical but keeps
    // the bodies from setting over a five thousand sight schedule. Only the noise is
    // under test here.
    let mut s = Scenario::new(
        "noise",
        4242,
        PHL,
        "2026-10-01T01:30:00Z",
        vec![
            body_at("a", PHL, 50.0, 30.0),
            body_at("b", PHL, 40.0, 150.0),
            body_at("c", PHL, 45.0, 270.0),
        ],
        Schedule::new(5000, 0.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 1.5;
    let sim = simulate_detailed(&s, None).unwrap();
    let e: Vec<f64> = sim.sights.iter().map(|t| t.noise_arcmin).collect();
    assert_eq!(e.len(), 5000);
    let n = e.len() as f64;
    let mean = e.iter().sum::<f64>() / n;
    let var = e.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n;
    let sd = var.sqrt();
    // 5 sigma on the mean is 1.5 * 5 / sqrt(5000) = 0.106.
    assert!(mean.abs() < 0.11, "noise mean {mean} arcmin");
    // 5 sigma on the sd is 1.5 * 5 / sqrt(2 * 5000) = 0.075.
    assert!((sd - 1.5).abs() < 0.08, "noise sd {sd} arcmin");
    // Independence: the lag-1 correlation of an independent stream is 0 +/- 1/sqrt(n).
    let lag1 = e
        .windows(2)
        .map(|w| (w[0] - mean) * (w[1] - mean))
        .sum::<f64>()
        / (n - 1.0)
        / var;
    assert!(lag1.abs() < 0.07, "lag-1 correlation {lag1}");
    // And it really is a normal: about 68 % inside 1 sigma, 95 % inside 2.
    let within = |k: f64| e.iter().filter(|x| x.abs() <= k * 1.5).count() as f64 / n;
    assert!(
        (within(1.0) - 0.6827).abs() < 0.025,
        "1 sigma {}",
        within(1.0)
    );
    assert!(
        (within(2.0) - 0.9545).abs() < 0.015,
        "2 sigma {}",
        within(2.0)
    );

    // The altitudes carry exactly that noise and nothing else.
    for (obs, t) in sim.session.observations.iter().zip(&sim.sights) {
        let applied = (obs.altitude_deg - t.true_altitude_deg) * 60.0;
        assert!((applied - t.noise_arcmin).abs() < 1e-9);
    }
}

#[test]
fn a_shared_bias_does_not_average_away_but_noise_does() {
    // The brief's non-negotiable distinction 6, demonstrated inside the simulator alone:
    // the MEAN sight error converges to the bias, not to zero, however many sights are
    // taken. This needs no solver.
    let mut s = Scenario::new(
        "bias",
        777,
        PHL,
        "2026-10-01T01:30:00Z",
        vec![body_at("a", PHL, 45.0, 90.0)],
        Schedule::new(4000, 0.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 1.0;
    s.shared_altitude_bias_arcmin = 3.0;
    let sim = simulate_detailed(&s, None).unwrap();
    let errors = experiment::sight_errors_arcmin(&sim.sights);
    let mean = errors.iter().sum::<f64>() / errors.len() as f64;
    assert!(
        (mean - 3.0).abs() < 0.1,
        "the mean sight error should stay at the bias, got {mean}"
    );
    // Turning the bias off lets the same number of sights average to zero.
    let mut clean = s.clone();
    clean.shared_altitude_bias_arcmin = 0.0;
    let sim = simulate_detailed(&clean, None).unwrap();
    let errors = experiment::sight_errors_arcmin(&sim.sights);
    let mean = errors.iter().sum::<f64>() / errors.len() as f64;
    assert!(
        mean.abs() < 0.1,
        "noise alone should average away, got {mean}"
    );
}

// ---------------------------------------------------------------------------
// Inverted geometry
// ---------------------------------------------------------------------------

#[test]
fn a_body_placed_at_an_altitude_and_azimuth_is_found_there_again() {
    for &(lat, lon) in &[
        (39.9526, -75.1652),
        (0.0, 0.0),
        (-33.8688, 151.2093),
        (70.0, 179.9),
        (-45.0, -179.9),
    ] {
        let obs = LatLon {
            lat_deg: lat,
            lon_deg: lon,
        };
        let p = Point::from_deg(lat, lon);
        for &h in &[1.0, 15.0, 42.5, 75.0, 88.0] {
            for zn in (0..360).step_by(23) {
                let zn = zn as f64;
                let (gha, dec) = gha_dec_for(obs, h, zn);
                let (h_back, zn_back) =
                    geometry::altitude_azimuth(p, gha.to_radians(), dec.to_radians());
                assert!(
                    (h_back - h.to_radians()).abs() < 1e-9,
                    "at {lat},{lon}: altitude {h} came back as {}",
                    rad_to_deg(h_back)
                );
                let dz = (rad_to_deg(zn_back) - zn + 540.0) % 360.0 - 180.0;
                assert!(
                    dz.abs() < 1e-9,
                    "at {lat},{lon}: azimuth {zn} came back as {}",
                    rad_to_deg(zn_back)
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Missing sights, blunders and clock offsets
// ---------------------------------------------------------------------------

#[test]
fn missing_fraction_drops_the_right_number_and_keeps_the_rest_intact() {
    let mut s = demos::philadelphia_stars();
    s.schedule = Schedule::new(20, 30.0, Ordering::RoundRobin);
    let full = simulate_detailed(&s, None).unwrap();
    s.missing_fraction = 0.3;
    let thinned = simulate_detailed(&s, None).unwrap();
    assert_eq!(full.sights.len(), 20);
    assert_eq!(thinned.sights.len(), 14, "round(20 * 0.3) = 6 dropped");

    // Every surviving sight is one of the originals, unchanged: the same body at the
    // same instant with the same noise. Only the id is renumbered.
    for t in &thinned.sights {
        let original = full
            .sights
            .iter()
            .find(|f| (f.true_jd_utc - t.true_jd_utc).abs() < 1e-12 && f.body == t.body)
            .unwrap_or_else(|| panic!("{} at {} is not in the full run", t.body, t.true_utc));
        assert_eq!(original.noise_arcmin, t.noise_arcmin);
        assert!((original.emitted_ho_deg - t.emitted_ho_deg).abs() < 1e-12);
    }
    let ids: Vec<&str> = thinned
        .session
        .observations
        .iter()
        .map(|o| o.id.as_str())
        .collect();
    assert_eq!(ids[0], "obs-1");
    assert_eq!(ids[13], "obs-14");
}

#[test]
fn the_blunder_lands_on_the_emitted_index_even_when_sights_are_missing() {
    let mut s = demos::philadelphia_stars();
    s.schedule = Schedule::new(10, 30.0, Ordering::RoundRobin);
    s.missing_fraction = 0.4;
    s.wrong_sight = Some(WrongSight {
        index: 3,
        error_arcmin: 8.0,
    });
    let sim = simulate_detailed(&s, None).unwrap();
    assert_eq!(sim.sights.len(), 6);
    assert_eq!(sim.truth.wrong_sight_ids, vec!["obs-4".to_string()]);
    for (i, t) in sim.sights.iter().enumerate() {
        assert_eq!(
            t.blunder_arcmin,
            if i == 3 { 8.0 } else { 0.0 },
            "sight {i}"
        );
    }
    // Indexing past the emitted sights is an error, not a quiet no-op.
    s.wrong_sight = Some(WrongSight {
        index: 6,
        error_arcmin: 8.0,
    });
    assert!(simulate(&s, None).unwrap_err().contains("out of range"));
}

#[test]
fn a_clock_offset_only_moves_the_timestamps_and_the_almanac_lookup() {
    let clean = simulate_detailed(&demos::philadelphia_stars(), None).unwrap();
    let mut s = demos::philadelphia_stars();
    s.clock_offset_s = 60.0;
    let late = simulate_detailed(&s, None).unwrap();

    let expected_gha_shift = SIDEREAL_RATE_DEG_PER_HOUR * 60.0 / 3600.0;
    for ((a, b), (ta, tb)) in clean
        .session
        .observations
        .iter()
        .zip(&late.session.observations)
        .zip(clean.sights.iter().zip(&late.sights))
    {
        // The sight itself is unchanged: it was taken at the same instant of the same sky.
        assert!((a.altitude_deg - b.altitude_deg).abs() < 1e-12);
        assert_eq!(ta.true_utc, tb.true_utc);
        assert!((ta.true_altitude_deg - tb.true_altitude_deg).abs() < 1e-12);
        // The recorded time is 60 seconds later: clock_offset_s = recorded - true.
        let da = time::parse_utc(&a.utc).unwrap();
        let db = time::parse_utc(&b.utc).unwrap();
        assert!(((db - da) * 86_400.0 - 60.0).abs() < 1e-3);
        // ...and the almanac was consulted at that later time.
        let shift = b.geocentric.unwrap().gha_deg - a.geocentric.unwrap().gha_deg;
        // 1e-6 degrees, not 1e-9: the recorded timestamps are snapped to the millisecond
        // and a Julian date only resolves ~40 microseconds, which is ~1e-8 degrees of
        // GHA. That is 0.00004 arcseconds of sky.
        assert!(
            (shift - expected_gha_shift).abs() < 1e-6,
            "gha shift {shift}"
        );
    }
    assert_eq!(late.truth.clock_offset_s, 60.0);
    // Sanity on the promised number: 0.2507 degrees of GHA per minute of clock error.
    assert!((expected_gha_shift - 0.250_684_477).abs() < 1e-9);
}

// ---------------------------------------------------------------------------
// The reverse correction chain
// ---------------------------------------------------------------------------

#[test]
fn the_reverse_chain_uses_the_conventions_numbers() {
    // Bennett refraction, CONVENTIONS section 5, at standard conditions.
    let r10 = optics::refraction_arcmin(10.0, 1010.0, 10.0);
    assert!((r10 - 5.391_505_468).abs() < 1e-9, "{r10}");
    assert!(
        (r10 - 5.3).abs() < 0.1,
        "should match the almanac's 5.3 arcmin"
    );
    // Dip, 1.76 sqrt(metres).
    assert!((optics::dip_arcmin(2.0) - 2.489_015_87).abs() < 1e-8);

    // A worked sight: Ho = 45 degrees, eye 2 m up, index error 2.0 arcmin on the arc.
    let ho = 45.0;
    let hs = optics::ho_to_hs(ho, -2.0, 2.0, 1010.0, 10.0).unwrap();
    let ha = optics::ho_to_ha(ho, 1010.0, 10.0).unwrap();
    // Ha is defined by Ha - R(Ha) = Ho, so it is very slightly less than Ho + R(Ho):
    // refraction is evaluated at the apparent altitude, not the observed one.
    assert!(
        (ha - optics::refraction_arcmin(ha, 1010.0, 10.0) / 60.0 - ho).abs() < 1e-12,
        "Ha {ha} does not satisfy its own definition"
    );
    let lift_arcmin = (ha - ho) * 60.0;
    assert!(
        (lift_arcmin - 0.9945).abs() < 0.002,
        "refraction lift {lift_arcmin} arcmin"
    );
    assert!(lift_arcmin < 0.994_848, "R(Ha) must be below R(Ho) here");
    // Hs = Ha + dip - IC.
    assert!(
        (hs - (ha + (2.489_016 + 2.0) / 60.0)).abs() < 1e-6,
        "Hs {hs}"
    );
    // And the forward chain, which is what a reducer runs, returns the original.
    assert!((optics::hs_to_ho(hs, -2.0, 2.0, 1010.0, 10.0).unwrap() - ho).abs() < 1e-11);
}

#[test]
fn a_sextant_session_declares_everything_needed_to_undo_it() {
    let s = demos::philadelphia_stars_sextant();
    let sim = simulate_detailed(&s, None).unwrap();
    let EmittedAltitude::SextantHs {
        height_of_eye_m,
        index_correction_arcmin,
        pressure_hpa,
        temperature_c,
    } = s.altitude_kind
    else {
        panic!("the sextant demo must emit raw readings");
    };
    // Everything the reducer needs is in the session, not only in the scenario.
    assert_eq!(sim.session.observer.height_of_eye_m, height_of_eye_m);
    assert_eq!(sim.session.observer.pressure_hpa, pressure_hpa);
    assert_eq!(sim.session.observer.temperature_c, temperature_c);
    assert_eq!(
        sim.session.instrument.index_correction_arcmin,
        index_correction_arcmin
    );
    assert_eq!(
        sim.session.instrument.horizon,
        skyfix_core::types::HorizonMode::Sea
    );
    for (obs, t) in sim.session.observations.iter().zip(&sim.sights) {
        assert_eq!(obs.altitude_kind, AltitudeKind::SextantHs);
        assert_eq!(obs.limb, skyfix_core::types::Limb::Center);
        let back = optics::hs_to_ho(
            obs.altitude_deg,
            index_correction_arcmin,
            height_of_eye_m,
            pressure_hpa,
            temperature_c,
        )
        .unwrap();
        assert!(
            (back - t.emitted_ho_deg).abs() < 1e-11,
            "{}: {back} vs {}",
            obs.id,
            t.emitted_ho_deg
        );
    }
}

// ---------------------------------------------------------------------------
// The demo set
// ---------------------------------------------------------------------------

#[test]
fn every_packaged_demo_generates_and_validates() {
    let mut scenarios = demos::all();
    scenarios.push(demos::philadelphia_stars_sextant());
    assert_eq!(
        scenarios.len(),
        9,
        "the brief's six demos, as nine scenarios"
    );
    for scenario in scenarios {
        let name = scenario.name.clone();
        let sim = simulate_detailed(&scenario, None)
            .unwrap_or_else(|e| panic!("{name} failed to generate: {e}"));
        validate_structure(&sim.session).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(sim.session.meta.kind, SessionKind::Simulated, "{name}");
        assert_eq!(sim.session.instrument.name, "simulated", "{name}");
        assert_eq!(sim.sights.len(), sim.session.observations.len(), "{name}");
        assert!(!sim.session.meta.notes.is_empty(), "{name} has no notes");
        // The JSON a packaging step would write is parseable and unchanged.
        let json = serde_json::to_string_pretty(&sim.session).unwrap();
        let back: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(back.schema, sim.session.schema);
        assert_eq!(back.observations.len(), sim.session.observations.len());
        assert_eq!(back.meta, sim.session.meta);
    }
}

#[test]
fn the_named_star_demo_asks_for_a_provider_rather_than_guessing() {
    let s = demos::philadelphia_stars_named();
    let err = simulate(&s, None).unwrap_err();
    assert!(err.contains("AstroProvider"), "{err}");
    assert!(
        err.contains("Vega"),
        "the message must name the body: {err}"
    );
}

#[test]
fn demo_descriptions_are_written_for_a_person() {
    let mut scenarios = demos::all();
    scenarios.push(demos::philadelphia_stars_named());
    scenarios.push(demos::philadelphia_stars_sextant());
    for s in scenarios {
        assert!(
            s.description.len() > 200,
            "{}: the description is too short to explain anything",
            s.name
        );
        // No jargon that only a programmer would recognise.
        for forbidden in ["Vec<", "todo!", "fn ", "struct ", "None", "Some("] {
            assert!(
                !s.description.contains(forbidden),
                "{}: description contains {forbidden:?}",
                s.name
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Experiment output formats (the solver-free half)
// ---------------------------------------------------------------------------

#[test]
fn a_refused_experiment_still_produces_a_usable_summary() {
    let mut e = Experiment::new(demos::philadelphia_stars(), 5);
    e.solve_options.initializer = Some(e.scenario.truth);
    let summary = experiment::run(&e, None);
    assert!(summary.runs.is_empty());
    assert_eq!(summary.aggregate.repetitions, 0);
    assert!(summary.notes.iter().any(|n| n.contains("refused")));
    // Both formats work on an empty result, which is what a CLI will hit first.
    let csv = experiment::to_csv(&summary);
    assert!(csv.contains("# note: experiment refused"));
    assert!(csv.lines().last().unwrap().starts_with("repetition,"));
    let json = experiment::to_json(&summary).unwrap();
    let back: ExperimentSummary = serde_json::from_str(&json).unwrap();
    assert_eq!(back, summary);
}

#[test]
fn csv_columns_and_rows_line_up() {
    let summary = ExperimentSummary {
        name: "shape".to_string(),
        description: "a, description, with commas".to_string(),
        runs: (0..3)
            .map(|i| RunRecord {
                repetition: i,
                seed: i as u64,
                result_kind: "unique".to_string(),
                converged: true,
                sights_used: 5,
                error_m: Some(123.456),
                sigma_north_m: Some(80.0),
                sigma_east_m: Some(60.0),
                inside_ellipse95: Some(true),
                ..Default::default()
            })
            .collect(),
        aggregate: Default::default(),
        notes: vec![],
    };
    let csv = experiment::to_csv(&summary);
    let lines: Vec<&str> = csv.lines().collect();
    let header = lines.iter().find(|l| l.starts_with("repetition,")).unwrap();
    let columns = header.split(',').count();
    let rows: Vec<&&str> = lines
        .iter()
        .filter(|l| !l.starts_with('#') && !l.starts_with("repetition,"))
        .collect();
    assert_eq!(rows.len(), 3);
    for r in rows {
        assert_eq!(r.split(',').count(), columns, "row {r}");
    }
    assert!(csv.contains("123.456000"));
}

#[test]
fn the_closed_form_predictions_are_reproducible_numbers() {
    // The two quantities the planner checks the solver against.
    let shift = experiment::clock_longitude_shift_deg(SIDEREAL_RATE_DEG_PER_HOUR, 60.0);
    assert!((shift + 0.250_684_477_333).abs() < 1e-9);
    let east = experiment::clock_shift_east_m(PHL.lat_deg, SIDEREAL_RATE_DEG_PER_HOUR, 60.0);
    assert!((east + 21_353.785).abs() < 0.01, "{east}");

    let (dn, de) = experiment::predicted_bias_shift_m(&demos::shared_bias(), None).unwrap();
    assert!((dn + 846.45).abs() < 0.5, "north {dn}");
    assert!((de - 6_964.31).abs() < 0.5, "east {de}");
}
