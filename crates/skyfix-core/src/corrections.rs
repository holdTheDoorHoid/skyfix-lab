//! CONVENTIONS section 5: the correction chain.
//!
//! OWNER: core-reduce agent; Moon and planet sights added by the navigation-Moon agent.
//! Pure functions; every step is reported in a [`CorrectionBreakdown`] so the UI can show
//! the table and so a record can never be corrected twice.
//!
//! The breakdown always lists all six [`CorrectionKind`]s in the order of section 5.
//! A step that did not run carries `applied = false`, `before_deg == after_deg` and a
//! note saying *why* — either "already in the reading" (the declared [`AltitudeKind`] is
//! already past it) or "not applicable" (wrong horizon mode, or a body without a disc or
//! a parallax). Nothing is ever silently dropped.
//!
//! # Which body follows which rules
//!
//! [`SightBody`] decides steps 4 and 5 (CONVENTIONS section 5):
//!
//! | body | semidiameter (step 4) | parallax in altitude (step 5) |
//! |---|---|---|
//! | Sun | geocentric SD by limb | `HP cos(Ha)` |
//! | Moon | **topocentric** (augmented) SD by limb | `asin(sin HP cos h)`, `h` the topocentric altitude of the centre |
//! | planet | none: the centre of light is observed | `asin(sin HP cos h)` |
//! | star | none | none |
//!
//! [`correct`] keeps its original contract (Sun when `is_sun`, otherwise a star), so every
//! existing caller gets bit-identical results; [`correct_sight`] takes the body class.

use serde::{Deserialize, Serialize};

use crate::SkyfixError;
use crate::types::{
    AltitudeKind, CorrectionBreakdown, CorrectionKind, CorrectionStep, GeocentricDirection,
    HorizonMode, Limb, Warning,
};

/// Everything the chain needs besides the reading itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CorrectionInputs<'a> {
    pub id: &'a str,
    /// Read only by [`correct`]; [`correct_sight`] takes the body class explicitly.
    pub is_sun: bool,
    pub limb: Limb,
    pub horizon: HorizonMode,
    pub index_correction_arcmin: f64,
    pub height_of_eye_m: f64,
    pub pressure_hpa: f64,
    pub temperature_c: f64,
    /// Semidiameter and horizontal parallax come from here (Sun, Moon and planets).
    pub direction: Option<GeocentricDirection>,
}

/// Which rules of CONVENTIONS section 5 steps 4 and 5 a body follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SightBody {
    /// Geocentric semidiameter by limb; parallax `HP cos(Ha)`.
    Sun,
    /// Topocentric (augmented) semidiameter by limb; rigorous parallax. HP is required.
    Moon,
    /// Observed at its centre of light, no semidiameter; rigorous parallax from its HP.
    Planet,
    /// Refraction only.
    Star,
}

/// The planets by canonical name (CONVENTIONS 13.1). The core carries no ephemeris, so
/// the list is spelled out here; `skyfix_ephemeris::body::PLANETS` is the same list.
pub const PLANET_NAMES: [&str; 7] = [
    "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune",
];

/// The class of a body name, trimmed and case-insensitive. Anything that is not the Sun,
/// the Moon or a planet is a star (catalogue names, `HIP <number>`, or a name that only
/// works with a supplied direction).
pub fn sight_body(body: &str) -> SightBody {
    let b = body.trim();
    if b.eq_ignore_ascii_case("sun") {
        SightBody::Sun
    } else if b.eq_ignore_ascii_case("moon") {
        SightBody::Moon
    } else if PLANET_NAMES.iter().any(|p| p.eq_ignore_ascii_case(b)) {
        SightBody::Planet
    } else {
        SightBody::Star
    }
}

