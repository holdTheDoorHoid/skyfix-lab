//! Daily almanac pages against Skyfield + JPL DE440s (`fixtures/reference/almanac_days.json`,
//! `tools/reference/gen_almanac.py`): every tabulated quantity of 17 pages, 1990-2060.
//!
//! The target is the page's own precision (EXPLORER_PLAN work package J): 0.1' for
//! every angle, v, d, HP and SD; 0.1 for magnitudes; 1 minute for every time (0.1
//! minute for Aries' meridian passage); 1 s for the equation of time. Printed values are
//! checked too: each must be its raw value correctly rounded, so it lies within 0.05'
//! (half a unit) of the reference plus the raw disagreement.
//!
//! `cargo test -p skyfix-almanac --test almanac_reference -- --nocapture` prints the
//! worst disagreement of every quantity.

mod common;

use std::collections::BTreeMap;

use common::load_fixture;
use serde_json::Value;
use skyfix_almanac::pages::{AlmanacDay, TableTime, TimeKind, almanac_day};
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::Sky;

/// Worst |ours - reference| per quantity, where it happened, and how many were compared.
#[derive(Default)]
struct Stats {
    worst: BTreeMap<&'static str, (f64, String, usize, &'static str)>,
    printed_exact: usize,
    printed_total: usize,
}

impl Stats {
    fn add(&mut self, what: &'static str, unit: &'static str, diff: f64, at: String) {
        let e = self
            .worst
            .entry(what)
            .or_insert((0.0, String::new(), 0, unit));
        e.2 += 1;
        if diff.abs() >= e.0 {
            e.0 = diff.abs();
            e.1 = at;
        }
    }

    fn report(&self) {
        eprintln!("almanac pages vs Skyfield/DE440s, worst |ours - reference|:");
        for (what, (w, at, n, unit)) in &self.worst {
            eprintln!("  {what:<34} {n:>5} values  {w:>9.4} {unit:<6} {at}");
        }
        eprintln!(
            "  printed angles identical to the reference rounded: {} of {} ({:.2} %)",
            self.printed_exact,
            self.printed_total,
            100.0 * self.printed_exact as f64 / self.printed_total as f64
        );
    }

    fn max(&self, what: &str) -> f64 {
        self.worst.get(what).map_or(0.0, |w| w.0)
    }
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

/// `183 12.4` or `N 12 34.5` back to degrees.
fn parse_printed_angle(s: &str) -> f64 {
    let parts: Vec<&str> = s.split(' ').collect();
    let (sign, rest) = match parts[0] {
        "N" => (1.0, &parts[1..]),
        "S" => (-1.0, &parts[1..]),
        _ => (1.0, &parts[..]),
    };
    let d: f64 = rest[0].parse().unwrap();
    let m: f64 = rest[1].parse().unwrap();
    sign * (d + m / 60.0)
}

/// Compare one tabulated angle, raw and printed. `wrap` for GHA and SHA.
#[allow(clippy::too_many_arguments)]
fn angle(
    s: &mut Stats,
    what: &'static str,
    ours_deg: f64,
    printed: &str,
    reference_deg: f64,
    wrap: bool,
    at: &str,
) {
    let diff = if wrap {
        norm_180(ours_deg - reference_deg)
    } else {
        ours_deg - reference_deg
    } * 60.0;
    s.add(what, "arcmin", diff, at.to_string());
    let p = parse_printed_angle(printed);
    let pdiff = if wrap {
        norm_180(p - reference_deg)
    } else {
        p - reference_deg
    } * 60.0;
    assert!(
        pdiff.abs() <= 0.05 + diff.abs() + 1e-9,
        "{what} {at}: printed {printed:?} is {pdiff:+.4}' from the reference {reference_deg}, \
         raw difference {diff:+.4}'"
    );
    let reference_printed = if printed.starts_with('N') || printed.starts_with('S') {
        skyfix_almanac::pages::fmt_dec(reference_deg)
    } else {
        skyfix_almanac::pages::fmt_angle(reference_deg)
    };
    s.printed_total += 1;
    if reference_printed == printed {
        s.printed_exact += 1;
    }
}

/// A fixture cell: `["time", jd]` or `["above"]` ...
fn cell_kind(v: &Value) -> (&str, Option<f64>) {
    let a = v.as_array().unwrap();
    (a[0].as_str().unwrap(), a.get(1).map(num))
}

fn kind_name(k: TimeKind) -> &'static str {
    match k {
        TimeKind::Time => "time",
        TimeKind::Above => "above",
        TimeKind::Below => "below",
        TimeKind::AllNight => "all_night",
        TimeKind::Later => "later",
        TimeKind::Unavailable => "unavailable",
    }
}

