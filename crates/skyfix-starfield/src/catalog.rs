//! The display catalogue: 9 095 naked-eye stars from NASA HEASARC's copy of the Yale
//! Bright Star Catalogue (5th revised edition), in HR order.
//!
//! `data/stars.bin` is written by `tools/starfield/build.py`. It is a 16-byte header
//! (`b"SKYFIXSF"`, format version `u16`, record size `u16`, star count `u32`) and one
//! 25-byte little-endian record per star:
//!
//! | bytes | type | field |
//! |---|---|---|
//! | 0-1 | `u16` | HR (Bright Star Catalogue) number |
//! | 2-5 | `u32` | J2000 right ascension, units of 0.1 s of time (the catalogue's precision) |
//! | 6-9 | `i32` | J2000 declination, arcseconds (the catalogue's precision) |
//! | 10-11 | `i16` | proper motion in RA, `mu_alpha cos(delta)`, mas/yr |
//! | 12-13 | `i16` | proper motion in Dec, mas/yr |
//! | 14-15 | `u16` | parallax, mas (negative published values stored as 0) |
//! | 16-17 | `i16` | V magnitude, 0.01 mag |
//! | 18-19 | `i16` | B-V, 0.01 mag; `-32768` when the catalogue has none |
//! | 20 | `u8` | Bayer letter, 1 = alpha ... 24 = omega, 0 = none |
//! | 21 | `u8` | Bayer superscript, 0 = none |
//! | 22-23 | `u16` | Flamsteed number, 0 = none |
//! | 24 | `u8` | constellation of the designation, index into [`crate::CONSTELLATIONS`], 255 = none |
//!
//! Positions and proper motions are the catalogue's FK5 J2000 values, used as ICRS
//! (the two frames differ by a few hundredths of an arcsecond, far below display
//! resolution). The catalogue has no position for 14 entries (novae, clusters and two
//! galaxies' supernovae); those, and the recurrent nova T CrB (catalogued at its
//! outburst peak), are left out by the build. `data/manifest.json` records all of it.

use std::collections::HashMap;

use crate::StarfieldError;
use crate::constellations::CONSTELLATIONS;

const STARS_BIN: &[u8] = include_bytes!("../data/stars.bin");
const NAMES_TXT: &str = include_str!("../data/names.txt");

const MAGIC: &[u8; 8] = b"SKYFIXSF";
const VERSION: u16 = 1;
const HEADER_BYTES: usize = 16;
const RECORD_BYTES: usize = 25;
const BV_UNKNOWN: i16 = i16::MIN;

const GREEK: [&str; 24] = [
    "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "ο", "π", "ρ", "σ", "τ",
    "υ", "φ", "χ", "ψ", "ω",
];
const SUPERSCRIPT: [&str; 10] = ["", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

/// A Bayer or Flamsteed designation as the catalogue gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Designation {
    /// 1 = alpha ... 24 = omega; 0 when the star has no Bayer letter.
    pub bayer: u8,
    /// Bayer superscript (alpha-1, alpha-2 ...), 0 when none.
    pub superscript: u8,
    /// Flamsteed number, 0 when none.
    pub flamsteed: u16,
    /// Index into [`CONSTELLATIONS`]; `None` when the star has neither designation.
    pub constellation: Option<u8>,
}

impl Designation {
    /// `"α Ori"`, `"α¹ Cru"`, `"58 Ori"`, or `""` when the catalogue gives neither
    /// designation. A Bayer letter wins over a Flamsteed number.
    pub fn render(&self) -> String {
        let Some(c) = self.constellation else {
            return String::new();
        };
        let abbr = CONSTELLATIONS[usize::from(c)].0;
        if self.bayer > 0 {
            format!(
                "{}{} {}",
                GREEK[usize::from(self.bayer) - 1],
                SUPERSCRIPT[usize::from(self.superscript)],
                abbr
            )
        } else if self.flamsteed > 0 {
            format!("{} {}", self.flamsteed, abbr)
        } else {
            String::new()
        }
    }
}

