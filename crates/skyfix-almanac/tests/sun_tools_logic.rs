//! `skyfix_almanac::sun_tools` against the rest of the engine (CONVENTIONS 13.10).
//!
//! Every altitude and azimuth a sun tool reports must be the one `sky_state` reports at
//! the same instant (to 0.01°; in practice to the event finder's 0.01" track error), its
//! thresholds must be the ones `find_altitude` and `day_events` find, and its windows must
//! be exactly where their conditions hold. These are checked here by dense brute-force
//! sampling of `sky_state`, independent of how each tool searches.

mod common;

use skyfix_almanac::events::{EventKind, EventOptions, day_events, find_altitude};
use skyfix_almanac::pages::almanac_day;
use skyfix_almanac::sky::{AlmanacError, sky_state};
use skyfix_almanac::sun_tools::alignment::{
    AlignedKind, AlignmentEvent, AlignmentRequest, alignment_days,
};
use skyfix_almanac::sun_tools::analemma::{AnalemmaRequest, ClockKind, analemma};
use skyfix_almanac::sun_tools::azimuth::{AltitudeBand, find_azimuth};
use skyfix_almanac::sun_tools::eot::{ExtremeKind, equation_of_time};
use skyfix_almanac::sun_tools::galactic::{CENTRE, GalacticOptions, galactic_centre_windows};
use skyfix_almanac::sun_tools::hours::{LightKind, LightPeriod, THRESHOLDS_DEG, sun_hours};
use skyfix_almanac::sun_tools::solar::{Panel, SolarYearRequest, solar_day, solar_year};
use skyfix_almanac::sun_tools::sunpath::{PathDay, RiseSetRequest, rise_set_azimuths, sun_path};
use skyfix_almanac::sun_tools::{apparent_equivalent_deg, find_geometric_altitude};
use skyfix_core::time::civil_to_jd;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::{BodyKind, MOON, SUN, Sky};
use skyfix_ephemeris::topocentric::{Site, horizontal};

const SEC: f64 = 1.0 / 86_400.0;

fn philadelphia() -> Site {
    Site {
        height_m: 12.0,
        ..Site::new(39.9526, -75.1652)
    }
}

fn tromso() -> Site {
    Site::new(69.6496, 18.9560)
}

fn sun_alt(sky: &Sky, site: &Site, t: f64) -> f64 {
    sky_state(sky, site, t, &[]).unwrap().sun_altitude_deg
}

// ---------------------------------------------------------------------------
// Golden and blue hour
// ---------------------------------------------------------------------------

