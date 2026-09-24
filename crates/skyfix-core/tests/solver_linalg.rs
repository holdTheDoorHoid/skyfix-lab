//! The numerical primitives under the solver: small dense linear algebra, the 95 %
//! ellipse and the conditioning report. Every case here has an answer worked out by hand
//! or by an independent identity, never by running the code and recording what it said.

use skyfix_core::linalg;
use skyfix_core::types::Conditioning;
use skyfix_core::uncertainty::{
    ELLIPSE_MODEL, conditioning, ellipse_95, is_poor_geometry, max_azimuth_gap_deg,
};
use skyfix_core::units::{CHI2_95_2DOF, NM_M};

fn m(rows: &[&[f64]]) -> Vec<Vec<f64>> {
    rows.iter().map(|r| r.to_vec()).collect()
}

#[test]
fn cholesky_solves_and_inverts_a_known_system() {
    // A = [[4, 2], [2, 3]], det 8. A^-1 = [[3, -2], [-2, 4]] / 8.
    let a = m(&[&[4.0, 2.0], &[2.0, 3.0]]);
    let x = linalg::solve_sym_pd(&a, &[10.0, 11.0]).unwrap();
    // 4x + 2y = 10, 2x + 3y = 11  ->  x = 1, y = 3.
    assert!(
        (x[0] - 1.0).abs() < 1e-12 && (x[1] - 3.0).abs() < 1e-12,
        "{x:?}"
    );

    let inv = linalg::invert_sym_pd(&a).unwrap();
    let expect = [[3.0 / 8.0, -2.0 / 8.0], [-2.0 / 8.0, 4.0 / 8.0]];
    for i in 0..2 {
        for j in 0..2 {
            assert!(
                (inv[i][j] - expect[i][j]).abs() < 1e-12,
                "inv[{i}][{j}] = {}",
                inv[i][j]
            );
        }
    }

    // A 3x3 with a known inverse: the diagonal case, plus a round-trip identity check.
    let b = m(&[&[2.0, 1.0, 0.0], &[1.0, 3.0, 1.0], &[0.0, 1.0, 4.0]]);
    let binv = linalg::invert_sym_pd(&b).unwrap();
    for (i, brow) in b.iter().enumerate() {
        for j in 0..3 {
            let s: f64 = brow
                .iter()
                .zip(binv.iter())
                .map(|(bik, ikr)| bik * ikr[j])
                .sum();
            let want = if i == j { 1.0 } else { 0.0 };
            assert!((s - want).abs() < 1e-12, "(B B^-1)[{i}][{j}] = {s}");
        }
    }
}

#[test]
fn non_positive_definite_matrices_are_refused() {
    assert!(
        linalg::cholesky(&m(&[&[1.0, 2.0], &[2.0, 1.0]])).is_none(),
        "indefinite"
    );
    assert!(
        linalg::cholesky(&m(&[&[0.0, 0.0], &[0.0, 1.0]])).is_none(),
        "singular"
    );
    assert!(linalg::cholesky(&m(&[&[-1.0]])).is_none(), "negative");
    assert!(linalg::cholesky(&[]).is_none(), "empty");
    assert!(linalg::cholesky(&m(&[&[1.0, 0.0]])).is_none(), "not square");
    assert!(
        linalg::solve_sym_pd(&m(&[&[4.0]]), &[1.0, 2.0]).is_none(),
        "length mismatch"
    );
    let nan = m(&[&[f64::NAN, 0.0], &[0.0, 1.0]]);
    assert!(linalg::cholesky(&nan).is_none(), "NaN");
}

