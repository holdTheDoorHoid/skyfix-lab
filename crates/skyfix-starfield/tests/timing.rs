//! EXPLORER_PLAN section 3.7: star-field apparent places in at most 5 ms.
//!
//! Timing means something only in an optimised build, so the budget is asserted only
//! there: `cargo test --release -p skyfix-starfield --test timing -- --nocapture`.
//! A debug build still runs the loop and prints its time.

use std::time::Instant;

#[test]
fn all_apparent_places_within_the_budget() {
    let mut buf = Vec::new();
    let jd0 = 2_461_308.0;
    // Warm up: first use parses the catalogue and prepares the per-star vectors.
    skyfix_starfield::apparent_radec_all_into(jd0, &mut buf).unwrap();
    // Time calls one by one and judge the fastest: on a shared machine other work can
    // only slow a call down, so the minimum is the best estimate of the real cost. The
    // median is printed too.
    let mut ms: Vec<f64> = (0..100)
        .map(|k| {
            // A different hour each time, as the UI would ask.
            let t = Instant::now();
            skyfix_starfield::apparent_radec_all_into(jd0 + f64::from(k) / 24.0, &mut buf).unwrap();
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    let (fastest, median) = (ms[0], ms[ms.len() / 2]);
    println!(
        "apparent places of {} stars: fastest {fastest:.3} ms, median {median:.3} ms per call ({} build)",
        buf.len() / 2,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    if !cfg!(debug_assertions) {
        assert!(fastest <= 5.0, "{fastest} ms");
    }
}

/// `sky_state` asks for the constellation of every body at one instant; the rotation
/// for that instant is computed once and the lookups after it are cheap.
#[test]
fn constellation_lookups_are_cheap_at_one_instant() {
    let jd = 2_461_308.0;
    skyfix_starfield::constellation_at(0.0, 0.0, jd).unwrap();
    let n = 10_000;
    let t = Instant::now();
    for k in 0..n {
        let ra = f64::from(k) * 0.036;
        let dec = f64::from(k % 179) - 89.0;
        skyfix_starfield::constellation_at(ra, dec, jd).unwrap();
    }
    let same_us = t.elapsed().as_secs_f64() * 1e6 / f64::from(n);
    let t = Instant::now();
    for k in 0..1_000 {
        skyfix_starfield::constellation_at(10.0, 10.0, jd + f64::from(k) / 1440.0).unwrap();
    }
    let new_us = t.elapsed().as_secs_f64() * 1e6 / 1_000.0;
    println!(
        "constellation_at: {same_us:.2} us per lookup at one instant, {new_us:.2} us at a new instant ({} build)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    if !cfg!(debug_assertions) {
        assert!(same_us < 20.0, "{same_us} us");
    }
}