/// The class [`correct`] has always assumed: the Sun when `is_sun`, otherwise a star.
fn legacy_class(inputs: &CorrectionInputs<'_>) -> SightBody {
    if inputs.is_sun {
        SightBody::Sun
    } else {
        SightBody::Star
    }
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

// --- dip short of the horizon (sailings agent, expansion programme) ------------------

/// Feet in Bowditch's nautical mile (vol. 2 §402): `6076.1`.
pub const BOWDITCH_FEET_PER_NM: f64 = 6076.1;
/// Bowditch's curvature-and-refraction constant (vol. 2 §402), NM: `8268 = 2 R'`, with
/// `R'` = 4134 NM the Earth's radius as terrestrial refraction makes it look.
pub const BOWDITCH_DIP_SHORT_NM: f64 = 8268.0;
/// Metres per international foot.
pub const M_PER_FT: f64 = 0.3048;

/// Dip of the sea short of the horizon, arcminutes: the depression below the horizontal
/// of the waterline `distance_nm` away seen from `height_of_eye_m` (Bowditch 2019 vol. 2
/// §402 and Table 14):
///
/// ```text
/// Ds = 60 tan⁻¹( h_ft / (6076.1 d) + d / 8268 )          (degrees -> minutes)
/// ```
///
/// The first term is the height seen from the distance; the second the Earth's
/// curvature, `d / 2R'`, with the effective radius `R'` = 4134 NM that terrestrial
/// refraction produces (the same refraction that makes the sea dip `0.97′ √h_ft`: the
/// formula is least at `d = √(8268 h_ft / 6076.1)`, the sea horizon, where it equals
/// that dip). For small angles it is `0.4158′ d + 1.8562′ h_m / d`, the two constants
/// being 3437.75/8268 and 3437.75/(0.3048 × 6076.1); the arctangent matters only for a
/// waterline a few cables off a high eye (0.63′ at 100 ft and 0.2 NM). The distance
/// must be positive and finite; [`check_horizon`] refuses anything else upstream.
pub fn dip_short_arcmin(height_of_eye_m: f64, distance_nm: f64) -> f64 {
    let h_ft = height_of_eye_m.max(0.0) / M_PER_FT;
    let t = h_ft / (BOWDITCH_FEET_PER_NM * distance_nm) + distance_nm / BOWDITCH_DIP_SHORT_NM;
    t.atan().to_degrees() * 60.0
}

/// Distance of the sea horizon, nautical miles, as the dip-short formula places it: the
/// distance at which [`dip_short_arcmin`] is least, `√(8268 h_ft / 6076.1)` (2.113 √h_m;
/// Bowditch's `1.17 √h_ft`). A shoreline farther than this is below the sea horizon.
pub fn sea_horizon_distance_nm(height_of_eye_m: f64) -> f64 {
    (BOWDITCH_DIP_SHORT_NM * height_of_eye_m.max(0.0) / M_PER_FT / BOWDITCH_FEET_PER_NM).sqrt()
}

/// What step 2 subtracts for a horizon with a dip.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HorizonDip {
    pub dip_arcmin: f64,
    /// `true` when the dip short of the horizon was used (a shoreline nearer than the
    /// sea horizon), `false` for the sea dip.
    pub short: bool,
    /// For a shore horizon: the distance of the sea horizon, NM.
    pub sea_horizon_nm: Option<f64>,
    /// For a shore horizon: the shoreline is at or beyond the sea horizon, so the sea dip
    /// was used ([`Warning::ShoreBeyondSeaHorizon`]).
    pub beyond_horizon: bool,
}

/// The dip of a horizon mode (CONVENTIONS section 5, step 2), or `None` for a horizon
/// without one (artificial, electronic).
///
/// - `sea`: [`dip_arcmin`], `1.76′ √h`.
/// - `shore { distance_nm }`: [`dip_short_arcmin`] while the shoreline is nearer than
///   [`sea_horizon_distance_nm`], never less than the sea dip (Bowditch's constants make
///   the formula's minimum `1.7569′ √h`, 0.18 % under the chain's rounded `1.76′ √h`, so
///   within a few per cent of the horizon distance the sea dip is the larger and is
///   used); at or beyond the sea horizon, the sea dip.
pub fn horizon_dip(horizon: HorizonMode, height_of_eye_m: f64) -> Option<HorizonDip> {
    match horizon {
        HorizonMode::Sea => Some(HorizonDip {
            dip_arcmin: dip_arcmin(height_of_eye_m),
            short: false,
            sea_horizon_nm: None,
            beyond_horizon: false,
        }),
        HorizonMode::Shore { distance_nm } => {
            let sea = dip_arcmin(height_of_eye_m);
            let horizon_nm = sea_horizon_distance_nm(height_of_eye_m);
            if distance_nm >= horizon_nm {
                Some(HorizonDip {
                    dip_arcmin: sea,
                    short: false,
                    sea_horizon_nm: Some(horizon_nm),
                    beyond_horizon: true,
                })
            } else {
                let short = dip_short_arcmin(height_of_eye_m, distance_nm);
                Some(HorizonDip {
                    dip_arcmin: short.max(sea),
                    short: short > sea,
                    sea_horizon_nm: Some(horizon_nm),
                    beyond_horizon: false,
                })
            }
        }
        HorizonMode::ArtificialReflected | HorizonMode::ElectronicVertical => None,
    }
}

