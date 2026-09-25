//! The sailings: great-circle, rhumb-line (Mercator), mid-latitude and composite
//! sailing between two points, forward dead reckoning, and routes of legs that give the
//! position at any time. `docs/NAVIGATION_METHODS.md` §9 is normative; wire shapes are in
//! `docs/EXPLORER_API.md`, "Expansion programme — sailings".
//!
//! Everything is on the sphere of CONVENTIONS section 1 (1′ of arc = 1 NM = 1852 m),
//! except where [`MeridionalParts::Wgs84`] is asked for (see [`rhumb`]). On the WGS84
//! ellipsoid the same distances differ by at most 0.52 % (a minute of latitude is
//! 1842.9 m at the equator and 1861.6 m at the poles; measured against Vincenty's
//! geodesic and the WGS84 loxodrome in `tests/sailings_wgs84.rs`).
//!
//! | module | what |
//! |---|---|
//! | [`great_circle`] | distance, initial and final course, vertices, meridian and equator crossings |
//! | [`rhumb`] | Mercator sailing on the sphere or with WGS84 meridional parts; mid-latitude, parallel, plane and traverse sailing |
//! | [`composite`] | composite sailing with a limiting latitude |
//! | [`dr`] | forward dead reckoning (rhumb, mid-latitude or great circle) and routes |
//!
//! [`passage`] puts them together for one departure and destination: every sailing, the
//! waypoints along the great circle (or the composite track) every N miles or on every
//! M-th meridian, the rhumb-line legs between them, and the times at a speed.

pub mod composite;
pub mod dr;
pub mod great_circle;
pub mod rhumb;

use serde::{Deserialize, Serialize};

use crate::SkyfixError;
use crate::geometry::Point;
use crate::time::{format_utc, parse_utc};
use crate::types::LatLon;
use crate::units::{ARCMIN, norm_360, norm_pi};

pub use composite::{Composite, CompositePiece, composite};
pub use dr::{DrMethod, Route, RouteLeg, RouteStatus, dr_advance};
pub use great_circle::GreatCircle;
pub use rhumb::{MeridionalParts, mid_latitude_inverse, rhumb_inverse, traverse};

/// Kilometres per nautical mile.
pub const KM_PER_NM: f64 = 1.852;
/// The most waypoints one request may ask for.
pub const MAX_WAYPOINTS: usize = 2000;
/// The most positions one route request may ask for.
pub const MAX_ROUTE_POINTS: usize = 20_000;
/// Drawing tracks are sampled at least this often, nautical miles (1° of arc).
pub const TRACK_STEP_NM: f64 = 60.0;
/// The fastest vessel a passage's times accept, knots.
pub const MAX_SPEED_KN: f64 = dr::MAX_ROUTE_SPEED_KN;

fn to_latlon(p: Point) -> LatLon {
    LatLon {
        lat_deg: p.lat_deg(),
        lon_deg: p.lon_deg(),
    }
}

fn to_point(p: LatLon) -> Point {
    Point::from_deg(p.lat_deg, p.lon_deg)
}

fn course_deg(c: f64) -> f64 {
    norm_360(c.to_degrees())
}

// ---------------------------------------------------------------------------
// Wire types: the passage between two points
// ---------------------------------------------------------------------------

/// How to space waypoints along the great circle (or the composite track).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WaypointSpacing {
    /// A waypoint every so many nautical miles from the departure.
    EveryNm(f64),
    /// A waypoint where the track crosses every meridian that is a whole multiple of
    /// this many degrees (Bowditch: "5° of longitude is a convenient length").
    EveryDegLon(f64),
}

/// A passage to plan: `sailing(request_json)`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PassageRequest {
    pub from: LatLon,
    pub to: LatLon,
    #[serde(default)]
    pub waypoints: Option<WaypointSpacing>,
    /// Composite sailing: the track may not pass this parallel (north positive: 47
    /// keeps it south of 47° N, −60 north of 60° S).
    #[serde(default)]
    pub limiting_latitude_deg: Option<f64>,
    #[serde(default)]
    pub meridional_parts: MeridionalParts,
    /// With `departure_utc`, times at every waypoint and the arrival.
    #[serde(default)]
    pub speed_kn: Option<f64>,
    #[serde(default)]
    pub departure_utc: Option<String>,
}

/// A vertex of the great circle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VertexReport {
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// Along the track from the departure, NM; negative when it is behind.
    pub distance_from_start_nm: f64,
    /// Between the departure and the destination.
    pub on_route: bool,
}

/// One waypoint and the rhumb-line leg from it to the next.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Waypoint {
    pub index: usize,
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// Along the great circle (or composite track) from the departure, NM.
    pub distance_from_start_nm: f64,
    /// Direction of the track here, degrees true.
    pub track_course_deg: f64,
    /// The rhumb line to the next waypoint: the course to steer and its length.
    /// `None` at the destination.
    pub leg_course_deg: Option<f64>,
    pub leg_distance_nm: Option<f64>,
    /// Sum of the rhumb-line legs from the departure to here, NM: what the vessel sails.
    pub sailed_nm: f64,
    /// At the request's speed from its departure time, along the rhumb-line legs.
    pub eta_utc: Option<String>,
    pub eta_jd_utc: Option<f64>,
}

