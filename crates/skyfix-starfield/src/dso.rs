//! Deep-sky objects: the 110 Messier objects and this project's own selection of 103
//! NGC/IC and other objects (EXPLORER_API.md, "Deep sky").
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6).
//!
//! `data/dso.txt` is written by `tools/starfield/dso.py` from the authored list
//! `tools/starfield/dso_objects.txt` (selection rule, types, names, descriptions):
//! positions (ICRS/J2000) and magnitudes from Wikidata (CC0), checked against SIMBAD and
//! Corwin's NGC/IC positions (`tests/dso_reference.rs` re-checks the shipped values);
//! integrated magnitudes of globular clusters from Harris's catalogue and of galaxies
//! from RC3, because Wikidata's V is sometimes a nucleus or a central star. One line per
//! object: `id|type|ra_deg|dec_deg|vmag|major_arcmin|minor_arcmin|name|description|cross_ids`.
//!
//! Apparent places follow [`crate::observe::Frame`] (no proper motion; the objects are
//! far enough that none matters for display). Visibility for a night is sampled every
//! five minutes through the observing window (the night's shared grid of sidereal
//! times), with the upper transit found from the sidereal rate.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::topocentric::Site;

use crate::StarfieldError;
use crate::constellations::{CONSTELLATIONS, constellation_at_b1875, icrs_to_b1875};
use crate::extinction::{Conditions, moonlight};
use crate::observe::{
    Frame, Horizon, Night, NightSummary, SIDEREAL_DEG_PER_DAY, Sighting, SiteFrame, separation_deg,
};

const DSO_TXT: &str = include_str!("../data/dso.txt");

/// What kind of object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DsoType {
    OpenCluster,
    GlobularCluster,
    PlanetaryNebula,
    EmissionNebula,
    ReflectionNebula,
    SupernovaRemnant,
    ClusterWithNebula,
    SpiralGalaxy,
    EllipticalGalaxy,
    LenticularGalaxy,
    IrregularGalaxy,
    DoubleStar,
    Asterism,
    StarCloud,
}

impl DsoType {
    fn from_code(code: &str) -> Option<DsoType> {
        Some(match code {
            "oc" => DsoType::OpenCluster,
            "gc" => DsoType::GlobularCluster,
            "pn" => DsoType::PlanetaryNebula,
            "en" => DsoType::EmissionNebula,
            "rn" => DsoType::ReflectionNebula,
            "snr" => DsoType::SupernovaRemnant,
            "cn" => DsoType::ClusterWithNebula,
            "sg" => DsoType::SpiralGalaxy,
            "eg" => DsoType::EllipticalGalaxy,
            "lg" => DsoType::LenticularGalaxy,
            "ig" => DsoType::IrregularGalaxy,
            "ds" => DsoType::DoubleStar,
            "as" => DsoType::Asterism,
            "sc" => DsoType::StarCloud,
            _ => return None,
        })
    }

    /// The broad class the Sky view draws a symbol for: `"cluster"`, `"nebula"`,
    /// `"galaxy"` or `"other"`.
    pub fn category(self) -> &'static str {
        use DsoType::*;
        match self {
            OpenCluster | GlobularCluster | ClusterWithNebula => "cluster",
            PlanetaryNebula | EmissionNebula | ReflectionNebula | SupernovaRemnant => "nebula",
            SpiralGalaxy | EllipticalGalaxy | LenticularGalaxy | IrregularGalaxy => "galaxy",
            DoubleStar | Asterism | StarCloud => "other",
        }
    }

    /// The type in words: "open cluster", "planetary nebula".
    pub fn noun(self) -> &'static str {
        use DsoType::*;
        match self {
            OpenCluster => "open cluster",
            GlobularCluster => "globular cluster",
            PlanetaryNebula => "planetary nebula",
            EmissionNebula => "emission nebula",
            ReflectionNebula => "reflection nebula",
            SupernovaRemnant => "supernova remnant",
            ClusterWithNebula => "star cluster with nebula",
            SpiralGalaxy => "spiral galaxy",
            EllipticalGalaxy => "elliptical galaxy",
            LenticularGalaxy => "lenticular galaxy",
            IrregularGalaxy => "irregular galaxy",
            DoubleStar => "double star",
            Asterism => "asterism",
            StarCloud => "star cloud",
        }
    }
}

