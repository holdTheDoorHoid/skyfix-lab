//! `StarProvider`: apparent geocentric GHA/Dec for the navigational stars, any date.
//!
//! OWNER: ephemeris agent.
//!
//! This is an offline, any-date provider, not a fixture pack. It computes the apparent
//! place of date from the embedded Hipparcos-derived catalogue
//! ([`crate::catalog`]) through the IAU 2006/2000B reduction in [`crate::frames`], and
//! the Greenwich hour angle from the sidereal time in [`crate::sidereal`]:
//!
//! ```text
//! GHA = GAST - RA(apparent, of date),  normalised to [0, 360), west-positive
//! Dec = declination of date
//! SHA = 360 - RA(apparent, of date)    (CONVENTIONS section 2)
//! ```
//!
//! Semidiameter and horizontal parallax are exactly zero: a star is a point source at
//! effectively infinite distance for altitude-correction purposes. Annual parallax is
//! not the same thing — it is a *direction* correction and is already inside the
//! apparent place (up to 0.74" for Rigil Kentaurus).
//!
//! ## Space motion (expansion programme)
//!
//! Each star moves from its catalogue place at J1991.25 by rigorous rectilinear space
//! motion with its SIMBAD radial velocity ([`crate::frames::space_motion`]: the
//! perspective acceleration is included), and **Rigil Kentaurus** (alpha Centauri A,
//! the body the Nautical Almanac tabulates) follows its orbit about the A-B barycentre
//! (USNO Sixth Orbit Catalog elements; [`crate::catalog::StarEntry::barycentric_direction`]).
//! USNO's celnav and the Almanac extrapolate A's Hipparcos place linearly, which is
//! exactly this model at J1991.25 and leaves A's real path by 5.8" in 2026 and 17" in
//! 2060: that is the one place this provider and the printed Almanac differ by more
//! than a few hundredths of an arcsecond (`docs/ACCURACY.md`, "Rigil Kentaurus").
//!
//! ## Tiers
//!
//! [`StarProvider::new`] answers the validated tier (1550-2650); with
//! [`TierPolicy::WithLabelled`] it answers 2000 BC to AD 3000, where the precession is
//! the long-term model (CONVENTIONS 15.1).
//!
//! ## Error budget (arcminutes, against a rigorous reference)
//!
//! | term | size | note |
//! |---|---|---|
//! | DUT1 assumed 0 | up to 0.23' | `|DUT1| < 0.9 s`; supply it with [`StarProvider::with_dut1`] |
//! | model chain (space motion, nutation, aberration, parallax, deflection) | 0.00027' measured | see below |
//! | catalogue position, proper-motion and radial-velocity error | ~0.001' in 1990-2060 | Hipparcos formal errors, SIMBAD's RV errors |
//! | Rigil Kentaurus's barycentric proper motion | 1-2" by 2060, ~10" at the tier edges | published values differ by 15-30 mas/yr |
//!
//! The model row is measured, not asserted: the reduction reproduces ERFA's
//! `eraAtci13` worked example — which uses IAU 2000A nutation, the `eraEpv00` Earth
//! ephemeris and radial velocity, none of which this crate has — to 0.016" (0.00027'),
//! and Meeus's example 23.a to 0.073". Those two checks live in
//! `tests/apparent_place_reference.rs` and print their residuals.
//!
//! [`crate::Coverage::accuracy_arcmin`] reports **0.02'**, the worst case over the
//! whole coverage window (the Rigil Kentaurus proper-motion term at 2060 plus
//! catalogue error), not the 0.0003' measured mid-window: a provider should quote the
//! bound it can defend everywhere, not its best epoch. The DUT1 term is excluded from
//! that figure because it is a *time* assumption the caller can remove, and it is
//! called out separately in the coverage notes exactly as CONVENTIONS section 6
//! requires. The Skyfield reference fixture, once it lands, is what can tighten or
//! refute this number (`tests/reference_fixtures.rs`).

use std::cell::Cell;

