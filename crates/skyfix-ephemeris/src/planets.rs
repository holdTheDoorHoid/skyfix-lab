//! Mercury to Neptune: apparent geocentric places, distance, parallax, semidiameter,
//! magnitude and phase.
//!
//! OWNER: planets agent. CONVENTIONS sections 7 and 13. Implements [`AstroProvider`]
//! and [`BodyEphemeris`] for every name in [`crate::body::PLANETS`].
//!
//! # Model chain
//!
//! This reproduces, step for step, what Skyfield's
//! `earth.at(t).observe(planet).apparent()` does with a JPL ephemeris, with VSOP87 in
//! place of the numerical integration:
//!
//! 1. **Heliocentric positions** of the planet and of the **Earth** (not the Earth-Moon
//!    barycentre, which is up to 4 700 km away) from VSOP87A — rectangular, dynamical
//!    ecliptic and equinox J2000, argument TT — embedded from
//!    `../data/vsop87a_planets.json`, truncated for 1990-2060 by
//!    `tools/reference/gen_vsop87a.py` (provenance, rule and measured error in that
//!    file and in `docs/THIRD_PARTY.md`). The Earth's velocity is the analytical
//!    derivative of the same series.
//! 2. **Equatorial axes**: the VSOP87A-to-equator-J2000 rotation published in the
//!    catalogue's `vsop87.txt`. That frame is DE200's J2000 frame, within about 0.03"
//!    of the ICRS, and is used as the ICRS.
//! 3. **Light-time**: the planet is taken at `t - tau` with
//!    `tau = |P(t - tau) - E(t)| / c`, iterated to 1e-12 day as Skyfield does, but with
//!    the full series summed only once (see [`retarded_position`]). Working
//!    heliocentrically instead of barycentrically changes nothing to first order in
//!    v/c: the Sun's motion enters light-time and aberration with opposite signs and
//!    cancels.
//! 4. **Gravitational deflection by the Sun**, the NOVAS formula for a source at a
//!    finite distance (Skyfield's `_compute_deflection`). Skyfield also deflects by
//!    Jupiter and Saturn; the fixtures measure that share at under 0.0003" for every
//!    case, so it is omitted. One deliberate difference: when the planet is hidden
//!    behind the solar disc the deflection is capped at its limb value (1.75") instead
//!    of following the formula toward its singularity at the Sun's centre
//!    (`deflect_by_sun` explains why).
//! 5. **Annual aberration**, the relativistic vector form
//!    [`crate::frames::apply_annual_aberration`], with the Earth's heliocentric
//!    velocity from step 1.
//! 6. **Frame bias, IAU 2006 precession and IAU 2000B nutation**,
//!    [`crate::frames::bias_precession_nutation_matrix`], to the true equator and
//!    equinox of date: CONVENTIONS section 7, and the same rotation the stars use.
//! 7. **GHA = GAST - RA**, [`crate::sidereal::gast_deg`] with UT1 = UTC + DUT1
//!    (DUT1 = 0 unless the provider is built with one; CONVENTIONS section 6).
//!
//! The positions are those of each planet's **system barycentre**, as in VSOP87 and
//! as in DE440s for Mars to Neptune. The centre of Jupiter's disc can sit up to
//! 0.08" from its barycentre (the Galilean moons), Saturn's up to 0.05" (Titan).
//!
//! # Physical quantities
//!
//! - `distance_km`: the light-time distance `|P(t - tau) - E(t)|`, the distance the
//!   light actually travelled, which is what semidiameter and parallax refer to.
//! - `semidiameter_arcmin = asin(R_eq / distance)` with the IAU WGCCRE 2015 equatorial
//!   radii (Archinal et al. 2018, *Celest. Mech. Dyn. Astron.* 130:22, table 1).
//! - `horizontal_parallax_arcmin = asin(a / distance)` with the Earth's WGS84
//!   equatorial radius [`crate::topocentric::WGS84_A_KM`], the radius the explorer's
//!   topocentric module uses for the same parallax.
//! - `phase_angle_deg`: the Sun-planet-Earth angle with the planet at `t - tau`
//!   (Skyfield's `almanac.phase_angle`); `illuminated_fraction = (1 + cos i) / 2`
//!   (CONVENTIONS 13.5).
//! - `elongation_deg`: the angle between the apparent Sun and the apparent planet.
//! - `bright_limb_angle_deg`: Meeus, *Astronomical Algorithms* (48.5), position angle
//!   of the bright limb's midpoint from north through east, from the apparent RA/Dec
//!   of the Sun and the planet.
//! - `magnitude`: Mallama & Hilton (2018), *Astronomy and Computing* 25, 10-24, the
//!   formulas `skyfield.magnitudelib.planetary_magnitude` implements, evaluated with
//!   the real Sun (see [`visual_magnitude`] for the validity ranges and what happens
//!   outside them).
//!
//! # Accuracy
//!
//! Measured two ways against JPL DE440s: the whole pipeline against
//! `fixtures/reference/planets_*.json` (Skyfield 1.55, 322-338 epochs per planet over
//! 1990-2060 including conjunctions, oppositions, greatest elongations and stations)
//! by `tests/planets_reference.rs`, and the embedded series against DE440s every day
//! of the window by the generator. The published figures are
//! [`ACCURACY_BY_PLANET_ARCMIN`] and [`ACCURACY_ARCMIN`]; `docs/ACCURACY.md`,
//! "Planets", has the tables. The error is VSOP87 itself (fitted to DE200 in 1988:
//! up to 2.4" for Neptune and 1.8" for Uranus, a few tenths for Jupiter and Saturn,
//! under 0.1" for Mercury to Mars) plus the truncation (at most 0.23" per planet at
//! its closest approach, measured).

use std::sync::OnceLock;

use serde::Deserialize;
use skyfix_core::time::{JD_J2000, jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::norm_360;

use crate::body::{AU_KM, ApparentState, BodyEphemeris, BodyKind, PLANETS};
use crate::frames::{apply_annual_aberration, bias_precession_nutation_matrix, radec_from_vector};
use crate::sidereal::gast_deg;
use crate::stars::{COVERAGE_END_UTC, COVERAGE_START_UTC};
use crate::{AstroProvider, Coverage, EphemerisError};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Speed of light in au per day: 299 792 458 m/s x 86 400 s / 149 597 870 700 m.
pub const C_AU_PER_DAY: f64 = 299_792_458.0 * 86_400.0 / 149_597_870_700.0;
/// `2 GM_sun / c^2` in au: the scale of solar light deflection.
const SUN_SCHWARZSCHILD_RADIUS_AU: f64 =
    2.0 * 1.327_124_400_41e20 / (299_792_458.0 * 299_792_458.0) / 149_597_870_700.0;
/// Nominal solar radius (IAU 2015 Resolution B3, 695 700 km), au.
const SUN_RADIUS_AU: f64 = 695_700.0 / 149_597_870.700;
/// Days per VSOP87 time unit (a thousand Julian years).
const DAYS_PER_TJY: f64 = 365_250.0;
/// Light-time convergence, days (Skyfield's own criterion).
const LIGHT_TIME_TOLERANCE_DAYS: f64 = 1e-12;

/// `vsop87.txt`, REFERENCE SYSTEM: VSOP87A dynamical ecliptic J2000 to the equator
/// J2000 (the catalogue says FK5; it is DE200's frame, within 0.03" of the ICRS).
const VSOP87A_TO_EQUATOR: [[f64; 3]; 3] = [
    [1.000_000_000_000, 0.000_000_440_360, -0.000_000_190_919],
    [-0.000_000_479_966, 0.917_482_137_087, -0.397_776_982_902],
    [0.000_000_000_000, 0.397_776_982_902, 0.917_482_137_087],
];

/// Saturn's and Uranus's north poles in the ICRS at J2000 (IAU WGCCRE 2015:
/// Saturn alpha0 = 40.589 deg, delta0 = 83.537 deg; Uranus alpha0 = 257.311 deg,
/// delta0 = -15.175 deg). The same vectors Skyfield's `magnitudelib` uses; the
/// secular drift of Saturn's pole over 1990-2060 is 0.02 deg, far below the
/// magnitude formula's resolution.
const SATURN_POLE: [f64; 3] = [0.085_478_83, 0.073_235_76, 0.993_644_75];
const URANUS_POLE: [f64; 3] = [-0.211_999_58, -0.941_559_16, -0.261_768_09];

const VSOP87A_JSON: &str = include_str!("../data/vsop87a_planets.json");
const VSOP87A_SCHEMA: &str = "skyfix.vsop87a_trunc/1";

// ---------------------------------------------------------------------------
// The planets
// ---------------------------------------------------------------------------

/// One of the seven planets this provider knows, in order from the Sun.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Planet {
    Mercury,
    Venus,
    Mars,
    Jupiter,
    Saturn,
    Uranus,
    Neptune,
}

