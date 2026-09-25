//! `PlanetProvider` against the independently generated reference fixtures
//! `fixtures/reference/planets_<planet>.json` (`skyfix.reference/1`, CONVENTIONS
//! section 11): Skyfield 1.55 with JPL DE440s, DE421 as a cross-check, 300+ epochs
//! per planet over 1990-2060 including inferior and superior conjunctions, greatest
//! elongations, oppositions, stations and Saturn's ring-plane crossings.
//!
//! What is asserted, per planet:
//!
//! - GHA (DUT1 = 0, against `gha_deg_dut1_zero`) and Dec within the file's
//!   `generator.tolerance_arcmin` (the CONVENTIONS 13.7 target, 0.1') **and** within
//!   the provider's own published figure for that planet
//!   (`planets::ACCURACY_BY_PLANET_ARCMIN`) and its `accuracy_arcmin`, so the coverage
//!   claim the explorer shows is the one this test backs;
//! - the same against the DE421 values, and GHA with each epoch's own DUT1 supplied
//!   against `gha_deg`, which proves `with_dut1_s` is wired in;
//! - illuminated fraction within 0.001 (`generator.tolerances`), phase angle within
//!   0.01 deg, elongation within 0.1', bright-limb angle within what a 0.1' position
//!   error allows at that elongation, distance, semidiameter and horizontal parallax
//!   within 1e-5 relative;
//! - magnitude within 0.01 of `magnitude_heliocentric` (Mallama & Hilton evaluated with
//!   the true Sun, which is this provider's definition) and within the file's 0.1 of
//!   Skyfield's `planetary_magnitude` **except** where the fixture itself shows that
//!   Skyfield's barycentre-for-Sun shortcut moves its own value by more than that; such
//!   cases are counted and printed, not hidden.
//!
//! The fixtures are required: a missing file fails, because the planets' `validated`
//! flag in the explorer rests on this test. Run with `-- --nocapture` for the report.

use std::collections::BTreeMap;

use serde::Deserialize;
use skyfix_core::time::{legacy_fixture_instant, parse_utc};
use skyfix_core::units::norm_180;
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::planets::{
    ACCURACY_ARCMIN, ACCURACY_BY_PLANET_ARCMIN, Planet, PlanetPosition, PlanetProvider,
};

#[derive(Debug, Deserialize)]
struct ReferenceFile {
    schema: String,
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    #[serde(default)]
    tolerance_arcmin: Option<f64>,
    #[serde(default)]
    tolerances: Option<Tolerances>,
}

#[derive(Debug, Deserialize)]
struct Tolerances {
    magnitude: f64,
    illuminated_fraction: f64,
}

#[derive(Debug, Deserialize)]
struct Case {
    utc: String,
    #[serde(default)]
    jd_utc: Option<f64>,
    #[serde(default)]
    dut1_s: Option<f64>,
    #[serde(default)]
    tags: Vec<String>,
    bodies: BTreeMap<String, Body>,
}

#[derive(Debug, Deserialize)]
struct Body {
    gha_deg: f64,
    gha_deg_dut1_zero: f64,
    dec_deg: f64,
    ra_deg: f64,
    distance_au: f64,
    heliocentric_distance_au: f64,
    phase_angle_deg: f64,
    illuminated_fraction: f64,
    elongation_deg: f64,
    bright_limb_angle_deg: f64,
    magnitude: Option<f64>,
    magnitude_heliocentric: Option<f64>,
    semidiameter_arcmin: f64,
    horizontal_parallax_arcmin: f64,
    /// Size of Skyfield's solar light deflection at this epoch, arcseconds.
    sun_deflection_arcsec: f64,
    /// Present when the planet is behind the solar disc: the same apparent place with
    /// no deflection at all.
    #[serde(default)]
    no_deflection: Option<Undeflected>,
    #[serde(default)]
    de421: Option<De421>,
}

