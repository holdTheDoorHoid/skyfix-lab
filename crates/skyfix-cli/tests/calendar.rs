//! End-to-end tests of `skyfix calendar` and the global `--calendar` flag
//! (CONVENTIONS 15.2-15.3). OWNER: timescales agent.
//!
//! `skyfix calendar --format json` must be exactly `skyfix_core::calendar::calendar_convert`
//! and `skyfix_core::time::time_info` for the same instant; the text names both calendars.
//! `--calendar` must change how a typed date is read and how dates are printed, never the
//! JSON's wire strings.

mod support;

use skyfix_core::calendar::{CalendarConvertRequest, calendar_convert};
use skyfix_core::time::time_info;
use support::skyfix;

#[test]
fn the_json_is_the_core_functions_result() {
    let run = skyfix(["calendar", "-0584-05-28", "--format", "json"]).expect_code(0);
    let v = run.json();
    let jd = 1_507_899.5;
    let want = serde_json::to_value(
        calendar_convert(&CalendarConvertRequest {
            jd_utc: Some(jd),
            civil: None,
        })
        .unwrap(),
    )
    .unwrap();
    for k in ["jd_utc", "gregorian", "julian"] {
        assert_eq!(v[k], want[k], "{k}");
    }
    assert_eq!(
        v["time_info"],
        serde_json::to_value(time_info(jd, None).unwrap()).unwrap()
    );
    assert_eq!(v["weekday"], "Wednesday");
}

#[test]
fn a_date_before_the_reform_is_julian_and_says_so() {
    skyfix(["calendar", "-0584-05-28"])
        .expect_code(0)
        .expect_stdout("Julian       -0584-05-28  28 May 585 BC, astronomical year -0584")
        .expect_stdout("Gregorian    -0584-05-22  22 May 585 BC")
        .expect_stdout("(proleptic)")
        .expect_stdout("Clock        UT")
        .expect_stdout("Wire         -0584-05-22T00:00:00.000Z");
    // The same day typed in the proleptic Gregorian calendar.
    skyfix(["calendar", "-0584-05-22", "--calendar", "gregorian"])
        .expect_code(0)
        .expect_stdout("Julian date  1507899.500000")
        .expect_stdout("Shown as     Gregorian, as --calendar asks");
}

#[test]
fn the_ten_lost_days_need_a_calendar() {
    skyfix(["calendar", "1582-10-10"])
        .expect_code(1)
        .expect_stderr("--calendar julian or --calendar gregorian");
    skyfix(["calendar", "1582-10-10", "--calendar", "julian"])
        .expect_code(0)
        .expect_stdout("Gregorian    1582-10-20");
}

#[test]
fn a_julian_date_on_any_command_reads_and_prints_in_julian() {
    // Julian 2026-09-11 12:00 is Gregorian 2026-09-24 12:00: the same sky, the dates in
    // the text in the calendar asked for, the JSON on the wire's Gregorian.
    let g = skyfix([
        "sky",
        "--lat",
        "39.95",
        "--lon",
        "-75.17",
        "--utc",
        "2026-09-24T12:00:00Z",
        "--bodies",
        "Sun",
        "--format",
        "json",
    ])
    .expect_code(0)
    .json();
    let j = skyfix([
        "sky",
        "--lat",
        "39.95",
        "--lon",
        "-75.17",
        "--utc",
        "2026-09-11T12:00:00Z",
        "--bodies",
        "Sun",
        "--format",
        "json",
        "--calendar",
        "julian",
    ])
    .expect_code(0)
    .json();
    assert_eq!(g, j);
    assert_eq!(j["utc"], "2026-09-24T12:00:00.000Z");
    skyfix([
        "sky",
        "--lat",
        "39.95",
        "--lon",
        "-75.17",
        "--utc",
        "2026-09-11T12:00:00Z",
        "--bodies",
        "Sun",
        "--calendar",
        "julian",
    ])
    .expect_code(0)
    .expect_stdout("2026-09-11T12:00:00Z (Julian)");
}
