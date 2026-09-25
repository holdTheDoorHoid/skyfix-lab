//! Shared geometry for the planet-detail modules (`discs`, `rings`, `satellites`,
//! `transits`, `conjunctions`, `earth_apsides`, `orbits`).
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.10.
//!
//! - Small `[f64; 3]` vector and matrix helpers.
//! - The frames the chapters of Meeus and the IAU rotation models are written in:
//!   ICRS (the planet provider's equatorial J2000 axes), the mean ecliptic and equinox
//!   of date (IAU 2006 Fukushima-Williams angles) and the true equator and equinox of
//!   date ([`skyfix_ephemeris::frames::bias_precession_nutation_matrix`]).
//! - The IAU WGCCRE 2015 rotation elements of Mercury to Neptune (Archinal et al. 2018,
//!   *Celest. Mech. Dyn. Astron.* 130:22, table 1 and 2; the values NAIF's
//!   `pck00011.tpc` carries), with Jupiter's historical Systems I and II.
//! - The coverage the planet-detail searches run in: whatever the Sun and planet
//!   providers answer for, read from their own `Coverage`, so a provider that grows
//!   (the deep-time tiers) widens every search here without a change.

use skyfix_core::time::{JD_J2000, parse_utc};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::frames::{bias_precession_nutation_matrix, fukushima_williams_2006};
use skyfix_ephemeris::planets::{Planet, PlanetProvider};
use skyfix_ephemeris::sun::SunProvider;

use crate::sky::AlmanacError;

pub(crate) type Vec3 = [f64; 3];
pub(crate) type Mat3 = [[f64; 3]; 3];

/// Speed of light, km/s.
pub(crate) const C_KM_S: f64 = 299_792.458;
/// Speed of light, au per day.
pub(crate) const C_AU_PER_DAY: f64 = skyfix_ephemeris::planets::C_AU_PER_DAY;
/// Radians to arcseconds.
pub(crate) const RAD_TO_ARCSEC: f64 = 206_264.806_247_096_36;

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn scale(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

pub(crate) fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub(crate) fn unit(a: Vec3) -> Vec3 {
    scale(a, 1.0 / norm(a))
}

/// The angle between two vectors, radians, well conditioned at 0 and pi.
pub(crate) fn angle(a: Vec3, b: Vec3) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b))
}

pub(crate) fn mat_vec(m: &Mat3, v: Vec3) -> Vec3 {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

/// `m^T v`: the inverse rotation.
pub(crate) fn mat_t_vec(m: &Mat3, v: Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

/// ERFA's `R1(phi)`: rotation of the frame about the x axis.
pub(crate) fn r1(phi: f64) -> Mat3 {
    let (s, c) = phi.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]]
}

