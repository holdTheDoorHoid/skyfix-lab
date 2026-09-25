//! The lunar limb (expansion programme P12) against three references:
//!
//! - **An independent implementation** of the same definitions
//!   (`fixtures/reference/eclipse_limb_skyfield.json`, `tools/limb/reference.py`): the
//!   Sun and the Moon from Skyfield with JPL DE440s on its IERS time scale, the Moon's
//!   orientation from NAIF's DE440 lunar kernel, and the profile from the raw LDEM_16 grid
//!   rather than the pack's ring. It checks the geometry, the frame, the ring and the
//!   contact solver; what remains is the ephemeris (the engine's Moon is 0.2-0.5 s from
//!   DE440s at a contact, ACCURACY "Eclipses") and the ring's resampling.
//! - **NASA's Scientific Visualization Studio** (`eclipse_limb_svs.json`): the published
//!   limb-corrected times of second and third contact, to the second, for 32 cities in the
//!   path of the total eclipse of 2024 April 8 and 19 in the path of the annular eclipse of
//!   2023 October 14 (LRO LOLA + SELENE topography at 60 m, SRTM terrain, JPL DE421).
//! - **The mean limb** of the engine itself: the option changes nothing else.
//!
//! Run with `-- --nocapture` for the tables.

use serde_json::Value;
use skyfix_almanac::eclipses::limb::LOADED_NOTE;
use skyfix_almanac::eclipses::{
    EclipseLocal, Eclipses, LimbRing, LocalEventKind, LocalType, SolarLimb, SolarLocal, profile_at,
};
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::Site;

fn repo(rel: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn json(rel: &str) -> Value {
    let path = repo(rel);
    serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} is committed: {e}", path.display())),
    )
    .unwrap()
}

/// The committed pack's payload (the common header read by hand: this crate does not
/// depend on the WASM crate, whose test checks the CRC).
fn pack() -> (String, Vec<u8>) {
    let dir = repo("web/public/data/packs");
    let file = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with("lunar-limb-") && n.ends_with(".bin"))
        .expect("the lunar-limb pack is committed");
    let bytes = std::fs::read(dir.join(&file)).unwrap();
    assert_eq!(&bytes[..8], b"SKYFIXPK");
    let n = usize::from(u16::from_le_bytes([bytes[10], bytes[11]]));
    assert_eq!(&bytes[12..12 + n], b"lunar-limb");
    let at = 12 + n;
    let len = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    assert_eq!(bytes.len(), at + 4 + len + 4, "{file}");
    (file, bytes[at + 4..at + 4 + len].to_vec())
}

fn ring() -> LimbRing {
    LimbRing::parse(&pack().1).unwrap()
}

fn site(c: &Value) -> Site {
    let mut s = Site::new(
        c["lat_deg"].as_f64().unwrap(),
        c["lon_deg"].as_f64().unwrap(),
    );
    s.height_m = c["height_m"].as_f64().unwrap();
    s
}

fn solar(l: EclipseLocal) -> SolarLocal {
    match l {
        EclipseLocal::Solar(s) => s,
        other => panic!("{other:?}"),
    }
}

fn day_start(id: &str) -> f64 {
    civil_to_jd(
        id[0..4].parse().unwrap(),
        id[5..7].parse().unwrap(),
        id[8..10].parse().unwrap(),
    )
}

fn seconds_of_day(hms: &str) -> f64 {
    let p: Vec<f64> = hms.split(':').map(|x| x.parse().unwrap()).collect();
    p[0] * 3600.0 + p[1] * 60.0 + p[2]
}

fn contact(limb: &SolarLimb, kind: LocalEventKind) -> Option<f64> {
    limb.contacts
        .iter()
        .find(|c| c.kind == kind)
        .map(|c| c.jd_utc)
}

fn key(kind: LocalEventKind) -> &'static str {
    match kind {
        LocalEventKind::C1 => "c1",
        LocalEventKind::C2 => "c2",
        LocalEventKind::C3 => "c3",
        LocalEventKind::C4 => "c4",
        other => panic!("{other:?}"),
    }
}

