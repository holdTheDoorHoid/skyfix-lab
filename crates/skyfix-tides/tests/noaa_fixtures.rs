//! Tide predictions against NOAA's own (`fixtures/reference/tides_noaa.json`, fetched by
//! `tools/tides/fixtures.py`): 20 harmonic stations over five coasts and four tide types,
//! 30 days each, and 6 subordinate stations.
//!
//! Built from the constants NOAA publishes (embedded in the fixture as NOAA served them),
//! not from the pack, so this checks the prediction alone; `pack_real.rs` checks that
//! the pack carries the same constants, and runs the all-station sweep.
//!
//! Targets (EXPANSION_PLAN P5): high and low water within 2 minutes and 5 cm, the curve
//! within 5 cm. NOAA rounds its times to the minute and its heights to the millimetre.
//! At a flat turn of the tide, the rules of `skyfix_tides::validation` allow three times
//! the time uncertainty the rounding of NOAA's published constants implies; the table
//! says how many extremes needed that (none, today).
//!
//! `cargo test -p skyfix-tides --test noaa_fixtures -- --nocapture` prints the
//! per-station table and the comparison with node factors evaluated at each instant
//! instead of at mid-year (NOAA's convention).

use std::path::PathBuf;

use serde_json::Value;
use skyfix_tides::db::{Datum, Datums, Harmonic, HeightAdjust, STORED_DATUMS, Subordinate};
use skyfix_tides::predict::{
    Extreme, ExtremeKind, NodalMode, Predictor, jd_year_start, table_rule,
};
use skyfix_tides::schureman::{CONSTITUENTS, index_of};
use skyfix_tides::validation::{Comparison, RefExtreme, Tolerance, compare, rounding_rate_sigma};

fn fixture() -> Value {
    let p =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/reference/tides_noaa.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("tides fixture")).unwrap()
}

/// JD of 00:00 UTC on a `YYYYMMDD` date.
fn jd_of(ymd: &str) -> f64 {
    let y: i32 = ymd[0..4].parse().unwrap();
    let m: u32 = ymd[4..6].parse().unwrap();
    let d: u32 = ymd[6..8].parse().unwrap();
    let cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let doy = cum[(m - 1) as usize] + d - 1 + u32::from(leap && m > 2);
    jd_year_start(y) + f64::from(doy)
}

/// The station's constants as NOAA published them, and MLLW − MSL in metres.
fn harmonic(constants: &Value) -> (Harmonic, f64) {
    let mut terms = Vec::new();
    for c in constants["constituents"].as_array().unwrap() {
        let name = c[0].as_str().unwrap();
        let k = index_of(name).unwrap_or_else(|| panic!("unknown constituent {name}"));
        let noaa_speed = c[3].as_f64().unwrap();
        let ours = CONSTITUENTS[k].speed_deg_per_hour();
        assert!(
            // NOAA prints speeds to 5-7 decimals (M6 86.95232 for 86.9523126).
            (ours - noaa_speed).abs() < 1.2e-5,
            "{name}: our speed {ours:.7} vs NOAA's {noaa_speed}"
        );
        terms.push((k as u8, c[1].as_f64().unwrap(), c[2].as_f64().unwrap()));
    }
    terms.sort_by_key(|t| t.0);
    let d = &constants["datums_m_above_station_datum"];
    let mllw_rel_msl = d["MLLW"].as_f64().unwrap() - d["MSL"].as_f64().unwrap();
    let mut datums = Datums::default();
    let k = STORED_DATUMS
        .iter()
        .position(|x| *x == Datum::Mllw)
        .unwrap();
    datums.mm_rel_msl[k] = Some((mllw_rel_msl * 1000.0).round() as i16);
    (Harmonic { datums, terms }, mllw_rel_msl)
}

fn reference(v: &Value, jd0: f64) -> Vec<RefExtreme> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| RefExtreme {
            jd_utc: jd0 + r[0].as_f64().unwrap() / 1440.0,
            height_m: r[1].as_f64().unwrap() / 1000.0,
            high: r[2].as_i64().unwrap() == 1,
        })
        .collect()
}

