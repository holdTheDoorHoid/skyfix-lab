//! Observation planner: rank visible bodies by the improvement they bring to the
//! conditioning of a fix, not by brightness or by evenly spaced azimuths.
//!
//! OWNER: planner agent (phase 2). Requires an approximate position, which every report
//! discloses. Visibility is geometric only.
//!
//! # What is being optimised
//!
//! A sight of a body at azimuth `Zn` with altitude standard deviation `sigma` contributes
//! one row to the tangent-plane Jacobian (CONVENTIONS section 3):
//!
//! ```text
//! dh = cos(Zn) dN + sin(Zn) dE        row = [cos Zn, sin Zn]
//! ```
//!
//! Weighting the row by `1 / sigma` and stacking the sights gives the a-priori position
//! information matrix and its covariance (CONVENTIONS section 9):
//!
//! ```text
//! M = J^T W J = sum_i [cos Zn_i, sin Zn_i]^T [cos Zn_i, sin Zn_i] / sigma_i^2
//! Cov = M^-1                          (2 x 2, north/east)
//! ```
//!
//! Everything in this module works in **metres**: `sigma_arcmin` is converted with the
//! project's exact identity `1 arcminute of arc = 1 NM = 1852 m`
//! ([`crate::units::NM_M`]), so `M` is in `m^-2` and `Cov` in `m^2` with no further
//! scaling. The information matrix depends only on the **azimuths and the sigmas** — not
//! on the residuals, not on the altitudes except through `sigma` — which is exactly why a
//! plan can be made before any sight is taken.
//!
//! The planner is a greedy forward selection over that matrix. It is not a proof of
//! optimality: greedy A-optimal selection is a heuristic, and the returned `score` is the
//! improvement measured **at the step the body was chosen**, not its marginal value in
//! the finished set.
//!
//! # Why brightness is not the criterion
//!
//! A very bright body adds nothing if its azimuth duplicates one you already have: the
//! second row is parallel to the first, the information matrix stays rank 1 in practice,
//! and the position stays undetermined along the perpendicular. Conversely a fourth-
//! magnitude star in the one open direction can halve the error ellipse. Brightness
//! enters this module only through [`Candidate::magnitude`], which is reported and used
//! as a display note — never as a term in the objective.

use crate::corrections::{
    LOW_ALTITUDE_FLAG_THRESHOLD_DEG, LOW_ALTITUDE_SIGMA_ARCMIN, LOW_ALTITUDE_SIGMA_THRESHOLD_DEG,
};
use crate::geometry::tangent_row;
use crate::linalg;
use crate::types::{Conditioning, LatLon};
use crate::uncertainty;
use crate::units::{NM_M, norm_360};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default number of bodies a plan selects.
pub const DEFAULT_SELECT: usize = 5;
/// Default lower altitude bound for a candidate, degrees.
pub const DEFAULT_MIN_ALTITUDE_DEG: f64 = 15.0;
/// Default upper altitude bound for a candidate, degrees.
pub const DEFAULT_MAX_ALTITUDE_DEG: f64 = 75.0;
/// Default per-sight altitude standard deviation before any altitude inflation, arcmin.
pub const DEFAULT_BASE_SIGMA_ARCMIN: f64 = 1.0;

/// Extra standard deviation added **in quadrature** for an altitude in
/// `[LOW_ALTITUDE_SIGMA_THRESHOLD_DEG, LOW_ALTITUDE_FLAG_THRESHOLD_DEG)`, arcminutes.
///
/// CONVENTIONS section 5 only *flags* the 5-10 degree band; it inflates sigma below
/// 5 degrees. This module adds a gentle 0.3' there as well, for one reason: between 5 and
/// 10 degrees the refraction is still 5 to 10 arcminutes and its dependence on the
/// real temperature profile is already several percent, so a sight there is genuinely
/// worse than the same sight at 40 degrees. The term is small enough that it never
/// outranks geometry — 0.3' in quadrature on a 1.0' sight is 1.04', a 4 % penalty — but
/// it does break the tie between two otherwise identical bodies in favour of the higher
/// one. It is a *planning* term and is deliberately **not** applied by
/// [`crate::corrections`]: it must never silently change a reduced sight's weight.
pub const MODERATE_ALTITUDE_SIGMA_ARCMIN: f64 = 0.3;

/// Standard deviation, in metres, of the notional isotropic prior used as a ridge when
/// the information matrix cannot be inverted (fewer than two independent sights).
///
/// `1e8 m` is about 16 Earth radii: it carries no navigational information at all. It
/// exists purely so that a rank-deficient matrix still has a finite determinant and the
/// selection can proceed. Whenever it is used, the plan says so in its notes and the
/// affected step's score switches to the log-determinant growth (see
/// [`ScoreBasis::LogDetGrowth`]).
pub const RIDGE_SIGMA_M: f64 = 1.0e8;

/// The ridge added to the diagonal of the information matrix, `m^-2`.
pub const RIDGE: f64 = 1.0 / (RIDGE_SIGMA_M * RIDGE_SIGMA_M);

/// An information matrix whose eigenvalue ratio is below this is called "balanced":
/// there is no single weak axis worth naming.
pub const BALANCED_INFORMATION_RATIO: f64 = 1.5;

/// Alignment within this many degrees of the weak axis counts as "adds constraint there".
pub const ALIGNED_DEG: f64 = 30.0;

/// Alignment beyond this many degrees from the weak axis counts as "mostly sharpens
/// what is already known".
pub const MISALIGNED_DEG: f64 = 60.0;

/// Relative tolerance for calling two greedy scores a tie (then altitude decides).
const TIE_REL: f64 = 1e-12;

/// Disclosure required on every plan: the visibility model.
pub const NOTE_GEOMETRIC_VISIBILITY: &str =
    "geometric visibility only: no weather, no twilight model beyond the Sun-altitude flag";

/// Disclosure required on every plan: brightness is not the criterion.
pub const NOTE_BRIGHTNESS_SECONDARY: &str = "brightness is secondary to geometry in this ranking";

/// Disclosure required on every plan: the approximate position the ranking rests on.
pub fn note_approximate_position(p: &LatLon) -> String {
    format!(
        "approximate position supplied: {:.4}, {:.4}: ranking is only as good as it",
        p.lat_deg, p.lon_deg
    )
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// A body that could be shot, with everything the ranking needs.
///
/// `sigma_arcmin` is the **expected** standard deviation of the altitude measurement,
/// i.e. the instrument sigma already put through [`expected_sigma_arcmin`]. The planner
/// does not inflate it a second time; it only reports when the value it was given is
/// above the base.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
    pub body: String,
    pub altitude_deg: f64,
    /// True azimuth `Zn`, degrees clockwise from north, `[0, 360)`.
    pub azimuth_deg: f64,
    pub sigma_arcmin: f64,
    /// Visual magnitude when the body is a catalogue star. Display only.
    #[serde(default)]
    pub magnitude: Option<f64>,
    /// Free text carried through to the plan, e.g. the twilight flag.
    #[serde(default)]
    pub note: String,
}

