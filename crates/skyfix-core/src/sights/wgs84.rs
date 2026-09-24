//! The observer on the WGS84 ellipsoid, for the lunar-distance clearing only.
//!
//! CONVENTIONS section 1 reduces sights on a sphere. The lunar distance is the one
//! navigation method here that needs the Moon's parallax to a few hundredths of an
//! arcminute, so its clearing places the observer on the ellipsoid, exactly as the
//! explorer's topocentric display does (`skyfix_ephemeris::topocentric`, validated
//! against Skyfield to 0.63"). The Earth-fixed frame has x through the Greenwich
//! meridian of date and z along the true pole of date; a body at apparent geocentric
//! GHA (west-positive) and declination points along `(cos d cos(-GHA), cos d sin(-GHA),
//! sin d)`. Polar motion and diurnal aberration (both under 0.5") are left out.

/// WGS84 equatorial radius, km.
pub const WGS84_A_KM: f64 = 6378.137;
/// WGS84 flattening.
pub const WGS84_F: f64 = 1.0 / 298.257_223_563;
/// The radius the providers' horizontal parallax refers to (IAU 1976, 6378.14 km): the
/// Moon's and the Sun's HP are exactly `asin(6378.14 km / d)`; the planets' use the
/// WGS84 6378.137 km, a difference of 5e-7 in the distance recovered from it.
pub const HP_RADIUS_KM: f64 = 6378.14;

pub type Vec3 = [f64; 3];

pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub fn scale(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn unit(a: Vec3) -> Vec3 {
    scale(a, 1.0 / norm(a))
}

/// Angle between two vectors, radians, robust at 0 and pi.
pub fn angle(a: Vec3, b: Vec3) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b))
}

/// Earth-fixed unit vector of an apparent geocentric GHA/Dec (degrees).
pub fn earth_fixed_unit(gha_deg: f64, dec_deg: f64) -> Vec3 {
    let (g, d) = (gha_deg.to_radians(), dec_deg.to_radians());
    [d.cos() * g.cos(), -d.cos() * g.sin(), d.sin()]
}

/// A sea-level site on the ellipsoid: its Earth-fixed position (km) and the east,
/// north and up axes of its geodetic normal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Site {
    pub position_km: Vec3,
    pub east: Vec3,
    pub north: Vec3,
    pub up: Vec3,
}

impl Site {
    pub fn new(lat_deg: f64, lon_deg: f64) -> Site {
        let (phi, lam) = (lat_deg.to_radians(), lon_deg.to_radians());
        let e2 = WGS84_F * (2.0 - WGS84_F);
        let n = WGS84_A_KM / (1.0 - e2 * phi.sin().powi(2)).sqrt();
        let (sp, cp) = phi.sin_cos();
        let (sl, cl) = lam.sin_cos();
        Site {
            position_km: [n * cp * cl, n * cp * sl, n * (1.0 - e2) * sp],
            east: [-sl, cl, 0.0],
            north: [-sp * cl, -sp * sl, cp],
            up: [cp * cl, cp * sl, sp],
        }
    }

    /// Earth-fixed vector to local (east, north, up).
    pub fn to_enu(&self, v: Vec3) -> Vec3 {
        [dot(v, self.east), dot(v, self.north), dot(v, self.up)]
    }

    /// Local (east, north, up) to Earth-fixed.
    pub fn from_enu(&self, v: Vec3) -> Vec3 {
        add(
            add(scale(self.east, v[0]), scale(self.north, v[1])),
            scale(self.up, v[2]),
        )
    }
}

/// Local unit vector (east, north, up) of an altitude and azimuth in degrees.
pub fn enu_from_alt_az(alt_deg: f64, az_deg: f64) -> Vec3 {
    let (a, z) = (alt_deg.to_radians(), az_deg.to_radians());
    [a.cos() * z.sin(), a.cos() * z.cos(), a.sin()]
}

/// Altitude and azimuth `[0, 360)` in degrees of a local (east, north, up) vector.
pub fn alt_az_from_enu(v: Vec3) -> (f64, f64) {
    let u = unit(v);
    (
        u[2].clamp(-1.0, 1.0).asin().to_degrees(),
        crate::units::norm_360(u[0].atan2(u[1]).to_degrees()),
    )
}

/// The distance along the unit direction `u` from the site at which a point is `d` km
/// from the Earth's centre: the positive root of `|o + s u| = d`.
pub fn range_to_radius(site: &Site, u: Vec3, d: f64) -> f64 {
    let o = site.position_km;
    let b = dot(o, u);
    let c = dot(o, o) - d * d;
    -b + (b * b - c).max(0.0).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_site_axes_are_orthonormal_and_up_is_the_geodetic_normal() {
        let s = Site::new(45.0, -75.0);
        for (a, b) in [(s.east, s.north), (s.north, s.up), (s.up, s.east)] {
            assert!(dot(a, b).abs() < 1e-15);
        }
        for a in [s.east, s.north, s.up] {
            assert!((norm(a) - 1.0).abs() < 1e-15);
        }
        // At 45 degrees the geocentric radius tilts 11.5' toward the equator from up.
        let tilt = angle(s.position_km, s.up).to_degrees() * 60.0;
        assert!((tilt - 11.5).abs() < 0.2, "{tilt}");
        assert!(norm(s.position_km) < WGS84_A_KM);
    }

    #[test]
    fn range_to_radius_lands_on_the_sphere_of_that_radius() {
        let s = Site::new(-33.0, 151.0);
        let u = unit(add(s.up, s.east));
        let r = range_to_radius(&s, u, 384_400.0);
        let p = add(s.position_km, scale(u, r));
        assert!((norm(p) - 384_400.0).abs() < 1e-6);
    }

    #[test]
    fn enu_round_trips_through_altitude_and_azimuth() {
        let v = enu_from_alt_az(23.4, 301.2);
        let (a, z) = alt_az_from_enu(v);
        assert!((a - 23.4).abs() < 1e-12 && (z - 301.2).abs() < 1e-12);
    }
}
