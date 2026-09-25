//! SkyFix Lab numerical core.
//!
//! Everything here is pure computation over `f64`: no files, no network, no clocks.
//! The conventions in `docs/CONVENTIONS.md` are normative; each module states the
//! section it implements.
//!
//! Module map (owners fill the stubs; signatures in `types` are the shared contract):
//! - [`units`]      section 1: constants and angle conversions
//! - [`time`]       sections 6 and 15.2: timestamps, the UTC/UT clock, leap seconds, TT, UT1, DUT1
//! - [`deltat`]     section 15.2: Delta-T with its uncertainty, the IERS UT1 - UTC history
//! - [`calendar`]   section 15.3: Julian and Gregorian dates for any year
//! - [`geometry`]   sections 2-3: altitude/azimuth, partials, circles, intersections
//! - [`types`]      sections 4, 8-10, 12: session model, results, warnings
//! - [`corrections`] section 5: the correction chain
//! - [`reduce`]     sections 3-5: observation -> reduced sight
//! - [`session`]    section 10: validation and CSV round-trip
//! - [`sights`]     Moon and planet sight tools: predicted sextant readings, lunar distance
//! - [`solver`]     section 8: weighted least squares, multistart, ambiguity
//! - [`uncertainty`] section 9: covariance, ellipse, conditioning
//! - [`linalg`]     small dense linear algebra used by the two modules above
//! - [`misfit`]     sections 8-9: the solver's misfit on a lat/lon grid (residual heat map)
//! - [`planner`]    observation planner (optional deliverable)
//! - [`methods`]    noon sight, Polaris latitude, averaging a run (docs/NAVIGATION_METHODS.md)

pub mod calendar;
pub mod corrections;
pub mod deltat;
pub mod error;
pub mod geometry;
pub mod linalg;
pub mod methods;
pub mod misfit;
pub mod planner;
pub mod reduce;
pub mod session;
pub mod sights;
pub mod solver;
pub mod time;
pub mod types;
pub mod uncertainty;
pub mod units;

pub use error::SkyfixError;

/// Crate version string, surfaced by the CLI and the WASM adapter.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
