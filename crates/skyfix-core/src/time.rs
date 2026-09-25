//! CONVENTIONS sections 6 and 15.2: timestamps, Julian dates, the app's clock, leap
//! seconds, TT and UT1.
//!
//! # The clock
//!
//! Instants are Julian dates on the app's clock, `jd_utc` on the wire. The clock is
//! **UTC from 1972-01-01 to 2035-12-31** and **UT (UT1) outside** ([`scale_at`]):
//!
//! | scale | TT | UT1 |
//! |---|---|---|
//! | `Utc` | clock + 32.184 s + (TAI - UTC), the leap-second table | clock + DUT1 ([`dut1_info`]) |
//! | `Ut` | clock + Delta-T, the model of [`crate::deltat`] | the clock itself |
//!
//! Before 1972 UTC with whole leap seconds did not exist; after 2035 UT1 - UTC may grow
//! without bound (CGPM 2022, Resolution 4), so a UTC clock could not be tied to the
//! Earth's rotation. [`jd_tt`] and [`jd_ut1`] keep their names and signatures: every
//! provider already converts through them.
//!
//! # Timestamps
//!
//! [`parse_utc`] and [`format_utc`] are the single implementation of the wire format
//! (EXPLORER_API.md, "Dates and years on the wire"): proleptic Gregorian, astronomical
//! year numbering, a trailing `Z`, four-digit years for 0000-9999 and ISO 8601 expanded
//! years (a sign and at least four digits) outside, e.g. `-0584-05-28T12:00:00Z`.

use crate::SkyfixError;
use crate::calendar::{self, Calendar, CivilDate, CivilDateTime};
use crate::deltat::{self, DeltaTSource};
use serde::{Deserialize, Serialize};

/// JD of the Unix epoch 1970-01-01T00:00:00Z.
pub const JD_UNIX_EPOCH: f64 = 2_440_587.5;
/// JD of J2000.0 (2000-01-01T12:00:00 TT).
pub const JD_J2000: f64 = 2_451_545.0;
pub const TT_MINUS_TAI_S: f64 = 32.184;
/// First instant of the UTC scale: 1972-01-01T00:00:00Z.
pub const UTC_SCALE_START_JD: f64 = 2_441_317.5;
/// First instant after the UTC scale: 2036-01-01T00:00:00 (UT from here on).
pub const UTC_SCALE_END_JD: f64 = 2_464_693.5;
/// Standard uncertainty of a DUT1 typed from a time signal (its 0.1 s code).
pub const USER_DUT1_SIGMA_S: f64 = 0.05;
/// Standard uncertainty when DUT1 is unknown on the UTC scale: |UT1 - UTC| < 0.9 s.
pub const ASSUMED_DUT1_SIGMA_S: f64 = 0.9;

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// Parse a wire timestamp: `[+|-]YYYY-MM-DDTHH:MM:SS[.fff]Z`, proleptic Gregorian, with
/// four digits for years 0000-9999 or a sign and at least four digits for any year.
/// Returns `jd_utc`. Anything else (an offset other than `Z`, a space for `T`, a
/// five-digit year without a sign, a day the month does not have) is rejected. `:60`
/// is accepted as a positive leap second and means the next second, as before.
pub fn parse_utc(s: &str) -> Result<f64, SkyfixError> {
    let bad = || SkyfixError::InvalidTimestamp(s.to_string());
    let (civil, nanos) = parse_iso(s.trim(), Calendar::Gregorian).ok_or_else(bad)?;
    civil_to_jd_nanos(&civil, nanos).ok_or_else(bad)
}

/// Parse the same form as [`parse_utc`] with the date in the given calendar (the CLI's
/// `--calendar julian`). The wire itself is always Gregorian.
pub fn parse_instant_in(s: &str, calendar: Calendar) -> Result<f64, SkyfixError> {
    let bad = || SkyfixError::InvalidTimestamp(s.to_string());
    let (civil, nanos) = parse_iso(s.trim(), calendar).ok_or_else(bad)?;
    civil_to_jd_nanos(&civil, nanos).ok_or_else(bad)
}

/// Parse a calendar date `[+|-]YYYY-MM-DD` (expanded years as in [`parse_utc`]) in the
/// given calendar: `(year, month, day)`, checked against the month's length.
pub fn parse_date_in(s: &str, calendar: Calendar) -> Option<(i64, u32, u32)> {
    let (year, rest) = parse_year(s.trim())?;
    let b = rest.as_bytes();
    if b.len() != 6 || b[0] != b'-' || b[3] != b'-' {
        return None;
    }
    let month = two_digits(&b[1..3])?;
    let day = two_digits(&b[4..6])?;
    calendar::check_date(calendar, year, month, day).ok()?;
    Some((year, month, day))
}

