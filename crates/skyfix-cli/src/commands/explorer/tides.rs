//! Tides from the optional `tides-us` pack: `tide-stations`, `tide-station`,
//! `tide-predict`, `tide-extremes`, `tide-now` and `tide-pack`. OWNER: cli3 agent.
//!
//! Engine: `skyfix_tides` through the WASM adapter's `skyfix_wasm::tides::native`, with
//! the station database the pack installs (`--pack web/public/data/packs/tides-us`, as
//! the site loads its saved copy); wire format EXPLORER_API.md "Expansion programme —
//! tides"; definitions CONVENTIONS 13.11. Every call without the pack fails with the
//! engine's `pack_not_loaded: …` and a line saying how to load it. Predictions, not
//! observations: weather and surge are not included, and every report says so.

use anyhow::{Result, anyhow};
use skyfix_tides::TideDb;
use skyfix_tides::api::{
    TideCurve, TideEvent, TideExtremes, TideNow, TideStation, TideStationNear,
};
use skyfix_wasm::tides::native;

use super::args::{FormatArgs, PositionArgs, parse_instant};
use super::sun::WindowFlags;
use super::text;
use super::wire::{
    Align, Table, ZoneFlag, emit_json, push_field, push_note, shown_in, when_cells, when_headers,
};
use super::zone::ResolvedZone;
use crate::exit;
use crate::report;

/// The installed database, or the engine's own refusal with how to load the pack.
fn db() -> Option<std::sync::Arc<TideDb>> {
    native::installed()
}

fn with_hint<T>(r: std::result::Result<T, String>) -> Result<T> {
    r.map_err(|e| {
        if e.starts_with("pack_not_loaded") {
            anyhow!(
                "{e}\nLoad it for this run with --pack web/public/data/packs/tides-us (from the \
                 repository root), or --pack FILE for a copy of the pack"
            )
        } else {
            anyhow!(e)
        }
    })
}

/// `--datum`.
#[derive(clap::Args, Debug, Clone)]
pub struct DatumFlag {
    /// The datum heights are above: MLLW, MLW, MSL, MTL, MHW, MHHW, LAT, HAT or NAVD88.
    /// Default: the station's own (MLLW; MSL where NOAA publishes no datums).
    #[arg(long, value_name = "DATUM", default_value = "")]
    pub datum: String,
}

fn station_block(out: &mut String, s: &TideStation) {
    push_field(
        out,
        "Station",
        &format!(
            "{}{}, NOAA {}",
            s.name,
            s.state
                .as_deref()
                .map(|st| format!(", {st}"))
                .unwrap_or_default(),
            s.id
        ),
    );
    let pos = skyfix_core::types::LatLon {
        lat_deg: s.lat_deg,
        lon_deg: s.lon_deg,
    };
    push_field(
        out,
        "Place",
        &format!(
            "{} ({})",
            report::format_position(pos),
            report::format_position_decimal(pos)
        ),
    );
    let kind = match (s.kind, &s.reference_name, &s.reference_id) {
        ("subordinate", Some(n), Some(id)) => {
            format!("subordinate to {n} ({id}): times and heights by NOAA's offsets")
        }
        (k, _, _) => k.to_string(),
    };
    push_field(
        out,
        "Kind",
        &format!(
            "{kind}; {}{}",
            s.tide_type
                .map(|t| format!("{} tide", t.replace('_', " ")))
                .unwrap_or_else(|| "tide type unknown".to_string()),
            s.form_number
                .map(|f| format!(" (form number {f:.2})"))
                .unwrap_or_default()
        ),
    );
    push_field(
        out,
        "Datums",
        &format!("{} (default {})", s.datums.join(", "), s.default_datum),
    );
}

fn feet(m: f64) -> String {
    format!("{:.2}", m / 0.3048)
}