/// Compare a time cell; returns false (after recording nothing) when the kinds differ.
fn time_cell(
    s: &mut Stats,
    what: &'static str,
    ours: &TableTime,
    reference: &Value,
    at: &str,
) -> bool {
    let (k, t) = cell_kind(reference);
    if kind_name(ours.kind) != k {
        return false;
    }
    if let (Some(a), Some(b)) = (ours.jd_utc, t) {
        let diff_s = (a - b) * 86_400.0;
        s.add(what, "s", diff_s, at.to_string());
        // Printed to the minute: within half a minute of the reference, plus the raw
        // difference.
        let h = ours.hours.unwrap();
        let printed_min = parse_hm(&ours.printed);
        let exact_min = h * 60.0;
        assert!(
            (printed_min - exact_min).abs() <= 0.5 + 1e-9,
            "{what} {at}: printed {:?} for {h} h",
            ours.printed
        );
    }
    true
}

/// `06 42`, `24 05`, `-00 02` to minutes.
fn parse_hm(s: &str) -> f64 {
    let neg = s.starts_with('-');
    let t = s.trim_start_matches('-');
    let (h, m) = t.split_once(' ').unwrap();
    let v = h.parse::<f64>().unwrap() * 60.0 + m.parse::<f64>().unwrap();
    if neg { -v } else { v }
}

fn page(sky: &Sky, date: &str) -> AlmanacDay {
    almanac_day(sky, date).unwrap_or_else(|e| panic!("{date}: {e}"))
}