impl Planet {
    pub const ALL: [Planet; 7] = [
        Planet::Mercury,
        Planet::Venus,
        Planet::Mars,
        Planet::Jupiter,
        Planet::Saturn,
        Planet::Uranus,
        Planet::Neptune,
    ];

    /// Canonical name, as in [`crate::body::PLANETS`].
    pub fn name(self) -> &'static str {
        PLANETS[self.index()]
    }

    /// Resolve a name: trimmed, case-insensitive (CONVENTIONS 13.1).
    pub fn from_name(name: &str) -> Option<Planet> {
        let n = name.trim();
        Planet::ALL
            .into_iter()
            .find(|p| p.name().eq_ignore_ascii_case(n))
    }

    fn index(self) -> usize {
        self as usize
    }

    /// Equatorial radius, km: IAU WGCCRE 2015 (Archinal et al. 2018, table 1). For
    /// the giant planets this is the 1-bar level.
    pub fn equatorial_radius_km(self) -> f64 {
        match self {
            Planet::Mercury => 2_440.53,
            Planet::Venus => 6_051.8,
            Planet::Mars => 3_396.19,
            Planet::Jupiter => 71_492.0,
            Planet::Saturn => 60_268.0,
            Planet::Uranus => 25_559.0,
            Planet::Neptune => 24_764.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Embedded VSOP87A series
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RawFile {
    schema: String,
    truncation: RawTruncation,
    bodies: std::collections::BTreeMap<String, RawBody>,
    checkpoints: Vec<RawCheckpoint>,
}

#[derive(Debug, Deserialize)]
struct RawTruncation {
    terms_kept: usize,
    terms_total: usize,
    bodies: std::collections::BTreeMap<String, RawBodyTruncation>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawBodyTruncation {
    terms_kept: usize,
    measured_max_error_au: f64,
}

/// `x[n]` is the `T**n` series of X; each term is `[A, B, C]` for `A cos(B + C T)`.
#[derive(Debug, Deserialize)]
struct RawBody {
    x: Vec<Vec<[f64; 3]>>,
    y: Vec<Vec<[f64; 3]>>,
    z: Vec<Vec<[f64; 3]>>,
}

#[derive(Debug, Deserialize)]
struct RawCheckpoint {
    body: String,
    jd_tt: f64,
    xyz_au: [f64; 3],
    source: String,
}

/// One coordinate: all terms contiguous, with the `[start, end)` range of each power.
#[derive(Debug)]
struct Coordinate {
    terms: Vec<[f64; 3]>,
    powers: Vec<(usize, usize)>,
}

impl Coordinate {
    fn new(raw: &[Vec<[f64; 3]>]) -> Coordinate {
        let mut terms = Vec::with_capacity(raw.iter().map(Vec::len).sum());
        let mut powers = Vec::with_capacity(raw.len());
        for p in raw {
            let start = terms.len();
            terms.extend_from_slice(p);
            powers.push((start, terms.len()));
        }
        Coordinate { terms, powers }
    }

    /// Value at `t` (thousands of Julian years of TT from J2000), Horner over powers.
    fn value(&self, t: f64) -> f64 {
        let mut total = 0.0;
        for &(a, b) in self.powers.iter().rev() {
            let mut s = 0.0;
            for term in &self.terms[a..b] {
                s += term[0] * (term[1] + term[2] * t).cos();
            }
            total = total * t + s;
        }
        total
    }

    /// Value and derivative per thousand Julian years.
    fn value_and_rate(&self, t: f64) -> (f64, f64) {
        // X = sum_n t^n S_n(t): Horner for the value (p), for the derivative of the
        // polynomial with S_n held fixed (q), and for sum_n t^n S_n'(t) (r).
        let (mut p, mut q, mut r) = (0.0, 0.0, 0.0);
        for &(a, b) in self.powers.iter().rev() {
            let (mut s, mut ds) = (0.0, 0.0);
            for term in &self.terms[a..b] {
                let (sin, cos) = (term[1] + term[2] * t).sin_cos();
                s += term[0] * cos;
                ds -= term[0] * term[2] * sin;
            }
            q = q * t + p;
            p = p * t + s;
            r = r * t + ds;
        }
        (p, q + r)
    }

    /// Value and rate from only the leading `k` terms of the `T^0` and `T^1` series
    /// (the file keeps each series in decreasing amplitude): good to about 1e-3 au,
    /// enough to estimate a light-time to 1e-5 day before the one full evaluation.
    fn leading_value_and_rate(&self, t: f64, k: usize) -> (f64, f64) {
        let (mut p, mut q, mut r) = (0.0, 0.0, 0.0);
        for &(a, b) in self.powers.iter().take(2).rev() {
            let (mut s, mut ds) = (0.0, 0.0);
            for term in &self.terms[a..b.min(a + k)] {
                let (sin, cos) = (term[1] + term[2] * t).sin_cos();
                s += term[0] * cos;
                ds -= term[0] * term[2] * sin;
            }
            q = q * t + p;
            p = p * t + s;
            r = r * t + ds;
        }
        (p, q + r)
    }
}

/// Leading terms per series used for the light-time estimate.
const LEADING_TERMS: usize = 16;

#[derive(Debug)]
struct BodySeries {
    xyz: [Coordinate; 3],
    truncation: RawBodyTruncation,
}

impl BodySeries {
    /// Heliocentric position, au, VSOP87A ecliptic axes.
    fn position(&self, t: f64) -> [f64; 3] {
        [
            self.xyz[0].value(t),
            self.xyz[1].value(t),
            self.xyz[2].value(t),
        ]
    }

    /// Heliocentric position (au) and velocity (au/day), VSOP87A ecliptic axes.
    fn position_velocity(&self, t: f64) -> ([f64; 3], [f64; 3]) {
        let (x, dx) = self.xyz[0].value_and_rate(t);
        let (y, dy) = self.xyz[1].value_and_rate(t);
        let (z, dz) = self.xyz[2].value_and_rate(t);
        (
            [x, y, z],
            [dx / DAYS_PER_TJY, dy / DAYS_PER_TJY, dz / DAYS_PER_TJY],
        )
    }

    /// [`Coordinate::leading_value_and_rate`] for all three coordinates, au and au/day.
    fn leading_position_velocity(&self, t: f64) -> ([f64; 3], [f64; 3]) {
        let (x, dx) = self.xyz[0].leading_value_and_rate(t, LEADING_TERMS);
        let (y, dy) = self.xyz[1].leading_value_and_rate(t, LEADING_TERMS);
        let (z, dz) = self.xyz[2].leading_value_and_rate(t, LEADING_TERMS);
        (
            [x, y, z],
            [dx / DAYS_PER_TJY, dy / DAYS_PER_TJY, dz / DAYS_PER_TJY],
        )
    }
}

/// What every planet at one instant shares: the Earth's heliocentric position and
/// velocity (equatorial axes, au and au/day) and the bias-precession-nutation matrix.
#[derive(Debug, Clone, Copy)]
struct EarthFrame {
    jd_tt: f64,
    earth: [f64; 3],
    earth_vel: [f64; 3],
    bpn: [[f64; 3]; 3],
}

thread_local! {
    /// The last [`EarthFrame`] computed. The explorer asks for all seven planets at the
    /// same instant, so the Earth's series is summed once instead of seven times. A
    /// pure cache: the key is the exact `jd_tt`, so results never depend on it.
    static LAST_EARTH_FRAME: std::cell::Cell<Option<EarthFrame>> =
        const { std::cell::Cell::new(None) };
}

fn earth_frame(s: &Series, jd_tt: f64) -> EarthFrame {
    if let Some(f) = LAST_EARTH_FRAME.with(std::cell::Cell::get)
        && f.jd_tt.to_bits() == jd_tt.to_bits()
    {
        return f;
    }
    let (e, v) = s.earth.position_velocity(vsop_time(jd_tt));
    let f = EarthFrame {
        jd_tt,
        earth: to_equator(e),
        earth_vel: to_equator(v),
        bpn: bias_precession_nutation_matrix(jd_tt),
    };
    LAST_EARTH_FRAME.with(|c| c.set(Some(f)));
    f
}

struct Series {
    earth: BodySeries,
    /// Indexed by [`Planet::index`].
    planets: Vec<BodySeries>,
    terms_kept: usize,
    terms_total: usize,
    checkpoints: Vec<RawCheckpoint>,
}

impl Series {
    fn body(&self, name: &str) -> Option<&BodySeries> {
        if name == "Earth" {
            Some(&self.earth)
        } else {
            Planet::from_name(name).map(|p| &self.planets[p.index()])
        }
    }
}

static SERIES: OnceLock<Result<Series, String>> = OnceLock::new();

fn parse_series() -> Result<Series, String> {
    let raw: RawFile =
        serde_json::from_str(VSOP87A_JSON).map_err(|e| format!("malformed JSON: {e}"))?;
    if raw.schema != VSOP87A_SCHEMA {
        return Err(format!(
            "schema is {:?}, expected {VSOP87A_SCHEMA:?}",
            raw.schema
        ));
    }
    let take = |name: &str| -> Result<BodySeries, String> {
        let b = raw
            .bodies
            .get(name)
            .ok_or_else(|| format!("no series for {name}"))?;
        if [&b.x, &b.y, &b.z]
            .iter()
            .any(|c| c.iter().all(Vec::is_empty))
        {
            return Err(format!("{name}: every coordinate needs at least one term"));
        }
        let truncation = raw
            .truncation
            .bodies
            .get(name)
            .cloned()
            .ok_or_else(|| format!("no truncation record for {name}"))?;
        let kept: usize = [&b.x, &b.y, &b.z]
            .iter()
            .map(|c| c.iter().map(Vec::len).sum::<usize>())
            .sum();
        if kept != truncation.terms_kept {
            return Err(format!(
                "{name}: {kept} terms present, the truncation record says {}",
                truncation.terms_kept
            ));
        }
        Ok(BodySeries {
            xyz: [
                Coordinate::new(&b.x),
                Coordinate::new(&b.y),
                Coordinate::new(&b.z),
            ],
            truncation,
        })
    };
    let earth = take("Earth")?;
    let planets = PLANETS
        .iter()
        .map(|p| take(p))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Series {
        earth,
        planets,
        terms_kept: raw.truncation.terms_kept,
        terms_total: raw.truncation.terms_total,
        checkpoints: raw.checkpoints,
    })
}

fn series() -> Result<&'static Series, EphemerisError> {
    SERIES
        .get_or_init(parse_series)
        .as_ref()
        .map_err(|e| EphemerisError::Data(format!("embedded VSOP87A data is unusable: {e}")))
}

/// VSOP87 time argument: thousands of Julian years of TT from J2000.
fn vsop_time(jd_tt: f64) -> f64 {
    (jd_tt - JD_J2000) / DAYS_PER_TJY
}

/// Heliocentric position of `body` ("Earth" or a planet name) in au, on the
/// equatorial J2000 axes this module treats as the ICRS (model step 2). `jd_tt` is
/// Terrestrial Time. No coverage check: the series are truncated for 1990-2060 and
/// degrade outside it.
pub fn heliocentric_position_au(body: &str, jd_tt: f64) -> Result<[f64; 3], EphemerisError> {
    let s = series()?;
    let b = s.body(body).ok_or_else(|| {
        EphemerisError::UnknownBody(body.to_string(), PlanetProvider::NAME.to_string())
    })?;
    Ok(to_equator(b.position(vsop_time(jd_tt))))
}

/// Re-evaluate the embedded series at the checkpoints shipped with the data file and
/// return the worst deviation in au, over every body.
///
/// One checkpoint per body is the catalogue's own published `vsop87.chk` value at
/// J2000, so this also checks the series against a source outside this repository.
/// The deviations are the truncation error, bounded by each body's
/// `measured_max_error_au`; a value far above that means the embedded file has been
/// damaged. Returns `(worst deviation, worst deviation / that body's bound)`.
pub fn vsop87a_self_check() -> Result<(f64, f64), EphemerisError> {
    let s = series()?;
    let mut worst = (0.0f64, 0.0f64);
    for c in &s.checkpoints {
        let b = s.body(&c.body).ok_or_else(|| {
            EphemerisError::Data(format!("checkpoint for unknown body {:?}", c.body))
        })?;
        let p = b.position(vsop_time(c.jd_tt));
        let d = ((p[0] - c.xyz_au[0]).powi(2)
            + (p[1] - c.xyz_au[1]).powi(2)
            + (p[2] - c.xyz_au[2]).powi(2))
        .sqrt();
        if !d.is_finite() {
            return Err(EphemerisError::Data(format!(
                "VSOP87A evaluation is not finite for {} at jd_tt {} ({})",
                c.body, c.jd_tt, c.source
            )));
        }
        worst.0 = worst.0.max(d);
        worst.1 = worst.1.max(d / b.truncation.measured_max_error_au);
    }
    Ok(worst)
}

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn scale(a: [f64; 3], k: f64) -> [f64; 3] {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    scale(a, 1.0 / norm(a))
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// The angle between two vectors in degrees, well conditioned at 0 and 180.
fn angle_deg(a: [f64; 3], b: [f64; 3]) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b)).to_degrees()
}

