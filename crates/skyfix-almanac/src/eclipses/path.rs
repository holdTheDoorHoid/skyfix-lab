//! Paths of a solar eclipse on the Earth: the central line, the northern and southern
//! limits of the umbra (total) or antumbra (annular), the northern and southern limits
//! of the penumbra (where a partial eclipse is just grazing), and the curves where the
//! partial eclipse begins or ends with the Sun on the horizon.
//!
//! Every curve is traced in time. At each instant:
//!
//! - **central line**: the point of the sea-level ellipsoid on the shadow axis;
//! - **limits**: the envelope of the shadow's edge, the point where the observer sits
//!   on the edge (`D = L`) *and* the edge is not moving across the observer
//!   (`d/dt (D - L) = 0`, so this is the observer's maximum). With the edge written
//!   `(u, v) = L (sin Q, cos Q)` the second condition is
//!   `u' sin Q + v' cos Q = L'`, `(u', v')` the axis velocity relative to the
//!   observer (Explanatory Supplement 1961, section 9.3; Meeus, *Elements of Solar
//!   Eclipses*); it is solved for the observer's height `zeta` above the plane by a
//!   bracketed root (`limit_point`), and where the solution folds back near the horizon
//!   the rest of the line is followed by height instead of time (`fold_extension`), so
//!   the limits end on the horizon where NASA's tables end them. North is the side to
//!   the left of the shadow's motion across the ground (the shadow always moves
//!   eastward on the plane);
//! - **horizon curves**: the points of the Earth's limb (Sun on the geodetic horizon)
//!   on the penumbra's edge.
//!
//! Instants where a curve does not exist (its point would be on the night side) end a
//! segment; the boundary is found by bisection so every curve ends on the horizon.
//! Curves are sampled every two minutes and each interval is halved until its chord is
//! within `MAX_SAGITTA_KM` of the curve and no longer than `MAX_SEGMENT_KM`, then split
//! at the antimeridian (longitude `+-180`, with the crossing point on both sides), so
//! each segment is a valid GeoJSON `LineString` in `[lon, lat]` order.

use serde::{Deserialize, Serialize};

use super::bessel::{
    Elements, Frame, Rates, SolarElements, Vec3, geodetic_of_surface_point, observer_rates,
};
use super::cheb::{minimise, root};
use super::solar::{SolarGlobal, T_TOL_H, central_point, limb_point};

/// A segment is split while it is longer than this...
pub const MAX_SEGMENT_KM: f64 = 150.0;
/// ...or while the curve strays further than this from the straight (great-circle)
/// chord between its ends: under a pixel on a map zoomed to a city.
pub const MAX_SAGITTA_KM: f64 = 0.2;
/// First sampling step along a curve, hours (two minutes).
const STEP_H: f64 = 2.0 / 60.0;
/// Deepest bisection of one step (2^-16 of two minutes is 2 ms).
const MAX_DEPTH: u32 = 16;
const EARTH_KM: f64 = skyfix_ephemeris::topocentric::WGS84_A_KM;

/// A polyline split into GeoJSON-ready segments, with the instant of each vertex.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Polyline {
    /// `[[lon_deg, lat_deg], ...]` per segment (a GeoJSON `MultiLineString`).
    pub segments: Vec<Vec<[f64; 2]>>,
    /// UTC Julian date of each vertex, parallel to `segments`.
    pub jd_utc: Vec<Vec<f64>>,
}

