//! End-to-end tests of `skyfix eclipses`, `skyfix eclipse` and `skyfix planet-events`.
//! OWNER: cli agent.
//!
//! As in `explorer.rs`, each command's `--format json` must be exactly what the library
//! function it wraps returns for the same inputs — `skyfix_almanac::eclipses::Eclipses`
//! (`find`, `by_id`, `local`, `path`) and `skyfix_almanac::planet_events::planet_events`
//! — so every JSON test calls that function directly and compares, number by number. The
//! eclipse engine itself is validated against NASA's canon, USNO and Skyfield where it
//! lives (docs/ACCURACY.md sections 12-13); these tests check what the commands add: the
//! flags, the filters, the text, the GeoJSON and the exit codes.

mod support;

use serde_json::Value;
use skyfix_almanac::eclipses::{Eclipse, EclipseLocal, EclipsePath, Eclipses, LocalEventKind};
use skyfix_almanac::planet_events::planet_events;
use skyfix_core::time::parse_utc;
use skyfix_ephemeris::planets::PlanetProvider;
use skyfix_ephemeris::topocentric::Site;
use support::skyfix;

/// Numbers may differ by this much between the binary and the library call.
const JSON_TOLERANCE: f64 = 1e-9;

fn assert_same<T: serde::Serialize>(cli: &Value, library: &T, what: &str) {
    let want = serde_json::to_value(library).expect("the library result serialises");
    if let Err(e) = support::json_close(cli, &want, JSON_TOLERANCE, what) {
        panic!("{what}: the CLI's JSON is not the library's result: {e}");
    }
}

fn jd(utc: &str) -> f64 {
    parse_utc(utc).expect("a test instant")
}

/// `v` without the keys the command adds beside the engine's own document.
fn without(mut v: Value, keys: &[&str]) -> Value {
    let o = v.as_object_mut().expect("a JSON object");
    for k in keys {
        o.remove(*k);
    }
    v
}

/// Dallas, as the brief gives it: 32.78 N, 96.80 W, on the ellipsoid.
const DALLAS: [&str; 4] = ["--lat", "32.78", "--lon", "-96.80"];

fn dallas() -> Site {
    Site {
        lat_deg: 32.78,
        lon_deg: -96.80,
        ..Site::default()
    }
}

fn run(args: &[&str]) -> support::Run {
    skyfix(args)
}

// ---------------------------------------------------------------------------
// eclipses
// ---------------------------------------------------------------------------

