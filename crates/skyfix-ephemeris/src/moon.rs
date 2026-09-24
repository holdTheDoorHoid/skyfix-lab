//! The Moon: apparent geocentric place, distance, parallax, semidiameter and phase.
//!
//! OWNER: Moon agent. CONVENTIONS sections 7 and 13.
//!
//! # Model chain
//!
//! 1. **Lunar theory: ELP 2000-82B** (Chapront-Touzé & Chapront 1983, 1988; CDS
//!    catalogue VI/79), with the constants the authors fitted to JPL DE200/LE200. The
//!    36 series files are truncated for 1990-2060 and embedded from
//!    `../data/elp82b_moon_terms.json`: 2023 of 37 872 terms, each record copied
//!    verbatim from the CDS file (see `docs/THIRD_PARTY.md`, "Moon model", and
//!    `tools/reference/build_moon_series.py`). The evaluation follows the authors'
//!    reference subroutine `elp82b.f` line for line: the main problem with the
//!    corrections of the constants (notice sect. 7), the perturbation series (Earth
//!    and Moon figure, planetary tables 1 and 2, tides, relativity, solar
//!    eccentricity) with their `t` and `t²` Poisson factors, the mean longitude `W1`,
//!    and Laskar's `P`, `Q` rotation from the inertial mean ecliptic of date to the
//!    **inertial mean ecliptic and equinox of J2000**. The main problem's time
//!    derivative is summed in the same pass and gives the geocentric velocity for
//!    step 4 (the perturbations carry under 1e-4 of it and are left out there).
//! 2. **To the mean equator and equinox of J2000** with the notice's own matrix
//!    (sect. 8): obliquity `ε_I = 23°26′21.40883″` and the arc `γ_I γ_FK5 = 0.09845″`
//!    from the same DE200 fit, `M = R3(0.09845″) R1(−ε_I)`.
//! 3. **To the GCRS** by the inverse of the IAU 2006 frame bias (the
//!    Fukushima-Williams angles at J2000 in [`crate::frames`]), i.e. the J2000 frame of
//!    the theory is treated as the IAU 2006 mean dynamical frame. The tie is good to a
//!    few hundredths of an arcsecond; measured against DE440s the constant part of
//!    the longitude difference is +0.02″.
//! 4. **Light-time, not annual aberration.** What Skyfield's
//!    `earth.at(t).observe(moon).apparent()` does — a light-time solution with
//!    *barycentric* positions, then aberration with the Earth's barycentric velocity —
//!    reduces for the Moon to the **geocentric position at the retarded time**
//!    `t − τ`, `τ = r / c ≈ 1.28 s`: the Earth's motion during `τ` (−v⊕τ) and the
//!    aberration (+v⊕τ) cancel to about 1 mas. So the Moon gets no 20″ annual
//!    aberration; it gets its own motion over 1.28 s, about 0.7″, applied here as
//!    `p − τ ṗ` with `ṗ` from step 1 (the neglected `τ² p̈ / 2` is 2e-6 km).
//!    Gravitational deflection of moonlight by the Sun is below 0.01 mas and ignored.
//! 5. **Precession and nutation of date** with the shared IAU 2006/2000B matrix
//!    [`crate::frames::bias_precession_nutation_matrix`] (the bias it contains cancels
//!    the inverse applied in step 3), giving the apparent RA and Dec of date
//!    (CONVENTIONS section 7).
//! 6. **GHA** `= GAST − RA` with [`crate::sidereal::gast_deg`] and the provider's
//!    DUT1 (0 unless supplied), exactly as the Sun and the stars do.
//!
//! The time argument of ELP is TDB; TT is used (`TDB − TT` is under 2 ms, 0.001″ of
//! lunar motion).
//!
//! # Physical quantities
//!
//! - `distance_km`: geometric geocentric distance at the instant (the light-time
//!   distance differs by at most 0.1 km).
//! - Horizontal parallax `HP = asin(a / d)` with `a = 6378.14 km`, the IAU 1976
//!   equatorial radius that ELP 2000-82B itself uses (the WGS84 6378.137 km would
//!   change HP by 0.002″).
//! - Semidiameter `SD = asin(k a / d)` with `k = 0.2725076`, the IAU 1982 ratio of the
//!   lunar to the terrestrial equatorial radius used by the Explanatory Supplement and
//!   the NASA eclipse canons (the Moon's mean radius, 1738.09 km). The alternative
//!   0.272493 changes SD by 0.05″.
//! - Elongation: the angle between the apparent directions of the Moon and the Sun
//!   (the Sun from [`SunProvider`]). Phase angle `i` (Sun-Moon-Earth) from Meeus,
//!   *Astronomical Algorithms*, eq. 48.3, `tan i = R sin ψ / (Δ − R cos ψ)`;
//!   illuminated fraction `(1 + cos i) / 2` (CONVENTIONS 13.5).
//! - Bright-limb position angle `χ`, from celestial north through east, Meeus eq. 48.5:
//!   `tan χ = cos δ☉ sin(α☉ − α) / (sin δ☉ cos δ − cos δ☉ sin δ cos(α☉ − α))`.
//! - Magnitude: **approximate**. The classical phase law
//!   `V = −12.73 + 0.026 |i| + 4×10⁻⁹ i⁴` (i in degrees) of Krisciunas & Schaefer
//!   (1991, PASP 103, 1033), after Allen, scaled by the inverse-square law to the
//!   actual Earth-Moon (mean 384 400 km) and Sun-Moon (1 au) distances. Good to one or
//!   two tenths of a magnitude away from new moon; it ignores the opposition surge
//!   within a few degrees of full moon and knows nothing about lunar eclipses.
//!
//! # Accuracy
//!
//! Measured against Skyfield with JPL DE440s (DE421 as a cross-check) at the epochs
//! of `fixtures/reference/moon_geocentric.json` by `tests/moon_reference.rs`; the
//! numbers are in `docs/ACCURACY.md`, "Moon". The dominant term is the theory itself:
//! ELP 2000-82B's DE200-fitted mean longitude drifts from DE440 by about
//! `0.37″ t + 0.99″ t²` (t in centuries from J2000), 0.7″ by 2060. Truncation adds at
//! most 0.13″ (measured over 20 000 epochs; the sum of every dropped term's peak,
//! a bound that assumes they all align, is 1.9″ in longitude and 1.0″ in latitude).

use std::sync::OnceLock;

