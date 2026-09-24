//! Small dense linear algebra for the position solver (CONVENTIONS sections 8-9).
//!
//! OWNER: core-solver agent. Deliberately tiny and dependency-free: a 2-3 parameter
//! navigation fix needs symmetric solves and inverses up to 4x4, the eigen-decomposition
//! of a symmetric matrix, and the singular values of a tall Jacobian. Matrices are
//! row-major `Vec<Vec<f64>>` (or fixed `[[f64; 2]; 2]` where the size is known); at these
//! sizes clarity is worth more than a packed layout.
//!
//! Singular values are obtained as `sqrt(eig(J^T J))`. Forming the Gram matrix squares
//! the condition number, so a Jacobian conditioned at `1e6` (the ellipse cut-off in
//! section 9) produces a Gram matrix conditioned at `1e12` — still four orders of
//! magnitude inside `f64` precision, which is why this cheap route is acceptable here.

use std::cmp::Ordering;

/// `J^T J` for a tall matrix `j` (rows = observations, columns = unknowns).
pub fn gram(j: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let n = j.first().map(|r| r.len()).unwrap_or(0);
    let mut g = vec![vec![0.0; n]; n];
    for row in j {
        if row.len() != n {
            continue;
        }
        for i in 0..n {
            for k in 0..n {
                g[i][k] += row[i] * row[k];
            }
        }
    }
    g
}

/// Lower-triangular Cholesky factor `L` with `A = L L^T`.
/// `None` when `a` is not square or not numerically positive definite.
#[allow(clippy::needless_range_loop)]
pub fn cholesky(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    if n == 0 || a.iter().any(|r| r.len() != n) {
        return None;
    }
    let mut l = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let mut s = a[i][j];
            for k in 0..j {
                s -= l[i][k] * l[j][k];
            }
            if i == j {
                if !s.is_finite() || s <= 0.0 {
                    return None;
                }
                l[i][i] = s.sqrt();
            } else {
                if l[j][j] == 0.0 {
                    return None;
                }
                l[i][j] = s / l[j][j];
            }
        }
    }
    if l.iter().flatten().any(|x| !x.is_finite()) {
        return None;
    }
    Some(l)
}

/// Solve `A x = b` for a symmetric positive-definite `A`. `None` when `A` is not PD.
#[allow(clippy::needless_range_loop)]
pub fn solve_sym_pd(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let l = cholesky(a)?;
    let n = l.len();
    if b.len() != n {
        return None;
    }
    // Forward substitution: L y = b.
    let mut y = vec![0.0f64; n];
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= l[i][k] * y[k];
        }
        y[i] = s / l[i][i];
    }
    // Back substitution: L^T x = y.
    let mut x = vec![0.0f64; n];
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in (i + 1)..n {
            s -= l[k][i] * x[k];
        }
        x[i] = s / l[i][i];
    }
    if x.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some(x)
}

/// Inverse of a symmetric positive-definite matrix. `None` when `A` is not PD.
#[allow(clippy::needless_range_loop)]
pub fn invert_sym_pd(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut inv = vec![vec![0.0f64; n]; n];
    for c in 0..n {
        let mut e = vec![0.0f64; n];
        e[c] = 1.0;
        let col = solve_sym_pd(a, &e)?;
        for r in 0..n {
            inv[r][c] = col[r];
        }
    }
    // Symmetrise: the column-wise solve leaves O(eps) asymmetry.
    for r in 0..n {
        for c in (r + 1)..n {
            let m = 0.5 * (inv[r][c] + inv[c][r]);
            inv[r][c] = m;
            inv[c][r] = m;
        }
    }
    Some(inv)
}

/// Closed-form eigen-decomposition of a symmetric 2x2 matrix.
///
/// Returns `(values, vectors)` with the eigenvalues in descending order and the matching
/// unit eigenvectors as the **columns** of `vectors` (`vectors[row][column]`). The
/// rotation angle is `0.5 * atan2(2 b, a - c)`, which stays well conditioned when the
/// matrix is nearly a multiple of the identity (where the axes are arbitrary anyway).
pub fn eigen_sym2(m: [[f64; 2]; 2]) -> ([f64; 2], [[f64; 2]; 2]) {
    let a = m[0][0];
    let b = 0.5 * (m[0][1] + m[1][0]);
    let c = m[1][1];
    let theta = 0.5 * (2.0 * b).atan2(a - c);
    let (s, co) = theta.sin_cos();
    let l1 = a * co * co + 2.0 * b * co * s + c * s * s;
    let l2 = a + c - l1;
    ([l1, l2], [[co, -s], [s, co]])
}

