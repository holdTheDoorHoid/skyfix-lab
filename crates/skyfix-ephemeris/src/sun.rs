//! OWNER: ephemeris agent. See lib.rs.
//!
//! Apparent geocentric place of the Sun, offline, for any instant in 1990-2060.
//!
//! # Model chain
//!
//! 1. **Earth, heliocentric** — VSOP87D (spherical L, B, R; mean dynamical ecliptic
//!    and equinox *of date*), truncated for this coverage window. Coefficients are
//!    embedded from `../data/vsop87_sun_terms.json`, generated from the CDS catalogue
//!    VI/81 file `VSOP87D.ear`; provenance and the truncation rule are recorded in that
//!    file and in `docs/THIRD_PARTY.md`.
//! 2. **Geocentric** — `theta = L + 180`, `beta = -B`.
//! 3. **VSOP87 dynamical frame -> FK5** — Meeus, *Astronomical Algorithms* (25.9):
//!    `-0.09033"` in longitude, `+0.03916" (cos L' - sin L')` in latitude.
//! 4. **Aberration / light-time** — `-20.4898" / R` in longitude (CONVENTIONS section 7
//!    requires the Sun's light-time to be included; this first-order form *is* that
//!    correction).
//! 5. **Nutation in longitude** — IAU 2000B (77 luni-solar terms plus the fixed
//!    planetary offset), giving the *apparent* longitude referred to the true equinox
//!    of date.
//! 6. **Obliquity** — IAU 2006 mean obliquity plus the IAU 2000B nutation in obliquity.
//! 7. **RA / Dec** — the usual ecliptic-to-equatorial rotation with the *true* obliquity.
//! 8. **GHA** — `GAST - RA`, normalised to `[0, 360)`.
//!
//! Semidiameter `959.63" / R` and horizontal parallax `8.794" / R`, both reported in
//! arcminutes as CONVENTIONS section 5 steps 4 and 5 require.
//!
//! # Accuracy
//!
//! Every term above is carried far past the 0.1' target. The residuals that matter:
//!
//! | source | bound |
//! |---|---|
//! | VSOP87D itself (Earth, `p0 = 0.6e-8`) | ~0.0012" |
//! | series truncation, measured over 1990-2060 | 0.0072" in L, 0.0135" in B |
//! | IAU 2000B nutation vs IAU 2000A | ~0.001" |
//! | FK5/ICRS frame residual after step 3 | ~0.02" |
//! | first-order aberration vs the rigorous form | ~0.02" |
//!
//! So RA and Dec are good to well under 0.1" ~= 0.002'. **GHA additionally carries the
//! DUT1 = 0 assumption** (CONVENTIONS section 6): |DUT1| < 0.9 s is up to 13.5" = 0.23'
//! of GHA. That term is in the error budget, not hidden, and a caller who knows DUT1
//! can supply it with [`SunProvider::with_dut1_s`].
//!
//! # Time scales
//!
//! VSOP87's argument is dynamical time, which the catalogue notice states may be taken
//! as TT; `skyfix_core::time::jd_tt` supplies it. TDB - TT < 2 ms, i.e. < 0.0001" of
//! solar motion, and is ignored.

use std::sync::OnceLock;

use serde::Deserialize;
use skyfix_core::time::{centuries_since_j2000, jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::{norm_180, norm_360};

use crate::{AstroProvider, Coverage, EphemerisError};

// ---------------------------------------------------------------------------
// Coverage and physical constants
// ---------------------------------------------------------------------------

/// First instant covered: 1990-01-01T00:00:00Z.
pub const JD_COVERAGE_START: f64 = 2_447_892.5;
/// Last instant covered: 2061-01-01T00:00:00Z (so the whole of 2060 is inside).
pub const JD_COVERAGE_END: f64 = 2_473_825.5;
pub const COVERAGE_START_UTC: &str = "1990-01-01T00:00:00Z";
pub const COVERAGE_END_UTC: &str = "2061-01-01T00:00:00Z";

/// Solar semidiameter at one astronomical unit, arcseconds (IAU / Astronomical Almanac).
pub const SUN_SEMIDIAMETER_UNIT_ARCSEC: f64 = 959.63;
/// Solar equatorial horizontal parallax at one astronomical unit, arcseconds.
pub const SUN_PARALLAX_UNIT_ARCSEC: f64 = 8.794;
/// Constant applied as `-SUN_ABERRATION_ARCSEC / R` to the geometric longitude.
pub const SUN_ABERRATION_ARCSEC: f64 = 20.4898;

const VSOP87_JSON: &str = include_str!("../data/vsop87_sun_terms.json");
const VSOP87_SCHEMA: &str = "skyfix.vsop87_trunc/1";

const ARCSEC_PER_DEG: f64 = 3600.0;
const TURNAS: f64 = 1_296_000.0;

// ---------------------------------------------------------------------------
// Embedded VSOP87D series
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Vsop87Data {
    schema: String,
    truncation: Vsop87Truncation,
    series: Vsop87Series,
    checkpoints: Vec<Vsop87Checkpoint>,
}

#[derive(Debug, Deserialize)]
struct Vsop87Truncation {
    measured_max_error_l_arcsec: f64,
    measured_max_error_b_arcsec: f64,
    measured_max_error_r_au: f64,
    terms_kept: usize,
    terms_total: usize,
}

/// `series.l[n]` is the `T**n` series; each term is `[A, B, C]` for `A cos(B + C tau)`.
#[derive(Debug, Deserialize)]
struct Vsop87Series {
    l: Vec<Vec<[f64; 3]>>,
    b: Vec<Vec<[f64; 3]>>,
    r: Vec<Vec<[f64; 3]>>,
}

#[derive(Debug, Deserialize)]
struct Vsop87Checkpoint {
    jd_tt: f64,
    l_rad: f64,
    b_rad: f64,
    r_au: f64,
    source: String,
}

static VSOP87: OnceLock<Result<Vsop87Data, String>> = OnceLock::new();

fn vsop87() -> Result<&'static Vsop87Data, EphemerisError> {
    let parsed = VSOP87.get_or_init(|| {
        let data: Vsop87Data =
            serde_json::from_str(VSOP87_JSON).map_err(|e| format!("malformed JSON: {e}"))?;
        if data.schema != VSOP87_SCHEMA {
            return Err(format!(
                "schema is {:?}, expected {VSOP87_SCHEMA:?}",
                data.schema
            ));
        }
        if data.series.l.is_empty() || data.series.b.is_empty() || data.series.r.is_empty() {
            return Err("series l, b and r must all be present".to_string());
        }
        Ok(data)
    });
    parsed
        .as_ref()
        .map_err(|e| EphemerisError::Data(format!("embedded VSOP87 data is unusable: {e}")))
}

