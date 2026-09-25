//! Forward dead reckoning and routes. `docs/NAVIGATION_METHODS.md` §9.4 is normative.
//!
//! A navigator steers a compass course, which is a rhumb line, so the default
//! [`DrMethod::Rhumb`] runs every leg as the loxodrome of that course (Mercator
//! sailing, exact on the chosen figure). [`DrMethod::MidLatitude`] is Bowditch's
//! approximation for short legs, and [`DrMethod::GreatCircle`] is the leg model the
//! running fix uses (`docs/MOTION.md` §1: each leg a great-circle segment on its initial
//! course, `skyfix_motion::track::Track::advance`), offered so a DR track drawn here and
//! the track a running fix assumes can be made identical. The two models part by the
//! rhumb line's geodesic curvature `sin C tan φ`: after a leg of `d` NM at latitude `φ`
//! on course `C` the ends are about `d² sin C tan φ / (2 · 3437.7)` NM apart, across the
//! track (249 m after 36 NM on 045° at 45° N; nothing on a meridian).
//!
//! A [`Route`] is a list of legs `{start_utc, course_deg, speed_kn}` — the running fix's
//! own leg shape (`skyfix_motion::request::RunningFixLeg`), so a route's legs can be
//! handed to `running_fix` unchanged — with a start position and instant. It answers
//! "where is the vessel at time t" for any `t`: under way between the start and the end
//! (if one is given), stationary at the start before it and at the last position after
//! the end, and it says which.

use serde::{Deserialize, Serialize};

use crate::SkyfixError;
use crate::geometry::{Point, apply_tangent_step, destination, tangent_offset};
use crate::types::LatLon;
use crate::units::{ARCMIN, nm_to_rad, norm_360};

use super::great_circle::GreatCircle;
use super::rhumb::{MeridionalParts, mid_latitude_direct, rhumb_direct, rhumb_inverse};

/// How a leg of constant course is run.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DrMethod {
    /// The rhumb line (loxodrome) of the course: what steering a compass course does.
    /// Default.
    #[default]
    Rhumb,
    /// Bowditch's mid-latitude sailing: `DLo = D sin C sec Lm`. For short legs.
    MidLatitude,
    /// A great circle on the initial course: the running fix's leg model
    /// (`docs/MOTION.md` §1).
    GreatCircle,
}

impl DrMethod {
    pub fn name(self) -> &'static str {
        match self {
            DrMethod::Rhumb => "rhumb",
            DrMethod::MidLatitude => "mid_latitude",
            DrMethod::GreatCircle => "great_circle",
        }
    }
}

/// Where `distance_nm` on `course` (radians) from `from` ends, by `method`. A negative
/// distance gives the position the vessel was at that far back: for a rhumb line and
/// for mid-latitude sailing that is the reverse run, which is exact; for a great-circle
/// leg it is the point from which the forward leg on this course arrives here (not a
/// reciprocal-bearing walk, which misses by the convergence of the meridians;
/// `docs/MOTION.md` §1).
pub fn dr_advance(
    from: Point,
    course: f64,
    distance_nm: f64,
    method: DrMethod,
    parts: MeridionalParts,
) -> Result<Point, SkyfixError> {
    if !distance_nm.is_finite() || !course.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: "course/distance".to_string(),
        });
    }
    if distance_nm == 0.0 {
        return Ok(from);
    }
    match method {
        DrMethod::Rhumb => rhumb_direct(from, course, distance_nm, parts),
        DrMethod::MidLatitude => mid_latitude_direct(from, course, distance_nm),
        DrMethod::GreatCircle => {
            if distance_nm > 0.0 {
                Ok(destination(from, course, nm_to_rad(distance_nm)))
            } else {
                Ok(great_circle_backward(from, course, -distance_nm))
            }
        }
    }
}

