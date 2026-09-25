//! Search: stars, deep-sky objects, constellations, the Sun, Moon and planets, and
//! meteor-shower radiants, by name or designation (EXPLORER_API.md, "Deep sky",
//! `sky_search`).
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6).
//!
//! **Matching.** Query and names are *folded*: lower case, accents removed (é to e, ñ to
//! n), Greek letters spelled out (α to alpha), superscript digits made plain, punctuation
//! made spaces, apostrophes dropped. A key then scores 100 when it equals the query
//! (spaces ignored, so "alpha1 cen" is "α¹ Cen" and "alnair" is "Al Na'ir"), 80 when it
//! starts with it, 60 when every query word starts a word of the key (less one for each
//! key word left over), 40 when it contains the query (three letters or more). Hits are ranked by score, then by kind
//! (the Sun, Moon and planets, then names, then designations), then by brightness.
//! Catalogue numbers are exact: `HR 2491`, `HIP 32349`, `M 31`, `NGC 224`.
//!
//! **Keys.** Stars: proper names (the star field's own and the IAU WGSN's), Bayer
//! designations with the constellation's abbreviation or genitive ("alpha cma", "alpha
//! canis majoris"), Flamsteed numbers ("61 cyg", "61 cygni"), HR numbers and, where
//! known, HIP numbers. Deep-sky objects: id, Messier/NGC/IC numbers and common names.
//! Constellations: name, abbreviation and genitive. Showers: name, IAU code and "radiant".

use std::sync::OnceLock;

use serde::Serialize;
use skyfix_ephemeris::body::{BodyEphemeris, MOON, PLANETS, SUN, Sky};
use skyfix_ephemeris::topocentric::{Site, horizontal};

use crate::constellations::CONSTELLATIONS;
use crate::observe::{Frame, Horizon, SiteFrame};
use crate::{StarfieldError, dso, names, showers, starfield};

/// Genitives of the 88 constellations, for Bayer and Flamsteed designations.
const GENITIVES: [(&str, &str); 88] = [
    ("And", "Andromedae"),
    ("Ant", "Antliae"),
    ("Aps", "Apodis"),
    ("Aqr", "Aquarii"),
    ("Aql", "Aquilae"),
    ("Ara", "Arae"),
    ("Ari", "Arietis"),
    ("Aur", "Aurigae"),
    ("Boo", "Bootis"),
    ("Cae", "Caeli"),
    ("Cam", "Camelopardalis"),
    ("Cnc", "Cancri"),
    ("CVn", "Canum Venaticorum"),
    ("CMa", "Canis Majoris"),
    ("CMi", "Canis Minoris"),
    ("Cap", "Capricorni"),
    ("Car", "Carinae"),
    ("Cas", "Cassiopeiae"),
    ("Cen", "Centauri"),
    ("Cep", "Cephei"),
    ("Cet", "Ceti"),
    ("Cha", "Chamaeleontis"),
    ("Cir", "Circini"),
    ("Col", "Columbae"),
    ("Com", "Comae Berenices"),
    ("CrA", "Coronae Australis"),
    ("CrB", "Coronae Borealis"),
    ("Crv", "Corvi"),
    ("Crt", "Crateris"),
    ("Cru", "Crucis"),
    ("Cyg", "Cygni"),
    ("Del", "Delphini"),
    ("Dor", "Doradus"),
    ("Dra", "Draconis"),
    ("Equ", "Equulei"),
    ("Eri", "Eridani"),
    ("For", "Fornacis"),
    ("Gem", "Geminorum"),
    ("Gru", "Gruis"),
    ("Her", "Herculis"),
    ("Hor", "Horologii"),
    ("Hya", "Hydrae"),
    ("Hyi", "Hydri"),
    ("Ind", "Indi"),
    ("Lac", "Lacertae"),
    ("Leo", "Leonis"),
    ("LMi", "Leonis Minoris"),
    ("Lep", "Leporis"),
    ("Lib", "Librae"),
    ("Lup", "Lupi"),
    ("Lyn", "Lyncis"),
    ("Lyr", "Lyrae"),
    ("Men", "Mensae"),
    ("Mic", "Microscopii"),
    ("Mon", "Monocerotis"),
    ("Mus", "Muscae"),
    ("Nor", "Normae"),
    ("Oct", "Octantis"),
    ("Oph", "Ophiuchi"),
    ("Ori", "Orionis"),
    ("Pav", "Pavonis"),
    ("Peg", "Pegasi"),
    ("Per", "Persei"),
    ("Phe", "Phoenicis"),
    ("Pic", "Pictoris"),
    ("Psc", "Piscium"),
    ("PsA", "Piscis Austrini"),
    ("Pup", "Puppis"),
    ("Pyx", "Pyxidis"),
    ("Ret", "Reticuli"),
    ("Sge", "Sagittae"),
    ("Sgr", "Sagittarii"),
    ("Sco", "Scorpii"),
    ("Scl", "Sculptoris"),
    ("Sct", "Scuti"),
    ("Ser", "Serpentis"),
    ("Sex", "Sextantis"),
    ("Tau", "Tauri"),
    ("Tel", "Telescopii"),
    ("Tri", "Trianguli"),
    ("TrA", "Trianguli Australis"),
    ("Tuc", "Tucanae"),
    ("UMa", "Ursae Majoris"),
    ("UMi", "Ursae Minoris"),
    ("Vel", "Velorum"),
    ("Vir", "Virginis"),
    ("Vol", "Volantis"),
    ("Vul", "Vulpeculae"),
];

