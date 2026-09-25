//! Deep sky: `dso-catalog`, `dso-list`, `dso`, `showers`, `milky-way`, `search`,
//! `tonight` and `extinction`. OWNER: cli3 agent.
//!
//! Engines: `skyfix_starfield::{dso, showers, milkyway, search, tonight, extinction}`
//! through the WASM adapter's `skyfix_wasm::deepsky::native`; wire format EXPLORER_API.md
//! "Expansion programme — deep sky". Display only (CONVENTIONS 13.6): nothing here reaches
//! a reduction, a fix or the planner. Rankings, meteor rates, limiting magnitudes and the
//! instrument guide are estimates from the stated rules, and the reports say so. Four
//! exports hand typed arrays to the page (`dso_catalog`, `dso_list`,
//! `milky_way_outline`, `extinction_table`); `--format json` rebuilds their objects key
//! for key, with the arrays as JSON arrays.

use anyhow::{Result, bail};
use serde_json::{Value, json};
use skyfix_starfield::dso::{DsoPositions, DsoVisibility, Instrument};
use skyfix_starfield::observe::{NightSummary, Sighting};
use skyfix_starfield::showers::ShowerYear;
use skyfix_starfield::tonight::Tonight;
use skyfix_wasm::deepsky::native;

use super::args::{FormatArgs, parse_instant};
use super::sun::YearFlag;
use super::text;
use super::wire::{
    Align, ConditionsArgs, OptionalSiteAir, SiteAirArgs, Table, ZoneFlag, call, emit_json, f64s,
    i32s, observer_line, opt_fixed, push_field, push_note, words,
};
use super::zone::ResolvedZone;
use crate::exit;
use crate::report;

/// `--utc`, required.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct UtcFlag {
    /// The instant, RFC 3339 with a trailing Z. For a night's question, any time in it:
    /// the night runs from local mean noon to local mean noon.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
}

fn hours(h: f64) -> String {
    text::hours_minutes(h)
}

fn at(i: &skyfix_starfield::observe::Instant, zone: &ResolvedZone) -> String {
    text::clock(i.jd_utc, zone.offset_minutes)[..5].to_string()
}

fn sighting(s: &Sighting, zone: &ResolvedZone) -> String {
    format!(
        "{} at {}, {} {}",
        &text::clock(s.jd_utc, zone.offset_minutes)[..5],
        text::alt_inline(s.alt_deg),
        text::dm360(s.az_deg).trim_start(),
        s.direction
    )
}

fn instrument_words(i: Instrument) -> &'static str {
    match i {
        Instrument::Eye => "the naked eye",
        Instrument::Binoculars => "binoculars (10x50)",
        Instrument::Telescope => "a small telescope (100 mm)",
        Instrument::Camera => "a camera or a larger telescope",
    }
}

fn conditions_line(out: &mut String, c: &skyfix_starfield::extinction::Conditions) {
    push_field(
        out,
        "Sky",
        &format!(
            "naked-eye limit {:.1} at the zenith{}, extinction k = {} mag per air mass, sky \
             {:.2} mag/arcsec2 ({})",
            c.nelm,
            c.bortle
                .map(|b| format!(" (Bortle {b})"))
                .unwrap_or_default(),
            c.k,
            c.sky_brightness_mpsas,
            match c.source {
                "nelm" => "from --nelm",
                "bortle" => "from --bortle",
                _ => "the default, Bortle 5",
            }
        ),
    );
}

