//! Increments and Corrections (the Nautical Almanac's tinted pages ii–xxxi).
//!
//! The daily pages give GHA at each whole hour. For the minutes and seconds after the
//! hour the navigator adds an **increment** at the rate the table assumes and then a
//! **v correction** for the body's actual rate; the declination changes by a **d
//! correction**. One table per minute of time (0 to 59), with a row for each second
//! (00 to 60):
//!
//! - **Sun and planets**: 15° an hour (the mean Sun).
//! - **Aries**: the sidereal rate, 360.985 647 366 29° a UT day (15° 02.464′ an hour),
//!   the rate of Greenwich sidereal time.
//! - **Moon**: 14° 19.0′ an hour, the Moon's slowest; its `v` is therefore never
//!   negative.
//! - **v or d corrections**: `v × (m + 0.5) / 60` for `v` (or `d`) from 0.0′ to 18.0′,
//!   computed for the **middle of the minute** `m`, as the printed tables compute them,
//!   so that the error for any second of the minute is at most half a minute's worth.
//!
//! Every value is rounded to 0.1′, exact halves up, in integer arithmetic (the Sun's
//! increments are exact multiples of 0.25′, so halves occur every other second).

use serde::{Deserialize, Serialize};

use super::{ArcminCell, BANNER, fmt_deg_min_tenths, fmt_tenths};

/// Degrees an hour the Sun and planets columns assume.
pub const SUN_PLANETS_DEG_PER_HOUR: f64 = 15.0;
/// Degrees an hour the Moon column assumes: 14° 19.0′.
pub const MOON_DEG_PER_HOUR: f64 = 14.0 + 19.0 / 60.0;
/// Degrees a UT day of Greenwich sidereal time (IAU 1982 / Meeus 12.4).
pub const ARIES_DEG_PER_DAY: f64 = 360.985_647_366_29;
/// Degrees an hour the Aries column assumes.
pub const ARIES_DEG_PER_HOUR: f64 = ARIES_DEG_PER_DAY / 24.0;
/// The largest `v` or `d` the corrections run to, arcminutes (the Moon's `d` reaches
/// about 17.5′ an hour, its `v` about 16.5′).
pub const MAX_V_OR_D_ARCMIN: f64 = 18.0;

/// One second of the minute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncrementRow {
    /// 0 to 60.
    pub second: u32,
    /// `0 15.0`.
    pub sun_planets: ArcminCell,
    pub aries: ArcminCell,
    pub moon: ArcminCell,
}

/// One `v or d` value and its correction for the minute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VdCorrection {
    /// 0.0 to 18.0 arcminutes an hour.
    pub v_arcmin: f64,
    /// `6.0`.
    pub v_printed: String,
    /// `v × (m + 0.5) / 60`, and its printed value (`0.3`).
    pub correction: ArcminCell,
}

/// The table for one minute of time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncrementsMinute {
    /// 0 to 59.
    pub minute: u32,
    /// 61 rows, seconds 00 to 60 (the 60 row is the next minute's 00).
    pub rows: Vec<IncrementRow>,
    /// 181 values of `v or d`, 0.0 to 18.0; the printed page lays them in three columns
    /// of 61 (0.0–6.0, 6.0–12.0, 12.0–18.0), repeating 6.0 and 12.0.
    pub corrections: Vec<VdCorrection>,
    pub how_to_use: String,
    pub example: String,
    pub notes: Vec<String>,
}

/// Increment of the Sun and planets for `seconds` after the hour, in tenths of an
/// arcminute, rounded half up: `15′ × seconds / 60` exactly.
pub fn sun_planets_tenths(seconds: u32) -> i64 {
    // 15' per minute = 0.25' per second = 2.5 tenths per second: (10 s) / 4 tenths.
    (i64::from(seconds) * 10 + 2) / 4
}

/// Increment of the Moon, tenths of an arcminute: `859′ × seconds / 3600` rounded half up.
pub fn moon_tenths(seconds: u32) -> i64 {
    // tenths = 8590 s / 3600 = 859 s / 360; half up: floor((2 * 859 s + 360) / 720).
    (2 * 859 * i64::from(seconds) + 360) / 720
}

/// Increment of Aries, tenths of an arcminute (the sidereal rate is not a simple
/// fraction; no second lands within 1e-6 of a half, so floating point decides nothing).
pub fn aries_tenths(seconds: u32) -> i64 {
    let arcmin = ARIES_DEG_PER_HOUR * 60.0 * f64::from(seconds) / 3600.0;
    (arcmin * 10.0 + 0.5).floor() as i64
}

/// The exact increment of each column for `seconds` after the hour, arcminutes.
pub fn increment_arcmin(seconds: f64) -> (f64, f64, f64) {
    (
        SUN_PLANETS_DEG_PER_HOUR * seconds / 60.0,
        ARIES_DEG_PER_HOUR * seconds / 60.0,
        MOON_DEG_PER_HOUR * seconds / 60.0,
    )
}

/// The `v or d` correction for minute `minute` of `v_tenths` tenths of an arcminute an
/// hour, in tenths, rounded half up: `v (m + 0.5) / 60` = `v (2m + 1) / 120`.
pub fn v_or_d_tenths(v_tenths: i64, minute: u32) -> i64 {
    let num = v_tenths * (2 * i64::from(minute) + 1);
    (num + 60).div_euclid(120)
}

