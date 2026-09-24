//! The event finder against an independent brute force, and the cases that break
//! naive finders: polar day and night, a Sun that grazes its rise/set altitude for a
//! minute, a body that rises twice in one window, the dip option, the sky-phase
//! cover, and bodies the provider cannot answer for.
//!
//! "Brute force" is `common::dense_exact`: the provider evaluated **exactly** every few
//! seconds, crossings located by linear interpolation. It shares nothing with the
//! finder except the provider and `topocentric::horizontal`: no track, no extremum
//! insertion, no Brent. The Moon here is the synthetic one of `common` (the real Moon
//! provider is a stub in this branch); the Sun and stars are the real providers.

mod common;

use common::{Exact, Refusing, SyntheticSky, brute_crossings, brute_transits, dense_exact};
use skyfix_almanac::events::{
    BodyEvents, DayEvents, EventKind, EventOptions, Horizon, day_events, find_altitude,
    standard_altitude_deg,
};
use skyfix_almanac::sky::{AlmanacError, SkyPhase, sky_phase, sky_state};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_ephemeris::body::{BodyEphemeris, BodyKind, Sky};
use skyfix_ephemeris::topocentric::Site;

const SEC: f64 = 1.0 / 86_400.0;

fn std_opts() -> EventOptions {
    EventOptions::default()
}

fn events_of<'a>(d: &'a DayEvents, body: &str) -> &'a BodyEvents {
    d.bodies
        .iter()
        .find(|b| b.body == body)
        .unwrap_or_else(|| panic!("{body} missing: errors {:?}", d.errors))
}

/// `(jd, rising)` of the events of two kinds (the upward and the downward one).
fn pairs(b: &BodyEvents, up: EventKind, down: EventKind) -> Vec<(f64, bool)> {
    b.events
        .iter()
        .filter(|e| e.kind == up || e.kind == down)
        .map(|e| (e.jd_utc, e.kind == up))
        .collect()
}

fn times(b: &BodyEvents, kind: EventKind) -> Vec<f64> {
    b.events
        .iter()
        .filter(|e| e.kind == kind)
        .map(|e| e.jd_utc)
        .collect()
}

/// Worst time difference in seconds between matched crossings; panics on a count or
/// direction mismatch.
fn worst_s(found: &[(f64, bool)], brute: &[(f64, bool)], what: &str) -> f64 {
    assert_eq!(
        found.len(),
        brute.len(),
        "{what}: finder {:?} vs brute force {:?}",
        found
            .iter()
            .map(|x| (format_utc(x.0), x.1))
            .collect::<Vec<_>>(),
        brute
            .iter()
            .map(|x| (format_utc(x.0), x.1))
            .collect::<Vec<_>>()
    );
    let mut worst = 0.0f64;
    for (f, b) in found.iter().zip(brute) {
        assert_eq!(f.1, b.1, "{what}: direction at {}", format_utc(f.0));
        worst = worst.max((f.0 - b.0).abs() / SEC);
    }
    worst
}

