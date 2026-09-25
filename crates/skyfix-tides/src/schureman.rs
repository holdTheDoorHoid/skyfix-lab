//! Schureman (1958): astronomical elements, node factors `f`, nodal angles `u` and the
//! equilibrium arguments `V` of NOAA's 37 standard constituents.
//!
//! Source: P. Schureman, *Manual of Harmonic Analysis and Prediction of Tides*, U.S.
//! Coast and Geodetic Survey Special Publication 98, revised 1940, reprinted 1958 (a
//! U.S. Government work, public domain). Formula numbers below are Schureman's:
//!
//! - Table 1: the mean longitudes `s`, `h`, `p`, `N`, `p1` (Newcomb and Brown) as
//!   polynomials in Julian centuries from Greenwich mean noon, 1899 December 31; the
//!   obliquity ω = 23.452° and the inclination of the Moon's orbit i = 5.145°.
//! - page 156: `cos I = cos i cos ω − sin i sin ω cos N`,
//!   `tan ½(N − ξ + ν) = [cos ½(ω − i)/cos ½(ω + i)] tan ½N`,
//!   `tan ½(N − ξ − ν) = [sin ½(ω − i)/sin ½(ω + i)] tan ½N`.
//! - formulas 73 to 78, 149, 195 to 207 (M1), 213 to 215 (L2), 224 and 227 (K1),
//!   232 and 235 (K2) for `f`; Table 2 and Table 2a for `V` and `u`.
//!
//! NOAA's convention (Schureman p. 157, "Table 15"), which its published predictions
//! follow and this crate reproduces: `V0` is taken at 0 h GMT on January 1 of the year,
//! `f` and `u` at the middle of the same year (Greenwich noon on July 2 in common years,
//! the preceding midnight in leap years), and within the year the argument advances at
//! the constituent's constant speed.

use std::f64::consts::PI;

const DEG: f64 = PI / 180.0;

/// JD of Schureman's epoch, Greenwich mean noon of 1899 December 31.
pub const JD_EPOCH: f64 = 2_415_020.0;

/// Hours in a Julian century.
const HOURS_PER_CENTURY: f64 = 36_525.0 * 24.0;

/// Obliquity of the ecliptic, epoch 1900 (Table 1), radians.
const OMEGA: f64 = 23.452 * DEG;
/// Inclination of the Moon's orbit to the ecliptic (Table 1), radians.
const INCL: f64 = 5.145 * DEG;

/// The astronomical elements of Schureman's Table 1, degrees in `[0, 360)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Elements {
    /// Hour angle of the mean Sun at Greenwich: 180° at every 0 h.
    pub t: f64,
    /// Mean longitude of the Moon.
    pub s: f64,
    /// Mean longitude of the Sun.
    pub h: f64,
    /// Longitude of the lunar perigee.
    pub p: f64,
    /// Longitude of the Moon's ascending node.
    pub n: f64,
    /// Longitude of the solar perigee.
    pub p1: f64,
}

fn norm360(x: f64) -> f64 {
    let r = x.rem_euclid(360.0);
    if r >= 360.0 { 0.0 } else { r }
}

/// Table 1 at the instant `jd` (Greenwich mean solar time; UTC is used, the difference
/// being under a second).
pub fn elements(jd: f64) -> Elements {
    const SEC: f64 = 1.0 / 3600.0;
    let c = (jd - JD_EPOCH) / 36_525.0;
    let c2 = c * c;
    let c3 = c2 * c;
    let h = 279.0 + 41.0 / 60.0 + 48.04 * SEC + 129_602_768.13 * SEC * c + 1.089 * SEC * c2;
    let p1 =
        281.0 + 13.0 / 60.0 + 15.0 * SEC + 6_189.03 * SEC * c + 1.63 * SEC * c2 + 0.012 * SEC * c3;
    let s = 270.0
        + 26.0 / 60.0
        + 14.72 * SEC
        + (1336.0 * 360.0 + 1_108_411.20 * SEC) * c
        + 9.09 * SEC * c2
        + 0.0068 * SEC * c3;
    let p = 334.0 + 19.0 / 60.0 + 40.87 * SEC + (11.0 * 360.0 + 392_515.94 * SEC) * c
        - 37.24 * SEC * c2
        - 0.045 * SEC * c3;
    let n = 259.0 + 10.0 / 60.0 + 57.12 * SEC - (5.0 * 360.0 + 482_912.63 * SEC) * c
        + 7.58 * SEC * c2
        + 0.008 * SEC * c3;
    let t = 180.0 + 360.0 * (jd + 0.5).rem_euclid(1.0);
    Elements {
        t: norm360(t),
        s: norm360(s),
        h: norm360(h),
        p: norm360(p),
        n: norm360(n),
        p1: norm360(p1),
    }
}

