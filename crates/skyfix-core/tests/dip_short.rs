//! The dip short of the horizon (CONVENTIONS section 5, step 2, `shore` horizon) against
//! Bowditch 2019 vol. 2 Table 14, typed into `fixtures/reference/bowditch_dip_short.json`,
//! and its place in the correction chain, the predicted reading and the session format.

use serde_json::Value;
use skyfix_core::corrections::{
    self, CorrectionInputs, M_PER_FT, SightBody, dip_arcmin, dip_short_arcmin, horizon_dip,
    sea_horizon_distance_nm,
};
use skyfix_core::sights::predict::predict_sextant;
use skyfix_core::types::{
    AltitudeKind, CorrectionKind, GeocentricDirection, HorizonMode, Instrument, Limb, Session,
    SightObserver, Warning,
};

fn table() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference/bowditch_dip_short.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn bowditch_table_14_reproduces_to_its_printed_tenth() {
    let t = table();
    let cases = t["cases"].as_array().unwrap();
    assert!(cases.len() >= 10);
    let mut worst: f64 = 0.0;
    println!(
        "{:>6} {:>6} {:>8} {:>9} {:>7}  branch",
        "h ft", "d NM", "Table 14", "SkyFix", "diff"
    );
    for c in cases {
        let h_m = c["height_ft"].as_f64().unwrap() * M_PER_FT;
        let d = c["distance_nm"].as_f64().unwrap();
        let printed = c["dip_arcmin"].as_f64().unwrap();
        let dip = horizon_dip(HorizonMode::Shore { distance_nm: d }, h_m).unwrap();
        let beyond = c
            .get("beyond_horizon")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert_eq!(dip.beyond_horizon, beyond, "{c}");
        let diff = dip.dip_arcmin - printed;
        worst = worst.max(diff.abs());
        println!(
            "{:>6} {:>6} {:>8.1} {:>9.3} {:>+7.3}  {}",
            c["height_ft"],
            d,
            printed,
            dip.dip_arcmin,
            diff,
            if beyond { "sea dip" } else { "dip short" }
        );
        // The brief asks for 0.1'; the table's own rounding is 0.05'.
        assert!(diff.abs() <= 0.05 + 1e-3, "{c}: {}", dip.dip_arcmin);
    }
    println!("worst {worst:.3}' over {} entries", cases.len());
}

#[test]
fn the_small_angle_constants_are_bowditchs_formula_in_metres() {
    // 0.4158' d + 1.8562' h/d: the linear form of 60 atan(h_ft/(6076.1 d) + d/8268).
    let arcmin_per_rad = 10_800.0 / std::f64::consts::PI;
    assert!((arcmin_per_rad / 8268.0 - 0.4158).abs() < 5e-5);
    assert!((arcmin_per_rad / (M_PER_FT * 6076.1) - 1.8562).abs() < 5e-5);
    for (h, d) in [(2.0, 1.0), (10.0, 3.0), (4.0, 0.5)] {
        let linear = 0.4158 * d + 1.8562 * h / d;
        assert!((dip_short_arcmin(h, d) - linear).abs() < 0.01, "{h} {d}");
    }
    // Where the arctangent matters: 100 ft (30.48 m) and 0.2 NM, Table 14 prints 282.3'.
    let linear: f64 = 0.4158 * 0.2 + 1.8562 * 30.48 / 0.2;
    assert!((linear - 282.3).abs() > 0.5);
    assert!((dip_short_arcmin(30.48, 0.2) - 282.3).abs() < 0.05);
}

