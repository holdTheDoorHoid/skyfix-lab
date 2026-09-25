//! The published worked examples, reproduced by the rigorous methods.
//!
//! Source: The American Practical Navigator (Bowditch), NGA Pub. No. 9, 2019 edition,
//! vol. 1, ch. 19, sections 1910 and 1912 and Figure 1912c (the Nautical Almanac 2016
//! Polaris table and its illustration). U.S. Government work, public domain. The
//! numbers are in `fixtures/reference/bowditch_worked_examples.json` with provenance.
//!
//! The book rounds to 0.1' with the Almanac's tables, so agreement to a tenth or two is
//! what "reproduced" means here; each test prints both numbers
//! (`cargo test -p skyfix-core --test nav_methods_worked_examples -- --nocapture`).

mod nav_support;

use nav_support::{EphemerisTable, book_case, f, provider, s};
use skyfix_core::methods::noon::noon_sight;
use skyfix_core::methods::polaris::polaris_latitude;
use skyfix_core::types::{
    AltitudeKind, Clock, CorrectionKind, DrPosition, HorizonMode, Instrument, Limb, MeridianSide,
    NoonMethod, NoonSightOptions, Observation, Observer, PolarisOptions, SESSION_SCHEMA, Session,
    SessionMeta, VesselMotion,
};

fn arcmin(deg: f64) -> f64 {
    deg * 60.0
}

fn polaris_session(utc: &str, ho_deg: f64) -> Session {
    Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta::default(),
        observer: Observer::default(),
        instrument: Instrument::default(),
        clock: Clock::default(),
        observations: vec![Observation {
            id: "polaris".into(),
            body: "Polaris".into(),
            utc: utc.into(),
            altitude_deg: ho_deg,
            altitude_kind: AltitudeKind::ObservedHo,
            sigma_arcmin: 0.2,
            limb: Limb::Center,
            horizon: None,
            geocentric: None,
            notes: String::new(),
        }],
    }
}

#[test]
fn bowditch_1910_latitude_at_local_apparent_noon() {
    let c = book_case("bowditch-1910-lan");
    let i = &c["input"];
    let e = &c["expected"];
    let session = Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta::default(),
        observer: Observer {
            height_of_eye_m: f(&i["height_of_eye_m"]),
            ..Observer::default()
        },
        instrument: Instrument {
            name: "Bowditch 1910".into(),
            index_correction_arcmin: f(&i["index_correction_arcmin"]),
            horizon: HorizonMode::Sea,
            index_error_log: Vec::new(),
        },
        clock: Clock::default(),
        observations: vec![Observation {
            id: "lan".into(),
            body: "Sun".into(),
            utc: s(&i["utc"]),
            altitude_deg: f(&i["hs_deg"]),
            altitude_kind: AltitudeKind::SextantHs,
            sigma_arcmin: 0.2,
            limb: Limb::Lower,
            horizon: None,
            geocentric: None,
            notes: String::new(),
        }],
    };
    let options = NoonSightOptions {
        dr: Some(DrPosition {
            lat_deg: f(&i["dr_lat_deg"]),
            lon_deg: f(&i["dr_lon_deg"]),
            sigma_nm: None,
        }),
        vessel: Some(VesselMotion {
            course_deg: f(&i["course_deg"]),
            speed_kn: f(&i["speed_kn"]),
        }),
        ..Default::default()
    };
    let r = noon_sight(&session, &provider(), &options).unwrap();
    assert_eq!(r.method, NoonMethod::MaximumAltitude);
    assert_eq!(r.side, MeridianSide::South);

    let sight = &r.sights[0];
    let dip = sight
        .corrections
        .steps
        .iter()
        .find(|s| s.kind == CorrectionKind::Dip)
        .unwrap()
        .delta_arcmin;
    let rows = [
        ("dip, arcmin", f(&e["dip_arcmin"]), dip, 0.05),
        (
            "declination, arcmin",
            arcmin(f(&e["declination_deg"])),
            arcmin(r.declination_deg),
            0.1,
        ),
        (
            "Ho, arcmin",
            arcmin(f(&e["ho_deg"])),
            arcmin(sight.ho_deg),
            0.15,
        ),
        (
            "zenith distance, arcmin",
            arcmin(f(&e["zenith_distance_deg"])),
            arcmin(r.zenith_distance_deg),
            0.2,
        ),
        (
            "latitude, arcmin",
            arcmin(f(&e["latitude_deg"])),
            arcmin(r.latitude.lat_deg),
            0.2,
        ),
    ];
    println!("Bowditch 1910 (LAN, 2016-03-09): book vs SkyFix");
    for (label, book, ours, tol) in rows {
        println!(
            "  {label:<26} book {book:>11.2}  skyfix {ours:>11.3}  diff {:+.3}",
            ours - book
        );
        assert!((ours - book).abs() <= tol, "{label}: {ours} vs {book}");
    }
    println!("  rule: {}", r.latitude_rule);
    // The default reads one altitude as the PEAK, and on a vessel running 7 kn north
    // the peak is a^2/4k above the meridian altitude. The book's altitude is taken AT
    // LAN, which is the same thing to its 0.1' rounding; the ex-meridian reading
    // (the altitude at the recorded time, reduced on the DR meridian) shows it.
    println!(
        "  peak minus meridian altitude (vessel 10 kn on 045): {:.3}'",
        r.curvature.max_minus_meridian_arcmin
    );
    assert!(r.curvature.max_minus_meridian_arcmin > 0.0);
    assert!(r.curvature.max_minus_meridian_arcmin < 0.1);
    assert!(r.latitude_rule.contains("SOUTH"));
    assert!(
        r.latitude_rule
            .contains("latitude = declination + zenith distance")
    );
    assert!(r.longitude.is_none());

    let ex = NoonSightOptions {
        single_altitude: skyfix_core::types::SingleAltitudeMode::ExMeridian,
        ..options
    };
    let rx = noon_sight(&session, &provider(), &ex).unwrap();
    assert_eq!(rx.method, NoonMethod::ExMeridian);
    println!(
        "  as an altitude at 15:08:04 reduced on the DR meridian (ex-meridian): latitude \
         {:.3}' ({:+.3}' from the book); d(lat)/dE {:+.4}'/NM",
        arcmin(rx.latitude.lat_deg),
        arcmin(rx.latitude.lat_deg) - arcmin(f(&e["latitude_deg"])),
        rx.longitude_sensitivity_arcmin_per_nm.unwrap()
    );
    assert!((arcmin(rx.latitude.lat_deg) - arcmin(f(&e["latitude_deg"]))).abs() <= 0.2);
}

