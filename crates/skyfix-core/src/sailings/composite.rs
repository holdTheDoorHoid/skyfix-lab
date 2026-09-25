//! Composite sailing (Bowditch 2019, vol. 1, ch. 12 §1205, §1213): a great circle from
//! the departure tangent to a limiting parallel, the parallel itself, and a great circle
//! tangent to it on to the destination. `docs/NAVIGATION_METHODS.md` §9 is normative.
//!
//! A great circle through a point at latitude `φ` whose vertex is on the limiting
//! parallel `φL` meets that parallel at a difference of longitude
//!
//! ```text
//! cos DLov = tan φ / tan φL          (Bowditch: cos DLovx = tan Lx cot Lv)
//! ```
//!
//! and its arc from the point to the vertex is `cos Dv = sin φ / sin φL` (the right
//! spherical triangle pole–point–vertex). The composite track applies only when the
//! direct great circle's vertex lies between the ends and beyond the limit; otherwise
//! the great circle itself is the answer, and the result says so.

use crate::SkyfixError;
use crate::geometry::Point;
use crate::units::{ARCMIN, norm_pi};

use super::great_circle::GreatCircle;

/// One piece of a composite track.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompositePiece {
    /// A great circle between two points.
    GreatCircle(GreatCircle),
    /// Due east or west along the limiting parallel: latitude, start longitude and the
    /// signed difference of longitude (radians).
    Parallel { lat: f64, lon_start: f64, dlo: f64 },
}

impl CompositePiece {
    /// Length, nautical miles (parallel sailing on the sphere: `DLo cos φ`).
    pub fn distance_nm(&self) -> f64 {
        match self {
            CompositePiece::GreatCircle(gc) => gc.distance_nm(),
            CompositePiece::Parallel { lat, dlo, .. } => dlo.abs() * lat.cos() / ARCMIN,
        }
    }

    pub fn start(&self) -> Point {
        match self {
            CompositePiece::GreatCircle(gc) => gc.from,
            CompositePiece::Parallel { lat, lon_start, .. } => Point::new(*lat, *lon_start),
        }
    }

    pub fn end(&self) -> Point {
        match self {
            CompositePiece::GreatCircle(gc) => gc.to,
            CompositePiece::Parallel {
                lat,
                lon_start,
                dlo,
                ..
            } => Point::new(*lat, lon_start + dlo),
        }
    }

    /// The point `nm` nautical miles from this piece's start.
    pub fn point_at_nm(&self, nm: f64) -> Point {
        match self {
            CompositePiece::GreatCircle(gc) => gc.point_at(nm * ARCMIN),
            CompositePiece::Parallel {
                lat,
                lon_start,
                dlo,
                ..
            } => {
                let total = self.distance_nm();
                let f = if total > 0.0 { nm / total } else { 0.0 };
                Point::new(*lat, lon_start + dlo * f)
            }
        }
    }

    /// Course at `nm` from the start, radians.
    pub fn course_at_nm(&self, nm: f64) -> f64 {
        match self {
            CompositePiece::GreatCircle(gc) => gc.course_at(nm * ARCMIN),
            CompositePiece::Parallel { dlo, .. } => {
                if *dlo >= 0.0 {
                    std::f64::consts::FRAC_PI_2
                } else {
                    1.5 * std::f64::consts::PI
                }
            }
        }
    }

    /// Where the piece crosses the meridian `lon`, as nautical miles from its start.
    pub fn meridian_crossing_nm(&self, lon: f64) -> Option<f64> {
        match self {
            CompositePiece::GreatCircle(gc) => gc.meridian_crossing(lon).map(|s| s / ARCMIN),
            CompositePiece::Parallel { lon_start, dlo, .. } => {
                if *dlo == 0.0 {
                    return None;
                }
                let along = norm_pi(lon - lon_start) / dlo;
                // `norm_pi` may have wrapped the wrong way for a parallel leg of more
                // than 180 degrees; try the other representative too.
                let alt =
                    (norm_pi(lon - lon_start) - 2.0 * std::f64::consts::PI * dlo.signum()) / dlo;
                [along, alt]
                    .into_iter()
                    .find(|f| (0.0..=1.0).contains(f))
                    .map(|f| f * self.distance_nm())
            }
        }
    }
}

