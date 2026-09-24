//! Constellations: this project's stick figures, label positions, the IAU boundaries,
//! and which constellation a direction lies in.
//!
//! ## Boundaries
//!
//! The IAU boundaries (Delporte 1930) are defined in the mean equator and equinox of
//! B1875.0, where every edge is an arc of an hour circle or of a parallel of
//! declination and every corner is on a grid of whole seconds of time and whole
//! arcminutes. `data/boundaries.txt` holds those corners as exact integers, one
//! polygon per line (Serpens has two parts). The build (`tools/starfield/build.py`)
//! checks the polygons tile the sky exactly and agree, cell for cell, with Skyfield's
//! independently digitised map.
//!
//! **Point in polygon.** Cast a ray from the point along its hour circle to the north
//! celestial pole and count the parallel edges it crosses: those strictly north of the
//! point whose RA span covers the point's hour circle. Hour-circle edges run along the
//! ray and are never crossed. An odd count means inside, except for Ursa Minor, the one
//! polygon that contains the pole, where the ray ends inside and the parity flips.
//! RA spans are half-open `[west end, east end)` and the latitude test is strict, so a
//! point exactly on a boundary belongs to the constellation east of an hour-circle edge
//! and north of a parallel edge; with integer corners that rule is exact, and every
//! point of the sky belongs to exactly one polygon.
//!
//! **Frames.** [`constellation_at`] takes an apparent direction of date (the explorer's
//! frame), rotates it back to ICRS with the transpose of the bias-precession-nutation
//! matrix of date, and forward to the mean equator and equinox of B1875.0 with the IAU
//! 2006 bias and precession (Fukushima-Williams angles; no nutation, because the IAU
//! boundaries are in the mean frame). It is a rotation only: annual aberration (up to
//! 20.5") is not removed, so a body within 20" of a boundary may be attributed to its
//! neighbour, and the answer is always the region the direction points into.
//! [`boundaries_j2000`] carries the corners the other way, B1875 to ICRS, after
//! interpolating every edge at 1 degree steps (precession turns parallels of B1875 into
//! curves).
//!
//! ## Figures and labels
//!
//! `data/figures.txt` is this project's own drawing: star pairs by HR number, written
//! from designations in `tools/starfield/figures.txt`, with a label position per
//! constellation (the figure's centre, moved inside the boundary when the centre is
//! outside it or too close to it). Label positions are ICRS directions.

use std::sync::OnceLock;

use skyfix_core::time::jd_tt;
use skyfix_ephemeris::frames::{bias_precession_nutation_matrix, fukushima_williams_2006};

use crate::{Catalog, StarfieldError, check_jd_utc, starfield};

const FIGURES_TXT: &str = include_str!("../data/figures.txt");
const BOUNDARIES_TXT: &str = include_str!("../data/boundaries.txt");

