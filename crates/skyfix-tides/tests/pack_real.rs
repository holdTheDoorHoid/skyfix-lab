//! The shipped pack, `web/public/data/packs/tides-us-<rev>.bin` (built by
//! `tools/tides/build.py` from NOAA's records):
//!
//! - it decodes, and re-encodes byte for byte (the Python writer and the Rust reader
//!   agree on the format documented in `pack.rs` and EXPLORER_API "Tides");
//! - its sidecar `tides-us.json` describes it;
//! - it carries NOAA's constants and datums exactly (to the published precision) for the
//!   stations of `fixtures/reference/tides_noaa.json`;
//! - every station agrees with NOAA's own high and low water over the sweep window
//!   (`fixtures/reference/tides_noaa_sweep.json`, 3 492 stations), except the ones the
//!   pack flags `noaa_differs`. The full sweep takes about 20 s in a release build; a
//!   debug build checks every 7th station unless `TIDES_FULL_SWEEP=1`.

use std::path::PathBuf;

use serde_json::Value;
use skyfix_tides::api;
use skyfix_tides::db::{Datum, StationKind, flags};
use skyfix_tides::pack::{decode_file, encode_payload, parse_file};
use skyfix_tides::predict::{Extreme, ExtremeKind, NodalMode, jd_year_start};
use skyfix_tides::schureman::index_of;
use skyfix_tides::validation::{RefExtreme, Tolerance, compare, rounding_rate_sigma};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn pack_path() -> PathBuf {
    let dir = repo().join("web/public/data/packs");
    let found: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("web/public/data/packs")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            n.starts_with("tides-us-") && n.ends_with(".bin")
        })
        .collect();
    assert_eq!(found.len(), 1, "exactly one tides-us pack: {found:?}");
    found[0].clone()
}

fn json(path: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(repo().join(path)).unwrap()).unwrap()
}

fn jd_of(ymd: &str) -> f64 {
    let y: i32 = ymd[0..4].parse().unwrap();
    let m: u32 = ymd[4..6].parse().unwrap();
    let d: u32 = ymd[6..8].parse().unwrap();
    let cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let doy = cum[(m - 1) as usize] + d - 1 + u32::from(leap && m > 2);
    jd_year_start(y) + f64::from(doy)
}

#[test]
fn the_shipped_pack_decodes_and_reencodes_byte_for_byte() {
    let bytes = std::fs::read(pack_path()).unwrap();
    assert!(
        bytes.len() <= 500_000,
        "pack {} bytes > 0.5 MB",
        bytes.len()
    );
    let db = decode_file(&bytes).unwrap();
    assert_eq!(db.stations.len(), 3499);
    assert_eq!(db.harmonic_count(), 1256);
    let (_, payload) = parse_file(&bytes).unwrap();
    assert_eq!(encode_payload(&db).unwrap(), payload);
    // Sorted by id, ids unique.
    for w in db.stations.windows(2) {
        assert!(w[0].id < w[1].id, "{} then {}", w[0].id, w[1].id);
    }
    // Anchorage carries NOAA's extended set.
    let StationKind::Harmonic(h) = &db.get("9455920").unwrap().kind else {
        panic!("Anchorage is harmonic")
    };
    assert_eq!(h.terms.len(), 120);
}

#[test]
fn the_sidecar_describes_the_file() {
    let path = pack_path();
    let side = json("web/public/data/packs/tides-us.json");
    let bytes = std::fs::read(&path).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    assert_eq!(side["name"], "tides-us");
    assert_eq!(side["file"], name.as_str());
    assert_eq!(side["bytes"].as_u64().unwrap() as usize, bytes.len());
    let rev = side["rev"].as_str().unwrap();
    assert_eq!(name, format!("tides-us-{rev}.bin"));
    assert_eq!(rev.len(), 16);
    assert!(side["sha256"].as_str().unwrap().starts_with(rev));
    let db = decode_file(&bytes).unwrap();
    assert_eq!(side["version"], db.version.as_str());
    for k in ["label", "description", "provides"] {
        assert!(side.get(k).is_some(), "sidecar lacks {k}");
    }
}

#[test]
fn the_pack_carries_noaas_constants_for_the_validation_stations() {
    let db = decode_file(&std::fs::read(pack_path()).unwrap()).unwrap();
    let fx = json("fixtures/reference/tides_noaa.json");
    let mut checked = 0;
    for s in fx["harmonic"].as_array().unwrap() {
        let id = s["id"].as_str().unwrap();
        let StationKind::Harmonic(h) = &db.get(id).unwrap().kind else {
            panic!("{id} is harmonic")
        };
        let noaa = s["constants"]["constituents"].as_array().unwrap();
        assert_eq!(h.terms.len(), noaa.len(), "{id}: constituent count");
        for c in noaa {
            let k = index_of(c[0].as_str().unwrap()).unwrap() as u8;
            let t = h.terms.iter().find(|t| t.0 == k).unwrap();
            assert!(
                (t.1 - c[1].as_f64().unwrap()).abs() < 1e-9,
                "{id} amplitude"
            );
            let dp = (t.2 - c[2].as_f64().unwrap()).rem_euclid(360.0);
            assert!(dp.min(360.0 - dp) < 1e-9, "{id} phase {} vs {}", t.2, c[2]);
            checked += 1;
        }
        let d = &s["constants"]["datums_m_above_station_datum"];
        let want = d["MLLW"].as_f64().unwrap() - d["MSL"].as_f64().unwrap();
        let got = h.datums.offset_m(Datum::Mllw).unwrap();
        assert!(
            (got - want).abs() < 0.0006,
            "{id}: MLLW − MSL {got} vs {want}"
        );
    }
    assert!(checked > 700, "{checked}");
}

