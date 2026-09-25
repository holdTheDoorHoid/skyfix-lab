//! The embedded Sun, planet and Moon series, both coverage tiers, decoded once from
//! `../data/series.bin`.
//!
//! OWNER: deeptime agent (expansion programme). Written by
//! `tools/reference/build_series.py`; the payload layout is EXPLORER_API "Series
//! payload (deeptime agent)" and the container is [`crate::pack`].
//!
//! What the file holds, and why (measurements: `docs/ACCURACY.md`, "Historical
//! accuracy"):
//!
//! - **VSOP87A** (Bretagnon & Francou 1988, CDS VI/81): heliocentric rectangular
//!   coordinates of the Earth and the seven planets, dynamical ecliptic and equinox
//!   J2000, argument TT. One Earth serves both the Sun and the planets. Every
//!   `(body, coordinate, power)` group is sorted by amplitude and cut twice, for the
//!   validated tier (1550-2650) and for the labelled tier (-2000..3000); the file stores
//!   the longer cut and the validated count, so [`VsopCoordinate::value`] sums a prefix.
//! - **Corrections to VSOP87A** fitted by this project to JPL DE440 (validated) and
//!   DE441 (labelled): a small linear model per body of the heliocentric longitude,
//!   latitude and relative radius ([`Corrections`]). VSOP87 was fitted to DE200 in
//!   1988; without them Mars, Uranus and Neptune drift 9-10" from DE440 inside
//!   1550-2650 and Saturn 110" from DE441 at 2000 BC.
//! - **ELP/MPP02** (Chapront & Francou 2003) with the constants fitted to DE405 and
//!   additive corrections to the secular parts of W1, W2 and W3 fitted by this project
//!   to DE441 and DE440 ([`ElpModel`]).
//!
//! The encoding is compact for the module's download budget (schema
//! `skyfix.series/2`): each body's VSOP87 frequencies are stored once and referenced by
//! a 16-bit index; amplitudes are f32 below 3e-3 au and phases a 32-bit fraction of a
//! turn, and under 2e-6 au a term takes a 16-bit amplitude (fixed point on its group's
//! scale) and a 16-bit phase; the lunar main-problem amplitudes are f32 below 100, the
//! perturbations f32 pairs or, under 0.05, 16-bit amplitude and phase; the correction
//! coefficients are f32. The generator quantises before it fits the corrections and
//! computes the checkpoints, so both describe exactly these numbers. The checkpoints themselves are not embedded:
//! they are `../data/series_checks.json`, which the tests read ([`self_check`]).
//!
//! Hot path: the decoded set lives in a `OnceLock`; after the first call every
//! evaluation reads plain `Vec`s with no lock and no allocation.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::EphemerisError;
use crate::pack::{Reader, Sections, parse_container};

const SERIES_BIN: &[u8] = include_bytes!("../data/series.bin");
/// The payload schema this build reads (META `schema`).
pub const SERIES_SCHEMA: &str = "skyfix.series/2";

const ARCSEC: f64 = std::f64::consts::PI / 648_000.0;
const TAU: f64 = std::f64::consts::TAU;
/// Days per VSOP87 time unit (a thousand Julian years).
pub const DAYS_PER_TJY: f64 = 365_250.0;

/// VSOP87 body order in the file.
pub const BODY_NAMES: [&str; 8] = [
    "Earth", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune",
];
/// Index of the Earth in [`BODY_NAMES`].
pub const EARTH: usize = 0;

/// VSOP87 time argument: thousands of Julian years of TT from J2000.
pub fn vsop_time(jd_tt: f64) -> f64 {
    (jd_tt - skyfix_core::time::JD_J2000) / DAYS_PER_TJY
}

type Mat3 = [[f64; 3]; 3];

// ---------------------------------------------------------------------------
// VSOP87A
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Group {
    start: usize,
    n_valid: usize,
    n_total: usize,
}

impl Group {
    fn len(&self, full: bool) -> usize {
        if full { self.n_total } else { self.n_valid }
    }
}

/// One coordinate of one body: every stored `[A, B, C]` for `A cos(B + C T)`, and the
/// per-power groups (index = power of T).
#[derive(Debug)]
pub struct VsopCoordinate {
    terms: Vec<[f64; 3]>,
    groups: Vec<Group>,
}

impl VsopCoordinate {
    /// Value at `t` (thousands of Julian years of TT): the validated prefix of every
    /// group, or all stored terms when `full` (the labelled tier).
    pub fn value(&self, t: f64, full: bool) -> f64 {
        let mut total = 0.0;
        for g in self.groups.iter().rev() {
            let mut s = 0.0;
            for term in &self.terms[g.start..g.start + g.len(full)] {
                s += term[0] * (term[1] + term[2] * t).cos();
            }
            total = total * t + s;
        }
        total
    }

    /// Value and derivative per thousand Julian years.
    pub fn value_and_rate(&self, t: f64, full: bool) -> (f64, f64) {
        // X = sum_n t^n S_n(t): Horner for the value (p), for the derivative of the
        // polynomial with S_n held fixed (q), and for sum_n t^n S_n'(t) (r).
        let (mut p, mut q, mut r) = (0.0, 0.0, 0.0);
        for g in self.groups.iter().rev() {
            let (mut s, mut ds) = (0.0, 0.0);
            for term in &self.terms[g.start..g.start + g.len(full)] {
                let (sin, cos) = (term[1] + term[2] * t).sin_cos();
                s += term[0] * cos;
                ds -= term[0] * term[2] * sin;
            }
            q = q * t + p;
            p = p * t + s;
            r = r * t + ds;
        }
        (p, q + r)
    }

