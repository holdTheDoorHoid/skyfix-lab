//! Residual heat map ("misfit grid"): the solver's data misfit on a latitude/longitude
//! grid. CONVENTIONS section 8 defines the residual model, section 9 the nominal levels.
//!
//! OWNER: misfit agent. Wire format: docs/EXPLORER_API.md, "Misfit grid"; the browser
//! pieces that draw it live in web/src/next/misfit/.
//!
//! # What is mapped
//!
//! At every node the value is the solver's own measure of fit, and nothing else:
//!
//! ```text
//! chi2(phi, lambda) = sum_i w_i ((Ho_i - Hc_i(phi, lambda) - b) / sigma_i)^2
//! ```
//!
//! - `Hc_i` is [`geometry::altitude_azimuth`]'s altitude: the same up, north and east
//!   components, grouped the same way (the sines and cosines computed once per row and
//!   column), with the angle taken as `atan(up / sqrt(north^2 + east^2))` rather than
//!   `atan2(up, hypot(north, east))`. That is the same angle to rounding (about 1e-16 rad,
//!   exact at the zenith too) at half the cost, which keeps a 200 x 200 grid of 10 sights
//!   well inside its 30 ms budget. The grid's lowest node therefore sits next to the
//!   solver's fix.
//! - The same sights as the solver: those with a finite direction, altitude and sigma and
//!   `sigma > 0`, in input order.
//! - `b` is 0 unless [`MisfitOptions::estimate_shared_bias`] is on. Then it is **profiled
//!   out** analytically at every node: the bias that fits best there,
//!   `b = sum(w_i r_i / sigma_i^2) / sum(w_i / sigma_i^2)` with `r_i = Ho_i - Hc_i`, so
//!   each point is judged with its own best bias, as the three-unknown fit judges it.
//! - `w_i` is 1 unless weights are given. [`options_for_solve`] gives the solver's
//!   **final** Huber weights, held fixed, when the solver reweighted (robust weighting on
//!   and a unique fix): the map's minimum is then the robust fix and, near it, the 95 %
//!   line is the solver's (approximate) ellipse. Far from the fix those weights are not
//!   what reweighting would have chosen there, so the far field is approximate and a note
//!   says so. The other choice, no weights, would put the minimum at the plain
//!   least-squares point, away from the fix the rest of the page shows.
//! - **A prior is never part of the map**: it shows how well each point fits the sights
//!   alone. The clock uncertainty and posterior scaling change the reported covariance,
//!   not the residuals, so they do not change it either.
//!
//! # The best point and the levels
//!
//! The grid's local minima (lowest first, at most 32) and any `seeds` (the solver's fix
//! and candidates) are polished with the solver's own damped Gauss-Newton step in the
//! tangent plane, under the model above. Polished points closer than
//! `cluster_radius_nm` (the solver's 10 NM) are one basin. The best of them is
//! [`MisfitGrid::min`], and the levels are measured up from its chi2, so a grid too
//! coarse to land a node in the bottom of the basin still draws the levels in the right
//! place — and a view that does not contain the best point says so instead of
//! re-anchoring the levels on its own lowest node.
//!
//! `levels` are the chi-square quantiles at the 1-sigma (68.27 %), 95 % and 3-sigma
//! (99.73 %) probabilities: 2.30, 5.99 and 11.83 for two unknowns, and, with the shared
//! bias estimated, 3.53, 7.81 and 14.16 for three. With three, a line is the joint region
//! of position and bias seen on the map (every position for which *some* bias fits at
//! that level); the solver's ellipse is the position-only 95 % region (5.99 on the
//! position block of the covariance), so it is smaller than the 95 % line. Every level is
//! nominal, under the independent-noise model of section 9: a shared error (a biased
//! sextant, a wrong clock) moves the whole picture without widening it.
//!
//! # Grid
//!
//! Nodes, not cells: `lat_deg[i] = south + i * lat_step` for `i` in `0..n_lat` (both edges
//! included), `lon = west + j * lon_step` eastward, so a box that crosses the antimeridian
//! is one grid. `chi2` is row-major, **south row first**: `chi2[i * n_lon + j]`. Output
//! longitudes are normalised to `(-180, 180]` (section 1); `bounds.east_deg` is
//! `west_deg + span` and may exceed 180. At a pole every node of the row is the same point
//! and carries the same value.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::f64::consts::{FRAC_PI_2, PI};

use crate::geometry::{
    CircleIntersection, Point, altitude_azimuth, angular_distance, apply_tangent_step,
    geographic_position, initial_bearing, tangent_row, two_circle_intersections,
};
use crate::linalg;
use crate::types::{FixCandidate, FixResult, LatLon, Sight, SolveOptions};
use crate::uncertainty;
use crate::units::{CHI2_95_2DOF, NM_M, nm_to_rad, norm_180, rad_to_arcmin, rad_to_deg, rad_to_nm};

/// Most nodes along either axis (a 1024 x 1024 grid is a million nodes).
pub const MAX_AXIS: usize = 1024;
/// Most basins reported.
pub const MAX_BASINS: usize = 8;
/// Grid local minima polished, lowest first.
const MAX_POLISHED: usize = 32;
/// A minimum whose weighted Jacobian is conditioned this badly fixes a line, not a point
/// (the ellipse cut-off of CONVENTIONS section 9).
const WELL_DETERMINED_CONDITION: f64 = 1e6;
/// Distinct circles used for the cocked-hat spread of the default frame.
const MAX_HAT_CIRCLES: usize = 12;
/// Circles crossing at a shallower angle do not count toward the cocked hat.
const MIN_HAT_CROSSING_DEG: f64 = 10.0;

const LM_LAMBDA_INIT: f64 = 1e-8;
const LM_LAMBDA_MIN: f64 = 1e-14;
const LM_LAMBDA_MAX: f64 = 1e12;
const LM_MAX_TRIALS: usize = 30;
const MAX_POSITION_STEP_RAD: f64 = 1.0;

/// Probability content of the three levels: 1 sigma, 95 %, 3 sigma (two-sided normal).
pub const LEVEL_CONFIDENCE: [f64; 3] = [0.6826894921370859, 0.95, 0.9973002039367398];
/// Chi-square quantiles at [`LEVEL_CONFIDENCE`] for two unknowns, `-2 ln(1 - p)`. The 95 %
/// value is the solver's ambiguity margin, [`CHI2_95_2DOF`].
pub const DELTA_CHI2_TWO_UNKNOWNS: [f64; 3] = [2.295748928898636, CHI2_95_2DOF, 11.829158081900795];
/// Chi-square quantiles at [`LEVEL_CONFIDENCE`] for three unknowns (the shared bias
/// estimated).
pub const DELTA_CHI2_THREE_UNKNOWNS: [f64; 3] =
    [3.52674038026172, 7.814727903251173, 14.156413609126663];
/// Machine names of the three levels, in order.
pub const LEVEL_NAMES: [&str; 3] = ["one_sigma", "p95", "three_sigma"];
const LEVEL_LABELS: [&str; 3] = ["68.3 % (1 sigma)", "95 %", "99.7 % (3 sigma)"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A latitude/longitude box, degrees, longitude east-positive.
///
/// The grid runs east from `west_deg` to `east_deg`. A box across the antimeridian may give
/// `east_deg` below `west_deg` (170 to -170) or above 180 (170 to 190); `east == west`
/// means all 360 degrees. [`GridBounds::normalized`] gives the form every result carries:
/// `west_deg` in `[-180, 180)` and `east_deg = west_deg + span`, `0 < span <= 360`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct GridBounds {
    pub south_deg: f64,
    pub north_deg: f64,
    pub west_deg: f64,
    pub east_deg: f64,
}

