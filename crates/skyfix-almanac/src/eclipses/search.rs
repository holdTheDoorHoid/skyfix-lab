//! Where to look: the syzygies near a lunar node, and the bookkeeping numbers
//! (lunation, saros) that identify an eclipse.
//!
//! **Candidates.** Meeus, *Astronomical Algorithms* (2nd ed., 1998), chapter 49 gives
//! the mean new and full moons `JDE = 2451550.09766 + 29.530588861 k + ...` and the
//! mean arguments; chapter 54 turns them into a quick estimate of each eclipse's
//! instant and gamma. That estimate only decides where to look and whether to look:
//! every number the engine reports comes from the ephemeris. It keeps a syzygy when
//! `|sin F| <= 0.36` (Meeus's own test) and, for the Sun, `|gamma| < 1.5433 + u` plus
//! a margin of 0.05, for the Moon a penumbral magnitude above -0.05. Meeus's gamma is
//! good to a few thousandths, so the margins lose nothing; `tests/eclipse_canon.rs`
//! proves it by finding every eclipse of NASA's canon for 1990-2060.
//!
//! **Lunation number**: synodic months since the new moon of 2000 January 6, as NASA
//! numbers them (Brown's lunation number minus 953). A lunar eclipse carries the
//! number of the lunation it falls in.
//!
//! **Saros number.** Eclipses one saros (223 lunations) apart belong to the same
//! series, and van den Bergh's numbering of the series advances by one per inex (358
//! lunations). So `N = 223 i + 358 s + c`: modulo 223 the lunation number fixes the
//! series, and because every series alive in 1990-2060 lies within 111 of the
//! reference, the residue picks it uniquely. References: the total solar eclipse of
//! 2024 April 8 (lunation 300, saros 139) and the total lunar eclipse of 2025 March 14
//! (lunation 311, saros 123), both from NASA's catalogues. The test against the canon
//! checks every eclipse of the window.

use std::f64::consts::PI;

/// Mean synodic month, days (Meeus 49.1).
pub(crate) const SYNODIC_MONTH_D: f64 = 29.530_588_861;
/// The new moon of 2000 January 6 (18:14 TT), JDE: lunation 0.
const LUNATION_ZERO_JDE: f64 = 2_451_550.26;

/// One syzygy worth a closer look.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Candidate {
    /// Meeus's `k`: an integer for a new moon, `n + 0.5` for a full moon.
    pub k: f64,
    /// Estimated instant of greatest eclipse, TT (Meeus 54), good to minutes.
    pub jde: f64,
    /// Meeus's gamma estimate.
    pub gamma: f64,
}

fn deg(x: f64) -> f64 {
    x * PI / 180.0
}

/// Meeus chapters 49 and 54 for one `k`. Returns `None` when there can be no eclipse.
pub(crate) fn candidate(k: f64) -> Option<Candidate> {
    let solar = k.fract().abs() < 0.25;
    let t = k / 1236.85;
    let t2 = t * t;
    let jde = 2_451_550.097_66 + SYNODIC_MONTH_D * k + 0.000_154_37 * t2 - 0.000_000_150 * t2 * t
        + 0.000_000_000_73 * t2 * t2;
    let m = deg(2.5534 + 29.105_356_70 * k - 0.000_001_4 * t2 - 0.000_000_11 * t2 * t);
    let mp = deg(
        201.5643 + 385.816_935_28 * k + 0.010_758_2 * t2 + 0.000_012_38 * t2 * t
            - 0.000_000_058 * t2 * t2,
    );
    let f = deg(
        160.7108 + 390.670_502_84 * k - 0.001_611_8 * t2 - 0.000_002_27 * t2 * t
            + 0.000_000_011 * t2 * t2,
    );
    let om = deg(124.7746 - 1.563_755_88 * k + 0.002_067_2 * t2 + 0.000_002_15 * t2 * t);
    if f.sin().abs() > 0.36 {
        return None;
    }
    let e = 1.0 - 0.002_516 * t - 0.000_007_4 * t2;
    let a1 = deg(299.77 + 0.107_408 * k - 0.009_173 * t2);
    let f1 = f - deg(0.026_65) * om.sin();
    let mut corr = if solar {
        -0.4075 * mp.sin() + 0.1721 * e * m.sin()
    } else {
        -0.4065 * mp.sin() + 0.1727 * e * m.sin()
    };
    corr += 0.0161 * (2.0 * mp).sin() - 0.0097 * (2.0 * f1).sin() + 0.0073 * e * (mp - m).sin()
        - 0.0050 * e * (mp + m).sin()
        - 0.0023 * (mp - 2.0 * f1).sin()
        + 0.0021 * e * (2.0 * m).sin()
        + 0.0012 * (mp + 2.0 * f1).sin()
        + 0.0006 * e * (2.0 * mp + m).sin()
        - 0.0004 * (3.0 * mp).sin()
        - 0.0003 * e * (m + 2.0 * f1).sin()
        + 0.0003 * a1.sin()
        - 0.0002 * e * (m - 2.0 * f1).sin()
        - 0.0002 * e * (2.0 * mp - m).sin()
        - 0.0002 * om.sin();
    let p = 0.2070 * e * m.sin() + 0.0024 * e * (2.0 * m).sin() - 0.0392 * mp.sin()
        + 0.0116 * (2.0 * mp).sin()
        - 0.0073 * e * (mp + m).sin()
        + 0.0067 * e * (mp - m).sin()
        + 0.0118 * (2.0 * f1).sin();
    let q = 5.2207 - 0.0048 * e * m.cos() + 0.0020 * e * (2.0 * m).cos()
        - 0.3299 * mp.cos()
        - 0.0060 * e * (mp + m).cos()
        + 0.0041 * e * (mp - m).cos();
    let w = f1.cos().abs();
    let gamma = (p * f1.cos() + q * f1.sin()) * (1.0 - 0.0048 * w);
    let u = 0.0059 + 0.0046 * e * m.cos() - 0.0182 * mp.cos() + 0.0004 * (2.0 * mp).cos()
        - 0.0005 * (m + mp).cos();
    let possible = if solar {
        gamma.abs() < 1.5433 + u + 0.05
    } else {
        (1.5573 + u - gamma.abs()) / 0.5450 > -0.05
    };
    possible.then_some(Candidate {
        k,
        jde: jde + corr,
        gamma,
    })
}

