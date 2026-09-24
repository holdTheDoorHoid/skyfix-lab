//! `CompositeProvider`: priority order, which provider answered, and what happens when
//! none of them can.

use std::collections::BTreeMap;

use skyfix_core::time::parse_utc;
use skyfix_ephemeris::fixture_pack::{
    ALMANAC_PACK_SCHEMA, AlmanacPack, BodyTable, CompositeProvider, FixturePackProvider,
};
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::{AstroProvider, EphemerisError};

const PACK_START: &str = "2026-10-01T00:00:00Z";

/// A pack carrying the Moon *and* a Sun of its own, so the priority order is testable.
fn pack() -> FixturePackProvider {
    let mut bodies = BTreeMap::new();
    for (body, gha0) in [("Moon", 100.0), ("Sun", 200.0)] {
        bodies.insert(
            body.to_string(),
            BodyTable {
                step_s: 3600.0,
                start_utc: PACK_START.to_string(),
                rows: (0..25)
                    .map(|i| {
                        let t = f64::from(i);
                        [
                            (gha0 + 14.4921 * t).rem_euclid(360.0),
                            5.0 + 0.1 * t,
                            16.0,
                            0.15,
                        ]
                    })
                    .collect(),
            },
        );
    }
    let p = AlmanacPack {
        schema: ALMANAC_PACK_SCHEMA.to_string(),
        provider: "test-pack".to_string(),
        generator: serde_json::json!({"tool": "test"}),
        bodies,
        notes: String::new(),
    };
    FixturePackProvider::from_json(&serde_json::to_string(&p).unwrap()).unwrap()
}

fn composite() -> CompositeProvider {
    CompositeProvider::new("SkyFix ephemeris")
        .with(SunProvider::new())
        .with(pack())
}

#[test]
fn the_first_provider_that_can_answer_does_and_is_named() {
    let c = composite();
    assert_eq!(
        c.provider_names(),
        vec!["SunProvider", "FixturePackProvider[test-pack]"]
    );

    // Inside the pack's window both providers carry the Sun; the Sun model wins.
    let jd = parse_utc("2026-10-01T06:30:00Z").unwrap();
    let (dir, who) = c.resolve("Sun", jd).unwrap();
    assert_eq!(
        who, "SunProvider",
        "the computed model must outrank the pack"
    );
    assert_eq!(dir, SunProvider::new().geocentric("Sun", jd).unwrap());

    // The Moon only exists in the pack.
    let (dir, who) = c.resolve("Moon", jd).unwrap();
    assert_eq!(who, "FixturePackProvider[test-pack]");
    assert_eq!(dir, pack().geocentric("Moon", jd).unwrap());

    // Outside the pack's window the Sun still answers, because its own coverage is
    // 1990-2060 and it is tried first.
    let jd = parse_utc("2040-06-01T00:00:00Z").unwrap();
    let (_, who) = c.resolve("Sun", jd).unwrap();
    assert_eq!(who, "SunProvider");
    // ... but the Moon is now out of every provider's reach.
    assert!(c.resolve("Moon", jd).is_err());

    // The plain trait method agrees with `resolve`, it just drops the name.
    let jd = parse_utc("2026-10-01T06:30:00Z").unwrap();
    assert_eq!(
        c.geocentric("Moon", jd).unwrap(),
        c.resolve("Moon", jd).unwrap().0
    );
    assert_eq!(c.name(), "SkyFix ephemeris");
}

/// Order is priority: put the pack first and it answers for the Sun instead.
#[test]
fn reordering_changes_who_answers() {
    let c = CompositeProvider::new("pack first")
        .with(pack())
        .with(SunProvider::new());
    let jd = parse_utc("2026-10-01T06:30:00Z").unwrap();
    let (dir, who) = c.resolve("Sun", jd).unwrap();
    assert_eq!(who, "FixturePackProvider[test-pack]");
    assert_eq!(dir, pack().geocentric("Sun", jd).unwrap());
    // And the two really do disagree, so this test is not vacuous: the pack's rows are
    // made up, the Sun model's are not.
    assert!(
        (dir.gha_deg - SunProvider::new().position(jd).unwrap().gha_deg).abs() > 1.0,
        "the synthetic pack should not happen to agree with the real Sun"
    );
}

