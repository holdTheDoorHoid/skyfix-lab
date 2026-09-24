//! The planner ranks on geometry, not on brightness and not on equal azimuth spacing.

use skyfix_core::planner::{
    Candidate, NOTE_BRIGHTNESS_SECONDARY, NOTE_GEOMETRIC_VISIBILITY, Objective, PlanOptions,
    ScoreBasis, note_approximate_position, rank,
};
use skyfix_core::types::LatLon;

const PHILADELPHIA: LatLon = LatLon {
    lat_deg: 39.9526,
    lon_deg: -75.1652,
};
const UTC: &str = "2026-10-01T01:30:00Z";

fn c(body: &str, altitude_deg: f64, azimuth_deg: f64) -> Candidate {
    Candidate::new(body, altitude_deg, azimuth_deg, 1.0)
}

fn with_magnitude(body: &str, altitude_deg: f64, azimuth_deg: f64, mag: f64) -> Candidate {
    let mut x = c(body, altitude_deg, azimuth_deg);
    x.magnitude = Some(mag);
    x
}

/// Smallest circular difference between two azimuths, degrees in `[0, 180]`.
fn azimuth_gap(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    d.min(360.0 - d)
}

fn clustered_options() -> PlanOptions {
    PlanOptions {
        already_taken: vec![
            c("Taken-40", 45.0, 40.0),
            c("Taken-50", 45.0, 50.0),
            c("Taken-60", 45.0, 60.0),
        ],
        ..PlanOptions::default()
    }
}

#[test]
fn a_clustered_set_is_completed_perpendicular_not_alongside() {
    let candidates = vec![
        c("Az-45", 45.0, 45.0),
        c("Az-135", 45.0, 135.0),
        c("Az-225", 45.0, 225.0),
        c("Az-315", 45.0, 315.0),
    ];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &clustered_options());

    let top = &plan.bodies[0];
    assert!(
        top.body == "Az-135" || top.body == "Az-315",
        "expected the perpendicular body first, got {} (order {:?})",
        top.body,
        plan.bodies.iter().map(|b| &b.body).collect::<Vec<_>>()
    );

    // The rationale must name the weak direction, which for azimuths 40/50/60 is the
    // axis at about 140 degrees.
    assert!(
        top.rationale.contains("weak along the NW-SE axis"),
        "rationale did not name the weak axis: {}",
        top.rationale
    );
    assert!(
        top.rationale.contains("adds constraint there"),
        "rationale did not say the body fixes that axis: {}",
        top.rationale
    );

    // Three sights already exist, so every step is scored in the objective's own units.
    assert!(
        plan.bodies
            .iter()
            .all(|b| b.score_basis == ScoreBasis::Objective)
    );
    assert_eq!(top.score_units, Objective::MinTrace.score_units());
    assert!(top.score > 0.0, "the top pick must improve the fix");

    // Azimuth 45 and azimuth 225 are the same line of position, so they carry identical
    // information and always tie. The perpendicular pair is taken first, the parallel
    // pair last: the ordering is by axis, not by the number written on the candidate.
    let axis_of = |b: &str| -> f64 {
        plan.bodies
            .iter()
            .find(|x| x.body == b)
            .map(|x| x.azimuth_deg.rem_euclid(180.0))
            .unwrap()
    };
    let order: Vec<f64> = plan
        .bodies
        .iter()
        .map(|b| b.azimuth_deg.rem_euclid(180.0))
        .collect();
    assert_eq!(order, vec![135.0, 135.0, 45.0, 45.0], "order was {order:?}");
    assert_eq!(axis_of("Az-135"), 135.0);
    assert_eq!(axis_of("Az-225"), 45.0);
}

