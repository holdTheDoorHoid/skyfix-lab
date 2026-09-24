//! `skyfix eclipse <id>`: one eclipse, what a place sees of it, and its path.
//! OWNER: cli agent.
//!
//! `skyfix_almanac::eclipses::Eclipses::{by_id, local, path}` (EXPLORER_API.md "Wave 2 —
//! eclipses": `eclipses`, `eclipse_local`, `eclipse_path`), called as the WASM exports
//! call them (DUT1 = 0). The text gives the eclipse's global circumstances — greatest
//! eclipse, magnitude, gamma, saros, the path's width and central duration, the contacts
//! of the shadow with the Earth — and with `--lat --lon` the local circumstances: every
//! contact with its UTC and the Sun's or the Moon's altitude and azimuth, the magnitude
//! and obscuration, and the duration of totality or annularity. A solar eclipse always
//! carries an eye-safety line.
//!
//! `--format json` is `{"eclipse": Eclipse, "local": EclipseLocal}` (`local` only with an
//! observer), each exactly as the engine returns it. `--path` prints the engine's
//! `EclipsePath` instead — as JSON, since polylines have no useful text form — or, with
//! `--format geojson`, the same lines as an RFC 7946 FeatureCollection that any map tool
//! opens: its coordinates are the engine's `[lon, lat]` pairs, unrounded.

use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use skyfix_almanac::eclipses::{
    COVERAGE_END_UTC, COVERAGE_START_UTC, Eclipse, EclipseError, EclipseLocal, EclipsePath,
    Eclipses, GlobalContactKind, LocalEvent, LocalEventKind, LocalType, LunarEclipse, LunarLocal,
    LunarPath, LunarType, Polyline, SolarEclipse, SolarLocal, SolarPath, SolarType, Visibility,
};
use skyfix_ephemeris::topocentric::Site;

use super::args::OptionalSiteArgs;
use super::eclipses::{
    alt_az, central_seen, event_code, event_words, find, percent, rise_set_words, site_words, title,
};
use super::text;
use crate::exit;
use crate::report;

/// `--format` values of `skyfix eclipse`: the shared text and JSON, and GeoJSON, which
/// only a path has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum EclipseFormat {
    /// Plain text for a person to read (the default; not with --path).
    Text,
    /// The engine's own result, as serde emits it (the default with --path).
    Json,
    /// With --path only: the path as a GeoJSON FeatureCollection (RFC 7946).
    Geojson,
}

#[derive(clap::Args, Debug)]
pub struct Args {
    /// The eclipse, as `skyfix eclipses` lists it: the UTC date of greatest eclipse and
    /// its kind, YYYY-MM-DD-solar or YYYY-MM-DD-lunar.
    #[arg(value_name = "ID")]
    pub id: String,
    #[command(flatten)]
    pub observer: OptionalSiteArgs,
    /// Print the eclipse's lines on the map instead: a solar eclipse's central line and
    /// the limits of its central and partial phases, a lunar eclipse's sub-lunar points.
    /// JSON, or GeoJSON with --format geojson.
    #[arg(long, conflicts_with_all = ["lat", "lon", "height"])]
    pub path: bool,
    /// `text` (default), `json`, or `geojson` (with --path, whose default is `json`).
    #[arg(long, value_enum, value_name = "FORMAT")]
    pub format: Option<EclipseFormat>,
    /// The same as --format json.
    #[arg(long, conflicts_with = "format")]
    pub json: bool,
}

/// What the flags ask to be printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    Text,
    Json,
    PathJson,
    PathGeojson,
}

/// The output the flags ask for, or why they contradict each other.
pub fn output(a: &Args) -> Result<Output> {
    let format = if a.json {
        Some(EclipseFormat::Json)
    } else {
        a.format
    };
    Ok(match (a.path, format) {
        (false, None | Some(EclipseFormat::Text)) => Output::Text,
        (false, Some(EclipseFormat::Json)) => Output::Json,
        (false, Some(EclipseFormat::Geojson)) => bail!(
            "--format geojson is for --path: the path is the part of an eclipse that is a map. \
             Add --path"
        ),
        (true, None | Some(EclipseFormat::Json)) => Output::PathJson,
        (true, Some(EclipseFormat::Geojson)) => Output::PathGeojson,
        (true, Some(EclipseFormat::Text)) => bail!(
            "--path has no text form (it is thousands of points): use --format json, or \
             --format geojson for a map"
        ),
    })
}