/// `(year, rest)`: four digits, or a sign and at least four digits.
fn parse_year(s: &str) -> Option<(i64, &str)> {
    let (sign, body) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => (0, s),
    };
    let n = body.bytes().take_while(u8::is_ascii_digit).count();
    if n < 4 || (sign == 0 && n != 4) || n > 15 {
        return None;
    }
    let v: i64 = body[..n].parse().ok()?;
    Some((if sign < 0 { -v } else { v }, &body[n..]))
}

fn two_digits(b: &[u8]) -> Option<u32> {
    match b {
        [a, c] if a.is_ascii_digit() && c.is_ascii_digit() => {
            Some(u32::from(a - b'0') * 10 + u32::from(c - b'0'))
        }
        _ => None,
    }
}

/// Parse `YEAR-MM-DDTHH:MM:SS[.f]Z` in `calendar`: the civil time (whole seconds) and
/// the fraction in nanoseconds (digits beyond nine are ignored, as chrono did).
fn parse_iso(s: &str, calendar: Calendar) -> Option<(CivilDateTime, u32)> {
    let (year, rest) = parse_year(s)?;
    let b = rest.as_bytes();
    // -MM-DDTHH:MM:SS then [.digits] then Z
    if b.len() < 16
        || b[0] != b'-'
        || b[3] != b'-'
        || b[6] != b'T'
        || b[9] != b':'
        || b[12] != b':'
        || *b.last()? != b'Z'
    {
        return None;
    }
    let month = two_digits(&b[1..3])?;
    let day = two_digits(&b[4..6])?;
    let hour = two_digits(&b[7..9])?;
    let minute = two_digits(&b[10..12])?;
    let second = two_digits(&b[13..15])?;
    let frac = &b[15..b.len() - 1];
    let nanos = match frac {
        [] => 0,
        [b'.', digits @ ..] if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) => {
            let mut n = 0u32;
            for i in 0..9 {
                n = n * 10 + digits.get(i).map_or(0, |d| u32::from(d - b'0'));
            }
            n
        }
        _ => return None,
    };
    calendar::check_date(calendar, year, month, day).ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some((
        CivilDateTime {
            calendar,
            year,
            month,
            day,
            hour,
            minute,
            second: f64::from(second),
        },
        nanos,
    ))
}

/// Whole seconds since the Unix epoch plus the fraction, then days: the arithmetic the
/// chrono-based parser used, so years 0000-9999 parse to the same bits as before.
fn civil_to_jd_nanos(c: &CivilDateTime, nanos: u32) -> Option<f64> {
    let jdn = calendar::jdn_from_civil(c.calendar, c.year, c.month, c.day);
    let whole = (jdn - 2_440_588)
        .checked_mul(86_400)?
        .checked_add(i64::from(c.hour) * 3_600 + i64::from(c.minute) * 60 + c.second as i64)?;
    let secs = whole as f64 + f64::from(nanos) * 1e-9;
    Some(JD_UNIX_EPOCH + secs / 86_400.0)
}

/// Format `jd_utc` as a wire timestamp with millisecond precision: proleptic Gregorian,
/// ISO expanded years outside 0000-9999, a trailing `Z`. A non-finite or absurdly far
/// value prints as `JD <value>`.
pub fn format_utc(jd_utc: f64) -> String {
    format_in(jd_utc, Calendar::Gregorian)
}

/// [`format_utc`] with the date in the given calendar (for text output; the wire is
/// always Gregorian).
pub fn format_in(jd: f64, calendar: Calendar) -> String {
    // Round to the nearest millisecond first: f64 Julian dates resolve ~40 microseconds,
    // so truncation would print 01:32:00 as 01:31:59.999.
    match CivilDateTime::from_jd(jd, calendar) {
        Some(c) => {
            let ms = (c.second * 1000.0).round() as u32;
            format!(
                "{}T{:02}:{:02}:{:02}.{:03}Z",
                c.date_string(),
                c.hour,
                c.minute,
                ms / 1000,
                ms % 1000
            )
        }
        None => format!("JD {jd}"),
    }
}

/// Julian date of a proleptic Gregorian civil date at 0h.
pub fn civil_to_jd(year: i32, month: u32, day: u32) -> f64 {
    calendar::jdn_from_civil(Calendar::Gregorian, i64::from(year), month, day) as f64 - 0.5
}

// ---------------------------------------------------------------------------
// Leap seconds
// ---------------------------------------------------------------------------

