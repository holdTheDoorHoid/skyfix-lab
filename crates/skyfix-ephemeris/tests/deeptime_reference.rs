//! The Sun, the Moon and the planets over both coverage tiers against
//! `fixtures/reference/deeptime_bodies.json` (`tools/reference/gen_deeptime.py`: Skyfield
//! with JPL DE440 per half-century of 1550-2650, DE441 per century from 2000 BC to
//! AD 3000; the long-term precession frame outside the validated tier).
//!
//! Every case gives its own TT and UT1, and the providers are called through
//! `position_at` with those, so Delta T is not part of the comparison (CONVENTIONS
//! 15.2): what is measured is the ephemeris and the frame model alone.
//!
//! Each case is asserted against the provider's published accuracy for the case's tier
//! (`SUN_ACCURACY_ARCMIN`, `SUN_LABELLED_ACCURACY_ARCMIN`, `MOON_*`,
//! `planets::{ACCURACY_BY_PLANET_ARCMIN, LABELLED_ACCURACY_BY_PLANET_ARCMIN}`), so the
//! numbers `explorer_coverage` reports for each tier are backed here. The stars (the
//! first epoch of each bin) are held to the model's own agreement with Skyfield, and
//! their published figures to that plus the catalogue's formal uncertainty the fixture
//! records. Run with `-- --nocapture` for the per-bin tables that `docs/ACCURACY.md`,
//! "Historical accuracy", quotes.

use std::collections::BTreeMap;

use serde::Deserialize;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::moon::{MOON_ACCURACY_ARCMIN, MOON_LABELLED_ACCURACY_ARCMIN, MoonProvider};
use skyfix_ephemeris::planets::{
    ACCURACY_BY_PLANET_ARCMIN, LABELLED_ACCURACY_BY_PLANET_ARCMIN, Planet, PlanetProvider,
};
use skyfix_ephemeris::stars::{
    STAR_ACCURACY_ARCMIN, STAR_LABELLED_ACCURACY_ARCMIN, apparent_radec_of_star,
};
use skyfix_ephemeris::sun::{SUN_ACCURACY_ARCMIN, SUN_LABELLED_ACCURACY_ARCMIN, SunProvider};
use skyfix_ephemeris::tiers::TierPolicy;

const FIXTURE: &str = "fixtures/reference/deeptime_bodies.json";

#[derive(Debug, Deserialize)]
struct File {
    schema: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    tier: String,
    bin: String,
    utc: String,
    jd_utc: f64,
    jd_ut1: f64,
    jd_tt: f64,
    bodies: BTreeMap<String, Body>,
    /// `{name: [ra_deg, dec_deg, catalogue_sigma_arcsec]}` on the first epoch of a bin.
    #[serde(default)]
    stars: Option<BTreeMap<String, [f64; 3]>>,
}

#[derive(Debug, Deserialize)]
struct Body {
    ra_deg: f64,
    dec_deg: f64,
    gha_deg: f64,
    distance_km: f64,
    #[serde(default)]
    geometric_distance_km: Option<f64>,
}

/// What the providers give for one body at one case.
struct Got {
    ra_deg: f64,
    dec_deg: f64,
    gha_deg: f64,
    distance_km: f64,
}

const ORDER: [&str; 9] = [
    "Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune",
];

fn claimed(body: &str, labelled: bool) -> f64 {
    match body {
        "Sun" if labelled => SUN_LABELLED_ACCURACY_ARCMIN,
        "Sun" => SUN_ACCURACY_ARCMIN,
        "Moon" if labelled => MOON_LABELLED_ACCURACY_ARCMIN,
        "Moon" => MOON_ACCURACY_ARCMIN,
        planet => {
            let p = Planet::from_name(planet).expect("a planet");
            let table = if labelled {
                &LABELLED_ACCURACY_BY_PLANET_ARCMIN
            } else {
                &ACCURACY_BY_PLANET_ARCMIN
            };
            table.iter().find(|(q, _)| *q == p).expect("listed").1
        }
    }
}

