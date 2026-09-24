//! End-to-end tests of the explorer commands: sky, events, phases, seasons, noon,
//! polaris, average, running-fix, predict, lunar and plan-sights. OWNER: cli agent.
//!
//! Each command's `--format json` must be exactly what the library function it wraps
//! returns for the same inputs, so every JSON test below calls that function directly
//! and compares, number by number (`support::json_close`). The astronomy itself is
//! validated where it lives (skyfix-almanac, skyfix-core, skyfix-ephemeris against
//! Skyfield and USNO); these tests check what the command adds: the flags, their
//! defaults, the text, and the exit codes. A few also check the answer against the
//! independent truth the session was transcribed from, so a flag that silently fails to
//! reach the engine cannot pass.

mod support;

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;
use skyfix_almanac::events::{self, DayEvents, EventOptions, Horizon};
use skyfix_almanac::sky;
use skyfix_core::time::parse_utc;
use skyfix_core::types::{
    AveragingOptions, DrPosition, Instrument, LatLon, Limb, LunarDistanceInput, NoonSightOptions,
    PolarisOptions, Session, SightObserver, SolveOptions,
};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::fixture_pack::CompositeProvider;
use skyfix_ephemeris::topocentric::Site;
use skyfix_ephemeris::{AstroProvider, ProviderSource};
use skyfix_motion::request::{
    MotionUncertaintyInput, RunningFixLeg, RunningFixRequest, running_fix_session,
};
use support::{data_file, distance_m, skyfix};

/// The CLI's `--ephemeris auto` astronomy (`crate::provider::auto_provider`): the Sun,
/// the Moon, the sight planets (Venus at its centre of light) and the stars.
fn auto() -> CompositeProvider {
    CompositeProvider::new("skyfix-auto")
        .with(skyfix_ephemeris::sun::SunProvider::new())
        .with(skyfix_ephemeris::moon::MoonProvider::new())
        .with(skyfix_ephemeris::sights::SightPlanetProvider::new())
        .with(skyfix_ephemeris::stars::StarProvider::new())
}

/// Numbers may differ by this much between the binary and the library call: nothing a
/// report could show, and far above any floating-point reordering.
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

fn fixture(name: &str) -> String {
    data_file(name).to_string_lossy().into_owned()
}

fn session(name: &str) -> Session {
    let text = std::fs::read_to_string(data_file(name)).expect("the session fixture");
    skyfix_core::session::parse_session(&text)
        .expect("the fixture is a valid session")
        .0
}

const PHL_LAT: &str = "39.9526";
const PHL_LON: &str = "-75.1652";

fn phl_site() -> Site {
    Site {
        lat_deg: 39.9526,
        lon_deg: -75.1652,
        ..Site::default()
    }
}

// ---------------------------------------------------------------------------
// sky
// ---------------------------------------------------------------------------

#[test]
fn sky_json_is_the_library_sky_state_with_its_constellations() {
    let utc = "2026-10-01T01:30:00Z";
    let run = skyfix([
        "sky", "--lat", PHL_LAT, "--lon", PHL_LON, "--utc", utc, "--format", "json",
    ])
    .expect_code(0);
    let bodies = sky::body_group("all").expect("the all group");
    let mut want = sky::sky_state(&Sky::new(), &phl_site(), jd(utc), &bodies).expect("sky");
    for b in &mut want.bodies {
        b.constellation = skyfix_starfield::constellation_at(b.ra_deg, b.dec_deg, jd(utc))
            .ok()
            .map(str::to_string);
    }
    let v = run.json();
    assert_same(&v, &want, "sky");
    assert_eq!(v["bodies"].as_array().expect("bodies").len(), 67);
    let con = |name: &str| {
        v["bodies"]
            .as_array()
            .expect("bodies")
            .iter()
            .find(|b| b["body"] == name)
            .map(|b| b["constellation"].clone())
    };
    assert_eq!(con("Vega"), Some(Value::from("Lyr")));
    assert_eq!(con("Polaris"), Some(Value::from("UMi")));
    assert_eq!(v["sky_phase"], "night");
}