impl GridBounds {
    /// Check the box and put it in normal form (see the type's documentation).
    pub fn normalized(&self) -> Result<GridBounds, String> {
        for (name, v) in [
            ("south_deg", self.south_deg),
            ("north_deg", self.north_deg),
            ("west_deg", self.west_deg),
            ("east_deg", self.east_deg),
        ] {
            if !v.is_finite() {
                return Err(format!("bounds: {name} must be a finite number of degrees"));
            }
        }
        if !(-90.0..=90.0).contains(&self.south_deg) || !(-90.0..=90.0).contains(&self.north_deg) {
            return Err(format!(
                "bounds: latitudes must lie in [-90, 90], got south {} and north {}",
                self.south_deg, self.north_deg
            ));
        }
        if self.north_deg <= self.south_deg {
            return Err(format!(
                "bounds: north_deg ({}) must be greater than south_deg ({})",
                self.north_deg, self.south_deg
            ));
        }
        let mut span = self.east_deg - self.west_deg;
        if span <= 0.0 {
            // Across the antimeridian (or, when east == west, the whole circle).
            span += 360.0;
        }
        if !(span > 0.0 && span <= 360.0) {
            return Err(format!(
                "bounds: from west_deg {} east to east_deg {} is not a span of longitude in \
                 (0, 360] degrees",
                self.west_deg, self.east_deg
            ));
        }
        let west = (self.west_deg + 180.0).rem_euclid(360.0) - 180.0;
        Ok(GridBounds {
            south_deg: self.south_deg,
            north_deg: self.north_deg,
            west_deg: west,
            east_deg: west + span,
        })
    }

    /// Longitude span, degrees (on a normalised box).
    pub fn lon_span_deg(&self) -> f64 {
        self.east_deg - self.west_deg
    }

    /// True when `p` is inside the (normalised) box, edges included.
    pub fn contains(&self, p: LatLon) -> bool {
        const EPS: f64 = 1e-9;
        if p.lat_deg < self.south_deg - EPS || p.lat_deg > self.north_deg + EPS {
            return false;
        }
        let span = self.lon_span_deg();
        if span >= 360.0 - EPS {
            return true;
        }
        let east_of_west = (p.lon_deg - self.west_deg).rem_euclid(360.0);
        east_of_west <= span + EPS || east_of_west >= 360.0 - EPS
    }
}

/// What the map is of. [`MisfitOptions::default`] is the plain two-unknown chi2 with every
/// sight at its own sigma.
#[derive(Debug, Clone, PartialEq)]
pub struct MisfitOptions {
    /// Profile a shared altitude bias out at every node (section 8's third unknown).
    pub estimate_shared_bias: bool,
    /// Multipliers on `1 / sigma_i^2`, one per entry of the `sights` slice (entries of
    /// unusable sights are ignored). `None`: all 1. [`options_for_solve`] puts the solver's
    /// final Huber weights here.
    pub weights: Option<Vec<f64>>,
    /// Positions known to be near minima (the solver's fix and candidates). They are
    /// polished like the grid's own minima, so the best point is found even when it lies
    /// outside the grid.
    pub seeds: Vec<LatLon>,
    /// Polished minima closer than this are one basin (the solver's `cluster_radius_nm`).
    pub cluster_radius_nm: f64,
    pub max_iterations: u32,
    /// Convergence threshold of the polishing step, radians (the solver's).
    pub step_tolerance_rad: f64,
}

impl Default for MisfitOptions {
    fn default() -> Self {
        MisfitOptions {
            estimate_shared_bias: false,
            weights: None,
            seeds: Vec::new(),
            cluster_radius_nm: 10.0,
            max_iterations: 50,
            step_tolerance_rad: 1e-9,
        }
    }
}

/// A polished minimum of the map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MisfitPoint {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub chi2: f64,
    /// `chi2 - min.chi2`.
    pub delta_chi2: f64,
    /// The best-fitting shared bias there, arcminutes, when the bias is estimated.
    pub shared_bias_arcmin: Option<f64>,
    pub inside_grid: bool,
    /// The sights fix a point here: the weighted Jacobian has full rank and a condition
    /// number under 1e6. False along a valley, where they fix only a line.
    pub well_determined: bool,
    pub converged: bool,
}

/// The lowest node of the grid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GridNode {
    /// Row (latitude index, from the south edge) and column (from the west edge).
    pub i: usize,
    pub j: usize,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub chi2: f64,
    pub delta_chi2: f64,
}

/// One contour level: `chi2 = min.chi2 + delta_chi2`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MisfitLevel {
    /// `one_sigma`, `p95` or `three_sigma`.
    pub name: String,
    pub label: String,
    /// Probability content under the independent-noise model, for `unknowns` unknowns.
    pub confidence: f64,
    pub delta_chi2: f64,
    pub chi2: f64,
}

/// A sight as the map uses it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MisfitSight {
    pub id: String,
    pub body: String,
    pub sigma_arcmin: f64,
    /// Multiplier on `1 / sigma^2`: 1 unless fixed weights were given.
    pub weight: f64,
}

/// The misfit map and what it needs to be drawn honestly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MisfitGrid {
    /// Normalised: `west_deg` in `[-180, 180)`, `east_deg = west_deg + span`.
    pub bounds: GridBounds,
    /// The columns run past 180 degrees (`bounds.east_deg > 180`), so `lon_deg` jumps.
    pub crosses_antimeridian: bool,
    pub n_lat: usize,
    pub n_lon: usize,
    pub lat_step_deg: f64,
    pub lon_step_deg: f64,
    /// Node latitudes, south to north.
    pub lat_deg: Vec<f64>,
    /// Node longitudes, west to east, normalised to `(-180, 180]` (so they jump by -360
    /// where the grid crosses the antimeridian; `bounds.west_deg + j * lon_step_deg` is
    /// the same column without the jump).
    pub lon_deg: Vec<f64>,
    /// Row-major, south row first: `chi2[i * n_lon + j]` at `(lat_deg[i], lon_deg[j])`.
    pub chi2: Vec<f64>,
    /// The best point: the lowest polished minimum. The levels are measured from it.
    pub min: MisfitPoint,
    pub grid_min: GridNode,
    /// Distinct polished minima, best first (at most [`MAX_BASINS`]), `min` included.
    pub basins: Vec<MisfitPoint>,
    /// 2, or 3 with the shared bias.
    pub unknowns: usize,
    /// Usable sights minus unknowns (may be zero or negative).
    pub dof: i64,
    pub levels: Vec<MisfitLevel>,
    pub bias_profiled: bool,
    /// Fixed weights were applied (see `sights[].weight`).
    pub weighted: bool,
    pub sights: Vec<MisfitSight>,
    /// Plain-language caveats for this particular map.
    pub notes: Vec<String>,
}

/// A frame for the map, chosen by [`default_bounds`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefaultBounds {
    pub bounds: GridBounds,
    /// The point the frame is built round.
    pub centre: LatLon,
    /// `fix`, `candidates`, `initializer` or `circle`.
    pub centred_on: String,
    /// The radius kept round each point framed, nautical miles.
    pub radius_nm: f64,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/// Evaluate the misfit of `sights` on an `n_lat` x `n_lon` grid over `bounds` (see the