#[test]
fn min_trace_shrinks_the_predicted_sigma_at_every_step() {
    let candidates = vec![
        c("Az-45", 45.0, 45.0),
        c("Az-135", 45.0, 135.0),
        c("Az-225", 45.0, 225.0),
        c("Az-315", 45.0, 315.0),
    ];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &clustered_options());

    assert_eq!(plan.bodies.len(), 4);
    assert_eq!(
        plan.progression.len(),
        5,
        "baseline plus one entry per pick"
    );
    assert!(
        !plan.baseline.singular,
        "three sights already determine a fix"
    );

    let mut previous = f64::INFINITY;
    for (i, m) in plan.progression.iter().enumerate() {
        let s = m
            .trace_sigma_m
            .unwrap_or_else(|| panic!("step {i} has no covariance"));
        assert!(
            s < previous,
            "step {i}: sqrt(trace) {s} did not fall below {previous}"
        );
        previous = s;
    }

    // Both single-axis sigmas and the worst axis improve too, and the gain is reported.
    assert!(plan.predicted.sigma_north_m.unwrap() < plan.baseline.sigma_north_m.unwrap());
    assert!(plan.predicted.sigma_east_m.unwrap() < plan.baseline.sigma_east_m.unwrap());
    assert!(plan.predicted.semi_major_sigma_m.unwrap() < plan.baseline.semi_major_sigma_m.unwrap());
    assert!(plan.predicted.condition_number.unwrap() < plan.baseline.condition_number.unwrap());
    assert_eq!(plan.baseline.sight_count, 3);
    assert_eq!(plan.predicted.sight_count, 7);

    // The clustered baseline really is bad. `condition_number` is that of `W^(1/2) J`
    // (CONVENTIONS section 9), so the covariance's axis ratio is its square: 6.98 here
    // means an error ellipse 7 times longer than it is wide.
    assert!(
        plan.baseline.condition_number.unwrap() > 5.0,
        "the clustered baseline should be poor geometry, got {:?}",
        plan.baseline.condition_number
    );
    assert!(plan.predicted.condition_number.unwrap() < 2.0);
    // The geometric dilution improves too, toward the 1852 m/arcmin ideal.
    assert!(
        plan.predicted.geometric_dilution_m_per_arcmin.unwrap()
            < plan.baseline.geometric_dilution_m_per_arcmin.unwrap()
    );
    // With every sigma at 1.0 arcmin the weighted and geometry-only measures coincide.
    assert!(
        (plan.predicted.geometric_dilution_m_per_arcmin.unwrap()
            - plan.predicted.trace_sigma_m.unwrap())
        .abs()
            < 1e-6
    );
}

#[test]
fn scores_are_the_improvement_at_the_step_the_body_was_chosen() {
    let candidates = vec![
        c("Az-45", 45.0, 45.0),
        c("Az-135", 45.0, 135.0),
        c("Az-225", 45.0, 225.0),
        c("Az-315", 45.0, 315.0),
    ];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &clustered_options());
    for (k, b) in plan.bodies.iter().enumerate() {
        let before = plan.progression[k].trace_sigma_m.unwrap();
        let after = plan.progression[k + 1].trace_sigma_m.unwrap();
        assert!(
            (b.score - (before - after)).abs() < 1e-6,
            "{}: score {} is not the step improvement {}",
            b.body,
            b.score,
            before - after
        );
        assert_eq!(b.step, k + 1);
    }
}

#[test]
fn with_nothing_taken_the_first_two_picks_open_the_geometry_not_the_brightest_pair() {
    // The two brightest are 10 degrees apart: taking both would be nearly useless.
    let candidates = vec![
        with_magnitude("Brightest", 40.0, 10.0, -1.46),
        with_magnitude("Second-brightest", 40.0, 20.0, -0.72),
        with_magnitude("Dim-east", 40.0, 100.0, 0.85),
        with_magnitude("Dim-south", 40.0, 190.0, 1.25),
        with_magnitude("Dim-west", 40.0, 280.0, 1.70),
    ];
    let options = PlanOptions {
        select: 2,
        ..PlanOptions::default()
    };
    let plan = rank(&candidates, PHILADELPHIA, UTC, &options);

    assert_eq!(plan.bodies.len(), 2);
    let gap = azimuth_gap(plan.bodies[0].azimuth_deg, plan.bodies[1].azimuth_deg);
    assert!(
        (60.0..=120.0).contains(&gap),
        "first two picks are {gap} deg apart: {:?}",
        plan.bodies
            .iter()
            .map(|b| (b.body.clone(), b.azimuth_deg))
            .collect::<Vec<_>>()
    );
    assert!(
        plan.bodies.iter().all(|b| b.body != "Second-brightest"),
        "the second-brightest body sits beside the brightest and must not be picked: {:?}",
        plan.bodies.iter().map(|b| &b.body).collect::<Vec<_>>()
    );

    // Starting from nothing, the covariance does not exist for the first two steps, so
    // they are scored on log-determinant growth and the plan says so.
    assert!(plan.baseline.singular);
    assert_eq!(plan.bodies[0].score_basis, ScoreBasis::LogDetGrowth);
    assert_eq!(plan.bodies[1].score_basis, ScoreBasis::LogDetGrowth);
    assert!(plan.bodies[0].score_units.contains("nats"));
    assert!(
        plan.notes.iter().any(|n| n.contains("ln det(J^T W J)")),
        "the ridge and the score change must be disclosed: {:?}",
        plan.notes
    );
    assert!(
        plan.bodies[0].rationale.contains("no sights yet"),
        "{}",
        plan.bodies[0].rationale
    );
    assert!(!plan.predicted.singular, "two sights determine a fix");
}

