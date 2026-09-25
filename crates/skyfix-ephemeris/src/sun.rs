//! OWNER: ephemeris agent; the expansion programme's deeptime agent rebuilt the model
//! chain on the planets' Earth. See lib.rs.
//!
//! Apparent geocentric place of the Sun, offline, from 2000 BC to AD 3000 in two tiers
//! (CONVENTIONS 15.1): validated 1550-2650, labelled outside it.
//!
//! # Model chain
//!
//! 1. **Earth, heliocentric** — VSOP87A (rectangular, dynamical ecliptic and equinox
//!    J2000, argument TT) with this project's corrections fitted to JPL DE440 inside the
//!    validated tier and DE441 outside, from [`crate::series`]: **the same Earth the
//!    planet provider uses** ([`crate::planets::earth_heliocentric_state`]). Until the
//!    expansion programme the Sun had its own VSOP87D series (spherical, ecliptic of
//!    date); keeping one Earth removes 1 454 duplicated terms and, more important, puts
//!    the Sun on the same precession as everything else outside 1550-2650, where
//!    VSOP87D's built-in precession of date would differ from the long-term model by
//!    arcseconds. Equatorial J2000 axes through the catalogue's rotation, as for the
//!    planets.
//! 2. **Geocentric** — the Sun is at the origin of the heliocentric frame, so its
//!    geometric geocentric vector is `-E`. Working heliocentrically needs no light-time:
//!    the Sun's barycentric motion enters light-time and aberration with opposite signs
//!    and cancels to first order (under 0.01", as for the planets).
//! 3. **Aberration** — relativistic vector aberration
//!    ([`crate::frames::apply_annual_aberration`]) with the Earth's heliocentric
//!    velocity: this *is* the Sun's classical `-20.49"/R` in longitude, with the
//!    Earth's orbital eccentricity and the second-order terms included.
//! 4. **Frame bias, precession and nutation** —
//!    [`crate::frames::bias_precession_nutation_matrix`]: IAU 2006 with IAU 2000B in the
//!    validated tier, the Vondrak-Capitaine-Wallace long-term precession outside it.
//!    RA and Dec of date follow; the apparent ecliptic longitude and latitude are the
//!    same vector rotated by the true obliquity.
//! 5. **GHA** — `GAST - RA` with [`crate::sidereal::gast_deg`], normalised to `[0, 360)`.
//!
//! Steps 4 and 5 are the *shared* frame model: the Sun, the Moon, the planets and the
//! navigational stars are reduced with the same matrix and the same sidereal time.
//!
//! Semidiameter `959.63" / R` and horizontal parallax `8.794" / R`, both reported in
//! arcminutes as CONVENTIONS section 5 steps 4 and 5 require.
//!
//! # Accuracy
//!
//! **Measured against the independent reference.** `tests/reference_fixtures_sun.rs`
//! compares this provider with `fixtures/reference/geocentric_sun_stars.json` (Skyfield
//! with JPL DE421/DE440s) at 58 epochs spanning 1995-2055 plus an hourly run through
//! 2026-10-01, and `tests/deeptime_reference.rs` with `fixtures/reference/deeptime_*`
//! (Skyfield with DE440 per half-century of 1550-2650, DE441 per century outside). The
//! published figure is [`SUN_ACCURACY_ARCMIN`]; `docs/ACCURACY.md` has the tables.
//!
//! **GHA additionally carries the DUT1 = 0 assumption** (CONVENTIONS section 6):
//! |DUT1| < 0.9 s is up to 13.5" = 0.23' of GHA, two orders above the model error and
//! the dominant term in this provider's budget. It is in the error budget, not hidden;
//! a caller who knows DUT1 can supply it with [`SunProvider::with_dut1_s`], and the
//! fixture test checks that path too.
//!
//! # Time scales
//!
//! VSOP87's argument is dynamical time, which the catalogue notice states may be taken
//! as TT; `skyfix_core::time::jd_tt` supplies it. TDB - TT < 2 ms, i.e. < 0.0001" of
//! solar motion, and is ignored. [`SunProvider::position_at`] takes TT and UT1 directly,
//! so a caller with its own Delta T (the historical fixtures) can keep Delta T out of
//! the comparison.

