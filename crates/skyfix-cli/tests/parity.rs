//! Parity of the expansion programme's commands with the engine. OWNER: cli3 agent.
//!
//! Every command below prints, with `--format json`, what the WASM export it mirrors
//! returns. Each test runs the real binary and compares its JSON, number by number to
//! 1e-9 (`support::json_close`), with the library call the export makes, computed here
//! independently of the adapter: so a flag that fails to reach the engine, or an argument
//! built wrongly, cannot pass. Most also compare with the WASM export's own native layer
//! (`skyfix_wasm::<module>::native`), called with the document the site would send.
//!
//! The windows are short on purpose: the binary is a debug build.

mod support;

use std::path::PathBuf;

use serde_json::{Value, json};
use skyfix_core::time::parse_utc;
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::topocentric::Site;
use support::{json_close, skyfix};

/// Numbers may differ by this much between the binary and the library call.
const TOL: f64 = 1e-9;

fn assert_same<T: serde::Serialize + ?Sized>(cli: &Value, want: &T, what: &str) {
    let want = serde_json::to_value(want).expect("the library result serialises");
    if let Err(e) = json_close(cli, &want, TOL, what) {
        panic!("{what}: the CLI's JSON is not the library's result: {e}");
    }
}

/// Every key of `want` is in `cli` with the same value (the CLI's document adds keys).
fn assert_includes<T: serde::Serialize>(cli: &Value, want: &T, what: &str) {
    let want = serde_json::to_value(want).expect("serialises");
    let obj = want.as_object().expect("an object");
    for (k, v) in obj {
        let got = cli
            .get(k)
            .unwrap_or_else(|| panic!("{what}: {k} missing from the CLI's JSON"));
        if let Err(e) = json_close(got, v, TOL, &format!("{what}.{k}")) {
            panic!("{what}: {e}");
        }
    }
}

fn jd(utc: &str) -> f64 {
    parse_utc(utc).expect("a test instant")
}

/// Run the binary with `--format json` appended and parse its stdout.
fn json_of(args: &[&str]) -> Value {
    let mut a: Vec<&str> = args.to_vec();
    a.extend_from_slice(&["--format", "json"]);
    skyfix(&a).expect_code(0).json()
}

const PHL: [&str; 4] = ["--lat", "39.9526", "--lon", "-75.1652"];

fn phl() -> Site {
    Site {
        lat_deg: 39.9526,
        lon_deg: -75.1652,
        ..Site::default()
    }
}

fn phl_json() -> String {
    json!({"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 0.0,
           "pressure_hpa": 1010.0, "temperature_c": 10.0})
    .to_string()
}

fn args(parts: &[&[&str]]) -> Vec<String> {
    parts
        .iter()
        .flat_map(|p| p.iter().map(|s| s.to_string()))
        .collect()
}

fn run_json(parts: &[&[&str]]) -> Value {
    let a = args(parts);
    let refs: Vec<&str> = a.iter().map(String::as_str).collect();
    json_of(&refs)
}

fn packs_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs")
}

/// The committed pack file `name-<rev>.bin`.
fn pack_file(name: &str) -> PathBuf {
    std::fs::read_dir(packs_dir())
        .expect("web/public/data/packs")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| {
            let f = p.file_name().unwrap().to_string_lossy().into_owned();
            f.starts_with(&format!("{name}-")) && f.ends_with(".bin")
        })
        .unwrap_or_else(|| panic!("no committed {name} pack"))
}