/// The dip a horizon mode subtracts, arcminutes (0 for a horizon without one).
pub fn horizon_dip_arcmin(horizon: HorizonMode, height_of_eye_m: f64) -> f64 {
    horizon_dip(horizon, height_of_eye_m).map_or(0.0, |d| d.dip_arcmin)
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
///
/// This is the Sun's form. It differs from the rigorous
/// [`rigorous_parallax_in_altitude_arcmin`] by under 0.001' for the Sun's 0.15' HP, and
/// is kept so that every Sun result stays what it has always been.
pub fn parallax_in_altitude_arcmin(
    horizontal_parallax_arcmin: f64,
    apparent_altitude_deg: f64,
) -> f64 {
    horizontal_parallax_arcmin * apparent_altitude_deg.to_radians().cos()
}

/// Parallax in altitude on the spherical Earth of CONVENTIONS section 1, arcminutes:
/// `p = asin(sin HP cos h)`, with `h` the **topocentric airless** altitude of the body's
/// centre in degrees (after refraction and, for a limb, the semidiameter).
///
/// Exact for an observer at the radius `HP` refers to: in the triangle Earth's centre,
/// observer, body, the sine rule gives `sin p = (a / d) sin z'` with `z' = 90 - h`. The
/// Moon's HP reaches 61.5', where the first-order `HP cos h` is 0.001' short and using
/// the apparent altitude instead of `h` would be up to 0.2' wrong.
pub fn rigorous_parallax_in_altitude_arcmin(
    horizontal_parallax_arcmin: f64,
    topocentric_altitude_deg: f64,
) -> f64 {
    let sin_hp = (horizontal_parallax_arcmin / 60.0).to_radians().sin();
    let x = (sin_hp * topocentric_altitude_deg.to_radians().cos()).clamp(-1.0, 1.0);
    x.asin().to_degrees() * 60.0
}

/// Topocentric ("augmented") semidiameter, arcminutes, of a body whose geocentric
/// semidiameter is `semidiameter_arcmin` and horizontal parallax
/// `horizontal_parallax_arcmin`, when its centre stands at topocentric airless altitude
/// `topocentric_altitude_deg` (CONVENTIONS section 5 step 4, the Moon).
///
/// The observer at radius `a` is nearer the body than the Earth's centre: with
/// `sin HP = a / d`, the law of cosines in the triangle Earth's centre, observer, body
/// gives `d' / d = sqrt(1 - sin^2 HP cos^2 h) - sin HP sin h`, and
/// `sin SD' = sin SD / (d' / d)`. At the zenith the Moon's disc grows by `SD sin HP`,
/// about 0.28'; on the horizon by 0.002'.
pub fn topocentric_semidiameter_arcmin(
    semidiameter_arcmin: f64,
    horizontal_parallax_arcmin: f64,
    topocentric_altitude_deg: f64,
) -> f64 {
    let sin_hp = (horizontal_parallax_arcmin / 60.0).to_radians().sin();
    let (sin_h, cos_h) = topocentric_altitude_deg.to_radians().sin_cos();
    let ratio = (1.0 - sin_hp * sin_hp * cos_h * cos_h).max(0.0).sqrt() - sin_hp * sin_h;
    let sin_sd = (semidiameter_arcmin / 60.0).to_radians().sin();
    if ratio <= 0.0 || !ratio.is_finite() {
        return f64::NAN;
    }
    (sin_sd / ratio).clamp(-1.0, 1.0).asin().to_degrees() * 60.0
}

/// The topocentric semidiameter of a limb observation and the altitude of the centre it
/// implies, found together: `h_c = h_limb + s SD'(h_c)` with `s = +1` for the lower limb
/// and `-1` for the upper. `SD'` changes by about 0.005' per degree of altitude, so the
/// fixed point converges in two passes; four are run.
///
/// Returns `(sd_topocentric_arcmin, centre_altitude_deg)`.
pub fn limb_to_centre(
    limb_altitude_deg: f64,
    limb_sign: f64,
    semidiameter_arcmin: f64,
    horizontal_parallax_arcmin: f64,
) -> (f64, f64) {
    let mut sd = topocentric_semidiameter_arcmin(
        semidiameter_arcmin,
        horizontal_parallax_arcmin,
        limb_altitude_deg,
    );
    let mut centre = limb_altitude_deg + limb_sign * sd / 60.0;
    for _ in 0..4 {
        sd = topocentric_semidiameter_arcmin(
            semidiameter_arcmin,
            horizontal_parallax_arcmin,
            centre,
        );
        centre = limb_altitude_deg + limb_sign * sd / 60.0;
    }
    (sd, centre)
}

/// The corrections whose parameters the caller supplied but which `kind` has already
/// consumed, so they will not run. Used both by the chain (to emit
/// [`Warning::AlreadyCorrected`]) and by [`crate::session::validate`], so the two can
/// never disagree about what "would have to be ignored" means.
///
/// Triggers: a nonzero index correction, a positive height of eye under a sea horizon,
/// an artificial horizon (the halving), a non-centre limb on the Sun, and a nonzero
/// solar horizontal parallax. This is [`ignored_correction_kinds_for`] with the class
/// [`correct`] assumes (the Sun when `is_sun`, otherwise a star).
pub fn ignored_correction_kinds(
    kind: AltitudeKind,
    inputs: &CorrectionInputs<'_>,
) -> Vec<CorrectionKind> {
    ignored_correction_kinds_for(kind, inputs, legacy_class(inputs))
}

/// [`ignored_correction_kinds`] for an explicit body class: a non-centre limb on the Sun
/// or the Moon, and a nonzero horizontal parallax on the Sun, the Moon or a planet, are
/// ignored by an `observed_ho` record.
pub fn ignored_correction_kinds_for(
    kind: AltitudeKind,
    inputs: &CorrectionInputs<'_>,
    body: SightBody,
) -> Vec<CorrectionKind> {
    let mut ignored = Vec::new();
    if matches!(kind, AltitudeKind::SextantHs) {
        return ignored;
    }
    // ApparentHa and ObservedHo are both past steps 1 and 2.
    if inputs.index_correction_arcmin != 0.0 {
        ignored.push(CorrectionKind::IndexCorrection);
    }
    // A shoreline has a dip even at a height of 0 (the curvature term), so a `shore`
    // horizon always has one to ignore.
    if (inputs.horizon == HorizonMode::Sea && inputs.height_of_eye_m > 0.0)
        || matches!(inputs.horizon, HorizonMode::Shore { .. })
    {
        ignored.push(CorrectionKind::Dip);
    }
    if inputs.horizon == HorizonMode::ArtificialReflected {
        ignored.push(CorrectionKind::ArtificialHorizonHalving);
    }
    if matches!(kind, AltitudeKind::ObservedHo) {
        let has_disc = matches!(body, SightBody::Sun | SightBody::Moon);
        if has_disc && inputs.limb != Limb::Center {
            ignored.push(CorrectionKind::Semidiameter);
        }
        let hp = inputs
            .direction
            .map_or(0.0, |d| d.horizontal_parallax_arcmin);
        if body != SightBody::Star && hp != 0.0 {
            ignored.push(CorrectionKind::Parallax);
        }
    }
    ignored
}

/// Run the chain from `altitude_deg` of the declared `kind` to `Ho`. Steps already
/// implied by `kind` are reported with `applied = false`.
///
/// The body is the Sun when `inputs.is_sun`, otherwise a star: this is the chain's
/// original contract, unchanged. Moon and planet sights go through [`correct_sight`].
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
    let body = legacy_class(&inputs);
    correct_sight(altitude_deg, kind, sigma_arcmin, inputs, body)
}

