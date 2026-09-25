//! The Moon's libration and orientation: which face is turned to the observer, which
//! way its axis points on the sky, where the Sun stands over it and where the
//! terminator runs.
//!
//! OWNER: moondetail agent (expansion programme P8). CONVENTIONS 13.10; wire format in
//! `docs/EXPLORER_API.md`, "Moon in detail"; accuracy in `docs/ACCURACY.md`, "Moon in
//! detail".
//!
//! # Model
//!
//! The Moon's orientation is the model of Meeus, *Astronomical Algorithms* (2nd ed.,
//! 1998), chapter 53, which is Eckhardt's theory of the physical libration as the
//! *Astronomical Almanac* uses it (Explanatory Supplement 1992, section 7.3), with the
//! IAU inclination of the mean lunar equator to the ecliptic, `I = 1°32′32.7″`:
//!
//! - Cassini's laws place the mean lunar equator at inclination `I` to the ecliptic of
//!   date, its descending node on the mean ascending node `Ω` of the orbit, and the
//!   prime meridian (the mean direction of the Earth) at `F + 180°` from that node,
//!   `F` the Moon's mean argument of latitude (Meeus 47.2-47.7);
//! - the physical libration moves the inclination by `ρ`, the node by `σ / sin I` and
//!   the prime meridian by `τ` (Meeus 53.1, Eckhardt's series to 0.0001°).
//!
//! Where Meeus linearises (his `l″`, `b″` and his position-angle formula), this module
//! builds the rotation those formulas describe, from the true equator and equinox of
//! date to the selenographic frame,
//!
//! ```text
//! M = R3(F + 180° + τ − σ cot I) · R1(−(I + ρ)) · R3(Ω + Δψ + σ / sin I) · R1(ε)
//! ```
//!
//! (`Ri` rotations of the frame; `Δψ` and `ε` the IAU 2000B nutation in longitude and
//! the true obliquity), so the same matrix answers every question: the selenographic
//! longitude and latitude of the direction from the Moon to the Earth's centre (the
//! geocentric libration), to the observer (the topocentric libration: the diurnal
//! part reaches about 1°), and to the Sun (the sub-solar point, which fixes the
//! terminator and the colongitude), and the lunar pole's direction on the sky (the
//! position angle of the axis). Meeus's own closed formulas are kept beside it
//! ([`meeus_libration`]) for the optical and physical parts separately, and the tests
//! hold the two together to a few ten-thousandths of a degree.
//!
//! Positions: the Moon's apparent geocentric place of date from
//! [`skyfix_ephemeris::moon`] (light-time included), the Sun's from
//! [`skyfix_ephemeris::sun`], the observer on the WGS84 ellipsoid (CONVENTIONS 13.2).
//! The orientation is taken at the instant the light left the Moon.
//!
//! # Accuracy
//!
//! Against Skyfield with JPL's DE440 lunar orientation (`moon_pa_de440_200625.bpc` and
//! the `MOON_ME_DE440_ME421` mean-Earth frame): see `tests/moon_libration.rs` and
//! `docs/ACCURACY.md`. The target is 0.05° (EXPANSION_PLAN P8).

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{AU_KM, ApparentState, BodyKind, MOON};
use skyfix_ephemeris::frames::{nutation_2000b_p03, true_obliquity_rad};
use skyfix_ephemeris::moon::{
    EARTH_EQUATORIAL_RADIUS_KM, MEAN_DISTANCE_KM, MOON_RADIUS_RATIO_K, MoonPosition, MoonProvider,
};
use skyfix_ephemeris::sun::{SunPosition, SunProvider};
use skyfix_ephemeris::topocentric::{Site, horizontal};

use crate::sky::AlmanacError;

/// Inclination of the mean lunar equator to the ecliptic, degrees: the IAU value
/// 1°32′32.7″ (Explanatory Supplement 1992, 7.3), which Meeus rounds to 1.54242°.
pub const LUNAR_EQUATOR_INCLINATION_DEG: f64 = 1.0 + 32.0 / 60.0 + 32.7 / 3600.0;

/// The Moon's mean radius, km: `k a` with the ephemeris's `k = 0.2725076` and
/// `a = 6378.14 km` (1738.09 km), the same radius its semidiameter uses.
pub const MOON_RADIUS_KM: f64 = MOON_RADIUS_RATIO_K * EARTH_EQUATORIAL_RADIUS_KM;

/// The fixed tilt between the Moon's figure (principal-axis) pole, which Eckhardt's
/// theory and Cassini's laws describe, and the mean rotation pole of the mean Earth/polar
/// axis frame that selenographic coordinates use (the IAU's, LOLA's and so the
/// gazetteer's): 78.6944″ about the frame's y axis, the DE440 principal-axes-to-mean-Earth
/// rotation (Park et al. 2021; NAIF frame kernel `moon_de440_250416.tf`). The model's
/// prime meridian already follows the mean Earth direction (`F + 180°`), so the kernel's
/// 67.85″ about z does not apply, and its 0.28″ about x is far below the model's accuracy.
pub const FIGURE_TO_MEAN_POLE_ARCSEC: f64 = 78.6944;

