//! The Moon: apparent geocentric place, distance, parallax, semidiameter and phase.
//!
//! OWNER: Moon agent; the expansion programme's deeptime agent replaced the lunar
//! theory. CONVENTIONS sections 7, 13 and 15.
//!
//! # Model chain
//!
//! 1. **Lunar theory: ELP/MPP02** (Chapront & Francou 2003, A&A 404, 735), the
//!    successor of ELP 2000-82B from the same authors at Paris Observatory (SYRTE),
//!    with the constants the authors fitted to JPL DE405 (including their additive
//!    secular corrections, which keep it near DE406 over six millennia) and **additive
//!    corrections to the secular polynomials of W1, W2 and W3 fitted by this project to
//!    JPL DE441 (2000 BC to AD 3000) and DE440 (1550-2650)**, the same kind of
//!    correction as the authors' own Table 6. The series are embedded in
//!    `../data/series.bin` ([`crate::series::ElpModel`]), truncated by amplitude for the
//!    validated tier and, with more terms, for the labelled one; the evaluation follows
//!    the authors' `ELPMPP02.for` (INITIAL, READFILE, EVALUATE): the main problem with
//!    corrected amplitudes, the perturbations with their Poisson factors `t..t^3`, the
//!    mean longitude W1, `a0(DE405)/a0(ELP)` on the distance, and Laskar's `P`, `Q`
//!    rotation to the **inertial mean ecliptic and equinox of J2000**. The main
//!    problem's time derivative is summed in the same pass and gives the geocentric
//!    velocity for step 3.
//!
//!    Why not ELP 2000-82B any more: it was fitted to DE200/LE200, whose tidal
//!    acceleration differs from today's, and drifts from DE440 as
//!    `0.12 + 0.39 t + 0.96 t^2` arcseconds (18" in 1550, 43" in 2650, 25' at 2000 BC).
//!    ELP/MPP02 with the refitted secular terms stays within 0.4" of DE440 over
//!    1550-2650 and 2" of DE441 back to 2000 BC (`docs/ACCURACY.md`, "Historical
//!    accuracy"), and its DE405-fitted tidal acceleration (-25.858"/cy^2) is the one the
//!    Delta T model of Stephenson, Morrison & Hohenkerk assumes.
//! 2. **To the ICRS** with the note's Table 7 (the position of the J2000 ecliptic in
//!    the frame of the DE405 fit): `R3(-phi) R1(-epsilon)`, `epsilon = 23 26' 21.40960"`,
//!    `phi = -0.05028"`. Measured against DE440 the constant part of the longitude
//!    difference is under 0.01".
//! 3. **Light-time, not annual aberration.** What Skyfield's
//!    `earth.at(t).observe(moon).apparent()` does — a light-time solution with
//!    *barycentric* positions, then aberration with the Earth's barycentric velocity —
//!    reduces for the Moon to the **geocentric position at the retarded time**
//!    `t - tau`, `tau = r / c ~ 1.28 s`: the Earth's motion during `tau` (`-v tau`) and the
//!    aberration (`+v tau`) cancel to about 1 mas. So the Moon gets no 20" annual
//!    aberration; it gets its own motion over 1.28 s, about 0.7", applied here as
//!    `p - tau p'` with `p'` from step 1 (the neglected `tau^2 p'' / 2` is 2e-6 km).
//!    Gravitational deflection of moonlight by the Sun is below 0.01 mas and ignored.
//! 4. **Precession and nutation of date** with the shared matrix
//!    [`crate::frames::bias_precession_nutation_matrix`] (IAU 2006/2000B in the
//!    validated tier, the Vondrak-Capitaine-Wallace long-term precession outside),
//!    giving the apparent RA and Dec of date (CONVENTIONS section 7).
//! 5. **GHA** `= GAST - RA` with [`crate::sidereal::gast_deg`] and the provider's
//!    DUT1 (0 unless supplied), exactly as the Sun and the stars do.
//!
//! The time argument of ELP is TDB; TT is used (`TDB - TT` is under 2 ms, 0.001" of
//! lunar motion).
//!
//! # Physical quantities
//!
//! - `distance_km`: geometric geocentric distance at the instant (the light-time
//!   distance differs by at most 0.1 km).
//! - Horizontal parallax `HP = asin(a / d)` with `a = 6378.14 km`, the IAU 1976
//!   equatorial radius the ELP theories use (the WGS84 6378.137 km would change HP by
//!   0.002").
//! - Semidiameter `SD = asin(k a / d)` with `k = 0.2725076`, the IAU 1982 ratio of the
//!   lunar to the terrestrial equatorial radius used by the Explanatory Supplement and
//!   the NASA eclipse canons (the Moon's mean radius, 1738.09 km). The alternative
//!   0.272493 changes SD by 0.05".
//! - Elongation: the angle between the apparent directions of the Moon and the Sun
//!   (the Sun from [`SunProvider`]). Phase angle `i` (Sun-Moon-Earth) from Meeus,
//!   *Astronomical Algorithms*, eq. 48.3, `tan i = R sin psi / (Delta - R cos psi)`;
//!   illuminated fraction `(1 + cos i) / 2` (CONVENTIONS 13.5).
//! - Bright-limb position angle `chi`, from celestial north through east, Meeus eq. 48.5:
//!   `tan chi = cos dec_S sin(ra_S - ra) / (sin dec_S cos dec - cos dec_S sin dec cos(ra_S - ra))`.
//! - Magnitude: **approximate**. The classical phase law
//!   `V = -12.73 + 0.026 |i| + 4e-9 i^4` (i in degrees) of Krisciunas & Schaefer
//!   (1991, PASP 103, 1033), after Allen, scaled by the inverse-square law to the
//!   actual Earth-Moon (mean 384 400 km) and Sun-Moon (1 au) distances. Good to one or
//!   two tenths of a magnitude away from new moon; it ignores the opposition surge
//!   within a few degrees of full moon and knows nothing about lunar eclipses.
//!
//! # Accuracy
//!
//! Measured against Skyfield with JPL DE440s (DE421 as a cross-check) at the epochs
//! of `fixtures/reference/moon_geocentric.json` by `tests/moon_reference.rs`, and with
//! DE440 and DE441 per half-century and per century by `tests/deeptime_reference.rs`;
//! the numbers are in `docs/ACCURACY.md`, "Moon" and "Historical accuracy".
//!
//! # Tiers
//!
//! [`MoonProvider::new`] answers the validated tier only (every navigation path);
//! [`MoonProvider::with_policy`] with [`TierPolicy::WithLabelled`] answers 2000 BC to
//! AD 3000 for display.

