//! Daily almanac pages in the layout navigators use: everything the Nautical Almanac's two
//! facing daily pages give, for one UT date.
//!
//! OWNER: almanac agent (wave 2). Definitions: CONVENTIONS 13.9 (and 13.3 for rise, set,
//! twilight and meridian passage, which come from [`crate::events`] unchanged). Wire
//! format: EXPLORER_API.md "Wave 2 — almanac pages".
//!
//! # What a page holds
//!
//! - **Left page.** For every hour 00h-23h UT: GHA of Aries; GHA and Dec of Venus, Mars,
//!   Jupiter and Saturn. For the day: each planet's magnitude, `v`, `d`, SHA and meridian
//!   passage; the meridian passage of Aries; SHA and Dec of the 57 navigational stars and
//!   Polaris.
//! - **Right page.** For every hour: GHA and Dec of the Sun; GHA, `v`, Dec, `d` and HP of
//!   the Moon. For the day: the Sun's SD and `d`, the equation of time at 00h and 12h and
//!   the Sun's meridian passage; the Moon's SD, upper and lower meridian passage, age and
//!   percentage illuminated. For the 31 standard latitudes 72 N to 60 S at the Greenwich
//!   meridian: nautical and civil twilight, sunrise and sunset, and moonrise and moonset
//!   for the date and the next.
//!
//! Every tabulated quantity carries its raw value (unit in the field name) and, under
//! `printed`, the text the page prints, rounded as the printed almanac rounds: angles to
//! 0.1', times to the minute (Aries' meridian passage to 0.1 minute), the equation of time
//! to the second, magnitudes to 0.1.
//!
//! # Definitions (CONVENTIONS 13.9)
//!
//! - **UT** is UTC with DUT1 = 0 (CONVENTIONS 6), the convention of every GHA in this
//!   project. The printed almanac's argument is UT1: the difference is up to 0.23' of GHA
//!   (0.9 s of Earth rotation).
//! - **Hourly values** are exact evaluations of the provider at each whole hour. `GHA
//!   Aries` is the Sun's `GHA + RA` at that hour, so it is consistent with every other GHA.
//! - **v** is the excess of a body's mean hourly increase of GHA over the rate the
//!   printed almanac's increments tables assume: 15° for the planets, 14° 19.0' for the
//!   Moon. The Moon's is tabulated every hour, from that hour to the next; a planet's is
//!   the mean over the day (00h to 24h). It is negative only for Venus moving fast.
//! - **d** is the hourly change of declination: every hour for the Moon, the mean over the
//!   day for the Sun and the planets. It is printed without a sign, as the printed almanac
//!   does (the sign follows from the trend of the column); the raw value is signed, north
//!   positive.
//! - **Once-a-day values** are for 12h UT of the date: the stars' SHA and Dec, the planets'
//!   SHA and magnitude, the Sun's and the Moon's SD, the Moon's age and percentage
//!   illuminated. The printed almanac tabulates them for the middle day of its three-day
//!   page. From 12h to 00h or 24h the 57 stars move at most 0.012' (1990-2060); Polaris,
//!   whose SHA changes by up to 0.79' a day so near the pole, up to 0.40'.
//! - **Equation of time** = apparent solar time minus mean solar time at Greenwich,
//!   `(GHA Sun - 15° × (UT hours - 12)) / 15°/h`. Printed as minutes and seconds without a
//!   sign; negative values (the Sun crosses the meridian after 12h) are the ones the
//!   printed almanac shades, and the UI shades them too.
//! - **Meridian passage** (CONVENTIONS 13.3) is the UT of the body's transit across the
//!   Greenwich meridian (`GHA = 0`; the Moon's lower passage `GHA = 180°`), taken from
//!   [`crate::events::day_events`] at 0° N 0° E; Aries' is the root of `GHA Aries = 0`.
//!   When a passage does not happen on the date the next one is given as `24 hh mm`.
//! - **Moon's age** is the time since the preceding new moon (CONVENTIONS 13.5), printed in
//!   whole days elapsed; **percentage illuminated** is `100 k`, `k = (1 + cos i) / 2`.
//! - **Rise, set and twilight** come from [`crate::events::day_events`] at each latitude on
//!   the Greenwich meridian (sea level, standard horizon), so they are CONVENTIONS 13.3
//!   exactly: the Sun's centre at -50' (sunrise, sunset), -6° (civil) and -12° (nautical);
//!   the Moon's centre at `-34' - SD`, topocentric (upper limb on the horizon with 34' of
//!   refraction, parallax included). Times are LMT at the Greenwich meridian, i.e. UT.
//!   - The morning columns hold the Sun's rising through each altitude between the lower
//!     meridian passage before the day's noon and that noon; the evening columns its
//!     setting between noon and the next lower passage. So an evening phenomenon a few
//!     minutes after midnight (high latitudes) is printed `24 hh mm`, and a morning one a
//!     few minutes before midnight `-00 mm`.
//!   - When the Sun does not cross an altitude that half-day: `□` it stays above the
//!     horizon all day (in every column), `■` it stays below that altitude, `////` it sets
//!     but twilight lasts all night.
//!   - Moonrise (moonset) is the first on that UT date. With none on the date: `□` / `■`
//!     when the Moon is above / below the horizon all day; otherwise the next one, on the
//!     following date, printed `24 hh mm`; `--` if that does not happen either.
//!   - `n/a`: the phenomenon needs the ephemeris outside its coverage (the first and last
//!     days of 1990-2060 only).
//!
//! # Where these differ from the printed Nautical Almanac
//!
//! - One date per page instead of three; moonrise and moonset for the date and the next
//!   instead of four days.
//! - The argument is UTC with DUT1 = 0, not UT1 (up to 0.23' of GHA, 1 s of any time).
//! - The once-a-day values are for 12h UT of the date rather than the middle day of three.
//! - Rise and set use the WGS84 ellipsoid for the observer (CONVENTIONS 13.2); the printed
//!   almanac's own reduction may differ by seconds of time.
//! - `n/a`, `--` and the `-00 mm` notation are this project's; the printed almanac has no
//!   coverage edge.
//! - Star names are the project's canonical spellings (`Zubenelgenubi`, the printed
//!   almanac's `Zuben'ubi`); Polaris, which the printed almanac tabulates separately, is
//!   listed after the 57 stars.
//!
//! # Cost
//!
//! A page is about 30 `day_events` calls (one per latitude, over 3.5 days). They all
//! evaluate the providers at the same node instants, so a per-call memo of
//! `apparent_state` (`Memo`) computes each node once and the tracks are identical to
//! uncached ones; only the topocentric scans are repeated per latitude.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc, parse_utc};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{ApparentState, BodyEphemeris, MOON, NAVIGATIONAL_PLANETS, SUN};
use skyfix_ephemeris::topocentric::Site;
use skyfix_ephemeris::{AstroProvider, Coverage, EphemerisError, catalog};

use crate::events::{
    self, CIVIL_TWILIGHT_DEG, EventKind, EventOptions, MoonPhaseKind, NAUTICAL_TWILIGHT_DEG,
    PhaseEvent, SUN_RISE_SET_DEG, SkyEvent,
};
use crate::sky::{AlmanacError, BodyError};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The latitudes of the printed almanac's twilight, sunrise, moonrise tables, north
/// positive, in its order.
pub const STANDARD_LATITUDES: [f64; 31] = [
    72.0, 70.0, 68.0, 66.0, 64.0, 62.0, 60.0, 58.0, 56.0, 54.0, 52.0, 50.0, 45.0, 40.0, 35.0, 30.0,
    20.0, 10.0, 0.0, -10.0, -20.0, -30.0, -35.0, -40.0, -45.0, -50.0, -52.0, -54.0, -56.0, -58.0,
    -60.0,
];

