//! Body registry and the physical-state contract every provider shares.
//!
//! CONVENTIONS section 13.1. OWNER: the planning session (contract). The Moon and
//! planet agents implement [`BodyEphemeris`] for their providers in `moon.rs` and
//! `planets.rs`; nothing else in this file should need to change for them.
//!
//! [`GeocentricDirection`] stays the navigation interface (CONVENTIONS section 7).
//! [`ApparentState`] adds what the explorer shows and the planner ranks by: distance,
//! magnitude and phase.

use serde::{Deserialize, Serialize};
use skyfix_core::types::GeocentricDirection;

use crate::moon::MoonProvider;
use crate::planets::PlanetProvider;
use crate::stars::StarProvider;
use crate::sun::SunProvider;
use crate::tiers::{CoverageTier, TierPolicy};
use crate::{AstroProvider, Coverage, EphemerisError, catalog};

/// Kilometres per astronomical unit (IAU 2012, exact).
pub const AU_KM: f64 = 149_597_870.700;

pub const SUN: &str = "Sun";
pub const MOON: &str = "Moon";
/// Every planet the explorer shows, in order from the Sun.
pub const PLANETS: [&str; 7] = [
    "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune",
];
/// The four planets the Nautical Almanac tabulates and a navigator may use.
pub const NAVIGATIONAL_PLANETS: [&str; 4] = ["Venus", "Mars", "Jupiter", "Saturn"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyKind {
    Sun,
    Moon,
    Planet,
    Star,
}

/// The canonical spelling of a body name (trimmed, case-insensitive), or `None` if
/// no provider in this crate knows it. Stars resolve through [`catalog::find`], so
/// `"HIP 91262"` and `"al nair"` work as they do everywhere else.
pub fn canonical(body: &str) -> Option<&'static str> {
    let b = body.trim();
    if b.eq_ignore_ascii_case(SUN) {
        return Some(SUN);
    }
    if b.eq_ignore_ascii_case(MOON) {
        return Some(MOON);
    }
    if let Some(p) = PLANETS.iter().find(|p| p.eq_ignore_ascii_case(b)) {
        return Some(p);
    }
    catalog::find(b).map(|s| s.name.as_str())
}

/// What kind of body a name refers to, or `None` if it is unknown.
pub fn kind(body: &str) -> Option<BodyKind> {
    let c = canonical(body)?;
    Some(match c {
        SUN => BodyKind::Sun,
        MOON => BodyKind::Moon,
        _ if PLANETS.contains(&c) => BodyKind::Planet,
        _ => BodyKind::Star,
    })
}

/// True for bodies a navigator may use (CONVENTIONS 13.1): Sun, Moon, Venus, Mars,
/// Jupiter, Saturn and the catalogue stars. Whether the provider is *validated* is a
/// separate question answered by coverage.
pub fn is_navigational(body: &str) -> bool {
    match canonical(body) {
        Some(c) if PLANETS.contains(&c) => NAVIGATIONAL_PLANETS.contains(&c),
        Some(_) => true,
        None => false,
    }
}

/// Everything the explorer needs about one body at one instant, geocentric.
///
/// Angles in degrees (CONVENTIONS section 1). `ra_deg`, `dec_deg` and `gha_deg` are
/// apparent geocentric of date (section 7), identical to what
/// [`AstroProvider::geocentric`] returns for the same body and instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApparentState {
    pub body: String,
    pub kind: BodyKind,
    pub jd_utc: f64,
    /// `[0, 360)`.
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// West-positive, `[0, 360)`.
    pub gha_deg: f64,
    /// Geocentric distance, km. `None` for stars.
    pub distance_km: Option<f64>,
    pub semidiameter_arcmin: f64,
    pub horizontal_parallax_arcmin: f64,
    /// Apparent visual magnitude, when modelled.
    pub magnitude: Option<f64>,
    /// Sun-body-Earth angle. Moon and planets only.
    pub phase_angle_deg: Option<f64>,
    /// `(1 + cos i) / 2`. Moon and planets only.
    pub illuminated_fraction: Option<f64>,
    /// Angle between the Sun and the body seen from the Earth. Moon and planets only.
    pub elongation_deg: Option<f64>,
    /// Position angle of the bright limb's midpoint, from celestial north through east.
    pub bright_limb_angle_deg: Option<f64>,
}

