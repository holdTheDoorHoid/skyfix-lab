//! Transits of Mercury and Venus against NASA (Espenak):
//! `fixtures/reference/planetdetail_transits.json` holds the Six Millennium catalogue of
//! Venus transits and the Seven Century catalogue of Mercury transits (geocentric UT to
//! the minute), the geocentric contacts of 2004 and 2012 to the second with their
//! position angles, and the local contacts of 24 named cities in 2004 and 2012.
//!
//! The catalogues' UT carries Espenak's Delta-T (observed before 2003, extrapolated
//! after); inside the leap-second era it is UT1, within a second of UTC, and the
//! comparisons are made in UTC. Transits outside the providers' coverage are skipped
//! (the catalogues reach 2000 BCE for the deep-time tiers).

mod pd_common;

use pd_common::{Worst, planet_coverage, read, wrap};
use serde::Deserialize;
use skyfix_almanac::transits::transits;
use skyfix_ephemeris::planets::PlanetProvider;
use skyfix_ephemeris::topocentric::Site;

#[derive(Debug, Deserialize)]
struct File {
    catalogue: Vec<CatalogueRow>,
    geocentric_to_the_second: Vec<Precise>,
    cities: Vec<City>,
    skyfield: Vec<SkyfieldRow>,
}

#[derive(Debug, Deserialize)]
struct CatalogueRow {
    planet: String,
    date: String,
    greatest_jd_ut: f64,
    min_separation_arcsec: f64,
    nasa_polynomial_delta_t_s: f64,
    c1_jd_ut: Option<f64>,
    c2_jd_ut: Option<f64>,
    c3_jd_ut: Option<f64>,
    c4_jd_ut: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct SkyfieldRow {
    planet: String,
    date: String,
    greatest_jd_tt: f64,
    min_separation_arcsec: f64,
    c1_jd_tt: Option<f64>,
    c2_jd_tt: Option<f64>,
    c3_jd_tt: Option<f64>,
    c4_jd_tt: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct Precise {
    id: String,
    min_separation_arcsec: f64,
    contacts: Vec<PreciseContact>,
}

#[derive(Debug, Deserialize)]
struct PreciseContact {
    kind: String,
    jd_ut: f64,
    position_angle_deg: f64,
}

#[derive(Debug, Deserialize)]
struct City {
    transit: String,
    city: String,
    lat_deg: f64,
    lon_deg: f64,
    contacts: Vec<CityContact>,
}

#[derive(Debug, Deserialize)]
struct CityContact {
    kind: String,
    jd_ut: f64,
    sun_alt_deg: Option<f64>,
}

fn file() -> File {
    serde_json::from_str(&read("fixtures/reference/planetdetail_transits.json")).unwrap()
}

#[test]
fn every_catalogued_transit_in_coverage_is_found_within_a_minute() {
    let (lo, hi) = planet_coverage();
    let f = file();
    let p = PlanetProvider::new();
    let list = transits(&p, lo, hi, None).unwrap();
    let rows: Vec<&CatalogueRow> = f
        .catalogue
        .iter()
        .filter(|r| r.greatest_jd_ut > lo + 1.0 && r.greatest_jd_ut < hi - 1.0)
        .collect();
    assert!(
        rows.len() >= 12,
        "{} catalogued transits in coverage",
        rows.len()
    );
    assert_eq!(
        list.transits.len(),
        rows.len(),
        "found {:?}",
        list.transits.iter().map(|t| &t.id).collect::<Vec<_>>()
    );
    let (mut dt, mut excess, mut dur, mut dsep) = (
        Worst::default(),
        Worst::default(),
        Worst::default(),
        Worst::default(),
    );
    for r in rows {
        let t = list
            .transits
            .iter()
            .find(|t| {
                t.planet == r.planet && (t.contacts_jd("greatest") - r.greatest_jd_ut).abs() < 0.1
            })
            .unwrap_or_else(|| panic!("{} {} not found", r.planet, r.date));
        // Espenak's Delta-T after 2003 is an extrapolation made then; NASA's 2006
        // polynomial stands in for it, and the difference from our TT - UTC is allowed.
        let dt_allow = (r.nasa_polynomial_delta_t_s - t.tt_minus_utc_s).abs();
        for (kind, want) in [
            ("c1", r.c1_jd_ut),
            ("c2", r.c2_jd_ut),
            ("greatest", Some(r.greatest_jd_ut)),
            ("c3", r.c3_jd_ut),
            ("c4", r.c4_jd_ut),
        ] {
            match want {
                Some(w) => {
                    let d = (t.contacts_jd(kind) - w) * 86_400.0;
                    let label = || format!("{} {} {kind}", r.planet, r.date);
                    dt.add(d, label);
                    excess.add((d.abs() - dt_allow).max(0.0), label);
                }
                None => assert!(
                    t.contact(kind).is_none(),
                    "{} {} has no {kind}",
                    r.planet,
                    r.date
                ),
            }
        }
        // Durations do not depend on Delta-T: two roundings to the minute.
        if let (Some(c1), Some(c4)) = (r.c1_jd_ut, r.c4_jd_ut) {
            let ours = t.contacts_jd("c4") - t.contacts_jd("c1");
            dur.add((ours - (c4 - c1)) * 86_400.0, || {
                format!("{} {}", r.planet, r.date)
            });
        }
        dsep.add(t.min_separation_arcsec - r.min_separation_arcsec, || {
            format!("{} {}", r.planet, r.date)
        });
    }
    println!(
        "contacts vs NASA (s): {dt:?}\nbeyond the Delta-T difference (s): {excess:?}\n\
         durations (s): {dur:?}\nleast separation (\"): {dsep:?}"
    );
    // The catalogue rounds to the minute; before 2003 its Delta-T is observed.
    assert!(excess.value < 60.0, "{excess:?}");
    assert!(dur.value.abs() < 60.0, "{dur:?}");
    assert!(dsep.value.abs() < 0.5, "{dsep:?}");
}

#[test]
fn contacts_match_skyfield_with_the_same_definitions() {
    // Skyfield + DE440s, the same Sun and planet radii: this is the precision test.
    let (lo, hi) = planet_coverage();
    let f = file();
    let p = PlanetProvider::new();
    let list = transits(&p, lo, hi, None).unwrap();
    let (mut dt, mut dsep, mut equiv, mut n) =
        (Worst::default(), Worst::default(), Worst::default(), 0);
    for r in &f.skyfield {
        let jd = pd_common::jd_utc_from_tt(r.greatest_jd_tt);
        if jd < lo + 1.0 || jd > hi - 1.0 {
            continue;
        }
        let t = list
            .transits
            .iter()
            .find(|t| t.planet == r.planet && (t.contacts_jd("greatest") - jd).abs() < 0.1)
            .unwrap_or_else(|| panic!("{} {} not found", r.planet, r.date));
        for (kind, want) in [
            ("c1", r.c1_jd_tt),
            ("c2", r.c2_jd_tt),
            ("greatest", Some(r.greatest_jd_tt)),
            ("c3", r.c3_jd_tt),
            ("c4", r.c4_jd_tt),
        ] {
            let got = t.contact(kind).map(|c| c.jd_tt);
            match (want, got) {
                (Some(w), Some(g)) => {
                    let d = (g - w) * 86_400.0;
                    let label = || format!("{} {} {kind}", r.planet, r.date);
                    dt.add(d, label);
                    // A contact's time is only as sharp as the angle at which the chord
                    // meets the limb: convert to the separation error that explains it,
                    // |dt| * (the rate the separation changes at that contact).
                    if kind != "greatest" {
                        let c = t.contact(kind).unwrap();
                        let g_c = t.contact("greatest").unwrap();
                        let (sep, d_min) = (c.separation_arcsec, g_c.separation_arcsec);
                        let half = (sep * sep - d_min * d_min).max(0.0).sqrt();
                        let v = half / ((c.jd_utc - g_c.jd_utc).abs() * 86_400.0);
                        // d(sep)/dt = v * half / sep along a straight chord.
                        equiv.add(d.abs() * v * half / sep, label);
                    }
                }
                (None, None) => {}
                _ => panic!("{} {} {kind}: {want:?} vs {got:?}", r.planet, r.date),
            }
        }
        dsep.add(t.min_separation_arcsec - r.min_separation_arcsec, || {
            format!("{} {}", r.planet, r.date)
        });
        n += 1;
    }
    println!(
        "{n} transits; contacts (s): {dt:?}\nas a separation error (\"): {equiv:?}\n\
         least separation (\"): {dsep:?}"
    );
    assert!(n >= 12, "{n}");
    // The planets and the Sun are good to about 0.1" (ACCURACY.md, "Planets"): contacts
    // within that of Skyfield's, which is 5 s at most except where the planet meets
    // the limb at a grazing angle (Mercury 1999: 150 s per arcsecond).
    assert!(equiv.value.abs() < 0.1, "{equiv:?}");
    assert!(dt.value.abs() < 10.0, "{dt:?}");
    assert!(dsep.value.abs() < 0.1, "{dsep:?}");
}

#[test]
fn the_2004_and_2012_transits_to_the_second() {
    let f = file();
    let p = PlanetProvider::new();
    let (mut dt, mut dpa) = (Worst::default(), Worst::default());
    for t in &f.geocentric_to_the_second {
        let g = t
            .contacts
            .iter()
            .find(|c| c.kind == "greatest")
            .unwrap()
            .jd_ut;
        let list = transits(&p, g - 1.0, g + 1.0, None).unwrap();
        assert_eq!(list.transits.len(), 1);
        let ours = &list.transits[0];
        assert_eq!(ours.id, t.id);
        for c in &t.contacts {
            let got = ours.contact(&c.kind).unwrap();
            dt.add((got.jd_utc - c.jd_ut) * 86_400.0, || {
                format!("{} {}", t.id, c.kind)
            });
            dpa.add(wrap(got.position_angle_deg, c.position_angle_deg), || {
                format!("{} {}", t.id, c.kind)
            });
        }
        assert!(
            (ours.min_separation_arcsec - t.min_separation_arcsec).abs() < 1.0,
            "{ours:?}"
        );
    }
    println!("contacts (s): {dt:?}\nposition angles (deg): {dpa:?}");
    // NASA's UT is UT1 (Delta-T observed): UT1 - UTC was -0.4 s in both Junes. The
    // external contacts fall 3-5 s inside NASA's and the internal ones 4-5 s outside:
    // NASA's Venus is about 0.2" (0.6 %) larger than the IAU's 6051.8 km; greatest
    // transit, which does not depend on the radii, agrees to 0.4 s.
    assert!(dt.value.abs() < 6.0, "{dt:?}");
    // Position angles printed to the degree.
    assert!(dpa.value.abs() < 0.6, "{dpa:?}");
}

#[test]
fn local_contacts_for_named_cities_within_30_seconds() {
    let f = file();
    let p = PlanetProvider::new();
    let (mut dt, mut dalt) = (Worst::default(), Worst::default());
    let mut n = 0;
    for city in &f.cities {
        let g = city.contacts[0].jd_ut;
        let site = Site::new(city.lat_deg, city.lon_deg);
        let list = transits(&p, g - 0.5, g + 0.5, Some(&site)).unwrap();
        let t = list.transits.iter().find(|t| t.id == city.transit).unwrap();
        let local = t.local.as_ref().unwrap();
        for c in &city.contacts {
            let got = local
                .events
                .iter()
                .find(|e| e.kind == c.kind)
                .unwrap_or_else(|| panic!("{} {}", city.city, c.kind));
            dt.add((got.jd_utc - c.jd_ut) * 86_400.0, || {
                format!("{} {} {}", city.transit, city.city, c.kind)
            });
            if let Some(alt) = c.sun_alt_deg {
                // NASA prints whole degrees (with refraction, it seems, near the horizon).
                dalt.add(got.sun_alt_deg - alt, || {
                    format!("{} {}", city.city, c.kind)
                });
            }
            n += 1;
        }
    }
    println!("{n} local contacts: time (s) {dt:?}\nSun altitude (deg) {dalt:?}");
    assert!(n > 80, "{n}");
    assert!(dt.value.abs() < 30.0, "{dt:?}");
    assert!(dalt.value.abs() < 1.0, "{dalt:?}");
}

trait Contacts {
    fn contact(&self, kind: &str) -> Option<&skyfix_almanac::transits::TransitContact>;
    fn contacts_jd(&self, kind: &str) -> f64 {
        self.contact(kind).map_or(f64::NAN, |c| c.jd_utc)
    }
}

impl Contacts for skyfix_almanac::transits::Transit {
    fn contact(&self, kind: &str) -> Option<&skyfix_almanac::transits::TransitContact> {
        self.contacts.iter().find(|c| c.kind == kind)
    }
}