fn mat_vec(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

fn to_equator(v: [f64; 3]) -> [f64; 3] {
    mat_vec(&VSOP87A_TO_EQUATOR, v)
}

/// Gravitational deflection of light by the Sun for a source at a finite distance:
/// the NOVAS `grav_vec` formula as Skyfield's `_compute_deflection` writes it.
///
/// `p` is the observer-to-planet vector and `e` the Sun-to-observer vector, both au
/// on the same axes.
///
/// The formula describes a ray that passes **outside** the Sun: 1.75" at the limb,
/// falling off as 1/impact parameter. A planet whose geometric direction lies inside
/// the solar disc is occulted, and there the formula grows without bound toward the
/// Sun's centre (Skyfield applies it anyway: 195" for Uranus on 2029-06-04, when it
/// passed 8" from the centre). This function caps the deflection at the limb-grazing
/// value inside the disc, so a hidden planet stays within 1.75" of its geometric
/// direction instead of being thrown arcminutes away; outside the disc it is the
/// formula exactly. Within about 1" of the centre, where the direction of the
/// deflection is undefined, none is applied (as in Skyfield).
fn deflect_by_sun(p: [f64; 3], e: [f64; 3]) -> [f64; 3] {
    let q = add(p, e);
    let (pmag, qmag, emag) = (norm(p), norm(q), norm(e));
    let (ph, qh, eh) = (
        scale(p, 1.0 / pmag),
        scale(q, 1.0 / qmag),
        scale(e, 1.0 / emag),
    );
    let (pdotq, qdote, edotp) = (dot(ph, qh), dot(qh, eh), dot(eh, ph));
    if edotp.abs() > 0.999_999_999_99 {
        return p;
    }
    let fac1 = SUN_SCHWARZSCHILD_RADIUS_AU / emag;
    let fac2 = 1.0 + qdote;
    let k = fac1 / fac2 * pmag;
    let mut correction = sub(scale(eh, k * pdotq), scale(qh, k * edotp));
    // The Sun's angular radius from the observer, and the planet's elongation.
    let limb = (SUN_RADIUS_AU / emag).asin();
    if angle_deg(p, scale(e, -1.0)).to_radians() < limb {
        // Limb-grazing deflection for a distant source: (2GM/c^2 |e|) cot(limb / 2).
        let at_limb = fac1 * limb.sin() / (1.0 - limb.cos());
        let now = norm(correction) / pmag;
        if now > at_limb {
            correction = scale(correction, at_limb / now);
        }
    }
    add(p, correction)
}

/// The planet's heliocentric position (equatorial axes, au) at `t - tau` and the
/// light-time `tau` (days), with `tau = |P(t - tau) - E(t)| / c` converged to 1e-12
/// day (model step 3).
///
/// The full series is summed once, cosines only: `tau` is first estimated from the
/// series' leading terms (good to about 1e-3 au, so to about 1e-5 day), the series is
/// evaluated at that retarded instant, and the iteration is finished by moving along
/// the leading-term velocity; its error times the 1e-5 day that remains is about
/// 1e-10 au, a millionth of an arcsecond from the Earth.
/// `tests::fast_light_time_equals_the_full_iteration` holds it to 1e-5".
fn retarded_position(body: &BodySeries, t: f64, earth: [f64; 3]) -> ([f64; 3], f64) {
    let (q_ecl, qv_ecl) = body.leading_position_velocity(t);
    let (q, qv) = (to_equator(q_ecl), to_equator(qv_ecl));
    let mut tau0 = norm(sub(q, earth)) / C_AU_PER_DAY;
    for _ in 0..3 {
        tau0 = norm(sub(sub(q, scale(qv, tau0)), earth)) / C_AU_PER_DAY;
    }
    let p0 = to_equator(body.position(t - tau0 / DAYS_PER_TJY));
    let at = |tau: f64| sub(p0, scale(qv, tau - tau0));
    let mut tau = tau0;
    for _ in 0..8 {
        let next = norm(sub(at(tau), earth)) / C_AU_PER_DAY;
        let done = (next - tau).abs() < LIGHT_TIME_TOLERANCE_DAYS;
        tau = next;
        if done {
            break;
        }
    }
    (at(tau), tau)
}

/// Meeus (48.5): position angle of the bright limb's midpoint, degrees `[0, 360)`,
/// from the apparent RA/Dec of the Sun and of the body.
fn bright_limb_angle_deg(sun_ra: f64, sun_dec: f64, ra: f64, dec: f64) -> f64 {
    let (a0, d0, a, d) = (
        sun_ra.to_radians(),
        sun_dec.to_radians(),
        ra.to_radians(),
        dec.to_radians(),
    );
    let y = d0.cos() * (a0 - a).sin();
    let x = d0.sin() * d.cos() - d0.cos() * d.sin() * (a0 - a).cos();
    norm_360(y.atan2(x).to_degrees())
}

// ---------------------------------------------------------------------------
// Magnitudes: Mallama & Hilton (2018)
// ---------------------------------------------------------------------------

/// What a magnitude formula needs, all heliocentric and light-time corrected.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MagnitudeGeometry {
    /// Sun-planet distance, au.
    pub r_au: f64,
    /// Observer-planet distance, au.
    pub delta_au: f64,
    /// Sun-planet-observer angle, degrees.
    pub phase_angle_deg: f64,
    /// Planetocentric latitude of the Sun seen from the planet, degrees (Saturn and
    /// Uranus only; 0 otherwise).
    pub sun_sub_latitude_deg: f64,
    /// Planetocentric latitude of the observer seen from the planet, degrees.
    pub observer_sub_latitude_deg: f64,
    /// Julian year of TT (Neptune only).
    pub year: f64,
}

