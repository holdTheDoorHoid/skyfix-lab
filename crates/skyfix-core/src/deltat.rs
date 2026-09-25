//! CONVENTIONS section 15.2: Delta-T = TT - UT1 with its standard uncertainty, and the
//! IERS UT1 - UTC history.
//!
//! # The model
//!
//! The same chain as Skyfield 1.55's `build_delta_t` (`timelib.py`), on this project's
//! own IERS table:
//!
//! | span (Julian epoch, TT) | Delta-T | source |
//! |---|---|---|
//! | 1973-01-02 to 2027-09-21 | IERS: `32.184 s + (TAI - UTC) - (UT1 - UTC)` from the weekly table ([`DUT1_E4`](data::DUT1_E4)); observed to 2026-09-24, IERS Bulletin A's prediction after | `iers`, then `prediction` |
//! | -720 to 1973 | Stephenson, Morrison & Hohenkerk 2016 splines in their 2020 revision (Table S15.2020), the last segment's linear term adjusted to meet the table's first value | `smh2016` |
//! | beyond both | the long-term parabola `-320 + 32.5 ((y - 1825)/100)^2` s | `parabola` |
//!
//! **Joining rule** (Skyfield's): on the left, a cubic Hermite segment over the 800 years
//! before -720 takes the parabola's value and slope at -1520 to the splines' at -720; on
//! the right, one from the table's last value and its slope over the table's last 365
//! days (times 366/365, as Skyfield computes it) to the parabola's value and slope at the
//! first whole century at least 800 years later (2800). The pure parabola holds before
//! -1520 and after 2800. The right-hand join is labelled `prediction`, the rest
//! `parabola`.
//!
//! Given the same table, Skyfield reproduces this curve to 1 microsecond
//! (`tools/timescales/gen_timescales.py` builds that Skyfield timescale and
//! `tests/timescales_reference.rs` compares). Skyfield's own bundled table ends in 2027
//! and has been a prediction since about 2026-01-23, 0.1 s off by September 2026, so its
//! future Delta-T differs from this one by up to 18 s around 2240, well inside either
//! one's uncertainty; both are the parabola after 2800.
//!
//! # The standard uncertainty
//!
//! - IERS observed values: 0.001 s (the weekly table's interpolation error: at most
//!   1.9 ms, 0.5 ms rms).
//! - 2026-01-24 to 2026-09-17, where the table is a prediction corrected to the
//!   observations at both ends: a Brownian bridge, `sqrt(0.001^2 + M^2 s (1 - s))` with
//!   `M` = 0.105 s, the size of the correction.
//! - After the last observation (2026-09-24): the larger of IERS Bulletin A's own
//!   prediction error `0.00025 n^0.75` s (`n` days) and Huber's random walk with drift
//!   ([`huber_sigma_s`], NASA's formula) counted from that date: 0.05 s after a year,
//!   10 s in 2060, 32 s in 2100, 15 min in 2650, 30 min in 3000.
//! - The splines, -720 to 1973: the published standard errors (Table
//!   DT-lod4500yrs.2020: 180 s at -720, 90 s at 0, 15 s at 1000-1600, 1 s in 1800,
//!   0.05 s from 1871), but never less than 0.11 s, the measured rms of the splines
//!   against the IERS values over 1973-2019 (their maximum there is 0.27 s).
//! - Before -720: Huber's formula counted from -500, NASA's calibration year for dates
//!   before 500 BC (3 732 s, about an hour, at -2000), never less than the 180 s the
//!   splines end with.

mod data;

use data::{
    DUT1_E4, EOP_BULLETIN_FIRST_OBSERVED_MJD, EOP_BUNDLE_LAST_OBSERVED_MJD, EOP_FIRST_MJD,
    EOP_GAP_MISS_S, EOP_LAST_OBSERVED_MJD, EOP_STEP_DAYS, S15, SMH_SIGMA,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub use data::EOP_RETRIEVED;

/// Where a Delta-T value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaTSource {
    /// Observed by the IERS (1973 to the build date).
    Iers,
    /// Stephenson, Morrison & Hohenkerk's splines (-720 to 1973).
    Smh2016,
    /// The long-term parabola, and the join from the splines to it before -720.
    Parabola,
    /// After the last observation: IERS Bulletin A's prediction, then the join to the
    /// parabola.
    Prediction,
}