pub(crate) type Vec3 = [f64; 3];
pub(crate) type Mat3 = [[f64; 3]; 3];

// ---------------------------------------------------------------------------
// Small vector helpers (shared with the other Moon modules of this crate)
// ---------------------------------------------------------------------------

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub(crate) fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn scale(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

pub(crate) fn unit(a: Vec3) -> Vec3 {
    let n = norm(a);
    if n == 0.0 { a } else { scale(a, 1.0 / n) }
}

pub(crate) fn apply(m: &Mat3, v: Vec3) -> Vec3 {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

pub(crate) fn apply_transpose(m: &Mat3, v: Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut m = [[0.0; 3]; 3];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, x) in row.iter_mut().enumerate() {
            *x = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    m
}

/// Rotation of the frame about x by `t` radians.
fn r1(t: f64) -> Mat3 {
    let (s, c) = t.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]]
}

/// Rotation of the frame about y by `t` radians.
fn r2(t: f64) -> Mat3 {
    let (s, c) = t.sin_cos();
    [[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]]
}

/// Rotation of the frame about z by `t` radians.
fn r3(t: f64) -> Mat3 {
    let (s, c) = t.sin_cos();
    [[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// Unit vector of right ascension and declination, degrees.
pub(crate) fn unit_radec(ra_deg: f64, dec_deg: f64) -> Vec3 {
    let (sa, ca) = ra_deg.to_radians().sin_cos();
    let (sd, cd) = dec_deg.to_radians().sin_cos();
    [cd * ca, cd * sa, sd]
}

/// Local north (increasing declination) and east (increasing right ascension) unit
/// vectors on the celestial sphere at the direction `u`.
pub(crate) fn north_east(u: Vec3) -> (Vec3, Vec3) {
    let e = unit([-u[1], u[0], 0.0]);
    let e = if norm([-u[1], u[0], 0.0]) < 1e-12 {
        [0.0, 1.0, 0.0]
    } else {
        e
    };
    // n = u x e (right-handed: u, e, n with n toward the pole).
    let n = [
        u[1] * e[2] - u[2] * e[1],
        u[2] * e[0] - u[0] * e[2],
        u[0] * e[1] - u[1] * e[0],
    ];
    (n, e)
}

/// Position angle of the direction `p` seen at `u`, from north through east, `[0, 360)`.
pub(crate) fn position_angle_deg(u: Vec3, p: Vec3) -> f64 {
    let (n, e) = north_east(u);
    norm_360(dot(p, e).atan2(dot(p, n)).to_degrees())
}

/// Angle between two vectors, degrees.
pub(crate) fn angle_deg(a: Vec3, b: Vec3) -> f64 {
    let c = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    norm(c).atan2(dot(a, b)).to_degrees()
}

// ---------------------------------------------------------------------------
// Meeus chapter 47 arguments and the physical libration (Meeus 53.1)
// ---------------------------------------------------------------------------

/// The Moon's fundamental arguments of Meeus, *Astronomical Algorithms*, 47.2-47.7 and
/// the two extra arguments of 53.1, degrees (not normalised) and the eccentricity factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FundamentalArguments {
    /// Mean elongation of the Moon `D`.
    pub d_deg: f64,
    /// Sun's mean anomaly `M`.
    pub m_deg: f64,
    /// Moon's mean anomaly `M′`.
    pub mp_deg: f64,
    /// Moon's argument of latitude `F`.
    pub f_deg: f64,
    /// Longitude of the mean ascending node `Ω`, mean equinox of date.
    pub omega_deg: f64,
    /// `E = 1 − 0.002516 T − 0.0000074 T²`.
    pub e: f64,
    /// `K1 = 119.75° + 131.849° T`.
    pub k1_deg: f64,
    /// `K2 = 72.56° + 20.186° T`.
    pub k2_deg: f64,
}

/// Meeus 47.2-47.7 and 53.1's `K1`, `K2` at `jd_tt` (Terrestrial Time, Julian date).
pub fn fundamental_arguments(jd_tt: f64) -> FundamentalArguments {
    let t = (jd_tt - skyfix_core::time::JD_J2000) / 36_525.0;
    let (t2, t3, t4) = (t * t, t * t * t, t * t * t * t);
    FundamentalArguments {
        d_deg: 297.850_192_1 + 445_267.111_403_4 * t - 0.001_881_9 * t2 + t3 / 545_868.0
            - t4 / 113_065_000.0,
        m_deg: 357.529_109_2 + 35_999.050_290_9 * t - 0.000_153_6 * t2 + t3 / 24_490_000.0,
        mp_deg: 134.963_396_4 + 477_198.867_505_5 * t + 0.008_741_4 * t2 + t3 / 69_699.0
            - t4 / 14_712_000.0,
        f_deg: 93.272_095_0 + 483_202.017_523_3 * t - 0.003_653_9 * t2 - t3 / 3_526_000.0
            + t4 / 863_310_000.0,
        omega_deg: 125.044_547_9 - 1_934.136_289_1 * t + 0.002_075_4 * t2 + t3 / 467_441.0
            - t4 / 60_616_000.0,
        e: 1.0 - 0.002_516 * t - 0.000_007_4 * t2,
        k1_deg: 119.75 + 131.849 * t,
        k2_deg: 72.56 + 20.186 * t,
    }
}

/// The physical libration angles of Meeus 53.1 (Eckhardt), degrees: `ρ` (in the
/// inclination of the lunar equator), `σ` (in its node, times `sin I`), `τ` (in the
/// rotation angle). Each is a few hundredths of a degree.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PhysicalLibration {
    pub rho_deg: f64,
    pub sigma_deg: f64,
    pub tau_deg: f64,
}

/// Meeus 53.1: Eckhardt's series for `ρ`, `σ`, `τ`, every term of 0.0001° or more.
pub fn physical_libration(a: &FundamentalArguments) -> PhysicalLibration {
    let r = f64::to_radians;
    let (d, m, mp, f, om) = (
        r(a.d_deg),
        r(a.m_deg),
        r(a.mp_deg),
        r(a.f_deg),
        r(a.omega_deg),
    );
    let (k1, k2, e) = (r(a.k1_deg), r(a.k2_deg), a.e);
    let rho = -0.027_52 * mp.cos() - 0.022_45 * f.sin() + 0.006_84 * (mp - 2.0 * f).cos()
        - 0.002_93 * (2.0 * f).cos()
        - 0.000_85 * (2.0 * f - 2.0 * d).cos()
        - 0.000_54 * (mp - 2.0 * d).cos()
        - 0.000_20 * (mp + f).sin()
        - 0.000_20 * (mp + 2.0 * f).cos()
        - 0.000_20 * (mp - f).cos()
        + 0.000_14 * (mp + 2.0 * f - 2.0 * d).cos();
    let sigma = -0.028_16 * mp.sin() + 0.022_44 * f.cos()
        - 0.006_82 * (mp - 2.0 * f).sin()
        - 0.002_79 * (2.0 * f).sin()
        - 0.000_83 * (2.0 * f - 2.0 * d).sin()
        + 0.000_69 * (mp - 2.0 * d).sin()
        + 0.000_40 * (mp + f).cos()
        - 0.000_25 * (2.0 * mp).sin()
        - 0.000_23 * (mp + 2.0 * f).sin()
        + 0.000_20 * (mp - f).cos()
        + 0.000_19 * (mp - f).sin()
        + 0.000_13 * (mp + 2.0 * f - 2.0 * d).sin()
        - 0.000_10 * (mp - 3.0 * f).cos();
    let tau = 0.025_20 * e * m.sin() + 0.004_73 * (2.0 * mp - 2.0 * f).sin() - 0.004_67 * mp.sin()
        + 0.003_96 * k1.sin()
        + 0.002_76 * (2.0 * mp - 2.0 * d).sin()
        + 0.001_96 * om.sin()
        - 0.001_83 * (mp - f).cos()
        + 0.001_15 * (mp - 2.0 * d).sin()
        - 0.000_96 * (mp - d).sin()
        + 0.000_46 * (2.0 * f - 2.0 * d).sin()
        - 0.000_39 * (mp - f).sin()
        - 0.000_32 * (mp - m - d).sin()
        + 0.000_27 * (2.0 * mp - m - 2.0 * d).sin()
        + 0.000_23 * k2.sin()
        - 0.000_14 * (2.0 * d).sin()
        + 0.000_14 * (2.0 * mp - 2.0 * f).cos()
        - 0.000_12 * (mp - 2.0 * f).sin()
        - 0.000_12 * (2.0 * mp).sin()
        + 0.000_11 * (2.0 * mp - 2.0 * m - 2.0 * d).sin();
    PhysicalLibration {
        rho_deg: rho,
        sigma_deg: sigma,
        tau_deg: tau,
    }
}

/// Meeus's closed formulas for the geocentric libration (53.1 and the two lines
/// after it), degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MeeusLibration {
    /// Optical libration in longitude `l′` and latitude `b′`.
    pub optical_lon_deg: f64,
    pub optical_lat_deg: f64,
    /// Physical libration in longitude `l″` and latitude `b″` (linearised).
    pub physical_lon_deg: f64,
    pub physical_lat_deg: f64,
    /// Meeus's auxiliary angle `A`, degrees.
    pub a_deg: f64,
}

