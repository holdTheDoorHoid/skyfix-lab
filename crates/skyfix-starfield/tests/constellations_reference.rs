//! `constellation_at` against Skyfield's constellation map on 25 000 pseudo-random
//! apparent-of-date directions and instants, 1990-2060
//! (`fixtures/reference/starfield_constellations.json`).
//!
//! The directions are not stored: both sides draw them from the same documented
//! generator (splitmix64, seed in the fixture), and the fixture carries the first
//! samples so a mismatch in the generator port fails loudly instead of comparing
//! unrelated points.
//!
//! Two reference answers are compared:
//!
//! * `answers_mean_b1875` — Skyfield's grid looked up in the MEAN equator and equinox of
//!   B1875.0, the frame the IAU boundaries are defined in. Target: 100 % agreement
//!   except within 1" of a boundary.
//! * Skyfield's `load_constellation_map()` as shipped, which looks the direction up in
//!   the TRUE equinox of B1875.0 (its `Time.M` includes nutation). It can differ within
//!   the 1875 nutation (about 8") of a boundary; any difference is explained here.

use serde_json::Value;
use skyfix_starfield::constellations::{apparent_to_b1875, boundary_distance_b1875_deg};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/reference/starfield_constellations.json"
);

struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * 2f64.powi(-53)
    }
}

fn samples(seed: u64, n: usize, jd0: f64, jd1: f64) -> Vec<(f64, f64, f64)> {
    let mut g = SplitMix64(seed);
    (0..n)
        .map(|_| {
            let (u1, u2, u3) = (g.uniform(), g.uniform(), g.uniform());
            (
                360.0 * u1,
                (2.0 * u2 - 1.0).asin().to_degrees(),
                jd0 + u3 * (jd1 - jd0),
            )
        })
        .collect()
}

#[test]
fn constellation_at_agrees_with_skyfield() {
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    let g = &fx["generator"]["sampling"];
    let seed = g["seed"].as_u64().unwrap();
    let count = g["count"].as_u64().unwrap() as usize;
    let pts = samples(seed, count, 2_447_892.5, 2_473_459.5);

    // The generator port reproduces Skyfield's side.
    for (k, want) in g["first_samples"].as_array().unwrap().iter().enumerate() {
        let (ra, dec, jd) = pts[k];
        let w: Vec<f64> = want
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect();
        assert!(
            (ra - w[0]).abs() < 1e-9 && (dec - w[1]).abs() < 1e-9 && (jd - w[2]).abs() < 1e-6,
            "sample {k}: ({ra}, {dec}, {jd}) vs {w:?}"
        );
    }

    let answers: Vec<&str> = fx["answers_mean_b1875"]
        .as_str()
        .unwrap()
        .split(' ')
        .collect();
    assert_eq!(answers.len(), count);
    assert!(count >= 20_000);

    let mut ours = Vec::with_capacity(count);
    let mut disagreements = Vec::new();
    for (k, &(ra, dec, jd)) in pts.iter().enumerate() {
        let c = skyfix_starfield::constellation_at(ra, dec, jd).unwrap();
        if c != answers[k] {
            let (rb, db) = apparent_to_b1875(ra, dec, jd).unwrap();
            let dist = boundary_distance_b1875_deg(rb, db) * 3600.0;
            disagreements.push((k, c, answers[k], dist));
        }
        ours.push(c);
    }
    for (k, c, want, dist) in &disagreements {
        println!("sample {k}: ours {c}, Skyfield (mean B1875) {want}, {dist:.3}\" from a boundary");
        assert!(
            *dist < 1.0,
            "sample {k} disagrees {dist:.3}\" from a boundary"
        );
    }
    println!(
        "{count} directions: {} disagree with Skyfield's map in the mean B1875 frame",
        disagreements.len()
    );

    // Skyfield as shipped (true equinox of B1875): explain every difference.
    let nut = &fx["generator"]["nutation_b1875_arcsec"];
    let shift = nut["dpsi"]
        .as_f64()
        .unwrap()
        .hypot(nut["deps"].as_f64().unwrap());
    let shipped = fx["answers_skyfield_as_shipped_where_different"]
        .as_array()
        .unwrap();
    for d in shipped {
        let k = d[0].as_u64().unwrap() as usize;
        let (ra, dec, jd) = pts[k];
        let (rb, db) = apparent_to_b1875(ra, dec, jd).unwrap();
        let dist = boundary_distance_b1875_deg(rb, db) * 3600.0;
        println!(
            "sample {k}: Skyfield as shipped says {}, ours {}; {dist:.2}\" from a boundary",
            d[1], ours[k]
        );
        assert!(dist < shift + 1.0, "sample {k}: {dist}\" from a boundary");
    }
    println!(
        "Skyfield as shipped (true equinox of B1875, nutation {shift:.1}\") differs at {} of {count}",
        shipped.len()
    );
}
