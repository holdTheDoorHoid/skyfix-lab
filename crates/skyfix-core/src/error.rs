use thiserror::Error;

/// Every failure the core can report. Keep messages self-explanatory: the CLI and
/// the UI print them verbatim.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SkyfixError {
    #[error("invalid timestamp {0:?}: expected RFC 3339 UTC with a trailing 'Z'")]
    InvalidTimestamp(String),
    #[error("{field}: value {value} is outside [{min}, {max}]")]
    AngleOutOfRange {
        field: String,
        value: f64,
        min: f64,
        max: f64,
    },
    #[error("{field}: value is not finite")]
    NonFinite { field: String },
    #[error("{field}: {message}")]
    InvalidField { field: String, message: String },
    #[error("unknown body {0:?}")]
    UnknownBody(String),
    #[error("duplicate observation id {0:?}")]
    DuplicateId(String),
    #[error("unsupported session schema {0:?} (expected {expected:?})", expected = crate::types::SESSION_SCHEMA)]
    UnsupportedSchema(String),
    #[error("observation {id}: no body direction available: {reason}")]
    NoDirection { id: String, reason: String },
    #[error("observation {id}: rejected: {reason}")]
    Rejected { id: String, reason: String },
    #[error("solver: {0}")]
    Solver(String),
    #[error("{0}")]
    Other(String),
}
