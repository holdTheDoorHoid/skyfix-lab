//! Timings against the tides work package's budget: a month of one station's high and
//! low water in under 20 ms natively (EXPANSION_PLAN P5).
//!
//! Ignored by default: timings mean nothing in a debug build. Run natively in release as
//! a proxy for the WASM build (typically 1.5 to 3 times slower):
//!
//! ```text
//! cargo test --release -p skyfix-tides --test perf -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::time::Instant;

use skyfix_tides::api;
use skyfix_tides::pack::decode_file;

fn time<T>(label: &str, reps: u32, mut f: impl FnMut() -> T) -> f64 {
    let _ = f();
    let t = Instant::now();
    for _ in 0..reps {
        std::hint::black_box(f());
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / f64::from(reps);
    eprintln!("{label:<60} {ms:>9.3} ms");
    ms
}

#[test]
#[ignore = "timing; run in release with --ignored --nocapture"]
fn tides_budget() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs");
    let path = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().ends_with(".bin"))
        .unwrap();
    let bytes = std::fs::read(path).unwrap();
    time("decode the pack (3 499 stations)", 20, || {
        decode_file(&bytes).unwrap()
    });
    let db = decode_file(&bytes).unwrap();
    let jd = 2_461_307.5;
    let boston = time(
        "a month of high and low water, Boston (34 terms)",
        50,
        || api::extremes(&db, "8443970", jd, jd + 30.0, "").unwrap(),
    );
    let anchorage = time(
        "a month of high and low water, Anchorage (120 terms)",
        20,
        || api::extremes(&db, "9455920", jd, jd + 30.0, "").unwrap(),
    );
    time(
        "a month of high and low water, Hell Gate (subordinate)",
        50,
        || api::extremes(&db, "8517401", jd, jd + 30.0, "").unwrap(),
    );
    time(
        "a week's curve at 6 min, Boston (1 681 samples)",
        200,
        || api::predict(&db, "8443970", jd, jd + 7.0, 6.0, "").unwrap(),
    );
    time("tide now, Boston", 200, || {
        api::now(&db, "8443970", jd + 0.3, "").unwrap()
    });
    time("the 10 nearest stations", 200, || {
        api::stations_near(&db, 39.95, -75.17, 10).unwrap()
    });
    assert!(boston < 20.0 && anchorage < 20.0);
}
