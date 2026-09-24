//! Core solver behaviour: a clean three-star fix, the one-sight and two-sight
//! observability limits, geometry conditioning, and the Jacobian itself.
//! CONVENTIONS sections 8 and 9.

mod solver_support;

use skyfix_core::geometry::{self, CircleIntersection, Point};
use skyfix_core::solver::solve;
use skyfix_core::types::{FixResult, LatLon, MultistartOptions, SolveOptions, Warning};
use skyfix_core::units::{ARCMIN, rad_to_nm};
use solver_support::*;
use std::f64::consts::FRAC_PI_2;

/// Three stars 120 degrees apart at usable altitudes: the well-conditioned reference.
fn three_well_spread(truth: Point, sigma: f64) -> Vec<skyfix_core::types::Sight> {
    let layout = [
        ("s1", "Vega", 35.0, 52.0),
        ("s2", "Altair", 155.0, 38.0),
        ("s3", "Kochab", 275.0, 44.0),
    ];
    layout
        .iter()
        .map(|&(id, body, zn, alt)| {
            let s = sight_at(id, body, truth, zn, alt, sigma);
            check_sight(&s, truth, zn, alt);
            s
        })
        .collect()
}

#[test]
fn three_clean_stars_recover_philadelphia_from_every_start() {
    let truth = philadelphia();
    let sights = three_well_spread(truth, 0.1);

    // (a) a nearby initializer, (b) one 3000 NM away, (c) none at all (grid only).
    let far = geometry::destination(truth, 70f64.to_radians(), 3000.0 * ARCMIN);
    let starts: [(&str, Option<LatLon>); 3] = [
        (
            "near",
            Some(LatLon {
                lat_deg: 40.5,
                lon_deg: -74.5,
            }),
        ),
        (
            "3000 NM away",
            Some(LatLon {
                lat_deg: far.lat_deg(),
                lon_deg: far.lon_deg(),
            }),
        ),
        ("grid only", None),
    ];
    assert!(
        (rad_to_nm(geometry::angular_distance(truth, far)) - 3000.0).abs() < 1e-6,
        "the far initializer must really be 3000 NM away"
    );

    for (label, initializer) in starts {
        let options = SolveOptions {
            initializer,
            ..Default::default()
        };
        let result = solve(&sights, &options);
        let fix = unique(&result);
        let err = distance_m(point_of(fix.position), truth);
        assert!(
            err < 10.0,
            "{label}: recovered position is {err:.3} m from truth"
        );
        assert!(fix.chi2 < 1e-9, "{label}: chi2 = {}", fix.chi2);
        assert!(fix.converged, "{label}: did not converge");
        assert!(
            fix.iterations < 10,
            "{label}: took {} iterations",
            fix.iterations
        );
        assert_eq!(fix.dof, 1, "{label}: three sights, two unknowns");
        assert!(
            fix.shared_bias_arcmin.is_none(),
            "{label}: bias is off by default"
        );

        let ellipse = fix
            .ellipse95
            .as_ref()
            .unwrap_or_else(|| panic!("{label}: no ellipse"));
        assert_eq!(ellipse.model, "nominal 95 %, independent-noise model");
        assert_eq!(ellipse.confidence, 0.95);
        // sigma 0.1' on three well-spread sights: a few hundred metres at 95 %.
        assert!(
            ellipse.semi_major_m > 100.0 && ellipse.semi_major_m < 1000.0,
            "{label}: semi-major {} m",
            ellipse.semi_major_m
        );
        assert!(ellipse.orientation_deg >= 0.0 && ellipse.orientation_deg < 180.0);
        assert!(
            !has_poor_geometry(&result),
            "{label}: geometry should be good"
        );
        assert!(
            fix.conditioning.condition_number < 2.0,
            "{label}: condition number {}",
            fix.conditioning.condition_number
        );
        assert_eq!(fix.conditioning.rank, 2);
        assert_eq!(fix.conditioning.columns, "position (north, east)");
        assert!(fix.residuals.iter().all(|r| r.residual_arcmin.abs() < 1e-6));
        assert!(fix.residuals.iter().all(|r| r.weight == 1.0));
        assert!(fix.posterior_scaled.is_none(), "not requested by default");
        assert_eq!(fix.clock_sigma_east_m, 0.0);
    }
}