/// One object of the table.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Dso {
    /// Stable identifier: `"M31"`, `"NGC869"`, `"IC2602"`, `"Mel25"`, `"LMC"`.
    pub id: &'static str,
    /// As printed: `"M31"`, `"NGC 869"`, `"IC 2602"`, `"Mel 25"`.
    pub label: String,
    /// Common name, if it has one.
    pub name: Option<&'static str>,
    #[serde(rename = "type")]
    pub kind: DsoType,
    pub category: &'static str,
    /// IAU abbreviation of the constellation it lies in.
    pub constellation: &'static str,
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
    /// Integrated V magnitude; `null` for nebulae with no meaningful one.
    pub magnitude: Option<f64>,
    /// Apparent size, arcminutes (rounded; display only).
    pub major_arcmin: f64,
    pub minor_arcmin: f64,
    /// One line; SkyFix Lab's own words.
    pub description: String,
    /// Other catalogue numbers: `["NGC 224"]`.
    pub cross_ids: Vec<&'static str>,
}

fn label_of(id: &str) -> String {
    for prefix in ["NGC", "IC", "Mel", "Cr"] {
        if let Some(num) = id.strip_prefix(prefix) {
            if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                return format!("{prefix} {num}");
            }
        }
    }
    id.to_string()
}

fn constellation_name(abbr: &str) -> &'static str {
    CONSTELLATIONS
        .iter()
        .find(|(a, _)| *a == abbr)
        .map_or("", |(_, n)| *n)
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| {
        f.to_uppercase().collect::<String>() + c.as_str()
    })
}

fn parse() -> Result<Vec<Dso>, StarfieldError> {
    let err = |line: &str, why: &str| StarfieldError::Data(format!("dso.txt: {why}: {line:?}"));
    let mut out: Vec<Dso> = Vec::new();
    for line in DSO_TXT.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&'static str> = line.split('|').collect();
        if f.len() != 10 {
            return Err(err(line, "expected 10 fields"));
        }
        let num = |s: &str| s.parse::<f64>().map_err(|_| err(line, "bad number"));
        let kind = DsoType::from_code(f[1]).ok_or_else(|| err(line, "unknown type"))?;
        let (ra, dec) = (num(f[2])?, num(f[3])?);
        if !((0.0..360.0).contains(&ra) && (-90.0..=90.0).contains(&dec)) {
            return Err(err(line, "impossible position"));
        }
        let magnitude = if f[4].is_empty() {
            None
        } else {
            Some(num(f[4])?)
        };
        let (b_ra, b_dec) = icrs_to_b1875(ra, dec);
        let constellation =
            constellation_at_b1875(b_ra, b_dec).ok_or_else(|| err(line, "no constellation"))?;
        let description = if f[8].is_empty() {
            capitalise(&format!(
                "{} in {}",
                kind.noun(),
                constellation_name(constellation)
            ))
        } else {
            f[8].to_string()
        };
        if out.iter().any(|d| d.id == f[0]) {
            return Err(err(line, "listed twice"));
        }
        out.push(Dso {
            id: f[0],
            label: label_of(f[0]),
            name: (!f[7].is_empty()).then_some(f[7]),
            kind,
            category: kind.category(),
            constellation,
            ra_j2000_deg: ra,
            dec_j2000_deg: dec,
            magnitude,
            major_arcmin: num(f[5])?,
            minor_arcmin: num(f[6])?,
            description,
            cross_ids: f[9].split(',').filter(|s| !s.is_empty()).collect(),
        });
    }
    Ok(out)
}

/// The whole table, parsed on first use.
pub fn catalog() -> Result<&'static [Dso], StarfieldError> {
    static CELL: OnceLock<Result<Vec<Dso>, StarfieldError>> = OnceLock::new();
    CELL.get_or_init(parse)
        .as_ref()
        .map(|v| v.as_slice())
        .map_err(Clone::clone)
}

/// An object by its id (`"M31"`, `"m31"`, `"NGC 869"`, `"ngc869"`): case and spaces
/// ignored; Messier numbers also by their NGC/IC cross-identification.
pub fn find(id: &str) -> Result<Option<&'static Dso>, StarfieldError> {
    let key: String = id
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    let squash = |s: &str| {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_ascii_lowercase()
    };
    Ok(catalog()?
        .iter()
        .find(|d| squash(d.id) == key || d.cross_ids.iter().any(|x| squash(x) == key)))
}

