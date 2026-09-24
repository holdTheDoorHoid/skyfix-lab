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
use skyfix_core::time::parse_utc;
use skyfix_core::types::LatLon;

use crate::catalog;
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
