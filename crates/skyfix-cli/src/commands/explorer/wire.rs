//! Shared plumbing of the expansion programme's commands. OWNER: cli3 agent.
//!
//! The commands for the programme's engines (sun tools, the magnetic field, sailings,
//! time scales, packs, the Moon in detail, deep sky, planet detail, tides, the lunar
//! limb) call the WASM adapter's native layer, `skyfix_wasm::<module>::native`: the same
//! function each export calls, with the export's own arguments (an observer document, a
//! request document, Julian dates), returning what the export serialises. So `--format
//! json` is the browser's JSON by construction, and the few exports that hand typed
//! arrays to the page are rebuilt here key for key ([`f64s`], [`i32s`]).
//!
//! The flags build those arguments: [`SiteArgs`] and [`SiteAirArgs`] the observer
//! document, [`ZoneFlag`] and [`ClockFlag`] the day or the year a local question is
//! about, [`ConditionsArgs`] the deep-sky conditions. [`set_explorer_dut1`] is the
//! site's DUT1 control (`set_dut1`).

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::{Value, json};
use skyfix_core::types::LatLon;
use skyfix_ephemeris::topocentric::Site;

use super::args::{AirArgs, PositionArgs, parse_lat, parse_lon};
use super::text;
use super::zone::{ResolvedZone, Zone, parse_zone};
use crate::report;

// ---------------------------------------------------------------------------
// Calling the engine and printing its answer
// ---------------------------------------------------------------------------

/// The native layer's `String` error as the command's error (exit 1, the sentence on
/// stderr).
pub fn call<T>(r: Result<T, String>) -> Result<T> {
    r.map_err(|e| anyhow!(e))
}

/// `--format json`: the value exactly as serde writes it, pretty-printed.
pub fn emit_json<T: Serialize + ?Sized>(v: &T) -> Result<()> {
    report::emit_line(&serde_json::to_string_pretty(v)?)?;
    Ok(())
}

/// A `Float64Array` of the wire, as a JSON array of numbers.
pub fn f64s(v: &[f64]) -> Value {
    Value::Array(v.iter().map(|x| json!(x)).collect())
}

/// An `Int32Array` of the wire, as a JSON array of integers.
pub fn i32s(v: &[i32]) -> Value {
    Value::Array(v.iter().map(|x| json!(x)).collect())
}

/// The explorer-wide DUT1 (`set_dut1`): a command whose export reads it (the sky, the
/// day's events, eclipses, the lunar limb, compass error, `time_info`) sets it from
/// `--dut1` before it calls the engine; without the flag the IERS history applies, as on
/// the site with the field empty.
pub fn set_explorer_dut1(dut1: Option<f64>) -> Result<()> {
    call(skyfix_wasm::timescale::native::set_dut1(dut1))
}

/// The span every body is computed over, from the engine itself (`explorer_coverage`,
/// the providers' intersection): `1990-01-01 to 2060-12-31`, never a literal in the help
/// text. The dates are the wire's, proleptic Gregorian.
pub fn coverage_dates() -> String {
    let c = skyfix_wasm::explorer::native::explorer_coverage();
    let day = |s: &str| s.split('T').next().unwrap_or(s).to_string();
    format!("{} to {}", day(&c.start_utc), day(&c.end_utc))
}

/// `Label      text`, the text wrapped under itself at column 12: a report's header line.
pub fn push_field(out: &mut String, label: &str, text: &str) {
    let indent = " ".repeat(11);
    for (i, line) in report::wrap(text, 77, &indent).into_iter().enumerate() {
        if i == 0 {
            out.push_str(&format!("{label:<11}{}\n", line.trim_start()));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }
}

/// Push each of `text`'s wrapped lines, then a newline (the notes under a report).
pub fn push_note(out: &mut String, text: &str) {
    for line in report::wrap(text, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
}

// ---------------------------------------------------------------------------
// The observer
// ---------------------------------------------------------------------------

/// `--lat --lon [--height]`: an observer whose answer does not depend on the air.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct SiteArgs {
    #[command(flatten)]
    pub position: PositionArgs,
    /// Height of the site above the WGS84 ellipsoid, metres; not the height of eye.
    /// Default 0.
    #[arg(
        long,
        value_name = "M",
        default_value_t = 0.0,
        allow_negative_numbers = true
    )]
    pub height: f64,
}

impl SiteArgs {
    pub fn site(&self) -> Site {
        Site {
            lat_deg: self.position.lat,
            lon_deg: self.position.lon,
            height_m: self.height,
            ..Site::default()
        }
    }

    /// The observer document of EXPLORER_API.md "Common rules".
    pub fn json(&self) -> String {
        observer_json(&self.site())
    }
}

