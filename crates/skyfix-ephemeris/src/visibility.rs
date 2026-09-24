//! Geometric visibility and the end-to-end observation plan.
//!
//! OWNER: planner agent. This module is the bridge between an [`AstroProvider`] and
//! [`skyfix_core::planner`]: it turns body names and a time into
//! [`Candidate`]s with altitude, azimuth and expected sigma, flags the twilight state,
//! and hands the set to [`planner::rank`].
//!
//! # What "visible" means here
//!
//! **Geometric visibility only.** A body is a candidate when its computed altitude at the
//! approximate position is above the caller's floor. Nothing here knows about cloud,
//! haze, a building, a headland, the Moon washing out a faint star, or whether the
//! horizon under the body is the sea horizon or a row of trees. The one atmospheric-ish
//! input is the Sun's altitude, and it is used only to attach the sentence in
//! [`sun_altitude_note`] — it never filters a body out.
//!
//! The Sun's altitude is an argument rather than a computation: the Sun provider is a
//! separate deliverable, and this module refuses to guess. Pass `None` and every star
//! carries the note "Sun altitude unknown".
//!
//! # Refraction is not applied
//!
//! The altitudes here are **geometric** altitudes computed from the apparent geocentric
//! direction (CONVENTIONS section 7) and the approximate position. They are what a
//! perfect instrument would compute, not what a sextant reads: refraction raises a real
//! body by about 0.5 degrees at the horizon and 0.02 degrees at 45 degrees
//! (CONVENTIONS section 5). At the 15-degree default floor the difference is about
//! 0.06 degrees, far inside the uncertainty of the approximate position a plan rests on,
//! so it is deliberately not modelled: a plan that turned on a 0.06-degree distinction
//! would be pretending to a precision it does not have.

use skyfix_core::geometry::{Point, altitude_azimuth};
use skyfix_core::planner::{self, Candidate, Plan, PlanOptions};
use skyfix_core::time::{format_utc, parse_utc};
use skyfix_core::types::{
    Instrument, LatLon, Limb, RecommendedSight, SightObserver, SightPlan, TwilightPlan,
};

use crate::body::{BodyEphemeris, BodyKind, Sky};
use crate::catalog;
use crate::topocentric::{Site as TopoSite, horizontal};
use crate::{AstroProvider, EphemerisError};

/// Sun altitude above this (degrees) means the sky is too bright for stars.
pub const CIVIL_TWILIGHT_DEG: f64 = -6.0;
/// Sun altitude below this (degrees) means full dark: no usable natural horizon.
pub const NAUTICAL_TWILIGHT_DEG: f64 = -12.0;

/// Note attached when the Sun altitude is bright enough to drown the stars.
pub const NOTE_TOO_BRIGHT: &str = "sky likely too bright for stars (civil twilight or day)";
/// Note attached during nautical twilight, the classic star-sight window.
pub const NOTE_NAUTICAL: &str = "nautical twilight: horizon and stars both visible (sea horizon)";
/// Note attached in full dark, when the stars are there but the horizon is not.
pub const NOTE_DARK: &str = "dark: stars visible, natural horizon likely not (artificial horizon or electronic \
     vertical needed)";
/// Note attached when the caller did not supply a Sun altitude.
pub const NOTE_SUN_UNKNOWN: &str = "Sun altitude unknown";

