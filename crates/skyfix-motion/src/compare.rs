//! Three measurement types, and the one thing a comparison between them can honestly say.
//!
//! BRIEF section C. `docs/MOTION.md` sections "The disagreement statistic" and "Why
//! relative motion needs a scale source" are normative.
//!
//! # The types are separate on purpose
//!
//! - [`AbsolutePosition`] — where you are, in a named frame, with a covariance.
//! - [`RelativeDisplacement`] — how far and which way you moved, with a covariance **and
//!   a statement about whether that "how far" is in metres at all** ([`ScaleKnowledge`]).
//! - [`AbsoluteHeading`] — which way you point.
//!
//! Nothing here converts one into another silently. Turning displacements into a position
//! needs a starting absolute position *and* a metric scale, and
//! [`integrate_odometry`] returns [`ScaleError::NoMetricScale`] rather than inventing one
//! when the scale is unknown.
//!
//! # The disagreement statistic
//!
//! Two absolute positions with covariances `Ca` and `Cb`, separated by `d` (metres, north
//! and east on the tangent plane):
//!
//! ```text
//! chi2 = d^T (Ca + Cb)^-1 d          2 degrees of freedom
//! k    = sqrt(chi2)                  "times their combined modelled uncertainty"
//! p    = exp(-chi2 / 2)              exact survival function of chi-square with 2 dof
//! beyond_modelled_uncertainty = p < 0.01
//! ```
//!
//! Adding the covariances assumes the two estimates are **independent**. They usually are
//! — a sextant and a GNSS receiver share no error source — but a celestial fix compared
//! against a GNSS-aided DR track is not independent of it, and then `Ca + Cb` is too
//! large and the test is too forgiving. That assumption is stated, not hidden.
//!
//! # What the statement may and may not say
//!
//! The statement is always the same sentence with different numbers, followed by
//! [`INDISTINGUISHABLE_CAUSES`] verbatim. A large `k` means the two estimates disagree by
//! more than their *modelled* uncertainty. It does not say which one is wrong, and it
//! cannot: scenario (d) in [`crate::scenarios`] produces a statement identical in form to
//! scenario (c) from a 30-second clock error rather than a displaced reference. The word
//! "spoofing" never appears as a conclusion anywhere in this crate.

use crate::{to_latlon, to_point};
use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{angular_distance, apply_tangent_step, tangent_offset};
use skyfix_core::linalg;
use skyfix_core::time::format_utc;
use skyfix_core::types::LatLon;
use skyfix_core::units::{NM_M, m_to_rad, norm_180, rad_to_m};

/// The six causes this comparison cannot separate. Emitted verbatim after every
/// disagreement statement.
pub const INDISTINGUISHABLE_CAUSES: &str = "This check cannot tell these causes apart: \
     clock error, instrument bias, ephemeris/almanac error, dead-reckoning error, a wrong \
     or spoofed reference, or an underestimated covariance. It reports a disagreement, \
     not a diagnosis.";

/// `p` below which the two estimates are called "beyond their modelled uncertainty".
pub const BEYOND_P_THRESHOLD: f64 = 0.01;

// ---------------------------------------------------------------------------
// The three measurement types
// ---------------------------------------------------------------------------

/// Where something is, in a frame, at an instant, with a covariance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AbsolutePosition {
    /// `jd_utc` (CONVENTIONS section 6).
    pub utc_jd: f64,
    pub position: LatLon,
    /// Tangent-plane covariance, metres^2, rows/cols `(north, east)`.
    pub covariance_ne_m2: [[f64; 2]; 2],
    /// Where this estimate came from: `"celestial running fix"`, `"GNSS"`, ...
    pub source: String,
}

impl AbsolutePosition {
    pub fn new(
        utc_jd: f64,
        position: LatLon,
        covariance_ne_m2: [[f64; 2]; 2],
        source: impl Into<String>,
    ) -> Self {
        AbsolutePosition {
            utc_jd,
            position,
            covariance_ne_m2,
            source: source.into(),
        }
    }

    /// An estimate with an isotropic 1-sigma radius.
    pub fn isotropic(
        utc_jd: f64,
        position: LatLon,
        sigma_m: f64,
        source: impl Into<String>,
    ) -> Self {
        let v = sigma_m * sigma_m;
        AbsolutePosition::new(utc_jd, position, [[v, 0.0], [0.0, v]], source)
    }

    pub fn utc(&self) -> String {
        format_utc(self.utc_jd)
    }
}

/// How the metric scale of a relative displacement is known.
///
/// A monocular camera measures direction and *relative* distance. Nothing in the image
/// says how big anything is, so an optic-flow displacement is a direction and a shape,
/// not a number of metres, until a scale source (a stereo baseline, a known object size,
/// a speed log, a pair of absolute positions) is supplied.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScaleKnowledge {
    /// The displacement really is in metres.
    Metric,
    /// The displacement is in *some* consistent unit. `nominal_scale` is the pipeline's
    /// working guess (metres per unit) and is recorded for provenance; it is **not** a
    /// scale source and never turns an unscaled track into a metric one.
    UnknownScale {
        nominal_scale: f64,
        scale_sigma: f64,
    },
}