fn on_mllw(list: Vec<Extreme>, mllw: f64) -> Vec<Extreme> {
    list.into_iter()
        .map(|e| Extreme {
            height_m: e.height_m - mllw,
            ..e
        })
        .collect()
}

fn curve_worst(p: &mut Predictor, hourly: &[Value], jd0: f64, mllw: f64) -> f64 {
    hourly
        .iter()
        .enumerate()
        .map(|(k, v)| {
            let ours = p.height(jd0 + k as f64 / 24.0) - mllw;
            (ours - v.as_f64().unwrap() / 1000.0).abs()
        })
        .fold(0.0, f64::max)
}

fn check(c: &Comparison, who: &str) {
    assert!(c.passes(), "{who}: {c:?}");
}

#[test]
fn harmonic_stations_match_noaa_within_2_minutes_and_5_cm() {
    let fx = fixture();
    let stations = fx["harmonic"].as_array().unwrap();
    assert_eq!(stations.len(), 20);
    let tol = Tolerance::default();
    let (mut n, mut flat, mut sharp_worst, mut dt_worst, mut dh_worst, mut curve_worst_all) =
        (0, 0, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut inst_dt, mut inst_dh, mut inst_curve) = (0.0f64, 0.0f64, 0.0f64);
    eprintln!(
        "{:<8} {:<28} {:>8} {:>4} {:>5} {:>6} {:>6} {:>6} | instant f,u: {:>6} {:>6} {:>6}",
        "id", "station", "window", "n", "flat", "dt", "dh cm", "curve", "dt", "dh cm", "curve"
    );
    for s in stations {
        let id = s["id"].as_str().unwrap();
        let (h, mllw) = harmonic(&s["constants"]);
        let w0 = s["window"][0].as_str().unwrap();
        let jd0 = jd_of(w0);
        let jd1 = jd_of(s["window"][1].as_str().unwrap()) + 1.0;
        let noaa = reference(&s["extremes"], jd0);
        let hourly = s["hourly_mm"].as_array().unwrap();

        let mut p = h.predictor(NodalMode::MidYear);
        let sigma = rounding_rate_sigma(&p);
        let ours = on_mllw(p.table_extremes(jd0, jd1), mllw);
        let mut q = h.predictor(NodalMode::MidYear);
        let c = compare(&noaa, &ours, jd0, jd1, tol, |t| q.eval(t).2, sigma);
        let curve = curve_worst(&mut p, hourly, jd0, mllw);

        // The same with f and u at each instant: the curve always, the high and low
        // waters only in release builds (node factors per evaluation are slow in debug).
        let mut pi = h.predictor(NodalMode::Instant);
        let curve_i = curve_worst(&mut pi, hourly, jd0, mllw);
        let ci = if cfg!(debug_assertions) {
            Comparison::default()
        } else {
            let inst = on_mllw(pi.table_extremes(jd0, jd1), mllw);
            compare(&noaa, &inst, jd0, jd1, tol, |_| f64::INFINITY, sigma)
        };

        let name: String = s["name"].as_str().unwrap().chars().take(28).collect();
        eprintln!(
            "{id:<8} {name:<28} {w0:>8} {:>4} {:>5} {:>6.2} {:>6.2} {:>6.2} | {:>18.2} {:>6.2} {:>6.2}",
            c.matched,
            c.flat,
            c.worst_dt_min,
            c.worst_dh_m * 100.0,
            curve * 100.0,
            ci.worst_dt_min,
            ci.worst_dh_m * 100.0,
            curve_i * 100.0
        );
        check(&c, id);
        assert!(curve <= 0.05, "{id}: curve off by {curve:.3} m");
        n += c.matched;
        flat += c.flat;
        sharp_worst = sharp_worst.max(c.worst_dt_sharp_min);
        dt_worst = dt_worst.max(c.worst_dt_min);
        dh_worst = dh_worst.max(c.worst_dh_m);
        curve_worst_all = curve_worst_all.max(curve);
        inst_dt = inst_dt.max(ci.worst_dt_min);
        inst_dh = inst_dh.max(ci.worst_dh_m);
        inst_curve = inst_curve.max(curve_i);
    }
    eprintln!(
        "ALL (NOAA's mid-year node factors): {n} extremes; {} within 2 min (worst \
         {sharp_worst:.2}), {flat} at flat turns (worst {dt_worst:.2} min); heights worst \
         {:.2} cm; curve worst {:.2} cm",
        n - flat,
        dh_worst * 100.0,
        curve_worst_all * 100.0
    );
    eprintln!(
        "ALL (f and u at each instant instead): times worst {inst_dt:.2} min, heights {:.2} cm, \
         curve {:.2} cm",
        inst_dh * 100.0,
        inst_curve * 100.0
    );
    assert!(n > 2000);
    // NOAA's predictions follow the mid-year convention, not instantaneous node factors.
    assert!(inst_curve > 5.0 * curve_worst_all, "{inst_curve} vs {curve_worst_all}");
}

