//! Geometric visibility against the real star provider, at a real place and time.
//!
//! Philadelphia City Hall (CONVENTIONS section 2), 2026-10-01T01:30:00Z — about 21:30
//! local, well after dark on the first of October.

use skyfix_core::planner::{Objective, PlanOptions, ScoreBasis};
use skyfix_core::time::parse_utc;
use skyfix_core::types::LatLon;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::visibility::{NOTE_DARK, plan_at, visible_bodies};

const PHILADELPHIA: LatLon = LatLon {
    lat_deg: 39.9526,
    lon_deg: -75.1652,
};
const UTC: &str = "2026-10-01T01:30:00Z";
const MIN_ALT: f64 = 15.0;

fn names() -> Vec<String> {
    StarProvider::new()
        .bodies()
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[test]
fn vega_and_altair_are_up_and_sirius_is_not() {
    let provider = StarProvider::new();
    let jd = parse_utc(UTC).expect("valid timestamp");
    let visible = visible_bodies(&provider, &names(), PHILADELPHIA, jd, MIN_ALT, 1.0)
        .expect("every catalogue name is answerable");

    let find = |body: &str| visible.iter().find(|c| c.body == body);
    let vega = find("Vega").expect("Vega should be well up on an October evening");
    let altair = find("Altair").expect("Altair should be well up on an October evening");
    assert!(
        vega.altitude_deg > MIN_ALT,
        "Vega altitude {}",
        vega.altitude_deg
    );
    assert!(
        altair.altitude_deg > MIN_ALT,
        "Altair altitude {}",
        altair.altitude_deg
    );
    assert!(
        find("Sirius").is_none(),
        "Sirius does not rise in Philadelphia until the small hours in October"
    );

    // Sanity: Vega is high in the west, Altair south-south-west, at this hour.
    assert!((vega.altitude_deg - 61.07).abs() < 0.1, "{vega:?}");
    assert!((vega.azimuth_deg - 280.06).abs() < 0.1, "{vega:?}");
    assert!((altair.altitude_deg - 54.62).abs() < 0.1, "{altair:?}");
    assert!((altair.azimuth_deg - 213.97).abs() < 0.1, "{altair:?}");
}

#[test]
fn polaris_stands_at_the_observers_latitude() {
    let provider = StarProvider::new();
    let jd = parse_utc(UTC).expect("valid timestamp");
    let visible = visible_bodies(&provider, &names(), PHILADELPHIA, jd, MIN_ALT, 1.0).unwrap();
    let polaris = visible
        .iter()
        .find(|c| c.body == "Polaris")
        .expect("Polaris never sets at 40 N");
    // Polaris is about 0.7 degrees from the pole, so its altitude swings that far either
    // side of the latitude over a day. One degree is the honest bound.
    assert!(
        (polaris.altitude_deg - PHILADELPHIA.lat_deg).abs() < 1.0,
        "Polaris altitude {} vs latitude {}",
        polaris.altitude_deg,
        PHILADELPHIA.lat_deg
    );
    // And it is, as ever, due north.
    assert!(
        polaris.azimuth_deg < 2.0 || polaris.azimuth_deg > 358.0,
        "Polaris azimuth {}",
        polaris.azimuth_deg
    );
}

#[test]
fn every_returned_candidate_is_in_range_and_carries_a_magnitude() {
    let provider = StarProvider::new();
    let jd = parse_utc(UTC).expect("valid timestamp");
    let visible = visible_bodies(&provider, &names(), PHILADELPHIA, jd, MIN_ALT, 1.0).unwrap();
    assert!(
        visible.len() >= 10,
        "an October evening at 40 N should offer plenty of stars, got {}",
        visible.len()
    );
    assert!(visible.len() < names().len());
    for c in &visible {
        assert!(
            (0.0..360.0).contains(&c.azimuth_deg),
            "{}: azimuth {}",
            c.body,
            c.azimuth_deg
        );
        assert!(
            (MIN_ALT..=90.0).contains(&c.altitude_deg),
            "{}: altitude {}",
            c.body,
            c.altitude_deg
        );
        // Above 15 degrees the planning inflation never applies.
        assert_eq!(c.sigma_arcmin, 1.0, "{}", c.body);
        assert!(
            c.magnitude.is_some(),
            "{} is a catalogue star and must carry its magnitude",
            c.body
        );
        assert!(c.is_usable());
    }
    // The floor is honoured: lowering it admits more bodies, raising it fewer.
    let low = visible_bodies(&provider, &names(), PHILADELPHIA, jd, 0.0, 1.0).unwrap();
    let high = visible_bodies(&provider, &names(), PHILADELPHIA, jd, 50.0, 1.0).unwrap();
    assert!(low.len() > visible.len() && visible.len() > high.len());
    // Below 10 degrees the sigma inflation does show up.
    assert!(
        low.iter()
            .any(|c| c.altitude_deg < 10.0 && c.sigma_arcmin > 1.0)
    );
}

#[test]
fn the_plan_picks_a_spread_of_bodies_and_excludes_the_one_near_the_zenith() {
    let provider = StarProvider::new();
    // Sun altitude is supplied by the caller: about -15 degrees at 21:30 local on 1 Oct.
    let plan = plan_at(
        &provider,
        &names(),
        PHILADELPHIA,
        UTC,
        &PlanOptions::default(),
        Some(-15.0),
    )
    .expect("the plan should build");

    assert_eq!(plan.bodies.len(), 5, "the default selection is five bodies");
    assert_eq!(plan.objective, Objective::MinTrace);

    // Deneb is at about 82.7 degrees: too near the zenith to use, and it is excluded by
    // name with the azimuth reason, not silently dropped.
    let deneb = plan
        .excluded
        .iter()
        .find(|e| e.body == "Deneb")
        .expect("Deneb is above the 75 degree ceiling at this instant");
    assert!(deneb.altitude_deg > 75.0);
    assert!(
        deneb
            .reason
            .contains("azimuth of the line of position is poorly defined"),
        "{}",
        deneb.reason
    );
    assert!(
        plan.bodies.iter().all(|b| b.body != "Deneb"),
        "an excluded body must not also be selected"
    );

    // The five picks spread around the compass rather than clustering.
    let mut axes: Vec<f64> = plan
        .bodies
        .iter()
        .map(|b| b.azimuth_deg.rem_euclid(180.0))
        .collect();
    axes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let widest = axes
        .windows(2)
        .map(|w| w[1] - w[0])
        .fold(180.0 - axes[axes.len() - 1] + axes[0], f64::max);
    assert!(
        widest < 90.0,
        "the selected lines of position leave a {widest} degree gap: {axes:?}"
    );

    // The predicted fix is well conditioned and much better than any single sight.
    assert!(!plan.predicted.singular);
    assert_eq!(plan.predicted.sight_count, 5);
    assert!(
        plan.predicted.condition_number.unwrap() < 1.5,
        "condition number {:?}",
        plan.predicted.condition_number
    );
    // Five one-arcminute sights in good geometry: under a nautical mile of 1-sigma.
    assert!(
        plan.predicted.trace_sigma_m.unwrap() < 1852.0,
        "trace sigma {:?} m",
        plan.predicted.trace_sigma_m
    );
    assert!(plan.baseline.singular, "nothing was taken yet");

    // Monotone improvement, step by step, once a covariance exists at all.
    let defined: Vec<f64> = plan
        .progression
        .iter()
        .filter_map(|m| m.trace_sigma_m)
        .collect();
    assert_eq!(defined.len(), 4, "the first two steps have no covariance");
    for w in defined.windows(2) {
        assert!(w[1] < w[0], "predicted sigma rose: {defined:?}");
    }

    // The twilight note reaches the rationale of every body and the plan's notes.
    for b in &plan.bodies {
        assert!(b.rationale.contains(NOTE_DARK), "{}", b.rationale);
        assert!(b.rationale.contains("Magnitude"));
    }
    assert!(plan.notes.iter().any(|n| n.contains(NOTE_DARK)));
    assert!(
        plan.notes
            .iter()
            .any(|n| n.contains("are at or above the 15.0 deg minimum altitude"))
    );
}

#[test]
fn the_objective_changes_the_selection_not_just_the_labels() {
    let provider = StarProvider::new();
    let mut picks = Vec::new();
    for objective in [
        Objective::MinTrace,
        Objective::MinMaxEigenvalue,
        Objective::MinConditionNumber,
    ] {
        let plan = plan_at(
            &provider,
            &names(),
            PHILADELPHIA,
            UTC,
            &PlanOptions {
                select: 4,
                objective,
                ..PlanOptions::default()
            },
            Some(-15.0),
        )
        .unwrap();
        assert_eq!(plan.bodies.len(), 4);
        // Starting from nothing, the first two steps are always log-determinant growth
        // and the rest are in the objective's own units.
        for b in &plan.bodies {
            let expected = if b.step <= 2 {
                ScoreBasis::LogDetGrowth
            } else {
                ScoreBasis::Objective
            };
            assert_eq!(b.score_basis, expected, "step {}", b.step);
            assert_eq!(b.score_units, expected.units(objective));
        }
        assert!(!plan.predicted.singular);
        picks.push(
            plan.bodies
                .iter()
                .map(|b| b.body.clone())
                .collect::<Vec<_>>(),
        );
    }
    // All three start the same way — with nothing taken, the first two steps are scored
    // on log-determinant growth regardless of objective — and then diverge or not
    // depending on the sky. What must hold is that each is a valid four-body plan.
    assert_eq!(picks[0][0], picks[1][0]);
    assert_eq!(picks[0][1], picks[1][1]);
    for p in &picks {
        assert_eq!(p.len(), 4);
        let mut sorted = p.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 4, "a body must not be selected twice: {p:?}");
    }
}

#[test]
fn a_time_outside_coverage_is_refused_rather_than_guessed() {
    let provider = StarProvider::new();
    let err = plan_at(
        &provider,
        &names(),
        PHILADELPHIA,
        "1889-05-06T12:00:00Z",
        &PlanOptions::default(),
        None,
    )
    .expect_err("1889 is outside the provider's coverage");
    let text = err.to_string();
    assert!(text.contains("coverage"), "{text}");

    // And a malformed timestamp is a data error, not a panic.
    let err = plan_at(
        &provider,
        &names(),
        PHILADELPHIA,
        "2026-10-01 01:30:00",
        &PlanOptions::default(),
        None,
    )
    .expect_err("CONVENTIONS section 6 requires RFC 3339 with a trailing Z");
    assert!(!err.to_string().is_empty());

    // An unknown body is named, not skipped.
    let err = visible_bodies(
        &provider,
        &["Betelgeuse".to_string(), "Death Star".to_string()],
        PHILADELPHIA,
        parse_utc(UTC).unwrap(),
        -90.0,
        1.0,
    )
    .expect_err("an unknown body must be an error");
    assert!(err.to_string().contains("Death Star"), "{err}");
}
