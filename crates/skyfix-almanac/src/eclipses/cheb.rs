//! Chebyshev interpolation of a smooth function of time, and the one-dimensional
//! minimiser and root finder the eclipse code runs on it.
//!
//! An eclipse needs the Sun and the Moon at every instant of a window of a few hours,
//! thousands of times (contacts, paths, limits). The ephemeris costs about 65 µs per
//! Sun-and-Moon pair, so each eclipse samples it once at the Chebyshev nodes of its
//! window and everything after that evaluates the interpolant, which costs nanoseconds.
//! Interpolating at Chebyshev nodes (rather than fitting a low-degree polynomial by
//! least squares, as the printed Besselian elements do) converges geometrically for
//! functions as smooth as these; `bessel.rs` measures the residual against the
//! ephemeris itself.

use std::f64::consts::PI;

/// A Chebyshev series on `[a, b]`, with its first derivative.
#[derive(Debug, Clone)]
pub(crate) struct Cheb {
    a: f64,
    b: f64,
    c: Vec<f64>,
    dc: Vec<f64>,
}

/// The `n` Chebyshev nodes of the first kind on `[a, b]`, in increasing order.
pub(crate) fn nodes(n: usize, a: f64, b: f64) -> Vec<f64> {
    let (mid, half) = (0.5 * (a + b), 0.5 * (b - a));
    (0..n)
        .rev()
        .map(|j| mid + half * (PI * (j as f64 + 0.5) / n as f64).cos())
        .collect()
}

/// Coefficients of the derivative series (with respect to the normalised variable).
fn derivative(c: &[f64]) -> Vec<f64> {
    let n = c.len();
    let mut d = vec![0.0; n];
    if n < 2 {
        return d;
    }
    d[n - 2] = 2.0 * (n - 1) as f64 * c[n - 1];
    for k in (1..n - 1).rev() {
        let next = if k + 1 < n { d[k + 1] } else { 0.0 };
        d[k - 1] = next + 2.0 * k as f64 * c[k];
    }
    d
}

/// Clenshaw summation of `sum' c_k T_k(tau)` (first term halved).
fn clenshaw(c: &[f64], tau: f64) -> f64 {
    let (mut b1, mut b2) = (0.0, 0.0);
    for &ck in c.iter().skip(1).rev() {
        let b0 = 2.0 * tau * b1 - b2 + ck;
        b2 = b1;
        b1 = b0;
    }
    tau * b1 - b2 + 0.5 * c[0]
}

impl Cheb {
    /// Interpolate `values`, taken at `nodes(values.len(), a, b)`.
    pub(crate) fn fit(values: &[f64], a: f64, b: f64) -> Cheb {
        let n = values.len();
        // `nodes` returns increasing times, i.e. j = n-1 .. 0 of the textbook ordering.
        let c: Vec<f64> = (0..n)
            .map(|k| {
                let s: f64 = values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let j = n - 1 - i;
                        v * (PI * k as f64 * (j as f64 + 0.5) / n as f64).cos()
                    })
                    .sum();
                2.0 * s / n as f64
            })
            .collect();
        let dc = derivative(&c);
        Cheb { a, b, c, dc }
    }

    fn tau(&self, t: f64) -> f64 {
        (2.0 * t - self.a - self.b) / (self.b - self.a)
    }

    fn scale(&self) -> f64 {
        2.0 / (self.b - self.a)
    }

    pub(crate) fn eval(&self, t: f64) -> f64 {
        clenshaw(&self.c, self.tau(t))
    }

    /// First derivative with respect to `t`.
    pub(crate) fn d1(&self, t: f64) -> f64 {
        clenshaw(&self.dc, self.tau(t)) * self.scale()
    }
}

/// Brent's root finder on `[a, b]` where `f(a)` and `f(b)` differ in sign. Returns
/// `None` when they do not. `tol` is the tolerance on the argument.
pub(crate) fn root<F: FnMut(f64) -> f64>(mut f: F, a: f64, b: f64, tol: f64) -> Option<f64> {
    let (mut a, mut b) = (a, b);
    let (mut fa, mut fb) = (f(a), f(b));
    if !fa.is_finite() || !fb.is_finite() || fa * fb > 0.0 {
        return None;
    }
    if fa == 0.0 {
        return Some(a);
    }
    if fb == 0.0 {
        return Some(b);
    }
    let (mut c, mut fc) = (a, fa);
    let mut d = b - a;
    let mut e = d;
    for _ in 0..200 {
        if fb * fc > 0.0 {
            c = a;
            fc = fa;
            d = b - a;
            e = d;
        }
        if fc.abs() < fb.abs() {
            a = b;
            b = c;
            c = a;
            fa = fb;
            fb = fc;
            fc = fa;
        }
        let tol1 = 2.0 * f64::EPSILON * b.abs() + 0.5 * tol;
        let xm = 0.5 * (c - b);
        if xm.abs() <= tol1 || fb == 0.0 {
            return Some(b);
        }
        if e.abs() >= tol1 && fa.abs() > fb.abs() {
            let s = fb / fa;
            let (mut p, mut q);
            if a == c {
                p = 2.0 * xm * s;
                q = 1.0 - s;
            } else {
                let qq = fa / fc;
                let r = fb / fc;
                p = s * (2.0 * xm * qq * (qq - r) - (b - a) * (r - 1.0));
                q = (qq - 1.0) * (r - 1.0) * (s - 1.0);
            }
            if p > 0.0 {
                q = -q;
            }
            p = p.abs();
            let min1 = 3.0 * xm * q - (tol1 * q).abs();
            let min2 = (e * q).abs();
            if 2.0 * p < min1.min(min2) {
                e = d;
                d = p / q;
            } else {
                d = xm;
                e = d;
            }
        } else {
            d = xm;
            e = d;
        }
        a = b;
        fa = fb;
        b += if d.abs() > tol1 { d } else { tol1.copysign(xm) };
        fb = f(b);
        if !fb.is_finite() {
            return None;
        }
    }
    Some(b)
}

