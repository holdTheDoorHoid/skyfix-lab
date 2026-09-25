//! CONVENTIONS section 15.3: Julian and Gregorian civil dates for any year.
//!
//! The Julian date stays the internal scale; this module only names days. Years are
//! astronomical everywhere in code and on the wire (year 0 is 1 BC, year -584 is 585 BC);
//! [`era_of`] gives the "585 BC" form people write. The Julian calendar is the display
//! and input convention before 1582-10-15 (Gregorian), the day after Julian 1582-10-04
//! ([`calendar_for_jd`]); the wire format is always proleptic Gregorian
//! (`time::format_utc`).
//!
//! The day counts are exact integer arithmetic with floor division, valid for every year
//! an `i64` holds: the proleptic Gregorian count in 400-year eras (146 097 days) and the
//! Julian in 4-year eras (1 461 days), both anchored on March 1 so that the leap day ends
//! the year. They are Meeus's chapter 7 algorithms in integer form, cross-checked
//! against Skyfield's `julian_day` and `compute_calendar_date` over -7450..+17190 in
//! `tests/timescales_reference.rs` (fixture `fixtures/reference/timescales.json`).

use serde::{Deserialize, Serialize};

/// The calendar a civil date is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Calendar {
    Julian,
    Gregorian,
}

impl Calendar {
    pub fn name(self) -> &'static str {
        match self {
            Calendar::Julian => "julian",
            Calendar::Gregorian => "gregorian",
        }
    }
}

impl std::fmt::Display for Calendar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Calendar::Julian => "Julian",
            Calendar::Gregorian => "Gregorian",
        })
    }
}

impl std::str::FromStr for Calendar {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "julian" => Ok(Calendar::Julian),
            "gregorian" | "iso" => Ok(Calendar::Gregorian),
            _ => Err(format!(
                "calendar {s:?}: expected \"julian\" or \"gregorian\""
            )),
        }
    }
}

/// Before Christ / Anno Domini, for the year as people write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Era {
    BC,
    AD,
}

impl std::fmt::Display for Era {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Era::BC => "BC",
            Era::AD => "AD",
        })
    }
}

/// `(era_year, era)` of an astronomical year: 2026 is (2026, AD), 1 is (1, AD), 0 is
/// (1, BC) and -584 is (585, BC).
pub fn era_of(year: i64) -> (i64, Era) {
    if year >= 1 {
        (year, Era::AD)
    } else {
        (1 - year, Era::BC)
    }
}

/// The astronomical year of a year as people write it: (585, BC) is -584.
pub fn year_of_era(era_year: i64, era: Era) -> i64 {
    match era {
        Era::AD => era_year,
        Era::BC => 1 - era_year,
    }
}

/// Julian day number (`floor(JD + 0.5)`: the day that begins at 0h of JD - 0.5) of
/// Gregorian 1582-10-15, the first day of the Gregorian calendar.
pub const GREGORIAN_START_JDN: i64 = 2_299_161;
/// JD of 1582-10-15T00:00 (Gregorian), which followed Julian 1582-10-04.
pub const GREGORIAN_START_JD: f64 = 2_299_160.5;
/// JDN of 1970-01-01 (Gregorian).
const JDN_UNIX_EPOCH: i64 = 2_440_588;
/// JDN of 0000-03-01 in each calendar: the anchors of the era arithmetic.
const JDN_MARCH_0_GREGORIAN: i64 = 1_721_120;
const JDN_MARCH_0_JULIAN: i64 = 1_721_118;

/// Errors from civil-date input.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CalendarError {
    #[error("month {0} is not 1-12")]
    Month(u32),
    #[error("{calendar} {year}-{month:02} has {max} days, not {day}")]
    Day {
        calendar: Calendar,
        year: i64,
        month: u32,
        day: u32,
        max: u32,
    },
    #[error("time of day {hour:02}:{minute:02}:{second} is out of range")]
    Time { hour: u32, minute: u32, second: f64 },
    #[error("{0}")]
    Other(String),
}

