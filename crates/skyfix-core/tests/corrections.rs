//! CONVENTIONS section 5: the correction chain, checked against hand-worked numbers.
//!
//! Every expected value in this file was computed outside the crate (Python `math`,
//! from the formulae as published) and pasted in as a literal, so a mistake in
//! `corrections.rs` cannot make its own test pass.

use approx::assert_relative_eq;
use skyfix_core::SkyfixError;
use skyfix_core::corrections::{CorrectionInputs, correct, dip_arcmin, refraction_arcmin};
use skyfix_core::types::{
    AltitudeKind, CorrectionKind, GeocentricDirection, HorizonMode, Limb, Warning,
};

/// Bennett 1982 at standard conditions, from `cot(Ha + 7.31/(Ha + 4.4))` in arcminutes.
/// These are the formula's own outputs, not table values; the published-table check is
/// the separate `refraction_matches_published_table` test below.
const BENNETT_0: f64 = 34.477_533_743_3;
const BENNETT_5: f64 = 9.883_144_234_2;
const BENNETT_10: f64 = 5.391_505_467_6;
const BENNETT_45: f64 = 0.994_847_967_9;
const BENNETT_30: f64 = 1.717_310_133_553_106_5;
const BENNETT_3: f64 = 14.344_422_444_336_306;
const BENNETT_7: f64 = 7.453_734_632_207_042;

/// `1.76' * sqrt(2 m)`.
const DIP_2M: f64 = 2.489_015_869_776_647_3;

fn star(id: &str) -> CorrectionInputs<'_> {
    CorrectionInputs {
        id,
        is_sun: false,
        limb: Limb::Center,
        horizon: HorizonMode::Sea,
        index_correction_arcmin: 0.0,
        height_of_eye_m: 0.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
        direction: None,
    }
}

fn sun(id: &str, limb: Limb) -> CorrectionInputs<'_> {
    CorrectionInputs {
        id,
        is_sun: true,
        limb,
        horizon: HorizonMode::Sea,
        index_correction_arcmin: 0.0,
        height_of_eye_m: 0.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
        direction: Some(GeocentricDirection {
            gha_deg: 180.0,
            dec_deg: 0.0,
            semidiameter_arcmin: 16.0,
            horizontal_parallax_arcmin: 0.15,
        }),
    }
}

fn step(
    b: &skyfix_core::types::CorrectionBreakdown,
    kind: CorrectionKind,
) -> &skyfix_core::types::CorrectionStep {
    b.steps
        .iter()
        .find(|s| s.kind == kind)
        .expect("step present")
}

// ---------------------------------------------------------------------------
// dip
// ---------------------------------------------------------------------------

#[test]
fn dip_is_1_76_root_metres() {
    assert_relative_eq!(dip_arcmin(1.0), 1.76, epsilon = 1e-12);
    assert_relative_eq!(dip_arcmin(2.0), DIP_2M, epsilon = 1e-12);
    assert_relative_eq!(dip_arcmin(4.0), 3.52, epsilon = 1e-12);
    assert_relative_eq!(dip_arcmin(9.0), 5.28, epsilon = 1e-12);
    assert_relative_eq!(dip_arcmin(25.0), 8.8, epsilon = 1e-12);
    // 1.76' sqrt(metres) is the same rule as 0.97' sqrt(feet): 9 m = 29.5276 ft. The two
    // published constants are each rounded to two figures, so they agree to about 0.01'.
    assert_relative_eq!(
        dip_arcmin(9.0),
        0.97 * (9.0f64 * 3.280_839_895).sqrt(),
        epsilon = 0.01
    );
    // Defensive, never NaN: a negative height is a validation error upstream.
    assert_eq!(dip_arcmin(0.0), 0.0);
    assert_eq!(dip_arcmin(-1.0), 0.0);
}

// ---------------------------------------------------------------------------
// refraction
// ---------------------------------------------------------------------------