const CONTACTS: [LocalEventKind; 4] = [
    LocalEventKind::C1,
    LocalEventKind::C2,
    LocalEventKind::C3,
    LocalEventKind::C4,
];

/// A near graze: the contact moves by more than 8 s per arcsecond of limb height (about 3
/// s/" is usual). At the edges of the path a hundred metres of terrain, or of ephemeris
/// error across the track, move such a contact by seconds (San Antonio, Toledo and
/// Lancaster in 2024).
const GRAZE_S_PER_ARCSEC: f64 = 8.0;

fn contact_sensitivity(limb: &SolarLimb, kind: LocalEventKind) -> f64 {
    limb.contacts
        .iter()
        .find(|c| c.kind == kind)
        .map_or(0.0, |c| c.seconds_per_arcsec)
}

#[test]
fn the_committed_pack_is_the_ring_its_sidecar_describes() {
    let (file, payload) = pack();
    let side = json("web/public/data/packs/lunar-limb.json");
    let ring = LimbRing::parse(&payload).unwrap();
    assert_eq!(side["file"].as_str().unwrap(), file);
    assert_eq!(ring.version(), side["version"].as_str().unwrap());
    assert!(ring.source().contains("LDEM_16"), "{}", ring.source());
    assert_eq!(ring.shape(), (5760, 384));
    assert_eq!(ring.delta_range_deg(), (-12.0, 12.0));
    assert_eq!(ring.reference_radius_km(), 1737.4);
    let (lo, hi) = ring.height_range_m();
    let r = &side["ring"]["height_range_m"];
    assert_eq!((lo, hi), (r[0].as_f64().unwrap(), r[1].as_f64().unwrap()));
    // Spot checks of the geometry: the far side's highest ground (the Selenean summit,
    // 10.7 km at 5.4 N 158.6 W) is outside the ring; Mare Smythii's floor, on the east
    // limb at 1.3 S 87.5 E, is 3.7 km below the reference sphere in LDEM_16.
    let smythii = skyfix_almanac::libration::Selenographic {
        lat_deg: -1.3,
        lon_deg: 87.5,
    };
    let h = ring.height_at_m(&smythii).unwrap();
    assert!((h + 3720.0).abs() < 60.0, "Mare Smythii {h} m");
    let far = skyfix_almanac::libration::Selenographic {
        lat_deg: 5.4,
        lon_deg: -158.6,
    };
    assert!(ring.height_at_m(&far).is_none());
}