/// Meeus 53.1 from the Moon's apparent geocentric ecliptic longitude `λ` and latitude
/// `β` (true equinox and ecliptic of date), the nutation in longitude `Δψ` and the
/// arguments and physical libration at the same instant. Degrees throughout.
pub fn meeus_libration(
    lambda_deg: f64,
    beta_deg: f64,
    dpsi_deg: f64,
    a: &FundamentalArguments,
    p: &PhysicalLibration,
) -> MeeusLibration {
    let i = LUNAR_EQUATOR_INCLINATION_DEG.to_radians();
    let w = (lambda_deg - dpsi_deg - a.omega_deg).to_radians();
    let b = beta_deg.to_radians();
    let big_a = (w.sin() * b.cos() * i.cos() - b.sin() * i.sin()).atan2(w.cos() * b.cos());
    let a_deg = big_a.to_degrees();
    let optical_lon = norm_180(a_deg - a.f_deg);
    let optical_lat = (-w.sin() * b.cos() * i.sin() - b.sin() * i.cos())
        .clamp(-1.0, 1.0)
        .asin();
    let physical_lon =
        -p.tau_deg + (p.rho_deg * big_a.cos() + p.sigma_deg * big_a.sin()) * optical_lat.tan();
    let physical_lat = p.sigma_deg * big_a.cos() - p.rho_deg * big_a.sin();
    MeeusLibration {
        optical_lon_deg: optical_lon,
        optical_lat_deg: optical_lat.to_degrees(),
        physical_lon_deg: physical_lon,
        physical_lat_deg: physical_lat,
        a_deg: norm_360(a_deg),
    }
}