/// The stars as parallel arrays (the shape the browser wants), HR order.
#[derive(Debug, Clone)]
pub struct Catalog {
    pub hr: Vec<i32>,
    /// Visual magnitude.
    pub vmag: Vec<f32>,
    /// B-V colour index; NaN when the catalogue has none.
    pub bv: Vec<f32>,
    /// ICRS (FK5 J2000) right ascension at epoch J2000.0, degrees `[0, 360)`.
    pub ra_j2000_deg: Vec<f64>,
    pub dec_j2000_deg: Vec<f64>,
    /// `mu_alpha cos(delta)`, mas per Julian year.
    pub pm_ra_cosdec_mas_yr: Vec<f64>,
    pub pm_dec_mas_yr: Vec<f64>,
    /// Annual parallax, mas (0 when the catalogue has none or a negative one).
    pub parallax_mas: Vec<f64>,
    pub designation: Vec<Designation>,
    /// [`Designation::render`] for every star, `""` when none.
    pub designations: Vec<String>,
    /// Proper names, `(index, name)`, sorted by index.
    pub names: Vec<(usize, String)>,
    index_by_hr: HashMap<i32, usize>,
}

impl Catalog {
    pub fn len(&self) -> usize {
        self.hr.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hr.is_empty()
    }

    /// The catalogue index of a Bright Star Catalogue number.
    pub fn index_of_hr(&self, hr: i32) -> Option<usize> {
        self.index_by_hr.get(&hr).copied()
    }

    /// The proper name of the star at `index`, if it has one.
    pub fn name_of(&self, index: usize) -> Option<&str> {
        self.names
            .binary_search_by_key(&index, |(i, _)| *i)
            .ok()
            .map(|k| self.names[k].1.as_str())
    }
}

