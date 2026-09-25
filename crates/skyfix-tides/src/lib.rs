//! Tide predictions for NOAA's tide stations: the optional `tides-us` pack.
//!
//! - [`schureman`]: the astronomical elements, node factors `f`, nodal angles `u` and
//!   equilibrium arguments `V` of NOAA's 37 standard constituents and the 83 of its
//!   extended set (Schureman 1958, with NOAA's own usage where it differs).
//! - [`predict`]: harmonic synthesis with NOAA's convention (`V0` at the start of each
//!   year, `f` and `u` at its middle), sampled curves, and the search for high and low
//!   water.
//! - [`db`]: the station index (harmonic and subordinate stations, datums, nearest
//!   stations).
//! - [`pack`]: the pack file (common header, CRC-32) and its payload.
//! - [`api`]: what the adapters call, as serde types (`docs/EXPLORER_API.md`, "Tides").
//! - [`validation`]: comparison with a reference list of high and low waters (NOAA's),
//!   shared by the tests and the pipeline's sweep.
//!
//! Definitions: `docs/CONVENTIONS.md` 13.10. Accuracy against NOAA's own predictions:
//! `docs/ACCURACY.md`, tides, backed by `tests/noaa_fixtures.rs`. Everything here builds
//! for `wasm32-unknown-unknown`: no filesystem, no network. The pack is data, loaded at
//! run time; the core module never depends on it.

pub mod api;
pub mod db;
pub mod pack;
pub mod predict;
pub mod schureman;
pub mod validation;

pub use db::TideDb;
