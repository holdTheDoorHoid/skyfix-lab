//! Loading, validating and querying a `skyfix.almanac_pack/1` document.

use std::collections::BTreeMap;

use skyfix_core::time::parse_utc;
use skyfix_ephemeris::fixture_pack::{
    ALMANAC_PACK_SCHEMA, AlmanacPack, BodyTable, FixturePackProvider, LIMITED_DATE_NOTE,
};
use skyfix_ephemeris::{AstroProvider, EphemerisError};

const START: &str = "2026-10-01T00:00:00Z";

/// A small, well-formed pack: the Moon hourly for six hours, Venus every two hours.
fn sample_pack() -> AlmanacPack {
    let mut bodies = BTreeMap::new();
    bodies.insert(
        "Moon".to_string(),
        BodyTable {
            step_s: 3600.0,
            start_utc: START.to_string(),
            rows: (0..7)
                .map(|i| {
                    let t = f64::from(i);
                    [
                        (100.0 + 14.4921 * t).rem_euclid(360.0),
                        10.0 + 0.2 * t,
                        15.0 + 0.01 * t,
                        55.0 + 0.04 * t,
                    ]
                })
                .collect(),
        },
    );
    bodies.insert(
        "Venus".to_string(),
        BodyTable {
            step_s: 7200.0,
            start_utc: START.to_string(),
            rows: (0..4)
                .map(|i| {
                    let t = f64::from(i) * 2.0;
                    [
                        (200.0 + 15.0 * t).rem_euclid(360.0),
                        -5.0 - 0.1 * t,
                        0.0,
                        0.0,
                    ]
                })
                .collect(),
        },
    );
    AlmanacPack {
        schema: ALMANAC_PACK_SCHEMA.to_string(),
        provider: "test-pack-2026".to_string(),
        generator: serde_json::json!({"tool": "hand-written test fixture", "ephemeris": "none"}),
        bodies,
        notes: "synthetic, for tests only".to_string(),
    }
}

fn load(pack: &AlmanacPack) -> FixturePackProvider {
    let json = serde_json::to_string(pack).unwrap();
    FixturePackProvider::from_json(&json).unwrap()
}

#[test]
fn pack_round_trips_through_json_and_answers_on_its_grid() {
    let pack = sample_pack();
    let p = load(&pack);

    // The document survives a round trip. NOTE: not bit-exact. serde_json 1.0.151
    // parses some shortest-round-trip float literals 1 ULP off (186.95260000000002
    // comes back as 186.9526), so this compares at 1e-15 relative, which is four
    // orders of magnitude tighter than anything this crate claims and still catches
    // a genuine serialisation bug.
    let json = serde_json::to_string(&pack).unwrap();
    let back: AlmanacPack = serde_json::from_str(&json).unwrap();
    assert_eq!(back.schema, pack.schema);
    assert_eq!(back.provider, pack.provider);
    assert_eq!(back.generator, pack.generator);
    assert_eq!(back.notes, pack.notes);
    assert_eq!(
        back.bodies.keys().collect::<Vec<_>>(),
        pack.bodies.keys().collect::<Vec<_>>()
    );
    for (name, table) in &pack.bodies {
        let b = &back.bodies[name];
        assert_eq!(b.step_s, table.step_s);
        assert_eq!(b.start_utc, table.start_utc);
        assert_eq!(b.rows.len(), table.rows.len());
        for (i, (x, y)) in b.rows.iter().zip(&table.rows).enumerate() {
            for c in 0..4 {
                assert!(
                    (x[c] - y[c]).abs() <= 1e-15 * y[c].abs().max(1.0),
                    "{name} row {i} column {c}: {} != {}",
                    x[c],
                    y[c]
                );
            }
        }
    }

    // Exactly on a grid point, interpolation must return the tabulated row. The
    // tolerance is 1e-6 deg (2e-5 arcmin) because a Julian date in one f64 resolves
    // only about 40 microseconds, which is 1.7e-7 deg of hour angle; `skyfix_core::time`
    // records the same limit.
    let start = parse_utc(START).unwrap();
    for i in 0..7 {
        let row = pack.bodies["Moon"].rows[i];
        let d = p.geocentric("Moon", start + i as f64 / 24.0).unwrap();
        assert!(
            (d.gha_deg - row[0]).abs() < 1e-6,
            "row {i}: GHA {} != tabulated {}",
            d.gha_deg,
            row[0]
        );
        assert!((d.dec_deg - row[1]).abs() < 1e-6);
        assert!((d.semidiameter_arcmin - row[2]).abs() < 1e-6);
        assert!((d.horizontal_parallax_arcmin - row[3]).abs() < 1e-6);
    }
}

