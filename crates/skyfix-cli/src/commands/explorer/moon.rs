//! The Moon in detail: `moon-orientation`, `moon-features`, `moon-apsides` and
//! `occultations`. OWNER: cli3 agent.
//!
//! Engines: `skyfix_almanac::{libration, lunar_features, apsides, occultations}` through
//! the WASM adapter's `skyfix_wasm::moondetail::native` (which joins the Bright Star
//! Catalogue's stars to the occultation targets, display data, CONVENTIONS 13.6); wire
//! format EXPLORER_API.md "Expansion programme P8 — the Moon in detail"; definitions
//! CONVENTIONS 13.12. The astronomy is the explorer's with DUT1 = 0, as the site's.

use anyhow::Result;
use serde_json::{Value, json};
use skyfix_almanac::apsides::{ApsisKind, MoonApsides, SyzygyKind};
use skyfix_almanac::libration::MoonOrientation;
use skyfix_almanac::lunar_features::MoonFeatures;
use skyfix_almanac::occultations::{OccultationContact, OccultationList};
use skyfix_wasm::moondetail::native;

use super::args::{FormatArgs, parse_instant};
use super::sky::phase_words;
use super::sun::WindowFlags;
use super::text;
use super::wire::{
    Align, OptionalSite, SiteArgs, Table, ZoneFlag, call, emit_json, observer_line, push_field,
    push_note, shown_in, when_cells, when_headers, words,
};
use super::zone::ResolvedZone;
use crate::exit;
use crate::report;

fn signed(v: f64, d: usize) -> String {
    text::signed_fixed(v, d)
}

fn where_from(site: &OptionalSite) -> String {
    site.site().map_or_else(
        || "the Earth's centre (give --lat --lon for an observer)".to_string(),
        |s| observer_line(&s),
    )
}

// ---------------------------------------------------------------------------
// moon-orientation
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct OrientationArgs {
    #[command(flatten)]
    pub site: OptionalSite,
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_orientation(a: &OrientationArgs) -> Result<u8> {
    let r = call(native::moon_orientation(&a.site.json(), a.utc))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_orientation(&r, &a.site))?;
    }
    Ok(exit::OK)
}

fn render_orientation(r: &MoonOrientation, site: &OptionalSite) -> String {
    let mut out = String::from("THE MOON'S ORIENTATION\n");
    push_field(&mut out, "Seen from", &where_from(site));
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    out.push('\n');
    let l = &r.libration;
    push_field(
        &mut out,
        "Libration",
        &format!(
            "longitude {} deg, latitude {} deg (optical {}, {}; physical {}, {}; diurnal {}, \
             {}): the point at the disc's centre",
            signed(l.lon_deg, 3),
            signed(l.lat_deg, 3),
            signed(l.optical_lon_deg, 3),
            signed(l.optical_lat_deg, 3),
            signed(l.physical_lon_deg, 3),
            signed(l.physical_lat_deg, 3),
            signed(l.diurnal_lon_deg, 3),
            signed(l.diurnal_lat_deg, 3)
        ),
    );
    push_field(
        &mut out,
        "Phase",
        &format!(
            "{:.1}% lit, {}, phase angle {:.2} deg; colongitude {:.2} deg (the morning \
             terminator at selenographic longitude {}, the evening one at {})",
            r.illuminated_fraction * 100.0,
            if r.waxing { "waxing" } else { "waning" },
            r.phase_angle_deg,
            r.colongitude_deg,
            signed(r.terminator.morning_lon_deg, 2),
            signed(r.terminator.evening_lon_deg, 2)
        ),
    );
    push_field(
        &mut out,
        "Sun over",
        &format!(
            "selenographic latitude {}, longitude {} (the sub-solar point)",
            signed(r.sub_solar.lat_deg, 3),
            signed(r.sub_solar.lon_deg, 3)
        ),
    );
    push_field(
        &mut out,
        "Axis",
        &format!(
            "the Moon's north pole at position angle {:.2} deg (north through east; {:.2} \
             from the Earth's centre); the bright limb at {:.2} deg",
            r.axis_position_angle_deg,
            r.geocentric_axis_position_angle_deg,
            r.bright_limb_angle_deg
        ),
    );
    push_field(
        &mut out,
        "Size",
        &format!(
            "{:.0} km away, {:.2}' across ({:+.1}% against its size at the mean distance); \
             from the Earth's centre {:.0} km",
            r.distance_km,
            r.apparent_diameter_arcmin,
            r.diameter_vs_mean_percent,
            r.geocentric_distance_km
        ),
    );
    if let (Some(alt), Some(az)) = (r.alt_deg, r.az_deg) {
        push_field(
            &mut out,
            "In the sky",
            &format!(
                "altitude {} (geometric), azimuth {}, parallactic angle {} deg",
                text::alt_inline(alt),
                text::dm360(az).trim_start(),
                r.parallactic_angle_deg
                    .map_or_else(|| "-".to_string(), |p| format!("{p:.2}"))
            ),
        );
    }
    out.push('\n');
    push_note(
        &mut out,
        "Selenographic places: latitude north positive, longitude east positive (toward Mare \
         Crisium). --format json adds the terminator as a great circle and as seen on the \
         disc, and the disc points of the north pole and the sub-solar point.",
    );
    out
}

