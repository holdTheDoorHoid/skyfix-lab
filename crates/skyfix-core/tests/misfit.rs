//! The misfit grid (`skyfix_core::misfit`) against the solver it mirrors.
//!
//! Sights are built from a truth position with `geometry` only (`solver_support`), so a
//! failure here is the misfit module's or the solver's, never the correction chain's. The
//! packaged demos are exercised end to end, through the WASM adapter's own code path, in
//! `crates/skyfix-wasm/src/misfit.rs`.
//!
//! Timing means something only in an optimised build: the 30 ms budget for a 200 x 200
//! grid of 10 sights is asserted there (`cargo test --release -p skyfix-core --test misfit
//! -- --nocapture`); a debug build still runs the loop and prints its time.

mod solver_support;

use skyfix_core::geometry::{Point, angular_distance, destination};
use skyfix_core::misfit::{
    self, DELTA_CHI2_THREE_UNKNOWNS, DELTA_CHI2_TWO_UNKNOWNS, GridBounds, MisfitGrid, MisfitOptions,
};
use skyfix_core::solver::solve;
use skyfix_core::types::{FixResult, LatLon, PositionPrior, RobustOptions, Sight, SolveOptions};
use skyfix_core::units::{nm_to_rad, rad_to_m, rad_to_nm};
use solver_support::{philadelphia, sight_at, unique, with_error};
use std::time::Instant;

fn point(p: LatLon) -> Point {
    Point::from_deg(p.lat_deg, p.lon_deg)
}

fn latlon(p: Point) -> LatLon {
    LatLon {
        lat_deg: p.lat_deg(),
        lon_deg: p.lon_deg(),
    }
}

fn metres(a: LatLon, b: LatLon) -> f64 {
    rad_to_m(angular_distance(point(a), point(b)))
}

fn best(g: &MisfitGrid) -> LatLon {
    LatLon {
        lat_deg: g.min.lat_deg,
        lon_deg: g.min.lon_deg,
    }
}

/// A deterministic "noise" pattern in arcminutes, so tests need no random numbers.
fn wobble(k: usize) -> f64 {
    [
        0.31, -0.52, 0.18, 0.44, -0.27, -0.61, 0.09, 0.38, -0.15, 0.56,
    ][k % 10]
}

/// `n` sights spread round the compass from `truth`, altitudes 25-65 degrees, each off by
/// the wobble times its sigma.
fn spread(truth: Point, n: usize, sigma_arcmin: f64) -> Vec<Sight> {
    (0..n)
        .map(|k| {
            let zn = 17.0 + 360.0 * k as f64 / n as f64;
            let alt = 25.0 + (k * 37 % 41) as f64;
            let s = sight_at(&format!("obs-{k}"), "sim", truth, zn, alt, sigma_arcmin);
            with_error(s, wobble(k) * sigma_arcmin)
        })
        .collect()
}

/// Rows and columns, in cells, from the lowest node to a position (columns measured the
/// short way round, so across the antimeridian too).
fn cells_from_grid_min(g: &MisfitGrid, p: LatLon) -> (f64, f64) {
    let di = (p.lat_deg - g.grid_min.lat_deg) / g.lat_step_deg;
    let mut dlon = (p.lon_deg - g.grid_min.lon_deg).rem_euclid(360.0);
    if dlon > 180.0 {
        dlon -= 360.0;
    }
    (di, dlon / g.lon_step_deg)
}

fn assert_grid_min_next_to(g: &MisfitGrid, p: LatLon, what: &str) {
    let (di, dj) = cells_from_grid_min(g, p);
    assert!(
        di.abs() <= 1.0 && dj.abs() <= 1.0,
        "{what}: the lowest node is ({di:.2}, {dj:.2}) cells from {p:?}"
    );
}

/// Every node at or above the best point (a node can only fit worse than the minimum).
fn assert_nothing_below_the_minimum(g: &MisfitGrid) {
    let floor = g.min.chi2 - 1e-9 * g.min.chi2.max(1.0);
    let lowest = g.chi2.iter().copied().fold(f64::INFINITY, f64::min);
    assert!(
        lowest >= floor,
        "a node at {lowest} is below the minimum {}",
        g.min.chi2
    );
}

/// Nodes on the grid's edge that are inside a level: none, if the frame holds the region.
fn edge_nodes_within(g: &MisfitGrid, chi2: f64) -> usize {
    let (n_lat, n_lon) = (g.n_lat, g.n_lon);
    (0..n_lat)
        .flat_map(|i| (0..n_lon).map(move |j| (i, j)))
        .filter(|&(i, j)| i == 0 || j == 0 || i + 1 == n_lat || j + 1 == n_lon)
        .filter(|&(i, j)| g.chi2[i * n_lon + j] <= chi2)
        .count()
}