/// The hourly increase of GHA the printed almanac's increments tables assume for the
/// Sun and the planets, degrees per hour. `v` is the excess over it.
pub const PLANET_ADOPTED_RATE_DEG_PER_HOUR: f64 = 15.0;
/// The same for the Moon: 14° 19.0' per hour (the Moon's slowest, so its `v` is positive).
pub const MOON_ADOPTED_RATE_DEG_PER_HOUR: f64 = 14.0 + 19.0 / 60.0;

/// Printed for a body above the horizon all day.
pub const ABOVE_SYMBOL: &str = "\u{25A1}";
/// Printed for a body below the horizon (or the twilight altitude) all day.
pub const BELOW_SYMBOL: &str = "\u{25A0}";
/// Printed when twilight lasts all night.
pub const ALL_NIGHT_SYMBOL: &str = "////";
/// Printed when the phenomenon is neither on the date nor the next.
pub const LATER_SYMBOL: &str = "--";
/// Printed when the phenomenon needs the ephemeris outside its coverage.
pub const UNAVAILABLE_SYMBOL: &str = "n/a";

/// Sidereal rotation, degrees per day of UT: the first guess for unwrapping GHA
/// differences (any body's own rate is within a few degrees a day of it).
const SIDEREAL_DEG_PER_DAY: f64 = 360.985_647_366_29;
const HOUR: f64 = 1.0 / 24.0;

/// Sentences every page prints under its tables (the CLI and the UI show them verbatim).
pub const NOTES: [&str; 7] = [
    "UT is UTC with DUT1 = 0 (CONVENTIONS 6); the printed almanac's argument is UT1. The \
     difference is up to 0.23' of GHA and 1 s of any time.",
    "v: the excess of the hourly increase of GHA over 15° (planets, mean over the day) or \
     14° 19.0' (Moon, from each hour to the next). d: the hourly change of declination, \
     printed without sign; take the sign from the trend of the column.",
    "Stars' SHA and Dec, the planets' SHA and magnitudes, SD, the Moon's age and percentage \
     illuminated are for 12h UT of the date. The stars stay within 0.02' of their row all \
     day; Polaris, which the printed almanac tabulates separately, moves up to 0.8' a day \
     in SHA and is within 0.4' of its row.",
    "Equation of time: apparent minus mean solar time at Greenwich, in minutes and seconds; \
     negative (shaded on the page, a minus sign in plain text) when the Sun crosses the \
     meridian after 12h.",
    "Twilight, sunrise, sunset, moonrise and moonset: LMT at the Greenwich meridian (= UT) \
     for a sea-level observer. Sun's centre at -50' (sunrise, sunset), -6° (civil) and \
     -12° (nautical); the Moon's upper limb on the horizon with 34' of refraction \
     (CONVENTIONS 13.3).",
    "\u{25A1} above the horizon all day; \u{25A0} below it (or below the twilight altitude) \
     all day; //// twilight all night; 24 hh mm: on the following date; -00 mm: minutes \
     before 00h; --: not on the date nor the next; n/a: outside the ephemeris coverage.",
    "Simulation and analysis workbench. Not a navigation instrument.",
];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What kind of entry a time cell is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeKind {
    /// The phenomenon happens at `jd_utc`: printed `hh mm` (`24 hh mm` on the next date,
    /// `-00 mm` just before 00h).
    Time,
    /// Above the horizon all day: [`ABOVE_SYMBOL`].
    Above,
    /// Below the horizon, or the twilight altitude, all day: [`BELOW_SYMBOL`].
    Below,
    /// The Sun sets but never reaches this twilight altitude: [`ALL_NIGHT_SYMBOL`].
    AllNight,
    /// Neither on the date nor the next: [`LATER_SYMBOL`].
    Later,
    /// Needs the ephemeris outside its coverage: [`UNAVAILABLE_SYMBOL`].
    Unavailable,
}

/// One time on the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableTime {
    pub kind: TimeKind,
    /// The instant, when `kind` is `time`.
    pub jd_utc: Option<f64>,
    pub utc: Option<String>,
    /// Hours after 00h UT of the column's date (LMT at the Greenwich meridian). May be
    /// negative or 24 and more; `null` unless `kind` is `time`.
    pub hours: Option<f64>,
    /// As the page prints it.
    pub printed: String,
}

impl TableTime {
    fn symbol(kind: TimeKind) -> TableTime {
        let printed = match kind {
            TimeKind::Above => ABOVE_SYMBOL,
            TimeKind::Below => BELOW_SYMBOL,
            TimeKind::AllNight => ALL_NIGHT_SYMBOL,
            TimeKind::Later => LATER_SYMBOL,
            TimeKind::Unavailable | TimeKind::Time => UNAVAILABLE_SYMBOL,
        };
        TableTime {
            kind,
            jd_utc: None,
            utc: None,
            hours: None,
            printed: printed.to_string(),
        }
    }

    fn unavailable() -> TableTime {
        TableTime::symbol(TimeKind::Unavailable)
    }

    /// A phenomenon at `jd`, printed to the minute (or to 0.1 minute) from 00h of the
    /// column's date `day0`.
    fn at(jd: f64, day0: f64, tenths: bool) -> TableTime {
        let hours = (jd - day0) * 24.0;
        TableTime {
            kind: TimeKind::Time,
            jd_utc: Some(jd),
            utc: Some(format_utc(jd)),
            hours: Some(hours),
            printed: if tenths {
                fmt_hm_tenths(hours)
            } else {
                fmt_hm(hours)
            },
        }
    }
}

/// GHA as printed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GhaText {
    pub gha: String,
}

/// GHA and declination as printed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GhaDecText {
    pub gha: String,
    pub dec: String,
}

/// GHA of Aries at one hour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AriesHour {
    pub gha_deg: f64,
    pub printed: GhaText,
}

/// The Sun or a planet at one hour: apparent geocentric GHA and Dec (CONVENTIONS 7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyHour {
    pub body: String,
    pub gha_deg: f64,
    pub dec_deg: f64,
    pub printed: GhaDecText,
}

/// The Moon's printed hourly columns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoonHourText {
    pub gha: String,
    pub v: String,
    pub dec: String,
    pub d: String,
    pub hp: String,
}

/// The Moon at one hour. `v` and `d` are from this hour to the next.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonHour {
    pub gha_deg: f64,
    pub dec_deg: f64,
    pub v_arcmin: f64,
    /// Signed, north positive.
    pub d_arcmin: f64,
    pub hp_arcmin: f64,
    pub printed: MoonHourText,
}

/// One hour of both pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HourRow {
    /// 0 to 23.
    pub hour: u32,
    pub jd_utc: f64,
    pub utc: String,
    pub aries: AriesHour,
    pub sun: BodyHour,
    /// `null` when the Moon cannot be computed (it is then listed in `errors`).
    pub moon: Option<MoonHour>,
    /// In the order of [`AlmanacDay::planets`].
    pub planets: Vec<BodyHour>,
}

/// Aries for the day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AriesDay {
    /// UT of `GHA Aries = 0`, printed to 0.1 minute.
    pub mer_pass: TableTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SunDayText {
    pub sd: String,
    pub d: String,
    pub eot_00h: String,
    pub eot_12h: String,
}

