//! Lieske's E5 theory of the Galilean satellites as Meeus gives it, *Astronomical
//! Algorithms* (2nd ed.), chapter 44, "higher accuracy": mean longitudes, the periodic
//! terms in longitude, latitude and radius vector, precession to the equinox of date and
//! the rotation from Jupiter's equator to the ecliptic.
//!
//! Transcribed from the book's tables (cross-checked term by term against the MIT
//! licensed transcription in `soniakeys/meeus`, `jupitermoons.go`). Meeus's steps 5 and
//! 6 (the view from the Earth) are not here: `satellites.rs` projects the positions
//! itself, from the Earth and from the Sun.

use std::f64::consts::PI;

const P: f64 = PI / 180.0;

/// Jupiter's equatorial radius in E5's unit, km (the unit of every radius vector here;
/// Meeus's perspective constant 2095 = 1 au / 71 398 km).
pub(crate) const E5_UNIT_KM: f64 = 71_398.0;

/// The positions of the four satellites relative to Jupiter's centre, in E5 units
/// (71,398 km), rectangular, referred to the mean ecliptic and equinox of `jd_frame`;
/// and Jupiter's north pole (E5's equator) in the same frame.
#[derive(Debug, Clone, Copy)]
pub(crate) struct E5Positions {
    pub(crate) moons: [[f64; 3]; 4],
    /// Only the tests read it: the moons are projected with the IAU pole.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) pole: [f64; 3],
}

/// Jupiter's orbital node and inclination on the ecliptic of date (Meeus table 31.A,
/// "mean equinox of the date"), radians.
fn jupiter_node_inclination(jd: f64) -> (f64, f64) {
    let t = (jd - 2_451_545.0) / 36_525.0;
    let node = 100.464_407 + t * (1.020_977_4 + t * (0.000_403_15 + t * 0.000_000_404));
    let inc = 1.303_267 + t * (-0.005_496_5 + t * (0.000_004_66 - t * 0.000_000_002));
    (node * P, inc * P)
}

