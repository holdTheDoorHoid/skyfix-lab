//! `PlanetProvider` behaviour that does not need the reference fixtures: the
//! provider contract (names, coverage, errors), agreement between its two views of a
//! planet, the `Sky` registry, and physical sanity across the whole window.
//!
//! The accuracy against JPL DE440s is `tests/planets_reference.rs`.

use skyfix_core::time::parse_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::{BodyEphemeris, BodyKind, PLANETS, Sky};
use skyfix_ephemeris::planets::{Planet, PlanetProvider};
use skyfix_ephemeris::{AstroProvider, EphemerisError};

fn jd(s: &str) -> f64 {
    parse_utc(s).unwrap()
}

#[test]
fn names_resolve_trimmed_and_case_insensitively() {
    let p = PlanetProvider::new();
    let t = jd("2026-09-24T12:00:00Z");
    for (name, canonical) in [
        (" jupiter ", "Jupiter"),
        ("VENUS", "Venus"),
        ("mars", "Mars"),
    ] {
        let st = p.apparent_state(name, t).unwrap();
        assert_eq!(st.body, canonical);
        assert_eq!(st.kind, BodyKind::Planet);
    }
    for bad in ["Pluto", "Sun", "Moon", "Vega", ""] {
        assert!(
            matches!(p.geocentric(bad, t), Err(EphemerisError::UnknownBody(..))),
            "{bad:?}"
        );
    }
    assert_eq!(Planet::from_name(" nEpTuNe"), Some(Planet::Neptune));
    assert_eq!(
        Planet::ALL.map(Planet::name).to_vec(),
        PLANETS.to_vec(),
        "Planet::ALL follows body::PLANETS"
    );
}

#[test]
fn state_and_direction_agree_exactly() {
    let p = PlanetProvider::new();
    let t = jd("2031-05-17T03:45:12Z");
    for name in PLANETS {
        let st = p.apparent_state(name, t).unwrap();
        let dir = p.geocentric(name, t).unwrap();
        assert_eq!(st.direction(), dir, "{name}");
        assert!((0.0..360.0).contains(&st.ra_deg) && (0.0..360.0).contains(&st.gha_deg));
        assert!((0.0..360.0).contains(&st.sha_deg()));
        let k = st.illuminated_fraction.unwrap();
        let i = st.phase_angle_deg.unwrap();
        assert!(
            (0.0..=1.0).contains(&k) && (0.0..=180.0).contains(&i),
            "{name}"
        );
        assert!((k - (1.0 + i.to_radians().cos()) / 2.0).abs() < 1e-12);
        assert!((0.0..=180.0).contains(&st.elongation_deg.unwrap()));
        assert!((0.0..360.0).contains(&st.bright_limb_angle_deg.unwrap()));
        assert!(st.magnitude.is_some(), "{name}");
        assert!(st.distance_km.unwrap() > 4.0e7, "{name}");
    }
}

#[test]
fn out_of_coverage_is_refused_not_extrapolated() {
    // The navigation default answers the validated tier only (CONVENTIONS 15.1).
    let p = PlanetProvider::new();
    for t in ["1549-12-31T23:59:59Z", "2650-01-22T00:00:01Z"] {
        assert!(
            matches!(
                p.apparent_state("Mars", jd(t)),
                Err(EphemerisError::OutOfCoverage { .. })
            ),
            "{t}"
        );
    }
    for t in ["1550-01-01T00:00:00Z", "2650-01-22T00:00:00Z"] {
        assert!(p.apparent_state("Mars", jd(t)).is_ok(), "{t}");
    }
    // The display path answers the labelled tier as well, and nothing beyond it.
    let l = p.with_policy(skyfix_ephemeris::tiers::TierPolicy::WithLabelled);
    for t in [
        "1549-12-31T23:59:59Z",
        "2650-01-22T00:00:01Z",
        "2999-12-31T00:00:00Z",
    ] {
        assert!(l.apparent_state("Mars", jd(t)).is_ok(), "{t}");
    }
    for jd_utc in [
        skyfix_ephemeris::tiers::JD_LABELLED_START - 1e-5,
        skyfix_ephemeris::tiers::JD_LABELLED_END + 1e-5,
    ] {
        assert!(matches!(
            l.apparent_state("Mars", jd_utc),
            Err(EphemerisError::OutOfCoverage { .. })
        ));
    }
}

