//! Moon and planet sight tools beyond the correction chain.
//!
//! OWNER: navigation-Moon agent (wave 2). `docs/NAVIGATION_SKY.md` explains the methods
//! in plain words; the wire types are at the end of [`crate::types`].
//!
//! - [`predict`]: the sextant reading a navigator would see — CONVENTIONS section 5 run
//!   in reverse from the computed altitude of section 3.
//! - [`lunar`]: a lunar distance cleared rigorously and turned into UTC, with an honest
//!   uncertainty.
//!
//! The lunar clearing places the observer on the WGS84 ellipsoid ([`wgs84`]): the
//! 5-second goal needs the Moon's parallax to 0.03', and the spherical Earth of
//! CONVENTIONS section 1 is up to 0.22' out for the Moon (the exception is recorded in
//! CONVENTIONS section 1 beside the explorer's display values). Sight reduction itself
//! stays on the sphere.

pub mod lunar;
pub mod predict;
pub mod wgs84;