/// Arrival at the request's speed: hours under way and the instant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Arrival {
    pub hours: f64,
    pub utc: Option<String>,
    pub jd_utc: Option<f64>,
}

/// Great-circle sailing (Bowditch §1208–1211).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GreatCircleReport {
    pub distance_nm: f64,
    pub distance_km: f64,
    /// Arc, degrees.
    pub distance_deg: f64,
    /// `None` when the two points coincide.
    pub initial_course_deg: Option<f64>,
    pub final_course_deg: Option<f64>,
    /// Bowditch's vertex: the one in the departure's hemisphere (the one ahead for a
    /// departure on the equator). `None` for a track along the equator.
    pub vertex: Option<VertexReport>,
    /// The latitude farthest from the equator anywhere on the route, degrees (signed).
    pub highest_latitude_deg: f64,
    /// Where the route crosses the equator, if it does.
    pub equator_crossing: Option<LatLon>,
    pub waypoints: Vec<Waypoint>,
    /// Sum of the rhumb-line legs between the waypoints, NM (slightly more than the
    /// great circle; equal to it when no waypoints were asked for).
    pub waypoint_route_nm: f64,
    /// Points along the track for drawing, at most [`TRACK_STEP_NM`] apart.
    pub track: Vec<LatLon>,
    pub arrival: Option<Arrival>,
}

/// Rhumb-line (Mercator) sailing (Bowditch §1219).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RhumbReport {
    pub course_deg: Option<f64>,
    pub distance_nm: f64,
    pub distance_km: f64,
    /// Difference of latitude `l`, minutes, north positive.
    pub dlat_arcmin: f64,
    /// Difference of longitude `DLo`, minutes, east positive (the shorter way).
    pub dlo_arcmin: f64,
    /// Departure `p`, NM, east positive.
    pub departure_nm: f64,
    /// Meridional difference `m`, minutes of equatorial arc; `null` when an end is at a
    /// pole.
    pub meridional_difference_arcmin: Option<f64>,
    pub meridional_parts: MeridionalParts,
    pub track: Vec<LatLon>,
    pub arrival: Option<Arrival>,
}

/// Mid-latitude sailing (Bowditch §1218).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MidLatitudeReport {
    pub course_deg: Option<f64>,
    pub distance_nm: f64,
    pub mean_latitude_deg: f64,
    pub dlat_arcmin: f64,
    pub dlo_arcmin: f64,
    pub departure_nm: f64,
    pub arrival: Option<Arrival>,
}

/// One piece of a composite track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositeLegReport {
    /// `"great_circle"` or `"parallel"`.
    pub kind: String,
    pub from: LatLon,
    pub to: LatLon,
    pub distance_nm: f64,
    pub initial_course_deg: Option<f64>,
    pub final_course_deg: Option<f64>,
}

/// Composite sailing (Bowditch §1213).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositeReport {
    pub limiting_latitude_deg: f64,
    /// `false` when the great circle stays within the limit: then the track is the
    /// great circle, and `note` says so.
    pub applies: bool,
    pub distance_nm: f64,
    pub distance_km: f64,
    /// Composite minus great circle, NM: the price of the limit.
    pub extra_distance_nm: f64,
    pub legs: Vec<CompositeLegReport>,
    pub waypoints: Vec<Waypoint>,
    pub waypoint_route_nm: f64,
    pub track: Vec<LatLon>,
    pub arrival: Option<Arrival>,
    pub note: String,
}

/// Every sailing between two points: `sailing(request_json)`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PassageReport {
    pub from: LatLon,
    pub to: LatLon,
    pub great_circle: GreatCircleReport,
    pub rhumb_line: RhumbReport,
    /// `None` across the equator (Bowditch solves each side separately).
    pub mid_latitude: Option<MidLatitudeReport>,
    pub composite: Option<CompositeReport>,
    /// Rhumb line minus great circle, NM: what the great circle saves.
    pub great_circle_saving_nm: f64,
    pub speed_kn: Option<f64>,
    pub departure_utc: Option<String>,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// The passage
// ---------------------------------------------------------------------------

/// The request's speed and departure instant, checked.
fn timing(req: &PassageRequest) -> Result<(Option<f64>, Option<f64>), SkyfixError> {
    let speed = match req.speed_kn {
        Some(v) if !(v.is_finite() && v > 0.0 && v <= MAX_SPEED_KN) => {
            return Err(SkyfixError::InvalidField {
                field: "speed_kn".to_string(),
                message: format!("must be a speed above 0 and at most {MAX_SPEED_KN} kn (got {v})"),
            });
        }
        v => v,
    };
    let departure = req.departure_utc.as_deref().map(parse_utc).transpose()?;
    Ok((speed, departure))
}