#[test]
fn sky_text_is_a_navigator_style_table() {
    skyfix([
        "sky",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--utc",
        "2026-10-01T01:30:00Z",
        "--bodies",
        "Sun,Vega",
    ])
    .expect_code(0)
    .expect_stdout("Time       2026-10-01T01:30:00Z")
    .expect_stdout("Sky        night: the Sun's centre is at -31 44.0")
    // Degrees and decimal minutes: Vega's Dec N 38 48.8, GHA 112 50.6, Lyra.
    .expect_stdout("N 38 48.8")
    .expect_stdout("112 50.6")
    .expect_stdout("Lyr")
    .expect_stdout("1 of 2 bodies are above the horizon")
    .expect_stdout_flat("hc_deg and zn_deg in --format json");
}

#[test]
fn sky_bodies_take_groups_and_names_and_refuse_unknown_ones() {
    let base = [
        "sky",
        "--lat",
        "0",
        "--lon",
        "0",
        "--utc",
        "2026-10-01T01:30:00Z",
    ];
    let names = |extra: &[&str]| -> Vec<String> {
        let mut args: Vec<&str> = base.to_vec();
        args.extend_from_slice(extra);
        args.extend_from_slice(&["--format", "json"]);
        skyfix(args).expect_code(0).json()["bodies"]
            .as_array()
            .expect("bodies")
            .iter()
            .map(|b| b["body"].as_str().expect("a name").to_string())
            .collect()
    };
    assert_eq!(names(&["--bodies", "navigational"]).len(), 64);
    assert_eq!(names(&["--bodies", "solar-system"]).len(), 9);
    assert_eq!(
        names(&["--bodies", "Sun, vega,HIP 32349,Vega"]),
        vec!["Sun", "Vega", "Sirius"]
    );
    let mut bad: Vec<&str> = base.to_vec();
    bad.extend_from_slice(&["--bodies", "Sun,Vulcan"]);
    skyfix(bad)
        .expect_code(1)
        .expect_stderr("Vulcan")
        .expect_stderr("skyfix catalog");
}