/// The `q` with `destination(q, course, d) == end`: a few fixed-point steps from the
/// reciprocal-bearing guess (the forward walk is nearly an isometry, so the iteration
/// contracts by about 1e-3 per step), exactly as `skyfix_motion::track` inverts a leg.
fn great_circle_backward(end: Point, course: f64, distance_nm: f64) -> Point {
    let d = nm_to_rad(distance_nm);
    let mut q = destination(end, course + std::f64::consts::PI, d);
    for _ in 0..12 {
        let forward = destination(q, course, d);
        let (dn, de) = tangent_offset(forward, end);
        if dn == 0.0 && de == 0.0 {
            break;
        }
        q = apply_tangent_step(q, dn, de);
        if dn.hypot(de) < 1e-15 {
            break;
        }
    }
    q
}

/// One leg of a route: the running fix's leg shape (`RunningFixLeg`). The first leg's
/// `start_utc` may be left out: it then starts at the route's start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteLeg {
    #[serde(default)]
    pub start_utc: Option<String>,
    /// Course over the ground, degrees true.
    pub course_deg: f64,
    /// Speed over the ground, knots.
    pub speed_kn: f64,
}

/// Where the vessel is relative to its route at an instant.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RouteStatus {
    /// Before the route's start: the start position is given, not extrapolated.
    BeforeStart,
    /// Waiting at the start for the first leg's (later) start time.
    Waiting,
    /// On a leg.
    UnderWay,
    /// After the route's end: the end position (the vessel is taken to have stopped).
    AfterEnd,
}

/// The fastest vessel a route accepts, knots (the navigation methods' limit, which
/// admits an aircraft's bubble sextant).
pub const MAX_ROUTE_SPEED_KN: f64 = 1000.0;

/// A resolved leg: its instants, its start position, course and speed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedLeg {
    pub start_jd: f64,
    /// Start of the next leg, or the route's end, or infinity.
    pub end_jd: f64,
    pub from: Point,
    pub course_deg: f64,
    pub speed_kn: f64,
}

/// A dead-reckoning route: legs of constant course and speed from a start position.
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub start: Point,
    pub start_jd: f64,
    pub end_jd: Option<f64>,
    pub method: DrMethod,
    pub parts: MeridionalParts,
    pub legs: Vec<ResolvedLeg>,
}

impl Route {
    /// Build a route, checking the legs: finite values, speeds within
    /// [`MAX_ROUTE_SPEED_KN`], start instants strictly increasing and not before the
    /// route's start, every leg after the first with its own start.
    pub fn new(
        start: LatLon,
        start_utc: &str,
        legs: &[RouteLeg],
        end_utc: Option<&str>,
        method: DrMethod,
        parts: MeridionalParts,
    ) -> Result<Route, SkyfixError> {
        check_position("start", start)?;
        let start_jd = crate::time::parse_utc(start_utc)?;
        let end_jd = end_utc.map(crate::time::parse_utc).transpose()?;
        if let Some(e) = end_jd
            && e < start_jd
        {
            return Err(SkyfixError::InvalidField {
                field: "end_utc".to_string(),
                message: "the route ends before it starts".to_string(),
            });
        }
        if legs.is_empty() {
            return Err(SkyfixError::InvalidField {
                field: "legs".to_string(),
                message: "a route needs at least one leg".to_string(),
            });
        }
        let mut starts = Vec::with_capacity(legs.len());
        for (i, leg) in legs.iter().enumerate() {
            let field = |f: &str| format!("legs[{i}].{f}");
            if !leg.course_deg.is_finite() {
                return Err(SkyfixError::NonFinite {
                    field: field("course_deg"),
                });
            }
            if !leg.speed_kn.is_finite() || leg.speed_kn.abs() > MAX_ROUTE_SPEED_KN {
                return Err(SkyfixError::InvalidField {
                    field: field("speed_kn"),
                    message: format!(
                        "must be finite and at most {MAX_ROUTE_SPEED_KN} kn either way (got {})",
                        leg.speed_kn
                    ),
                });
            }
            let t = match (&leg.start_utc, i) {
                (Some(s), _) => crate::time::parse_utc(s)?,
                (None, 0) => start_jd,
                (None, _) => {
                    return Err(SkyfixError::InvalidField {
                        field: field("start_utc"),
                        message: "every leg after the first needs its start time".to_string(),
                    });
                }
            };
            if t < start_jd {
                return Err(SkyfixError::InvalidField {
                    field: field("start_utc"),
                    message: "a leg cannot start before the route does".to_string(),
                });
            }
            if let Some(&prev) = starts.last()
                && t <= prev
            {
                return Err(SkyfixError::InvalidField {
                    field: field("start_utc"),
                    message: "legs must start in time order, each after the one before".to_string(),
                });
            }
            starts.push(t);
        }
        let mut resolved: Vec<ResolvedLeg> = Vec::with_capacity(legs.len());
        let mut here = Point::from_deg(start.lat_deg, start.lon_deg);
        for (i, leg) in legs.iter().enumerate() {
            let next = starts
                .get(i + 1)
                .copied()
                .unwrap_or(f64::INFINITY)
                .min(end_jd.unwrap_or(f64::INFINITY));
            let r = ResolvedLeg {
                start_jd: starts[i],
                end_jd: next.max(starts[i]),
                from: here,
                course_deg: leg.course_deg,
                speed_kn: leg.speed_kn,
            };
            if r.end_jd.is_finite() {
                here = r.advance(r.end_jd, method, parts)?;
            }
            resolved.push(r);
            if end_jd.is_some_and(|e| next >= e) && i + 1 < legs.len() {
                // Later legs start after the route's end: they never run.
                break;
            }
        }
        Ok(Route {
            start: Point::from_deg(start.lat_deg, start.lon_deg),
            start_jd,
            end_jd,
            method,
            parts,
            legs: resolved,
        })
    }

