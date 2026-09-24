//! Solar eclipse paths against NASA's path tables (`eclipses_nasa_paths.json`) and the
//! limits against Skyfield + DE440s (`eclipses_skyfield.json`, `limit_crossings`).
//!
//! NASA's tables are in UT with the page's own Delta-T (68.4 s in 2017 to 71.4 s in
//! 2026). The engine is run with the DUT1 that reproduces it,
//! `DUT1 = 32.184 + 37 - Delta-T`, so both sides describe the same Earth rotation and
//! a table row at UT `T` is compared with our curves at UTC `T - DUT1`. The tables give
//! positions to 0.1' (185 m) and use ELP-2000/85 where we use ELP 2000-82B, which
//! already puts the shadow axis 5e-5 Earth radii (0.3 km) apart.
//!
//! Each NASA point is measured against our curve as a map needs it: its perpendicular
//! distance from the curve (is a place inside the path or not), and the difference
//! between the curve's time at the foot of that perpendicular and the table's time.
//! Comparing positions at equal times instead would mix the two: near sunrise and sunset
//! the shadow crosses the ground at up to hundreds of km/s, so a tenth of a second
//! there is kilometres along the path while the path itself has not moved.
//!
//! Run with `-- --nocapture` for the numbers.

use serde::Deserialize;
use skyfix_almanac::eclipses::{Eclipse, EclipsePath, Eclipses, Polyline, SolarPath};
use skyfix_core::time::civil_to_jd;

const PATHS: &str = "fixtures/reference/eclipses_nasa_paths.json";
const SKYFIELD: &str = "fixtures/reference/eclipses_skyfield.json";

fn read(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is committed: {e}", path.display()))
}

#[derive(Debug, Deserialize)]
struct PathsFile {
    schema: String,
    eclipses: Vec<PathEclipse>,
}

#[derive(Debug, Deserialize)]
struct PathEclipse {
    id: String,
    delta_t_s: f64,
    greatest: Greatest,
    limits: Option<Limits>,
    rows: Vec<Row>,
}

#[derive(Debug, Deserialize)]
struct Greatest {
    ut: String,
    lat_deg: f64,
    lon_deg: f64,
    sun_alt_deg: f64,
    path_width_km: f64,
    central_duration_s: f64,
}

#[derive(Debug, Deserialize)]
struct Limits {
    start: Row,
    end: Option<Row>,
}

