//! Delta-T, UT1 and the calendars against `fixtures/reference/timescales.json`
//! (`tools/timescales/gen_timescales.py`, Skyfield 1.55).
//!
//! - `delta_t_s`: Skyfield's own `build_delta_t` run on this project's IERS table. The
//!   Rust model must reproduce it to 1 microsecond everywhere, -2000..3000.
//! - `skyfield_finals_s`: Skyfield's timescale built from the same finals2000A.all, daily:
//!   the brief's "within 0.01 s of Skyfield's delta_t where both use IERS" over the whole
//!   IERS span 1973-01-02..2027-09-28 (observed and predicted), the splines and the
//!   parabola to 0.1 ms, and the future join inside the model's own uncertainty.
//! - `skyfield_builtin_s`: Skyfield's shipped timescale, whose table is an earlier
//!   finals2000A.all: within 0.01 s where it is observed and unrevised (to 2026-01-16),
//!   within 1 s on the Stephenson-Morrison-Hohenkerk splines (-720..1972), equal on the
//!   parabola. After 2026-01-16 its table is a January-2026 prediction, 0.11 s off the
//!   observations by September 2026; the difference is measured and must stay inside the
//!   model's own standard uncertainty or 0.35 s.
//! - `dut1_daily`, `bulletin_a_observed`: the weekly table against the daily series it was
//!   sampled from (flags `I` observed, `P` predicted), and against the text of IERS
//!   Bulletin A of 2026-09-24.
//! - `delta_t_sigma`: the standard uncertainty against an independent implementation of
//!   the rules in the generator.
//! - `calendar`: Julian day numbers against Skyfield's `compute_calendar_date` in both
//!   calendars, -7450..+17190.
//!
//! Run with `-- --nocapture` for the measured worst cases.

use serde::Deserialize;
use skyfix_core::calendar::{self, Calendar};
use skyfix_core::deltat::{self, DeltaTSource};
use skyfix_core::time;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Fixture {
    schema: String,
    generator: Generator,
    delta_t: Vec<DeltaTCase>,
    ut1_to_tt: Vec<Ut1Case>,
    dut1_daily: Vec<Dut1Case>,
    bulletin_a_observed: Vec<BulletinCase>,
    delta_t_sigma: Vec<SigmaCase>,
    calendar: Vec<CalendarCase>,
}

#[derive(Deserialize)]
struct Generator {
    tolerances: Tolerances,
    table: Table,
}

#[derive(Deserialize)]
struct Tolerances {
    delta_t_vs_python_model_s: f64,
    delta_t_vs_skyfield_finals_s: f64,
    delta_t_vs_skyfield_builtin_observed_s: f64,
    delta_t_vs_skyfield_smh2016_s: f64,
    dut1_vs_daily_s: f64,
    ut1_to_tt_s: f64,
    sigma_relative: f64,
}

#[derive(Deserialize)]
struct Table {
    first_mjd: f64,
    last_mjd: f64,
    samples: usize,
    last_observed_mjd: f64,
    skyfield_bundle: BundleComparison,
}

#[derive(Deserialize)]
struct BundleComparison {
    #[serde(rename = "agrees_within_0.1_ms_to_mjd")]
    agrees_to_mjd: f64,
}

#[derive(Deserialize)]
struct DeltaTCase {
    jd_tt: f64,
    band: String,
    delta_t_s: f64,
    skyfield_finals_s: f64,
    skyfield_builtin_s: f64,
}

#[derive(Deserialize)]
struct Ut1Case {
    jd_ut1: f64,
    jd_tt: f64,
    delta_t_s: f64,
}

#[derive(Deserialize)]
struct Dut1Case {
    mjd_utc: f64,
    flag: String,
    dut1_s: f64,
}

#[derive(Deserialize)]
struct BulletinCase {
    mjd_utc: f64,
    dut1_s: f64,
}

