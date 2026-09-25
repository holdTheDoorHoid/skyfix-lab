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
    /// UT1 - UTC in seconds, from the time signal or IERS Bulletin A (CONVENTIONS 6 and
    /// 15.2). `None` (absent, or `null`) means "automatic": the engine's history or
    /// model through [`crate::time::dut1_s`]. Added by the expansion programme
    /// (moonshape agent); older files load unchanged, and a session without it is
    /// written without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dut1_s: Option<f64>,
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
    /// Computed at the assumed position (if any): CONVENTIONS section 3, plus
    /// `earth_shape_arcmin` for the Moon (section 15.4).
    pub hc_deg: Option<f64>,
    pub zn_deg: Option<f64>,
    /// `Ho - Hc` in nautical miles, positive toward the body.
    pub intercept_nm: Option<f64>,
    /// The complete list for this sight: a superset of `corrections.warnings`.
    pub warnings: Vec<Warning>,
    /// The direction's horizontal parallax, arcminutes (0 for a star): what the Moon's
    /// Earth-shape term needs wherever the model altitude is evaluated (CONVENTIONS
    /// 15.4). Added by the expansion programme.
    #[serde(default)]
    pub horizontal_parallax_arcmin: f64,
    /// The Moon's Earth-shape term included in `hc_deg`, arcminutes (CONVENTIONS 15.4):
    /// the WGS84 geometry at the assumed position minus the sphere's. `None` for every
    /// other body, without an assumed position, and for a Moon direction without a
    /// horizontal parallax. The correction chain (`corrections`, `ho_deg`) never
    /// includes it. Added by the expansion programme.
    #[serde(default)]
    pub earth_shape_arcmin: Option<f64>,
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
    /// The Moon's horizontal parallax, arcminutes, when this is a Moon sight whose
    /// direction carries one: the model altitude then includes the Earth-shape term at
    /// the trial position (CONVENTIONS 15.4, `sights::wgs84::EarthShape`). `None` for
    /// every other body. Set by `reduce::to_sights`.
    pub moon_hp_arcmin: Option<f64>,
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
    // --- navigation methods (docs/NAVIGATION_METHODS.md) -----------------------
    /// Noon sight: the longitude comes from the *time* of a flat-topped peak, so it is
    /// far weaker than the latitude. Emitted whenever a noon longitude is reported.
    FlatPeakLongitude {
        body: String,
        /// 1-sigma of the time of meridian passage, seconds (clock included).
        sigma_time_s: f64,
        /// 1-sigma of the longitude, arcminutes of longitude (clock included).
        sigma_lon_arcmin: f64,
        /// The same as an east-west distance, nautical miles.
        sigma_east_nm: f64,
    },
    /// Noon sight: the body crossed the meridian within 5 deg of the zenith, where its
    /// bearing swings fast, the altitude is hard to measure and north/south decides
    /// the latitude.
    MeridianNearZenith {
        body: String,
        meridian_altitude_deg: f64,
    },
    /// Noon sight: the DR latitude does not clearly decide whether the body passed
    /// north or south of the zenith; `other_latitude_deg` is the answer for the other side.
    MeridianSideAmbiguous {
        body: String,
        latitude_deg: f64,
        other_latitude_deg: f64,
    },
    /// A single altitude used as the meridian (maximum) altitude was taken far from the
    /// meridian passage the DR predicts.
    NotAtMeridianPassage {
        id: String,
        minutes_from_passage: f64,
    },
    /// Noon sight: every sight is on one side of meridian passage, so the time of the
    /// peak is extrapolated rather than bracketed.
    OneSidedRun {
        body: String,
        before: usize,
        after: usize,
    },
    /// Noon sight: the curvature fitted to the sights disagrees with the curvature the
    /// geometry predicts by more than 3 sigma.
    CurvatureInconsistent {
        body: String,
        predicted_arcmin_per_min2: f64,
        fitted_arcmin_per_min2: f64,
        z: f64,
    },
    /// Averaging: the free-slope fit disagrees with the slope the ephemeris predicts at
    /// the DR position by more than 3 sigma.
    SlopeInconsistent {
        body: String,
        predicted_arcmin_per_min: f64,
        fitted_arcmin_per_min: f64,
        z: f64,
    },
    /// A sight in a run whose normalised residual exceeds the outlier threshold.
    /// `rejected` says whether it was left out of the averaged answer.
    RunOutlier {
        id: String,
        normalized_residual: f64,
        rejected: bool,
    },
    /// Polaris latitude near the pole: Polaris is nearly overhead, its bearing is far
    /// from north, and the latitude depends strongly on the longitude.
    PolarisNearPole {
        id: String,
        latitude_deg: f64,
        azimuth_deg: f64,
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

// ---------------------------------------------------------------------------
// Navigation methods: noon sight, Polaris latitude, averaging a run of sights.
// docs/NAVIGATION_METHODS.md is normative; the computation is `crate::methods`.
// Wire shapes only. Every input reuses the session model above: the sights are a
// `Session`'s observations and go through the ordinary reduction (CONVENTIONS 4-5).
// ---------------------------------------------------------------------------

/// Constant course and speed over the ground while a method's sights were taken.
/// The run is a great circle through the method's reference position on this course.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct VesselMotion {
    /// Course over the ground, degrees true.
    pub course_deg: f64,
    /// Speed over the ground, knots.
    pub speed_kn: f64,
}

