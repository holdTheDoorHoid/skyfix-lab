//! The alignment finder: on which days of a year does a body rise or set along a given
//! bearing, or stand at a given height on it (CONVENTIONS 13.10)?
//!
//! Manhattanhenge is the example everyone knows: Manhattan's street grid runs 29° off
//! true east-west, so the Sun sets straight down the cross streets on two evenings in
//! late May and two in mid-July. The same question fits a window, a stone row, a street
//! or a valley for the Sun, the Moon, a planet or a star.
//!
//! - `rise` / `set`: the event finder's rise and set (`day_events`, CONVENTIONS 13.3): the
//!   instant the **upper limb** touches the sea-level horizon with standard refraction
//!   (the centre at `h0`: -50' for the Sun, `-34' - SD` for the Moon, -34' otherwise;
//!   lowered by the dip with `horizon = dip`). The azimuth reported is the centre's at
//!   that instant.
//! - `at_altitude`: the instants the centre's **apparent** altitude is `altitude_deg`
//!   (`find_altitude`), rising and setting. `altitude_deg = 0` is the photographers'
//!   "half sun" on a flat horizon, and `+SD` (about 0.27° for the Sun) the "full sun"
//!   sitting on it.
//!
//! The whole year is one search (one `day_events` or one `find_altitude` over the local
//! year, at most 366 days), so the events are exactly those the explorer shows. A day
//! matches when its event's azimuth is within `tolerance_deg` of the bearing; each run of
//! consecutive matching days marks its closest day `best`. `closest` is the year's
//! closest event whether it matches or not, so "never" can say by how much.

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::BodyEphemeris;
use skyfix_ephemeris::topocentric::Site;

use super::{clip_to_coverage, clock_offset_hours, local_date, year_window};
use crate::events::{EventKind, EventOptions, day_events, find_altitude};
use crate::sky::{AlmanacError, checked_site, resolve_bodies};

/// Which moment of the day is aligned.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AlignmentEvent {
    Rise,
    Set,
    /// The centre at this apparent altitude, rising and setting.
    AtAltitude {
        altitude_deg: f64,
    },
}

/// `alignment_days` request (EXPLORER_API.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlignmentRequest {
    #[serde(default = "default_body")]
    pub body: String,
    pub year: i32,
    /// The bearing, degrees from true north.
    pub azimuth_deg: f64,
    /// How far from the bearing still counts, degrees (default 0.5).
    #[serde(default = "default_tolerance")]
    pub tolerance_deg: f64,
    pub event: AlignmentEvent,
    /// The clock the dates are written on; default local mean time.
    #[serde(default)]
    pub utc_offset_hours: Option<f64>,
    /// Rise and set only: the horizon (CONVENTIONS 13.3).
    #[serde(default)]
    pub options: Option<EventOptions>,
}

fn default_body() -> String {
    "Sun".to_string()
}

fn default_tolerance() -> f64 {
    0.5
}

/// Direction of an aligned moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlignedKind {
    Rise,
    Set,
    /// `at_altitude`, climbing through the altitude.
    Rising,
    /// `at_altitude`, sinking through it.
    Setting,
}

/// One aligned (or, for `closest`, nearest) moment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlignmentMatch {
    /// Local calendar date on the request's clock, `YYYY-MM-DD`.
    pub date: String,
    pub kind: AlignedKind,
    pub jd_utc: f64,
    pub utc: String,
    /// The centre's azimuth at that instant.
    pub az_deg: f64,
    /// `az_deg - azimuth_deg`, wrapped into (-180, 180].
    pub offset_deg: f64,
    /// Topocentric geometric altitude of the centre at that instant.
    pub alt_deg: f64,
    /// The closest day of its run of consecutive matching days.
    pub best: bool,
}

/// `alignment_days` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlignmentResult {
    pub body: String,
    pub year: i32,
    pub azimuth_deg: f64,
    pub tolerance_deg: f64,
    pub event: AlignmentEvent,
    /// The clock the dates are on (local mean time when the request gave none).
    pub utc_offset_hours: f64,
    /// The window searched: the local year, clipped to the coverage.
    pub jd_start: f64,
    pub jd_end: f64,
    /// The local year reaches outside the coverage and was clipped.
    pub truncated: bool,
    /// Events of the requested kind found in the year.
    pub events_considered: usize,
    /// Every event within the tolerance, time-ordered.
    pub matches: Vec<AlignmentMatch>,
    /// The year's event nearest the bearing, matching or not; `None` when the body has
    /// no such event all year (always up, always down, never at that altitude).
    pub closest: Option<AlignmentMatch>,
}