#[test]
fn golden_and_blue_hours_are_exactly_where_the_sun_is_in_its_band() {
    let sky = Sky::new();
    let cases = [
        (philadelphia(), (2026, 9, 24), -4.0),
        (philadelphia(), (2026, 6, 21), -4.0),
        (philadelphia(), (2026, 12, 21), -5.0),
        (tromso(), (2026, 12, 21), 1.0),
        (tromso(), (2026, 6, 21), 2.0),
        (tromso(), (2026, 1, 20), 1.0),
        (tromso(), (2026, 11, 26), 1.0),
        (Site::new(-0.18, -78.47), (2026, 3, 20), -5.0),
        (Site::new(-33.87, 151.21), (2026, 7, 1), 10.0),
        (Site::new(89.9, 0.0), (2026, 3, 19), 0.0),
    ];
    let mut windows_seen = 0;
    let mut worst_threshold = 0.0f64;
    for (site, (y, m, d), offset_h) in cases {
        let a = civil_to_jd(y, m, d) - offset_h / 24.0;
        let b = a + 1.0;
        let h = sun_hours(&sky, &site, a, b).unwrap();
        // Every crossing is at its threshold (geometric altitude, sky_state).
        for bd in &h.boundaries {
            for c in &bd.crossings {
                let alt = sun_alt(&sky, &site, c.jd_utc);
                worst_threshold = worst_threshold.max((alt - bd.altitude_deg).abs());
                assert!((c.alt_deg - bd.altitude_deg).abs() < 1e-4, "{c:?}");
            }
            if bd.crossings.is_empty() {
                assert!(bd.always_above != bd.always_below, "{bd:?}");
            } else {
                assert!(!bd.always_above && !bd.always_below);
            }
        }
        // The -6 degree crossings are civil dawn and dusk.
        let civil: Vec<f64> = h
            .sun
            .events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::CivilDawn | EventKind::CivilDusk))
            .map(|e| e.jd_utc)
            .collect();
        let six: Vec<f64> = h.boundaries[0].crossings.iter().map(|c| c.jd_utc).collect();
        assert_eq!(civil.len(), six.len(), "{y}-{m}-{d} at {site:?}");
        for (p, q) in civil.iter().zip(&six) {
            assert!((p - q).abs() < 0.005 * SEC, "{} s", (p - q) / SEC);
        }
        // Brute force: every 2 minutes, the band of the Sun agrees with the windows.
        let mut t = a + 30.0 * SEC;
        while t < b {
            let alt = sun_alt(&sky, &site, t);
            let near = h
                .windows
                .iter()
                .any(|w| (w.jd_start - t).abs() < 2.0 * SEC || (w.jd_end - t).abs() < 2.0 * SEC);
            if !near {
                let inside = h.windows.iter().find(|w| w.jd_start <= t && t < w.jd_end);
                let expect = if alt > -6.0 && alt <= -4.0 {
                    Some(LightKind::Blue)
                } else if alt > -4.0 && alt <= 6.0 {
                    Some(LightKind::Golden)
                } else {
                    None
                };
                assert_eq!(
                    inside.map(|w| w.kind),
                    expect,
                    "{y}-{m}-{d} alt {alt} at {t}"
                );
            }
            t += 120.0 * SEC;
        }
        // Morning windows end climbing, evening windows end sinking.
        for w in &h.windows {
            windows_seen += 1;
            assert!((w.duration_min - (w.jd_end - w.jd_start) * 1440.0).abs() < 1e-9);
            assert_eq!(w.open_start, w.jd_start == a);
            assert_eq!(w.open_end, w.jd_end == b);
            let mid = 0.5 * (w.jd_start + w.jd_end);
            let slope =
                sun_alt(&sky, &site, mid + 60.0 * SEC) - sun_alt(&sky, &site, mid - 60.0 * SEC);
            match w.period {
                LightPeriod::Morning => assert!(slope > 0.0, "{w:?}"),
                LightPeriod::Evening => assert!(slope < 0.0, "{w:?}"),
                _ => {}
            }
        }
    }
    eprintln!(
        "golden/blue hour: {windows_seen} windows at 10 place-days; crossings at their \
         threshold to {worst_threshold:.2e} deg"
    );
    // verify2: ACCURACY.md claims 9e-7 deg; 1e-4 deg (0.36") was a hundred times that.
    assert!(worst_threshold < 1e-5, "{worst_threshold:e}");
}

#[test]
fn polar_golden_and_blue_hours_use_the_twilight_vocabulary() {
    let sky = Sky::new();
    // Tromso at midwinter: the Sun peaks at about -3 degrees, so golden hour is the
    // middle of the day and +6 is never reached.
    let a = civil_to_jd(2026, 12, 21) - 1.0 / 24.0;
    let h = sun_hours(&sky, &tromso(), a, a + 1.0).unwrap();
    assert!(h.boundaries[2].always_below && h.boundaries[2].crossings.is_empty());
    let golden: Vec<_> = h
        .windows
        .iter()
        .filter(|w| w.kind == LightKind::Golden)
        .collect();
    assert_eq!(golden.len(), 1);
    assert_eq!(golden[0].period, LightPeriod::Midday);
    // At midsummer the Sun stays above -4: no blue hour, golden hour around midnight.
    let a = civil_to_jd(2026, 6, 21) - 2.0 / 24.0;
    let h = sun_hours(&sky, &tromso(), a, a + 1.0).unwrap();
    assert!(h.boundaries[0].always_above && h.boundaries[1].always_above);
    assert!(h.windows.iter().all(|w| w.kind == LightKind::Golden));
    assert!(h.windows.iter().any(|w| w.period == LightPeriod::Midnight));
    // Near the pole at the equinox the Sun circles close to the horizon all day.
    let a = civil_to_jd(2026, 3, 19);
    let h = sun_hours(&sky, &Site::new(89.9, 0.0), a, a + 1.0).unwrap();
    assert_eq!(h.windows.len(), 1, "{:?}", h.windows);
    assert_eq!(h.windows[0].period, LightPeriod::AllDay);
    assert!(h.windows[0].open_start && h.windows[0].open_end);
}