fn arrival(distance_nm: f64, speed: Option<f64>, departure: Option<f64>) -> Option<Arrival> {
    let v = speed?;
    let hours = distance_nm / v;
    let jd = departure.map(|t| t + hours / 24.0);
    Some(Arrival {
        hours,
        utc: jd.map(format_utc),
        jd_utc: jd,
    })
}

/// A path made of pieces, with the distance along it.
struct Path<'a> {
    pieces: &'a [CompositePiece],
}

impl Path<'_> {
    fn total_nm(&self) -> f64 {
        self.pieces.iter().map(CompositePiece::distance_nm).sum()
    }

    /// Point and track course `nm` from the start.
    fn at(&self, nm: f64) -> (Point, f64) {
        let mut left = nm;
        for (i, piece) in self.pieces.iter().enumerate() {
            let len = piece.distance_nm();
            if left <= len || i + 1 == self.pieces.len() {
                let s = left.min(len);
                return (piece.point_at_nm(s), piece.course_at_nm(s));
            }
            left -= len;
        }
        (self.pieces[0].start(), 0.0)
    }

    fn longitude_change(&self) -> f64 {
        self.pieces
            .iter()
            .map(|p| match p {
                CompositePiece::GreatCircle(gc) => gc.longitude_change(),
                CompositePiece::Parallel { dlo, .. } => *dlo,
            })
            .sum()
    }

    /// Distances along the path at which it crosses meridians that are whole multiples
    /// of `step` (radians), strictly between the ends.
    fn meridian_stations(&self, step: f64) -> Vec<f64> {
        let start = self.pieces[0].start().lon;
        let change = self.longitude_change();
        if change.abs() < 1e-12 {
            return Vec::new();
        }
        let dir = change.signum();
        let first = if dir > 0.0 {
            (start / step).floor() + 1.0
        } else {
            (start / step).ceil() - 1.0
        };
        let mut out = Vec::new();
        let mut k = first;
        loop {
            let lon = k * step;
            if dir * (lon - (start + change)) >= -1e-12 {
                break;
            }
            // Find the piece that crosses this meridian.
            let mut offset = 0.0;
            for piece in self.pieces {
                if let Some(s) = piece.meridian_crossing_nm(norm_pi(lon)) {
                    out.push(offset + s);
                    break;
                }
                offset += piece.distance_nm();
            }
            k += dir;
            if out.len() > MAX_WAYPOINTS {
                break;
            }
        }
        out.sort_by(f64::total_cmp);
        out.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        out
    }

    fn track(&self) -> Vec<LatLon> {
        let total = self.total_nm();
        let n = ((total / TRACK_STEP_NM).ceil() as usize).max(1);
        (0..=n)
            .map(|k| to_latlon(self.at(total * k as f64 / n as f64).0))
            .collect()
    }

    fn waypoints(
        &self,
        spacing: Option<WaypointSpacing>,
        parts: MeridionalParts,
        speed: Option<f64>,
        departure: Option<f64>,
    ) -> Result<(Vec<Waypoint>, f64), SkyfixError> {
        let total = self.total_nm();
        let Some(spacing) = spacing else {
            return Ok((Vec::new(), total));
        };
        let mut stations: Vec<f64> = match spacing {
            WaypointSpacing::EveryNm(n) => {
                if !(n.is_finite() && n > 0.0) {
                    return Err(SkyfixError::InvalidField {
                        field: "waypoints.every_nm".to_string(),
                        message: format!("must be a positive distance (got {n})"),
                    });
                }
                let count = (total / n).ceil();
                if count > MAX_WAYPOINTS as f64 {
                    return Err(too_many(count));
                }
                (1..count as usize)
                    .map(|k| k as f64 * n)
                    .filter(|s| *s < total - 1e-9)
                    .collect()
            }
            WaypointSpacing::EveryDegLon(m) => {
                if !(m.is_finite() && m > 0.0 && m <= 180.0) {
                    return Err(SkyfixError::InvalidField {
                        field: "waypoints.every_deg_lon".to_string(),
                        message: format!("must be between 0 and 180 degrees (got {m})"),
                    });
                }
                if self.longitude_change().abs() / m.to_radians() > MAX_WAYPOINTS as f64 {
                    return Err(too_many(self.longitude_change().abs() / m.to_radians()));
                }
                self.meridian_stations(m.to_radians())
            }
        };
        stations.insert(0, 0.0);
        stations.push(total);
        let points: Vec<(Point, f64)> = stations.iter().map(|&s| self.at(s)).collect();
        let mut out = Vec::with_capacity(stations.len());
        let mut sailed = 0.0;
        for (i, (&s, &(p, c))) in stations.iter().zip(&points).enumerate() {
            let leg = points
                .get(i + 1)
                .map(|&(q, _)| rhumb::rhumb_inverse(p, q, parts));
            let eta = speed.zip(departure).map(|(v, t)| t + sailed / v / 24.0);
            out.push(Waypoint {
                index: i,
                lat_deg: p.lat_deg(),
                lon_deg: p.lon_deg(),
                distance_from_start_nm: s,
                track_course_deg: course_deg(c),
                leg_course_deg: leg.and_then(|l| l.course.map(course_deg)),
                leg_distance_nm: leg.map(|l| l.distance_nm),
                sailed_nm: sailed,
                eta_utc: eta.map(format_utc),
                eta_jd_utc: eta,
            });
            sailed += leg.map_or(0.0, |l| l.distance_nm);
        }
        Ok((out, sailed))
    }
}

