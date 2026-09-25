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
//!
//! ## Space motion (expansion programme)
//!
//! Each entry also keeps the file's own epoch and position, its radial velocity
//! (`rv_km_s`, SIMBAD's, absent means 0) and, for a star that orbits a companion, the
//! orbit (`orbit`: Rigil Kentaurus, alpha Centauri A about the A-B barycentre).
//! [`StarEntry::barycentric_direction`] propagates from the catalogue epoch by rigorous
//! rectilinear space motion ([`crate::frames::space_motion`], the model of Skyfield's
//! `Star` and ERFA's `eraStarpv`, perspective acceleration included) and, for an
//! orbiting star, adds the primary's offset about the barycentre. The J2000 fields are
//! that model at J2000, for display and for the older single-star functions.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::EphemerisError;
use skyfix_core::time::JD_J2000;
use skyfix_core::units::norm_360;

/// The embedded catalogue file. Path is relative to this source file.
const CATALOG_JSON: &str = include_str!("../../../fixtures/reference/navigational_stars_hip.json");

/// One catalogue star. The `*_j2000_*` positions are ICRS at epoch J2000.0 (see the
/// module docs); the model itself runs from the catalogue epoch
/// ([`StarEntry::barycentric_direction`]).
#[derive(Debug, Clone, PartialEq)]
pub struct StarEntry {
    /// Nautical Almanac spelling, e.g. `"Al Na'ir"`, `"Rigil Kentaurus"`.
    pub name: String,
    pub hip: u32,
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
    /// The catalogue's proper motion (for an orbiting star, the primary's instantaneous
    /// one at the catalogue epoch, as published).
    pub pm_ra_cosdec_mas_per_year: f64,
    pub pm_dec_mas_per_year: f64,
    /// Annual parallax, milliarcseconds. Used for the (small) parallactic shift.
    pub parallax_mas: f64,
    pub magnitude: f64,
    /// Radial velocity, km/s, positive receding (0 when the file has none).
    pub rv_km_s: f64,
    /// Catalogue epoch (TT Julian date) and the position there, degrees.
    pub epoch_jd: f64,
    pub ra_epoch_deg: f64,
    pub dec_epoch_deg: f64,
    /// For a star orbiting a companion, the orbit; `None` otherwise.
    pub orbit: Option<BinaryOrbit>,
    /// The proper motion the linear part of the model uses: the catalogue's, less the
    /// primary's orbital velocity at the catalogue epoch for an orbiting star.
    pub bary_pm_ra_cosdec_mas_per_year: f64,
    pub bary_pm_dec_mas_per_year: f64,
}

/// A visual-binary orbit (elements of the secondary relative to the primary, the
/// convention of the USNO Sixth Orbit Catalog) and the secondary's mass fraction, so the
/// primary's offset from the barycentre is `-f_B` times the relative position.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct BinaryOrbit {
    pub period_yr: f64,
    pub semi_major_arcsec: f64,
    pub inclination_deg: f64,
    pub node_deg: f64,
    pub periastron_epoch_yr: f64,
    pub eccentricity: f64,
    pub periastron_arg_deg: f64,
    pub secondary_mass_fraction: f64,
}

impl BinaryOrbit {
    /// Secondary relative to primary at Julian year `year`, `(north, east)` arcseconds
    /// (Thiele-Innes constants; Kepler's equation by Newton to machine precision).
    pub fn relative_offset_arcsec(&self, year: f64) -> [f64; 2] {
        let e = self.eccentricity;
        let m = std::f64::consts::TAU * (year - self.periastron_epoch_yr) / self.period_yr;
        let m = m.rem_euclid(std::f64::consts::TAU);
        let mut ea = if e < 0.8 { m } else { std::f64::consts::PI };
        for _ in 0..60 {
            let d = (ea - e * ea.sin() - m) / (1.0 - e * ea.cos());
            ea -= d;
            if d.abs() < 1e-15 {
                break;
            }
        }
        let x = ea.cos() - e;
        let y = (1.0 - e * e).sqrt() * ea.sin();
        let (si, ci) = self.inclination_deg.to_radians().sin_cos();
        let _ = si;
        let (so, co) = self.node_deg.to_radians().sin_cos();
        let (sw, cw) = self.periastron_arg_deg.to_radians().sin_cos();
        let a = self.semi_major_arcsec;
        let ta = a * (cw * co - sw * so * ci);
        let tb = a * (cw * so + sw * co * ci);
        let tf = a * (-sw * co - cw * so * ci);
        let tg = a * (-sw * so + cw * co * ci);
        [ta * x + tf * y, tb * x + tg * y]
    }

    /// The primary about the barycentre, `(north, east)` arcseconds.
    pub fn primary_offset_arcsec(&self, year: f64) -> [f64; 2] {
        let r = self.relative_offset_arcsec(year);
        [
            -self.secondary_mass_fraction * r[0],
            -self.secondary_mass_fraction * r[1],
        ]
    }

