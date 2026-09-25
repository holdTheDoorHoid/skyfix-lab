//! CONVENTIONS section 7: ICRS catalogue place -> apparent place of date.
//!
//! OWNER: ephemeris agent.
//!
//! Models used, and why each one is good enough for a 0.05' (3") navigation budget:
//!
//! | step | model | residual vs a rigorous reference |
//! |---|---|---|
//! | frame bias + precession | IAU 2006 (P03) Fukushima-Williams angles, `eraPfw06` polynomials | exact (same model) |
//! | nutation | IAU 2000B, 77 luni-solar terms + the fixed planetary offsets, adjusted to P03 | <= 1 mas (0.001") |
//! | mean obliquity | IAU 2006, `eraObl06` polynomial | exact (same model) |
//! | annual aberration | relativistic vector aberration with a Keplerian Earth velocity | see below |
//! | annual parallax | same Keplerian Earth position (cheap, so it is included) | see below |
//! | proper motion | unit-vector space motion from J2000, no radial velocity | <= 0.6" by 2060 (Rigil Kentaurus) |
//! | light deflection by the Sun | included, point-mass Sun, source at infinity | <= 0.001" |
//!
//! The last three rows are checked together rather than separately: the whole chain
//! reproduces ERFA's `eraAtci13` worked example — proper motion, parallax, radial
//! velocity, deflection and aberration with IAU 2000A nutation and the `eraEpv00`
//! Earth ephemeris — to **0.016 arcseconds** (0.00027'), and Meeus's example 23.a to
//! 0.073" (the residual there is the IAU 1976/1980 to IAU 2006/2000B model change,
//! which is expected to be of that size). See
//! `tests/apparent_place_reference.rs`.
//!
//! Everything is a pure `f64` computation: no allocation, no I/O, `wasm32` clean.
//!
//! Frame convention: all vectors below are right-handed equatorial unit vectors
//! `(cos dec cos ra, cos dec sin ra, sin dec)`. Parallax and aberration are vector
//! operations, so they may be applied before or after the bias/precession/nutation
//! rotation provided the Earth position/velocity are expressed in the same frame.
//! This module applies them *after* the rotation, in the true equator and equinox of
//! date, and builds the Earth state directly in that frame. That is Meeus's order in
//! chapter 23 and avoids the `1/cos(dec)` singularity of the scalar aberration
//! formulae, which matters here because Polaris is in the catalogue.

use skyfix_core::time::{JD_J2000, centuries_since_j2000};
use skyfix_core::units::{ARCSEC, DEG, norm_360};

/// One turn in arcseconds; the fundamental arguments are reduced modulo this.
const TURNAS: f64 = 1_296_000.0;
/// 0.1 microarcsecond in radians: the unit of the IAU 2000B series coefficients.
const U2R: f64 = ARCSEC / 1.0e7;
/// One milliarcsecond in radians.
pub const MAS: f64 = ARCSEC / 1000.0;
/// Constant of aberration, 20.49552", in radians. Includes the `1/sqrt(1-e^2)` factor,
/// so it is exactly `mu / h` for the Earth's orbit expressed in units of `c`.
const ABERRATION_CONSTANT_RAD: f64 = 20.49552 * ARCSEC;
/// Julian year, days. Proper motions are per Julian year.
const JULIAN_YEAR_DAYS: f64 = 365.25;
/// Schwarzschild radius of the Sun in astronomical units, `2 GM_sun / c^2 / AU`.
/// IAU 2009 `GM_sun = 1.32712440041e20 m^3 s^-2`, exact `c = 299792458 m/s`,
/// IAU 2012 `AU = 1.49597870700e11 m`. Works out to 1.97412574e-8.
const SOLAR_SCHWARZSCHILD_RADIUS_AU: f64 =
    2.0 * 1.327_124_400_41e20 / (299_792_458.0 * 299_792_458.0) / 1.495_978_707e11;

/// Evaluate `c[0] + c[1] t + c[2] t^2 + ...` by Horner.
fn poly(t: f64, c: &[f64]) -> f64 {
    let mut v = 0.0;
    for &a in c.iter().rev() {
        v = v * t + a;
    }
    v
}

// ---------------------------------------------------------------------------
// Nutation: IAU 2000B (McCarthy & Luzum 2003)
// ---------------------------------------------------------------------------

/// Nutation in longitude and obliquity, radians.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nutation {
    pub dpsi_rad: f64,
    pub deps_rad: f64,
}

#[derive(Clone, Copy)]
struct LuniSolarTerm {
    /// Multipliers of the Delaunay arguments l, l', F, D, Omega.
    n: [i8; 5],
    /// Longitude: sin, t*sin, cos coefficients, units of 0.1 microarcsecond.
    ps: i32,
    pst: i32,
    pc: i32,
    /// Obliquity: cos, t*cos, sin coefficients, units of 0.1 microarcsecond.
    ec: i32,
    ect: i32,
    es: i32,
}

