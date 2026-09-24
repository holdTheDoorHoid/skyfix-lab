//! The six packaged scenarios (a)-(f) of BRIEF section C, asserted end to end.
//!
//! Run `cargo test -p skyfix-motion -- --nocapture` to print the table that
//! `docs/MOTION.md` quotes.

use skyfix_core::geometry::{angular_distance, apply_tangent_step};
use skyfix_core::units::{NM_M, nm_to_rad, rad_to_m};
use skyfix_motion::compare::{
    AbsolutePosition, INDISTINGUISHABLE_CAUSES, ScaleError, disagreement,
};
use skyfix_motion::replay::{ReplayOptions, replay, replay_detailed, summarize, to_csv};
use skyfix_motion::scenarios::{
    EPOCH_JD, HOUR_JD, TRUTH, clock_error_scenario, gnss_offset_scenario, heading_wrap_scenario,
    monocular_odometry, run_monocular_odometry, run_under_way, running_fix_coverage,
    sigma_inflation_table, statement_skeleton, under_way, warnings_text,
};
use skyfix_motion::to_latlon;
use skyfix_motion::to_point;
use skyfix_motion::track::{MotionUncertainty, Track};

/// Seed for the packaged run of scenario (a). Fixed so the numbers in docs/MOTION.md are
/// reproducible; the coverage test below sweeps many seeds instead of relying on one.
const SCENARIO_A_SEED: u64 = 20_261_001;

// ---------------------------------------------------------------------------
// (a) Three star sights under way
// ---------------------------------------------------------------------------

#[test]
fn scenario_a_stationary_solve_is_wrong_and_the_running_fix_recovers_the_position() {
    let scenario = under_way(SCENARIO_A_SEED, true, true);
    let result = run_under_way(&scenario);

    println!("--- scenario (a): 10 kn on 045, three sights over 3 h ---");
    println!(
        "  stationary solve: residual RMS {:.2} arcmin, {:.2} NM from truth",
        result.stationary_residual_rms_arcmin, result.stationary_error_nm
    );
    println!(
        "  running fix:      {:.1} m from truth, Mahalanobis {:.2}, largest sigma \
         inflation {:.2} arcmin",
        result.running_error_m, result.running_mahalanobis, result.largest_sigma_inflation_arcmin
    );

    // Treating sights taken under way as stationary leaves residuals the size of the run.
    // One arcminute of altitude is one nautical mile of position (CONVENTIONS section 1).
    assert!(
        result.stationary_residual_rms_arcmin > 5.0,
        "stationary residual RMS was only {:.3} arcmin",
        result.stationary_residual_rms_arcmin
    );
    assert!(
        result.stationary_error_nm > 5.0,
        "stationary fix was only {:.3} NM off",
        result.stationary_error_nm
    );

    // The running fix recovers the reference position inside its modelled uncertainty.
    assert!(
        result.running_mahalanobis < 3.0,
        "running fix Mahalanobis {:.3}",
        result.running_mahalanobis
    );
    // ... and its own residuals are back down at the noise level.
    let running_rms = match &result.running {
        skyfix_core::types::FixResult::Unique { fix, .. } => {
            let s: f64 = fix
                .residuals
                .iter()
                .map(|r| r.residual_arcmin * r.residual_arcmin)
                .sum();
            (s / fix.residuals.len() as f64).sqrt()
        }
        other => panic!("expected a unique running fix, got {other:?}"),
    };
    println!("  running fix residual RMS {running_rms:.2} arcmin");
    assert!(
        running_rms < 2.0,
        "running fix residual RMS {running_rms:.3} arcmin"
    );
    assert!(running_rms < result.stationary_residual_rms_arcmin / 3.0);

    // The caveats travel with the result.
    let text = warnings_text(&result.running);
    assert!(text.contains("RUNNING FIX at"), "{text}");
    assert!(text.contains("NOT the instrument sigmas"), "{text}");
    assert!(text.contains("OPTIMISTIC"), "{text}");
    assert!(text.contains("INDEPENDENT"), "{text}");
    assert!(text.contains("lower bound"), "{text}");
}