/// Eigen-decomposition of a symmetric `n x n` matrix by cyclic Jacobi rotations.
///
/// Returns `(values, vectors)` with eigenvalues in descending order and unit eigenvectors
/// as the columns of `vectors`. Non-square input yields empty vectors.
#[allow(clippy::needless_range_loop)]
pub fn jacobi_eigen_sym(a_in: &[Vec<f64>]) -> (Vec<f64>, Vec<Vec<f64>>) {
    let n = a_in.len();
    if n == 0 || a_in.iter().any(|r| r.len() != n) {
        return (Vec::new(), Vec::new());
    }
    if n == 1 {
        return (vec![a_in[0][0]], vec![vec![1.0]]);
    }
    let mut a: Vec<Vec<f64>> = a_in.to_vec();
    // Symmetrise the input so a slightly asymmetric Gram matrix cannot stall the sweep.
    for r in 0..n {
        for c in (r + 1)..n {
            let m = 0.5 * (a[r][c] + a[c][r]);
            a[r][c] = m;
            a[c][r] = m;
        }
    }
    let mut v: Vec<Vec<f64>> = (0..n)
        .map(|i| (0..n).map(|j| if i == j { 1.0 } else { 0.0 }).collect())
        .collect();
    let scale = a
        .iter()
        .flatten()
        .map(|x| x * x)
        .sum::<f64>()
        .sqrt()
        .max(f64::MIN_POSITIVE);

    for _sweep in 0..60 {
        let mut off = 0.0;
        for p in 0..n {
            for q in (p + 1)..n {
                off += a[p][q] * a[p][q];
            }
        }
        if off.sqrt() <= 1e-18 * scale {
            break;
        }
        for p in 0..(n - 1) {
            for q in (p + 1)..n {
                let apq = a[p][q];
                if apq == 0.0 || !apq.is_finite() {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * apq);
                let t = if theta >= 0.0 {
                    1.0 / (theta + (theta * theta + 1.0).sqrt())
                } else {
                    -1.0 / (-theta + (theta * theta + 1.0).sqrt())
                };
                let cs = 1.0 / (t * t + 1.0).sqrt();
                let sn = t * cs;
                // A <- J^T A J, V <- V J, with J = [[c, s], [-s, c]] on rows/cols (p, q).
                for k in 0..n {
                    let kp = a[k][p];
                    let kq = a[k][q];
                    a[k][p] = cs * kp - sn * kq;
                    a[k][q] = sn * kp + cs * kq;
                }
                for k in 0..n {
                    let pk = a[p][k];
                    let qk = a[q][k];
                    a[p][k] = cs * pk - sn * qk;
                    a[q][k] = sn * pk + cs * qk;
                }
                for k in 0..n {
                    let kp = v[k][p];
                    let kq = v[k][q];
                    v[k][p] = cs * kp - sn * kq;
                    v[k][q] = sn * kp + cs * kq;
                }
            }
        }
    }

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| a[j][j].partial_cmp(&a[i][i]).unwrap_or(Ordering::Equal));
    let values: Vec<f64> = order.iter().map(|&i| a[i][i]).collect();
    let vectors: Vec<Vec<f64>> = (0..n)
        .map(|r| order.iter().map(|&c| v[r][c]).collect())
        .collect();
    (values, vectors)
}

/// Singular values of a tall matrix, descending, as `sqrt(eig(J^T J))`.
/// Negative eigenvalues produced by rounding are clamped to zero.
pub fn singular_values(j: &[Vec<f64>]) -> Vec<f64> {
    let g = gram(j);
    if g.is_empty() {
        return Vec::new();
    }
    let (values, _) = jacobi_eigen_sym(&g);
    values.into_iter().map(|v| v.max(0.0).sqrt()).collect()
}
