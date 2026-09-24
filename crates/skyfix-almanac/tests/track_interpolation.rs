//! How far the interpolated track is from exact evaluation.
//!
//! `sample_bodies` and the event finder evaluate each body exactly at nodes no more
//! than 3 hours apart and interpolate in between (`sky::track`). This test measures the
//! price, black-box: every sample `sample_bodies` returns is compared with an exact
//! `apparent_state` + `topocentric::horizontal` at the same instant. The claim in the
//! module docs is under 0.01"; the assertion is that, for every body class including a
//! Moon-like one.

mod common;

use common::SyntheticSky;
use skyfix_almanac::sky::sample_bodies;
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::body::BodyEphemeris;
use skyfix_ephemeris::topocentric::{Site, horizontal};

/// Great-circle separation of two (lon-like, lat-like) directions, arcseconds.
fn sep_arcsec(a: (f64, f64), b: (f64, f64)) -> f64 {
    let v = |(l, p): (f64, f64)| {
        let (sl, cl) = l.to_radians().sin_cos();
        let (sp, cp) = p.to_radians().sin_cos();
        [cp * cl, cp * sl, sp]
    };
    let (u, w) = (v(a), v(b));
    let cross = [
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
    ];
    let s = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
    let c = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
    s.atan2(c).to_degrees() * 3600.0
}

fn worst_error(
    eph: &dyn BodyEphemeris,
    site: &Site,
    body: &str,
    t0: f64,
    t1: f64,
    step_min: f64,
    stride: usize,
) -> (f64, f64, usize) {
    let s = sample_bodies(eph, site, &[body], t0, t1, step_min).unwrap();
    assert!(s.errors.is_empty(), "{:?}", s.errors);
    let b = &s.bodies[0];
    let (mut worst_geo, mut worst_topo) = (0.0f64, 0.0f64);
    let mut n = 0;
    for i in (0..s.jd_utc.len()).step_by(stride) {
        let st = eph.apparent_state(body, s.jd_utc[i]).unwrap();
        let h = horizontal(&st, site);
        worst_geo = worst_geo.max(sep_arcsec(
            (b.gha_deg[i], b.dec_deg[i]),
            (st.gha_deg, st.dec_deg),
        ));
        worst_topo = worst_topo.max(sep_arcsec(
            (b.az_deg[i], b.alt_deg[i]),
            (h.az_deg, h.alt_deg),
        ));
        assert!(
            (b.alt_apparent_deg[i] - b.alt_deg[i] - (h.alt_apparent_deg - h.alt_deg)).abs() < 1e-6,
            "refraction must be applied to the sample's own altitude"
        );
        n += 1;
    }
    (worst_geo, worst_topo, n)
}

#[test]
fn interpolated_samples_are_within_a_hundredth_of_an_arcsecond_of_exact() {
    let eph = SyntheticSky::new();
    let sites = [
        Site {
            height_m: 10.0,
            ..Site::new(39.9526, -75.1652)
        },
        Site::new(-33.8688, 151.2093),
        Site::new(69.6496, 18.956),
    ];
    let cases: [(&str, f64, f64, f64, usize); 6] = [
        // body, start, length (days), step (min), exact-check stride
        ("Sun", civil_to_jd(2026, 9, 24), 1.0, 1.0, 7),
        ("Moon", civil_to_jd(2026, 9, 24), 1.0, 1.0, 7),
        ("Moon", civil_to_jd(1999, 3, 2), 3.0, 2.0, 11),
        ("Sirius", civil_to_jd(2044, 1, 15), 1.0, 1.0, 13),
        ("Polaris", civil_to_jd(1993, 6, 30), 2.0, 5.0, 5),
        ("Moon", civil_to_jd(2031, 11, 1), 30.0, 30.0, 17),
    ];
    let mut report = Vec::new();
    for site in &sites {
        for &(body, t0, days, step, stride) in &cases {
            let (geo, topo, n) = worst_error(&eph, site, body, t0, t0 + days, step, stride);
            report.push(format!(
                "{body:8} lat {:+6.1} {days:4} d: geocentric {geo:.5}\", topocentric \
                 {topo:.5}\" over {n} samples",
                site.lat_deg
            ));
            assert!(geo < 0.01, "{body} geocentric {geo}\"");
            assert!(topo < 0.01, "{body} topocentric {topo}\"");
        }
    }
    eprintln!("{}", report.join("\n"));
}

#[test]
fn a_short_request_is_evaluated_exactly() {
    let eph = SyntheticSky::new();
    let site = Site::new(51.4769, -0.0005);
    let t0 = civil_to_jd(2026, 1, 1);
    let s = sample_bodies(&eph, &site, &["Moon", "Vega"], t0, t0 + 0.25, 60.0).unwrap();
    assert_eq!(s.jd_utc.len(), 7);
    for (b, name) in s.bodies.iter().zip(["Moon", "Vega"]) {
        for (i, &t) in s.jd_utc.iter().enumerate() {
            let st = eph.apparent_state(name, t).unwrap();
            let h = horizontal(&st, &site);
            assert_eq!(b.alt_deg[i], h.alt_deg, "{name}");
            assert_eq!(b.gha_deg[i], st.gha_deg, "{name}");
        }
    }
}