#[test]
fn symmetric_2x2_eigen_is_exact_on_hand_cases() {
    // [[2, 1], [1, 2]]: eigenvalues 3 and 1, first eigenvector along (1, 1).
    let (values, vectors) = linalg::eigen_sym2([[2.0, 1.0], [1.0, 2.0]]);
    assert!(
        (values[0] - 3.0).abs() < 1e-12 && (values[1] - 1.0).abs() < 1e-12,
        "{values:?}"
    );
    let inv_root2 = 1.0 / 2f64.sqrt();
    assert!((vectors[0][0].abs() - inv_root2).abs() < 1e-12);
    assert!(
        (vectors[0][0] * vectors[1][0] - 0.5).abs() < 1e-12,
        "same sign, (1,1) direction"
    );

    // Already diagonal, larger value second: the decomposition must reorder.
    let (values, vectors) = linalg::eigen_sym2([[1.0, 0.0], [0.0, 9.0]]);
    assert!((values[0] - 9.0).abs() < 1e-12 && (values[1] - 1.0).abs() < 1e-12);
    assert!(vectors[0][0].abs() < 1e-12 && vectors[1][0].abs() - 1.0 < 1e-12);

    // A v = lambda v, and the eigenvectors are orthonormal, for an arbitrary matrix.
    let a = [[3.5, -1.25], [-1.25, 0.75]];
    let (values, vectors) = linalg::eigen_sym2(a);
    assert!(values[0] >= values[1]);
    for c in 0..2 {
        let v = [vectors[0][c], vectors[1][c]];
        assert!(
            (v[0] * v[0] + v[1] * v[1] - 1.0).abs() < 1e-12,
            "unit length"
        );
        for r in 0..2 {
            let av = a[r][0] * v[0] + a[r][1] * v[1];
            assert!((av - values[c] * v[r]).abs() < 1e-12, "A v = lambda v");
        }
    }
    let dot = vectors[0][0] * vectors[0][1] + vectors[1][0] * vectors[1][1];
    assert!(dot.abs() < 1e-12, "orthogonal");
    // Trace and determinant are preserved.
    assert!((values[0] + values[1] - (a[0][0] + a[1][1])).abs() < 1e-12);
    assert!((values[0] * values[1] - (a[0][0] * a[1][1] - a[0][1] * a[1][0])).abs() < 1e-12);
}

#[test]
fn jacobi_eigen_reconstructs_a_symmetric_matrix() {
    let a = m(&[&[4.0, 1.0, -2.0], &[1.0, 2.0, 0.0], &[-2.0, 0.0, 3.0]]);
    let (values, vectors) = linalg::jacobi_eigen_sym(&a);
    assert_eq!(values.len(), 3);
    assert!(
        values[0] >= values[1] && values[1] >= values[2],
        "{values:?}"
    );
    assert!(
        (values.iter().sum::<f64>() - 9.0).abs() < 1e-10,
        "trace is preserved"
    );

    // V diag(values) V^T == A.
    for i in 0..3 {
        for j in 0..3 {
            let s: f64 = (0..3)
                .map(|k| vectors[i][k] * values[k] * vectors[j][k])
                .sum();
            assert!((s - a[i][j]).abs() < 1e-10, "reconstruct[{i}][{j}] = {s}");
        }
    }
    // Columns are orthonormal.
    for c1 in 0..3 {
        for c2 in 0..3 {
            let dot: f64 = (0..3).map(|r| vectors[r][c1] * vectors[r][c2]).sum();
            let want = if c1 == c2 { 1.0 } else { 0.0 };
            assert!((dot - want).abs() < 1e-10, "V^T V [{c1}][{c2}] = {dot}");
        }
    }

    // A diagonal matrix comes back untouched apart from ordering.
    let (values, _) = linalg::jacobi_eigen_sym(&m(&[&[5.0, 0.0], &[0.0, 7.0]]));
    assert!((values[0] - 7.0).abs() < 1e-12 && (values[1] - 5.0).abs() < 1e-12);
    // Degenerate input is handled rather than looping.
    let (values, _) = linalg::jacobi_eigen_sym(&m(&[&[0.0, 0.0], &[0.0, 0.0]]));
    assert_eq!(values, vec![0.0, 0.0]);
    assert!(
        linalg::jacobi_eigen_sym(&m(&[&[1.0, 2.0]])).0.is_empty(),
        "not square"
    );
}

#[test]
fn singular_values_of_a_tall_matrix() {
    // Orthonormal columns scaled: [[2,0],[0,3],[0,0]] has singular values 3 and 2.
    let j = m(&[&[2.0, 0.0], &[0.0, 3.0], &[0.0, 0.0]]);
    let s = linalg::singular_values(&j);
    assert!(
        (s[0] - 3.0).abs() < 1e-12 && (s[1] - 2.0).abs() < 1e-12,
        "{s:?}"
    );

    // Two identical rows: rank 1, so the smaller singular value is zero.
    let j = m(&[&[1.0, 0.0], &[1.0, 0.0]]);
    let s = linalg::singular_values(&j);
    assert!((s[0] - 2f64.sqrt()).abs() < 1e-12, "{s:?}");
    assert!(s[1] < 1e-12, "{s:?}");

    // Three unit rows 120 degrees apart: J^T J = 1.5 I, so both values are sqrt(1.5).
    let j: Vec<Vec<f64>> = [0.0f64, 120.0, 240.0]
        .iter()
        .map(|d| {
            let r = d.to_radians();
            vec![r.cos(), r.sin()]
        })
        .collect();
    let s = linalg::singular_values(&j);
    assert!(
        (s[0] - 1.5f64.sqrt()).abs() < 1e-12 && (s[1] - 1.5f64.sqrt()).abs() < 1e-12,
        "{s:?}"
    );
}

