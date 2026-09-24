//! Global circumstances of a solar eclipse from its Besselian elements: greatest
//! eclipse, gamma, magnitude, type, and when the penumbra and the umbra first and last
//! touch the Earth.
//!
//! Definitions follow NASA's *Five Millennium Canon of Solar Eclipses* (Espenak &
//! Meeus 2006) so the results can be checked against it:
//!
//! - **Greatest eclipse** is the instant the shadow axis passes closest to the Earth's
//!   centre, the minimum of `x^2 + y^2`. **Gamma** is that distance in Earth
//!   equatorial radii, signed like `y` (positive when the axis passes north).
//! - **Central** eclipses are those whose axis meets the (WGS84) Earth: the axis point
//!   `(x, y)` enters the Earth's outline on the fundamental plane, the ellipse
//!   `xi^2 + eta^2 / rho1^2 = 1`, `rho1 = sqrt(1 - e^2 cos^2 d)`.
//! - **Type**: along the central line the umbral radius `L2 = l2 - zeta tan f2` is
//!   negative where the eclipse is total and positive where it is annular; mixed
//!   signs make it hybrid. A non-central eclipse is total or annular when the umbra
//!   (radius `|L2|` at the Earth's limb) still reaches the outline, and partial
//!   otherwise.
//! - **Magnitude** at greatest eclipse: for central eclipses the ratio of the
//!   apparent diameters of the Moon and the Sun at the point of greatest eclipse,
//!   `(L1 - L2) / (L1 + L2)`; otherwise the fraction of the Sun's diameter covered at
//!   the point of the Earth's limb nearest the axis, `(L1 - D) / (L1 + L2)`.

use super::SolarType;
use super::bessel::{Elements, Frame, SolarElements, Vec3, geodetic_of_surface_point};
use super::cheb::{root, scan_minimum};

/// Time tolerance for every instant, hours (0.36 ms).
pub(crate) const T_TOL_H: f64 = 1e-7;

/// Signed distance from `(x, y)` to the Earth's outline `xi^2 + eta^2/rho1^2 = 1`
/// on the fundamental plane (negative inside) and the nearest point of the outline.
pub(crate) fn outline_distance(x: f64, y: f64, rho1: f64) -> (f64, [f64; 2]) {
    // Newton for the foot of the normal, from the direction of the point; the outline
    // is within 0.34 % of a circle, so this start is already close.
    let mut th = (y / rho1).atan2(x);
    for _ in 0..12 {
        let (s, c) = th.sin_cos();
        let (rx, ry) = (c - x, rho1 * s - y);
        let (dx, dy) = (-s, rho1 * c);
        let f = rx * dx + ry * dy;
        let fp = dx * dx + dy * dy + rx * (-c) + ry * (-rho1 * s);
        if fp.abs() < 1e-300 {
            break;
        }
        let step = f / fp;
        th -= step;
        if step.abs() < 1e-15 {
            break;
        }
    }
    let (s, c) = th.sin_cos();
    let e = [c, rho1 * s];
    let dist = (x - e[0]).hypot(y - e[1]);
    let inside = x * x + (y / rho1).powi(2) < 1.0;
    (if inside { -dist } else { dist }, e)
}

/// The Earth-fixed point of the limb (Sun on the geodetic horizon) whose projection
/// is the outline point `(xi, eta)`, and its `zeta`.
pub(crate) fn limb_point(f: &Frame, xi: f64, eta: f64) -> (Vec3, f64) {
    match f.surface_point(xi, eta) {
        Some((p, zeta, _)) => (p, zeta),
        None => {
            // Rounding put the point a hair outside; take the double root.
            let a = [
                xi * f.x[0] + eta * f.y[0],
                xi * f.x[1] + eta * f.y[1],
                xi * f.x[2] + eta * f.y[2],
            ];
            let ib2 = 1.0 / (super::bessel::B_OVER_A * super::bessel::B_OVER_A);
            let mdot = |u: Vec3, v: Vec3| u[0] * v[0] + u[1] * v[1] + u[2] * v[2] * ib2;
            let zeta = -mdot(a, f.z) / mdot(f.z, f.z);
            (
                [
                    a[0] + zeta * f.z[0],
                    a[1] + zeta * f.z[1],
                    a[2] + zeta * f.z[2],
                ],
                zeta,
            )
        }
    }
}