// ---------------------------------------------------------------------------
// The selenographic frame
// ---------------------------------------------------------------------------

/// A selenographic direction or place: latitude north-positive, longitude east-positive
/// (toward Mare Crisium, the IAU convention), `(-180, 180]`, degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Selenographic {
    pub lat_deg: f64,
    pub lon_deg: f64,
}

impl Selenographic {
    /// Unit vector in the selenographic frame (x to 0° 0°, z to the north pole).
    pub fn unit(&self) -> [f64; 3] {
        let (sb, cb) = self.lat_deg.to_radians().sin_cos();
        let (sl, cl) = self.lon_deg.to_radians().sin_cos();
        [cb * cl, cb * sl, sb]
    }

    fn of(v: Vec3) -> Selenographic {
        let r = norm(v);
        Selenographic {
            lat_deg: (v[2] / r).clamp(-1.0, 1.0).asin().to_degrees(),
            lon_deg: norm_180(v[1].atan2(v[0]).to_degrees()),
        }
    }
}

/// The Moon's orientation at one instant: the rotation from the true equator and
/// equinox of date to the selenographic (mean Earth/polar axis) frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonFrame {
    /// Terrestrial Time the orientation belongs to, Julian date.
    pub jd_tt: f64,
    /// `v_selenographic = matrix · v_equatorial_of_date`: the mean Earth/polar axis frame
    /// of IAU selenographic coordinates (and of the named features).
    pub matrix: [[f64; 3]; 3],
    /// The same for the figure frame of Meeus's chapter 53 (Eckhardt's theory, the pole
    /// of the principal axes): `matrix = R2(−78.6944″) · figure_matrix`. Meeus's printed
    /// totals are in this frame.
    pub figure_matrix: [[f64; 3]; 3],
    pub arguments: FundamentalArguments,
    pub physical: PhysicalLibration,
    /// Nutation in longitude, degrees.
    pub dpsi_deg: f64,
}

impl MoonFrame {
    /// The orientation at `jd_tt` (module docs, "Model").
    pub fn at(jd_tt: f64) -> MoonFrame {
        let a = fundamental_arguments(jd_tt);
        let p = physical_libration(&a);
        let dpsi_deg = nutation_2000b_p03(jd_tt).dpsi_rad.to_degrees();
        let eps = true_obliquity_rad(jd_tt);
        let i = LUNAR_EQUATOR_INCLINATION_DEG.to_radians();
        let node = (a.omega_deg + dpsi_deg + p.sigma_deg / i.sin()).to_radians();
        let incl = i + p.rho_deg.to_radians();
        let meridian =
            (a.f_deg + 180.0 + p.tau_deg).to_radians() - p.sigma_deg.to_radians() / i.tan();
        let figure = mat_mul(
            &r3(meridian),
            &mat_mul(&r1(-incl), &mat_mul(&r3(node), &r1(eps))),
        );
        let tilt = -(FIGURE_TO_MEAN_POLE_ARCSEC / 3600.0).to_radians();
        MoonFrame {
            jd_tt,
            matrix: mat_mul(&r2(tilt), &figure),
            figure_matrix: figure,
            arguments: a,
            physical: p,
            dpsi_deg,
        }
    }

    /// Selenographic latitude and longitude of the direction `v` (true equator and
    /// equinox of date; any length).
    pub fn selenographic(&self, v: [f64; 3]) -> Selenographic {
        Selenographic::of(apply(&self.matrix, v))
    }

    /// The unit vector, true equator and equinox of date, of a selenographic direction.
    pub fn equatorial(&self, s: &Selenographic) -> [f64; 3] {
        apply_transpose(&self.matrix, s.unit())
    }

    /// The Moon's north pole (its mean rotation axis), unit vector, true equator of date.
    pub fn pole(&self) -> [f64; 3] {
        apply_transpose(&self.matrix, [0.0, 0.0, 1.0])
    }

