//! WASM exports for the residual heat map: the solver's misfit on a lat/lon grid.
//!
//! OWNER: misfit agent. Wire format: docs/EXPLORER_API.md, "Misfit grid"; the TypeScript
//! mirror is the `MisfitEngine` section at the end of web/src/next/engine/types.ts; the
//! computation is `skyfix_core::misfit` (CONVENTIONS sections 8-9).
//!
//! Both exports take the session, `ephemeris_mode` and solve options exactly as `solve`
//! takes them (the session's assumed position and clock uncertainty fill the options the
//! same way), reduce and solve once, and build the map of that solve: its bias model, its
//! final robust weights, its minima. Each has a plain-Rust `*_json` twin returning the
//! result or the error message, so every path is tested natively. Errors throw a string.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use skyfix_core::misfit::{
    self, DefaultBounds, GridBounds, GridNode, MisfitGrid, MisfitLevel, MisfitPoint, MisfitSight,
};
use skyfix_core::reduce::{DirectionSource, SuppliedOnly};
use skyfix_core::types::{FixResult, Sight, SolveOptions};
use skyfix_ephemeris::ProviderSource;

use crate::{apply_session_position, auto_provider, err, to_js};

/// A map is at most this many nodes along either axis.
pub const MAX_AXIS: usize = misfit::MAX_AXIS;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// `misfit_grid` result, natively: the core's grid plus the kind of the solve it maps.
/// In JavaScript `chi2` is a `Float64Array`; everything else is this, as JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MisfitGridOutput {
    #[serde(flatten)]
    pub grid: MisfitGrid,
    /// `unique`, `ambiguous`, `underdetermined` or `failed`: what `solve` returned.
    pub solve_kind: String,
}

/// `misfit_default_bounds` result: the frame `misfit_grid` uses when given no bounds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MisfitDefaultBoundsOutput {
    #[serde(flatten)]
    pub frame: DefaultBounds,
    pub solve_kind: String,
}

/// Every field of [`MisfitGridOutput`] except `chi2`, borrowed, so the values cross into
/// JavaScript once, as a typed array, instead of first as 40 000 JSON numbers.
#[derive(Serialize)]
struct Head<'a> {
    bounds: &'a GridBounds,
    crosses_antimeridian: bool,
    n_lat: usize,
    n_lon: usize,
    lat_step_deg: f64,
    lon_step_deg: f64,
    lat_deg: &'a [f64],
    lon_deg: &'a [f64],
    min: &'a MisfitPoint,
    grid_min: &'a GridNode,
    basins: &'a [MisfitPoint],
    unknowns: usize,
    dof: i64,
    levels: &'a [MisfitLevel],
    bias_profiled: bool,
    weighted: bool,
    sights: &'a [MisfitSight],
    notes: &'a [String],
    solve_kind: &'a str,
}

