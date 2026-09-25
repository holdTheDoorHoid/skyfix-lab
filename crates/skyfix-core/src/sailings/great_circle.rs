//! Great-circle sailing on the sphere of CONVENTIONS section 1 (1′ of arc = 1 NM).
//!
//! `docs/NAVIGATION_METHODS.md` §9 is normative. Everything is done with unit vectors,
//! which keeps the formulas exact and well conditioned where the textbook trigonometry
//! is not (short legs, legs along a meridian, a departure on the equator):
//!
//! ```text
//! p1, p2      unit vectors of the departure and the destination
//! n = (p1 × p2) / |p1 × p2|      the pole of the great circle; travel p1 -> p2 turns
//!                                positively about n
//! t1 = n × p1                    the unit direction of travel at the departure
//! p(s) = p1 cos s + t1 sin s     the point s radians along the track (any real s)
//! ```
//!
//! The initial course is the bearing of `t1`; the final course the bearing of the
//! direction of travel at `s = D`. The vertices are the points of the circle nearest the
//! poles, `± (ẑ − n_z n) / sqrt(1 − n_z²)`, at latitude `acos |n_z|` (Clairaut:
//! `cos φ sin C` is the same everywhere on a great circle). Where the track crosses the
//! meridian `λ`, `tan φ = −(n_x cos λ + n_y sin λ) / n_z`.
//!
//! Bowditch (2019, vol. 1, ch. 12 §1208–1211) gives the same quantities by spherical
//! trigonometry; the worked examples reproduce (tests/sailings_worked_examples.rs).

use crate::SkyfixError;
use crate::geometry::Point;
use crate::units::{norm_2pi, norm_pi, rad_to_nm};

/// A three-vector in the Earth-fixed frame of [`Point::to_unit`].
pub type Vec3 = [f64; 3];

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn scale(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

pub(crate) fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn length(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

/// Local north and east unit vectors at a point.
pub(crate) fn north_east(p: Point) -> (Vec3, Vec3) {
    let (sl, cl) = p.lat.sin_cos();
    let (so, co) = p.lon.sin_cos();
    ([-sl * co, -sl * so, cl], [-so, co, 0.0])
}

/// Bearing of a tangent direction `t` at `p`, radians clockwise from north, `[0, 2 pi)`.
pub(crate) fn bearing_of(p: Point, t: Vec3) -> f64 {
    let (north, east) = north_east(p);
    norm_2pi(dot(t, east).atan2(dot(t, north)))
}

/// Below this cross-product length the two points are treated as coincident or
/// antipodal (1e-12 rad is 6 micrometres on the Earth).
pub const DEGENERATE: f64 = 1e-12;

/// A great circle inclined to the equator by less than this (radians; 6 mm on the
/// Earth) is taken to run along it: it has no vertices and no equator crossing.
pub const ALONG_EQUATOR: f64 = 1e-9;

/// The great circle from one point to another, with the track parametrised by the
/// distance run along it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GreatCircle {
    pub from: Point,
    pub to: Point,
    p1: Vec3,
    /// Unit direction of travel at the departure.
    t1: Vec3,
    /// Unit pole of the circle (right-handed with the direction of travel).
    n: Vec3,
    /// Angular length of the track, radians, `[0, pi)`.
    d: f64,
}

/// A vertex of a great circle: the point nearest a pole, where the track runs due east
/// or due west.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vertex {
    pub point: Point,
    /// Signed arc from the departure along the direction of travel, radians,
    /// `(-pi, pi]`: negative when the vertex is behind the departure.
    pub arc_from_start: f64,
}

impl GreatCircle {
    /// The track from `from` to `to`. Errors for antipodal points, through which every
    /// great circle passes; two coincident points give a track of length zero whose
    /// course is undefined (see [`GreatCircle::is_null`]).
    pub fn new(from: Point, to: Point) -> Result<Self, SkyfixError> {
        let p1 = from.to_unit();
        let p2 = to.to_unit();
        let c = cross(p1, p2);
        let s = length(c);
        let cos_d = dot(p1, p2);
        if s < DEGENERATE {
            if cos_d < 0.0 {
                return Err(SkyfixError::InvalidField {
                    field: "to".to_string(),
                    message: "the destination is the antipode of the departure: every great \
                              circle through them is 10 800 NM long and none is shorter; add \
                              a waypoint to choose one"
                        .to_string(),
                });
            }
            // Coincident: any circle through the point will do; the course is undefined.
            let (north, _) = north_east(from);
            let n = cross(p1, north);
            return Ok(GreatCircle {
                from,
                to,
                p1,
                t1: north,
                n,
                d: 0.0,
            });
        }
        let n = scale(c, 1.0 / s);
        let t1 = cross(n, p1);
        Ok(GreatCircle {
            from,
            to,
            p1,
            t1,
            n,
            d: s.atan2(cos_d),
        })
    }

