//! IGRF-14 against independent calculators (fixtures/reference/geomag_igrf14.json, written
//! by tools/geomag/gen_fixtures.py; never from this code). IAGA's own geocentric test
//! values are checked in `src/reference_tests.rs`.
//!
//! - The British Geological Survey's IGRF-14 calculator (JSON web service) at 25 points
//!   spread over 1900-2030: every continent, both polar regions, the South Atlantic
//!   anomaly, the 1995-2000 change of degree, an aircraft's height and the forecast years
//!   after 2025. The brief asks for 0.1 degree; the service prints D and I to 0.001 degree.
//!   NOAA's own calculator answers only with a registered key, so it was not used.
//! - NOAA's Geomag 7.0 sample output at 2015.0 (+1/365), where IGRF-13 and IGRF-14 share
//!   the definitive 2015 field: printed to 1 arcminute and 0.1 nT.
//!
//! Run with `-- --nocapture` for the table ACCURACY.md quotes.

use serde_json::Value;
use skyfix_geomag::{Model, ModelChoice, field};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/reference/geomag_igrf14.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn num(v: &Value, k: &str) -> f64 {
    v[k].as_f64()
        .unwrap_or_else(|| panic!("{k} missing in {v}"))
}

/// Decimal year of the middle (12:00) of a `YYYY-MM-DD` date, as the BGS service reads it.
fn midday_year(date: &str) -> f64 {
    let p: Vec<i64> = date.split('-').map(|x| x.parse().unwrap()).collect();
    let (y, m, d) = (p[0], p[1], p[2]);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let doy = cum[(m - 1) as usize] + d + if leap && m > 2 { 1 } else { 0 };
    y as f64 + (doy as f64 - 0.5) / if leap { 366.0 } else { 365.0 }
}

fn dang(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 { d - 360.0 } else { d }
}

#[test]
fn the_bgs_calculator_agrees_at_25_points_from_1900_to_2030() {
    let fx = fixture();
    let cases = fx["bgs_calculator"].as_array().unwrap();
    assert!(cases.len() >= 20);
    let (mut wd, mut wi, mut wnt, mut wsv_d, mut wsv_nt): (f64, f64, f64, f64, f64) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    println!("IGRF-14 against the BGS calculator (D and I printed to 0.001 deg, nT to 1):");
    for c in cases {
        let date = c["date"].as_str().unwrap();
        let t = midday_year(date);
        let f = field(
            num(c, "lat_deg"),
            num(c, "lon_deg"),
            num(c, "height_km") * 1000.0,
            t,
            ModelChoice::Igrf14,
        )
        .unwrap();
        assert_eq!(f.model, Model::Igrf14);
        let dd = dang(f.declination_deg, num(c, "d_deg"));
        let di = f.inclination_deg - num(c, "i_deg");
        let mut dnt: f64 = 0.0;
        for (ours, k) in [
            (f.total_nt, "f_nt"),
            (f.horizontal_nt, "h_nt"),
            (f.north_nt, "x_nt"),
            (f.east_nt, "y_nt"),
            (f.down_nt, "z_nt"),
        ] {
            dnt = dnt.max((ours - num(c, k)).abs());
        }
        let sv_d =
            f.annual_change.declination_deg_per_year * 60.0 - num(c, "d_dot_arcmin_per_year");
        let mut sv_nt: f64 = 0.0;
        for (ours, k) in [
            (f.annual_change.total_nt_per_year, "f_dot_nt_per_year"),
            (f.annual_change.north_nt_per_year, "x_dot_nt_per_year"),
            (f.annual_change.east_nt_per_year, "y_dot_nt_per_year"),
            (f.annual_change.down_nt_per_year, "z_dot_nt_per_year"),
            (f.annual_change.horizontal_nt_per_year, "h_dot_nt_per_year"),
        ] {
            sv_nt = sv_nt.max((ours - num(c, k)).abs());
        }
        println!(
            "  {date} {:>7.2} {:>8.2} {:>5.1} km  D {:>9.3} (ours {:>9.4}, {:+.4})  I {:+.4}  nT {:.2}",
            num(c, "lat_deg"),
            num(c, "lon_deg"),
            num(c, "height_km"),
            num(c, "d_deg"),
            f.declination_deg,
            dd,
            di,
            dnt
        );
        wd = wd.max(dd.abs());
        wi = wi.max(di.abs());
        wnt = wnt.max(dnt);
        wsv_d = wsv_d.max(sv_d.abs());
        wsv_nt = wsv_nt.max(sv_nt);
    }
    println!(
        "  worst: D {wd:.4} deg, I {wi:.4} deg, intensities {wnt:.2} nT, \
         rate of D {wsv_d:.3} arcmin/yr, rates {wsv_nt:.3} nT/yr"
    );
    // The brief: 0.1 degree. Measured: the calculator's own printing (0.0005 degree, 0.5 nT).
    assert!(wd < 0.1 && wi < 0.1);
    assert!(wd < 0.0015, "declination {wd}");
    assert!(wi < 0.0015, "inclination {wi}");
    assert!(wnt < 1.0, "intensities {wnt}");
    assert!(wsv_d < 0.06, "rate of declination {wsv_d}");
    assert!(wsv_nt < 0.06, "rates {wsv_nt}");
}

#[test]
fn noaas_geomag70_sample_output_agrees_at_2015() {
    let fx = fixture();
    let cases = fx["noaa_geomag70_2015"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    for c in cases {
        let f = field(
            num(c, "lat_deg"),
            num(c, "lon_deg"),
            num(c, "height_km") * 1000.0,
            num(c, "year"),
            ModelChoice::Igrf14,
        )
        .unwrap();
        // D and I printed to 1 arcminute; nT to 0.1 (plus 0.003 nT from IGRF-13's rate).
        assert!(
            dang(f.declination_deg, num(c, "d_deg")).abs() < 0.5 / 60.0 + 1e-9,
            "{c}"
        );
        assert!(
            (f.inclination_deg - num(c, "i_deg")).abs() < 0.5 / 60.0 + 1e-9,
            "{c}"
        );
        for (ours, k) in [
            (f.total_nt, "f_nt"),
            (f.horizontal_nt, "h_nt"),
            (f.north_nt, "x_nt"),
            (f.east_nt, "y_nt"),
            (f.down_nt, "z_nt"),
        ] {
            assert!(
                (ours - num(c, k)).abs() < 0.06,
                "{k}: {ours} vs {}",
                num(c, k)
            );
        }
    }
}

#[test]
fn the_auto_model_switches_to_wmm2025_without_a_jump_worth_showing() {
    // At 2025.0 the two models are different fits; at a mid-latitude place they agree to
    // well inside either model's stated uncertainty, so the switch is not a visible step.
    for (lat, lon) in [(39.95, -75.17), (-33.9, 18.4), (51.5, -0.1), (35.7, 139.7)] {
        let before = field(lat, lon, 0.0, 2024.9999, ModelChoice::Auto).unwrap();
        let after = field(lat, lon, 0.0, 2025.0, ModelChoice::Auto).unwrap();
        assert_eq!(before.model, Model::Igrf14);
        assert_eq!(after.model, Model::Wmm2025);
        let step = dang(after.declination_deg, before.declination_deg).abs();
        assert!(step < 0.1, "{lat} {lon}: {step}");
        assert!(step < after.uncertainty.declination_deg / 3.0);
    }
}