/// A dead-reckoning position and, when the navigator states it, its uncertainty.
/// Used to choose between answers, to predict, and to propagate uncertainty; never as
/// a prior on an answer (CONVENTIONS section 8).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct DrPosition {
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// 1-sigma error of the DR position, nautical miles, in each of north and east.
    /// `None` means "not stated", which is never silently replaced by a guess.
    #[serde(default)]
    pub sigma_nm: Option<f64>,
}

/// Which side of the zenith the body crosses the meridian, as the navigator states it.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BodyBearing {
    /// Decide from the DR latitude and the declination.
    #[default]
    Auto,
    /// The body was north of the zenith at meridian passage (you faced north).
    North,
    /// The body was south of the zenith at meridian passage (you faced south).
    South,
}

/// The side a result found. `Auto` never appears in output.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeridianSide {
    North,
    South,
}

/// How the noon curve's curvature is obtained.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoonCurvature {
    /// From the geometry (the exact altitude curve at the solved position). Default.
    #[default]
    Predicted,
    /// Fitted to the sights as a free parabola (needs three or more sights).
    Fitted,
}

/// What a single noon altitude means.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SingleAltitudeMode {
    /// The navigator recorded the peak: it is the meridian altitude. Default.
    #[default]
    Maximum,
    /// An altitude taken near noon at the recorded time, reduced to the meridian with
    /// the DR longitude (the ex-meridian method; the altitude equation solved exactly).
    ExMeridian,
}

/// Options for [`crate::methods::noon::noon_sight`]. Every field has a default, so `{}`
/// is a valid document.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NoonSightOptions {
    /// DR position for the middle of the run. Defaults to the session's assumed
    /// position (and its prior sigma, if its role is `prior`).
    pub dr: Option<DrPosition>,
    pub vessel: Option<VesselMotion>,
    pub body_bearing: BodyBearing,
    pub curvature: NoonCurvature,
    pub single_altitude: SingleAltitudeMode,
}

/// Which computation produced a noon answer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoonMethod {
    /// Two or more sights fitted with the exact altitude curve (curvature predicted).
    CurveFit,
    /// Three or more sights fitted with a free-curvature parabola.
    CurveFitFreeCurvature,
    /// Latitude only, reducing the sight(s) to the meridian with the DR longitude.
    ExMeridian,
    /// One altitude, recorded at the peak, used as the meridian altitude.
    MaximumAltitude,
}

/// A latitude and its 1-sigma, arcminutes (= nautical miles).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LatitudeEstimate {
    pub lat_deg: f64,
    pub sigma_arcmin: f64,
}

/// A longitude and its 1-sigma, both as arcminutes of longitude and as an east-west
/// distance. `sigma_arcmin` includes the clock term `clock_sigma_arcmin`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LongitudeEstimate {
    pub lon_deg: f64,
    pub sigma_arcmin: f64,
    pub sigma_nm: f64,
    /// The part of `sigma_arcmin` that is the session's clock uncertainty (CONVENTIONS 6).
    pub clock_sigma_arcmin: f64,
}

/// An instant and its 1-sigma, seconds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimeEstimate {
    pub utc: String,
    pub jd_utc: f64,
    pub sigma_s: f64,
}

