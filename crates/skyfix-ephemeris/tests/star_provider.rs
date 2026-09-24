//! `StarProvider` behaviour: catalogue completeness, the `AstroProvider` contract,
//! coverage refusal, normalisation and the GHA/SHA/Aries identity.

use skyfix_core::time::parse_utc;
use skyfix_core::units::norm_360;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::{AstroProvider, EphemerisError};

/// The 57 Nautical Almanac navigational stars plus Polaris, in the spelling
/// `docs/CONVENTIONS.md` section 10 requires of session files.
const ALMANAC_NAMES: [&str; 58] = [
    "Acamar",
    "Achernar",
    "Acrux",
    "Adhara",
    "Aldebaran",
    "Alioth",
    "Alkaid",
    "Al Na'ir",
    "Alnilam",
    "Alphard",
    "Alphecca",
    "Alpheratz",
    "Altair",
    "Ankaa",
    "Antares",
    "Arcturus",
    "Atria",
    "Avior",
    "Bellatrix",
    "Betelgeuse",
    "Canopus",
    "Capella",
    "Deneb",
    "Denebola",
    "Diphda",
    "Dubhe",
    "Elnath",
    "Eltanin",
    "Enif",
    "Fomalhaut",
    "Gacrux",
    "Gienah",
    "Hadar",
    "Hamal",
    "Kaus Australis",
    "Kochab",
    "Markab",
    "Menkar",
    "Menkent",
    "Miaplacidus",
    "Mirfak",
    "Nunki",
    "Peacock",
    "Pollux",
    "Procyon",
    "Rasalhague",
    "Regulus",
    "Rigel",
    "Rigil Kentaurus",
    "Sabik",
    "Schedar",
    "Shaula",
    "Sirius",
    "Spica",
    "Suhail",
    "Vega",
    "Zubenelgenubi",
    "Polaris",
];

fn jd(utc: &str) -> f64 {
    parse_utc(utc).expect("test timestamp")
}

#[test]
fn every_almanac_star_is_present_and_answerable() {
    let p = StarProvider::new();
    let cov = p.coverage();
    assert_eq!(cov.bodies.len(), 58);
    let t = jd("2026-10-01T01:30:00Z");
    for name in ALMANAC_NAMES {
        assert!(
            cov.bodies.iter().any(|b| b == name),
            "{name} missing from coverage"
        );
        let d = p
            .geocentric(name, t)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            (0.0..360.0).contains(&d.gha_deg),
            "{name} GHA {} out of [0, 360)",
            d.gha_deg
        );
        assert!(
            (-90.0..=90.0).contains(&d.dec_deg),
            "{name} Dec {} out of range",
            d.dec_deg
        );
        assert_eq!(d.semidiameter_arcmin, 0.0, "{name} has a semidiameter");
        assert_eq!(
            d.horizontal_parallax_arcmin, 0.0,
            "{name} has a horizontal parallax"
        );
    }
}

#[test]
fn unknown_bodies_are_refused_by_name() {
    let p = StarProvider::new();
    let t = jd("2026-10-01T01:30:00Z");
    match p.geocentric("Sun", t) {
        Err(EphemerisError::UnknownBody(b, prov)) => {
            assert_eq!(b, "Sun");
            assert!(prov.contains("skyfix-stars"));
        }
        other => panic!("expected UnknownBody for the Sun, got {other:?}"),
    }
    assert!(matches!(
        p.geocentric("Betelgeuze", t),
        Err(EphemerisError::UnknownBody(..))
    ));
    assert!(matches!(
        p.geocentric("HIP 999999", t),
        Err(EphemerisError::UnknownBody(..))
    ));
}

#[test]
fn queries_outside_coverage_are_refused_with_the_range() {
    let p = StarProvider::new();
    let cov = p.coverage();
    for outside in ["1989-12-31T23:00:00Z", "2061-01-01T00:00:01Z"] {
        match p.geocentric("Vega", jd(outside)) {
            Err(EphemerisError::OutOfCoverage { coverage, .. }) => {
                assert!(
                    coverage.contains(&cov.start_utc) && coverage.contains(&cov.end_utc),
                    "coverage message {coverage:?} does not name the range"
                );
            }
            other => panic!("expected OutOfCoverage at {outside}, got {other:?}"),
        }
    }
    // The edges themselves are inside.
    assert!(p.geocentric("Vega", jd("1990-01-01T00:00:00Z")).is_ok());
    assert!(p.geocentric("Vega", jd("2060-12-31T23:59:59Z")).is_ok());
}

