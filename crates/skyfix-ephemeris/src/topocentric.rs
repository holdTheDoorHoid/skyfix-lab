//! Topocentric altitude and azimuth for display (CONVENTIONS section 13.2).
//!
//! OWNER: planning session (initial version); the Moon agent validates it against
//! Skyfield and may refine it. **Display only**: sight reduction keeps the spherical
//! model of CONVENTIONS sections 1 and 3.
//!
//! Method: the observer is placed on the WGS84 ellipsoid in the Earth-fixed frame whose
//! x axis is the Greenwich meridian of date and whose z axis is the true pole of date.
//! The body is placed in the same frame from its apparent geocentric GHA, declination
//! and distance (GHA already contains Earth rotation with DUT1 = 0). The topocentric
//! vector is their difference, resolved on the local east/north/up axes of the
//! geodetic normal. Polar motion (< 0.5") and diurnal aberration (< 0.32") are not
//! modelled.

use serde::{Deserialize, Serialize};

use crate::body::ApparentState;

/// WGS84 equatorial radius, km.
pub const WGS84_A_KM: f64 = 6378.137;
/// WGS84 flattening.
pub const WGS84_F: f64 = 1.0 / 298.257_223_563;

/// An observing site. Longitude east-positive (CONVENTIONS section 2).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Site {
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// Height above the WGS84 ellipsoid, metres. Not the height of eye.
    pub height_m: f64,
    pub pressure_hpa: f64,
    pub temperature_c: f64,
}

impl Default for Site {
    fn default() -> Self {
        Site {
            lat_deg: 0.0,
            lon_deg: 0.0,
            height_m: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        }
    }
}

impl Site {
    pub fn new(lat_deg: f64, lon_deg: f64) -> Self {
        Site {
            lat_deg,
            lon_deg,
            ..Site::default()
        }
    }

    /// Earth-fixed position of the site, km.
    pub fn position_km(&self) -> [f64; 3] {
        let (phi, lam) = (self.lat_deg.to_radians(), self.lon_deg.to_radians());
        let e2 = WGS84_F * (2.0 - WGS84_F);
        let n = WGS84_A_KM / (1.0 - e2 * phi.sin().powi(2)).sqrt();
        let h = self.height_m / 1000.0;
        [
            (n + h) * phi.cos() * lam.cos(),
            (n + h) * phi.cos() * lam.sin(),
            (n * (1.0 - e2) + h) * phi.sin(),
        ]
    }

    /// Unit vectors east, north and up of the geodetic normal.
    pub fn enu_axes(&self) -> [[f64; 3]; 3] {
        let (phi, lam) = (self.lat_deg.to_radians(), self.lon_deg.to_radians());
        [
            [-lam.sin(), lam.cos(), 0.0],
            [-phi.sin() * lam.cos(), -phi.sin() * lam.sin(), phi.cos()],
            [phi.cos() * lam.cos(), phi.cos() * lam.sin(), phi.sin()],
        ]
    }
}

/// Where a body appears from a site.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Horizontal {
    /// Topocentric geometric altitude of the centre, degrees (parallax, no refraction).
    pub alt_deg: f64,
    /// Azimuth from true north, clockwise, `[0, 360)`.
    pub az_deg: f64,
    /// `alt_deg` plus display refraction (CONVENTIONS 13.2).
    pub alt_apparent_deg: f64,
    /// Parallactic angle, degrees, positive west of the meridian.
    pub parallactic_angle_deg: f64,
    /// Topocentric distance, km. `None` for stars.
    pub distance_km: Option<f64>,
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Earth-fixed direction (unit vector) of an apparent geocentric GHA/Dec.
pub fn earth_fixed_unit(gha_deg: f64, dec_deg: f64) -> [f64; 3] {
    let (g, d) = (gha_deg.to_radians(), dec_deg.to_radians());
    // GHA is west-positive, so the body's east longitude is -GHA.
    [d.cos() * g.cos(), -d.cos() * g.sin(), d.sin()]
}

