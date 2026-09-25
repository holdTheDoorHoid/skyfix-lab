//! The equation of time through a year (CONVENTIONS 13.9 and 13.10).
//!
//! Apparent minus mean solar time, seconds: how far a sundial runs ahead of (positive) or
//! behind (negative) a clock keeping local mean time. The definition is the almanac
//! page's (CONVENTIONS 13.9), `EoT = (GHA_Sun - 15° (UT - 12 h)) / (15°/h)`, with UT = UTC
//! (DUT1 = 0, CONVENTIONS 6) and the Sun's apparent geocentric GHA from the Sun provider,
//! so this series and the page's `eot_12h` are the same number. It is the same for every
//! observer; only the instant it is evaluated at matters (it changes by up to 30 s a day
//! in December).
//!
//! Meeus's route (*Astronomical Algorithms*, 2nd ed., eq. 28.1, from the Sun's mean
//! longitude; `skyfix_ephemeris::sun::equation_of_time_min`) defines the mean sun slightly
//! differently: it runs 0.21 s ahead of this one, steadily. Both are checked in
//! `tests/sun_tools_reference.rs`: this series against Meeus's example 28.a and against
//! Skyfield + JPL DE440s (fixture `sun_tools_skyfield.json`).

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::{ApparentState, BodyEphemeris, SUN};

use super::{check_year, local_date};
use crate::sky::{AlmanacError, BodyError};

/// The equation of time at the Sun's state, seconds: `(GHA - 15° (UT - 12 h)) / 15°/h`,
/// UT taken from the state's own `jd_utc` (CONVENTIONS 13.9).
pub fn equation_of_time_s(sun: &ApparentState) -> f64 {
    equation_of_time_at(sun.jd_utc, sun.gha_deg)
}

/// The same from an instant and the Sun's apparent GHA at it (degrees).
pub fn equation_of_time_at(jd_utc: f64, sun_gha_deg: f64) -> f64 {
    let day0 = (jd_utc - 0.5).floor() + 0.5;
    let ut_hours = (jd_utc - day0) * 24.0;
    norm_180(sun_gha_deg - 15.0 * (ut_hours - 12.0)) * 240.0
}

/// One day of the series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EotPoint {
    /// The UTC date, `YYYY-MM-DD`.
    pub date: String,
    pub jd_utc: f64,
    pub utc: String,
    /// Apparent minus mean solar time, seconds (positive: the sundial is fast).
    pub eot_s: f64,
    /// The Sun's apparent geocentric declination, degrees.
    pub dec_deg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtremeKind {
    Minimum,
    Maximum,
}

/// A turning point of the daily series (to the day: the day of the largest or smallest
/// value, not an interpolated instant).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EotExtreme {
    pub kind: ExtremeKind,
    pub date: String,
    pub jd_utc: f64,
    pub eot_s: f64,
}

/// `equation_of_time` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EquationOfTime {
    pub year: i32,
    /// Each day is evaluated at this UTC hour.
    pub utc_hour: f64,
    pub points: Vec<EotPoint>,
    /// The year's minima and maxima (about 11 February, 14 May, 26 July, 3 November).
    pub extremes: Vec<EotExtreme>,
    /// Days the Sun could not be computed on (outside the coverage), with the reason.
    pub errors: Vec<BodyError>,
}

/// The equation of time and the Sun's declination on every UTC date of `year`, at
/// `utc_hour` (EXPLORER_API.md `equation_of_time`). Days outside the Sun's coverage are
/// left out and counted in `errors`; a year with no day inside fails.
pub fn equation_of_time(
    eph: &dyn BodyEphemeris,
    year: i32,
    utc_hour: f64,
) -> Result<EquationOfTime, AlmanacError> {
    check_year(year)?;
    if !(utc_hour.is_finite() && (0.0..24.0).contains(&utc_hour)) {
        return Err(AlmanacError::invalid(format!(
            "utc_hour must be in [0, 24), got {utc_hour}"
        )));
    }
    let d0 = civil_to_jd(year, 1, 1);
    let days = (civil_to_jd(year + 1, 1, 1) - d0).round() as usize;
    let mut points = Vec::with_capacity(days);
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    for k in 0..days {
        let jd = d0 + k as f64 + utc_hour / 24.0;
        match eph.apparent_state(SUN, jd) {
            Ok(sun) => points.push(EotPoint {
                date: local_date(d0 + k as f64 + 0.5, 0.0),
                jd_utc: jd,
                utc: format_utc(jd),
                eot_s: equation_of_time_s(&sun),
                dec_deg: sun.dec_deg,
            }),
            Err(e) => {
                failed += 1;
                first_error.get_or_insert_with(|| e.to_string());
            }
        }
    }
    let errors = first_error
        .map(|m| {
            vec![BodyError {
                body: SUN.to_string(),
                message: format!("{failed} of {days} days left out: {m}"),
            }]
        })
        .unwrap_or_default();
    if points.is_empty() {
        return Err(AlmanacError::Unavailable {
            body: SUN.to_string(),
            message: errors
                .first()
                .map_or("no day could be computed".to_string(), |e| {
                    e.message.clone()
                }),
        });
    }
    let extremes = extremes(&points);
    Ok(EquationOfTime {
        year,
        utc_hour,
        points,
        extremes,
        errors,
    })
}

/// Interior local minima and maxima of the daily series.
fn extremes(points: &[EotPoint]) -> Vec<EotExtreme> {
    let mut out = Vec::new();
    for w in points.windows(3) {
        let (a, b, c) = (w[0].eot_s, w[1].eot_s, w[2].eot_s);
        let kind = if b > a && b >= c {
            ExtremeKind::Maximum
        } else if b < a && b <= c {
            ExtremeKind::Minimum
        } else {
            continue;
        };
        out.push(EotExtreme {
            kind,
            date: w[1].date.clone(),
            jd_utc: w[1].jd_utc,
            eot_s: b,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_ephemeris::body::BodyKind;

    fn sun_at(jd_utc: f64, gha_deg: f64) -> ApparentState {
        ApparentState {
            body: "Sun".into(),
            kind: BodyKind::Sun,
            jd_utc,
            ra_deg: 0.0,
            dec_deg: 0.0,
            gha_deg,
            distance_km: Some(1.496e8),
            semidiameter_arcmin: 16.0,
            horizontal_parallax_arcmin: 0.15,
            magnitude: None,
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        }
    }

    #[test]
    fn a_sun_on_the_greenwich_meridian_at_noon_has_no_equation_of_time() {
        // A Julian date near 2.46e6 resolves 40 microseconds of time, so these hold to
        // about 1e-4 s, not better.
        let tol = 1e-3;
        let noon = civil_to_jd(2026, 3, 1) + 0.5;
        assert!(equation_of_time_s(&sun_at(noon, 0.0)).abs() < tol);
        // One degree of GHA ahead of the mean sun is four minutes fast.
        assert!((equation_of_time_s(&sun_at(noon, 1.0)) - 240.0).abs() < tol);
        // At 23h UT the mean sun is 165° past the meridian; 164° is 4 minutes slow.
        let late = civil_to_jd(2026, 3, 1) + 23.0 / 24.0;
        assert!((equation_of_time_s(&sun_at(late, 164.0)) + 240.0).abs() < tol);
        // Just after midnight the wrap goes the short way.
        let early = civil_to_jd(2026, 3, 2) + 1.0 / 1440.0;
        assert!((equation_of_time_s(&sun_at(early, 180.0 + 0.25 + 1.0)) - 240.0).abs() < tol);
    }
}