/// The 88 IAU constellations, abbreviation and name, in the IAU's alphabetical order.
/// The index is the constellation code stored in `stars.bin`.
pub const CONSTELLATIONS: [(&str, &str); 88] = [
    ("And", "Andromeda"),
    ("Ant", "Antlia"),
    ("Aps", "Apus"),
    ("Aqr", "Aquarius"),
    ("Aql", "Aquila"),
    ("Ara", "Ara"),
    ("Ari", "Aries"),
    ("Aur", "Auriga"),
    ("Boo", "Boötes"),
    ("Cae", "Caelum"),
    ("Cam", "Camelopardalis"),
    ("Cnc", "Cancer"),
    ("CVn", "Canes Venatici"),
    ("CMa", "Canis Major"),
    ("CMi", "Canis Minor"),
    ("Cap", "Capricornus"),
    ("Car", "Carina"),
    ("Cas", "Cassiopeia"),
    ("Cen", "Centaurus"),
    ("Cep", "Cepheus"),
    ("Cet", "Cetus"),
    ("Cha", "Chamaeleon"),
    ("Cir", "Circinus"),
    ("Col", "Columba"),
    ("Com", "Coma Berenices"),
    ("CrA", "Corona Australis"),
    ("CrB", "Corona Borealis"),
    ("Crv", "Corvus"),
    ("Crt", "Crater"),
    ("Cru", "Crux"),
    ("Cyg", "Cygnus"),
    ("Del", "Delphinus"),
    ("Dor", "Dorado"),
    ("Dra", "Draco"),
    ("Equ", "Equuleus"),
    ("Eri", "Eridanus"),
    ("For", "Fornax"),
    ("Gem", "Gemini"),
    ("Gru", "Grus"),
    ("Her", "Hercules"),
    ("Hor", "Horologium"),
    ("Hya", "Hydra"),
    ("Hyi", "Hydrus"),
    ("Ind", "Indus"),
    ("Lac", "Lacerta"),
    ("Leo", "Leo"),
    ("LMi", "Leo Minor"),
    ("Lep", "Lepus"),
    ("Lib", "Libra"),
    ("Lup", "Lupus"),
    ("Lyn", "Lynx"),
    ("Lyr", "Lyra"),
    ("Men", "Mensa"),
    ("Mic", "Microscopium"),
    ("Mon", "Monoceros"),
    ("Mus", "Musca"),
    ("Nor", "Norma"),
    ("Oct", "Octans"),
    ("Oph", "Ophiuchus"),
    ("Ori", "Orion"),
    ("Pav", "Pavo"),
    ("Peg", "Pegasus"),
    ("Per", "Perseus"),
    ("Phe", "Phoenix"),
    ("Pic", "Pictor"),
    ("Psc", "Pisces"),
    ("PsA", "Piscis Austrinus"),
    ("Pup", "Puppis"),
    ("Pyx", "Pyxis"),
    ("Ret", "Reticulum"),
    ("Sge", "Sagitta"),
    ("Sgr", "Sagittarius"),
    ("Sco", "Scorpius"),
    ("Scl", "Sculptor"),
    ("Sct", "Scutum"),
    ("Ser", "Serpens"),
    ("Sex", "Sextans"),
    ("Tau", "Taurus"),
    ("Tel", "Telescopium"),
    ("Tri", "Triangulum"),
    ("TrA", "Triangulum Australe"),
    ("Tuc", "Tucana"),
    ("UMa", "Ursa Major"),
    ("UMi", "Ursa Minor"),
    ("Vel", "Vela"),
    ("Vir", "Virgo"),
    ("Vol", "Volans"),
    ("Vul", "Vulpecula"),
];

/// Besselian epoch 1875.0 as a TT Julian date:
/// `2415020.31352 + (1875 - 1900) * 365.242198781`.
pub const B1875_JD_TT: f64 = 2_405_889.258_550_475;

const DAY_S: i32 = 86_400;
const HALF_DAY_S: i32 = 43_200;
/// Longest step between interpolated points of a drawn boundary, degrees of arc.
const BOUNDARY_STEP_DEG: f64 = 1.0;

type Mat3 = [[f64; 3]; 3];

/// One constellation as the browser draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct Constellation {
    pub abbr: &'static str,
    pub name: &'static str,
    /// Stick-figure segments as pairs of catalogue indices.
    pub lines: Vec<(usize, usize)>,
    /// Where to put the name: an ICRS (J2000) direction inside the boundary.
    pub label_ra_deg: f64,
    pub label_dec_deg: f64,
}

/// One closed boundary polygon for drawing, ICRS (J2000) degrees. The last point
/// repeats the first. Serpens appears twice (Caput and Cauda); shared edges appear once
/// in each of the two constellations they separate.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryPolyline {
    pub abbr: &'static str,
    pub ra_deg: Vec<f64>,
    pub dec_deg: Vec<f64>,
}

