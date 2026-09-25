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
//! - **Meteor showers** active that night ([`crate::showers::night_activity`]).
//! - **The Milky Way's core** (Sagittarius A*) through the darkness.
//! - **The summary**: plain sentences. Times inside them are tokens `{jd:2461308.51717}`
//!   (a UTC Julian date) that the interface replaces with a time in its own zone.
//!
//! Natively the whole call takes a few tens of milliseconds (`tests/timing.rs`).

use serde::Serialize;
use skyfix_almanac::events::SkyPhase;
use skyfix_almanac::sky::sample_bodies;
use skyfix_core::units::norm_360;
use skyfix_ephemeris::body::{BodyEphemeris, PLANETS, Sky};
use skyfix_ephemeris::topocentric::Site;

use crate::dso::{self, Instrument, MoonEffect};
use crate::extinction::Conditions;
use crate::observe::{
    Darkness, Frame, Instant, Night, NightSummary, Sighting, compass_words, separation_deg,
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

/// An active meteor shower.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShowerTonight {
    #[serde(flatten)]
    pub night: ShowerNight,
    pub variable: bool,
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
    pub showers: Vec<ShowerTonight>,
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

fn tok(jd: f64) -> String {
    format!("{{jd:{jd:.6}}}")
}

fn place_words(alt: f64, az: f64) -> String {
    let where_ = compass_words(az);
    match alt {
        a if a >= 60.0 => format!("high in the {where_}"),
        a if a >= 30.0 => format!("in the {where_}"),
        _ => format!("low in the {where_}"),
    }
}

fn moon_words(m: &Option<MoonEffect>) -> &'static str {
    match m.map_or(0.0, |m| m.brightening_mag) {
        b if b < 0.3 => "",
        b if b < 1.0 => "; some moonlight",
        _ => "; washed out by moonlight",
    }
}

fn instrument_words(i: Instrument) -> &'static str {
    match i {
        Instrument::Eye => "naked eye",
        Instrument::Binoculars => "binoculars",
        Instrument::Telescope => "a small telescope",
        Instrument::Camera => "a camera",
    }
}