use serde::Deserialize;
use skyfix_core::time::{JD_J2000, civil_to_jd, jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::{ARCSEC, DEG, norm_360};

use crate::body::{AU_KM, ApparentState, BodyEphemeris, BodyKind, MOON};
use crate::frames::{
    bias_precession_nutation_matrix, fukushima_williams_2006, radec_from_vector, true_obliquity_rad,
};
use crate::sidereal::gast_deg;
use crate::sun::SunProvider;
use crate::{AstroProvider, Coverage, EphemerisError};

// ---------------------------------------------------------------------------
// Coverage and physical constants
// ---------------------------------------------------------------------------

/// First instant covered, the same as the Sun and the stars.
pub const COVERAGE_START_UTC: &str = crate::stars::COVERAGE_START_UTC;
/// Last instant covered, the same as the stars.
pub const COVERAGE_END_UTC: &str = crate::stars::COVERAGE_END_UTC;

/// Earth's equatorial radius used for the horizontal parallax, km (IAU 1976; the value
/// ELP 2000-82B was built with).
pub const EARTH_EQUATORIAL_RADIUS_KM: f64 = 6378.14;
/// Ratio of the Moon's radius to the Earth's equatorial radius (IAU 1982).
pub const MOON_RADIUS_RATIO_K: f64 = 0.272_507_6;
/// Mean Earth-Moon distance the magnitude law refers to, km.
pub const MEAN_DISTANCE_KM: f64 = 384_400.0;

/// Speed of light, km/s (exact).
const C_KM_S: f64 = 299_792.458;
/// Seconds in a Julian century.
const SECONDS_PER_CENTURY: f64 = 36_525.0 * 86_400.0;
const TAU: f64 = std::f64::consts::TAU;

const ELP_JSON: &str = include_str!("../data/elp82b_moon_terms.json");
const ELP_SCHEMA: &str = "skyfix.elp82b_trunc/1";

fn coverage_start_jd() -> f64 {
    civil_to_jd(1990, 1, 1)
}

fn coverage_end_jd() -> f64 {
    // 2060-12-31T23:59:59Z, exactly what COVERAGE_END_UTC advertises.
    civil_to_jd(2060, 12, 31) + 86_399.0 / 86_400.0
}

// ---------------------------------------------------------------------------
// ELP 2000-82B constants: elp82b.f (CDS VI/79) and the notice, sections 4-8
// ---------------------------------------------------------------------------

/// `a0` and the value `ath` the distance series were computed with; the series are
/// scaled by `a0 / ath` (elp82b.f).
const ELP_ATH_KM: f64 = 384_747.980_674_316_5;
const ELP_A0_KM: f64 = 384_747.980_644_895_4;
/// `m = n' / nu` and `alpha = a0 / a'` (notice sect. 5), for the corrections below.
const ELP_AM: f64 = 0.074_801_329_518;
const ELP_ALFA: f64 = 0.002_571_881_335;

/// Degrees, minutes, seconds to arcseconds.
const fn dms_arcsec(d: f64, m: f64, s: f64) -> f64 {
    d * 3600.0 + m * 60.0 + s
}

/// Mean mean longitude of the Moon `W1`, arcseconds and arcseconds per century**k
/// (notice sect. 7, the values fitted to DE200/LE200).
const W1: [f64; 5] = [
    dms_arcsec(218.0, 18.0, 59.955_71),
    1_732_559_343.736_04,
    -5.8883,
    0.006_604,
    -0.000_031_69,
];
/// Mean longitude of the lunar perigee `W2`.
const W2: [f64; 5] = [
    dms_arcsec(83.0, 21.0, 11.674_75),
    14_643_420.263_2,
    -38.2776,
    -0.045_047,
    0.000_213_01,
];
/// Mean longitude of the lunar ascending node `W3`.
const W3: [f64; 5] = [
    dms_arcsec(125.0, 2.0, 40.398_16),
    -6_967_919.362_2,
    6.3622,
    0.007_625,
    -0.000_035_86,
];
/// Mean heliocentric mean longitude of the Earth-Moon barycentre `T`.
const EARTH_T: [f64; 5] = [
    dms_arcsec(100.0, 27.0, 59.220_59),
    129_597_742.275_8,
    -0.0202,
    0.000_009,
    0.000_000_15,
];
/// Mean longitude of the perihelion of the Earth-Moon barycentre `ϖ'`.
const PERIHELION: [f64; 5] = [
    dms_arcsec(102.0, 56.0, 14.427_53),
    1_161.228_3,
    0.5327,
    -0.000_138,
    0.0,
];
/// Precession constant `p` in J2000, arcseconds per century; `ζ = W1 + p t`.
const PRECESSION_P: f64 = 5_029.096_6;
/// Planetary mean longitudes (VSOP82, notice Table F): constant and rate, for Me, V,
/// T (the Earth-Moon barycentre, the same `T` as above), Ma, J, S, U, N.
const PLANETS: [[f64; 2]; 8] = [
    [dms_arcsec(252.0, 15.0, 3.259_86), 538_101_628.688_98],
    [dms_arcsec(181.0, 58.0, 47.283_05), 210_664_136.433_55],
    [EARTH_T[0], EARTH_T[1]],
    [dms_arcsec(355.0, 25.0, 59.788_66), 68_905_077.592_84],
    [dms_arcsec(34.0, 21.0, 5.342_12), 10_925_660.428_61],
    [dms_arcsec(50.0, 4.0, 38.896_94), 4_399_609.659_32],
    [dms_arcsec(314.0, 3.0, 18.018_41), 1_542_481.193_93],
    [dms_arcsec(304.0, 20.0, 55.195_75), 786_550.320_74],
];
/// Corrections of the constants fitted to DE200/LE200 (notice sect. 7): `Δν`, `ΔE`,
/// `ΔΓ`, `Δn'`, `Δe'`, as elp82b.f states them (arcseconds; `Δν` and `Δn'` per
/// century, used relative to `ν`).
const DEL_NU_ARCSEC: f64 = 0.556_04;
const DEL_E_ARCSEC: f64 = 0.017_89;
const DEL_G_ARCSEC: f64 = -0.080_66;
const DEL_NP_ARCSEC: f64 = -0.064_24;
const DEL_EP_ARCSEC: f64 = -0.128_79;
/// Laskar's `P` and `Q` (notice sect. 8), coefficients of `t, t², …, t⁵`.
const LASKAR_P: [f64; 5] = [
    0.101_803_91e-4,
    0.470_204_39e-6,
    -0.541_736_7e-9,
    -0.250_794_8e-11,
    0.463_486e-14,
];
const LASKAR_Q: [f64; 5] = [
    -0.113_469_002e-3,
    0.123_726_74e-6,
    0.126_541_7e-8,
    -0.137_180_8e-11,
    -0.320_334e-14,
];
/// Obliquity of the inertial mean ecliptic of J2000 on the mean equator, and the arc
/// from the inertial equinox to the FK5 equinox, both from the DE200 fit (notice
/// sect. 8).
const EPSILON_I_ARCSEC: f64 = dms_arcsec(23.0, 26.0, 21.408_83);
const GAMMA_I_TO_FK5_ARCSEC: f64 = 0.098_45;

// ---------------------------------------------------------------------------
// Small vector helpers (row-major 3x3, frame rotations as in `crate::frames`)
// ---------------------------------------------------------------------------

type Mat3 = [[f64; 3]; 3];

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut m = [[0.0; 3]; 3];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    m
}

fn transpose(a: &Mat3) -> Mat3 {
    let mut m = [[0.0; 3]; 3];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[j][i];
        }
    }
    m
}

fn apply(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Angle between two vectors, radians, robust at 0 and 180 degrees.
fn angle_between(a: [f64; 3], b: [f64; 3]) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b))
}