#[test]
fn refraction_matches_bennett_1982_exactly() {
    for (ha, expected) in [
        (0.0, BENNETT_0),
        (3.0, BENNETT_3),
        (5.0, BENNETT_5),
        (7.0, BENNETT_7),
        (10.0, BENNETT_10),
        (30.0, BENNETT_30),
        (45.0, BENNETT_45),
    ] {
        assert_relative_eq!(
            refraction_arcmin(ha, 1010.0, 10.0),
            expected,
            epsilon = 1e-9
        );
    }
    // Bennett's expression goes very slightly negative near the zenith (-0.00135' at
    // 90 deg). Refraction cannot be negative, so it is clamped at zero.
    assert_eq!(refraction_arcmin(90.0, 1010.0, 10.0), 0.0);
    assert_eq!(refraction_arcmin(89.99, 1010.0, 10.0), 0.0);
    assert!(refraction_arcmin(89.5, 1010.0, 10.0) > 0.0);
    // Monotone decreasing with altitude over the useful range.
    let mut previous = f64::INFINITY;
    for i in 0..=90 {
        let r = refraction_arcmin(f64::from(i), 1010.0, 10.0);
        assert!(
            r < previous,
            "refraction rose at {i} deg: {r} >= {previous}"
        );
        previous = r;
    }
}

#[test]
fn refraction_matches_published_table() {
    // Nautical Almanac / Bowditch standard refraction, to the precision those tables
    // are quoted at. Bennett's own residual against them is <= 0.07'.
    assert_relative_eq!(refraction_arcmin(0.0, 1010.0, 10.0), 34.5, epsilon = 0.1);
    assert_relative_eq!(refraction_arcmin(5.0, 1010.0, 10.0), 9.9, epsilon = 0.1);
    assert_relative_eq!(refraction_arcmin(10.0, 1010.0, 10.0), 5.3, epsilon = 0.1);
    assert_relative_eq!(refraction_arcmin(45.0, 1010.0, 10.0), 1.0, epsilon = 0.1);
    assert_relative_eq!(refraction_arcmin(90.0, 1010.0, 10.0), 0.0, epsilon = 0.1);
}

#[test]
fn refraction_scales_with_pressure_and_temperature_in_the_right_direction() {
    let standard = refraction_arcmin(10.0, 1010.0, 10.0);
    // Denser air bends more: higher pressure or lower temperature increases refraction.
    let high_p = refraction_arcmin(10.0, 1030.0, 10.0);
    let low_p = refraction_arcmin(10.0, 990.0, 10.0);
    assert!(high_p > standard, "{high_p} !> {standard}");
    assert!(low_p < standard, "{low_p} !< {standard}");
    let cold = refraction_arcmin(10.0, 1010.0, -10.0);
    let hot = refraction_arcmin(10.0, 1010.0, 30.0);
    assert!(cold > standard, "{cold} !> {standard}");
    assert!(hot < standard, "{hot} !< {standard}");

    // Exact scale factors: (P/1010) and (283/(273+T)).
    assert_relative_eq!(high_p / standard, 1030.0 / 1010.0, epsilon = 1e-12);
    assert_relative_eq!(hot / standard, 283.0 / 303.0, epsilon = 1e-12);
    assert_relative_eq!(cold / standard, 283.0 / 263.0, epsilon = 1e-12);
    // Independently computed values, 1030 hPa and 30 C at Ha = 10 deg.
    assert_relative_eq!(high_p, 5.498_267_952_080_887, epsilon = 1e-9);
    assert_relative_eq!(hot, 5.035_630_519_219_712, epsilon = 1e-9);
}

// ---------------------------------------------------------------------------
// the chain, step by step
// ---------------------------------------------------------------------------