#[test]
fn scenario_a_without_dr_error_the_running_fix_is_essentially_exact() {
    // No track perturbation, no altitude noise: the only thing left is the advance-the-GP
    // approximation, which should be metres.
    let scenario = under_way(1, false, false);
    let result = run_under_way(&scenario);
    println!(
        "--- scenario (a), noise-free: running fix {:.3} m from truth ---",
        result.running_error_m
    );
    assert!(
        result.running_error_m < 5.0,
        "noise-free running fix was {:.3} m off",
        result.running_error_m
    );
    assert!(result.stationary_error_nm > 5.0);
}

#[test]
fn scenario_a_coverage_is_below_the_nominal_95_percent() {
    // 300 seeded repetitions. The inflated sigmas are correlated across sights because
    // one speed error and one course error drive every run, but the core solver models
    // them as independent -- so the nominal 95 % ellipse under-covers. This measures by
    // how much, and is the evidence behind the warning every running fix carries.
    let (coverage, mean_mahalanobis) = running_fix_coverage(300, 7_000);
    println!(
        "--- scenario (a) coverage over 300 seeds: {:.1} % inside the nominal 95 % \
         ellipse, mean Mahalanobis {:.2} ---",
        100.0 * coverage,
        mean_mahalanobis
    );
    // Binomial 1-sigma on 300 samples at p = 0.95 is 1.3 %, so a coverage at or above
    // 93 % would be consistent with the nominal model; below that it is not.
    assert!(
        coverage < 0.93,
        "coverage was {:.3}: the independent-sigma model was expected to UNDER-cover",
        coverage
    );
    assert!(
        coverage > 0.3,
        "coverage was {coverage:.3}: that is worse than the model being merely optimistic"
    );
}

// ---------------------------------------------------------------------------
// (b) Sigma inflation
// ---------------------------------------------------------------------------

#[test]
fn scenario_b_motion_uncertainty_inflates_the_sigmas_by_the_documented_amounts() {
    let rows = sigma_inflation_table();
    println!("--- scenario (b): 3 h at 10 kn on 045, speed sigma 0.5 kn, course sigma 2 deg ---");
    for r in &rows {
        println!(
            "  {:<22} run {:.0} NM  sigma_sight {:.3}'  sigma_motion {:.4}'  total {:.4}'",
            r.label, r.run_nm, r.sigma_sight_arcmin, r.sigma_motion_arcmin, r.sigma_total_arcmin
        );
    }

    let eps = 1e-6;
    // Along track: the speed error alone, sigma_v * T = 0.5 * 3 = 1.5 NM = 1.5 arcmin.
    assert!(
        (rows[0].sigma_motion_arcmin - 1.5).abs() < eps,
        "{:?}",
        rows[0]
    );
    assert!(
        (rows[0].sigma_total_arcmin - (1.0f64 + 2.25).sqrt()).abs() < eps,
        "{:?}",
        rows[0]
    );
    // Cross track: the course error alone, d * sigma_c = 30 * 2 deg = 1.047198 NM.
    let cross = 30.0 * 2.0f64.to_radians();
    assert!(
        (rows[1].sigma_motion_arcmin - cross).abs() < eps,
        "{:?}",
        rows[1]
    );
    assert!(
        (rows[1].sigma_total_arcmin - (1.0 + cross * cross).sqrt()).abs() < eps,
        "{:?}",
        rows[1]
    );
    // Due north (45 deg to both axes): sqrt((1.5^2 + cross^2) / 2) = 1.293566.
    let north = ((2.25 + cross * cross) / 2.0f64).sqrt();
    assert!(
        (rows[2].sigma_motion_arcmin - north).abs() < eps,
        "{:?}",
        rows[2]
    );
    assert!((north - 1.293_565_365_807).abs() < 1e-9);
    // Astern is the same line of position as ahead: identical inflation.
    assert!((rows[3].sigma_motion_arcmin - rows[0].sigma_motion_arcmin).abs() < eps);
    // A 1-arcminute sight is inflated to 1.8028' along track and 1.4480' across it.
    assert!((rows[0].sigma_total_arcmin - 1.802_775_637_732).abs() < 1e-9);
    assert!((rows[1].sigma_total_arcmin - 1.447_971_930_402).abs() < 1e-9);
    assert!((rows[2].sigma_total_arcmin - 1.635_026_408_232).abs() < 1e-9);
}