// ---------------------------------------------------------------------------
// dso_list
// ---------------------------------------------------------------------------

/// `options_json` of `dso_list`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ListOptions {
    /// Keep only these categories (`"cluster"`, `"nebula"`, `"galaxy"`, `"other"`) or
    /// types (`"open_cluster"`, ...). Empty keeps everything.
    pub kinds: Vec<String>,
    /// Keep only objects at least this bright (objects without a magnitude are kept).
    pub max_magnitude: Option<f64>,
    /// With an observer: keep only objects above the horizon now.
    pub above_horizon: bool,
}

/// One object at one instant.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DsoState {
    #[serde(flatten)]
    pub object: &'static Dso,
    /// Apparent geocentric RA and Dec of date (the frame of `sky_state`).
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// Topocentric, with an observer: geometric altitude, azimuth, apparent altitude.
    pub alt_deg: Option<f64>,
    pub az_deg: Option<f64>,
    pub alt_apparent_deg: Option<f64>,
    pub above_horizon: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DsoList {
    pub jd_utc: f64,
    pub utc: String,
    pub objects: Vec<DsoState>,
    /// Provenance, one sentence.
    pub source: &'static str,
}

pub const SOURCE: &str = "SkyFix Lab's selection: the 110 Messier objects and 103 NGC/IC \
     and other objects by a stated rule; positions and magnitudes from Wikidata (CC0), \
     checked against SIMBAD and Corwin (2004); integrated magnitudes of globular clusters \
     from Harris and of galaxies from RC3; types, sizes, names and descriptions by \
     SkyFix Lab.";

fn keep(d: &Dso, o: &ListOptions) -> bool {
    let kind_ok = o.kinds.is_empty()
        || o.kinds
            .iter()
            .any(|k| k == d.category || serde_json_like_name(d.kind) == k.as_str());
    let mag_ok = match (o.max_magnitude, d.magnitude) {
        (Some(limit), Some(m)) => m <= limit,
        _ => true,
    };
    kind_ok && mag_ok
}

/// The wire name of a type (`"open_cluster"`), without going through serde.
pub fn serde_json_like_name(t: DsoType) -> &'static str {
    use DsoType::*;
    match t {
        OpenCluster => "open_cluster",
        GlobularCluster => "globular_cluster",
        PlanetaryNebula => "planetary_nebula",
        EmissionNebula => "emission_nebula",
        ReflectionNebula => "reflection_nebula",
        SupernovaRemnant => "supernova_remnant",
        ClusterWithNebula => "cluster_with_nebula",
        SpiralGalaxy => "spiral_galaxy",
        EllipticalGalaxy => "elliptical_galaxy",
        LenticularGalaxy => "lenticular_galaxy",
        IrregularGalaxy => "irregular_galaxy",
        DoubleStar => "double_star",
        Asterism => "asterism",
        StarCloud => "star_cloud",
    }
}

/// Every object (filtered by `options`), with its apparent place at `jd_utc` and, given
/// a site, its altitude and azimuth.
pub fn list(site: Option<&Site>, jd_utc: f64, options: &ListOptions) -> Result<DsoList, String> {
    let frame = Frame::at(jd_utc).map_err(|e| e.to_string())?;
    let sf = site.map(SiteFrame::new);
    let mut objects = Vec::new();
    for d in catalog().map_err(|e| e.to_string())? {
        if !keep(d, options) {
            continue;
        }
        let (ra, dec) = frame.apparent(d.ra_j2000_deg, d.dec_j2000_deg);
        let h: Option<Horizon> = sf.as_ref().map(|s| s.horizontal(frame.gha_deg(ra), dec));
        if options.above_horizon && h.is_some_and(|h| h.alt_apparent_deg <= 0.0) {
            continue;
        }
        objects.push(DsoState {
            object: d,
            ra_deg: ra,
            dec_deg: dec,
            alt_deg: h.map(|h| h.alt_deg),
            az_deg: h.map(|h| h.az_deg),
            alt_apparent_deg: h.map(|h| h.alt_apparent_deg),
            above_horizon: h.map(|h| h.alt_apparent_deg > 0.0),
        });
    }
    Ok(DsoList {
        jd_utc,
        utc: skyfix_core::time::format_utc(jd_utc),
        objects,
        source: SOURCE,
    })
}