/// Compare every event of `body` in the window with the brute force.
#[allow(clippy::too_many_arguments)]
fn check_against_brute_force(
    eph: &dyn BodyEphemeris,
    body: &str,
    kind: BodyKind,
    site: &Site,
    t0: f64,
    t1: f64,
    step_s: f64,
    tol_s: f64,
) -> f64 {
    let d = day_events(eph, site, t0, t1, &[body], &std_opts()).unwrap();
    let b = events_of(&d, body);
    let dense = dense_exact(eph, body, site, t0, t1, step_s);
    let what = format!(
        "{body} at {:.2},{:.2} from {}",
        site.lat_deg,
        site.lon_deg,
        format_utc(t0)
    );
    let rs = brute_crossings(&dense, |e: &Exact| {
        e.alt - standard_altitude_deg(kind, e.sd)
    });
    let mut worst = worst_s(&pairs(b, EventKind::Rise, EventKind::Set), &rs, &what);
    if kind == BodyKind::Sun {
        for (deg, up, down) in [
            (-6.0, EventKind::CivilDawn, EventKind::CivilDusk),
            (-12.0, EventKind::NauticalDawn, EventKind::NauticalDusk),
            (
                -18.0,
                EventKind::AstronomicalDawn,
                EventKind::AstronomicalDusk,
            ),
        ] {
            let bc = brute_crossings(&dense, |e: &Exact| e.alt - deg);
            worst = worst.max(worst_s(&pairs(b, up, down), &bc, &format!("{what} {deg}")));
        }
    }
    for (kind, offset) in [(EventKind::Transit, 0.0), (EventKind::LowerTransit, 180.0)] {
        let found: Vec<(f64, bool)> = times(b, kind).into_iter().map(|t| (t, true)).collect();
        let brute: Vec<(f64, bool)> = brute_transits(&dense, site.lon_deg, offset)
            .into_iter()
            .map(|t| (t, true))
            .collect();
        worst = worst.max(worst_s(&found, &brute, &format!("{what} {kind:?}")));
    }
    assert!(worst < tol_s, "{what}: worst {worst} s");
    // The always flags agree with the brute force too.
    assert_eq!(
        b.always_above,
        rs.is_empty() && dense[0].alt > standard_altitude_deg(kind, dense[0].sd)
    );
    worst
}

fn site(lat: f64, lon: f64) -> Site {
    Site::new(lat, lon)
}

#[test]
fn sun_events_match_a_dense_exact_scan() {
    let eph = Sky::new();
    let cases = [
        (site(39.9526, -75.1652), civil_to_jd(2026, 9, 24)),
        (
            site(-33.8688, 151.2093),
            civil_to_jd(2026, 6, 21) - 151.2 / 360.0,
        ),
        (site(69.6496, 18.956), civil_to_jd(2026, 12, 21) - 0.05),
        (site(69.6496, 18.956), civil_to_jd(2026, 5, 10) - 0.05),
        (site(-0.1807, -78.4678), civil_to_jd(2030, 3, 20) + 0.2),
        (site(78.2232, 15.6267), civil_to_jd(1996, 3, 1)),
        (site(-66.2821, 110.5285), civil_to_jd(2041, 12, 1) - 0.3),
        (site(60.1699, 24.9384), civil_to_jd(2055, 6, 21) - 0.07),
    ];
    let mut worst = 0.0f64;
    for (s, t0) in cases {
        worst = worst.max(check_against_brute_force(
            &eph,
            "Sun",
            BodyKind::Sun,
            &s,
            t0,
            t0 + 1.0,
            20.0,
            0.5,
        ));
    }
    eprintln!("Sun: worst difference from a 20-s exact scan {worst:.3} s");
}

#[test]
fn star_events_match_a_dense_exact_scan() {
    let eph = Sky::new();
    for (body, s, t0) in [
        ("Sirius", site(39.9526, -75.1652), civil_to_jd(2026, 9, 24)),
        ("Canopus", site(-33.8688, 151.2093), civil_to_jd(2001, 2, 2)),
        ("Capella", site(51.4769, 0.0), civil_to_jd(2019, 8, 8)),
        ("Polaris", site(-10.0, 30.0), civil_to_jd(2044, 4, 4)),
        ("Acrux", site(21.3, -157.86), civil_to_jd(2012, 5, 5)),
    ] {
        check_against_brute_force(&eph, body, BodyKind::Star, &s, t0, t0 + 1.0, 30.0, 0.5);
    }
}

#[test]
fn moon_events_match_a_dense_exact_scan() {
    let eph = SyntheticSky::new();
    let mut worst = 0.0f64;
    for (s, t0) in [
        (site(39.9526, -75.1652), civil_to_jd(2026, 9, 24)),
        (site(35.6762, 139.6503), civil_to_jd(2026, 10, 3)),
        (site(-33.8688, 151.2093), civil_to_jd(2031, 1, 17)),
        (site(64.1466, -21.9426), civil_to_jd(2025, 3, 8)),
        (site(-54.8, -68.3), civil_to_jd(2044, 7, 1)),
        (site(0.0, 179.99), civil_to_jd(1999, 12, 31)),
    ] {
        worst = worst.max(check_against_brute_force(
            &eph,
            "Moon",
            BodyKind::Moon,
            &s,
            t0,
            t0 + 1.0,
            20.0,
            0.5,
        ));
    }
    eprintln!("Moon (synthetic): worst difference from a 20-s exact scan {worst:.3} s");
}