/// The linear rates of `T`, `s`, `h`, `p`, `p1` in degrees per mean solar hour (the
/// first-order terms of Table 1). `T` advances exactly 15°/h.
pub const RATES_DEG_PER_HOUR: [f64; 5] = [
    15.0,
    (1336.0 * 360.0 + 1_108_411.20 / 3600.0) / HOURS_PER_CENTURY,
    (129_602_768.13 / 3600.0) / HOURS_PER_CENTURY,
    (11.0 * 360.0 + 392_515.94 / 3600.0) / HOURS_PER_CENTURY,
    (6_189.03 / 3600.0) / HOURS_PER_CENTURY,
];

/// The nodal quantities of one instant, radians.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NodeArgs {
    /// Obliquity of the Moon's orbit to the equator.
    pub i: f64,
    /// Right ascension of the lunar intersection.
    pub nu: f64,
    /// Longitude in the Moon's orbit of the lunar intersection.
    pub xi: f64,
    /// ν′ (formula 224), the K1 angle.
    pub nu_p: f64,
    /// 2ν″ (formula 232), the K2 angle.
    pub nu_pp2: f64,
    /// P = p − ξ, the lunar perigee reckoned from the lunar intersection.
    pub big_p: f64,
}

/// `I`, `ν`, `ξ`, `ν′`, `2ν″` and `P` from the longitudes of the node and the perigee.
pub fn node_args(n_deg: f64, p_deg: f64) -> NodeArgs {
    // N reduced to (-180°, 180°] so that ½N and both arctangents stay in one branch.
    let n = {
        let r = n_deg.rem_euclid(360.0);
        if r > 180.0 { r - 360.0 } else { r }
    } * DEG;
    let cos_i = INCL.cos() * OMEGA.cos() - INCL.sin() * OMEGA.sin() * n.cos();
    let i = cos_i.clamp(-1.0, 1.0).acos();
    let t = (n / 2.0).tan();
    let a1 = ((0.5 * (OMEGA - INCL)).cos() / (0.5 * (OMEGA + INCL)).cos() * t).atan();
    let a2 = ((0.5 * (OMEGA - INCL)).sin() / (0.5 * (OMEGA + INCL)).sin() * t).atan();
    // ½(N − ξ + ν) = a1 and ½(N − ξ − ν) = a2.
    let nu = a1 - a2;
    let xi = n - a1 - a2;
    let s2i = (2.0 * i).sin();
    let nu_p = (s2i * nu.sin()).atan2(s2i * nu.cos() + 0.3347);
    let si2 = i.sin() * i.sin();
    let nu_pp2 = (si2 * (2.0 * nu).sin()).atan2(si2 * (2.0 * nu).cos() + 0.0727);
    NodeArgs {
        i,
        nu,
        xi,
        nu_p,
        nu_pp2,
        big_p: p_deg * DEG - xi,
    }
}

/// How an elementary constituent's node factor and nodal angle are formed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeRule {
    /// Solar constituents: f = 1, u = 0.
    Unity,
    /// Formula 73 (Mm): f = (2/3 − sin²I)/0.5021, u = 0.
    Mm,
    /// Formula 74 (Mf): f = sin²I/0.1578, u = −2ξ.
    Mf,
    /// Formula 75 (O1, Q1, 2Q1, ρ1, σ1): f = sin I cos²½I/0.3800, u = 2ξ − ν.
    O1,
    /// Formula 76 (J1, χ1, θ1, MP1, SO1): f = sin 2I/0.7214, u = −ν.
    J1,
    /// Formula 77 (OO1): f = sin I sin²½I/0.0164, u = −2ξ − ν.
    Oo1,
    /// Formula 78 (M2, N2, 2N2, ν2, λ2, μ2): f = cos⁴½I/0.9154, u = 2ξ − 2ν.
    M2,
    /// Formula 227 (K1): f = (0.8965 sin²2I + 0.6001 sin 2I cos ν + 0.1006)^½, u = −ν′.
    K1,
    /// Formula 149 (M3): f = cos⁶½I/0.8758, u = 3ξ − 3ν.
    M3,
    /// Formulas 197, 201, 203, 207 (M1, in the form without the element p in V):
    /// f = f(O1)·(2.310 + 1.435 cos 2P)^½, u = ξ − ν + Q, tan Q = 0.483 tan P.
    M1,
    /// Formulas 212 to 215 (L2): f = f(M2)/Ra, u = 2ξ − 2ν − R.
    L2,
    /// Formulas 232 and 235 (K2): f = (19.0444 sin⁴I + 2.7702 sin²I cos 2ν + 0.0981)^½,
    /// u = −2ν″.
    K2,
}