/// When nothing can answer, report the most informative failure: "this provider stops
/// in 2026" tells the user what to change, "nobody here has a Moon" does not.
#[test]
fn the_most_informative_failure_is_reported() {
    let c = composite();

    // A body no provider carries anywhere: UnknownBody, naming the composite.
    let jd = parse_utc("2026-10-01T06:30:00Z").unwrap();
    match c.resolve("Jupiter", jd) {
        Err(EphemerisError::UnknownBody(body, _)) => assert_eq!(body, "Jupiter"),
        other => panic!("expected UnknownBody, got {other:?}"),
    }

    // The Moon exists in the pack but the time is outside it. The Sun provider's
    // UnknownBody must not mask the pack's OutOfCoverage.
    let jd = parse_utc("2026-10-05T00:00:00Z").unwrap();
    match c.resolve("Moon", jd) {
        Err(EphemerisError::OutOfCoverage {
            provider, coverage, ..
        }) => {
            assert_eq!(provider, "FixturePackProvider[test-pack]");
            assert!(coverage.starts_with("Moon"), "{coverage}");
        }
        other => panic!("expected the pack's OutOfCoverage, got {other:?}"),
    }

    // Order must not change which failure is reported.
    let reversed = CompositeProvider::new("reversed")
        .with(pack())
        .with(SunProvider::new());
    assert!(matches!(
        reversed.resolve("Moon", jd),
        Err(EphemerisError::OutOfCoverage { .. })
    ));
}

#[test]
fn an_empty_composite_refuses_everything_and_says_so() {
    let c = CompositeProvider::new("empty");
    assert!(c.provider_names().is_empty());
    let jd = parse_utc("2026-10-01T06:30:00Z").unwrap();
    match c.resolve("Sun", jd) {
        Err(EphemerisError::UnknownBody(body, provider)) => {
            assert_eq!(body, "Sun");
            assert!(provider.contains("no providers configured"), "{provider}");
        }
        other => panic!("expected UnknownBody, got {other:?}"),
    }
    let cov = c.coverage();
    assert!(cov.bodies.is_empty());
    assert!(cov.start_utc.is_empty() && cov.end_utc.is_empty());
}

/// The composite's coverage is the union of its parts, and it says plainly that a time
/// inside the envelope can still be outside the provider a given body needs.
#[test]
fn coverage_is_the_union_and_says_what_the_envelope_means() {
    let c = composite();
    let cov = c.coverage();
    assert_eq!(cov.bodies, vec!["Sun".to_string(), "Moon".to_string()]);
    assert_eq!(cov.start_utc, "1990-01-01T00:00:00.000Z");
    assert_eq!(cov.end_utc, "2061-01-01T00:00:00.000Z");
    assert!(cov.notes.contains("SunProvider"));
    assert!(cov.notes.contains("FixturePackProvider[test-pack]"));
    assert!(
        cov.notes.contains("envelope"),
        "the union has to be labelled as an envelope: {}",
        cov.notes
    );
    // The worst of the parts, not the best.
    let worst = SunProvider::new()
        .coverage()
        .accuracy_arcmin
        .max(pack().coverage().accuracy_arcmin);
    assert_eq!(cov.accuracy_arcmin, worst);
    // "Sun" appears once even though two providers carry it.
    assert_eq!(cov.bodies.iter().filter(|b| *b == "Sun").count(), 1);
}

/// `push` and `with` build the same thing, so a composite can also be assembled at
/// runtime from a list of boxed providers.
#[test]
fn push_and_with_agree() {
    let mut a = CompositeProvider::new("x");
    a.push(Box::new(SunProvider::new()));
    a.push(Box::new(pack()));
    let b = composite();
    assert_eq!(a.provider_names(), b.provider_names());
    let jd = parse_utc("2026-10-01T06:30:00Z").unwrap();
    for body in ["Sun", "Moon"] {
        assert_eq!(a.resolve(body, jd).unwrap(), b.resolve(body, jd).unwrap());
    }
}