/// Geometric altitude and true azimuth of every requested body that is high enough.
///
/// Each body is queried from `provider`, its apparent geocentric GHA/Dec turned into an
/// altitude and azimuth at `position` through
/// [`skyfix_core::geometry::altitude_azimuth`], and kept when the altitude is at least
/// `min_altitude_deg`. `sigma_arcmin` comes from
/// [`planner::expected_sigma_arcmin`] applied to `base_sigma_arcmin`, and the magnitude
/// comes from the star catalogue when the body is a catalogue star (the Sun and anything
/// else gets `None`).
///
/// A body the provider does not know, or a time outside its coverage, is an **error**,
/// not a silent omission: a plan that quietly dropped half the sky would be worse than no
/// plan. Filter the name list before calling if partial answers are wanted.
///
/// The returned order is the order of `bodies`, which the planner's tie-break depends on.
pub fn visible_bodies(
    provider: &dyn AstroProvider,
    bodies: &[String],
    position: LatLon,
    jd_utc: f64,
    min_altitude_deg: f64,
    base_sigma_arcmin: f64,
) -> Result<Vec<Candidate>, EphemerisError> {
    let observer = Point::from_deg(position.lat_deg, position.lon_deg);
    let mut out = Vec::new();
    for body in bodies {
        let d = provider.geocentric(body, jd_utc)?;
        let (h, zn) = altitude_azimuth(observer, d.gha_deg.to_radians(), d.dec_deg.to_radians());
        let altitude_deg = h.to_degrees();
        // A NaN altitude fails this test and is dropped, which is the intent.
        if altitude_deg < min_altitude_deg || altitude_deg.is_nan() {
            continue;
        }
        out.push(Candidate {
            body: body.clone(),
            altitude_deg,
            azimuth_deg: zn.to_degrees().rem_euclid(360.0),
            sigma_arcmin: planner::expected_sigma_arcmin(base_sigma_arcmin, altitude_deg),
            magnitude: catalog::find(body).map(|s| s.magnitude),
            note: String::new(),
        });
    }
    Ok(out)
}

/// The twilight sentence for a Sun altitude, or the honest admission when there is none.
///
/// | Sun altitude | note |
/// |---|---|
/// | above -6 deg | [`NOTE_TOO_BRIGHT`] |
/// | -12 to -6 deg | [`NOTE_NAUTICAL`] |
/// | below -12 deg | [`NOTE_DARK`] |
/// | `None` or `NaN` | [`NOTE_SUN_UNKNOWN`] |
///
/// The middle band is the reason star sights are taken at twilight at all: the stars are
/// out and the sea horizon is still a sharp line. In full dark the stars are better and
/// the horizon is gone, which is a statement about the *horizon reference*, not about the
/// stars — hence the pointer to an artificial horizon or an electronic vertical
/// (CONVENTIONS section 5).
pub fn sun_altitude_note(sun_altitude_deg: Option<f64>) -> &'static str {
    match sun_altitude_deg {
        Some(a) if a.is_finite() => {
            if a > CIVIL_TWILIGHT_DEG {
                NOTE_TOO_BRIGHT
            } else if a >= NAUTICAL_TWILIGHT_DEG {
                NOTE_NAUTICAL
            } else {
                NOTE_DARK
            }
        }
        _ => NOTE_SUN_UNKNOWN,
    }
}

/// Attach [`sun_altitude_note`] to every **star** candidate, in place.
///
/// The Sun itself is skipped: the note is about whether stars can be seen, and saying
/// "sky likely too bright for stars" on a Sun sight would be nonsense. An existing note
/// is kept and the twilight sentence appended after `"; "`.
pub fn sun_altitude_flag(candidates: &mut [Candidate], sun_altitude_deg: Option<f64>) {
    let note = sun_altitude_note(sun_altitude_deg);
    for c in candidates.iter_mut() {
        if c.body.eq_ignore_ascii_case("sun") {
            continue;
        }
        if c.note.trim().is_empty() {
            c.note = note.to_string();
        } else if !c.note.contains(note) {
            c.note = format!("{}; {}", c.note.trim_end_matches(['.', ' ']), note);
        }
    }
}

/// Query, flag and rank in one call: the whole observation plan for one place and time.
///
/// `catalogue_names` is the set of bodies to consider — typically
/// `StarProvider::bodies()` mapped to `String`. Bodies below
/// `options.min_altitude_deg` never reach the ranking, so they do not clutter the plan's
/// notes; the count that survived is noted instead. Bodies *above*
/// `options.max_altitude_deg` do reach it and are excluded individually with the
/// near-zenith reason, because that exclusion is the surprising one.
///
/// `sun_altitude_deg` is supplied by the caller (see the module docs).
pub fn plan_at(
    provider: &dyn AstroProvider,
    catalogue_names: &[String],
    position: LatLon,
    utc: &str,
    options: &PlanOptions,
    sun_altitude_deg: Option<f64>,
) -> Result<Plan, EphemerisError> {
    let jd_utc = parse_utc(utc).map_err(|e| EphemerisError::Data(e.to_string()))?;
    let mut candidates = visible_bodies(
        provider,
        catalogue_names,
        position,
        jd_utc,
        options.min_altitude_deg,
        options.base_sigma_arcmin,
    )?;
    sun_altitude_flag(&mut candidates, sun_altitude_deg);
    let mut plan = planner::rank(&candidates, position, utc, options);
    plan.notes.push(format!(
        "{} of {} bodies offered by {} are at or above the {:.1} deg minimum altitude at \
         this place and time; the rest were never ranked",
        candidates.len(),
        catalogue_names.len(),
        provider.name(),
        options.min_altitude_deg
    ));
    plan.notes.push(format!(
        "twilight flag from the supplied Sun altitude: {}",
        sun_altitude_note(sun_altitude_deg)
    ));
    Ok(plan)
}

