//! The additional altitude corrections for Venus and Mars, for one calendar year.
//!
//! A planet is observed at its centre of light, so its correction beyond the stars' is
//! its parallax in altitude, `HP cos Ha` (CONVENTIONS 5 step 5; Venus's phase is carried
//! in its tabulated position). Venus's horizontal parallax runs from 0.08′ to 0.55′ and
//! Mars's from 0.06′ to 0.43′ as their distances change, so the printed table gives the
//! correction for date ranges. Here a range is a run of days on which the planet's
//! parallax at 0h UT rounds to the same 0.1′, and its corrections are that rounded
//! parallax times `cos Ha`, as a critical table in whole degrees of apparent altitude.
//! (For Jupiter and Saturn the parallax is under 0.04′ and there is no table.)

use serde::{Deserialize, Serialize};
use skyfix_core::calendar::{Calendar, civil_from_jdn, jdn_from_civil};
use skyfix_core::corrections::rigorous_parallax_in_altitude_arcmin;
use skyfix_ephemeris::body::BodyEphemeris;

use super::{
    ArcminCell, BANNER, CriticalArgument, CriticalTable, critical_on_grid, tenths_half_up,
};
use crate::sky::{AlmanacError, BodyError};

/// A calendar day, in the table's calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CivilDay {
    /// Astronomical year.
    pub year: i64,
    pub month: u32,
    pub day: u32,
}

/// A run of days with one set of corrections.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParallaxPeriod {
    pub from: CivilDay,
    pub to: CivilDay,
    /// 0h UT of the first and of the last day.
    pub from_jd_utc: f64,
    pub to_jd_utc: f64,
    /// The horizontal parallax the corrections use, to 0.1′.
    pub hp_arcmin: f64,
    /// Argument apparent altitude in whole degrees, 0° to 90°.
    pub table: CriticalTable,
}

/// Venus and Mars for a year.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanetCorrections {
    pub year: i64,
    pub calendar: Calendar,
    pub venus: Vec<ParallaxPeriod>,
    pub mars: Vec<ParallaxPeriod>,
    pub how_to_use: String,
    pub notes: Vec<String>,
    /// Days that could not be computed (outside the ephemeris coverage), by planet.
    pub errors: Vec<BodyError>,
}

/// 0h UT (JD) of a civil date in `calendar`.
pub fn jd_of(calendar: Calendar, year: i64, month: u32, day: u32) -> f64 {
    jdn_from_civil(calendar, year, month, day) as f64 - 0.5
}

/// The civil day containing 0h UT `jd` in `calendar`.
pub fn civil_day(calendar: Calendar, jd: f64) -> CivilDay {
    let (year, month, day) = civil_from_jdn(calendar, (jd + 0.5).floor() as i64);
    CivilDay { year, month, day }
}

/// The critical table of `hp cos Ha` over whole degrees 0° to 90°.
fn parallax_table(hp_arcmin: f64) -> CriticalTable {
    let (bounds, values) = critical_on_grid(0, 90, 0, |deg| {
        vec![tenths_half_up(rigorous_parallax_in_altitude_arcmin(
            hp_arcmin, deg as f64,
        ))]
    });
    CriticalTable {
        argument: "apparent altitude".to_string(),
        unit: "deg".to_string(),
        columns: vec!["Corr".to_string()],
        boundaries: bounds
            .iter()
            .map(|&d| CriticalArgument {
                value: d as f64,
                printed: d.to_string(),
            })
            .collect(),
        values: values
            .iter()
            .map(|row| row.iter().map(|&t| ArcminCell::signed_tenths(t)).collect())
            .collect(),
    }
}