/// Leap year in the given calendar (astronomical numbering: year 0 and -4 are leap).
pub fn is_leap_year(calendar: Calendar, year: i64) -> bool {
    match calendar {
        Calendar::Julian => year.rem_euclid(4) == 0,
        Calendar::Gregorian => {
            year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
        }
    }
}

/// Days in `month` (1-12) of `year`, or `None` for a month out of range.
pub fn days_in_month(calendar: Calendar, year: i64, month: u32) -> Option<u32> {
    Some(match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(calendar, year) => 29,
        2 => 28,
        _ => return None,
    })
}

/// Check a civil date.
pub fn check_date(
    calendar: Calendar,
    year: i64,
    month: u32,
    day: u32,
) -> Result<(), CalendarError> {
    let max = days_in_month(calendar, year, month).ok_or(CalendarError::Month(month))?;
    if (1..=max).contains(&day) {
        Ok(())
    } else {
        Err(CalendarError::Day {
            calendar,
            year,
            month,
            day,
            max,
        })
    }
}

/// Julian day number of a civil date (the JD at noon of that day). The date must be
/// valid ([`check_date`]); an invalid day rolls over arithmetically.
pub fn jdn_from_civil(calendar: Calendar, year: i64, month: u32, day: u32) -> i64 {
    let m = i64::from(month);
    let y = if m <= 2 { year - 1 } else { year };
    let mp = (m + 9).rem_euclid(12); // March = 0 .. February = 11
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1; // [0, 365]
    match calendar {
        Calendar::Gregorian => {
            let era = y.div_euclid(400);
            let yoe = y - era * 400; // [0, 399]
            let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
            era * 146_097 + doe + JDN_MARCH_0_GREGORIAN
        }
        Calendar::Julian => {
            let era = y.div_euclid(4);
            let yoe = y - era * 4; // [0, 3]
            let doe = yoe * 365 + doy; // [0, 1460]
            era * 1_461 + doe + JDN_MARCH_0_JULIAN
        }
    }
}

/// `(year, month, day)` of a Julian day number in the given calendar.
pub fn civil_from_jdn(calendar: Calendar, jdn: i64) -> (i64, u32, u32) {
    let (y, doy) = match calendar {
        Calendar::Gregorian => {
            let z = jdn - JDN_MARCH_0_GREGORIAN;
            let era = z.div_euclid(146_097);
            let doe = z.rem_euclid(146_097); // [0, 146096]
            let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
            (yoe + era * 400, doe - (365 * yoe + yoe / 4 - yoe / 100))
        }
        Calendar::Julian => {
            let z = jdn - JDN_MARCH_0_JULIAN;
            let era = z.div_euclid(1_461);
            let doe = z.rem_euclid(1_461); // [0, 1460]
            let yoe = (doe - doe / 1_460) / 365; // [0, 3]
            (yoe + era * 4, doe - 365 * yoe)
        }
    };
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// The calendar the app displays for a Julian day number: Julian before 1582-10-15.
pub fn calendar_for_jdn(jdn: i64) -> Calendar {
    if jdn < GREGORIAN_START_JDN {
        Calendar::Julian
    } else {
        Calendar::Gregorian
    }
}

/// The calendar the app displays for an instant: Julian before 1582-10-15T00:00.
pub fn calendar_for_jd(jd: f64) -> Calendar {
    if jd < GREGORIAN_START_JD {
        Calendar::Julian
    } else {
        Calendar::Gregorian
    }
}

/// Milliseconds since 1970-01-01T00:00 of a Julian date, rounded to the nearest
/// millisecond (f64 JDs resolve about 40 microseconds). `None` when not finite or beyond
/// about 280 000 years, where milliseconds stop being exact in an f64.
pub fn unix_ms_of_jd(jd: f64) -> Option<i64> {
    let ms = ((jd - 2_440_587.5) * 86_400_000.0).round();
    (ms.is_finite() && ms.abs() < 9.0e15).then_some(ms as i64)
}

/// A civil date and time of day in one calendar, on the app's clock (CONVENTIONS 15.2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CivilDateTime {
    pub calendar: Calendar,
    /// Astronomical year (0 = 1 BC).
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// Seconds with the milliseconds, `[0, 60)`.
    pub second: f64,
}