use skyfix_core::time::{centuries_since_j2000, jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::{norm_180, norm_360};

use crate::frames::{
    apply_annual_aberration, bias_precession_nutation_matrix, radec_from_vector, true_obliquity_rad,
};
use crate::planets::{C_AU_PER_DAY, earth_heliocentric_state};
use crate::tiers::{self, CoverageTier, TierPolicy};
use crate::{AstroProvider, Coverage, EphemerisError};

// ---------------------------------------------------------------------------
// Coverage and physical constants
// ---------------------------------------------------------------------------

/// First instant [`SunProvider::new`] answers: the validated tier's start,
/// 1550-01-01T00:00:00Z. The labelled tier starts at [`tiers::LABELLED_START_UTC`].
pub const JD_COVERAGE_START: f64 = tiers::JD_VALIDATED_START;
/// Last instant [`SunProvider::new`] answers: the validated tier's end,
/// 2650-01-22T00:00:00Z.
pub const JD_COVERAGE_END: f64 = tiers::JD_VALIDATED_END;
pub const COVERAGE_START_UTC: &str = tiers::VALIDATED_START_UTC;
pub const COVERAGE_END_UTC: &str = tiers::VALIDATED_END_UTC;

/// Solar semidiameter at one astronomical unit, arcseconds (IAU / Astronomical Almanac).
pub const SUN_SEMIDIAMETER_UNIT_ARCSEC: f64 = 959.63;
/// Solar equatorial horizontal parallax at one astronomical unit, arcseconds.
pub const SUN_PARALLAX_UNIT_ARCSEC: f64 = 8.794;
/// The classical constant of solar aberration, `20.4898" / R` in longitude. Kept for
/// callers and documentation; the provider applies the vector form (step 3), which
/// reduces to this with the eccentricity terms added.
pub const SUN_ABERRATION_ARCSEC: f64 = 20.4898;

/// Documented worst-case error of GHA (DUT1 = 0) and Dec over the validated tier,
/// arcminutes, against JPL DE440 (the historical fixtures) and DE440s/DE421 (the
/// 1995-2055 fixtures), rounded up. Excludes the DUT1 = 0 assumption.
pub const SUN_ACCURACY_ARCMIN: f64 = 0.01;
/// The same over the labelled tier against DE441, rounded up.
pub const SUN_LABELLED_ACCURACY_ARCMIN: f64 = 0.02;

const ARCSEC_PER_DEG: f64 = 3600.0;

// ---------------------------------------------------------------------------
// The Sun
// ---------------------------------------------------------------------------

/// Apparent geocentric place of the Sun and everything used to build it.
///
/// Angles are degrees unless the field name says otherwise, per CONVENTIONS section 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SunPosition {
    pub jd_utc: f64,
    pub jd_tt: f64,
    pub jd_ut1: f64,
    /// Apparent geocentric longitude, true equinox and ecliptic of date.
    pub apparent_longitude_deg: f64,
    /// Apparent geocentric latitude (under an arcsecond for the Sun).
    pub apparent_latitude_deg: f64,
    /// Earth-Sun distance, astronomical units.
    pub radius_au: f64,
    /// Apparent right ascension, true equator and equinox of date, `[0, 360)`.
    pub ra_deg: f64,
    /// Apparent declination, north positive.
    pub dec_deg: f64,
    /// Greenwich apparent sidereal time used for the hour angle, `[0, 360)`.
    pub gast_deg: f64,
    /// Greenwich hour angle, west positive, `[0, 360)`.
    pub gha_deg: f64,
    pub semidiameter_arcmin: f64,
    pub horizontal_parallax_arcmin: f64,
    pub nutation_longitude_arcsec: f64,
    pub nutation_obliquity_arcsec: f64,
    pub true_obliquity_deg: f64,
    /// Apparent solar time minus mean solar time, minutes.
    pub equation_of_time_min: f64,
}

