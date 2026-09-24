//! The solar-system bodies as the navigation chain sees them.
//!
//! OWNER: navigation-Moon agent. CONVENTIONS sections 5, 7 and 13.1;
//! `docs/NAVIGATION_SKY.md` explains every choice here in plain words.
//!
//! # Which bodies are offered for sights
//!
//! A body is offered for sights when it is navigational (CONVENTIONS 13.1: the Sun, the
//! Moon, Venus, Mars, Jupiter, Saturn and the 58 stars) **and** its provider's documented
//! accuracy meets the 0.1' target of CONVENTIONS 13.7 ([`SIGHT_ACCURACY_TARGET_ARCMIN`]).
//! Mercury, Uranus and Neptune are shown by the explorer but never offered:
//! [`SightPlanetProvider`] refuses them with a sentence that says why.
//!
//! # Venus is observed at its centre of light
//!
//! Venus shows a phase. A navigator puts the *light* of Venus on the horizon, and when
//! Venus is a crescent the centroid of that light lies up to 0.4' from the centre of the
//! disc, toward the Sun. The Nautical Almanac allows for this in its tabulated
//! coordinates, not in an altitude correction: its explanation reads "The phase
//! correction for Venus has been incorporated in the tabulations for GHA and Dec, and no
//! correction for phase is required. The additional corrections for Venus and Mars allow
//! for parallax." USNO's Celestial Navigation Data service says the same ("The data for
//! Venus has been corrected for phase, as in the Nautical Almanac, assuming the center of
//! light is observed").
//!
//! So [`SightPlanetProvider`] returns Venus's **centre of light**, and a Venus direction
//! typed from the Almanac means the same thing as one this provider computes. The shift
//! is [`VENUS_CENTRE_OF_LIGHT_K`]` × (1 − cos i) × SD` along the position angle of the
//! bright limb (`i` the phase angle): the form of the centroid of a uniformly bright
//! illuminated disc, `4/(3π) (1 − cos i)`, with the coefficient measured against USNO
//! (`fixtures/reference/usno_celnav_venus_phase.json`: 0.4403 over twelve responses from
//! a 15-degree to a 157-degree phase angle, residual 0.0013' rms). Mars's phase moves its
//! centre of light by under 0.01', and USNO does not apply it; Jupiter's and Saturn's are
//! smaller still. Those three are returned at their geometric centres.

use skyfix_core::geometry::{Point, destination};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::{ARCMIN, norm_360};

use crate::body::{MOON, NAVIGATIONAL_PLANETS, PLANETS, SUN};
use crate::moon::MoonProvider;
use crate::planets::{ACCURACY_BY_PLANET_ARCMIN, Planet, PlanetProvider};
use crate::stars::StarProvider;
use crate::sun::SunProvider;
use crate::{AstroProvider, Coverage, EphemerisError, catalog};

/// CONVENTIONS 13.7: a provider is offered for sights only when its documented accuracy
/// is within this, arcminutes.
pub const SIGHT_ACCURACY_TARGET_ARCMIN: f64 = 0.1;

/// Coefficient of Venus's centre-of-light shift, `K (1 − cos i) SD` toward the bright
/// limb. The uniformly bright disc gives `4/(3π) = 0.4244`; the Nautical Almanac's
/// convention, measured through USNO, is 0.4403 (see the module documentation).
pub const VENUS_CENTRE_OF_LIGHT_K: f64 = 0.44;

/// Distance of Venus's centre of light from the centre of its disc, arcminutes, for a
/// geocentric semidiameter `semidiameter_arcmin` and phase angle `phase_angle_deg`.
pub fn venus_centre_of_light_offset_arcmin(semidiameter_arcmin: f64, phase_angle_deg: f64) -> f64 {
    VENUS_CENTRE_OF_LIGHT_K * (1.0 - phase_angle_deg.to_radians().cos()) * semidiameter_arcmin
}

/// Move an apparent direction by `offset_arcmin` along the position angle
/// `position_angle_deg` (from celestial north through east). GHA is west-positive, so a
/// shift to the east lowers it. Exact on the sphere: the body's ground point moves the
/// same distance along the same bearing.
pub fn shift_direction(
    gha_deg: f64,
    dec_deg: f64,
    position_angle_deg: f64,
    offset_arcmin: f64,
) -> (f64, f64) {
    if offset_arcmin == 0.0 {
        return (gha_deg, dec_deg);
    }
    let gp = Point::from_deg(dec_deg, -gha_deg);
    let moved = destination(gp, position_angle_deg.to_radians(), offset_arcmin * ARCMIN);
    (norm_360(-moved.lon_deg()), moved.lat_deg())
}