/// A boundary polygon in B1875.0 with its point-in-polygon bookkeeping.
#[derive(Debug, Clone)]
pub(crate) struct Region {
    pub(crate) abbr_index: usize,
    /// Corners: (RA seconds of time in [0, 86400), Dec arcminutes).
    pub(crate) corners: Vec<(i32, i32)>,
    /// Parallel edges: (Dec arcminutes, west end seconds, span seconds).
    parallels: Vec<(i32, i32, i32)>,
    contains_ncp: bool,
    /// Winds once around a pole (Ursa Minor, Octans).
    winds: bool,
    /// Southernmost and northernmost corner, arcminutes.
    min_dec_m: f64,
    max_dec_m: f64,
}

impl Region {
    fn new(abbr_index: usize, corners: Vec<(i32, i32)>) -> Result<Self, StarfieldError> {
        let abbr = CONSTELLATIONS[abbr_index].0;
        let mut parallels = Vec::new();
        let mut winding: i64 = 0;
        let n = corners.len();
        if n < 4 {
            return Err(StarfieldError::Data(format!(
                "{abbr}: fewer than 4 corners"
            )));
        }
        for i in 0..n {
            let (a1, d1) = corners[i];
            let (a2, d2) = corners[(i + 1) % n];
            if (a1, d1) == (a2, d2) {
                continue;
            }
            if d1 == d2 {
                let delta = (a2 - a1 + HALF_DAY_S).rem_euclid(DAY_S) - HALF_DAY_S;
                if delta == -HALF_DAY_S {
                    return Err(StarfieldError::Data(format!(
                        "{abbr}: a 12-hour parallel edge is ambiguous"
                    )));
                }
                let west = if delta > 0 { a1 } else { a2 };
                parallels.push((d1, west, delta.abs()));
                winding += i64::from(delta);
            } else if a1 != a2 {
                return Err(StarfieldError::Data(format!(
                    "{abbr}: an edge is neither an hour circle nor a parallel"
                )));
            }
        }
        if winding != 0 && winding.abs() != i64::from(DAY_S) {
            return Err(StarfieldError::Data(format!("{abbr}: winding {winding} s")));
        }
        let mean_dec: f64 = corners.iter().map(|&(_, d)| f64::from(d)).sum::<f64>() / n as f64;
        let min_dec_m = corners.iter().map(|&(_, d)| d).min().map_or(0.0, f64::from);
        let max_dec_m = corners.iter().map(|&(_, d)| d).max().map_or(0.0, f64::from);
        Ok(Region {
            abbr_index,
            corners,
            parallels,
            contains_ncp: winding != 0 && mean_dec > 0.0,
            winds: winding != 0,
            min_dec_m,
            max_dec_m,
        })
    }

    /// A cheap necessary condition for [`Region::contains`]. A polygon that does not
    /// wind round a pole cannot contain a point north of its northernmost corner (the
    /// ray crosses nothing) or south of its southernmost (the ray crosses its boundary
    /// an even number of times), so only its own band of declination needs the full
    /// test; the two polar polygons always get it.
    fn may_contain(&self, dec_m: f64) -> bool {
        self.winds || (self.min_dec_m <= dec_m && dec_m < self.max_dec_m)
    }

    /// Point in polygon; `ra_s` in seconds of time `[0, 86400)`, `dec_m` in arcminutes.
    fn contains(&self, ra_s: f64, dec_m: f64) -> bool {
        let mut crossings = 0u32;
        for &(d, west, span) in &self.parallels {
            if f64::from(d) > dec_m {
                // Both RAs are in [0, 86400), so one conditional turn wraps the
                // difference into [0, 86400) exactly (no fmod).
                let mut x = ra_s - f64::from(west);
                if x < 0.0 {
                    x += 86_400.0;
                }
                if x < f64::from(span) {
                    crossings += 1;
                }
            }
        }
        (crossings % 2 == 1) != self.contains_ncp
    }

    fn corner_deg(&self, i: usize) -> (f64, f64) {
        let (a, d) = self.corners[i % self.corners.len()];
        (f64::from(a) / 240.0, f64::from(d) / 60.0)
    }

