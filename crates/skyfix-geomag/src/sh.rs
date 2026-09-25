//! Spherical-harmonic synthesis of the main field, exactly as the WMM2025 technical
//! report (Chulliat et al. 2025, section 1.2) states it; IGRF-14 uses the same equations
//! with its own coefficients.
//!
//! 1. Geodetic latitude, longitude and height above the WGS84 ellipsoid become geocentric
//!    spherical coordinates (latitude `phi'`, radius `r`).
//! 2. The Gauss coefficients `g`, `h` (nT) and their rates (nT/yr) are those of the
//!    instant (`crate::models`).
//! 3. The geocentric north, east and down components are
//!    `X' =  sum_n (a/r)^(n+2) sum_m (g cos m.lon + h sin m.lon) dP/dtheta`,
//!    `Y' = (1/sin theta) sum_n (a/r)^(n+2) sum_m m (g sin m.lon - h cos m.lon) P`,
//!    `Z' = -sum_n (n+1) (a/r)^(n+2) sum_m (g cos m.lon + h sin m.lon) P`,
//!    with `P` the Schmidt semi-normalised associated Legendre functions of the geocentric
//!    colatitude `theta` and `a = 6 371 200 m`; the rates use the rates of the coefficients.
//! 4. They are rotated by `psi = phi' - phi` into the ellipsoidal frame:
//!    `X = X' cos psi - Z' sin psi`, `Y = Y'`, `Z = X' sin psi + Z' cos psi`.
//! 5. `H = hypot(X, Y)`, `F = hypot(H, Z)`, `D = atan2(Y, X)`, `I = atan2(Z, H)` and their
//!    rates `H' = (X X' + Y Y')/H`, `F' = (X X' + Y Y' + Z Z')/F`,
//!    `D' = (X Y' - Y X')/H^2`, `I' = (H Z' - Z H')/F^2`.
//!
//! At a geographic pole `sin theta` is the (tiny, positive) distance from the axis over
//! `r`, never zero, so `Y'` is the limit along the given meridian and "north" is the
//! direction of that meridian.

/// Highest degree of any model here (IGRF-14 from 2000 on).
pub(crate) const N_MAX: usize = 13;
/// Geomagnetic reference radius `a`, metres (both models).
pub(crate) const REFERENCE_RADIUS_M: f64 = 6_371_200.0;
/// WGS84 semi-major axis, metres.
pub(crate) const WGS84_A_M: f64 = 6_378_137.0;
/// WGS84 reciprocal flattening.
pub(crate) const WGS84_INV_F: f64 = 298.257_223_563;

pub(crate) type Table = [[f64; N_MAX + 1]; N_MAX + 1];

/// Gauss coefficients `[n][m]` at one instant (nT) and their rates (nT per year).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Gauss {
    pub g: Table,
    pub h: Table,
    pub g_dot: Table,
    pub h_dot: Table,
}

impl Gauss {
    pub(crate) fn zero() -> Gauss {
        let z = [[0.0; N_MAX + 1]; N_MAX + 1];
        Gauss {
            g: z,
            h: z,
            g_dot: z,
            h_dot: z,
        }
    }
}

/// A point in geocentric spherical coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Spherical {
    pub r_m: f64,
    /// `sin phi'` = cos of the geocentric colatitude.
    pub sin_lat: f64,
    /// `cos phi'` = sin of the geocentric colatitude, never exactly zero.
    pub cos_lat: f64,
    pub lon_rad: f64,
}

impl Spherical {
    /// Geocentric latitude, radians.
    pub(crate) fn lat_rad(&self) -> f64 {
        self.sin_lat.atan2(self.cos_lat)
    }

    /// From geocentric colatitude and longitude (degrees) and radius (metres).
    #[cfg(test)]
    pub(crate) fn from_colatitude(colat_deg: f64, lon_deg: f64, r_m: f64) -> Spherical {
        let (s, c) = colat_deg.to_radians().sin_cos();
        Spherical {
            r_m,
            sin_lat: c,
            cos_lat: s.max(TINY),
            lon_rad: lon_deg.to_radians(),
        }
    }
}

/// Smallest `cos phi'` used, so the east component at a pole is a limit, not 0/0.
const TINY: f64 = 1e-300;

