//! Lunar eclipses: the Moon against the Earth's shadow, seen from the Earth's centre.
//!
//! - **Shadow axis**: the direction opposite the apparent Sun (CONVENTIONS section 7).
//!   The Moon is the apparent geocentric Moon; in the Earth's frame the sunlight that
//!   casts the shadow arrives from the apparent Sun, so the pair is consistent.
//! - **Shadow radii, Danjon's rule** (the convention of NASA's *Five Millennium Canon
//!   of Lunar Eclipses* and the *Connaissance des Temps*): the Earth's radius is
//!   enlarged by about 1/85 for the opaque lower atmosphere, which is the same as
//!   enlarging the Moon's parallax, and 1/594 is taken off for the oblateness at 45
//!   degrees: umbra `Ru = 1.01 pi_M - s_S + pi_S`, penumbra `Rp = 1.01 pi_M + s_S + pi_S`
//!   (`pi` equatorial horizontal parallaxes, `s_S` the Sun's semidiameter). The
//!   *Astronomical Almanac*'s 1/50 enlargement (Chauvenet) gives umbral magnitudes
//!   about 0.006 larger and penumbral ones about 0.026 larger.
//! - **Greatest eclipse**: the Moon's centre passes closest to the shadow axis.
//!   **Gamma**: that distance in Earth equatorial radii, positive when the Moon passes
//!   north of the axis.
//! - **Magnitudes**: fraction of the Moon's diameter inside the umbra or penumbra,
//!   `(R + s_M - theta) / (2 s_M)`, `theta` the angle between the Moon's centre and the
//!   axis. **Contacts**: P1 and P4 when `theta = Rp + s_M`, U1 and U4 when
//!   `theta = Ru + s_M`, U2 and U3 when `theta = Ru - s_M`.

use skyfix_ephemeris::EphemerisError;
use skyfix_ephemeris::frames::unit_vector_from_radec;
use skyfix_ephemeris::moon::{MoonPosition, MoonProvider};
use skyfix_ephemeris::sun::{SunPosition, SunProvider};
use skyfix_ephemeris::topocentric::WGS84_A_KM;

use super::LunarType;
use super::bessel::{K_PENUMBRA, NODES, dot};
use super::cheb::{Cheb, nodes, root, scan_minimum};
use super::solar::T_TOL_H;

/// Danjon's factor on the Moon's parallax: `1 + 1/85 - 1/594`, rounded as published.
pub const DANJON_FACTOR: f64 = 1.01;

const ARCMIN: f64 = std::f64::consts::PI / 10_800.0;

/// `[x, y, distance, Ru, Rp, s_M]` at one instant: the Moon's centre on the plane
/// through it perpendicular to the shadow axis (east, north; Earth radii), its
/// distance (Earth radii) and the three angular radii (radians).
fn lunar_values(sun: &SunPosition, moon: &MoonPosition) -> [f64; 6] {
    let anti = unit_vector_from_radec(sun.ra_deg + 180.0, -sun.dec_deg);
    let (ra, dec) = (
        (sun.ra_deg + 180.0).to_radians(),
        (-sun.dec_deg).to_radians(),
    );
    let east = [-ra.sin(), ra.cos(), 0.0];
    let north = [-dec.sin() * ra.cos(), -dec.sin() * ra.sin(), dec.cos()];
    debug_assert!(dot(anti, east).abs() < 1e-12);
    let m = moon.apparent_km.map(|v| v / WGS84_A_KM);
    let dist = moon.distance_km / WGS84_A_KM;
    let pi_m = moon.horizontal_parallax_arcmin * ARCMIN;
    let s_s = sun.semidiameter_arcmin * ARCMIN;
    let pi_s = sun.horizontal_parallax_arcmin * ARCMIN;
    [
        dot(m, east),
        dot(m, north),
        dist,
        DANJON_FACTOR * pi_m - s_s + pi_s,
        DANJON_FACTOR * pi_m + s_s + pi_s,
        (K_PENUMBRA * pi_m.sin()).asin(),
    ]
}

/// Interpolated lunar-eclipse quantities over a window, hours from `jd_mid`.
#[derive(Debug, Clone)]
pub(crate) struct LunarElements {
    pub jd_mid: f64,
    pub t_lo: f64,
    pub t_hi: f64,
    x: Cheb,
    y: Cheb,
    dist: Cheb,
    ru: Cheb,
    rp: Cheb,
    sm: Cheb,
}

/// The Moon against the shadow at one instant.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LunarState {
    pub x: f64,
    pub y: f64,
    /// Angle between the Moon's centre and the shadow axis, radians.
    pub theta: f64,
    pub ru: f64,
    pub rp: f64,
    pub sm: f64,
}