// ---------------------------------------------------------------------------
// (c) and (d): two causes, one statement
// ---------------------------------------------------------------------------

#[test]
fn scenario_c_a_two_mile_gnss_offset_is_flagged() {
    let (celestial, gnss, d) = gnss_offset_scenario();
    println!("--- scenario (c): GNSS 2 NM from the celestial fix ---");
    println!(
        "  separation {:.1} m, k = {:.2}, p = {:.3e}, beyond = {}",
        d.separation_m, d.mahalanobis, d.chi2_p_value, d.beyond_modelled_uncertainty
    );
    println!("  {}", d.statement);

    assert!(
        (d.separation_m - 2.0 * NM_M).abs() < 1.0,
        "{}",
        d.separation_m
    );
    // 2 NM against a 0.5 NM celestial sigma and a 9 m GNSS sigma: four sigmas.
    assert!((d.mahalanobis - 4.0).abs() < 0.01, "k = {}", d.mahalanobis);
    assert!(d.chi2_p_value < 0.01, "p = {}", d.chi2_p_value);
    assert!(d.beyond_modelled_uncertainty);
    assert!(d.statement.ends_with(INDISTINGUISHABLE_CAUSES));
    assert!(!d.statement.contains("spoofing"));
    assert_eq!(celestial.source, "celestial fix");
    assert_eq!(gnss.source, "GNSS receiver");
}

#[test]
fn scenario_d_a_thirty_second_clock_error_looks_exactly_the_same() {
    let clock = clock_error_scenario(30.0);
    let d = &clock.disagreement;
    println!("--- scenario (d): the celestial chronometer is 30 s fast, the GNSS is right ---");
    println!(
        "  separation {:.1} m (closed form {:.1} m), k = {:.2}, p = {:.3e}, beyond = {}",
        d.separation_m,
        clock.predicted_separation_m,
        d.mahalanobis,
        d.chi2_p_value,
        d.beyond_modelled_uncertainty
    );
    println!("  {}", d.statement);

    // cos(lat) * 15.041 deg/h * 30 s, converted at 60 NM per degree.
    let ratio = d.separation_m / clock.predicted_separation_m;
    assert!(
        (ratio - 1.0).abs() < 0.05,
        "separation {:.1} m vs predicted {:.1} m (ratio {ratio:.4})",
        d.separation_m,
        clock.predicted_separation_m
    );
    assert!((clock.predicted_separation_m - 10_669.0).abs() < 5.0);
    assert!(d.beyond_modelled_uncertainty);

    // ...and the statement is IDENTICAL IN FORM to scenario (c)'s. The check cannot tell
    // a displaced reference from a chronometer error; that is the whole point.
    let (_, _, c) = gnss_offset_scenario();
    assert_eq!(
        statement_skeleton(&d.statement),
        statement_skeleton(&c.statement),
        "the two statements must differ only in their numbers"
    );
    assert_eq!(d.beyond_modelled_uncertainty, c.beyond_modelled_uncertainty);
    assert!(!d.statement.contains("spoofing"));
}

#[test]
fn scenario_d_the_clock_error_leaves_no_residual_to_find_it_by() {
    // The degeneracy is exact for a star-only session: the fix slides west and every
    // residual stays at the noise level, so nothing in the sights reveals the clock.
    for seconds in [0.0, 30.0, 120.0] {
        let clock = clock_error_scenario(seconds);
        let separation = rad_to_m(angular_distance(
            to_point(clock.celestial.position),
            to_point(TRUTH),
        ));
        println!(
            "  clock {seconds:>5.0} s -> fix {separation:9.1} m west of truth (predicted \
             {:9.1} m)",
            clock.predicted_separation_m
        );
        if seconds == 0.0 {
            assert!(separation < 1.0);
        } else {
            assert!((separation / clock.predicted_separation_m - 1.0).abs() < 0.05);
        }
        // The fix is displaced almost purely in longitude.
        assert!(
            (clock.celestial.position.lat_deg - TRUTH.lat_deg).abs() < 1e-6,
            "latitude moved by {} deg",
            clock.celestial.position.lat_deg - TRUTH.lat_deg
        );
        assert!(clock.celestial.position.lon_deg <= TRUTH.lon_deg + 1e-12);
    }
}

