//! Sun tools: golden and blue hour, the azimuth search, the alignment finder, the
//! analemma, the sun path and its seasonal envelope, rise and set azimuths through the
//! year, the equation of time, a clear-sky solar-energy estimate, and the galactic
//! centre's dark-sky windows (the Milky Way planner).
//!
//! OWNER: suntools agent (expansion programme, work package P7). Definitions:
//! CONVENTIONS 13.10; wire formats: EXPLORER_API.md, "Expansion programme — sun tools".
//!
//! Everything here is built on this crate's event finder and sky state rather than
//! beside them, so every altitude and azimuth it reports is the one [`crate::sky`]
//! reports at the same instant:
//!
//! - thresholds of the Sun's **geometric** altitude (golden and blue hour, dark-sky
//!   limits) are found by [`crate::events::find_altitude`], asked for the apparent
//!   altitude that the site's display refraction maps onto that geometric altitude
//!   ([`find_geometric_altitude`]); the mapping is monotonic, so the instants are the
//!   geometric crossings;
//! - rise, set, transit and twilight come from [`crate::events::day_events`];
//! - single instants come from [`crate::sky::sky_state`], and sampled paths from
//!   [`crate::sky::sample_bodies`] or the same interpolated track it uses;
//! - new searches (the azimuth search, the galactic centre's altitude) use the event
//!   finder's own numerical kernel, [`roots`], compiled from the same source file.
//!
//! Nothing here changes a navigation result: these are display and planning tools, on
//! the WGS84 site of CONVENTIONS 13.2, never fed back into sight reduction.

pub mod alignment;
pub mod analemma;
pub mod azimuth;
pub mod eot;
pub mod galactic;
pub mod hours;
pub mod solar;
pub mod sunpath;

// The event finder's bracketed root finder and minimiser (Brent 1973), compiled here from
// the same file rather than copied: `events::roots` is private to `events`, which this
// module does not own (and must not edit). Both instances are the identical, tested code.
// When `events` makes it `pub(crate)`, this becomes `use crate::events::roots;`.
#[allow(clippy::duplicate_mod, dead_code)]
#[path = "../events/roots.rs"]
pub(crate) mod roots;

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc, parse_utc};
use skyfix_ephemeris::body::BodyEphemeris;
use skyfix_ephemeris::topocentric::{Site, refraction_true_to_apparent_arcmin};

use crate::events::{AltitudeCrossing, find_altitude};
use crate::sky::AlmanacError;

pub use crate::events::MAX_WINDOW_DAYS;

/// One second, in days.
pub(crate) const SECOND_DAYS: f64 = 1.0 / 86_400.0;
/// Instants are refined to this, days (1 ms, as the event finder does).
pub(crate) const ROOT_TOL_DAYS: f64 = 0.001 / 86_400.0;
/// Extrema are located to this, days (0.5 s, as the event finder does).
pub(crate) const EXTREMUM_TOL_DAYS: f64 = 0.5 / 86_400.0;
/// The bracketing grid of every search here, days: 10 minutes, the event finder's grid
/// (CONVENTIONS 13.3).
pub(crate) const GRID_DAYS: f64 = 10.0 / 1440.0;
/// Largest `|utc_offset_hours|` accepted (UTC+14 is the easternmost civil zone; LMT at
/// 180 degrees is 12 hours).
pub const MAX_UTC_OFFSET_HOURS: f64 = 15.0;
/// Years accepted by the year-long series (the providers answer only inside their
/// coverage; this bound only keeps the calendar arithmetic finite).
pub const YEAR_RANGE: std::ops::RangeInclusive<i32> = -4000..=10_000;

// ---------------------------------------------------------------------------
// Windows, clocks and calendar days
// ---------------------------------------------------------------------------

/// A finite, ordered window of at most [`MAX_WINDOW_DAYS`], with the same wording as the
/// event finder.
pub(crate) fn check_window(jd_start: f64, jd_end: f64) -> Result<(), AlmanacError> {
    crate::sky::check_jd("jd_start", jd_start)?;
    crate::sky::check_jd("jd_end", jd_end)?;
    if jd_end <= jd_start {
        return Err(AlmanacError::invalid(format!(
            "the window must end after it starts: jd_start {jd_start}, jd_end {jd_end}"
        )));
    }
    if jd_end - jd_start > MAX_WINDOW_DAYS {
        return Err(AlmanacError::invalid(format!(
            "the window is {:.1} days long; at most {MAX_WINDOW_DAYS} days",
            jd_end - jd_start
        )));
    }
    Ok(())
}

