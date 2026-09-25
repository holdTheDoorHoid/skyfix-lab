//! The analemma: where the Sun stands at the same clock time on every day of a year
//! (CONVENTIONS 13.10).
//!
//! The clock is local mean time at the observer's longitude (`lmt`) or a zone time with a
//! fixed offset from UTC (`zone`); daylight saving is never applied, as an analemma
//! photograph is taken. Each day's point is `sky_state` for the Sun at that instant
//! (topocentric altitude, apparent altitude and azimuth), with the Sun's declination and
//! the equation of time (the analemma's two axes) beside it.

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_ephemeris::body::{BodyEphemeris, SUN};
use skyfix_ephemeris::topocentric::Site;

use super::eot::equation_of_time_at;
use super::{check_year, clock_offset_hours, local_date};
use crate::sky::{AlmanacError, BodyError, checked_site, sky_state};

/// The clock an analemma is laid out on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockKind {
    /// Local mean time at the observer's longitude: UTC + `lon_east / 15` hours.
    Lmt,
    /// A zone time `utc_offset_hours` ahead of UTC, all year.
    Zone,
}

/// `analemma` request.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalemmaRequest {
    pub year: i32,
    /// Clock time of day, hours in `[0, 24)` (12.0 = noon).
    pub time_h: f64,
    pub clock: ClockKind,
    /// Required for `zone`, refused for `lmt`.
    #[serde(default)]
    pub utc_offset_hours: Option<f64>,
}

/// The Sun on one day at the chosen clock time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalemmaPoint {
    /// The local date on the chosen clock, `YYYY-MM-DD`.
    pub date: String,
    pub jd_utc: f64,
    pub utc: String,
    /// Topocentric geometric altitude of the centre (CONVENTIONS 13.2).
    pub alt_deg: f64,
    pub alt_apparent_deg: f64,
    pub az_deg: f64,
    /// Apparent geocentric declination.
    pub dec_deg: f64,
    /// Equation of time at that instant, seconds (CONVENTIONS 13.9).
    pub eot_s: f64,
}

/// `analemma` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Analemma {
    pub year: i32,
    pub time_h: f64,
    pub clock: ClockKind,
    /// The offset used: `lon_east / 15` for `lmt`.
    pub utc_offset_hours: f64,
    pub points: Vec<AnalemmaPoint>,
    /// Days the Sun could not be computed on, with the reason (at most one entry).
    pub errors: Vec<BodyError>,
}

/// The Sun at `time_h` on the chosen clock on every local date of `year`
/// (EXPLORER_API.md `analemma`).
pub fn analemma(
    eph: &dyn BodyEphemeris,
    site: &Site,
    request: &AnalemmaRequest,
) -> Result<Analemma, AlmanacError> {
    let site = checked_site(site)?;
    check_year(request.year)?;
    let t = request.time_h;
    if !(t.is_finite() && (0.0..24.0).contains(&t)) {
        return Err(AlmanacError::invalid(format!(
            "time_h must be in [0, 24), got {t}"
        )));
    }
    let offset = match (request.clock, request.utc_offset_hours) {
        (ClockKind::Lmt, None) => clock_offset_hours(None, &site)?,
        (ClockKind::Lmt, Some(_)) => {
            return Err(AlmanacError::invalid(
                "clock lmt takes its offset from the longitude; give utc_offset_hours only \
                 with clock zone",
            ));
        }
        (ClockKind::Zone, Some(h)) => clock_offset_hours(Some(h), &site)?,
        (ClockKind::Zone, None) => {
            return Err(AlmanacError::invalid(
                "clock zone needs utc_offset_hours (e.g. -5 for UTC-5)",
            ));
        }
    };
    let d0 = civil_to_jd(request.year, 1, 1);
    let days = (civil_to_jd(request.year + 1, 1, 1) - d0).round() as usize;
    let mut points = Vec::with_capacity(days);
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    for k in 0..days {
        let jd = d0 + k as f64 + (t - offset) / 24.0;
        match sky_state(eph, &site, jd, &[SUN]) {
            Ok(s) => {
                let Some(b) = s.bodies.first() else {
                    failed += 1;
                    continue;
                };
                points.push(AnalemmaPoint {
                    date: local_date(jd, offset),
                    jd_utc: jd,
                    utc: format_utc(jd),
                    alt_deg: b.alt_deg,
                    alt_apparent_deg: b.alt_apparent_deg,
                    az_deg: b.az_deg,
                    dec_deg: b.dec_deg,
                    eot_s: equation_of_time_at(jd, b.gha_deg),
                });
            }
            Err(AlmanacError::Unavailable { message, .. }) => {
                failed += 1;
                first_error.get_or_insert(message);
            }
            Err(e) => return Err(e),
        }
    }
    if points.is_empty() {
        return Err(AlmanacError::Unavailable {
            body: SUN.to_string(),
            message: first_error.unwrap_or_else(|| "no day could be computed".to_string()),
        });
    }
    Ok(Analemma {
        year: request.year,
        time_h: t,
        clock: request.clock,
        utc_offset_hours: offset,
        points,
        errors: first_error
            .map(|m| {
                vec![BodyError {
                    body: SUN.to_string(),
                    message: format!("{failed} of {days} days left out: {m}"),
                }]
            })
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_and_the_clock_needs_its_offset() {
        let r: AnalemmaRequest =
            serde_json::from_str(r#"{"year": 2026, "time_h": 12, "clock": "lmt"}"#).unwrap();
        assert_eq!(r.clock, ClockKind::Lmt);
        let sky = skyfix_ephemeris::body::Sky::new();
        let site = Site::new(40.0, -75.0);
        let bad = AnalemmaRequest {
            clock: ClockKind::Zone,
            ..r
        };
        assert!(analemma(&sky, &site, &bad).is_err());
        let also_bad = AnalemmaRequest {
            utc_offset_hours: Some(-5.0),
            ..r
        };
        assert!(analemma(&sky, &site, &also_bad).is_err());
        let late = AnalemmaRequest { time_h: 24.0, ..r };
        assert!(analemma(&sky, &site, &late).is_err());
    }
}