    /// Value and rate from the leading `k` terms of the `T^0` and `T^1` groups only:
    /// good to about 1e-3 au, enough to estimate a light-time.
    pub fn leading_value_and_rate(&self, t: f64, k: usize) -> (f64, f64) {
        let (mut p, mut q, mut r) = (0.0, 0.0, 0.0);
        for g in self.groups.iter().take(2).rev() {
            let (mut s, mut ds) = (0.0, 0.0);
            for term in &self.terms[g.start..g.start + g.n_total.min(k)] {
                let (sin, cos) = (term[1] + term[2] * t).sin_cos();
                s += term[0] * cos;
                ds -= term[0] * term[2] * sin;
            }
            q = q * t + p;
            p = p * t + s;
            r = r * t + ds;
        }
        (p, q + r)
    }

    /// Stored terms (all tiers) and the validated count.
    pub fn counts(&self) -> (usize, usize) {
        (
            self.groups.iter().map(|g| g.n_total).sum(),
            self.groups.iter().map(|g| g.n_valid).sum(),
        )
    }
}

/// The three coordinates of one VSOP87A body.
#[derive(Debug)]
pub struct VsopBody {
    pub xyz: [VsopCoordinate; 3],
}

impl VsopBody {
    /// Heliocentric position, au, VSOP87A ecliptic axes, **uncorrected**.
    pub fn position(&self, t: f64, full: bool) -> [f64; 3] {
        [
            self.xyz[0].value(t, full),
            self.xyz[1].value(t, full),
            self.xyz[2].value(t, full),
        ]
    }

    /// Heliocentric position (au) and velocity (au per day), uncorrected.
    pub fn position_velocity(&self, t: f64, full: bool) -> ([f64; 3], [f64; 3]) {
        let (x, dx) = self.xyz[0].value_and_rate(t, full);
        let (y, dy) = self.xyz[1].value_and_rate(t, full);
        let (z, dz) = self.xyz[2].value_and_rate(t, full);
        (
            [x, y, z],
            [dx / DAYS_PER_TJY, dy / DAYS_PER_TJY, dz / DAYS_PER_TJY],
        )
    }

    /// [`VsopCoordinate::leading_value_and_rate`] for all three coordinates, au and au
    /// per day.
    pub fn leading_position_velocity(&self, t: f64, k: usize) -> ([f64; 3], [f64; 3]) {
        let (x, dx) = self.xyz[0].leading_value_and_rate(t, k);
        let (y, dy) = self.xyz[1].leading_value_and_rate(t, k);
        let (z, dz) = self.xyz[2].leading_value_and_rate(t, k);
        (
            [x, y, z],
            [dx / DAYS_PER_TJY, dy / DAYS_PER_TJY, dz / DAYS_PER_TJY],
        )
    }
}

fn read_vsop(bytes: &[u8]) -> Result<Vec<VsopBody>, String> {
    let mut r = Reader::new(bytes, "VSOP section");
    let n = usize::from(r.u8()?);
    if n != BODY_NAMES.len() {
        return Err(format!("VSOP section: {n} bodies, expected 8"));
    }
    let mut bodies: Vec<Option<VsopBody>> = (0..8).map(|_| None).collect();
    for _ in 0..n {
        let idx = usize::from(r.u8()?);
        if idx >= 8 || bodies[idx].is_some() {
            return Err(format!(
                "VSOP section: body index {idx} is wrong or repeated"
            ));
        }
        // The body's frequency dictionary: every record names its C by index.
        let n_freq = usize::from(r.u16()?);
        let mut freq = Vec::with_capacity(n_freq);
        for _ in 0..n_freq {
            freq.push(r.f64()?);
        }
        let mut coords = Vec::with_capacity(3);
        for _ in 0..3 {
            let n_powers = usize::from(r.u8()?);
            if n_powers > 6 {
                return Err(format!("VSOP section: {n_powers} powers of T"));
            }
            let mut terms = Vec::new();
            let mut groups = Vec::with_capacity(n_powers);
            for _ in 0..n_powers {
                let n_total = r.count(6)?;
                let n_valid = r.u32()? as usize;
                let n_wide = r.u32()? as usize;
                let n_fine = r.u32()? as usize;
                let coarse_scale = r.f64()?;
                if n_valid > n_total || n_wide > n_fine || n_fine > n_total {
                    return Err(format!(
                        "VSOP section: {n_valid} of {n_total} validated, {n_wide} wide, \
                         {n_fine} fine"
                    ));
                }
                let start = terms.len();
                for i in 0..n_total {
                    let (a, b) = if i < n_wide {
                        (r.f64()?, r.f64()?)
                    } else if i < n_fine {
                        let a = f64::from(r.f32()?);
                        (a, f64::from(r.u32()?) / 4_294_967_296.0 * TAU)
                    } else {
                        let a = f64::from(r.u16()?) * coarse_scale;
                        (a, f64::from(r.u16()?) / 65_536.0 * TAU)
                    };
                    let k = usize::from(r.u16()?);
                    let c = *freq
                        .get(k)
                        .ok_or_else(|| format!("VSOP section: frequency index {k} of {n_freq}"))?;
                    terms.push([a, b, c]);
                }
                groups.push(Group {
                    start,
                    n_valid,
                    n_total,
                });
            }
            coords.push(VsopCoordinate { terms, groups });
        }
        let [x, y, z]: [VsopCoordinate; 3] = coords
            .try_into()
            .map_err(|_| "VSOP section: three coordinates".to_string())?;
        bodies[idx] = Some(VsopBody { xyz: [x, y, z] });
    }
    r.finish()?;
    bodies
        .into_iter()
        .enumerate()
        .map(|(i, b)| b.ok_or_else(|| format!("VSOP section: no series for {}", BODY_NAMES[i])))
        .collect()
}

