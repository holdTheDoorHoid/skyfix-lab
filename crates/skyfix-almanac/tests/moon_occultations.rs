//! Lunar occultations against Skyfield's own topocentric geometry
//! (`fixtures/reference/moon_occultations.json`, `tools/moon/gen_reference.py`: JPL
//! DE440s, Hipparcos, mean limb, UT1 = UTC) and against published predictions
//! (`fixtures/reference/moon_occultations_published.json`, transcribed by hand).
//!
//! Target (EXPANSION_PLAN P8): contacts within 30 s of Skyfield. Near a graze a contact's
//! time is hypersensitive (1″ of position moves it by tens of seconds), so events whose
//! body passes within 1′ of the limb are held instead to their least limb distance and to
//! being flagged as grazes, and their contact times are reported.

use std::path::PathBuf;

use skyfix_almanac::occultations::{
    OccultationOptions, OccultationTarget, StarTarget, navigational_star_targets, occultations,
    planet_targets,
};
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::planets::PlanetProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::Site;

fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn f(v: &serde_json::Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} missing in {v}"))
}

fn wrap(d: f64) -> f64 {
    (d + 540.0).rem_euclid(360.0) - 180.0
}

/// The target a fixture event names: a navigational star or planet from the engine's own
/// lists, any other star from the catalogue place the fixture used.
fn target_of(e: &serde_json::Value) -> OccultationTarget {
    let body = e["body"].as_str().unwrap();
    let from = |list: Vec<OccultationTarget>| list.into_iter().find(|t| t.name() == body);
    if e["kind"] == "planet" {
        return from(planet_targets()).unwrap();
    }
    if e["navigational"].as_bool().unwrap() {
        return from(navigational_star_targets()).unwrap();
    }
    let c = &e["catalogue"];
    OccultationTarget::Star(StarTarget {
        name: body.to_string(),
        designation: None,
        hr: None,
        magnitude: f(c, "magnitude"),
        ra_j2000_deg: f(c, "ra_j2000_deg"),
        dec_j2000_deg: f(c, "dec_j2000_deg"),
        pm_ra_cosdec_mas_yr: f(c, "pm_ra_cosdec_mas_yr"),
        pm_dec_mas_yr: f(c, "pm_dec_mas_yr"),
        parallax_mas: f(c, "parallax_mas"),
        navigational: false,
    })
}

fn site_of(o: &serde_json::Value) -> Site {
    Site {
        height_m: o["height_m"].as_f64().unwrap_or(0.0),
        ..Site::new(f(o, "lat_deg"), f(o, "lon_deg"))
    }
}