impl CivilDateTime {
    /// The civil date and time of `jd` in `calendar`, rounded to the millisecond.
    /// `None` for a non-finite `jd` or one beyond about 280 000 years.
    pub fn from_jd(jd: f64, calendar: Calendar) -> Option<Self> {
        let ms = unix_ms_of_jd(jd)?;
        let days = ms.div_euclid(86_400_000);
        let ms_of_day = ms.rem_euclid(86_400_000);
        let (year, month, day) = civil_from_jdn(calendar, days + JDN_UNIX_EPOCH);
        let hour = (ms_of_day / 3_600_000) as u32;
        let minute = (ms_of_day / 60_000 % 60) as u32;
        let second = (ms_of_day % 60_000) as f64 / 1000.0;
        Some(CivilDateTime {
            calendar,
            year,
            month,
            day,
            hour,
            minute,
            second,
        })
    }

    /// The Julian date of this civil instant. Checks the date and the time of day
    /// (`second` in `[0, 60]`: a positive leap second's `:60` is the next second).
    pub fn to_jd(&self) -> Result<f64, CalendarError> {
        check_date(self.calendar, self.year, self.month, self.day)?;
        if self.hour > 23
            || self.minute > 59
            || !self.second.is_finite()
            || !(0.0..=60.0).contains(&self.second)
        {
            return Err(CalendarError::Time {
                hour: self.hour,
                minute: self.minute,
                second: self.second,
            });
        }
        let jdn = jdn_from_civil(self.calendar, self.year, self.month, self.day);
        // The same arithmetic as `time::parse_utc`: whole seconds since the Unix epoch
        // plus the fraction, then days.
        let whole = self.second.trunc();
        let secs = ((jdn - JDN_UNIX_EPOCH) * 86_400
            + i64::from(self.hour) * 3_600
            + i64::from(self.minute) * 60
            + whole as i64) as f64
            + (self.second - whole);
        Ok(2_440_587.5 + secs / 86_400.0)
    }

    /// `(era_year, era)` of the year.
    pub fn era(&self) -> (i64, Era) {
        era_of(self.year)
    }

    /// The same instant in the other calendar (or the same one).
    pub fn in_calendar(&self, calendar: Calendar) -> Self {
        if calendar == self.calendar {
            return *self;
        }
        let jdn = jdn_from_civil(self.calendar, self.year, self.month, self.day);
        let (year, month, day) = civil_from_jdn(calendar, jdn);
        CivilDateTime {
            calendar,
            year,
            month,
            day,
            ..*self
        }
    }

    /// `YYYY-MM-DD` with ISO expanded years outside 0000-9999 (`-0584-05-28`).
    pub fn date_string(&self) -> String {
        format!(
            "{}-{:02}-{:02}",
            format_year(self.year),
            self.month,
            self.day
        )
    }

    /// `HH:MM:SS` (seconds truncated to whole seconds).
    pub fn time_string(&self) -> String {
        format!(
            "{:02}:{:02}:{:02}",
            self.hour,
            self.minute,
            self.second.trunc() as u32
        )
    }

    /// The date as people write it: `28 May 585 BC`, `24 September 2026`.
    pub fn human_date(&self) -> String {
        const MONTHS: [&str; 12] = [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ];
        let (y, era) = self.era();
        let month = MONTHS[(self.month.clamp(1, 12) - 1) as usize];
        match era {
            Era::AD => format!("{} {month} {y}", self.day),
            Era::BC => format!("{} {month} {y} BC", self.day),
        }
    }
}