#[test]
fn subordinate_stations_match_noaa_within_2_minutes_and_5_cm() {
    let fx = fixture();
    let stations = fx["subordinate"].as_array().unwrap();
    assert!(stations.len() >= 5);
    for s in stations {
        let id = s["id"].as_str().unwrap();
        let (h, mllw) = harmonic(&s["reference_constants"]);
        let off = &s["offsets"];
        let (hi, lo) = (
            off["heightOffsetHighTide"].as_f64().unwrap(),
            off["heightOffsetLowTide"].as_f64().unwrap(),
        );
        let heights = match off["heightAdjustedType"].as_str().unwrap() {
            "R" => HeightAdjust::Ratio { high: hi, low: lo },
            // NOAA serves the additive differences in feet (tools/tides/build.py).
            "F" => HeightAdjust::Additive {
                high_m: hi * 0.3048,
                low_m: lo * 0.3048,
            },
            t => panic!("{id}: height type {t}"),
        };
        let sub = Subordinate {
            reference: 0,
            time_high_min: off["timeOffsetHighTide"].as_i64().unwrap() as i16,
            time_low_min: off["timeOffsetLowTide"].as_i64().unwrap() as i16,
            heights,
        };
        let shift = |kind: ExtremeKind| {
            f64::from(if kind == ExtremeKind::High {
                sub.time_high_min
            } else {
                sub.time_low_min
            })
        };
        let w0 = s["window"][0].as_str().unwrap();
        let jd0 = jd_of(w0);
        let jd1 = jd_of(s["window"][1].as_str().unwrap()) + 1.0;
        let mut p = h.predictor(NodalMode::MidYear);
        let sigma = rounding_rate_sigma(&p);
        // As skyfix_tides::api does: raw reference extremes, the differences, the rule.
        let raw = on_mllw(p.extremes(jd0 - 1.0, jd1 + 1.0), mllw);
        let ours: Vec<Extreme> = table_rule(&sub.apply(&raw))
            .into_iter()
            .filter(|e| e.jd_utc >= jd0 && e.jd_utc <= jd1)
            .collect();
        let noaa = reference(&s["extremes"], jd0);
        // The flatness of a subordinate turn is its reference station's, shifted.
        let mut q = h.predictor(NodalMode::MidYear);
        let c = compare(
            &noaa,
            &ours,
            jd0,
            jd1,
            Tolerance::default(),
            |t| {
                let near = ours
                    .iter()
                    .min_by(|a, b| (a.jd_utc - t).abs().total_cmp(&(b.jd_utc - t).abs()))
                    .unwrap();
                q.eval(t - shift(near.kind) / 1440.0).2
            },
            sigma,
        );
        eprintln!(
            "{id} {:<28} from {:<8} {:>4} extremes ({} flat), worst {:.2} min, {:.2} cm, {} stands",
            s["name"].as_str().unwrap(),
            s["reference_id"].as_str().unwrap(),
            c.matched,
            c.flat,
            c.worst_dt_min,
            c.worst_dh_m * 100.0,
            c.stands
        );
        check(&c, id);
    }
}