impl Polyline {
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    pub fn vertex_count(&self) -> usize {
        self.segments.iter().map(Vec::len).sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vertex {
    t: f64,
    lat: f64,
    lon: f64,
}

/// Mean Earth radius for the refinement tests (not for any reported number).
const MEAN_EARTH_KM: f64 = 6371.0;

fn unit(v: &Vertex) -> Vec3 {
    let (p, l) = (v.lat.to_radians(), v.lon.to_radians());
    [p.cos() * l.cos(), p.cos() * l.sin(), p.sin()]
}

fn distance_km(a: &Vertex, b: &Vertex) -> f64 {
    let (ua, ub) = (unit(a), unit(b));
    let c = [
        ua[1] * ub[2] - ua[2] * ub[1],
        ua[2] * ub[0] - ua[0] * ub[2],
        ua[0] * ub[1] - ua[1] * ub[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    let d = ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2];
    MEAN_EARTH_KM * s.atan2(d)
}

/// Distance of `m` from the great circle through `a` and `b`, km.
fn cross_track_km(a: &Vertex, b: &Vertex, m: &Vertex) -> f64 {
    let (ua, ub, um) = (unit(a), unit(b), unit(m));
    let n = [
        ua[1] * ub[2] - ua[2] * ub[1],
        ua[2] * ub[0] - ua[0] * ub[2],
        ua[0] * ub[1] - ua[1] * ub[0],
    ];
    let nn = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if nn < 1e-15 {
        return distance_km(a, m);
    }
    let s = (n[0] * um[0] + n[1] * um[1] + n[2] * um[2]) / nn;
    MEAN_EARTH_KM * s.clamp(-1.0, 1.0).asin().abs()
}

/// Trace `f` over `[a, b]` hours: runs of consecutive instants where it exists.
fn trace<F: FnMut(f64) -> Option<(f64, f64)>>(f: F, a: f64, b: f64) -> Vec<Vec<Vertex>> {
    trace_step(f, a, b, STEP_H)
}

/// `trace` with its own first sampling step, for curves that exist only briefly.
fn trace_step<F: FnMut(f64) -> Option<(f64, f64)>>(
    mut f: F,
    a: f64,
    b: f64,
    step: f64,
) -> Vec<Vec<Vertex>> {
    let mut runs: Vec<Vec<Vertex>> = Vec::new();
    if b <= a {
        return runs;
    }
    let n = ((b - a) / step).ceil().max(2.0) as usize;
    let h = (b - a) / n as f64;
    let mut eval = |t: f64| f(t).map(|(lat, lon)| Vertex { t, lat, lon });

    // Last instant in (lo, hi) where the curve exists, lo existing and hi not
    // (or the reverse when `forward` is false).
    fn edge<G: FnMut(f64) -> Option<Vertex>>(
        g: &mut G,
        mut yes: f64,
        mut no: f64,
    ) -> Option<Vertex> {
        let mut best = None;
        for _ in 0..48 {
            let mid = 0.5 * (yes + no);
            match g(mid) {
                Some(v) => {
                    best = Some(v);
                    yes = mid;
                }
                None => no = mid,
            }
            if (yes - no).abs() < 1e-9 {
                break;
            }
        }
        best
    }

    fn refine<G: FnMut(f64) -> Option<Vertex>>(
        g: &mut G,
        a: Vertex,
        b: Vertex,
        depth: u32,
        out: &mut Vec<Vertex>,
    ) {
        if depth >= MAX_DEPTH {
            out.push(b);
            return;
        }
        let mid = 0.5 * (a.t + b.t);
        match g(mid) {
            Some(m) => {
                if distance_km(&a, &b) <= MAX_SEGMENT_KM
                    && cross_track_km(&a, &b, &m) <= MAX_SAGITTA_KM
                {
                    out.push(b);
                } else {
                    refine(g, a, m, depth + 1, out);
                    refine(g, m, b, depth + 1, out);
                }
            }
            None => out.push(b),
        }
    }

    let mut prev = eval(a);
    let mut current: Vec<Vertex> = prev.into_iter().collect();
    for i in 1..=n {
        let t = a + h * i as f64;
        let here = eval(t);
        match (prev, here) {
            (Some(p), Some(q)) => refine(&mut eval, p, q, 0, &mut current),
            (Some(p), None) => {
                if let Some(e) = edge(&mut eval, p.t, t) {
                    refine(&mut eval, p, e, 0, &mut current);
                }
                if current.len() >= 2 {
                    runs.push(std::mem::take(&mut current));
                }
                current.clear();
            }
            (None, Some(q)) => {
                current.clear();
                if let Some(e) = edge(&mut eval, t, t - h) {
                    current.push(e);
                    refine(&mut eval, e, q, 0, &mut current);
                } else {
                    current.push(q);
                }
            }
            (None, None) => {}
        }
        prev = here;
    }
    if current.len() >= 2 {
        runs.push(current);
    }
    runs
}

/// Split runs at the antimeridian and convert to a polyline.
fn to_polyline(runs: Vec<Vec<Vertex>>, jd_of: impl Fn(f64) -> f64) -> Polyline {
    let mut out = Polyline::default();
    for run in runs {
        let mut seg: Vec<[f64; 2]> = Vec::new();
        let mut times: Vec<f64> = Vec::new();
        for (i, v) in run.iter().enumerate() {
            if i > 0 {
                let p = run[i - 1];
                let dl = v.lon - p.lon;
                if dl.abs() > 180.0 {
                    // Crossing: unwrap the second longitude next to the first.
                    let lon2 = if dl > 0.0 {
                        v.lon - 360.0
                    } else {
                        v.lon + 360.0
                    };
                    let edge = if lon2 > p.lon { 180.0 } else { -180.0 };
                    let f = (edge - p.lon) / (lon2 - p.lon);
                    let lat = p.lat + f * (v.lat - p.lat);
                    let t = p.t + f * (v.t - p.t);
                    seg.push([edge, lat]);
                    times.push(jd_of(t));
                    if seg.len() >= 2 {
                        out.segments.push(std::mem::take(&mut seg));
                        out.jd_utc.push(std::mem::take(&mut times));
                    }
                    seg.clear();
                    times.clear();
                    seg.push([-edge, lat]);
                    times.push(jd_of(t));
                }
            }
            seg.push([v.lon, v.lat]);
            times.push(jd_of(v.t));
        }
        if seg.len() >= 2 {
            out.segments.push(seg);
            out.jd_utc.push(times);
        }
    }
    out
}

/// Which shadow cone a limit belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cone {
    Penumbra,
    Umbra,
}

fn cone_radius(e: &Elements, r: &Rates, cone: Cone, zeta: f64, zeta_dot: f64) -> (f64, f64) {
    match cone {
        Cone::Penumbra => {
            let l = e.l1 - zeta * e.tan_f1;
            (l, r.l1 - zeta_dot * e.tan_f1)
        }
        Cone::Umbra => {
            let l = e.l2 - zeta * e.tan_f2;
            let s = if l < 0.0 { -1.0 } else { 1.0 };
            (l.abs(), s * (r.l2 - zeta_dot * e.tan_f2))
        }
    }
}

/// For an observer assumed at height `zeta` above the plane: the point `(xi, eta)` of
/// the shadow's edge where the envelope condition holds, iterated from `start` to
/// consistency with the observer velocity it implies (a strong contraction: the
/// velocity depends on `(xi, eta)` only through the Earth's rotation).
fn edge_point(
    e: &Elements,
    r: &Rates,
    cone: Cone,
    north: bool,
    zeta: f64,
    start: (f64, f64),
) -> Option<(f64, f64)> {
    let (mut xi, mut eta) = start;
    for _ in 0..50 {
        let q = [xi, eta, zeta];
        let qd = observer_rates(q, e, r);
        let (l, l_dot) = cone_radius(e, r, cone, zeta, qd[2]);
        let (a, b) = (r.x - qd[0], r.y - qd[1]);
        let n = a.hypot(b);
        if n < 1e-12 {
            return None;
        }
        let s = (l_dot / n).clamp(-1.0, 1.0).asin();
        let psi = b.atan2(a);
        let mut chosen = None;
        for qq in [s - psi, std::f64::consts::PI - s - psi] {
            // Offset of the observer from the axis against the left of the motion.
            let (ox, oy) = (-qq.sin(), -qq.cos());
            if ((ox * -b + oy * a) > 0.0) == north {
                chosen = Some(qq);
            }
        }
        let qq = chosen?;
        let (nx, ny) = (e.x - l * qq.sin(), e.y - l * qq.cos());
        let change = (nx - xi).abs() + (ny - eta).abs();
        xi = nx;
        eta = ny;
        if change < 1e-11 {
            break;
        }
    }
    Some((xi, eta))
}

/// The height residual of a limit at `t` for a trial height `zeta`: the surface
/// height of the edge point minus `zeta` (continued outward, negative, off the disc),
/// with the surface point when there is one.
fn limit_residual(
    el: &SolarElements,
    t: f64,
    cone: Cone,
    north: bool,
    zeta: f64,
) -> (f64, Option<Vec3>) {
    let e = el.at(t);
    let r = el.rates(t);
    let f = Frame::new(e.d, e.mu);
    match edge_point(&e, &r, cone, north, zeta, (e.x, e.y)) {
        None => (f64::NAN, None),
        Some((xi, eta)) => match f.surface_point(xi, eta) {
            Some((p, z, _)) => (z - zeta, Some(p)),
            None => (
                -zeta - (xi.hypot(eta / Frame::outline_rho1(e.d)) - 1.0),
                None,
            ),
        },
    }
}

/// The northern (`north = true`) or southern limit of `cone` at `t` hours: the
/// Earth-fixed point and its height `zeta` above the plane, or `None` when there is
/// none on the day side.
///
/// The unknown is the observer's height `zeta`: for each trial height `edge_point`
/// gives the edge point, the Earth's surface gives that point's actual height, and
/// the two must agree. Away from the horizon that residual falls with `zeta` at a slope
/// close to -1, so the estimate from `zeta = 0` is bracketed tightly and solved by
/// Brent. Near the horizon it can rise, then fall: the edge point moves with the trial
/// height (for the penumbra by some 70 km per 0.04 of it), so it can start off the disc
/// and come onto it. There the residual is scanned down from `zeta = 1` and the
/// *upper* root taken, which continues the limit from higher in the sky; the lower
/// root belongs to the branch `fold_extension` follows to the horizon. (A plain
/// fixed-point iteration on all three coordinates diverges near the horizon, where the
/// surface height changes infinitely fast across the Earth's limb.)
pub(crate) fn limit_point(
    el: &SolarElements,
    t: f64,
    cone: Cone,
    north: bool,
) -> Option<(Vec3, f64)> {
    limit_point_near(el, t, cone, north, None)
}

/// `limit_point` warm-started from the height `hint` found at a nearby instant: when
/// the residual changes sign within 0.015 of it (non-negative below, non-positive
/// above), the root there is the upper one and no scan is needed.
fn limit_point_near(
    el: &SolarElements,
    t: f64,
    cone: Cone,
    north: bool,
    hint: Option<f64>,
) -> Option<(Vec3, f64)> {
    let e = el.at(t);
    let r = el.rates(t);
    let f = Frame::new(e.d, e.mu);
    let rho1 = Frame::outline_rho1(e.d);
    let mut start = (e.x, e.y);
    let mut residual = |zeta: f64| -> f64 {
        match edge_point(&e, &r, cone, north, zeta, start) {
            None => f64::NAN,
            Some((xi, eta)) => {
                start = (xi, eta);
                match f.surface_point(xi, eta) {
                    Some((_, z, _)) => z - zeta,
                    // Off the disc: continue the residual outward.
                    None => -zeta - (xi.hypot(eta / rho1) - 1.0),
                }
            }
        }
    };
    let top = 1.0 + 1e-9;
    if let Some(h) = hint {
        let (a, b) = ((h - 0.015).max(0.0), (h + 0.015).min(top));
        if residual(a) >= 0.0
            && residual(b) <= 0.0
            && let Some(zeta) = root(&mut residual, a, b, 1e-11)
            && let Some((xi, eta)) = edge_point(&e, &r, cone, north, zeta, (e.x, e.y))
        {
            return Some(match f.surface_point(xi, eta) {
                Some((p, z, _)) => (p, z),
                None => limb_point(&f, xi, eta),
            });
        }
    }
    let g0 = residual(0.0);
    // Far off the disc no height can help: the edge point moves by at most about
    // 0.5 Earth radii over the whole range of heights (`L * dQ/dzeta`, with `L` at most
    // 0.56 and `dQ/dzeta` the Earth's rotation over the shadow's relative speed).
    if g0.is_nan() || g0 <= -0.6 {
        return None;
    }
    let mut zeta = None;
    if g0 >= 0.0 {
        let guess = g0.min(1.0);
        let (a, b) = ((guess - 0.02).max(0.0), (guess + 0.02).min(top));
        if residual(a) >= 0.0 && residual(b) <= 0.0 {
            zeta = root(&mut residual, a, b, 1e-11);
        }
    }
    if zeta.is_none() {
        // Down from the top to the first height where the residual is not negative. A
        // band narrower than the spacing only occurs right at a fold, where
        // `fold_extension` takes over.
        const LEVELS: [f64; 26] = [
            1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.29, 0.24, 0.2, 0.165, 0.135, 0.11, 0.09,
            0.073, 0.059, 0.047, 0.037, 0.029, 0.022, 0.016, 0.011, 0.007, 0.0035, 0.0,
        ];
        let mut above = top;
        for &z in &LEVELS[1..] {
            let g = residual(z);
            if g >= 0.0 {
                zeta = root(&mut residual, z, above, 1e-11);
                break;
            }
            above = z;
        }
    }
    let zeta = zeta?;
    let (xi, eta) = edge_point(&e, &r, cone, north, zeta, start)?;
    match f.surface_point(xi, eta) {
        Some((p, z, _)) => Some((p, z)),
        None => Some(limb_point(&f, xi, eta)),
    }
}

/// Close the gap between a limit's last solvable instant and the horizon.
///
/// Near the horizon the time of the grazing maximum folds back: followed in time, the
/// limit's point stops at a height `zeta_f > 0` (the Sun a fraction of a degree up for
/// the umbra, several degrees for the penumbra) and a second branch runs from there to
/// the horizon while the time retreats (70 ms for the southern umbral limit of
/// 2024-04-08, tens of seconds for a penumbral limit). That branch is parametrised by
/// height instead: for heights from `zeta_f` down to 0, the instant nearest the fold,
/// on the side where the run exists (`into_run` is +1 after the fold, -1 before it),
/// where the residual turns positive. Returned from the fold toward the horizon.
fn fold_extension(
    el: &SolarElements,
    cone: Cone,
    north: bool,
    fold: &Vertex,
    zeta_f: f64,
    into_run: f64,
) -> Vec<Vertex> {
    let mut out = Vec::new();
    if zeta_f < 1e-6 {
        return out;
    }
    let steps = 32;
    for k in 1..=steps {
        let zeta = zeta_f * (1.0 - f64::from(k) / f64::from(steps));
        let g = |t: f64| limit_residual(el, t, cone, north, zeta).0;
        // Step away from the fold, doubling, until the residual turns non-negative.
        let (mut prev, mut dt) = (fold.t, 0.5 / 3600.0);
        let mut bracket = None;
        while dt < 0.5 {
            let t = fold.t + into_run * dt;
            if t < el.t_lo || t > el.t_hi {
                break;
            }
            if g(t) >= 0.0 {
                bracket = Some((prev, t));
                break;
            }
            prev = t;
            dt *= 2.0;
        }
        let Some((a, b)) = bracket else { continue };
        let Some(t) = root(g, a.min(b), a.max(b), 1e-9) else {
            continue;
        };
        let e = el.at(t);
        let f = Frame::new(e.d, e.mu);
        let p = match limit_residual(el, t, cone, north, zeta).1 {
            Some(p) => p,
            None => {
                let r = el.rates(t);
                let Some((xi, eta)) = edge_point(&e, &r, cone, north, zeta, (e.x, e.y)) else {
                    continue;
                };
                limb_point(&f, xi, eta).0
            }
        };
        let (lat, lon) = geodetic_of_surface_point(p);
        out.push(Vertex { t, lat, lon });
    }
    out
}

fn surface_latlon(p: Vec3) -> (f64, f64) {
    geodetic_of_surface_point(p)
}

/// The central line.
pub(crate) fn central_line(el: &SolarElements, g: &SolarGlobal) -> Polyline {
    let Some((a, b)) = g.central_interval else {
        return Polyline::default();
    };
    let pad = 2.0 * STEP_H;
    let runs = trace(
        |t| central_point(el, t).map(|(p, _, _)| surface_latlon(p)),
        (a - pad).max(el.t_lo),
        (b + pad).min(el.t_hi),
    );
    to_polyline(runs, |t| el.jd(t))
}

/// A limit line of `cone`.
pub(crate) fn limit_line(el: &SolarElements, g: &SolarGlobal, cone: Cone, north: bool) -> Polyline {
    let (a, b) = match cone {
        Cone::Penumbra => (g.p1, g.p4),
        Cone::Umbra => (g.u1, g.u4),
    };
    let (Some(a), Some(b)) = (a, b) else {
        return Polyline::default();
    };
    let pad = 2.0 * STEP_H;
    // The trace visits neighbouring instants in turn: start each from the last height.
    // The penumbral limits are smooth and long: sampled every four minutes before the
    // refinement, not two.
    let hint = std::cell::Cell::new(None);
    let step = match cone {
        Cone::Penumbra => 2.0 * STEP_H,
        Cone::Umbra => STEP_H,
    };
    let runs = trace_step(
        |t| {
            let found = limit_point_near(el, t, cone, north, hint.get());
            hint.set(found.map(|(_, z)| z));
            found.map(|(p, _)| surface_latlon(p))
        },
        (a - pad).max(el.t_lo),
        (b + pad).min(el.t_hi),
        step,
    );
    // Carry each end that stops short of the horizon on to it.
    let zeta_at = |v: &Vertex| limit_point(el, v.t, cone, north).map_or(0.0, |(_, z)| z);
    let runs = runs
        .into_iter()
        .map(|run| {
            let (first, last) = (run[0], run[run.len() - 1]);
            let mut head = fold_extension(el, cone, north, &first, zeta_at(&first), 1.0);
            head.reverse();
            let tail = fold_extension(el, cone, north, &last, zeta_at(&last), -1.0);
            head.into_iter().chain(run).chain(tail).collect()
        })
        .collect();
    to_polyline(runs, |t| el.jd(t))
}

/// Points of the Earth's limb on the edge of `cone` at `t`: 0 or 2 outline angles.
///
/// The outline is within 0.34 % of a unit circle, so the circle-circle intersection
/// (law of cosines) places each root to a few thousandths of a radian; each is then
/// bracketed around that estimate and solved exactly.
fn horizon_angles(el: &SolarElements, t: f64, cone: Cone) -> Vec<f64> {
    let e = el.at(t);
    let rho1 = Frame::outline_rho1(e.d);
    let f = Frame::new(e.d, e.mu);
    let radius = |zeta: f64| match cone {
        Cone::Penumbra => e.l1 - zeta * e.tan_f1,
        Cone::Umbra => (e.l2 - zeta * e.tan_f2).abs(),
    };
    let h = |th: f64| {
        let (s, c) = th.sin_cos();
        let (xi, eta) = (c, rho1 * s);
        let (_, zeta) = limb_point(&f, xi, eta);
        (xi - e.x).hypot(eta - e.y) - radius(zeta)
    };
    let l = radius(0.0);
    let r = e.x.hypot(e.y / rho1);
    let cos_a = (r * r + 1.0 - l * l) / (2.0 * r);
    if !(-1.02..=1.02).contains(&cos_a) {
        return Vec::new();
    }
    let phi = (e.y / rho1).atan2(e.x);
    let alpha = cos_a.clamp(-1.0, 1.0).acos();
    let mut out: Vec<f64> = Vec::new();
    // Close roots (a small umbra, or near tangency) share one window scanned finely
    // enough to separate them.
    let windows: Vec<(f64, f64, u32)> = if alpha < 0.2 {
        vec![(phi, 2.0 * alpha + 0.01, 80)]
    } else {
        vec![(phi + alpha, 0.05, 10), (phi - alpha, 0.05, 10)]
    };
    for (centre, w, n) in windows {
        let step = 2.0 * w / f64::from(n);
        let mut a = centre - w;
        let mut ha = h(a);
        for i in 1..=n {
            let b = centre - w + step * f64::from(i);
            let hb = h(b);
            if ha * hb < 0.0
                && let Some(root) = root(h, a, b, 1e-12)
                && out.iter().all(|o| (o - root).abs() > 1e-9)
            {
                out.push(root);
            }
            a = b;
            ha = hb;
        }
    }
    out
}

/// The curves where the eclipse of `cone` begins or ends with the Sun on the horizon.
/// Each interval of time during which the cone's edge crosses the limb gives one
/// closed loop: the two crossing points traced forward, joined head to tail. For the
/// penumbra these bound, with the penumbral limits, the region that sees any eclipse;
/// for the umbra they close the path of totality or annularity at sunrise and sunset.
pub(crate) fn horizon_curves(el: &SolarElements, g: &SolarGlobal, cone: Cone) -> Polyline {
    let (a, b) = match cone {
        Cone::Penumbra => (g.p1, g.p4),
        Cone::Umbra => (g.u1, g.u4),
    };
    let (Some(a), Some(b)) = (a, b) else {
        return Polyline::default();
    };
    let point_of = |t: f64, th: f64| {
        let e = el.at(t);
        let rho1 = Frame::outline_rho1(e.d);
        let f = Frame::new(e.d, e.mu);
        let (p, _) = limb_point(&f, th.cos(), rho1 * th.sin());
        let (lat, lon) = surface_latlon(p);
        Vertex { t, lat, lon }
    };
    // Both branches are traced over the same instants: solve each instant once.
    let cache: std::cell::RefCell<std::collections::HashMap<u64, Vec<f64>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    let angles_at = |t: f64| -> Vec<f64> {
        cache
            .borrow_mut()
            .entry(t.to_bits())
            .or_insert_with(|| horizon_angles(el, t, cone))
            .clone()
    };
    // The two branches, told apart by their angle from the axis direction (in the
    // outline's own parametrisation): the larger is "left".
    let branch = |t: f64, left: bool| -> Option<(f64, f64)> {
        let e = el.at(t);
        let rho1 = Frame::outline_rho1(e.d);
        let axis = (e.y / rho1).atan2(e.x);
        let angles = angles_at(t);
        if angles.len() != 2 {
            return None;
        }
        let rel = |th: f64| {
            (th - axis + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU)
                - std::f64::consts::PI
        };
        let (a0, a1) = (angles[0], angles[1]);
        let (hi, lo) = if rel(a0) >= rel(a1) {
            (a0, a1)
        } else {
            (a1, a0)
        };
        let v = point_of(t, if left { hi } else { lo });
        Some((v.lat, v.lon))
    };
    // The penumbra straddles the limb for tens of minutes at a time (sampled every four
    // minutes before refinement); the umbra only for a minute or two just after it
    // first touches the Earth and just before it leaves, so those two windows are
    // sampled every ten seconds.
    let windows: Vec<(f64, f64, f64)> = match cone {
        Cone::Penumbra => {
            let pad = 2.0 * STEP_H;
            vec![((a - pad).max(el.t_lo), (b + pad).min(el.t_hi), 2.0 * STEP_H)]
        }
        Cone::Umbra => {
            let (w, step) = (10.0 / 60.0, 10.0 / 3600.0);
            if b - a > 2.0 * w {
                vec![
                    ((a - step).max(el.t_lo), a + w, step),
                    (b - w, (b + step).min(el.t_hi), step),
                ]
            } else {
                vec![((a - step).max(el.t_lo), (b + step).min(el.t_hi), step)]
            }
        }
    };
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for &(lo, hi, step) in &windows {
        left.extend(trace_step(|t| branch(t, true), lo, hi, step));
        right.extend(trace_step(|t| branch(t, false), lo, hi, step));
    }
    // Pair each left run with the right run covering the same interval and close the
    // loop through the instants where the two branches meet.
    let mut runs = Vec::new();
    for l in left {
        let (t0, t1) = (l[0].t, l[l.len() - 1].t);
        let partner = right
            .iter()
            .filter(|r| r[0].t < t1 && r[r.len() - 1].t > t0)
            .max_by(|x, y| x.len().cmp(&y.len()));
        let mut run = l.clone();
        if let Some(r) = partner {
            run.extend(r.iter().rev().copied());
            run.push(l[0]);
        }
        runs.push(run);
    }
    to_polyline(runs, |t| el.jd(t))
}

/// Width of the umbral path at `t` hours, km: the distances from the central-line
/// point to the nearest points of the two limit lines.
pub(crate) fn path_width_km(el: &SolarElements, t: f64) -> Option<f64> {
    let (c, _, _) = central_point(el, t)?;
    let mut total = 0.0;
    for north in [true, false] {
        let dist = |s: f64| {
            limit_point(el, s, Cone::Umbra, north)
                .map(|(p, _)| {
                    let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
                    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() * EARTH_KM
                })
                .unwrap_or(f64::INFINITY)
        };
        let span = 0.25;
        let (_, d) = minimise(
            dist,
            (t - span).max(el.t_lo),
            (t + span).min(el.t_hi),
            T_TOL_H,
        );
        if !d.is_finite() {
            return None;
        }
        total += d;
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antimeridian_split_puts_the_crossing_on_both_sides() {
        let run = vec![
            Vertex {
                t: 0.0,
                lat: 10.0,
                lon: 170.0,
            },
            Vertex {
                t: 1.0,
                lat: 12.0,
                lon: -170.0,
            },
            Vertex {
                t: 2.0,
                lat: 14.0,
                lon: -160.0,
            },
        ];
        let p = to_polyline(vec![run], |t| t);
        assert_eq!(p.segments.len(), 2);
        assert_eq!(p.segments[0].last().unwrap()[0], 180.0);
        assert_eq!(p.segments[1][0][0], -180.0);
        assert!((p.segments[0].last().unwrap()[1] - 11.0).abs() < 1e-12);
        assert!((p.jd_utc[1][0] - 0.5).abs() < 1e-12);
        assert_eq!(p.vertex_count(), 5);
    }
}