#[derive(Debug, Deserialize)]
struct Undeflected {
    gha_deg_dut1_zero: f64,
    dec_deg: f64,
}

/// Skyfield's solar deflection exceeds the limb-grazing 1.75" only when the planet is
/// geometrically behind the solar disc.
const LIMB_DEFLECTION_ARCSEC: f64 = 1.76;

#[derive(Debug, Deserialize)]
struct De421 {
    gha_deg_dut1_zero: f64,
    dec_deg: f64,
}

/// Worst deviation seen for one quantity, and where.
#[derive(Debug, Default, Clone)]
struct Worst {
    value: f64,
    at: String,
}

impl Worst {
    fn see(&mut self, v: f64, at: &str) {
        if v.abs() > self.value {
            self.value = v.abs();
            self.at = at.to_string();
        }
    }
}

#[derive(Debug, Default)]
struct Report {
    cases: usize,
    gha: Worst,
    dec: Worst,
    ra: Worst,
    gha_with_dut1: Worst,
    de421_gha: Worst,
    de421_dec: Worst,
    de421_cases: usize,
    distance_rel: Worst,
    helio_distance_rel: Worst,
    sd_rel: Worst,
    hp_rel: Worst,
    phase_deg: Worst,
    fraction: Worst,
    elongation_arcmin: Worst,
    limb_excess_deg: Worst,
    mag_helio: Worst,
    mag_skyfield: Worst,
    mag_skyfield_within: Worst,
    mag_skyfield_misses: usize,
    mag_skyfield_null: usize,
    /// Epochs with the planet behind the solar disc, judged against `no_deflection`.
    behind_sun: usize,
    behind_sun_vs_undeflected: Worst,
    behind_sun_vs_skyfield: Worst,
    /// Worst GHA/Dec per event tag, arcminutes.
    by_tag: BTreeMap<String, f64>,
    failures: Vec<String>,
}

fn fixture_path(planet: Planet) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(format!(
            "fixtures/reference/planets_{}.json",
            planet.name().to_lowercase()
        ))
}

