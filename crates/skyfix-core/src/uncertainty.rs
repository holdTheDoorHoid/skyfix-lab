//! CONVENTIONS section 9: covariance, nominal 95 % ellipse, conditioning.
//!
//! OWNER: core-solver agent.

use crate::types::{Conditioning, ErrorEllipse};

/// 2x2 symmetric covariance (metres^2, north/east) -> nominal 95 % ellipse.
/// Returns `None` when the matrix is not positive definite.
pub fn ellipse_95(cov_ne_m2: [[f64; 2]; 2]) -> Option<ErrorEllipse> {
    todo!("core-solver: ellipse_95")
}

/// Conditioning of a weighted Jacobian (rows = sights, columns = unknowns).
pub fn conditioning(weighted_jacobian: &[Vec<f64>], azimuths_rad: &[f64]) -> Conditioning {
    todo!("core-solver: conditioning")
}
