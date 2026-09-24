//! Seeded simulator and error experiments.
//!
//! OWNER: sim agent. Truth is generated here and written to a separate `Truth` document;
//! the estimator only ever sees the `Session`. Nothing in this crate may pass a truth
//! position into `SolveOptions::initializer`.
//!
//! Randomness: a small seeded generator lives in [`rng`] (splitmix64 seeding,
//! xoshiro256\*\* stream, Box-Muller normals). No `rand` dependency: the `getrandom`
//! backend it pulls in does not build for `wasm32-unknown-unknown` without extra cfg
//! flags, and a hand-written generator guarantees bit-identical native/WASM streams.
//!
//! `docs/SIMULATOR.md` is normative for everything below and states the sign
//! conventions, the reverse correction chain, the coverage statistic, and — importantly
//! — what these tests do *not* prove.
//!
//! # The shape of a run
//!
//! ```no_run
//! use skyfix_sim::{demos, experiment::{Experiment, run, to_csv}, generate::simulate};
//!
//! // One session, plus the truth it was generated from. The two never mix.
//! let scenario = demos::philadelphia_stars();
//! let (session, truth) = simulate(&scenario, None).unwrap();
//!
//! // Or many, scored against the uncertainty the solver predicted.
//! let summary = run(&Experiment::new(demos::shared_bias(), 40), None);
//! print!("{}", to_csv(&summary));
//! ```
//!
//! # Modules
//!
//! - [`rng`]: the deterministic generator. Its stream is a regression surface.
//! - [`scenario`]: what an experiment *is*, with truth knobs and reported knobs marked
//!   separately, plus the inverted geometry that places a synthetic body at a chosen
//!   altitude and azimuth.
//! - [`optics`]: the simulator's own dip and Bennett refraction, and the reverse of the
//!   CONVENTIONS section 5 correction chain. Deliberately independent of
//!   `skyfix_core::corrections`.
//! - [`generate`]: scenario in, `(Session, Truth)` out.
//! - [`experiment`]: repetitions, coverage, and the closed-form predictions a solver can
//!   be checked against.
//! - [`demos`]: the six packaged demonstrations, as nine scenarios with fixed seeds.
//!
//! # The honest caveat
//!
//! The simulator computes its true altitudes with `skyfix_core::geometry`, and so does
//! the solver. A round trip through both therefore demonstrates that they are
//! **consistent**, not that either is **correct**. Correctness of the geometry and the
//! astronomy is established by the independent Skyfield fixtures in
//! `fixtures/reference/`, never from Rust output.

pub mod demos;
pub mod experiment;
pub mod generate;
pub mod optics;
pub mod rng;
pub mod scenario;