/// WGS84 geodetic latitude (radians), longitude (radians) and height above the
/// ellipsoid (metres) to geocentric spherical coordinates (report equations 7-8).
pub(crate) fn geodetic_to_spherical(lat_rad: f64, lon_rad: f64, height_m: f64) -> Spherical {
    let f = 1.0 / WGS84_INV_F;
    let e2 = f * (2.0 - f);
    let (s, c) = lat_rad.sin_cos();
    let rc = WGS84_A_M / (1.0 - e2 * s * s).sqrt();
    let p = (rc + height_m) * c.abs();
    let z = (rc * (1.0 - e2) + height_m) * s;
    let r = p.hypot(z);
    Spherical {
        r_m: r,
        sin_lat: z / r,
        cos_lat: (p / r).max(TINY),
        lon_rad,
    }
}

/// Schmidt semi-normalised associated Legendre functions `P[n][m]` of `cos theta = ct`
/// and their derivatives with respect to the colatitude `theta` (`sin theta = st`).
fn legendre(ct: f64, st: f64) -> (Table, Table) {
    let mut p = [[0.0; N_MAX + 1]; N_MAX + 1];
    let mut dp = [[0.0; N_MAX + 1]; N_MAX + 1];
    p[0][0] = 1.0;
    for n in 1..=N_MAX {
        let nf = n as f64;
        // Sectoral term: P_n^n = sqrt((2n-1)/(2n)) sin(theta) P_{n-1}^{n-1} (P_1^1 = sin).
        let k = if n == 1 {
            1.0
        } else {
            ((2.0 * nf - 1.0) / (2.0 * nf)).sqrt()
        };
        p[n][n] = k * st * p[n - 1][n - 1];
        dp[n][n] = k * (ct * p[n - 1][n - 1] + st * dp[n - 1][n - 1]);
        // P_n^m = ((2n-1) cos P_{n-1}^m - sqrt((n-1)^2 - m^2) P_{n-2}^m) / sqrt(n^2 - m^2).
        for m in 0..n {
            let mf = m as f64;
            let a = 2.0 * nf - 1.0;
            let b = ((nf - 1.0) * (nf - 1.0) - mf * mf).max(0.0).sqrt();
            let c = (nf * nf - mf * mf).sqrt();
            let (p2, dp2) = if n >= 2 && m < n - 1 {
                (p[n - 2][m], dp[n - 2][m])
            } else {
                (0.0, 0.0)
            };
            p[n][m] = (a * ct * p[n - 1][m] - b * p2) / c;
            dp[n][m] = (a * (ct * dp[n - 1][m] - st * p[n - 1][m]) - b * dp2) / c;
        }
    }
    (p, dp)
}

/// Everything that depends on latitude and height only, so a row of a grid computes it
/// once: the Legendre functions, the powers of `a/r` and the rotation to the ellipsoid.
pub(crate) struct Row {
    p: Table,
    dp: Table,
    /// `(a/r)^(n+2)` for `n = 0..=N_MAX`.
    rn: [f64; N_MAX + 1],
    /// `cos phi'`, never zero.
    cos_lat: f64,
    /// `psi = phi' - phi`, the geocentric minus the geodetic latitude.
    sin_psi: f64,
    cos_psi: f64,
}

impl Row {
    /// A geodetic latitude (radians) and height above the ellipsoid (metres).
    pub(crate) fn geodetic(lat_rad: f64, height_m: f64) -> Row {
        let at = geodetic_to_spherical(lat_rad, 0.0, height_m);
        Row::spherical(&at, at.lat_rad() - lat_rad)
    }

    /// A geocentric point, with `psi` for the rotation (0: stay geocentric).
    pub(crate) fn spherical(at: &Spherical, psi: f64) -> Row {
        let (p, dp) = legendre(at.sin_lat, at.cos_lat);
        let ratio = REFERENCE_RADIUS_M / at.r_m;
        let mut rn = [0.0; N_MAX + 1];
        let mut x = ratio * ratio;
        for r in rn.iter_mut() {
            *r = x;
            x *= ratio;
        }
        let (sin_psi, cos_psi) = psi.sin_cos();
        Row {
            p,
            dp,
            rn,
            cos_lat: at.cos_lat,
            sin_psi,
            cos_psi,
        }
    }