#[test]
fn the_profile_matches_one_built_from_the_raw_dem_with_naif_orientation() {
    let ring = ring();
    let fx = json("fixtures/reference/eclipse_limb_skyfield.json");
    let mut n_profiles = 0;
    for ecl in fx["eclipses"].as_array().unwrap() {
        let dut1 = ecl["dut1_s"].as_f64().unwrap();
        let (moon, sun) = (
            MoonProvider::with_dut1_s(dut1),
            SunProvider::with_dut1_s(dut1),
        );
        for c in ecl["cities"].as_array().unwrap() {
            let Some(p) = c.get("profile_at_max") else {
                continue;
            };
            let theirs: Vec<f64> = p["height_arcsec"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect();
            let ours =
                profile_at(&ring, &moon, &sun, &site(c), p["jd_utc"].as_f64().unwrap()).unwrap();
            assert!(!ours.ring_truncated);
            let d: Vec<f64> = ours
                .height_arcsec
                .iter()
                .zip(&theirs)
                .map(|(a, b)| a.unwrap() - b)
                .collect();
            let n = d.len() as f64;
            let mean = d.iter().sum::<f64>() / n;
            let rms = (d.iter().map(|x| x * x).sum::<f64>() / n).sqrt();
            let worst = d.iter().fold(0.0f64, |a, x| a.max(x.abs()));
            let km = ours.moon_distance_km / 206_264.806;
            println!(
                "{} {}: profile {} bins, mean {mean:+.4}\" ({:+.0} m), rms {rms:.4}\" ({:.0} m), worst {worst:.3}\"",
                ecl["id"].as_str().unwrap(),
                c["name"].as_str().unwrap(),
                d.len(),
                mean * km * 1000.0,
                rms * km * 1000.0
            );
            assert_eq!(d.len(), 5760);
            // Measured: mean -0.018", rms 0.026", worst 0.14" (the ring's second
            // interpolation rounds the sharpest crests off; 0.03" is 50 m).
            assert!(mean.abs() < 0.03, "mean {mean}");
            assert!(rms < 0.05, "rms {rms}");
            assert!(worst < 0.25, "worst {worst}");
            n_profiles += 1;
        }
    }
    assert_eq!(n_profiles, 3);
}

#[test]
fn contacts_match_an_independent_implementation() {
    let ring = ring();
    let fx = json("fixtures/reference/eclipse_limb_skyfield.json");
    for ecl in fx["eclipses"].as_array().unwrap() {
        let id = ecl["id"].as_str().unwrap();
        let e = Eclipses::with_dut1_s(ecl["dut1_s"].as_f64().unwrap());
        let (mut worst_abs, mut worst_corr) = ([0.0f64; 4], [0.0f64; 4]);
        // Near grazes: the difference in arcseconds of limb (time / sensitivity).
        let (mut graze_abs, mut graze_corr, mut n_graze) = (0.0f64, 0.0f64, 0);
        let mut n = 0;
        for c in ecl["cities"].as_array().unwrap() {
            let s = solar(e.local_with_limb(id, &site(c), Some(&ring)).unwrap());
            let limb = s.limb.as_deref().unwrap();
            for (k, kind) in CONTACTS.iter().enumerate() {
                let theirs = &c["limb"][key(*kind)];
                let ours = contact(limb, *kind);
                assert_eq!(
                    ours.is_some(),
                    !theirs.is_null(),
                    "{id} {}: {kind:?}",
                    c["name"]
                );
                let Some(ours) = ours else { continue };
                let dt = (ours - theirs["jd_utc"].as_f64().unwrap()) * 86_400.0;
                let our_mean = s.events.iter().find(|x| x.kind == *kind).map(|x| x.jd_utc);
                let their_mean = c["mean"][key(*kind)].as_f64();
                let dcorr = match (our_mean, their_mean) {
                    (Some(a), Some(b)) => dt - (a - b) * 86_400.0,
                    _ => dt,
                };
                let sens = contact_sensitivity(limb, *kind);
                if sens > GRAZE_S_PER_ARCSEC {
                    graze_abs = graze_abs.max(dt.abs() / sens);
                    graze_corr = graze_corr.max(dcorr.abs() / sens);
                    n_graze += 1;
                } else {
                    worst_abs[k] = worst_abs[k].max(dt.abs());
                    worst_corr[k] = worst_corr[k].max(dcorr.abs());
                }
                n += 1;
            }
        }
        println!(
            "{id}: {n} contacts; c1..c4 within {:.2} {:.2} {:.2} {:.2} s, corrections within {:.2} {:.2} {:.2} {:.2} s; \
             {n_graze} near grazes within {graze_abs:.3}\" of limb, corrections {graze_corr:.3}\"",
            worst_abs[0],
            worst_abs[1],
            worst_abs[2],
            worst_abs[3],
            worst_corr[0],
            worst_corr[1],
            worst_corr[2],
            worst_corr[3]
        );
        // The engine's Moon against DE440s moves every contact by 0.2-0.7 s; the
        // correction (limb minus mean limb) cancels most of that: measured within 0.34 s
        // (0.22 s but for Lancaster's second contact, 6 s/" from a graze).
        for k in 0..4 {
            assert!(worst_abs[k] < 0.8, "{id} contact {k}: {} s", worst_abs[k]);
            assert!(
                worst_corr[k] < 0.4,
                "{id} correction {k}: {} s",
                worst_corr[k]
            );
        }
        // Near grazes (2024: San Antonio, Toledo, Lancaster): within 0.15" of limb.
        assert!(
            graze_abs < 0.15 && graze_corr < 0.15,
            "{graze_abs} {graze_corr}"
        );
    }
}

/// One row of the SVS comparison.
struct SvsRow {
    name: String,
    graze: bool,
    c2: f64,
    c3: f64,
    /// The mean limb's second and third contact minus SVS's (none at San Antonio).
    mean_c2: Option<f64>,
    mean_c3: Option<f64>,
    dur_limb: f64,
    dur_mean: Option<f64>,
    dur_svs: f64,
}

fn svs_rows(ring: &LimbRing, ecl: &Value) -> Vec<SvsRow> {
    let id = ecl["id"].as_str().unwrap();
    let j0 = day_start(id);
    // As shipped: DUT1 from the IERS history.
    let e = Eclipses::new();
    ecl["cities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let s = solar(e.local_with_limb(id, &site(c), Some(ring)).unwrap());
            let limb = s.limb.as_deref().unwrap();
            let t = c["svs"]["ECLIPSE"].as_array().unwrap();
            let (s2, s3) = (
                seconds_of_day(t[2].as_str().unwrap()),
                seconds_of_day(t[3].as_str().unwrap()),
            );
            let at = |k| (contact(limb, k).unwrap() - j0) * 86_400.0;
            let graze = [LocalEventKind::C2, LocalEventKind::C3]
                .iter()
                .any(|k| contact_sensitivity(limb, *k) > GRAZE_S_PER_ARCSEC);
            SvsRow {
                name: c["name"].as_str().unwrap().to_string(),
                graze,
                mean_c2: s
                    .events
                    .iter()
                    .find(|x| x.kind == LocalEventKind::C2)
                    .map(|x| (x.jd_utc - j0) * 86_400.0 - s2),
                mean_c3: s
                    .events
                    .iter()
                    .find(|x| x.kind == LocalEventKind::C3)
                    .map(|x| (x.jd_utc - j0) * 86_400.0 - s3),
                c2: at(LocalEventKind::C2) - s2,
                c3: at(LocalEventKind::C3) - s3,
                dur_limb: limb.central_duration_s.unwrap(),
                dur_mean: s.central_duration_s,
                dur_svs: s3 - s2,
            }
        })
        .collect()
}

