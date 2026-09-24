//! Bracketed root finding and one-dimensional minimisation (Brent 1973).
//!
//! Both work on a caller-chosen abscissa. The event finder passes *days since the
//! window start*, never raw Julian dates: near JD 2.46e6 an `f64` resolves only 40
//! microseconds, and tolerances relative to `|x|` would be meaningless there.

/// A root of `f` in `[a, b]`, given `fa = f(a)` and `fb = f(b)` of opposite signs (or
/// one of them zero), to within `tol` in `x`.
///
/// Brent's method: inverse quadratic interpolation and secant steps with a bisection
/// safeguard, so it never leaves the bracket and never takes more than a bisection's
/// number of steps plus a few.
pub(crate) fn brent_root(
    mut f: impl FnMut(f64) -> f64,
    a: f64,
    b: f64,
    fa: f64,
    fb: f64,
    tol: f64,
) -> f64 {
    if fa == 0.0 {
        return a;
    }
    if fb == 0.0 {
        return b;
    }
    let (mut a, mut b, mut fa, mut fb) = (a, b, fa, fb);
    let (mut c, mut fc) = (a, fa);
    let mut d = b - a;
    let mut e = d;
    for _ in 0..200 {
        if (fb > 0.0) == (fc > 0.0) {
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
            return b;
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
    }
    b
}

/// The minimum of `f` on `[a, b]`, to within `tol` in `x`: `(x_min, f(x_min))`.
///
/// Brent's `localmin`: golden-section search accelerated by parabolic interpolation.
/// For a maximum, minimise `-f`.
pub(crate) fn brent_min(mut f: impl FnMut(f64) -> f64, a: f64, b: f64, tol: f64) -> (f64, f64) {
    // (3 - sqrt 5) / 2, the golden-section fraction.
    const GOLD: f64 = 0.381_966_011_250_105_1;
    let (mut a, mut b) = if a <= b { (a, b) } else { (b, a) };
    let mut x = a + GOLD * (b - a);
    let (mut w, mut v) = (x, x);
    let mut fx = f(x);
    let (mut fw, mut fv) = (fx, fx);
    let (mut d, mut e) = (0.0f64, 0.0f64);
    for _ in 0..200 {
        let m = 0.5 * (a + b);
        let tol1 = tol / 3.0 + f64::EPSILON * x.abs();
        let tol2 = 2.0 * tol1;
        if (x - m).abs() <= tol2 - 0.5 * (b - a) {
            break;
        }
        let mut golden = true;
        if e.abs() > tol1 {
            let mut r = (x - w) * (fx - fv);
            let mut q = (x - v) * (fx - fw);
            let mut p = (x - v) * q - (x - w) * r;
            q = 2.0 * (q - r);
            if q > 0.0 {
                p = -p;
            } else {
                q = -q;
            }
            r = e;
            e = d;
            if p.abs() < (0.5 * q * r).abs() && p > q * (a - x) && p < q * (b - x) {
                d = p / q;
                let u = x + d;
                if u - a < tol2 || b - u < tol2 {
                    d = if x < m { tol1 } else { -tol1 };
                }
                golden = false;
            }
        }
        if golden {
            e = if x < m { b - x } else { a - x };
            d = GOLD * e;
        }
        let u = if d.abs() >= tol1 {
            x + d
        } else if d > 0.0 {
            x + tol1
        } else {
            x - tol1
        };
        let fu = f(u);
        if fu <= fx {
            if u < x {
                b = x;
            } else {
                a = x;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_of_a_smooth_function_to_tolerance() {
        let f = |x: f64| x.cos() - x;
        let r = brent_root(f, 0.0, 1.0, f(0.0), f(1.0), 1e-12);
        assert!((r - 0.739_085_133_215_160_6).abs() < 1e-11, "{r}");
    }

    #[test]
    fn root_with_an_endpoint_on_zero_returns_that_endpoint() {
        let f = |x: f64| x - 2.0;
        assert_eq!(brent_root(f, 2.0, 3.0, 0.0, 1.0, 1e-9), 2.0);
        assert_eq!(brent_root(f, 1.0, 2.0, -1.0, 0.0, 1e-9), 2.0);
    }

    #[test]
    fn root_of_a_nearly_flat_function_stays_in_the_bracket() {
        let f = |x: f64| (x - 0.3).powi(3) * 1e-9;
        let r = brent_root(f, 0.0, 1.0, f(0.0), f(1.0), 1e-9);
        assert!((0.0..=1.0).contains(&r));
        assert!((r - 0.3).abs() < 1e-3, "{r}");
    }

    #[test]
    fn root_counts_its_evaluations() {
        let mut n = 0;
        let f = |x: f64| {
            n += 1;
            (x * 3.0).sin() - 0.2
        };
        let _ = brent_root(f, 0.0, 0.5, -0.2, (1.5f64).sin() - 0.2, 1e-10);
        assert!(n < 20, "{n} evaluations");
    }

    #[test]
    fn minimum_of_a_parabola_and_of_a_cosine() {
        let (x, fx) = brent_min(|x| (x - 0.25).powi(2) + 3.0, 0.0, 1.0, 1e-9);
        assert!(
            (x - 0.25).abs() < 1e-7 && (fx - 3.0).abs() < 1e-12,
            "{x} {fx}"
        );
        let (x, _) = brent_min(|x: f64| x.cos(), 2.0, 4.5, 1e-9);
        assert!((x - std::f64::consts::PI).abs() < 1e-7, "{x}");
    }

    #[test]
    fn minimum_at_an_end_of_the_interval_is_found_at_that_end() {
        let (x, _) = brent_min(|x| x, 0.0, 1.0, 1e-9);
        assert!(x < 1e-8, "{x}");
    }
}