/// Sum one `A cos(B + C tau)` series family, Horner in `tau` over the powers.
fn sum_series(powers: &[Vec<[f64; 3]>], tau: f64) -> f64 {
    let mut total = 0.0;
    for terms in powers.iter().rev() {
        let mut s = 0.0;
        for t in terms {
            s += t[0] * (t[1] + t[2] * tau).cos();
        }
        total = total * tau + s;
    }
    total
}

/// Earth's heliocentric longitude and latitude (radians) and radius vector (au) in the
/// VSOP87D frame — the mean dynamical ecliptic and equinox of date.
///
/// `jd_tt` is Terrestrial Time as a Julian date. No coverage check: callers that need
/// one use [`SunProvider::position`].
pub fn earth_heliocentric(jd_tt: f64) -> Result<(f64, f64, f64), EphemerisError> {
    let d = vsop87()?;
    let tau = (jd_tt - skyfix_core::time::JD_J2000) / 365_250.0;
    Ok((
        sum_series(&d.series.l, tau),
        sum_series(&d.series.b, tau),
        sum_series(&d.series.r, tau),
    ))
}

/// Re-evaluate the embedded series at the checkpoints shipped with the data file and
/// return the worst deviation as `(l_arcsec, b_arcsec, r_au)`.
///
/// The first checkpoint is the value published in the catalogue's own `vsop87.chk`, so
/// this also checks the series against a source outside this repository. The deviations
/// are the *truncation* error, bounded by the data file's `truncation` block; a value
/// far above that means the embedded file has been corrupted.
pub fn vsop87_self_check() -> Result<(f64, f64, f64), EphemerisError> {
    let d = vsop87()?;
    let mut worst = (0.0f64, 0.0f64, 0.0f64);
    for c in &d.checkpoints {
        let (l, b, r) = earth_heliocentric(c.jd_tt)?;
        if !l.is_finite() || !b.is_finite() || !r.is_finite() {
            return Err(EphemerisError::Data(format!(
                "VSOP87 evaluation is not finite at jd_tt {} ({})",
                c.jd_tt, c.source
            )));
        }
        worst.0 = worst
            .0
            .max((l - c.l_rad).abs() / skyfix_core::units::ARCSEC);
        worst.1 = worst
            .1
            .max((b - c.b_rad).abs() / skyfix_core::units::ARCSEC);
        worst.2 = worst.2.max((r - c.r_au).abs());
    }
    Ok(worst)
}

// ---------------------------------------------------------------------------
// Nutation (IAU 2000B) and obliquity (IAU 2006)
// ---------------------------------------------------------------------------

/// One luni-solar term of the IAU 2000B nutation series.
///
/// `n` holds the multipliers of the Delaunay arguments `l, l', F, D, Omega`. `ps`,
/// `pst`, `pc` are the longitude sine, `t`-sine and cosine coefficients and `ec`,
/// `ect`, `es` the obliquity cosine, `t`-cosine and sine coefficients, all in units of
/// 0.1 microarcsecond (and the same per Julian century for the `t` coefficients).
struct NutTerm {
    n: [i32; 5],
    ps: f64,
    pst: f64,
    pc: f64,
    ec: f64,
    ect: f64,
    es: f64,
}