    /// [`MoonFrame::selenographic`] in the figure frame of Meeus's chapter 53.
    pub fn figure_selenographic(&self, v: [f64; 3]) -> Selenographic {
        Selenographic::of(apply(&self.figure_matrix, v))
    }

    /// The figure frame's pole (Meeus's axis, whose position angle he calls `P`).
    pub fn figure_pole(&self) -> [f64; 3] {
        apply_transpose(&self.figure_matrix, [0.0, 0.0, 1.0])
    }
}

// ---------------------------------------------------------------------------
// The geometry of one instant, shared by the orientation and the named features
// ---------------------------------------------------------------------------

/// Everything the orientation and the feature list derive from, true equator and
/// equinox of date, kilometres.
#[derive(Debug, Clone)]
pub(crate) struct MoonGeometry {
    pub jd_utc: f64,
    pub moon: MoonPosition,
    pub sun: SunPosition,
    pub frame: MoonFrame,
    /// Geocentric apparent Moon, km.
    pub moon_km: Vec3,
    /// Geocentric apparent Sun, km.
    pub sun_km: Vec3,
    /// Observer, km (the Earth's centre when there is none).
    pub observer_km: Vec3,
    /// Up (the geodetic normal), when there is an observer.
    pub zenith: Option<Vec3>,
    pub site: Option<Site>,
}

impl MoonGeometry {
    pub fn new(
        moon: &MoonProvider,
        sun: &SunProvider,
        site: Option<&Site>,
        jd_utc: f64,
    ) -> Result<MoonGeometry, AlmanacError> {
        if !jd_utc.is_finite() {
            return Err(AlmanacError::invalid("jd_utc must be a finite Julian date"));
        }
        let m = moon
            .position(jd_utc)
            .map_err(|e| AlmanacError::Unavailable {
                body: MOON.to_string(),
                message: e.to_string(),
            })?;
        let s = sun
            .position(jd_utc)
            .map_err(|e| AlmanacError::Unavailable {
                body: "Sun".to_string(),
                message: e.to_string(),
            })?;
        // The orientation when the light left the Moon.
        let frame = MoonFrame::at(m.jd_tt - m.light_time_s / 86_400.0);
        let sun_km = scale(unit_radec(s.ra_deg, s.dec_deg), s.radius_au * AU_KM);
        let (observer_km, zenith) = match site {
            Some(site) => {
                let g = m.gast_deg.to_radians();
                let rot = |v: Vec3| -> Vec3 {
                    let (sg, cg) = g.sin_cos();
                    [v[0] * cg - v[1] * sg, v[0] * sg + v[1] * cg, v[2]]
                };
                let up = site.enu_axes()[2];
                (rot(site.position_km()), Some(rot(up)))
            }
            None => ([0.0; 3], None),
        };
        Ok(MoonGeometry {
            jd_utc,
            moon: m,
            sun: s,
            frame,
            moon_km: m.apparent_km,
            sun_km,
            observer_km,
            zenith,
            site: site.copied(),
        })
    }

    /// From the observer (or the Earth's centre) to the Moon, km.
    pub fn line_of_sight_km(&self) -> Vec3 {
        sub(self.moon_km, self.observer_km)
    }

    /// Unit vector from the observer toward the Moon's centre.
    pub fn toward_moon(&self) -> Vec3 {
        unit(self.line_of_sight_km())
    }

    /// The Moon's semidiameter seen by the observer, degrees.
    pub fn semidiameter_deg(&self) -> f64 {
        (MOON_RADIUS_KM / norm(self.line_of_sight_km()))
            .asin()
            .to_degrees()
    }

    /// Unit vector from the Moon's centre toward the Sun.
    pub fn toward_sun_from_moon(&self) -> Vec3 {
        unit(sub(self.sun_km, self.moon_km))
    }

    /// Parallactic angle at the Moon (position angle of the zenith), degrees, or `None`
    /// without an observer.
    pub fn parallactic_angle_deg(&self) -> Option<f64> {
        self.zenith.map(|z| {
            let a = position_angle_deg(self.toward_moon(), z);
            norm_180(a)
        })
    }

    /// Project a unit vector from the Moon's centre (a point of its surface) onto the
    /// disc the observer sees: `(east, north)` in disc radii, and whether that point
    /// faces the observer.
    pub fn disc(&self, s_eq: Vec3) -> DiscPoint {
        let u = self.toward_moon();
        let (n, e) = north_east(u);
        let east = dot(s_eq, e);
        let north = dot(s_eq, n);
        // A surface point is in view when it faces the observer, beyond the tangent
        // circle: (O - M).s > R, i.e. s.(-u) > sin SD.
        let facing = -dot(s_eq, u);
        let visible = facing > MOON_RADIUS_KM / norm(self.line_of_sight_km());
        let (x, y) = match self.parallactic_angle_deg() {
            Some(q) => {
                let (sq, cq) = q.to_radians().sin_cos();
                (north * sq - east * cq, north * cq + east * sq)
            }
            None => (-east, north),
        };
        DiscPoint {
            east,
            north,
            x,
            y,
            visible,
        }
    }
}

