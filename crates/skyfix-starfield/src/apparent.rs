//! Apparent geocentric places of date for every catalogue star at once.
//!
//! CONVENTIONS section 7 frame (true equator and equinox of date), computed by exactly
//! the chain `skyfix_ephemeris::frames::apparent_radec_of_date` applies to the
//! navigational stars, in the same order and with the same formulas:
//!
//! 1. proper motion from J2000 along the tangent-plane space motion (no radial
//!    velocity), renormalised;
//! 2. frame bias + IAU 2006 precession + IAU 2000B nutation (one matrix per call);
//! 3. annual parallax from a Keplerian Earth position;
//! 4. gravitational light deflection by the Sun;
//! 5. relativistic annual aberration from the Keplerian Earth velocity.
//!
//! Everything that depends only on the date (the matrix, the Earth's state, the
//! deflection and aberration constants) is computed once per call; everything that
//! depends only on the star (its J2000 unit vector and proper-motion vector) once per
//! process. The per-star loop is then a few dozen multiply-adds, two or three square
//! roots and two `atan2`: the ephemeris function renormalises after every step, which
//! changes no direction, so the loop renormalises only where a later step would feel
//! the length (after proper motion and after parallax). `tests/apparent_matches_ephemeris.rs` holds it to the
//! ephemeris crate's one-star function to 1e-5" for every star, so the star field and
//! `sky_state` can never drift apart.

use skyfix_core::time::{JD_J2000, jd_tt};
use skyfix_core::units::ARCSEC;
use skyfix_ephemeris::frames::{bias_precession_nutation_matrix, earth_state_of_date};

use crate::{Catalog, StarfieldError, check_jd_utc, starfield};

/// One milliarcsecond in radians.
const MAS: f64 = ARCSEC / 1000.0;
/// Julian year, days: proper motions are per Julian year.
const JULIAN_YEAR_DAYS: f64 = 365.25;
/// Schwarzschild radius of the Sun in astronomical units, `2 GM_sun / c^2 / AU`, with
/// the same constants as `skyfix_ephemeris::frames` (IAU 2009 GM_sun, exact c, IAU 2012
/// au).
const SOLAR_SCHWARZSCHILD_RADIUS_AU: f64 =
    2.0 * 1.327_124_400_41e20 / (299_792_458.0 * 299_792_458.0) / 1.495_978_707e11;

/// Per-star constants: J2000 unit vector, proper-motion vector (radians per Julian
/// year) and parallax (radians), seven numbers per star.
pub(crate) struct Motion {
    per_star: Vec<[f64; 7]>,
}

impl Motion {
    pub(crate) fn new(c: &Catalog) -> Self {
        let per_star = (0..c.len())
            .map(|i| {
                let (sa, ca) = c.ra_j2000_deg[i].to_radians().sin_cos();
                let (sd, cd) = c.dec_j2000_deg[i].to_radians().sin_cos();
                let mu_ra = c.pm_ra_cosdec_mas_yr[i] * MAS;
                let mu_dec = c.pm_dec_mas_yr[i] * MAS;
                // Unit vectors of increasing RA and increasing Dec at the star.
                let e_ra = [-sa, ca, 0.0];
                let e_dec = [-sd * ca, -sd * sa, cd];
                [
                    cd * ca,
                    cd * sa,
                    sd,
                    mu_ra * e_ra[0] + mu_dec * e_dec[0],
                    mu_ra * e_ra[1] + mu_dec * e_dec[1],
                    mu_ra * e_ra[2] + mu_dec * e_dec[2],
                    c.parallax_mas[i] * MAS,
                ]
            })
            .collect();
        Motion { per_star }
    }
}

type Mat3 = [[f64; 3]; 3];

#[inline]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = dot(v, v).sqrt();
    if n == 0.0 {
        v
    } else {
        let k = 1.0 / n;
        [v[0] * k, v[1] * k, v[2] * k]
    }
}

