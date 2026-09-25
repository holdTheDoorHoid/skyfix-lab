//! Planet detail: `galilean-moons`, `galilean-events`, `saturn-rings`, `planet-disc`,
//! `transits`, `conjunctions`, `stations`, `earth-apsides` and `orbit`. OWNER: cli3
//! agent.
//!
//! Engines: `skyfix_almanac::{satellites, rings, discs, transits, conjunctions,
//! earth_apsides, orbits}` through the WASM adapter's `skyfix_wasm::planetdetail::native`;
//! wire format EXPLORER_API.md "Expansion programme — planet detail"; definitions
//! CONVENTIONS 13.13. `sample_custom_bodies` hands the page typed arrays; `orbit --from
//! --to` rebuilds its object key for key.

use std::io::Read;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use skyfix_almanac::conjunctions::{ConjunctionList, StationList};
use skyfix_almanac::discs::PlanetDisc;
use skyfix_almanac::earth_apsides::EarthApsides;
use skyfix_almanac::rings::SaturnRings;
use skyfix_almanac::satellites::{GalileanEvents, GalileanMoons};
use skyfix_almanac::transits::TransitList;
use skyfix_wasm::planetdetail::native::{self, CustomBodyStates};

use super::args::{FormatArgs, parse_instant};
use super::sun::{WindowFlags, YearFlag};
use super::text;
use super::wire::{
    Align, OptionalSite, OptionalSiteAir, Table, call, emit_json, f64s, observer_line, opt_fixed,
    push_field, push_note, words,
};
use super::zone::{ResolvedZone, Zone, parse_zone};
use crate::exit;
use crate::report;

/// `--utc`, required.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct Instant {
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
}

/// `--zone` for a list with no observer: UTC or a fixed offset.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct ListZone {
    /// The zone a date is taken in and times are shown in: `utc` (default) or a fixed
    /// offset such as -05:00.
    #[arg(long, value_name = "ZONE", default_value = "utc", value_parser = parse_zone, allow_hyphen_values = true)]
    pub zone: Zone,
}

impl ListZone {
    fn resolve(&self) -> Result<ResolvedZone> {
        if self.zone == Zone::Nautical {
            bail!(
                "--zone nautical needs a longitude, and this list has no observer: give the \
                 zone as an offset such as -05:00"
            );
        }
        Ok(self.zone.resolve(0.0))
    }
}

fn cells(jd: f64, zone: &ResolvedZone) -> Vec<String> {
    super::wire::when_cells(jd, zone)
}

fn headers(zone: &ResolvedZone) -> Vec<(&'static str, Align)> {
    super::wire::when_headers(zone)
}

fn window_line(out: &mut String, s: f64, e: f64, truncated: bool, zone: &ResolvedZone) {
    push_field(
        out,
        "Window",
        &format!(
            "{} to {}{}{}",
            text::utc(s),
            text::utc(e),
            super::wire::shown_in(zone),
            if truncated {
                ", clipped to the coverage"
            } else {
                ""
            }
        ),
    );
}

// ---------------------------------------------------------------------------
// galilean-moons
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct MoonsArgs {
    #[command(flatten)]
    pub at: Instant,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_moons(a: &MoonsArgs) -> Result<u8> {
    let r = call(native::galilean_moons(a.at.utc))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_moons(&r))?;
    }
    Ok(exit::OK)
}