#[test]
fn the_moon_h0_includes_its_semidiameter_and_parallax_lowers_it() {
    let eph = SyntheticSky::new();
    let s = site(39.9526, -75.1652);
    let t0 = civil_to_jd(2026, 9, 24);
    let d = day_events(&eph, &s, t0, t0 + 2.0, &["Moon"], &std_opts()).unwrap();
    let b = events_of(&d, "Moon");
    let mut n = 0;
    for e in &b.events {
        if matches!(e.kind, EventKind::Rise | EventKind::Set) {
            let st = eph.apparent_state("Moon", e.jd_utc).unwrap();
            let h0 = -(34.0 + st.semidiameter_arcmin) / 60.0;
            assert!((e.alt_deg - h0).abs() < 1e-5, "{e:?} vs h0 {h0}");
            // Geocentrically the Moon is still about HP - 49' above the horizon.
            let ss = sky_state(&eph, &s, e.jd_utc, &["Moon"]).unwrap();
            assert!(ss.bodies[0].hc_deg > 0.1, "{:?}", ss.bodies[0].hc_deg);
            n += 1;
        }
    }
    assert!(n >= 3, "{n} rise/set events in two days");
}

#[test]
fn polar_day_and_night_are_classified() {
    let eph = Sky::new();
    let svalbard = site(78.2232, 15.6267);
    // Midnight sun.
    let t0 = civil_to_jd(2026, 6, 21) - 15.6 / 360.0;
    let d = day_events(&eph, &svalbard, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    assert!(sun.always_above && !sun.always_below);
    assert_eq!(sun.day_length_h, Some(24.0));
    let kinds: Vec<EventKind> = sun.events.iter().map(|e| e.kind).collect();
    assert_eq!(kinds.len(), 2, "{kinds:?}");
    assert!(kinds.contains(&EventKind::Transit) && kinds.contains(&EventKind::LowerTransit));
    assert_eq!(d.phases.len(), 1);
    assert_eq!(d.phases[0].phase, SkyPhase::Day);

    // Polar night at 78 N: noon is -11.7 deg, nautical twilight at best.
    let t0 = civil_to_jd(2026, 12, 21) - 15.6 / 360.0;
    let d = day_events(&eph, &svalbard, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    assert!(sun.always_below && !sun.always_above);
    assert_eq!(sun.day_length_h, Some(0.0));
    let kinds: Vec<EventKind> = sun.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EventKind::AstronomicalDawn,
            EventKind::NauticalDawn,
            EventKind::Transit,
            EventKind::NauticalDusk,
            EventKind::AstronomicalDusk,
            EventKind::LowerTransit
        ]
    );
    let noon = sun
        .events
        .iter()
        .find(|e| e.kind == EventKind::Transit)
        .unwrap();
    assert!((noon.alt_deg + 11.66).abs() < 0.05, "{}", noon.alt_deg);
    assert!(
        d.phases
            .iter()
            .all(|p| !matches!(p.phase, SkyPhase::Day | SkyPhase::Civil))
    );

    // Near the pole in December it is night all day.
    let t0 = civil_to_jd(2026, 12, 21);
    let d = day_events(&eph, &site(88.0, 0.0), t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    assert_eq!(sun.events.len(), 2, "{:?}", sun.events);
    assert_eq!(d.phases.len(), 1);
    assert_eq!(d.phases[0].phase, SkyPhase::Night);

    // Polar night at 69.6 N still has a civil-twilight noon: no rise, but civil dawn
    // and dusk, and the phases run night -> ... -> civil -> ... -> night.
    let tromso = site(69.6496, 18.956);
    let t0 = civil_to_jd(2026, 12, 21) - 19.0 / 360.0;
    let d = day_events(&eph, &tromso, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    assert!(sun.always_below);
    let kinds: Vec<EventKind> = sun.events.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&EventKind::CivilDawn) && kinds.contains(&EventKind::CivilDusk));
    assert!(!kinds.contains(&EventKind::Rise) && !kinds.contains(&EventKind::Set));
    assert!(d.phases.iter().any(|p| p.phase == SkyPhase::Civil));
    assert!(!d.phases.iter().any(|p| p.phase == SkyPhase::Day));

    // Southern midnight sun (Casey Station, 66.3 S, December solstice).
    let casey = site(-66.2821, 110.5285);
    let t0 = civil_to_jd(2026, 12, 21) - 110.5 / 360.0;
    let d = day_events(&eph, &casey, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    assert!(events_of(&d, "Sun").always_above);

    // White nights: 60 N in June has no astronomical twilight at all.
    let helsinki = site(60.1699, 24.9384);
    let t0 = civil_to_jd(2026, 6, 21) - 25.0 / 360.0;
    let d = day_events(&eph, &helsinki, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    assert!(sun.events.iter().all(|e| !matches!(
        e.kind,
        EventKind::AstronomicalDawn
            | EventKind::AstronomicalDusk
            | EventKind::NauticalDawn
            | EventKind::NauticalDusk
    )));
    assert!(d.phases.iter().all(|p| p.phase != SkyPhase::Night));
}

/// Alt of the Sun's lower culmination near 2026-06-21T00:00Z at longitude 0.
fn lower_culmination_alt(eph: &Sky, lat: f64) -> (f64, f64) {
    let t0 = civil_to_jd(2026, 6, 20) + 0.5;
    let d = day_events(eph, &site(lat, 0.0), t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let lt = events_of(&d, "Sun")
        .events
        .iter()
        .find(|e| e.kind == EventKind::LowerTransit)
        .unwrap()
        .clone();
    (lt.alt_deg, lt.jd_utc)
}

#[test]
fn a_sun_that_grazes_its_rise_set_altitude_is_caught_on_both_sides() {
    let eph = Sky::new();
    let h0 = -50.0 / 60.0;
    for (below_deg, max_minutes) in [(0.005, 12.0), (0.0003, 3.0)] {
        // Solve for the latitude whose lower culmination is `below_deg` under h0.
        let mut lat = 90.0 - 23.44 + h0 - below_deg;
        for _ in 0..4 {
            let (alt, _) = lower_culmination_alt(&eph, lat);
            lat += (h0 - below_deg) - alt;
        }
        let (alt, t_lt) = lower_culmination_alt(&eph, lat);
        assert!(
            (alt - (h0 - below_deg)).abs() < below_deg / 20.0,
            "latitude solve: {alt}"
        );
        let s = site(lat, 0.0);
        let t0 = civil_to_jd(2026, 6, 20) + 0.5;
        let d = day_events(&eph, &s, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
        let sun = events_of(&d, "Sun");
        let rs = pairs(sun, EventKind::Rise, EventKind::Set);
        assert_eq!(rs.len(), 2, "dip of {below_deg} deg: {:?}", sun.events);
        assert!(!rs[0].1 && rs[1].1, "set, then rise");
        let gap_min = (rs[1].0 - rs[0].0) / SEC / 60.0;
        assert!(gap_min < max_minutes, "{gap_min} min");
        assert!(rs[0].0 < t_lt && t_lt < rs[1].0);
        // A 1-second exact scan around the lower transit sees the same two crossings.
        let dense = dense_exact(&eph, "Sun", &s, t_lt - 900.0 * SEC, t_lt + 900.0 * SEC, 1.0);
        let brute = brute_crossings(&dense, |e: &Exact| e.alt - h0);
        let w = worst_s(&rs, &brute, "grazing Sun");
        assert!(w < 1.5, "{w} s");
        eprintln!(
            "grazing Sun {below_deg} deg below h0 at lat {lat:.5}: below for {gap_min:.2} \
             min, worst {w:.2} s from a 1-s scan"
        );
    }
    // And just above h0 it is midnight sun: no events, always above.
    let mut lat = 90.0 - 23.44 + h0 + 0.002;
    for _ in 0..4 {
        let (alt, _) = lower_culmination_alt(&eph, lat);
        lat += (h0 + 0.002) - alt;
    }
    let t0 = civil_to_jd(2026, 6, 20) + 0.5;
    let d = day_events(&eph, &site(lat, 0.0), t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    assert!(events_of(&d, "Sun").always_above);
}

#[test]
fn a_star_rises_twice_in_a_24_hour_window() {
    let eph = Sky::new();
    let s = site(39.9526, -75.1652);
    let t0 = civil_to_jd(2026, 9, 24);
    let d = day_events(&eph, &s, t0, t0 + 1.0, &["Sirius"], &std_opts()).unwrap();
    let rise = times(events_of(&d, "Sirius"), EventKind::Rise)[0];
    let w0 = rise - 60.0 * SEC;
    let d = day_events(&eph, &s, w0, w0 + 1.0, &["Sirius"], &std_opts()).unwrap();
    let rises = times(events_of(&d, "Sirius"), EventKind::Rise);
    assert_eq!(rises.len(), 2, "{:?}", events_of(&d, "Sirius").events);
    let sidereal_day_s = (rises[1] - rises[0]) / SEC;
    assert!(
        (sidereal_day_s - 86_164.09).abs() < 2.0,
        "{sidereal_day_s} s between rises"
    );
    // Sorted, and the window edge created nothing.
    let ev = &events_of(&d, "Sirius").events;
    assert!(ev.windows(2).all(|w| w[0].jd_utc <= w[1].jd_utc));
    assert!(ev.iter().all(|e| e.jd_utc > w0 + 30.0 * SEC));
}

#[test]
fn the_moon_rises_twice_in_a_day_at_high_latitude_and_is_sometimes_circumpolar() {
    let eph = SyntheticSky::new();
    let s = site(69.6496, 18.956);
    // One 60-day window (the API allows up to 400): find two consecutive moonrises
    // less than 24 hours apart, which happens at high latitude while the Moon's
    // declination climbs fast.
    let start = civil_to_jd(2026, 1, 1);
    let d = day_events(&eph, &s, start, start + 60.0, &["Moon"], &std_opts()).unwrap();
    let rises = times(events_of(&d, "Moon"), EventKind::Rise);
    let pair = rises
        .windows(2)
        .find(|w| w[1] - w[0] < 1.0 - 120.0 * SEC)
        .expect("two moonrises within 24 h at 69.6 N in early 2026");
    let t0 = pair[0] - 60.0 * SEC;
    let d = day_events(&eph, &s, t0, t0 + 1.0, &["Moon"], &std_opts()).unwrap();
    assert_eq!(times(events_of(&d, "Moon"), EventKind::Rise).len(), 2);
    eprintln!(
        "two moonrises within 24 h: {} and {}",
        format_utc(pair[0]),
        format_utc(pair[1])
    );
    check_against_brute_force(&eph, "Moon", BodyKind::Moon, &s, t0, t0 + 1.0, 20.0, 0.5);

    // Days on which the Moon never sets, and days on which it never rises.
    let (mut above, mut below) = (0, 0);
    for day in 0..30 {
        let t = start + f64::from(day);
        let d = day_events(&eph, &s, t, t + 1.0, &["Moon"], &std_opts()).unwrap();
        let m = events_of(&d, "Moon");
        above += usize::from(m.always_above);
        below += usize::from(m.always_below);
    }
    eprintln!("January 2026 at 69.6 N: {above} days always above, {below} always below");
    assert!(above > 0 && below > 0);
}

#[test]
fn the_dip_option_moves_rise_and_set_only() {
    let eph = Sky::new();
    let s = site(39.9526, -75.1652);
    let t0 = civil_to_jd(2026, 9, 24);
    let std = day_events(&eph, &s, t0, t0 + 1.0, &["Sun", "Vega"], &std_opts()).unwrap();
    let dip_opts = EventOptions {
        horizon: Horizon::Dip,
        height_of_eye_m: 16.0,
    };
    let dip = day_events(&eph, &s, t0, t0 + 1.0, &["Sun", "Vega"], &dip_opts).unwrap();
    let dip_deg = 1.76 * 4.0 / 60.0;
    for body in ["Sun", "Vega"] {
        let (a, b) = (events_of(&std, body), events_of(&dip, body));
        let (ra, rb) = (times(a, EventKind::Rise)[0], times(b, EventKind::Rise)[0]);
        let (sa, sb) = (times(a, EventKind::Set)[0], times(b, EventKind::Set)[0]);
        let early = (ra - rb) / SEC;
        let late = (sb - sa) / SEC;
        // Expected shift: the dip divided by the altitude rate at the standard event.
        let rate = |t: f64| {
            let alt = |t: f64| sky_state(&eph, &s, t, &[body]).unwrap().bodies[0].alt_deg;
            (alt(t + 30.0 * SEC) - alt(t - 30.0 * SEC)) / 60.0
        };
        let want_early = dip_deg / rate(ra);
        let want_late = -dip_deg / rate(sa);
        assert!(
            (early - want_early).abs() < 1.0,
            "{body} rises {early} s earlier, expected {want_early}"
        );
        assert!(
            (late - want_late).abs() < 1.0,
            "{body} sets {late} s later, expected {want_late}"
        );
        let e = b.events.iter().find(|e| e.kind == EventKind::Rise).unwrap();
        let kind = if body == "Sun" {
            BodyKind::Sun
        } else {
            BodyKind::Star
        };
        assert!((e.alt_deg - (standard_altitude_deg(kind, 0.0) - dip_deg)).abs() < 1e-5);
        // Transits and twilight do not move.
        for k in [
            EventKind::Transit,
            EventKind::CivilDawn,
            EventKind::NauticalDusk,
        ] {
            assert_eq!(times(a, k), times(b, k), "{body} {k:?}");
        }
    }
    // The phases are defined without dip, so they do not move either.
    assert_eq!(std.phases, dip.phases);
    let (la, lb) = (
        events_of(&std, "Sun").day_length_h.unwrap(),
        events_of(&dip, "Sun").day_length_h.unwrap(),
    );
    assert!(lb > la + 60.0 / 3600.0, "{la} h vs {lb} h");
}

#[test]
fn phases_cover_the_window_and_their_bounds_are_the_suns_events() {
    let eph = Sky::new();
    let cases = [
        (site(39.9526, -75.1652), civil_to_jd(2026, 9, 24) + 0.2, 1.0),
        (site(69.6496, 18.956), civil_to_jd(2026, 3, 1), 1.0),
        (site(-33.9, 18.4), civil_to_jd(2013, 7, 7) + 0.9, 2.5),
        (site(78.2, 15.6), civil_to_jd(2026, 4, 25), 1.0),
        (site(0.0, 0.0), civil_to_jd(2045, 10, 10), 0.1),
    ];
    for (s, t0, len) in cases {
        let d = day_events(&eph, &s, t0, t0 + len, &["Sun"], &std_opts()).unwrap();
        assert_eq!(d.phases[0].jd_start, t0);
        assert_eq!(d.phases.last().unwrap().jd_end, t0 + len);
        for w in d.phases.windows(2) {
            assert_eq!(w[0].jd_end, w[1].jd_start, "contiguous");
            assert_ne!(w[0].phase, w[1].phase, "merged");
        }
        let sun = events_of(&d, "Sun");
        let bounds: Vec<f64> = sun
            .events
            .iter()
            .filter(|e| !matches!(e.kind, EventKind::Transit | EventKind::LowerTransit))
            .map(|e| e.jd_utc)
            .collect();
        for p in &d.phases {
            assert!(p.jd_end > p.jd_start);
            if p.jd_start != t0 {
                assert!(
                    bounds.contains(&p.jd_start),
                    "{} is not a Sun event",
                    p.jd_start
                );
            }
            let mid = 0.5 * (p.jd_start + p.jd_end);
            let alt = sky_state(&eph, &s, mid, &[]).unwrap().sun_altitude_deg;
            assert_eq!(sky_phase(alt), p.phase, "at {}", format_utc(mid));
        }
    }
}

#[test]
fn day_length_is_the_time_between_rise_and_set() {
    let eph = Sky::new();
    let s = site(39.9526, -75.1652);
    let t0 = civil_to_jd(2026, 9, 24);
    let d = day_events(&eph, &s, t0, t0 + 1.0, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    let r = times(sun, EventKind::Rise)[0];
    let st = times(sun, EventKind::Set)[0];
    let len = sun.day_length_h.unwrap();
    assert!((len - (st - r) * 24.0).abs() < 1e-6, "{len}");
    assert!((12.0..12.2).contains(&len), "{len}");
    assert!(
        d.bodies
            .iter()
            .all(|b| b.body == "Sun" || b.day_length_h.is_none())
    );
}

#[test]
fn event_altitudes_and_azimuths_match_sky_state_and_transits_are_on_the_meridian() {
    let eph = SyntheticSky::new();
    let s = site(39.9526, -75.1652);
    let t0 = civil_to_jd(2026, 9, 24);
    let d = day_events(
        &eph,
        &s,
        t0,
        t0 + 1.0,
        &["Sun", "Vega", "Sirius", "Moon"],
        &std_opts(),
    )
    .unwrap();
    let mut worst = 0.0f64;
    for b in &d.bodies {
        for e in &b.events {
            let st = sky_state(&eph, &s, e.jd_utc, &[b.body.as_str()]).unwrap();
            let bs = &st.bodies[0];
            // Reported from the interpolated track: within 0.01" of an exact state.
            let d_alt = (e.alt_deg - bs.alt_deg).abs() * 3600.0;
            let d_az = skyfix_core::units::norm_180(e.az_deg - bs.az_deg).abs()
                * 3600.0
                * bs.alt_deg.to_radians().cos();
            worst = worst.max(d_alt).max(d_az);
            assert!(
                d_alt < 0.01 && d_az < 0.01,
                "{} {e:?}: {d_alt}\" {d_az}\"",
                b.body
            );
            if e.kind == EventKind::Transit || e.kind == EventKind::LowerTransit {
                let lha = (bs.gha_deg + s.lon_deg).rem_euclid(360.0);
                let want = if e.kind == EventKind::Transit {
                    0.0
                } else {
                    180.0
                };
                let d_lha = skyfix_core::units::norm_180(lha - want).abs() * 3600.0;
                // 0.01 s of time is 0.15" of hour angle.
                assert!(d_lha < 0.2, "{} {e:?}: LHA off by {d_lha}\"", b.body);
            }
        }
        let kinds_ok = b.events.iter().all(|e| {
            b.body == "Sun"
                || matches!(
                    e.kind,
                    EventKind::Rise | EventKind::Set | EventKind::Transit | EventKind::LowerTransit
                )
        });
        assert!(kinds_ok, "{}: {:?}", b.body, b.events);
    }
    eprintln!("event alt/az vs an exact sky_state: worst {worst:.5}\"");
}

#[test]
fn find_altitude_crosses_the_requested_apparent_altitude() {
    let eph = SyntheticSky::new();
    let s = Site {
        height_m: 10.0,
        pressure_hpa: 990.0,
        temperature_c: 25.0,
        ..site(39.9526, -75.1652)
    };
    let t0 = civil_to_jd(2026, 6, 21);
    let v = find_altitude(&eph, &s, "sun", t0, t0 + 1.0, 30.0).unwrap();
    assert_eq!(v.len(), 2, "{v:?}");
    assert!(v[0].rising && !v[1].rising);
    for c in &v {
        let st = sky_state(&eph, &s, c.jd_utc, &["Sun"]).unwrap();
        let b = &st.bodies[0];
        assert!(
            (b.alt_apparent_deg - 30.0).abs() < 1e-6,
            "{}",
            b.alt_apparent_deg
        );
        assert!((c.alt_deg - b.alt_deg).abs() < 3e-6 && (c.az_deg - b.az_deg).abs() < 3e-5);
        assert!(
            c.alt_deg < 30.0,
            "alt_deg is geometric, below the apparent 30"
        );
    }
    // Philadelphia's June Sun peaks near 73.5: never at 80.
    assert!(
        find_altitude(&eph, &s, "Sun", t0, t0 + 1.0, 80.0)
            .unwrap()
            .is_empty()
    );
    // The synthetic Moon, and a negative altitude.
    let m = find_altitude(&eph, &s, "Moon", t0, t0 + 3.0, -5.0).unwrap();
    assert!(m.len() >= 4, "{m:?}");
    for c in &m {
        let st = sky_state(&eph, &s, c.jd_utc, &["Moon"]).unwrap();
        assert!((st.bodies[0].alt_apparent_deg + 5.0).abs() < 1e-5);
    }
    assert!(find_altitude(&eph, &s, "Sun", t0, t0 + 1.0, 91.0).is_err());
    assert!(find_altitude(&eph, &s, "Vulcan", t0, t0 + 1.0, 10.0).is_err());
    let refusing = Refusing::new(&["Moon"]);
    let e = find_altitude(&refusing, &s, "Moon", t0, t0 + 1.0, 10.0).unwrap_err();
    assert!(matches!(e, AlmanacError::Unavailable { .. }), "{e}");
}

#[test]
fn bodies_the_provider_cannot_answer_for_are_errors_not_guesses() {
    // A provider that refuses the Moon and Jupiter, as a stub or an out-of-coverage
    // provider would.
    let refusing = Refusing::new(&["Moon", "Jupiter"]);
    let s = site(39.9526, -75.1652);
    let t0 = civil_to_jd(2026, 9, 24);
    let d = day_events(
        &refusing,
        &s,
        t0,
        t0 + 1.0,
        &["Moon", "Sun", "Jupiter", "Vega"],
        &std_opts(),
    )
    .unwrap();
    let names: Vec<&str> = d.bodies.iter().map(|b| b.body.as_str()).collect();
    assert_eq!(
        names,
        vec!["Sun", "Vega"],
        "request order, failures left out"
    );
    let failed: Vec<&str> = d.errors.iter().map(|e| e.body.as_str()).collect();
    assert_eq!(failed, vec!["Moon", "Jupiter"]);
    assert!(d.errors.iter().all(|e| e.message.contains("refused")));
    let eph = Sky::new();

    // The star catalogue stops one second before the Sun does.
    let t0 = civil_to_jd(2060, 12, 31) + 0.5;
    let d = day_events(
        &eph,
        &s,
        t0,
        civil_to_jd(2061, 1, 1),
        &["Sun", "Vega"],
        &std_opts(),
    )
    .unwrap();
    assert_eq!(d.bodies.len(), 1);
    assert_eq!(d.errors[0].body, "Vega");

    // Without the Sun there are no phases: the call fails.
    let t0 = civil_to_jd(1989, 12, 31);
    match day_events(&eph, &s, t0, t0 + 1.0, &["Vega"], &std_opts()) {
        Err(AlmanacError::Unavailable { body, .. }) => assert_eq!(body, "Sun"),
        other => panic!("{other:?}"),
    }
    for (a, b) in [(t0, t0), (t0 + 1.0, t0), (f64::NAN, t0), (t0, t0 + 401.0)] {
        assert!(matches!(
            day_events(&eph, &s, a, b, &["Sun"], &std_opts()),
            Err(AlmanacError::Invalid(_))
        ));
    }
}

#[test]
fn a_window_that_starts_with_the_sun_up_has_no_rise_at_its_start() {
    let eph = Sky::new();
    let s = site(39.9526, -75.1652);
    let noon = civil_to_jd(2026, 9, 24) + 16.9 / 24.0;
    let d = day_events(&eph, &s, noon, noon + 0.5, &["Sun"], &std_opts()).unwrap();
    let sun = events_of(&d, "Sun");
    assert!(times(sun, EventKind::Rise).is_empty());
    assert_eq!(times(sun, EventKind::Set).len(), 1);
    assert_eq!(d.phases[0].phase, SkyPhase::Day);
}