// ---------------------------------------------------------------------------
// Tonight's sights: the twilight sight planner (navigation-Moon agent, wave 2)
// ---------------------------------------------------------------------------
//
// `plan_sights` finds the next evening and morning nautical twilight in a span of
// time, and for each recommends the bodies to shoot — stars, the four navigational
// planets and the Moon, whichever are validated for sights — ranked by the planner
// above for the geometry of the fix, with the sextant reading and bearing predicted
// for the moment the twilight begins. docs/NAVIGATION_SKY.md, "Tonight's sights".

/// Sampling step for the Sun's altitude, minutes (CONVENTIONS 13.3 allows 20).
const TWILIGHT_STEP_MIN: f64 = 10.0;
/// Root refinement for the twilight instants, days (under a second).
const TWILIGHT_TOLERANCE_DAYS: f64 = 0.5 / 86_400.0;
/// Fewer eligible bodies than this and the brightness limit is relaxed.
pub const MIN_RECOMMENDED: usize = 3;
/// The faintest limit ever applied: every navigational star is brighter.
pub const FAINTEST_LIMIT_MAG: f64 = 3.0;

/// The faintest body worth offering at a given Sun altitude: magnitude 1.5 with the Sun
/// at -6 degrees (only the first-magnitude stars and the planets show against the
/// bright horizon), 3.0 with the Sun at -12 degrees (every navigational star), linear
/// between. A planning heuristic, stated in every plan's notes; it is not a model of
/// the sky's brightness.
pub fn twilight_limiting_magnitude(sun_altitude_deg: f64) -> f64 {
    (1.5 + 0.25 * (CIVIL_TWILIGHT_DEG - sun_altitude_deg)).clamp(1.5, FAINTEST_LIMIT_MAG)
}

/// The Sun's topocentric geometric altitude (CONVENTIONS 13.2) at a sea-level site.
fn sun_altitude_at(sky: &Sky, site: &TopoSite, jd: f64) -> Result<f64, EphemerisError> {
    let st = sky.apparent_state(crate::body::SUN, jd)?;
    Ok(horizontal(&st, site).alt_deg)
}

/// Instants in `[from, to]` at which the Sun crosses `level`, with `true` for rising.
fn sun_crossings(sky: &Sky, site: &TopoSite, from: f64, to: f64, level: f64) -> Vec<(f64, bool)> {
    let step = TWILIGHT_STEP_MIN / 1440.0;
    let n = ((to - from) / step).ceil().max(1.0) as usize;
    let mut out = Vec::new();
    let mut prev: Option<(f64, f64)> = None;
    for k in 0..=n {
        let t = from + (to - from) * k as f64 / n as f64;
        let Ok(h) = sun_altitude_at(sky, site, t) else {
            prev = None;
            continue;
        };
        if let Some((tp, hp)) = prev
            && (hp - level < 0.0) != (h - level < 0.0)
        {
            let (mut a, mut b) = (tp, t);
            let rising = h > hp;
            while b - a > TWILIGHT_TOLERANCE_DAYS {
                let m = 0.5 * (a + b);
                match sun_altitude_at(sky, site, m) {
                    Ok(hm) if (hm - level < 0.0) == (hp - level < 0.0) => a = m,
                    Ok(_) => b = m,
                    Err(_) => break,
                }
            }
            out.push((0.5 * (a + b), rising));
        }
        prev = Some((t, h));
    }
    out
}

