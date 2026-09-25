//! The Moon's perigees and apogees, and supermoons and micromoons.
//!
//! OWNER: moondetail agent (expansion programme P8). Definitions in CONVENTIONS 13.10;
//! wire format in `docs/EXPLORER_API.md`, `moon_apsides`; accuracy in
//! `docs/ACCURACY.md`, "Moon in detail".
//!
//! # Method
//!
//! Perigee and apogee are the local minima and maxima of the geometric distance between
//! the centres of the Earth and the Moon, taken from the ephemeris itself
//! ([`skyfix_ephemeris::moon`], ELP 2000-82B), not from Meeus's chapter-50 series: the
//! distance is sampled every day (an extremum recurs every 27.55 days and the two kinds
//! alternate, so a day brackets each one), and each extremum is refined by Brent's
//! minimiser to about a tenth of a second.
//!
//! New and full Moons come from [`crate::events::moon_phases`] (CONVENTIONS 13.5), the
//! same instants the Events view shows. At each one the distance is compared with the
//! orbit's extremes:
//!
//! - **supermoon** (Nolle 1979, the definition most calendars use): the Moon is at least
//!   90 % of the way from apogee to perigee, `(d_A − d) / (d_A − d_P) ≥ 0.9`, with `P`
//!   and `A` the perigee and the apogee on either side of the new or full Moon in time
//!   (the leg of the orbit it falls on: one is the last extreme before it, the other the
//!   next after it, since perigees and apogees alternate). "The nearest perigee and the
//!   nearest apogee" is not well defined near perigee, where the apogees before and
//!   after are almost equally far in time and can differ by 1 000 km;
//! - **micromoon**: at least 90 % of the way to apogee, the same fraction `≤ 0.1`;
//! - the **largest** and **smallest full Moon of the year**: the least and the greatest
//!   distance at the instant of full Moon among the full Moons of that UTC calendar year.
//!
//! Both distances are always given, with the disc's size against its size at the mean
//! distance of 384 400 km, so the interface can say "7 % larger than average" whatever
//! definition it prefers ("a full Moon within 24 hours of perigee" is the other common
//! one; `hours_from_perigee` answers it).

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc, parse_utc};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::body::BodyEphemeris;
use skyfix_ephemeris::moon::{
    EARTH_EQUATORIAL_RADIUS_KM, MEAN_DISTANCE_KM, MOON_RADIUS_RATIO_K, MoonProvider,
};

use crate::eclipses::cheb::minimise;
use crate::events::{MoonPhaseKind, moon_phases};
use crate::sky::AlmanacError;

/// Sampling step of the distance, days.
const STEP_DAYS: f64 = 1.0;
/// Extrema to this, days (about 0.1 s; the distance is flat at an extremum, so its
/// instant is only as sharp as the ephemeris's curvature allows).
const EXTREMUM_TOL_DAYS: f64 = 1e-6;
/// The Nolle fraction a supermoon reaches (and a micromoon does not exceed `1 - it`).
pub const SUPERMOON_FRACTION: f64 = 0.9;
/// The longest window, days (a century): the search costs about 0.1 s a year natively.
pub const MAX_WINDOW_DAYS: f64 = 36_525.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApsisKind {
    Perigee,
    Apogee,
}

/// A perigee or an apogee.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Apsis {
    pub kind: ApsisKind,
    pub jd_utc: f64,
    pub utc: String,
    /// Geometric distance between the centres of the Earth and the Moon, km.
    pub distance_km: f64,
    /// Geocentric semidiameter and diameter of the disc, arcminutes.
    pub semidiameter_arcmin: f64,
    pub diameter_arcmin: f64,
    /// The disc's size against its size at the mean distance (384 400 km), percent.
    pub diameter_vs_mean_percent: f64,
}

/// The perigee or the apogee on one side of a new or full Moon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApsisRef {
    pub jd_utc: f64,
    pub utc: String,
    pub distance_km: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyzygyKind {
    NewMoon,
    FullMoon,
}