    /// Geocentric `[X', Y', Z']` (nT) at east longitude `lon_rad`, and their rates (nT/yr)
    /// when `rates` (zeros otherwise).
    pub(crate) fn synthesize(
        &self,
        gauss: &Gauss,
        lon_rad: f64,
        rates: bool,
    ) -> ([f64; 3], [f64; 3]) {
        let (s1, c1) = lon_rad.sin_cos();
        let mut cos_ml = [0.0; N_MAX + 1];
        let mut sin_ml = [0.0; N_MAX + 1];
        cos_ml[0] = 1.0;
        for m in 1..=N_MAX {
            cos_ml[m] = cos_ml[m - 1] * c1 - sin_ml[m - 1] * s1;
            sin_ml[m] = sin_ml[m - 1] * c1 + cos_ml[m - 1] * s1;
        }
        let mut v = [0.0; 3];
        let mut v_dot = [0.0; 3];
        for n in 1..=N_MAX {
            let rn = self.rn[n];
            let n1 = (n + 1) as f64;
            for m in 0..=n {
                let (c, s) = (cos_ml[m], sin_ml[m]);
                let mf = m as f64;
                let (p, dp) = (self.p[n][m], self.dp[n][m]);
                let (g, h) = (gauss.g[n][m], gauss.h[n][m]);
                let a = g * c + h * s;
                let b = g * s - h * c;
                v[0] += rn * a * dp;
                v[1] += rn * mf * b * p;
                v[2] -= rn * n1 * a * p;
                if rates {
                    let (gd, hd) = (gauss.g_dot[n][m], gauss.h_dot[n][m]);
                    let ad = gd * c + hd * s;
                    let bd = gd * s - hd * c;
                    v_dot[0] += rn * ad * dp;
                    v_dot[1] += rn * mf * bd * p;
                    v_dot[2] -= rn * n1 * ad * p;
                }
            }
        }
        v[1] /= self.cos_lat;
        v_dot[1] /= self.cos_lat;
        (v, v_dot)
    }

    /// A geocentric north-east-down vector turned into the ellipsoidal frame.
    pub(crate) fn rotate(&self, v: [f64; 3]) -> [f64; 3] {
        [
            v[0] * self.cos_psi - v[2] * self.sin_psi,
            v[1],
            v[0] * self.sin_psi + v[2] * self.cos_psi,
        ]
    }
}

/// Geocentric `[X', Y', Z']` (nT) and their rates (nT/yr) at a point.
#[cfg(test)]
pub(crate) fn synthesize(gauss: &Gauss, at: &Spherical) -> ([f64; 3], [f64; 3]) {
    Row::spherical(at, 0.0).synthesize(gauss, at.lon_rad, true)
}

/// Every element of the field and its annual rate, in the ellipsoidal frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Elements {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub h: f64,
    pub f: f64,
    pub d_rad: f64,
    pub i_rad: f64,
    pub x_dot: f64,
    pub y_dot: f64,
    pub z_dot: f64,
    pub h_dot: f64,
    pub f_dot: f64,
    pub d_dot_rad: f64,
    pub i_dot_rad: f64,
}

/// The field at a geodetic point (report steps 1, 3, 4 and 5).
pub(crate) fn elements(gauss: &Gauss, lat_rad: f64, lon_rad: f64, height_m: f64) -> Elements {
    let row = Row::geodetic(lat_rad, height_m);
    let (v, v_dot) = row.synthesize(gauss, lon_rad, true);
    from_components(row.rotate(v), row.rotate(v_dot))
}