/// module documentation for exactly what is computed).
pub fn grid(
    sights: &[Sight],
    options: &MisfitOptions,
    bounds: &GridBounds,
    n_lat: usize,
    n_lon: usize,
) -> Result<MisfitGrid, String> {
    check_axis("n_lat", n_lat)?;
    check_axis("n_lon", n_lon)?;
    let b = bounds.normalized()?;
    let model = Model::new(sights, options)?;

    let span = b.lon_span_deg();
    let lat_step = (b.north_deg - b.south_deg) / (n_lat - 1) as f64;
    let lon_step = span / (n_lon - 1) as f64;
    let lat_deg: Vec<f64> = (0..n_lat)
        .map(|i| {
            if i + 1 == n_lat {
                b.north_deg
            } else {
                b.south_deg + i as f64 * lat_step
            }
        })
        .collect();
    let lon_deg: Vec<f64> = (0..n_lon)
        .map(|j| {
            norm_180(if j + 1 == n_lon {
                b.east_deg
            } else {
                b.west_deg + j as f64 * lon_step
            })
        })
        .collect();
    // Exactly the radians a `Point` built from the output degrees holds, so a node's value
    // is what the solver computes at `Point::from_deg(lat_deg[i], lon_deg[j])`.
    let lat_rad: Vec<f64> = lat_deg.iter().map(|d| d.to_radians()).collect();
    let lon_rad: Vec<f64> = lon_deg
        .iter()
        .map(|&d| Point::from_deg(0.0, d).lon)
        .collect();

    let mut chi2 = vec![0.0; n_lat * n_lon];
    model.fill(&lat_rad, &lon_rad, &mut chi2);

    let grid_min_idx = lowest_node(&chi2).ok_or_else(|| {
        "the misfit is not finite anywhere on the grid (check the sights' values)".to_string()
    })?;

    // Polish the grid's lowest local minima and the seeds.
    let mut starts: Vec<Point> = Vec::new();
    let mut minima = local_minima(&chi2, n_lat, n_lon);
    minima.sort_by(|&x, &y| chi2[x].total_cmp(&chi2[y]).then(x.cmp(&y)));
    for &idx in minima.iter().take(MAX_POLISHED) {
        starts.push(Point::new(lat_rad[idx / n_lon], lon_rad[idx % n_lon]));
    }
    for s in &options.seeds {
        if s.lat_deg.is_finite() && s.lon_deg.is_finite() && s.lat_deg.abs() <= 90.0 {
            starts.push(Point::from_deg(s.lat_deg, s.lon_deg));
        }
    }
    let max_iterations = options.max_iterations.max(1);
    let tol = if options.step_tolerance_rad.is_finite() && options.step_tolerance_rad > 0.0 {
        options.step_tolerance_rad
    } else {
        1e-9
    };
    let mut polished: Vec<Polished> = starts
        .iter()
        .filter_map(|&p| model.polish(p, max_iterations, tol))
        .filter(|m| m.chi2.is_finite())
        .collect();
    polished.sort_by(|x, y| x.chi2.total_cmp(&y.chi2));
    let radius = if options.cluster_radius_nm.is_finite() && options.cluster_radius_nm > 0.0 {
        nm_to_rad(options.cluster_radius_nm)
    } else {
        nm_to_rad(10.0)
    };
    let mut distinct: Vec<Polished> = Vec::new();
    for m in polished {
        if distinct
            .iter()
            .all(|k| angular_distance(k.p, m.p) >= radius)
        {
            distinct.push(m);
        }
    }

    let grid_min_value = chi2[grid_min_idx];
    let (gi, gj) = (grid_min_idx / n_lon, grid_min_idx % n_lon);
    // Polishing only ever goes downhill from the lowest node, so the best polished value is
    // at most the grid's lowest; the fallback is for a model that could not be polished.
    let min_chi2 = distinct
        .first()
        .map_or(grid_min_value, |m| m.chi2.min(grid_min_value));
    let point = |m: &Polished| -> MisfitPoint {
        let ll = LatLon {
            lat_deg: m.p.lat_deg(),
            lon_deg: m.p.lon_deg(),
        };
        MisfitPoint {
            lat_deg: ll.lat_deg,
            lon_deg: ll.lon_deg,
            chi2: m.chi2,
            delta_chi2: m.chi2 - min_chi2,
            shared_bias_arcmin: model.bias.then(|| rad_to_arcmin(m.b)),
            inside_grid: b.contains(ll),
            well_determined: m.well_determined,
            converged: m.converged,
        }
    };
    let basins: Vec<MisfitPoint> = distinct.iter().take(MAX_BASINS).map(point).collect();
    let min = basins.first().cloned().unwrap_or_else(|| MisfitPoint {
        lat_deg: lat_deg[gi],
        lon_deg: lon_deg[gj],
        chi2: grid_min_value,
        delta_chi2: 0.0,
        shared_bias_arcmin: model
            .bias
            .then(|| rad_to_arcmin(model.best_bias(Point::new(lat_rad[gi], lon_rad[gj])))),
        inside_grid: true,
        well_determined: false,
        converged: false,
    });

    let unknowns = if model.bias { 3 } else { 2 };
    let deltas = if model.bias {
        DELTA_CHI2_THREE_UNKNOWNS
    } else {
        DELTA_CHI2_TWO_UNKNOWNS
    };
    let levels: Vec<MisfitLevel> = (0..3)
        .map(|k| MisfitLevel {
            name: LEVEL_NAMES[k].to_string(),
            label: LEVEL_LABELS[k].to_string(),
            confidence: LEVEL_CONFIDENCE[k],
            delta_chi2: deltas[k],
            chi2: min.chi2 + deltas[k],
        })
        .collect();
    let dof = model.terms.len() as i64 - unknowns as i64;

    let mut notes = Vec::new();
    if model.bias {
        notes.push(format!(
            "A shared altitude bias is estimated: every point is judged with the bias that fits \
             it best, and the lines are the levels for three unknowns ({:.2} at 95 %), the joint \
             region of position and bias. The solver's 95 % ellipse is the position-only region \
             ({:.2}), so it is smaller than the 95 % line here.",
            DELTA_CHI2_THREE_UNKNOWNS[1], CHI2_95_2DOF
        ));
    }
    if model.weighted {
        let reduced: Vec<&str> = model
            .terms
            .iter()
            .filter(|t| t.w < 1.0 - 1e-9)
            .map(|t| t.sight.id.as_str())
            .collect();
        notes.push(format!(
            "Fixed weights: {} counted for less than its sigma says{}. Near the best point this \
             is the fit the solver made; far from it, reweighting would have chosen other \
             weights, so the far field is approximate.",
            match reduced.len() {
                0 => "no sight".to_string(),
                1 => "1 sight".to_string(),
                n => format!("{n} sights"),
            },
            if reduced.is_empty() {
                String::new()
            } else {
                format!(" ({})", reduced.join(", "))
            }
        ));
    }
    if !min.inside_grid {
        notes.push(
            "The best-fitting point is outside this grid. The lines are measured from it, so \
             they may not appear here at all."
                .to_string(),
        );
    }
    if !basins.is_empty() && basins.iter().all(|m| !m.well_determined) {
        notes.push(
            "The sights fix a line, not a point: the best-fitting points run along a valley \
             rather than into one basin."
                .to_string(),
        );
    }
    let ambiguous = basins
        .iter()
        .filter(|m| m.well_determined && m.delta_chi2 <= deltas[1])
        .count();
    if ambiguous > 1 {
        notes.push(format!(
            "{ambiguous} separate basins fit within the 95 % level: the sights alone cannot \
             choose between them."
        ));
    }
    if dof <= 0 {
        notes.push(format!(
            "{} sight(s) for {unknowns} unknowns: the best points fit exactly, so the fit says \
             nothing about the size of the errors; only the stated sigmas do.",
            model.terms.len()
        ));
    }
    let level_95 = levels[1].chi2;
    let nodes_inside = chi2.iter().filter(|&&v| v <= level_95).count();
    if min.inside_grid && nodes_inside < 4 {
        notes.push(
            "The 95 % region is smaller than a grid cell here: zoom in to see its shape."
                .to_string(),
        );
    }

    let sights_out: Vec<MisfitSight> = model
        .terms
        .iter()
        .map(|t| MisfitSight {
            id: t.sight.id.clone(),
            body: t.sight.body.clone(),
            sigma_arcmin: rad_to_arcmin(t.sigma),
            weight: t.w,
        })
        .collect();

    Ok(MisfitGrid {
        // The columns run past 180 degrees (the normalised west edge is below 180).
        crosses_antimeridian: b.east_deg > 180.0,
        bounds: b,
        n_lat,
        n_lon,
        lat_step_deg: lat_step,
        lon_step_deg: lon_step,
        grid_min: GridNode {
            i: gi,
            j: gj,
            lat_deg: lat_deg[gi],
            lon_deg: lon_deg[gj],
            chi2: grid_min_value,
            delta_chi2: grid_min_value - min.chi2,
        },
        lat_deg,
        lon_deg,
        chi2,
        min,
        basins,
        unknowns,
        dof,
        levels,
        bias_profiled: model.bias,
        weighted: model.weighted,
        sights: sights_out,
        notes,
    })
}