fn le_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn le_i16(b: &[u8], at: usize) -> i16 {
    i16::from_le_bytes([b[at], b[at + 1]])
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn le_i32(b: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn data_err(msg: impl Into<String>) -> StarfieldError {
    StarfieldError::Data(msg.into())
}

/// Decode `stars.bin` and `names.txt`.
pub(crate) fn parse() -> Result<Catalog, StarfieldError> {
    parse_from(STARS_BIN, NAMES_TXT)
}

pub(crate) fn parse_from(bin: &[u8], names_txt: &str) -> Result<Catalog, StarfieldError> {
    if bin.len() < HEADER_BYTES || &bin[0..8] != MAGIC {
        return Err(data_err("stars.bin: bad header"));
    }
    let version = le_u16(bin, 8);
    let record = usize::from(le_u16(bin, 10));
    let count = le_u32(bin, 12) as usize;
    if version != VERSION || record != RECORD_BYTES {
        return Err(data_err(format!(
            "stars.bin: format {version} with {record}-byte records, expected {VERSION} with {RECORD_BYTES}"
        )));
    }
    if bin.len() != HEADER_BYTES + count * RECORD_BYTES {
        return Err(data_err("stars.bin: length does not match the star count"));
    }

    let mut c = Catalog {
        hr: Vec::with_capacity(count),
        vmag: Vec::with_capacity(count),
        bv: Vec::with_capacity(count),
        ra_j2000_deg: Vec::with_capacity(count),
        dec_j2000_deg: Vec::with_capacity(count),
        pm_ra_cosdec_mas_yr: Vec::with_capacity(count),
        pm_dec_mas_yr: Vec::with_capacity(count),
        parallax_mas: Vec::with_capacity(count),
        designation: Vec::with_capacity(count),
        designations: Vec::with_capacity(count),
        names: Vec::new(),
        index_by_hr: HashMap::with_capacity(count),
    };
    for i in 0..count {
        let r = &bin[HEADER_BYTES + i * RECORD_BYTES..HEADER_BYTES + (i + 1) * RECORD_BYTES];
        let hr = i32::from(le_u16(r, 0));
        let ra_tenths = le_u32(r, 2);
        let dec_arcsec = le_i32(r, 6);
        if ra_tenths >= 864_000 || !(-324_000..=324_000).contains(&dec_arcsec) {
            return Err(data_err(format!(
                "stars.bin: HR {hr} has an impossible position"
            )));
        }
        let bv = le_i16(r, 18);
        let constellation = match r[24] {
            255 => None,
            k if usize::from(k) < CONSTELLATIONS.len() => Some(k),
            k => return Err(data_err(format!("stars.bin: HR {hr} constellation {k}"))),
        };
        let d = Designation {
            bayer: r[20],
            superscript: r[21],
            flamsteed: le_u16(r, 22),
            constellation,
        };
        if d.bayer > 24 || d.superscript > 9 {
            return Err(data_err(format!(
                "stars.bin: HR {hr} has a bad designation"
            )));
        }
        if c.index_by_hr.insert(hr, i).is_some() {
            return Err(data_err(format!("stars.bin: HR {hr} appears twice")));
        }
        c.hr.push(hr);
        c.ra_j2000_deg.push(f64::from(ra_tenths) / 2400.0);
        c.dec_j2000_deg.push(f64::from(dec_arcsec) / 3600.0);
        c.pm_ra_cosdec_mas_yr.push(f64::from(le_i16(r, 10)));
        c.pm_dec_mas_yr.push(f64::from(le_i16(r, 12)));
        c.parallax_mas.push(f64::from(le_u16(r, 14)));
        c.vmag.push(f32::from(le_i16(r, 16)) / 100.0);
        c.bv.push(if bv == BV_UNKNOWN {
            f32::NAN
        } else {
            f32::from(bv) / 100.0
        });
        c.designations.push(d.render());
        c.designation.push(d);
    }

    for line in names_txt.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (hr, name) = line
            .split_once('|')
            .ok_or_else(|| data_err(format!("names.txt: malformed line {line:?}")))?;
        let hr: i32 = hr
            .parse()
            .map_err(|_| data_err(format!("names.txt: bad HR in {line:?}")))?;
        let index = c
            .index_of_hr(hr)
            .ok_or_else(|| data_err(format!("names.txt: HR {hr} is not in the catalogue")))?;
        c.names.push((index, name.to_string()));
    }
    c.names.sort_by_key(|(i, _)| *i);
    if c.names.windows(2).any(|w| w[0].0 == w[1].0) {
        return Err(data_err("names.txt: a star is named twice"));
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn designations_render_with_greek_letters_and_superscripts() {
        let d = Designation {
            bayer: 1,
            superscript: 0,
            flamsteed: 58,
            constellation: Some(59),
        };
        assert_eq!(CONSTELLATIONS[59].0, "Ori");
        assert_eq!(d.render(), "α Ori");
        let d = Designation {
            bayer: 1,
            superscript: 1,
            flamsteed: 0,
            constellation: Some(29),
        };
        assert_eq!(d.render(), "α¹ Cru");
        let d = Designation {
            bayer: 0,
            superscript: 0,
            flamsteed: 58,
            constellation: Some(59),
        };
        assert_eq!(d.render(), "58 Ori");
        assert_eq!(Designation::default().render(), "");
    }

    #[test]
    fn a_damaged_file_is_an_error_not_a_panic() {
        assert!(parse_from(b"nonsense", "").is_err());
        let mut bin = STARS_BIN.to_vec();
        bin.truncate(bin.len() - 1);
        assert!(parse_from(&bin, NAMES_TXT).is_err());
        assert!(parse_from(STARS_BIN, "1|x\n1|y\n").is_err());
        assert!(parse_from(STARS_BIN, "999999|Nowhere\n").is_err());
        assert!(parse_from(STARS_BIN, NAMES_TXT).is_ok());
    }
}