    /// A great circle through `from` on a given initial course (radians), for tracks
    /// defined by a course rather than a destination. `to` is the point `length` radians
    /// along it.
    pub fn from_course(from: Point, course: f64, length: f64) -> Self {
        let p1 = from.to_unit();
        let (north, east) = north_east(from);
        let (sc, cc) = course.sin_cos();
        let t1 = add(scale(north, cc), scale(east, sc));
        let n = cross(p1, t1);
        let mut gc = GreatCircle {
            from,
            to: from,
            p1,
            t1,
            n,
            d: length,
        };
        gc.to = gc.point_at(length);
        gc
    }

    /// True when the two points coincide (to 6 micrometres): no course exists.
    pub fn is_null(&self) -> bool {
        self.d == 0.0
    }

    /// Length of the track, radians of arc.
    pub fn distance_rad(&self) -> f64 {
        self.d
    }

    /// Length of the track, nautical miles (1′ = 1 NM).
    pub fn distance_nm(&self) -> f64 {
        rad_to_nm(self.d)
    }

    /// The unit pole of the circle.
    pub fn pole(&self) -> Vec3 {
        self.n
    }

    /// The point `s` radians along the track from the departure (negative: behind it).
    pub fn point_at(&self, s: f64) -> Point {
        let (ss, cs) = s.sin_cos();
        Point::from_unit(add(scale(self.p1, cs), scale(self.t1, ss)))
    }

    /// The direction of travel at `s` radians along the track, radians clockwise from
    /// north, `[0, 2 pi)`. Undefined (north) for a null track.
    pub fn course_at(&self, s: f64) -> f64 {
        let (ss, cs) = s.sin_cos();
        let t = add(scale(self.p1, -ss), scale(self.t1, cs));
        bearing_of(self.point_at(s), t)
    }

    /// Initial course, radians `[0, 2 pi)`.
    pub fn initial_course(&self) -> f64 {
        self.course_at(0.0)
    }

    /// Final course: the direction of travel on arrival, radians `[0, 2 pi)`.
    pub fn final_course(&self) -> f64 {
        self.course_at(self.d)
    }

    /// Signed arc from the departure to a point of the circle, `(-pi, pi]`.
    pub fn arc_to(&self, p: Vec3) -> f64 {
        dot(cross(self.p1, p), self.n).atan2(dot(self.p1, p))
    }

    /// The two vertices, northern first. `None` when the track runs along the equator
    /// (every point is as far from the poles as any other).
    pub fn vertices(&self) -> Option<(Vertex, Vertex)> {
        let nz = self.n[2];
        // |n x z| = sqrt(nx^2 + ny^2): the sine of the inclination, without cancellation.
        let r = self.n[0].hypot(self.n[1]);
        if r < ALONG_EQUATOR {
            return None;
        }
        let v = scale(add([0.0, 0.0, 1.0], scale(self.n, -nz)), 1.0 / r);
        let w = scale(v, -1.0);
        Some((
            Vertex {
                point: Point::from_unit(v),
                arc_from_start: self.arc_to(v),
            },
            Vertex {
                point: Point::from_unit(w),
                arc_from_start: self.arc_to(w),
            },
        ))
    }

    /// Bowditch's vertex (§1211): the one in the departure's hemisphere; for a
    /// departure on the equator, the one ahead.
    pub fn vertex(&self) -> Option<Vertex> {
        let (north, south) = self.vertices()?;
        Some(if self.from.lat > 0.0 {
            north
        } else if self.from.lat < 0.0 {
            south
        } else if north.arc_from_start > 0.0 {
            north
        } else {
            south
        })
    }

    /// The arc from the departure at which the track crosses the meridian `lon`
    /// (radians, east-positive), when it does so between the departure and the
    /// destination. `None` for a track along a meridian or one that does not reach it.
    pub fn meridian_crossing(&self, lon: f64) -> Option<f64> {
        let n = self.n;
        if n[2].abs() < DEGENERATE {
            return None;
        }
        let (so, co) = lon.sin_cos();
        let lat = (-(n[0] * co + n[1] * so) / n[2]).atan();
        let p = Point::new(lat, lon).to_unit();
        let s = self.arc_to(p);
        let s = if s < 0.0 {
            s + 2.0 * std::f64::consts::PI
        } else {
            s
        };
        (s <= self.d).then_some(s)
    }

    /// Where the track crosses the equator between the ends, as an arc from the
    /// departure. `None` when it stays in one hemisphere (or runs along the equator).
    pub fn equator_crossing(&self) -> Option<f64> {
        // Points of the circle on the equator: z = 0, i.e. p = ±(n × ẑ) normalised.
        let e = cross(self.n, [0.0, 0.0, 1.0]);
        let r = length(e);
        if r < ALONG_EQUATOR || self.d == 0.0 {
            return None;
        }
        let e = scale(e, 1.0 / r);
        [e, scale(e, -1.0)]
            .into_iter()
            .map(|q| self.arc_to(q))
            .filter(|&s| s > 0.0 && s < self.d)
            .min_by(|a, b| a.total_cmp(b))
    }

