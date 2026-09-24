//! `topocentric::horizontal` against `fixtures/reference/moon_topocentric.json`
//! (Skyfield + JPL DE440s, `skyfix.reference/1`).
//!
//! The fixture is built with **UT1 = UTC** (each instant on a Skyfield timescale whose
//! Delta-T is `32.184 s + (TAI - UTC)` of its leap-second era), so it is the same
//! Earth orientation `Sky::new()` uses (CONVENTIONS 6 and 13.2): no DUT1 term hides in
//! the comparison. Bodies: the Moon at 600 site-instants (12 sites: the equator, the
//! tropics, 60+ degrees north and south, 2000 m, the antimeridian), plus the Sun and
//! four stars whenever they are above -2 degrees at the same instant.
//!
//! What is compared: the topocentric **geometric** altitude (parallax, no refraction)
//! and the azimuth. Skyfield also applies diurnal aberration (up to 0.32") and the
//! observer's own light-time; `horizontal` models neither, both far below the 0.1'
//! target of CONVENTIONS 13.7. Azimuth is judged on the sky (`dAz cos(alt)`) for every
//! case and as a raw angle below 70 degrees of altitude, where `1 / cos(alt) < 3`.
//!
//! Run with `-- --nocapture` for the worst cases.

use std::collections::BTreeMap;

use serde::Deserialize;
use skyfix_core::time::parse_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::{BodyEphemeris, BodyKind, Sky};
use skyfix_ephemeris::topocentric::{Site, horizontal};

const FIXTURE: &str = "fixtures/reference/moon_topocentric.json";
/// Raw azimuth is judged only below this altitude (see the module docs).
const RAW_AZIMUTH_MAX_ALT_DEG: f64 = 70.0;

#[derive(Debug, Deserialize)]
struct ReferenceFile {
    schema: String,
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    tolerance_arcmin: f64,
}

#[derive(Debug, Deserialize)]
struct Case {
    utc: String,
    jd_utc: f64,
    site: FixtureSite,
    bodies: BTreeMap<String, Body>,
}

#[derive(Debug, Deserialize)]
struct FixtureSite {
    name: String,
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
}

#[derive(Debug, Deserialize)]
struct Body {
    alt_deg: f64,
    az_deg: f64,
}

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
struct Stats {
    n: usize,
    alt: Worst,
    az_on_sky: Worst,
    az_raw: Worst,
}

fn kind_label(k: BodyKind) -> &'static str {
    match k {
        BodyKind::Moon => "Moon",
        BodyKind::Sun => "Sun",
        BodyKind::Planet => "planet",
        BodyKind::Star => "star",
    }
}

/// `|d| <= limit`, false for NaN, so a NaN never passes silently.
fn within(d: f64, limit: f64) -> bool {
    d.abs() <= limit
}

fn compare(text: &str) -> Result<(BTreeMap<&'static str, Stats>, Vec<String>), String> {
    let file: ReferenceFile =
        serde_json::from_str(text).map_err(|e| format!("{FIXTURE} is not valid JSON: {e}"))?;
    if file.schema != skyfix_core::types::REFERENCE_SCHEMA {
        return Err(format!("{FIXTURE} declares schema {:?}", file.schema));
    }
    let tol = file.generator.tolerance_arcmin;
    if !(tol > 0.0 && tol.is_finite()) {
        return Err(format!(
            "{FIXTURE}: tolerance_arcmin must be positive, got {tol}"
        ));
    }
    let sky = Sky::new();
    let mut stats: BTreeMap<&'static str, Stats> = BTreeMap::new();
    let mut failures = Vec::new();
    for case in &file.cases {
        let jd = parse_utc(&case.utc).map_err(|e| format!("{}: {e}", case.utc))?;
        if (jd - case.jd_utc).abs() > 1e-6 {
            return Err(format!("{}: jd_utc does not match the timestamp", case.utc));
        }
        let site = Site {
            lat_deg: case.site.lat_deg,
            lon_deg: case.site.lon_deg,
            height_m: case.site.height_m,
            ..Site::default()
        };
        for (name, want) in &case.bodies {
            let st = sky
                .apparent_state(name, jd)
                .map_err(|e| format!("{} {name}: {e}", case.utc))?;
            let h = horizontal(&st, &site);
            let at = format!("{name} at {} {}", case.site.name, case.utc);
            let d_alt = (h.alt_deg - want.alt_deg) * 60.0;
            let d_az = norm_180(h.az_deg - want.az_deg) * 60.0;
            let d_az_sky = d_az * want.alt_deg.to_radians().cos();
            let s = stats.entry(kind_label(st.kind)).or_default();
            s.n += 1;
            s.alt.see(d_alt, &at);
            s.az_on_sky.see(d_az_sky, &at);
            if want.alt_deg < RAW_AZIMUTH_MAX_ALT_DEG {
                s.az_raw.see(d_az, &at);
                if !within(d_az, tol) {
                    failures.push(format!("{at}: azimuth off by {:.4}'", d_az.abs()));
                }
            }
            if !within(d_alt, tol) {
                failures.push(format!("{at}: altitude off by {:.4}'", d_alt.abs()));
            }
            if !within(d_az_sky, tol) {
                failures.push(format!(
                    "{at}: azimuth x cos(alt) off by {:.4}'",
                    d_az_sky.abs()
                ));
            }
        }
    }
    Ok((stats, failures))
}

#[test]
fn topocentric_alt_az_match_skyfield() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("{FIXTURE} is missing ({e}); regenerate it with tools/reference/gen_moon.py")
    });
    let (stats, failures) = compare(&text).unwrap_or_else(|e| panic!("{e}"));
    let moon = stats.get("Moon").map_or(0, |s| s.n);
    assert!(moon >= 500, "only {moon} Moon cases");
    println!("{FIXTURE}:");
    for (kind, s) in &stats {
        println!(
            "  {kind:<5} {:>5} cases: worst alt {:.5}' ({:.3}\") at {}",
            s.n,
            s.alt.value,
            s.alt.value * 60.0,
            s.alt.at
        );
        println!(
            "        worst az x cos(alt) {:.5}' ({:.3}\") at {}",
            s.az_on_sky.value,
            s.az_on_sky.value * 60.0,
            s.az_on_sky.at
        );
        println!(
            "        worst raw az below {RAW_AZIMUTH_MAX_ALT_DEG} deg {:.5}' ({:.3}\") at {}",
            s.az_raw.value,
            s.az_raw.value * 60.0,
            s.az_raw.at
        );
    }
    assert!(
        failures.is_empty(),
        "{} topocentric disagreements:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}