/// TAI - UTC (IERS Bulletin C): `(jd of 0h UTC on the date it takes effect, seconds)`.
/// Last entry 2017-01-01, 37 s. IERS Bulletin A of 2026-09-24 announces no leap second at
/// the end of December 2026, so the table holds to at least 2027-06-30; later leap
/// seconds are unknown and taken as none (CONVENTIONS 15.2).
const LEAP_SECONDS: &[(f64, f64)] = &[
    (2_441_317.5, 10.0), // 1972-01-01
    (2_441_499.5, 11.0), // 1972-07-01
    (2_441_683.5, 12.0), // 1973-01-01
    (2_442_048.5, 13.0), // 1974-01-01
    (2_442_413.5, 14.0), // 1975-01-01
    (2_442_778.5, 15.0), // 1976-01-01
    (2_443_144.5, 16.0), // 1977-01-01
    (2_443_509.5, 17.0), // 1978-01-01
    (2_443_874.5, 18.0), // 1979-01-01
    (2_444_239.5, 19.0), // 1980-01-01
    (2_444_786.5, 20.0), // 1981-07-01
    (2_445_151.5, 21.0), // 1982-07-01
    (2_445_516.5, 22.0), // 1983-07-01
    (2_446_247.5, 23.0), // 1985-07-01
    (2_447_161.5, 24.0), // 1988-01-01
    (2_447_892.5, 25.0), // 1990-01-01
    (2_448_257.5, 26.0), // 1991-01-01
    (2_448_804.5, 27.0), // 1992-07-01
    (2_449_169.5, 28.0), // 1993-07-01
    (2_449_534.5, 29.0), // 1994-07-01
    (2_450_083.5, 30.0), // 1996-01-01
    (2_450_630.5, 31.0), // 1997-07-01
    (2_451_179.5, 32.0), // 1999-01-01
    (2_453_736.5, 33.0), // 2006-01-01
    (2_454_832.5, 34.0), // 2009-01-01
    (2_456_109.5, 35.0), // 2012-07-01
    (2_457_204.5, 36.0), // 2015-07-01
    (2_457_754.5, 37.0), // 2017-01-01
];

/// Last day the leap-second table is known to hold (the end of June 2027: the next
/// possible leap second, not yet announced on the build date).
pub const LEAP_TABLE_VALID_TO_JD: f64 = 2_461_587.5; // 2027-07-01T00:00:00Z

/// TAI - UTC in seconds at `jd_utc` on the UTC scale. Before 1972 returns 10 s: the
/// app's clock is UT there and never asks (the 1961-1971 UTC offsets are not modelled).
pub fn delta_at(jd_utc: f64) -> f64 {
    let i = LEAP_SECONDS.partition_point(|&(jd, _)| jd <= jd_utc);
    if i == 0 { 10.0 } else { LEAP_SECONDS[i - 1].1 }
}

// ---------------------------------------------------------------------------
// The clock's scale, TT and UT1
// ---------------------------------------------------------------------------

/// The time scale of the app's clock at an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClockScale {
    /// Coordinated Universal Time, 1972-01-01 to 2035-12-31.
    Utc,
    /// Universal Time (UT1) outside that span.
    Ut,
}

impl ClockScale {
    /// `"UTC"` or `"UT"`, the word the interface shows (CONVENTIONS 15.2).
    pub fn label(self) -> &'static str {
        match self {
            ClockScale::Utc => "UTC",
            ClockScale::Ut => "UT",
        }
    }
}

/// The scale of the clock at `jd_clock`: UTC in `[1972-01-01, 2036-01-01)`, UT outside.
pub fn scale_at(jd_clock: f64) -> ClockScale {
    if (UTC_SCALE_START_JD..UTC_SCALE_END_JD).contains(&jd_clock) {
        ClockScale::Utc
    } else {
        ClockScale::Ut
    }
}

/// TT minus the clock, seconds: 32.184 + (TAI - UTC) on the UTC scale, Delta-T from the
/// model on the UT scale.
pub fn tt_minus_clock_s(jd_clock: f64) -> f64 {
    match scale_at(jd_clock) {
        ClockScale::Utc => TT_MINUS_TAI_S + delta_at(jd_clock),
        ClockScale::Ut => deltat::tt_minus_ut1_s(jd_clock),
    }
}

/// Terrestrial Time of a clock instant, as a Julian date.
pub fn tt_from_clock(jd_clock: f64) -> f64 {
    match scale_at(jd_clock) {
        ClockScale::Utc => jd_clock + (TT_MINUS_TAI_S + delta_at(jd_clock)) / 86_400.0,
        ClockScale::Ut => deltat::tt_of_ut1(jd_clock),
    }
}

