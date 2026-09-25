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
// Expansion programme, suntools agent (P7): golden and blue hour, azimuth search,
// alignments, analemma, sun path, equation of time, clear-sky energy, Milky Way windows.
pub mod sun_tools;

// Expansion programme P8 (moondetail agent): the Moon in detail.
pub mod apsides;
pub mod libration;
pub mod lunar_features;
pub mod occultations;

// Planet detail (expansion programme P9, planetdetail agent): discs, rings, the
// Galilean moons, transits of Mercury and Venus, conjunctions and stations, the Earth's
// apsides and user-supplied orbits. CONVENTIONS 13.12.
pub mod conjunctions;
pub mod discs;
pub mod earth_apsides;
pub mod orbits;
pub(crate) mod planet_geometry;
pub mod rings;
pub mod satellites;
pub mod transits;