/// Compare one planet's fixture document. Malformed documents are an `Err`;
/// disagreements land in `report.failures`.
fn compare(planet: Planet, text: &str, label: &str) -> Result<Report, String> {
    let file: ReferenceFile = serde_json::from_str(text)
        .map_err(|e| format!("{label} is not valid skyfix.reference/1 JSON: {e}"))?;
    if file.schema != skyfix_core::types::REFERENCE_SCHEMA {
        return Err(format!("{label} declares schema {:?}", file.schema));
    }
    let tol = file.generator.tolerance_arcmin.ok_or_else(|| {
        format!("{label} records no generator.tolerance_arcmin (CONVENTIONS section 11)")
    })?;
    if !(tol.is_finite() && tol > 0.0) {
        return Err(format!(
            "{label}: tolerance_arcmin must be positive, got {tol}"
        ));
    }
    let tols = file
        .generator
        .tolerances
        .ok_or_else(|| format!("{label} records no generator.tolerances"))?;
    let claimed = ACCURACY_BY_PLANET_ARCMIN
        .iter()
        .find(|(p, _)| *p == planet)
        .map(|(_, a)| *a)
        .ok_or_else(|| format!("no published figure for {planet:?}"))?;

    let plain = PlanetProvider::new();
    let mut r = Report::default();
    for case in &file.cases {
        let Some(b) = case.bodies.get(planet.name()) else {
            continue;
        };
        let at = format!("{} [{}]", case.utc, case.tags.join(","));
        let jd = parse_utc(&case.utc).map_err(|e| format!("{label} {}: {e}", case.utc))?;
        if let Some(rec) = case.jd_utc
            && (rec - jd).abs() > 1e-6
        {
            return Err(format!(
                "{label} {}: jd_utc {rec} disagrees with utc",
                case.utc
            ));
        }
        // timescales agent: the fixture took TT = UTC + 69.184 s and UT1 = UTC after 2035;
        // the clock is UT there now (CONVENTIONS 15.2). Evaluate the fixture's own TT and
        // UT1 (identical up to 2035) until the fixture is regenerated on the new scale.
        let (jd, shift) = legacy_fixture_instant(jd);
        let plain = PlanetProvider::with_dut1_s(plain.dut1_s() + shift);
        let p = plain
            .position(planet, jd)
            .map_err(|e| format!("{label} {}: {e}", case.utc))?;
        r.cases += 1;
        let mut fails: Vec<String> = Vec::new();

        // Directions, arcminutes. GHA is judged on GHA itself (no cos Dec factor).
        let d_gha = norm_180(p.gha_deg - b.gha_deg_dut1_zero) * 60.0;
        let d_dec = (p.dec_deg - b.dec_deg) * 60.0;
        let d_ra = norm_180(p.ra_deg - b.ra_deg) * 60.0;
        let behind_sun = b.sun_deflection_arcsec > LIMB_DEFLECTION_ARCSEC;
        if behind_sun {
            // The planet is hidden by the Sun and Skyfield's deflection is outside the
            // formula's domain (see `planets::deflect_by_sun`). Judge everything but
            // the deflection: against the undeflected place, allowing the provider's
            // capped deflection (at most the limb value) on top of the tolerance.
            r.behind_sun += 1;
            r.behind_sun_vs_skyfield
                .see(d_gha.abs().max(d_dec.abs()), &at);
            let u = b.no_deflection.as_ref().ok_or_else(|| {
                format!(
                    "{label} {}: behind the Sun but no `no_deflection` block",
                    case.utc
                )
            })?;
            let ug = norm_180(p.gha_deg - u.gha_deg_dut1_zero) * 60.0;
            let ud = (p.dec_deg - u.dec_deg) * 60.0;
            r.behind_sun_vs_undeflected.see(ug.abs().max(ud.abs()), &at);
            // The deflection is an angle on the sky; in GHA it grows by 1 / cos Dec.
            let allowed = claimed + LIMB_DEFLECTION_ARCSEC / 60.0 / b.dec_deg.to_radians().cos();
            if ug.abs().max(ud.abs()) > allowed {
                fails.push(format!(
                    "behind the Sun: {ug:.5}'/{ud:.5}' from the undeflected place \
                     (allowed {allowed:.4}')"
                ));
            }
        } else {
            r.gha.see(d_gha, &at);
            r.dec.see(d_dec, &at);
            r.ra.see(d_ra, &at);
            for tag in &case.tags {
                let w = r.by_tag.entry(tag.clone()).or_insert(0.0);
                *w = w.max(d_gha.abs()).max(d_dec.abs());
            }
            for (what, d) in [("GHA", d_gha), ("Dec", d_dec), ("RA", d_ra)] {
                if d.abs() > tol.min(claimed) {
                    fails.push(format!(
                        "{what} off by {:.5}' (target {tol}', published {claimed}')",
                        d.abs()
                    ));
                }
            }
        }
        if let Some(dut1) = case.dut1_s {
            let w = PlanetProvider::with_dut1_s(dut1 + shift)
                .position(planet, jd)
                .map_err(|e| format!("{label} {}: {e}", case.utc))?;
            let d = norm_180(w.gha_deg - b.gha_deg) * 60.0;
            if !behind_sun {
                r.gha_with_dut1.see(d, &at);
            }
            if d.abs() > tol && !behind_sun {
                fails.push(format!("GHA with DUT1 {dut1:+.4} s off by {:.5}'", d.abs()));
            }
        }
        if let Some(x) = b.de421.as_ref().filter(|_| !behind_sun) {
            r.de421_cases += 1;
            let dg = norm_180(p.gha_deg - x.gha_deg_dut1_zero) * 60.0;
            let dd = (p.dec_deg - x.dec_deg) * 60.0;
            r.de421_gha.see(dg, &at);
            r.de421_dec.see(dd, &at);
            if dg.abs().max(dd.abs()) > tol {
                fails.push(format!("DE421 GHA/Dec off by {dg:.5}'/{dd:.5}'"));
            }
        }

        // Distances and what depends on them.
        for (what, got, want, worst) in [
            (
                "distance",
                p.distance_au,
                b.distance_au,
                &mut r.distance_rel,
            ),
            (
                "heliocentric distance",
                p.heliocentric_distance_au,
                b.heliocentric_distance_au,
                &mut r.helio_distance_rel,
            ),
            (
                "semidiameter",
                p.semidiameter_arcmin,
                b.semidiameter_arcmin,
                &mut r.sd_rel,
            ),
            (
                "horizontal parallax",
                p.horizontal_parallax_arcmin,
                b.horizontal_parallax_arcmin,
                &mut r.hp_rel,
            ),
        ] {
            let rel = (got - want) / want;
            worst.see(rel, &at);
            if rel.abs() > 1e-5 {
                fails.push(format!("{what} off by {rel:.2e} relative"));
            }
        }

        // Phase, elongation, bright limb.
        let d_phase = p.phase_angle_deg - b.phase_angle_deg;
        let d_frac = p.illuminated_fraction - b.illuminated_fraction;
        let d_elong = (p.elongation_deg - b.elongation_deg) * 60.0;
        r.phase_deg.see(d_phase, &at);
        r.fraction.see(d_frac, &at);
        if !behind_sun {
            r.elongation_arcmin.see(d_elong, &at);
        }
        if d_phase.abs() > 0.01 {
            fails.push(format!("phase angle off by {d_phase:.5} deg"));
        }
        if d_frac.abs() > tols.illuminated_fraction {
            fails.push(format!("illuminated fraction off by {d_frac:.6}"));
        }
        if d_elong.abs() > tol && !behind_sun {
            fails.push(format!("elongation off by {d_elong:.5}'"));
        }
        let limb_tol = 0.001 + (tol / 60.0) / b.elongation_deg.to_radians().sin();
        let d_limb = norm_180(p.bright_limb_angle_deg - b.bright_limb_angle_deg);
        if !behind_sun {
            r.limb_excess_deg.see(d_limb.abs() / limb_tol, &at);
        }
        if d_limb.abs() > limb_tol && !behind_sun {
            fails.push(format!(
                "bright-limb angle off by {d_limb:.4} deg (allowed {limb_tol:.4})"
            ));
        }

        r.failures
            .extend(fails.into_iter().map(|f| format!("{at}: {f}")));

        // Magnitudes.
        check_magnitude(&p, b, tols.magnitude, &at, &mut r);
    }
    Ok(r)
}