#[test]
fn a_200_by_200_grid_of_10_sights_within_30_ms() {
    let sights = spread(philadelphia(), 10, 1.0);
    let options = SolveOptions::default();
    let result = solve(&sights, &options);
    let fix = unique(&result);
    let bounds = misfit::default_bounds(&sights, &result, None)
        .unwrap()
        .bounds;
    // Warm up, then judge the fastest of several runs: other work on a shared machine can
    // only slow a run down. The median is printed too.
    let g = misfit::grid_for_solve(&sights, &options, &result, Some(bounds), 200, 200).unwrap();
    assert_grid_min_next_to(&g, fix.position, "timing grid");
    let mut ms: Vec<f64> = (0..15)
        .map(|_| {
            let t = Instant::now();
            let g =
                misfit::grid_for_solve(&sights, &options, &result, Some(bounds), 200, 200).unwrap();
            std::hint::black_box(&g);
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    let (fastest, median) = (ms[0], ms[ms.len() / 2]);
    println!(
        "misfit grid 200 x 200, 10 sights: fastest {fastest:.2} ms, median {median:.2} ms \
         ({} build)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    if !cfg!(debug_assertions) {
        assert!(fastest <= 30.0, "{fastest} ms");
    }
}

#[test]
fn the_best_point_is_the_solvers_fix_and_the_levels_sit_on_it() {
    let sights = spread(philadelphia(), 6, 1.0);
    let options = SolveOptions::default();
    let result = solve(&sights, &options);
    let fix = unique(&result);
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 101, 101).unwrap();

    assert_grid_min_next_to(&g, fix.position, "six spread sights");
    let off = metres(best(&g), fix.position);
    assert!(off < 0.01, "{off} m");
    assert!((g.min.chi2 - fix.chi2).abs() < 1e-9 * fix.chi2.max(1.0));
    assert!(g.min.inside_grid && g.min.well_determined && g.min.converged);
    assert_eq!(g.min.shared_bias_arcmin, None);
    assert_eq!((g.unknowns, g.dof), (2, 4));
    assert_eq!(g.basins.len(), 1, "one basin: {:?}", g.basins);
    assert_eq!(g.basins[0], g.min);
    for (level, delta) in g.levels.iter().zip(DELTA_CHI2_TWO_UNKNOWNS) {
        assert_eq!(level.delta_chi2, delta);
        assert_eq!(level.chi2, g.min.chi2 + delta);
    }
    assert_eq!(g.levels[1].name, "p95");
    assert_nothing_below_the_minimum(&g);
    assert!(g.grid_min.delta_chi2 >= 0.0);
    // The default frame holds the whole 3-sigma region.
    assert_eq!(edge_nodes_within(&g, g.levels[2].chi2), 0);
    assert!(!g.weighted && !g.bias_profiled && !g.crosses_antimeridian);
    assert!(
        g.sights
            .iter()
            .all(|s| s.weight == 1.0 && (s.sigma_arcmin - 1.0).abs() < 1e-12)
    );
    // One-point evaluation: the arithmetic of a grid node.
    let v = misfit::value_at(&sights, &MisfitOptions::default(), best(&g)).unwrap();
    assert_eq!(v, g.min.chi2);
    let node = LatLon {
        lat_deg: g.lat_deg[7],
        lon_deg: g.lon_deg[11],
    };
    let v = misfit::value_at(&sights, &MisfitOptions::default(), node).unwrap();
    assert_eq!(v, g.chi2[7 * g.n_lon + 11]);
}

#[test]
fn a_grid_across_the_antimeridian_is_one_grid() {
    let truth = Point::from_deg(-12.0, 179.99);
    let sights = spread(truth, 5, 0.8);
    let options = SolveOptions::default();
    let result = solve(&sights, &options);
    let fix = unique(&result);
    let d = misfit::default_bounds(&sights, &result, None).unwrap();
    assert!(
        d.bounds.west_deg < 180.0 && d.bounds.east_deg > 180.0,
        "{:?}",
        d.bounds
    );
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 120, 120).unwrap();
    assert!(g.crosses_antimeridian);
    assert!(g.lon_deg.iter().all(|&l| l > -180.0 && l <= 180.0));
    // Eastward columns: the normalised longitudes jump once, from near +180 to near -180.
    let jumps = g.lon_deg.windows(2).filter(|w| w[1] < w[0]).count();
    assert_eq!(jumps, 1);
    assert_grid_min_next_to(&g, fix.position, "antimeridian");
    assert!(metres(best(&g), fix.position) < 0.01);
    assert!(g.min.inside_grid);
    assert_eq!(edge_nodes_within(&g, g.levels[2].chi2), 0);

    // The same box written three ways is the same grid.
    let (w, e) = (179.5, -179.6);
    let base = GridBounds {
        south_deg: -12.5,
        north_deg: -11.5,
        west_deg: w,
        east_deg: e,
    };
    let a = misfit::grid(&sights, &MisfitOptions::default(), &base, 20, 30).unwrap();
    for other in [
        GridBounds {
            east_deg: e + 360.0,
            ..base
        },
        GridBounds {
            west_deg: w - 360.0,
            ..base
        },
    ] {
        let b = misfit::grid(&sights, &MisfitOptions::default(), &other, 20, 30).unwrap();
        assert_eq!(a.bounds.west_deg, b.bounds.west_deg);
        assert!((a.bounds.east_deg - b.bounds.east_deg).abs() < 1e-9);
        for (x, y) in a.chi2.iter().zip(&b.chi2) {
            assert!((x - y).abs() <= 1e-9 * x.max(1.0), "{x} vs {y}");
        }
    }
    assert!((a.bounds.lon_span_deg() - 0.9).abs() < 1e-9);
}