/// Apparent visual magnitude by Mallama & Hilton (2018), *Astronomy and Computing*
/// 25, 10-24: the same formulas and branch limits as
/// `skyfield.magnitudelib.planetary_magnitude` (Skyfield 1.55). `None` where the
/// published model has no answer.
///
/// Validity and what this function does outside it (paper section in brackets):
///
/// - **Mercury** (3.1, eq. 2): observed for 2.1 < alpha < 169.5 deg. The polynomial is
///   evaluated for any alpha, as Skyfield and the paper's own statistics do; near
///   inferior conjunction (alpha 169-179 deg) it is an extrapolation.
/// - **Venus** (3.2, eqs. 3-4): eq. 3 for alpha < 163.7 deg, eq. 4 up to 179 deg;
///   beyond 179 deg eq. 4 is extrapolated.
/// - **Mars** (3.4, eqs. 6-7): eq. 6 for alpha <= 50 deg (all of the geocentric
///   range). The rotational and seasonal corrections `L(lambda_e)` and `L(Ls)` are
///   **not applied**, as in Skyfield: up to about 0.06 mag.
/// - **Jupiter** (3.5, eqs. 8-9): eq. 8 for alpha <= 12 deg, eq. 9 beyond.
/// - **Saturn** (3.6, eq. 10, globe and rings): valid for alpha <= 6.5 deg and
///   effective ring tilt beta <= 27 deg. Outside that the paper gives no magnitude for
///   the planet with its rings and this returns `None` (Skyfield: NaN). Seen from the
///   Earth, alpha stays under 6.4 deg and beta under 27 deg, so this never happens in
///   the coverage window.
/// - **Uranus** (3.7, eqs. 14-15): eq. 14 with the sub-latitude term, plus eq. 15's
///   phase term only above alpha = 3.1 deg, as Skyfield does. Planetocentric
///   latitudes are used where the paper specifies planetographic (Skyfield does the
///   same); with the paper's flattening the difference is under 0.001 mag.
/// - **Neptune** (3.8, eqs. 16-17): eq. 16 (V(1,0) brightening from -6.89 before 1980
///   to -7.00 after 2000); eq. 17's phase term above alpha = 1.9 deg after 2000.
///   Before 2000 above 1.9 deg Skyfield returns NaN because eq. 17's constant is the
///   post-2000 one; this function returns eq. 16 alone there, which is the paper's
///   own geocentric formula (it ignores Neptune's phase from the Earth, a 0.015 mag
///   effect at most).
pub fn visual_magnitude(planet: Planet, g: &MagnitudeGeometry) -> Option<f64> {
    let a = g.phase_angle_deg;
    let distance = 5.0 * (g.r_au * g.delta_au).log10();
    let m = match planet {
        Planet::Mercury => {
            -0.613
                + a * (6.3280e-02
                    + a * (-1.6336e-03
                        + a * (3.3644e-05 + a * (-3.4265e-07 + a * (1.6893e-09 - a * 3.0334e-12)))))
        }
        Planet::Venus => {
            if a < 163.7 {
                -4.384 + a * (-1.044e-03 + a * (3.687e-04 + a * (-2.814e-06 + a * 8.938e-09)))
            } else {
                236.058_28 + a * (-2.819_14 + a * 8.390_34e-03)
            }
        }
        Planet::Mars => {
            if a <= 50.0 {
                -1.601 + a * (2.267e-02 - a * 1.302e-04)
            } else {
                -0.367 + a * (-0.025_73 + a * 0.000_344_5)
            }
        }
        Planet::Jupiter => {
            if a <= 12.0 {
                -9.395 + a * (-3.7e-04 + a * 6.16e-04)
            } else {
                let x = a / 180.0;
                -9.428
                    - 2.5
                        * (1.0
                            + x * (-1.507 + x * (-0.363 + x * (-0.062 + x * (2.809 - x * 1.876)))))
                            .log10()
            }
        }
        Planet::Saturn => {
            let product = g.sun_sub_latitude_deg * g.observer_sub_latitude_deg;
            let beta = if product >= 0.0 { product.sqrt() } else { 0.0 };
            if a > 6.5 || beta > 27.0 {
                return None;
            }
            let sb = beta.to_radians().sin();
            -8.914 - 1.825 * sb + 0.026 * a - 0.378 * sb * (-2.25 * a).exp()
        }
        Planet::Uranus => {
            let phi = (g.sun_sub_latitude_deg.abs() + g.observer_sub_latitude_deg.abs()) / 2.0;
            let phase = if a > 3.1 {
                (1.045e-4 * a + 6.587e-3) * a
            } else {
                0.0
            };
            -7.110 - 0.000_84 * phi + phase
        }
        Planet::Neptune => {
            let v1 = (-6.89 - 0.0054 * (g.year - 1980.0)).clamp(-7.00, -6.89);
            if a > 1.9 && g.year >= 2000.0 {
                v1 + 7.944e-3 * a + 9.617e-5 * a * a
            } else {
                v1
            }
        }
    };
    let v = m + distance;
    v.is_finite().then_some(v)
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/// Everything the pipeline computes for one planet at one instant.
///
/// Angles in degrees unless the name says otherwise (CONVENTIONS section 1). RA, Dec
/// and GHA are apparent geocentric of date (section 7).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanetPosition {
    pub planet: Planet,
    pub jd_utc: f64,
    pub jd_tt: f64,
    pub jd_ut1: f64,
    /// `[0, 360)`.
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// Greenwich apparent sidereal time used for the hour angle, `[0, 360)`.
    pub gast_deg: f64,
    /// West-positive, `[0, 360)`.
    pub gha_deg: f64,
    /// Light-time distance from the Earth's centre, au.
    pub distance_au: f64,
    /// Light-time, seconds.
    pub light_time_s: f64,
    /// Distance from the Sun at the light-time-corrected instant, au.
    pub heliocentric_distance_au: f64,
    pub semidiameter_arcmin: f64,
    pub horizontal_parallax_arcmin: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub elongation_deg: f64,
    pub bright_limb_angle_deg: f64,
    pub magnitude: Option<f64>,
    /// The apparent Sun from the same pipeline (used for elongation and the bright
    /// limb), for callers that want both from one evaluation.
    pub sun_ra_deg: f64,
    pub sun_dec_deg: f64,
}