use skyfix_core::time::{jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::norm_360;

use crate::catalog::{self, StarEntry};
use crate::frames::{
    EarthState, apply_annual_aberration, apply_annual_parallax, apply_solar_light_deflection,
    bias_precession_nutation_matrix, earth_state_of_date, radec_from_vector,
};
use crate::sidereal::{gast_deg, gha_aries_deg};
use crate::tiers::{self, CoverageTier, TierPolicy};
use crate::{AstroProvider, Coverage, EphemerisError};

/// Provider name, used in errors and in `ReducedSight::direction_source`.
pub const PROVIDER_NAME: &str = "skyfix-stars (IAU 2006/2000B, Hipparcos)";

/// First instant [`StarProvider::new`] answers: the validated tier's start.
pub const COVERAGE_START_UTC: &str = tiers::VALIDATED_START_UTC;
/// Last instant [`StarProvider::new`] answers: the validated tier's end.
pub const COVERAGE_END_UTC: &str = tiers::VALIDATED_END_UTC;

/// Documented worst-case error of GHA (DUT1 = 0) and Dec over the validated tier,
/// arcminutes (Rigil Kentaurus's barycentric-motion caveat is in the notes).
pub const STAR_ACCURACY_ARCMIN: f64 = 0.02;
/// The same over the labelled tier (catalogue errors carried over millennia), rounded
/// up; Rigil Kentaurus is labelled separately in the notes.
pub const STAR_LABELLED_ACCURACY_ARCMIN: f64 = 0.1;

/// Apparent geocentric directions for the 57 Nautical Almanac navigational stars plus
/// Polaris, over the validated tier (and the labelled one with
/// [`TierPolicy::WithLabelled`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StarProvider {
    /// `UT1 - UTC`, seconds. Zero unless the caller knows better.
    dut1_s: f64,
    policy: TierPolicy,
}

impl Default for StarProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl StarProvider {
    /// A provider that assumes `DUT1 = 0`, the same approximation a user of the
    /// printed almanac makes. Worth up to 0.23' of GHA.
    pub const fn new() -> Self {
        StarProvider {
            dut1_s: 0.0,
            policy: TierPolicy::ValidatedOnly,
        }
    }

    /// A provider using a known `UT1 - UTC` in seconds (IERS Bulletin A/D).
    pub const fn with_dut1(dut1_s: f64) -> Self {
        StarProvider {
            dut1_s,
            policy: TierPolicy::ValidatedOnly,
        }
    }

    /// The same provider answering the tiers `policy` allows.
    pub const fn with_policy(self, policy: TierPolicy) -> Self {
        StarProvider {
            dut1_s: self.dut1_s,
            policy,
        }
    }

    pub const fn policy(&self) -> TierPolicy {
        self.policy
    }

