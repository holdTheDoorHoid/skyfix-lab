//! Besselian elements of a solar eclipse and the geometry of the fundamental plane.
//!
//! The classical construction (Explanatory Supplement to the Astronomical Almanac,
//! 1961 and 1992 editions, chapter "Eclipses"; Chauvenet), carried out in the
//! Earth-fixed frame of date that `skyfix_ephemeris::topocentric` uses (x toward the
//! Greenwich meridian, z toward the true pole, Earth rotation by GAST with the
//! provider's DUT1), so that the hour angle `mu` of the shadow axis comes out directly.
//!
//! - Positions: the apparent geocentric Sun (`SunProvider`) and Moon (`MoonProvider`)
//!   of CONVENTIONS section 7, placed at their geometric distances. Unit of length:
//!   the WGS84 equatorial radius `a`.
//! - Shadow axis: the line through the centres of the Moon and the Sun; `z` points
//!   from the Moon toward the Sun. `d` is its declination and `mu` its Greenwich hour
//!   angle (radians, unwrapped so it is continuous over the window).
//! - Fundamental plane: through the Earth's centre, perpendicular to the axis, with
//!   `x` toward the east (increasing right ascension) and `y` toward the north.
//!   `x`, `y` are the coordinates of the axis (the Moon's centre projected).
//! - Cones: penumbral half-angle `sin f1 = (R_sun + k1) / G`, umbral
//!   `sin f2 = (R_sun - k2) / G`, `G` the Sun-Moon distance; radii on the plane
//!   `l1 = z tan f1 + k1 sec f1` and `l2 = z tan f2 - k2 sec f2` (negative when the
//!   umbra reaches the plane, i.e. total).
//!
//! An observer at fundamental coordinates `(xi, eta, zeta)` sees the limbs touch
//! externally when the distance `D` from the axis equals `L1 = l1 - zeta tan f1`, and
//! internally when `D = |L2|`, `L2 = l2 - zeta tan f2` (`L2 < 0`: total there). The
//! magnitude is `(L1 - D) / (L1 + L2)`. This is exact for spherical Sun and Moon; the
//! only approximation in this module is the interpolation, measured in the tests.

use skyfix_ephemeris::EphemerisError;
use skyfix_ephemeris::body::AU_KM;
use skyfix_ephemeris::moon::{MoonPosition, MoonProvider};
use skyfix_ephemeris::sun::{SUN_SEMIDIAMETER_UNIT_ARCSEC, SunPosition, SunProvider};
use skyfix_ephemeris::topocentric::{WGS84_A_KM, WGS84_F, earth_fixed_unit};

use super::cheb::{Cheb, nodes};

/// Radius of the Moon in Earth equatorial radii for the penumbra (first and fourth
/// contacts): NASA's `k1`, the value in the Besselian elements Espenak publishes.
pub const K_PENUMBRA: f64 = 0.272_488;
/// Radius of the Moon for the umbra (second and third contacts, the limits of the
/// path): NASA's `k2`, smaller than the mean radius so it represents the valleys of
/// the limb profile through which the last sunlight shines.
pub const K_UMBRA: f64 = 0.272_281;

/// WGS84 polar radius over equatorial radius.
pub(crate) const B_OVER_A: f64 = 1.0 - WGS84_F;

/// The Sun's radius in Earth equatorial radii: the radius that subtends
/// `SUN_SEMIDIAMETER_UNIT_ARCSEC` (959.63") at one astronomical unit, the same
/// constant the Sun provider's semidiameter uses.
pub(crate) fn sun_radius_earth_radii() -> f64 {
    AU_KM * (SUN_SEMIDIAMETER_UNIT_ARCSEC / 206_264.806_247_096_36).sin() / WGS84_A_KM
}

pub(crate) type Vec3 = [f64; 3];

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Earth-fixed position of the Sun and the Moon, Earth equatorial radii.
pub(crate) fn earth_fixed_positions(sun: &SunPosition, moon: &MoonPosition) -> (Vec3, Vec3) {
    let s = scale(
        earth_fixed_unit(sun.gha_deg, sun.dec_deg),
        sun.radius_au * AU_KM / WGS84_A_KM,
    );
    let m = scale(
        earth_fixed_unit(moon.gha_deg, moon.dec_deg),
        moon.distance_km / WGS84_A_KM,
    );
    (s, m)
}