/// Most of the world is south or west: `--lat -33.87` must not be read as a flag.
#[test]
fn positions_south_and_west_need_no_equals_sign_and_out_of_range_is_refused() {
    skyfix([
        "sky",
        "--lat",
        "-33.87",
        "--lon",
        "-151.21",
        "--utc",
        "2026-10-01T01:30:00Z",
        "--bodies",
        "Sun",
    ])
    .expect_code(0)
    .expect_stdout("33 52.20' S, 151 12.60' W");
    skyfix([
        "sky",
        "--lat",
        "91",
        "--lon",
        "0",
        "--utc",
        "2026-10-01T01:30:00Z",
    ])
    .expect_code(1)
    .expect_stderr("latitude 91 is outside [-90, 90]");
    skyfix([
        "sky",
        "--lat",
        "0",
        "--lon",
        "0",
        "--utc",
        "2026-10-01 01:30",
    ])
    .expect_code(1)
    .expect_stderr("trailing Z");
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

#[test]
fn events_json_is_the_library_day_events_for_the_local_day() {
    let run = skyfix([
        "events",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--date",
        "2026-09-24",
        "--zone",
        "-04:00",
        "--format",
        "json",
    ])
    .expect_code(0);
    let mut v = run.json();
    assert_eq!(v["date"], "2026-09-24");
    assert_eq!(v["zone"], "UTC-04:00");
    assert_eq!(v["utc_offset_minutes"], -240);
    let o = v.as_object_mut().expect("an object");
    for k in ["date", "zone", "utc_offset_minutes"] {
        o.remove(k);
    }
    // Local midnight to local midnight: 04:00Z to 04:00Z the next day.
    let start = jd("2026-09-24T04:00:00Z");
    let want = events::day_events(
        &Sky::new(),
        &phl_site(),
        start,
        start + 1.0,
        &["Sun", "Moon"],
        &EventOptions::default(),
    )
    .expect("day events");
    assert_same(&v, &want, "events");
    let day: DayEvents = serde_json::from_value(v).expect("the DayEvents wire shape");
    assert_eq!(day.bodies.len(), 2);
    assert!(day.bodies[0].day_length_h.expect("the Sun's day length") > 12.0);
}

#[test]
fn events_text_shows_the_zone_time_beside_utc() {
    skyfix([
        "events",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--date",
        "2026-09-24",
        "--zone",
        "-04:00",
    ])
    .expect_code(0)
    .expect_stdout(
        "Day        2026-09-24 in UTC-04:00: 2026-09-24T04:00:00Z to 2026-09-25T04:00:00Z",
    )
    .expect_stdout("06:50:15  2026-09-24T10:50:15Z  rise")
    .expect_stdout("day length 12 h 04 min")
    .expect_stdout("until the end of the day");

    // The nautical zone comes from the longitude: 75 W is ZD +5.
    skyfix([
        "events",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--date",
        "2026-09-24",
        "--zone",
        "nautical",
    ])
    .expect_code(0)
    .expect_stdout("in nautical ZD +5 (UTC-05:00): 2026-09-24T05:00:00Z");
}

#[test]
fn events_refuse_named_zones_and_say_what_to_type_instead() {
    skyfix([
        "events",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--date",
        "2026-09-24",
        "--zone",
        "America/New_York",
    ])
    .expect_code(1)
    .expect_stderr("tz database")
    .expect_stderr("--zone -04:00");
}

#[test]
fn events_dip_needs_a_height_of_eye_and_lowers_rise_and_set() {
    let base = [
        "events",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--date",
        "2026-09-24",
        "--bodies",
        "Sun",
    ];
    let with = |extra: &[&str]| {
        let mut args: Vec<&str> = base.to_vec();
        args.extend_from_slice(extra);
        skyfix(args)
    };
    with(&["--horizon", "dip"])
        .expect_code(1)
        .expect_stderr("needs --height-of-eye");
    with(&["--height-of-eye", "9"])
        .expect_code(1)
        .expect_stderr("only applies with --horizon dip");

    let rise = |v: &Value| -> (f64, f64) {
        let e = v["bodies"][0]["events"]
            .as_array()
            .expect("events")
            .iter()
            .find(|e| e["kind"] == "rise")
            .expect("a sunrise")
            .clone();
        (
            e["jd_utc"].as_f64().expect("jd"),
            e["alt_deg"].as_f64().expect("alt"),
        )
    };
    let standard = rise(&with(&["--format", "json"]).expect_code(0).json());
    let dip = with(&[
        "--horizon",
        "dip",
        "--height-of-eye",
        "9",
        "--format",
        "json",
    ])
    .expect_code(0)
    .json();
    let (t, h0) = rise(&dip);
    // -50' lowered by 1.76' sqrt(9) = 5.28' (CONVENTIONS 13.3), so the Sun rises earlier.
    // The instant is refined to 1 ms, in which the Sun climbs about 0.0003'.
    assert!((h0 * 60.0 + 50.0 + 5.28).abs() < 1e-3, "{h0}");
    assert!(
        t < standard.0,
        "a dipped horizon must bring sunrise earlier"
    );
    let want = events::day_events(
        &Sky::new(),
        &phl_site(),
        jd("2026-09-24T00:00:00Z"),
        jd("2026-09-25T00:00:00Z"),
        &["Sun"],
        &EventOptions {
            horizon: Horizon::Dip,
            height_of_eye_m: 9.0,
        },
    )
    .expect("events");
    let mut v = dip;
    for k in ["date", "zone", "utc_offset_minutes"] {
        v.as_object_mut().expect("object").remove(k);
    }
    assert_same(&v, &want, "events with dip");
}

// ---------------------------------------------------------------------------
// phases and seasons
// ---------------------------------------------------------------------------

#[test]
fn phases_json_is_the_library_list() {
    let run = skyfix([
        "phases",
        "--from",
        "2026-09-01",
        "--to",
        "2026-10-31",
        "--format",
        "json",
    ])
    .expect_code(0);
    let want = events::moon_phases(
        &Sky::new(),
        jd("2026-09-01T00:00:00Z"),
        jd("2026-11-01T00:00:00Z"),
    )
    .expect("phases");
    assert_same(&run.json(), &want, "phases");
    assert_eq!(want.len(), 8);
}

#[test]
fn a_date_as_to_means_the_end_of_that_day() {
    // The full moon of 26 September 2026 is at 16:49Z: inside "--to 2026-09-26".
    skyfix(["phases", "--from", "2026-09-26", "--to", "2026-09-26"])
        .expect_code(0)
        .expect_stdout("2026-09-26T16:49:02Z  full moon");
    skyfix([
        "phases",
        "--from",
        "2026-09-26T12:00:00Z",
        "--to",
        "2026-09-26T16:00:00Z",
    ])
    .expect_code(0)
    .expect_stdout("none in this window");
    skyfix(["phases", "--from", "2026-10-01", "--to", "2026-09-01"])
        .expect_code(1)
        .expect_stderr("--to must come after --from");
}

#[test]
fn seasons_json_is_the_library_list_and_a_year_outside_coverage_is_refused() {
    let run = skyfix(["seasons", "--year", "2026", "--json"]).expect_code(0);
    assert_same(
        &run.json(),
        &events::seasons(&Sky::new(), 2026).expect("seasons"),
        "seasons",
    );
    skyfix(["seasons", "--year", "2026"])
        .expect_code(0)
        .expect_stdout("2026-09-23T00:05:12Z  September equinox");
    skyfix(["seasons", "--year", "1980"])
        .expect_code(1)
        .expect_stderr("Sun");
}

// ---------------------------------------------------------------------------
// noon
// ---------------------------------------------------------------------------

const NOON_DR: DrPosition = DrPosition {
    lat_deg: 39.779322089,
    lon_deg: -75.295321012,
    sigma_nm: Some(10.0),
};

#[test]
fn noon_json_is_the_library_noon_sight_and_recovers_the_truth() {
    let run = skyfix([
        "noon",
        &fixture("noon_equinox_sun.session.json"),
        "--dr",
        "39.779322089,-75.295321012,10",
        "--format",
        "json",
    ])
    .expect_code(0);
    let want = skyfix_core::methods::noon::noon_sight(
        &session("noon_equinox_sun.session.json"),
        &ProviderSource(auto()),
        &NoonSightOptions {
            dr: Some(NOON_DR),
            ..NoonSightOptions::default()
        },
    )
    .expect("noon");
    let v = run.json();
    assert_same(&v, &want, "noon");
    // Against the Skyfield truth of fixtures/reference/nav_methods.json.
    assert!((want.latitude.lat_deg - 39.9526).abs() * 60.0 < 0.01);
    let passage = want.meridian_passage.expect("a timed passage");
    assert!((passage.jd_utc - 2_461_307.203_445_47).abs() * 86_400.0 < 1.0);
    assert_eq!(v["method"], "curve_fit");
}

#[test]
fn noon_text_leads_with_the_latitude_and_calls_the_longitude_weak() {
    skyfix([
        "noon",
        &fixture("noon_equinox_sun.session.json"),
        "--dr",
        "39.779322089,-75.295321012,10",
    ])
    .expect_code(0)
    .expect_stdout("NOON SIGHT")
    .expect_stdout("Latitude   39 57.15' N (39.952583)")
    .expect_stdout("Passage    2026-09-23T16:52:58Z")
    .expect_stdout("from --dr")
    .expect_stdout_flat("the longitude, which is nothing but that time")
    .expect_stdout_flat("flat-topped peak");
}

#[test]
fn noon_options_reach_the_method() {
    let file = fixture("noon_equinox_sun.session.json");
    let v = skyfix([
        "noon",
        &file,
        "--curvature",
        "fitted",
        "--body-bearing",
        "south",
        "--format",
        "json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(v["method"], "curve_fit_free_curvature");
    // No --dr: the session's assumed position is the DR, with no stated sigma.
    assert!(v["dr_check"]["predicted_passage_sigma_s"].is_null());

    // Bowditch 1910: one altitude, on a vessel making 10 kn on 045.
    let book = fixture("noon_bowditch_1910.session.json");
    let peak = skyfix(["noon", &book, "--vessel", "45,10", "--json"])
        .expect_code(0)
        .json();
    assert_eq!(peak["method"], "maximum_altitude");
    let lat = peak["latitude"]["lat_deg"].as_f64().expect("a latitude");
    // The book says 39 48.6' N; docs/NAVIGATION_METHODS.md 6.2 accounts for the 0.18'.
    assert!(((lat - 39.81) * 60.0).abs() < 0.25, "{lat}");
    let ex = skyfix([
        "noon",
        &book,
        "--vessel",
        "45,10",
        "--single-altitude",
        "ex-meridian",
        "--json",
    ])
    .expect_code(0)
    .json();
    assert_eq!(ex["method"], "ex_meridian");
    assert!(ex["longitude_sensitivity_arcmin_per_nm"].is_number());
}

#[test]
fn a_rejected_sight_is_a_warning_and_exit_two_and_no_dr_is_refused() {
    let mut s = session("noon_equinox_sun.session.json");
    let mut bad = s.observations[10].clone();
    bad.id = "below-horizon".to_string();
    bad.altitude_deg = -1.0;
    s.observations.push(bad);
    let path = support::write_tmp("noon_with_a_bad_sight.session.json", &support::to_json(&s));
    let run = skyfix(["noon", path.to_str().expect("utf-8"), "--format", "json"])
        .expect_code(2)
        .expect_stderr("1 of 22 sight(s) were rejected");
    assert!(
        run.stdout.contains("below-horizon"),
        "the rejection must be named in the warnings"
    );

    s.observer.assumed_position = None;
    let path = support::write_tmp("noon_without_dr.session.json", &support::to_json(&s));
    skyfix(["noon", path.to_str().expect("utf-8")])
        .expect_code(1)
        .expect_stderr("DR position");
}

// ---------------------------------------------------------------------------
// polaris
// ---------------------------------------------------------------------------

#[test]
fn polaris_json_is_the_library_result_and_reproduces_bowditch_1912() {
    let run = skyfix([
        "polaris",
        &fixture("polaris_bowditch_1912.session.json"),
        "--dr",
        "40.766666667,-43.366666667,10",
        "--format",
        "json",
    ])
    .expect_code(0);
    let want = skyfix_core::methods::polaris::polaris_latitude(
        &session("polaris_bowditch_1912.session.json"),
        &ProviderSource(auto()),
        Some(&skyfix_ephemeris::stars::EphemerisPolarisTable),
        &PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: 40.766666667,
                lon_deg: -43.366666667,
                sigma_nm: Some(10.0),
            }),
            ..PolarisOptions::default()
        },
    )
    .expect("polaris");
    assert_same(&run.json(), &want, "polaris");
    // Bowditch: 40 48.4' N, a0 54.9', a1 0.5', a2 0.9' (docs/NAVIGATION_METHODS.md 6.2).
    assert!(((want.latitude.lat_deg - 40.806666667) * 60.0).abs() < 0.1);
    let t = want.polaris[0].almanac.as_ref().expect("the Almanac terms");
    assert!((t.a0_arcmin - 54.9).abs() < 0.05);

    skyfix(["polaris", &fixture("polaris_bowditch_1912.session.json")])
        .expect_code(0)
        .expect_stdout("Latitude   40 48.47' N")
        .expect_stdout("127 15.1")
        .expect_stdout("Almanac Polaris table, unrounded");
}

