//! Events, sky state, almanac pages, eclipses and planet events for SkyFix Lab.
//!
//! CONVENTIONS section 13; wire formats in `docs/EXPLORER_API.md`. Everything here must
//! build for `wasm32-unknown-unknown` without `std::fs` or network. This crate must not
//! depend on `skyfix-starfield` (CONVENTIONS 13.6).

pub mod eclipses;
pub mod events;
pub mod pages;
pub mod planet_events;
pub mod sky;

// Expansion programme P8 (moondetail agent): the Moon in detail.
pub mod apsides;
pub mod libration;
pub mod lunar_features;
pub mod occultations;