/// `--format json`: the eclipse and, with an observer, what the observer sees.
#[derive(Serialize)]
struct EclipseJson<'a> {
    eclipse: &'a Eclipse,
    #[serde(skip_serializing_if = "Option::is_none")]
    local: Option<&'a EclipseLocal>,
}

/// The engine's refusal, with a pointer to the list when the id names no eclipse.
fn refusal(e: EclipseError) -> anyhow::Error {
    match e {
        EclipseError::NotFound { .. } => anyhow!(
            "{e}. skyfix eclipses --from DATE --to DATE lists the eclipses and their ids, from \
             {} to {}",
            &COVERAGE_START_UTC[..10],
            &COVERAGE_END_UTC[..10]
        ),
        e => anyhow!("{e}"),
    }
}

pub fn run(a: &Args) -> Result<u8> {
    let out = output(a)?;
    let engine = Eclipses::new();
    match out {
        Output::PathJson | Output::PathGeojson => {
            let path = engine.path(&a.id).map_err(refusal)?;
            let text = if out == Output::PathJson {
                serde_json::to_string_pretty(&path)?
            } else {
                serde_json::to_string_pretty(&geojson(&path))?
            };
            report::emit_line(&text)?;
        }
        Output::Text | Output::Json => {
            let eclipse = engine.by_id(&a.id).map_err(refusal)?;
            let site = a.observer.site();
            let local = match &site {
                Some(site) => Some(engine.local(&a.id, site).map_err(refusal)?),
                None => None,
            };
            if out == Output::Json {
                let doc = EclipseJson {
                    eclipse: &eclipse,
                    local: local.as_ref(),
                };
                report::emit_line(&serde_json::to_string_pretty(&doc)?)?;
            } else {
                report::emit(&render(&eclipse, site.as_ref(), local.as_ref()))?;
            }
        }
    }
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// A labelled line, `Label      value`, wrapped at 88 columns under the value.
fn field(out: &mut String, label: &str, value: &str) {
    for (i, line) in report::wrap(value, 77, "           ")
        .into_iter()
        .enumerate()
    {
        if i == 0 {
            out.push_str(&format!(
                "{}{}\n",
                report::pad(label, 11),
                line.trim_start()
            ));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }
}

fn wrapped(out: &mut String, text: &str) {
    for line in report::wrap(text, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
}

/// `25 17.34' N, 104 08.76' W (25.289270, -104.146130)`.
fn place(lat_deg: f64, lon_deg: f64) -> String {
    let p = skyfix_core::types::LatLon { lat_deg, lon_deg };
    format!(
        "{} ({})",
        report::format_position(p),
        report::format_position_decimal(p)
    )
}

/// How far north or south, in words: `+0.3431: ... 0.3431 Earth radii north of ...`.
fn gamma_words(gamma: f64, what: &str, from: &str) -> String {
    let side = if gamma < 0.0 { "south" } else { "north" };
    format!(
        "{}: {what} passes {} Earth radii {side} of {from}",
        text::signed_fixed(gamma, 4),
        text::fixed(gamma.abs(), 4)
    )
}

pub fn render(e: &Eclipse, site: Option<&Site>, local: Option<&EclipseLocal>) -> String {
    let mut out = format!("{}  {}\n", title(e), e.id());
    match e {
        Eclipse::Solar(s) => solar_global(&mut out, s),
        Eclipse::Lunar(l) => lunar_global(&mut out, l, local.is_none()),
    }
    if let (Some(site), Some(local)) = (site, local) {
        out.push('\n');
        out.push_str(&format!("SEEN FROM  {}\n", site_words(site)));
        match local {
            EclipseLocal::Solar(l) => solar_local(&mut out, l),
            EclipseLocal::Lunar(l) => lunar_local(&mut out, l),
        }
    }
    out.push('\n');
    if let Eclipse::Solar(s) = e {
        let solar_local = match local {
            Some(EclipseLocal::Solar(l)) => Some(l),
            _ => None,
        };
        wrapped(&mut out, &eye_safety(s.eclipse_type, solar_local));
        out.push('\n');
    }
    wrapped(&mut out, &notes(e, local));
    out
}

fn solar_global(out: &mut String, s: &SolarEclipse) {
    let g = &s.greatest;
    field(
        out,
        "Greatest",
        &format!(
            "{} at {}, the Sun at altitude {}, azimuth {} there",
            text::utc(g.jd_utc),
            place(g.lat_deg, g.lon_deg),
            text::alt_inline(g.sun_alt_deg),
            text::dm360(g.sun_az_deg).trim_start()
        ),
    );
    let magnitude = if s.central {
        "the Moon's apparent diameter over the Sun's at greatest eclipse"
    } else {
        "the fraction of the Sun's diameter covered at greatest eclipse"
    };
    field(
        out,
        "Magnitude",
        &format!("{:.4}: {magnitude}", s.magnitude),
    );
    field(
        out,
        "Gamma",
        &gamma_words(s.gamma, "the shadow's axis", "the Earth's centre"),
    );
    field(
        out,
        "Saros",
        &format!("{} (lunation {})", s.saros, s.lunation),
    );
    let phase = match s.eclipse_type {
        SolarType::Total => "totality",
        SolarType::Annular => "the annular phase",
        SolarType::Hybrid => "the central phase",
        SolarType::Partial => "",
    };
    let path = match (s.path_width_km, s.central_duration_s) {
        (Some(w), Some(d)) => format!(
            "{w:.1} km wide at greatest eclipse, where {phase} lasts {}",
            text::duration_s(d)
        ),
        (Some(w), None) => format!("{w:.1} km wide at greatest eclipse"),
        _ if s.eclipse_type == SolarType::Partial => {
            "none: the Moon's dark shadow misses the Earth, so the eclipse is partial \
             everywhere it is seen"
                .to_string()
        }
        _ => "no central line: the shadow's axis misses the Earth, and only the edge of the \
              shadow touches it, near a pole"
            .to_string(),
    };
    field(out, "Path", &path);
    field(
        out,
        "Delta-T",
        &format!(
            "{:.3} s (TT - UT1), assumed by every place and local time here",
            s.delta_t_s
        ),
    );
    out.push_str("\nThe shadow on the Earth\n");
    for c in &s.contacts {
        let words = match c.kind {
            GlobalContactKind::P1 => {
                "the partial eclipse begins: the penumbra first touches the Earth"
            }
            GlobalContactKind::U1 => {
                "the central eclipse begins: the umbra first touches the Earth"
            }
            GlobalContactKind::U4 => "the central eclipse ends: the umbra leaves the Earth",
            GlobalContactKind::P4 => "the eclipse ends: the penumbra leaves the Earth",
            GlobalContactKind::U2 | GlobalContactKind::U3 => "",
        };
        out.push_str(&format!(
            "  {:<4}{}  {words}\n",
            contact_code(c.kind),
            text::utc(c.jd_utc)
        ));
    }
}

fn contact_code(k: GlobalContactKind) -> &'static str {
    match k {
        GlobalContactKind::P1 => "p1",
        GlobalContactKind::U1 => "u1",
        GlobalContactKind::U2 => "u2",
        GlobalContactKind::U3 => "u3",
        GlobalContactKind::U4 => "u4",
        GlobalContactKind::P4 => "p4",
    }
}

fn lunar_global(out: &mut String, l: &LunarEclipse, with_contacts: bool) {
    let g = &l.greatest;
    field(
        out,
        "Greatest",
        &format!(
            "{}, with the Moon overhead at {}",
            text::utc(g.jd_utc),
            place(g.lat_deg, g.lon_deg)
        ),
    );
    let umbral = if l.umbral_magnitude < 0.0 {
        "umbral (negative: the Moon misses the Earth's dark shadow)"
    } else {
        "umbral (the fraction of the Moon's diameter inside the Earth's dark shadow)"
    };
    field(
        out,
        "Magnitude",
        &format!(
            "{} {umbral}, penumbral {}",
            text::fixed(l.umbral_magnitude, 4),
            text::fixed(l.penumbral_magnitude, 4)
        ),
    );
    field(
        out,
        "Gamma",
        &gamma_words(l.gamma, "the Moon's centre", "the shadow's axis"),
    );
    field(
        out,
        "Saros",
        &format!("{} (lunation {})", l.saros, l.lunation),
    );
    for (label, d, span) in [
        (
            "Totality",
            l.total_duration_s,
            "u2 to u3, the Moon wholly in the umbra",
        ),
        (
            "Partial",
            l.partial_duration_s,
            "u1 to u4, the Moon partly or wholly in the umbra",
        ),
        (
            "Penumbral",
            l.penumbral_duration_s,
            "p1 to p4, the whole eclipse",
        ),
    ] {
        if let Some(d) = d {
            field(out, label, &format!("{} ({span})", text::duration_s(d)));
        }
    }
    field(
        out,
        "Delta-T",
        &format!(
            "{:.3} s (TT - UT1): the contacts are the same instants everywhere; where the Moon \
             is overhead depends on it",
            l.delta_t_s
        ),
    );
    if !with_contacts {
        return;
    }
    out.push_str("\nContacts, the same instants wherever the Moon is up\n");
    for c in &l.contacts {
        let words = match c.kind {
            GlobalContactKind::P1 => "the Moon enters the penumbra: the penumbral eclipse begins",
            GlobalContactKind::U1 => "the Moon enters the umbra: the partial eclipse begins",
            GlobalContactKind::U2 => "the Moon is wholly inside the umbra: totality begins",
            GlobalContactKind::U3 => "totality ends",
            GlobalContactKind::U4 => "the Moon leaves the umbra: the partial eclipse ends",
            GlobalContactKind::P4 => "the Moon leaves the penumbra: the eclipse is over",
        };
        out.push_str(&format!(
            "  {:<4}{}  {words}\n",
            contact_code(c.kind),
            text::utc(c.jd_utc)
        ));
    }
}

/// The local table: every event with its UTC and the body's altitude and azimuth.
fn event_table(out: &mut String, body: &str, events: &[LocalEvent], annular: bool, solar: bool) {
    out.push('\n');
    let mut head = format!(
        "  {}{}{:>9}{:>10}",
        report::pad("UTC", 22),
        report::pad("event", 30),
        format!("{body} alt"),
        "Az"
    );
    if solar {
        head.push_str(&format!("{:>6}{:>6}", "P", "V"));
    }
    out.push_str(head.trim_end());
    out.push('\n');
    for e in events {
        let code = match e.kind {
            LocalEventKind::Sunrise
            | LocalEventKind::Sunset
            | LocalEventKind::Moonrise
            | LocalEventKind::Moonset => "",
            k => event_code(k),
        };
        let mut words = event_words(e.kind, annular).to_string();
        if matches!(e.kind, LocalEventKind::Sunrise | LocalEventKind::Sunset)
            && let Some(o) = e.obscuration
        {
            words.push_str(&format!(", {} covered", percent(o)));
        }
        let mut line = format!(
            "  {}  {}{:>9}{:>10}",
            text::utc(e.jd_utc),
            report::pad(&format!("{code:<5}{words}"), 30),
            text::alt(e.alt_deg),
            text::dm360(e.az_deg)
        );
        if solar {
            let angle = |v: Option<f64>| v.map_or_else(|| "-".to_string(), |v| format!("{v:.0}"));
            line.push_str(&format!(
                "{:>6}{:>6}",
                angle(e.position_angle_deg),
                angle(e.vertex_angle_deg)
            ));
        }
        if !e.visible {
            line.push_str(&format!("  {body} down"));
        }
        out.push_str(&line);
        out.push('\n');
    }
}

fn solar_local(out: &mut String, l: &SolarLocal) {
    let annular = l.local_type == LocalType::Annular;
    let here = match (l.visibility, l.local_type) {
        (Visibility::None, _) | (_, LocalType::None) => {
            field(
                out,
                "Here",
                "no eclipse: the Moon's shadow misses this place, which is outside the \
                 penumbra throughout",
            );
            return;
        }
        (_, LocalType::Total) => "total: inside the path of totality",
        (_, LocalType::Annular) => "annular: inside the path of the annular eclipse",
        (_, LocalType::Partial) => "partial",
    };
    let sun = match l.visibility {
        Visibility::Visible => "with the Sun up from first contact to last".to_string(),
        Visibility::BelowHorizon => {
            "but the Sun is below the horizon throughout, so none of it can be seen".to_string()
        }
        _ => rise_set_words(
            "Sun",
            &l.events,
            LocalEventKind::Sunrise,
            LocalEventKind::Sunset,
        )
        .unwrap_or_else(|| "with the Sun down for part of it".to_string()),
    };
    field(out, "Here", &format!("{here}, {sun}"));
    if let (Some(c2), Some(c3), Some(d)) = (
        find(&l.events, LocalEventKind::C2),
        find(&l.events, LocalEventKind::C3),
        l.central_duration_s,
    ) {
        let label = if annular { "Annularity" } else { "Totality" };
        let mut v = format!(
            "{} to {}, {}",
            text::utc(c2.jd_utc),
            text::utc(c3.jd_utc),
            text::duration_s(d)
        );
        match central_seen(l) {
            Some(seen) if seen.all => {}
            Some(seen) => v.push_str(&format!(
                "; the Sun is up for {} of it, from {} to {}",
                text::duration_s((seen.end - seen.start) * 86_400.0),
                text::utc(seen.start),
                text::utc(seen.end)
            )),
            None => v.push_str(", with the Sun below the horizon throughout"),
        }
        field(out, label, &v);
    }
    if let Some(m) = find(&l.events, LocalEventKind::Max) {
        let mut v = format!(
            "{}: magnitude {:.3}, {} of the Sun's area covered, {}",
            text::utc(m.jd_utc),
            l.magnitude,
            percent(l.obscuration),
            alt_az("Sun", m)
        );
        if !m.visible {
            v.push_str(" (below the horizon)");
        }
        field(out, "Maximum", &v);
    }
    if let Some(v) = &l.visible_max
        && v.kind != LocalEventKind::Max
    {
        field(
            out,
            "Most seen",
            &format!(
                "at {} {}: magnitude {:.3}, {} covered",
                event_words(v.kind, annular),
                text::utc(v.jd_utc),
                v.magnitude.unwrap_or(0.0),
                percent(v.obscuration.unwrap_or(0.0))
            ),
        );
    }
    if let (Some(c1), Some(c4), Some(d)) = (
        find(&l.events, LocalEventKind::C1),
        find(&l.events, LocalEventKind::C4),
        l.duration_s,
    ) {
        field(
            out,
            "Eclipse",
            &format!(
                "{} to {}, {} from first contact to last",
                text::utc(c1.jd_utc),
                text::utc(c4.jd_utc),
                text::duration_s(d)
            ),
        );
    }
    event_table(out, "Sun", &l.events, annular, true);
}

fn lunar_local(out: &mut String, l: &LunarLocal) {
    let here = match l.visibility {
        Visibility::Visible => "all of it seen, with the Moon up from beginning to end".to_string(),
        Visibility::PartlyBelowHorizon => format!(
            "partly seen: {}",
            rise_set_words(
                "Moon",
                &l.events,
                LocalEventKind::Moonrise,
                LocalEventKind::Moonset
            )
            .unwrap_or_else(|| "the Moon is down for part of it".to_string())
        ),
        Visibility::BelowHorizon => {
            "not seen: the Moon is below the horizon throughout".to_string()
        }
        Visibility::None => "no eclipse here".to_string(),
    };
    field(out, "Here", &here);
    if let Some(m) = find(&l.events, LocalEventKind::Max) {
        let mut v = format!("{}, {}", text::utc(m.jd_utc), alt_az("Moon", m));
        if !m.visible {
            v.push_str(" (below the horizon)");
        }
        field(out, "Greatest", &v);
    }
    event_table(out, "Moon", &l.events, false, false);
}

/// The eye-safety line of a solar eclipse, fitted to what the observer sees, or with no
/// observer to the eclipse's type: only totality is ever safe to look at unprotected.
fn eye_safety(eclipse_type: SolarType, local: Option<&SolarLocal>) -> String {
    let base = "Eye safety: never look at the Sun, even when it is mostly covered, without \
                certified eclipse glasses (ISO 12312-2) or a pinhole projector.";
    let totality = local
        .filter(|l| l.local_type == LocalType::Total)
        .and_then(central_seen);
    let local_type = local.map(|l| l.local_type);
    match (totality, local_type, eclipse_type) {
        (Some(seen), _, _) if seen.all => format!(
            "{base} Only during totality itself, here from {} to {}, is it safe to look with \
             the naked eye; the glasses go back on as the first bright point reappears.",
            text::utc(seen.start),
            text::utc(seen.end)
        ),
        (Some(seen), _, _) => format!(
            "{base} Only during totality itself is it safe to look with the naked eye: here \
             from {} to {}, the part of totality with the Sun above the horizon.",
            text::utc(seen.start),
            text::utc(seen.end)
        ),
        (None, Some(LocalType::Annular), _)
        | (None, None | Some(LocalType::None), SolarType::Annular) => {
            format!(
                "{base} An annular eclipse is never safe to look at with the naked eye, not \
                 even at its greatest: the ring of Sun left uncovered is still blinding."
            )
        }
        (None, Some(LocalType::Total), _) => format!(
            "{base} Totality comes with the Sun below the horizon here, so there is no moment \
             when it is safe to look with the naked eye."
        ),
        (None, Some(LocalType::Partial), _) => format!(
            "{base} There is no totality to see from this place, so there is no moment when it \
             is safe to look with the naked eye."
        ),
        (None, None | Some(LocalType::None), SolarType::Partial) => format!(
            "{base} A partial eclipse is never safe to look at with the naked eye: some of the \
             Sun is always left uncovered."
        ),
        (None, None | Some(LocalType::None), SolarType::Total | SolarType::Hybrid) => format!(
            "{base} Only during totality itself, inside the path of totality, is it safe to \
             look with the naked eye."
        ),
    }
}

fn notes(e: &Eclipse, local: Option<&EclipseLocal>) -> String {
    let mut s = String::from(
        "Times are UTC to the nearest second; --format json carries the milliseconds, and \
         --path the lines on the map (--format geojson for a map tool).",
    );
    if local.is_some() {
        let body = match e {
            Eclipse::Solar(_) => {
                " alt and Az are the Sun's centre, geometric, with no refraction, from the WGS84 \
                 site (CONVENTIONS 13.2); an event is marked Sun down when the Sun's centre is \
                 below -50', its rise and set altitude. P and V say where on the Sun's disc the \
                 limbs touch: the angle from the disc's north point (P) or from its top, toward \
                 the zenith (V), counted through east. A place's maximum is its greatest \
                 magnitude. Contacts agree with USNO's within 2 s at USNO's Delta-T, and within \
                 6 s as computed here with DUT1 = 0 (docs/ACCURACY.md section 12); for a future \
                 eclipse the true Delta-T will differ, and each second of difference moves a \
                 contact by up to about a second."
            }
            Eclipse::Lunar(_) => {
                " alt and Az are the Moon's centre, geometric, with no refraction, from the WGS84 \
                 site (CONVENTIONS 13.2); an event is marked Moon down when the Moon's centre is \
                 below -(34' + SD), its rise and set altitude. The contacts are the same \
                 instants everywhere; only the Moon's height differs from place to place."
            }
        };
        s.push_str(body);
    }
    if let Eclipse::Lunar(l) = e
        && l.eclipse_type == LunarType::Penumbral
    {
        s.push_str(
            " A penumbral eclipse is a subtle dimming, easiest to notice near greatest eclipse.",
        );
    }
    s
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

/// An RFC 7946 FeatureCollection. Typed rather than built as a `serde_json::Value`, so
/// every object prints with its `type` first, as GeoJSON is usually written.
#[derive(Debug, Serialize)]
pub struct FeatureCollection<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    pub features: Vec<Feature<'a>>,
}

#[derive(Debug, Serialize)]
pub struct Feature<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    pub geometry: Geometry<'a>,
    pub properties: Properties<'a>,
}

/// `[lon, lat]` coordinates, exactly the engine's.
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum Geometry<'a> {
    Point { coordinates: [f64; 2] },
    MultiLineString { coordinates: &'a [Vec<[f64; 2]>] },
}

/// When: one instant for a point, the instant of every vertex for a line.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Times<'a> {
    One(f64),
    Vertices(&'a [Vec<f64>]),
}

#[derive(Debug, Serialize)]
pub struct Properties<'a> {
    /// The eclipse's id and type, on every feature, so a layer can be filtered alone.
    pub eclipse: &'a str,
    pub eclipse_type: &'static str,
    /// The engine's name for the line or point: `central_line`, `umbra_north`, ...
    pub feature: &'static str,
    /// Sub-lunar points: the contact, `p1` to `p4` or `max`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<&'static str>,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utc: Option<&'a str>,
    pub jd_utc: Times<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sun_alt_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sun_az_deg: Option<f64>,
    /// TT - UT1 the ground positions assume.
    pub delta_t_s: f64,
}