fn list_words(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        n => format!("{} and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

fn planets_tonight(
    sky: &Sky,
    site: &Site,
    night: &Night,
    errors: &mut Vec<String>,
) -> Vec<PlanetTonight> {
    let twilight = |p: SkyPhase| {
        matches!(
            p,
            SkyPhase::Nautical | SkyPhase::Astronomical | SkyPhase::Night
        )
    };
    let Some((a, b)) = night.run(twilight) else {
        return Vec::new();
    };
    let s = match sample_bodies(sky, site, &PLANETS, a, b, 10.0) {
        Ok(s) => s,
        Err(e) => {
            errors.push(format!("planets: {e}"));
            return Vec::new();
        }
    };
    for e in &s.errors {
        errors.push(format!("{}: {}", e.body, e.message));
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
        let (mut best, mut first, mut last, mut up) = (None::<(f64, f64, f64)>, None, None, 0usize);
        for (k, &t) in s.jd_utc.iter().enumerate() {
            let alt = body.alt_apparent_deg[k];
            if best.is_none_or(|(_, x, _)| alt > x) {
                best = Some((t, alt, body.az_deg[k]));
            }
            if alt >= PLANET_UP_DEG {
                first.get_or_insert(t);
                last = Some(t);
                up += 1;
            }
        }
        let hours_up = up as f64 * 10.0 / 60.0;
        let best = best.filter(|(_, alt, _)| *alt > 0.0);
        let reason = match (best, magnitude) {
            (Some((_, alt, az)), m) if alt >= PLANET_UP_DEG => format!(
                "{}{}, at best {} ({:.0}°)",
                name,
                m.map_or(String::new(), |m| format!(
                    ", magnitude {}",
                    format!("{m:.1}").replace('-', "−")
                )),
                place_words(alt, az),
                alt
            ),
            (Some(_), _) => format!("{name} stays below 10° in the dark hours"),
            (None, _) => format!("{name} is not up while the sky is dark"),
        };
        out.push(PlanetTonight {
            body: name,
            magnitude,
            best: best.map(|(t, alt, az)| Sighting {
                jd_utc: t,
                utc: skyfix_core::time::format_utc(t),
                alt_deg: alt,
                az_deg: az,
                direction: crate::observe::compass(az),
            }),
            up_from: first.map(Instant::new),
            up_until: last.map(Instant::new),
            hours_up,
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
        let base = match instrument {
            Instrument::Eye => 1.0,
            Instrument::Binoculars => 0.8,
            Instrument::Telescope => 0.5,
            Instrument::Camera => 0.35,
        };
        let moon = v.moon.map_or(0.0, |m| m.brightening_mag);
        let score = 100.0
            * base
            * best.alt_deg.to_radians().sin()
            * (0.5 + 0.5 * (v.hours_above_20 / 4.0).min(1.0))
            * 10f64.powf(-0.2 * moon)
            * if d.name.is_some() { 1.2 } else { 1.0 };
        let reason = format!(
            "{} ({:.0}° at best), {:.1} h above 20° in darkness; {}{}",
            capital(&place_words(best.alt_deg, best.az_deg)),
            best.alt_deg,
            v.hours_above_20,
            instrument_words(instrument),
            moon_words(&v.moon)
        );
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
    out.sort_by(|x, y| y.score.total_cmp(&x.score));
    out.truncate(limit);
    Ok(out)
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| {
        f.to_uppercase().collect::<String>() + c.as_str()
    })
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
            Ok(Some(n)) if n.expected_rate_per_hour >= 0.5 || s.variable => {
                let reason = shower_reason(s, &n);
                shower_list.push(ShowerTonight {
                    night: n,
                    variable: s.variable,
                    reason,
                })
            }
            Ok(_) => {}
            Err(e) => errors.push(format!("{}: {e}", s.code)),
        }
    }
    shower_list.sort_by(|a, b| {
        b.night
            .expected_rate_per_hour
            .total_cmp(&a.night.expected_rate_per_hour)
    });

    let core = {
        let mid = night
            .window()
            .map_or(night.start_jd + 0.5, |(a, b)| 0.5 * (a + b));
        let frame = Frame::at(mid).map_err(|e| e.to_string())?;
        let (ra, dec) = frame.apparent(GALACTIC_CENTRE_RA_DEG, GALACTIC_CENTRE_DEC_DEG);
        let v = dso::visibility_of(ra, dec, &night, conditions, None);
        let reason = match &v.best {
            Some(b) if v.hours_above_20 > 0.0 => format!(
                "The Milky Way's core is {} ({:.0}° at best), {:.1} h above 20° in darkness",
                place_words(b.alt_deg, b.az_deg),
                b.alt_deg,
                v.hours_above_20
            ),
            Some(b) => format!(
                "The Milky Way's core stays low ({:.0}° at best) in the dark hours",
                b.alt_deg
            ),
            None => "The Milky Way's core is not up while the sky is dark".to_string(),
        };
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

fn shower_reason(s: &showers::Shower, n: &ShowerNight) -> String {
    let when = match n.days_from_peak {
        d if d.abs() < 1.0 => "at its peak".to_string(),
        d if d < 0.0 => format!("{:.0} days before its peak", -d),
        d => format!("{d:.0} days after its peak"),
    };
    let rate = n.expected_rate_per_hour.round();
    let at = n.best.as_ref().map_or(String::new(), |b| {
        format!(
            ", best with the radiant {} ({:.0}°)",
            place_words(b.alt_deg, b.az_deg),
            b.alt_deg
        )
    });
    let var = if s.variable {
        "; rates vary from year to year"
    } else {
        ""
    };
    if rate >= 1.0 {
        format!(
            "{} {when}: about {rate:.0} meteors an hour{at}{var}",
            s.name
        )
    } else {
        format!("{} {when}: only an occasional meteor{at}{var}", s.name)
    }
}

fn summary(
    night: &Night,
    planets: &[PlanetTonight],
    deep: &[DsoTonight],
    showers: &[ShowerTonight],
    core: &CoreTonight,
) -> String {
    let mut s: Vec<String> = Vec::new();
    match &night.dark {
        Some(w) if w.kind == Darkness::Night => s.push(format!(
            "Dark from {} to {} ({:.1} hours).",
            tok(w.start.jd_utc),
            tok(w.end.jd_utc),
            w.hours
        )),
        Some(w) => s.push(format!(
            "The sky never gets fully dark tonight; it is darkest from {} to {}.",
            tok(w.start.jd_utc),
            tok(w.end.jd_utc)
        )),
        None => s.push("The Sun stays too high for a dark sky tonight.".to_string()),
    }
    let m = &night.moon;
    let pct = (m.illuminated_fraction * 100.0).round();
    let moon = if m.illuminated_fraction < 0.03 {
        "The Moon is new: a dark night.".to_string()
    } else if night.dark.is_none() {
        format!("The Moon is {}, {pct:.0}% lit.", m.phase)
    } else if m.up_hours < 0.1 {
        format!(
            "The Moon ({}, {pct:.0}% lit) is down during the dark hours.",
            m.phase
        )
    } else if m.down_hours < 0.1 {
        format!(
            "The Moon, {}, {pct:.0}% lit, is up all through the dark hours{}",
            m.phase,
            if m.illuminated_fraction > 0.5 {
                ": faint objects will be hard."
            } else {
                "."
            }
        )
    } else {
        let mut t = format!("The Moon is {}, {pct:.0}% lit", m.phase);
        match (&m.rise, &m.set) {
            (Some(r), Some(st)) if r.jd_utc < st.jd_utc => {
                t += &format!(
                    "; it rises at {} and sets at {}",
                    tok(r.jd_utc),
                    tok(st.jd_utc)
                )
            }
            (Some(r), Some(st)) => {
                t += &format!(
                    "; it sets at {} and rises at {}",
                    tok(st.jd_utc),
                    tok(r.jd_utc)
                )
            }
            (Some(r), None) => t += &format!("; it rises at {}", tok(r.jd_utc)),
            (None, Some(st)) => t += &format!("; it sets at {}", tok(st.jd_utc)),
            (None, None) => {}
        }
        t += &format!(", leaving {:.1} dark hours without it.", m.down_hours);
        t
    };
    s.push(moon);
    let up: Vec<String> = planets
        .iter()
        .filter(|p| p.hours_up > 0.0)
        .map(|p| {
            let b = p.best.as_ref().map_or(String::new(), |b| {
                format!(
                    " ({}, best near {})",
                    place_words(b.alt_deg, b.az_deg),
                    tok(b.jd_utc)
                )
            });
            format!("{}{}", p.body, b)
        })
        .collect();
    if !up.is_empty() {
        s.push(format!("Planets: {}.", list_words(&up)));
    }
    let best_showers: Vec<String> = showers
        .iter()
        .filter(|x| x.night.expected_rate_per_hour >= 2.0)
        .map(|x| {
            format!(
                "the {} (about {:.0} an hour{})",
                x.night.name,
                x.night.expected_rate_per_hour.round(),
                x.night
                    .best
                    .as_ref()
                    .map_or(String::new(), |b| format!(" near {}", tok(b.jd_utc)))
            )
        })
        .collect();
    if !best_showers.is_empty() {
        s.push(format!("Meteors: {}.", list_words(&best_showers)));
    }
    let top: Vec<String> = deep
        .iter()
        .take(3)
        .map(|d| {
            d.name
                .map_or_else(|| d.label.clone(), |n| format!("the {n}"))
        })
        .collect();
    if !top.is_empty() {
        s.push(format!("Best deep-sky sights: {}.", list_words(&top)));
    }
    if core.hours_above_20 > 0.0 {
        s.push(format!("{}.", core.reason));
    }
    s.join(" ")
}

/// Angle from the Moon to a direction, for callers that have both (re-exported for the
/// WASM layer's tests).
pub fn moon_separation(night: &Night, t: f64, ra: f64, dec: f64) -> f64 {
    let (_, mra, mdec) = night.moon_at(t);
    separation_deg(norm_360(ra), dec, mra, mdec)
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
            .find(|s| s.night.code == "PER")
            .expect("the Perseids");
        assert!(
            per.night.days_from_peak.abs() < 1.0,
            "{}",
            per.night.days_from_peak
        );
        assert!(per.night.expected_rate_per_hour > 5.0, "{per:?}");
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
    }
}