#[test]
fn second_and_third_contact_against_nasa_svs() {
    let ring = ring();
    let fx = json("fixtures/reference/eclipse_limb_svs.json");
    for ecl in fx["eclipses"].as_array().unwrap() {
        let id = ecl["id"].as_str().unwrap();
        let rows = svs_rows(&ring, ecl);
        println!("{id}: limb-corrected minus SVS, s (central phase: ours, mean limb, SVS)");
        for r in &rows {
            println!(
                "  {:28} c2 {:+6.2}  c3 {:+6.2}   {:6.1} {:>6} {:4.0}{}",
                r.name,
                r.c2,
                r.c3,
                r.dur_limb,
                r.dur_mean.map_or("-".into(), |d| format!("{d:.1}")),
                r.dur_svs,
                if r.graze { "  (edge of the path)" } else { "" }
            );
        }
        let inside: Vec<&SvsRow> = rows.iter().filter(|r| !r.graze).collect();
        let n = inside.len() as f64;
        let mean2 = inside.iter().map(|r| r.c2).sum::<f64>() / n;
        let mean3 = inside.iter().map(|r| r.c3).sum::<f64>() / n;
        let worst2 = inside.iter().fold(0.0f64, |a, r| a.max(r.c2.abs()));
        let worst3 = inside.iter().fold(0.0f64, |a, r| a.max(r.c3.abs()));
        let within2 = inside
            .iter()
            .filter(|r| r.c2.abs() <= 2.0 && r.c3.abs() <= 2.0)
            .count();
        let dur: Vec<f64> = inside.iter().map(|r| r.dur_limb - r.dur_svs).collect();
        let dur_mean = dur.iter().sum::<f64>() / n;
        let dur_worst = dur.iter().fold(0.0f64, |a, x| a.max(x.abs()));
        let mean_limb_worst = inside
            .iter()
            .filter_map(|r| r.dur_mean.map(|m| (m - r.dur_svs).abs()))
            .fold(0.0f64, f64::max);
        println!(
            "{id}: {} cities; c2 mean {mean2:+.2} s, worst {worst2:.2} s; c3 mean {mean3:+.2} s, worst {worst3:.2} s; \
             both within 2 s at {within2}; central phase {dur_mean:+.2} s (worst {dur_worst:.2} s), mean limb's worst {mean_limb_worst:.1} s",
            inside.len()
        );
        // The correction's work: the corrected contacts scatter about SVS's far less than
        // the mean limb's do.
        let std = |v: &[f64]| {
            let m = v.iter().sum::<f64>() / v.len() as f64;
            (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
        };
        for (which, limb_d, mean_d) in [
            (
                "c2",
                inside.iter().map(|r| r.c2).collect::<Vec<_>>(),
                inside.iter().filter_map(|r| r.mean_c2).collect::<Vec<_>>(),
            ),
            (
                "c3",
                inside.iter().map(|r| r.c3).collect(),
                inside.iter().filter_map(|r| r.mean_c3).collect(),
            ),
        ] {
            let (a, b) = (std(&limb_d), std(&mean_d));
            println!("{id} {which}: scatter about SVS {a:.2} s corrected, {b:.2} s mean limb");
            assert!(a < 0.6 * b, "{id} {which}: {a} vs {b}");
        }
        // Measured (ACCURACY "Lunar limb"): second contact within 1.1 s; third contact
        // 1.4 s early on average (0.5-3.2 s), in both eclipses and in the independent
        // implementation alike: SVS's central phase is 1.0-1.6 s longer than the geometric
        // one for the total and the annular eclipse, which no change in the size of the
        // Moon or of the Sun can do (it would lengthen one and shorten the other).
        assert!(worst2 < 1.5, "{id} c2 {worst2}");
        assert!(worst3 < 3.5, "{id} c3 {worst3}");
        // On the two-tier series (deeptime agent: ELP/MPP02 and the VSOP87A Earth, 0.13"
        // from DE440 in 1990-2060 where ELP 2000-82B was 0.89") the mean moved from -1.4 s
        // to -0.9 s; the window allows both.
        assert!((-2.0..-0.5).contains(&mean3), "{id} c3 mean {mean3}");
        assert!(mean2.abs() < 0.6, "{id} c2 mean {mean2}");
        assert!(
            within2 as f64 >= 0.85 * n,
            "{id}: {within2} of {n} within 2 s"
        );
        assert!((-2.0..0.0).contains(&dur_mean) && dur_worst < 5.0);
        assert!(mean_limb_worst > dur_worst, "{mean_limb_worst}");
        // Near grazes: seconds per hundred metres of limb.
        for r in rows.iter().filter(|r| r.graze) {
            assert!(r.c2.abs() < 2.0 && r.c3.abs() < 9.0, "{}", r.name);
        }
    }
}

#[test]
fn the_annular_eclipses_peaks_shorten_annularity_everywhere() {
    // With a smooth Moon of radius k2 annularity is 7-19 s too long: the highest peaks on
    // the leading and trailing limbs touch the Sun's limb first. Every corrected
    // annularity is shorter, second contact later and third earlier.
    let ring = ring();
    let fx = json("fixtures/reference/eclipse_limb_svs.json");
    let ecl = &fx["eclipses"].as_array().unwrap()[1];
    assert_eq!(ecl["id"], "2023-10-14-solar");
    let e = Eclipses::new();
    for c in ecl["cities"].as_array().unwrap() {
        let s = solar(
            e.local_with_limb("2023-10-14-solar", &site(c), Some(&ring))
                .unwrap(),
        );
        let limb = s.limb.as_deref().unwrap();
        assert_eq!(limb.local_type, Some(LocalType::Annular));
        let corr = |k| {
            limb.contacts
                .iter()
                .find(|x| x.kind == k)
                .unwrap()
                .correction_s
                .unwrap()
        };
        assert!(corr(LocalEventKind::C2) > 0.5, "{}", c["name"]);
        assert!(corr(LocalEventKind::C3) < -2.0, "{}", c["name"]);
        assert!(limb.central_duration_correction_s.unwrap() < -5.0);
    }
}

#[test]
fn a_site_at_the_edge_of_the_path_gains_totality_with_the_limb() {
    // San Antonio, 2024: the smooth Moon (k2) misses totality by a whisker; SVS gives 18 s
    // and the independent implementation 12 s.
    let ring = ring();
    let mut sa = Site::new(29.462809, -98.524635);
    sa.height_m = 198.0;
    let s = solar(
        Eclipses::new()
            .local_with_limb("2024-04-08-solar", &sa, Some(&ring))
            .unwrap(),
    );
    assert_eq!(s.local_type, LocalType::Partial);
    let limb = s.limb.as_deref().unwrap();
    assert_eq!(limb.local_type, Some(LocalType::Total));
    let d = limb.central_duration_s.unwrap();
    assert!((8.0..25.0).contains(&d), "{d}");
    for c in &limb.contacts {
        let central = matches!(c.kind, LocalEventKind::C2 | LocalEventKind::C3);
        assert_eq!(c.mean_jd_utc.is_none(), central, "{:?}", c.kind);
    }
    assert!(limb.central_duration_correction_s.is_none());
}

#[test]
fn the_option_leaves_every_mean_limb_result_alone_and_says_why_without_the_pack() {
    let ring = ring();
    let e = Eclipses::new();
    let mut dallas = Site::new(32.7767, -96.797);
    dallas.height_m = 150.0;
    for id in ["2024-04-08-solar", "2023-10-14-solar", "2017-08-21-solar"] {
        let plain = solar(e.local(id, &dallas).unwrap());
        assert!(plain.limb.is_none());
        let json_plain = serde_json::to_value(&plain).unwrap();
        assert!(
            json_plain.get("limb").is_none(),
            "eclipse_local grew a field"
        );
        for with in [None, Some(&ring)] {
            let mut l = solar(e.local_with_limb(id, &dallas, with).unwrap());
            let limb = l.limb.take().unwrap();
            assert_eq!(l, plain, "{id}: the mean-limb fields changed");
            assert_eq!(limb.loaded, with.is_some());
            if with.is_none() {
                assert!(limb.contacts.is_empty() && limb.profile.is_none());
                assert!(limb.note.contains("Lunar limb data pack"));
            } else {
                assert_eq!(limb.note, LOADED_NOTE);
            }
        }
    }
    // Philadelphia sees a partial eclipse in 2024: external contacts only; Sydney none.
    let philly = Site::new(39.9526, -75.1652);
    let l = solar(
        e.local_with_limb("2024-04-08-solar", &philly, Some(&ring))
            .unwrap(),
    );
    let limb = l.limb.unwrap();
    assert_eq!(limb.local_type, Some(LocalType::Partial));
    let kinds: Vec<LocalEventKind> = limb.contacts.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, [LocalEventKind::C1, LocalEventKind::C4]);
    for c in &limb.contacts {
        assert!(c.correction_s.unwrap().abs() < 3.0);
    }
    // Sydney: the eclipse happens there geometrically, on the night side; the corrected
    // contacts exist, none of them visible, as the mean-limb events.
    let sydney = Site::new(-33.8688, 151.2093);
    let l = solar(
        e.local_with_limb("2024-04-08-solar", &sydney, Some(&ring))
            .unwrap(),
    );
    let limb = l.limb.unwrap();
    assert!(l.events.iter().all(|x| !x.visible));
    assert!(limb.contacts.iter().all(|c| !c.visible));
    // A lunar eclipse has no limb block.
    let lunar = e
        .local_with_limb("2025-03-14-lunar", &dallas, Some(&ring))
        .unwrap();
    assert!(matches!(lunar, EclipseLocal::Lunar(_)));
}