/// The instant of the Sun's lowest (or highest) altitude in `[a, b]`, sampled.
fn sun_extreme(sky: &Sky, site: &TopoSite, a: f64, b: f64, lowest: bool) -> f64 {
    let n = 96;
    let mut best = (a, if lowest { f64::MAX } else { f64::MIN });
    for k in 0..=n {
        let t = a + (b - a) * k as f64 / n as f64;
        if let Ok(h) = sun_altitude_at(sky, site, t)
            && ((lowest && h < best.1) || (!lowest && h > best.1))
        {
            best = (t, h);
        }
    }
    best.0
}

/// One nautical twilight at a place: `kind` is `"evening"` or `"morning"`.
#[derive(Debug, Clone, PartialEq)]
pub struct NauticalTwilight {
    pub kind: &'static str,
    pub jd_start: f64,
    pub jd_end: f64,
    /// Set when the Sun does not reach -12 degrees and the window is cut at its lowest.
    pub note: Option<String>,
}

/// Nautical twilight periods overlapping `[jd_start, jd_end]` at a sea-level site, in
/// time order: evening from the Sun's descent through -6 degrees to -12, morning from
/// its ascent through -12 to -6 (the Sun's centre, topocentric and geometric, CONVENTIONS
/// 13.3; sampled every 10 minutes, refined to half a second). When the Sun never gets
/// below -12 degrees the evening window ends, and the morning one begins, at its lowest
/// point.
pub fn nautical_twilights(
    sky: &Sky,
    lat_deg: f64,
    lon_deg: f64,
    jd_start: f64,
    jd_end: f64,
) -> Vec<NauticalTwilight> {
    twilight_periods(sky, &TopoSite::new(lat_deg, lon_deg), jd_start, jd_end)
        .into_iter()
        .map(|(kind, jd_start, jd_end, note)| NauticalTwilight {
            kind,
            jd_start,
            jd_end,
            note,
        })
        .collect()
}

fn twilight_periods(
    sky: &Sky,
    site: &TopoSite,
    jd_start: f64,
    jd_end: f64,
) -> Vec<(&'static str, f64, f64, Option<String>)> {
    let (from, to) = (jd_start - 1.0, jd_end + 1.0);
    let civil = sun_crossings(sky, site, from, to, CIVIL_TWILIGHT_DEG);
    let nautical = sun_crossings(sky, site, from, to, NAUTICAL_TWILIGHT_DEG);
    let mut out = Vec::new();
    for (i, &(t, rising)) in civil.iter().enumerate() {
        if !rising {
            // Evening: down through -6. The window ends at the next descent through
            // -12, unless the Sun comes back up through -6 first.
            let next_up = civil[i + 1..]
                .iter()
                .find(|c| c.1)
                .map(|c| c.0)
                .unwrap_or(to);
            match nautical.iter().find(|n| !n.1 && n.0 > t && n.0 < next_up) {
                Some(&(end, _)) => out.push(("evening", t, end, None)),
                None => {
                    let low = sun_extreme(sky, site, t, next_up, true);
                    out.push((
                        "evening",
                        t,
                        low,
                        Some(
                            "the Sun does not reach -12 degrees tonight: nautical twilight lasts \
                             all night, and this window ends at the Sun's lowest point"
                                .to_string(),
                        ),
                    ));
                }
            }
        } else {
            // Morning: up through -6; the window began at the last ascent through -12
            // since the Sun went down through -6.
            let prev_down = civil[..i]
                .iter()
                .rev()
                .find(|c| !c.1)
                .map(|c| c.0)
                .unwrap_or(from);
            match nautical
                .iter()
                .rev()
                .find(|n| n.1 && n.0 < t && n.0 > prev_down)
            {
                Some(&(start, _)) => out.push(("morning", start, t, None)),
                None => {
                    let low = sun_extreme(sky, site, prev_down, t, true);
                    out.push((
                        "morning",
                        low,
                        t,
                        Some(
                            "the Sun did not reach -12 degrees: this window begins at its lowest \
                             point"
                                .to_string(),
                        ),
                    ));
                }
            }
        }
    }
    out.retain(|(_, s, e, _)| *e > jd_start && *s <= jd_end);
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out
}

