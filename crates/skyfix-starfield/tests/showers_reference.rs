//! Meteor-shower dates against the International Meteor Organization's calendars
//! (fixtures/reference/showers_reference.json, written by tools/starfield/showers.py),
//! computed from the table's solar longitudes with SkyFix Lab's own Sun: for 2026 every
//! peak, start and end date within a day of the calendar's; for 2027 every peak. (The
//! table's activity limits come from the 2026 calendar; the 2027 calendar moved two of
//! them by more than a day, the eta-Lyrids' and the Phoenicids' starts, and the test
//! prints the differences.)

use serde_json::Value;
use skyfix_core::time::format_utc;
use skyfix_ephemeris::body::Sky;
use skyfix_starfield::extinction::SkyConditions;
use skyfix_starfield::showers::year;

fn date(jd: f64) -> String {
    format_utc(jd)[..10].to_string()
}

fn days_between(a: &str, b: &str) -> i64 {
    let p = |s: &str| {
        let y: i32 = s[0..4].parse().unwrap();
        let m: u32 = s[5..7].parse().unwrap();
        let d: u32 = s[8..10].parse().unwrap();
        skyfix_core::time::civil_to_jd(y, m, d)
    };
    (p(a) - p(b)).round() as i64
}

#[test]
fn dates_agree_with_the_imo_calendars_within_a_day() {
    let path = format!(
        "{}/../../fixtures/reference/showers_reference.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let f: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let sky = Sky::new();
    let c = SkyConditions::default().resolve().unwrap();
    for y in [2026, 2027] {
        let computed = year(&sky, y, None, &c).unwrap();
        assert!(computed.errors.is_empty(), "{:?}", computed.errors);
        assert_eq!(computed.showers.len(), 32);
        let (mut exact, mut n, mut worst) = (0, 0, 0i64);
        for s in f["showers"].as_array().unwrap() {
            let code = s["code"].as_str().unwrap();
            let Some(imo) = s.get(format!("imo_{y}")) else {
                continue;
            };
            let ours = computed
                .showers
                .iter()
                .find(|x| x.shower.code == code)
                .unwrap();
            for (what, jd) in [
                ("peak", ours.peak.jd_utc),
                ("start", ours.start.jd_utc),
                ("end", ours.end.jd_utc),
            ] {
                let theirs = imo[what].as_str().unwrap();
                let d = days_between(&date(jd), theirs);
                if y == 2026 || what == "peak" {
                    assert!(
                        d.abs() <= 1,
                        "{y} {code} {what}: ours {} vs the IMO's {theirs}",
                        date(jd)
                    );
                    worst = worst.max(d.abs());
                } else if d.abs() > 1 {
                    println!(
                        "{y} {code} {what}: ours {} vs the IMO's {theirs} (revised limit)",
                        date(jd)
                    );
                }
                if what == "peak" {
                    exact += usize::from(d == 0);
                    n += 1;
                }
            }
        }
        println!(
            "{y}: {exact} of {n} peak dates exactly the IMO's; every date checked within {worst} day"
        );
        assert!(n >= 30);
    }
}

#[test]
fn a_site_gets_the_peak_night() {
    let sky = Sky::new();
    let site = skyfix_ephemeris::topocentric::Site::new(39.95, -75.17);
    let c = SkyConditions::default().resolve().unwrap();
    let y = year(&sky, 2026, Some(&site), &c).unwrap();
    let per = y.showers.iter().find(|s| s.shower.code == "PER").unwrap();
    let at = per.at_site.as_ref().unwrap();
    assert!(at.days_from_peak.abs() < 1.0);
    assert!(
        at.expected_rate_per_hour > 5.0 && at.expected_rate_per_hour < 100.0,
        "{at:?}"
    );
    // The Geminids' radiant is up most of the night from 40 N.
    let gem = y.showers.iter().find(|s| s.shower.code == "GEM").unwrap();
    assert!(gem.at_site.as_ref().unwrap().hours_radiant_above_20 > 6.0);
}