const GREEK_NAMES: [&str; 24] = [
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
    "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi",
    "psi", "omega",
];

/// Three-letter Greek abbreviations people type (BSC, SIMBAD).
const GREEK_ABBR: [(&str, &str); 16] = [
    ("alf", "alpha"),
    ("alp", "alpha"),
    ("bet", "beta"),
    ("gam", "gamma"),
    ("del", "delta"),
    ("eps", "epsilon"),
    ("zet", "zeta"),
    ("iot", "iota"),
    ("kap", "kappa"),
    ("lam", "lambda"),
    ("omi", "omicron"),
    ("sig", "sigma"),
    ("ups", "upsilon"),
    ("ome", "omega"),
    ("the", "theta"),
    ("ksi", "xi"),
];

fn greek_name(c: char) -> Option<&'static str> {
    let i = match c {
        'α' => 0,
        'β' => 1,
        'γ' => 2,
        'δ' => 3,
        'ε' | 'ϵ' => 4,
        'ζ' => 5,
        'η' => 6,
        'θ' | 'ϑ' => 7,
        'ι' => 8,
        'κ' => 9,
        'λ' => 10,
        'μ' => 11,
        'ν' => 12,
        'ξ' => 13,
        'ο' => 14,
        'π' => 15,
        'ρ' => 16,
        'σ' | 'ς' => 17,
        'τ' => 18,
        'υ' => 19,
        'φ' | 'ϕ' => 20,
        'χ' => 21,
        'ψ' => 22,
        'ω' => 23,
        _ => return None,
    };
    Some(GREEK_NAMES[i])
}

fn latin_base(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => "c",
        'ď' | 'đ' | 'ð' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => "e",
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => "g",
        'ĥ' | 'ħ' => "h",
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => "i",
        'ĵ' => "j",
        'ķ' => "k",
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => "l",
        'ñ' | 'ń' | 'ņ' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => "o",
        'œ' => "oe",
        'ŕ' | 'ŗ' | 'ř' => "r",
        'ś' | 'ŝ' | 'ş' | 'š' => "s",
        'ß' => "ss",
        'ţ' | 'ť' | 'ŧ' => "t",
        'þ' => "th",
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => "u",
        'ŵ' => "w",
        'ý' | 'ÿ' | 'ŷ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        _ => return None,
    })
}

