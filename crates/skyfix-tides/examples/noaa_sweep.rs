//! The pipeline's sweep: every station of the pack against NOAA's own high and low water
//! (`fixtures/reference/tides_noaa_sweep.json`, fetched by `tools/tides/fixtures.py`).
//!
//! ```text
//! cargo run --release -p skyfix-tides --example noaa_sweep -- \
//!     web/public/data/packs/tides-us-<rev>.bin fixtures/reference/tides_noaa_sweep.json \
//!     [--write tools/tides/noaa_differs.json] [--pairs]
//! ```
//!
//! Prints a summary and every station that fails the validation rules
//! (`skyfix_tides::validation`); `--write` records those stations for `build.py`, which
//! flags them `noaa_differs` in the pack; `--pairs` lists the short-lived pairs of
//! extremes each side has and the other lacks (to study NOAA's own rule for them).

use std::collections::BTreeMap;

use serde_json::Value;
use skyfix_tides::api;
use skyfix_tides::db::{StationKind, flags};
use skyfix_tides::pack::decode_file;
use skyfix_tides::predict::{Extreme, ExtremeKind, NodalMode};
use skyfix_tides::validation::{RefExtreme, Tolerance, compare, rounding_rate_sigma};

fn jd_of(ymd: &str) -> f64 {
    let y: i32 = ymd[0..4].parse().unwrap();
    let m: u32 = ymd[4..6].parse().unwrap();
    let d: u32 = ymd[6..8].parse().unwrap();
    let cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let doy = cum[(m - 1) as usize] + d - 1 + u32::from(leap && m > 2);
    skyfix_tides::predict::jd_year_start(y) + f64::from(doy)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pack = std::fs::read(&args[1]).expect("pack");
    let db = decode_file(&pack).expect("decode");
    let sweep: Value =
        serde_json::from_str(&std::fs::read_to_string(&args[2]).expect("sweep")).unwrap();
    let write = args
        .iter()
        .position(|a| a == "--write")
        .map(|k| args[k + 1].clone());
    let pairs = args.iter().any(|a| a == "--pairs");
    let dump = args
        .iter()
        .position(|a| a == "--dump")
        .map(|k| args[k + 1].clone());
    let mut dumped = serde_json::Map::new();
    let w = &sweep["generator"]["window"];
    let jd0 = jd_of(w[0].as_str().unwrap());
    let jd1 = jd_of(w[1].as_str().unwrap()) + 1.0;
    let tol = Tolerance::default();

    let mut failures: BTreeMap<String, String> = BTreeMap::new();
    let (mut n_st, mut n_ex, mut n_flat, mut n_stands) = (0, 0, 0, 0);
    let (mut worst_sharp, mut worst_dh) = (0.0f64, 0.0f64);
    let mut not_predictable = Vec::new();
    for (id, list) in sweep["stations"].as_object().unwrap() {
        let Some(k) = db.index_of(id) else {
            failures.insert(id.clone(), "not in the pack".into());
            continue;
        };
        let st = &db.stations[k];
        let ours = match api::extremes(&db, id, jd0, jd1, "MLLW") {
            Ok(x) => x,
            Err(e) => {
                not_predictable.push(format!("{id} ({e})"));
                failures.insert(id.clone(), e);
                continue;
            }
        };
        let ours: Vec<Extreme> = ours
            .extremes
            .iter()
            .map(|e| Extreme {
                kind: if e.kind == "high" {
                    ExtremeKind::High
                } else {
                    ExtremeKind::Low
                },
                jd_utc: e.jd_utc,
                height_m: e.height_m,
            })
            .collect();
        if dump.is_some() {
            dumped.insert(
                id.clone(),
                serde_json::json!(
                    ours.iter()
                        .map(|e| (e.jd_utc, e.height_m, e.kind == ExtremeKind::High))
                        .collect::<Vec<_>>()
                ),
            );
        }
        let reference: Vec<RefExtreme> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|r| RefExtreme {
                jd_utc: jd0 + r[0].as_f64().unwrap() / 1440.0,
                height_m: r[1].as_f64().unwrap() / 1000.0,
                high: r[2].as_i64().unwrap() == 1,
            })
            .collect();
        // Flatness from the harmonic curve (the reference station's for a subordinate).
        let (h, shift_hi, shift_lo) = match &st.kind {
            StationKind::Harmonic(h) => (h, 0.0, 0.0),
            StationKind::Subordinate(sub) => match &db.stations[sub.reference as usize].kind {
                StationKind::Harmonic(h) => (
                    h,
                    f64::from(sub.time_high_min) / 1440.0,
                    f64::from(sub.time_low_min) / 1440.0,
                ),
                StationKind::Subordinate(_) => unreachable!("decoder checks references"),
            },
        };
        let mut p = h.predictor(NodalMode::MidYear);
        let sigma = rounding_rate_sigma(&p);
        let c = compare(
            &reference,
            &ours,
            jd0,
            jd1,
            tol,
            |t| {
                let near = ours
                    .iter()
                    .min_by(|a, b| (a.jd_utc - t).abs().total_cmp(&(b.jd_utc - t).abs()))
                    .unwrap();
                let s = if near.kind == ExtremeKind::High {
                    shift_hi
                } else {
                    shift_lo
                };
                p.eval(t - s).2
            },
            sigma,
        );
        n_st += 1;
        n_ex += c.matched;
        n_flat += c.flat;
        n_stands += c.stands;
        worst_sharp = worst_sharp.max(c.worst_dt_sharp_min);
        worst_dh = worst_dh.max(c.worst_dh_m);
        if pairs {
            for (list_name, times, all) in [
                ("ours only", &c.invented, &ours),
                ("NOAA only", &c.missing, &ours),
            ] {
                for t in times.iter() {
                    let k = all.partition_point(|e| e.jd_utc < *t);
                    let near = |j: usize| all.get(j).map(|e| (e.jd_utc, e.height_m));
                    println!(
                        "{list_name:9} {id:8} {:<30} at {t:.4} neighbours {:?} {:?} {:?}",
                        st.name.chars().take(30).collect::<String>(),
                        k.checked_sub(1).and_then(near),
                        near(k),
                        near(k + 1)
                    );
                }
            }
        }
        if !c.passes() {
            failures.insert(
                id.clone(),
                format!(
                    "late {:?} off_height {:?} missing {} invented {} (worst {:.1} min, {:.1} cm)",
                    c.late
                        .iter()
                        .map(|l| format!("{:+.1}/{:.1} min", l.1, l.2))
                        .collect::<Vec<_>>(),
                    c.off_height
                        .iter()
                        .map(|o| format!("{:+.1} cm", o.1 * 100.0))
                        .collect::<Vec<_>>(),
                    c.missing.len(),
                    c.invented.len(),
                    c.worst_dt_min,
                    c.worst_dh_m * 100.0
                ),
            );
        }
    }
    let refused = sweep["refused"].as_object().unwrap();
    println!(
        "{n_st} stations compared, {n_ex} extremes ({n_flat} at flat turns, {n_stands} stands); worst sharp time {worst_sharp:.2} min, worst height {:.2} cm; {} fail; NOAA \
         refused {} ({:?})",
        worst_dh * 100.0,
        failures.len(),
        refused.len(),
        refused.keys().collect::<Vec<_>>()
    );
    for (id, message) in refused {
        if let Some(st) = db.get(id) {
            let described = api::describe(&db, st);
            println!(
                "  NOAA refused {id} {} (our curve: {}): {}",
                st.name,
                described.curve,
                message.as_str().unwrap_or("")
            );
            // A station we can predict (on MLLW) but NOAA serves nothing for is flagged:
            // its predictions cannot be checked against NOAA's.
            if described.curve != "none" && described.datums.contains(&"MLLW") {
                failures.insert(
                    id.clone(),
                    "NOAA serves no predictions for this station".to_string(),
                );
            }
        }
    }
    for (id, why) in &failures {
        let name = db.get(id).map(|s| s.name.as_str()).unwrap_or("?");
        let flagged = db.get(id).is_some_and(|s| s.has(flags::NOAA_DIFFERS));
        println!(
            "FAIL {id} {name:<34} {why}{}",
            if flagged { " [flagged]" } else { "" }
        );
    }
    if let Some(path) = dump {
        std::fs::write(&path, serde_json::to_string(&dumped).unwrap()).unwrap();
    }
    if let Some(path) = write {
        let v = serde_json::json!({
            "about": "Stations whose NOAA predictions (the sweep, tools/tides/fixtures.py) the \
                      published constants do not reproduce within the validation rules of \
                      skyfix_tides::validation. Written by examples/noaa_sweep.rs; build.py \
                      flags them noaa_differs.",
            "window": w,
            "stations": failures,
        });
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        println!("wrote {path}");
    }
}
