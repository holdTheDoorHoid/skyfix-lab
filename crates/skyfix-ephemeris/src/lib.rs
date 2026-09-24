//! Offline astronomy for SkyFix Lab.
//!
//! OWNER: ephemeris agent. Everything here must build for `wasm32-unknown-unknown`
//! without `std::fs` or network: data is embedded with `include_str!` / `include_bytes!`
//! or handed in as strings by the caller.
//!
//! Output frame is CONVENTIONS section 7 (apparent geocentric of date). Every provider
//! declares its coverage and refuses queries outside it.

pub mod catalog;
pub mod fixture_pack;
pub mod frames;
pub mod sidereal;
pub mod stars;
pub mod sun;

use skyfix_core::types::GeocentricDirection;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum EphemerisError {
    #[error("body {0:?} is not provided by {1}")]
    UnknownBody(String, String),
    #[error("time {jd_utc} is outside {provider} coverage {coverage}")]
    OutOfCoverage {
        provider: String,
        jd_utc: f64,
        coverage: String,
    },
    #[error("{0}")]
    Data(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Coverage {
    pub start_utc: String,
    pub end_utc: String,
    pub bodies: Vec<String>,
    /// Provenance and accuracy notes shown to the user verbatim.
    pub notes: String,
    /// Documented angular accuracy vs the reference (arcminutes).
    pub accuracy_arcmin: f64,
}

pub trait AstroProvider {
    fn name(&self) -> &str;
    fn coverage(&self) -> Coverage;
    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError>;
}

/// Adapter so any provider can feed `skyfix_core::reduce`.
pub struct ProviderSource<P: AstroProvider>(pub P);

impl<P: AstroProvider> skyfix_core::reduce::DirectionSource for ProviderSource<P> {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn direction(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, String> {
        self.0.geocentric(body, jd_utc).map_err(|e| e.to_string())
    }
    fn gha_rate_deg_per_hour(&self, body: &str) -> f64 {
        if body.eq_ignore_ascii_case("sun") {
            skyfix_core::units::SOLAR_RATE_DEG_PER_HOUR
        } else {
            skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR
        }
    }
}