/// The clock a year-long series is laid out on: `utc_offset_hours` ahead of UTC when
/// given (zone time, e.g. `-5` for EST), otherwise local mean time at the site's
/// longitude (`lon_east / 15` hours). Daylight saving is never applied: a fixed offset
/// all year, as an analemma photograph is taken.
pub fn clock_offset_hours(utc_offset_hours: Option<f64>, site: &Site) -> Result<f64, AlmanacError> {
    match utc_offset_hours {
        None => Ok(site.lon_deg / 15.0),
        Some(h) if h.is_finite() && h.abs() <= MAX_UTC_OFFSET_HOURS => Ok(h),
        Some(h) => Err(AlmanacError::invalid(format!(
            "utc_offset_hours must be between -{MAX_UTC_OFFSET_HOURS} and \
             {MAX_UTC_OFFSET_HOURS}, got {h}"
        ))),
    }
}

/// `YYYY-MM-DD`: the calendar date of `jd_utc` on a clock `offset_h` hours ahead of UTC
/// (proleptic Gregorian, as on the wire).
pub fn local_date(jd_utc: f64, offset_h: f64) -> String {
    let s = format_utc(jd_utc + offset_h / 24.0);
    match s.find('T') {
        Some(i) => s[..i].to_string(),
        None => s,
    }
}

pub(crate) fn check_year(year: i32) -> Result<(), AlmanacError> {
    if YEAR_RANGE.contains(&year) {
        Ok(())
    } else {
        Err(AlmanacError::invalid(format!(
            "year {year} is outside {} .. {}",
            YEAR_RANGE.start(),
            YEAR_RANGE.end()
        )))
    }
}

/// The local calendar year `[1 January 00:00, next 1 January 00:00)` on a clock
/// `offset_h` ahead of UTC, as UTC Julian dates.
pub fn year_window(year: i32, offset_h: f64) -> Result<(f64, f64), AlmanacError> {
    check_year(year)?;
    let shift = offset_h / 24.0;
    Ok((
        civil_to_jd(year, 1, 1) - shift,
        civil_to_jd(year + 1, 1, 1) - shift,
    ))
}

/// A window clipped to what the provider covers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Clipped {
    pub start: f64,
    pub end: f64,
    /// The request reached outside the coverage.
    pub truncated: bool,
}

/// Clip `[t0, t1]` to the provider's declared coverage (`AstroProvider::coverage`). An
/// unparsable coverage leaves the window as it is; a window entirely outside is an
/// error about `body` naming the coverage.
pub(crate) fn clip_to_coverage(
    eph: &dyn BodyEphemeris,
    body: &str,
    t0: f64,
    t1: f64,
) -> Result<Clipped, AlmanacError> {
    let c = eph.coverage();
    let lo = parse_utc(&c.start_utc).ok();
    let hi = parse_utc(&c.end_utc).ok();
    let start = lo.map_or(t0, |lo| t0.max(lo));
    let end = hi.map_or(t1, |hi| t1.min(hi));
    if end <= start {
        return Err(AlmanacError::Unavailable {
            body: body.to_string(),
            message: format!(
                "the request ({} .. {}) is outside the coverage {} .. {}",
                format_utc(t0),
                format_utc(t1),
                c.start_utc,
                c.end_utc
            ),
        });
    }
    Ok(Clipped {
        start,
        end,
        truncated: start > t0 || end < t1,
    })
}

// ---------------------------------------------------------------------------
// Geometric altitude crossings through the event finder
// ---------------------------------------------------------------------------

/// The apparent altitude (CONVENTIONS 13.2 display refraction at this site) of a body
/// whose geometric altitude is `h_deg`.
pub fn apparent_equivalent_deg(h_deg: f64, site: &Site) -> f64 {
    h_deg + refraction_true_to_apparent_arcmin(h_deg, site.pressure_hpa, site.temperature_c) / 60.0
}