fn too_many(count: f64) -> SkyfixError {
    SkyfixError::InvalidField {
        field: "waypoints".to_string(),
        message: format!(
            "that spacing gives {count:.0} waypoints; at most {MAX_WAYPOINTS} are offered — \
             choose a wider spacing"
        ),
    }
}

/// Every sailing from `req.from` to `req.to` (docs/NAVIGATION_METHODS.md §9).
pub fn passage(req: &PassageRequest) -> Result<PassageReport, SkyfixError> {
    dr::check_position("from", req.from)?;
    dr::check_position("to", req.to)?;
    let (speed, departure) = timing(req)?;
    let from = to_point(req.from);
    let to = to_point(req.to);
    let parts = req.meridional_parts;

    // --- great circle ---------------------------------------------------------
    let gc = GreatCircle::new(from, to)?;
    let gc_pieces = [CompositePiece::GreatCircle(gc)];
    let gc_path = Path { pieces: &gc_pieces };
    let (gc_waypoints, gc_sailed) = gc_path.waypoints(req.waypoints, parts, speed, departure)?;
    let vertex = gc.vertex().map(|v| VertexReport {
        lat_deg: v.point.lat_deg(),
        lon_deg: v.point.lon_deg(),
        distance_from_start_nm: v.arc_from_start / ARCMIN,
        on_route: v.arc_from_start > 0.0 && v.arc_from_start < gc.distance_rad(),
    });
    let highest = {
        let mut best = if from.lat.abs() >= to.lat.abs() {
            from.lat
        } else {
            to.lat
        };
        if let Some((n, s)) = gc.vertices() {
            for v in [n, s] {
                if v.arc_from_start > 0.0
                    && v.arc_from_start < gc.distance_rad()
                    && v.point.lat.abs() > best.abs()
                {
                    best = v.point.lat;
                }
            }
        }
        best.to_degrees()
    };
    let great_circle = GreatCircleReport {
        distance_nm: gc.distance_nm(),
        distance_km: gc.distance_nm() * KM_PER_NM,
        distance_deg: gc.distance_rad().to_degrees(),
        initial_course_deg: (!gc.is_null()).then(|| course_deg(gc.initial_course())),
        final_course_deg: (!gc.is_null()).then(|| course_deg(gc.final_course())),
        vertex,
        highest_latitude_deg: highest,
        equator_crossing: gc.equator_crossing().map(|s| to_latlon(gc.point_at(s))),
        waypoint_route_nm: gc_sailed,
        waypoints: gc_waypoints,
        track: gc_path.track(),
        arrival: arrival(gc_sailed, speed, departure),
    };

    // --- rhumb line -----------------------------------------------------------
    let r = rhumb::rhumb_inverse(from, to, parts);
    let rhumb_track = {
        let n = ((r.distance_nm / TRACK_STEP_NM).ceil() as usize).max(1);
        match r.course {
            Some(c) => (0..=n)
                .map(|k| {
                    rhumb::rhumb_direct(from, c, r.distance_nm * k as f64 / n as f64, parts)
                        .map(to_latlon)
                        .unwrap_or_else(|_| req.to)
                })
                .collect(),
            None => vec![req.from, req.to],
        }
    };
    let rhumb_line = RhumbReport {
        course_deg: r.course.map(course_deg),
        distance_nm: r.distance_nm,
        distance_km: r.distance_nm * KM_PER_NM,
        dlat_arcmin: r.dlat_arcmin,
        dlo_arcmin: r.dlo_arcmin,
        departure_nm: r.departure_nm,
        meridional_difference_arcmin: r
            .meridional_difference_arcmin
            .is_finite()
            .then_some(r.meridional_difference_arcmin),
        meridional_parts: parts,
        track: rhumb_track,
        arrival: arrival(r.distance_nm, speed, departure),
    };

    // --- mid-latitude -----------------------------------------------------------
    let mid_latitude = rhumb::mid_latitude_inverse(from, to).map(|m| MidLatitudeReport {
        course_deg: m.course.map(course_deg),
        distance_nm: m.distance_nm,
        mean_latitude_deg: m.mean_latitude.to_degrees(),
        dlat_arcmin: m.dlat_arcmin,
        dlo_arcmin: m.dlo_arcmin,
        departure_nm: m.departure_nm,
        arrival: arrival(m.distance_nm, speed, departure),
    });

    // --- composite ----------------------------------------------------------------
    let composite = match req.limiting_latitude_deg {
        None => None,
        Some(limit_deg) => {
            let c = composite::composite(from, to, limit_deg.to_radians())?;
            let path = Path { pieces: &c.pieces };
            let (waypoints, sailed) = path.waypoints(req.waypoints, parts, speed, departure)?;
            let legs = c
                .pieces
                .iter()
                .map(|p| match p {
                    CompositePiece::GreatCircle(g) => CompositeLegReport {
                        kind: "great_circle".to_string(),
                        from: to_latlon(g.from),
                        to: to_latlon(g.to),
                        distance_nm: g.distance_nm(),
                        initial_course_deg: (!g.is_null()).then(|| course_deg(g.initial_course())),
                        final_course_deg: (!g.is_null()).then(|| course_deg(g.final_course())),
                    },
                    CompositePiece::Parallel { .. } => CompositeLegReport {
                        kind: "parallel".to_string(),
                        from: to_latlon(p.start()),
                        to: to_latlon(p.end()),
                        distance_nm: p.distance_nm(),
                        initial_course_deg: Some(course_deg(p.course_at_nm(0.0))),
                        final_course_deg: Some(course_deg(p.course_at_nm(0.0))),
                    },
                })
                .collect();
            let distance = c.distance_nm();
            Some(CompositeReport {
                limiting_latitude_deg: limit_deg,
                applies: c.applies,
                distance_nm: distance,
                distance_km: distance * KM_PER_NM,
                extra_distance_nm: distance - gc.distance_nm(),
                legs,
                waypoint_route_nm: sailed,
                waypoints,
                track: path.track(),
                arrival: arrival(sailed, speed, departure),
                note: c.note,
            })
        }
    };

    let mut notes = vec![
        "Distances are on the sphere of 1′ = 1 NM. On the WGS84 ellipsoid the same legs \
         differ by at most 0.52 % (a minute of latitude is 1842.9 m at the equator and 1861.6 m \
         at the poles)."
            .to_string(),
    ];
    if parts == MeridionalParts::Wgs84 {
        notes.push(
            "Rhumb-line courses use WGS84 meridional parts, as a Mercator chart and Bowditch's \
             Table 6; its distance is Bowditch's D = l sec C, 1′ of latitude = 1 NM."
                .to_string(),
        );
    }
    if speed.is_some() && departure.is_none() {
        notes.push(
            "A speed without a departure time gives hours under way, not arrival times."
                .to_string(),
        );
    }
    if great_circle.waypoints.len() > 2 {
        notes.push(format!(
            "Steering the rhumb lines between the waypoints sails {:.1} NM, {:.1} NM more than \
             the great circle itself.",
            gc_sailed,
            gc_sailed - gc.distance_nm()
        ));
    }
    Ok(PassageReport {
        from: to_latlon(from),
        to: to_latlon(to),
        great_circle_saving_nm: r.distance_nm - gc.distance_nm(),
        great_circle,
        rhumb_line,
        mid_latitude,
        composite,
        speed_kn: speed,
        departure_utc: departure.map(format_utc),
        notes,
    })
}