/// A new or full Moon with its distance and its place in the orbit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Syzygy {
    pub kind: SyzygyKind,
    pub jd_utc: f64,
    pub utc: String,
    pub distance_km: f64,
    pub diameter_arcmin: f64,
    pub diameter_vs_mean_percent: f64,
    /// The perigee and the apogee on either side of it in time (the leg of the orbit
    /// it falls on).
    pub perigee: ApsisRef,
    pub apogee: ApsisRef,
    /// Hours from that perigee (negative: before it).
    pub hours_from_perigee: f64,
    /// Where the distance sits between the orbit's apogee (0) and perigee (1).
    pub perigee_fraction: f64,
    /// `perigee_fraction ≥ 0.9` (Nolle).
    pub supermoon: bool,
    /// `perigee_fraction ≤ 0.1`.
    pub micromoon: bool,
    /// Full Moons only: the nearest (largest) and farthest (smallest) full Moon of this
    /// UTC calendar year. Always false for a new Moon.
    pub largest_of_year: bool,
    pub smallest_of_year: bool,
}

/// The definitions the flags follow, repeated for the About view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApsidesDefinitions {
    pub apsis: String,
    pub supermoon: String,
    pub micromoon: String,
    pub largest_of_year: String,
    pub mean_distance_km: f64,
}

/// Result of [`moon_apsides`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonApsides {
    /// The window searched: the request clipped to the Moon's coverage.
    pub jd_start: f64,
    pub jd_end: f64,
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    /// Perigees and apogees with their instant in the window, sorted by time.
    pub apsides: Vec<Apsis>,
    /// New and full Moons with their instant in the window, sorted by time.
    pub syzygies: Vec<Syzygy>,
    pub definitions: ApsidesDefinitions,
}

fn semidiameter_arcmin(distance_km: f64) -> f64 {
    (MOON_RADIUS_RATIO_K * EARTH_EQUATORIAL_RADIUS_KM / distance_km)
        .asin()
        .to_degrees()
        * 60.0
}

fn vs_mean_percent(distance_km: f64) -> f64 {
    (MEAN_DISTANCE_KM / distance_km - 1.0) * 100.0
}

/// The provider's coverage as UTC Julian dates.
fn coverage(moon: &MoonProvider) -> Result<(f64, f64, String, String), AlmanacError> {
    let c = moon.coverage();
    let a = parse_utc(&c.start_utc).map_err(|e| AlmanacError::invalid(e.to_string()))?;
    let b = parse_utc(&c.end_utc).map_err(|e| AlmanacError::invalid(e.to_string()))?;
    Ok((a, b, c.start_utc, c.end_utc))
}

fn unavailable(e: impl std::fmt::Display) -> AlmanacError {
    AlmanacError::Unavailable {
        body: "Moon".to_string(),
        message: e.to_string(),
    }
}