const fn t(n: [i8; 5], ps: i32, pst: i32, pc: i32, ec: i32, ect: i32, es: i32) -> LuniSolarTerm {
    LuniSolarTerm {
        n,
        ps,
        pst,
        pc,
        ec,
        ect,
        es,
    }
}

/// The 77 luni-solar terms of the IAU 2000B nutation model, transcribed from
/// ERFA 2.0 `nut00b.c` (BSD 3-clause; see `docs/THIRD_PARTY.md`). Ordered largest
/// first, exactly as published; the summation runs in reverse so the smallest
/// contributions accumulate first.
#[rustfmt::skip]
const NUT_2000B_LUNI_SOLAR: [LuniSolarTerm; 77] = [
    t([0, 0, 0, 0, 1], -172064161, -174666, 33386, 92052331, 9086, 15377),
    t([0, 0, 2, -2, 2], -13170906, -1675, -13696, 5730336, -3015, -4587),
    t([0, 0, 2, 0, 2], -2276413, -234, 2796, 978459, -485, 1374),
    t([0, 0, 0, 0, 2], 2074554, 207, -698, -897492, 470, -291),
    t([0, 1, 0, 0, 0], 1475877, -3633, 11817, 73871, -184, -1924),
    t([0, 1, 2, -2, 2], -516821, 1226, -524, 224386, -677, -174),
    t([1, 0, 0, 0, 0], 711159, 73, -872, -6750, 0, 358),
    t([0, 0, 2, 0, 1], -387298, -367, 380, 200728, 18, 318),
    t([1, 0, 2, 0, 2], -301461, -36, 816, 129025, -63, 367),
    t([0, -1, 2, -2, 2], 215829, -494, 111, -95929, 299, 132),
    t([0, 0, 2, -2, 1], 128227, 137, 181, -68982, -9, 39),
    t([-1, 0, 2, 0, 2], 123457, 11, 19, -53311, 32, -4),
    t([-1, 0, 0, 2, 0], 156994, 10, -168, -1235, 0, 82),
    t([1, 0, 0, 0, 1], 63110, 63, 27, -33228, 0, -9),
    t([-1, 0, 0, 0, 1], -57976, -63, -189, 31429, 0, -75),
    t([-1, 0, 2, 2, 2], -59641, -11, 149, 25543, -11, 66),
    t([1, 0, 2, 0, 1], -51613, -42, 129, 26366, 0, 78),
    t([-2, 0, 2, 0, 1], 45893, 50, 31, -24236, -10, 20),
    t([0, 0, 0, 2, 0], 63384, 11, -150, -1220, 0, 29),
    t([0, 0, 2, 2, 2], -38571, -1, 158, 16452, -11, 68),
    t([0, -2, 2, -2, 2], 32481, 0, 0, -13870, 0, 0),
    t([-2, 0, 0, 2, 0], -47722, 0, -18, 477, 0, -25),
    t([2, 0, 2, 0, 2], -31046, -1, 131, 13238, -11, 59),
    t([1, 0, 2, -2, 2], 28593, 0, -1, -12338, 10, -3),
    t([-1, 0, 2, 0, 1], 20441, 21, 10, -10758, 0, -3),
    t([2, 0, 0, 0, 0], 29243, 0, -74, -609, 0, 13),
    t([0, 0, 2, 0, 0], 25887, 0, -66, -550, 0, 11),
    t([0, 1, 0, 0, 1], -14053, -25, 79, 8551, -2, -45),
    t([-1, 0, 0, 2, 1], 15164, 10, 11, -8001, 0, -1),
    t([0, 2, 2, -2, 2], -15794, 72, -16, 6850, -42, -5),
    t([0, 0, -2, 2, 0], 21783, 0, 13, -167, 0, 13),
    t([1, 0, 0, -2, 1], -12873, -10, -37, 6953, 0, -14),
    t([0, -1, 0, 0, 1], -12654, 11, 63, 6415, 0, 26),
    t([-1, 0, 2, 2, 1], -10204, 0, 25, 5222, 0, 15),
    t([0, 2, 0, 0, 0], 16707, -85, -10, 168, -1, 10),
    t([1, 0, 2, 2, 2], -7691, 0, 44, 3268, 0, 19),
    t([-2, 0, 2, 0, 0], -11024, 0, -14, 104, 0, 2),
    t([0, 1, 2, 0, 2], 7566, -21, -11, -3250, 0, -5),
    t([0, 0, 2, 2, 1], -6637, -11, 25, 3353, 0, 14),
    t([0, -1, 2, 0, 2], -7141, 21, 8, 3070, 0, 4),
    t([0, 0, 0, 2, 1], -6302, -11, 2, 3272, 0, 4),
    t([1, 0, 2, -2, 1], 5800, 10, 2, -3045, 0, -1),
    t([2, 0, 2, -2, 2], 6443, 0, -7, -2768, 0, -4),
    t([-2, 0, 0, 2, 1], -5774, -11, -15, 3041, 0, -5),
    t([2, 0, 2, 0, 1], -5350, 0, 21, 2695, 0, 12),
    t([0, -1, 2, -2, 1], -4752, -11, -3, 2719, 0, -3),
    t([0, 0, 0, -2, 1], -4940, -11, -21, 2720, 0, -9),
    t([-1, -1, 0, 2, 0], 7350, 0, -8, -51, 0, 4),
    t([2, 0, 0, -2, 1], 4065, 0, 6, -2206, 0, 1),
    t([1, 0, 0, 2, 0], 6579, 0, -24, -199, 0, 2),
    t([0, 1, 2, -2, 1], 3579, 0, 5, -1900, 0, 1),
    t([1, -1, 0, 0, 0], 4725, 0, -6, -41, 0, 3),
    t([-2, 0, 2, 0, 2], -3075, 0, -2, 1313, 0, -1),
    t([3, 0, 2, 0, 2], -2904, 0, 15, 1233, 0, 7),
    t([0, -1, 0, 2, 0], 4348, 0, -10, -81, 0, 2),
    t([1, -1, 2, 0, 2], -2878, 0, 8, 1232, 0, 4),
    t([0, 0, 0, 1, 0], -4230, 0, 5, -20, 0, -2),
    t([-1, -1, 2, 2, 2], -2819, 0, 7, 1207, 0, 3),
    t([-1, 0, 2, 0, 0], -4056, 0, 5, 40, 0, -2),
    t([0, -1, 2, 2, 2], -2647, 0, 11, 1129, 0, 5),
    t([-2, 0, 0, 0, 1], -2294, 0, -10, 1266, 0, -4),
    t([1, 1, 2, 0, 2], 2481, 0, -7, -1062, 0, -3),
    t([2, 0, 0, 0, 1], 2179, 0, -2, -1129, 0, -2),
    t([-1, 1, 0, 1, 0], 3276, 0, 1, -9, 0, 0),
    t([1, 1, 0, 0, 0], -3389, 0, 5, 35, 0, -2),
    t([1, 0, 2, 0, 0], 3339, 0, -13, -107, 0, 1),
    t([-1, 0, 2, -2, 1], -1987, 0, -6, 1073, 0, -2),
    t([1, 0, 0, 0, 2], -1981, 0, 0, 854, 0, 0),
    t([-1, 0, 0, 1, 0], 4026, 0, -353, -553, 0, -139),
    t([0, 0, 2, 1, 2], 1660, 0, -5, -710, 0, -2),
    t([-1, 0, 2, 4, 2], -1521, 0, 9, 647, 0, 4),
    t([-1, 1, 0, 1, 1], 1314, 0, 0, -700, 0, 0),
    t([0, -2, 2, -2, 1], -1283, 0, 0, 672, 0, 0),
    t([1, 0, 2, 2, 1], -1331, 0, 8, 663, 0, 4),
    t([-2, 0, 2, 2, 2], 1383, 0, -2, -594, 0, -2),
    t([-1, 0, 0, 0, 2], 1405, 0, 4, -610, 0, 2),
    t([1, 1, 2, -2, 2], 1290, 0, 0, -556, 0, 0),
];