/// `--lat --lon [--height] [--pressure] [--temperature]`: an observer whose answer has an
/// apparent (refracted) altitude in it.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct SiteAirArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    #[command(flatten)]
    pub air: AirArgs,
}

impl SiteAirArgs {
    pub fn site(&self) -> Site {
        Site {
            pressure_hpa: self.air.pressure,
            temperature_c: self.air.temperature,
            ..self.site.site()
        }
    }

    pub fn json(&self) -> String {
        observer_json(&self.site())
    }
}

/// `[--lat --lon [--height]]`: an observer a command also answers without (then for the
/// Earth's centre, or without local circumstances).
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct OptionalSite {
    /// Observer's latitude, degrees, north positive (-90 to 90). With --lon.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lat, requires = "lon")]
    pub lat: Option<f64>,
    /// Observer's longitude, degrees, EAST positive (-180 to 180): 75.17 W is -75.17.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lon, requires = "lat")]
    pub lon: Option<f64>,
    /// Height of the site above the WGS84 ellipsoid, metres; not the height of eye.
    /// Default 0.
    #[arg(
        long,
        value_name = "M",
        allow_negative_numbers = true,
        requires = "lat"
    )]
    pub height: Option<f64>,
}

impl OptionalSite {
    pub fn site(&self) -> Option<Site> {
        match (self.lat, self.lon) {
            (Some(lat_deg), Some(lon_deg)) => Some(Site {
                lat_deg,
                lon_deg,
                height_m: self.height.unwrap_or(0.0),
                ..Site::default()
            }),
            _ => None,
        }
    }

    /// The observer document, or `""` (the exports' "no observer").
    pub fn json(&self) -> String {
        self.site().map_or_else(String::new, |s| observer_json(&s))
    }
}

/// [`OptionalSite`] with the air, for an answer with apparent altitudes in it.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct OptionalSiteAir {
    #[command(flatten)]
    pub site: OptionalSite,
    /// Air pressure, hPa, for refraction (with --lat --lon). Default 1010.
    #[arg(long, value_name = "HPA", requires = "lat")]
    pub pressure: Option<f64>,
    /// Air temperature, degrees Celsius, for refraction (with --lat --lon). Default 10.
    #[arg(
        long,
        value_name = "C",
        allow_negative_numbers = true,
        requires = "lat"
    )]
    pub temperature: Option<f64>,
}

impl OptionalSiteAir {
    pub fn site(&self) -> Option<Site> {
        self.site.site().map(|s| Site {
            pressure_hpa: self.pressure.unwrap_or(s.pressure_hpa),
            temperature_c: self.temperature.unwrap_or(s.temperature_c),
            ..s
        })
    }

    pub fn json(&self) -> String {
        self.site().map_or_else(String::new, |s| observer_json(&s))
    }
}

/// `{"lat_deg", "lon_deg", "height_m", "pressure_hpa", "temperature_c"}`.
pub fn observer_json(s: &Site) -> String {
    json!({
        "lat_deg": s.lat_deg,
        "lon_deg": s.lon_deg,
        "height_m": s.height_m,
        "pressure_hpa": s.pressure_hpa,
        "temperature_c": s.temperature_c,
    })
    .to_string()
}

/// `Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 12 m above the WGS84
/// ellipsoid` for a report's header.
pub fn observer_line(s: &Site) -> String {
    let p = LatLon {
        lat_deg: s.lat_deg,
        lon_deg: s.lon_deg,
    };
    format!(
        "{} ({}), {} m above the WGS84 ellipsoid",
        report::format_position(p),
        report::format_position_decimal(p),
        s.height_m
    )
}

// ---------------------------------------------------------------------------
// Zones and clocks
// ---------------------------------------------------------------------------

/// `--zone`: the zone a day is taken in and times are shown in, for a command with an
/// observer (whose longitude sets the nautical zone).
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct ZoneFlag {
    /// `utc` (default), a fixed offset such as -04:00, or `nautical` for the zone time of
    /// the longitude. A date is a date in this zone, and times are shown in it beside UTC.
    /// Named zones (America/New_York) need a tz database this offline tool does not
    /// carry; see docs/CLI.md.
    #[arg(long, value_name = "ZONE", default_value = "utc", value_parser = parse_zone, allow_hyphen_values = true)]
    pub zone: Zone,
}

impl ZoneFlag {
    pub fn resolve(&self, lon_deg: f64) -> ResolvedZone {
        self.zone.resolve(lon_deg)
    }
}