/// The highest point of the fitted noon curve. It differs from meridian passage when
/// the declination changes or the vessel moves north or south.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurveMaximum {
    pub utc: String,
    pub jd_utc: f64,
    pub altitude_deg: f64,
    /// Positive when the peak comes after meridian passage.
    pub seconds_after_passage: f64,
}

/// The shape of the noon curve near meridian passage: `h ~ H0 + a t - k t^2`,
/// `t` in minutes from passage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurvatureReport {
    /// `k` from the geometry, arcminutes per minute squared.
    pub predicted_arcmin_per_min2: f64,
    /// `a`, the rate of the meridian altitude itself (declination change and the
    /// vessel's north-south motion), arcminutes per minute.
    pub rate_at_passage_arcmin_per_min: f64,
    /// `a^2 / (4 k)`: how much higher the peak is than the meridian altitude, arcminutes.
    pub max_minus_meridian_arcmin: f64,
    /// `k` fitted as a free parameter (three or more sights), with its 1-sigma.
    pub fitted_arcmin_per_min2: Option<f64>,
    pub fitted_sigma_arcmin_per_min2: Option<f64>,
    /// `(fitted - predicted) / sigma`.
    pub z: Option<f64>,
    /// `|z| <= 3`.
    pub consistent: Option<bool>,
}

/// The answers of the noon computation that was *not* chosen as primary, for comparison.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoonAlternative {
    pub method: NoonMethod,
    pub latitude: LatitudeEstimate,
    pub meridian_altitude_deg: f64,
    pub meridian_passage: Option<TimeEstimate>,
    pub longitude: Option<LongitudeEstimate>,
    pub chi2: f64,
    pub dof: i64,
}

/// The noon answer against the DR.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoonDrCheck {
    /// Meridian passage predicted from the DR longitude (moved with the vessel).
    pub predicted_passage_utc: String,
    pub predicted_passage_jd_utc: f64,
    /// 1-sigma of that prediction from the DR's stated uncertainty; `None` if unstated.
    pub predicted_passage_sigma_s: Option<f64>,
    /// Answer minus DR at the answer's instant, arcminutes of latitude (= NM).
    pub latitude_difference_arcmin: f64,
    /// Answer minus DR, arcminutes of longitude; `None` when no longitude was found.
    pub longitude_difference_arcmin: Option<f64>,
}

/// One sight of a run against the fitted model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunResidual {
    pub id: String,
    pub utc: String,
    pub jd_utc: f64,
    /// Minutes from the method's reference instant (noon: meridian passage;
    /// averaging: the chosen reference time).
    pub minutes: f64,
    pub ho_deg: f64,
    pub model_deg: f64,
    /// `Ho - model`, arcminutes.
    pub residual_arcmin: f64,
    /// `residual / sigma` (CONVENTIONS section 9).
    pub normalized: f64,
    /// Averaging only: the residual against the fit to the *other* sights, divided by
    /// its own standard deviation. This is the statistic the outlier test uses.
    pub normalized_loo: Option<f64>,
    pub used: bool,
    pub outlier: bool,
}

/// A point on a fitted curve, for plotting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CurvePoint {
    pub jd_utc: f64,
    pub minutes: f64,
    pub altitude_deg: f64,
}

/// Result of [`crate::methods::noon::noon_sight`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoonSightResult {
    pub body: String,
    pub method: NoonMethod,
    pub n_sights: usize,
    /// Which side of the zenith the body crossed the meridian.
    pub side: MeridianSide,
    pub latitude: LatitudeEstimate,
    /// Altitude of the body's centre at meridian passage (Ho), degrees.
    pub meridian_altitude_deg: f64,
    pub declination_deg: f64,
    pub zenith_distance_deg: f64,
    /// The rule applied, in words, with the numbers.
    pub latitude_rule: String,
    /// Measured time of meridian passage; `None` for the single-altitude and
    /// ex-meridian methods, which cannot time the peak.
    pub meridian_passage: Option<TimeEstimate>,
    pub longitude: Option<LongitudeEstimate>,
    /// Plain-language statement of how weak the longitude is (the flat peak), or why
    /// there is none.
    pub longitude_caveat: String,
    /// Ex-meridian only: arcminutes of latitude per nautical mile of east-west DR error.
    pub longitude_sensitivity_arcmin_per_nm: Option<f64>,
    pub maximum: Option<CurveMaximum>,
    pub curvature: CurvatureReport,
    pub alternative: Option<NoonAlternative>,
    pub dr_check: NoonDrCheck,
    pub chi2: f64,
    pub dof: i64,
    pub residuals: Vec<RunResidual>,
    pub model_curve: Vec<CurvePoint>,
    /// Every sight through the correction chain, with its workings.
    pub sights: Vec<ReducedSight>,
    pub warnings: Vec<Warning>,
}

