//! The twilight sight planner (`visibility::plan_sights`, docs/NAVIGATION_SKY.md).
//!
//! The twilight instants are checked against Skyfield (`fixtures/reference/
//! nautical_twilight.json`, CONVENTIONS 13.7: 10 s), and the plans for the evening of
//! the February 2025 planet parade off Cape May for what a navigator would want: three
//! to five bodies spread round the horizon, bright enough for the twilight, each with a
//! sextant reading that reduces back to its computed altitude.

use serde::Deserialize;
use skyfix_core::corrections::{CorrectionInputs, correct_sight, sight_body};
use skyfix_core::planner::PlanOptions;
use skyfix_core::time::parse_utc;
use skyfix_core::types::{
    AltitudeKind, GeocentricDirection, HorizonMode, Instrument, Limb, SightObserver,
};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::fixture_pack::CompositeProvider;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sights::{SightPlanetProvider, sight_bodies};
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::visibility::{nautical_twilights, plan_sights};

fn auto() -> CompositeProvider {
    CompositeProvider::new("test-auto")
        .with(SunProvider::new())
        .with(MoonProvider::new())
        .with(SightPlanetProvider::new())
        .with(StarProvider::new())
}

fn candidates() -> Vec<&'static str> {
    sight_bodies().into_iter().filter(|b| *b != "Sun").collect()
}

#[derive(Debug, Deserialize)]
struct File {
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    time_tolerance_s: f64,
}

#[derive(Debug, Deserialize)]
struct Crossing {
    jd_utc: f64,
    level_deg: f64,
    rising: bool,
}

#[derive(Debug, Deserialize)]
struct Case {
    site: String,
    lat_deg: f64,
    lon_deg: f64,
    jd_from: f64,
    crossings: Vec<Crossing>,
}

#[test]
fn twilight_windows_match_skyfields_crossings() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference/nautical_twilight.json");
    let f: File = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let sky = Sky::new();
    let mut worst = 0.0f64;
    for c in &f.cases {
        let windows = nautical_twilights(&sky, c.lat_deg, c.lon_deg, c.jd_from, c.jd_from + 2.0);
        let nearest = |jd: f64, level: f64, rising: bool| -> f64 {
            c.crossings
                .iter()
                .filter(|x| x.level_deg == level && x.rising == rising)
                .map(|x| (x.jd_utc - jd).abs() * 86_400.0)
                .fold(f64::INFINITY, f64::min)
        };
        for w in &windows {
            // Boundaries inside the fixture's two days must be Skyfield's crossings.
            let inside = |jd: f64| jd > c.jd_from + 0.01 && jd < c.jd_from + 1.99;
            let checks: Vec<(f64, f64, bool)> = match (w.kind, w.note.is_some()) {
                ("evening", false) => vec![(w.jd_start, -6.0, false), (w.jd_end, -12.0, false)],
                ("evening", true) => vec![(w.jd_start, -6.0, false)],
                ("morning", false) => vec![(w.jd_start, -12.0, true), (w.jd_end, -6.0, true)],
                ("morning", true) => vec![(w.jd_end, -6.0, true)],
                _ => unreachable!(),
            };
            for (jd, level, rising) in checks {
                if !inside(jd) {
                    continue;
                }
                let d = nearest(jd, level, rising);
                println!("{} {} {level}: {d:.2} s", c.site, w.kind);
                assert!(
                    d <= f.generator.time_tolerance_s,
                    "{} {}: {d} s",
                    c.site,
                    w.kind
                );
                worst = worst.max(d);
            }
        }
        // And every Skyfield crossing of -6 degrees inside the span opens or closes one.
        for x in c.crossings.iter().filter(|x| x.level_deg == -6.0) {
            if x.jd_utc < c.jd_from + 0.01 || x.jd_utc > c.jd_from + 1.99 {
                continue;
            }
            let found = windows.iter().any(|w| {
                (w.jd_start - x.jd_utc).abs() * 86_400.0 < 10.0
                    || (w.jd_end - x.jd_utc).abs() * 86_400.0 < 10.0
            });
            assert!(found, "{}: no window at the crossing {}", c.site, x.jd_utc);
        }
    }
    println!("worst twilight difference from Skyfield: {worst:.2} s");
}

fn observer() -> SightObserver {
    SightObserver {
        lat_deg: 38.90,
        lon_deg: -74.80,
        height_of_eye_m: 3.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
    }
}

fn instrument() -> Instrument {
    Instrument {
        name: "test".into(),
        index_correction_arcmin: -1.2,
        horizon: HorizonMode::Sea,
    }
}

