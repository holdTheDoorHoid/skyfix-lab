//! CONVENTIONS sections 2-3: spherical sight geometry.
//!
//! All angles in radians. Longitude east-positive. GHA west-positive.
//! `LHA = GHA + lon_east`. This module is the single source of the altitude model
//! and its derivatives; the solver, the simulator, the planner and the reducer all
//! call into it so that no two crates can disagree about the formula.

use crate::units::{norm_2pi, norm_pi};
use std::f64::consts::PI;

/// A point on the sphere, radians, longitude east-positive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub lat: f64,
    pub lon: f64,
}

impl Point {
    pub fn new(lat: f64, lon: f64) -> Self {
        Point {
            lat,
            lon: norm_pi(lon),
        }
    }
    pub fn from_deg(lat_deg: f64, lon_deg: f64) -> Self {
        Point::new(lat_deg.to_radians(), lon_deg.to_radians())
    }
    pub fn lat_deg(&self) -> f64 {
        self.lat.to_degrees()
    }
    pub fn lon_deg(&self) -> f64 {
        self.lon.to_degrees()
    }
    /// Unit vector in the Earth-fixed frame: x through (0, 0), y through (0, 90E), z north.
    pub fn to_unit(&self) -> [f64; 3] {
        let (sl, cl) = self.lat.sin_cos();
        let (so, co) = self.lon.sin_cos();
        [cl * co, cl * so, sl]
    }
    pub fn from_unit(v: [f64; 3]) -> Self {
        // atan2 form: precise near the poles, tolerant of non-unit input.
        Point::new(v[2].atan2(v[0].hypot(v[1])), v[1].atan2(v[0]))
    }
}

/// Geographic position of a body: latitude = declination, longitude = -GHA (east-positive).
pub fn geographic_position(gha: f64, dec: f64) -> Point {
    Point::new(dec, -gha)
}

/// Computed altitude `Hc` (radians) of a body at the observer.
/// `sin Hc = sin(phi) sin(delta) + cos(phi) cos(delta) cos(LHA)`.
pub fn altitude(observer: Point, gha: f64, dec: f64) -> f64 {
    altitude_azimuth(observer, gha, dec).0
}

/// Computed altitude and true azimuth `Zn` in `[0, 2 pi)`, clockwise from north.
pub fn altitude_azimuth(observer: Point, gha: f64, dec: f64) -> (f64, f64) {
    let lha = gha + observer.lon;
    let (sphi, cphi) = observer.lat.sin_cos();
    let (sdec, cdec) = dec.sin_cos();
    let (slha, clha) = lha.sin_cos();
    let up = sphi * sdec + cphi * cdec * clha;
    let north = cphi * sdec - sphi * cdec * clha;
    let east = -cdec * slha;
    // atan2 keeps full precision near the zenith, where asin(up) loses ~1e-8 rad.
    let h = up.atan2(north.hypot(east));
    let zn = norm_2pi(east.atan2(north));
    (h, zn)
}

/// Partial derivatives of altitude with respect to latitude and (east) longitude,
/// given the azimuth: `dh/dphi = cos Zn`, `dh/dlambda = cos(phi) sin Zn`.
pub fn partials(observer_lat: f64, zn: f64) -> (f64, f64) {
    (zn.cos(), observer_lat.cos() * zn.sin())
}

/// Jacobian row in tangent-plane displacements (north, east), radians of arc:
/// `dh = cos(Zn) dN + sin(Zn) dE`.
pub fn tangent_row(zn: f64) -> (f64, f64) {
    (zn.cos(), zn.sin())
}

/// Great-circle angular distance between two points (robust for small and antipodal).
pub fn angular_distance(a: Point, b: Point) -> f64 {
    let u = a.to_unit();
    let v = b.to_unit();
    let cross = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let sin_d = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
    let cos_d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    sin_d.atan2(cos_d)
}

