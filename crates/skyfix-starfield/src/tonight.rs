//! "Tonight": what the night at a place offers, ranked, with a sentence (EXPLORER_API.md,
//! "Deep sky", `tonight`).
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6). Every ranking here is a guide
//! built from stated rules, not an accuracy claim.
//!
//! - **The night** ([`crate::observe::Night`]): local mean noon to noon; the darkness
//!   window (the Sun below -18 degrees, or the darkest stretch when it never gets that
//!   low) and the Sun's and the Moon's events, from the events crate.
//! - **Planets**: sampled every 10 minutes while the Sun is below -6 degrees (Mercury and
//!   Venus are twilight objects); the highest point, how long each is 10 degrees up, its
//!   magnitude.
//! - **Deep-sky objects**: each object's best time, hours above 20 degrees in darkness,
//!   the Moon's light on it (Krisciunas & Schaefer 1991) and the instrument guide of
//!   [`crate::dso::instrument`], scored
//!   `100 x base(instrument) x sin(best altitude) x (0.5 + 0.5 min(1, hours / 4)) x
//!   10^(-0.2 x moon brightening) x 1.2 if it has a common name`, with
//!   `base` = 1.0 eye, 0.8 binoculars, 0.5 telescope, 0.35 camera; the best `limit`.
//! - **Meteor showers** active that night ([`crate::showers::night_activity`]), listed
//!   when the expected rate reaches half a meteor an hour or the shower is variable.
//! - **The Milky Way's core** (Sagittarius A*) through the darkness.
//! - **The summary**: plain sentences. Times inside them are tokens `{jd:2461308.517173}`
//!   (a UTC Julian date) that the interface replaces with a time in its own zone.
//!
//! Natively the whole call takes about 20 ms (`tests/deepsky_timing.rs`).

use serde::Serialize;
use skyfix_almanac::events::SkyPhase;
use skyfix_almanac::sky::sample_bodies;
use skyfix_ephemeris::body::{BodyEphemeris, PLANETS, Sky};
use skyfix_ephemeris::topocentric::Site;

use crate::dso::{self, Instrument, MoonEffect};
use crate::extinction::Conditions;
use crate::observe::{
    Darkness, Frame, Instant, Night, NightSummary, Sighting, compass, place_words, take_ordered,
};
use crate::showers::{self, ShowerNight};

/// Sagittarius A*, ICRS degrees: where the Milky Way's core is.
pub const GALACTIC_CENTRE_RA_DEG: f64 = 266.416_817;
pub const GALACTIC_CENTRE_DEC_DEG: f64 = -29.007_825;

/// Deep-sky objects listed when the caller does not say.
pub const DEFAULT_LIMIT: usize = 12;
/// Planet altitude that counts as "up", degrees.
pub const PLANET_UP_DEG: f64 = 10.0;

/// A planet through the night.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanetTonight {
    pub body: &'static str,
    pub magnitude: Option<f64>,
    /// Highest point while the Sun is below -6 degrees.
    pub best: Option<Sighting>,
    /// First and last moment it is 10 degrees up in that time.
    pub up_from: Option<Instant>,
    pub up_until: Option<Instant>,
    pub hours_up: f64,
    pub reason: String,
}

/// A deep-sky object worth a look.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DsoTonight {
    pub id: &'static str,
    pub label: String,
    pub name: Option<&'static str>,
    #[serde(rename = "type")]
    pub kind: dso::DsoType,
    pub category: &'static str,
    pub constellation: &'static str,
    pub magnitude: Option<f64>,
    pub best: Sighting,
    pub hours_above_20: f64,
    pub moon: Option<MoonEffect>,
    pub instrument: Instrument,
    pub score: f64,
    pub reason: String,
}