// ---------------------------------------------------------------------------
// Corrections to VSOP87A
// ---------------------------------------------------------------------------

/// One fitted correction model: the basis shape and the coefficients of the longitude,
/// latitude and relative-radius corrections (arcseconds, and arcsecond units for
/// `dr / r`).
#[derive(Debug, Clone)]
struct CorrectionFit {
    /// Polynomial degree, time degree on the harmonics, harmonics of the heliocentric
    /// longitude, great-inequality harmonics, their time degree.
    spec: [u8; 5],
    coef: [Vec<f64>; 3],
}

#[derive(Debug, Clone)]
struct BodyCorrection {
    validated: CorrectionFit,
    labelled: CorrectionFit,
}

/// The VSOP87A corrections of every body and how the two fits are blended.
#[derive(Debug, Clone)]
pub struct Corrections {
    lambda_j: [f64; 2],
    lambda_s: [f64; 2],
    validated_jd: [f64; 2],
    blend_days: f64,
    bodies: Vec<BodyCorrection>,
}

fn basis_len(body: usize, spec: [u8; 5]) -> usize {
    let [kp, ko, harm, gih, gik] = spec.map(usize::from);
    let gi = if matches!(BODY_NAMES[body], "Jupiter" | "Saturn") {
        gih * (gik + 1) * 2
    } else {
        0
    };
    kp + 1 + harm * (ko + 1) * 2 + gi
}

impl Corrections {
    /// Weight of the validated fit at `jd_tt`: 1 inside the validated band, 0 beyond
    /// the blend zones, a smoothstep between (the generator's `blend_weight`).
    pub fn validated_weight(&self, jd_tt: f64) -> f64 {
        let [lo, hi] = self.validated_jd;
        let span = self.blend_days;
        let x = if jd_tt < lo {
            (jd_tt - (lo - span)) / span
        } else if jd_tt > hi {
            ((hi + span) - jd_tt) / span
        } else {
            1.0
        };
        let x = x.clamp(0.0, 1.0);
        x * x * (3.0 - 2.0 * x)
    }

    /// `(dlon, dlat, dr/r)` in radians (and radians-units) of one fit.
    fn eval(&self, body: usize, fit: &CorrectionFit, t_mill: f64, lam: f64) -> [f64; 3] {
        let [kp, ko, harm, gih, gik] = fit.spec.map(usize::from);
        let t = t_mill * 10.0;
        let mut acc = [0.0f64; 3];
        let mut col = 0usize;
        let mut push = |x: f64| {
            for (a, c) in acc.iter_mut().zip(fit.coef.iter()) {
                *a += c[col] * x;
            }
            col += 1;
        };
        let mut tk = 1.0;
        for _ in 0..=kp {
            push(tk);
            tk *= t;
        }
        for h in 1..=harm {
            let (sh, ch) = (h as f64 * lam).sin_cos();
            let mut tk = 1.0;
            for _ in 0..=ko {
                push(tk * sh);
                push(tk * ch);
                tk *= t;
            }
        }
        if matches!(BODY_NAMES[body], "Jupiter" | "Saturn") {
            let g = 2.0 * (self.lambda_j[0] + self.lambda_j[1] * t_mill)
                - 5.0 * (self.lambda_s[0] + self.lambda_s[1] * t_mill);
            for m in 1..=gih {
                let (sg, cg) = (m as f64 * g).sin_cos();
                let mut tk = 1.0;
                for _ in 0..=gik {
                    push(tk * sg);
                    push(tk * cg);
                    tk *= t;
                }
            }
        }
        acc.map(|v| v * ARCSEC)
    }