/// The composite track, or the reason it is the plain great circle.
#[derive(Debug, Clone, PartialEq)]
pub struct Composite {
    /// Limiting latitude, radians (signed: north positive).
    pub limit: f64,
    /// `false` when the great circle never passes the limit between the ends: then
    /// `pieces` is the great circle alone.
    pub applies: bool,
    pub pieces: Vec<CompositePiece>,
    pub note: String,
}

impl Composite {
    pub fn distance_nm(&self) -> f64 {
        self.pieces.iter().map(CompositePiece::distance_nm).sum()
    }
}

/// Composite sailing from `from` to `to` without passing the parallel `limit`
/// (radians, signed: +47° keeps the track south of 47° N, −60° north of 60° S).
///
/// Errors when an end is already beyond the limit, or the limit is a pole or the
/// equator. When the direct great circle stays within the limit the result is that
/// great circle (`applies = false`) with a note.
pub fn composite(from: Point, to: Point, limit: f64) -> Result<Composite, SkyfixError> {
    let direct = GreatCircle::new(from, to)?;
    let half_pi = std::f64::consts::FRAC_PI_2;
    if !limit.is_finite() || limit.abs() >= half_pi || limit == 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "limiting_latitude_deg".to_string(),
            message: "must be a latitude strictly between the equator and a pole (north \
                      positive: 47 keeps the track south of 47° N, -60 north of 60° S)"
                .to_string(),
        });
    }
    let north = limit > 0.0;
    let beyond = |lat: f64| if north { lat > limit } else { lat < limit };
    for (name, p) in [("from", from), ("to", to)] {
        if beyond(p.lat) {
            return Err(SkyfixError::InvalidField {
                field: name.to_string(),
                message: format!(
                    "{name} is at {:.4}°, already beyond the limiting latitude {:.4}°",
                    p.lat.to_degrees(),
                    limit.to_degrees()
                ),
            });
        }
    }
    let plain = |note: String| Composite {
        limit,
        applies: false,
        pieces: vec![CompositePiece::GreatCircle(direct)],
        note,
    };
    if direct.is_null() {
        return Ok(plain("departure and destination coincide".to_string()));
    }
    // The vertex on the limit's side, and whether it lies between the ends.
    let vertex = match direct.vertices() {
        Some((n, s)) => {
            if north {
                n
            } else {
                s
            }
        }
        None => {
            return Ok(plain(
                "the great circle runs along the equator and never approaches the limit"
                    .to_string(),
            ));
        }
    };
    let between = vertex.arc_from_start > 0.0 && vertex.arc_from_start < direct.distance_rad();
    if !between || !beyond(vertex.point.lat) {
        let highest = if between {
            vertex.point.lat
        } else if north {
            from.lat.max(to.lat)
        } else {
            from.lat.min(to.lat)
        };
        return Ok(plain(format!(
            "the great circle's farthest point toward the limit is {:.4}°, within the \
             limiting latitude {:.4}°: composite sailing is not needed and the great circle \
             is the track",
            highest.to_degrees(),
            limit.to_degrees()
        )));
    }
    // The direction of travel in longitude: that of the great circle (monotonic).
    let dir = direct.longitude_change().signum();
    let dir = if dir == 0.0 { 1.0 } else { dir };
    let tan_l = limit.tan();
    let dlov = |lat: f64| (lat.tan() / tan_l).clamp(-1.0, 1.0).acos();
    let lon1 = from.lon + dir * dlov(from.lat);
    let lon2 = to.lon - dir * dlov(to.lat);
    let t1 = Point::new(limit, lon1);
    let t2 = Point::new(limit, lon2);
    let dlo = dir * (dir * norm_pi(lon2 - lon1)).rem_euclid(2.0 * std::f64::consts::PI);
    let gc1 = GreatCircle::new(from, t1)?;
    let gc2 = GreatCircle::new(t2, to)?;
    let mut pieces = Vec::with_capacity(3);
    if !gc1.is_null() {
        pieces.push(CompositePiece::GreatCircle(gc1));
    }
    pieces.push(CompositePiece::Parallel {
        lat: limit,
        lon_start: lon1,
        dlo,
    });
    if !gc2.is_null() {
        pieces.push(CompositePiece::GreatCircle(gc2));
    }
    Ok(Composite {
        limit,
        applies: true,
        pieces,
        note: format!(
            "the great circle would reach {:.4}°; the composite track follows a great circle \
             to the limiting parallel {:.4}°, runs along it, and leaves it on a great circle \
             tangent to it",
            vertex.point.lat.to_degrees(),
            limit.to_degrees()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: f64 = std::f64::consts::PI / 180.0;

    fn dm(d: f64, m: f64) -> f64 {
        (d.abs() + m / 60.0).copysign(d)
    }

    #[test]
    fn the_tangent_great_circles_have_their_vertices_on_the_limit() {
        let from = Point::from_deg(dm(36.0, 57.7), -dm(75.0, 42.2));
        let to = Point::from_deg(dm(45.0, 39.1), -dm(1.0, 29.8));
        let c = composite(from, to, 47.0 * D).unwrap();
        assert!(c.applies);
        assert_eq!(c.pieces.len(), 3);
        for piece in &c.pieces {
            if let CompositePiece::GreatCircle(gc) = piece {
                let (v, _) = gc.vertices().unwrap();
                assert!((v.point.lat - 47.0 * D).abs() < 1e-12);
            }
        }
        // The pieces join end to start and the track never passes 47 N.
        for w in c.pieces.windows(2) {
            let (a, b) = (w[0].end(), w[1].start());
            assert!((a.lat - b.lat).abs() < 1e-12 && norm_pi(a.lon - b.lon).abs() < 1e-12);
        }
        let mut s = 0.0;
        while s < c.distance_nm() {
            let mut left = s;
            for piece in &c.pieces {
                let len = piece.distance_nm();
                if left <= len {
                    assert!(piece.point_at_nm(left).lat <= 47.0 * D + 1e-12);
                    break;
                }
                left -= len;
            }
            s += 25.0;
        }
        // Longer than the great circle, shorter than the rhumb line would be here.
        let gc = GreatCircle::new(from, to).unwrap();
        assert!(c.distance_nm() > gc.distance_nm());
    }

    #[test]
    fn a_limit_the_great_circle_never_reaches_leaves_it_alone() {
        let from = Point::from_deg(10.0, -60.0);
        let to = Point::from_deg(20.0, -20.0);
        let c = composite(from, to, 47.0 * D).unwrap();
        assert!(!c.applies);
        assert_eq!(c.pieces.len(), 1);
        assert!(c.note.contains("not needed"), "{}", c.note);
        // A southern limit for a northern route never binds either.
        let c = composite(
            Point::from_deg(36.96, -75.7),
            Point::from_deg(45.65, -1.5),
            -47.0 * D,
        )
        .unwrap();
        assert!(!c.applies);
    }

    #[test]
    fn an_end_beyond_the_limit_is_refused() {
        let e = composite(
            Point::from_deg(50.0, 0.0),
            Point::from_deg(40.0, 30.0),
            47.0 * D,
        )
        .unwrap_err();
        assert!(
            e.to_string().contains("beyond the limiting latitude"),
            "{e}"
        );
        let e =
            composite(Point::from_deg(40.0, 0.0), Point::from_deg(41.0, 30.0), 0.0).unwrap_err();
        assert!(e.to_string().contains("limiting_latitude_deg"), "{e}");
    }

    #[test]
    fn southern_routes_work_the_same_way() {
        // Cape Town to Melbourne, keeping north of 45 S.
        let from = Point::from_deg(-34.36, 18.47);
        let to = Point::from_deg(-38.3, 144.6);
        let c = composite(from, to, -45.0 * D).unwrap();
        assert!(c.applies, "{}", c.note);
        for piece in &c.pieces {
            if let CompositePiece::Parallel { lat, dlo, .. } = piece {
                assert!((lat + 45.0 * D).abs() < 1e-15);
                assert!(*dlo > 0.0);
            }
        }
    }
}