/// Terrestrial Time as a Julian date: [`tt_from_clock`] (the name every provider uses).
pub fn jd_tt(jd_utc: f64) -> f64 {
    tt_from_clock(jd_utc)
}

/// The clock instant of a TT instant: the inverse of [`tt_from_clock`]. Where the clock
/// changes scale (1972-01-01, 2036-01-01) TT − clock jumps by a fraction of a second to a
/// second or so; a TT instant in such a gap maps to the boundary, one in an overlap to
/// its UTC reading.
pub fn clock_from_tt(jd_tt_v: f64) -> f64 {
    // The UTC reading, iterated as the old eclipse code did.
    let mut utc = jd_tt_v - (TT_MINUS_TAI_S + 37.0) / 86_400.0;
    for _ in 0..3 {
        utc = jd_tt_v - (TT_MINUS_TAI_S + delta_at(utc)) / 86_400.0;
    }
    if scale_at(utc) == ClockScale::Utc {
        return utc;
    }
    let ut = deltat::ut1_of_tt(jd_tt_v);
    if scale_at(ut) == ClockScale::Ut {
        return ut;
    }
    // In the gap between the scales: the boundary between them.
    if jd_tt_v < UTC_SCALE_START_JD + 0.5 {
        UTC_SCALE_START_JD
    } else {
        UTC_SCALE_END_JD
    }
}

/// The clock instant, and the DUT1 (UT1 - clock, seconds) to build a provider with, at
/// which the provider's TT and UT1 are exactly `jd_tt` and `jd_ut1`. This is how a
/// reference computed on another time convention is evaluated without its Delta-T
/// counting as ephemeris error: e.g. the 1990-2060 Skyfield fixtures, which after 2035
/// took TT = UTC + 69.184 s and UT1 = UTC ([`legacy_frozen_utc`]).
pub fn clock_for_tt_ut1(jd_tt: f64, jd_ut1: f64) -> (f64, f64) {
    let clock = clock_from_tt(jd_tt);
    (clock, (jd_ut1 - clock) * 86_400.0)
}

/// `(jd_tt, jd_ut1)` of an instant labelled `jd_utc` under the convention the reference
/// fixtures of 1990-2060 were generated with: UTC continued past 2035 with the leap
/// seconds frozen (TT = UTC + 32.184 s + 37 s) and DUT1 = 0. Identical to the app's clock
/// up to 2035; after it the app's clock is UT (CONVENTIONS 15.2). Pass the result to
/// [`clock_for_tt_ut1`].
pub fn legacy_frozen_utc(jd_utc: f64) -> (f64, f64) {
    (
        jd_utc + (TT_MINUS_TAI_S + delta_at(jd_utc)) / 86_400.0,
        jd_utc,
    )
}

/// Where to evaluate an instant of a reference fixture generated under
/// [`legacy_frozen_utc`]: `(clock, dut1_s)` for a provider built `with_dut1_s(dut1_s)`.
/// Exactly `(jd_utc, 0.0)` up to 2035; after it, the clock whose TT is the fixture's TT,
/// with the DUT1 that puts UT1 back on the fixture's. Remove from a test once its fixture
/// is regenerated on the CONVENTIONS 15.2 scale (`tools/timescales/skyfield_timescale.py`).
pub fn legacy_fixture_instant(jd_utc: f64) -> (f64, f64) {
    if scale_at(jd_utc) == ClockScale::Utc {
        return (jd_utc, 0.0);
    }
    let (tt, ut1) = legacy_frozen_utc(jd_utc);
    clock_for_tt_ut1(tt, ut1)
}

/// UT1 as a Julian date, given DUT1 = UT1 - clock in seconds. The caller chooses DUT1;
/// [`dut1_s`] is the lookup that knows the history and the scale.
pub fn jd_ut1(jd_utc: f64, dut1_s: f64) -> f64 {
    jd_utc + dut1_s / 86_400.0
}

/// UT1 of a clock instant with the automatic DUT1 ([`dut1_s`]).
pub fn ut1_from_clock(jd_clock: f64, user_dut1_s: Option<f64>) -> f64 {
    jd_ut1(jd_clock, dut1_s(jd_clock, user_dut1_s))
}

/// Julian centuries since J2000.0 for a given (TT or UT1) Julian date.
pub fn centuries_since_j2000(jd: f64) -> f64 {
    (jd - JD_J2000) / 36_525.0
}

// ---------------------------------------------------------------------------
// DUT1
// ---------------------------------------------------------------------------