#[derive(Deserialize)]
struct SigmaCase {
    jd_tt: f64,
    sigma_s: f64,
}

#[derive(Deserialize)]
struct CalendarCase {
    jdn: i64,
    gregorian: (i64, u32, u32),
    julian: (i64, u32, u32),
}

fn fixture() -> Fixture {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/reference/timescales.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    let f: Fixture = serde_json::from_str(&text).unwrap();
    assert_eq!(f.schema, "skyfix.reference/1");
    f
}

const MJD0: f64 = 2_400_000.5;

#[test]
fn delta_t_reproduces_skyfields_construction_everywhere() {
    let f = fixture();
    let tol = f.generator.tolerances.delta_t_vs_python_model_s;
    let mut worst = (0.0_f64, 0.0, String::new());
    for c in &f.delta_t {
        let ours = deltat::delta_t(c.jd_tt).value_s;
        let err = (ours - c.delta_t_s).abs();
        assert!(
            err <= tol,
            "{} at jd_tt {}: {ours} vs {} ({err:e} s)",
            c.band,
            c.jd_tt,
            c.delta_t_s
        );
        if err > worst.0 {
            worst = (err, c.jd_tt, c.band.clone());
        }
        // The value-only hot path gives the same number.
        assert_eq!(deltat::delta_t_s(c.jd_tt), ours);
    }
    println!(
        "Delta-T vs Skyfield's build_delta_t on our table: {} cases, worst {:.2e} s ({} at jd_tt {})",
        f.delta_t.len(),
        worst.0,
        worst.2,
        worst.1
    );
}

/// Worst |difference| per band, with the year where it happens.
type Worst = std::collections::BTreeMap<String, (f64, f64)>;

fn see(worst: &mut Worst, band: &str, diff: f64, year: f64) {
    let w = worst.entry(band.to_string()).or_default();
    if diff > w.0 {
        *w = (diff, year);
    }
}

#[test]
fn delta_t_against_skyfield_from_the_same_iers_data() {
    let f = fixture();
    let t = &f.generator.tolerances;
    let mut worst = Worst::default();
    for c in &f.delta_t {
        let d = deltat::delta_t(c.jd_tt);
        let diff = (d.value_s - c.skyfield_finals_s).abs();
        let year = deltat::epoch_year(c.jd_tt);
        match c.band.as_str() {
            // Both read the same IERS days: only our weekly sampling differs.
            "iers_observed" | "iers_predicted" => {
                assert!(diff <= t.delta_t_vs_skyfield_finals_s, "{} {diff}", c.jd_tt)
            }
            // The splines' last segment meets each table's first value: ours is rounded
            // to 0.1 ms.
            "smh2016" | "parabola_and_join" => assert!(diff <= 1e-4, "{} {diff}", c.jd_tt),
            _ if year < 1973.0 || year >= deltat::parabola_rejoins_year() => {
                assert!(diff <= 1e-4, "{} {diff}", c.jd_tt)
            }
            // The join to the parabola starts from each table's end (ours up to six days
            // earlier) and last-year slope: inside the model's uncertainty.
            _ => assert!(diff <= d.sigma_s, "{} {diff} > {}", c.jd_tt, d.sigma_s),
        }
        see(&mut worst, &c.band, diff, year);
    }
    for (band, (d, y)) in worst {
        println!(
            "Delta-T vs Skyfield from the same finals2000A.all, {band}: worst {d:.4} s (year {y:.1})"
        );
    }
}