#[test]
fn the_dip_short_meets_the_sea_dip_at_the_sea_horizon() {
    for h in [0.5, 2.0, 10.0, 30.0] {
        let dh = sea_horizon_distance_nm(h);
        // Bowditch's horizon distance: 1.17 sqrt(h ft) (vol. 2 section 402).
        assert!(
            (dh - 1.17 * (h / M_PER_FT).sqrt()).abs() < 0.01 * dh,
            "{h}: {dh}"
        );
        // At the horizon the formula is its own minimum, 0.97' sqrt(h ft) = 1.757' sqrt(h m).
        let at = dip_short_arcmin(h, dh);
        assert!(
            (at - 0.97 * (h / M_PER_FT).sqrt()).abs() < 0.002 * at,
            "{h}"
        );
        // The chain never subtracts less than the sea dip for a nearer shoreline, and is
        // continuous across the horizon.
        let mut prev = f64::INFINITY;
        for k in 1..=200 {
            let d = dh * 1.2 * k as f64 / 200.0;
            let dip = horizon_dip(HorizonMode::Shore { distance_nm: d }, h).unwrap();
            assert!(dip.dip_arcmin >= dip_arcmin(h) - 1e-12);
            assert!(
                dip.dip_arcmin <= prev + 1e-12,
                "the dip grows as the shore nears"
            );
            prev = dip.dip_arcmin;
        }
    }
}

fn inputs(horizon: HorizonMode, height_of_eye_m: f64) -> CorrectionInputs<'static> {
    CorrectionInputs {
        id: "s1",
        is_sun: false,
        limb: Limb::Center,
        horizon,
        index_correction_arcmin: -1.5,
        height_of_eye_m,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
        direction: None,
    }
}

#[test]
fn the_chain_subtracts_the_dip_short_in_step_two() {
    let shore = HorizonMode::Shore { distance_nm: 1.2 };
    let b = corrections::correct_sight(
        30.0,
        AltitudeKind::SextantHs,
        1.0,
        inputs(shore, 3.0),
        SightBody::Star,
    )
    .unwrap();
    assert_eq!(b.steps.len(), 6);
    let dip = &b.steps[1];
    assert_eq!(dip.kind, CorrectionKind::Dip);
    assert!(dip.applied);
    assert!((dip.delta_arcmin + dip_short_arcmin(3.0, 1.2)).abs() < 1e-9);
    assert!(dip.note.contains("Table 14"), "{}", dip.note);
    // Only step 2 differs from a sea horizon: the apparent altitude it hands on is lower
    // by the difference of the dips (refraction then follows that apparent altitude).
    let sea = corrections::correct_sight(
        30.0,
        AltitudeKind::SextantHs,
        1.0,
        inputs(HorizonMode::Sea, 3.0),
        SightBody::Star,
    )
    .unwrap();
    assert_eq!(sea.steps[0], b.steps[0]);
    let expected = sea.steps[1].after_deg - (dip_short_arcmin(3.0, 1.2) - dip_arcmin(3.0)) / 60.0;
    assert!((b.steps[1].after_deg - expected).abs() < 1e-12);
    assert!(
        b.warnings
            .iter()
            .all(|w| !matches!(w, Warning::ShoreBeyondSeaHorizon { .. }))
    );

    // Beyond the sea horizon (3.66 NM for 3 m): the sea dip, and the warning.
    let far = HorizonMode::Shore { distance_nm: 6.0 };
    let b = corrections::correct_sight(
        30.0,
        AltitudeKind::SextantHs,
        1.0,
        inputs(far, 3.0),
        SightBody::Star,
    )
    .unwrap();
    assert!((b.steps[1].delta_arcmin + dip_arcmin(3.0)).abs() < 1e-12);
    assert!(b.warnings.iter().any(|w| matches!(
        w,
        Warning::ShoreBeyondSeaHorizon { distance_nm, sea_horizon_nm, .. }
            if *distance_nm == 6.0 && (*sea_horizon_nm - 3.66).abs() < 0.01
    )));

    // A distance that is not a distance is refused.
    for bad in [0.0, -1.0, f64::NAN] {
        let e = corrections::correct_sight(
            30.0,
            AltitudeKind::SextantHs,
            1.0,
            inputs(HorizonMode::Shore { distance_nm: bad }, 3.0),
            SightBody::Star,
        )
        .unwrap_err();
        assert!(e.to_string().contains("shoreline"), "{e}");
    }
    // An apparent altitude has already had its dip: the shore distance is ignored, said so.
    let b = corrections::correct_sight(
        30.0,
        AltitudeKind::ApparentHa,
        1.0,
        inputs(shore, 3.0),
        SightBody::Star,
    )
    .unwrap();
    assert!(b.warnings.iter().any(|w| matches!(
        w,
        Warning::AlreadyCorrected { ignored, .. } if ignored.contains(&CorrectionKind::Dip)
    )));
}

