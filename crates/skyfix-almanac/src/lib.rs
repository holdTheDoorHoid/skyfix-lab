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

// Planet detail (expansion programme P9, planetdetail agent): discs, rings, the
// Galilean moons, transits of Mercury and Venus, conjunctions and stations, the Earth's
// apsides and user-supplied orbits. CONVENTIONS 13.10.
pub mod discs;
pub(crate) mod planet_geometry;
pub mod rings;
pub mod satellites;
pub mod transits;
