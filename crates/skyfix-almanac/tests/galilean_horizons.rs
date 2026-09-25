//! Jupiter's moons (Lieske's E5) against JPL Horizons over 1600-2200 (verify2).
//!
//! `fixtures/reference/galilean_horizons.json` (`tools/reference/gen_galilean_horizons.py`)
//! holds 400 instants: 240 spread over the whole span of JPL's satellite ephemeris and
//! 160 over 1990-2060. Every moon's offset from Jupiter must be inside the accuracy the
//! engine publishes for that date (`satellites::accuracy_arcsec_at`). The single 0.5"
//! published before failed here: 0.67" (Ganymede) in 2057, 1.27" in the 1600s.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use skyfix_almanac::satellites::{accuracy_arcsec_at, galilean_moons};
use skyfix_core::time::clock_from_tt;

fn fixture() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference/galilean_horizons.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("galilean_horizons.json")).unwrap()
}

#[test]
fn every_moon_is_within_the_accuracy_published_for_its_date() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 400);
    // Worst error, and the tightest margin to the published figure, per era.
    let mut worst: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    let mut n = 0;
    for c in cases {
        let jd_tt = c["jd_tt"].as_f64().unwrap();
        let g = galilean_moons(clock_from_tt(jd_tt)).unwrap();
        let limit = accuracy_arcsec_at(jd_tt);
        assert_eq!(g.accuracy_arcsec, limit);
        let year = 2000.0 + (jd_tt - 2_451_545.0) / 365.25;
        let era = match year {
            y if y < 1800.0 => "1600-1800",
            y if y < 1900.0 => "1800-1900",
            y if y < 2040.0 => "1900-2040",
            y if y < 2100.0 => "2040-2100",
            _ => "2100-2200",
        };
        for m in &g.moons {
            let r = &c["offsets_arcsec"][m.name.as_str()];
            let (e, north) = (r[0].as_f64().unwrap(), r[1].as_f64().unwrap());
            let d = (m.offset_east_arcsec - e).hypot(m.offset_north_arcsec - north);
            assert!(
                d < limit,
                "{} at {year:.2}: {d:.3}\" from JPL, published {limit}\"",
                m.name
            );
            let w = worst.entry(era).or_insert((0.0, f64::INFINITY));
            w.0 = w.0.max(d);
            w.1 = w.1.min(limit - d);
            n += 1;
        }
    }
    for (era, (d, margin)) in &worst {
        println!(
            "{era}: worst {d:.3}\" from JPL (least margin to the published figure {margin:.3}\")"
        );
    }
    assert_eq!(n, 1600);
}