/// Fold for matching (see the module documentation).
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        for c in ch.to_lowercase() {
            if c.is_ascii_alphanumeric() {
                out.push(c);
            } else if let Some(g) = greek_name(c) {
                out.push(' ');
                out.push_str(g);
                out.push(' ');
            } else if let Some(b) = latin_base(c) {
                out.push_str(b);
            } else if let Some(d) = "⁰¹²³⁴⁵⁶⁷⁸⁹".chars().position(|x| x == c) {
                out.push(' ');
                out.push(char::from(b'0' + d as u8));
            } else if matches!(c, '\'' | '’' | 'ʻ' | '`') {
                // Apostrophes join: "Al Na'ir" is "al nair".
            } else {
                out.push(' ');
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// What a key points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Target {
    Star(usize),
    Dso(usize),
    Constellation(usize),
    Body(&'static str),
    Shower(usize),
}

/// How a key names its target, for ranking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum KeyKind {
    Designation = 0,
    Name = 1,
    Body = 2,
}

struct Index {
    keys: Vec<(String, String, Target, KeyKind)>,
}

fn build() -> Result<Index, StarfieldError> {
    let sf = starfield()?;
    let c = &sf.catalog;
    let mut keys: Vec<(String, String, Target, KeyKind)> = Vec::new();
    let mut add = |text: &str, t: Target, k: KeyKind| {
        let f = fold(text);
        if !f.is_empty() {
            keys.push((compact(&f), f, t, k));
        }
    };
    for (i, name) in &c.names {
        add(name, Target::Star(*i), KeyKind::Name);
    }
    for nav in &sf.navigational {
        add(nav.name, Target::Star(nav.index), KeyKind::Name);
    }
    for (i, d) in c.designation.iter().enumerate() {
        let Some(con) = d.constellation else { continue };
        let abbr = CONSTELLATIONS[usize::from(con)].0;
        let genitive = GENITIVES.iter().find(|g| g.0 == abbr).map_or(abbr, |g| g.1);
        if d.bayer > 0 {
            let letter = GREEK_NAMES[usize::from(d.bayer) - 1];
            for tail in [abbr, genitive] {
                add(
                    &format!("{letter} {tail}"),
                    Target::Star(i),
                    KeyKind::Designation,
                );
                if d.superscript > 0 {
                    add(
                        &format!("{letter} {} {tail}", d.superscript),
                        Target::Star(i),
                        KeyKind::Designation,
                    );
                }
            }
        }
        if d.flamsteed > 0 {
            for tail in [abbr, genitive] {
                add(
                    &format!("{} {tail}", d.flamsteed),
                    Target::Star(i),
                    KeyKind::Designation,
                );
            }
        }
    }
    for (i, d) in dso::catalog()?.iter().enumerate() {
        add(d.id, Target::Dso(i), KeyKind::Designation);
        add(&d.label, Target::Dso(i), KeyKind::Designation);
        if let Some(n) = d.id.strip_prefix('M') {
            add(
                &format!("Messier {n}"),
                Target::Dso(i),
                KeyKind::Designation,
            );
        }
        for x in &d.cross_ids {
            add(x, Target::Dso(i), KeyKind::Designation);
        }
        if let Some(n) = d.name {
            add(n, Target::Dso(i), KeyKind::Name);
        }
    }
    for (i, (abbr, name)) in CONSTELLATIONS.iter().enumerate() {
        add(name, Target::Constellation(i), KeyKind::Name);
        add(abbr, Target::Constellation(i), KeyKind::Designation);
        if let Some(g) = GENITIVES.iter().find(|g| g.0 == *abbr) {
            add(g.1, Target::Constellation(i), KeyKind::Designation);
        }
    }
    for b in [SUN, MOON].iter().chain(PLANETS.iter()) {
        add(b, Target::Body(b), KeyKind::Body);
    }
    for (i, s) in showers::table()?.iter().enumerate() {
        add(s.name, Target::Shower(i), KeyKind::Name);
        add(s.code, Target::Shower(i), KeyKind::Designation);
        add(
            &format!("{} radiant", s.name),
            Target::Shower(i),
            KeyKind::Name,
        );
    }
    Ok(Index { keys })
}

fn index() -> Result<&'static Index, StarfieldError> {
    static CELL: OnceLock<Result<Index, StarfieldError>> = OnceLock::new();
    CELL.get_or_init(build).as_ref().map_err(Clone::clone)
}

fn score(key: &str, key_compact: &str, q: &str, q_compact: &str, q_words: &[&str]) -> u32 {
    if key_compact == q_compact {
        return 100;
    }
    if key.starts_with(q) {
        return 80;
    }
    let words: Vec<&str> = key.split(' ').collect();
    let mut used = vec![false; words.len()];
    let all = q_words.iter().all(|w| {
        match words
            .iter()
            .enumerate()
            .find(|(k, kw)| !used[*k] && kw.starts_with(w))
        {
            Some((k, _)) => {
                used[k] = true;
                true
            }
            None => false,
        }
    });
    if all {
        // Fewer words the query leaves unmatched rank higher: "geminid radiant" is the
        // Geminids before the Epsilon Geminids.
        let extra = used.iter().filter(|u| !**u).count() as u32;
        return 60 - extra.min(15);
    }
    if q.len() >= 3 && key.contains(q) {
        return 40;
    }
    0
}

