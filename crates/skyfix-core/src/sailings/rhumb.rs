//! Rhumb-line sailings: Mercator sailing (the exact loxodrome), mid-latitude, parallel,
//! plane and traverse sailing. `docs/NAVIGATION_METHODS.md` §9 is normative.
//!
//! # Mercator sailing
//!
//! A rhumb line crosses every meridian at the same angle, so on a Mercator chart it is
//! straight. With the meridional parts `M(φ)` (the chart's northing, in minutes of
//! equatorial arc), the course and the difference of longitude obey
//!
//! ```text
//! tan C = DLo / m,     m = M(φ2) − M(φ1)
//! ```
//!
//! and the distance is the plane-sailing `D = l sec C` with `l` the difference of
//! latitude in minutes (Bowditch 2019, vol. 1, ch. 12 §1219).
//!
//! Two figures are offered ([`MeridionalParts`]):
//!
//! - **`sphere`** (default): the sphere of CONVENTIONS section 1, on which 1′ of arc is
//!   1 NM everywhere. `M(φ) = (10800/π) atanh(sin φ)`. Course, distance and position are
//!   those of the true loxodrome on that sphere.
//! - **`wgs84`**: meridional parts of the WGS84 ellipsoid,
//!   `M(φ) = (10800/π) [atanh(sin φ) − e atanh(e sin φ)]` — what a Mercator chart on WGS84
//!   is drawn with and what Bowditch's Table 6 tabulates (to its 0.1′, whichever modern
//!   spheroid it was computed on). The course and the difference of longitude are then
//!   the WGS84 loxodrome's; the distance keeps Bowditch's `D = l sec C` with 1′ of
//!   latitude taken as 1 NM, exactly as a navigator measures it on the chart's latitude
//!   scale. That convention differs from the true length on the ellipsoid by the ratio
//!   of the local meridian minute to 1852 m (−0.5 % at the equator, +0.5 % at the
//!   poles), and for a course due east or west it gives `DLo cos φ (1 − e² sin²φ)/(1 − e²)`
//!   rather than parallel sailing's `DLo cos φ` (up to 0.67 % more near the equator).
//!
//! Every formula is written so that it stays exact for courses near due east or west,
//! where `tan C` and `sec C` blow up: the difference of latitude and the stretched
//! difference of latitude `Δψ` are combined as `q = Δφ / Δψ` (which tends to
//! `dφ/dψ = cos φ` on the sphere), and `Δψ` itself is taken from the difference formula
//! `atanh a − atanh b = atanh((a − b)/(1 − a b))`, never as a difference of two large
//! numbers.
//!
//! # The approximations Bowditch also teaches
//!
//! - **Mid-latitude sailing** (§1218): `p = DLo cos Lm`, `tan C = p / l`, `D = l sec C`,
//!   `Lm` the mean latitude. Good for short legs; across the equator Bowditch solves each
//!   side separately, which [`mid_latitude_direct`] does and [`mid_latitude_inverse`]
//!   declines (the two sides would need two courses).
//! - **Parallel sailing** (§1217): `DLo = p sec L` — the rhumb line due east or west.
//! - **Plane and traverse sailing** (§1215–1216): `l = D cos C`, `p = D sin C`, summed
//!   over legs; no longitude.

use serde::{Deserialize, Serialize};

use crate::SkyfixError;
use crate::geometry::Point;
use crate::units::{ARCMIN, norm_2pi, norm_pi};

/// WGS84 first eccentricity squared, `f (2 − f)` with `f = 1 / 298.257223563`.
pub const WGS84_E2: f64 = 0.006_694_379_990_141_317;

/// Which figure the meridional parts of Mercator sailing are computed on.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeridionalParts {
    /// The sphere of CONVENTIONS section 1 (1′ = 1 NM). Default.
    #[default]
    Sphere,
    /// The WGS84 ellipsoid, as a Mercator chart and Bowditch's Table 6; distances keep
    /// 1′ of latitude = 1 NM (the chart's latitude scale).
    Wgs84,
}

impl MeridionalParts {
    fn e2(self) -> f64 {
        match self {
            MeridionalParts::Sphere => 0.0,
            MeridionalParts::Wgs84 => WGS84_E2,
        }
    }

    /// Wire spelling.
    pub fn name(self) -> &'static str {
        match self {
            MeridionalParts::Sphere => "sphere",
            MeridionalParts::Wgs84 => "wgs84",
        }
    }
}

/// Minutes of arc per radian.
const ARCMIN_PER_RAD: f64 = 1.0 / ARCMIN;

