//! Offline astronomy for SkyFix Lab.
//!
//! OWNER: ephemeris agent. Everything here must build for `wasm32-unknown-unknown`
//! without `std::fs` or network: data is embedded with `include_str!` / `include_bytes!`
//! or handed in as strings by the caller.
//!
//! Output frame is CONVENTIONS section 7 (apparent geocentric of date). Every provider
//! declares its coverage and refuses queries outside it.

pub mod body;
pub mod catalog;
pub mod fixture_pack;
pub mod frames;
pub mod moon;
pub mod pack;
pub mod planets;
pub mod series;
pub mod sidereal;
pub mod sights;
pub mod stars;
pub mod sun;
pub mod tiers;
pub mod topocentric;
pub mod visibility;

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

    /// The coverage tiers this provider answers (CONVENTIONS 15.1): the validated tier
    /// and, when the provider was built to answer it, the labelled tier, each with its
    /// measured accuracy. Empty for a provider that predates tiers (its coverage is then
    /// just `coverage()`).
    fn tiers(&self) -> Vec<tiers::CoverageTier> {
        Vec::new()
    }
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
        // Trimmed and case-insensitive, like the correction chain: the same record must
        // not be the Sun for semidiameter and parallax and a star for the clock rate.
        // Without an instant the Moon gets its mean rate, never the sidereal one.
        skyfix_core::reduce::nominal_gha_rate_deg_per_hour(body)
    }
    /// CONVENTIONS 13.1: the Sun and the stars keep their fixed rates (bit for bit what
    /// they always had); the Moon and the planets get the provider's own GHA rate at the
    /// sight's instant, a central difference over +/-60 s.
    fn gha_rate_deg_per_hour_at(&self, body: &str, jd_utc: f64) -> f64 {
        use skyfix_core::corrections::{SightBody, sight_body};
        match sight_body(body) {
            SightBody::Sun | SightBody::Star => self.gha_rate_deg_per_hour(body),
            SightBody::Moon | SightBody::Planet => {
                provider_gha_rate_deg_per_hour(&self.0, body, jd_utc)
                    .unwrap_or_else(|| self.gha_rate_deg_per_hour(body))
            }
        }
    }
}

/// A provider's own GHA rate for `body` at `jd_utc`, degrees per hour: the central
/// difference over +/-60 s with the 360-degree wrap removed (CONVENTIONS 13.1), or a
/// one-sided difference at the edge of the provider's coverage. `None` when the provider
/// cannot answer on either side.
pub fn provider_gha_rate_deg_per_hour(
    provider: &(impl AstroProvider + ?Sized),
    body: &str,
    jd_utc: f64,
) -> Option<f64> {
    let h = 60.0 / 86_400.0;
    let gha = |jd: f64| provider.geocentric(body, jd).ok().map(|d| d.gha_deg);
    let rate = |a: f64, b: f64, span_days: f64| {
        let d = (b - a + 540.0).rem_euclid(360.0) - 180.0;
        d / (span_days * 24.0)
    };
    match (gha(jd_utc - h), gha(jd_utc + h)) {
        (Some(a), Some(b)) => Some(rate(a, b, 2.0 * h)),
        (None, Some(b)) => gha(jd_utc).map(|a| rate(a, b, h)),
        (Some(a), None) => gha(jd_utc).map(|b| rate(a, b, h)),
        (None, None) => None,
    }
}
