//! Errors for module A.
//!
//! Hand-written `Display`/`Error` impls rather than `thiserror`: this crate takes no
//! dependency the workspace does not already force on it, and the enum is small.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum CameraError {
    /// A timestamp that `skyfix_core::time::parse_utc` rejected, or a value outside
    /// the ephemeris provider's coverage.
    Time { utc: String, reason: String },
    /// The ephemeris provider refused a body or an instant.
    Ephemeris(String),
    /// A parameter was non-finite or outside its physical range.
    Invalid { field: String, reason: String },
    /// The horizon line could not be fitted.
    HorizonFit(String),
    /// Wahba's problem had too few (or degenerate) directions to solve.
    Attitude(String),
}

impl fmt::Display for CameraError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CameraError::Time { utc, reason } => write!(f, "timestamp {utc:?}: {reason}"),
            CameraError::Ephemeris(m) => write!(f, "ephemeris: {m}"),
            CameraError::Invalid { field, reason } => write!(f, "{field}: {reason}"),
            CameraError::HorizonFit(m) => write!(f, "horizon line fit: {m}"),
            CameraError::Attitude(m) => write!(f, "attitude: {m}"),
        }
    }
}

impl std::error::Error for CameraError {}

impl CameraError {
    pub(crate) fn invalid(field: &str, reason: impl Into<String>) -> Self {
        CameraError::Invalid {
            field: field.to_string(),
            reason: reason.into(),
        }
    }
}
