//! CONVENTIONS sections 3-5: observation -> reduced sight -> solver input.
//!
//! OWNER: core-reduce agent.
//!
//! One observation becomes one [`ReducedSight`]: the recorded time is parsed and the
//! chronometer correction applied (section 6), a body direction is obtained (supplied on
//! the record, else from a [`DirectionSource`]), the correction chain runs (section 5),
//! and — only when the session carries an assumed position — `Hc`, `Zn` and the
//! intercept are computed with [`crate::geometry`] (section 3). The assumed position is
//! a reference point for the sight-reduction table; it is never a prior and never
//! reaches the solver from here.

use crate::SkyfixError;
use crate::corrections::{self, CorrectionInputs};
use crate::geometry::{self, Point};
use crate::types::{GeocentricDirection, Observation, ReducedSight, Session, Sight, Warning};
use crate::units;

/// Supplies a body direction for an observation when the record has none.
/// Implemented by `skyfix-ephemeris` providers; the core only knows the shape.
pub trait DirectionSource {
    fn name(&self) -> &str;
    /// Apparent geocentric GHA/Dec (degrees) at `jd_utc`, or an explanation.
    fn direction(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, String>;
    /// GHA rate for clock propagation, degrees per hour (sidereal for stars).
    fn gha_rate_deg_per_hour(&self, body: &str) -> f64;
}

/// A source that only honours directions supplied in the observation itself.
pub struct SuppliedOnly;

impl DirectionSource for SuppliedOnly {
    fn name(&self) -> &str {
        "supplied"
    }
    fn direction(&self, _body: &str, _jd_utc: f64) -> Result<GeocentricDirection, String> {
        Err("no ephemeris provider configured; supply gha_deg/dec_deg in the observation".into())
    }
    fn gha_rate_deg_per_hour(&self, body: &str) -> f64 {
        // `is_sun` trims: the same record must not be the Sun for the correction chain
        // (semidiameter, parallax) and a star for the clock rate.
        if is_sun(body) {
            crate::units::SOLAR_RATE_DEG_PER_HOUR
        } else {
            crate::units::SIDEREAL_RATE_DEG_PER_HOUR
        }
    }
}

/// The name that marks a direction taken from the observation record itself.
pub const SUPPLIED_DIRECTION_SOURCE: &str = "supplied";

/// True when this body name is the Sun, the only body with semidiameter and parallax
/// corrections in this release (CONVENTIONS section 5, steps 4-5).
pub fn is_sun(body: &str) -> bool {
    body.trim().eq_ignore_ascii_case("sun")
}

/// Reduce one observation. If the session has an assumed position, `hc`, `zn` and the
/// intercept are computed there; otherwise they are `None`.
pub fn reduce_observation(
    session: &Session,
    obs: &Observation,
    source: &dyn DirectionSource,
) -> Result<ReducedSight, SkyfixError> {
    let id = obs.id.as_str();

    // --- time (section 6) ----------------------------------------------------
    let jd_recorded = crate::time::parse_utc(&obs.utc)?;
    let correction_s = session.clock.correction_s;
    if !correction_s.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: "clock.correction_s".to_string(),
        });
    }
    // A known chronometer correction is ADDED to every recorded time before use.
    let jd_utc = jd_recorded + correction_s / 86_400.0;

    // --- body direction (section 7) -----------------------------------------
    let mut warnings: Vec<Warning> = Vec::new();
    let (direction, direction_source) = match obs.geocentric {
        Some(d) => {
            // A supplied direction wins over any provider, and the report says so.
            warnings.push(Warning::SuppliedDirectionUsed { id: id.to_string() });
            (d, SUPPLIED_DIRECTION_SOURCE.to_string())
        }
        None => match source.direction(&obs.body, jd_utc) {
            Ok(d) => (d, source.name().to_string()),
            Err(reason) => {
                return Err(SkyfixError::NoDirection {
                    id: id.to_string(),
                    reason,
                });
            }
        },
    };
    let (gha_deg, dec_deg) = check_direction(id, &direction)?;

    // --- correction chain (section 5) ---------------------------------------
    let horizon = obs.horizon.unwrap_or(session.instrument.horizon);
    let breakdown = corrections::correct(
        obs.altitude_deg,
        obs.altitude_kind,
        obs.sigma_arcmin,
        CorrectionInputs {
            id,
            is_sun: is_sun(&obs.body),
            limb: obs.limb,
            horizon,
            index_correction_arcmin: session.instrument.index_correction_arcmin,
            height_of_eye_m: session.observer.height_of_eye_m,
            pressure_hpa: session.observer.pressure_hpa,
            temperature_c: session.observer.temperature_c,
            direction: Some(direction),
        },
    )?;
    warnings.extend(breakdown.warnings.iter().cloned());

    // --- sight reduction at the assumed position (section 3) ----------------
    let (hc_deg, zn_deg, intercept_nm) = match session.observer.assumed_position {
        Some(ap) => {
            check_assumed_position(&ap)?;
            let observer = Point::from_deg(ap.lat_deg, ap.lon_deg);
            let (hc_rad, zn_rad) =
                geometry::altitude_azimuth(observer, gha_deg.to_radians(), dec_deg.to_radians());
            let hc = hc_rad.to_degrees();
            // 1 arcminute of altitude = 1 nautical mile of intercept (section 1);
            // positive means "Ho more, toward" (section 3).
            let intercept = (breakdown.ho_deg - hc) * 60.0;
            (
                Some(hc),
                Some(units::norm_360(zn_rad.to_degrees())),
                Some(intercept),
            )
        }
        None => (None, None, None),
    };

    Ok(ReducedSight {
        id: obs.id.clone(),
        body: obs.body.clone(),
        utc: obs.utc.clone(),
        jd_utc,
        gha_deg,
        dec_deg,
        direction_source,
        ho_deg: breakdown.ho_deg,
        sigma_arcmin: breakdown.sigma_ho_arcmin,
        corrections: breakdown,
        hc_deg,
        zn_deg,
        intercept_nm,
        warnings,
    })
}

