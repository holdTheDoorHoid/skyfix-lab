//! Scenario tests for the polarization compass laboratory.
//!
//! These are the end-to-end claims. Numbers that can be worked out
//! independently are written into the test rather than recomputed by the code
//! under test, and every threshold is accompanied by the measured value it was
//! set from, so a regression shows up as a number moving rather than as a
//! vague failure.
//!
//! Reference geometry unless a test says otherwise: an 81 x 81 equidistant
//! fisheye over the full hemisphere, Sun at altitude 30 deg and azimuth 135
//! deg, true heading 123 deg, levelled, `I0 = 1`, `d_max = 1`, default
//! thresholds (`min_s0 = 0.05`, `min_dolp = 0.10`), which admits about 4 700
//! pixels.

use skyfix_polar::angles::{diff180_deg, diff360_deg, mean180_deg, wrap180_deg};
use skyfix_polar::camera::{
    Camera, DEFAULT_ANALYZERS_DEG, Degradations, Extrinsics, FisheyeIntrinsics, PixelRegion,
    RadianceModel, Scene, ViewGeom, render,
};
use skyfix_polar::experiments::{ComparisonTable, ExperimentConfig, compare_sensors};
use skyfix_polar::heading::{
    AolpSample, HeadingConfig, HeadingEstimate, SampleOptions, Tilt, estimate, samples_from_stokes,
    samples_from_views, tilt_sensitivity,
};
use skyfix_polar::sensor::{FewChannelSensor, SensorDegradations};
use skyfix_polar::sky::{Dir, RayleighSky};
use skyfix_polar::stokes::{
    StokesThresholds, analyzer_intensity, dolp_aolp, recover, stokes_from_four,
};

const TRUE_HEADING: f64 = 123.0;
const SIZE: usize = 81;

fn sun() -> Dir {
    Dir::from_deg(30.0, 135.0)
}

fn intrinsics() -> FisheyeIntrinsics {
    FisheyeIntrinsics::new(SIZE, SIZE, 180.0)
}

/// Render, recover and sample an image under the given attitude and defects.
fn pipeline(extr: Extrinsics, s: Dir, deg: &Degradations) -> (Vec<AolpSample>, f64, usize) {
    let intr = FisheyeIntrinsics::new(SIZE, SIZE, 180.0);
    let cam = Camera::new(intr, extr);
    let r = render(&cam, &Scene::new(s), DEFAULT_ANALYZERS_DEG, deg);
    let f = recover(&r.images, &StokesThresholds::default());
    let rejected = f.rejected_fraction(&r.images.in_fov);
    let samples = samples_from_stokes(&intr, &f, &SampleOptions::default());
    let n = samples.len();
    (samples, rejected, n)
}

fn estimate_level(samples: &[AolpSample], s: Dir) -> HeadingEstimate {
    estimate(samples, s, Tilt::default(), &HeadingConfig::default())
}

// ---------------------------------------------------------------------------
// 1. Stokes round trip and modulo-180 arithmetic
// ---------------------------------------------------------------------------

#[test]
fn stokes_round_trip_recovers_a_known_state_to_1e_9() {
    // Independent numbers: (S0, DoLP, AoLP) chosen here, intensities built by
    // hand from the forward model, recovery by the closed form.
    let cases = [
        (1.0_f64, 0.75_f64, 0.0_f64),
        (1.0, 0.75, 22.5),
        (2.5, 0.40, 73.0),
        (0.3, 1.00, 179.5),
        (1.0, 0.13, 91.25),
    ];
    for (s0_t, p_t, psi_deg) in cases {
        let psi = psi_deg.to_radians();
        let i: Vec<f64> = DEFAULT_ANALYZERS_DEG
            .iter()
            .map(|a| analyzer_intensity(s0_t, p_t, psi, a.to_radians()))
            .collect();
        let (s0, s1, s2) = stokes_from_four(i[0], i[1], i[2], i[3]);
        let (p, psi_r) = dolp_aolp(s0, s1, s2);
        assert!((s0 - s0_t).abs() < 1e-9, "S0 {s0} vs {s0_t}");
        assert!((p - p_t).abs() < 1e-9, "DoLP {p} vs {p_t}");
        assert!(
            diff180_deg(psi_r.to_degrees(), psi_deg).abs() < 1e-9,
            "AoLP {} vs {psi_deg}",
            psi_r.to_degrees()
        );
    }
}