impl SunPosition {
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

/// Offline Sun provider: the corrected VSOP87A Earth, the shared precession-nutation
/// matrix and sidereal time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SunProvider {
    dut1_s: f64,
    policy: TierPolicy,
}

impl Default for SunProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SunProvider {
    /// The name this provider reports, e.g. for the CLI's "direction from:" line.
    pub const NAME: &'static str = "SunProvider";

    /// DUT1 = 0, the CONVENTIONS section 6 default; the validated tier only.
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    /// Supply a known DUT1 = UT1 - UTC in seconds, removing the 0.23' GHA term.
    pub fn with_dut1_s(dut1_s: f64) -> Self {
        SunProvider {
            dut1_s,
            policy: TierPolicy::ValidatedOnly,
        }
    }

    /// The same provider answering the tiers `policy` allows.
    pub fn with_policy(self, policy: TierPolicy) -> Self {
        SunProvider { policy, ..self }
    }

    pub fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    pub fn policy(&self) -> TierPolicy {
        self.policy
    }

    /// Full apparent place of the Sun at `jd_utc`.
    pub fn position(&self, jd_utc: f64) -> Result<SunPosition, EphemerisError> {
        self.policy.check(Self::NAME, jd_utc)?;
        self.position_at(jd_utc, jd_tt(jd_utc), jd_ut1(jd_utc, self.dut1_s))
    }

    /// [`SunProvider::position`] with the time scales given: `jd_tt` for the position,
    /// `jd_ut1` for the hour angle; `jd_utc` is only echoed. Refused outside the
    /// labelled tier's span in TT.
    pub fn position_at(
        &self,
        jd_utc: f64,
        jd_tt_v: f64,
        jd_ut1_v: f64,
    ) -> Result<SunPosition, EphemerisError> {
        crate::planets::check_model_span(Self::NAME, jd_tt_v)?;

        // 1-3. The Earth, the geocentric Sun and its aberration, equatorial J2000 axes.
        let (earth, earth_vel) = earth_heliocentric_state(jd_tt_v)?;
        let r_au = (earth[0] * earth[0] + earth[1] * earth[1] + earth[2] * earth[2]).sqrt();
        let geometric = [-earth[0] / r_au, -earth[1] / r_au, -earth[2] / r_au];
        let v_c = earth_vel.map(|v| v / C_AU_PER_DAY);
        let apparent = apply_annual_aberration(geometric, v_c);

        // 4. True equator and equinox of date.
        let m = bias_precession_nutation_matrix(jd_tt_v);
        let q = [
            m[0][0] * apparent[0] + m[0][1] * apparent[1] + m[0][2] * apparent[2],
            m[1][0] * apparent[0] + m[1][1] * apparent[1] + m[1][2] * apparent[2],
            m[2][0] * apparent[0] + m[2][1] * apparent[1] + m[2][2] * apparent[2],
        ];
        let (ra_deg, dec_deg) = radec_from_vector(q);

        // Apparent ecliptic coordinates of date: the same vector, true obliquity.
        let eps = true_obliquity_rad(jd_tt_v);
        let (se, ce) = eps.sin_cos();
        let ye = q[1] * ce + q[2] * se;
        let ze = -q[1] * se + q[2] * ce;
        let apparent_longitude_deg = norm_360(ye.atan2(q[0]).to_degrees());
        let apparent_latitude_deg = ze.clamp(-1.0, 1.0).asin().to_degrees();
        let nut = crate::frames::nutation_2000b_p03(jd_tt_v);
        let dpsi_as = nut.dpsi_rad / skyfix_core::units::ARCSEC;
        let deps_as = nut.deps_rad / skyfix_core::units::ARCSEC;
        let true_obliquity_deg = eps.to_degrees();

        // 5. Hour angle, from the same sidereal time the other providers use.
        let gast_deg = crate::sidereal::gast_deg(jd_ut1_v, jd_tt_v);
        let gha_deg = norm_360(gast_deg - ra_deg);

        // Equation of time (Meeus 28.1) from the Sun's mean longitude. This route
        // never touches sidereal time, so comparing it with `gha_deg` is an
        // independent check of the whole hour-angle chain (see
        // `tests/sun_equation_of_time.rs`); the two definitions of "the mean sun" differ
        // by a steady few hundredths of a second of time (see the note on
        // `equation_of_time_min` below).
        let tau = centuries_since_j2000(jd_tt_v) / 10.0;
        let mean_longitude_deg = 280.466_456_7
            + tau
                * (360_007.698_277_9
                    + tau
                        * (0.030_320_28
                            + tau
                                * (1.0 / 49_931.0 + tau * (-1.0 / 15_300.0 + tau / -2_000_000.0))));
        let eot_deg = norm_180(
            mean_longitude_deg - 0.005_718_3 - ra_deg
                + dpsi_as * true_obliquity_deg.to_radians().cos() / ARCSEC_PER_DEG,
        );

        Ok(SunPosition {
            jd_utc,
            jd_tt: jd_tt_v,
            jd_ut1: jd_ut1_v,
            apparent_longitude_deg,
            apparent_latitude_deg,
            radius_au: r_au,
            ra_deg,
            dec_deg,
            gast_deg,
            gha_deg,
            semidiameter_arcmin: SUN_SEMIDIAMETER_UNIT_ARCSEC / 60.0 / r_au,
            horizontal_parallax_arcmin: SUN_PARALLAX_UNIT_ARCSEC / 60.0 / r_au,
            nutation_longitude_arcsec: dpsi_as,
            nutation_obliquity_arcsec: deps_as,
            true_obliquity_deg,
            equation_of_time_min: eot_deg * 4.0,
        })
    }
}