#[test]
fn a_priori_covariance_is_never_rescaled_by_the_residuals() {
    // Same geometry, the same sigma, but sights that fit perfectly and sights that do not:
    // the a priori ellipse must be identical. Only the posterior-scaled report may differ.
    let truth = philadelphia();
    let mut clean = three_well_spread(truth, 1.0);
    for (i, (zn, alt)) in [(95.0, 60.0), (215.0, 25.0)].into_iter().enumerate() {
        clean.push(sight_at(&format!("x{i}"), "Extra", truth, zn, alt, 1.0));
    }
    let mut noisy = clean.clone();
    noisy[0].ho_rad += 3.0 * ARCMIN;
    noisy[1].ho_rad -= 2.0 * ARCMIN;
    noisy[3].ho_rad += 2.5 * ARCMIN;

    let options = SolveOptions::default();
    let a = solve(&clean, &options);
    let b = solve(&noisy, &options);
    let (fa, fb) = (unique(&a), unique(&b));
    assert!(
        fb.chi2 > 5.0,
        "the noisy set should misfit: chi2 = {}",
        fb.chi2
    );
    let posterior_factor = fb.chi2 / fb.dof as f64;
    assert!(
        posterior_factor > 2.0,
        "the misfit should be large enough to notice"
    );
    // The two covariances differ only because the Jacobian is evaluated at slightly
    // different converged points, never by the residual variance.
    for i in 0..2 {
        for j in 0..2 {
            let (x, y) = (fa.covariance_ne_m2[i][j], fb.covariance_ne_m2[i][j]);
            let rel = (x - y).abs() / x.abs().max(1.0);
            assert!(rel < 1e-2, "cov[{i}][{j}] moved by {rel:.4}: {x} vs {y}");
            assert!(
                rel < 0.5 * (posterior_factor - 1.0),
                "cov[{i}][{j}] looks rescaled by chi2/dof = {posterior_factor}"
            );
        }
    }
}

#[test]
fn posterior_scaling_only_with_three_degrees_of_freedom() {
    let truth = philadelphia();
    let options = SolveOptions {
        posterior_scaling: true,
        ..Default::default()
    };

    // Three sights: dof = 1, so the scaling is refused and says so.
    let three = three_well_spread(truth, 1.0);
    let r = solve(&three, &options);
    assert!(unique(&r).posterior_scaled.is_none());
    assert!(
        warnings_of(&r)
            .iter()
            .any(|w| matches!(w, Warning::PosteriorScalingSkipped { dof: 1 })),
        "expected PosteriorScalingSkipped, got {:?}",
        warnings_of(&r)
    );

    // Five sights: dof = 3, so it is reported alongside the a priori covariance.
    let mut five = three;
    for (i, (zn, alt)) in [(95.0, 60.0), (215.0, 25.0)].into_iter().enumerate() {
        let s = sight_at(&format!("x{i}"), "Extra", truth, zn, alt, 1.0);
        five.push(s);
    }
    let mut perturbed = five.clone();
    perturbed[0].ho_rad += 1.5 * ARCMIN;
    perturbed[3].ho_rad -= 1.0 * ARCMIN;
    let r = solve(&perturbed, &options);
    let fix = unique(&r);
    let scaled = fix.posterior_scaled.as_ref().expect("dof = 3 should scale");
    assert_eq!(fix.dof, 3);
    assert!((scaled.scale_factor_s2 - fix.chi2 / 3.0).abs() < 1e-12);
    assert!(
        (scaled.covariance_ne_m2[0][0] - fix.covariance_ne_m2[0][0] * scaled.scale_factor_s2).abs()
            < 1e-6
    );
}

#[test]
fn one_sight_is_underdetermined_and_returns_its_circle() {
    let truth = philadelphia();
    let s = sight_at("only", "Vega", truth, 35.0, 52.0, 1.0);
    check_sight(&s, truth, 35.0, 52.0);
    match solve(std::slice::from_ref(&s), &SolveOptions::default()) {
        FixResult::Underdetermined {
            circles, reason, ..
        } => {
            assert_eq!(circles.len(), 1);
            assert!((circles[0].zenith_distance_deg - 38.0).abs() < 1e-9);
            // The circle really passes through the truth at that radius.
            let gp = point_of(circles[0].gp);
            let r = geometry::angular_distance(gp, truth).to_degrees();
            assert!((r - 38.0).abs() < 1e-9, "circle radius {r} deg");
            assert!(reason.contains("circle of position"), "reason: {reason}");
        }
        other => panic!("expected underdetermined, got {other:#?}"),
    }
}