/// The misfit at one position, exactly as a grid node there would carry it.
pub fn value_at(sights: &[Sight], options: &MisfitOptions, at: LatLon) -> Result<f64, String> {
    let model = Model::new(sights, options)?;
    Ok(model.value_at(Point::from_deg(at.lat_deg, at.lon_deg)))
}

fn check_axis(name: &str, n: usize) -> Result<(), String> {
    if (2..=MAX_AXIS).contains(&n) {
        Ok(())
    } else {
        Err(format!(
            "{name} must be between 2 and {MAX_AXIS} nodes, got {n}"
        ))
    }
}

/// Index of the lowest finite value (the first, on a tie).
fn lowest_node(values: &[f64]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (k, v) in values.iter().enumerate() {
        if v.is_finite() && best.is_none_or(|b| *v < values[b]) {
            best = Some(k);
        }
    }
    best
}

/// Nodes no higher than any of their (up to eight) neighbours; on a tie the node that
/// comes first in the row-major order wins, so a flat patch yields one minimum.
fn local_minima(values: &[f64], n_lat: usize, n_lon: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for i in 0..n_lat {
        for j in 0..n_lon {
            let idx = i * n_lon + j;
            let x = values[idx];
            if !x.is_finite() {
                continue;
            }
            let rows = i.saturating_sub(1)..=(i + 1).min(n_lat - 1);
            let mut lowest = true;
            'scan: for ii in rows {
                for jj in j.saturating_sub(1)..=(j + 1).min(n_lon - 1) {
                    let k = ii * n_lon + jj;
                    if k == idx {
                        continue;
                    }
                    let y = values[k];
                    if y < x || (y == x && k < idx) {
                        lowest = false;
                        break 'scan;
                    }
                }
            }
            if lowest {
                out.push(idx);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The model: the solver's residuals, evaluated fast on a grid and polished at minima
// ---------------------------------------------------------------------------

struct Term<'a> {
    sight: &'a Sight,
    gha: f64,
    sdec: f64,
    cdec: f64,
    ho: f64,
    sigma: f64,
    /// Robust multiplier.
    w: f64,
    /// `w / sigma^2`, for the profiled bias.
    wn: f64,
}

struct Model<'a> {
    terms: Vec<Term<'a>>,
    bias: bool,
    weighted: bool,
    /// `sum(w / sigma^2)`.
    wn_sum: f64,
}

/// Per row and sight: the products of the observer's and the body's sines and cosines,
/// grouped exactly as `altitude_azimuth` groups them.
#[derive(Clone, Copy, Default)]
struct RowCoef {
    sphi_sdec: f64,
    cphi_cdec: f64,
    cphi_sdec: f64,
    sphi_cdec: f64,
}

/// Per column and sight: `cos LHA` and the east component `-cos(dec) sin LHA`.
#[derive(Clone, Copy, Default)]
struct ColCoef {
    clha: f64,
    east: f64,
}

struct Eval {
    zn: Vec<f64>,
    r: Vec<f64>,
    cost: f64,
}

struct Polished {
    p: Point,
    b: f64,
    chi2: f64,
    converged: bool,
    well_determined: bool,
}

/// The sights the solver uses (its `partition_usable`).
fn usable(s: &Sight) -> bool {
    s.gha_rad.is_finite()
        && s.dec_rad.is_finite()
        && s.ho_rad.is_finite()
        && s.sigma_rad.is_finite()
        && s.sigma_rad > 0.0
}

impl<'a> Model<'a> {
    fn new(sights: &'a [Sight], options: &MisfitOptions) -> Result<Self, String> {
        if let Some(w) = &options.weights
            && w.len() != sights.len()
        {
            return Err(format!(
                "weights: {} given for {} sights (one per sight, in order)",
                w.len(),
                sights.len()
            ));
        }
        let mut terms = Vec::new();
        for (k, s) in sights.iter().enumerate() {
            if !usable(s) {
                continue;
            }
            let w = options.weights.as_ref().map_or(1.0, |w| w[k]);
            if !(w.is_finite() && w >= 0.0) {
                return Err(format!(
                    "weights: the weight of sight {} must be finite and not negative, got {w}",
                    s.id
                ));
            }
            let (sdec, cdec) = s.dec_rad.sin_cos();
            terms.push(Term {
                sight: s,
                gha: s.gha_rad,
                sdec,
                cdec,
                ho: s.ho_rad,
                sigma: s.sigma_rad,
                w,
                wn: w / (s.sigma_rad * s.sigma_rad),
            });
        }
        if terms.is_empty() {
            return Err(
                "no usable sights: every sight has a non-finite value or a sigma that is not \
                 positive, so there is no misfit to map"
                    .to_string(),
            );
        }
        let wn_sum: f64 = terms.iter().map(|t| t.wn).sum();
        if wn_sum.is_nan() || wn_sum <= 0.0 {
            return Err("weights: every sight has weight 0, so nothing is fitted".to_string());
        }
        Ok(Model {
            terms,
            bias: options.estimate_shared_bias,
            weighted: options.weights.is_some(),
            wn_sum,
        })
    }

    /// Fill `out` (row-major, `lat_rad.len()` rows of `lon_rad.len()`).
    fn fill(&self, lat_rad: &[f64], lon_rad: &[f64], out: &mut [f64]) {
        let n = self.terms.len();
        let n_lon = lon_rad.len();
        let mut cols = vec![ColCoef::default(); n_lon * n];
        for (&lon, col) in lon_rad.iter().zip(cols.chunks_exact_mut(n)) {
            for (c, t) in col.iter_mut().zip(&self.terms) {
                // The solver: `lha = gha + observer.lon`.
                let (slha, clha) = (t.gha + lon).sin_cos();
                *c = ColCoef {
                    clha,
                    east: -t.cdec * slha,
                };
            }
        }
        let mut rows = vec![RowCoef::default(); n];
        let mut d = vec![0.0; n];
        for (&lat, out_row) in lat_rad.iter().zip(out.chunks_exact_mut(n_lon)) {
            let (sphi, cphi) = lat.sin_cos();
            for (r, t) in rows.iter_mut().zip(&self.terms) {
                *r = RowCoef {
                    sphi_sdec: sphi * t.sdec,
                    cphi_cdec: cphi * t.cdec,
                    cphi_sdec: cphi * t.sdec,
                    sphi_cdec: sphi * t.cdec,
                };
            }
            for (cell, col) in out_row.iter_mut().zip(cols.chunks_exact(n)) {
                *cell = if self.bias {
                    for ((r, c), (t, dk)) in rows.iter().zip(col).zip(self.terms.iter().zip(&mut d))
                    {
                        *dk = t.ho - altitude(r, c);
                    }
                    self.profiled(&d)
                } else {
                    let mut acc = 0.0;
                    for ((r, c), t) in rows.iter().zip(col).zip(&self.terms) {
                        let dk = t.ho - altitude(r, c);
                        acc += t.wn * dk * dk;
                    }
                    acc
                };
            }
        }
    }

    /// `Ho - Hc` for every sight at `p`, with the grid's arithmetic.
    fn departures(&self, p: Point) -> Vec<f64> {
        let (sphi, cphi) = p.lat.sin_cos();
        self.terms
            .iter()
            .map(|t| {
                let (slha, clha) = (t.gha + p.lon).sin_cos();
                let r = RowCoef {
                    sphi_sdec: sphi * t.sdec,
                    cphi_cdec: cphi * t.cdec,
                    cphi_sdec: cphi * t.sdec,
                    sphi_cdec: sphi * t.cdec,
                };
                let c = ColCoef {
                    clha,
                    east: -t.cdec * slha,
                };
                t.ho - altitude(&r, &c)
            })
            .collect()
    }

    /// The misfit of departures `d`, with the bias that fits them best.
    fn profiled(&self, d: &[f64]) -> f64 {
        let b = self.bias_for(d);
        let mut acc = 0.0;
        for (t, dk) in self.terms.iter().zip(d) {
            let e = dk - b;
            acc += t.wn * e * e;
        }
        acc
    }

    /// The bias that fits best, given the departures `Ho - Hc` (the order of [`Model::fill`]).
    fn bias_for(&self, d: &[f64]) -> f64 {
        let mut num = 0.0;
        for (t, dk) in self.terms.iter().zip(d) {
            num += t.wn * dk;
        }
        num / self.wn_sum
    }

    /// The bias that fits best at `p`.
    fn best_bias(&self, p: Point) -> f64 {
        self.bias_for(&self.departures(p))
    }

    /// The map's value at `p`: the same arithmetic, in the same order, as [`Model::fill`].
    fn value_at(&self, p: Point) -> f64 {
        let d = self.departures(p);
        if self.bias {
            return self.profiled(&d);
        }
        let mut acc = 0.0;
        for (t, dk) in self.terms.iter().zip(&d) {
            acc += t.wn * dk * dk;
        }
        acc
    }

    fn n_params(&self) -> usize {
        if self.bias { 3 } else { 2 }
    }

    /// Residuals, azimuths and weighted cost at `(p, b)`, as the solver's `Model::eval`.
    fn eval(&self, p: Point, b: f64) -> Eval {
        let mut zn = Vec::with_capacity(self.terms.len());
        let mut r = Vec::with_capacity(self.terms.len());
        let mut cost = 0.0;
        for t in &self.terms {
            let (h, z) = altitude_azimuth(p, t.gha, t.dec());
            let ri = t.ho - h - b;
            let u = ri / t.sigma;
            cost += t.w * u * u;
            zn.push(z);
            r.push(ri);
        }
        Eval { zn, r, cost }
    }

    /// Normal equations `A dx = g` in the tangent plane (north, east[, bias]).
    fn normal(&self, e: &Eval) -> (Vec<Vec<f64>>, Vec<f64>) {
        let m = self.n_params();
        let mut a = vec![vec![0.0f64; m]; m];
        let mut g = vec![0.0f64; m];
        for (k, t) in self.terms.iter().enumerate() {
            let (cn, ce) = tangent_row(e.zn[k]);
            let row = [cn, ce, 1.0];
            for i in 0..m {
                g[i] += t.wn * row[i] * e.r[k];
                for j in 0..m {
                    a[i][j] += t.wn * row[i] * row[j];
                }
            }
        }
        (a, g)
    }

    /// The solver's damped Gauss-Newton iteration from `start`, under this model.
    fn polish(&self, start: Point, max_iterations: u32, tol: f64) -> Option<Polished> {
        let m = self.n_params();
        let mut p = start;
        let mut b = if self.bias { self.best_bias(p) } else { 0.0 };
        let mut e = self.eval(p, b);
        if !e.cost.is_finite() {
            return None;
        }
        let mut lambda = LM_LAMBDA_INIT;
        let mut converged = false;
        for _ in 0..max_iterations {
            let (a, g) = self.normal(&e);
            let dmax = (0..m).fold(0.0f64, |acc, i| acc.max(a[i][i]));
            if !(dmax.is_finite() && dmax > 0.0) {
                break;
            }
            let mut accepted = false;
            for _trial in 0..LM_MAX_TRIALS {
                let mut ad = a.clone();
                for (i, row) in ad.iter_mut().enumerate() {
                    row[i] = a[i][i] + lambda * dmax;
                }
                let step = linalg::solve_sym_pd(&ad, &g).and_then(|dx| {
                    let raw = dx[0].hypot(dx[1]);
                    raw.is_finite().then_some((dx, raw))
                });
                let Some((dx, raw)) = step else {
                    lambda *= 10.0;
                    if lambda > LM_LAMBDA_MAX {
                        break;
                    }
                    continue;
                };
                let f = if raw > MAX_POSITION_STEP_RAD {
                    MAX_POSITION_STEP_RAD / raw
                } else {
                    1.0
                };
                let (dn, de) = (dx[0] * f, dx[1] * f);
                let db = if self.bias { dx[2] } else { 0.0 };
                let trial_p = apply_tangent_step(p, dn, de);
                let trial_b = b + db;
                let trial = self.eval(trial_p, trial_b);
                if trial.cost.is_finite() && trial.cost <= e.cost {
                    converged = dn.hypot(de).hypot(db.abs()) < tol;
                    p = trial_p;
                    b = trial_b;
                    e = trial;
                    lambda = (lambda / 5.0).max(LM_LAMBDA_MIN);
                    accepted = true;
                    break;
                }
                lambda *= 10.0;
                if lambda > LM_LAMBDA_MAX {
                    break;
                }
            }
            if converged {
                break;
            }
            if !accepted {
                // No damped step lowers the cost: a minimum to floating-point precision.
                converged = true;
                break;
            }
        }

        // Does the fit determine a point here? The rank test the solver applies.
        let mut jw = Vec::with_capacity(self.terms.len());
        for (t, &z) in self.terms.iter().zip(&e.zn) {
            let (cn, ce) = tangent_row(z);
            let s = t.w.max(0.0).sqrt() / t.sigma;
            let mut row = vec![cn * s, ce * s];
            if self.bias {
                row.push(s);
            }
            jw.push(row);
        }
        let c = uncertainty::conditioning(&jw, &e.zn);
        let well_determined = c.rank == m
            && c.condition_number.is_finite()
            && c.condition_number < WELL_DETERMINED_CONDITION;
        let b = if self.bias { self.best_bias(p) } else { 0.0 };
        Some(Polished {
            p,
            b,
            chi2: self.value_at(p),
            converged,
            well_determined,
        })
    }
}

impl Term<'_> {
    fn dec(&self) -> f64 {
        self.sight.dec_rad
    }
}