/// The Sun for the day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SunDay {
    /// At 12h UT.
    pub sd_arcmin: f64,
    /// Mean hourly change of declination over the day, signed.
    pub d_arcmin: f64,
    /// Equation of time at 00h and 12h UT, seconds, apparent minus mean (negative: the
    /// Sun crosses the meridian after 12h; the page shades it).
    pub eot_00h_s: f64,
    pub eot_12h_s: f64,
    pub mer_pass: TableTime,
    pub printed: SunDayText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoonDayText {
    pub sd: String,
    /// Whole days since the preceding new moon, or `--` when that is outside the
    /// ephemeris coverage.
    pub age: String,
    pub illuminated: String,
}

/// The Moon for the day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonDay {
    /// At 12h UT.
    pub sd_arcmin: f64,
    pub mer_pass_upper: TableTime,
    pub mer_pass_lower: TableTime,
    /// Days since the preceding new moon at 12h UT; `null` when it is before the start of
    /// the ephemeris coverage.
    pub age_days: Option<f64>,
    /// At 12h UT; `null` if the provider does not model it.
    pub illuminated_fraction: Option<f64>,
    /// A principal phase (new moon, first quarter, full moon, last quarter) during the
    /// date, if there is one.
    pub phase: Option<PhaseEvent>,
    pub printed: MoonDayText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanetDayText {
    /// With its sign, e.g. `-4.0`, `+1.3`; `--` when not modelled.
    pub magnitude: String,
    pub v: String,
    pub d: String,
    pub sha: String,
}

/// A planet for the day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanetDay {
    pub body: String,
    /// At 12h UT.
    pub magnitude: Option<f64>,
    /// Mean over the day.
    pub v_arcmin: f64,
    /// Mean over the day, signed.
    pub d_arcmin: f64,
    /// At 12h UT: `360° - RA`.
    pub sha_deg: f64,
    pub mer_pass: TableTime,
    pub printed: PlanetDayText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StarText {
    pub sha: String,
    pub dec: String,
}

/// A star at 12h UT of the date.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StarRow {
    pub body: String,
    pub sha_deg: f64,
    pub dec_deg: f64,
    /// Catalogue visual magnitude.
    pub magnitude: f64,
    pub printed: StarText,
}

/// One latitude of the twilight, sunrise, sunset, moonrise and moonset tables.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LatitudeRow {
    pub lat_deg: f64,
    /// `N 72`, `0`, `S 60`.
    pub label: String,
    pub nautical_dawn: TableTime,
    pub civil_dawn: TableTime,
    pub sunrise: TableTime,
    pub sunset: TableTime,
    pub civil_dusk: TableTime,
    pub nautical_dusk: TableTime,
    /// For the dates in [`RiseSetTable::moon_dates`].
    pub moonrise: Vec<TableTime>,
    pub moonset: Vec<TableTime>,
}

/// The twilight, sunrise, sunset, moonrise and moonset tables.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RiseSetTable {
    /// The UT dates of the moonrise and moonset columns: the page's date and the next.
    pub moon_dates: Vec<String>,
    pub rows: Vec<LatitudeRow>,
}

/// Everything the two facing daily pages give for one UT date (EXPLORER_API.md
/// `AlmanacDay`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlmanacDay {
    /// `YYYY-MM-DD`, UT.
    pub date: String,
    /// `Monday` ... `Sunday`.
    pub weekday: String,
    /// 00h UT of the date.
    pub jd_utc: f64,
    /// 12h UT: the instant of every once-a-day value.
    pub noon_jd_utc: f64,
    /// 24 rows, 00h to 23h.
    pub hours: Vec<HourRow>,
    pub aries: AriesDay,
    pub sun: SunDay,
    /// `null` when the Moon cannot be computed.
    pub moon: Option<MoonDay>,
    /// Venus, Mars, Jupiter and Saturn (those the provider can compute).
    pub planets: Vec<PlanetDay>,
    /// The 57 navigational stars in the printed almanac's order, then Polaris.
    pub stars: Vec<StarRow>,
    pub rise_set: RiseSetTable,
    /// What the page prints under its tables ([`NOTES`]).
    pub notes: Vec<String>,
    /// Bodies or phenomena that could not be computed, with the reason.
    pub errors: Vec<BodyError>,
}

// ---------------------------------------------------------------------------
// Printing, as the printed almanac rounds
// ---------------------------------------------------------------------------

/// `183 12.4`: degrees and arcminutes to 0.1' of an angle in `[0, 360)`. Rounding is done
/// once, on tenths of arcminutes, so 359° 59.97' prints `0 00.0`, never `360 00.0`.
pub fn fmt_angle(deg: f64) -> String {
    let tenths = (norm_360(deg) * 600.0).round() as i64 % 216_000;
    format!(
        "{} {:02}.{}",
        tenths / 600,
        (tenths % 600) / 10,
        tenths % 10
    )
}

/// `N 12 34.5` / `S 0 42.3`: a declination to 0.1'. The hemisphere is that of the value,
/// even when it rounds to zero.
pub fn fmt_dec(deg: f64) -> String {
    let hemisphere = if deg < 0.0 { 'S' } else { 'N' };
    let tenths = (deg.abs() * 600.0).round() as i64;
    format!(
        "{hemisphere} {} {:02}.{}",
        tenths / 600,
        (tenths % 600) / 10,
        tenths % 10
    )
}

/// An arcminute quantity to 0.1', with a minus sign when negative (`-0.3`), never `-0.0`.
pub fn fmt_arcmin(arcmin: f64) -> String {
    let tenths = (arcmin * 10.0).round() as i64;
    let sign = if tenths < 0 { "-" } else { "" };
    format!("{sign}{}.{}", tenths.abs() / 10, tenths.abs() % 10)
}

/// A magnitude to 0.1 with its sign (`-4.0`, `+1.3`, `+0.0` is printed `0.0`).
pub fn fmt_magnitude(mag: f64) -> String {
    let tenths = (mag * 10.0).round() as i64;
    let sign = match tenths.signum() {
        -1 => "-",
        1 => "+",
        _ => "",
    };
    format!("{sign}{}.{}", tenths.abs() / 10, tenths.abs() % 10)
}

/// `06 42`: hours and minutes to the nearest minute. 24 and more stay as they are
/// (`24 05`, the next date); before 00h a minus sign counts back (`-00 02`).
pub fn fmt_hm(hours: f64) -> String {
    let minutes = (hours * 60.0).round() as i64;
    let sign = if minutes < 0 { "-" } else { "" };
    let m = minutes.abs();
    format!("{sign}{:02} {:02}", m / 60, m % 60)
}

/// `23 15.2`: hours and minutes to 0.1 minute (Aries' meridian passage).
pub fn fmt_hm_tenths(hours: f64) -> String {
    let tenths = (hours * 600.0).round() as i64;
    let sign = if tenths < 0 { "-" } else { "" };
    let t = tenths.abs();
    format!("{sign}{:02} {:02}.{}", t / 600, (t % 600) / 10, t % 10)
}

/// `07 45`: a duration's magnitude in minutes and seconds, to the second.
pub fn fmt_ms(seconds: f64) -> String {
    let s = seconds.abs().round() as i64;
    format!("{:02} {:02}", s / 60, s % 60)
}