    /// Apply the corrections of `body` to its uncorrected heliocentric position
    /// (au, VSOP87A ecliptic axes) at `jd_tt`.
    pub fn apply(&self, body: usize, jd_tt: f64, xyz: [f64; 3]) -> [f64; 3] {
        let r = (xyz[0] * xyz[0] + xyz[1] * xyz[1] + xyz[2] * xyz[2]).sqrt();
        if r == 0.0 {
            return xyz;
        }
        let lam = xyz[1].atan2(xyz[0]);
        let bet = (xyz[2] / r).clamp(-1.0, 1.0).asin();
        let t_mill = vsop_time(jd_tt);
        let w = self.validated_weight(jd_tt);
        let c = &self.bodies[body];
        let mut d = [0.0f64; 3];
        if w > 0.0 {
            let v = self.eval(body, &c.validated, t_mill, lam);
            for k in 0..3 {
                d[k] += w * v[k];
            }
        }
        if w < 1.0 {
            let l = self.eval(body, &c.labelled, t_mill, lam);
            for k in 0..3 {
                d[k] += (1.0 - w) * l[k];
            }
        }
        let (lam, bet, r) = (lam + d[0], bet + d[1], r * (1.0 + d[2]));
        let (sl, cl) = lam.sin_cos();
        let (sb, cb) = bet.sin_cos();
        [r * cb * cl, r * cb * sl, r * sb]
    }
}

fn read_corrections(bytes: &[u8]) -> Result<Corrections, String> {
    let mut r = Reader::new(bytes, "VCOR section");
    let lambda_j = [r.f64()?, r.f64()?];
    let lambda_s = [r.f64()?, r.f64()?];
    let validated_jd = [r.f64()?, r.f64()?];
    let blend_days = r.f64()?;
    if validated_jd[0] >= validated_jd[1] || !(0.0..=36_525.0).contains(&blend_days) {
        return Err("VCOR section: implausible band or blend".to_string());
    }
    let n = usize::from(r.u8()?);
    if n != 8 {
        return Err(format!("VCOR section: {n} bodies, expected 8"));
    }
    let mut bodies: Vec<Option<BodyCorrection>> = (0..8).map(|_| None).collect();
    for _ in 0..n {
        let idx = usize::from(r.u8()?);
        if idx >= 8 || bodies[idx].is_some() {
            return Err(format!(
                "VCOR section: body index {idx} is wrong or repeated"
            ));
        }
        let mut fits = Vec::with_capacity(2);
        for _ in 0..2 {
            let mut spec = [0u8; 5];
            for s in spec.iter_mut() {
                *s = r.u8()?;
            }
            if spec.iter().any(|&s| s > 8) {
                return Err(format!("VCOR section: implausible basis {spec:?}"));
            }
            let want = basis_len(idx, spec);
            let mut coef: [Vec<f64>; 3] = Default::default();
            for c in coef.iter_mut() {
                let m = usize::from(r.u16()?);
                if m != want {
                    return Err(format!(
                        "VCOR section: {} has {m} coefficients, its basis has {want}",
                        BODY_NAMES[idx]
                    ));
                }
                for _ in 0..m {
                    c.push(f64::from(r.f32()?));
                }
            }
            fits.push(CorrectionFit { spec, coef });
        }
        let labelled = fits.pop().expect("two fits");
        let validated = fits.pop().expect("two fits");
        bodies[idx] = Some(BodyCorrection {
            validated,
            labelled,
        });
    }
    r.finish()?;
    Ok(Corrections {
        lambda_j,
        lambda_s,
        validated_jd,
        blend_days,
        bodies: bodies
            .into_iter()
            .enumerate()
            .map(|(i, b)| b.ok_or_else(|| format!("VCOR section: nothing for {}", BODY_NAMES[i])))
            .collect::<Result<_, _>>()?,
    })
}

// ---------------------------------------------------------------------------
// ELP/MPP02
// ---------------------------------------------------------------------------

/// Largest Delaunay multiplier in the main problem (ELP/MPP02: 10, on D).
const MAX_MAIN_MULTIPLIER: usize = 12;

#[derive(Debug, Clone, Copy)]
struct MainTerm {
    /// Multipliers of D, F, l, l'.
    mult: [i8; 4],
    amp: f64,
}

#[derive(Debug, Clone, Copy)]
struct PertTerm {
    amp: f64,
    /// Argument polynomial, radians and radians per century**k.
    fk: [f64; 5],
}

#[derive(Debug, Clone)]
struct ElpGroup<T> {
    terms: Vec<T>,
    n_valid: usize,
}

impl<T> Default for ElpGroup<T> {
    fn default() -> Self {
        ElpGroup {
            terms: Vec::new(),
            n_valid: 0,
        }
    }
}

impl<T> ElpGroup<T> {
    fn active(&self, full: bool) -> &[T] {
        if full {
            &self.terms
        } else {
            &self.terms[..self.n_valid]
        }
    }
}

/// ELP/MPP02, ready to evaluate.
#[derive(Debug)]
pub struct ElpModel {
    /// Mean longitude W1 (corrected), radians per century**k.
    w1: [f64; 5],
    /// Delaunay arguments D, F, l, l' (corrected), radians per century**k.
    delaunay: [[f64; 4]; 5],
    laskar_p: [f64; 5],
    laskar_q: [f64; 5],
    /// a0(DE405) / a0(ELP), applied to the distance series.
    distance_ratio: f64,
    /// Inertial mean ecliptic and equinox of J2000 -> ICRS (the note's Table 7).
    to_icrs: Mat3,
    main: [ElpGroup<MainTerm>; 3],
    pert: [[ElpGroup<PertTerm>; 4]; 3],
}