    /// The `UT1 - UTC` this provider is using, seconds.
    pub const fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    /// Every body name this provider answers to, in catalogue order.
    pub fn bodies(&self) -> Vec<&'static str> {
        catalog::names()
    }

    fn resolve(&self, body: &str) -> Result<&'static StarEntry, EphemerisError> {
        if let Some(e) = catalog::load_error_as_ephemeris_error(PROVIDER_NAME) {
            return Err(e);
        }
        catalog::find(body)
            .ok_or_else(|| EphemerisError::UnknownBody(body.to_string(), PROVIDER_NAME.to_string()))
    }

    fn check_coverage(&self, jd_utc: f64) -> Result<(), EphemerisError> {
        // A NaN compares false with both ends, so the policy refuses it on its own, as
        // the Sun, Moon and planet providers do.
        self.policy.check(PROVIDER_NAME, jd_utc).map(|_| ())
    }

    /// [`AstroProvider::geocentric`] with the time scales given: `jd_tt` for the
    /// apparent place, `jd_ut1` for the hour angle (the historical fixtures build both
    /// from one Delta T). Refused outside the labelled tier's span in TT.
    pub fn geocentric_at(
        &self,
        body: &str,
        jd_tt_v: f64,
        jd_ut1_v: f64,
    ) -> Result<GeocentricDirection, EphemerisError> {
        crate::planets::check_model_span(PROVIDER_NAME, jd_tt_v)?;
        let s = self.resolve(body)?;
        let (ra, dec) = StarFrame::cached(jd_tt_v).apparent_radec_deg(s);
        let gast = cached_gast_deg(jd_ut1_v, jd_tt_v);
        Ok(GeocentricDirection {
            gha_deg: norm_360(gast - ra),
            dec_deg: dec,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        })
    }

    /// Apparent right ascension and declination of date, degrees. RA is `[0, 360)`.
    pub fn apparent_radec_deg(
        &self,
        body: &str,
        jd_utc: f64,
    ) -> Result<(f64, f64), EphemerisError> {
        self.check_coverage(jd_utc)?;
        let s = self.resolve(body)?;
        Ok(StarFrame::cached(jd_tt(jd_utc)).apparent_radec_deg(s))
    }

    /// Sidereal hour angle of date, degrees in `[0, 360)`.
    ///
    /// `SHA = 360 - RA`, so that `GHA_star = GHA_Aries + SHA` (CONVENTIONS section 2).
    /// This is the column the Nautical Almanac prints for the stars; it is offered for
    /// display, while [`AstroProvider::geocentric`] gives the GHA the solver uses.
    pub fn sha_deg(&self, body: &str, jd_utc: f64) -> Result<f64, EphemerisError> {
        let (ra, _) = self.apparent_radec_deg(body, jd_utc)?;
        Ok(norm_360(360.0 - ra))
    }

    /// GHA of Aries at this instant with the provider's DUT1, degrees in `[0, 360)`.
    pub fn gha_aries_deg(&self, jd_utc: f64) -> f64 {
        gha_aries_deg(jd_utc, self.dut1_s)
    }

    /// Visual magnitude from the catalogue, for the observation planner and the UI.
    pub fn magnitude(&self, body: &str) -> Result<f64, EphemerisError> {
        Ok(self.resolve(body)?.magnitude)
    }
}

// ---------------------------------------------------------------------------
// Shared frame quantities: computed once per instant, reused for every star
// ---------------------------------------------------------------------------

/// The frame quantities every star shares at one instant: the bias-precession-nutation
/// matrix and the Earth's heliocentric position and velocity, both in the true equator
/// and equinox of date.
///
/// Building them is most of the cost of an apparent place (two IAU 2000B nutation
/// series and the Fukushima-Williams angles); applying them to one star is a handful of
/// multiplications. [`StarFrame::apparent_radec_deg`] applies exactly the chain of
/// [`crate::frames::apparent_radec_of_date`], in the same order and with the same
/// arithmetic, so its result is **bit-for-bit identical** to that function's
/// (`tests/star_frame_batch.rs` asserts it for every star at many instants).
///
/// [`StarProvider`] keeps the frame of the most recent instant it was asked about (one
/// per thread), so a caller that evaluates the whole catalogue at one instant — the
/// explorer's `sky_state`, the observation planner — builds the frame once instead of
/// 58 times without doing anything special. A caller that wants the saving explicitly,
/// or across interleaved instants, can hold a `StarFrame` itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StarFrame {
    /// The Terrestrial Time these quantities belong to, as a Julian date.
    pub jd_tt: f64,
    /// ICRS -> true equator and equinox of date
    /// ([`crate::frames::bias_precession_nutation_matrix`]).
    pub bpn: [[f64; 3]; 3],
    /// Earth's position and velocity of date ([`crate::frames::earth_state_of_date`]).
    pub earth: EarthState,
}

thread_local! {
    /// The frame of the last instant any `StarProvider` on this thread was asked about.
    static LAST_FRAME: Cell<Option<StarFrame>> = const { Cell::new(None) };
    /// `(jd_ut1 bits, jd_tt bits, GAST degrees)` of the last `geocentric` call.
    static LAST_GAST: Cell<Option<(u64, u64, f64)>> = const { Cell::new(None) };
}

impl StarFrame {
    /// Build the frame for `jd_tt` (Terrestrial Time, Julian date).
    pub fn at(jd_tt: f64) -> Self {
        StarFrame {
            jd_tt,
            bpn: bias_precession_nutation_matrix(jd_tt),
            earth: earth_state_of_date(jd_tt),
        }
    }