    /// The position at `jd`, the leg it is on (index) and the status.
    pub fn position_at(&self, jd: f64) -> Result<(Point, Option<usize>, RouteStatus), SkyfixError> {
        if jd < self.start_jd {
            return Ok((self.start, None, RouteStatus::BeforeStart));
        }
        let first = &self.legs[0];
        if jd < first.start_jd {
            return Ok((self.start, None, RouteStatus::Waiting));
        }
        if let Some(e) = self.end_jd
            && jd > e
        {
            let last = self.legs.last().expect("a route has a leg");
            return Ok((
                last.advance(e.min(last.end_jd), self.method, self.parts)?,
                None,
                RouteStatus::AfterEnd,
            ));
        }
        let i = self
            .legs
            .iter()
            .rposition(|l| l.start_jd <= jd)
            .expect("jd is at or after the first leg");
        let leg = &self.legs[i];
        Ok((
            leg.advance(jd.min(leg.end_jd), self.method, self.parts)?,
            Some(i),
            RouteStatus::UnderWay,
        ))
    }

    /// Distance run from the start to `jd`, nautical miles (path length).
    pub fn distance_run_nm(&self, jd: f64) -> f64 {
        self.legs
            .iter()
            .map(|l| {
                let a = l.start_jd;
                let b = l.end_jd.min(jd).min(self.end_jd.unwrap_or(f64::INFINITY));
                if b > a {
                    (b - a) * 24.0 * l.speed_kn.abs()
                } else {
                    0.0
                }
            })
            .sum()
    }
}

impl ResolvedLeg {
    /// Position on this leg at `jd` (clamped to the leg's start).
    pub fn advance(
        &self,
        jd: f64,
        method: DrMethod,
        parts: MeridionalParts,
    ) -> Result<Point, SkyfixError> {
        let hours = ((jd - self.start_jd) * 24.0).max(0.0);
        dr_advance(
            self.from,
            self.course_deg.to_radians(),
            self.speed_kn * hours,
            method,
            parts,
        )
    }

    /// Course and distance of the leg by the rhumb line from its start to its end (the
    /// course made good; for a great-circle leg it differs from the initial course).
    pub fn made_good(
        &self,
        method: DrMethod,
        parts: MeridionalParts,
    ) -> Option<(Option<f64>, f64)> {
        if !self.end_jd.is_finite() {
            return None;
        }
        let end = self.advance(self.end_jd, method, parts).ok()?;
        let r = rhumb_inverse(self.from, end, parts);
        Some((r.course.map(|c| norm_360(c.to_degrees())), r.distance_nm))
    }
}

