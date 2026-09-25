//! Passage planning and sight extras: `sailing`, `dr-advance`, `route-positions`,
//! `star-id` and `star-finder`. OWNER: cli3 agent.
//!
//! Engines: `skyfix_core::sailings` and `skyfix_core::methods::{starid, starfinder}`,
//! through the WASM adapter's `skyfix_wasm::sailings` (`sailing_impl`,
//! `dr_advance_impl`, `route_positions_impl`, `star_identify_impl`,
//! `star_finder_geometry_impl`: the same candidates and star-finder assembly the site
//! uses); wire format EXPLORER_API.md "Expansion programme — sailings, dead reckoning,
//! star identification, star finder"; methods docs/NAVIGATION_METHODS.md sections 9-11.

use anyhow::{Result, bail};
use skyfix_core::methods::starfinder::Side;
use skyfix_core::methods::starid::{BearingKind, CandidateKind, StarIdRequest, StarIdResult};
use skyfix_core::sailings::{
    Arrival, DrMethod, DrReport, DrRequest, MeridionalParts, PassageReport, PassageRequest,
    RouteLeg, RouteReport, RouteRequest, RouteStatus, Waypoint, WaypointSpacing,
};
use skyfix_core::types::{AltitudeKind, LatLon};
use skyfix_motion::request::RunningFixLeg;
use skyfix_wasm::sailings::{self as wasm_sailings, StarFinderGeometry};

use super::args::{
    FormatArgs, PositionArgs, SightOpticsArgs, parse_instant, parse_lat, parse_leg, wire_instant,
};
use super::text;
use super::wire::{Align, Table, call, emit_json, push_field, push_note};
use crate::cli::parse_latlon;
use crate::commands::reduce::{step_header, step_row};
use crate::exit;
use crate::report;

/// `--meridional-parts` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum PartsArg {
    /// The sphere of 1' = 1 NM (default).
    #[default]
    Sphere,
    /// The WGS84 ellipsoid, as a Mercator chart and Bowditch's Table 6.
    Wgs84,
}

impl From<PartsArg> for MeridionalParts {
    fn from(p: PartsArg) -> Self {
        match p {
            PartsArg::Sphere => MeridionalParts::Sphere,
            PartsArg::Wgs84 => MeridionalParts::Wgs84,
        }
    }
}

/// `--method` values of dead reckoning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum DrMethodArg {
    /// The rhumb line of the course: what steering a compass course does (default).
    #[default]
    Rhumb,
    /// Mid-latitude sailing, for short legs.
    MidLatitude,
    /// A great circle on the initial course: the running fix's leg model.
    GreatCircle,
}

impl From<DrMethodArg> for DrMethod {
    fn from(m: DrMethodArg) -> Self {
        match m {
            DrMethodArg::Rhumb => DrMethod::Rhumb,
            DrMethodArg::MidLatitude => DrMethod::MidLatitude,
            DrMethodArg::GreatCircle => DrMethod::GreatCircle,
        }
    }
}

fn pos(p: LatLon) -> String {
    format!(
        "{} ({})",
        report::format_position(p),
        report::format_position_decimal(p)
    )
}

fn opt_course(c: Option<f64>) -> String {
    c.map_or_else(|| "-".to_string(), |v| format!("{v:.1}"))
}

fn arrival_words(a: &Option<Arrival>) -> String {
    match a {
        Some(a) => match a.jd_utc {
            Some(jd) => format!("{:.1} h, arriving {}", a.hours, text::utc(jd)),
            None => format!("{:.1} h", a.hours),
        },
        None => "-".to_string(),
    }
}

