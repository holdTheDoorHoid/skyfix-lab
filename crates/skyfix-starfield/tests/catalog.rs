//! The embedded catalogue: counts, exclusions, designations, names and the
//! navigational cross-identification.

use serde_json::Value;

const MANIFEST: &str = include_str!("../data/manifest.json");

fn manifest() -> Value {
    serde_json::from_str(MANIFEST).unwrap()
}

#[test]
fn counts_match_the_build_manifest() {
    let m = manifest();
    let cat = skyfix_starfield::catalog().unwrap();
    let counts = &m["counts"];
    assert_eq!(cat.len() as u64, counts["stars"].as_u64().unwrap());
    assert_eq!(cat.len(), 9_095);
    assert_eq!(
        cat.bv.iter().filter(|b| b.is_nan()).count() as u64,
        counts["without_bv"].as_u64().unwrap()
    );
    assert_eq!(cat.names.len() as u64, counts["names"].as_u64().unwrap());
    assert_eq!(
        cat.designations.iter().filter(|d| !d.is_empty()).count() as u64,
        counts["with_designation"].as_u64().unwrap()
    );
    assert!(cat.hr.windows(2).all(|w| w[0] < w[1]), "HR order");
    // The 14 non-stellar entries and T CrB are not in the display catalogue.
    for hr in [
        92, 95, 182, 1057, 1841, 2472, 2496, 3515, 3671, 6309, 6515, 7189, 7539, 8296, 5958,
    ] {
        assert!(cat.index_of_hr(hr).is_none(), "HR {hr} should be left out");
    }
    let vmin = cat.vmag.iter().copied().fold(f32::INFINITY, f32::min);
    let vmax = cat.vmag.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    assert!(
        (-1.47..-1.45).contains(&vmin) && (7.9..8.0).contains(&vmax),
        "{vmin} {vmax}"
    );
}

#[test]
fn designations_and_names() {
    let cat = skyfix_starfield::catalog().unwrap();
    let at = |hr: i32| cat.index_of_hr(hr).unwrap();
    assert_eq!(cat.designations[at(2061)], "α Ori");
    assert_eq!(cat.name_of(at(2061)), Some("Betelgeuse"));
    assert_eq!(cat.designations[at(4730)], "α¹ Cru");
    assert_eq!(cat.name_of(at(4730)), Some("Acrux"));
    assert_eq!(cat.designations[at(3)], "33 Psc");
    assert_eq!(cat.designations[at(1)], "");
    assert_eq!(cat.name_of(at(1)), None);
    assert_eq!(cat.designations[at(2491)], "α CMa");
    assert_eq!(cat.name_of(at(2491)), Some("Sirius"));
    assert_eq!(cat.name_of(at(7001)), Some("Vega"));
    assert_eq!(cat.name_of(at(8425)), Some("Al Na'ir"));
    // B-V: Betelgeuse is red, Rigel blue-white.
    assert!(cat.bv[at(2061)] > 1.5 && cat.bv[at(1713)] < 0.0);
    // Names go to the brighter stars.
    for (i, name) in &cat.names {
        assert!(cat.vmag[*i] < 6.0, "{name} is V {}", cat.vmag[*i]);
    }
}

#[test]
fn all_58_navigational_stars_are_found_by_position_and_magnitude() {
    let cat = skyfix_starfield::catalog().unwrap();
    let nav = skyfix_starfield::navigational().unwrap();
    assert_eq!(nav.len(), 58);
    let mut worst_sep = 0.0f64;
    let mut worst_dm = 0.0f64;
    for m in nav {
        assert!(
            m.separation_arcsec < 60.0 && m.magnitude_difference.abs() <= 1.0,
            "{m:?}"
        );
        worst_sep = worst_sep.max(m.separation_arcsec);
        worst_dm = worst_dm.max(m.magnitude_difference.abs());
        // The name list agrees with the positional match.
        assert_eq!(cat.name_of(m.index), Some(m.name), "{m:?}");
    }
    let hr = |name: &str| nav.iter().find(|m| m.name == name).unwrap().hr;
    assert_eq!(hr("Sirius"), 2491);
    assert_eq!(hr("Vega"), 7001);
    assert_eq!(hr("Polaris"), 424);
    // The brighter components of the close pairs, as the Almanac tabulates.
    assert_eq!(hr("Rigil Kentaurus"), 5459);
    assert_eq!(hr("Acrux"), 4730);
    assert_eq!(hr("Acamar"), 897);
    assert_eq!(hr("Zubenelgenubi"), 5531);
    let mut idx: Vec<usize> = nav.iter().map(|m| m.index).collect();
    idx.sort_unstable();
    idx.dedup();
    assert_eq!(
        idx.len(),
        58,
        "two navigational stars matched the same entry"
    );
    println!("worst separation {worst_sep:.2}\", worst magnitude difference {worst_dm:.2}");
}
