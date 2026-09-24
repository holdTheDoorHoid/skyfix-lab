//! `skyfix eclipses`: every eclipse in a window, and which of them a place can see.
//! OWNER: cli agent.
//!
//! `skyfix_almanac::eclipses::Eclipses::find` (EXPLORER_API.md "Wave 2 — eclipses"
//! `eclipses`; model and validation in docs/ACCURACY.md section 12), called as the WASM
//! export calls it (DUT1 = 0). With `--lat --lon` the command adds, for each eclipse,
//! `Eclipses::local` at that place (the export `eclipse_local`): whether it is seen there
//! and its local maximum. Nothing here computes an eclipse; it filters by `--kind`,
//! words the results and prints them.
//!
//! `--format json` is the engine's `EclipseList` (its `eclipses` filtered by `--kind`),
//! with `kinds`, the kinds kept, and — with an observer — `local`, the `EclipseLocal` of
//! each listed eclipse in the same order. The words shared with `skyfix eclipse` (type
//! names, event names, percentages) live here too.

use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use skyfix_almanac::eclipses::{
    Eclipse, EclipseList, EclipseLocal, Eclipses, LocalEvent, LocalEventKind, LocalType,
    LunarLocal, LunarType, SolarLocal, SolarType, Visibility,
};
use skyfix_core::types::LatLon;
use skyfix_ephemeris::topocentric::Site;

use super::args::{FormatArgs, OptionalSiteArgs, When, parse_when, window};
use super::text;
use crate::exit;
use crate::report;

/// `--kind` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum KindChoice {
    /// Solar and lunar eclipses.
    #[default]
    All,
    /// Solar eclipses only.
    Solar,
    /// Lunar eclipses only.
    Lunar,
}

impl KindChoice {
    pub fn keeps(self, e: &Eclipse) -> bool {
        match self {
            KindChoice::All => true,
            KindChoice::Solar => matches!(e, Eclipse::Solar(_)),
            KindChoice::Lunar => matches!(e, Eclipse::Lunar(_)),
        }
    }

    /// The kinds kept, as the engine spells an eclipse's `kind`.
    pub fn kinds(self) -> Vec<&'static str> {
        match self {
            KindChoice::All => vec!["solar", "lunar"],
            KindChoice::Solar => vec!["solar"],
            KindChoice::Lunar => vec!["lunar"],
        }
    }

    fn words(self) -> &'static str {
        match self {
            KindChoice::All => "solar and lunar",
            KindChoice::Solar => "solar only",
            KindChoice::Lunar => "lunar only",
        }
    }
}

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Start: YYYY-MM-DD (00:00 UTC that day) or an RFC 3339 UTC instant. An eclipse is
    /// listed when its greatest eclipse falls in the window.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub from: When,
    /// End: YYYY-MM-DD (through the END of that day, UTC) or an RFC 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub to: When,
    /// Which eclipses to list.
    #[arg(long, value_enum, default_value_t = KindChoice::All, value_name = "KIND")]
    pub kind: KindChoice,
    #[command(flatten)]
    pub observer: OptionalSiteArgs,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `--format json`: the engine's list, filtered, and what the observer sees of each.
#[derive(Serialize)]
struct ListJson<'a> {
    #[serde(flatten)]
    list: &'a EclipseList,
    kinds: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local: Option<&'a [EclipseLocal]>,
}

/// The engine's eclipses in `[start, end]` of the kinds asked for, or why there are none
/// to look at: a window wholly outside the coverage is a usage error, as for `phases`.
/// A window that only reaches past it is clipped, and the list says so (`truncated`).
pub fn list(engine: &Eclipses, start: f64, end: f64, kind: KindChoice) -> Result<EclipseList> {
    let mut list = engine.find(start, end).map_err(|e| anyhow!("{e}"))?;
    if list.jd_start > list.jd_end {
        bail!(
            "{} to {} is outside the eclipses' coverage, {} to {} (the Moon's)",
            text::utc(start),
            text::utc(end),
            list.coverage_start_utc,
            list.coverage_end_utc
        );
    }
    list.eclipses.retain(|e| kind.keeps(e));
    Ok(list)
}

