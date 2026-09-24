//! CONVENTIONS section 5: the correction chain.
//!
//! OWNER: core-reduce agent.
//! Pure functions; every step is reported in a [`CorrectionBreakdown`] so the UI can show
//! the table and so a record can never be corrected twice.
//!
//! The breakdown always lists all six [`CorrectionKind`]s in the order of section 5.
//! A step that did not run carries `applied = false`, `before_deg == after_deg` and a
//! note saying *why* — either "already in the reading" (the declared [`AltitudeKind`] is
//! already past it) or "not applicable" (wrong horizon mode, or not the Sun). Nothing is
//! ever silently dropped.

use crate::SkyfixError;
use crate::types::{
    AltitudeKind, CorrectionBreakdown, CorrectionKind, CorrectionStep, GeocentricDirection,
    HorizonMode, Limb, Warning,
};

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

/// Apparent altitude below this (degrees) inflates sigma by [`LOW_ALTITUDE_SIGMA_ARCMIN`].
pub const LOW_ALTITUDE_SIGMA_THRESHOLD_DEG: f64 = 5.0;
/// Apparent altitude below this (degrees) is flagged [`Warning::LowAltitudeRefraction`].
pub const LOW_ALTITUDE_FLAG_THRESHOLD_DEG: f64 = 10.0;
/// Added in quadrature below [`LOW_ALTITUDE_SIGMA_THRESHOLD_DEG`] (CONVENTIONS section 5).
pub const LOW_ALTITUDE_SIGMA_ARCMIN: f64 = 1.0;

/// Dip of the sea horizon in arcminutes for a height of eye in metres (`1.76 sqrt(h)`).
///
/// Nautical Almanac / Bowditch; `1.76' sqrt(metres)` equals `0.97' sqrt(feet)`. A
/// negative or non-finite height is a validation error upstream
/// ([`crate::session::validate`]); here it defensively yields zero dip rather than a
/// `NaN` that would silently poison the chain.
pub fn dip_arcmin(height_of_eye_m: f64) -> f64 {
    if height_of_eye_m > 0.0 {
        1.76 * height_of_eye_m.sqrt()
    } else {
        // Covers 0, negatives and NaN (all comparisons with NaN are false).
        0.0
    }
}

/// Bennett (1982) refraction in arcminutes for an apparent altitude in degrees,
/// scaled for pressure (hPa) and temperature (C). Caller enforces the validity range.
///
/// `R' = cot(Ha + 7.31 / (Ha + 4.4))` arcmin at 1010 hPa and 10 C, scaled by
/// `(P / 1010) * (283 / (273 + T))`. Bennett's own residual against the standard
/// tables is <= 0.07', which is inside the sigma floor and is not modelled.
///
/// Above about 89.92 deg the expression goes very slightly negative (-0.0014' at the
/// zenith, i.e. -0.08 arcsec). Refraction cannot lift a body away from the zenith, so
/// the result is clamped at zero; the clamp can never exceed 0.0014', two orders of
/// magnitude below the formula's own residual. Non-finite inputs return `NaN` rather
/// than being clamped to a plausible-looking zero.
pub fn refraction_arcmin(apparent_altitude_deg: f64, pressure_hpa: f64, temperature_c: f64) -> f64 {
    if !apparent_altitude_deg.is_finite() || !pressure_hpa.is_finite() || !temperature_c.is_finite()
    {
        return f64::NAN;
    }
    let arg_deg = apparent_altitude_deg + 7.31 / (apparent_altitude_deg + 4.4);
    let r0 = 1.0 / arg_deg.to_radians().tan();
    let scaled = r0 * (pressure_hpa / 1010.0) * (283.0 / (273.0 + temperature_c));
    if scaled > 0.0 { scaled } else { 0.0 }
}

/// Parallax in altitude, arcminutes: `PA = HP cos(Ha)` (CONVENTIONS section 5 step 5).
/// `Ha` in degrees. Stars have `HP = 0` and therefore `PA = 0`.
pub fn parallax_in_altitude_arcmin(horizontal_parallax_arcmin: f64, apparent_altitude_deg: f64) -> f64 {
    horizontal_parallax_arcmin * apparent_altitude_deg.to_radians().cos()
}

