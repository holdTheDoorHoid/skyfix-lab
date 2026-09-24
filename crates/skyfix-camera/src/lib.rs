//! Module A: stationary camera sextant (synthetic images first).
//!
//! OWNER: camera agent. Attitude results and position results are separate types and
//! separate functions; identifying stars yields orientation, never location, until an
//! independently measured local vertical or horizon is supplied.
//!
//! # The chain
//!
//! ```text
//! render  -> Image                      (synthetic; truth kept in a separate struct)
//! centroid-> Vec<Centroid>              (pixels, flux, saturation flag)
//! identify-> Identification             (closed world: the 58 catalogue stars)
//! attitude-> Attitude                   (Wahba / Davenport q-method) -- ORIENTATION ONLY
//! vertical-> LocalVertical              (inclinometer or horizon line; NOT from the stars)
//! sights  -> Vec<Observation>           (apparent_ha + electronic_vertical)
//! core    -> reduce + solve             (position, with its own uncertainty)
//! ```
//!
//! # The physical distinction this crate enforces (BRIEF, non-negotiable item 2)
//!
//! [`attitude::solve_attitude`] takes matched star directions and returns an
//! [`attitude::Attitude`]. That type has **no** altitude, latitude or longitude field,
//! and no function in this crate turns an image alone into a position or an altitude.
//! The only way to an altitude is [`sights::altitudes_from_camera`], whose signature
//! *requires* a [`vertical::LocalVertical`] — a value that can only be built from an
//! inclinometer reading, a horizon line, or a caller-supplied vector. None of those
//! come from the stars. There is no default, no `Option`, and no "estimate the vertical
//! from the star field" path, because no such estimate exists: a star field fixes the
//! camera's orientation with respect to the sky and says nothing about which way gravity
//! points.
//!
//! Anything that reads the hidden truth of a render does so through a function that
//! takes [`render::RenderTruth`] (or a field of it) as an explicit argument. The
//! estimator entry points — [`centroid::detect`], [`identify::identify`],
//! [`attitude::solve_attitude`], [`vertical::vertical_from_horizon_line`],
//! [`sights::altitudes_from_camera`] — cannot see it.
//!
//! # Scope and honesty
//!
//! * Images are synthetic. Nothing here has met a real lens, a real sensor or a real
//!   sky. See `docs/CAMERA.md` for the backlog that real imagery would add.
//! * Star identification is **closed world**: the 58 stars of
//!   [`skyfix_ephemeris::catalog`] and their 1653 pair angles. A real camera at this
//!   sensitivity sees hundreds of stars; a production system needs a deeper catalogue
//!   and a proper geometric index. This is the first experiment, not a star tracker.
//! * The simulated inclinometer models a **stationary calibrated instrument**
//!   (BRIEF, non-negotiable item 4). Gravity sensed on an accelerating platform is not
//!   a local vertical, and nothing here pretends otherwise.
//!
//! # Build constraints
//!
//! Builds for `wasm32-unknown-unknown`: no `std::fs`, no threads, no image crates, no
//! new dependencies. Images are `Vec<f64>` with a width and a height; the PGM exporter
//! returns bytes and never touches a file. Randomness comes from [`rng`], a seeded
//! splitmix64 + xoshiro256\*\* generator local to this crate.

pub mod attitude;
pub mod camera;
pub mod centroid;
pub mod error;
pub mod frames;
pub mod identify;
pub mod render;
pub mod rng;
pub mod sights;
pub mod vertical;

pub use error::CameraError;

/// Crate version string.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