use skyfix_core::time::{JD_J2000, jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::{DEG, norm_360};

use crate::body::{AU_KM, ApparentState, BodyEphemeris, BodyKind, MOON};
use crate::frames::{bias_precession_nutation_matrix, radec_from_vector, true_obliquity_rad};
use crate::sidereal::gast_deg;
use crate::sun::SunProvider;
use crate::tiers::{self, CoverageTier, TierPolicy};
use crate::{AstroProvider, Coverage, EphemerisError};

// ---------------------------------------------------------------------------
// Coverage and physical constants
// ---------------------------------------------------------------------------

/// First instant [`MoonProvider::new`] answers: the validated tier's start.
pub const COVERAGE_START_UTC: &str = tiers::VALIDATED_START_UTC;
/// Last instant [`MoonProvider::new`] answers: the validated tier's end.
pub const COVERAGE_END_UTC: &str = tiers::VALIDATED_END_UTC;

/// Earth's equatorial radius used for the horizontal parallax, km (IAU 1976; the value
/// the ELP theories were built with).
pub const EARTH_EQUATORIAL_RADIUS_KM: f64 = 6378.14;
/// Ratio of the Moon's radius to the Earth's equatorial radius (IAU 1982).
pub const MOON_RADIUS_RATIO_K: f64 = 0.272_507_6;
/// Mean Earth-Moon distance the magnitude law refers to, km.
pub const MEAN_DISTANCE_KM: f64 = 384_400.0;

/// Speed of light, km/s (exact).
const C_KM_S: f64 = 299_792.458;
/// Seconds in a Julian century.
const SECONDS_PER_CENTURY: f64 = 36_525.0 * 86_400.0;

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

fn apply(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Angle between two vectors, radians, robust at 0 and 180 degrees.
fn angle_between(a: [f64; 3], b: [f64; 3]) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b))
}