/// Days of `year` on which `request.body`'s rise, set or given altitude falls within
/// `tolerance_deg` of `azimuth_deg` (EXPLORER_API.md `alignment_days`).
pub fn alignment_days(
    eph: &dyn BodyEphemeris,
    site: &Site,
    request: &AlignmentRequest,
) -> Result<AlignmentResult, AlmanacError> {
    let site = checked_site(site)?;
    let body = resolve_bodies(&[request.body.as_str()])?[0];
    let bearing = request.azimuth_deg;
    if !(bearing.is_finite() && (-360.0..=720.0).contains(&bearing)) {
        return Err(AlmanacError::invalid(format!(
            "azimuth_deg must be a bearing in degrees, got {bearing}"
        )));
    }
    let tol = request.tolerance_deg;
    if !(tol.is_finite() && tol > 0.0 && tol <= 90.0) {
        return Err(AlmanacError::invalid(format!(
            "tolerance_deg must be above 0 and at most 90, got {tol}"
        )));
    }
    let offset = clock_offset_hours(request.utc_offset_hours, &site)?;
    let (y0, y1) = year_window(request.year, offset)?;
    let w = clip_to_coverage(eph, body, y0, y1)?;

    // (kind, jd, az, alt) for every event of the requested sort in the year.
    let mut events: Vec<(AlignedKind, f64, f64, f64)> = Vec::new();
    match request.event {
        AlignmentEvent::Rise | AlignmentEvent::Set => {
            let options = request.options.unwrap_or_default();
            let de = day_events(eph, &site, w.start, w.end, &[body], &options)?;
            if let Some(e) = de.errors.into_iter().next() {
                return Err(e.into());
            }
            let want = if request.event == AlignmentEvent::Rise {
                EventKind::Rise
            } else {
                EventKind::Set
            };
            for b in de.bodies {
                for e in b.events.into_iter().filter(|e| e.kind == want) {
                    let kind = if want == EventKind::Rise {
                        AlignedKind::Rise
                    } else {
                        AlignedKind::Set
                    };
                    events.push((kind, e.jd_utc, e.az_deg, e.alt_deg));
                }
            }
        }
        AlignmentEvent::AtAltitude { altitude_deg } => {
            if request.options.is_some() {
                return Err(AlmanacError::invalid(
                    "options (the horizon) apply to rise and set only; at_altitude uses the \
                     apparent altitude given",
                ));
            }
            for c in find_altitude(eph, &site, body, w.start, w.end, altitude_deg)? {
                let kind = if c.rising {
                    AlignedKind::Rising
                } else {
                    AlignedKind::Setting
                };
                events.push((kind, c.jd_utc, c.az_deg, c.alt_deg));
            }
        }
    }

    let to_match = |&(kind, jd, az, alt): &(AlignedKind, f64, f64, f64)| AlignmentMatch {
        date: local_date(jd, offset),
        kind,
        jd_utc: jd,
        utc: format_utc(jd),
        az_deg: az,
        offset_deg: norm_180(az - bearing),
        alt_deg: alt,
        best: false,
    };
    let closest = events
        .iter()
        .min_by(|a, b| {
            norm_180(a.2 - bearing)
                .abs()
                .total_cmp(&norm_180(b.2 - bearing).abs())
        })
        .map(to_match);
    let mut matches: Vec<AlignmentMatch> = events
        .iter()
        .filter(|e| norm_180(e.2 - bearing).abs() <= tol)
        .map(to_match)
        .collect();
    mark_best(&mut matches);

    Ok(AlignmentResult {
        body: body.to_string(),
        year: request.year,
        azimuth_deg: bearing,
        tolerance_deg: tol,
        event: request.event,
        utc_offset_hours: offset,
        jd_start: w.start,
        jd_end: w.end,
        truncated: w.truncated,
        events_considered: events.len(),
        matches,
        closest,
    })
}

/// Mark the closest match of each run: matches of one kind less than 1.5 days apart.
fn mark_best(matches: &mut [AlignmentMatch]) {
    let mut done = vec![false; matches.len()];
    for i in 0..matches.len() {
        if done[i] {
            continue;
        }
        let mut run = vec![i];
        let mut last = matches[i].jd_utc;
        for (j, m) in matches.iter().enumerate().skip(i + 1) {
            if done[j] || m.kind != matches[i].kind {
                continue;
            }
            if m.jd_utc - last < 1.5 {
                run.push(j);
                last = m.jd_utc;
            } else {
                break;
            }
        }
        for &j in &run {
            done[j] = true;
        }
        if let Some(&b) = run.iter().min_by(|&&a, &&b| {
            matches[a]
                .offset_deg
                .abs()
                .total_cmp(&matches[b].offset_deg.abs())
        }) {
            matches[b].best = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_from_the_wire_shape() {
        let r: AlignmentRequest =
            serde_json::from_str(r#"{"year": 2026, "azimuth_deg": 299, "event": {"kind": "set"}}"#)
                .unwrap();
        assert_eq!(r.body, "Sun");
        assert_eq!(r.tolerance_deg, 0.5);
        assert_eq!(r.event, AlignmentEvent::Set);
        let a: AlignmentRequest = serde_json::from_str(
            r#"{"body": "Moon", "year": 2026, "azimuth_deg": 60, "tolerance_deg": 1,
                "event": {"kind": "at_altitude", "altitude_deg": 5}, "utc_offset_hours": -5}"#,
        )
        .unwrap();
        assert_eq!(a.event, AlignmentEvent::AtAltitude { altitude_deg: 5.0 });
        assert!(
            serde_json::from_str::<AlignmentRequest>(
                r#"{"year": 2026, "azimuth_deg": 299, "event": {"kind": "sunset"}}"#
            )
            .is_err()
        );
    }

    fn m(day: f64, off: f64) -> AlignmentMatch {
        AlignmentMatch {
            date: String::new(),
            kind: AlignedKind::Set,
            jd_utc: 2_461_000.0 + day,
            utc: String::new(),
            az_deg: 299.0 + off,
            offset_deg: off,
            alt_deg: -0.8,
            best: false,
        }
    }

    #[test]
    fn each_run_of_days_has_one_best() {
        let mut v = vec![
            m(0.0, 0.4),
            m(1.0, -0.1),
            m(2.0, -0.45),
            m(45.0, 0.3),
            m(46.0, 0.2),
        ];
        mark_best(&mut v);
        let best: Vec<bool> = v.iter().map(|x| x.best).collect();
        assert_eq!(best, vec![false, true, false, false, true]);
    }
}