/// The isometric latitude `ψ` (radians): `atanh(sin φ)` on the sphere, less
/// `e atanh(e sin φ)` on the ellipsoid. Infinite at the poles.
pub fn isometric_latitude(lat: f64, parts: MeridionalParts) -> f64 {
    let s = lat.sin();
    let e2 = parts.e2();
    if e2 == 0.0 {
        s.atanh()
    } else {
        let e = e2.sqrt();
        s.atanh() - e * (e * s).atanh()
    }
}

/// Meridional parts `M(φ)`, minutes of equatorial arc (Bowditch Table 6; 0 at the
/// equator, infinite at the poles). `lat` in radians.
pub fn meridional_parts_arcmin(lat: f64, parts: MeridionalParts) -> f64 {
    isometric_latitude(lat, parts) * ARCMIN_PER_RAD
}

/// `Δψ = ψ(φ2) − ψ(φ1)` without cancellation, radians.
fn delta_psi(lat1: f64, lat2: f64, parts: MeridionalParts) -> f64 {
    let (s1, s2) = (lat1.sin(), lat2.sin());
    // sin φ2 − sin φ1, exactly as the product it is.
    let ds = 2.0 * (0.5 * (lat1 + lat2)).cos() * (0.5 * (lat2 - lat1)).sin();
    let sphere = (ds / (1.0 - s1 * s2)).atanh();
    let e2 = parts.e2();
    if e2 == 0.0 {
        sphere
    } else {
        let e = e2.sqrt();
        sphere - e * (e * ds / (1.0 - e2 * s1 * s2)).atanh()
    }
}

/// `dφ/dψ` at `lat`: `cos φ` on the sphere, `cos φ (1 − e² sin²φ) / (1 − e²)` on the
/// ellipsoid.
fn dlat_dpsi(lat: f64, parts: MeridionalParts) -> f64 {
    let e2 = parts.e2();
    let s = lat.sin();
    lat.cos() * (1.0 - e2 * s * s) / (1.0 - e2)
}

/// `q = Δφ / Δψ`: the factor that turns a difference of longitude into minutes of
/// latitude along the rhumb line (the "departure" factor; `cos φ` for a short leg on the
/// sphere).
fn q_factor(lat1: f64, lat2: f64, parts: MeridionalParts) -> f64 {
    let dlat = lat2 - lat1;
    if dlat.abs() < 1e-12 {
        dlat_dpsi(0.5 * (lat1 + lat2), parts)
    } else {
        dlat / delta_psi(lat1, lat2, parts)
    }
}

/// A rhumb line between two points (Mercator sailing).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RhumbSolution {
    /// Course, radians clockwise from north, `[0, 2 pi)`; `None` for coincident points.
    pub course: Option<f64>,
    /// Distance, nautical miles (1′ of latitude = 1 NM).
    pub distance_nm: f64,
    /// Difference of latitude `l`, minutes, north positive.
    pub dlat_arcmin: f64,
    /// Difference of longitude `DLo`, minutes, east positive, the shorter way round.
    pub dlo_arcmin: f64,
    /// Departure `p = D sin C`, nautical miles, east positive.
    pub departure_nm: f64,
    /// Meridional difference `m`, minutes of equatorial arc, north positive. Infinite
    /// when an end is at a pole.
    pub meridional_difference_arcmin: f64,
}

/// Course and distance along the rhumb line from `from` to `to` (Mercator sailing,
/// Bowditch §1219). The rhumb line goes the shorter way round in longitude.
pub fn rhumb_inverse(from: Point, to: Point, parts: MeridionalParts) -> RhumbSolution {
    let dlat = to.lat - from.lat;
    let dlo = norm_pi(to.lon - from.lon);
    let at_pole = from.lat.abs() >= std::f64::consts::FRAC_PI_2 - 1e-15
        || to.lat.abs() >= std::f64::consts::FRAC_PI_2 - 1e-15;
    if at_pole {
        // Only a meridian reaches a pole; the longitude there is not a direction.
        let course = if dlat == 0.0 {
            None
        } else if dlat > 0.0 {
            Some(0.0)
        } else {
            Some(std::f64::consts::PI)
        };
        return RhumbSolution {
            course,
            distance_nm: dlat.abs() * ARCMIN_PER_RAD,
            dlat_arcmin: dlat * ARCMIN_PER_RAD,
            dlo_arcmin: dlo * ARCMIN_PER_RAD,
            departure_nm: 0.0,
            meridional_difference_arcmin: if dlat >= 0.0 {
                f64::INFINITY
            } else {
                f64::NEG_INFINITY
            },
        };
    }
    let q = q_factor(from.lat, to.lat, parts);
    // Everything in radians of latitude: north component `dlat`, east component `q DLo`.
    let east = q * dlo;
    let distance = dlat.hypot(east);
    let course = (distance > 0.0).then(|| norm_2pi(east.atan2(dlat)));
    RhumbSolution {
        course,
        distance_nm: distance * ARCMIN_PER_RAD,
        dlat_arcmin: dlat * ARCMIN_PER_RAD,
        dlo_arcmin: dlo * ARCMIN_PER_RAD,
        departure_nm: east * ARCMIN_PER_RAD,
        meridional_difference_arcmin: delta_psi(from.lat, to.lat, parts) * ARCMIN_PER_RAD,
    }
}