/// Julian centuries of TDB (taken as TT) from J2000.
fn centuries(jd_tdb: f64) -> f64 {
    (jd_tdb - JD_J2000) / 36_525.0
}

/// Geometric geocentric position of the Moon (km, ICRS) from the embedded ELP/MPP02 at
/// `jd_tdb` (TT is fine): the validated-tier series inside 1550-2650, the longer
/// labelled-tier series outside. No coverage check beyond the series' own span.
pub fn elp_geocentric_icrs_km(jd_tdb: f64) -> Result<[f64; 3], EphemerisError> {
    crate::planets::check_model_span(MoonProvider::NAME, jd_tdb)?;
    let s = crate::series::series()?;
    let full = !tiers::validated_model_at_tt(jd_tdb);
    Ok(s.elp.state_icrs(centuries(jd_tdb), full).0)
}

// ---------------------------------------------------------------------------
// The Moon
// ---------------------------------------------------------------------------

/// Apparent geocentric place of the Moon and the quantities built with it.
///
/// Angles in degrees unless the field name says otherwise (CONVENTIONS section 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonPosition {
    pub jd_utc: f64,
    pub jd_tt: f64,
    pub jd_ut1: f64,
    /// Apparent right ascension, true equator and equinox of date, `[0, 360)`.
    pub ra_deg: f64,
    /// Apparent declination, north positive.
    pub dec_deg: f64,
    /// Greenwich apparent sidereal time used for the hour angle, `[0, 360)`.
    pub gast_deg: f64,
    /// Greenwich hour angle, west positive, `[0, 360)`.
    pub gha_deg: f64,
    /// Apparent ecliptic longitude, true ecliptic and equinox of date, `[0, 360)`.
    pub ecliptic_longitude_deg: f64,
    /// Apparent ecliptic latitude, true ecliptic of date.
    pub ecliptic_latitude_deg: f64,
    /// Geometric geocentric distance at `jd`, km.
    pub distance_km: f64,
    /// Light time `distance / c`, seconds.
    pub light_time_s: f64,
    /// Apparent geocentric position vector, true equator and equinox of date, km.
    pub apparent_km: [f64; 3],
    /// `asin(6378.14 km / distance)`.
    pub horizontal_parallax_arcmin: f64,
    /// `asin(0.2725076 × 6378.14 km / distance)`.
    pub semidiameter_arcmin: f64,
}

impl MoonPosition {
    /// The direction in the shape the reducer and the session format use.
    pub fn direction(&self) -> GeocentricDirection {
        GeocentricDirection {
            gha_deg: self.gha_deg,
            dec_deg: self.dec_deg,
            semidiameter_arcmin: self.semidiameter_arcmin,
            horizontal_parallax_arcmin: self.horizontal_parallax_arcmin,
        }
    }
}

/// How the Moon is lit, from the Moon's and the Sun's apparent geocentric places.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonIllumination {
    /// Sun-Moon angle seen from the Earth, `[0, 180]`.
    pub elongation_deg: f64,
    /// Sun-Moon-Earth angle, `[0, 180]`.
    pub phase_angle_deg: f64,
    /// `(1 + cos i) / 2`.
    pub illuminated_fraction: f64,
    /// Position angle of the bright limb's midpoint, north through east, `[0, 360)`.
    pub bright_limb_angle_deg: f64,
    /// Approximate apparent visual magnitude (see the module documentation).
    pub magnitude: f64,
}

