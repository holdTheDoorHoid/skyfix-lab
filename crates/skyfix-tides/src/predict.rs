//! Harmonic synthesis and the search for high and low water.
//!
//! The height about the station's mean sea level at an instant `t` in year `Y` is
//!
//! ```text
//! h(t) = Σ f·H · cos(V0 + u + ω·τ − G)
//! ```
//!
//! with `H` and `G` NOAA's amplitude and Greenwich phase (`phase_GMT`), `ω` the
//! constituent's speed, `τ` the hours since 0 h UTC on January 1 of `Y`, `V0` the
//! equilibrium argument at that instant, and `f`, `u` evaluated once for the middle of
//! `Y` ([`NodalMode::MidYear`], NOAA's convention, Schureman p. 157). The sum is
//! discontinuous by a few millimetres at each new year, exactly as NOAA's is.
//! [`NodalMode::Instant`] evaluates `f` and `u` at `t` instead; it exists to quantify the
//! difference (`tests/noaa_fixtures.rs`), not for use.

use std::f64::consts::PI;

use crate::schureman::{Constituent, elements, node_args};

const DEG: f64 = PI / 180.0;

/// Where `f` and `u` are evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NodalMode {
    /// At the middle of each calendar year, `V0` at its start: NOAA's convention.
    #[default]
    MidYear,
    /// At the instant of prediction.
    Instant,
}

/// One constituent of a station: NOAA's amplitude (metres) and Greenwich phase
/// (degrees, `phase_GMT`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Term {
    pub constituent: &'static Constituent,
    pub amplitude_m: f64,
    pub phase_deg: f64,
}

/// High or low water.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtremeKind {
    High,
    Low,
}

/// One high or low water: `height_m` about the station's mean sea level.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Extreme {
    pub kind: ExtremeKind,
    pub jd_utc: f64,
    pub height_m: f64,
}

/// Grid step of the extremum search, minutes. Two extremes closer together than this
/// could be missed; such a pair is a ripple far shallower than 0.1 ft, which the tide
/// table drops anyway ([`table_rule`]).
pub const SEARCH_STEP_MIN: f64 = 6.0;

/// A high and a low water closer together than this (in whole minutes)...
pub const TABLE_MIN_GAP_MIN: i64 = 120;
/// ...and differing in height by less than this (0.1 ft) are both left out of the tide
/// table: NOAA's rule, found from its own lists (`tools/tides/README.md`).
pub const TABLE_MIN_RANGE_M: f64 = 0.030_48;

/// NOAA's tide-table rule, applied to extremes in time order: scanning from the
/// earliest, a high and the next low (or a low and the next high) less than 2 hours
/// apart, their instants rounded to the minute, and less than 0.1 ft apart in height are
/// both dropped (a ripple on a rising or falling tide, or a stand, not a tide). Across
/// NOAA's 3 499 stations this reproduces NOAA's lists of high and low water except for
/// one sub-millimetre double high (tests/pack_real.rs).
pub fn table_rule(ex: &[Extreme]) -> Vec<Extreme> {
    let minute = |jd: f64| (jd * 1440.0).round() as i64;
    let mut out = Vec::with_capacity(ex.len());
    let mut k = 0;
    while k < ex.len() {
        if let Some(next) = ex.get(k + 1) {
            let a = &ex[k];
            if next.kind != a.kind
                && minute(next.jd_utc) - minute(a.jd_utc) < TABLE_MIN_GAP_MIN
                && (next.height_m - a.height_m).abs() < TABLE_MIN_RANGE_M
            {
                k += 2;
                continue;
            }
        }
        out.push(ex[k]);
        k += 1;
    }
    out
}

/// The Gregorian year containing `jd` (UTC).
pub fn year_of(jd: f64) -> i32 {
    let z = (jd + 0.5).floor() as i64;
    let a = z + 32_044;
    let b = (4 * a + 3).div_euclid(146_097);
    let c = a - (146_097 * b).div_euclid(4);
    let d = (4 * c + 3).div_euclid(1461);
    let e = c - (1461 * d).div_euclid(4);
    let m = (5 * e + 2).div_euclid(153);
    (100 * b + d - 4800 + m / 10) as i32
}

/// JD of 0 h UTC on January 1 of `year` (proleptic Gregorian).
pub fn jd_year_start(year: i32) -> f64 {
    let y = i64::from(year) + 4799;
    let jdn = 307 + 365 * y + y.div_euclid(4) - y.div_euclid(100) + y.div_euclid(400) - 32_045;
    jdn as f64 - 0.5
}

