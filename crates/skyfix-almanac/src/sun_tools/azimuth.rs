//! `find_azimuth`: the instants a body crosses a bearing, the sibling of
//! [`crate::events::find_altitude`] (CONVENTIONS 13.10).
//!
//! "When is the Sun due west of my window?", "when is the Moon over the church spire at
//! bearing 118°?" The azimuth is the topocentric azimuth of the body's centre
//! (`az_deg`, CONVENTIONS 13.2: WGS84 site, parallax applied; refraction moves altitude
//! only). A crossing counts only when the body is inside an altitude band at that instant:
//! by default **above the horizon** exactly as `sky_state`'s `above_horizon` says (upper
//! limb above the sea-level horizon: `alt_apparent_deg + SD > 0`); a band given as
//! `min_deg` / `max_deg` bounds the **apparent** altitude of the centre, the altitude
//! `find_altitude` searches.
//!
//! # Method
//!
//! The body's apparent geocentric state comes from the same interpolated track the event
//! finder uses (3-hour nodes for the Moon, 4 for planets, 8 for the Sun and stars; under
//! 0.01" of error), and the topocentric step is exact at every evaluation. The azimuth is
//! sampled on the event finder's 10-minute grid; an interval over which the azimuth turns
//! by more than 20° (a body passing near the zenith) is halved until it does not, down to
//! one second. The signed difference `az - bearing`, wrapped into (-180°, 180°], changes
//! sign continuously where the body crosses the bearing and jumps by nearly 360° where it
//! crosses the opposite bearing; only the first is a crossing. Each is refined with the
//! event finder's Brent root finder to 1 ms. A body that passes exactly through the
//! zenith has no azimuth there and crosses no bearing on the way.

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::{ApparentState, BodyEphemeris};
use skyfix_ephemeris::topocentric::{Horizontal, Site, horizontal};

use super::{GRID_DAYS, ROOT_TOL_DAYS, SECOND_DAYS, check_window, roots};
use crate::sky::track::Track;
use crate::sky::{AlmanacError, checked_site, resolve_bodies};

/// An interval whose azimuth turns by more than this is subdivided, degrees.
const MAX_AZIMUTH_STEP_DEG: f64 = 20.0;

/// The altitude band a crossing must be in. Degrees of **apparent** altitude of the
/// centre (`alt_apparent_deg`). `min_deg: None` means "above the horizon" as
/// `above_horizon` defines it; `max_deg: None` means no upper limit.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AltitudeBand {
    pub min_deg: Option<f64>,
    pub max_deg: Option<f64>,
}

impl AltitudeBand {
    /// Both limits finite, within [-90, 90] and in order.
    pub fn checked(&self) -> Result<Self, AlmanacError> {
        for (name, v) in [("min_deg", self.min_deg), ("max_deg", self.max_deg)] {
            if let Some(v) = v {
                if !(v.is_finite() && (-90.0..=90.0).contains(&v)) {
                    return Err(AlmanacError::invalid(format!(
                        "altitude band {name} must be between -90 and 90, got {v}"
                    )));
                }
            }
        }
        if let (Some(a), Some(b)) = (self.min_deg, self.max_deg) {
            if a > b {
                return Err(AlmanacError::invalid(format!(
                    "altitude band min_deg {a} is above max_deg {b}"
                )));
            }
        }
        Ok(*self)
    }

    /// Whether a body with this apparent altitude and semidiameter is inside the band.
    pub fn contains(&self, alt_apparent_deg: f64, semidiameter_arcmin: f64) -> bool {
        let low = match self.min_deg {
            Some(m) => alt_apparent_deg >= m,
            None => alt_apparent_deg + semidiameter_arcmin / 60.0 > 0.0,
        };
        low && self.max_deg.is_none_or(|m| alt_apparent_deg <= m)
    }
}

/// One `find_azimuth` crossing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AzimuthCrossing {
    pub jd_utc: f64,
    pub utc: String,
    /// The body's azimuth at that instant (the requested bearing, to the root tolerance).
    pub az_deg: f64,
    /// Topocentric geometric altitude of the centre, as everywhere.
    pub alt_deg: f64,
    /// `alt_deg` plus the display refraction.
    pub alt_apparent_deg: f64,
    /// The altitude is increasing at that instant.
    pub rising: bool,
    /// The azimuth is increasing (the body moves clockwise, seen from above: east to
    /// south to west for the Sun in northern mid-latitudes).
    pub clockwise: bool,
}

/// Evaluates one body's track from one site without allocating.
pub(crate) struct AzProbe<'a> {
    track: &'a Track,
    site: &'a Site,
    scratch: ApparentState,
}

impl<'a> AzProbe<'a> {
    pub(crate) fn new(track: &'a Track, site: &'a Site) -> Self {
        AzProbe {
            track,
            site,
            scratch: track.template().clone(),
        }
    }

    pub(crate) fn at(&mut self, t: f64) -> (Horizontal, f64) {
        self.track.fill(t, &mut self.scratch);
        (
            horizontal(&self.scratch, self.site),
            self.scratch.semidiameter_arcmin,
        )
    }
}