/// Illumination of a body at `distance_km` in apparent direction `(ra, dec)` by a Sun
/// at `(sun_ra, sun_dec)` and `sun_distance_km`, all apparent geocentric of date.
///
/// Meeus eq. 48.3 for the phase angle and eq. 48.5 for the bright limb; the magnitude
/// law is the Moon's (Krisciunas & Schaefer 1991).
pub fn illumination(
    ra_deg: f64,
    dec_deg: f64,
    distance_km: f64,
    sun_ra_deg: f64,
    sun_dec_deg: f64,
    sun_distance_km: f64,
) -> MoonIllumination {
    let u_moon = crate::frames::unit_vector_from_radec(ra_deg, dec_deg);
    let u_sun = crate::frames::unit_vector_from_radec(sun_ra_deg, sun_dec_deg);
    let psi = angle_between(u_moon, u_sun);
    let big_r = sun_distance_km;
    let i = (big_r * psi.sin()).atan2(distance_km - big_r * psi.cos());
    let (a, d) = (ra_deg * DEG, dec_deg * DEG);
    let (a0, d0) = (sun_ra_deg * DEG, sun_dec_deg * DEG);
    let chi =
        (d0.cos() * (a0 - a).sin()).atan2(d0.sin() * d.cos() - d0.cos() * d.sin() * (a0 - a).cos());
    let i_deg = i.to_degrees();
    // Sun-Moon distance for the inverse-square term.
    let sun_moon_km =
        (big_r * big_r + distance_km * distance_km - 2.0 * big_r * distance_km * psi.cos()).sqrt();
    let magnitude = -12.73
        + 0.026 * i_deg.abs()
        + 4.0e-9 * i_deg.powi(4)
        + 5.0 * ((distance_km / MEAN_DISTANCE_KM) * (sun_moon_km / AU_KM)).log10();
    MoonIllumination {
        elongation_deg: psi.to_degrees(),
        phase_angle_deg: i_deg,
        illuminated_fraction: (1.0 + i.cos()) / 2.0,
        bright_limb_angle_deg: norm_360(chi.to_degrees()),
        magnitude,
    }
}

/// Offline Moon provider: ELP/MPP02 with refitted secular terms + the shared frame
/// model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MoonProvider {
    dut1_s: f64,
    policy: TierPolicy,
}

impl Default for MoonProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MoonProvider {
    pub const NAME: &'static str = "skyfix-moon (ELP/MPP02, IAU 2006/2000B)";

    /// DUT1 = 0 (CONVENTIONS section 6), validated tier only.
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    /// Supply a known DUT1 = UT1 - UTC in seconds, removing up to 0.23' of GHA error.
    pub fn with_dut1_s(dut1_s: f64) -> Self {
        MoonProvider {
            dut1_s,
            policy: TierPolicy::ValidatedOnly,
        }
    }

    /// The same provider answering the tiers `policy` allows.
    pub fn with_policy(self, policy: TierPolicy) -> Self {
        MoonProvider { policy, ..self }
    }

    pub fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    pub fn policy(&self) -> TierPolicy {
        self.policy
    }

    fn check_body(&self, body: &str) -> Result<(), EphemerisError> {
        if body.trim().eq_ignore_ascii_case(MOON) {
            Ok(())
        } else {
            Err(EphemerisError::UnknownBody(
                body.to_string(),
                Self::NAME.to_string(),
            ))
        }
    }

    /// Full apparent place of the Moon at `jd_utc` (module docs, steps 1-5).
    pub fn position(&self, jd_utc: f64) -> Result<MoonPosition, EphemerisError> {
        self.policy.check(Self::NAME, jd_utc)?;
        self.position_at(jd_utc, jd_tt(jd_utc), jd_ut1(jd_utc, self.dut1_s))
    }