// ---------------------------------------------------------------------------
// moon-features
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct FeaturesArgs {
    #[command(flatten)]
    pub site: OptionalSite,
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// List all 150 features, not only those near the terminator.
    #[arg(long)]
    pub all: bool,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_features(a: &FeaturesArgs) -> Result<u8> {
    let r = call(native::moon_features(&a.site.json(), a.utc))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_features(&r, a))?;
    }
    Ok(exit::OK)
}

fn render_features(r: &MoonFeatures, a: &FeaturesArgs) -> String {
    let mut out = String::from("THE MOON'S NAMED FEATURES\n");
    push_field(&mut out, "Seen from", &where_from(&a.site));
    push_field(&mut out, "Time", &text::utc(r.jd_utc));
    push_field(
        &mut out,
        "Phase",
        &format!(
            "{:.1}% lit, {}, colongitude {:.2} deg",
            r.illuminated_fraction * 100.0,
            if r.waxing { "waxing" } else { "waning" },
            r.colongitude_deg
        ),
    );
    out.push('\n');
    push_field(
        &mut out,
        "Tonight",
        &if r.tonight.is_empty() {
            "no named relief feature is near the terminator on the visible side".to_string()
        } else {
            format!("{}.", r.tonight.join(", "))
        },
    );
    out.push('\n');
    let mut t = Table::new(&[
        ("feature", Align::Left),
        ("kind", Align::Left),
        ("rank", Align::Right),
        ("lat", Align::Right),
        ("lon", Align::Right),
        ("km", Align::Right),
        ("Sun alt", Align::Right),
        ("", Align::Left),
    ]);
    for f in r
        .features
        .iter()
        .filter(|f| a.all || (f.near_terminator && f.visible))
    {
        t.row(vec![
            f.feature.name.clone(),
            words(&f.feature.kind),
            f.feature.rank.to_string(),
            signed(f.feature.lat_deg, 1),
            signed(f.feature.lon_deg, 1),
            format!("{:.0}", f.feature.diameter_km),
            signed(f.sun_altitude_deg, 1),
            [
                if f.lit { "lit" } else { "dark" },
                if f.morning { "morning" } else { "evening" },
                if f.visible { "" } else { "far side" },
                if f.near_terminator {
                    "near the terminator"
                } else {
                    ""
                },
            ]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(", "),
        ]);
    }
    if t.is_empty() {
        out.push_str("  none near the terminator on the visible side\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "Listed: {} (--all lists all 150). Sun alt is the Sun's altitude over the \
             feature, degrees; near the terminator means between -r and {} + r degrees, r its \
             angular radius. Rank 1 is a showpiece, 2 notable, 3 more to find. {}",
            if a.all {
                "every feature"
            } else {
                "the visible features near the terminator"
            },
            r.terminator_band_deg,
            r.source
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// moon-apsides
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ApsidesArgs {
    #[command(flatten)]
    pub window: WindowFlags,
    /// The zone a date is taken in and times are shown in: utc (default) or an offset.
    #[arg(long, value_name = "ZONE", default_value = "utc", value_parser = super::zone::parse_zone, allow_hyphen_values = true)]
    pub zone: super::zone::Zone,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_apsides(a: &ApsidesArgs) -> Result<u8> {
    if a.zone == super::zone::Zone::Nautical {
        anyhow::bail!(
            "--zone nautical needs a longitude, and the Moon's apsides have no observer: give \
             the zone as an offset such as -05:00"
        );
    }
    let zone = a.zone.resolve(0.0);
    let (s, e) = a.window.resolve(&zone)?;
    let r = call(native::moon_apsides(s, e))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_apsides(&r, &zone))?;
    }
    Ok(exit::OK)
}

fn render_apsides(r: &MoonApsides, zone: &ResolvedZone) -> String {
    let mut out = format!(
        "PERIGEE, APOGEE AND SUPERMOONS  {} to {}{}\n",
        text::utc(r.jd_start),
        text::utc(r.jd_end),
        shown_in(zone)
    );
    if r.truncated {
        push_field(
            &mut out,
            "Coverage",
            &format!(
                "the window was clipped to {} .. {}",
                r.coverage_start_utc, r.coverage_end_utc
            ),
        );
    }
    out.push_str("\nPerigees and apogees\n");
    let mut cols = when_headers(zone);
    cols.extend([
        ("", Align::Left),
        ("km", Align::Right),
        ("diameter '", Align::Right),
        ("vs mean", Align::Right),
    ]);
    let mut t = Table::new(&cols);
    for p in &r.apsides {
        let mut row = when_cells(p.jd_utc, zone);
        row.extend([
            match p.kind {
                ApsisKind::Perigee => "perigee",
                ApsisKind::Apogee => "apogee",
            }
            .to_string(),
            format!("{:.0}", p.distance_km),
            format!("{:.2}", p.diameter_arcmin),
            format!("{:+.1}%", p.diameter_vs_mean_percent),
        ]);
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    out.push_str("\nNew and full Moons\n");
    let mut cols = when_headers(zone);
    cols.extend([
        ("", Align::Left),
        ("km", Align::Right),
        ("diameter '", Align::Right),
        ("to perigee", Align::Right),
        ("", Align::Left),
    ]);
    let mut t = Table::new(&cols);
    for s in &r.syzygies {
        let mut row = when_cells(s.jd_utc, zone);
        let mut flags = Vec::new();
        if s.supermoon {
            flags.push("supermoon");
        }
        if s.micromoon {
            flags.push("micromoon");
        }
        if s.largest_of_year {
            flags.push("the year's largest full Moon");
        }
        if s.smallest_of_year {
            flags.push("the year's smallest full Moon");
        }
        row.extend([
            match s.kind {
                SyzygyKind::NewMoon => "new moon",
                SyzygyKind::FullMoon => "full moon",
            }
            .to_string(),
            format!("{:.0}", s.distance_km),
            format!("{:.2}", s.diameter_arcmin),
            format!("{:.0}%", s.perigee_fraction * 100.0),
            flags.join(", "),
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
            "Distances are centre to centre, geometric. to perigee: how near to perigee the \
             Moon is, 0% at apogee and 100% at perigee. {} {}",
            r.definitions.supermoon, r.definitions.micromoon
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// occultations
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct OccultationsArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    #[command(flatten)]
    pub window: WindowFlags,
    /// Catalogue stars brighter than this join the 58 navigational stars (-2 to 6.5).
    /// Default 3.5.
    #[arg(
        long = "max-magnitude",
        value_name = "MAG",
        allow_negative_numbers = true
    )]
    pub max_magnitude: Option<f64>,
    /// Leave the stars out.
    #[arg(long = "no-stars")]
    pub no_stars: bool,
    /// Leave the planets out.
    #[arg(long = "no-planets")]
    pub no_planets: bool,
    /// Keep events with the Moon below the horizon at every contact.
    #[arg(long = "below-horizon")]
    pub below_horizon: bool,
    /// Leave out the bodies that pass just outside the mean limb (within 1').
    #[arg(long = "no-near-misses")]
    pub no_near_misses: bool,
    /// Only this body (repeat for more), as results spell it: Regulus, Mars, HR 1457.
    #[arg(long = "body", value_name = "NAME")]
    pub bodies: Vec<String>,
    #[command(flatten)]
    pub zone: ZoneFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// The options document, with only the keys the flags set.
pub fn occultation_options(a: &OccultationsArgs) -> String {
    let mut m = serde_json::Map::new();
    if let Some(v) = a.max_magnitude {
        m.insert("max_magnitude".into(), json!(v));
    }
    if a.no_stars {
        m.insert("stars".into(), json!(false));
    }
    if a.no_planets {
        m.insert("planets".into(), json!(false));
    }
    if a.below_horizon {
        m.insert("include_below_horizon".into(), json!(true));
    }
    if a.no_near_misses {
        m.insert("include_near_misses".into(), json!(false));
    }
    if !a.bodies.is_empty() {
        m.insert("bodies".into(), json!(a.bodies));
    }
    if m.is_empty() {
        String::new()
    } else {
        Value::Object(m).to_string()
    }
}

pub fn run_occultations(a: &OccultationsArgs) -> Result<u8> {
    let zone = a.zone.resolve(a.site.position.lon);
    let (s, e) = a.window.resolve(&zone)?;
    let r = call(native::occultations(
        &a.site.json(),
        s,
        e,
        &occultation_options(a),
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_occultations(&r, a, &zone))?;
    }
    for err in &r.errors {
        eprintln!("not computed: {}: {}", err.body, err.message);
    }
    Ok(exit::OK)
}

/// A contact's time and place on the limb: the disappearance with its date (in the zone
/// and in UTC), the reappearance minutes later as a time of day in the zone.
fn contact_words(
    c: &Option<OccultationContact>,
    zone: &ResolvedZone,
    with_date: bool,
) -> Vec<String> {
    match c {
        Some(c) => {
            let mut v = if with_date {
                when_cells(c.jd_utc, zone)
            } else {
                vec![text::clock(c.jd_utc, zone.offset_minutes)]
            };
            v.push(format!(
                "{:>3.0} {}{}",
                c.position_angle_deg,
                words(&c.limb),
                if c.moon_above_horizon {
                    String::new()
                } else {
                    " (Moon down)".to_string()
                }
            ));
            v
        }
        None => {
            let n = if with_date && !zone.is_utc() { 3 } else { 2 };
            vec!["-".to_string(); n]
        }
    }
}

fn render_occultations(r: &OccultationList, a: &OccultationsArgs, zone: &ResolvedZone) -> String {
    let mut out = String::from("LUNAR OCCULTATIONS\n");
    push_field(&mut out, "Observer", &observer_line(&a.site.site()));
    push_field(
        &mut out,
        "Window",
        &format!(
            "{} to {}{}{}",
            text::utc(r.jd_start),
            text::utc(r.jd_end),
            shown_in(zone),
            if r.truncated {
                ", clipped to the coverage"
            } else {
                ""
            }
        ),
    );
    push_field(
        &mut out,
        "Searched",
        &format!(
            "{} bodies near the Moon's path (stars within 7 deg of the ecliptic)",
            r.bodies_searched
        ),
    );
    out.push('\n');
    let mut cols = vec![("body", Align::Left), ("mag", Align::Right)];
    for (h, al) in when_headers(zone) {
        cols.push((
            if h == "UTC" {
                "disappears UTC"
            } else {
                "disappears"
            },
            al,
        ));
    }
    cols.push(("PA, limb", Align::Left));
    cols.push(("reappears", Align::Left));
    cols.push(("PA, limb", Align::Left));
    cols.push(("", Align::Left));
    let mut t = Table::new(&cols);
    for ev in &r.events {
        let mut row = vec![ev.body.clone(), super::wire::opt_fixed(ev.magnitude, 2)];
        row.extend(contact_words(&ev.disappearance, zone, true));
        row.extend(contact_words(&ev.reappearance, zone, false));
        let mut notes = Vec::new();
        if !ev.occulted {
            notes.push(format!(
                "near miss, {:.2}' outside the limb",
                ev.closest.limb_distance_arcmin
            ));
        }
        if ev.graze {
            notes.push("graze".to_string());
        }
        if !ev.visible {
            notes.push("not seen: the Moon is down".to_string());
        }
        if let Some(c) = ev.disappearance.as_ref().or(ev.reappearance.as_ref()) {
            notes.push(phase_words(c.sky_phase).to_string());
        }
        row.push(notes.join(", "));
        t.row(row);
    }
    if t.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&t.render("  "));
    }
    for err in &r.errors {
        out.push_str(&format!("  not computed: {}: {}\n", err.body, err.message));
    }
    out.push('\n');
    push_note(&mut out, &r.limb_note);
    push_note(
        &mut out,
        &format!(
            "The reappearance is a time of day in {}, minutes after the disappearance. PA is \
             the position angle on the Moon's limb, from celestial north through east; the \
             limb is the dark or the bright one. The sky words are the sky phase at the first \
             contact (CONVENTIONS 13.4). --format json adds the vertex and cusp angles, the \
             Moon's and the Sun's altitudes at each contact and the closest approach.",
            zone.label
        ),
    );
    out
}