fn solar_type_name(t: SolarType) -> &'static str {
    match t {
        SolarType::Total => "total",
        SolarType::Annular => "annular",
        SolarType::Hybrid => "hybrid",
        SolarType::Partial => "partial",
    }
}

fn lunar_type_name(t: LunarType) -> &'static str {
    match t {
        LunarType::Total => "total",
        LunarType::Partial => "partial",
        LunarType::Penumbral => "penumbral",
    }
}

fn feature<'a>(geometry: Geometry<'a>, properties: Properties<'a>) -> Feature<'a> {
    Feature {
        kind: "Feature",
        geometry,
        properties,
    }
}

fn solar_geojson(p: &SolarPath) -> Vec<Feature<'_>> {
    let ty = solar_type_name(p.eclipse_type);
    let central = match p.eclipse_type {
        SolarType::Annular => "the annular phase",
        SolarType::Hybrid => "the central phase",
        _ => "totality",
    };
    let g = &p.greatest;
    let mut features = vec![feature(
        Geometry::Point {
            coordinates: [g.lon_deg, g.lat_deg],
        },
        Properties {
            eclipse: &p.id,
            eclipse_type: ty,
            feature: "greatest_eclipse",
            contact: None,
            description: if p.central {
                "the point of greatest eclipse, on the central line".to_string()
            } else {
                "the point of greatest eclipse: the Earth's limb nearest the shadow's axis"
                    .to_string()
            },
            utc: Some(&g.utc),
            jd_utc: Times::One(g.jd_utc),
            sun_alt_deg: Some(g.sun_alt_deg),
            sun_az_deg: Some(g.sun_az_deg),
            delta_t_s: p.delta_t_s,
        },
    )];
    let lines: [(&'static str, String, &Polyline); 7] = [
        (
            "central_line",
            "where the shadow's axis meets the ground, the middle of the path; jd_utc is when \
             the eclipse is greatest at each point"
                .to_string(),
            &p.central_line,
        ),
        (
            "umbra_north",
            format!(
                "the northern limit of {central}, on the left of the shadow's motion; jd_utc \
                 is when it grazes each point"
            ),
            &p.umbra_north,
        ),
        (
            "umbra_south",
            format!(
                "the southern limit of {central}, on the right of the shadow's motion; jd_utc \
                 is when it grazes each point"
            ),
            &p.umbra_south,
        ),
        (
            "umbra_horizon",
            format!(
                "where {central} is under way with the Sun on the horizon; with the limits it \
                 closes the path's ends"
            ),
            &p.umbra_horizon,
        ),
        (
            "penumbra_north",
            "the northern limit of the partial eclipse".to_string(),
            &p.penumbra_north,
        ),
        (
            "penumbra_south",
            "the southern limit of the partial eclipse".to_string(),
            &p.penumbra_south,
        ),
        (
            "penumbra_horizon",
            "where the partial eclipse begins or ends with the Sun on the horizon; with the \
             limits it bounds everywhere that sees any eclipse"
                .to_string(),
            &p.penumbra_horizon,
        ),
    ];
    for (name, description, line) in lines {
        if line.is_empty() {
            continue;
        }
        features.push(feature(
            Geometry::MultiLineString {
                coordinates: &line.segments,
            },
            Properties {
                eclipse: &p.id,
                eclipse_type: ty,
                feature: name,
                contact: None,
                description,
                utc: None,
                jd_utc: Times::Vertices(&line.jd_utc),
                sun_alt_deg: None,
                sun_az_deg: None,
                delta_t_s: p.delta_t_s,
            },
        ));
    }
    features
}