// ---------------------------------------------------------------------------
// Dead reckoning: one leg
// ---------------------------------------------------------------------------

/// Forward dead reckoning: `dr_advance(request_json)`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DrRequest {
    pub from: LatLon,
    /// Course over the ground, degrees true.
    pub course_deg: f64,
    /// Speed over the ground, knots.
    pub speed_kn: f64,
    /// Hours run; negative: where the vessel was that long before.
    pub hours: f64,
    #[serde(default)]
    pub method: DrMethod,
    #[serde(default)]
    pub meridional_parts: MeridionalParts,
    /// The instant at `from`, RFC 3339 UTC; gives the arrival time.
    #[serde(default)]
    pub start_utc: Option<String>,
}

/// Where the run ends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DrReport {
    pub from: LatLon,
    pub to: LatLon,
    pub course_deg: f64,
    pub speed_kn: f64,
    pub hours: f64,
    /// `speed × hours`, NM (negative for a run backwards).
    pub distance_nm: f64,
    pub method: DrMethod,
    pub meridional_parts: MeridionalParts,
    /// The direction of travel on arrival: the course itself on a rhumb line or by
    /// mid-latitude sailing; on a great circle it turns as the meridians converge.
    pub final_course_deg: f64,
    pub arrival_utc: Option<String>,
    pub arrival_jd_utc: Option<f64>,
}

