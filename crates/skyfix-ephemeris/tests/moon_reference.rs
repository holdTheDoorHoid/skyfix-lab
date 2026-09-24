//! `MoonProvider` against the independently generated reference
//! `fixtures/reference/moon_geocentric.json` (`skyfix.reference/1`, CONVENTIONS section
//! 11): Skyfield with JPL DE440s at about 1750 instants over 1990-2060 — random,
//! perigees and apogees, declination extremes including the major standstills.
//!
//! Judged at the file's own `generator.tolerances`, which are the CONVENTIONS 13.7
//! targets (GHA and Dec 0.1', HP 0.05', illuminated fraction 0.001), **and** at the
//! provider's declared `accuracy_arcmin`, so the number the explorer shows is backed
//! by this test.
//!
//! GHA is compared with `gha_deg_dut1_zero` (UT1 = UTC, CONVENTIONS section 6). One
//! case in ten is also re-run with the case's own DUT1 through
//! `MoonProvider::with_dut1_s` against `gha_deg`, which proves the DUT1 input is
//! applied rather than ignored.
//!
//! Run with `-- --nocapture` to see the worst deviation of every quantity.

use serde::Deserialize;
use skyfix_core::time::parse_utc;
use skyfix_core::units::norm_180;
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::body::BodyEphemeris;
use skyfix_ephemeris::moon::MoonProvider;

const FIXTURE: &str = "fixtures/reference/moon_geocentric.json";