/// Every instant in `[jd_start, jd_end]` at which `body`'s **geometric** topocentric
/// altitude of the centre (`alt_deg`, CONVENTIONS 13.2) crosses `altitude_deg`.
///
/// This is [`find_altitude`] asked for [`apparent_equivalent_deg`]: the apparent altitude
/// `h + R(h)` is monotonic in `h` (the refraction falls by less than 0.2 degree per
/// degree even at the horizon, and is held constant below -1 degree), so it crosses
/// `h0 + R(h0)` exactly when the geometric altitude crosses `h0`. Each crossing's
/// `alt_deg` is therefore `altitude_deg` to within the root tolerance.
pub fn find_geometric_altitude(
    eph: &dyn BodyEphemeris,
    site: &Site,
    body: &str,
    jd_start: f64,
    jd_end: f64,
    altitude_deg: f64,
) -> Result<Vec<AltitudeCrossing>, AlmanacError> {
    if !(altitude_deg.is_finite() && (-90.0..=90.0).contains(&altitude_deg)) {
        return Err(AlmanacError::invalid(format!(
            "altitude_deg must be between -90 and 90, got {altitude_deg}"
        )));
    }
    let site = crate::sky::checked_site(site)?;
    let target = apparent_equivalent_deg(altitude_deg, &site).clamp(-90.0, 90.0);
    find_altitude(eph, &site, body, jd_start, jd_end, target)
}

/// The Sun's topocentric geometric altitude at one instant (`sky_state`'s
/// `sun_altitude_deg`).
pub(crate) fn sun_altitude_deg(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_utc: f64,
) -> Result<f64, AlmanacError> {
    Ok(crate::sky::sky_state(eph, site, jd_utc, &[])?.sun_altitude_deg)
}

// ---------------------------------------------------------------------------
// A generic threshold scan (for directions that are not provider bodies)
// ---------------------------------------------------------------------------

/// Where `f(x)` (x in days after the scan start, `f` continuous) changes sign inside
/// `(0, span)`: `(x, rising)`, refined to [`ROOT_TOL_DAYS`]. `f >= 0` counts as above.
///
/// The event finder's method (module docs of [`crate::events`]): a grid no coarser than
/// [`GRID_DAYS`] plus one sample beyond each end, every local extremum on it located to
/// half a second and added, so a threshold grazed between two grid points is not missed.
pub(crate) fn scan_crossings(f: &mut dyn FnMut(f64) -> f64, span: f64) -> Vec<(f64, bool)> {
    let n = (span / GRID_DAYS).ceil().max(1.0) as usize;
    let dx = span / n as f64;
    let grid: Vec<(f64, f64)> = (0..n + 3)
        .map(|k| {
            let x = if k == n + 1 {
                span
            } else {
                (k as f64 - 1.0) * dx
            };
            (x, f(x))
        })
        .collect();
    let mut samples: Vec<(f64, f64)> = grid[1..=n + 1].to_vec();
    for k in 1..=n + 1 {
        let (a, b, c) = (grid[k - 1].1, grid[k].1, grid[k + 1].1);
        let sign = if b >= a && b > c {
            -1.0
        } else if b <= a && b < c {
            1.0
        } else {
            continue;
        };
        let (xe, _) = roots::brent_min(
            |x| sign * f(x),
            grid[k - 1].0,
            grid[k + 1].0,
            EXTREMUM_TOL_DAYS,
        );
        if xe > 0.0 && xe < span {
            samples.push((xe, f(xe)));
        }
    }
    samples.sort_by(|p, q| p.0.total_cmp(&q.0));
    let mut out = Vec::new();
    for w in samples.windows(2) {
        let (above_a, above_b) = (w[0].1 >= 0.0, w[1].1 >= 0.0);
        if above_a != above_b {
            let x = roots::brent_root(&mut *f, w[0].0, w[1].0, w[0].1, w[1].1, ROOT_TOL_DAYS);
            out.push((x, above_b));
        }
    }
    out
}

/// Where the Sun, a planet or a star is in a band of altitudes: the stretches of a window
/// (UTC Julian dates, time-ordered, contiguous cover) with the band each is in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub jd_start: f64,
    pub jd_end: f64,
}

/// Merge sorted cut instants inside `(t0, t1)` into the stretches between them.
pub(crate) fn stretches(t0: f64, t1: f64, cuts: &mut Vec<f64>) -> Vec<Span> {
    cuts.retain(|&t| t > t0 && t < t1);
    cuts.sort_by(f64::total_cmp);
    cuts.dedup();
    let mut bounds = Vec::with_capacity(cuts.len() + 2);
    bounds.push(t0);
    bounds.extend(cuts.iter().copied());
    bounds.push(t1);
    bounds
        .windows(2)
        .filter(|w| w[1] > w[0])
        .map(|w| Span {
            jd_start: w[0],
            jd_end: w[1],
        })
        .collect()
}