fn evaluate(body: &str, c: &Case) -> Got {
    let policy = TierPolicy::WithLabelled;
    match body {
        "Sun" => {
            let p = SunProvider::new()
                .with_policy(policy)
                .position_at(c.jd_utc, c.jd_tt, c.jd_ut1)
                .unwrap();
            Got {
                ra_deg: p.ra_deg,
                dec_deg: p.dec_deg,
                gha_deg: p.gha_deg,
                distance_km: p.radius_au * skyfix_ephemeris::body::AU_KM,
            }
        }
        "Moon" => {
            let p = MoonProvider::new()
                .with_policy(policy)
                .position_at(c.jd_utc, c.jd_tt, c.jd_ut1)
                .unwrap();
            Got {
                ra_deg: p.ra_deg,
                dec_deg: p.dec_deg,
                gha_deg: p.gha_deg,
                distance_km: p.distance_km,
            }
        }
        planet => {
            let pl = Planet::from_name(planet).unwrap();
            let p = PlanetProvider::new()
                .with_policy(policy)
                .position_at(pl, c.jd_utc, c.jd_tt, c.jd_ut1)
                .unwrap();
            Got {
                ra_deg: p.ra_deg,
                dec_deg: p.dec_deg,
                gha_deg: p.gha_deg,
                distance_km: p.distance_au * skyfix_ephemeris::body::AU_KM,
            }
        }
    }
}

#[derive(Default, Clone, Copy)]
struct Worst {
    /// Largest of |dGHA| and |dDec|, arcminutes (the quantity the accuracy claims bound).
    gha_dec: f64,
    /// Largest on-sky direction error, arcseconds.
    on_sky: f64,
    /// Largest relative distance error.
    distance: f64,
}

#[test]
fn every_body_meets_its_tier_accuracy_over_both_tiers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let file: File = serde_json::from_str(&text).expect("valid skyfix.reference/1");
    assert_eq!(file.schema, skyfix_core::types::REFERENCE_SCHEMA);
    assert!(file.cases.len() > 500, "{} cases", file.cases.len());

    // bin -> body -> worst, in file order of the bins.
    let mut bins: Vec<(String, String)> = Vec::new();
    let mut table: BTreeMap<(String, String), Worst> = BTreeMap::new();
    let mut tier_worst: BTreeMap<(String, String), Worst> = BTreeMap::new();
    let mut failures = Vec::new();
    for c in &file.cases {
        let labelled = c.tier == "labelled";
        assert!(labelled || c.tier == "validated", "{}", c.tier);
        if bins.last().is_none_or(|(b, _)| *b != c.bin) {
            bins.push((c.bin.clone(), c.tier.clone()));
        }
        for body in ORDER {
            let want = &c.bodies[body];
            let got = evaluate(body, c);
            let d_gha = norm_180(got.gha_deg - want.gha_deg) * 60.0;
            let d_ra = norm_180(got.ra_deg - want.ra_deg) * 60.0;
            let d_dec = (got.dec_deg - want.dec_deg) * 60.0;
            let cosd = want.dec_deg.to_radians().cos();
            let on_sky = (d_ra * cosd).hypot(d_dec) * 60.0;
            let reference_km = if body == "Moon" {
                want.geometric_distance_km.unwrap_or(want.distance_km)
            } else {
                want.distance_km
            };
            let d_dist = ((got.distance_km - reference_km) / reference_km).abs();
            let gha_dec = d_gha.abs().max(d_dec.abs());
            let limit = claimed(body, labelled);
            if gha_dec.is_nan() || gha_dec > limit {
                failures.push(format!(
                    "{} [{}] {body}: GHA {d_gha:+.5}' Dec {d_dec:+.5}' (published {limit}')",
                    c.utc, c.bin
                ));
            }
            // The Moon's distance is compared geometric to geometric; the planets' and
            // the Sun's are the light-time distance on both sides. Distance only feeds
            // the semidiameter and parallax: 2e-4 of Saturn's is 0.002" of its disc.
            let dist_limit = if labelled { 2e-4 } else { 1e-5 };
            if d_dist.is_nan() || d_dist >= dist_limit {
                failures.push(format!("{} {body}: distance off by {d_dist:.2e}", c.utc));
            }
            for (key, map) in [
                ((c.bin.clone(), body.to_string()), &mut table),
                ((c.tier.clone(), body.to_string()), &mut tier_worst),
            ] {
                let w = map.entry(key).or_default();
                w.gha_dec = w.gha_dec.max(gha_dec);
                w.on_sky = w.on_sky.max(on_sky);
                w.distance = w.distance.max(d_dist);
            }
        }
    }

    // The table ACCURACY.md quotes: worst on-sky direction error per bin, arcseconds.
    println!(
        "| bin | tier | {} |",
        ORDER
            .iter()
            .map(|b| b.to_string())
            .collect::<Vec<_>>()
            .join(" | ")
    );
    println!("|---|---|{}", "---|".repeat(ORDER.len()));
    for (bin, tier) in &bins {
        let row: Vec<String> = ORDER
            .iter()
            .map(|b| format!("{:.2}", table[&(bin.clone(), b.to_string())].on_sky))
            .collect();
        println!("| {bin} | {tier} | {} |", row.join(" | "));
    }
    for tier in ["validated", "labelled"] {
        let row: Vec<String> = ORDER
            .iter()
            .map(|b| {
                let w = tier_worst[&(tier.to_string(), b.to_string())];
                format!(
                    "{b} {:.4}' ({:.2}\", distance {:.1e})",
                    w.gha_dec, w.on_sky, w.distance
                )
            })
            .collect();
        println!("worst GHA/Dec, {tier}: {}", row.join(", "));
    }
    assert!(
        failures.is_empty(),
        "{} failures, first: {:#?}",
        failures.len(),
        &failures[..failures.len().min(12)]
    );
}

