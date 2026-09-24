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