#[test]
fn delta_t_against_skyfields_own_timescale() {
    let f = fixture();
    let t = &f.generator.tolerances;
    let agrees_to = f.generator.table.skyfield_bundle.agrees_to_mjd;
    let mut worst = Worst::default();
    for c in &f.delta_t {
        let d = deltat::delta_t(c.jd_tt);
        let diff = (d.value_s - c.skyfield_builtin_s).abs();
        let mjd = c.jd_tt - MJD0 - 69.184 / 86_400.0;
        let year = deltat::epoch_year(c.jd_tt);
        let band = match c.band.as_str() {
            "iers_observed" if mjd <= agrees_to => {
                assert!(
                    diff <= t.delta_t_vs_skyfield_builtin_observed_s,
                    "{} {diff}",
                    c.jd_tt
                );
                "iers_observed, both observed".to_string()
            }
            "smh2016" => {
                assert!(
                    diff <= t.delta_t_vs_skyfield_smh2016_s,
                    "{} {diff}",
                    c.jd_tt
                );
                c.band.clone()
            }
            "parabola_and_join" => {
                assert!(diff <= 1e-6, "{} {diff}", c.jd_tt);
                c.band.clone()
            }
            _ if year >= deltat::parabola_rejoins_year() || year < -720.0 => {
                assert!(diff <= 1e-6, "{} {diff}", c.jd_tt);
                c.band.clone()
            }
            // After 2026-01-16 Skyfield's bundle is its January-2026 prediction, and its
            // join to the parabola starts from that: inside our uncertainty or 0.35 s.
            other => {
                assert!(
                    diff <= d.sigma_s.max(0.35),
                    "{} {diff} > {}",
                    c.jd_tt,
                    d.sigma_s
                );
                if other == "iers_observed" {
                    "iers_observed, bundle predicted".to_string()
                } else {
                    other.to_string()
                }
            }
        };
        see(&mut worst, &band, diff, year);
    }
    for (band, (d, y)) in worst {
        println!("Delta-T vs Skyfield 1.55's own timescale, {band}: worst {d:.4} s (year {y:.1})");
    }
}

#[test]
fn ut1_to_tt_as_skyfield() {
    let f = fixture();
    for c in &f.ut1_to_tt {
        let tt = deltat::tt_of_ut1(c.jd_ut1);
        let err = ((tt - c.jd_tt) * 86_400.0).abs();
        assert!(
            err <= f.generator.tolerances.ut1_to_tt_s.max(2e-5),
            "{}: {err}",
            c.jd_ut1
        );
        let dt = deltat::tt_minus_ut1_s(c.jd_ut1);
        assert!(
            (dt - c.delta_t_s).abs() <= f.generator.tolerances.ut1_to_tt_s,
            "{}",
            c.jd_ut1
        );
        // On the UT scale the clock is UT1: TT from the clock is the same.
        if time::scale_at(c.jd_ut1) == time::ClockScale::Ut {
            assert_eq!(time::tt_from_clock(c.jd_ut1), tt);
            let back = time::clock_from_tt(tt);
            assert!(((back - c.jd_ut1) * 86_400.0).abs() < 1e-4);
        }
    }
}

#[test]
fn dut1_table_against_the_daily_series_and_bulletin_a() {
    let f = fixture();
    let tab = &f.generator.table;
    assert_eq!(tab.samples, 2857);
    let (first, last, last_obs) = deltat::iers_table_span();
    assert_eq!(first, tab.first_mjd + MJD0);
    assert_eq!(last, tab.last_mjd + MJD0);
    assert_eq!(last_obs, tab.last_observed_mjd + MJD0);
    let mut worst = 0.0_f64;
    for c in &f.dut1_daily {
        let (v, _) = deltat::iers_dut1(c.mjd_utc + MJD0).unwrap();
        let err = (v - c.dut1_s).abs();
        assert!(
            err <= f.generator.tolerances.dut1_vs_daily_s,
            "MJD {}: {v} vs {}",
            c.mjd_utc,
            c.dut1_s
        );
        worst = worst.max(err);
        // The same through the public lookup on the UTC scale.
        let d = time::dut1_info(c.mjd_utc + MJD0, None);
        assert_eq!(d.source, time::Dut1Source::Iers);
        assert_eq!(d.value_s, v);
        // Observed days carry the table's 1 ms; predicted ones at least that.
        match c.flag.as_str() {
            "I" => assert_eq!(d.sigma_s, deltat::SIGMA_OBSERVED_S, "MJD {}", c.mjd_utc),
            "P" => assert!(d.sigma_s >= deltat::SIGMA_OBSERVED_S, "MJD {}", c.mjd_utc),
            other => panic!("flag {other:?}"),
        }
    }
    for c in &f.bulletin_a_observed {
        let (v, s) = deltat::iers_dut1(c.mjd_utc + MJD0).unwrap();
        assert!(
            (v - c.dut1_s).abs() <= f.generator.tolerances.dut1_vs_daily_s,
            "MJD {}",
            c.mjd_utc
        );
        assert_eq!(s, deltat::SIGMA_OBSERVED_S);
    }
    println!(
        "DUT1 weekly table vs the daily series: {} dates, worst {:.2} ms",
        f.dut1_daily.len(),
        worst * 1e3
    );
}

