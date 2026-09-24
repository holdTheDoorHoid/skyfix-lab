//! Module B: polarization compass laboratory.
//!
//! OWNER: polarization agent. An ideal single-scattering Rayleigh sky is a
//! stress model, not validated atmosphere physics. Heading estimates return
//! every unresolved candidate.
//!
//! # Scope, stated before anything else
//!
//! This crate is a **simulation laboratory**. Every photon in it is synthetic.
//! It exists to answer one question honestly: *given an ideal sky model and a
//! stated set of instrument defects, how well can heading be recovered, and
//! what remains ambiguous?* It says nothing about all-weather accuracy, nothing
//! about real atmospheres, and — by design — nothing about **position**.
//! Geolocation from polarization is deferred: see `docs/POLARIZATION.md`.
//!
//! Brief, "Non-negotiable physical distinctions" item 5: *polarization
//! measurements have angular ambiguities and depend on geometry and
//! calibration; a modeled sky pattern does not prove all-weather compass
//! accuracy or independent global positioning.* Every public entry point here
//! is written to make that impossible to forget.
//!
//! # Module map
//!
//! | module | what it owns |
//! |---|---|
//! | [`sky`] | the ideal single-scattering Rayleigh model, its symmetries and its two neutral points |
//! | [`camera`] | fisheye projection, extrinsics, the AoLP-into-the-pixel-frame transform, synthetic analyzer images, seeded degradations |
//! | [`stokes`] | `S0, S1, S2` recovery from four images, DoLP, AoLP, threshold masking |
//! | [`sensor`] | the few-channel photodiode alternative and its least-squares recovery |
//! | [`heading`] | the heading search, every unresolved candidate, tilt sensitivity |
//! | [`experiments`] | the seeded image-versus-few-channel sweep and its CSV |
//! | [`ephem`] | adapter from any `AstroProvider` to a Sun direction |
//! | [`angles`] | modulo-180-degree arithmetic, in one place |
//! | [`rng`] | splitmix64 + Box-Muller, so experiments are reproducible from a seed |
//! | [`vec3`] | 3-vector and 3x3 helpers |
//!
//! # Conventions, in one sentence each
//!
//! * **World frame** — right-handed `(east, north, up)`; a direction is
//!   altitude up from the horizon and azimuth clockwise from north, matching
//!   `docs/CONVENTIONS.md` section 2.
//! * **Camera body frame** — right-handed `(image right, image up, optical
//!   axis)`, the optical axis pointing at the sky.
//! * **Extrinsics** — `v_world = R_yaw(heading) R_pitch(pitch) R_roll(roll)
//!   v_body`: tilt first, then heading.
//! * **Pixel-frame angles** — image polar angle and analyzer angle are both
//!   measured from image up toward image right; AoLP uses the same zero.
//! * **World-frame AoLP** — measured from the local meridian (toward the
//!   zenith) toward increasing azimuth, modulo 180 degrees.
//! * **Units** — radians inside (`*_rad`), degrees at every serde and public
//!   reporting boundary (`*_deg`), per `docs/CONVENTIONS.md` section 1.
//!
//! # Quick start
//!
//! ```
//! use skyfix_polar::camera::{Camera, DEFAULT_ANALYZERS_DEG, Degradations, Extrinsics,
//!                            FisheyeIntrinsics, Scene, render};
//! use skyfix_polar::heading::{HeadingConfig, SampleOptions, Tilt, estimate, samples_from_stokes};
//! use skyfix_polar::sky::Dir;
//! use skyfix_polar::stokes::{StokesThresholds, recover};
//!
//! let sun = Dir::from_deg(30.0, 135.0);
//! let intrinsics = FisheyeIntrinsics::new(61, 61, 180.0);
//! let camera = Camera::new(intrinsics, Extrinsics::level(77.0));
//! let r = render(&camera, &Scene::new(sun), DEFAULT_ANALYZERS_DEG, &Degradations::default());
//! let field = recover(&r.images, &StokesThresholds::default());
//! let samples = samples_from_stokes(&intrinsics, &field, &SampleOptions::default());
//! let est = estimate(&samples, sun, Tilt::default(), &HeadingConfig::default());
//!
//! // The best candidate is the truth, and the 180 degree alternative is still listed.
//! assert!((est.best().unwrap().heading_deg - 77.0).abs() < 0.1);
//! assert!(est.has_anti_candidate(0.5));
//! assert!(!est.ambiguity.is_empty());
//! ```

#![forbid(unsafe_code)]

pub mod angles;
pub mod camera;
pub mod ephem;
pub mod experiments;
pub mod heading;
pub mod rng;
pub mod sensor;
pub mod sky;
pub mod stokes;
pub mod vec3;

/// Crate version, surfaced by any caller that reports provenance.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The standing caveat for anything this crate produces. Quote it verbatim.
pub const SCOPE_CAVEAT: &str =
    "skyfix-polar is a simulation laboratory. Its sky is an ideal single-scattering Rayleigh \
     model: a stress model, not validated atmosphere physics. Its results describe that model \
     under stated instrument defects. They are not an all-weather compass accuracy, and this \
     module does not estimate position at all.";