/// `N 72`, `0`, `S 60`.
pub fn latitude_label(lat_deg: f64) -> String {
    if lat_deg > 0.0 {
        format!("N {lat_deg:.0}")
    } else if lat_deg < 0.0 {
        format!("S {:.0}", -lat_deg)
    } else {
        "0".to_string()
    }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// A UT calendar date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtDate {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl UtDate {
    /// Parse `YYYY-MM-DD` (exactly that form).
    pub fn parse(text: &str) -> Result<UtDate, AlmanacError> {
        let t = text.trim();
        let bad = || {
            AlmanacError::Invalid(format!(
                "date must be a UT calendar date written YYYY-MM-DD, got {text:?}"
            ))
        };
        let b = t.as_bytes();
        if !t.is_ascii() || b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return Err(bad());
        }
        let digits = |s: &str| -> Option<u32> {
            s.bytes()
                .all(|c| c.is_ascii_digit())
                .then(|| s.parse().ok())
                .flatten()
        };
        let year = digits(&t[0..4]).ok_or_else(bad)?;
        let month = digits(&t[5..7]).ok_or_else(bad)?;
        let day = digits(&t[8..10]).ok_or_else(bad)?;
        if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year as i32, month) {
            return Err(AlmanacError::Invalid(format!(
                "{text:?} is not a calendar date"
            )));
        }
        Ok(UtDate {
            year: year as i32,
            month,
            day,
        })
    }

    /// 00h UT of the date.
    pub fn jd_utc(&self) -> f64 {
        civil_to_jd(self.year, self.month, self.day)
    }

    /// The date `n` days later.
    pub fn plus_days(&self, n: i64) -> UtDate {
        from_jd(self.jd_utc() + n as f64)
    }

    pub fn weekday(&self) -> &'static str {
        const NAMES: [&str; 7] = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ];
        NAMES[((self.jd_utc() + 1.5).floor() as i64).rem_euclid(7) as usize]
    }
}

impl std::fmt::Display for UtDate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The UT date containing `jd` (Fliegel & Van Flandern, inverse of `civil_to_jd`).
fn from_jd(jd: f64) -> UtDate {
    let l0 = (jd + 0.5).floor() as i64 + 68_569;
    let n = 4 * l0 / 146_097;
    let l1 = l0 - (146_097 * n + 3) / 4;
    let i = 4000 * (l1 + 1) / 1_461_001;
    let l2 = l1 - 1461 * i / 4 + 31;
    let j = 80 * l2 / 2447;
    let day = l2 - 2447 * j / 80;
    let l3 = j / 11;
    let month = j + 2 - 12 * l3;
    let year = 100 * (n - 49) + i + l3;
    UtDate {
        year: year as i32,
        month: month as u32,
        day: day as u32,
    }
}

// ---------------------------------------------------------------------------
// A memo of the provider for one page
// ---------------------------------------------------------------------------

/// `apparent_state` of the wrapped provider, remembered by body and exact instant.
///
/// Every `day_events` call of a page uses the same window, so its tracks ask for the same
/// bodies at the same node instants whatever the latitude; this computes each node once.
/// Results are the provider's own, so everything built on them is identical to uncached.
struct Memo<'a> {
    inner: &'a dyn BodyEphemeris,
    cache: RefCell<HashMap<(String, u64), ApparentState>>,
}

impl<'a> Memo<'a> {
    fn new(inner: &'a dyn BodyEphemeris) -> Self {
        Memo {
            inner,
            cache: RefCell::new(HashMap::new()),
        }
    }
}

impl AstroProvider for Memo<'_> {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn coverage(&self) -> Coverage {
        self.inner.coverage()
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        Ok(self.apparent_state(body, jd_utc)?.direction())
    }
}

impl BodyEphemeris for Memo<'_> {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        let key = (body.to_string(), jd_utc.to_bits());
        if let Some(hit) = self.cache.borrow().get(&key) {
            return Ok(hit.clone());
        }
        let st = self.inner.apparent_state(body, jd_utc)?;
        self.cache.borrow_mut().insert(key, st.clone());
        Ok(st)
    }

    fn gha_rate_deg_per_hour(&self, body: &str, jd_utc: f64) -> Result<f64, EphemerisError> {
        self.inner.gha_rate_deg_per_hour(body, jd_utc)
    }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/// The instants a provider answers for, from its coverage record.
fn coverage_window(eph: &dyn BodyEphemeris) -> Result<(f64, f64), AlmanacError> {
    let c = eph.coverage();
    let start = parse_utc(&c.start_utc).map_err(|e| AlmanacError::Unavailable {
        body: eph.name().to_string(),
        message: format!("its coverage start {:?} does not parse: {e}", c.start_utc),
    })?;
    let end = parse_utc(&c.end_utc).map_err(|e| AlmanacError::Unavailable {
        body: eph.name().to_string(),
        message: format!("its coverage end {:?} does not parse: {e}", c.end_utc),
    })?;
    Ok((start, end))
}

/// A GHA difference `b - a` over `dt_days`, unwrapped with the sidereal rate as the first
/// guess: degrees, any size.
fn gha_change_deg(a: f64, b: f64, dt_days: f64) -> f64 {
    let guess = SIDEREAL_DEG_PER_DAY * dt_days;
    guess + norm_180(b - a - guess)
}

/// `v` in arcminutes: the mean hourly GHA increase between two states minus `adopted`.
fn v_arcmin(a: &ApparentState, b: &ApparentState, adopted_deg_per_hour: f64) -> f64 {
    let dt_days = b.jd_utc - a.jd_utc;
    (gha_change_deg(a.gha_deg, b.gha_deg, dt_days) / (dt_days * 24.0) - adopted_deg_per_hour) * 60.0
}

/// `d` in arcminutes per hour, signed.
fn d_arcmin(a: &ApparentState, b: &ApparentState) -> f64 {
    (b.dec_deg - a.dec_deg) * 60.0 / ((b.jd_utc - a.jd_utc) * 24.0)
}

fn body_hour(st: &ApparentState) -> BodyHour {
    BodyHour {
        body: st.body.clone(),
        gha_deg: st.gha_deg,
        dec_deg: st.dec_deg,
        printed: GhaDecText {
            gha: fmt_angle(st.gha_deg),
            dec: fmt_dec(st.dec_deg),
        },
    }
}

fn gha_aries_of(sun: &ApparentState) -> f64 {
    norm_360(sun.gha_deg + sun.ra_deg)
}

/// Equation of time at the Sun's state, seconds: `(GHA - 15° (UT - 12h)) / 15°/h`.
fn equation_of_time_s(sun: &ApparentState, day0: f64) -> f64 {
    let ut_hours = (sun.jd_utc - day0) * 24.0;
    norm_180(sun.gha_deg - 15.0 * (ut_hours - 12.0)) * 240.0
}

/// Everything the two daily pages give for one UT date `YYYY-MM-DD` (module docs).
///
/// Fails with [`AlmanacError::Invalid`] for a malformed date or one outside the
/// provider's coverage, and with [`AlmanacError::Unavailable`] when the Sun cannot be
/// computed. Any other body the provider cannot give is left out and listed in `errors`.
pub fn almanac_day(eph: &dyn BodyEphemeris, date: &str) -> Result<AlmanacDay, AlmanacError> {
    let date = UtDate::parse(date)?;
    almanac_day_for(eph, date)
}