#[test]
fn beads_come_before_second_and_after_third_contact_and_end_in_the_contact_valley() {
    let ring = ring();
    let e = Eclipses::new();
    for (name, lat, lon, h) in [
        ("Indianapolis", 39.7684, -86.1581, 220.0),
        ("Dallas", 32.7767, -96.797, 150.0),
        ("Cleveland", 41.4993, -81.6944, 200.0),
    ] {
        let mut s = Site::new(lat, lon);
        s.height_m = h;
        let l = solar(
            e.local_with_limb("2024-04-08-solar", &s, Some(&ring))
                .unwrap(),
        );
        let limb = l.limb.unwrap();
        let c2 = limb
            .contacts
            .iter()
            .find(|c| c.kind == LocalEventKind::C2)
            .unwrap();
        let c3 = limb
            .contacts
            .iter()
            .find(|c| c.kind == LocalEventKind::C3)
            .unwrap();
        let before: Vec<_> = limb
            .beads
            .iter()
            .filter(|b| b.contact == LocalEventKind::C2)
            .collect();
        let after: Vec<_> = limb
            .beads
            .iter()
            .filter(|b| b.contact == LocalEventKind::C3)
            .collect();
        println!(
            "{name}: {} beads before second contact, {} after third",
            before.len(),
            after.len()
        );
        for b in &limb.beads {
            println!(
                "  {:?} {:+6.2} s  on the Sun {:5.1}°  on the Moon {:5.1}° at {:+.2}\"",
                b.contact,
                b.seconds_from_contact,
                b.position_angle_deg,
                b.limb_position_angle_deg,
                b.limb_height_arcsec
            );
        }
        assert!(!before.is_empty() && !after.is_empty());
        assert!(before.len() <= 8 && after.len() <= 8);
        assert!(before.iter().all(|b| b.seconds_from_contact <= 0.0));
        assert!(after.iter().all(|b| b.seconds_from_contact >= 0.0));
        assert!(
            limb.beads
                .iter()
                .all(|b| b.seconds_from_contact.abs() <= 15.0)
        );
        // The last bead to go out is the contact itself, in the contact's valley.
        let last = before.last().unwrap();
        assert!(
            last.seconds_from_contact > -0.1,
            "{}",
            last.seconds_from_contact
        );
        assert!((last.limb_position_angle_deg - c2.limb_position_angle_deg).abs() < 0.2);
        let first = after.first().unwrap();
        assert!(first.seconds_from_contact < 0.1);
        assert!((first.limb_position_angle_deg - c3.limb_position_angle_deg).abs() < 0.2);
        // The profile for drawing: the whole limb at the maximum.
        let p = limb.profile.as_ref().unwrap();
        assert_eq!(p.height_arcsec.len(), 2880);
        assert_eq!(p.step_deg, 0.125);
        assert!(p.height_arcsec.iter().all(|h| h.is_some()));
        assert!(!p.ring_truncated);
        assert!((p.mean_limb_k2_arcsec + 0.45).abs() < 0.05);
    }
}