/// The corrections whose parameters the caller supplied but which `kind` has already
/// consumed, so they will not run. Used both by the chain (to emit
/// [`Warning::AlreadyCorrected`]) and by [`crate::session::validate`], so the two can
/// never disagree about what "would have to be ignored" means.
///
/// Triggers: a nonzero index correction, a positive height of eye under a sea horizon,
/// an artificial horizon (the halving), a non-centre limb on the Sun, and a nonzero
/// solar horizontal parallax.
pub fn ignored_correction_kinds(kind: AltitudeKind, inputs: &CorrectionInputs<'_>) -> Vec<CorrectionKind> {
    let mut ignored = Vec::new();
    if matches!(kind, AltitudeKind::SextantHs) {
        return ignored;
    }
    // ApparentHa and ObservedHo are both past steps 1 and 2.
    if inputs.index_correction_arcmin != 0.0 {
        ignored.push(CorrectionKind::IndexCorrection);
    }
    if inputs.horizon == HorizonMode::Sea && inputs.height_of_eye_m > 0.0 {
        ignored.push(CorrectionKind::Dip);
    }
    if inputs.horizon == HorizonMode::ArtificialReflected {
        ignored.push(CorrectionKind::ArtificialHorizonHalving);
    }
    if matches!(kind, AltitudeKind::ObservedHo) {
        if inputs.is_sun && inputs.limb != Limb::Center {
            ignored.push(CorrectionKind::Semidiameter);
        }
        let hp = inputs.direction.map_or(0.0, |d| d.horizontal_parallax_arcmin);
        if inputs.is_sun && hp != 0.0 {
            ignored.push(CorrectionKind::Parallax);
        }
    }
    ignored
}