/// The Milky Way's core.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoreTonight {
    pub best: Option<Sighting>,
    pub hours_above_20: f64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tonight {
    pub night: NightSummary,
    pub conditions: Conditions,
    pub planets: Vec<PlanetTonight>,
    pub deep_sky: Vec<DsoTonight>,
    pub showers: Vec<ShowerNight>,
    pub milky_way_core: CoreTonight,
    /// Plain sentences; `{jd:...}` tokens stand for times.
    pub summary: String,
    /// What the numbers are: the models behind them.
    pub notes: Vec<&'static str>,
    pub errors: Vec<String>,
}

pub const NOTES: [&str; 3] = [
    "Rankings and rates are estimates from stated rules (EXPLORER_API.md, \"Deep sky\").",
    "Moonlight from Krisciunas & Schaefer (1991); extinction from Pickering's air mass.",
    "Meteor rates: ZHR x sin(radiant altitude) x r^(LM - 6.5); real rates vary.",
];

/// A time token for the summary.
fn tok(jd: f64) -> String {
    format!("{{jd:{jd:.6}}}")
}

/// A number with `digits` decimals, and a proper minus sign.
fn num(x: f64, digits: usize) -> String {
    format!("{x:.digits$}").replace('-', "−")
}

/// "high in the south (62° at best)".
fn place_at(alt: f64, az: f64) -> String {
    let mut s = place_words(alt, az);
    s.push_str(" (");
    s.push_str(&num(alt, 0));
    s.push_str("° at best)");
    s
}

fn list_words(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        n => {
            let mut s = items[..n - 1].join(", ");
            s.push_str(" and ");
            s.push_str(&items[n - 1]);
            s
        }
    }
}

fn planets_tonight(
    sky: &Sky,
    site: &Site,
    night: &Night,
    errors: &mut Vec<String>,
) -> Vec<PlanetTonight> {
    let Some((a, b)) = night.run(&|p| {
        matches!(
            p,
            SkyPhase::Nautical | SkyPhase::Astronomical | SkyPhase::Night
        )
    }) else {
        return Vec::new();
    };
    let s = match sample_bodies(sky, site, &PLANETS, a, b, 10.0) {
        Ok(s) => s,
        Err(e) => {
            errors.push(e.to_string());
            return Vec::new();
        }
    };
    for e in &s.errors {
        errors.push(e.message.clone());
    }
    let mid = 0.5 * (a + b);
    let mut out = Vec::new();
    for body in &s.bodies {
        let Some(name) = PLANETS.iter().find(|p| **p == body.body) else {
            continue;
        };
        let magnitude = sky
            .apparent_state(name, mid)
            .ok()
            .and_then(|st| st.magnitude);
        let (mut best, mut first, mut last, mut up) = (None::<usize>, None, None, 0usize);
        for (k, &t) in s.jd_utc.iter().enumerate() {
            let alt = body.alt_apparent_deg[k];
            if best.is_none_or(|j| alt > body.alt_apparent_deg[j]) {
                best = Some(k);
            }
            if alt >= PLANET_UP_DEG {
                first.get_or_insert(t);
                last = Some(t);
                up += 1;
            }
        }
        let best = best.filter(|&k| body.alt_apparent_deg[k] > 0.0);
        let mut reason = String::from(*name);
        if let Some(m) = magnitude {
            reason.push_str(", magnitude ");
            reason.push_str(&num(m, 1));
        }
        match best {
            Some(k) if body.alt_apparent_deg[k] >= PLANET_UP_DEG => {
                reason.push_str(", ");
                reason.push_str(&place_at(body.alt_apparent_deg[k], body.az_deg[k]));
            }
            Some(_) => reason.push_str(": below 10° in the dark hours"),
            None => reason.push_str(": not up while the sky is dark"),
        }
        out.push(PlanetTonight {
            body: name,
            magnitude,
            best: best.map(|k| Sighting {
                jd_utc: s.jd_utc[k],
                utc: skyfix_core::time::format_utc(s.jd_utc[k]),
                alt_deg: body.alt_apparent_deg[k],
                az_deg: body.az_deg[k],
                direction: compass(body.az_deg[k]),
            }),
            up_from: first.map(Instant::new),
            up_until: last.map(Instant::new),
            hours_up: up as f64 * 10.0 / 60.0,
            reason,
        });
    }
    out
}