// ---------------------------------------------------------------------------
// sailing
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct SailingArgs {
    /// Departure, LAT,LON in degrees (east-positive longitude).
    #[arg(long, value_name = "LAT,LON", value_parser = parse_latlon, allow_hyphen_values = true)]
    pub from: LatLon,
    /// Destination, LAT,LON.
    #[arg(long, value_name = "LAT,LON", value_parser = parse_latlon, allow_hyphen_values = true)]
    pub to: LatLon,
    /// A waypoint every N nautical miles along the great circle.
    #[arg(long = "every-nm", value_name = "N", conflicts_with = "every_deg_lon")]
    pub every_nm: Option<f64>,
    /// A waypoint where the great circle crosses every meridian that is a multiple of M
    /// degrees.
    #[arg(long = "every-deg-lon", value_name = "M")]
    pub every_deg_lon: Option<f64>,
    /// Composite sailing: the track may not pass this parallel (47 keeps it south of
    /// 47 N, -60 north of 60 S).
    #[arg(
        long = "limiting-lat",
        value_name = "DEG",
        allow_negative_numbers = true
    )]
    pub limiting_lat: Option<f64>,
    /// Meridional parts of the rhumb line.
    #[arg(long = "meridional-parts", value_enum, default_value_t = PartsArg::Sphere, value_name = "PARTS")]
    pub meridional_parts: PartsArg,
    /// Speed over the ground, knots: hours under way, and with --departure the ETAs.
    #[arg(long, value_name = "KN")]
    pub speed: Option<f64>,
    /// Departure time, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = wire_instant, allow_hyphen_values = true, requires = "speed")]
    pub departure: Option<String>,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn sailing_request(a: &SailingArgs) -> PassageRequest {
    PassageRequest {
        from: a.from,
        to: a.to,
        waypoints: match (a.every_nm, a.every_deg_lon) {
            (Some(n), _) => Some(WaypointSpacing::EveryNm(n)),
            (None, Some(m)) => Some(WaypointSpacing::EveryDegLon(m)),
            (None, None) => None,
        },
        limiting_latitude_deg: a.limiting_lat,
        meridional_parts: a.meridional_parts.into(),
        speed_kn: a.speed,
        departure_utc: a.departure.clone(),
    }
}

pub fn run_sailing(a: &SailingArgs) -> Result<u8> {
    let req = sailing_request(a);
    let r = call(wasm_sailings::sailing_impl(&serde_json::to_string(&req)?))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_sailing(&r))?;
    }
    Ok(exit::OK)
}

fn waypoint_table(w: &[Waypoint]) -> String {
    let mut t = Table::new(&[
        ("#", Align::Right),
        ("lat", Align::Left),
        ("lon", Align::Left),
        ("from start NM", Align::Right),
        ("track", Align::Right),
        ("rhumb to next", Align::Right),
        ("NM", Align::Right),
        ("sailed NM", Align::Right),
        ("ETA", Align::Left),
    ]);
    for p in w {
        t.row(vec![
            p.index.to_string(),
            report::format_lat(p.lat_deg),
            report::format_lon(p.lon_deg),
            format!("{:.1}", p.distance_from_start_nm),
            format!("{:.1}", p.track_course_deg),
            opt_course(p.leg_course_deg),
            p.leg_distance_nm
                .map_or_else(|| "-".to_string(), |d| format!("{d:.1}")),
            format!("{:.1}", p.sailed_nm),
            p.eta_jd_utc.map_or_else(|| "-".to_string(), text::utc),
        ]);
    }
    t.render("  ")
}