/// Per-year constants of the sum: `A = f·H`, `ω` (radians per hour) and the phase
/// `V0 + u − G` (radians) at 0 h UTC on January 1.
#[derive(Debug, Clone)]
struct YearTerms {
    year: i32,
    jd0: f64,
    jd1: f64,
    amp: Vec<f64>,
    omega: Vec<f64>,
    phase: Vec<f64>,
}

impl YearTerms {
    fn new(terms: &[Term], year: i32) -> YearTerms {
        let jd0 = jd_year_start(year);
        let jd1 = jd_year_start(year + 1);
        let e0 = elements(jd0);
        let em = elements(0.5 * (jd0 + jd1));
        let nod = node_args(em.n, em.p);
        let mut amp = Vec::with_capacity(terms.len());
        let mut omega = Vec::with_capacity(terms.len());
        let mut phase = Vec::with_capacity(terms.len());
        for t in terms {
            let (f, u) = t.constituent.node(&nod);
            amp.push(f * t.amplitude_m);
            omega.push(t.constituent.speed_deg_per_hour() * DEG);
            phase.push((t.constituent.v_deg(&e0) - t.phase_deg) * DEG + u);
        }
        YearTerms {
            year,
            jd0,
            jd1,
            amp,
            omega,
            phase,
        }
    }

    /// Height (m), rate (m/h) and acceleration (m/h²) at `jd` inside the year.
    fn eval(&self, jd: f64) -> (f64, f64, f64) {
        let tau = (jd - self.jd0) * 24.0;
        let (mut h, mut r, mut a) = (0.0, 0.0, 0.0);
        for k in 0..self.amp.len() {
            let w = self.omega[k];
            let (s, c) = (w * tau + self.phase[k]).rem_euclid(2.0 * PI).sin_cos();
            let amp = self.amp[k];
            h += amp * c;
            r -= amp * w * s;
            a -= amp * w * w * c;
        }
        (h, r, a)
    }
}

/// Harmonic predictions for one station. Keeps the per-year constants it has computed.
#[derive(Debug, Clone)]
pub struct Predictor {
    terms: Vec<Term>,
    mode: NodalMode,
    years: Vec<YearTerms>,
}

impl Predictor {
    pub fn new(terms: Vec<Term>, mode: NodalMode) -> Predictor {
        Predictor {
            terms,
            mode,
            years: Vec::new(),
        }
    }

    pub fn terms(&self) -> &[Term] {
        &self.terms
    }

    fn year(&mut self, year: i32) -> &YearTerms {
        if let Some(k) = self.years.iter().position(|y| y.year == year) {
            return &self.years[k];
        }
        if self.years.len() >= 8 {
            self.years.remove(0);
        }
        self.years.push(YearTerms::new(&self.terms, year));
        self.years.last().expect("just pushed")
    }

    /// Height (m about mean sea level), rate (m/h) and acceleration (m/h²) at `jd`.
    pub fn eval(&mut self, jd: f64) -> (f64, f64, f64) {
        match self.mode {
            NodalMode::MidYear => self.year(year_of(jd)).eval(jd),
            NodalMode::Instant => self.eval_instant(jd),
        }
    }

    fn eval_instant(&self, jd: f64) -> (f64, f64, f64) {
        let year = year_of(jd);
        let jd0 = jd_year_start(year);
        let e0 = elements(jd0);
        let now = elements(jd);
        let nod = node_args(now.n, now.p);
        let tau = (jd - jd0) * 24.0;
        let (mut h, mut r, mut a) = (0.0, 0.0, 0.0);
        for t in &self.terms {
            let (f, u) = t.constituent.node(&nod);
            let w = t.constituent.speed_deg_per_hour() * DEG;
            let arg = w * tau + (t.constituent.v_deg(&e0) - t.phase_deg) * DEG + u;
            let (s, c) = arg.rem_euclid(2.0 * PI).sin_cos();
            let amp = f * t.amplitude_m;
            h += amp * c;
            r -= amp * w * s;
            a -= amp * w * w * c;
        }
        (h, r, a)
    }

    /// Height about mean sea level, metres.
    pub fn height(&mut self, jd: f64) -> f64 {
        self.eval(jd).0
    }