impl DeltaTSource {
    pub fn name(self) -> &'static str {
        match self {
            DeltaTSource::Iers => "iers",
            DeltaTSource::Smh2016 => "smh2016",
            DeltaTSource::Parabola => "parabola",
            DeltaTSource::Prediction => "prediction",
        }
    }
}

/// Delta-T = TT - UT1 at an instant, with its standard uncertainty.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DeltaT {
    pub value_s: f64,
    pub sigma_s: f64,
    pub source: DeltaTSource,
}

/// JD of the Julian epoch year 0.0 (Skyfield's `J` origin): `y = (jd - this) / 365.25`.
const JD_EPOCH_YEAR_0: f64 = 1_721_045.0;
const MJD_OFFSET: f64 = 2_400_000.5;
const TT_MINUS_TAI_S: f64 = 32.184;
/// Standard uncertainty of the IERS table where it is observed.
pub const SIGMA_OBSERVED_S: f64 = 0.001;
/// Floor under the splines' published standard error: their measured rms against IERS.
pub const SPLINE_SIGMA_FLOOR_S: f64 = 0.11;
/// Huber (2000): the variability of the length of day, ms^2 per year.
const HUBER_Q: f64 = 0.058;
/// Huber (2000): the span of the observations the variability was measured over, years.
const HUBER_M: f64 = 2500.0;
/// NASA's calibration year for Huber's formula before 500 BC.
const HUBER_PAST_CALIBRATION_YEAR: f64 = -500.0;
/// How far the joins reach, years (Skyfield's `patch_width`).
const PATCH_WIDTH_Y: f64 = 800.0;

/// Julian epoch year (TT) of a TT Julian date.
pub fn epoch_year(jd_tt: f64) -> f64 {
    (jd_tt - JD_EPOCH_YEAR_0) / 365.25
}

/// The long-term parabola (Stephenson, Morrison & Hohenkerk 2016), seconds.
pub fn parabola_s(year: f64) -> f64 {
    let t = (year - 1825.0) / 100.0;
    -320.0 + 32.5 * t * t
}

fn parabola_slope(year: f64) -> f64 {
    // d/dy of 32.5 ((y - 1825)/100)^2, seconds per year.
    0.65 * (year - 1825.0) / 100.0
}

/// Huber's (2000) standard error of Delta-T `n_years` from the calibration epoch,
/// seconds: `365.25 N sqrt((N Q / 3)(1 + N / M)) / 1000` with Q = 0.058 ms^2/yr and
/// M = 2500 yr, as NASA's "Uncertainty in Delta T" page states it.
pub fn huber_sigma_s(n_years: f64) -> f64 {
    let n = n_years.abs();
    365.25 * n * ((n * HUBER_Q / 3.0) * (1.0 + n / HUBER_M)).sqrt() / 1000.0
}

/// IERS Bulletin A's prediction error for UT1 - UTC `n_days` after its last observed
/// day, seconds (`S t = 0.00025 (MJD - MJD0)^0.75`).
pub fn bulletin_a_sigma_s(n_days: f64) -> f64 {
    0.000_25 * n_days.max(0.0).powf(0.75)
}

// ---------------------------------------------------------------------------
// Leap seconds, for the table (the same values as time::delta_at)
// ---------------------------------------------------------------------------

fn tai_minus_utc_at_mjd(mjd_utc: f64) -> f64 {
    crate::time::delta_at(mjd_utc + MJD_OFFSET)
}

// ---------------------------------------------------------------------------
// The IERS table
// ---------------------------------------------------------------------------

fn table_last_mjd() -> i32 {
    EOP_FIRST_MJD + EOP_STEP_DAYS * (DUT1_E4.len() as i32 - 1)
}

/// UT1 - TAI at sample `i`, seconds (continuous across leap seconds).
fn ut1_minus_tai_sample(i: usize) -> f64 {
    let mjd = EOP_FIRST_MJD + EOP_STEP_DAYS * i as i32;
    f64::from(DUT1_E4[i]) * 1e-4 - tai_minus_utc_at_mjd(f64::from(mjd))
}

/// UT1 - TAI at an MJD (UTC) inside the table, linear between the weekly samples.
fn ut1_minus_tai(mjd_utc: f64) -> Option<f64> {
    let first = f64::from(EOP_FIRST_MJD);
    let last = f64::from(table_last_mjd());
    if !(first..=last).contains(&mjd_utc) {
        return None;
    }
    let x = (mjd_utc - first) / f64::from(EOP_STEP_DAYS);
    let i = (x.floor() as usize).min(DUT1_E4.len() - 2);
    let f = x - i as f64;
    let (a, b) = (ut1_minus_tai_sample(i), ut1_minus_tai_sample(i + 1));
    Some(a + (b - a) * f)
}