// ---------------------------------------------------------------------------
// The navigational planets
// ---------------------------------------------------------------------------

/// Venus, Mars, Jupiter and Saturn as a sight provider: Venus at its centre of light,
/// the others at their centres, from [`PlanetProvider`]. Mercury, Uranus and Neptune are
/// refused (CONVENTIONS 13.1).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SightPlanetProvider {
    planets: PlanetProvider,
}

impl SightPlanetProvider {
    pub const NAME: &'static str =
        "skyfix-planets for sights (VSOP87A; Venus at its centre of light)";

    /// DUT1 = 0 (CONVENTIONS section 6).
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    pub fn with_dut1_s(dut1_s: f64) -> Self {
        SightPlanetProvider {
            planets: PlanetProvider::with_dut1_s(dut1_s),
        }
    }

    /// The navigational planet a name refers to, or the reason it is not one.
    fn resolve(&self, body: &str) -> Result<Planet, EphemerisError> {
        let Some(planet) = Planet::from_name(body) else {
            return Err(EphemerisError::UnknownBody(
                body.to_string(),
                Self::NAME.to_string(),
            ));
        };
        if !NAVIGATIONAL_PLANETS.contains(&planet.name()) {
            return Err(EphemerisError::Data(format!(
                "{} is shown in the explorer but is not offered for sights: the Nautical \
                 Almanac does not tabulate it and it is not a navigational body \
                 (CONVENTIONS 13.1); supply a geocentric direction to use it anyway",
                planet.name()
            )));
        }
        Ok(planet)
    }

    /// The direction a navigator's sight of `body` refers to: Venus's centre of light,
    /// the geometric centre of the others.
    pub fn sight_direction(
        &self,
        body: &str,
        jd_utc: f64,
    ) -> Result<GeocentricDirection, EphemerisError> {
        let planet = self.resolve(body)?;
        let p = self.planets.position(planet, jd_utc)?;
        let mut d = p.direction();
        if planet == Planet::Venus {
            let offset =
                venus_centre_of_light_offset_arcmin(p.semidiameter_arcmin, p.phase_angle_deg);
            let (gha, dec) = shift_direction(d.gha_deg, d.dec_deg, p.bright_limb_angle_deg, offset);
            d.gha_deg = gha;
            d.dec_deg = dec;
        }
        Ok(d)
    }
}

impl AstroProvider for SightPlanetProvider {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn coverage(&self) -> Coverage {
        let base = self.planets.coverage();
        let accuracy = ACCURACY_BY_PLANET_ARCMIN
            .iter()
            .filter(|(p, _)| NAVIGATIONAL_PLANETS.contains(&p.name()))
            .map(|(_, a)| *a)
            .fold(0.0, f64::max);
        Coverage {
            start_utc: base.start_utc,
            end_utc: base.end_utc,
            bodies: NAVIGATIONAL_PLANETS.iter().map(|p| p.to_string()).collect(),
            notes: format!(
                "The four navigational planets for sight reduction, from the planets \
                 provider below. Venus is returned at its centre of light, as the Nautical \
                 Almanac tabulates it: shifted {VENUS_CENTRE_OF_LIGHT_K} x (1 - cos i) x SD \
                 toward the bright limb (up to 0.4' for a crescent), agreeing with USNO to \
                 0.003'. Mars, Jupiter and Saturn are at their centres (their phase moves \
                 the light by under 0.01'). Mercury, Uranus and Neptune are refused. \
                 Planets provider: {}",
                base.notes
            ),
            accuracy_arcmin: accuracy,
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        self.sight_direction(body, jd_utc)
    }
}

// ---------------------------------------------------------------------------
// Which bodies are offered for sights
// ---------------------------------------------------------------------------

/// Every body offered for sights, in the order Sun, Moon, Venus, Mars, Jupiter, Saturn,
/// then the stars in catalogue order: navigational (CONVENTIONS 13.1) and validated
/// (each provider's documented accuracy within [`SIGHT_ACCURACY_TARGET_ARCMIN`]).
pub fn sight_bodies() -> Vec<&'static str> {
    let validated = |c: Coverage| c.accuracy_arcmin <= SIGHT_ACCURACY_TARGET_ARCMIN;
    let mut out = Vec::new();
    if validated(SunProvider::new().coverage()) {
        out.push(SUN);
    }
    if validated(MoonProvider::new().coverage()) {
        out.push(MOON);
    }
    let planets = SightPlanetProvider::new();
    if validated(planets.coverage()) {
        out.extend(
            PLANETS
                .iter()
                .copied()
                .filter(|p| NAVIGATIONAL_PLANETS.contains(p)),
        );
    }
    if validated(StarProvider::new().coverage()) {
        out.extend(catalog::names());
    }
    out
}

