//! Observation planner: rank visible bodies by the improvement they bring to the
//! conditioning of a fix, not by brightness or by evenly spaced azimuths.
//!
//! OWNER: planner agent (phase 2). Requires an approximate position, which every report
//! discloses. Visibility is geometric only.

use crate::types::LatLon;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlannedBody {
    pub body: String,
    pub altitude_deg: f64,
    pub azimuth_deg: f64,
    pub score: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Plan {
    pub approximate_position: LatLon,
    pub utc: String,
    pub bodies: Vec<PlannedBody>,
    pub notes: Vec<String>,
}