pub fn run(a: &Args) -> Result<u8> {
    let (start, end) = window(a.from, a.to, 0)?;
    let engine = Eclipses::new();
    let list = list(&engine, start, end, a.kind)?;
    let site = a.observer.site();
    let local = match &site {
        Some(site) => Some(
            list.eclipses
                .iter()
                .map(|e| engine.local(e.id(), site))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| anyhow!("{e}"))?,
        ),
        None => None,
    };
    if list.truncated {
        eprintln!(
            "note: the window was clipped to the eclipses' coverage, {} to {}",
            list.coverage_start_utc, list.coverage_end_utc
        );
    }
    if a.format.is_json() {
        let doc = ListJson {
            list: &list,
            kinds: a.kind.kinds(),
            local: local.as_deref(),
        };
        report::emit_line(&serde_json::to_string_pretty(&doc)?)?;
    } else {
        report::emit(&render(&list, a.kind, site.as_ref(), local.as_deref()))?;
    }
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// Words shared with `skyfix eclipse`
// ---------------------------------------------------------------------------

/// `total`, `annular`, `hybrid`, `partial`, `penumbral`.
pub fn type_word(e: &Eclipse) -> &'static str {
    match e {
        Eclipse::Solar(s) => match s.eclipse_type {
            SolarType::Total => "total",
            SolarType::Annular => "annular",
            SolarType::Hybrid => "hybrid",
            SolarType::Partial => "partial",
        },
        Eclipse::Lunar(l) => match l.eclipse_type {
            LunarType::Total => "total",
            LunarType::Partial => "partial",
            LunarType::Penumbral => "penumbral",
        },
    }
}

/// `TOTAL SOLAR ECLIPSE`, `PENUMBRAL LUNAR ECLIPSE`.
pub fn title(e: &Eclipse) -> String {
    let kind = match e {
        Eclipse::Solar(_) => "SOLAR",
        Eclipse::Lunar(_) => "LUNAR",
    };
    format!("{} {kind} ECLIPSE", type_word(e).to_uppercase())
}

/// The engine's name of a local event: `c1`, `max`, `u2`, `sunrise`.
pub fn event_code(kind: LocalEventKind) -> &'static str {
    match kind {
        LocalEventKind::C1 => "c1",
        LocalEventKind::C2 => "c2",
        LocalEventKind::Max => "max",
        LocalEventKind::C3 => "c3",
        LocalEventKind::C4 => "c4",
        LocalEventKind::P1 => "p1",
        LocalEventKind::U1 => "u1",
        LocalEventKind::U2 => "u2",
        LocalEventKind::U3 => "u3",
        LocalEventKind::U4 => "u4",
        LocalEventKind::P4 => "p4",
        LocalEventKind::Sunrise => "sunrise",
        LocalEventKind::Sunset => "sunset",
        LocalEventKind::Moonrise => "moonrise",
        LocalEventKind::Moonset => "moonset",
    }
}

/// What a local event is, in words. `annular` names a solar eclipse's central phase.
pub fn event_words(kind: LocalEventKind, annular: bool) -> &'static str {
    match kind {
        LocalEventKind::C1 | LocalEventKind::U1 => "partial eclipse begins",
        LocalEventKind::C2 if annular => "annular phase begins",
        LocalEventKind::C3 if annular => "annular phase ends",
        LocalEventKind::C2 | LocalEventKind::U2 => "totality begins",
        LocalEventKind::C3 | LocalEventKind::U3 => "totality ends",
        LocalEventKind::Max => "greatest eclipse",
        LocalEventKind::C4 | LocalEventKind::U4 => "partial eclipse ends",
        LocalEventKind::P1 => "penumbral eclipse begins",
        LocalEventKind::P4 => "penumbral eclipse ends",
        LocalEventKind::Sunrise => "sunrise",
        LocalEventKind::Sunset => "sunset",
        LocalEventKind::Moonrise => "moonrise",
        LocalEventKind::Moonset => "moonset",
    }
}

/// A fraction as a percentage that never claims 100 % or 0 % when it is not (the web
/// UI's rule): `100%`, `99.4%`, `58%`, `under 1%`.
pub fn percent(fraction: f64) -> String {
    if !fraction.is_finite() {
        return "-".to_string();
    }
    if fraction >= 1.0 {
        "100%".to_string()
    } else if fraction <= 0.0 {
        "0%".to_string()
    } else if fraction > 0.99 {
        format!("{:.1}%", (fraction * 1000.0).floor() / 10.0)
    } else if fraction < 0.01 {
        "under 1%".to_string()
    } else {
        format!("{:.0}%", fraction * 100.0)
    }
}