    /// [`MoonProvider::position`] with the time scales given: `jd_tt` for the position,
    /// `jd_ut1` for the hour angle; `jd_utc` is only echoed. Refused outside the
    /// labelled tier's span in TT.
    pub fn position_at(
        &self,
        jd_utc: f64,
        jd_tt_v: f64,
        jd_ut1_v: f64,
    ) -> Result<MoonPosition, EphemerisError> {
        crate::planets::check_model_span(Self::NAME, jd_tt_v)?;
        let s = crate::series::series()?;
        let full = !tiers::validated_model_at_tt(jd_tt_v);

        // 1-2. Geometric geocentric position and velocity, ICRS axes.
        let (p, v) = s.elp.state_icrs(centuries(jd_tt_v), full);
        let v = v.map(|x| x / SECONDS_PER_CENTURY);

        // 3. Light-time: the position the light left, `p(t - tau)`.
        let distance_km = norm(p);
        let tau = distance_km / C_KM_S;
        let p_app = [p[0] - tau * v[0], p[1] - tau * v[1], p[2] - tau * v[2]];

        // 4. True equator and equinox of date.
        let q = apply(&bias_precession_nutation_matrix(jd_tt_v), p_app);
        let (ra_deg, dec_deg) = radec_from_vector(q);

        // Apparent ecliptic coordinates of date (true obliquity), for phases.
        let (se, ce) = true_obliquity_rad(jd_tt_v).sin_cos();
        let ye = q[1] * ce + q[2] * se;
        let ze = -q[1] * se + q[2] * ce;
        let ecliptic_longitude_deg = norm_360(ye.atan2(q[0]).to_degrees());
        let ecliptic_latitude_deg = (ze / norm(q)).clamp(-1.0, 1.0).asin().to_degrees();

        // 5. Hour angle from the shared sidereal time.
        let gast = gast_deg(jd_ut1_v, jd_tt_v);
        let gha_deg = norm_360(gast - ra_deg);

        let sin_hp = EARTH_EQUATORIAL_RADIUS_KM / distance_km;
        Ok(MoonPosition {
            jd_utc,
            jd_tt: jd_tt_v,
            jd_ut1: jd_ut1_v,
            ra_deg,
            dec_deg,
            gast_deg: gast,
            gha_deg,
            ecliptic_longitude_deg,
            ecliptic_latitude_deg,
            distance_km,
            light_time_s: tau,
            apparent_km: q,
            horizontal_parallax_arcmin: sin_hp.asin().to_degrees() * 60.0,
            semidiameter_arcmin: (MOON_RADIUS_RATIO_K * sin_hp).asin().to_degrees() * 60.0,
        })
    }

    /// Elongation, phase, bright limb and magnitude at `jd_utc`, with the Sun from
    /// [`SunProvider`] (same DUT1 and tier policy; DUT1 does not matter here).
    pub fn illumination(&self, jd_utc: f64) -> Result<MoonIllumination, EphemerisError> {
        let moon = self.position(jd_utc)?;
        self.illumination_of(&moon)
    }

    fn illumination_of(&self, moon: &MoonPosition) -> Result<MoonIllumination, EphemerisError> {
        let sun = SunProvider::with_dut1_s(self.dut1_s)
            .with_policy(self.policy)
            .position_at(moon.jd_utc, moon.jd_tt, moon.jd_ut1)?;
        Ok(illumination(
            moon.ra_deg,
            moon.dec_deg,
            moon.distance_km,
            sun.ra_deg,
            sun.dec_deg,
            sun.radius_au * AU_KM,
        ))
    }
}