    /// Great-circle distance from a B1875 point to the nearest edge, degrees.
    fn distance_deg(&self, ra_deg: f64, dec_deg: f64) -> f64 {
        (0..self.corners.len())
            .map(|i| {
                let (a1, d1) = self.corner_deg(i);
                let (a2, d2) = self.corner_deg(i + 1);
                distance_to_edge_deg(ra_deg, dec_deg, a1, d1, a2, d2)
            })
            .fold(f64::INFINITY, f64::min)
    }
}

fn wrap180(x: f64) -> f64 {
    (x + 180.0).rem_euclid(360.0) - 180.0
}

fn unit(ra_deg: f64, dec_deg: f64) -> [f64; 3] {
    let (sa, ca) = ra_deg.to_radians().sin_cos();
    let (sd, cd) = dec_deg.to_radians().sin_cos();
    [cd * ca, cd * sa, sd]
}

/// Wrap into `[0, limit)`. `rem_euclid` alone can return `limit` itself for a value a
/// hair below zero, which would put a point on 0h on the wrong side of the meridian.
fn wrap_to(x: f64, limit: f64) -> f64 {
    let w = x.rem_euclid(limit);
    if w >= limit { 0.0 } else { w }
}

fn radec(v: [f64; 3]) -> (f64, f64) {
    let r = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let ra = wrap_to(v[1].atan2(v[0]).to_degrees(), 360.0);
    (ra, (v[2] / r).clamp(-1.0, 1.0).asin().to_degrees())
}

fn separation_deg(a1: f64, d1: f64, a2: f64, d2: f64) -> f64 {
    let (u, v) = (unit(a1, d1), unit(a2, d2));
    // atan2 of |u x v| and u.v: accurate at every separation.
    let c = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    s.atan2(u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
        .to_degrees()
}

fn distance_to_edge_deg(ra: f64, dec: f64, a1: f64, d1: f64, a2: f64, d2: f64) -> f64 {
    let ends = separation_deg(ra, dec, a1, d1).min(separation_deg(ra, dec, a2, d2));
    if d1 == d2 {
        // Arc of a parallel: the nearest point is on the point's own hour circle when
        // that hour circle crosses the arc.
        let delta = wrap180(a2 - a1);
        let west = if delta > 0.0 { a1 } else { a2 };
        if (ra - west).rem_euclid(360.0) <= delta.abs() {
            return (dec - d1).abs().min(ends);
        }
        return ends;
    }
    // Arc of an hour circle (a great circle through the poles).
    let dra = wrap180(ra - a1).to_radians();
    let p = dec.to_radians();
    let foot = p.sin().atan2(p.cos() * dra.cos()).to_degrees();
    let (lo, hi) = (d1.min(d2), d1.max(d2));
    if dra.cos() > 0.0 && (lo..=hi).contains(&foot) {
        return (p.cos() * dra.sin())
            .abs()
            .clamp(0.0, 1.0)
            .asin()
            .to_degrees();
    }
    ends
}

/// Build `R1(-eps) R3(-psi) R1(phi) R3(gamma)` from Fukushima-Williams angles (the
/// construction of `eraFw2m`).
fn fw_matrix(gamma: f64, phi: f64, psi: f64, eps: f64) -> Mat3 {
    fn rot_x(a: f64, m: &mut Mat3) {
        let (s, c) = a.sin_cos();
        let (r1, r2) = (m[1], m[2]);
        for k in 0..3 {
            m[1][k] = c * r1[k] + s * r2[k];
            m[2][k] = -s * r1[k] + c * r2[k];
        }
    }
    fn rot_z(a: f64, m: &mut Mat3) {
        let (s, c) = a.sin_cos();
        let (r0, r1) = (m[0], m[1]);
        for k in 0..3 {
            m[0][k] = c * r0[k] + s * r1[k];
            m[1][k] = -s * r0[k] + c * r1[k];
        }
    }
    let mut m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    rot_z(gamma, &mut m);
    rot_x(phi, &mut m);
    rot_z(-psi, &mut m);
    rot_x(-eps, &mut m);
    m
}

/// ICRS to the mean equator and equinox of B1875.0: frame bias and IAU 2006
/// precession, no nutation.
pub fn icrs_to_mean_b1875() -> &'static Mat3 {
    static M: OnceLock<Mat3> = OnceLock::new();
    M.get_or_init(|| {
        let fw = fukushima_williams_2006(B1875_JD_TT);
        fw_matrix(
            fw.gamma_bar_rad,
            fw.phi_bar_rad,
            fw.psi_bar_rad,
            fw.eps_a_rad,
        )
    })
}

