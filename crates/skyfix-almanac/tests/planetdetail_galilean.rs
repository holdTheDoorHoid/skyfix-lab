//! The Galilean moons against Skyfield with JPL's `jup365` satellite ephemeris on DE440
//! (`fixtures/reference/planetdetail_galilean.json`): the moons' offsets from Jupiter's
//! centre at 18 instants (15 inside 1995-2058) and every transit, shadow transit,
//! occultation and eclipse of two 20-day windows of 2026, one at opposition and one at
//! eastern quadrature.

mod pd_common;

use pd_common::{Worst, jd_utc_from_tt, planet_coverage, read};
use serde::Deserialize;
use skyfix_almanac::satellites::{MOONS, PhenomenonKind, galilean_events, galilean_moons};

#[derive(Debug, Deserialize)]
struct File {
    positions: Vec<Instant>,
    events: Vec<Edge>,
}

#[derive(Debug, Deserialize)]
struct Instant {
    jd_tt: f64,
    jupiter_pole_pa_deg: f64,
    jupiter_radius_arcsec: f64,
    sub_earth_lat_deg: f64,
    moons: Vec<Moon>,
}

#[derive(Debug, Deserialize)]
struct Moon {
    name: String,
    east_arcsec: f64,
    north_arcsec: f64,
    x_rj: f64,
    y_rj: f64,
    depth_km: f64,
    transit: bool,
    occultation: bool,
    eclipse: bool,
    shadow_transit: bool,
}

#[derive(Debug, Deserialize)]
struct Edge {
    moon: String,
    kind: String,
    edge: String,
    jd_tt: f64,
}

fn file() -> File {
    serde_json::from_str(&read("fixtures/reference/planetdetail_galilean.json")).unwrap()
}

#[test]
fn positions_match_jup365() {
    let (lo, hi) = planet_coverage();
    let f = file();
    let mut worst = [
        Worst::default(),
        Worst::default(),
        Worst::default(),
        Worst::default(),
    ];
    let (mut pa, mut radius, mut lat) = (Worst::default(), Worst::default(), Worst::default());
    let mut compared = 0;
    for inst in &f.positions {
        let jd = jd_utc_from_tt(inst.jd_tt);
        if jd < lo || jd > hi {
            continue;
        }
        let m = galilean_moons(jd).unwrap();
        let at = || format!("jd_tt {}", inst.jd_tt);
        pa.add(
            pd_common::wrap(m.jupiter.pole_position_angle_deg, inst.jupiter_pole_pa_deg),
            at,
        );
        radius.add(
            m.jupiter.equatorial_radius_arcsec - inst.jupiter_radius_arcsec,
            at,
        );
        lat.add(m.jupiter.sub_earth_lat_deg - inst.sub_earth_lat_deg, at);
        for (k, want) in inst.moons.iter().enumerate() {
            let got = &m.moons[k];
            assert_eq!(got.name, want.name);
            let de = got.offset_east_arcsec - want.east_arcsec;
            let dn = got.offset_north_arcsec - want.north_arcsec;
            let err = de.hypot(dn);
            worst[k].add(err, || {
                format!(
                    "{} jd_tt {} (de {de:+.3}\", dn {dn:+.3}\")",
                    want.name, inst.jd_tt
                )
            });
            // The frame of x/y matches to the same tolerance, in Jupiter radii.
            let rj = inst.jupiter_radius_arcsec;
            assert!((got.x_rj - want.x_rj).abs() * rj < 1.5, "{got:?} {want:?}");
            assert!((got.y_rj - want.y_rj).abs() * rj < 1.5, "{got:?} {want:?}");
            assert!(
                (got.z_rj * 71_492.0 - want.depth_km).abs() < 2_000.0,
                "{got:?} {want:?}"
            );
            // States agree unless the moon is within a few seconds of a limb.
            let near_limb = (got.x_rj.powi(2) + got.y_rj.powi(2)).sqrt();
            if !(0.97..1.03).contains(&near_limb) {
                assert_eq!(got.in_transit, want.transit, "{got:?} {want:?}");
                assert_eq!(got.occulted, want.occultation, "{got:?} {want:?}");
            }
            assert_eq!(got.eclipsed, want.eclipse, "{got:?} {want:?}");
            assert_eq!(got.shadow_on_disc, want.shadow_transit, "{got:?} {want:?}");
            compared += 1;
        }
    }
    for w in &worst {
        println!("{w:?}");
    }
    println!("pole PA {pa:?}\nradius {radius:?}\nsub-Earth latitude {lat:?}");
    assert!(compared >= 60, "{compared}");
    for w in &worst {
        assert!(
            w.value.abs() < skyfix_almanac::satellites::ACCURACY_ARCSEC,
            "{w:?}"
        );
    }
    assert!(
        pa.value.abs() < 0.001 && lat.value.abs() < 0.001,
        "{pa:?} {lat:?}"
    );
    assert!(radius.value.abs() < 0.001, "{radius:?}");
}