/// Where a vessel arrives after `distance_nm` along the rhumb line of `course`
/// (radians) from `from`. A negative distance runs the line backwards, which for a rhumb
/// line is exactly the reverse walk. Errors when the line would reach or cross a pole.
pub fn rhumb_direct(
    from: Point,
    course: f64,
    distance_nm: f64,
    parts: MeridionalParts,
) -> Result<Point, SkyfixError> {
    let d = distance_nm * ARCMIN;
    let (sc, cc) = course.sin_cos();
    let dlat = d * cc;
    let lat2 = from.lat + dlat;
    if lat2.abs() >= std::f64::consts::FRAC_PI_2 - 1e-12 {
        return Err(SkyfixError::InvalidField {
            field: "distance_nm".to_string(),
            message: format!(
                "a rhumb line of course {:.1}° reaches the pole after {:.1} NM and cannot be \
                 held beyond it (it spirals into the pole); shorten the run or steer a great \
                 circle",
                norm_2pi(course).to_degrees(),
                ((std::f64::consts::FRAC_PI_2 * dlat.signum() - from.lat) / cc) / ARCMIN
            ),
        });
    }
    if from.lat.abs() >= std::f64::consts::FRAC_PI_2 - 1e-15 {
        // Leaving a pole: only the meridian of the course is defined. Take the course
        // as the longitude of departure, as the textbooks do.
        return Ok(Point::new(lat2, from.lon));
    }
    let q = q_factor(from.lat, lat2, parts);
    let dlo = d * sc / q;
    Ok(Point::new(lat2, from.lon + dlo))
}

/// Mid-latitude sailing between two points (Bowditch §1218).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MidLatitudeSolution {
    pub course: Option<f64>,
    pub distance_nm: f64,
    pub dlat_arcmin: f64,
    pub dlo_arcmin: f64,
    pub departure_nm: f64,
    /// The mean latitude `Lm`, radians.
    pub mean_latitude: f64,
}

/// Course and distance by mid-latitude sailing: `p = DLo cos Lm`, `tan C = p / l`,
/// `D = sqrt(l² + p²)`. `None` when the two points are on opposite sides of the equator
/// (Bowditch solves each side separately, which needs a course per side).
pub fn mid_latitude_inverse(from: Point, to: Point) -> Option<MidLatitudeSolution> {
    if from.lat * to.lat < 0.0 {
        return None;
    }
    let dlat = to.lat - from.lat;
    let dlo = norm_pi(to.lon - from.lon);
    let lm = 0.5 * (from.lat + to.lat);
    let p = dlo * lm.cos();
    let distance = dlat.hypot(p);
    Some(MidLatitudeSolution {
        course: (distance > 0.0).then(|| norm_2pi(p.atan2(dlat))),
        distance_nm: distance * ARCMIN_PER_RAD,
        dlat_arcmin: dlat * ARCMIN_PER_RAD,
        dlo_arcmin: dlo * ARCMIN_PER_RAD,
        departure_nm: p * ARCMIN_PER_RAD,
        mean_latitude: lm,
    })
}

/// Arrival by mid-latitude sailing: `l = D cos C`, `p = D sin C`, `DLo = p sec Lm`. A
/// leg across the equator is solved in two parts, each with its own mean latitude
/// (Bowditch §1218). A negative distance runs the leg backwards (the exact reverse).
pub fn mid_latitude_direct(
    from: Point,
    course: f64,
    distance_nm: f64,
) -> Result<Point, SkyfixError> {
    let d = distance_nm * ARCMIN;
    let (sc, cc) = course.sin_cos();
    let dlat = d * cc;
    let p = d * sc;
    let lat2 = from.lat + dlat;
    if lat2.abs() >= std::f64::consts::FRAC_PI_2 - 1e-12 {
        return Err(SkyfixError::InvalidField {
            field: "distance_nm".to_string(),
            message: "mid-latitude sailing cannot carry a leg to or across a pole; shorten \
                      the run"
                .to_string(),
        });
    }
    let dlo = if from.lat * lat2 < 0.0 {
        // Two parts: to the equator, then beyond it, each with its own mean latitude.
        let f = from.lat.abs() / dlat.abs();
        let p1 = p * f;
        let p2 = p * (1.0 - f);
        p1 / (0.5 * from.lat).cos() + p2 / (0.5 * lat2).cos()
    } else {
        p / (0.5 * (from.lat + lat2)).cos()
    };
    Ok(Point::new(lat2, from.lon + dlo))
}