/// An astronomical year the way ISO 8601 writes it: four digits for 0000-9999, else a
/// sign and at least four digits (`-0584`, `+12345`).
pub fn format_year(year: i64) -> String {
    if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:04}", year.unsigned_abs())
    } else {
        format!("+{year}")
    }
}

/// The wire shape of a civil date (`EXPLORER_API.md`, "`time_info`"): the date and time
/// of day in `calendar`, the astronomical `year`, and the year as people write it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CivilDate {
    pub calendar: Calendar,
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: f64,
    pub era_year: i64,
    pub era: Era,
}

impl From<CivilDateTime> for CivilDate {
    fn from(c: CivilDateTime) -> Self {
        let (era_year, era) = c.era();
        CivilDate {
            calendar: c.calendar,
            year: c.year,
            month: c.month,
            day: c.day,
            hour: c.hour,
            minute: c.minute,
            second: c.second,
            era_year,
            era,
        }
    }
}

/// `calendar_convert` request (`EXPLORER_API.md`): exactly one of `jd_utc` or `civil`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarConvertRequest {
    #[serde(default)]
    pub jd_utc: Option<f64>,
    #[serde(default)]
    pub civil: Option<CivilInput>,
}

/// A civil date typed by a person: the calendar, the astronomical year, month and day;
/// the time of day defaults to 00:00:00. `era_year`/`era`, when given, must name the same
/// year.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CivilInput {
    pub calendar: Calendar,
    pub year: i64,
    pub month: u32,
    pub day: u32,
    #[serde(default)]
    pub hour: Option<u32>,
    #[serde(default)]
    pub minute: Option<u32>,
    #[serde(default)]
    pub second: Option<f64>,
    #[serde(default)]
    pub era_year: Option<i64>,
    #[serde(default)]
    pub era: Option<Era>,
}

/// `calendar_convert` result: the instant and its date in both calendars.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalendarConversion {
    pub jd_utc: f64,
    pub gregorian: CivilDate,
    pub julian: CivilDate,
}