    /// Heights at `jd_start + k·step_days` for `k = 0, 1, …` while not after `jd_end`.
    /// Mid-year mode steps each constituent's phasor by rotation, re-seeded exactly
    /// every 256 samples and at each new year.
    pub fn sample(&mut self, jd_start: f64, jd_end: f64, step_days: f64) -> (Vec<f64>, Vec<f64>) {
        let n = ((jd_end - jd_start) / step_days + 1e-9).floor().max(-1.0) as i64 + 1;
        let n = n.max(0) as usize;
        let mut jds = Vec::with_capacity(n);
        let mut hs = Vec::with_capacity(n);
        if self.mode == NodalMode::Instant {
            for k in 0..n {
                let jd = jd_start + k as f64 * step_days;
                jds.push(jd);
                hs.push(self.eval_instant(jd).0);
            }
            return (jds, hs);
        }
        let mut k = 0usize;
        while k < n {
            let jd = jd_start + k as f64 * step_days;
            let yt = self.year(year_of(jd)).clone();
            let mut stepper = Stepper::new(&yt, jd, step_days);
            let mut run = 0;
            while k < n && run < 256 {
                let jdk = jd_start + k as f64 * step_days;
                if jdk >= yt.jd1 || jdk < yt.jd0 {
                    break;
                }
                jds.push(jdk);
                hs.push(stepper.height());
                stepper.advance();
                k += 1;
                run += 1;
            }
            if run == 0 {
                // Never expected (year_of and jd_year_start agree); keeps the loop finite.
                jds.push(jd);
                hs.push(self.height(jd));
                k += 1;
            }
        }
        (jds, hs)
    }

    /// Every high and low water with its instant in `[jd_start, jd_end]`: sign changes
    /// of the rate on a [`SEARCH_STEP_MIN`] grid, each refined to under 0.1 s by
    /// Newton's method on the rate (bisection when Newton leaves the bracket). The
    /// window's edges never create an extreme.
    pub fn extremes(&mut self, jd_start: f64, jd_end: f64) -> Vec<Extreme> {
        let step = SEARCH_STEP_MIN / 1440.0;
        let mut out = Vec::new();
        if jd_end <= jd_start {
            return out;
        }
        let (times, rates) = self.rate_grid(jd_start, jd_end, step);
        for k in 1..times.len() {
            let (t0, r0, t1, r1) = (times[k - 1], rates[k - 1], times[k], rates[k]);
            let kind = if r0 > 0.0 && r1 <= 0.0 {
                ExtremeKind::High
            } else if r0 < 0.0 && r1 >= 0.0 {
                ExtremeKind::Low
            } else {
                continue;
            };
            let t = self.refine(t0, r0, t1, r1);
            if t >= jd_start && t <= jd_end {
                let height_m = self.eval(t).0;
                out.push(Extreme {
                    kind,
                    jd_utc: t,
                    height_m,
                });
            }
        }
        out
    }

    /// The rate at `jd_start + k·step` up to `jd_end` (always included): phasor stepping
    /// in mid-year mode, re-seeded exactly every 256 steps and at each new year.
    fn rate_grid(&mut self, jd_start: f64, jd_end: f64, step: f64) -> (Vec<f64>, Vec<f64>) {
        let n = ((jd_end - jd_start) / step).floor() as usize;
        let mut times: Vec<f64> = (0..=n).map(|k| jd_start + k as f64 * step).collect();
        if *times.last().expect("n + 1 points") < jd_end {
            times.push(jd_end);
        }
        let mut rates = Vec::with_capacity(times.len());
        if self.mode == NodalMode::Instant {
            for &t in &times {
                rates.push(self.eval_instant(t).1);
            }
            return (times, rates);
        }
        let mut k = 0;
        while k < times.len() {
            let yt = self.year(year_of(times[k])).clone();
            let mut stepper = Stepper::new(&yt, times[k], step);
            let mut run = 0;
            while k < times.len() && run < 256 {
                let t = times[k];
                if t >= yt.jd1 || t < yt.jd0 {
                    break;
                }
                // Points 0..=n are on the lattice; the appended end point is not, and is
                // evaluated exactly.
                rates.push(if k <= n {
                    stepper.rate(&yt.omega)
                } else {
                    yt.eval(t).1
                });
                stepper.advance();
                k += 1;
                run += 1;
            }
            if run == 0 {
                rates.push(self.eval(times[k]).1);
                k += 1;
            }
        }
        (times, rates)
    }