// ---------------------------------------------------------------------------
// Visibility through a night
// ---------------------------------------------------------------------------

/// Altitude an object must reach to count as usefully placed, degrees.
pub const USEFUL_ALT_DEG: f64 = 20.0;

/// How a deep-sky object might be seen: a rough guide from its magnitude, size and the
/// limiting magnitude (EXPLORER_API.md, "Deep sky": the rule is stated there).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Instrument {
    Eye,
    Binoculars,
    Telescope,
    /// Beyond a small telescope, or a faint nebula best photographed.
    Camera,
}

/// Magnitudes that binoculars (10x50) and a small telescope (100 mm) add to the eye's
/// limit, for point-like objects: rough, stated values.
pub const BINOCULAR_GAIN_MAG: f64 = 3.0;
pub const TELESCOPE_GAIN_MAG: f64 = 5.0;
/// An extended object is taken to look as hard as a point `0.75 log10(size/1')`
/// magnitudes fainter, and the eye needs half a magnitude of margin.
pub const SIZE_PENALTY_PER_DEX: f64 = 0.75;
pub const EYE_MARGIN_MAG: f64 = 0.5;

/// The magnitude a deep-sky object "looks like" for the instrument guide.
pub fn effective_magnitude(d: &Dso) -> Option<f64> {
    d.magnitude
        .map(|m| m + SIZE_PENALTY_PER_DEX * d.major_arcmin.max(1.0).log10())
}

/// The instrument guide for an object against a limiting magnitude (which already
/// includes extinction and moonlight).
pub fn instrument(d: &Dso, limiting_mag: f64) -> Instrument {
    let Some(m) = effective_magnitude(d) else {
        return Instrument::Camera;
    };
    if m <= limiting_mag - EYE_MARGIN_MAG {
        Instrument::Eye
    } else if m <= limiting_mag + BINOCULAR_GAIN_MAG {
        Instrument::Binoculars
    } else if m <= limiting_mag + TELESCOPE_GAIN_MAG {
        Instrument::Telescope
    } else {
        Instrument::Camera
    }
}

/// The Moon's effect on one object at one instant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MoonEffect {
    pub moon_alt_deg: f64,
    pub separation_deg: f64,
    /// Sky brightening at the object, magnitudes (Krisciunas & Schaefer 1991).
    pub brightening_mag: f64,
}

/// What a night looks like for one object.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Visibility {
    /// Highest point in the observing window (the upper transit when it falls inside).
    pub best: Option<Sighting>,
    /// Upper transit inside the night, whether dark or not.
    pub transit: Option<Sighting>,
    /// Hours of the observing window with the object at least 20 degrees up.
    pub hours_above_20: f64,
    /// The Moon at the best time.
    pub moon: Option<MoonEffect>,
    /// Limiting magnitude at the object at the best time: extinction and moonlight.
    pub limiting_mag: Option<f64>,
    pub instrument: Option<Instrument>,
}

/// Apparent altitude of an object at `t` from the night's site.
fn altitude(frame_ra: f64, dec: f64, site: &SiteFrame, t: f64) -> Horizon {
    let gast = skyfix_ephemeris::sidereal::gha_aries_deg(t, 0.0);
    site.horizontal((gast - frame_ra).rem_euclid(360.0), dec)
}

/// Upper transits (LHA = 0) of apparent RA `ra` in `[a, b]`, given GAST at `a`: the
/// sidereal time runs linearly from there (nutation moves it from the line by about
/// 0.1" in a day, a few milliseconds of time).
fn transits(ra: f64, lon: f64, a: f64, b: f64, gast_a: f64) -> Vec<f64> {
    let lha0 = gast_a + lon - ra;
    let mut t = a + (360.0 - lha0.rem_euclid(360.0)).rem_euclid(360.0) / SIDEREAL_DEG_PER_DAY;
    let mut out = Vec::new();
    while t <= b {
        out.push(t);
        t += 360.0 / SIDEREAL_DEG_PER_DAY;
    }
    out
}