#[derive(Debug, Deserialize)]
struct ReferenceFile {
    schema: String,
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    #[serde(default)]
    tolerances: Option<Tolerances>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct Tolerances {
    gha_dec_arcmin: f64,
    horizontal_parallax_arcmin: f64,
    illuminated_fraction: f64,
}

#[derive(Debug, Deserialize)]
struct Case {
    utc: String,
    jd_utc: f64,
    dut1_s: f64,
    set: String,
    moon: Moon,
}

#[derive(Debug, Deserialize)]
struct Moon {
    gha_deg: f64,
    gha_deg_dut1_zero: f64,
    dec_deg: f64,
    ra_deg: f64,
    ecliptic_longitude_deg: f64,
    ecliptic_latitude_deg: f64,
    distance_km: f64,
    horizontal_parallax_arcmin: f64,
    semidiameter_arcmin: f64,
    phase_angle_deg: f64,
    illuminated_fraction: f64,
    elongation_deg: f64,
    bright_limb_angle_deg: f64,
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
struct Report {
    checked: usize,
    gha: Worst,
    gha_on_sky: Worst,
    gha_with_dut1: Worst,
    dut1_cases: usize,
    dec: Worst,
    ra: Worst,
    ecl_lon: Worst,
    ecl_lat: Worst,
    distance_km: Worst,
    hp: Worst,
    sd: Worst,
    phase_angle_deg: Worst,
    fraction: Worst,
    elongation_deg: Worst,
    limb_deg: Worst,
    limb_cases: usize,
    /// Worst on-sky direction error (arcmin) per instant set.
    by_set: std::collections::BTreeMap<String, (usize, f64)>,
    failures: Vec<String>,
}

/// Limits beyond the CONVENTIONS 13.7 targets, for quantities the targets do not name.
/// Each is justified where it is used.
const ELONGATION_TOL_DEG: f64 = 0.1 / 60.0;
/// Skyfield's phase angle is built from astrometric directions (the Moon's includes
/// the Earth's motion over the light time, the Sun's has no aberration); this
/// provider's comes from the apparent directions. The two definitions differ by up to
/// twice the constant of aberration, 41", which moves the illuminated fraction by at
/// most 1e-4. The limit is that plus margin; the fraction has its own, tighter check.
const PHASE_ANGLE_TOL_DEG: f64 = 0.02;
/// Only judged between 5 and 175 degrees of elongation, where a 1" position error
/// moves the position angle by at most 11".
const LIMB_TOL_DEG: f64 = 0.01;
const LIMB_MIN_ELONGATION_DEG: f64 = 5.0;
/// Distance is judged by its effect on HP (0.05' is 340 km); this is a sanity bound.
const DISTANCE_TOL_KM: f64 = 2.0;

/// `|d| <= limit`, false for NaN, so a NaN never passes silently.
fn within(d: f64, limit: f64) -> bool {
    d.abs() <= limit
}

fn compare(text: &str, label: &str, provider: &MoonProvider) -> Result<Report, String> {
    let file: ReferenceFile = serde_json::from_str(text)
        .map_err(|e| format!("{label} is not valid skyfix.reference/1 JSON: {e}"))?;
    if file.schema != skyfix_core::types::REFERENCE_SCHEMA {
        return Err(format!("{label} declares schema {:?}", file.schema));
    }
    let tol = file.generator.tolerances.ok_or_else(|| {
        format!("{label} records no generator.tolerances; this test will not invent them")
    })?;
    let declared = provider.coverage().accuracy_arcmin;
    let angle_tol = tol.gha_dec_arcmin.min(declared);
    let mut r = Report::default();
    for (i, case) in file.cases.iter().enumerate() {
        let jd = parse_utc(&case.utc)
            .map_err(|e| format!("{label} case {}: bad timestamp: {e}", case.utc))?;
        if (jd - case.jd_utc).abs() > 1e-6 {
            return Err(format!(
                "{label} case {}: jd_utc {} does not match the timestamp ({jd})",
                case.utc, case.jd_utc
            ));
        }
        let st = provider
            .apparent_state("Moon", jd)
            .map_err(|e| format!("{label} case {}: {e}", case.utc))?;
        let pos = provider
            .position(jd)
            .map_err(|e| format!("{label} case {}: {e}", case.utc))?;
        let m = &case.moon;
        let at = format!("{} ({})", case.utc, case.set);
        r.checked += 1;
        let mut fail = |what: &str, d: f64, limit: f64, unit: &str| {
            if !within(d, limit) {
                r.failures.push(format!(
                    "{at}: {what} off by {:.5}{unit} (limit {limit}{unit})",
                    d.abs()
                ));
            }
        };

        let d_gha = norm_180(st.gha_deg - m.gha_deg_dut1_zero) * 60.0;
        let d_dec = (st.dec_deg - m.dec_deg) * 60.0;
        let on_sky = (d_gha * m.dec_deg.to_radians().cos()).hypot(d_dec);
        r.gha.see(d_gha, &at);
        r.gha_on_sky.see(d_gha * m.dec_deg.to_radians().cos(), &at);
        r.dec.see(d_dec, &at);
        fail("GHA (DUT1 = 0)", d_gha, angle_tol, "'");
        fail("Dec", d_dec, angle_tol, "'");
        let e = r.by_set.entry(case.set.clone()).or_insert((0, 0.0));
        e.0 += 1;
        e.1 = e.1.max(on_sky);

        let d_ra = norm_180(st.ra_deg - m.ra_deg) * 60.0;
        r.ra.see(d_ra, &at);
        fail("RA", d_ra, angle_tol, "'");
        let d_lon = norm_180(pos.ecliptic_longitude_deg - m.ecliptic_longitude_deg) * 60.0;
        let d_lat = (pos.ecliptic_latitude_deg - m.ecliptic_latitude_deg) * 60.0;
        r.ecl_lon.see(d_lon, &at);
        r.ecl_lat.see(d_lat, &at);
        fail("ecliptic longitude", d_lon, angle_tol, "'");
        fail("ecliptic latitude", d_lat, angle_tol, "'");

        let d_km = st.distance_km.unwrap_or(f64::NAN) - m.distance_km;
        r.distance_km.see(d_km, &at);
        fail("distance", d_km, DISTANCE_TOL_KM, " km");
        let d_hp = st.horizontal_parallax_arcmin - m.horizontal_parallax_arcmin;
        r.hp.see(d_hp, &at);
        fail("HP", d_hp, tol.horizontal_parallax_arcmin, "'");
        let d_sd = st.semidiameter_arcmin - m.semidiameter_arcmin;
        r.sd.see(d_sd, &at);
        fail("SD", d_sd, tol.horizontal_parallax_arcmin, "'");

        let d_phase = st.phase_angle_deg.unwrap_or(f64::NAN) - m.phase_angle_deg;
        r.phase_angle_deg.see(d_phase, &at);
        fail("phase angle", d_phase, PHASE_ANGLE_TOL_DEG, " deg");
        let d_k = st.illuminated_fraction.unwrap_or(f64::NAN) - m.illuminated_fraction;
        r.fraction.see(d_k, &at);
        fail("illuminated fraction", d_k, tol.illuminated_fraction, "");
        let d_el = st.elongation_deg.unwrap_or(f64::NAN) - m.elongation_deg;
        r.elongation_deg.see(d_el, &at);
        fail("elongation", d_el, ELONGATION_TOL_DEG, " deg");
        if (LIMB_MIN_ELONGATION_DEG..=180.0 - LIMB_MIN_ELONGATION_DEG).contains(&m.elongation_deg) {
            let d_limb =
                norm_180(st.bright_limb_angle_deg.unwrap_or(f64::NAN) - m.bright_limb_angle_deg);
            r.limb_deg.see(d_limb, &at);
            r.limb_cases += 1;
            fail("bright limb angle", d_limb, LIMB_TOL_DEG, " deg");
        }

        if i % 10 == 0 {
            let with = MoonProvider::with_dut1_s(case.dut1_s)
                .position(jd)
                .map_err(|e| format!("{label} case {}: {e}", case.utc))?;
            let d = norm_180(with.gha_deg - m.gha_deg) * 60.0;
            r.dut1_cases += 1;
            r.gha_with_dut1.see(d, &at);
            fail("GHA with the case's DUT1", d, angle_tol, "'");
        }
    }
    Ok(r)
}

#[test]
fn moon_matches_the_reference_fixture() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(FIXTURE);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{FIXTURE} is missing ({e}); regenerate it with tools/reference/gen_moon.py. The \
             Moon provider's accuracy claim rests on it."
        )
    });
    let provider = MoonProvider::new();
    let r = compare(&text, FIXTURE, &provider).unwrap_or_else(|e| panic!("{e}"));
    assert!(r.checked >= 1500, "only {} instants checked", r.checked);

    println!("{FIXTURE}: {} instants", r.checked);
    for (what, w, unit, scale) in [
        ("GHA (DUT1 = 0)", &r.gha, "'", 60.0),
        ("GHA x cos(Dec)", &r.gha_on_sky, "'", 60.0),
        ("GHA (DUT1 supplied)", &r.gha_with_dut1, "'", 60.0),
        ("Dec", &r.dec, "'", 60.0),
        ("RA", &r.ra, "'", 60.0),
        ("ecliptic longitude", &r.ecl_lon, "'", 60.0),
        ("ecliptic latitude", &r.ecl_lat, "'", 60.0),
        ("HP", &r.hp, "'", 60.0),
        ("SD", &r.sd, "'", 60.0),
        ("distance", &r.distance_km, " km", f64::NAN),
        ("phase angle", &r.phase_angle_deg, " deg", 3600.0),
        ("illuminated fraction", &r.fraction, "", f64::NAN),
        ("elongation", &r.elongation_deg, " deg", 3600.0),
        ("bright limb angle", &r.limb_deg, " deg", 3600.0),
    ] {
        if scale.is_nan() {
            println!("  worst {what:<22} {:.5}{unit}  at {}", w.value, w.at);
        } else {
            println!(
                "  worst {what:<22} {:.5}{unit} ({:.3}\")  at {}",
                w.value,
                w.value * scale,
                w.at
            );
        }
    }
    println!(
        "  {} instants re-run with their own DUT1; bright limb judged at {} instants",
        r.dut1_cases, r.limb_cases
    );
    for (set, (n, worst)) in &r.by_set {
        println!(
            "  set {set:<8} {n:>5} instants, worst on-sky error {:.5}' ({:.3}\")",
            worst,
            worst * 60.0
        );
    }
    assert!(
        r.failures.is_empty(),
        "{} disagreements with {FIXTURE}:\n  {}",
        r.failures.len(),
        r.failures.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// The comparator itself, on synthetic documents that are wrong on purpose.
// ---------------------------------------------------------------------------

fn doc(generator: &str, cases: &str) -> String {
    format!(r#"{{"schema":"skyfix.reference/1","generator":{generator},"cases":[{cases}]}}"#)
}

fn case_from_provider(utc: &str, tweak: impl Fn(&mut serde_json::Value)) -> String {
    let jd = parse_utc(utc).unwrap();
    let p = MoonProvider::new();
    let st = p.apparent_state("Moon", jd).unwrap();
    let pos = p.position(jd).unwrap();
    let mut v = serde_json::json!({
        "utc": utc, "jd_utc": jd, "dut1_s": 0.0, "set": "synthetic",
        "moon": {
            "gha_deg": st.gha_deg, "gha_deg_dut1_zero": st.gha_deg, "dec_deg": st.dec_deg,
            "ra_deg": st.ra_deg, "ecliptic_longitude_deg": pos.ecliptic_longitude_deg,
            "ecliptic_latitude_deg": pos.ecliptic_latitude_deg,
            "distance_km": st.distance_km.unwrap(),
            "horizontal_parallax_arcmin": st.horizontal_parallax_arcmin,
            "semidiameter_arcmin": st.semidiameter_arcmin,
            "phase_angle_deg": st.phase_angle_deg.unwrap(),
            "illuminated_fraction": st.illuminated_fraction.unwrap(),
            "elongation_deg": st.elongation_deg.unwrap(),
            "bright_limb_angle_deg": st.bright_limb_angle_deg.unwrap()
        }
    });
    tweak(&mut v);
    v.to_string()
}

const TOLS: &str = r#"{"tolerances":{"gha_dec_arcmin":0.1,"horizontal_parallax_arcmin":0.05,"illuminated_fraction":0.001}}"#;

#[test]
fn comparator_passes_the_provider_itself_and_flags_wrong_values() {
    let good = case_from_provider("2026-10-01T01:30:00Z", |_| {});
    let r = compare(&doc(TOLS, &good), "synthetic", &MoonProvider::new()).unwrap();
    assert!(r.failures.is_empty(), "{:?}", r.failures);

    let bad = case_from_provider("2026-10-01T01:30:00Z", |v| {
        let m = &mut v["moon"];
        m["gha_deg_dut1_zero"] = (m["gha_deg_dut1_zero"].as_f64().unwrap() + 0.2 / 60.0).into();
        m["dec_deg"] = (m["dec_deg"].as_f64().unwrap() - 0.2 / 60.0).into();
        m["horizontal_parallax_arcmin"] =
            (m["horizontal_parallax_arcmin"].as_f64().unwrap() + 0.06).into();
        m["illuminated_fraction"] = (m["illuminated_fraction"].as_f64().unwrap() + 0.002).into();
    });
    let r = compare(&doc(TOLS, &bad), "synthetic", &MoonProvider::new()).unwrap();
    for what in ["GHA (DUT1 = 0)", "Dec", "HP", "illuminated fraction"] {
        assert!(
            r.failures
                .iter()
                .any(|f| f.contains(&format!(": {what} off"))),
            "{what} not flagged: {:?}",
            r.failures
        );
    }
}

#[test]
fn comparator_compares_gha_across_the_360_seam_and_refuses_bad_files() {
    // The same hour angle restated 360 degrees away, plus 0.02'.
    let seam = case_from_provider("2031-05-17T08:00:00Z", |v| {
        let g = v["moon"]["gha_deg_dut1_zero"].as_f64().unwrap();
        v["moon"]["gha_deg_dut1_zero"] = (g - 360.0 + 0.02 / 60.0).into();
    });
    let r = compare(&doc(TOLS, &seam), "synthetic", &MoonProvider::new()).unwrap();
    assert!((r.gha.value - 0.02).abs() < 1e-6, "{}", r.gha.value);

    let good = case_from_provider("2026-10-01T01:30:00Z", |_| {});
    let e = compare(
        &doc(r#"{"tool":"x"}"#, &good),
        "synthetic",
        &MoonProvider::new(),
    )
    .unwrap_err();
    assert!(e.contains("tolerances"), "{e}");
    let bad_jd = case_from_provider("2026-10-01T01:30:00Z", |v| v["jd_utc"] = 2_461_000.0.into());
    let e = compare(&doc(TOLS, &bad_jd), "synthetic", &MoonProvider::new()).unwrap_err();
    assert!(e.contains("jd_utc"), "{e}");
}

/// Cost of one evaluation. Not a pass/fail test (timings depend on the machine); run
/// `cargo test --release -p skyfix-ephemeris --test moon_reference -- --ignored --nocapture`.
#[test]
#[ignore = "timing report, run on demand in a release build"]
fn moon_evaluation_timing() {
    let p = MoonProvider::new();
    let start = parse_utc("2026-01-01T00:00:00Z").unwrap();
    let n = 20_000;
    // Warm up the embedded-data parse, which happens once per process.
    let t = std::time::Instant::now();
    p.position(start).unwrap();
    let first = t.elapsed();
    let mut sink = 0.0;
    let t = std::time::Instant::now();
    for i in 0..n {
        sink += p.position(start + f64::from(i) * 0.013).unwrap().gha_deg;
    }
    let pos = t.elapsed() / n;
    let t = std::time::Instant::now();
    for i in 0..n {
        sink += p
            .apparent_state("Moon", start + f64::from(i) * 0.013)
            .unwrap()
            .dec_deg;
    }
    let state = t.elapsed() / n;
    println!(
        "first call (parses the embedded series) {first:?}; position {pos:?}; \
         apparent_state (adds the Sun and illumination) {state:?}  [{sink:.1}]"
    );
}

// ---------------------------------------------------------------------------
// USNO's Celestial Navigation Data API, the other independent source
// ---------------------------------------------------------------------------

const USNO_FIXTURE: &str = "fixtures/reference/usno_celnav_2026-10-01T0130Z.json";

/// USNO's celnav Moon equals Skyfield's DE440s apparent Moon evaluated with its time
/// argument this many seconds later (GAST unchanged), to 0.003" on the sky. Found at
/// development time by a one-parameter search against Skyfield, never against this
/// crate. Stars and GHA Aries cannot show such an offset (10 s moves them by
/// microarcseconds), which is why they agree with USNO to 0.006".
const USNO_MOON_TIME_ARGUMENT_OFFSET_S: f64 = 10.36;

#[test]
fn moon_agrees_with_usno_once_its_time_argument_is_allowed_for() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(USNO_FIXTURE);
    let text = std::fs::read_to_string(&path).expect("the USNO fixture is committed");
    let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
    let moon = doc["usno_response"]["properties"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["object"] == "Moon")
        .expect("USNO returned the Moon");
    let usno_gha = moon["almanac_data"]["gha"].as_f64().unwrap();
    let usno_dec = moon["almanac_data"]["dec"].as_f64().unwrap();

    let jd = parse_utc("2026-10-01T01:30:00Z").unwrap();
    let p = MoonProvider::new();
    let at = p.position(jd).unwrap();
    // As is: USNO's time argument costs it 6.7" of GHA.
    let d_gha = norm_180(at.gha_deg - usno_gha) * 60.0;
    let d_dec = (at.dec_deg - usno_dec) * 60.0;
    // With USNO's time argument: the Moon's place 10.36 s later, the same GAST.
    let later = p
        .position(jd + USNO_MOON_TIME_ARGUMENT_OFFSET_S / 86_400.0)
        .unwrap();
    let gha_later = (at.gast_deg - later.ra_deg).rem_euclid(360.0);
    let d_gha_later = norm_180(gha_later - usno_gha) * 60.0;
    let d_dec_later = (later.dec_deg - usno_dec) * 60.0;
    println!(
        "USNO celnav Moon 2026-10-01T01:30Z: ours minus USNO GHA {d_gha:+.4}' Dec {d_dec:+.4}'; \
         with USNO's time argument (+{USNO_MOON_TIME_ARGUMENT_OFFSET_S} s) GHA \
         {d_gha_later:+.4}' Dec {d_dec_later:+.4}'"
    );
    // The documented discrepancy, bounded so a change in either side is noticed.
    assert!(
        (0.08..0.14).contains(&d_gha) && d_dec.abs() < 0.03,
        "{d_gha} {d_dec}"
    );
    // Allowing for it, USNO and this provider agree inside the declared accuracy.
    let declared = p.coverage().accuracy_arcmin;
    assert!(
        d_gha_later.abs() <= declared && d_dec_later.abs() <= declared,
        "{d_gha_later}' {d_dec_later}' vs {declared}'"
    );
}
