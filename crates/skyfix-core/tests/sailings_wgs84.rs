//! How far the sailings' sphere (CONVENTIONS section 1: 1′ of arc = 1 NM = 1852 m) is
//! from the WGS84 ellipsoid. The numbers quoted in docs/NAVIGATION_METHODS.md section
//! 9.7 come from here (`-- --nocapture`).
//!
//! The ellipsoidal references are computed in this test and nowhere else:
//! - the geodesic by Vincenty's inverse formula (T. Vincenty, "Direct and inverse
//!   solutions of geodesics on the ellipsoid with application of nested equations",
//!   Survey Review 23 (176), 1975), checked against the worked example in the
//!   Geocentric Datum of Australia technical manual (Flinders Peak to Buninyong,
//!   54 972.271 m) and against the WGS84 quarter meridian (10 001 965.729 m);
//! - the loxodrome on the ellipsoid from the WGS84 isometric latitude and the meridian
//!   arc (the Helmert series in the third flattening, checked against the same quarter
//!   meridian).

use skyfix_core::geometry::Point;
use skyfix_core::sailings::great_circle::GreatCircle;
use skyfix_core::sailings::rhumb::{MeridionalParts, isometric_latitude, rhumb_inverse};
use skyfix_core::units::{NM_M, norm_pi};

const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_223_563;
const D: f64 = std::f64::consts::PI / 180.0;

/// Vincenty's inverse: the geodesic distance in metres, or `None` when the iteration
/// does not settle (near-antipodal points).
fn vincenty_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> Option<f64> {
    let b = A * (1.0 - F);
    let l = lon2 - lon1;
    let u1 = ((1.0 - F) * lat1.tan()).atan();
    let u2 = ((1.0 - F) * lat2.tan()).atan();
    let (su1, cu1) = u1.sin_cos();
    let (su2, cu2) = u2.sin_cos();
    let mut lambda = l;
    for _ in 0..500 {
        let (sl, cl) = lambda.sin_cos();
        let sin_sigma = ((cu2 * sl).powi(2) + (cu1 * su2 - su1 * cu2 * cl).powi(2)).sqrt();
        if sin_sigma == 0.0 {
            return Some(0.0);
        }
        let cos_sigma = su1 * su2 + cu1 * cu2 * cl;
        let sigma = sin_sigma.atan2(cos_sigma);
        let sin_alpha = cu1 * cu2 * sl / sin_sigma;
        let cos2_alpha = 1.0 - sin_alpha * sin_alpha;
        let cos_2sm = if cos2_alpha == 0.0 {
            0.0
        } else {
            cos_sigma - 2.0 * su1 * su2 / cos2_alpha
        };
        let c = F / 16.0 * cos2_alpha * (4.0 + F * (4.0 - 3.0 * cos2_alpha));
        let next = l
            + (1.0 - c)
                * F
                * sin_alpha
                * (sigma
                    + c * sin_sigma * (cos_2sm + c * cos_sigma * (-1.0 + 2.0 * cos_2sm * cos_2sm)));
        if (next - lambda).abs() < 1e-13 {
            let u_sq = cos2_alpha * (A * A - b * b) / (b * b);
            let big_a =
                1.0 + u_sq / 16384.0 * (4096.0 + u_sq * (-768.0 + u_sq * (320.0 - 175.0 * u_sq)));
            let big_b = u_sq / 1024.0 * (256.0 + u_sq * (-128.0 + u_sq * (74.0 - 47.0 * u_sq)));
            let d_sigma = big_b
                * sin_sigma
                * (cos_2sm
                    + big_b / 4.0
                        * (cos_sigma * (-1.0 + 2.0 * cos_2sm * cos_2sm)
                            - big_b / 6.0
                                * cos_2sm
                                * (-3.0 + 4.0 * sin_sigma * sin_sigma)
                                * (-3.0 + 4.0 * cos_2sm * cos_2sm)));
            return Some(b * big_a * (sigma - d_sigma));
        }
        lambda = next;
    }
    None
}

/// Meridian arc from the equator to `lat`, metres (Helmert's series in n = f/(2-f)).
fn meridian_arc_m(lat: f64) -> f64 {
    let n = F / (2.0 - F);
    let (n2, n3, n4) = (n * n, n * n * n, n * n * n * n);
    A / (1.0 + n)
        * ((1.0 + n2 / 4.0 + n4 / 64.0) * lat - 1.5 * (n - n3 / 8.0) * (2.0 * lat).sin()
            + 15.0 / 16.0 * (n2 - n4 / 4.0) * (4.0 * lat).sin()
            - 35.0 / 48.0 * n3 * (6.0 * lat).sin()
            + 315.0 / 512.0 * n4 * (8.0 * lat).sin())
}