#[test]
fn a_grid_that_reaches_the_pole_takes_every_longitude() {
    // Two nautical miles from the pole.
    let truth = Point::from_deg(89.9667, 30.0);
    let sights = spread(truth, 5, 1.0);
    let options = SolveOptions::default();
    let result = solve(&sights, &options);
    let fix = unique(&result);
    let d = misfit::default_bounds(&sights, &result, None).unwrap();
    assert_eq!(d.bounds.north_deg, 90.0);
    assert_eq!(d.bounds.lon_span_deg(), 360.0);
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 150, 180).unwrap();
    assert!(!g.crosses_antimeridian);
    assert!(metres(best(&g), fix.position) < 0.01);
    assert!(g.min.inside_grid);
    // The pole row is one point: every node there carries the same misfit.
    let top = &g.chi2[(g.n_lat - 1) * g.n_lon..];
    let range = top.iter().fold(0.0f64, |m, v| m.max((v - top[0]).abs()));
    assert!(
        range <= 1e-9 * top[0].max(1.0),
        "the pole row varies by {range}"
    );
    // The lowest node is next to the fix in latitude; in longitude the cells there are
    // only hundreds of metres wide, so it is judged by distance.
    let di = (fix.position.lat_deg - g.grid_min.lat_deg) / g.lat_step_deg;
    assert!(di.abs() <= 1.0, "{di} rows");
    let node = LatLon {
        lat_deg: g.grid_min.lat_deg,
        lon_deg: g.grid_min.lon_deg,
    };
    let cell_m = rad_to_m(g.lat_step_deg.to_radians());
    assert!(metres(node, fix.position) <= 1.5 * cell_m);
    // A polar cap's only real edge is its southern row (the top row is the pole and the
    // first and last columns are the same meridian): the 3-sigma region stays off it.
    let south_row = &g.chi2[..g.n_lon];
    assert!(south_row.iter().all(|&v| v > g.levels[2].chi2));
}

#[test]
fn a_shared_bias_is_profiled_out_at_every_point() {
    // Three lopsided azimuths, three sights each, every altitude 3' high.
    let truth = philadelphia();
    let sights: Vec<Sight> = (0..9)
        .map(|k| {
            let (zn, alt) = [(45.0, 35.0), (95.0, 50.0), (145.0, 30.0)][k % 3];
            let s = sight_at(&format!("obs-{k}"), "sim", truth, zn + k as f64, alt, 0.3);
            with_error(s, 3.0 + 0.3 * wobble(k))
        })
        .collect();
    let options = SolveOptions {
        estimate_shared_bias: true,
        ..Default::default()
    };
    let result = solve(&sights, &options);
    let fix = unique(&result);
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 101, 101).unwrap();
    assert!(g.bias_profiled);
    assert_eq!((g.unknowns, g.dof), (3, 6));
    let off = metres(best(&g), fix.position);
    assert!(off < 0.05, "{off} m");
    assert_grid_min_next_to(&g, fix.position, "bias estimated");
    let bias = g.min.shared_bias_arcmin.unwrap();
    assert!(
        (bias - fix.shared_bias_arcmin.unwrap()).abs() < 1e-4,
        "{bias}"
    );
    assert!((bias - 3.0).abs() < 0.5, "the bias is found: {bias}");
    for (level, delta) in g.levels.iter().zip(DELTA_CHI2_THREE_UNKNOWNS) {
        assert_eq!(level.delta_chi2, delta);
    }
    assert!(
        g.notes.iter().any(|n| n.contains("three unknowns")),
        "{:?}",
        g.notes
    );
    assert_nothing_below_the_minimum(&g);

    // Without the bias the same sights put the minimum where the plain solver puts it,
    // kilometres away: the bias has been absorbed into the position.
    let plain = solve(&sights, &SolveOptions::default());
    let plain_fix = unique(&plain);
    let p =
        misfit::grid_for_solve(&sights, &SolveOptions::default(), &plain, None, 101, 101).unwrap();
    assert!(metres(best(&p), plain_fix.position) < 0.05);
    assert!(metres(plain_fix.position, fix.position) > 1000.0);
}