/// Initial bearing from `a` to `b`, `[0, 2 pi)` clockwise from north.
pub fn initial_bearing(a: Point, b: Point) -> f64 {
    let dlon = b.lon - a.lon;
    let y = dlon.sin() * b.lat.cos();
    let x = a.lat.cos() * b.lat.sin() - a.lat.sin() * b.lat.cos() * dlon.cos();
    norm_2pi(y.atan2(x))
}

/// Point reached from `start` travelling `distance` radians along `bearing`.
pub fn destination(start: Point, bearing: f64, distance: f64) -> Point {
    let (sl, cl) = start.lat.sin_cos();
    let (sd, cd) = distance.sin_cos();
    let (sb, cb) = bearing.sin_cos();
    let sin_lat2 = (sl * cd + cl * sd * cb).clamp(-1.0, 1.0);
    let lat2 = sin_lat2.atan2((1.0 - sin_lat2 * sin_lat2).max(0.0).sqrt());
    let lon2 = start.lon + (sb * sd * cl).atan2(cd - sl * sin_lat2);
    Point::new(lat2, lon2)
}

/// Local tangent-plane offset of `p` relative to `origin`: (north, east) in radians of
/// arc, exact along the great circle (distance and bearing), so it is valid at any
/// separation for the purpose of re-linearisation.
pub fn tangent_offset(origin: Point, p: Point) -> (f64, f64) {
    let d = angular_distance(origin, p);
    if d == 0.0 {
        return (0.0, 0.0);
    }
    let b = initial_bearing(origin, p);
    (d * b.cos(), d * b.sin())
}

/// Apply a tangent-plane step (north, east) in radians of arc from `origin`, moving
/// along the great circle in the direction of the step.
pub fn apply_tangent_step(origin: Point, north: f64, east: f64) -> Point {
    let d = north.hypot(east);
    if d == 0.0 {
        return origin;
    }
    destination(origin, east.atan2(north), d)
}

/// `n` points around the circle of position of angular radius `zenith_distance` about `gp`.
pub fn circle_of_position(gp: Point, zenith_distance: f64, n: usize) -> Vec<Point> {
    (0..n)
        .map(|i| destination(gp, 2.0 * PI * i as f64 / n as f64, zenith_distance))
        .collect()
}

/// Result of intersecting two circles of position.
#[derive(Debug, Clone, PartialEq)]
pub enum CircleIntersection {
    /// Two distinct intersection points: the classic two-body ambiguity.
    Two(Point, Point),
    /// Circles touch at one point (within tolerance).
    Tangent(Point),
    /// Circles do not meet (observations inconsistent with any single position).
    None { gap: f64 },
    /// Same geographic position and same radius: infinitely many solutions.
    Coincident,
}

