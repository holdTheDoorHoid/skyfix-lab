//! Local circumstances against two independent sources:
//!
//! - **USNO**'s Solar Eclipse Computer (`eclipses_usno_local.json`, 22 sites for the
//!   total eclipses of 2017-08-21 and 2024-04-08 and the annular eclipse of
//!   2023-10-14): published contact times, altitudes, position and vertex angles,
//!   magnitude and obscuration. USNO computes with its own Delta-T (69.4 s in 2017, 72.5
//!   and 72.8 s in 2023-24, where the true value was about 69.2 s), so the engine is
//!   compared twice: once adopting USNO's Delta-T through DUT1, which isolates the
//!   model (seconds), and once as shipped, DUT1 = 0, against the 1-minute target.
//! - **Skyfield + DE440s** (`eclipses_skyfield.json`): contact instants found by root
//!   finding on the topocentric apparent Sun-Moon separation against the sum or
//!   difference of the semidiameters, with the same radii, on a UT1 = UTC timescale.
//!   A time difference `dt` at a contact is a separation residual of
//!   `rate * dt`, which the test reports: that is the check that the separation equals
//!   the sum or difference of the semidiameters at our instants.
//!
//! Run with `-- --nocapture` for the numbers.

use std::collections::HashMap;

use serde::Deserialize;
use skyfix_almanac::eclipses::{
    Eclipse, EclipseLocal, Eclipses, LocalEvent, LocalEventKind, LocalType, SolarLocal, Visibility,
};
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::topocentric::Site;

fn read(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is committed: {e}", path.display()))
}

#[derive(Debug, Clone, Deserialize)]
struct SiteRec {
    name: String,
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
}

impl SiteRec {
    fn site(&self) -> Site {
        let mut s = Site::new(self.lat_deg, self.lon_deg);
        s.height_m = self.height_m;
        s
    }
}

#[derive(Debug, Deserialize)]
struct UsnoFile {
    cases: Vec<UsnoCase>,
}

#[derive(Debug, Deserialize)]
struct UsnoCase {
    id: String,
    site: SiteRec,
    response: serde_json::Value,
}

fn solar_local(e: &Eclipses, id: &str, site: &Site) -> SolarLocal {
    match e.local(id, site).unwrap() {
        EclipseLocal::Solar(s) => s,
        other => panic!("{other:?}"),
    }
}

fn event(l: &SolarLocal, kind: LocalEventKind) -> Option<&LocalEvent> {
    l.events.iter().find(|e| e.kind == kind)
}

fn seconds_of_day(s: &str) -> f64 {
    let p: Vec<f64> = s.split(':').map(|x| x.parse().unwrap()).collect();
    p[0] * 3600.0 + p[1] * 60.0 + p.get(2).copied().unwrap_or(0.0)
}

fn kind_of(phenomenon: &str) -> LocalEventKind {
    match phenomenon {
        "Eclipse Begins" => LocalEventKind::C1,
        "Totality Begins" | "Annularity Begins" => LocalEventKind::C2,
        "Maximum Eclipse" => LocalEventKind::Max,
        "Totality Ends" | "Annularity Ends" => LocalEventKind::C3,
        "Eclipse Ends" => LocalEventKind::C4,
        "Sunrise" => LocalEventKind::Sunrise,
        "Sunset" => LocalEventKind::Sunset,
        other => panic!("unknown phenomenon {other}"),
    }
}

fn angle_diff(a: f64, b: f64) -> f64 {
    (a - b + 540.0).rem_euclid(360.0) - 180.0
}

#[derive(Default, Debug)]
struct Stats {
    contact_s: f64,
    max_s: f64,
    horizon_s: f64,
    magnitude: f64,
    obscuration_pct: f64,
    alt: f64,
    az: f64,
    pa_external: f64,
    pa_total: f64,
    pa_annular: f64,
    vertex: f64,
}

