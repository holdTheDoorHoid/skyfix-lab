//! Planet events against Skyfield + JPL DE440s (`planet_events_skyfield.json`: every
//! opposition, conjunction, greatest elongation and closest approach of 1990-2060) and
//! NASA's SKYCAL Sky Events Calendar (`planet_events_nasa_skycal.json`, a published U.S.
//! Government source for the same kinds of events, without perigees).
//!
//! SKYCAL is an approximate calendar: its instants differ from DE440s by a median of 10
//! to 30 minutes and at most 4.4 hours (its generator evidently uses mean-orbit
//! formulas). It is used for what it is good for — the same events, of the same kinds,
//! on the same days, with the same greatest elongations to its 0.1 degree — while
//! DE440s sets the timing bar.
//!
//! The default run covers 2019-2026; `-- --ignored` (release) covers 1990-2060.

use serde::Deserialize;
use skyfix_almanac::planet_events::{PlanetEvent, PlanetEventKind, planet_events};
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::planets::PlanetProvider;

fn read(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is committed: {e}", path.display()))
}

#[derive(Debug, Deserialize)]
struct SkyfieldFile {
    events: Vec<SkyfieldEvent>,
}

#[derive(Debug, Deserialize)]
struct SkyfieldEvent {
    body: String,
    kind: String,
    jd_utc: f64,
    elongation_deg: f64,
    distance_au: f64,
    #[serde(default)]
    transit: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SkycalFile {
    events: Vec<SkycalEvent>,
}

#[derive(Debug, Deserialize)]
struct SkycalEvent {
    body: String,
    kind: String,
    jd: f64,
    #[serde(default)]
    elongation_deg: Option<f64>,
}

fn kind_name(k: PlanetEventKind) -> &'static str {
    match k {
        PlanetEventKind::Opposition => "opposition",
        PlanetEventKind::Conjunction => "conjunction",
        PlanetEventKind::InferiorConjunction => "inferior_conjunction",
        PlanetEventKind::SuperiorConjunction => "superior_conjunction",
        PlanetEventKind::GreatestElongationEast => "greatest_elongation_east",
        PlanetEventKind::GreatestElongationWest => "greatest_elongation_west",
        PlanetEventKind::Perigee => "perigee",
    }
}

fn extremum(kind: &str) -> bool {
    kind.starts_with("greatest") || kind == "perigee"
}

/// The nearest of `ours` with the same body and kind.
fn nearest<'a>(
    ours: &'a [PlanetEvent],
    body: &str,
    kind: &str,
    jd: f64,
) -> Option<&'a PlanetEvent> {
    ours.iter()
        .filter(|e| e.body == body && kind_name(e.kind) == kind)
        .min_by(|a, b| (a.jd_utc - jd).abs().total_cmp(&(b.jd_utc - jd).abs()))
}

#[derive(Default, Debug)]
struct Worst {
    root_s: f64,
    root_at: String,
    extremum_s: f64,
    extremum_at: String,
    elongation_deg: f64,
    elongation_at: String,
    distance_km: f64,
    distance_at: String,
    distance_rel: f64,
}