#[derive(Debug, Deserialize)]
struct Row {
    #[serde(default)]
    ut: Option<String>,
    north: Option<LatLon>,
    south: Option<LatLon>,
    central: Option<LatLon>,
    sun_alt_deg: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct LatLon {
    lat_deg: f64,
    lon_deg: f64,
}

fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (p1, p2) = (a.0.to_radians(), b.0.to_radians());
    let dl = (b.1 - a.1).to_radians();
    let h = ((p2 - p1) / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().min(1.0).asin()
}

fn unit(lat: f64, lon: f64) -> [f64; 3] {
    let (p, l) = (lat.to_radians(), lon.to_radians());
    [p.cos() * l.cos(), p.cos() * l.sin(), p.sin()]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    let c = cross(a, b);
    dot(c, c).sqrt().atan2(dot(a, b))
}

/// Distance (km, on a 6371 km sphere) from `q` to the curve `p`, and the curve's time
/// (UTC JD) at the nearest point. Each segment is taken as a great-circle arc, which
/// holds at the poles too.
fn cross_track(p: &Polyline, q: (f64, f64)) -> Option<(f64, f64)> {
    let pq = unit(q.0, q.1);
    let mut best: Option<(f64, f64)> = None;
    for (seg, ts) in p.segments.iter().zip(&p.jd_utc) {
        for i in 0..seg.len().saturating_sub(1) {
            let (a, b) = (
                unit(seg[i][1], seg[i][0]),
                unit(seg[i + 1][1], seg[i + 1][0]),
            );
            let n = cross(a, b);
            let nn = dot(n, n).sqrt();
            let (d, f) = if nn < 1e-15 {
                (angle(pq, a), 0.0)
            } else {
                let n = n.map(|v| v / nn);
                let h = dot(pq, n);
                let foot = [pq[0] - h * n[0], pq[1] - h * n[1], pq[2] - h * n[2]];
                let ab = angle(a, b);
                let (fa, fb) = (angle(a, foot), angle(foot, b));
                if (fa + fb - ab).abs() < 1e-9 {
                    (h.clamp(-1.0, 1.0).asin().abs(), fa / ab)
                } else if angle(pq, a) <= angle(pq, b) {
                    (angle(pq, a), 0.0)
                } else {
                    (angle(pq, b), 1.0)
                }
            };
            let d = d * 6371.0;
            if best.is_none_or(|x| d < x.0) {
                best = Some((d, ts[i] + f * (ts[i + 1] - ts[i])));
            }
        }
    }
    best
}

fn nearest_km(lines: &[&Polyline], q: (f64, f64)) -> f64 {
    lines
        .iter()
        .flat_map(|p| p.segments.iter().flatten())
        .map(|v| km((v[1], v[0]), q))
        .fold(f64::INFINITY, f64::min)
}

fn ut_seconds(s: &str) -> f64 {
    let p: Vec<f64> = s.split(':').map(|x| x.parse().unwrap()).collect();
    p[0] * 3600.0 + p[1] * 60.0 + p.get(2).copied().unwrap_or(0.0)
}

fn solar_path(e: &Eclipses, id: &str) -> SolarPath {
    match e.path(id).unwrap() {
        EclipsePath::Solar(p) => *p,
        other => panic!("{other:?}"),
    }
}

#[test]
fn paths_match_nasa_tables() {
    let file: PathsFile = serde_json::from_str(&read(PATHS)).unwrap();
    assert_eq!(file.schema, "skyfix.reference/1");
    assert_eq!(file.eclipses.len(), 6);
    let (mut worst_high, mut worst_low, mut worst_dt) = (0.0f64, 0.0f64, 0.0f64);
    let mut failures: Vec<String> = Vec::new();
    let mut compared = 0usize;
    for ecl in &file.eclipses {
        let dut1 = 69.184 - ecl.delta_t_s;
        let engine = Eclipses::with_dut1_s(dut1);
        let path = solar_path(&engine, &ecl.id);
        let (y, m, d) = (
            ecl.id[0..4].parse::<i32>().unwrap(),
            ecl.id[5..7].parse::<u32>().unwrap(),
            ecl.id[8..10].parse::<u32>().unwrap(),
        );
        let j0 = civil_to_jd(y, m, d);
        let (mut e_high, mut e_low, mut e_dt) = (0.0f64, 0.0f64, 0.0f64);
        let mut n = 0;
        for row in &ecl.rows {
            let ut = ut_seconds(row.ut.as_deref().unwrap());
            let jd = j0 + (ut - dut1) / 86_400.0;
            for (theirs, ours, what) in [
                (row.central, &path.central_line, "central"),
                (row.north, &path.umbra_north, "north"),
                (row.south, &path.umbra_south, "south"),
            ] {
                let Some(t) = theirs else { continue };
                let q = (t.lat_deg, t.lon_deg);
                // NASA's hybrid table labels its limits by the sign of L2, so in the total
                // section its "northern limit" is the geographic southern one; ours are
                // geographic (left of the shadow's motion). Compare a hybrid's unlabelled.
                let (err, t_ours) = if ecl.id == "2023-04-20-solar" && what != "central" {
                    let n = cross_track(&path.umbra_north, q).unwrap();
                    let s = cross_track(&path.umbra_south, q).unwrap();
                    if n.0 <= s.0 { n } else { s }
                } else {
                    cross_track(ours, q).unwrap_or_else(|| panic!("{} has no {what} line", ecl.id))
                };
                let dt = (t_ours - jd) * 86_400.0;
                if std::env::var("SHOW_ROWS").is_ok() {
                    println!(
                        "  {} {} {what}: {err:.2} km, {dt:+.2} s (Sun {} deg)",
                        ecl.id,
                        row.ut.as_deref().unwrap(),
                        row.sun_alt_deg
                    );
                }
                if row.sun_alt_deg >= 5.0 {
                    e_high = e_high.max(err);
                    e_dt = e_dt.max(dt.abs());
                } else {
                    e_low = e_low.max(err);
                }
                n += 1;
            }
        }
        // The two ends of the path (NASA's "Limits" rows): the central line's first and
        // last points, and the extremes of the path at sunrise and sunset, which lie on
        // the umbral horizon loops or the ends of the limit lines.
        let mut e_ends = 0.0f64;
        if let Some(l) = &ecl.limits {
            for (row, first) in [(Some(&l.start), true), (l.end.as_ref(), false)] {
                let Some(row) = row else { continue };
                if let Some(c) = row.central {
                    let seg = if first {
                        path.central_line.segments.first().and_then(|s| s.first())
                    } else {
                        path.central_line.segments.last().and_then(|s| s.last())
                    };
                    let v = seg.unwrap();
                    e_ends = e_ends.max(km((v[1], v[0]), (c.lat_deg, c.lon_deg)));
                }
                for p in [row.north, row.south].into_iter().flatten() {
                    let lines = [&path.umbra_north, &path.umbra_south, &path.umbra_horizon];
                    e_ends = e_ends.max(nearest_km(&lines, (p.lat_deg, p.lon_deg)));
                }
            }
        }
        // Greatest eclipse.
        let g = &ecl.greatest;
        let summary = match engine.by_id(&ecl.id).unwrap() {
            Eclipse::Solar(s) => s,
            other => panic!("{other:?}"),
        };
        let ge_ut = (summary.greatest.jd_utc - j0) * 86_400.0 + dut1;
        let dt_ge = ge_ut - ut_seconds(&g.ut);
        let d_ge = km(
            (summary.greatest.lat_deg, summary.greatest.lon_deg),
            (g.lat_deg, g.lon_deg),
        );
        let d_width = summary.path_width_km.unwrap() - g.path_width_km;
        let d_dur = summary.central_duration_s.unwrap() - g.central_duration_s;
        let d_alt = summary.greatest.sun_alt_deg - g.sun_alt_deg;
        println!(
            "{}: {n} points, off the line by {e_high:.2} km at most (Sun >= 5 deg; \
             {e_low:.2} km lower), along it {e_dt:.2} s; ends {e_ends:.2} km; greatest \
             eclipse {dt_ge:+.2} s {d_ge:.2} km, width {d_width:+.2} km, duration \
             {d_dur:+.2} s, Sun altitude {d_alt:+.2} deg",
            ecl.id
        );
        // 2021-12-04 (Antarctica, the Sun at most 17 degrees up): NASA's table is 2.3 km
        // from ours, and ours is within 0.16 km of Skyfield + DE440s there
        // (`limits_cross_meridians_where_skyfield_says`): the difference is NASA's.
        let (km_bound, s_bound, ge_bound) = if ecl.id == "2021-12-04-solar" {
            (3.0, 3.0, 2.5)
        } else {
            (1.0, 2.0, 1.5)
        };
        let checks = [
            (e_high < km_bound, "cross-track (Sun >= 5 deg)"),
            (e_low < 3.0, "cross-track (Sun < 5 deg)"),
            (e_dt < s_bound, "along-track time"),
            (e_ends < 4.0, "ends of the path"),
            (dt_ge.abs() < 2.0 && d_ge < ge_bound, "greatest eclipse"),
            (
                d_width.abs() < 1.5 && d_dur.abs() < 1.5,
                "width and duration",
            ),
            (d_alt.abs() < 0.2, "Sun altitude"),
        ];
        for (ok, what) in checks {
            if !ok {
                failures.push(format!("{}: {what}", ecl.id));
            }
        }
        worst_high = worst_high.max(e_high);
        worst_low = worst_low.max(e_low);
        worst_dt = worst_dt.max(e_dt);
        compared += n;
    }
    println!(
        "all: {compared} points: within {worst_high:.2} km of our lines (Sun >= 5 deg; {worst_low:.2} km lower), {worst_dt:.2} s along them"
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[derive(Debug, Deserialize)]
struct SkyfieldFile {
    limit_crossings: Vec<Crossing>,
}

#[derive(Debug, Deserialize)]
struct Crossing {
    id: String,
    cone: String,
    lon_deg: f64,
    crossings: Vec<CrossingPoint>,
}

#[derive(Debug, Deserialize)]
struct CrossingPoint {
    lat_deg: f64,
    jd_utc: f64,
    sun_alt_deg: f64,
}

/// Latitudes (and times) where `p` crosses meridian `lon`.
fn meridian_crossings(p: &Polyline, lon: f64) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for (seg, ts) in p.segments.iter().zip(&p.jd_utc) {
        for (w, t) in seg.windows(2).zip(ts.windows(2)) {
            let (a, b) = (w[0], w[1]);
            if (b[0] - a[0]).abs() > 180.0 {
                continue;
            }
            if (a[0] - lon) * (b[0] - lon) <= 0.0 && a[0] != b[0] {
                let f = (lon - a[0]) / (b[0] - a[0]);
                out.push((a[1] + f * (b[1] - a[1]), t[0] + f * (t[1] - t[0])));
            }
        }
    }
    out
}

/// Skyfield + DE440s finds each limit where it crosses a meridian as the latitude at
/// which the eclipse is exactly grazing at maximum, from the topocentric separation
/// alone. Our limit lines must cross there. Compared without labels: north and south
/// are the sides left and right of the shadow's motion (NASA's usage), which for a
/// path running west, as in Antarctica in 2021, is not the geographic north.
#[test]
fn limits_cross_meridians_where_skyfield_says() {
    let file: SkyfieldFile = serde_json::from_str(&read(SKYFIELD)).unwrap();
    let engine = Eclipses::new();
    let (mut worst_u, mut worst_p, mut worst_t) = (0.0f64, 0.0f64, 0.0f64);
    let mut n = 0;
    for c in &file.limit_crossings {
        let path = solar_path(&engine, &c.id);
        let lines: [&Polyline; 2] = match c.cone.as_str() {
            "umbra" => [&path.umbra_north, &path.umbra_south],
            "penumbra" => [&path.penumbra_north, &path.penumbra_south],
            other => panic!("{other}"),
        };
        let ours: Vec<(f64, f64)> = lines
            .iter()
            .flat_map(|l| meridian_crossings(l, c.lon_deg))
            .collect();
        for x in &c.crossings {
            let (lat, t) = ours
                .iter()
                .copied()
                .min_by(|a, b| (a.0 - x.lat_deg).abs().total_cmp(&(b.0 - x.lat_deg).abs()))
                .unwrap_or_else(|| panic!("{} {}: no limit crosses {}", c.id, c.cone, c.lon_deg));
            let d_lat = lat - x.lat_deg;
            let d_t = (t - x.jd_utc) * 86_400.0;
            println!(
                "{} {:8} limit at {:7.1} E, {:6.2} N (Sun {:4.1} deg): {:+.5} deg ({:+.3} km), \
                 time {d_t:+.1} s",
                c.id,
                c.cone,
                c.lon_deg,
                x.lat_deg,
                x.sun_alt_deg,
                d_lat,
                d_lat * 111.2
            );
            if c.cone == "umbra" {
                worst_u = worst_u.max(d_lat.abs());
            } else {
                worst_p = worst_p.max(d_lat.abs());
            }
            worst_t = worst_t.max(d_t.abs());
            n += 1;
        }
    }
    println!(
        "{n} crossings: umbral limits within {:.3} km, penumbral within {:.3} km (in latitude), \
         times within {worst_t:.1} s",
        worst_u * 111.2,
        worst_p * 111.2
    );
    assert!(n >= 20, "{n}");
    // 0.01 degree of latitude is 1.1 km; measured 0.59 km and 0.40 km.
    assert!(worst_u < 0.01 && worst_p < 0.01, "{worst_u} {worst_p}");
    assert!(worst_t < 3.0, "{worst_t}");
}

#[test]
fn paths_are_geojson_ready_and_fast() {
    let engine = Eclipses::new();
    for id in [
        "2024-04-08-solar",
        "2021-12-04-solar",
        "2014-04-29-solar",
        "2011-07-01-solar",
    ] {
        let t0 = std::time::Instant::now();
        let p = solar_path(&engine, id);
        let dt = t0.elapsed();
        let all = [
            &p.central_line,
            &p.umbra_north,
            &p.umbra_south,
            &p.umbra_horizon,
            &p.penumbra_north,
            &p.penumbra_south,
            &p.penumbra_horizon,
        ];
        let mut vertices = 0;
        for line in all {
            assert_eq!(line.segments.len(), line.jd_utc.len());
            for (seg, ts) in line.segments.iter().zip(&line.jd_utc) {
                assert!(seg.len() >= 2 && seg.len() == ts.len(), "{id}");
                for w in seg.windows(2) {
                    // No segment jumps across the map: it was split at +-180.
                    assert!((w[1][0] - w[0][0]).abs() < 180.0, "{id}: {w:?}");
                }
                for v in seg {
                    assert!((-180.0..=180.0).contains(&v[0]) && (-90.0..=90.0).contains(&v[1]));
                }
                vertices += seg.len();
            }
        }
        println!("{id}: {vertices} vertices in {dt:?}");
    }
    // 2024-04-08: the northern penumbral limit runs over the pole and across 180.
    let p = solar_path(&engine, "2024-04-08-solar");
    assert!(p.penumbra_north.segments.len() >= 2);
    assert!(
        p.penumbra_north
            .segments
            .iter()
            .any(|s| s.iter().any(|v| v[0].abs() == 180.0))
    );
    // A partial eclipse has no central line and no umbral limits; a non-central
    // annular eclipse has one umbral limit and no central line.
    let p = solar_path(&engine, "2011-07-01-solar");
    assert!(p.central_line.is_empty() && p.umbra_north.is_empty() && p.umbra_south.is_empty());
    let p = solar_path(&engine, "2014-04-29-solar");
    assert!(p.central_line.is_empty());
    assert!(p.umbra_north.is_empty() != p.umbra_south.is_empty());
}

/// Timing in a release build (`cargo test --release -p skyfix-almanac --test
/// eclipse_paths -- --ignored --nocapture`): the budget is 50 ms per path. Each path is
/// timed five times and the best kept, so a busy machine does not decide the result.
#[test]
#[ignore]
fn path_timing_release() {
    let engine = Eclipses::new();
    let list = engine
        .find(civil_to_jd(2017, 1, 1), civil_to_jd(2027, 1, 1))
        .unwrap();
    let mut worst = std::time::Duration::ZERO;
    let mut n = 0;
    for e in &list.eclipses {
        if let Eclipse::Solar(s) = e {
            let best = (0..5)
                .map(|_| {
                    let t0 = std::time::Instant::now();
                    let _ = engine.path(&s.id).unwrap();
                    t0.elapsed()
                })
                .min()
                .unwrap();
            println!("{}: {best:?}", s.id);
            worst = worst.max(best);
            n += 1;
        }
    }
    println!("{n} paths, slowest {worst:?} (best of five each)");
    assert!(worst.as_secs_f64() < 0.05, "{worst:?}");
}

/// Every solar eclipse of 1990-2060 draws: finite coordinates, the lines its type
/// implies, no jump between neighbouring vertices longer than the refinement allows
/// (plus the closing chord of a horizon loop and the last step onto the horizon).
/// Release build: `cargo test --release -p skyfix-almanac --test eclipse_paths --
/// --ignored --nocapture`.
#[test]
#[ignore]
fn every_path_of_1990_2060_is_drawable() {
    use skyfix_almanac::eclipses::SolarType;
    let engine = Eclipses::new();
    let list = engine
        .find(civil_to_jd(1990, 1, 1), civil_to_jd(2061, 1, 1))
        .unwrap();
    let (mut n, mut worst_gap, mut worst_at) = (0, 0.0f64, String::new());
    for e in &list.eclipses {
        let Eclipse::Solar(s) = e else { continue };
        let p = solar_path(&engine, &s.id);
        assert_eq!(p.central_line.is_empty(), !s.central, "{}", s.id);
        let umbra = !p.umbra_north.is_empty() || !p.umbra_south.is_empty();
        assert_eq!(umbra, s.eclipse_type != SolarType::Partial, "{}", s.id);
        assert!(
            !p.penumbra_north.is_empty()
                || !p.penumbra_south.is_empty()
                || !p.penumbra_horizon.is_empty(),
            "{}",
            s.id
        );
        for (name, line) in [
            ("central", &p.central_line),
            ("umbra_north", &p.umbra_north),
            ("umbra_south", &p.umbra_south),
            ("penumbra_north", &p.penumbra_north),
            ("penumbra_south", &p.penumbra_south),
        ] {
            for seg in &line.segments {
                for w in seg.windows(2) {
                    assert!(w[0].iter().chain(&w[1]).all(|v| v.is_finite()), "{}", s.id);
                    let gap = km((w[0][1], w[0][0]), (w[1][1], w[1][0]));
                    if gap > worst_gap {
                        worst_gap = gap;
                        worst_at = format!("{} {name}", s.id);
                    }
                }
            }
        }
        n += 1;
    }
    println!("{n} solar paths; longest step between vertices {worst_gap:.0} km ({worst_at})");
    assert_eq!(n, 158);
    // MAX_SEGMENT_KM is 150 km; the steps onto the horizon stay within it too.
    assert!(worst_gap <= 151.0, "{worst_gap} km at {worst_at}");
}
