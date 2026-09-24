//! What goes wrong, and whether the solver says so: one bad sight, a shared instrument
//! bias that averaging cannot remove, clock uncertainty, priors, and awkward geometry.
//! CONVENTIONS sections 6, 8 and 9; BRIEF "Non-negotiable physical distinctions" 3 and 6.

mod solver_support;

use skyfix_core::geometry::{self, Point};
use skyfix_core::solver::solve;
use skyfix_core::types::{
    FixResult, LatLon, MultistartOptions, PositionPrior, RobustOptions, Sight, SolveOptions,
    Warning,
};
use skyfix_core::units::{CHI2_95_2DOF, NM_M, SIDEREAL_RATE_DEG_PER_HOUR, rad_to_m, rad_to_nm};
use solver_support::*;

fn local_options(lat_deg: f64, lon_deg: f64) -> SolveOptions {
    SolveOptions {
        initializer: Some(LatLon { lat_deg, lon_deg }),
        multistart: MultistartOptions {
            enabled: false,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Five well-spread stars at usable altitudes.
fn five_stars(truth: Point, sigma_arcmin: f64) -> Vec<Sight> {
    [
        ("s1", 12.0, 48.0),
        ("s2", 84.0, 31.0),
        ("s3", 155.0, 57.0),
        ("s4", 228.0, 22.0),
        ("s5", 300.0, 40.0),
    ]
    .iter()
    .map(|&(id, zn, alt)| {
        let s = sight_at(id, "Star", truth, zn, alt, sigma_arcmin);
        check_sight(&s, truth, zn, alt);
        s
    })
    .collect()
}

#[test]
fn one_wrong_sight_shows_up_as_a_large_normalised_residual() {
    let truth = philadelphia();
    let mut sights = five_stars(truth, 1.0);
    sights[2] = with_error(sights[2].clone(), 10.0); // "s3" reads 10 arcminutes too high

    let options = local_options(40.2, -75.0);
    let plain = solve(&sights, &options);
    let fix = unique(&plain);

    let bad = fix.residuals.iter().find(|r| r.id == "s3").unwrap();
    assert!(
        bad.normalized > 5.0,
        "the wrong sight should stand out: normalized = {:.2}",
        bad.normalized
    );
    let worst_other = fix
        .residuals
        .iter()
        .filter(|r| r.id != "s3")
        .map(|r| r.normalized.abs())
        .fold(0.0f64, f64::max);
    assert!(
        bad.normalized > 1.5 * worst_other,
        "the blunder ({:.2}) should dominate the redistributed residuals ({worst_other:.2})",
        bad.normalized
    );
    for r in &fix.residuals {
        // Reported normalisation is exactly residual / sigma.
        let sigma_arcmin =
            sights.iter().find(|s| s.id == r.id).unwrap().sigma_rad / skyfix_core::units::ARCMIN;
        assert!((r.normalized - r.residual_arcmin / sigma_arcmin).abs() < 1e-9);
    }
    let plain_error = distance_m(point_of(fix.position), truth);
    assert!(
        plain_error > 2000.0,
        "one 10' blunder should drag the fix: {plain_error:.0} m"
    );

    // Huber IRLS: the blunder is down-weighted and the fix walks back toward truth.
    let robust_options = SolveOptions {
        robust: Some(RobustOptions::default()),
        ..options.clone()
    };
    let robust = solve(&sights, &robust_options);
    let rfix = unique(&robust);
    let report = rfix.robust.as_ref().expect("a robust report");
    assert_eq!(report.downweighted_ids, vec!["s3".to_string()]);
    assert_eq!(report.huber_k, 1.5);
    assert!(
        report.note.contains("APPROXIMATE"),
        "the covariance caveat must be visible: {}",
        report.note
    );
    assert!(
        warnings_of(&robust)
            .iter()
            .any(|w| matches!(w, Warning::RobustWeightsApplied { .. }))
    );
    let bad_weight = rfix.residuals.iter().find(|r| r.id == "s3").unwrap().weight;
    assert!(bad_weight < 0.3, "weight on the blunder: {bad_weight}");
    for r in rfix.residuals.iter().filter(|r| r.id != "s3") {
        assert_eq!(r.weight, 1.0, "{} should keep full weight", r.id);
    }
    let robust_error = distance_m(point_of(rfix.position), truth);
    assert!(
        robust_error < 0.4 * plain_error,
        "robust error {robust_error:.0} m vs plain {plain_error:.0} m"
    );
}

/// Section 6 / BRIEF distinction 6: repeating a measurement does not average away a bias
/// that every measurement shares. Residuals stay tiny while the fix is miles out, and the
/// nominal ellipse - which only knows about independent noise - does not cover the truth.
#[test]
fn a_shared_bias_survives_repetition_and_breaks_the_ellipse() {
    let truth = philadelphia();
    let bias_arcmin = 2.0;
    let sigma = 0.2;
    // Three stars inside a 40 degree azimuth window, each observed four times. A common
    // bias is then almost entirely absorbable by moving the fix, which is exactly why the
    // residuals look innocent.
    let mut rng = Rng::new(0x5F1E_0001);
    let mut sights = Vec::new();
    for round in 0..4 {
        for (k, (zn, alt)) in [(0.0, 35.0), (20.0, 50.0), (40.0, 28.0)]
            .into_iter()
            .enumerate()
        {
            let mut s = sight_at(&format!("r{round}s{k}"), "Star", truth, zn, alt, sigma);
            check_sight(&s, truth, zn, alt);
            s.ho_rad += (bias_arcmin + sigma * rng.next_normal()) * skyfix_core::units::ARCMIN;
            sights.push(s);
        }
    }
    assert_eq!(sights.len(), 12);

    let result = solve(&sights, &local_options(40.2, -75.0));
    let fix = unique(&result);
    assert_eq!(fix.dof, 10);

    let worst = fix
        .residuals
        .iter()
        .map(|r| r.normalized.abs())
        .fold(0.0f64, f64::max);
    assert!(
        worst < 3.0,
        "the residuals must look innocent; worst normalized = {worst:.2}"
    );

    let error_m = distance_m(point_of(fix.position), truth);
    let error_nm = error_m / NM_M;
    assert!(
        (1.5..3.5).contains(&error_nm),
        "expected roughly 2 NM of bias-driven error, got {error_nm:.2} NM"
    );
    // ...and it lies along the mean azimuth of the cluster (20 degrees).
    let bearing = geometry::initial_bearing(truth, point_of(fix.position)).to_degrees();
    let off = (bearing - 20.0).rem_euclid(360.0);
    let off = off.min(360.0 - off);
    assert!(
        off < 15.0,
        "error bearing {bearing:.1} deg, mean azimuth 20 deg"
    );

    let ellipse = fix
        .ellipse95
        .as_ref()
        .expect("the geometry still supports an ellipse");
    assert!(
        error_m > ellipse.semi_major_m,
        "the nominal 95 % ellipse (semi-major {:.0} m) must fail to cover a {error_m:.0} m error",
        ellipse.semi_major_m
    );
    assert!(
        mahalanobis2(point_of(fix.position), truth, fix.covariance_ne_m2) > CHI2_95_2DOF,
        "truth must fall outside the nominal 95 % region"
    );
    assert!(fix.shared_bias_arcmin.is_none(), "bias estimation was off");
}

/// The same bias, but with enough azimuth spread and the third unknown switched on.
#[test]
fn estimating_the_shared_bias_recovers_it_and_the_position() {
    let truth = philadelphia();
    let bias_arcmin = 2.0;
    let sigma = 0.05;
    let options = SolveOptions {
        estimate_shared_bias: true,
        ..local_options(40.2, -75.0)
    };
    // A hundred deterministic draws: a single draw would be a coin toss against a 95 %
    // region. The coverage claim itself is measured over 2000 trials in `solver_coverage`.
    let mut rng = Rng::new(0x5F1E_0002);
    let mut inside = 0usize;
    let draws = 100;
    for draw in 0..draws {
        let mut sights = Vec::new();
        for round in 0..2 {
            for (k, (zn, alt)) in [(20.0, 44.0), (100.0, 31.0), (195.0, 55.0), (300.0, 26.0)]
                .into_iter()
                .enumerate()
            {
                let mut s = sight_at(&format!("r{round}s{k}"), "Star", truth, zn, alt, sigma);
                check_sight(&s, truth, zn, alt);
                s.ho_rad += (bias_arcmin + sigma * rng.next_normal()) * skyfix_core::units::ARCMIN;
                sights.push(s);
            }
        }
        let result = solve(&sights, &options);
        let fix = unique(&result);
        let recovered = fix.shared_bias_arcmin.expect("a shared bias estimate");
        assert!(
            (recovered - bias_arcmin).abs() < 0.1,
            "draw {draw}: recovered bias {recovered:.4}', truth {bias_arcmin}'"
        );
        assert_eq!(fix.dof, 5, "eight sights, three unknowns");
        assert_eq!(
            fix.conditioning.columns, "position (north, east) and shared bias",
            "the conditioning must include the bias column"
        );
        assert_eq!(fix.conditioning.rank, 3);
        assert_eq!(fix.conditioning.singular_values.len(), 3);
        if mahalanobis2(point_of(fix.position), truth, fix.covariance_ne_m2) < CHI2_95_2DOF {
            inside += 1;
        }
    }
    assert!(
        inside >= 87,
        "only {inside}/{draws} draws put the truth inside the 95 % region"
    );
}

/// A shared bias is nearly collinear with position when every body lies one way, so the
/// conditioning of the three-unknown problem has to show it.
#[test]
fn a_bias_column_is_collinear_with_position_when_the_azimuths_cluster() {
    let truth = philadelphia();
    let clustered: Vec<Sight> = [(0.0, 35.0), (20.0, 50.0), (40.0, 28.0), (15.0, 62.0)]
        .iter()
        .enumerate()
        .map(|(k, &(zn, alt))| sight_at(&format!("c{k}"), "Star", truth, zn, alt, 1.0))
        .collect();
    let spread: Vec<Sight> = [(20.0, 44.0), (100.0, 31.0), (195.0, 55.0), (300.0, 26.0)]
        .iter()
        .enumerate()
        .map(|(k, &(zn, alt))| sight_at(&format!("s{k}"), "Star", truth, zn, alt, 1.0))
        .collect();

    let options = SolveOptions {
        estimate_shared_bias: true,
        ..local_options(40.2, -75.0)
    };
    let c = solve(&clustered, &options);
    let s = solve(&spread, &options);

    match &c {
        FixResult::Unique { fix, .. } => {
            assert!(
                fix.conditioning.condition_number > 20.0,
                "clustered + bias should be badly conditioned, got {}",
                fix.conditioning.condition_number
            );
            assert!(has_poor_geometry(&c), "PoorGeometry must fire");
        }
        FixResult::Underdetermined { reason, .. } => {
            // Acceptable and equally honest: the three unknowns are not separable at all.
            assert!(reason.contains("unknowns"), "reason: {reason}");
        }
        other => panic!("unexpected result {other:#?}"),
    }
    let sf = unique(&s);
    assert!(
        sf.conditioning.condition_number < 20.0,
        "spread + bias should stay well conditioned, got {}",
        sf.conditioning.condition_number
    );
}

/// Section 6: clock uncertainty is propagated east-west, never estimated.
#[test]
fn clock_uncertainty_inflates_only_the_east_west_term() {
    let truth = philadelphia();
    let sights = five_stars(truth, 1.0);
    let base = local_options(40.2, -75.0);
    let clocked = SolveOptions {
        clock_uncertainty_s: 2.0,
        ..base.clone()
    };

    let a = solve(&sights, &base);
    let b = solve(&sights, &clocked);
    let (fa, fb) = (unique(&a), unique(&b));

    let omega = SIDEREAL_RATE_DEG_PER_HOUR.to_radians() / 3600.0;
    let expected = rad_to_m(truth.lat.cos() * omega * 2.0);
    assert!(
        (fb.clock_sigma_east_m - expected).abs() < 1e-6,
        "clock_sigma_east_m {} m, expected {expected} m",
        fb.clock_sigma_east_m
    );
    // Sanity on the magnitude: about 0.384 NM at 39.95 N for a 2 s uncertainty.
    let nm = fb.clock_sigma_east_m / NM_M;
    assert!(
        (0.37..0.40).contains(&nm),
        "expected about 0.384 NM of east-west clock term, got {nm:.4} NM"
    );

    assert_eq!(fa.clock_sigma_east_m, 0.0);
    assert!(
        (fb.sigma_north_m - fa.sigma_north_m).abs() < 1e-9,
        "north sigma must not move: {} vs {}",
        fb.sigma_north_m,
        fa.sigma_north_m
    );
    assert!(
        (fb.covariance_ne_m2[0][0] - fa.covariance_ne_m2[0][0]).abs() < 1e-6,
        "north-north covariance must not move"
    );
    assert!(
        (fb.covariance_ne_m2[1][1] - fa.covariance_ne_m2[1][1] - expected * expected).abs() < 1e-3,
        "east-east covariance must grow by exactly the clock term"
    );
    assert_eq!(
        fb.covariance_ne_m2[0][1], fa.covariance_ne_m2[0][1],
        "the clock term is rank 1 in east and touches no cross term"
    );
    assert!(fb.sigma_east_m > fa.sigma_east_m);
    assert!(
        warnings_of(&b)
            .iter()
            .any(|w| matches!(w, Warning::ClockDegenerateWithLongitude { .. })),
        "the degeneracy must be stated: {:?}",
        warnings_of(&b)
    );
    assert!(
        !warnings_of(&a)
            .iter()
            .any(|w| matches!(w, Warning::ClockDegenerateWithLongitude { .. }))
    );
}

/// An assumed position is an initializer by default and a prior only when asked, and the
/// report says what the prior did.
#[test]
fn a_prior_is_reported_with_and_without() {
    let truth = philadelphia();
    let sights = five_stars(truth, 2.0);
    let centre = LatLon {
        lat_deg: 40.20,
        lon_deg: -75.00,
    };

    let plain = solve(&sights, &local_options(centre.lat_deg, centre.lon_deg));
    let plain_fix = unique(&plain);
    assert!(plain_fix.prior.is_none(), "an initializer is not a prior");

    let prior_options = SolveOptions {
        prior: Some(PositionPrior {
            center: centre,
            sigma_nm: 2.0,
        }),
        ..local_options(centre.lat_deg, centre.lon_deg)
    };
    let pulled = solve(&sights, &prior_options);
    let pfix = unique(&pulled);
    let report = pfix.prior.as_ref().expect("a prior report");
    assert_eq!(report.sigma_nm, 2.0);
    assert!(distance_m(point_of(report.center), point_of(centre)) < 1e-6);
    let without = report.fix_without_prior.expect("the data-only fix");
    assert!(
        distance_m(point_of(without), point_of(plain_fix.position)) < 1.0,
        "the without-prior fix must match the plain solve"
    );
    assert!(
        report.shift_m > 1.0,
        "the prior should actually move something"
    );
    assert!((report.shift_m - distance_m(point_of(pfix.position), point_of(without))).abs() < 1e-6);
    // The prior pulls the fix toward its centre.
    assert!(
        distance_m(point_of(pfix.position), point_of(centre))
            < distance_m(point_of(without), point_of(centre))
    );
    assert!(
        warnings_of(&pulled)
            .iter()
            .any(|w| matches!(w, Warning::PriorUsed { .. })),
        "PriorUsed must be emitted"
    );
}

// ---------------------------------------------------------------------------
// Edge cases (BRIEF "Validation that matters")
// ---------------------------------------------------------------------------

#[test]
fn high_and_southern_latitudes_and_a_near_zenith_body() {
    for (label, lat, lon) in [("85 N", 85.0, 12.0), ("-60 S", -60.0, -58.0)] {
        let truth = Point::from_deg(lat, lon);
        let sights = five_stars(truth, 1.0);
        let start = geometry::destination(truth, 1.0, 120.0 * skyfix_core::units::ARCMIN);
        let result = solve(&sights, &local_options(start.lat_deg(), start.lon_deg()));
        let fix = unique(&result);
        let err = distance_m(point_of(fix.position), truth);
        assert!(err < 10.0, "{label}: {err:.3} m from truth");
        assert!(
            fix.converged && fix.chi2 < 1e-9,
            "{label}: chi2 {}",
            fix.chi2
        );
    }

    // A body 0.5 degrees from the zenith: a 30 NM circle of position, and the tangent-plane
    // linearisation has to cope with it.
    let truth = philadelphia();
    let mut sights = five_stars(truth, 1.0);
    sights.push({
        let s = sight_at("zenith", "Overhead", truth, 245.0, 89.5, 1.0);
        check_sight(&s, truth, 245.0, 89.5);
        s
    });
    let result = solve(&sights, &local_options(40.2, -75.0));
    let fix = unique(&result);
    assert!(distance_m(point_of(fix.position), truth) < 10.0);
    let z = fix.residuals.iter().find(|r| r.id == "zenith").unwrap();
    assert!(
        (z.hc_deg - 89.5).abs() < 1e-9,
        "Hc near the zenith: {}",
        z.hc_deg
    );
}

#[test]
fn a_fix_on_the_dateline_survives_an_initializer_on_the_other_side() {
    let truth = Point::from_deg(10.0, 179.95);
    let sights = five_stars(truth, 1.0);
    // Start 1.05 degrees west in longitude terms, which is across the antimeridian.
    let result = solve(&sights, &local_options(10.3, -179.0));
    let fix = unique(&result);
    assert!(
        fix.position.lon_deg > 179.0,
        "longitude wrapped to the wrong side: {}",
        fix.position.lon_deg
    );
    let err = distance_m(point_of(fix.position), truth);
    assert!(err < 10.0, "{err:.3} m from truth across the dateline");

    // And the global grid finds it with no initializer at all.
    let grid = solve(&sights, &SolveOptions::default());
    assert!(distance_m(point_of(unique(&grid).position), truth) < 10.0);
}

#[test]
fn duplicated_sights_add_degrees_of_freedom_but_no_geometry() {
    let truth = philadelphia();
    let base: Vec<Sight> = five_stars(truth, 1.0)[..3].to_vec();
    let mut doubled = base.clone();
    for (i, s) in base.iter().enumerate() {
        let mut copy = s.clone();
        copy.id = format!("{}-dup{i}", s.id);
        doubled.push(copy);
    }

    let options = local_options(40.2, -75.0);
    let a = solve(&base, &options);
    let b = solve(&doubled, &options);
    let (fa, fb) = (unique(&a), unique(&b));

    assert_eq!(fa.dof, 1);
    assert_eq!(fb.dof, 4, "duplicates raise the degrees of freedom");
    assert_eq!(fa.conditioning.rank, 2);
    assert_eq!(fb.conditioning.rank, 2, "duplicates add no rank");
    assert!(distance_m(point_of(fa.position), point_of(fb.position)) < 1e-3);
    // Two identical observations halve the variance under the independent-noise model.
    assert!(
        (fa.covariance_ne_m2[0][0] / fb.covariance_ne_m2[0][0] - 2.0).abs() < 1e-6,
        "variance ratio {}",
        fa.covariance_ne_m2[0][0] / fb.covariance_ne_m2[0][0]
    );
    // The same geometry, so the same dilution.
    assert!(
        (fa.conditioning.geometric_dilution_m_per_arcmin
            / fb.conditioning.geometric_dilution_m_per_arcmin
            - 2f64.sqrt())
        .abs()
            < 1e-9
    );
    match warnings_of(&b)
        .iter()
        .find(|w| matches!(w, Warning::DuplicateObservation { .. }))
    {
        Some(Warning::DuplicateObservation { ids }) => assert_eq!(ids.len(), 6),
        other => panic!("expected a DuplicateObservation warning, got {other:?}"),
    }
    assert!(
        !warnings_of(&a)
            .iter()
            .any(|w| matches!(w, Warning::DuplicateObservation { .. }))
    );
}

#[test]
fn sigmas_of_very_different_magnitudes_weight_the_fit() {
    let truth = philadelphia();
    let mut sights = five_stars(truth, 1.0);
    sights[0].sigma_rad = 0.05 * skyfix_core::units::ARCMIN;
    sights[1].sigma_rad = 1.0 * skyfix_core::units::ARCMIN;
    sights[2].sigma_rad = 10.0 * skyfix_core::units::ARCMIN;
    sights[3].sigma_rad = 0.5 * skyfix_core::units::ARCMIN;
    sights[4].sigma_rad = 3.0 * skyfix_core::units::ARCMIN;
    let options = local_options(40.2, -75.0);

    // A 5 arcminute blunder on the sloppiest sight barely moves the fix...
    let mut sloppy = sights.clone();
    sloppy[2] = with_error(sloppy[2].clone(), 5.0);
    let sloppy_error = distance_m(point_of(unique(&solve(&sloppy, &options)).position), truth);

    // ...while the same blunder on the sharpest sight moves it a long way.
    let mut sharp = sights.clone();
    sharp[0] = with_error(sharp[0].clone(), 5.0);
    let sharp_error = distance_m(point_of(unique(&solve(&sharp, &options)).position), truth);

    assert!(
        sharp_error > 20.0 * sloppy_error,
        "sharp-sight blunder {sharp_error:.0} m vs sloppy-sight blunder {sloppy_error:.0} m"
    );
    let clean = solve(&sights, &options);
    let fix = unique(&clean);
    assert!(distance_m(point_of(fix.position), truth) < 10.0);
    assert!(fix.conditioning.singular_values.len() == 2);
    // The dilution is geometry only, so it ignores the sigmas entirely.
    let uniform: Vec<Sight> = five_stars(truth, 1.0);
    let uniform_result = solve(&uniform, &options);
    let uf = unique(&uniform_result);
    assert!(
        (fix.conditioning.geometric_dilution_m_per_arcmin
            - uf.conditioning.geometric_dilution_m_per_arcmin)
            .abs()
            < 1e-6,
        "dilution must not depend on the sigmas"
    );
}

#[test]
fn unusable_sights_are_reported_not_silently_dropped() {
    let truth = philadelphia();
    let mut sights = five_stars(truth, 1.0);
    sights[1].sigma_rad = 0.0;
    sights[3].ho_rad = f64::NAN;

    let result = solve(&sights, &local_options(40.2, -75.0));
    let fix = unique(&result);
    assert_eq!(fix.residuals.len(), 3);
    assert_eq!(fix.dof, 1);
    let message = warnings_of(&result)
        .iter()
        .find_map(|w| match w {
            Warning::Other { message } => Some(message.clone()),
            _ => None,
        })
        .expect("a warning naming the dropped sights");
    assert!(
        message.contains("s2") && message.contains("s4"),
        "message: {message}"
    );
}

#[test]
fn a_hopeless_iteration_budget_fails_instead_of_guessing() {
    let truth = philadelphia();
    let sights = five_stars(truth, 1.0);
    let options = SolveOptions {
        max_iterations: 1,
        step_tolerance_rad: 1e-18,
        ..local_options(10.0, 10.0)
    };
    match solve(&sights, &options) {
        FixResult::Failed { reason, warnings } => {
            assert!(reason.contains("no start converged"), "reason: {reason}");
            assert!(
                warnings
                    .iter()
                    .any(|w| matches!(w, Warning::NotConverged { .. }))
            );
        }
        other => panic!("expected failure, got {other:#?}"),
    }
}

#[test]
fn the_reported_intercept_is_the_classical_ho_minus_hc() {
    let truth = philadelphia();
    let mut sights = five_stars(truth, 1.0);
    sights[0] = with_error(sights[0].clone(), 4.0);
    let result = solve(&sights, &local_options(40.2, -75.0));
    let fix = unique(&result);
    let p = point_of(fix.position);
    for r in &fix.residuals {
        let s = sights.iter().find(|s| s.id == r.id).unwrap();
        let hc = geometry::altitude(p, s.gha_rad, s.dec_rad);
        assert!(
            (r.intercept_nm - rad_to_nm(s.ho_rad - hc)).abs() < 1e-9,
            "{}: intercept {} NM",
            r.id,
            r.intercept_nm
        );
        // With no shared bias the intercept in NM and the residual in arcminutes agree.
        assert!((r.intercept_nm - r.residual_arcmin).abs() < 1e-9);
    }
}