impl ApparentState {
    /// The navigation view of this state (CONVENTIONS section 7).
    pub fn direction(&self) -> GeocentricDirection {
        GeocentricDirection {
            gha_deg: self.gha_deg,
            dec_deg: self.dec_deg,
            semidiameter_arcmin: self.semidiameter_arcmin,
            horizontal_parallax_arcmin: self.horizontal_parallax_arcmin,
        }
    }

    /// `SHA = 360 - RA`, `[0, 360)` (CONVENTIONS section 2).
    pub fn sha_deg(&self) -> f64 {
        (360.0 - self.ra_deg).rem_euclid(360.0)
    }
}

/// A provider that can describe a body fully, not just point at it.
pub trait BodyEphemeris: AstroProvider {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError>;

    /// GHA rate in degrees per hour at `jd_utc`: a central difference of the
    /// provider's own GHA over +/-60 s with the 360-degree wrap removed
    /// (CONVENTIONS 13.1). Providers with an exact rate may override.
    fn gha_rate_deg_per_hour(&self, body: &str, jd_utc: f64) -> Result<f64, EphemerisError> {
        let h = 60.0 / 86_400.0;
        let a = self.geocentric(body, jd_utc - h)?.gha_deg;
        let b = self.geocentric(body, jd_utc + h)?.gha_deg;
        let d = (b - a + 540.0).rem_euclid(360.0) - 180.0;
        Ok(d / (2.0 * h * 24.0))
    }
}

// ---------------------------------------------------------------------------
// The Sun and the stars already exist; describe them fully here.
// ---------------------------------------------------------------------------

impl BodyEphemeris for SunProvider {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        if !skyfix_core::reduce::is_sun(body) {
            return Err(EphemerisError::UnknownBody(
                body.to_string(),
                SunProvider::NAME.to_string(),
            ));
        }
        let p = self.position(jd_utc)?;
        Ok(ApparentState {
            body: SUN.to_string(),
            kind: BodyKind::Sun,
            jd_utc,
            ra_deg: p.ra_deg,
            dec_deg: p.dec_deg,
            gha_deg: p.gha_deg,
            distance_km: Some(p.radius_au * AU_KM),
            semidiameter_arcmin: p.semidiameter_arcmin,
            horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
            // V(1 au) = -26.74; the inverse-square distance term is worth +/-0.04.
            magnitude: Some(-26.74 + 5.0 * p.radius_au.log10()),
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        })
    }
}

impl BodyEphemeris for StarProvider {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        let name = catalog::find(body).map(|s| s.name.clone()).ok_or_else(|| {
            EphemerisError::UnknownBody(body.to_string(), crate::stars::PROVIDER_NAME.to_string())
        })?;
        let (ra_deg, dec_deg) = self.apparent_radec_deg(&name, jd_utc)?;
        let dir = self.geocentric(&name, jd_utc)?;
        Ok(ApparentState {
            body: name.clone(),
            kind: BodyKind::Star,
            jd_utc,
            ra_deg,
            dec_deg,
            gha_deg: dir.gha_deg,
            distance_km: None,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
            magnitude: Some(self.magnitude(&name)?),
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        })
    }

    /// Stars move with the sky: the sidereal rate, exactly as `ProviderSource` has
    /// always used for them.
    fn gha_rate_deg_per_hour(&self, _body: &str, _jd_utc: f64) -> Result<f64, EphemerisError> {
        Ok(skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR)
    }
}

// ---------------------------------------------------------------------------
// The whole sky behind one name-dispatching provider
// ---------------------------------------------------------------------------

/// Sun, Moon, planets and the catalogue stars behind one [`BodyEphemeris`].
///
/// This is what the explorer, the event finder and the almanac use. The navigation
/// path keeps using whichever [`AstroProvider`] the caller composes.
///
/// Like every provider it answers the validated tier only unless it is built
/// [`Sky::with_policy`]`(TierPolicy::WithLabelled)`, which the explorer's display path
/// does (CONVENTIONS 15.1).
#[derive(Debug, Clone)]
pub struct Sky {
    sun: SunProvider,
    moon: MoonProvider,
    planets: PlanetProvider,
    stars: StarProvider,
}

