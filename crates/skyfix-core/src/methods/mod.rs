//! Navigation methods beyond the general fix: the noon sight (meridian altitude),
//! latitude by Polaris, and averaging a run of sights.
//!
//! `docs/NAVIGATION_METHODS.md` is normative for everything in this module tree, and
//! CONVENTIONS sections 3 (geometry), 4-5 (the correction chain, which never runs
//! twice), 6 (time and the clock), 9 (residuals) and 12 (warnings) apply.
//!
//! Every method starts the same way: each observation goes through
//! [`crate::reduce::reduce_observation`] exactly once, so the correction chain is the
//! ordinary one and the declared `altitude_kind` decides which steps run. The reduced
//! sights are returned with every result, so the workings are always visible, and a
//! rejected sight becomes a warning rather than a silent drop.
//!
//! The DR position a method is given is used to choose between answers, to predict
//! and to propagate uncertainty. It is never a prior on an answer (CONVENTIONS 8).
//!
//! This module holds what the three methods share: the reduced run, the body's
//! direction at any instant near the run ([`BodyTrack`]), dead reckoning over a few
//! minutes, meridian passage, and the altitude equation solved for latitude.

pub mod averaging;
// Compass error by azimuth and amplitude (expansion programme, geomag agent).
pub mod compass;
pub mod noon;
pub mod polaris;

use crate::SkyfixError;
use crate::geometry::{Point, altitude_azimuth, destination};
use crate::reduce::{DirectionSource, SUPPLIED_DIRECTION_SOURCE, reduce_observation};
use crate::types::{
    AssumedPositionRole, DrPosition, GeocentricDirection, ReducedSight, Session, VesselMotion,
    Warning,
};
use crate::units::{nm_to_rad, norm_180, norm_360, norm_pi};
use std::f64::consts::FRAC_PI_2;

/// Minutes in one day of `jd_utc`.
pub const MINUTES_PER_DAY: f64 = 1440.0;
/// Seconds in one day of `jd_utc`.
pub const SECONDS_PER_DAY: f64 = 86_400.0;
/// Newton iterations on an instant stop below this step, days: a few ulps of a Julian
/// date near 2.46e6 (one ulp is 4.7e-10 day), 0.17 ms.
pub const JD_STEP_TOLERANCE: f64 = 2e-9;
/// The outlier and consistency threshold used throughout: 3 standard deviations
/// (about 1 false alarm in 370 when everything is as stated).
pub const THREE_SIGMA: f64 = 3.0;

// ---------------------------------------------------------------------------
// The run of reduced sights
// ---------------------------------------------------------------------------

/// Reduce every observation of `session`, in time order. A sight the reducer rejects is
/// returned as a warning naming it, so a method can go on with the rest.
pub fn reduce_all(
    session: &Session,
    source: &dyn DirectionSource,
) -> (Vec<ReducedSight>, Vec<Warning>) {
    let mut sights = Vec::with_capacity(session.observations.len());
    let mut warnings = Vec::new();
    for obs in &session.observations {
        match reduce_observation(session, obs, source) {
            Ok(s) => sights.push(s),
            Err(e) => warnings.push(Warning::Other {
                message: format!("{e}. This sight was not used."),
            }),
        }
    }
    sights.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));
    (sights, warnings)
}

/// The error a method returns when no sight survived the reduction.
pub(crate) fn nothing_usable(
    method: &str,
    n_observations: usize,
    warnings: &[Warning],
) -> SkyfixError {
    if n_observations == 0 {
        return SkyfixError::InvalidField {
            field: "session.observations".to_string(),
            message: format!("{method} needs at least one observation"),
        };
    }
    let reasons: Vec<String> = warnings
        .iter()
        .filter_map(|w| match w {
            Warning::Other { message } => Some(message.clone()),
            _ => None,
        })
        .collect();
    SkyfixError::Other(format!(
        "{method}: every observation was rejected before the method could run: {}",
        reasons.join(" ")
    ))
}

/// All sights must be of one body (names compared trimmed and case-insensitively).
/// Returns the name as the first sight spells it.
pub fn one_body(sights: &[ReducedSight], method: &str) -> Result<String, SkyfixError> {
    let first = sights
        .first()
        .map(|s| s.body.trim().to_string())
        .unwrap_or_default();
    let mut others: Vec<String> = Vec::new();
    for s in sights {
        let b = s.body.trim();
        if !b.eq_ignore_ascii_case(&first) && !others.iter().any(|o| o.eq_ignore_ascii_case(b)) {
            others.push(b.to_string());
        }
    }
    if others.is_empty() {
        Ok(first)
    } else {
        Err(SkyfixError::InvalidField {
            field: "session.observations".to_string(),
            message: format!(
                "{method} works on a run of sights of ONE body, but this session has {first} \
                 and {}; pass each body's run separately",
                others.join(", ")
            ),
        })
    }
}