/// Where a DUT1 value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dut1Source {
    /// The IERS table (1973-01-02 to 2027-09-21; Bulletin A's prediction after
    /// 2026-09-24).
    Iers,
    /// Given by the user (`set_dut1`, a session's `clock.dut1_s`, the CLI's `--dut1`).
    User,
    /// The clock is UT: DUT1 is 0 by definition and UT follows from Delta-T.
    Model,
    /// Unknown on the UTC scale: 0, standard uncertainty 0.9 s.
    Assumed,
}

impl Dut1Source {
    pub fn name(self) -> &'static str {
        match self {
            Dut1Source::Iers => "iers",
            Dut1Source::User => "user",
            Dut1Source::Model => "model",
            Dut1Source::Assumed => "assumed",
        }
    }
}

/// UT1 minus the clock at an instant, with its standard uncertainty and source.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Dut1 {
    pub value_s: f64,
    pub sigma_s: f64,
    pub source: Dut1Source,
}

/// DUT1 = UT1 - UTC at `jd_utc`: the user's value when given; else the IERS history
/// inside its span; else 0 (`assumed`, standard uncertainty 0.9 s) on the rest of the
/// UTC scale. On the UT scale the clock is UT1, so DUT1 is 0 by definition (`model`)
/// and a user value does not apply (a DUT1 relates a UTC clock to the Earth).
pub fn dut1_info(jd_utc: f64, user: Option<f64>) -> Dut1 {
    if scale_at(jd_utc) == ClockScale::Ut {
        return Dut1 {
            value_s: 0.0,
            sigma_s: 0.0,
            source: Dut1Source::Model,
        };
    }
    if let Some(v) = user.filter(|v| v.is_finite()) {
        return Dut1 {
            value_s: v,
            sigma_s: USER_DUT1_SIGMA_S,
            source: Dut1Source::User,
        };
    }
    match deltat::iers_dut1(jd_utc) {
        Some((value_s, sigma_s)) => Dut1 {
            value_s,
            sigma_s,
            source: Dut1Source::Iers,
        },
        None => Dut1 {
            value_s: 0.0,
            sigma_s: ASSUMED_DUT1_SIGMA_S,
            source: Dut1Source::Assumed,
        },
    }
}

/// DUT1 = UT1 - UTC in seconds at `jd_utc` (the value of [`dut1_info`]). The single
/// lookup every reduce/solve/predict path and the explorer use to build providers
/// (`with_dut1_s(dut1_s(jd, user))`).
pub fn dut1_s(jd_utc: f64, user: Option<f64>) -> f64 {
    dut1_info(jd_utc, user).value_s
}

// ---------------------------------------------------------------------------
// time_info
// ---------------------------------------------------------------------------

/// Everything the interface needs to label an instant (EXPLORER_API.md, "`time_info`").
/// The coverage tier is added by the adapter that knows which packs are loaded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeInfo {
    pub jd_utc: f64,
    pub utc: String,
    pub scale: ClockScale,
    /// Delta-T = TT - UT1 from the model at this instant (the best estimate): observed
    /// by the IERS, the historical splines, the prediction or the long-term parabola.
    /// On the UT scale it equals `tt_minus_clock_s`; on the UTC scale the engine uses
    /// `tt_minus_clock_s - dut1_s`, which equals it while `dut1_source` is `iers`.
    pub delta_t_s: f64,
    pub delta_t_sigma_s: f64,
    pub delta_t_source: DeltaTSource,
    pub tt_minus_clock_s: f64,
    pub dut1_s: f64,
    pub dut1_sigma_s: f64,
    pub dut1_source: Dut1Source,
    /// The calendar to display: Julian before 1582-10-15.
    pub calendar: Calendar,
    /// The date and time of day in `calendar`.
    pub civil: CivilDate,
    /// The same in the Julian calendar, always.
    pub julian_civil: CivilDate,
    pub notes: Vec<String>,
}