impl ScaleKnowledge {
    pub fn is_metric(&self) -> bool {
        matches!(self, ScaleKnowledge::Metric)
    }
}

/// How far and which way something moved between two instants.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelativeDisplacement {
    pub from_utc_jd: f64,
    pub to_utc_jd: f64,
    /// North component. Metres when `scale` is [`ScaleKnowledge::Metric`], otherwise in
    /// the sensor's own arbitrary unit.
    pub north_m: f64,
    /// East component, same unit as `north_m`.
    pub east_m: f64,
    /// Covariance in the same (possibly arbitrary) unit squared, rows/cols
    /// `(north, east)`.
    pub covariance_ne_m2: [[f64; 2]; 2],
    pub scale: ScaleKnowledge,
    pub source: String,
}

impl RelativeDisplacement {
    pub fn metric(
        from_utc_jd: f64,
        to_utc_jd: f64,
        north_m: f64,
        east_m: f64,
        covariance_ne_m2: [[f64; 2]; 2],
        source: impl Into<String>,
    ) -> Self {
        RelativeDisplacement {
            from_utc_jd,
            to_utc_jd,
            north_m,
            east_m,
            covariance_ne_m2,
            scale: ScaleKnowledge::Metric,
            source: source.into(),
        }
    }

    pub fn unscaled(
        from_utc_jd: f64,
        to_utc_jd: f64,
        north: f64,
        east: f64,
        covariance_ne_m2: [[f64; 2]; 2],
        nominal_scale: f64,
        scale_sigma: f64,
        source: impl Into<String>,
    ) -> Self {
        RelativeDisplacement {
            from_utc_jd,
            to_utc_jd,
            north_m: north,
            east_m: east,
            covariance_ne_m2,
            scale: ScaleKnowledge::UnknownScale {
                nominal_scale,
                scale_sigma,
            },
            source: source.into(),
        }
    }
}

/// Which way something points, at an instant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AbsoluteHeading {
    pub utc_jd: f64,
    /// True heading, degrees clockwise from north. Any representative of the angle is
    /// accepted; comparisons are modulo 360.
    pub heading_deg: f64,
    pub sigma_deg: f64,
    pub source: String,
}

impl AbsoluteHeading {
    pub fn new(utc_jd: f64, heading_deg: f64, sigma_deg: f64, source: impl Into<String>) -> Self {
        AbsoluteHeading {
            utc_jd,
            heading_deg,
            sigma_deg,
            source: source.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Disagreement
// ---------------------------------------------------------------------------

/// The result of comparing two absolute positions. `statement` is the only thing meant
/// for a human, and it never names a cause.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Disagreement {
    /// Great-circle separation of the two estimates, metres.
    pub separation_m: f64,
    /// `sqrt(chi2)`: how many combined standard deviations apart they are.
    pub mahalanobis: f64,
    /// `exp(-chi2 / 2)`, the exact chi-square survival function with 2 dof.
    pub chi2_p_value: f64,
    /// `chi2_p_value < 0.01`.
    pub beyond_modelled_uncertainty: bool,
    pub statement: String,
}

/// Compare two absolute positions.
///
/// The timestamp printed is estimate A's. Comparing estimates at different instants is
/// the caller's responsibility; [`crate::replay`] interpolates the reference so that they
/// match.
pub fn disagreement(a: &AbsolutePosition, b: &AbsolutePosition) -> Disagreement {
    let pa = to_point(a.position);
    let pb = to_point(b.position);
    let separation_m = rad_to_m(angular_distance(pa, pb));
    let (dn, de) = tangent_offset(pa, pb);
    let d = [rad_to_m(dn), rad_to_m(de)];

    let combined = [
        [
            a.covariance_ne_m2[0][0] + b.covariance_ne_m2[0][0],
            a.covariance_ne_m2[0][1] + b.covariance_ne_m2[0][1],
        ],
        [
            a.covariance_ne_m2[1][0] + b.covariance_ne_m2[1][0],
            a.covariance_ne_m2[1][1] + b.covariance_ne_m2[1][1],
        ],
    ];
    let chi2 = mahalanobis_squared(d, combined);
    let mahalanobis = chi2.sqrt();
    let chi2_p_value = chi2_p_value_2dof(chi2);
    Disagreement {
        separation_m,
        mahalanobis,
        chi2_p_value,
        beyond_modelled_uncertainty: chi2_p_value < BEYOND_P_THRESHOLD,
        statement: position_statement(&a.source, &b.source, a.utc_jd, separation_m, mahalanobis),
    }
}

/// `d^T C^-1 d`. A combined covariance that is not positive definite claims zero variance
/// in some direction, so any separation along it is infinitely many sigmas; a zero
/// separation is still zero sigmas.
fn mahalanobis_squared(d: [f64; 2], c: [[f64; 2]; 2]) -> f64 {
    if !d[0].is_finite() || !d[1].is_finite() || c.iter().flatten().any(|v| !v.is_finite()) {
        return f64::NAN;
    }
    if d[0] == 0.0 && d[1] == 0.0 {
        return 0.0;
    }
    let m = vec![vec![c[0][0], c[0][1]], vec![c[1][0], c[1][1]]];
    match linalg::invert_sym_pd(&m) {
        Some(inv) => {
            let x0 = inv[0][0] * d[0] + inv[0][1] * d[1];
            let x1 = inv[1][0] * d[0] + inv[1][1] * d[1];
            (d[0] * x0 + d[1] * x1).max(0.0)
        }
        None => f64::INFINITY,
    }
}

/// Survival function of chi-square with 2 degrees of freedom: `exp(-x / 2)`, exact.
pub fn chi2_p_value_2dof(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x <= 0.0 {
        return 1.0;
    }
    (-0.5 * x).exp()
}

/// Survival function of chi-square with 1 degree of freedom: `erfc(sqrt(x / 2))`.
pub fn chi2_p_value_1dof(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x <= 0.0 {
        return 1.0;
    }
    erfc((0.5 * x).sqrt())
}

/// Complementary error function, Numerical Recipes' Chebyshev fit `erfcc`. Fractional
/// error below 1.2e-7 everywhere, which is four orders inside the 0.01 threshold this
/// crate compares against.
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let poly = -1.265_512_23
        + t * (1.000_023_68
            + t * (0.374_091_96
                + t * (0.096_784_18
                    + t * (-0.186_288_06
                        + t * (0.278_868_07
                            + t * (-1.135_203_98
                                + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77))))))));
    let ans = t * (-z * z + poly).exp();
    if x >= 0.0 { ans } else { 2.0 - ans }
}