impl AstroProvider for MoonProvider {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn coverage(&self) -> Coverage {
        let (stored, validated) = match crate::series::series() {
            Ok(s) => s.elp.counts(),
            Err(_) => (0, 0),
        };
        let dut1 = if self.dut1_s == 0.0 {
            "DUT1 assumed 0 (CONVENTIONS section 6), which puts up to 0.23' of unmodelled \
             error into GHA and nothing into Dec"
                .to_string()
        } else {
            format!("DUT1 supplied as {:+.4} s", self.dut1_s)
        };
        Coverage {
            start_utc: self.policy.start_utc().to_string(),
            end_utc: self.policy.end_utc().to_string(),
            bodies: vec![MOON.to_string()],
            notes: format!(
                "Apparent geocentric Moon from ELP/MPP02 (Chapront & Francou 2003, Paris \
                 Observatory; constants fitted to DE405) with the secular terms of W1, W2 \
                 and W3 refitted by this project to JPL DE441 and DE440; {validated} terms \
                 for the validated tier (1550-2650), {stored} for the labelled one. \
                 Light-time applied as the Moon's own motion over r/c; no annual aberration \
                 (it cancels for a geocentric body). The shared precession (IAU 2006 in the \
                 validated tier, Vondrak, Capitaine & Wallace 2011 outside), IAU 2000B \
                 nutation and sidereal time. Horizontal parallax asin(6378.14 km / d); \
                 semidiameter with k = 0.2725076. Magnitude is an approximate phase law. \
                 {dut1}. Verified against Skyfield with JPL DE440 over 1550-2650 (and \
                 DE440s at {MOON_FIXTURE_EPOCHS} epochs over 1990-2060): worst GHA or Dec \
                 under {MOON_ACCURACY_ARCMIN}'."
            ),
            accuracy_arcmin: MOON_ACCURACY_ARCMIN,
        }
    }

    fn tiers(&self) -> Vec<CoverageTier> {
        tiers::coverage_tiers(
            self.policy,
            MOON_ACCURACY_ARCMIN,
            MOON_LABELLED_ACCURACY_ARCMIN,
            tiers::LABELLED_NOTE,
        )
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        self.check_body(body)?;
        Ok(self.position(jd_utc)?.direction())
    }
}

impl BodyEphemeris for MoonProvider {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        self.check_body(body)?;
        let p = self.position(jd_utc)?;
        let lit = self.illumination_of(&p)?;
        Ok(ApparentState {
            body: MOON.to_string(),
            kind: BodyKind::Moon,
            jd_utc,
            ra_deg: p.ra_deg,
            dec_deg: p.dec_deg,
            gha_deg: p.gha_deg,
            distance_km: Some(p.distance_km),
            semidiameter_arcmin: p.semidiameter_arcmin,
            horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
            magnitude: Some(lit.magnitude),
            phase_angle_deg: Some(lit.phase_angle_deg),
            illuminated_fraction: Some(lit.illuminated_fraction),
            elongation_deg: Some(lit.elongation_deg),
            bright_limb_angle_deg: Some(lit.bright_limb_angle_deg),
        })
    }
}

// ---------------------------------------------------------------------------
// The validated accuracy (tests/moon_reference.rs and tests/deeptime_reference.rs
// assert these against the fixtures)
// ---------------------------------------------------------------------------