/// Hs 45 00.0', IC -2.0', height of eye 2 m, sea horizon, star, 1010 hPa / 10 C:
///
/// ```text
/// Hs            45.000 000 000 deg
/// + IC -2.0'    44.966 666 666 666 67   (45 - 2/60)
/// - dip 2.489'  44.925 183 068 837 06   (dip = 1.76 sqrt 2 = 2.489 015 869 8')
/// - R   0.997'  44.908 559 040 215 49   (Bennett at Ha 44.925 183 07 deg)
/// Ho            44.908 559 040 215 49
/// ```
#[test]
fn worked_star_sight_sea_horizon() {
    let mut inputs = star("obs-1");
    inputs.index_correction_arcmin = -2.0;
    inputs.height_of_eye_m = 2.0;
    let b = correct(45.0, AltitudeKind::SextantHs, 1.0, inputs).unwrap();

    let ic = step(&b, CorrectionKind::IndexCorrection);
    assert!(ic.applied);
    assert_eq!(ic.before_deg, 45.0);
    assert_relative_eq!(ic.after_deg, 44.966_666_666_666_67, epsilon = 1e-12);
    assert_relative_eq!(ic.delta_arcmin, -2.0, epsilon = 1e-9);

    let dip = step(&b, CorrectionKind::Dip);
    assert!(dip.applied);
    assert_relative_eq!(dip.before_deg, 44.966_666_666_666_67, epsilon = 1e-12);
    assert_relative_eq!(dip.after_deg, 44.925_183_068_837_06, epsilon = 1e-12);
    assert_relative_eq!(dip.delta_arcmin, -DIP_2M, epsilon = 1e-9);

    let halving = step(&b, CorrectionKind::ArtificialHorizonHalving);
    assert!(!halving.applied);
    assert!(halving.note.contains("not applicable"), "{}", halving.note);

    let refraction = step(&b, CorrectionKind::Refraction);
    assert!(refraction.applied);
    assert_relative_eq!(
        refraction.before_deg,
        44.925_183_068_837_06,
        epsilon = 1e-12
    );
    assert_relative_eq!(refraction.after_deg, 44.908_559_040_215_49, epsilon = 1e-12);
    assert_relative_eq!(
        refraction.delta_arcmin,
        -0.997_441_717_294_030_5,
        epsilon = 1e-9
    );

    assert!(!step(&b, CorrectionKind::Semidiameter).applied);
    assert!(!step(&b, CorrectionKind::Parallax).applied);

    assert_relative_eq!(b.ho_deg, 44.908_559_040_215_49, epsilon = 1e-12);
    // Total correction: -5.486' from a 45 deg reading.
    assert_relative_eq!(
        (b.ho_deg - 45.0) * 60.0,
        -5.486_457_587_070_39,
        epsilon = 1e-9
    );
    assert_eq!(b.sigma_ho_arcmin, 1.0);
    assert!(b.warnings.is_empty(), "{:?}", b.warnings);
}

#[test]
fn reducing_the_apparent_altitude_gives_the_same_ho() {
    // Feeding back the Ha from the worked sight above must land on the same Ho, and the
    // index correction and dip must NOT be taken off a second time.
    let mut inputs = star("obs-1");
    inputs.index_correction_arcmin = -2.0;
    inputs.height_of_eye_m = 2.0;
    let b = correct(44.925_183_068_837_06, AltitudeKind::ApparentHa, 1.0, inputs).unwrap();
    assert_relative_eq!(b.ho_deg, 44.908_559_040_215_49, epsilon = 1e-12);
    assert!(!step(&b, CorrectionKind::IndexCorrection).applied);
    assert!(!step(&b, CorrectionKind::Dip).applied);
    assert!(step(&b, CorrectionKind::Refraction).applied);
    // The ignored parameters are named, not silently dropped.
    let ignored = b
        .warnings
        .iter()
        .find_map(|w| match w {
            Warning::AlreadyCorrected { kind, ignored, .. } => {
                assert_eq!(*kind, AltitudeKind::ApparentHa);
                Some(ignored.clone())
            }
            _ => None,
        })
        .expect("already-corrected warning");
    assert_eq!(
        ignored,
        vec![CorrectionKind::IndexCorrection, CorrectionKind::Dip]
    );
}