/// Every perigee and apogee with its instant in `[lo, hi]` (UTC Julian dates inside the
/// coverage), from the distance function `dist` (km of a UTC Julian date).
///
/// Generic over the distance so that the method can be checked on the raw lunar theory
/// outside the provider's coverage (Meeus's example 50.a is in 1988).
pub fn find_apsides(
    mut dist: impl FnMut(f64) -> Result<f64, AlmanacError>,
    lo: f64,
    hi: f64,
) -> Result<Vec<(ApsisKind, f64, f64)>, AlmanacError> {
    if !(lo.is_finite() && hi.is_finite() && hi > lo) {
        return Err(AlmanacError::invalid(
            "the window must be finite and end after it starts",
        ));
    }
    // Work in days from `lo`: a Julian date resolves only 40 microseconds. Samples stay
    // inside [lo, hi], so an extremum within a step of either end is not bracketed; the
    // caller widens the window where it can.
    let n = ((hi - lo) / STEP_DAYS).ceil().max(2.0) as usize;
    let h = (hi - lo) / n as f64;
    let xs: Vec<f64> = (0..=n).map(|k| k as f64 * h).collect();
    let mut ds = Vec::with_capacity(xs.len());
    for &x in &xs {
        ds.push(dist(lo + x)?);
    }
    let mut failure: Option<AlmanacError> = None;
    let mut out = Vec::new();
    for i in 1..xs.len() - 1 {
        let (a, b, c) = (ds[i - 1], ds[i], ds[i + 1]);
        let kind = if b <= a && b < c {
            ApsisKind::Perigee
        } else if b >= a && b > c {
            ApsisKind::Apogee
        } else {
            continue;
        };
        let sign = if kind == ApsisKind::Perigee {
            1.0
        } else {
            -1.0
        };
        let mut f = |x: f64| match dist(lo + x) {
            Ok(d) => sign * d,
            Err(e) => {
                failure.get_or_insert(e);
                f64::NAN
            }
        };
        let (x, fx) = minimise(&mut f, xs[i - 1], xs[i + 1], EXTREMUM_TOL_DAYS);
        if let Some(e) = failure.take() {
            return Err(e);
        }
        let jd = lo + x;
        if jd >= lo && jd <= hi {
            out.push((kind, jd, sign * fx));
        }
    }
    Ok(out)
}