/// f and u (radians, in `(-π, π]`) for one rule.
pub fn node_factor(rule: NodeRule, a: &NodeArgs) -> (f64, f64) {
    let (f, u) = node_factor_raw(rule, a);
    (f, wrap_pi(u))
}

fn wrap_pi(u: f64) -> f64 {
    let mut u = u.rem_euclid(2.0 * PI);
    if u > PI {
        u -= 2.0 * PI;
    }
    u
}

fn node_factor_raw(rule: NodeRule, a: &NodeArgs) -> (f64, f64) {
    let i = a.i;
    let (si, ci2) = (i.sin(), (i / 2.0).cos());
    let f_m2 = ci2.powi(4) / 0.9154;
    let u_m2 = 2.0 * a.xi - 2.0 * a.nu;
    let f_o1 = si * ci2 * ci2 / 0.3800;
    let u_o1 = 2.0 * a.xi - a.nu;
    let s2i = (2.0 * i).sin();
    match rule {
        NodeRule::Unity => (1.0, 0.0),
        NodeRule::Mm => ((2.0 / 3.0 - si * si) / 0.5021, 0.0),
        NodeRule::Mf => (si * si / 0.1578, -2.0 * a.xi),
        NodeRule::O1 => (f_o1, u_o1),
        NodeRule::J1 => (s2i / 0.7214, -a.nu),
        NodeRule::Oo1 => {
            let s = (i / 2.0).sin();
            (si * s * s / 0.0164, -2.0 * a.xi - a.nu)
        }
        NodeRule::M2 => (f_m2, u_m2),
        NodeRule::K1 => (
            (0.8965 * s2i * s2i + 0.6001 * s2i * a.nu.cos() + 0.1006).sqrt(),
            -a.nu_p,
        ),
        NodeRule::M3 => (ci2.powi(6) / 0.8758, 1.5 * u_m2),
        NodeRule::M1 => {
            let p = a.big_p;
            let inv_qa = (2.310 + 1.435 * (2.0 * p).cos()).sqrt();
            let q = (0.483 * p.sin()).atan2(p.cos());
            (f_o1 * inv_qa, a.xi - a.nu + q)
        }
        NodeRule::L2 => {
            let p = a.big_p;
            let t2 = (i / 2.0).tan().powi(2);
            let inv_ra = (1.0 - 12.0 * t2 * (2.0 * p).cos() + 36.0 * t2 * t2).sqrt();
            let r = (2.0 * p).sin().atan2(1.0 / (6.0 * t2) - (2.0 * p).cos());
            (f_m2 * inv_ra, u_m2 - r)
        }
        NodeRule::K2 => {
            let s2 = si * si;
            let f = (19.0444 * s2 * s2 + 2.7702 * s2 * (2.0 * a.nu).cos() + 0.0981).sqrt();
            (f, -a.nu_pp2)
        }
    }
}

/// What a constituent is made of.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// An elementary term of Schureman's Table 2:
    /// `V = aT·T + as·s + ah·h + ap·p + ap1·p1 + c`, with its node rule.
    Elementary {
        /// Coefficients of T, s, h, p, p1.
        v: [i8; 5],
        /// The coefficients whose rates give the speed: `v`, except for M1.
        speed_v: [i8; 5],
        /// The constant of V, degrees (0, ±90 or 180).
        v_const_deg: f64,
        rule: NodeRule,
    },
    /// A shallow-water or compound constituent (Schureman Table 2a): the sum of
    /// elementary constituents with integer multipliers `n`; `V = Σ n·V`, `u = Σ n·u`,
    /// `f = Π f^|n|`.
    Compound(&'static [(&'static str, i8)]),
}

/// One harmonic constituent as NOAA names it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Constituent {
    /// NOAA's name, as `harcon.json` spells it.
    pub name: &'static str,
    pub kind: Kind,
}

fn parts(c: &Constituent) -> Vec<(&'static Constituent, i8)> {
    match c.kind {
        Kind::Elementary { .. } => Vec::new(),
        Kind::Compound(p) => p
            .iter()
            .map(|&(n, k)| {
                (
                    constituent(n).expect("compound parts are in the table (tested)"),
                    k,
                )
            })
            .collect(),
    }
}

