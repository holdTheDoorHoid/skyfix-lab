//! End-to-end tests of `skyfix almanac`. OWNER: almanac agent.
//!
//! The numbers themselves are validated against Skyfield in
//! `crates/skyfix-almanac/tests/almanac_reference.rs`; these check what the command adds:
//! the flags, the layout, the JSON document and the exit codes.

mod support;

use support::skyfix;

#[test]
fn almanac_prints_both_pages_with_every_section() {
    skyfix(["almanac", "--date", "2026-09-24"])
        .expect_code(0)
        .expect_stdout("2026-09-24 (THURSDAY)")
        .expect_stdout("Not a navigation instrument.")
        .expect_stdout("LEFT PAGE: ARIES, PLANETS, STARS")
        .expect_stdout("VENUS -4.8")
        .expect_stdout("Mer. Pass. of Aries 23 44.7")
        .expect_stdout("Zubenelgenubi")
        .expect_stdout("Polaris")
        .expect_stdout("RIGHT PAGE: SUN, MOON, TWILIGHT, SUNRISE, MOONRISE")
        .expect_stdout("00   181 57.1  S  0 23.3    32 25.8  14.1  S 12 13.1  13.7  56.0")
        .expect_stdout("N 72    03 10  04 39   05 47    18 06  17 31")
        .expect_stdout("SUN   Eqn. of Time 00h  07 48   12h  07 59   Mer. Pass. 11 52")
        .expect_stdout("Age 13 d   95 % illuminated")
        // pages::NOTES[0], the almanac owner's wording of CONVENTIONS 15.2.
        .expect_stdout_flat(
            "UT is UT1, as in the printed almanac: enter the tables with UTC + DUT1, the time \
             signal's correction (CONVENTIONS 15.2). Outside 1972-2035 the clock is UT itself.",
        );
}

#[test]
fn almanac_json_is_the_almanac_day_document() {
    let run = skyfix(["almanac", "--date", "2026-09-24", "--format", "json"]).expect_code(0);
    let v = run.json();
    assert_eq!(v["date"], "2026-09-24");
    assert_eq!(v["hours"].as_array().unwrap().len(), 24);
    assert_eq!(v["hours"][0]["sun"]["printed"]["gha"], "181 57.1");
    assert_eq!(v["rise_set"]["rows"].as_array().unwrap().len(), 31);
    assert_eq!(v["stars"].as_array().unwrap().len(), 58);
    assert!(v["hours"][0]["moon"]["v_arcmin"].is_number());
}

#[test]
fn almanac_shows_the_polar_symbols_and_negative_equation_of_time() {
    // June solstice: midnight sun at 72 N, twilight all night further south.
    skyfix(["almanac", "--date", "1992-06-21"])
        .expect_code(0)
        .expect_stdout("N 72        \u{25A1}      \u{25A1}       \u{25A1}")
        .expect_stdout("////");
    // Mid-February: the Sun crosses the meridian about 14 minutes after noon.
    skyfix(["almanac", "--date", "2026-02-11"])
        .expect_code(0)
        .expect_stdout("Eqn. of Time 00h -14 ")
        .expect_stdout("Mer. Pass. 12 14");
}

#[test]
fn almanac_refuses_bad_or_uncovered_dates_with_exit_1() {
    skyfix(["almanac", "--date", "2026-9-24"])
        .expect_code(1)
        .expect_stderr("YYYY-MM-DD");
    // Past the validated tier (2650-01-22, deeptime agent).
    skyfix(["almanac", "--date", "2651-01-01"])
        .expect_code(1)
        .expect_stderr("coverage");
    skyfix(["almanac", "--date", "2026-09-24", "--format", "pdf"]).expect_code(1);
    skyfix(["almanac"]).expect_code(1);
}
