//! Mercury to Neptune: apparent geocentric places, distance, parallax, semidiameter,
//! magnitude and phase.
//!
//! OWNER: planets agent. CONVENTIONS sections 7 and 13. Contract: implement
//! [`AstroProvider`] and [`BodyEphemeris`] for [`PlanetProvider`] for every name in
//! [`crate::body::PLANETS`], keep the constructor signatures, and validate against
//! DE440s to the targets in CONVENTIONS 13.7.
//!
//! Until then this is a stub that refuses every query with a clear message.

use skyfix_core::types::GeocentricDirection;

use crate::body::{ApparentState, BodyEphemeris, PLANETS};
use crate::{AstroProvider, Coverage, EphemerisError};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanetProvider {
    dut1_s: f64,
}

impl Default for PlanetProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl PlanetProvider {
    pub const NAME: &'static str = "skyfix-planets (not yet implemented)";

    /// DUT1 = 0 (CONVENTIONS section 6).
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    pub fn with_dut1_s(dut1_s: f64) -> Self {
        PlanetProvider { dut1_s }
    }

    pub fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    fn not_yet(&self, body: &str) -> EphemerisError {
        if PLANETS.iter().any(|p| p.eq_ignore_ascii_case(body.trim())) {
            EphemerisError::Data("the planet provider is not implemented yet".to_string())
        } else {
            EphemerisError::UnknownBody(body.to_string(), Self::NAME.to_string())
        }
    }
}

impl AstroProvider for PlanetProvider {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn coverage(&self) -> Coverage {
        Coverage {
            start_utc: crate::stars::COVERAGE_START_UTC.to_string(),
            end_utc: crate::stars::COVERAGE_END_UTC.to_string(),
            bodies: PLANETS.iter().map(|p| p.to_string()).collect(),
            notes: "Not implemented yet: every query is refused.".to_string(),
            accuracy_arcmin: f64::INFINITY,
        }
    }

    fn geocentric(&self, body: &str, _jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        Err(self.not_yet(body))
    }
}

impl BodyEphemeris for PlanetProvider {
    fn apparent_state(&self, body: &str, _jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        Err(self.not_yet(body))
    }
}