/// A fixed direction (apparent of date, fixed over the night) seen through `night`.
pub fn visibility_of(
    ra: f64,
    dec: f64,
    night: &Night,
    conditions: &Conditions,
    object: Option<&Dso>,
) -> Visibility {
    let site = &night.site;
    let lon = site.site.lon_deg;
    let gast0 = skyfix_ephemeris::sidereal::gha_aries_deg(night.start_jd, 0.0);
    let transit = transits(ra, lon, night.start_jd, night.end_jd, gast0)
        .first()
        .map(|&t| Sighting::new(t, &altitude(ra, dec, site, t)));
    let mut out = Visibility {
        best: None,
        transit,
        hours_above_20: 0.0,
        moon: None,
        limiting_mag: None,
        instrument: None,
    };
    let Some((a, b)) = night.window() else {
        return out;
    };
    // Best: the higher window end, or a transit inside the window.
    let (grid, dt) = night.grid();
    let gast_a = gast0 + (a - night.start_jd) * SIDEREAL_DEG_PER_DAY;
    let mut cands = vec![a, b];
    cands.extend(transits(ra, lon, a, b, gast_a));
    let (tb, hb) = cands
        .into_iter()
        .map(|t| (t, altitude(ra, dec, site, t)))
        .max_by(|x, y| x.1.alt_apparent_deg.total_cmp(&y.1.alt_apparent_deg))
        .unwrap_or((a, altitude(ra, dec, site, a)));
    let up = grid
        .iter()
        .filter(|(_, gast)| {
            site.horizontal((gast - ra).rem_euclid(360.0), dec)
                .alt_apparent_deg
                >= USEFUL_ALT_DEG
        })
        .count();
    out.hours_above_20 = up as f64 * dt * 24.0;
    if hb.alt_apparent_deg <= 0.0 {
        return out;
    }
    out.best = Some(Sighting::new(tb, &hb));
    let (malt, mra, mdec) = night.moon_at(tb);
    let sep = separation_deg(ra, dec, mra, mdec);
    let ml = moonlight(
        night.moon.phase_angle_deg,
        malt,
        hb.alt_apparent_deg,
        sep,
        conditions.k,
        conditions.sky_brightness_mpsas,
    );
    out.moon = Some(MoonEffect {
        moon_alt_deg: malt,
        separation_deg: sep,
        brightening_mag: ml.brightening_mag,
    });
    let lm = conditions
        .limiting_mag_at(hb.alt_apparent_deg)
        .map(|l| l + conditions.nelm_brightened(ml.brightening_mag) - conditions.nelm);
    out.limiting_mag = lm;
    if let (Some(d), Some(lm)) = (object, lm) {
        out.instrument = Some(instrument(d, lm));
    }
    out
}

/// `dso_visibility(id, observer, night)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DsoVisibility {
    pub object: &'static Dso,
    pub night: NightSummary,
    pub conditions: Conditions,
    #[serde(flatten)]
    pub visibility: Visibility,
    /// Apparent altitude through the night (local noon to noon) every 10 minutes, for
    /// charts.
    pub track: Track,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Track {
    pub jd_utc: Vec<f64>,
    pub alt_deg: Vec<f64>,
}

