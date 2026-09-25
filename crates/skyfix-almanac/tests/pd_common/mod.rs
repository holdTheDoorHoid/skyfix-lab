//! Shared support for the planet-detail reference tests (`planetdetail_*.rs`).

#![allow(dead_code)]

use skyfix_core::time::{jd_tt, parse_utc};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::planets::PlanetProvider;

/// A committed fixture, read relative to the repository root.
pub fn read(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is committed: {e}", path.display()))
}

/// The app's clock instant (`jd_utc`) of a TT Julian date, by inverting
/// `skyfix_core::time::jd_tt`, so the fixtures (in TT) stay valid whatever TT - UTC
/// model the core uses.
pub fn jd_utc_from_tt(jd_tt_target: f64) -> f64 {
    let mut x = jd_tt_target - 69.184 / 86_400.0;
    for _ in 0..4 {
        x += jd_tt_target - jd_tt(x);
    }
    x
}

/// The planet provider's coverage as UTC Julian dates.
pub fn planet_coverage() -> (f64, f64) {
    let c = PlanetProvider::new().coverage();
    (
        parse_utc(&c.start_utc).unwrap(),
        parse_utc(&c.end_utc).unwrap(),
    )
}

/// `a - b` wrapped into `(-180, 180]` degrees.
pub fn wrap(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 { d - 360.0 } else { d }
}

/// Running worst absolute value with its label.
#[derive(Debug, Default, Clone)]
pub struct Worst {
    pub value: f64,
    pub label: String,
    pub count: usize,
}

impl Worst {
    pub fn add(&mut self, v: f64, label: impl FnOnce() -> String) {
        self.count += 1;
        if v.abs() > self.value.abs() || self.label.is_empty() {
            self.value = v;
            self.label = label();
        }
    }
}