/// Intersect two circles of position analytically. Tolerance is applied to the
/// tangency test only (`tol` radians, typically 1e-9).
pub fn two_circle_intersections(
    gp1: Point,
    z1: f64,
    gp2: Point,
    z2: f64,
    tol: f64,
) -> CircleIntersection {
    let g1 = gp1.to_unit();
    let g2 = gp2.to_unit();
    let d = (g1[0] * g2[0] + g1[1] * g2[1] + g1[2] * g2[2]).clamp(-1.0, 1.0);
    let one_minus_d2 = 1.0 - d * d;
    let c1 = z1.cos();
    let c2 = z2.cos();
    if one_minus_d2 < 1e-18 {
        // Concentric (same or antipodal GPs).
        let same = d > 0.0;
        let equal_radius = if same {
            (z1 - z2).abs() <= tol
        } else {
            (z1 + z2 - PI).abs() <= tol
        };
        return if equal_radius {
            CircleIntersection::Coincident
        } else {
            CircleIntersection::None {
                gap: if same {
                    (z1 - z2).abs()
                } else {
                    (z1 + z2 - PI).abs()
                },
            }
        };
    }
    let a = (c1 - c2 * d) / one_minus_d2;
    let b = (c2 - c1 * d) / one_minus_d2;
    let cross = [
        g1[1] * g2[2] - g1[2] * g2[1],
        g1[2] * g2[0] - g1[0] * g2[2],
        g1[0] * g2[1] - g1[1] * g2[0],
    ];
    let t2 = (1.0 - a * a - b * b - 2.0 * a * b * d) / one_minus_d2;
    let base = [
        a * g1[0] + b * g2[0],
        a * g1[1] + b * g2[1],
        a * g1[2] + b * g2[2],
    ];
    // Tangency: t^2 near zero. Convert the tolerance to the t^2 scale conservatively.
    if t2 < 0.0 {
        if t2 > -tol {
            return CircleIntersection::Tangent(Point::from_unit(base));
        }
        // Gap between circles along the line of GPs.
        let sep = angular_distance(gp1, gp2);
        let gap = if sep > z1 + z2 {
            sep - (z1 + z2)
        } else {
            (z1 - z2).abs() - sep
        };
        return CircleIntersection::None { gap: gap.max(0.0) };
    }
    let t = t2.sqrt();
    if t <= tol {
        return CircleIntersection::Tangent(Point::from_unit(base));
    }
    let p1 = [
        base[0] + t * cross[0],
        base[1] + t * cross[1],
        base[2] + t * cross[2],
    ];
    let p2 = [
        base[0] - t * cross[0],
        base[1] - t * cross[1],
        base[2] - t * cross[2],
    ];
    CircleIntersection::Two(Point::from_unit(p1), Point::from_unit(p2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    const D: f64 = PI / 180.0;

    #[test]
    fn body_at_zenith_has_altitude_90() {
        let obs = Point::from_deg(39.9526, -75.1652);
        // GP = observer: dec = lat, GHA = -lon = +75.1652 (west).
        let h = altitude(obs, 75.1652 * D, 39.9526 * D);
        assert_relative_eq!(h, PI / 2.0, epsilon = 1e-12);
    }

    #[test]
    fn body_on_meridian_north_and_south() {
        let obs = Point::from_deg(40.0, -75.0);
        // Same GHA as observer's -lon, dec 60N: body is 20 deg north of zenith -> Hc = 70, Zn = 0.
        let (h, zn) = altitude_azimuth(obs, 75.0 * D, 60.0 * D);
        assert_relative_eq!(h, 70.0 * D, epsilon = 1e-12);
        assert_relative_eq!(zn, 0.0, epsilon = 1e-12);
        // dec 10N: body is 30 deg south of zenith -> Hc = 60, Zn = 180.
        let (h, zn) = altitude_azimuth(obs, 75.0 * D, 10.0 * D);
        assert_relative_eq!(h, 60.0 * D, epsilon = 1e-12);
        assert_relative_eq!(zn, 180.0 * D, epsilon = 1e-12);
    }

    #[test]
    fn body_west_of_observer_has_westerly_azimuth() {
        // Observer on the equator at lon 0; body on the equator with GHA 30 (30 deg west).
        let obs = Point::from_deg(0.0, 0.0);
        let (h, zn) = altitude_azimuth(obs, 30.0 * D, 0.0);
        assert_relative_eq!(h, 60.0 * D, epsilon = 1e-12);
        assert_relative_eq!(zn, 270.0 * D, epsilon = 1e-12);
        // GHA 330 = 30 deg east.
        let (h, zn) = altitude_azimuth(obs, 330.0 * D, 0.0);
        assert_relative_eq!(h, 60.0 * D, epsilon = 1e-12);
        assert_relative_eq!(zn, 90.0 * D, epsilon = 1e-12);
    }

    #[test]
    fn analytic_case_from_spherical_triangle() {
        // Observer 40N 75W, body dec 20N, GHA 100W -> LHA = 25.
        // sin h = sin40 sin20 + cos40 cos20 cos25
        let obs = Point::from_deg(40.0, -75.0);
        let expected = (40f64 * D).sin() * (20f64 * D).sin()
            + (40f64 * D).cos() * (20f64 * D).cos() * (25f64 * D).cos();
        let (h, zn) = altitude_azimuth(obs, 100.0 * D, 20.0 * D);
        assert_relative_eq!(h.sin(), expected, epsilon = 1e-14);
        // Body is west of the meridian (LHA in (0,180)) and south: Zn in (180, 270).
        assert!(zn > 180.0 * D && zn < 270.0 * D, "zn = {}", zn / D);
    }

    #[test]
    fn partials_match_finite_differences() {
        let obs = Point::from_deg(40.0, -75.0);
        let (gha, dec) = (100.0 * D, 20.0 * D);
        let (_, zn) = altitude_azimuth(obs, gha, dec);
        let (dphi, dlam) = partials(obs.lat, zn);
        let eps = 1e-6;
        let fd_phi = (altitude(Point::new(obs.lat + eps, obs.lon), gha, dec)
            - altitude(Point::new(obs.lat - eps, obs.lon), gha, dec))
            / (2.0 * eps);
        let fd_lam = (altitude(Point::new(obs.lat, obs.lon + eps), gha, dec)
            - altitude(Point::new(obs.lat, obs.lon - eps), gha, dec))
            / (2.0 * eps);
        assert_relative_eq!(dphi, fd_phi, epsilon = 1e-8);
        assert_relative_eq!(dlam, fd_lam, epsilon = 1e-8);
        // Tangent-plane row: stepping 1 arcmin toward the body raises it by 1 arcmin.
        let step = PI / 10800.0;
        let moved = apply_tangent_step(obs, step * zn.cos(), step * zn.sin());
        let dh = altitude(moved, gha, dec) - altitude(obs, gha, dec);
        assert_relative_eq!(dh, step, epsilon = 1e-9);
    }

    #[test]
    fn distance_bearing_destination_round_trip() {
        let a = Point::from_deg(39.9526, -75.1652);
        let b = Point::from_deg(51.5074, -0.1278);
        let d = angular_distance(a, b);
        let brg = initial_bearing(a, b);
        let c = destination(a, brg, d);
        assert_relative_eq!(c.lat, b.lat, epsilon = 1e-12);
        assert_relative_eq!(c.lon, b.lon, epsilon = 1e-12);
        let (n, e) = tangent_offset(a, b);
        let back = apply_tangent_step(a, n, e);
        assert_relative_eq!(back.lat, b.lat, epsilon = 1e-12);
        assert_relative_eq!(back.lon, b.lon, epsilon = 1e-12);
        // Antipodal distance is pi; tiny distances are stable.
        assert_relative_eq!(
            angular_distance(Point::from_deg(0.0, 0.0), Point::from_deg(0.0, 180.0)),
            PI,
            epsilon = 1e-12
        );
        let tiny = angular_distance(a, Point::new(a.lat + 1e-9, a.lon));
        assert_relative_eq!(tiny, 1e-9, epsilon = 1e-15);
    }

    #[test]
    fn longitude_wraps_across_the_dateline() {
        let p = destination(Point::from_deg(0.0, 179.5), PI / 2.0, 1.0 * D);
        assert_relative_eq!(p.lon_deg(), -179.5, epsilon = 1e-9);
        let q = Point::from_deg(10.0, -180.0);
        assert_relative_eq!(q.lon_deg(), 180.0, epsilon = 1e-12);
    }

    #[test]
    fn circle_of_position_points_lie_on_the_circle() {
        let gp = Point::from_deg(38.79, -123.45);
        let z = 40.0 * D;
        for p in circle_of_position(gp, z, 36) {
            assert_relative_eq!(angular_distance(gp, p), z, epsilon = 1e-12);
        }
    }

    #[test]
    fn two_circles_intersect_symmetrically() {
        let gp1 = Point::from_deg(0.0, 0.0);
        let gp2 = Point::from_deg(0.0, 90.0);
        match two_circle_intersections(gp1, 60.0 * D, gp2, 60.0 * D, 1e-9) {
            CircleIntersection::Two(p, q) => {
                let mut lats = [p.lat_deg(), q.lat_deg()];
                lats.sort_by(|a, b| a.partial_cmp(b).unwrap());
                assert_relative_eq!(lats[0], -45.0, epsilon = 1e-9);
                assert_relative_eq!(lats[1], 45.0, epsilon = 1e-9);
                assert_relative_eq!(p.lon_deg(), 45.0, epsilon = 1e-9);
                assert_relative_eq!(q.lon_deg(), 45.0, epsilon = 1e-9);
                for pt in [p, q] {
                    assert_relative_eq!(angular_distance(gp1, pt), 60.0 * D, epsilon = 1e-9);
                    assert_relative_eq!(angular_distance(gp2, pt), 60.0 * D, epsilon = 1e-9);
                }
            }
            other => panic!("expected two intersections, got {other:?}"),
        }
    }

    #[test]
    fn great_circles_meet_at_the_poles() {
        let gp1 = Point::from_deg(0.0, 0.0);
        let gp2 = Point::from_deg(0.0, 90.0);
        match two_circle_intersections(gp1, 90.0 * D, gp2, 90.0 * D, 1e-9) {
            CircleIntersection::Two(p, q) => {
                assert_relative_eq!(p.lat_deg().abs(), 90.0, epsilon = 1e-9);
                assert_relative_eq!(q.lat_deg().abs(), 90.0, epsilon = 1e-9);
                assert!((p.lat_deg() - q.lat_deg()).abs() > 179.0);
            }
            other => panic!("expected two intersections, got {other:?}"),
        }
    }

    #[test]
    fn tangent_and_disjoint_and_coincident_circles() {
        let gp1 = Point::from_deg(0.0, 0.0);
        let gp2 = Point::from_deg(0.0, 90.0);
        // Externally tangent: 45 + 45 = 90.
        match two_circle_intersections(gp1, 45.0 * D, gp2, 45.0 * D, 1e-9) {
            CircleIntersection::Tangent(p) => {
                assert_relative_eq!(p.lat_deg(), 0.0, epsilon = 1e-6);
                assert_relative_eq!(p.lon_deg(), 45.0, epsilon = 1e-6);
            }
            other => panic!("expected tangent, got {other:?}"),
        }
        // Disjoint: 30 + 30 < 90.
        match two_circle_intersections(gp1, 30.0 * D, gp2, 30.0 * D, 1e-9) {
            CircleIntersection::None { gap } => assert_relative_eq!(gap, 30.0 * D, epsilon = 1e-9),
            other => panic!("expected none, got {other:?}"),
        }
        // Coincident.
        assert_eq!(
            two_circle_intersections(gp1, 30.0 * D, gp1, 30.0 * D, 1e-9),
            CircleIntersection::Coincident
        );
        // Antipodal GPs with complementary radii are the same circle.
        let anti = Point::from_deg(0.0, 180.0);
        assert_eq!(
            two_circle_intersections(gp1, 30.0 * D, anti, 150.0 * D, 1e-9),
            CircleIntersection::Coincident
        );
    }

    #[test]
    fn unit_vector_round_trip_and_gp() {
        let p = Point::from_deg(-33.8688, 151.2093);
        let q = Point::from_unit(p.to_unit());
        assert_relative_eq!(p.lat, q.lat, epsilon = 1e-12);
        assert_relative_eq!(p.lon, q.lon, epsilon = 1e-12);
        let gp = geographic_position(200.0 * D, -12.0 * D);
        assert_relative_eq!(gp.lat_deg(), -12.0, epsilon = 1e-12);
        assert_relative_eq!(gp.lon_deg(), 160.0, epsilon = 1e-12);
    }
}
