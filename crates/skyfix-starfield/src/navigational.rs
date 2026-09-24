//! Which display-catalogue star is each of the 58 navigational stars.
//!
//! The navigational stars live in `skyfix_ephemeris::catalog` (Hipparcos positions at
//! J2000.0, Nautical Almanac names); the display catalogue is the Bright Star
//! Catalogue. They are matched here by position and magnitude, never by name, so a
//! mismatch between the two catalogues cannot hide: every navigational star must have a
//! catalogue star within 1' whose V magnitude is within 1.0 of the Hipparcos value.
//!
//! When several candidates qualify (close pairs such as alpha-1/alpha-2 Crucis and
//! alpha-1/alpha-2 Centauri, whose components the Bright Star Catalogue lists
//! separately), the one minimising `|dm| + separation/1'` wins: magnitude is what tells
//! the components apart, position what tells neighbours apart. The Almanac tabulates
//! the brighter component in both of those pairs, and so does Hipparcos's entry.
//!
//! The match is for drawing only (CONVENTIONS 13.6): the explorer still takes every
//! navigational star's place from `skyfix_ephemeris::stars`.

use crate::{Catalog, StarfieldError};

/// Largest accepted separation between the two catalogues' J2000 places, arcseconds.
pub const MAX_SEPARATION_ARCSEC: f64 = 60.0;
/// Largest accepted V-magnitude difference.
pub const MAX_MAGNITUDE_DIFFERENCE: f64 = 1.0;

/// One navigational star and its display-catalogue counterpart.
#[derive(Debug, Clone, PartialEq)]
pub struct NavigationalMatch {
    /// Nautical Almanac spelling, as everywhere else in SkyFix Lab.
    pub name: &'static str,
    /// Index into the display catalogue.
    pub index: usize,
    pub hr: i32,
    /// Separation between the Hipparcos and Bright Star Catalogue J2000 places.
    pub separation_arcsec: f64,
    /// Bright Star Catalogue V minus Hipparcos V.
    pub magnitude_difference: f64,
}

fn unit(ra_deg: f64, dec_deg: f64) -> [f64; 3] {
    let (sa, ca) = ra_deg.to_radians().sin_cos();
    let (sd, cd) = dec_deg.to_radians().sin_cos();
    [cd * ca, cd * sa, sd]
}

fn separation_arcsec(u: [f64; 3], v: [f64; 3]) -> f64 {
    let c = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    s.atan2(u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
        .to_degrees()
        * 3600.0
}

pub(crate) fn cross_identify(c: &Catalog) -> Result<Vec<NavigationalMatch>, StarfieldError> {
    if let Some(e) = skyfix_ephemeris::catalog::load_error() {
        return Err(StarfieldError::Data(format!("navigational catalogue: {e}")));
    }
    let units: Vec<[f64; 3]> = (0..c.len())
        .map(|i| unit(c.ra_j2000_deg[i], c.dec_j2000_deg[i]))
        .collect();
    let limit_cos = (MAX_SEPARATION_ARCSEC / 3600.0).to_radians().cos();
    let mut out = Vec::new();
    for s in skyfix_ephemeris::catalog::navigational_stars() {
        let u = unit(s.ra_j2000_deg, s.dec_j2000_deg);
        let best = units
            .iter()
            .enumerate()
            .filter(|(_, v)| u[0] * v[0] + u[1] * v[1] + u[2] * v[2] >= limit_cos)
            .map(|(i, v)| {
                let sep = separation_arcsec(u, *v);
                let dm = f64::from(c.vmag[i]) - s.magnitude;
                (i, sep, dm)
            })
            .filter(|&(_, sep, dm)| {
                sep <= MAX_SEPARATION_ARCSEC && dm.abs() <= MAX_MAGNITUDE_DIFFERENCE
            })
            .min_by(|a, b| {
                let score = |x: &(usize, f64, f64)| x.2.abs() + x.1 / MAX_SEPARATION_ARCSEC;
                score(a).total_cmp(&score(b))
            });
        let (index, separation_arcsec, magnitude_difference) = best.ok_or_else(|| {
            StarfieldError::Data(format!(
                "no display-catalogue star within 1' and 1 mag of {} (HIP {})",
                s.name, s.hip
            ))
        })?;
        out.push(NavigationalMatch {
            name: s.name.as_str(),
            index,
            hr: c.hr[index],
            separation_arcsec,
            magnitude_difference,
        });
    }
    Ok(out)
}