#[test]
fn the_planet_parade_evening_gets_a_spread_of_bright_bodies_with_readings() {
    let sky = Sky::new();
    let provider = auto();
    let bodies = candidates();
    let start = parse_utc("2025-02-10T18:00:00Z").unwrap();
    let plan = plan_sights(
        &sky,
        &provider,
        &bodies,
        &observer(),
        start,
        start + 1.0,
        &instrument(),
        &PlanOptions::default(),
    )
    .unwrap();
    let kinds: Vec<&str> = plan.windows.iter().map(|w| w.kind.as_str()).collect();
    assert_eq!(kinds, ["evening", "morning"], "{:?}", plan.notes);
    for w in &plan.windows {
        println!(
            "{} twilight {} to {}, Sun {:.1} deg, limit {:.1} mag",
            w.kind, w.utc_start, w.utc_end, w.sun_altitude_deg, w.limiting_magnitude
        );
        assert!(
            (3..=5).contains(&w.sights.len()),
            "{}: {:?}",
            w.kind,
            w.notes
        );
        let mut azimuths: Vec<f64> = Vec::new();
        for s in &w.sights {
            println!(
                "  {:<8} {:>5.1} mag  Hc {:6.2}  Zn {:6.1}  Hs {:7.3}  {:?}",
                s.body,
                s.magnitude.unwrap_or(f64::NAN),
                s.hc_deg,
                s.zn_deg,
                s.hs_deg,
                s.limb
            );
            // Useful altitudes and bright enough for this twilight.
            assert!((15.0..=75.0).contains(&s.hc_deg), "{}", s.body);
            assert!(s.magnitude.is_none_or(|m| m <= w.limiting_magnitude));
            // The predicted reading reduces back to the computed altitude.
            let p = &s.prediction;
            let back = correct_sight(
                s.hs_deg,
                AltitudeKind::SextantHs,
                1.0,
                CorrectionInputs {
                    id: "x",
                    is_sun: false,
                    limb: s.limb,
                    horizon: HorizonMode::Sea,
                    index_correction_arcmin: -1.2,
                    height_of_eye_m: 3.0,
                    pressure_hpa: 1010.0,
                    temperature_c: 10.0,
                    direction: Some(GeocentricDirection {
                        gha_deg: p.gha_deg,
                        dec_deg: p.dec_deg,
                        semidiameter_arcmin: p.semidiameter_arcmin,
                        horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
                    }),
                },
                sight_body(&s.body),
            )
            .unwrap();
            assert!((back.ho_deg - s.hc_deg).abs() < 1e-9, "{}", s.body);
            if s.kind == "moon" {
                assert_ne!(s.limb, Limb::Center);
                // Two days before full: the lower limb is lit, and the reading sits
                // well below Hc (parallax beats refraction and semidiameter).
                assert!(s.hs_deg < s.hc_deg - 0.5, "{} vs {}", s.hs_deg, s.hc_deg);
            } else {
                assert_eq!(s.limb, Limb::Center);
            }
            azimuths.push(s.zn_deg);
        }
        azimuths.sort_by(f64::total_cmp);
        let mut gap: f64 = 360.0 - azimuths.last().unwrap() + azimuths[0];
        for pair in azimuths.windows(2) {
            gap = gap.max(pair[1] - pair[0]);
        }
        assert!(gap < 180.0, "{} twilight: azimuth gap {gap:.0} deg", w.kind);
    }
    // The evening of the parade offers the planets and the Moon.
    let evening = &plan.windows[0];
    let names: Vec<&str> = evening
        .sights
        .iter()
        .map(|b| b.body.as_str())
        .chain(evening.also_eligible.iter().map(String::as_str))
        .collect();
    for planet in ["Venus", "Jupiter", "Mars", "Moon"] {
        assert!(names.contains(&planet), "{planet} missing from {names:?}");
    }
    assert!(
        evening.sights.iter().any(|s| s.kind != "star"),
        "{:?}",
        evening.sights
    );
}

#[test]
fn no_twilight_in_polar_summer_and_an_all_night_twilight_is_said_so() {
    let sky = Sky::new();
    let provider = auto();
    let bodies = candidates();
    let june = parse_utc("2026-06-20T00:00:00Z").unwrap();
    let polar = SightObserver {
        lat_deg: 82.0,
        ..observer()
    };
    let plan = plan_sights(
        &sky,
        &provider,
        &bodies,
        &polar,
        june,
        june + 1.0,
        &instrument(),
        &PlanOptions::default(),
    )
    .unwrap();
    assert!(plan.windows.is_empty());
    assert!(
        plan.notes
            .iter()
            .any(|n| n.contains("no nautical twilight"))
    );

    let north_sea = SightObserver {
        lat_deg: 57.0,
        lon_deg: 3.0,
        ..observer()
    };
    let plan = plan_sights(
        &sky,
        &provider,
        &bodies,
        &north_sea,
        june,
        june + 1.0,
        &instrument(),
        &PlanOptions::default(),
    )
    .unwrap();
    assert!(!plan.windows.is_empty());
    assert!(
        plan.windows
            .iter()
            .any(|w| w.notes.iter().any(|n| n.contains("does not reach -12"))),
        "{:?}",
        plan.windows.iter().map(|w| &w.notes).collect::<Vec<_>>()
    );
    // Bad windows are refused.
    assert!(
        plan_sights(
            &sky,
            &provider,
            &bodies,
            &north_sea,
            june,
            june,
            &instrument(),
            &PlanOptions::default()
        )
        .is_err()
    );
}