fn compare(from: (i32, u32, u32), to: (i32, u32, u32)) {
    let (a, b) = (
        civil_to_jd(from.0, from.1, from.2),
        civil_to_jd(to.0, to.1, to.2),
    );
    let t0 = std::time::Instant::now();
    let list = planet_events(&PlanetProvider::new(), a, b).unwrap();
    let elapsed = t0.elapsed();
    let ours = &list.events;

    // --- Skyfield + DE440s: the same events, one for one.
    let sky: SkyfieldFile =
        serde_json::from_str(&read("fixtures/reference/planet_events_skyfield.json")).unwrap();
    let theirs: Vec<&SkyfieldEvent> = sky
        .events
        .iter()
        .filter(|e| e.jd_utc >= a && e.jd_utc <= b)
        .collect();
    let mut w = Worst::default();
    let mut used = vec![false; ours.len()];
    for t in &theirs {
        let e = nearest(ours, &t.body, &t.kind, t.jd_utc)
            .unwrap_or_else(|| panic!("no {} {} near JD {}", t.body, t.kind, t.jd_utc));
        let i = ours.iter().position(|x| std::ptr::eq(x, e)).unwrap();
        assert!(!used[i], "{} {} matched twice", t.body, t.kind);
        used[i] = true;
        let dt = (e.jd_utc - t.jd_utc) * 86_400.0;
        let at = format!("{} {} {}", t.body, t.kind, &e.utc[..16]);
        if extremum(&t.kind) {
            if dt.abs() > w.extremum_s.abs() {
                w.extremum_s = dt;
                w.extremum_at = at;
            }
        } else if dt.abs() > w.root_s.abs() {
            w.root_s = dt;
            w.root_at = at;
        }
        // The elongation and distance at the reference's own instant are what the two
        // ephemerides say about the same moment; comparing them at slightly different
        // instants would mostly measure the instants.
        if t.kind.starts_with("greatest") {
            let d = (e.elongation_deg - t.elongation_deg).abs();
            if d > w.elongation_deg {
                w.elongation_deg = d;
                w.elongation_at = format!("{} {} {}", t.body, t.kind, &e.utc[..16]);
            }
        }
        if t.kind == "perigee" {
            let d = (e.distance_au - t.distance_au).abs() * 149_597_870.7;
            if d > w.distance_km {
                w.distance_km = d;
                w.distance_at = format!("{} {}", t.body, &e.utc[..16]);
            }
            w.distance_rel = w
                .distance_rel
                .max((e.distance_au / t.distance_au - 1.0).abs());
        }
        if let Some(tr) = t.transit {
            assert_eq!(e.transit, tr, "{} transit at {}", t.body, e.utc);
        }
    }
    let extra: Vec<&PlanetEvent> = ours
        .iter()
        .zip(&used)
        .filter(|(_, u)| !**u)
        .map(|(e, _)| e)
        .collect();
    assert!(
        extra.is_empty(),
        "events Skyfield does not have: {extra:#?}"
    );

    // --- NASA SKYCAL: the same events on the same days.
    let nasa: SkycalFile =
        serde_json::from_str(&read("fixtures/reference/planet_events_nasa_skycal.json")).unwrap();
    let (mut worst_nasa_s, mut worst_nasa_elong, mut n_nasa) = (0.0f64, 0.0f64, 0);
    for r in nasa
        .events
        .iter()
        .filter(|r| r.jd >= a + 0.5 && r.jd <= b - 0.5)
    {
        let e = nearest(ours, &r.body, &r.kind, r.jd)
            .unwrap_or_else(|| panic!("no {} {} near SKYCAL JD {}", r.body, r.kind, r.jd));
        let dt = (e.jd_utc - r.jd) * 86_400.0;
        assert!(
            dt.abs() < 6.0 * 3600.0,
            "{} {} {}: {dt} s from SKYCAL",
            r.body,
            r.kind,
            e.utc
        );
        worst_nasa_s = worst_nasa_s.max(dt.abs());
        if let Some(el) = r.elongation_deg {
            worst_nasa_elong = worst_nasa_elong.max((e.elongation_deg - el).abs());
        }
        n_nasa += 1;
    }
    let ours_no_perigee = ours
        .iter()
        .filter(|e| {
            e.kind != PlanetEventKind::Perigee && e.jd_utc >= a + 0.5 && e.jd_utc <= b - 0.5
        })
        .count();
    assert_eq!(
        n_nasa, ours_no_perigee,
        "SKYCAL lists the same events (perigees aside)"
    );

    println!(
        "{}-{}: {} events in {:?}; against DE440s: conjunctions and oppositions within \
         {:.1} s ({}), greatest elongations and closest approaches within {:.1} s ({}); \
         greatest elongations within {:.5} deg ({}), closest distances within {:.0} km ({}, \
         {:.1e} relative). \
         Against NASA SKYCAL ({} events): within {:.1} h, elongations within {:.2} deg.",
        from.0,
        to.0 - 1,
        ours.len(),
        elapsed,
        w.root_s,
        w.root_at,
        w.extremum_s,
        w.extremum_at,
        w.elongation_deg,
        w.elongation_at,
        w.distance_km,
        w.distance_at,
        w.distance_rel,
        n_nasa,
        worst_nasa_s / 3600.0,
        worst_nasa_elong
    );
    // Targets (the fixture's `tolerances`): conjunctions and oppositions 1 min, as
    // CONVENTIONS 13.7 asks of the Moon's phases; greatest elongations and closest
    // approaches 10 min, because an extremum is flat (Venus's elongation changes by under
    // 0.001 degree in the 12 hours either side of its greatest).
    assert!(w.root_s.abs() < 60.0, "{w:?}");
    assert!(w.extremum_s.abs() < 600.0, "{w:?}");
    assert!(w.elongation_deg < 0.001, "{w:?}");
    // Distances: the planets' target in docs/ACCURACY.md section 2, 1e-5 relative.
    assert!(w.distance_rel < 1e-5, "{w:?}");
    // SKYCAL prints elongations to 0.1 degree.
    assert!(worst_nasa_elong <= 0.1 + 1e-9, "{worst_nasa_elong}");
}