/// IAU 2000B luni-solar nutation series (McCarthy & Luzum 2003; Luzum 2001), taken
/// verbatim from ERFA `eraNut00b` (`nut00b.c`), which is BSD-3-Clause and derived with
/// permission from IAU SOFA. See `docs/THIRD_PARTY.md`.
#[rustfmt::skip]
const NUT2000B: [NutTerm; 77] = [
    NutTerm { n: [ 0,  0,  0,  0,  1], ps: -172064161.0, pst: -174666.0, pc: 33386.0, ec: 92052331.0, ect: 9086.0, es: 15377.0 },
    NutTerm { n: [ 0,  0,  2, -2,  2], ps: -13170906.0, pst: -1675.0, pc: -13696.0, ec: 5730336.0, ect: -3015.0, es: -4587.0 },
    NutTerm { n: [ 0,  0,  2,  0,  2], ps: -2276413.0, pst: -234.0, pc: 2796.0, ec: 978459.0, ect: -485.0, es: 1374.0 },
    NutTerm { n: [ 0,  0,  0,  0,  2], ps: 2074554.0, pst: 207.0, pc: -698.0, ec: -897492.0, ect: 470.0, es: -291.0 },
    NutTerm { n: [ 0,  1,  0,  0,  0], ps: 1475877.0, pst: -3633.0, pc: 11817.0, ec: 73871.0, ect: -184.0, es: -1924.0 },
    NutTerm { n: [ 0,  1,  2, -2,  2], ps: -516821.0, pst: 1226.0, pc: -524.0, ec: 224386.0, ect: -677.0, es: -174.0 },
    NutTerm { n: [ 1,  0,  0,  0,  0], ps: 711159.0, pst: 73.0, pc: -872.0, ec: -6750.0, ect: 0.0, es: 358.0 },
    NutTerm { n: [ 0,  0,  2,  0,  1], ps: -387298.0, pst: -367.0, pc: 380.0, ec: 200728.0, ect: 18.0, es: 318.0 },
    NutTerm { n: [ 1,  0,  2,  0,  2], ps: -301461.0, pst: -36.0, pc: 816.0, ec: 129025.0, ect: -63.0, es: 367.0 },
    NutTerm { n: [ 0, -1,  2, -2,  2], ps: 215829.0, pst: -494.0, pc: 111.0, ec: -95929.0, ect: 299.0, es: 132.0 },
    NutTerm { n: [ 0,  0,  2, -2,  1], ps: 128227.0, pst: 137.0, pc: 181.0, ec: -68982.0, ect: -9.0, es: 39.0 },
    NutTerm { n: [-1,  0,  2,  0,  2], ps: 123457.0, pst: 11.0, pc: 19.0, ec: -53311.0, ect: 32.0, es: -4.0 },
    NutTerm { n: [-1,  0,  0,  2,  0], ps: 156994.0, pst: 10.0, pc: -168.0, ec: -1235.0, ect: 0.0, es: 82.0 },
    NutTerm { n: [ 1,  0,  0,  0,  1], ps: 63110.0, pst: 63.0, pc: 27.0, ec: -33228.0, ect: 0.0, es: -9.0 },
    NutTerm { n: [-1,  0,  0,  0,  1], ps: -57976.0, pst: -63.0, pc: -189.0, ec: 31429.0, ect: 0.0, es: -75.0 },
    NutTerm { n: [-1,  0,  2,  2,  2], ps: -59641.0, pst: -11.0, pc: 149.0, ec: 25543.0, ect: -11.0, es: 66.0 },
    NutTerm { n: [ 1,  0,  2,  0,  1], ps: -51613.0, pst: -42.0, pc: 129.0, ec: 26366.0, ect: 0.0, es: 78.0 },
    NutTerm { n: [-2,  0,  2,  0,  1], ps: 45893.0, pst: 50.0, pc: 31.0, ec: -24236.0, ect: -10.0, es: 20.0 },
    NutTerm { n: [ 0,  0,  0,  2,  0], ps: 63384.0, pst: 11.0, pc: -150.0, ec: -1220.0, ect: 0.0, es: 29.0 },
    NutTerm { n: [ 0,  0,  2,  2,  2], ps: -38571.0, pst: -1.0, pc: 158.0, ec: 16452.0, ect: -11.0, es: 68.0 },
    NutTerm { n: [ 0, -2,  2, -2,  2], ps: 32481.0, pst: 0.0, pc: 0.0, ec: -13870.0, ect: 0.0, es: 0.0 },
    NutTerm { n: [-2,  0,  0,  2,  0], ps: -47722.0, pst: 0.0, pc: -18.0, ec: 477.0, ect: 0.0, es: -25.0 },
    NutTerm { n: [ 2,  0,  2,  0,  2], ps: -31046.0, pst: -1.0, pc: 131.0, ec: 13238.0, ect: -11.0, es: 59.0 },
    NutTerm { n: [ 1,  0,  2, -2,  2], ps: 28593.0, pst: 0.0, pc: -1.0, ec: -12338.0, ect: 10.0, es: -3.0 },
    NutTerm { n: [-1,  0,  2,  0,  1], ps: 20441.0, pst: 21.0, pc: 10.0, ec: -10758.0, ect: 0.0, es: -3.0 },
    NutTerm { n: [ 2,  0,  0,  0,  0], ps: 29243.0, pst: 0.0, pc: -74.0, ec: -609.0, ect: 0.0, es: 13.0 },
    NutTerm { n: [ 0,  0,  2,  0,  0], ps: 25887.0, pst: 0.0, pc: -66.0, ec: -550.0, ect: 0.0, es: 11.0 },
    NutTerm { n: [ 0,  1,  0,  0,  1], ps: -14053.0, pst: -25.0, pc: 79.0, ec: 8551.0, ect: -2.0, es: -45.0 },
    NutTerm { n: [-1,  0,  0,  2,  1], ps: 15164.0, pst: 10.0, pc: 11.0, ec: -8001.0, ect: 0.0, es: -1.0 },
    NutTerm { n: [ 0,  2,  2, -2,  2], ps: -15794.0, pst: 72.0, pc: -16.0, ec: 6850.0, ect: -42.0, es: -5.0 },
    NutTerm { n: [ 0,  0, -2,  2,  0], ps: 21783.0, pst: 0.0, pc: 13.0, ec: -167.0, ect: 0.0, es: 13.0 },
    NutTerm { n: [ 1,  0,  0, -2,  1], ps: -12873.0, pst: -10.0, pc: -37.0, ec: 6953.0, ect: 0.0, es: -14.0 },
    NutTerm { n: [ 0, -1,  0,  0,  1], ps: -12654.0, pst: 11.0, pc: 63.0, ec: 6415.0, ect: 0.0, es: 26.0 },
    NutTerm { n: [-1,  0,  2,  2,  1], ps: -10204.0, pst: 0.0, pc: 25.0, ec: 5222.0, ect: 0.0, es: 15.0 },
    NutTerm { n: [ 0,  2,  0,  0,  0], ps: 16707.0, pst: -85.0, pc: -10.0, ec: 168.0, ect: -1.0, es: 10.0 },
    NutTerm { n: [ 1,  0,  2,  2,  2], ps: -7691.0, pst: 0.0, pc: 44.0, ec: 3268.0, ect: 0.0, es: 19.0 },
    NutTerm { n: [-2,  0,  2,  0,  0], ps: -11024.0, pst: 0.0, pc: -14.0, ec: 104.0, ect: 0.0, es: 2.0 },
    NutTerm { n: [ 0,  1,  2,  0,  2], ps: 7566.0, pst: -21.0, pc: -11.0, ec: -3250.0, ect: 0.0, es: -5.0 },
    NutTerm { n: [ 0,  0,  2,  2,  1], ps: -6637.0, pst: -11.0, pc: 25.0, ec: 3353.0, ect: 0.0, es: 14.0 },
    NutTerm { n: [ 0, -1,  2,  0,  2], ps: -7141.0, pst: 21.0, pc: 8.0, ec: 3070.0, ect: 0.0, es: 4.0 },
    NutTerm { n: [ 0,  0,  0,  2,  1], ps: -6302.0, pst: -11.0, pc: 2.0, ec: 3272.0, ect: 0.0, es: 4.0 },
    NutTerm { n: [ 1,  0,  2, -2,  1], ps: 5800.0, pst: 10.0, pc: 2.0, ec: -3045.0, ect: 0.0, es: -1.0 },
    NutTerm { n: [ 2,  0,  2, -2,  2], ps: 6443.0, pst: 0.0, pc: -7.0, ec: -2768.0, ect: 0.0, es: -4.0 },
    NutTerm { n: [-2,  0,  0,  2,  1], ps: -5774.0, pst: -11.0, pc: -15.0, ec: 3041.0, ect: 0.0, es: -5.0 },
    NutTerm { n: [ 2,  0,  2,  0,  1], ps: -5350.0, pst: 0.0, pc: 21.0, ec: 2695.0, ect: 0.0, es: 12.0 },
    NutTerm { n: [ 0, -1,  2, -2,  1], ps: -4752.0, pst: -11.0, pc: -3.0, ec: 2719.0, ect: 0.0, es: -3.0 },
    NutTerm { n: [ 0,  0,  0, -2,  1], ps: -4940.0, pst: -11.0, pc: -21.0, ec: 2720.0, ect: 0.0, es: -9.0 },
    NutTerm { n: [-1, -1,  0,  2,  0], ps: 7350.0, pst: 0.0, pc: -8.0, ec: -51.0, ect: 0.0, es: 4.0 },
    NutTerm { n: [ 2,  0,  0, -2,  1], ps: 4065.0, pst: 0.0, pc: 6.0, ec: -2206.0, ect: 0.0, es: 1.0 },
    NutTerm { n: [ 1,  0,  0,  2,  0], ps: 6579.0, pst: 0.0, pc: -24.0, ec: -199.0, ect: 0.0, es: 2.0 },
    NutTerm { n: [ 0,  1,  2, -2,  1], ps: 3579.0, pst: 0.0, pc: 5.0, ec: -1900.0, ect: 0.0, es: 1.0 },
    NutTerm { n: [ 1, -1,  0,  0,  0], ps: 4725.0, pst: 0.0, pc: -6.0, ec: -41.0, ect: 0.0, es: 3.0 },
    NutTerm { n: [-2,  0,  2,  0,  2], ps: -3075.0, pst: 0.0, pc: -2.0, ec: 1313.0, ect: 0.0, es: -1.0 },
    NutTerm { n: [ 3,  0,  2,  0,  2], ps: -2904.0, pst: 0.0, pc: 15.0, ec: 1233.0, ect: 0.0, es: 7.0 },
    NutTerm { n: [ 0, -1,  0,  2,  0], ps: 4348.0, pst: 0.0, pc: -10.0, ec: -81.0, ect: 0.0, es: 2.0 },
    NutTerm { n: [ 1, -1,  2,  0,  2], ps: -2878.0, pst: 0.0, pc: 8.0, ec: 1232.0, ect: 0.0, es: 4.0 },
    NutTerm { n: [ 0,  0,  0,  1,  0], ps: -4230.0, pst: 0.0, pc: 5.0, ec: -20.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [-1, -1,  2,  2,  2], ps: -2819.0, pst: 0.0, pc: 7.0, ec: 1207.0, ect: 0.0, es: 3.0 },
    NutTerm { n: [-1,  0,  2,  0,  0], ps: -4056.0, pst: 0.0, pc: 5.0, ec: 40.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [ 0, -1,  2,  2,  2], ps: -2647.0, pst: 0.0, pc: 11.0, ec: 1129.0, ect: 0.0, es: 5.0 },
    NutTerm { n: [-2,  0,  0,  0,  1], ps: -2294.0, pst: 0.0, pc: -10.0, ec: 1266.0, ect: 0.0, es: -4.0 },
    NutTerm { n: [ 1,  1,  2,  0,  2], ps: 2481.0, pst: 0.0, pc: -7.0, ec: -1062.0, ect: 0.0, es: -3.0 },
    NutTerm { n: [ 2,  0,  0,  0,  1], ps: 2179.0, pst: 0.0, pc: -2.0, ec: -1129.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [-1,  1,  0,  1,  0], ps: 3276.0, pst: 0.0, pc: 1.0, ec: -9.0, ect: 0.0, es: 0.0 },
    NutTerm { n: [ 1,  1,  0,  0,  0], ps: -3389.0, pst: 0.0, pc: 5.0, ec: 35.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [ 1,  0,  2,  0,  0], ps: 3339.0, pst: 0.0, pc: -13.0, ec: -107.0, ect: 0.0, es: 1.0 },
    NutTerm { n: [-1,  0,  2, -2,  1], ps: -1987.0, pst: 0.0, pc: -6.0, ec: 1073.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [ 1,  0,  0,  0,  2], ps: -1981.0, pst: 0.0, pc: 0.0, ec: 854.0, ect: 0.0, es: 0.0 },
    NutTerm { n: [-1,  0,  0,  1,  0], ps: 4026.0, pst: 0.0, pc: -353.0, ec: -553.0, ect: 0.0, es: -139.0 },
    NutTerm { n: [ 0,  0,  2,  1,  2], ps: 1660.0, pst: 0.0, pc: -5.0, ec: -710.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [-1,  0,  2,  4,  2], ps: -1521.0, pst: 0.0, pc: 9.0, ec: 647.0, ect: 0.0, es: 4.0 },
    NutTerm { n: [-1,  1,  0,  1,  1], ps: 1314.0, pst: 0.0, pc: 0.0, ec: -700.0, ect: 0.0, es: 0.0 },
    NutTerm { n: [ 0, -2,  2, -2,  1], ps: -1283.0, pst: 0.0, pc: 0.0, ec: 672.0, ect: 0.0, es: 0.0 },
    NutTerm { n: [ 1,  0,  2,  2,  1], ps: -1331.0, pst: 0.0, pc: 8.0, ec: 663.0, ect: 0.0, es: 4.0 },
    NutTerm { n: [-2,  0,  2,  2,  2], ps: 1383.0, pst: 0.0, pc: -2.0, ec: -594.0, ect: 0.0, es: -2.0 },
    NutTerm { n: [-1,  0,  0,  0,  2], ps: 1405.0, pst: 0.0, pc: 4.0, ec: -610.0, ect: 0.0, es: 2.0 },
    NutTerm { n: [ 1,  1,  2, -2,  2], ps: 1290.0, pst: 0.0, pc: 0.0, ec: -556.0, ect: 0.0, es: 0.0 },
];