/// Frame rotation about x: `R1(phi)`.
fn r1(phi: f64) -> Mat3 {
    let (s, c) = phi.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]]
}

/// Frame rotation about z: `R3(psi)`.
fn r3(psi: f64) -> Mat3 {
    let (s, c) = psi.sin_cos();
    [[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// The notice's matrix from the inertial mean ecliptic and equinox of J2000 to the
/// mean equator and (FK5) equinox of J2000: `R3(γ_I γ_FK5) R1(−ε_I)`.
fn elp_ecliptic_to_equator() -> Mat3 {
    mat_mul(
        &r3(GAMMA_I_TO_FK5_ARCSEC * ARCSEC),
        &r1(-EPSILON_I_ARCSEC * ARCSEC),
    )
}

/// IAU 2006 frame bias: GCRS to the mean equator and dynamical equinox of J2000,
/// `R1(−ε0) R3(−ψ̄0) R1(φ̄0) R3(γ̄0)` from the Fukushima-Williams angles at J2000.
fn iau2006_frame_bias() -> Mat3 {
    let fw = fukushima_williams_2006(JD_J2000);
    let mut m = r3(fw.gamma_bar_rad);
    m = mat_mul(&r1(fw.phi_bar_rad), &m);
    m = mat_mul(&r3(-fw.psi_bar_rad), &m);
    mat_mul(&r1(-fw.eps_a_rad), &m)
}

// ---------------------------------------------------------------------------
// Embedded series
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ElpData {
    schema: String,
    truncation: ElpTruncation,
    files: Vec<ElpFile>,
    checkpoints: Vec<ElpCheckpoint>,
}

/// The measured truncation error the generator recorded (see the module docs).
#[derive(Debug, Clone, Deserialize)]
pub struct ElpTruncation {
    pub terms_kept: usize,
    pub terms_total: usize,
    pub threshold_longitude_arcsec: f64,
    pub threshold_latitude_arcsec: f64,
    pub threshold_distance_km: f64,
    pub measured_max_error_longitude_arcsec: f64,
    pub measured_max_error_latitude_arcsec: f64,
    pub measured_max_error_distance_km: f64,
    pub measured_max_error_direction_arcsec: f64,
    pub dropped_worstcase_longitude_arcsec: f64,
    pub dropped_worstcase_latitude_arcsec: f64,
    pub dropped_worstcase_distance_km: f64,
}

#[derive(Debug, Deserialize)]
struct ElpFile {
    file: u8,
    terms_total: usize,
    terms_kept: usize,
    rows: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ElpCheckpoint {
    jd_tdb: f64,
    xyz_km: [f64; 3],
    #[serde(default)]
    sums: Option<[f64; 3]>,
    series: String,
}

/// A main-problem term: `A sin(i·(D, l', l, F))` (cosine for the distance).
#[derive(Debug, Clone, Copy)]
struct MainTerm {
    /// Multipliers of D, l', l, F, `|i| <= MAX_MAIN_MULTIPLIER`.
    mult: [i8; 4],
    amp: f64,
}

/// Largest Delaunay multiplier in the main problem (all 2645 records of ELP1-3 stay
/// within it; the loader refuses anything larger).
const MAX_MAIN_MULTIPLIER: usize = 10;

/// Every other term: `A t^power sin(phase + freq t)`, radians and radians per century.
#[derive(Debug, Clone, Copy)]
struct PoissonTerm {
    amp: f64,
    phase: f64,
    freq: f64,
    power: u8,
}

/// The theory, ready to evaluate.
struct ElpModel {
    main: [Vec<MainTerm>; 3],
    poisson: [Vec<PoissonTerm>; 3],
    /// Delaunay arguments D, l', l, F: radians per century**k, k = 0..4.
    delaunay: [[f64; 5]; 4],
    /// `W1` in radians per century**k.
    w1: [f64; 5],
    /// Inertial mean ecliptic and equinox of J2000 (the theory's output) to the GCRS.
    to_gcrs: Mat3,
    truncation: ElpTruncation,
    checkpoints: Vec<ElpCheckpoint>,
}

static ELP: OnceLock<Result<ElpModel, String>> = OnceLock::new();

fn elp() -> Result<&'static ElpModel, EphemerisError> {
    ELP.get_or_init(build_model)
        .as_ref()
        .map_err(|e| EphemerisError::Data(format!("embedded ELP 2000-82B data is unusable: {e}")))
}

/// Which coordinate a file feeds (0 longitude, 1 latitude, 2 distance), the power of
/// `t` that multiplies its series, and the record layout (notice sect. 2-3).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Layout {
    /// Files 1-3: `i1..i4 A B1..B6`.
    Main,
    /// Files 4-9 and 22-36: `i1..i5 phase A`, multipliers of ζ, D, l', l, F.
    Figure,
    /// Files 10-15: `i1..i11 phase A`, multipliers of Me V T Ma J S U N D l F.
    Planetary1,
    /// Files 16-21: `i1..i11 phase A`, multipliers of Me V T Ma J S U D l' l F.
    Planetary2,
}

fn file_kind(n: u8) -> (usize, u8, Layout) {
    let coord = usize::from((n - 1) % 3);
    match n {
        1..=3 => (coord, 0, Layout::Main),
        10..=12 | 16..=18 => (
            coord,
            0,
            if n <= 15 {
                Layout::Planetary1
            } else {
                Layout::Planetary2
            },
        ),
        13..=15 | 19..=21 => (
            coord,
            1,
            if n <= 15 {
                Layout::Planetary1
            } else {
                Layout::Planetary2
            },
        ),
        7..=9 | 25..=27 => (coord, 1, Layout::Figure),
        34..=36 => (coord, 2, Layout::Figure),
        _ => (coord, 0, Layout::Figure),
    }
}

fn integer(v: f64, what: &str) -> Result<f64, String> {
    if v.fract() == 0.0 && v.abs() < 100.0 {
        Ok(v)
    } else {
        Err(format!("{what}: {v} is not a small integer multiplier"))
    }
}

fn build_model() -> Result<ElpModel, String> {
    let data: ElpData =
        serde_json::from_str(ELP_JSON).map_err(|e| format!("malformed JSON: {e}"))?;
    if data.schema != ELP_SCHEMA {
        return Err(format!(
            "schema is {:?}, expected {ELP_SCHEMA:?}",
            data.schema
        ));
    }

    // Arguments, radians. Delaunay arguments exactly as elp82b.f forms them.
    let rad = |a: [f64; 5]| a.map(|x| x * ARCSEC);
    let (w1, w2, w3, tt, pp) = (rad(W1), rad(W2), rad(W3), rad(EARTH_T), rad(PERIHELION));
    let mut delaunay = [[0.0; 5]; 4];
    for k in 0..5 {
        delaunay[0][k] = w1[k] - tt[k];
        delaunay[1][k] = tt[k] - pp[k];
        delaunay[2][k] = w1[k] - w2[k];
        delaunay[3][k] = w1[k] - w3[k];
    }
    delaunay[0][0] += std::f64::consts::PI;
    let zeta = [w1[0], w1[1] + PRECESSION_P * ARCSEC];
    let planets = PLANETS.map(|p| [p[0] * ARCSEC, p[1] * ARCSEC]);

    // Corrections of the constants (notice sect. 7), as elp82b.f applies them.
    let del_nu = DEL_NU_ARCSEC / W1[1];
    let del_np = DEL_NP_ARCSEC / W1[1];
    let (del_e, del_g, del_ep) = (
        DEL_E_ARCSEC * ARCSEC,
        DEL_G_ARCSEC * ARCSEC,
        DEL_EP_ARCSEC * ARCSEC,
    );
    let dtasm = 2.0 * ELP_ALFA / (3.0 * ELP_AM);

    let mut main: [Vec<MainTerm>; 3] = Default::default();
    let mut poisson: [Vec<PoissonTerm>; 3] = Default::default();
    let mut seen = [false; 36];
    let mut kept = 0usize;
    let mut total = 0usize;
    for f in &data.files {
        if !(1..=36).contains(&f.file) {
            return Err(format!("file number {} is not an ELP file", f.file));
        }
        let idx = usize::from(f.file - 1);
        if seen[idx] {
            return Err(format!("ELP{} appears twice", f.file));
        }
        seen[idx] = true;
        if f.rows.len() != f.terms_kept || f.terms_kept > f.terms_total {
            return Err(format!(
                "ELP{}: {} rows but terms_kept {} of {}",
                f.file,
                f.rows.len(),
                f.terms_kept,
                f.terms_total
            ));
        }
        kept += f.terms_kept;
        total += f.terms_total;
        let (coord, power, layout) = file_kind(f.file);
        let width = match layout {
            Layout::Main => 11,
            Layout::Figure => 7,
            Layout::Planetary1 | Layout::Planetary2 => 13,
        };
        for row in &f.rows {
            if row.len() != width || row.iter().any(|v| !v.is_finite()) {
                return Err(format!(
                    "ELP{}: a record has {} numbers, expected {width}: {row:?}",
                    f.file,
                    row.len()
                ));
            }
            let what = format!("ELP{}", f.file);
            match layout {
                Layout::Main => {
                    let mut mult = [0i8; 4];
                    for (k, slot) in mult.iter_mut().enumerate() {
                        let v = integer(row[k], &what)?;
                        if v.abs() > MAX_MAIN_MULTIPLIER as f64 {
                            return Err(format!(
                                "{what}: multiplier {v} exceeds {MAX_MAIN_MULTIPLIER}"
                            ));
                        }
                        *slot = v as i8;
                    }
                    let mut a = row[4];
                    let b = &row[5..11];
                    if f.file == 3 {
                        a -= 2.0 * a * del_nu / 3.0;
                    }
                    let tgv = b[0] + dtasm * b[4];
                    let amp = a
                        + tgv * (del_np - ELP_AM * del_nu)
                        + b[1] * del_g
                        + b[2] * del_e
                        + b[3] * del_ep;
                    main[coord].push(MainTerm { mult, amp });
                }
                Layout::Figure | Layout::Planetary1 | Layout::Planetary2 => {
                    let n = width - 2;
                    let mut m = [0.0f64; 11];
                    for (k, slot) in m.iter_mut().take(n).enumerate() {
                        *slot = integer(row[k], &what)?;
                    }
                    let (phase_deg, amp) = (row[n], row[n + 1]);
                    let mut arg = [phase_deg * DEG, 0.0];
                    for (k, a) in arg.iter_mut().enumerate() {
                        match layout {
                            Layout::Figure => {
                                *a += m[0] * zeta[k]
                                    + (0..4).map(|i| m[i + 1] * delaunay[i][k]).sum::<f64>();
                            }
                            Layout::Planetary1 => {
                                *a += m[8] * delaunay[0][k]
                                    + m[9] * delaunay[2][k]
                                    + m[10] * delaunay[3][k]
                                    + (0..8).map(|i| m[i] * planets[i][k]).sum::<f64>();
                            }
                            Layout::Planetary2 => {
                                *a += (0..4).map(|i| m[i + 7] * delaunay[i][k]).sum::<f64>()
                                    + (0..7).map(|i| m[i] * planets[i][k]).sum::<f64>();
                            }
                            Layout::Main => unreachable!(),
                        }
                    }
                    poisson[coord].push(PoissonTerm {
                        amp,
                        phase: arg[0].rem_euclid(TAU),
                        freq: arg[1],
                        power,
                    });
                }
            }
        }
    }
    if let Some(missing) = seen.iter().position(|s| !s) {
        return Err(format!("ELP{} is missing", missing + 1));
    }
    if kept != data.truncation.terms_kept || total != data.truncation.terms_total {
        return Err(format!(
            "files hold {kept} of {total} terms but the truncation block says {} of {}",
            data.truncation.terms_kept, data.truncation.terms_total
        ));
    }

    Ok(ElpModel {
        main,
        poisson,
        delaunay,
        w1,
        to_gcrs: mat_mul(
            &transpose(&iau2006_frame_bias()),
            &elp_ecliptic_to_equator(),
        ),
        truncation: data.truncation,
        checkpoints: data.checkpoints,
    })
}

/// `(cos kθ, sin kθ)` for `k = 0..=MAX_MAIN_MULTIPLIER`, each from its own `sin_cos`
/// so no error accumulates.
fn multiples(theta: f64) -> [(f64, f64); MAX_MAIN_MULTIPLIER + 1] {
    let mut out = [(1.0, 0.0); MAX_MAIN_MULTIPLIER + 1];
    for (k, slot) in out.iter_mut().enumerate().skip(1) {
        let (s, c) = (k as f64 * theta).sin_cos();
        *slot = (c, s);
    }
    out
}

/// `e^{i k θ}` from the table of non-negative multiples.
#[inline]
fn expi(table: &[(f64, f64); MAX_MAIN_MULTIPLIER + 1], k: i8) -> (f64, f64) {
    let (c, s) = table[usize::from(k.unsigned_abs())];
    if k < 0 { (c, -s) } else { (c, s) }
}

#[inline]
fn cmul(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

/// Series sums (longitude and latitude in arcseconds, distance in km, before the
/// `a0/ath` scaling) and the time derivative of the main-problem part, per century.
///
/// The main problem's arguments are integer combinations of the four Delaunay
/// arguments, so `sin` and `cos` of each come from products of `e^{i k D}`,
/// `e^{i k l'}`, `e^{i k l}`, `e^{i k F}` tabulated once per call: no transcendental
/// function per term. Every other term is one `sin`. The derivative (used only for the
/// 0.7" light-time step) leaves out the perturbation series: they carry under 1e-4 of
/// the Moon's velocity, so the light-time displacement changes by under 0.0001".
fn series_sums(m: &ElpModel, t: f64) -> ([f64; 3], [f64; 3]) {
    let mut tables = [[(1.0, 0.0); MAX_MAIN_MULTIPLIER + 1]; 4];
    let mut rates = [0.0f64; 4];
    for (i, c) in m.delaunay.iter().enumerate() {
        let d = (c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * c[4])))).rem_euclid(TAU);
        tables[i] = multiples(d);
        rates[i] = c[1] + t * (2.0 * c[2] + t * (3.0 * c[3] + t * 4.0 * c[4]));
    }
    let tp = [1.0, t, t * t];
    let mut sum = [0.0f64; 3];
    let mut der = [0.0f64; 3];
    for coord in 0..3 {
        let (mut s, mut ds) = (0.0f64, 0.0f64);
        for term in &m.main[coord] {
            let k = term.mult;
            let z = cmul(
                cmul(expi(&tables[0], k[0]), expi(&tables[1], k[1])),
                cmul(expi(&tables[2], k[2]), expi(&tables[3], k[3])),
            );
            let darg = f64::from(k[0]) * rates[0]
                + f64::from(k[1]) * rates[1]
                + f64::from(k[2]) * rates[2]
                + f64::from(k[3]) * rates[3];
            if coord == 2 {
                s += term.amp * z.0;
                ds -= term.amp * z.1 * darg;
            } else {
                s += term.amp * z.1;
                ds += term.amp * z.0 * darg;
            }
        }
        for term in &m.poisson[coord] {
            s += term.amp * tp[usize::from(term.power)] * (term.phase + term.freq * t).sin();
        }
        sum[coord] = s;
        der[coord] = ds;
    }
    (sum, der)
}

