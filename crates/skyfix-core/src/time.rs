//! CONVENTIONS section 6: UTC parsing, Julian dates, leap seconds, TT and UT1.
//!
//! Timestamps are RFC 3339 with a trailing `Z`. Internally a Julian date of the UTC
//! calendar instant (`jd_utc`) is used. Terrestrial Time is derived through the
//! leap-second table below; UT1 is UTC plus an externally supplied DUT1 (default 0).

use crate::SkyfixError;
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};

/// JD of the Unix epoch 1970-01-01T00:00:00Z.
pub const JD_UNIX_EPOCH: f64 = 2_440_587.5;
/// JD of J2000.0 (2000-01-01T12:00:00 TT).
pub const JD_J2000: f64 = 2_451_545.0;
pub const TT_MINUS_TAI_S: f64 = 32.184;

/// Parse an RFC 3339 timestamp that must be in UTC (`Z` suffix). Returns `jd_utc`.
pub fn parse_utc(s: &str) -> Result<f64, SkyfixError> {
    let trimmed = s.trim();
    // Strict form: date, 'T', time, 'Z'. chrono would also accept a space separator.
    if !trimmed.ends_with('Z') || trimmed.len() < 20 || trimmed.as_bytes()[10] != b'T' {
        return Err(SkyfixError::InvalidTimestamp(s.to_string()));
    }
    let dt = DateTime::parse_from_rfc3339(trimmed)
        .map_err(|_| SkyfixError::InvalidTimestamp(s.to_string()))?;
    let secs = dt.timestamp() as f64 + f64::from(dt.timestamp_subsec_nanos()) * 1e-9;
    Ok(JD_UNIX_EPOCH + secs / 86_400.0)
}

/// Format `jd_utc` back to RFC 3339 with millisecond precision and a `Z` suffix.
pub fn format_utc(jd_utc: f64) -> String {
    // Round to the nearest millisecond first: f64 Julian dates resolve ~40 microseconds,
    // so truncation would print 01:32:00 as 01:31:59.999.
    let millis = ((jd_utc - JD_UNIX_EPOCH) * 86_400_000.0).round();
    let whole = (millis / 1000.0).floor();
    let nanos = ((millis - whole * 1000.0) * 1e6) as u32;
    match Utc.timestamp_opt(whole as i64, nanos) {
        chrono::LocalResult::Single(dt) => dt.to_rfc3339_opts(SecondsFormat::Millis, true),
        _ => format!("JD {jd_utc}"),
    }
}

/// Julian date of a proleptic Gregorian civil date at 0h (Fliegel & Van Flandern).
pub fn civil_to_jd(year: i32, month: u32, day: u32) -> f64 {
    let a = (14 - month as i32) / 12;
    let y = year + 4800 - a;
    let m = month as i32 + 12 * a - 3;
    let jdn = day as i32 + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    jdn as f64 - 0.5
}

/// TAI - UTC leap-second table (IERS Bulletin C). Last entry: 2017-01-01, 37 s.
/// No leap second has been announced since; the table is valid through the build date.
const LEAP_SECONDS: &[(i32, u32, u32, f64)] = &[
    (1972, 1, 1, 10.0),
    (1972, 7, 1, 11.0),
    (1973, 1, 1, 12.0),
    (1974, 1, 1, 13.0),
    (1975, 1, 1, 14.0),
    (1976, 1, 1, 15.0),
    (1977, 1, 1, 16.0),
    (1978, 1, 1, 17.0),
    (1979, 1, 1, 18.0),
    (1980, 1, 1, 19.0),
    (1981, 7, 1, 20.0),
    (1982, 7, 1, 21.0),
    (1983, 7, 1, 22.0),
    (1985, 7, 1, 23.0),
    (1988, 1, 1, 24.0),
    (1990, 1, 1, 25.0),
    (1991, 1, 1, 26.0),
    (1992, 7, 1, 27.0),
    (1993, 7, 1, 28.0),
    (1994, 7, 1, 29.0),
    (1996, 1, 1, 30.0),
    (1997, 7, 1, 31.0),
    (1999, 1, 1, 32.0),
    (2006, 1, 1, 33.0),
    (2009, 1, 1, 34.0),
    (2012, 7, 1, 35.0),
    (2015, 7, 1, 36.0),
    (2017, 1, 1, 37.0),
];