#[test]
fn two_crossing_sights_are_ambiguous_and_match_the_analytic_intersections() {
    let truth = philadelphia();
    let a = sight_at("a", "Vega", truth, 20.0, 45.0, 1.0);
    let b = sight_at("b", "Altair", truth, 110.0, 40.0, 1.0);
    check_sight(&a, truth, 20.0, 45.0);
    check_sight(&b, truth, 110.0, 40.0);

    let analytic = geometry::two_circle_intersections(
        geometry::geographic_position(a.gha_rad, a.dec_rad),
        FRAC_PI_2 - a.ho_rad,
        geometry::geographic_position(b.gha_rad, b.dec_rad),
        FRAC_PI_2 - b.ho_rad,
        1e-9,
    );
    let CircleIntersection::Two(p, q) = analytic else {
        panic!("expected two analytic intersections, got {analytic:?}");
    };

    match solve(&[a, b], &SolveOptions::default()) {
        FixResult::Ambiguous {
            candidates,
            circles,
            ..
        } => {
            assert_eq!(circles.len(), 2);
            assert_eq!(candidates.len(), 2, "exactly two zero-cost minima");
            for c in &candidates {
                assert!(c.chi2 < 1e-12, "candidate chi2 {}", c.chi2);
                assert!(c.delta_chi2_from_best.abs() < 1e-9);
                let d = point_of(c.position);
                let nearest = distance_m(d, p).min(distance_m(d, q));
                assert!(
                    nearest < 1.0,
                    "candidate {:?} is {nearest:.3} m from either intersection",
                    c.position
                );
            }
            // The two candidates are distinct, and one of them is the truth.
            let separation = distance_m(
                point_of(candidates[0].position),
                point_of(candidates[1].position),
            );
            assert!(
                separation > 1000.0,
                "candidates only {separation:.0} m apart"
            );
            let to_truth = candidates
                .iter()
                .map(|c| distance_m(point_of(c.position), truth))
                .fold(f64::INFINITY, f64::min);
            assert!(
                to_truth < 1.0,
                "neither candidate is the truth ({to_truth:.3} m)"
            );
        }
        other => panic!("expected ambiguous, got {other:#?}"),
    }
}

#[test]
fn tangent_and_disjoint_two_sight_circles_never_produce_a_point() {
    // Both GPs on the equator 90 degrees apart, built directly so the geometry is exact.
    let sight = |id: &str, gha_deg: f64, alt_deg: f64| skyfix_core::types::Sight {
        id: id.to_string(),
        body: "Test".to_string(),
        gha_rad: gha_deg.to_radians(),
        dec_rad: 0.0,
        ho_rad: alt_deg.to_radians(),
        sigma_rad: ARCMIN,
        gha_rate_rad_per_s: sidereal_rate_rad_per_s(),
    };

    // Tangent: zenith distances 45 + 45 = the 90 degree GP separation.
    match solve(
        &[sight("t1", 0.0, 45.0), sight("t2", 270.0, 45.0)],
        &SolveOptions::default(),
    ) {
        FixResult::Underdetermined {
            reason, circles, ..
        } => {
            assert_eq!(circles.len(), 2);
            assert!(reason.contains("touch"), "reason: {reason}");
            assert!(reason.contains("gap 0.00 NM"), "reason: {reason}");
        }
        other => panic!("tangent circles: expected underdetermined, got {other:#?}"),
    }

    // Disjoint: 30 + 30 leaves a 30 degree = 1800 NM gap.
    match solve(
        &[sight("d1", 0.0, 60.0), sight("d2", 270.0, 60.0)],
        &SolveOptions::default(),
    ) {
        FixResult::Underdetermined {
            reason, circles, ..
        } => {
            assert_eq!(circles.len(), 2);
            assert!(reason.contains("do not meet"), "reason: {reason}");
            assert!(
                reason.contains("1800.00 NM"),
                "reason should carry the gap: {reason}"
            );
        }
        other => panic!("disjoint circles: expected underdetermined, got {other:#?}"),
    }

    // Identical sights twice over: the same circle, so still no point.
    match solve(
        &[sight("c1", 0.0, 45.0), sight("c2", 0.0, 45.0)],
        &SolveOptions::default(),
    ) {
        FixResult::Underdetermined { reason, .. } => {
            assert!(reason.contains("same circle"), "reason: {reason}")
        }
        other => panic!("coincident circles: expected underdetermined, got {other:#?}"),
    }
}

