//! Daily almanac pages against the US Naval Observatory (`fixtures/reference/almanac_usno.json`,
//! `tools/reference/gen_almanac.py --usno-only`): an entirely independent code path,
//! ephemeris and star catalogue.
//!
//! - **Celestial Navigation Data** at four whole hours of pages (2000, 2016, 2026 twice),
//!   each queried at the ground point of the Sun, the Moon and the four planets so that
//!   every one is above the horizon: GHA and Dec of Aries, the Sun, the Moon, the planets
//!   and the stars against the page's row for that hour (stars: GHA Aries + SHA).
//! - **One-day rise, set, transit and civil twilight** at the Greenwich meridian for six
//!   latitude-dates, against the page's tables.
//!
//! Target: the page's precision, 0.1' and 1 minute (USNO rounds its times to the minute).
//! Three USNO conventions are measured here rather than hidden (docs/ACCURACY.md section 10):
//!
//! - **The Moon's time argument.** docs/ACCURACY.md section 7 found USNO's Moon 10.36 s
//!   late at one instant. With four instants the offset is not constant: fitted per
//!   instant it is -2.4 s (2000), +4.9 s (2016), +10.3 s (2026), and the residual after
//!   the fit is under 0.01'. The page is asserted against USNO as is (within 0.1') and
//!   the fitted residual is asserted too.
//! - **Venus.** USNO's Venus differs from the page, and by the same amount from Skyfield +
//!   DE440s (`almanac_days.json`), by up to 0.25' when Venus is a thin crescent near
//!   inferior conjunction, always toward the Sun: USNO gives its centre of light, the page
//!   (like the printed almanac's tables and JPL's apparent place) the centre of the disc.
//!   Asserted: the page and Skyfield agree about USNO to 0.01'.
//! - **Polaris.** Its SHA changes by up to half an arcminute a day near the pole, so the
//!   page's 12h value is compared at 12h only; at other hours the provider's own SHA is.
mod common;

use std::collections::BTreeMap;

use common::load_fixture;
use serde_json::Value;
use skyfix_almanac::pages::{AlmanacDay, TableTime, TimeKind, almanac_day};
use skyfix_core::time::parse_utc;
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{BodyEphemeris, Sky, canonical};

#[derive(Default)]
struct Worst(BTreeMap<String, (f64, String, usize)>);

impl Worst {
    fn add(&mut self, what: &str, diff: f64, at: String) {
        let e = self
            .0
            .entry(what.to_string())
            .or_insert((0.0, String::new(), 0));
        e.2 += 1;
        if diff.abs() >= e.0 {
            e.0 = diff.abs();
            e.1 = at;
        }
    }
    fn get(&self, what: &str) -> f64 {
        self.0.get(what).map_or(0.0, |w| w.0)
    }
    fn report(&self, title: &str) {
        eprintln!("{title}");
        for (what, (w, at, n)) in &self.0 {
            eprintln!("  {what:<44} {n:>4} values  worst {w:>8.4}  {at}");
        }
    }
}

fn pages() -> impl FnMut(&str) -> AlmanacDay {
    let sky = Sky::new();
    let mut cache: BTreeMap<String, AlmanacDay> = BTreeMap::new();
    move |date: &str| {
        cache
            .entry(date.to_string())
            .or_insert_with(|| almanac_day(&sky, date).unwrap())
            .clone()
    }
}

/// Skyfield + DE440s hourly positions from `almanac_days.json`, for the instants both
/// fixtures share: `(date, hour, key) -> (GHA, Dec)`.
fn skyfield_hours() -> BTreeMap<(String, usize, String), (f64, f64)> {
    let doc = load_fixture("almanac_days.json");
    let mut out = BTreeMap::new();
    for day in doc["days"].as_array().unwrap() {
        let date = day["date"].as_str().unwrap().to_string();
        for (h, r) in day["hours"].as_array().unwrap().iter().enumerate() {
            for key in ["venus", "mars", "jupiter", "saturn"] {
                if let Some(v) = r.get(key) {
                    out.insert(
                        (date.clone(), h, key.to_string()),
                        (v[0].as_f64().unwrap(), v[1].as_f64().unwrap()),
                    );
                }
            }
        }
    }
    out
}

