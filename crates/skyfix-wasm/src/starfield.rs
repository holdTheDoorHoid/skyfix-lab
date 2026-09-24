//! WASM exports for the explorer: starfield.
//!
//! OWNER: star-field agent (wave 1). Wire format: docs/EXPLORER_API.md, "Wave 1 — star
//! field". Everything here is display-only (CONVENTIONS 13.6): `skyfix-starfield` never
//! feeds `reduce`, `solve`, the planner's navigation candidates or an accuracy claim.
//!
//! Numeric arrays cross the boundary as real typed arrays built with `js_sys`, never
//! as JSON arrays of numbers. Each export is a thin wrapper over a plain-Rust function
//! below it, because JS values cannot be created off wasm32 and the native tests call
//! the plain functions.

use js_sys::{Array, Float32Array, Float64Array, Int32Array, Object, Reflect};
use wasm_bindgen::prelude::*;

use skyfix_starfield::{BoundaryPolyline, Constellation};

fn js_err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

fn set(obj: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(obj, &JsValue::from_str(key), value).map(|_| ())
}

fn index(i: usize) -> JsValue {
    // Catalogue indices are < 10 000, exactly representable as JS numbers.
    JsValue::from(i as u32)
}

// ---------------------------------------------------------------------------
// Plain-Rust layer (tested natively)
// ---------------------------------------------------------------------------

/// `[ra_rad, dec_rad, ...]` for every star, apparent geocentric of date.
pub fn apparent(jd_utc: f64) -> Result<Vec<f64>, String> {
    skyfix_starfield::apparent_radec_all(jd_utc).map_err(|e| e.to_string())
}

/// The ICRS to true-of-date rotation, row-major.
pub fn frame_matrix_row_major(jd_utc: f64) -> Result<[f64; 9], String> {
    let m = skyfix_starfield::frame_matrix(jd_utc).map_err(|e| e.to_string())?;
    Ok([
        m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
    ])
}

/// IAU abbreviation of the constellation containing an apparent direction of date.
pub fn constellation(ra_deg: f64, dec_deg: f64, jd_utc: f64) -> Result<&'static str, String> {
    skyfix_starfield::constellation_at(ra_deg, dec_deg, jd_utc).map_err(|e| e.to_string())
}

/// Boundary polylines at J2000.
pub fn boundaries() -> Result<&'static [BoundaryPolyline], String> {
    skyfix_starfield::boundaries_j2000().map_err(|e| e.to_string())
}

/// `(name, index)` for the 58 navigational stars, in `skyfix_ephemeris` catalogue order.
pub fn navigational_indices() -> Result<Vec<(&'static str, usize)>, String> {
    Ok(skyfix_starfield::navigational()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| (m.name, m.index))
        .collect())
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// The display catalogue, once: `StarfieldCatalog` in docs/EXPLORER_API.md.
///
/// `{count, hr: Int32Array, vmag: Float32Array, bv: Float32Array (NaN when unknown),
/// names: [{index, name}], designations: string[], navigational: [{name, index}],
/// constellations: [{abbr, name, lines: [[i, j]], label_ra_deg, label_dec_deg}],
/// source, licence}`.
#[wasm_bindgen]
pub fn starfield_catalog() -> Result<JsValue, JsValue> {
    let cat = skyfix_starfield::catalog().map_err(js_err)?;
    let obj = Object::new();
    set(&obj, "count", &index(cat.len()))?;
    set(&obj, "hr", &Int32Array::from(cat.hr.as_slice()).into())?;
    set(
        &obj,
        "vmag",
        &Float32Array::from(cat.vmag.as_slice()).into(),
    )?;
    set(&obj, "bv", &Float32Array::from(cat.bv.as_slice()).into())?;

    let names = Array::new();
    for (i, name) in &cat.names {
        let o = Object::new();
        set(&o, "index", &index(*i))?;
        set(&o, "name", &JsValue::from_str(name))?;
        names.push(&o);
    }
    set(&obj, "names", &names)?;

    let designations = Array::new();
    for d in &cat.designations {
        designations.push(&JsValue::from_str(d));
    }
    set(&obj, "designations", &designations)?;

    let nav = Array::new();
    for (name, i) in navigational_indices().map_err(js_err)? {
        let o = Object::new();
        set(&o, "name", &JsValue::from_str(name))?;
        set(&o, "index", &index(i))?;
        nav.push(&o);
    }
    set(&obj, "navigational", &nav)?;

    let cons = Array::new();
    for c in skyfix_starfield::constellations().map_err(js_err)? {
        cons.push(&constellation_object(c)?);
    }
    set(&obj, "constellations", &cons)?;
    set(&obj, "source", &JsValue::from_str(skyfix_starfield::SOURCE))?;
    set(
        &obj,
        "licence",
        &JsValue::from_str(skyfix_starfield::LICENCE),
    )?;
    Ok(obj.into())
}

fn constellation_object(c: &Constellation) -> Result<JsValue, JsValue> {
    let o = Object::new();
    set(&o, "abbr", &JsValue::from_str(c.abbr))?;
    set(&o, "name", &JsValue::from_str(c.name))?;
    let lines = Array::new();
    for &(a, b) in &c.lines {
        lines.push(&Array::of2(&index(a), &index(b)));
    }
    set(&o, "lines", &lines)?;
    set(&o, "label_ra_deg", &JsValue::from_f64(c.label_ra_deg))?;
    set(&o, "label_dec_deg", &JsValue::from_f64(c.label_dec_deg))?;
    Ok(o.into())
}

