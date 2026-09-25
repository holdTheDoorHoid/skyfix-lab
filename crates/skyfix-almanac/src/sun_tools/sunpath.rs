//! The sun path (a day's altitude and azimuth at a fixed step) with the envelope of the
//! solstices and equinoxes, and rise and set azimuths through the year
//! (CONVENTIONS 13.10).
//!
//! The paths are `sample_bodies` for the Sun (within 0.01" of `sky_state` at every
//! sample); the envelope is the same local day shifted by whole days to the days of the
//! year's equinoxes and solstices (`seasons`, CONVENTIONS 13.5). Rise and set azimuths
//! come from one `day_events` over the local year, split into local days, so they are
//! exactly the explorer's rise and set (CONVENTIONS 13.3), and they work for any body.

use serde::{Deserialize, Serialize};
use skyfix_ephemeris::body::{self, BodyEphemeris, BodyKind, SUN};
use skyfix_ephemeris::topocentric::Site;

use super::{check_window, clip_to_coverage, clock_offset_hours, local_date, year_window};
use crate::events::{
    EventKind, EventOptions, SeasonKind, day_events, seasons, standard_altitude_deg,
};
use crate::sky::{AlmanacError, BodyError, checked_site, resolve_bodies, sample_bodies, sky_state};

/// Longest window `sun_path` samples, days.
pub const MAX_PATH_DAYS: f64 = 2.0;
/// Default and allowed sample spacing of `sun_path`, minutes.
pub const DEFAULT_STEP_MINUTES: f64 = 10.0;
pub const MAX_STEP_MINUTES: f64 = 60.0;

/// One sample of a path.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PathPoint {
    pub jd_utc: f64,
    /// Topocentric geometric altitude of the Sun's centre (CONVENTIONS 13.2).
    pub alt_deg: f64,
    pub alt_apparent_deg: f64,
    pub az_deg: f64,
}

/// Which day a path is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathDay {
    /// The requested window.
    Day,
    MarchEquinox,
    JuneSolstice,
    SeptemberEquinox,
    DecemberSolstice,
}

/// One day's path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayPath {
    pub day: PathDay,
    pub jd_start: f64,
    pub jd_end: f64,
    /// The equinox or solstice instant (inside the window); `None` for the requested day.
    pub season_jd_utc: Option<f64>,
    pub points: Vec<PathPoint>,
}

/// `sun_path` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SunPath {
    pub step_minutes: f64,
    /// The requested window's path.
    pub path: DayPath,
    /// The same local day on the year's March equinox, June solstice, September equinox
    /// and December solstice (the year of the window's middle), in that order; a day the
    /// Sun cannot be computed on is left out and named in `errors`.
    pub envelope: Vec<DayPath>,
    pub errors: Vec<BodyError>,
}

/// The Gregorian calendar year of a Julian date (Fliegel & Van Flandern, JD >= 0).
pub(crate) fn gregorian_year(jd: f64) -> i32 {
    let jdn = (jd + 0.5).floor() as i64;
    let l = jdn + 68_569;
    let n = 4 * l / 146_097;
    let l = l - (146_097 * n + 3) / 4;
    let i = 4000 * (l + 1) / 1_461_001;
    let l = l - 1461 * i / 4 + 31;
    let j = 80 * l / 2447;
    let l = j / 11;
    (100 * (n - 49) + i + l) as i32
}

fn path_of(
    eph: &dyn BodyEphemeris,
    site: &Site,
    day: PathDay,
    a: f64,
    b: f64,
    step_minutes: f64,
    season: Option<f64>,
) -> Result<Result<DayPath, BodyError>, AlmanacError> {
    let s = sample_bodies(eph, site, &[SUN], a, b, step_minutes)?;
    if let Some(e) = s.errors.into_iter().next() {
        return Ok(Err(e));
    }
    let Some(sun) = s.bodies.into_iter().next() else {
        return Ok(Err(BodyError {
            body: SUN.to_string(),
            message: "no samples".to_string(),
        }));
    };
    let points = s
        .jd_utc
        .iter()
        .enumerate()
        .map(|(k, &t)| PathPoint {
            jd_utc: t,
            alt_deg: sun.alt_deg[k],
            alt_apparent_deg: sun.alt_apparent_deg[k],
            az_deg: sun.az_deg[k],
        })
        .collect();
    Ok(Ok(DayPath {
        day,
        jd_start: a,
        jd_end: b,
        season_jd_utc: season,
        points,
    }))
}