/// ERFA's `R3(psi)`: rotation of the frame about the z axis.
pub(crate) fn r3(psi: f64) -> Mat3 {
    let (s, c) = psi.sin_cos();
    [[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// Unit vector of a right ascension and declination in degrees.
pub(crate) fn radec_unit(ra_deg: f64, dec_deg: f64) -> Vec3 {
    let (sa, ca) = ra_deg.to_radians().sin_cos();
    let (sd, cd) = dec_deg.to_radians().sin_cos();
    [cd * ca, cd * sa, sd]
}

/// Right ascension `[0, 360)` and declination of a vector, degrees.
pub(crate) fn radec_of(v: Vec3) -> (f64, f64) {
    let r = norm(v);
    let ra = v[1].atan2(v[0]).to_degrees().rem_euclid(360.0);
    (ra, (v[2] / r).clamp(-1.0, 1.0).asin().to_degrees())
}

/// The local east and north unit vectors of the sky at direction `u` (any equatorial
/// frame; north is toward that frame's pole). At a pole, east is taken along +y.
pub(crate) fn east_north(u: Vec3) -> (Vec3, Vec3) {
    let u = unit(u);
    let e = [-u[1], u[0], 0.0];
    let n = norm(e);
    let e = if n < 1e-15 {
        [0.0, 1.0, 0.0]
    } else {
        scale(e, 1.0 / n)
    };
    (e, cross(u, e))
}

/// Position angle of direction `v` seen from direction `u` (both from the same
/// observer, the same equatorial frame), degrees `[0, 360)`, from north through east.
pub(crate) fn position_angle_deg(u: Vec3, v: Vec3) -> f64 {
    let (e, n) = east_north(u);
    let d = sub(unit(v), scale(unit(u), dot(unit(v), unit(u))));
    dot(d, e).atan2(dot(d, n)).to_degrees().rem_euclid(360.0)
}

/// Position angle of the sky projection of a direction in space `axis` (say a planet's
/// pole) at the line of sight `u`, degrees `[0, 360)`.
pub(crate) fn axis_position_angle_deg(u: Vec3, axis: Vec3) -> f64 {
    let (e, n) = east_north(u);
    dot(axis, e)
        .atan2(dot(axis, n))
        .to_degrees()
        .rem_euclid(360.0)
}

/// Gnomonic (east, north) coordinates of direction `v` about direction `u`, radians.
pub(crate) fn tangent_plane(u: Vec3, v: Vec3) -> (f64, f64) {
    let (e, n) = east_north(u);
    let (u, v) = (unit(u), unit(v));
    let w = dot(v, u);
    (dot(v, e) / w, dot(v, n) / w)
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/// ICRS to the mean ecliptic and equinox of date (IAU 2006, frame bias included):
/// `R3(-psi_bar) R1(phi_bar) R3(gamma_bar)`, the Fukushima-Williams matrix without its
/// final rotation from the ecliptic to the equator.
pub(crate) fn icrs_to_ecliptic_of_date(jd_tt: f64) -> Mat3 {
    let fw = fukushima_williams_2006(jd_tt);
    mat_mul(
        &r3(-fw.psi_bar_rad),
        &mat_mul(&r1(fw.phi_bar_rad), &r3(fw.gamma_bar_rad)),
    )
}

/// ICRS to the true equator and equinox of date (CONVENTIONS section 7).
pub(crate) fn icrs_to_true_of_date(jd_tt: f64) -> Mat3 {
    bias_precession_nutation_matrix(jd_tt)
}

// ---------------------------------------------------------------------------
// IAU rotation elements
// ---------------------------------------------------------------------------

/// A planet's orientation: its north pole in the ICRF and the prime meridian angle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Orientation {
    pub(crate) pole: Vec3,
    pub(crate) pole_ra_deg: f64,
    pub(crate) pole_dec_deg: f64,
    /// Prime meridian angle `W`, degrees, measured eastward along the planet's equator
    /// from its ascending node on the ICRF equator (IAU convention).
    pub(crate) w_deg: f64,
}

impl Orientation {
    /// Planetocentric latitude and east longitude (degrees) of a direction seen from
    /// the planet's centre.
    pub(crate) fn lat_lon_east_deg(&self, dir: Vec3) -> (f64, f64) {
        let d = unit(dir);
        let (ra0, w) = (self.pole_ra_deg.to_radians(), self.w_deg.to_radians());
        let q = [-ra0.sin(), ra0.cos(), 0.0];
        let pq = cross(self.pole, q);
        let (sw, cw) = w.sin_cos();
        let x = add(scale(q, cw), scale(pq, sw));
        let y = cross(self.pole, x);
        let lat = dot(d, self.pole).clamp(-1.0, 1.0).asin().to_degrees();
        let lon = dot(d, y).atan2(dot(d, x)).to_degrees().rem_euclid(360.0);
        (lat, lon)
    }
}

/// How a longitude is counted on a planet (IAU planetographic convention): west for
/// the direct rotators, so the central meridian increases with time; east for Venus and
/// Uranus, which rotate retrograde.
pub(crate) fn longitude_positive_west(planet: Planet) -> bool {
    !matches!(planet, Planet::Venus | Planet::Uranus)
}

/// Polar radius, km (IAU WGCCRE 2015, the `pck00011.tpc` radii). The equatorial radius
/// is [`Planet::equatorial_radius_km`].
pub(crate) fn polar_radius_km(planet: Planet) -> f64 {
    match planet {
        Planet::Mercury => 2_438.26,
        Planet::Venus => 6_051.8,
        Planet::Mars => 3_376.20,
        Planet::Jupiter => 66_854.0,
        Planet::Saturn => 54_364.0,
        Planet::Uranus => 24_973.0,
        Planet::Neptune => 24_341.0,
    }
}

/// Flattening `1 - c / a`.
pub(crate) fn flattening(planet: Planet) -> f64 {
    1.0 - polar_radius_km(planet) / planet.equatorial_radius_km()
}

/// Jupiter's three rotation systems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::upper_case_acronyms)] // Roman numerals, the systems' names.
pub(crate) enum JupiterSystem {
    /// Equatorial belt, 877.900 deg/day (IAU 1976; the Astronomical Almanac's).
    I,
    /// The rest of the visible disc, 870.270 deg/day (IAU 1976).
    II,
    /// The magnetic field, 870.536 deg/day: the IAU 2015 prime meridian.
    III,
}

fn sin_d(a: f64, rate: f64, t: f64) -> f64 {
    (a + rate * t).to_radians().sin()
}

fn cos_d(a: f64, rate: f64, t: f64) -> f64 {
    (a + rate * t).to_radians().cos()
}

/// IAU WGCCRE 2015 orientation of `planet` at barycentric dynamical time `jd_tdb` (TT
/// is used for it: the difference is under 2 ms). Jupiter's prime meridian is System
/// III; [`jupiter_w_deg`] gives Systems I and II.
pub(crate) fn orientation(planet: Planet, jd_tdb: f64) -> Orientation {
    let d = jd_tdb - JD_J2000;
    let t = d / 36_525.0;
    let (ra, dec, w) = match planet {
        Planet::Mercury => {
            let m = [
                (174.791_085_7, 4.092_335),
                (349.582_171_4, 8.184_670),
                (164.373_257_1, 12.277_005),
                (339.164_342_9, 16.369_340),
                (153.955_428_6, 20.461_675),
            ];
            let k = [
                0.010_672_57,
                -0.001_123_09,
                -0.000_110_40,
                -0.000_025_39,
                -0.000_005_71,
            ];
            let lib: f64 = m.iter().zip(k).map(|(&(a, r), k)| k * sin_d(a, r, d)).sum();
            (
                281.0103 - 0.0328 * t,
                61.4155 - 0.0049 * t,
                329.5988 + 6.138_510_8 * d + lib,
            )
        }
        Planet::Venus => (272.76, 67.16, 160.20 - 1.481_368_8 * d),
        Planet::Mars => (
            317.269_202 - 0.109_275_47 * t
                + 0.000_068 * sin_d(198.991_226, 19_139.481_998_5, t)
                + 0.000_238 * sin_d(226.292_679, 38_280.851_128_1, t)
                + 0.000_052 * sin_d(249.663_391, 57_420.725_159_3, t)
                + 0.000_009 * sin_d(266.183_510, 76_560.636_795_0, t)
                + 0.419_057 * sin_d(79.398_797, 0.504_261_5, t),
            54.432_516 - 0.058_271_05 * t
                + 0.000_051 * cos_d(122.433_576, 19_139.940_747_6, t)
                + 0.000_141 * cos_d(43.058_401, 38_280.875_327_2, t)
                + 0.000_031 * cos_d(57.663_379, 57_420.751_720_5, t)
                + 0.000_005 * cos_d(79.476_401, 76_560.649_500_4, t)
                + 1.591_274 * cos_d(166.325_722, 0.504_261_5, t),
            176.049_863
                + 350.891_982_443_297 * d
                + 0.000_145 * sin_d(129.071_773, 19_140.032_824_4, t)
                + 0.000_157 * sin_d(36.352_167, 38_281.047_359_1, t)
                + 0.000_040 * sin_d(56.668_646, 57_420.929_536_0, t)
                + 0.000_001 * sin_d(67.364_003, 76_560.255_221_5, t)
                + 0.000_001 * sin_d(104.792_680, 95_700.438_757_8, t)
                + 0.584_542 * sin_d(95.391_654, 0.504_261_5, t),
        ),
        Planet::Jupiter => {
            let ja = (99.360_714, 4_850.404_6);
            let jb = (175.895_369, 1_191.960_5);
            let jc = (300.323_162, 262.547_5);
            let jd = (114.012_305, 6_070.247_6);
            let je = (49.511_251, 64.300_0);
            (
                268.056_595 - 0.006_499 * t
                    + 0.000_117 * sin_d(ja.0, ja.1, t)
                    + 0.000_938 * sin_d(jb.0, jb.1, t)
                    + 0.001_432 * sin_d(jc.0, jc.1, t)
                    + 0.000_030 * sin_d(jd.0, jd.1, t)
                    + 0.002_150 * sin_d(je.0, je.1, t),
                64.495_303
                    + 0.002_413 * t
                    + 0.000_050 * cos_d(ja.0, ja.1, t)
                    + 0.000_404 * cos_d(jb.0, jb.1, t)
                    + 0.000_617 * cos_d(jc.0, jc.1, t)
                    - 0.000_013 * cos_d(jd.0, jd.1, t)
                    + 0.000_926 * cos_d(je.0, je.1, t),
                jupiter_w_deg(JupiterSystem::III, jd_tdb),
            )
        }
        Planet::Saturn => (
            40.589 - 0.036 * t,
            83.537 - 0.004 * t,
            38.90 + 810.793_902_4 * d,
        ),
        Planet::Uranus => (257.311, -15.175, 203.81 - 501.160_092_8 * d),
        Planet::Neptune => {
            let n = (357.85 + 52.316 * t).to_radians();
            (
                299.36 + 0.70 * n.sin(),
                43.46 - 0.51 * n.cos(),
                249.978 + 541.139_775_7 * d - 0.48 * n.sin(),
            )
        }
    };
    Orientation {
        pole: radec_unit(ra, dec),
        pole_ra_deg: ra,
        pole_dec_deg: dec,
        w_deg: w.rem_euclid(360.0),
    }
}

/// Jupiter's prime meridian angle in one of its three systems, degrees. System III is
/// the IAU 2015 value; Systems I and II are the IAU 1976 definitions the Astronomical
/// Almanac still tabulates (`W = 67.1 + 877.900 d` and `W = 43.3 + 870.270 d`), both
/// with the same pole.
pub(crate) fn jupiter_w_deg(system: JupiterSystem, jd_tdb: f64) -> f64 {
    let d = jd_tdb - JD_J2000;
    let w = match system {
        JupiterSystem::I => 67.1 + 877.900 * d,
        JupiterSystem::II => 43.3 + 870.270 * d,
        JupiterSystem::III => 284.95 + 870.536_000_0 * d,
    };
    w.rem_euclid(360.0)
}

// ---------------------------------------------------------------------------
// Interpolated vector functions
// ---------------------------------------------------------------------------

/// A 3-vector function of time (Julian days) replaced by Chebyshev series on equal
/// segments, sampled at each segment's Chebyshev nodes. Searches that ask for the same
/// slowly varying positions thousands of times evaluate the provider once per node.
#[derive(Debug, Clone)]
pub(crate) struct VecFit {
    a: f64,
    seg: f64,
    parts: Vec<[crate::eclipses::cheb::Cheb; 3]>,
}

impl VecFit {
    /// Fit `f` on `[a, b]` with segments of at most `seg_days` and `n` nodes each.
    pub(crate) fn new<E>(
        mut f: impl FnMut(f64) -> Result<Vec3, E>,
        a: f64,
        b: f64,
        seg_days: f64,
        n: usize,
    ) -> Result<VecFit, E> {
        use crate::eclipses::cheb::{Cheb, nodes};
        let count = (((b - a) / seg_days).ceil() as usize).max(1);
        let seg = (b - a) / count as f64;
        let mut parts = Vec::with_capacity(count);
        for k in 0..count {
            let (lo, hi) = (a + seg * k as f64, a + seg * (k + 1) as f64);
            let ts = nodes(n, lo, hi);
            let mut vals = [
                Vec::with_capacity(n),
                Vec::with_capacity(n),
                Vec::with_capacity(n),
            ];
            for &t in &ts {
                let v = f(t)?;
                for (i, col) in vals.iter_mut().enumerate() {
                    col.push(v[i]);
                }
            }
            parts.push([
                Cheb::fit(&vals[0], lo, hi),
                Cheb::fit(&vals[1], lo, hi),
                Cheb::fit(&vals[2], lo, hi),
            ]);
        }
        Ok(VecFit { a, seg, parts })
    }

    fn part(&self, t: f64) -> &[crate::eclipses::cheb::Cheb; 3] {
        let k = ((t - self.a) / self.seg).floor();
        let k = (k.max(0.0) as usize).min(self.parts.len() - 1);
        &self.parts[k]
    }

    pub(crate) fn eval(&self, t: f64) -> Vec3 {
        let p = self.part(t);
        [p[0].eval(t), p[1].eval(t), p[2].eval(t)]
    }

    /// First derivative, per day.
    pub(crate) fn rate(&self, t: f64) -> Vec3 {
        let p = self.part(t);
        [p[0].d1(t), p[1].d1(t), p[2].d1(t)]
    }
}

/// The UTC Julian date whose TT is `jd_tt_target` (the inverse of
/// `skyfix_core::time::jd_tt`, whatever TT - UTC model the core uses).
pub(crate) fn jd_utc_from_tt(jd_tt_target: f64) -> f64 {
    let mut x = jd_tt_target - 69.184 / 86_400.0;
    for _ in 0..4 {
        x += jd_tt_target - skyfix_core::time::jd_tt(x);
    }
    x
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

fn parse_bound(s: &str) -> f64 {
    parse_utc(s).unwrap_or(f64::NAN)
}

/// The instants the planet provider answers for, as UTC Julian dates.
pub(crate) fn planet_coverage() -> (f64, f64) {
    let c = PlanetProvider::new().coverage();
    (parse_bound(&c.start_utc), parse_bound(&c.end_utc))
}

/// The instants both the Sun and the planet providers answer for.
pub(crate) fn sun_planet_coverage() -> (f64, f64) {
    let (a, b) = planet_coverage();
    let c = SunProvider::new().coverage();
    (
        a.max(parse_bound(&c.start_utc)),
        b.min(parse_bound(&c.end_utc)),
    )
}

/// Check a search window and clip it to `(lo, hi)`: `(start, end, truncated)`.
pub(crate) fn clip_window(
    what: &str,
    jd_start: f64,
    jd_end: f64,
    lo: f64,
    hi: f64,
    max_days: f64,
) -> Result<(f64, f64, bool), AlmanacError> {
    if !jd_start.is_finite() || !jd_end.is_finite() || jd_end < jd_start {
        return Err(AlmanacError::Invalid(format!(
            "{what} needs a finite window with jd_end >= jd_start (got {jd_start}, {jd_end})"
        )));
    }
    if jd_end - jd_start > max_days {
        return Err(AlmanacError::Invalid(format!(
            "{what}: the window is {:.0} days; at most {max_days:.0} days per call",
            jd_end - jd_start
        )));
    }
    let (a, b) = (jd_start.max(lo), jd_end.min(hi));
    Ok((a, b, a > jd_start || b < jd_end))
}

/// A provider failure as an almanac error naming the body.
pub(crate) fn unavailable(body: &str, e: impl std::fmt::Display) -> AlmanacError {
    AlmanacError::Unavailable {
        body: body.to_string(),
        message: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_rotations_and_agree_at_j2000() {
        let m = icrs_to_ecliptic_of_date(JD_J2000);
        // At J2000 the ecliptic of date is the J2000 ecliptic: the ICRS pole sits at
        // ecliptic latitude 90 - 23.439 degrees.
        let z = mat_vec(&m, [0.0, 0.0, 1.0]);
        assert!(((z[2].asin().to_degrees()) - (90.0 - 23.439_279)).abs() < 1e-4);
        for v in [[1.0, 0.0, 0.0], [0.3, -0.4, 0.866]] {
            let w = mat_t_vec(&m, mat_vec(&m, v));
            assert!(norm(sub(w, v)) < 1e-14);
        }
    }

    #[test]
    fn position_angles_and_tangent_plane() {
        let u = radec_unit(30.0, 10.0);
        let north = radec_unit(30.0, 11.0);
        let east = radec_unit(31.0, 10.0);
        assert!(position_angle_deg(u, north).abs() < 1e-9);
        // The same declination 1 degree east lies a little north of the great circle
        // due east: PA = 90 - 0.087 degrees.
        assert!((position_angle_deg(u, east) - 89.913).abs() < 0.001);
        let (x, y) = tangent_plane(u, north);
        assert!(x.abs() < 1e-12 && (y - 1f64.to_radians().tan()).abs() < 1e-12);
    }

    #[test]
    fn saturns_pole_matches_the_planet_providers() {
        // skyfix_ephemeris::planets uses the same IAU 2015 pole for its magnitudes.
        let o = orientation(Planet::Saturn, JD_J2000);
        let expected = [0.085_478_83, 0.073_235_76, 0.993_644_75];
        assert!(norm(sub(o.pole, expected)) < 1e-7, "{:?}", o.pole);
    }
}