/// The intersection of two sorted, disjoint interval lists.
pub(crate) fn intersect(a: &[Span], b: &[Span]) -> Vec<Span> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let s = a[i].jd_start.max(b[j].jd_start);
        let e = a[i].jd_end.min(b[j].jd_end);
        if e > s {
            out.push(Span {
                jd_start: s,
                jd_end: e,
            });
        }
        if a[i].jd_end < b[j].jd_end {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clocks_default_to_local_mean_time_and_are_range_checked() {
        let site = Site::new(40.0, -75.0);
        assert_eq!(clock_offset_hours(None, &site).unwrap(), -5.0);
        assert_eq!(clock_offset_hours(Some(5.5), &site).unwrap(), 5.5);
        assert!(clock_offset_hours(Some(15.5), &site).is_err());
        assert!(clock_offset_hours(Some(f64::NAN), &site).is_err());
    }

    #[test]
    fn local_dates_follow_the_clock() {
        // 2026-05-30T00:25Z is still 29 May on a clock 4 hours behind UTC.
        let jd = civil_to_jd(2026, 5, 30) + 25.0 / 1440.0;
        assert_eq!(local_date(jd, -4.0), "2026-05-29");
        assert_eq!(local_date(jd, 0.0), "2026-05-30");
        // verify2: an expanded year keeps its whole date (transit ids use this).
        assert_eq!(
            local_date(civil_to_jd(-584, 5, 22) + 0.5, 0.0),
            "-0584-05-22"
        );
        assert_eq!(
            local_date(civil_to_jd(12_345, 1, 2) + 0.5, 0.0),
            "+12345-01-02"
        );
        let (a, b) = year_window(2026, -5.0).unwrap();
        assert!((a - (civil_to_jd(2026, 1, 1) + 5.0 / 24.0)).abs() < 1e-12);
        assert!((b - a - 365.0).abs() < 1e-9);
        assert!(year_window(20_000, 0.0).is_err());
    }

    #[test]
    fn the_apparent_equivalent_is_monotonic_through_the_horizon() {
        let site = Site::new(0.0, 0.0);
        let mut last = f64::NEG_INFINITY;
        for i in -800..=800 {
            let h = f64::from(i) / 100.0;
            let a = apparent_equivalent_deg(h, &site);
            assert!(a > last, "{h}: {a} after {last}");
            last = a;
        }
        let airless = Site {
            pressure_hpa: 0.0,
            ..site
        };
        assert_eq!(apparent_equivalent_deg(-4.0, &airless), -4.0);
    }

    #[test]
    fn a_scan_finds_a_graze_between_grid_points() {
        // A bump 3 minutes wide that pokes 1e-6 above zero inside one grid interval.
        let centre = 0.4321;
        let mut f = |x: f64| 1e-6 - ((x - centre) * 1440.0 / 1.5).powi(2) * 1e-6;
        let v = scan_crossings(&mut f, 1.0);
        assert_eq!(v.len(), 2, "{v:?}");
        assert!(v[0].1 && !v[1].1);
        assert!(((v[0].0 + v[1].0) / 2.0 - centre).abs() < 1e-6);
    }

    #[test]
    fn stretches_and_intersections() {
        let s = stretches(0.0, 10.0, &mut vec![5.0, 2.0, 12.0, 2.0, 0.0]);
        assert_eq!(
            s.iter().map(|x| (x.jd_start, x.jd_end)).collect::<Vec<_>>(),
            vec![(0.0, 2.0), (2.0, 5.0), (5.0, 10.0)]
        );
        let a = [
            Span {
                jd_start: 0.0,
                jd_end: 3.0,
            },
            Span {
                jd_start: 5.0,
                jd_end: 9.0,
            },
        ];
        let b = [Span {
            jd_start: 2.0,
            jd_end: 6.0,
        }];
        let i = intersect(&a, &b);
        assert_eq!(
            i.iter().map(|x| (x.jd_start, x.jd_end)).collect::<Vec<_>>(),
            vec![(2.0, 3.0), (5.0, 6.0)]
        );
    }
}