/// Convert between a Julian date and civil dates in either calendar, for any year.
pub fn calendar_convert(req: &CalendarConvertRequest) -> Result<CalendarConversion, CalendarError> {
    let jd = match (req.jd_utc, &req.civil) {
        (Some(jd), None) => {
            if !jd.is_finite() {
                return Err(CalendarError::Other(format!("jd_utc {jd} is not finite")));
            }
            jd
        }
        (None, Some(c)) => {
            if let (Some(ey), Some(era)) = (c.era_year, c.era)
                && year_of_era(ey, era) != c.year
            {
                return Err(CalendarError::Other(format!(
                    "era_year {ey} {era} is astronomical year {}, not {}",
                    year_of_era(ey, era),
                    c.year
                )));
            }
            CivilDateTime {
                calendar: c.calendar,
                year: c.year,
                month: c.month,
                day: c.day,
                hour: c.hour.unwrap_or(0),
                minute: c.minute.unwrap_or(0),
                second: c.second.unwrap_or(0.0),
            }
            .to_jd()?
        }
        _ => {
            return Err(CalendarError::Other(
                "give exactly one of jd_utc or civil".to_string(),
            ));
        }
    };
    let out = |cal| {
        CivilDateTime::from_jd(jd, cal)
            .map(CivilDate::from)
            .ok_or_else(|| CalendarError::Other(format!("jd_utc {jd} is out of range")))
    };
    Ok(CalendarConversion {
        jd_utc: jd,
        gregorian: out(Calendar::Gregorian)?,
        julian: out(Calendar::Julian)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_days() {
        // JDN 0 is Julian -4712-01-01; J2000's day; the calendar reform; the Unix epoch.
        assert_eq!(jdn_from_civil(Calendar::Julian, -4712, 1, 1), 0);
        assert_eq!(civil_from_jdn(Calendar::Julian, 0), (-4712, 1, 1));
        assert_eq!(civil_from_jdn(Calendar::Gregorian, 0), (-4713, 11, 24));
        assert_eq!(jdn_from_civil(Calendar::Gregorian, 2000, 1, 1), 2_451_545);
        assert_eq!(jdn_from_civil(Calendar::Julian, 1582, 10, 4), 2_299_160);
        assert_eq!(
            jdn_from_civil(Calendar::Gregorian, 1582, 10, 15),
            GREGORIAN_START_JDN
        );
        assert_eq!(
            civil_from_jdn(Calendar::Julian, GREGORIAN_START_JDN),
            (1582, 10, 5)
        );
        assert_eq!(
            jdn_from_civil(Calendar::Gregorian, 1970, 1, 1),
            JDN_UNIX_EPOCH
        );
        // Meeus, Astronomical Algorithms (2nd ed.), examples 7.a and 7.b and the table
        // after them (JD at 0h is the JDN - 0.5).
        assert_eq!(jdn_from_civil(Calendar::Gregorian, 1957, 10, 4), 2_436_116);
        assert_eq!(jdn_from_civil(Calendar::Julian, 333, 1, 27), 1_842_713);
        assert_eq!(jdn_from_civil(Calendar::Gregorian, 1600, 12, 31), 2_305_813);
        assert_eq!(jdn_from_civil(Calendar::Julian, 837, 4, 10), 2_026_872);
        assert_eq!(jdn_from_civil(Calendar::Julian, -123, 12, 31), 1_676_497);
        assert_eq!(jdn_from_civil(Calendar::Julian, -122, 1, 1), 1_676_498);
        assert_eq!(jdn_from_civil(Calendar::Julian, -1000, 7, 12), 1_356_001);
        assert_eq!(jdn_from_civil(Calendar::Julian, -1000, 2, 29), 1_355_867);
        assert_eq!(jdn_from_civil(Calendar::Julian, -1001, 8, 17), 1_355_671);
    }

    #[test]
    fn round_trips_every_day_over_ten_thousand_years() {
        for cal in [Calendar::Julian, Calendar::Gregorian] {
            let first = jdn_from_civil(cal, -5000, 1, 1);
            let last = jdn_from_civil(cal, 5000, 12, 31);
            let (mut y, mut m, mut d) = (-5000_i64, 1_u32, 1_u32);
            for jdn in first..=last {
                assert_eq!(civil_from_jdn(cal, jdn), (y, m, d), "{cal} {jdn}");
                assert_eq!(jdn_from_civil(cal, y, m, d), jdn);
                // The next day by hand.
                if d < days_in_month(cal, y, m).unwrap() {
                    d += 1;
                } else if m < 12 {
                    (m, d) = (m + 1, 1);
                } else {
                    (y, m, d) = (y + 1, 1, 1);
                }
            }
        }
    }

    #[test]
    fn leap_years_and_month_lengths() {
        assert!(is_leap_year(Calendar::Julian, 1900));
        assert!(!is_leap_year(Calendar::Gregorian, 1900));
        assert!(is_leap_year(Calendar::Gregorian, 2000));
        assert!(is_leap_year(Calendar::Julian, 0) && is_leap_year(Calendar::Gregorian, 0));
        assert!(is_leap_year(Calendar::Julian, -4) && !is_leap_year(Calendar::Julian, -1));
        assert!(
            !is_leap_year(Calendar::Gregorian, -100) && is_leap_year(Calendar::Gregorian, -400)
        );
        assert_eq!(days_in_month(Calendar::Julian, 1500, 2), Some(29));
        assert_eq!(days_in_month(Calendar::Gregorian, 1500, 2), Some(28));
        assert_eq!(days_in_month(Calendar::Gregorian, 2026, 13), None);
        assert!(check_date(Calendar::Julian, 1500, 2, 29).is_ok());
        assert!(check_date(Calendar::Gregorian, 1500, 2, 29).is_err());
        assert!(check_date(Calendar::Gregorian, 2026, 0, 1).is_err());
    }

    #[test]
    fn eras() {
        assert_eq!(era_of(2026), (2026, Era::AD));
        assert_eq!(era_of(1), (1, Era::AD));
        assert_eq!(era_of(0), (1, Era::BC));
        assert_eq!(era_of(-584), (585, Era::BC));
        assert_eq!(year_of_era(585, Era::BC), -584);
        assert_eq!(format_year(-584), "-0584");
        assert_eq!(format_year(0), "0000");
        assert_eq!(format_year(9999), "9999");
        assert_eq!(format_year(10_000), "+10000");
        assert_eq!(format_year(-12_345), "-12345");
        assert_eq!(calendar_for_jd(GREGORIAN_START_JD), Calendar::Gregorian);
        assert_eq!(calendar_for_jd(GREGORIAN_START_JD - 1e-6), Calendar::Julian);
    }

    #[test]
    fn civil_instants_round_trip_to_the_millisecond() {
        for (cal, y, mo, d, h, mi, s) in [
            (Calendar::Julian, -584, 5, 28, 13, 7, 42.125),
            (Calendar::Gregorian, 2026, 9, 24, 12, 0, 0.0),
            (Calendar::Julian, 0, 2, 29, 23, 59, 59.999),
            (Calendar::Gregorian, 12_345, 1, 1, 0, 0, 0.001),
        ] {
            let c = CivilDateTime {
                calendar: cal,
                year: y,
                month: mo,
                day: d,
                hour: h,
                minute: mi,
                second: s,
            };
            let jd = c.to_jd().unwrap();
            let back = CivilDateTime::from_jd(jd, cal).unwrap();
            assert_eq!(
                (back.year, back.month, back.day, back.hour, back.minute),
                (y, mo, d, h, mi)
            );
            assert!((back.second - s).abs() < 5e-4, "{back:?}");
        }
        // 585 BC May 28 (Julian), Thales' eclipse day, is Gregorian 585 BC May 22.
        let c = CivilDateTime {
            calendar: Calendar::Julian,
            year: -584,
            month: 5,
            day: 28,
            hour: 0,
            minute: 0,
            second: 0.0,
        };
        let g = c.in_calendar(Calendar::Gregorian);
        assert_eq!((g.year, g.month, g.day), (-584, 5, 22));
        assert_eq!(c.human_date(), "28 May 585 BC");
        assert_eq!(c.date_string(), "-0584-05-28");
    }

    #[test]
    fn convert_requests() {
        let r = calendar_convert(&CalendarConvertRequest {
            jd_utc: Some(2_461_308.0),
            civil: None,
        })
        .unwrap();
        assert_eq!(
            (r.gregorian.year, r.gregorian.month, r.gregorian.day),
            (2026, 9, 24)
        );
        assert_eq!((r.gregorian.hour, r.gregorian.minute), (12, 0));
        assert_eq!((r.julian.year, r.julian.month, r.julian.day), (2026, 9, 11));
        let req: CalendarConvertRequest = serde_json::from_str(
            r#"{"civil": {"calendar": "julian", "year": -584, "month": 5, "day": 28, "era_year": 585, "era": "BC"}}"#,
        )
        .unwrap();
        let r = calendar_convert(&req).unwrap();
        assert_eq!(r.jd_utc, 1_507_899.5);
        assert_eq!((r.julian.era_year, r.julian.era), (585, Era::BC));
        let bad: CalendarConvertRequest = serde_json::from_str(
            r#"{"civil": {"calendar": "julian", "year": 585, "month": 5, "day": 28, "era": "BC", "era_year": 585}}"#,
        )
        .unwrap();
        assert!(calendar_convert(&bad).is_err());
        assert!(calendar_convert(&CalendarConvertRequest::default()).is_err());
        let feb30: CalendarConvertRequest = serde_json::from_str(
            r#"{"civil": {"calendar": "gregorian", "year": 1500, "month": 2, "day": 29}}"#,
        )
        .unwrap();
        assert!(calendar_convert(&feb30).is_err());
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["julian"]["calendar"], "julian");
        assert_eq!(json["julian"]["era"], "BC");
    }
}
