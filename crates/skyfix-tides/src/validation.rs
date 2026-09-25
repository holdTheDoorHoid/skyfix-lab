//! Comparing a list of high and low waters with a reference list (NOAA's), as the tests
//! and the pipeline's sweep (`examples/noaa_sweep.rs`) do.
//!
//! The rules, and why (CONVENTIONS 13.10, ACCURACY "Tides"):
//!
//! - Each reference extreme is paired with our nearest extreme of the same kind within an
//!   hour. Heights must agree within [`Tolerance::height_m`] (5 cm).
//! - Times must agree within [`Tolerance::time_min`] (2 min), **or**, at a flat turn of
//!   the tide, within three times the time uncertainty that rounding NOAA's published
//!   constants (amplitudes to 1 mm, phases to 0.1°) alone causes there: that rounding
//!   moves the rate of rise by `σ_r = sqrt(Σ (0.0005·ω)²/3 + (A·ω·0.05°)²/3)` m/h, which
//!   moves the instant where the rate is zero by `σ_r / |acceleration|`. At the flat
//!   high and low waters of diurnal ports that is several minutes; elsewhere it is well
//!   under the 2-minute floor.
//! - Both lists are tide tables: ripples shallower than 0.1 ft within 2 hours are
//!   dropped by NOAA's rule (`predict::table_rule`). Where that rule meets a double high
//!   or low whose peaks differ by less than [`Tolerance::stand_m`] (5 mm, the rounding
//!   noise again), the two lists may keep different peaks of the same stand: an unpaired
//!   extreme on each side, of the same kind, within 3 hours and 5 mm of each other, is
//!   counted as such a stand (`stands`), not as missing or invented. Every other extreme
//!   must be paired both ways.

use crate::predict::{Extreme, ExtremeKind, Predictor};

/// A reference high or low water.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefExtreme {
    pub jd_utc: f64,
    pub height_m: f64,
    pub high: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tolerance {
    pub time_min: f64,
    pub height_m: f64,
    pub stand_m: f64,
    /// Multiple of the rounding-implied time uncertainty allowed at flat turns.
    pub sigmas: f64,
}

impl Default for Tolerance {
    fn default() -> Self {
        Tolerance {
            time_min: 2.0,
            height_m: 0.05,
            stand_m: 0.005,
            sigmas: 3.0,
        }
    }
}

/// The outcome for one station.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Comparison {
    /// Reference extremes paired with ours.
    pub matched: usize,
    /// Of those, how many needed the flat-turn allowance for their time.
    pub flat: usize,
    /// Worst |time difference| (minutes) over all pairs, and over the pairs within the
    /// 2-minute floor's reach (not flat).
    pub worst_dt_min: f64,
    pub worst_dt_sharp_min: f64,
    /// Worst |height difference|, metres.
    pub worst_dh_m: f64,
    /// Pairs whose time failed both rules: (reference JD, dt minutes, allowed minutes).
    pub late: Vec<(f64, f64, f64)>,
    /// Pairs whose height failed: (reference JD, dh metres).
    pub off_height: Vec<(f64, f64)>,
    /// Reference extremes with no partner (inside the window, away from its edges).
    pub missing: Vec<f64>,
    /// Our extremes with no reference partner (inside the window, away from its edges).
    pub invented: Vec<f64>,
    /// Stands where the two lists keep different peaks (see the module notes).
    pub stands: usize,
}

impl Comparison {
    pub fn passes(&self) -> bool {
        self.late.is_empty()
            && self.off_height.is_empty()
            && self.missing.is_empty()
            && self.invented.is_empty()
    }
}

/// The rate uncertainty (m/h) that rounding the constants to 1 mm and 0.1° implies, from
/// the predictor's terms (uniform rounding errors: variance = half-step² / 3).
pub fn rounding_rate_sigma(p: &Predictor) -> f64 {
    let half_amp = 0.0005;
    let half_phase = 0.05f64.to_radians();
    p.terms()
        .iter()
        .map(|t| {
            let w = t.constituent.speed_deg_per_hour().to_radians();
            (half_amp * w).powi(2) / 3.0 + (t.amplitude_m * w * half_phase).powi(2) / 3.0
        })
        .sum::<f64>()
        .sqrt()
}

/// Compare `ours` (heights on the same datum as the reference) with `reference` over
/// `[jd0, jd1]`. `accel_at` gives our curve's acceleration (m/h²) at an instant and
/// `sigma_rate` the rounding-implied rate uncertainty (m/h); pass `f64::INFINITY` as
/// the acceleration to disable the flat-turn allowance (subordinate stations use the
/// reference station's curve for both).
pub fn compare(
    reference: &[RefExtreme],
    ours: &[Extreme],
    jd0: f64,
    jd1: f64,
    tol: Tolerance,
    mut accel_at: impl FnMut(f64) -> f64,
    sigma_rate: f64,
) -> Comparison {
    let mut c = Comparison::default();
    let mut used = vec![false; ours.len()];
    let inside = |t: f64| t >= jd0 + 3.0 / 1440.0 && t <= jd1 - 3.0 / 1440.0;
    let mut unmatched_ref = Vec::new();
    for r in reference {
        let best = ours
            .iter()
            .enumerate()
            .filter(|(_, o)| (o.kind == ExtremeKind::High) == r.high)
            .min_by(|a, b| {
                (a.1.jd_utc - r.jd_utc)
                    .abs()
                    .total_cmp(&(b.1.jd_utc - r.jd_utc).abs())
            });
        let partner = best.filter(|(_, o)| (o.jd_utc - r.jd_utc).abs() * 1440.0 < 60.0);
        let Some((j, o)) = partner else {
            // Within 3 minutes of an edge, the reference's rounding to the minute decides
            // which side an extreme falls: not a disagreement.
            if inside(r.jd_utc) {
                unmatched_ref.push(*r);
            }
            continue;
        };
        used[j] = true;
        c.matched += 1;
        let dt = (o.jd_utc - r.jd_utc) * 1440.0;
        let dh = o.height_m - r.height_m;
        c.worst_dt_min = c.worst_dt_min.max(dt.abs());
        c.worst_dh_m = c.worst_dh_m.max(dh.abs());
        if dh.abs() > tol.height_m {
            c.off_height.push((r.jd_utc, dh));
        }
        if dt.abs() <= tol.time_min {
            c.worst_dt_sharp_min = c.worst_dt_sharp_min.max(dt.abs());
        } else {
            let acc = accel_at(o.jd_utc).abs();
            let allowed = tol.sigmas * sigma_rate / acc * 60.0;
            if dt.abs() <= allowed {
                c.flat += 1;
            } else {
                c.late.push((r.jd_utc, dt, allowed.max(tol.time_min)));
            }
        }
    }
    let mut unmatched_ours: Vec<&Extreme> = ours
        .iter()
        .enumerate()
        .filter(|(j, o)| !used[*j] && inside(o.jd_utc))
        .map(|(_, o)| o)
        .collect();
    for r in unmatched_ref {
        let stand = unmatched_ours.iter().position(|o| {
            (o.kind == ExtremeKind::High) == r.high
                && (o.jd_utc - r.jd_utc).abs() * 1440.0 < 180.0
                && (o.height_m - r.height_m).abs() < tol.stand_m
        });
        match stand {
            Some(k) => {
                unmatched_ours.remove(k);
                c.stands += 1;
            }
            None => c.missing.push(r.jd_utc),
        }
    }
    c.invented = unmatched_ours.iter().map(|o| o.jd_utc).collect();
    c
}