#[test]
fn aolp_modulo_180_arithmetic() {
    // 179 and 1 differ by 2, and their mean is 0. Both are wrong under naive
    // linear arithmetic, which would say 178 and 90.
    assert!((diff180_deg(179.0, 1.0).abs() - 2.0).abs() < 1e-12);
    assert!(mean180_deg(&[179.0, 1.0]).unwrap().abs() < 1e-12);
    assert!((wrap180_deg(-1.0) - 179.0).abs() < 1e-12);
    // Sign is carried: 179 is 2 deg *below* 1 in the modulo-180 sense.
    assert!(diff180_deg(179.0, 1.0) < 0.0);
    assert!(diff180_deg(1.0, 179.0) > 0.0);
}

// ---------------------------------------------------------------------------
// 2. The AoLP-into-the-pixel-frame transform
// ---------------------------------------------------------------------------

#[test]
fn a_synthetic_field_of_known_aolp_survives_the_whole_pipeline() {
    // Bypass the sky model entirely: build four analyzer planes from an AoLP
    // field chosen here (psi = the pixel's own image polar angle, plus a
    // constant), then recover. Anything wrong in the Stokes inversion or in the
    // pixel-frame angle convention shows up immediately.
    let intr = intrinsics();
    let n = intr.pixel_count();
    let mut planes = [vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]];
    let mut in_fov = vec![false; n];
    let mut truth = vec![0.0f64; n];
    for row in 0..intr.height {
        for col in 0..intr.width {
            let Some(g) = intr.pixel_geom(col, row) else {
                continue;
            };
            let i = intr.index(col, row);
            in_fov[i] = true;
            let psi = g.phi_rad + 17.0_f64.to_radians();
            truth[i] = psi.to_degrees();
            for (k, plane) in planes.iter_mut().enumerate() {
                plane[i] = analyzer_intensity(1.0, 0.6, psi, DEFAULT_ANALYZERS_DEG[k].to_radians());
            }
        }
    }
    let images = skyfix_polar::camera::AnalyzerImages {
        width: intr.width,
        height: intr.height,
        analyzer_deg: DEFAULT_ANALYZERS_DEG,
        planes,
        in_fov,
    };
    let f = recover(&images, &StokesThresholds::default());
    let mut checked = 0;
    for (i, want) in truth.iter().enumerate() {
        if !f.valid[i] {
            continue;
        }
        assert!((f.dolp[i] - 0.6).abs() < 1e-12);
        assert!(diff180_deg(f.aolp_rad[i].to_degrees(), *want).abs() < 1e-9);
        checked += 1;
    }
    assert!(checked > 4000, "only {checked} pixels checked");
}

#[test]
fn rotating_the_camera_30_degrees_rotates_the_aolp_field_by_minus_30() {
    // The sign-checked statement of the pixel-frame transform. Two cameras see
    // the SAME sky point when the second one's pixel sits 30 deg earlier in
    // image polar angle. There, its AoLP must read 30 deg LOWER.
    //
    //   psi_pixel(heading h, phi) = psi_pixel(heading 0, phi + h) - h   (mod 180)
    //
    // Evaluated on the continuous geometry so that the 30 deg rotation does not
    // have to land on pixel centres.
    let h = 30.0_f64;
    let s = sun();
    let cam0 = Camera::new(intrinsics(), Extrinsics::level(0.0));
    let camh = Camera::new(intrinsics(), Extrinsics::level(h));
    let s0 = cam0.sun_in_body(s);
    let sh = camh.sun_in_body(s);

    let mut checked = 0;
    let mut wrong_sign_would_fail = 0;
    for theta_deg in [5.0f64, 20.0, 45.0, 70.0, 88.0] {
        for phi_deg in (0..360).step_by(11) {
            let phi = phi_deg as f64;
            let g0 = ViewGeom::from_theta_phi(theta_deg.to_radians(), phi.to_radians());
            let gh = ViewGeom::from_theta_phi(theta_deg.to_radians(), (phi - h).to_radians());
            let (Some(p0), Some(ph)) = (g0.aolp_rad(s0), gh.aolp_rad(sh)) else {
                continue;
            };
            let (p0, ph) = (p0.to_degrees(), ph.to_degrees());
            assert!(
                diff180_deg(ph, p0 - h).abs() < 1e-9,
                "theta {theta_deg} phi {phi}: got {ph}, expected {} (= {p0} - {h})",
                wrap180_deg(p0 - h)
            );
            // And the opposite sign is genuinely different, so the test has teeth.
            if diff180_deg(ph, p0 + h).abs() > 1.0 {
                wrong_sign_would_fail += 1;
            }
            checked += 1;
        }
    }
    assert!(checked > 100, "only {checked} directions checked");
    assert!(
        wrong_sign_would_fail > checked / 2,
        "the sign check is not discriminating: {wrong_sign_would_fail}/{checked}"
    );
}

