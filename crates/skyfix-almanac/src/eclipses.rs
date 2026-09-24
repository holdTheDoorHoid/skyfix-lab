//! Solar and lunar eclipses: finding, classification, local circumstances, paths.
//!
//! OWNER: eclipse agent (wave 2). CONVENTIONS sections 1, 6, 7 and 13; wire format in
//! `docs/EXPLORER_API.md`, "Wave 2 — eclipses"; accuracy in `docs/ACCURACY.md`,
//! "Eclipses"; sources in `docs/THIRD_PARTY.md`, "Eclipses".
//!
//! # Model
//!
//! - **Ephemeris**: the apparent geocentric Sun (`SunProvider`, VSOP87D) and Moon
//!   (`MoonProvider`, ELP 2000-82B) of CONVENTIONS section 7, the same two theories
//!   NASA's *Five Millennium Canon* (Espenak & Meeus) was computed with. Earth rotation
//!   is GAST with UT1 = UTC + DUT1, DUT1 = 0 unless supplied (CONVENTIONS section 6).
//! - **Solar eclipses** are reduced to Besselian elements (`bessel.rs`), interpolated
//!   at Chebyshev nodes over twelve hours around each eclipse; everything else —
//!   greatest eclipse, type, contacts, paths, local circumstances — is geometry on those
//!   elements. The observer is a WGS84 site (CONVENTIONS section 1, display exception).
//! - **Moon's radius**: NASA's `k1 = 0.272488` Earth radii for the penumbra and
//!   `k2 = 0.272281` for the umbra ([`K_PENUMBRA`], [`K_UMBRA`]); the smaller umbral
//!   value stands for the valleys of the lunar limb, through which the last sunlight
//!   shines. The limb profile itself is not modelled (it moves limits by 1-3 km and
//!   shortens totality by a second or two). The Sun's radius subtends 959.63" at 1 au.
//! - **Lunar eclipses** (`lunar.rs`): the Moon against the shadow cast opposite the
//!   apparent Sun, shadow radii by **Danjon's rule** (`1.01 x` the Moon's parallax,
//!   [`DANJON_FACTOR`]), the convention of NASA's lunar canon.
//! - **Time**: every instant in and out is UTC (`jd_utc`, `utc`). Greatest eclipse also
//!   carries `jd_tt`, and each eclipse its `delta_t_s`, the TT minus UT1 its ground track
//!   assumed (32.184 s plus TAI minus UTC, less DUT1). Global quantities (gamma,
//!   magnitude, type, instants in TT) do not depend on it; geographic positions and local
//!   UTC times do.
//! - **Identity**: `"YYYY-MM-DD-solar"` or `"YYYY-MM-DD-lunar"`, the UTC date of
//!   greatest eclipse. **Saros** and **lunation** numbers as NASA numbers them
//!   (`search.rs`).
//!
//! Coverage is the Moon provider's, 1990-01-01T00:00Z to 2060-12-31T23:59:59Z.

mod bessel;
pub(crate) mod cheb;
mod local;
mod lunar;
mod path;
mod search;
mod solar;

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc, jd_tt};
use skyfix_ephemeris::EphemerisError;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::Site;

pub use bessel::{K_PENUMBRA, K_UMBRA};
pub use local::{
    LocalEvent, LocalEventKind, LocalType, SUN_RISE_SET_ALT_DEG, Visibility, obscuration,
};
pub use lunar::DANJON_FACTOR;
pub use path::{MAX_SAGITTA_KM, MAX_SEGMENT_KM, Polyline};

/// First instant any eclipse can be computed: the Moon provider's coverage.
pub const COVERAGE_START_UTC: &str = skyfix_ephemeris::moon::COVERAGE_START_UTC;
/// Last instant, likewise.
pub const COVERAGE_END_UTC: &str = skyfix_ephemeris::moon::COVERAGE_END_UTC;