/// The DR a method uses: the one in its options, else the session's assumed position,
/// with the prior's 1-sigma when the session declares its role as `prior`.
pub fn resolve_dr(explicit: Option<DrPosition>, session: &Session) -> Option<DrPosition> {
    if explicit.is_some() {
        return explicit;
    }
    let ap = session.observer.assumed_position?;
    let sigma_nm = match session.observer.assumed_position_role {
        AssumedPositionRole::Prior { sigma_nm } => Some(sigma_nm),
        _ => None,
    };
    Some(DrPosition {
        lat_deg: ap.lat_deg,
        lon_deg: ap.lon_deg,
        sigma_nm,
    })
}

pub(crate) fn check_dr(dr: &DrPosition) -> Result<(), SkyfixError> {
    if !dr.lat_deg.is_finite() || !dr.lon_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: "dr".to_string(),
        });
    }
    if !(-90.0..=90.0).contains(&dr.lat_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: "dr.lat_deg".to_string(),
            value: dr.lat_deg,
            min: -90.0,
            max: 90.0,
            max_exclusive: false,
        });
    }
    if !(-180.0..=180.0).contains(&dr.lon_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: "dr.lon_deg".to_string(),
            value: dr.lon_deg,
            min: -180.0,
            max: 180.0,
            max_exclusive: false,
        });
    }
    if let Some(s) = dr.sigma_nm
        && !(s.is_finite() && s > 0.0)
    {
        return Err(SkyfixError::InvalidField {
            field: "dr.sigma_nm".to_string(),
            message: format!("must be a finite value greater than 0 when stated (got {s})"),
        });
    }
    Ok(())
}

/// The fastest vessel (or aircraft with a bubble sextant) a method accepts, knots. Far
/// beyond it the dead-reckoning track wraps round the Earth within the run, and a typo
/// such as 1e6 for 10 came back as an averaged altitude of 159 degrees.
pub const MAX_VESSEL_SPEED_KN: f64 = 1000.0;

pub(crate) fn check_vessel(vessel: Option<VesselMotion>) -> Result<(), SkyfixError> {
    if let Some(v) = vessel {
        if !v.course_deg.is_finite() || !v.speed_kn.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: "vessel".to_string(),
            });
        }
        if v.speed_kn.abs() > MAX_VESSEL_SPEED_KN {
            return Err(SkyfixError::InvalidField {
                field: "vessel.speed_kn".to_string(),
                message: format!(
                    "{} kn is not a speed over the ground a navigator can sight from; at most \
                     {MAX_VESSEL_SPEED_KN} kn either way",
                    v.speed_kn
                ),
            });
        }
    }
    Ok(())
}

/// The session's clock uncertainty, seconds (CONVENTIONS 6), guarded.
pub(crate) fn clock_sigma_s(session: &Session) -> f64 {
    let s = session.clock.uncertainty_s;
    if s.is_finite() && s > 0.0 { s } else { 0.0 }
}

/// Where a vessel at `p` is `hours` later (negative: earlier), on a constant course and
/// speed: the great circle through `p` with that course at `p`. Over the minutes a noon
/// run or an averaging run spans this is the dead-reckoning track to far better than
/// the dead reckoning itself (docs/NAVIGATION_METHODS.md, "Moving vessel").
pub fn dr_move(p: Point, vessel: Option<VesselMotion>, hours: f64) -> Point {
    match vessel {
        Some(v) if v.speed_kn != 0.0 && hours != 0.0 => {
            destination(p, v.course_deg.to_radians(), nm_to_rad(v.speed_kn * hours))
        }
        _ => p,
    }
}

// ---------------------------------------------------------------------------
// The body's direction at any instant near the run
// ---------------------------------------------------------------------------

/// A straight-line model of a body's GHA and declination, fitted to the run's own
/// directions. Used when every sight carries a supplied direction (the user's almanac
/// wins, CONVENTIONS 10) or when the provider cannot answer.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LinearTrack {
    t0: f64,
    gha0_deg: f64,
    gha_rate_deg_per_day: f64,
    dec0_deg: f64,
    dec_rate_deg_per_day: f64,
}