/// The Besselian elements at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Elements {
    pub x: f64,
    pub y: f64,
    /// Declination of the axis, radians.
    pub d: f64,
    /// Greenwich hour angle of the axis, radians (unwrapped).
    pub mu: f64,
    pub l1: f64,
    pub l2: f64,
    pub tan_f1: f64,
    pub tan_f2: f64,
}

/// Hourly rates of the elements (radians per hour for `d` and `mu`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rates {
    pub x: f64,
    pub y: f64,
    pub d: f64,
    pub mu: f64,
    pub l1: f64,
    pub l2: f64,
}

/// The elements straight from two ephemeris positions.
pub(crate) fn elements_from(sun: &SunPosition, moon: &MoonPosition) -> Elements {
    let (s, m) = earth_fixed_positions(sun, moon);
    let g = sub(s, m);
    let gn = norm(g);
    let z = scale(g, 1.0 / gn);
    let d = z[2].clamp(-1.0, 1.0).asin();
    let mu = (-z[1]).atan2(z[0]).rem_euclid(std::f64::consts::TAU);
    let f = Frame::new(d, mu);
    let (x, y, zm) = (dot(m, f.x), dot(m, f.y), dot(m, f.z));
    let rs = sun_radius_earth_radii();
    let sin_f1 = (rs + K_PENUMBRA) / gn;
    let sin_f2 = (rs - K_UMBRA) / gn;
    let (cos_f1, cos_f2) = (
        (1.0 - sin_f1 * sin_f1).sqrt(),
        (1.0 - sin_f2 * sin_f2).sqrt(),
    );
    let (tan_f1, tan_f2) = (sin_f1 / cos_f1, sin_f2 / cos_f2);
    Elements {
        x,
        y,
        d,
        mu,
        l1: zm * tan_f1 + K_PENUMBRA / cos_f1,
        l2: zm * tan_f2 - K_UMBRA / cos_f2,
        tan_f1,
        tan_f2,
    }
}

/// The axes of the fundamental plane in the Earth-fixed frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Frame {
    pub x: Vec3,
    pub y: Vec3,
    pub z: Vec3,
}

impl Frame {
    pub(crate) fn new(d: f64, mu: f64) -> Frame {
        let (sd, cd) = d.sin_cos();
        let (sm, cm) = mu.sin_cos();
        Frame {
            x: [sm, cm, 0.0],
            y: [-sd * cm, sd * sm, cd],
            z: [cd * cm, -cd * sm, sd],
        }
    }

    /// Fundamental coordinates `(xi, eta, zeta)` of an Earth-fixed point.
    pub(crate) fn project(&self, p: Vec3) -> Vec3 {
        [dot(p, self.x), dot(p, self.y), dot(p, self.z)]
    }

    /// The point of the sea-level ellipsoid on the sunward side with fundamental
    /// coordinates `(xi, eta)`, and its `zeta`. `None` when the line parallel to the
    /// axis through `(xi, eta)` misses the Earth (the Sun is below the horizon there).
    ///
    /// Solves `(A + zeta z)^T M (A + zeta z) = 1` with `M = diag(1, 1, 1/b^2)` and
    /// `A = xi x + eta y`. At the sunward root the outward normal `M P` has component
    /// `sqrt(disc)` along `z`: positive means the Sun is above the geodetic horizon,
    /// zero is the limb.
    pub(crate) fn surface_point(&self, xi: f64, eta: f64) -> Option<(Vec3, f64, f64)> {
        let a = [
            xi * self.x[0] + eta * self.y[0],
            xi * self.x[1] + eta * self.y[1],
            xi * self.x[2] + eta * self.y[2],
        ];
        let ib2 = 1.0 / (B_OVER_A * B_OVER_A);
        let mdot = |u: Vec3, v: Vec3| u[0] * v[0] + u[1] * v[1] + u[2] * v[2] * ib2;
        let qa = mdot(self.z, self.z);
        let qb = mdot(a, self.z);
        let qc = mdot(a, a) - 1.0;
        let disc = qb * qb - qa * qc;
        if disc < 0.0 {
            return None;
        }
        let zeta = (-qb + disc.sqrt()) / qa;
        let p = [
            a[0] + zeta * self.z[0],
            a[1] + zeta * self.z[1],
            a[2] + zeta * self.z[2],
        ];
        Some((p, zeta, disc))
    }

