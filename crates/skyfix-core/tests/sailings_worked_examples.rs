//! The worked examples of Bowditch 2019, vol. 1, ch. 12 "The Sailings" (NGA Pub. No. 9,
//! a U.S. Government work), reproduced through `skyfix_core::sailings`.
//!
//! The numbers are typed with provenance into `fixtures/reference/bowditch_sailings.json`
//! (CONVENTIONS section 11). Each case states its tolerance: the printed precision, or,
//! where the book's own four-decimal arithmetic or an intermediate rounding moves the
//! printed answer further, that rounding carried through, with the reason in `why`.
//! Errata are recorded there and checked against the book's own formulas here.
//!
//! `cargo test -p skyfix-core --test sailings_worked_examples -- --nocapture` prints the
//! comparison table quoted in docs/NAVIGATION_METHODS.md section 9.8.

use serde_json::Value;
use skyfix_core::geometry::Point;
use skyfix_core::sailings::composite::{CompositePiece, composite};
use skyfix_core::sailings::dr::{DrMethod, dr_advance};
use skyfix_core::sailings::great_circle::GreatCircle;
use skyfix_core::sailings::rhumb::{
    MeridionalParts, mid_latitude_direct, mid_latitude_inverse, plane_sailing, rhumb_direct,
    rhumb_inverse, traverse,
};
use skyfix_core::units::{ARCMIN, norm_180, norm_360};

const D: f64 = std::f64::consts::PI / 180.0;

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference/bowditch_sailings.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("missing number {key} in {v}"))
}

fn pair(v: &Value, key: &str) -> Point {
    let a = v[key].as_array().unwrap();
    Point::from_deg(a[0].as_f64().unwrap(), a[1].as_f64().unwrap())
}

fn list(v: &Value, key: &str) -> Vec<f64> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn parts(v: &Value) -> MeridionalParts {
    match v.get("meridional_parts").and_then(Value::as_str) {
        Some("wgs84") => MeridionalParts::Wgs84,
        _ => MeridionalParts::Sphere,
    }
}

/// Collects `(case, quantity, book, skyfix, difference, tolerance)` and fails at the end
/// with every miss listed.
struct Check {
    rows: Vec<(String, String, f64, f64, f64, f64)>,
    misses: Vec<String>,
}

impl Check {
    fn new() -> Self {
        Check {
            rows: Vec::new(),
            misses: Vec::new(),
        }
    }

    /// `diff` is SkyFix minus the book in the unit of `tol`.
    fn row(&mut self, case: &str, what: &str, book: f64, ours: f64, diff: f64, tol: f64) {
        if diff.is_nan() || diff.abs() > tol {
            self.misses.push(format!(
                "{case} {what}: book {book}, SkyFix {ours}, difference {diff:+.4} > {tol}"
            ));
        }
        self.rows
            .push((case.to_string(), what.to_string(), book, ours, diff, tol));
    }

    /// Latitudes and angles compared in arcminutes.
    fn arcmin(&mut self, case: &str, what: &str, book_deg: f64, ours_deg: f64, tol_arcmin: f64) {
        self.row(
            case,
            what,
            book_deg,
            ours_deg,
            norm_180(ours_deg - book_deg) * 60.0,
            tol_arcmin,
        );
    }

    fn plain(&mut self, case: &str, what: &str, book: f64, ours: f64, tol: f64) {
        self.row(case, what, book, ours, ours - book, tol);
    }

    fn course(&mut self, case: &str, what: &str, book: f64, ours: f64, tol: f64) {
        self.row(case, what, book, ours, norm_180(ours - book), tol);
    }
}