/// [`correct`] for an explicit body class (CONVENTIONS section 5, steps 4 and 5 per
/// [`SightBody`]). `inputs.is_sun` is not read: `body` decides.
///
/// Additional errors for the Moon: a sextant or apparent altitude whose direction carries
/// no horizontal parallax (0.0' means unknown, and the Moon's parallax is up to 61').
pub fn correct_sight(
    altitude_deg: f64,
    kind: AltitudeKind,
    sigma_arcmin: f64,
    inputs: CorrectionInputs<'_>,
    body: SightBody,
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
    let already = format!(
        "already in the reading (altitude_kind = {})",
        kind_name(kind)
    );

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
    } else if let HorizonMode::Shore { distance_nm } = inputs.horizon {
        // Dip short of the horizon (Bowditch vol. 2 Table 14), or the sea dip when the
        // shoreline is beyond the sea horizon.
        let dip =
            horizon_dip(inputs.horizon, inputs.height_of_eye_m).expect("a shore horizon has a dip");
        let after = h - dip.dip_arcmin / 60.0;
        let horizon_nm = dip.sea_horizon_nm.unwrap_or(0.0);
        let eye = inputs.height_of_eye_m.max(0.0);
        let note = if dip.beyond_horizon {
            warnings.push(Warning::ShoreBeyondSeaHorizon {
                id: id.to_string(),
                distance_nm,
                sea_horizon_nm: horizon_nm,
            });
            format!(
                "shore horizon {distance_nm:.3} NM away is beyond the sea horizon ({horizon_nm:.2} NM \
                 for {eye:.3} m): the sea horizon is the one seen, sea dip {:.3}' subtracted",
                dip.dip_arcmin
            )
        } else if dip.short {
            format!(
                "shore horizon {distance_nm:.3} NM away, height of eye {eye:.3} m: dip short of the \
                 horizon {:.3}' subtracted (Bowditch Table 14; the sea horizon is {horizon_nm:.2} NM)",
                dip.dip_arcmin
            )
        } else {
            format!(
                "shore horizon {distance_nm:.3} NM away, next to the sea horizon ({horizon_nm:.2} NM): \
                 the sea dip {:.3}' is the larger and is subtracted",
                dip.dip_arcmin
            )
        };
        steps.push(make_step(CorrectionKind::Dip, h, after, true, note));
        h = after;
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

    // --- 4. semidiameter (Sun and Moon) ------------------------------------
    let sd = inputs.direction.map_or(0.0, |d| d.semidiameter_arcmin);
    let hp = inputs
        .direction
        .map_or(0.0, |d| d.horizontal_parallax_arcmin);
    if needs_ho_steps && body == SightBody::Moon && hp == 0.0 {
        // Unlike the Sun's 0.15', the Moon's parallax is up to 61': a sight reduced
        // without it would put the line of position up to 61 NM out. Refuse it.
        return Err(SkyfixError::Rejected {
            id: id.to_string(),
            reason: "the Moon's horizontal parallax is 0.0' (unknown); supply \
                     horizontal_parallax_arcmin from the almanac (54' to 61.5'), without it \
                     the altitude would be wrong by up to 61'"
                .to_string(),
        });
    }
    if !needs_ho_steps {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            already.clone(),
        ));
    } else if body == SightBody::Moon {
        h = moon_semidiameter_step(&mut steps, &mut warnings, id, inputs.limb, h, sd, hp);
    } else if body == SightBody::Planet {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            "not applicable: a planet is observed at its centre of light, with no \
             semidiameter (Venus's phase is carried in its direction, as in the Nautical \
             Almanac)"
                .to_string(),
        ));
        if inputs.limb != Limb::Center {
            warnings.push(Warning::LimbIgnoredForStar { id: id.to_string() });
        }
    } else if body == SightBody::Star {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            "not applicable: a star has no disc (semidiameter is geocentric for the Sun only; \
             the Moon's is augmented to its topocentric value)"
                .to_string(),
        ));
        if inputs.limb != Limb::Center {
            warnings.push(Warning::LimbIgnoredForStar { id: id.to_string() });
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
        let sign = if inputs.limb == Limb::Lower {
            1.0
        } else {
            -1.0
        };
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

    // --- 5. parallax in altitude (Sun, Moon, planets), added ----------------
    if !needs_ho_steps {
        steps.push(make_step(CorrectionKind::Parallax, h, h, false, already));
    } else if body == SightBody::Star {
        steps.push(make_step(
            CorrectionKind::Parallax,
            h,
            h,
            false,
            "not applicable: a star has no parallax in altitude (0.000'); HP cos(Ha) is used \
             for the Sun only, asin(sin HP cos h) for the Moon and the planets"
                .to_string(),
        ));
    } else if matches!(body, SightBody::Moon | SightBody::Planet) {
        // `h` is now the topocentric airless altitude of the centre (the Moon's limb was
        // moved to the centre in step 4; a planet is observed at its centre of light).
        let pa = rigorous_parallax_in_altitude_arcmin(hp, h);
        let after = h + pa / 60.0;
        let who = if body == SightBody::Moon {
            "Moon".to_string()
        } else {
            "planet".to_string()
        };
        steps.push(make_step(
            CorrectionKind::Parallax,
            h,
            after,
            true,
            format!(
                "{who}: asin(sin HP {hp:.3}' x cos h), h = {h:.4} deg topocentric: {pa:.3}' added"
            ),
        ));
        if body == SightBody::Planet && hp == 0.0 {
            warnings.push(Warning::Other {
                message: format!(
                    "observation {id}: planet horizontal parallax supplied as 0.0' (unknown); \
                     parallax omitted, which is up to 0.56' for Venus and 0.4' for Mars"
                ),
            });
        }
        h = after;
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
    let ignored = ignored_correction_kinds_for(kind, &inputs, body);
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
            message: format!(
                "must be a finite positive pressure (got {})",
                inputs.pressure_hpa
            ),
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
    check_horizon(
        inputs.horizon,
        &format!("observation {id}: horizon.shore.distance_nm"),
    )?;
    Ok(())
}

/// A `shore` horizon needs a finite distance greater than zero.
pub fn check_horizon(horizon: HorizonMode, field: &str) -> Result<(), SkyfixError> {
    if let HorizonMode::Shore { distance_nm } = horizon
        && !(distance_nm.is_finite() && distance_nm > 0.0)
    {
        return Err(SkyfixError::InvalidField {
            field: field.to_string(),
            message: format!(
                "the distance to the shoreline must be a positive number of nautical miles \
                 (got {distance_nm})"
            ),
        });
    }
    Ok(())
}

/// Step 4 for the Moon: the topocentric (augmented) semidiameter by limb. `h` is the
/// airless topocentric altitude of the observed limb; the return value is the altitude of
/// the centre (unchanged for a centre observation or an unknown semidiameter).
fn moon_semidiameter_step(
    steps: &mut Vec<CorrectionStep>,
    warnings: &mut Vec<Warning>,
    id: &str,
    limb: Limb,
    h: f64,
    sd: f64,
    hp: f64,
) -> f64 {
    if limb == Limb::Center {
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            false,
            "not applicable: the Moon's centre observed, no semidiameter".to_string(),
        ));
        return h;
    }
    if sd == 0.0 {
        warnings.push(Warning::Other {
            message: format!(
                "observation {id}: Moon {} limb requested but the semidiameter supplied is \
                 0.0' (unknown); no semidiameter applied, so Ho is a limb altitude, not a \
                 centre altitude",
                limb_name(limb)
            ),
        });
        steps.push(make_step(
            CorrectionKind::Semidiameter,
            h,
            h,
            true,
            format!(
                "Moon {} limb, but semidiameter is unknown (0.000'): nothing added",
                limb_name(limb)
            ),
        ));
        return h;
    }
    let sign = if limb == Limb::Lower { 1.0 } else { -1.0 };
    let (sd_topo, centre) = limb_to_centre(h, sign, sd, hp);
    steps.push(make_step(
        CorrectionKind::Semidiameter,
        h,
        centre,
        true,
        format!(
            "Moon {} limb: semidiameter {sd:.3}' augmented by {:.3}' to {sd_topo:.3}' \
             (topocentric, centre at {centre:.4} deg) {}",
            limb_name(limb),
            sd_topo - sd,
            if sign > 0.0 { "added" } else { "subtracted" }
        ),
    ));
    centre
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

