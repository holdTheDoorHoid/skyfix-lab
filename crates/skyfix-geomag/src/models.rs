//! The Gauss coefficients of each model at an instant (decimal year).
//!
//! - **WMM2025**: `g(t) = g(2025.0) + (t - 2025.0) g_dot` for `2025.0 <= t <= 2030.0`
//!   (technical report, equation 9); degree 12.
//! - **IGRF-14**: main-field models every five years from 1900.0 to 2025.0 (degree 10 up to
//!   1995.0, degree 13 from 2000.0), linearly interpolated between epochs, and the
//!   predictive secular variation after 2025.0 (degree 8). Between 1995.0 and 2000.0 the
//!   degree 11-13 terms grow linearly from zero, as the coefficient file's zeros imply and
//!   as IAGA's own software computes them. The rate of change is the slope of that
//!   piecewise-linear model: constant within each five-year interval.

use crate::coeffs::{
    IGRF14_FIRST_EPOCH, IGRF14_NEW, IGRF14_OLD, IGRF14_SV, WMM2025, WMM2025_EPOCH,
};
use crate::sh::{Gauss, N_MAX};

/// Number of IGRF-14 main-field epochs (1900.0 to 2025.0).
pub(crate) const IGRF14_EPOCHS: usize = 26;
/// Rows (g and h lines) of the IGRF-14 file for degree 10 and for degree 13.
const IGRF_OLD_ROWS: usize = 120;
const IGRF_ROWS: usize = 195;

/// `(is_h, n, m)` of each row of the IGRF coefficient file, in file order: for n, for m,
/// the g row, then the h row when m > 0.
fn igrf_row_index() -> [(bool, usize, usize); IGRF_ROWS] {
    let mut out = [(false, 0, 0); IGRF_ROWS];
    let mut k = 0;
    for n in 1..=N_MAX {
        for m in 0..=n {
            out[k] = (false, n, m);
            k += 1;
            if m > 0 {
                out[k] = (true, n, m);
                k += 1;
            }
        }
    }
    debug_assert_eq!(k, IGRF_ROWS);
    out
}

/// IGRF-14 coefficient of file row `row` at epoch index `k` (0 = 1900.0 ... 25 = 2025.0), nT.
pub(crate) fn igrf14_epoch_value(row: usize, k: usize) -> f64 {
    if k < 20 {
        if row < IGRF_OLD_ROWS {
            f64::from(IGRF14_OLD[row][k])
        } else {
            0.0
        }
    } else {
        f64::from(IGRF14_NEW[row][k - 20]) / 100.0
    }
}

/// IGRF-14 predictive secular variation of file row `row`, nT per year.
pub(crate) fn igrf14_sv_value(row: usize) -> f64 {
    f64::from(IGRF14_SV[row]) / 10.0
}

/// WMM2025 coefficients at decimal year `t` (no range check here).
pub(crate) fn wmm2025_at(t: f64) -> Gauss {
    let mut out = Gauss::zero();
    let dt = t - WMM2025_EPOCH;
    let mut k = 0;
    for n in 1..=12 {
        for m in 0..=n {
            let [g, h, gd, hd] = WMM2025[k].map(|v| f64::from(v) / 10.0);
            out.g[n][m] = g + dt * gd;
            out.h[n][m] = h + dt * hd;
            out.g_dot[n][m] = gd;
            out.h_dot[n][m] = hd;
            k += 1;
        }
    }
    out
}

/// IGRF-14 coefficients at decimal year `t` (no range check here: before 1900 the first
/// interval is extended and after 2025 the secular variation is extrapolated; callers
/// refuse those dates).
pub(crate) fn igrf14_at(t: f64) -> Gauss {
    let mut out = Gauss::zero();
    let last_epoch = IGRF14_FIRST_EPOCH + 5.0 * (IGRF14_EPOCHS - 1) as f64;
    let rows = igrf_row_index();
    if t >= last_epoch {
        let dt = t - last_epoch;
        for (row, &(is_h, n, m)) in rows.iter().enumerate() {
            let c = igrf14_epoch_value(row, IGRF14_EPOCHS - 1);
            let sv = igrf14_sv_value(row);
            let (v, r) = (c + dt * sv, sv);
            set(&mut out, is_h, n, m, v, r);
        }
    } else {
        let x = (t - IGRF14_FIRST_EPOCH) / 5.0;
        let k = (x.floor().max(0.0) as usize).min(IGRF14_EPOCHS - 2);
        let frac = x - k as f64;
        for (row, &(is_h, n, m)) in rows.iter().enumerate() {
            let c0 = igrf14_epoch_value(row, k);
            let c1 = igrf14_epoch_value(row, k + 1);
            let v = c0 + (c1 - c0) * frac;
            let r = (c1 - c0) / 5.0;
            set(&mut out, is_h, n, m, v, r);
        }
    }
    out
}