/// One provider group's coverage with its tiers (EXPLORER_API "explorer_coverage() —
/// tiers"): [`Coverage`] describes the validated tier, as it always has; `tiers` lists
/// the validated tier and, for a sky built with [`TierPolicy::WithLabelled`], the
/// labelled one.
#[derive(Debug, Clone, PartialEq)]
pub struct TieredCoverage {
    pub coverage: Coverage,
    pub tiers: Vec<CoverageTier>,
}

impl Default for Sky {
    fn default() -> Self {
        Self::new()
    }
}

impl Sky {
    pub const NAME: &'static str = "skyfix-sky (Sun, Moon, planets, stars)";

    /// DUT1 = 0 (CONVENTIONS section 6).
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    pub fn with_dut1_s(dut1_s: f64) -> Self {
        Sky {
            sun: SunProvider::with_dut1_s(dut1_s),
            moon: MoonProvider::with_dut1_s(dut1_s),
            planets: PlanetProvider::with_dut1_s(dut1_s),
            stars: StarProvider::with_dut1(dut1_s),
        }
    }

    /// The same sky answering the tiers `policy` allows: [`TierPolicy::WithLabelled`]
    /// for display (2000 BC to AD 3000), the default [`TierPolicy::ValidatedOnly`]
    /// wherever a number feeds a sight, a fix or a plan.
    pub fn with_policy(self, policy: TierPolicy) -> Self {
        Sky {
            sun: self.sun.with_policy(policy),
            moon: self.moon.with_policy(policy),
            planets: self.planets.with_policy(policy),
            stars: self.stars.with_policy(policy),
        }
    }

    /// The tiers this sky answers.
    pub fn policy(&self) -> TierPolicy {
        self.sun.policy()
    }

    /// Every body this sky knows: Sun, Moon, the planets, then the stars in catalogue
    /// order.
    pub fn bodies(&self) -> Vec<&'static str> {
        let mut v = vec![SUN, MOON];
        v.extend(PLANETS);
        v.extend(self.stars.bodies());
        v
    }

    /// The provider responsible for `body`, or `None` if nobody knows the name.
    pub fn provider_for(&self, body: &str) -> Option<&dyn BodyEphemeris> {
        match kind(body)? {
            BodyKind::Sun => Some(&self.sun),
            BodyKind::Moon => Some(&self.moon),
            BodyKind::Planet => Some(&self.planets),
            BodyKind::Star => Some(&self.stars),
        }
    }

    /// One coverage record per provider, in the order Sun, Moon, planets, stars. Each
    /// describes the validated tier; [`Sky::tiered_coverage_groups`] adds the tiers.
    pub fn coverage_groups(&self) -> Vec<Coverage> {
        vec![
            self.sun.coverage(),
            self.moon.coverage(),
            self.planets.coverage(),
            self.stars.coverage(),
        ]
    }

    /// [`Sky::coverage_groups`] with each provider's tiers under this sky's policy.
    pub fn tiered_coverage_groups(&self) -> Vec<TieredCoverage> {
        let tiers = [
            self.sun.tiers(),
            self.moon.tiers(),
            self.planets.tiers(),
            self.stars.tiers(),
        ];
        self.coverage_groups()
            .into_iter()
            .zip(tiers)
            .map(|(coverage, tiers)| TieredCoverage { coverage, tiers })
            .collect()
    }

    fn unknown(body: &str) -> EphemerisError {
        EphemerisError::UnknownBody(body.to_string(), Self::NAME.to_string())
    }
}

impl AstroProvider for Sky {
    fn name(&self) -> &str {
        Self::NAME
    }

    /// The intersection of the providers' date ranges is not meaningful per body, so
    /// this reports the widest range and lists every body; ask
    /// [`Sky::coverage_groups`] for the per-provider truth.
    fn coverage(&self) -> Coverage {
        let groups = self.coverage_groups();
        let policy = self.policy();
        Coverage {
            start_utc: policy.start_utc().to_string(),
            end_utc: policy.end_utc().to_string(),
            bodies: self.bodies().into_iter().map(str::to_string).collect(),
            notes: groups
                .iter()
                .map(|c| c.notes.as_str())
                .collect::<Vec<_>>()
                .join(" | "),
            accuracy_arcmin: groups.iter().map(|c| c.accuracy_arcmin).fold(0.0, f64::max),
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        self.provider_for(body)
            .ok_or_else(|| Self::unknown(body))?
            .geocentric(canonical(body).unwrap_or(body), jd_utc)
    }
}

impl BodyEphemeris for Sky {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        self.provider_for(body)
            .ok_or_else(|| Self::unknown(body))?
            .apparent_state(canonical(body).unwrap_or(body), jd_utc)
    }

