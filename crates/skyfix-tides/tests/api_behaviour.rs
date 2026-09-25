//! `skyfix_tides::api` on the shipped pack: datums, subordinate stations, the state of
//! the tide now, and the error codes the adapters pass on.

use std::path::PathBuf;

use skyfix_tides::TideDb;
use skyfix_tides::api::{self, LABEL};
use skyfix_tides::pack::decode_file;
use skyfix_tides::predict::jd_year_start;

fn db() -> TideDb {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs");
    let path = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            n.starts_with("tides-us-") && n.ends_with(".bin")
        })
        .unwrap();
    decode_file(&std::fs::read(path).unwrap()).unwrap()
}

/// 2026-09-24T00:00Z.
const JD: f64 = 2_461_307.5;

#[test]
fn heights_follow_the_chosen_datum() {
    let db = db();
    let a = api::predict(&db, "9414290", JD, JD + 1.0, 60.0, "MLLW").unwrap();
    let b = api::predict(&db, "9414290", JD, JD + 1.0, 60.0, "MSL").unwrap();
    let c = api::predict(&db, "9414290", JD, JD + 1.0, 60.0, "").unwrap();
    assert_eq!(c.datum, "MLLW");
    assert_eq!(a.height_m, c.height_m);
    // San Francisco: MSL is 0.951 m above MLLW (NOAA datums, epoch 1983-2001).
    for (x, y) in a.height_m.iter().zip(&b.height_m) {
        assert!((x - y - 0.951).abs() < 1e-9, "{x} {y}");
    }
    let s = api::station_by_id(&db, "9414290").unwrap();
    assert_eq!(s.default_datum, "MLLW");
    for d in ["HAT", "MHHW", "MHW", "MTL", "MSL", "MLW", "MLLW", "LAT"] {
        assert!(s.datums.contains(&d), "{d} missing from {:?}", s.datums);
    }
    assert_eq!(s.tide_type, Some("mixed_semidiurnal"));
    assert!(a.label == LABEL && a.notes[0].contains("MLLW"));
    let e = api::predict(&db, "9414290", JD, JD + 1.0, 60.0, "CD").unwrap_err();
    assert!(e.starts_with("bad_request:"), "{e}");
}

#[test]
fn extremes_curve_and_now_agree() {
    let db = db();
    let ex = api::extremes(&db, "8443970", JD, JD + 2.0, "").unwrap();
    let curve = api::predict(&db, "8443970", JD, JD + 2.0, 1.0, "").unwrap();
    assert_eq!(ex.extremes.len(), 8, "Boston is semidiurnal");
    for e in &ex.extremes {
        // The curve never exceeds a high water or undercuts a low water nearby.
        let k = ((e.jd_utc - JD) * 1440.0).round() as usize;
        for j in k.saturating_sub(30)..(k + 30).min(curve.height_m.len()) {
            let h = curve.height_m[j];
            if e.kind == "high" {
                assert!(h <= e.height_m + 1e-6);
            } else {
                assert!(h >= e.height_m - 1e-6);
            }
        }
    }
    for k in 0..48 {
        let t = JD + 0.02 + k as f64 / 24.0;
        let now = api::now(&db, "8443970", t, "").unwrap();
        let prev = now.previous.as_ref().unwrap();
        let next = now.next.as_ref().unwrap();
        assert!(prev.jd_utc <= t && next.jd_utc > t);
        assert_eq!(
            now.state,
            if next.kind == "high" {
                "rising"
            } else {
                "falling"
            }
        );
        assert_eq!(now.state == "rising", now.rate_m_per_h > 0.0);
        assert!(now.next_high.as_ref().unwrap().jd_utc > t);
        assert!(now.next_low.as_ref().unwrap().jd_utc > t);
        let lo = prev.height_m.min(next.height_m) - 1e-6;
        let hi = prev.height_m.max(next.height_m) + 1e-6;
        assert!(
            (lo..=hi).contains(&now.height_m),
            "{} not in {lo}..{hi}",
            now.height_m
        );
    }
}

#[test]
fn subordinate_stations_give_high_and_low_water_and_an_interpolated_curve() {
    let db = db();
    // Hell Gate, from The Battery (+3 h).
    let s = api::station_by_id(&db, "8517401").unwrap();
    assert_eq!(s.kind, "subordinate");
    assert_eq!(s.reference_id.as_deref(), Some("8518750"));
    assert_eq!(s.curve, "interpolated");
    assert_eq!(s.datums, vec!["MLLW"]);
    assert!(s.notes.iter().any(|n| n.contains("cosine")));
    let ex = api::extremes(&db, "8517401", JD, JD + 2.0, "").unwrap();
    assert_eq!(ex.method, "subordinate_offsets");
    let c = api::predict(&db, "8517401", JD, JD + 2.0, 6.0, "").unwrap();
    assert_eq!(c.method, "interpolated");
    assert_eq!(c.jd_utc.len(), c.height_m.len());
    // The interpolated curve passes through each high and low water.
    let fine = api::predict(&db, "8517401", JD, JD + 2.0, 0.5, "").unwrap();
    for e in &ex.extremes {
        let k = fine
            .jd_utc
            .iter()
            .position(|t| (t - e.jd_utc).abs() * 1440.0 <= 0.25)
            .unwrap();
        assert!((fine.height_m[k] - e.height_m).abs() < 1e-4, "{e:?}");
    }
    let now = api::now(&db, "8517401", JD + 0.4, "").unwrap();
    assert_eq!(now.method, "interpolated");
    let e = api::extremes(&db, "8517401", JD, JD + 1.0, "MSL").unwrap_err();
    assert!(e.starts_with("datum_unavailable:"), "{e}");
}