// ---------------------------------------------------------------------------
// average
// ---------------------------------------------------------------------------

#[test]
fn average_json_is_the_library_result_and_hits_the_true_altitude() {
    let run = skyfix([
        "average",
        &fixture("average_vega.session.json"),
        "--dr",
        "40.077256408,-74.882250386,10",
        "--format",
        "json",
    ])
    .expect_code(0);
    let want = skyfix_core::methods::averaging::average_sights(
        &session("average_vega.session.json"),
        &ProviderSource(auto()),
        &AveragingOptions {
            dr: Some(DrPosition {
                lat_deg: 40.077256408,
                lon_deg: -74.882250386,
                sigma_nm: Some(10.0),
            }),
            ..AveragingOptions::default()
        },
    )
    .expect("average");
    let v = run.json();
    assert_same(&v, &want, "average");
    // Skyfield's altitude at the mean instant: 61.072473005 deg.
    assert!((want.ho_deg - 61.072_473_005).abs() * 60.0 < 0.01);
    // The averaged observation is a session observation, ready for `skyfix solve`.
    let doc = serde_json::json!({"schema": "skyfix.session/1", "observations": [v["observation"]]});
    skyfix_core::session::parse_session(&doc.to_string()).expect("a valid observation");
}

#[test]
fn average_flags_reach_the_options() {
    let file = fixture("average_vega.session.json");
    let run = skyfix([
        "average",
        &file,
        "--reference-utc",
        "2026-10-01T01:31:00Z",
        "--keep-outliers",
        "--outlier-threshold",
        "2.5",
        "--vessel",
        "90,6",
        "--json",
    ])
    .expect_code(0);
    let want = skyfix_core::methods::averaging::average_sights(
        &session("average_vega.session.json"),
        &ProviderSource(auto()),
        &AveragingOptions {
            reference_utc: Some("2026-10-01T01:31:00Z".to_string()),
            dr: None,
            vessel: Some(skyfix_core::types::VesselMotion {
                course_deg: 90.0,
                speed_kn: 6.0,
            }),
            reject_outliers: false,
            outlier_threshold: 2.5,
        },
    )
    .expect("average");
    assert_same(&run.json(), &want, "average with flags");
    assert_eq!(want.utc, "2026-10-01T01:31:00.000Z");
    skyfix(["average", &file, "--reference-utc", "01:31"])
        .expect_code(1)
        .expect_stderr("--reference-utc");
}