/// Perigees, apogees, new and full Moons, supermoons and micromoons with their instant in
/// `[jd_start, jd_end]` (UTC Julian dates), clipped to the Moon's coverage. `eph` gives
/// the phases (the explorer's [`skyfix_ephemeris::body::Sky`]).
pub fn moon_apsides(
    moon: &MoonProvider,
    eph: &dyn BodyEphemeris,
    jd_start: f64,
    jd_end: f64,
) -> Result<MoonApsides, AlmanacError> {
    if !(jd_start.is_finite() && jd_end.is_finite()) || jd_end <= jd_start {
        return Err(AlmanacError::invalid(format!(
            "the window must be finite and end after it starts: jd_start {jd_start}, jd_end {jd_end}"
        )));
    }
    if jd_end - jd_start > MAX_WINDOW_DAYS {
        return Err(AlmanacError::invalid(format!(
            "the window is {:.0} days; at most {MAX_WINDOW_DAYS:.0}",
            jd_end - jd_start
        )));
    }
    let (c0, c1, c0s, c1s) = coverage(moon)?;
    let (lo, hi) = (jd_start.max(c0), jd_end.min(c1));
    let truncated = lo > jd_start || hi < jd_end;
    let definitions = ApsidesDefinitions {
        apsis: "Perigee and apogee: least and greatest geometric distance between the \
                centres of the Earth and the Moon (ELP 2000-82B)."
            .to_string(),
        supermoon: "A new or full Moon at least 90 % of the way from apogee to perigee: \
                    (apogee - d) / (apogee - perigee) >= 0.9, with the perigee and the \
                    apogee on either side of it in time (Nolle 1979)."
            .to_string(),
        micromoon: "A new or full Moon at least 90 % of the way to apogee: the same \
                    fraction <= 0.1."
            .to_string(),
        largest_of_year: "The full Moons of a UTC calendar year with the least and the \
                          greatest distance at the instant of full Moon."
            .to_string(),
        mean_distance_km: MEAN_DISTANCE_KM,
    };
    let mut result = MoonApsides {
        jd_start: lo,
        jd_end: hi,
        truncated,
        coverage_start_utc: c0s,
        coverage_end_utc: c1s,
        apsides: Vec::new(),
        syzygies: Vec::new(),
        definitions,
    };
    if hi <= lo {
        return Ok(result);
    }
    let dist = |jd: f64| -> Result<f64, AlmanacError> {
        moon.position(jd)
            .map(|p| p.distance_km)
            .map_err(unavailable)
    };

    // Apsides over the window plus a margin (the syzygies near its ends need the
    // extremes around them), all inside the coverage.
    let (alo, ahi) = ((lo - 20.0).max(c0), (hi + 20.0).min(c1));
    let apsides = find_apsides(dist, alo, ahi)?;
    for &(kind, jd, d) in &apsides {
        if jd >= lo && jd <= hi {
            let sd = semidiameter_arcmin(d);
            result.apsides.push(Apsis {
                kind,
                jd_utc: jd,
                utc: format_utc(jd),
                distance_km: d,
                semidiameter_arcmin: sd,
                diameter_arcmin: 2.0 * sd,
                diameter_vs_mean_percent: vs_mean_percent(d),
            });
        }
    }

    // New and full Moons in the window; then, for the year's largest and smallest, the
    // full Moons of the rest of every calendar year that has one in the window.
    let mut phases = moon_phases(eph, lo, hi)?;
    let years: std::collections::BTreeSet<i32> = phases
        .iter()
        .filter(|p| p.kind == MoonPhaseKind::FullMoon)
        .map(|p| year_of(p.jd_utc))
        .collect();
    let mut full_by_year: std::collections::BTreeMap<i32, Vec<(f64, f64)>> = Default::default();
    for &y in &years {
        let (y0, y1) = (
            civil_to_jd(y, 1, 1).max(c0),
            civil_to_jd(y + 1, 1, 1).min(c1),
        );
        let mut year_phases: Vec<_> = phases
            .iter()
            .filter(|p| p.jd_utc >= y0 && p.jd_utc < y1)
            .cloned()
            .collect();
        if y0 < lo {
            year_phases.extend(moon_phases(eph, y0, lo)?);
        }
        if y1 > hi {
            year_phases.extend(moon_phases(eph, hi, y1)?);
        }
        let list = full_by_year.entry(y).or_default();
        for p in year_phases {
            if p.kind == MoonPhaseKind::FullMoon
                && year_of(p.jd_utc) == y
                && !list.iter().any(|x| (x.0 - p.jd_utc).abs() < 1.0)
            {
                list.push((p.jd_utc, dist(p.jd_utc)?));
            }
        }
    }
    phases.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));
    // The perigee and the apogee on either side of an instant: the last extreme before
    // it and the first after it (they alternate).
    let bracket = |jd: f64| -> Option<((f64, f64), (f64, f64))> {
        let k = apsides.iter().position(|a| a.1 > jd)?;
        let (before, after) = (apsides.get(k.checked_sub(1)?)?, &apsides[k]);
        let pair = |a: &(ApsisKind, f64, f64)| (a.1, a.2);
        match (before.0, after.0) {
            (ApsisKind::Perigee, ApsisKind::Apogee) => Some((pair(before), pair(after))),
            (ApsisKind::Apogee, ApsisKind::Perigee) => Some((pair(after), pair(before))),
            _ => None,
        }
    };
    for p in &phases {
        let kind = match p.kind {
            MoonPhaseKind::NewMoon => SyzygyKind::NewMoon,
            MoonPhaseKind::FullMoon => SyzygyKind::FullMoon,
            _ => continue,
        };
        if p.jd_utc < lo || p.jd_utc > hi {
            continue;
        }
        let d = dist(p.jd_utc)?;
        let Some((per, apo)) = bracket(p.jd_utc) else {
            // At the very edge of the coverage an extreme can be missing.
            continue;
        };
        let fraction = (apo.1 - d) / (apo.1 - per.1);
        let (largest, smallest) = if kind == SyzygyKind::FullMoon {
            let year = &full_by_year[&year_of(p.jd_utc)];
            let min = year.iter().map(|x| x.1).fold(f64::INFINITY, f64::min);
            let max = year.iter().map(|x| x.1).fold(f64::NEG_INFINITY, f64::max);
            (d == min, d == max)
        } else {
            (false, false)
        };
        let sd = semidiameter_arcmin(d);
        result.syzygies.push(Syzygy {
            kind,
            jd_utc: p.jd_utc,
            utc: p.utc.clone(),
            distance_km: d,
            diameter_arcmin: 2.0 * sd,
            diameter_vs_mean_percent: vs_mean_percent(d),
            perigee: ApsisRef {
                jd_utc: per.0,
                utc: format_utc(per.0),
                distance_km: per.1,
            },
            apogee: ApsisRef {
                jd_utc: apo.0,
                utc: format_utc(apo.0),
                distance_km: apo.1,
            },
            hours_from_perigee: (p.jd_utc - per.0) * 24.0,
            perigee_fraction: fraction,
            supermoon: fraction >= SUPERMOON_FRACTION,
            micromoon: fraction <= 1.0 - SUPERMOON_FRACTION,
            largest_of_year: largest,
            smallest_of_year: smallest,
        });
    }
    Ok(result)
}

