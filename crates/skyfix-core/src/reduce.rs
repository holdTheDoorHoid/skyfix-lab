//! CONVENTIONS sections 3-5: observation -> reduced sight -> solver input.
//!
//! OWNER: core-reduce agent.

use crate::types::{GeocentricDirection, Observation, ReducedSight, Session, Sight};

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
        if body.eq_ignore_ascii_case("sun") {
            crate::units::SOLAR_RATE_DEG_PER_HOUR
        } else {
            crate::units::SIDEREAL_RATE_DEG_PER_HOUR
        }
    }
}

/// Reduce one observation. If the session has an assumed position, `hc`, `zn` and the
/// intercept are computed there; otherwise they are `None`.
pub fn reduce_observation(
    session: &Session,
    obs: &Observation,
    source: &dyn DirectionSource,
) -> Result<ReducedSight, crate::SkyfixError> {
    todo!("core-reduce: reduce_observation")
}

/// Reduce every observation. Errors on any rejected sight are returned in order; the
/// caller decides whether to continue with the rest.
pub fn reduce_session(
    session: &Session,
    source: &dyn DirectionSource,
) -> Vec<Result<ReducedSight, crate::SkyfixError>> {
    todo!("core-reduce: reduce_session")
}

/// Convert reduced sights to solver input (radians).
pub fn to_sights(reduced: &[ReducedSight], source: &dyn DirectionSource) -> Vec<Sight> {
    todo!("core-reduce: to_sights")
}