#[test]
fn clustered_azimuths_stay_solvable_but_advertise_the_geometry() {
    let truth = philadelphia();
    // Three stars inside a 15 degree azimuth window.
    let clustered: Vec<_> = [("c1", 40.0, 30.0), ("c2", 47.5, 45.0), ("c3", 55.0, 60.0)]
        .iter()
        .map(|&(id, zn, alt)| {
            let s = sight_at(id, "Clustered", truth, zn, alt, 1.0);
            check_sight(&s, truth, zn, alt);
            s
        })
        .collect();
    let spread = three_well_spread(truth, 1.0);

    let options = SolveOptions {
        initializer: Some(LatLon {
            lat_deg: 40.5,
            lon_deg: -74.5,
        }),
        ..Default::default()
    };
    let clustered_result = solve(&clustered, &options);
    let spread_result = solve(&spread, &options);
    let cf = unique(&clustered_result);
    let sf = unique(&spread_result);

    assert!(cf.converged);
    assert!(distance_m(point_of(cf.position), truth) < 10.0);
    assert!(
        has_poor_geometry(&clustered_result),
        "clustered azimuths must raise PoorGeometry; warnings: {:?}",
        warnings_of(&clustered_result)
    );
    assert!(!has_poor_geometry(&spread_result));
    assert!(
        cf.conditioning.max_azimuth_gap_deg > 180.0,
        "max gap {} deg",
        cf.conditioning.max_azimuth_gap_deg
    );
    assert!(
        cf.conditioning.condition_number > 5.0 * sf.conditioning.condition_number,
        "clustered condition {} vs spread {}",
        cf.conditioning.condition_number,
        sf.conditioning.condition_number
    );
    assert!(
        cf.conditioning.geometric_dilution_m_per_arcmin
            > 4.0 * sf.conditioning.geometric_dilution_m_per_arcmin,
        "clustered dilution {} m/' vs spread {} m/'",
        cf.conditioning.geometric_dilution_m_per_arcmin,
        sf.conditioning.geometric_dilution_m_per_arcmin
    );

    // The ellipse is long across the line of sight and short along it.
    let ce = cf
        .ellipse95
        .as_ref()
        .expect("still well enough conditioned for an ellipse");
    let se = sf.ellipse95.as_ref().expect("spread case has an ellipse");
    assert!(
        ce.semi_major_m / ce.semi_minor_m > 5.0,
        "clustered ellipse axis ratio {}",
        ce.semi_major_m / ce.semi_minor_m
    );
    assert!(se.semi_major_m / se.semi_minor_m < 1.5);
    let mean_az = mean_azimuth_deg(&cf.residuals.iter().map(|r| r.zn_deg).collect::<Vec<_>>());
    let expected = (mean_az + 90.0).rem_euclid(180.0);
    let delta = (ce.orientation_deg - expected).rem_euclid(180.0);
    let delta = delta.min(180.0 - delta);
    assert!(
        delta < 5.0,
        "major axis at {} deg, expected perpendicular to the mean azimuth {mean_az} deg ({expected} deg)",
        ce.orientation_deg
    );
}

