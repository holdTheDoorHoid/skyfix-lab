//! Navigational star catalogue: the 57 Nautical Almanac stars plus Polaris.
//!
//! OWNER: ephemeris agent.
//!
//! The data live in `fixtures/reference/navigational_stars_hip.json` and are embedded
//! with `include_str!`, so the catalogue works on `wasm32-unknown-unknown` with no
//! filesystem and no network. Provenance and licence: `docs/THIRD_PARTY.md`.
//!
//! ## Epoch
//!
//! [`StarEntry`] positions are always ICRS at epoch **J2000.0**, whatever the file
//! says, because [`crate::frames::apparent_radec_of_date`] takes a J2000 place. The
//! file declares its own epoch in `generator.epoch`; when it differs from J2000.0 the
//! loader propagates every position with the catalogue proper motions at load time.
//! Accepted spellings are `"J2000.0"`, `"J1991.25"`, a bare Julian year such as
//! `1991.25`, or `{"jd": 2448349.0625}`. **Absent means J2000.0.**
//!
//! This matters: the Hipparcos catalogue is published at J1991.25, and the difference
//! is 32" for Rigil Kentaurus. A replacement file that ships Hipparcos-epoch positions
//! without saying so would be wrong by that much.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::EphemerisError;
use crate::frames::proper_motion_from_j2000;
use skyfix_core::time::JD_J2000;
use skyfix_core::units::norm_360;

/// The embedded catalogue file. Path is relative to this source file.
const CATALOG_JSON: &str = include_str!("../../../fixtures/reference/navigational_stars_hip.json");

/// One catalogue star. Positions are ICRS at epoch J2000.0 (see the module docs).
#[derive(Debug, Clone, PartialEq)]
pub struct StarEntry {
    /// Nautical Almanac spelling, e.g. `"Al Na'ir"`, `"Rigil Kentaurus"`.
    pub name: String,
    pub hip: u32,
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
    pub pm_ra_cosdec_mas_per_year: f64,
    pub pm_dec_mas_per_year: f64,
    /// Annual parallax, milliarcseconds. Used for the (small) parallactic shift.
    pub parallax_mas: f64,
    pub magnitude: f64,
}

/// What the catalogue file says about where its numbers came from. Surfaced verbatim
/// in the provider's [`crate::Coverage::notes`], so a user can see whether they are
/// looking at the provisional file or the authoritative one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Provenance {
    pub source: String,
    pub retrieved: String,
    pub license: String,
    /// Epoch as written in the file, normalised for display.
    pub epoch: String,
    /// `true` while the file is the ephemeris agent's stand-in.
    pub provisional: bool,
}

// ---------------------------------------------------------------------------
// The file format (schema `skyfix.reference/1`)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CatalogFile {
    #[serde(default)]
    schema: String,
    #[serde(default)]
    generator: Generator,
    stars: Vec<StarRecord>,
}

#[derive(Deserialize, Default)]
struct Generator {
    #[serde(default)]
    source: String,
    #[serde(default)]
    retrieved: String,
    #[serde(default)]
    license: String,
    /// Absent means J2000.0.
    #[serde(default)]
    epoch: Option<Epoch>,
    #[serde(default)]
    provisional: bool,
}

/// `"J2000.0"`, `"J1991.25"`, `1991.25`, or `{"jd": 2448349.0625}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum Epoch {
    Named(String),
    JulianYear(f64),
    Jd { jd: f64 },
}

impl Epoch {
    /// Julian date of this epoch, or `None` if it cannot be understood.
    fn to_jd(&self) -> Option<f64> {
        match self {
            Epoch::Jd { jd } => Some(*jd),
            Epoch::JulianYear(y) => Some(julian_year_to_jd(*y)),
            Epoch::Named(s) => {
                let t = s.trim();
                let digits = t.strip_prefix(['J', 'j']).unwrap_or(t);
                if let Ok(y) = digits.parse::<f64>() {
                    // A bare number under 10000 is a Julian year; anything larger is
                    // already a Julian date.
                    Some(if y < 10_000.0 {
                        julian_year_to_jd(y)
                    } else {
                        y
                    })
                } else {
                    None
                }
            }
        }
    }