/// Compare every USNO case with the engine at `dut1_of(usno_delta_t)`.
fn compare_usno(dut1_of: impl Fn(f64) -> f64) -> Stats {
    let file: UsnoFile =
        serde_json::from_str(&read("fixtures/reference/eclipses_usno_local.json")).unwrap();
    assert_eq!(file.cases.len(), 22);
    let mut st = Stats::default();
    for case in &file.cases {
        let site = case.site.site();
        let r = &case.response;
        let tag = format!("{} {}", case.id, case.site.name);
        if r.get("error").is_some() {
            // USNO: "Eclipse not visible from selected location". Sydney is inside the
            // penumbra's cone, but on the night side: we say so ("below_horizon").
            let l = solar_local(&Eclipses::new(), &case.id, &site);
            assert!(
                matches!(l.visibility, Visibility::None | Visibility::BelowHorizon),
                "{tag}: {:?}",
                l.visibility
            );
            assert!(
                l.events.iter().all(|e| !e.visible) && l.visible_max.is_none(),
                "{tag}"
            );
            continue;
        }
        let p = &r["properties"];
        let usno_dt: f64 = p["delta_t"]
            .as_str()
            .unwrap()
            .trim_end_matches('s')
            .parse()
            .unwrap();
        let dut1 = dut1_of(usno_dt);
        let l = solar_local(&Eclipses::with_dut1_s(dut1), &case.id, &site);
        let desc = p["description"].as_str().unwrap();
        let want_type = if desc.contains("Total") {
            LocalType::Total
        } else if desc.contains("Annular") {
            LocalType::Annular
        } else {
            LocalType::Partial
        };
        assert_eq!(l.local_type, want_type, "{tag}");
        let j0 = civil_to_jd(
            case.id[0..4].parse().unwrap(),
            case.id[5..7].parse().unwrap(),
            case.id[8..10].parse().unwrap(),
        );
        let data = p["local_data"].as_array().unwrap();
        let has_horizon = data
            .iter()
            .any(|d| matches!(d["phenomenon"].as_str(), Some("Sunrise") | Some("Sunset")));
        let want_vis = if has_horizon {
            Visibility::PartlyBelowHorizon
        } else {
            Visibility::Visible
        };
        assert_eq!(l.visibility, want_vis, "{tag}");
        for d in data {
            let kind = kind_of(d["phenomenon"].as_str().unwrap());
            let ours = event(&l, kind).unwrap_or_else(|| panic!("{tag}: no {kind:?}"));
            // Our UTC with this DUT1, as UT1, like USNO's UT.
            let ours_ut = (ours.jd_utc - j0) * 86_400.0 + dut1;
            let dt = ours_ut - seconds_of_day(d["time"].as_str().unwrap());
            match kind {
                LocalEventKind::Sunrise | LocalEventKind::Sunset => {
                    st.horizon_s = st.horizon_s.max(dt.abs());
                    continue;
                }
                LocalEventKind::Max => {
                    if std::env::var("SHOW_MAX").is_ok() {
                        println!("{tag}: max {dt:+.2} s");
                    }
                    st.max_s = st.max_s.max(dt.abs())
                }
                _ => st.contact_s = st.contact_s.max(dt.abs()),
            }
            if let Some(alt) = d["altitude"].as_str().and_then(|a| a.parse::<f64>().ok()) {
                st.alt = st.alt.max((ours.alt_deg - alt).abs());
            }
            if let Some(az) = d["azimuth"].as_str().and_then(|a| a.parse::<f64>().ok()) {
                st.az = st.az.max(angle_diff(ours.az_deg, az).abs());
            }
            if let Some(pa) = d["position_angle"]
                .as_str()
                .and_then(|a| a.parse::<f64>().ok())
            {
                let ours_pa = ours.position_angle_deg.unwrap();
                let err = angle_diff(ours_pa, pa).abs();
                match (kind, want_type) {
                    (LocalEventKind::C1 | LocalEventKind::C4, _) => {
                        st.pa_external = st.pa_external.max(err)
                    }
                    (_, LocalType::Total) => st.pa_total = st.pa_total.max(err),
                    // USNO measures the annular second and third contacts on the far
                    // side of the Sun's disc from where the limbs touch.
                    _ => st.pa_annular = st.pa_annular.max((180.0 - err).abs()),
                }
            }
            if let Some(v) = d["vertex_angle"]
                .as_str()
                .and_then(|a| a.parse::<f64>().ok())
            {
                let ours_v = ours.vertex_angle_deg.unwrap();
                let err = angle_diff(ours_v, v).abs();
                let err = if want_type == LocalType::Annular
                    && matches!(kind, LocalEventKind::C2 | LocalEventKind::C3)
                {
                    (180.0 - err).abs()
                } else {
                    err
                };
                st.vertex = st.vertex.max(err);
            }
        }
        let mag: f64 = p["magnitude"].as_str().unwrap().parse().unwrap();
        let obs: f64 = p["obscuration"]
            .as_str()
            .unwrap()
            .trim_end_matches('%')
            .parse()
            .unwrap();
        st.magnitude = st.magnitude.max((l.magnitude - mag).abs());
        st.obscuration_pct = st.obscuration_pct.max((100.0 * l.obscuration - obs).abs());
    }
    st
}