/// Documented worst-case error of GHA (DUT1 = 0) and Dec over the validated tier
/// (1550-2650) against JPL DE440 (and DE440s over 1990-2060), arcminutes, rounded up.
/// Like the Sun and the stars, it excludes the DUT1 = 0 assumption, which the coverage
/// notes state separately and a caller can remove.
pub const MOON_ACCURACY_ARCMIN: f64 = 0.02;
/// The same over the labelled tier against DE441, rounded up.
pub const MOON_LABELLED_ACCURACY_ARCMIN: f64 = 0.05;
const MOON_FIXTURE_EPOCHS: usize = 1757;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_theory_reproduces_the_authors_check_values_in_shape() {
        // ELP/MPP02 note, Table 8 (DE405 fit): JD 2 500 000.5 (2132-09-01) geocentric
        // x 274 034.591 03, y 252 067.536 89, z -18 998.755 19 km on the J2000
        // ecliptic. The embedded series is truncated and carries this project's secular
        // corrections, so it matches to the truncation plus the correction there:
        // a few tenths of an arcsecond, well under 2 km at the Moon's distance.
        let s = crate::series::series().unwrap();
        let t = centuries(2_500_000.5);
        let (p, _) = s.elp.state_icrs(t, false);
        // Back to the ecliptic of the note with the inverse of Table 7's rotation:
        // x_ecl = R1(eps) R3(phi) x_icrs.
        let eps = (23.0 * 3600.0 + 26.0 * 60.0 + 21.409_60) * skyfix_core::units::ARCSEC;
        let phi = -0.050_28 * skyfix_core::units::ARCSEC;
        let (sp, cp) = phi.sin_cos();
        let a = [cp * p[0] - sp * p[1], sp * p[0] + cp * p[1], p[2]];
        let (se, ce) = eps.sin_cos();
        let x = [a[0], ce * a[1] + se * a[2], -se * a[1] + ce * a[2]];
        let want = [274_034.591_03, 252_067.536_89, -18_998.755_19];
        let d =
            ((x[0] - want[0]).powi(2) + (x[1] - want[1]).powi(2) + (x[2] - want[2]).powi(2)).sqrt();
        assert!(d < 2.0, "{x:?} is {d} km from the published value");
    }

    #[test]
    fn velocity_is_the_derivative_of_position() {
        let s = crate::series::series().unwrap();
        for jd in [2_461_314.5, 1_500_000.5, 2_780_000.5] {
            let full = !tiers::validated_model_at_tt(jd);
            let t = centuries(jd);
            let h = 1.0 / 36_525.0 / 1440.0; // one minute
            let (p0, v) = s.elp.state_icrs(t, full);
            let (pa, _) = s.elp.state_icrs(t - h, full);
            let (pb, _) = s.elp.state_icrs(t + h, full);
            for k in 0..3 {
                let fd = (pb[k] - pa[k]) / (2.0 * h);
                // The velocity leaves out the perturbation series (see `sums`).
                assert!(
                    (fd - v[k]).abs() < 1e-4 * norm(v),
                    "axis {k}: {fd} vs {} at {jd}",
                    v[k]
                );
            }
            // About 1 km/s.
            let speed = norm(v) / SECONDS_PER_CENTURY;
            assert!((0.9..1.15).contains(&speed), "{speed} km/s");
            assert!((356_000.0..407_000.0).contains(&norm(p0)));
        }
    }

    #[test]
    fn refuses_other_bodies_and_out_of_coverage() {
        let p = MoonProvider::new();
        assert!(matches!(
            p.geocentric("Sun", 2_461_314.5),
            Err(EphemerisError::UnknownBody(..))
        ));
        assert!(p.geocentric(" moon ", 2_461_314.5).is_ok());
        let (lo, hi) = (tiers::JD_VALIDATED_START, tiers::JD_VALIDATED_END);
        for jd in [lo - 1e-3, hi + 1e-3] {
            assert!(matches!(
                p.geocentric("Moon", jd),
                Err(EphemerisError::OutOfCoverage { .. })
            ));
        }
        assert!(matches!(
            p.geocentric("Moon", f64::NAN),
            Err(EphemerisError::Data(_))
        ));
        assert!(p.geocentric("Moon", lo).is_ok());
        assert!(p.geocentric("Moon", hi).is_ok());
        // The labelled tier, only when asked for, and nothing beyond it.
        let l = p.with_policy(TierPolicy::WithLabelled);
        for jd in [
            lo - 1e-3,
            hi + 1e-3,
            tiers::JD_LABELLED_START,
            tiers::JD_LABELLED_END,
        ] {
            assert!(l.geocentric("Moon", jd).is_ok(), "{jd}");
        }
        for jd in [
            tiers::JD_LABELLED_START - 1e-3,
            tiers::JD_LABELLED_END + 1e-3,
        ] {
            assert!(matches!(
                l.geocentric("Moon", jd),
                Err(EphemerisError::OutOfCoverage { .. })
            ));
        }
        assert_eq!(p.tiers().len(), 1);
        assert_eq!(l.tiers().len(), 2);
    }

    #[test]
    fn illumination_limits() {
        // Sun and Moon together: new moon, dark, bright limb toward the Sun.
        let new = illumination(10.0, 0.0, 384_400.0, 10.0, 1.0, AU_KM);
        assert!(new.illuminated_fraction < 0.001, "{new:?}");
        assert!((new.bright_limb_angle_deg - 0.0).abs() < 1e-6, "{new:?}");
        // Opposite: full.
        let full = illumination(190.0, 0.0, 384_400.0, 10.0, 0.0, AU_KM);
        assert!(full.illuminated_fraction > 0.999, "{full:?}");
        assert!((full.magnitude + 12.73).abs() < 0.02, "{full:?}");
        // Quadrature: half lit, Sun to the east (larger RA) gives a limb angle of 90.
        let quarter = illumination(100.0, 0.0, 384_400.0, 190.0, 0.0, AU_KM);
        assert!(
            (quarter.illuminated_fraction - 0.5).abs() < 0.003,
            "{quarter:?}"
        );
        assert!(
            (quarter.bright_limb_angle_deg - 90.0).abs() < 1e-6,
            "{quarter:?}"
        );
        assert!((quarter.elongation_deg - 90.0).abs() < 1e-9);
    }

    #[test]
    fn the_sky_registry_serves_the_moon_consistently() {
        use crate::body::Sky;
        let sky = Sky::new();
        let jd = 2_461_314.562_5; // 2026-10-01T01:30Z
        let st = sky.apparent_state(" moon", jd).unwrap();
        let dir = sky.geocentric("MOON", jd).unwrap();
        assert_eq!(st.body, "Moon");
        assert_eq!(st.kind, BodyKind::Moon);
        assert_eq!(st.gha_deg, dir.gha_deg);
        assert_eq!(st.dec_deg, dir.dec_deg);
        assert_eq!(st.semidiameter_arcmin, dir.semidiameter_arcmin);
        assert_eq!(
            st.horizontal_parallax_arcmin,
            dir.horizontal_parallax_arcmin
        );
        // SD / HP is k to first order; HP about a degree.
        let ratio = st.semidiameter_arcmin / st.horizontal_parallax_arcmin;
        assert!((ratio - MOON_RADIUS_RATIO_K).abs() < 1e-4, "{ratio}");
        assert!((53.0..62.0).contains(&st.horizontal_parallax_arcmin));
        // Waning gibbous that night (USNO: 77 % illuminated).
        let k = st.illuminated_fraction.unwrap();
        assert!((0.76..0.79).contains(&k), "{k}");
        assert!(st.magnitude.unwrap() < -11.0);
        let cov = sky
            .coverage_groups()
            .into_iter()
            .find(|c| c.bodies == ["Moon"])
            .unwrap();
        assert!(cov.accuracy_arcmin.is_finite() && cov.accuracy_arcmin <= 0.1);
    }

    #[test]
    fn gha_runs_at_the_lunar_rate_not_the_sidereal_one() {
        // CONVENTIONS 13.1: the clock term needs the Moon's own GHA rate, 15.04 deg/h
        // less the Moon's motion in RA (0.45 to 0.7 deg/h), never the sidereal rate.
        let p = MoonProvider::new();
        let start = 2_461_300.5;
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for i in 0..60 {
            let r = p
                .gha_rate_deg_per_hour("Moon", start + f64::from(i) * 0.5)
                .unwrap();
            lo = lo.min(r);
            hi = hi.max(r);
        }
        assert!(lo > 14.1 && hi < 14.9 && hi - lo > 0.1, "{lo}..{hi} deg/h");
    }

    #[test]
    fn dut1_moves_only_the_hour_angle() {
        let jd = 2_461_314.562_5;
        let a = MoonProvider::new().position(jd).unwrap();
        let b = MoonProvider::with_dut1_s(0.5).position(jd).unwrap();
        assert_eq!(a.ra_deg, b.ra_deg);
        assert_eq!(a.dec_deg, b.dec_deg);
        // 0.5 s of UT1 is 7.52" of Earth rotation.
        let d = (b.gha_deg - a.gha_deg) * 3600.0;
        assert!((d - 7.52).abs() < 0.01, "{d}");
        assert_eq!(MoonProvider::with_dut1_s(0.5).dut1_s(), 0.5);
    }
}