/// One search result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    /// `"star"`, `"deep_sky"`, `"constellation"`, `"sun"`, `"moon"`, `"planet"` or
    /// `"shower"`.
    pub kind: &'static str,
    /// Stable identifier: `"HR 2491"`, `"M31"`, `"CMa"`, `"Mars"`, `"PER"`.
    pub id: String,
    /// What to call it: `"Sirius"`, `"Andromeda Galaxy"`, `"Canis Major"`.
    pub label: String,
    /// One line: `"α CMa · HR 2491 · magnitude -1.5"`.
    pub detail: String,
    pub magnitude: Option<f64>,
    /// The star's index in `starfield_catalog()`, for stars.
    pub index: Option<usize>,
    /// Apparent RA and Dec of date at `jd_utc` (for a shower, its radiant); `null`
    /// without a time or outside a provider's coverage.
    pub ra_deg: Option<f64>,
    pub dec_deg: Option<f64>,
    /// With an observer and a time.
    pub alt_deg: Option<f64>,
    pub az_deg: Option<f64>,
    pub alt_apparent_deg: Option<f64>,
    pub above_horizon: Option<bool>,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchResult {
    pub query: String,
    pub hits: Vec<Hit>,
}

/// Most hits returned when the caller does not say.
pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 100;

fn fmt_mag(m: f64) -> String {
    format!("magnitude {}", format!("{m:.1}").replace('-', "−"))
}

/// Exact catalogue numbers: "hr 2491", "hip 32349".
fn catalogue_number(q: &str) -> Option<Target> {
    let c = compact(q);
    let c = c.as_str();
    let sf = starfield().ok()?;
    if let Some(n) = c.strip_prefix("hr").and_then(|n| n.parse::<i32>().ok()) {
        return sf.catalog.index_of_hr(n).map(Target::Star);
    }
    if let Some(n) = c.strip_prefix("hip").and_then(|n| n.parse::<u32>().ok()) {
        return (0..sf.catalog.len())
            .find(|&i| names::hip_of(i) == Some(n))
            .map(Target::Star);
    }
    None
}