#[test]
fn usno_contacts_with_usno_delta_t() {
    // Adopt USNO's Delta-T: DUT1 = 32.184 + 37 - Delta-T.
    let st = compare_usno(|dt| 69.184 - dt);
    println!("USNO, same Delta-T: {st:#?}");
    assert!(st.contact_s < 5.0, "contacts {} s", st.contact_s);
    // The instant of maximum is poorly conditioned (at Honolulu the magnitude changes
    // by a millionth in five seconds): within 0.8 s at 19 sites, 4.7 and 5.4 s at
    // Honolulu with the Sun 5 to 12 degrees up. Skyfield, with our definition (greatest
    // magnitude), agrees with us there to 0.4 s; USNO's definition evidently differs.
    assert!(st.max_s < 6.0, "maximum {} s", st.max_s);
    // USNO rounds sunrise and sunset to the minute.
    assert!(st.horizon_s < 60.0, "sunrise/sunset {} s", st.horizon_s);
    assert!(st.magnitude < 0.002, "magnitude {}", st.magnitude);
    assert!(
        st.obscuration_pct < 0.2,
        "obscuration {} %",
        st.obscuration_pct
    );
    assert!(st.alt < 0.1 && st.az < 0.1, "alt {} az {}", st.alt, st.az);
    assert!(st.pa_external < 0.3, "{}", st.pa_external);
    assert!(
        st.pa_total < 1.5 && st.pa_annular < 1.5,
        "{} {}",
        st.pa_total,
        st.pa_annular
    );
    assert!(st.vertex < 1.5, "{}", st.vertex);
}

#[test]
fn usno_contacts_as_shipped_within_a_minute() {
    // DUT1 = 0: the engine's own Delta-T, 69.184 s since 2017.
    let st = compare_usno(|_| 0.0);
    println!(
        "USNO, DUT1 = 0: contacts {:.2} s, maximum {:.2} s",
        st.contact_s, st.max_s
    );
    assert!(st.contact_s < 60.0 && st.max_s < 60.0);
}

#[derive(Debug, Deserialize)]
struct SkyfieldFile {
    solar_local: Vec<SkyfieldSolar>,
    lunar: Vec<SkyfieldLunar>,
}

#[derive(Debug, Deserialize)]
struct SkyfieldSolar {
    id: String,
    site: SiteRec,
    eclipse: bool,
    #[serde(default)]
    max: Option<SkyfieldMax>,
    #[serde(default)]
    contacts: Vec<SkyfieldContact>,
}

#[derive(Debug, Deserialize)]
struct SkyfieldMax {
    jd_utc: f64,
    separation_arcsec: f64,
    sun_sd_arcsec: f64,
    moon_sd_k1_arcsec: f64,
    moon_sd_k2_arcsec: f64,
    sun_alt_deg: f64,
}