// ---------------------------------------------------------------------------
// running-fix
// ---------------------------------------------------------------------------

#[test]
fn running_fix_json_is_the_library_result_and_recovers_the_truth() {
    let run = skyfix([
        "running-fix",
        &fixture("running_fix_north.session.json"),
        "--leg",
        "0,12",
        "--speed-sigma",
        "0.5",
        "--course-sigma",
        "2",
        "--format",
        "json",
    ])
    .expect_code(0);
    let s = session("running_fix_north.session.json");
    let request = RunningFixRequest {
        reference_utc: None,
        legs: vec![RunningFixLeg {
            start_utc: None,
            course_deg: 0.0,
            speed_kn: 12.0,
        }],
        end_utc: None,
        motion_uncertainty: MotionUncertaintyInput {
            speed_sigma_kn: 0.5,
            course_sigma_deg: 2.0,
            random_walk_nm_per_sqrt_hour: 0.0,
        },
        // The session has no assumed position and no clock uncertainty, so `solve`'s
        // rules add nothing to the defaults.
        options: SolveOptions::default(),
    };
    let want = running_fix_session(&s, &request, &ProviderSource(auto())).expect("running fix");
    assert_same(&run.json(), &want, "running-fix");
    let skyfix_core::types::FixResult::Unique { fix, .. } = &want.result else {
        panic!("expected a unique fix, got {:?}", want.result)
    };
    // Truth (Skyfield, nav_methods.json due-north-12kn): 40.6 N, 70.0 W at 03:00Z.
    let err = distance_m(
        fix.position,
        LatLon {
            lat_deg: 40.6,
            lon_deg: -70.0,
        },
    );
    assert!(err < 10.0, "{err} m from the truth");
    assert_eq!(want.reference_utc, "2026-10-01T03:00:00.000Z");
    assert_eq!(want.inflations.len(), 3);
}

