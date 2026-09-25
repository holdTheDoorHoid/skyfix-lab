//! WMM2025 against NOAA NCEI's official test values (fixtures/reference/geomag_wmm2025.json,
//! written by tools/geomag/gen_fixtures.py from the published files; never from this code).
//!
//! - The 100 rows of `WMM2025_TestValues.txt`: X, Y, Z, H, F and their rates to six
//!   decimals, D and I to 0.01 degree, dD/dt and dI/dt to six decimals.
//! - Table 6 of the technical report: 12 rows to 0.1 nT and 0.01 degree.
//! - The report's high-precision numerical example (its geodetic answers; the
//!   intermediate quantities are checked in `src/reference_tests.rs`).
//!
//! The report's licence to use the name WMM2025 (section 1.10) is agreement with the model
//! equations within 0.1 nT and 0.1 nT/yr between 89.992 S and 89.992 N; the brief asks for
//! 0.01 degree on every published declination and inclination.
//!
//! Run with `-- --nocapture` for the table ACCURACY.md quotes.

use serde_json::Value;
use skyfix_geomag::{Model, ModelChoice, field};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/reference/geomag_wmm2025.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn num(v: &Value, k: &str) -> f64 {
    v[k].as_f64()
        .unwrap_or_else(|| panic!("{k} missing in {v}"))
}

#[derive(Default)]
struct Worst {
    rows: Vec<(String, f64)>,
}

impl Worst {
    fn see(&mut self, name: &str, diff: f64) {
        match self.rows.iter_mut().find(|(n, _)| n == name) {
            Some((_, w)) => *w = w.max(diff.abs()),
            None => self.rows.push((name.to_string(), diff.abs())),
        }
    }
    fn get(&self, name: &str) -> f64 {
        self.rows.iter().find(|(n, _)| n == name).unwrap().1
    }
    fn print(&self, title: &str) {
        println!("{title}");
        for (n, w) in &self.rows {
            println!("  {n:<28} worst |diff| {w:.3e}");
        }
    }
}

/// Angle difference folded into (-180, 180].
fn dang(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 { d - 360.0 } else { d }
}

#[test]
fn every_official_test_value_is_reproduced() {
    let fx = fixture();
    let rows = fx["test_values"].as_array().unwrap();
    assert_eq!(rows.len(), 100);
    let mut w = Worst::default();
    for r in rows {
        let t = num(r, "year");
        let f = field(
            num(r, "lat_deg"),
            num(r, "lon_deg"),
            num(r, "height_km") * 1000.0,
            t,
            ModelChoice::Wmm2025,
        )
        .unwrap();
        assert_eq!(f.model, Model::Wmm2025);
        for (name, ours, theirs) in [
            ("X nT", f.north_nt, num(r, "x_nt")),
            ("Y nT", f.east_nt, num(r, "y_nt")),
            ("Z nT", f.down_nt, num(r, "z_nt")),
            ("H nT", f.horizontal_nt, num(r, "h_nt")),
            ("F nT", f.total_nt, num(r, "f_nt")),
            (
                "dX/dt nT/yr",
                f.annual_change.north_nt_per_year,
                num(r, "x_dot_nt_per_year"),
            ),
            (
                "dY/dt nT/yr",
                f.annual_change.east_nt_per_year,
                num(r, "y_dot_nt_per_year"),
            ),
            (
                "dZ/dt nT/yr",
                f.annual_change.down_nt_per_year,
                num(r, "z_dot_nt_per_year"),
            ),
            (
                "dH/dt nT/yr",
                f.annual_change.horizontal_nt_per_year,
                num(r, "h_dot_nt_per_year"),
            ),
            (
                "dF/dt nT/yr",
                f.annual_change.total_nt_per_year,
                num(r, "f_dot_nt_per_year"),
            ),
        ] {
            w.see(name, ours - theirs);
        }
        // Published to 0.01 degree.
        w.see(
            "D deg (printed 0.01)",
            dang(f.declination_deg, num(r, "d_deg")),
        );
        w.see("I deg (printed 0.01)", f.inclination_deg - num(r, "i_deg"));
        // The same angles from the file's six-decimal X, Y, Z: our D and I exactly.
        let d_exact = num(r, "y_nt").atan2(num(r, "x_nt")).to_degrees();
        let i_exact = num(r, "z_nt").atan2(num(r, "h_nt")).to_degrees();
        w.see("D deg (from file X, Y)", dang(f.declination_deg, d_exact));
        w.see("I deg (from file H, Z)", f.inclination_deg - i_exact);
        w.see(
            "dD/dt deg/yr",
            f.annual_change.declination_deg_per_year - num(r, "d_dot_deg_per_year"),
        );
        w.see(
            "dI/dt deg/yr",
            f.annual_change.inclination_deg_per_year - num(r, "i_dot_deg_per_year"),
        );
    }
    w.print("WMM2025 against its 100 official test values:");
    // Y and Z agree to a few micro-nT. X (and so H and F) differs by up to 7.2e-4 nT, with
    // Z moving by sin(psi) of that: the file's own X' carries noise of about 1e-8 of the
    // field, while its Y' and Z' and the report's high-precision example (Table 3b, where
    // X agrees to 1e-6 nT) do not; our dP/dtheta satisfies the exact identity to 1e-12
    // (`sh::tests`). 7e-4 nT is 140 times inside the WMM label tolerance of 0.1 nT.
    for (n, limit) in [
        ("X nT", 1e-3),
        ("Y nT", 1e-5),
        ("Z nT", 1e-5),
        ("H nT", 1e-3),
        ("F nT", 1e-3),
    ] {
        assert!(w.get(n) < limit, "{n}: {}", w.get(n));
    }
    for n in [
        "dX/dt nT/yr",
        "dY/dt nT/yr",
        "dZ/dt nT/yr",
        "dH/dt nT/yr",
        "dF/dt nT/yr",
    ] {
        assert!(w.get(n) < 1e-4, "{n}: {}", w.get(n));
    }
    // Printed to 0.01: agreement to half the last digit (the brief: within 0.01 degree).
    assert!(w.get("D deg (printed 0.01)") <= 0.005 + 1e-9);
    assert!(w.get("I deg (printed 0.01)") <= 0.005 + 1e-9);
    assert!(w.get("D deg (from file X, Y)") < 5e-6);
    assert!(w.get("I deg (from file H, Z)") < 5e-6);
    assert!(w.get("dD/dt deg/yr") < 1e-5);
    assert!(w.get("dI/dt deg/yr") < 1e-5);
}

