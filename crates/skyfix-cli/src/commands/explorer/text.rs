//! Navigator-style numbers for the explorer commands' text reports. OWNER: cli agent.
//!
//! Angles are printed the way the Nautical Almanac prints them: whole degrees and
//! arcminutes to a tenth (0.1' is 185 m), `183 12.4` for an hour angle or a bearing,
//! `N 38 47.1` for a declination, and a sign on an altitude so a body below the horizon
//! cannot be read as one above it. Rounding happens once, on the total arcminutes, so
//! 59.96' carries into the degrees instead of printing an impossible `60.0`.
//!
//! Times are to the second, on the app's clock (CONVENTIONS 15.2): UTC with a trailing
//! `Z` from 1972 to 2035, `UT` outside it; dates are Julian before 1582-10-15, labelled
//! `(Julian)`, unless `--calendar` says otherwise (15.3). The JSON output keeps the
//! engine's milliseconds and the wire's proleptic Gregorian dates.

use skyfix_core::calendar::{self, Calendar, CivilDateTime};
use skyfix_core::time::{self, ClockScale, JD_UNIX_EPOCH};

/// `(whole degrees, arcminutes)` of `|deg|`, rounded once to tenths of an arcminute.
fn split(deg_abs: f64) -> (i64, f64) {
    let tenths = (deg_abs * 600.0).round();
    let d = (tenths / 600.0).floor();
    let m = (tenths - d * 600.0) / 10.0;
    (d as i64, m)
}

/// An angle in `[0, 360)` — GHA, SHA, azimuth — as `183 12.4`, degrees right-aligned in
/// three. A value that rounds up to 360 prints as `0 00.0`, the same direction.
pub fn dm360(deg: f64) -> String {
    if !deg.is_finite() {
        return format!("{deg:>8}");
    }
    let (mut d, m) = split(deg.rem_euclid(360.0));
    if d >= 360 {
        d -= 360;
    }
    format!("{d:>3} {m:04.1}")
}

/// `(negative, whole degrees, arcminutes)` of a signed angle. A value that rounds to
/// zero is not negative, so nothing prints as `-0 00.0`.
fn signed(deg: f64) -> (bool, i64, f64) {
    let (d, m) = split(deg.abs());
    (deg < 0.0 && (d > 0 || m > 0.0), d, m)
}

/// A signed angle — an altitude — as `+61 04.3` or `-12 30.0`, degrees right-aligned in
/// two, for a table column.
pub fn alt(deg: f64) -> String {
    if !deg.is_finite() {
        return format!("{deg:>8}");
    }
    let (neg, d, m) = signed(deg);
    format!("{}{d:>2} {m:04.1}", if neg { '-' } else { '+' })
}

/// An altitude inside a sentence: `-6 00.0`, `+49 23.1`.
pub fn alt_inline(deg: f64) -> String {
    if !deg.is_finite() {
        return deg.to_string();
    }
    let (neg, d, m) = signed(deg);
    format!("{}{d} {m:04.1}", if neg { '-' } else { '+' })
}

/// A declination as `N 38 47.1` or `S  0 23.3` (the Almanac's layout), for a table.
pub fn dec(deg: f64) -> String {
    if !deg.is_finite() {
        return format!("{deg:>9}");
    }
    let (neg, d, m) = signed(deg);
    format!("{} {d:>2} {m:04.1}", if neg { 'S' } else { 'N' })
}

/// A declination inside a sentence: `S 0 23.3`, `N 26 18.3`.
pub fn dec_inline(deg: f64) -> String {
    if !deg.is_finite() {
        return deg.to_string();
    }
    let (neg, d, m) = signed(deg);
    format!("{} {d} {m:04.1}", if neg { 'S' } else { 'N' })
}

/// A course in degrees true the way a navigator writes it: `045`, `000`, or `045.5`
/// when it is not a whole degree.
pub fn course(deg: f64) -> String {
    if deg.fract() == 0.0 {
        format!("{deg:03.0}")
    } else {
        format!("{deg:05.1}")
    }
}

/// `jd_utc` rounded to the nearest whole second.
pub fn round_to_second(jd_utc: f64) -> f64 {
    let s = ((jd_utc - JD_UNIX_EPOCH) * 86_400.0).round();
    JD_UNIX_EPOCH + s / 86_400.0
}

/// The calendar text output shows a date in: `--calendar`, else Julian before
/// 1582-10-15 (CONVENTIONS 15.3).
pub fn display_calendar(jd: f64) -> Calendar {
    super::args::calendar_choice().unwrap_or_else(|| calendar::calendar_for_jd(jd))
}