/// The Sun's path over `[jd_start, jd_end]` (at most two days; the UI passes one local
/// day) every `step_minutes` (1 to 60), and the envelope of the year's equinox and
/// solstice days (EXPLORER_API.md `sun_path`).
pub fn sun_path(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_start: f64,
    jd_end: f64,
    step_minutes: f64,
) -> Result<SunPath, AlmanacError> {
    let site = checked_site(site)?;
    check_window(jd_start, jd_end)?;
    if jd_end - jd_start > MAX_PATH_DAYS {
        return Err(AlmanacError::invalid(format!(
            "a sun path covers at most {MAX_PATH_DAYS} days, got {:.2}",
            jd_end - jd_start
        )));
    }
    if !(step_minutes.is_finite() && (1.0..=MAX_STEP_MINUTES).contains(&step_minutes)) {
        return Err(AlmanacError::invalid(format!(
            "step_minutes must be between 1 and {MAX_STEP_MINUTES}, got {step_minutes}"
        )));
    }
    let path = path_of(
        eph,
        &site,
        PathDay::Day,
        jd_start,
        jd_end,
        step_minutes,
        None,
    )?
    .map_err(AlmanacError::from)?;

    let mid = 0.5 * (jd_start + jd_end);
    let mut envelope = Vec::with_capacity(4);
    let mut errors = Vec::new();
    match seasons(eph, gregorian_year(mid)) {
        Ok(list) => {
            for s in list {
                let day = match s.kind {
                    SeasonKind::MarchEquinox => PathDay::MarchEquinox,
                    SeasonKind::JuneSolstice => PathDay::JuneSolstice,
                    SeasonKind::SeptemberEquinox => PathDay::SeptemberEquinox,
                    SeasonKind::DecemberSolstice => PathDay::DecemberSolstice,
                };
                // The requested day shifted by whole days: to the one holding the instant
                // (a window of a day or less), or centred nearest to it (a longer one).
                let n = if jd_end - jd_start <= 1.0 {
                    (s.jd_utc - jd_start).floor()
                } else {
                    (s.jd_utc - mid).round()
                };
                match path_of(
                    eph,
                    &site,
                    day,
                    jd_start + n,
                    jd_end + n,
                    step_minutes,
                    Some(s.jd_utc),
                )? {
                    Ok(p) => envelope.push(p),
                    Err(e) => errors.push(e),
                }
            }
        }
        Err(e) => errors.push(BodyError {
            body: SUN.to_string(),
            message: format!("no envelope: {e}"),
        }),
    }
    Ok(SunPath {
        step_minutes,
        path,
        envelope,
        errors,
    })
}

// ---------------------------------------------------------------------------
// Rise and set azimuths through the year
// ---------------------------------------------------------------------------

/// `rise_set_azimuths` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RiseSetRequest {
    #[serde(default = "default_sun")]
    pub body: String,
    pub year: i32,
    /// The clock the local days are laid out on; default local mean time.
    #[serde(default)]
    pub utc_offset_hours: Option<f64>,
    #[serde(default)]
    pub options: Option<EventOptions>,
}

fn default_sun() -> String {
    SUN.to_string()
}

/// An event's instant and where the body is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventRef {
    pub jd_utc: f64,
    pub utc: String,
    pub az_deg: f64,
    pub alt_deg: f64,
}