    /// The semi-minor axis of the Earth's outline on the fundamental plane (the
    /// semi-major axis, along `x`, is 1): `sqrt(1 - e^2 cos^2 d)`.
    pub(crate) fn outline_rho1(d: f64) -> f64 {
        let e2 = 1.0 - B_OVER_A * B_OVER_A;
        (1.0 - e2 * d.cos().powi(2)).sqrt()
    }
}

/// Observer velocity on the fundamental plane (per hour), from the axes' rotation:
/// `xi' = mu' (zeta cos d - eta sin d)`, `eta' = mu' xi sin d - d' zeta`,
/// `zeta' = -mu' xi cos d + d' eta` (Explanatory Supplement).
pub(crate) fn observer_rates(q: Vec3, e: &Elements, r: &Rates) -> Vec3 {
    let (sd, cd) = e.d.sin_cos();
    [
        r.mu * (q[2] * cd - q[1] * sd),
        r.mu * q[0] * sd - r.d * q[2],
        -r.mu * q[0] * cd + r.d * q[1],
    ]
}

/// Geodetic latitude and east longitude (degrees) of a point on the sea-level
/// ellipsoid, Earth-fixed, in equatorial radii.
pub(crate) fn geodetic_of_surface_point(p: Vec3) -> (f64, f64) {
    let lon = p[1].atan2(p[0]).to_degrees();
    let lat = p[2]
        .atan2(B_OVER_A * B_OVER_A * p[0].hypot(p[1]))
        .to_degrees();
    (lat, lon)
}

/// Interpolated Besselian elements over a window of a few hours.
///
/// Time is measured in hours from `jd_mid` (UTC-based Julian date); the element
/// window is `[t_lo, t_hi]` hours.
#[derive(Debug, Clone)]
pub(crate) struct SolarElements {
    pub jd_mid: f64,
    pub t_lo: f64,
    pub t_hi: f64,
    x: Cheb,
    y: Cheb,
    d: Cheb,
    mu: Cheb,
    l1: Cheb,
    l2: Cheb,
    tan_f1: Cheb,
    tan_f2: Cheb,
}

/// Number of Chebyshev nodes per window. `tests::interpolation_matches_the_ephemeris`
/// measures the interpolation error against direct evaluation over a 12-hour window:
/// from 7 nodes up it is at the floor set by the time resolution of an `f64` Julian
/// date, so 9 leaves a margin at 0.6 ms of ephemeris per eclipse.
pub(crate) const NODES: usize = 9;

impl SolarElements {
    /// Sample the ephemeris at the Chebyshev nodes of `[t_lo, t_hi]` hours around
    /// `jd_mid` and interpolate.
    pub(crate) fn build(
        sun: &SunProvider,
        moon: &MoonProvider,
        jd_mid: f64,
        t_lo: f64,
        t_hi: f64,
    ) -> Result<SolarElements, EphemerisError> {
        let ts = nodes(NODES, t_lo, t_hi);
        let mut cols: [Vec<f64>; 8] = Default::default();
        let mut prev_mu: Option<f64> = None;
        for &t in &ts {
            let jd = jd_mid + t / 24.0;
            let e = elements_from(&sun.position(jd)?, &moon.position(jd)?);
            // Unwrap mu (it grows by about 15 degrees an hour).
            let mut mu = e.mu;
            if let Some(p) = prev_mu {
                let tau = std::f64::consts::TAU;
                mu = p + (mu - p + std::f64::consts::PI).rem_euclid(tau) - std::f64::consts::PI;
            }
            prev_mu = Some(mu);
            for (col, v) in cols
                .iter_mut()
                .zip([e.x, e.y, e.d, mu, e.l1, e.l2, e.tan_f1, e.tan_f2])
            {
                col.push(v);
            }
        }
        let fit = |v: &Vec<f64>| Cheb::fit(v, t_lo, t_hi);
        Ok(SolarElements {
            jd_mid,
            t_lo,
            t_hi,
            x: fit(&cols[0]),
            y: fit(&cols[1]),
            d: fit(&cols[2]),
            mu: fit(&cols[3]),
            l1: fit(&cols[4]),
            l2: fit(&cols[5]),
            tan_f1: fit(&cols[6]),
            tan_f2: fit(&cols[7]),
        })
    }

    pub(crate) fn jd(&self, t: f64) -> f64 {
        self.jd_mid + t / 24.0
    }

    pub(crate) fn at(&self, t: f64) -> Elements {
        Elements {
            x: self.x.eval(t),
            y: self.y.eval(t),
            d: self.d.eval(t),
            mu: self.mu.eval(t),
            l1: self.l1.eval(t),
            l2: self.l2.eval(t),
            tan_f1: self.tan_f1.eval(t),
            tan_f2: self.tan_f2.eval(t),
        }
    }