/// Apparent geocentric places of date of every catalogue star, `[ra_rad, dec_rad, ...]`
/// (length `2 * count`), the frame of `sky_state`. Throws for a non-finite time or one
/// outside 1800-2200.
#[wasm_bindgen]
pub fn starfield_apparent(jd_utc: f64) -> Result<Float64Array, JsValue> {
    let v = apparent(jd_utc).map_err(js_err)?;
    Ok(Float64Array::from(v.as_slice()))
}

/// IAU abbreviation of the constellation containing an apparent direction of date.
/// Throws for non-finite input or a declination outside [-90, 90].
#[wasm_bindgen]
pub fn constellation_at(ra_deg: f64, dec_deg: f64, jd_utc: f64) -> Result<String, JsValue> {
    constellation(ra_deg, dec_deg, jd_utc)
        .map(str::to_string)
        .map_err(js_err)
}

/// The IAU boundaries for drawing: `[{abbr, ra_deg: Float64Array, dec_deg: Float64Array}]`,
/// closed polylines in ICRS (J2000) degrees, points at most 1 degree apart.
#[wasm_bindgen]
pub fn constellation_boundaries() -> Result<Array, JsValue> {
    let out = Array::new();
    for b in boundaries().map_err(js_err)? {
        let o = Object::new();
        set(&o, "abbr", &JsValue::from_str(b.abbr))?;
        set(
            &o,
            "ra_deg",
            &Float64Array::from(b.ra_deg.as_slice()).into(),
        )?;
        set(
            &o,
            "dec_deg",
            &Float64Array::from(b.dec_deg.as_slice()).into(),
        )?;
        out.push(&o);
    }
    Ok(out)
}

/// Extension to the wave-1 contract: the rotation from ICRS (J2000) to the true equator
/// and equinox of date (frame bias, precession, nutation), row-major, length 9:
/// `v_of_date[i] = sum_j m[3 i + j] * v_icrs[j]`. It lets the Sky view carry the J2000
/// boundaries and label positions into the frame of `starfield_apparent` without doing
/// astronomy in TypeScript. Annual aberration (at most 20.5") is not in it.
#[wasm_bindgen]
pub fn starfield_frame_matrix(jd_utc: f64) -> Result<Float64Array, JsValue> {
    let m = frame_matrix_row_major(jd_utc).map_err(js_err)?;
    Ok(Float64Array::from(&m[..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apparent_places_cover_the_catalogue() {
        let n = skyfix_starfield::catalog().unwrap().len();
        let v = apparent(2_461_308.0).unwrap();
        assert_eq!(v.len(), 2 * n);
        assert!(apparent(f64::NAN).unwrap_err().contains("finite"));
        assert!(apparent(1.0e7).unwrap_err().contains("outside"));
    }

    #[test]
    fn the_frame_matrix_is_a_rotation_that_matches_the_apparent_places() {
        let jd = 2_461_308.0;
        let m = frame_matrix_row_major(jd).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                let d: f64 = (0..3).map(|k| m[3 * i + k] * m[3 * j + k]).sum();
                assert!((d - f64::from(u8::from(i == j))).abs() < 1e-14);
            }
        }
        // Rotating Sirius's J2000 place gives its apparent place to within aberration,
        // deflection and 26 years of proper motion (well under an arcminute).
        let cat = skyfix_starfield::catalog().unwrap();
        let i = cat.index_of_hr(2491).unwrap();
        let (a, d) = (
            cat.ra_j2000_deg[i].to_radians(),
            cat.dec_j2000_deg[i].to_radians(),
        );
        let u = [d.cos() * a.cos(), d.cos() * a.sin(), d.sin()];
        let r: Vec<f64> = (0..3)
            .map(|k| (0..3).map(|j| m[3 * k + j] * u[j]).sum())
            .collect();
        let app = apparent(jd).unwrap();
        let (ra, dec) = (app[2 * i], app[2 * i + 1]);
        let w = [dec.cos() * ra.cos(), dec.cos() * ra.sin(), dec.sin()];
        let sep = (r[0] * w[0] + r[1] * w[1] + r[2] * w[2])
            .clamp(-1.0, 1.0)
            .acos()
            .to_degrees()
            * 60.0;
        assert!(sep < 1.0, "{sep}'");
    }

    #[test]
    fn constellation_lookups_and_errors() {
        // Vega, apparent of date in 2026 (from the explorer frame).
        assert_eq!(constellation(279.4, 38.8, 2_461_308.0).unwrap(), "Lyr");
        assert!(constellation(f64::NAN, 0.0, 2_461_308.0).is_err());
        assert!(constellation(0.0, 91.0, 2_461_308.0).is_err());
    }

    #[test]
    fn boundaries_and_navigational_indices() {
        assert_eq!(boundaries().unwrap().len(), 89);
        let nav = navigational_indices().unwrap();
        assert_eq!(nav.len(), 58);
        let cat = skyfix_starfield::catalog().unwrap();
        let (_, sirius) = nav.iter().find(|(n, _)| *n == "Sirius").unwrap();
        assert_eq!(cat.hr[*sirius], 2491);
    }
}
