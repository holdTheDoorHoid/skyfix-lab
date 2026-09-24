//! CONVENTIONS section 10: session validation and CSV round-trip.
//!
//! OWNER: core-reduce agent. The core does no file I/O: these functions take and return
//! strings; the CLI and the WASM adapter own the files.

use crate::types::{Session, Warning};

/// Parse and validate a session JSON document. Returns warnings for non-fatal issues.
pub fn parse_session(json: &str) -> Result<(Session, Vec<Warning>), crate::SkyfixError> {
    todo!("core-reduce: parse_session")
}

/// Validate an already-constructed session (ranges, finiteness, ids, timestamps, bodies).
pub fn validate(
    session: &Session,
    known_bodies: &[&str],
) -> Result<Vec<Warning>, crate::SkyfixError> {
    todo!("core-reduce: validate")
}

/// CSV with a `#`-prefixed header block for session-level fields and one row per observation.
pub fn to_csv(session: &Session) -> String {
    todo!("core-reduce: to_csv")
}

pub fn from_csv(csv: &str) -> Result<Session, crate::SkyfixError> {
    todo!("core-reduce: from_csv")
}