impl Constituent {
    /// Speed in degrees per mean solar hour, from the rates of Table 1.
    pub fn speed_deg_per_hour(&self) -> f64 {
        match self.kind {
            Kind::Elementary { speed_v, .. } => speed_v
                .iter()
                .zip(RATES_DEG_PER_HOUR)
                .map(|(&k, r)| f64::from(k) * r)
                .sum(),
            Kind::Compound(_) => parts(self)
                .iter()
                .map(|(c, n)| f64::from(*n) * c.speed_deg_per_hour())
                .sum(),
        }
    }

    /// V at an instant, degrees in `[0, 360)`.
    pub fn v_deg(&self, e: &Elements) -> f64 {
        match self.kind {
            Kind::Elementary { v, v_const_deg, .. } => {
                let x = [e.t, e.s, e.h, e.p, e.p1];
                norm360(v.iter().zip(x).map(|(&k, a)| f64::from(k) * a).sum::<f64>() + v_const_deg)
            }
            Kind::Compound(_) => norm360(
                parts(self)
                    .iter()
                    .map(|(c, n)| f64::from(*n) * c.v_deg(e))
                    .sum(),
            ),
        }
    }

    /// f and u (radians, in `(-π, π]`).
    pub fn node(&self, a: &NodeArgs) -> (f64, f64) {
        match self.kind {
            Kind::Elementary { rule, .. } => node_factor(rule, a),
            Kind::Compound(_) => {
                let (mut f, mut u) = (1.0, 0.0);
                for (c, n) in parts(self) {
                    let (fc, uc) = c.node(a);
                    f *= fc.powi(i32::from(n.unsigned_abs()));
                    u += f64::from(n) * uc;
                }
                (f, wrap_pi(u))
            }
        }
    }
}

const fn el(name: &'static str, v: [i8; 5], v_const_deg: f64, rule: NodeRule) -> Constituent {
    Constituent {
        name,
        kind: Kind::Elementary {
            v,
            speed_v: v,
            v_const_deg,
            rule,
        },
    }
}

