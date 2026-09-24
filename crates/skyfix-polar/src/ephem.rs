//! Adapter from the workspace's astronomy providers to a Sun direction.
//!
//! The heading estimator takes the Sun's altitude and azimuth as **inputs**; it
//! never computes them. This module is the thin bridge that lets a caller
//! obtain them from any [`AstroProvider`] plus an approximate observer
//! position, reusing `skyfix_core::geometry` so that the polarization module
//! cannot disagree with the rest of the workspace about the altitude formula.
//!
//! # Status
//!
//! The workspace's Sun provider is owned by another module and is a stub at the
//! time of writing, so **this adapter is exercised only against a synthetic
//! provider in its own tests**. It is correct with respect to
//! `docs/CONVENTIONS.md` sections 2 and 3; it is not evidence that any real
//! provider is accurate.
//!
//! # What is deliberately left out
//!
//! The direction returned is **apparent geocentric** (CONVENTIONS section 7):
//! no refraction, no topocentric parallax, no semidiameter. For polarization
//! geometry that is the right choice — the scattering geometry is about where
//! the Sun actually is, not where it appears through the atmosphere — but note
//! that a low Sun appears up to about 0.5 deg higher than it is, and this
//! module does not model that. Anyone who needs the *apparent* position should
//! apply `skyfix_core::corrections` themselves and say so.

use crate::sky::Dir;
use skyfix_core::geometry::{Point, altitude_azimuth};
use skyfix_ephemeris::AstroProvider;

/// Horizon-frame direction of a body from an observer, at a Julian date.
pub fn body_direction<P: AstroProvider + ?Sized>(
    provider: &P,
    body: &str,
    jd_utc: f64,
    observer: Point,
) -> Result<Dir, String> {
    let g = provider
        .geocentric(body, jd_utc)
        .map_err(|e| format!("{}: {e}", provider.name()))?;
    let (alt, az) = altitude_azimuth(observer, g.gha_deg.to_radians(), g.dec_deg.to_radians());
    Ok(Dir::new(alt, az))
}

/// Horizon-frame direction of the Sun. Convenience over [`body_direction`].
pub fn sun_direction<P: AstroProvider + ?Sized>(
    provider: &P,
    jd_utc: f64,
    observer: Point,
) -> Result<Dir, String> {
    body_direction(provider, "Sun", jd_utc, observer)
}

/// Direction from a geocentric hour angle and declination supplied directly,
/// for callers holding an almanac line rather than a provider.
pub fn direction_from_gha_dec(gha_deg: f64, dec_deg: f64, observer: Point) -> Dir {
    let (alt, az) = altitude_azimuth(observer, gha_deg.to_radians(), dec_deg.to_radians());
    Dir::new(alt, az)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use skyfix_core::types::GeocentricDirection;
    use skyfix_ephemeris::{Coverage, EphemerisError};

    /// A provider that returns one fixed direction, so the adapter itself is
    /// tested without depending on any real ephemeris.
    struct FixedProvider {
        gha_deg: f64,
        dec_deg: f64,
    }

    impl AstroProvider for FixedProvider {
        fn name(&self) -> &str {
            "fixed-test-provider"
        }
        fn coverage(&self) -> Coverage {
            Coverage {
                start_utc: "2026-01-01T00:00:00Z".to_string(),
                end_utc: "2026-12-31T00:00:00Z".to_string(),
                bodies: vec!["Sun".to_string()],
                notes: "synthetic, for adapter tests only".to_string(),
                accuracy_arcmin: 0.0,
            }
        }
        fn geocentric(
            &self,
            body: &str,
            _jd_utc: f64,
        ) -> Result<GeocentricDirection, EphemerisError> {
            if !body.eq_ignore_ascii_case("sun") {
                return Err(EphemerisError::UnknownBody(
                    body.to_string(),
                    self.name().to_string(),
                ));
            }
            Ok(GeocentricDirection {
                gha_deg: self.gha_deg,
                dec_deg: self.dec_deg,
                semidiameter_arcmin: 16.0,
                horizontal_parallax_arcmin: 0.146,
            })
        }
    }

    #[test]
    fn a_body_over_the_observer_is_at_the_zenith() {
        // GP = observer: dec = latitude, GHA = -longitude (east-positive).
        let observer = Point::from_deg(39.9526, -75.1652);
        let p = FixedProvider {
            gha_deg: 75.1652,
            dec_deg: 39.9526,
        };
        let d = sun_direction(&p, 2_461_000.5, observer).unwrap();
        assert_relative_eq!(d.alt_deg(), 90.0, epsilon = 1e-9);
    }

    #[test]
    fn a_body_due_south_and_a_body_due_east() {
        let observer = Point::from_deg(40.0, -75.0);
        // Same meridian, declination 10 N: 30 deg south of the zenith.
        let p = FixedProvider {
            gha_deg: 75.0,
            dec_deg: 10.0,
        };
        let d = sun_direction(&p, 2_461_000.5, observer).unwrap();
        assert_relative_eq!(d.alt_deg(), 60.0, epsilon = 1e-9);
        assert_relative_eq!(crate::angles::wrap360_deg(d.az_deg()), 180.0, epsilon = 1e-9);
        // Equator observer, body 30 deg east on the equator.
        let d = direction_from_gha_dec(330.0, 0.0, Point::from_deg(0.0, 0.0));
        assert_relative_eq!(d.alt_deg(), 60.0, epsilon = 1e-9);
        assert_relative_eq!(crate::angles::wrap360_deg(d.az_deg()), 90.0, epsilon = 1e-9);
    }

    #[test]
    fn an_unknown_body_is_an_error_naming_the_provider() {
        let observer = Point::from_deg(0.0, 0.0);
        let p = FixedProvider {
            gha_deg: 0.0,
            dec_deg: 0.0,
        };
        let e = body_direction(&p, "Vega", 2_461_000.5, observer).unwrap_err();
        assert!(e.contains("fixed-test-provider"), "{e}");
        assert!(e.contains("Vega"), "{e}");
    }

    #[test]
    fn the_adapter_is_object_safe() {
        // `&dyn AstroProvider` works, so a caller can hold any provider.
        let p = FixedProvider {
            gha_deg: 75.0,
            dec_deg: 40.0,
        };
        let dynamic: &dyn AstroProvider = &p;
        let d = sun_direction(dynamic, 2_461_000.5, Point::from_deg(40.0, -75.0)).unwrap();
        assert_relative_eq!(d.alt_deg(), 90.0, epsilon = 1e-9);
        assert!(!dynamic.coverage().bodies.is_empty());
    }
}
