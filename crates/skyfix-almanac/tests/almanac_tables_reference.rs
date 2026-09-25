//! The almanac tables against an independent computation and against the published ones.
//!
//! 1. `fixtures/reference/almanac_tables.json` (`tools/reference/gen_almanac_tables.py`):
//!    the same definitions coded again in Python with other algorithms (exact fractions,
//!    root-finding for critical boundaries, Skyfield and DE440s for Polaris and the
//!    planets). Every formula-only table must print identically; Polaris and the planets
//!    may differ by one unit in the last place where the two ephemerides straddle a
//!    rounding threshold.
//! 2. `fixtures/reference/almanac_tables_published.json`: the values Bowditch's worked
//!    examples read from the printed Nautical Almanac 2016 and 2024, and the 2016 Polaris
//!    page. The printed tables use another refraction model and another Polaris mean
//!    position, so each value must be within 0.1′ (one unit) and the statistics are
//!    printed; Polaris' a1 and azimuth must be identical and a0 + a2 within 0.1′.
//!
//! `cargo test -p skyfix-almanac --test almanac_tables_reference -- --nocapture` prints
//! every comparison.

mod common;

use common::load_fixture;
use serde_json::Value;
use skyfix_almanac::tables::altitude::{
    AltitudeTables, Conditions, ZONE_LETTERS, additional_correction_arcmin, altitude_tables,
    density_factor, zone_of_factor,
};
use skyfix_almanac::tables::planets::{PlanetCorrections, jd_of};
use skyfix_almanac::tables::polaris::a0_arcmin;
use skyfix_almanac::tables::{
    CriticalTable, PolarisTable, arc_to_time, fmt_deg_min_tenths, increments, planet_corrections,
    polaris_table, tenths_half_up,
};
use skyfix_core::calendar::Calendar;
use skyfix_ephemeris::body::Sky;

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// `50 26.6` / `-0 12.3` (degrees and minutes) to degrees; `0.9` to the number.
fn deg_min(text: &str) -> f64 {
    let neg = text.starts_with('-');
    let p: Vec<f64> = text
        .trim_start_matches('-')
        .split(' ')
        .map(|x| x.parse().unwrap())
        .collect();
    let v = p[0] + p.get(1).copied().unwrap_or(0.0) / 60.0;
    if neg { -v } else { v }
}

/// A printed correction or angle in arcminutes (`+15.3`, `0 54.9`).
fn arcmin_of(text: &str) -> f64 {
    if text.contains(' ') {
        deg_min(text) * 60.0
    } else {
        text.parse().unwrap()
    }
}

fn table_by_name<'a>(t: &'a AltitudeTables, name: &str) -> &'a CriticalTable {
    match name {
        "stars_planets" => &t.stars_planets,
        "sun_oct_mar" => &t.sun_oct_mar,
        "sun_apr_sep" => &t.sun_apr_sep,
        other => panic!("no table {other}"),
    }
}