fn position_statement(
    source_a: &str,
    source_b: &str,
    utc_jd: f64,
    separation_m: f64,
    k: f64,
) -> String {
    format!(
        "Estimate A ({source_a}) and estimate B ({source_b}) at {} disagree by {separation_m:.1} \
         m, {k:.2} times their combined modelled uncertainty. {INDISTINGUISHABLE_CAUSES}",
        format_utc(utc_jd)
    )
}

// ---------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------

/// The result of comparing two absolute headings. One degree of freedom.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeadingDisagreement {
    /// Smallest signed difference `a - b`, degrees, in `(-180, 180]`.
    pub difference_deg: f64,
    /// `|difference_deg|`.
    pub separation_deg: f64,
    pub mahalanobis: f64,
    /// `erfc(k / sqrt(2))`, the chi-square survival function with 1 dof.
    pub chi2_p_value: f64,
    pub beyond_modelled_uncertainty: bool,
    pub statement: String,
}

/// Compare two absolute headings, modulo 360.
///
/// 359 deg and 1 deg are two degrees apart, not 358. The statement carries the same fixed
/// causes list as [`disagreement`]: a heading disagreement is no more diagnostic than a
/// position disagreement.
pub fn heading_disagreement(a: &AbsoluteHeading, b: &AbsoluteHeading) -> HeadingDisagreement {
    let difference_deg = norm_180(a.heading_deg - b.heading_deg);
    let separation_deg = difference_deg.abs();
    let var = a.sigma_deg * a.sigma_deg + b.sigma_deg * b.sigma_deg;
    let mahalanobis = if !var.is_finite() || !separation_deg.is_finite() {
        f64::NAN
    } else if var <= 0.0 {
        if separation_deg == 0.0 {
            0.0
        } else {
            f64::INFINITY
        }
    } else {
        separation_deg / var.sqrt()
    };
    let chi2_p_value = chi2_p_value_1dof(mahalanobis * mahalanobis);
    HeadingDisagreement {
        difference_deg,
        separation_deg,
        mahalanobis,
        chi2_p_value,
        beyond_modelled_uncertainty: chi2_p_value < BEYOND_P_THRESHOLD,
        statement: format!(
            "Estimate A ({}) and estimate B ({}) at {} disagree by {separation_deg:.2} deg, \
             {mahalanobis:.2} times their combined modelled uncertainty. \
             {INDISTINGUISHABLE_CAUSES}",
            a.source,
            b.source,
            format_utc(a.utc_jd)
        ),
    }
}

// ---------------------------------------------------------------------------
// Odometry integration
// ---------------------------------------------------------------------------

/// Why a set of relative displacements could not be turned into an absolute position.
#[derive(Debug, Clone, PartialEq)]
pub enum ScaleError {
    /// At least one leg has no metric scale and no scale source was supplied.
    NoMetricScale {
        sources: Vec<String>,
        message: String,
    },
    /// The anchor pair does not bracket the legs in time, so it constrains a different
    /// stretch of motion than the one being scaled.
    AnchorDoesNotBracket { message: String },
    /// The unscaled legs sum to (nearly) zero displacement, so the anchor separation
    /// carries no information about the scale.
    DegenerateAnchor { message: String },
    /// Nothing to integrate.
    NoLegs,
}