/// Geocentric position (km) and velocity (km per century) of the Moon in the
/// theory's own frame, the inertial mean ecliptic and equinox of J2000.
fn elp_ecliptic_state(m: &ElpModel, t: f64) -> ([f64; 3], [f64; 3]) {
    let (s, ds) = series_sums(m, t);
    let w = &m.w1;
    let w1 = (w[0] + t * (w[1] + t * (w[2] + t * (w[3] + t * w[4])))).rem_euclid(TAU);
    let dw1 = w[1] + t * (2.0 * w[2] + t * (3.0 * w[3] + t * 4.0 * w[4]));
    let v = s[0] * ARCSEC + w1;
    let dv = ds[0] * ARCSEC + dw1;
    let u = s[1] * ARCSEC;
    let du = ds[1] * ARCSEC;
    let scale = ELP_A0_KM / ELP_ATH_KM;
    let r = s[2] * scale;
    let dr = ds[2] * scale;

    let (sv, cv) = v.sin_cos();
    let (su, cu) = u.sin_cos();
    let x = [r * cu * cv, r * cu * sv, r * su];
    let dx = [
        dr * cu * cv - r * su * du * cv - r * cu * sv * dv,
        dr * cu * sv - r * su * du * sv + r * cu * cv * dv,
        dr * su + r * cu * du,
    ];

    // Laskar's P, Q: inertial mean ecliptic of date to that of J2000 (elp82b.f). Its
    // own rate, about 1e-4 rad per century, moves the velocity by 1e-8 of itself and
    // is not carried.
    let poly = |c: &[f64; 5]| t * (c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * c[4]))));
    let (pw, qw) = (poly(&LASKAR_P), poly(&LASKAR_Q));
    let ra = 2.0 * (1.0 - pw * pw - qw * qw).sqrt();
    let pwqw = 2.0 * pw * qw;
    let pw2 = 1.0 - 2.0 * pw * pw;
    let qw2 = 1.0 - 2.0 * qw * qw;
    let (pwr, qwr) = (pw * ra, qw * ra);
    let rot: Mat3 = [
        [pw2, pwqw, pwr],
        [pwqw, qw2, -qwr],
        [-pwr, qwr, pw2 + qw2 - 1.0],
    ];
    (apply(&rot, x), apply(&rot, dx))
}