#[test]
fn bowditch_chapter_12_worked_examples_reproduce() {
    let fx = fixture();
    let mut c = Check::new();
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        26,
        "every worked example of sections 1207-1220 with numbers"
    );
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let i = &case["input"];
        let e = &case["expected"];
        let t = &case["tolerance"];
        match kind {
            "gc_inverse" => {
                let gc = GreatCircle::new(pair(i, "from"), pair(i, "to")).unwrap();
                c.plain(
                    name,
                    "distance, deg",
                    num(e, "distance_deg"),
                    gc.distance_rad() / D,
                    num(t, "distance_deg"),
                );
                c.plain(
                    name,
                    "distance, NM",
                    num(e, "distance_nm"),
                    gc.distance_nm(),
                    num(t, "distance_nm"),
                );
                c.course(
                    name,
                    "initial course, deg",
                    num(e, "initial_course_deg"),
                    norm_360(gc.initial_course() / D),
                    num(t, "initial_course_deg"),
                );
            }
            "gc_final_course" => {
                let gc = GreatCircle::new(pair(i, "from"), pair(i, "to")).unwrap();
                let ours = norm_360(gc.final_course() / D);
                // The book's own formula with its own inputs (an independent computation:
                // spherical trigonometry, not unit vectors).
                let (dd, l1, l2) = (
                    num(i, "book_D_deg") * D,
                    num(i, "book_L1_deg") * D,
                    num(i, "book_L2_deg") * D,
                );
                let cos_c = (l1.sin() - dd.cos() * l2.sin()) / (dd.sin() * l2.cos());
                // Destination south of the equator, DLo west: the final course angle is
                // named N...W (Bowditch: contrary to L2, same as DLo), so Cn = 360 - C.
                let book_formula = 360.0 - cos_c.acos() / D;
                c.course(
                    name,
                    "final course vs the book's formula, deg",
                    book_formula,
                    ours,
                    num(t, "final_course_deg"),
                );
                // The erratum: the printed ratio does not follow from the printed formula.
                assert!((cos_c - num(e, "printed_cos_C")).abs() > 0.03, "{cos_c}");
                assert!((ours - num(e, "printed_final_course_deg")).abs() > 1.5);
            }
            "gc_points_dlo_from_vertex" => {
                let v = pair(i, "vertex");
                for (k, dlo) in list(i, "dlo_deg").into_iter().enumerate() {
                    let course = if dlo > 0.0 { 90.0 } else { 270.0 };
                    let gc = GreatCircle::from_course(v, course * D, 1.5);
                    let s = gc.meridian_crossing(v.lon + dlo * D).unwrap();
                    let p = gc.point_at(s);
                    c.arcmin(
                        name,
                        "latitude",
                        num(e, "lat_deg"),
                        p.lat_deg(),
                        num(t, "lat_arcmin"),
                    );
                    let book_lon = list(e, "lon_deg")[k];
                    c.arcmin(
                        name,
                        "longitude",
                        book_lon,
                        p.lon_deg(),
                        num(t, "lon_arcmin"),
                    );
                }
            }
            "gc_points_distance_from_vertex" => {
                let v = pair(i, "vertex");
                let d = num(i, "distance_nm") * ARCMIN;
                let west = GreatCircle::from_course(v, 270.0 * D, d).to;
                let east = GreatCircle::from_course(v, 90.0 * D, d).to;
                for (what, p, lon) in [("west", west, "lon_w_deg"), ("east", east, "lon_e_deg")] {
                    c.arcmin(
                        name,
                        &format!("latitude {what}"),
                        num(e, "lat_deg"),
                        p.lat_deg(),
                        num(t, "lat_arcmin"),
                    );
                    c.arcmin(
                        name,
                        &format!("longitude {what}"),
                        num(e, lon),
                        p.lon_deg(),
                        num(t, "lon_arcmin"),
                    );
                }
            }
            "gc_points_on_meridians" => {
                let from = pair(i, "from");
                let gc = GreatCircle::from_course(from, num(i, "course_deg") * D, 1.0);
                let v = gc.vertex().unwrap();
                c.arcmin(
                    name,
                    "vertex latitude",
                    num(e, "vertex_lat_deg"),
                    v.point.lat_deg(),
                    num(t, "vertex_lat_arcmin"),
                );
                c.arcmin(
                    name,
                    "vertex longitude",
                    num(e, "vertex_lon_deg"),
                    v.point.lon_deg(),
                    num(t, "vertex_lon_arcmin"),
                );
                for (lon, lat) in list(i, "meridians_deg").into_iter().zip(list(e, "lat_deg")) {
                    let s = gc.meridian_crossing(lon * D).unwrap();
                    c.arcmin(
                        name,
                        &format!("latitude at {lon}"),
                        lat,
                        gc.point_at(s).lat_deg(),
                        num(t, "lat_arcmin"),
                    );
                }
            }
            "gc_points_along_course" => {
                let from = pair(i, "from");
                let lats = list(e, "lat_deg");
                let dlos = list(e, "dlo_deg");
                for (k, arc) in list(i, "arc_deg").into_iter().enumerate() {
                    let p = GreatCircle::from_course(from, num(i, "course_deg") * D, arc * D).to;
                    c.arcmin(
                        name,
                        &format!("latitude at {arc} deg"),
                        lats[k],
                        p.lat_deg(),
                        num(t, "lat_arcmin"),
                    );
                    let dlo = norm_180(p.lon_deg() - from.lon_deg()).abs();
                    c.plain(
                        name,
                        &format!("DLo at {arc} deg"),
                        dlos[k],
                        dlo,
                        num(t, "dlo_deg"),
                    );
                }
            }
            "gc_vertex_from_course" => {
                let from = pair(i, "from");
                let gc = GreatCircle::from_course(from, num(i, "course_deg") * D, 1.0);
                let v = gc.vertex().unwrap();
                c.arcmin(
                    name,
                    "vertex latitude",
                    num(e, "lat_deg"),
                    v.point.lat_deg(),
                    num(t, "lat_arcmin"),
                );
                c.arcmin(
                    name,
                    "vertex longitude",
                    num(e, "lon_deg"),
                    v.point.lon_deg(),
                    num(t, "lon_arcmin"),
                );
                c.plain(
                    name,
                    "distance to vertex, NM",
                    num(e, "distance_nm"),
                    v.arc_from_start / ARCMIN,
                    num(t, "distance_nm"),
                );
            }
            "composite" => {
                let comp =
                    composite(pair(i, "from"), pair(i, "to"), num(i, "limit_deg") * D).unwrap();
                assert!(comp.applies, "{name}: {}", comp.note);
                let (lon1, dlo) = comp
                    .pieces
                    .iter()
                    .find_map(|p| match p {
                        CompositePiece::Parallel { lon_start, dlo, .. } => Some((*lon_start, *dlo)),
                        _ => None,
                    })
                    .unwrap();
                c.arcmin(
                    name,
                    "reach the limit at longitude",
                    num(e, "lon1_deg"),
                    lon1 / D,
                    num(t, "lon1_arcmin"),
                );
                c.arcmin(
                    name,
                    "leave the limit at longitude",
                    num(e, "lon2_deg"),
                    (lon1 + dlo) / D,
                    num(t, "lon2_arcmin"),
                );
            }
            "plane_direct" => {
                let (l, p) = plane_sailing(num(i, "course_deg") * D, num(i, "distance_nm"));
                c.plain(
                    name,
                    "difference of latitude, NM",
                    num(e, "dlat_nm"),
                    l,
                    num(t, "dlat_nm"),
                );
                c.plain(
                    name,
                    "departure, NM",
                    num(e, "departure_nm"),
                    p,
                    num(t, "departure_nm"),
                );
            }
            "plane_inverse" => {
                let tr = traverse(&[(0.0, num(i, "dlat_nm")), (90.0, num(i, "departure_nm"))]);
                c.course(
                    name,
                    "course, deg",
                    num(e, "course_deg"),
                    tr.course_deg.unwrap(),
                    num(t, "course_deg"),
                );
                c.plain(
                    name,
                    "distance, NM",
                    num(e, "distance_nm"),
                    tr.distance_nm,
                    num(t, "distance_nm"),
                );
            }
            "traverse" => {
                let legs: Vec<(f64, f64)> = i["legs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| (l[0].as_f64().unwrap(), l[1].as_f64().unwrap()))
                    .collect();
                let tr = traverse(&legs);
                c.course(
                    name,
                    "course made good, deg",
                    num(e, "course_deg"),
                    tr.course_deg.unwrap(),
                    num(t, "course_deg"),
                );
                c.plain(
                    name,
                    "distance made good, NM",
                    num(e, "distance_nm"),
                    tr.distance_nm,
                    num(t, "distance_nm"),
                );
            }
            "parallel_departure" => {
                let lat = num(i, "lat_deg");
                let r = rhumb_inverse(
                    Point::from_deg(lat, 0.0),
                    Point::from_deg(lat, num(i, "dlo_arcmin") / 60.0),
                    MeridionalParts::Sphere,
                );
                c.plain(
                    name,
                    "departure, NM",
                    num(e, "departure_nm"),
                    r.departure_nm,
                    num(t, "departure_nm"),
                );
            }
            "parallel_dlo" => {
                let lat = num(i, "lat_deg");
                let p = num(i, "departure_nm");
                let course = if p >= 0.0 { 90.0 } else { 270.0 };
                let q = rhumb_direct(
                    Point::from_deg(lat, 0.0),
                    course * D,
                    p.abs(),
                    MeridionalParts::Sphere,
                )
                .unwrap();
                c.plain(
                    name,
                    "DLo, arcmin",
                    num(e, "dlo_arcmin"),
                    q.lon_deg() * 60.0,
                    num(t, "dlo_arcmin"),
                );
            }
            "midlat_direct" => {
                let q = mid_latitude_direct(
                    pair(i, "from"),
                    num(i, "course_deg") * D,
                    num(i, "distance_nm"),
                )
                .unwrap();
                c.arcmin(
                    name,
                    "latitude",
                    num(e, "lat_deg"),
                    q.lat_deg(),
                    num(t, "lat_arcmin"),
                );
                c.arcmin(
                    name,
                    "longitude",
                    num(e, "lon_deg"),
                    q.lon_deg(),
                    num(t, "lon_arcmin"),
                );
            }
            "midlat_inverse" => {
                let m = mid_latitude_inverse(pair(i, "from"), pair(i, "to")).unwrap();
                c.course(
                    name,
                    "course, deg",
                    num(e, "course_deg"),
                    norm_360(m.course.unwrap() / D),
                    num(t, "course_deg"),
                );
                c.plain(
                    name,
                    "distance, NM",
                    num(e, "distance_nm"),
                    m.distance_nm,
                    num(t, "distance_nm"),
                );
                c.arcmin(
                    name,
                    "mean latitude",
                    num(e, "mean_latitude_deg"),
                    m.mean_latitude / D,
                    num(t, "mean_latitude_arcmin"),
                );
                c.plain(
                    name,
                    "departure, NM",
                    num(e, "departure_nm"),
                    m.departure_nm,
                    num(t, "departure_nm"),
                );
            }
            "mercator_inverse" => {
                let r = rhumb_inverse(pair(i, "from"), pair(i, "to"), parts(i));
                if e.get("meridional_difference_arcmin").is_some() {
                    c.plain(
                        name,
                        "meridional difference, arcmin",
                        num(e, "meridional_difference_arcmin"),
                        r.meridional_difference_arcmin,
                        num(t, "meridional_difference_arcmin"),
                    );
                    c.plain(
                        name,
                        "DLo, arcmin",
                        num(e, "dlo_arcmin"),
                        r.dlo_arcmin,
                        num(t, "dlo_arcmin"),
                    );
                }
                c.course(
                    name,
                    "course, deg",
                    num(e, "course_deg"),
                    norm_360(r.course.unwrap() / D),
                    num(t, "course_deg"),
                );
                c.plain(
                    name,
                    "distance, NM",
                    num(e, "distance_nm"),
                    r.distance_nm,
                    num(t, "distance_nm"),
                );
            }
            "mercator_direct" | "dr_rhumb" => {
                let q = dr_advance(
                    pair(i, "from"),
                    num(i, "course_deg") * D,
                    num(i, "distance_nm"),
                    DrMethod::Rhumb,
                    parts(i),
                )
                .unwrap();
                c.arcmin(
                    name,
                    "latitude",
                    num(e, "lat_deg"),
                    q.lat_deg(),
                    num(t, "lat_arcmin"),
                );
                c.arcmin(
                    name,
                    "longitude",
                    num(e, "lon_deg"),
                    q.lon_deg(),
                    num(t, "lon_arcmin"),
                );
            }
            other => panic!("unknown case kind {other}"),
        }
    }
    println!(
        "{:<26} {:<44} {:>14} {:>14} {:>10} {:>6}",
        "case", "quantity", "Bowditch", "SkyFix", "diff", "tol"
    );
    for (case, what, book, ours, diff, tol) in &c.rows {
        println!("{case:<26} {what:<44} {book:>14.4} {ours:>14.4} {diff:>+10.4} {tol:>6}");
    }
    println!("{} comparisons", c.rows.len());
    assert!(c.misses.is_empty(), "misses:\n{}", c.misses.join("\n"));
}

/// The Mercator examples need the spheroidal meridional parts the book's Table 6 is
/// built on: on the sphere the courses move by 0.1-0.2 degree. Pinned so the docs'
/// statement stays true.
#[test]
fn mercator_examples_on_the_sphere_differ_by_the_spheroid() {
    let fx = fixture();
    let mut worst: f64 = 0.0;
    for case in fx["cases"].as_array().unwrap() {
        if case["kind"] != "mercator_inverse" {
            continue;
        }
        let i = &case["input"];
        let w = rhumb_inverse(pair(i, "from"), pair(i, "to"), MeridionalParts::Wgs84);
        let s = rhumb_inverse(pair(i, "from"), pair(i, "to"), MeridionalParts::Sphere);
        let dc = norm_180((s.course.unwrap() - w.course.unwrap()) / D);
        println!(
            "{}: course sphere - wgs84 = {dc:+.3} deg, distance {:+.2} NM",
            case["name"].as_str().unwrap(),
            s.distance_nm - w.distance_nm
        );
        worst = worst.max(dc.abs());
    }
    assert!(worst > 0.1 && worst < 0.2, "{worst}");
}