#[test]
fn table_6_of_the_technical_report_is_reproduced() {
    let fx = fixture();
    let rows = fx["table6"].as_array().unwrap();
    assert_eq!(rows.len(), 12);
    let mut w = Worst::default();
    for r in rows {
        let f = field(
            num(r, "lat_deg"),
            num(r, "lon_deg"),
            num(r, "height_km") * 1000.0,
            num(r, "year"),
            ModelChoice::Wmm2025,
        )
        .unwrap();
        for (name, ours, theirs) in [
            ("X nT", f.north_nt, num(r, "x_nt")),
            ("Y nT", f.east_nt, num(r, "y_nt")),
            ("Z nT", f.down_nt, num(r, "z_nt")),
            ("H nT", f.horizontal_nt, num(r, "h_nt")),
            ("F nT", f.total_nt, num(r, "f_nt")),
            (
                "dX/dt",
                f.annual_change.north_nt_per_year,
                num(r, "x_dot_nt_per_year"),
            ),
            (
                "dY/dt",
                f.annual_change.east_nt_per_year,
                num(r, "y_dot_nt_per_year"),
            ),
            (
                "dZ/dt",
                f.annual_change.down_nt_per_year,
                num(r, "z_dot_nt_per_year"),
            ),
            (
                "dH/dt",
                f.annual_change.horizontal_nt_per_year,
                num(r, "h_dot_nt_per_year"),
            ),
            (
                "dF/dt",
                f.annual_change.total_nt_per_year,
                num(r, "f_dot_nt_per_year"),
            ),
        ] {
            w.see(name, ours - theirs);
        }
        w.see("D deg", dang(f.declination_deg, num(r, "d_deg")));
        w.see("I deg", f.inclination_deg - num(r, "i_deg"));
        w.see(
            "dD/dt deg/yr",
            f.annual_change.declination_deg_per_year - num(r, "d_dot_deg_per_year"),
        );
        w.see(
            "dI/dt deg/yr",
            f.annual_change.inclination_deg_per_year - num(r, "i_dot_deg_per_year"),
        );
    }
    w.print("WMM2025 against Table 6 of the technical report:");
    // Printed to 0.1 nT, 0.1 nT/yr and 0.01 degree.
    for (n, _) in &w.rows {
        let limit = if n.contains("deg") { 0.005 } else { 0.05 };
        assert!(w.get(n) <= limit + 1e-9, "{n}: {}", w.get(n));
    }
}

#[test]
fn the_numerical_example_gives_the_published_answers() {
    let fx = fixture();
    let e = &fx["numerical_example"];
    let f = field(
        num(e, "lat_deg"),
        num(e, "lon_deg"),
        num(e, "height_km") * 1000.0,
        num(e, "year"),
        ModelChoice::Wmm2025,
    )
    .unwrap();
    let close = |ours: f64, theirs: f64, tol: f64, what: &str| {
        assert!((ours - theirs).abs() < tol, "{what}: {ours} vs {theirs}");
    };
    close(f.north_nt, num(e, "x_nt"), 1e-6, "X");
    close(f.east_nt, num(e, "y_nt"), 1e-6, "Y");
    close(f.down_nt, num(e, "z_nt"), 1e-6, "Z");
    close(f.horizontal_nt, num(e, "h_nt"), 1e-6, "H");
    close(f.total_nt, num(e, "f_nt"), 1e-6, "F");
    close(f.declination_deg.to_radians(), num(e, "d_rad"), 1e-10, "D");
    close(f.inclination_deg.to_radians(), num(e, "i_rad"), 1e-10, "I");
    close(
        f.annual_change.north_nt_per_year,
        num(e, "x_dot_nt_per_year"),
        1e-8,
        "Xdot",
    );
    close(
        f.annual_change.down_nt_per_year,
        num(e, "z_dot_nt_per_year"),
        1e-8,
        "Zdot",
    );
    close(
        f.annual_change.total_nt_per_year,
        num(e, "f_dot_nt_per_year"),
        1e-8,
        "Fdot",
    );
    close(
        f.annual_change.horizontal_nt_per_year,
        num(e, "h_dot_nt_per_year"),
        1e-8,
        "Hdot",
    );
    close(
        f.annual_change.declination_deg_per_year.to_radians(),
        num(e, "d_dot_rad_per_year"),
        1e-10,
        "Ddot",
    );
    close(
        f.annual_change.inclination_deg_per_year.to_radians(),
        num(e, "i_dot_rad_per_year"),
        1e-10,
        "Idot",
    );
}