/// Where a point of the Moon appears on its disc, in units of the disc's radius.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DiscPoint {
    /// Toward celestial east (position angle 90°).
    pub east: f64,
    /// Toward celestial north (position angle 0°).
    pub north: f64,
    /// As the observer sees the Moon with the zenith up: `x` to the right, `y` up.
    /// Without an observer, celestial north is up and east is to the left.
    pub x: f64,
    pub y: f64,
    /// The point faces the observer (on the visible hemisphere).
    pub visible: bool,
}

// ---------------------------------------------------------------------------
// The orientation the explorer shows
// ---------------------------------------------------------------------------

/// Libration in longitude and latitude, degrees: the selenographic longitude and
/// latitude of the point of the Moon's surface at the centre of the disc, which is how
/// far the Moon has turned from its mean face. Positive longitude shows more of the
/// eastern (Mare Crisium) limb, positive latitude more of the northern limb.
///
/// `lon_deg`/`lat_deg` are in the mean Earth/polar axis frame of IAU selenographic
/// coordinates. The optical and physical parts are Meeus's, in the figure frame of his
/// chapter 53, so `optical + physical + diurnal` differs from the total by the fixed
/// 78.7″ between the two frames' poles ([`FIGURE_TO_MEAN_POLE_ARCSEC`]): at most 0.022°,
/// in latitude near the centre of the disc.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LibrationAngles {
    /// Total, as the observer sees it (topocentric with an observer, else geocentric).
    pub lon_deg: f64,
    pub lat_deg: f64,
    /// Optical libration (Meeus `l′`, `b′`): geocentric, from the Moon's orbit alone.
    pub optical_lon_deg: f64,
    pub optical_lat_deg: f64,
    /// Physical libration (Meeus `l″`, `b″`, taken exactly from the rotation rather than
    /// linearised): the Moon's own rocking, a few hundredths of a degree.
    pub physical_lon_deg: f64,
    pub physical_lat_deg: f64,
    /// Diurnal (topocentric) libration: the observer's total minus the geocentric
    /// total; 0 without an observer. Up to about 1°.
    pub diurnal_lon_deg: f64,
    pub diurnal_lat_deg: f64,
}

/// The terminator: the great circle 90° from the sub-solar point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Terminator {
    /// Its pole, the sub-solar point.
    pub pole: Selenographic,
    /// Where the sunrise (morning) terminator crosses the lunar equator: longitude
    /// `−colongitude`, degrees.
    pub morning_lon_deg: f64,
    /// Where the sunset (evening) terminator crosses the equator, degrees.
    pub evening_lon_deg: f64,
    /// The whole circle every 5°, `[lat_deg, lon_deg]`, starting on the morning
    /// terminator at the equator and heading north.
    pub points: Vec<[f64; 2]>,
    /// The part the observer can see, on the disc, `[x, y]` in disc radii (as
    /// [`DiscPoint::x`], [`DiscPoint::y`]), from one cusp to the other; empty at new
    /// Moon when none of it faces the observer.
    pub disc: Vec<[f64; 2]>,
}

/// Everything about how the Moon is turned and lit, for one observer (or the Earth's
/// centre) at one instant. Wire shape: `docs/EXPLORER_API.md`, `moon_orientation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonOrientation {
    pub jd_utc: f64,
    pub utc: String,
    /// True when an observer was given (topocentric values), false for the Earth's
    /// centre.
    pub topocentric: bool,
    pub libration: LibrationAngles,
    /// The point of the Moon at the centre of the observer's disc (= `libration`).
    pub sub_observer: Selenographic,
    /// The point at the centre of the geocentric disc.
    pub sub_earth: Selenographic,
    /// Where the Sun is overhead on the Moon.
    pub sub_solar: Selenographic,
    /// Selenographic colongitude of the Sun, `90° − sub-solar longitude` in `[0, 360)`:
    /// about 270° at new Moon, 0° at first quarter, 90° at full, 180° at last quarter.
    pub colongitude_deg: f64,
    /// Position angle of the Moon's north pole (its axis) as the observer sees it,
    /// from celestial north through east, `[0, 360)`.
    pub axis_position_angle_deg: f64,
    /// The same from the Earth's centre (the almanac's `P`).
    pub geocentric_axis_position_angle_deg: f64,
    /// Position angle of the bright limb's midpoint from the ephemeris (geocentric,
    /// CONVENTIONS 13.5), degrees.
    pub bright_limb_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub phase_angle_deg: f64,
    /// The illuminated part is growing (the Moon is between new and full).
    pub waxing: bool,
    pub terminator: Terminator,
    /// Distance from the observer (or the Earth's centre) to the Moon's centre, km.
    pub distance_km: f64,
    /// Semidiameter and diameter the observer sees, arcminutes.
    pub semidiameter_arcmin: f64,
    pub apparent_diameter_arcmin: f64,
    /// How much larger the disc looks than at the mean distance of 384 400 km, percent
    /// (negative when smaller).
    pub diameter_vs_mean_percent: f64,
    pub geocentric_distance_km: f64,
    pub geocentric_semidiameter_arcmin: f64,
    /// Topocentric geometric altitude and azimuth of the Moon's centre (CONVENTIONS
    /// 13.2); `None` without an observer.
    pub alt_deg: Option<f64>,
    pub az_deg: Option<f64>,
    /// Position angle of the zenith at the Moon, degrees in `(-180, 180]`; `None`
    /// without an observer. `DiscPoint::x/y` are rotated by it.
    pub parallactic_angle_deg: Option<f64>,
    /// Where the Moon's north pole and the sub-solar point fall on the disc.
    pub north_pole_disc: DiscPoint,
    pub sub_solar_disc: DiscPoint,
}

