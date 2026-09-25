//! Saturn's rings as seen from the Earth: the tilt toward the Earth (B) and the Sun
//! (B'), the position angle of the ring's minor axis (P), the size of the ellipses the
//! ring edges make on the sky, and Saturn's magnitude with its rings.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.12; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail".
//!
//! # Model
//!
//! Meeus, *Astronomical Algorithms* (2nd ed.), chapter 45, with two modern inputs:
//!
//! - **The ring plane is Saturn's equator** and its pole is the IAU WGCCRE 2015 pole
//!   (the one the planet provider's magnitudes and [`crate::discs`] use), not Meeus's
//!   1980s ring elements `i = 28.075216 deg`, `Omega = 169.508470 deg` (those put P
//!   0.026 deg and B 0.005 deg away from JPL Horizons in 1992, the pole difference).
//!   So `B` is the planetocentric latitude of the Earth seen from Saturn's centre at
//!   the light-time instant (geometric), `B'` that of the Sun as Saturn sees it
//!   (aberration included: Meeus's `l' = l - 0.01759 deg / r` is the same correction),
//!   `P` the position angle of the pole's projection (north through east, true equator
//!   of date) and `delta U` the angle between the Sun and the Earth measured in the
//!   ring plane.
//! - **The ring edges** are NASA's (NSSDCA Saturnian Rings Fact Sheet, 2022): A ring
//!   136,780 km (outer) and 122,340 km (inner), B ring 117,507 and 91,975 km, C ring
//!   74,658 km (inner). Meeus's `a = 375.35" / delta` is a 136,117 km outer edge, 0.5 %
//!   smaller. The ellipse of an edge of radius `R` has major axis `2 asin(R / delta)`
//!   and minor axis that times `|sin B|`.
//!
//! **Magnitude with the rings**: the Astronomical Almanac's 1984 formula that Meeus
//! gives in chapter 41, `V = -8.88 + 5 log10(r delta) + 0.044 |delta U| - 2.60 sin|B| +
//! 1.25 sin^2 B`, beside the explorer's own magnitude (Mallama & Hilton 2018, globe and
//! rings, from the planet provider). They differ by up to about 0.1 (Mallama's is
//! fitted to modern photometry and has a phase term the 1984 formula does not); the
//! explorer shows Mallama's and this one is given for comparison with printed
//! almanacs.

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_ephemeris::planets::{Planet, PlanetProvider};

use crate::discs::planet_view;
use crate::planet_geometry::{
    axis_position_angle_deg, icrs_to_true_of_date, mat_vec, radec_unit, scale,
};
use crate::sky::AlmanacError;

const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;

/// The ring edges, km (NSSDCA Saturnian Rings Fact Sheet, last updated 2022-04-19).
pub const RING_EDGES_KM: [(&str, f64); 5] = [
    ("A outer", 136_780.0),
    ("A inner", 122_340.0),
    ("B outer", 117_507.0),
    ("B inner", 91_975.0),
    ("C inner", 74_658.0),
];

/// One ring edge's ellipse on the sky.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RingEdge {
    pub name: String,
    pub radius_km: f64,
    pub major_axis_arcsec: f64,
    pub minor_axis_arcsec: f64,
}

/// Saturn's rings at one instant (EXPLORER_API.md `SaturnRings`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaturnRings {
    pub jd_utc: f64,
    pub utc: String,
    /// B: Saturnicentric latitude of the Earth referred to the ring plane, degrees.
    /// Positive: the north face is seen.
    pub earth_latitude_deg: f64,
    /// B': the same for the Sun. Positive: the north face is lit.
    pub sun_latitude_deg: f64,
    /// Difference of the Saturnicentric longitudes of the Sun and the Earth in the ring
    /// plane, degrees `[0, 180]`.
    pub delta_u_deg: f64,
    /// P: position angle of the ring's northern minor axis (Saturn's pole), north
    /// through east, degrees.
    pub position_angle_deg: f64,
    /// The outer edge of the A ring: major and minor axes of its ellipse, arcseconds.
    pub major_axis_arcsec: f64,
    pub minor_axis_arcsec: f64,
    /// Every edge of `RING_EDGES_KM`.
    pub edges: Vec<RingEdge>,
    /// The Earth sees the north face (`B > 0`).
    pub north_face_visible: bool,
    /// The face turned to the Earth is the sunlit one (`B` and `B'` of the same sign);
    /// otherwise the rings are seen from their dark side.
    pub lit_face_visible: bool,
    pub distance_au: f64,
    pub heliocentric_distance_au: f64,
    /// Astronomical Almanac 1984 / Meeus chapter 41 magnitude of globe and rings.
    pub magnitude_aa1984: f64,
    /// The explorer's magnitude (Mallama & Hilton 2018), when its model covers the
    /// geometry.
    pub magnitude: Option<f64>,
}