/// Fixed offsets standing in for the long-period planetary terms, milliarcseconds
/// (ERFA `DPPLAN` / `DEPLAN`, the Luzum 2001 values for the rigorous method).
const NUT_PLANETARY_DPSI_MAS: f64 = -0.135;
const NUT_PLANETARY_DEPS_MAS: f64 = 0.388;

/// Delaunay arguments `l, l', F, D, Omega` in radians (Simon et al. 1994, as used by
/// the IAU 2000B model), for `t` Julian centuries of TT since J2000.0.
fn delaunay_args(t: f64) -> [f64; 5] {
    let as2r = skyfix_core::units::ARCSEC;
    [
        (485_868.249_036 + 1_717_915_923.217_8 * t) % TURNAS * as2r,
        (1_287_104.793_05 + 129_596_581.048_1 * t) % TURNAS * as2r,
        (335_779.526_232 + 1_739_527_262.847_8 * t) % TURNAS * as2r,
        (1_072_260.703_69 + 1_602_961_601.209_0 * t) % TURNAS * as2r,
        (450_160.398_036 - 6_962_890.543_1 * t) % TURNAS * as2r,
    ]
}

/// Nutation in longitude and obliquity, **arcseconds**, IAU 2000B.
fn nutation_arcsec(jd_tt: f64) -> (f64, f64) {
    let t = centuries_since_j2000(jd_tt);
    let fa = delaunay_args(t);
    let (mut dp, mut de) = (0.0f64, 0.0f64);
    // Smallest terms first, as ERFA does, so the small contributions are not lost.
    for term in NUT2000B.iter().rev() {
        let arg = f64::from(term.n[0]) * fa[0]
            + f64::from(term.n[1]) * fa[1]
            + f64::from(term.n[2]) * fa[2]
            + f64::from(term.n[3]) * fa[3]
            + f64::from(term.n[4]) * fa[4];
        let (sarg, carg) = arg.sin_cos();
        dp += (term.ps + term.pst * t) * sarg + term.pc * carg;
        de += (term.ec + term.ect * t) * carg + term.es * sarg;
    }
    // Series units are 0.1 microarcsecond; the planetary offsets are milliarcseconds.
    (
        dp * 1e-7 + NUT_PLANETARY_DPSI_MAS * 1e-3,
        de * 1e-7 + NUT_PLANETARY_DEPS_MAS * 1e-3,
    )
}

