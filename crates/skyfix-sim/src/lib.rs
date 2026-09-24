//! Seeded simulator and error experiments.
//!
//! OWNER: sim agent. Truth is generated here and written to a separate `Truth` document;
//! the estimator only ever sees the `Session`. Nothing in this crate may pass a truth
//! position into `SolveOptions::initializer`.
//!
//! Randomness: implement a small seeded generator in this crate (splitmix64 seeding,
//! xoshiro256** stream, Box-Muller normals). No `rand` dependency: the `getrandom`
//! backend it pulls in does not build for `wasm32-unknown-unknown` without extra cfg
//! flags, and a hand-written generator guarantees bit-identical native/WASM streams.

pub mod generate;
pub mod optics;
pub mod rng;
pub mod scenario;