/// TAI - UTC in seconds at `jd_utc`. Before 1972 returns 10 s (out of scope; callers
/// that care about pre-1972 dates must reject them at a higher level).
pub fn delta_at(jd_utc: f64) -> f64 {
    let mut d = 10.0;
    for &(y, m, day, v) in LEAP_SECONDS {
        if jd_utc >= civil_to_jd(y, m, day) {
            d = v;
        } else {
            break;
        }
    }
    d
}

/// Terrestrial Time as a Julian date.
pub fn jd_tt(jd_utc: f64) -> f64 {
    jd_utc + (delta_at(jd_utc) + TT_MINUS_TAI_S) / 86_400.0
}

/// UT1 as a Julian date, given DUT1 = UT1 - UTC in seconds (0 when unknown).
pub fn jd_ut1(jd_utc: f64, dut1_s: f64) -> f64 {
    jd_utc + dut1_s / 86_400.0
}

/// Julian centuries since J2000.0 for a given (TT or UT1) Julian date.
pub fn centuries_since_j2000(jd: f64) -> f64 {
    (jd - JD_J2000) / 36_525.0
}

// --- moonshape (expansion programme, 2026-09-24): the single DUT1 lookup -----------

/// DUT1 = UT1 - UTC in seconds at `jd_utc`: the navigator's own value (a session's
/// `clock.dut1_s`, the CLI's `--dut1`) when given, otherwise the engine's.
///
/// This is the one lookup every reduce, solve, predict and plan path goes through
/// (EXPLORER_API.md, "Expansion programme", session schema). **Interim fallback:** with
/// no user value it returns 0 s, the CONVENTIONS section 6 assumption this programme
/// retires; the timescales agent replaces that fallback with the IERS history (1973 to
/// the build date) and the model of CONVENTIONS 15.2, keeping this signature. A user
/// value always wins.
pub fn dut1_s(jd_utc: f64, user: Option<f64>) -> f64 {
    let _ = jd_utc;
    user.unwrap_or(0.0)
}

// --- end moonshape ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn parses_only_utc_z() {
        assert_relative_eq!(parse_utc("2000-01-01T12:00:00Z").unwrap(), 2_451_545.0);
        assert_relative_eq!(parse_utc("1970-01-01T00:00:00Z").unwrap(), JD_UNIX_EPOCH);
        assert_relative_eq!(
            parse_utc("2026-10-01T01:30:00.500Z").unwrap(),
            civil_to_jd(2026, 10, 1) + (1.5 * 3600.0 + 0.5) / 86_400.0,
            epsilon = 1e-9
        );
        assert!(parse_utc("2026-10-01T01:30:00+00:00").is_err());
        assert!(parse_utc("2026-10-01T01:30:00").is_err());
        assert!(parse_utc("2026-10-01 01:30:00Z").is_err());
        assert!(parse_utc("").is_err());
    }

    #[test]
    fn round_trips() {
        let s = "2026-10-01T01:30:00.250Z";
        assert_eq!(format_utc(parse_utc(s).unwrap()), s);
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_to_jd(2000, 1, 1), 2_451_544.5);
        assert_eq!(civil_to_jd(1970, 1, 1), 2_440_587.5);
        assert_eq!(civil_to_jd(2026, 9, 23), 2_461_306.5);
    }

    #[test]
    fn leap_seconds() {
        assert_eq!(delta_at(civil_to_jd(2026, 9, 23)), 37.0);
        assert_eq!(delta_at(civil_to_jd(2016, 12, 31)), 36.0);
        assert_eq!(delta_at(civil_to_jd(2017, 1, 1)), 37.0);
        assert_eq!(delta_at(civil_to_jd(1999, 1, 1)), 32.0);
        assert_eq!(delta_at(civil_to_jd(1998, 12, 31)), 31.0);
        // TT - UTC = 69.184 s in 2026. f64 Julian dates resolve ~40 microseconds,
        // so the tolerance is 1 ms (15"/s * 1 ms = 0.015" of GHA: negligible).
        let jd = civil_to_jd(2026, 9, 23);
        assert_relative_eq!((jd_tt(jd) - jd) * 86_400.0, 69.184, epsilon = 1e-3);
    }
}