/// `Hc` from the row and column products: `geometry::altitude_azimuth`'s components, the
/// angle as `atan(up / cos h)` (see the module documentation).
#[inline(always)]
fn altitude(r: &RowCoef, c: &ColCoef) -> f64 {
    let up = r.sphi_sdec + r.cphi_cdec * c.clha;
    let north = r.cphi_sdec - r.sphi_cdec * c.clha;
    // cos h >= 0; at the zenith it is 0 and up / 0 = +inf gives exactly pi / 2.
    let cos_h = (north * north + c.east * c.east).sqrt();
    (up / cos_h).atan()
}

// ---------------------------------------------------------------------------
// From a solve
// ---------------------------------------------------------------------------

/// The map that goes with a solve: the solver's model (shared bias; its final Huber
/// weights when it reweighted), its minima as seeds, and its clustering radius. The
/// strings are notes to show with the map.
pub fn options_for_solve(
    sights: &[Sight],
    options: &SolveOptions,
    result: &FixResult,
) -> (MisfitOptions, Vec<String>) {
    let mut notes = Vec::new();
    let mut seeds = Vec::new();
    let mut weights = None;
    match result {
        FixResult::Unique {
            fix, alternatives, ..
        } => {
            seeds.push(fix.position);
            if let Some(prior) = &fix.prior
                && let Some(p) = prior.fix_without_prior
            {
                seeds.push(p);
            }
            seeds.extend(alternatives.iter().map(|a| a.position));
            if fix.robust.is_some() {
                match final_weights(sights, fix) {
                    Some(w) => weights = Some(w),
                    None => notes.push(
                        "The solver's final robust weights could not be matched to the sights, \
                         so this map weights every sight equally."
                            .to_string(),
                    ),
                }
            }
        }
        FixResult::Ambiguous { candidates, .. } => {
            seeds.extend(candidates.iter().map(|c| c.position));
        }
        FixResult::Underdetermined { .. } | FixResult::Failed { .. } => {}
    }
    let reweighted = matches!(result, FixResult::Unique { fix, .. } if fix.robust.is_some());
    if options.robust.is_some() && !reweighted {
        notes.push(
            "Robust weighting was asked for, but the solver reweights only a unique fix, so \
             this map weights every sight equally."
                .to_string(),
        );
    }
    if options.prior.is_some() {
        notes.push(
            "The prior is not part of this map, which shows how well each point fits the sights \
             alone. The fix with the prior is pulled toward the prior's centre; the fix without \
             it is at this map's best point."
                .to_string(),
        );
    }
    if options.clock_uncertainty_s.is_finite() && options.clock_uncertainty_s > 0.0 {
        notes.push(format!(
            "The clock's stated uncertainty ({} s) widens the solver's ellipse east-west, but it \
             is not a residual, so it does not widen this map.",
            options.clock_uncertainty_s
        ));
    }
    let cluster_radius_nm = if options.multistart.cluster_radius_nm.is_finite()
        && options.multistart.cluster_radius_nm > 0.0
    {
        options.multistart.cluster_radius_nm
    } else {
        10.0
    };
    (
        MisfitOptions {
            estimate_shared_bias: options.estimate_shared_bias,
            weights,
            seeds,
            cluster_radius_nm,
            max_iterations: options.max_iterations,
            step_tolerance_rad: options.step_tolerance_rad,
        },
        notes,
    )
}