#[test]
fn a_third_sight_is_placed_where_the_first_two_left_a_gap() {
    // Two sights 40 degrees apart leave a weak axis at about 110 degrees (WNW-ESE).
    let options = PlanOptions {
        select: 1,
        already_taken: vec![c("N", 45.0, 0.0), c("NE", 45.0, 40.0)],
        ..PlanOptions::default()
    };
    let candidates = vec![
        c("Repeat-N", 45.0, 2.0),
        c("Cross", 45.0, 110.0),
        c("Repeat-NE", 45.0, 38.0),
    ];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &options);
    assert_eq!(plan.bodies[0].body, "Cross");
    assert!(
        plan.bodies[0].rationale.contains("WNW-ESE"),
        "{}",
        plan.bodies[0].rationale
    );
    assert!(
        (plan.baseline.semi_major_azimuth_deg.unwrap() - 110.0).abs() < 1.0,
        "the ellipse's major axis is the weak axis: {:?}",
        plan.baseline.semi_major_azimuth_deg
    );
}

#[test]
fn after_two_perpendicular_equal_sights_the_third_azimuth_does_not_matter() {
    // A property of the criteria, not a bug, and worth pinning down: with an isotropic
    // information matrix, adding one unit-weight row leaves trace(Cov), the largest
    // eigenvalue and the condition number all unchanged whatever its azimuth. Only the
    // sigma of the third sight can separate the candidates, so the documented tie-break
    // (higher altitude, then input order) is what decides — and the planner must not
    // pretend it made a geometric choice.
    let options = PlanOptions {
        select: 1,
        already_taken: vec![c("N", 45.0, 0.0), c("E", 45.0, 90.0)],
        ..PlanOptions::default()
    };
    let mut scores = Vec::new();
    for azimuth in [2.0, 45.0, 88.0, 200.0] {
        let plan = rank(&[c("Third", 45.0, azimuth)], PHILADELPHIA, UTC, &options);
        scores.push(plan.bodies[0].score);
        assert!(plan.bodies[0].rationale.contains("already balanced"));
    }
    for s in &scores {
        assert!(
            (s - scores[0]).abs() < 1e-6,
            "isotropic geometry must score every azimuth alike: {scores:?}"
        );
    }
    // But a lower sigma still wins.
    let sharper = rank(
        &[
            Candidate::new("Blunt", 45.0, 45.0, 2.0),
            Candidate::new("Sharp", 45.0, 45.0, 0.5),
        ],
        PHILADELPHIA,
        UTC,
        &options,
    );
    assert_eq!(sharper.bodies[0].body, "Sharp");
}