#[test]
fn observed_ho_records_are_never_corrected_twice() {
    let mut inputs = sun("obs-ho", Limb::Lower);
    inputs.index_correction_arcmin = -2.0;
    inputs.height_of_eye_m = 2.0;
    let b = correct(45.0, AltitudeKind::ObservedHo, 1.0, inputs).unwrap();

    assert_eq!(
        b.ho_deg, 45.0,
        "an observed_ho record must pass through unchanged"
    );
    assert_eq!(b.sigma_ho_arcmin, 1.0);
    assert!(b.steps.iter().all(|s| !s.applied));
    assert!(b.steps.iter().all(|s| s.delta_arcmin == 0.0));
    let ignored = b
        .warnings
        .iter()
        .find_map(|w| match w {
            Warning::AlreadyCorrected { kind, ignored, .. } => {
                assert_eq!(*kind, AltitudeKind::ObservedHo);
                Some(ignored.clone())
            }
            _ => None,
        })
        .expect("already-corrected warning");
    assert_eq!(
        ignored,
        vec![
            CorrectionKind::IndexCorrection,
            CorrectionKind::Dip,
            CorrectionKind::Semidiameter,
            CorrectionKind::Parallax,
        ]
    );

    // With nothing to ignore there is nothing to warn about.
    let clean = correct(45.0, AltitudeKind::ObservedHo, 1.0, star("obs-clean")).unwrap();
    assert!(
        !clean
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::AlreadyCorrected { .. })),
        "{:?}",
        clean.warnings
    );
}

// ---------------------------------------------------------------------------
// horizon modes
// ---------------------------------------------------------------------------

#[test]
fn dip_applies_to_the_sea_horizon_only() {
    for (horizon, dip_applied, halved) in [
        (HorizonMode::Sea, true, false),
        (HorizonMode::ArtificialReflected, false, true),
        (HorizonMode::ElectronicVertical, false, false),
    ] {
        let mut inputs = star("obs-1");
        inputs.horizon = horizon;
        inputs.height_of_eye_m = 2.0;
        let b = correct(60.0, AltitudeKind::SextantHs, 1.0, inputs).unwrap();
        assert_eq!(
            step(&b, CorrectionKind::Dip).applied,
            dip_applied,
            "{horizon:?}"
        );
        assert_eq!(
            step(&b, CorrectionKind::ArtificialHorizonHalving).applied,
            halved,
            "{horizon:?}"
        );
        let warned = b
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::DipNotApplicable { .. }));
        // A height of eye was supplied; if it is going unused, say so.
        assert_eq!(warned, !dip_applied, "{horizon:?}: {:?}", b.warnings);
    }
}

#[test]
fn electronic_vertical_is_index_correction_only_before_refraction() {
    let mut inputs = star("obs-e");
    inputs.horizon = HorizonMode::ElectronicVertical;
    inputs.index_correction_arcmin = 1.5;
    inputs.height_of_eye_m = 30.0; // on a hill: irrelevant without a sea horizon
    let b = correct(20.0, AltitudeKind::SextantHs, 1.0, inputs).unwrap();
    let ha = 20.0 + 1.5 / 60.0;
    assert_relative_eq!(
        step(&b, CorrectionKind::Refraction).before_deg,
        ha,
        epsilon = 1e-12
    );
    assert_relative_eq!(
        b.ho_deg,
        ha - refraction_arcmin(ha, 1010.0, 10.0) / 60.0,
        epsilon = 1e-12
    );
}

#[test]
fn artificial_horizon_halves_the_reading_and_its_sigma() {
    let mut inputs = star("obs-a");
    inputs.horizon = HorizonMode::ArtificialReflected;
    inputs.index_correction_arcmin = -2.0;
    // Double angle 80 deg 00.0' with IC -2.0' -> (80 - 2/60)/2 = 39.983 333 333 deg.
    let b = correct(80.0, AltitudeKind::SextantHs, 2.0, inputs).unwrap();
    let halving = step(&b, CorrectionKind::ArtificialHorizonHalving);
    assert!(halving.applied);
    assert_relative_eq!(halving.before_deg, 79.966_666_666_666_67, epsilon = 1e-12);
    assert_relative_eq!(halving.after_deg, 39.983_333_333_333_33, epsilon = 1e-12);
    // The recorded sigma describes the double angle, so it halves with it.
    assert_relative_eq!(b.sigma_ho_arcmin, 1.0, epsilon = 1e-12);
    assert!(!step(&b, CorrectionKind::Dip).applied);
}