/// The 10 largest terms of the equation-of-the-equinoxes complementary series
/// (`eraEect00` `e0`), as `(l, l', F, D, Omega, sin_coeff_arcsec, cos_coeff_arcsec)`.
/// The full series never exceeds 0.0027"; truncating here leaves < 0.00002" (3e-7 ').
#[rustfmt::skip]
const EE_COMPLEMENTARY: [([i8; 5], f64, f64); 10] = [
    ([0, 0, 0, 0, 1], 2640.96e-6, -0.39e-6),
    ([0, 0, 0, 0, 2], 63.52e-6, -0.02e-6),
    ([0, 0, 2, -2, 3], 11.75e-6, 0.01e-6),
    ([0, 0, 2, -2, 1], 11.21e-6, 0.01e-6),
    ([0, 0, 2, -2, 2], -4.55e-6, 0.00e-6),
    ([0, 0, 2, 0, 3], 2.02e-6, 0.00e-6),
    ([0, 0, 2, 0, 1], 1.98e-6, 0.00e-6),
    ([0, 0, 0, 0, 3], -1.72e-6, 0.00e-6),
    ([0, 1, 0, 0, 1], -1.41e-6, -0.01e-6),
    ([0, 1, 0, 0, -1], -1.26e-6, -0.01e-6),
];

