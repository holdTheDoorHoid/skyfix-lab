//! CONVENTIONS section 8: weighted nonlinear least squares on the sphere.
//!
//! OWNER: core-solver agent. Uses only `geometry` for the model and `uncertainty` for
//! covariance/ellipse/conditioning. Never reads a `Truth`.

use crate::types::{FixResult, Sight, SolveOptions};

/// Solve for a stationary observer position from reduced sights.
pub fn solve(sights: &[Sight], options: &SolveOptions) -> FixResult {
    todo!("core-solver: solve")
}