/// CONVENTIONS section 2: `GHA_star = GHA_Aries + SHA`.
#[test]
fn gha_equals_gha_aries_plus_sha() {
    let p = StarProvider::new();
    for utc in [
        "1990-01-01T00:00:00Z",
        "2026-10-01T01:30:00Z",
        "2026-03-20T12:00:00Z",
        "2060-12-31T12:00:00Z",
    ] {
        let t = jd(utc);
        let aries = p.gha_aries_deg(t);
        for name in ["Vega", "Polaris", "Rigil Kentaurus", "Acamar", "Sirius"] {
            let gha = p.geocentric(name, t).unwrap().gha_deg;
            let sha = p.sha_deg(name, t).unwrap();
            let rebuilt = norm_360(aries + sha);
            let d = (gha - rebuilt).abs().min(360.0 - (gha - rebuilt).abs());
            assert!(
                d * 3600.0 < 1e-6,
                "{name} at {utc}: GHA {gha}, rebuilt {rebuilt}"
            );
            assert!((0.0..360.0).contains(&sha), "{name} SHA {sha} out of range");
        }
    }
}

/// GHA must advance at the sidereal rate: one full turn per sidereal day.
#[test]
fn gha_advances_at_the_sidereal_rate() {
    let p = StarProvider::new();
    let t = jd("2026-10-01T01:30:00Z");
    let a = p.geocentric("Vega", t).unwrap().gha_deg;
    let b = p.geocentric("Vega", t + 1.0 / 24.0).unwrap().gha_deg;
    let rate = norm_360(b - a);
    assert!(
        (rate - skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR).abs() < 1e-3,
        "{rate} deg/h"
    );
}

/// The GHA wrap must be handled, not smoothed: stepping across 0 deg is fine.
#[test]
fn gha_wraps_cleanly_through_zero() {
    let p = StarProvider::new();
    let mut crossed = false;
    let start = jd("2026-10-01T00:00:00Z");
    let mut prev = p.geocentric("Vega", start).unwrap().gha_deg;
    for i in 1..=1440 {
        let g = p.geocentric("Vega", start + f64::from(i) / 1440.0).unwrap();
        assert!((0.0..360.0).contains(&g.gha_deg));
        if g.gha_deg < prev {
            crossed = true;
        }
        prev = g.gha_deg;
    }
    assert!(crossed, "GHA never wrapped in a whole day");
}

/// Precession is real but bounded: over the 71-year coverage window an apparent place
/// moves by roughly 1 degree, never by tens of degrees.
#[test]
fn apparent_places_drift_by_about_a_degree_across_the_coverage_window() {
    let p = StarProvider::new();
    let (t0, t1) = (jd("1990-01-01T00:00:00Z"), jd("2060-12-31T00:00:00Z"));
    for name in ["Vega", "Sirius", "Capella", "Antares"] {
        let (ra0, dec0) = p.apparent_radec_deg(name, t0).unwrap();
        let (ra1, dec1) = p.apparent_radec_deg(name, t1).unwrap();
        let dra = ((ra1 - ra0 + 180.0).rem_euclid(360.0) - 180.0) * dec0.to_radians().cos();
        let drift = dra.hypot(dec1 - dec0);
        assert!(
            (0.2..3.0).contains(&drift),
            "{name} drifted {drift} deg over 71 years"
        );
    }
}

/// Polaris is the reason the aberration and parallax code is written in vectors: the
/// scalar formulae blow up as `1/cos(dec)`. Its declination must stay sane and its
/// GHA must still be a well-defined number all year.
#[test]
fn polaris_stays_well_behaved_near_the_pole() {
    let p = StarProvider::new();
    let start = jd("2026-01-01T00:00:00Z");
    for i in 0..365 {
        let d = p.geocentric("Polaris", start + f64::from(i)).unwrap();
        assert!(d.gha_deg.is_finite() && (0.0..360.0).contains(&d.gha_deg));
        assert!(
            (89.0..90.0).contains(&d.dec_deg),
            "Polaris declination {} on day {i}",
            d.dec_deg
        );
    }
}

#[test]
fn supplying_dut1_moves_gha_and_nothing_else() {
    let t = jd("2026-10-01T01:30:00Z");
    let a = StarProvider::new();
    let b = StarProvider::with_dut1(-0.4);
    let ga = a.geocentric("Vega", t).unwrap();
    let gb = b.geocentric("Vega", t).unwrap();
    assert_eq!(ga.dec_deg, gb.dec_deg, "DUT1 must not touch declination");
    let shift_arcmin = ((gb.gha_deg - ga.gha_deg + 180.0).rem_euclid(360.0) - 180.0) * 60.0;
    // -0.4 s of UT1 is -0.4 * 15.04107"/s = -6.02" = -0.100'.
    assert!((shift_arcmin + 0.1003).abs() < 0.001, "{shift_arcmin}'");
    assert_eq!(b.dut1_s(), -0.4);
}