    /// The frame for `jd_tt`, reusing this thread's most recent one when it is for the
    /// same instant (compared bit for bit, so there is no tolerance to reason about).
    pub fn cached(jd_tt: f64) -> Self {
        LAST_FRAME.with(|cell| {
            // No let-chains: the workspace's MSRV (1.85) predates them.
            if let Some(f) = cell.get() {
                if f.jd_tt.to_bits() == jd_tt.to_bits() {
                    return f;
                }
            }
            let f = StarFrame::at(jd_tt);
            cell.set(Some(f));
            f
        })
    }

    /// Apparent right ascension `[0, 360)` and declination of date, degrees, of a
    /// catalogue star at this frame's instant. Identical, bit for bit, to
    /// [`apparent_radec_of_star`] for the same star and `jd_tt`.
    pub fn apparent_radec_deg(&self, s: &StarEntry) -> (f64, f64) {
        // The same chain, in the same order, as `frames::apparent_radec_from_barycentric`.
        let p = s.barycentric_direction(self.jd_tt);
        let m = &self.bpn;
        let p = [
            m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
            m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
            m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
        ];
        let p = apply_annual_parallax(p, s.parallax_mas, self.earth.pos_au);
        let p = apply_solar_light_deflection(p, self.earth.pos_au);
        let p = apply_annual_aberration(p, self.earth.vel_c);
        radec_from_vector(p)
    }
}

/// Apparent right ascension `[0, 360)` and declination of date, degrees, of a
/// catalogue star at `jd_tt`, without the per-instant frame cache: the star's
/// barycentric direction ([`StarEntry::barycentric_direction`]: space motion with the
/// radial velocity, and the orbit for Rigil Kentaurus) through
/// [`crate::frames::apparent_radec_from_barycentric`].
pub fn apparent_radec_of_star(s: &StarEntry, jd_tt: f64) -> (f64, f64) {
    crate::frames::apparent_radec_from_barycentric(
        s.barycentric_direction(jd_tt),
        s.parallax_mas,
        jd_tt,
    )
}

/// [`gast_deg`] for `(jd_ut1, jd_tt)`, reusing this thread's previous answer when both
/// arguments are bit-for-bit the same.
fn cached_gast_deg(jd_ut1_val: f64, jd_tt_val: f64) -> f64 {
    let key = (jd_ut1_val.to_bits(), jd_tt_val.to_bits());
    LAST_GAST.with(|cell| {
        if let Some((a, b, g)) = cell.get() {
            if (a, b) == key {
                return g;
            }
        }
        let g = gast_deg(jd_ut1_val, jd_tt_val);
        cell.set(Some((key.0, key.1, g)));
        g
    })
}

impl AstroProvider for StarProvider {
    fn name(&self) -> &str {
        PROVIDER_NAME
    }