/// Run the chain from `altitude_deg` of the declared `kind` to `Ho`. Steps already
/// implied by `kind` are reported with `applied = false`.
///
/// Errors: non-finite inputs, a non-positive sigma, an apparent altitude below the
/// horizon (section 5 makes that `RefractionOutOfRange`) and a corrected altitude above
/// the zenith.
pub fn correct(
    altitude_deg: f64,
    kind: AltitudeKind,
    sigma_arcmin: f64,
    inputs: CorrectionInputs<'_>,
) -> Result<CorrectionBreakdown, SkyfixError> {
    let id = inputs.id;
    check_inputs(altitude_deg, sigma_arcmin, &inputs)?;

    let mut warnings: Vec<Warning> = Vec::new();
    let mut steps: Vec<CorrectionStep> = Vec::with_capacity(6);
    let mut h = altitude_deg;
    let mut sigma = sigma_arcmin;

    // `sextant_hs` still needs steps 1-2; `sextant_hs` and `apparent_ha` still need 3-5.
    let needs_horizon_steps = matches!(kind, AltitudeKind::SextantHs);
    let needs_ho_steps = matches!(kind, AltitudeKind::SextantHs | AltitudeKind::ApparentHa);
    let already = format!("already in the reading (altitude_kind = {})", kind_name(kind));

    if inputs.height_of_eye_m < 0.0 {
        warnings.push(Warning::Other {
            message: format!(
                "observation {id}: height of eye {:.3} m is negative; treated as 0 m (no dip)",
                inputs.height_of_eye_m
            ),
        });
    }

    // --- 1. index correction, added -----------------------------------------
    if needs_horizon_steps {
        let after = h + inputs.index_correction_arcmin / 60.0;
        steps.push(make_step(
            CorrectionKind::IndexCorrection,
            h,
            after,
            true,
            format!(
                "index correction {:+.3}' added to the sextant reading",
                inputs.index_correction_arcmin
            ),
        ));
        h = after;
    } else {
        steps.push(make_step(
            CorrectionKind::IndexCorrection,
            h,
            h,
            false,
            already.clone(),
        ));
    }

    // --- 2a. dip (sea horizon only), subtracted -----------------------------
    if !needs_horizon_steps {
        steps.push(make_step(CorrectionKind::Dip, h, h, false, already.clone()));
    } else if inputs.horizon == HorizonMode::Sea {
        let dip = dip_arcmin(inputs.height_of_eye_m);
        let after = h - dip / 60.0;
        steps.push(make_step(
            CorrectionKind::Dip,
            h,
            after,
            true,
            format!(
                "sea horizon, height of eye {:.3} m: dip {dip:.3}' subtracted",
                inputs.height_of_eye_m.max(0.0)
            ),
        ));
        h = after;
    } else {
        steps.push(make_step(
            CorrectionKind::Dip,
            h,
            h,
            false,
            format!(
                "not applicable: the {} horizon has no dip",
                horizon_name(inputs.horizon)
            ),
        ));
        if inputs.height_of_eye_m > 0.0 {
            // A height was supplied and is being discarded: say so, do not just drop it.
            warnings.push(Warning::DipNotApplicable {
                id: id.to_string(),
                horizon: inputs.horizon,
            });
        }
    }

    // --- 2b. artificial-horizon halving, after IC ---------------------------
    if !needs_horizon_steps {
        steps.push(make_step(
            CorrectionKind::ArtificialHorizonHalving,
            h,
            h,
            false,
            already.clone(),
        ));
    } else if inputs.horizon == HorizonMode::ArtificialReflected {
        let after = h / 2.0;
        steps.push(make_step(
            CorrectionKind::ArtificialHorizonHalving,
            h,
            after,
            true,
            format!(
                "reflected artificial horizon: the reading is the double angle, halved after IC; \
                 sigma halved with it ({sigma:.3}' -> {:.3}')",
                sigma / 2.0
            ),
        ));
        h = after;
        // The recorded sigma describes the double angle (section 5, sigma propagation).
        sigma /= 2.0;
    } else {
        steps.push(make_step(
            CorrectionKind::ArtificialHorizonHalving,
            h,
            h,
            false,
            format!(
                "not applicable: the {} horizon reading is a single angle",
                horizon_name(inputs.horizon)
            ),
        ));
    }

    // Apparent altitude (or, for an `observed_ho` record, the observed altitude itself).
    let ha_deg = h;
    if ha_deg < 0.0 {
        return Err(SkyfixError::Rejected {
            id: id.to_string(),
            reason: if needs_ho_steps {
                format!(
                    "apparent altitude {ha_deg:.4} deg is below the horizon; the refraction model \
                     is valid only for Ha >= 0 deg (RefractionOutOfRange)"
                )
            } else {
                format!("observed altitude {ha_deg:.4} deg is below the horizon")
            },
        });
    }

    // --- low-altitude refraction flag (section 5, step 3) -------------------
    // The sigma inflation belongs to the refraction step: an `observed_ho` record's
    // sigma was declared by whoever applied refraction, so it is flagged but not
    // inflated a second time.
    let sigma_added = if needs_ho_steps && ha_deg < LOW_ALTITUDE_SIGMA_THRESHOLD_DEG {
        LOW_ALTITUDE_SIGMA_ARCMIN
    } else {
        0.0
    };
    if ha_deg < LOW_ALTITUDE_FLAG_THRESHOLD_DEG {
        warnings.push(Warning::LowAltitudeRefraction {
            id: id.to_string(),
            apparent_altitude_deg: ha_deg,
            sigma_added_arcmin: sigma_added,
        });
    }

    // --- 3. refraction, subtracted ------------------------------------------
    if needs_ho_steps {
        let r = refraction_arcmin(ha_deg, inputs.pressure_hpa, inputs.temperature_c);
        let after = h - r / 60.0;
        steps.push(make_step(
            CorrectionKind::Refraction,
            h,
            after,
            true,
            format!(
                "Bennett 1982 at Ha {ha_deg:.4} deg, {:.1} hPa, {:.1} C: {r:.3}' subtracted",
                inputs.pressure_hpa, inputs.temperature_c
            ),
        ));
        h = after;
    } else {
        steps.push(make_step(
            CorrectionKind::Refraction,
            h,
            h,
            false,
            already.clone(),
        ));
    }

    // --- 4. semidiameter (Sun only) -----------------------------------------
    let sd = inputs.direction.map_or(0.0, |d| d.semidiameter_arcmin);
    if !needs_ho_steps {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            already.clone(),
        ));
    } else if !inputs.is_sun {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            "not applicable: semidiameter is applied for the Sun only".to_string(),
        ));
        if inputs.limb != Limb::Center {
            warnings.push(Warning::LimbIgnoredForStar {
                id: id.to_string(),
            });
        }
    } else if inputs.limb == Limb::Center {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            "not applicable: centre limb observed, no semidiameter".to_string(),
        ));
    } else {
        let sign = if inputs.limb == Limb::Lower { 1.0 } else { -1.0 };
        let after = h + sign * sd / 60.0;
        let note = if sd == 0.0 {
            // SD 0 means "unknown", not "zero": say so instead of implying a centre altitude.
            warnings.push(Warning::Other {
                message: format!(
                    "observation {id}: Sun {} limb requested but the semidiameter supplied is \
                     0.0' (unknown); no semidiameter applied, so Ho is a limb altitude, not a \
                     centre altitude",
                    limb_name(inputs.limb)
                ),
            });
            format!(
                "Sun {} limb, but semidiameter is unknown (0.000'): nothing added",
                limb_name(inputs.limb)
            )
        } else {
            format!(
                "Sun {} limb: semidiameter {sd:.3}' {}",
                limb_name(inputs.limb),
                if sign > 0.0 { "added" } else { "subtracted" }
            )
        };
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            after,
            true,
            note,
        ));
        h = after;
    }

    // --- 5. parallax in altitude (Sun only), added --------------------------
    let hp = inputs.direction.map_or(0.0, |d| d.horizontal_parallax_arcmin);
    if !needs_ho_steps {
        steps.push(make_step(CorrectionKind::Parallax, h, h, false, already));
    } else if !inputs.is_sun {
        steps.push(make_step(
            CorrectionKind::Parallax,
            h,
            h,
            false,
            "not applicable: parallax in altitude is modelled for the Sun only (stars: 0.000')"
                .to_string(),
        ));
    } else {
        let pa = parallax_in_altitude_arcmin(hp, ha_deg);
        let after = h + pa / 60.0;
        steps.push(make_step(
            CorrectionKind::Parallax,
            h,
            after,
            true,
            format!("Sun: HP {hp:.3}' x cos(Ha) = {pa:.3}' added"),
        ));
        h = after;
        if hp == 0.0 {
            warnings.push(Warning::Other {
                message: format!(
                    "observation {id}: Sun horizontal parallax supplied as 0.0' (unknown); \
                     parallax omitted, which is about 0.15' at low altitude"
                ),
            });
        }
    }

    // --- already-corrected report -------------------------------------------
    let ignored = ignored_correction_kinds(kind, &inputs);
    if !ignored.is_empty() {
        warnings.push(Warning::AlreadyCorrected {
            id: id.to_string(),
            kind,
            ignored,
        });
    }

    let ho_deg = h;
    if ho_deg > 90.0 {
        return Err(SkyfixError::Rejected {
            id: id.to_string(),
            reason: format!(
                "corrected altitude {ho_deg:.4} deg is above the zenith; check the horizon mode \
                 (a reflected artificial-horizon reading is the double angle)"
            ),
        });
    }

    Ok(CorrectionBreakdown {
        input_kind: kind,
        input_deg: altitude_deg,
        steps,
        ho_deg,
        sigma_ho_arcmin: (sigma * sigma + sigma_added * sigma_added).sqrt(),
        warnings,
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn check_inputs(
    altitude_deg: f64,
    sigma_arcmin: f64,
    inputs: &CorrectionInputs<'_>,
) -> Result<(), SkyfixError> {
    let id = inputs.id;
    if !altitude_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: format!("observation {id}: altitude_deg"),
        });
    }
    if !sigma_arcmin.is_finite() || sigma_arcmin <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: format!("observation {id}: sigma_arcmin"),
            message: format!(
                "must be a finite value greater than 0 (got {sigma_arcmin}); a zero sigma would \
                 give the sight infinite weight"
            ),
        });
    }
    if !inputs.index_correction_arcmin.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: format!("observation {id}: index_correction_arcmin"),
        });
    }
    if !inputs.height_of_eye_m.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: format!("observation {id}: height_of_eye_m"),
        });
    }
    if !inputs.pressure_hpa.is_finite() || inputs.pressure_hpa <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: format!("observation {id}: pressure_hpa"),
            message: format!("must be a finite positive pressure (got {})", inputs.pressure_hpa),
        });
    }
    if !inputs.temperature_c.is_finite() || 273.0 + inputs.temperature_c <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: format!("observation {id}: temperature_c"),
            message: format!(
                "must be finite and above -273 C (got {})",
                inputs.temperature_c
            ),
        });
    }
    if let Some(d) = inputs.direction
        && (!d.semidiameter_arcmin.is_finite() || !d.horizontal_parallax_arcmin.is_finite())
    {
        return Err(SkyfixError::NonFinite {
            field: format!("observation {id}: semidiameter_arcmin/horizontal_parallax_arcmin"),
        });
    }
    Ok(())
}