/// One leg of dead reckoning (docs/NAVIGATION_METHODS.md §9.4).
pub fn dead_reckoning(req: &DrRequest) -> Result<DrReport, SkyfixError> {
    dr::check_position("from", req.from)?;
    for (name, v) in [
        ("course_deg", req.course_deg),
        ("speed_kn", req.speed_kn),
        ("hours", req.hours),
    ] {
        if !v.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: name.to_string(),
            });
        }
    }
    if req.speed_kn.abs() > MAX_SPEED_KN {
        return Err(SkyfixError::InvalidField {
            field: "speed_kn".to_string(),
            message: format!(
                "at most {MAX_SPEED_KN} kn either way (got {})",
                req.speed_kn
            ),
        });
    }
    let from = to_point(req.from);
    let course = req.course_deg.to_radians();
    let distance = req.speed_kn * req.hours;
    let to = dr_advance(from, course, distance, req.method, req.meridional_parts)?;
    let final_course = match req.method {
        DrMethod::GreatCircle if distance > 0.0 => {
            GreatCircle::from_course(from, course, distance * ARCMIN).final_course()
        }
        DrMethod::GreatCircle if distance < 0.0 => {
            // The leg ran from `to` to `from` on `course` at `to`; arriving at `from`.
            GreatCircle::from_course(to, course, -distance * ARCMIN).final_course()
        }
        _ => course,
    };
    let start = req.start_utc.as_deref().map(parse_utc).transpose()?;
    let arrival = start.map(|t| t + req.hours / 24.0);
    Ok(DrReport {
        from: to_latlon(from),
        to: to_latlon(to),
        course_deg: norm_360(req.course_deg),
        speed_kn: req.speed_kn,
        hours: req.hours,
        distance_nm: distance,
        method: req.method,
        meridional_parts: req.meridional_parts,
        final_course_deg: course_deg(final_course),
        arrival_utc: arrival.map(format_utc),
        arrival_jd_utc: arrival,
    })
}

// ---------------------------------------------------------------------------
// Routes: the position at any time
// ---------------------------------------------------------------------------

/// A route and the instants to report: `route_positions(request_json)`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteRequest {
    pub start: LatLon,
    /// The instant the vessel is at `start`, RFC 3339 UTC.
    pub start_utc: String,
    /// The running fix's leg shape: `{start_utc, course_deg, speed_kn}`.
    pub legs: Vec<RouteLeg>,
    /// When the vessel stops; after it the position stays put.
    #[serde(default)]
    pub end_utc: Option<String>,
    #[serde(default)]
    pub method: DrMethod,
    #[serde(default)]
    pub meridional_parts: MeridionalParts,
    /// Report the position at each of these instants.
    #[serde(default)]
    pub times_utc: Vec<String>,
    /// And every so many minutes from the start to the end (needs `end_utc`).
    #[serde(default)]
    pub step_minutes: Option<f64>,
}

/// One reported position.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutePoint {
    pub utc: String,
    pub jd_utc: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// The leg the vessel is on (0-based), `None` when not under way.
    pub leg: Option<usize>,
    pub status: RouteStatus,
    /// Path length from the start, NM.
    pub distance_run_nm: f64,
}

/// One leg as run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteLegReport {
    pub index: usize,
    pub start_utc: String,
    pub start_jd_utc: f64,
    /// `None` for a last leg with no route end.
    pub end_utc: Option<String>,
    pub end_jd_utc: Option<f64>,
    pub from: LatLon,
    pub to: Option<LatLon>,
    pub course_deg: f64,
    pub speed_kn: f64,
    pub distance_nm: Option<f64>,
}

/// Course and distance made good from the start to the last reported instant (the
/// rhumb line joining them).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MadeGood {
    pub course_deg: Option<f64>,
    pub distance_nm: f64,
    pub hours: f64,
    /// Distance made good over the hours: the speed made good, knots.
    pub speed_kn: Option<f64>,
}

/// Positions along a route.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteReport {
    pub method: DrMethod,
    pub meridional_parts: MeridionalParts,
    pub legs: Vec<RouteLegReport>,
    pub points: Vec<RoutePoint>,
    /// From the start to the latest reported point.
    pub made_good: Option<MadeGood>,
    pub notes: Vec<String>,
}