/// Julian centuries of TDB (taken as TT) from J2000.
fn centuries(jd_tdb: f64) -> f64 {
    (jd_tdb - JD_J2000) / 36_525.0
}

/// Geocentric rectangular coordinates of the Moon from the embedded (truncated)
/// ELP 2000-82B, km, in the theory's own frame: the inertial mean ecliptic and
/// equinox of J2000. `jd_tdb` is a Julian date of TDB (TT is fine). No coverage check.
pub fn elp82b_ecliptic_j2000_km(jd_tdb: f64) -> Result<[f64; 3], EphemerisError> {
    let m = elp()?;
    Ok(elp_ecliptic_state(m, centuries(jd_tdb)).0)
}

/// The generator's measured truncation error and term counts.
pub fn elp82b_truncation() -> Result<ElpTruncation, EphemerisError> {
    Ok(elp()?.truncation.clone())
}

/// Result of [`elp82b_self_check`], kilometres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ElpSelfCheck {
    /// Worst distance between this crate's evaluation of the embedded series and the
    /// generator's evaluation of the same series. Arithmetic only: should be ~1e-8 km.
    pub truncated_series_km: f64,
    /// Worst distance from the notice's Table H values (the complete theory) at the
    /// Table H epochs inside the coverage window. This is the truncation error there.
    pub table_h_in_window_km: f64,
    /// How many Table H epochs were inside the window.
    pub table_h_epochs: usize,
}