/// `[--zone]` for a question about a local year (the days of an alignment, the analemma,
/// the rise and set bearings, the solar year): the clock its dates are on. Without it the
/// engine's default, local mean time at the observer's longitude.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct ClockFlag {
    /// The clock the dates are on: a fixed offset such as -05:00 (no daylight saving),
    /// `utc`, or `nautical` for the zone time of the longitude. Default: local mean time
    /// at the observer's longitude (UTC + lon/15 hours).
    #[arg(long, value_name = "ZONE", value_parser = parse_zone, allow_hyphen_values = true)]
    pub zone: Option<Zone>,
}

impl ClockFlag {
    /// Hours ahead of UTC, or `None` for local mean time.
    pub fn utc_offset_hours(&self, lon_deg: f64) -> Option<f64> {
        self.zone
            .map(|z| f64::from(z.resolve(lon_deg).offset_minutes) / 60.0)
    }

    /// `local mean time (UTC-05:00:40)` or the zone's label, for a report's header.
    pub fn words(&self, lon_deg: f64) -> String {
        match self.zone {
            Some(z) => z.resolve(lon_deg).label,
            None => {
                let s = (lon_deg / 15.0 * 3600.0).round() as i64;
                let sign = if s < 0 { '-' } else { '+' };
                let a = s.abs();
                format!(
                    "local mean time at the longitude (UTC{sign}{:02}:{:02}:{:02})",
                    a / 3600,
                    a / 60 % 60,
                    a % 60
                )
            }
        }
    }
}

/// The instant `jd` in a table: `[local date and time, UTC]` in a zone, `[UTC]` in UTC.
pub fn when_cells(jd: f64, zone: &ResolvedZone) -> Vec<String> {
    if zone.is_utc() {
        vec![text::utc(jd)]
    } else {
        vec![text::local_datetime(jd, zone.offset_minutes), text::utc(jd)]
    }
}

/// The headings of [`when_cells`].
pub fn when_headers(zone: &ResolvedZone) -> Vec<(&'static str, Align)> {
    if zone.is_utc() {
        vec![("UTC", Align::Left)]
    } else {
        vec![("local", Align::Left), ("UTC", Align::Left)]
    }
}

/// The time of day `jd` in a table for one day: `[local HH:MM:SS, UTC]` in a zone.
pub fn clock_cells(jd: f64, zone: &ResolvedZone) -> Vec<String> {
    if zone.is_utc() {
        vec![text::utc(jd)]
    } else {
        vec![text::clock(jd, zone.offset_minutes), text::utc(jd)]
    }
}

/// `, shown in UTC-04:00` after a title, or nothing in UTC.
pub fn shown_in(zone: &ResolvedZone) -> String {
    if zone.is_utc() {
        String::new()
    } else {
        format!(", shown in {}", zone.label)
    }
}

// ---------------------------------------------------------------------------
// Deep-sky conditions
// ---------------------------------------------------------------------------

/// `[--bortle N | --nelm M] [--k K]`: the observer's sky (EXPLORER_API.md "Deep sky",
/// `conditions_json`).
#[derive(clap::Args, Debug, Clone, Copy, Default)]
pub struct ConditionsArgs {
    /// Bortle class of the sky, 1 (darkest) to 9 (inner city). Default 5.
    #[arg(long, value_name = "N", conflicts_with = "nelm")]
    pub bortle: Option<u8>,
    /// Naked-eye limiting magnitude at the zenith, 1 to 8 (instead of --bortle).
    #[arg(long, value_name = "MAG")]
    pub nelm: Option<f64>,
    /// The extinction coefficient k in V, magnitudes per air mass, 0.2 to 0.4. Default
    /// 0.25.
    #[arg(long = "extinction", value_name = "K")]
    pub k: Option<f64>,
}