impl LinearTrack {
    fn fit(sights: &[ReducedSight], nominal_gha_rate_deg_per_day: f64) -> LinearTrack {
        let t0 = sights.first().map_or(0.0, |s| s.jd_utc);
        // Unwrap the GHA so a run across the 0/360 line is a straight line.
        let mut ghas: Vec<f64> = Vec::with_capacity(sights.len());
        for s in sights {
            let g = match ghas.last() {
                Some(&prev) => prev + norm_180(s.gha_deg - prev),
                None => s.gha_deg,
            };
            ghas.push(g);
        }
        let n = sights.len() as f64;
        let ts: Vec<f64> = sights.iter().map(|s| s.jd_utc - t0).collect();
        let t_mean = ts.iter().sum::<f64>() / n.max(1.0);
        let stt: f64 = ts.iter().map(|t| (t - t_mean) * (t - t_mean)).sum();
        let g_mean = ghas.iter().sum::<f64>() / n.max(1.0);
        let d_mean = sights.iter().map(|s| s.dec_deg).sum::<f64>() / n.max(1.0);
        // Two instants a few seconds apart are enough to define a rate; one is not.
        let (gha_rate, dec_rate) = if stt > (1.0 / SECONDS_PER_DAY).powi(2) {
            let sg: f64 = ts
                .iter()
                .zip(&ghas)
                .map(|(t, g)| (t - t_mean) * (g - g_mean))
                .sum();
            let sd: f64 = ts
                .iter()
                .zip(sights)
                .map(|(t, s)| (t - t_mean) * (s.dec_deg - d_mean))
                .sum();
            (sg / stt, sd / stt)
        } else {
            (nominal_gha_rate_deg_per_day, 0.0)
        };
        LinearTrack {
            t0,
            gha0_deg: g_mean - gha_rate * t_mean,
            gha_rate_deg_per_day: gha_rate,
            dec0_deg: d_mean - dec_rate * t_mean,
            dec_rate_deg_per_day: dec_rate,
        }
    }

    /// Semidiameter and parallax are zero here on purpose: a track direction is used
    /// for geometry only, never to correct an altitude (the sights are already reduced).
    fn at(&self, jd_utc: f64) -> GeocentricDirection {
        let dt = jd_utc - self.t0;
        GeocentricDirection {
            gha_deg: norm_360(self.gha0_deg + self.gha_rate_deg_per_day * dt),
            dec_deg: (self.dec0_deg + self.dec_rate_deg_per_day * dt).clamp(-90.0, 90.0),
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        }
    }
}

/// The body's apparent geocentric direction at any instant near the run: the provider
/// when it can answer (and the run is not entirely supplied), otherwise a straight line
/// through the run's own directions. Rates are always taken numerically from this
/// track, never assumed, so a body with its own motion (the Moon, CONVENTIONS 13.1)
/// is handled the same way as the Sun and the stars.
pub struct BodyTrack<'a> {
    body: String,
    provider: Option<&'a dyn DirectionSource>,
    linear: LinearTrack,
}

impl<'a> BodyTrack<'a> {
    pub fn new(body: &str, sights: &[ReducedSight], source: &'a dyn DirectionSource) -> Self {
        let nominal = source.gha_rate_deg_per_hour(body) * 24.0;
        let linear = LinearTrack::fit(sights, nominal);
        let all_supplied = !sights.is_empty()
            && sights
                .iter()
                .all(|s| s.direction_source == SUPPLIED_DIRECTION_SOURCE);
        let provider = if all_supplied {
            None
        } else {
            let t = sights.first().map_or(0.0, |s| s.jd_utc);
            source.direction(body, t).ok().map(|_| source)
        };
        BodyTrack {
            body: body.to_string(),
            provider,
            linear,
        }
    }

    /// Where the directions come from, for the report.
    pub fn describe(&self) -> String {
        match self.provider {
            Some(p) => p.name().to_string(),
            None => "a straight line through the sights' supplied directions".to_string(),
        }
    }

    pub fn direction(&self, jd_utc: f64) -> GeocentricDirection {
        if let Some(p) = self.provider
            && let Ok(d) = p.direction(&self.body, jd_utc)
            && d.gha_deg.is_finite()
            && d.dec_deg.is_finite()
        {
            return GeocentricDirection {
                gha_deg: norm_360(d.gha_deg),
                ..d
            };
        }
        self.linear.at(jd_utc)
    }

    /// GHA rate, degrees per day, by a central difference over +/-60 s.
    pub fn gha_rate_deg_per_day(&self, jd_utc: f64) -> f64 {
        let h = 60.0 / SECONDS_PER_DAY;
        let a = self.direction(jd_utc - h).gha_deg;
        let b = self.direction(jd_utc + h).gha_deg;
        norm_180(b - a) / (2.0 * h)
    }
}