/// The UTC calendar year of a Julian date.
fn year_of(jd: f64) -> i32 {
    // format_utc is the project's one calendar; its year is the leading field.
    let s = format_utc(jd);
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, s.strip_prefix('+').unwrap_or(&s)),
    };
    sign * rest
        .split('-')
        .next()
        .and_then(|y| y.parse::<i32>().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_ephemeris::body::Sky;

    #[test]
    fn a_year_has_thirteen_or_fourteen_of_each_extreme_alternating() {
        let r = moon_apsides(
            &MoonProvider::new(),
            &Sky::new(),
            civil_to_jd(2026, 1, 1),
            civil_to_jd(2027, 1, 1),
        )
        .unwrap();
        let per = r
            .apsides
            .iter()
            .filter(|a| a.kind == ApsisKind::Perigee)
            .count();
        let apo = r
            .apsides
            .iter()
            .filter(|a| a.kind == ApsisKind::Apogee)
            .count();
        assert!(
            (13..=14).contains(&per) && (13..=14).contains(&apo),
            "{per} {apo}"
        );
        assert!(
            r.apsides
                .windows(2)
                .all(|w| w[0].kind != w[1].kind && w[0].jd_utc < w[1].jd_utc)
        );
        for a in &r.apsides {
            match a.kind {
                ApsisKind::Perigee => assert!((356_000.0..371_000.0).contains(&a.distance_km)),
                ApsisKind::Apogee => assert!((404_000.0..407_000.0).contains(&a.distance_km)),
            }
        }
        // 12 or 13 full Moons, exactly one largest and one smallest.
        let full: Vec<&Syzygy> = r
            .syzygies
            .iter()
            .filter(|s| s.kind == SyzygyKind::FullMoon)
            .collect();
        assert!((12..=13).contains(&full.len()));
        assert_eq!(full.iter().filter(|s| s.largest_of_year).count(), 1);
        assert_eq!(full.iter().filter(|s| s.smallest_of_year).count(), 1);
        for s in &r.syzygies {
            assert!((0.0..=1.0).contains(&s.perigee_fraction), "{s:?}");
            assert!(!(s.supermoon && s.micromoon));
            assert!(s.hours_from_perigee.abs() < 16.0 * 24.0);
        }
        assert_eq!(year_of(civil_to_jd(2026, 12, 31) + 0.99), 2026);
    }

    #[test]
    fn windows_are_checked_and_clipped() {
        let m = MoonProvider::new();
        let s = Sky::new();
        assert!(moon_apsides(&m, &s, 2_461_000.0, 2_460_000.0).is_err());
        assert!(moon_apsides(&m, &s, f64::NAN, 2_460_000.0).is_err());
        // The Moon's coverage starts 1550-01-01 (the validated tier, deeptime agent).
        let r = moon_apsides(&m, &s, civil_to_jd(1540, 1, 1), civil_to_jd(1550, 3, 1)).unwrap();
        assert!(r.truncated && r.jd_start >= civil_to_jd(1550, 1, 1));
        assert!(!r.apsides.is_empty());
    }
}