#[test]
fn every_unflagged_station_matches_noaas_sweep() {
    let db = decode_file(&std::fs::read(pack_path()).unwrap()).unwrap();
    let sweep = json("fixtures/reference/tides_noaa_sweep.json");
    let w = &sweep["generator"]["window"];
    let jd0 = jd_of(w[0].as_str().unwrap());
    let jd1 = jd_of(w[1].as_str().unwrap()) + 1.0;
    let every = if cfg!(debug_assertions) && std::env::var("TIDES_FULL_SWEEP").is_err() {
        7
    } else {
        1
    };
    let (mut stations, mut extremes, mut worst_dt, mut worst_dh) = (0, 0, 0.0f64, 0.0f64);
    let mut failing = Vec::new();
    for (n, (id, list)) in sweep["stations"].as_object().unwrap().iter().enumerate() {
        if n % every != 0 {
            continue;
        }
        let st = db.get(id).unwrap_or_else(|| panic!("{id} not in the pack"));
        let table =
            api::extremes(&db, id, jd0, jd1, "MLLW").unwrap_or_else(|e| panic!("{id}: {e}"));
        let ours: Vec<Extreme> = table
            .extremes
            .iter()
            .map(|e| Extreme {
                kind: if e.kind == "high" {
                    ExtremeKind::High
                } else {
                    ExtremeKind::Low
                },
                jd_utc: e.jd_utc,
                height_m: e.height_m,
            })
            .collect();
        let reference: Vec<RefExtreme> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|r| RefExtreme {
                jd_utc: jd0 + r[0].as_f64().unwrap() / 1440.0,
                height_m: r[1].as_f64().unwrap() / 1000.0,
                high: r[2].as_i64().unwrap() == 1,
            })
            .collect();
        let h = match &st.kind {
            StationKind::Harmonic(h) => h,
            StationKind::Subordinate(sub) => match &db.stations[sub.reference as usize].kind {
                StationKind::Harmonic(h) => h,
                StationKind::Subordinate(_) => unreachable!(),
            },
        };
        let p = h.predictor(NodalMode::MidYear);
        // The flat-turn allowance is not needed across the sweep (no extreme uses it);
        // an infinite acceleration disables it, so this check is the plain 2 min / 5 cm.
        let c = compare(
            &reference,
            &ours,
            jd0,
            jd1,
            Tolerance::default(),
            |_| f64::INFINITY,
            rounding_rate_sigma(&p),
        );
        stations += 1;
        extremes += c.matched;
        worst_dt = worst_dt.max(c.worst_dt_min);
        worst_dh = worst_dh.max(c.worst_dh_m);
        if !c.passes() && !st.has(flags::NOAA_DIFFERS) {
            failing.push(format!("{id}: {c:?}"));
        }
    }
    eprintln!(
        "sweep: {stations} stations, {extremes} extremes, worst {worst_dt:.2} min, {:.2} cm",
        worst_dh * 100.0
    );
    assert!(failing.is_empty(), "{failing:#?}");
    assert!(worst_dt <= 2.0 && worst_dh <= 0.05);
    assert!(stations * every >= 3400, "{stations}");
}

#[test]
fn the_flags_say_what_noaa_does() {
    let db = decode_file(&std::fs::read(pack_path()).unwrap()).unwrap();
    let sweep = json("fixtures/reference/tides_noaa_sweep.json");
    // NOAA refuses predictions for exactly the stations we cannot predict on MLLW, and
    // for the one the pack flags `noaa_differs` for that reason.
    for id in sweep["refused"].as_object().unwrap().keys() {
        let st = db.get(id).unwrap();
        let d = api::describe(&db, st);
        let ours_on_mllw = d.curve != "none" && d.datums.contains(&"MLLW");
        assert!(
            !ours_on_mllw || st.has(flags::NOAA_DIFFERS),
            "{id}: NOAA refuses it, we predict it unflagged"
        );
    }
    let differs = json("tools/tides/noaa_differs.json");
    for id in differs["stations"].as_object().unwrap().keys() {
        assert!(
            db.get(id).unwrap().has(flags::NOAA_DIFFERS),
            "{id} not flagged"
        );
    }
}

#[test]
fn nearest_stations_are_the_obvious_ones() {
    let db = decode_file(&std::fs::read(pack_path()).unwrap()).unwrap();
    for (lat, lon, want) in [
        (42.3548, -71.0534, "8443970"),  // Boston
        (37.8063, -122.4659, "9414290"), // San Francisco
        (21.3033, -157.8645, "1612340"), // Honolulu
        (61.2381, -149.8900, "9455920"), // Anchorage
    ] {
        let near = api::stations_near(&db, lat, lon, 5).unwrap();
        assert_eq!(near[0].station.id, want, "{lat} {lon}");
        assert!(near[0].distance_km < 1.0);
        assert!(
            near.windows(2)
                .all(|w| w[0].distance_km <= w[1].distance_km)
        );
    }
}