fn mul(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn mul_t(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

fn check_direction(ra_deg: f64, dec_deg: f64) -> Result<(), StarfieldError> {
    if !ra_deg.is_finite() {
        return Err(StarfieldError::NotFinite("ra_deg"));
    }
    if !dec_deg.is_finite() {
        return Err(StarfieldError::NotFinite("dec_deg"));
    }
    if !(-90.0..=90.0).contains(&dec_deg) {
        return Err(StarfieldError::Declination(dec_deg));
    }
    Ok(())
}

/// An apparent direction of date (degrees) in the mean equator and equinox of B1875.0
/// (degrees, RA `[0, 360)`).
pub fn apparent_to_b1875(
    ra_deg: f64,
    dec_deg: f64,
    jd_utc: f64,
) -> Result<(f64, f64), StarfieldError> {
    check_direction(ra_deg, dec_deg)?;
    check_jd_utc(jd_utc)?;
    Ok(radec(mul(&of_date_to_b1875(jd_utc), unit(ra_deg, dec_deg))))
}

/// `P_B1875 B (N P B)(t)^T`: apparent-of-date to mean B1875, cached for the last
/// instant asked for. The nutation series behind the matrix of date is most of the
/// cost of a lookup, and `sky_state` asks for many bodies at one instant.
fn of_date_to_b1875(jd_utc: f64) -> Mat3 {
    use std::cell::Cell;
    thread_local! {
        static LAST: Cell<Option<(u64, Mat3)>> = const { Cell::new(None) };
    }
    let key = jd_utc.to_bits();
    if let Some((k, m)) = LAST.get() {
        if k == key {
            return m;
        }
    }
    let of_date = bias_precession_nutation_matrix(jd_tt(jd_utc));
    let b = icrs_to_mean_b1875();
    let mut m = [[0.0; 3]; 3];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, x) in row.iter_mut().enumerate() {
            // (B1875 * of_date^T)[i][j] = sum_k b[i][k] * of_date[j][k]
            *x = (0..3).map(|k| b[i][k] * of_date[j][k]).sum();
        }
    }
    LAST.set(Some((key, m)));
    m
}

/// An ICRS (J2000) direction in the mean equator and equinox of B1875.0, degrees.
pub fn icrs_to_b1875(ra_deg: f64, dec_deg: f64) -> (f64, f64) {
    radec(mul(icrs_to_mean_b1875(), unit(ra_deg, dec_deg)))
}

/// The constellation containing a point given in the mean equator and equinox of
/// B1875.0 (degrees). `None` for a non-finite coordinate or a declination outside
/// [-90, 90] (or if the embedded data failed to load).
pub fn constellation_at_b1875(ra_deg: f64, dec_deg: f64) -> Option<&'static str> {
    check_direction(ra_deg, dec_deg).ok()?;
    let sf = starfield().ok()?;
    let ra_s = wrap_to(ra_deg * 240.0, 86_400.0);
    let dec_m = dec_deg * 60.0;
    sf.regions
        .iter()
        .find(|r| r.may_contain(dec_m) && r.contains(ra_s, dec_m))
        .map(|r| CONSTELLATIONS[r.abbr_index].0)
}