/// Options for [`crate::methods::polaris::polaris_latitude`]. Every field defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PolarisOptions {
    /// DR position at the reference instant. Defaults to the session's assumed position.
    /// The longitude is required; its `sigma_nm` enters the latitude's sigma.
    pub dr: Option<DrPosition>,
    pub vessel: Option<VesselMotion>,
    /// The instant a combined latitude refers to, RFC 3339 UTC. Default: the last sight.
    pub reference_utc: Option<String>,
}

/// The Nautical Almanac's Polaris-table terms for one sight, unrounded, for teaching:
/// `Latitude = Ho - 1 deg + a0 + a1 + a2`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolarisAlmanacTerms {
    pub lha_aries_deg: f64,
    pub a0_arcmin: f64,
    pub a1_arcmin: f64,
    pub a2_arcmin: f64,
    /// `Ho - 1 deg + a0 + a1 + a2`, degrees.
    pub latitude_deg: f64,
    /// Rigorous latitude minus the table formula, arcminutes.
    pub difference_arcmin: f64,
    /// The latitude the a1 term was entered with (DR, else the rigorous answer).
    pub table_latitude_deg: f64,
    /// The year's mean position of Polaris the table is built on.
    pub mean_sha_deg: f64,
    pub mean_dec_deg: f64,
    /// The printed a1 table runs from 0 to 68 degrees north.
    pub within_printed_table: bool,
    pub note: String,
}

/// One Polaris sight, solved for latitude.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolarisSight {
    pub id: String,
    pub utc: String,
    pub jd_utc: f64,
    pub ho_deg: f64,
    pub gha_deg: f64,
    pub dec_deg: f64,
    /// DR longitude used for this sight (moved with the vessel), degrees.
    pub dr_lon_deg: f64,
    /// Local hour angle of Polaris, `[0, 360)`.
    pub lha_deg: f64,
    pub azimuth_deg: f64,
    /// Total 1-sigma: altitude, DR longitude and clock in quadrature.
    pub latitude: LatitudeEstimate,
    pub sigma_from_altitude_arcmin: f64,
    /// `None` when the DR's uncertainty was not stated.
    pub sigma_from_longitude_arcmin: Option<f64>,
    pub sigma_from_clock_arcmin: f64,
    /// Arcminutes of latitude per nautical mile of east-west DR error.
    pub longitude_sensitivity_arcmin_per_nm: f64,
    /// `latitude - Ho`, arcminutes: the whole Polaris correction.
    pub correction_arcmin: f64,
    /// Against the combined latitude, when there are several sights.
    pub normalized_residual: Option<f64>,
    pub almanac: Option<PolarisAlmanacTerms>,
}

/// Result of [`crate::methods::polaris::polaris_latitude`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolarisResult {
    /// The latitude at `reference_utc`: the one sight's, or all of them combined.
    pub latitude: LatitudeEstimate,
    pub reference_utc: String,
    pub reference_jd_utc: f64,
    pub polaris: Vec<PolarisSight>,
    /// Scatter of the individual latitudes about the combined one (several sights).
    pub chi2: Option<f64>,
    pub dof: i64,
    pub sights: Vec<ReducedSight>,
    pub warnings: Vec<Warning>,
}

/// Options for [`crate::methods::averaging::average_sights`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AveragingOptions {
    /// The instant of the averaged sight, RFC 3339 UTC (already corrected, like every
    /// time in a result). Default: the weighted mean time of the sights used.
    pub reference_utc: Option<String>,
    /// DR position for the middle of the run; the predicted slope is computed there.
    /// Defaults to the session's assumed position.
    pub dr: Option<DrPosition>,
    pub vessel: Option<VesselMotion>,
    /// Leave sights whose normalised residual exceeds `outlier_threshold` out of the
    /// average (default true). They are always flagged either way.
    pub reject_outliers: bool,
    pub outlier_threshold: f64,
}