/// Positions along a route at the requested instants (docs/NAVIGATION_METHODS.md §9.5).
pub fn route_positions(req: &RouteRequest) -> Result<RouteReport, SkyfixError> {
    let route = Route::new(
        req.start,
        &req.start_utc,
        &req.legs,
        req.end_utc.as_deref(),
        req.method,
        req.meridional_parts,
    )?;
    let mut instants: Vec<f64> = req
        .times_utc
        .iter()
        .map(|s| parse_utc(s))
        .collect::<Result<_, _>>()?;
    if let Some(step) = req.step_minutes {
        if !(step.is_finite() && step > 0.0) {
            return Err(SkyfixError::InvalidField {
                field: "step_minutes".to_string(),
                message: format!("must be a positive number of minutes (got {step})"),
            });
        }
        let Some(end) = route.end_jd else {
            return Err(SkyfixError::InvalidField {
                field: "step_minutes".to_string(),
                message: "stepping along a route needs its end_utc".to_string(),
            });
        };
        let n = ((end - route.start_jd) * 1440.0 / step).floor();
        if n + instants.len() as f64 > MAX_ROUTE_POINTS as f64 {
            return Err(SkyfixError::InvalidField {
                field: "step_minutes".to_string(),
                message: format!(
                    "that step gives {n:.0} positions; at most {MAX_ROUTE_POINTS} are offered"
                ),
            });
        }
        for k in 0..=(n as usize) {
            instants.push(route.start_jd + k as f64 * step / 1440.0);
        }
        if instants.last().is_some_and(|&t| end - t > 1e-9) {
            instants.push(end);
        }
    }
    if instants.len() > MAX_ROUTE_POINTS {
        return Err(SkyfixError::InvalidField {
            field: "times_utc".to_string(),
            message: format!("at most {MAX_ROUTE_POINTS} instants"),
        });
    }
    instants.sort_by(f64::total_cmp);
    let mut points = Vec::with_capacity(instants.len());
    for &t in &instants {
        let (p, leg, status) = route.position_at(t)?;
        points.push(RoutePoint {
            utc: format_utc(t),
            jd_utc: t,
            lat_deg: p.lat_deg(),
            lon_deg: p.lon_deg(),
            leg,
            status,
            distance_run_nm: route.distance_run_nm(t),
        });
    }
    let legs = route
        .legs
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let end = l.end_jd.is_finite().then_some(l.end_jd);
            let to = end
                .map(|e| l.advance(e, route.method, route.parts))
                .transpose()?;
            Ok(RouteLegReport {
                index: i,
                start_utc: format_utc(l.start_jd),
                start_jd_utc: l.start_jd,
                end_utc: end.map(format_utc),
                end_jd_utc: end,
                from: to_latlon(l.from),
                to: to.map(to_latlon),
                course_deg: norm_360(l.course_deg),
                speed_kn: l.speed_kn,
                distance_nm: end.map(|e| (e - l.start_jd) * 24.0 * l.speed_kn.abs()),
            })
        })
        .collect::<Result<Vec<_>, SkyfixError>>()?;
    let made_good = points.last().map(|last| {
        let end = Point::from_deg(last.lat_deg, last.lon_deg);
        let r = rhumb::rhumb_inverse(route.start, end, route.parts);
        let hours = (last.jd_utc - route.start_jd) * 24.0;
        MadeGood {
            course_deg: r.course.map(course_deg),
            distance_nm: r.distance_nm,
            hours,
            speed_kn: (hours > 0.0).then(|| r.distance_nm / hours),
        }
    });
    let mut notes = Vec::new();
    if points.iter().any(|p| p.status == RouteStatus::BeforeStart) {
        notes.push(
            "Some instants are before the route's start: the start position is reported for \
             them, not a position extrapolated backwards."
                .to_string(),
        );
    }
    if points.iter().any(|p| p.status == RouteStatus::AfterEnd) {
        notes.push(
            "Some instants are after the route's end: the vessel is taken to have stopped there."
                .to_string(),
        );
    }
    if route.method == DrMethod::GreatCircle {
        notes.push(
            "Each leg is a great circle on its initial course: the running fix's leg model \
             (docs/MOTION.md section 1). A compass course held is a rhumb line."
                .to_string(),
        );
    }
    Ok(RouteReport {
        method: route.method,
        meridional_parts: route.parts,
        legs,
        points,
        made_good,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ll(lat_deg: f64, lon_deg: f64) -> LatLon {
        LatLon { lat_deg, lon_deg }
    }

    fn request(from: LatLon, to: LatLon) -> PassageRequest {
        PassageRequest {
            from,
            to,
            waypoints: None,
            limiting_latitude_deg: None,
            meridional_parts: MeridionalParts::Sphere,
            speed_kn: None,
            departure_utc: None,
        }
    }

    #[test]
    fn a_passage_carries_every_sailing() {
        let mut req = request(ll(36.9617, -75.7033), ll(45.6517, -1.4967));
        req.waypoints = Some(WaypointSpacing::EveryDegLon(5.0));
        req.limiting_latitude_deg = Some(47.0);
        req.speed_kn = Some(12.0);
        req.departure_utc = Some("2026-10-01T00:00:00Z".to_string());
        let r = passage(&req).unwrap();
        assert!(r.great_circle_saving_nm > 0.0);
        let gc = &r.great_circle;
        // Every whole 5-degree meridian between 75.7 W and 1.5 W: 75, 70, ..., 5 W.
        assert_eq!(gc.waypoints.len(), 15 + 2);
        for w in &gc.waypoints[1..gc.waypoints.len() - 1] {
            assert!(
                (w.lon_deg / 5.0 - (w.lon_deg / 5.0).round()).abs() < 1e-9,
                "{}",
                w.lon_deg
            );
        }
        // Distances increase; the rhumb legs add up to the sailed distance.
        for w in gc.waypoints.windows(2) {
            assert!(w[1].distance_from_start_nm > w[0].distance_from_start_nm);
            assert!((w[0].sailed_nm + w[0].leg_distance_nm.unwrap() - w[1].sailed_nm).abs() < 1e-9);
        }
        assert!(gc.waypoint_route_nm > gc.distance_nm);
        assert!(gc.waypoint_route_nm - gc.distance_nm < 10.0);
        let c = r.composite.as_ref().unwrap();
        assert!(c.applies);
        assert_eq!(c.legs.len(), 3);
        assert!(c.extra_distance_nm > 0.0);
        let arrival = gc.arrival.as_ref().unwrap();
        assert!((arrival.hours - gc.waypoint_route_nm / 12.0).abs() < 1e-9);
        assert!(r.mid_latitude.is_some());
    }

    #[test]
    fn waypoints_every_n_miles_and_bad_spacings() {
        let mut req = request(ll(40.0, -70.0), ll(50.0, -5.0));
        req.waypoints = Some(WaypointSpacing::EveryNm(250.0));
        let r = passage(&req).unwrap();
        let gc = &r.great_circle;
        let n = (gc.distance_nm / 250.0).ceil() as usize;
        assert_eq!(gc.waypoints.len(), n + 1);
        assert!((gc.waypoints[1].distance_from_start_nm - 250.0).abs() < 1e-9);
        req.waypoints = Some(WaypointSpacing::EveryNm(0.0));
        assert!(passage(&req).is_err());
        req.waypoints = Some(WaypointSpacing::EveryNm(0.001));
        assert!(passage(&req).unwrap_err().to_string().contains("at most"));
    }

    #[test]
    fn the_request_shape_parses_with_defaults() {
        let json = r#"{"from": {"lat_deg": 1, "lon_deg": 2}, "to": {"lat_deg": 3, "lon_deg": 4},
                       "waypoints": {"every_nm": 50}}"#;
        let req: PassageRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.waypoints, Some(WaypointSpacing::EveryNm(50.0)));
        assert_eq!(req.meridional_parts, MeridionalParts::Sphere);
        let dr: DrRequest =
            serde_json::from_str(r#"{"from": {"lat_deg": 1, "lon_deg": 2}, "course_deg": 90, "speed_kn": 6, "hours": 2}"#)
                .unwrap();
        assert_eq!(dr.method, DrMethod::Rhumb);
    }

    #[test]
    fn dead_reckoning_reports_the_arrival() {
        let r = dead_reckoning(&DrRequest {
            from: ll(44.0 + 36.3 / 60.0, -(31.0 + 18.3 / 60.0)),
            course_deg: 270.0,
            speed_kn: 17.0,
            hours: 4.5,
            method: DrMethod::Rhumb,
            meridional_parts: MeridionalParts::Sphere,
            start_utc: Some("2026-10-01T15:30:00Z".to_string()),
        })
        .unwrap();
        assert!((r.distance_nm - 76.5).abs() < 1e-12);
        assert_eq!(r.arrival_utc.as_deref(), Some("2026-10-01T20:00:00.000Z"));
        assert!(((-r.to.lon_deg) * 60.0 - (33.0 * 60.0 + 5.7)).abs() < 0.05);
        assert_eq!(r.final_course_deg, 270.0);
    }

    #[test]
    fn a_route_reports_positions_and_made_good() {
        let req = RouteRequest {
            start: ll(40.0, -70.0),
            start_utc: "2026-10-01T00:00:00Z".to_string(),
            legs: vec![
                RouteLeg {
                    start_utc: None,
                    course_deg: 90.0,
                    speed_kn: 10.0,
                },
                RouteLeg {
                    start_utc: Some("2026-10-01T03:00:00Z".to_string()),
                    course_deg: 0.0,
                    speed_kn: 10.0,
                },
            ],
            end_utc: Some("2026-10-01T06:00:00Z".to_string()),
            method: DrMethod::Rhumb,
            meridional_parts: MeridionalParts::Sphere,
            times_utc: vec!["2026-10-01T07:00:00Z".to_string()],
            step_minutes: Some(60.0),
        };
        let r = route_positions(&req).unwrap();
        assert_eq!(r.points.len(), 8);
        assert_eq!(r.points.last().unwrap().status, RouteStatus::AfterEnd);
        assert!((r.points[6].distance_run_nm - 60.0).abs() < 1e-6);
        let mg = r.made_good.unwrap();
        assert!((mg.hours - 7.0).abs() < 1e-6);
        assert!((mg.course_deg.unwrap() - 45.0).abs() < 0.5);
        assert_eq!(r.legs.len(), 2);
        assert!((r.legs[1].distance_nm.unwrap() - 30.0).abs() < 1e-9);
    }
}