/// Reduce every observation. Errors on any rejected sight are returned in order; the
/// caller decides whether to continue with the rest.
pub fn reduce_session(
    session: &Session,
    source: &dyn DirectionSource,
) -> Vec<Result<ReducedSight, SkyfixError>> {
    session
        .observations
        .iter()
        .map(|obs| reduce_observation(session, obs, source))
        .collect()
}

/// Convert reduced sights to solver input (radians).
pub fn to_sights(reduced: &[ReducedSight], source: &dyn DirectionSource) -> Vec<Sight> {
    reduced
        .iter()
        .map(|r| Sight {
            id: r.id.clone(),
            body: r.body.clone(),
            gha_rad: r.gha_deg.to_radians(),
            dec_rad: r.dec_deg.to_radians(),
            ho_rad: r.ho_deg.to_radians(),
            sigma_rad: units::arcmin_to_rad(r.sigma_arcmin),
            gha_rate_rad_per_s: source.gha_rate_deg_per_hour(&r.body).to_radians() / 3600.0,
        })
        .collect()
}

/// Reduce a session and keep only the sights that survived, alongside the failures.
/// Convenience for the CLI and the WASM adapter: one rejected sight never discards
/// the others (CONVENTIONS section 8 decides what to do with what is left).
pub fn reduce_session_partitioned(
    session: &Session,
    source: &dyn DirectionSource,
) -> (Vec<ReducedSight>, Vec<SkyfixError>) {
    let mut ok = Vec::new();
    let mut err = Vec::new();
    for r in reduce_session(session, source) {
        match r {
            Ok(s) => ok.push(s),
            Err(e) => err.push(e),
        }
    }
    (ok, err)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Finiteness and range of a body direction, returning `(gha_deg in [0,360), dec_deg)`.
/// A provider may legitimately return an unnormalised GHA; a declination outside
/// `[-90, 90]` has no normalised reading and is an error.
fn check_direction(id: &str, d: &GeocentricDirection) -> Result<(f64, f64), SkyfixError> {
    if !d.gha_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: format!("observation {id}: gha_deg"),
        });
    }
    if !d.dec_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: format!("observation {id}: dec_deg"),
        });
    }
    if !(-90.0..=90.0).contains(&d.dec_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: format!("observation {id}: dec_deg"),
            value: d.dec_deg,
            min: -90.0,
            max: 90.0,
            max_exclusive: false,
        });
    }
    Ok((units::norm_360(d.gha_deg), d.dec_deg))
}

fn check_assumed_position(ap: &crate::types::LatLon) -> Result<(), SkyfixError> {
    if !ap.lat_deg.is_finite() || !ap.lon_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: "observer.assumed_position".to_string(),
        });
    }
    if !(-90.0..=90.0).contains(&ap.lat_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: "observer.assumed_position.lat_deg".to_string(),
            value: ap.lat_deg,
            min: -90.0,
            max: 90.0,
            max_exclusive: false,
        });
    }
    if !(-180.0..=180.0).contains(&ap.lon_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: "observer.assumed_position.lon_deg".to_string(),
            value: ap.lon_deg,
            min: -180.0,
            max: 180.0,
            max_exclusive: false,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sun_is_recognised_case_insensitively() {
        assert!(is_sun("Sun"));
        assert!(is_sun("sun"));
        assert!(is_sun("SUN"));
        assert!(is_sun(" Sun "));
        assert!(!is_sun("Sunflower"));
        assert!(!is_sun("Vega"));
    }

    #[test]
    fn supplied_only_source_explains_itself() {
        let s = SuppliedOnly;
        assert_eq!(s.name(), "supplied");
        let e = s.direction("Vega", 2_461_306.5).unwrap_err();
        assert!(e.contains("supply gha_deg/dec_deg"), "{e}");
        assert_eq!(
            s.gha_rate_deg_per_hour("Sun"),
            crate::units::SOLAR_RATE_DEG_PER_HOUR
        );
        assert_eq!(
            s.gha_rate_deg_per_hour("Vega"),
            crate::units::SIDEREAL_RATE_DEG_PER_HOUR
        );
    }
}