    pub(crate) fn rates(&self, t: f64) -> Rates {
        Rates {
            x: self.x.d1(t),
            y: self.y.d1(t),
            d: self.d.d1(t),
            mu: self.mu.d1(t),
            l1: self.l1.d1(t),
            l2: self.l2.d1(t),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_matches_the_ephemeris() {
        // 2024-04-08, around greatest eclipse (18:17 UT), a 12-hour window.
        let (sun, moon) = (SunProvider::new(), MoonProvider::new());
        let jd_mid = 2_460_409.262;
        let el = SolarElements::build(&sun, &moon, jd_mid, -6.0, 6.0).unwrap();
        let (mut worst_xy, mut worst_ang, mut worst_l) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..=96 {
            let t = -6.0 + 12.0 * f64::from(i) / 96.0;
            let jd = jd_mid + t / 24.0;
            let direct = elements_from(&sun.position(jd).unwrap(), &moon.position(jd).unwrap());
            let e = el.at(t);
            worst_xy = worst_xy
                .max((e.x - direct.x).abs())
                .max((e.y - direct.y).abs());
            let dmu = (e.mu - direct.mu + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU)
                - std::f64::consts::PI;
            worst_ang = worst_ang.max((e.d - direct.d).abs()).max(dmu.abs());
            worst_l = worst_l
                .max((e.l1 - direct.l1).abs())
                .max((e.l2 - direct.l2).abs());
        }
        // The floor is the direct evaluation itself: an f64 Julian date resolves about
        // 40 microseconds, in which the axis moves 6e-9 Earth radii and turns 3e-9 rad.
        // 7 to 13 nodes all reach it; 2e-8 Earth radii is 13 cm, 1e-8 rad is 0.002".
        assert!(worst_xy < 2e-8, "x, y interpolation error {worst_xy:e}");
        assert!(
            worst_ang < 1e-8,
            "d, mu interpolation error {worst_ang:e} rad"
        );
        assert!(worst_l < 1e-10, "l1, l2 interpolation error {worst_l:e}");
    }

    /// NASA's polynomial Besselian elements (`fixtures/reference/eclipses_nasa_paths.json`,
    /// six eclipses, 2017-2026) against ours at the same Dynamical Time, across each
    /// table's six-hour validity window. NASA's `mu` is the ephemeris hour angle, ahead
    /// of the Greenwich hour angle by `1.00273781 * 15 deg/h * Delta-T`; ours is
    /// computed with the page's Delta-T (through DUT1) and converted.
    #[test]
    fn elements_match_nasas_polynomials() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/reference/eclipses_nasa_paths.json");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let deg_per_s = 1.002_737_811_911_354_5 * 360.0 / 86_400.0;
        let poly = |c: &serde_json::Value, t: f64| {
            c.as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(n, a)| a.as_f64().unwrap() * t.powi(n as i32))
                .sum::<f64>()
        };
        let mut worst = [0.0f64; 5];
        let mut n = 0;
        for e in v["eclipses"].as_array().unwrap() {
            let mut worst_xy = 0.0f64;
            let b = &e["besselian"];
            let dt = b["delta_t_s"].as_f64().unwrap();
            let (sun, moon) = (
                SunProvider::with_dut1_s(69.184 - dt),
                MoonProvider::with_dut1_s(69.184 - dt),
            );
            // Most pages use our k1 = 0.272488; the 2017 page used 0.272508. The radius
            // enters l1 and l2 as `k sec f`, so compare at the page's own values.
            let (k1, k2) = (b["k1"].as_f64().unwrap(), b["k2"].as_f64().unwrap());
            let c = &b["coefficients"];
            for step in -6..=6 {
                let t = 0.5 * f64::from(step);
                let jd_tt = b["jd_tdt_t0"].as_f64().unwrap() + t / 24.0;
                // Every table here is after 2017-01-01: TT - UTC = 69.184 s.
                let jd_utc = jd_tt - 69.184 / 86_400.0;
                let ours = elements_from(
                    &sun.position(jd_utc).unwrap(),
                    &moon.position(jd_utc).unwrap(),
                );
                let mu_eph = ours.mu.to_degrees() + deg_per_s * dt;
                let dmu = (mu_eph - poly(&c["mu"], t) + 540.0).rem_euclid(360.0) - 180.0;
                let errs = [
                    (ours.x - poly(&c["x"], t))
                        .abs()
                        .max((ours.y - poly(&c["y"], t)).abs()),
                    (ours.d.to_degrees() - poly(&c["d"], t)).abs(),
                    dmu.abs(),
                    (ours.l1 + (k1 - K_PENUMBRA) * ours.tan_f1.hypot(1.0) - poly(&c["l1"], t))
                        .abs()
                        .max(
                            (ours.l2 - (k2 - K_UMBRA) * ours.tan_f2.hypot(1.0) - poly(&c["l2"], t))
                                .abs(),
                        ),
                    (ours.tan_f1 - b["tan_f1"].as_f64().unwrap())
                        .abs()
                        .max((ours.tan_f2 - b["tan_f2"].as_f64().unwrap()).abs()),
                ];
                worst_xy = worst_xy.max(errs[0]);
                for (w, e) in worst.iter_mut().zip(errs) {
                    *w = w.max(e);
                }
                n += 1;
            }
            println!("{}: x, y within {worst_xy:.2e} Earth radii", e["id"]);
        }
        println!(
            "{n} instants: x, y {:.2e} Earth radii; d {:.2e} deg; mu {:.2e} deg; l1, l2 {:.2e}; tan f {:.1e}",
            worst[0], worst[1], worst[2], worst[3], worst[4]
        );
        // Measured: x, y 9.7e-5 Earth radii (620 m; the shadow covers that in 0.7 s),
        // d 2.5e-5 deg, mu 4.2e-5 deg, l1 and l2 1.5e-6, tan f 2.1e-7. NASA's lunar
        // theory is ELP-2000/85 where ours is ELP 2000-82B, and its tables are cubic
        // least-squares fits printed to six decimals.
        assert!(worst[0] < 1.2e-4, "x, y {}", worst[0]);
        assert!(
            worst[1] < 5e-5 && worst[2] < 1e-4,
            "d {} mu {}",
            worst[1],
            worst[2]
        );
        assert!(
            worst[3] < 5e-6 && worst[4] < 5e-7,
            "l {} tan f {}",
            worst[3],
            worst[4]
        );
    }