const fn cp(name: &'static str, parts: &'static [(&'static str, i8)]) -> Constituent {
    Constituent {
        name,
        kind: Kind::Compound(parts),
    }
}

/// How many of [`CONSTITUENTS`] are NOAA's standard set (`harcon.json` numbers 1-37).
pub const NOAA_STANDARD: usize = 37;

/// NOAA's 37 standard constituents in NOAA's own numbering, then the 83 further ones of
/// NOAA's extended set (so far published only for Anchorage, 9455920), in NOAA's order.
/// Elementary terms from Schureman Table 2 (σ1 is A20, χ1 A27, θ1 A28,
/// TK1 = π1 B15, RP1 = ψ1 B24, KP1 = φ1 B31); compounds as their names say (MP1 =
/// M2 − P1 and SO1 = S2 − O1 rather than A29 and A30), each
/// checked against NOAA's printed speed and NOAA's Anchorage predictions.
pub const CONSTITUENTS: [Constituent; 120] = [
    el("M2", [2, -2, 2, 0, 0], 0.0, NodeRule::M2),
    el("S2", [2, 0, 0, 0, 0], 0.0, NodeRule::Unity),
    el("N2", [2, -3, 2, 1, 0], 0.0, NodeRule::M2),
    el("K1", [1, 0, 1, 0, 0], -90.0, NodeRule::K1),
    cp("M4", &[("M2", 2)]),
    el("O1", [1, -2, 1, 0, 0], 90.0, NodeRule::O1),
    cp("M6", &[("M2", 3)]),
    cp("MK3", &[("M2", 1), ("K1", 1)]),
    cp("S4", &[("S2", 2)]),
    cp("MN4", &[("M2", 1), ("N2", 1)]),
    el("NU2", [2, -3, 4, -1, 0], 0.0, NodeRule::M2),
    cp("S6", &[("S2", 3)]),
    el("MU2", [2, -4, 4, 0, 0], 0.0, NodeRule::M2),
    el("2N2", [2, -4, 2, 2, 0], 0.0, NodeRule::M2),
    el("OO1", [1, 2, 1, 0, 0], -90.0, NodeRule::Oo1),
    el("LAM2", [2, -1, 0, 1, 0], 180.0, NodeRule::M2),
    el("S1", [1, 0, 0, 0, 0], 0.0, NodeRule::Unity),
    // M1 as NOAA predicts it: V0 + u of Schureman's formula 201 (V = T − s + h − 90°,
    // u = ξ − ν + Q, the form his Table 15 prints) advanced at the speed of formula 194,
    // 14.4966939°/h, which includes the perigee's motion (NOAA's published speed). The
    // mixture reproduces NOAA's curves (1.2 cm better at Juneau than either pure form).
    Constituent {
        name: "M1",
        kind: Kind::Elementary {
            v: [1, -1, 1, 0, 0],
            speed_v: [1, -1, 1, 1, 0],
            v_const_deg: -90.0,
            rule: NodeRule::M1,
        },
    },
    el("J1", [1, 1, 1, -1, 0], -90.0, NodeRule::J1),
    el("MM", [0, 1, 0, -1, 0], 0.0, NodeRule::Mm),
    el("SSA", [0, 0, 2, 0, 0], 0.0, NodeRule::Unity),
    el("SA", [0, 0, 1, 0, 0], 0.0, NodeRule::Unity),
    // MSf as the compound S2 − M2, as NOAA's tables use it (Schureman Table 14 footnote;
    // Table 15 prints MSf's V0 + u equal to 2SM2's), not Table 2's lunar term A5.
    cp("MSF", &[("S2", 1), ("M2", -1)]),
    el("MF", [0, 2, 0, 0, 0], 0.0, NodeRule::Mf),
    el("RHO", [1, -3, 3, -1, 0], 90.0, NodeRule::O1),
    el("Q1", [1, -3, 1, 1, 0], 90.0, NodeRule::O1),
    el("T2", [2, 0, -1, 0, 1], 0.0, NodeRule::Unity),
    el("R2", [2, 0, 1, 0, -1], 180.0, NodeRule::Unity),
    el("2Q1", [1, -4, 1, 2, 0], 90.0, NodeRule::O1),
    el("P1", [1, 0, -1, 0, 0], 90.0, NodeRule::Unity),
    cp("2SM2", &[("S2", 2), ("M2", -1)]),
    el("M3", [3, -3, 3, 0, 0], 0.0, NodeRule::M3),
    el("L2", [2, -1, 2, -1, 0], 180.0, NodeRule::L2),
    cp("2MK3", &[("M2", 2), ("K1", -1)]),
    el("K2", [2, 0, 2, 0, 0], 0.0, NodeRule::K2),
    cp("M8", &[("M2", 4)]),
    cp("MS4", &[("M2", 1), ("S2", 1)]),
    // NOAA's extended set, numbers 38-120.
    el("SIGMA1", [1, -4, 3, 0, 0], 90.0, NodeRule::O1),
    // MP1 as the compound M2 − P1 (same V as Schureman A29, but u and f of M2): it
    // reproduces NOAA's Anchorage curve 0.4 cm (rms) better than A29.
    cp("MP1", &[("M2", 1), ("P1", -1)]),
    el("CHI1", [1, -1, 3, -1, 0], -90.0, NodeRule::J1),
    cp("2PO1", &[("P1", 2), ("O1", -1)]),
    // SO1 as the compound S2 − O1 (same V as Schureman A30), like MP1.
    cp("SO1", &[("S2", 1), ("O1", -1)]),
    cp("MSN2", &[("M2", 1), ("S2", 1), ("N2", -1)]),
    cp("MNS2", &[("M2", 1), ("N2", 1), ("S2", -1)]),
    cp("OP2", &[("O1", 1), ("P1", 1)]),
    cp("MKS2", &[("M2", 1), ("K2", 1), ("S2", -1)]),
    cp("2NS2", &[("N2", 2), ("S2", -1)]),
    cp("MLN2S2", &[("M2", 1), ("L2", 1), ("N2", 1), ("S2", -2)]),
    cp("2ML2S2", &[("M2", 2), ("L2", 1), ("S2", -2)]),
    cp("SKM2", &[("S2", 1), ("K2", 1), ("M2", -1)]),
    cp("2MS2K2", &[("M2", 2), ("S2", 1), ("K2", -2)]),
    cp("MKL2S2", &[("M2", 1), ("K2", 1), ("L2", 1), ("S2", -2)]),
    cp("M2KS2", &[("M2", 1), ("K2", 2), ("S2", -2)]),
    cp("2SNMK2", &[("S2", 2), ("N2", 1), ("M2", -1), ("K2", -1)]),
    cp("2KMSN2", &[("K2", 2), ("M2", 1), ("S2", -1), ("N2", -1)]),
    cp("SO3", &[("S2", 1), ("O1", 1)]),
    cp("SK3", &[("S2", 1), ("K1", 1)]),
    cp("NO3", &[("N2", 1), ("O1", 1)]),
    cp("MK4", &[("M2", 1), ("K2", 1)]),
    cp("SN4", &[("S2", 1), ("N2", 1)]),
    cp("2MLS4", &[("M2", 2), ("L2", 1), ("S2", -1)]),
    cp("3MS4", &[("M2", 3), ("S2", -1)]),
    cp("ML4", &[("M2", 1), ("L2", 1)]),
    cp("N4", &[("N2", 2)]),
    cp("SL4", &[("S2", 1), ("L2", 1)]),
    cp("MNO5", &[("M2", 1), ("N2", 1), ("O1", 1)]),
    cp("2MO5", &[("M2", 2), ("O1", 1)]),
    cp("2MK5", &[("M2", 2), ("K1", 1)]),
    cp("MSK5", &[("M2", 1), ("S2", 1), ("K1", 1)]),
    cp("3KM5", &[("K2", 1), ("K1", 1), ("M2", 1)]),
    cp("2MP5", &[("M2", 2), ("P1", 1)]),
    cp("3MP5", &[("M2", 3), ("P1", -1)]),
    cp("MNK5", &[("M2", 1), ("N2", 1), ("K1", 1)]),
    cp("2SM6", &[("S2", 2), ("M2", 1)]),
    cp("2MN6", &[("M2", 2), ("N2", 1)]),
    cp("MSN6", &[("M2", 1), ("S2", 1), ("N2", 1)]),
    cp("2MS6", &[("M2", 2), ("S2", 1)]),
    cp("2NMLS6", &[("N2", 2), ("M2", 1), ("L2", 1), ("S2", -1)]),
    cp("2NM6", &[("N2", 2), ("M2", 1)]),
    cp("MSL6", &[("M2", 1), ("S2", 1), ("L2", 1)]),
    cp("2ML6", &[("M2", 2), ("L2", 1)]),
    cp("MSK6", &[("M2", 1), ("S2", 1), ("K2", 1)]),
    cp("2MLNS6", &[("M2", 2), ("L2", 1), ("N2", 1), ("S2", -1)]),
    cp("3MLS6", &[("M2", 3), ("L2", 1), ("S2", -1)]),
    cp("2MK6", &[("M2", 2), ("K2", 1)]),
    cp("2MNO7", &[("M2", 2), ("N2", 1), ("O1", 1)]),
    cp("2NMK7", &[("N2", 2), ("M2", 1), ("K1", 1)]),
    cp("2MSO7", &[("M2", 2), ("S2", 1), ("O1", 1)]),
    cp("MSKO7", &[("M2", 1), ("S2", 1), ("K2", 1), ("O1", 1)]),
    cp("2MSN8", &[("M2", 2), ("S2", 1), ("N2", 1)]),
    cp("3MS8", &[("M2", 3), ("S2", 1)]),
    cp("2MS8", &[("M2", 2), ("S2", 2)]),
    cp("2MN8", &[("M2", 2), ("N2", 2)]),
    cp("3MN8", &[("M2", 3), ("N2", 1)]),
    cp("2MSL8", &[("M2", 2), ("S2", 1), ("L2", 1)]),
    cp("4MLS8", &[("M2", 4), ("L2", 1), ("S2", -1)]),
    cp("3ML8", &[("M2", 3), ("L2", 1)]),
    cp("3MK8", &[("M2", 3), ("K2", 1)]),
    cp("2MSK8", &[("M2", 2), ("S2", 1), ("K2", 1)]),
    cp("2M2NK9", &[("M2", 2), ("N2", 2), ("K1", 1)]),
    cp("3MNK9", &[("M2", 3), ("N2", 1), ("K1", 1)]),
    cp("4MK9", &[("M2", 4), ("K1", 1)]),
    cp("3MSK9", &[("M2", 3), ("S2", 1), ("K1", 1)]),
    cp("4MN10", &[("M2", 4), ("N2", 1)]),
    cp("M10", &[("M2", 5)]),
    cp("3MNS10", &[("M2", 3), ("N2", 1), ("S2", 1)]),
    cp("4MS10", &[("M2", 4), ("S2", 1)]),
    cp("3MSL10", &[("M2", 3), ("S2", 1), ("L2", 1)]),
    cp("3M2S10", &[("M2", 3), ("S2", 2)]),
    cp("4MSK11", &[("M2", 4), ("S2", 1), ("K1", 1)]),
    cp("4MNS12", &[("M2", 4), ("N2", 1), ("S2", 1)]),
    cp("5MS12", &[("M2", 5), ("S2", 1)]),
    cp("4MSL12", &[("M2", 4), ("S2", 1), ("L2", 1)]),
    cp("4M2S12", &[("M2", 4), ("S2", 2)]),
    // TK1, RP1 and KP1 are Schureman's solar diurnal terms π1 (B15), ψ1 (B24) and φ1
    // (B31), with f = 1 and u = 0, not the compounds their names suggest (RP1 as R2 − P1
    // would differ by 180°): the elementary forms reproduce NOAA's Anchorage curve.
    el("TK1", [1, 0, -2, 0, 1], 90.0, NodeRule::Unity),
    el("RP1", [1, 0, 2, 0, -1], -90.0, NodeRule::Unity),
    el("KP1", [1, 0, 3, 0, 0], -90.0, NodeRule::Unity),
    el("THETA1", [1, 1, -1, 1, 0], -90.0, NodeRule::J1),
    cp("KJ2", &[("K1", 1), ("J1", 1)]),
    cp("OO2", &[("O1", 1), ("Q1", 1)]),
];

/// The index in [`CONSTITUENTS`] of the constituent NOAA calls `name` (case-insensitive).
pub fn index_of(name: &str) -> Option<usize> {
    CONSTITUENTS
        .iter()
        .position(|c| c.name.eq_ignore_ascii_case(name.trim()))
}

/// The constituent NOAA calls `name` (case-insensitive).
pub fn constituent(name: &str) -> Option<&'static Constituent> {
    index_of(name).map(|k| &CONSTITUENTS[k])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Schureman Table 6 (page 173): I, ν, ξ, ν′ and 2ν″ for chosen degrees of N,
    /// printed to 0.01°.
    #[test]
    fn node_args_match_schureman_table_6() {
        // N, I, ν, ξ, ν′, 2ν″
        let rows: [[f64; 6]; 6] = [
            [0.0, 28.60, 0.00, 0.00, 0.00, 0.00],
            [10.0, 28.53, 1.87, 1.68, 1.34, 2.83],
            [20.0, 28.34, 3.70, 3.34, 2.64, 5.60],
            [30.0, 28.02, 5.48, 4.94, 3.90, 8.25],
            [40.0, 27.58, 7.15, 6.46, 5.08, 10.69],
            [45.0, 27.32, 7.94, 7.18, 5.63, 11.82],
        ];
        for r in rows {
            let a = node_args(r[0], 0.0);
            let got = [
                a.i / DEG,
                a.nu / DEG,
                a.xi / DEG,
                a.nu_p / DEG,
                a.nu_pp2 / DEG,
            ];
            // Printed to 0.01°, and "taken from the preceding edition ... based upon
            // formulas differing slightly" (Schureman p. 156): 0.011° allowed.
            for (k, (g, want)) in got.iter().zip(&r[1..]).enumerate() {
                assert!(
                    (g - want).abs() <= 0.011,
                    "N = {}: quantity {k} = {g:.4}, Table 6 {want}",
                    r[0]
                );
            }
            // "Negative when N is between 180 and 360": the table is antisymmetric.
            let b = node_args(360.0 - r[0], 0.0);
            assert!((b.nu + a.nu).abs() < 1e-12 && (b.xi + a.xi).abs() < 1e-12);
            assert!((b.i - a.i).abs() < 1e-12);
        }
    }

    /// Speeds printed in Schureman Tables 2 and 2a (degrees per solar hour, 7 decimals).
    #[test]
    fn speeds_match_schureman_tables_2_and_2a() {
        let printed = [
            ("M2", 28.984_104_2),
            ("S2", 30.0),
            ("N2", 28.439_729_5),
            ("K1", 15.041_068_6),
            ("O1", 13.943_035_6),
            ("M1", 14.496_693_9),
            ("J1", 15.585_443_3),
            ("OO1", 16.139_101_7),
            ("Q1", 13.398_660_9),
            ("2Q1", 12.854_286_2),
            ("RHO", 13.471_514_5),
            ("P1", 14.958_931_4),
            ("S1", 15.0),
            ("NU2", 28.512_583_1),
            ("LAM2", 29.455_625_3),
            ("MU2", 27.968_208_4),
            ("2N2", 27.895_354_8),
            ("L2", 29.528_478_9),
            ("T2", 29.958_933_3),
            ("R2", 30.041_066_7),
            ("K2", 30.082_137_3),
            ("M3", 43.476_156_3),
            ("MK3", 44.025_172_9),
            ("2MK3", 42.927_139_8),
            ("M4", 57.968_208_4),
            ("MS4", 58.984_104_2),
            ("MN4", 57.423_833_7),
            ("M6", 86.952_312_7),
            ("M8", 115.936_416_6),
            ("2SM2", 31.015_895_8),
            ("MM", 0.544_374_7),
            ("MF", 1.098_033_1),
            ("MSF", 1.015_895_8),
            ("SA", 0.041_068_6),
            ("SSA", 0.082_137_3),
            ("SIGMA1", 12.927_139_8),
            ("MP1", 14.025_172_9),
            ("CHI1", 14.569_547_6),
            ("THETA1", 15.512_589_7),
            ("SO1", 16.056_964_4),
        ];
        for (name, speed) in printed {
            let got = constituent(name).unwrap().speed_deg_per_hour();
            // 7 printed decimals; M8's speed is eight times rounded rates (2.6e-7).
            assert!(
                (got - speed).abs() < 5e-7,
                "{name}: {got:.8} vs Schureman {speed}"
            );
        }
    }

    #[test]
    fn compounds_are_made_of_elementary_constituents() {
        for c in &CONSTITUENTS {
            if let Kind::Compound(p) = c.kind {
                assert!(!p.is_empty(), "{}", c.name);
                for (n, k) in p {
                    let part = constituent(n).unwrap_or_else(|| panic!("{}: {n}", c.name));
                    assert!(
                        matches!(part.kind, Kind::Elementary { .. }),
                        "{}: {n} is itself a compound",
                        c.name
                    );
                    assert_ne!(*k, 0);
                }
            }
            assert_eq!(index_of(c.name).map(|k| CONSTITUENTS[k].name), Some(c.name));
        }
        // 2MK3 is 2M2 − K1 (Table 2a), not M2 + O1: same speed, different u and f.
        let a = node_args(123.0, 45.0);
        let (f, u) = constituent("2MK3").unwrap().node(&a);
        let (fm2, um2) = node_factor(NodeRule::M2, &a);
        let (fk1, uk1) = node_factor(NodeRule::K1, &a);
        assert!((f - fm2 * fm2 * fk1).abs() < 1e-12);
        assert!((u - wrap_pi(2.0 * um2 - uk1)).abs() < 1e-12);
    }

    #[test]
    fn midnight_hour_angle_is_180_degrees() {
        // 2026-01-01T00:00Z = JD 2461041.5
        let e = elements(2_461_041.5);
        assert!((e.t - 180.0).abs() < 1e-9, "{}", e.t);
        let noon = elements(2_461_042.0);
        assert!(noon.t.abs() < 1e-9 || (noon.t - 360.0).abs() < 1e-9);
    }

    /// Node factors stay within their known ranges over a whole nodal cycle, and the
    /// mean over the cycle of the elementary lunar ones is close to 1 (their
    /// denominators are the means of the obliquity factors).
    #[test]
    fn node_factors_are_sane_over_a_nodal_cycle() {
        for c in CONSTITUENTS.iter().take(NOAA_STANDARD) {
            let mut sum = 0.0;
            let n = 3600;
            for k in 0..n {
                let a = node_args(f64::from(k) * 0.1, f64::from(k) * 0.37);
                let (f, u) = c.node(&a);
                assert!(f > 0.0 && f < 2.5, "{}: f = {f}", c.name);
                // M1's u = ξ − ν + Q carries Q, which follows the perigee all the way
                // round; every other u stays within a few tens of degrees.
                if c.name != "M1" {
                    assert!(u.abs() < 60.0 * DEG, "{}: u = {}", c.name, u / DEG);
                }
                sum += f;
            }
            let mean = sum / f64::from(n);
            // M1's factor is about 1.5 on average: Darwin's omission of √2.307, kept by
            // convention (Schureman paragraphs 125-127). Compounds of several lunar
            // factors average a little away from 1.
            let want = if c.name == "M1" { 1.3..1.7 } else { 0.8..1.25 };
            assert!(want.contains(&mean), "{}: mean f {mean}", c.name);
        }
        // M2 at N = 0 (I largest, 28.60°): f = cos⁴(14.30°)/0.9154 = 0.9632.
        let (f, _) = node_factor(NodeRule::M2, &node_args(0.0, 0.0));
        assert!((f - 0.9632).abs() < 2e-4, "{f}");
    }
}
