//! Geometry for a rotating star finder, the equivalent of the Star Finder and Identifier
//! No. 2102-D. `docs/NAVIGATION_METHODS.md` §11 is normative (sailings agent, expansion
//! programme).
//!
//! # The base plate
//!
//! Each side of the base is a polar **azimuthal equidistant** projection of the
//! celestial sphere, centred on a celestial pole and extending to the opposite pole at
//! the rim: the distance from the centre is proportional to the polar distance, so the
//! equator is the circle of radius 1/2 and a body of declination `δ` sits at
//!
//! ```text
//! north side:  r = (90° − δ) / 180°,   (x, y) = r (cos α,  sin α)
//! south side:  r = (90° + δ) / 180°,   (x, y) = r (cos α, −sin α)
//! ```
//!
//! with `α = 360° − SHA` the right ascension. Coordinates are on the unit disc, `x`
//! right and `y` up, the base seen **from outside** the celestial sphere, like a globe:
//! right ascension runs anticlockwise round the north side and clockwise round the
//! south. The rim carries the **Aries index**: graduation `L` (0° to 360°) at the rim
//! point of angle `L` on the north side and `−L` on the south, so the graduation under a
//! star is its right ascension.
//!
//! # The templates
//!
//! One template per 10° of latitude, 5° to 85°, for each hemisphere. A template is the
//! altitude–azimuth grid of an observer at that latitude, drawn in the same projection
//! with the observer's meridian — the arrow, from the pole through the zenith — along
//! `+x`. The point at altitude `h` and azimuth `A` has declination `δ` and hour angle `t`
//! (west positive)
//!
//! ```text
//! sin δ     = sin φ sin h + cos φ cos h cos A
//! cos δ sin t = −cos h sin A
//! cos δ cos t = cos φ sin h − sin φ cos h cos A
//! ```
//!
//! and sits at `r (cos t, −sin t)` on a north template, `r (cos t, sin t)` on a south one.
//!
//! # Setting it
//!
//! Lay the template on the base of the same hemisphere and turn it so the arrow points at
//! the local hour angle of Aries on the index: anticlockwise by `LHA ♈` on the north side,
//! clockwise on the south ([`template_rotation_deg`]). Every star then stands at its
//! altitude and azimuth on the grid: a star of right ascension `α` has hour angle
//! `LHA ♈ − α`, which is where the rotated template places it. The test
//! `a_set_template_reads_every_star_s_altitude_and_azimuth` checks that against the
//! sight-reduction formula of CONVENTIONS section 3 at random latitudes and times.
//!
//! Like the printed star finder, the grid is geometric: no refraction and no dip.

use serde::{Deserialize, Serialize};

use crate::SkyfixError;

/// Template latitudes, degrees: 5° to 85° every 10°.
pub const TEMPLATE_LATITUDES_DEG: [f64; 9] = [5.0, 15.0, 25.0, 35.0, 45.0, 55.0, 65.0, 75.0, 85.0];
/// Altitude circles every so many degrees (0° is the horizon).
pub const ALTITUDE_STEP_DEG: f64 = 5.0;
/// Azimuth lines every so many degrees.
pub const AZIMUTH_STEP_DEG: f64 = 10.0;

/// Which side of the base, i.e. which hemisphere.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    North,
    South,
}

/// Base-plate coordinates of right ascension `ra_deg` and declination `dec_deg`.
pub fn base_xy(side: Side, ra_deg: f64, dec_deg: f64) -> [f64; 2] {
    let (s, c) = ra_deg.to_radians().sin_cos();
    match side {
        Side::North => {
            let r = (90.0 - dec_deg) / 180.0;
            [r * c, r * s]
        }
        Side::South => {
            let r = (90.0 + dec_deg) / 180.0;
            [r * c, -r * s]
        }
    }
}

/// Template coordinates (arrow along `+x`) of altitude `alt_deg`, azimuth `az_deg` for
/// an observer at `lat_deg` (whose sign picks the side).
pub fn template_xy(lat_deg: f64, alt_deg: f64, az_deg: f64) -> [f64; 2] {
    let (sp, cp) = lat_deg.to_radians().sin_cos();
    let (sh, ch) = alt_deg.to_radians().sin_cos();
    let (sa, ca) = az_deg.to_radians().sin_cos();
    // The point's unit vector in the equatorial frame of the observer's meridian:
    // `n = cos δ cos t`, `e = cos δ sin t`, `z = sin δ` (the formulas above), and the
    // polar distance from atan2, exact at the poles where asin(sin δ) is not.
    let n = cp * sh - sp * ch * ca;
    let e = -ch * sa;
    let z = sp * sh + cp * ch * ca;
    let rho = e.hypot(n);
    let (cos_t, sin_t) = if rho > 0.0 {
        (n / rho, e / rho)
    } else {
        (1.0, 0.0)
    };
    if lat_deg >= 0.0 {
        let r = rho.atan2(z) / std::f64::consts::PI;
        [r * cos_t, -r * sin_t]
    } else {
        let r = rho.atan2(-z) / std::f64::consts::PI;
        [r * cos_t, r * sin_t]
    }
}

