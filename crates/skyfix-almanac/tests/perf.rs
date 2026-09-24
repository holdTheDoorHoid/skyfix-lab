//! Timings against the explorer's performance budget (EXPLORER_PLAN section 3.7).
//!
//! Ignored by default: timings mean nothing in a debug build or on a loaded CI box.
//! Run natively in release as a proxy for the WASM build:
//!
//! ```text
//! cargo test --release -p skyfix-almanac --test perf -- --ignored --nocapture
//! ```
//!
//! The budget is `sky_state` for all solar-system bodies plus the 58 stars in 2 ms, and
//! a year of Sun `day_events_batch` "well under a second". WASM typically runs 1.5 to
//! 3 times slower than native, so the native figures here should sit well below those.

mod common;

use std::time::Instant;

use common::SyntheticSky;
use skyfix_almanac::events::{EventOptions, day_events, day_events_batch, moon_phases, seasons};
use skyfix_almanac::sky::{body_group, sample_bodies, sky_state};
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::body::{BodyEphemeris, Sky};
use skyfix_ephemeris::topocentric::Site;

fn time<T>(label: &str, reps: u32, mut f: impl FnMut() -> T) -> f64 {
    // Warm up (embedded data parse, caches).
    let _ = f();
    let t = Instant::now();
    for _ in 0..reps {
        std::hint::black_box(f());
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / f64::from(reps);
    eprintln!("{label:<62} {ms:>9.3} ms");
    ms
}

#[test]
#[ignore = "timing; run in release with --ignored --nocapture"]
fn explorer_budget() {
    let real = Sky::new();
    let synth = SyntheticSky::new();
    let site = Site {
        height_m: 12.0,
        ..Site::new(39.9526, -75.1652)
    };
    let all = body_group("all").unwrap();
    let t0 = civil_to_jd(2026, 9, 24);

    // sky_state, scrubbing: a new instant every call, as the time bar does.
    let mut k = 0.0;
    let ms_all = time(
        "sky_state, all 67 bodies (the providers in this build)",
        2000,
        || {
            k += 1.0;
            sky_state(&real, &site, t0 + k / 1440.0, &all).unwrap()
        },
    );
    let mut k = 0.0;
    time(
        "sky_state, all 67 bodies with the synthetic Moon",
        2000,
        || {
            k += 1.0;
            sky_state(&synth as &dyn BodyEphemeris, &site, t0 + k / 1440.0, &all).unwrap()
        },
    );
    let stars: Vec<&str> = all[9..].to_vec();
    let mut k = 0.0;
    time("sky_state, 58 stars only", 2000, || {
        k += 1.0;
        sky_state(&real, &site, t0 + k / 1440.0, &stars).unwrap()
    });
    let mut k = 0.0;
    time("sky_state, Sun only", 5000, || {
        k += 1.0;
        sky_state(&real, &site, t0 + k / 1440.0, &["Sun"]).unwrap()
    });

    // Events.
    let opts = EventOptions::default();
    let windows: Vec<(f64, f64)> = (0..365)
        .map(|d| (t0 + f64::from(d), t0 + f64::from(d) + 1.0))
        .collect();
    let ms_year = time("day_events_batch, Sun, 365 daily windows", 5, || {
        day_events_batch(&real, &site, &windows, &["Sun"], &opts).unwrap()
    });
    time(
        "day_events_batch, Sun + synthetic Moon, 365 windows",
        3,
        || day_events_batch(&synth, &site, &windows, &["Sun", "Moon"], &opts).unwrap(),
    );
    time(
        "day_events, one day, all 67 bodies (synthetic Moon)",
        20,
        || day_events(&synth, &site, t0, t0 + 1.0, &all, &opts).unwrap(),
    );
    time("day_events, one day, Sun", 200, || {
        day_events(&real, &site, t0, t0 + 1.0, &["Sun"], &opts).unwrap()
    });

    // Paths and calendars.
    let nav = body_group("navigational").unwrap();
    time(
        "sample_bodies, navigational (64), one day at 5 min",
        10,
        || sample_bodies(&synth, &site, &nav, t0, t0 + 1.0, 5.0).unwrap(),
    );
    time("sample_bodies, Sun + Moon, one day at 1 min", 50, || {
        sample_bodies(&synth, &site, &["Sun", "Moon"], t0, t0 + 1.0, 1.0).unwrap()
    });
    time("moon_phases, one year (synthetic Moon)", 10, || {
        moon_phases(&synth, t0, t0 + 365.0).unwrap()
    });
    time("seasons, one year", 20, || seasons(&real, 2026).unwrap());

    assert!(ms_all < 2.0, "sky_state over budget: {ms_all} ms");
    assert!(ms_year < 500.0, "a year of Sun events: {ms_year} ms");
}