impl PlanetPosition {
    pub fn direction(&self) -> GeocentricDirection {
        GeocentricDirection {
            gha_deg: self.gha_deg,
            dec_deg: self.dec_deg,
            semidiameter_arcmin: self.semidiameter_arcmin,
            horizontal_parallax_arcmin: self.horizontal_parallax_arcmin,
        }
    }
}

/// Apparent geocentric Mercury to Neptune from truncated VSOP87A, 1990-2060.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanetProvider {
    dut1_s: f64,
}

impl Default for PlanetProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// The accuracy published for each planet, arcminutes: the worst GHA or Dec error
/// against JPL DE440s, rounded up.
///
/// Two measurements back each figure. `tests/planets_reference.rs` runs the whole
/// apparent-place pipeline against `fixtures/reference/planets_*.json` (Skyfield +
/// DE440s, 322-338 epochs per planet) and asserts every epoch against it. Between
/// those epochs, `tools/reference/gen_vsop87a.py` compares the embedded (truncated)
/// series with DE440s every day of the window, geometrically; the rest of the
/// pipeline agrees with Skyfield to about 0.001", so that daily figure is the
/// provider's error. Worst values, daily / fixtures, arcminutes: Mercury 0.0023 /
/// 0.0022, Venus 0.0041 / 0.0031, Mars 0.0034 / 0.0032, Jupiter 0.0064 / 0.0063,
/// Saturn 0.0061 / 0.0061, Uranus 0.029 / 0.029, Neptune 0.040 / 0.040.
pub const ACCURACY_BY_PLANET_ARCMIN: [(Planet, f64); 7] = [
    (Planet::Mercury, 0.005),
    (Planet::Venus, 0.005),
    (Planet::Mars, 0.005),
    (Planet::Jupiter, 0.01),
    (Planet::Saturn, 0.01),
    (Planet::Uranus, 0.035),
    (Planet::Neptune, 0.045),
];

/// The accuracy this provider reports in its coverage, arcminutes: the worst planet
/// (Neptune), rounded up. Inside the CONVENTIONS 13.7 target of 0.1', so the explorer
/// offers the navigational planets for sights. It does not include the DUT1 = 0
/// assumption (up to 0.23' of GHA), which the coverage notes state separately.
pub const ACCURACY_ARCMIN: f64 = 0.05;

impl PlanetProvider {
    pub const NAME: &'static str = "skyfix-planets (VSOP87A, IAU 2006/2000B)";

    /// DUT1 = 0 (CONVENTIONS section 6).
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    /// A known DUT1 = UT1 - UTC in seconds, removing up to 0.23' of GHA error.
    pub fn with_dut1_s(dut1_s: f64) -> Self {
        PlanetProvider { dut1_s }
    }

    pub fn dut1_s(&self) -> f64 {
        self.dut1_s
    }

    fn resolve(&self, body: &str) -> Result<Planet, EphemerisError> {
        Planet::from_name(body)
            .ok_or_else(|| EphemerisError::UnknownBody(body.to_string(), Self::NAME.to_string()))
    }