/// The Astronomical Almanac's 1984 magnitude of Saturn with its rings (Meeus 41).
pub fn magnitude_aa1984(r_au: f64, delta_au: f64, delta_u_deg: f64, b_deg: f64) -> f64 {
    let sb = b_deg.to_radians().sin();
    -8.88 + 5.0 * (r_au * delta_au).log10() + 0.044 * delta_u_deg.abs() - 2.60 * sb.abs()
        + 1.25 * sb * sb
}

/// Saturn's rings at `jd_utc`.
pub fn saturn_rings(provider: &PlanetProvider, jd_utc: f64) -> Result<SaturnRings, AlmanacError> {
    let v = planet_view(provider, Planet::Saturn, jd_utc)?;
    let p = &v.position;
    let o = &v.orientation;
    let (b, lon_earth) = o.lat_lon_east_deg(scale(v.astrometric, -1.0));
    let (b_sun, lon_sun) = o.lat_lon_east_deg(v.sun_apparent_from_planet);
    let du = (lon_sun - lon_earth).rem_euclid(360.0);
    let delta_u_deg = if du > 180.0 { 360.0 - du } else { du };
    let pole_date = mat_vec(&icrs_to_true_of_date(p.jd_tt), o.pole);
    let position_angle_deg = axis_position_angle_deg(radec_unit(p.ra_deg, p.dec_deg), pole_date);
    let delta_km = p.distance_au * AU_KM;
    let sin_b = b.to_radians().sin().abs();
    let edges: Vec<RingEdge> = RING_EDGES_KM
        .iter()
        .map(|&(name, radius_km)| {
            let major = 2.0 * (radius_km / delta_km).asin().to_degrees() * 3600.0;
            RingEdge {
                name: name.to_string(),
                radius_km,
                major_axis_arcsec: major,
                minor_axis_arcsec: major * sin_b,
            }
        })
        .collect();
    Ok(SaturnRings {
        jd_utc,
        utc: format_utc(jd_utc),
        earth_latitude_deg: b,
        sun_latitude_deg: b_sun,
        delta_u_deg,
        position_angle_deg,
        major_axis_arcsec: edges[0].major_axis_arcsec,
        minor_axis_arcsec: edges[0].minor_axis_arcsec,
        edges,
        north_face_visible: b > 0.0,
        lit_face_visible: b * b_sun > 0.0,
        distance_au: p.distance_au,
        heliocentric_distance_au: p.heliocentric_distance_au,
        magnitude_aa1984: magnitude_aa1984(
            p.heliocentric_distance_au,
            p.distance_au,
            delta_u_deg,
            b,
        ),
        magnitude: p.magnitude,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn the_aa1984_formula_on_meeus_example_inputs() {
        // Meeus example 45.a's geometry (1992 Dec 16 0h TD): r = 9.867882, delta =
        // 10.464606, delta U = 4.198 deg, B = 16.442 deg; the formula by hand gives
        // +0.7387.
        let m = magnitude_aa1984(9.867_882, 10.464_606, 4.198, 16.442);
        assert!((m - 0.7387).abs() < 5e-4, "{m}");
    }

    #[test]
    fn edge_on_in_2025_and_open_in_2017() {
        let p = PlanetProvider::new();
        // The Earth crossed the ring plane on 2025-03-23.
        let r = saturn_rings(&p, civil_to_jd(2025, 3, 23)).unwrap();
        assert!(r.earth_latitude_deg.abs() < 0.05, "{r:?}");
        assert!(r.minor_axis_arcsec < 0.05);
        // Widest open in October 2017: B about +27 deg.
        let r = saturn_rings(&p, civil_to_jd(2017, 10, 16)).unwrap();
        assert!((26.5..27.3).contains(&r.earth_latitude_deg), "{r:?}");
        assert!(r.north_face_visible && r.lit_face_visible);
        assert!(r.edges.windows(2).all(|w| w[0].radius_km > w[1].radius_km));
        let m = r.magnitude.unwrap();
        assert!(
            (m - r.magnitude_aa1984).abs() < 0.2,
            "{m} {}",
            r.magnitude_aa1984
        );
    }
}
