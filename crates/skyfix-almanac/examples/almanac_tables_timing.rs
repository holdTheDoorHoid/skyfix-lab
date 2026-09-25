//! CPU cost of the almanac tables and the three-day opening (release build), one kind
//! per run so that `time` can report user CPU time on a busy machine:
//! `cargo run --release -p skyfix-almanac --example almanac_tables_timing -- opening 5`.
use skyfix_almanac::opening::almanac_opening;
use skyfix_almanac::pages::almanac_day;
use skyfix_almanac::tables::{altitude_tables, increments, planet_corrections, polaris_table};
use skyfix_core::calendar::Calendar;
use skyfix_ephemeris::body::Sky;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let what = args.get(1).map_or("day", String::as_str);
    let n: usize = args.get(2).and_then(|x| x.parse().ok()).unwrap_or(5);
    let sky = Sky::new();
    for k in 0..n {
        let date = format!("2026-09-{:02}", 1 + k % 28);
        match what {
            "day" => drop(std::hint::black_box(almanac_day(&sky, &date).unwrap())),
            "opening" => drop(std::hint::black_box(
                almanac_opening(&sky, &date, None).unwrap(),
            )),
            "increments" => drop(std::hint::black_box(increments((k % 60) as u32).unwrap())),
            "altitude" => drop(std::hint::black_box(altitude_tables(None).unwrap())),
            "planets" => drop(std::hint::black_box(
                planet_corrections(&sky, 2000 + k as i64, Calendar::Gregorian).unwrap(),
            )),
            "polaris" => drop(std::hint::black_box(
                polaris_table(&sky, 2000 + k as i64, Calendar::Gregorian).unwrap(),
            )),
            "none" => {}
            other => panic!("unknown {other}"),
        }
    }
}