#[test]
fn every_tabulated_quantity_is_within_the_printed_precision_of_skyfield() {
    let doc = load_fixture("almanac_days.json");
    let sky = Sky::new();
    let mut s = Stats::default();
    let mut grazing: Vec<String> = Vec::new();
    let mut kinds: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut hidden_hours = 0;
    let days = doc["days"].as_array().unwrap();
    assert!(days.len() >= 12, "at least 12 dates");
    for day in days {
        let date = day["date"].as_str().unwrap();
        let p = page(&sky, date);
        assert!(p.errors.is_empty(), "{date}: {:?}", p.errors);
        assert_eq!(p.hours.len(), 24);

        // Hourly values.
        for h in 0..24 {
            let r = &day["hours"][h];
            let row = &p.hours[h];
            let at = format!("{date} {h:02}h");
            assert!((row.jd_utc - num(&r["jd_utc"])).abs() < 1e-9);
            angle(
                &mut s,
                "GHA Aries",
                row.aries.gha_deg,
                &row.aries.printed.gha,
                num(&r["gha_aries_deg"]),
                true,
                &at,
            );
            angle(
                &mut s,
                "Sun GHA",
                row.sun.gha_deg,
                &row.sun.printed.gha,
                num(&r["sun"][0]),
                true,
                &at,
            );
            angle(
                &mut s,
                "Sun Dec",
                row.sun.dec_deg,
                &row.sun.printed.dec,
                num(&r["sun"][1]),
                false,
                &at,
            );
            let m = row.moon.as_ref().unwrap();
            let rm = &r["moon"];
            angle(
                &mut s,
                "Moon GHA",
                m.gha_deg,
                &m.printed.gha,
                num(&rm[0]),
                true,
                &at,
            );
            angle(
                &mut s,
                "Moon Dec",
                m.dec_deg,
                &m.printed.dec,
                num(&rm[1]),
                false,
                &at,
            );
            s.add("Moon HP", "arcmin", m.hp_arcmin - num(&rm[2]), at.clone());
            s.add("Moon v", "arcmin", m.v_arcmin - num(&rm[3]), at.clone());
            s.add("Moon d", "arcmin", m.d_arcmin - num(&rm[4]), at.clone());
            for (i, (name, key)) in [
                ("Venus", "venus"),
                ("Mars", "mars"),
                ("Jupiter", "jupiter"),
                ("Saturn", "saturn"),
            ]
            .iter()
            .enumerate()
            {
                let b = &row.planets[i];
                assert_eq!(b.body, *name);
                let what_gha: &'static str = match i {
                    0 => "Venus GHA",
                    1 => "Mars GHA",
                    2 => "Jupiter GHA",
                    _ => "Saturn GHA",
                };
                let what_dec: &'static str = match i {
                    0 => "Venus Dec",
                    1 => "Mars Dec",
                    2 => "Jupiter Dec",
                    _ => "Saturn Dec",
                };
                // Behind the solar disc Skyfield's light deflection grows without bound
                // and the provider caps it at the limb (docs/ACCURACY.md, "Planets hidden
                // behind the Sun"): judge those hours against the undeflected place.
                let hidden = r.get(format!("{key}_no_deflection"));
                match hidden {
                    Some(u) => {
                        let at = format!("{at} (behind the Sun)");
                        angle(
                            &mut s,
                            "planet behind the Sun, GHA vs undeflected",
                            b.gha_deg,
                            &b.printed.gha,
                            num(&u[0]),
                            true,
                            &at,
                        );
                        angle(
                            &mut s,
                            "planet behind the Sun, Dec vs undeflected",
                            b.dec_deg,
                            &b.printed.dec,
                            num(&u[1]),
                            false,
                            &at,
                        );
                        hidden_hours += 1;
                    }
                    None => {
                        angle(
                            &mut s,
                            what_gha,
                            b.gha_deg,
                            &b.printed.gha,
                            num(&r[*key][0]),
                            true,
                            &at,
                        );
                        angle(
                            &mut s,
                            what_dec,
                            b.dec_deg,
                            &b.printed.dec,
                            num(&r[*key][1]),
                            false,
                            &at,
                        );
                    }
                }
            }
        }

        // Aries, Sun, Moon and planets for the day.
        let at = date.to_string();
        let (_, t) = cell_kind(&day["aries_mer_pass"]);
        s.add(
            "Aries mer. pass.",
            "s",
            (p.aries.mer_pass.jd_utc.unwrap() - t.unwrap()) * 86_400.0,
            at.clone(),
        );
        let rs = &day["sun"];
        s.add(
            "Sun SD",
            "arcmin",
            p.sun.sd_arcmin - num(&rs["sd_arcmin"]),
            at.clone(),
        );
        s.add(
            "Sun d",
            "arcmin",
            p.sun.d_arcmin - num(&rs["d_arcmin"]),
            at.clone(),
        );
        s.add(
            "Eqn. of time 00h",
            "s",
            p.sun.eot_00h_s - num(&rs["eot_00h_s"]),
            at.clone(),
        );
        s.add(
            "Eqn. of time 12h",
            "s",
            p.sun.eot_12h_s - num(&rs["eot_12h_s"]),
            at.clone(),
        );
        assert!(time_cell(
            &mut s,
            "Sun mer. pass.",
            &p.sun.mer_pass,
            &rs["mer_pass"],
            &at
        ));
        let moon = p.moon.as_ref().unwrap();
        let rm = &day["moon"];
        s.add(
            "Moon SD",
            "arcmin",
            moon.sd_arcmin - num(&rm["sd_arcmin"]),
            at.clone(),
        );
        s.add(
            "Moon illuminated",
            "%",
            (moon.illuminated_fraction.unwrap() - num(&rm["illuminated_fraction"])) * 100.0,
            at.clone(),
        );
        s.add(
            "Moon age",
            "s",
            (moon.age_days.unwrap() - num(&rm["age_days"])) * 86_400.0,
            at.clone(),
        );
        assert!(time_cell(
            &mut s,
            "Moon mer. pass. upper",
            &moon.mer_pass_upper,
            &rm["mer_pass_upper"],
            &at
        ));
        assert!(time_cell(
            &mut s,
            "Moon mer. pass. lower",
            &moon.mer_pass_lower,
            &rm["mer_pass_lower"],
            &at
        ));
        match (&moon.phase, rm["phase"].as_array()) {
            (None, None) => {}
            (Some(ph), Some(r)) => {
                let kind = serde_json::to_value(ph.kind).unwrap();
                assert_eq!(kind.as_str(), r[0].as_str(), "{date}");
                s.add(
                    "Moon phase instant",
                    "s",
                    (ph.jd_utc - num(&r[1])) * 86_400.0,
                    at.clone(),
                );
            }
            (a, b) => panic!("{date}: phase {a:?} vs reference {b:?}"),
        }
        for (i, rp) in day["planets"].as_array().unwrap().iter().enumerate() {
            let pl = &p.planets[i];
            assert_eq!(pl.body, rp["body"].as_str().unwrap());
            s.add(
                "planet v",
                "arcmin",
                pl.v_arcmin - num(&rp["v_arcmin"]),
                format!("{date} {}", pl.body),
            );
            s.add(
                "planet d",
                "arcmin",
                pl.d_arcmin - num(&rp["d_arcmin"]),
                format!("{date} {}", pl.body),
            );
            let sha_ref = rp.get("sha_deg_no_deflection").unwrap_or(&rp["sha_deg"]);
            angle(
                &mut s,
                "planet SHA",
                pl.sha_deg,
                &pl.printed.sha,
                num(sha_ref),
                true,
                &format!("{date} {}", pl.body),
            );
            s.add(
                "planet magnitude",
                "mag",
                pl.magnitude.unwrap() - num(&rp["magnitude"]),
                format!("{date} {}", pl.body),
            );
            assert!(time_cell(
                &mut s,
                "planet mer. pass.",
                &pl.mer_pass,
                &rp["mer_pass"],
                &format!("{date} {}", pl.body)
            ));
        }

        // Stars at 12h UT.
        let rstars = day["stars"].as_array().unwrap();
        assert_eq!(p.stars.len(), rstars.len());
        for (st, r) in p.stars.iter().zip(rstars) {
            assert_eq!(st.body, r[0].as_str().unwrap());
            let at = format!("{date} {}", st.body);
            angle(
                &mut s,
                "star SHA",
                st.sha_deg,
                &st.printed.sha,
                num(&r[1]),
                true,
                &at,
            );
            angle(
                &mut s,
                "star Dec",
                st.dec_deg,
                &st.printed.dec,
                num(&r[2]),
                false,
                &at,
            );
        }

        // The rise, set and twilight tables.
        let rows = day["rise_set"].as_array().unwrap();
        assert_eq!(p.rise_set.rows.len(), rows.len());
        for (row, r) in p.rise_set.rows.iter().zip(rows) {
            assert_eq!(row.lat_deg, num(&r["lat_deg"]));
            let at = format!("{date} {}", row.label);
            let margins = &r["sun_alt_at_passages"];
            let near = |threshold: f64| {
                ["upper_deg", "lower_before_deg", "lower_after_deg"]
                    .iter()
                    .filter_map(|k| margins[*k].as_f64())
                    .any(|a| (a - threshold).abs() < 0.01)
            };
            let sun = [
                ("nautical dawn", &row.nautical_dawn, "nautical_dawn", -12.0),
                ("civil dawn", &row.civil_dawn, "civil_dawn", -6.0),
                ("sunrise", &row.sunrise, "sunrise", -50.0 / 60.0),
                ("sunset", &row.sunset, "sunset", -50.0 / 60.0),
                ("civil dusk", &row.civil_dusk, "civil_dusk", -6.0),
                ("nautical dusk", &row.nautical_dusk, "nautical_dusk", -12.0),
            ];
            for (what, ours, key, threshold) in sun {
                *kinds.entry(kind_name(ours.kind)).or_default() += 1;
                if !time_cell(&mut s, "Sun rise/set/twilight", ours, &r[key], &at) {
                    assert!(
                        near(threshold),
                        "{at} {what}: ours {:?} ({}), reference {}",
                        ours.kind,
                        ours.printed,
                        r[key]
                    );
                    grazing.push(format!(
                        "{at} {what}: ours {}, reference {}",
                        ours.printed, r[key]
                    ));
                }
            }
            for k in 0..2 {
                for (what, ours, key) in [
                    ("moonrise", &row.moonrise[k], "moonrise"),
                    ("moonset", &row.moonset[k], "moonset"),
                ] {
                    *kinds.entry(kind_name(ours.kind)).or_default() += 1;
                    assert!(
                        time_cell(&mut s, "moonrise/moonset", ours, &r[key][k], &at),
                        "{at} {what} day +{k}: ours {:?} {}, reference {}",
                        ours.kind,
                        ours.printed,
                        r[key][k]
                    );
                }
            }
        }
    }
    s.report();
    eprintln!("  table cells by kind: {kinds:?}");
    eprintln!("  planet-hours behind the solar disc (judged undeflected): {hidden_hours}");
    for g in &grazing {
        eprintln!("  grazing (Sun within 0.01 deg of the altitude at a passage): {g}");
    }

    // The targets: the printed precision.
    for (what, limit) in [
        ("GHA Aries", 0.1),
        ("Sun GHA", 0.1),
        ("Sun Dec", 0.1),
        ("Moon GHA", 0.1),
        ("Moon Dec", 0.1),
        ("Moon HP", 0.1),
        ("Moon v", 0.1),
        ("Moon d", 0.1),
        ("Venus GHA", 0.1),
        ("Venus Dec", 0.1),
        ("Mars GHA", 0.1),
        ("Mars Dec", 0.1),
        ("Jupiter GHA", 0.1),
        ("Jupiter Dec", 0.1),
        ("Saturn GHA", 0.1),
        ("Saturn Dec", 0.1),
        ("Sun SD", 0.1),
        ("Sun d", 0.1),
        ("Moon SD", 0.1),
        ("planet v", 0.1),
        ("planet d", 0.1),
        ("planet SHA", 0.1),
        ("planet magnitude", 0.1),
        ("star SHA", 0.1),
        ("star Dec", 0.1),
        ("planet behind the Sun, GHA vs undeflected", 0.1),
        ("planet behind the Sun, Dec vs undeflected", 0.1),
        ("Eqn. of time 00h", 1.0),
        ("Eqn. of time 12h", 1.0),
        ("Aries mer. pass.", 6.0),
        ("Sun mer. pass.", 60.0),
        ("Moon mer. pass. upper", 60.0),
        ("Moon mer. pass. lower", 60.0),
        ("planet mer. pass.", 60.0),
        ("Sun rise/set/twilight", 60.0),
        ("moonrise/moonset", 60.0),
        ("Moon age", 60.0),
        ("Moon phase instant", 60.0),
        ("Moon illuminated", 0.5),
    ] {
        let w = s.max(what);
        assert!(w < limit, "{what}: worst {w} exceeds {limit}");
    }
    // Regression guards far inside the targets: what the providers are documented to
    // reach (docs/ACCURACY.md sections 2, 7, 9 and the planets section).
    for (what, limit) in [
        ("GHA Aries", 0.001),
        ("Sun GHA", 0.01),
        ("Moon GHA", 0.03),
        ("Moon Dec", 0.03),
        ("Venus GHA", 0.02),
        ("Jupiter GHA", 0.02),
        ("Saturn GHA", 0.02),
        // Polaris: 0.02' of SHA is 0.0002' on the sky at 89.4 deg.
        ("star SHA", 0.03),
        ("star Dec", 0.01),
        ("Moon v", 0.01),
        ("Sun rise/set/twilight", 2.0),
        ("moonrise/moonset", 5.0),
    ] {
        let w = s.max(what);
        assert!(
            w < limit,
            "{what}: worst {w} exceeds the regression guard {limit}"
        );
    }
    // Every kind of cell occurs in the reference set.
    for k in ["time", "above", "below", "all_night"] {
        assert!(
            kinds.get(k).copied().unwrap_or(0) > 0,
            "no {k} cell in the fixture dates"
        );
    }
    // Each printed value was checked above to be its raw value correctly rounded. Two
    // correct roundings of values 0.005' apart still differ when a rounding boundary
    // falls between them, about one time in a hundred.
    assert!(
        s.printed_exact as f64 >= 0.98 * s.printed_total as f64,
        "{} of {} printed angles match the rounded reference",
        s.printed_exact,
        s.printed_total
    );
}