// ---------------------------------------------------------------------------
// (e) Monocular odometry
// ---------------------------------------------------------------------------

#[test]
fn scenario_e_unknown_scale_is_refused_and_an_anchor_recovers_it() {
    let scenario = monocular_odometry(31_337, true);
    let result = run_monocular_odometry(&scenario);

    println!("--- scenario (e): five monocular optic-flow legs, unknown scale ---");
    match &result.without_anchor {
        ScaleError::NoMetricScale { sources, message } => {
            println!(
                "  without an anchor: {} leg source(s) refused",
                sources.len()
            );
            println!("  {message}");
            assert!(message.contains("NO metric scale"));
            assert!(message.contains("scale source"));
            assert!(message.contains("not a measurement"));
            assert_eq!(sources.len(), 5);
        }
        other => panic!("expected NoMetricScale, got {other:?}"),
    }
    println!(
        "  with an anchor:    scale {:.4} +/- {:.4} m/unit (true {:.4}), {:.2} sigma off",
        result.with_anchor.scale,
        result.with_anchor.sigma,
        scenario.true_scale,
        result.scale_error_sigmas
    );
    println!("  {}", result.note);

    assert!(result.with_anchor.sigma > 0.0);
    assert!(
        result.scale_error_sigmas < 3.0,
        "scale was {:.3} sigma off",
        result.scale_error_sigmas
    );
    // The pipeline's nominal was 20 % low and is reported, not used.
    assert_eq!(result.with_anchor.nominal_scale, 30.0);
    assert!(result.note.contains("NOT used as a prior"));
    // The integrated end position carries the scale uncertainty.
    assert!(result.end_position.covariance_ne_m2[0][0] > scenario.start.covariance_ne_m2[0][0]);
}

#[test]
fn scenario_e_a_noise_free_anchor_recovers_the_scale_exactly() {
    let scenario = monocular_odometry(1, false);
    let result = run_monocular_odometry(&scenario);
    assert!(
        result.scale_error.abs() < 1e-9,
        "noise-free scale error {:.3e}",
        result.scale_error
    );
    // The anchor's own uncertainty still shows up as the scale sigma.
    assert!(result.with_anchor.sigma > 0.0);
}

#[test]
fn scenario_e_scale_estimates_are_consistent_with_their_sigma() {
    // 200 seeded anchors: the recovered scale should sit inside 2 sigma about 95 % of the
    // time, which is the check that the reported sigma means something.
    let mut inside = 0u32;
    let reps = 200u32;
    for seed in 0..reps {
        let scenario = monocular_odometry(90_000 + u64::from(seed), true);
        let result = run_monocular_odometry(&scenario);
        if result.scale_error_sigmas <= 2.0 {
            inside += 1;
        }
    }
    let coverage = f64::from(inside) / f64::from(reps);
    println!(
        "--- scenario (e): {:.1} % of scales within 2 sigma ---",
        100.0 * coverage
    );
    assert!(
        (0.88..=1.0).contains(&coverage),
        "2-sigma coverage was {coverage:.3}"
    );
}

// ---------------------------------------------------------------------------
// (f) Heading across the wrap
// ---------------------------------------------------------------------------