fn pack_arg(name: &str) -> String {
    packs_dir().join(name).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Sun tools
// ---------------------------------------------------------------------------

mod sun {
    use super::*;
    use skyfix_almanac::sun_tools::alignment::{self, AlignmentEvent, AlignmentRequest};
    use skyfix_almanac::sun_tools::analemma::{self, AnalemmaRequest, ClockKind};
    use skyfix_almanac::sun_tools::azimuth::{self, AltitudeBand};
    use skyfix_almanac::sun_tools::eot;
    use skyfix_almanac::sun_tools::galactic::{self, GalacticOptions};
    use skyfix_almanac::sun_tools::hours;
    use skyfix_almanac::sun_tools::solar::{self, Panel, SolarYearRequest};
    use skyfix_almanac::sun_tools::sunpath::{self, RiseSetRequest};
    use skyfix_wasm::suntools::native;

    /// 2026-09-24 in UTC-04:00: 04:00Z to 04:00Z.
    fn day() -> (f64, f64) {
        let s = jd("2026-09-24T04:00:00Z");
        (s, s + 1.0)
    }

    #[test]
    fn sun_hours_is_the_library_and_the_export() {
        let v = run_json(&[
            &["sun-hours"],
            &PHL,
            &["--date", "2026-09-24", "--zone", "-04:00"],
        ]);
        let (s, e) = day();
        let want = hours::sun_hours(&Sky::new(), &phl(), s, e).unwrap();
        assert_same(&v, &want, "sun-hours");
        assert_same(&v, &native::sun_hours(&phl_json(), s, e).unwrap(), "export");
        assert_eq!(v["windows"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn find_azimuth_passes_the_band_and_the_body() {
        let v = run_json(&[
            &["find-azimuth"],
            &PHL,
            &[
                "--body",
                "moon",
                "--azimuth",
                "120",
                "--from",
                "2026-09-24",
                "--to",
                "2026-09-27",
                "--min-alt",
                "5",
                "--max-alt",
                "60",
            ],
        ]);
        let (s, e) = (jd("2026-09-24T00:00:00Z"), jd("2026-09-28T00:00:00Z"));
        let band = AltitudeBand {
            min_deg: Some(5.0),
            max_deg: Some(60.0),
        };
        let want = azimuth::find_azimuth(&Sky::new(), &phl(), "moon", s, e, 120.0, &band).unwrap();
        assert!(
            !want.is_empty(),
            "the Moon crosses 120 degrees in the window"
        );
        assert_same(&v, &want, "find-azimuth");
        let wasm = native::find_azimuth(
            &phl_json(),
            "moon",
            s,
            e,
            120.0,
            r#"{"min_deg": 5, "max_deg": 60}"#,
        )
        .unwrap();
        assert_same(&v, &wasm, "export");
    }

    #[test]
    fn alignment_days_is_manhattanhenge() {
        let manhattan = ["--lat", "40.758", "--lon", "-73.9855"];
        let v = run_json(&[
            &["alignment-days"],
            &manhattan,
            &[
                "--year",
                "2026",
                "--azimuth",
                "299",
                "--tolerance",
                "0.3",
                "--event",
                "set",
                "--zone",
                "-04:00",
            ],
        ]);
        let site = Site {
            lat_deg: 40.758,
            lon_deg: -73.9855,
            ..Site::default()
        };
        let req = AlignmentRequest {
            body: "Sun".into(),
            year: 2026,
            azimuth_deg: 299.0,
            tolerance_deg: 0.3,
            event: AlignmentEvent::Set,
            utc_offset_hours: Some(-4.0),
            options: None,
        };
        let want = alignment::alignment_days(&Sky::new(), &site, &req).unwrap();
        assert_same(&v, &want, "alignment-days");
        // The API's worked example: the best days are 24 May and 18 July.
        let best: Vec<&str> = v["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["best"] == true)
            .map(|m| m["date"].as_str().unwrap())
            .collect();
        assert_eq!(best, ["2026-05-24", "2026-07-18"]);
        // At an altitude, local mean time by default.
        let v = run_json(&[
            &["alignment-days"],
            &PHL,
            &[
                "--year",
                "2026",
                "--azimuth",
                "240",
                "--event",
                "at-altitude",
                "--altitude",
                "10",
            ],
        ]);
        let req = AlignmentRequest {
            body: "Sun".into(),
            year: 2026,
            azimuth_deg: 240.0,
            tolerance_deg: 0.5,
            event: AlignmentEvent::AtAltitude { altitude_deg: 10.0 },
            utc_offset_hours: None,
            options: None,
        };
        let want = alignment::alignment_days(&Sky::new(), &phl(), &req).unwrap();
        assert_same(&v, &want, "alignment-days at an altitude");
        let wasm =
            native::alignment_days(&phl_json(), &serde_json::to_string(&req).unwrap()).unwrap();
        assert_same(&v, &wasm, "export");
    }

    #[test]
    fn rise_set_azimuths_and_analemma_are_the_library() {
        let v = run_json(&[
            &["rise-set-azimuths"],
            &PHL,
            &["--year", "2026", "--zone", "-05:00"],
        ]);
        let req = RiseSetRequest {
            body: "Sun".into(),
            year: 2026,
            utc_offset_hours: Some(-5.0),
            options: None,
        };
        let want = sunpath::rise_set_azimuths(&Sky::new(), &phl(), &req).unwrap();
        assert_same(&v, &want, "rise-set-azimuths");
        assert_eq!(v["days"].as_array().unwrap().len(), 365);

        let v = run_json(&[&["analemma"], &PHL, &["--year", "2026", "--time", "09:30"]]);
        let req = AnalemmaRequest {
            year: 2026,
            time_h: 9.5,
            clock: ClockKind::Lmt,
            utc_offset_hours: None,
        };
        let want = analemma::analemma(&Sky::new(), &phl(), &req).unwrap();
        assert_same(&v, &want, "analemma");
        let v = run_json(&[&["analemma"], &PHL, &["--year", "2026", "--zone", "-05:00"]]);
        let req = AnalemmaRequest {
            year: 2026,
            time_h: 12.0,
            clock: ClockKind::Zone,
            utc_offset_hours: Some(-5.0),
        };
        let wasm = native::analemma(&phl_json(), &serde_json::to_string(&req).unwrap()).unwrap();
        assert_same(&v, &wasm, "analemma export");
    }

    #[test]
    fn sun_path_and_the_equation_of_time_are_the_library() {
        let v = run_json(&[
            &["sun-path"],
            &PHL,
            &["--date", "2026-09-24", "--zone", "-04:00", "--step", "20"],
        ]);
        let (s, e) = day();
        let want = sunpath::sun_path(&Sky::new(), &phl(), s, e, 20.0).unwrap();
        assert_same(&v, &want, "sun-path");
        assert_same(
            &v,
            &native::sun_path(&phl_json(), s, e, 20.0).unwrap(),
            "export",
        );

        let v = json_of(&["equation-of-time", "--year", "2026", "--hour", "0"]);
        let want = eot::equation_of_time(&Sky::new(), 2026, 0.0).unwrap();
        assert_same(&v, &want, "equation-of-time");
        assert_same(
            &v,
            &native::equation_of_time(2026.0, 0.0).unwrap(),
            "export",
        );
    }

    #[test]
    fn solar_day_and_year_carry_the_panel() {
        let v = run_json(&[
            &["solar-day"],
            &PHL,
            &[
                "--date",
                "2026-09-24",
                "--zone",
                "-04:00",
                "--tilt",
                "30",
                "--panel-azimuth",
                "170",
                "--albedo",
                "0.3",
                "--step",
                "15",
            ],
        ]);
        let (s, e) = day();
        let panel = Panel {
            tilt_deg: 30.0,
            azimuth_deg: Some(170.0),
            albedo: Some(0.3),
        };
        let want = solar::solar_day(&Sky::new(), &phl(), s, e, &panel, 15.0).unwrap();
        assert_same(&v, &want, "solar-day");
        assert_eq!(v["panel"]["azimuth_deg"], 170.0);

        let v = run_json(&[
            &["solar-year"],
            &PHL,
            &["--year", "2026", "--tilt", "30", "--optimise-tilt"],
        ]);
        let req = SolarYearRequest {
            year: 2026,
            panel: Panel {
                tilt_deg: 30.0,
                ..Panel::default()
            },
            utc_offset_hours: None,
            step_minutes: None,
            optimise_tilt: true,
        };
        let want = solar::solar_year(&Sky::new(), &phl(), &req).unwrap();
        assert_same(&v, &want, "solar-year");
        assert!(v["optimal"]["tilt_deg"].is_number());
        let wasm = native::solar_year(&phl_json(), &serde_json::to_string(&req).unwrap()).unwrap();
        assert_same(&v, &wasm, "export");
    }

    #[test]
    fn galactic_centre_windows_take_their_options() {
        let sso = ["--lat", "-31.2733", "--lon", "149.0617", "--height", "1165"];
        let v = run_json(&[
            &["galactic-centre"],
            &sso,
            &[
                "--from",
                "2026-06-15",
                "--to",
                "2026-06-16",
                "--zone",
                "+10:00",
                "--min-alt",
                "15",
                "--sun-max-alt",
                "-15",
            ],
        ]);
        let site = Site {
            lat_deg: -31.2733,
            lon_deg: 149.0617,
            height_m: 1165.0,
            ..Site::default()
        };
        let (s, e) = (jd("2026-06-14T14:00:00Z"), jd("2026-06-16T14:00:00Z"));
        let options = GalacticOptions {
            min_altitude_deg: Some(15.0),
            sun_max_altitude_deg: Some(-15.0),
        };
        let want = galactic::galactic_centre_windows(&Sky::new(), &site, s, e, &options).unwrap();
        assert_same(&v, &want, "galactic-centre");
        assert!(!v["windows"].as_array().unwrap().is_empty());
    }
}

// ---------------------------------------------------------------------------
// The magnetic field and compass error
// ---------------------------------------------------------------------------

mod geomag {
    use super::*;
    use skyfix_geomag::ModelChoice;

    #[test]
    fn variation_is_the_model_and_the_export() {
        let t = "2026-09-24T12:00:00Z";
        let v = run_json(&[&["variation"], &PHL, &["--height", "12", "--utc", t]]);
        let field =
            skyfix_geomag::field_at_jd(39.9526, -75.1652, 12.0, jd(t), ModelChoice::Auto).unwrap();
        assert_includes(&v, &field, "variation");
        assert_eq!(v["available"], true);
        let wasm =
            skyfix_wasm::geomag::magnetic_field_impl(39.9526, -75.1652, 12.0, jd(t), Some("auto"))
                .unwrap();
        assert_same(&v, &wasm, "export");
        // The API's example: 11.8 degrees W.
        assert_eq!(v["variation_text"], "11.8° W");
        // IGRF-14 by name, and no model before 1900: an answer, exit 0.
        let v = run_json(&[&["variation"], &PHL, &["--utc", t, "--model", "igrf14"]]);
        assert_eq!(v["model"], "IGRF-14");
        let v = run_json(&[&["variation"], &PHL, &["--utc", "1850-01-01T00:00:00Z"]]);
        assert_eq!(v["available"], false);
        assert!(v["reason"].as_str().unwrap().contains("1900"));
    }

    #[test]
    fn the_grid_is_the_models_grid() {
        let t = "2026-09-24T12:00:00Z";
        let v = json_of(&[
            "magnetic-grid",
            "--utc",
            t,
            "--lat-range",
            "30,40",
            "--lon-range",
            "-80,-70",
            "--rows",
            "3",
            "--cols",
            "2",
        ]);
        let lats = [30.0, 35.0, 40.0];
        let lons = [-80.0, -70.0];
        let year = skyfix_geomag::decimal_year(jd(t));
        let g = skyfix_geomag::grid(year, ModelChoice::Auto, &lats, &lons, 0.0).unwrap();
        assert_same(&v["declination_deg"], &g.declination_deg, "declination");
        assert_same(&v["horizontal_nt"], &g.horizontal_nt, "H");
        assert_same(&v["lat_deg"], &lats, "lats");
        assert_same(&v["lon_deg"], &lons, "lons");
        assert_eq!(v["model"], "WMM2025");
        let wasm =
            skyfix_wasm::geomag::magnetic_grid_impl(jd(t), 30.0, 40.0, 3, -80.0, -70.0, 2, 0.0)
                .unwrap()
                .unwrap();
        assert_same(&v["declination_deg"], &wasm.declination_deg, "export");
        assert_eq!(v["decimal_year"], wasm.decimal_year);
        // No model: null, exit 0.
        let v = json_of(&[
            "magnetic-grid",
            "--utc",
            "1850-01-01T00:00:00Z",
            "--lat-range",
            "0,1",
            "--lon-range",
            "0,1",
            "--rows",
            "1",
            "--cols",
            "1",
        ]);
        assert!(v.is_null());
    }

    #[test]
    fn compass_error_is_the_export_and_its_variation_the_models() {
        let t = "2026-09-24T21:40:00Z";
        let v = run_json(&[
            &["compass-error"],
            &PHL,
            &[
                "--height",
                "12",
                "--utc",
                t,
                "--body",
                "Sun",
                "--bearing",
                "272",
            ],
        ]);
        let req = json!({"method": "azimuth", "body": "Sun", "jd_utc": jd(t),
                         "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12.0},
                         "compass_bearing_deg": 272.0, "compass": "magnetic"});
        let wasm = skyfix_wasm::geomag::compass_error_impl(&req.to_string()).unwrap();
        assert_same(&v, &wasm, "compass-error");
        // The API's worked values.
        assert!((v["compass_error_deg"].as_f64().unwrap() + 14.448).abs() < 5e-4);
        assert!((v["deviation_deg"].as_f64().unwrap() + 2.642).abs() < 5e-4);
        let field =
            skyfix_geomag::field_at_jd(39.9526, -75.1652, 12.0, jd(t), ModelChoice::Auto).unwrap();
        assert!((v["variation"]["deg"].as_f64().unwrap() - field.declination_deg).abs() < TOL);
        // An amplitude, a gyro and a chart variation.
        let v = run_json(&[
            &["compass-error"],
            &PHL,
            &[
                "--utc",
                "2026-09-24T22:50:00Z",
                "--body",
                "Sun",
                "--bearing",
                "285",
                "--method",
                "amplitude",
                "--height-of-eye",
                "3",
                "--limb",
                "lower",
                "--variation",
                "-12",
                "--variation-sigma",
                "0.5",
            ],
        ]);
        let req = json!({"method": "amplitude", "body": "Sun", "jd_utc": jd("2026-09-24T22:50:00Z"),
                         "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652},
                         "compass_bearing_deg": 285.0, "variation_deg": -12.0,
                         "variation_sigma_deg": 0.5, "height_of_eye_m": 3.0, "limb": "lower"});
        let wasm = skyfix_wasm::geomag::compass_error_impl(&req.to_string()).unwrap();
        assert_same(&v, &wasm, "amplitude");
        assert_eq!(v["variation"]["source"], "given");
        skyfix([
            "compass-error",
            "--lat",
            "0",
            "--lon",
            "0",
            "--utc",
            t,
            "--body",
            "Sun",
            "--bearing",
            "90",
            "--limb",
            "lower",
        ])
        .expect_code(1)
        .expect_stderr("--method amplitude");
    }
}

// ---------------------------------------------------------------------------
// Sailings, dead reckoning, star identification, the star finder
// ---------------------------------------------------------------------------

mod sailings {
    use super::*;
    use skyfix_core::sailings::{DrRequest, PassageRequest, RouteRequest};

    #[test]
    fn a_sailing_is_the_passage_the_api_documents() {
        let v = json_of(&[
            "sailing",
            "--from",
            "36.9617,-75.7033",
            "--to",
            "45.6517,-1.4967",
            "--every-deg-lon",
            "10",
            "--limiting-lat",
            "47",
            "--speed",
            "12",
            "--departure",
            "2026-10-01T12:00:00Z",
        ]);
        let req: PassageRequest = serde_json::from_value(json!({
            "from": {"lat_deg": 36.9617, "lon_deg": -75.7033},
            "to": {"lat_deg": 45.6517, "lon_deg": -1.4967},
            "waypoints": {"every_deg_lon": 10}, "limiting_latitude_deg": 47,
            "meridional_parts": "sphere", "speed_kn": 12,
            "departure_utc": "2026-10-01T12:00:00Z"}))
        .unwrap();
        let want = skyfix_core::sailings::passage(&req).unwrap();
        assert_same(&v, &want, "sailing");
        assert!((v["great_circle"]["distance_nm"].as_f64().unwrap() - 3264.54).abs() < 0.01);
        let wasm =
            skyfix_wasm::sailings::sailing_impl(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_same(&v, &wasm, "export");
        // WGS84 meridional parts reach the rhumb line only.
        let v = json_of(&[
            "sailing",
            "--from",
            "36.9617,-75.7033",
            "--to",
            "45.6517,-1.4967",
            "--meridional-parts",
            "wgs84",
            "--every-nm",
            "500",
        ]);
        assert_eq!(v["rhumb_line"]["meridional_parts"], "wgs84");
        assert!(v["great_circle"]["waypoints"].as_array().unwrap().len() > 6);
    }

    #[test]
    fn dead_reckoning_and_routes_are_the_library() {
        let v = json_of(&[
            "dr-advance",
            "--from",
            "44.605,-31.305",
            "--course",
            "270",
            "--speed",
            "17",
            "--hours",
            "4.5",
            "--start",
            "2026-10-01T15:30:00Z",
        ]);
        let req: DrRequest = serde_json::from_value(json!({
            "from": {"lat_deg": 44.605, "lon_deg": -31.305}, "course_deg": 270, "speed_kn": 17,
            "hours": 4.5, "method": "rhumb", "meridional_parts": "sphere",
            "start_utc": "2026-10-01T15:30:00.000Z"}))
        .unwrap();
        assert_same(
            &v,
            &skyfix_core::sailings::dead_reckoning(&req).unwrap(),
            "dr",
        );
        let v = json_of(&[
            "dr-advance",
            "--from",
            "44.605,-31.305",
            "--course",
            "45",
            "--speed",
            "10",
            "--hours",
            "-3",
            "--method",
            "great-circle",
        ]);
        assert_eq!(v["method"], "great_circle");
        assert!(v["to"]["lat_deg"].as_f64().unwrap() < 44.605);

        let v = json_of(&[
            "route-positions",
            "--start",
            "40,-70",
            "--start-utc",
            "2026-10-01T00:00:00Z",
            "--leg",
            "90,10",
            "--leg",
            "2026-10-01T03:00:00Z,0,10",
            "--end-utc",
            "2026-10-01T06:00:00Z",
            "--at",
            "2026-10-01T02:00:00Z",
            "--at",
            "2026-10-01T07:00:00Z",
            "--step",
            "60",
        ]);
        let req: RouteRequest = serde_json::from_value(json!({
            "start": {"lat_deg": 40.0, "lon_deg": -70.0}, "start_utc": "2026-10-01T00:00:00.000Z",
            "legs": [{"course_deg": 90, "speed_kn": 10},
                     {"start_utc": "2026-10-01T03:00:00.000Z", "course_deg": 0, "speed_kn": 10}],
            "end_utc": "2026-10-01T06:00:00.000Z", "method": "rhumb",
            "times_utc": ["2026-10-01T02:00:00.000Z", "2026-10-01T07:00:00.000Z"],
            "step_minutes": 60}))
        .unwrap();
        let want = skyfix_core::sailings::route_positions(&req).unwrap();
        assert_same(&v, &want, "route");
        let wasm =
            skyfix_wasm::sailings::route_positions_impl(&serde_json::to_string(&req).unwrap())
                .unwrap();
        assert_same(&v, &wasm, "export");
    }

    #[test]
    fn star_identification_finds_vega() {
        let v = json_of(&[
            "star-id",
            "--lat",
            "39.95",
            "--lon",
            "-75.17",
            "--height-of-eye",
            "2.5",
            "--ic",
            "-1.2",
            "--utc",
            "2026-10-01T00:30:00Z",
            "--altitude",
            "72.59",
            "--bearing",
            "286",
            "--bearing-kind",
            "compass",
            "--variation",
            "-12.5",
            "--deviation",
            "0",
        ]);
        let req = json!({"utc": "2026-10-01T00:30:00.000Z",
            "observer": {"lat_deg": 39.95, "lon_deg": -75.17, "height_of_eye_m": 2.5},
            "instrument": {"index_correction_arcmin": -1.2},
            "altitude_deg": 72.59, "altitude_kind": "sextant_hs",
            "bearing_deg": 286, "bearing_kind": "compass", "variation_deg": -12.5,
            "deviation_deg": 0});
        let parsed: skyfix_core::methods::starid::StarIdRequest =
            serde_json::from_value(req.clone()).unwrap();
        let want = skyfix_core::methods::starid::star_identify(
            &parsed,
            &skyfix_wasm::sailings::SkyStarIdSource::new(),
        )
        .unwrap();
        assert_same(&v, &want, "star-id");
        assert_eq!(v["best"], "Vega");
        let wasm = skyfix_wasm::sailings::star_identify_impl(&req.to_string()).unwrap();
        assert_same(&v, &wasm, "export");
    }

    #[test]
    fn the_shore_horizon_and_the_index_log_reach_the_reduction() {
        let v = json_of(&[
            "star-id",
            "--lat",
            "39.95",
            "--lon",
            "-75.17",
            "--height-of-eye",
            "10",
            "--shore",
            "0.5",
            "--ic-log",
            "2026-10-01T00:00:00Z,-1.0",
            "--ic-log",
            "2026-10-01T01:00:00Z,-2.0",
            "--utc",
            "2026-10-01T00:30:00Z",
            "--altitude",
            "72.5",
            "--bearing",
            "273.5",
        ]);
        let steps = v["corrections"]["steps"].as_array().unwrap();
        let ic = steps
            .iter()
            .find(|s| s["kind"] == "index_correction")
            .unwrap();
        // Halfway between the two entries: -1.5' (a difference of degrees, so to 1e-6').
        assert!(
            (ic["delta_arcmin"].as_f64().unwrap() + 1.5).abs() < 1e-6,
            "{ic}"
        );
        let dip = steps.iter().find(|s| s["kind"] == "dip").unwrap();
        assert!(
            dip["note"].as_str().unwrap().contains("shore")
                || dip["note"].as_str().unwrap().contains("short"),
            "{dip}"
        );
        // The same flags on predict: the log's value at the sight's time.
        let p = json_of(&[
            "predict",
            "--lat",
            "39.95",
            "--lon",
            "-75.17",
            "--utc",
            "2026-10-01T00:30:00Z",
            "--body",
            "Vega",
            "--ic-log",
            "2026-10-01T00:00:00Z,-1.0",
            "--ic-log",
            "2026-10-01T01:00:00Z,-2.0",
        ]);
        let ic = p["corrections"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["kind"] == "index_correction")
            .unwrap()
            .clone();
        assert!(
            (ic["delta_arcmin"].as_f64().unwrap() + 1.5).abs() < 1e-6,
            "{ic}"
        );
        skyfix([
            "predict",
            "--lat",
            "0",
            "--lon",
            "0",
            "--utc",
            "2026-10-01T00:30:00Z",
            "--body",
            "Vega",
            "--ic",
            "-1",
            "--ic-log",
            "2026-10-01T00:00:00Z,-1.0",
        ])
        .expect_code(1);
    }

    #[test]
    fn the_star_finder_is_the_export() {
        let v = json_of(&["star-finder", "--lat", "39.95"]);
        let wasm = skyfix_wasm::sailings::star_finder_geometry_impl(39.95, None).unwrap();
        assert_same(&v, &wasm, "star-finder");
        assert_eq!(v["template_latitude_deg"], 35.0);
        assert_eq!(v["stars"].as_array().unwrap().len(), 58);
        let t = skyfix_core::methods::starfinder::template(35.0).unwrap();
        assert_same(&v["template"], &t, "the template");
        let v = json_of(&[
            "star-finder",
            "--lat",
            "-33.9",
            "--utc",
            "2026-10-01T00:00:00Z",
        ]);
        let wasm = skyfix_wasm::sailings::star_finder_geometry_impl(
            -33.9,
            Some(jd("2026-10-01T00:00:00Z")),
        )
        .unwrap();
        assert_same(&v, &wasm, "southern, apparent places");
        assert_eq!(v["side"], "south");
    }
}

// ---------------------------------------------------------------------------
// Time scales and calendars
// ---------------------------------------------------------------------------

mod time {
    use super::*;
    use skyfix_core::calendar::{Calendar, CalendarConvertRequest, CivilInput};

    #[test]
    fn time_info_is_the_core_with_the_tier() {
        let v = json_of(&["time-info", "2026-09-24T12:00:00Z"]);
        let t = skyfix_core::time::time_info(jd("2026-09-24T12:00:00Z"), None).unwrap();
        assert_includes(&v, &t, "time-info");
        assert_eq!(v["tier"], "validated");
        assert_same(
            &v,
            &skyfix_wasm::timescale::native::time_info(jd("2026-09-24T12:00:00Z")).unwrap(),
            "export",
        );
        // --dut1 is the site's field: a user value, with its sigma.
        let v = json_of(&["time-info", "2026-09-24T12:00:00Z", "--dut1", "-0.3"]);
        let t = skyfix_core::time::time_info(jd("2026-09-24T12:00:00Z"), Some(-0.3)).unwrap();
        assert_includes(&v, &t, "time-info with DUT1");
        assert_eq!(v["dut1_source"], "user");
        // Far dates: UT, the Julian calendar, Delta-T's sigma.
        let v = json_of(&["time-info", "-0584-05-28T12:00:00Z"]);
        assert_eq!(v["scale"], "ut");
        assert_eq!(v["calendar"], "julian");
        assert_eq!(v["civil"]["day"], 28);
        let v = json_of(&["time-info", "--jd", "2461308"]);
        assert_eq!(v["utc"], "2026-09-24T12:00:00.000Z");
    }

    #[test]
    fn calendar_convert_sends_the_civil_date_as_typed() {
        let v = json_of(&["calendar-convert", "-0584-05-28T12:00:00Z"]);
        let want = skyfix_core::calendar::calendar_convert(&CalendarConvertRequest {
            jd_utc: None,
            civil: Some(CivilInput {
                calendar: Calendar::Julian,
                year: -584,
                month: 5,
                day: 28,
                hour: Some(12),
                minute: Some(0),
                second: Some(0.0),
                era_year: None,
                era: None,
            }),
        })
        .unwrap();
        assert_same(&v, &want, "calendar-convert");
        assert_eq!(v["jd_utc"], 1_507_900.0);
        assert_eq!(v["gregorian"]["day"], 22);
        // --calendar decides the typed date's calendar; auto is the display rule.
        let g = json_of(&["calendar-convert", "1752-09-14", "--calendar", "gregorian"]);
        let j = json_of(&["calendar-convert", "1752-09-03", "--calendar", "julian"]);
        assert_eq!(g["jd_utc"], j["jd_utc"]);
        // auto is the display rule: Gregorian after the 1582 reform, Julian before it.
        let a = json_of(&["calendar-convert", "1752-09-14", "--calendar", "auto"]);
        assert_eq!(a["jd_utc"], g["jd_utc"]);
        let a = json_of(&["calendar-convert", "1500-03-01", "--calendar", "auto"]);
        let j = json_of(&["calendar-convert", "1500-03-01", "--calendar", "julian"]);
        assert_eq!(a["jd_utc"], j["jd_utc"]);
        let wasm =
            skyfix_wasm::timescale::native::calendar_convert(r#"{"jd_utc": 2361221.5}"#).unwrap();
        let v = json_of(&["calendar-convert", "--jd", "2361221.5"]);
        assert_same(&v, &wasm, "export");
    }
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

mod packs {
    use super::*;

    fn sidecar(name: &str) -> Value {
        let text = std::fs::read_to_string(packs_dir().join(format!("{name}.json"))).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn packs_lists_the_registry_and_what_was_loaded() {
        let v = json_of(&["packs"]);
        let names: Vec<&str> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        let registry: Vec<&str> = skyfix_wasm::packs::PRODUCERS
            .iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, registry);
        assert!(v.as_array().unwrap().iter().all(|p| p["loaded"] == false));

        let tides = pack_arg("tides-us");
        let v = json_of(&["packs", "--pack", &tides]);
        let t = v
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "tides-us")
            .unwrap();
        let side = sidecar("tides-us");
        assert_eq!(t["loaded"], true);
        assert_eq!(t["version"], side["version"]);
        assert_eq!(t["bytes"], side["bytes"]);
        assert_eq!(t["label"], side["label"]);
        assert_eq!(t["provides"], side["provides"]);
        // The same list the site's packs() gives after load_pack: in a fresh registry.
        let mut reg = skyfix_wasm::packs::Packs::new(skyfix_wasm::packs::PRODUCERS);
        reg.load("tides-us", &std::fs::read(pack_file("tides-us")).unwrap())
            .unwrap();
        assert_same(&v, &reg.status(), "the export");
    }

    #[test]
    fn a_pack_by_file_or_by_name_and_a_refused_one() {
        let file = pack_file("tides-us").to_string_lossy().into_owned();
        let v = json_of(&["tide-pack", "--pack", &file]);
        assert_eq!(v["name"], "tides-us");
        assert_eq!(v["stations"], 3499);
        let v = json_of(&["tide-pack"]);
        assert!(v.is_null(), "no pack, no info: {v}");
        // A file that is not a pack is refused with the site's sentence, exit 1.
        let junk = support::write_tmp("junk.bin", "not a pack");
        skyfix(["packs", "--pack", junk.to_str().unwrap()])
            .expect_code(1)
            .expect_stderr("does not start with SKYFIXPK");
        skyfix(["packs", "--pack", "no/such/dir/tides-us"])
            .expect_code(1)
            .expect_stderr("no such file");
    }
}

// ---------------------------------------------------------------------------
// The Moon in detail
// ---------------------------------------------------------------------------

mod moon {
    use super::*;
    use skyfix_almanac::occultations::{OccultationOptions, planet_targets};
    use skyfix_ephemeris::moon::MoonProvider;
    use skyfix_ephemeris::planets::PlanetProvider;
    use skyfix_ephemeris::sun::SunProvider;
    use skyfix_wasm::moondetail::native;

    #[test]
    fn orientation_and_features_with_and_without_an_observer() {
        let t = "2026-09-25T02:24:00Z";
        let v = run_json(&[&["moon-orientation"], &PHL, &["--height", "10", "--utc", t]]);
        let site = Site {
            height_m: 10.0,
            ..phl()
        };
        let want = skyfix_almanac::libration::moon_orientation(
            &MoonProvider::new(),
            &SunProvider::new(),
            Some(&site),
            jd(t),
        )
        .unwrap();
        assert_same(&v, &want, "moon-orientation");
        assert_eq!(v["topocentric"], true);
        let v = json_of(&["moon-orientation", "--utc", t]);
        assert_same(
            &v,
            &native::moon_orientation("", jd(t)).unwrap(),
            "geocentric",
        );
        assert_eq!(v["topocentric"], false);

        let v = run_json(&[&["moon-features"], &PHL, &["--utc", t]]);
        let want = skyfix_almanac::lunar_features::moon_features(
            &MoonProvider::new(),
            &SunProvider::new(),
            Some(&phl()),
            jd(t),
        )
        .unwrap();
        assert_same(&v, &want, "moon-features");
        assert_eq!(v["features"].as_array().unwrap().len(), 150);
    }

    #[test]
    fn apsides_are_the_library() {
        let v = json_of(&["moon-apsides", "--from", "2026-01-01", "--to", "2026-02-28"]);
        let (s, e) = (jd("2026-01-01T00:00:00Z"), jd("2026-03-01T00:00:00Z"));
        let want =
            skyfix_almanac::apsides::moon_apsides(&MoonProvider::new(), &Sky::new(), s, e).unwrap();
        assert_same(&v, &want, "moon-apsides");
        assert_same(&v, &native::moon_apsides(s, e).unwrap(), "export");
        // The full Moon of 3 January 2026 is a supermoon.
        let first = v["syzygies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["kind"] == "full_moon")
            .unwrap()
            .clone();
        assert_eq!(first["supermoon"], true, "{first}");
    }

    #[test]
    fn occultations_of_the_planets_and_of_the_stars() {
        // Venus occulted from Philadelphia on 2026-06-17.
        let v = run_json(&[
            &["occultations"],
            &PHL,
            &["--from", "2026-06-15", "--to", "2026-06-20", "--no-stars"],
        ]);
        let (s, e) = (jd("2026-06-15T00:00:00Z"), jd("2026-06-21T00:00:00Z"));
        let want = skyfix_almanac::occultations::occultations(
            &MoonProvider::new(),
            &SunProvider::new(),
            &PlanetProvider::new(),
            &phl(),
            s,
            e,
            &planet_targets(),
            &OccultationOptions::default(),
        )
        .unwrap();
        assert_same(&v, &want, "occultations of the planets");
        assert!(
            v["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|ev| ev["body"] == "Venus" && ev["occulted"] == true)
        );
        // The default search (the 58 stars and the catalogue's to 3.5) is the export's.
        let v = run_json(&[
            &["occultations"],
            &PHL,
            &["--from", "2026-02-01", "--to", "2026-02-05"],
        ]);
        let (s, e) = (jd("2026-02-01T00:00:00Z"), jd("2026-02-06T00:00:00Z"));
        assert_same(
            &v,
            &native::occultations(&phl_json(), s, e, "").unwrap(),
            "export",
        );
        assert!(
            v["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|ev| ev["body"] == "Regulus")
        );
        let v = run_json(&[
            &["occultations"],
            &PHL,
            &[
                "--from",
                "2026-02-01",
                "--to",
                "2026-02-05",
                "--body",
                "Regulus",
                "--no-near-misses",
                "--below-horizon",
                "--max-magnitude",
                "2",
            ],
        ]);
        let opts = r#"{"max_magnitude": 2, "include_below_horizon": true,
                       "include_near_misses": false, "bodies": ["Regulus"]}"#;
        assert_same(
            &v,
            &native::occultations(&phl_json(), s, e, opts).unwrap(),
            "options",
        );
        assert_eq!(v["events"].as_array().unwrap().len(), 1);
    }
}

// ---------------------------------------------------------------------------
// Deep sky
// ---------------------------------------------------------------------------

mod deepsky {
    use super::*;
    use skyfix_starfield::extinction::SkyConditions;
    use skyfix_starfield::{dso, extinction, milkyway, search, showers, tonight};
    use skyfix_wasm::deepsky::native;

    fn conditions(bortle: Option<u8>) -> extinction::Conditions {
        SkyConditions {
            bortle,
            nelm: None,
            k: None,
        }
        .resolve()
        .unwrap()
    }

    #[test]
    fn the_catalogue_and_a_list_rebuild_the_exports_objects() {
        let v = json_of(&["dso-catalog"]);
        assert_same(&v["objects"], dso::catalog().unwrap(), "objects");
        assert_eq!(v["source"], dso::SOURCE);
        assert_eq!(v["objects"].as_array().unwrap().len(), 213);

        let t = "2026-09-25T02:00:00Z";
        let v = run_json(&[
            &["dso-list"],
            &PHL,
            &[
                "--utc",
                t,
                "--kind",
                "galaxy",
                "--max-magnitude",
                "7",
                "--above-horizon",
            ],
        ]);
        let p = dso::list(
            Some(&phl()),
            jd(t),
            &serde_json::from_str(
                r#"{"kinds": ["galaxy"], "max_magnitude": 7, "above_horizon": true}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let [alt, az, app] = p.horizon.clone().unwrap();
        let want = json!({"jd_utc": p.jd_utc, "index": p.index, "ra_deg": p.ra_deg,
                          "dec_deg": p.dec_deg, "alt_deg": alt, "az_deg": az,
                          "alt_apparent_deg": app});
        assert_same(&v, &want, "dso-list");
        assert_eq!(v["index"].as_array().unwrap().len(), 3);
        let v = json_of(&["dso-list", "--utc", t]);
        assert!(v["alt_deg"].is_null() && v["az_deg"].is_null());
        let wasm = native::dso_list("", jd(t), "").unwrap();
        assert_same(&v["ra_deg"], &wasm.ra_deg, "export");
    }

    #[test]
    fn one_object_through_the_night() {
        let t = "2026-09-24T22:00:00Z";
        let v = run_json(&[&["dso", "m31"], &PHL, &["--utc", t, "--bortle", "4"]]);
        let want =
            dso::visibility(&Sky::new(), "m31", &phl(), jd(t), &conditions(Some(4))).unwrap();
        assert_same(&v, &want, "dso");
        assert_same(
            &v,
            &native::dso_visibility("M 31", &phl_json(), jd(t), r#"{"bortle": 4}"#).unwrap(),
            "export",
        );
    }

    #[test]
    fn showers_with_and_without_an_observer() {
        let v = json_of(&["showers", "--year", "2026"]);
        let want = showers::year(&Sky::new(), 2026, None, &conditions(None)).unwrap();
        assert_same(&v, &want, "showers");
        let v = run_json(&[&["showers"], &PHL, &["--year", "2026", "--nelm", "6.2"]]);
        assert_same(
            &v,
            &native::meteor_showers(2026.0, &phl_json(), r#"{"nelm": 6.2}"#).unwrap(),
            "export",
        );
        skyfix(["showers", "--year", "2026", "--bortle", "3"])
            .expect_code(1)
            .expect_stderr("--lat --lon");
    }

    #[test]
    fn the_milky_way_search_tonight_and_extinction() {
        let v = json_of(&["milky-way"]);
        let o = milkyway::outline().unwrap();
        assert_same(&v["levels"], &o.levels, "levels");
        assert_eq!(v["rings"].as_array().unwrap().len(), o.rings.len());
        assert_same(&v["rings"][3]["ra_deg"], &o.rings[3].ra_deg, "a ring");
        assert_eq!(v["source"], milkyway::SOURCE);

        let t = "2026-09-25T02:00:00Z";
        let v = run_json(&[&["search", "m31"], &PHL, &["--utc", t, "--limit", "3"]]);
        let want = search::search(&Sky::new(), "m31", Some(&phl()), Some(jd(t)), Some(3)).unwrap();
        assert_same(&v, &want, "search");
        let v = json_of(&["search", "alpha cen"]);
        assert_same(
            &v,
            &native::sky_search("alpha cen", "", None, None).unwrap(),
            "export",
        );
        skyfix(["search", "vega", "--lat", "0", "--lon", "0"])
            .expect_code(1)
            .expect_stderr("needs a time");

        let t = "2026-09-24T22:00:00Z";
        let v = run_json(&[
            &["tonight"],
            &PHL,
            &["--utc", t, "--limit", "5", "--bortle", "3"],
        ]);
        let want =
            tonight::tonight(&Sky::new(), &phl(), jd(t), &conditions(Some(3)), Some(5)).unwrap();
        assert_same(&v, &want, "tonight");
        assert_eq!(v["deep_sky"].as_array().unwrap().len(), 5);

        let v = json_of(&["extinction", "--nelm", "6.5", "--extinction", "0.3"]);
        let c = SkyConditions {
            bortle: None,
            nelm: Some(6.5),
            k: Some(0.3),
        }
        .resolve()
        .unwrap();
        let tab = extinction::table(&c);
        let want = json!({"conditions": tab.conditions, "alt_deg": tab.alt_deg,
                          "airmass": tab.airmass, "extinction_mag": tab.extinction_mag,
                          "limiting_mag": tab.limiting_mag, "model": tab.model});
        assert_same(&v, &want, "extinction");
    }
}

// ---------------------------------------------------------------------------
// Planet detail
// ---------------------------------------------------------------------------

mod planets {
    use super::*;
    use skyfix_almanac::{conjunctions, discs, earth_apsides, orbits, rings, satellites, transits};
    use skyfix_ephemeris::planets::{Planet, PlanetProvider};
    use skyfix_wasm::planetdetail::native;

    const CERES: &str = r#"[{"name": "(1) Ceres", "designation": "(1)", "class": "asteroid",
        "epoch_jd_tt": 2461200.5, "perihelion_distance_au": 2.545159, "eccentricity": 0.079692,
        "inclination_deg": 10.58803, "ascending_node_deg": 80.24863,
        "argument_of_perihelion_deg": 73.2942, "perihelion_jd_tt": 2459919.988326,
        "magnitude": {"model": "hg", "h": 3.34, "g": 0.15}, "source": "mpcorb"}]"#;

    #[test]
    fn jupiters_moons_saturns_rings_and_a_disc() {
        let t = "2026-01-10T00:00:00Z";
        let v = json_of(&["galilean-moons", "--utc", t]);
        assert_same(
            &v,
            &satellites::galilean_moons(jd(t)).unwrap(),
            "galilean-moons",
        );
        let v = json_of(&[
            "galilean-events",
            "--from",
            "2026-01-10",
            "--to",
            "2026-01-11",
        ]);
        let (s, e) = (jd("2026-01-10T00:00:00Z"), jd("2026-01-12T00:00:00Z"));
        assert_same(
            &v,
            &satellites::galilean_events(s, e).unwrap(),
            "galilean-events",
        );
        assert_same(&v, &native::galilean_events(s, e).unwrap(), "export");

        let t = "2026-09-24T00:00:00Z";
        let v = json_of(&["saturn-rings", "--utc", t]);
        let want = rings::saturn_rings(&PlanetProvider::new(), jd(t)).unwrap();
        assert_same(&v, &want, "saturn-rings");
        let v = json_of(&["planet-disc", "--body", "jupiter", "--utc", t]);
        let want = discs::planet_disc(&PlanetProvider::new(), Planet::Jupiter, jd(t)).unwrap();
        assert_same(&v, &want, "planet-disc");
        skyfix(["planet-disc", "--body", "Pluto", "--utc", t])
            .expect_code(1)
            .expect_stderr("is not a planet");
    }

    #[test]
    fn transits_conjunctions_stations_and_the_earths_apsides() {
        let v = run_json(&[
            &["transits"],
            &PHL,
            &[
                "--height",
                "12",
                "--from",
                "2012-06-05",
                "--to",
                "2012-06-07",
            ],
        ]);
        let (s, e) = (jd("2012-06-05T00:00:00Z"), jd("2012-06-08T00:00:00Z"));
        let site = Site {
            height_m: 12.0,
            ..phl()
        };
        let want = transits::transits(&PlanetProvider::new(), s, e, Some(&site)).unwrap();
        assert_same(&v, &want, "transits");
        assert_eq!(v["transits"][0]["id"], "2012-06-06-venus");

        let v = run_json(&[
            &["conjunctions"],
            &PHL,
            &[
                "--from",
                "2020-12-15",
                "--to",
                "2020-12-25",
                "--planets",
                "Jupiter,Saturn,Venus",
                "--stars",
                "none",
                "--no-moon",
                "--max-separation",
                "3",
            ],
        ]);
        let (s, e) = (jd("2020-12-15T00:00:00Z"), jd("2020-12-26T00:00:00Z"));
        let opts: conjunctions::ConjunctionOptions = serde_json::from_value(json!({
            "planets": ["Jupiter", "Saturn", "Venus"], "moon": false, "stars": [],
            "max_separation_deg": 3.0,
            "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652}}))
        .unwrap();
        let want = conjunctions::conjunctions(s, e, &opts).unwrap();
        assert_same(&v, &want, "conjunctions");
        assert_eq!(v["conjunctions"][0]["body"], "Jupiter");
        let v = json_of(&["conjunctions", "--from", "2020-12-01", "--to", "2020-12-31"]);
        let (s, e) = (jd("2020-12-01T00:00:00Z"), jd("2021-01-01T00:00:00Z"));
        assert_same(&v, &native::conjunctions(s, e, "").unwrap(), "export");

        let v = json_of(&["stations", "--from", "2024-11-01", "--to", "2024-12-31"]);
        let (s, e) = (jd("2024-11-01T00:00:00Z"), jd("2025-01-01T00:00:00Z"));
        assert_same(&v, &conjunctions::stations(s, e).unwrap(), "stations");

        let v = json_of(&["earth-apsides", "--year", "2026"]);
        assert_same(
            &v,
            &earth_apsides::earth_apsides(2026).unwrap(),
            "earth-apsides",
        );
    }

    #[test]
    fn an_orbit_read_placed_and_tracked() {
        let path = support::write_tmp("ceres.elements.json", CERES);
        let file = path.to_str().unwrap();
        let v = json_of(&["orbit", file]);
        assert_same(
            &v,
            &orbits::parse_orbits(CERES).unwrap(),
            "orbit (elements)",
        );

        let t = "2026-09-24T12:00:00Z";
        let v = run_json(&[&["orbit", file], &PHL, &["--height", "12", "--utc", t]]);
        let obs = json!({"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12.0}).to_string();
        let elements = serde_json::to_string(&orbits::parse_orbits(CERES).unwrap()).unwrap();
        assert_same(
            &v,
            &native::custom_body_states(&obs, jd(t), &elements).unwrap(),
            "orbit (states)",
        );
        let site = Site {
            height_m: 12.0,
            ..phl()
        };
        let el = &orbits::parse_orbits(CERES).unwrap()[0];
        let st = orbits::custom_body_state(el, &site, jd(t)).unwrap();
        assert!((v["bodies"][0]["ra_deg"].as_f64().unwrap() - st.state.ra_deg).abs() < TOL);
        assert!(
            (v["bodies"][0]["alt_apparent_deg"].as_f64().unwrap() - st.state.alt_apparent_deg)
                .abs()
                < TOL
        );

        let v = run_json(&[
            &["orbit", file],
            &PHL,
            &[
                "--from",
                "2026-09-24T00:00:00Z",
                "--to",
                "2026-09-24T03:00:00Z",
                "--step",
                "60",
            ],
        ]);
        let (times, bodies, errors) = native::sample_custom_bodies(
            &phl_json(),
            &elements,
            jd("2026-09-24T00:00:00Z"),
            jd("2026-09-24T03:00:00Z"),
            60.0,
        )
        .unwrap();
        let want = json!({"jd_utc": times, "bodies": bodies, "errors": errors});
        assert_same(&v, &want, "orbit (tracks)");
        assert_eq!(v["jd_utc"].as_array().unwrap().len(), 4);
    }
}

// ---------------------------------------------------------------------------
// Tides (the tides-us pack)
// ---------------------------------------------------------------------------

mod tides {
    use super::*;
    use skyfix_tides::api;

    fn db() -> skyfix_tides::TideDb {
        skyfix_tides::pack::decode_file(&std::fs::read(pack_file("tides-us")).unwrap()).unwrap()
    }

    #[test]
    fn every_tide_command_is_the_library_on_the_committed_pack() {
        let pack = pack_arg("tides-us");
        let p = ["--pack", pack.as_str()];
        let db = db();

        let v = run_json(&[
            &[
                "tide-stations",
                "--lat",
                "37.8",
                "--lon",
                "-122.4",
                "--count",
                "4",
            ],
            &p,
        ]);
        assert_same(
            &v,
            &api::stations_near(&db, 37.8, -122.4, 4).unwrap(),
            "stations",
        );
        let v = run_json(&[&["tide-station", "9414290"], &p]);
        assert_same(&v, &api::station_by_id(&db, "9414290").unwrap(), "station");

        let (s, e) = (jd("2026-09-24T07:00:00Z"), jd("2026-09-25T07:00:00Z"));
        let v = run_json(&[
            &[
                "tide-extremes",
                "9414290",
                "--from",
                "2026-09-24",
                "--to",
                "2026-09-24",
            ],
            &["--zone", "-07:00"],
            &p,
        ]);
        assert_same(
            &v,
            &api::extremes(&db, "9414290", s, e, "").unwrap(),
            "extremes",
        );
        let v = run_json(&[
            &[
                "tide-predict",
                "9414290",
                "--from",
                "2026-09-24",
                "--to",
                "2026-09-24",
            ],
            &["--zone", "-07:00", "--step", "30", "--datum", "MSL"],
            &p,
        ]);
        let want = api::predict(&db, "9414290", s, e, 30.0, "MSL").unwrap();
        assert_same(&v, &want, "predict");
        assert_eq!(v["datum"], "MSL");
        let v = run_json(&[
            &["tide-now", "9414290", "--utc", "2026-09-24T19:00:00Z"],
            &p,
        ]);
        let want = api::now(&db, "9414290", jd("2026-09-24T19:00:00Z"), "").unwrap();
        assert_same(&v, &want, "now");
        // A subordinate station, through the export on the same database.
        let v = run_json(&[
            &[
                "tide-extremes",
                "9414305",
                "--from",
                "2026-09-24",
                "--to",
                "2026-09-25",
            ],
            &p,
        ]);
        let (s, e) = (jd("2026-09-24T00:00:00Z"), jd("2026-09-26T00:00:00Z"));
        let wasm = skyfix_wasm::tides::native::extremes_in(Some(&db), "9414305", s, e, "").unwrap();
        assert_same(&v, &wasm, "export");
        assert_eq!(v["method"], "subordinate_offsets");
    }

    #[test]
    fn without_the_pack_every_tide_command_says_how_to_load_it() {
        skyfix(["tide-station", "9414290"])
            .expect_code(1)
            .expect_stderr("pack_not_loaded")
            .expect_stderr("--pack web/public/data/packs/tides-us");
        let pack = pack_arg("tides-us");
        skyfix(["tide-station", "0000000", "--pack", &pack])
            .expect_code(1)
            .expect_stderr("unknown_station");
    }
}

// ---------------------------------------------------------------------------
// The lunar limb (the lunar-limb pack)
// ---------------------------------------------------------------------------

mod limb {
    use super::*;
    use skyfix_almanac::eclipses::{Eclipses, LimbRing, profile_at};
    use skyfix_ephemeris::moon::MoonProvider;
    use skyfix_ephemeris::sun::SunProvider;

    fn ring() -> LimbRing {
        let bytes = std::fs::read(pack_file("lunar-limb")).unwrap();
        let h = skyfix_wasm::packs::parse(&bytes).unwrap();
        LimbRing::parse(h.payload).unwrap()
    }

    const DALLAS: [&str; 6] = ["--lat", "32.7767", "--lon", "-96.797", "--height", "150"];

    fn dallas() -> Site {
        Site {
            lat_deg: 32.7767,
            lon_deg: -96.797,
            height_m: 150.0,
            ..Site::default()
        }
    }

    #[test]
    fn eclipse_limb_is_the_limb_corrected_local_circumstances() {
        let pack = pack_arg("lunar-limb");
        let v = run_json(&[
            &["eclipse", "2024-04-08-solar"],
            &DALLAS,
            &["--limb", "--pack", &pack],
        ]);
        let r = ring();
        let want = Eclipses::with_user_dut1(None)
            .local_with_limb("2024-04-08-solar", &dallas(), Some(&r))
            .unwrap();
        assert_same(&v["local"], &want, "eclipse --limb");
        assert_eq!(v["local"]["limb"]["loaded"], true);
        let wasm = skyfix_wasm::limb::native::eclipse_local_limb_in(
            Some(&r),
            "2024-04-08-solar",
            r#"{"lat_deg": 32.7767, "lon_deg": -96.797, "height_m": 150}"#,
        )
        .unwrap();
        assert_same(&v["local"], &wasm, "export");
        // Without the pack: the mean limb and the note, as on the site.
        let v = run_json(&[&["eclipse", "2024-04-08-solar"], &DALLAS, &["--limb"]]);
        assert_eq!(v["local"]["limb"]["loaded"], false);
        // Without --limb the local circumstances are eclipse_local's, with no limb block.
        let v = run_json(&[&["eclipse", "2024-04-08-solar"], &DALLAS]);
        assert!(
            v["local"].get("limb").is_none_or(Value::is_null),
            "{}",
            v["local"]
        );
    }

    #[test]
    fn the_limb_profile_is_the_library_on_the_committed_pack() {
        let pack = pack_arg("lunar-limb");
        let t = "2024-04-08T18:42:39Z";
        let v = run_json(&[&["limb-profile"], &DALLAS, &["--utc", t, "--pack", &pack]]);
        let dut1 = skyfix_core::time::dut1_s(jd(t), None);
        let want = profile_at(
            &ring(),
            &MoonProvider::with_dut1_s(dut1),
            &SunProvider::with_dut1_s(dut1),
            &dallas(),
            jd(t),
        )
        .unwrap();
        assert_same(&v, &want, "limb-profile");
        assert_eq!(v["height_arcsec"].as_array().unwrap().len(), 5760);
        let v = json_of(&["limb-pack", "--pack", &pack]);
        assert_eq!(v["name"], "lunar-limb");
        assert_eq!(v["step_deg"], 0.0625);
        skyfix(["limb-profile", "--lat", "0", "--lon", "0", "--utc", t])
            .expect_code(1)
            .expect_stderr("pack_not_loaded");
    }
}

// ---------------------------------------------------------------------------
// DUT1: the site's field reaches every export that reads it
// ---------------------------------------------------------------------------

mod dut1 {
    use super::*;

    #[test]
    fn dut1_moves_the_sky_the_day_and_the_eclipse_as_the_sites_field_does() {
        let t = "2026-10-01T01:30:00Z";
        let sky =
            |extra: &[&str]| run_json(&[&["sky"], &PHL, &["--utc", t, "--bodies", "Vega"], extra]);
        let auto = sky(&[]);
        let given = sky(&["--dut1", "0.4"]);
        let want = skyfix_almanac::sky::sky_state(&Sky::with_dut1_s(0.4), &phl(), jd(t), &["Vega"])
            .unwrap();
        let mut got = given.clone();
        got["bodies"][0]
            .as_object_mut()
            .unwrap()
            .remove("constellation");
        let mut want = serde_json::to_value(&want).unwrap();
        want["bodies"][0]
            .as_object_mut()
            .unwrap()
            .remove("constellation");
        if let Err(e) = json_close(&got, &want, TOL, "sky --dut1") {
            panic!("{e}");
        }
        // 0.4 s of rotation is 6.0" of GHA.
        let d = given["bodies"][0]["gha_deg"].as_f64().unwrap()
            - auto["bodies"][0]["gha_deg"].as_f64().unwrap();
        let expected = (0.4 - skyfix_core::time::dut1_s(jd(t), None)) * 15.041_068_64 / 3600.0;
        assert!((d - expected).abs() < 1e-7, "{d} vs {expected}");

        let e = run_json(&[&["eclipse", "2024-04-08-solar", "--dut1", "0.5"]]);
        let want = Eclipses::with_user_dut1(Some(0.5))
            .by_id("2024-04-08-solar")
            .unwrap();
        assert_same(&e["eclipse"], &want, "eclipse --dut1");
        skyfix(["sky", "--lat", "0", "--lon", "0", "--utc", t, "--dut1", "5"])
            .expect_code(1)
            .expect_stderr("0.9 s");
    }

    use skyfix_almanac::eclipses::Eclipses;
}