#[test]
fn robust_weights_put_the_minimum_on_the_robust_fix() {
    let truth = philadelphia();
    let mut sights = spread(truth, 6, 0.5);
    sights[2] = with_error(sights[2].clone(), 8.0);
    let robust = SolveOptions {
        robust: Some(RobustOptions::default()),
        ..Default::default()
    };
    let result = solve(&sights, &robust);
    let fix = unique(&result);
    let g = misfit::grid_for_solve(&sights, &robust, &result, None, 101, 101).unwrap();
    assert!(g.weighted);
    let off = metres(best(&g), fix.position);
    assert!(off < 0.05, "{off} m");
    let bad = g.sights.iter().find(|s| s.id == "obs-2").unwrap();
    assert!(bad.weight < 0.5, "{}", bad.weight);
    assert!(g.notes.iter().any(|n| n.contains("obs-2")), "{:?}", g.notes);

    // Equal weights: the plain least-squares point, which the bad sight has dragged away.
    let plain = solve(&sights, &SolveOptions::default());
    let plain_fix = unique(&plain);
    let e = misfit::grid(
        &sights,
        &MisfitOptions {
            seeds: vec![plain_fix.position],
            ..Default::default()
        },
        &g.bounds,
        101,
        101,
    )
    .unwrap();
    assert!(metres(best(&e), plain_fix.position) < 0.05);
    assert!(metres(plain_fix.position, fix.position) > 500.0);
}

#[test]
fn a_prior_is_left_out_of_the_map() {
    let truth = philadelphia();
    let sights = spread(truth, 4, 1.0);
    let centre = destination(truth, 0.7, nm_to_rad(6.0));
    let options = SolveOptions {
        prior: Some(PositionPrior {
            center: latlon(centre),
            sigma_nm: 1.0,
        }),
        ..Default::default()
    };
    let result = solve(&sights, &options);
    let fix = unique(&result);
    let without = fix.prior.as_ref().unwrap().fix_without_prior.unwrap();
    assert!(
        metres(fix.position, without) > 1000.0,
        "the prior must pull"
    );
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 101, 101).unwrap();
    let off = metres(best(&g), without);
    assert!(off < 0.05, "{off} m");
    assert!(g.notes.iter().any(|n| n.contains("prior")), "{:?}", g.notes);
}

#[test]
fn one_sight_is_a_valley_not_a_basin() {
    let truth = philadelphia();
    let sights = vec![sight_at("obs-1", "sim", truth, 45.0, 45.0, 1.0)];
    let initializer = latlon(destination(truth, 5.0, nm_to_rad(25.0)));
    let options = SolveOptions {
        initializer: Some(initializer),
        ..Default::default()
    };
    let result = solve(&sights, &options);
    assert!(matches!(result, FixResult::Underdetermined { .. }));
    let d = misfit::default_bounds(&sights, &result, options.initializer).unwrap();
    assert_eq!(d.centred_on, "initializer");
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 80, 80).unwrap();
    assert_eq!(g.dof, -1);
    assert!(g.min.chi2 < 1e-12);
    assert!(
        g.basins.iter().all(|b| !b.well_determined),
        "{:?}",
        g.basins
    );
    assert!(
        g.notes.iter().any(|n| n.contains("line, not a point")),
        "{:?}",
        g.notes
    );
    // The circle crosses the frame: nodes within the 95 % level reach its edges.
    assert!(edge_nodes_within(&g, g.levels[1].chi2) >= 2);

    // With no initializer the frame is the whole circle.
    let lone = solve(&sights, &SolveOptions::default());
    let d = misfit::default_bounds(&sights, &lone, None).unwrap();
    assert_eq!(d.centred_on, "circle");
    let s = &sights[0];
    let gp = skyfix_core::geometry::geographic_position(s.gha_rad, s.dec_rad);
    let z = std::f64::consts::FRAC_PI_2 - s.ho_rad;
    for p in skyfix_core::geometry::circle_of_position(gp, z, 72) {
        assert!(d.bounds.contains(latlon(p)), "{p:?} outside {:?}", d.bounds);
    }
}