impl Default for AveragingOptions {
    fn default() -> Self {
        AveragingOptions {
            reference_utc: None,
            dr: None,
            vessel: None,
            reject_outliers: true,
            outlier_threshold: 3.0,
        }
    }
}

/// The free-slope line through a run (four or more sights), for comparison with the
/// predicted slope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FreeSlopeFit {
    pub slope_arcmin_per_min: f64,
    pub slope_sigma_arcmin_per_min: f64,
    /// The averaged altitude this line gives at the reference instant.
    pub ho_deg: f64,
    pub sigma_arcmin: f64,
    /// `(fitted - predicted) / sigma`, with the predicted slope's own sigma included.
    pub z: f64,
    /// `|z| <= 3`.
    pub consistent: bool,
    pub chi2: f64,
    pub dof: i64,
}

/// Result of [`crate::methods::averaging::average_sights`]: one averaged sight.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AveragedSight {
    pub body: String,
    pub utc: String,
    pub jd_utc: f64,
    /// Averaged observed altitude (fully corrected), degrees.
    pub ho_deg: f64,
    pub sigma_arcmin: f64,
    pub n_used: usize,
    pub n_total: usize,
    /// Rate of change of the altitude predicted at the DR position, at the reference
    /// instant, arcminutes per minute.
    pub predicted_slope_arcmin_per_min: f64,
    /// Its 1-sigma from the DR's stated uncertainty; `None` when unstated.
    pub predicted_slope_sigma_arcmin_per_min: Option<f64>,
    /// Second derivative of the predicted altitude at the reference instant,
    /// arcminutes per minute squared (tiny over a few minutes; included in the model).
    pub predicted_curvature_arcmin_per_min2: f64,
    pub chi2: f64,
    pub dof: i64,
    pub free_slope: Option<FreeSlopeFit>,
    pub outliers: Vec<String>,
    pub residuals: Vec<RunResidual>,
    pub model_curve: Vec<CurvePoint>,
    /// The averaged sight as a session observation (`observed_ho`), ready for a fix.
    pub observation: Observation,
    pub sights: Vec<ReducedSight>,
    pub warnings: Vec<Warning>,
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

// ---------------------------------------------------------------------------
// Moon and planet sights: predicted sextant readings, lunar distances and the
// twilight sight plan (navigation-Moon agent, wave 2; docs/NAVIGATION_SKY.md).
// Wire formats: docs/EXPLORER_API.md, "Wave 2 — Moon and planet sights".
// ---------------------------------------------------------------------------

/// A navigator's position and what the correction chain needs to know about the eye
/// and the air (CONVENTIONS section 5). Longitude east-positive.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct SightObserver {
    pub lat_deg: f64,
    pub lon_deg: f64,
    #[serde(default)]
    pub height_of_eye_m: f64,
    #[serde(default = "default_pressure_hpa")]
    pub pressure_hpa: f64,
    #[serde(default = "default_temperature_c")]
    pub temperature_c: f64,
}

/// What a sextant would read for one body from one place at one instant: the
/// correction chain run in reverse from the computed altitude (CONVENTIONS sections 3
/// and 5). Reducing `hs_deg` with the same observer and instrument gives back `hc_deg`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PredictedSight {
    pub body: String,
    pub jd_utc: f64,
    pub utc: String,
    pub limb: Limb,
    pub horizon: HorizonMode,
    /// `"supplied"` or the provider that gave the direction.
    pub direction_source: String,
    pub gha_deg: f64,
    pub dec_deg: f64,
    pub semidiameter_arcmin: f64,
    pub horizontal_parallax_arcmin: f64,
    /// Computed altitude and true azimuth at the observer (section 3; for the Moon the
    /// altitude includes `earth_shape_arcmin`, section 15.4).
    pub hc_deg: f64,
    pub zn_deg: f64,
    /// The sextant reading: the double angle with a reflected artificial horizon.
    pub hs_deg: f64,
    /// Apparent altitude after index correction and dip (or halving).
    pub ha_deg: f64,
    /// The forward chain from `hs_deg`: every correction, landing on `hc_deg`.
    pub corrections: CorrectionBreakdown,
    pub warnings: Vec<Warning>,
    /// The Moon's Earth-shape term included in `hc_deg`, arcminutes (CONVENTIONS 15.4);
    /// 0 for every other body. Added by the expansion programme.
    #[serde(default)]
    pub earth_shape_arcmin: f64,
}