/// Build [`TimeInfo`] for a clock instant, with the explorer-wide user DUT1.
pub fn time_info(jd_utc: f64, user_dut1: Option<f64>) -> Result<TimeInfo, SkyfixError> {
    let bad = || SkyfixError::InvalidTimestamp(format!("jd_utc {jd_utc}"));
    if !jd_utc.is_finite() {
        return Err(bad());
    }
    let scale = scale_at(jd_utc);
    let tt_minus_clock = tt_minus_clock_s(jd_utc);
    let tt = jd_utc + tt_minus_clock / 86_400.0;
    let mut dt = deltat::delta_t(tt);
    if scale == ClockScale::Ut {
        // The value TT was built with (identical to 1e-9 s; exactly equal on the wire).
        dt.value_s = tt_minus_clock;
    }
    let dut1 = dut1_info(jd_utc, user_dut1);
    let cal = calendar::calendar_for_jd(jd_utc);
    let civil = CivilDateTime::from_jd(jd_utc, cal).ok_or_else(bad)?;
    let julian = CivilDateTime::from_jd(jd_utc, Calendar::Julian).ok_or_else(bad)?;

    let mut notes = Vec::new();
    match scale {
        ClockScale::Ut if jd_utc < UTC_SCALE_START_JD => notes.push(
            "The clock is UT (Universal Time, UT1): UTC with leap seconds began in 1972."
                .to_string(),
        ),
        ClockScale::Ut => notes.push(
            "The clock is UT (Universal Time, UT1): after 2035 leap seconds may stop, so \
             UTC cannot be tied to the Earth's rotation."
                .to_string(),
        ),
        ClockScale::Utc if jd_utc >= LEAP_TABLE_VALID_TO_JD => notes.push(
            "Leap seconds after June 2027 are not yet announced: TT - UTC is taken as \
             69.184 s."
                .to_string(),
        ),
        ClockScale::Utc => {}
    }
    if scale == ClockScale::Ut && user_dut1.is_some() {
        notes.push("A DUT1 you set applies to the UTC years 1972-2035 only.".to_string());
    }
    match dut1.source {
        Dut1Source::Assumed => notes.push(
            "UT1 - UTC is not known for this date: taken as 0 s, +-0.9 s (up to 0.23' of \
             longitude)."
                .to_string(),
        ),
        Dut1Source::Iers if jd_utc > deltat::iers_table_span().2 + 1.0 => notes.push(format!(
            "UT1 - UTC is IERS Bulletin A's prediction of {}.",
            deltat::EOP_RETRIEVED
        )),
        _ => {}
    }
    if dt.sigma_s > 30.0 {
        notes.push(format!(
            "Delta-T is uncertain by +-{}: times and Earth-fixed positions carry it (15\" of \
             longitude per second).",
            human_duration(dt.sigma_s)
        ));
    }
    if cal == Calendar::Julian {
        notes.push("Julian calendar: the Gregorian calendar began on 1582-10-15.".to_string());
    }
    if civil.year <= 0 {
        let (ey, era) = civil.era();
        notes.push(format!("Astronomical year {} is {ey} {era}.", civil.year));
    }

    Ok(TimeInfo {
        jd_utc,
        utc: format_utc(jd_utc),
        scale,
        delta_t_s: dt.value_s,
        delta_t_sigma_s: dt.sigma_s,
        delta_t_source: dt.source,
        tt_minus_clock_s: tt_minus_clock,
        dut1_s: dut1.value_s,
        dut1_sigma_s: dut1.sigma_s,
        dut1_source: dut1.source,
        calendar: cal,
        civil: civil.into(),
        julian_civil: julian.into(),
        notes,
    })
}

