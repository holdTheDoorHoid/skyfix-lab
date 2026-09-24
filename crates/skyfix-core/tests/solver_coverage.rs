//! Seeded Monte Carlo coverage of the nominal 95 % ellipse (CONVENTIONS section 9,
//! BRIEF "Validation that matters").
//!
//! The ellipse claims that, under the independent-noise model, the truth falls inside it
//! 95 % of the time. These tests check that claim by simulation with a self-contained
//! deterministic generator, and then break it on purpose with a correlated error, because
//! a coverage number is only meaningful next to the case where it fails.

mod solver_support;

use skyfix_core::geometry::Point;
use skyfix_core::solver::solve;
use skyfix_core::types::{FixResult, LatLon, MultistartOptions, Sight, SolveOptions};
use skyfix_core::units::{ARCMIN, CHI2_95_2DOF};
use solver_support::*;

const TRIALS: usize = 2000;
/// Four stars spread around the compass, but not symmetrically: an exactly balanced set
/// would absorb a shared bias into the residuals and hide the correlated-error failure.
const LAYOUT: [(f64, f64); 4] = [(0.0, 42.0), (70.0, 28.0), (140.0, 55.0), (210.0, 33.0)];

fn layout_sights(truth: Point, sigma_arcmin: f64) -> Vec<Sight> {
    LAYOUT
        .iter()
        .enumerate()
        .map(|(k, &(zn, alt))| {
            let s = sight_at(&format!("m{k}"), "Star", truth, zn, alt, sigma_arcmin);
            check_sight(&s, truth, zn, alt);
            s
        })
        .collect()
}