fn render_moons(r: &GalileanMoons) -> String {
    let mut out = String::from("JUPITER'S GALILEAN MOONS\n");
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    let j = &r.jupiter;
    push_field(
        &mut out,
        "Jupiter",
        &format!(
            "{:.4} au away (light {:.0} s), disc {:.2}\" x {:.2}\", pole at PA {:.2} deg, \
             {:.1} deg from the Sun",
            j.distance_au,
            j.light_time_s,
            2.0 * j.equatorial_radius_arcsec,
            2.0 * j.polar_radius_arcsec,
            j.pole_position_angle_deg,
            j.elongation_deg
        ),
    );
    out.push('\n');
    let mut t = Table::new(&[
        ("moon", Align::Left),
        ("x Rj", Align::Right),
        ("y Rj", Align::Right),
        ("east \"", Align::Right),
        ("north \"", Align::Right),
        ("", Align::Left),
    ]);
    for m in &r.moons {
        let mut state = vec![if m.in_front { "in front" } else { "behind" }];
        if m.in_transit {
            state.push("crossing the disc");
        }
        if m.occulted {
            state.push("hidden behind Jupiter");
        }
        if m.eclipsed {
            state.push("in Jupiter's shadow");
        }
        if m.shadow_on_disc {
            state.push("its shadow on the disc");
        }
        t.row(vec![
            m.name.clone(),
            format!("{:+.3}", m.x_rj),
            format!("{:+.3}", m.y_rj),
            format!("{:+.1}", m.offset_east_arcsec),
            format!("{:+.1}", m.offset_north_arcsec),
            state.join(", "),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "x is along Jupiter's equator, positive WEST, and y toward its north pole, in \
             Jupiter's equatorial radius (Rj): draw the view from these. east and north are \
             the same offsets in arcseconds of sky. {} (worst offset against JPL {}\").",
            r.theory, r.accuracy_arcsec
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// galilean-events
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct MoonEventsArgs {
    #[command(flatten)]
    pub window: WindowFlags,
    #[command(flatten)]
    pub zone: ListZone,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_moon_events(a: &MoonEventsArgs) -> Result<u8> {
    let zone = a.zone.resolve()?;
    let (s, e) = a.window.resolve(&zone)?;
    let r = call(native::galilean_events(s, e))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_moon_events(&r, &zone))?;
    }
    Ok(exit::OK)
}

fn render_moon_events(r: &GalileanEvents, zone: &ResolvedZone) -> String {
    let mut out = String::from("JUPITER'S MOONS: TRANSITS, SHADOWS, OCCULTATIONS, ECLIPSES\n");
    window_line(&mut out, r.jd_start, r.jd_end, r.truncated, zone);
    out.push('\n');
    let mut cols = vec![("moon", Align::Left), ("event", Align::Left)];
    cols.extend(headers(zone));
    cols.extend([
        ("ends", Align::Left),
        ("seen", Align::Left),
        ("from Sun", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for p in &r.phenomena {
        let mut row = vec![p.moon.clone(), words(&p.kind)];
        row.extend(cells(p.start.jd_utc, zone));
        row.push(text::clock(p.end.jd_utc, zone.offset_minutes));
        row.push(
            match (p.start.observable, p.end.observable) {
                (true, true) => "both",
                (true, false) => "start",
                (false, true) => "end",
                (false, false) => "neither",
            }
            .to_string(),
        );
        row.push(format!("{:.0}", p.jupiter_elongation_deg));
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "seen: whether the Earth can see the start and the end happen (a moon can go into \
             eclipse and then behind the planet). from Sun: Jupiter's elongation, degrees; \
             nothing is observable within about 15. {}",
            r.conventions
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// saturn-rings
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct RingsArgs {
    #[command(flatten)]
    pub at: Instant,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_rings(a: &RingsArgs) -> Result<u8> {
    let r = call(native::saturn_rings(a.at.utc))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_rings(&r))?;
    }
    Ok(exit::OK)
}

fn render_rings(r: &SaturnRings) -> String {
    let mut out = String::from("SATURN'S RINGS\n");
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    push_field(
        &mut out,
        "Tilt",
        &format!(
            "B = {:+.4} deg (the Earth's latitude on Saturn over the ring plane: the {} face \
             is seen), B' = {:+.4} deg (the Sun's), dU = {:.4} deg; {}",
            r.earth_latitude_deg,
            if r.north_face_visible {
                "north"
            } else {
                "south"
            },
            r.sun_latitude_deg,
            r.delta_u_deg,
            if r.lit_face_visible {
                "the lit face is toward us"
            } else {
                "we see the UNLIT face"
            }
        ),
    );
    push_field(
        &mut out,
        "Rings",
        &format!(
            "{:.3}\" x {:.3}\" (outer edge of ring A), the northern semi-minor axis at PA \
             {:.2} deg",
            r.major_axis_arcsec, r.minor_axis_arcsec, r.position_angle_deg
        ),
    );
    push_field(
        &mut out,
        "Saturn",
        &format!(
            "{:.4} au away ({:.4} au from the Sun), magnitude {} (Mallama & Hilton 2018; \
             {:.2} by the 1984 formula)",
            r.distance_au,
            r.heliocentric_distance_au,
            opt_fixed(r.magnitude, 2),
            r.magnitude_aa1984
        ),
    );
    out.push('\n');
    let mut t = Table::new(&[
        ("edge", Align::Left),
        ("radius km", Align::Right),
        ("major \"", Align::Right),
        ("minor \"", Align::Right),
    ]);
    for e in &r.edges {
        t.row(vec![
            e.name.clone(),
            format!("{:.0}", e.radius_km),
            format!("{:.3}", e.major_axis_arcsec),
            format!("{:.3}", e.minor_axis_arcsec),
        ]);
    }
    out.push_str(&t.render("  "));
    out
}

// ---------------------------------------------------------------------------
// planet-disc
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct DiscArgs {
    /// The planet: Mercury, Venus, Mars, Jupiter, Saturn, Uranus or Neptune.
    #[arg(long, value_name = "PLANET")]
    pub body: String,
    #[command(flatten)]
    pub at: Instant,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_disc(a: &DiscArgs) -> Result<u8> {
    let r = call(native::planet_disc(&a.body, a.at.utc))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_disc(&r))?;
    }
    Ok(exit::OK)
}

fn render_disc(r: &PlanetDisc) -> String {
    let mut out = format!("{}'S DISC\n", r.body.to_uppercase());
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    push_field(
        &mut out,
        "Size",
        &format!(
            "{:.3}\" x {:.3}\" (equatorial x polar, as seen), {:.6} au away (light {:.1} s)",
            r.equatorial_diameter_arcsec, r.polar_diameter_arcsec, r.distance_au, r.light_time_s
        ),
    );
    push_field(
        &mut out,
        "Phase",
        &format!(
            "{:.2}% lit, phase angle {:.3} deg, defect {:.3}\", bright limb at PA {:.2} deg",
            r.illuminated_fraction * 100.0,
            r.phase_angle_deg,
            r.defect_of_illumination_arcsec,
            r.bright_limb_angle_deg
        ),
    );
    push_field(
        &mut out,
        "Pole",
        &format!("north pole at PA {:.3} deg", r.pole_position_angle_deg),
    );
    push_field(
        &mut out,
        "Earth over",
        &format!(
            "latitude {:+.3} (planetographic {:+.3}), longitude {:.3} ({} positive)",
            r.sub_earth_lat_deg,
            r.sub_earth_lat_graphic_deg,
            r.sub_earth_lon_deg,
            r.longitude_positive
        ),
    );
    push_field(
        &mut out,
        "Sun over",
        &format!(
            "latitude {:+.3} (planetographic {:+.3}), longitude {:.3}",
            r.sub_solar_lat_deg, r.sub_solar_lat_graphic_deg, r.sub_solar_lon_deg
        ),
    );
    let cms: Vec<String> = r
        .central_meridians
        .iter()
        .map(|c| format!("System {} {:.3}", c.system, c.longitude_deg))
        .collect();
    push_field(
        &mut out,
        "Central",
        &format!("meridian: {}", cms.join(", ")),
    );
    push_field(&mut out, "Magnitude", &opt_fixed(r.magnitude, 2));
    out.push('\n');
    for n in &r.notes {
        push_note(&mut out, n);
    }
    push_note(&mut out, &format!("Rotation: {}.", r.rotation_model));
    out
}

// ---------------------------------------------------------------------------
// transits
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct TransitsArgs {
    #[command(flatten)]
    pub window: WindowFlags,
    #[command(flatten)]
    pub site: OptionalSite,
    #[command(flatten)]
    pub zone: ListZone,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_transits(a: &TransitsArgs) -> Result<u8> {
    let zone = a.zone.resolve()?;
    let (s, e) = a.window.resolve(&zone)?;
    let r = call(native::transits(s, e, &a.site.json()))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_transits(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn render_transits(r: &TransitList, a: &TransitsArgs, zone: &ResolvedZone) -> String {
    let mut out = String::from("TRANSITS OF MERCURY AND VENUS\n");
    window_line(&mut out, r.jd_start, r.jd_end, r.truncated, zone);
    if let Some(s) = a.site.site() {
        push_field(&mut out, "Observer", &observer_line(&s));
    }
    if r.transits.is_empty() {
        out.push_str("\n  none in this window\n");
    }
    for tr in &r.transits {
        out.push_str(&format!(
            "\n{}  {}: least separation {:.1}\" (the Sun's radius {:.1}\"), {}{}\n",
            tr.id,
            tr.planet,
            tr.min_separation_arcsec,
            tr.sun_semidiameter_arcsec,
            text::duration_s(tr.duration_s),
            if tr.grazing { ", grazing" } else { "" }
        ));
        let mut cols = vec![("contact", Align::Left)];
        cols.extend(headers(zone));
        cols.extend([("PA", Align::Right), ("sep \"", Align::Right)]);
        let mut t = Table::new(&cols);
        for c in &tr.contacts {
            let mut row = vec![c.kind.clone()];
            row.extend(cells(c.jd_utc, zone));
            row.extend([
                format!("{:.1}", c.position_angle_deg),
                format!("{:.1}", c.separation_arcsec),
            ]);
            t.row(row);
        }
        out.push_str("  from the Earth's centre\n");
        out.push_str(&t.render("  "));
        if let Some(l) = &tr.local {
            out.push_str(&format!(
                "  from here: {}\n",
                l.visibility.replace('_', " ")
            ));
            let mut cols = vec![("event", Align::Left)];
            cols.extend(headers(zone));
            cols.extend([
                ("Sun alt", Align::Right),
                ("Az", Align::Right),
                ("PA", Align::Right),
                ("seen", Align::Left),
            ]);
            let mut t = Table::new(&cols);
            for ev in &l.events {
                let mut row = vec![ev.kind.clone()];
                row.extend(cells(ev.jd_utc, zone));
                row.extend([
                    text::alt(ev.sun_alt_deg),
                    text::dm360(ev.sun_az_deg),
                    format!("{:.1}", ev.position_angle_deg),
                    if ev.visible { "yes" } else { "no" }.to_string(),
                ]);
                t.row(row);
            }
            out.push_str(&t.render("  "));
        }
    }
    out.push('\n');
    push_note(&mut out, &r.conventions);
    out
}

// ---------------------------------------------------------------------------
// conjunctions
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ConjunctionsArgs {
    #[command(flatten)]
    pub window: WindowFlags,
    /// The planets taken into account, comma-separated. Default all seven.
    #[arg(long = "planets", value_name = "NAMES", value_delimiter = ',')]
    pub planets: Vec<String>,
    /// Leave the Moon out.
    #[arg(long = "no-moon")]
    pub no_moon: bool,
    /// Stars, comma-separated navigational star names; `none` for none. Default:
    /// Aldebaran, Regulus, Spica, Antares.
    #[arg(long = "stars", value_name = "NAMES", value_delimiter = ',')]
    pub stars: Vec<String>,
    /// The largest separation reported, degrees (0.1 to 20). Default 5.
    #[arg(long = "max-separation", value_name = "DEG")]
    pub max_separation: Option<f64>,
    /// Below this elongation from the Sun a pair is not visible, degrees. Default 15.
    #[arg(long = "min-sun-elongation", value_name = "DEG")]
    pub min_sun_elongation: Option<f64>,
    #[command(flatten)]
    pub site: OptionalSiteAir,
    #[command(flatten)]
    pub zone: ListZone,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// The options document, with only the keys the flags set.
pub fn conjunction_options(a: &ConjunctionsArgs) -> String {
    let mut m = serde_json::Map::new();
    if !a.planets.is_empty() {
        m.insert("planets".into(), json!(a.planets));
    }
    if a.no_moon {
        m.insert("moon".into(), json!(false));
    }
    if !a.stars.is_empty() {
        let stars: Vec<&String> = a
            .stars
            .iter()
            .filter(|s| !s.eq_ignore_ascii_case("none"))
            .collect();
        m.insert("stars".into(), json!(stars));
    }
    if let Some(v) = a.max_separation {
        m.insert("max_separation_deg".into(), json!(v));
    }
    if let Some(v) = a.min_sun_elongation {
        m.insert("min_sun_elongation_deg".into(), json!(v));
    }
    if let Some(s) = a.site.site() {
        m.insert("observer".into(), json!(s));
    }
    if m.is_empty() {
        String::new()
    } else {
        Value::Object(m).to_string()
    }
}

pub fn run_conjunctions(a: &ConjunctionsArgs) -> Result<u8> {
    let zone = a.zone.resolve()?;
    let (s, e) = a.window.resolve(&zone)?;
    let r = call(native::conjunctions(s, e, &conjunction_options(a)))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_conjunctions(&r, a, &zone))?;
    }
    Ok(exit::OK)
}

fn render_conjunctions(r: &ConjunctionList, a: &ConjunctionsArgs, zone: &ResolvedZone) -> String {
    let mut out = String::from("CONJUNCTIONS\n");
    window_line(&mut out, r.jd_start, r.jd_end, r.truncated, zone);
    let local = a.site.site();
    if let Some(s) = &local {
        push_field(&mut out, "Observer", &observer_line(s));
    }
    out.push('\n');
    let mut cols = headers(zone);
    cols.extend([
        ("pair", Align::Left),
        ("sep deg", Align::Right),
        ("PA", Align::Right),
        ("from Sun", Align::Right),
        ("mags", Align::Left),
    ]);
    if local.is_some() {
        cols.push(("best seen here", Align::Left));
    } else {
        cols.push(("", Align::Left));
    }
    let mut t = Table::new(&cols);
    for c in &r.conjunctions {
        let mut row = cells(c.jd_utc, zone);
        row.extend([
            format!("{} - {}", c.body, c.other),
            format!("{:.3}", c.separation_deg),
            format!("{:.0}", c.position_angle_deg),
            format!("{:.0}", c.body_elongation_deg),
            format!(
                "{} / {}",
                opt_fixed(c.body_magnitude, 1),
                opt_fixed(c.other_magnitude, 1)
            ),
        ]);
        let tail = match (&c.local, c.visible) {
            (Some(l), _) => match &l.best {
                Some(b) => format!(
                    "{} {} / {}",
                    text::local_datetime(b.jd_utc, zone.offset_minutes)
                        .rsplit_once(':')
                        .map_or_else(String::new, |(hm, _)| hm.to_string()),
                    text::alt_inline(b.body_alt_deg),
                    text::alt_inline(b.other_alt_deg)
                ),
                None => "not in a dark sky within 12 h".to_string(),
            },
            (None, true) => String::new(),
            (None, false) => "too near the Sun".to_string(),
        };
        row.push(tail);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        "Closest approaches in apparent separation from the Earth's centre (CONVENTIONS \
         13.13). PA is the first body seen from the second, north through east; from Sun the \
         first body's elongation, degrees. With an observer, best is the moment within 12 \
         hours when the lower of the two stands highest with the Sun below -6 deg, and the \
         two apparent altitudes then.",
    );
    out
}

// ---------------------------------------------------------------------------
// stations
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct StationsArgs {
    #[command(flatten)]
    pub window: WindowFlags,
    #[command(flatten)]
    pub zone: ListZone,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_stations(a: &StationsArgs) -> Result<u8> {
    let zone = a.zone.resolve()?;
    let (s, e) = a.window.resolve(&zone)?;
    let r = call(native::stations(s, e))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_stations(&r, &zone))?;
    }
    Ok(exit::OK)
}

fn render_stations(r: &StationList, zone: &ResolvedZone) -> String {
    let mut out = String::from("PLANETARY STATIONS\n");
    window_line(&mut out, r.jd_start, r.jd_end, r.truncated, zone);
    out.push('\n');
    let mut cols = headers(zone);
    cols.extend([
        ("planet", Align::Left),
        ("", Align::Left),
        ("in", Align::Left),
        ("at deg", Align::Right),
        ("from Sun", Align::Right),
        ("mag", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for s in &r.stations {
        let mut row = cells(s.jd_utc, zone);
        row.extend([
            s.body.clone(),
            words(&s.kind),
            words(&s.coordinate),
            format!("{:.4}", s.angle_deg),
            format!("{:.1}", s.elongation_deg),
            opt_fixed(s.magnitude, 2),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "Each station twice: in ecliptic longitude (the definition of retrograde motion, \
             which the explorer shows: {}) and in right ascension of date. at deg is the \
             coordinate's value at the station.",
            words(&r.ui_coordinate)
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// earth-apsides
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct EarthApsidesArgs {
    #[command(flatten)]
    pub year: YearFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_earth_apsides(a: &EarthApsidesArgs) -> Result<u8> {
    let r = call(native::earth_apsides(f64::from(a.year.year)))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_earth_apsides(&r))?;
    }
    Ok(exit::OK)
}

fn render_earth_apsides(r: &EarthApsides) -> String {
    let mut out = format!("THE EARTH'S PERIHELION AND APHELION {}\n\n", r.year);
    let mut t = Table::new(&[
        ("UTC", Align::Left),
        ("", Align::Left),
        ("au", Align::Right),
        ("km", Align::Right),
    ]);
    for e in &r.events {
        t.row(vec![
            text::utc(e.jd_utc),
            words(&e.kind),
            format!("{:.6}", e.distance_au),
            format!("{:.0}", e.distance_km),
        ]);
    }
    out.push_str(&t.render("  "));
    out
}

// ---------------------------------------------------------------------------
// orbit
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct OrbitArgs {
    /// Orbital elements: lines in the Minor Planet Center's formats (MPCORB, or the comet
    /// format of CometEls.txt), or JSON; `-` reads standard input.
    #[arg(value_name = "FILE")]
    pub file: String,
    #[command(flatten)]
    pub site: OptionalSiteAir,
    /// Where each body is at this instant (with --lat --lon).
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true, requires = "lat", conflicts_with = "from")]
    pub utc: Option<f64>,
    /// Sample each body's track from this instant (with --lat --lon, --to).
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true, requires_all = ["lat", "to"])]
    pub from: Option<f64>,
    /// ... to this one.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true, requires = "from")]
    pub to: Option<f64>,
    /// Minutes between samples. Default 60.
    #[arg(long, value_name = "MIN", default_value_t = 60.0, requires = "from")]
    pub step: f64,
    #[command(flatten)]
    pub format: FormatArgs,
}

fn read_text(file: &str) -> Result<String> {
    if file == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .context("reading the elements from standard input")?;
        Ok(s)
    } else {
        std::fs::read_to_string(file).with_context(|| format!("reading {file}"))
    }
}

pub fn run_orbit(a: &OrbitArgs) -> Result<u8> {
    let elements = call(native::parse_orbits(&read_text(&a.file)?))?;
    let site_json = a.site.json();
    match (a.site.site(), a.utc, a.from, a.to) {
        (Some(site), Some(jd), _, _) => {
            let elements_json = serde_json::to_string(&elements)?;
            let r = call(native::custom_body_states(&site_json, jd, &elements_json))?;
            if a.format.is_json() {
                emit_json(&r)?;
            } else {
                report::emit(&render_states(&r, &site))?;
            }
        }
        (Some(site), None, Some(s), Some(e)) => {
            let elements_json = serde_json::to_string(&elements)?;
            let (times, bodies, errors) = call(native::sample_custom_bodies(
                &site_json,
                &elements_json,
                s,
                e,
                a.step,
            ))?;
            if a.format.is_json() {
                let bodies: Vec<Value> = bodies
                    .iter()
                    .map(|b| {
                        json!({
                            "body": b.body,
                            "alt_deg": f64s(&b.alt_deg),
                            "alt_apparent_deg": f64s(&b.alt_apparent_deg),
                            "az_deg": f64s(&b.az_deg),
                            "gha_deg": f64s(&b.gha_deg),
                            "dec_deg": f64s(&b.dec_deg),
                        })
                    })
                    .collect();
                emit_json(&json!({
                    "jd_utc": f64s(&times),
                    "bodies": bodies,
                    "errors": errors,
                }))?;
            } else {
                let mut out = String::from("CUSTOM BODIES: TRACKS\n");
                push_field(&mut out, "Observer", &observer_line(&site));
                out.push('\n');
                for b in &bodies {
                    out.push_str(&format!("{}\n", b.body));
                    let mut t = Table::new(&[
                        ("UTC", Align::Left),
                        ("app. alt", Align::Right),
                        ("Az", Align::Right),
                        ("GHA", Align::Right),
                        ("Dec", Align::Right),
                    ]);
                    for (k, jd) in times.iter().enumerate() {
                        t.row(vec![
                            text::utc(*jd),
                            text::alt(b.alt_apparent_deg[k]),
                            text::dm360(b.az_deg[k]),
                            text::dm360(b.gha_deg[k]),
                            text::dec(b.dec_deg[k]),
                        ]);
                    }
                    out.push_str(&t.render("  "));
                }
                for err in &errors {
                    out.push_str(&format!("  not computed: {}: {}\n", err.body, err.message));
                }
                report::emit(&out)?;
            }
        }
        (None, _, _, _) => {
            if a.format.is_json() {
                emit_json(&elements)?;
            } else {
                report::emit(&render_elements(&elements))?;
            }
        }
        (Some(_), None, _, _) => bail!(
            "with --lat --lon give --utc for where the bodies are, or --from --to for their \
             tracks"
        ),
    }
    Ok(exit::OK)
}

fn render_elements(elements: &[skyfix_almanac::orbits::OrbitalElements]) -> String {
    let mut out = format!("ORBITAL ELEMENTS: {}\n\n", elements.len());
    let mut t = Table::new(&[
        ("name", Align::Left),
        ("class", Align::Left),
        ("q au", Align::Right),
        ("e", Align::Right),
        ("i", Align::Right),
        ("node", Align::Right),
        ("peri", Align::Right),
        ("perihelion (TT)", Align::Left),
        ("source", Align::Left),
    ]);
    for el in elements {
        t.row(vec![
            el.name.clone(),
            words(&el.class),
            format!("{:.6}", el.perihelion_distance_au),
            format!("{:.6}", el.eccentricity),
            format!("{:.4}", el.inclination_deg),
            format!("{:.4}", el.ascending_node_deg),
            format!("{:.4}", el.argument_of_perihelion_deg),
            format!("JD {:.4}", el.perihelion_jd_tt),
            el.source.clone(),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "Angles in degrees on the J2000 ecliptic. With --lat --lon --utc the command gives \
         where each body is; with --from --to its track. The MPC asks that \"Source: Minor \
         Planet Center\" accompany its data.",
    );
    out
}

fn render_states(r: &CustomBodyStates, site: &skyfix_ephemeris::topocentric::Site) -> String {
    let mut out = String::from("CUSTOM BODIES\n");
    push_field(&mut out, "Observer", &observer_line(site));
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    out.push('\n');
    let mut t = Table::new(&[
        ("body", Align::Left),
        ("kind", Align::Left),
        ("app. alt", Align::Right),
        ("Az", Align::Right),
        ("RA", Align::Right),
        ("Dec", Align::Right),
        ("mag", Align::Right),
        ("au", Align::Right),
        ("con", Align::Left),
    ]);
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64);
    for b in &r.bodies {
        t.row(vec![
            b["body"].as_str().unwrap_or("?").to_string(),
            b["kind"].as_str().unwrap_or("?").to_string(),
            num(b, "alt_apparent_deg").map_or_else(|| "-".into(), text::alt),
            num(b, "az_deg").map_or_else(|| "-".into(), text::dm360),
            opt_fixed(num(b, "ra_deg"), 4),
            opt_fixed(num(b, "dec_deg"), 4),
            opt_fixed(num(b, "magnitude"), 2),
            opt_fixed(num(b, "distance_au"), 4),
            b["constellation"].as_str().unwrap_or("-").to_string(),
        ]);
    }
    out.push_str(&t.render("  "));
    for b in &r.bodies {
        if let Some(w) = b["warnings"].as_array() {
            for w in w.iter().filter_map(Value::as_str) {
                push_note(
                    &mut out,
                    &format!("{}: {w}", b["body"].as_str().unwrap_or("?")),
                );
            }
        }
    }
    for e in &r.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.body, e.message));
    }
    out
}