    /// The primary's orbital velocity, `(north, east)` arcseconds per Julian year.
    pub fn primary_velocity_arcsec_yr(&self, year: f64) -> [f64; 2] {
        let h = 1e-3;
        let (a, b) = (
            self.primary_offset_arcsec(year - h),
            self.primary_offset_arcsec(year + h),
        );
        [(b[0] - a[0]) / (2.0 * h), (b[1] - a[1]) / (2.0 * h)]
    }

    fn check(&self) -> Result<(), String> {
        let ok = self.period_yr > 0.0
            && self.semi_major_arcsec > 0.0
            && (0.0..1.0).contains(&self.eccentricity)
            && (0.0..=1.0).contains(&self.secondary_mass_fraction)
            && [
                self.inclination_deg,
                self.node_deg,
                self.periastron_arg_deg,
                self.periastron_epoch_yr,
            ]
            .iter()
            .all(|v| v.is_finite());
        if ok {
            Ok(())
        } else {
            Err("implausible orbit elements".to_string())
        }
    }
}

impl StarEntry {
    /// Barycentric (ICRS) unit vector of the star at `jd_tt`: rigorous rectilinear space
    /// motion from the catalogue epoch with the radial velocity, plus, for an orbiting
    /// star, the primary's offset about the barycentre relative to its value at the
    /// catalogue epoch, added in the tangent plane of the moving position.
    pub fn barycentric_direction(&self, jd_tt: f64) -> [f64; 3] {
        let years = (jd_tt - self.epoch_jd) / 365.25;
        let p = crate::frames::space_motion(
            self.ra_epoch_deg,
            self.dec_epoch_deg,
            self.bary_pm_ra_cosdec_mas_per_year,
            self.bary_pm_dec_mas_per_year,
            self.parallax_mas,
            self.rv_km_s,
            years,
        );
        match &self.orbit {
            None => p,
            Some(o) => {
                let epoch_year = julian_year(self.epoch_jd);
                let now = o.primary_offset_arcsec(julian_year(jd_tt));
                let then = o.primary_offset_arcsec(epoch_year);
                crate::frames::tangent_offset(
                    p,
                    (now[0] - then[0]) * skyfix_core::units::ARCSEC,
                    (now[1] - then[1]) * skyfix_core::units::ARCSEC,
                )
            }
        }
    }
}

fn julian_year(jd: f64) -> f64 {
    2000.0 + (jd - JD_J2000) / 365.25
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
    /// The authoritative Skyfield-generated file calls this array `cases`.
    #[serde(alias = "cases")]
    stars: Vec<StarRecord>,
}

#[derive(Deserialize, Default)]
struct Generator {
    /// The Skyfield-generated file records these under its own names.
    #[serde(default, alias = "catalogue_reference")]
    source: String,
    #[serde(default, alias = "generated_utc")]
    retrieved: String,
    #[serde(alias = "licence", default = "default_license_note")]
    license: String,
    /// Absent means J2000.0.
    #[serde(default)]
    epoch: Option<Epoch>,
    #[serde(default)]
    provisional: bool,
}