    /// The tide table for `[jd_start, jd_end]`: [`Predictor::extremes`] searched 6 hours
    /// beyond each edge, [`table_rule`] applied, then clipped to the window (so a ripple
    /// straddling an edge is judged whole, as NOAA's own lists judge it).
    pub fn table_extremes(&mut self, jd_start: f64, jd_end: f64) -> Vec<Extreme> {
        let margin = 0.25;
        table_rule(&self.extremes(jd_start - margin, jd_end + margin))
            .into_iter()
            .filter(|e| e.jd_utc >= jd_start && e.jd_utc <= jd_end)
            .collect()
    }

    /// The root of the rate between `a` (rate `ra`) and `b` (rate `rb`), which differ in
    /// sign (or `rb` is zero).
    fn refine(&mut self, mut a: f64, mut ra: f64, mut b: f64, rb: f64) -> f64 {
        if rb == 0.0 {
            return b;
        }
        let tol = 1.0e-6; // days, 0.086 s
        // Start from the secant.
        let mut t = a + (b - a) * ra / (ra - rb);
        for _ in 0..40 {
            let (_, r, acc) = self.eval(t);
            if r == 0.0 {
                return t;
            }
            if (r > 0.0) == (ra > 0.0) {
                a = t;
                ra = r;
            } else {
                b = t;
            }
            // Newton step in days (rate in m/h, acceleration in m/h²).
            let newton = if acc != 0.0 {
                t - r / acc / 24.0
            } else {
                f64::NAN
            };
            let next = if newton.is_finite() && newton > a && newton < b {
                newton
            } else {
                0.5 * (a + b)
            };
            if (next - t).abs() < tol || (b - a) < tol {
                return next;
            }
            t = next;
        }
        t
    }
}

/// Phasor stepping for evenly spaced samples inside one year.
struct Stepper {
    re: Vec<f64>,
    im: Vec<f64>,
    rot_re: Vec<f64>,
    rot_im: Vec<f64>,
}

impl Stepper {
    fn new(y: &YearTerms, jd: f64, step_days: f64) -> Stepper {
        let tau = (jd - y.jd0) * 24.0;
        let dt = step_days * 24.0;
        let n = y.amp.len();
        let (mut re, mut im) = (Vec::with_capacity(n), Vec::with_capacity(n));
        let (mut rot_re, mut rot_im) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for k in 0..n {
            let (s, c) = (y.omega[k] * tau + y.phase[k])
                .rem_euclid(2.0 * PI)
                .sin_cos();
            re.push(y.amp[k] * c);
            im.push(y.amp[k] * s);
            let (rs, rc) = (y.omega[k] * dt).rem_euclid(2.0 * PI).sin_cos();
            rot_re.push(rc);
            rot_im.push(rs);
        }
        Stepper {
            re,
            im,
            rot_re,
            rot_im,
        }
    }

    fn height(&self) -> f64 {
        self.re.iter().sum()
    }

    /// −Σ A·ω·sin θ, m/h.
    fn rate(&self, omega: &[f64]) -> f64 {
        -self.im.iter().zip(omega).map(|(i, w)| i * w).sum::<f64>()
    }