#[test]
fn scenario_f_heading_comparison_handles_the_wrap() {
    let rows = heading_wrap_scenario();
    println!("--- scenario (f): heading comparison modulo 360 ---");
    for (a, b, d) in &rows {
        println!(
            "  {:8.1} vs {:8.1} -> {:6.2} deg apart, k = {:.2}, beyond = {}",
            a.heading_deg,
            b.heading_deg,
            d.separation_deg,
            d.mahalanobis,
            d.beyond_modelled_uncertainty
        );
    }
    // 359.2 against 1.4 is 2.2 degrees apart, not 357.8.
    assert!((rows[0].2.separation_deg - 2.2).abs() < 1e-9);
    assert!((rows[0].2.difference_deg + 2.2).abs() < 1e-9);
    // The same angles written as 719.2 and -358.6 give the same answer.
    assert!((rows[1].2.separation_deg - rows[0].2.separation_deg).abs() < 1e-9);
    assert_eq!(
        rows[1].2.beyond_modelled_uncertainty,
        rows[0].2.beyond_modelled_uncertainty
    );
    // Reciprocal headings are the maximum separation and are flagged.
    assert!((rows[2].2.separation_deg - 180.0).abs() < 1e-9);
    assert!(rows[2].2.beyond_modelled_uncertainty);
    // A 3.5 deg disagreement on 0.5 deg sigmas is 4.95 sigma: flagged, one dof.
    assert!((rows[3].2.mahalanobis - 3.5 / (0.5f64 * 0.5 * 2.0).sqrt()).abs() < 1e-9);
    assert!(rows[3].2.beyond_modelled_uncertainty);
    // Same causes list as a position disagreement, same refusal to diagnose.
    for (_, _, d) in &rows {
        assert!(d.statement.ends_with(INDISTINGUISHABLE_CAUSES));
        assert!(!d.statement.contains("spoofing"));
    }
}

// ---------------------------------------------------------------------------
// Replay, tying the pieces together
// ---------------------------------------------------------------------------

#[test]
fn replay_of_a_drifting_celestial_series_against_gnss() {
    // A six-hour passage sampled every 30 minutes by GNSS, with a celestial fix each
    // hour. The celestial side's chronometer goes 30 s fast halfway through.
    let track = Track::constant(EPOCH_JD, 45.0, 10.0);
    let truth = to_point(TRUTH);
    let reference: Vec<AbsolutePosition> = (0..=12)
        .map(|i| {
            let t = EPOCH_JD + f64::from(i) * 0.5 * HOUR_JD;
            AbsolutePosition::isotropic(
                t,
                to_latlon(track.advance(truth, EPOCH_JD, t)),
                9.0,
                "GNSS receiver",
            )
        })
        .collect();

    let clock_shift_m = TRUTH.lat_deg.to_radians().cos()
        * (skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR * 30.0 / 3600.0)
        * 60.0
        * NM_M;
    let fixes: Vec<AbsolutePosition> = (0..=6)
        .map(|i| {
            let t = EPOCH_JD + f64::from(i) * HOUR_JD;
            let mut p = track.advance(truth, EPOCH_JD, t);
            if i >= 3 {
                // West by the clock-error amount, exactly as scenario (d) predicts.
                p = apply_tangent_step(p, 0.0, -skyfix_core::units::m_to_rad(clock_shift_m));
            }
            AbsolutePosition::isotropic(t, to_latlon(p), 0.5 * NM_M, "celestial running fix")
        })
        .collect();

    let result = replay_detailed(&fixes, &reference, &ReplayOptions::default());
    let summary = &result.summary;
    println!("--- replay: 7 celestial fixes against a 30-minute GNSS track ---");
    for p in &result.points {
        println!(
            "  {}  separation {:8.1} m  k = {:5.2}  beyond = {}",
            p.celestial.utc(),
            p.disagreement.separation_m,
            p.disagreement.mahalanobis,
            p.disagreement.beyond_modelled_uncertainty
        );
    }
    println!(
        "  summary: n = {}, n_beyond = {}, worst k = {:.2}",
        summary.n,
        summary.n_beyond,
        summary.worst.as_ref().map_or(f64::NAN, |w| w.mahalanobis)
    );

    assert_eq!(summary.n, 7);
    assert_eq!(
        summary.n_beyond, 4,
        "the last four fixes carry the clock error"
    );
    assert!(result.skipped.is_empty());
    let worst = summary.worst.as_ref().expect("a worst point");
    assert!((worst.separation_m - clock_shift_m).abs() < 20.0);

    // The plain replay() signature agrees with the detailed one.
    let plain = replay(&fixes, &reference);
    assert_eq!(plain.len(), 7);
    assert_eq!(summarize(&plain), *summary);

    // CSV carries every row plus the summary comment.
    let csv = to_csv(&result);
    assert_eq!(csv.lines().count(), 1 + 7 + 1);
    assert!(
        csv.lines()
            .last()
            .unwrap()
            .starts_with("# summary: n=7 n_beyond=4")
    );
}

