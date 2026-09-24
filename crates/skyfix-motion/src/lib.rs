//! Module C: motion and independent navigation checks.
//!
//! OWNER: motion agent. Relative motion, absolute heading and absolute position are
//! distinct measurement types. The first output is "two estimates disagree beyond their
//! modelled uncertainty", never a diagnosis.
//!
//! `docs/MOTION.md` is the normative description of everything below: the dead-reckoning
//! model and its covariance, the advance-the-GP approximation and its measured error, the
//! disagreement statistic, and the fixed list of causes the statistic cannot separate.
//! `docs/CONVENTIONS.md` remains normative for units, signs, time and the solver.
//!
//! # The three measurement types (BRIEF section C)
//!
//! | type | what it fixes | what it can never supply on its own |
//! |---|---|---|
//! | [`compare::AbsolutePosition`] | where you are, in one frame | nothing more; it already carries a frame |
//! | [`compare::RelativeDisplacement`] | how far and which way you moved | the absolute position, and — for a monocular sensor — the metric scale |
//! | [`compare::AbsoluteHeading`] | which way you point | position, and distance run |
//!
//! They are separate Rust types on purpose. Integrating relative displacements into an
//! absolute position requires a starting absolute position *and* a metric scale;
//! [`compare::integrate_odometry`] refuses rather than inventing one.
//!
//! # Modules
//!
//! - [`track`]: a piecewise-constant-velocity dead-reckoning track, its tangent-plane
//!   displacement, its great-circle advance, and the 2x2 covariance of that displacement.
//! - [`running_fix`]: each sight converted to an equivalent stationary sight at a common
//!   reference time, then handed to `skyfix_core::solver::solve` unchanged.
//! - [`compare`]: the three measurement types, the disagreement statistic, the
//!   indistinguishable-causes statement, and scale-aware odometry integration.
//! - [`replay`]: a celestial fix series replayed against an independently sourced
//!   reference track, with a summary and CSV/JSON export.
//! - [`scenarios`]: the six packaged scenarios (a)-(f), with fixed seeds.
//! - [`rng`]: this crate's own deterministic generator.
//!
//! # The honest caveat
//!
//! Nothing here detects spoofing. A disagreement is a disagreement. The statement this
//! crate emits lists six causes that produce the same number and does not rank them.

pub mod compare;
pub mod replay;
pub mod rng;
pub mod running_fix;
// pub mod scenarios;
pub mod track;

use skyfix_core::geometry::Point;
use skyfix_core::types::LatLon;

/// Crate version string.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Degrees/degrees (`LatLon`, the I/O boundary) to radians (`Point`, the computation).
#[inline]
pub fn to_point(ll: LatLon) -> Point {
    Point::from_deg(ll.lat_deg, ll.lon_deg)
}

/// Radians (`Point`) back to the degrees form used in every result type.
#[inline]
pub fn to_latlon(p: Point) -> LatLon {
    LatLon {
        lat_deg: p.lat_deg(),
        lon_deg: p.lon_deg(),
    }
}