fn periods(
    eph: &dyn BodyEphemeris,
    body: &str,
    calendar: Calendar,
    start: f64,
    days: i64,
    errors: &mut Vec<BodyError>,
) -> Vec<ParallaxPeriod> {
    let mut out: Vec<ParallaxPeriod> = Vec::new();
    let mut run: Option<(f64, f64, i64)> = None; // (first day jd, last day jd, hp tenths)
    let flush = |run: Option<(f64, f64, i64)>, out: &mut Vec<ParallaxPeriod>| {
        if let Some((a, b, t)) = run {
            let hp = t as f64 / 10.0;
            out.push(ParallaxPeriod {
                from: civil_day(calendar, a),
                to: civil_day(calendar, b),
                from_jd_utc: a,
                to_jd_utc: b,
                hp_arcmin: hp,
                table: parallax_table(hp),
            });
        }
    };
    for k in 0..days {
        let jd = start + k as f64;
        let hp = match eph.apparent_state(body, jd) {
            Ok(st) => st.horizontal_parallax_arcmin,
            Err(e) => {
                errors.push(BodyError {
                    body: body.to_string(),
                    message: format!("from {:?}: {e}", civil_day(calendar, jd)),
                });
                break;
            }
        };
        let t = tenths_half_up(hp);
        run = match run {
            Some((a, _, rt)) if rt == t => Some((a, jd, rt)),
            other => {
                flush(other, &mut out);
                Some((jd, jd, t))
            }
        };
    }
    flush(run, &mut out);
    out
}

/// The Venus and Mars corrections for `year` in `calendar`.
pub fn planet_corrections(
    eph: &dyn BodyEphemeris,
    year: i64,
    calendar: Calendar,
) -> Result<PlanetCorrections, AlmanacError> {
    if !(-100_000..=100_000).contains(&year) {
        return Err(AlmanacError::Invalid(format!(
            "year {year} is out of range"
        )));
    }
    let start = jd_of(calendar, year, 1, 1);
    let end = jd_of(calendar, year + 1, 1, 1);
    let days = (end - start).round() as i64;
    let mut errors = Vec::new();
    let venus = periods(eph, "Venus", calendar, start, days, &mut errors);
    let mars = periods(eph, "Mars", calendar, start, days, &mut errors);
    Ok(PlanetCorrections {
        year,
        calendar,
        venus,
        mars,
        how_to_use: "Find the date range of the sight under the planet, and in it the \
                     correction for the apparent altitude (between the two altitudes either \
                     side of it). Add it, as well as the stars and planets correction."
            .to_string(),
        notes: vec![
            "The planet's parallax in altitude, HP cos Ha, with HP at 0h UT rounded to 0.1′ \
             over each date range. Venus's phase is in its tabulated position. Jupiter and \
             Saturn: under 0.04′, no correction."
                .to_string(),
            BANNER.to_string(),
        ],
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_ephemeris::body::Sky;

    /// Bowditch (2019 ch. 19; 2024 vol. 2 ch. 6), from the printed tables.
    #[test]
    fn the_published_additional_corrections() {
        let eph = Sky::new();
        let find = |pc: &PlanetCorrections, venus: bool, m: u32, d: u32, ha: f64| {
            let jd = jd_of(Calendar::Gregorian, pc.year, m, d);
            let list = if venus { &pc.venus } else { &pc.mars };
            let p = list
                .iter()
                .find(|p| p.from_jd_utc <= jd && jd <= p.to_jd_utc)
                .expect("a period");
            p.table.lookup(ha).unwrap()[0].printed.clone()
        };
        let y2016 = planet_corrections(&eph, 2016, Calendar::Gregorian).unwrap();
        assert!(y2016.errors.is_empty(), "{:?}", y2016.errors);
        assert_eq!(find(&y2016, false, 3, 9, 29.0 + 35.2 / 60.0), "+0.1");
        let y2024 = planet_corrections(&eph, 2024, Calendar::Gregorian).unwrap();
        assert_eq!(find(&y2024, true, 12, 19, 44.0 + 16.2 / 60.0), "+0.1");
        assert_eq!(find(&y2024, false, 11, 28, 4.0 + 2.1 / 60.0), "+0.2");
        assert_eq!(find(&y2024, false, 6, 18, 34.0 + 6.4 / 60.0), "+0.1");
        // The ranges tile the year without gaps.
        for list in [&y2024.venus, &y2024.mars] {
            assert_eq!(
                list[0].from,
                CivilDay {
                    year: 2024,
                    month: 1,
                    day: 1
                }
            );
            assert_eq!(
                list.last().unwrap().to,
                CivilDay {
                    year: 2024,
                    month: 12,
                    day: 31
                }
            );
            for w in list.windows(2) {
                assert!((w[1].from_jd_utc - w[0].to_jd_utc - 1.0).abs() < 1e-9);
                assert_ne!(w[0].hp_arcmin, w[1].hp_arcmin);
            }
        }
    }
}