#[test]
fn page_positions_agree_with_usno_celestial_navigation_data() {
    let doc = load_fixture("almanac_usno.json");
    let sky = Sky::new();
    let reference = skyfield_hours();
    let mut page = pages();
    let mut w = Worst::default();
    let mut moon_offsets: BTreeMap<String, f64> = BTreeMap::new();
    for entry in doc["celnav"].as_array().unwrap() {
        let utc = entry["utc"].as_str().unwrap();
        let jd = parse_utc(utc).unwrap();
        let date = &utc[..10];
        let hour: usize = utc[11..13].parse().unwrap();
        let day = page(date);
        let row = &day.hours[hour];
        for o in entry["response"]["data"].as_array().unwrap() {
            let name = o["object"].as_str().unwrap();
            let a = &o["almanac_data"];
            let gha = a["gha"].as_f64().unwrap();
            let at = format!("{utc} {name}");
            if name.eq_ignore_ascii_case("ARIES") {
                w.add("Aries GHA", norm_180(row.aries.gha_deg - gha) * 60.0, at);
                continue;
            }
            let Some(body) = canonical(name) else {
                panic!("USNO object {name:?} is not a body this project knows");
            };
            let dec = a["dec"].as_f64().unwrap();
            match body {
                "Sun" => {
                    w.add(
                        "Sun GHA",
                        norm_180(row.sun.gha_deg - gha) * 60.0,
                        at.clone(),
                    );
                    w.add("Sun Dec", (row.sun.dec_deg - dec) * 60.0, at);
                }
                "Moon" => {
                    let m = row.moon.as_ref().unwrap();
                    w.add(
                        "Moon GHA as is",
                        norm_180(m.gha_deg - gha) * 60.0,
                        at.clone(),
                    );
                    w.add("Moon Dec as is", (m.dec_deg - dec) * 60.0, at.clone());
                    // The time offset that best explains USNO's Moon, sidereal time fixed:
                    // a least-squares step along the Moon's own motion over one second.
                    let gast = row.aries.gha_deg;
                    let s0 = sky.apparent_state("Moon", jd).unwrap();
                    let s1 = sky.apparent_state("Moon", jd + 1.0 / 86_400.0).unwrap();
                    let cosd = s0.dec_deg.to_radians().cos();
                    let (g0, g1) = (norm_360(gast - s0.ra_deg), norm_360(gast - s1.ra_deg));
                    let (ex, ey) = (norm_180(gha - g0) * 60.0 * cosd, (dec - s0.dec_deg) * 60.0);
                    let (vx, vy) = (
                        norm_180(g1 - g0) * 60.0 * cosd,
                        (s1.dec_deg - s0.dec_deg) * 60.0,
                    );
                    let dt = (ex * vx + ey * vy) / (vx * vx + vy * vy);
                    w.add(
                        "Moon residual after USNO's time offset",
                        (ex - dt * vx).hypot(ey - dt * vy),
                        at,
                    );
                    moon_offsets.insert(utc.to_string(), dt);
                }
                "Venus" | "Mars" | "Jupiter" | "Saturn" => {
                    let i = day.planets.iter().position(|p| p.body == body).unwrap();
                    let p = &row.planets[i];
                    let (dg, dd) = (norm_180(p.gha_deg - gha) * 60.0, (p.dec_deg - dec) * 60.0);
                    let what = if body == "Venus" {
                        "Venus"
                    } else {
                        "Mars, Jupiter, Saturn"
                    };
                    w.add(&format!("{what} GHA"), dg, at.clone());
                    w.add(&format!("{what} Dec"), dd, at.clone());
                    // Whatever USNO does, the page and Skyfield + DE440s agree about it.
                    let key = (date.to_string(), hour, body.to_ascii_lowercase());
                    if let Some(&(sg, sd)) = reference.get(&key) {
                        let (rg, rd) = (norm_180(sg - gha) * 60.0, (sd - dec) * 60.0);
                        w.add(
                            "planets: (page - USNO) - (Skyfield - USNO)",
                            (dg - rg).hypot(dd - rd),
                            at,
                        );
                    }
                }
                "Polaris" => {
                    let st = sky.apparent_state("Polaris", jd).unwrap();
                    let g = norm_360(row.aries.gha_deg + st.sha_deg());
                    w.add(
                        "Polaris GHA (SHA at the instant)",
                        norm_180(g - gha) * 60.0,
                        at.clone(),
                    );
                    w.add("Polaris Dec", (st.dec_deg - dec) * 60.0, at.clone());
                    let s = day.stars.iter().find(|s| s.body == "Polaris").unwrap();
                    let page_gha = norm_360(row.aries.gha_deg + s.sha_deg);
                    let what = if hour == 12 {
                        "Polaris GHA from the page (12h)"
                    } else {
                        "Polaris GHA from the page's 12h SHA at another hour"
                    };
                    w.add(what, norm_180(page_gha - gha) * 60.0, at);
                }
                star => {
                    let s = day.stars.iter().find(|s| s.body == star).unwrap();
                    let g = norm_360(row.aries.gha_deg + s.sha_deg);
                    w.add(
                        "stars GHA (GHA Aries + SHA at 12h)",
                        norm_180(g - gha) * 60.0,
                        at.clone(),
                    );
                    w.add("stars Dec", (s.dec_deg - dec) * 60.0, at);
                }
            }
        }
    }
    w.report("almanac pages vs USNO Celestial Navigation Data, arcminutes:");
    eprintln!("  USNO's Moon time argument minus ours, fitted per instant: {moon_offsets:?} s");
    for (what, limit) in [
        ("Aries GHA", 0.001),
        ("Sun GHA", 0.1),
        ("Sun Dec", 0.1),
        ("Moon GHA as is", 0.1),
        ("Moon Dec as is", 0.1),
        ("Moon residual after USNO's time offset", 0.01),
        ("Mars, Jupiter, Saturn GHA", 0.1),
        ("Mars, Jupiter, Saturn Dec", 0.1),
        ("Venus GHA", 0.3),
        ("Venus Dec", 0.3),
        ("planets: (page - USNO) - (Skyfield - USNO)", 0.01),
        ("stars GHA (GHA Aries + SHA at 12h)", 0.1),
        ("stars Dec", 0.1),
        ("Polaris GHA (SHA at the instant)", 0.1),
        ("Polaris GHA from the page (12h)", 0.1),
        ("Polaris Dec", 0.1),
    ] {
        assert!(w.0.contains_key(what), "no {what} in the USNO answers");
        let v = w.get(what);
        assert!(v < limit, "{what}: worst {v}' exceeds {limit}'");
    }
    // The findings themselves (see the module docs), so a change in USNO's answers or in
    // the page is noticed: the Moon's offset grows from about -2 s (2000) to +10 s (2026),
    // and Venus near inferior conjunction is more than 0.2' off.
    let first = moon_offsets.values().next().copied().unwrap();
    let last = moon_offsets.values().last().copied().unwrap();
    assert!(first < 0.0 && last > 9.0, "{moon_offsets:?}");
    assert!(w.get("Venus GHA") > 0.2);
}