fn compare_critical(ours: &CriticalTable, reference: &Value, what: &str) {
    let b: Vec<&str> = ours.boundaries.iter().map(|x| x.printed.as_str()).collect();
    let rb: Vec<&str> = reference["boundaries"]
        .as_array()
        .unwrap()
        .iter()
        .map(s)
        .collect();
    assert_eq!(b, rb, "{what}: boundaries");
    let v: Vec<Vec<&str>> = ours
        .values
        .iter()
        .map(|r| r.iter().map(|c| c.printed.as_str()).collect())
        .collect();
    let rv: Vec<Vec<&str>> = reference["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_array().unwrap().iter().map(s).collect())
        .collect();
    assert_eq!(v, rv, "{what}: values");
}

// ---------------------------------------------------------------------------
// 1. The independent Python computation
// ---------------------------------------------------------------------------

#[test]
fn formula_tables_print_identically_to_the_independent_computation() {
    let f = load_fixture("almanac_tables.json");
    let mut cells = 0usize;
    // Increments and v or d.
    for page in f["increments"].as_array().unwrap() {
        let m = page["minute"].as_u64().unwrap() as u32;
        let ours = increments(m).unwrap();
        for (sec, row) in page["rows"].as_array().unwrap().iter().enumerate() {
            let r = &ours.rows[sec];
            let got = [&r.sun_planets.printed, &r.aries.printed, &r.moon.printed];
            for (k, want) in row.as_array().unwrap().iter().enumerate() {
                assert_eq!(got[k], s(want), "increments {m}m {sec}s column {k}");
                cells += 1;
            }
        }
        for (v, want) in page["corrections"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                ours.corrections[v].correction.printed,
                s(want),
                "{m}m v {v}"
            );
            cells += 1;
        }
    }
    // Arc to time.
    let at = arc_to_time();
    for (d, want) in f["arc_to_time"]["degrees"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        assert_eq!(at.degrees[d].printed, s(want));
        cells += 1;
    }
    for (m, row) in f["arc_to_time"]["arcminutes"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        for (q, want) in row.as_array().unwrap().iter().enumerate() {
            assert_eq!(at.arcminutes[m].printed[q], s(want));
            cells += 1;
        }
    }
    // Altitude corrections.
    let t = altitude_tables(None).unwrap();
    let a = &f["altitude"];
    compare_critical(&t.sun_oct_mar, &a["sun_oct_mar"], "Sun Oct-Mar");
    compare_critical(&t.sun_apr_sep, &a["sun_apr_sep"], "Sun Apr-Sep");
    compare_critical(&t.stars_planets, &a["stars_planets"], "stars and planets");
    compare_critical(&t.dip.metres, &a["dip_metres"], "dip (m)");
    compare_critical(&t.dip.feet, &a["dip_feet"], "dip (ft)");
    cells += [
        &t.sun_oct_mar,
        &t.sun_apr_sep,
        &t.stars_planets,
        &t.dip.metres,
        &t.dip.feet,
    ]
    .iter()
    .map(|c| c.boundaries.len() + c.values.iter().map(Vec::len).sum::<usize>())
    .sum::<usize>();
    for (row, want) in t.low.iter().zip(a["low"].as_array().unwrap()) {
        let want: Vec<&str> = want.as_array().unwrap().iter().map(s).collect();
        let got = [
            row.printed_alt.as_str(),
            &row.sun_oct_mar[0].printed,
            &row.sun_oct_mar[1].printed,
            &row.sun_apr_sep[0].printed,
            &row.sun_apr_sep[1].printed,
            &row.stars_planets.printed,
        ];
        assert_eq!(got.to_vec(), want, "0-10 table");
        cells += 6;
    }
    assert_eq!(t.low.len(), a["low"].as_array().unwrap().len());
    for (row, want) in t
        .additional
        .rows
        .iter()
        .zip(a["additional"].as_array().unwrap())
    {
        let got: Vec<&str> = row.corrections.iter().map(|c| c.printed.as_str()).collect();
        let want: Vec<&str> = want.as_array().unwrap().iter().map(s).collect();
        assert_eq!(got, want, "non-standard conditions at {}", row.printed_alt);
        cells += got.len();
    }
    // The Moon: every entry of both parts.
    let mut moon_diff = Vec::new();
    for (col, want) in t.moon.columns.iter().zip(a["moon"].as_array().unwrap()) {
        for (part, ours, theirs) in [
            ("upper", &col.upper, &want["upper"]),
            ("L", &col.lower_limb, &want["lower_limb"]),
            ("U", &col.upper_limb, &want["upper_limb"]),
        ] {
            for (k, (o, w)) in ours.iter().zip(theirs.as_array().unwrap()).enumerate() {
                cells += 1;
                if o.printed != s(w) {
                    moon_diff.push(format!(
                        "{} {part}[{k}] {} vs {}",
                        col.from_deg,
                        o.printed,
                        s(w)
                    ));
                }
            }
        }
    }
    assert!(moon_diff.is_empty(), "Moon table: {moon_diff:?}");
    eprintln!("formula tables: {cells} printed values identical to the independent computation");
}