/// How the Moon is turned and lit at `jd_utc`, from `site` or, when `site` is `None`,
/// from the Earth's centre. Fails only when the Moon or the Sun cannot be computed.
pub fn moon_orientation(
    moon: &MoonProvider,
    sun: &SunProvider,
    site: Option<&Site>,
    jd_utc: f64,
) -> Result<MoonOrientation, AlmanacError> {
    let g = MoonGeometry::new(moon, sun, site, jd_utc)?;
    Ok(orientation_of(&g))
}

pub(crate) fn orientation_of(g: &MoonGeometry) -> MoonOrientation {
    let frame = &g.frame;
    let sub_earth = frame.selenographic(scale(g.moon_km, -1.0));
    let figure_earth = frame.figure_selenographic(scale(g.moon_km, -1.0));
    let sub_observer = frame.selenographic(sub(g.observer_km, g.moon_km));
    let sub_solar = frame.selenographic(sub(g.sun_km, g.moon_km));
    let meeus = meeus_libration(
        g.moon.ecliptic_longitude_deg,
        g.moon.ecliptic_latitude_deg,
        frame.dpsi_deg,
        &frame.arguments,
        &frame.physical,
    );
    let pole = frame.pole();
    let lit = skyfix_ephemeris::moon::illumination(
        g.moon.ra_deg,
        g.moon.dec_deg,
        g.moon.distance_km,
        g.sun.ra_deg,
        g.sun.dec_deg,
        g.sun.radius_au * AU_KM,
    );
    // Waxing: the Moon is east of the Sun (ecliptic longitude difference in (0, 180)).
    let waxing = norm_360(g.moon.ecliptic_longitude_deg - g.sun.apparent_longitude_deg) < 180.0;
    let colongitude_deg = norm_360(90.0 - sub_solar.lon_deg);
    let los = g.line_of_sight_km();
    let distance_km = norm(los);
    let sd_deg = g.semidiameter_deg();
    let (alt_deg, az_deg) = match &g.site {
        Some(site) => {
            let h = horizontal(&moon_state(&g.moon), site);
            (Some(h.alt_deg), Some(h.az_deg))
        }
        None => (None, None),
    };
    MoonOrientation {
        jd_utc: g.jd_utc,
        utc: format_utc(g.jd_utc),
        topocentric: g.site.is_some(),
        libration: LibrationAngles {
            lon_deg: sub_observer.lon_deg,
            lat_deg: sub_observer.lat_deg,
            optical_lon_deg: meeus.optical_lon_deg,
            optical_lat_deg: meeus.optical_lat_deg,
            physical_lon_deg: norm_180(figure_earth.lon_deg - meeus.optical_lon_deg),
            physical_lat_deg: figure_earth.lat_deg - meeus.optical_lat_deg,
            diurnal_lon_deg: norm_180(sub_observer.lon_deg - sub_earth.lon_deg),
            diurnal_lat_deg: sub_observer.lat_deg - sub_earth.lat_deg,
        },
        sub_observer,
        sub_earth,
        sub_solar,
        colongitude_deg,
        axis_position_angle_deg: position_angle_deg(unit(los), pole),
        geocentric_axis_position_angle_deg: position_angle_deg(unit(g.moon_km), pole),
        bright_limb_angle_deg: lit.bright_limb_angle_deg,
        illuminated_fraction: lit.illuminated_fraction,
        phase_angle_deg: lit.phase_angle_deg,
        waxing,
        terminator: terminator(g, &sub_solar),
        distance_km,
        semidiameter_arcmin: sd_deg * 60.0,
        apparent_diameter_arcmin: 2.0 * sd_deg * 60.0,
        diameter_vs_mean_percent: (MEAN_DISTANCE_KM / distance_km - 1.0) * 100.0,
        geocentric_distance_km: g.moon.distance_km,
        geocentric_semidiameter_arcmin: g.moon.semidiameter_arcmin,
        alt_deg,
        az_deg,
        parallactic_angle_deg: g.parallactic_angle_deg(),
        north_pole_disc: g.disc(pole),
        sub_solar_disc: g.disc(g.toward_sun_from_moon()),
    }
}