/// One object through the night containing `jd_utc` (see [`Night::containing`]).
pub fn visibility(
    sky: &Sky,
    id: &str,
    site: &Site,
    jd_utc: f64,
    conditions: &Conditions,
) -> Result<DsoVisibility, String> {
    let d = find(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no deep-sky object {id:?}"))?;
    let night = Night::containing(sky, site, jd_utc)?;
    let mid = night
        .window()
        .map_or(night.start_jd + 0.5, |(a, b)| 0.5 * (a + b));
    let frame = Frame::at(mid).map_err(|e| e.to_string())?;
    let (ra, dec) = frame.apparent(d.ra_j2000_deg, d.dec_j2000_deg);
    let v = visibility_of(ra, dec, &night, conditions, Some(d));
    let mut track = Track {
        jd_utc: Vec::with_capacity(145),
        alt_deg: Vec::with_capacity(145),
    };
    for k in 0..=144 {
        let t = night.start_jd + f64::from(k) / 144.0;
        track.jd_utc.push(t);
        track
            .alt_deg
            .push(altitude(ra, dec, &night.site, t).alt_apparent_deg);
    }
    Ok(DsoVisibility {
        object: d,
        night: night.summary(),
        conditions: *conditions,
        visibility: v,
        track,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses_with_every_field() {
        let c = catalog().unwrap();
        assert_eq!(c.len(), 213);
        assert_eq!(
            c.iter()
                .filter(|d| d.id.starts_with('M') && d.id[1..].bytes().all(|b| b.is_ascii_digit()))
                .count(),
            110
        );
        let m31 = find("m 31").unwrap().unwrap();
        assert_eq!(m31.name, Some("Andromeda Galaxy"));
        assert_eq!(m31.constellation, "And");
        assert_eq!(m31.kind, DsoType::SpiralGalaxy);
        assert_eq!(m31.category, "galaxy");
        assert_eq!(m31.cross_ids, vec!["NGC 224"]);
        assert!((m31.magnitude.unwrap() - 3.4).abs() < 0.1);
        assert_eq!(find("NGC224").unwrap().unwrap().id, "M31");
        assert_eq!(find("ngc 869").unwrap().unwrap().label, "NGC 869");
        assert!(find("M999").unwrap().is_none());
        // Constellations from the IAU boundaries, as the names say.
        for (id, con) in [
            ("M42", "Ori"),
            ("M45", "Tau"),
            ("NGC5139", "Cen"),
            ("NGC104", "Tuc"),
            ("M13", "Her"),
            ("LMC", "Dor"),
            ("Mel25", "Tau"),
            ("M57", "Lyr"),
        ] {
            assert_eq!(find(id).unwrap().unwrap().constellation, con, "{id}");
        }
        // Generated descriptions read as sentences.
        let blank = c
            .iter()
            .find(|d| d.description.starts_with("Open cluster in "));
        assert!(blank.is_none() || blank.unwrap().description.len() > 15);
        // Both hemispheres, every broad class.
        assert!(c.iter().filter(|d| d.dec_j2000_deg < 0.0).count() > 90);
        for cat in ["cluster", "nebula", "galaxy", "other"] {
            assert!(c.iter().any(|d| d.category == cat), "{cat}");
        }
    }

    #[test]
    fn the_instrument_guide_is_sensible_for_showpieces() {
        let get = |id: &str| find(id).unwrap().unwrap();
        // A dark rural sky (limit 6.5): the Andromeda Galaxy and the Pleiades by eye,
        // the Hercules Cluster in binoculars, the Ring Nebula in binoculars at best.
        assert_eq!(instrument(get("M31"), 6.5), Instrument::Eye);
        assert_eq!(instrument(get("M45"), 6.5), Instrument::Eye);
        assert_eq!(instrument(get("M13"), 6.5), Instrument::Binoculars);
        // A suburban sky (5.5): the Andromeda Galaxy needs binoculars, the Ring Nebula a
        // telescope, the Pleiades are still easy.
        assert_eq!(instrument(get("M31"), 5.5), Instrument::Binoculars);
        assert_eq!(instrument(get("M57"), 5.5), Instrument::Telescope);
        assert_eq!(instrument(get("M45"), 5.5), Instrument::Eye);
        // Nebulae without a magnitude are camera targets.
        assert_eq!(get("IC434").magnitude, None);
        assert_eq!(instrument(get("IC434"), 6.5), Instrument::Camera);
    }

    #[test]
    fn transits_are_where_the_hour_angle_is_zero() {
        let lon = -75.1652;
        let a = 2_461_308.2;
        let g = skyfix_ephemeris::sidereal::gha_aries_deg(a, 0.0);
        let ts = transits(123.4, lon, a, a + 1.0, g);
        assert_eq!(ts.len(), 1);
        let lha = (skyfix_ephemeris::sidereal::gha_aries_deg(ts[0], 0.0) + lon - 123.4 + 180.0)
            .rem_euclid(360.0)
            - 180.0;
        // Within 0.5" of hour angle: 33 ms of time.
        assert!(lha.abs() * 3600.0 < 0.5, "{lha}");
        assert!(transits(123.4, lon, a, a + 0.5, g).len() <= 1);
        assert_eq!(transits(123.4, lon, a, a + 2.0, g).len(), 2);
    }
}