/// The side a latitude's template belongs to.
pub fn side_of(lat_deg: f64) -> Side {
    if lat_deg >= 0.0 {
        Side::North
    } else {
        Side::South
    }
}

/// The anticlockwise rotation, degrees, that sets a template's arrow on `LHA ♈` of the
/// index: `+LHA ♈` on the north side, `−LHA ♈` on the south.
pub fn template_rotation_deg(side: Side, lha_aries_deg: f64) -> f64 {
    match side {
        Side::North => lha_aries_deg,
        Side::South => -lha_aries_deg,
    }
}

/// Rotate a point anticlockwise by `deg`.
pub fn rotate(p: [f64; 2], deg: f64) -> [f64; 2] {
    let (s, c) = deg.to_radians().sin_cos();
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

/// The template latitude for any latitude: the 10° band's centre, 5° to 85°, with its
/// sign (0° counts as north).
pub fn template_latitude(lat_deg: f64) -> f64 {
    let a = lat_deg.abs().min(89.999);
    let band = ((a / 10.0).floor() * 10.0 + 5.0).clamp(5.0, 85.0);
    if lat_deg < 0.0 { -band } else { band }
}

/// A polyline of the template.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TemplateLine {
    /// The altitude of an altitude circle, or the azimuth of an azimuth line, degrees.
    pub value_deg: f64,
    pub points: Vec<[f64; 2]>,
}

/// One template: its grid, arrow along `+x`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Template {
    pub latitude_deg: f64,
    pub side: Side,
    /// The zenith, on the arrow.
    pub zenith: [f64; 2],
    /// The horizon (altitude 0°), closed.
    pub horizon: Vec<[f64; 2]>,
    /// Altitude circles every [`ALTITUDE_STEP_DEG`] from 5° to 85°, closed.
    pub altitude_circles: Vec<TemplateLine>,
    /// Azimuth lines every [`AZIMUTH_STEP_DEG`], from the horizon to the zenith.
    pub azimuth_lines: Vec<TemplateLine>,
}

fn r6(p: [f64; 2]) -> [f64; 2] {
    [(p[0] * 1e6).round() / 1e6, (p[1] * 1e6).round() / 1e6]
}

/// The grid of the template for `lat_deg` (a template latitude, or any latitude, which is
/// used as given).
pub fn template(lat_deg: f64) -> Result<Template, SkyfixError> {
    if !lat_deg.is_finite() || lat_deg.abs() >= 90.0 || lat_deg == 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "lat_band".to_string(),
            message: format!(
                "a template needs a latitude between 0 and 90 degrees either side of the \
                 equator (got {lat_deg})"
            ),
        });
    }
    let circle = |h: f64| -> Vec<[f64; 2]> {
        (0..=72)
            .map(|k| r6(template_xy(lat_deg, h, k as f64 * 5.0)))
            .collect()
    };
    let altitude_circles = (1..)
        .map(|k| k as f64 * ALTITUDE_STEP_DEG)
        .take_while(|h| *h < 90.0)
        .map(|h| TemplateLine {
            value_deg: h,
            points: circle(h),
        })
        .collect();
    let azimuth_lines = (0..)
        .map(|k| k as f64 * AZIMUTH_STEP_DEG)
        .take_while(|a| *a < 360.0)
        .map(|a| TemplateLine {
            value_deg: a,
            points: (0..=36)
                .map(|k| r6(template_xy(lat_deg, k as f64 * 2.5, a)))
                .collect(),
        })
        .collect();
    Ok(Template {
        latitude_deg: lat_deg,
        side: side_of(lat_deg),
        zenith: r6(template_xy(lat_deg, 90.0, 0.0)),
        horizon: circle(0.0),
        altitude_circles,
        azimuth_lines,
    })
}