/// Standard uncertainty of the table's UT1 - UTC (and so of its Delta-T) at an MJD.
fn table_sigma_s(mjd_utc: f64) -> f64 {
    let t0 = f64::from(EOP_BUNDLE_LAST_OBSERVED_MJD);
    let t1 = f64::from(EOP_BULLETIN_FIRST_OBSERVED_MJD);
    let last_obs = f64::from(EOP_LAST_OBSERVED_MJD);
    if mjd_utc <= t0 || (t1..=last_obs).contains(&mjd_utc) {
        SIGMA_OBSERVED_S
    } else if mjd_utc < t1 {
        let s = (mjd_utc - t0) / (t1 - t0);
        (SIGMA_OBSERVED_S * SIGMA_OBSERVED_S + EOP_GAP_MISS_S * EOP_GAP_MISS_S * s * (1.0 - s))
            .sqrt()
    } else {
        future_sigma_s(mjd_utc)
    }
}

/// Standard uncertainty after the last observation.
fn future_sigma_s(mjd_utc: f64) -> f64 {
    let n = mjd_utc - f64::from(EOP_LAST_OBSERVED_MJD);
    SIGMA_OBSERVED_S
        .max(bulletin_a_sigma_s(n))
        .max(huber_sigma_s(n / 365.25))
}

/// UT1 - UTC from the IERS table at `jd_utc`, with its standard uncertainty, or `None`
/// outside the table (MJD 41684 = 1973-01-02 to the last predicted sample, 2027-09-21).
/// Past 2026-09-24 the values are IERS Bulletin A's prediction.
pub fn iers_dut1(jd_utc: f64) -> Option<(f64, f64)> {
    let mjd = jd_utc - MJD_OFFSET;
    let u = ut1_minus_tai(mjd)?;
    Some((u + crate::time::delta_at(jd_utc), table_sigma_s(mjd)))
}

/// First and last instants (`jd_utc`, 0h UTC) of the IERS table, and its last observed
/// day.
pub fn iers_table_span() -> (f64, f64, f64) {
    (
        f64::from(EOP_FIRST_MJD) + MJD_OFFSET,
        f64::from(table_last_mjd()) + MJD_OFFSET,
        f64::from(EOP_LAST_OBSERVED_MJD) + MJD_OFFSET,
    )
}

/// Delta-T at the table's MJD sample (0h UTC), seconds.
fn table_delta_t_at_mjd(mjd_utc: f64) -> f64 {
    TT_MINUS_TAI_S - ut1_minus_tai(mjd_utc).expect("inside the table")
}

/// TT JD of 0h UTC on an MJD.
fn tt_of_mjd(mjd_utc: f64) -> f64 {
    mjd_utc + MJD_OFFSET + (TT_MINUS_TAI_S + tai_minus_utc_at_mjd(mjd_utc)) / 86_400.0
}

// ---------------------------------------------------------------------------
// The curve outside the table
// ---------------------------------------------------------------------------

/// A cubic in `t = (y - x0) / (x1 - x0)`: `a0 + a1 t + a2 t^2 + a3 t^3`.
#[derive(Debug, Clone, Copy)]
struct Segment {
    x0: f64,
    x1: f64,
    a: [f64; 4],
}

impl Segment {
    /// Skyfield's `build_spline_given_ends`: value and slope (per year) at both ends.
    fn given_ends(x0: f64, y0: f64, slope0: f64, x1: f64, y1: f64, slope1: f64) -> Self {
        let width = x1 - x0;
        let (s0, s1) = (slope0 * width, slope1 * width);
        Segment {
            x0,
            x1,
            a: [
                y0,
                s0,
                -2.0 * s0 - s1 - 3.0 * y0 + 3.0 * y1,
                s0 + s1 + 2.0 * y0 - 2.0 * y1,
            ],
        }
    }

    fn eval(&self, y: f64) -> f64 {
        let t = (y - self.x0) / (self.x1 - self.x0);
        // Horner with the highest power first, as Skyfield's `Splines`.
        ((self.a[3] * t + self.a[2]) * t + self.a[1]) * t + self.a[0]
    }

    fn slope(&self, y: f64) -> f64 {
        let w = self.x1 - self.x0;
        let t = (y - self.x0) / w;
        ((3.0 * self.a[3] * t + 2.0 * self.a[2]) * t + self.a[1]) / w
    }
}