/// `2026-10-01T01:30:00Z`: RFC 3339 UTC, to the nearest second. Outside 1972-2035 the
/// clock is UT: `1900-01-01T00:00:00 UT`; before 1582-10-15 the date is Julian and says
/// so, `-0584-05-28T12:00:00 UT (Julian)`.
pub fn utc(jd_utc: f64) -> String {
    let jd = round_to_second(jd_utc);
    let cal = display_calendar(jd);
    let Some(c) = CivilDateTime::from_jd(jd, cal) else {
        return format!("JD {jd_utc}");
    };
    let mut s = format!("{}T{}", c.date_string(), c.time_string());
    s.push_str(match time::scale_at(jd) {
        ClockScale::Utc => "Z",
        ClockScale::Ut => " UT",
    });
    if cal == Calendar::Julian {
        s.push_str(" (Julian)");
    }
    s
}

/// The clock's word at `jd_utc`, for a table heading over times [`utc`] prints: `UTC`
/// from 1972 to 2035, `UT` outside (CONVENTIONS 15.2).
pub fn scale_word(jd_utc: f64) -> &'static str {
    match time::scale_at(round_to_second(jd_utc)) {
        ClockScale::Utc => "UTC",
        ClockScale::Ut => "UT",
    }
}

/// The time of day `HH:MM:SS` at `offset_minutes` from UTC (0 for UTC itself), to the
/// nearest second.
pub fn clock(jd_utc: f64, offset_minutes: i32) -> String {
    let jd = round_to_second(jd_utc) + f64::from(offset_minutes) / 1440.0;
    CivilDateTime::from_jd(jd, Calendar::Gregorian)
        .map_or_else(|| format!("JD {jd}"), |c| c.time_string())
}

/// The date and time of day `YYYY-MM-DD HH:MM:SS` at `offset_minutes` from UTC, to the
/// nearest second: a local time for a list that runs over several days. The date is in
/// the display calendar ([`display_calendar`]).
pub fn local_datetime(jd_utc: f64, offset_minutes: i32) -> String {
    let jd = round_to_second(jd_utc) + f64::from(offset_minutes) / 1440.0;
    CivilDateTime::from_jd(jd, display_calendar(jd)).map_or_else(
        || format!("JD {jd}"),
        |c| format!("{} {}", c.date_string(), c.time_string()),
    )
}

/// A duration in seconds as `58 s`, `3 min 51 s` or `2 h 39 min 22 s`, to the nearest
/// second: for eclipse phases, where seconds matter.
pub fn duration_s(seconds: f64) -> String {
    if !seconds.is_finite() {
        return seconds.to_string();
    }
    let s = seconds.round().max(0.0) as i64;
    match (s / 3600, (s % 3600) / 60, s % 60) {
        (0, 0, sec) => format!("{sec} s"),
        (0, m, sec) => format!("{m} min {sec:02} s"),
        (h, m, sec) => format!("{h} h {m:02} min {sec:02} s"),
    }
}

/// A duration in hours as `12 h 05 min`, to the nearest minute.
pub fn hours_minutes(hours: f64) -> String {
    let total = (hours * 60.0).round() as i64;
    format!("{} h {:02} min", total / 60, total % 60)
}

/// A signed duration in seconds as `+9 min 42 s` or `-35 s`, to the nearest second.
pub fn signed_min_s(seconds: f64) -> String {
    let total = seconds.round() as i64;
    let sign = if total < 0 { '-' } else { '+' };
    let a = total.abs();
    if a >= 60 {
        format!("{sign}{} min {:02} s", a / 60, a % 60)
    } else {
        format!("{sign}{a} s")
    }
}

/// `x` to `decimals` places, never as a negative zero: a residual of -1e-12 prints as
/// `0.00`, not `-0.00`, so noise below the printed precision cannot show up as a sign.
pub fn fixed(x: f64, decimals: usize) -> String {
    let s = format!("{x:.decimals$}");
    if s.starts_with('-') && s[1..].bytes().all(|b| b == b'0' || b == b'.') {
        s[1..].to_string()
    } else {
        s
    }
}

/// As [`fixed`], with an explicit `+` on positive values: `+0.43`, `-1.20`, `0.00`.
pub fn signed_fixed(x: f64, decimals: usize) -> String {
    let s = fixed(x, decimals);
    if s.starts_with('-') || s.bytes().all(|b| b == b'0' || b == b'.') {
        s
    } else {
        format!("+{s}")
    }
}