    /// The signed change of longitude along the track, radians, `(-pi, pi]`. Along a
    /// great circle the longitude changes monotonically (Clairaut: `cos φ sin C` keeps
    /// its sign), and an arc shorter than half the circle spans less than 180°, so this
    /// is the shorter-way difference of the end longitudes.
    pub fn longitude_change(&self) -> f64 {
        norm_pi(self.to.lon - self.from.lon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{angular_distance, destination, initial_bearing};

    const D: f64 = std::f64::consts::PI / 180.0;

    #[test]
    fn distance_and_courses_agree_with_the_geometry_module() {
        let cases = [
            ((-22.0, 116.0), (-20.0, 31.0)),
            ((28.0, -122.0), (-24.0, 151.0)),
            ((39.95, -75.17), (51.47, -0.45)),
            ((0.0, 0.0), (0.0, 90.0)),
            ((10.0, 20.0), (-60.0, 20.0)),
        ];
        for ((a1, o1), (a2, o2)) in cases {
            let p = Point::from_deg(a1, o1);
            let q = Point::from_deg(a2, o2);
            let gc = GreatCircle::new(p, q).unwrap();
            assert!((gc.distance_rad() - angular_distance(p, q)).abs() < 1e-14);
            assert!((gc.initial_course() - initial_bearing(p, q)).abs() < 1e-12);
            // Walking the track lands on the destination.
            let end = gc.point_at(gc.distance_rad());
            assert!(angular_distance(end, q) < 1e-13);
            // The final course is the reverse track's initial course, turned round.
            let back = norm_2pi(initial_bearing(q, p) + std::f64::consts::PI);
            assert!(norm_pi(gc.final_course() - back).abs() < 1e-12);
            // So is the course the geometry module would steer from any point.
            let mid = gc.point_at(0.4 * gc.distance_rad());
            assert!(
                norm_pi(gc.course_at(0.4 * gc.distance_rad()) - initial_bearing(mid, q)).abs()
                    < 1e-11
            );
        }
    }

    #[test]
    fn from_course_matches_destination() {
        let p = Point::from_deg(28.0, -125.0);
        let gc = GreatCircle::from_course(p, 249.0 * D, 50.0 * D);
        let q = destination(p, 249.0 * D, 50.0 * D);
        assert!(angular_distance(gc.to, q) < 1e-13);
        assert!((gc.initial_course() - 249.0 * D).abs() < 1e-12);
    }

    #[test]
    fn clairaut_holds_at_the_vertex_and_along_the_track() {
        let gc = GreatCircle::new(
            Point::from_deg(36.9617, -75.7033),
            Point::from_deg(45.6517, -1.4967),
        )
        .unwrap();
        let k = gc.from.lat.cos() * gc.initial_course().sin();
        let (v, _) = gc.vertices().unwrap();
        assert!((v.point.lat.cos() - k.abs()).abs() < 1e-14);
        for f in [0.1, 0.3, 0.77, 1.0] {
            let s = f * gc.distance_rad();
            let p = gc.point_at(s);
            assert!((p.lat.cos() * gc.course_at(s).sin() - k).abs() < 1e-13);
        }
        // At the vertex the track runs due east or west.
        let c = gc.course_at(v.arc_from_start);
        assert!(
            (c - 90.0 * D).abs() < 1e-9 || (c - 270.0 * D).abs() < 1e-9,
            "{}",
            c / D
        );
    }

    #[test]
    fn meridian_crossings_lie_on_the_track() {
        let gc =
            GreatCircle::new(Point::from_deg(28.0, -125.0), Point::from_deg(-10.0, 170.0)).unwrap();
        for lon in [-130.0, -150.0, -179.5, 179.0, 175.0] {
            let s = gc.meridian_crossing(lon * D).unwrap();
            let p = gc.point_at(s);
            assert!(norm_pi(p.lon - lon * D).abs() < 1e-12, "{lon}");
        }
        assert!(gc.meridian_crossing(-100.0 * D).is_none());
        assert!(gc.meridian_crossing(160.0 * D).is_none());
    }

    #[test]
    fn the_equator_crossing_and_degenerate_tracks() {
        let gc =
            GreatCircle::new(Point::from_deg(28.0, -122.0), Point::from_deg(-24.0, 151.0)).unwrap();
        let s = gc.equator_crossing().unwrap();
        assert!(gc.point_at(s).lat.abs() < 1e-14);
        let equator =
            GreatCircle::new(Point::from_deg(0.0, 0.0), Point::from_deg(0.0, 50.0)).unwrap();
        assert!(equator.vertices().is_none());
        assert!(equator.equator_crossing().is_none());
        let same =
            GreatCircle::new(Point::from_deg(10.0, 10.0), Point::from_deg(10.0, 10.0)).unwrap();
        assert!(same.is_null());
        assert_eq!(same.distance_nm(), 0.0);
        let e = GreatCircle::new(Point::from_deg(10.0, 10.0), Point::from_deg(-10.0, -170.0))
            .unwrap_err();
        assert!(e.to_string().contains("antipode"), "{e}");
    }
}