impl std::fmt::Display for ScaleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScaleError::NoMetricScale { message, .. }
            | ScaleError::AnchorDoesNotBracket { message }
            | ScaleError::DegenerateAnchor { message } => f.write_str(message),
            ScaleError::NoLegs => f.write_str("no relative displacements to integrate"),
        }
    }
}

impl std::error::Error for ScaleError {}

/// Two absolute positions bracketing the legs, used as a scale source.
#[derive(Debug, Clone, PartialEq)]
pub struct ScaleAnchor {
    pub start: AbsolutePosition,
    pub end: AbsolutePosition,
}

impl ScaleAnchor {
    pub fn new(start: AbsolutePosition, end: AbsolutePosition) -> Self {
        ScaleAnchor { start, end }
    }
}

/// An estimated metric scale and its 1-sigma uncertainty, in metres per sensor unit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScaleEstimate {
    pub scale: f64,
    pub sigma: f64,
    /// The nominal the pipeline carried, for comparison. Never used as a prior.
    pub nominal_scale: f64,
    /// What supplied the scale, e.g. `"anchor pair GNSS -> GNSS"`.
    pub source: String,
}

/// An integrated track with whatever scale information was used to build it.
#[derive(Debug, Clone, PartialEq)]
pub struct OdometryIntegration {
    pub position: AbsolutePosition,
    /// `None` when every leg was already metric.
    pub scale: Option<ScaleEstimate>,
    pub note: String,
}

/// Integrate relative displacements from a known starting position.
///
/// Succeeds only when **every** leg is [`ScaleKnowledge::Metric`]. A leg with an unknown
/// scale returns [`ScaleError::NoMetricScale`]: a monocular relative-motion sensor
/// measures shape and direction, not metres, and a `nominal_scale` recorded for
/// provenance is a guess, not a measurement. Supply a scale source and use
/// [`integrate_odometry_with_anchor`].
pub fn integrate_odometry(
    start: &AbsolutePosition,
    legs: &[RelativeDisplacement],
) -> Result<AbsolutePosition, ScaleError> {
    integrate(start, legs, None).map(|o| o.position)
}

/// Integrate relative displacements, estimating the metric scale from a pair of absolute
/// positions that bracket the legs.
///
/// The scale is a single number applied to every non-metric leg:
///
/// ```text
/// s     = ((d_anchor - d_metric) . d_unscaled) / (d_unscaled . d_unscaled)
/// var s = u^T (C_start + C_end + C_metric + s^2 C_unscaled) u / |d_unscaled|^2
/// ```
///
/// with `u` the unit vector along the unscaled displacement. It is reported with its
/// sigma and never silently folded away.
pub fn integrate_odometry_with_anchor(
    start: &AbsolutePosition,
    legs: &[RelativeDisplacement],
    anchor: &ScaleAnchor,
) -> Result<OdometryIntegration, ScaleError> {
    integrate(start, legs, Some(anchor))
}