fn check_magnitude(p: &PlanetPosition, b: &Body, tol: f64, at: &str, r: &mut Report) {
    let Some(mine) = p.magnitude else {
        // Every planet has a magnitude everywhere Skyfield has one.
        if b.magnitude.is_some() || b.magnitude_heliocentric.is_some() {
            r.failures
                .push(format!("{at}: no magnitude where the reference has one"));
        }
        return;
    };
    if let Some(h) = b.magnitude_heliocentric {
        let d = mine - h;
        r.mag_helio.see(d, at);
        if d.abs() > 0.01 {
            r.failures.push(format!(
                "{at}: magnitude {mine:.4} vs {h:.4} (same formulas, true Sun)"
            ));
        }
    }
    match b.magnitude {
        None => r.mag_skyfield_null += 1,
        Some(s) => {
            let d = mine - s;
            r.mag_skyfield.see(d, at);
            if d.abs() <= tol {
                r.mag_skyfield_within.see(d, at);
            } else {
                r.mag_skyfield_misses += 1;
                // Allowed only when Skyfield's own two columns disagree by at least as
                // much: the barycentre-for-Sun shortcut, not this model.
                let shortcut = b
                    .magnitude_heliocentric
                    .map(|h| (s - h).abs())
                    .unwrap_or(0.0);
                if shortcut < d.abs() - 0.01 {
                    r.failures.push(format!(
                        "{at}: magnitude {mine:.4} vs Skyfield {s:.4}, not explained by \
                         its barycentric shortcut ({shortcut:.4})"
                    ));
                }
            }
        }
    }
}