#[test]
fn a_predicted_reading_to_a_shore_horizon_reduces_back_to_hc() {
    let observer = SightObserver {
        lat_deg: 41.0,
        lon_deg: -71.0,
        height_of_eye_m: 4.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
    };
    let instrument = Instrument {
        horizon: HorizonMode::Shore { distance_nm: 0.8 },
        index_correction_arcmin: 0.7,
        ..Instrument::default()
    };
    let direction = GeocentricDirection {
        gha_deg: 80.0,
        dec_deg: 20.0,
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: 0.0,
    };
    let p = predict_sextant(
        &observer,
        &instrument,
        "Vega",
        Limb::Center,
        2.461e6,
        direction,
        "test",
    )
    .unwrap();
    assert!((p.corrections.ho_deg - p.hc_deg).abs() < 1e-9);
    // The reading is higher than to the sea horizon by the difference of the dips.
    let sea = predict_sextant(
        &observer,
        &Instrument {
            horizon: HorizonMode::Sea,
            ..instrument.clone()
        },
        "Vega",
        Limb::Center,
        2.461e6,
        direction,
        "test",
    )
    .unwrap();
    let diff = (p.hs_deg - sea.hs_deg) * 60.0;
    assert!(
        (diff - (dip_short_arcmin(4.0, 0.8) - dip_arcmin(4.0))).abs() < 1e-6,
        "{diff}"
    );
}

#[test]
fn a_shore_horizon_round_trips_through_json_and_csv() {
    let json = r#"{
      "schema": "skyfix.session/1",
      "instrument": {"horizon": {"shore": {"distance_nm": 1.25}}},
      "observer": {"height_of_eye_m": 3.0},
      "observations": [
        {"id": "a", "body": "Vega", "utc": "2026-10-01T01:30:00Z", "altitude_deg": 61.2,
         "altitude_kind": "sextant_hs", "horizon": {"shore": {"distance_nm": 0.4}},
         "geocentric": {"gha_deg": 123.4, "dec_deg": 38.8}},
        {"id": "b", "body": "Deneb", "utc": "2026-10-01T01:31:00Z", "altitude_deg": 70.0,
         "altitude_kind": "sextant_hs", "horizon": "sea",
         "geocentric": {"gha_deg": 100.0, "dec_deg": 45.3}}
      ]
    }"#;
    let (s, _) = skyfix_core::session::parse_session(json).unwrap();
    assert_eq!(
        s.instrument.horizon,
        HorizonMode::Shore { distance_nm: 1.25 }
    );
    assert_eq!(
        s.observations[0].horizon,
        Some(HorizonMode::Shore { distance_nm: 0.4 })
    );
    let back: Session = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(back, s);
    let csv = skyfix_core::session::to_csv(&s);
    assert!(csv.contains("# instrument.horizon=shore:1.25"), "{csv}");
    assert!(csv.contains(",shore:0.4,"), "{csv}");
    assert_eq!(skyfix_core::session::from_csv(&csv).unwrap(), s);
    // A shore horizon without a usable distance is refused at validation.
    let bad = json.replace("1.25", "0");
    let e = skyfix_core::session::parse_session(&bad).unwrap_err();
    assert!(e.to_string().contains("instrument.horizon"), "{e}");
}
