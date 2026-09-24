//! Minimal 3-vector and 3x3-matrix helpers.
//!
//! Self-contained on purpose: `skyfix-polar` must build for
//! `wasm32-unknown-unknown` and adds no dependencies of its own.
//!
//! **Basis.** Every 3-vector in this crate is expressed in a *right-handed*
//! orthonormal triad. The world triad is `(east, north, up)`, so
//! `east x north = up`. The camera-body triad is `(image right, image up,
//! optical axis)`, also right-handed. Keeping both right-handed is what makes
//! `R^T (s x v) = (R^T s) x (R^T v)` usable, and that identity is the whole
//! reason the heading search is cheap (see `heading.rs`).

/// A 3-vector in a right-handed orthonormal triad.
pub type Vec3 = [f64; 3];

/// Row-major 3x3 matrix: `m[row][col]`.
pub type Mat3 = [[f64; 3]; 3];

/// The 3x3 identity.
pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
pub fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

#[inline]
pub fn scale(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/// Unit vector, or `None` when the input is shorter than `tol`.
#[inline]
pub fn normalize(a: Vec3, tol: f64) -> Option<Vec3> {
    let n = norm(a);
    if n < tol { None } else { Some(scale(a, 1.0 / n)) }
}

#[inline]
pub fn mat_vec(m: &Mat3, v: Vec3) -> Vec3 {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

pub fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0f64; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
        }
    }
    out
}

pub fn transpose(m: &Mat3) -> Mat3 {
    let mut out = [[0.0f64; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = m[c][r];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn world_triad_is_right_handed() {
        // east x north = up, in (east, north, up) component order.
        let east = [1.0, 0.0, 0.0];
        let north = [0.0, 1.0, 0.0];
        assert_eq!(cross(east, north), [0.0, 0.0, 1.0]);
    }

    #[test]
    fn rotation_commutes_with_the_cross_product() {
        // R(a x b) = (Ra) x (Rb) for any rotation R. The heading search relies on it.
        let t = 0.7_f64;
        let (s, c) = t.sin_cos();
        let r: Mat3 = [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]];
        let a = [0.3, -0.8, 0.5];
        let b = [0.1, 0.2, 0.97];
        let lhs = mat_vec(&r, cross(a, b));
        let rhs = cross(mat_vec(&r, a), mat_vec(&r, b));
        for i in 0..3 {
            assert_relative_eq!(lhs[i], rhs[i], epsilon = 1e-15);
        }
    }

    #[test]
    fn transpose_of_a_rotation_is_its_inverse() {
        let t = -0.4_f64;
        let (s, c) = t.sin_cos();
        let r: Mat3 = [[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]];
        let i = mat_mul(&r, &transpose(&r));
        for a in 0..3 {
            for b in 0..3 {
                assert_relative_eq!(i[a][b], IDENTITY[a][b], epsilon = 1e-15);
            }
        }
    }

    #[test]
    fn normalize_refuses_the_zero_vector() {
        assert!(normalize([0.0, 0.0, 0.0], 1e-12).is_none());
        let u = normalize([3.0, 4.0, 0.0], 1e-12).unwrap();
        assert_relative_eq!(u[0], 0.6, epsilon = 1e-15);
        assert_relative_eq!(u[1], 0.8, epsilon = 1e-15);
        assert_relative_eq!(norm(sub(add(u, u), scale(u, 2.0))), 0.0, epsilon = 1e-15);
    }
}