/// Half-width of the window sampled around each eclipse, hours. A penumbral phase
/// lasts at most about 6.3 h, so +-6 h around the estimated instant (itself good to
/// minutes) always contains it.
const HALF_WINDOW_H: f64 = 6.0;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum EclipseError {
    #[error("malformed eclipse id {0:?}: expected \"YYYY-MM-DD-solar\" or \"YYYY-MM-DD-lunar\"")]
    BadId(String),
    #[error("there is no {kind} eclipse with greatest eclipse on {date} (UTC)")]
    NotFound { kind: &'static str, date: String },
    #[error("{0}")]
    Input(String),
    #[error(transparent)]
    Ephemeris(#[from] EphemerisError),
}

fn coverage_start_jd() -> f64 {
    civil_to_jd(1990, 1, 1)
}

fn coverage_end_jd() -> f64 {
    civil_to_jd(2060, 12, 31) + 86_399.0 / 86_400.0
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolarType {
    Total,
    Annular,
    Hybrid,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LunarType {
    Total,
    Partial,
    Penumbral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobalContactKind {
    /// Penumbra first touches the Earth (solar) / the Moon enters the penumbra (lunar).
    P1,
    /// Umbra first touches the Earth (solar) / the Moon enters the umbra (lunar).
    U1,
    /// The Moon is wholly inside the umbra (lunar, total only).
    U2,
    U3,
    U4,
    P4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlobalContact {
    pub kind: GlobalContactKind,
    pub jd_utc: f64,
    pub utc: String,
}

/// Greatest eclipse of a solar eclipse and where it happens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarGreatest {
    pub jd_utc: f64,
    pub utc: String,
    pub jd_tt: f64,
    /// On the central line, or (partial and non-central eclipses) the point of the
    /// Earth's limb nearest the shadow axis.
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// The Sun seen from there (CONVENTIONS 13.2).
    pub sun_alt_deg: f64,
    pub sun_az_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarEclipse {
    pub id: String,
    #[serde(rename = "type")]
    pub eclipse_type: SolarType,
    /// The shadow axis meets the Earth.
    pub central: bool,
    pub greatest: SolarGreatest,
    /// Central eclipses: the Moon/Sun diameter ratio at greatest eclipse. Others: the
    /// fraction of the Sun's diameter covered there.
    pub magnitude: f64,
    /// Distance of the shadow axis from the Earth's centre at greatest eclipse, Earth
    /// equatorial radii, positive north.
    pub gamma: f64,
    pub saros: i64,
    pub lunation: i64,
    /// `p1`, `u1`, `u4`, `p4`: when the penumbra and the umbra first and last touch
    /// the Earth.
    pub contacts: Vec<GlobalContact>,
    /// Central eclipses with both limits: path width and duration of totality or
    /// annularity at the point of greatest eclipse.
    pub path_width_km: Option<f64>,
    pub central_duration_s: Option<f64>,
    /// TT - UT1 the geographic quantities assume.
    pub delta_t_s: f64,
}

/// Greatest eclipse of a lunar eclipse and where the Moon is overhead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LunarGreatest {
    pub jd_utc: f64,
    pub utc: String,
    pub jd_tt: f64,
    pub lat_deg: f64,
    pub lon_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LunarEclipse {
    pub id: String,
    #[serde(rename = "type")]
    pub eclipse_type: LunarType,
    pub greatest: LunarGreatest,
    pub umbral_magnitude: f64,
    pub penumbral_magnitude: f64,
    /// Distance of the Moon's centre from the shadow axis at greatest eclipse, Earth
    /// equatorial radii, positive north.
    pub gamma: f64,
    pub saros: i64,
    pub lunation: i64,
    /// `p1`, `u1`, `u2`, `u3`, `u4`, `p4` as they occur.
    pub contacts: Vec<GlobalContact>,
    pub penumbral_duration_s: Option<f64>,
    pub partial_duration_s: Option<f64>,
    pub total_duration_s: Option<f64>,
    pub delta_t_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Eclipse {
    Solar(SolarEclipse),
    Lunar(LunarEclipse),
}

impl Eclipse {
    pub fn id(&self) -> &str {
        match self {
            Eclipse::Solar(s) => &s.id,
            Eclipse::Lunar(l) => &l.id,
        }
    }

    pub fn jd_utc(&self) -> f64 {
        match self {
            Eclipse::Solar(s) => s.greatest.jd_utc,
            Eclipse::Lunar(l) => l.greatest.jd_utc,
        }
    }
}

/// The conventions behind every number, for the UI's "about these numbers".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EclipseConventions {
    pub moon_radius_k_penumbra: f64,
    pub moon_radius_k_umbra: f64,
    pub lunar_shadow: String,
    pub delta_t: String,
    pub sources: String,
}

impl EclipseConventions {
    pub fn current() -> Self {
        EclipseConventions {
            moon_radius_k_penumbra: K_PENUMBRA,
            moon_radius_k_umbra: K_UMBRA,
            lunar_shadow: "Danjon: umbra 1.01 pi_moon - s_sun + pi_sun, penumbra 1.01 pi_moon + \
                           s_sun + pi_sun (NASA's lunar canon; the Astronomical Almanac's 1/50 \
                           rule gives magnitudes about 0.006 and 0.026 larger)"
                .to_string(),
            delta_t: "TT - UT1 = 32.184 s + (TAI - UTC) - DUT1 with DUT1 = 0: exact to 0.9 s \
                      for the past, the leap-second table's value for the future"
                .to_string(),
            sources: "VSOP87D Sun and ELP 2000-82B Moon (the theories of NASA's Five Millennium \
                      Canon); validated against the canon, USNO local circumstances and \
                      Skyfield with JPL DE440s"
                .to_string(),
        }
    }
}

/// Result of [`Eclipses::find`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EclipseList {
    /// The window actually searched: the request clipped to the coverage (`jd_start >
    /// jd_end`, and no eclipses, when the request lies wholly outside it).
    pub jd_start: f64,
    pub jd_end: f64,
    /// True when the request extended beyond the coverage.
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    /// Sorted by greatest eclipse.
    pub eclipses: Vec<Eclipse>,
    pub conventions: EclipseConventions,
}

/// The observer, echoed back.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ObserverEcho {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub height_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarLocal {
    pub id: String,
    pub observer: ObserverEcho,
    pub visibility: Visibility,
    pub local_type: LocalType,
    /// At the geometric maximum, whether or not the Sun is up (0 when `none`).
    pub magnitude: f64,
    pub obscuration: f64,
    /// C1 to C4.
    pub duration_s: Option<f64>,
    /// C2 to C3: totality or annularity.
    pub central_duration_s: Option<f64>,
    /// `c1`, `c2`, `max`, `c3`, `c4`, `sunrise`, `sunset`, sorted by time.
    pub events: Vec<LocalEvent>,
    /// The most of the eclipse the observer can see: the maximum if the Sun is up,
    /// else the sunrise or sunset nearest to it; `null` when nothing is visible.
    pub visible_max: Option<LocalEvent>,
    pub delta_t_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LunarLocal {
    pub id: String,
    pub observer: ObserverEcho,
    pub visibility: Visibility,
    /// `p1`, `u1`, `u2`, `max`, `u3`, `u4`, `p4`, `moonrise`, `moonset`, sorted.
    pub events: Vec<LocalEvent>,
    pub delta_t_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EclipseLocal {
    Solar(SolarLocal),
    Lunar(LunarLocal),
}

/// Where a solar eclipse can be seen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarPath {
    pub id: String,
    #[serde(rename = "type")]
    pub eclipse_type: SolarType,
    pub central: bool,
    pub greatest: SolarGreatest,
    /// Empty for partial and non-central eclipses.
    pub central_line: Polyline,
    /// Limits of totality or annularity.
    pub umbra_north: Polyline,
    pub umbra_south: Polyline,
    /// Where totality or annularity is in progress with the Sun on the horizon: small
    /// closed loops that close the path at its sunrise and sunset ends.
    pub umbra_horizon: Polyline,
    /// Limits of the partial eclipse (where it is only just grazing at maximum).
    pub penumbra_north: Polyline,
    pub penumbra_south: Polyline,
    /// Where the partial eclipse begins or ends with the Sun on the horizon: closed
    /// loops that, with the penumbral limits, bound the region that sees any eclipse.
    pub penumbra_horizon: Polyline,
    pub delta_t_s: f64,
}

/// A point under the Moon at one contact of a lunar eclipse: the Moon is overhead
/// there and above the horizon within about 89 degrees of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SublunarPoint {
    pub kind: LocalEventKind,
    pub jd_utc: f64,
    pub utc: String,
    pub lat_deg: f64,
    pub lon_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LunarPath {
    pub id: String,
    #[serde(rename = "type")]
    pub eclipse_type: LunarType,
    /// The sub-lunar point at each contact and at greatest eclipse.
    pub sublunar: Vec<SublunarPoint>,
    pub delta_t_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EclipsePath {
    Solar(Box<SolarPath>),
    Lunar(LunarPath),
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// Eclipse computations on the project's own Sun and Moon.
#[derive(Debug, Clone)]
pub struct Eclipses {
    sun: SunProvider,
    moon: MoonProvider,
    dut1_s: f64,
}

impl Default for Eclipses {
    fn default() -> Self {
        Self::new()
    }
}

struct SolarModel {
    el: bessel::SolarElements,
    g: solar::SolarGlobal,
    summary: SolarEclipse,
}

struct LunarModel {
    el: lunar::LunarElements,
    g: lunar::LunarGlobal,
    summary: LunarEclipse,
}

enum Model {
    Solar(Box<SolarModel>),
    Lunar(Box<LunarModel>),
}

fn instant_contact(kind: GlobalContactKind, jd: f64) -> GlobalContact {
    GlobalContact {
        kind,
        jd_utc: jd,
        utc: format_utc(jd),
    }
}

fn date_of(jd_utc: f64) -> String {
    format_utc(jd_utc).chars().take(10).collect()
}

/// UTC Julian date of a TT Julian date (inverting the leap-second table).
fn utc_of_tt(jd_tt_v: f64) -> f64 {
    let mut jd = jd_tt_v - 69.184 / 86_400.0;
    for _ in 0..3 {
        jd = jd_tt_v - (jd_tt(jd) - jd);
    }
    jd
}

fn check_site(site: &Site) -> Result<(), EclipseError> {
    let ok = site.lat_deg.is_finite()
        && site.lon_deg.is_finite()
        && site.height_m.is_finite()
        && (-90.0..=90.0).contains(&site.lat_deg)
        && (-180.0..=180.0).contains(&site.lon_deg)
        && (-1000.0..=100_000.0).contains(&site.height_m);
    if ok {
        Ok(())
    } else {
        Err(EclipseError::Input(format!(
            "observer out of range: lat {} (-90..90), lon {} (-180..180), height {} m",
            site.lat_deg, site.lon_deg, site.height_m
        )))
    }
}

impl Eclipses {
    /// DUT1 = 0 (CONVENTIONS section 6).
    pub fn new() -> Self {
        Self::with_dut1_s(0.0)
    }

    /// With a known DUT1 = UT1 - UTC, seconds. A validation can also use it to adopt
    /// another source's Delta-T: `DUT1 = 32.184 + (TAI - UTC) - Delta-T`.
    pub fn with_dut1_s(dut1_s: f64) -> Self {
        Eclipses {
            sun: SunProvider::with_dut1_s(dut1_s),
            moon: MoonProvider::with_dut1_s(dut1_s),
            dut1_s,
        }
    }

    fn delta_t_s(&self, jd_utc: f64) -> f64 {
        skyfix_core::time::TT_MINUS_TAI_S + skyfix_core::time::delta_at(jd_utc) - self.dut1_s
    }

    fn window(&self, jd_guess: f64) -> (f64, f64) {
        let lo = (coverage_start_jd() - jd_guess) * 24.0;
        let hi = (coverage_end_jd() - jd_guess) * 24.0;
        ((-HALF_WINDOW_H).max(lo), HALF_WINDOW_H.min(hi))
    }

    fn solar_model(&self, c: &search::Candidate) -> Result<Option<SolarModel>, EclipseError> {
        let jd_guess = utc_of_tt(c.jde);
        let (lo, hi) = self.window(jd_guess);
        if hi - lo < 1.0 {
            return Ok(None);
        }
        let el = bessel::SolarElements::build(&self.sun, &self.moon, jd_guess, lo, hi)?;
        let Some(g) = solar::solar_global(&el) else {
            return Ok(None);
        };
        let jd = el.jd(g.t_ge);
        let tt = jd_tt(jd);
        let site = Site::new(g.ge_lat_deg, g.ge_lon_deg);
        let hz = local::sun_horizontal(&self.sun, &site, jd)?;
        let lunation = search::lunation_number(tt, true);
        let mut contacts = Vec::new();
        for (kind, t) in [
            (GlobalContactKind::P1, g.p1),
            (GlobalContactKind::U1, g.u1),
            (GlobalContactKind::U4, g.u4),
            (GlobalContactKind::P4, g.p4),
        ] {
            if let Some(t) = t {
                contacts.push(instant_contact(kind, el.jd(t)));
            }
        }
        let (mut width, mut duration) = (None, None);
        if g.central {
            width = path::path_width_km(&el, g.t_ge);
            let c = local::solar_contacts(&el, g.ge_point);
            if let (Some(a), Some(b)) = (c.c2, c.c3) {
                duration = Some((b - a) * 3600.0);
            }
        }
        let summary = SolarEclipse {
            id: format!("{}-solar", date_of(jd)),
            eclipse_type: g.kind,
            central: g.central,
            greatest: SolarGreatest {
                jd_utc: jd,
                utc: format_utc(jd),
                jd_tt: tt,
                lat_deg: g.ge_lat_deg,
                lon_deg: g.ge_lon_deg,
                sun_alt_deg: hz.alt_deg,
                sun_az_deg: hz.az_deg,
            },
            magnitude: g.magnitude,
            gamma: g.gamma,
            saros: search::saros_number(lunation, true),
            lunation,
            contacts,
            path_width_km: width,
            central_duration_s: duration,
            delta_t_s: self.delta_t_s(jd),
        };
        Ok(Some(SolarModel { el, g, summary }))
    }

    fn lunar_model(&self, c: &search::Candidate) -> Result<Option<LunarModel>, EclipseError> {
        let jd_guess = utc_of_tt(c.jde);
        let (lo, hi) = self.window(jd_guess);
        if hi - lo < 1.0 {
            return Ok(None);
        }
        let el = lunar::LunarElements::build(&self.sun, &self.moon, jd_guess, lo, hi)?;
        let Some(g) = lunar::lunar_global(&el) else {
            return Ok(None);
        };
        let jd = el.jd(g.t_ge);
        let tt = jd_tt(jd);
        let moon = self.moon.position(jd)?;
        let lunation = search::lunation_number(tt, false);
        let mut contacts = Vec::new();
        for (kind, t) in [
            (GlobalContactKind::P1, g.p1),
            (GlobalContactKind::U1, g.u1),
            (GlobalContactKind::U2, g.u2),
            (GlobalContactKind::U3, g.u3),
            (GlobalContactKind::U4, g.u4),
            (GlobalContactKind::P4, g.p4),
        ] {
            if let Some(t) = t {
                contacts.push(instant_contact(kind, el.jd(t)));
            }
        }
        let span = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => Some((b - a) * 3600.0),
            _ => None,
        };
        let summary = LunarEclipse {
            id: format!("{}-lunar", date_of(jd)),
            eclipse_type: g.kind,
            greatest: LunarGreatest {
                jd_utc: jd,
                utc: format_utc(jd),
                jd_tt: tt,
                lat_deg: moon.dec_deg,
                lon_deg: skyfix_core::units::norm_180(-moon.gha_deg),
            },
            umbral_magnitude: g.umbral_magnitude,
            penumbral_magnitude: g.penumbral_magnitude,
            gamma: g.gamma,
            saros: search::saros_number(lunation, false),
            lunation,
            contacts,
            penumbral_duration_s: span(g.p1, g.p4),
            partial_duration_s: span(g.u1, g.u4),
            total_duration_s: span(g.u2, g.u3),
            delta_t_s: self.delta_t_s(jd),
        };
        Ok(Some(LunarModel { el, g, summary }))
    }

    /// Every eclipse whose greatest eclipse falls in `[jd_start, jd_end]` (UTC), in
    /// time order. The window is clipped to the coverage.
    pub fn find(&self, jd_start: f64, jd_end: f64) -> Result<EclipseList, EclipseError> {
        if !jd_start.is_finite() || !jd_end.is_finite() || jd_end < jd_start {
            return Err(EclipseError::Input(format!(
                "eclipse window must be finite with jd_end >= jd_start (got {jd_start}, {jd_end})"
            )));
        }
        let (a, b) = (
            jd_start.max(coverage_start_jd()),
            jd_end.min(coverage_end_jd()),
        );
        let truncated = a > jd_start || b < jd_end;
        let mut eclipses = Vec::new();
        if a <= b {
            // Candidates by estimated TT instant, widened by a day either side.
            let (ta, tb) = (jd_tt(a) - 1.0, jd_tt(b) + 1.0);
            for c in search::candidates(ta, tb, true) {
                if let Some(m) = self.solar_model(&c)?
                    && (a..=b).contains(&m.summary.greatest.jd_utc)
                {
                    eclipses.push(Eclipse::Solar(m.summary));
                }
            }
            for c in search::candidates(ta, tb, false) {
                if let Some(m) = self.lunar_model(&c)?
                    && (a..=b).contains(&m.summary.greatest.jd_utc)
                {
                    eclipses.push(Eclipse::Lunar(m.summary));
                }
            }
        }
        eclipses.sort_by(|x, y| x.jd_utc().total_cmp(&y.jd_utc()));
        Ok(EclipseList {
            jd_start: a,
            jd_end: b,
            truncated,
            coverage_start_utc: COVERAGE_START_UTC.to_string(),
            coverage_end_utc: COVERAGE_END_UTC.to_string(),
            eclipses,
            conventions: EclipseConventions::current(),
        })
    }

    fn model(&self, id: &str) -> Result<Model, EclipseError> {
        let bad = || EclipseError::BadId(id.to_string());
        let id = id.trim();
        let (date, kind) = id.rsplit_once('-').ok_or_else(bad)?;
        let solar = match kind {
            "solar" => true,
            "lunar" => false,
            _ => return Err(bad()),
        };
        let parts: Vec<&str> = date.split('-').collect();
        if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
            return Err(bad());
        }
        let y: i32 = parts[0].parse().map_err(|_| bad())?;
        let m: u32 = parts[1].parse().map_err(|_| bad())?;
        let d: u32 = parts[2].parse().map_err(|_| bad())?;
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return Err(bad());
        }
        let jd0 = civil_to_jd(y, m, d);
        // A date like 2024-02-31 would silently roll over: refuse it.
        if date_of(jd0 + 0.5) != date {
            return Err(bad());
        }
        let not_found = || EclipseError::NotFound {
            kind: if solar { "solar" } else { "lunar" },
            date: date.to_string(),
        };
        if jd0 + 1.0 < coverage_start_jd() || jd0 > coverage_end_jd() {
            return Err(not_found());
        }
        let want = format!("{date}-{kind}");
        let (ta, tb) = (jd_tt(jd0) - 1.0, jd_tt(jd0) + 2.0);
        for c in search::candidates(ta, tb, solar) {
            if solar {
                if let Some(m) = self.solar_model(&c)?
                    && m.summary.id == want
                {
                    return Ok(Model::Solar(Box::new(m)));
                }
            } else if let Some(m) = self.lunar_model(&c)?
                && m.summary.id == want
            {
                return Ok(Model::Lunar(Box::new(m)));
            }
        }
        Err(not_found())
    }

    /// One eclipse by id.
    pub fn by_id(&self, id: &str) -> Result<Eclipse, EclipseError> {
        Ok(match self.model(id)? {
            Model::Solar(m) => Eclipse::Solar(m.summary),
            Model::Lunar(m) => Eclipse::Lunar(m.summary),
        })
    }

    /// Local circumstances of eclipse `id` at `site`.
    pub fn local(&self, id: &str, site: &Site) -> Result<EclipseLocal, EclipseError> {
        check_site(site)?;
        let observer = ObserverEcho {
            lat_deg: site.lat_deg,
            lon_deg: site.lon_deg,
            height_m: site.height_m,
        };
        Ok(match self.model(id)? {
            Model::Solar(m) => {
                let r = local::solar_local(&m.el, &self.sun, site)?;
                EclipseLocal::Solar(SolarLocal {
                    id: m.summary.id.clone(),
                    observer,
                    visibility: r.visibility,
                    local_type: r.local_type,
                    magnitude: r.magnitude,
                    obscuration: r.obscuration,
                    duration_s: r.duration_s,
                    central_duration_s: r.central_duration_s,
                    events: r.events,
                    visible_max: r.visible_max,
                    delta_t_s: m.summary.delta_t_s,
                })
            }
            Model::Lunar(m) => {
                let r = local::lunar_local(&m.el, &m.g, &self.moon, site)?;
                EclipseLocal::Lunar(LunarLocal {
                    id: m.summary.id.clone(),
                    observer,
                    visibility: r.visibility,
                    events: r.events,
                    delta_t_s: m.summary.delta_t_s,
                })
            }
        })
    }

    /// Paths of eclipse `id` on the map (solar), or the sub-lunar points (lunar).
    pub fn path(&self, id: &str) -> Result<EclipsePath, EclipseError> {
        Ok(match self.model(id)? {
            Model::Solar(m) => {
                let (el, g) = (&m.el, &m.g);
                EclipsePath::Solar(Box::new(SolarPath {
                    id: m.summary.id.clone(),
                    eclipse_type: m.summary.eclipse_type,
                    central: m.summary.central,
                    greatest: m.summary.greatest.clone(),
                    central_line: path::central_line(el, g),
                    umbra_north: path::limit_line(el, g, path::Cone::Umbra, true),
                    umbra_south: path::limit_line(el, g, path::Cone::Umbra, false),
                    umbra_horizon: path::horizon_curves(el, g, path::Cone::Umbra),
                    penumbra_north: path::limit_line(el, g, path::Cone::Penumbra, true),
                    penumbra_south: path::limit_line(el, g, path::Cone::Penumbra, false),
                    penumbra_horizon: path::horizon_curves(el, g, path::Cone::Penumbra),
                    delta_t_s: m.summary.delta_t_s,
                }))
            }
            Model::Lunar(m) => {
                let mut sublunar = Vec::new();
                for (kind, t) in [
                    (LocalEventKind::P1, m.g.p1),
                    (LocalEventKind::U1, m.g.u1),
                    (LocalEventKind::U2, m.g.u2),
                    (LocalEventKind::Max, Some(m.g.t_ge)),
                    (LocalEventKind::U3, m.g.u3),
                    (LocalEventKind::U4, m.g.u4),
                    (LocalEventKind::P4, m.g.p4),
                ] {
                    let Some(t) = t else { continue };
                    let jd = m.el.jd(t);
                    let p = self.moon.position(jd)?;
                    sublunar.push(SublunarPoint {
                        kind,
                        jd_utc: jd,
                        utc: format_utc(jd),
                        lat_deg: p.dec_deg,
                        lon_deg: skyfix_core::units::norm_180(-p.gha_deg),
                    });
                }
                EclipsePath::Lunar(LunarPath {
                    id: m.summary.id.clone(),
                    eclipse_type: m.summary.eclipse_type,
                    sublunar,
                    delta_t_s: m.summary.delta_t_s,
                })
            }
        })
    }
}