pub fn find(events: &[LocalEvent], kind: LocalEventKind) -> Option<&LocalEvent> {
    events.iter().find(|e| e.kind == kind)
}

/// `Sun alt +67 13.8, Az 186 20.4`.
pub fn alt_az(body: &str, e: &LocalEvent) -> String {
    format!(
        "{body} alt {}, Az {}",
        text::alt_inline(e.alt_deg),
        text::dm360(e.az_deg).trim_start()
    )
}

/// `the Sun rises at 2024-10-02T12:03:00Z and sets at ...Z during it`, from the local
/// rise and set events; `None` when there are neither.
pub fn rise_set_words(
    body: &str,
    events: &[LocalEvent],
    rise: LocalEventKind,
    set: LocalEventKind,
) -> Option<String> {
    match (find(events, rise), find(events, set)) {
        (Some(r), Some(s)) if r.jd_utc < s.jd_utc => Some(format!(
            "the {body} rises at {} and sets at {} during it",
            text::utc(r.jd_utc),
            text::utc(s.jd_utc)
        )),
        (Some(r), Some(s)) => Some(format!(
            "the {body} sets at {} and rises again at {} during it",
            text::utc(s.jd_utc),
            text::utc(r.jd_utc)
        )),
        (Some(r), None) => Some(format!(
            "the {body} rises at {} during it",
            text::utc(r.jd_utc)
        )),
        (None, Some(s)) => Some(format!(
            "the {body} sets at {} during it",
            text::utc(s.jd_utc)
        )),
        (None, None) => None,
    }
}

/// The part of a place's totality or annularity (c2 to c3) that comes with the Sun up.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CentralSeen {
    /// `jd_utc` of its start and end: c2 or the sunrise during it, c3 or the sunset.
    pub start: f64,
    pub end: f64,
    /// The whole central phase is seen.
    pub all: bool,
}

/// What of the central phase is seen with the Sun up, or `None` when the place has no
/// central phase or sees none of it. When the Sun sets (or rises) during totality, the
/// part before the sunset (or after the sunrise) is still totality, and still safe to
/// look at.
pub fn central_seen(l: &SolarLocal) -> Option<CentralSeen> {
    let c2 = find(&l.events, LocalEventKind::C2)?;
    let c3 = find(&l.events, LocalEventKind::C3)?;
    let during = |kind: LocalEventKind| {
        l.events
            .iter()
            .find(|e| e.kind == kind && e.jd_utc > c2.jd_utc && e.jd_utc < c3.jd_utc)
            .map(|e| e.jd_utc)
    };
    let start = if c2.visible {
        c2.jd_utc
    } else {
        during(LocalEventKind::Sunrise)?
    };
    let end = if c3.visible {
        c3.jd_utc
    } else {
        during(LocalEventKind::Sunset)?
    };
    (end > start).then_some(CentralSeen {
        start,
        end,
        all: c2.visible && c3.visible,
    })
}

/// What a place sees of an eclipse, in one sentence: whether it is seen and its local
/// maximum.
pub fn here_words(local: &EclipseLocal) -> String {
    match local {
        EclipseLocal::Solar(l) => solar_here(l),
        EclipseLocal::Lunar(l) => lunar_here(l),
    }
}

fn solar_here(l: &SolarLocal) -> String {
    if l.visibility == Visibility::None {
        return "no eclipse: the Moon's shadow misses this place".to_string();
    }
    let at_max = find(&l.events, LocalEventKind::Max).map_or_else(String::new, |m| {
        format!(
            "maximum {}, magnitude {:.3} ({} of the Sun's area covered), {}",
            text::utc(m.jd_utc),
            l.magnitude,
            percent(l.obscuration),
            alt_az("Sun", m)
        )
    });
    if l.visibility == Visibility::BelowHorizon {
        return format!("not seen: the Sun is below the horizon throughout; {at_max}");
    }
    let annular = l.local_type == LocalType::Annular;
    let what = match l.local_type {
        LocalType::Total | LocalType::Annular => {
            let word = if annular { "annular" } else { "total" };
            let duration = l
                .central_duration_s
                .map_or_else(|| "?".to_string(), text::duration_s);
            match central_seen(l) {
                Some(seen) if seen.all => format!("{word} for {duration}"),
                Some(seen) => format!(
                    "{word} for {duration}, {} of it with the Sun up",
                    text::duration_s((seen.end - seen.start) * 86_400.0)
                ),
                None => format!("{word} for {duration}, but with the Sun down then"),
            }
        }
        LocalType::Partial | LocalType::None => "partial".to_string(),
    };
    let sun = if l.visibility == Visibility::Visible {
        "with the Sun up throughout".to_string()
    } else {
        rise_set_words(
            "Sun",
            &l.events,
            LocalEventKind::Sunrise,
            LocalEventKind::Sunset,
        )
        .unwrap_or_else(|| "with the Sun down for part of it".to_string())
    };
    let mut s = format!("{what}, {sun}; {at_max}");
    if let Some(v) = &l.visible_max
        && v.kind != LocalEventKind::Max
    {
        s.push_str(&format!(
            "; the most seen is at {} {}, {} covered",
            event_words(v.kind, annular),
            text::utc(v.jd_utc),
            percent(v.obscuration.unwrap_or(0.0))
        ));
    }
    s
}