/// The night's frame: its darkness window, the Sun's and the Moon's events.
fn night_lines(out: &mut String, n: &NightSummary, zone: &ResolvedZone) {
    push_field(
        out,
        "Night",
        &format!(
            "{} to {} (local mean noon to noon), times below in {}",
            text::utc(n.start.jd_utc),
            text::utc(n.end.jd_utc),
            zone.label
        ),
    );
    push_field(
        out,
        "Darkness",
        &match &n.darkness {
            Some(d) => format!(
                "{} from {} to {}, {}",
                match words(&d.kind).as_str() {
                    "night" => "night (the Sun below -18 deg)".to_string(),
                    other => format!("{other} at its darkest"),
                },
                at(&d.start, zone),
                at(&d.end, zone),
                hours(d.hours)
            ),
            None => "none: the Sun never goes 6 deg below the horizon".to_string(),
        },
    );
    let s = &n.sun;
    let ev = |name: &str, i: &Option<skyfix_starfield::observe::Instant>| {
        i.as_ref().map(|i| format!("{name} {}", at(i, zone)))
    };
    let sun: Vec<String> = [
        ev("set", &s.set),
        ev("civil dusk", &s.civil_dusk),
        ev("nautical dusk", &s.nautical_dusk),
        ev("astronomical dusk", &s.astronomical_dusk),
        ev("astronomical dawn", &s.astronomical_dawn),
        ev("nautical dawn", &s.nautical_dawn),
        ev("civil dawn", &s.civil_dawn),
        ev("rise", &s.rise),
    ]
    .into_iter()
    .flatten()
    .collect();
    push_field(out, "Sun", &sun.join(", "));
    let m = &n.moon;
    let mut moon = format!("{}, {:.0}% lit", m.phase, m.illuminated_fraction * 100.0);
    if let Some(r) = &m.rise {
        moon.push_str(&format!(", rises {}", at(r, zone)));
    }
    if let Some(s) = &m.set {
        moon.push_str(&format!(", sets {}", at(s, zone)));
    }
    moon.push_str(&format!(
        "; up {} of the dark window, down {}",
        hours(m.up_hours),
        hours(m.down_hours)
    ));
    push_field(out, "Moon", &moon);
}