#[test]
fn the_ellipse_is_the_labelled_95_percent_contour() {
    // Axis-aligned, north larger.
    let e = ellipse_95([[400.0, 0.0], [0.0, 100.0]]).unwrap();
    assert!((e.semi_major_m - (CHI2_95_2DOF * 400.0).sqrt()).abs() < 1e-9);
    assert!((e.semi_minor_m - (CHI2_95_2DOF * 100.0).sqrt()).abs() < 1e-9);
    assert!(e.orientation_deg.abs() < 1e-9, "major axis due north");
    assert_eq!(e.confidence, 0.95);
    assert_eq!(e.model, ELLIPSE_MODEL);
    assert_eq!(e.model, "nominal 95 %, independent-noise model");

    // Axis-aligned, east larger: the major axis is due east.
    let e = ellipse_95([[100.0, 0.0], [0.0, 400.0]]).unwrap();
    assert!((e.orientation_deg - 90.0).abs() < 1e-9);

    // Correlated: [[2, 1], [1, 2]] has its major axis along north-east.
    let e = ellipse_95([[2.0, 1.0], [1.0, 2.0]]).unwrap();
    assert!(
        (e.orientation_deg - 45.0).abs() < 1e-9,
        "{}",
        e.orientation_deg
    );
    assert!((e.semi_major_m - (CHI2_95_2DOF * 3.0).sqrt()).abs() < 1e-12);
    // ...and the opposite correlation puts it along north-west, reported in [0, 180).
    let e = ellipse_95([[2.0, -1.0], [-1.0, 2.0]]).unwrap();
    assert!(
        (e.orientation_deg - 135.0).abs() < 1e-9,
        "{}",
        e.orientation_deg
    );
    assert!(e.orientation_deg >= 0.0 && e.orientation_deg < 180.0);

    // Not positive definite, or not finite: no ellipse at all.
    assert!(ellipse_95([[1.0, 2.0], [2.0, 1.0]]).is_none(), "indefinite");
    assert!(ellipse_95([[0.0, 0.0], [0.0, 1.0]]).is_none(), "singular");
    assert!(ellipse_95([[f64::NAN, 0.0], [0.0, 1.0]]).is_none(), "NaN");
    assert!(
        ellipse_95([[f64::INFINITY, 0.0], [0.0, 1.0]]).is_none(),
        "infinite"
    );
}