/// The solver's final weights, one per entry of `sights` (1 for sights it did not use).
/// `fix.residuals` lists the usable sights in input order; `None` if they do not line up.
fn final_weights(sights: &[Sight], fix: &crate::types::Fix) -> Option<Vec<f64>> {
    let mut out = vec![1.0; sights.len()];
    let mut residuals = fix.residuals.iter();
    for (k, s) in sights.iter().enumerate() {
        if !usable(s) {
            continue;
        }
        let r = residuals.next()?;
        if r.id != s.id {
            return None;
        }
        out[k] = r.weight;
    }
    residuals.next().is_none().then_some(out)
}

/// [`grid`] for a solve's answer: [`options_for_solve`], and [`default_bounds`] round the
/// answer when `bounds` is `None`. The solve's notes come first.
pub fn grid_for_solve(
    sights: &[Sight],
    options: &SolveOptions,
    result: &FixResult,
    bounds: Option<GridBounds>,
    n_lat: usize,
    n_lon: usize,
) -> Result<MisfitGrid, String> {
    let (misfit_options, mut notes) = options_for_solve(sights, options, result);
    let bounds = match bounds {
        Some(b) => b,
        None => default_bounds(sights, result, options.initializer)?.bounds,
    };
    let mut g = grid(sights, &misfit_options, &bounds, n_lat, n_lon)?;
    notes.append(&mut g.notes);
    g.notes = notes;
    Ok(g)
}

// ---------------------------------------------------------------------------
// A default frame
// ---------------------------------------------------------------------------

/// A frame for the map round a solve's answer.
///
/// - A unique fix: centred on it, reaching 1.6 times the largest of the 3-sigma extent of
///   its covariance (clock term removed: the map does not show it), the cocked hat (the
///   farthest pairwise intersection of the circles near the fix, for circles crossing at
///   10 degrees or more) and 3 sigma of the noisiest sight (1' of altitude is 1 NM).
/// - Ambiguous: every candidate within the 95 % margin with that sigma allowance round
///   it, and 15 % of the span added on each side, so every basin is on the map.
/// - No point fix: round the initializer, reaching 1.5 times past the farthest circle's
///   nearest point; with no initializer, the whole first circle.
///
/// A frame that reaches a pole takes every longitude.
pub fn default_bounds(
    sights: &[Sight],
    result: &FixResult,
    initializer: Option<LatLon>,
) -> Result<DefaultBounds, String> {
    let usable: Vec<&Sight> = sights.iter().filter(|s| usable(s)).collect();
    let sigma_nm = usable
        .iter()
        .map(|s| rad_to_nm(s.sigma_rad))
        .fold(0.0f64, f64::max);
    let floor_nm = (3.0 * sigma_nm).max(0.5);
    let initializer = initializer
        .filter(|p| p.lat_deg.is_finite() && p.lon_deg.is_finite() && p.lat_deg.abs() <= 90.0);

    match result {
        FixResult::Unique { fix, .. } => {
            let centre = Point::from_deg(fix.position.lat_deg, fix.position.lon_deg);
            let ellipse_nm = three_sigma_extent_nm(fix);
            let hat_nm = cocked_hat_nm(&usable, centre, 5.0 * ellipse_nm.max(floor_nm));
            let radius_nm = (1.6 * ellipse_nm.max(hat_nm).max(floor_nm)).clamp(0.25, 3000.0);
            Ok(DefaultBounds {
                bounds: frame(
                    &[Anchor {
                        p: centre,
                        r: nm_to_rad(radius_nm),
                    }],
                    0.0,
                ),
                centre: fix.position,
                centred_on: "fix".to_string(),
                radius_nm,
                reason: format!(
                    "centred on the fix, {radius_nm:.2} NM each way: 1.6 times the largest of \
                     the 3-sigma extent of its covariance ({ellipse_nm:.2} NM), the cocked hat \
                     ({hat_nm:.2} NM) and 3 sigma of the noisiest sight ({floor_nm:.2} NM)"
                ),
            })
        }
        FixResult::Ambiguous { candidates, .. } => {
            let chosen: Vec<&FixCandidate> = candidates
                .iter()
                .enumerate()
                .filter(|(k, c)| *k == 0 || c.delta_chi2_from_best <= CHI2_95_2DOF)
                .map(|(_, c)| c)
                .collect();
            if chosen.is_empty() {
                return Err("an ambiguous result with no candidates".to_string());
            }
            let radius_nm = 1.6 * floor_nm;
            let anchors: Vec<Anchor> = chosen
                .iter()
                .map(|c| Anchor {
                    p: Point::from_deg(c.position.lat_deg, c.position.lon_deg),
                    r: nm_to_rad(radius_nm),
                })
                .collect();
            let pad = if anchors.len() > 1 { 0.15 } else { 0.0 };
            Ok(DefaultBounds {
                bounds: frame(&anchors, pad),
                centre: mean_position(&anchors),
                centred_on: "candidates".to_string(),
                radius_nm,
                reason: format!(
                    "every one of the {} candidates within the 95 % margin, {radius_nm:.2} NM \
                     round each{}",
                    chosen.len(),
                    if pad > 0.0 {
                        ", and 15 % of the span beyond them on each side"
                    } else {
                        ""
                    }
                ),
            })
        }
        FixResult::Underdetermined { .. } | FixResult::Failed { .. } => {
            if let Some(init) = initializer {
                let centre = Point::from_deg(init.lat_deg, init.lon_deg);
                let reach_nm = usable
                    .iter()
                    .map(|s| {
                        let gp = geographic_position(s.gha_rad, s.dec_rad);
                        let z = FRAC_PI_2 - s.ho_rad;
                        rad_to_nm((angular_distance(centre, gp) - z).abs())
                    })
                    .fold(0.0f64, f64::max);
                let radius_nm = (1.5 * reach_nm.max(floor_nm)).clamp(0.25, 5400.0);
                Ok(DefaultBounds {
                    bounds: frame(
                        &[Anchor {
                            p: centre,
                            r: nm_to_rad(radius_nm),
                        }],
                        0.0,
                    ),
                    centre: init,
                    centred_on: "initializer".to_string(),
                    radius_nm,
                    reason: format!(
                        "no point fix: centred on the initializer, {radius_nm:.2} NM each way, \
                         1.5 times past the nearest point of the farthest circle ({reach_nm:.2} NM)"
                    ),
                })
            } else if let Some(s) = usable.first() {
                let gp = geographic_position(s.gha_rad, s.dec_rad);
                let r = ((FRAC_PI_2 - s.ho_rad).abs() + nm_to_rad(4.0 * floor_nm)).min(PI);
                Ok(DefaultBounds {
                    bounds: frame(&[Anchor { p: gp, r }], 0.0),
                    centre: LatLon {
                        lat_deg: gp.lat_deg(),
                        lon_deg: gp.lon_deg(),
                    },
                    centred_on: "circle".to_string(),
                    radius_nm: rad_to_nm(r),
                    reason: format!(
                        "no point fix and no initializer: the whole circle of position of {}",
                        s.id
                    ),
                })
            } else {
                Err(
                    "no usable sights and no initializer: there is nothing to centre a map on"
                        .to_string(),
                )
            }
        }
    }
}