/// [`almanac_day`] for an already parsed date.
pub fn almanac_day_for(eph: &dyn BodyEphemeris, date: UtDate) -> Result<AlmanacDay, AlmanacError> {
    let (cov_start, cov_end) = coverage_window(eph)?;
    let day0 = date.jd_utc();
    if day0 < cov_start || day0 > cov_end {
        return Err(AlmanacError::Invalid(format!(
            "{date} is outside the ephemeris coverage ({} to {})",
            format_utc(cov_start),
            format_utc(cov_end)
        )));
    }
    let memo = Memo::new(eph);
    let noon = day0 + 0.5;
    let mut errors: Vec<BodyError> = Vec::new();

    // Hourly instants 00h..24h; the 25th only feeds v and d, and is pulled back to the
    // coverage end on the last day (the rates are over the interval actually spanned).
    let times: Vec<f64> = (0..=24)
        .map(|h| (day0 + f64::from(h) * HOUR).min(cov_end))
        .collect();

    // --- The Sun (the page cannot exist without it) ---------------------------------
    let sun_states: Vec<ApparentState> = times
        .iter()
        .map(|&t| memo.apparent_state(SUN, t))
        .collect::<Result<_, _>>()
        .map_err(|e| AlmanacError::Unavailable {
            body: SUN.to_string(),
            message: format!("{e}; the daily page cannot be made without the Sun"),
        })?;
    let sun_noon = memo
        .apparent_state(SUN, noon)
        .map_err(|e| AlmanacError::Unavailable {
            body: SUN.to_string(),
            message: e.to_string(),
        })?;

    // --- Moon and planets: hourly states, or an error for the whole day --------------
    let series = |body: &str, errors: &mut Vec<BodyError>| -> Option<Vec<ApparentState>> {
        match times
            .iter()
            .map(|&t| memo.apparent_state(body, t))
            .collect::<Result<Vec<_>, _>>()
            .and_then(|v| memo.apparent_state(body, noon).map(|n| (v, n)))
        {
            Ok((v, _)) => Some(v),
            Err(e) => {
                errors.push(BodyError {
                    body: body.to_string(),
                    message: e.to_string(),
                });
                None
            }
        }
    };
    let moon_states = series(MOON, &mut errors);
    let planet_states: Vec<(&'static str, Vec<ApparentState>)> = NAVIGATIONAL_PLANETS
        .iter()
        .filter_map(|&p| series(p, &mut errors).map(|v| (p, v)))
        .collect();

    // --- Hourly rows -----------------------------------------------------------------
    let hours: Vec<HourRow> = (0..24)
        .map(|h| {
            let sun = &sun_states[h];
            let aries = gha_aries_of(sun);
            HourRow {
                hour: h as u32,
                jd_utc: times[h],
                utc: format_utc(times[h]),
                aries: AriesHour {
                    gha_deg: aries,
                    printed: GhaText {
                        gha: fmt_angle(aries),
                    },
                },
                sun: body_hour(sun),
                moon: moon_states.as_ref().map(|m| {
                    let (a, b) = (&m[h], &m[h + 1]);
                    let v = v_arcmin(a, b, MOON_ADOPTED_RATE_DEG_PER_HOUR);
                    let d = d_arcmin(a, b);
                    MoonHour {
                        gha_deg: a.gha_deg,
                        dec_deg: a.dec_deg,
                        v_arcmin: v,
                        d_arcmin: d,
                        hp_arcmin: a.horizontal_parallax_arcmin,
                        printed: MoonHourText {
                            gha: fmt_angle(a.gha_deg),
                            v: fmt_arcmin(v),
                            dec: fmt_dec(a.dec_deg),
                            d: fmt_arcmin(d.abs()),
                            hp: fmt_arcmin(a.horizontal_parallax_arcmin),
                        },
                    }
                }),
                planets: planet_states
                    .iter()
                    .map(|(_, s)| body_hour(&s[h]))
                    .collect(),
            }
        })
        .collect();

    // --- The rise, set and twilight tables (and the Sun's and Moon's passages) --------
    let clamp = |a: f64, b: f64| -> Option<(f64, f64)> {
        let (a, b) = (a.max(cov_start), b.min(cov_end));
        (b > a).then_some((a, b))
    };
    let window = clamp(day0 - 0.5, day0 + 3.0).expect("the date is inside the coverage");
    let moon_ok = moon_states.is_some();
    let rs_bodies: Vec<&str> = if moon_ok { vec![SUN, MOON] } else { vec![SUN] };
    let options = EventOptions::default();
    let mut rows = Vec::with_capacity(STANDARD_LATITUDES.len());
    let mut greenwich: Option<(Vec<SkyEvent>, Option<MoonEvents>)> = None;
    for &lat in &STANDARD_LATITUDES {
        let site = Site::new(lat, 0.0);
        let de = events::day_events(&memo, &site, window.0, window.1, &rs_bodies, &options)?;
        let sun_ev = &de.bodies[0].events;
        let [
            nautical_dawn,
            civil_dawn,
            sunrise,
            sunset,
            civil_dusk,
            nautical_dusk,
        ] = sun_cells(sun_ev, day0, window);
        let moon = if moon_ok {
            de.bodies
                .iter()
                .find(|b| b.body == MOON)
                .map(|b| MoonEvents {
                    events: b.events.clone(),
                    always_above: b.always_above,
                })
        } else {
            None
        };
        let (moonrise, moonset) = match &moon {
            Some(m) => (
                (0..2)
                    .map(|k| moon_cell(m, EventKind::Rise, day0 + k as f64, window))
                    .collect(),
                (0..2)
                    .map(|k| moon_cell(m, EventKind::Set, day0 + k as f64, window))
                    .collect(),
            ),
            None => (
                vec![TableTime::unavailable(); 2],
                vec![TableTime::unavailable(); 2],
            ),
        };
        if lat == 0.0 {
            greenwich = Some((sun_ev.clone(), moon));
        }
        rows.push(LatitudeRow {
            lat_deg: lat,
            label: latitude_label(lat),
            nautical_dawn,
            civil_dawn,
            sunrise,
            sunset,
            civil_dusk,
            nautical_dusk,
            moonrise,
            moonset,
        });
    }
    if window.1 < day0 + 3.0 || window.0 > day0 - 0.5 {
        errors.push(BodyError {
            body: "rise_set".to_string(),
            message: format!(
                "the ephemeris covers {} to {}; phenomena that need instants outside it are \
                 printed n/a",
                format_utc(cov_start),
                format_utc(cov_end)
            ),
        });
    }
    let (sun_green, moon_green) = greenwich.expect("0 is a standard latitude");

    // --- Aries ---------------------------------------------------------------------------
    let aries = AriesDay {
        mer_pass: aries_mer_pass(&memo, day0, cov_end),
    };

    // --- Sun -----------------------------------------------------------------------------
    let sun_mer = passage(&sun_green, EventKind::Transit, day0, window);
    let sd = sun_noon.semidiameter_arcmin;
    let d = d_arcmin(&sun_states[0], &sun_states[24]);
    let eot0 = equation_of_time_s(&sun_states[0], day0);
    let eot12 = equation_of_time_s(&sun_states[12], day0);
    let sun = SunDay {
        sd_arcmin: sd,
        d_arcmin: d,
        eot_00h_s: eot0,
        eot_12h_s: eot12,
        mer_pass: sun_mer,
        printed: SunDayText {
            sd: fmt_arcmin(sd),
            d: fmt_arcmin(d.abs()),
            eot_00h: fmt_ms(eot0),
            eot_12h: fmt_ms(eot12),
        },
    };

    // --- Moon ----------------------------------------------------------------------------
    let moon = match (&moon_states, &moon_green) {
        (Some(_), Some(mg)) => {
            let st = memo
                .apparent_state(MOON, noon)
                .map_err(|e| AlmanacError::Unavailable {
                    body: MOON.to_string(),
                    message: e.to_string(),
                })?;
            let (age_days, phase) = moon_age_and_phase(&memo, day0, cov_start, &mut errors);
            let k = st.illuminated_fraction;
            Some(MoonDay {
                sd_arcmin: st.semidiameter_arcmin,
                mer_pass_upper: passage(&mg.events, EventKind::Transit, day0, window),
                mer_pass_lower: passage(&mg.events, EventKind::LowerTransit, day0, window),
                age_days,
                illuminated_fraction: k,
                phase,
                printed: MoonDayText {
                    sd: fmt_arcmin(st.semidiameter_arcmin),
                    age: age_days.map_or_else(
                        || LATER_SYMBOL.to_string(),
                        |a| format!("{:02}", a.floor() as i64),
                    ),
                    illuminated: k.map_or_else(
                        || LATER_SYMBOL.to_string(),
                        |k| format!("{:.0}", (k * 100.0).round()),
                    ),
                },
            })
        }
        _ => None,
    };

    // --- Planets for the day -----------------------------------------------------------
    let planet_passages = planet_passages(&memo, &planet_states, day0, &clamp)?;
    let mut planets = Vec::with_capacity(planet_states.len());
    for ((name, s), mer_pass) in planet_states.iter().zip(planet_passages) {
        let st = memo
            .apparent_state(name, noon)
            .map_err(|e| AlmanacError::Unavailable {
                body: (*name).to_string(),
                message: e.to_string(),
            })?;
        let v = v_arcmin(&s[0], &s[24], PLANET_ADOPTED_RATE_DEG_PER_HOUR);
        let d = d_arcmin(&s[0], &s[24]);
        let sha = st.sha_deg();
        planets.push(PlanetDay {
            body: (*name).to_string(),
            magnitude: st.magnitude,
            v_arcmin: v,
            d_arcmin: d,
            sha_deg: sha,
            mer_pass,
            printed: PlanetDayText {
                magnitude: st
                    .magnitude
                    .map_or_else(|| LATER_SYMBOL.to_string(), fmt_magnitude),
                v: fmt_arcmin(v),
                d: fmt_arcmin(d.abs()),
                sha: fmt_angle(sha),
            },
        });
    }

    // --- Stars at 12h ----------------------------------------------------------------
    let mut stars = Vec::with_capacity(58);
    for s in catalog::navigational_stars() {
        match memo.apparent_state(&s.name, noon) {
            Ok(st) => stars.push(StarRow {
                body: st.body.clone(),
                sha_deg: st.sha_deg(),
                dec_deg: st.dec_deg,
                magnitude: s.magnitude,
                printed: StarText {
                    sha: fmt_angle(st.sha_deg()),
                    dec: fmt_dec(st.dec_deg),
                },
            }),
            Err(e) => errors.push(BodyError {
                body: s.name.clone(),
                message: e.to_string(),
            }),
        }
    }

    Ok(AlmanacDay {
        date: date.to_string(),
        weekday: date.weekday().to_string(),
        jd_utc: day0,
        noon_jd_utc: noon,
        hours,
        aries,
        sun,
        moon,
        planets,
        stars,
        rise_set: RiseSetTable {
            moon_dates: vec![date.to_string(), date.plus_days(1).to_string()],
            rows,
        },
        notes: NOTES.iter().map(|s| (*s).to_string()).collect(),
        errors,
    })
}

// ---------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------

/// The Moon's events at one latitude over the page's window.
#[derive(Debug, Clone)]
struct MoonEvents {
    events: Vec<SkyEvent>,
    /// The window-wide classification from `day_events` (used only when the Moon neither
    /// rises nor sets anywhere in the window).
    always_above: bool,
}

/// The first `kind` event on the date `day0`, or else the first on the next date
/// (printed `24 hh mm`); `--` when neither, `n/a` when the window stops short.
fn passage(ev: &[SkyEvent], kind: EventKind, day0: f64, window: (f64, f64)) -> TableTime {
    let first_in = |a: f64, b: f64| {
        ev.iter()
            .find(|e| e.kind == kind && e.jd_utc >= a && e.jd_utc < b)
    };
    if let Some(e) = first_in(day0, day0 + 1.0) {
        return TableTime::at(e.jd_utc, day0, false);
    }
    if day0 + 1.0 > window.1 {
        return TableTime::unavailable();
    }
    if let Some(e) = first_in(day0 + 1.0, day0 + 2.0) {
        return TableTime::at(e.jd_utc, day0, false);
    }
    if day0 + 2.0 > window.1 {
        TableTime::unavailable()
    } else {
        TableTime::symbol(TimeKind::Later)
    }
}

/// The UT at which `GHA Aries = 0` on the date (the first, if twice), by Newton's method
/// on the Sun's `GHA + RA` (a few provider calls; the rate is sidereal to 1e-9).
fn aries_mer_pass(eph: &dyn BodyEphemeris, day0: f64, cov_end: f64) -> TableTime {
    let aries = |t: f64| eph.apparent_state(SUN, t).ok().map(|s| gha_aries_of(&s));
    let Some(g0) = aries(day0) else {
        return TableTime::unavailable();
    };
    let mut t = day0 + norm_360(-g0) / SIDEREAL_DEG_PER_DAY;
    for _ in 0..4 {
        if t > cov_end {
            return TableTime::unavailable();
        }
        let Some(g) = aries(t) else {
            return TableTime::unavailable();
        };
        let step = norm_180(-g) / SIDEREAL_DEG_PER_DAY;
        t += step;
        if step.abs() < 1e-9 {
            break;
        }
    }
    TableTime::at(t, day0, true)
}

/// Each planet's upper meridian passage at Greenwich on the date (or the next).
fn planet_passages(
    eph: &dyn BodyEphemeris,
    planets: &[(&'static str, Vec<ApparentState>)],
    day0: f64,
    clamp: &dyn Fn(f64, f64) -> Option<(f64, f64)>,
) -> Result<Vec<TableTime>, AlmanacError> {
    if planets.is_empty() {
        return Ok(Vec::new());
    }
    let Some(window) = clamp(day0, day0 + 2.0) else {
        return Ok(vec![TableTime::unavailable(); planets.len()]);
    };
    let names: Vec<&str> = planets.iter().map(|(n, _)| *n).collect();
    let de = events::day_events(
        eph,
        &Site::new(0.0, 0.0),
        window.0,
        window.1,
        &names,
        &EventOptions::default(),
    )?;
    Ok(names
        .iter()
        .map(|n| match de.bodies.iter().find(|b| b.body == *n) {
            Some(b) => passage(&b.events, EventKind::Transit, day0, window),
            None => TableTime::unavailable(),
        })
        .collect())
}

/// The Moon's age at 12h UT (days since the preceding new moon) and a principal phase
/// during the date, from [`events::moon_phases`].
fn moon_age_and_phase(
    eph: &dyn BodyEphemeris,
    day0: f64,
    cov_start: f64,
    errors: &mut Vec<BodyError>,
) -> (Option<f64>, Option<PhaseEvent>) {
    let noon = day0 + 0.5;
    // A synodic month is at most 29.9 days: 31 days back always holds a new moon.
    let from = (noon - 31.0).max(cov_start);
    match events::moon_phases(eph, from, day0 + 1.0) {
        Ok(phases) => {
            let age = phases
                .iter()
                .rfind(|p| p.kind == MoonPhaseKind::NewMoon && p.jd_utc <= noon)
                .map(|p| noon - p.jd_utc);
            if age.is_none() {
                errors.push(BodyError {
                    body: MOON.to_string(),
                    message: "the Moon's age needs the preceding new moon, which is before \
                              the start of the ephemeris coverage"
                        .to_string(),
                });
            }
            let phase = phases
                .into_iter()
                .find(|p| p.jd_utc >= day0 && p.jd_utc < day0 + 1.0);
            (age, phase)
        }
        Err(e) => {
            errors.push(BodyError {
                body: MOON.to_string(),
                message: format!("Moon's age and phase: {e}"),
            });
            (None, None)
        }
    }
}

// ---------------------------------------------------------------------------
// Rise, set and twilight cells (module docs)
// ---------------------------------------------------------------------------

/// The Sun's six cells at one latitude: nautical dawn, civil dawn, sunrise, sunset, civil
/// dusk, nautical dusk, from its events over the page's window (sorted by time).
fn sun_cells(ev: &[SkyEvent], day0: f64, window: (f64, f64)) -> [TableTime; 6] {
    let Some(noon) = ev
        .iter()
        .find(|e| e.kind == EventKind::Transit && e.jd_utc >= day0 && e.jd_utc < day0 + 1.0)
    else {
        return std::array::from_fn(|_| TableTime::unavailable());
    };
    let before = ev
        .iter()
        .rev()
        .find(|e| e.kind == EventKind::LowerTransit && e.jd_utc < noon.jd_utc);
    let after = ev
        .iter()
        .find(|e| e.kind == EventKind::LowerTransit && e.jd_utc > noon.jd_utc);
    let from = before.map_or(window.0, |e| e.jd_utc);
    let to = after.map_or(window.1, |e| e.jd_utc);
    let low_morning = before.map(|e| e.alt_deg);
    let low_evening = after.map(|e| e.alt_deg);

    let cell = |threshold: f64, kind: EventKind, morning: bool| -> TableTime {
        let found = if morning {
            ev.iter()
                .find(|e| e.kind == kind && e.jd_utc > from && e.jd_utc <= noon.jd_utc)
        } else {
            ev.iter()
                .rev()
                .find(|e| e.kind == kind && e.jd_utc > noon.jd_utc && e.jd_utc <= to)
        };
        if let Some(e) = found {
            return TableTime::at(e.jd_utc, day0, false);
        }
        let low = if morning { low_morning } else { low_evening };
        let twilight = threshold != SUN_RISE_SET_DEG;
        if noon.alt_deg < threshold {
            TableTime::symbol(TimeKind::Below)
        } else {
            match low {
                Some(l) if l > threshold => {
                    if twilight && l <= SUN_RISE_SET_DEG {
                        TableTime::symbol(TimeKind::AllNight)
                    } else {
                        TableTime::symbol(TimeKind::Above)
                    }
                }
                _ => TableTime::unavailable(),
            }
        }
    };
    [
        cell(NAUTICAL_TWILIGHT_DEG, EventKind::NauticalDawn, true),
        cell(CIVIL_TWILIGHT_DEG, EventKind::CivilDawn, true),
        cell(SUN_RISE_SET_DEG, EventKind::Rise, true),
        cell(SUN_RISE_SET_DEG, EventKind::Set, false),
        cell(CIVIL_TWILIGHT_DEG, EventKind::CivilDusk, false),
        cell(NAUTICAL_TWILIGHT_DEG, EventKind::NauticalDusk, false),
    ]
}

/// Whether the Moon is above its rise/set altitude at `t`, from the rise and set events
/// around it (or, with none in the window, the window-wide classification).
fn moon_above_at(m: &MoonEvents, t: f64) -> bool {
    let is_rs = |e: &&SkyEvent| matches!(e.kind, EventKind::Rise | EventKind::Set);
    if let Some(e) = m.events.iter().filter(is_rs).rev().find(|e| e.jd_utc <= t) {
        return e.kind == EventKind::Rise;
    }
    if let Some(e) = m.events.iter().filter(is_rs).find(|e| e.jd_utc > t) {
        return e.kind == EventKind::Set;
    }
    m.always_above
}

/// A moonrise (`kind = Rise`) or moonset cell for the date starting at `x0` (module docs).
fn moon_cell(m: &MoonEvents, kind: EventKind, x0: f64, window: (f64, f64)) -> TableTime {
    if x0 < window.0 || x0 + 1.0 > window.1 {
        return TableTime::unavailable();
    }
    let in_day = |e: &&SkyEvent| e.jd_utc >= x0 && e.jd_utc < x0 + 1.0;
    if let Some(e) = m.events.iter().filter(in_day).find(|e| e.kind == kind) {
        return TableTime::at(e.jd_utc, x0, false);
    }
    let crosses = m
        .events
        .iter()
        .filter(in_day)
        .any(|e| matches!(e.kind, EventKind::Rise | EventKind::Set));
    if !crosses {
        return TableTime::symbol(if moon_above_at(m, x0) {
            TimeKind::Above
        } else {
            TimeKind::Below
        });
    }
    if let Some(e) = m
        .events
        .iter()
        .find(|e| e.kind == kind && e.jd_utc >= x0 + 1.0 && e.jd_utc < x0 + 2.0)
    {
        return TableTime::at(e.jd_utc, x0, false);
    }
    if x0 + 2.0 > window.1 {
        TableTime::unavailable()
    } else {
        TableTime::symbol(TimeKind::Later)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angles_print_to_a_tenth_of_an_arcminute() {
        assert_eq!(fmt_angle(183.206_667), "183 12.4");
        assert_eq!(fmt_angle(2.123_4), "2 07.4");
        assert_eq!(fmt_angle(0.0), "0 00.0");
        // Rounds up across the degree and across 360 without printing 60' or 360°.
        assert_eq!(fmt_angle(12.999_99), "13 00.0");
        assert_eq!(fmt_angle(359.999_9), "0 00.0");
        assert_eq!(fmt_angle(-0.5), "359 30.0");
        assert_eq!(fmt_dec(-12.575), "S 12 34.5");
        assert_eq!(fmt_dec(1.038_333), "N 1 02.3");
        assert_eq!(fmt_dec(-0.000_1), "S 0 00.0");
        assert_eq!(fmt_dec(89.999_99), "N 90 00.0");
    }

    #[test]
    fn small_quantities_times_and_magnitudes() {
        assert_eq!(fmt_arcmin(7.25), "7.3");
        assert_eq!(fmt_arcmin(-0.34), "-0.3");
        assert_eq!(fmt_arcmin(-0.04), "0.0");
        assert_eq!(fmt_arcmin(54.83), "54.8");
        assert_eq!(fmt_magnitude(-3.94), "-3.9");
        assert_eq!(fmt_magnitude(1.26), "+1.3");
        assert_eq!(fmt_magnitude(0.04), "0.0");
        assert_eq!(fmt_hm(6.7), "06 42");
        assert_eq!(fmt_hm(24.0 + 5.0 / 60.0), "24 05");
        assert_eq!(fmt_hm(-2.0 / 60.0), "-00 02");
        assert_eq!(fmt_hm(23.999_9), "24 00");
        assert_eq!(fmt_hm_tenths(23.0 + 15.24 / 60.0), "23 15.2");
        assert_eq!(fmt_ms(-465.4), "07 45");
        assert_eq!(fmt_ms(59.6), "01 00");
        assert_eq!(latitude_label(72.0), "N 72");
        assert_eq!(latitude_label(0.0), "0");
        assert_eq!(latitude_label(-35.0), "S 35");
    }

    #[test]
    fn dates_parse_strictly_and_know_their_weekday() {
        let d = UtDate::parse("2026-09-24").unwrap();
        assert_eq!((d.year, d.month, d.day), (2026, 9, 24));
        assert_eq!(d.weekday(), "Thursday");
        assert_eq!(UtDate::parse("2000-01-01").unwrap().weekday(), "Saturday");
        assert_eq!(
            UtDate::parse("2000-02-29")
                .unwrap()
                .plus_days(1)
                .to_string(),
            "2000-03-01"
        );
        assert_eq!(
            UtDate::parse("2060-12-31")
                .unwrap()
                .plus_days(1)
                .to_string(),
            "2061-01-01"
        );
        for bad in [
            "2026-9-24",
            "2026-02-30",
            "2026-13-01",
            "26-09-24",
            "2026/09/24",
            "",
            "2026-09-24T00",
        ] {
            assert!(UtDate::parse(bad).is_err(), "{bad}");
        }
        assert!(UtDate::parse("2100-02-29").is_err());
        assert!(UtDate::parse("2000-02-29").is_ok());
    }

    fn ev(kind: EventKind, jd: f64, alt: f64) -> SkyEvent {
        SkyEvent {
            kind,
            jd_utc: jd,
            utc: String::new(),
            alt_deg: alt,
            az_deg: 0.0,
        }
    }

    /// A Sun that sets, grazes the civil altitude and never reaches the nautical one.
    #[test]
    fn sun_cells_pick_morning_and_evening_and_classify_the_rest() {
        let d = 100.0;
        let events = vec![
            ev(EventKind::LowerTransit, d - 0.001, -7.0),
            ev(EventKind::CivilDawn, d + 0.05, -6.0),
            ev(EventKind::Rise, d + 0.12, SUN_RISE_SET_DEG),
            ev(EventKind::Transit, d + 0.5, 40.0),
            ev(EventKind::Set, d + 0.88, SUN_RISE_SET_DEG),
            // Civil dusk a few minutes after midnight: the evening of `d`.
            ev(EventKind::CivilDusk, d + 1.003, -6.0),
            ev(EventKind::LowerTransit, d + 1.01, -6.5),
        ];
        let c = sun_cells(&events, d, (d - 0.5, d + 3.0));
        assert_eq!(c[0].kind, TimeKind::AllNight, "nautical dawn");
        assert_eq!(c[1].printed, "01 12");
        assert_eq!(c[2].printed, "02 53");
        assert_eq!(c[3].printed, "21 07");
        assert_eq!(c[4].printed, "24 04");
        assert_eq!(c[5].printed, ALL_NIGHT_SYMBOL);
    }

    #[test]
    fn sun_cells_in_midnight_sun_and_polar_night() {
        let d = 100.0;
        let midnight_sun = vec![
            ev(EventKind::LowerTransit, d, 2.0),
            ev(EventKind::Transit, d + 0.5, 40.0),
            ev(EventKind::LowerTransit, d + 1.0, 2.1),
        ];
        let c = sun_cells(&midnight_sun, d, (d - 0.5, d + 3.0));
        assert!(c.iter().all(|x| x.printed == ABOVE_SYMBOL), "{c:?}");

        let polar_night = vec![
            ev(EventKind::LowerTransit, d, -30.0),
            ev(EventKind::NauticalDawn, d + 0.4, -12.0),
            ev(EventKind::Transit, d + 0.5, -8.0),
            ev(EventKind::NauticalDusk, d + 0.6, -12.0),
            ev(EventKind::LowerTransit, d + 1.0, -30.0),
        ];
        let c = sun_cells(&polar_night, d, (d - 0.5, d + 3.0));
        assert_eq!(c[0].printed, "09 36");
        assert_eq!(c[1].printed, BELOW_SYMBOL);
        assert_eq!(c[2].printed, BELOW_SYMBOL);
        assert_eq!(c[3].printed, BELOW_SYMBOL);
        assert_eq!(c[4].printed, BELOW_SYMBOL);
        assert_eq!(c[5].printed, "14 24");
    }

    #[test]
    fn moon_cells_follow_the_next_day_and_box_conventions() {
        let d = 100.0;
        let w = (d - 0.5, d + 3.0);
        // Rises late on d - 1, sets on d, rises again early on d + 1.
        let m = MoonEvents {
            events: vec![
                ev(EventKind::Rise, d - 0.02, -0.8),
                ev(EventKind::Set, d + 0.5, -0.8),
                ev(EventKind::Rise, d + 1.03, -0.8),
                ev(EventKind::Set, d + 1.55, -0.8),
                ev(EventKind::Rise, d + 2.07, -0.8),
            ],
            always_above: false,
        };
        assert_eq!(moon_cell(&m, EventKind::Rise, d, w).printed, "24 43");
        assert_eq!(moon_cell(&m, EventKind::Set, d, w).printed, "12 00");
        assert_eq!(moon_cell(&m, EventKind::Rise, d + 1.0, w).printed, "00 43");
        // A day wholly above, then wholly below.
        let up = MoonEvents {
            events: vec![
                ev(EventKind::Rise, d - 0.2, 0.0),
                ev(EventKind::Set, d + 1.3, 0.0),
            ],
            always_above: false,
        };
        assert_eq!(moon_cell(&up, EventKind::Rise, d, w).printed, ABOVE_SYMBOL);
        assert_eq!(moon_cell(&up, EventKind::Set, d, w).printed, ABOVE_SYMBOL);
        let down = MoonEvents {
            events: vec![],
            always_above: false,
        };
        assert_eq!(
            moon_cell(&down, EventKind::Rise, d, w).printed,
            BELOW_SYMBOL
        );
        // Sets on d, no rise on d nor d + 1.
        let gone = MoonEvents {
            events: vec![ev(EventKind::Set, d + 0.3, 0.0)],
            always_above: false,
        };
        assert_eq!(
            moon_cell(&gone, EventKind::Rise, d, w).printed,
            LATER_SYMBOL
        );
        // The window stops before the next day: n/a, not a guess.
        assert_eq!(
            moon_cell(&gone, EventKind::Rise, d, (d - 0.5, d + 1.5)).printed,
            UNAVAILABLE_SYMBOL
        );
        assert_eq!(
            moon_cell(&m, EventKind::Rise, d + 1.0, (d - 0.5, d + 1.5)).printed,
            UNAVAILABLE_SYMBOL
        );
    }

    #[test]
    fn passages_fall_back_to_the_next_date() {
        let d = 100.0;
        let w = (d - 0.5, d + 3.0);
        let e = vec![
            ev(EventKind::Transit, d - 0.01, 0.0),
            ev(EventKind::Transit, d + 1.02, 0.0),
        ];
        assert_eq!(passage(&e, EventKind::Transit, d, w).printed, "24 29");
        assert_eq!(
            passage(&e, EventKind::LowerTransit, d, w).printed,
            LATER_SYMBOL
        );
        assert_eq!(
            passage(&e, EventKind::LowerTransit, d, (d, d + 1.5)).printed,
            UNAVAILABLE_SYMBOL
        );
    }
}
