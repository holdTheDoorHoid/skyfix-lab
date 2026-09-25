//! Golden hour and blue hour (CONVENTIONS 13.10), with the day's twilight in one object.
//!
//! Photographers' conventions, not physical boundaries: **golden hour** while the Sun's
//! centre is between -4 and +6 degrees, **blue hour** while it is between -6 and -4
//! degrees, morning and evening. Like twilight (CONVENTIONS 13.3) the thresholds are on
//! the **geometric** altitude of the Sun's centre (`alt_deg`: WGS84 site, parallax, no
//! refraction), so blue hour ends exactly when civil twilight does. The bands include
//! their upper edge, as the sky phases of CONVENTIONS 13.4 do: blue `(-6, -4]`, golden
//! `(-4, 6]`.
//!
//! The crossings are found by the event finder ([`super::find_geometric_altitude`], which
//! is [`crate::events::find_altitude`] at the apparent equivalent of each threshold), and
//! the rise, set, transits, twilight and sky phases are [`crate::events::day_events`]'s.
//! Polar cases use the twilight vocabulary: a threshold that is never crossed in the
//! window is `always_above` or `always_below`, and a golden or blue hour that runs into
//! an edge of the window says so (`open_start`, `open_end`) instead of inventing an
//! instant.

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_ephemeris::body::{BodyEphemeris, SUN};
use skyfix_ephemeris::topocentric::Site;

use super::{Span, find_geometric_altitude, stretches, sun_altitude_deg};
use crate::events::{
    AltitudeCrossing, BodyEvents, EventKind, EventOptions, PhaseSegment, day_events,
};
use crate::sky::{AlmanacError, BodyError, checked_site};

/// Golden hour: the Sun's centre above this geometric altitude, degrees...
pub const GOLDEN_HOUR_LOW_DEG: f64 = -4.0;
/// ...and not above this one.
pub const GOLDEN_HOUR_HIGH_DEG: f64 = 6.0;
/// Blue hour: the Sun's centre above this geometric altitude and not above
/// [`GOLDEN_HOUR_LOW_DEG`]. The same altitude as civil twilight.
pub const BLUE_HOUR_LOW_DEG: f64 = -6.0;

/// The three thresholds, lowest first.
pub const THRESHOLDS_DEG: [f64; 3] = [BLUE_HOUR_LOW_DEG, GOLDEN_HOUR_LOW_DEG, GOLDEN_HOUR_HIGH_DEG];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightKind {
    Golden,
    Blue,
}

/// When in the day a golden or blue hour falls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightPeriod {
    /// The Sun climbs through the band.
    Morning,
    /// The Sun sinks through the band.
    Evening,
    /// The Sun culminates inside the band (high-latitude winter: a golden "day").
    Midday,
    /// The Sun's lower culmination is inside the band (high-latitude summer nights).
    Midnight,
    /// The Sun is in the band for the whole window.
    AllDay,
}

/// One golden or blue hour inside the window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LightWindow {
    pub kind: LightKind,
    pub period: LightPeriod,
    pub jd_start: f64,
    pub utc_start: String,
    pub jd_end: f64,
    pub utc_end: String,
    pub duration_min: f64,
    /// The Sun was already in the band when the window began: `jd_start` is the window's
    /// edge, not a crossing.
    pub open_start: bool,
    /// The Sun was still in the band when the window ended.
    pub open_end: bool,
}

/// Every crossing of one threshold, with the twilight vocabulary for none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HourBoundary {
    /// Geometric altitude of the Sun's centre, degrees: -6, -4 or +6.
    pub altitude_deg: f64,
    /// Time-ordered; `alt_deg` of each is the threshold (geometric), `az_deg` where the
    /// Sun is at that instant.
    pub crossings: Vec<AltitudeCrossing>,
    /// Never crossed inside the window, above it throughout.
    pub always_above: bool,
    /// Never crossed inside the window, below it throughout.
    pub always_below: bool,
}

/// `sun_hours` result (EXPLORER_API.md `SunHours`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SunHours {
    pub jd_start: f64,
    pub jd_end: f64,
    /// Golden and blue hours, time-ordered (a blue hour and a golden hour touch at -4).
    pub windows: Vec<LightWindow>,
    /// The -6, -4 and +6 degree thresholds, in that order.
    pub boundaries: Vec<HourBoundary>,
    /// The Sun's rise, set, transits and twilight: `day_events` for the Sun.
    pub sun: BodyEvents,
    /// The sky phases over the window (CONVENTIONS 13.4), from the same `day_events`.
    pub phases: Vec<PhaseSegment>,
}

/// Band index: 0 at or below -6, 1 blue, 2 golden, 3 above +6.
fn band_of(alt_deg: f64) -> usize {
    THRESHOLDS_DEG.iter().filter(|&&h| alt_deg > h).count()
}

