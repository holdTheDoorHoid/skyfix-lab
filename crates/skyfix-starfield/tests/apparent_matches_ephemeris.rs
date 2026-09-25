//! The star field uses the same frame and pipeline as `sky_state`'s stars.
//!
//! `apparent_radec_all` is an optimised loop over the whole catalogue; this test holds
//! it to `skyfix_ephemeris::frames::apparent_radec_of_date`, the one-star function the
//! navigational `StarProvider` is built on, for every star at several dates. Any
//! difference beyond floating-point noise means the two pipelines have drifted apart.

use skyfix_core::time::jd_tt;
use skyfix_ephemeris::frames::apparent_radec_of_date;

fn sep_arcsec(ra1_deg: f64, d1_deg: f64, ra2_deg: f64, d2_deg: f64) -> f64 {
    let (a1, b1, a2, b2) = (
        ra1_deg.to_radians(),
        d1_deg.to_radians(),
        ra2_deg.to_radians(),
        d2_deg.to_radians(),
    );
    let u = [b1.cos() * a1.cos(), b1.cos() * a1.sin(), b1.sin()];
    let v = [b2.cos() * a2.cos(), b2.cos() * a2.sin(), b2.sin()];
    let c = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    s.atan2(u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
        .to_degrees()
        * 3600.0
}

#[test]
fn every_star_matches_the_ephemeris_chain_to_microarcseconds() {
    let cat = skyfix_starfield::catalog().unwrap();
    let mut worst = 0.0f64;
    // 1990, 2026 and 2060, plus one date either side of the validated window.
    for jd in [
        2_447_892.5,
        2_461_308.25,
        2_473_459.0,
        2_378_496.5,
        2_524_593.5,
    ] {
        let all = skyfix_starfield::apparent_radec_all(jd).unwrap();
        let t = jd_tt(jd);
        for i in 0..cat.len() {
            let (ra, dec) = apparent_radec_of_date(
                cat.ra_j2000_deg[i],
                cat.dec_j2000_deg[i],
                cat.pm_ra_cosdec_mas_yr[i],
                cat.pm_dec_mas_yr[i],
                cat.parallax_mas[i],
                t,
            );
            let d = sep_arcsec(
                all[2 * i].to_degrees(),
                all[2 * i + 1].to_degrees(),
                ra,
                dec,
            );
            worst = worst.max(d);
        }
    }
    println!("worst difference from frames::apparent_radec_of_date: {worst:.2e}\"");
    assert!(worst < 1e-5, "{worst}\"");
}

#[test]
fn navigational_stars_sit_where_the_ephemeris_puts_them() {
    // Two different catalogues (Bright Star Catalogue here, Hipparcos in
    // skyfix-ephemeris) through the same chain: the difference is the catalogues'.
    let sf = skyfix_starfield::starfield().unwrap();
    let provider = skyfix_ephemeris::stars::StarProvider::new();
    let jd = 2_461_308.0;
    let all = skyfix_starfield::apparent_radec_all(jd).unwrap();
    let mut worst = (0.0f64, "");
    for m in &sf.navigational {
        let (ra, dec) = provider.apparent_radec_deg(m.name, jd).unwrap();
        let d = sep_arcsec(
            all[2 * m.index].to_degrees(),
            all[2 * m.index + 1].to_degrees(),
            ra,
            dec,
        );
        if d > worst.0 {
            worst = (d, m.name);
        }
        // The catalogues' own difference at J2000 plus 26 years of their different
        // proper motions; well inside a drawn star's size.
        assert!(d < 60.0, "{}: {d:.2}\"", m.name);
    }
    println!(
        "worst navigational-star difference: {:.2}\" ({})",
        worst.0, worst.1
    );
}

/// ACCURACY.md section 8: the star field draws the Bright Star Catalogue, whose places
/// and proper motions are older than the Hipparcos ones the navigational provider uses.
/// The documented distances between the two over 1990-2060 are held here: Rigil
/// Kentaurus 9.6" (the provider follows alpha Cen A's orbit since the deeptime agent;
/// it was 8.6" against the straight line), Ankaa 3.8", Dubhe 2.9", every other
/// navigational star under 1.5".
#[test]
fn navigational_stars_stay_within_the_documented_distance_of_the_ephemeris() {
    use skyfix_ephemeris::stars::StarProvider;
    let cat = skyfix_starfield::catalog().unwrap();
    let provider = StarProvider::new();
    let mut worst: std::collections::BTreeMap<&str, f64> = Default::default();
    // 1990.0, J2000, 2026.0 and the last day of 2060: the proper-motion differences
    // are linear in time, so the extremes are at the ends.
    for jd in [2_447_892.5, 2_451_545.0, 2_461_041.5, 2_473_459.4] {
        let all = skyfix_starfield::apparent_radec_all(jd).unwrap();
        for m in skyfix_starfield::navigational().unwrap() {
            let (ra, dec) = provider.apparent_radec_deg(m.name, jd).unwrap();
            let d = sep_arcsec(
                all[2 * m.index].to_degrees(),
                all[2 * m.index + 1].to_degrees(),
                ra,
                dec,
            );
            let w = worst.entry(m.name).or_insert(0.0);
            *w = w.max(d);
        }
    }
    assert_eq!(worst.len(), 58, "{}", cat.len());
    for (name, sep) in &worst {
        let documented = match *name {
            "Rigil Kentaurus" => 9.7,
            "Ankaa" => 3.9,
            "Dubhe" => 3.0,
            _ => 1.5,
        };
        println!("{name:16} {sep:.2}\" (documented {documented}\")");
        assert!(*sep <= documented, "{name}: {sep:.2}\" > {documented}\"");
    }
    // Rigil Kentaurus is the one star whose drawn place leaves CONVENTIONS 13.7's 0.1'.
    assert!(worst["Rigil Kentaurus"] > 6.0);
}