/// One local day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RiseSetDay {
    pub date: String,
    pub jd_start: f64,
    pub jd_end: f64,
    /// Usually one each; none on a day the body does not cross its rise/set altitude,
    /// two for the Moon on rare days at high latitude.
    pub rises: Vec<EventRef>,
    pub sets: Vec<EventRef>,
    /// Upper transit (meridian passage), with the altitude there.
    pub transit: Option<EventRef>,
    pub always_above: bool,
    pub always_below: bool,
}

/// `rise_set_azimuths` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RiseSetAzimuths {
    pub body: String,
    pub year: i32,
    pub utc_offset_hours: f64,
    pub jd_start: f64,
    pub jd_end: f64,
    /// The local year reaches outside the coverage; the days outside are left out.
    pub truncated: bool,
    pub days: Vec<RiseSetDay>,
}

/// Daily rise and set azimuths (and transit altitude) of a body over a local year
/// (EXPLORER_API.md `rise_set_azimuths`).
pub fn rise_set_azimuths(
    eph: &dyn BodyEphemeris,
    site: &Site,
    request: &RiseSetRequest,
) -> Result<RiseSetAzimuths, AlmanacError> {
    let site = checked_site(site)?;
    let name = resolve_bodies(&[request.body.as_str()])?[0];
    let options = request.options.unwrap_or_default().checked()?;
    let offset = clock_offset_hours(request.utc_offset_hours, &site)?;
    let (y0, y1) = year_window(request.year, offset)?;
    let w = clip_to_coverage(eph, y0, y1)?;
    let de = day_events(eph, &site, w.start, w.end, &[name], &options)?;
    if let Some(e) = de.errors.into_iter().next() {
        return Err(e.into());
    }
    let events = de
        .bodies
        .into_iter()
        .next()
        .map(|b| b.events)
        .unwrap_or_default();
    let kind = body::kind(name).unwrap_or(BodyKind::Star);
    let n_days = (y1 - y0).round() as usize;
    let mut days = Vec::with_capacity(n_days);
    for i in 0..n_days {
        let (a, b) = (y0 + i as f64, y0 + i as f64 + 1.0);
        if a < w.start || b > w.end {
            continue;
        }
        let refs = |k: EventKind| -> Vec<EventRef> {
            events
                .iter()
                .filter(|e| e.kind == k && e.jd_utc >= a && e.jd_utc < b)
                .map(|e| EventRef {
                    jd_utc: e.jd_utc,
                    utc: e.utc.clone(),
                    az_deg: e.az_deg,
                    alt_deg: e.alt_deg,
                })
                .collect()
        };
        let rises = refs(EventKind::Rise);
        let sets = refs(EventKind::Set);
        let transit = refs(EventKind::Transit).into_iter().next();
        let (mut always_above, mut always_below) = (false, false);
        if rises.is_empty() && sets.is_empty() {
            let s = sky_state(eph, &site, 0.5 * (a + b), &[name])?;
            if let Some(st) = s.bodies.first() {
                let h0 = standard_altitude_deg(kind, st.semidiameter_arcmin) - options.dip_deg();
                always_above = st.alt_deg >= h0;
                always_below = !always_above;
            }
        }
        days.push(RiseSetDay {
            date: local_date(a + 0.5, offset),
            jd_start: a,
            jd_end: b,
            rises,
            sets,
            transit,
            always_above,
            always_below,
        });
    }
    Ok(RiseSetAzimuths {
        body: name.to_string(),
        year: request.year,
        utc_offset_hours: offset,
        jd_start: w.start,
        jd_end: w.end,
        truncated: w.truncated,
        days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn calendar_years_of_julian_dates() {
        assert_eq!(gregorian_year(civil_to_jd(2026, 1, 1)), 2026);
        assert_eq!(gregorian_year(civil_to_jd(2026, 12, 31) + 0.999), 2026);
        assert_eq!(gregorian_year(civil_to_jd(2000, 2, 29) + 0.5), 2000);
        assert_eq!(gregorian_year(civil_to_jd(1600, 1, 1)), 1600);
        assert_eq!(gregorian_year(civil_to_jd(-500, 6, 1)), -500);
    }
}