impl ConditionsArgs {
    /// The conditions document; fields left out take the engine's defaults.
    pub fn json(&self) -> String {
        let mut m = serde_json::Map::new();
        if let Some(b) = self.bortle {
            m.insert("bortle".into(), json!(b));
        }
        if let Some(n) = self.nelm {
            m.insert("nelm".into(), json!(n));
        }
        if let Some(k) = self.k {
            m.insert("k".into(), json!(k));
        }
        if m.is_empty() {
            String::new()
        } else {
            Value::Object(m).to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/// How a column's cells line up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
}

/// A plain-text table: headings, rows, each column as wide as its widest cell, two
/// spaces between columns, numbers right-aligned.
#[derive(Debug, Clone, Default)]
pub struct Table {
    headers: Vec<String>,
    align: Vec<Align>,
    rows: Vec<Vec<String>>,
}

impl Table {
    pub fn new(columns: &[(&str, Align)]) -> Self {
        Table {
            headers: columns.iter().map(|(h, _)| (*h).to_string()).collect(),
            align: columns.iter().map(|(_, a)| *a).collect(),
            rows: Vec::new(),
        }
    }

    pub fn row(&mut self, cells: Vec<String>) {
        self.rows.push(cells);
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// A heading that says `UTC` over times [`text::utc`] printed as `UT` (outside
    /// 1972-2035, CONVENTIONS 15.2) says `UT`, and `UTC or UT` over a mix.
    fn clock_heading(&self, i: usize) -> String {
        let h = &self.headers[i];
        if !h.contains("UTC") {
            return h.clone();
        }
        let (mut z, mut ut) = (false, false);
        for r in &self.rows {
            match r.get(i) {
                Some(c) if c.ends_with('Z') => z = true,
                Some(c) if c.ends_with(" UT") || c.ends_with(" UT (Julian)") => ut = true,
                _ => {}
            }
        }
        match (z, ut) {
            (false, true) => h.replace("UTC", "UT"),
            (true, true) => h.replace("UTC", "UTC or UT"),
            _ => h.clone(),
        }
    }

    /// The table, each line starting with `indent`, with no trailing spaces.
    pub fn render(&self, indent: &str) -> String {
        let n = self.headers.len();
        let headers: Vec<String> = (0..n).map(|i| self.clock_heading(i)).collect();
        let mut width: Vec<usize> = headers.iter().map(|h| h.chars().count()).collect();
        for r in &self.rows {
            for (i, c) in r.iter().enumerate().take(n) {
                width[i] = width[i].max(c.chars().count());
            }
        }
        let line = |cells: &[String]| -> String {
            let mut s = String::from(indent);
            for (i, c) in cells.iter().enumerate().take(n) {
                if i > 0 {
                    s.push_str("  ");
                }
                let pad = width[i].saturating_sub(c.chars().count());
                match self.align[i] {
                    Align::Left => {
                        s.push_str(c);
                        s.push_str(&" ".repeat(pad));
                    }
                    Align::Right => {
                        s.push_str(&" ".repeat(pad));
                        s.push_str(c);
                    }
                }
            }
            let mut s = s.trim_end().to_string();
            s.push('\n');
            s
        };
        let mut out = line(&headers);
        for r in &self.rows {
            out.push_str(&line(r));
        }
        out
    }
}

/// An enum's wire spelling (`"open_cluster"`) with spaces for underscores, for text.
pub fn words<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(Value::String(s)) => s.replace('_', " "),
        Ok(other) => other.to_string(),
        Err(_) => "?".to_string(),
    }
}

/// `x` to `decimals` places, or `-` for `None`.
pub fn opt_fixed(v: Option<f64>, decimals: usize) -> String {
    v.map_or_else(|| "-".to_string(), |x| text::fixed(x, decimals))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_table_lines_up_its_columns_without_trailing_spaces() {
        let mut t = Table::new(&[("name", Align::Left), ("mag", Align::Right)]);
        t.row(vec!["Vega".into(), "0.03".into()]);
        t.row(vec!["Sirius".into(), "-1.44".into()]);
        assert_eq!(
            t.render("  "),
            "  name      mag\n  Vega     0.03\n  Sirius  -1.44\n"
        );
    }

    #[test]
    fn a_utc_heading_over_ut_times_says_ut() {
        let mut t = Table::new(&[("UTC", Align::Left), ("from UTC", Align::Left)]);
        t.row(vec![
            "1600-01-01T00:00:00 UT".into(),
            "-0584-05-28T12:00:00 UT (Julian)".into(),
        ]);
        let s = t.render("");
        assert!(s.starts_with("UT  "), "{s}");
        assert!(s.contains("from UT"), "{s}");
        t.row(vec!["2026-01-01T00:00:00Z".into(), "-".into()]);
        assert!(t.render("").starts_with("UTC or UT"), "{}", t.render(""));
    }

    #[test]
    fn the_local_mean_time_clock_is_named_with_its_offset() {
        let c = ClockFlag { zone: None };
        assert_eq!(c.utc_offset_hours(-75.1652), None);
        assert_eq!(
            c.words(-75.1652),
            "local mean time at the longitude (UTC-05:00:40)"
        );
        let c = ClockFlag {
            zone: Some(Zone::Fixed(-240)),
        };
        assert_eq!(c.utc_offset_hours(0.0), Some(-4.0));
        let c = ClockFlag {
            zone: Some(Zone::Nautical),
        };
        assert_eq!(c.utc_offset_hours(-75.0), Some(-5.0));
    }

    #[test]
    fn conditions_leave_out_what_was_not_given() {
        assert_eq!(ConditionsArgs::default().json(), "");
        let c = ConditionsArgs {
            bortle: Some(3),
            nelm: None,
            k: Some(0.3),
        };
        assert_eq!(c.json(), r#"{"bortle":3,"k":0.3}"#);
    }
}