    #[test]
    fn frame_is_orthonormal_and_surface_points_lie_on_the_ellipsoid() {
        let f = Frame::new(0.3, 1.2);
        for (a, b, want) in [
            (f.x, f.x, 1.0),
            (f.y, f.y, 1.0),
            (f.z, f.z, 1.0),
            (f.x, f.y, 0.0),
            (f.x, f.z, 0.0),
            (f.y, f.z, 0.0),
        ] {
            assert!((dot(a, b) - want).abs() < 1e-15);
        }
        // x points east: at mu = 0 it is the direction of longitude 90 E.
        let f0 = Frame::new(0.0, 0.0);
        assert!((f0.x[1] - 1.0).abs() < 1e-15);
        let (p, zeta, disc) = f.surface_point(0.3, -0.4).unwrap();
        let ib2 = 1.0 / (B_OVER_A * B_OVER_A);
        assert!((p[0] * p[0] + p[1] * p[1] + p[2] * p[2] * ib2 - 1.0).abs() < 1e-14);
        assert!(zeta > 0.0 && disc > 0.0);
        let q = f.project(p);
        assert!((q[0] - 0.3).abs() < 1e-14 && (q[1] + 0.4).abs() < 1e-14);
        assert!(f.surface_point(0.9, 0.9).is_none());
        // The outline: on the x axis at 1, on the y axis at rho1.
        let rho1 = Frame::outline_rho1(0.3);
        assert!(f.surface_point(0.0, rho1 * (1.0 - 1e-12)).is_some());
        assert!(f.surface_point(0.0, rho1 * (1.0 + 1e-9)).is_none());
    }

    #[test]
    fn geodetic_conversion_inverts_the_site_position() {
        use skyfix_ephemeris::topocentric::Site;
        for (lat, lon) in [(39.95, -75.17), (-33.9, 151.2), (78.2, 15.6), (0.0, 180.0)] {
            let p = Site::new(lat, lon).position_km().map(|v| v / WGS84_A_KM);
            let (la, lo) = geodetic_of_surface_point(p);
            assert!((la - lat).abs() < 1e-12, "{la} {lat}");
            let dl = (lo - lon + 540.0).rem_euclid(360.0) - 180.0;
            assert!(dl.abs() < 1e-12, "{lo} {lon}");
        }
    }
}