/// Length of the loxodrome on WGS84, metres.
fn wgs84_loxodrome_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlon = norm_pi(lon2 - lon1);
    let dpsi = isometric_latitude(lat2, MeridionalParts::Wgs84)
        - isometric_latitude(lat1, MeridionalParts::Wgs84);
    if (lat2 - lat1).abs() < 1e-10 {
        let e2 = F * (2.0 - F);
        let nu = A / (1.0 - e2 * lat1.sin().powi(2)).sqrt();
        return nu * lat1.cos() * dlon.abs();
    }
    let ds = meridian_arc_m(lat2) - meridian_arc_m(lat1);
    ds.abs() * dlon.hypot(dpsi) / dpsi.abs()
}

/// A small deterministic generator (xorshift64*), so the sweep is reproducible without
/// a random-number crate.
struct Rng(u64);

impl Rng {
    fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next_f64()
    }
}

fn dms(d: f64, m: f64, s: f64) -> f64 {
    (d.abs() + m / 60.0 + s / 3600.0).copysign(d) * D
}

#[test]
fn the_ellipsoidal_references_reproduce_their_published_values() {
    // GDA technical manual: Flinders Peak to Buninyong, 54 972.271 m (GRS80, whose
    // flattening differs from WGS84's by 1.6e-11: 0.001 mm here).
    let s = vincenty_m(
        dms(-37.0, 57.0, 3.72030),
        dms(144.0, 25.0, 29.52440),
        dms(-37.0, 39.0, 10.15610),
        dms(143.0, 55.0, 35.38390),
    )
    .unwrap();
    assert!((s - 54_972.271).abs() < 0.001, "{s}");
    // The WGS84 quarter meridian, 10 001 965.729 m, both ways.
    let q = vincenty_m(0.0, 0.0, 90.0 * D, 0.0).unwrap();
    assert!((q - 10_001_965.729).abs() < 0.001, "{q}");
    assert!((meridian_arc_m(90.0 * D) - 10_001_965.729).abs() < 0.001);
    // A minute of latitude: 1842.9 m at the equator, 1861.6 m at the pole.
    let at =
        |lat: f64| meridian_arc_m((lat + 0.5 / 60.0) * D) - meridian_arc_m((lat - 0.5 / 60.0) * D);
    assert!((at(0.0) - 1842.9).abs() < 0.05, "{}", at(0.0));
    assert!((at(89.99) - 1861.6).abs() < 0.05, "{}", at(89.99));
}

#[test]
fn sphere_distances_are_within_half_a_percent_of_wgs84() {
    let mut rng = Rng(0x5eed_5a11_1665_0001);
    let (mut worst_gc, mut worst_rhumb, mut worst_short) = (0.0f64, 0.0f64, 0.0f64);
    let mut n = 0;
    for _ in 0..20_000 {
        let lat1 = rng.range(-80.0, 80.0) * D;
        let lat2 = rng.range(-80.0, 80.0) * D;
        let lon1 = rng.range(-180.0, 180.0) * D;
        let lon2 = rng.range(-180.0, 180.0) * D;
        let gc = GreatCircle::new(Point::new(lat1, lon1), Point::new(lat2, lon2)).unwrap();
        if gc.distance_rad() > 170.0 * D || gc.distance_rad() < 1e-6 {
            continue;
        }
        let Some(geodesic) = vincenty_m(lat1, lon1, lat2, lon2) else {
            continue;
        };
        n += 1;
        let rel = gc.distance_nm() * NM_M / geodesic - 1.0;
        worst_gc = worst_gc.max(rel.abs());
        let r = rhumb_inverse(
            Point::new(lat1, lon1),
            Point::new(lat2, lon2),
            MeridionalParts::Sphere,
        );
        let lox = wgs84_loxodrome_m(lat1, lon1, lat2, lon2);
        worst_rhumb = worst_rhumb.max((r.distance_nm * NM_M / lox - 1.0).abs());
    }
    // Short legs are where the local minute of latitude shows most: along a meridian
    // near the equator (1842.9 m) and near a pole (1861.6 m).
    for lat in [0.0, 30.0, 60.0, 80.0, 89.0] {
        for course in [0.0, 45.0, 90.0] {
            let p = Point::from_deg(lat, 10.0);
            let q = skyfix_core::geometry::destination(p, course * D, 10.0 / 3437.747);
            let s = vincenty_m(p.lat, p.lon, q.lat, q.lon).unwrap();
            worst_short = worst_short.max((10.0 * NM_M / s - 1.0).abs());
        }
    }
    println!("{n} random pairs (up to 170 deg apart, latitudes within 80 deg):");
    println!(
        "  great circle on the sphere vs the WGS84 geodesic: worst {:.3} %",
        100.0 * worst_gc
    );
    println!(
        "  rhumb line on the sphere vs the WGS84 loxodrome:  worst {:.3} %",
        100.0 * worst_rhumb
    );
    println!(
        "  10 NM legs at 0-89 deg latitude:                  worst {:.3} %",
        100.0 * worst_short
    );
    assert!(n > 15_000);
    // docs/NAVIGATION_METHODS.md 9.7: "at most 0.52 %".
    assert!(worst_gc < 0.0052 && worst_rhumb < 0.0052 && worst_short < 0.0052);
    assert!(
        worst_gc > 0.0049 && worst_short > 0.0049,
        "the bound should be tight"
    );
}
