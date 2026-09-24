//! One module per subcommand. OWNER: cli agent.
//!
//! Every `run` returns the exit code it earned rather than calling `process::exit`, so
//! the dispatch in `main` is the single place a code reaches the operating system and
//! the codes stay testable.

pub mod almanac;
pub mod catalog;
pub mod convert;
pub mod experiment;
pub mod plan;
pub mod reduce;
pub mod scenarios;
pub mod simulate;
pub mod solve;
pub mod validate;
