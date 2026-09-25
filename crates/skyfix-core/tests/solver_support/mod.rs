//! Shared helpers for the `solver_*` integration tests.
//!
//! Sights are built straight from a truth position and a desired azimuth/altitude, using
//! only `geometry`, so these tests never touch `corrections`, `reduce` or `session` (whose
//! stubs belong to another agent) and never read a `Truth` file. `geometry` itself is
//! validated against independent fixtures elsewhere; [`check_sight`] asserts the
//! construction round-trips through `geometry::altitude` so a broken helper cannot quietly
//! agree with a broken solver.

#![allow(dead_code)]

use skyfix_core::geometry::{self, Point};
use skyfix_core::types::{Fix, FixResult, Sight, Warning};
use skyfix_core::units::{ARCMIN, SIDEREAL_RATE_DEG_PER_HOUR, arcmin_to_rad, norm_2pi, rad_to_m};

/// The `Fix` of a `unique` result, or a panic that says what came back instead.
pub fn unique(result: &FixResult) -> &Fix {
    match result {
        FixResult::Unique { fix, .. } => fix,
        other => panic!("expected a unique fix, got {other:#?}"),
    }
}

pub fn warnings_of(result: &FixResult) -> &[Warning] {
    match result {
        FixResult::Underdetermined { warnings, .. }
        | FixResult::Ambiguous { warnings, .. }
        | FixResult::Unique { warnings, .. }
        | FixResult::Failed { warnings, .. } => warnings,
    }
}

pub fn has_poor_geometry(result: &FixResult) -> bool {
    warnings_of(result)
        .iter()
        .any(|w| matches!(w, Warning::PoorGeometry { .. }))
}

/// GHA drift of a star, radians per second (CONVENTIONS section 6).
pub fn sidereal_rate_rad_per_s() -> f64 {
    SIDEREAL_RATE_DEG_PER_HOUR.to_radians() / 3600.0
}

pub const PHILADELPHIA: (f64, f64) = (39.9526, -75.1652);

pub fn philadelphia() -> Point {
    Point::from_deg(PHILADELPHIA.0, PHILADELPHIA.1)
}

/// A sight of a body that, from `truth`, sits at true azimuth `zn_deg` and altitude
/// `alt_deg`. The body's geographic position is placed by walking the zenith distance
/// along that bearing, which fixes the geometry exactly and makes azimuth spread a
/// directly controllable experiment variable.
pub fn sight_at(
    id: &str,
    body: &str,
    truth: Point,
    zn_deg: f64,
    alt_deg: f64,
    sigma_arcmin: f64,
) -> Sight {
    let zenith_distance = (90.0 - alt_deg).to_radians();
    let gp = geometry::destination(truth, zn_deg.to_radians(), zenith_distance);
    Sight {
        id: id.to_string(),
        body: body.to_string(),
        gha_rad: norm_2pi(-gp.lon),
        dec_rad: gp.lat,
        ho_rad: alt_deg.to_radians(),
        sigma_rad: arcmin_to_rad(sigma_arcmin),
        gha_rate_rad_per_s: sidereal_rate_rad_per_s(),
        moon_hp_arcmin: None,
    }
}

/// Assert that a constructed sight really is the altitude/azimuth it claims, computed by
/// the shared kernel rather than by the constructor.
pub fn check_sight(s: &Sight, truth: Point, zn_deg: f64, alt_deg: f64) {
    let (hc, zn) = geometry::altitude_azimuth(truth, s.gha_rad, s.dec_rad);
    assert!(
        (hc - alt_deg.to_radians()).abs() < 1e-12,
        "{}: Hc {} deg, wanted {alt_deg}",
        s.id,
        hc.to_degrees()
    );
    let dz = (zn.to_degrees() - zn_deg).rem_euclid(360.0);
    let dz = dz.min(360.0 - dz);
    assert!(
        dz < 1e-9,
        "{}: Zn {} deg, wanted {zn_deg}",
        s.id,
        zn.to_degrees()
    );
}

/// Add an altitude error, in arcminutes, to a sight's observed altitude.
pub fn with_error(mut s: Sight, arcmin: f64) -> Sight {
    s.ho_rad += arcmin * ARCMIN;
    s
}

/// Great-circle distance in metres.
pub fn distance_m(a: Point, b: Point) -> f64 {
    rad_to_m(geometry::angular_distance(a, b))
}

pub fn point_of(ll: skyfix_core::types::LatLon) -> Point {
    Point::from_deg(ll.lat_deg, ll.lon_deg)
}

/// Mahalanobis distance squared of the offset from `fix` to `truth`, using a covariance
/// expressed in tangent-plane metres (north, east) about the fix.
pub fn mahalanobis2(fix: Point, truth: Point, cov: [[f64; 2]; 2]) -> f64 {
    let (dn, de) = geometry::tangent_offset(fix, truth);
    let (dn, de) = (rad_to_m(dn), rad_to_m(de));
    let det = cov[0][0] * cov[1][1] - cov[0][1] * cov[1][0];
    if det <= 0.0 || !det.is_finite() {
        return f64::INFINITY;
    }
    let (i00, i01, i11) = (cov[1][1] / det, -cov[0][1] / det, cov[0][0] / det);
    dn * dn * i00 + 2.0 * dn * de * i01 + de * de * i11
}

/// Deterministic splitmix64: a self-contained generator so the Monte Carlo tests are
/// reproducible and the crate stays dependency-free.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in (0, 1).
    pub fn next_f64(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    /// Standard normal by the Box-Muller transform.
    pub fn next_normal(&mut self) -> f64 {
        let u1 = self.next_f64();
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
}