/// The Moon's lit limb, seen from `observer`: upper when the bright limb faces the
/// zenith. The bright limb's position angle `chi` (from celestial north through east)
/// less the parallactic angle `q` is measured from the zenith (docs/EXPLORER_API.md).
fn lit_limb(chi_deg: f64, gha_deg: f64, dec_deg: f64, observer: &SightObserver) -> Limb {
    let lha = (gha_deg + observer.lon_deg).to_radians();
    let (phi, dec) = (observer.lat_deg.to_radians(), dec_deg.to_radians());
    let q = lha
        .sin()
        .atan2(phi.tan() * dec.cos() - dec.sin() * lha.cos());
    if (chi_deg.to_radians() - q).cos() > 0.0 {
        Limb::Upper
    } else {
        Limb::Lower
    }
}

/// The twilight sight plan (module notes above; CONVENTIONS 13.3 for the twilight).
///
/// `sky` supplies the Sun for the twilight and the magnitudes; `sights` supplies the
/// directions the sights refer to (the auto composition, with Venus at its centre of
/// light). `bodies` are the candidates (normally
/// [`crate::sights::sight_bodies`] without the Sun). `options` are the planner's; its
/// `select` is clamped to 3-5.
#[allow(clippy::too_many_arguments)]
pub fn plan_sights(
    sky: &Sky,
    sights: &dyn AstroProvider,
    bodies: &[&str],
    observer: &SightObserver,
    jd_start: f64,
    jd_end: f64,
    instrument: &Instrument,
    options: &PlanOptions,
) -> Result<SightPlan, EphemerisError> {
    if !(jd_start.is_finite() && jd_end.is_finite()) || jd_end <= jd_start {
        return Err(EphemerisError::Data(
            "plan_sights: the window must have jd_end after jd_start".to_string(),
        ));
    }
    if jd_end - jd_start > 7.0 {
        return Err(EphemerisError::Data(
            "plan_sights: the window may span at most 7 days".to_string(),
        ));
    }
    let site = TopoSite::new(observer.lat_deg, observer.lon_deg);
    let mut options = options.clone();
    options.select = options.select.clamp(MIN_RECOMMENDED, 5);

    let periods = twilight_periods(sky, &site, jd_start, jd_end);
    let mut windows = Vec::new();
    for kind in ["evening", "morning"] {
        if let Some((_, start, end, note)) = periods.iter().find(|p| p.0 == kind) {
            windows.push(plan_window(
                sky,
                sights,
                bodies,
                observer,
                instrument,
                &options,
                kind,
                *start,
                *end,
                jd_start,
                note.clone(),
            )?);
        }
    }
    windows.sort_by(|a, b| a.jd_start.total_cmp(&b.jd_start));
    let mut notes = vec![
        "nautical twilight: the Sun's centre between -6 and -12 degrees, topocentric and \
         geometric (CONVENTIONS 13.3-13.4); evening from -6 down to -12, morning from -12 up \
         to -6"
            .to_string(),
        "predictions are for the start of each window; the bodies move up to 15 degrees an \
         hour, so recompute before a late sight"
            .to_string(),
        "Venus is sighted at its centre of light, as the Nautical Almanac tabulates it".to_string(),
    ];
    if windows.is_empty() {
        notes.push(
            "no nautical twilight in this window: the Sun stays above -6 degrees or below -12 \
             degrees throughout (polar day or night), or the window is too short"
                .to_string(),
        );
    }
    Ok(SightPlan {
        observer: *observer,
        jd_start,
        utc_start: format_utc(jd_start),
        jd_end,
        utc_end: format_utc(jd_end),
        windows,
        notes,
    })
}