#[test]
fn the_three_objectives_are_selectable_and_labelled() {
    // A geometry whose two axes are very unequal: one tight north-south pair and one
    // loose east-west sight. Shape and size disagree about what to add next.
    let taken = vec![
        Candidate::new("N1", 45.0, 0.0, 0.5),
        Candidate::new("N2", 45.0, 5.0, 0.5),
        Candidate::new("E1", 45.0, 90.0, 4.0),
    ];
    let candidates = vec![
        Candidate::new("Sharp-north", 45.0, 0.0, 0.2),
        Candidate::new("Loose-east", 45.0, 90.0, 2.0),
    ];
    for objective in [
        Objective::MinTrace,
        Objective::MinMaxEigenvalue,
        Objective::MinConditionNumber,
    ] {
        let options = PlanOptions {
            select: 1,
            already_taken: taken.clone(),
            objective,
            ..PlanOptions::default()
        };
        let plan = rank(&candidates, PHILADELPHIA, UTC, &options);
        assert_eq!(plan.objective, objective);
        assert_eq!(plan.bodies[0].score_units, objective.score_units());
        assert!(
            plan.notes.iter().any(|n| n == objective.description()),
            "the objective must be disclosed: {:?}",
            plan.notes
        );
        assert!(plan.bodies[0].score > 0.0);
    }

    // All three objectives agree here: the east axis is the weak one, so the east sight
    // wins whether you measure overall size, worst axis or shape.
    for objective in [
        Objective::MinTrace,
        Objective::MinMaxEigenvalue,
        Objective::MinConditionNumber,
    ] {
        let options = PlanOptions {
            select: 1,
            already_taken: taken.clone(),
            objective,
            ..PlanOptions::default()
        };
        let plan = rank(&candidates, PHILADELPHIA, UTC, &options);
        assert_eq!(
            plan.bodies[0].body, "Loose-east",
            "{objective:?} picked the wrong body"
        );
    }

    // min_condition_number optimises shape only, so it is allowed to end with a larger
    // ellipse than min_trace. Check that the two objectives really do score differently.
    let trace_plan = rank(
        &candidates,
        PHILADELPHIA,
        UTC,
        &PlanOptions {
            select: 1,
            already_taken: taken.clone(),
            objective: Objective::MinTrace,
            ..PlanOptions::default()
        },
    );
    let cond_plan = rank(
        &candidates,
        PHILADELPHIA,
        UTC,
        &PlanOptions {
            select: 1,
            already_taken: taken,
            objective: Objective::MinConditionNumber,
            ..PlanOptions::default()
        },
    );
    assert!((trace_plan.bodies[0].score - cond_plan.bodies[0].score).abs() > 1e-6);
    assert!(trace_plan.bodies[0].score_units.contains("metres"));
    assert!(cond_plan.bodies[0].score_units.contains("dimensionless"));
}

#[test]
fn every_plan_carries_the_three_disclosures() {
    let candidates = vec![c("Az-45", 45.0, 45.0), c("Az-135", 45.0, 135.0)];
    let plans = [
        rank(&candidates, PHILADELPHIA, UTC, &PlanOptions::default()),
        rank(&candidates, PHILADELPHIA, UTC, &clustered_options()),
        rank(&[], PHILADELPHIA, UTC, &PlanOptions::default()),
        rank(
            &candidates,
            LatLon {
                lat_deg: -33.8688,
                lon_deg: 151.2093,
            },
            UTC,
            &PlanOptions::default(),
        ),
    ];
    for plan in &plans {
        assert!(
            plan.notes
                .contains(&note_approximate_position(&plan.approximate_position)),
            "missing the approximate-position disclosure: {:?}",
            plan.notes
        );
        assert!(
            plan.notes
                .iter()
                .any(|n| n.starts_with("approximate position supplied:")
                    && n.ends_with("ranking is only as good as it"))
        );
        assert!(plan.notes.iter().any(|n| n == NOTE_GEOMETRIC_VISIBILITY));
        assert!(plan.notes.iter().any(|n| n == NOTE_BRIGHTNESS_SECONDARY));
        assert_eq!(plan.utc, UTC);
    }
    // An empty candidate list is a plan with no bodies, not a panic.
    assert!(plans[2].bodies.is_empty());
    assert!(plans[2].predicted.singular);
    assert_eq!(plans[2].progression.len(), 1);
}