/// `"12 s"`, `"15 min"`, `"1.0 h"`.
fn human_duration(s: f64) -> String {
    if s < 90.0 {
        format!("{s:.0} s")
    } else if s < 5400.0 {
        format!("{:.0} min", s / 60.0)
    } else {
        format!("{:.1} h", s / 3600.0)
    }
}

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
    fn rejects_malformed_and_impossible() {
        for bad in [
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-09-24T24:00:00Z",
            "2026-09-24T12:60:00Z",
            "2026-09-24T12:00:61Z",
            "2026-09-24T12:00:00.Z",
            "2026-09-24T12:00:00.5z",
            "12345-01-01T00:00:00Z",
            "584-05-28T00:00:00Z",
            "-584-05-28T00:00:00Z",
            "+-0584-05-28T00:00:00Z",
            "2026-9-24T12:00:00Z",
            "2026-09-24T12:00Z",
            "2026-09-24t12:00:00Z",
        ] {
            assert!(parse_utc(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn expanded_years() {
        let jd = parse_utc("-0584-05-22T00:00:00Z").unwrap();
        // Gregorian 585 BC May 22 = Julian 585 BC May 28 (JD 1507899.5).
        assert_eq!(jd, 1_507_899.5);
        assert_eq!(format_utc(jd), "-0584-05-22T00:00:00.000Z");
        assert_eq!(format_in(jd, Calendar::Julian), "-0584-05-28T00:00:00.000Z");
        assert_eq!(
            parse_instant_in("-0584-05-28T00:00:00Z", Calendar::Julian).unwrap(),
            jd
        );
        let big = parse_utc("+12345-01-01T00:00:00Z").unwrap();
        assert_eq!(format_utc(big), "+12345-01-01T00:00:00.000Z");
        assert_eq!(
            parse_utc("+2026-09-24T12:00:00Z").unwrap(),
            parse_utc("2026-09-24T12:00:00Z").unwrap()
        );
        assert_eq!(
            format_utc(parse_utc("0000-01-01T00:00:00Z").unwrap()),
            "0000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            parse_utc("-0000-03-01T00:00:00Z").unwrap(),
            parse_utc("0000-03-01T00:00:00Z").unwrap()
        );
        assert_eq!(format_utc(f64::NAN), "JD NaN");
        assert_eq!(
            parse_date_in("-0584-05-28", Calendar::Julian),
            Some((-584, 5, 28))
        );
        assert_eq!(parse_date_in("1500-02-29", Calendar::Gregorian), None);
        assert_eq!(
            parse_date_in("1500-02-29", Calendar::Julian),
            Some((1500, 2, 29))
        );
    }

    #[test]
    fn round_trips() {
        let s = "2026-10-01T01:30:00.250Z";
        assert_eq!(format_utc(parse_utc(s).unwrap()), s);
    }

    #[test]
    fn round_trips_over_five_thousand_years() {
        // Every year -2000..3000 at an awkward time of day, and the leap days.
        for y in -2000_i64..=3000 {
            for (m, d) in [(1, 1), (2, 28), (3, 1), (7, 15), (12, 31)] {
                let s = format!(
                    "{}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
                    calendar::format_year(y),
                    (y.rem_euclid(24)),
                    (y.rem_euclid(60)),
                    ((y + 7).rem_euclid(60)),
                    (y.rem_euclid(1000))
                );
                let jd = parse_utc(&s).unwrap();
                assert_eq!(format_utc(jd), s);
            }
            if calendar::is_leap_year(Calendar::Gregorian, y) {
                let s = format!("{}-02-29T23:59:59.999Z", calendar::format_year(y));
                assert_eq!(format_utc(parse_utc(&s).unwrap()), s);
            }
        }
    }

    #[test]
    fn leap_second_strings_mean_the_next_second() {
        assert_eq!(
            parse_utc("2016-12-31T23:59:60Z").unwrap(),
            parse_utc("2017-01-01T00:00:00Z").unwrap()
        );
        assert_relative_eq!(
            parse_utc("2016-12-31T23:59:60.5Z").unwrap(),
            parse_utc("2017-01-01T00:00:00.5Z").unwrap(),
            epsilon = 1e-10
        );
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_to_jd(2000, 1, 1), 2_451_544.5);
        assert_eq!(civil_to_jd(1970, 1, 1), 2_440_587.5);
        assert_eq!(civil_to_jd(2026, 9, 23), 2_461_306.5);
        assert_eq!(civil_to_jd(1972, 1, 1), UTC_SCALE_START_JD);
        assert_eq!(civil_to_jd(2036, 1, 1), UTC_SCALE_END_JD);
        assert_eq!(civil_to_jd(2027, 7, 1), LEAP_TABLE_VALID_TO_JD);
    }

    #[test]
    fn leap_second_table_dates() {
        let dates = [
            (1972, 1),
            (1972, 7),
            (1973, 1),
            (1974, 1),
            (1975, 1),
            (1976, 1),
            (1977, 1),
            (1978, 1),
            (1979, 1),
            (1980, 1),
            (1981, 7),
            (1982, 7),
            (1983, 7),
            (1985, 7),
            (1988, 1),
            (1990, 1),
            (1991, 1),
            (1992, 7),
            (1993, 7),
            (1994, 7),
            (1996, 1),
            (1997, 7),
            (1999, 1),
            (2006, 1),
            (2009, 1),
            (2012, 7),
            (2015, 7),
            (2017, 1),
        ];
        assert_eq!(dates.len(), LEAP_SECONDS.len());
        for (i, ((y, m), &(jd, v))) in dates.iter().zip(LEAP_SECONDS).enumerate() {
            assert_eq!(civil_to_jd(*y, *m, 1), jd, "{y}-{m}");
            assert_eq!(v, 10.0 + i as f64);
        }
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

    #[test]
    fn scales_and_tt() {
        assert_eq!(scale_at(civil_to_jd(1971, 12, 31)), ClockScale::Ut);
        assert_eq!(scale_at(civil_to_jd(1972, 1, 1)), ClockScale::Utc);
        assert_eq!(scale_at(civil_to_jd(2035, 12, 31) + 0.999), ClockScale::Utc);
        assert_eq!(scale_at(civil_to_jd(2036, 1, 1)), ClockScale::Ut);
        // UTC scale: TT - clock is the leap-second value, whatever Delta-T is.
        assert_eq!(tt_minus_clock_s(civil_to_jd(1990, 6, 1)), 32.184 + 25.0);
        // UT scale: Delta-T. 1900: -1.98 s (SMH 2020); 1550: about 3 minutes.
        let t1900 = tt_minus_clock_s(civil_to_jd(1900, 1, 1));
        assert!((t1900 + 1.98).abs() < 0.3, "{t1900}");
        let t1550 =
            tt_minus_clock_s(parse_instant_in("1550-01-01T00:00:00Z", Calendar::Julian).unwrap());
        assert!((150.0..250.0).contains(&t1550), "{t1550}");
        // The clock round-trips through TT on both scales.
        for s in [
            "-1999-06-01T00:00:00Z",
            "1066-10-14T09:00:00Z",
            "1971-12-31T23:59:59Z",
            "2026-09-24T12:00:00Z",
            "2100-01-01T00:00:00Z",
            "3000-12-31T23:59:59Z",
        ] {
            let jd = parse_utc(s).unwrap();
            let back = clock_from_tt(tt_from_clock(jd));
            assert!(
                ((back - jd) * 86_400.0).abs() < 1e-4,
                "{s}: {}",
                (back - jd) * 86_400.0
            );
        }
    }

    #[test]
    fn dut1_lookup() {
        let now = parse_utc("2026-09-24T00:00:00Z").unwrap();
        let d = dut1_info(now, None);
        assert_eq!(d.source, Dut1Source::Iers);
        assert!((d.value_s + 0.0135).abs() < 0.002, "{d:?}");
        let u = dut1_info(now, Some(-0.2));
        assert_eq!((u.value_s, u.source), (-0.2, Dut1Source::User));
        assert_eq!(dut1_info(now, Some(f64::NAN)).source, Dut1Source::Iers);
        let later = parse_utc("2030-01-01T00:00:00Z").unwrap();
        let a = dut1_info(later, None);
        assert_eq!(
            (a.value_s, a.sigma_s, a.source),
            (0.0, 0.9, Dut1Source::Assumed)
        );
        let ut = parse_utc("2040-01-01T00:00:00Z").unwrap();
        let m = dut1_info(ut, Some(0.3));
        assert_eq!((m.value_s, m.source), (0.0, Dut1Source::Model));
        assert_eq!(
            dut1_s(parse_utc("1972-06-01T00:00:00Z").unwrap(), None),
            0.0
        );
        assert_relative_eq!(
            ut1_from_clock(now, Some(0.5)),
            now + 0.5 / 86_400.0,
            epsilon = 1e-12
        );
    }

    #[test]
    fn time_info_fields() {
        let t = time_info(2_461_308.0, None).unwrap();
        assert_eq!(t.utc, "2026-09-24T12:00:00.000Z");
        assert_eq!(t.scale, ClockScale::Utc);
        assert_eq!(t.delta_t_source, DeltaTSource::Iers);
        assert_relative_eq!(t.tt_minus_clock_s, 69.184, epsilon = 1e-3);
        assert!((t.delta_t_s - (t.tt_minus_clock_s - t.dut1_s)).abs() < 0.003);
        assert_eq!((t.civil.year, t.civil.month, t.civil.day), (2026, 9, 24));
        assert_eq!(
            (
                t.julian_civil.year,
                t.julian_civil.month,
                t.julian_civil.day
            ),
            (2026, 9, 11)
        );
        assert_eq!(t.calendar, Calendar::Gregorian);
        assert!(t.notes.is_empty(), "{:?}", t.notes);
        let old = time_info(
            parse_instant_in("-0584-05-28T12:00:00Z", Calendar::Julian).unwrap(),
            Some(0.1),
        )
        .unwrap();
        assert_eq!(old.scale, ClockScale::Ut);
        assert_eq!(old.calendar, Calendar::Julian);
        assert_eq!(
            (
                old.civil.year,
                old.civil.month,
                old.civil.day,
                old.civil.hour
            ),
            (-584, 5, 28, 12)
        );
        assert_eq!(
            (old.civil.era_year, old.civil.era),
            (585, calendar::Era::BC)
        );
        assert_eq!(old.utc, "-0584-05-22T12:00:00.000Z");
        assert_eq!(old.dut1_source, Dut1Source::Model);
        assert_eq!(old.delta_t_s, old.tt_minus_clock_s);
        assert!(old.delta_t_sigma_s > 30.0);
        assert!(old.notes.len() >= 4, "{:?}", old.notes);
        assert!(time_info(f64::INFINITY, None).is_err());
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["scale"], "utc");
        assert_eq!(json["dut1_source"], "iers");
        assert_eq!(json["delta_t_source"], "iers");
        assert_eq!(json["calendar"], "gregorian");
        assert_eq!(json["civil"]["era"], "AD");
    }
}