#[test]
fn a_running_fix_and_a_gnss_position_can_be_compared_directly() {
    // The whole module in one flow: sights under way -> running fix -> AbsolutePosition
    // -> disagreement against GNSS. With a correct GNSS the two agree.
    let scenario = under_way(4242, true, true);
    let result = run_under_way(&scenario);
    let (position, covariance) = match &result.running {
        skyfix_core::types::FixResult::Unique { fix, .. } => (fix.position, fix.covariance_ne_m2),
        other => panic!("expected a unique fix, got {other:?}"),
    };
    let celestial = AbsolutePosition::new(
        scenario.reference_utc_jd,
        position,
        covariance,
        "celestial running fix",
    );
    let gnss = AbsolutePosition::isotropic(scenario.reference_utc_jd, TRUTH, 9.0, "GNSS receiver");
    let agree = disagreement(&celestial, &gnss);
    println!(
        "--- running fix vs GNSS: {:.1} m apart, k = {:.2}, beyond = {} ---",
        agree.separation_m, agree.mahalanobis, agree.beyond_modelled_uncertainty
    );
    assert!(!agree.beyond_modelled_uncertainty, "{}", agree.statement);

    // Folding the dead reckoning into the sigmas COSTS SENSITIVITY, and the check should
    // show that honestly rather than pretending a running fix is as sharp as a stationary
    // one. The same 2 NM offset that is 4.0 sigma against the 0.5 NM stationary fix of
    // scenario (c) is only a couple of sigma against this running fix.
    let mut ks = Vec::new();
    for offset_nm in [2.0, 4.0, 6.0] {
        let displaced = AbsolutePosition::isotropic(
            scenario.reference_utc_jd,
            to_latlon(apply_tangent_step(
                to_point(TRUTH),
                nm_to_rad(offset_nm),
                0.0,
            )),
            9.0,
            "GNSS receiver",
        );
        let d = disagreement(&celestial, &displaced);
        println!(
            "  GNSS displaced {offset_nm:.0} NM -> {:.0} m apart, k = {:.2}, beyond = {}",
            d.separation_m, d.mahalanobis, d.beyond_modelled_uncertainty
        );
        ks.push((offset_nm, d));
    }
    assert!(
        !ks[0].1.beyond_modelled_uncertainty,
        "a 2 NM offset should NOT clear the bar against a running fix's honest covariance"
    );
    assert!(
        ks[2].1.beyond_modelled_uncertainty,
        "a 6 NM offset should: k was {:.2}",
        ks[2].1.mahalanobis
    );
    assert!(ks[0].1.mahalanobis < ks[1].1.mahalanobis);
    assert!(ks[1].1.mahalanobis < ks[2].1.mahalanobis);
    // Flagged or not, the sentence has the same shape and names no cause.
    assert_eq!(
        statement_skeleton(&ks[2].1.statement),
        statement_skeleton(&agree.statement)
    );
}

#[test]
fn a_zero_motion_uncertainty_running_fix_does_not_inflate_anything() {
    // The default MotionUncertainty is all zeros on purpose: an unstated DR uncertainty
    // must not quietly become a plausible-looking one.
    let scenario = under_way(9, false, false);
    let prepared = skyfix_motion::running_fix::prepare(
        &scenario.sights,
        &scenario.dr_track,
        &MotionUncertainty::default(),
        scenario.reference_utc_jd,
        &skyfix_core::types::SolveOptions {
            initializer: Some(scenario.dr_position),
            ..Default::default()
        },
    );
    assert!(prepared.applied);
    for row in &prepared.inflations {
        assert_eq!(row.sigma_motion_arcmin, 0.0);
        assert!((row.sigma_total_arcmin - row.sigma_sight_arcmin).abs() < 1e-12);
    }
    // The warning still says the sigmas are not the instrument sigmas -- with zero
    // inflation that is trivially true, and the caveat about correlation still applies.
    let text = prepared
        .warnings
        .iter()
        .map(|w| format!("{w:?}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(text.contains("OPTIMISTIC"));
}
