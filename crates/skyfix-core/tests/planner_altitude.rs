//! Altitude rules: the sigma inflation that makes a higher body worth more, and the two
//! exclusion bounds with their reasons.

use skyfix_core::corrections::{
    LOW_ALTITUDE_FLAG_THRESHOLD_DEG, LOW_ALTITUDE_SIGMA_ARCMIN, LOW_ALTITUDE_SIGMA_THRESHOLD_DEG,
};
use skyfix_core::planner::{
    Candidate, MODERATE_ALTITUDE_SIGMA_ARCMIN, PlanOptions, expected_sigma_arcmin, rank,
};
use skyfix_core::types::LatLon;

const PHILADELPHIA: LatLon = LatLon {
    lat_deg: 39.9526,
    lon_deg: -75.1652,
};
const UTC: &str = "2026-10-01T01:30:00Z";

fn planned(body: &str, altitude_deg: f64, azimuth_deg: f64) -> Candidate {
    Candidate::new(
        body,
        altitude_deg,
        azimuth_deg,
        expected_sigma_arcmin(1.0, altitude_deg),
    )
}

#[test]
fn the_inflation_is_the_conventions_rule_plus_one_documented_planning_term() {
    let base = 1.0;
    // Section 5: 1.0' in quadrature below 5 degrees.
    let low = expected_sigma_arcmin(base, LOW_ALTITUDE_SIGMA_THRESHOLD_DEG - 0.1);
    assert!((low - (base * base + LOW_ALTITUDE_SIGMA_ARCMIN.powi(2)).sqrt()).abs() < 1e-12);
    // The planning-only term in the 5-10 band.
    let mid = expected_sigma_arcmin(base, LOW_ALTITUDE_FLAG_THRESHOLD_DEG - 0.1);
    assert!((mid - (base * base + MODERATE_ALTITUDE_SIGMA_ARCMIN.powi(2)).sqrt()).abs() < 1e-12);
    // Nothing at all above the flag threshold.
    assert!((expected_sigma_arcmin(base, LOW_ALTITUDE_FLAG_THRESHOLD_DEG) - base).abs() < 1e-12);
    // Strictly ordered: lower is always worse, never better.
    assert!(low > mid && mid > base);
    // The two terms are never both applied.
    assert!(low < (base * base + 1.0 + 0.09).sqrt());
}

#[test]
fn between_two_bodies_on_one_azimuth_the_higher_one_wins() {
    // Same azimuth, so they carry exactly the same direction of information: only the
    // expected sigma can separate them.
    let candidates = vec![planned("Low-8", 8.0, 90.0), planned("High-40", 40.0, 90.0)];
    assert!(candidates[0].sigma_arcmin > candidates[1].sigma_arcmin);

    let options = PlanOptions {
        // 8 degrees is below the default floor, so this sub-test lowers it deliberately.
        min_altitude_deg: 5.0,
        ..PlanOptions::default()
    };
    let plan = rank(&candidates, PHILADELPHIA, UTC, &options);
    assert_eq!(plan.bodies.len(), 2);
    assert_eq!(
        plan.bodies[0].body, "High-40",
        "the higher body must be ranked first: {:?}",
        plan.bodies
            .iter()
            .map(|b| (b.body.clone(), b.score))
            .collect::<Vec<_>>()
    );
    assert!(plan.bodies[0].score > plan.bodies[1].score);

    // The low body's rationale says why it is worth less.
    let low = &plan.bodies[1];
    assert!(
        low.rationale.contains("Low altitude 8 deg")
            && low.rationale.contains("refraction uncertainty inflated to"),
        "{}",
        low.rationale
    );
    // The high body carries no such note.
    assert!(!plan.bodies[0].rationale.contains("Low altitude"));
}

#[test]
fn a_three_degree_body_is_excluded_at_the_default_floor_and_the_reason_is_kept() {
    let candidates = vec![
        planned("Grazing-3", 3.0, 180.0),
        planned("Fine-45", 45.0, 180.0),
    ];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &PlanOptions::default());

    assert_eq!(plan.bodies.len(), 1);
    assert_eq!(plan.bodies[0].body, "Fine-45");

    let excluded = plan
        .excluded
        .iter()
        .find(|e| e.body == "Grazing-3")
        .expect("the 3-degree body must be reported as excluded");
    assert!(
        excluded.reason.contains("below the 15.0 deg minimum"),
        "{}",
        excluded.reason
    );
    assert!(
        excluded.reason.contains("refraction"),
        "the reason must say why: {}",
        excluded.reason
    );
    assert!(
        plan.notes
            .iter()
            .any(|n| n.contains("excluded Grazing-3") && n.contains("below the 15.0 deg minimum")),
        "the exclusion must also reach Plan.notes: {:?}",
        plan.notes
    );
    assert_eq!(excluded.altitude_deg, 3.0);
}

#[test]
fn a_near_zenith_body_at_eighty_degrees_is_excluded_for_its_azimuth_not_its_brightness() {
    let mut zenith = planned("Overhead-80", 80.0, 250.0);
    zenith.magnitude = Some(-1.4); // the brightest thing in the list, and still excluded
    let candidates = vec![zenith, planned("Workable-60", 60.0, 250.0)];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &PlanOptions::default());

    assert_eq!(plan.bodies.len(), 1);
    assert_eq!(plan.bodies[0].body, "Workable-60");

    let excluded = plan
        .excluded
        .iter()
        .find(|e| e.body == "Overhead-80")
        .expect("the 80-degree body must be reported as excluded");
    assert!(
        excluded.reason.contains("above the 75.0 deg maximum"),
        "{}",
        excluded.reason
    );
    assert!(
        excluded.reason.contains("azimuth of the line of position is poorly defined"),
        "the near-zenith reason must be the azimuth one: {}",
        excluded.reason
    );
    assert!(plan.notes.iter().any(|n| n.contains("excluded Overhead-80")));

    // Raising the ceiling lets it back in: the bound is an option, not a law of nature.
    let relaxed = PlanOptions {
        max_altitude_deg: 85.0,
        ..PlanOptions::default()
    };
    let plan = rank(&candidates, PHILADELPHIA, UTC, &relaxed);
    assert_eq!(plan.bodies.len(), 2);
    assert!(plan.excluded.is_empty());
}

#[test]
fn already_taken_sights_are_facts_and_the_altitude_window_does_not_apply_to_them() {
    // A sight already taken at 82 degrees still shapes the geometry it produced.
    let options = PlanOptions {
        select: 1,
        already_taken: vec![planned("Taken-82", 82.0, 0.0), planned("Taken-4", 4.0, 3.0)],
        ..PlanOptions::default()
    };
    let candidates = vec![planned("Cross", 45.0, 92.0)];
    let plan = rank(&candidates, PHILADELPHIA, UTC, &options);
    assert_eq!(plan.baseline.sight_count, 2, "both taken sights count");
    assert!(
        plan.excluded.is_empty(),
        "already-taken sights are never excluded: {:?}",
        plan.excluded
    );
    assert_eq!(plan.bodies.len(), 1);
    assert!(!plan.predicted.singular);
}