fn lunar_geojson(p: &LunarPath) -> Vec<Feature<'_>> {
    let ty = lunar_type_name(p.eclipse_type);
    p.sublunar
        .iter()
        .map(|s| {
            let contact = event_code(s.kind);
            feature(
                Geometry::Point {
                    coordinates: [s.lon_deg, s.lat_deg],
                },
                Properties {
                    eclipse: &p.id,
                    eclipse_type: ty,
                    feature: "sublunar_point",
                    contact: Some(contact),
                    description: format!(
                        "the Moon is overhead here at {contact}, and above the horizon within \
                         about 89 degrees of this point"
                    ),
                    utc: Some(&s.utc),
                    jd_utc: Times::One(s.jd_utc),
                    sun_alt_deg: None,
                    sun_az_deg: None,
                    delta_t_s: p.delta_t_s,
                },
            )
        })
        .collect()
}

/// The engine's path as an RFC 7946 FeatureCollection: `[lon, lat]` coordinates exactly
/// as the engine gives them (already split at the antimeridian), one feature per line or
/// point, each with the eclipse, what the feature is and the UTC Julian date of every
/// vertex in its properties. Empty lines are left out.
pub fn geojson(path: &EclipsePath) -> FeatureCollection<'_> {
    FeatureCollection {
        kind: "FeatureCollection",
        features: match path {
            EclipsePath::Solar(p) => solar_geojson(p),
            EclipsePath::Lunar(p) => lunar_geojson(p),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(extra: &[&str]) -> Result<Args, clap::Error> {
        use clap::Parser;
        #[derive(clap::Parser)]
        struct Wrap {
            #[command(flatten)]
            a: Args,
        }
        let mut v = vec!["eclipse", "2024-04-08-solar"];
        v.extend_from_slice(extra);
        Wrap::try_parse_from(v).map(|w| w.a)
    }

    #[test]
    fn the_path_is_json_by_default_and_geojson_needs_it() {
        assert_eq!(output(&args(&[]).unwrap()).unwrap(), Output::Text);
        assert_eq!(output(&args(&["--json"]).unwrap()).unwrap(), Output::Json);
        assert_eq!(
            output(&args(&["--path"]).unwrap()).unwrap(),
            Output::PathJson
        );
        assert_eq!(
            output(&args(&["--path", "--format", "geojson"]).unwrap()).unwrap(),
            Output::PathGeojson
        );
        assert!(output(&args(&["--format", "geojson"]).unwrap()).is_err());
        assert!(output(&args(&["--path", "--format", "text"]).unwrap()).is_err());
        // The path is the same for everyone: an observer with it is a usage error.
        assert!(args(&["--path", "--lat", "32.78", "--lon", "-96.8"]).is_err());
        assert!(args(&["--lat", "32.78"]).is_err(), "--lat needs --lon");
        assert!(
            args(&["--height", "100"]).is_err(),
            "--height needs a position"
        );
        assert!(args(&["--json", "--format", "json"]).is_err());
    }
}