#[derive(Debug, Deserialize)]
struct SkyfieldContact {
    kind: String,
    jd_utc: f64,
    residual_rate_arcsec_per_s: f64,
    sun_alt_deg: f64,
    sun_az_deg: f64,
    moon_position_angle_deg: f64,
}

#[derive(Debug, Deserialize)]
struct SkyfieldLunar {
    id: String,
    greatest_jd_utc: f64,
    gamma: f64,
    umbral_magnitude: f64,
    penumbral_magnitude: f64,
    contacts: Vec<LunarContact>,
    local: Vec<LunarLocalRec>,
}

#[derive(Debug, Deserialize)]
struct LunarContact {
    kind: String,
    jd_utc: f64,
}

#[derive(Debug, Deserialize)]
struct LunarLocalRec {
    site: SiteRec,
    events: Vec<LunarLocalEvent>,
}

#[derive(Debug, Deserialize)]
struct LunarLocalEvent {
    kind: String,
    moon_alt_deg: f64,
}

fn kind_str(k: LocalEventKind) -> &'static str {
    match k {
        LocalEventKind::C1 => "c1",
        LocalEventKind::C2 => "c2",
        LocalEventKind::Max => "max",
        LocalEventKind::C3 => "c3",
        LocalEventKind::C4 => "c4",
        LocalEventKind::P1 => "p1",
        LocalEventKind::U1 => "u1",
        LocalEventKind::U2 => "u2",
        LocalEventKind::U3 => "u3",
        LocalEventKind::U4 => "u4",
        LocalEventKind::P4 => "p4",
        LocalEventKind::Sunrise => "sunrise",
        LocalEventKind::Sunset => "sunset",
        LocalEventKind::Moonrise => "moonrise",
        LocalEventKind::Moonset => "moonset",
    }
}