#[test]
fn a_photodiode_sees_exactly_what_the_matching_pixel_sees() {
    // The structural bridge between the two sensor models.
    let intr = intrinsics();
    let extr = Extrinsics::new(TRUE_HEADING, 6.0, -3.0);
    let scene = Scene::new(sun());
    let r = render(
        &Camera::new(intr, extr),
        &scene,
        DEFAULT_ANALYZERS_DEG,
        &Degradations::default(),
    );
    for (col, row) in [(40usize, 40usize), (55, 25), (12, 60)] {
        let g = intr.pixel_geom(col, row).unwrap();
        let sensor = FewChannelSensor {
            views: vec![skyfix_polar::sensor::SensorView {
                dir_body: Dir::from_unit(g.dir),
                analyzers_deg: DEFAULT_ANALYZERS_DEG.to_vec(),
            }],
            extrinsics: extr,
        };
        let readings = skyfix_polar::sensor::read(&sensor, &scene, &SensorDegradations::default());
        let i = r.images.index(col, row);
        for k in 0..4 {
            assert!(
                (readings.intensities[k] - r.images.planes[k][i]).abs() < 1e-9,
                "channel {k} at ({col},{row})"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Heading recovery
// ---------------------------------------------------------------------------

#[test]
fn a_clean_image_recovers_heading_within_0_1_degrees_and_still_lists_the_alternative() {
    let (samples, _, n) = pipeline(
        Extrinsics::level(TRUE_HEADING),
        sun(),
        &Degradations::default(),
    );
    assert!(n > 4000, "only {n} samples");
    let est = estimate_level(&samples, sun());
    let best = est.best().unwrap();
    assert!(
        diff360_deg(best.heading_deg, TRUE_HEADING).abs() < 0.1,
        "best {} vs truth {TRUE_HEADING}",
        best.heading_deg
    );
    // Both candidates, exactly 180 deg apart, and the ambiguity is stated.
    assert!(est.candidates.len() >= 2);
    assert!(est.has_anti_candidate(0.001), "{:?}", est.candidates);
    assert!(!est.ambiguity.is_empty());
    assert!(
        est.ambiguity
            .starts_with("180-separated-by-field-asymmetry"),
        "{}",
        est.ambiguity
    );
    // The cost curve is returned in full.
    assert_eq!(est.cost_curve.len(), 360);
    assert!(est.cost_curve.iter().all(|p| p.cost.is_finite()));
    // Every note carries the standing caveats.
    assert!(est.notes.iter().any(|n| n.contains("stress model")));
    assert!(est.notes.iter().any(|n| n.contains("nominal")));
}

#[test]
fn two_percent_noise_still_recovers_heading_within_one_degree() {
    // Measured over eight seeds at 81 x 81: mean error 0.062 deg, worst 0.154
    // deg, nominal sigma 0.046 deg. The 1 deg bound has a wide margin on
    // purpose; the useful regression signal is the worst case below.
    let mut worst: f64 = 0.0;
    for seed in 1..9u64 {
        let (samples, _, _) = pipeline(
            Extrinsics::level(TRUE_HEADING),
            sun(),
            &Degradations::seeded(seed).with_noise(0.02),
        );
        let est = estimate_level(&samples, sun());
        let e = est.nearest_error_deg(TRUE_HEADING).unwrap();
        assert!(e < 1.0, "seed {seed}: error {e} deg");
        worst = worst.max(e);
    }
    assert!(worst < 0.40, "worst-case error grew to {worst} deg");
    assert!(worst > 0.0, "noise had no effect at all");
}

#[test]
fn per_channel_gain_mismatch_produces_a_bias_that_averaging_cannot_remove() {
    // The four closed-form Stokes formulas assume the channels share a gain.
    // They do not here, so the recovered AoLP is *wrong* rather than *noisy*:
    // the error is deterministic, survives with no noise at all, and does not
    // shrink with more pixels.
    let s = sun();
    let (clean, _, _) = pipeline(Extrinsics::level(TRUE_HEADING), s, &Degradations::default());
    let clean_err = estimate_level(&clean, s)
        .nearest_error_deg(TRUE_HEADING)
        .unwrap();
    assert!(
        clean_err < 1e-6,
        "the undegraded case is not exact: {clean_err}"
    );

    let gains = Degradations::EXAMPLE_GAINS; // [1.0, 1.03, 0.98, 1.01]
    let (biased, _, _) = pipeline(
        Extrinsics::level(TRUE_HEADING),
        s,
        &Degradations::default().with_gains(gains),
    );
    let est = estimate_level(&biased, s);
    let bias = est.nearest_error_deg(TRUE_HEADING).unwrap();
    // Measured: 0.11399 deg of heading bias, with a residual RMS of 0.835 deg.
    assert!(bias > 1e-3, "gain mismatch produced no bias at all: {bias}");
    assert!(
        (0.05..0.30).contains(&bias),
        "gain bias moved from its documented 0.114 deg to {bias} deg"
    );
    assert!(
        est.residual_rms_deg > 0.1,
        "a gain mismatch should leave a residual: {}",
        est.residual_rms_deg
    );

    // More pixels do not help: the bias is common to every pixel.
    let intr_big = FisheyeIntrinsics::new(161, 161, 180.0);
    let cam = Camera::new(intr_big, Extrinsics::level(TRUE_HEADING));
    let r = render(
        &cam,
        &Scene::new(s),
        DEFAULT_ANALYZERS_DEG,
        &Degradations::default().with_gains(gains),
    );
    let f = recover(&r.images, &StokesThresholds::default());
    let big = samples_from_stokes(&intr_big, &f, &SampleOptions::default());
    assert!(big.len() > 3 * biased.len());
    let big_bias = estimate_level(&big, s)
        .nearest_error_deg(TRUE_HEADING)
        .unwrap();
    assert!(
        (big_bias - bias).abs() < 0.05,
        "four times the pixels changed the bias from {bias} to {big_bias}: it is not a bias"
    );
}

#[test]
fn an_unmodelled_two_degree_tilt_moves_the_heading_as_the_sensitivity_predicts() {
    // The camera really is tilted; the estimator is told it is not. The error
    // that produces must agree with d(heading)/d(tilt) at the solution.
    //
    // Measured at 81 x 81, Sun altitude 30: dH/dpitch = 0.1196 deg/deg and
    // dH/droll = 1.0000 deg/deg. Roll is exactly unity because rolling a
    // camera that looks straight up is indistinguishable from turning it.
    let s = sun();
    let cfg = HeadingConfig::default();

    // Reference sensitivity, measured with the tilt correctly known.
    let (level, _, _) = pipeline(Extrinsics::level(TRUE_HEADING), s, &Degradations::default());
    let ts = tilt_sensitivity(&level, s, Tilt::default(), &cfg, 0.5).unwrap();
    assert!(
        (ts.d_heading_d_roll - 1.0).abs() < 0.01,
        "dH/droll {} should be 1",
        ts.d_heading_d_roll
    );
    assert!(
        (0.05..0.25).contains(&ts.d_heading_d_pitch),
        "dH/dpitch moved from its documented 0.120: {}",
        ts.d_heading_d_pitch
    );

    let err_deg = 2.0;
    for (true_pitch, true_roll, dp, dr) in [
        (err_deg, 0.0, err_deg, 0.0),
        (0.0, err_deg, 0.0, err_deg),
        (err_deg, err_deg, err_deg, err_deg),
    ] {
        let (samples, _, _) = pipeline(
            Extrinsics::new(TRUE_HEADING, true_pitch, true_roll),
            s,
            &Degradations::default(),
        );
        // The estimator is told the instrument is level: a tilt error of
        // (dp, dr) degrees.
        let est = estimate(&samples, s, Tilt::default(), &cfg);
        let actual = est.nearest_error_deg(TRUE_HEADING).unwrap();
        let predicted = ts.predicted_heading_error_deg(-dp, -dr);
        assert!(predicted > 0.0, "sensitivity predicted nothing");
        let ratio = actual / predicted;
        assert!(
            (0.5..2.0).contains(&ratio),
            "tilt ({true_pitch}, {true_roll}): actual {actual:.4} deg, \
             predicted {predicted:.4} deg, ratio {ratio:.3} outside a factor of 2"
        );
    }
}

#[test]
fn a_forty_percent_mask_still_yields_a_solution() {
    // Rows 0..34 of the 81 x 81 grid remove 42 % of the sky inside the lens
    // circle. The estimator is never told where the mask is: it discovers the
    // loss through its own S0 threshold.
    let s = sun();
    let deg = Degradations::seeded(5)
        .with_noise(0.01)
        .with_mask(PixelRegion::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: (SIZE - 1) as f64,
            y1: 34.0,
        });
    let cam = Camera::new(intrinsics(), Extrinsics::level(TRUE_HEADING));
    let r = render(&cam, &Scene::new(s), DEFAULT_ANALYZERS_DEG, &deg);
    let masked_fraction = r.truth.masked_fraction();
    assert!(
        masked_fraction >= 0.40,
        "the mask covers only {masked_fraction:.3} of the field"
    );
    let f = recover(&r.images, &StokesThresholds::default());
    let rejected = f.rejected_fraction(&r.images.in_fov);
    assert!(
        rejected >= masked_fraction,
        "the thresholds found {rejected:.3} but {masked_fraction:.3} was hidden"
    );
    let samples = samples_from_stokes(&intrinsics(), &f, &SampleOptions::default());
    let est = estimate_level(&samples, s);
    let err = est.nearest_error_deg(TRUE_HEADING).unwrap();
    assert!(err < 1.0, "42 % masked: error {err} deg");
    // Still cheaper than the unmasked case, and it says so.
    let (full, _, n_full) = pipeline(
        Extrinsics::level(TRUE_HEADING),
        s,
        &Degradations::seeded(5).with_noise(0.01),
    );
    assert!(est.samples_used < n_full);
    assert!(!full.is_empty());
}

#[test]
fn a_depolarized_region_is_dropped_rather_than_trusted() {
    // A patch with its DoLP scaled to 0.05 falls under the min_dolp threshold
    // and is rejected, instead of contributing a meaningless angle.
    let s = sun();
    let region = PixelRegion::Circle {
        cx: 25.0,
        cy: 25.0,
        radius_px: 18.0,
    };
    let (base, _, n_base) = pipeline(Extrinsics::level(TRUE_HEADING), s, &Degradations::default());
    let (depol, _, n_depol) = pipeline(
        Extrinsics::level(TRUE_HEADING),
        s,
        &Degradations::default().with_depolarization(region, 0.05),
    );
    assert!(n_depol < n_base, "{n_depol} vs {n_base}");
    assert!(!base.is_empty() && !depol.is_empty());
    let err = estimate_level(&depol, s)
        .nearest_error_deg(TRUE_HEADING)
        .unwrap();
    assert!(
        err < 1e-6,
        "dropping the patch should leave an exact fit: {err}"
    );
}

#[test]
fn a_zenith_sun_returns_no_candidates_with_an_explanation() {
    for alt in [86.0, 88.0, 90.0] {
        let s = Dir::from_deg(alt, 135.0);
        let (samples, _, _) =
            pipeline(Extrinsics::level(TRUE_HEADING), s, &Degradations::default());
        let est = estimate_level(&samples, s);
        assert!(est.candidates.is_empty(), "alt {alt} returned a candidate");
        assert!(
            est.ambiguity.starts_with("unobservable"),
            "{}",
            est.ambiguity
        );
        assert!(est.ambiguity.contains("rotationally symmetric"));
        assert!(est.ambiguity_flagged());
        assert!(est.nearest_error_deg(TRUE_HEADING).is_none());
    }
    // Just outside the 5 deg limit it works again.
    let s = Dir::from_deg(84.0, 135.0);
    let (samples, _, _) = pipeline(Extrinsics::level(TRUE_HEADING), s, &Degradations::default());
    let est = estimate_level(&samples, s);
    assert!(!est.candidates.is_empty());
    assert!(est.nearest_error_deg(TRUE_HEADING).unwrap() < 0.1);
}

// ---------------------------------------------------------------------------
// 4. Image sensor against few-channel sensor
// ---------------------------------------------------------------------------

fn few_channel(seed: u64, noise: f64, s: Dir) -> HeadingEstimate {
    let sensor = FewChannelSensor::ring(
        4,
        45.0,
        true,
        &DEFAULT_ANALYZERS_DEG,
        Extrinsics::level(TRUE_HEADING),
    );
    let deg = SensorDegradations::seeded(seed).with_noise(noise);
    let readings = skyfix_polar::sensor::read(&sensor, &Scene::new(s), &deg);
    let views =
        skyfix_polar::sensor::recover_views(&sensor, &readings, &StokesThresholds::default());
    estimate_level(&samples_from_views(&views), s)
}

#[test]
fn at_equal_noise_the_image_sensor_has_the_smaller_nominal_sigma() {
    // Measured at sigma = 0.02: image 0.045-0.047 deg from about 4 700
    // samples, few-channel 0.24-0.88 deg from 4 lines of sight.
    let s = sun();
    for seed in 1..5u64 {
        let (samples, _, n_img) = pipeline(
            Extrinsics::level(TRUE_HEADING),
            s,
            &Degradations::seeded(seed).with_noise(0.02),
        );
        let img = estimate_level(&samples, s);
        let few = few_channel(seed, 0.02, s);
        let si = img.best().unwrap().sigma_deg;
        let sf = few.best().unwrap().sigma_deg;
        assert!(
            si < sf,
            "seed {seed}: image sigma {si:.4} is not smaller than few-channel {sf:.4}"
        );
        assert!(n_img > 100 * few.samples_used);
        // Roughly the square-root-of-n advantage the sample counts imply.
        assert!(
            sf / si > 3.0,
            "seed {seed}: sigma ratio only {:.2}",
            sf / si
        );
    }
}

#[test]
fn the_few_channel_sensor_cannot_represent_an_image_mask() {
    // Structural, not a threshold: the image rows change under a mask, the
    // few-channel rows are bit-identical, and only the image reports a
    // rejected fraction at all.
    let base = ExperimentConfig {
        sun_alt_deg: vec![30.0],
        noise_sigmas: vec![0.01],
        tilt_errors_deg: vec![0.0],
        image_size: 41,
        ..Default::default()
    };
    let masked = ExperimentConfig {
        mask: Some(PixelRegion::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: 40.0,
            y1: 17.0,
        }),
        ..base.clone()
    };
    let a = compare_sensors(&base);
    let b = compare_sensors(&masked);
    let mut checked_few = 0;
    let mut checked_img = 0;
    for (ra, rb) in a.rows.iter().zip(&b.rows) {
        if ra.sensor == "few-channel" {
            assert_eq!(ra, rb, "an image mask reached the few-channel sensor");
            assert!(ra.rejected_fraction.is_none());
            checked_few += 1;
        } else {
            assert!(rb.samples_used < ra.samples_used);
            assert!(rb.rejected_fraction.unwrap() > ra.rejected_fraction.unwrap());
            checked_img += 1;
        }
    }
    assert!(checked_few > 0 && checked_img > 0);
    assert!(skyfix_polar::sensor::MASK_NOT_REPRESENTABLE.contains("no image plane"));
}

#[test]
fn a_zenith_only_sensor_keeps_the_exact_180_degree_ambiguity() {
    // The contrast that makes the wide-field separation interpretable.
    let s = sun();
    let sensor =
        FewChannelSensor::zenith_only(&DEFAULT_ANALYZERS_DEG, Extrinsics::level(TRUE_HEADING));
    let readings =
        skyfix_polar::sensor::read(&sensor, &Scene::new(s), &SensorDegradations::default());
    let views =
        skyfix_polar::sensor::recover_views(&sensor, &readings, &StokesThresholds::default());
    let est = estimate_level(&samples_from_views(&views), s);
    assert!(
        est.ambiguity.starts_with("unresolved-180"),
        "{}",
        est.ambiguity
    );
    assert!(est.ambiguity_flagged());
    assert!(est.has_anti_candidate(0.01));
    assert!(est.nearest_error_deg(TRUE_HEADING).unwrap() < 0.05);
    // The closed form agrees with the search and returns the same two options.
    let analytic = skyfix_polar::heading::heading_from_zenith_aolp(views[0].aolp_rad, s);
    assert!(
        analytic
            .iter()
            .any(|a| diff360_deg(*a, TRUE_HEADING).abs() < 1e-9)
    );
    assert!(
        (diff360_deg(analytic[0], analytic[1]).abs() - 180.0).abs() < 1e-9,
        "the two analytic options are not 180 apart"
    );
}

// ---------------------------------------------------------------------------
// 5. The optional radiance hint
// ---------------------------------------------------------------------------

#[test]
fn the_radiance_hint_is_opt_in_and_says_it_is_not_validated() {
    // A low Sun is the case where the AoLP field alone barely separates the
    // 180 deg alternative, so it is where a hint would matter.
    let s = Dir::from_deg(2.0, 135.0);
    let intr = FisheyeIntrinsics::new(61, 61, 180.0);
    let cam = Camera::new(intr, Extrinsics::level(TRUE_HEADING));
    let scene = Scene {
        sky: RayleighSky::default(),
        sun: s,
        radiance: RadianceModel::SunGradient { i0: 1.0, k: 1.0 },
    };
    let r = render(
        &cam,
        &scene,
        DEFAULT_ANALYZERS_DEG,
        &Degradations::default(),
    );
    let f = recover(&r.images, &StokesThresholds::default());
    let samples = samples_from_stokes(&intr, &f, &SampleOptions::default());

    let off = estimate(&samples, s, Tilt::default(), &HeadingConfig::default());
    assert!(!off.notes.iter().any(|n| n.contains("radiance")));

    let on = estimate(
        &samples,
        s,
        Tilt::default(),
        &HeadingConfig {
            use_radiance_hint: true,
            ..Default::default()
        },
    );
    assert!(
        on.ambiguity.starts_with("180-preferred-by-radiance-hint"),
        "{}",
        on.ambiguity
    );
    assert!(on.ambiguity.contains("not validated"));
    assert!(on.notes.iter().any(|n| n.contains("not validated")));
    // It picks the true heading, and it still lists the alternative.
    assert!(diff360_deg(on.best().unwrap().heading_deg, TRUE_HEADING).abs() < 0.1);
    assert!(on.candidates.len() >= 2);
    assert!(on.has_anti_candidate(0.001));

    // With a uniform-radiance scene there is no gradient and it says so.
    let uniform = render(
        &cam,
        &Scene::new(s),
        DEFAULT_ANALYZERS_DEG,
        &Degradations::default(),
    );
    let fu = recover(&uniform.images, &StokesThresholds::default());
    let su = samples_from_stokes(&intr, &fu, &SampleOptions::default());
    let on_u = estimate(
        &su,
        s,
        Tilt::default(),
        &HeadingConfig {
            use_radiance_hint: true,
            ..Default::default()
        },
    );
    assert!(
        on_u.notes.iter().any(|n| n.contains("uninformative")),
        "{:?}",
        on_u.notes
    );
}

// ---------------------------------------------------------------------------
// 6. The experiment table
// ---------------------------------------------------------------------------

#[test]
fn the_experiment_sweep_is_deterministic_and_its_csv_is_well_formed() {
    let cfg = ExperimentConfig::default();
    let a = compare_sensors(&cfg);
    let b = compare_sensors(&cfg);
    assert_eq!(a, b, "the sweep is not deterministic");
    // 4 Sun altitudes x 3 noise levels x 2 tilt errors x 2 sensors.
    assert_eq!(a.rows.len(), 48);
    let csv = a.to_csv();
    let lines: Vec<&str> = csv.lines().collect();
    assert_eq!(lines.len(), 49);
    assert_eq!(lines[0], ComparisonTable::HEADER);
    assert!(a.caveat.contains("stress model"));
    // Bounds measured from the table in docs/POLARIZATION.md. They differ by
    // sensor on purpose: the five-line-of-sight sensor is genuinely worse, and
    // worst of all with a high Sun, where its ring at 45 deg altitude sits in
    // the weakly polarized part of the pattern.
    let mut worst_image: f64 = 0.0;
    let mut worst_few: f64 = 0.0;
    for r in &a.rows {
        let Some(e) = r.nearest_error_deg else {
            continue;
        };
        assert!(e.is_finite());
        if r.sensor == "image" {
            worst_image = worst_image.max(e);
        } else {
            worst_few = worst_few.max(e);
        }
    }
    // Measured: image worst 1.373 deg, few-channel worst 11.487 deg, both at
    // Sun altitude 70 with a 2 deg unmodelled tilt.
    assert!(
        worst_image < 2.0,
        "image worst case grew to {worst_image} deg"
    );
    assert!(
        worst_few < 15.0,
        "few-channel worst case grew to {worst_few} deg"
    );
    assert!(
        worst_few > 3.0 * worst_image,
        "the image advantage vanished: image {worst_image}, few-channel {worst_few}"
    );
}