#[test]
fn jacobian_rows_match_numerical_derivatives_at_the_fix() {
    let truth = philadelphia();
    let sights = three_well_spread(truth, 1.0);
    let result = solve(&sights, &SolveOptions::default());
    let fix = unique(&result);
    let p = point_of(fix.position);

    let eps = 1e-7; // radians of arc, about 0.6 m
    for (r, s) in fix.residuals.iter().zip(sights.iter()) {
        let zn = r.zn_deg.to_radians();
        let (an, ae) = geometry::tangent_row(zn);
        let dn = (geometry::altitude(
            geometry::apply_tangent_step(p, eps, 0.0),
            s.gha_rad,
            s.dec_rad,
        ) - geometry::altitude(
            geometry::apply_tangent_step(p, -eps, 0.0),
            s.gha_rad,
            s.dec_rad,
        )) / (2.0 * eps);
        let de = (geometry::altitude(
            geometry::apply_tangent_step(p, 0.0, eps),
            s.gha_rad,
            s.dec_rad,
        ) - geometry::altitude(
            geometry::apply_tangent_step(p, 0.0, -eps),
            s.gha_rad,
            s.dec_rad,
        )) / (2.0 * eps);
        assert!((an - dn).abs() < 1e-7, "{}: d/dN {an} vs {dn}", r.id);
        assert!((ae - de).abs() < 1e-7, "{}: d/dE {ae} vs {de}", r.id);
        // Hc reported by the solver is the same model the derivative was taken of.
        let hc = geometry::altitude(p, s.gha_rad, s.dec_rad);
        assert!((hc.to_degrees() - r.hc_deg).abs() < 1e-12);
    }
}

#[test]
fn multistart_can_be_switched_off_and_still_uses_the_analytic_intersections() {
    let truth = philadelphia();
    let sights = three_well_spread(truth, 0.5);
    let options = SolveOptions {
        initializer: None,
        multistart: MultistartOptions {
            enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };
    let result = solve(&sights, &options);
    assert!(distance_m(point_of(unique(&result).position), truth) < 10.0);
}

fn mean_azimuth_deg(az_deg: &[f64]) -> f64 {
    let (mut c, mut s) = (0.0, 0.0);
    for a in az_deg {
        let r = a.to_radians();
        c += r.cos();
        s += r.sin();
    }
    s.atan2(c).to_degrees().rem_euclid(360.0)
}

#[test]
fn non_unique_results_say_the_ellipse_is_suppressed() {
    let truth = philadelphia();
    let one = sight_at("only", "Vega", truth, 35.0, 52.0, 1.0);
    let two = sight_at("b", "Altair", truth, 110.0, 40.0, 1.0);

    for (label, result) in [
        (
            "underdetermined",
            solve(std::slice::from_ref(&one), &SolveOptions::default()),
        ),
        (
            "ambiguous",
            solve(&[one.clone(), two], &SolveOptions::default()),
        ),
    ] {
        let suppressed = warnings_of(&result).iter().any(|w| match w {
            Warning::EllipseSuppressed { reason } => !reason.is_empty(),
            _ => false,
        });
        assert!(
            suppressed,
            "{label}: section 9 emits an ellipse only for a unique fix; warnings {:?}",
            warnings_of(&result)
        );
    }
}

/// The global grid has to work anywhere, not just off the US east coast. Truths are drawn
/// uniformly over the sphere (uniform in sin(latitude)) with a random azimuth rotation,
/// and solved with no initializer at all.
#[test]
fn the_global_grid_finds_the_fix_anywhere_on_the_sphere() {
    let mut rng = Rng::new(0xA11_9091);
    let options = SolveOptions::default();
    let trials = 40;
    let mut worst = 0.0f64;
    let started = std::time::Instant::now();
    for t in 0..trials {
        // |lat| <= 80 deg: the poles have no longitude to recover.
        let lat = (2.0 * rng.next_f64() - 1.0)
            .clamp(-0.985, 0.985)
            .asin()
            .to_degrees()
            * 0.89;
        let lon = 360.0 * rng.next_f64() - 180.0;
        let truth = Point::from_deg(lat, lon);
        let rotation = 360.0 * rng.next_f64();
        let sights: Vec<_> = [(0.0, 30.0), (85.0, 55.0), (170.0, 24.0), (265.0, 47.0)]
            .iter()
            .enumerate()
            .map(|(k, &(zn, alt))| {
                sight_at(&format!("g{k}"), "Star", truth, zn + rotation, alt, 1.0)
            })
            .collect();
        let result = solve(&sights, &options);
        let fix = unique(&result);
        let err = distance_m(point_of(fix.position), truth);
        assert!(
            err < 10.0,
            "trial {t} at {lat:.3}, {lon:.3}: {err:.3} m from truth"
        );
        worst = worst.max(err);
    }
    let per_solve = started.elapsed().as_secs_f64() * 1e3 / trials as f64;
    println!(
        "global grid: {trials} truths over the whole sphere, worst error {worst:.4} m, \
         {per_solve:.1} ms per grid solve"
    );
}