/// Delaunay arguments `(l, l', F, D, Omega)` in radians: the full Simon et al. (1994)
/// polynomials of the IERS Conventions 2003 (ERFA `eraFal03`, `eraFalp03`, `eraFaf03`,
/// `eraFad03`, `eraFaom03`), four coefficients beyond the constant each.
///
/// IAU 2000B is *published* with the linear parts only (McCarthy & Luzum 2003). Those
/// are fine for a century either side of J2000 but the dropped `t^2..t^4` terms grow
/// quadratically: against IAU 2000A the linear arguments put the 2000B series 29 mas
/// off over 1550-2650 and 950 mas at 2000 BC; with the full polynomials the same 77
/// terms stay within 3 mas of 2000A over the whole -2000..+3000 span (the accuracy
/// audit, `nutation_prec.py`). Inside 1990-2060 the change is under 0.1 mas. The
/// equation of the equinoxes' complementary terms (`eraEect00`) are defined with
/// these same full polynomials, so they now use exactly ERFA's arguments too.
fn delaunay_arguments(tc: f64) -> [f64; 5] {
    let arg = |c: [f64; 5]| (poly(tc, &c) % TURNAS) * ARCSEC;
    [
        arg([
            485_868.249_036,
            1_717_915_923.217_8,
            31.879_2,
            0.051_635,
            -0.000_244_70,
        ]),
        arg([
            1_287_104.793_048,
            129_596_581.048_1,
            -0.553_2,
            0.000_136,
            -0.000_011_49,
        ]),
        arg([
            335_779.526_232,
            1_739_527_262.847_8,
            -12.751_2,
            -0.001_037,
            0.000_004_17,
        ]),
        arg([
            1_072_260.703_692,
            1_602_961_601.209_0,
            -6.370_6,
            0.006_593,
            -0.000_031_69,
        ]),
        arg([
            450_160.398_036,
            -6_962_890.543_1,
            7.472_2,
            0.007_702,
            -0.000_059_39,
        ]),
    ]
}

/// Nutation in longitude and obliquity, IAU 2000B (McCarthy & Luzum 2003).
///
/// 77 luni-solar terms plus the fixed offsets that stand in for the omitted planetary
/// terms, evaluated with the full polynomial fundamental arguments
/// ([`delaunay_arguments`]). Agrees with the full IAU 2000A model to within 1 mas over
/// 1995-2050 and 3 mas over 2000 BC to AD 3000.
pub fn nutation_2000b(jd_tt: f64) -> Nutation {
    let tc = centuries_since_j2000(jd_tt);
    let [el, elp, f, d, om] = delaunay_arguments(tc);

    let (mut dp, mut de) = (0.0f64, 0.0f64);
    // Smallest terms first, as in the published implementation.
    for term in NUT_2000B_LUNI_SOLAR.iter().rev() {
        let arg = f64::from(term.n[0]) * el
            + f64::from(term.n[1]) * elp
            + f64::from(term.n[2]) * f
            + f64::from(term.n[3]) * d
            + f64::from(term.n[4]) * om;
        let (sa, ca) = arg.sin_cos();
        dp += (f64::from(term.ps) + f64::from(term.pst) * tc) * sa + f64::from(term.pc) * ca;
        de += (f64::from(term.ec) + f64::from(term.ect) * tc) * ca + f64::from(term.es) * sa;
    }

    Nutation {
        // Fixed offsets in lieu of the planetary nutation terms.
        dpsi_rad: dp * U2R - 0.135 * MAS,
        deps_rad: de * U2R + 0.388 * MAS,
    }
}

/// IAU 2000B nutation adjusted for use with IAU 2006 precession.
///
/// The 2000A/2000B nutation series were derived against IAU 2000 precession; pairing
/// them with P03 needs the two scale factors of Wallace & Capitaine (2006), Eqs. 5.
/// The adjustment is about 10 microarcseconds - free, so it is applied.
pub fn nutation_2000b_p03(jd_tt: f64) -> Nutation {
    let tc = centuries_since_j2000(jd_tt);
    let fj2 = -2.7774e-6 * tc;
    let n = nutation_2000b(jd_tt);
    Nutation {
        dpsi_rad: n.dpsi_rad * (1.0 + 0.4697e-6 + fj2),
        deps_rad: n.deps_rad * (1.0 + fj2),
    }
}

// ---------------------------------------------------------------------------
// Obliquity and precession: IAU 2006 (P03)
// ---------------------------------------------------------------------------

/// Mean obliquity of the ecliptic, IAU 2006 (`eraObl06` polynomial), radians.
pub fn mean_obliquity_rad(jd_tt: f64) -> f64 {
    let tc = centuries_since_j2000(jd_tt);
    poly(
        tc,
        &[
            84381.406,
            -46.836_769,
            -0.000_183_1,
            0.002_003_40,
            -0.000_000_576,
            -0.000_000_043_4,
        ],
    ) * ARCSEC
}

/// True obliquity = mean obliquity + nutation in obliquity, radians.
pub fn true_obliquity_rad(jd_tt: f64) -> f64 {
    mean_obliquity_rad(jd_tt) + nutation_2000b_p03(jd_tt).deps_rad
}

/// Fukushima-Williams bias + precession angles, IAU 2006 (P03). Radians.
///
/// These are the *bias-included* angles: rotating by them takes a GCRS/ICRS direction
/// to the mean equator and equinox of date, so no separate frame-bias step is needed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FukushimaWilliams {
    pub gamma_bar_rad: f64,
    pub phi_bar_rad: f64,
    pub psi_bar_rad: f64,
    pub eps_a_rad: f64,
}