// ---------------------------------------------------------------------------
// Geometry shared by the methods
// ---------------------------------------------------------------------------

/// `Hc` and `Zn` (radians) of a direction seen from `p` (CONVENTIONS 3).
pub fn hc_zn(p: Point, d: &GeocentricDirection) -> (f64, f64) {
    altitude_azimuth(p, d.gha_deg.to_radians(), d.dec_deg.to_radians())
}

/// Every latitude in `[-pi/2, pi/2]` at which a body at (`gha`, `dec`) has altitude `h`
/// for an observer at east longitude `lon` (all radians): the altitude equation
/// `sin h = sin(phi) sin(dec) + cos(phi) cos(dec) cos(LHA)` solved for `phi`.
///
/// Writing `A = sin dec`, `B = cos dec cos LHA`, `R = hypot(A, B)` and
/// `psi = atan2(B, A)`, the equation is `R sin(phi + psi) = sin h`, so
/// `phi = asin(sin h / R) - psi` or `pi - asin(sin h / R) - psi`. Empty when
/// `|sin h| > R`: no latitude on that meridian sees the body that high.
pub fn latitudes_for_altitude(h: f64, gha: f64, dec: f64, lon: f64) -> Vec<f64> {
    let lha = gha + lon;
    let a = dec.sin();
    let b = dec.cos() * lha.cos();
    let r = a.hypot(b);
    let c = h.sin();
    if r.is_nan() || r <= 0.0 || c.abs() > r * (1.0 + 1e-15) {
        return Vec::new();
    }
    let psi = b.atan2(a);
    let base = (c / r).clamp(-1.0, 1.0).asin();
    let mut out: Vec<f64> = Vec::with_capacity(2);
    for cand in [base - psi, std::f64::consts::PI - base - psi] {
        let phi = norm_pi(cand);
        if (-FRAC_PI_2 - 1e-12..=FRAC_PI_2 + 1e-12).contains(&phi)
            && !out.iter().any(|&q| (q - phi).abs() < 1e-13)
        {
            out.push(phi.clamp(-FRAC_PI_2, FRAC_PI_2));
        }
    }
    out
}

/// The instant nearest `t_guess` at which `LHA = GHA(t) + lon(t) = 0`: upper meridian
/// passage (CONVENTIONS 13.3, from the apparent geocentric GHA). `lon_deg_at` is the
/// observer's east longitude at `t`, which moves for a vessel under way. Newton on the
/// wrapped LHA with a numerical rate; `None` if it does not settle.
pub fn meridian_passage(
    track: &BodyTrack<'_>,
    lon_deg_at: &dyn Fn(f64) -> f64,
    t_guess: f64,
) -> Option<f64> {
    let lha = |t: f64| norm_180(track.direction(t).gha_deg + lon_deg_at(t));
    let h = 30.0 / SECONDS_PER_DAY;
    let mut t = t_guess;
    for _ in 0..12 {
        let rate = norm_180(lha(t + h) - lha(t - h)) / (2.0 * h);
        if !rate.is_finite() || rate.abs() < 1e-6 {
            return None;
        }
        let step = -lha(t) / rate;
        if !step.is_finite() {
            return None;
        }
        // A step of more than half a day would jump to another passage.
        t += step.clamp(-0.5, 0.5);
        // A Julian date near 2.46e6 resolves 4.7e-10 day (40 microseconds), so stop at
        // a few of those: 2e-9 day is 0.17 ms, 0.0007' of LHA.
        if step.abs() < JD_STEP_TOLERANCE {
            return Some(t);
        }
    }
    let residual = lha(t).abs();
    if residual < 1e-6 { Some(t) } else { None }
}

/// Inverse of a symmetric 2x2 matrix and its condition number (ratio of eigenvalues).
pub(crate) fn inverse_2x2(a: [[f64; 2]; 2]) -> Option<([[f64; 2]; 2], f64)> {
    let (values, _) = crate::linalg::eigen_sym2(a);
    let det = a[0][0] * a[1][1] - a[0][1] * a[1][0];
    if !det.is_finite() || det <= 0.0 || values[1].is_nan() || values[1] <= 0.0 {
        return None;
    }
    let inv = [
        [a[1][1] / det, -a[0][1] / det],
        [-a[1][0] / det, a[0][0] / det],
    ];
    Some((inv, values[0] / values[1]))
}

// ---------------------------------------------------------------------------
// Plain-language formatting for the rules a result states
// ---------------------------------------------------------------------------