#[test]
fn bowditch_1912_latitude_by_polaris() {
    let c = book_case("bowditch-1912-polaris");
    let i = &c["input"];
    let e = &c["expected"];
    let session = polaris_session(&s(&i["utc"]), f(&i["ho_deg"]));
    let options = PolarisOptions {
        dr: Some(DrPosition {
            lat_deg: f(&i["dr_lat_deg"]),
            lon_deg: f(&i["dr_lon_deg"]),
            sigma_nm: Some(10.0),
        }),
        ..Default::default()
    };
    let r = polaris_latitude(&session, &provider(), Some(&EphemerisTable), &options).unwrap();
    let p = &r.polaris[0];
    let a = p.almanac.as_ref().expect("almanac terms");
    let rows = [
        (
            "LHA Aries, arcmin",
            arcmin(f(&e["lha_aries_deg"])),
            arcmin(a.lha_aries_deg),
            0.1,
        ),
        ("a0, arcmin", f(&e["a0_arcmin"]), a.a0_arcmin, 0.1),
        ("a1, arcmin", f(&e["a1_arcmin"]), a.a1_arcmin, 0.1),
        ("a2, arcmin", f(&e["a2_arcmin"]), a.a2_arcmin, 0.1),
        (
            "total correction, arcmin",
            f(&e["total_correction_arcmin"]),
            p.correction_arcmin,
            0.15,
        ),
        (
            "latitude, arcmin",
            arcmin(f(&e["latitude_deg"])),
            arcmin(r.latitude.lat_deg),
            0.15,
        ),
    ];
    println!("Bowditch 1912 (Polaris, 2016-03-22): book vs SkyFix");
    for (label, book, ours, tol) in rows {
        println!(
            "  {label:<26} book {book:>11.2}  skyfix {ours:>11.3}  diff {:+.3}",
            ours - book
        );
        assert!((ours - book).abs() <= tol, "{label}: {ours} vs {book}");
    }
    println!(
        "  table formula vs rigorous: {:+.3}'; azimuth {:.2} deg; d(lat)/dE {:+.4}'/NM",
        a.difference_arcmin, p.azimuth_deg, p.longitude_sensitivity_arcmin_per_nm
    );
    assert!(a.within_printed_table);
    assert!(a.difference_arcmin.abs() < 0.05);
}

#[test]
fn nautical_almanac_2016_polaris_illustration() {
    let c = book_case("nautical-almanac-2016-polaris-illustration");
    let i = &c["input"];
    let e = &c["expected"];
    let session = polaris_session(&s(&i["utc"]), f(&i["ho_deg"]));
    let options = PolarisOptions {
        dr: Some(DrPosition {
            lat_deg: f(&i["dr_lat_deg"]),
            lon_deg: f(&i["dr_lon_deg"]),
            sigma_nm: None,
        }),
        ..Default::default()
    };
    let r = polaris_latitude(&session, &provider(), Some(&EphemerisTable), &options).unwrap();
    let p = &r.polaris[0];
    let a = p.almanac.as_ref().expect("almanac terms");
    let rows = [
        (
            "LHA Aries, arcmin",
            arcmin(f(&e["lha_aries_deg"])),
            arcmin(a.lha_aries_deg),
            0.5,
        ),
        ("a0, arcmin", f(&e["a0_arcmin"]), a.a0_arcmin, 0.1),
        ("a1, arcmin", f(&e["a1_arcmin"]), a.a1_arcmin, 0.1),
        ("a2, arcmin", f(&e["a2_arcmin"]), a.a2_arcmin, 0.1),
        (
            "latitude, arcmin",
            arcmin(f(&e["latitude_deg"])),
            arcmin(r.latitude.lat_deg),
            0.15,
        ),
    ];
    println!("Nautical Almanac 2016 Polaris illustration (2016-04-21): book vs SkyFix");
    for (label, book, ours, tol) in rows {
        println!(
            "  {label:<26} book {book:>11.2}  skyfix {ours:>11.3}  diff {:+.3}",
            ours - book
        );
        assert!((ours - book).abs() <= tol, "{label}: {ours} vs {book}");
    }
}