/// Which edge of a disc a lunar distance was measured to.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LunarLimb {
    /// The edge nearest the other body (the usual choice: the Moon's bright limb when
    /// it faces the body, the Sun's near limb).
    #[default]
    Near,
    /// The edge farthest from the other body.
    Far,
    /// The centre: a star, or a planet's centre of light.
    Center,
}

/// An altitude observed at the moment of a lunar distance.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LunarAltitudeObservation {
    pub altitude_deg: f64,
    /// `sextant_hs` (default) or `apparent_ha`.
    #[serde(default)]
    pub altitude_kind: AltitudeKind,
    /// Lower, upper or centre (default centre).
    #[serde(default)]
    pub limb: Limb,
    /// 1-sigma of the altitude, arcminutes (default 1').
    #[serde(default = "default_sigma_arcmin")]
    pub sigma_arcmin: f64,
}

/// A lunar distance to clear (CONVENTIONS section 5 and docs/NAVIGATION_SKY.md).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunarDistanceInput {
    /// Dead-reckoning position, height of eye, pressure and temperature.
    pub observer: SightObserver,
    /// Index correction (applied to the distance and to any altitude) and the horizon
    /// the altitudes were taken to.
    #[serde(default)]
    pub instrument: Instrument,
    /// The Sun, a navigational star or planet. Not the Moon.
    pub body: String,
    /// The watch's UTC for the moment of the distance (RFC 3339 `Z`); the search is
    /// centred on it.
    pub utc_estimate: String,
    /// The sextant reading of the distance, degrees (the index correction is added).
    pub distance_deg: f64,
    /// Which limb of the Moon (default `near`).
    #[serde(default)]
    pub moon_limb: LunarLimb,
    /// Which limb of the body: default `near` for the Sun, `center` otherwise.
    #[serde(default)]
    pub body_limb: Option<LunarLimb>,
    /// Observed altitudes. When absent, they are computed from the DR position at every
    /// trial instant.
    #[serde(default)]
    pub moon_altitude: Option<LunarAltitudeObservation>,
    #[serde(default)]
    pub body_altitude: Option<LunarAltitudeObservation>,
    /// 1-sigma of the distance measurement, arcminutes (default 0.2').
    #[serde(default = "default_lunar_sigma_arcmin")]
    pub sigma_arcmin: f64,
    /// Half-width of the search window around `utc_estimate`, hours (default 12).
    #[serde(default = "default_lunar_search_hours")]
    pub search_hours: f64,
    /// 1-sigma of the DR position, nautical miles (default 0: reported, not added).
    #[serde(default)]
    pub dr_uncertainty_nm: f64,
}

fn default_lunar_sigma_arcmin() -> f64 {
    0.2
}
fn default_lunar_search_hours() -> f64 {
    12.0
}

/// One step of clearing the distance, in the order it is applied.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunarClearingStep {
    /// `index_correction`, `moon_semidiameter`, `body_semidiameter`, `refraction`,
    /// `parallax`.
    pub kind: String,
    pub before_deg: f64,
    pub after_deg: f64,
    pub delta_arcmin: f64,
    pub note: String,
}

/// The altitudes the clearing used, at the instant found.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunarAltitudes {
    /// `"observed"` or `"computed"` (from the DR position), per body.
    pub moon_source: String,
    pub body_source: String,
    /// Apparent (refracted) altitude of each centre, degrees.
    pub moon_apparent_deg: f64,
    pub body_apparent_deg: f64,
    /// Airless topocentric altitude of each centre, degrees.
    pub moon_true_deg: f64,
    pub body_true_deg: f64,
    /// Azimuths from the DR position, degrees.
    pub moon_azimuth_deg: f64,
    pub body_azimuth_deg: f64,
    /// Altitudes computed from the DR position at the instant found, for comparison
    /// with observed ones (apparent, degrees).
    pub moon_computed_apparent_deg: f64,
    pub body_computed_apparent_deg: f64,
}

/// One term of the time's error budget.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunarErrorTerm {
    pub name: String,
    /// 1-sigma, arcminutes of distance.
    pub distance_arcmin: f64,
    /// The same in seconds of time.
    pub time_s: f64,
}

