//! The `AstroProvider` contract for `SunProvider`: coverage, refusals, the shape of
//! the direction it hands to the reducer, and the DUT1 assumption.

use skyfix_core::time::parse_utc;
use skyfix_ephemeris::sun::{
    COVERAGE_END_UTC, COVERAGE_START_UTC, JD_COVERAGE_END, JD_COVERAGE_START, SunProvider,
    vsop87_self_check,
};
use skyfix_ephemeris::{AstroProvider, EphemerisError};

#[test]
fn coverage_declares_the_window_the_bodies_and_the_assumptions() {
    let c = SunProvider::new().coverage();
    assert_eq!(c.start_utc, COVERAGE_START_UTC);
    assert_eq!(c.end_utc, COVERAGE_END_UTC);
    assert_eq!(c.bodies, vec!["Sun".to_string()]);
    assert_eq!(parse_utc(&c.start_utc).unwrap(), JD_COVERAGE_START);
    assert_eq!(parse_utc(&c.end_utc).unwrap(), JD_COVERAGE_END);
    // The notes are shown to the user verbatim, so they must name the model, the
    // truncation and the DUT1 assumption.
    for needle in ["VSOP87D", "IAU 2000B", "DUT1", "0.23'", "959.63", "8.794"] {
        assert!(
            c.notes.contains(needle),
            "coverage notes should mention {needle:?}: {}",
            c.notes
        );
    }
    assert!(c.accuracy_arcmin > 0.0 && c.accuracy_arcmin <= 0.1);
}

#[test]
fn refuses_times_outside_coverage_and_names_the_range() {
    let p = SunProvider::new();
    for jd in [JD_COVERAGE_START - 1e-6, JD_COVERAGE_END + 1e-6] {
        match p.geocentric("Sun", jd) {
            Err(EphemerisError::OutOfCoverage {
                provider,
                jd_utc,
                coverage,
            }) => {
                assert_eq!(provider, "SunProvider");
                assert_eq!(jd_utc, jd);
                assert!(coverage.contains(COVERAGE_START_UTC));
                assert!(coverage.contains(COVERAGE_END_UTC));
            }
            other => panic!("expected OutOfCoverage at jd {jd}, got {other:?}"),
        }
    }
    // Both endpoints themselves are inside.
    assert!(p.geocentric("Sun", JD_COVERAGE_START).is_ok());
    assert!(p.geocentric("Sun", JD_COVERAGE_END).is_ok());
}

#[test]
fn refuses_non_finite_times_and_bodies_it_does_not_provide() {
    let p = SunProvider::new();
    for jd in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(matches!(
            p.geocentric("Sun", jd),
            Err(EphemerisError::Data(_))
        ));
    }
    let jd = parse_utc("2026-10-01T01:30:00Z").unwrap();
    match p.geocentric("Vega", jd) {
        Err(EphemerisError::UnknownBody(body, provider)) => {
            assert_eq!(body, "Vega");
            assert_eq!(provider, "SunProvider");
        }
        other => panic!("expected UnknownBody, got {other:?}"),
    }
    // The Nautical Almanac spelling is "Sun"; accept any casing of it.
    for name in ["Sun", "sun", "SUN", "sUn"] {
        assert!(p.geocentric(name, jd).is_ok(), "{name} should resolve");
    }
}

/// `skyfix_core::session::validate` accepts a body name with surrounding whitespace
/// (`body_is_known` trims), `catalog::find` resolves `"vega "`, and
/// `skyfix_core::reduce::is_sun` trims before deciding whether to apply semidiameter and
/// parallax. The Sun provider has to agree, or the same record is legal to validate,
/// corrected as the Sun, and then refused a direction.
#[test]
fn a_padded_sun_name_resolves_exactly_as_a_padded_star_name_does() {
    let p = SunProvider::new();
    let jd = parse_utc("2026-10-01T15:30:00Z").unwrap();
    let reference = p.geocentric("Sun", jd).unwrap();
    for name in ["Sun ", " Sun", "  sun  ", "\tSUN\n"] {
        assert!(
            skyfix_core::reduce::is_sun(name),
            "{name:?}: the correction chain calls this the Sun"
        );
        match p.geocentric(name, jd) {
            Ok(d) => assert_eq!(d, reference, "{name:?} must give the same direction"),
            Err(e) => panic!("{name:?} was refused a direction: {e}"),
        }
    }
    // And the clock rate is the solar one, not the sidereal one, for the same names.
    let source = skyfix_ephemeris::ProviderSource(SunProvider::new());
    for name in ["Sun", "Sun ", " sun"] {
        assert_eq!(
            skyfix_core::reduce::DirectionSource::gha_rate_deg_per_hour(&source, name),
            skyfix_core::units::SOLAR_RATE_DEG_PER_HOUR,
            "{name:?} must use the solar GHA rate"
        );
    }
    assert_eq!(
        skyfix_core::reduce::DirectionSource::gha_rate_deg_per_hour(&source, "Vega "),
        skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR
    );
}