    fn label(&self) -> String {
        match self {
            Epoch::Named(s) => s.clone(),
            Epoch::JulianYear(y) => format!("J{y}"),
            Epoch::Jd { jd } => format!("JD {jd}"),
        }
    }
}

fn julian_year_to_jd(year: f64) -> f64 {
    JD_J2000 + (year - 2000.0) * 365.25
}

#[derive(Deserialize)]
struct StarRecord {
    name: String,
    hip: u32,
    ra_deg: f64,
    dec_deg: f64,
    #[serde(default)]
    pm_ra_cosdec_mas_yr: f64,
    #[serde(default)]
    pm_dec_mas_yr: f64,
    #[serde(default)]
    parallax_mas: f64,
    #[serde(default)]
    mag: f64,
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

struct Loaded {
    stars: Vec<StarEntry>,
    provenance: Provenance,
    error: Option<String>,
}

fn parse(json: &str) -> Result<(Vec<StarEntry>, Provenance), String> {
    let file: CatalogFile =
        serde_json::from_str(json).map_err(|e| format!("navigational star catalogue: {e}"))?;
    if !file.schema.is_empty() && file.schema != skyfix_core::types::REFERENCE_SCHEMA {
        return Err(format!(
            "navigational star catalogue: schema is {:?}, expected {:?}",
            file.schema,
            skyfix_core::types::REFERENCE_SCHEMA
        ));
    }
    if file.stars.is_empty() {
        return Err("navigational star catalogue: no stars in the file".into());
    }

    // Bring the positions to epoch J2000.0 if the file is at another epoch.
    let (epoch_jd, epoch_label) = match &file.generator.epoch {
        None => (
            JD_J2000,
            "J2000.0 (assumed; generator.epoch absent)".to_string(),
        ),
        Some(e) => match e.to_jd() {
            Some(jd) => (jd, e.label()),
            None => {
                return Err(format!(
                    "navigational star catalogue: generator.epoch {:?} is not a recognised epoch",
                    e.label()
                ));
            }
        },
    };
    // Proper motion carries a J2000 place forward; here we need to run it backwards
    // from the file's epoch, so the interval is negated.
    let years_to_j2000 = (JD_J2000 - epoch_jd) / 365.25;

    let mut stars = Vec::with_capacity(file.stars.len());
    for r in &file.stars {
        if !r.ra_deg.is_finite()
            || !r.dec_deg.is_finite()
            || !(-90.0..=90.0).contains(&r.dec_deg)
            || !r.pm_ra_cosdec_mas_yr.is_finite()
            || !r.pm_dec_mas_yr.is_finite()
            || !r.parallax_mas.is_finite()
        {
            return Err(format!(
                "navigational star catalogue: {} (HIP {}) has out-of-range or non-finite values",
                r.name, r.hip
            ));
        }
        let (ra, dec) = if years_to_j2000 == 0.0 {
            (norm_360(r.ra_deg), r.dec_deg)
        } else {
            // `proper_motion_from_j2000` measures from J2000; feeding it a date
            // `years_to_j2000` away from J2000 applies exactly that interval.
            let v = proper_motion_from_j2000(
                r.ra_deg,
                r.dec_deg,
                r.pm_ra_cosdec_mas_yr,
                r.pm_dec_mas_yr,
                JD_J2000 + years_to_j2000 * 365.25,
            );
            crate::frames::radec_from_vector(v)
        };
        stars.push(StarEntry {
            name: r.name.clone(),
            hip: r.hip,
            ra_j2000_deg: ra,
            dec_j2000_deg: dec,
            pm_ra_cosdec_mas_per_year: r.pm_ra_cosdec_mas_yr,
            pm_dec_mas_per_year: r.pm_dec_mas_yr,
            parallax_mas: r.parallax_mas,
            magnitude: r.mag,
        });
    }

    let g = file.generator;
    Ok((
        stars,
        Provenance {
            source: g.source,
            retrieved: g.retrieved,
            license: g.license,
            epoch: epoch_label,
            provisional: g.provisional,
        },
    ))
}

fn loaded() -> &'static Loaded {
    static CELL: OnceLock<Loaded> = OnceLock::new();
    CELL.get_or_init(|| match parse(CATALOG_JSON) {
        Ok((stars, provenance)) => Loaded {
            stars,
            provenance,
            error: None,
        },
        Err(e) => Loaded {
            stars: Vec::new(),
            provenance: Provenance::default(),
            error: Some(e),
        },
    })
}