fn describe(
    t: Target,
    sky: &Sky,
    frame: Option<&Frame>,
    site: Option<&SiteFrame>,
    score: u32,
) -> Result<Hit, StarfieldError> {
    let sf = starfield()?;
    let c = &sf.catalog;
    let mut hit = Hit {
        kind: "star",
        id: String::new(),
        label: String::new(),
        detail: String::new(),
        magnitude: None,
        index: None,
        ra_deg: None,
        dec_deg: None,
        alt_deg: None,
        az_deg: None,
        alt_apparent_deg: None,
        above_horizon: None,
        score,
    };
    let mut place = |ra: f64, dec: f64, h: Option<Horizon>| {
        hit.ra_deg = Some(ra);
        hit.dec_deg = Some(dec);
        if let Some(h) = h {
            hit.alt_deg = Some(h.alt_deg);
            hit.az_deg = Some(h.az_deg);
            hit.alt_apparent_deg = Some(h.alt_apparent_deg);
            hit.above_horizon = Some(h.alt_apparent_deg > 0.0);
        }
    };
    let fixed = |ra: f64, dec: f64| -> Option<Horizon> {
        let (f, s) = (frame?, site?);
        Some(s.horizontal(f.gha_deg(ra), dec))
    };
    match t {
        Target::Star(i) => {
            let navname = sf
                .navigational
                .iter()
                .find(|n| n.index == i)
                .map(|n| n.name);
            let name = navname.or_else(|| c.name_of(i));
            let desig = &c.designations[i];
            let hr = format!("HR {}", c.hr[i]);
            hit.id = hr.clone();
            hit.label = name.map(str::to_string).unwrap_or_else(|| {
                if desig.is_empty() {
                    hr.clone()
                } else {
                    desig.clone()
                }
            });
            let mut parts: Vec<String> = Vec::new();
            if name.is_some() && !desig.is_empty() {
                parts.push(desig.clone());
            }
            parts.push(hr);
            if let Some(h) = names::hip_of(i) {
                parts.push(format!("HIP {h}"));
            }
            let m = f64::from(c.vmag[i]);
            parts.push(fmt_mag(m));
            hit.detail = parts.join(" · ");
            hit.magnitude = Some(m);
            hit.index = Some(i);
            if let Some(f) = frame {
                let (ra, dec) = f.apparent_star(
                    c.ra_j2000_deg[i],
                    c.dec_j2000_deg[i],
                    c.pm_ra_cosdec_mas_yr[i],
                    c.pm_dec_mas_yr[i],
                    c.parallax_mas[i],
                );
                place(ra, dec, fixed(ra, dec));
            }
        }
        Target::Dso(i) => {
            let d = &dso::catalog()?[i];
            hit.kind = "deep_sky";
            hit.id = d.id.to_string();
            hit.label = d.name.map_or_else(|| d.label.clone(), str::to_string);
            let mut parts = vec![d.label.clone()];
            parts.extend(d.cross_ids.iter().map(|s| s.to_string()));
            parts.push(d.description.clone());
            if let Some(m) = d.magnitude {
                parts.push(fmt_mag(m));
            }
            hit.detail = parts.join(" · ");
            hit.magnitude = d.magnitude;
            if let Some(f) = frame {
                let (ra, dec) = f.apparent(d.ra_j2000_deg, d.dec_j2000_deg);
                place(ra, dec, fixed(ra, dec));
            }
        }
        Target::Constellation(i) => {
            let (abbr, name) = CONSTELLATIONS[i];
            hit.kind = "constellation";
            hit.id = abbr.to_string();
            hit.label = name.to_string();
            let genitive = GENITIVES.iter().find(|g| g.0 == abbr).map_or("", |g| g.1);
            hit.detail = format!("Constellation · {abbr} · genitive {genitive}");
            if let (Some(f), Some(con)) = (frame, sf.constellations.iter().find(|c| c.abbr == abbr))
            {
                let (ra, dec) = f.rotate(con.label_ra_deg, con.label_dec_deg);
                place(ra, dec, fixed(ra, dec));
            }
        }
        Target::Body(b) => {
            hit.kind = match b {
                SUN => "sun",
                MOON => "moon",
                _ => "planet",
            };
            hit.id = b.to_string();
            hit.label = b.to_string();
            hit.detail = match b {
                SUN => "The Sun".to_string(),
                MOON => "The Moon".to_string(),
                _ => "Planet".to_string(),
            };
            if let Some(f) = frame {
                if let Ok(st) = sky.apparent_state(b, f.jd_utc) {
                    hit.magnitude = st.magnitude;
                    let h = site.map(|s| {
                        let t = horizontal(&st, &s.site);
                        Horizon {
                            alt_deg: t.alt_deg,
                            az_deg: t.az_deg,
                            alt_apparent_deg: t.alt_apparent_deg,
                        }
                    });
                    place(st.ra_deg, st.dec_deg, h);
                }
            }
        }
        Target::Shower(i) => {
            let s = &showers::table()?[i];
            hit.kind = "shower";
            hit.id = s.code.to_string();
            hit.label = s.name.to_string();
            hit.detail = format!(
                "Meteor shower · IAU {} {} · peak ZHR {}{}",
                s.iau,
                s.code,
                s.zhr,
                if s.variable { " (variable)" } else { "" }
            );
            if let Some(f) = frame {
                if let Ok((ra, dec)) = showers::radiant_of_date(sky, s, f.jd_utc) {
                    place(ra, dec, fixed(ra, dec));
                }
            }
        }
    }
    Ok(hit)
}

fn priority(t: Target, k: KeyKind) -> u32 {
    match (t, k) {
        (Target::Body(_), _) => 4,
        (_, KeyKind::Name) => 3,
        (Target::Constellation(_), _) | (Target::Dso(_), _) | (Target::Shower(_), _) => 2,
        _ => 1,
    }
}