/// Golden and blue hours over `[jd_start, jd_end]` (the UI passes one local day), with the
/// Sun's events and the sky phases of the same window (EXPLORER_API.md `sun_hours`).
///
/// Fails like `day_events`: a malformed window, or a window the Sun cannot be computed
/// over ([`AlmanacError::Unavailable`]).
pub fn sun_hours(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_start: f64,
    jd_end: f64,
) -> Result<SunHours, AlmanacError> {
    let site = checked_site(site)?;
    let de = day_events(
        eph,
        &site,
        jd_start,
        jd_end,
        &[SUN],
        &EventOptions::default(),
    )?;
    let sun = match de.bodies.into_iter().next() {
        Some(b) => b,
        None => {
            let e = de.errors.into_iter().next().unwrap_or(BodyError {
                body: SUN.to_string(),
                message: "the Sun could not be computed over the window".to_string(),
            });
            return Err(e.into());
        }
    };

    let start_alt = sun_altitude_deg(eph, &site, jd_start)?;
    let mut boundaries = Vec::with_capacity(THRESHOLDS_DEG.len());
    let mut cuts = Vec::new();
    for h in THRESHOLDS_DEG {
        let crossings = find_geometric_altitude(eph, &site, SUN, jd_start, jd_end, h)?;
        cuts.extend(crossings.iter().map(|c| c.jd_utc));
        let none = crossings.is_empty();
        boundaries.push(HourBoundary {
            altitude_deg: h,
            always_above: none && start_alt > h,
            always_below: none && start_alt <= h,
            crossings,
        });
    }

    // The band of each stretch between crossings, from the Sun's altitude at its middle
    // (robust to simultaneous crossings), merged where neighbours share a band.
    let mut merged: Vec<(Span, usize)> = Vec::new();
    for s in stretches(jd_start, jd_end, &mut cuts) {
        let band = band_of(sun_altitude_deg(eph, &site, 0.5 * (s.jd_start + s.jd_end))?);
        match merged.last_mut() {
            Some((last, b)) if *b == band => last.jd_end = s.jd_end,
            _ => merged.push((s, band)),
        }
    }

    let transits: Vec<(f64, bool)> = sun
        .events
        .iter()
        .filter_map(|e| match e.kind {
            EventKind::Transit => Some((e.jd_utc, true)),
            EventKind::LowerTransit => Some((e.jd_utc, false)),
            _ => None,
        })
        .collect();
    let rising_at = |t: f64| -> Option<bool> {
        boundaries
            .iter()
            .flat_map(|b| b.crossings.iter())
            .find(|c| (c.jd_utc - t).abs() < 1e-9)
            .map(|c| c.rising)
    };

    let mut windows = Vec::new();
    for (span, band) in merged {
        let kind = match band {
            1 => LightKind::Blue,
            2 => LightKind::Golden,
            _ => continue,
        };
        let open_start = span.jd_start <= jd_start;
        let open_end = span.jd_end >= jd_end;
        let inside = |upper: bool| {
            transits
                .iter()
                .any(|&(t, u)| u == upper && t > span.jd_start && t < span.jd_end)
        };
        let period = if open_start && open_end {
            LightPeriod::AllDay
        } else if inside(true) {
            LightPeriod::Midday
        } else if inside(false) {
            LightPeriod::Midnight
        } else {
            let edge = if open_end {
                rising_at(span.jd_start)
            } else {
                rising_at(span.jd_end)
            };
            match edge {
                Some(false) => LightPeriod::Evening,
                _ => LightPeriod::Morning,
            }
        };
        windows.push(LightWindow {
            kind,
            period,
            jd_start: span.jd_start,
            utc_start: format_utc(span.jd_start),
            jd_end: span.jd_end,
            utc_end: format_utc(span.jd_end),
            duration_min: (span.jd_end - span.jd_start) * 1440.0,
            open_start,
            open_end,
        });
    }

    Ok(SunHours {
        jd_start,
        jd_end,
        windows,
        boundaries,
        sun,
        phases: de.phases,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_include_their_upper_edge_like_the_sky_phases() {
        assert_eq!(band_of(-6.0), 0);
        assert_eq!(band_of(-5.99), 1);
        assert_eq!(band_of(-4.0), 1);
        assert_eq!(band_of(-3.99), 2);
        assert_eq!(band_of(6.0), 2);
        assert_eq!(band_of(6.01), 3);
    }

    #[test]
    fn kinds_and_periods_serialise_as_documented() {
        let s: Vec<String> = [
            LightPeriod::Morning,
            LightPeriod::Evening,
            LightPeriod::Midday,
            LightPeriod::Midnight,
            LightPeriod::AllDay,
        ]
        .iter()
        .map(|p| serde_json::to_string(p).unwrap())
        .collect();
        assert_eq!(
            s.join(","),
            "\"morning\",\"evening\",\"midday\",\"midnight\",\"all_day\""
        );
        assert_eq!(
            serde_json::to_string(&LightKind::Golden).unwrap(),
            "\"golden\""
        );
    }
}