/// Where the shadow meets the Earth's limb at one instant.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LimbState {
    /// Signed distance of the axis from the outline (negative inside).
    pub signed_distance: f64,
    /// Earth-fixed position of the outline point nearest the axis.
    pub point: Vec3,
    /// Penumbral and (absolute) umbral radius at that limb point.
    pub l1: f64,
    pub l2: f64,
}

pub(crate) fn limb_state(el: &SolarElements, t: f64) -> LimbState {
    let e = el.at(t);
    let rho1 = Frame::outline_rho1(e.d);
    let (sd, op) = outline_distance(e.x, e.y, rho1);
    let f = Frame::new(e.d, e.mu);
    let (p, zeta) = limb_point(&f, op[0], op[1]);
    LimbState {
        signed_distance: sd,
        point: p,
        l1: e.l1 - zeta * e.tan_f1,
        l2: e.l2 - zeta * e.tan_f2,
    }
}

/// The point of the central line at `t` (the axis meets the Earth), with `zeta`.
pub(crate) fn central_point(el: &SolarElements, t: f64) -> Option<(Vec3, f64, Elements)> {
    let e = el.at(t);
    let f = Frame::new(e.d, e.mu);
    f.surface_point(e.x, e.y).map(|(p, zeta, _)| (p, zeta, e))
}

/// Global circumstances, times in hours from the elements' `jd_mid`.
#[derive(Debug, Clone)]
pub(crate) struct SolarGlobal {
    pub t_ge: f64,
    pub gamma: f64,
    pub central: bool,
    pub kind: SolarType,
    pub magnitude: f64,
    /// Earth-fixed point of greatest eclipse (on the central line, or the limb point
    /// nearest the axis) and its geodetic latitude and longitude, degrees.
    pub ge_point: Vec3,
    pub ge_lat_deg: f64,
    pub ge_lon_deg: f64,
    /// Penumbra first and last touches the Earth.
    pub p1: Option<f64>,
    pub p4: Option<f64>,
    /// Umbra (or antumbra) first and last touches the Earth.
    pub u1: Option<f64>,
    pub u4: Option<f64>,
    /// When the axis is on the Earth.
    pub central_interval: Option<(f64, f64)>,
}