fn make_step(
    kind: CorrectionKind,
    before_deg: f64,
    after_deg: f64,
    applied: bool,
    note: String,
) -> CorrectionStep {
    CorrectionStep {
        kind,
        applied,
        before_deg,
        after_deg,
        delta_arcmin: (after_deg - before_deg) * 60.0,
        note,
    }
}

/// Serialised spelling of an [`AltitudeKind`], for notes and CSV.
pub fn kind_name(kind: AltitudeKind) -> &'static str {
    match kind {
        AltitudeKind::SextantHs => "sextant_hs",
        AltitudeKind::ApparentHa => "apparent_ha",
        AltitudeKind::ObservedHo => "observed_ho",
    }
}

/// Serialised spelling of a [`HorizonMode`], for notes and CSV.
pub fn horizon_name(horizon: HorizonMode) -> &'static str {
    match horizon {
        HorizonMode::Sea => "sea",
        HorizonMode::ArtificialReflected => "artificial_reflected",
        HorizonMode::ElectronicVertical => "electronic_vertical",
    }
}

/// Serialised spelling of a [`Limb`], for notes and CSV.
pub fn limb_name(limb: Limb) -> &'static str {
    match limb {
        Limb::Center => "center",
        Limb::Lower => "lower",
        Limb::Upper => "upper",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn star_inputs<'a>(id: &'a str) -> CorrectionInputs<'a> {
        CorrectionInputs {
            id,
            is_sun: false,
            limb: Limb::Center,
            horizon: HorizonMode::Sea,
            index_correction_arcmin: 0.0,
            height_of_eye_m: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
            direction: None,
        }
    }

    #[test]
    fn every_kind_is_reported_exactly_once() {
        let b = correct(45.0, AltitudeKind::SextantHs, 1.0, star_inputs("a")).unwrap();
        let kinds: Vec<CorrectionKind> = b.steps.iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![
                CorrectionKind::IndexCorrection,
                CorrectionKind::Dip,
                CorrectionKind::ArtificialHorizonHalving,
                CorrectionKind::Refraction,
                CorrectionKind::Semidiameter,
                CorrectionKind::Parallax,
            ]
        );
        // Chain continuity: every step starts where the previous one ended.
        for w in b.steps.windows(2) {
            assert_eq!(w[0].after_deg, w[1].before_deg);
        }
        assert_eq!(b.steps[0].before_deg, 45.0);
        assert_eq!(b.steps[5].after_deg, b.ho_deg);
    }

    #[test]
    fn skipped_steps_have_a_note_and_do_not_move_the_altitude() {
        let b = correct(45.0, AltitudeKind::ObservedHo, 1.0, star_inputs("a")).unwrap();
        assert_eq!(b.ho_deg, 45.0);
        for s in &b.steps {
            assert!(!s.applied, "{:?} should be skipped", s.kind);
            assert_eq!(s.before_deg, s.after_deg);
            assert_eq!(s.delta_arcmin, 0.0);
            assert!(!s.note.is_empty());
        }
    }

    #[test]
    fn dip_is_defensive_about_bad_heights() {
        assert_eq!(dip_arcmin(0.0), 0.0);
        assert_eq!(dip_arcmin(-4.0), 0.0);
        assert_eq!(dip_arcmin(f64::NAN), 0.0);
    }

    #[test]
    fn refraction_is_nan_for_nan_inputs_not_zero() {
        assert!(refraction_arcmin(f64::NAN, 1010.0, 10.0).is_nan());
        assert!(refraction_arcmin(10.0, f64::NAN, 10.0).is_nan());
        assert!(refraction_arcmin(10.0, 1010.0, f64::NAN).is_nan());
    }
}