fn s15_segment(row: &[f64; 6]) -> Segment {
    Segment {
        x0: row[0],
        x1: row[1],
        a: [row[2], row[3], row[4], row[5]],
    }
}

/// The joins and the adjusted last spline segment, computed once from the tables.
struct Curve {
    /// Splines before this year; the table (or the right-hand join) after it.
    table_start_year: f64,
    table_end_year: f64,
    /// Rows `S15[..n_s15]` are used; the last of them with `last_s15`'s adjusted linear
    /// term.
    n_s15: usize,
    last_s15: Segment,
    left: Segment,
    right: Segment,
}

fn curve() -> &'static Curve {
    static CURVE: OnceLock<Curve> = OnceLock::new();
    CURVE.get_or_init(|| {
        let first = f64::from(EOP_FIRST_MJD);
        let last = f64::from(table_last_mjd());
        let table_start_year = epoch_year(tt_of_mjd(first));
        let table_end_year = epoch_year(tt_of_mjd(last));
        // Keep the spline rows that start before the table (numpy's searchsorted, left).
        let n_s15 = S15.iter().filter(|r| r[0] < table_start_year).count();
        let mut last_s15 = s15_segment(&S15[n_s15 - 1]);
        let t = (table_start_year - last_s15.x0) / (last_s15.x1 - last_s15.x0);
        let current = last_s15.eval(table_start_year);
        last_s15.a[1] += (table_delta_t_at_mjd(first) - current) / t;
        // Left: the parabola at -1520 to the first spline row at -720.
        let s0 = s15_segment(&S15[0]);
        let x1 = s0.x0;
        let x0 = x1 - PATCH_WIDTH_Y;
        let left = Segment::given_ends(
            x0,
            parabola_s(x0),
            parabola_slope(x0),
            x1,
            s0.eval(x1),
            s0.slope(x1),
        );
        // Right: the table's last value and last-year slope to the parabola.
        let y_end = table_delta_t_at_mjd(last);
        let slope = (y_end - table_delta_t_at_mjd(last - 365.0)) * 366.0 / 365.0;
        let x1 = ((table_end_year + PATCH_WIDTH_Y) / 100.0).floor() * 100.0;
        let right = Segment::given_ends(
            table_end_year,
            y_end,
            slope,
            x1,
            parabola_s(x1),
            parabola_slope(x1),
        );
        Curve {
            table_start_year,
            table_end_year,
            n_s15,
            last_s15,
            left,
            right,
        }
    })
}

/// Delta-T off the table at Julian epoch `year` (TT): the splines, the joins, the
/// parabola.
fn curve_delta_t(year: f64) -> (f64, DeltaTSource) {
    let c = curve();
    if year < c.left.x0 {
        (parabola_s(year), DeltaTSource::Parabola)
    } else if year < c.left.x1 {
        (c.left.eval(year), DeltaTSource::Parabola)
    } else if year < c.table_start_year {
        // The row whose [K_i, K_{i+1}) holds the year, among the kept rows.
        let i = S15[..c.n_s15].partition_point(|r| r[0] <= year) - 1;
        let v = if i + 1 == c.n_s15 {
            c.last_s15.eval(year)
        } else {
            s15_segment(&S15[i]).eval(year)
        };
        (v, DeltaTSource::Smh2016)
    } else if year < c.right.x1 {
        (c.right.eval(year), DeltaTSource::Prediction)
    } else {
        (parabola_s(year), DeltaTSource::Parabola)
    }
}

/// Standard uncertainty off the table (see the module docs).
fn curve_sigma_s(year: f64, jd_tt: f64) -> f64 {
    let c = curve();
    if year >= c.table_start_year {
        // After the table: counted from the last observation.
        return future_sigma_s(utc_mjd_of_tt(jd_tt));
    }
    let (y_first, s_first) = SMH_SIGMA[0];
    if year < y_first {
        return s_first.max(huber_sigma_s(HUBER_PAST_CALIBRATION_YEAR - year));
    }
    let i = SMH_SIGMA.partition_point(|&(y, _)| y <= year);
    let s = if i >= SMH_SIGMA.len() {
        SMH_SIGMA[SMH_SIGMA.len() - 1].1
    } else {
        let (ya, sa) = SMH_SIGMA[i - 1];
        let (yb, sb) = SMH_SIGMA[i];
        sa + (sb - sa) * (year - ya) / (yb - ya)
    };
    s.max(SPLINE_SIGMA_FLOOR_S)
}