fn set(out: &mut Gauss, is_h: bool, n: usize, m: usize, value: f64, rate: f64) {
    if is_h {
        out.h[n][m] = value;
        out.h_dot[n][m] = rate;
    } else {
        out.g[n][m] = value;
        out.g_dot[n][m] = rate;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse `crates/skyfix-geomag/data/igrf14coeffs.txt` into (row, epoch values, sv).
    fn igrf_file() -> Vec<(String, usize, usize, Vec<f64>, f64)> {
        let text = include_str!("../data/igrf14coeffs.txt");
        text.lines()
            .filter(|l| l.starts_with("g ") || l.starts_with("h "))
            .map(|l| {
                let f: Vec<&str> = l.split_whitespace().collect();
                let vals: Vec<f64> = f[3..29].iter().map(|v| v.parse().unwrap()).collect();
                (
                    f[0].to_string(),
                    f[1].parse().unwrap(),
                    f[2].parse().unwrap(),
                    vals,
                    f[29].parse().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn the_tables_are_the_published_files() {
        // IGRF-14: every value of every epoch and the secular variation, exactly.
        let rows = igrf_file();
        assert_eq!(rows.len(), IGRF_ROWS);
        let index = igrf_row_index();
        for (row, (kind, n, m, vals, sv)) in rows.iter().enumerate() {
            assert_eq!(index[row], (kind == "h", *n, *m), "row {row}");
            for (k, v) in vals.iter().enumerate() {
                assert_eq!(igrf14_epoch_value(row, k), *v, "{kind} {n} {m} epoch {k}");
            }
            assert_eq!(igrf14_sv_value(row), *sv, "{kind} {n} {m} sv");
        }
        // WMM2025: every coefficient and rate, exactly.
        let text = include_str!("../data/WMM2025.COF");
        let mut lines = text.lines();
        let head: Vec<&str> = lines.next().unwrap().split_whitespace().collect();
        assert_eq!((head[0], head[1]), ("2025.0", "WMM-2025"));
        let mut k = 0;
        for l in lines {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.is_empty() || f[0].starts_with("9999") {
                break;
            }
            let v: Vec<f64> = f[2..6].iter().map(|x| x.parse().unwrap()).collect();
            let got = WMM2025[k].map(|x| f64::from(x) / 10.0);
            for j in 0..4 {
                assert_eq!(got[j], v[j], "WMM row {k} column {j}");
            }
            k += 1;
        }
        assert_eq!(k, 90);
    }

    #[test]
    fn interpolation_hits_every_epoch_and_the_rate_is_the_interval_slope() {
        let rows = igrf_file();
        for k in 0..IGRF14_EPOCHS {
            let t = 1900.0 + 5.0 * k as f64;
            let g = igrf14_at(t);
            assert_eq!(g.g[1][0], rows[0].3[k], "g10 at {t}");
            assert_eq!(g.h[13][13], rows[194].3[k], "h13,13 at {t}");
        }
        let mid = igrf14_at(1997.5);
        // Degree 11-13 halfway between zero (1995) and the 2000 value.
        assert!((mid.g[11][0] - rows[120].3[20] / 2.0).abs() < 1e-12);
        assert!((mid.g_dot[1][0] - (rows[0].3[20] - rows[0].3[19]) / 5.0).abs() < 1e-12);
        let late = igrf14_at(2028.0);
        assert!((late.g[1][0] - (rows[0].3[25] + 3.0 * rows[0].4)).abs() < 1e-9);
        assert_eq!(late.g_dot[1][0], rows[0].4);
    }
}