fn print_report(planet: Planet, r: &Report) {
    println!("{} ({} epochs)", planet.name(), r.cases);
    for (what, w, unit) in [
        ("GHA (DUT1 = 0)", &r.gha, "'"),
        ("Dec", &r.dec, "'"),
        ("RA", &r.ra, "'"),
        ("GHA (own DUT1)", &r.gha_with_dut1, "'"),
        ("DE421 GHA", &r.de421_gha, "'"),
        ("DE421 Dec", &r.de421_dec, "'"),
        ("elongation", &r.elongation_arcmin, "'"),
        ("phase angle", &r.phase_deg, " deg"),
        ("illum. fraction", &r.fraction, ""),
        ("limb / allowed", &r.limb_excess_deg, ""),
        ("distance (rel)", &r.distance_rel, ""),
        ("helio dist (rel)", &r.helio_distance_rel, ""),
        ("semidiameter (rel)", &r.sd_rel, ""),
        ("HP (rel)", &r.hp_rel, ""),
        ("mag vs true-Sun", &r.mag_helio, ""),
        ("mag vs Skyfield", &r.mag_skyfield, ""),
        ("  where <= 0.1", &r.mag_skyfield_within, ""),
    ] {
        println!("  worst {what:<19} {:>10.6}{unit}  at {}", w.value, w.at);
    }
    println!(
        "  Skyfield magnitude: {} beyond 0.1 (its barycentric Sun), {} null; DE421 on {} epochs",
        r.mag_skyfield_misses, r.mag_skyfield_null, r.de421_cases
    );
    println!(
        "  behind the Sun: {} epochs, worst {:.5}' from the undeflected place, {:.5}' from \
         Skyfield's unbounded deflection (at {})",
        r.behind_sun,
        r.behind_sun_vs_undeflected.value,
        r.behind_sun_vs_skyfield.value,
        r.behind_sun_vs_skyfield.at
    );
    let tags = r
        .by_tag
        .iter()
        .map(|(k, v)| format!("{k} {v:.5}'"))
        .collect::<Vec<_>>()
        .join(", ");
    println!("  worst GHA/Dec by kind: {tags}");
}

#[test]
fn planets_match_the_reference_fixtures() {
    let mut all_failures = Vec::new();
    let mut worst_overall = 0.0f64;
    for planet in Planet::ALL {
        let path = fixture_path(planet);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{} is missing ({e}). The planets' accuracy claim rests on it; regenerate \
                 with tools/reference/.venv/bin/python -m tools.reference.gen_planets",
                path.display()
            )
        });
        let r =
            compare(planet, &text, &path.display().to_string()).unwrap_or_else(|e| panic!("{e}"));
        assert!(r.cases >= 300, "{planet:?}: only {} epochs", r.cases);
        assert!(
            r.de421_cases > 200,
            "{planet:?}: DE421 on {} epochs",
            r.de421_cases
        );
        print_report(planet, &r);
        worst_overall = worst_overall.max(r.gha.value).max(r.dec.value);
        all_failures.extend(r.failures.iter().map(|f| format!("{}: {f}", planet.name())));
    }
    println!("worst GHA/Dec over all planets: {worst_overall:.5}' (claimed {ACCURACY_ARCMIN}')");
    assert!(
        all_failures.is_empty(),
        "{} disagreements:\n  {}",
        all_failures.len(),
        all_failures.join("\n  ")
    );
    // The published group figure must cover the worst planet, and be what coverage()
    // reports, and be inside the target that makes the explorer mark it validated.
    assert!(worst_overall <= ACCURACY_ARCMIN);
    let cov = PlanetProvider::new().coverage();
    assert_eq!(cov.accuracy_arcmin, ACCURACY_ARCMIN);
    assert!(cov.accuracy_arcmin.is_finite() && cov.accuracy_arcmin <= 0.1);
    let largest = ACCURACY_BY_PLANET_ARCMIN
        .iter()
        .map(|(_, a)| *a)
        .fold(0.0, f64::max);
    assert!(largest <= ACCURACY_ARCMIN);
}