// ---------------------------------------------------------------------------
// tide-stations
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct StationsNearArgs {
    #[command(flatten)]
    pub position: PositionArgs,
    /// How many stations, nearest first (1 to 100).
    #[arg(long, value_name = "N", default_value_t = 10)]
    pub count: u32,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_stations_near(a: &StationsNearArgs) -> Result<u8> {
    let db = db();
    let r = with_hint(native::stations_near_in(
        db.as_deref(),
        a.position.lat,
        a.position.lon,
        a.count,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_near(&r, a))?;
    }
    Ok(exit::OK)
}

fn render_near(r: &[TideStationNear], a: &StationsNearArgs) -> String {
    let p = skyfix_core::types::LatLon {
        lat_deg: a.position.lat,
        lon_deg: a.position.lon,
    };
    let mut out = format!(
        "TIDE STATIONS NEAR {} ({})\n\n",
        report::format_position(p),
        report::format_position_decimal(p)
    );
    let mut t = Table::new(&[
        ("id", Align::Left),
        ("station", Align::Left),
        ("state", Align::Left),
        ("NM", Align::Right),
        ("km", Align::Right),
        ("bearing", Align::Right),
        ("kind", Align::Left),
        ("curve", Align::Left),
    ]);
    for s in r {
        t.row(vec![
            s.station.id.clone(),
            s.station.name.clone(),
            s.station.state.clone().unwrap_or_default(),
            format!("{:.1}", s.distance_nm),
            format!("{:.1}", s.distance_km),
            text::course(s.bearing_deg.round()),
            s.station.kind.to_string(),
            s.station.curve.to_string(),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "Distances on the sphere, bearings the initial great-circle bearing from the place, \
         true. curve: harmonic, a true tide curve; interpolated (a subordinate station), the \
         curve between its high and low waters, an estimate; none, no prediction.",
    );
    out
}

// ---------------------------------------------------------------------------
// tide-station
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct StationArgs {
    /// The NOAA station id, e.g. 9414290.
    #[arg(value_name = "ID")]
    pub id: String,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_station(a: &StationArgs) -> Result<u8> {
    let db = db();
    let s = with_hint(native::station_in(db.as_deref(), &a.id))?;
    if a.format.is_json() {
        emit_json(&s)?;
    } else {
        let mut out = String::from("TIDE STATION\n");
        station_block(&mut out, &s);
        push_field(&mut out, "Curve", s.curve);
        if !s.flags.is_empty() {
            push_field(&mut out, "Flags", &s.flags.join(", "));
        }
        if !s.notes.is_empty() {
            out.push('\n');
            for n in &s.notes {
                push_note(&mut out, n);
            }
        }
        report::emit(&out)?;
    }
    Ok(exit::OK)
}

/// The zone for a station: the nautical zone takes the station's longitude.
fn station_zone(zone: &ZoneFlag, id: &str) -> Result<(ResolvedZone, TideStation)> {
    let db = db();
    let s = with_hint(native::station_in(db.as_deref(), id))?;
    Ok((zone.resolve(s.lon_deg), s))
}

fn label_notes(out: &mut String, label: &str, notes: &[String]) {
    out.push('\n');
    push_note(out, &format!("{label}."));
    for n in notes {
        push_note(out, n);
    }
}

// ---------------------------------------------------------------------------
// tide-extremes
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ExtremesArgs {
    /// The NOAA station id.
    #[arg(value_name = "ID")]
    pub id: String,
    #[command(flatten)]
    pub window: WindowFlags,
    #[command(flatten)]
    pub datum: DatumFlag,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_extremes(a: &ExtremesArgs) -> Result<u8> {
    let (zone, _) = station_zone(&a.zone, &a.id)?;
    let (s, e) = a.window.resolve(&zone)?;
    let db = db();
    let r = with_hint(native::extremes_in(
        db.as_deref(),
        &a.id,
        s,
        e,
        &a.datum.datum,
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_extremes(&r, &zone))?;
    }
    Ok(exit::OK)
}

fn event_table(events: &[TideEvent], zone: &ResolvedZone, datum: &str) -> String {
    let mut cols = when_headers(zone);
    cols.extend([
        ("tide", Align::Left),
        ("m", Align::Right),
        ("ft", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for ev in events {
        let mut row = when_cells(ev.jd_utc, zone);
        row.extend([
            ev.kind.to_string(),
            format!("{:.3}", ev.height_m),
            feet(ev.height_m),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        return "  none in this window\n".to_string();
    }
    let mut s = t.render("  ");
    s.push_str(&format!("  heights above {datum}\n"));
    s
}

fn render_extremes(r: &TideExtremes, zone: &ResolvedZone) -> String {
    let mut out = String::from("HIGH AND LOW WATER\n");
    station_block(&mut out, &r.station);
    push_field(
        &mut out,
        "Window",
        &format!(
            "{} to {}{}; {}",
            text::utc(r.jd_start),
            text::utc(r.jd_end),
            shown_in(zone),
            if r.method == "subordinate_offsets" {
                "by the reference station's tides and NOAA's offsets"
            } else {
                "harmonic prediction"
            }
        ),
    );
    out.push('\n');
    out.push_str(&event_table(&r.extremes, zone, r.datum));
    label_notes(&mut out, r.label, &r.notes);
    out
}

// ---------------------------------------------------------------------------
// tide-predict
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct PredictArgs {
    /// The NOAA station id.
    #[arg(value_name = "ID")]
    pub id: String,
    #[command(flatten)]
    pub window: WindowFlags,
    /// Minutes between heights, 0.5 to 1440.
    #[arg(long, value_name = "MIN", default_value_t = 10.0)]
    pub step: f64,
    #[command(flatten)]
    pub datum: DatumFlag,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_predict(a: &PredictArgs) -> Result<u8> {
    let (zone, _) = station_zone(&a.zone, &a.id)?;
    let (s, e) = a.window.resolve(&zone)?;
    let db = db();
    let r = with_hint(native::predict_in(
        db.as_deref(),
        &a.id,
        s,
        e,
        a.step,
        &a.datum.datum,
    ))?;
    if a.format.is_json() {
        // The export's object; its jd_utc and height_m are Float64Arrays there, arrays
        // here, and TideCurve serialises to exactly those keys.
        emit_json(&r)?;
    } else {
        report::emit(&render_predict(&r, &zone))?;
    }
    Ok(exit::OK)
}

fn render_predict(r: &TideCurve, zone: &ResolvedZone) -> String {
    let mut out = String::from("TIDE CURVE\n");
    station_block(&mut out, &r.station);
    push_field(
        &mut out,
        "Window",
        &format!(
            "{} to {}{}, every {} min; {}",
            text::utc(r.jd_start),
            text::utc(r.jd_end),
            shown_in(zone),
            r.step_min,
            if r.method == "interpolated" {
                "interpolated between high and low water (NOAA's Table 3): an estimate"
            } else {
                "harmonic prediction"
            }
        ),
    );
    out.push('\n');
    let mut cols = when_headers(zone);
    cols.extend([("m", Align::Right), ("ft", Align::Right)]);
    let mut t = Table::new(&cols);
    for (jd, h) in r.jd_utc.iter().zip(&r.height_m) {
        let mut row = when_cells(*jd, zone);
        row.extend([format!("{h:.3}"), feet(*h)]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  no heights in this window\n");
    } else {
        out.push_str(&t.render("  "));
        out.push_str(&format!("  heights above {}\n", r.datum));
    }
    label_notes(&mut out, r.label, &r.notes);
    out
}

// ---------------------------------------------------------------------------
// tide-now
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct NowArgs {
    /// The NOAA station id.
    #[arg(value_name = "ID")]
    pub id: String,
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    #[command(flatten)]
    pub datum: DatumFlag,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_now(a: &NowArgs) -> Result<u8> {
    let (zone, _) = station_zone(&a.zone, &a.id)?;
    let db = db();
    let r = with_hint(native::now_in(db.as_deref(), &a.id, a.utc, &a.datum.datum))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_now(&r, &zone))?;
    }
    Ok(exit::OK)
}

fn render_now(r: &TideNow, zone: &ResolvedZone) -> String {
    let mut out = String::from("THE TIDE NOW\n");
    station_block(&mut out, &r.station);
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    push_field(
        &mut out,
        "Tide",
        &format!(
            "{:.3} m ({} ft) above {}, {} at {:+.3} m an hour",
            r.height_m,
            feet(r.height_m),
            r.datum,
            r.state,
            r.rate_m_per_h
        ),
    );
    out.push('\n');
    let events: Vec<TideEvent> = [&r.previous, &r.next, &r.next_high, &r.next_low]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let mut seen = std::collections::HashSet::new();
    let events: Vec<TideEvent> = events
        .into_iter()
        .filter(|e| seen.insert(e.utc.clone()))
        .collect();
    out.push_str(&event_table(&events, zone, r.datum));
    label_notes(&mut out, r.label, &r.notes);
    out
}

// ---------------------------------------------------------------------------
// tide-pack
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct PackArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_pack(a: &PackArgs) -> Result<u8> {
    let info = native::pack_info();
    if a.format.is_json() {
        emit_json(&info)?;
        return Ok(exit::OK);
    }
    let out = match info {
        Some(i) => format!(
            "TIDES PACK\nPack       {} {}, {} bytes of data, provides {}\nStations   {} ({} \
             harmonic, {} subordinate)\n",
            i.name,
            i.version,
            i.bytes,
            i.provides.join(", "),
            i.stations,
            i.harmonic,
            i.subordinate
        ),
        None => "TIDES PACK\nPack       not loaded: give --pack web/public/data/packs/tides-us\n"
            .to_string(),
    };
    report::emit(&out)?;
    Ok(exit::OK)
}