fn lunar_here(l: &LunarLocal) -> String {
    let at_max = find(&l.events, LocalEventKind::Max).map_or_else(String::new, |m| {
        format!(
            "greatest eclipse {}, {}{}",
            text::utc(m.jd_utc),
            alt_az("Moon", m),
            if m.visible || l.visibility == Visibility::BelowHorizon {
                ""
            } else {
                ", below the horizon"
            }
        )
    });
    match l.visibility {
        Visibility::Visible => format!("all of it seen, with the Moon up throughout; {at_max}"),
        Visibility::PartlyBelowHorizon => {
            let when = rise_set_words(
                "Moon",
                &l.events,
                LocalEventKind::Moonrise,
                LocalEventKind::Moonset,
            )
            .unwrap_or_else(|| "the Moon is down for part of it".to_string());
            format!("partly seen: {when}; {at_max}")
        }
        Visibility::BelowHorizon => {
            format!("not seen: the Moon is below the horizon throughout; {at_max}")
        }
        Visibility::None => "no eclipse here".to_string(),
    }
}

/// Something of the eclipse can be seen from the place: the body up for part of it.
pub fn seen(local: &EclipseLocal) -> bool {
    let v = match local {
        EclipseLocal::Solar(l) => l.visibility,
        EclipseLocal::Lunar(l) => l.visibility,
    };
    matches!(v, Visibility::Visible | Visibility::PartlyBelowHorizon)
}

/// `32 46.80' N, 096 48.00' W (32.780000, -96.800000), 0 m above the WGS84 ellipsoid`.
pub fn site_words(site: &Site) -> String {
    let p = LatLon {
        lat_deg: site.lat_deg,
        lon_deg: site.lon_deg,
    };
    format!(
        "{} ({}), {} m above the WGS84 ellipsoid",
        report::format_position(p),
        report::format_position_decimal(p),
        site.height_m
    )
}

/// `mag`, `pen.mag`: a solar eclipse's magnitude, or a lunar one's umbral and penumbral.
fn magnitudes(e: &Eclipse) -> (String, String) {
    match e {
        Eclipse::Solar(s) => (format!("{:.4}", s.magnitude), "-".to_string()),
        Eclipse::Lunar(l) => (
            text::fixed(l.umbral_magnitude, 4),
            text::fixed(l.penumbral_magnitude, 4),
        ),
    }
}

fn gamma(e: &Eclipse) -> f64 {
    match e {
        Eclipse::Solar(s) => s.gamma,
        Eclipse::Lunar(l) => l.gamma,
    }
}

fn saros(e: &Eclipse) -> i64 {
    match e {
        Eclipse::Solar(s) => s.saros,
        Eclipse::Lunar(l) => l.saros,
    }
}