#[test]
fn conditioning_of_hand_worked_geometries() {
    // Two sights at right angles, sigma = 1 radian: perfectly conditioned.
    let jw = m(&[&[1.0, 0.0], &[0.0, 1.0]]);
    let c = conditioning(&jw, &[0.0, std::f64::consts::FRAC_PI_2]);
    assert_eq!(c.rank, 2);
    assert!((c.condition_number - 1.0).abs() < 1e-12);
    assert_eq!(c.singular_values.len(), 2);
    assert_eq!(c.columns, "position (north, east)");
    // trace((J^T J)^-1) = 2, so the dilution is sqrt(2) NM per arcminute.
    assert!(
        (c.geometric_dilution_m_per_arcmin - 2f64.sqrt() * NM_M).abs() < 1e-6,
        "{}",
        c.geometric_dilution_m_per_arcmin
    );
    // Azimuths 0 and 90: the rest of the compass is one 270 degree gap.
    assert!((c.max_azimuth_gap_deg - 270.0).abs() < 1e-9);
    assert!(
        is_poor_geometry(&c),
        "half the compass empty is poor geometry"
    );

    // Three sights 120 degrees apart: J^T J = 1.5 I.
    let jw: Vec<Vec<f64>> = [0.0f64, 120.0, 240.0]
        .iter()
        .map(|d| {
            let r = d.to_radians();
            vec![r.cos(), r.sin()]
        })
        .collect();
    let az: Vec<f64> = [0.0f64, 120.0, 240.0]
        .iter()
        .map(|d| d.to_radians())
        .collect();
    let c = conditioning(&jw, &az);
    assert_eq!(c.rank, 2);
    assert!((c.condition_number - 1.0).abs() < 1e-12);
    assert!((c.max_azimuth_gap_deg - 120.0).abs() < 1e-9);
    assert!(
        (c.geometric_dilution_m_per_arcmin - (2.0f64 / 1.5).sqrt() * NM_M).abs() < 1e-6,
        "{}",
        c.geometric_dilution_m_per_arcmin
    );
    assert!(!is_poor_geometry(&c));

    // Parallel rows: rank 1, infinite condition number, infinite dilution.
    let jw = m(&[&[1.0, 0.0], &[2.0, 0.0]]);
    let c = conditioning(&jw, &[0.0, 0.0]);
    assert_eq!(c.rank, 1);
    assert!(c.condition_number.is_infinite());
    assert!(c.geometric_dilution_m_per_arcmin.is_infinite());
    assert!(is_poor_geometry(&c));

    // Sigmas scale the singular values but never the geometry-only dilution.
    let sharp = m(&[&[10.0, 0.0], &[0.0, 10.0]]);
    let cs = conditioning(&sharp, &[0.0, std::f64::consts::FRAC_PI_2]);
    assert!((cs.singular_values[0] - 10.0).abs() < 1e-12);
    assert!((cs.geometric_dilution_m_per_arcmin - 2f64.sqrt() * NM_M).abs() < 1e-6);

    // A bias column is reported as such.
    let with_bias = m(&[&[1.0, 0.0, 1.0], &[0.0, 1.0, 1.0], &[-1.0, 0.0, 1.0]]);
    let c = conditioning(&with_bias, &[0.0, 1.0, 2.0]);
    assert_eq!(c.columns, "position (north, east) and shared bias");
    assert_eq!(c.singular_values.len(), 3);
    assert_eq!(c.rank, 3);
}

#[test]
fn azimuth_gaps_around_the_circle() {
    let d = |v: &[f64]| -> Vec<f64> { v.iter().map(|x| x.to_radians()).collect() };
    assert_eq!(max_azimuth_gap_deg(&[]), 360.0);
    assert_eq!(
        max_azimuth_gap_deg(&d(&[42.0])),
        360.0,
        "one body is one direction"
    );
    assert!((max_azimuth_gap_deg(&d(&[0.0, 180.0])) - 180.0).abs() < 1e-9);
    assert!((max_azimuth_gap_deg(&d(&[10.0, 130.0, 250.0])) - 120.0).abs() < 1e-9);
    // Unsorted input, and the wrap-around gap is the largest one.
    assert!((max_azimuth_gap_deg(&d(&[350.0, 10.0, 30.0])) - 320.0).abs() < 1e-9);
    // Normalisation: -10 degrees is 350 degrees.
    assert!((max_azimuth_gap_deg(&d(&[-10.0, 10.0, 30.0])) - 320.0).abs() < 1e-9);
    // A non-finite azimuth is ignored rather than poisoning the sort.
    assert!((max_azimuth_gap_deg(&[0.0, f64::NAN, std::f64::consts::PI]) - 180.0).abs() < 1e-9);
}

#[test]
fn poor_geometry_thresholds() {
    let base = Conditioning {
        singular_values: vec![1.0, 1.0],
        condition_number: 1.0,
        rank: 2,
        geometric_dilution_m_per_arcmin: NM_M,
        max_azimuth_gap_deg: 120.0,
        columns: "position (north, east)".to_string(),
    };
    assert!(!is_poor_geometry(&base));
    assert!(!is_poor_geometry(&Conditioning {
        condition_number: 20.0,
        ..base.clone()
    }));
    assert!(is_poor_geometry(&Conditioning {
        condition_number: 20.1,
        ..base.clone()
    }));
    assert!(!is_poor_geometry(&Conditioning {
        max_azimuth_gap_deg: 180.0,
        ..base.clone()
    }));
    assert!(is_poor_geometry(&Conditioning {
        max_azimuth_gap_deg: 180.1,
        ..base.clone()
    }));
    assert!(is_poor_geometry(&Conditioning {
        condition_number: f64::NAN,
        ..base
    }));
}