/// Serialised spelling of a [`HorizonMode`]'s kind, for notes (`"shore"` without its
/// distance; [`horizon_label`] keeps it).
pub fn horizon_name(horizon: HorizonMode) -> &'static str {
    match horizon {
        HorizonMode::Sea => "sea",
        HorizonMode::ArtificialReflected => "artificial_reflected",
        HorizonMode::ElectronicVertical => "electronic_vertical",
        HorizonMode::Shore { .. } => "shore",
    }
}

/// A [`HorizonMode`] as one CSV cell: its name, and for a shore horizon
/// `shore:<distance_nm>` with the shortest decimal that parses back to the same number.
/// [`parse_horizon_label`] is the inverse.
pub fn horizon_label(horizon: HorizonMode) -> String {
    match horizon {
        HorizonMode::Shore { distance_nm } => format!("shore:{distance_nm}"),
        other => horizon_name(other).to_string(),
    }
}

/// Parse a [`horizon_label`]: `sea`, `artificial_reflected`, `electronic_vertical` or
/// `shore:<distance_nm>`. `None` for anything else.
pub fn parse_horizon_label(s: &str) -> Option<HorizonMode> {
    match s.trim() {
        "sea" => Some(HorizonMode::Sea),
        "artificial_reflected" => Some(HorizonMode::ArtificialReflected),
        "electronic_vertical" => Some(HorizonMode::ElectronicVertical),
        other => {
            let d = other.strip_prefix("shore:")?.trim().parse::<f64>().ok()?;
            Some(HorizonMode::Shore { distance_nm: d })
        }
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
