//! SkyFix Lab numerical core.
//!
//! Everything here is pure computation over `f64`: no files, no network, no clocks.
//! The conventions in `docs/CONVENTIONS.md` are normative; each module states the
//! section it implements.
//!
//! Module map (owners fill the stubs; signatures in `types` are the shared contract):
//! - [`units`]      section 1: constants and angle conversions
//! - [`time`]       section 6: UTC parsing, Julian dates, leap seconds, TT
//! - [`geometry`]   sections 2-3: altitude/azimuth, partials, circles, intersections
//! - [`types`]      sections 4, 8-10, 12: session model, results, warnings
//! - [`corrections`] section 5: the correction chain
//! - [`reduce`]     sections 3-5: observation -> reduced sight
//! - [`session`]    section 10: validation and CSV round-trip
//! - [`solver`]     section 8: weighted least squares, multistart, ambiguity
//! - [`uncertainty`] section 9: covariance, ellipse, conditioning
//! - [`planner`]    observation planner (optional deliverable)

pub mod corrections;
pub mod error;
pub mod geometry;
pub mod planner;
pub mod reduce;
pub mod session;
pub mod solver;
pub mod time;
pub mod types;
pub mod uncertainty;
pub mod units;

pub use error::SkyfixError;

/// Crate version string, surfaced by the CLI and the WASM adapter.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