/// Every catalogue star, in the file's order (Nautical Almanac alphabetical, Polaris
/// last). Empty if the embedded file failed to parse; see [`load_error`].
pub fn navigational_stars() -> &'static [StarEntry] {
    &loaded().stars
}

/// Why the embedded catalogue could not be loaded, if it could not be. Always `None`
/// for a well-formed build; a test asserts as much.
pub fn load_error() -> Option<&'static str> {
    loaded().error.as_deref()
}

/// Where the catalogue numbers came from, for display and for the provider's coverage
/// notes.
pub fn provenance() -> &'static Provenance {
    &loaded().provenance
}

/// Catalogue star names in catalogue order.
pub fn names() -> Vec<&'static str> {
    navigational_stars()
        .iter()
        .map(|s| s.name.as_str())
        .collect()
}

/// Strip everything but ASCII alphanumerics and lowercase, so `"Al Na'ir"`,
/// `"al nair"` and `"ALNAIR"` all compare equal.
fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Parse `"HIP 91262"`, `"hip91262"`, `"HIP-91262"` into the HIP number.
fn hip_number(s: &str) -> Option<u32> {
    let t = s.trim();
    let rest = t
        .strip_prefix("HIP")
        .or_else(|| t.strip_prefix("hip"))
        .or_else(|| t.strip_prefix("Hip"))?;
    rest.trim_start_matches([' ', '-', '_', '\t'])
        .parse::<u32>()
        .ok()
}

/// Look up a star by Nautical Almanac name (case-insensitive) or by `"HIP <number>"`.
///
/// The name match is exact-but-case-insensitive first, then falls back to comparing
/// with spaces, hyphens and apostrophes removed, so `"Al Nair"` and `"KausAustralis"`
/// also resolve. `"Sun"` is deliberately not here: this catalogue holds stars only.
pub fn find(name: &str) -> Option<&'static StarEntry> {
    let stars = navigational_stars();
    if let Some(hip) = hip_number(name) {
        return stars.iter().find(|s| s.hip == hip);
    }
    let want = name.trim();
    if let Some(s) = stars.iter().find(|s| s.name.eq_ignore_ascii_case(want)) {
        return Some(s);
    }
    let squashed = squash(want);
    if squashed.is_empty() {
        return None;
    }
    stars.iter().find(|s| squash(&s.name) == squashed)
}