/// Mean obliquity of the ecliptic, **degrees**, IAU 2006 (ERFA `eraObl06`).
fn mean_obliquity_deg(jd_tt: f64) -> f64 {
    let t = centuries_since_j2000(jd_tt);
    let arcsec = 84_381.406
        + t * (-46.836_769
            + t * (-0.000_183_1
                + t * (0.002_003_40 + t * (-0.000_000_576 + t * -0.000_000_043_4))));
    arcsec / ARCSEC_PER_DEG
}

// ---------------------------------------------------------------------------
// Interim sidereal time
// ---------------------------------------------------------------------------

/// Earth rotation angle, **degrees**, IAU 2000 (ERFA `eraEra00`).
fn earth_rotation_angle_deg(jd_ut1: f64) -> f64 {
    let t = jd_ut1 - skyfix_core::time::JD_J2000;
    let f = jd_ut1 % 1.0;
    norm_360(360.0 * (f + 0.779_057_273_264_0 + 0.002_737_811_911_354_48 * t))
}

/// The four largest complementary terms of the equation of the equinoxes,
/// **arcseconds** (ERFA `eraEect00`, `t^0` series, terms 1-4). The rest of that series
/// sums to under 0.000002", far below anything this crate claims.
fn ee_complementary_arcsec(fa: &[f64; 5]) -> f64 {
    let om = fa[4];
    let two_f_two_d = 2.0 * fa[2] - 2.0 * fa[3];
    2640.96e-6 * om.sin()
        + 63.52e-6 * (2.0 * om).sin()
        + 11.75e-6 * (two_f_two_d + 3.0 * om).sin()
        + 11.21e-6 * (two_f_two_d + om).sin()
}