#[test]
fn stations_nothing_can_be_predicted_for_say_so() {
    let db = db();
    // Carolina Forest: NOAA lists it but publishes no harmonic constants.
    let s = api::station_by_id(&db, "8660754").unwrap();
    assert_eq!(s.curve, "none");
    assert!(s.flags.contains(&"no_constants"));
    let e = api::extremes(&db, "8660754", JD, JD + 1.0, "").unwrap_err();
    assert!(e.starts_with("no_prediction:"), "{e}");
    // Holly Grove Plantation: NOAA serves no predictions for it.
    let s = api::station_by_id(&db, "8661558").unwrap();
    assert!(s.flags.contains(&"noaa_differs"));
    // Eugene Island: constants but no datums, so heights about MSL only.
    let s = api::station_by_id(&db, "8764311").unwrap();
    assert!(s.flags.contains(&"no_datums"));
    assert_eq!(s.default_datum, "MSL");
    assert_eq!(s.datums, vec!["MSL"]);
    assert!(api::extremes(&db, "8764311", JD, JD + 1.0, "").is_ok());
}

#[test]
fn bad_requests_are_refused_with_a_code() {
    let db = db();
    let cases = [
        (
            api::extremes(&db, "zzz", JD, JD + 1.0, "").unwrap_err(),
            "unknown_station:",
        ),
        (
            api::extremes(&db, "9414290", jd_year_start(1899), JD, "").unwrap_err(),
            "outside_range:",
        ),
        (
            api::extremes(&db, "9414290", JD, jd_year_start(2101) + 1.0, "").unwrap_err(),
            "outside_range:",
        ),
        (
            api::extremes(&db, "9414290", JD, JD + 401.0, "").unwrap_err(),
            "bad_request:",
        ),
        (
            api::extremes(&db, "9414290", JD + 1.0, JD, "").unwrap_err(),
            "bad_request:",
        ),
        (
            api::predict(&db, "9414290", JD, JD + 30.0, 1.0, "").unwrap_err(),
            "bad_request:",
        ),
        (
            api::predict(&db, "9414290", JD, JD + 1.0, 0.1, "").unwrap_err(),
            "bad_request:",
        ),
        (
            api::now(&db, "9414290", f64::NAN, "").unwrap_err(),
            "bad_request:",
        ),
        (
            api::stations_near(&db, 91.0, 0.0, 5).unwrap_err(),
            "bad_request:",
        ),
    ];
    for (e, code) in cases {
        assert!(e.starts_with(code), "{e} (expected {code})");
    }
    assert!(api::pack_not_loaded().starts_with("pack_not_loaded:"));
    // n is clamped to 1..=100.
    assert_eq!(api::stations_near(&db, 0.0, 0.0, 0).unwrap().len(), 1);
    assert_eq!(api::stations_near(&db, 0.0, 0.0, 500).unwrap().len(), 100);
}

#[test]
fn the_wire_shapes_serialise_with_the_documented_fields() {
    let db = db();
    let v = serde_json::to_value(api::extremes(&db, "1612340", JD, JD + 1.0, "").unwrap()).unwrap();
    for k in [
        "station", "datum", "method", "jd_start", "jd_end", "extremes", "label", "notes",
    ] {
        assert!(v.get(k).is_some(), "TideExtremes lacks {k}");
    }
    let st = &v["station"];
    for k in [
        "id",
        "name",
        "state",
        "lat_deg",
        "lon_deg",
        "kind",
        "reference_id",
        "reference_name",
        "tide_type",
        "form_number",
        "datums",
        "default_datum",
        "curve",
        "flags",
        "notes",
    ] {
        assert!(st.get(k).is_some(), "TideStation lacks {k}");
    }
    assert_eq!(st["name"], "Honolulu");
    let e = &v["extremes"][0];
    assert!(e["utc"].as_str().unwrap().ends_with('Z'));
    let near = serde_json::to_value(api::stations_near(&db, 21.3, -157.86, 2).unwrap()).unwrap();
    assert!(near[0].get("distance_nm").is_some() && near[0].get("id").is_some());
}