impl Candidate {
    /// A candidate with no magnitude and no note.
    pub fn new(body: &str, altitude_deg: f64, azimuth_deg: f64, sigma_arcmin: f64) -> Self {
        Candidate {
            body: body.to_string(),
            altitude_deg,
            azimuth_deg,
            sigma_arcmin,
            magnitude: None,
            note: String::new(),
        }
    }

    /// `true` when every number is finite, the sigma positive and the angles in range.
    pub fn is_usable(&self) -> bool {
        self.altitude_deg.is_finite()
            && self.azimuth_deg.is_finite()
            && self.sigma_arcmin.is_finite()
            && self.sigma_arcmin > 0.0
            && self.altitude_deg >= -90.0
            && self.altitude_deg <= 90.0
    }

    /// Weighted Jacobian row `[cos Zn, sin Zn] / sigma_m`, metres^-1.
    fn weighted_row(&self) -> Option<Vec<f64>> {
        if !self.is_usable() {
            return None;
        }
        let (n, e) = tangent_row(self.azimuth_deg.to_radians());
        let sigma_m = self.sigma_arcmin * NM_M;
        Some(vec![n / sigma_m, e / sigma_m])
    }
}

/// What the greedy selection minimises. `Cov = (J^T W J)^-1` throughout, north/east,
/// in square metres.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Objective {
    /// **A-optimal.** Minimise `trace(Cov) = sigma_north^2 + sigma_east^2`, reported as
    /// its square root so the cost is in metres. This is the average variance over all
    /// directions: it makes the fix small *on the whole* and is the right default,
    /// because a navigator asks "how big is my error" before asking "in which
    /// direction". It will happily accept a slightly elongated ellipse if that buys a
    /// large reduction in overall size, which is why a body that merely repeats an
    /// existing azimuth can still be picked late in a plan once the geometry is already
    /// closed.
    #[default]
    MinTrace,
    /// **E-optimal.** Minimise the largest eigenvalue of `Cov`, reported as its square
    /// root: the 1-sigma semi-major axis of the error ellipse, in metres. This is the
    /// pessimist's objective — it improves the *worst* direction and nothing else — so it
    /// drives hard toward an isotropic ellipse and will reject a body that shrinks the
    /// already-good axis. Choose it when a single direction matters (closing a coast,
    /// running a line of soundings) or when you distrust the weakest axis of the fix.
    MinMaxEigenvalue,
    /// Minimise the condition number of `W^(1/2) J`, which is the same thing as the
    /// **aspect ratio of the error ellipse**: `semi_major / semi_minor`, dimensionless
    /// and never below 1. (CONVENTIONS section 9 defines the reported condition number on
    /// the Jacobian, so its square is the eigenvalue ratio of `Cov`; this objective uses
    /// the Jacobian convention so that its cost and
    /// [`PlanMetrics::condition_number`] are the same number.) This optimises the *shape*
    /// of the ellipse and is blind to its size — three weak sights at 120 degrees score
    /// better than two excellent sights 80 degrees apart. Use it to diagnose or repair
    /// geometry, not to minimise error: it is the only objective here whose cost is not
    /// in metres, and a plan built on it can end with a larger ellipse than one built on
    /// [`Objective::MinTrace`].
    MinConditionNumber,
}

impl Objective {
    /// Human-readable one-liner used in the plan notes.
    pub fn description(&self) -> &'static str {
        match self {
            Objective::MinTrace => {
                "objective min_trace (A-optimal): minimise sqrt(trace of the position \
                 covariance), i.e. the overall size of the fix, in metres"
            }
            Objective::MinMaxEigenvalue => {
                "objective min_max_eigenvalue (E-optimal): minimise the 1-sigma \
                 semi-major axis, i.e. the worst direction of the fix, in metres"
            }
            Objective::MinConditionNumber => {
                "objective min_condition_number: minimise the aspect ratio of the error \
                 ellipse (shape only; it does not minimise the size)"
            }
        }
    }

    /// Units of `PlannedBody::score` when the step was scored on this objective.
    pub fn score_units(&self) -> &'static str {
        match self {
            Objective::MinTrace => "metres (reduction in sqrt(trace of position covariance))",
            Objective::MinMaxEigenvalue => "metres (reduction in the 1-sigma semi-major axis)",
            Objective::MinConditionNumber => {
                "dimensionless (reduction in the error ellipse's aspect ratio)"
            }
        }
    }
}

/// Knobs for [`rank`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanOptions {
    /// How many bodies to select. Default [`DEFAULT_SELECT`].
    #[serde(default = "default_select")]
    pub select: usize,
    /// Candidates below this altitude are excluded. Default [`DEFAULT_MIN_ALTITUDE_DEG`].
    #[serde(default = "default_min_altitude_deg")]
    pub min_altitude_deg: f64,
    /// Candidates above this altitude are excluded. Default [`DEFAULT_MAX_ALTITUDE_DEG`].
    #[serde(default = "default_max_altitude_deg")]
    pub max_altitude_deg: f64,
    /// Sights that already exist. They set the starting geometry and are never re-picked,
    /// and the altitude window is **not** applied to them: they are facts, not choices.
    #[serde(default)]
    pub already_taken: Vec<Candidate>,
    #[serde(default)]
    pub objective: Objective,
    /// Instrument sigma before altitude inflation, used by the ephemeris helper that
    /// builds candidates. Default [`DEFAULT_BASE_SIGMA_ARCMIN`].
    #[serde(default = "default_base_sigma_arcmin")]
    pub base_sigma_arcmin: f64,
}

fn default_select() -> usize {
    DEFAULT_SELECT
}
fn default_min_altitude_deg() -> f64 {
    DEFAULT_MIN_ALTITUDE_DEG
}
fn default_max_altitude_deg() -> f64 {
    DEFAULT_MAX_ALTITUDE_DEG
}
fn default_base_sigma_arcmin() -> f64 {
    DEFAULT_BASE_SIGMA_ARCMIN
}