#[test]
fn running_fix_legs_and_instants_are_checked() {
    let file = fixture("running_fix_north.session.json");
    skyfix(["running-fix", &file])
        .expect_code(1)
        .expect_stderr("--leg");
    skyfix(["running-fix", &file, "--leg", "0,12", "--leg", "90,10"])
        .expect_code(1)
        .expect_stderr("needs a start_utc");
    skyfix(["running-fix", &file, "--leg", "0,12", "--end-utc", "noon"])
        .expect_code(1)
        .expect_stderr("--end-utc");
    skyfix(["running-fix", &file, "--leg", "0,-12"])
        .expect_code(1)
        .expect_stderr("speed");
}

#[test]
fn running_fix_text_reports_the_advance_and_the_fix_like_solve() {
    let file = fixture("running_fix_north.session.json");
    skyfix([
        "running-fix",
        &file,
        "--leg",
        "2026-10-01T00:00:00Z,0,12",
        "--require-unique",
    ])
    .expect_code(0)
    .expect_stdout("RUNNING FIX")
    .expect_stdout("Track      from 2026-10-01T00:00:00Z: course 000 at 12 kn")
    .expect_stdout("Motion     not stated: the run between the sights is treated as exact")
    .expect_stdout("What the dead reckoning adds to each sight's sigma")
    .expect_stdout("UNIQUE FIX")
    .expect_stdout("40 36.00' N, 070 00.00' W")
    .expect_stdout_flat("no dead-reckoning uncertainty was stated");
}

