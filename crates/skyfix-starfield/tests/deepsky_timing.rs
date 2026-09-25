//! The deep-sky calls within their budgets (EXPLORER_API.md, "Deep sky"): `tonight`
//! under 50 ms natively, the others far under it. Asserted in optimised builds only:
//! `cargo test --release -p skyfix-starfield --test deepsky_timing -- --nocapture`.

use std::time::Instant;

use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::topocentric::Site;
use skyfix_starfield::extinction::SkyConditions;
use skyfix_starfield::{dso, search, showers, tonight};

fn fastest<T>(n: usize, mut f: impl FnMut(usize) -> T) -> f64 {
    (0..n)
        .map(|k| {
            let t = Instant::now();
            std::hint::black_box(f(k));
            t.elapsed().as_secs_f64() * 1000.0
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn deep_sky_calls_are_fast() {
    let sky = Sky::new();
    let site = Site::new(39.9526, -75.1652);
    let c = SkyConditions::default().resolve().unwrap();
    let jd = civil_to_jd(2026, 9, 24) + 0.9;
    // Warm up: first use parses the tables and builds the search index.
    tonight::tonight(&sky, &site, jd, &c, None).unwrap();
    search::search(&sky, "vega", Some(&site), Some(jd), None).unwrap();
    let t_tonight = fastest(5, |k| {
        tonight::tonight(&sky, &site, jd + k as f64, &c, None).unwrap()
    });
    let t_list = fastest(20, |k| {
        dso::list(Some(&site), jd + k as f64 / 24.0, &Default::default()).unwrap()
    });
    let t_vis = fastest(5, |k| {
        dso::visibility(&sky, "M31", &site, jd + k as f64, &c).unwrap()
    });
    let t_search = fastest(20, |_| {
        search::search(&sky, "alpha cen", Some(&site), Some(jd), None).unwrap()
    });
    let t_year = fastest(2, |_| showers::year(&sky, 2026, None, &c).unwrap());
    let t_year_site = fastest(1, |_| showers::year(&sky, 2026, Some(&site), &c).unwrap());
    let build = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    println!(
        "tonight {t_tonight:.1} ms, dso_list {t_list:.2} ms, dso_visibility {t_vis:.1} ms, \
         search {t_search:.2} ms, showers(year) {t_year:.1} ms, with a site {t_year_site:.0} ms ({build} build)"
    );
    if !cfg!(debug_assertions) {
        assert!(t_tonight < 50.0, "{t_tonight}");
        assert!(
            t_list < 5.0 && t_search < 5.0 && t_vis < 50.0,
            "{t_list} {t_search} {t_vis}"
        );
    }
}