/// Global circumstances, or `None` when the penumbra misses the Earth.
pub(crate) fn solar_global(el: &SolarElements) -> Option<SolarGlobal> {
    let (lo, hi) = (el.t_lo, el.t_hi);
    let steps = ((hi - lo) * 6.0).ceil().max(12.0) as usize;

    // Greatest eclipse: minimum of x^2 + y^2, refined as the root of x x' + y y'.
    let r2 = |t: f64| {
        let e = el.at(t);
        e.x * e.x + e.y * e.y
    };
    let (t0, _) = scan_minimum(r2, lo, hi, steps, T_TOL_H);
    let h = (hi - lo) / steps as f64;
    let g = |t: f64| {
        let e = el.at(t);
        let r = el.rates(t);
        e.x * r.x + e.y * r.y
    };
    let t_ge = root(g, (t0 - h).max(lo), (t0 + h).min(hi), T_TOL_H).unwrap_or(t0);
    if t_ge <= lo + 1e-6 || t_ge >= hi - 1e-6 {
        return None;
    }
    let ge = el.at(t_ge);
    let gamma = ge.x.hypot(ge.y).copysign(ge.y);

    // Does the penumbra reach the Earth at all?
    let pen = |t: f64| {
        let s = limb_state(el, t);
        s.signed_distance - s.l1
    };
    let (_, pen_min) = scan_minimum(pen, lo, hi, steps, T_TOL_H);
    if pen_min >= 0.0 {
        return None;
    }

    // Central: the axis enters the outline.
    let q = |t: f64| {
        let e = el.at(t);
        let rho1 = Frame::outline_rho1(e.d);
        e.x * e.x + (e.y / rho1).powi(2) - 1.0
    };
    let (tq, qmin) = scan_minimum(q, lo, hi, steps, T_TOL_H);
    let central_interval = if qmin < 0.0 {
        let a = root(q, lo, tq, T_TOL_H);
        let b = root(q, tq, hi, T_TOL_H);
        match (a, b) {
            (Some(a), Some(b)) => Some((a, b)),
            _ => None,
        }
    } else {
        None
    };
    let central = central_interval.is_some();

    // The umbra at the limb: does it touch the Earth?
    let umb = |t: f64| {
        let s = limb_state(el, t);
        s.signed_distance - s.l2.abs()
    };
    let (_, umb_min) = scan_minimum(umb, lo, hi, steps, T_TOL_H);
    let umbra_touches = central || umb_min < 0.0;

    // Type.
    let kind = if let Some((a, b)) = central_interval {
        let (mut lmin, mut lmax) = (f64::INFINITY, f64::NEG_INFINITY);
        let n = 400;
        for i in 0..=n {
            let t = a + (b - a) * f64::from(i) / f64::from(n);
            let l2 = match central_point(el, t) {
                Some((_, zeta, e)) => e.l2 - zeta * e.tan_f2,
                None => limb_state(el, t).l2,
            };
            lmin = lmin.min(l2);
            lmax = lmax.max(l2);
        }
        if lmax < 0.0 {
            SolarType::Total
        } else if lmin > 0.0 {
            SolarType::Annular
        } else {
            SolarType::Hybrid
        }
    } else if umbra_touches {
        if limb_state(el, t_ge).l2 < 0.0 {
            SolarType::Total
        } else {
            SolarType::Annular
        }
    } else {
        SolarType::Partial
    };

    // Point of greatest eclipse and magnitude.
    let (ge_point, magnitude) = match central_point(el, t_ge) {
        Some((p, zeta, e)) => {
            let l1 = e.l1 - zeta * e.tan_f1;
            let l2 = e.l2 - zeta * e.tan_f2;
            (p, (l1 - l2) / (l1 + l2))
        }
        None => {
            let s = limb_state(el, t_ge);
            let dist = s.signed_distance.max(0.0);
            (s.point, (s.l1 - dist) / (s.l1 + s.l2))
        }
    };
    let (ge_lat_deg, ge_lon_deg) = geodetic_of_surface_point(ge_point);

    // Global contacts.
    let p1 = root(pen, lo, t_ge, T_TOL_H);
    let p4 = root(pen, t_ge, hi, T_TOL_H);
    let (u1, u4) = if umbra_touches {
        (root(umb, lo, t_ge, T_TOL_H), root(umb, t_ge, hi, T_TOL_H))
    } else {
        (None, None)
    };

    Some(SolarGlobal {
        t_ge,
        gamma,
        central,
        kind,
        magnitude,
        ge_point,
        ge_lat_deg,
        ge_lon_deg,
        p1,
        p4,
        u1,
        u4,
        central_interval,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outline_distance_of_simple_points() {
        let (d, p) = outline_distance(2.0, 0.0, 0.9966);
        assert!((d - 1.0).abs() < 1e-12 && (p[0] - 1.0).abs() < 1e-12);
        let (d, p) = outline_distance(0.0, -1.5, 0.9966);
        assert!((d - (1.5 - 0.9966)).abs() < 1e-12 && (p[1] + 0.9966).abs() < 1e-12);
        let (d, _) = outline_distance(0.1, 0.2, 0.9966);
        assert!(d < 0.0);
        // A point off an axis: the offset to the foot is normal to the ellipse.
        let (x, y, rho1) = (1.2, 0.9, 0.99);
        let (_, p) = outline_distance(x, y, rho1);
        let th = (p[1] / rho1).atan2(p[0]);
        let tangent = [-th.sin(), rho1 * th.cos()];
        let off = [x - p[0], y - p[1]];
        assert!((off[0] * tangent[0] + off[1] * tangent[1]).abs() < 1e-12);
    }
}