/// E5 at the satellites' own time `jd_theory` (TT Julian date: Meeus's `JDE - tau`),
/// rotated to the ecliptic and equinox of `jd_frame` (the observation's TT).
pub(crate) fn positions(jd_theory: f64, jd_frame: f64) -> E5Positions {
    let t = jd_theory - 2_443_000.5;
    let l1 = 106.077_19 * P + 203.488_955_790 * P * t;
    let l2 = 175.731_61 * P + 101.374_724_735 * P * t;
    let l3 = 120.558_83 * P + 50.317_609_207 * P * t;
    let l4 = 84.444_59 * P + 21.571_071_177 * P * t;
    let pi1 = 97.0881 * P + 0.161_385_86 * P * t;
    let pi2 = 154.8663 * P + 0.047_263_07 * P * t;
    let pi3 = 188.1840 * P + 0.007_127_34 * P * t;
    let pi4 = 335.2868 * P + 0.001_840_00 * P * t;
    let w1 = 312.3346 * P - 0.132_793_86 * P * t;
    let w2 = 100.4411 * P - 0.032_630_64 * P * t;
    let w3 = 119.1942 * P - 0.007_177_03 * P * t;
    let w4 = 322.6186 * P - 0.001_759_34 * P * t;
    // Principal inequality in the longitude of Jupiter.
    let gamma = 0.330_33 * P * (163.679 * P + 0.001_051_2 * P * t).sin()
        + 0.034_39 * P * (34.486 * P - 0.016_173_1 * P * t).sin();
    // Phase of free libration.
    let phl = 199.6766 * P + 0.173_791_9 * P * t;
    // Longitude of the node of Jupiter's equator on the ecliptic.
    let mut psi = 316.5182 * P - 0.000_002_08 * P * t;
    // Mean anomalies of Jupiter and Saturn; longitude of Jupiter's perihelion.
    let g = 30.237_56 * P + 0.083_092_570_1 * P * t + gamma;
    let gp = 31.978_53 * P + 0.033_459_733_9 * P * t;
    let pj = 13.469_942 * P;

    let s = f64::sin;
    let sig1 = P
        * (0.472_59 * s(2.0 * (l1 - l2)) - 0.034_78 * s(pi3 - pi4)
            + 0.010_81 * s(l2 - 2.0 * l3 + pi3)
            + 0.007_38 * s(phl)
            + 0.007_13 * s(l2 - 2.0 * l3 + pi2)
            - 0.006_74 * s(pi1 + pi3 - 2.0 * pj - 2.0 * g)
            + 0.006_66 * s(l2 - 2.0 * l3 + pi4)
            + 0.004_45 * s(l1 - pi3)
            - 0.003_54 * s(l1 - l2)
            - 0.003_17 * s(2.0 * psi - 2.0 * pj)
            + 0.002_65 * s(l1 - pi4)
            - 0.001_86 * s(g)
            + 0.001_62 * s(pi2 - pi3)
            + 0.001_58 * s(4.0 * (l1 - l2))
            - 0.001_55 * s(l1 - l3)
            - 0.001_38 * s(psi + w3 - 2.0 * pj - 2.0 * g)
            - 0.001_15 * s(2.0 * (l1 - 2.0 * l2 + w2))
            + 0.000_89 * s(pi2 - pi4)
            + 0.000_85 * s(l1 + pi3 - 2.0 * pj - 2.0 * g)
            + 0.000_83 * s(w2 - w3)
            + 0.000_53 * s(psi - w2));
    let sig2 = P
        * (1.064_76 * s(2.0 * (l2 - l3))
            + 0.042_56 * s(l1 - 2.0 * l2 + pi3)
            + 0.035_81 * s(l2 - pi3)
            + 0.023_95 * s(l1 - 2.0 * l2 + pi4)
            + 0.019_84 * s(l2 - pi4)
            - 0.017_78 * s(phl)
            + 0.016_54 * s(l2 - pi2)
            + 0.013_34 * s(l2 - 2.0 * l3 + pi2)
            + 0.012_94 * s(pi3 - pi4)
            - 0.011_42 * s(l2 - l3)
            - 0.010_57 * s(g)
            - 0.007_75 * s(2.0 * (psi - pj))
            + 0.005_24 * s(2.0 * (l1 - l2))
            - 0.004_60 * s(l1 - l3)
            + 0.003_16 * s(psi - 2.0 * g + w3 - 2.0 * pj)
            - 0.002_03 * s(pi1 + pi3 - 2.0 * pj - 2.0 * g)
            + 0.001_46 * s(psi - w3)
            - 0.001_45 * s(2.0 * g)
            + 0.001_25 * s(psi - w4)
            - 0.001_15 * s(l1 - 2.0 * l3 + pi3)
            - 0.000_94 * s(2.0 * (l2 - w2))
            + 0.000_86 * s(2.0 * (l1 - 2.0 * l2 + w2))
            - 0.000_86 * s(5.0 * gp - 2.0 * g + 52.225 * P)
            - 0.000_78 * s(l2 - l4)
            - 0.000_64 * s(3.0 * l3 - 7.0 * l4 + 4.0 * pi4)
            + 0.000_64 * s(pi1 - pi4)
            - 0.000_63 * s(l1 - 2.0 * l3 + pi4)
            + 0.000_58 * s(w3 - w4)
            + 0.000_56 * s(2.0 * (psi - pj - g))
            + 0.000_56 * s(2.0 * (l2 - l4))
            + 0.000_55 * s(2.0 * (l1 - l3))
            + 0.000_52 * s(3.0 * l3 - 7.0 * l4 + pi3 + 3.0 * pi4)
            - 0.000_43 * s(l1 - pi3)
            + 0.000_41 * s(5.0 * (l2 - l3))
            + 0.000_41 * s(pi4 - pj)
            + 0.000_32 * s(w2 - w3)
            + 0.000_32 * s(2.0 * (l3 - g - pj)));
    let sig3 = P
        * (0.164_90 * s(l3 - pi3) + 0.090_81 * s(l3 - pi4) - 0.069_07 * s(l2 - l3)
            + 0.037_84 * s(pi3 - pi4)
            + 0.018_46 * s(2.0 * (l3 - l4))
            - 0.013_40 * s(g)
            - 0.010_14 * s(2.0 * (psi - pj))
            + 0.007_04 * s(l2 - 2.0 * l3 + pi3)
            - 0.006_20 * s(l2 - 2.0 * l3 + pi2)
            - 0.005_41 * s(l3 - l4)
            + 0.003_81 * s(l2 - 2.0 * l3 + pi4)
            + 0.002_35 * s(psi - w3)
            + 0.001_98 * s(psi - w4)
            + 0.001_76 * s(phl)
            + 0.001_30 * s(3.0 * (l3 - l4))
            + 0.001_25 * s(l1 - l3)
            - 0.001_19 * s(5.0 * gp - 2.0 * g + 52.225 * P)
            + 0.001_09 * s(l1 - l2)
            - 0.001_00 * s(3.0 * l3 - 7.0 * l4 + 4.0 * pi4)
            + 0.000_91 * s(w3 - w4)
            + 0.000_80 * s(3.0 * l3 - 7.0 * l4 + pi3 + 3.0 * pi4)
            - 0.000_75 * s(2.0 * l2 - 3.0 * l3 + pi3)
            + 0.000_72 * s(pi1 + pi3 - 2.0 * pj - 2.0 * g)
            + 0.000_69 * s(pi4 - pj)
            - 0.000_58 * s(2.0 * l3 - 3.0 * l4 + pi4)
            - 0.000_57 * s(l3 - 2.0 * l4 + pi4)
            + 0.000_56 * s(l3 + pi3 - 2.0 * pj - 2.0 * g)
            - 0.000_52 * s(l2 - 2.0 * l3 + pi1)
            - 0.000_50 * s(pi2 - pi3)
            + 0.000_48 * s(l3 - 2.0 * l4 + pi3)
            - 0.000_45 * s(2.0 * l2 - 3.0 * l3 + pi4)
            - 0.000_41 * s(pi2 - pi4)
            - 0.000_38 * s(2.0 * g)
            - 0.000_37 * s(pi3 - pi4 + w3 - w4)
            - 0.000_32 * s(3.0 * l3 - 7.0 * l4 + 2.0 * pi3 + 2.0 * pi4)
            + 0.000_30 * s(4.0 * (l3 - l4))
            + 0.000_29 * s(l3 + pi4 - 2.0 * pj - 2.0 * g)
            - 0.000_28 * s(w3 + psi - 2.0 * pj - 2.0 * g)
            + 0.000_26 * s(l3 - pj - g)
            + 0.000_24 * s(l2 - 3.0 * l3 + 2.0 * l4)
            + 0.000_21 * s(2.0 * (l3 - pj - g))
            - 0.000_21 * s(l3 - pi2)
            + 0.000_17 * s(2.0 * (l3 - pi3)));
    let sig4 = P
        * (0.842_87 * s(l4 - pi4) + 0.034_31 * s(pi4 - pi3)
            - 0.033_05 * s(2.0 * (psi - pj))
            - 0.032_11 * s(g)
            - 0.018_62 * s(l4 - pi3)
            + 0.011_86 * s(psi - w4)
            + 0.006_23 * s(l4 + pi4 - 2.0 * g - 2.0 * pj)
            + 0.003_87 * s(2.0 * (l4 - pi4))
            - 0.002_84 * s(5.0 * gp - 2.0 * g + 52.225 * P)
            - 0.002_34 * s(2.0 * (psi - pi4))
            - 0.002_23 * s(l3 - l4)
            - 0.002_08 * s(l4 - pj)
            + 0.001_78 * s(psi + w4 - 2.0 * pi4)
            + 0.001_34 * s(pi4 - pj)
            + 0.001_25 * s(2.0 * (l4 - g - pj))
            - 0.001_17 * s(2.0 * g)
            - 0.001_12 * s(2.0 * (l3 - l4))
            + 0.001_07 * s(3.0 * l3 - 7.0 * l4 + 4.0 * pi4)
            + 0.001_02 * s(l4 - g - pj)
            + 0.000_96 * s(2.0 * l4 - psi - w4)
            + 0.000_87 * s(2.0 * (psi - w4))
            - 0.000_85 * s(3.0 * l3 - 7.0 * l4 + pi3 + 3.0 * pi4)
            + 0.000_85 * s(l3 - 2.0 * l4 + pi4)
            - 0.000_81 * s(2.0 * (l4 - psi))
            + 0.000_71 * s(l4 + pi4 - 2.0 * pj - 3.0 * g)
            + 0.000_61 * s(l1 - l4)
            - 0.000_56 * s(psi - w3)
            - 0.000_54 * s(l3 - 2.0 * l4 + pi3)
            + 0.000_51 * s(l2 - l4)
            + 0.000_42 * s(2.0 * (psi - g - pj))
            + 0.000_39 * s(2.0 * (pi4 - w4))
            + 0.000_36 * s(psi + pj - pi4 - w4)
            + 0.000_35 * s(2.0 * gp - g + 188.37 * P)
            - 0.000_35 * s(l4 - pi4 + 2.0 * pj - 2.0 * psi)
            - 0.000_32 * s(l4 + pi4 - 2.0 * pj - g)
            + 0.000_30 * s(2.0 * gp - 2.0 * g + 149.15 * P)
            + 0.000_29 * s(3.0 * l3 - 7.0 * l4 + 2.0 * pi3 + 2.0 * pi4)
            + 0.000_28 * s(l4 - pi4 + 2.0 * psi - 2.0 * pj)
            - 0.000_28 * s(2.0 * (l4 - w4))
            - 0.000_27 * s(pi3 - pi4 + w3 - w4)
            - 0.000_26 * s(5.0 * gp - 3.0 * g + 188.37 * P)
            + 0.000_25 * s(w4 - w3)
            - 0.000_25 * s(l2 - 3.0 * l3 + 2.0 * l4)
            - 0.000_23 * s(3.0 * (l3 - l4))
            + 0.000_21 * s(2.0 * l4 - 2.0 * pj - 3.0 * g)
            - 0.000_21 * s(2.0 * l3 - 3.0 * l4 + pi4)
            + 0.000_19 * s(l4 - pi4 - g)
            - 0.000_19 * s(2.0 * l4 - pi3 - pi4)
            - 0.000_18 * s(l4 - pi4 + g)
            - 0.000_16 * s(l4 + pi3 - 2.0 * pj - 2.0 * g));

    let big_l = [l1 + sig1, l2 + sig2, l3 + sig3, l4 + sig4];
    let (ll1, ll2, ll3, ll4) = (big_l[0], big_l[1], big_l[2], big_l[3]);
    // Latitudes on Jupiter's equator (the tangents of B).
    let tan_b = [
        0.000_639_3 * s(ll1 - w1) + 0.000_182_5 * s(ll1 - w2) + 0.000_032_9 * s(ll1 - w3)
            - 0.000_031_1 * s(ll1 - psi)
            + 0.000_009_3 * s(ll1 - w4)
            + 0.000_007_5 * s(3.0 * ll1 - 4.0 * l2 - 1.9927 * sig1 + w2)
            + 0.000_004_6 * s(ll1 + psi - 2.0 * pj - 2.0 * g),
        0.008_100_4 * s(ll2 - w2) + 0.000_451_2 * s(ll2 - w3) - 0.000_328_4 * s(ll2 - psi)
            + 0.000_116_0 * s(ll2 - w4)
            + 0.000_027_2 * s(l1 - 2.0 * l3 + 1.0146 * sig2 + w2)
            - 0.000_014_4 * s(ll2 - w1)
            + 0.000_014_3 * s(ll2 + psi - 2.0 * pj - 2.0 * g)
            + 0.000_003_5 * s(ll2 - psi + g)
            - 0.000_002_8 * s(l1 - 2.0 * l3 + 1.0146 * sig2 + w3),
        0.003_240_2 * s(ll3 - w3) - 0.001_691_1 * s(ll3 - psi) + 0.000_684_7 * s(ll3 - w4)
            - 0.000_279_7 * s(ll3 - w2)
            + 0.000_032_1 * s(ll3 + psi - 2.0 * pj - 2.0 * g)
            + 0.000_005_1 * s(ll3 - psi + g)
            - 0.000_004_5 * s(ll3 - psi - g)
            - 0.000_004_5 * s(ll3 + psi - 2.0 * pj)
            + 0.000_003_7 * s(ll3 + psi - 2.0 * pj - 3.0 * g)
            + 0.000_003_0 * s(2.0 * l2 - 3.0 * ll3 + 4.03 * sig3 + w2)
            - 0.000_002_1 * s(2.0 * l2 - 3.0 * ll3 + 4.03 * sig3 + w3),
        -0.007_657_9 * s(ll4 - psi) + 0.004_413_4 * s(ll4 - w4) - 0.000_511_2 * s(ll4 - w3)
            + 0.000_077_3 * s(ll4 + psi - 2.0 * pj - 2.0 * g)
            + 0.000_010_4 * s(ll4 - psi + g)
            - 0.000_010_2 * s(ll4 - psi - g)
            + 0.000_008_8 * s(ll4 + psi - 2.0 * pj - 3.0 * g)
            - 0.000_003_8 * s(ll4 + psi - 2.0 * pj - g),
    ];
    let c = f64::cos;
    let radius = [
        5.905_69
            * (1.0
                - 0.004_133_9 * c(2.0 * (l1 - l2))
                - 0.000_038_7 * c(l1 - pi3)
                - 0.000_021_4 * c(l1 - pi4)
                + 0.000_017_0 * c(l1 - l2)
                - 0.000_013_1 * c(4.0 * (l1 - l2))
                + 0.000_010_6 * c(l1 - l3)
                - 0.000_006_6 * c(l1 + pi3 - 2.0 * pj - 2.0 * g)),
        9.396_57
            * (1.0 + 0.009_384_8 * c(l1 - l2)
                - 0.000_311_6 * c(l2 - pi3)
                - 0.000_174_4 * c(l2 - pi4)
                - 0.000_144_2 * c(l2 - pi2)
                + 0.000_055_3 * c(l2 - l3)
                + 0.000_052_3 * c(l1 - l3)
                - 0.000_029_0 * c(2.0 * (l1 - l2))
                + 0.000_016_4 * c(2.0 * (l2 - w2))
                + 0.000_010_7 * c(l1 - 2.0 * l3 + pi3)
                - 0.000_010_2 * c(l2 - pi1)
                - 0.000_009_1 * c(2.0 * (l1 - l3))),
        14.988_32
            * (1.0 - 0.001_438_8 * c(l3 - pi3) - 0.000_791_7 * c(l3 - pi4)
                + 0.000_634_2 * c(l2 - l3)
                - 0.000_176_1 * c(2.0 * (l3 - l4))
                + 0.000_029_4 * c(l3 - l4)
                - 0.000_015_6 * c(3.0 * (l3 - l4))
                + 0.000_015_6 * c(l1 - l3)
                - 0.000_015_3 * c(l1 - l2)
                + 0.000_007_0 * c(2.0 * l2 - 3.0 * l3 + pi3)
                - 0.000_005_1 * c(l3 + pi3 - 2.0 * pj - 2.0 * g)),
        26.362_73
            * (1.0 - 0.007_354_6 * c(l4 - pi4)
                + 0.000_162_1 * c(l4 - pi3)
                + 0.000_097_4 * c(l3 - l4)
                - 0.000_054_3 * c(l4 + pi4 - 2.0 * pj - 2.0 * g)
                - 0.000_027_1 * c(2.0 * (l4 - pi4))
                + 0.000_018_2 * c(l4 - pj)
                + 0.000_017_7 * c(2.0 * (l3 - l4))
                - 0.000_016_7 * c(2.0 * l4 - psi - w4)
                + 0.000_016_7 * c(psi - w4)
                - 0.000_015_5 * c(2.0 * (l4 - pj - g))
                + 0.000_014_2 * c(2.0 * (l4 - psi))
                + 0.000_010_5 * c(l1 - l4)
                + 0.000_009_2 * c(l2 - l4)
                - 0.000_008_9 * c(l4 - pj - g)
                - 0.000_006_2 * c(l4 + pi4 - 2.0 * pj - 3.0 * g)
                + 0.000_004_8 * c(2.0 * (l4 - w4))),
    ];

    // Precession from the B1950.0 equinox of the theory to the equinox of date (p. 311).
    let t0 = (jd_frame - 2_433_282.423) / 36_525.0;
    let prec = (1.396_662_6 * P + 0.000_308_8 * P * t0) * t0;
    psi += prec;
    // Inclination of Jupiter's equator on its orbit.
    let t1900 = (jd_frame - 2_415_020.0) / 36_525.0;
    let big_i = 3.120_262 * P + 0.0006 * P * t1900;
    let (node, inc) = jupiter_node_inclination(jd_frame);
    let (si, ci) = big_i.sin_cos();
    let (sphi, cphi) = (psi - node).sin_cos();
    let (sinc, cinc) = inc.sin_cos();
    let (snode, cnode) = node.sin_cos();
    let rotate = |x: f64, y: f64, z: f64| -> [f64; 3] {
        // Step 1: Jupiter's equator to its orbit.
        let a = x;
        let b = y * ci - z * si;
        let c = y * si + z * ci;
        // Step 2: about the orbit's pole by psi - Omega.
        let (a, b) = (a * cphi - b * sphi, a * sphi + b * cphi);
        // Step 3: the orbit to the ecliptic.
        let (b, c) = (b * cinc - c * sinc, b * sinc + c * cinc);
        // Step 4: about the ecliptic pole by Omega.
        let (a, b) = (a * cnode - b * snode, a * snode + b * cnode);
        [a, b, c]
    };
    let mut moons = [[0.0; 3]; 4];
    for k in 0..4 {
        let lon = big_l[k] + prec - psi;
        let b = tan_b[k].atan();
        let (sl, cl) = lon.sin_cos();
        let (sb, cb) = b.sin_cos();
        let r = radius[k];
        moons[k] = rotate(r * cl * cb, r * sl * cb, r * sb);
    }
    E5Positions {
        moons,
        pole: rotate(0.0, 0.0, 1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radius_vectors_are_the_mean_distances() {
        let p = positions(2_451_545.0, 2_451_545.0);
        for (k, mean) in [5.905_69, 9.396_57, 14.988_32, 26.362_73]
            .iter()
            .enumerate()
        {
            let r = (p.moons[k][0].powi(2) + p.moons[k][1].powi(2) + p.moons[k][2].powi(2)).sqrt();
            assert!((r / mean - 1.0).abs() < 0.01, "moon {k}: {r}");
        }
        // Jupiter's pole is about 3 degrees from the ecliptic pole.
        let tilt = p.pole[2].acos().to_degrees();
        assert!((1.5..4.5).contains(&tilt), "{tilt}");
    }
}