/// Search `query`; with a time, the hits' places then; with an observer too, their
/// altitude and azimuth.
pub fn search(
    sky: &Sky,
    query: &str,
    site: Option<&Site>,
    jd_utc: Option<f64>,
    limit: Option<usize>,
) -> Result<SearchResult, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut q = fold(query);
    // "alf cma" and friends: a leading three-letter Greek abbreviation.
    if let Some((first, rest)) = q.split_once(' ') {
        if let Some((_, full)) = GREEK_ABBR.iter().find(|(a, _)| *a == first) {
            q = format!("{full} {rest}");
        }
    }
    let frame = jd_utc
        .map(Frame::at)
        .transpose()
        .map_err(|e| e.to_string())?;
    let sf = site.map(SiteFrame::new);
    let mut result = SearchResult {
        query: query.to_string(),
        hits: Vec::new(),
    };
    if q.is_empty() {
        return Ok(result);
    }
    let qc = compact(&q);
    let words: Vec<&str> = q.split(' ').collect();
    let mut best: Vec<(Target, u32, u32)> = Vec::new(); // target, score, priority
    if let Some(t) = catalogue_number(&q) {
        best.push((t, 100, 3));
    }
    for (kc, key, t, kind) in &index().map_err(|e| e.to_string())?.keys {
        let s = score(key, kc, &q, &qc, &words);
        if s == 0 {
            continue;
        }
        let p = priority(*t, *kind);
        match best.iter_mut().find(|b| b.0 == *t) {
            Some(b) => {
                if (s, p) > (b.1, b.2) {
                    b.1 = s;
                    b.2 = p;
                }
            }
            None => best.push((*t, s, p)),
        }
    }
    let catalog = &starfield().map_err(|e| e.to_string())?.catalog;
    let dsos = dso::catalog().map_err(|e| e.to_string())?;
    let mag = |t: Target| -> f64 {
        match t {
            Target::Star(i) => f64::from(catalog.vmag[i]),
            Target::Dso(i) => dsos[i].magnitude.unwrap_or(9.0),
            Target::Body(_) => -30.0,
            _ => 5.0,
        }
    };
    best.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(b.2.cmp(&a.2))
            .then(mag(a.0).total_cmp(&mag(b.0)))
    });
    for (t, s, _) in best.into_iter().take(limit) {
        result
            .hits
            .push(describe(t, sky, frame.as_ref(), sf.as_ref(), s).map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn top(q: &str) -> Hit {
        search(&Sky::new(), q, None, None, Some(5))
            .unwrap()
            .hits
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("no hit for {q:?}"))
    }

    #[test]
    fn folding_removes_case_accents_and_greek() {
        assert_eq!(fold("α¹ Cen"), "alpha 1 cen");
        assert_eq!(fold("Al Na'ir"), "al nair");
        assert_eq!(fold("Añañuca"), "ananuca");
        assert_eq!(fold("  Boötes--"), "bootes");
        assert_eq!(fold("NGC 224"), "ngc 224");
    }

    #[test]
    fn names_designations_and_numbers_find_the_right_object() {
        assert_eq!(top("sirius").label, "Sirius");
        assert_eq!(top("SIRI").label, "Sirius");
        assert_eq!(top("alpha cma").label, "Sirius");
        assert_eq!(top("α CMa").label, "Sirius");
        assert_eq!(top("alf cma").label, "Sirius");
        assert_eq!(top("alpha canis majoris").label, "Sirius");
        assert_eq!(top("HR 2491").label, "Sirius");
        assert_eq!(top("hip 32349").label, "Sirius");
        assert_eq!(top("alnair").label, "Al Na'ir");
        assert_eq!(top("alpha centauri").label, "Rigil Kentaurus");
        assert_eq!(top("61 cygni").id, "HR 8085");
        assert_eq!(top("m31").label, "Andromeda Galaxy");
        assert_eq!(top("M 31").id, "M31");
        assert_eq!(top("messier 31").id, "M31");
        assert_eq!(top("NGC 224").id, "M31");
        assert_eq!(top("andromeda gal").id, "M31");
        assert_eq!(top("orion").kind, "constellation");
        assert_eq!(top("orionis").kind, "constellation");
        assert_eq!(top("jupiter").kind, "planet");
        assert_eq!(top("moon").kind, "moon");
        assert_eq!(top("perseids").kind, "shower");
        assert_eq!(top("geminid radiant").id, "GEM");
        assert!(
            search(&Sky::new(), "   ", None, None, None)
                .unwrap()
                .hits
                .is_empty()
        );
        assert!(
            search(&Sky::new(), "zzzzqq", None, None, None)
                .unwrap()
                .hits
                .is_empty()
        );
    }

    #[test]
    fn hits_carry_their_place_with_a_time_and_an_observer() {
        let site = Site::new(39.95, -75.17);
        let jd = 2_461_308.5;
        let r = search(&Sky::new(), "vega", Some(&site), Some(jd), Some(3)).unwrap();
        let h = &r.hits[0];
        assert_eq!(h.label, "Vega");
        assert!(h.ra_deg.is_some() && h.alt_deg.is_some() && h.above_horizon.is_some());
        let m = search(&Sky::new(), "mars", Some(&site), Some(jd), Some(1)).unwrap();
        assert!(m.hits[0].alt_deg.is_some() && m.hits[0].magnitude.is_some());
        // Without a time there is no place.
        assert!(top("vega").ra_deg.is_none());
    }
}