/// Another instant in the window at which the distance takes the same value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunarAlternative {
    pub jd_utc: f64,
    pub utc: String,
}

/// The UTC a lunar distance gives, with its honest uncertainty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunarDistanceResult {
    pub body: String,
    /// The instant at which the cleared distance equals the geocentric distance.
    pub jd_utc: f64,
    pub utc: String,
    /// Found UTC minus the watch's estimate, seconds: the correction to add to the watch.
    pub utc_minus_estimate_s: f64,
    /// 1-sigma of the UTC, seconds.
    pub sigma_s: f64,
    /// Longitude uncertainty that time uncertainty implies, arcminutes of longitude
    /// (15' per minute of time) and nautical miles at the DR latitude.
    pub longitude_sigma_arcmin: f64,
    pub longitude_sigma_nm: f64,
    /// The measured distance with the index correction and the semidiameters applied:
    /// apparent distance between the centres, degrees.
    pub apparent_distance_deg: f64,
    /// The cleared (geocentric) distance, degrees.
    pub cleared_distance_deg: f64,
    /// How fast the geocentric distance changes there, arcminutes per minute of time.
    pub distance_rate_arcmin_per_min: f64,
    pub clearing: Vec<LunarClearingStep>,
    pub altitudes: LunarAltitudes,
    /// 1-sigma terms combined in quadrature into `sigma_s`.
    pub error_budget: Vec<LunarErrorTerm>,
    /// How much the cleared distance moves per 10 NM of DR error north and east,
    /// arcminutes (the DR enters through the altitudes and azimuths).
    pub dr_sensitivity_arcmin_per_10nm: [f64; 2],
    pub alternatives: Vec<LunarAlternative>,
    pub warnings: Vec<Warning>,
    pub notes: Vec<String>,
}

/// One body recommended for a twilight round of sights, with what the sextant will read
/// at the start of the twilight window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecommendedSight {
    pub body: String,
    /// `"moon"`, `"planet"` or `"star"`.
    pub kind: String,
    /// Apparent visual magnitude, when modelled.
    pub magnitude: Option<f64>,
    /// 1-based position in the planner's shooting order.
    pub step: usize,
    /// The limb to observe: the Moon's lit one; `center` for a planet or star.
    pub limb: Limb,
    /// Computed altitude and true azimuth at the window's start (CONVENTIONS section 3).
    pub hc_deg: f64,
    pub zn_deg: f64,
    /// The predicted sextant reading at the window's start.
    pub hs_deg: f64,
    /// Why the planner chose it (its geometry), from `skyfix_core::planner`.
    pub rationale: String,
    /// The full prediction: direction, every correction, warnings.
    pub prediction: PredictedSight,
}

/// One nautical twilight: the Sun's centre between -6 and -12 degrees (CONVENTIONS
/// 13.3-13.4), evening or morning, and the sights recommended for it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TwilightPlan {
    /// `"evening"` (Sun going down from -6 to -12 degrees) or `"morning"` (up from -12
    /// to -6 degrees).
    pub kind: String,
    pub jd_start: f64,
    pub utc_start: String,
    pub jd_end: f64,
    pub utc_end: String,
    /// The instant the predictions refer to: the window's start, or the search window's
    /// start when the twilight had already begun.
    pub jd_predicted: f64,
    pub utc_predicted: String,
    /// The Sun's topocentric geometric altitude at `jd_predicted`, degrees.
    pub sun_altitude_deg: f64,
    /// Bodies fainter than this were not offered (see `notes`).
    pub limiting_magnitude: f64,
    pub sights: Vec<RecommendedSight>,
    /// Bodies bright enough and high enough that were not chosen, for a navigator who
    /// wants more sights or a substitute.
    pub also_eligible: Vec<String>,
    /// The planner's ranking of the chosen bodies: shooting order, predicted fix
    /// quality, disclosures.
    pub plan: crate::planner::Plan,
    pub notes: Vec<String>,
}

/// The twilight sight plan for a place and a span of time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SightPlan {
    pub observer: SightObserver,
    pub jd_start: f64,
    pub utc_start: String,
    pub jd_end: f64,
    pub utc_end: String,
    /// The next evening and the next morning nautical twilight in the window, in time
    /// order (none when the Sun does not pass through -6 to -12 degrees).
    pub windows: Vec<TwilightPlan>,
    pub notes: Vec<String>,
}