fn default_license_note() -> String {
    "see docs/THIRD_PARTY.md (Hipparcos, ESA 1997, served by CDS/VizieR)".to_string()
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
    #[serde(default)]
    rv_km_s: f64,
    #[serde(default)]
    orbit: Option<BinaryOrbit>,
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
            || !r.rv_km_s.is_finite()
            || r.rv_km_s.abs() > 1000.0
        {
            return Err(format!(
                "navigational star catalogue: {} (HIP {}) has out-of-range or non-finite values",
                r.name, r.hip
            ));
        }
        if let Some(o) = &r.orbit {
            o.check()
                .map_err(|e| format!("navigational star catalogue: {}: {e}", r.name))?;
        }
        // The linear part of the model moves the barycentre: for an orbiting star, the
        // catalogue's (instantaneous) proper motion less the primary's orbital velocity
        // at the catalogue epoch, so the model reproduces the catalogue there.
        let (bary_pm_ra, bary_pm_dec) = match &r.orbit {
            None => (r.pm_ra_cosdec_mas_yr, r.pm_dec_mas_yr),
            Some(o) => {
                let v = o.primary_velocity_arcsec_yr(julian_year(epoch_jd));
                (
                    r.pm_ra_cosdec_mas_yr - v[1] * 1000.0,
                    r.pm_dec_mas_yr - v[0] * 1000.0,
                )
            }
        };
        let mut entry = StarEntry {
            name: r.name.clone(),
            hip: r.hip,
            ra_j2000_deg: 0.0,
            dec_j2000_deg: 0.0,
            pm_ra_cosdec_mas_per_year: r.pm_ra_cosdec_mas_yr,
            pm_dec_mas_per_year: r.pm_dec_mas_yr,
            parallax_mas: r.parallax_mas,
            magnitude: r.mag,
            rv_km_s: r.rv_km_s,
            epoch_jd,
            ra_epoch_deg: norm_360(r.ra_deg),
            dec_epoch_deg: r.dec_deg,
            orbit: r.orbit,
            bary_pm_ra_cosdec_mas_per_year: bary_pm_ra,
            bary_pm_dec_mas_per_year: bary_pm_dec,
        };
        // The J2000 place is the same model at J2000 (the catalogue's own place when
        // the file is already at J2000.0).
        let (ra, dec) = if years_to_j2000 == 0.0 {
            (norm_360(r.ra_deg), r.dec_deg)
        } else {
            crate::frames::radec_from_vector(entry.barycentric_direction(JD_J2000))
        };
        entry.ra_j2000_deg = ra;
        entry.dec_j2000_deg = dec;
        stars.push(entry);
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
        // Arcturus moves 2.28"/yr, so 8.75 years is about 20" (no orbit, a radial
        // velocity of -5.2 km/s: a millionth of an arcsecond of perspective here).
        let at_1991 = r#"{
          "schema": "skyfix.reference/1",
          "generator": {"epoch": "J1991.25"},
          "stars": [{"name": "Arcturus", "hip": 69673,
                     "ra_deg": 213.91811403, "dec_deg": 19.18726997,
                     "pm_ra_cosdec_mas_yr": -1093.45, "pm_dec_mas_yr": -1999.4,
                     "parallax_mas": 88.85, "mag": -0.05, "rv_km_s": -5.229}]
        }"#;
        let (stars, prov) = parse(at_1991).unwrap();
        assert_eq!(prov.epoch, "J1991.25");
        let s = &stars[0];
        let embedded = find("Arcturus").unwrap();
        let d_ra =
            (s.ra_j2000_deg - embedded.ra_j2000_deg) * 3600.0 * s.dec_j2000_deg.to_radians().cos();
        let d_dec = (s.dec_j2000_deg - embedded.dec_j2000_deg) * 3600.0;
        assert!(
            d_ra.abs() < 0.01 && d_dec.abs() < 0.01,
            "propagated place differs from the embedded one by ({d_ra}\", {d_dec}\")"
        );
        // And it really did move: the raw file value is 20" away from J2000.
        let moved = ((213.91811403 - s.ra_j2000_deg) * s.dec_j2000_deg.to_radians().cos())
            .hypot(19.18726997 - s.dec_j2000_deg)
            * 3600.0;
        assert!(
            (19.0..21.0).contains(&moved),
            "expected ~20\" of motion, got {moved}\""
        );
        // The model runs from the file's epoch with its radial velocity.
        assert_eq!(s.rv_km_s, -5.229);
        assert!((s.epoch_jd - (JD_J2000 - 8.75 * 365.25)).abs() < 1e-9);
    }

    #[test]
    fn rigil_kentaurus_follows_its_orbit_and_is_the_catalogue_at_its_epoch() {
        let s = find("Rigil Kentaurus").unwrap();
        let o = s.orbit.expect("alpha Cen A carries its orbit");
        // USNO's Sixth Orbit Catalog ephemeris (orb6ephem.txt) for alpha Cen AB:
        // 2026.0 separation 9.294", 2029.0 10.329" (position angles are of date there).
        for (year, rho) in [(2026.0, 9.294), (2029.0, 10.329)] {
            let r = o.relative_offset_arcsec(year);
            assert!((r[0].hypot(r[1]) - rho).abs() < 0.002, "{year}: {r:?}");
        }
        // At the catalogue epoch the model is the catalogue: the same place, and the
        // same (instantaneous) proper motion.
        let p0 = s.barycentric_direction(s.epoch_jd);
        let (ra, dec) = crate::frames::radec_from_vector(p0);
        assert!(((ra - s.ra_epoch_deg) * 3600.0).abs() < 1e-6);
        assert!(((dec - s.dec_epoch_deg) * 3600.0).abs() < 1e-6);
        let h = 36.525; // a tenth of a year
        let (ra1, dec1) = crate::frames::radec_from_vector(s.barycentric_direction(s.epoch_jd + h));
        let (ra0, dec0) = crate::frames::radec_from_vector(s.barycentric_direction(s.epoch_jd - h));
        let pm_ra = (ra1 - ra0) * 3.6e6 * dec.to_radians().cos() / 0.2;
        let pm_dec = (dec1 - dec0) * 3.6e6 / 0.2;
        assert!((pm_ra - s.pm_ra_cosdec_mas_per_year).abs() < 1.0, "{pm_ra}");
        assert!((pm_dec - s.pm_dec_mas_per_year).abs() < 1.0, "{pm_dec}");
        // Away from it, A leaves the tangent line: 5.8" in 2026 (tools/reference/acen_orbit.py).
        let jd_2026 = JD_J2000 + 26.0 * 365.25;
        let linear = crate::frames::space_motion(
            s.ra_epoch_deg,
            s.dec_epoch_deg,
            s.pm_ra_cosdec_mas_per_year,
            s.pm_dec_mas_per_year,
            s.parallax_mas,
            s.rv_km_s,
            (jd_2026 - s.epoch_jd) / 365.25,
        );
        let orbit = s.barycentric_direction(jd_2026);
        let sep = {
            let c = [
                linear[1] * orbit[2] - linear[2] * orbit[1],
                linear[2] * orbit[0] - linear[0] * orbit[2],
                linear[0] * orbit[1] - linear[1] * orbit[0],
            ];
            (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt() / skyfix_core::units::ARCSEC
        };
        assert!((sep - 5.78).abs() < 0.05, "{sep}\"");
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
