//! `StarFrame`: the per-instant frame quantities shared by every star.
//!
//! The explorer evaluates all 58 stars at one instant many times a second, so
//! `StarProvider` builds the bias-precession-nutation matrix and the Earth state once
//! per instant and reuses them. That is only acceptable if it changes nothing: these
//! tests pin the results **bit for bit** to `stars::apparent_radec_of_star`, the
//! unbatched chain (the star's space motion, then `frames::apparent_radec_from_barycentric`).

use skyfix_core::time::{civil_to_jd, jd_tt, jd_ut1};
use skyfix_core::units::norm_360;
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::sidereal::gast_deg;
use skyfix_ephemeris::stars::{StarFrame, StarProvider, apparent_radec_of_star};

fn instants() -> Vec<f64> {
    let mut v = Vec::new();
    // Every 97 days across the coverage window, at an awkward time of day.
    let mut jd = civil_to_jd(1990, 1, 1) + 0.123_456_789;
    while jd < civil_to_jd(2060, 12, 31) {
        v.push(jd);
        jd += 97.0;
    }
    v.push(civil_to_jd(2060, 12, 31) + 0.5);
    v
}

#[test]
fn the_frame_reproduces_the_unbatched_chain_bit_for_bit() {
    for jd_utc in instants() {
        let tt = jd_tt(jd_utc);
        let frame = StarFrame::at(tt);
        for s in catalog::navigational_stars() {
            let direct = apparent_radec_of_star(s, tt);
            let batched = frame.apparent_radec_deg(s);
            assert_eq!(
                (direct.0.to_bits(), direct.1.to_bits()),
                (batched.0.to_bits(), batched.1.to_bits()),
                "{} at jd {jd_utc}: {direct:?} vs {batched:?}",
                s.name
            );
        }
    }
}

#[test]
fn the_provider_is_unchanged_by_the_cache_whatever_the_call_order() {
    let p = StarProvider::new();
    let jds = instants();
    // Interleave instants so the one-entry cache is hit, missed and refilled.
    for (i, &jd_utc) in jds.iter().enumerate() {
        let other = jds[(i * 7 + 3) % jds.len()];
        for s in catalog::navigational_stars() {
            for &t in &[jd_utc, other, jd_utc] {
                let tt = jd_tt(t);
                let want = apparent_radec_of_star(s, tt);
                let got = p.apparent_radec_deg(&s.name, t).unwrap();
                assert_eq!(want, got, "{} at {t}", s.name);
                let dir = p.geocentric(&s.name, t).unwrap();
                let gha = norm_360(gast_deg(jd_ut1(t, 0.0), tt) - want.0);
                assert_eq!(
                    dir.gha_deg.to_bits(),
                    gha.to_bits(),
                    "{} GHA at {t}",
                    s.name
                );
                assert_eq!(dir.dec_deg.to_bits(), want.1.to_bits());
            }
        }
    }
}

#[test]
fn a_provider_with_dut1_does_not_reuse_a_dut1_zero_sidereal_time() {
    let jd = civil_to_jd(2026, 9, 24) + 0.25;
    let zero = StarProvider::new().geocentric("Vega", jd).unwrap();
    let with = StarProvider::with_dut1(0.5).geocentric("Vega", jd).unwrap();
    let again = StarProvider::new().geocentric("Vega", jd).unwrap();
    // 0.5 s of UT1 is 7.52" of GHA.
    let d = norm_360(with.gha_deg - zero.gha_deg) * 3600.0;
    assert!((d - 7.5205).abs() < 0.001, "{d}\"");
    assert_eq!(zero, again);
}

#[test]
fn the_cached_frame_is_the_frame_for_that_instant() {
    let a = jd_tt(civil_to_jd(2001, 2, 3));
    let b = jd_tt(civil_to_jd(2045, 6, 7));
    assert_eq!(StarFrame::cached(a), StarFrame::at(a));
    assert_eq!(StarFrame::cached(b), StarFrame::at(b));
    assert_eq!(StarFrame::cached(a), StarFrame::at(a));
    assert_ne!(StarFrame::at(a), StarFrame::at(b));
}