/// The Moon as the display code's [`ApparentState`], for the shared topocentric
/// altitude and azimuth (CONVENTIONS 13.2).
pub(crate) fn moon_state(m: &MoonPosition) -> ApparentState {
    ApparentState {
        body: MOON.to_string(),
        kind: BodyKind::Moon,
        jd_utc: m.jd_utc,
        ra_deg: m.ra_deg,
        dec_deg: m.dec_deg,
        gha_deg: m.gha_deg,
        distance_km: Some(m.distance_km),
        semidiameter_arcmin: m.semidiameter_arcmin,
        horizontal_parallax_arcmin: m.horizontal_parallax_arcmin,
        magnitude: None,
        phase_angle_deg: None,
        illuminated_fraction: None,
        elongation_deg: None,
        bright_limb_angle_deg: None,
    }
}

fn terminator(g: &MoonGeometry, sub_solar: &Selenographic) -> Terminator {
    // Two unit vectors spanning the terminator's plane, in the selenographic frame:
    // `a` on the equator at the morning terminator (longitude l0 - 90), `b = s x a`
    // heading north from there.
    let s = sub_solar.unit();
    let l0 = sub_solar.lon_deg.to_radians();
    let a = [
        (l0 - std::f64::consts::FRAC_PI_2).cos(),
        (l0 - std::f64::consts::FRAC_PI_2).sin(),
        0.0,
    ];
    let b = [
        s[1] * a[2] - s[2] * a[1],
        s[2] * a[0] - s[0] * a[2],
        s[0] * a[1] - s[1] * a[0],
    ];
    let b = if b[2] < 0.0 { scale(b, -1.0) } else { b };
    let mut points = Vec::with_capacity(72);
    let mut disc = Vec::new();
    for k in 0..72 {
        let t = (k as f64 * 5.0).to_radians();
        let v = [
            a[0] * t.cos() + b[0] * t.sin(),
            a[1] * t.cos() + b[1] * t.sin(),
            a[2] * t.cos() + b[2] * t.sin(),
        ];
        let p = Selenographic::of(v);
        points.push([p.lat_deg, p.lon_deg]);
    }
    // The visible half, from cusp to cusp: sample the circle finely and keep the run
    // that faces the observer, starting where it comes into view.
    let n = 360;
    let pts: Vec<DiscPoint> = (0..n)
        .map(|k| {
            let t = (k as f64).to_radians();
            let v = [
                a[0] * t.cos() + b[0] * t.sin(),
                a[1] * t.cos() + b[1] * t.sin(),
                a[2] * t.cos() + b[2] * t.sin(),
            ];
            g.disc(apply_transpose(&g.frame.matrix, v))
        })
        .collect();
    if let Some(start) = (0..n).find(|&k| pts[k].visible && !pts[(k + n - 1) % n].visible) {
        for j in 0..n {
            let p = &pts[(start + j) % n];
            if !p.visible {
                break;
            }
            disc.push([p.x, p.y]);
        }
    } else if pts.iter().all(|p| p.visible) {
        // Cannot happen for a great circle seen from outside the sphere, but keep the
        // whole circle rather than an arbitrary arc if rounding ever says so.
        disc.extend(pts.iter().map(|p| [p.x, p.y]));
    }
    Terminator {
        pole: *sub_solar,
        morning_lon_deg: norm_180(sub_solar.lon_deg - 90.0),
        evening_lon_deg: norm_180(sub_solar.lon_deg + 90.0),
        points,
        disc,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_a_rotation_and_its_pole_is_near_the_ecliptic_pole() {
        let f = MoonFrame::at(2_461_308.5);
        let m = f.matrix;
        for i in 0..3 {
            for j in 0..3 {
                let d: f64 = (0..3).map(|k| m[i][k] * m[j][k]).sum();
                assert!((d - if i == j { 1.0 } else { 0.0 }).abs() < 1e-14);
            }
        }
        // The lunar pole is 1.5 degrees from the ecliptic pole, which is 23.4 degrees
        // from the celestial pole.
        let pole = f.pole();
        let from_celestial_pole = pole[2].acos().to_degrees();
        assert!(
            (21.8..25.0).contains(&from_celestial_pole),
            "{from_celestial_pole}"
        );
    }

    #[test]
    fn selenographic_round_trips() {
        let f = MoonFrame::at(2_460_000.5);
        for (lat, lon) in [(0.0, 0.0), (45.0, -120.0), (-89.0, 179.0), (12.3, 45.6)] {
            let s = Selenographic {
                lat_deg: lat,
                lon_deg: lon,
            };
            let back = f.selenographic(f.equatorial(&s));
            assert!((back.lat_deg - lat).abs() < 1e-9 && (back.lon_deg - lon).abs() < 1e-9);
        }
    }

    #[test]
    fn physical_libration_is_a_few_hundredths_of_a_degree() {
        for k in 0..400 {
            let a = fundamental_arguments(2_451_545.0 + k as f64 * 9.7);
            let p = physical_libration(&a);
            assert!(p.rho_deg.abs() < 0.07 && p.sigma_deg.abs() < 0.07 && p.tau_deg.abs() < 0.06);
        }
    }
}
