//! Star names from the IAU Working Group on Star Names, and HIP numbers.
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6).
//!
//! `data/names_wgsn.txt` is written by `tools/starfield/wgsn.py`: every IAU-named star
//! of the catalogue (joined by HR number and checked by position or designation), as
//! `hr|hip|name`. The name is given only where `names.txt` (the star field's own 252
//! names, with the Nautical Almanac spellings of the navigational stars) has none, so
//! [`extend`] never replaces an existing name. Star names are facts; the docs say "star
//! names: IAU WGSN".
//!
//! HIP numbers are known for the WGSN stars (from the WGSN catalogue) and for the 58
//! navigational stars (from the navigation catalogue); [`hip_of`] answers for those and
//! `None` otherwise.

use std::sync::OnceLock;

use crate::{Catalog, StarfieldError};

const NAMES_WGSN_TXT: &str = include_str!("../data/names_wgsn.txt");

fn bad() -> StarfieldError {
    StarfieldError::Data("names_wgsn.txt is malformed".into())
}

fn parse() -> Result<Vec<(i32, u32, &'static str)>, StarfieldError> {
    let mut out = Vec::new();
    for line in NAMES_WGSN_TXT.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let mut f = line.split('|');
        let (Some(hr), Some(hip), Some(name), None) = (f.next(), f.next(), f.next(), f.next())
        else {
            return Err(bad());
        };
        out.push((
            hr.parse().map_err(|_| bad())?,
            hip.parse().map_err(|_| bad())?,
            name,
        ));
    }
    Ok(out)
}

/// Add the WGSN names to the stars that have none. Called once, when the catalogue
/// is loaded.
pub(crate) fn extend(c: &mut Catalog) -> Result<(), StarfieldError> {
    for (hr, _, name) in parse()? {
        if name.is_empty() {
            continue;
        }
        // A star missing from the catalogue, one already named, or a name already
        // used would be a packaging error (the build and the tests rule them out).
        let index = c.index_of_hr(hr).ok_or_else(bad)?;
        if c.name_of(index).is_some() || c.names.iter().any(|(_, n)| n == name) {
            return Err(bad());
        }
        let at = c.names.partition_point(|(i, _)| *i < index);
        c.names.insert(at, (index, name.to_string()));
    }
    Ok(())
}

/// `(catalogue index, HIP)` for every star whose HIP number is known, by index.
fn hip_table() -> &'static [(usize, u32)] {
    static CELL: OnceLock<Vec<(usize, u32)>> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut m: Vec<(usize, u32)> = Vec::new();
        let (Ok(sf), Ok(rows)) = (crate::starfield(), parse()) else {
            return m;
        };
        let mut add = |i: usize, hip: u32| {
            if let Err(at) = m.binary_search_by_key(&i, |x| x.0) {
                m.insert(at, (i, hip));
            }
        };
        for nav in &sf.navigational {
            if let Some(s) = skyfix_ephemeris::catalog::find(nav.name) {
                add(nav.index, s.hip);
            }
        }
        for (hr, hip, _) in rows {
            if let (Some(i), true) = (sf.catalog.index_of_hr(hr), hip > 0) {
                add(i, hip);
            }
        }
        m
    })
}

/// The HIP number of a catalogue star, where it is known.
pub fn hip_of(index: usize) -> Option<u32> {
    let t = hip_table();
    t.binary_search_by_key(&index, |x| x.0).ok().map(|k| t[k].1)
}

/// The catalogue star with a HIP number, where it is known.
pub fn index_of_hip(hip: u32) -> Option<usize> {
    hip_table().iter().find(|x| x.1 == hip).map(|x| x.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wgsn_names_extend_and_never_replace() {
        let c = crate::catalog().unwrap();
        // The 252 own names and the 220 WGSN additions.
        assert!(c.names.len() >= 450, "{}", c.names.len());
        assert!(c.names.windows(2).all(|w| w[0].0 < w[1].0));
        let named = |hr: i32| c.name_of(c.index_of_hr(hr).unwrap());
        // Ours kept: Navi (gamma Cas; the WGSN says Tiansi), Al Na'ir (not Alnair).
        assert_eq!(named(264), Some("Navi"));
        assert_eq!(named(8425), Some("Al Na'ir"));
        // Added: Simmakh (41 Psc, HR 80), Mizar (HR 5054) was already ours.
        assert_eq!(named(80), Some("Simmakh"));
        assert_eq!(named(5054), Some("Mizar"));
        // HIP numbers: from the WGSN, and the navigational stars' own.
        assert_eq!(hip_of(c.index_of_hr(2491).unwrap()), Some(32349)); // Sirius
        assert_eq!(hip_of(c.index_of_hr(80).unwrap()), Some(1645));
        assert_eq!(hip_of(c.index_of_hr(3).unwrap()), None);
    }
}