/// Bringing the direct image's lower limb to the reflected image's upper limb measures
/// `2h - 2SD`; halving gives `h - SD`, exactly a lower-limb altitude. With the Sun's
/// apparent centre at 40 deg and SD 16.0', the reading is 2 * 39.733 333 = 79.466 667 deg.
#[test]
fn sun_with_an_artificial_horizon_halves_before_the_limb_rule() {
    let mut inputs = sun("obs-sun-ah", Limb::Lower);
    inputs.horizon = HorizonMode::ArtificialReflected;
    let centre_ha = 40.0;
    let reading = 2.0 * (centre_ha - 16.0 / 60.0);
    assert_relative_eq!(reading, 79.466_666_666_666_67, epsilon = 1e-12);

    let b = correct(reading, AltitudeKind::SextantHs, 2.0, inputs).unwrap();

    // Halving first: the apparent altitude is the lower limb's, 39.733 333 3 deg.
    let halving = step(&b, CorrectionKind::ArtificialHorizonHalving);
    assert_relative_eq!(halving.after_deg, 39.733_333_333_333_334, epsilon = 1e-12);
    // Then refraction, then the limb rule puts the centre back.
    let refraction = step(&b, CorrectionKind::Refraction);
    assert_relative_eq!(refraction.after_deg, 39.713_399_493_879_89, epsilon = 1e-12);
    let sd = step(&b, CorrectionKind::Semidiameter);
    assert!(sd.applied);
    assert_relative_eq!(sd.delta_arcmin, 16.0, epsilon = 1e-9);
    assert_relative_eq!(sd.after_deg, 39.980_066_160_546_556, epsilon = 1e-12);
    let parallax = step(&b, CorrectionKind::Parallax);
    assert_relative_eq!(
        parallax.delta_arcmin,
        0.115_354_170_721_279_9,
        epsilon = 1e-9
    );

    // Ho is the centre altitude corrected for refraction and parallax: the 2h - 2SD
    // reading has come back to h.
    let expected = centre_ha - 1.196_030_367_206_708_7 / 60.0 + 0.115_354_170_721_279_9 / 60.0;
    assert_relative_eq!(b.ho_deg, expected, epsilon = 1e-12);
    assert_relative_eq!(b.ho_deg, 39.981_988_730_058_575, epsilon = 1e-12);
    assert_relative_eq!(b.sigma_ho_arcmin, 1.0, epsilon = 1e-12);
}

// ---------------------------------------------------------------------------
// the Sun
// ---------------------------------------------------------------------------

/// Hs 30 deg, sea horizon, height 0, SD 16.0', HP 0.15'. Refraction 1.717 310 1',
/// parallax `0.15 cos 30 = 0.129 903 8'`.
#[test]
fn sun_limbs_differ_by_two_semidiameters() {
    let lower = correct(
        30.0,
        AltitudeKind::SextantHs,
        1.0,
        sun("obs-l", Limb::Lower),
    )
    .unwrap();
    let upper = correct(
        30.0,
        AltitudeKind::SextantHs,
        1.0,
        sun("obs-u", Limb::Upper),
    )
    .unwrap();
    let centre = correct(
        30.0,
        AltitudeKind::SextantHs,
        1.0,
        sun("obs-c", Limb::Center),
    )
    .unwrap();

    assert_relative_eq!(lower.ho_deg, 30.240_209_894_616_91, epsilon = 1e-12);
    assert_relative_eq!(upper.ho_deg, 29.706_876_561_283_58, epsilon = 1e-12);
    assert_relative_eq!(centre.ho_deg, 29.973_543_227_950_245, epsilon = 1e-12);

    // Lower limb adds SD, upper limb subtracts it: the gap is exactly 2 SD = 32.0'.
    assert_relative_eq!((lower.ho_deg - upper.ho_deg) * 60.0, 32.0, epsilon = 1e-9);
    assert_relative_eq!(
        step(&lower, CorrectionKind::Semidiameter).delta_arcmin,
        16.0,
        epsilon = 1e-9
    );
    assert_relative_eq!(
        step(&upper, CorrectionKind::Semidiameter).delta_arcmin,
        -16.0,
        epsilon = 1e-9
    );
    assert!(!step(&centre, CorrectionKind::Semidiameter).applied);

    // Parallax is added for every Sun sight, limb or not: 0.15' cos(Ha).
    for b in [&lower, &upper, &centre] {
        assert_relative_eq!(
            step(b, CorrectionKind::Parallax).delta_arcmin,
            0.129_903_810_567_665_8,
            epsilon = 1e-9
        );
    }
}