#[test]
fn sigma_follows_the_documented_rules() {
    let f = fixture();
    for c in &f.delta_t_sigma {
        let s = deltat::delta_t(c.jd_tt).sigma_s;
        assert!(
            (s - c.sigma_s).abs() <= f.generator.tolerances.sigma_relative * c.sigma_s.max(1.0),
            "jd_tt {} (year {:.1}): {s} vs {}",
            c.jd_tt,
            deltat::epoch_year(c.jd_tt),
            c.sigma_s
        );
    }
}

#[test]
fn sources_are_labelled() {
    let f = fixture();
    for c in &f.delta_t {
        let d = deltat::delta_t(c.jd_tt);
        let expect = match c.band.as_str() {
            "iers_observed" => Some(DeltaTSource::Iers),
            "iers_predicted" => Some(DeltaTSource::Prediction),
            "smh2016" => Some(DeltaTSource::Smh2016),
            "parabola_and_join" => Some(DeltaTSource::Parabola),
            "future" => Some(
                if deltat::epoch_year(c.jd_tt) >= deltat::parabola_rejoins_year() {
                    DeltaTSource::Parabola
                } else {
                    DeltaTSource::Prediction
                },
            ),
            _ => None,
        };
        if let Some(e) = expect {
            assert_eq!(d.source, e, "{} {}", c.band, c.jd_tt);
        }
    }
}

#[test]
fn calendars_match_skyfield() {
    let f = fixture();
    for c in &f.calendar {
        assert_eq!(
            calendar::civil_from_jdn(Calendar::Gregorian, c.jdn),
            c.gregorian,
            "JDN {}",
            c.jdn
        );
        assert_eq!(
            calendar::civil_from_jdn(Calendar::Julian, c.jdn),
            c.julian,
            "JDN {}",
            c.jdn
        );
        let (y, m, d) = c.gregorian;
        assert_eq!(
            calendar::jdn_from_civil(Calendar::Gregorian, y, m, d),
            c.jdn
        );
        let (y, m, d) = c.julian;
        assert_eq!(calendar::jdn_from_civil(Calendar::Julian, y, m, d), c.jdn);
    }
}

#[test]
fn time_info_is_fast() {
    // The interface calls time_info on every redraw: under 50 microseconds natively.
    let jds: Vec<f64> = (0..2000)
        .map(|i| 990_000.0 + f64::from(i) * 1_000.37)
        .collect();
    let _ = time::time_info(jds[0], None).unwrap();
    let start = std::time::Instant::now();
    let mut n = 0usize;
    for &jd in &jds {
        n += time::time_info(jd, Some(0.1)).unwrap().notes.len();
    }
    let per = start.elapsed().as_secs_f64() / jds.len() as f64;
    println!(
        "time_info: {:.2} microseconds per call ({n} notes)",
        per * 1e6
    );
    // Generous for a debug build; the release figure is reported in ACCURACY.md.
    assert!(per < 500e-6, "{per}");
}