pub(crate) fn check_position(field: &str, p: LatLon) -> Result<(), SkyfixError> {
    if !p.lat_deg.is_finite() || !p.lon_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: field.to_string(),
        });
    }
    if !(-90.0..=90.0).contains(&p.lat_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: format!("{field}.lat_deg"),
            value: p.lat_deg,
            min: -90.0,
            max: 90.0,
            max_exclusive: false,
        });
    }
    if !(-180.0..=180.0).contains(&p.lon_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: format!("{field}.lon_deg"),
            value: p.lon_deg,
            min: -180.0,
            max: 180.0,
            max_exclusive: false,
        });
    }
    Ok(())
}

/// The great circle a great-circle DR leg follows (for drawing it).
pub fn great_circle_leg(from: Point, course: f64, distance_nm: f64) -> GreatCircle {
    GreatCircle::from_course(from, course, distance_nm * ARCMIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::angular_distance;
    use crate::units::{norm_pi, rad_to_m};

    const D: f64 = std::f64::consts::PI / 180.0;

    #[test]
    fn every_method_runs_backwards_exactly() {
        let p = Point::from_deg(40.0, -70.0);
        for method in [
            DrMethod::Rhumb,
            DrMethod::MidLatitude,
            DrMethod::GreatCircle,
        ] {
            for course in [0.0, 45.0, 135.0, 270.0, 333.0] {
                let q = dr_advance(p, course * D, 120.0, method, MeridionalParts::Sphere).unwrap();
                let back =
                    dr_advance(q, course * D, -120.0, method, MeridionalParts::Sphere).unwrap();
                assert!(
                    rad_to_m(angular_distance(back, p)) < 1e-6,
                    "{method:?} {course}"
                );
            }
        }
    }

    #[test]
    fn the_rhumb_and_great_circle_legs_part_by_the_geodesic_curvature() {
        // d^2 sin C tan(phi) / (2 * 3437.7) NM: the module docs' statement.
        for (lat, course) in [(45.0, 45.0), (60.0, 45.0), (20.0, 70.0), (-50.0, 120.0)] {
            let p = Point::from_deg(lat, -30.0);
            let r = dr_advance(
                p,
                course * D,
                36.0,
                DrMethod::Rhumb,
                MeridionalParts::Sphere,
            )
            .unwrap();
            let g = dr_advance(
                p,
                course * D,
                36.0,
                DrMethod::GreatCircle,
                MeridionalParts::Sphere,
            )
            .unwrap();
            let m = rad_to_m(angular_distance(r, g));
            let predicted = 36.0 * 36.0 * (course * D).sin() * (lat * D).tan().abs()
                / (2.0 * 3437.747)
                * 1852.0;
            assert!(
                (m - predicted).abs() < 0.02 * predicted,
                "{lat} {course}: {m} vs {predicted}"
            );
        }
        let p = Point::from_deg(45.0, -30.0);
        let r = dr_advance(p, 45.0 * D, 36.0, DrMethod::Rhumb, MeridionalParts::Sphere).unwrap();
        let g = dr_advance(
            p,
            45.0 * D,
            36.0,
            DrMethod::GreatCircle,
            MeridionalParts::Sphere,
        )
        .unwrap();
        assert!((rad_to_m(angular_distance(r, g)) - 249.0).abs() < 1.0);
        // Along a meridian the two are the same line.
        let r = dr_advance(p, 0.0, 36.0, DrMethod::Rhumb, MeridionalParts::Sphere).unwrap();
        let g = dr_advance(p, 0.0, 36.0, DrMethod::GreatCircle, MeridionalParts::Sphere).unwrap();
        assert!(rad_to_m(angular_distance(r, g)) < 1e-6);
    }

    fn route(legs: Vec<RouteLeg>, end: Option<&str>, method: DrMethod) -> Route {
        Route::new(
            LatLon {
                lat_deg: 40.0,
                lon_deg: -70.0,
            },
            "2026-10-01T00:00:00Z",
            &legs,
            end,
            method,
            MeridionalParts::Sphere,
        )
        .unwrap()
    }

    fn leg(start: Option<&str>, c: f64, v: f64) -> RouteLeg {
        RouteLeg {
            start_utc: start.map(str::to_string),
            course_deg: c,
            speed_kn: v,
        }
    }

    #[test]
    fn a_route_walks_its_legs_and_says_where_it_is() {
        let r = route(
            vec![
                leg(None, 90.0, 10.0),
                leg(Some("2026-10-01T03:00:00Z"), 180.0, 12.0),
            ],
            Some("2026-10-01T05:00:00Z"),
            DrMethod::Rhumb,
        );
        let jd = |s: &str| crate::time::parse_utc(s).unwrap();
        let (p, i, s) = r.position_at(jd("2026-10-01T03:00:00Z")).unwrap();
        assert_eq!((i, s), (Some(1), RouteStatus::UnderWay));
        assert!((p.lat - 40.0 * D).abs() < 1e-12);
        assert!((norm_pi(p.lon + 70.0 * D) / ARCMIN - 30.0 / (40.0 * D).cos()).abs() < 1e-9);
        let (q, _, s) = r.position_at(jd("2026-10-01T06:00:00Z")).unwrap();
        assert_eq!(s, RouteStatus::AfterEnd);
        // Julian dates resolve about 40 microseconds: 1e-7 NM at these speeds.
        assert!(((40.0 * D - q.lat) / ARCMIN - 24.0).abs() < 1e-6);
        assert_eq!(
            r.position_at(jd("2026-09-30T23:00:00Z")).unwrap().2,
            RouteStatus::BeforeStart
        );
        assert!((r.distance_run_nm(jd("2026-10-01T06:00:00Z")) - 54.0).abs() < 1e-6);
    }

    #[test]
    fn a_great_circle_route_matches_the_running_fix_leg_model() {
        // skyfix-motion's Track::advance: one `destination` step per leg.
        let r = route(
            vec![
                leg(None, 45.0, 10.0),
                leg(Some("2026-10-01T02:00:00Z"), 120.0, 8.0),
            ],
            None,
            DrMethod::GreatCircle,
        );
        let t = crate::time::parse_utc("2026-10-01T04:30:00Z").unwrap();
        let (p, _, _) = r.position_at(t).unwrap();
        let a = destination(Point::from_deg(40.0, -70.0), 45.0 * D, nm_to_rad(20.0));
        let b = destination(a, 120.0 * D, nm_to_rad(20.0));
        // Equal to the Julian date's resolution (40 microseconds of run, 1e-11 rad).
        assert!(angular_distance(p, b) < 1e-10);
    }

    #[test]
    fn bad_routes_are_refused_with_the_field_named() {
        let bad = |legs: Vec<RouteLeg>, end: Option<&str>| {
            Route::new(
                LatLon {
                    lat_deg: 40.0,
                    lon_deg: -70.0,
                },
                "2026-10-01T00:00:00Z",
                &legs,
                end,
                DrMethod::Rhumb,
                MeridionalParts::Sphere,
            )
            .unwrap_err()
            .to_string()
        };
        assert!(bad(vec![], None).contains("at least one leg"));
        assert!(
            bad(vec![leg(None, 0.0, 5.0), leg(None, 90.0, 5.0)], None)
                .contains("legs[1].start_utc")
        );
        assert!(
            bad(vec![leg(Some("2026-09-30T00:00:00Z"), 0.0, 5.0)], None)
                .contains("before the route")
        );
        assert!(bad(vec![leg(None, 0.0, 5e6)], None).contains("speed_kn"));
        assert!(
            bad(vec![leg(None, 0.0, 5.0)], Some("2026-09-01T00:00:00Z")).contains("ends before")
        );
    }
}