/// The listing for 2024-2026 is the library's: every eclipse, in time order, number for
/// number, and the twelve that NASA's canon lists for those years.
#[test]
fn the_2024_to_2026_listing_is_the_librarys() {
    let v = run(&[
        "eclipses",
        "--from",
        "2024-01-01",
        "--to",
        "2026-12-31",
        "--format",
        "json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(v["kinds"], serde_json::json!(["solar", "lunar"]));
    assert!(
        v.get("local").is_none(),
        "no observer, no local circumstances"
    );
    let want = Eclipses::new()
        .find(jd("2024-01-01T00:00:00Z"), jd("2027-01-01T00:00:00Z"))
        .expect("the library's list");
    assert_same(&without(v, &["kinds"]), &want, "eclipses 2024-2026");
    let ids: Vec<&str> = want.eclipses.iter().map(Eclipse::id).collect();
    assert_eq!(
        ids,
        [
            "2024-03-25-lunar",
            "2024-04-08-solar",
            "2024-09-18-lunar",
            "2024-10-02-solar",
            "2025-03-14-lunar",
            "2025-03-29-solar",
            "2025-09-07-lunar",
            "2025-09-21-solar",
            "2026-02-17-solar",
            "2026-03-03-lunar",
            "2026-08-12-solar",
            "2026-08-28-lunar",
        ]
    );
    assert!(!want.truncated);
}

#[test]
fn kind_keeps_the_librarys_own_eclipses_of_that_kind() {
    let lib = Eclipses::new()
        .find(jd("2024-01-01T00:00:00Z"), jd("2027-01-01T00:00:00Z"))
        .expect("the library's list");
    for (kind, solar) in [("solar", true), ("lunar", false)] {
        let v = run(&[
            "eclipses",
            "--from",
            "2024-01-01",
            "--to",
            "2026-12-31",
            "--kind",
            kind,
            "--json",
        ])
        .expect_code(0)
        .json();
        assert_eq!(v["kinds"], serde_json::json!([kind]));
        let mut want = lib.clone();
        want.eclipses
            .retain(|e| matches!(e, Eclipse::Solar(_)) == solar);
        assert_eq!(want.eclipses.len(), 6);
        assert_same(&without(v, &["kinds"]), &want, kind);
    }
    run(&[
        "eclipses",
        "--from",
        "2024-01-01",
        "--to",
        "2024-12-31",
        "--kind",
        "comet",
    ])
    .expect_code(1);
}

/// With an observer, `local` is `Eclipses::local` for each listed eclipse, in order.
#[test]
fn an_observer_adds_the_librarys_local_circumstances_for_each_eclipse() {
    let mut args = vec!["eclipses", "--from", "2024-01-01", "--to", "2024-12-31"];
    args.extend_from_slice(&DALLAS);
    args.extend_from_slice(&["--format", "json"]);
    let v = run(&args).expect_code(0).json();
    let engine = Eclipses::new();
    let list = engine
        .find(jd("2024-01-01T00:00:00Z"), jd("2025-01-01T00:00:00Z"))
        .expect("the list");
    let local: Vec<EclipseLocal> = list
        .eclipses
        .iter()
        .map(|e| {
            engine
                .local(e.id(), &dallas())
                .expect("local circumstances")
        })
        .collect();
    assert_eq!(local.len(), 4);
    assert_same(&v["local"], &local, "local circumstances");
    assert_same(&without(v, &["kinds", "local"]), &list, "the list itself");
}

#[test]
fn the_listing_text_has_one_row_per_eclipse_and_says_what_dallas_sees() {
    let mut args = vec!["eclipses", "--from", "2024-01-01", "--to", "2026-12-31"];
    args.extend_from_slice(&DALLAS);
    run(&args)
        .expect_code(0)
        .expect_stdout("ECLIPSES  2024-01-01T00:00:00Z to 2027-01-01T00:00:00Z, solar and lunar")
        .expect_stdout("Observer  32 46.80' N, 096 48.00' W (32.780000, -96.800000)")
        .expect_stdout(
            "  2024-04-08-solar  total      2024-04-08T18:17:20Z   1.0566        -  +0.3431    139",
        )
        .expect_stdout(
            "  2025-03-14-lunar  total      2025-03-14T06:58:46Z   1.1784   2.2595  +0.3484    123",
        )
        .expect_stdout_flat("here: total for 3 min 51 s, with the Sun up throughout")
        .expect_stdout_flat("here: no eclipse: the Moon's shadow misses this place")
        .expect_stdout_flat("here: partly seen: the Moon sets at 2026-03-03T12:55:56Z")
        .expect_stdout_flat("12 eclipses in the window: 6 solar, 6 lunar.")
        .expect_stdout_flat("Seen from the observer, in whole or in part: 6 of 12.");
}

#[test]
fn eclipse_windows_are_checked_and_clipped_to_the_coverage() {
    run(&["eclipses", "--from", "2025-01-01", "--to", "2024-01-01"])
        .expect_code(1)
        .expect_stderr("--to must come after --from");
    run(&["eclipses", "--from", "1980-01-01", "--to", "1985-12-31"])
        .expect_code(1)
        .expect_stderr("outside the eclipses' coverage, 1990-01-01T00:00:00Z");
    // Reaching past the coverage clips the window and says so, and still lists what is in it.
    let r = run(&["eclipses", "--from", "1989-06-01", "--to", "1990-12-31"])
        .expect_code(0)
        .expect_stderr("clipped")
        .expect_stdout("Coverage  the window was clipped to the eclipses' coverage");
    assert!(r.stdout.contains("1990-01-26-solar"), "{}", r.stdout);
    let v = run(&[
        "eclipses",
        "--from",
        "1989-06-01",
        "--to",
        "1990-12-31",
        "--json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(v["truncated"], true);
    // A latitude needs a longitude.
    run(&[
        "eclipses",
        "--from",
        "2024-01-01",
        "--to",
        "2024-12-31",
        "--lat",
        "32.78",
    ])
    .expect_code(1);
}

// ---------------------------------------------------------------------------
// eclipse
// ---------------------------------------------------------------------------

/// The acceptance case: the total eclipse of 2024-04-08 from Dallas (32.78 N, 96.80 W).
/// The printed contacts are the library's to the second, and totality is 3 min 51 s.
///
/// At these coordinates the library puts second contact at 18:40:43.33 and third at
/// 18:44:33.94, so the report prints 18:40:43 to 18:44:34. The brief's "18:40:42" is the
/// web UI's Dallas (its gazetteer's 32.7767 N, 96.797 W, where the library gives
/// 18:40:42.98) read to the whole second below; the test pins the printed values to the
/// library's within 1 s and to the brief's within 1.5 s, and says so rather than hide it.
#[test]
fn dallas_sees_3_min_51_s_of_totality_the_library_to_the_second() {
    let mut args = vec!["eclipse", "2024-04-08-solar"];
    args.extend_from_slice(&DALLAS);
    let text = run(&args).expect_code(0);
    let json = {
        let mut a = args.clone();
        a.push("--json");
        run(&a).expect_code(0).json()
    };
    let engine = Eclipses::new();
    let local = engine
        .local("2024-04-08-solar", &dallas())
        .expect("local circumstances");
    assert_same(&json["local"], &local, "Dallas");
    let EclipseLocal::Solar(l) = &local else {
        panic!("a solar eclipse")
    };
    let at = |k: LocalEventKind| {
        l.events
            .iter()
            .find(|e| e.kind == k)
            .expect("the contact")
            .jd_utc
    };
    let (c2, c3) = (at(LocalEventKind::C2), at(LocalEventKind::C3));

    // The text's totality line, parsed back and set against the library.
    let line = text
        .stdout
        .lines()
        .find(|l| l.starts_with("Totality   "))
        .expect("a totality line");
    let parts: Vec<&str> = line.split_whitespace().collect();
    // "Totality 2024-04-08T18:40:43Z to 2024-04-08T18:44:34Z, 3 min 51 s"
    let (p2, p3) = (jd(parts[1]), jd(parts[3].trim_end_matches(',')));
    for (printed, lib, brief, what) in [
        (p2, c2, "2024-04-08T18:40:42Z", "second contact"),
        (p3, c3, "2024-04-08T18:44:34Z", "third contact"),
    ] {
        let from_library = (printed - lib).abs() * 86_400.0;
        assert!(
            from_library <= 0.5 + 1e-3,
            "{what}: printed {from_library} s from the library"
        );
        let from_brief = (printed - jd(brief)).abs() * 86_400.0;
        assert!(from_brief <= 1.5, "{what}: {from_brief} s from the brief");
    }
    assert!(line.ends_with("3 min 51 s"), "{line}");
    assert!((l.central_duration_s.expect("a central phase") - 231.0).abs() < 1.0);
    text.expect_stdout("TOTAL SOLAR ECLIPSE  2024-04-08-solar")
        .expect_stdout("Totality   2024-04-08T18:40:43Z to 2024-04-08T18:44:34Z, 3 min 51 s")
        .expect_stdout("Here       total: inside the path of totality")
        .expect_stdout("Maximum    2024-04-08T18:42:39Z: magnitude 1.015, 100% of the Sun's area")
        .expect_stdout("  2024-04-08T18:40:43Z  c2   totality begins")
        .expect_stdout("  2024-04-08T18:44:34Z  c3   totality ends")
        .expect_stdout_flat("Only during totality itself, here from 2024-04-08T18:40:43Z to 2024-04-08T18:44:34Z, is it safe to look with the naked eye");
}

#[test]
fn eclipse_json_is_by_id_and_with_an_observer_local() {
    let engine = Eclipses::new();
    let v = run(&["eclipse", "2025-03-14-lunar", "--format", "json"])
        .expect_code(0)
        .json();
    assert!(v.get("local").is_none());
    assert_same(
        &v["eclipse"],
        &engine.by_id("2025-03-14-lunar").expect("by id"),
        "by_id",
    );
    let london = Site {
        lat_deg: 51.5074,
        lon_deg: -0.1278,
        ..Site::default()
    };
    let v = run(&[
        "eclipse",
        "2025-03-14-lunar",
        "--lat",
        "51.5074",
        "--lon",
        "-0.1278",
        "--json",
    ])
    .expect_code(0)
    .json();
    assert_same(
        &v["local"],
        &engine.local("2025-03-14-lunar", &london).expect("local"),
        "London",
    );
    // docs/EXPLORER_API.md: the Moon sets over London during that eclipse.
    assert_eq!(v["local"]["visibility"], "partly_below_horizon");
    // --height reaches the site.
    let v = run(&[
        "eclipse",
        "2024-04-08-solar",
        "--lat",
        "32.78",
        "--lon",
        "-96.8",
        "--height",
        "150",
        "--json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(v["local"]["observer"]["height_m"], 150.0);
    let high = Site {
        height_m: 150.0,
        ..dallas()
    };
    assert_same(
        &v["local"],
        &engine.local("2024-04-08-solar", &high).expect("local"),
        "Dallas at 150 m",
    );
}

#[test]
fn a_lunar_eclipse_reads_its_contacts_and_the_moons_height() {
    run(&[
        "eclipse",
        "2025-03-14-lunar",
        "--lat",
        "51.5074",
        "--lon",
        "-0.1278",
    ])
    .expect_code(0)
    .expect_stdout("TOTAL LUNAR ECLIPSE  2025-03-14-lunar")
    .expect_stdout("Totality   1 h 05 min 24 s (u2 to u3")
    .expect_stdout("Here       partly seen: the Moon sets at 2025-03-14T06:22:57Z during it")
    .expect_stdout("  2025-03-14T03:57:28Z  p1   penumbral eclipse begins  +21 13.1")
    .expect_stdout("  2025-03-14T06:22:57Z       moonset")
    .expect_stdout("Moon down");
    // Without an observer the contacts are listed once, as the same instants everywhere.
    let r = run(&["eclipse", "2025-03-14-lunar"])
        .expect_code(0)
        .expect_stdout("Contacts, the same instants wherever the Moon is up")
        .expect_stdout("  u2  2025-03-14T06:26:04Z  the Moon is wholly inside the umbra");
    assert!(
        !r.stdout.contains("Eye safety"),
        "a lunar eclipse is safe to watch"
    );
}

#[test]
fn every_solar_eclipse_carries_an_eye_safety_line_fitted_to_the_place() {
    run(&["eclipse", "2024-04-08-solar"])
        .expect_code(0)
        .expect_stdout_flat("Eye safety: never look at the Sun")
        .expect_stdout_flat("ISO 12312-2")
        .expect_stdout_flat("Only during totality itself, inside the path of totality");
    // With no observer the line follows the eclipse's type: an annular or a partial
    // eclipse has no totality anywhere, so no moment is safe.
    run(&["eclipse", "2024-10-02-solar"])
        .expect_code(0)
        .expect_stdout_flat("An annular eclipse is never safe to look at with the naked eye");
    run(&["eclipse", "2025-03-29-solar"])
        .expect_code(0)
        .expect_stdout_flat("A partial eclipse is never safe to look at with the naked eye");
    // Easter Island, inside the annular path of 2024-10-02.
    run(&[
        "eclipse",
        "2024-10-02-solar",
        "--lat",
        "-27.1127",
        "--lon",
        "-109.3497",
    ])
    .expect_code(0)
    .expect_stdout("Annularity 2024-10-02T19:04:20Z to 2024-10-02T19:10:18Z, 5 min 58 s")
    .expect_stdout_flat("An annular eclipse is never safe to look at with the naked eye");
    // Honolulu, 2017: the Sun rises eclipsed and the eclipse is partial there.
    run(&[
        "eclipse",
        "2017-08-21-solar",
        "--lat",
        "21.3069",
        "--lon",
        "-157.8583",
    ])
    .expect_code(0)
    .expect_stdout("Here       partial, the Sun rises at 2017-08-21T16:11:58Z during it")
    .expect_stdout("sunrise, 16% covered")
    .expect_stdout("Sun down")
    .expect_stdout_flat("there is no moment when it is safe to look with the naked eye");
}

/// `--path` is the library's `EclipsePath`, and `--format geojson` the same lines as a
/// FeatureCollection whose coordinates are the library's, unrounded.
#[test]
fn the_path_is_the_librarys_and_geojson_carries_it_unrounded() {
    let engine = Eclipses::new();
    let path = engine.path("2024-04-08-solar").expect("the path");
    let v = run(&["eclipse", "2024-04-08-solar", "--path"])
        .expect_code(0)
        .json();
    assert_same(&v, &path, "the path");
    let explicit = run(&["eclipse", "2024-04-08-solar", "--path", "--format", "json"])
        .expect_code(0)
        .json();
    assert_eq!(v, explicit);

    let g = run(&[
        "eclipse",
        "2024-04-08-solar",
        "--path",
        "--format",
        "geojson",
    ])
    .expect_code(0)
    .json();
    assert_eq!(g["type"], "FeatureCollection");
    let features = g["features"].as_array().expect("features");
    let EclipsePath::Solar(p) = &path else {
        panic!("a solar path")
    };
    let greatest = &features[0];
    assert_eq!(greatest["geometry"]["type"], "Point");
    assert_eq!(greatest["properties"]["feature"], "greatest_eclipse");
    assert_same(
        &greatest["geometry"]["coordinates"],
        &[p.greatest.lon_deg, p.greatest.lat_deg],
        "greatest eclipse, [lon, lat]",
    );
    let lines = [
        ("central_line", &p.central_line),
        ("umbra_north", &p.umbra_north),
        ("umbra_south", &p.umbra_south),
        ("umbra_horizon", &p.umbra_horizon),
        ("penumbra_north", &p.penumbra_north),
        ("penumbra_south", &p.penumbra_south),
        ("penumbra_horizon", &p.penumbra_horizon),
    ];
    let mut expected = 1;
    for (name, line) in lines {
        let f = features.iter().find(|f| f["properties"]["feature"] == name);
        if line.is_empty() {
            assert!(f.is_none(), "{name} is empty and must be left out");
            continue;
        }
        expected += 1;
        let f = f.unwrap_or_else(|| panic!("no {name} feature"));
        assert_eq!(f["type"], "Feature");
        assert_eq!(f["geometry"]["type"], "MultiLineString");
        assert_same(&f["geometry"]["coordinates"], &line.segments, name);
        assert_same(&f["properties"]["jd_utc"], &line.jd_utc, name);
        assert_eq!(f["properties"]["eclipse"], "2024-04-08-solar");
        assert_eq!(f["properties"]["eclipse_type"], "total");
    }
    assert_eq!(features.len(), expected);
    assert!(expected >= 6, "a total eclipse has a path and its limits");

    // A lunar eclipse's "path" is the point under the Moon at each contact.
    let lunar = engine.path("2025-03-14-lunar").expect("sub-lunar points");
    let EclipsePath::Lunar(l) = &lunar else {
        panic!("a lunar path")
    };
    let g = run(&[
        "eclipse",
        "2025-03-14-lunar",
        "--path",
        "--format",
        "geojson",
    ])
    .expect_code(0)
    .json();
    let points = g["features"].as_array().expect("features");
    assert_eq!(points.len(), l.sublunar.len());
    for (f, s) in points.iter().zip(&l.sublunar) {
        assert_eq!(f["geometry"]["type"], "Point");
        assert_same(
            &f["geometry"]["coordinates"],
            &[s.lon_deg, s.lat_deg],
            "a sub-lunar point",
        );
        assert_eq!(f["properties"]["utc"], s.utc.as_str());
    }
    assert_eq!(points[0]["properties"]["contact"], "p1");
}

#[test]
fn eclipse_flags_that_contradict_each_other_are_refused() {
    run(&["eclipse", "2024-04-08-eclipse"])
        .expect_code(1)
        .expect_stderr("malformed eclipse id");
    run(&["eclipse", "2024-04-09-solar"])
        .expect_code(1)
        .expect_stderr("there is no solar eclipse with greatest eclipse on 2024-04-09")
        .expect_stderr("skyfix eclipses --from DATE --to DATE");
    run(&["eclipse", "2024-04-08-solar", "--format", "geojson"])
        .expect_code(1)
        .expect_stderr("--format geojson is for --path");
    run(&["eclipse", "2024-04-08-solar", "--path", "--format", "text"])
        .expect_code(1)
        .expect_stderr("--path has no text form");
    let mut with_observer = vec!["eclipse", "2024-04-08-solar", "--path"];
    with_observer.extend_from_slice(&DALLAS);
    run(&with_observer).expect_code(1).expect_stderr("--path");
    run(&["eclipse", "2024-04-08-solar", "--lon", "-96.8"]).expect_code(1);
    run(&[
        "eclipse",
        "2024-04-08-solar",
        "--lat",
        "32.78",
        "--lon",
        "-96.8",
        "--height",
        "200000",
    ])
    .expect_code(1)
    .expect_stderr("observer out of range");
}

// ---------------------------------------------------------------------------
// planet-events
// ---------------------------------------------------------------------------

#[test]
fn planet_events_json_is_the_librarys_list() {
    let v = run(&[
        "planet-events",
        "--from",
        "2026-01-01",
        "--to",
        "2026-12-31",
        "--format",
        "json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(
        v["bodies"],
        serde_json::json!([
            "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"
        ])
    );
    let want = planet_events(
        &PlanetProvider::new(),
        jd("2026-01-01T00:00:00Z"),
        jd("2027-01-01T00:00:00Z"),
    )
    .expect("planet events");
    assert_same(&without(v, &["bodies"]), &want, "planet events 2026");
    // docs/EXPLORER_API.md: 2026 opens with Venus's superior conjunction.
    assert_eq!(want.events[0].body, "Venus");
    assert!(want.events.len() > 20);
}

#[test]
fn body_keeps_the_planets_asked_for_in_any_case() {
    let v = run(&[
        "planet-events",
        "--from",
        "2026-01-01",
        "--to",
        "2026-12-31",
        "--body",
        "jupiter, MARS",
        "--json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(v["bodies"], serde_json::json!(["Mars", "Jupiter"]));
    let mut want = planet_events(
        &PlanetProvider::new(),
        jd("2026-01-01T00:00:00Z"),
        jd("2027-01-01T00:00:00Z"),
    )
    .expect("planet events");
    want.events
        .retain(|e| e.body == "Mars" || e.body == "Jupiter");
    assert_same(&without(v, &["bodies"]), &want, "Mars and Jupiter");
    for bad in ["Pluto", "Moon", "Sun", "Mars,,Venus"] {
        run(&[
            "planet-events",
            "--from",
            "2026-01-01",
            "--to",
            "2026-12-31",
            "--body",
            bad,
        ])
        .expect_code(1);
    }
    run(&[
        "planet-events",
        "--from",
        "2026-01-01",
        "--to",
        "2026-01-31",
        "--body",
        "Vulcan",
    ])
    .expect_code(1)
    .expect_stderr("is not a planet");
}

/// The transit of Mercury of 2032-11-13 is flagged on its inferior conjunction.
#[test]
fn the_transit_of_mercury_of_2032_is_flagged() {
    let r = run(&[
        "planet-events",
        "--from",
        "2032-11-01",
        "--to",
        "2032-11-30",
        "--body",
        "Mercury",
    ])
    .expect_code(0)
    .expect_stdout("Planets        Mercury")
    .expect_stdout_flat("with a transit across the Sun's disc: Mercury on 2032-11-13");
    let row = r
        .stdout
        .lines()
        .find(|l| l.contains("inferior conjunction"))
        .expect("the conjunction");
    assert!(
        row.starts_with("  2032-11-13T") && row.ends_with("yes"),
        "{row}"
    );
    // Its neighbours are not transits, and only an inferior conjunction says no.
    let r = run(&[
        "planet-events",
        "--from",
        "2026-03-01",
        "--to",
        "2026-03-31",
        "--body",
        "mercury",
    ])
    .expect_code(0);
    let row = r
        .stdout
        .lines()
        .find(|l| l.contains("inferior conjunction"))
        .expect("the conjunction of 2026-03-07");
    assert!(row.ends_with("no"), "{row}");
}

#[test]
fn planet_event_windows_are_checked_and_clipped_to_the_coverage() {
    run(&[
        "planet-events",
        "--from",
        "2027-01-01",
        "--to",
        "2026-01-01",
    ])
    .expect_code(1)
    .expect_stderr("--to must come after --from");
    run(&[
        "planet-events",
        "--from",
        "1980-01-01",
        "--to",
        "1980-12-31",
    ])
    .expect_code(1)
    .expect_stderr("outside the planets' coverage");
    let v = run(&[
        "planet-events",
        "--from",
        "2060-12-01",
        "--to",
        "2061-03-31",
        "--json",
    ])
    .expect_code(0)
    .expect_stderr("clipped")
    .json();
    assert_eq!(v["truncated"], true);
}