#[test]
fn geometric_thresholds_go_through_find_altitude() {
    let sky = Sky::new();
    let site = philadelphia();
    let a = civil_to_jd(2026, 9, 24) + 4.0 / 24.0;
    for h in THRESHOLDS_DEG {
        let g = find_geometric_altitude(&sky, &site, SUN, a, a + 1.0, h).unwrap();
        let f = find_altitude(
            &sky,
            &site,
            SUN,
            a,
            a + 1.0,
            apparent_equivalent_deg(h, &site),
        )
        .unwrap();
        assert_eq!(g, f);
        for c in &g {
            let st = sky_state(&sky, &site, c.jd_utc, &[SUN]).unwrap();
            assert!((st.bodies[0].alt_deg - h).abs() < 1e-5, "{c:?}");
            assert!((st.bodies[0].az_deg - c.az_deg).abs() < 1e-5, "{c:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// Azimuth search
// ---------------------------------------------------------------------------

#[test]
fn a_bearing_of_180_is_the_meridian_passage() {
    let sky = Sky::new();
    let site = philadelphia();
    for (body, date) in [
        (SUN, (2026, 9, 24)),
        (MOON, (2026, 9, 28)),
        ("Jupiter", (2026, 12, 1)),
    ] {
        let a = civil_to_jd(date.0, date.1, date.2);
        let de = day_events(&sky, &site, a, a + 1.0, &[body], &EventOptions::default()).unwrap();
        let transits: Vec<f64> = de.bodies[0]
            .events
            .iter()
            .filter(|e| e.kind == EventKind::Transit)
            .map(|e| e.jd_utc)
            .collect();
        let any = AltitudeBand {
            min_deg: Some(-90.0),
            max_deg: None,
        };
        let south = find_azimuth(&sky, &site, body, a, a + 1.0, 180.0, &any).unwrap();
        assert_eq!(south.len(), transits.len(), "{body}: {south:?}");
        for (s, t) in south.iter().zip(&transits) {
            assert!(
                (s.jd_utc - t).abs() < 0.005 * SEC,
                "{body}: {} s",
                (s.jd_utc - t) / SEC
            );
            assert!(s.clockwise, "{s:?}");
        }
    }
}

#[test]
fn every_crossing_is_on_its_bearing_as_sky_state_sees_it() {
    let sky = Sky::new();
    let site = Site::new(-33.87, 151.21);
    let a = civil_to_jd(2026, 7, 1);
    let any = AltitudeBand {
        min_deg: Some(-90.0),
        max_deg: None,
    };
    let mut n = 0;
    for body in [SUN, MOON, "Venus", "Sirius", "Canopus"] {
        for bearing in [0.0, 45.0, 135.0, 200.0, 270.0, 359.5, 360.0, -90.0] {
            for c in find_azimuth(&sky, &site, body, a, a + 3.0, bearing, &any).unwrap() {
                let st = sky_state(&sky, &site, c.jd_utc, &[body]).unwrap();
                let b = &st.bodies[0];
                assert!(
                    norm_180(b.az_deg - bearing).abs() < 1e-4,
                    "{body} {bearing}: {c:?}"
                );
                assert!((b.alt_deg - c.alt_deg).abs() < 1e-6, "{c:?}");
                assert!((b.alt_apparent_deg - c.alt_apparent_deg).abs() < 1e-6);
                n += 1;
            }
        }
    }
    assert!(n > 40, "{n} crossings");
}

#[test]
fn the_default_band_keeps_only_crossings_above_the_horizon() {
    let sky = Sky::new();
    let site = philadelphia();
    let a = civil_to_jd(2026, 9, 24);
    let all = AltitudeBand {
        min_deg: Some(-90.0),
        max_deg: None,
    };
    // Due north is the Sun's lower transit, below the horizon.
    assert_eq!(
        find_azimuth(&sky, &site, SUN, a, a + 1.0, 0.0, &all)
            .unwrap()
            .len(),
        1
    );
    assert!(
        find_azimuth(&sky, &site, SUN, a, a + 1.0, 0.0, &AltitudeBand::default())
            .unwrap()
            .is_empty()
    );
    let band = AltitudeBand {
        min_deg: Some(20.0),
        max_deg: Some(30.0),
    };
    for c in find_azimuth(&sky, &site, SUN, a, a + 2.0, 240.0, &band).unwrap() {
        assert!((20.0..=30.0).contains(&c.alt_apparent_deg), "{c:?}");
    }
    // Malformed requests.
    assert!(find_azimuth(&sky, &site, SUN, a, a - 1.0, 90.0, &all).is_err());
    assert!(find_azimuth(&sky, &site, SUN, a, a + 401.0, 90.0, &all).is_err());
    assert!(find_azimuth(&sky, &site, SUN, a, a + 1.0, f64::NAN, &all).is_err());
    assert!(find_azimuth(&sky, &site, "Vulcan", a, a + 1.0, 90.0, &all).is_err());
    let e = find_azimuth(
        &sky,
        &site,
        SUN,
        civil_to_jd(2651, 1, 1),
        civil_to_jd(2651, 1, 2),
        90.0,
        &all,
    )
    .unwrap_err();
    assert!(matches!(e, AlmanacError::Unavailable { .. }), "{e:?}");
}

// ---------------------------------------------------------------------------
// Alignments: Manhattanhenge
// ---------------------------------------------------------------------------

fn manhattan() -> Site {
    Site::new(40.7580, -73.9855)
}

fn manhattanhenge(event: AlignmentEvent) -> skyfix_almanac::sun_tools::alignment::AlignmentResult {
    alignment_days(
        &Sky::new(),
        &manhattan(),
        &AlignmentRequest {
            body: "Sun".into(),
            year: 2026,
            azimuth_deg: 299.0,
            tolerance_deg: 0.3,
            event,
            utc_offset_hours: Some(-4.0),
            options: None,
        },
    )
    .unwrap()
}

fn best_dates(r: &skyfix_almanac::sun_tools::alignment::AlignmentResult) -> Vec<String> {
    r.matches
        .iter()
        .filter(|m| m.best)
        .map(|m| m.date.clone())
        .collect()
}

#[test]
fn manhattanhenge_as_the_engine_sees_it() {
    // The engine's sunset (upper limb on a sea-level horizon, standard refraction).
    let set = manhattanhenge(AlignmentEvent::Set);
    assert_eq!(set.events_considered, 365);
    assert_eq!(best_dates(&set), ["2026-05-24", "2026-07-18"]);
    // With the Sun's geometric altitude (refraction left out), the "half sun" (centre on
    // the horizon) and "full sun" (lower limb on it) fall on the American Museum of
    // Natural History's published May dates for 2026: 28 May half, 29 May full. Their
    // July dates (11 full, 12 half) are two days earlier than these.
    let half = manhattanhenge(AlignmentEvent::AtAltitude {
        altitude_deg: apparent_equivalent_deg(0.0, &manhattan()),
    });
    assert_eq!(best_dates(&half), ["2026-05-28", "2026-07-14"]);
    let full = manhattanhenge(AlignmentEvent::AtAltitude {
        altitude_deg: apparent_equivalent_deg(0.2630, &manhattan()),
    });
    assert_eq!(best_dates(&full), ["2026-05-29", "2026-07-13"]);
    // Only setting moments can be aligned with a north-west bearing.
    assert!(half.matches.iter().all(|m| m.kind == AlignedKind::Setting));
    // The same azimuth at the same altitude is the same declination: the May and July
    // dates are the solar declination's twins (within its change over a day).
    let sky = Sky::new();
    let dec = |jd: f64| sky_state(&sky, &manhattan(), jd, &[SUN]).unwrap().bodies[0].dec_deg;
    let best: Vec<_> = half.matches.iter().filter(|m| m.best).collect();
    assert!((dec(best[0].jd_utc) - dec(best[1].jd_utc)).abs() < 0.15);
    for m in set.matches.iter().chain(&half.matches) {
        assert!(m.offset_deg.abs() <= 0.3);
        assert!((norm_180(m.az_deg - 299.0) - m.offset_deg).abs() < 1e-12);
    }
}

#[test]
fn a_bearing_the_body_never_reaches_says_by_how_much() {
    let sky = Sky::new();
    let r = alignment_days(
        &sky,
        &manhattan(),
        &AlignmentRequest {
            body: "Sun".into(),
            year: 2026,
            azimuth_deg: 200.0,
            tolerance_deg: 1.0,
            event: AlignmentEvent::Set,
            utc_offset_hours: None,
            options: None,
        },
    )
    .unwrap();
    assert!(r.matches.is_empty());
    let c = r.closest.unwrap();
    // The southernmost sunset at 40.8 N is near 238 degrees, in December.
    assert!(c.offset_deg > 30.0 && c.offset_deg < 45.0, "{c:?}");
    assert!(c.date.starts_with("2026-12"), "{c:?}");
    assert!((r.utc_offset_hours - manhattan().lon_deg / 15.0).abs() < 1e-12);
    // The Moon rises over a bearing too; each match is a moonrise within tolerance.
    let moon = alignment_days(
        &sky,
        &manhattan(),
        &AlignmentRequest {
            body: "moon".into(),
            year: 2026,
            azimuth_deg: 90.0,
            tolerance_deg: 2.0,
            event: AlignmentEvent::Rise,
            utc_offset_hours: Some(-5.0),
            options: None,
        },
    )
    .unwrap();
    assert_eq!(moon.body, "Moon");
    assert!(!moon.matches.is_empty());
    for m in &moon.matches {
        assert_eq!(m.kind, AlignedKind::Rise);
        let st = sky_state(&sky, &manhattan(), m.jd_utc, &[MOON]).unwrap();
        assert!((st.bodies[0].az_deg - m.az_deg).abs() < 1e-5);
    }
    // Malformed requests.
    for bad in [
        r#"{"year": 2026, "azimuth_deg": 90, "tolerance_deg": 0, "event": {"kind": "set"}}"#,
        r#"{"year": 2026, "azimuth_deg": 90, "event": {"kind": "set"}, "utc_offset_hours": 20}"#,
        r#"{"year": 2651, "azimuth_deg": 90, "event": {"kind": "set"}}"#,
    ] {
        let req: AlignmentRequest = serde_json::from_str(bad).unwrap();
        assert!(alignment_days(&sky, &manhattan(), &req).is_err(), "{bad}");
    }
    // A year outside the coverage is refused about the body asked for.
    let late: AlignmentRequest = serde_json::from_str(
        r#"{"body": "Moon", "year": 2651, "azimuth_deg": 90, "event": {"kind": "rise"}}"#,
    )
    .unwrap();
    match alignment_days(&sky, &manhattan(), &late) {
        Err(AlmanacError::Unavailable { body, message }) => {
            assert_eq!(body, "Moon");
            assert!(message.contains("outside the coverage"), "{message}");
        }
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Analemma, sun path, azimuths through the year, equation of time
// ---------------------------------------------------------------------------

#[test]
fn the_analemma_is_sky_state_at_the_same_clock_time_every_day() {
    let sky = Sky::new();
    let site = philadelphia();
    for (clock, offset, time_h) in [
        (ClockKind::Lmt, None, 12.0),
        (ClockKind::Zone, Some(-5.0), 9.5),
    ] {
        let a = analemma(
            &sky,
            &site,
            &AnalemmaRequest {
                year: 2024,
                time_h,
                clock,
                utc_offset_hours: offset,
            },
        )
        .unwrap();
        assert_eq!(a.points.len(), 366);
        let off = offset.unwrap_or(site.lon_deg / 15.0);
        let (mut dmin, mut dmax, mut emin, mut emax) = (90.0f64, -90.0f64, 1e9f64, -1e9f64);
        for (k, p) in a.points.iter().enumerate() {
            let expect = civil_to_jd(2024, 1, 1) + k as f64 + (time_h - off) / 24.0;
            assert!((p.jd_utc - expect).abs() < 1e-9);
            let b = &sky_state(&sky, &site, p.jd_utc, &[SUN]).unwrap().bodies[0];
            assert_eq!(
                (b.alt_deg, b.az_deg, b.dec_deg),
                (p.alt_deg, p.az_deg, p.dec_deg)
            );
            dmin = dmin.min(p.dec_deg);
            dmax = dmax.max(p.dec_deg);
            emin = emin.min(p.eot_s);
            emax = emax.max(p.eot_s);
        }
        assert!(
            (dmin + 23.44).abs() < 0.02 && (dmax - 23.44).abs() < 0.02,
            "{dmin} {dmax}"
        );
        assert!((emin / 60.0 + 14.2).abs() < 0.3 && (emax / 60.0 - 16.4).abs() < 0.3);
    }
}

#[test]
fn sun_paths_are_sampled_positions_with_the_seasonal_envelope() {
    let sky = Sky::new();
    let site = philadelphia();
    let a = civil_to_jd(2026, 9, 24) + 4.0 / 24.0;
    let p = sun_path(&sky, &site, a, a + 1.0, 10.0).unwrap();
    assert_eq!(p.path.points.len(), 145);
    for q in p.path.points.iter().step_by(7) {
        let b = &sky_state(&sky, &site, q.jd_utc, &[SUN]).unwrap().bodies[0];
        assert!((b.alt_deg - q.alt_deg).abs() < 1e-5 && norm_180(b.az_deg - q.az_deg).abs() < 1e-5);
    }
    let kinds: Vec<PathDay> = p.envelope.iter().map(|d| d.day).collect();
    assert_eq!(
        kinds,
        [
            PathDay::MarchEquinox,
            PathDay::JuneSolstice,
            PathDay::SeptemberEquinox,
            PathDay::DecemberSolstice
        ]
    );
    for d in &p.envelope {
        let s = d.season_jd_utc.unwrap();
        assert!(d.jd_start <= s && s < d.jd_end, "{:?}", d.day);
        assert!(
            ((d.jd_start - a).rem_euclid(1.0)).min(1.0 - (d.jd_start - a).rem_euclid(1.0)) < 1e-9
        );
    }
    let june_top = p.envelope[1]
        .points
        .iter()
        .map(|q| q.alt_deg)
        .fold(-90.0, f64::max);
    assert!(
        (june_top - (90.0 - site.lat_deg + 23.44)).abs() < 0.1,
        "{june_top}"
    );
    assert!(sun_path(&sky, &site, a, a + 3.0, 10.0).is_err());
    assert!(sun_path(&sky, &site, a, a + 1.0, 0.5).is_err());
}

#[test]
fn rise_and_set_azimuths_through_the_year_are_the_days_events() {
    let sky = Sky::new();
    let site = philadelphia();
    let r = rise_set_azimuths(
        &sky,
        &site,
        &RiseSetRequest {
            body: "Sun".into(),
            year: 2026,
            utc_offset_hours: Some(-5.0),
            options: None,
        },
    )
    .unwrap();
    assert_eq!(r.days.len(), 365);
    assert!(!r.truncated);
    for d in r.days.iter().step_by(17) {
        let de = day_events(
            &sky,
            &site,
            d.jd_start,
            d.jd_end,
            &[SUN],
            &EventOptions::default(),
        )
        .unwrap();
        let ev = &de.bodies[0].events;
        for (kind, mine) in [(EventKind::Rise, &d.rises), (EventKind::Set, &d.sets)] {
            let theirs: Vec<_> = ev.iter().filter(|e| e.kind == kind).collect();
            assert_eq!(theirs.len(), mine.len(), "{}", d.date);
            for (t, m) in theirs.iter().zip(mine) {
                assert!((t.jd_utc - m.jd_utc).abs() < 0.01 * SEC);
                assert!((t.az_deg - m.az_deg).abs() < 1e-5);
            }
        }
        assert!(d.transit.is_some());
    }
    let north = r.days.iter().map(|d| d.sets[0].az_deg).fold(0.0, f64::max);
    let south = r
        .days
        .iter()
        .map(|d| d.sets[0].az_deg)
        .fold(360.0, f64::min);
    assert!(
        north > 301.0 && north < 303.0 && south > 237.0 && south < 240.0,
        "{south} {north}"
    );
    // Polar day and night at Tromso.
    let t = rise_set_azimuths(
        &sky,
        &tromso(),
        &RiseSetRequest {
            body: "Sun".into(),
            year: 2026,
            utc_offset_hours: Some(1.0),
            options: None,
        },
    )
    .unwrap();
    let get = |date: &str| t.days.iter().find(|d| d.date == date).unwrap();
    assert!(get("2026-06-21").always_above && get("2026-06-21").sets.is_empty());
    assert!(get("2026-12-21").always_below && get("2026-12-21").rises.is_empty());
    assert!(!get("2026-03-21").always_above && !get("2026-03-21").always_below);
    // The last local year of the coverage is clipped, not refused (deeptime agent: the
    // validated tier ends 2650-01-22T00:00Z, so at UTC-5 the local days 1 to 20 January
    // are whole).
    let edge = rise_set_azimuths(
        &sky,
        &site,
        &RiseSetRequest {
            body: "Sun".into(),
            year: 2650,
            utc_offset_hours: Some(-5.0),
            options: None,
        },
    )
    .unwrap();
    assert!(
        edge.truncated && edge.days.len() == 20,
        "{}",
        edge.days.len()
    );
}

#[test]
fn the_equation_of_time_series_is_the_almanac_pages_value() {
    let sky = Sky::new();
    let e = equation_of_time(&sky, 2026, 12.0).unwrap();
    assert_eq!(e.points.len(), 365);
    for date in [
        "2026-02-11",
        "2026-05-14",
        "2026-07-26",
        "2026-11-03",
        "2026-12-25",
    ] {
        let page = almanac_day(&sky, date).unwrap();
        let p = e.points.iter().find(|p| p.date == date).unwrap();
        assert!((p.eot_s - page.sun.eot_12h_s).abs() < 1e-6, "{date}");
    }
    let kinds: Vec<(ExtremeKind, &str)> = e
        .extremes
        .iter()
        .map(|x| (x.kind, x.date.as_str()))
        .collect();
    assert_eq!(kinds.len(), 4, "{kinds:?}");
    let expect = [
        (ExtremeKind::Minimum, "2026-02-1"),
        (ExtremeKind::Maximum, "2026-05-1"),
        (ExtremeKind::Minimum, "2026-07-2"),
        (ExtremeKind::Maximum, "2026-11-0"),
    ];
    for ((k, d), (ek, prefix)) in kinds.iter().zip(expect) {
        assert_eq!(*k, ek);
        assert!(d.starts_with(prefix), "{d} vs {prefix}");
    }
    assert!(equation_of_time(&sky, 2026, 24.0).is_err());
    // Past the validated tier (2650-01-22, deeptime agent).
    assert!(equation_of_time(&sky, 2651, 12.0).is_err());
    let edge = equation_of_time(&sky, 2060, 23.99).unwrap();
    assert_eq!(edge.points.len(), 366);
}

// ---------------------------------------------------------------------------
// Solar energy
// ---------------------------------------------------------------------------

#[test]
fn a_flat_panel_collects_the_global_irradiance() {
    let sky = Sky::new();
    let site = philadelphia();
    let a = civil_to_jd(2026, 6, 21) + 5.0 / 24.0;
    let flat = Panel::default();
    let d = solar_day(&sky, &site, a, a + 1.0, &flat, 10.0).unwrap();
    for s in &d.samples {
        assert!((s.poa_w_m2 - s.ghi_w_m2).abs() < 1e-9, "{s:?}");
        if s.sun_alt_apparent_deg <= 0.0 {
            assert_eq!(s.poa_w_m2, 0.0);
            assert!(s.incidence_deg.is_none());
        }
        let b = &sky_state(&sky, &site, s.jd_utc, &[SUN]).unwrap().bodies[0];
        assert!((b.alt_apparent_deg - s.sun_alt_apparent_deg).abs() < 1e-5);
    }
    assert!((d.poa_kwh_m2 - d.ghi_kwh_m2).abs() < 1e-12);
    // A clear midsummer day at 40 N: 8-9 kWh/m2 on the ground (textbook clear-sky values).
    assert!(d.ghi_kwh_m2 > 7.5 && d.ghi_kwh_m2 < 9.0, "{}", d.ghi_kwh_m2);
    // A finer step changes the day's energy by well under a percent.
    let fine = solar_day(&sky, &site, a, a + 1.0, &flat, 1.0).unwrap();
    assert!((fine.ghi_kwh_m2 / d.ghi_kwh_m2 - 1.0).abs() < 0.002);
    assert!(solar_day(&sky, &site, a, a + 1.0, &flat, 0.5).is_err());
    assert!(solar_day(&sky, &site, a, a + 3.0, &flat, 10.0).is_err());
}

#[test]
fn a_year_of_clear_sky_energy_and_the_best_tilt() {
    let sky = Sky::new();
    let site = philadelphia();
    let req = |tilt: f64, optimise: bool| SolarYearRequest {
        year: 2026,
        panel: Panel {
            tilt_deg: tilt,
            ..Panel::default()
        },
        utc_offset_hours: Some(-5.0),
        step_minutes: None,
        optimise_tilt: optimise,
    };
    let y = solar_year(&sky, &site, &req(30.0, true)).unwrap();
    assert_eq!(y.days.len(), 365);
    assert_eq!(y.months.len(), 12);
    let sum: f64 = y.months.iter().map(|m| m.poa_kwh_m2).sum();
    assert!((sum - y.poa_kwh_m2).abs() < 1e-9);
    assert_eq!(y.months.iter().map(|m| m.days).sum::<u32>(), 365);
    let opt = y.optimal.unwrap();
    eprintln!(
        "Philadelphia 2026, clear sky: flat {:.0} kWh/m2, 30 deg south {:.0}, best tilt \
         {:.1} deg {:.0}",
        y.ghi_kwh_m2, y.poa_kwh_m2, opt.tilt_deg, opt.poa_kwh_m2
    );
    assert!(opt.tilt_deg > 25.0 && opt.tilt_deg < 45.0, "{opt:?}");
    for t in [opt.tilt_deg - 5.0, opt.tilt_deg + 5.0] {
        let other = solar_year(&sky, &site, &req(t, false)).unwrap();
        assert!(other.poa_kwh_m2 < opt.poa_kwh_m2, "{t}");
    }
    let flat = solar_year(&sky, &site, &req(0.0, false)).unwrap();
    assert!((flat.poa_kwh_m2 - flat.ghi_kwh_m2).abs() < 1e-6);
    // One day of the year agrees with the day integration of the same local day.
    let d = &y.days[171];
    let day = solar_day(
        &sky,
        &site,
        d.jd_start,
        d.jd_start + 1.0,
        &Panel {
            tilt_deg: 30.0,
            ..Panel::default()
        },
        2.0,
    )
    .unwrap();
    assert!(
        (day.poa_kwh_m2 / d.poa_kwh_m2 - 1.0).abs() < 0.003,
        "{} {}",
        day.poa_kwh_m2,
        d.poa_kwh_m2
    );
    // South of the equator a panel faces north by default.
    let cape = solar_year(&sky, &Site::new(-33.9, 18.4), &req(30.0, false)).unwrap();
    assert_eq!(cape.panel.azimuth_deg, 0.0);
    assert!(cape.poa_kwh_m2 > cape.ghi_kwh_m2);
    assert!(y.model.label == "clear-sky estimate");
}

// ---------------------------------------------------------------------------
// The Milky Way planner
// ---------------------------------------------------------------------------

#[test]
fn galactic_windows_hold_their_conditions_and_are_maximal() {
    let sky = Sky::new();
    let site = Site {
        height_m: 1165.0,
        ..Site::new(-31.2733, 149.0617)
    };
    let a = civil_to_jd(2026, 6, 10) + 2.0 / 24.0;
    let b = a + 12.0;
    let g = galactic_centre_windows(&sky, &site, a, b, &GalacticOptions::default()).unwrap();
    assert!(g.windows.len() >= 12, "{}", g.windows.len());
    let gc_alt = |t: f64| horizontal(&CENTRE.state(t), &site).alt_apparent_deg;
    let moon = |t: f64| {
        let st = sky_state(&sky, &site, t, &[MOON]).unwrap();
        let m = &st.bodies[0];
        let h0 =
            skyfix_almanac::events::standard_altitude_deg(BodyKind::Moon, m.semidiameter_arcmin);
        m.alt_deg >= h0
    };
    for w in &g.windows {
        let mut t = w.jd_start + 5.0 * SEC;
        while t < w.jd_end - 5.0 * SEC {
            assert!(gc_alt(t) >= 10.0 - 1e-6, "{w:?}");
            assert!(sun_alt(&sky, &site, t) <= -18.0 + 1e-6);
            assert_eq!(moon(t), w.moon_up, "{w:?} at {t}");
            t += 300.0 * SEC;
        }
        // Just outside, something changes: a condition fails or the Moon rises or sets.
        for (edge, outside) in [
            (w.jd_start, w.jd_start - 10.0 * SEC),
            (w.jd_end, w.jd_end + 10.0 * SEC),
        ] {
            if edge <= a || edge >= b {
                continue;
            }
            let changed = gc_alt(outside) < 10.0
                || sun_alt(&sky, &site, outside) > -18.0
                || moon(outside) != w.moon_up;
            assert!(changed, "{w:?} is not maximal at {edge}");
        }
        // The best moment is the highest in the window.
        let mut t = w.jd_start;
        while t <= w.jd_end {
            assert!(gc_alt(t) <= w.best.alt_apparent_deg + 1e-6, "{w:?}");
            t += 120.0 * SEC;
        }
        assert!(w.best.jd_utc >= w.jd_start && w.best.jd_utc <= w.jd_end);
        assert!((w.duration_h - (w.jd_end - w.jd_start) * 24.0).abs() < 1e-9);
        if w.moon_up {
            assert!(w.moon_illuminated_fraction > 0.0);
        }
    }
    // Far in the north the galactic centre never climbs 10 degrees.
    let none =
        galactic_centre_windows(&sky, &tromso(), a, a + 5.0, &GalacticOptions::default()).unwrap();
    assert!(none.windows.is_empty());
    let bad = GalacticOptions {
        min_altitude_deg: Some(95.0),
        sun_max_altitude_deg: None,
    };
    assert!(galactic_centre_windows(&sky, &site, a, a + 1.0, &bad).is_err());
}