/// The UTC MJD of a TT instant, good to a microsecond except within a minute of a
/// leap second (where it is off by up to a second, which moves Delta-T by nanoseconds).
fn utc_mjd_of_tt(jd_tt: f64) -> f64 {
    let approx = jd_tt - (TT_MINUS_TAI_S + 37.0) / 86_400.0;
    let dat = crate::time::delta_at(approx);
    jd_tt - (TT_MINUS_TAI_S + dat) / 86_400.0 - MJD_OFFSET
}

/// Delta-T = TT - UT1 at the TT instant `jd_tt`, seconds (value only; the hot path).
///
/// `jd_tt` may be any of TT, UT1 or UTC: the value changes by at most 1 microsecond
/// inside the IERS table and by 0.03 s at -2000 (Delta-T 13 hours, rate 20 s a year).
pub fn delta_t_s(jd_tt: f64) -> f64 {
    let mjd = utc_mjd_of_tt(jd_tt);
    match ut1_minus_tai(mjd) {
        Some(u) => TT_MINUS_TAI_S - u,
        None => curve_delta_t(epoch_year(jd_tt)).0,
    }
}

/// Delta-T at the TT instant `jd_tt` with its standard uncertainty and source.
pub fn delta_t(jd_tt: f64) -> DeltaT {
    let mjd = utc_mjd_of_tt(jd_tt);
    match ut1_minus_tai(mjd) {
        Some(u) => DeltaT {
            value_s: TT_MINUS_TAI_S - u,
            sigma_s: table_sigma_s(mjd),
            // The whole of the last observed day counts as observed.
            source: if mjd < f64::from(EOP_LAST_OBSERVED_MJD) + 1.0 {
                DeltaTSource::Iers
            } else {
                DeltaTSource::Prediction
            },
        },
        None => {
            let year = epoch_year(jd_tt);
            let (value_s, source) = curve_delta_t(year);
            DeltaT {
                value_s,
                sigma_s: curve_sigma_s(year, jd_tt),
                source,
            }
        }
    }
}

/// Delta-T at the TT instant of a UT1 instant, `TT - UT1` in seconds, solved as
/// Skyfield's `ut1_jd` does (two evaluations; the error is below a nanosecond over
/// -2000..3000).
pub fn tt_minus_ut1_s(jd_ut1: f64) -> f64 {
    let first = jd_ut1 + delta_t_s(jd_ut1) / 86_400.0;
    delta_t_s(first)
}

/// TT of a UT1 instant: `UT1 + Delta-T(TT)` ([`tt_minus_ut1_s`]).
pub fn tt_of_ut1(jd_ut1: f64) -> f64 {
    jd_ut1 + tt_minus_ut1_s(jd_ut1) / 86_400.0
}

/// UT1 of a TT instant: `TT - Delta-T(TT)`.
pub fn ut1_of_tt(jd_tt: f64) -> f64 {
    jd_tt - delta_t_s(jd_tt) / 86_400.0
}

/// Year (Julian epoch) where the right-hand join meets the parabola (2800).
pub fn parabola_rejoins_year() -> f64 {
    curve().right.x1
}