#[test]
fn solar_contacts_agree_with_skyfield_de440s() {
    let file: SkyfieldFile =
        serde_json::from_str(&read("fixtures/reference/eclipses_skyfield.json")).unwrap();
    assert_eq!(file.solar_local.len(), 22);
    let engine = Eclipses::new();
    let (mut worst_dt, mut worst_res, mut worst_alt, mut worst_pa, mut worst_mag) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut worst_max = 0.0f64;
    let mut n = 0;
    for case in &file.solar_local {
        let tag = format!("{} {}", case.id, case.site.name);
        let l = solar_local(&engine, &case.id, &case.site.site());
        if !case.eclipse {
            assert_eq!(l.visibility, Visibility::None, "{tag}");
            continue;
        }
        if l.visibility == Visibility::BelowHorizon {
            // Skyfield's separation says the same regardless of the horizon.
            assert!(l.events.iter().all(|e| !e.visible), "{tag}");
        }
        for c in &case.contacts {
            let ours = l
                .events
                .iter()
                .find(|e| kind_str(e.kind) == c.kind)
                .unwrap_or_else(|| panic!("{tag}: no {}", c.kind));
            let dt = (ours.jd_utc - c.jd_utc) * 86_400.0;
            let residual = c.residual_rate_arcsec_per_s * dt;
            worst_dt = worst_dt.max(dt.abs());
            worst_res = worst_res.max(residual.abs());
            // Altitude and azimuth at our instant against Skyfield's at its own; the
            // Sun moves at most 0.0042 deg/s, so dt barely matters.
            worst_alt = worst_alt.max((ours.alt_deg - c.sun_alt_deg).abs()).max(
                (angle_diff(ours.az_deg, c.sun_az_deg) * ours.alt_deg.to_radians().cos()).abs(),
            );
            // Our contact angle is the Moon's direction from the Sun's centre, turned
            // by 180 degrees for the internal contacts of a total eclipse.
            let pa = ours.position_angle_deg.unwrap();
            let internal_total =
                l.local_type == LocalType::Total && matches!(c.kind.as_str(), "c2" | "c3");
            let err = angle_diff(
                pa + if internal_total { 180.0 } else { 0.0 },
                c.moon_position_angle_deg,
            );
            // Internal contacts of a deep eclipse put the centres within a few
            // arcseconds, where the angle is poorly defined; judge the external ones.
            if matches!(c.kind.as_str(), "c1" | "c4") {
                worst_pa = worst_pa.max(err.abs());
            }
            n += 1;
        }
        let m = case.max.as_ref().unwrap();
        let sky_mag = (m.sun_sd_arcsec + m.moon_sd_k1_arcsec - m.separation_arcsec)
            / (2.0 * m.sun_sd_arcsec + m.moon_sd_k1_arcsec - m.moon_sd_k2_arcsec);
        worst_mag = worst_mag.max((l.magnitude - sky_mag).abs());
        let ours_max = event(&l, LocalEventKind::Max).unwrap();
        let dt_max = (ours_max.jd_utc - m.jd_utc) * 86_400.0;
        worst_max = worst_max.max(dt_max.abs());
        // The Sun climbs or sinks up to 0.0042 deg/s: allow for the (ill-conditioned)
        // instants of maximum differing.
        assert!(
            (ours_max.alt_deg - m.sun_alt_deg).abs() < 0.01 + 0.0042 * dt_max.abs(),
            "{tag}"
        );
    }
    println!(
        "Skyfield + DE440s, {n} contacts: worst {worst_dt:.3} s = separation residual \
         {worst_res:.3}\"; Sun altitude/azimuth {worst_alt:.4} deg; position angle \
         {worst_pa:.3} deg; magnitude {worst_mag:.5}; maximum {worst_max:.2} s"
    );
    // Both sides take maximum as the greatest magnitude: measured 0.43 s.
    assert!(worst_max < 1.0, "{worst_max}");
    assert!(n >= 70, "{n}");
    // Target: 5 s (the fixture's tolerance). Measured: see docs/ACCURACY.md.
    assert!(worst_dt < 5.0, "{worst_dt} s");
    assert!(worst_res < 1.0, "{worst_res} arcsec");
    assert!(worst_alt < 0.01, "{worst_alt}");
    assert!(worst_pa < 0.05, "{worst_pa}");
    assert!(worst_mag < 5e-4, "{worst_mag}");
}