/// H, F, D, I and their rates from north, east, down components and rates.
pub(crate) fn from_components(v: [f64; 3], v_dot: [f64; 3]) -> Elements {
    let [x, y, z] = v;
    let [x_dot, y_dot, z_dot] = v_dot;
    let h = x.hypot(y);
    let f = h.hypot(z);
    let (h_dot, d_dot_rad) = if h > 0.0 {
        (
            (x * x_dot + y * y_dot) / h,
            (x * y_dot - y * x_dot) / (h * h),
        )
    } else {
        // Exactly on a dip pole: no horizontal field, no declination to change.
        (0.0, 0.0)
    };
    let f_dot = if f > 0.0 {
        (x * x_dot + y * y_dot + z * z_dot) / f
    } else {
        0.0
    };
    let i_dot_rad = if f > 0.0 {
        (h * z_dot - z * h_dot) / (f * f)
    } else {
        0.0
    };
    Elements {
        x,
        y,
        z,
        h,
        f,
        d_rad: y.atan2(x),
        i_rad: z.atan2(h),
        x_dot,
        y_dot,
        z_dot,
        h_dot,
        f_dot,
        d_dot_rad,
        i_dot_rad,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Schmidt semi-normalised closed forms for a few functions.
    #[test]
    fn the_legendre_recursion_matches_the_closed_forms() {
        for &theta_deg in &[0.3f64, 17.0, 45.0, 90.0, 123.0, 179.7] {
            let t = theta_deg.to_radians();
            let (st, ct) = t.sin_cos();
            let (p, dp) = legendre(ct, st);
            let s3 = 3f64.sqrt();
            let checks = [
                (1, 0, ct, -st),
                (1, 1, st, ct),
                (2, 0, 1.5 * ct * ct - 0.5, -3.0 * ct * st),
                (2, 1, s3 * ct * st, s3 * (ct * ct - st * st)),
                (2, 2, 0.5 * s3 * st * st, s3 * st * ct),
                (
                    3,
                    1,
                    (3.0f64 / 8.0).sqrt() * st * (5.0 * ct * ct - 1.0),
                    (3.0f64 / 8.0).sqrt() * (ct * (5.0 * ct * ct - 1.0) - 10.0 * st * st * ct),
                ),
            ];
            for (n, m, pv, dpv) in checks {
                assert!((p[n][m] - pv).abs() < 1e-14, "P{n}{m} at {theta_deg}");
                assert!((dp[n][m] - dpv).abs() < 1e-13, "dP{n}{m} at {theta_deg}");
            }
        }
    }

    #[test]
    fn the_derivatives_are_the_slopes_of_the_functions() {
        let t = 0.7f64;
        let e = 1e-6;
        let (p1, _) = legendre((t + e).cos(), (t + e).sin());
        let (p0, _) = legendre((t - e).cos(), (t - e).sin());
        let (_, dp) = legendre(t.cos(), t.sin());
        for n in 1..=N_MAX {
            for m in 0..=n {
                let slope = (p1[n][m] - p0[n][m]) / (2.0 * e);
                assert!((slope - dp[n][m]).abs() < 1e-8, "n {n} m {m}");
            }
        }
    }

    /// The recursion's derivatives against the exact identity
    /// `dP_n^m/dtheta = (n cos(theta) P_n^m - sqrt(n^2 - m^2) P_{n-1}^m) / sin(theta)`.
    #[test]
    fn the_derivatives_satisfy_the_exact_identity() {
        let mut worst: f64 = 0.0;
        for i in 1..180 {
            let t = (i as f64).to_radians();
            let (st, ct) = t.sin_cos();
            let (p, dp) = legendre(ct, st);
            for n in 1..=N_MAX {
                for m in 0..=n {
                    let nf = n as f64;
                    let mf = m as f64;
                    let prev = if m < n { p[n - 1][m] } else { 0.0 };
                    let exact = (nf * ct * p[n][m] - (nf * nf - mf * mf).sqrt() * prev) / st;
                    worst = worst.max((exact - dp[n][m]).abs());
                }
            }
        }
        assert!(worst < 1e-12, "{worst:e}");
    }

    #[test]
    fn an_axial_dipole_points_north_and_dips_down_in_the_north() {
        let mut g = Gauss::zero();
        g.g[1][0] = -30_000.0;
        let e = elements(&g, 45f64.to_radians(), 0.3, 0.0);
        assert!(e.x > 0.0 && e.z > 0.0 && e.y.abs() < 1e-9);
        let s = elements(&g, (-45f64).to_radians(), 0.3, 0.0);
        assert!(s.x > 0.0 && s.z < 0.0);
    }

    #[test]
    fn the_poles_are_limits_not_zero_over_zero() {
        let mut g = Gauss::zero();
        g.g[1][1] = -1500.0;
        g.h[1][1] = 4500.0;
        for lat in [90.0f64, -90.0] {
            let e = elements(&g, lat.to_radians(), 1.0, 0.0);
            assert!(
                e.x.is_finite() && e.y.is_finite() && e.z.is_finite(),
                "{e:?}"
            );
            let near = elements(&g, (lat - lat.signum() * 1e-7).to_radians(), 1.0, 0.0);
            assert!((e.y - near.y).abs() < 1e-3 && (e.x - near.x).abs() < 1e-3);
        }
    }
}