/// The 3-sigma extent of a fix's covariance along its major axis, nautical miles, without
/// the clock's east-west term.
fn three_sigma_extent_nm(fix: &crate::types::Fix) -> f64 {
    let c = fix.covariance_ne_m2;
    let clock = fix.clock_sigma_east_m;
    let data = [
        [c[0][0], c[0][1]],
        [c[1][0], (c[1][1] - clock * clock).max(0.0)],
    ];
    if data.iter().flatten().any(|v| !v.is_finite()) {
        return 0.0;
    }
    let (values, _) = linalg::eigen_sym2(data);
    let largest = values[0].max(values[1]).max(0.0);
    (DELTA_CHI2_TWO_UNKNOWNS[2] * largest).sqrt() / NM_M
}

/// The farthest of the pairwise circle intersections nearest `centre`, nautical miles:
/// the navigator's cocked hat. Pairs crossing at less than [`MIN_HAT_CROSSING_DEG`] are
/// left out (two sights of one star a minute apart cross at a fraction of a degree, and an
/// arcminute of noise moves such a crossing hundreds of miles), and so is any crossing
/// beyond `limit_nm`.
fn cocked_hat_nm(usable: &[&Sight], centre: Point, limit_nm: f64) -> f64 {
    let mut distinct: Vec<&Sight> = Vec::new();
    for s in usable {
        let same = distinct
            .iter()
            .any(|k| k.gha_rad == s.gha_rad && k.dec_rad == s.dec_rad && k.ho_rad == s.ho_rad);
        if !same {
            distinct.push(s);
            if distinct.len() >= MAX_HAT_CIRCLES {
                break;
            }
        }
    }
    let min_crossing = MIN_HAT_CROSSING_DEG.to_radians();
    let mut farthest = 0.0f64;
    for (i, a) in distinct.iter().enumerate() {
        for b in &distinct[i + 1..] {
            let z1 = FRAC_PI_2 - a.ho_rad;
            let z2 = FRAC_PI_2 - b.ho_rad;
            if !(z1 > 0.0 && z1 < PI && z2 > 0.0 && z2 < PI) {
                continue;
            }
            let (gp1, gp2) = (
                geographic_position(a.gha_rad, a.dec_rad),
                geographic_position(b.gha_rad, b.dec_rad),
            );
            let p = match two_circle_intersections(gp1, z1, gp2, z2, 1e-9) {
                CircleIntersection::Two(p, q) => {
                    if angular_distance(centre, p) <= angular_distance(centre, q) {
                        p
                    } else {
                        q
                    }
                }
                _ => continue,
            };
            // The circles cross at the difference of the bodies' azimuths from there.
            let turn = (initial_bearing(p, gp1) - initial_bearing(p, gp2)).rem_euclid(PI);
            if turn.min(PI - turn) < min_crossing {
                continue;
            }
            let d_nm = rad_to_nm(angular_distance(centre, p));
            if d_nm <= limit_nm {
                farthest = farthest.max(d_nm);
            }
        }
    }
    farthest
}

/// A point to frame and the radius (radians of arc) to keep round it.
struct Anchor {
    p: Point,
    r: f64,
}

fn mean_position(anchors: &[Anchor]) -> LatLon {
    let mut v = [0.0; 3];
    for a in anchors {
        for (vk, uk) in v.iter_mut().zip(a.p.to_unit()) {
            *vk += uk;
        }
    }
    let norm = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let p = if norm > 1e-9 {
        Point::from_unit(v)
    } else {
        anchors[0].p
    };
    LatLon {
        lat_deg: p.lat_deg(),
        lon_deg: p.lon_deg(),
    }
}

/// The smallest box holding a cap of radius `r` round every anchor, widened by `pad` of its
/// span on each side. A cap that reaches a pole takes every longitude.
fn frame(anchors: &[Anchor], pad: f64) -> GridBounds {
    let mut south = 90.0f64;
    let mut north = -90.0f64;
    let mut intervals: Vec<(f64, f64)> = Vec::new();
    let mut every_longitude = false;
    for a in anchors {
        let lat = a.p.lat_deg();
        let r = rad_to_deg(a.r);
        south = south.min((lat - r).max(-90.0));
        north = north.max((lat + r).min(90.0));
        if lat.abs() + r >= 90.0 - 1e-9 {
            every_longitude = true;
            continue;
        }
        // The widest longitude on a small circle of radius r round (lat, lon).
        let dlon = rad_to_deg((a.r.sin() / a.p.lat.cos()).clamp(-1.0, 1.0).asin());
        intervals.push((a.p.lon_deg() - dlon, 2.0 * dlon));
    }
    let lat_pad = pad * (north - south);
    south = (south - lat_pad).max(-90.0);
    north = (north + lat_pad).min(90.0);
    let whole = |south: f64, north: f64| GridBounds {
        south_deg: south,
        north_deg: north,
        west_deg: -180.0,
        east_deg: 180.0,
    };
    if every_longitude || intervals.is_empty() {
        return whole(south, north);
    }
    let Some((west, span)) = smallest_arc(&intervals) else {
        return whole(south, north);
    };
    let padded = span * (1.0 + 2.0 * pad);
    if padded >= 360.0 {
        return whole(south, north);
    }
    let west = west - pad * span;
    GridBounds {
        south_deg: south,
        north_deg: north,
        west_deg: west,
        east_deg: west + padded,
    }
    .normalized()
    .unwrap_or_else(|_| whole(south, north))
}