/// Every instant in `[jd_start, jd_end]` at which `body`'s topocentric azimuth crosses
/// `azimuth_deg` while the body is inside `band` (EXPLORER_API.md `find_azimuth`),
/// time-ordered. Fails with [`AlmanacError::Unavailable`] when the body cannot be
/// computed over the window (at most 400 days).
pub fn find_azimuth(
    eph: &dyn BodyEphemeris,
    site: &Site,
    body: &str,
    jd_start: f64,
    jd_end: f64,
    azimuth_deg: f64,
    band: &AltitudeBand,
) -> Result<Vec<AzimuthCrossing>, AlmanacError> {
    let site = checked_site(site)?;
    check_window(jd_start, jd_end)?;
    if !(azimuth_deg.is_finite() && (-360.0..=720.0).contains(&azimuth_deg)) {
        return Err(AlmanacError::invalid(format!(
            "azimuth_deg must be a bearing in degrees, got {azimuth_deg}"
        )));
    }
    let band = band.checked()?;
    let name = resolve_bodies(&[body])?[0];
    let track = Track::build_many(eph, &[name], jd_start, jd_end)
        .pop()
        .expect("one track per body")?;
    let mut probe = AzProbe::new(&track, &site);
    let roots = azimuth_roots(&mut probe, jd_start, jd_end, azimuth_deg);
    let mut out = Vec::with_capacity(roots.len());
    for (t, clockwise) in roots {
        let (h, sd) = probe.at(t);
        if !band.contains(h.alt_apparent_deg, sd) {
            continue;
        }
        let before = probe.at(t - SECOND_DAYS).0.alt_deg;
        let after = probe.at(t + SECOND_DAYS).0.alt_deg;
        out.push(AzimuthCrossing {
            jd_utc: t,
            utc: format_utc(t),
            az_deg: h.az_deg,
            alt_deg: h.alt_deg,
            alt_apparent_deg: h.alt_apparent_deg,
            rising: after > before,
            clockwise,
        });
    }
    Ok(out)
}

/// The instants in `[t0, t1]` at which the probe's azimuth crosses `bearing`, with
/// whether it was increasing. Window edges never create crossings.
pub(crate) fn azimuth_roots(
    probe: &mut AzProbe,
    t0: f64,
    t1: f64,
    bearing: f64,
) -> Vec<(f64, bool)> {
    let span = t1 - t0;
    let n = (span / GRID_DAYS).ceil().max(1.0) as usize;
    let dx = span / n as f64;
    let mut out = Vec::new();
    let mut a = (t0, probe.at(t0).0.az_deg);
    for k in 1..=n {
        let tb = if k == n { t1 } else { t0 + k as f64 * dx };
        let b = (tb, probe.at(tb).0.az_deg);
        interval(probe, a, b, bearing, &mut out);
        a = b;
    }
    out
}

/// Crossings inside one grid interval, subdividing where the azimuth turns quickly.
fn interval(
    probe: &mut AzProbe,
    a: (f64, f64),
    b: (f64, f64),
    bearing: f64,
    out: &mut Vec<(f64, bool)>,
) {
    let step = norm_180(b.1 - a.1).abs();
    if step > MAX_AZIMUTH_STEP_DEG && b.0 - a.0 > SECOND_DAYS {
        let tm = 0.5 * (a.0 + b.0);
        let m = (tm, probe.at(tm).0.az_deg);
        interval(probe, a, m, bearing, out);
        interval(probe, m, b, bearing, out);
        return;
    }
    let (da, db) = (norm_180(a.1 - bearing), norm_180(b.1 - bearing));
    // A continuous pass through zero, not the jump at the opposite bearing.
    if (da >= 0.0) != (db >= 0.0) && (db - da).abs() < 180.0 {
        let t = roots::brent_root(
            |t| norm_180(probe.at(t).0.az_deg - bearing),
            a.0,
            b.0,
            da,
            db,
            ROOT_TOL_DAYS,
        );
        out.push((t, db > da));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_band_is_the_upper_limb_above_the_horizon() {
        let b = AltitudeBand::default();
        assert!(b.contains(-0.2, 16.0), "upper limb still up");
        assert!(!b.contains(-0.3, 16.0));
        assert!(b.contains(89.0, 0.0));
        let explicit = AltitudeBand {
            min_deg: Some(10.0),
            max_deg: Some(30.0),
        };
        assert!(!explicit.contains(9.99, 16.0) && explicit.contains(10.0, 0.0));
        assert!(!explicit.contains(30.01, 0.0));
    }

    #[test]
    fn bands_are_checked() {
        assert!(
            AltitudeBand {
                min_deg: Some(20.0),
                max_deg: Some(10.0)
            }
            .checked()
            .is_err()
        );
        assert!(
            AltitudeBand {
                min_deg: Some(f64::NAN),
                max_deg: None
            }
            .checked()
            .is_err()
        );
        let parsed: AltitudeBand = serde_json::from_str(r#"{"min_deg": 5}"#).unwrap();
        assert_eq!(parsed.min_deg, Some(5.0));
        assert!(serde_json::from_str::<AltitudeBand>(r#"{"low": 5}"#).is_err());
    }
}