/// Every candidate syzygy of one kind whose estimated instant is within
/// `[jde_start, jde_end]` (TT; widen by a day to be safe at the edges).
pub(crate) fn candidates(jde_start: f64, jde_end: f64, solar: bool) -> Vec<Candidate> {
    let offset = if solar { 0.0 } else { 0.5 };
    let k0 = ((jde_start - 2_451_550.097_66) / SYNODIC_MONTH_D - offset).floor() - 1.0;
    let k1 = ((jde_end - 2_451_550.097_66) / SYNODIC_MONTH_D - offset).ceil() + 1.0;
    let mut out = Vec::new();
    let mut k = k0;
    while k <= k1 {
        if let Some(c) = candidate(k + offset)
            && c.jde >= jde_start
            && c.jde <= jde_end
        {
            out.push(c);
        }
        k += 1.0;
    }
    out
}

/// NASA's lunation number of an eclipse at `jd_tt`.
pub(crate) fn lunation_number(jd_tt: f64, solar: bool) -> i64 {
    let n = (jd_tt - LUNATION_ZERO_JDE) / SYNODIC_MONTH_D;
    if solar {
        n.round() as i64
    } else {
        n.floor() as i64
    }
}

/// Saros series from the lunation number (module docs).
pub(crate) fn saros_number(lunation: i64, solar: bool) -> i64 {
    // 358 = 135 (mod 223) and 135 * 38 = 5130 = 23 * 223 + 1, so 38 inverts 358.
    let (n_ref, s_ref) = if solar { (300, 139) } else { (311, 123) };
    let ds = (38 * (lunation - n_ref)).rem_euclid(223);
    let ds = if ds > 111 { ds - 223 } else { ds };
    s_ref + ds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_are_close_to_the_canon() {
        // NASA canon: partial solar eclipse of 1993 May 21, greatest 14:20:15 TD
        // (JDE 2449129.09740), gamma 1.1372, lunation -82 (Meeus's k).
        let c = candidate(-82.0).unwrap();
        assert!((c.jde - 2_449_129.097_40).abs() < 0.002, "{}", c.jde);
        assert!((c.gamma - 1.1372).abs() < 0.005, "{}", c.gamma);
        // Total lunar eclipse of 1997 September 16, 18:47:42 TD (JDE 2450708.28313),
        // gamma -0.3768.
        let c = candidate(-28.5).unwrap();
        assert!((c.jde - 2_450_708.283_13).abs() < 0.002, "{}", c.jde);
        assert!((c.gamma + 0.3768).abs() < 0.005, "{}", c.gamma);
        // Two lunations later the Moon is some 60 degrees from its node: no eclipse.
        assert!(candidate(-80.0).is_none());
        assert_eq!(lunation_number(2_449_129.097_40, true), -82);
        assert_eq!(lunation_number(2_450_708.283_13, false), -29);
    }

    #[test]
    fn saros_numbers_of_well_known_eclipses() {
        // NASA catalogues: solar 2024-04-08 (lunation 300, saros 139), 2017-08-21
        // (218, 145), 2023-10-14 (294, 134), 1993-05-21 (-82, 118); lunar 2025-03-14
        // (311, 123), 2019-01-21 (235, 134), 2022-11-08 (282, 136), 1997-09-16 (-29, 137).
        for (n, s) in [(300, 139), (218, 145), (294, 134), (-82, 118)] {
            assert_eq!(saros_number(n, true), s, "solar lunation {n}");
        }
        for (n, s) in [(311, 123), (235, 134), (282, 136), (-29, 137)] {
            assert_eq!(saros_number(n, false), s, "lunar lunation {n}");
        }
    }
}