/// IAU 2006 Fukushima-Williams angles (`eraPfw06` polynomials).
pub fn fukushima_williams_2006(jd_tt: f64) -> FukushimaWilliams {
    let tc = centuries_since_j2000(jd_tt);
    FukushimaWilliams {
        gamma_bar_rad: poly(
            tc,
            &[
                -0.052_928,
                10.556_378,
                0.493_204_4,
                -0.000_312_38,
                -0.000_002_788,
                0.000_000_026_0,
            ],
        ) * ARCSEC,
        phi_bar_rad: poly(
            tc,
            &[
                84_381.412_819,
                -46.811_016,
                0.051_126_8,
                0.000_532_89,
                -0.000_000_440,
                -0.000_000_017_6,
            ],
        ) * ARCSEC,
        psi_bar_rad: poly(
            tc,
            &[
                -0.041_775,
                5_038.481_484,
                1.558_417_5,
                -0.000_185_22,
                -0.000_026_452,
                -0.000_000_014_8,
            ],
        ) * ARCSEC,
        eps_a_rad: mean_obliquity_rad(jd_tt),
    }
}

type Mat3 = [[f64; 3]; 3];

/// `m <- R1(phi) * m` (rotation of the frame about the x-axis).
fn rot_x(phi: f64, m: &mut Mat3) {
    let (s, c) = phi.sin_cos();
    let (a, b) = (m[1], m[2]);
    m[1] = [
        c * a[0] + s * b[0],
        c * a[1] + s * b[1],
        c * a[2] + s * b[2],
    ];
    m[2] = [
        -s * a[0] + c * b[0],
        -s * a[1] + c * b[1],
        -s * a[2] + c * b[2],
    ];
}

/// `m <- R3(psi) * m` (rotation of the frame about the z-axis).
fn rot_z(psi: f64, m: &mut Mat3) {
    let (s, c) = psi.sin_cos();
    let (a, b) = (m[0], m[1]);
    m[0] = [
        c * a[0] + s * b[0],
        c * a[1] + s * b[1],
        c * a[2] + s * b[2],
    ];
    m[1] = [
        -s * a[0] + c * b[0],
        -s * a[1] + c * b[1],
        -s * a[2] + c * b[2],
    ];
}

/// Rotation taking an ICRS/GCRS direction to the **true equator and equinox of date**:
/// frame bias, IAU 2006 precession and IAU 2000B nutation in one matrix.
///
/// This is `eraFw2m(gamb, phib, psib + dpsi, epsa + deps)`, i.e.
/// `R1(-eps) R3(-psi) R1(phi) R3(gamma)`.
pub fn bias_precession_nutation_matrix(jd_tt: f64) -> Mat3 {
    let fw = fukushima_williams_2006(jd_tt);
    let nut = nutation_2000b_p03(jd_tt);
    let mut m: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    rot_z(fw.gamma_bar_rad, &mut m);
    rot_x(fw.phi_bar_rad, &mut m);
    rot_z(-(fw.psi_bar_rad + nut.dpsi_rad), &mut m);
    rot_x(-(fw.eps_a_rad + nut.deps_rad), &mut m);
    m
}

/// Equation of the equinoxes: GAST - GMST, radians.
///
/// `dpsi cos(eps_A)` plus the 10 largest complementary terms of `eraEect00`.
pub fn equation_of_equinoxes_rad(jd_tt: f64) -> f64 {
    let tc = centuries_since_j2000(jd_tt);
    let fa = delaunay_arguments(tc);
    let mut ct = 0.0;
    for (n, sc, cc) in EE_COMPLEMENTARY.iter().rev() {
        let arg: f64 = n
            .iter()
            .zip(fa.iter())
            .map(|(&k, &a)| f64::from(k) * a)
            .sum();
        let (sa, ca) = arg.sin_cos();
        ct += sc * sa + cc * ca;
    }
    nutation_2000b_p03(jd_tt).dpsi_rad * mean_obliquity_rad(jd_tt).cos() + ct * ARCSEC
}

// ---------------------------------------------------------------------------
// Earth's orbit: position and velocity for parallax and aberration
// ---------------------------------------------------------------------------

/// Earth's position and velocity, expressed in the **true equator and equinox of date**.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EarthState {
    /// Heliocentric position, astronomical units. Used as the barycentric position;
    /// the difference (the Sun's motion about the barycentre, <= 0.008 AU) contributes
    /// at most 0.006" of parallax for the nearest navigational star.
    pub pos_au: [f64; 3],
    /// Velocity in units of `c`. Heliocentric, used as barycentric: the neglected
    /// terms (solar motion about the barycentre, the Earth-Moon barycentre wobble and
    /// planetary perturbations) total about 0.02" of aberration.
    pub vel_c: [f64; 3],
}

/// The Earth's orbit at `jd_tt`, from Meeus, *Astronomical Algorithms* 2nd ed.,
/// chapter 25 (the "low accuracy" solar model, 0.01 deg in longitude) plus the
/// longitude of perihelion used in chapter 23.
struct EarthOrbit {
    /// Sun's geometric (true) longitude, degrees, mean equinox of date.
    sun_true_lon_deg: f64,
    /// Eccentricity of the Earth's orbit.
    eccentricity: f64,
    /// Longitude of perihelion of the Earth's orbit, degrees.
    perihelion_lon_deg: f64,
    /// Sun-Earth distance, astronomical units.
    radius_au: f64,
}