/// `39°48.7′` for an unsigned angle, rounded to 0.1′ with the carry handled.
pub fn fmt_dm(deg: f64) -> String {
    let tenths = (deg.abs() * 600.0).round() as i64;
    let d = tenths / 600;
    let m = (tenths % 600) as f64 / 10.0;
    format!("{d}°{m:04.1}′")
}

/// `39°48.7′ N` / `4°09.9′ S`.
pub fn fmt_lat(deg: f64) -> String {
    format!("{} {}", fmt_dm(deg), if deg < 0.0 { "S" } else { "N" })
}

/// `44°33.0′ W` / `151°12.6′ E`.
pub fn fmt_lon(deg: f64) -> String {
    format!("{} {}", fmt_dm(deg), if deg < 0.0 { "W" } else { "E" })
}

/// `+39°48.7′` / `-4°09.9′`, for arithmetic written out.
pub fn fmt_signed(deg: f64) -> String {
    format!("{}{}", if deg < 0.0 { "−" } else { "+" }, fmt_dm(deg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::altitude;

    const D: f64 = std::f64::consts::PI / 180.0;

    #[test]
    fn the_altitude_equation_solved_for_latitude_round_trips() {
        for &lat in &[-60.0, -20.0, 0.0, 12.5, 39.95, 68.0, 85.0] {
            for &dec in &[-23.0, -4.2, 0.0, 19.0, 89.3] {
                for &lha in &[0.0, 2.0, 15.0, 70.0, 180.0, 300.0] {
                    let p = Point::from_deg(lat, 10.0);
                    let gha = (lha - 10.0) * D;
                    let h = altitude(p, gha, dec * D);
                    if h < 0.0 {
                        continue;
                    }
                    let cands = latitudes_for_altitude(h, gha, dec * D, 10.0 * D);
                    assert!(
                        cands.iter().any(|&c| (c - lat * D).abs() < 1e-11),
                        "lat {lat} dec {dec} lha {lha}: {cands:?}"
                    );
                    for c in cands {
                        let back = altitude(Point::new(c, 10.0 * D), gha, dec * D);
                        assert!((back - h).abs() < 1e-11);
                    }
                }
            }
        }
    }

    #[test]
    fn an_impossible_altitude_has_no_latitude() {
        // A body 90 deg of LHA away on the equator can never be 60 deg high.
        assert!(latitudes_for_altitude(60.0 * D, 90.0 * D, 0.0, 0.0).is_empty());
    }

    #[test]
    fn degrees_and_minutes_carry_correctly() {
        assert_eq!(fmt_dm(39.0 + 48.66 / 60.0), "39°48.7′");
        assert_eq!(fmt_dm(4.0 + 9.9 / 60.0), "4°09.9′");
        assert_eq!(fmt_dm(44.0 + 59.97 / 60.0), "45°00.0′");
        assert_eq!(fmt_lat(-4.165), "4°09.9′ S");
        assert_eq!(fmt_lon(-44.55), "44°33.0′ W");
        assert_eq!(fmt_signed(-4.165), "−4°09.9′");
    }

    #[test]
    fn an_impossible_speed_is_refused_not_averaged() {
        // Verifier regression: 1e6 kn (a typo for 10) passed the finiteness check and the
        // averaging method returned Ho = 158.9 deg; 1e308 kn returned NaN as a result.
        let v = |speed_kn: f64| {
            check_vessel(Some(VesselMotion {
                course_deg: 45.0,
                speed_kn,
            }))
        };
        for bad in [1e6, 1e308, -1001.0] {
            let e = v(bad).unwrap_err().to_string();
            assert!(e.contains("speed_kn"), "{e}");
        }
        for fine in [0.0, 12.0, -12.0, 1000.0] {
            assert!(v(fine).is_ok(), "{fine}");
        }
        assert!(check_vessel(None).is_ok());
    }

    #[test]
    fn dead_reckoning_backwards_and_forwards_is_the_same_great_circle() {
        let p = Point::from_deg(40.0, -70.0);
        let v = Some(VesselMotion {
            course_deg: 45.0,
            speed_kn: 12.0,
        });
        let ahead = dr_move(p, v, 0.25);
        let behind = dr_move(p, v, -0.25);
        let d1 = crate::geometry::angular_distance(p, ahead);
        let d2 = crate::geometry::angular_distance(p, behind);
        assert!((crate::units::rad_to_nm(d1) - 3.0).abs() < 1e-9);
        assert!((crate::units::rad_to_nm(d2) - 3.0).abs() < 1e-9);
        assert_eq!(dr_move(p, None, 5.0), p);
    }
}