/// INTERIM Greenwich apparent sidereal time, **degrees**.
///
/// IAU 2006 GMST (ERFA `eraGmst06`: ERA plus the accumulated-precession polynomial)
/// plus an equation of the equinoxes made of `dpsi cos(eps_true)` and the four largest
/// complementary terms.
///
/// **Handover:** when the sibling agent's `sidereal` module lands, delete this function
/// and replace its single call site in [`SunProvider::position`] with
/// `crate::sidereal::gast_deg(jd_ut1, jd_tt)`. The signature is deliberately identical.
fn interim_gast_deg(jd_ut1: f64, jd_tt: f64) -> f64 {
    let t = centuries_since_j2000(jd_tt);
    let gmst = earth_rotation_angle_deg(jd_ut1)
        + (0.014_506
            + t * (4612.156_534
                + t * (1.391_581_7
                    + t * (-0.000_000_44 + t * (-0.000_029_956 + t * -0.000_000_036_8)))))
            / ARCSEC_PER_DEG;
    let (dpsi_as, deps_as) = nutation_arcsec(jd_tt);
    let eps_true_deg = mean_obliquity_deg(jd_tt) + deps_as / ARCSEC_PER_DEG;
    let fa = delaunay_args(t);
    let ee_as = dpsi_as * eps_true_deg.to_radians().cos() + ee_complementary_arcsec(&fa);
    norm_360(gmst + ee_as / ARCSEC_PER_DEG)
}

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

/// Offline Sun provider: VSOP87D + IAU 2000B nutation + IAU 2006 obliquity, 1990-2060.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SunProvider {
    dut1_s: f64,
}

impl Default for SunProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SunProvider {
    /// The name this provider reports, e.g. for the CLI's "direction from:" line.
    pub const NAME: &'static str = "SunProvider";

    /// DUT1 = 0, the CONVENTIONS section 6 default.
    pub fn new() -> Self {
        SunProvider { dut1_s: 0.0 }
    }

    /// Supply a known DUT1 = UT1 - UTC in seconds, removing the 0.23' GHA term.
    pub fn with_dut1_s(dut1_s: f64) -> Self {
        SunProvider { dut1_s }
    }

    pub fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    fn check_coverage(&self, jd_utc: f64) -> Result<(), EphemerisError> {
        if !jd_utc.is_finite() {
            return Err(EphemerisError::Data(
                "jd_utc is not a finite Julian date".to_string(),
            ));
        }
        if jd_utc < JD_COVERAGE_START || jd_utc > JD_COVERAGE_END {
            return Err(EphemerisError::OutOfCoverage {
                provider: Self::NAME.to_string(),
                jd_utc,
                coverage: format!("{COVERAGE_START_UTC} .. {COVERAGE_END_UTC}"),
            });
        }
        Ok(())
    }