impl LunarElements {
    pub(crate) fn build(
        sun: &SunProvider,
        moon: &MoonProvider,
        jd_mid: f64,
        t_lo: f64,
        t_hi: f64,
    ) -> Result<LunarElements, EphemerisError> {
        let ts = nodes(NODES, t_lo, t_hi);
        let mut cols: [Vec<f64>; 6] = Default::default();
        for &t in &ts {
            let jd = jd_mid + t / 24.0;
            let v = lunar_values(&sun.position(jd)?, &moon.position(jd)?);
            for (col, x) in cols.iter_mut().zip(v) {
                col.push(x);
            }
        }
        let fit = |v: &Vec<f64>| Cheb::fit(v, t_lo, t_hi);
        Ok(LunarElements {
            jd_mid,
            t_lo,
            t_hi,
            x: fit(&cols[0]),
            y: fit(&cols[1]),
            dist: fit(&cols[2]),
            ru: fit(&cols[3]),
            rp: fit(&cols[4]),
            sm: fit(&cols[5]),
        })
    }

    pub(crate) fn jd(&self, t: f64) -> f64 {
        self.jd_mid + t / 24.0
    }

    pub(crate) fn at(&self, t: f64) -> LunarState {
        let (x, y) = (self.x.eval(t), self.y.eval(t));
        let dist = self.dist.eval(t);
        LunarState {
            x,
            y,
            theta: (x.hypot(y) / dist).clamp(-1.0, 1.0).asin(),
            ru: self.ru.eval(t),
            rp: self.rp.eval(t),
            sm: self.sm.eval(t),
        }
    }
}

/// Global circumstances of a lunar eclipse, hours from the elements' `jd_mid`.
#[derive(Debug, Clone)]
pub(crate) struct LunarGlobal {
    pub t_ge: f64,
    pub gamma: f64,
    pub kind: LunarType,
    pub umbral_magnitude: f64,
    pub penumbral_magnitude: f64,
    pub p1: Option<f64>,
    pub u1: Option<f64>,
    pub u2: Option<f64>,
    pub u3: Option<f64>,
    pub u4: Option<f64>,
    pub p4: Option<f64>,
}

/// Global circumstances, or `None` when the Moon misses the penumbra.
pub(crate) fn lunar_global(el: &LunarElements) -> Option<LunarGlobal> {
    let (lo, hi) = (el.t_lo, el.t_hi);
    let steps = ((hi - lo) * 6.0).ceil().max(12.0) as usize;
    let r2 = |t: f64| {
        let s = el.at(t);
        s.x * s.x + s.y * s.y
    };
    let (t0, _) = scan_minimum(r2, lo, hi, steps, T_TOL_H);
    let h = (hi - lo) / steps as f64;
    let g = |t: f64| {
        let dx = el.x.d1(t);
        let dy = el.y.d1(t);
        el.x.eval(t) * dx + el.y.eval(t) * dy
    };
    let t_ge = root(g, (t0 - h).max(lo), (t0 + h).min(hi), T_TOL_H).unwrap_or(t0);
    if t_ge <= lo + 1e-6 || t_ge >= hi - 1e-6 {
        return None;
    }
    let s = el.at(t_ge);
    let umbral_magnitude = (s.ru + s.sm - s.theta) / (2.0 * s.sm);
    let penumbral_magnitude = (s.rp + s.sm - s.theta) / (2.0 * s.sm);
    if penumbral_magnitude <= 0.0 {
        return None;
    }
    let kind = if umbral_magnitude >= 1.0 {
        LunarType::Total
    } else if umbral_magnitude > 0.0 {
        LunarType::Partial
    } else {
        LunarType::Penumbral
    };
    let pair = |f: &dyn Fn(f64) -> f64| (root(f, lo, t_ge, T_TOL_H), root(f, t_ge, hi, T_TOL_H));
    let (p1, p4) = pair(&|t| {
        let s = el.at(t);
        s.theta - (s.rp + s.sm)
    });
    let (u1, u4) = if umbral_magnitude > 0.0 {
        pair(&|t| {
            let s = el.at(t);
            s.theta - (s.ru + s.sm)
        })
    } else {
        (None, None)
    };
    let (u2, u3) = if umbral_magnitude >= 1.0 {
        pair(&|t| {
            let s = el.at(t);
            s.theta - (s.ru - s.sm)
        })
    } else {
        (None, None)
    };
    Some(LunarGlobal {
        t_ge,
        gamma: s.x.hypot(s.y).copysign(s.y),
        kind,
        umbral_magnitude,
        penumbral_magnitude,
        p1,
        u1,
        u2,
        u3,
        u4,
        p4,
    })
}
