//! Events, sky state, almanac pages and eclipses for SkyFix Lab.
//!
//! CONVENTIONS section 13; wire formats in `docs/EXPLORER_API.md`. Everything here must
//! build for `wasm32-unknown-unknown` without `std::fs` or network. This crate must not
//! depend on `skyfix-starfield` (CONVENTIONS 13.6).

pub mod eclipses;
pub mod events;
pub mod pages;
pub mod sky;