/// The 58 stars over both tiers: the model against Skyfield with the same catalogue
/// (radial velocities, alpha Cen A's orbit), and what the catalogue's own formal errors
/// allow at each epoch. The published figures must cover both, Rigil Kentaurus aside
/// (its barycentric proper motion is uncertain beyond its formal errors: ACCURACY.md,
/// "Rigil Kentaurus").
#[test]
fn the_stars_follow_skyfield_and_their_catalogue_over_both_tiers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let text = std::fs::read_to_string(&path).unwrap();
    let file: File = serde_json::from_str(&text).unwrap();
    // bin -> (worst model error ", worst catalogue sigma " without alpha Cen, alpha Cen's).
    let mut rows: Vec<(String, String, f64, f64, f64)> = Vec::new();
    let mut worst_model = [0.0f64; 2];
    let mut worst_total = [0.0f64; 2];
    let mut n = 0;
    for c in &file.cases {
        let Some(stars) = &c.stars else { continue };
        let labelled = c.tier == "labelled";
        let (mut model, mut sigma, mut acen) = (0.0f64, 0.0f64, 0.0f64);
        for (name, [ra, dec, sig]) in stars {
            let entry = catalog::find(name).unwrap_or_else(|| panic!("{name}"));
            let (r, d) = apparent_radec_of_star(entry, c.jd_tt);
            let dra = norm_180(r - ra) * dec.to_radians().cos();
            let sep = dra.hypot(d - dec) * 3600.0;
            model = model.max(sep);
            if name == "Rigil Kentaurus" {
                acen = *sig;
            } else {
                sigma = sigma.max(*sig);
                let k = usize::from(labelled);
                worst_total[k] = worst_total[k].max(sep + sig);
            }
            n += 1;
        }
        let k = usize::from(labelled);
        worst_model[k] = worst_model[k].max(model);
        rows.push((c.bin.clone(), c.tier.clone(), model, sigma, acen));
    }
    assert!(n > 3000, "{n} star cases");
    println!(
        "| bin | tier | model vs Skyfield | catalogue 1-sigma (57 stars) | Rigil Kentaurus 1-sigma |"
    );
    println!("|---|---|---|---|---|");
    for (bin, tier, m, s, a) in &rows {
        println!("| {bin} | {tier} | {m:.3} | {s:.2} | {a:.2} |");
    }
    println!(
        "stars: model worst {:.3}\" validated, {:.3}\" labelled; model + catalogue 1-sigma \
         worst {:.2}\" validated, {:.2}\" labelled",
        worst_model[0], worst_model[1], worst_total[0], worst_total[1]
    );
    // The model reproduces Skyfield's apparent place to far better than the claims.
    assert!(
        worst_model[0] < 0.1 && worst_model[1] < 0.5,
        "{worst_model:?}"
    );
    // The published figures cover model plus the catalogue's 1-sigma, alpha Cen aside.
    assert!(
        worst_total[0] <= STAR_ACCURACY_ARCMIN * 60.0,
        "{worst_total:?}"
    );
    assert!(
        worst_total[1] <= STAR_LABELLED_ACCURACY_ARCMIN * 60.0,
        "{worst_total:?}"
    );
}
