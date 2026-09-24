//! CONVENTIONS sections 4, 8, 9, 10, 12: the shared data contract.
//!
//! Serialised types use degrees / arcminutes / metres, exactly as they appear in JSON.
//! Internal computational types (`Sight`) use radians. Owners of `corrections`,
//! `reduce`, `solver`, `uncertainty` and `session` may *add* fields and variants; they
//! must not rename or remove anything here without updating every consumer crate.

use serde::{Deserialize, Serialize};

pub const SESSION_SCHEMA: &str = "skyfix.session/1";
pub const REFERENCE_SCHEMA: &str = "skyfix.reference/1";
pub const TRUTH_SCHEMA: &str = "skyfix.truth/1";

// ---------------------------------------------------------------------------
// Session model (section 10)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub schema: String,
    #[serde(default)]
    pub meta: SessionMeta,
    #[serde(default)]
    pub observer: Observer,
    #[serde(default)]
    pub instrument: Instrument,
    #[serde(default)]
    pub clock: Clock,
    pub observations: Vec<Observation>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionMeta {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub kind: SessionKind,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Simulated,
    Real,
}

/// Latitude/longitude in degrees, longitude east-positive.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LatLon {
    pub lat_deg: f64,
    pub lon_deg: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum AssumedPositionRole {
    /// Used only to start the iteration. Never affects the answer of a converged fix.
    #[default]
    Initializer,
    /// A proper Gaussian prior with the given 1-sigma radius; its effect is reported.
    Prior { sigma_nm: f64 },
    /// Ignored entirely; the solver relies on multistart.
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Observer {
    #[serde(default)]
    pub height_of_eye_m: f64,
    #[serde(default = "default_pressure_hpa")]
    pub pressure_hpa: f64,
    #[serde(default = "default_temperature_c")]
    pub temperature_c: f64,
    #[serde(default)]
    pub assumed_position: Option<LatLon>,
    #[serde(default)]
    pub assumed_position_role: AssumedPositionRole,
}

fn default_pressure_hpa() -> f64 {
    1010.0
}
fn default_temperature_c() -> f64 {
    10.0
}

impl Default for Observer {
    fn default() -> Self {
        Observer {
            height_of_eye_m: 0.0,
            pressure_hpa: default_pressure_hpa(),
            temperature_c: default_temperature_c(),
            assumed_position: None,
            assumed_position_role: AssumedPositionRole::Initializer,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Instrument {
    #[serde(default)]
    pub name: String,
    /// Signed, arcminutes, ADDED to the sextant reading (section 5, step 1).
    #[serde(default)]
    pub index_correction_arcmin: f64,
    #[serde(default)]
    pub horizon: HorizonMode,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HorizonMode {
    /// Natural sea horizon: dip applies.
    #[default]
    Sea,
    /// Reflected artificial horizon: reading is the double angle, halve after IC, no dip.
    ArtificialReflected,
    /// Electronic local vertical (inclinometer / camera attitude): no dip.
    ElectronicVertical,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct Clock {
    /// 1-sigma uncertainty of the recorded UTC, seconds. Propagated, never estimated.
    #[serde(default)]
    pub uncertainty_s: f64,
    /// Known chronometer correction, seconds, ADDED to every recorded time.
    #[serde(default)]
    pub correction_s: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AltitudeKind {
    #[default]
    SextantHs,
    ApparentHa,
    ObservedHo,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Limb {
    #[default]
    Center,
    Lower,
    Upper,
}

/// Apparent geocentric direction of date (section 7), degrees. GHA west-positive.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct GeocentricDirection {
    pub gha_deg: f64,
    pub dec_deg: f64,
    #[serde(default)]
    pub semidiameter_arcmin: f64,
    #[serde(default)]
    pub horizontal_parallax_arcmin: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Observation {
    pub id: String,
    pub body: String,
    /// RFC 3339 UTC with a trailing `Z`.
    pub utc: String,
    pub altitude_deg: f64,
    pub altitude_kind: AltitudeKind,
    #[serde(default = "default_sigma_arcmin")]
    pub sigma_arcmin: f64,
    #[serde(default)]
    pub limb: Limb,
    /// Per-observation override of the instrument horizon mode.
    #[serde(default)]
    pub horizon: Option<HorizonMode>,
    /// Supplied body direction; wins over any ephemeris provider when present.
    #[serde(default)]
    pub geocentric: Option<GeocentricDirection>,
    #[serde(default)]
    pub notes: String,
}

fn default_sigma_arcmin() -> f64 {
    1.0
}

// ---------------------------------------------------------------------------
// Corrections and reduction (sections 3-5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CorrectionKind {
    IndexCorrection,
    Dip,
    ArtificialHorizonHalving,
    Refraction,
    Semidiameter,
    Parallax,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CorrectionStep {
    pub kind: CorrectionKind,
    /// `false` when the step was skipped because the altitude kind was already past it,
    /// or because it does not apply to this horizon mode / body.
    pub applied: bool,
    pub before_deg: f64,
    pub after_deg: f64,
    /// `after - before` in arcminutes, for every step including halving.
    pub delta_arcmin: f64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CorrectionBreakdown {
    pub input_kind: AltitudeKind,
    pub input_deg: f64,
    pub steps: Vec<CorrectionStep>,
    pub ho_deg: f64,
    pub sigma_ho_arcmin: f64,
    pub warnings: Vec<Warning>,
}

/// One observation fully reduced against a body direction at an assumed position.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReducedSight {
    pub id: String,
    pub body: String,
    pub utc: String,
    pub jd_utc: f64,
    pub gha_deg: f64,
    pub dec_deg: f64,
    /// Where the direction came from: `"supplied"` or the provider name.
    pub direction_source: String,
    pub ho_deg: f64,
    /// The final sigma the solver uses; always equal to `corrections.sigma_ho_arcmin`.
    pub sigma_arcmin: f64,
    pub corrections: CorrectionBreakdown,
    /// Computed at the assumed position (if any).
    pub hc_deg: Option<f64>,
    pub zn_deg: Option<f64>,
    /// `Ho - Hc` in nautical miles, positive toward the body.
    pub intercept_nm: Option<f64>,
    /// The complete list for this sight: a superset of `corrections.warnings`.
    pub warnings: Vec<Warning>,
}

/// Solver input, radians. Built by `reduce`; never deserialised from user JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct Sight {
    pub id: String,
    pub body: String,
    pub gha_rad: f64,
    pub dec_rad: f64,
    pub ho_rad: f64,
    pub sigma_rad: f64,
    /// Rate of GHA change for clock-uncertainty propagation (section 6).
    pub gha_rate_rad_per_s: f64,
}

// ---------------------------------------------------------------------------
// Solver options and results (sections 8-9)
// ---------------------------------------------------------------------------

/// Every field has a default, so a JSON document may specify only what it changes.
/// When a session declares `assumed_position_role = prior` AND `SolveOptions.prior` is
/// set, `SolveOptions.prior` wins; callers (CLI, WASM) derive one from the other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SolveOptions {
    /// Starting point only. Never a prior.
    pub initializer: Option<LatLon>,
    /// Explicit Gaussian prior; reported with and without.
    pub prior: Option<PositionPrior>,
    /// Estimate a shared altitude bias as a third unknown (off by default).
    pub estimate_shared_bias: bool,
    /// Huber IRLS when `Some`.
    pub robust: Option<RobustOptions>,
    /// Propagated as an east-west covariance term (section 6).
    pub clock_uncertainty_s: f64,
    /// Report `s^2 = chi2/dof` scaled covariance in addition (only when dof >= 3).
    pub posterior_scaling: bool,
    pub multistart: MultistartOptions,
    pub max_iterations: u32,
    /// Convergence threshold on the tangent-plane step, radians.
    pub step_tolerance_rad: f64,
}

impl Default for SolveOptions {
    fn default() -> Self {
        SolveOptions {
            initializer: None,
            prior: None,
            estimate_shared_bias: false,
            robust: None,
            clock_uncertainty_s: 0.0,
            posterior_scaling: false,
            multistart: MultistartOptions::default(),
            max_iterations: 50,
            step_tolerance_rad: 1e-9,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct PositionPrior {
    pub center: LatLon,
    pub sigma_nm: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct RobustOptions {
    /// Huber threshold in normalised-residual units (default 1.5).
    pub huber_k: f64,
    pub max_reweight_iterations: u32,
}

impl Default for RobustOptions {
    fn default() -> Self {
        RobustOptions {
            huber_k: 1.5,
            max_reweight_iterations: 10,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct MultistartOptions {
    pub enabled: bool,
    pub grid_step_deg: f64,
    /// Minima closer than this are the same solution.
    pub cluster_radius_nm: f64,
    /// Chi-square margin below which a second minimum makes the result ambiguous.
    pub ambiguity_delta_chi2: f64,
}

impl Default for MultistartOptions {
    fn default() -> Self {
        MultistartOptions {
            enabled: true,
            grid_step_deg: 10.0,
            cluster_radius_nm: 10.0,
            ambiguity_delta_chi2: crate::units::CHI2_95_2DOF,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)] // one result per solve; readability over 1 kB of stack
pub enum FixResult {
    /// Fewer than two usable sights, or rank < 2: circles only, no point.
    Underdetermined {
        circles: Vec<CircleOfPosition>,
        reason: String,
        warnings: Vec<Warning>,
    },
    /// Two or more minima within the ambiguity margin. None is promoted.
    Ambiguous {
        candidates: Vec<FixCandidate>,
        circles: Vec<CircleOfPosition>,
        warnings: Vec<Warning>,
    },
    /// One fix; rejected alternatives listed with their chi-square gap. The circles of
    /// position are included so a plot never has to re-derive them.
    Unique {
        fix: Fix,
        alternatives: Vec<FixCandidate>,
        circles: Vec<CircleOfPosition>,
        warnings: Vec<Warning>,
    },
    Failed {
        reason: String,
        warnings: Vec<Warning>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CircleOfPosition {
    pub id: String,
    pub body: String,
    pub gp: LatLon,
    pub zenith_distance_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FixCandidate {
    pub position: LatLon,
    pub chi2: f64,
    pub delta_chi2_from_best: f64,
    pub converged: bool,
    pub iterations: u32,
    pub shared_bias_arcmin: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fix {
    pub position: LatLon,
    pub shared_bias_arcmin: Option<f64>,
    /// A priori tangent-plane covariance, metres^2, rows/cols = (north, east).
    pub covariance_ne_m2: [[f64; 2]; 2],
    pub sigma_north_m: f64,
    pub sigma_east_m: f64,
    /// East-west 1-sigma contribution from `clock_uncertainty_s`, metres (already
    /// included in `covariance_ne_m2`).
    pub clock_sigma_east_m: f64,
    pub ellipse95: Option<ErrorEllipse>,
    pub ellipse_suppressed_reason: Option<String>,
    /// Present only when `posterior_scaling` was requested and dof >= 3.
    pub posterior_scaled: Option<PosteriorScaled>,
    pub residuals: Vec<Residual>,
    pub chi2: f64,
    pub dof: i64,
    pub conditioning: Conditioning,
    pub iterations: u32,
    pub converged: bool,
    pub prior: Option<PriorReport>,
    pub robust: Option<RobustReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorEllipse {
    pub semi_major_m: f64,
    pub semi_minor_m: f64,
    /// Azimuth of the major axis, degrees clockwise from north, `[0, 180)`.
    pub orientation_deg: f64,
    pub confidence: f64,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PosteriorScaled {
    pub scale_factor_s2: f64,
    pub covariance_ne_m2: [[f64; 2]; 2],
    pub ellipse95: Option<ErrorEllipse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Residual {
    pub id: String,
    pub body: String,
    pub hc_deg: f64,
    pub zn_deg: f64,
    /// `Ho - Hc - bias`, arcminutes.
    pub residual_arcmin: f64,
    pub normalized: f64,
    /// Final weight relative to `1/sigma^2` (1.0 unless robust weighting reduced it).
    pub weight: f64,
    pub intercept_nm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
/// `condition_number` and `geometric_dilution_m_per_arcmin` are infinite for a singular
/// geometry; serde_json writes infinity as `null`, so JSON consumers must accept null there.
pub struct Conditioning {
    pub singular_values: Vec<f64>,
    pub condition_number: f64,
    pub rank: usize,
    /// `sqrt(trace((J^T J)^-1))`, metres of position per arcminute of altitude noise.
    pub geometric_dilution_m_per_arcmin: f64,
    /// Largest gap between consecutive sight azimuths, degrees (360 = all in one direction).
    pub max_azimuth_gap_deg: f64,
    /// Which Jacobian columns the singular values and rank above describe:
    /// `"position (north, east)"`, or `"position (north, east) and shared bias"` when a
    /// shared altitude bias is estimated. A shared bias is nearly collinear with position
    /// whenever the azimuth spread is poor, and this report includes that column so the
    /// condition number shows it.
    #[serde(default)]
    pub columns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PriorReport {
    pub center: LatLon,
    pub sigma_nm: f64,
    pub fix_without_prior: Option<LatLon>,
    pub shift_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RobustReport {
    pub huber_k: f64,
    pub downweighted_ids: Vec<String>,
    pub note: String,
}

// ---------------------------------------------------------------------------
// Warnings (section 12)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Warning {
    /// Apparent altitude below 10 deg; below 5 deg sigma was inflated.
    LowAltitudeRefraction {
        id: String,
        apparent_altitude_deg: f64,
        sigma_added_arcmin: f64,
    },
    DipNotApplicable {
        id: String,
        horizon: HorizonMode,
    },
    AlreadyCorrected {
        id: String,
        kind: AltitudeKind,
        ignored: Vec<CorrectionKind>,
    },
    LimbIgnoredForStar {
        id: String,
    },
    SuppliedDirectionUsed {
        id: String,
    },
    EphemerisCoverageLimited {
        provider: String,
        coverage: String,
    },
    PoorGeometry {
        condition_number: f64,
        max_azimuth_gap_deg: f64,
    },
    ClockDegenerateWithLongitude {
        sigma_east_m: f64,
    },
    PriorUsed {
        sigma_nm: f64,
        shift_m: f64,
    },
    RobustWeightsApplied {
        downweighted_ids: Vec<String>,
    },
    EllipseSuppressed {
        reason: String,
    },
    PosteriorScalingSkipped {
        dof: i64,
    },
    DuplicateObservation {
        ids: Vec<String>,
    },
    NotConverged {
        iterations: u32,
    },
    Other {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Simulation truth (kept out of the solver's reach by construction)
// ---------------------------------------------------------------------------

/// The `fixtures/expected/<name>.truth.json` shape. Only simulator/evaluation code reads it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Truth {
    pub schema: String,
    pub session_name: String,
    pub position: LatLon,
    pub seed: u64,
    #[serde(default)]
    pub clock_offset_s: f64,
    #[serde(default)]
    pub shared_altitude_bias_arcmin: f64,
    #[serde(default)]
    pub wrong_sight_ids: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_json_round_trip_with_defaults() {
        let json = r#"{
          "schema": "skyfix.session/1",
          "observations": [
            {"id": "a", "body": "Vega", "utc": "2026-10-01T01:30:00Z",
             "altitude_deg": 61.2, "altitude_kind": "sextant_hs",
             "geocentric": {"gha_deg": 123.4, "dec_deg": 38.8}}
          ]
        }"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.observer.pressure_hpa, 1010.0);
        assert_eq!(s.observer.temperature_c, 10.0);
        assert_eq!(s.instrument.horizon, HorizonMode::Sea);
        assert_eq!(s.observations[0].sigma_arcmin, 1.0);
        assert_eq!(s.observations[0].limb, Limb::Center);
        assert_eq!(
            s.observations[0].geocentric.unwrap().semidiameter_arcmin,
            0.0
        );
        let back = serde_json::to_string(&s).unwrap();
        let s2: Session = serde_json::from_str(&back).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn enums_serialise_snake_case_and_tagged() {
        let r = AssumedPositionRole::Prior { sigma_nm: 20.0 };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"role":"prior","sigma_nm":20.0}"#
        );
        let w = Warning::EllipseSuppressed {
            reason: "ambiguous".into(),
        };
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"code":"ellipse_suppressed","reason":"ambiguous"}"#
        );
        let f = FixResult::Failed {
            reason: "x".into(),
            warnings: vec![],
        };
        assert!(
            serde_json::to_string(&f)
                .unwrap()
                .starts_with(r#"{"kind":"failed""#)
        );
    }
}