impl AstroProvider for SunProvider {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn coverage(&self) -> Coverage {
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
            bodies: vec!["Sun".to_string()],
            notes: format!(
                "Apparent geocentric Sun from the Earth of VSOP87A (CDS VI/81, Bretagnon & \
                 Francou 1988) with corrections fitted by this project to JPL DE440 inside \
                 1550-2650 and DE441 outside, the same Earth the planet provider uses, \
                 truncated to 0.05\" of the Sun's direction; relativistic vector aberration \
                 with the Earth's velocity (the -20.49\"/R of aberration); precession IAU \
                 2006 in the validated tier and Vondrak, Capitaine & Wallace 2011 outside, \
                 IAU 2000B nutation (full fundamental arguments) and GAST: the shared frame \
                 model in skyfix_ephemeris::frames and ::sidereal. Semidiameter 959.63\"/R \
                 and horizontal parallax 8.794\"/R. {dut1}. Verified against Skyfield with \
                 JPL DE440 over 1550-2650 and DE421/DE440s at 58 epochs 1995-2055: worst \
                 GHA or Dec under {SUN_ACCURACY_ARCMIN}'."
            ),
            // The model alone, rounded up from the measured worst case. The DUT1 term
            // above is reported separately because it is an input assumption, not a
            // model error, and a caller can remove it.
            accuracy_arcmin: SUN_ACCURACY_ARCMIN,
        }
    }

    fn tiers(&self) -> Vec<CoverageTier> {
        tiers::coverage_tiers(
            self.policy,
            SUN_ACCURACY_ARCMIN,
            SUN_LABELLED_ACCURACY_ARCMIN,
            tiers::LABELLED_NOTE,
        )
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        // `is_sun` trims, exactly as `catalog::find` does for a star name, so `"Sun "`
        // and `" sun"` resolve here as well as they do everywhere else in the project.
        if !skyfix_core::reduce::is_sun(body) {
            return Err(EphemerisError::UnknownBody(
                body.to_string(),
                Self::NAME.to_string(),
            ));
        }
        Ok(self.position(jd_utc)?.direction())
    }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/// Equation of time (apparent solar time minus mean solar time) in minutes, DUT1 = 0.