    fn advance(&mut self) {
        for k in 0..self.re.len() {
            let (x, y) = (self.re[k], self.im[k]);
            self.re[k] = x * self.rot_re[k] - y * self.rot_im[k];
            self.im[k] = x * self.rot_im[k] + y * self.rot_re[k];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schureman::constituent;

    #[test]
    fn calendar_helpers_round_trip() {
        for year in [1900, 1999, 2000, 2024, 2025, 2026, 2100] {
            let jd0 = jd_year_start(year);
            assert_eq!(year_of(jd0), year);
            assert_eq!(year_of(jd0 - 1e-6), year - 1);
            assert_eq!(year_of(jd0 + 365.0 - 1e-6), year);
        }
        assert_eq!(jd_year_start(2026), 2_461_041.5);
        assert_eq!(jd_year_start(2000), 2_451_544.5);
    }

    /// A pure S2 tide (f = 1, u = 0, V = 2T): high water every 12 h at T = G/2, i.e.
    /// at 00:00 + G/30 hours for G < 180.
    #[test]
    fn a_pure_s2_tide_peaks_where_its_phase_says() {
        let s2 = constituent("S2").unwrap();
        let mut p = Predictor::new(
            vec![Term {
                constituent: s2,
                amplitude_m: 1.0,
                phase_deg: 60.0,
            }],
            NodalMode::MidYear,
        );
        // V = 2T = 2(180° + 15° UT) ≡ 30° UT (mod 360): the peak is where 30·UT = 60, UT 2 h.
        let day = jd_year_start(2026) + 40.0;
        let ex = p.extremes(day, day + 1.0);
        let highs: Vec<_> = ex.iter().filter(|e| e.kind == ExtremeKind::High).collect();
        assert_eq!(highs.len(), 2, "{ex:?}");
        assert!(((highs[0].jd_utc - day) * 24.0 - 2.0).abs() < 1e-4);
        assert!(((highs[1].jd_utc - day) * 24.0 - 14.0).abs() < 1e-4);
        assert!((highs[0].height_m - 1.0).abs() < 1e-9);
        let lows: Vec<_> = ex.iter().filter(|e| e.kind == ExtremeKind::Low).collect();
        assert!(((lows[0].jd_utc - day) * 24.0 - 8.0).abs() < 1e-4);
        assert!((lows[0].height_m + 1.0).abs() < 1e-9);
    }

    /// Stepped samples agree with exact evaluation, across a new year.
    #[test]
    fn stepping_agrees_with_direct_evaluation() {
        let terms: Vec<Term> = ["M2", "S2", "K1", "O1", "M4", "SA", "MF", "L2", "M1"]
            .iter()
            .enumerate()
            .map(|(k, n)| Term {
                constituent: constituent(n).unwrap(),
                amplitude_m: 0.1 + 0.05 * k as f64,
                phase_deg: 37.0 * k as f64,
            })
            .collect();
        let mut p = Predictor::new(terms, NodalMode::MidYear);
        let start = jd_year_start(2027) - 3.0;
        let (jds, hs) = p.sample(start, start + 6.0, 6.0 / 1440.0);
        assert_eq!(jds.len(), 1441);
        // A JD near 2.46e6 resolves 5e-5 s, which moves the fastest terms by ~1e-8 m:
        // that, not the stepping, sets the tolerance.
        for (jd, h) in jds.iter().zip(&hs) {
            let exact = p.height(*jd);
            assert!((exact - h).abs() < 1e-7, "{jd}: {h} vs {exact}");
        }
        // The extremum search's stepped rates, likewise (off-lattice end included).
        let (ts, rs) = p.rate_grid(start, start + 6.0 + 1e-3, 6.0 / 1440.0);
        assert_eq!(ts.len(), 1442);
        for (t, r) in ts.iter().zip(&rs) {
            let exact = p.eval(*t).1;
            assert!((exact - r).abs() < 1e-6, "{t}: {r} vs {exact}");
        }
    }

    fn ex(kind: ExtremeKind, minute: f64, height_m: f64) -> Extreme {
        Extreme {
            kind,
            jd_utc: 2_461_000.5 + minute / 1440.0,
            height_m,
        }
    }

    /// NOAA's rule: a high and a low less than 2 h apart and less than 0.1 ft apart are
    /// both dropped, scanning from the earliest; either condition alone keeps them.
    #[test]
    fn the_table_rule_drops_short_shallow_pairs_only() {
        use ExtremeKind::{High, Low};
        let list = [
            ex(Low, 0.0, -0.10),
            ex(High, 400.0, 0.50),
            // A double high: the first high and the dip after it (80 min, 2 cm) are
            // dropped together and the second high stays, even though it is 1 cm lower,
            // as NOAA's lists do (Vaca Key, 2026-02-01).
            ex(Low, 480.0, 0.48),
            ex(High, 540.0, 0.49),
            ex(Low, 900.0, 0.00),
            ex(High, 1000.0, 0.04), // 100 min but 4 cm: kept
            ex(Low, 1130.0, 0.035), // 130 min, 5 mm: kept (2 h or more)
        ];
        let kept = table_rule(&list);
        let minutes: Vec<i64> = kept
            .iter()
            .map(|e| ((e.jd_utc - 2_461_000.5) * 1440.0).round() as i64)
            .collect();
        assert_eq!(minutes, [0, 540, 900, 1000, 1130]);
        // 119.6 min apart rounds to 120 in whole minutes: kept, as NOAA's lists keep it.
        let edge = [ex(High, 10.2, 0.2), ex(Low, 129.8, 0.19)];
        assert_eq!(table_rule(&edge).len(), 2);
        let inside = [ex(High, 10.6, 0.2), ex(Low, 129.4, 0.19)];
        assert!(table_rule(&inside).is_empty());
    }
}