/// Plane sailing (§1215): the difference of latitude and the departure, nautical miles,
/// of a run of `distance_nm` on `course` (radians).
pub fn plane_sailing(course: f64, distance_nm: f64) -> (f64, f64) {
    let (sc, cc) = course.sin_cos();
    (distance_nm * cc, distance_nm * sc)
}

/// The course and distance made good over a series of courses and distances (traverse
/// sailing, §1216): plane-sailing components summed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Traverse {
    /// Degrees true, `[0, 360)`; `None` when the legs cancel exactly.
    pub course_deg: Option<f64>,
    pub distance_nm: f64,
    /// Total difference of latitude, NM, north positive.
    pub dlat_nm: f64,
    /// Total departure, NM, east positive.
    pub departure_nm: f64,
}

/// Traverse sailing over `(course_deg, distance_nm)` legs.
pub fn traverse(legs: &[(f64, f64)]) -> Traverse {
    let (mut north, mut east) = (0.0, 0.0);
    for &(c, d) in legs {
        let (l, p) = plane_sailing(c.to_radians(), d);
        north += l;
        east += p;
    }
    let distance = north.hypot(east);
    Traverse {
        course_deg: (distance > 0.0)
            .then(|| crate::units::norm_360(east.atan2(north).to_degrees())),
        distance_nm: distance,
        dlat_nm: north,
        departure_nm: east,
    }
}