#[test]
fn phenomena_match_jup365() {
    let f = file();
    // The two windows of the fixture, UTC.
    let windows = [
        (2_461_045.5, 2_461_065.5), // 2026-01-05 .. 2026-01-25
        (2_461_131.5, 2_461_151.5), // 2026-04-01 .. 2026-04-21
    ];
    let mut per_kind: std::collections::BTreeMap<String, Worst> = Default::default();
    let mut matched = 0;
    for (a, b) in windows {
        let ev = galilean_events(a, b).unwrap();
        let want: Vec<&Edge> = f
            .events
            .iter()
            .filter(|e| {
                let jd = jd_utc_from_tt(e.jd_tt);
                jd >= a && jd <= b
            })
            .collect();
        // Every reference edge inside the window has a computed edge of the same moon and
        // kind within tolerance, and vice versa.
        let mut ours = Vec::new();
        for p in &ev.phenomena {
            let kind = match p.kind {
                PhenomenonKind::Transit => "transit",
                PhenomenonKind::ShadowTransit => "shadow_transit",
                PhenomenonKind::Occultation => "occultation",
                PhenomenonKind::Eclipse => "eclipse",
            };
            for (edge, inst) in [("start", &p.start), ("end", &p.end)] {
                if inst.jd_utc >= a && inst.jd_utc <= b {
                    ours.push((p.moon.clone(), kind, edge, inst.jd_utc));
                }
            }
        }
        for w in &want {
            let jd = jd_utc_from_tt(w.jd_tt);
            let best = ours
                .iter()
                .filter(|o| o.0 == w.moon && o.1 == w.kind && o.2 == w.edge)
                .map(|o| (o.3 - jd) * 86_400.0)
                .min_by(|x, y| x.abs().total_cmp(&y.abs()));
            let Some(dt) = best else {
                panic!("no computed {} {} {} near {jd}", w.moon, w.kind, w.edge);
            };
            per_kind
                .entry(format!("{} {}", w.moon, w.kind))
                .or_default()
                .add(dt, || format!("{} {} at jd_tt {}", w.edge, w.kind, w.jd_tt));
            matched += 1;
        }
        // Nothing extra, beyond edges within a minute of the window's ends.
        let extra = ours
            .iter()
            .filter(|o| o.3 > a + 60.0 / 86_400.0 && o.3 < b - 60.0 / 86_400.0)
            .count();
        assert_eq!(
            extra,
            want.len(),
            "computed {extra} edges, reference {}",
            want.len()
        );
    }
    for (k, w) in &per_kind {
        println!("{k}: {w:?}");
    }
    assert!(matched > 300, "{matched}");
    // Timing: the moons cross the limb at 8-17 km/s, so E5's along-track error in 2026
    // (Io about 350 km ahead, Ganymede 800 km behind, Callisto 450 km ahead; Europa's
    // swings with a period of weeks) is the whole budget: measured worst 34 s (Io), 50 s
    // (Europa), 103 s (Ganymede), 81 s (Callisto).
    for (k, w) in &per_kind {
        let tol = match k.split(' ').next() {
            Some("Io") => 45.0,
            Some("Europa") => 60.0,
            _ => 120.0,
        };
        assert!(w.value.abs() < tol, "{k}: {w:?}");
    }
    let _ = MOONS;
}