/// `(cos k theta, sin k theta)` for `k = 0..=MAX_MAIN_MULTIPLIER`.
fn multiples(theta: f64) -> [(f64, f64); MAX_MAIN_MULTIPLIER + 1] {
    let mut out = [(1.0, 0.0); MAX_MAIN_MULTIPLIER + 1];
    for (k, slot) in out.iter_mut().enumerate().skip(1) {
        let (s, c) = (k as f64 * theta).sin_cos();
        *slot = (c, s);
    }
    out
}

#[inline]
fn expi(table: &[(f64, f64); MAX_MAIN_MULTIPLIER + 1], k: i8) -> (f64, f64) {
    let (c, s) = table[usize::from(k.unsigned_abs())];
    if k < 0 { (c, -s) } else { (c, s) }
}

#[inline]
fn cmul(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

impl ElpModel {
    /// Series sums at `t` (Julian centuries of TDB from J2000): longitude and latitude
    /// in arcseconds, distance in km before the `a0` ratio; and the time derivative of
    /// the main problem's part, per century (the perturbations carry under 1e-4 of the
    /// Moon's velocity and are left out of it, as before).
    pub fn sums(&self, t: f64, full: bool) -> ([f64; 3], [f64; 3]) {
        let mut tables = [[(1.0, 0.0); MAX_MAIN_MULTIPLIER + 1]; 4];
        let mut rates = [0.0f64; 4];
        for i in 0..4 {
            let c = |k: usize| self.delaunay[k][i];
            let theta = (c(0) + t * (c(1) + t * (c(2) + t * (c(3) + t * c(4))))).rem_euclid(TAU);
            tables[i] = multiples(theta);
            rates[i] = c(1) + t * (2.0 * c(2) + t * (3.0 * c(3) + t * 4.0 * c(4)));
        }
        let tp = [1.0, t, t * t, t * t * t];
        let mut sum = [0.0f64; 3];
        let mut der = [0.0f64; 3];
        for coord in 0..3 {
            let (mut s, mut ds) = (0.0f64, 0.0f64);
            for term in self.main[coord].active(full) {
                let k = term.mult;
                let z = cmul(
                    cmul(expi(&tables[0], k[0]), expi(&tables[1], k[1])),
                    cmul(expi(&tables[2], k[2]), expi(&tables[3], k[3])),
                );
                let darg = f64::from(k[0]) * rates[0]
                    + f64::from(k[1]) * rates[1]
                    + f64::from(k[2]) * rates[2]
                    + f64::from(k[3]) * rates[3];
                if coord == 2 {
                    // The distance is a cosine series.
                    s += term.amp * z.0;
                    ds -= term.amp * z.1 * darg;
                } else {
                    s += term.amp * z.1;
                    ds += term.amp * z.0 * darg;
                }
            }
            for (power, group) in self.pert[coord].iter().enumerate() {
                let mut sp = 0.0f64;
                for term in group.active(full) {
                    let f = &term.fk;
                    sp += term.amp * (f[0] + t * (f[1] + t * (f[2] + t * (f[3] + t * f[4])))).sin();
                }
                s += sp * tp[power];
            }
            sum[coord] = s;
            der[coord] = ds;
        }
        (sum, der)
    }

    /// Geocentric position (km) and velocity (km per century) of the Moon in the ICRS,
    /// geometric, at `t` Julian centuries of TDB (TT) from J2000.
    pub fn state_icrs(&self, t: f64, full: bool) -> ([f64; 3], [f64; 3]) {
        let (s, ds) = self.sums(t, full);
        let w = &self.w1;
        let w1 = (w[0] + t * (w[1] + t * (w[2] + t * (w[3] + t * w[4])))).rem_euclid(TAU);
        let dw1 = w[1] + t * (2.0 * w[2] + t * (3.0 * w[3] + t * 4.0 * w[4]));
        let v = s[0] * ARCSEC + w1;
        let dv = ds[0] * ARCSEC + dw1;
        let u = s[1] * ARCSEC;
        let du = ds[1] * ARCSEC;
        let r = s[2] * self.distance_ratio;
        let dr = ds[2] * self.distance_ratio;
        let (sv, cv) = v.sin_cos();
        let (su, cu) = u.sin_cos();
        let x = [r * cu * cv, r * cu * sv, r * su];
        let dx = [
            dr * cu * cv - r * su * du * cv - r * cu * sv * dv,
            dr * cu * sv - r * su * du * sv + r * cu * cv * dv,
            dr * su + r * cu * du,
        ];
        // Laskar's P, Q: inertial mean ecliptic of date -> that of J2000 (EVALUATE).
        // Its own rate (1e-4 rad per century) moves the velocity by 1e-8 of itself.
        let poly = |c: &[f64; 5]| t * (c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * c[4]))));
        let (pw, qw) = (poly(&self.laskar_p), poly(&self.laskar_q));
        let ra = 2.0 * (1.0 - pw * pw - qw * qw).sqrt();
        let pwqw = 2.0 * pw * qw;
        let pw2 = 1.0 - 2.0 * pw * pw;
        let qw2 = 1.0 - 2.0 * qw * qw;
        let (pwr, qwr) = (pw * ra, qw * ra);
        let rot: Mat3 = [
            [pw2, pwqw, pwr],
            [pwqw, qw2, -qwr],
            [-pwr, qwr, pw2 + qw2 - 1.0],
        ];
        let m = mat_mul(&self.to_icrs, &rot);
        (apply(&m, x), apply(&m, dx))
    }

    /// Stored terms and the validated count.
    pub fn counts(&self) -> (usize, usize) {
        let main = self.main.iter().map(|g| (g.terms.len(), g.n_valid));
        let pert = self
            .pert
            .iter()
            .flat_map(|p| p.iter().map(|g| (g.terms.len(), g.n_valid)));
        main.chain(pert)
            .fold((0, 0), |(a, b), (c, d)| (a + c, b + d))
    }

    /// The corrected mean longitude W1, radians per century**k.
    pub fn w1(&self) -> [f64; 5] {
        self.w1
    }
}

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut m = [[0.0; 3]; 3];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    m
}