/// `Some(x)` with `decimals`, right-aligned in `width`; `None` as `-`.
pub fn opt(v: Option<f64>, width: usize, decimals: usize) -> String {
    match v {
        Some(x) => format!("{:>width$}", fixed(x, decimals)),
        None => format!("{:>width$}", "-"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angles_print_the_almanac_way() {
        assert_eq!(dm360(183.2067), "183 12.4");
        assert_eq!(dm360(2.5), "  2 30.0");
        assert_eq!(dm360(359.9999), "  0 00.0");
        assert_eq!(dm360(-10.0), "350 00.0");
        assert_eq!(alt(61.0717), "+61 04.3");
        assert_eq!(alt(-12.5), "-12 30.0");
        assert_eq!(alt(-0.0001), "+ 0 00.0");
        assert_eq!(dec(38.785), "N 38 47.1");
        assert_eq!(dec(-0.3883), "S  0 23.3");
        assert_eq!(alt_inline(-6.0), "-6 00.0");
        assert_eq!(alt_inline(49.385), "+49 23.1");
        assert_eq!(dec_inline(-0.3883), "S 0 23.3");
        assert_eq!(dec_inline(26.305), "N 26 18.3");
        assert_eq!(course(45.0), "045");
        assert_eq!(course(0.0), "000");
        assert_eq!(course(45.5), "045.5");
    }

    #[test]
    fn rounding_carries_into_the_degrees() {
        // 39.99999 deg is 39 deg 59.9994', which must not print as "39 60.0".
        assert_eq!(dm360(39.99999), " 40 00.0");
        assert_eq!(alt(-39.99999), "-40 00.0");
        assert_eq!(dec(39.99999), "N 40 00.0");
    }

    #[test]
    fn times_are_utc_with_z_to_the_second() {
        let jd = skyfix_core::time::parse_utc("2026-10-01T01:29:59.600Z").unwrap();
        assert_eq!(utc(jd), "2026-10-01T01:30:00Z");
        assert_eq!(clock(jd, 0), "01:30:00");
        assert_eq!(clock(jd, -240), "21:30:00");
        assert_eq!(clock(jd, 330), "07:00:00");
        assert_eq!(hours_minutes(12.0806), "12 h 05 min");
        assert_eq!(signed_min_s(582.2), "+9 min 42 s");
        assert_eq!(signed_min_s(-35.4), "-35 s");
        assert_eq!(local_datetime(jd, 0), "2026-10-01 01:30:00");
        // Four hours west of Greenwich it is still the evening before.
        assert_eq!(local_datetime(jd, -240), "2026-09-30 21:30:00");
        assert_eq!(local_datetime(jd, 720), "2026-10-01 13:30:00");
        assert_eq!(duration_s(58.4), "58 s");
        assert_eq!(duration_s(231.2), "3 min 51 s");
        assert_eq!(duration_s(9562.5), "2 h 39 min 23 s");
        assert_eq!(duration_s(3600.0), "1 h 00 min 00 s");
    }

    #[test]
    fn far_dates_say_ut_and_julian() {
        let t = |s: &str| skyfix_core::time::parse_utc(s).unwrap();
        // UTC 1972-2035, UT outside; the Julian calendar before 1582-10-15.
        assert_eq!(utc(t("1971-12-31T23:59:59.6Z")), "1972-01-01T00:00:00Z");
        assert_eq!(utc(t("1971-12-31T12:00:00Z")), "1971-12-31T12:00:00 UT");
        assert_eq!(utc(t("2036-01-01T00:00:00Z")), "2036-01-01T00:00:00 UT");
        assert_eq!(utc(t("1582-10-15T00:00:00Z")), "1582-10-15T00:00:00 UT");
        assert_eq!(
            utc(t("1582-10-14T23:59:59Z")),
            "1582-10-04T23:59:59 UT (Julian)"
        );
        let thales = t("-0584-05-22T12:00:00Z");
        assert_eq!(utc(thales), "-0584-05-28T12:00:00 UT (Julian)");
        assert_eq!(clock(thales, 0), "12:00:00");
        assert_eq!(local_datetime(thales, -60), "-0584-05-28 11:00:00");
        assert_eq!(
            local_datetime(t("+12345-01-01T00:00:00Z"), 0),
            "+12345-01-01 00:00:00"
        );
    }

    #[test]
    fn a_heading_names_the_clock_of_its_times() {
        let t = |s: &str| skyfix_core::time::parse_utc(s).unwrap();
        assert_eq!(scale_word(t("2026-10-01T00:00:00Z")), "UTC");
        assert_eq!(scale_word(t("1971-06-01T00:00:00Z")), "UT");
        assert_eq!(scale_word(t("-0584-05-28T12:00:00Z")), "UT");
    }

    #[test]
    fn noise_below_the_printed_precision_has_no_sign() {
        assert_eq!(fixed(-1e-12, 2), "0.00");
        assert_eq!(fixed(-0.004, 2), "0.00");
        assert_eq!(fixed(-0.006, 2), "-0.01");
        assert_eq!(signed_fixed(-1e-12, 1), "0.0");
        assert_eq!(signed_fixed(0.43, 2), "+0.43");
        assert_eq!(signed_fixed(-1.2, 2), "-1.20");
        assert_eq!(opt(Some(-1e-9), 6, 2), "  0.00");
    }
}