/// The shortest arc of longitude covering every `(start, length)` interval, as
/// `(west, span)` degrees, or `None` when they cover the whole circle.
fn smallest_arc(intervals: &[(f64, f64)]) -> Option<(f64, f64)> {
    let mut iv: Vec<(f64, f64)> = intervals
        .iter()
        .map(|&(start, len)| {
            let s = start.rem_euclid(360.0);
            (s, s + len.max(0.0))
        })
        .collect();
    iv.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (s, e) in iv {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    let m = merged.len();
    let mut best_gap = f64::NEG_INFINITY;
    let mut after = 0;
    for k in 0..m {
        let gap = if k + 1 < m {
            merged[k + 1].0 - merged[k].1
        } else {
            merged[0].0 + 360.0 - merged[k].1
        };
        if gap > best_gap {
            best_gap = gap;
            after = (k + 1) % m;
        }
    }
    if best_gap <= 0.0 {
        return None;
    }
    Some((merged[after].0, 360.0 - best_gap))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::arcmin_to_rad;

    fn sight(id: &str, truth: Point, zn_deg: f64, alt_deg: f64, sigma_arcmin: f64) -> Sight {
        let gp =
            crate::geometry::destination(truth, zn_deg.to_radians(), (90.0 - alt_deg).to_radians());
        Sight {
            id: id.to_string(),
            body: format!("sim-{id}"),
            gha_rad: crate::units::norm_2pi(-gp.lon),
            dec_rad: gp.lat,
            ho_rad: alt_deg.to_radians(),
            sigma_rad: arcmin_to_rad(sigma_arcmin),
            gha_rate_rad_per_s: 0.0,
        }
    }

    #[test]
    fn bounds_normalise_across_the_antimeridian_and_reject_nonsense() {
        let b = GridBounds {
            south_deg: -10.0,
            north_deg: 10.0,
            west_deg: 170.0,
            east_deg: -170.0,
        }
        .normalized()
        .unwrap();
        assert_eq!((b.west_deg, b.east_deg), (170.0, 190.0));
        let same = GridBounds {
            east_deg: 190.0,
            ..b
        }
        .normalized()
        .unwrap();
        assert_eq!(same, b);
        let whole = GridBounds {
            south_deg: -90.0,
            north_deg: 90.0,
            west_deg: -180.0,
            east_deg: 180.0,
        }
        .normalized()
        .unwrap();
        assert_eq!((whole.west_deg, whole.lon_span_deg()), (-180.0, 360.0));
        let west_180 = GridBounds {
            west_deg: 180.0,
            east_deg: -170.0,
            ..b
        }
        .normalized()
        .unwrap();
        assert_eq!((west_180.west_deg, west_180.east_deg), (-180.0, -170.0));
        for bad in [
            GridBounds {
                north_deg: -20.0,
                ..b
            },
            GridBounds {
                south_deg: -91.0,
                ..b
            },
            GridBounds {
                west_deg: f64::NAN,
                ..b
            },
            GridBounds {
                west_deg: 0.0,
                east_deg: 400.0,
                ..b
            },
        ] {
            assert!(bad.normalized().is_err(), "{bad:?}");
        }
        assert!(b.contains(LatLon {
            lat_deg: 0.0,
            lon_deg: -175.0
        }));
        assert!(b.contains(LatLon {
            lat_deg: 0.0,
            lon_deg: 180.0
        }));
        assert!(!b.contains(LatLon {
            lat_deg: 0.0,
            lon_deg: 160.0
        }));
    }

    #[test]
    fn a_node_carries_what_the_solver_computes_there() {
        let truth = Point::from_deg(39.95, -75.17);
        let mut sights: Vec<Sight> = [(30.0, 40.0), (120.0, 55.0), (200.0, 35.0), (290.0, 60.0)]
            .iter()
            .enumerate()
            .map(|(k, &(zn, alt))| sight(&format!("s{k}"), truth, zn, alt, 0.7 + 0.1 * k as f64))
            .collect();
        // One body almost overhead, where atan2 and atan part company if either is careless.
        sights.push(sight("zenith", truth, 10.0, 89.99, 0.5));
        let bounds = GridBounds {
            south_deg: 39.5,
            north_deg: 40.5,
            west_deg: -75.9,
            east_deg: -74.4,
        };
        let g = grid(&sights, &MisfitOptions::default(), &bounds, 7, 9).unwrap();
        for i in 0..g.n_lat {
            for j in 0..g.n_lon {
                let p = Point::from_deg(g.lat_deg[i], g.lon_deg[j]);
                // The solver's own arithmetic (solver::Model::eval with b = 0, weights 1).
                let mut chi2 = 0.0;
                for s in &sights {
                    let (h, _) = altitude_azimuth(p, s.gha_rad, s.dec_rad);
                    let u = (s.ho_rad - h - 0.0) / s.sigma_rad;
                    chi2 += u * u;
                }
                let node = g.chi2[i * g.n_lon + j];
                assert!(
                    (node - chi2).abs() <= 1e-12 * chi2.max(1.0),
                    "node {i},{j}: {node} vs {chi2}"
                );
            }
        }
    }

    #[test]
    fn local_minima_break_ties_and_see_the_edges() {
        #[rustfmt::skip]
        let v = [
            5.0, 4.0, 4.0, 9.0,
            6.0, 7.0, 8.0, 1.0,
            3.0, 7.0, 7.0, 2.0,
        ];
        // The top edge's plateau of 4s is one minimum, at its first node.
        assert_eq!(local_minima(&v, 3, 4), vec![1, 7, 8]);
        let flat = [2.0; 6];
        assert_eq!(local_minima(&flat, 2, 3), vec![0]);
        assert_eq!(lowest_node(&[f64::NAN, 3.0, 1.0, 1.0]), Some(2));
        assert_eq!(lowest_node(&[f64::NAN]), None);
    }

    #[test]
    fn the_smallest_arc_takes_the_short_way_round() {
        // 170 to 175 E and 178 to 174 W: 170 E eastward to 174 W is 16 degrees.
        let (w, s) = smallest_arc(&[(170.0, 5.0), (-178.0, 4.0)]).unwrap();
        assert!(
            (w - 170.0).abs() < 1e-12 && (s - 16.0).abs() < 1e-12,
            "{w} {s}"
        );
        let (w, s) = smallest_arc(&[(-80.0, 10.0), (0.0, 10.0)]).unwrap();
        assert!(
            (w - 280.0).abs() < 1e-12 && (s - 90.0).abs() < 1e-12,
            "{w} {s}"
        );
        assert!(smallest_arc(&[(0.0, 200.0), (180.0, 200.0)]).is_none());
    }

    #[test]
    fn the_levels_are_the_chi_square_quantiles() {
        // Two degrees of freedom: P(chi2 <= x) = 1 - exp(-x / 2).
        for (x, p) in DELTA_CHI2_TWO_UNKNOWNS.iter().zip(LEVEL_CONFIDENCE) {
            assert!((1.0 - (-x / 2.0).exp() - p).abs() < 1e-9, "{x}");
        }
        // Three: P = erf(sqrt(x/2)) - sqrt(2x/pi) exp(-x/2); erf from its series.
        let erf = |x: f64| -> f64 {
            let mut sum = 0.0;
            let mut term = x;
            for n in 0..200 {
                sum += term / (2 * n + 1) as f64;
                term *= -x * x / (n + 1) as f64;
            }
            2.0 / PI.sqrt() * sum
        };
        for (x, p) in DELTA_CHI2_THREE_UNKNOWNS.iter().zip(LEVEL_CONFIDENCE) {
            let cdf = erf((x / 2.0).sqrt()) - (2.0 * x / PI).sqrt() * (-x / 2.0).exp();
            assert!((cdf - p).abs() < 1e-9, "{x}: {cdf}");
        }
    }
}