#[test]
fn contacts_match_skyfields_topocentric_geometry() {
    let fx = fixture("moon_occultations.json");
    let events = fx["events"].as_array().unwrap();
    assert!(events.len() >= 12);
    let (m, s, p) = (
        MoonProvider::new(),
        SunProvider::new(),
        PlanetProvider::new(),
    );
    let options = OccultationOptions {
        include_below_horizon: true,
        include_near_misses: true,
    };
    let (mut worst_s, mut worst_pa, mut worst_alt, mut worst_sun) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut n_normal, mut n_graze) = (0, 0);
    let mut graze_report = Vec::new();
    for e in events {
        let site = site_of(&e["observer"]);
        let cs = e["contacts"].as_array().unwrap();
        let (d_ref, r_ref) = (&cs[0], &cs[1]);
        let jd = f(d_ref, "jd_utc");
        let target = target_of(e);
        let list = occultations(
            &m,
            &s,
            &p,
            &site,
            jd - 0.5,
            jd + 0.5,
            std::slice::from_ref(&target),
            &options,
        )
        .unwrap();
        let body = e["body"].as_str().unwrap();
        let got = list
            .events
            .iter()
            .find(|x| x.body == body)
            .unwrap_or_else(|| panic!("{body} at {} not found: {list:?}", e["site"]));
        let least = f(e, "least_limb_distance_arcmin_sampled");
        let d = got.disappearance.as_ref().expect("a disappearance");
        let r = got.reappearance.as_ref().expect("a reappearance");
        let dt_d = (d.jd_utc - f(d_ref, "jd_utc")) * 86_400.0;
        let dt_r = (r.jd_utc - f(r_ref, "jd_utc")) * 86_400.0;
        if least > -1.0 {
            // A graze by the 1' rule: flagged, and the same shallow chord.
            n_graze += 1;
            assert!(got.graze, "{body} at {} should be a graze", e["site"]);
            assert!(
                (got.closest.limb_distance_arcmin - least).abs() < 0.1,
                "{body}: least limb distance {} vs {least} (sampled every 2 min)",
                got.closest.limb_distance_arcmin
            );
            graze_report.push(format!(
                "{body} {} ({least:+.2}'): D {dt_d:+.1} s, R {dt_r:+.1} s",
                e["site"].as_str().unwrap()
            ));
            continue;
        }
        n_normal += 1;
        assert!(!got.graze && got.occulted, "{body} at {}", e["site"]);
        for (c, rf, dt) in [(d, d_ref, dt_d), (r, r_ref, dt_r)] {
            worst_s = worst_s.max(dt.abs());
            worst_pa = worst_pa.max(wrap(c.position_angle_deg - f(rf, "position_angle_deg")).abs());
            worst_alt = worst_alt.max((c.moon_alt_deg - f(rf, "moon_alt_deg")).abs());
            worst_sun = worst_sun.max((c.sun_alt_deg - f(rf, "sun_alt_deg")).abs());
        }
    }
    eprintln!(
        "occultations vs Skyfield topocentric geometry, {n_normal} events (48 contacts): \
         worst time {worst_s:.2} s, position angle {worst_pa:.3} deg, Moon altitude \
         {worst_alt:.4} deg, Sun altitude {worst_sun:.4} deg; {n_graze} grazes flagged, \
         contacts {}",
        graze_report.join("; ")
    );
    assert!(n_normal >= 12);
    assert!(worst_s < 30.0, "{worst_s} s");
    assert!(worst_pa < 0.5 && worst_alt < 0.02 && worst_sun < 0.02);
}

#[test]
fn contacts_agree_with_published_predictions() {
    let fx = fixture("moon_occultations_published.json");
    let (m, s, p) = (
        MoonProvider::new(),
        SunProvider::new(),
        PlanetProvider::new(),
    );
    let options = OccultationOptions {
        include_below_horizon: true,
        include_near_misses: true,
    };
    let mut lines = Vec::new();
    for e in fx["events"].as_array().unwrap() {
        let body = e["body"].as_str().unwrap();
        let target = navigational_star_targets()
            .into_iter()
            .chain(planet_targets())
            .find(|t| t.name() == body)
            .unwrap();
        for place in e["places"].as_array().unwrap() {
            let site = site_of(place);
            let jd = f(place, "disappearance_jd_utc");
            let list = occultations(
                &m,
                &s,
                &p,
                &site,
                jd - 0.3,
                jd + 0.3,
                std::slice::from_ref(&target),
                &options,
            )
            .unwrap();
            let got = list.events.iter().find(|x| x.body == body).unwrap();
            let tol = f(place, "tolerance_s");
            for (kind, key, label) in [
                (&got.disappearance, "disappearance_jd_utc", "D"),
                (&got.reappearance, "reappearance_jd_utc", "R"),
            ] {
                let c = kind.as_ref().unwrap();
                let dt = (c.jd_utc - f(place, key)) * 86_400.0;
                lines.push(format!(
                    "{body} {} {label} {dt:+.0} s",
                    place["name"].as_str().unwrap()
                ));
                assert!(
                    dt.abs() <= tol,
                    "{body} at {}: {key} differs by {dt:.1} s (tolerance {tol} s)",
                    place["name"]
                );
            }
        }
    }
    eprintln!("against published predictions: {}", lines.join("; "));
}