fn render_sailing(r: &PassageReport) -> String {
    let mut out = String::from("SAILINGS\n");
    out.push_str(&format!(
        "From       {}\nTo         {}\n",
        pos(r.from),
        pos(r.to)
    ));
    if let Some(v) = r.speed_kn {
        out.push_str(&format!(
            "Speed      {v} kn{}\n",
            r.departure_utc
                .as_deref()
                .map(|d| format!(", departing {d}"))
                .unwrap_or_default()
        ));
    }
    out.push('\n');
    let gc = &r.great_circle;
    let rl = &r.rhumb_line;
    let mut t = Table::new(&[
        ("sailing", Align::Left),
        ("course", Align::Right),
        ("NM", Align::Right),
        ("km", Align::Right),
        ("under way", Align::Left),
    ]);
    t.row(vec![
        "great circle".into(),
        format!(
            "{} initial, {} final",
            opt_course(gc.initial_course_deg),
            opt_course(gc.final_course_deg)
        ),
        format!("{:.1}", gc.distance_nm),
        format!("{:.1}", gc.distance_km),
        arrival_words(&gc.arrival),
    ]);
    t.row(vec![
        format!("rhumb line ({})", rl.meridional_parts.name()),
        opt_course(rl.course_deg),
        format!("{:.1}", rl.distance_nm),
        format!("{:.1}", rl.distance_km),
        arrival_words(&rl.arrival),
    ]);
    if let Some(m) = &r.mid_latitude {
        t.row(vec![
            "mid-latitude".into(),
            opt_course(m.course_deg),
            format!("{:.1}", m.distance_nm),
            "-".into(),
            arrival_words(&m.arrival),
        ]);
    }
    if let Some(c) = &r.composite {
        t.row(vec![
            format!("composite (limit {} deg)", c.limiting_latitude_deg),
            if c.applies { "3 legs" } else { "not needed" }.into(),
            format!("{:.1}", c.distance_nm),
            format!("{:.1}", c.distance_km),
            arrival_words(&c.arrival),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_field(
        &mut out,
        "Saving",
        &format!(
            "the great circle is {:.1} NM shorter than the rhumb line",
            r.great_circle_saving_nm
        ),
    );
    match &gc.vertex {
        Some(v) => push_field(
            &mut out,
            "Vertex",
            &format!(
                "{}, {:.1} NM {} the departure{}",
                pos(LatLon {
                    lat_deg: v.lat_deg,
                    lon_deg: v.lon_deg
                }),
                v.distance_from_start_nm.abs(),
                if v.distance_from_start_nm < 0.0 {
                    "behind"
                } else {
                    "from"
                },
                if v.on_route { ", on the route" } else { "" }
            ),
        ),
        None => push_field(&mut out, "Vertex", "none: the track runs along the equator"),
    }
    push_field(
        &mut out,
        "Rhumb line",
        &format!(
            "DLat {:.1}', DLo {:.1}', departure {:.1} NM{}",
            rl.dlat_arcmin,
            rl.dlo_arcmin,
            rl.departure_nm,
            rl.meridional_difference_arcmin
                .map(|m| format!(", meridional difference {m:.1}'"))
                .unwrap_or_default()
        ),
    );
    if let Some(c) = &r.composite {
        out.push_str("\nComposite sailing\n");
        let mut t = Table::new(&[
            ("leg", Align::Left),
            ("from", Align::Left),
            ("to", Align::Left),
            ("NM", Align::Right),
            ("course", Align::Right),
        ]);
        for l in &c.legs {
            t.row(vec![
                l.kind.replace('_', " "),
                report::format_position(l.from),
                report::format_position(l.to),
                format!("{:.1}", l.distance_nm),
                format!(
                    "{} to {}",
                    opt_course(l.initial_course_deg),
                    opt_course(l.final_course_deg)
                ),
            ]);
        }
        out.push_str(&t.render("  "));
        push_note(&mut out, &c.note);
        if !c.waypoints.is_empty() {
            out.push_str("\nComposite waypoints\n");
            out.push_str(&waypoint_table(&c.waypoints));
        }
    }
    if !gc.waypoints.is_empty() {
        out.push_str("\nGreat-circle waypoints (steer the rhumb line to the next)\n");
        out.push_str(&waypoint_table(&gc.waypoints));
        out.push_str(&format!(
            "  sailing the rhumb lines between them: {:.1} NM\n",
            gc.waypoint_route_nm
        ));
    }
    if !r.notes.is_empty() {
        out.push('\n');
        for n in &r.notes {
            push_note(&mut out, n);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// dr-advance
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct DrArgs {
    /// Where the run starts, LAT,LON in degrees.
    #[arg(long, value_name = "LAT,LON", value_parser = parse_latlon, allow_hyphen_values = true)]
    pub from: LatLon,
    /// Course over the ground, degrees true.
    #[arg(long, value_name = "DEG")]
    pub course: f64,
    /// Speed over the ground, knots.
    #[arg(long, value_name = "KN")]
    pub speed: f64,
    /// Hours run; negative for where the vessel was that long before.
    #[arg(long, value_name = "H", allow_negative_numbers = true)]
    pub hours: f64,
    /// How the leg is sailed.
    #[arg(long, value_enum, default_value_t = DrMethodArg::Rhumb, value_name = "METHOD")]
    pub method: DrMethodArg,
    /// Meridional parts of a rhumb-line leg.
    #[arg(long = "meridional-parts", value_enum, default_value_t = PartsArg::Sphere, value_name = "PARTS")]
    pub meridional_parts: PartsArg,
    /// The instant at --from, RFC 3339 with a trailing Z: gives the arrival time.
    #[arg(long, value_name = "RFC3339", value_parser = wire_instant, allow_hyphen_values = true)]
    pub start: Option<String>,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn dr_request(a: &DrArgs) -> DrRequest {
    DrRequest {
        from: a.from,
        course_deg: a.course,
        speed_kn: a.speed,
        hours: a.hours,
        method: a.method.into(),
        meridional_parts: a.meridional_parts.into(),
        start_utc: a.start.clone(),
    }
}

pub fn run_dr(a: &DrArgs) -> Result<u8> {
    let req = dr_request(a);
    let r = call(wasm_sailings::dr_advance_impl(&serde_json::to_string(
        &req,
    )?))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_dr(&r))?;
    }
    Ok(exit::OK)
}

fn render_dr(r: &DrReport) -> String {
    let mut out = String::from("DEAD RECKONING\n");
    out.push_str(&format!("From       {}\n", pos(r.from)));
    out.push_str(&format!(
        "Run        course {} at {} kn for {} h: {:.2} NM, {} sailing{}\n",
        text::course(r.course_deg),
        r.speed_kn,
        r.hours,
        r.distance_nm,
        r.method.name().replace('_', "-"),
        if r.method == DrMethod::Rhumb {
            format!(" ({} meridional parts)", r.meridional_parts.name())
        } else {
            String::new()
        }
    ));
    out.push_str(&format!("DR         {}\n", pos(r.to)));
    out.push_str(&format!(
        "Heading    {} on arrival\n",
        text::course(r.final_course_deg)
    ));
    if let Some(jd) = r.arrival_jd_utc {
        out.push_str(&format!("Time       {}\n", text::utc(jd)));
    }
    out
}

// ---------------------------------------------------------------------------
// route-positions
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct RouteArgs {
    /// Where the route starts, LAT,LON in degrees.
    #[arg(long, value_name = "LAT,LON", value_parser = parse_latlon, allow_hyphen_values = true)]
    pub start: LatLon,
    /// When the vessel is at --start, RFC 3339 with a trailing Z.
    #[arg(long = "start-utc", value_name = "RFC3339", value_parser = wire_instant, allow_hyphen_values = true)]
    pub start_utc: String,
    /// A leg, [START_UTC,]COURSE,SPEED, repeated in time order; only the first may leave
    /// out its start (it then starts with the route). The running fix's legs.
    #[arg(long = "leg", value_name = "[START,]COURSE,SPEED", value_parser = parse_leg, allow_hyphen_values = true, required = true)]
    pub legs: Vec<RunningFixLeg>,
    /// When the vessel stops; after it the position stays put.
    #[arg(long = "end-utc", value_name = "RFC3339", value_parser = wire_instant, allow_hyphen_values = true)]
    pub end_utc: Option<String>,
    /// How each leg is sailed.
    #[arg(long, value_enum, default_value_t = DrMethodArg::Rhumb, value_name = "METHOD")]
    pub method: DrMethodArg,
    /// Meridional parts of rhumb-line legs.
    #[arg(long = "meridional-parts", value_enum, default_value_t = PartsArg::Sphere, value_name = "PARTS")]
    pub meridional_parts: PartsArg,
    /// Report the position at this instant (repeat the flag for more).
    #[arg(long = "at", value_name = "RFC3339", value_parser = wire_instant, allow_hyphen_values = true)]
    pub at: Vec<String>,
    /// And every so many minutes from the start to --end-utc.
    #[arg(long, value_name = "MIN", requires = "end_utc")]
    pub step: Option<f64>,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn route_request(a: &RouteArgs) -> RouteRequest {
    RouteRequest {
        start: a.start,
        start_utc: a.start_utc.clone(),
        legs: a
            .legs
            .iter()
            .map(|l| RouteLeg {
                start_utc: l.start_utc.clone(),
                course_deg: l.course_deg,
                speed_kn: l.speed_kn,
            })
            .collect(),
        end_utc: a.end_utc.clone(),
        method: a.method.into(),
        meridional_parts: a.meridional_parts.into(),
        times_utc: a.at.clone(),
        step_minutes: a.step,
    }
}

pub fn run_route(a: &RouteArgs) -> Result<u8> {
    let req = route_request(a);
    let r = call(wasm_sailings::route_positions_impl(&serde_json::to_string(
        &req,
    )?))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_route(&r))?;
    }
    Ok(exit::OK)
}

fn status_words(s: RouteStatus) -> &'static str {
    match s {
        RouteStatus::BeforeStart => "before the start",
        RouteStatus::Waiting => "waiting to start",
        RouteStatus::UnderWay => "under way",
        RouteStatus::AfterEnd => "after the end",
    }
}

fn render_route(r: &RouteReport) -> String {
    let mut out = format!(
        "ROUTE\nMethod     {} sailing{}\n\nLegs\n",
        r.method.name().replace('_', "-"),
        if r.method == DrMethod::Rhumb {
            format!(" ({} meridional parts)", r.meridional_parts.name())
        } else {
            String::new()
        }
    );
    let mut t = Table::new(&[
        ("#", Align::Right),
        ("from UTC", Align::Left),
        ("to UTC", Align::Left),
        ("course", Align::Right),
        ("kn", Align::Right),
        ("NM", Align::Right),
        ("ends at", Align::Left),
    ]);
    for l in &r.legs {
        t.row(vec![
            l.index.to_string(),
            text::utc(l.start_jd_utc),
            l.end_jd_utc.map_or_else(|| "-".to_string(), text::utc),
            text::course(l.course_deg),
            format!("{}", l.speed_kn),
            l.distance_nm
                .map_or_else(|| "-".to_string(), |d| format!("{d:.1}")),
            l.to.map_or_else(|| "-".to_string(), report::format_position),
        ]);
    }
    out.push_str(&t.render("  "));
    if !r.points.is_empty() {
        out.push_str("\nPositions\n");
        let mut t = Table::new(&[
            ("UTC", Align::Left),
            ("lat", Align::Left),
            ("lon", Align::Left),
            ("leg", Align::Right),
            ("run NM", Align::Right),
            ("", Align::Left),
        ]);
        for p in &r.points {
            t.row(vec![
                text::utc(p.jd_utc),
                report::format_lat(p.lat_deg),
                report::format_lon(p.lon_deg),
                p.leg.map_or_else(|| "-".to_string(), |l| l.to_string()),
                format!("{:.2}", p.distance_run_nm),
                status_words(p.status).to_string(),
            ]);
        }
        out.push_str(&t.render("  "));
    }
    if let Some(m) = &r.made_good {
        out.push('\n');
        push_field(
            &mut out,
            "Made good",
            &format!(
                "{:.2} NM in {:.2} h{}{}",
                m.distance_nm,
                m.hours,
                m.course_deg
                    .map(|c| format!(", course {c:.1}"))
                    .unwrap_or_default(),
                m.speed_kn
                    .map(|v| format!(", {v:.2} kn"))
                    .unwrap_or_default()
            ),
        );
    }
    if !r.notes.is_empty() {
        out.push('\n');
        for n in &r.notes {
            push_note(&mut out, n);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// star-id
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum AltitudeKindArg {
    /// The sextant reading, corrected here (default).
    #[default]
    #[value(alias = "hs")]
    SextantHs,
    /// The apparent altitude, after the index correction and dip.
    #[value(alias = "ha")]
    ApparentHa,
    /// The observed altitude, fully corrected (as for a star).
    #[value(alias = "ho")]
    ObservedHo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum BearingKindArg {
    /// A true bearing (default).
    #[default]
    True,
    /// A magnetic bearing: --variation is added.
    Magnetic,
    /// A compass bearing: --deviation and --variation are added.
    Compass,
}

#[derive(clap::Args, Debug)]
pub struct StarIdArgs {
    #[command(flatten)]
    pub position: PositionArgs,
    /// The sight's time, RFC 3339 with a trailing Z (the watch's error already applied).
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// The altitude measured, degrees.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true)]
    pub altitude: f64,
    /// What --altitude is.
    #[arg(long = "altitude-kind", value_enum, default_value_t = AltitudeKindArg::SextantHs, value_name = "KIND")]
    pub altitude_kind: AltitudeKindArg,
    /// The bearing, degrees.
    #[arg(long, value_name = "DEG")]
    pub bearing: f64,
    /// What --bearing is.
    #[arg(long = "bearing-kind", value_enum, default_value_t = BearingKindArg::True, value_name = "KIND")]
    pub bearing_kind: BearingKindArg,
    /// Variation, degrees east positive (11.5 W is -11.5), for a magnetic or compass
    /// bearing.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true)]
    pub variation: Option<f64>,
    /// Deviation, degrees east positive, for a compass bearing.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true)]
    pub deviation: Option<f64>,
    /// How far in altitude a candidate may be, degrees. Default 2.
    #[arg(long = "altitude-tolerance", value_name = "DEG")]
    pub altitude_tolerance: Option<f64>,
    /// How far in bearing a candidate may be, degrees. Default 5.
    #[arg(long = "bearing-tolerance", value_name = "DEG")]
    pub bearing_tolerance: Option<f64>,
    #[command(flatten)]
    pub optics: SightOpticsArgs,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn star_id_request(a: &StarIdArgs) -> Result<StarIdRequest> {
    let bearing_kind = match a.bearing_kind {
        BearingKindArg::True => BearingKind::True,
        BearingKindArg::Magnetic => BearingKind::Magnetic,
        BearingKindArg::Compass => BearingKind::Compass,
    };
    if bearing_kind == BearingKind::True && (a.variation.is_some() || a.deviation.is_some()) {
        bail!(
            "--variation and --deviation apply to a magnetic or compass bearing \
             (--bearing-kind magnetic|compass); a true bearing needs neither"
        );
    }
    if bearing_kind == BearingKind::Magnetic && a.deviation.is_some() {
        bail!("--deviation applies to a compass bearing (--bearing-kind compass) only");
    }
    Ok(StarIdRequest {
        utc: skyfix_core::time::format_utc(a.utc),
        observer: a.optics.observer(a.position.lat, a.position.lon),
        instrument: a.optics.instrument(),
        altitude_deg: a.altitude,
        altitude_kind: match a.altitude_kind {
            AltitudeKindArg::SextantHs => AltitudeKind::SextantHs,
            AltitudeKindArg::ApparentHa => AltitudeKind::ApparentHa,
            AltitudeKindArg::ObservedHo => AltitudeKind::ObservedHo,
        },
        bearing_deg: a.bearing,
        bearing_kind,
        variation_deg: a.variation,
        deviation_deg: a.deviation,
        altitude_tolerance_deg: a.altitude_tolerance.unwrap_or(2.0),
        bearing_tolerance_deg: a.bearing_tolerance.unwrap_or(5.0),
    })
}

pub fn run_star_id(a: &StarIdArgs) -> Result<u8> {
    let req = star_id_request(a)?;
    let r = call(wasm_sailings::star_identify_impl(&serde_json::to_string(
        &req,
    )?))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_star_id(&r, a))?;
    }
    Ok(exit::OK)
}

fn render_star_id(r: &StarIdResult, a: &StarIdArgs) -> String {
    let p = LatLon {
        lat_deg: a.position.lat,
        lon_deg: a.position.lon,
    };
    let mut out = format!(
        "WHAT DID I SHOOT?\nDR         {}\nTime       {}\n",
        pos(p),
        text::utc(r.jd_utc)
    );
    push_field(
        &mut out,
        "Observed",
        &format!(
            "altitude {} (after the corrections, airless topocentric), true bearing {}",
            text::alt_inline(r.observed_altitude_deg),
            text::dm360(r.observed_bearing_deg).trim_start()
        ),
    );
    push_field(
        &mut out,
        "Sky",
        &format!(
            "{}, the Sun at {}: stars to magnitude {:.1} are visible",
            r.sky,
            text::alt_inline(r.sun_altitude_deg),
            r.limiting_magnitude
        ),
    );
    out.push('\n');
    push_note(&mut out, &r.message);
    out.push('\n');
    let mut t = Table::new(&[
        ("#", Align::Right),
        ("body", Align::Left),
        ("kind", Align::Left),
        ("mag", Align::Right),
        ("alt", Align::Right),
        ("Az", Align::Right),
        ("d alt '", Align::Right),
        ("d brg '", Align::Right),
        ("within", Align::Left),
    ]);
    for c in &r.candidates {
        t.row(vec![
            c.rank.to_string(),
            c.body.clone(),
            match c.kind {
                CandidateKind::Star => "star",
                CandidateKind::Planet => "planet",
                CandidateKind::Moon => "Moon",
            }
            .to_string(),
            super::wire::opt_fixed(c.magnitude, 2),
            text::alt(c.altitude_deg),
            text::dm360(c.azimuth_deg),
            text::signed_fixed(c.delta_altitude_deg * 60.0, 1),
            text::signed_fixed(c.delta_bearing_deg * 60.0, 1),
            if c.within_tolerance {
                if c.bright_enough == Some(false) {
                    "yes, too faint"
                } else {
                    "yes"
                }
            } else {
                "no"
            }
            .to_string(),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push_str(&format!(
        "\nThe corrections applied to the {}\n",
        match a.altitude_kind {
            AltitudeKindArg::SextantHs => "sextant reading",
            AltitudeKindArg::ApparentHa => "apparent altitude",
            AltitudeKindArg::ObservedHo => "observed altitude",
        }
    ));
    out.push_str(&step_header());
    for step in &r.corrections.steps {
        out.push_str(&step_row(step));
    }
    report::warning_block(&r.warnings, &mut out);
    out.push('\n');
    for n in &r.notes {
        push_note(&mut out, n);
    }
    push_note(
        &mut out,
        &format!(
            "alt is each body's airless topocentric altitude at the DR (the Moon's parallax \
             removed), Az true; d alt and d brg are observed minus the body's, in \
             arcminutes. Tolerances {} deg in altitude, {} deg in bearing. Candidates from \
             {}.",
            r.altitude_tolerance_deg, r.bearing_tolerance_deg, r.source
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// star-finder
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct StarFinderArgs {
    /// Your latitude, degrees: it picks the template of its 10-degree band.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lat)]
    pub lat: f64,
    /// Plot the stars' apparent places of this date instead of J2000.0.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: Option<f64>,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_star_finder(a: &StarFinderArgs) -> Result<u8> {
    let g = call(wasm_sailings::star_finder_geometry_impl(a.lat, a.utc))?;
    if a.format.is_json() {
        emit_json(&g)?;
    } else {
        report::emit(&render_star_finder(&g))?;
    }
    Ok(exit::OK)
}

fn render_star_finder(g: &StarFinderGeometry) -> String {
    let side = match g.side {
        Side::North => "north",
        Side::South => "south",
    };
    let mut out = String::from("STAR FINDER\n");
    push_field(
        &mut out,
        "Template",
        &format!(
            "for {:.0} deg {} (latitude {} asked), the {side} side of the base; stars at \
             their {}",
            g.template_latitude_deg.abs(),
            if g.template_latitude_deg >= 0.0 {
                "N"
            } else {
                "S"
            },
            g.requested_latitude_deg,
            g.epoch
        ),
    );
    push_field(
        &mut out,
        "Setting",
        &format!(
            "turn the template {} by LHA Aries degrees about the centre and read each star's \
             altitude and azimuth off its grid",
            if g.rotation_sign > 0.0 {
                "anticlockwise"
            } else {
                "clockwise"
            }
        ),
    );
    out.push('\n');
    let mut t = Table::new(&[
        ("star", Align::Left),
        ("SHA", Align::Right),
        ("Dec", Align::Right),
        ("mag", Align::Right),
        ("x", Align::Right),
        ("y", Align::Right),
    ]);
    for s in &g.stars {
        let xy = if g.side == Side::North {
            s.north
        } else {
            s.south
        };
        t.row(vec![
            s.name.clone(),
            text::dm360(s.sha_deg),
            text::dec(s.dec_deg),
            format!("{:.2}", s.magnitude),
            format!("{:+.4}", xy[0]),
            format!("{:+.4}", xy[1]),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    for n in &g.notes {
        push_note(&mut out, n);
    }
    push_note(
        &mut out,
        &format!(
            "x and y are on the {side} side's unit disc (x right, y up, the equator at radius \
             {}); --format json has both sides, the Aries index, and the template's horizon, \
             altitude circles and azimuth lines for drawing.",
            g.equator_radius
        ),
    );
    out
}