// ---------------------------------------------------------------------------
// predict
// ---------------------------------------------------------------------------

#[test]
fn predict_json_is_the_library_prediction_and_reduces_back_to_hc() {
    let utc = "2026-10-01T03:00:00Z";
    let run = skyfix([
        "predict",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--utc",
        utc,
        "--body",
        "moon",
        "--limb",
        "lower",
        "--height-of-eye",
        "2.5",
        "--ic",
        "-2.0",
        "--format",
        "json",
    ])
    .expect_code(0);
    let astro = auto();
    let want = skyfix_core::sights::predict::predict_sextant(
        &SightObserver {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
            height_of_eye_m: 2.5,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        },
        &Instrument {
            name: String::new(),
            index_correction_arcmin: -2.0,
            horizon: skyfix_core::types::HorizonMode::Sea,
        },
        "Moon",
        Limb::Lower,
        jd(utc),
        astro.geocentric("Moon", jd(utc)).expect("the Moon"),
        astro.name(),
    )
    .expect("prediction");
    assert_same(&run.json(), &want, "predict");
    assert_eq!(want.body, "Moon");
    assert!((want.corrections.ho_deg - want.hc_deg).abs() < 1e-9);
    // The Moon reads well below Hc: parallax beats refraction and the semidiameter.
    assert!(want.hc_deg - want.hs_deg > 0.5);
}

#[test]
fn predict_text_gives_the_reading_and_the_bearing() {
    skyfix([
        "predict",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--utc",
        "2026-10-01T01:30:00Z",
        "--body",
        "Vega",
        "--horizon",
        "artificial",
    ])
    .expect_code(0)
    .expect_stdout("Body        Vega, centre")
    .expect_stdout("the DOUBLE angle, reflected artificial horizon")
    .expect_stdout("Zn  280 03.")
    .expect_stdout("artificial_horizon_halving  yes");
}

#[test]
fn predict_refuses_bodies_it_cannot_predict() {
    let base = [
        "predict",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--utc",
        "2026-10-01T01:30:00Z",
        "--body",
    ];
    let with = |body: &str| {
        let mut args: Vec<&str> = base.to_vec();
        args.push(body);
        skyfix(args)
    };
    with("Mercury")
        .expect_code(1)
        .expect_stderr("not offered for sights");
    with("Vulcan").expect_code(1).expect_stderr("unknown body");
    // Sirius is below the horizon over Philadelphia then.
    with("Sirius")
        .expect_code(1)
        .expect_stderr("below the visible horizon");
}

// ---------------------------------------------------------------------------
// lunar
// ---------------------------------------------------------------------------

fn lunar_input() -> LunarDistanceInput {
    let text = std::fs::read_to_string(data_file("lunar_19.input.json")).expect("the input");
    serde_json::from_str(&text).expect("a lunar distance document")
}