/// Brent's minimiser of `f` on `[a, b]`. Returns `(t, f(t))`. `f` should be unimodal on
/// the interval; callers bracket the minimum with a coarse scan first.
pub(crate) fn minimise<F: FnMut(f64) -> f64>(mut f: F, a: f64, b: f64, tol: f64) -> (f64, f64) {
    const GOLD: f64 = 0.381_966_011_250_105_1;
    let (mut a, mut b) = (a.min(b), a.max(b));
    let mut x = a + GOLD * (b - a);
    let (mut w, mut v) = (x, x);
    let mut fx = f(x);
    let (mut fw, mut fv) = (fx, fx);
    let (mut d, mut e) = (0.0f64, 0.0f64);
    for _ in 0..200 {
        let xm = 0.5 * (a + b);
        let tol1 = tol + 1e-12 * x.abs();
        let tol2 = 2.0 * tol1;
        if (x - xm).abs() <= tol2 - 0.5 * (b - a) {
            break;
        }
        let mut golden = true;
        if e.abs() > tol1 {
            let r = (x - w) * (fx - fv);
            let mut q = (x - v) * (fx - fw);
            let mut p = (x - v) * q - (x - w) * r;
            q = 2.0 * (q - r);
            if q > 0.0 {
                p = -p;
            }
            q = q.abs();
            let etemp = e;
            e = d;
            if !(p.abs() >= (0.5 * q * etemp).abs() || p <= q * (a - x) || p >= q * (b - x)) {
                d = p / q;
                let u = x + d;
                if u - a < tol2 || b - u < tol2 {
                    d = tol1.copysign(xm - x);
                }
                golden = false;
            }
        }
        if golden {
            e = if x >= xm { a - x } else { b - x };
            d = GOLD * e;
        }
        let u = if d.abs() >= tol1 {
            x + d
        } else {
            x + tol1.copysign(d)
        };
        let fu = f(u);
        if fu <= fx {
            if u >= x {
                a = x;
            } else {
                b = x;
            }
            v = w;
            fv = fw;
            w = x;
            fw = fx;
            x = u;
            fx = fu;
        } else {
            if u < x {
                a = u;
            } else {
                b = u;
            }
            if fu <= fw || w == x {
                v = w;
                fv = fw;
                w = u;
                fw = fu;
            } else if fu <= fv || v == x || v == w {
                v = u;
                fv = fu;
            }
        }
    }
    (x, fx)
}

/// Minimum of `f` over `[a, b]`: a scan at `steps` points to bracket it, then Brent.
pub(crate) fn scan_minimum<F: FnMut(f64) -> f64>(
    mut f: F,
    a: f64,
    b: f64,
    steps: usize,
    tol: f64,
) -> (f64, f64) {
    let h = (b - a) / steps as f64;
    let mut best = (a, f(a));
    for i in 1..=steps {
        let t = a + h * i as f64;
        let v = f(t);
        if v < best.1 {
            best = (t, v);
        }
    }
    let lo = (best.0 - h).max(a);
    let hi = (best.0 + h).min(b);
    let refined = minimise(&mut f, lo, hi, tol);
    if refined.1 <= best.1 { refined } else { best }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_a_smooth_function_and_its_derivative() {
        let f = |t: f64| (0.3 * t).sin() + 0.01 * t * t;
        let (a, b) = (-5.0, 5.0);
        let ts = nodes(13, a, b);
        assert!(ts.windows(2).all(|w| w[0] < w[1]));
        let vals: Vec<f64> = ts.iter().map(|&t| f(t)).collect();
        let c = Cheb::fit(&vals, a, b);
        for i in 0..=100 {
            let t = a + (b - a) * i as f64 / 100.0;
            assert!((c.eval(t) - f(t)).abs() < 1e-11, "{t}");
            let d1 = 0.3 * (0.3 * t).cos() + 0.02 * t;
            assert!((c.d1(t) - d1).abs() < 1e-9, "{t}");
        }
    }

    #[test]
    fn root_and_minimum() {
        let r = root(|t| t * t - 2.0, 0.0, 2.0, 1e-13).unwrap();
        assert!((r - 2f64.sqrt()).abs() < 1e-12);
        assert!(root(|t| t * t + 1.0, -1.0, 1.0, 1e-9).is_none());
        let (t, v) = scan_minimum(|t| (t - 0.7).powi(2) + 3.0, -4.0, 4.0, 16, 1e-10);
        assert!((t - 0.7).abs() < 1e-6 && (v - 3.0).abs() < 1e-12, "{t} {v}");
    }
}