fn earth_orbit(jd_tt: f64) -> EarthOrbit {
    let tc = centuries_since_j2000(jd_tt);
    let l0 = poly(tc, &[280.466_46, 36_000.769_83, 0.000_303_2]);
    let m_deg = poly(tc, &[357.529_11, 35_999.050_29, -0.000_153_7]);
    let e = poly(tc, &[0.016_708_634, -0.000_042_037, -0.000_000_126_7]);
    let m_rad = m_deg * DEG;
    // Equation of the centre.
    let c_deg = poly(tc, &[1.914_602, -0.004_817, -0.000_014]) * m_rad.sin()
        + poly(tc, &[0.019_993, -0.000_101]) * (2.0 * m_rad).sin()
        + 0.000_289 * (3.0 * m_rad).sin();
    // True anomaly of the Earth in its orbit is M + C.
    let nu_rad = m_rad + c_deg * DEG;
    EarthOrbit {
        sun_true_lon_deg: l0 + c_deg,
        eccentricity: e,
        perihelion_lon_deg: poly(tc, &[102.937_35, 1.719_46, 0.000_46]),
        radius_au: 1.000_001_018 * (1.0 - e * e) / (1.0 + e * nu_rad.cos()),
    }
}

/// Earth's position (AU) and velocity (units of `c`) in the true equatorial frame of
/// date, from a two-body Keplerian model of the Earth's orbit.
///
/// In the ecliptic of date, with `L` the Sun's geometric longitude, `e` the
/// eccentricity and `w` the longitude of perihelion, the exact Keplerian velocity is
/// `vx = k (sin L - e sin w)`, `vy = k (-cos L + e cos w)` with `k` the constant of
/// aberration in radians. These are the vector form of Meeus's equations (23.3), which
/// this module deliberately does not use in their scalar `1/cos(dec)` form.
pub fn earth_state_of_date(jd_tt: f64) -> EarthState {
    let orbit = earth_orbit(jd_tt);
    let e = orbit.eccentricity;
    let (sin_l, cos_l) = (orbit.sun_true_lon_deg * DEG).sin_cos();
    let (sin_w, cos_w) = (orbit.perihelion_lon_deg * DEG).sin_cos();
    let k = ABERRATION_CONSTANT_RAD;

    // Ecliptic of date. The Earth is opposite the Sun as seen from the Sun.
    let (px, py) = (-orbit.radius_au * cos_l, -orbit.radius_au * sin_l);
    let (vx, vy) = (k * (sin_l - e * sin_w), k * (-cos_l + e * cos_w));

    // Ecliptic of date -> true equator of date.
    let (sin_eps, cos_eps) = true_obliquity_rad(jd_tt).sin_cos();
    EarthState {
        pos_au: [px, py * cos_eps, py * sin_eps],
        vel_c: [vx, vy * cos_eps, vy * sin_eps],
    }
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = dot(v, v).sqrt();
    if n == 0.0 {
        v
    } else {
        [v[0] / n, v[1] / n, v[2] / n]
    }
}