// ---------------------------------------------------------------------------
// The comparator itself, on synthetic documents that are wrong by a known amount.
// ---------------------------------------------------------------------------

fn synthetic(body: &str) -> String {
    format!(
        r#"{{"schema":"skyfix.reference/1",
            "generator":{{"tolerance_arcmin":0.1,
                          "tolerances":{{"magnitude":0.1,"illuminated_fraction":0.001}}}},
            "cases":[{{"utc":"2026-03-20T00:00:00Z","tags":["synthetic"],
                       "bodies":{{"Jupiter":{body}}}}}]}}"#
    )
}

fn body_json(p: &PlanetPosition, dgha_deg: f64, dmag: f64) -> String {
    let m = p.magnitude.unwrap();
    format!(
        r#"{{"gha_deg":{},"gha_deg_dut1_zero":{},"dec_deg":{},"ra_deg":{},
            "distance_au":{},"heliocentric_distance_au":{},"phase_angle_deg":{},
            "illuminated_fraction":{},"elongation_deg":{},"bright_limb_angle_deg":{},
            "magnitude":{},"magnitude_heliocentric":{},"semidiameter_arcmin":{},
            "horizontal_parallax_arcmin":{},"sun_deflection_arcsec":0.01}}"#,
        p.gha_deg + dgha_deg,
        p.gha_deg + dgha_deg,
        p.dec_deg,
        p.ra_deg,
        p.distance_au,
        p.heliocentric_distance_au,
        p.phase_angle_deg,
        p.illuminated_fraction,
        p.elongation_deg,
        p.bright_limb_angle_deg,
        m + dmag,
        m + dmag,
        p.semidiameter_arcmin,
        p.horizontal_parallax_arcmin
    )
}

#[test]
fn comparator_passes_the_provider_against_itself_and_flags_known_errors() {
    let jd = parse_utc("2026-03-20T00:00:00Z").unwrap();
    let p = PlanetProvider::new().position(Planet::Jupiter, jd).unwrap();

    let same = compare(
        Planet::Jupiter,
        &synthetic(&body_json(&p, 0.0, 0.0)),
        "self",
    )
    .unwrap();
    assert_eq!(same.cases, 1);
    assert!(same.failures.is_empty(), "{:?}", same.failures);

    // 0.2' of GHA and 0.3 mag, restated across the 360 seam: both must be flagged.
    let wrong = compare(
        Planet::Jupiter,
        &synthetic(&body_json(&p, 0.2 / 60.0 - 360.0, 0.3)),
        "wrong",
    )
    .unwrap();
    assert!(
        wrong
            .failures
            .iter()
            .any(|f| f.contains("GHA off by 0.2000")),
        "{:?}",
        wrong.failures
    );
    assert!(
        wrong.failures.iter().any(|f| f.contains("magnitude")),
        "{:?}",
        wrong.failures
    );
}

#[test]
fn comparator_refuses_a_file_that_does_not_say_what_it_expects() {
    let no_tol = r#"{"schema":"skyfix.reference/1","generator":{},"cases":[]}"#;
    assert!(
        compare(Planet::Mars, no_tol, "x")
            .unwrap_err()
            .contains("tolerance_arcmin")
    );
    let bad_schema =
        r#"{"schema":"skyfix.reference/2","generator":{"tolerance_arcmin":0.1},"cases":[]}"#;
    assert!(
        compare(Planet::Mars, bad_schema, "x")
            .unwrap_err()
            .contains("schema")
    );
}
