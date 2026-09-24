//! CONVENTIONS section 9: covariance, nominal 95 % ellipse, conditioning.
//!
//! OWNER: core-solver agent.
//!
//! The covariance itself is assembled by [`crate::solver`] from the normal equations
//! (`Cov = (J^T W J)^-1`, a priori, in tangent-plane metres, north/east). This module
//! turns that 2x2 matrix into the labelled 95 % ellipse and reports how well the sight
//! geometry determines a position at all.

use crate::linalg;
use crate::types::{Conditioning, ErrorEllipse};
use crate::units::{CHI2_95_2DOF, NM_M, norm_360};
use std::cmp::Ordering;

/// The only string the project uses for the ellipse model, so the CLI, the WASM adapter
/// and the UI cannot describe it differently (section 9).
pub const ELLIPSE_MODEL: &str = "nominal 95 %, independent-noise model";

/// Relative tolerance on the singular values when counting the numerical rank.
pub const RANK_TOLERANCE_REL: f64 = 1e-10;

/// Condition number above which the geometry is called poor (section 9 diagnostics).
pub const POOR_GEOMETRY_CONDITION: f64 = 20.0;

/// Azimuth gap above which the geometry is called poor: every body on one side.
pub const POOR_GEOMETRY_GAP_DEG: f64 = 180.0;

/// 2x2 symmetric covariance (metres^2, north/east) -> nominal 95 % ellipse.
/// Returns `None` when the matrix is not positive definite.
pub fn ellipse_95(cov_ne_m2: [[f64; 2]; 2]) -> Option<ErrorEllipse> {
    if cov_ne_m2.iter().flatten().any(|v| !v.is_finite()) {
        return None;
    }
    let (values, vectors) = linalg::eigen_sym2(cov_ne_m2);
    if values[1].is_nan() || values[1] <= 0.0 || !values[0].is_finite() {
        return None;
    }
    // Major axis = first eigenvector (column 0), components (north, east).
    let (vn, ve) = (vectors[0][0], vectors[1][0]);
    let orientation_deg = ve.atan2(vn).to_degrees().rem_euclid(180.0);
    Some(ErrorEllipse {
        semi_major_m: (CHI2_95_2DOF * values[0]).sqrt(),
        semi_minor_m: (CHI2_95_2DOF * values[1]).sqrt(),
        orientation_deg,
        confidence: 0.95,
        model: ELLIPSE_MODEL.to_string(),
    })
}

/// Conditioning of a weighted Jacobian (rows = sights, columns = unknowns).
///
/// `weighted_jacobian` is `W^(1/2) J`: row `i` is `[cos Zn_i, sin Zn_i] / sigma_i`, with a
/// third column `1 / sigma_i` when a shared altitude bias is being estimated. Passing the
/// bias column is what makes the report show the collinearity between a shared bias and
/// position when the azimuth spread is poor.
///
/// `geometric_dilution_m_per_arcmin` is deliberately **geometry only**: the position rows
/// are renormalised to unit length (recovering `[cos Zn, sin Zn]` exactly, whatever the
/// sigmas were), so the number answers "how many metres of position error does one
/// arcminute of altitude error buy me, given these azimuths". A value of 1852 m (1 NM per
/// arcminute) is the ideal.
pub fn conditioning(weighted_jacobian: &[Vec<f64>], azimuths_rad: &[f64]) -> Conditioning {
    let columns = weighted_jacobian.first().map(|r| r.len()).unwrap_or(0);
    let singular_values = linalg::singular_values(weighted_jacobian);
    let smax = singular_values.first().copied().unwrap_or(0.0);
    let smin = singular_values.last().copied().unwrap_or(0.0);
    let tol = RANK_TOLERANCE_REL * smax;
    let rank = singular_values.iter().filter(|&&s| s > tol).count();
    let condition_number = if rank == columns && smin > 0.0 {
        smax / smin
    } else {
        f64::INFINITY
    };

    // Geometry-only dilution: strip the weights from the position columns.
    let mut geom: Vec<Vec<f64>> = Vec::with_capacity(weighted_jacobian.len());
    for row in weighted_jacobian {
        if row.len() < 2 {
            continue;
        }
        let norm = row[0].hypot(row[1]);
        if norm > 0.0 && norm.is_finite() {
            geom.push(vec![row[0] / norm, row[1] / norm]);
        }
    }
    // An empty Jacobian (no usable sights) has no geometry to speak of.
    let geometric_dilution_m_per_arcmin = if geom.is_empty() {
        f64::INFINITY
    } else {
        match linalg::invert_sym_pd(&linalg::gram(&geom)) {
            // trace((J^T J)^-1) is in (radians of position)^2 per (radian of altitude)^2;
            // one arcminute of altitude is one nautical mile of position at unit dilution.
            Some(inv) if inv.len() >= 2 => (inv[0][0] + inv[1][1]).sqrt() * NM_M,
            _ => f64::INFINITY,
        }
    };

    Conditioning {
        singular_values,
        condition_number,
        rank,
        geometric_dilution_m_per_arcmin,
        max_azimuth_gap_deg: max_azimuth_gap_deg(azimuths_rad),
        columns: describe_columns(columns),
    }
}

/// Largest gap between consecutive sight azimuths, degrees, measured around the circle.
/// Fewer than two azimuths means every observation points one way: 360.
pub fn max_azimuth_gap_deg(azimuths_rad: &[f64]) -> f64 {
    let mut a: Vec<f64> = azimuths_rad
        .iter()
        .filter(|z| z.is_finite())
        .map(|z| norm_360(z.to_degrees()))
        .collect();
    if a.len() < 2 {
        return 360.0;
    }
    a.sort_by(|x, y| x.partial_cmp(y).unwrap_or(Ordering::Equal));
    let mut gap = 360.0 - a[a.len() - 1] + a[0];
    for w in a.windows(2) {
        gap = gap.max(w[1] - w[0]);
    }
    gap
}

fn describe_columns(columns: usize) -> String {
    match columns {
        2 => "position (north, east)".to_string(),
        3 => "position (north, east) and shared bias".to_string(),
        n => format!("{n} unknowns"),
    }
}

/// `true` when the geometry is poor enough to deserve `Warning::PoorGeometry`.
pub fn is_poor_geometry(c: &Conditioning) -> bool {
    c.condition_number.is_nan()
        || c.condition_number > POOR_GEOMETRY_CONDITION
        || c.max_azimuth_gap_deg > POOR_GEOMETRY_GAP_DEG
}

#[cfg(test)]
mod empty_jacobian {
    #[test]
    fn conditioning_of_nothing_does_not_panic() {
        let c = super::conditioning(&[], &[]);
        assert_eq!(c.rank, 0);
        assert!(c.condition_number.is_infinite());
        assert!(c.geometric_dilution_m_per_arcmin.is_infinite());
        assert_eq!(c.max_azimuth_gap_deg, 360.0);
    }
}