/// A graduation of the Aries index on the rim.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AriesTick {
    pub lha_aries_deg: f64,
    /// Rim point on the north side and on the south side.
    pub north: [f64; 2],
    pub south: [f64; 2],
    /// `"label"` every 10°, `"major"` every 5°, `"minor"` every degree.
    pub kind: String,
}

/// The Aries index: one graduation per degree.
pub fn aries_index() -> Vec<AriesTick> {
    (0..360)
        .map(|g| {
            let g = g as f64;
            AriesTick {
                lha_aries_deg: g,
                north: r6(base_xy(Side::North, g, -90.0)),
                south: r6(base_xy(Side::South, g, 90.0)),
                kind: if g % 10.0 == 0.0 {
                    "label"
                } else if g % 5.0 == 0.0 {
                    "major"
                } else {
                    "minor"
                }
                .to_string(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{Point, altitude_azimuth};

    /// A small deterministic generator (xorshift64*).
    struct Rng(u64);
    impl Rng {
        fn f(&mut self) -> f64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    #[test]
    fn a_set_template_reads_every_star_s_altitude_and_azimuth() {
        let mut rng = Rng(0x0217_0d00_5eed_0001);
        let mut n = 0;
        for _ in 0..20_000 {
            let lat = TEMPLATE_LATITUDES_DEG[(rng.f() * 9.0) as usize]
                * if rng.f() < 0.5 { -1.0 } else { 1.0 };
            let lha_aries = rng.f() * 360.0;
            let ra = rng.f() * 360.0;
            let dec = rng.f() * 180.0 - 90.0;
            // CONVENTIONS section 3: LHA of the star = LHA Aries + SHA = LHA Aries - RA.
            let lha = lha_aries - ra;
            let (h, z) = altitude_azimuth(
                Point::from_deg(lat, 0.0),
                lha.to_radians(),
                dec.to_radians(),
            );
            let (h, z) = (h.to_degrees(), z.to_degrees());
            if h < 0.0 {
                continue;
            }
            n += 1;
            let side = side_of(lat);
            let on_grid = rotate(
                template_xy(lat, h, z),
                template_rotation_deg(side, lha_aries),
            );
            let on_base = base_xy(side, ra, dec);
            let d = (on_grid[0] - on_base[0]).hypot(on_grid[1] - on_base[1]);
            assert!(
                d < 1e-9,
                "lat {lat} lha {lha_aries} ra {ra} dec {dec}: {on_grid:?} vs {on_base:?}"
            );
        }
        assert!(n > 5_000);
    }

    #[test]
    fn the_grid_is_where_a_2102d_puts_it() {
        let t = template(35.0).unwrap();
        // Zenith at polar distance 55 degrees on the arrow; the celestial pole (altitude =
        // latitude, due north) at the centre.
        assert!((t.zenith[0] - 55.0 / 180.0).abs() < 1e-6 && t.zenith[1].abs() < 1e-6);
        let pole = template_xy(35.0, 35.0, 0.0);
        assert!(pole[0].hypot(pole[1]) < 1e-9);
        // The horizon's south point is 90 degrees south of the zenith, at declination -55:
        // radius 145/180.
        let south = template_xy(35.0, 0.0, 180.0);
        assert!((south[0] - 145.0 / 180.0).abs() < 1e-9);
        assert_eq!(t.altitude_circles.len(), 17);
        assert_eq!(t.azimuth_lines.len(), 36);
        // Every point is on the unit disc.
        for line in t.altitude_circles.iter().chain(&t.azimuth_lines) {
            assert!(line.points.iter().all(|p| p[0].hypot(p[1]) <= 1.0 + 1e-9));
        }
        // East is anticlockwise of the arrow on a north template (seen from outside).
        let east = template_xy(35.0, 0.0, 90.0);
        assert!(east[1] > 0.0);
        let south_east = template_xy(-35.0, 0.0, 90.0);
        assert!(south_east[1] < 0.0);
    }

    #[test]
    fn latitudes_snap_to_their_band_and_the_index_is_graduated() {
        assert_eq!(template_latitude(39.95), 35.0);
        assert_eq!(template_latitude(-0.2), -5.0);
        assert_eq!(template_latitude(0.0), 5.0);
        assert_eq!(template_latitude(89.9), 85.0);
        assert!(template(0.0).is_err());
        let idx = aries_index();
        assert_eq!(idx.len(), 360);
        assert_eq!(idx.iter().filter(|t| t.kind == "label").count(), 36);
        assert!((idx[90].north[1] - 1.0).abs() < 1e-9 && (idx[90].south[1] + 1.0).abs() < 1e-9);
    }
}