    fn coverage(&self) -> Coverage {
        let p = catalog::provenance();
        let mut notes = String::new();
        notes.push_str(
            "Apparent geocentric place of date (CONVENTIONS section 7): rigorous space \
             motion from the Hipparcos catalogue at J1991.25 with SIMBAD's radial \
             velocities (perspective acceleration included), frame bias and precession \
             (IAU 2006 in the validated tier 1550-2650, Vondrak, Capitaine & Wallace 2011 \
             outside), IAU 2000B nutation (77 luni-solar terms, full fundamental \
             arguments), annual aberration by relativistic vector aberration from a \
             Keplerian Earth velocity, annual parallax, and gravitational light \
             deflection by the Sun. GHA = GAST - RA. ",
        );
        notes.push_str(
            "Rigil Kentaurus is alpha Centauri A, the body the Nautical Almanac tabulates, \
             and here it follows A's orbit about the A-B barycentre (USNO Sixth Orbit \
             Catalog, Akeson et al. 2021) instead of extrapolating A's 1991 proper motion \
             in a straight line as the Almanac and USNO's celnav do: the two differ by \
             5.8\" in 2026 and 17\" in 2060. A sextant sees the A+B light centre, about 2\" \
             from A in 2026; the barycentre's own proper motion is uncertain by 15-30 \
             mas/yr (1-2\" by 2060, about 10\" at the tier edges). Not modelled: diurnal \
             aberration and topocentric parallax, which are altitude corrections rather \
             than direction corrections (CONVENTIONS section 5). Measured agreement with \
             ERFA's eraAtci13 worked example: 0.016\" (0.0003'). ",
        );
        if self.dut1_s == 0.0 {
            notes.push_str(
                "DUT1 is assumed to be 0, which is worth up to 0.23' of GHA \
                 (|UT1 - UTC| < 0.9 s). The printed almanac's users make the same \
                 assumption; supply a value with StarProvider::with_dut1 to remove it. \
                 This term is NOT included in accuracy_arcmin. ",
            );
        } else {
            notes.push_str(&format!(
                "DUT1 = {} s supplied by the caller. ",
                self.dut1_s
            ));
        }
        notes.push_str(&format!(
            "Catalogue: {} (retrieved {}; {}); positions used at epoch {}.",
            if p.source.is_empty() {
                "unrecorded"
            } else {
                &p.source
            },
            if p.retrieved.is_empty() {
                "unrecorded"
            } else {
                &p.retrieved
            },
            if p.license.is_empty() {
                "licence unrecorded"
            } else {
                &p.license
            },
            p.epoch
        ));
        if p.provisional {
            notes.push_str(
                " PROVISIONAL catalogue file: awaiting the authoritative \
                 Skyfield-generated fixture.",
            );
        }
        if let Some(e) = catalog::load_error() {
            notes.push_str(&format!(" CATALOGUE FAILED TO LOAD: {e}"));
        }

        Coverage {
            start_utc: self.policy.start_utc().to_string(),
            end_utc: self.policy.end_utc().to_string(),
            bodies: catalog::names().into_iter().map(str::to_string).collect(),
            notes,
            // Everything except the DUT1 assumption, which the notes call out and the
            // caller can remove. See the module-level error budget.
            accuracy_arcmin: STAR_ACCURACY_ARCMIN,
        }
    }

    fn tiers(&self) -> Vec<CoverageTier> {
        tiers::coverage_tiers(
            self.policy,
            STAR_ACCURACY_ARCMIN,
            STAR_LABELLED_ACCURACY_ARCMIN,
            "outside the validated tier: space motion and catalogue errors carried over \
             millennia (Rigil Kentaurus about 2' at 2000 BC from its barycentric proper \
             motion); the long-term precession; every time shown carries the Delta T \
             uncertainty; display only, not offered for sights",
        )
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        let (ra, dec) = self.apparent_radec_deg(body, jd_utc)?;
        let gast = cached_gast_deg(jd_ut1(jd_utc, self.dut1_s), jd_tt(jd_utc));
        Ok(GeocentricDirection {
            gha_deg: norm_360(gast - ra),
            dec_deg: dec,
            // A star has no disc and no measurable diurnal parallax.
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        })
    }
}

/// The GHA of Aries and Polaris from this crate (DUT1 = 0, CONVENTIONS section 6), for
/// the Nautical Almanac's a0, a1 and a2 teaching terms that
/// `skyfix_core::methods::polaris::polaris_latitude` reports beside every Polaris
/// latitude (docs/NAVIGATION_METHODS.md section 3.4). The core computes no sidereal time
/// of its own, so its callers pass this. The terms are display only: the Polaris
/// latitude itself uses the caller's direction source.
///
/// Shared by the WASM `polaris_latitude` export and `skyfix polaris`, so the teaching
/// terms are the same number in the browser and on the command line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EphemerisPolarisTable;

impl skyfix_core::methods::polaris::PolarisTableSource for EphemerisPolarisTable {
    fn gha_aries_deg(&self, jd_utc: f64) -> f64 {
        gha_aries_deg(jd_utc, 0.0)
    }

    fn polaris(&self, jd_utc: f64) -> Result<GeocentricDirection, String> {
        StarProvider::new()
            .geocentric("Polaris", jd_utc)
            .map_err(|e| e.to_string())
    }
}