fn integrate(
    start: &AbsolutePosition,
    legs: &[RelativeDisplacement],
    anchor: Option<&ScaleAnchor>,
) -> Result<OdometryIntegration, ScaleError> {
    if legs.is_empty() {
        return Err(ScaleError::NoLegs);
    }
    let mut ordered: Vec<&RelativeDisplacement> = legs.iter().collect();
    ordered.sort_by(|a, b| {
        a.from_utc_jd
            .partial_cmp(&b.from_utc_jd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let unscaled_sources: Vec<String> = ordered
        .iter()
        .filter(|l| !l.scale.is_metric())
        .map(|l| l.source.clone())
        .collect();

    let scale = match (unscaled_sources.is_empty(), anchor) {
        (true, _) => None,
        (false, None) => {
            return Err(ScaleError::NoMetricScale {
                sources: unscaled_sources.clone(),
                message: format!(
                    "{} relative displacement(s) ({}) have no metric scale. Monocular \
                     relative motion measures direction and relative distance only; it has \
                     NO metric scale until a scale source is supplied (a stereo baseline, a \
                     known object size, a speed log, or a pair of absolute positions \
                     bracketing the legs). The nominal scale recorded on the leg is the \
                     pipeline's working guess for provenance, not a measurement, and this \
                     function will not silently promote it to metres.",
                    unscaled_sources.len(),
                    unscaled_sources.join(", ")
                ),
            });
        }
        (false, Some(a)) => Some(estimate_scale(&ordered, a)?),
    };

    let s = scale.as_ref().map_or(1.0, |e| e.scale);
    let mut p = to_point(start.position);
    let mut cov = start.covariance_ne_m2;
    let (mut unscaled_n, mut unscaled_e) = (0.0, 0.0);
    for leg in &ordered {
        let k = if leg.scale.is_metric() { 1.0 } else { s };
        if !leg.scale.is_metric() {
            unscaled_n += leg.north_m;
            unscaled_e += leg.east_m;
        }
        p = apply_tangent_step(p, m_to_rad(k * leg.north_m), m_to_rad(k * leg.east_m));
        // Leg errors are summed in the start frame. The frame rotates along the path, but
        // over a track short enough for this integration to mean anything the rotation is
        // far below the covariance itself.
        add_scaled(&mut cov, leg.covariance_ne_m2, k * k);
    }
    // The scale is one number multiplying the whole unscaled displacement, so its
    // uncertainty is a rank-1 term along that displacement.
    if let Some(e) = &scale {
        let v = e.sigma * e.sigma;
        cov[0][0] += v * unscaled_n * unscaled_n;
        cov[0][1] += v * unscaled_n * unscaled_e;
        cov[1][0] += v * unscaled_n * unscaled_e;
        cov[1][1] += v * unscaled_e * unscaled_e;
    }

    let note = match &scale {
        None => format!(
            "{} metric leg(s) integrated; no scale estimation was needed.",
            ordered.len()
        ),
        Some(e) => format!(
            "{} leg(s) integrated. {} of them had no metric scale and were scaled by \
             {:.6} +/- {:.6} m per unit, estimated from {}; the pipeline's nominal was \
             {:.6} and was NOT used as a prior. The scale uncertainty is included in the \
             covariance as a rank-1 term along the unscaled displacement.",
            ordered.len(),
            unscaled_sources.len(),
            e.scale,
            e.sigma,
            e.source,
            e.nominal_scale
        ),
    };

    let end_utc = ordered
        .iter()
        .map(|l| l.to_utc_jd)
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(OdometryIntegration {
        position: AbsolutePosition::new(
            end_utc,
            to_latlon(p),
            cov,
            format!("{} + odometry", start.source),
        ),
        scale,
        note,
    })
}

fn estimate_scale(
    ordered: &[&RelativeDisplacement],
    anchor: &ScaleAnchor,
) -> Result<ScaleEstimate, ScaleError> {
    let first = ordered.first().map(|l| l.from_utc_jd).unwrap_or(f64::NAN);
    let last = ordered
        .iter()
        .map(|l| l.to_utc_jd)
        .fold(f64::NEG_INFINITY, f64::max);
    // A Julian date resolves ~40 us; allow a millisecond of slop before calling an
    // anchor "outside" the legs.
    let tol = 1e-3 / 86_400.0;
    if !(anchor.start.utc_jd <= first + tol && anchor.end.utc_jd >= last - tol) {
        return Err(ScaleError::AnchorDoesNotBracket {
            message: format!(
                "the anchor pair spans {} to {} but the legs span {} to {}: an anchor that \
                 does not bracket the legs constrains a different stretch of motion and \
                 cannot scale them",
                anchor.start.utc(),
                anchor.end.utc(),
                format_utc(first),
                format_utc(last)
            ),
        });
    }

    let (an, ae) = tangent_offset(
        to_point(anchor.start.position),
        to_point(anchor.end.position),
    );
    let observed = [rad_to_m(an), rad_to_m(ae)];
    let mut metric = [0.0, 0.0];
    let mut unscaled = [0.0, 0.0];
    let mut cov_metric = [[0.0; 2]; 2];
    let mut cov_unscaled = [[0.0; 2]; 2];
    let mut nominal = f64::NAN;
    for leg in ordered {
        match leg.scale {
            ScaleKnowledge::Metric => {
                metric[0] += leg.north_m;
                metric[1] += leg.east_m;
                add_scaled(&mut cov_metric, leg.covariance_ne_m2, 1.0);
            }
            ScaleKnowledge::UnknownScale { nominal_scale, .. } => {
                unscaled[0] += leg.north_m;
                unscaled[1] += leg.east_m;
                add_scaled(&mut cov_unscaled, leg.covariance_ne_m2, 1.0);
                if nominal.is_nan() {
                    nominal = nominal_scale;
                }
            }
        }
    }

    let denom = unscaled[0] * unscaled[0] + unscaled[1] * unscaled[1];
    let length = denom.sqrt();
    // A closing loop, or numerical dust, leaves nothing for the anchor to measure.
    let anchor_sigma = (anchor.start.covariance_ne_m2[0][0] + anchor.end.covariance_ne_m2[0][0])
        .max(0.0)
        .sqrt();
    if !denom.is_finite() || length <= anchor_sigma.max(1e-9) {
        return Err(ScaleError::DegenerateAnchor {
            message: format!(
                "the unscaled legs sum to a displacement of {length:.6} sensor units, which is \
                 not larger than the anchor's own uncertainty: the anchor separation carries \
                 no information about the scale (an out-and-back track cannot be scaled by \
                 its endpoints)"
            ),
        });
    }

    let residual = [observed[0] - metric[0], observed[1] - metric[1]];
    let scale = (residual[0] * unscaled[0] + residual[1] * unscaled[1]) / denom;

    let u = [unscaled[0] / length, unscaled[1] / length];
    let mut total = [[0.0; 2]; 2];
    add_scaled(&mut total, anchor.start.covariance_ne_m2, 1.0);
    add_scaled(&mut total, anchor.end.covariance_ne_m2, 1.0);
    add_scaled(&mut total, cov_metric, 1.0);
    add_scaled(&mut total, cov_unscaled, scale * scale);
    let along = u[0] * (total[0][0] * u[0] + total[0][1] * u[1])
        + u[1] * (total[1][0] * u[0] + total[1][1] * u[1]);
    let sigma = (along.max(0.0) / denom).sqrt();

    Ok(ScaleEstimate {
        scale,
        sigma,
        nominal_scale: if nominal.is_nan() { 1.0 } else { nominal },
        source: format!(
            "anchor pair {} -> {}",
            anchor.start.source, anchor.end.source
        ),
    })
}

fn add_scaled(into: &mut [[f64; 2]; 2], c: [[f64; 2]; 2], k: f64) {
    for r in 0..2 {
        for col in 0..2 {
            into[r][col] += k * c[r][col];
        }
    }
}

/// Helper for building test and demo covariances: an ellipse of 1-sigma semi-axes
/// `sigma_along_m` (at `orientation_deg` clockwise from north) and `sigma_across_m`.
pub fn oriented_covariance(
    sigma_along_m: f64,
    sigma_across_m: f64,
    orientation_deg: f64,
) -> [[f64; 2]; 2] {
    let (s, c) = orientation_deg.to_radians().sin_cos();
    let (a, b) = (
        sigma_along_m * sigma_along_m,
        sigma_across_m * sigma_across_m,
    );
    [
        [a * c * c + b * s * s, (a - b) * s * c],
        [(a - b) * s * c, a * s * s + b * c * c],
    ]
}

/// Nautical miles to metres, for scenario and demo code that thinks in NM.
pub fn nm_m(nm: f64) -> f64 {
    nm * NM_M
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    const T0: f64 = 2_461_314.5;
    const HOUR: f64 = 1.0 / 24.0;

    fn at(lat: f64, lon: f64) -> LatLon {
        LatLon {
            lat_deg: lat,
            lon_deg: lon,
        }
    }

    #[test]
    fn identical_estimates_do_not_disagree() {
        let a = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 100.0, "celestial fix");
        let b = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 5.0, "GNSS receiver");
        let d = disagreement(&a, &b);
        assert_relative_eq!(d.separation_m, 0.0, epsilon = 1e-9);
        assert_eq!(d.mahalanobis, 0.0);
        assert_eq!(d.chi2_p_value, 1.0);
        assert!(!d.beyond_modelled_uncertainty);
    }

    #[test]
    fn the_statistic_is_the_documented_closed_form() {
        // 1852 m due north, both estimates isotropic with sigma 926 m: k = 2 sigma
        // combined would be sqrt(2) * 926; check against the explicit arithmetic.
        let a = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 926.0, "A");
        let north = apply_tangent_step(to_point(a.position), m_to_rad(1852.0), 0.0);
        let b = AbsolutePosition::isotropic(T0, to_latlon(north), 926.0, "B");
        let d = disagreement(&a, &b);
        assert_relative_eq!(d.separation_m, 1852.0, epsilon = 1e-6);
        let expected_k = 1852.0 / (926.0f64 * 926.0 * 2.0).sqrt();
        assert_relative_eq!(d.mahalanobis, expected_k, epsilon = 1e-9);
        assert_relative_eq!(
            d.chi2_p_value,
            (-0.5 * expected_k * expected_k).exp(),
            epsilon = 1e-12
        );
    }

    #[test]
    fn the_threshold_is_p_below_one_percent() {
        // p = 0.01 at chi2 = 2 ln 100 = 9.2103, k = 3.0349.
        let k_threshold = (2.0 * 100.0f64.ln()).sqrt();
        assert_relative_eq!(
            chi2_p_value_2dof(k_threshold * k_threshold),
            0.01,
            epsilon = 1e-12
        );
        for (k, beyond) in [(k_threshold * 0.99, false), (k_threshold * 1.01, true)] {
            let sigma = 100.0;
            let a = AbsolutePosition::isotropic(T0, at(40.0, -70.0), sigma, "A");
            let offset = k * sigma * 2.0f64.sqrt();
            let moved = apply_tangent_step(to_point(a.position), m_to_rad(offset), 0.0);
            let b = AbsolutePosition::isotropic(T0, to_latlon(moved), sigma, "B");
            assert_eq!(disagreement(&a, &b).beyond_modelled_uncertainty, beyond);
        }
    }

    #[test]
    fn the_statement_has_the_fixed_form_and_never_concludes_spoofing() {
        let a = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 926.0, "celestial fix");
        let moved = apply_tangent_step(to_point(a.position), m_to_rad(3704.0), 0.0);
        let b = AbsolutePosition::isotropic(T0, to_latlon(moved), 9.0, "GNSS receiver");
        let d = disagreement(&a, &b);
        assert!(
            d.statement
                .starts_with("Estimate A (celestial fix) and estimate B (GNSS receiver) at ")
        );
        assert!(d.statement.contains("disagree by "));
        assert!(
            d.statement
                .contains("times their combined modelled uncertainty.")
        );
        assert!(d.statement.ends_with(INDISTINGUISHABLE_CAUSES));
        assert!(!d.statement.contains("spoofing"));
        // Every one of the six causes is named.
        for cause in [
            "clock error",
            "instrument bias",
            "ephemeris/almanac error",
            "dead-reckoning error",
            "a wrong or spoofed reference",
            "an underestimated covariance",
        ] {
            assert!(d.statement.contains(cause), "missing cause: {cause}");
        }
    }

    #[test]
    fn a_singular_combined_covariance_is_infinitely_many_sigmas() {
        let a = AbsolutePosition::new(T0, at(40.0, -70.0), [[0.0, 0.0], [0.0, 0.0]], "A");
        let moved = apply_tangent_step(to_point(a.position), m_to_rad(10.0), 0.0);
        let b = AbsolutePosition::new(T0, to_latlon(moved), [[0.0, 0.0], [0.0, 0.0]], "B");
        let d = disagreement(&a, &b);
        assert!(d.mahalanobis.is_infinite());
        assert_eq!(d.chi2_p_value, 0.0);
        assert!(d.beyond_modelled_uncertainty);
        // Same covariance, same position: no disagreement.
        let same = disagreement(&a, &a);
        assert_eq!(same.mahalanobis, 0.0);
        assert!(!same.beyond_modelled_uncertainty);
    }

    #[test]
    fn heading_comparison_wraps_through_zero() {
        let a = AbsoluteHeading::new(T0, 359.0, 1.0, "gyro");
        let b = AbsoluteHeading::new(T0, 1.0, 1.0, "celestial azimuth");
        let d = heading_disagreement(&a, &b);
        assert_relative_eq!(d.separation_deg, 2.0, epsilon = 1e-12);
        assert_relative_eq!(d.difference_deg, -2.0, epsilon = 1e-12);
        assert_relative_eq!(d.mahalanobis, 2.0 / 2.0f64.sqrt(), epsilon = 1e-12);
        assert!(!d.beyond_modelled_uncertainty);

        // The same pair written as 719 and -359.
        let a2 = AbsoluteHeading::new(T0, 719.0, 1.0, "gyro");
        let b2 = AbsoluteHeading::new(T0, -359.0, 1.0, "celestial azimuth");
        assert_relative_eq!(
            heading_disagreement(&a2, &b2).separation_deg,
            2.0,
            epsilon = 1e-9
        );

        // 180 deg apart is the maximum separation.
        let opposite = heading_disagreement(
            &AbsoluteHeading::new(T0, 10.0, 1.0, "a"),
            &AbsoluteHeading::new(T0, 190.0, 1.0, "b"),
        );
        assert_relative_eq!(opposite.separation_deg, 180.0, epsilon = 1e-12);
        assert!(opposite.beyond_modelled_uncertainty);
        assert!(opposite.statement.ends_with(INDISTINGUISHABLE_CAUSES));
    }

    #[test]
    fn one_dof_p_value_matches_known_quantiles() {
        // Standard normal two-sided tails.
        assert_relative_eq!(chi2_p_value_1dof(1.0), 0.317_310_5, epsilon = 1e-6);
        assert_relative_eq!(chi2_p_value_1dof(3.841_458_8), 0.05, epsilon = 1e-6);
        assert_relative_eq!(chi2_p_value_1dof(6.634_896_6), 0.01, epsilon = 1e-6);
        assert_eq!(chi2_p_value_1dof(0.0), 1.0);
    }

    #[test]
    fn metric_legs_integrate_without_a_scale() {
        let start = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 10.0, "GNSS");
        let legs = vec![
            RelativeDisplacement::metric(
                T0,
                T0 + HOUR,
                1000.0,
                0.0,
                [[4.0, 0.0], [0.0, 4.0]],
                "wheel odometry",
            ),
            RelativeDisplacement::metric(
                T0 + HOUR,
                T0 + 2.0 * HOUR,
                0.0,
                2000.0,
                [[9.0, 0.0], [0.0, 9.0]],
                "wheel odometry",
            ),
        ];
        let end = integrate_odometry(&start, &legs).unwrap();
        let (n, e) = tangent_offset(to_point(start.position), to_point(end.position));
        assert_relative_eq!(rad_to_m(n), 1000.0, epsilon = 0.5);
        assert_relative_eq!(rad_to_m(e), 2000.0, epsilon = 0.5);
        // Covariances add: 100 + 4 + 9.
        assert_relative_eq!(end.covariance_ne_m2[0][0], 113.0, epsilon = 1e-9);
        assert_eq!(end.utc_jd, T0 + 2.0 * HOUR);
    }

    #[test]
    fn unknown_scale_is_an_explicit_error_not_a_guess() {
        let start = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 10.0, "GNSS");
        let legs = vec![RelativeDisplacement::unscaled(
            T0,
            T0 + HOUR,
            1.0,
            0.0,
            [[1e-4, 0.0], [0.0, 1e-4]],
            1000.0,
            50.0,
            "monocular optic flow",
        )];
        match integrate_odometry(&start, &legs) {
            Err(ScaleError::NoMetricScale { sources, message }) => {
                assert_eq!(sources, vec!["monocular optic flow".to_string()]);
                assert!(message.contains("NO metric scale"), "{message}");
                assert!(message.contains("scale source"), "{message}");
                assert!(message.contains("nominal"), "{message}");
            }
            other => panic!("expected NoMetricScale, got {other:?}"),
        }
        assert!(matches!(
            integrate_odometry(&start, &[]),
            Err(ScaleError::NoLegs)
        ));
    }

    #[test]
    fn an_anchor_pair_recovers_the_scale() {
        let start = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 1.0, "GNSS");
        let true_scale = 37.5;
        // Three unscaled legs summing to (4, 3) sensor units = 5 units of displacement.
        let legs = vec![
            RelativeDisplacement::unscaled(
                T0,
                T0 + HOUR,
                2.0,
                1.0,
                [[1e-6, 0.0], [0.0, 1e-6]],
                30.0,
                10.0,
                "monocular optic flow",
            ),
            RelativeDisplacement::unscaled(
                T0 + HOUR,
                T0 + 2.0 * HOUR,
                2.0,
                2.0,
                [[1e-6, 0.0], [0.0, 1e-6]],
                30.0,
                10.0,
                "monocular optic flow",
            ),
        ];
        let truth_end = apply_tangent_step(
            to_point(start.position),
            m_to_rad(true_scale * 4.0),
            m_to_rad(true_scale * 3.0),
        );
        let anchor = ScaleAnchor::new(
            start.clone(),
            AbsolutePosition::isotropic(T0 + 2.0 * HOUR, to_latlon(truth_end), 1.0, "GNSS"),
        );
        let out = integrate_odometry_with_anchor(&start, &legs, &anchor).unwrap();
        let est = out.scale.expect("a scale should have been estimated");
        assert_relative_eq!(est.scale, true_scale, epsilon = 1e-6);
        assert!(est.sigma > 0.0);
        // sigma ~ anchor sigma along the run / |d_unscaled| = sqrt(1 + 1) / 5.
        assert_relative_eq!(est.sigma, 2.0f64.sqrt() / 5.0, epsilon = 1e-3);
        assert_eq!(est.nominal_scale, 30.0);
        assert!(out.note.contains("NOT used as a prior"), "{}", out.note);
        // The integrated end position lands on the anchor's end.
        let gap = rad_to_m(angular_distance(
            to_point(out.position.position),
            to_point(anchor.end.position),
        ));
        assert!(gap < 1e-3, "gap {gap} m");
        // The scale uncertainty shows up in the covariance.
        assert!(out.position.covariance_ne_m2[0][0] > start.covariance_ne_m2[0][0]);
    }

    #[test]
    fn an_anchor_that_does_not_bracket_the_legs_is_refused() {
        let start = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 1.0, "GNSS");
        let legs = vec![RelativeDisplacement::unscaled(
            T0,
            T0 + 2.0 * HOUR,
            4.0,
            3.0,
            [[1e-6, 0.0], [0.0, 1e-6]],
            30.0,
            10.0,
            "monocular optic flow",
        )];
        let anchor = ScaleAnchor::new(
            start.clone(),
            AbsolutePosition::isotropic(T0 + HOUR, at(40.05, -70.0), 1.0, "GNSS"),
        );
        assert!(matches!(
            integrate_odometry_with_anchor(&start, &legs, &anchor),
            Err(ScaleError::AnchorDoesNotBracket { .. })
        ));
    }

    #[test]
    fn a_closed_loop_cannot_be_scaled_by_its_endpoints() {
        let start = AbsolutePosition::isotropic(T0, at(40.0, -70.0), 1.0, "GNSS");
        let legs = vec![
            RelativeDisplacement::unscaled(
                T0,
                T0 + HOUR,
                5.0,
                0.0,
                [[1e-6, 0.0], [0.0, 1e-6]],
                30.0,
                10.0,
                "monocular optic flow",
            ),
            RelativeDisplacement::unscaled(
                T0 + HOUR,
                T0 + 2.0 * HOUR,
                -5.0,
                0.0,
                [[1e-6, 0.0], [0.0, 1e-6]],
                30.0,
                10.0,
                "monocular optic flow",
            ),
        ];
        let anchor = ScaleAnchor::new(
            start.clone(),
            AbsolutePosition::isotropic(T0 + 2.0 * HOUR, at(40.0, -70.0), 1.0, "GNSS"),
        );
        assert!(matches!(
            integrate_odometry_with_anchor(&start, &legs, &anchor),
            Err(ScaleError::DegenerateAnchor { .. })
        ));
    }

    #[test]
    fn oriented_covariance_builds_the_ellipse_it_says() {
        let c = oriented_covariance(100.0, 10.0, 45.0);
        let (values, _) = skyfix_core::linalg::eigen_sym2(c);
        assert_relative_eq!(values[0].sqrt(), 100.0, epsilon = 1e-9);
        assert_relative_eq!(values[1].sqrt(), 10.0, epsilon = 1e-9);
        assert_relative_eq!(nm_m(1.0), 1852.0, epsilon = 1e-12);
    }
}
