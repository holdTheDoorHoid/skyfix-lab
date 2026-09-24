//! CONVENTIONS section 5: the correction chain.
//!
//! OWNER: core-reduce agent. Replace every `todo!()`; keep the signatures.
//! Pure functions; every step is reported in a [`CorrectionBreakdown`] so the UI can show
//! the table and so a record can never be corrected twice.

use crate::types::{AltitudeKind, CorrectionBreakdown, GeocentricDirection, HorizonMode, Limb};

/// Everything the chain needs besides the reading itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CorrectionInputs<'a> {
    pub id: &'a str,
    pub is_sun: bool,
    pub limb: Limb,
    pub horizon: HorizonMode,
    pub index_correction_arcmin: f64,
    pub height_of_eye_m: f64,
    pub pressure_hpa: f64,
    pub temperature_c: f64,
    /// Semidiameter and horizontal parallax come from here (Sun only).
    pub direction: Option<GeocentricDirection>,
}

/// Dip of the sea horizon in arcminutes for a height of eye in metres (`1.76 sqrt(h)`).
pub fn dip_arcmin(height_of_eye_m: f64) -> f64 {
    todo!("core-reduce: dip")
}

/// Bennett (1982) refraction in arcminutes for an apparent altitude in degrees,
/// scaled for pressure (hPa) and temperature (C). Caller enforces the validity range.
pub fn refraction_arcmin(apparent_altitude_deg: f64, pressure_hpa: f64, temperature_c: f64) -> f64 {
    todo!("core-reduce: refraction")
}

/// Run the chain from `altitude_deg` of the declared `kind` to `Ho`. Steps already
/// implied by `kind` are reported with `applied = false`.
pub fn correct(
    altitude_deg: f64,
    kind: AltitudeKind,
    sigma_arcmin: f64,
    inputs: CorrectionInputs<'_>,
) -> Result<CorrectionBreakdown, crate::SkyfixError> {
    todo!("core-reduce: correction chain")
}
