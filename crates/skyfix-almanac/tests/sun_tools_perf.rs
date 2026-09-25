//! Timings of the sun tools against their budget (EXPANSION_PLAN P7): **a year of daily
//! series in under 200 ms natively**. WASM runs 1.5 to 3 times slower than native.
//!
//! Ignored by default: timings mean nothing in a debug build or on a loaded machine.
//!
//! ```text
//! cargo test --release -p skyfix-almanac --test sun_tools_perf -- --ignored --nocapture
//! ```

use std::time::Instant;

use skyfix_almanac::sun_tools::alignment::{AlignmentEvent, AlignmentRequest, alignment_days};
use skyfix_almanac::sun_tools::analemma::{AnalemmaRequest, ClockKind, analemma};
use skyfix_almanac::sun_tools::azimuth::{AltitudeBand, find_azimuth};
use skyfix_almanac::sun_tools::eot::equation_of_time;
use skyfix_almanac::sun_tools::galactic::{GalacticOptions, galactic_centre_windows};
use skyfix_almanac::sun_tools::hours::sun_hours;
use skyfix_almanac::sun_tools::solar::{Panel, SolarYearRequest, solar_day, solar_year};
use skyfix_almanac::sun_tools::sunpath::{RiseSetRequest, rise_set_azimuths, sun_path};
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::topocentric::Site;

fn time<T>(label: &str, reps: u32, mut f: impl FnMut() -> T) -> f64 {
    let _ = f();
    let t = Instant::now();
    for _ in 0..reps {
        std::hint::black_box(f());
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / f64::from(reps);
    eprintln!("{label:<58} {ms:>9.3} ms");
    ms
}

#[test]
#[ignore = "timing; run in release with --ignored --nocapture"]
fn sun_tools_budget() {
    let sky = Sky::new();
    let site = Site {
        height_m: 12.0,
        ..Site::new(39.9526, -75.1652)
    };
    let d0 = civil_to_jd(2026, 9, 24) + 4.0 / 24.0;
    let year_days: Vec<(f64, f64)> = (0..365)
        .map(|k| {
            let a = civil_to_jd(2026, 1, 1) + 5.0 / 24.0 + k as f64;
            (a, a + 1.0)
        })
        .collect();
    let mut year = Vec::new();

    time("sun_hours, one local day", 20, || {
        sun_hours(&sky, &site, d0, d0 + 1.0).unwrap()
    });
    time("find_azimuth, the Moon, one day", 20, || {
        find_azimuth(
            &sky,
            &site,
            "Moon",
            d0,
            d0 + 1.0,
            120.0,
            &AltitudeBand::default(),
        )
        .unwrap()
    });
    year.push(time("find_azimuth, the Sun, 365 days", 3, || {
        find_azimuth(
            &sky,
            &site,
            "Sun",
            year_days[0].0,
            year_days[364].1,
            250.0,
            &AltitudeBand::default(),
        )
        .unwrap()
    }));
    let req = |event| AlignmentRequest {
        body: "Sun".into(),
        year: 2026,
        azimuth_deg: 299.0,
        tolerance_deg: 0.5,
        event,
        utc_offset_hours: Some(-4.0),
        options: None,
    };
    year.push(time("alignment_days, sunsets of a year", 3, || {
        alignment_days(&sky, &site, &req(AlignmentEvent::Set)).unwrap()
    }));
    year.push(time(
        "alignment_days, the Sun at 5 degrees, a year",
        3,
        || {
            alignment_days(
                &sky,
                &site,
                &req(AlignmentEvent::AtAltitude { altitude_deg: 5.0 }),
            )
            .unwrap()
        },
    ));
    time(
        "alignment_days, moonrises of a year (the Moon's provider)",
        3,
        || {
            alignment_days(
                &sky,
                &site,
                &AlignmentRequest {
                    body: "Moon".into(),
                    ..req(AlignmentEvent::Rise)
                },
            )
            .unwrap()
        },
    );
    year.push(time("analemma, 365 days", 3, || {
        analemma(
            &sky,
            &site,
            &AnalemmaRequest {
                year: 2026,
                time_h: 12.0,
                clock: ClockKind::Lmt,
                utc_offset_hours: None,
            },
        )
        .unwrap()
    }));
    time(
        "sun_path, a day at 10 minutes and four envelope days",
        10,
        || sun_path(&sky, &site, d0, d0 + 1.0, 10.0).unwrap(),
    );
    year.push(time("rise_set_azimuths, the Sun, a year", 3, || {
        rise_set_azimuths(
            &sky,
            &site,
            &RiseSetRequest {
                body: "Sun".into(),
                year: 2026,
                utc_offset_hours: Some(-5.0),
                options: None,
            },
        )
        .unwrap()
    }));
    time(
        "rise_set_azimuths, the Moon, a year (the Moon's provider)",
        3,
        || {
            rise_set_azimuths(
                &sky,
                &site,
                &RiseSetRequest {
                    body: "Moon".into(),
                    year: 2026,
                    utc_offset_hours: Some(-5.0),
                    options: None,
                },
            )
            .unwrap()
        },
    );
    year.push(time("equation_of_time, 365 days", 3, || {
        equation_of_time(&sky, 2026, 12.0).unwrap()
    }));
    time("solar_day, 10-minute samples", 20, || {
        solar_day(
            &sky,
            &site,
            d0,
            d0 + 1.0,
            &Panel {
                tilt_deg: 30.0,
                ..Panel::default()
            },
            10.0,
        )
        .unwrap()
    });
    let solar = |optimise| SolarYearRequest {
        year: 2026,
        panel: Panel {
            tilt_deg: 30.0,
            ..Panel::default()
        },
        utc_offset_hours: Some(-5.0),
        step_minutes: None,
        optimise_tilt: optimise,
    };
    year.push(time("solar_year, 10-minute steps", 3, || {
        solar_year(&sky, &site, &solar(false)).unwrap()
    }));
    year.push(time("solar_year with the best-tilt search", 3, || {
        solar_year(&sky, &site, &solar(true)).unwrap()
    }));
    let dark = Site::new(-31.2733, 149.0617);
    let n0 = civil_to_jd(2026, 6, 15) + 2.0 / 24.0;
    time("galactic_centre_windows, one night", 20, || {
        galactic_centre_windows(&sky, &dark, n0, n0 + 1.0, &GalacticOptions::default()).unwrap()
    });
    time("galactic_centre_windows, 30 nights", 3, || {
        galactic_centre_windows(&sky, &dark, n0, n0 + 30.0, &GalacticOptions::default()).unwrap()
    });
    let whole_year = time("galactic_centre_windows, 365 nights", 2, || {
        galactic_centre_windows(&sky, &dark, n0, n0 + 365.0, &GalacticOptions::default()).unwrap()
    });
    eprintln!(
        "(the galactic windows of a whole year: {whole_year:.0} ms, outside the budget's scope)"
    );
    // The Moon's year series are dominated by the provider: a year of 3-hour track nodes is
    // about 2 900 exact evaluations of ELP 2000-82B at about 0.1 ms each. The budget is the
    // Sun's (EXPANSION_PLAN P7).
    let worst = year.iter().copied().fold(0.0, f64::max);
    eprintln!("worst year-long series of the Sun: {worst:.1} ms (budget 200 ms)");
    assert!(worst < 200.0, "{worst} ms");
}