impl Default for PlanOptions {
    fn default() -> Self {
        PlanOptions {
            select: DEFAULT_SELECT,
            min_altitude_deg: DEFAULT_MIN_ALTITUDE_DEG,
            max_altitude_deg: DEFAULT_MAX_ALTITUDE_DEG,
            already_taken: Vec::new(),
            objective: Objective::default(),
            base_sigma_arcmin: DEFAULT_BASE_SIGMA_ARCMIN,
        }
    }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/// Which quantity a step's `score` is the growth of.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScoreBasis {
    /// The geometry before the step was already rank 2: the score is the reduction in
    /// the objective's cost, in the objective's own units.
    #[default]
    Objective,
    /// The geometry before the step was rank-deficient, so the covariance did not exist.
    /// The score is instead the growth of `ln det(J^T W J + ridge I)`, in nats. Larger is
    /// better in both cases, but the two are not comparable with each other.
    LogDetGrowth,
}

impl ScoreBasis {
    pub fn units(&self, objective: Objective) -> String {
        match self {
            ScoreBasis::Objective => objective.score_units().to_string(),
            ScoreBasis::LogDetGrowth => {
                "nats (growth in ln det of the information matrix; the covariance was \
                 still singular at this step)"
                    .to_string()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlannedBody {
    pub body: String,
    pub altitude_deg: f64,
    pub azimuth_deg: f64,
    pub score: f64,
    pub rationale: String,
    /// 1-based position in the shooting order.
    #[serde(default)]
    pub step: usize,
    /// What `score` measures and in what units.
    #[serde(default = "default_score_units")]
    pub score_units: String,
    #[serde(default)]
    pub score_basis: ScoreBasis,
    #[serde(default = "default_base_sigma_arcmin")]
    pub sigma_arcmin: f64,
    #[serde(default)]
    pub magnitude: Option<f64>,
}

fn default_score_units() -> String {
    Objective::MinTrace.score_units().to_string()
}

/// A candidate that never entered the selection, and why.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExcludedBody {
    pub body: String,
    pub altitude_deg: f64,
    pub azimuth_deg: f64,
    pub reason: String,
}

/// Predicted quality of a set of sights, from geometry and sigmas alone.
///
/// Every field is a *prediction* from the a-priori covariance (CONVENTIONS section 9).
/// No observation has been made, so none of it can be checked against residuals.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanMetrics {
    /// How many sights this describes.
    pub sight_count: usize,
    /// `sqrt(Cov[0][0])`, metres. `None` when the geometry is rank-deficient.
    pub sigma_north_m: Option<f64>,
    /// `sqrt(Cov[1][1])`, metres. `None` when the geometry is rank-deficient.
    pub sigma_east_m: Option<f64>,
    /// `sqrt(trace(Cov))`, metres: the overall size of the fix, the `min_trace` cost.
    pub trace_sigma_m: Option<f64>,
    /// `sqrt(max eigenvalue of Cov)`, metres: the 1-sigma semi-major axis.
    pub semi_major_sigma_m: Option<f64>,
    /// `sqrt(min eigenvalue of Cov)`, metres: the 1-sigma semi-minor axis.
    pub semi_minor_sigma_m: Option<f64>,
    /// Azimuth of the semi-major axis, degrees clockwise from north, `[0, 180)`.
    pub semi_major_azimuth_deg: Option<f64>,
    /// Geometry-only dilution: metres of position per arcminute of altitude noise.
    /// 1852 m is the ideal (CONVENTIONS section 9). `None` when rank-deficient.
    pub geometric_dilution_m_per_arcmin: Option<f64>,
    /// Condition number of `W^(1/2) J` — **not** of the covariance, whose axis ratio is
    /// this number squared (CONVENTIONS section 9). `None` when rank-deficient.
    ///
    /// Both this and the dilution are `Option` rather than `f64::INFINITY` on purpose:
    /// `serde_json` writes a non-finite float as `null` and then refuses to read it back,
    /// so an infinity here would make a rank-deficient plan fail to round-trip.
    pub condition_number: Option<f64>,
    pub rank: usize,
    pub max_azimuth_gap_deg: f64,
    /// `true` when the covariance does not exist: fewer than two independent azimuths.
    pub singular: bool,
}

impl PlanMetrics {
    fn empty() -> Self {
        PlanMetrics {
            sight_count: 0,
            sigma_north_m: None,
            sigma_east_m: None,
            trace_sigma_m: None,
            semi_major_sigma_m: None,
            semi_minor_sigma_m: None,
            semi_major_azimuth_deg: None,
            geometric_dilution_m_per_arcmin: None,
            condition_number: None,
            rank: 0,
            max_azimuth_gap_deg: 360.0,
            singular: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Plan {
    pub approximate_position: LatLon,
    pub utc: String,
    pub bodies: Vec<PlannedBody>,
    pub notes: Vec<String>,
    #[serde(default)]
    pub objective: Objective,
    /// What the `already_taken` set alone predicts. The gain is `baseline` -> `predicted`.
    pub baseline: PlanMetrics,
    /// What `already_taken` plus every selected body predicts.
    pub predicted: PlanMetrics,
    /// `progression[0]` is [`Plan::baseline`]; `progression[k]` is the state after the
    /// `k`-th selected body. Monotone non-increasing in the chosen objective's cost.
    #[serde(default)]
    pub progression: Vec<PlanMetrics>,
    #[serde(default)]
    pub excluded: Vec<ExcludedBody>,
}

// ---------------------------------------------------------------------------
// Expected sigma
// ---------------------------------------------------------------------------

/// Expected altitude standard deviation of a sight taken at `altitude_deg`, arcminutes.
///
/// CONVENTIONS section 5 plus one planning-only term:
///
/// ```text
/// altitude < 5 deg        sigma^2 = base^2 + 1.0'^2     (section 5, the reducer applies this too)
/// 5 <= altitude < 10 deg  sigma^2 = base^2 + 0.3'^2     (planner only, MODERATE_ALTITUDE_SIGMA_ARCMIN)
/// altitude >= 10 deg      sigma   = base
/// ```
///
/// The two terms are never both applied. Non-finite input, or a base sigma that is not
/// strictly positive, yields `NaN`: [`rank`] excludes such candidates by name rather than
/// silently weighting them.
pub fn expected_sigma_arcmin(base_sigma_arcmin: f64, altitude_deg: f64) -> f64 {
    if !base_sigma_arcmin.is_finite() || base_sigma_arcmin <= 0.0 || !altitude_deg.is_finite() {
        return f64::NAN;
    }
    let extra = if altitude_deg < LOW_ALTITUDE_SIGMA_THRESHOLD_DEG {
        LOW_ALTITUDE_SIGMA_ARCMIN
    } else if altitude_deg < LOW_ALTITUDE_FLAG_THRESHOLD_DEG {
        MODERATE_ALTITUDE_SIGMA_ARCMIN
    } else {
        0.0
    };
    (base_sigma_arcmin * base_sigma_arcmin + extra * extra).sqrt()
}

// ---------------------------------------------------------------------------
// Information-matrix helpers
// ---------------------------------------------------------------------------

/// The 2x2 position information matrix `J^T W J` (`m^-2`) with its trace and determinant.
///
/// The determinant is **not** formed as `M00 M11 - M01^2`. For a set of sights whose
/// azimuths are close together — precisely the case a planner is asked about — that
/// expression is a difference of two nearly equal numbers and loses most of its
/// significant digits; for a single sight it should be exactly zero and instead comes out
/// as rounding noise of the order of `1e-16 * trace^2`, which is then large enough to
/// decide a comparison between two candidates that ought to tie.
///
/// Cauchy-Binet gives the determinant as a sum of squares instead, which has no
/// cancellation at all:
///
/// ```text
/// det(sum_i r_i r_i^T) = sum_{i < j} (r_i[0] r_j[1] - r_i[1] r_j[0])^2
/// ```
///
/// A single row therefore yields exactly `0`, two parallel rows yield exactly `0`, and
/// two candidates that differ only by a 180-degree azimuth flip tie exactly — which is
/// what makes the greedy selection deterministic.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Info {
    m: [[f64; 2]; 2],
    trace: f64,
    det: f64,
}

impl Info {
    fn of(rows: &[Vec<f64>]) -> Info {
        let mut m = [[0.0f64; 2]; 2];
        for r in rows {
            if r.len() != 2 {
                continue;
            }
            m[0][0] += r[0] * r[0];
            m[0][1] += r[0] * r[1];
            m[1][0] += r[1] * r[0];
            m[1][1] += r[1] * r[1];
        }
        let mut det = 0.0;
        for (i, a) in rows.iter().enumerate() {
            if a.len() != 2 {
                continue;
            }
            for b in rows.iter().skip(i + 1) {
                if b.len() != 2 {
                    continue;
                }
                let cross = a[0] * b[1] - a[1] * b[0];
                det += cross * cross;
            }
        }
        Info {
            m,
            trace: m[0][0] + m[1][1],
            det,
        }
    }

    /// Eigenvalues `(largest, smallest)`. The smaller one is recovered as `det / largest`
    /// rather than from the quadratic formula, which would cancel.
    fn eigenvalues(&self) -> (f64, f64) {
        let disc = (self.trace * self.trace - 4.0 * self.det).max(0.0).sqrt();
        let big = 0.5 * (self.trace + disc);
        let small = if big > 0.0 { self.det / big } else { 0.0 };
        (big, small)
    }

    /// `true` when there is no position covariance: fewer than two independent azimuths.
    ///
    /// The test is on the singular values of `W^(1/2) J`, i.e. on `sqrt(eigenvalue)`, with
    /// the project's [`uncertainty::RANK_TOLERANCE_REL`], so it agrees with the rank
    /// reported elsewhere (CONVENTIONS section 9).
    fn is_singular(&self) -> bool {
        let (big, small) = self.eigenvalues();
        let positive = big > 0.0 && small > 0.0;
        !positive || small / big < uncertainty::RANK_TOLERANCE_REL * uncertainty::RANK_TOLERANCE_REL
    }

    fn rank(&self) -> usize {
        let (big, _) = self.eigenvalues();
        if big <= 0.0 || big.is_nan() {
            0
        } else if self.is_singular() {
            1
        } else {
            2
        }
    }

    /// Condition number of `W^(1/2) J` (not of the covariance, whose axis ratio is this
    /// number squared). Infinite when rank-deficient.
    fn condition_number(&self) -> f64 {
        if self.is_singular() {
            return f64::INFINITY;
        }
        let (big, small) = self.eigenvalues();
        (big / small).sqrt()
    }

    /// `Cov = M^-1`, north/east, `m^2`. `None` when rank-deficient.
    fn covariance(&self) -> Option<[[f64; 2]; 2]> {
        if self.is_singular() || !self.det.is_finite() {
            return None;
        }
        let d = self.det;
        let c = [
            [self.m[1][1] / d, -self.m[0][1] / d],
            [-self.m[1][0] / d, self.m[0][0] / d],
        ];
        if c.iter().flatten().any(|v| !v.is_finite()) {
            return None;
        }
        Some(c)
    }

    /// `ln det(M + ridge I)`, always finite: `det + ridge * trace + ridge^2`.
    fn log_det_ridged(&self) -> f64 {
        let d = self.det + RIDGE * self.trace + RIDGE * RIDGE;
        if d.is_finite() && d > 0.0 {
            d.ln()
        } else {
            // Rounding can only get here from a rank-0 matrix.
            (RIDGE * RIDGE).ln()
        }
    }

    /// Objective cost. Lower is better. `None` when the covariance does not exist.
    fn cost(&self, objective: Objective) -> Option<f64> {
        if self.is_singular() {
            return None;
        }
        let (big, small) = self.eigenvalues();
        let value = match objective {
            // trace(M^-1) = trace(M) / det(M).
            Objective::MinTrace => (self.trace / self.det).sqrt(),
            // The largest eigenvalue of M^-1 is the reciprocal of the smallest of M.
            Objective::MinMaxEigenvalue => (1.0 / small).sqrt(),
            Objective::MinConditionNumber => (big / small).sqrt(),
        };
        value.is_finite().then_some(value)
    }

    /// Azimuth of the least-constrained direction, degrees in `[0, 180)`, and the
    /// eigenvalue ratio. This is also the azimuth of the covariance ellipse's major axis.
    fn weak_axis_deg(&self) -> f64 {
        let (_, vectors) = linalg::eigen_sym2(self.m);
        let (vn, ve) = (vectors[0][1], vectors[1][1]);
        ve.atan2(vn).to_degrees().rem_euclid(180.0)
    }
}

/// Conditioning of a stack of weighted rows.
///
/// [`uncertainty::conditioning`] indexes a 2x2 inverse unconditionally, so it must not be
/// called with an empty Jacobian; the zero-sight case is built here instead. Only its
/// geometry-only dilution and azimuth gap are used: its rank and condition number come
/// from the Gram matrix, which cannot see a rank-1 Jacobian as rank 1 (the squared
/// condition number floors the smaller singular value at about `sqrt(eps)`), so [`Info`]
/// supplies those two instead.
fn conditioning_of(rows: &[Vec<f64>], azimuths_rad: &[f64]) -> Conditioning {
    if rows.is_empty() {
        return Conditioning {
            singular_values: Vec::new(),
            condition_number: f64::INFINITY,
            rank: 0,
            geometric_dilution_m_per_arcmin: f64::INFINITY,
            max_azimuth_gap_deg: 360.0,
            columns: "position (north, east)".to_string(),
        };
    }
    uncertainty::conditioning(rows, azimuths_rad)
}

/// `Some(v)` for a finite `v`, `None` for an infinity or a NaN.
fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

fn metrics(candidates: &[&Candidate]) -> PlanMetrics {
    let rows: Vec<Vec<f64>> = candidates.iter().filter_map(|c| c.weighted_row()).collect();
    let azimuths: Vec<f64> = candidates
        .iter()
        .filter(|c| c.is_usable())
        .map(|c| c.azimuth_deg.to_radians())
        .collect();
    let cond = conditioning_of(&rows, &azimuths);
    let info = Info::of(&rows);
    let cov = info.covariance();
    let mut out = PlanMetrics {
        sight_count: rows.len(),
        sigma_north_m: None,
        sigma_east_m: None,
        trace_sigma_m: None,
        semi_major_sigma_m: None,
        semi_minor_sigma_m: None,
        semi_major_azimuth_deg: None,
        geometric_dilution_m_per_arcmin: finite(cond.geometric_dilution_m_per_arcmin),
        condition_number: finite(info.condition_number()),
        rank: info.rank(),
        max_azimuth_gap_deg: cond.max_azimuth_gap_deg,
        singular: cov.is_none(),
    };
    if let Some(c) = cov {
        let (big, small) = info.eigenvalues();
        out.sigma_north_m = Some(c[0][0].max(0.0).sqrt());
        out.sigma_east_m = Some(c[1][1].max(0.0).sqrt());
        out.trace_sigma_m = Some((c[0][0] + c[1][1]).max(0.0).sqrt());
        // The covariance's largest eigenvalue is 1 / the information's smallest.
        out.semi_major_sigma_m = Some((1.0 / small).sqrt());
        out.semi_minor_sigma_m = Some((1.0 / big).sqrt());
        out.semi_major_azimuth_deg = Some(info.weak_axis_deg());
    }
    out
}

// ---------------------------------------------------------------------------
// Weak-axis naming
// ---------------------------------------------------------------------------

/// The direction the current geometry constrains least.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WeakAxis {
    /// No sights at all: every direction is unconstrained.
    Unconstrained,
    /// One weak axis worth naming, its azimuth in `[0, 180)` and the eigenvalue ratio.
    Axis { azimuth_deg: f64, ratio: f64 },
    /// The information is already close to isotropic; the ratio is reported anyway.
    Balanced { ratio: f64 },
}

/// Compass name of an axis given its azimuth in `[0, 180)`, to the nearest 22.5 degrees.
pub fn axis_name(axis_deg: f64) -> &'static str {
    if !axis_deg.is_finite() {
        return "undetermined";
    }
    let bin = ((axis_deg.rem_euclid(180.0) / 22.5).round() as i64).rem_euclid(8);
    match bin {
        0 => "N-S",
        1 => "NNE-SSW",
        2 => "NE-SW",
        3 => "ENE-WSW",
        4 => "E-W",
        5 => "WNW-ESE",
        6 => "NW-SE",
        _ => "NNW-SSE",
    }
}

/// An eigenvalue ratio above this is reported as "no constraint at all on that axis yet":
/// beyond it the small eigenvalue is rounding noise, not a measurement.
const NO_CONSTRAINT_RATIO: f64 = 1.0e12;

fn weak_axis(info: &Info) -> WeakAxis {
    let (big, small) = info.eigenvalues();
    if !(big.is_finite() && big > 0.0) {
        return WeakAxis::Unconstrained;
    }
    let ratio = if small > 0.0 && big / small <= NO_CONSTRAINT_RATIO {
        big / small
    } else {
        f64::INFINITY
    };
    if ratio < BALANCED_INFORMATION_RATIO {
        return WeakAxis::Balanced { ratio };
    }
    WeakAxis::Axis {
        azimuth_deg: info.weak_axis_deg(),
        ratio,
    }
}

/// Smallest angle between two undirected axes, degrees in `[0, 90]`.
fn axis_separation_deg(a_deg: f64, b_deg: f64) -> f64 {
    let d = (a_deg - b_deg).rem_euclid(180.0);
    if d > 90.0 { 180.0 - d } else { d }
}

fn rationale(weak: WeakAxis, c: &Candidate, base_sigma_arcmin: f64) -> String {
    let az = norm_360(c.azimuth_deg);
    let mut s = match weak {
        WeakAxis::Unconstrained => format!(
            "no sights yet, so position is unconstrained in every direction; this body's \
             azimuth {az:.0} opens the first line of position"
        ),
        WeakAxis::Balanced { ratio } => format!(
            "current geometry is already balanced (information ratio {ratio:.2}); this \
             body's azimuth {az:.0} sharpens it without changing its shape much"
        ),
        WeakAxis::Axis { azimuth_deg, ratio } => {
            let name = axis_name(azimuth_deg);
            let sep = axis_separation_deg(az, azimuth_deg);
            let ratio_text = if ratio.is_finite() {
                format!("information ratio {ratio:.1}")
            } else {
                "no constraint at all on that axis yet".to_string()
            };
            if sep <= ALIGNED_DEG {
                format!(
                    "current geometry is weak along the {name} axis ({ratio_text}); this \
                     body's azimuth {az:.0} adds constraint there"
                )
            } else if sep <= MISALIGNED_DEG {
                format!(
                    "current geometry is weak along the {name} axis ({ratio_text}); this \
                     body's azimuth {az:.0} is {sep:.0} deg off that axis and recovers \
                     part of the missing constraint"
                )
            } else {
                format!(
                    "current geometry is weak along the {name} axis ({ratio_text}); this \
                     body's azimuth {az:.0} lies {sep:.0} deg away, near the \
                     already-strong direction, so it mostly sharpens what is already known"
                )
            }
        }
    };
    if c.sigma_arcmin > base_sigma_arcmin * (1.0 + 1e-9) {
        s.push_str(&format!(
            ". Low altitude {:.0} deg: refraction uncertainty inflated to {:.2}'",
            c.altitude_deg, c.sigma_arcmin
        ));
    }
    if let Some(mag) = c.magnitude {
        s.push_str(&format!(
            ". Magnitude {mag:.2}, which did not enter the ranking"
        ));
    }
    if !c.note.trim().is_empty() {
        s.push_str(&format!(". {}", c.note.trim()));
    }
    s.push('.');
    s
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/// Greedy forward selection of the bodies that most improve the predicted fix.
///
/// The selection starts from `options.already_taken` and adds one body at a time, each
/// time taking the candidate that most improves the objective **at that step**. Ties
/// (within `1e-12` relative) go to the higher altitude, then to the earlier candidate, so
/// the result is deterministic for a given input order.
///
/// While the geometry so far is rank-deficient — fewer than two independent azimuths, for
/// which no covariance exists — the step is scored on the growth of
/// `ln det(J^T W J + ridge I)` instead (see [`RIDGE_SIGMA_M`] and
/// [`ScoreBasis::LogDetGrowth`]); the plan's notes say so, and so does the step's
/// `score_units`. The ridge is 16 Earth radii of prior and is *not* a navigational prior.
///
/// `approximate_position` and `utc` are recorded and disclosed; neither changes the
/// arithmetic, which depends only on the azimuths and sigmas already in the candidates.
pub fn rank(
    candidates: &[Candidate],
    approximate_position: LatLon,
    utc: &str,
    options: &PlanOptions,
) -> Plan {
    let mut notes = vec![
        note_approximate_position(&approximate_position),
        NOTE_GEOMETRIC_VISIBILITY.to_string(),
        NOTE_BRIGHTNESS_SECONDARY.to_string(),
        options.objective.description().to_string(),
    ];

    // Already-taken sights are facts: the altitude window does not apply to them, but
    // unusable numbers still cannot enter a Jacobian.
    let mut taken: Vec<&Candidate> = Vec::new();
    for c in &options.already_taken {
        if c.is_usable() {
            taken.push(c);
        } else {
            notes.push(format!(
                "already-taken sight {:?} ignored: altitude, azimuth or sigma is not a \
                 usable finite number",
                c.body
            ));
        }
    }

    // Eligible candidates, with every exclusion recorded.
    let mut excluded: Vec<ExcludedBody> = Vec::new();
    let mut eligible: Vec<&Candidate> = Vec::new();
    for c in candidates {
        let reason = exclusion_reason(c, options);
        match reason {
            Some(r) => excluded.push(ExcludedBody {
                body: c.body.clone(),
                altitude_deg: c.altitude_deg,
                azimuth_deg: c.azimuth_deg,
                reason: r,
            }),
            None => eligible.push(c),
        }
    }
    for e in &excluded {
        notes.push(format!("excluded {}: {}", e.body, e.reason));
    }

    let baseline = metrics(&taken);
    let mut progression = vec![baseline.clone()];
    let mut chosen: Vec<PlannedBody> = Vec::new();
    let mut used = vec![false; eligible.len()];
    let mut current: Vec<&Candidate> = taken.clone();
    let mut used_ridge = false;

    let want = options.select.min(eligible.len());
    for step in 1..=want {
        let rows: Vec<Vec<f64>> = current.iter().filter_map(|c| c.weighted_row()).collect();
        let info_before = Info::of(&rows);
        let cost_before = info_before.cost(options.objective);
        let basis = if cost_before.is_some() {
            ScoreBasis::Objective
        } else {
            ScoreBasis::LogDetGrowth
        };
        let logdet_before = info_before.log_det_ridged();
        let weak = weak_axis(&info_before);

        let mut best: Option<(usize, f64, f64)> = None; // (index, score, altitude)
        for (i, c) in eligible.iter().enumerate() {
            if used[i] {
                continue;
            }
            let Some(row) = c.weighted_row() else {
                continue;
            };
            let mut rows_after = rows.clone();
            rows_after.push(row);
            let info_after = Info::of(&rows_after);
            let score = match basis {
                ScoreBasis::Objective => {
                    // cost_before exists here by construction; a candidate that cannot
                    // produce a cost (never happens once rank 2) scores -inf.
                    match (cost_before, info_after.cost(options.objective)) {
                        (Some(b), Some(a)) => b - a,
                        _ => f64::NEG_INFINITY,
                    }
                }
                ScoreBasis::LogDetGrowth => info_after.log_det_ridged() - logdet_before,
            };
            if !score.is_finite() {
                continue;
            }
            best = Some(match best {
                None => (i, score, c.altitude_deg),
                Some((bi, bs, ba)) => {
                    let scale = score.abs().max(bs.abs()).max(f64::MIN_POSITIVE);
                    let tie = (score - bs).abs() <= TIE_REL * scale;
                    if (!tie && score > bs) || (tie && c.altitude_deg > ba) {
                        (i, score, c.altitude_deg)
                    } else {
                        (bi, bs, ba)
                    }
                }
            });
        }

        let Some((idx, score, _)) = best else { break };
        used[idx] = true;
        let c = eligible[idx];
        if basis == ScoreBasis::LogDetGrowth {
            used_ridge = true;
        }
        chosen.push(PlannedBody {
            body: c.body.clone(),
            altitude_deg: c.altitude_deg,
            azimuth_deg: norm_360(c.azimuth_deg),
            score,
            rationale: rationale(weak, c, options.base_sigma_arcmin),
            step,
            score_units: basis.units(options.objective),
            score_basis: basis,
            sigma_arcmin: c.sigma_arcmin,
            magnitude: c.magnitude,
        });
        current.push(c);
        progression.push(metrics(&current));
    }

    if used_ridge {
        notes.push(format!(
            "fewer than two sights were available at the start, so the covariance did not \
             exist: those steps were scored on the growth of ln det(J^T W J) with a ridge \
             of one isotropic pseudo-sight at sigma {RIDGE_SIGMA_M:.0e} m (about 16 Earth \
             radii, i.e. no navigational information). Their scores are in nats and are \
             not comparable with the later metre-valued scores"
        ));
    }
    notes.push(format!(
        "selected {} of {} eligible candidates ({} excluded), starting from {} sight(s) \
         already taken",
        chosen.len(),
        eligible.len(),
        excluded.len(),
        taken.len()
    ));

    let predicted = progression
        .last()
        .cloned()
        .unwrap_or_else(PlanMetrics::empty);

    Plan {
        approximate_position,
        utc: utc.to_string(),
        bodies: chosen,
        notes,
        objective: options.objective,
        baseline,
        predicted,
        progression,
        excluded,
    }
}

fn exclusion_reason(c: &Candidate, options: &PlanOptions) -> Option<String> {
    if !c.altitude_deg.is_finite() || !c.azimuth_deg.is_finite() {
        return Some("altitude or azimuth is not a finite number".to_string());
    }
    if !c.sigma_arcmin.is_finite() || c.sigma_arcmin <= 0.0 {
        return Some(format!(
            "sigma {} is not a positive finite number of arcminutes",
            c.sigma_arcmin
        ));
    }
    if c.altitude_deg < options.min_altitude_deg {
        return Some(format!(
            "altitude {:.1} deg is below the {:.1} deg minimum: refraction is large and \
             strongly dependent on the real temperature profile near the horizon, and the \
             sea horizon itself is often obscured",
            c.altitude_deg, options.min_altitude_deg
        ));
    }
    if c.altitude_deg > options.max_altitude_deg {
        return Some(format!(
            "altitude {:.1} deg is above the {:.1} deg maximum: near the zenith the \
             azimuth of the line of position is poorly defined (a small altitude error \
             swings it a long way) and the sextant is hard to hold and swing",
            c.altitude_deg, options.max_altitude_deg
        ));
    }
    if !c.is_usable() {
        return Some("altitude is outside [-90, 90] degrees".to_string());
    }
    None
}

// ---------------------------------------------------------------------------
// Azimuth spread with an unknown shared altitude error (navigation-Moon agent)
// ---------------------------------------------------------------------------

/// Largest number of subsets [`best_spread_subset`] examines exhaustively.
pub const SPREAD_EXHAUSTIVE_LIMIT: u64 = 250_000;

/// The position variance, square metres, of a fix from `candidates` in which a shared
/// altitude error is estimated too: rows `[cos Zn, sin Zn, 1] / sigma` (CONVENTIONS
/// sections 8-9 with the shared bias on), the trace of the position block of
/// `(J^T W J)^-1`. Infinite when the three unknowns cannot all be determined (fewer
/// than three distinct azimuths, or all on one side of a line through the observer
/// with the bias unresolvable).
pub fn spread_variance_m2(candidates: &[&Candidate]) -> f64 {
    let mut m = [[0.0f64; 3]; 3];
    for c in candidates {
        if !c.is_usable() {
            return f64::INFINITY;
        }
        let (n, e) = tangent_row(c.azimuth_deg.to_radians());
        let s = c.sigma_arcmin * NM_M;
        let r = [n / s, e / s, 1.0 / s];
        for (i, ri) in r.iter().enumerate() {
            for (j, rj) in r.iter().enumerate() {
                m[i][j] += ri * rj;
            }
        }
    }
    let c00 = m[1][1] * m[2][2] - m[1][2] * m[2][1];
    let c11 = m[0][0] * m[2][2] - m[0][2] * m[2][0];
    let det = m[0][0] * c00 - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let scale = m[0][0] * m[1][1] * m[2][2];
    if !(det.is_finite() && scale > 0.0 && det > 1e-12 * scale) {
        return f64::INFINITY;
    }
    (c00 + c11) / det
}

/// The `count` candidates (indices into `candidates`, ascending) whose fix is best
/// when a shared altitude error is unknown: [`spread_variance_m2`] minimised.
///
/// A dip, index or refraction error moves every line of position the same way, toward
/// or away from its body; it cancels in the fix only when the bodies surround the
/// observer. Minimising the position variance with that error as a third unknown is the
/// navigator's "best azimuth spread" (three bodies 120 degrees apart, four 90 degrees
/// apart) made exact, and it still weighs each body's sigma. Exhaustive up to
/// [`SPREAD_EXHAUSTIVE_LIMIT`] subsets, otherwise greedy with pairwise exchanges. Ties
/// keep the earlier subset in input order, so the result is deterministic.
pub fn best_spread_subset(candidates: &[Candidate], count: usize) -> Vec<usize> {
    let n = candidates.len();
    let k = count.min(n);
    if k == n {
        return (0..n).collect();
    }
    let cost = |idx: &[usize]| {
        let set: Vec<&Candidate> = idx.iter().map(|&i| &candidates[i]).collect();
        spread_variance_m2(&set)
    };
    let subsets = binomial(n as u64, k as u64);
    if subsets <= SPREAD_EXHAUSTIVE_LIMIT {
        let mut idx: Vec<usize> = (0..k).collect();
        let mut best = (cost(&idx), idx.clone());
        loop {
            // Next combination in lexicographic order.
            let mut i = k;
            while i > 0 && idx[i - 1] == n - k + i - 1 {
                i -= 1;
            }
            if i == 0 {
                break;
            }
            idx[i - 1] += 1;
            for j in i..k {
                idx[j] = idx[j - 1] + 1;
            }
            let c = cost(&idx);
            if c < best.0 {
                best = (c, idx.clone());
            }
        }
        return best.1;
    }
    // Greedy growth on the 2-D trace, then exchanges while any swap helps.
    let mut chosen: Vec<usize> = Vec::with_capacity(k);
    while chosen.len() < k {
        let mut pick = None;
        for i in (0..n).filter(|i| !chosen.contains(i)) {
            let mut trial = chosen.clone();
            trial.push(i);
            let c = if trial.len() >= 3 {
                cost(&trial)
            } else {
                -(trial.len() as f64)
            };
            if pick.is_none_or(|(_, pc)| c < pc) {
                pick = Some((i, c));
            }
        }
        chosen.push(pick.map(|p| p.0).unwrap_or(0));
    }
    let mut current = cost(&chosen);
    let mut improved = true;
    while improved {
        improved = false;
        for slot in 0..k {
            for i in 0..n {
                if chosen.contains(&i) {
                    continue;
                }
                let mut trial = chosen.clone();
                trial[slot] = i;
                let c = cost(&trial);
                if c < current {
                    current = c;
                    chosen = trial;
                    improved = true;
                }
            }
        }
    }
    chosen.sort_unstable();
    chosen
}

fn binomial(n: u64, k: u64) -> u64 {
    let k = k.min(n - k);
    let mut r: u64 = 1;
    for i in 0..k {
        r = r.saturating_mul(n - i) / (i + 1);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn expected_sigma_follows_conventions_section_5() {
        // Above 10 deg: untouched.
        assert_relative_eq!(expected_sigma_arcmin(1.0, 40.0), 1.0, epsilon = 1e-12);
        assert_relative_eq!(expected_sigma_arcmin(1.0, 10.0), 1.0, epsilon = 1e-12);
        // 5..10: the planning term only.
        assert_relative_eq!(
            expected_sigma_arcmin(1.0, 8.0),
            (1.0f64 + 0.09).sqrt(),
            epsilon = 1e-12
        );
        // Below 5: the section 5 term, and only it.
        assert_relative_eq!(
            expected_sigma_arcmin(1.0, 3.0),
            std::f64::consts::SQRT_2,
            epsilon = 1e-12
        );
        // Bad input is NaN, not a silent weight.
        assert!(expected_sigma_arcmin(0.0, 30.0).is_nan());
        assert!(expected_sigma_arcmin(-1.0, 30.0).is_nan());
        assert!(expected_sigma_arcmin(1.0, f64::NAN).is_nan());
    }

    #[test]
    fn two_perpendicular_sights_give_the_textbook_covariance() {
        // Rows [1,0]/s and [0,1]/s -> Cov = diag(s^2, s^2) in metres.
        let s = 1.0;
        let a = Candidate::new("A", 45.0, 0.0, s);
        let b = Candidate::new("B", 45.0, 90.0, s);
        let m = metrics(&[&a, &b]);
        let expect = s * NM_M;
        assert_relative_eq!(m.sigma_north_m.unwrap(), expect, epsilon = 1e-6);
        assert_relative_eq!(m.sigma_east_m.unwrap(), expect, epsilon = 1e-6);
        assert_relative_eq!(m.condition_number.unwrap(), 1.0, epsilon = 1e-9);
        assert!(!m.singular);
    }

    #[test]
    fn one_sight_is_singular_and_zero_sights_do_not_panic() {
        let a = Candidate::new("A", 45.0, 0.0, 1.0);
        let one = metrics(&[&a]);
        assert!(one.singular);
        assert!(one.sigma_north_m.is_none());
        let none = metrics(&[]);
        assert!(none.singular);
        assert_eq!(none.sight_count, 0);
        assert_eq!(none.max_azimuth_gap_deg, 360.0);
    }

    #[test]
    fn axis_names_cover_the_compass() {
        assert_eq!(axis_name(0.0), "N-S");
        assert_eq!(axis_name(90.0), "E-W");
        assert_eq!(axis_name(135.0), "NW-SE");
        assert_eq!(axis_name(179.9), "N-S");
        assert_eq!(axis_name(f64::NAN), "undetermined");
        assert_eq!(axis_separation_deg(312.0, 132.0), 0.0);
        assert_relative_eq!(axis_separation_deg(0.0, 91.0), 89.0, epsilon = 1e-9);
    }

    #[test]
    fn weak_axis_of_a_single_sight_is_perpendicular_to_it() {
        let a = Candidate::new("A", 45.0, 0.0, 1.0);
        let info = Info::of(&[a.weighted_row().unwrap()]);
        match weak_axis(&info) {
            WeakAxis::Axis { azimuth_deg, ratio } => {
                assert_relative_eq!(azimuth_deg, 90.0, epsilon = 1e-9);
                assert!(
                    ratio.is_infinite(),
                    "a single sight constrains one axis only"
                );
            }
            other => panic!("expected a named weak axis, got {other:?}"),
        }
        assert_eq!(weak_axis(&Info::of(&[])), WeakAxis::Unconstrained);
        let b = Candidate::new("B", 45.0, 90.0, 1.0);
        let both = Info::of(&[a.weighted_row().unwrap(), b.weighted_row().unwrap()]);
        match weak_axis(&both) {
            WeakAxis::Balanced { ratio } => assert_relative_eq!(ratio, 1.0, epsilon = 1e-9),
            other => panic!("expected balanced, got {other:?}"),
        }
    }

    #[test]
    fn the_determinant_of_parallel_rows_is_exactly_zero() {
        // The whole selection rests on this: two rows on one axis must tie exactly, not
        // within rounding noise, or the tie-break becomes arbitrary.
        let a = Candidate::new("A", 45.0, 37.0, 1.0);
        let flipped = Candidate::new("B", 45.0, 217.0, 1.0);
        let same = Candidate::new("C", 45.0, 37.0, 1.0);
        for other in [&flipped, &same] {
            let info = Info::of(&[a.weighted_row().unwrap(), other.weighted_row().unwrap()]);
            assert!(info.is_singular());
            assert!(info.covariance().is_none());
            assert_eq!(info.rank(), 1);
            assert!(info.condition_number().is_infinite());
        }
        assert_eq!(Info::of(&[a.weighted_row().unwrap()]).det, 0.0);
        assert_eq!(Info::of(&[]).rank(), 0);

        // Two candidates one 180 degrees from the other score identically at step 1.
        let one = Info::of(&[a.weighted_row().unwrap()]).log_det_ridged();
        let two = Info::of(&[flipped.weighted_row().unwrap()]).log_det_ridged();
        assert_eq!(one, two);
    }

    #[test]
    fn the_condition_number_is_the_jacobians_not_the_covariances() {
        // Rows at 0 and 60 degrees with unit sigma: eigenvalues of M are 1.5 and 0.5, so
        // the covariance axis ratio is 3 and the Jacobian condition number sqrt(3).
        let a = Candidate::new("A", 45.0, 0.0, 1.0);
        let b = Candidate::new("B", 45.0, 60.0, 1.0);
        let info = Info::of(&[a.weighted_row().unwrap(), b.weighted_row().unwrap()]);
        let (big, small) = info.eigenvalues();
        assert_relative_eq!(big / small, 3.0, epsilon = 1e-9);
        assert_relative_eq!(info.condition_number(), 3f64.sqrt(), epsilon = 1e-9);
        assert_relative_eq!(
            info.cost(Objective::MinConditionNumber).unwrap(),
            3f64.sqrt(),
            epsilon = 1e-9
        );
        let m = metrics(&[&a, &b]);
        assert_relative_eq!(m.condition_number.unwrap(), 3f64.sqrt(), epsilon = 1e-9);
        assert_relative_eq!(
            m.semi_major_sigma_m.unwrap() / m.semi_minor_sigma_m.unwrap(),
            3f64.sqrt(),
            epsilon = 1e-9
        );
    }
    #[test]
    fn the_best_spread_surrounds_the_observer() {
        // Six bodies: four crowded into the west, two east. Three of them should span
        // the horizon, not sit in the west where a shared error would not cancel.
        let c = [
            Candidate::new("W1", 40.0, 250.0, 1.0),
            Candidate::new("W2", 40.0, 270.0, 1.0),
            Candidate::new("W3", 40.0, 290.0, 1.0),
            Candidate::new("W4", 40.0, 310.0, 1.0),
            Candidate::new("E1", 40.0, 30.0, 1.0),
            Candidate::new("E2", 40.0, 150.0, 1.0),
        ];
        let pick = best_spread_subset(&c, 3);
        let names: Vec<&str> = pick.iter().map(|&i| c[i].body.as_str()).collect();
        assert_eq!(names, ["W2", "E1", "E2"], "{names:?}");
        // All on one side, the shared error is unresolvable.
        let west: Vec<&Candidate> = c[..3].iter().collect();
        let ratio = spread_variance_m2(&west) / spread_variance_m2(&[&c[1], &c[4], &c[5]]);
        assert!(ratio > 20.0, "{ratio}");
        let same: Vec<&Candidate> = vec![&c[0], &c[0], &c[0]];
        assert!(spread_variance_m2(&same).is_infinite());
        assert_eq!(binomial(30, 5), 142_506);
    }
}