    /// Full apparent place of the Sun at `jd_utc`.
    pub fn position(&self, jd_utc: f64) -> Result<SunPosition, EphemerisError> {
        self.check_coverage(jd_utc)?;
        let jd_tt_v = jd_tt(jd_utc);
        let jd_ut1_v = jd_ut1(jd_utc, self.dut1_s);

        // 1-2. Earth heliocentric -> Sun geocentric, mean ecliptic and equinox of date.
        let (l_rad, b_rad, r_au) = earth_heliocentric(jd_tt_v)?;
        let mut theta_deg = l_rad.to_degrees() + 180.0;
        let mut beta_deg = -b_rad.to_degrees();

        // 3. VSOP87 dynamical frame -> FK5 (Meeus 25.9). T is centuries, not millennia.
        let t = centuries_since_j2000(jd_tt_v);
        let lambda_p = (theta_deg - 1.397 * t - 0.000_31 * t * t).to_radians();
        theta_deg += -0.090_33 / ARCSEC_PER_DEG;
        beta_deg += 0.039_16 * (lambda_p.cos() - lambda_p.sin()) / ARCSEC_PER_DEG;

        // 4-5. Aberration (which is the Sun's light-time to this order) and nutation.
        let (dpsi_as, deps_as) = nutation_arcsec(jd_tt_v);
        let aberration_as = -SUN_ABERRATION_ARCSEC / r_au;
        let apparent_longitude_deg =
            norm_360(theta_deg + (dpsi_as + aberration_as) / ARCSEC_PER_DEG);

        // 6-7. True obliquity, then RA and Dec.
        let true_obliquity_deg = mean_obliquity_deg(jd_tt_v) + deps_as / ARCSEC_PER_DEG;
        let (lam, bet, eps) = (
            apparent_longitude_deg.to_radians(),
            beta_deg.to_radians(),
            true_obliquity_deg.to_radians(),
        );
        let (sin_lam, cos_lam) = lam.sin_cos();
        let (sin_eps, cos_eps) = eps.sin_cos();
        let (sin_bet, cos_bet) = bet.sin_cos();
        let ra_deg = norm_360(
            (sin_lam * cos_eps - (sin_bet / cos_bet) * sin_eps)
                .atan2(cos_lam)
                .to_degrees(),
        );
        let dec_deg = (sin_bet * cos_eps + cos_bet * sin_eps * sin_lam)
            .asin()
            .to_degrees();

        // 8. Hour angle. ---------------------------------------------------------
        // SIDEREAL HANDOVER POINT: replace the next line with
        //     let gast_deg = crate::sidereal::gast_deg(jd_ut1_v, jd_tt_v);
        // and delete `interim_gast_deg`. Nothing else in this file changes.
        let gast_deg = interim_gast_deg(jd_ut1_v, jd_tt_v);
        let gha_deg = norm_360(gast_deg - ra_deg);

        // Equation of time (Meeus 28.1) from the Sun's mean longitude. This route
        // never touches sidereal time, so comparing it with `gha_deg` is an
        // independent check of the whole hour-angle chain (see
        // `tests/sun_equation_of_time.rs`). The two disagree by a steady +0.0034 min
        // (+3.1" of arc, +0.21 s of time) because they use different mean suns; see
        // the note on `equation_of_time_min` below.
        let tau = t / 10.0;
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
            apparent_latitude_deg: beta_deg,
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
        let (kept, total, el, eb, er) = match vsop87() {
            Ok(d) => (
                d.truncation.terms_kept,
                d.truncation.terms_total,
                d.truncation.measured_max_error_l_arcsec,
                d.truncation.measured_max_error_b_arcsec,
                d.truncation.measured_max_error_r_au,
            ),
            Err(_) => (0, 0, f64::NAN, f64::NAN, f64::NAN),
        };
        let dut1 = if self.dut1_s == 0.0 {
            "DUT1 assumed 0 (CONVENTIONS section 6), which puts up to 0.23' of unmodelled \
             error into GHA and nothing into Dec"
                .to_string()
        } else {
            format!("DUT1 supplied as {:+.4} s", self.dut1_s)
        };
        Coverage {
            start_utc: COVERAGE_START_UTC.to_string(),
            end_utc: COVERAGE_END_UTC.to_string(),
            bodies: vec!["Sun".to_string()],
            notes: format!(
                "Apparent geocentric Sun from VSOP87D (CDS VI/81, Bretagnon & Francou 1988), \
                 {kept} of {total} Earth terms kept for this window (truncation error measured \
                 over 1990-2060: {el:.4}\" in L, {eb:.4}\" in B, {er:.2e} au in R); IAU 2000B \
                 nutation and IAU 2006 mean obliquity from ERFA; aberration -20.4898\"/R; \
                 semidiameter 959.63\"/R and horizontal parallax 8.794\"/R. {dut1}. \
                 Sidereal time is the interim IAU 2006 GMST + 4-term equation of the equinoxes \
                 inside sun.rs until the sidereal module lands."
            ),
            // The model alone; the DUT1 term above is reported separately because it is
            // an input assumption, not a model error, and a caller can remove it.
            accuracy_arcmin: 0.02,
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        if !body.eq_ignore_ascii_case("sun") {
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
/// steady +0.0034 min (+3.1" of arc, +0.21 s of time) across 1990-2060, varying by
/// under 0.00001 min within any one year. `tests/sun_equation_of_time.rs` pins that
/// offset; it is below the resolution at which the equation of time is displayed, and
/// it does not touch `gha_deg` or `dec_deg`.
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

    #[test]
    fn embedded_series_parses_and_matches_its_checkpoints() {
        let d = vsop87().expect("embedded VSOP87 data must parse");
        assert_eq!(d.schema, VSOP87_SCHEMA);
        assert_eq!(d.truncation.terms_kept, 1020);
        assert_eq!(d.truncation.terms_total, 2425);
        assert!(d.checkpoints.len() >= 8);
        // The first checkpoint is the catalogue's own published check value.
        assert!(d.checkpoints[0].source.contains("vsop87.chk"));

        let (dl, db, dr) = vsop87_self_check().unwrap();
        // The deviations ARE the truncation error, so they must sit inside the bound
        // the generator measured, with a little room for f64 summation order.
        assert!(
            dl <= d.truncation.measured_max_error_l_arcsec + 1e-6,
            "L off by {dl}\", bound {}\"",
            d.truncation.measured_max_error_l_arcsec
        );
        assert!(
            db <= d.truncation.measured_max_error_b_arcsec + 1e-6,
            "B off by {db}\", bound {}\"",
            d.truncation.measured_max_error_b_arcsec
        );
        assert!(
            dr <= d.truncation.measured_max_error_r_au + 1e-12,
            "R off by {dr} au, bound {} au",
            d.truncation.measured_max_error_r_au
        );
        // And the whole point: the truncation is far inside the 0.1' = 6" target.
        assert!(dl < 0.05 && db < 0.05, "truncation error too large");
    }

    /// Meeus, *Astronomical Algorithms*, Example 22.a: 1987 April 10 at 0h TD gives
    /// `dpsi = -3".788`, `deps = +9".443`, mean obliquity `23d 26' 27".407`.
    ///
    /// Meeus uses IAU 1980 nutation; this crate uses IAU 2000B, which differs from it
    /// by a few hundredths of an arcsecond, and IAU 2006 mean obliquity, which differs
    /// from Meeus's Laskar expression by about 0.04". The tolerances below are those
    /// model differences, not slack: a transcription error in any of the large
    /// nutation terms would be tens of arcseconds.
    #[test]
    fn nutation_and_obliquity_match_meeus_22a() {
        let jd_tt = civil_to_jd(1987, 4, 10);
        let (dpsi, deps) = nutation_arcsec(jd_tt);
        assert_relative_eq!(dpsi, -3.788, epsilon = 0.02);
        assert_relative_eq!(deps, 9.443, epsilon = 0.02);

        let eps0 = mean_obliquity_deg(jd_tt);
        let expected = 23.0 + 26.0 / 60.0 + 27.407 / 3600.0;
        assert_relative_eq!(eps0, expected, epsilon = 0.05 / 3600.0);
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

    /// The Earth rotation angle advances exactly one turn per UT1 sidereal day and is
    /// `100.46...` degrees at J2000.0 noon.
    #[test]
    fn earth_rotation_angle_is_linear_in_ut1() {
        let j2000 = skyfix_core::time::JD_J2000;
        assert_relative_eq!(
            earth_rotation_angle_deg(j2000),
            280.460_618_4,
            epsilon = 1e-6
        );
        let a = earth_rotation_angle_deg(j2000);
        let b = earth_rotation_angle_deg(j2000 + 1.0);
        assert_relative_eq!(
            norm_360(b - a),
            360.0 * 0.002_737_811_911_354_48,
            epsilon = 1e-9
        );
    }

    /// The interim GAST must agree with GMST to within the equation of the equinoxes,
    /// which never exceeds about 1.15 s of time (17.2" x cos eps + 2.6 mas).
    #[test]
    fn interim_gast_differs_from_gmst_only_by_the_equation_of_the_equinoxes() {
        let start = parse_utc("1990-01-01T00:00:00Z").unwrap();
        let mut max_ee_arcsec = 0.0f64;
        for i in 0..(71 * 52) {
            let jd = start + f64::from(i) * 7.0;
            let t = centuries_since_j2000(jd_tt(jd));
            let gmst = norm_360(
                earth_rotation_angle_deg(jd)
                    + (0.014_506 + t * (4612.156_534 + t * 1.391_581_7)) / ARCSEC_PER_DEG,
            );
            let ee = norm_180(interim_gast_deg(jd, jd_tt(jd)) - gmst) * ARCSEC_PER_DEG;
            max_ee_arcsec = max_ee_arcsec.max(ee.abs());
        }
        // max|dpsi| (18.93") x cos(eps) (0.9175) = 17.37", plus 2.6 mas of
        // complementary terms.
        assert!(
            (17.0..17.6).contains(&max_ee_arcsec),
            "max |equation of the equinoxes| = {max_ee_arcsec}\", expected ~17.3\""
        );
    }
}