#[test]
fn body_names_are_case_insensitive_and_unknown_bodies_are_refused() {
    let p = load(&sample_pack());
    let jd = parse_utc("2026-10-01T02:30:00Z").unwrap();
    for name in ["Moon", "moon", "MOON"] {
        assert!(p.geocentric(name, jd).is_ok(), "{name} should resolve");
    }
    match p.geocentric("Mars", jd) {
        Err(EphemerisError::UnknownBody(body, provider)) => {
            assert_eq!(body, "Mars");
            assert_eq!(provider, "FixturePackProvider[test-pack-2026]");
        }
        other => panic!("expected UnknownBody, got {other:?}"),
    }
}

#[test]
fn refuses_outside_the_tabulated_range_and_names_that_range() {
    let p = load(&sample_pack());
    let start = parse_utc(START).unwrap();

    // The Moon table ends six hours in; Venus's ends six hours in as well but on a
    // two-hour grid, so both share an end. Test one second past each end.
    for (body, end_offset_days) in [("Moon", 6.0 / 24.0), ("Venus", 6.0 / 24.0)] {
        assert!(p.geocentric(body, start).is_ok(), "{body} start is inside");
        assert!(
            p.geocentric(body, start + end_offset_days).is_ok(),
            "{body} end is inside"
        );
        for jd in [
            start - 1.0 / 86_400.0,
            start + end_offset_days + 1.0 / 86_400.0,
        ] {
            match p.geocentric(body, jd) {
                Err(EphemerisError::OutOfCoverage {
                    provider,
                    jd_utc,
                    coverage,
                }) => {
                    assert_eq!(provider, "FixturePackProvider[test-pack-2026]");
                    assert_eq!(jd_utc, jd);
                    assert!(
                        coverage.starts_with(body),
                        "the refusal must name the body whose range applied: {coverage}"
                    );
                    assert!(
                        coverage.contains("2026-10-01T00:00:00")
                            && coverage.contains("2026-10-01T06:00:00"),
                        "the refusal must name the range: {coverage}"
                    );
                }
                other => panic!("expected OutOfCoverage for {body} at {jd}, got {other:?}"),
            }
        }
    }
    assert!(matches!(
        p.geocentric("Moon", f64::NAN),
        Err(EphemerisError::Data(_))
    ));
}

#[test]
fn coverage_says_limited_date_verbatim_and_lists_every_body_and_range() {
    let p = load(&sample_pack());
    let c = p.coverage();
    assert!(
        c.notes.contains(LIMITED_DATE_NOTE),
        "the fallback must be labelled {LIMITED_DATE_NOTE:?} verbatim: {}",
        c.notes
    );
    assert_eq!(c.notes.matches("limited-date operation").count(), 1);
    assert_eq!(c.bodies, vec!["Moon".to_string(), "Venus".to_string()]);
    assert!(c.notes.contains("Moon 2026-10-01T00:00:00"));
    assert!(c.notes.contains("Venus 2026-10-01T00:00:00"));
    assert!(c.notes.contains("every 3600 s") && c.notes.contains("every 7200 s"));
    assert!(c.notes.contains("synthetic, for tests only"));
    assert_eq!(c.start_utc, "2026-10-01T00:00:00.000Z");
    assert_eq!(c.end_utc, "2026-10-01T06:00:00.000Z");
    assert_eq!(p.bodies(), vec!["Moon".to_string(), "Venus".to_string()]);
    assert_eq!(
        p.body_range("moon"),
        Some((
            "2026-10-01T00:00:00.000Z".to_string(),
            "2026-10-01T06:00:00.000Z".to_string()
        ))
    );
    assert_eq!(p.body_range("Mars"), None);
    assert_eq!(p.generator()["tool"], "hand-written test fixture");
}