fn apply(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn read_elp(k_bytes: &[u8], s_bytes: &[u8]) -> Result<ElpModel, String> {
    let mut r = Reader::new(k_bytes, "ELPK section");
    let n = usize::from(r.u16()?);
    if n != 76 {
        return Err(format!("ELPK section: {n} constants, expected 76"));
    }
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        v.push(r.f64()?);
    }
    r.finish()?;
    let take = |from: usize, len: usize| &v[from..from + len];
    let w = take(0, 15);
    let dl = take(15, 20);
    let p = take(35, 16);
    let zeta = take(51, 5);
    let lp = take(56, 5);
    let lq = take(61, 5);
    let distance_ratio = v[66];
    let m = take(67, 9);
    if !(0.99..1.01).contains(&distance_ratio) {
        return Err("ELPK section: implausible distance ratio".to_string());
    }
    let w1: [f64; 5] = w[0..5].try_into().expect("5");
    // delaunay[k][i]: coefficient of t^k of argument i (D, F, l, l').
    let mut delaunay = [[0.0f64; 4]; 5];
    for i in 0..4 {
        for k in 0..5 {
            delaunay[k][i] = dl[i * 5 + k];
        }
    }
    let planet = |i: usize, k: usize| if k < 2 { p[i * 2 + k] } else { 0.0 };
    let to_icrs: Mat3 = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];

    let mut r = Reader::new(s_bytes, "ELPS section");
    let n_groups = usize::from(r.u16()?);
    if n_groups != 15 {
        return Err(format!("ELPS section: {n_groups} groups, expected 15"));
    }
    let mut main: [ElpGroup<MainTerm>; 3] = Default::default();
    let mut pert: [[ElpGroup<PertTerm>; 4]; 3] = Default::default();
    let mut seen = [[false; 5]; 3];
    for _ in 0..n_groups {
        let kind = r.u8()?;
        let coord = usize::from(r.u8()?);
        let power = usize::from(r.u8()?);
        let n_total = r.count(8)?;
        let n_valid = r.u32()? as usize;
        let n_wide = r.u32()? as usize;
        let coarse_scale = r.f64()?;
        if coord > 2
            || kind > 1
            || (kind == 0 && power != 0)
            || power > 3
            || n_valid > n_total
            || n_wide > n_total
        {
            return Err(format!(
                "ELPS section: bad group (kind {kind}, coordinate {coord}, power {power}, \
                 {n_valid} of {n_total}, {n_wide} wide)"
            ));
        }
        let slot = if kind == 0 { 0 } else { power + 1 };
        if seen[coord][slot] {
            return Err("ELPS section: a group appears twice".to_string());
        }
        seen[coord][slot] = true;
        if kind == 0 {
            let g = &mut main[coord];
            g.n_valid = n_valid;
            for i in 0..n_total {
                let mut mult = [0i8; 4];
                for m in mult.iter_mut() {
                    *m = r.i8()?;
                    if usize::from(m.unsigned_abs()) > MAX_MAIN_MULTIPLIER {
                        return Err(format!("ELPS section: multiplier {m} in the main problem"));
                    }
                }
                let amp = if i < n_wide {
                    r.f64()?
                } else {
                    f64::from(r.f32()?)
                };
                g.terms.push(MainTerm { mult, amp });
            }
        } else {
            let g = &mut pert[coord][power];
            g.n_valid = n_valid;
            for i in 0..n_total {
                let mut mult = [0i8; 13];
                for m in mult.iter_mut() {
                    *m = r.i8()?;
                }
                let (amp, pha) = if i < n_wide {
                    let s = f64::from(r.f32()?);
                    let c = f64::from(r.f32()?);
                    let mut pha = c.atan2(s);
                    if pha < 0.0 {
                        pha += TAU;
                    }
                    ((c * c + s * s).sqrt(), pha)
                } else {
                    let amp = f64::from(r.u16()?) * coarse_scale;
                    (amp, f64::from(r.u16()?) / 65_536.0 * TAU)
                };
                // READFILE: the argument polynomial from the Delaunay arguments, the
                // planetary mean longitudes (linear) and zeta.
                let mut fk = [0.0f64; 5];
                for (k, f) in fk.iter_mut().enumerate() {
                    let mut a = if k == 0 { pha } else { 0.0 };
                    for i in 0..4 {
                        a += f64::from(mult[i]) * delaunay[k][i];
                    }
                    for i in 0..8 {
                        a += f64::from(mult[i + 4]) * planet(i, k);
                    }
                    a += f64::from(mult[12]) * zeta[k];
                    *f = a;
                }
                g.terms.push(PertTerm { amp, fk });
            }
        }
    }
    r.finish()?;
    if seen.iter().flatten().any(|s| !s) {
        return Err("ELPS section: a group is missing".to_string());
    }
    Ok(ElpModel {
        w1,
        delaunay,
        laskar_p: lp.try_into().expect("5"),
        laskar_q: lq.try_into().expect("5"),
        distance_ratio,
        to_icrs,
        main,
        pert,
    })
}

