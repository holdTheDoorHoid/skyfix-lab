//! The shipped deep-sky table against its two references (fixtures/reference/
//! dso_positions.json, written by tools/starfield/dso.py): every position within its
//! size-based tolerance of SIMBAD's and of Corwin's (2004) NGC/IC position, and the table
//! exactly the Wikidata values the build adopted.

use serde_json::Value;
use skyfix_starfield::dso::catalog;
use skyfix_starfield::observe::separation_deg;

fn fixture() -> Value {
    let path = format!(
        "{}/../../fixtures/reference/dso_positions.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

#[test]
fn every_object_agrees_with_simbad_and_corwin() {
    let f = fixture();
    let objs = f["objects"].as_array().unwrap();
    let table = catalog().unwrap();
    assert_eq!(objs.len(), table.len());
    let (mut n_sb, mut n_cw) = (0, 0);
    let (mut seps_sb, mut seps_cw) = (Vec::new(), Vec::new());
    for o in objs {
        let id = o["id"].as_str().unwrap();
        let d = table
            .iter()
            .find(|d| d.id == id)
            .unwrap_or_else(|| panic!("{id} missing"));
        let tol = o["tolerance_arcmin"].as_f64().unwrap();
        // The table carries the adopted Wikidata position, rounded to 1e-4 degree.
        let wd = &o["wikidata"];
        let s = separation_deg(
            d.ra_j2000_deg,
            d.dec_j2000_deg,
            wd["ra_deg"].as_f64().unwrap(),
            wd["dec_deg"].as_f64().unwrap(),
        ) * 60.0;
        assert!(s < 0.01, "{id}: {s}' from the adopted value");
        let sb = &o["simbad"];
        let s = separation_deg(
            d.ra_j2000_deg,
            d.dec_j2000_deg,
            sb["ra_deg"].as_f64().unwrap(),
            sb["dec_deg"].as_f64().unwrap(),
        ) * 60.0;
        assert!(s <= tol + 0.01, "{id}: {s}' from SIMBAD (tolerance {tol}')");
        seps_sb.push(s);
        n_sb += 1;
        if let Some(cw) = o["corwin"].as_object() {
            let s = separation_deg(
                d.ra_j2000_deg,
                d.dec_j2000_deg,
                cw["ra_deg"].as_f64().unwrap(),
                cw["dec_deg"].as_f64().unwrap(),
            ) * 60.0;
            assert!(s <= tol + 0.01, "{id}: {s}' from Corwin (tolerance {tol}')");
            seps_cw.push(s);
            n_cw += 1;
        }
    }
    seps_sb.sort_by(f64::total_cmp);
    seps_cw.sort_by(f64::total_cmp);
    let pct = |v: &[f64], p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    println!(
        "SIMBAD: {n_sb} objects, median {:.3}', 90% {:.3}', max {:.2}'; Corwin: {n_cw} objects, median {:.3}', 90% {:.3}', max {:.2}'",
        pct(&seps_sb, 0.5),
        pct(&seps_sb, 0.9),
        pct(&seps_sb, 1.0),
        pct(&seps_cw, 0.5),
        pct(&seps_cw, 0.9),
        pct(&seps_cw, 1.0)
    );
    assert_eq!(n_sb, 213);
    assert!(n_cw >= 200);
    // Objects with a well-defined centre (globular clusters, planetary nebulae and
    // galaxies under 20') agree with Corwin, whose positions are independent of
    // Wikidata's, to better than half an arcminute.
    let centred: Vec<f64> = objs
        .iter()
        .filter(|o| {
            ["gc", "pn", "sg", "eg", "lg", "ig"].contains(&o["type"].as_str().unwrap())
                && o["major_arcmin"].as_f64().unwrap() < 20.0
                && o["corwin"].is_object()
        })
        .map(|o| o["sep_corwin_arcmin"].as_f64().unwrap())
        .collect();
    let worst = centred.iter().copied().fold(0.0, f64::max);
    println!(
        "{} well-centred objects: worst {worst:.3}' from Corwin",
        centred.len()
    );
    assert!(
        centred.len() >= 100 && worst < 0.5,
        "{} {worst}",
        centred.len()
    );
}