/// The solar-system bodies of [`sight_bodies`]: Sun, Moon and the four planets.
pub fn solar_system_sight_bodies() -> Vec<&'static str> {
    sight_bodies()
        .into_iter()
        .filter(|b| *b == SUN || *b == MOON || PLANETS.contains(b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_offset_is_zero_at_full_phase_and_grows_toward_the_crescent() {
        assert_eq!(venus_centre_of_light_offset_arcmin(0.5, 0.0), 0.0);
        let half = venus_centre_of_light_offset_arcmin(0.2, 90.0);
        assert!((half - 0.088).abs() < 1e-12, "{half}");
        let crescent = venus_centre_of_light_offset_arcmin(0.48, 157.0);
        assert!((0.40..0.42).contains(&crescent), "{crescent}");
    }

    #[test]
    fn a_shift_moves_the_direction_by_exactly_the_offset_along_the_bearing() {
        let (g0, d0) = (123.4, 21.7);
        for pa in [0.0, 45.0, 90.0, 180.0, 300.0] {
            let (g1, d1) = shift_direction(g0, d0, pa, 0.4);
            let a = Point::from_deg(d0, -g0);
            let b = Point::from_deg(d1, -g1);
            let dist = skyfix_core::geometry::angular_distance(a, b) / ARCMIN;
            assert!((dist - 0.4).abs() < 1e-9, "{pa}: {dist}");
            let bearing = skyfix_core::geometry::initial_bearing(a, b).to_degrees();
            let diff = (bearing - pa + 540.0).rem_euclid(360.0) - 180.0;
            assert!(diff.abs() < 1e-6, "{pa}: {bearing}");
        }
        // North raises the declination; east (PA 90) lowers the GHA.
        let (g, d) = shift_direction(10.0, 0.0, 0.0, 1.0);
        assert!((d - 1.0 / 60.0).abs() < 1e-12 && (g - 10.0).abs() < 1e-12);
        let (g, _) = shift_direction(10.0, 0.0, 90.0, 1.0);
        assert!((g - (10.0 - 1.0 / 60.0)).abs() < 1e-12, "{g}");
    }

    #[test]
    fn mercury_uranus_and_neptune_are_refused_with_a_reason() {
        let p = SightPlanetProvider::new();
        let jd = 2_461_314.562_5;
        for name in ["Mercury", "uranus", " Neptune"] {
            match p.geocentric(name, jd) {
                Err(EphemerisError::Data(m)) => {
                    assert!(m.contains("not offered for sights"), "{m}")
                }
                other => panic!("{name}: {other:?}"),
            }
        }
        assert!(matches!(
            p.geocentric("Vega", jd),
            Err(EphemerisError::UnknownBody(..))
        ));
        for name in NAVIGATIONAL_PLANETS {
            assert!(p.geocentric(name, jd).is_ok(), "{name}");
        }
    }

    #[test]
    fn only_venus_leaves_its_geometric_centre() {
        let sights = SightPlanetProvider::new();
        let raw = PlanetProvider::new();
        // 2026-10-14: Venus a thin crescent ten days before inferior conjunction.
        let jd = skyfix_core::time::parse_utc("2026-10-14T12:00:00Z").unwrap();
        for name in NAVIGATIONAL_PLANETS {
            let a = sights.geocentric(name, jd).unwrap();
            let b = raw.geocentric(name, jd).unwrap();
            let sep = skyfix_core::geometry::angular_distance(
                Point::from_deg(a.dec_deg, -a.gha_deg),
                Point::from_deg(b.dec_deg, -b.gha_deg),
            ) / ARCMIN;
            if name == "Venus" {
                assert!((0.38..0.43).contains(&sep), "Venus moved {sep}'");
                assert_eq!(a.semidiameter_arcmin, b.semidiameter_arcmin);
                assert_eq!(a.horizontal_parallax_arcmin, b.horizontal_parallax_arcmin);
            } else {
                assert_eq!(sep, 0.0, "{name}");
            }
        }
    }

    #[test]
    fn the_sight_bodies_are_the_validated_navigational_ones() {
        let b = sight_bodies();
        assert_eq!(
            &b[..6],
            &["Sun", "Moon", "Venus", "Mars", "Jupiter", "Saturn"]
        );
        assert_eq!(b.len(), 6 + catalog::names().len());
        for gone in ["Mercury", "Uranus", "Neptune"] {
            assert!(!b.contains(&gone), "{gone}");
        }
        assert_eq!(solar_system_sight_bodies().len(), 6);
    }
}