// ---------------------------------------------------------------------------
// META and the decoded set
// ---------------------------------------------------------------------------

/// What the generator recorded (a subset of the META section).
#[derive(Debug, Clone, Deserialize)]
pub struct Meta {
    pub schema: String,
    #[serde(default)]
    pub generated_utc: String,
    #[serde(default)]
    pub vsop87a: serde_json::Value,
    #[serde(default)]
    pub elpmpp02: serde_json::Value,
}

/// `../data/series_checks.json`: what the generator computed from the stored numbers,
/// kept out of the shipped bytes.
#[derive(Debug, Clone, Deserialize)]
pub struct Checks {
    pub schema: String,
    /// CRC-32 of the payload the checks were computed for, lower-case hex.
    pub series_crc32: String,
    pub checkpoints: Vec<Checkpoint>,
    #[serde(default)]
    pub measured: serde_json::Value,
}

/// A value the generator computed from the stored numbers, for [`self_check`].
#[derive(Debug, Clone, Deserialize)]
pub struct Checkpoint {
    pub kind: String,
    #[serde(default)]
    pub body: String,
    pub jd_tt: f64,
    pub tier: String,
    #[serde(default)]
    pub xyz_au: Option<[f64; 3]>,
    #[serde(default)]
    pub corrected_xyz_au: Option<[f64; 3]>,
    #[serde(default)]
    pub sums: Option<[f64; 3]>,
}

/// Everything in the series file, decoded.
#[derive(Debug)]
pub struct SeriesSet {
    pub meta: Meta,
    pub vsop: Vec<VsopBody>,
    pub corrections: Corrections,
    pub elp: ElpModel,
    pub crc32: u32,
    pub bytes: usize,
}

impl SeriesSet {
    /// Heliocentric position of VSOP87 body `body`, au, VSOP87A ecliptic axes,
    /// **corrected**, at `jd_tt`; `full` selects the labelled-tier prefix.
    pub fn heliocentric_ecliptic(&self, body: usize, jd_tt: f64, full: bool) -> [f64; 3] {
        let raw = self.vsop[body].position(vsop_time(jd_tt), full);
        self.corrections.apply(body, jd_tt, raw)
    }
}

/// Decode a series payload (the bytes inside the container).
pub fn decode_payload(
    payload: &[u8],
) -> Result<(Meta, Vec<VsopBody>, Corrections, ElpModel), String> {
    let s = Sections::parse(payload)?;
    let meta: Meta =
        serde_json::from_slice(s.require("META")?).map_err(|e| format!("META section: {e}"))?;
    if meta.schema != SERIES_SCHEMA {
        return Err(format!(
            "META section: schema {:?}, this build reads {SERIES_SCHEMA:?}",
            meta.schema
        ));
    }
    let vsop = read_vsop(s.require("VSOP")?)?;
    let corrections = read_corrections(s.require("VCOR")?)?;
    let elp = read_elp(s.require("ELPK")?, s.require("ELPS")?)?;
    Ok((meta, vsop, corrections, elp))
}

/// Decode a whole series file (container plus payload).
pub fn decode(bytes: &[u8]) -> Result<SeriesSet, String> {
    let file = parse_container(bytes)?;
    if file.name != "series" {
        return Err(format!("pack {:?} is not a series file", file.name));
    }
    let (meta, vsop, corrections, elp) = decode_payload(file.payload)?;
    Ok(SeriesSet {
        meta,
        vsop,
        corrections,
        elp,
        crc32: file.crc32,
        bytes: bytes.len(),
    })
}

static SERIES: OnceLock<Result<SeriesSet, String>> = OnceLock::new();

/// The embedded series, decoded on first use.
pub fn series() -> Result<&'static SeriesSet, EphemerisError> {
    SERIES
        .get_or_init(|| decode(SERIES_BIN))
        .as_ref()
        .map_err(|e| EphemerisError::Data(format!("embedded series file is unusable: {e}")))
}

/// Worst deviations of this build's evaluation from the generator's checkpoints.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SelfCheck {
    pub checkpoints: usize,
    /// Uncorrected heliocentric positions, au.
    pub vsop_au: f64,
    /// Corrected heliocentric positions, au.
    pub corrected_au: f64,
    /// ELP series sums, arcseconds (longitude, latitude) or km (distance).
    pub elp_sums: f64,
}