#[allow(clippy::too_many_arguments)]
fn plan_window(
    sky: &Sky,
    sights: &dyn AstroProvider,
    bodies: &[&str],
    observer: &SightObserver,
    instrument: &Instrument,
    options: &PlanOptions,
    kind: &str,
    start: f64,
    end: f64,
    jd_start: f64,
    period_note: Option<String>,
) -> Result<TwilightPlan, EphemerisError> {
    let site = TopoSite::new(observer.lat_deg, observer.lon_deg);
    let t0 = start.max(jd_start);
    let sun_alt = sun_altitude_at(sky, &site, t0)?;
    let position = LatLon {
        lat_deg: observer.lat_deg,
        lon_deg: observer.lon_deg,
    };
    let point = Point::from_deg(observer.lat_deg, observer.lon_deg);
    let mut notes: Vec<String> = period_note.into_iter().collect();

    // Every candidate above the altitude floor, with its magnitude and direction.
    struct Seen {
        candidate: Candidate,
        direction: skyfix_core::types::GeocentricDirection,
        kind: BodyKind,
    }
    let mut seen: Vec<Seen> = Vec::new();
    for body in bodies {
        let direction = match sights.geocentric(body, t0) {
            Ok(d) => d,
            Err(e) => {
                notes.push(format!("{body} left out: {e}"));
                continue;
            }
        };
        let (h, zn) = altitude_azimuth(
            point,
            direction.gha_deg.to_radians(),
            direction.dec_deg.to_radians(),
        );
        let altitude_deg = h.to_degrees();
        if altitude_deg < options.min_altitude_deg || altitude_deg.is_nan() {
            continue;
        }
        let state = sky.apparent_state(body, t0)?;
        seen.push(Seen {
            candidate: Candidate {
                body: state.body.clone(),
                altitude_deg,
                azimuth_deg: zn.to_degrees().rem_euclid(360.0),
                sigma_arcmin: planner::expected_sigma_arcmin(
                    options.base_sigma_arcmin,
                    altitude_deg,
                ),
                magnitude: state.magnitude,
                note: String::new(),
            },
            direction,
            kind: state.kind,
        });
    }

    // Bright enough for this Sun altitude; relaxed when too few are left.
    let mut limit = twilight_limiting_magnitude(sun_alt);
    let eligible = |limit: f64| {
        seen.iter()
            .filter(|s| {
                s.candidate.magnitude.is_none_or(|m| m <= limit)
                    && s.candidate.altitude_deg <= options.max_altitude_deg
            })
            .count()
    };
    notes.push(format!(
        "brightness limit {limit:.1} mag with the Sun at {sun_alt:.1} deg (1.5 at -6 deg, 3.0 at \
         -12 deg: a planning rule of thumb, not a sky-brightness model)"
    ));
    if eligible(limit) < MIN_RECOMMENDED && limit < FAINTEST_LIMIT_MAG {
        limit = FAINTEST_LIMIT_MAG;
        notes.push(format!(
            "fewer than {MIN_RECOMMENDED} bodies were that bright, so every navigational body \
             up to magnitude {limit:.1} was considered"
        ));
    }
    let faint: Vec<String> = seen
        .iter()
        .filter(|s| s.candidate.magnitude.is_some_and(|m| m > limit))
        .map(|s| s.candidate.body.clone())
        .collect();
    if !faint.is_empty() {
        notes.push(format!("too faint for this twilight: {}", faint.join(", ")));
    }
    // Bright enough and within the altitude window: the eligible set. The subset with
    // the best spread round the horizon is chosen (planner::best_spread_subset: the fix
    // with a shared altitude error also unknown), then ordered and explained by the
    // planner's ranking.
    let eligible: Vec<Candidate> = seen
        .iter()
        .filter(|s| {
            s.candidate.magnitude.is_none_or(|m| m <= limit)
                && s.candidate.altitude_deg <= options.max_altitude_deg
        })
        .map(|s| s.candidate.clone())
        .collect();
    let k = options.select.min(eligible.len());
    let chosen_idx = planner::best_spread_subset(&eligible, k);
    let chosen: Vec<Candidate> = chosen_idx.iter().map(|&i| eligible[i].clone()).collect();
    let others: Vec<String> = eligible
        .iter()
        .enumerate()
        .filter(|(i, _)| !chosen_idx.contains(i))
        .map(|(_, c)| c.body.clone())
        .collect();
    if !chosen.is_empty() {
        notes.push(format!(
            "{} chosen from {} eligible bodies for the best spread round the horizon: the              smallest fix error when a shared altitude error (dip, index error, refraction)              is unknown too, which only bodies on all sides can cancel",
            chosen.len(),
            eligible.len()
        ));
    }
    if !others.is_empty() {
        notes.push(format!("also eligible: {}", others.join(", ")));
    }
    let mut rank_options = options.clone();
    rank_options.select = k;
    let plan = planner::rank(&chosen, position, &format_utc(t0), &rank_options);
    if plan.bodies.len() < MIN_RECOMMENDED {
        notes.push(format!(
            "only {} suitable bodies in this twilight: a fix needs at least two, and three or \
             more well spread in azimuth make it trustworthy",
            plan.bodies.len()
        ));
    }

    let mut recommended = Vec::new();
    for planned in &plan.bodies {
        let Some(s) = seen.iter().find(|s| s.candidate.body == planned.body) else {
            continue;
        };
        let limb = if s.kind == BodyKind::Moon {
            let state = sky.apparent_state(&planned.body, t0)?;
            state
                .bright_limb_angle_deg
                .map(|chi| lit_limb(chi, s.direction.gha_deg, s.direction.dec_deg, observer))
                .unwrap_or(Limb::Lower)
        } else {
            Limb::Center
        };
        match skyfix_core::sights::predict::predict_sextant(
            observer,
            instrument,
            &planned.body,
            limb,
            t0,
            s.direction,
            sights.name(),
        ) {
            Ok(prediction) => recommended.push(RecommendedSight {
                body: planned.body.clone(),
                kind: match s.kind {
                    BodyKind::Sun => "sun",
                    BodyKind::Moon => "moon",
                    BodyKind::Planet => "planet",
                    BodyKind::Star => "star",
                }
                .to_string(),
                magnitude: s.candidate.magnitude,
                step: planned.step,
                limb,
                hc_deg: prediction.hc_deg,
                zn_deg: prediction.zn_deg,
                hs_deg: prediction.hs_deg,
                rationale: if s.kind == BodyKind::Moon {
                    format!(
                        "{} Its {} limb is the lit one.",
                        planned.rationale,
                        if limb == Limb::Upper {
                            "upper"
                        } else {
                            "lower"
                        }
                    )
                } else {
                    planned.rationale.clone()
                },
                prediction,
            }),
            Err(e) => notes.push(format!("{}: no prediction ({e})", planned.body)),
        }
    }

    Ok(TwilightPlan {
        kind: kind.to_string(),
        jd_start: start,
        utc_start: format_utc(start),
        jd_end: end,
        utc_end: format_utc(end),
        jd_predicted: t0,
        utc_predicted: format_utc(t0),
        sun_altitude_deg: sun_alt,
        limiting_magnitude: limit,
        sights: recommended,
        also_eligible: others,
        plan,
        notes,
    })
}