#[test]
fn geocentric_matches_the_full_position_and_carries_sd_and_hp() {
    let p = SunProvider::new();
    let jd = parse_utc("2026-10-01T15:30:00Z").unwrap();
    let full = p.position(jd).unwrap();
    let dir = p.geocentric("Sun", jd).unwrap();
    assert_eq!(dir, full.direction());
    assert_eq!(dir.gha_deg, full.gha_deg);
    assert_eq!(dir.dec_deg, full.dec_deg);
    // CONVENTIONS section 5 steps 4 and 5 read these straight off the record, so they
    // must never be left at zero for the Sun.
    assert!(dir.semidiameter_arcmin > 15.0);
    assert!(dir.horizontal_parallax_arcmin > 0.1);
    assert_eq!(p.name(), "SunProvider");
}

/// DUT1 moves GHA and nothing else, at the sidereal rate. |DUT1| < 0.9 s is the 0.23'
/// GHA term that CONVENTIONS section 6 puts in the error budget.
#[test]
fn dut1_shifts_gha_only() {
    let jd = parse_utc("2026-10-01T15:30:00Z").unwrap();
    let zero = SunProvider::new().position(jd).unwrap();
    let plus = SunProvider::with_dut1_s(0.9).position(jd).unwrap();

    assert_eq!(SunProvider::new().dut1_s(), 0.0);
    assert_eq!(SunProvider::default(), SunProvider::new());

    // Declination, distance and the ecliptic place do not depend on UT1 at all.
    assert_eq!(zero.dec_deg, plus.dec_deg);
    assert_eq!(zero.radius_au, plus.radius_au);
    assert_eq!(zero.apparent_longitude_deg, plus.apparent_longitude_deg);

    // GHA moves by 0.9 s at the sidereal rate: 0.9 * 15.041 / 3600 deg = 0.00376 deg
    // = 0.2256 arcmin.
    let shift_arcmin = (plus.gha_deg - zero.gha_deg) * 60.0;
    assert!(
        (0.22..0.23).contains(&shift_arcmin),
        "0.9 s of DUT1 moved GHA by {shift_arcmin:.4}', expected about 0.226'"
    );
    // The coverage notes change to report the supplied value instead of the assumption.
    assert!(
        SunProvider::with_dut1_s(0.9)
            .coverage()
            .notes
            .contains("DUT1 supplied as +0.9000 s")
    );
}

/// The embedded VSOP87 series still reproduces the checkpoints it shipped with,
/// including the value published in the catalogue's own `vsop87.chk`.
#[test]
fn embedded_series_still_matches_its_published_checkpoint() {
    let (dl, db, dr) = vsop87_self_check().unwrap();
    assert!(dl < 0.02, "heliocentric longitude off by {dl}\"");
    assert!(db < 0.02, "heliocentric latitude off by {db}\"");
    assert!(dr < 1e-7, "radius vector off by {dr} au");
}

/// The provider must be able to run with no filesystem and no network — that is the
/// whole point of embedding the coefficients. A crude but effective guard: no code
/// line in `src/` may reach for the filesystem or a socket. Comments are skipped, so
/// provenance URLs in documentation are fine; a URL in a string literal is text, not a
/// network call, and is not what this looks for.
#[test]
fn library_sources_contain_no_filesystem_or_network_access() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (i, line) in text.lines().enumerate() {
            // Skip doc comments and ordinary comments: provenance URLs belong there.
            let t = line.trim_start();
            if t.starts_with("//") {
                continue;
            }
            for needle in ["std::fs", "std::net", "File::open", "TcpStream", "reqwest"] {
                assert!(
                    !line.contains(needle),
                    "{}:{} uses {needle:?}, which will not build for wasm32: {line}",
                    path.display(),
                    i + 1
                );
            }
        }
    }
}