#[inline]
fn apply(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Rotation from ICRS to the true equator and equinox of date (frame bias, IAU 2006
/// precession, IAU 2000B nutation), row-major: `v_of_date = M v_icrs`.
///
/// This is the rotation part of an apparent place. The browser can use it to carry the
/// J2000 constellation boundaries and label positions into the frame of
/// [`apparent_radec_all`]; it leaves out annual aberration (at most 20.5"), which is a
/// displacement of each star's light, not a rotation of the sky.
pub fn frame_matrix(jd_utc: f64) -> Result<Mat3, StarfieldError> {
    check_jd_utc(jd_utc)?;
    Ok(bias_precession_nutation_matrix(jd_tt(jd_utc)))
}

/// Apparent right ascension and declination of date of every catalogue star, radians,
/// `[ra_0, dec_0, ra_1, dec_1, ...]` in catalogue (HR) order. RA is `[0, 2 pi)`.
pub fn apparent_radec_all(jd_utc: f64) -> Result<Vec<f64>, StarfieldError> {
    let mut out = Vec::new();
    apparent_radec_all_into(jd_utc, &mut out)?;
    Ok(out)
}

/// [`apparent_radec_all`] into a caller-owned buffer (cleared first), so a render loop
/// can reuse one allocation.
pub fn apparent_radec_all_into(jd_utc: f64, out: &mut Vec<f64>) -> Result<(), StarfieldError> {
    check_jd_utc(jd_utc)?;
    let sf = starfield()?;
    let jd_tt = jd_tt(jd_utc);
    let years = (jd_tt - JD_J2000) / JULIAN_YEAR_DAYS;
    let m = bias_precession_nutation_matrix(jd_tt);
    let earth = earth_state_of_date(jd_tt);

    // Light deflection: the Sun-to-observer direction and its scale.
    let pos = earth.pos_au;
    let em = dot(pos, pos).sqrt();
    let e = [pos[0] / em, pos[1] / em, pos[2] / em];
    let deflection_scale = SOLAR_SCHWARZSCHILD_RADIUS_AU / em;
    // Aberration: the Earth's velocity in units of c.
    let v = earth.vel_c;
    let bm1 = (1.0 - dot(v, v)).sqrt();
    let inv_one_plus_bm1 = 1.0 / (1.0 + bm1);

    out.clear();
    out.reserve(2 * sf.motion.per_star.len());
    for s in &sf.motion.per_star {
        // 1. Proper motion from J2000, renormalised (the length grows by up to 2e-6
        //    over 1990-2060 for the fastest star, which aberration would feel).
        let p = normalize([
            s[0] + years * s[3],
            s[1] + years * s[4],
            s[2] + years * s[5],
        ]);
        // 2. Bias, precession, nutation.
        let mut q = apply(&m, p);
        // 3. Annual parallax, renormalised (the shift is up to 3.6e-6 of the length,
        //    which aberration below would otherwise feel at the 1e-4" level).
        if s[6] != 0.0 {
            q = normalize([
                q[0] - s[6] * pos[0],
                q[1] - s[6] * pos[1],
                q[2] - s[6] * pos[2],
            ]);
        }
        // 4. Solar light deflection (source at infinity; capped behind the Sun's disc
        //    exactly as frames::apply_solar_light_deflection is). The result is unit
        //    length to 1e-10, so it is not renormalised either.
        let pde = dot(q, e);
        let w = deflection_scale / (1.0 + pde).max(1.0e-6);
        q = [
            q[0] + w * (e[0] - pde * q[0]),
            q[1] + w * (e[1] - pde * q[1]),
            q[2] + w * (e[2] - pde * q[2]),
        ];
        // 5. Annual aberration (relativistic vector form).
        let w1 = 1.0 + dot(q, v) * inv_one_plus_bm1;
        q = [
            q[0] * bm1 + w1 * v[0],
            q[1] * bm1 + w1 * v[1],
            q[2] * bm1 + w1 * v[2],
        ];
        // Angles straight from the (not quite unit) vector.
        let mut ra = q[1].atan2(q[0]);
        if ra < 0.0 {
            ra += std::f64::consts::TAU;
        }
        out.push(ra);
        out.push(q[2].atan2((q[0] * q[0] + q[1] * q[1]).sqrt()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schwarzschild_radius_is_the_published_value() {
        assert!((SOLAR_SCHWARZSCHILD_RADIUS_AU - 1.974_125_7e-8).abs() < 1e-15);
    }

    #[test]
    fn bad_times_are_refused() {
        assert_eq!(
            apparent_radec_all(f64::NAN),
            Err(StarfieldError::NotFinite("jd_utc"))
        );
        assert!(matches!(
            apparent_radec_all(2_000_000.0),
            Err(StarfieldError::OutOfRange { .. })
        ));
        assert!(frame_matrix(f64::INFINITY).is_err());
    }

    #[test]
    fn output_has_two_numbers_per_star_in_range() {
        let v = apparent_radec_all(2_461_308.0).unwrap();
        assert_eq!(v.len(), 2 * crate::catalog().unwrap().len());
        for pair in v.chunks(2) {
            assert!((0.0..std::f64::consts::TAU).contains(&pair[0]));
            assert!(pair[1].abs() <= std::f64::consts::FRAC_PI_2);
        }
    }
}