fn deep_sky_tonight(
    night: &Night,
    conditions: &Conditions,
    limit: usize,
) -> Result<Vec<DsoTonight>, String> {
    let Some((a, b)) = night.window() else {
        return Ok(Vec::new());
    };
    let frame = Frame::at(0.5 * (a + b)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for d in dso::catalog().map_err(|e| e.to_string())? {
        let (ra, dec) = frame.apparent(d.ra_j2000_deg, d.dec_j2000_deg);
        let v = dso::visibility_of(ra, dec, night, conditions, Some(d));
        let (Some(best), Some(instrument)) = (v.best, v.instrument) else {
            continue;
        };
        if v.hours_above_20 <= 0.0 {
            continue;
        }
        let (base, how) = match instrument {
            Instrument::Eye => (1.0, "naked eye"),
            Instrument::Binoculars => (0.8, "binoculars"),
            Instrument::Telescope => (0.5, "a small telescope"),
            Instrument::Camera => (0.35, "a camera"),
        };
        let moon = v.moon.map_or(0.0, |m| m.brightening_mag);
        let score = 100.0
            * base
            * best.alt_deg.to_radians().sin()
            * (0.5 + 0.5 * (v.hours_above_20 / 4.0).min(1.0))
            * crate::extinction::exp10(-0.2 * moon)
            * if d.name.is_some() { 1.2 } else { 1.0 };
        let mut reason = place_at(best.alt_deg, best.az_deg);
        reason.push_str(", ");
        reason.push_str(&num(v.hours_above_20, 1));
        reason.push_str(" h above 20° in darkness; ");
        reason.push_str(how);
        reason.push_str(match moon {
            m if m < 0.3 => "",
            m if m < 1.0 => "; some moonlight",
            _ => "; washed out by moonlight",
        });
        let mut r = reason.chars();
        let reason = r.next().map_or_else(String::new, |f| {
            f.to_uppercase().collect::<String>() + r.as_str()
        });
        out.push(DsoTonight {
            id: d.id,
            label: d.label.clone(),
            name: d.name,
            kind: d.kind,
            category: d.category,
            constellation: d.constellation,
            magnitude: d.magnitude,
            best,
            hours_above_20: v.hours_above_20,
            moon: v.moon,
            instrument,
            score,
            reason,
        });
    }
    let keys: Vec<f64> = out.iter().map(|d| d.score).collect();
    Ok(take_ordered(out, &keys, limit))
}

/// Tonight at `site`, for the night `jd_utc` belongs to ([`Night::containing`]).
pub fn tonight(
    sky: &Sky,
    site: &Site,
    jd_utc: f64,
    conditions: &Conditions,
    limit: Option<usize>,
) -> Result<Tonight, String> {
    let night = Night::containing(sky, site, jd_utc)?;
    let mut errors = Vec::new();
    let planets = planets_tonight(sky, site, &night, &mut errors);
    let deep_sky = deep_sky_tonight(
        &night,
        conditions,
        limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 60),
    )?;

    let mut shower_list = Vec::new();
    for s in showers::table().map_err(|e| e.to_string())? {
        match showers::night_activity(sky, s, &night, conditions) {
            Ok(Some(n)) if n.expected_rate_per_hour >= 0.5 || s.variable => shower_list.push(n),
            Ok(_) => {}
            Err(e) => errors.push(e),
        }
    }
    let keys: Vec<f64> = shower_list
        .iter()
        .map(|n| n.expected_rate_per_hour)
        .collect();
    let n = keys.len();
    let shower_list = take_ordered(shower_list, &keys, n);

    let core = {
        let mid = night
            .window()
            .map_or(night.start_jd + 0.5, |(a, b)| 0.5 * (a + b));
        let frame = Frame::at(mid).map_err(|e| e.to_string())?;
        let (ra, dec) = frame.apparent(GALACTIC_CENTRE_RA_DEG, GALACTIC_CENTRE_DEC_DEG);
        let v = dso::visibility_of(ra, dec, &night, conditions, None);
        let mut reason = String::from("The Milky Way's core ");
        match &v.best {
            Some(b) if v.hours_above_20 > 0.0 => {
                reason.push_str("is ");
                reason.push_str(&place_at(b.alt_deg, b.az_deg));
                reason.push_str(", ");
                reason.push_str(&num(v.hours_above_20, 1));
                reason.push_str(" h above 20° in darkness");
            }
            Some(_) => reason.push_str("stays below 20° in the dark hours"),
            None => reason.push_str("is not up while the sky is dark"),
        }
        CoreTonight {
            best: v.best,
            hours_above_20: v.hours_above_20,
            reason,
        }
    };

    let summary = summary(&night, &planets, &deep_sky, &shower_list, &core);
    Ok(Tonight {
        night: night.summary(),
        conditions: *conditions,
        planets,
        deep_sky,
        showers: shower_list,
        milky_way_core: core,
        summary,
        notes: NOTES.to_vec(),
        errors,
    })
}