    fn gha_rate_deg_per_hour(&self, body: &str, jd_utc: f64) -> Result<f64, EphemerisError> {
        self.provider_for(body)
            .ok_or_else(|| Self::unknown(body))?
            .gha_rate_deg_per_hour(canonical(body).unwrap_or(body), jd_utc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve_to_canonical_spelling_and_kind() {
        assert_eq!(canonical(" sun "), Some("Sun"));
        assert_eq!(canonical("MOON"), Some("Moon"));
        assert_eq!(canonical("jupiter"), Some("Jupiter"));
        assert_eq!(canonical("vega"), Some("Vega"));
        assert_eq!(canonical("Vulcan"), None);
        assert_eq!(kind("saturn"), Some(BodyKind::Planet));
        assert_eq!(kind("Polaris"), Some(BodyKind::Star));
        assert!(is_navigational("Venus"));
        assert!(!is_navigational("Neptune"));
        assert!(is_navigational("Sirius"));
    }

    #[test]
    fn sky_lists_every_body_once() {
        let sky = Sky::new();
        let b = sky.bodies();
        assert_eq!(b.len(), 2 + 7 + 58);
        let mut sorted = b.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), b.len());
    }

    #[test]
    fn sun_and_star_states_agree_with_their_directions() {
        let sky = Sky::new();
        let jd = 2_461_310.5; // 2026-09-26T00:00Z
        for body in ["Sun", "Vega"] {
            let st = sky.apparent_state(body, jd).unwrap();
            let dir = sky.geocentric(body, jd).unwrap();
            assert_eq!(st.gha_deg, dir.gha_deg, "{body}");
            assert_eq!(st.dec_deg, dir.dec_deg, "{body}");
            assert!((0.0..360.0).contains(&st.sha_deg()));
        }
        let sun = sky.apparent_state("sun", jd).unwrap();
        let km = sun.distance_km.unwrap();
        assert!((1.47e8..1.53e8).contains(&km), "{km}");
        assert!((-26.8..-26.7).contains(&sun.magnitude.unwrap()));
    }

    #[test]
    fn a_labelled_sky_answers_2000_bc_and_a_default_one_refuses_it() {
        use crate::tiers::{JD_LABELLED_START, Tier};
        let jd = JD_LABELLED_START + 100.0;
        let plain = Sky::new();
        let wide = Sky::new().with_policy(TierPolicy::WithLabelled);
        assert_eq!(wide.policy(), TierPolicy::WithLabelled);
        for body in ["Sun", "Moon", "Saturn", "Sirius"] {
            assert!(matches!(
                plain.apparent_state(body, jd),
                Err(EphemerisError::OutOfCoverage { .. })
            ));
            let st = wide.apparent_state(body, jd).unwrap();
            assert!(st.dec_deg.abs() <= 90.0, "{body}");
        }
        let groups = wide.tiered_coverage_groups();
        assert_eq!(groups.len(), 4);
        for g in &groups {
            assert_eq!(g.tiers.len(), 2);
            assert_eq!(g.tiers[0].tier, Tier::Validated);
            assert_eq!(g.tiers[1].tier, Tier::Labelled);
            assert!(g.tiers[1].accuracy_arcmin >= g.tiers[0].accuracy_arcmin);
        }
        assert!(
            plain
                .tiered_coverage_groups()
                .iter()
                .all(|g| g.tiers.len() == 1)
        );
    }

    #[test]
    fn sun_gha_rate_is_close_to_fifteen_degrees_an_hour() {
        let sky = Sky::new();
        let r = sky.gha_rate_deg_per_hour("Sun", 2_461_310.5).unwrap();
        assert!((r - 15.0).abs() < 0.01, "{r}");
        let s = sky.gha_rate_deg_per_hour("Vega", 2_461_310.5).unwrap();
        assert!((s - 15.041_07).abs() < 1e-3, "{s}");
    }
}