/// Construct an [`EphemerisError`] describing a failed catalogue load.
pub(crate) fn load_error_as_ephemeris_error(provider: &str) -> Option<EphemerisError> {
    load_error().map(|e| EphemerisError::Data(format!("{provider}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_catalogue_parses() {
        assert_eq!(load_error(), None, "embedded catalogue failed to load");
        assert_eq!(navigational_stars().len(), 58);
    }

    #[test]
    fn lookup_accepts_names_and_hip_numbers() {
        let vega = find("Vega").unwrap();
        assert_eq!(vega.hip, 91262);
        assert_eq!(find("vega").unwrap().hip, 91262);
        assert_eq!(find("VEGA").unwrap().hip, 91262);
        assert_eq!(find("HIP 91262").unwrap().name, "Vega");
        assert_eq!(find("hip91262").unwrap().name, "Vega");
        assert_eq!(find("HIP-91262").unwrap().name, "Vega");
        assert_eq!(find("Al Na'ir").unwrap().hip, 109268);
        assert_eq!(find("Al Nair").unwrap().hip, 109268);
        assert_eq!(find("Rigil Kentaurus").unwrap().hip, 71683);
        assert!(find("Sun").is_none());
        assert!(find("HIP 1").is_none());
        assert!(find("").is_none());
    }

    /// Published J2000 places, independent of this file's own numbers.
    #[test]
    fn spot_check_against_published_j2000_positions() {
        // Vega: 18h36m56.336s, +38d47'01.28".
        let v = find("Vega").unwrap();
        let ra = (18.0 + 36.0 / 60.0 + 56.336 / 3600.0) * 15.0;
        let dec = 38.0 + 47.0 / 60.0 + 1.28 / 3600.0;
        assert!((v.ra_j2000_deg - ra).abs() * 3600.0 < 0.05);
        assert!((v.dec_j2000_deg - dec).abs() * 3600.0 < 0.05);
        // Polaris: 2h31m49.09s, +89d15'50.8".
        let p = find("Polaris").unwrap();
        let ra = (2.0 + 31.0 / 60.0 + 49.09 / 3600.0) * 15.0;
        let dec = 89.0 + 15.0 / 60.0 + 50.8 / 3600.0;
        assert!((p.ra_j2000_deg - ra).abs() * 3600.0 < 0.3);
        assert!((p.dec_j2000_deg - dec).abs() * 3600.0 < 0.3);
        // Sirius: 6h45m8.917s, -16d42'58.02".
        let s = find("Sirius").unwrap();
        let ra = (6.0 + 45.0 / 60.0 + 8.917 / 3600.0) * 15.0;
        let dec = -(16.0 + 42.0 / 60.0 + 58.02 / 3600.0);
        assert!((s.ra_j2000_deg - ra).abs() * 3600.0 < 0.05);
        assert!((s.dec_j2000_deg - dec).abs() * 3600.0 < 0.05);
    }

    #[test]
    fn a_j1991_25_file_is_propagated_to_j2000() {
        // Rigil Kentaurus moves 3.71"/yr, so 8.75 years is about 32".
        let at_1991 = r#"{
          "schema": "skyfix.reference/1",
          "generator": {"epoch": "J1991.25"},
          "stars": [{"name": "Rigil Kentaurus", "hip": 71683,
                     "ra_deg": 219.92041034, "dec_deg": -60.83514707,
                     "pm_ra_cosdec_mas_yr": -3678.19, "pm_dec_mas_yr": 481.84,
                     "parallax_mas": 742.12, "mag": -0.01}]
        }"#;
        let (stars, prov) = parse(at_1991).unwrap();
        assert_eq!(prov.epoch, "J1991.25");
        let s = &stars[0];
        let embedded = find("Rigil Kentaurus").unwrap();
        let d_ra =
            (s.ra_j2000_deg - embedded.ra_j2000_deg) * 3600.0 * s.dec_j2000_deg.to_radians().cos();
        let d_dec = (s.dec_j2000_deg - embedded.dec_j2000_deg) * 3600.0;
        assert!(
            d_ra.abs() < 0.01 && d_dec.abs() < 0.01,
            "propagated place differs from the embedded one by ({d_ra}\", {d_dec}\")"
        );
        // And it really did move: the raw file value is 32" away from J2000.
        let moved = (219.92041034 - s.ra_j2000_deg) * 3600.0 * s.dec_j2000_deg.to_radians().cos();
        assert!(
            moved.abs() > 25.0,
            "expected ~32\" of motion, got {moved}\""
        );
    }

    #[test]
    fn a_bad_file_is_reported_not_panicked() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"schema":"skyfix.reference/1","stars":[]}"#).is_err());
        assert!(
            parse(r#"{"schema":"wrong/1","stars":[{"name":"x","hip":1,"ra_deg":0,"dec_deg":0}]}"#)
                .is_err()
        );
        assert!(
            parse(
                r#"{"schema":"skyfix.reference/1","generator":{"epoch":"yesterday"},
                     "stars":[{"name":"x","hip":1,"ra_deg":0,"dec_deg":0}]}"#
            )
            .is_err()
        );
        assert!(
            parse(
                r#"{"schema":"skyfix.reference/1",
                     "stars":[{"name":"x","hip":1,"ra_deg":0,"dec_deg":91}]}"#
            )
            .is_err()
        );
    }
}