///
/// Positive means the sundial is ahead of the clock. Ranges from about -14.2 min in
/// mid-February to +16.4 min in early November.
///
/// Computed by Meeus (28.1) from the Sun's mean longitude, which is a route through
/// the ephemeris that never touches sidereal time. **It is therefore not identical to
/// `gha_deg / 15 + 12 h - UT1`**: those two definitions of "the mean sun" differ by a
/// steady few hundredths of a second of time across 1990-2060, varying by under
/// 0.00001 min within any one year. `tests/sun_equation_of_time.rs` pins that offset;
/// it is below the resolution at which the equation of time is displayed, and it does
/// not touch `gha_deg` or `dec_deg`.
pub fn equation_of_time_min(jd_utc: f64) -> Result<f64, EphemerisError> {
    Ok(SunProvider::new().position(jd_utc)?.equation_of_time_min)
}

/// Apparent geocentric declination of the Sun in degrees, north positive, DUT1 = 0.
pub fn declination_deg(jd_utc: f64) -> Result<f64, EphemerisError> {
    Ok(SunProvider::new().position(jd_utc)?.dec_deg)
}

// ---------------------------------------------------------------------------
// Unit tests that need access to the private model internals.
// Behavioural tests live in `tests/sun_*.rs`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use skyfix_core::time::{civil_to_jd, parse_utc};

    /// Nutation in longitude and obliquity, arcseconds, from the shared frame model.
    fn nutation_arcsec(jd_tt: f64) -> (f64, f64) {
        let n = crate::frames::nutation_2000b_p03(jd_tt);
        (
            n.dpsi_rad / skyfix_core::units::ARCSEC,
            n.deps_rad / skyfix_core::units::ARCSEC,
        )
    }

    /// Meeus, *Astronomical Algorithms*, Example 22.a: 1987 April 10 at 0h TD gives
    /// `dpsi = -3".788`, `deps = +9".443`, mean obliquity `23d 26' 27".407`.
    ///
    /// Meeus uses IAU 1980 nutation; `crate::frames` supplies IAU 2000B, which differs
    /// from it by a few hundredths of an arcsecond, and IAU 2006 mean obliquity, which
    /// differs from Meeus's Laskar expression by about 0.04". The tolerances below are
    /// those model differences, not slack: an error in any of the large nutation terms
    /// would be tens of arcseconds.
    #[test]
    fn nutation_and_obliquity_match_meeus_22a() {
        let jd_tt = civil_to_jd(1987, 4, 10);
        let (dpsi, deps) = nutation_arcsec(jd_tt);
        assert_relative_eq!(dpsi, -3.788, epsilon = 0.02);
        assert_relative_eq!(deps, 9.443, epsilon = 0.02);

        let eps0 = crate::frames::mean_obliquity_rad(jd_tt).to_degrees();
        let expected = 23.0 + 26.0 / 60.0 + 27.407 / 3600.0;
        assert_relative_eq!(eps0, expected, epsilon = 0.05 / 3600.0);

        // Meeus's true obliquity for the same instant, 23d 26' 36".850.
        let eps = crate::frames::true_obliquity_rad(jd_tt).to_degrees();
        assert_relative_eq!(
            eps,
            23.0 + 26.0 / 60.0 + 36.850 / 3600.0,
            epsilon = 0.05 / 3600.0
        );
    }

    #[test]
    fn nutation_stays_inside_its_physical_envelope() {
        // The 18.6-year principal term is 17.2"; nothing should exceed ~17.3"/9.3".
        let (mut max_p, mut max_e) = (0.0f64, 0.0f64);
        let start = parse_utc("1990-01-01T00:00:00Z").unwrap();
        for i in 0..(71 * 365) {
            let (p, e) = nutation_arcsec(jd_tt(start + f64::from(i)));
            max_p = max_p.max(p.abs());
            max_e = max_e.max(e.abs());
        }
        // These are the coherent sums of the leading terms, not the 17.2"/9.2"
        // amplitude of the 18.6-year term alone: the semi-annual (1.317"/0.573"),
        // 2-Omega (0.207"/0.090") and 2F-2D+2Omega (0.228"/0.098") terms add to it,
        // so the envelope of the total is near 18.9" and 10.0".
        assert!(
            (18.5..19.3).contains(&max_p),
            "max |dpsi| = {max_p}\", expected ~18.9\""
        );
        assert!(
            (9.6..10.3).contains(&max_e),
            "max |deps| = {max_e}\", expected ~10.0\""
        );
    }

    /// The sidereal time the Sun uses must differ from GMST only by the equation of
    /// the equinoxes, which never exceeds about 1.15 s of time
    /// (max|dpsi| 18.93" x cos eps 0.9175 = 17.37", plus 2.6 mas of complementary
    /// terms). This is the Sun's view of `crate::sidereal`.
    #[test]
    fn gast_differs_from_gmst_only_by_the_equation_of_the_equinoxes() {
        let start = parse_utc("1990-01-01T00:00:00Z").unwrap();
        let mut max_ee_arcsec = 0.0f64;
        for i in 0..(71 * 52) {
            let jd = start + f64::from(i) * 7.0;
            let tt = jd_tt(jd);
            let ee =
                norm_180(crate::sidereal::gast_deg(jd, tt) - crate::sidereal::gmst_deg(jd, tt))
                    * ARCSEC_PER_DEG;
            max_ee_arcsec = max_ee_arcsec.max(ee.abs());
        }
        assert!(
            (17.0..17.6).contains(&max_ee_arcsec),
            "max |equation of the equinoxes| = {max_ee_arcsec}\", expected ~17.3\""
        );
    }

    /// The vector aberration is the classical `-20.4898"/R` in longitude to within the
    /// eccentricity terms the classical constant leaves out (about 0.34").
    #[test]
    fn aberration_is_the_classical_constant_to_first_order() {
        let jd_tt = 2_461_310.5;
        let (earth, vel) = earth_heliocentric_state(jd_tt).unwrap();
        let r = (earth[0].powi(2) + earth[1].powi(2) + earth[2].powi(2)).sqrt();
        let g = earth.map(|x| -x / r);
        let a = apply_annual_aberration(g, vel.map(|v| v / C_AU_PER_DAY));
        let shift = (1.0 - (g[0] * a[0] + g[1] * a[1] + g[2] * a[2]).powi(2))
            .sqrt()
            .asin()
            / skyfix_core::units::ARCSEC;
        assert!((shift - SUN_ABERRATION_ARCSEC / r).abs() < 0.4, "{shift}\"");
    }

    #[test]
    fn the_labelled_tier_is_answered_only_when_asked_for() {
        let jd = civil_to_jd(-500, 3, 21);
        assert!(matches!(
            SunProvider::new().position(jd),
            Err(EphemerisError::OutOfCoverage { .. })
        ));
        let p = SunProvider::new()
            .with_policy(TierPolicy::WithLabelled)
            .position(jd)
            .unwrap();
        // Near the March equinox of 501 BC (proleptic Gregorian; the Julian date is
        // three days later): the Sun's longitude is near 0 or 360 degrees.
        let l = p.apparent_longitude_deg;
        assert!(!(10.0..350.0).contains(&l), "{l}");
        assert!((0.98..1.02).contains(&p.radius_au), "{}", p.radius_au);
    }
}