fn summary(
    night: &Night,
    planets: &[PlanetTonight],
    deep: &[DsoTonight],
    showers: &[ShowerNight],
    core: &CoreTonight,
) -> String {
    let mut s = String::new();
    match &night.dark {
        Some(w) => {
            s.push_str(if w.kind == Darkness::Night {
                "Dark from "
            } else {
                "The sky never gets fully dark tonight; it is darkest from "
            });
            s.push_str(&tok(w.start.jd_utc));
            s.push_str(" to ");
            s.push_str(&tok(w.end.jd_utc));
            s.push_str(" (");
            s.push_str(&num(w.hours, 1));
            s.push_str(" hours).");
        }
        None => s.push_str("The Sun stays too high for a dark sky tonight."),
    }
    let m = &night.moon;
    s.push_str(" The Moon is ");
    if m.illuminated_fraction < 0.03 {
        s.push_str("new: a dark night.");
    } else {
        s.push_str(m.phase);
        s.push_str(", ");
        s.push_str(&num(m.illuminated_fraction * 100.0, 0));
        s.push_str("% lit");
        if night.dark.is_none() {
            s.push('.');
        } else if m.up_hours < 0.1 {
            s.push_str(", and down during the dark hours.");
        } else if m.down_hours < 0.1 {
            s.push_str(", and up all through the dark hours");
            s.push_str(if m.illuminated_fraction > 0.5 {
                ": faint objects will be hard."
            } else {
                "."
            });
        } else {
            let mut events: Vec<(f64, &str)> = Vec::new();
            if let Some(r) = &m.rise {
                events.push((r.jd_utc, "rises"));
            }
            if let Some(st) = &m.set {
                events.push((st.jd_utc, "sets"));
            }
            if events.len() == 2 && events[1].0 < events[0].0 {
                events.swap(0, 1);
            }
            for (k, (t, what)) in events.iter().enumerate() {
                s.push_str(if k == 0 { "; it " } else { " and " });
                s.push_str(what);
                s.push_str(" at ");
                s.push_str(&tok(*t));
            }
            s.push_str(", leaving ");
            s.push_str(&num(m.down_hours, 1));
            s.push_str(" dark hours without it.");
        }
    }
    let item = |name: &str, best: Option<&Sighting>, extra: &str| {
        let mut t = String::from(name);
        t.push_str(extra);
        if let Some(b) = best {
            t.push_str(if extra.is_empty() { " (" } else { ", " });
            t.push_str(&place_words(b.alt_deg, b.az_deg));
            t.push_str(", best near ");
            t.push_str(&tok(b.jd_utc));
            t.push(')');
        } else if !extra.is_empty() {
            t.push(')');
        }
        t
    };
    let up: Vec<String> = planets
        .iter()
        .filter(|p| p.hours_up > 0.0)
        .map(|p| item(p.body, p.best.as_ref(), ""))
        .collect();
    if !up.is_empty() {
        s.push_str(" Planets: ");
        s.push_str(&list_words(&up));
        s.push('.');
    }
    let rain: Vec<String> = showers
        .iter()
        .filter(|x| x.expected_rate_per_hour >= 2.0)
        .map(|x| {
            let mut extra = String::from(" (about ");
            extra.push_str(&num(x.expected_rate_per_hour.round(), 0));
            extra.push_str(" an hour");
            item(&(String::from("the ") + x.name), x.best.as_ref(), &extra)
        })
        .collect();
    if !rain.is_empty() {
        s.push_str(" Meteors: ");
        s.push_str(&list_words(&rain));
        s.push('.');
    }
    let top: Vec<String> = deep
        .iter()
        .take(3)
        .map(|d| {
            d.name
                .map_or_else(|| d.label.clone(), |n| String::from("the ") + n)
        })
        .collect();
    if !top.is_empty() {
        s.push_str(" Best deep-sky sights: ");
        s.push_str(&list_words(&top));
        s.push('.');
    }
    if core.hours_above_20 > 0.0 {
        s.push(' ');
        s.push_str(&core.reason);
        s.push('.');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn a_night_in_philadelphia_has_everything() {
        let sky = Sky::new();
        let site = Site::new(39.9526, -75.1652);
        let c = crate::extinction::SkyConditions::default()
            .resolve()
            .unwrap();
        // 2026-08-12 22:00 EDT: the Perseid peak night (the IMO calendar's 13 August).
        let jd = civil_to_jd(2026, 8, 13) + 2.0 / 24.0;
        let t = tonight(&sky, &site, jd, &c, None).unwrap();
        assert!(t.errors.is_empty(), "{:?}", t.errors);
        assert_eq!(t.night.darkness.as_ref().unwrap().kind, Darkness::Night);
        assert_eq!(t.deep_sky.len(), DEFAULT_LIMIT);
        assert!(t.deep_sky.windows(2).all(|w| w[0].score >= w[1].score));
        assert_eq!(t.planets.len(), 7);
        let per = t
            .showers
            .iter()
            .find(|s| s.code == "PER")
            .expect("the Perseids");
        assert!(per.days_from_peak.abs() < 1.0, "{}", per.days_from_peak);
        assert!(per.expected_rate_per_hour > 5.0, "{per:?}");
        assert!(
            per.reason.starts_with("Perseids at its peak: about "),
            "{}",
            per.reason
        );
        assert!(
            t.showers
                .windows(2)
                .all(|w| w[0].expected_rate_per_hour >= w[1].expected_rate_per_hour)
        );
        assert!(t.summary.starts_with("Dark from {jd:"), "{}", t.summary);
        assert!(t.summary.contains("Perseids"), "{}", t.summary);
        // Every token in the summary is a Julian date inside the night.
        for part in t.summary.split("{jd:").skip(1) {
            let jd: f64 = part.split('}').next().unwrap().parse().unwrap();
            assert!(
                jd >= t.night.start.jd_utc && jd <= t.night.end.jd_utc,
                "{jd}"
            );
        }
        // The core of the Milky Way culminates in the south at 90 - 40 - 29 = 21 degrees
        // at 40 N: just above 20 degrees for a little while after dark in August.
        let core = t.milky_way_core.best.as_ref().unwrap();
        assert!(
            (core.alt_deg - 21.0).abs() < 0.5 && core.direction == "S",
            "{core:?}"
        );
        assert!(t.milky_way_core.hours_above_20 > 0.0);
        // The top objects read as sentences.
        assert!(
            t.deep_sky[0].reason.contains("h above 20° in darkness"),
            "{}",
            t.deep_sky[0].reason
        );
    }
}