#[test]
fn a_plan_round_trips_through_json() {
    let candidates = vec![
        with_magnitude("Az-45", 45.0, 45.0, 0.5),
        c("Az-135", 45.0, 135.0),
    ];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &clustered_options());
    let text = serde_json::to_string(&plan).expect("serialise");
    let back: skyfix_core::planner::Plan = serde_json::from_str(&text).expect("deserialise");
    // Structure and prose must survive exactly. The floats are compared with a
    // tolerance: serde_json's parser is not bit-exact on every f64, and a plan is a
    // report, not a checksum.
    assert_eq!(back.notes, plan.notes);
    assert_eq!(back.objective, plan.objective);
    assert_eq!(back.excluded, plan.excluded);
    assert_eq!(back.approximate_position, plan.approximate_position);
    assert_eq!(back.utc, plan.utc);
    assert_eq!(back.progression.len(), plan.progression.len());
    assert_eq!(back.predicted.rank, plan.predicted.rank);
    assert_eq!(back.predicted.singular, plan.predicted.singular);
    assert_eq!(back.bodies.len(), plan.bodies.len());
    for (a, b) in back.bodies.iter().zip(&plan.bodies) {
        assert_eq!(a.body, b.body);
        assert_eq!(a.rationale, b.rationale);
        assert_eq!(a.score_units, b.score_units);
        assert_eq!(a.score_basis, b.score_basis);
        assert_eq!(a.step, b.step);
        assert!((a.score - b.score).abs() <= 1e-9 * b.score.abs());
    }
    assert!(
        (back.predicted.trace_sigma_m.unwrap() - plan.predicted.trace_sigma_m.unwrap()).abs()
            <= 1e-9 * plan.predicted.trace_sigma_m.unwrap()
    );

    // A rank-deficient plan must round-trip too: an infinity would be written as JSON
    // null and then refuse to read back, so the undefined metrics are Option, not
    // f64::INFINITY.
    let singular = rank(
        &[c("Only-one", 45.0, 30.0)],
        PHILADELPHIA,
        UTC,
        &PlanOptions::default(),
    );
    assert!(singular.predicted.singular);
    assert_eq!(singular.predicted.condition_number, None);
    assert_eq!(singular.predicted.geometric_dilution_m_per_arcmin, None);
    let text = serde_json::to_string(&singular).expect("serialise");
    // `None` is written as JSON null and reads back as `None`. Had these stayed bare
    // f64s holding f64::INFINITY, serde_json would also have written null and then
    // refused to parse it back into an f64 at all, so this parse is the whole point.
    let back: skyfix_core::planner::Plan = serde_json::from_str(&text).expect("deserialise");
    assert_eq!(back.predicted.condition_number, None);
    assert_eq!(back.predicted.geometric_dilution_m_per_arcmin, None);
    assert_eq!(back.predicted.trace_sigma_m, None);
    assert_eq!(back.predicted.rank, 1);
    assert!(back.predicted.singular);
    assert_eq!(back.notes, singular.notes);
    // Options carry their defaults through JSON too.
    let options: PlanOptions = serde_json::from_str("{}").expect("default options");
    assert_eq!(options, PlanOptions::default());
    assert_eq!(
        serde_json::to_string(&Objective::MinMaxEigenvalue).unwrap(),
        "\"min_max_eigenvalue\""
    );
}

#[test]
fn unusable_numbers_are_named_and_dropped_not_weighted() {
    let candidates = vec![
        Candidate::new("NaN-altitude", f64::NAN, 45.0, 1.0),
        Candidate::new("Infinite-azimuth", 45.0, f64::INFINITY, 1.0),
        Candidate::new("Zero-sigma", 45.0, 200.0, 0.0),
        c("Good", 45.0, 300.0),
    ];
    let options = PlanOptions {
        already_taken: vec![
            c("Taken", 45.0, 20.0),
            Candidate::new("Taken-bad", 45.0, 30.0, f64::NAN),
        ],
        ..PlanOptions::default()
    };
    let plan = rank(&candidates, PHILADELPHIA, UTC, &options);
    assert_eq!(plan.bodies.len(), 1);
    assert_eq!(plan.bodies[0].body, "Good");
    assert_eq!(plan.excluded.len(), 3);
    for name in ["NaN-altitude", "Infinite-azimuth", "Zero-sigma"] {
        assert!(
            plan.excluded.iter().any(|e| e.body == name),
            "{name} should have been excluded"
        );
        assert!(plan.notes.iter().any(|n| n.contains(name)));
    }
    // The unusable already-taken sight is reported and not counted.
    assert_eq!(plan.baseline.sight_count, 1);
    assert!(plan.notes.iter().any(|n| n.contains("already-taken sight")));
}