// ---------------------------------------------------------------------------
// dso-catalog
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct CatalogArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_catalog(a: &CatalogArgs) -> Result<u8> {
    let objects = call(native::dso_catalog())?;
    if a.format.is_json() {
        emit_json(&json!({
            "objects": objects,
            "source": skyfix_starfield::dso::SOURCE,
        }))?;
        return Ok(exit::OK);
    }
    let mut out = format!("DEEP-SKY OBJECTS: {}\n\n", objects.len());
    let mut t = Table::new(&[
        ("id", Align::Left),
        ("name", Align::Left),
        ("type", Align::Left),
        ("con", Align::Left),
        ("RA J2000", Align::Right),
        ("Dec J2000", Align::Right),
        ("mag", Align::Right),
        ("size '", Align::Right),
    ]);
    for o in objects {
        t.row(vec![
            o.label.clone(),
            o.name.unwrap_or("").to_string(),
            words(&o.kind),
            o.constellation.to_string(),
            format!("{:.4}", o.ra_j2000_deg),
            format!("{:+.4}", o.dec_j2000_deg),
            opt_fixed(o.magnitude, 1),
            format!("{} x {}", o.major_arcmin, o.minor_arcmin),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(&mut out, skyfix_starfield::dso::SOURCE);
    report::emit(&out)?;
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// dso-list
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ListArgs {
    #[command(flatten)]
    pub site: OptionalSiteAir,
    #[command(flatten)]
    pub utc: UtcFlag,
    /// Keep only these categories (cluster, nebula, galaxy, other) or types
    /// (open_cluster, spiral_galaxy, ...), comma-separated. Default: all.
    #[arg(long = "kind", value_name = "KINDS", value_delimiter = ',')]
    pub kinds: Vec<String>,
    /// Keep only objects at least this bright (objects without a magnitude are kept).
    #[arg(
        long = "max-magnitude",
        value_name = "MAG",
        allow_negative_numbers = true
    )]
    pub max_magnitude: Option<f64>,
    /// Keep only objects above the horizon now (with --lat --lon).
    #[arg(long = "above-horizon", requires = "lat")]
    pub above_horizon: bool,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `dso_list`'s object: `index` an Int32Array, the rest Float64Arrays; the horizon
/// arrays `null` without an observer.
pub fn positions_json(p: &DsoPositions) -> Value {
    let (alt, az, app) = match &p.horizon {
        Some([a, z, h]) => (f64s(a), f64s(z), f64s(h)),
        None => (Value::Null, Value::Null, Value::Null),
    };
    json!({
        "jd_utc": p.jd_utc,
        "index": i32s(&p.index),
        "ra_deg": f64s(&p.ra_deg),
        "dec_deg": f64s(&p.dec_deg),
        "alt_deg": alt,
        "az_deg": az,
        "alt_apparent_deg": app,
    })
}

pub fn list_options(a: &ListArgs) -> String {
    let mut m = serde_json::Map::new();
    if !a.kinds.is_empty() {
        m.insert("kinds".into(), json!(a.kinds));
    }
    if let Some(v) = a.max_magnitude {
        m.insert("max_magnitude".into(), json!(v));
    }
    if a.above_horizon {
        m.insert("above_horizon".into(), json!(true));
    }
    if m.is_empty() {
        String::new()
    } else {
        Value::Object(m).to_string()
    }
}

pub fn run_list(a: &ListArgs) -> Result<u8> {
    let p = call(native::dso_list(
        &a.site.json(),
        a.utc.utc,
        &list_options(a),
    ))?;
    if a.format.is_json() {
        emit_json(&positions_json(&p))?;
        return Ok(exit::OK);
    }
    let catalog = call(native::dso_catalog())?;
    let mut out = String::from("DEEP-SKY OBJECTS AT AN INSTANT\n");
    if let Some(s) = a.site.site() {
        push_field(&mut out, "Observer", &observer_line(&s));
    }
    push_field(&mut out, "Time", &text::utc(p.jd_utc));
    out.push('\n');
    let mut cols = vec![
        ("id", Align::Left),
        ("name", Align::Left),
        ("mag", Align::Right),
        ("RA", Align::Right),
        ("Dec", Align::Right),
    ];
    if p.horizon.is_some() {
        cols.extend([("app. alt", Align::Right), ("Az", Align::Right)]);
    }
    let mut t = Table::new(&cols);
    for (k, &i) in p.index.iter().enumerate() {
        let o = &catalog[i as usize];
        let mut row = vec![
            o.label.clone(),
            o.name.unwrap_or("").to_string(),
            opt_fixed(o.magnitude, 1),
            format!("{:.4}", p.ra_deg[k]),
            format!("{:+.4}", p.dec_deg[k]),
        ];
        if let Some([_, az, app]) = &p.horizon {
            row.extend([text::alt(app[k]), text::dm360(az[k])]);
        }
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  no object passes the filter\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "{} objects. RA and Dec are apparent geocentric of date, degrees (the frame of \
             skyfix sky); app. alt is the topocentric apparent altitude with the display \
             refraction, Az true.",
            p.index.len()
        ),
    );
    report::emit(&out)?;
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// dso
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct DsoArgs {
    /// The object: M31, NGC 869, "m 31", Andromeda's cross identifications (NGC 224).
    #[arg(value_name = "ID")]
    pub id: String,
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub utc: UtcFlag,
    #[command(flatten)]
    pub conditions: ConditionsArgs,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_dso(a: &DsoArgs) -> Result<u8> {
    let v = call(native::dso_visibility(
        &a.id,
        &a.site.json(),
        a.utc.utc,
        &a.conditions.json(),
    ))?;
    if a.format.is_json() {
        emit_json(&v)?;
    } else {
        let zone = a.zone.resolve(a.site.site.position.lon);
        report::emit(&render_dso(&v, a, &zone))?;
    }
    Ok(exit::OK)
}

fn render_dso(v: &DsoVisibility, a: &DsoArgs, zone: &ResolvedZone) -> String {
    let o = v.object;
    let mut out = format!(
        "{}{}\n",
        o.label,
        o.name.map(|n| format!(", {n}")).unwrap_or_default()
    );
    push_field(
        &mut out,
        "Object",
        &format!(
            "{} in {}, magnitude {}, {}' x {}'; RA {:.4}, Dec {:+.4} (J2000). {}",
            words(&o.kind),
            o.constellation,
            opt_fixed(o.magnitude, 1),
            o.major_arcmin,
            o.minor_arcmin,
            o.ra_j2000_deg,
            o.dec_j2000_deg,
            o.description
        ),
    );
    push_field(&mut out, "Observer", &observer_line(&a.site.site()));
    night_lines(&mut out, &v.night, zone);
    conditions_line(&mut out, &v.conditions);
    out.push('\n');
    let vis = &v.visibility;
    push_field(
        &mut out,
        "Best",
        &vis.best.as_ref().map_or_else(
            || "not above the horizon in the dark window".to_string(),
            |s| format!("{} (highest in the dark window)", sighting(s, zone)),
        ),
    );
    if let Some(t) = &vis.transit {
        push_field(&mut out, "Transit", &sighting(t, zone));
    }
    push_field(
        &mut out,
        "High",
        &format!(
            "{} above 20 deg in the dark window",
            hours(vis.hours_above_20)
        ),
    );
    if let Some(m) = &vis.moon {
        push_field(
            &mut out,
            "Moonlight",
            &format!(
                "the Moon {} deg away at altitude {}, brightening the sky there by {:.2} mag",
                text::fixed(m.separation_deg, 1),
                text::alt_inline(m.moon_alt_deg),
                m.brightening_mag
            ),
        );
    }
    push_field(
        &mut out,
        "Limit",
        &vis.limiting_mag.map_or_else(
            || "-".to_string(),
            |l| format!("stars to magnitude {l:.1} at the object at its best"),
        ),
    );
    push_field(
        &mut out,
        "See it",
        &vis.instrument.map_or_else(
            || "not in the dark window".to_string(),
            |i| format!("with {} (a rule of thumb)", instrument_words(i)),
        ),
    );
    out.push('\n');
    push_note(
        &mut out,
        "Altitudes are apparent (refracted), azimuths true with a compass word. The \
         instrument guide compares the object's magnitude, spread by its size, with the \
         limiting magnitude at it (EXPLORER_API.md, \"Deep sky\"): an estimate to argue \
         with. --format json has the altitude every 10 minutes of the night.",
    );
    out
}

// ---------------------------------------------------------------------------
// showers
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ShowersArgs {
    #[command(flatten)]
    pub year: YearFlag,
    #[command(flatten)]
    pub site: OptionalSiteAir,
    #[command(flatten)]
    pub conditions: ConditionsArgs,
    /// The zone times are shown in: utc (default), an offset, or nautical (with --lon).
    #[arg(long, value_name = "ZONE", default_value = "utc", value_parser = super::zone::parse_zone, allow_hyphen_values = true)]
    pub zone: super::zone::Zone,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_showers(a: &ShowersArgs) -> Result<u8> {
    let site = a.site.site();
    if site.is_none() && a.conditions.json() != "" {
        bail!(
            "--bortle, --nelm and --extinction describe an observer's sky: give --lat --lon \
             too, or leave them out"
        );
    }
    let zone = match (a.zone, site) {
        (super::zone::Zone::Nautical, None) => {
            bail!("--zone nautical needs the observer's longitude: give --lat --lon")
        }
        (z, s) => z.resolve(s.map_or(0.0, |s| s.lon_deg)),
    };
    let r = call(native::meteor_showers(
        f64::from(a.year.year),
        &a.site.json(),
        &a.conditions.json(),
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_showers(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn render_showers(r: &ShowerYear, a: &ShowersArgs, zone: &ResolvedZone) -> String {
    let mut out = format!("METEOR SHOWERS {}\n", r.year);
    if let Some(s) = a.site.site() {
        push_field(&mut out, "Observer", &observer_line(&s));
    }
    out.push('\n');
    let mut cols = vec![
        ("shower", Align::Left),
        ("code", Align::Left),
        ("peak", Align::Left),
        ("ZHR", Align::Right),
        ("active", Align::Left),
        ("Moon", Align::Right),
    ];
    if a.site.site().is_some() {
        cols.extend([("rate/h here", Align::Right), ("best", Align::Left)]);
    }
    let mut t = Table::new(&cols);
    for s in &r.showers {
        let day = |jd: f64| {
            text::local_datetime(jd, zone.offset_minutes)
                .split(' ')
                .next()
                .unwrap_or_default()
                .to_string()
        };
        let mut row = vec![
            s.shower.name.to_string(),
            s.shower.code.to_string(),
            text::local_datetime(s.peak.jd_utc, zone.offset_minutes)[..]
                .rsplit_once(':')
                .map_or_else(String::new, |(hm, _)| hm.to_string()),
            format!(
                "{}{}",
                s.shower.zhr,
                if s.shower.variable { " var" } else { "" }
            ),
            format!("{} to {}", day(s.start.jd_utc), day(s.end.jd_utc)),
            format!("{:.0}%", s.moon_illuminated_fraction * 100.0),
        ];
        if a.site.site().is_some() {
            match &s.at_site {
                Some(n) => row.extend([
                    format!("{:.1}", n.expected_rate_per_hour),
                    n.best
                        .as_ref()
                        .map_or_else(|| "-".to_string(), |b| sighting(b, zone)),
                ]),
                None => row.extend(["-".to_string(), "not active in the dark".to_string()]),
            }
        }
        t.row(row);
    }
    out.push_str(&t.render("  "));
    for e in &r.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.code, e.message));
    }
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "Times in {}. ZHR is the zenithal hourly rate at the peak (var: variable from year \
             to year); Moon is its illuminated fraction at the peak. rate/h here is the \
             expected rate at the best moment of the night nearest the peak: {} {}",
            zone.label, r.rate_model, r.source
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// milky-way
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct MilkyWayArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_milky_way(a: &MilkyWayArgs) -> Result<u8> {
    let o = call(native::milky_way_outline())?;
    if a.format.is_json() {
        let rings: Vec<Value> = o
            .rings
            .iter()
            .map(|r| {
                json!({
                    "level": r.level,
                    "ra_deg": f64s(&r.ra_deg),
                    "dec_deg": f64s(&r.dec_deg),
                })
            })
            .collect();
        emit_json(&json!({
            "levels": o.levels,
            "rings": rings,
            "source": skyfix_starfield::milkyway::SOURCE,
        }))?;
        return Ok(exit::OK);
    }
    let mut out = String::from("THE MILKY WAY'S OUTLINE\n\n");
    let mut t = Table::new(&[
        ("level", Align::Right),
        ("threshold MJy/sr", Align::Right),
        ("rings", Align::Right),
        ("points", Align::Right),
    ]);
    for (level, threshold) in o.levels.iter().enumerate() {
        let rings: Vec<_> = o
            .rings
            .iter()
            .filter(|r| usize::from(r.level) == level)
            .collect();
        t.row(vec![
            level.to_string(),
            format!("{threshold:.2}"),
            rings.len().to_string(),
            rings
                .iter()
                .map(|r| r.ra_deg.len())
                .sum::<usize>()
                .to_string(),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "Closed, oriented rings of RA and Dec (J2000, degrees) at four brightness levels; \
         --format json has every point, for drawing. Each step between points is a \
         great-circle arc.",
    );
    push_note(&mut out, skyfix_starfield::milkyway::SOURCE);
    report::emit(&out)?;
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct SearchArgs {
    /// What to look for: a star (Sirius, alpha CMa, HR 2491), an object (M31, Andromeda),
    /// a constellation, a planet or a meteor shower.
    #[arg(value_name = "QUERY")]
    pub query: String,
    #[command(flatten)]
    pub site: OptionalSiteAir,
    /// Place the hits at this instant (needed with --lat --lon).
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: Option<f64>,
    /// How many hits, 1 to 100. Default 20.
    #[arg(long, value_name = "N")]
    pub limit: Option<u32>,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_search(a: &SearchArgs) -> Result<u8> {
    let r = call(native::sky_search(&a.query, &a.site.json(), a.utc, a.limit))?;
    if a.format.is_json() {
        emit_json(&r)?;
        return Ok(exit::OK);
    }
    let mut out = format!("SEARCH {:?}\n", r.query);
    if let Some(jd) = a.utc {
        push_field(&mut out, "Time", &text::utc(jd));
    }
    out.push('\n');
    let mut cols = vec![
        ("kind", Align::Left),
        ("label", Align::Left),
        ("detail", Align::Left),
        ("score", Align::Right),
    ];
    if a.utc.is_some() {
        cols.extend([("RA", Align::Right), ("Dec", Align::Right)]);
    }
    if a.site.site().is_some() {
        cols.extend([("app. alt", Align::Right), ("Az", Align::Right)]);
    }
    let mut t = Table::new(&cols);
    for h in &r.hits {
        let mut row = vec![
            h.kind.replace('_', " "),
            h.label.clone(),
            h.detail.clone(),
            h.score.to_string(),
        ];
        if a.utc.is_some() {
            row.extend([opt_fixed(h.ra_deg, 4), opt_fixed(h.dec_deg, 4)]);
        }
        if a.site.site().is_some() {
            row.extend([
                h.alt_apparent_deg
                    .map_or_else(|| "-".to_string(), text::alt),
                h.az_deg.map_or_else(|| "-".to_string(), text::dm360),
            ]);
        }
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  nothing matches\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        "Best first: score 100 an exact match, 80 a prefix, 60 every word, 40 contained. RA \
         and Dec are apparent geocentric of date, degrees; app. alt the apparent altitude, Az \
         true.",
    );
    report::emit(&out)?;
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// tonight
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct TonightArgs {
    #[command(flatten)]
    pub site: SiteAirArgs,
    #[command(flatten)]
    pub utc: UtcFlag,
    #[command(flatten)]
    pub conditions: ConditionsArgs,
    /// How many deep-sky objects, 1 to 60. Default 12.
    #[arg(long, value_name = "N")]
    pub limit: Option<usize>,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `tonight`'s options: the conditions and the limit.
pub fn tonight_options(a: &TonightArgs) -> String {
    let mut m = match serde_json::from_str::<Value>(&a.conditions.json()) {
        Ok(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    if let Some(l) = a.limit {
        m.insert("limit".into(), json!(l));
    }
    if m.is_empty() {
        String::new()
    } else {
        Value::Object(m).to_string()
    }
}

pub fn run_tonight(a: &TonightArgs) -> Result<u8> {
    let r = call(native::tonight(
        &a.site.json(),
        a.utc.utc,
        &tonight_options(a),
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        let zone = a.zone.resolve(a.site.site.position.lon);
        report::emit(&render_tonight(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

/// The summary with its `{jd:2461308.517173}` tokens written as times in the zone, as the
/// interface does (`formatSummaryTimes`).
pub fn fill_times(summary: &str, zone: &ResolvedZone) -> String {
    let mut out = String::new();
    let mut rest = summary;
    while let Some(i) = rest.find("{jd:") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 4..];
        match after.find('}') {
            Some(j) => {
                match after[..j].parse::<f64>() {
                    Ok(jd) => out.push_str(&text::clock(jd, zone.offset_minutes)[..5]),
                    Err(_) => out.push_str(&rest[i..i + 5 + j]),
                }
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn render_tonight(r: &Tonight, a: &TonightArgs, zone: &ResolvedZone) -> String {
    let mut out = String::from("TONIGHT\n");
    push_field(&mut out, "Observer", &observer_line(&a.site.site()));
    night_lines(&mut out, &r.night, zone);
    conditions_line(&mut out, &r.conditions);
    out.push('\n');
    push_note(&mut out, &fill_times(&r.summary, zone));
    out.push_str("\nPlanets\n");
    let mut t = Table::new(&[
        ("planet", Align::Left),
        ("mag", Align::Right),
        ("best", Align::Left),
        ("up", Align::Left),
        ("", Align::Left),
    ]);
    for p in &r.planets {
        t.row(vec![
            p.body.to_string(),
            opt_fixed(p.magnitude, 1),
            p.best
                .as_ref()
                .map_or_else(|| "-".to_string(), |b| sighting(b, zone)),
            match (&p.up_from, &p.up_until) {
                (Some(f), Some(u)) => format!("{} to {}", at(f, zone), at(u, zone)),
                _ => "-".to_string(),
            },
            p.reason.clone(),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push_str("\nDeep sky, best first\n");
    let mut t = Table::new(&[
        ("object", Align::Left),
        ("type", Align::Left),
        ("mag", Align::Right),
        ("best", Align::Left),
        ("h > 20", Align::Right),
        ("with", Align::Left),
        ("score", Align::Right),
    ]);
    for d in &r.deep_sky {
        t.row(vec![
            format!(
                "{}{}",
                d.label,
                d.name.map(|n| format!(" {n}")).unwrap_or_default()
            ),
            words(&d.kind),
            opt_fixed(d.magnitude, 1),
            sighting(&d.best, zone),
            format!("{:.1}", d.hours_above_20),
            words(&d.instrument),
            format!("{:.1}", d.score),
        ]);
    }
    if t.is_empty() {
        out.push_str("  none above 20 deg in the dark window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    if !r.showers.is_empty() {
        out.push_str("\nMeteor showers\n");
        let mut t = Table::new(&[
            ("shower", Align::Left),
            ("rate/h", Align::Right),
            ("best", Align::Left),
            ("", Align::Left),
        ]);
        for s in &r.showers {
            t.row(vec![
                s.name.to_string(),
                format!("{:.1}", s.expected_rate_per_hour),
                s.best
                    .as_ref()
                    .map_or_else(|| "-".to_string(), |b| sighting(b, zone)),
                s.reason.clone(),
            ]);
        }
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_field(
        &mut out,
        "Milky Way",
        &format!(
            "{} (the core {})",
            r.milky_way_core.reason,
            r.milky_way_core.best.as_ref().map_or_else(
                || "is not up in the dark".to_string(),
                |b| format!("at its best {}", sighting(b, zone))
            )
        ),
    );
    for e in &r.errors {
        out.push_str(&format!("  not computed: {e}\n"));
    }
    out.push('\n');
    for n in &r.notes {
        push_note(&mut out, n);
    }
    out
}

// ---------------------------------------------------------------------------
// extinction
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ExtinctionArgs {
    #[command(flatten)]
    pub conditions: ConditionsArgs,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_extinction(a: &ExtinctionArgs) -> Result<u8> {
    let t = call(native::extinction_table(&a.conditions.json()))?;
    if a.format.is_json() {
        emit_json(&json!({
            "conditions": t.conditions,
            "alt_deg": f64s(&t.alt_deg),
            "airmass": f64s(&t.airmass),
            "extinction_mag": f64s(&t.extinction_mag),
            "limiting_mag": f64s(&t.limiting_mag),
            "model": t.model,
        }))?;
        return Ok(exit::OK);
    }
    let mut out = String::from("EXTINCTION AND THE LIMITING MAGNITUDE\n");
    conditions_line(&mut out, &t.conditions);
    out.push('\n');
    let mut tab = Table::new(&[
        ("app. alt", Align::Right),
        ("air mass", Align::Right),
        ("extinction mag", Align::Right),
        ("limiting mag", Align::Right),
    ]);
    for i in 0..t.alt_deg.len() {
        let h = t.alt_deg[i];
        if h < 10.0 || h % 5.0 == 0.0 {
            tab.row(vec![
                format!("{h:.0}"),
                format!("{:.2}", t.airmass[i]),
                format!("{:.2}", t.extinction_mag[i]),
                format!("{:.2}", t.limiting_mag[i]),
            ]);
        }
    }
    out.push_str(&tab.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "Every degree to 10, then every 5; --format json has every degree. {}",
            t.model
        ),
    );
    report::emit(&out)?;
    Ok(exit::OK)
}