/// `cargo test --release -p skyfix-almanac --test eclipse_limb -- --ignored --nocapture`
#[test]
#[ignore]
fn timing() {
    let (_, payload) = pack();
    let t = std::time::Instant::now();
    let mut ring = None;
    for _ in 0..5 {
        ring = Some(LimbRing::parse(&payload).unwrap());
    }
    let parse_ms = t.elapsed().as_secs_f64() * 1000.0 / 5.0;
    let ring = ring.unwrap();
    let e = Eclipses::new();
    let mut indy = Site::new(39.7684, -86.1581);
    indy.height_m = 220.0;
    let _ = e.local_with_limb("2024-04-08-solar", &indy, Some(&ring));
    let t = std::time::Instant::now();
    for _ in 0..5 {
        let _ = e.local("2024-04-08-solar", &indy).unwrap();
    }
    let plain_ms = t.elapsed().as_secs_f64() * 1000.0 / 5.0;
    let t = std::time::Instant::now();
    for _ in 0..5 {
        let _ = e
            .local_with_limb("2024-04-08-solar", &indy, Some(&ring))
            .unwrap();
    }
    let limb_ms = t.elapsed().as_secs_f64() * 1000.0 / 5.0;
    let t = std::time::Instant::now();
    let (moon, sun) = (MoonProvider::new(), SunProvider::new());
    for _ in 0..5 {
        let _ = profile_at(&ring, &moon, &sun, &indy, 2_460_409.29).unwrap();
    }
    let profile_ms = t.elapsed().as_secs_f64() * 1000.0 / 5.0;
    println!(
        "parse {parse_ms:.1} ms; eclipse_local {plain_ms:.1} ms, with the limb {limb_ms:.1} ms; a profile {profile_ms:.1} ms"
    );
}