pub fn render(
    list: &EclipseList,
    kind: KindChoice,
    site: Option<&Site>,
    local: Option<&[EclipseLocal]>,
) -> String {
    let mut out = format!(
        "ECLIPSES  {} to {}, {}\n",
        text::utc(list.jd_start),
        text::utc(list.jd_end),
        kind.words()
    );
    if list.truncated {
        out.push_str(&format!(
            "Coverage  the window was clipped to the eclipses' coverage, {} to {}\n",
            list.coverage_start_utc, list.coverage_end_utc
        ));
    }
    if let Some(site) = site {
        out.push_str(&format!("Observer  {}\n", site_words(site)));
    }
    out.push('\n');
    if list.eclipses.is_empty() {
        out.push_str("  none in this window\n");
    } else {
        out.push_str(&format!(
            "  {}{}{}{:>9}{:>9}{:>9}{:>7}\n",
            report::pad("id", 18),
            report::pad("type", 11),
            report::pad("greatest eclipse", 20),
            "mag",
            "pen.mag",
            "gamma",
            "saros"
        ));
    }
    for (i, e) in list.eclipses.iter().enumerate() {
        let (mag, pen) = magnitudes(e);
        out.push_str(&format!(
            "  {}{}{}{mag:>9}{pen:>9}{:>9}{:>7}\n",
            report::pad(e.id(), 18),
            report::pad(type_word(e), 11),
            text::utc(e.jd_utc()),
            text::signed_fixed(gamma(e), 4),
            saros(e)
        ));
        if let Some(l) = local.and_then(|l| l.get(i)) {
            for line in report::wrap(&format!("here: {}", here_words(l)), 80, "      ") {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }

    out.push('\n');
    let n = list.eclipses.len();
    let solar = list
        .eclipses
        .iter()
        .filter(|e| matches!(e, Eclipse::Solar(_)))
        .count();
    let mut summary = match kind {
        KindChoice::All => format!(
            "{n} eclipse{} in the window: {solar} solar, {} lunar.",
            plural(n),
            n - solar
        ),
        KindChoice::Solar => format!("{n} solar eclipse{} in the window.", plural(n)),
        KindChoice::Lunar => format!("{n} lunar eclipse{} in the window.", plural(n)),
    };
    if let Some(local) = local {
        let seen = local.iter().filter(|l| seen(l)).count();
        summary.push_str(&format!(
            " Seen from the observer, in whole or in part: {seen} of {n}."
        ));
    }
    for line in report::wrap(&summary, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
    out.push('\n');

    let mut notes = String::from(
        "mag is a solar eclipse's magnitude (for a total, annular or hybrid eclipse the Moon's \
         apparent diameter over the Sun's at greatest eclipse, for a partial one the fraction \
         of the Sun's diameter covered there) or a lunar eclipse's umbral magnitude, the \
         fraction of the Moon's diameter inside the Earth's dark shadow (negative when the \
         Moon misses it); pen.mag is a lunar eclipse's penumbral magnitude. gamma is how far \
         the shadow's axis passes from the Earth's centre (solar), or the Moon's centre from \
         the shadow's axis (lunar), at greatest eclipse, in Earth radii, positive north; saros \
         is NASA's numbering. Times are UTC to the nearest second (--format json carries the \
         milliseconds). Every eclipse of 1990-2060 is NASA's Five Millennium Canon's, of the \
         same type and saros (docs/ACCURACY.md section 12). skyfix eclipse ID gives an \
         eclipse's contacts, what a place sees of it and its path.",
    );
    if local.is_some() {
        notes.push_str(
            " The here lines say what the observer sees: a solar eclipse's maximum is its \
             greatest magnitude at that place, a lunar eclipse's greatest eclipse is the same instant \
             everywhere. Altitudes (alt) and azimuths (Az) are the body's centre, geometric, \
             with no refraction, from the WGS84 site (CONVENTIONS 13.2), and the body counts \
             as up above its rise and set altitude: -50' for the Sun, -(34' + SD) for the \
             Moon. Local times assume each eclipse's Delta-T (--format json: delta_t_s); for \
             a future eclipse the true value will differ, and each second of difference moves \
             a local contact by up to about a second.",
        );
    }
    for line in report::wrap(&notes, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentages_never_claim_all_or_nothing_when_it_is_not() {
        assert_eq!(percent(1.0), "100%");
        assert_eq!(percent(0.9999), "99.9%");
        assert_eq!(percent(0.994), "99.4%");
        assert_eq!(percent(0.58), "58%");
        assert_eq!(percent(0.004), "under 1%");
        assert_eq!(percent(0.0), "0%");
    }

    #[test]
    fn event_words_name_the_central_phase() {
        assert_eq!(event_words(LocalEventKind::C2, false), "totality begins");
        assert_eq!(
            event_words(LocalEventKind::C2, true),
            "annular phase begins"
        );
        assert_eq!(event_words(LocalEventKind::C3, true), "annular phase ends");
        assert_eq!(event_words(LocalEventKind::U2, false), "totality begins");
        assert_eq!(
            event_words(LocalEventKind::U1, false),
            "partial eclipse begins"
        );
        assert_eq!(event_code(LocalEventKind::Moonset), "moonset");
    }
}