fn apply(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Unit vector from right ascension and declination in degrees.
pub fn unit_vector_from_radec(ra_deg: f64, dec_deg: f64) -> [f64; 3] {
    let (sa, ca) = (ra_deg * DEG).sin_cos();
    let (sd, cd) = (dec_deg * DEG).sin_cos();
    [cd * ca, cd * sa, sd]
}

/// Right ascension `[0, 360)` and declination `[-90, 90]` in degrees from a vector.
pub fn radec_from_vector(v: [f64; 3]) -> (f64, f64) {
    let r = dot(v, v).sqrt();
    if r == 0.0 {
        return (0.0, 0.0);
    }
    let ra = norm_360(v[1].atan2(v[0]) / DEG);
    let dec = (v[2] / r).clamp(-1.0, 1.0).asin() / DEG;
    (ra, dec)
}

// ---------------------------------------------------------------------------
// Proper motion, parallax, aberration
// ---------------------------------------------------------------------------

/// Move an ICRS catalogue position from epoch J2000.0 to `jd_tt` by proper motion.
///
/// Unit-vector space motion: `p(t) = normalise(p0 + t * mu)` with
/// `mu = mu_ra* e_ra + mu_dec e_dec`. Radial velocity is not in the catalogue, so the
/// perspective acceleration is neglected; it reaches about 0.6" for Rigil Kentaurus
/// (parallax 742 mas, the largest in the catalogue) by 2060 and is under 0.01"
/// for every other navigational star.
pub fn proper_motion_from_j2000(
    ra_j2000_deg: f64,
    dec_j2000_deg: f64,
    pm_ra_cosdec_mas_yr: f64,
    pm_dec_mas_yr: f64,
    jd_tt: f64,
) -> [f64; 3] {
    let years = (jd_tt - JD_J2000) / JULIAN_YEAR_DAYS;
    let (sa, ca) = (ra_j2000_deg * DEG).sin_cos();
    let (sd, cd) = (dec_j2000_deg * DEG).sin_cos();
    let p = [cd * ca, cd * sa, sd];
    // Unit vectors of increasing RA (already per cos(dec)) and increasing declination.
    let e_ra = [-sa, ca, 0.0];
    let e_dec = [-sd * ca, -sd * sa, cd];
    let mu_ra = pm_ra_cosdec_mas_yr * MAS;
    let mu_dec = pm_dec_mas_yr * MAS;
    normalize([
        p[0] + years * (mu_ra * e_ra[0] + mu_dec * e_dec[0]),
        p[1] + years * (mu_ra * e_ra[1] + mu_dec * e_dec[1]),
        p[2] + years * (mu_ra * e_ra[2] + mu_dec * e_dec[2]),
    ])
}

/// Annual parallax: shift a barycentric direction to a geocentric one.
/// `earth_pos_au` must be in the same frame as `p`.
pub fn apply_annual_parallax(p: [f64; 3], parallax_mas: f64, earth_pos_au: [f64; 3]) -> [f64; 3] {
    if parallax_mas == 0.0 {
        return p;
    }
    let plx = parallax_mas * MAS;
    normalize([
        p[0] - plx * earth_pos_au[0],
        p[1] - plx * earth_pos_au[1],
        p[2] - plx * earth_pos_au[2],
    ])
}

/// Gravitational light deflection by the Sun, for a source at stellar distance.
///
/// `earth_pos_au` is the heliocentric position of the observer in the same frame as
/// `p`, so `e = earth_pos_au / |earth_pos_au|` is the Sun-to-observer direction. For a
/// source effectively at infinity the Sun-to-source direction equals the observed
/// direction, and the deflection reduces to
/// `p' = p + w (e - (p.e) p)`, `w = SRS / (|E| (1 + p.e))`,
/// which is the classical `0.00407" cot(psi/2)` with `psi` the solar elongation.
///
/// The deflection is 4 mas at 90 deg elongation and 0.23" at 2 deg, so it is under the
/// 0.05' budget everywhere a navigational star is actually observable. It is included
/// because it costs six lines given the Earth position that parallax already needs.
/// `min_denominator` caps the singularity for a source behind the Sun's disc.
pub fn apply_solar_light_deflection(p: [f64; 3], earth_pos_au: [f64; 3]) -> [f64; 3] {
    let em = dot(earth_pos_au, earth_pos_au).sqrt();
    if em == 0.0 {
        return p;
    }
    let e = [
        earth_pos_au[0] / em,
        earth_pos_au[1] / em,
        earth_pos_au[2] / em,
    ];
    let pde = dot(p, e);
    // Grazing the solar limb at 1 AU corresponds to 1 + p.e ~ 1.1e-5; clamp below that
    // so a source geometrically behind the Sun cannot produce an infinite deflection.
    let denom = (1.0 + pde).max(1.0e-6);
    let w = SOLAR_SCHWARZSCHILD_RADIUS_AU / (em * denom);
    normalize([
        p[0] + w * (e[0] - pde * p[0]),
        p[1] + w * (e[1] - pde * p[1]),
        p[2] + w * (e[2] - pde * p[2]),
    ])
}

/// Annual aberration, special-relativistic vector form (`eraAb` without the solar
/// light-deflection retardation term). `vel_c` must be in the same frame as `p` and in
/// units of `c`. Pole-safe: there is no `1/cos(dec)` anywhere.
pub fn apply_annual_aberration(p: [f64; 3], vel_c: [f64; 3]) -> [f64; 3] {
    let v2 = dot(vel_c, vel_c);
    let bm1 = (1.0 - v2).sqrt();
    let pdv = dot(p, vel_c);
    let w1 = 1.0 + pdv / (1.0 + bm1);
    normalize([
        p[0] * bm1 + w1 * vel_c[0],
        p[1] * bm1 + w1 * vel_c[1],
        p[2] * bm1 + w1 * vel_c[2],
    ])
}

/// Apparent right ascension and declination of date, degrees, for an ICRS catalogue
/// star given at epoch **J2000.0**.
///
/// Chain: proper motion from J2000 -> frame bias + IAU 2006 precession + IAU 2000B
/// nutation -> annual parallax -> solar light deflection -> annual aberration. The
/// result is referred to the true equator and equinox of date, which is the Nautical
/// Almanac frame (CONVENTIONS section 7).
pub fn apparent_radec_of_date(
    icrs_ra_deg: f64,
    icrs_dec_deg: f64,
    pm_ra_cosdec_mas_yr: f64,
    pm_dec_mas_yr: f64,
    parallax_mas: f64,
    jd_tt: f64,
) -> (f64, f64) {
    let p = proper_motion_from_j2000(
        icrs_ra_deg,
        icrs_dec_deg,
        pm_ra_cosdec_mas_yr,
        pm_dec_mas_yr,
        jd_tt,
    );
    let m = bias_precession_nutation_matrix(jd_tt);
    let p = apply(&m, p);
    let earth = earth_state_of_date(jd_tt);
    let p = apply_annual_parallax(p, parallax_mas, earth.pos_au);
    let p = apply_solar_light_deflection(p, earth.pos_au);
    let p = apply_annual_aberration(p, earth.vel_c);
    radec_from_vector(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Meeus, *Astronomical Algorithms* 2nd ed., example 23.a (p. 152): the mean place
    /// of theta Persei carried to the mean equinox of 2028 November 13.19 TD by proper
    /// motion and precession is 2h46m11.331s, +49d20'54.54".
    ///
    /// Meeus uses IAU 1976 precession from the FK5 J2000 place; this module uses IAU
    /// 2006 including the ICRS frame bias, so a residual of order 0.1" is expected.
    #[test]
    fn precession_matches_meeus_23a_mean_place() {
        let jd_tt = 2_462_088.69;
        // theta Per: 2h44m11.986s, +49d13'42.48"; pm +0.03425 s/yr in RA, -0.0895"/yr.
        let ra0 = (2.0 + 44.0 / 60.0 + 11.986 / 3600.0) * 15.0;
        let dec0 = 49.0 + 13.0 / 60.0 + 42.48 / 3600.0;
        let pm_ra_cosdec = 0.03425 * 15.0 * (dec0 * DEG).cos() * 1000.0;
        let pm_dec = -0.0895 * 1000.0;
        let p = proper_motion_from_j2000(ra0, dec0, pm_ra_cosdec, pm_dec, jd_tt);
        // Mean equinox of date: precession and bias only, no nutation.
        let fw = fukushima_williams_2006(jd_tt);
        let mut m: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        rot_z(fw.gamma_bar_rad, &mut m);
        rot_x(fw.phi_bar_rad, &mut m);
        rot_z(-fw.psi_bar_rad, &mut m);
        rot_x(-fw.eps_a_rad, &mut m);
        let (ra, dec) = radec_from_vector(apply(&m, p));

        let ra_expected = (2.0 + 46.0 / 60.0 + 11.331 / 3600.0) * 15.0;
        let dec_expected = 49.0 + 20.0 / 60.0 + 54.54 / 3600.0;
        let d_ra_arcsec = (ra - ra_expected) * 3600.0 * (dec * DEG).cos();
        let d_dec_arcsec = (dec - dec_expected) * 3600.0;
        assert!(
            d_ra_arcsec.abs() < 0.5 && d_dec_arcsec.abs() < 0.5,
            "mean place differs by ({d_ra_arcsec:.3}\", {d_dec_arcsec:.3}\")"
        );
    }

    #[test]
    fn earth_velocity_has_the_right_magnitude_and_direction() {
        // 2000-03-20, close to the March equinox: the Sun's longitude is near 0, so
        // the Earth's velocity points to ecliptic longitude 270 deg.
        let jd_tt = 2_451_623.5;
        let s = earth_state_of_date(jd_tt);
        let speed = dot(s.vel_c, s.vel_c).sqrt();
        // 20.49552" +/- the eccentricity modulation.
        assert!(
            (speed / ARCSEC - 20.4955).abs() < 0.4,
            "aberration magnitude {}\"",
            speed / ARCSEC
        );
        // Earth is about 1 AU from the Sun.
        let r = dot(s.pos_au, s.pos_au).sqrt();
        assert!((r - 1.0).abs() < 0.02, "radius {r} AU");
        // Velocity points roughly to ecliptic longitude 270 deg: y component negative.
        assert!(s.vel_c[1] < 0.0, "vel {:?}", s.vel_c);
    }

    #[test]
    fn aberration_displacement_is_bounded_even_at_the_pole() {
        let jd_tt = 2_460_000.5;
        let earth = earth_state_of_date(jd_tt);
        for dec in [0.0, 45.0, 89.26, 89.999] {
            let p = unit_vector_from_radec(37.95, dec);
            let q = apply_annual_aberration(p, earth.vel_c);
            let sep = dot(p, q).clamp(-1.0, 1.0).acos() / ARCSEC;
            assert!(sep <= 21.0, "aberration {sep}\" at dec {dec}");
        }
    }

    #[test]
    fn bpn_matrix_is_orthonormal() {
        let m = bias_precession_nutation_matrix(2_460_000.5);
        for i in 0..3 {
            for j in 0..3 {
                let d: f64 = (0..3).map(|k| m[i][k] * m[j][k]).sum();
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((d - want).abs() < 1e-14, "row {i}.{j} = {d}");
            }
        }
    }

    #[test]
    fn radec_round_trips_through_the_unit_vector() {
        for (ra, dec) in [(0.0, 0.0), (359.9, -89.5), (180.0, 89.26), (123.456, -45.0)] {
            let (a, d) = radec_from_vector(unit_vector_from_radec(ra, dec));
            assert!((a - ra).abs() < 1e-9 && (d - dec).abs() < 1e-9, "{a} {d}");
        }
    }
}
