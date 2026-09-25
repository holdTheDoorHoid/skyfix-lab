//! Conversion of Arc to Time (the Nautical Almanac's page i).
//!
//! The Earth turns 360° in 24 hours of solar time as the tables use it, so 1° of arc is
//! 4 minutes of time, 1′ is 4 seconds and 0.25′ is 1 second. The table converts whole
//! degrees (0°–359°) to hours and minutes, and minutes of arc with their quarters
//! (0′.00, 0′.25, 0′.50, 0′.75) to minutes and seconds; the two parts are added. Every
//! entry is exact: nothing is rounded.
//!
//! Its main use is converting a longitude to time: LMT to UT (add the time if west,
//! subtract if east), for sunrise, sunset and meridian passage.

use serde::{Deserialize, Serialize};

use super::BANNER;

/// One whole degree of arc as time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DegreeRow {
    pub deg: u32,
    /// `4 × deg` minutes of time.
    pub minutes: u32,
    /// `h m`: `12 04`.
    pub printed: String,
}

/// One whole minute of arc as time, with its quarters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArcminRow {
    pub arcmin: u32,
    /// Seconds of time for `arcmin` + 0.00, 0.25, 0.50 and 0.75.
    pub seconds: [u32; 4],
    /// `m s`: `1 48`.
    pub printed: [String; 4],
}

/// The whole conversion table, with how to use it and a worked example.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArcToTime {
    /// 0° to 359°.
    pub degrees: Vec<DegreeRow>,
    /// 0′ to 59′.
    pub arcminutes: Vec<ArcminRow>,
    pub how_to_use: String,
    pub example: String,
    pub notes: Vec<String>,
}

/// `h m` of a number of minutes of time.
fn fmt_h_m(minutes: u32) -> String {
    format!("{} {:02}", minutes / 60, minutes % 60)
}

/// `m s` of a number of seconds of time.
fn fmt_m_s(seconds: u32) -> String {
    format!("{} {:02}", seconds / 60, seconds % 60)
}

/// The time equivalent of an angle, in seconds of time (exact: 240 s per degree).
pub fn arc_to_seconds(arc_deg: f64) -> f64 {
    arc_deg * 240.0
}

/// The table.
pub fn arc_to_time() -> ArcToTime {
    let degrees = (0..360)
        .map(|deg| DegreeRow {
            deg,
            minutes: 4 * deg,
            printed: fmt_h_m(4 * deg),
        })
        .collect();
    let arcminutes = (0..60)
        .map(|m| {
            let seconds = [0, 1, 2, 3].map(|q| 4 * m + q);
            ArcminRow {
                arcmin: m,
                seconds,
                printed: seconds.map(fmt_m_s),
            }
        })
        .collect();
    ArcToTime {
        degrees,
        arcminutes,
        how_to_use: "Find the whole degrees in the left-hand columns (hours and minutes of \
                     time) and the minutes of arc, to a quarter, on the right (minutes and \
                     seconds); add the two. 1° is 4 minutes of time, 1′ is 4 seconds."
            .to_string(),
        example: "Longitude 44° 27′ W: 44° is 2 h 56 m and 27′ is 1 m 48 s, so 2 h 57 m 48 s; \
                  the Sun's meridian passage there is 2 h 57.8 m later by the clock of the \
                  Greenwich meridian than the tabulated LMT. (Bowditch §1910 converts the \
                  same 27′ to 1 m 48 s.)"
            .to_string(),
        notes: vec![
            "Exact: 360° of arc = 24 hours of time.".to_string(),
            BANNER.to_string(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_exact() {
        let t = arc_to_time();
        assert_eq!(t.degrees.len(), 360);
        assert_eq!(t.arcminutes.len(), 60);
        assert_eq!(t.degrees[0].printed, "0 00");
        assert_eq!(t.degrees[15].printed, "1 00");
        assert_eq!(t.degrees[44].printed, "2 56");
        assert_eq!(t.degrees[359].printed, "23 56");
        // Bowditch §1910: 27′ of arc is 1 m 48 s.
        assert_eq!(t.arcminutes[27].printed[0], "1 48");
        assert_eq!(t.arcminutes[27].printed[1], "1 49");
        assert_eq!(t.arcminutes[59].printed[3], "3 59");
        assert_eq!(arc_to_seconds(1.0), 240.0);
    }
}
