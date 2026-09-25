//! Three-day openings: the two facing daily pages of the printed Nautical Almanac, which
//! cover three UT dates, built from [`crate::pages`]' one-date pages.
//!
//! OWNER: almanac2 agent (expansion programme Q7; the "three-day extension" of the daily
//! pages). Definitions: CONVENTIONS 13.12; wire format: EXPLORER_API.md "Expansion
//! programme — almanac tables and three-day pages".
//!
//! # Which three dates
//!
//! The printed almanac groups the year in threes from January 1: January 1–3, 4–6, …; a
//! common year's last opening is December 30, 31 and January 1 of the next year, a leap
//! year's December 29–31. The grouping is by the day of the year in the calendar the
//! dates are shown in ([`Calendar`]): Julian before 1582-10-15 and Gregorian from then
//! (`auto`), or either one named. In 1582 the days are counted from Julian January 1
//! straight across the reform (October 4 is followed by October 15).
//!
//! # What the opening holds, as the printed pages give it
//!
//! - Every hour of the three dates: the three daily pages' rows, unchanged.
//! - **Once per opening, for the middle date**: the stars' SHA and Dec, the planets'
//!   magnitudes, v, d and meridian passages, Aries' meridian passage, the Sun's SD and
//!   d, and the twilight, sunrise and sunset table (the middle page's own values).
//! - **The planets' SHA at 0h UT of the middle date**, as the printed pages give it (the
//!   one-date page gives it at 12h; `planet_sha_00h`).
//! - **For each date**: the Moon's SD, the equation of time, the meridian passages, the
//!   Moon's age and phase.
//! - **Moonrise and moonset** for the three dates and the next: each date's own page's
//!   first column, and the last page's second.

use serde::{Deserialize, Serialize};
use skyfix_core::calendar::{self, Calendar, Era, civil_from_jdn, jdn_from_civil};
use skyfix_core::units::norm_360;
use skyfix_ephemeris::body::BodyEphemeris;

use crate::pages::{
    self, AlmanacDay, GhaText, TableTime, UtDate, almanac_day_for, fmt_angle, from_jd,
};
use crate::sky::{AlmanacError, BodyError};

/// One date of the opening, in the calendar the opening is shown in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpeningDay {
    /// The wire date (proleptic Gregorian, `YYYY-MM-DD` or expanded).
    pub date: String,
    pub calendar: Calendar,
    /// Astronomical year in `calendar`.
    pub year: i64,
    pub month: u32,
    pub day: u32,
    /// The year as people write it, with `era`: 585 BC is `era_year` 585, `year` -584.
    pub era_year: i64,
    pub era: Era,
    pub weekday: String,
}

/// Moonrise and moonset at one latitude for the four dates of the opening.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpeningMoonRow {
    pub lat_deg: f64,
    pub label: String,
    pub moonrise: Vec<TableTime>,
    pub moonset: Vec<TableTime>,
}

/// A planet's SHA at 0h UT of the middle date.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanetSha {
    pub body: String,
    pub sha_deg: f64,
    pub printed: GhaText,
}

/// The two facing pages for three dates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlmanacOpening {
    /// The date asked for (wire).
    pub date: String,
    /// The calendar the grouping and the dates below use.
    pub calendar: Calendar,
    /// Which of the three is the date asked for (0, 1 or 2).
    pub index: usize,
    pub dates: Vec<OpeningDay>,
    /// The three daily pages. Once-per-opening values: `days[1]` (module docs).
    pub days: Vec<AlmanacDay>,
    /// The four dates of the moonrise and moonset columns (wire).
    pub moon_dates: Vec<String>,
    /// 31 latitudes, 72 N to 60 S.
    pub moon_rows: Vec<OpeningMoonRow>,
    /// Venus, Mars, Jupiter and Saturn (those computed), at 0h UT of the middle date.
    pub planet_sha_00h: Vec<PlanetSha>,
    pub notes: Vec<String>,
    pub errors: Vec<BodyError>,
}

/// What the opening prints under its tables, after the daily pages' own notes.
pub const OPENING_NOTES: [&str; 2] = [
    "Three dates per opening, grouped from January 1 as the printed almanac groups them. \
     Stars, the planets' magnitudes, v, d and meridian passages, Aries' meridian passage, \
     the Sun's SD and d, and the twilight, sunrise and sunset table are for the middle date; \
     the planets' SHA for 0h UT of the middle date; moonrise and moonset for the three \
     dates and the next.",
    "Before 1767 there was no Nautical Almanac: an opening for an earlier date is what its \
     tables would have said, in its format, from today's ephemeris.",
];

/// The calendar in force on a Julian day number: Julian before 1582-10-15.
pub fn auto_calendar(jdn: i64) -> Calendar {
    calendar::calendar_for_jdn(jdn)
}

