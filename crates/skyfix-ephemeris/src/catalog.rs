//! Navigational star catalogue: the 57 Nautical Almanac stars plus Polaris.
//! OWNER: ephemeris agent. J2000 positions and proper motions with provenance
//! (Hipparcos / the source actually used, recorded in THIRD_PARTY.md).

#[derive(Debug, Clone, PartialEq)]
pub struct StarEntry {
    pub name: &'static str,
    pub hip: u32,
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
    pub pm_ra_cosdec_mas_per_year: f64,
    pub pm_dec_mas_per_year: f64,
    pub magnitude: f64,
}