#[cfg(test)]
mod sight_plan_tests {
    use super::*;

    fn at(lat: f64, lon: f64) -> SightObserver {
        SightObserver {
            lat_deg: lat,
            lon_deg: lon,
            height_of_eye_m: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        }
    }

    #[test]
    fn the_lit_limb_is_the_one_facing_the_sun() {
        // A Moon rising due east on the equator: the zenith lies to the west of it on the
        // sky (parallactic angle -90). A Sun to the west, above, lights the upper limb; a
        // Sun to the east, below the horizon, the lower.
        let o = at(0.0, 0.0);
        assert_eq!(lit_limb(270.0, 300.0, 0.0, &o), Limb::Upper);
        assert_eq!(lit_limb(90.0, 300.0, 0.0, &o), Limb::Lower);
        // Setting in the west, the zenith is to the east of it.
        assert_eq!(lit_limb(90.0, 60.0, 0.0, &o), Limb::Upper);
        assert_eq!(lit_limb(270.0, 60.0, 0.0, &o), Limb::Lower);
    }

    #[test]
    fn the_brightness_limit_runs_from_first_magnitude_at_civil_dusk_to_third() {
        assert_eq!(twilight_limiting_magnitude(-3.0), 1.5);
        assert_eq!(twilight_limiting_magnitude(-6.0), 1.5);
        assert!((twilight_limiting_magnitude(-9.0) - 2.25).abs() < 1e-12);
        assert_eq!(twilight_limiting_magnitude(-12.0), 3.0);
        assert_eq!(twilight_limiting_magnitude(-15.0), 3.0);
    }
}