#[test]
fn two_sights_make_two_basins_both_inside_the_95_percent_level() {
    let truth = philadelphia();
    let sights = vec![
        sight_at("obs-1", "sim", truth, 45.0, 40.0, 1.0),
        sight_at("obs-2", "sim", truth, 135.0, 40.0, 1.0),
    ];
    let options = SolveOptions::default();
    let result = solve(&sights, &options);
    let FixResult::Ambiguous { candidates, .. } = &result else {
        panic!("expected an ambiguous result, got {result:?}");
    };
    let d = misfit::default_bounds(&sights, &result, None).unwrap();
    assert_eq!(d.centred_on, "candidates");
    for c in candidates {
        assert!(
            d.bounds.contains(c.position),
            "{:?} outside {:?}",
            c.position,
            d.bounds
        );
    }
    let g = misfit::grid_for_solve(&sights, &options, &result, None, 200, 200).unwrap();
    let basins: Vec<_> = g
        .basins
        .iter()
        .filter(|b| b.well_determined && b.inside_grid && b.delta_chi2 <= g.levels[1].delta_chi2)
        .collect();
    assert_eq!(basins.len(), 2, "{:?}", g.basins);
    for c in candidates {
        let nearest = basins
            .iter()
            .map(|b| {
                metres(
                    c.position,
                    LatLon {
                        lat_deg: b.lat_deg,
                        lon_deg: b.lon_deg,
                    },
                )
            })
            .fold(f64::INFINITY, f64::min);
        assert!(nearest < 1.0, "{nearest} m from {:?}", c.position);
    }
    assert!(
        g.notes.iter().any(|n| n.contains("2 separate basins")),
        "{:?}",
        g.notes
    );
    let apart = rad_to_nm(angular_distance(
        point(candidates[0].position),
        point(candidates[1].position),
    ));
    assert!(apart > 1000.0, "{apart} NM");
}

#[test]
fn bad_requests_are_explained() {
    let sights = spread(philadelphia(), 4, 1.0);
    let o = MisfitOptions::default();
    let b = GridBounds {
        south_deg: 39.0,
        north_deg: 41.0,
        west_deg: -76.0,
        east_deg: -74.0,
    };
    let e = misfit::grid(&sights, &o, &b, 1, 10).unwrap_err();
    assert!(e.contains("n_lat"), "{e}");
    let e = misfit::grid(&sights, &o, &b, 10, 1025).unwrap_err();
    assert!(e.contains("n_lon"), "{e}");
    let low_north = GridBounds {
        north_deg: 38.0,
        ..b
    };
    let e = misfit::grid(&sights, &o, &low_north, 10, 10).unwrap_err();
    assert!(e.contains("north_deg"), "{e}");
    let e = misfit::grid(&[], &o, &b, 10, 10).unwrap_err();
    assert!(e.contains("no usable sights"), "{e}");
    let mut broken = sights.clone();
    for s in &mut broken {
        s.sigma_rad = 0.0;
    }
    assert!(misfit::grid(&broken, &o, &b, 10, 10).is_err());
    let short = MisfitOptions {
        weights: Some(vec![1.0; 3]),
        ..Default::default()
    };
    let e = misfit::grid(&sights, &short, &b, 10, 10).unwrap_err();
    assert!(e.contains("weights"), "{e}");
    let negative = MisfitOptions {
        weights: Some(vec![1.0, -1.0, 1.0, 1.0]),
        ..Default::default()
    };
    let e = misfit::grid(&sights, &negative, &b, 10, 10).unwrap_err();
    assert!(e.contains("obs-1"), "{e}");
    // A sight the solver would drop is dropped here too, not an error.
    let mut one_bad = sights.clone();
    one_bad[1].ho_rad = f64::NAN;
    let g = misfit::grid(&one_bad, &o, &b, 10, 10).unwrap();
    assert_eq!(g.sights.len(), 3);
    assert!(g.sights.iter().all(|s| s.id != "obs-1"));
}