/// Topocentric altitude and azimuth of `state` from `site` (CONVENTIONS 13.2).
pub fn horizontal(state: &ApparentState, site: &Site) -> Horizontal {
    let u = earth_fixed_unit(state.gha_deg, state.dec_deg);
    let (v, distance_km) = match state.distance_km {
        Some(d) => {
            let o = site.position_km();
            let v = [d * u[0] - o[0], d * u[1] - o[1], d * u[2] - o[2]];
            let r = dot(v, v).sqrt();
            (v, Some(r))
        }
        None => (u, None),
    };
    let [e, n, up] = site.enu_axes();
    let (ve, vn, vu) = (dot(v, e), dot(v, n), dot(v, up));
    let alt_deg = vu.atan2(ve.hypot(vn)).to_degrees();
    let az_deg = ve.atan2(vn).to_degrees().rem_euclid(360.0);
    let lha = (state.gha_deg + site.lon_deg).to_radians();
    let (phi, dec) = (site.lat_deg.to_radians(), state.dec_deg.to_radians());
    let q = lha
        .sin()
        .atan2(phi.tan() * dec.cos() - dec.sin() * lha.cos())
        .to_degrees();
    Horizontal {
        alt_deg,
        az_deg,
        alt_apparent_deg: alt_deg
            + refraction_true_to_apparent_arcmin(alt_deg, site.pressure_hpa, site.temperature_c)
                / 60.0,
        parallactic_angle_deg: q,
        distance_km,
    }
}

/// Saemundsson's refraction for a true (geometric) altitude, arcminutes, with the
/// pressure/temperature scaling of CONVENTIONS 13.2. Evaluated at `max(alt, -1 deg)`.
pub fn refraction_true_to_apparent_arcmin(
    alt_deg: f64,
    pressure_hpa: f64,
    temperature_c: f64,
) -> f64 {
    let h = alt_deg.max(-1.0);
    let r = 1.02 / (h + 10.3 / (h + 5.11)).to_radians().tan();
    r * (pressure_hpa / 1010.0) * (283.0 / (273.0 + temperature_c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::{ApparentState, BodyKind};

    fn state(gha: f64, dec: f64, distance_km: Option<f64>) -> ApparentState {
        ApparentState {
            body: "test".into(),
            kind: BodyKind::Star,
            jd_utc: 2_451_545.0,
            ra_deg: 0.0,
            dec_deg: dec,
            gha_deg: gha,
            distance_km,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
            magnitude: None,
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        }
    }

    #[test]
    fn a_star_over_the_site_is_at_the_zenith() {
        // On the equator geodetic and geocentric verticals coincide.
        let h = horizontal(&state(75.0, 0.0, None), &Site::new(0.0, -75.0));
        assert!((h.alt_deg - 90.0).abs() < 1e-9, "{h:?}");
    }

    #[test]
    fn azimuth_is_clockwise_from_north() {
        let site = Site::new(0.0, 0.0);
        // A star on the equator 90 degrees west of the meridian sets due west.
        let w = horizontal(&state(90.0, 0.0, None), &site);
        assert!(
            (w.az_deg - 270.0).abs() < 1e-9 && w.alt_deg.abs() < 1e-9,
            "{w:?}"
        );
        let n = horizontal(&state(0.0, 60.0, None), &site);
        assert!(
            n.az_deg.abs() < 1e-9 || (n.az_deg - 360.0).abs() < 1e-9,
            "{n:?}"
        );
    }

    #[test]
    fn the_moon_on_the_horizon_is_lowered_by_its_parallax() {
        // Geocentric altitude 0 seen from the equator: the site is `a` above the
        // centre, so the Moon is depressed by atan(a / d). (HP = asin(a / d) is the
        // parallax for a body on the *topocentric* horizon; sin p = (a/d) cos h.)
        let d = 384_400.0;
        let p_deg = (WGS84_A_KM / d).atan().to_degrees();
        let h = horizontal(&state(90.0, 0.0, Some(d)), &Site::new(0.0, 0.0));
        assert!(
            (h.alt_deg + p_deg).abs() < 1e-9,
            "{} vs {}",
            h.alt_deg,
            -p_deg
        );
        let hp_deg = (WGS84_A_KM / d).asin().to_degrees();
        assert!((h.alt_deg + hp_deg).abs() < 2e-4, "within 0.5\" of -HP");
    }

    #[test]
    fn refraction_is_about_half_a_degree_at_the_horizon_and_a_minute_at_45() {
        let r0 = refraction_true_to_apparent_arcmin(0.0, 1010.0, 10.0);
        assert!((28.0..30.0).contains(&r0), "{r0}");
        let r45 = refraction_true_to_apparent_arcmin(45.0, 1010.0, 10.0);
        assert!((0.95..1.05).contains(&r45), "{r45}");
    }
}