#[test]
fn lunar_json_is_the_library_result_and_finds_the_time() {
    let run = skyfix(["lunar", &fixture("lunar_19.input.json"), "--format", "json"]).expect_code(0);
    let want = skyfix_core::sights::lunar::lunar_distance(&lunar_input(), &ProviderSource(auto()))
        .expect("a lunar");
    assert_same(&run.json(), &want, "lunar");
    // docs/EXPLORER_API.md: 2029-10-17T01:15:25Z, 9 min 42 s after the watch.
    assert!((want.jd_utc - jd("2029-10-17T01:15:25Z")).abs() * 86_400.0 < 5.0);
    skyfix(["lunar", &fixture("lunar_19.input.json")])
        .expect_code(0)
        .expect_stdout("LUNAR DISTANCE: the Moon to Venus")
        .expect_stdout("UTC        2029-10-17T01:15:2")
        .expect_stdout("+9 min 42 s: add this to the watch's time")
        .expect_stdout("Error budget");
}

#[test]
fn lunar_reads_standard_input_and_refuses_a_foreign_document() {
    let text = std::fs::read_to_string(data_file("lunar_19.input.json")).expect("the input");
    let mut child = Command::new(env!("CARGO_BIN_EXE_skyfix"))
        .args(["lunar", "-", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary runs");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(text.as_bytes())
        .expect("write the document");
    let out = child.wait_with_output().expect("it finishes");
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).expect("JSON");
    assert_eq!(v["body"], "Venus");

    skyfix(["lunar", &fixture("phl_four_star.session.json")])
        .expect_code(1)
        .expect_stderr("is not a lunar distance document");
}

// ---------------------------------------------------------------------------
// plan-sights
// ---------------------------------------------------------------------------

#[test]
fn plan_sights_json_is_the_library_plan() {
    let run = skyfix([
        "plan-sights",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--from",
        "2026-10-01T12:00:00Z",
        "--to",
        "2026-10-02T12:00:00Z",
        "--height-of-eye",
        "2.5",
        "--format",
        "json",
    ])
    .expect_code(0);
    let bodies: Vec<&str> = skyfix_ephemeris::sights::sight_bodies()
        .into_iter()
        .filter(|b| *b != "Sun")
        .collect();
    let want = skyfix_ephemeris::visibility::plan_sights(
        &Sky::new(),
        &auto(),
        &bodies,
        &SightObserver {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
            height_of_eye_m: 2.5,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        },
        jd("2026-10-01T12:00:00Z"),
        jd("2026-10-02T12:00:00Z"),
        &Instrument::default(),
        &skyfix_core::planner::PlanOptions::default(),
    )
    .expect("a plan");
    assert_same(&run.json(), &want, "plan-sights");
    assert_eq!(want.windows.len(), 2);
    assert_eq!(want.windows[0].kind, "evening");
}

#[test]
fn plan_sights_text_and_its_limits() {
    skyfix([
        "plan-sights",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--from",
        "2026-10-01T12:00:00Z",
        "--to",
        "2026-10-02T12:00:00Z",
    ])
    .expect_code(0)
    .expect_stdout("TONIGHT'S SIGHTS")
    .expect_stdout("EVENING NAUTICAL TWILIGHT")
    .expect_stdout("MORNING NAUTICAL TWILIGHT")
    .expect_stdout("Taking them all predicts a fix of about");
    skyfix([
        "plan-sights",
        "--lat",
        PHL_LAT,
        "--lon",
        PHL_LON,
        "--from",
        "2026-10-01",
        "--to",
        "2026-10-10",
    ])
    .expect_code(1)
    .expect_stderr("at most 7 days");
}

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

#[test]
fn json_and_format_json_are_the_same_and_cannot_both_be_given() {
    let a = skyfix(["seasons", "--year", "2026", "--json"]).expect_code(0);
    let b = skyfix(["seasons", "--year", "2026", "--format", "json"]).expect_code(0);
    assert_eq!(a.stdout, b.stdout);
    skyfix(["seasons", "--year", "2026", "--json", "--format", "text"]).expect_code(1);
}

#[test]
fn every_new_command_has_help_and_needs_no_network() {
    for command in [
        "sky",
        "events",
        "phases",
        "seasons",
        "noon",
        "polaris",
        "average",
        "running-fix",
        "predict",
        "lunar",
        "plan-sights",
    ] {
        skyfix([command, "--help"])
            .expect_code(0)
            .expect_stdout("--format");
    }
}