#[test]
fn polaris_and_the_planets_agree_with_skyfield() {
    let f = load_fixture("almanac_tables.json");
    let eph = Sky::new();
    for (year, reference) in f["polaris"].as_object().unwrap() {
        let year: i64 = year.parse().unwrap();
        let t = polaris_table(&eph, year, Calendar::Gregorian).unwrap();
        let (sha0, dec0) = (
            reference["mean_sha_deg"].as_f64().unwrap(),
            reference["mean_dec_deg"].as_f64().unwrap(),
        );
        let d_sha = (t.mean_sha_deg - sha0) * 60.0;
        let d_dec = (t.mean_dec_deg - dec0) * 3600.0;
        let (mut same, mut total, mut worst) = (0usize, 0usize, 0.0f64);
        for (c, want) in t
            .columns
            .iter()
            .zip(reference["columns"].as_array().unwrap())
        {
            let pairs = [
                (&c.a0, &want["a0"]),
                (&c.a1, &want["a1"]),
                (&c.a2, &want["a2"]),
            ];
            for (ours, theirs) in pairs {
                for (o, w) in ours.iter().zip(theirs.as_array().unwrap()) {
                    total += 1;
                    let d = (arcmin_of(&o.printed) - arcmin_of(s(w))).abs();
                    worst = worst.max(d);
                    same += usize::from(o.printed == s(w));
                }
            }
            for (o, w) in c.azimuth.iter().zip(want["azimuth"].as_array().unwrap()) {
                total += 1;
                let d = (o.printed.parse::<f64>().unwrap() - s(w).parse::<f64>().unwrap()).abs();
                worst = worst.max(d.min(360.0 - d) * 60.0 / 6.0);
                same += usize::from(o.printed == s(w));
            }
        }
        eprintln!(
            "Polaris {year}: mean SHA {:+.4}' Dec {:+.4}\" from Skyfield's; {same} of {total} \
             printed values identical, worst difference {worst:.2} units",
            d_sha, d_dec
        );
        assert!(d_sha.abs() < 0.05 && d_dec.abs() < 0.05, "mean position");
        assert!(worst <= 0.1 + 1e-9, "Polaris {year}: worst {worst}");
        assert!(same * 100 >= total * 99, "Polaris {year}: {same}/{total}");
    }
    // Venus and Mars: the daily parallax and the runs.
    let p = &f["planets"];
    let year = p["year"].as_i64().unwrap();
    let ours = planet_corrections(&eph, year, Calendar::Gregorian).unwrap();
    for (name, list) in [("Venus", &ours.venus), ("Mars", &ours.mars)] {
        let theirs = p[name].as_array().unwrap();
        let hp_ref = p[format!("{name}_daily_hp_arcmin")].as_array().unwrap();
        // Our daily parallax, rebuilt from the provider.
        let start = jd_of(Calendar::Gregorian, year, 1, 1);
        let mut worst: f64 = 0.0;
        let mut straddles = 0;
        for (k, h) in hp_ref.iter().enumerate() {
            let st =
                skyfix_ephemeris::body::BodyEphemeris::apparent_state(&eph, name, start + k as f64)
                    .unwrap();
            let h = h.as_f64().unwrap();
            worst = worst.max((st.horizontal_parallax_arcmin - h).abs());
            if tenths_half_up(st.horizontal_parallax_arcmin) != tenths_half_up(h) {
                straddles += 1;
            }
        }
        eprintln!(
            "{name} {year}: daily HP within {worst:.5}' of Skyfield's; {} runs (reference {}), \
             {straddles} days round differently",
            list.len(),
            theirs.len()
        );
        // verify2: 1e-4' (measured under 0.000005'; ACCURACY.md 0.00001'). With 0.001' a
        // regression in HP created straddles, and the comparison below switched itself
        // off; the fixture's year has none, so it now always runs.
        assert!(worst < 1e-4, "{name}: {worst}");
        assert_eq!(straddles, 0, "{name}: days whose HP rounds differently");
        assert_eq!(list.len(), theirs.len());
        for (o, w) in list.iter().zip(theirs) {
            assert_eq!(format!("{:.1}", o.hp_arcmin), s(&w["hp"]));
            compare_critical(&o.table, &w["table"], name);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. The published tables (Bowditch's worked examples)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Tally {
    same: usize,
    total: usize,
    lines: Vec<String>,
}

impl Tally {
    fn add(&mut self, what: &str, ours: &str, published: &str, source: &str) {
        let d = (arcmin_of(ours) - arcmin_of(published)).abs();
        self.total += 1;
        self.same += usize::from((d * 10.0).round() == 0.0);
        self.lines.push(format!(
            "  {:<40} ours {:>8}  printed {:>8}  {}  ({source})",
            what,
            ours,
            published,
            if (d * 10.0).round() == 0.0 {
                "="
            } else {
                "≠"
            }
        ));
        assert!(
            d <= 0.1 + 1e-9,
            "{what}: ours {ours}, printed {published} ({source})"
        );
    }
}

/// Linear interpolation of printed values, rounded half up to 0.1 as a navigator would.
fn interpolate(x0: f64, v0: f64, x1: f64, v1: f64, x: f64) -> f64 {
    tenths_half_up(v0 + (x - x0) / (x1 - x0) * (v1 - v0)) as f64 / 10.0
}

#[test]
fn the_published_examples() {
    let f = load_fixture("almanac_tables_published.json");
    let t = altitude_tables(None).unwrap();
    let eph = Sky::new();
    let mut tally = Tally::default();
    for e in f["increments"].as_array().unwrap() {
        let m = e["minute"].as_u64().unwrap() as u32;
        let sec = e["second"].as_u64().unwrap() as usize;
        let row = &increments(m).unwrap().rows[sec];
        let ours = match s(&e["column"]) {
            "aries" => &row.aries,
            "moon" => &row.moon,
            _ => &row.sun_planets,
        };
        tally.add(
            &format!("increment {m}m {sec:02}s {}", s(&e["column"])),
            &ours.printed,
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    for e in f["v_or_d"].as_array().unwrap() {
        let m = e["minute"].as_u64().unwrap() as u32;
        let v = e["v"].as_f64().unwrap();
        let ours = &increments(m).unwrap().corrections[(v * 10.0).round() as usize].correction;
        tally.add(
            &format!("v or d {v} at {m}m"),
            &ours.printed,
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    for e in f["arc_to_time"].as_array().unwrap() {
        let m = e["arcmin"].as_u64().unwrap() as usize;
        let q = e["quarter"].as_u64().unwrap() as usize;
        assert_eq!(arc_to_time().arcminutes[m].printed[q], s(&e["printed"]));
    }
    for e in f["critical"].as_array().unwrap() {
        let table = table_by_name(&t, s(&e["table"]));
        let col = e["column"].as_u64().unwrap() as usize;
        let ours = &table.lookup(deg_min(s(&e["ha"]))).unwrap()[col];
        tally.add(
            &format!("{} {} Ha {}", s(&e["table"]), col, s(&e["ha"])),
            &ours.printed,
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    for e in f["dip_feet"].as_array().unwrap() {
        let h = e["height_ft"].as_f64().unwrap();
        let ours = &t.dip.feet.lookup(h).unwrap()[0];
        tally.add(
            &format!("dip {h} ft"),
            &ours.printed,
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    for e in f["low"].as_array().unwrap() {
        let ha = deg_min(s(&e["ha"]));
        let value = |r: &skyfix_almanac::tables::altitude::LowRow| -> f64 {
            let cell = match s(&e["column"]) {
                "sun_oct_mar_lower" => &r.sun_oct_mar[0],
                "sun_apr_sep_lower" => &r.sun_apr_sep[0],
                _ => &r.stars_planets,
            };
            cell.printed.parse().unwrap()
        };
        let k = t.low.iter().rposition(|r| r.alt_deg <= ha).unwrap();
        let (a, b) = (&t.low[k], &t.low[k + 1]);
        let ours = if s(&e["rule"]) == "nearest" {
            if ha - a.alt_deg <= b.alt_deg - ha {
                value(a)
            } else {
                value(b)
            }
        } else {
            interpolate(a.alt_deg, value(a), b.alt_deg, value(b), ha)
        };
        tally.add(
            &format!("0-10 {} Ha {}", s(&e["column"]), s(&e["ha"])),
            &format!("{ours:+.1}"),
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    for e in f["additional_exact"].as_array().unwrap() {
        let t_c = (e["temperature_f"].as_f64().unwrap() - 32.0) / 1.8;
        let p = e["pressure_inhg"].as_f64().unwrap() * 33.863_889;
        let v = additional_correction_arcmin(deg_min(s(&e["ha"])), density_factor(t_c, p));
        tally.add(
            &format!("T and P exact, Ha {}", s(&e["ha"])),
            &format!("{:+.1}", tenths_half_up(v) as f64 / 10.0),
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    // The zone table: our zones are our own (module docs); Bowditch 2016's case is zone M
    // in both, and its value must agree. The 2024 cases are printed for information.
    for e in f["additional_zone"].as_array().unwrap() {
        let t_c = (e["temperature_f"].as_f64().unwrap() - 32.0) / 1.8;
        let p = e["pressure_hpa"]
            .as_f64()
            .unwrap_or_else(|| e["pressure_inhg"].as_f64().unwrap() * 33.863_889);
        let zone = zone_of_factor(density_factor(t_c, p)).unwrap();
        let ha = deg_min(s(&e["ha"]));
        let rows = &t.additional.rows;
        let k = rows.iter().rposition(|r| r.alt_deg <= ha).unwrap();
        let v = |r: usize| -> f64 { rows[r].corrections[zone].printed.parse().unwrap() };
        let ours = interpolate(rows[k].alt_deg, v(k), rows[k + 1].alt_deg, v(k + 1), ha);
        let line = format!(
            "  zone {} Ha {}: ours {ours:+.1}, printed {} (printed zone {})  ({})",
            ZONE_LETTERS[zone],
            s(&e["ha"]),
            s(&e["printed"]),
            e["zone"].as_str().unwrap_or("not stated"),
            s(&e["source"])
        );
        if let Some(z) = e["zone"].as_str() {
            assert_eq!(ZONE_LETTERS[zone], z);
            assert!(
                (ours - arcmin_of(s(&e["printed"]))).abs() <= 0.1 + 1e-9,
                "{line}"
            );
        }
        tally.lines.push(line);
    }
    for e in f["moon"].as_array().unwrap() {
        let ours = match s(&e["part"]) {
            "upper" => {
                let row = deg_min(s(&e["row"]));
                let col = &t.moon.columns[(row / 5.0).floor() as usize];
                let k = ((row - f64::from(col.from_deg)) * 6.0).round() as usize;
                col.upper[k].printed.clone()
            }
            part => {
                let col = &t.moon.columns[e["column_from_deg"].as_u64().unwrap() as usize / 5];
                let list = if part == "L" {
                    &col.lower_limb
                } else {
                    &col.upper_limb
                };
                let hp = e["hp"].as_f64().unwrap();
                let k = t
                    .moon
                    .hp_rows
                    .iter()
                    .rposition(|&h| h <= hp + 1e-9)
                    .unwrap();
                let v = |i: usize| -> f64 { list[i].printed.parse().unwrap() };
                if (t.moon.hp_rows[k] - hp).abs() < 1e-9 {
                    format!("{:.1}", v(k))
                } else {
                    format!(
                        "{:.1}",
                        interpolate(t.moon.hp_rows[k], v(k), t.moon.hp_rows[k + 1], v(k + 1), hp)
                    )
                }
            }
        };
        tally.add(
            &format!(
                "Moon {} {}",
                s(&e["part"]),
                e.get("row").and_then(Value::as_str).unwrap_or("")
            ),
            &ours,
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    let mut planets: Vec<PlanetCorrections> = Vec::new();
    for e in f["venus_mars"].as_array().unwrap() {
        let date = s(&e["date"]);
        let year: i64 = date[..4].parse().unwrap();
        if !planets.iter().any(|p| p.year == year) {
            planets.push(planet_corrections(&eph, year, Calendar::Gregorian).unwrap());
        }
        let pc = planets.iter().find(|p| p.year == year).unwrap();
        let (m, d): (u32, u32) = (date[5..7].parse().unwrap(), date[8..10].parse().unwrap());
        let jd = jd_of(Calendar::Gregorian, year, m, d);
        let list = if s(&e["body"]) == "Venus" {
            &pc.venus
        } else {
            &pc.mars
        };
        let period = list
            .iter()
            .find(|p| p.from_jd_utc <= jd && jd <= p.to_jd_utc)
            .unwrap();
        let ours = &period.table.lookup(deg_min(s(&e["ha"]))).unwrap()[0];
        tally.add(
            &format!("{} {date} Ha {}", s(&e["body"]), s(&e["ha"])),
            &ours.printed,
            s(&e["printed"]),
            s(&e["source"]),
        );
    }
    eprintln!(
        "published examples: {} of {} identical, the rest within 0.1':",
        tally.same, tally.total
    );
    for line in &tally.lines {
        eprintln!("{line}");
    }
    // Everything formula-only is identical; the refraction model changes a few values.
    // verify2: pin exactly which (ACCURACY.md's table of ten, 36 of 46 identical) rather
    // than "at least 70 %", so any other entry moving fails.
    assert_eq!((tally.same, tally.total), (36, 46));
    let differing: Vec<&str> = tally
        .lines
        .iter()
        .filter(|l| l.contains('≠'))
        .map(|l| l.trim_start().split("  ours").next().unwrap_or("").trim())
        .collect();
    assert_eq!(
        differing,
        [
            "stars_planets 0 Ha 27 48.1",
            "0-10 sun_oct_mar_lower Ha 6 29.7",
            "0-10 sun_apr_sep_lower Ha 1 19.7",
            "0-10 stars_planets Ha 4 02.1",
            "T and P exact, Ha 1 19.7",
            "Moon upper 3 50",
            "Moon upper 18 00",
            "Moon upper 66 40",
            "Moon upper 2 30",
            "Moon U",
        ]
    );
}

#[test]
fn the_printed_2016_polaris_page() {
    let f = load_fixture("almanac_tables_published.json");
    let page = &f["polaris_page_2016"];
    let t: PolarisTable = polaris_table(&Sky::new(), 2016, Calendar::Gregorian).unwrap();
    let (mut a1_same, mut az_same, mut a1_n, mut az_n) = (0, 0, 0, 0);
    let (mut a0_same, mut a2_same, mut a0_n, mut a2_n) = (0, 0, 0, 0);
    let mut worst_sum: f64 = 0.0;
    // The printed page's own adopted mean position, recovered from its a0 column (rounded
    // to the minute of SHA and the tenth of a minute of Dec): the formula with it prints
    // every a0 entry of the page.
    let (sha_printed, dec_printed) = (316.0 + 47.0 / 60.0, 89.0 + 20.0 / 60.0);
    let mut a0_adopted_same = 0;
    for from in page["columns_from_deg"].as_array().unwrap() {
        let from = from.as_u64().unwrap();
        let key = from.to_string();
        let c = &t.columns[from as usize / 10];
        let text = |part: &str| -> Vec<String> {
            page[part][&key]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| s(v).to_string())
                .collect()
        };
        for (o, w) in c.a1.iter().zip(text("a1")) {
            a1_n += 1;
            a1_same += usize::from(o.printed == w);
        }
        for (o, w) in c.azimuth.iter().zip(text("azimuth")) {
            az_n += 1;
            az_same += usize::from(o.printed == w);
        }
        let (a0p, a2p) = (text("a0"), text("a2"));
        for (r, (o, w)) in c.a0.iter().zip(&a0p).enumerate() {
            a0_n += 1;
            a0_same += usize::from(&o.printed == w);
            let adopted = a0_arcmin(from as f64 + r as f64, sha_printed, dec_printed);
            a0_adopted_same += usize::from(&fmt_deg_min_tenths(tenths_half_up(adopted)) == w);
        }
        for (o, w) in c.a2.iter().zip(&a2p) {
            a2_n += 1;
            a2_same += usize::from(&o.printed == w);
        }
        for (oa0, wa0) in c.a0.iter().zip(&a0p) {
            for (oa2, wa2) in c.a2.iter().zip(&a2p) {
                let ours = arcmin_of(&oa0.printed) + arcmin_of(&oa2.printed);
                let printed = arcmin_of(wa0) + arcmin_of(wa2);
                worst_sum = worst_sum.max((ours - printed).abs());
            }
        }
    }
    eprintln!(
        "Polaris 2016 page 275 (Bowditch fig. 1912c): a1 {a1_same}/{a1_n} and azimuth \
         {az_same}/{az_n} identical; a0 {a0_same}/{a0_n} and a2 {a2_same}/{a2_n} identical \
         (another adopted mean position); a0 + a2 within {worst_sum:.2}' of the printed sum \
         in all {} combinations; with the page's own mean position (SHA 316 47, Dec N 89 20.0) \
         the formula prints {a0_adopted_same}/{a0_n} of its a0",
        a0_n * 12
    );
    assert_eq!(a0_adopted_same, a0_n);
    assert_eq!(a1_same, a1_n);
    assert_eq!(az_same, az_n);
    assert!(worst_sum <= 0.1 + 1e-9);
    // The worked examples: the latitudes agree within 0.1′ (the terms may split
    // differently between a0 and a2).
    for e in f["polaris_worked"].as_array().unwrap() {
        let lha = deg_min(s(&e["lha_aries"]));
        let col = &t.columns[(lha / 10.0).floor() as usize];
        let d = lha.floor();
        let row = (d as u32 - col.from_deg) as usize;
        let (v0, v1) = (
            arcmin_of(&col.a0[row].printed),
            arcmin_of(&col.a0[row + 1].printed),
        );
        let a0 = tenths_half_up(v0 + (lha - d) * (v1 - v0)) as f64 / 10.0;
        let lat = e["latitude_deg"].as_f64().unwrap();
        let li = [
            0.0, 10.0, 20.0, 30.0, 40.0, 45.0, 50.0, 55.0, 60.0, 62.0, 64.0, 66.0, 68.0,
        ]
        .iter()
        .position(|&x| x == lat)
        .unwrap();
        let a1: f64 = col.a1[li].printed.parse().unwrap();
        let a2: f64 = col.a2[e["month"].as_u64().unwrap() as usize - 1]
            .printed
            .parse()
            .unwrap();
        let printed = arcmin_of(s(&e["a0"])) + arcmin_of(s(&e["a1"])) + arcmin_of(s(&e["a2"]));
        eprintln!(
            "  {}: a0 {a0:.1} a1 {a1:.1} a2 {a2:.1} = {:.1}; printed {} + {} + {} = {printed:.1}",
            s(&e["source"]),
            a0 + a1 + a2,
            s(&e["a0"]),
            s(&e["a1"]),
            s(&e["a2"])
        );
        assert!((a0 + a1 + a2 - printed).abs() <= 0.1 + 1e-9);
    }
}

#[test]
fn exact_conditions_match_the_formula() {
    let t = altitude_tables(Some(Conditions {
        temperature_c: 31.0,
        pressure_hpa: 1008.5,
    }))
    .unwrap();
    let c = t.additional.conditions.as_ref().unwrap();
    for (row, cell) in t.additional.rows.iter().zip(&c.corrections) {
        let exact = additional_correction_arcmin(row.alt_deg, c.factor);
        assert!((cell.arcmin - exact).abs() < 1e-12);
    }
}