#[test]
fn lunar_eclipses_agree_with_skyfield_de440s() {
    let file: SkyfieldFile =
        serde_json::from_str(&read("fixtures/reference/eclipses_skyfield.json")).unwrap();
    let engine = Eclipses::new();
    let (mut worst_dt, mut worst_alt) = (0.0f64, 0.0f64);
    for case in &file.lunar {
        let e = match engine.by_id(&case.id).unwrap() {
            Eclipse::Lunar(l) => l,
            other => panic!("{other:?}"),
        };
        let tag = &case.id;
        assert!(
            (e.gamma - case.gamma).abs() < 5e-4,
            "{tag}: gamma {} {}",
            e.gamma,
            case.gamma
        );
        assert!(
            (e.umbral_magnitude - case.umbral_magnitude).abs() < 1e-3,
            "{tag}"
        );
        assert!(
            (e.penumbral_magnitude - case.penumbral_magnitude).abs() < 1e-3,
            "{tag}"
        );
        worst_dt = worst_dt.max((e.greatest.jd_utc - case.greatest_jd_utc).abs() * 86_400.0);
        let times: HashMap<String, f64> = case
            .contacts
            .iter()
            .map(|c| (c.kind.clone(), c.jd_utc))
            .collect();
        for c in &e.contacts {
            let kind = format!("{:?}", c.kind).to_lowercase();
            let theirs = times[&kind];
            worst_dt = worst_dt.max((c.jd_utc - theirs).abs() * 86_400.0);
        }
        for rec in &case.local {
            let l = match engine.local(&case.id, &rec.site.site()).unwrap() {
                EclipseLocal::Lunar(l) => l,
                other => panic!("{other:?}"),
            };
            for ev in &rec.events {
                let ours = l
                    .events
                    .iter()
                    .find(|e| kind_str(e.kind) == ev.kind)
                    .unwrap_or_else(|| panic!("{tag} {}: no {}", rec.site.name, ev.kind));
                worst_alt = worst_alt.max((ours.alt_deg - ev.moon_alt_deg).abs());
                // The Moon's rise/set altitude is about -0.83 degrees.
                if (ev.moon_alt_deg + 0.83).abs() > 0.2 {
                    assert_eq!(
                        ours.visible,
                        ev.moon_alt_deg > -0.83,
                        "{tag} {} {}",
                        rec.site.name,
                        ev.kind
                    );
                }
            }
            let any = l.events.iter().any(|e| e.visible);
            let all = l.events.iter().all(|e| e.visible);
            let crossings = l
                .events
                .iter()
                .any(|e| matches!(e.kind, LocalEventKind::Moonrise | LocalEventKind::Moonset));
            match l.visibility {
                Visibility::Visible => assert!(all && !crossings),
                Visibility::PartlyBelowHorizon => assert!(crossings),
                Visibility::BelowHorizon => assert!(!any),
                Visibility::None => panic!("a lunar eclipse is never 'none'"),
            }
            println!("{tag} {}: {:?}", rec.site.name, l.visibility);
        }
    }
    println!(
        "lunar: contacts within {worst_dt:.2} s of Skyfield, Moon altitude within {worst_alt:.4} deg"
    );
    assert!(worst_dt < 10.0, "{worst_dt}");
    assert!(worst_alt < 0.05, "{worst_alt}");
}

#[test]
fn horizon_cases() {
    let engine = Eclipses::new();
    // Dakar, 2017-08-21: the Sun sets while partly eclipsed.
    let l = solar_local(&engine, "2017-08-21-solar", &Site::new(14.7167, -17.4677));
    assert_eq!(l.visibility, Visibility::PartlyBelowHorizon);
    let set = event(&l, LocalEventKind::Sunset).expect("sunset during the eclipse");
    let vm = l.visible_max.as_ref().unwrap();
    assert_eq!(vm.kind, LocalEventKind::Sunset);
    assert!(vm.magnitude.unwrap() < l.magnitude);
    assert!(event(&l, LocalEventKind::C1).unwrap().visible);
    assert!(!event(&l, LocalEventKind::C4).unwrap().visible);
    assert!(set.jd_utc > event(&l, LocalEventKind::C1).unwrap().jd_utc);
    // Honolulu, 2017-08-21: the Sun rises eclipsed.
    let l = solar_local(&engine, "2017-08-21-solar", &Site::new(21.3069, -157.8583));
    assert_eq!(l.visibility, Visibility::PartlyBelowHorizon);
    assert!(event(&l, LocalEventKind::Sunrise).is_some());
    assert!(!event(&l, LocalEventKind::C1).unwrap().visible);
    // The maximum is after sunrise there, so it is what is seen.
    assert_eq!(l.visible_max.as_ref().unwrap().kind, LocalEventKind::Max);
    // Sydney, 2024-04-08: inside the penumbra's cone, but on the night side.
    let l = solar_local(&engine, "2024-04-08-solar", &Site::new(-33.8688, 151.2093));
    assert_eq!(l.visibility, Visibility::BelowHorizon);
    assert!(l.events.iter().all(|e| !e.visible) && l.visible_max.is_none());
    assert!(l.magnitude > 0.0);
    // McMurdo, 2024-04-08: outside the cone altogether.
    let l = solar_local(&engine, "2024-04-08-solar", &Site::new(-77.85, 166.67));
    assert_eq!(l.visibility, Visibility::None);
    assert_eq!(l.local_type, LocalType::None);
    assert!(l.events.is_empty() && l.visible_max.is_none() && l.magnitude == 0.0);
}