/// A local solve: a fixed initializer well away from truth, no global grid. Multistart
/// correctness is covered elsewhere; here 2000 trials should not pay for 400 starts each.
fn local_options() -> SolveOptions {
    SolveOptions {
        initializer: Some(LatLon {
            lat_deg: 40.4,
            lon_deg: -74.7,
        }),
        multistart: MultistartOptions {
            enabled: false,
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn nominal_ellipse_covers_the_truth_95_percent_of_the_time() {
    let truth = philadelphia();
    let sigma_arcmin = 1.0;
    let base = layout_sights(truth, sigma_arcmin);
    let options = local_options();

    let mut rng = Rng::new(0xC0FF_EE01);
    let mut inside = 0usize;
    let mut solved = 0usize;
    for _ in 0..TRIALS {
        let noisy: Vec<Sight> = base
            .iter()
            .map(|s| {
                let mut s = s.clone();
                s.ho_rad += sigma_arcmin * rng.next_normal() * ARCMIN;
                s
            })
            .collect();
        let result = solve(&noisy, &options);
        let FixResult::Unique { fix, .. } = &result else {
            panic!("trial did not produce a unique fix: {result:#?}");
        };
        assert!(
            fix.ellipse95.is_some(),
            "every trial should support an ellipse"
        );
        solved += 1;
        if mahalanobis2(point_of(fix.position), truth, fix.covariance_ne_m2) <= CHI2_95_2DOF {
            inside += 1;
        }
    }
    assert_eq!(solved, TRIALS);
    let coverage = inside as f64 / TRIALS as f64;
    let standard_error = (0.95 * 0.05 / TRIALS as f64).sqrt();
    println!(
        "independent noise: {inside}/{TRIALS} inside the nominal 95 % ellipse = {coverage:.4} \
         (binomial standard error {standard_error:.4})"
    );
    assert!(
        (0.93..=0.97).contains(&coverage),
        "coverage {coverage:.4} is outside 0.95 +/- 0.02 ({inside}/{TRIALS})"
    );
}

/// The same geometry and the same 1-sigma claim, but every sight in a set shares one
/// error. Repeating the observation shrinks the reported covariance and does nothing at
/// all to the error, so the nominal ellipse stops meaning what it says.
#[test]
fn a_shared_error_collapses_the_nominal_coverage() {
    let truth = philadelphia();
    let sigma_arcmin = 1.0;
    let bias_sigma_arcmin = 2.0;
    let rounds = 6; // 24 sights: the reported covariance shrinks by a factor of 6.
    let options = local_options();

    let mut base = Vec::new();
    for round in 0..rounds {
        for (k, &(zn, alt)) in LAYOUT.iter().enumerate() {
            base.push(sight_at(
                &format!("r{round}m{k}"),
                "Star",
                truth,
                zn,
                alt,
                sigma_arcmin,
            ));
        }
    }
    assert_eq!(base.len(), rounds * LAYOUT.len());

    let mut rng = Rng::new(0xC0FF_EE02);
    let mut inside = 0usize;
    for _ in 0..TRIALS {
        let bias = bias_sigma_arcmin * rng.next_normal() * ARCMIN;
        let biased: Vec<Sight> = base
            .iter()
            .map(|s| {
                let mut s = s.clone();
                s.ho_rad += bias;
                s
            })
            .collect();
        let result = solve(&biased, &options);
        let FixResult::Unique { fix, .. } = &result else {
            panic!("trial did not produce a unique fix: {result:#?}");
        };
        if mahalanobis2(point_of(fix.position), truth, fix.covariance_ne_m2) <= CHI2_95_2DOF {
            inside += 1;
        }
    }
    let coverage = inside as f64 / TRIALS as f64;
    println!(
        "shared bias (sigma {bias_sigma_arcmin}', {rounds} rounds of {} sights): \
         {inside}/{TRIALS} inside = {coverage:.4} - the independent-noise model is simply wrong here",
        LAYOUT.len()
    );
    assert!(
        coverage < 0.80,
        "coverage {coverage:.4} did not collapse; the correlated-error failure is not being shown"
    );
}

/// With the shared bias estimated as a third unknown, the covariance has to account for
/// the extra parameter; this is the coverage check for that three-unknown covariance.
#[test]
fn coverage_holds_when_the_shared_bias_is_estimated() {
    let truth = philadelphia();
    let sigma_arcmin = 1.0;
    let bias_sigma_arcmin = 2.0;
    let mut base = Vec::new();
    for round in 0..2 {
        for (k, &(zn, alt)) in LAYOUT.iter().enumerate() {
            base.push(sight_at(
                &format!("r{round}m{k}"),
                "Star",
                truth,
                zn,
                alt,
                sigma_arcmin,
            ));
        }
    }
    let options = SolveOptions {
        estimate_shared_bias: true,
        ..local_options()
    };

    let mut rng = Rng::new(0xC0FF_EE03);
    let mut inside = 0usize;
    let mut bias_inside = 0usize;
    for _ in 0..TRIALS {
        let bias = bias_sigma_arcmin * rng.next_normal();
        let noisy: Vec<Sight> = base
            .iter()
            .map(|s| {
                let mut s = s.clone();
                s.ho_rad += (bias + sigma_arcmin * rng.next_normal()) * ARCMIN;
                s
            })
            .collect();
        let result = solve(&noisy, &options);
        let FixResult::Unique { fix, .. } = &result else {
            panic!("trial did not produce a unique fix: {result:#?}");
        };
        if mahalanobis2(point_of(fix.position), truth, fix.covariance_ne_m2) <= CHI2_95_2DOF {
            inside += 1;
        }
        if (fix.shared_bias_arcmin.unwrap() - bias).abs() < 3.0 * sigma_arcmin {
            bias_inside += 1;
        }
    }
    let coverage = inside as f64 / TRIALS as f64;
    println!(
        "estimated shared bias: {inside}/{TRIALS} positions inside the nominal 95 % ellipse = \
         {coverage:.4}; {bias_inside}/{TRIALS} bias estimates within 3 sigma"
    );
    assert!(
        (0.93..=0.97).contains(&coverage),
        "three-unknown coverage {coverage:.4} is outside 0.95 +/- 0.02 ({inside}/{TRIALS})"
    );
}