/// Every region claiming a B1875 point, by the full point-in-polygon test on all 89
/// polygons. Exactly one for any point of the sky; exposed so the tests can prove it,
/// and prove that [`constellation_at_b1875`]'s shortcut finds the same one.
pub fn regions_containing_b1875(ra_deg: f64, dec_deg: f64) -> Vec<&'static str> {
    let (Ok(()), Ok(sf)) = (check_direction(ra_deg, dec_deg), starfield()) else {
        return Vec::new();
    };
    let ra_s = wrap_to(ra_deg * 240.0, 86_400.0);
    let dec_m = dec_deg * 60.0;
    // The full test on every region, without the declination prefilter that
    // `constellation_at_b1875` uses, so the tests can hold one against the other.
    sf.regions
        .iter()
        .filter(|r| r.contains(ra_s, dec_m))
        .map(|r| CONSTELLATIONS[r.abbr_index].0)
        .collect()
}

/// Great-circle distance, degrees, from a B1875 point to the nearest constellation
/// boundary.
pub fn boundary_distance_b1875_deg(ra_deg: f64, dec_deg: f64) -> f64 {
    starfield().map_or(f64::NAN, |sf| {
        sf.regions
            .iter()
            .map(|r| r.distance_deg(ra_deg, dec_deg))
            .fold(f64::INFINITY, f64::min)
    })
}

/// IAU abbreviation of the constellation containing an apparent direction of date
/// (the frame of `sky_state` and [`crate::apparent_radec_all`]). See the module
/// documentation for the frame handling.
pub fn constellation_at(
    ra_deg: f64,
    dec_deg: f64,
    jd_utc: f64,
) -> Result<&'static str, StarfieldError> {
    let (ra, dec) = apparent_to_b1875(ra_deg, dec_deg, jd_utc)?;
    constellation_at_b1875(ra, dec)
        .ok_or_else(|| StarfieldError::Data(format!("no constellation claims B1875 ({ra}, {dec})")))
}

/// Parse `boundaries.txt`.
pub(crate) fn parse_regions() -> Result<Vec<Region>, StarfieldError> {
    let mut regions = Vec::new();
    for line in BOUNDARIES_TXT.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('|');
        let (Some(abbr), Some(_part), Some(corners), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(StarfieldError::Data(format!("boundaries.txt: {line:?}")));
        };
        let idx = CONSTELLATIONS
            .iter()
            .position(|(a, _)| *a == abbr)
            .ok_or_else(|| StarfieldError::Data(format!("boundaries.txt: unknown {abbr:?}")))?;
        let corners = corners
            .split_whitespace()
            .map(|pair| {
                let (a, d) = pair.split_once(',')?;
                let (a, d) = (a.parse::<i32>().ok()?, d.parse::<i32>().ok()?);
                ((0..DAY_S).contains(&a) && (-5400..=5400).contains(&d)).then_some((a, d))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| StarfieldError::Data(format!("boundaries.txt: bad corner in {abbr}")))?;
        regions.push(Region::new(idx, corners)?);
    }
    let mut seen = [false; 88];
    for r in &regions {
        seen[r.abbr_index] = true;
    }
    let ncp: Vec<_> = regions.iter().filter(|r| r.contains_ncp).collect();
    if !seen.iter().all(|&s| s) || ncp.len() != 1 || CONSTELLATIONS[ncp[0].abbr_index].0 != "UMi" {
        return Err(StarfieldError::Data(
            "boundaries.txt: not the 88 constellations with Ursa Minor at the pole".into(),
        ));
    }
    Ok(regions)
}