    fn check_coverage(&self, jd_utc: f64) -> Result<(), EphemerisError> {
        if !jd_utc.is_finite() {
            return Err(EphemerisError::Data(
                "jd_utc is not a finite Julian date".to_string(),
            ));
        }
        let start = skyfix_core::time::civil_to_jd(1990, 1, 1);
        let end = skyfix_core::time::civil_to_jd(2060, 12, 31) + 86_399.0 / 86_400.0;
        if jd_utc < start || jd_utc > end {
            return Err(EphemerisError::OutOfCoverage {
                provider: Self::NAME.to_string(),
                jd_utc,
                coverage: format!("{COVERAGE_START_UTC} .. {COVERAGE_END_UTC}"),
            });
        }
        Ok(())
    }

    /// The full apparent place and physical ephemeris of `planet` at `jd_utc`.
    pub fn position(&self, planet: Planet, jd_utc: f64) -> Result<PlanetPosition, EphemerisError> {
        self.check_coverage(jd_utc)?;
        let s = series()?;
        let jd_tt_v = jd_tt(jd_utc);
        let jd_ut1_v = jd_ut1(jd_utc, self.dut1_s);
        let t = vsop_time(jd_tt_v);

        // 1-2. Earth (shared by every planet at this instant) and the planet,
        // heliocentric, equatorial J2000 axes; 3. light-time.
        let frame = earth_frame(s, jd_tt_v);
        let (earth, earth_vel) = (frame.earth, frame.earth_vel);
        let (planet_helio, tau) = retarded_position(&s.planets[planet.index()], t, earth);
        let astrometric = sub(planet_helio, earth);
        let distance_au = norm(astrometric);

        // 4-5. Deflection by the Sun, then aberration by the Earth's velocity.
        let v_c = scale(earth_vel, 1.0 / C_AU_PER_DAY);
        let apparent = apply_annual_aberration(unit(deflect_by_sun(astrometric, earth)), v_c);
        // The Sun: at the origin of this frame, so its astrometric vector is -E.
        let sun_apparent = apply_annual_aberration(unit(scale(earth, -1.0)), v_c);

        // 6. To the true equator and equinox of date.
        let m = &frame.bpn;
        let (planet_date, sun_date) = (mat_vec(m, apparent), mat_vec(m, sun_apparent));
        let (ra_deg, dec_deg) = radec_from_vector(planet_date);
        let (sun_ra_deg, sun_dec_deg) = radec_from_vector(sun_date);

        // 7. Hour angle.
        let gast = gast_deg(jd_ut1_v, jd_tt_v);
        let gha_deg = norm_360(gast - ra_deg);

        // Physical ephemeris.
        let distance_km = distance_au * AU_KM;
        let r_au = norm(planet_helio);
        let phase_angle_deg = angle_deg(planet_helio, astrometric);
        let (sun_lat, obs_lat) = match planet {
            Planet::Saturn => (
                angle_deg(SATURN_POLE, planet_helio) - 90.0,
                angle_deg(SATURN_POLE, astrometric) - 90.0,
            ),
            Planet::Uranus => (
                angle_deg(URANUS_POLE, planet_helio) - 90.0,
                angle_deg(URANUS_POLE, astrometric) - 90.0,
            ),
            _ => (0.0, 0.0),
        };
        let magnitude = visual_magnitude(
            planet,
            &MagnitudeGeometry {
                r_au,
                delta_au: distance_au,
                phase_angle_deg,
                sun_sub_latitude_deg: sun_lat,
                observer_sub_latitude_deg: obs_lat,
                year: 2000.0 + (jd_tt_v - JD_J2000) / 365.25,
            },
        );

        Ok(PlanetPosition {
            planet,
            jd_utc,
            jd_tt: jd_tt_v,
            jd_ut1: jd_ut1_v,
            ra_deg,
            dec_deg,
            gast_deg: gast,
            gha_deg,
            distance_au,
            light_time_s: tau * 86_400.0,
            heliocentric_distance_au: r_au,
            semidiameter_arcmin: (planet.equatorial_radius_km() / distance_km)
                .asin()
                .to_degrees()
                * 60.0,
            horizontal_parallax_arcmin: (crate::topocentric::WGS84_A_KM / distance_km)
                .asin()
                .to_degrees()
                * 60.0,
            phase_angle_deg,
            illuminated_fraction: (1.0 + phase_angle_deg.to_radians().cos()) / 2.0,
            elongation_deg: angle_deg(planet_date, sun_date),
            bright_limb_angle_deg: bright_limb_angle_deg(sun_ra_deg, sun_dec_deg, ra_deg, dec_deg),
            magnitude,
            sun_ra_deg,
            sun_dec_deg,
        })
    }
}

impl AstroProvider for PlanetProvider {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn coverage(&self) -> Coverage {
        let (kept, total) = match series() {
            Ok(s) => (s.terms_kept, s.terms_total),
            Err(_) => (0, 0),
        };
        let per_planet = ACCURACY_BY_PLANET_ARCMIN
            .iter()
            .map(|(p, a)| format!("{} {a}'", p.name()))
            .collect::<Vec<_>>()
            .join(", ");
        let dut1 = if self.dut1_s == 0.0 {
            "DUT1 assumed 0 (CONVENTIONS section 6), which puts up to 0.23' of unmodelled \
             error into GHA and nothing into Dec; it is not in accuracy_arcmin"
                .to_string()
        } else {
            format!("DUT1 supplied as {:+.4} s", self.dut1_s)
        };
        let mut notes = format!(
            "Apparent geocentric Mercury to Neptune of date from VSOP87A (CDS VI/81, \
             Bretagnon & Francou 1988; Earth series, not the Earth-Moon barycentre), \
             {kept} of {total} terms kept for 1990-2060 (the truncation costs at most \
             0.23\" at a planet's closest approach, measured); light-time, deflection by \
             the Sun (capped at its limb value for a planet hidden behind the Sun), \
             relativistic annual aberration, then the shared IAU 2006/2000B bias, \
             precession and nutation and GAST in skyfix_ephemeris::frames and ::sidereal. \
             Positions are of each planet's system barycentre (Jupiter's disc centre can \
             be 0.08\" away). Accuracy per planet, the worst GHA or Dec error against JPL \
             DE440s (at 322-338 Skyfield reference epochs each, and daily between them) \
             rounded up: {per_planet}; accuracy_arcmin is the worst planet. Uranus and \
             Neptune are limited by VSOP87 itself (fitted to DE200 in 1988), not by the \
             truncation. All seven meet the 0.1' target. {dut1}. "
        );
        notes.push_str(
            "Semidiameter from the IAU 2015 equatorial radii; horizontal parallax from the \
             WGS84 equatorial radius. Magnitudes by Mallama & Hilton (2018) with the true \
             Sun (Skyfield's planetary_magnitude treats the solar-system barycentre as the \
             Sun, which moves Mercury's magnitude by up to 0.2 when it is a thin \
             crescent); Mars's rotational and seasonal terms (about 0.06 mag) are not \
             applied.",
        );
        Coverage {
            start_utc: COVERAGE_START_UTC.to_string(),
            end_utc: COVERAGE_END_UTC.to_string(),
            bodies: PLANETS.iter().map(|p| p.to_string()).collect(),
            notes,
            accuracy_arcmin: ACCURACY_ARCMIN,
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        let planet = self.resolve(body)?;
        Ok(self.position(planet, jd_utc)?.direction())
    }
}

impl BodyEphemeris for PlanetProvider {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        let planet = self.resolve(body)?;
        let p = self.position(planet, jd_utc)?;
        Ok(ApparentState {
            body: planet.name().to_string(),
            kind: BodyKind::Planet,
            jd_utc,
            ra_deg: p.ra_deg,
            dec_deg: p.dec_deg,
            gha_deg: p.gha_deg,
            distance_km: Some(p.distance_au * AU_KM),
            semidiameter_arcmin: p.semidiameter_arcmin,
            horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
            magnitude: p.magnitude,
            phase_angle_deg: Some(p.phase_angle_deg),
            illuminated_fraction: Some(p.illuminated_fraction),
            elongation_deg: Some(p.elongation_deg),
            bright_limb_angle_deg: Some(p.bright_limb_angle_deg),
        })
    }
}