/// The Increments and Corrections table for one minute of time, 0 to 59.
pub fn increments(minute: u32) -> Result<IncrementsMinute, String> {
    if minute > 59 {
        return Err(format!(
            "the increments tables run from minute 0 to 59, not {minute}"
        ));
    }
    let rows = (0..=60)
        .map(|s| {
            let seconds = 60 * minute + s;
            let (sun, aries, moon) = increment_arcmin(f64::from(seconds));
            IncrementRow {
                second: s,
                sun_planets: ArcminCell {
                    arcmin: sun,
                    printed: fmt_deg_min_tenths(sun_planets_tenths(seconds)),
                },
                aries: ArcminCell {
                    arcmin: aries,
                    printed: fmt_deg_min_tenths(aries_tenths(seconds)),
                },
                moon: ArcminCell {
                    arcmin: moon,
                    printed: fmt_deg_min_tenths(moon_tenths(seconds)),
                },
            }
        })
        .collect();
    let max_tenths = (MAX_V_OR_D_ARCMIN * 10.0).round() as i64;
    let corrections = (0..=max_tenths)
        .map(|v| {
            let exact = v as f64 / 10.0 * (f64::from(minute) + 0.5) / 60.0;
            VdCorrection {
                v_arcmin: v as f64 / 10.0,
                v_printed: fmt_tenths(v),
                correction: ArcminCell {
                    arcmin: exact,
                    printed: fmt_tenths(v_or_d_tenths(v, minute)),
                },
            }
        })
        .collect();
    Ok(IncrementsMinute {
        minute,
        rows,
        corrections,
        how_to_use: "Take GHA for the whole hour before the time from the daily page. On the \
                     page for the minutes, on the line for the seconds, read the increment \
                     for the body (Aries for a star) and add it. Then, on the same page, \
                     find the correction beside the body's v and add it (subtract it when v \
                     is printed with a minus sign, Venus only), and the correction beside d, \
                     added to or subtracted from the declination as the declination column \
                     is going."
            .to_string(),
        example: "Deneb at 08h 58m 27s UT, 9 March 2016 (Bowditch §1906): GHA Aries at 08h \
                  287° 26.6′; the 58-minute page, 27-second line, Aries column gives \
                  14° 39.2′; with Deneb's SHA 49° 30.5′ its GHA is 351° 36.3′."
            .to_string(),
        notes: vec![
            "Sun and planets: 15° an hour. Aries: 15° 02.464′ an hour. Moon: 14° 19.0′ an hour. \
             v or d corrections are for the middle of the minute: v × (m + 0.5) / 60."
                .to_string(),
            "Rounded to 0.1′, exact halves up.".to_string(),
            BANNER.to_string(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked examples of Bowditch (2019) ch. 19 and the Nautical Almanac's own
    /// Polaris illustration, all from the printed tables.
    #[test]
    fn the_published_increments_and_corrections() {
        let at = |m: u32, s: u32| {
            let t = increments(m).unwrap();
            t.rows[s as usize].clone()
        };
        assert_eq!(at(58, 27).aries.printed, "14 39.2"); // §1906 Deneb
        assert_eq!(at(0, 24).sun_planets.printed, "0 06.0"); // §1907 Sun
        assert_eq!(at(1, 4).moon.printed, "0 15.3"); // §1908 Moon
        assert_eq!(at(58, 34).sun_planets.printed, "14 38.5"); // §1909 Mars
        assert_eq!(at(18, 56).aries.printed, "4 44.8"); // §1912 and the illustration
        let corr = |m: u32, v: f64| {
            let t = increments(m).unwrap();
            t.corrections[(v * 10.0).round() as usize]
                .correction
                .printed
                .clone()
        };
        assert_eq!(corr(1, 15.0), "0.4"); // Moon v
        assert_eq!(corr(1, 9.4), "0.2"); // Moon d
        assert_eq!(corr(58, 1.5), "1.5"); // Mars v
        assert_eq!(corr(58, 0.2), "0.2"); // Mars d
        assert_eq!(corr(8, 1.0), "0.1"); // §1910 Sun d
        assert_eq!(corr(0, 1.0), "0.0"); // §1907 Sun d
    }

    #[test]
    fn halves_round_up_and_the_sixty_row_is_the_next_minute() {
        let t = increments(0).unwrap();
        assert_eq!(t.rows.len(), 61);
        assert_eq!(t.corrections.len(), 181);
        assert_eq!(t.rows[1].sun_planets.printed, "0 00.3");
        assert_eq!(t.rows[3].sun_planets.printed, "0 00.8");
        assert_eq!(t.rows[57].sun_planets.printed, "0 14.3");
        assert_eq!(t.rows[60].sun_planets.printed, "0 15.0");
        assert_eq!(t.rows[60].moon.printed, "0 14.3");
        let next = increments(1).unwrap();
        assert_eq!(t.rows[60].aries.printed, next.rows[0].aries.printed);
        assert_eq!(
            increments(59).unwrap().rows[60].sun_planets.printed,
            "15 00.0"
        );
        assert!(increments(60).is_err());
        // Every printed value is its exact value rounded: never more than 0.05' away.
        for m in 0..60 {
            let t = increments(m).unwrap();
            for r in &t.rows {
                for c in [&r.sun_planets, &r.aries, &r.moon] {
                    let p: Vec<f64> = c.printed.split(' ').map(|x| x.parse().unwrap()).collect();
                    let printed = p[0] * 60.0 + p[1];
                    assert!((printed - c.arcmin).abs() <= 0.05 + 1e-9, "{m}m {r:?}");
                }
            }
            for c in &t.corrections {
                let printed: f64 = c.correction.printed.parse().unwrap();
                assert!((printed - c.correction.arcmin).abs() <= 0.05 + 1e-9);
            }
        }
    }
}