/// Parse `figures.txt` against the catalogue.
pub(crate) fn parse_figures(catalog: &Catalog) -> Result<Vec<Constellation>, StarfieldError> {
    let mut out = Vec::with_capacity(88);
    for line in FIGURES_TXT.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split('|').collect();
        let bad = || StarfieldError::Data(format!("figures.txt: {line:?}"));
        if f.len() != 5 {
            return Err(bad());
        }
        let k = out.len();
        if k >= 88 || CONSTELLATIONS[k].0 != f[0] || CONSTELLATIONS[k].1 != f[1] {
            return Err(StarfieldError::Data(format!(
                "figures.txt: line {} is {:?}, expected {:?} in IAU order",
                k + 1,
                f[0],
                CONSTELLATIONS.get(k).map(|c| c.0)
            )));
        }
        let label_ra_deg: f64 = f[2].parse().map_err(|_| bad())?;
        let label_dec_deg: f64 = f[3].parse().map_err(|_| bad())?;
        let mut lines = Vec::new();
        for pair in f[4].split_whitespace() {
            let (a, b) = pair.split_once('-').ok_or_else(bad)?;
            let a: i32 = a.parse().map_err(|_| bad())?;
            let b: i32 = b.parse().map_err(|_| bad())?;
            let ia = catalog.index_of_hr(a).ok_or_else(|| {
                StarfieldError::Data(format!(
                    "figures.txt: {} uses HR {a}, not in the catalogue",
                    f[0]
                ))
            })?;
            let ib = catalog.index_of_hr(b).ok_or_else(|| {
                StarfieldError::Data(format!(
                    "figures.txt: {} uses HR {b}, not in the catalogue",
                    f[0]
                ))
            })?;
            lines.push((ia, ib));
        }
        if lines.is_empty() {
            return Err(bad());
        }
        out.push(Constellation {
            abbr: CONSTELLATIONS[k].0,
            name: CONSTELLATIONS[k].1,
            lines,
            label_ra_deg,
            label_dec_deg,
        });
    }
    if out.len() != 88 {
        return Err(StarfieldError::Data(format!(
            "figures.txt: {} constellations, expected 88",
            out.len()
        )));
    }
    Ok(out)
}

/// The boundary polygons for drawing, in ICRS (J2000) degrees, interpolated at 1-degree
/// steps and closed (see [`BoundaryPolyline`]). Built on first use.
pub fn boundaries_j2000() -> Result<&'static [BoundaryPolyline], StarfieldError> {
    static CELL: OnceLock<Result<Vec<BoundaryPolyline>, StarfieldError>> = OnceLock::new();
    CELL.get_or_init(|| {
        let sf = starfield()?;
        Ok(sf.regions.iter().map(polyline_j2000).collect())
    })
    .as_ref()
    .map(Vec::as_slice)
    .map_err(Clone::clone)
}