/// Re-evaluate the embedded series at the checkpoints shipped with the data file.
///
/// Table H of the ELP 2000-82B notice is published by the theory's authors, so this
/// also checks the embedded records against a source outside this repository.
pub fn elp82b_self_check() -> Result<ElpSelfCheck, EphemerisError> {
    let m = elp()?;
    let mut out = ElpSelfCheck {
        truncated_series_km: 0.0,
        table_h_in_window_km: 0.0,
        table_h_epochs: 0,
    };
    let dist = |a: [f64; 3], b: [f64; 3]| norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
    for c in &m.checkpoints {
        let got = elp_ecliptic_state(m, centuries(c.jd_tdb)).0;
        if got.iter().any(|v| !v.is_finite()) {
            return Err(EphemerisError::Data(format!(
                "ELP evaluation is not finite at JD {}",
                c.jd_tdb
            )));
        }
        let e = dist(got, c.xyz_km);
        match c.series.as_str() {
            "truncated" => {
                out.truncated_series_km = out.truncated_series_km.max(e);
                if let Some(sums) = c.sums {
                    let (s, _) = series_sums(m, centuries(c.jd_tdb));
                    // arcseconds and km; 1e-6 is far above rounding, far below any error.
                    let worst = (0..3).map(|i| (s[i] - sums[i]).abs()).fold(0.0, f64::max);
                    if worst > 1e-6 {
                        return Err(EphemerisError::Data(format!(
                            "ELP series sums differ from the generator's by {worst} at JD {}",
                            c.jd_tdb
                        )));
                    }
                }
            }
            "complete" => {
                let jd_utc_approx = c.jd_tdb;
                if (coverage_start_jd()..=coverage_end_jd() + 1.0).contains(&jd_utc_approx) {
                    out.table_h_in_window_km = out.table_h_in_window_km.max(e);
                    out.table_h_epochs += 1;
                }
            }
            other => {
                return Err(EphemerisError::Data(format!(
                    "unknown checkpoint series {other:?}"
                )));
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The Moon
// ---------------------------------------------------------------------------

/// Apparent geocentric place of the Moon and the quantities built with it.
///
/// Angles in degrees unless the field name says otherwise (CONVENTIONS section 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonPosition {
    pub jd_utc: f64,
    pub jd_tt: f64,
    pub jd_ut1: f64,
    /// Apparent right ascension, true equator and equinox of date, `[0, 360)`.
    pub ra_deg: f64,
    /// Apparent declination, north positive.
    pub dec_deg: f64,
    /// Greenwich apparent sidereal time used for the hour angle, `[0, 360)`.
    pub gast_deg: f64,
    /// Greenwich hour angle, west positive, `[0, 360)`.
    pub gha_deg: f64,
    /// Apparent ecliptic longitude, true ecliptic and equinox of date, `[0, 360)`.
    pub ecliptic_longitude_deg: f64,
    /// Apparent ecliptic latitude, true ecliptic of date.
    pub ecliptic_latitude_deg: f64,
    /// Geometric geocentric distance at `jd`, km.
    pub distance_km: f64,
    /// Light time `distance / c`, seconds.
    pub light_time_s: f64,
    /// Apparent geocentric position vector, true equator and equinox of date, km.
    pub apparent_km: [f64; 3],
    /// `asin(6378.14 km / distance)`.
    pub horizontal_parallax_arcmin: f64,
    /// `asin(0.2725076 × 6378.14 km / distance)`.
    pub semidiameter_arcmin: f64,
}

impl MoonPosition {
    /// The direction in the shape the reducer and the session format use.
    pub fn direction(&self) -> GeocentricDirection {
        GeocentricDirection {
            gha_deg: self.gha_deg,
            dec_deg: self.dec_deg,
            semidiameter_arcmin: self.semidiameter_arcmin,
            horizontal_parallax_arcmin: self.horizontal_parallax_arcmin,
        }
    }
}

/// How the Moon is lit, from the Moon's and the Sun's apparent geocentric places.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonIllumination {
    /// Sun-Moon angle seen from the Earth, `[0, 180]`.
    pub elongation_deg: f64,
    /// Sun-Moon-Earth angle, `[0, 180]`.
    pub phase_angle_deg: f64,
    /// `(1 + cos i) / 2`.
    pub illuminated_fraction: f64,
    /// Position angle of the bright limb's midpoint, north through east, `[0, 360)`.
    pub bright_limb_angle_deg: f64,
    /// Approximate apparent visual magnitude (see the module documentation).
    pub magnitude: f64,
}

/// Illumination of a body at `distance_km` in apparent direction `(ra, dec)` by a Sun
/// at `(sun_ra, sun_dec)` and `sun_distance_km`, all apparent geocentric of date.
///
/// Meeus eq. 48.3 for the phase angle and eq. 48.5 for the bright limb; the magnitude
/// law is the Moon's (Krisciunas & Schaefer 1991).
pub fn illumination(
    ra_deg: f64,
    dec_deg: f64,
    distance_km: f64,
    sun_ra_deg: f64,
    sun_dec_deg: f64,
    sun_distance_km: f64,
) -> MoonIllumination {
    let u_moon = crate::frames::unit_vector_from_radec(ra_deg, dec_deg);
    let u_sun = crate::frames::unit_vector_from_radec(sun_ra_deg, sun_dec_deg);
    let psi = angle_between(u_moon, u_sun);
    let big_r = sun_distance_km;
    let i = (big_r * psi.sin()).atan2(distance_km - big_r * psi.cos());
    let (a, d) = (ra_deg * DEG, dec_deg * DEG);
    let (a0, d0) = (sun_ra_deg * DEG, sun_dec_deg * DEG);
    let chi =
        (d0.cos() * (a0 - a).sin()).atan2(d0.sin() * d.cos() - d0.cos() * d.sin() * (a0 - a).cos());
    let i_deg = i.to_degrees();
    // Sun-Moon distance for the inverse-square term.
    let sun_moon_km =
        (big_r * big_r + distance_km * distance_km - 2.0 * big_r * distance_km * psi.cos()).sqrt();
    let magnitude = -12.73
        + 0.026 * i_deg.abs()
        + 4.0e-9 * i_deg.powi(4)
        + 5.0 * ((distance_km / MEAN_DISTANCE_KM) * (sun_moon_km / AU_KM)).log10();
    MoonIllumination {
        elongation_deg: psi.to_degrees(),
        phase_angle_deg: i_deg,
        illuminated_fraction: (1.0 + i.cos()) / 2.0,
        bright_limb_angle_deg: norm_360(chi.to_degrees()),
        magnitude,
    }
}

/// Offline Moon provider: ELP 2000-82B + IAU 2006/2000B, 1990-2060.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonProvider {
    dut1_s: f64,
}

impl Default for MoonProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MoonProvider {
    pub const NAME: &'static str = "skyfix-moon (ELP 2000-82B, IAU 2006/2000B)";

    /// DUT1 = 0 (CONVENTIONS section 6).
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    /// Supply a known DUT1 = UT1 - UTC in seconds, removing up to 0.23' of GHA error.
    pub fn with_dut1_s(dut1_s: f64) -> Self {
        MoonProvider { dut1_s }
    }

    pub fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    fn check_body(&self, body: &str) -> Result<(), EphemerisError> {
        if body.trim().eq_ignore_ascii_case(MOON) {
            Ok(())
        } else {
            Err(EphemerisError::UnknownBody(
                body.to_string(),
                Self::NAME.to_string(),
            ))
        }
    }

    fn check_coverage(&self, jd_utc: f64) -> Result<(), EphemerisError> {
        if !jd_utc.is_finite() {
            return Err(EphemerisError::Data(
                "jd_utc is not a finite Julian date".to_string(),
            ));
        }
        if jd_utc < coverage_start_jd() || jd_utc > coverage_end_jd() {
            return Err(EphemerisError::OutOfCoverage {
                provider: Self::NAME.to_string(),
                jd_utc,
                coverage: format!("{COVERAGE_START_UTC} .. {COVERAGE_END_UTC}"),
            });
        }
        Ok(())
    }

    /// Full apparent place of the Moon at `jd_utc` (module docs, steps 1-6).
    pub fn position(&self, jd_utc: f64) -> Result<MoonPosition, EphemerisError> {
        self.check_coverage(jd_utc)?;
        let m = elp()?;
        let jd_tt_v = jd_tt(jd_utc);
        let jd_ut1_v = jd_ut1(jd_utc, self.dut1_s);

        // 1-3. Geometric geocentric position and velocity, GCRS axes.
        let (p_ecl, v_ecl) = elp_ecliptic_state(m, centuries(jd_tt_v));
        let p = apply(&m.to_gcrs, p_ecl);
        let v = apply(&m.to_gcrs, v_ecl).map(|x| x / SECONDS_PER_CENTURY);

        // 4. Light-time: the position the light left, `p(t - tau)`.
        let distance_km = norm(p);
        let tau = distance_km / C_KM_S;
        let p_app = [p[0] - tau * v[0], p[1] - tau * v[1], p[2] - tau * v[2]];

        // 5. True equator and equinox of date.
        let q = apply(&bias_precession_nutation_matrix(jd_tt_v), p_app);
        let (ra_deg, dec_deg) = radec_from_vector(q);

        // Apparent ecliptic coordinates of date (true obliquity), for phases.
        let (se, ce) = true_obliquity_rad(jd_tt_v).sin_cos();
        let ye = q[1] * ce + q[2] * se;
        let ze = -q[1] * se + q[2] * ce;
        let ecliptic_longitude_deg = norm_360(ye.atan2(q[0]).to_degrees());
        let ecliptic_latitude_deg = (ze / norm(q)).clamp(-1.0, 1.0).asin().to_degrees();

        // 6. Hour angle from the shared sidereal time.
        let gast = gast_deg(jd_ut1_v, jd_tt_v);
        let gha_deg = norm_360(gast - ra_deg);

        let sin_hp = EARTH_EQUATORIAL_RADIUS_KM / distance_km;
        Ok(MoonPosition {
            jd_utc,
            jd_tt: jd_tt_v,
            jd_ut1: jd_ut1_v,
            ra_deg,
            dec_deg,
            gast_deg: gast,
            gha_deg,
            ecliptic_longitude_deg,
            ecliptic_latitude_deg,
            distance_km,
            light_time_s: tau,
            apparent_km: q,
            horizontal_parallax_arcmin: sin_hp.asin().to_degrees() * 60.0,
            semidiameter_arcmin: (MOON_RADIUS_RATIO_K * sin_hp).asin().to_degrees() * 60.0,
        })
    }

    /// Elongation, phase, bright limb and magnitude at `jd_utc`, with the Sun from
    /// [`SunProvider`] (same DUT1, which does not matter here).
    pub fn illumination(&self, jd_utc: f64) -> Result<MoonIllumination, EphemerisError> {
        let moon = self.position(jd_utc)?;
        self.illumination_of(&moon)
    }

    fn illumination_of(&self, moon: &MoonPosition) -> Result<MoonIllumination, EphemerisError> {
        let sun = SunProvider::with_dut1_s(self.dut1_s).position(moon.jd_utc)?;
        Ok(illumination(
            moon.ra_deg,
            moon.dec_deg,
            moon.distance_km,
            sun.ra_deg,
            sun.dec_deg,
            sun.radius_au * AU_KM,
        ))
    }
}

impl AstroProvider for MoonProvider {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn coverage(&self) -> Coverage {
        let (kept, total, trunc) = match elp() {
            Ok(m) => (
                m.truncation.terms_kept,
                m.truncation.terms_total,
                m.truncation.measured_max_error_direction_arcsec,
            ),
            Err(_) => (0, 0, f64::NAN),
        };
        let dut1 = if self.dut1_s == 0.0 {
            "DUT1 assumed 0 (CONVENTIONS section 6), which puts up to 0.23' of unmodelled \
             error into GHA and nothing into Dec"
                .to_string()
        } else {
            format!("DUT1 supplied as {:+.4} s", self.dut1_s)
        };
        Coverage {
            start_utc: COVERAGE_START_UTC.to_string(),
            end_utc: COVERAGE_END_UTC.to_string(),
            bodies: vec![MOON.to_string()],
            notes: format!(
                "Apparent geocentric Moon from ELP 2000-82B (Chapront-Touze & Chapront, CDS \
                 VI/79; constants fitted to DE200/LE200), {kept} of {total} terms kept for \
                 1990-2060 (truncation error measured over 20 000 epochs: {trunc:.2}\"). \
                 Light-time applied as the Moon's own motion over r/c; no annual aberration \
                 (it cancels for a geocentric body). IAU 2006/2000B precession-nutation and \
                 sidereal time shared with the Sun and the stars. Horizontal parallax \
                 asin(6378.14 km / d); semidiameter with k = 0.2725076. Magnitude is an \
                 approximate phase law. {dut1}. Verified against Skyfield with JPL DE440s \
                 (DE421 cross-check) at {MOON_FIXTURE_EPOCHS} epochs over 1990-2060: worst \
                 GHA {MOON_WORST_GHA_ARCSEC:.2}\", worst Dec {MOON_WORST_DEC_ARCSEC:.2}\", \
                 worst HP {MOON_WORST_HP_ARCSEC:.3}\"."
            ),
            accuracy_arcmin: MOON_ACCURACY_ARCMIN,
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        self.check_body(body)?;
        Ok(self.position(jd_utc)?.direction())
    }
}

impl BodyEphemeris for MoonProvider {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        self.check_body(body)?;
        let p = self.position(jd_utc)?;
        let lit = self.illumination_of(&p)?;
        Ok(ApparentState {
            body: MOON.to_string(),
            kind: BodyKind::Moon,
            jd_utc,
            ra_deg: p.ra_deg,
            dec_deg: p.dec_deg,
            gha_deg: p.gha_deg,
            distance_km: Some(p.distance_km),
            semidiameter_arcmin: p.semidiameter_arcmin,
            horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
            magnitude: Some(lit.magnitude),
            phase_angle_deg: Some(lit.phase_angle_deg),
            illuminated_fraction: Some(lit.illuminated_fraction),
            elongation_deg: Some(lit.elongation_deg),
            bright_limb_angle_deg: Some(lit.bright_limb_angle_deg),
        })
    }
}

// ---------------------------------------------------------------------------
// The validated accuracy (tests/moon_reference.rs asserts these against the fixture)
// ---------------------------------------------------------------------------

/// Documented worst-case error of GHA (DUT1 = 0) and Dec against Skyfield + DE440s,
/// arcminutes: the measured worst cases, 0.0149' in GHA and 0.0064' in Dec (both at the
/// end of 2060, where the theory's secular drift peaks), rounded up. Like the Sun and
/// the stars, it excludes the DUT1 = 0 assumption, which the coverage notes state
/// separately and a caller can remove.
pub const MOON_ACCURACY_ARCMIN: f64 = 0.02;
const MOON_FIXTURE_EPOCHS: usize = 1757;
const MOON_WORST_GHA_ARCSEC: f64 = 0.89;
const MOON_WORST_DEC_ARCSEC: f64 = 0.38;
const MOON_WORST_HP_ARCSEC: f64 = 0.005;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_series_parses_and_matches_its_checkpoints() {
        let m = elp().expect("embedded ELP data must parse");
        assert_eq!(m.truncation.terms_total, 37_872);
        assert_eq!(
            m.main.iter().map(Vec::len).sum::<usize>()
                + m.poisson.iter().map(Vec::len).sum::<usize>(),
            m.truncation.terms_kept
        );
        let c = elp82b_self_check().unwrap();
        // Same series, same arithmetic up to summation order.
        assert!(c.truncated_series_km < 1e-6, "{c:?}");
        // Table H (the complete theory) at 1993-01-13 and 2047-10-17: the difference is
        // the truncation error, which the generator bounds.
        assert_eq!(c.table_h_epochs, 2);
        let t = &m.truncation;
        let bound_km = (t.measured_max_error_direction_arcsec * ARCSEC * 410_000.0)
            .hypot(t.measured_max_error_distance_km);
        assert!(
            c.table_h_in_window_km <= bound_km,
            "Table H off by {} km, truncation bound {bound_km} km",
            c.table_h_in_window_km
        );
    }

    #[test]
    fn notice_matrix_matches_the_printed_one() {
        // ELP 2000-82B notice, sect. 8.
        let m = elp_ecliptic_to_equator();
        let printed = [
            [1.0, 0.000_000_437_913, -0.000_000_189_859],
            [-0.000_000_477_299, 0.917_482_137_607, -0.397_776_981_701],
            [0.0, 0.397_776_981_701, 0.917_482_137_607],
        ];
        for i in 0..3 {
            for j in 0..3 {
                assert!(
                    (m[i][j] - printed[i][j]).abs() < 1e-12,
                    "[{i}][{j}] {} vs {}",
                    m[i][j],
                    printed[i][j]
                );
            }
        }
    }

    #[test]
    fn velocity_is_the_derivative_of_position() {
        let m = elp().unwrap();
        let t = centuries(2_461_314.5);
        let h = 1.0 / 36_525.0 / 1440.0; // one minute
        let (p0, v) = elp_ecliptic_state(m, t);
        let (pa, _) = elp_ecliptic_state(m, t - h);
        let (pb, _) = elp_ecliptic_state(m, t + h);
        for k in 0..3 {
            let fd = (pb[k] - pa[k]) / (2.0 * h);
            // The velocity leaves out the perturbation series (see `series_sums`).
            assert!(
                (fd - v[k]).abs() < 1e-4 * norm(v),
                "axis {k}: {fd} vs {}",
                v[k]
            );
        }
        // About 1 km/s.
        let speed = norm(v) / SECONDS_PER_CENTURY;
        assert!((0.9..1.15).contains(&speed), "{speed} km/s");
        assert!((356_000.0..407_000.0).contains(&norm(p0)));
    }

    #[test]
    fn refuses_other_bodies_and_out_of_coverage() {
        let p = MoonProvider::new();
        assert!(matches!(
            p.geocentric("Sun", 2_461_314.5),
            Err(EphemerisError::UnknownBody(..))
        ));
        assert!(p.geocentric(" moon ", 2_461_314.5).is_ok());
        for jd in [coverage_start_jd() - 1e-3, coverage_end_jd() + 1e-3] {
            assert!(matches!(
                p.geocentric("Moon", jd),
                Err(EphemerisError::OutOfCoverage { .. })
            ));
        }
        assert!(matches!(
            p.geocentric("Moon", f64::NAN),
            Err(EphemerisError::Data(_))
        ));
        assert!(p.geocentric("Moon", coverage_start_jd()).is_ok());
        assert!(p.geocentric("Moon", coverage_end_jd()).is_ok());
    }

    #[test]
    fn illumination_limits() {
        // Sun and Moon together: new moon, dark, bright limb toward the Sun.
        let new = illumination(10.0, 0.0, 384_400.0, 10.0, 1.0, AU_KM);
        assert!(new.illuminated_fraction < 0.001, "{new:?}");
        assert!((new.bright_limb_angle_deg - 0.0).abs() < 1e-6, "{new:?}");
        // Opposite: full.
        let full = illumination(190.0, 0.0, 384_400.0, 10.0, 0.0, AU_KM);
        assert!(full.illuminated_fraction > 0.999, "{full:?}");
        assert!((full.magnitude + 12.73).abs() < 0.02, "{full:?}");
        // Quadrature: half lit, Sun to the east (larger RA) gives a limb angle of 90.
        let quarter = illumination(100.0, 0.0, 384_400.0, 190.0, 0.0, AU_KM);
        assert!(
            (quarter.illuminated_fraction - 0.5).abs() < 0.003,
            "{quarter:?}"
        );
        assert!(
            (quarter.bright_limb_angle_deg - 90.0).abs() < 1e-6,
            "{quarter:?}"
        );
        assert!((quarter.elongation_deg - 90.0).abs() < 1e-9);
    }

    #[test]
    fn the_sky_registry_serves_the_moon_consistently() {
        use crate::body::Sky;
        let sky = Sky::new();
        let jd = 2_461_314.562_5; // 2026-10-01T01:30Z
        let st = sky.apparent_state(" moon", jd).unwrap();
        let dir = sky.geocentric("MOON", jd).unwrap();
        assert_eq!(st.body, "Moon");
        assert_eq!(st.kind, BodyKind::Moon);
        assert_eq!(st.gha_deg, dir.gha_deg);
        assert_eq!(st.dec_deg, dir.dec_deg);
        assert_eq!(st.semidiameter_arcmin, dir.semidiameter_arcmin);
        assert_eq!(
            st.horizontal_parallax_arcmin,
            dir.horizontal_parallax_arcmin
        );
        // SD / HP is k to first order; HP about a degree.
        let ratio = st.semidiameter_arcmin / st.horizontal_parallax_arcmin;
        assert!((ratio - MOON_RADIUS_RATIO_K).abs() < 1e-4, "{ratio}");
        assert!((53.0..62.0).contains(&st.horizontal_parallax_arcmin));
        // Waning gibbous that night (USNO: 77 % illuminated).
        let k = st.illuminated_fraction.unwrap();
        assert!((0.76..0.79).contains(&k), "{k}");
        assert!(st.magnitude.unwrap() < -11.0);
        let cov = sky
            .coverage_groups()
            .into_iter()
            .find(|c| c.bodies == ["Moon"])
            .unwrap();
        assert!(cov.accuracy_arcmin.is_finite() && cov.accuracy_arcmin <= 0.1);
    }

    #[test]
    fn gha_runs_at_the_lunar_rate_not_the_sidereal_one() {
        // CONVENTIONS 13.1: the clock term needs the Moon's own GHA rate, 15.04 deg/h
        // less the Moon's motion in RA (0.45 to 0.7 deg/h), never the sidereal rate.
        let p = MoonProvider::new();
        let start = 2_461_300.5;
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for i in 0..60 {
            let r = p
                .gha_rate_deg_per_hour("Moon", start + f64::from(i) * 0.5)
                .unwrap();
            lo = lo.min(r);
            hi = hi.max(r);
        }
        assert!(lo > 14.1 && hi < 14.9 && hi - lo > 0.1, "{lo}..{hi} deg/h");
    }

    #[test]
    fn dut1_moves_only_the_hour_angle() {
        let jd = 2_461_314.562_5;
        let a = MoonProvider::new().position(jd).unwrap();
        let b = MoonProvider::with_dut1_s(0.5).position(jd).unwrap();
        assert_eq!(a.ra_deg, b.ra_deg);
        assert_eq!(a.dec_deg, b.dec_deg);
        // 0.5 s of UT1 is 7.52" of Earth rotation.
        let d = (b.gha_deg - a.gha_deg) * 3600.0;
        assert!((d - 7.52).abs() < 0.01, "{d}");
        assert_eq!(MoonProvider::with_dut1_s(0.5).dut1_s(), 0.5);
    }
}