/// Julian epoch (TT) of the table's first and last samples.
pub fn table_years() -> (f64, f64) {
    let c = curve();
    (c.table_start_year, c.table_end_year)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jd_tt_of_year(y: f64) -> f64 {
        2_451_545.0 + (y - 2000.0) * 365.25
    }

    #[test]
    fn huber_matches_nasas_table() {
        // NASA, "Uncertainty in Delta T", Table 3: calibration -500 before 500 BC, 2005
        // for the future.
        for (year, sigma) in [(-2000.0, 3732.0), (-1500.0, 1900.0), (-1000.0, 622.0)] {
            let s = huber_sigma_s(-500.0 - year);
            assert!((s - sigma).abs() < 1.0, "{year}: {s}");
        }
        for (year, sigma) in [(2500.0, 612.0), (3000.0, 1885.0)] {
            let s = huber_sigma_s(year - 2005.0);
            assert!((s - sigma).abs() < 1.0, "{year}: {s}");
        }
    }

    #[test]
    fn the_brief_orders_of_magnitude() {
        // 10 s in 2060, 33 s in 2100, 15 min in 2650, 30 min in 3000, an hour at 2000 BC.
        for (year, lo, hi) in [
            (2060.0, 8.0, 12.0),
            (2100.0, 28.0, 36.0),
            (2650.0, 800.0, 950.0),
            (3000.0, 1700.0, 1900.0),
            (-1999.0, 3400.0, 4000.0),
        ] {
            let s = delta_t(jd_tt_of_year(year)).sigma_s;
            assert!((lo..=hi).contains(&s), "{year}: {s}");
        }
    }

    #[test]
    fn sources_by_span() {
        assert_eq!(
            delta_t(jd_tt_of_year(-2000.0)).source,
            DeltaTSource::Parabola
        );
        assert_eq!(
            delta_t(jd_tt_of_year(-1000.0)).source,
            DeltaTSource::Parabola
        );
        assert_eq!(delta_t(jd_tt_of_year(-500.0)).source, DeltaTSource::Smh2016);
        assert_eq!(delta_t(jd_tt_of_year(1900.0)).source, DeltaTSource::Smh2016);
        assert_eq!(delta_t(jd_tt_of_year(2000.0)).source, DeltaTSource::Iers);
        assert_eq!(
            delta_t(jd_tt_of_year(2027.0)).source,
            DeltaTSource::Prediction
        );
        assert_eq!(
            delta_t(jd_tt_of_year(2100.0)).source,
            DeltaTSource::Prediction
        );
        assert_eq!(
            delta_t(jd_tt_of_year(2900.0)).source,
            DeltaTSource::Parabola
        );
        assert_eq!(parabola_rejoins_year(), 2800.0);
    }

    #[test]
    fn continuous_at_every_join() {
        let c = curve();
        for y in [
            c.left.x0,
            c.left.x1,
            c.table_start_year,
            c.table_end_year,
            c.right.x1,
        ] {
            let (a, b) = (
                delta_t(jd_tt_of_year(y) - 1e-4).value_s,
                delta_t(jd_tt_of_year(y) + 1e-4).value_s,
            );
            assert!((a - b).abs() < 1e-3, "{y}: {a} {b}");
        }
        // The splines join the table: the adjusted segment meets its first value.
        let first = f64::from(EOP_FIRST_MJD);
        let at = c.last_s15.eval(c.table_start_year);
        assert!((at - table_delta_t_at_mjd(first)).abs() < 1e-9);
    }

    #[test]
    fn known_values() {
        // J2000.0: IERS Delta-T 63.83 s (UT1 - UTC = +0.355 s, TAI - UTC = 32 s).
        let d = delta_t(2_451_545.0);
        assert!((d.value_s - 63.829).abs() < 0.005, "{d:?}");
        assert_eq!(d.sigma_s, SIGMA_OBSERVED_S);
        // The spline at -720 is its first row's a0.
        assert!((delta_t(jd_tt_of_year(-720.0)).value_s - 20_371.848).abs() < 1e-6);
        // The parabola at 3000 and -2000.
        assert!((delta_t(jd_tt_of_year(3000.0)).value_s - parabola_s(3000.0)).abs() < 1e-9);
        assert!((delta_t(jd_tt_of_year(-2000.0)).value_s - 47_229.531_25).abs() < 1e-6);
    }

    #[test]
    fn ut1_and_tt_invert_each_other() {
        for y in [-2000.0, -584.4, 1000.0, 1971.5, 2026.7, 2100.0, 3000.0] {
            let ut1 = jd_tt_of_year(y);
            let tt = tt_of_ut1(ut1);
            assert!(((ut1_of_tt(tt) - ut1) * 86_400.0).abs() < 1e-5, "{y}");
        }
    }

    #[test]
    fn iers_dut1_values_and_span() {
        // IERS Bulletin A, 2026-09-24: UT1 - UTC = -0.013473 s that day.
        let (v, s) = iers_dut1(2_461_307.5).unwrap();
        assert!((v + 0.013_473).abs() < 0.002, "{v}");
        assert_eq!(s, SIGMA_OBSERVED_S);
        // Across the 2016-12-31 leap second UT1 - UTC jumps by +1 s.
        let before = iers_dut1(2_457_753.5 + 0.999_99).unwrap().0;
        let after = iers_dut1(2_457_754.5).unwrap().0;
        assert!((after - before - 1.0).abs() < 0.002, "{before} {after}");
        let (first, last, last_obs) = iers_table_span();
        assert!(iers_dut1(first - 1e-3).is_none() && iers_dut1(last + 1e-3).is_none());
        assert_eq!(last_obs, 2_461_307.5);
        // A prediction a year on carries its growing uncertainty.
        let (_, s) = iers_dut1(last).unwrap();
        assert!((0.02..0.06).contains(&s), "{s}");
    }
}
