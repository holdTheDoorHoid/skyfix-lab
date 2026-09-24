//! Boundaries, figures and labels: the checks `tools/starfield/build.py` makes, made
//! again on the Rust side against the embedded data.

use skyfix_starfield::constellations::{
    boundary_distance_b1875_deg, icrs_to_b1875, regions_containing_b1875,
};
use skyfix_starfield::{CONSTELLATIONS, boundaries_j2000, constellation_at_b1875};

fn sep_deg(a1: f64, d1: f64, a2: f64, d2: f64) -> f64 {
    let (a1, d1, a2, d2) = (
        a1.to_radians(),
        d1.to_radians(),
        a2.to_radians(),
        d2.to_radians(),
    );
    let c = d1.sin() * d2.sin() + d1.cos() * d2.cos() * (a1 - a2).cos();
    c.clamp(-1.0, 1.0).acos().to_degrees()
}

#[test]
fn every_point_of_the_sky_is_in_exactly_one_constellation() {
    // A half-degree grid, offset so it also samples the poles' neighbourhoods.
    let mut n = 0;
    let mut dec = -89.9;
    while dec < 90.0 {
        let mut ra = 0.1;
        while ra < 360.0 {
            let r = regions_containing_b1875(ra, dec);
            assert_eq!(r.len(), 1, "({ra}, {dec}) is in {r:?}");
            n += 1;
            ra += 0.5;
        }
        dec += 0.5;
    }
    assert!(n > 250_000);
}

#[test]
fn points_exactly_on_boundary_lines_belong_to_one_constellation() {
    // Every combination of a boundary RA and a boundary Dec: all of them lie on at
    // least one boundary line, the hardest case for the half-open rules.
    let text = include_str!("../data/boundaries.txt");
    let mut ras = std::collections::BTreeSet::new();
    let mut decs = std::collections::BTreeSet::new();
    for line in text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        for pair in line.rsplit('|').next().unwrap().split_whitespace() {
            let (a, d) = pair.split_once(',').unwrap();
            ras.insert(a.parse::<i32>().unwrap());
            decs.insert(d.parse::<i32>().unwrap());
        }
    }
    for &a in &ras {
        for &d in &decs {
            let r = regions_containing_b1875(f64::from(a) / 240.0, f64::from(d) / 60.0);
            assert_eq!(r.len(), 1, "({a} s, {d}') is in {r:?}");
        }
    }
    println!("{} boundary grid points checked", ras.len() * decs.len());
}

#[test]
fn every_constellation_has_a_figure_and_a_label_inside_it() {
    let cons = skyfix_starfield::constellations().unwrap();
    assert_eq!(cons.len(), 88);
    for (c, (abbr, name)) in cons.iter().zip(CONSTELLATIONS.iter()) {
        assert_eq!((c.abbr, c.name), (*abbr, *name));
        assert!(!c.lines.is_empty(), "{abbr} has no figure");
        let (a, d) = icrs_to_b1875(c.label_ra_deg, c.label_dec_deg);
        assert_eq!(constellation_at_b1875(a, d), Some(c.abbr), "{abbr} label");
        let inset = boundary_distance_b1875_deg(a, d);
        assert!(inset > 0.25, "{abbr} label only {inset:.3} deg inside");
    }
}

#[test]
fn figure_stars_lie_in_or_beside_their_constellation() {
    let cat = skyfix_starfield::catalog().unwrap();
    let cons = skyfix_starfield::constellations().unwrap();
    let mut outside = Vec::new();
    let mut longest = (0.0f64, "");
    let mut segments = 0;
    for c in cons {
        let mut seen = std::collections::BTreeSet::new();
        for &(i, j) in &c.lines {
            assert_ne!(i, j, "{}: zero-length segment", c.abbr);
            let len = sep_deg(
                cat.ra_j2000_deg[i],
                cat.dec_j2000_deg[i],
                cat.ra_j2000_deg[j],
                cat.dec_j2000_deg[j],
            );
            assert!(len <= 25.0, "{}: segment of {len:.1} deg", c.abbr);
            if len > longest.0 {
                longest = (len, c.abbr);
            }
            assert!(
                seen.insert((i.min(j), i.max(j))),
                "{}: segment drawn twice",
                c.abbr
            );
            segments += 1;
        }
        let members: std::collections::BTreeSet<usize> =
            seen.iter().flat_map(|&(a, b)| [a, b]).collect();
        for k in members {
            let (a, d) = icrs_to_b1875(cat.ra_j2000_deg[k], cat.dec_j2000_deg[k]);
            let home = constellation_at_b1875(a, d).unwrap();
            if home != c.abbr {
                let dist = boundary_distance_b1875_deg(a, d);
                assert!(
                    dist < 2.0,
                    "{}: HR {} lies in {home}, {dist:.2} deg away",
                    c.abbr,
                    cat.hr[k]
                );
                outside.push((c.abbr, cat.hr[k], home));
            }
            // Figures are for naked-eye stars.
            assert!(
                cat.vmag[k] < 5.6,
                "{}: HR {} is V {}",
                c.abbr,
                cat.hr[k],
                cat.vmag[k]
            );
        }
    }
    println!(
        "{segments} segments; longest {:.1} deg ({}); borrowed stars {outside:?}",
        longest.0, longest.1
    );
    // Alpheratz closes the Square of Pegasus; Elnath closes the pentagon of Auriga.
    assert_eq!(outside.len(), 2, "{outside:?}");
}

#[test]
fn drawn_boundaries_are_closed_fine_and_on_the_boundary() {
    let b = boundaries_j2000().unwrap();
    assert_eq!(b.len(), 89, "88 constellations, Serpens in two parts");
    let mut abbrs: Vec<&str> = b.iter().map(|p| p.abbr).collect();
    abbrs.dedup();
    assert_eq!(abbrs.len(), 88);
    let mut points = 0;
    for p in b {
        let n = p.ra_deg.len();
        assert_eq!(n, p.dec_deg.len());
        assert!(n >= 5, "{}", p.abbr);
        assert_eq!(
            (p.ra_deg[0], p.dec_deg[0]),
            (p.ra_deg[n - 1], p.dec_deg[n - 1])
        );
        for k in 0..n {
            assert!((0.0..360.0).contains(&p.ra_deg[k]) && p.dec_deg[k].abs() <= 90.0);
            if k > 0 {
                let step = sep_deg(p.ra_deg[k - 1], p.dec_deg[k - 1], p.ra_deg[k], p.dec_deg[k]);
                assert!(step <= 1.01, "{}: {step:.3} deg step", p.abbr);
            }
            // Back in B1875 every point is on a boundary (to rounding). Every fifth
            // point is enough, and keeps the debug-build test quick.
            if k % 5 != 0 {
                continue;
            }
            let (a, d) = icrs_to_b1875(p.ra_deg[k], p.dec_deg[k]);
            let off = boundary_distance_b1875_deg(a, d) * 3600.0;
            assert!(
                off < 1e-3,
                "{}: point {k} is {off}\" off the boundary",
                p.abbr
            );
        }
        points += n;
    }
    println!("{points} boundary points");
}