/// Re-evaluate the embedded series at the checkpoints the generator computed from the
/// same stored numbers (`checks_json`, the text of `data/series_checks.json`, which
/// must name this file's checksum). Differences are arithmetic only (summation order,
/// and the rounding of arguments that reach millions of radians far from J2000): about
/// 2e-14 au and 1e-6 arcsec. Anything larger means the file or the decoder is wrong.
pub fn self_check(checks_json: &str) -> Result<SelfCheck, EphemerisError> {
    let s = series()?;
    let checks: Checks = serde_json::from_str(checks_json)
        .map_err(|e| EphemerisError::Data(format!("series checks: {e}")))?;
    if checks.schema != SERIES_SCHEMA || checks.series_crc32 != format!("{:08x}", s.crc32) {
        return Err(EphemerisError::Data(format!(
            "series checks are for {} {}, the embedded file is {SERIES_SCHEMA} {:08x}",
            checks.schema, checks.series_crc32, s.crc32
        )));
    }
    let mut out = SelfCheck::default();
    for c in &checks.checkpoints {
        let full = c.tier == "labelled";
        match c.kind.as_str() {
            "vsop" => {
                let body = BODY_NAMES
                    .iter()
                    .position(|b| *b == c.body)
                    .ok_or_else(|| EphemerisError::Data(format!("checkpoint body {:?}", c.body)))?;
                let raw = s.vsop[body].position(vsop_time(c.jd_tt), full);
                let cor = s.corrections.apply(body, c.jd_tt, raw);
                if let Some(x) = c.xyz_au {
                    out.vsop_au = out.vsop_au.max(dist(raw, x));
                }
                if let Some(x) = c.corrected_xyz_au {
                    out.corrected_au = out.corrected_au.max(dist(cor, x));
                }
            }
            "elp_sums" => {
                let t = (c.jd_tt - skyfix_core::time::JD_J2000) / 36_525.0;
                let (sums, _) = s.elp.sums(t, full);
                if let Some(x) = c.sums {
                    for k in 0..3 {
                        out.elp_sums = out.elp_sums.max((sums[k] - x[k]).abs());
                    }
                }
            }
            other => {
                return Err(EphemerisError::Data(format!(
                    "unknown checkpoint kind {other:?}"
                )));
            }
        }
        out.checkpoints += 1;
    }
    Ok(out)
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The generator's checkpoints: test data, not embedded in the library.
    const CHECKS: &str = include_str!("../data/series_checks.json");

    #[test]
    fn the_embedded_file_decodes_and_matches_its_checkpoints() {
        let s = series().expect("embedded series must decode");
        assert_eq!(s.meta.schema, SERIES_SCHEMA);
        let c = self_check(CHECKS).unwrap();
        assert!(c.checkpoints >= 16, "{c:?}");
        assert!(c.vsop_au < 1e-12, "{c:?}");
        assert!(c.corrected_au < 1e-12, "{c:?}");
        // At 1500 BC the arguments reach 3e6 radians, where one f64 rounding of the
        // argument is 3e-10 rad, 7e-6" on the 22 640" equation of the centre: the
        // generator (numpy, direct polynomials) and this evaluator (reduced angles and
        // their multiples) round differently by that much and no more.
        assert!(c.elp_sums < 1e-5, "{c:?}");
        // Both tiers: the validated prefix is a strict subset.
        for b in &s.vsop {
            for coord in &b.xyz {
                let (stored, valid) = coord.counts();
                assert!(valid <= stored && valid > 0);
            }
        }
        let (stored, valid) = s.elp.counts();
        assert!(valid < stored && valid > 1000, "{valid} of {stored}");
    }

    #[test]
    fn damaged_payloads_are_refused() {
        let file = parse_container(SERIES_BIN).unwrap();
        let payload = file.payload;
        assert!(decode_payload(payload).is_ok());
        // Cut at many places: every cut is an error, never a panic.
        let step = (payload.len() / 97).max(1);
        for n in (0..payload.len()).step_by(step) {
            assert!(decode_payload(&payload[..n]).is_err(), "cut at {n}");
        }
        // Flip bytes inside the numeric sections: either refused or decoded, never a
        // panic (a flipped mantissa bit is still a number; the CRC catches it in a
        // real file).
        for n in (0..payload.len()).step_by(step) {
            let mut p = payload.to_vec();
            p[n] ^= 0x5A;
            let _ = decode_payload(&p);
        }
        // The container's checksum refuses any flipped byte.
        let mut damaged = SERIES_BIN.to_vec();
        let mid = damaged.len() / 2;
        damaged[mid] ^= 1;
        assert!(decode(&damaged).unwrap_err().contains("checksum"));
    }

    #[test]
    fn the_correction_blend_is_one_inside_and_zero_far_out() {
        let s = series().unwrap();
        let c = &s.corrections;
        let [lo, hi] = c.validated_jd;
        assert_eq!(c.validated_weight(lo), 1.0);
        assert_eq!(c.validated_weight(hi), 1.0);
        assert_eq!(c.validated_weight((lo + hi) / 2.0), 1.0);
        assert_eq!(c.validated_weight(lo - c.blend_days), 0.0);
        assert_eq!(c.validated_weight(hi + c.blend_days + 1.0), 0.0);
        let mid = c.validated_weight(lo - c.blend_days / 2.0);
        assert!((mid - 0.5).abs() < 1e-12, "{mid}");
        // Continuous at the band edges to first order (smoothstep).
        let eps = 1.0;
        assert!(1.0 - c.validated_weight(lo - eps) < 1e-6);
    }
}