/// The Julian day numbers of the three dates of the opening that contains the day `jdn`,
/// and the day's index in it, grouping by the day of the year in `cal` (`None`: auto).
pub fn opening_jdns(jdn: i64, cal: Option<Calendar>) -> ([i64; 3], usize) {
    let shown = cal.unwrap_or_else(|| auto_calendar(jdn));
    let (year, _, _) = civil_from_jdn(shown, jdn);
    // Auto: January 1 in the calendar in force then (Julian up to 1582, so 1582 is
    // counted across the reform).
    let year_start_cal = match cal {
        Some(c) => c,
        None if year <= 1582 => Calendar::Julian,
        None => Calendar::Gregorian,
    };
    let start = jdn_from_civil(year_start_cal, year, 1, 1);
    let index = (jdn - start).rem_euclid(3) as usize;
    let first = jdn - index as i64;
    ([first, first + 1, first + 2], index)
}

fn opening_day(jdn: i64, cal: Option<Calendar>) -> OpeningDay {
    let shown = cal.unwrap_or_else(|| auto_calendar(jdn));
    let (year, month, day) = civil_from_jdn(shown, jdn);
    let (era_year, era) = calendar::era_of(year);
    let ut = from_jd(jdn as f64 - 0.5);
    OpeningDay {
        date: ut.to_string(),
        calendar: shown,
        year,
        month,
        day,
        era_year,
        era,
        weekday: ut.weekday().to_string(),
    }
}