/// Parallel sailing (§1217): the difference of longitude, minutes, for a departure
/// `p_nm` (east positive) along the parallel `lat` (radians).
pub fn parallel_sailing_dlo_arcmin(lat: f64, p_nm: f64) -> f64 {
    p_nm / lat.cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: f64 = std::f64::consts::PI / 180.0;

    #[test]
    fn meridional_parts_match_bowditch_table_6_on_wgs84() {
        // The four values Bowditch 2019 ch. 12 §1219 takes from Table 6.
        for (lat, printed) in [
            (32.0 + 14.7 / 60.0, 2033.4),
            (36.0 + 58.7 / 60.0, 2377.1),
            (75.0 + 31.7 / 60.0, 7072.4),
            (71.0 + 32.9 / 60.0, 6226.1),
        ] {
            let m = meridional_parts_arcmin(lat * D, MeridionalParts::Wgs84);
            // Table 6 is printed to 0.1' and interpolated by hand; the spheroids the
            // editions used differ from WGS84 by up to 0.25' here.
            assert!((m - printed).abs() < 0.3, "{lat}: {m} vs {printed}");
        }
        // The sphere's are larger by about e^2 sin(phi) * 3437.7'.
        let s = meridional_parts_arcmin(45.0 * D, MeridionalParts::Sphere);
        assert!((s - 3029.94).abs() < 0.01, "{s}");
    }

    #[test]
    fn delta_psi_is_the_difference_of_isometric_latitudes() {
        for parts in [MeridionalParts::Sphere, MeridionalParts::Wgs84] {
            for (a, b) in [
                (10.0, 20.0),
                (-30.0, 45.0),
                (70.0, 89.0),
                (-5.0, -80.0),
                (1e-3, 2e-3),
            ] {
                let direct = isometric_latitude(b * D, parts) - isometric_latitude(a * D, parts);
                let stable = delta_psi(a * D, b * D, parts);
                assert!(
                    (direct - stable).abs() < 1e-12 * (1.0 + direct.abs()),
                    "{a} {b}"
                );
            }
        }
    }

    #[test]
    fn inverse_and_direct_round_trip_on_both_figures() {
        let pts = [
            (32.245, -66.4817, 36.9783, -75.7033),
            (-33.888, 18.385, 40.452, -73.823),
            (10.0, 170.0, 12.0, -170.0),
            (44.605, -31.305, 44.605, -33.095),
            (-60.0, 0.0, -60.0, 1e-9),
            (0.0, 0.0, 0.0, 179.0),
        ];
        for parts in [MeridionalParts::Sphere, MeridionalParts::Wgs84] {
            for (a1, o1, a2, o2) in pts {
                let p = Point::from_deg(a1, o1);
                let q = Point::from_deg(a2, o2);
                let r = rhumb_inverse(p, q, parts);
                let back = rhumb_direct(p, r.course.unwrap(), r.distance_nm, parts).unwrap();
                assert!((back.lat - q.lat).abs() < 1e-12, "{a1} {o1} -> {a2} {o2}");
                assert!(
                    norm_pi(back.lon - q.lon).abs() < 1e-11,
                    "{a1} {o1} -> {a2} {o2}"
                );
                // Backwards along the same line lands on the start again.
                let again = rhumb_direct(q, r.course.unwrap(), -r.distance_nm, parts).unwrap();
                assert!((again.lat - p.lat).abs() < 1e-12);
                assert!(norm_pi(again.lon - p.lon).abs() < 1e-11);
            }
        }
    }

    #[test]
    fn due_east_is_parallel_sailing_on_the_sphere() {
        // Bowditch 2019 ch. 12 §1220: 1530 DR 44°36.3'N 31°18.3'W, 270° at 17 kn to 2000.
        let p = Point::from_deg(44.0 + 36.3 / 60.0, -(31.0 + 18.3 / 60.0));
        let q = rhumb_direct(p, 270.0 * D, 17.0 * 4.5, MeridionalParts::Sphere).unwrap();
        assert!((q.lat - p.lat).abs() < 1e-15);
        let lon_min = -q.lon.to_degrees() * 60.0;
        assert!((lon_min - (33.0 * 60.0 + 5.7)).abs() < 0.05, "{lon_min}");
        let dlo = parallel_sailing_dlo_arcmin(p.lat, 17.0 * 4.5);
        assert!((norm_pi(p.lon - q.lon) / ARCMIN - dlo).abs() < 1e-9);
    }

    #[test]
    fn near_east_west_courses_stay_finite_and_continuous() {
        let p = Point::from_deg(40.0, -70.0);
        let a = rhumb_direct(p, 90.0 * D, 100.0, MeridionalParts::Sphere).unwrap();
        let b = rhumb_direct(p, 90.0 * D + 1e-9, 100.0, MeridionalParts::Sphere).unwrap();
        assert!((a.lon - b.lon).abs() < 1e-9 && (a.lat - b.lat).abs() < 1e-9);
        let r = rhumb_inverse(p, a, MeridionalParts::Sphere);
        assert!((r.distance_nm - 100.0).abs() < 1e-9);
        assert!((r.course.unwrap() - 90.0 * D).abs() < 1e-12);
    }

    #[test]
    fn a_rhumb_line_to_the_pole_is_refused() {
        let p = Point::from_deg(80.0, 0.0);
        let e = rhumb_direct(p, 10.0 * D, 700.0, MeridionalParts::Sphere).unwrap_err();
        assert!(e.to_string().contains("pole"), "{e}");
        let r = rhumb_inverse(p, Point::from_deg(90.0, 0.0), MeridionalParts::Sphere);
        assert_eq!(r.course, Some(0.0));
        assert!((r.distance_nm - 600.0).abs() < 1e-9);
    }

    #[test]
    fn mid_latitude_splits_at_the_equator_and_round_trips() {
        let p = Point::from_deg(2.0, 10.0);
        let q = mid_latitude_direct(p, 160.0 * D, 400.0).unwrap();
        assert!(q.lat < 0.0);
        let back = mid_latitude_direct(q, 160.0 * D, -400.0).unwrap();
        assert!((back.lat - p.lat).abs() < 1e-13 && norm_pi(back.lon - p.lon).abs() < 1e-13);
        assert!(mid_latitude_inverse(p, q).is_none());
        let same_side = mid_latitude_direct(p, 60.0 * D, 400.0).unwrap();
        let r = mid_latitude_inverse(p, same_side).unwrap();
        assert!((r.distance_nm - 400.0).abs() < 1e-9);
        assert!((r.course.unwrap() - 60.0 * D).abs() < 1e-12);
    }

    #[test]
    fn traverse_sums_the_legs() {
        let t = traverse(&[(0.0, 10.0), (90.0, 10.0), (180.0, 10.0)]);
        assert!((t.distance_nm - 10.0).abs() < 1e-12);
        assert!((t.course_deg.unwrap() - 90.0).abs() < 1e-9);
        let none = traverse(&[(45.0, 5.0), (225.0, 5.0)]);
        assert!(none.distance_nm < 1e-12);
    }
}