#[test]
fn heliocentric_positions_are_exposed_on_equatorial_axes() {
    use skyfix_ephemeris::planets::heliocentric_position_au;
    // vsop87.chk, VSOP87A EARTH at J2000: x -0.1771354586, y 0.9672416237,
    // z -0.0000039 on the ecliptic; rotated to the equator by the catalogue's matrix.
    let e = heliocentric_position_au("Earth", 2_451_545.0).unwrap();
    let ecl = [-0.177_135_458_6, 0.967_241_623_7, -0.000_003_900_0];
    let m = [
        [1.0, 0.000_000_440_360, -0.000_000_190_919],
        [-0.000_000_479_966, 0.917_482_137_087, -0.397_776_982_902],
        [0.0, 0.397_776_982_902, 0.917_482_137_087],
    ];
    for k in 0..3 {
        let want: f64 = (0..3).map(|j| m[k][j] * ecl[j]).sum();
        // The embedded series are truncated: 2.3e-7 au at worst over the window.
        assert!((e[k] - want).abs() < 2.5e-7, "{e:?}, axis {k}: {want}");
    }
    let r = |b: &str| {
        let p = heliocentric_position_au(b, 2_461_307.5).unwrap();
        (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt()
    };
    assert!((0.30..0.47).contains(&r("mercury")));
    assert!((29.7..30.4).contains(&r("Neptune")));
    assert!(matches!(
        heliocentric_position_au("Pluto", 2_451_545.0),
        Err(EphemerisError::UnknownBody(..))
    ));
}

#[test]
fn dut1_moves_gha_only() {
    let t = jd("2026-10-01T01:30:00Z");
    let a = PlanetProvider::new().position(Planet::Saturn, t).unwrap();
    let b = PlanetProvider::with_dut1_s(0.5)
        .position(Planet::Saturn, t)
        .unwrap();
    // 0.5 s of UT1 is 0.5 x 15.041" = 7.52" of hour angle.
    let d = norm_180(b.gha_deg - a.gha_deg) * 3600.0;
    assert!((d - 7.52).abs() < 0.01, "{d}\"");
    assert_eq!(a.dec_deg, b.dec_deg);
    assert_eq!(a.ra_deg, b.ra_deg);
    assert_eq!(PlanetProvider::with_dut1_s(0.5).dut1_s(), 0.5);
}

#[test]
fn the_sky_registry_serves_planets_and_reports_them_validated() {
    let sky = Sky::new();
    let t = jd("2026-09-24T00:00:00Z");
    let venus = sky.apparent_state("venus", t).unwrap();
    assert_eq!(venus.body, "Venus");
    assert_eq!(
        venus,
        PlanetProvider::new().apparent_state("Venus", t).unwrap()
    );
    let rate = sky.gha_rate_deg_per_hour("Jupiter", t).unwrap();
    assert!((14.9..15.1).contains(&rate), "{rate}");
    let group = &sky.coverage_groups()[2];
    assert_eq!(group.bodies, PLANETS.map(str::to_string).to_vec());
    assert!(
        group.accuracy_arcmin.is_finite() && group.accuracy_arcmin <= 0.1,
        "the planets must be offered as validated: {}",
        group.accuracy_arcmin
    );
    assert!(group.notes.contains("VSOP87A"));
}

/// Every planet, every 40 days for 71 years: the geometry and the physical
/// ephemeris stay where the solar system keeps them.
#[test]
fn physical_ephemeris_stays_in_range_over_the_window() {
    let p = PlanetProvider::new();
    let start = jd("1990-01-01T00:00:00Z");
    // (planet, max elongation, magnitude range, semidiameter range in arcsec)
    let limits = [
        (Planet::Mercury, 28.5, (-2.7, 7.6), (2.2, 6.6)),
        (Planet::Venus, 47.9, (-4.95, -2.9), (4.7, 33.0)),
        (Planet::Mars, 180.0, (-3.0, 1.9), (1.7, 12.9)),
        (Planet::Jupiter, 180.0, (-3.0, -1.5), (15.0, 25.2)),
        (Planet::Saturn, 180.0, (-0.6, 1.6), (7.2, 10.4)),
        (Planet::Uranus, 180.0, (5.2, 6.1), (1.6, 2.1)),
        (Planet::Neptune, 180.0, (7.6, 8.1), (1.0, 1.2)),
    ];
    for (planet, max_elong, (m_lo, m_hi), (sd_lo, sd_hi)) in limits {
        let mut i = 0;
        loop {
            let t = start + 40.0 * f64::from(i);
            if t > jd("2060-12-31T00:00:00Z") {
                break;
            }
            let s = p.position(planet, t).unwrap();
            let m = s.magnitude.expect("a magnitude everywhere in the window");
            let sd = s.semidiameter_arcmin * 60.0;
            assert!(s.elongation_deg <= max_elong, "{planet:?} {t}: {s:?}");
            assert!((m_lo..=m_hi).contains(&m), "{planet:?} {t}: V {m}");
            assert!((sd_lo..=sd_hi).contains(&sd), "{planet:?} {t}: SD {sd}\"");
            // Horizontal parallax is the Earth's radius over the distance, like SD.
            let hp_over_sd = s.horizontal_parallax_arcmin / s.semidiameter_arcmin;
            let want = 6378.137 / planet.equatorial_radius_km();
            assert!((hp_over_sd / want - 1.0).abs() < 1e-6);
            // The light-time is the distance over c.
            assert!((s.light_time_s - s.distance_au * 499.004_784).abs() < 1e-3);
            i += 1;
        }
    }
}

/// Speed: run with `cargo test --release -p skyfix-ephemeris --test planets_provider
/// -- --ignored --nocapture`.
#[test]
#[ignore = "timing, meaningful only in release"]
fn timing_per_call() {
    let p = PlanetProvider::new();
    let t0 = jd("2026-09-24T00:00:00Z");
    // Warm the embedded-data parse.
    p.position(Planet::Mars, t0).unwrap();
    let n = 2000;
    for planet in Planet::ALL {
        let start = std::time::Instant::now();
        let mut acc = 0.0;
        for i in 0..n {
            acc += p
                .position(planet, t0 + f64::from(i) * 0.37)
                .unwrap()
                .gha_deg;
        }
        let us = start.elapsed().as_secs_f64() * 1e6 / f64::from(n);
        println!("{:<8} {us:7.1} us per position ({acc:.0})", planet.name());
    }
    let start = std::time::Instant::now();
    let mut acc = 0.0;
    for i in 0..200 {
        for planet in Planet::ALL {
            acc += p
                .position(planet, t0 + f64::from(i) * 0.37)
                .unwrap()
                .dec_deg;
        }
    }
    let us = start.elapsed().as_secs_f64() * 1e6 / 200.0;
    println!("all seven planets: {us:.1} us ({acc:.0})");
}