fn polyline_j2000(r: &Region) -> BoundaryPolyline {
    let m = icrs_to_mean_b1875();
    let mut ra_deg = Vec::new();
    let mut dec_deg = Vec::new();
    let mut push = |a: f64, d: f64| {
        let (ra, dec) = radec(mul_t(m, unit(a, d)));
        ra_deg.push(ra);
        dec_deg.push(dec);
    };
    let n = r.corners.len();
    for i in 0..n {
        let (a1, d1) = r.corner_deg(i);
        let (a2, d2) = r.corner_deg(i + 1);
        let (steps, da, dd) = if d1 == d2 {
            let da = wrap180(a2 - a1);
            let arc = da.abs() * d1.to_radians().cos();
            ((arc / BOUNDARY_STEP_DEG).ceil().max(1.0), da, 0.0)
        } else {
            let dd = d2 - d1;
            ((dd.abs() / BOUNDARY_STEP_DEG).ceil().max(1.0), 0.0, dd)
        };
        let steps = steps as usize;
        for k in 0..steps {
            let f = k as f64 / steps as f64;
            push(a1 + f * da, d1 + f * dd);
        }
    }
    let (a0, d0) = r.corner_deg(0);
    push(a0, d0);
    BoundaryPolyline {
        abbr: CONSTELLATIONS[r.abbr_index].0,
        ra_deg,
        dec_deg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fw_construction_matches_the_ephemeris_matrix() {
        // With nutation added to psi and eps, fw_matrix must reproduce
        // frames::bias_precession_nutation_matrix exactly.
        let jd = 2_461_308.0;
        let fw = fukushima_williams_2006(jd);
        let nut = skyfix_ephemeris::frames::nutation_2000b_p03(jd);
        let a = fw_matrix(
            fw.gamma_bar_rad,
            fw.phi_bar_rad,
            fw.psi_bar_rad + nut.dpsi_rad,
            fw.eps_a_rad + nut.deps_rad,
        );
        let b = bias_precession_nutation_matrix(jd);
        for i in 0..3 {
            for j in 0..3 {
                assert!((a[i][j] - b[i][j]).abs() < 1e-15, "{i}{j}");
            }
        }
    }

    #[test]
    fn b1875_epoch_is_the_besselian_year() {
        let jd = 2_415_020.313_52 + (1875.0 - 1900.0) * 365.242_198_781;
        assert!((B1875_JD_TT - jd).abs() < 1e-9);
    }

    #[test]
    fn the_poles_and_some_bright_stars_land_where_they_should() {
        assert_eq!(constellation_at_b1875(0.0, 89.99), Some("UMi"));
        assert_eq!(constellation_at_b1875(180.0, -89.99), Some("Oct"));
        // Vega, Betelgeuse, Sirius at J2000 (their catalogue places).
        let (a, d) = icrs_to_b1875(279.2347, 38.7837);
        assert_eq!(constellation_at_b1875(a, d), Some("Lyr"));
        let (a, d) = icrs_to_b1875(88.7929, 7.4071);
        assert_eq!(constellation_at_b1875(a, d), Some("Ori"));
        let (a, d) = icrs_to_b1875(101.2872, -16.7161);
        assert_eq!(constellation_at_b1875(a, d), Some("CMa"));
    }

    #[test]
    fn wrapping_never_returns_the_limit() {
        assert_eq!(wrap_to(-1e-30, 360.0), 0.0);
        assert_eq!(wrap_to(360.0, 360.0), 0.0);
        assert_eq!(wrap_to(-90.0, 360.0), 270.0);
        // A value a hair below 0h is 0h, not 24h: both land in the same constellation.
        assert_eq!(
            constellation_at_b1875(-1e-30, 30.0),
            constellation_at_b1875(0.0, 30.0)
        );
    }

    #[test]
    fn non_finite_b1875_points_belong_nowhere() {
        // Without the check every comparison against NaN fails and the polar polygon,
        // whose parity is flipped, would claim the point.
        assert_eq!(constellation_at_b1875(f64::NAN, 10.0), None);
        assert_eq!(constellation_at_b1875(10.0, f64::NAN), None);
        assert_eq!(constellation_at_b1875(10.0, 90.5), None);
        assert!(regions_containing_b1875(f64::INFINITY, 0.0).is_empty());
    }

    #[test]
    fn bad_directions_are_refused() {
        assert!(constellation_at(f64::NAN, 0.0, 2_461_308.0).is_err());
        assert!(constellation_at(0.0, 90.5, 2_461_308.0).is_err());
        assert!(constellation_at(0.0, 0.0, f64::NAN).is_err());
        assert!(constellation_at(0.0, 0.0, 1.0e7).is_err());
        // Right ascension outside [0, 360) is simply wrapped.
        assert_eq!(
            constellation_at(-270.0, 20.0, 2_461_308.0).unwrap(),
            constellation_at(90.0, 20.0, 2_461_308.0).unwrap()
        );
    }

    #[test]
    fn edge_distances() {
        // 1 degree south of a parallel edge's middle.
        let d = distance_to_edge_deg(15.0, 29.0, 10.0, 30.0, 20.0, 30.0);
        assert!((d - 1.0).abs() < 1e-9, "{d}");
        // Due east of an hour-circle edge on the equator: 2 degrees.
        let d = distance_to_edge_deg(12.0, 0.0, 10.0, -5.0, 10.0, 5.0);
        assert!((d - 2.0).abs() < 1e-9, "{d}");
        // Beyond the end of an edge: distance to the corner.
        let d = distance_to_edge_deg(10.0, 10.0, 10.0, -5.0, 10.0, 5.0);
        assert!((d - 5.0).abs() < 1e-9, "{d}");
    }
}
