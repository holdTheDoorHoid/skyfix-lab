//! Seeded simulator and error experiments.
//!
//! OWNER: sim agent. Truth is generated here and written to a separate `Truth` document;
//! the estimator only ever sees the `Session`. Nothing in this crate may pass a truth
//! position into `SolveOptions::initializer`.