#[test]
fn planet_events_2019_2026_against_de440s_and_nasa() {
    compare((2019, 1, 1), (2027, 1, 1));
}

/// The whole window in a release build: `cargo test --release -p skyfix-almanac --test
/// planet_events -- --ignored --nocapture`.
#[test]
#[ignore]
fn planet_events_1990_2060_against_de440s_and_nasa() {
    compare((1990, 1, 1), (2061, 1, 1));
}

/// Every transit of Mercury and Venus of 1990-2060, as NASA's transit catalogues list them
/// (Espenak, "Seven Century Catalog of Mercury Transits: 1601 CE to 2300 CE" and "Six
/// Millennium Catalog of Venus Transits", <https://eclipse.gsfc.nasa.gov/transit/catalog/
/// MercuryCatalog.html> and `VenusCatalog.html`, retrieved 2026-09-24; a U.S. Government
/// work): the date is the catalogue's (of the first contact, UT), and ours is the date of
/// the inferior conjunction flagged as a transit, which is the same or the next day.
#[test]
fn the_transits_are_those_of_nasas_catalogues() {
    let nasa = [
        ("Mercury", 1993, 11, 6),
        ("Mercury", 1999, 11, 15),
        ("Venus", 2004, 6, 8),
        ("Mercury", 2003, 5, 7),
        ("Mercury", 2006, 11, 8),
        ("Venus", 2012, 6, 6),
        ("Mercury", 2016, 5, 9),
        ("Mercury", 2019, 11, 11),
        ("Mercury", 2032, 11, 13),
        ("Mercury", 2039, 11, 7),
        ("Mercury", 2049, 5, 7),
        ("Mercury", 2052, 11, 9),
    ];
    let list = planet_events(
        &PlanetProvider::new(),
        civil_to_jd(1990, 1, 1),
        civil_to_jd(2061, 1, 1),
    )
    .unwrap();
    let ours: Vec<&PlanetEvent> = list.events.iter().filter(|e| e.transit).collect();
    assert_eq!(ours.len(), nasa.len(), "{ours:#?}");
    for (body, y, m, d) in nasa {
        let day = civil_to_jd(y, m, d);
        assert!(
            ours.iter().any(|e| e.body == body
                && e.kind == PlanetEventKind::InferiorConjunction
                && e.jd_utc >= day
                && e.jd_utc < day + 2.0),
            "no transit of {body} on {y}-{m:02}-{d:02}"
        );
    }
}