// ---------------------------------------------------------------------------
// Unit tests that need the private internals. Behavioural tests live in
// `tests/planets_*.rs`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::parse_utc;

    #[test]
    fn embedded_series_parse_and_match_their_checkpoints() {
        let s = series().expect("embedded VSOP87A data must parse");
        assert!(s.terms_kept > 1000 && s.terms_kept < s.terms_total);
        // One catalogue check value and eight full-series values per body.
        assert_eq!(s.checkpoints.len(), 8 * 9);
        assert_eq!(
            s.checkpoints
                .iter()
                .filter(|c| c.source.contains("vsop87.chk"))
                .count(),
            8
        );
        let (worst_au, worst_ratio) = vsop87a_self_check().unwrap();
        // The deviations ARE the truncation error: inside each body's measured bound
        // (with room for f64 summation order), and far inside an arcsecond.
        assert!(worst_ratio <= 1.0 + 1e-6, "ratio {worst_ratio}");
        assert!(worst_au < 3e-5, "{worst_au} au");
    }

    #[test]
    fn the_earth_series_is_the_earth_not_the_barycentre() {
        // vsop87.chk: VSOP87A EARTH at J2000 is x -0.1771354586, y 0.9672416237;
        // the EMB is x -0.1771591440, y 0.9672192891 -- 4 800 km away.
        let s = series().unwrap();
        let p = s.earth.position(0.0);
        assert!((p[0] + 0.177_135_458_6).abs() < 3e-7, "{p:?}");
        assert!((p[1] - 0.967_241_623_7).abs() < 3e-7, "{p:?}");
    }

    #[test]
    fn earth_velocity_matches_the_catalogue_check_value() {
        // vsop87.chk: EARTH J2000 x' -.0172076240 y' -.0031587881 z' .0000001069 au/d.
        // Truncation moves the velocity by at most 2.8e-8 au/day over the window (5 cm/s,
        // 0.00003" of aberration; the generator records the worst case).
        let s = series().unwrap();
        let (_, v) = s.earth.position_velocity(0.0);
        let want = [-0.017_207_624_0, -0.003_158_788_1, 0.000_000_106_9];
        for k in 0..3 {
            assert!((v[k] - want[k]).abs() < 1e-8, "{v:?}");
        }
        let error = ((v[0] - want[0]).powi(2) + (v[1] - want[1]).powi(2)).sqrt();
        assert!(error / C_AU_PER_DAY < 0.01 / 206_264.8, "{error} au/day");
    }

    /// The light-time the Skyfield way: sum the full series at every iteration.
    fn retarded_position_by_full_iteration(
        body: &BodySeries,
        t: f64,
        earth: [f64; 3],
    ) -> ([f64; 3], f64) {
        let mut tau = norm(sub(to_equator(body.position(t)), earth)) / C_AU_PER_DAY;
        for _ in 0..10 {
            let p = to_equator(body.position(t - tau / DAYS_PER_TJY));
            let next = norm(sub(p, earth)) / C_AU_PER_DAY;
            if (next - tau).abs() < 1e-14 {
                return (p, next);
            }
            tau = next;
        }
        panic!("light-time did not converge");
    }

    #[test]
    fn fast_light_time_equals_the_full_iteration() {
        let s = series().unwrap();
        let (mut worst_arcsec, mut worst_tau) = (0.0f64, 0.0f64);
        for i in 0..40 {
            let jd = 2_447_893.0 + f64::from(i) * 647.3;
            let t = vsop_time(jd);
            let earth = to_equator(s.earth.position(t));
            for body in &s.planets {
                let (fast, tau_fast) = retarded_position(body, t, earth);
                let (slow, tau_slow) = retarded_position_by_full_iteration(body, t, earth);
                // As an angle seen from the Earth: what the difference does to the sky.
                let angle = norm(sub(fast, slow)) / norm(sub(slow, earth)) * 206_264.806;
                worst_arcsec = worst_arcsec.max(angle);
                worst_tau = worst_tau.max((tau_fast - tau_slow).abs());
            }
        }
        assert!(worst_arcsec < 1e-5, "{worst_arcsec}\"");
        assert!(worst_tau < 1e-12, "{worst_tau} day");
    }

    #[test]
    fn rates_are_the_derivative_of_the_values() {
        let s = series().unwrap();
        for b in std::iter::once(&s.earth).chain(s.planets.iter()) {
            let t = 0.0237;
            // 1e-8 thousand years is 5 minutes: small enough that the central
            // difference's own error (h^2 / 6 times the third derivative) stays under
            // 1e-9 au/day even for Mercury.
            let h = 1e-8;
            let (_, v) = b.position_velocity(t);
            let (a, c) = (b.position(t - h), b.position(t + h));
            for k in 0..3 {
                let num = (c[k] - a[k]) / (2.0 * h) / DAYS_PER_TJY;
                assert!((num - v[k]).abs() < 1e-9, "{num} vs {}", v[k]);
            }
        }
    }

    /// Mallama & Hilton's own test data (the paper's `Ap_Mag_Output_V3.txt`, as
    /// carried in Skyfield's test suite): r, delta, alpha and the published V.
    #[test]
    fn magnitudes_reproduce_mallama_and_hilton_test_data() {
        let g = |r: f64, d: f64, a: f64| MagnitudeGeometry {
            r_au: r,
            delta_au: d,
            phase_angle_deg: a,
            sun_sub_latitude_deg: 0.0,
            observer_sub_latitude_deg: 0.0,
            year: 2018.0,
        };
        let cases: [(Planet, MagnitudeGeometry, f64, f64); 18] = [
            (
                Planet::Mercury,
                g(0.310_295_423_552, 1.321_826_436_257_54, 1.1677),
                -2.477,
                5e-4,
            ),
            (
                Planet::Mercury,
                g(0.413_629_222_334, 0.926_448_087_186_13, 90.1662),
                0.181,
                5e-4,
            ),
            (
                Planet::Mercury,
                g(0.448_947_624_811, 0.560_049_732_178_83, 178.7284),
                7.167,
                5e-4,
            ),
            (
                Planet::Venus,
                g(0.722_722_540_169, 1.716_074_895_540_51, 1.3232),
                -3.917,
                5e-4,
            ),
            (
                Planet::Venus,
                g(0.721_480_714_554, 0.377_625_112_062_78, 124.1348),
                -4.916,
                5e-4,
            ),
            (
                Planet::Venus,
                g(0.726_166_592_736, 0.288_895_824_206_42, 179.1845),
                -3.090,
                5e-4,
            ),
            // Mars: the published values include L(lambda_e) and L(Ls), which are not
            // modelled (up to ~0.06 mag), hence the looser bound.
            (
                Planet::Mars,
                g(1.381_191_244_505, 0.372_743_810_979_11, 4.8948),
                -2.862,
                0.1,
            ),
            (
                Planet::Mars,
                g(1.664_150_453_905, 2.589_951_645_184_60, 11.5877),
                1.788,
                0.1,
            ),
            (
                Planet::Mars,
                g(1.591_952_180_003, 3.858_825_522_720_13, 167.9),
                8.977,
                0.1,
            ),
            (
                Planet::Jupiter,
                g(5.446_231_815_414, 6.449_858_674_590_88, 0.2446),
                -1.667,
                5e-4,
            ),
            (
                Planet::Jupiter,
                g(4.957_681_473_205, 3.953_930_781_360_13, 0.3431),
                -2.934,
                5e-4,
            ),
            (
                Planet::Jupiter,
                g(5.227_587_855_371, 5.235_019_200_093_81, 147.0989),
                0.790,
                5e-4,
            ),
            (
                Planet::Saturn,
                MagnitudeGeometry {
                    sun_sub_latitude_deg: -26.224_864_126_755_417,
                    observer_sub_latitude_deg: -26.332_275_658_328_648,
                    ..g(9.014_989_659_493, 8.031_604_705_468_89, 0.1055)
                },
                -0.552,
                5e-4,
            ),
            (
                Planet::Uranus,
                MagnitudeGeometry {
                    sun_sub_latitude_deg: -20.29,
                    observer_sub_latitude_deg: -20.28,
                    ..g(18.321_003_215_845, 17.322_972_852_510_8, 0.0410)
                },
                5.381,
                5e-4,
            ),
            (
                Planet::Uranus,
                MagnitudeGeometry {
                    sun_sub_latitude_deg: -71.16,
                    observer_sub_latitude_deg: 55.11,
                    ..g(19.380_030_717_75, 11.188_424_380_138_3, 161.7728)
                },
                8.318,
                5e-4,
            ),
            (
                Planet::Neptune,
                MagnitudeGeometry {
                    year: 1970.8963,
                    ..g(30.322_109_867_761, 31.309_161_009_821_4, 0.0549)
                },
                7.997,
                5e-4,
            ),
            (
                Planet::Neptune,
                MagnitudeGeometry {
                    year: 2009.6299,
                    ..g(30.028_181_709_541, 29.015_852_166_574_4, 0.0381)
                },
                7.701,
                5e-4,
            ),
            (
                Planet::Neptune,
                MagnitudeGeometry {
                    year: 2018.1409,
                    ..g(29.943_863_119_56, 0.009_409_689_422_51, 88.4363)
                },
                -8.296,
                5e-4,
            ),
        ];
        for (planet, geometry, want, tol) in cases {
            let got = visual_magnitude(planet, &geometry).unwrap();
            assert!(
                (got - want).abs() < tol,
                "{planet:?} {geometry:?}: {got:.4} vs {want}"
            );
        }
    }

    #[test]
    fn saturn_outside_its_ring_model_has_no_magnitude() {
        // Mallama & Hilton give nothing for globe + rings beyond alpha 6.5 deg.
        let g = MagnitudeGeometry {
            r_au: 9.026_035_315_474,
            delta_au: 10.132_149_765_476_5,
            phase_angle_deg: 169.8958,
            sun_sub_latitude_deg: 29.097,
            observer_sub_latitude_deg: -26.673,
            year: 2018.0,
        };
        assert_eq!(visual_magnitude(Planet::Saturn, &g), None);
        // Sun and observer on opposite sides of the rings: beta = 0, rings dark.
        let backlit = MagnitudeGeometry {
            phase_angle_deg: 3.0,
            sun_sub_latitude_deg: 1.0,
            observer_sub_latitude_deg: -1.0,
            ..g
        };
        let m = visual_magnitude(Planet::Saturn, &backlit).unwrap();
        let want = 5.0 * (g.r_au * g.delta_au).log10() - 8.914 + 0.026 * 3.0;
        assert!((m - want).abs() < 1e-12);
    }

    #[test]
    fn neptune_before_2000_beyond_the_geocentric_limit_uses_eq_16() {
        // Skyfield returns NaN here; this module keeps the paper's geocentric formula.
        let g = MagnitudeGeometry {
            r_au: 30.207_767_693_725,
            delta_au: 29.817_237_085_753,
            phase_angle_deg: 1.93,
            sun_sub_latitude_deg: 0.0,
            observer_sub_latitude_deg: 0.0,
            year: 1990.3240,
        };
        let m = visual_magnitude(Planet::Neptune, &g).unwrap();
        let v1 = -6.89 - 0.0054 * (1990.3240 - 1980.0);
        assert!((m - (5.0 * (g.r_au * g.delta_au).log10() + v1)).abs() < 1e-12);
    }

    #[test]
    fn deflection_is_zero_for_a_planet_in_line_with_the_sun_and_small_elsewhere() {
        let e = [1.0, 0.0, 0.0];
        // Straight behind the Sun: skipped rather than singular.
        let p = [-2.0, 0.0, 0.0];
        assert_eq!(deflect_by_sun(p, e), p);
        // At 90 deg elongation a planet 5 au away is deflected by milliarcseconds.
        let p = [0.0, 5.0, 0.0];
        let q = deflect_by_sun(p, e);
        let sep = angle_deg(p, q) * 3600.0;
        assert!(sep > 0.0005 && sep < 0.01, "{sep}\"");
    }

    #[test]
    fn deflection_is_capped_at_the_limb_value_behind_the_sun() {
        // Observer 1 au from the Sun; a planet 20 au beyond it, seen at `theta` from
        // the Sun's centre. The Sun's radius is about 959" from here.
        let e = [1.0, 0.0, 0.0];
        let deflection = |theta_arcsec: f64| {
            let th = (theta_arcsec / 3600.0).to_radians();
            let p = [-21.0, 21.0 * th.tan(), 0.0];
            angle_deg(p, deflect_by_sun(p, e)) * 3600.0
        };
        // Outside the disc: the formula, about 1.75" x (959" / theta), slightly less
        // for a source at a finite distance, and away from the Sun.
        let outside = deflection(1918.0);
        assert!((0.8..0.88).contains(&outside), "{outside}\"");
        // Just outside the limb the formula stays under the cap...
        let limb = deflection(965.0);
        assert!((1.6..1.76).contains(&limb), "{limb}\"");
        // ...and deep inside, where the formula would give 170", it is held at the
        // limb value instead of growing toward the Sun's centre.
        for theta in [10.0, 100.0, 500.0] {
            let d = deflection(theta);
            assert!((1.70..1.76).contains(&d), "{d}\" at {theta}\"");
        }
    }

    #[test]
    fn coverage_is_enforced() {
        let p = PlanetProvider::new();
        let before = parse_utc("1989-12-31T23:59:59Z").unwrap();
        let after = parse_utc("2061-01-01T00:00:00Z").unwrap();
        for jd in [before, after] {
            assert!(matches!(
                p.position(Planet::Mars, jd),
                Err(EphemerisError::OutOfCoverage { .. })
            ));
        }
        assert!(p.position(Planet::Mars, f64::NAN).is_err());
        let first = parse_utc("1990-01-01T00:00:00Z").unwrap();
        let last = parse_utc("2060-12-31T23:59:59Z").unwrap();
        for jd in [first, last] {
            for planet in Planet::ALL {
                assert!(p.position(planet, jd).is_ok(), "{planet:?} at {jd}");
            }
        }
    }
}