impl<'a> Head<'a> {
    fn of(o: &'a MisfitGridOutput) -> Self {
        let g = &o.grid;
        Head {
            bounds: &g.bounds,
            crosses_antimeridian: g.crosses_antimeridian,
            n_lat: g.n_lat,
            n_lon: g.n_lon,
            lat_step_deg: g.lat_step_deg,
            lon_step_deg: g.lon_step_deg,
            lat_deg: &g.lat_deg,
            lon_deg: &g.lon_deg,
            min: &g.min,
            grid_min: &g.grid_min,
            basins: &g.basins,
            unknowns: g.unknowns,
            dof: g.dof,
            levels: &g.levels,
            bias_profiled: g.bias_profiled,
            weighted: g.weighted,
            sights: &g.sights,
            notes: &g.notes,
            solve_kind: &o.solve_kind,
        }
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// The misfit (chi-square) of every node of an `n_lat` x `n_lon` grid (2 to 1024 each).
///
/// `options_json` is a `SolveOptions` document (`"{}"` for defaults), as `solve` takes it;
/// `bounds_json` is `{"south_deg", "north_deg", "west_deg", "east_deg"}`, or `""`/`"null"`
/// for the frame `misfit_default_bounds` gives. Returns the grid with `chi2` as a
/// row-major `Float64Array`, south row first.
#[wasm_bindgen]
pub fn misfit_grid(
    session_json: &str,
    ephemeris_mode: &str,
    options_json: &str,
    bounds_json: &str,
    n_lat: u32,
    n_lon: u32,
) -> Result<JsValue, JsValue> {
    let out = misfit_grid_json(
        session_json,
        ephemeris_mode,
        options_json,
        bounds_json,
        n_lat as usize,
        n_lon as usize,
    )
    .map_err(err)?;
    let head = to_js(&Head::of(&out))?;
    let values = js_sys::Float64Array::from(out.grid.chi2.as_slice());
    js_sys::Reflect::set(&head, &JsValue::from_str("chi2"), &values)?;
    Ok(head)
}

/// The frame `misfit_grid` uses when it is given no bounds: centred on the fix, or round
/// every ambiguous candidate, or round the initializer (or the first circle) when there is
/// no point fix; sized from the covariance and the spread of the circles.
#[wasm_bindgen]
pub fn misfit_default_bounds(
    session_json: &str,
    ephemeris_mode: &str,
    options_json: &str,
) -> Result<JsValue, JsValue> {
    to_js(&misfit_default_bounds_json(session_json, ephemeris_mode, options_json).map_err(err)?)
}

// ---------------------------------------------------------------------------
// The same, in plain Rust
// ---------------------------------------------------------------------------

pub fn misfit_grid_json(
    session_json: &str,
    ephemeris_mode: &str,
    options_json: &str,
    bounds_json: &str,
    n_lat: usize,
    n_lon: usize,
) -> Result<MisfitGridOutput, String> {
    // Check the cheap arguments before reducing and solving.
    let bounds = bounds_from(bounds_json)?;
    for (name, n) in [("n_lat", n_lat), ("n_lon", n_lon)] {
        if !(2..=MAX_AXIS).contains(&n) {
            return Err(format!(
                "{name} must be between 2 and {MAX_AXIS} nodes, got {n}"
            ));
        }
    }
    let solved = solved(session_json, ephemeris_mode, options_json)?;
    let mut grid = misfit::grid_for_solve(
        &solved.sights,
        &solved.options,
        &solved.result,
        bounds,
        n_lat,
        n_lon,
    )?;
    grid.notes.extend(solved.notes);
    Ok(MisfitGridOutput {
        grid,
        solve_kind: solve_kind(&solved.result).to_string(),
    })
}

pub fn misfit_default_bounds_json(
    session_json: &str,
    ephemeris_mode: &str,
    options_json: &str,
) -> Result<MisfitDefaultBoundsOutput, String> {
    let solved = solved(session_json, ephemeris_mode, options_json)?;
    let frame = misfit::default_bounds(&solved.sights, &solved.result, solved.options.initializer)?;
    Ok(MisfitDefaultBoundsOutput {
        frame,
        solve_kind: solve_kind(&solved.result).to_string(),
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct Solved {
    sights: Vec<Sight>,
    options: SolveOptions,
    result: FixResult,
    notes: Vec<String>,
}

/// Parse, reduce and solve exactly as the `solve` export does.
fn solved(session_json: &str, ephemeris_mode: &str, options_json: &str) -> Result<Solved, String> {
    let (session, _warnings) =
        skyfix_core::session::parse_session(session_json).map_err(|e| e.to_string())?;
    let trimmed = options_json.trim();
    let mut options: SolveOptions = if trimmed.is_empty() {
        SolveOptions::default()
    } else {
        serde_json::from_str(trimmed).map_err(|e| format!("solve options: {e}"))?
    };
    apply_session_position(&session, &mut options);
    if options.clock_uncertainty_s == 0.0 {
        options.clock_uncertainty_s = session.clock.uncertainty_s;
    }
    let source = source_for(ephemeris_mode)?;
    let (reduced, rejected) =
        skyfix_core::reduce::reduce_session_partitioned(&session, source.as_ref());
    if reduced.is_empty() {
        return Err(if rejected.is_empty() {
            "the session has no observations, so there is no misfit to map".to_string()
        } else {
            format!(
                "every observation was rejected before the solver, so there is no misfit to \
                 map: {}",
                rejected
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        });
    }
    let sights = skyfix_core::reduce::to_sights(&reduced, source.as_ref());
    let result = skyfix_core::solver::solve(&sights, &options);
    let notes = rejected
        .iter()
        .map(|e| format!("{e}. This sight is not in the map."))
        .collect();
    Ok(Solved {
        sights,
        options,
        result,
        notes,
    })
}

/// `""` or `"null"`: the default frame. Otherwise a `GridBounds` document.
fn bounds_from(json: &str) -> Result<Option<GridBounds>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(None);
    }
    let b: GridBounds = serde_json::from_str(trimmed).map_err(|e| format!("bounds: {e}"))?;
    b.normalized().map(Some)
}

/// The direction source for an `ephemeris_mode`, as `lib.rs` defines the modes, with a
/// plain error so the `*_json` functions run natively.
fn source_for(mode: &str) -> Result<Box<dyn DirectionSource>, String> {
    match mode {
        "supplied" => Ok(Box::new(SuppliedOnly)),
        "auto" | "" => Ok(Box::new(ProviderSource(auto_provider()))),
        other => Err(format!(
            "unknown ephemeris_mode {other:?}: expected \"supplied\" or \"auto\""
        )),
    }
}

fn solve_kind(result: &FixResult) -> &'static str {
    match result {
        FixResult::Unique { .. } => "unique",
        FixResult::Ambiguous { .. } => "ambiguous",
        FixResult::Underdetermined { .. } => "underdetermined",
        FixResult::Failed { .. } => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use skyfix_core::geometry::{Point, angular_distance};
    use skyfix_core::types::{LatLon, Session};
    use skyfix_core::units::{CHI2_95_2DOF, rad_to_m};
    use skyfix_sim::scenario::Scenario;

    /// Every packaged demo, as the browser lists them (`demos()` in lib.rs).
    fn packaged() -> Vec<Scenario> {
        let mut all = skyfix_sim::demos::all();
        all.insert(1, skyfix_sim::demos::philadelphia_stars_named());
        all.insert(2, skyfix_sim::demos::philadelphia_stars_sextant());
        all
    }

    fn session_of(scenario: &Scenario) -> String {
        let provider = auto_provider();
        let (session, _truth): (Session, _) =
            skyfix_sim::generate::simulate(scenario, Some(&provider)).unwrap();
        serde_json::to_string(&session).unwrap()
    }

    fn demo(name: &str) -> String {
        let s = packaged().into_iter().find(|s| s.name == name).unwrap();
        session_of(&s)
    }

    fn solved_demo(name: &str, options: &str) -> Solved {
        solved(&demo(name), "auto", options).unwrap()
    }

    fn metres(a: LatLon, b: LatLon) -> f64 {
        rad_to_m(angular_distance(
            Point::from_deg(a.lat_deg, a.lon_deg),
            Point::from_deg(b.lat_deg, b.lon_deg),
        ))
    }

    fn best(g: &MisfitGrid) -> LatLon {
        LatLon {
            lat_deg: g.min.lat_deg,
            lon_deg: g.min.lon_deg,
        }
    }

    /// Rows and columns from the lowest node to `p`.
    fn cells(g: &MisfitGrid, p: LatLon) -> (f64, f64) {
        let di = (p.lat_deg - g.grid_min.lat_deg) / g.lat_step_deg;
        let mut dlon = (p.lon_deg - g.grid_min.lon_deg).rem_euclid(360.0);
        if dlon > 180.0 {
            dlon -= 360.0;
        }
        (di, dlon / g.lon_step_deg)
    }

    /// The shape of the region inside a level: (long axis, short axis) in metres from the
    /// second moments of its nodes about the best point, and the long axis's bearing.
    fn region_shape(g: &MisfitGrid, level: f64) -> (f64, f64, f64) {
        let lat0 = g.min.lat_deg.to_radians();
        let (mut n, mut see, mut snn, mut sen) = (0.0, 0.0, 0.0, 0.0);
        for i in 0..g.n_lat {
            for j in 0..g.n_lon {
                if g.chi2[i * g.n_lon + j] > level {
                    continue;
                }
                let mut dlon = g.lon_deg[j] - g.min.lon_deg;
                dlon = (dlon + 180.0).rem_euclid(360.0) - 180.0;
                let north = (g.lat_deg[i] - g.min.lat_deg) * 60.0 * 1852.0;
                let east = dlon * lat0.cos() * 60.0 * 1852.0;
                n += 1.0;
                see += east * east;
                snn += north * north;
                sen += east * north;
            }
        }
        let (a, b, c) = (snn / n, sen / n, see / n);
        let (values, vectors) = skyfix_core::linalg::eigen_sym2([[a, b], [b, c]]);
        let bearing = vectors[1][0]
            .atan2(vectors[0][0])
            .to_degrees()
            .rem_euclid(180.0);
        (values[0].sqrt(), values[1].max(0.0).sqrt(), bearing)
    }

    #[test]
    fn every_packaged_demo_maps_with_its_minimum_on_the_fix() {
        for scenario in packaged() {
            let name = scenario.name.clone();
            let session = session_of(&scenario);
            let out = misfit_grid_json(&session, "auto", "{}", "", 200, 200)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let g = &out.grid;
            let solved = solved(&session, "auto", "{}").unwrap();
            assert_eq!(out.solve_kind, solve_kind(&solved.result), "{name}");
            assert_eq!(g.chi2.len(), 200 * 200, "{name}");
            assert!(g.chi2.iter().all(|v| v.is_finite()), "{name}");
            match &solved.result {
                FixResult::Unique { fix, .. } => {
                    let (di, dj) = cells(g, fix.position);
                    println!(
                        "{name:28} lowest node ({di:+.2}, {dj:+.2}) cells from the fix, \
                         best point {:.3} m from it, cell {:.0} m x {:.0} m",
                        metres(best(g), fix.position),
                        g.lat_step_deg * 60.0 * 1852.0,
                        g.lon_step_deg * 60.0 * 1852.0 * fix.position.lat_deg.to_radians().cos()
                    );
                    assert!(di.abs() <= 1.0 && dj.abs() <= 1.0, "{name}: ({di}, {dj})");
                    assert!(metres(best(g), fix.position) < 0.05, "{name}");
                    // Off centre and odd-sized, so the fix falls anywhere inside a cell.
                    let b = g.bounds;
                    let (h, w) = (b.north_deg - b.south_deg, b.lon_span_deg());
                    let shifted = json!({
                        "south_deg": b.south_deg + 0.137 * h, "north_deg": b.north_deg + 0.137 * h,
                        "west_deg": b.west_deg - 0.211 * w, "east_deg": b.east_deg - 0.211 * w,
                    });
                    let o =
                        misfit_grid_json(&session, "auto", "{}", &shifted.to_string(), 173, 191)
                            .unwrap();
                    let (di, dj) = cells(&o.grid, fix.position);
                    assert!(
                        di.abs() <= 1.0 && dj.abs() <= 1.0,
                        "{name} shifted: ({di}, {dj})"
                    );
                    assert!(metres(best(&o.grid), fix.position) < 0.05, "{name} shifted");
                    assert!(
                        (g.min.chi2 - fix.chi2).abs() <= 1e-6 * fix.chi2.max(1.0),
                        "{name}"
                    );
                    assert!(g.min.inside_grid && g.min.well_determined, "{name}");
                    assert_eq!(g.dof, fix.dof, "{name}");
                }
                FixResult::Ambiguous { candidates, .. } => {
                    for c in candidates
                        .iter()
                        .filter(|c| c.delta_chi2_from_best <= CHI2_95_2DOF)
                    {
                        let near = g.basins.iter().any(|b| {
                            metres(
                                c.position,
                                LatLon {
                                    lat_deg: b.lat_deg,
                                    lon_deg: b.lon_deg,
                                },
                            ) < 1.0
                        });
                        assert!(near, "{name}: no basin at {:?}", c.position);
                    }
                }
                other => {
                    assert_eq!(name, "single-sight", "{name}: {other:?}");
                }
            }
        }
    }

    #[test]
    fn the_two_sight_demo_shows_two_basins_both_inside_the_95_percent_level() {
        let out =
            misfit_grid_json(&demo("two-sight-ambiguous"), "auto", "{}", "", 200, 200).unwrap();
        assert_eq!(out.solve_kind, "ambiguous");
        let g = &out.grid;
        let inside: Vec<&MisfitPoint> = g
            .basins
            .iter()
            .filter(|b| b.well_determined && b.inside_grid && b.delta_chi2 <= CHI2_95_2DOF)
            .collect();
        assert_eq!(inside.len(), 2, "{:?}", g.basins);
        // One of them is Philadelphia (the truth), the other the far intersection.
        assert!(inside.iter().any(|b| {
            metres(
                LatLon {
                    lat_deg: b.lat_deg,
                    lon_deg: b.lon_deg,
                },
                skyfix_sim::demos::PHILADELPHIA,
            ) < 100.0
        }));
        // The grid itself shows them: a local minimum node near each.
        for b in &inside {
            let near = (0..g.n_lat).any(|i| {
                (0..g.n_lon).any(|j| {
                    let p = LatLon {
                        lat_deg: g.lat_deg[i],
                        lon_deg: g.lon_deg[j],
                    };
                    let q = LatLon {
                        lat_deg: b.lat_deg,
                        lon_deg: b.lon_deg,
                    };
                    metres(p, q) < 2.0 * g.lat_step_deg * 60.0 * 1852.0
                        && g.chi2[i * g.n_lon + j] < g.levels[2].chi2 * 100.0
                })
            });
            assert!(near, "no low node near {b:?}");
        }
        assert!(
            g.notes.iter().any(|n| n.contains("2 separate basins")),
            "{:?}",
            g.notes
        );
        // Both candidates are 4800 NM apart and both are in the default frame.
        let d = misfit_default_bounds_json(&demo("two-sight-ambiguous"), "auto", "{}").unwrap();
        assert_eq!(d.frame.centred_on, "candidates");
        assert_eq!(d.frame.bounds, g.bounds);
    }

    #[test]
    fn clustered_geometry_shows_an_elongated_valley() {
        let good = misfit_grid_json(&demo("good-geometry"), "auto", "{}", "", 200, 200).unwrap();
        let bad =
            misfit_grid_json(&demo("clustered-geometry"), "auto", "{}", "", 200, 200).unwrap();
        let (gl, gs, _) = region_shape(&good.grid, good.grid.levels[1].chi2);
        let (bl, bs, bearing) = region_shape(&bad.grid, bad.grid.levels[1].chi2);
        println!(
            "95 % region: good {:.0} m x {:.0} m (aspect {:.2}), clustered {:.0} m x {:.0} m \
             (aspect {:.2}, long axis {bearing:.1} deg)",
            gl,
            gs,
            gl / gs,
            bl,
            bs,
            bl / bs
        );
        assert!(gl / gs < 2.0, "good geometry is round-ish: {}", gl / gs);
        assert!(bl / bs > 3.0, "clustered geometry is a valley: {}", bl / bs);
        assert!(bl > 2.0 * gl, "and a long one");
        // The valley runs the way the solver's ellipse does.
        let solved = solved_demo("clustered-geometry", "{}");
        let FixResult::Unique { fix, .. } = &solved.result else {
            panic!("clustered geometry should be unique")
        };
        let e = fix.ellipse95.as_ref().unwrap();
        let diff = (bearing - e.orientation_deg).rem_euclid(180.0);
        assert!(
            diff.min(180.0 - diff) < 5.0,
            "valley {bearing} vs ellipse {}",
            e.orientation_deg
        );
        // Its long axis matches the ellipse's to a few per cent: the 95 % line near the fix
        // is the ellipse (the moments of a uniformly filled ellipse are a^2 / 4).
        let semi_major = 2.0 * bl;
        assert!(
            (semi_major / e.semi_major_m - 1.0).abs() < 0.05,
            "{semi_major} vs {}",
            e.semi_major_m
        );
    }

    #[test]
    fn the_shared_bias_demo_with_the_bias_estimated() {
        let options = r#"{"estimate_shared_bias": true}"#;
        let out = misfit_grid_json(&demo("shared-bias"), "auto", options, "", 150, 150).unwrap();
        let g = &out.grid;
        assert_eq!((g.unknowns, g.dof), (3, 21));
        assert!(g.bias_profiled);
        let solved = solved_demo("shared-bias", options);
        let FixResult::Unique { fix, .. } = &solved.result else {
            panic!("expected a unique fix")
        };
        assert!(metres(best(g), fix.position) < 0.05);
        let bias = g.min.shared_bias_arcmin.unwrap();
        assert!(
            (bias - fix.shared_bias_arcmin.unwrap()).abs() < 1e-4,
            "{bias}"
        );
        assert!((g.levels[1].delta_chi2 - 7.8147).abs() < 1e-3);
    }

    #[test]
    fn the_bad_sight_demo_with_robust_weighting() {
        let options = r#"{"robust": {"huber_k": 1.5, "max_reweight_iterations": 10}}"#;
        let out = misfit_grid_json(&demo("one-bad-sight"), "auto", options, "", 150, 150).unwrap();
        let g = &out.grid;
        assert!(g.weighted);
        let solved = solved_demo("one-bad-sight", options);
        let FixResult::Unique { fix, .. } = &solved.result else {
            panic!("expected a unique fix")
        };
        assert!(metres(best(g), fix.position) < 0.05);
        let bad = g.sights.iter().find(|s| s.id == "obs-3").unwrap();
        assert!(bad.weight < 0.2, "{}", bad.weight);
    }

    #[test]
    fn one_sight_is_a_valley_round_the_initializer() {
        let out = misfit_grid_json(&demo("single-sight"), "auto", "{}", "", 100, 100).unwrap();
        assert_eq!(out.solve_kind, "underdetermined");
        let g = &out.grid;
        assert!(g.basins.iter().all(|b| !b.well_determined));
        assert!(g.notes.iter().any(|n| n.contains("line, not a point")));
        let d = misfit_default_bounds_json(&demo("single-sight"), "auto", "{}").unwrap();
        assert_eq!(d.frame.centred_on, "initializer");
    }

    #[test]
    fn explicit_bounds_are_used_as_given_and_checked() {
        let bounds =
            json!({"south_deg": 39.9, "north_deg": 40.0, "west_deg": -75.2, "east_deg": -75.1});
        let out = misfit_grid_json(
            &demo("philadelphia-stars"),
            "auto",
            "{}",
            &bounds.to_string(),
            11,
            21,
        )
        .unwrap();
        assert_eq!(out.grid.bounds.south_deg, 39.9);
        assert!((out.grid.bounds.east_deg + 75.1).abs() < 1e-12);
        assert_eq!((out.grid.n_lat, out.grid.n_lon), (11, 21));
        let s = demo("philadelphia-stars");
        let e = misfit_grid_json(&s, "auto", "{}", r#"{"south_deg": 1}"#, 10, 10).unwrap_err();
        assert!(e.starts_with("bounds:"), "{e}");
        let e = misfit_grid_json(
            &s,
            "auto",
            "{}",
            r#"{"south_deg": 10, "north_deg": 5, "west_deg": 0, "east_deg": 1}"#,
            10,
            10,
        )
        .unwrap_err();
        assert!(e.contains("north_deg"), "{e}");
        let e = misfit_grid_json(&s, "auto", "{}", "", 1, 10).unwrap_err();
        assert!(e.contains("n_lat"), "{e}");
        let e = misfit_grid_json(&s, "auto", "{}", "", 10, 5000).unwrap_err();
        assert!(e.contains("n_lon"), "{e}");
        let e = misfit_grid_json(&s, "moon", "{}", "", 10, 10).unwrap_err();
        assert!(e.contains("ephemeris_mode"), "{e}");
        let e = misfit_grid_json(&s, "auto", "{nope", "", 10, 10).unwrap_err();
        assert!(e.starts_with("solve options:"), "{e}");
        let empty = json!({"schema": "skyfix.session/1", "observations": []}).to_string();
        let e = misfit_grid_json(&empty, "auto", "{}", "", 10, 10).unwrap_err();
        assert!(e.contains("no observations"), "{e}");
        // "null" is the default frame, like "".
        let a = misfit_grid_json(&s, "auto", "{}", "null", 12, 12).unwrap();
        let b = misfit_grid_json(&s, "auto", "{}", "", 12, 12).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_rejected_sight_is_named_in_the_notes() {
        let mut session: Value = serde_json::from_str(&demo("philadelphia-stars")).unwrap();
        // Take the direction away from one observation: in "supplied" mode it is rejected.
        session["observations"][1]["geocentric"] = Value::Null;
        let out = misfit_grid_json(&session.to_string(), "supplied", "{}", "", 20, 20).unwrap();
        assert_eq!(out.grid.sights.len(), 4);
        assert!(
            out.grid
                .notes
                .iter()
                .any(|n| n.contains("obs-2") && n.contains("not in the map")),
            "{:?}",
            out.grid.notes
        );
    }

    #[test]
    fn the_javascript_head_carries_every_field_but_the_values() {
        let out = misfit_grid_json(&demo("philadelphia-stars"), "auto", "{}", "", 8, 9).unwrap();
        let full = serde_json::to_value(&out).unwrap();
        let head = serde_json::to_value(Head::of(&out)).unwrap();
        let mut full_keys: Vec<&String> = full.as_object().unwrap().keys().collect();
        let mut head_keys: Vec<&String> = head.as_object().unwrap().keys().collect();
        full_keys.retain(|k| k.as_str() != "chi2");
        full_keys.sort();
        head_keys.sort();
        assert_eq!(full_keys, head_keys);
        for k in head_keys {
            assert_eq!(full[k], head[k], "{k}");
        }
        assert_eq!(full["levels"][1]["name"], "p95");
        assert_eq!(full["min"]["shared_bias_arcmin"], Value::Null);
        assert_eq!(full["solve_kind"], "unique");
    }
}