#[test]
fn coverage_declares_its_models_and_its_provisional_data() {
    let cov = StarProvider::new().coverage();
    assert_eq!(cov.start_utc, "1990-01-01T00:00:00Z");
    assert_eq!(cov.end_utc, "2060-12-31T23:59:59Z");
    assert!(cov.accuracy_arcmin > 0.0 && cov.accuracy_arcmin <= 0.05);
    for expected in [
        "IAU 2006",
        "IAU 2000B",
        "aberration",
        "parallax",
        "DUT1",
        "Hipparcos",
    ] {
        assert!(
            cov.notes.contains(expected),
            "coverage notes never mention {expected:?}: {}",
            cov.notes
        );
    }
    assert!(!cov.notes.contains("CATALOGUE FAILED TO LOAD"));
}

/// The crate's `ProviderSource` adapter must hand the core a star rate, not a Sun rate.
#[test]
fn provider_source_adapter_reports_the_sidereal_rate() {
    use skyfix_core::reduce::DirectionSource;
    let s = skyfix_ephemeris::ProviderSource(StarProvider::new());
    assert_eq!(
        s.gha_rate_deg_per_hour("Vega"),
        skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR
    );
    let d = s.direction("Vega", jd("2026-10-01T01:30:00Z")).unwrap();
    assert!((0.0..360.0).contains(&d.gha_deg));
    assert!(s.direction("Jupiter", jd("2026-10-01T01:30:00Z")).is_err());
}

/// The oldest check in celestial navigation: the altitude of Polaris is the
/// observer's latitude, to within Polaris's distance from the pole (0.63 deg in the
/// 2020s). Nothing in this crate is fitted to that fact, so it is a genuine
/// end-to-end test of the catalogue, the reduction and the sidereal time at once —
/// and it would fail loudly if GHA had the wrong sign or the wrong zero point.
///
/// The altitude formula is CONVENTIONS section 3, written out here so the test does
/// not depend on another crate's module.
#[test]
fn the_altitude_of_polaris_is_the_observers_latitude() {
    let p = StarProvider::new();
    // Philadelphia City Hall (CONVENTIONS section 2), longitude east-positive.
    let (lat_deg, lon_deg) = (39.9526_f64, -75.1652_f64);
    let mut extremes = (f64::MAX, f64::MIN);
    for utc in [
        "2026-01-15T03:00:00Z",
        "2026-04-15T09:00:00Z",
        "2026-07-15T15:00:00Z",
        "2026-10-01T01:30:00Z",
        "2026-10-01T13:30:00Z",
    ] {
        let d = p.geocentric("Polaris", jd(utc)).unwrap();
        let lha = norm_360(d.gha_deg + lon_deg).to_radians();
        let (phi, dec) = (lat_deg.to_radians(), d.dec_deg.to_radians());
        let hc = (phi.sin() * dec.sin() + phi.cos() * dec.cos() * lha.cos())
            .asin()
            .to_degrees();
        // North component of the body direction, for the azimuth.
        let n = phi.cos() * dec.sin() - phi.sin() * dec.cos() * lha.cos();
        let e = -dec.cos() * lha.sin();
        let zn = norm_360(e.atan2(n).to_degrees());
        let err = hc - lat_deg;
        extremes = (extremes.0.min(err), extremes.1.max(err));
        assert!(
            err.abs() < 0.7,
            "{utc}: Polaris altitude {hc:.4} deg vs latitude {lat_deg} deg ({err:+.4})"
        );
        // And it must be in the north.
        assert!(
            zn < 1.5 || zn > 358.5,
            "{utc}: Polaris azimuth {zn:.2} deg is not north"
        );
    }
    // The error must actually swing with hour angle, not sit at a constant: that is
    // what proves the GHA is moving and not frozen.
    assert!(
        extremes.1 - extremes.0 > 0.5,
        "Polaris altitude error never varied: {extremes:?}"
    );
}

/// Vega's tabulated place, as a coarse cross-check against the printed almanac: the
/// Nautical Almanac star pages give SHA about 80.5 deg and declination about
/// N 38 deg 48' through the 2020s. This is a smoke test with a deliberately loose
/// tolerance, not a precision claim; the precision claims are in
/// `apparent_place_reference.rs`.
#[test]
fn vega_is_where_the_almanac_star_pages_put_it() {
    let p = StarProvider::new();
    let t = jd("2026-10-01T01:30:00Z");
    let sha = p.sha_deg("Vega", t).unwrap();
    let dec = p.geocentric("Vega", t).unwrap().dec_deg;
    assert!((sha - 80.5).abs() < 0.3, "Vega SHA {sha} deg");
    assert!(
        (dec - (38.0 + 48.0 / 60.0)).abs() < 0.1,
        "Vega Dec {dec} deg"
    );
}