fn usno_minutes(s: &str) -> f64 {
    let (h, m) = s.split_once(':').unwrap();
    h.parse::<f64>().unwrap() * 60.0 + m.parse::<f64>().unwrap()
}

fn same_day_minutes(t: &TableTime) -> Option<f64> {
    (t.kind == TimeKind::Time)
        .then(|| t.hours.unwrap() * 60.0)
        .filter(|m| (0.0..1440.0).contains(m))
}

#[test]
fn page_tables_agree_with_usno_one_day_phenomena() {
    let doc = load_fixture("almanac_usno.json");
    let mut page = pages();
    let mut w = Worst::default();
    let mut n = 0;
    for entry in doc["oneday"].as_array().unwrap() {
        let date = entry["date"].as_str().unwrap();
        let lat = entry["lat_deg"].as_f64().unwrap();
        let day = page(date);
        let row = day.rise_set.rows.iter().find(|r| r.lat_deg == lat).unwrap();
        let moon = day.moon.as_ref().unwrap();
        let at = format!("{date} {}", row.label);
        let mut check = |what: &str, ours: &TableTime, usno: &Value| {
            let u = usno_minutes(usno["time"].as_str().unwrap());
            let o = same_day_minutes(ours)
                .unwrap_or_else(|| panic!("{at} {what}: USNO {u} min, ours {}", ours.printed));
            w.add(what, o - u, at.clone());
            n += 1;
        };
        for p in entry["sundata"].as_array().unwrap() {
            match p["phen"].as_str().unwrap() {
                "Begin Civil Twilight" => check("Sun: civil dawn", &row.civil_dawn, p),
                "Rise" => check("Sun: sunrise", &row.sunrise, p),
                "Upper Transit" => check("Sun: meridian passage", &day.sun.mer_pass, p),
                "Set" => check("Sun: sunset", &row.sunset, p),
                "End Civil Twilight" => check("Sun: civil dusk", &row.civil_dusk, p),
                other => panic!("unexpected USNO phenomenon {other}"),
            }
        }
        for p in entry["moondata"].as_array().unwrap() {
            match p["phen"].as_str().unwrap() {
                "Rise" => check("Moon: moonrise", &row.moonrise[0], p),
                "Set" => check("Moon: moonset", &row.moonset[0], p),
                "Upper Transit" => check("Moon: meridian passage", &moon.mer_pass_upper, p),
                other => panic!("unexpected USNO phenomenon {other}"),
            }
        }
    }
    w.report("almanac tables vs USNO one-day phenomena, minutes (USNO rounds to the minute):");
    assert!(n >= 40, "only {n} phenomena compared");
    for (what, (worst, at, _)) in &w.0 {
        assert!(*worst <= 0.75, "{what}: {worst} min at {at}");
    }
}