#[test]
fn stars_get_no_semidiameter_or_parallax() {
    let b = correct(30.0, AltitudeKind::SextantHs, 1.0, star("obs-star")).unwrap();
    let sd = step(&b, CorrectionKind::Semidiameter);
    let pa = step(&b, CorrectionKind::Parallax);
    assert!(!sd.applied && !pa.applied);
    assert!(sd.note.contains("Sun only"), "{}", sd.note);
    assert!(pa.note.contains("Sun only"), "{}", pa.note);
    assert_relative_eq!(b.ho_deg, 30.0 - BENNETT_30 / 60.0, epsilon = 1e-12);
}

#[test]
fn a_limb_on_a_star_is_a_warning_not_a_correction() {
    let mut inputs = star("obs-star");
    inputs.limb = Limb::Lower;
    let b = correct(30.0, AltitudeKind::SextantHs, 1.0, inputs).unwrap();
    assert_relative_eq!(b.ho_deg, 30.0 - BENNETT_30 / 60.0, epsilon = 1e-12);
    assert!(
        b.warnings
            .iter()
            .any(|w| matches!(w, Warning::LimbIgnoredForStar { .. })),
        "{:?}",
        b.warnings
    );
}

#[test]
fn an_unknown_solar_semidiameter_is_declared_not_assumed() {
    let mut inputs = sun("obs-sd0", Limb::Lower);
    inputs.direction = Some(GeocentricDirection {
        gha_deg: 180.0,
        dec_deg: 0.0,
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: 0.0,
    });
    let b = correct(30.0, AltitudeKind::SextantHs, 1.0, inputs).unwrap();
    // SD 0 means "unknown", so nothing is applied and Ho stays a limb altitude.
    assert_relative_eq!(b.ho_deg, 30.0 - BENNETT_30 / 60.0, epsilon = 1e-12);
    let messages: Vec<&str> = b
        .warnings
        .iter()
        .filter_map(|w| match w {
            Warning::Other { message } => Some(message.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        messages.iter().any(|m| m.contains("semidiameter")),
        "{messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.contains("parallax")),
        "{messages:?}"
    );
}

// ---------------------------------------------------------------------------
// low altitude and rejections
// ---------------------------------------------------------------------------

#[test]
fn low_altitude_inflates_sigma_below_five_degrees_and_flags_below_ten() {
    // Ha 3 deg: flagged, 1.0' added in quadrature -> sqrt(1 + 1) = 1.414 213 562 4'.
    let b = correct(3.0, AltitudeKind::SextantHs, 1.0, star("obs-3")).unwrap();
    assert_relative_eq!(b.ho_deg, 3.0 - BENNETT_3 / 60.0, epsilon = 1e-12);
    assert_relative_eq!(b.sigma_ho_arcmin, std::f64::consts::SQRT_2, epsilon = 1e-12);
    match b
        .warnings
        .iter()
        .find(|w| matches!(w, Warning::LowAltitudeRefraction { .. }))
    {
        Some(Warning::LowAltitudeRefraction {
            apparent_altitude_deg,
            sigma_added_arcmin,
            ..
        }) => {
            assert_relative_eq!(*apparent_altitude_deg, 3.0, epsilon = 1e-12);
            assert_eq!(*sigma_added_arcmin, 1.0);
        }
        other => panic!("expected a low-altitude warning, got {other:?}"),
    }

    // Ha 7 deg: flagged only, sigma untouched.
    let b = correct(7.0, AltitudeKind::SextantHs, 1.0, star("obs-7")).unwrap();
    assert_relative_eq!(b.ho_deg, 7.0 - BENNETT_7 / 60.0, epsilon = 1e-12);
    assert_eq!(b.sigma_ho_arcmin, 1.0);
    match b
        .warnings
        .iter()
        .find(|w| matches!(w, Warning::LowAltitudeRefraction { .. }))
    {
        Some(Warning::LowAltitudeRefraction {
            sigma_added_arcmin, ..
        }) => {
            assert_eq!(*sigma_added_arcmin, 0.0);
        }
        other => panic!("expected a low-altitude warning, got {other:?}"),
    }

    // Ha 12 deg: nothing to say.
    let b = correct(12.0, AltitudeKind::SextantHs, 1.0, star("obs-12")).unwrap();
    assert!(b.warnings.is_empty(), "{:?}", b.warnings);
    assert_eq!(b.sigma_ho_arcmin, 1.0);

    // The boundaries themselves: 5 deg is flagged but not inflated, 10 deg is silent.
    let five = correct(5.0, AltitudeKind::SextantHs, 1.0, star("obs-5")).unwrap();
    assert_eq!(five.sigma_ho_arcmin, 1.0);
    assert!(
        five.warnings
            .iter()
            .any(|w| matches!(w, Warning::LowAltitudeRefraction { .. }))
    );
    let ten = correct(10.0, AltitudeKind::SextantHs, 1.0, star("obs-10")).unwrap();
    assert!(ten.warnings.is_empty(), "{:?}", ten.warnings);
}

#[test]
fn an_altitude_below_the_horizon_after_dip_is_rejected() {
    // Hs 0 deg 01.8' with 2 m of height: dip 2.489' puts Ha at -0.011 483 6 deg.
    let mut inputs = star("obs-neg");
    inputs.height_of_eye_m = 2.0;
    match correct(0.03, AltitudeKind::SextantHs, 1.0, inputs) {
        Err(SkyfixError::Rejected { id, reason }) => {
            assert_eq!(id, "obs-neg");
            assert!(reason.contains("below the horizon"), "{reason}");
            assert!(reason.contains("RefractionOutOfRange"), "{reason}");
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
    // Exactly on the horizon is allowed.
    assert!(correct(0.0, AltitudeKind::SextantHs, 1.0, star("obs-zero")).is_ok());
}

#[test]
fn nonsense_inputs_are_rejected_with_a_named_field() {
    // sigma must be positive: a zero sigma is infinite weight in the solver.
    match correct(45.0, AltitudeKind::SextantHs, 0.0, star("obs-s0")) {
        Err(SkyfixError::InvalidField { field, message }) => {
            assert!(field.contains("sigma_arcmin"), "{field}");
            assert!(message.contains("infinite weight"), "{message}");
        }
        other => panic!("expected an invalid-field error, got {other:?}"),
    }
    assert!(matches!(
        correct(45.0, AltitudeKind::SextantHs, -1.0, star("obs-sneg")),
        Err(SkyfixError::InvalidField { .. })
    ));
    assert!(matches!(
        correct(45.0, AltitudeKind::SextantHs, f64::NAN, star("obs-snan")),
        Err(SkyfixError::InvalidField { .. })
    ));

    // Non-finite altitude.
    match correct(f64::NAN, AltitudeKind::SextantHs, 1.0, star("obs-nan")) {
        Err(SkyfixError::NonFinite { field }) => assert!(field.contains("altitude_deg"), "{field}"),
        other => panic!("expected a non-finite error, got {other:?}"),
    }
    assert!(matches!(
        correct(f64::INFINITY, AltitudeKind::SextantHs, 1.0, star("obs-inf")),
        Err(SkyfixError::NonFinite { .. })
    ));

    // Non-finite environment.
    let mut bad = star("obs-p");
    bad.pressure_hpa = f64::NAN;
    assert!(matches!(
        correct(45.0, AltitudeKind::SextantHs, 1.0, bad),
        Err(SkyfixError::InvalidField { .. })
    ));
    let mut bad = star("obs-t");
    bad.temperature_c = -300.0;
    assert!(matches!(
        correct(45.0, AltitudeKind::SextantHs, 1.0, bad),
        Err(SkyfixError::InvalidField { .. })
    ));
}

#[test]
fn an_altitude_above_the_zenith_is_rejected() {
    // A 185 deg artificial-horizon reading halves to 92.5 deg: above the zenith.
    let mut inputs = star("obs-zen");
    inputs.horizon = HorizonMode::ArtificialReflected;
    match correct(185.0, AltitudeKind::SextantHs, 1.0, inputs) {
        Err(SkyfixError::Rejected { reason, .. }) => {
            assert!(reason.contains("above the zenith"), "{reason}");
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
}

#[test]
fn a_negative_height_of_eye_is_reported_and_treated_as_zero() {
    let mut inputs = star("obs-h");
    inputs.height_of_eye_m = -2.0;
    let b = correct(45.0, AltitudeKind::SextantHs, 1.0, inputs).unwrap();
    assert_eq!(step(&b, CorrectionKind::Dip).delta_arcmin, 0.0);
    assert!(
        b.warnings
            .iter()
            .any(|w| matches!(w, Warning::Other { message } if message.contains("negative"))),
        "{:?}",
        b.warnings
    );
}

#[test]
fn an_observed_ho_at_low_altitude_is_flagged_but_its_sigma_is_left_alone() {
    // The sigma of an observed_ho record was declared by whoever applied refraction to
    // it. Flag the extra refraction uncertainty; do not inflate a second time.
    let b = correct(3.0, AltitudeKind::ObservedHo, 1.0, star("obs-ho-low")).unwrap();
    assert_eq!(b.ho_deg, 3.0);
    assert_eq!(b.sigma_ho_arcmin, 1.0);
    match b
        .warnings
        .iter()
        .find(|w| matches!(w, Warning::LowAltitudeRefraction { .. }))
    {
        Some(Warning::LowAltitudeRefraction {
            sigma_added_arcmin, ..
        }) => assert_eq!(*sigma_added_arcmin, 0.0),
        other => panic!("expected a low-altitude warning, got {other:?}"),
    }
}

#[test]
fn an_apparent_ha_under_an_artificial_horizon_is_not_halved_again() {
    // `apparent_ha` is defined as post-halving (CONVENTIONS section 4). Halving it a
    // second time would quietly put the sight 20 degrees out and leave sigma too small.
    let mut inputs = star("obs-ah-ha");
    inputs.horizon = HorizonMode::ArtificialReflected;
    let b = correct(40.0, AltitudeKind::ApparentHa, 2.0, inputs).unwrap();
    assert!(!step(&b, CorrectionKind::ArtificialHorizonHalving).applied);
    assert_relative_eq!(
        b.ho_deg,
        40.0 - refraction_arcmin(40.0, 1010.0, 10.0) / 60.0,
        epsilon = 1e-12
    );
    assert_eq!(
        b.sigma_ho_arcmin, 2.0,
        "sigma already describes the halved angle"
    );
    // The halving is named among the ignored steps, so the danger is visible.
    let ignored = b
        .warnings
        .iter()
        .find_map(|w| match w {
            Warning::AlreadyCorrected { ignored, .. } => Some(ignored.clone()),
            _ => None,
        })
        .expect("already-corrected warning");
    assert!(ignored.contains(&CorrectionKind::ArtificialHorizonHalving));
}