#[test]
fn malformed_packs_are_refused_with_a_message_that_says_what_is_wrong() {
    /// A way to break a pack, and the word its refusal must contain.
    type Case = (Box<dyn Fn(&mut AlmanacPack)>, &'static str);

    let cases: Vec<Case> = vec![
        (
            Box::new(|p: &mut AlmanacPack| p.schema = "skyfix.almanac_pack/2".into()),
            "schema",
        ),
        (
            Box::new(|p: &mut AlmanacPack| p.bodies.clear()),
            "no bodies",
        ),
        (
            Box::new(|p: &mut AlmanacPack| {
                p.bodies.get_mut("Moon").unwrap().rows.clear();
            }),
            "no rows",
        ),
        (
            Box::new(|p: &mut AlmanacPack| p.bodies.get_mut("Moon").unwrap().step_s = 0.0),
            "step_s",
        ),
        (
            Box::new(|p: &mut AlmanacPack| p.bodies.get_mut("Moon").unwrap().step_s = -60.0),
            "step_s",
        ),
        (
            Box::new(|p: &mut AlmanacPack| {
                p.bodies.get_mut("Moon").unwrap().start_utc = "not a timestamp".into();
            }),
            "start_utc",
        ),
        (
            Box::new(|p: &mut AlmanacPack| {
                p.bodies.get_mut("Moon").unwrap().start_utc = "2026-10-01T00:00:00+00:00".into();
            }),
            "start_utc",
        ),
        (
            Box::new(|p: &mut AlmanacPack| {
                p.bodies.get_mut("Moon").unwrap().rows[2][0] = f64::NAN;
            }),
            "non-finite",
        ),
        (
            Box::new(|p: &mut AlmanacPack| {
                p.bodies.get_mut("Moon").unwrap().rows[2][1] = 91.0;
            }),
            "declination",
        ),
        (
            Box::new(|p: &mut AlmanacPack| {
                p.bodies.get_mut("Moon").unwrap().rows[2][2] = -1.0;
            }),
            "negative semidiameter",
        ),
    ];
    for (mutate, needle) in cases {
        let mut pack = sample_pack();
        mutate(&mut pack);
        // Validate through `from_pack`, not `from_json`: JSON cannot carry a NaN
        // (serde_json writes it as `null`), so the non-finite case would otherwise be
        // caught by the parser rather than by the validator under test.
        match FixturePackProvider::from_pack(&pack) {
            Err(EphemerisError::Data(msg)) => assert!(
                msg.contains(needle),
                "expected the message to mention {needle:?}, got {msg:?}"
            ),
            other => panic!("expected a Data error mentioning {needle:?}, got {other:?}"),
        }
        // Everything except the NaN case must be caught on the JSON path too.
        if needle != "non-finite" {
            let json = serde_json::to_string(&pack).unwrap();
            assert!(
                matches!(
                    FixturePackProvider::from_json(&json),
                    Err(EphemerisError::Data(_))
                ),
                "the JSON path should also refuse the {needle:?} case"
            );
        }
    }
    // Not JSON at all, and JSON of the wrong shape.
    for bad in [
        "{nope",
        "[]",
        "null",
        r#"{"schema":"skyfix.almanac_pack/1"}"#,
    ] {
        assert!(
            matches!(
                FixturePackProvider::from_json(bad),
                Err(EphemerisError::Data(_))
            ),
            "{bad:?} should be refused"
        );
    }
}

/// A one-row table is legal: it covers a single instant and refuses everything else.
#[test]
fn a_single_row_table_covers_exactly_one_instant() {
    let mut bodies = BTreeMap::new();
    bodies.insert(
        "Moon".to_string(),
        BodyTable {
            step_s: 3600.0,
            start_utc: START.to_string(),
            rows: vec![[12.0, 34.0, 15.5, 57.0]],
        },
    );
    let pack = AlmanacPack {
        schema: ALMANAC_PACK_SCHEMA.to_string(),
        provider: "single".to_string(),
        generator: serde_json::Value::Null,
        bodies,
        notes: String::new(),
    };
    let p = load(&pack);
    let jd = parse_utc(START).unwrap();
    let d = p.geocentric("Moon", jd).unwrap();
    assert_eq!(d.gha_deg, 12.0);
    assert_eq!(d.dec_deg, 34.0);
    assert!(p.geocentric("Moon", jd + 1e-6).is_err());
    assert!(!p.uses_cubic("Moon", jd));
}

/// Two and three rows are enough for linear interpolation but never for the 4-point
/// stencil; the provider must say so rather than silently reaching past the table.
#[test]
fn short_tables_fall_back_to_linear_everywhere() {
    for n in 2u32..=3 {
        let mut bodies = BTreeMap::new();
        bodies.insert(
            "Moon".to_string(),
            BodyTable {
                step_s: 3600.0,
                start_utc: START.to_string(),
                rows: (0..n)
                    .map(|i| [f64::from(i) * 10.0, f64::from(i), 15.0, 55.0])
                    .collect(),
            },
        );
        let pack = AlmanacPack {
            schema: ALMANAC_PACK_SCHEMA.to_string(),
            provider: format!("rows-{n}"),
            generator: serde_json::Value::Null,
            bodies,
            notes: String::new(),
        };
        let p = load(&pack);
        let jd = parse_utc(START).unwrap() + 0.5 / 24.0;
        assert!(
            !p.uses_cubic("Moon", jd),
            "{n} rows cannot use a 4-point stencil"
        );
        let d = p.geocentric("Moon", jd).unwrap();
        assert!(
            (d.gha_deg - 5.0).abs() < 1e-6,
            "linear midpoint, got {}",
            d.gha_deg
        );
    }
}

/// The 4-point stencil is used in the interior and the linear fallback at the ends;
/// `uses_cubic` reports which, so a caller can widen its error budget at the ends.
#[test]
fn cubic_in_the_interior_linear_at_the_ends() {
    let p = load(&sample_pack());
    let start = parse_utc(START).unwrap();
    // Seven rows (0..6 h). Intervals: [0,1] and [5,6] are linear, [1,5] cubic.
    let h = |x: f64| start + x / 24.0;
    assert!(!p.uses_cubic("Moon", h(0.5)));
    assert!(p.uses_cubic("Moon", h(1.5)));
    assert!(p.uses_cubic("Moon", h(3.5)));
    assert!(p.uses_cubic("Moon", h(4.5)));
    assert!(!p.uses_cubic("Moon", h(5.5)));
}