/// The opening (three dates, two facing pages) that contains the UT date `date`
/// (`YYYY-MM-DD`, proleptic Gregorian, expanded years allowed), grouped in `cal`
/// (`None`: Julian before 1582-10-15, Gregorian after).
pub fn almanac_opening(
    eph: &dyn BodyEphemeris,
    date: &str,
    cal: Option<Calendar>,
) -> Result<AlmanacOpening, AlmanacError> {
    let asked = UtDate::parse(date)?;
    let jdn = (asked.jd_utc() + 0.5).floor() as i64;
    let (jdns, index) = opening_jdns(jdn, cal);
    let shown = cal.unwrap_or_else(|| auto_calendar(jdn));
    let mut days = Vec::with_capacity(3);
    for &j in &jdns {
        days.push(almanac_day_for(eph, from_jd(j as f64 - 0.5))?);
    }
    let last = &days[2];
    let moon_dates = vec![
        days[0].date.clone(),
        days[1].date.clone(),
        days[2].date.clone(),
        last.rise_set.moon_dates.get(1).cloned().unwrap_or_default(),
    ];
    let moon_rows = days[1]
        .rise_set
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let cell = |d: usize, k: usize, rise: bool| -> TableTime {
                let r = &days[d].rise_set.rows[i];
                let list = if rise { &r.moonrise } else { &r.moonset };
                list[k].clone()
            };
            OpeningMoonRow {
                lat_deg: row.lat_deg,
                label: row.label.clone(),
                moonrise: vec![
                    cell(0, 0, true),
                    cell(1, 0, true),
                    cell(2, 0, true),
                    cell(2, 1, true),
                ],
                moonset: vec![
                    cell(0, 0, false),
                    cell(1, 0, false),
                    cell(2, 0, false),
                    cell(2, 1, false),
                ],
            }
        })
        .collect();
    let middle = &days[1];
    let planet_sha_00h = middle.hours[0]
        .planets
        .iter()
        .map(|p| {
            let sha = norm_360(p.gha_deg - middle.hours[0].aries.gha_deg);
            PlanetSha {
                body: p.body.clone(),
                sha_deg: sha,
                printed: GhaText {
                    gha: fmt_angle(sha),
                },
            }
        })
        .collect();
    let mut errors: Vec<BodyError> = Vec::new();
    for d in &days {
        for e in &d.errors {
            if !errors.contains(e) {
                errors.push(e.clone());
            }
        }
    }
    let mut notes: Vec<String> = pages::NOTES.iter().map(|s| (*s).to_string()).collect();
    // The daily pages end with the honesty line; the opening's own notes go before it.
    let banner = notes.pop();
    notes.extend(OPENING_NOTES.iter().map(|s| (*s).to_string()));
    notes.extend(banner);
    Ok(AlmanacOpening {
        date: asked.to_string(),
        calendar: shown,
        index,
        dates: jdns.iter().map(|&j| opening_day(j, cal)).collect(),
        days,
        moon_dates,
        moon_rows,
        planet_sha_00h,
        notes,
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_ephemeris::body::Sky;

    fn jdn_of(cal: Calendar, y: i64, m: u32, d: u32) -> i64 {
        jdn_from_civil(cal, y, m, d)
    }

    fn triple(cal: Option<Calendar>, c: Calendar, y: i64, m: u32, d: u32) -> [(i64, u32, u32); 3] {
        let (j, _) = opening_jdns(jdn_of(c, y, m, d), cal);
        j.map(|x| civil_from_jdn(c, x))
    }

    #[test]
    fn openings_group_the_year_in_threes_from_january_1() {
        let g = Calendar::Gregorian;
        // Bowditch figures 1906b and 1908a: March 7-9 and March 22-24, 2016.
        assert_eq!(
            triple(None, g, 2016, 3, 8),
            [(2016, 3, 7), (2016, 3, 8), (2016, 3, 9)]
        );
        assert_eq!(triple(None, g, 2016, 3, 24)[0], (2016, 3, 22));
        // A common year ends with December 30, 31 and January 1.
        assert_eq!(
            triple(None, g, 2023, 12, 31),
            [(2023, 12, 30), (2023, 12, 31), (2024, 1, 1)]
        );
        // The next year's January 1 starts its own opening.
        assert_eq!(triple(None, g, 2024, 1, 1)[0], (2024, 1, 1));
        // A leap year ends with December 29-31.
        assert_eq!(triple(None, g, 2024, 12, 31)[0], (2024, 12, 29));
        // Julian dates before the reform group by the Julian day of the year.
        let j = Calendar::Julian;
        assert_eq!(triple(None, j, 1500, 3, 10)[0], (1500, 3, 10));
        assert_eq!(triple(Some(g), g, 1500, 3, 19)[0], (1500, 3, 17));
        // 1582 is counted from Julian January 1 across the reform: October 4 (Julian) is
        // day 277 = 3 x 92 + 1, which starts an opening, and October 15 (Gregorian) is
        // day 278, the opening's second date.
        let (reform, idx) = opening_jdns(jdn_of(g, 1582, 10, 15), None);
        assert_eq!(civil_from_jdn(j, reform[0]), (1582, 10, 4));
        assert_eq!(civil_from_jdn(g, reform[2]), (1582, 10, 16));
        assert_eq!(idx, 1);
        // 585 BC (astronomical -584).
        let (bc, _) = opening_jdns(jdn_of(j, -584, 5, 28), None);
        assert_eq!(civil_from_jdn(j, bc[0]).0, -584);
    }

    #[test]
    fn dates_parse_in_any_year() {
        let d = UtDate::parse("-0584-05-22").unwrap();
        assert_eq!((d.year, d.month, d.day), (-584, 5, 22));
        assert_eq!(d.to_string(), "-0584-05-22");
        assert_eq!(
            UtDate::parse("+12345-01-01").unwrap().to_string(),
            "+12345-01-01"
        );
        assert_eq!(
            UtDate::parse("0000-02-29").unwrap().to_string(),
            "0000-02-29"
        );
        assert!(UtDate::parse("12345-01-01").is_err());
        assert!(UtDate::parse("-584-05-22").is_err());
        assert!(UtDate::parse("-0584-02-30").is_err());
        let e = UtDate::parse("24/09/2026").unwrap_err().to_string();
        assert!(e.contains("YYYY-MM-DD"), "{e}");
        let e = UtDate::parse("2026-02-30").unwrap_err().to_string();
        assert!(e.contains("not a calendar date"), "{e}");
        // 28 May 585 BC (Julian) is -0584-05-22 Gregorian, JD 1507899.5 (Meeus 7.1 in
        // either calendar): (JD + 1.5) mod 7 = 3, a Wednesday.
        assert_eq!(UtDate::parse("-0584-05-22").unwrap().jd_utc(), 1_507_899.5);
        assert_eq!(UtDate::parse("-0584-05-22").unwrap().weekday(), "Wednesday");
    }

    #[test]
    fn an_opening_is_three_daily_pages_and_their_moon_columns() {
        let o = almanac_opening(&Sky::new(), "2016-03-08", None).unwrap();
        assert_eq!(o.index, 1);
        let dates: Vec<&str> = o.dates.iter().map(|d| d.date.as_str()).collect();
        assert_eq!(dates, ["2016-03-07", "2016-03-08", "2016-03-09"]);
        assert_eq!(o.dates[0].weekday, "Monday");
        assert_eq!(o.days.len(), 3);
        assert_eq!(
            o.moon_dates,
            ["2016-03-07", "2016-03-08", "2016-03-09", "2016-03-10"]
        );
        assert_eq!(o.moon_rows.len(), 31);
        for (i, row) in o.moon_rows.iter().enumerate() {
            assert_eq!(row.moonrise.len(), 4);
            assert_eq!(row.moonrise[1], o.days[1].rise_set.rows[i].moonrise[0]);
            assert_eq!(row.moonset[3], o.days[2].rise_set.rows[i].moonset[1]);
        }
        assert_eq!(o.planet_sha_00h.len(), 4);
        // Bowditch figure 1906b / 1906: GHA Aries at 08h on 9 March 2016 is 287° 26.6′.
        assert_eq!(o.days[2].hours[8].aries.printed.gha, "287 26.6");
        assert!(o.errors.is_empty(), "{:?}", o.errors);
        assert!(
            o.notes
                .last()
                .unwrap()
                .contains("Not a navigation instrument")
        );
    }
}
