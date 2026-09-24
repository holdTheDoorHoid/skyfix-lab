//! Rise, set, transit, twilight, sky phases, Moon phases, seasons, altitude crossings.
//!
//! OWNER: events agent. CONVENTIONS 13.3 to 13.5; wire format in EXPLORER_API.md.
//!
//! # Definitions (CONVENTIONS 13.3)
//!
//! Every event is an instant in UTC at which the **topocentric geometric altitude of
//! the body's centre** (`alt_deg`: WGS84 site, parallax applied, no refraction; see
//! [`skyfix_ephemeris::topocentric::horizontal`]) crosses a threshold `h0`:
//!
//! | body | `h0`, standard horizon |
//! |---|---|
//! | Sun | -50' |
//! | Moon | -34' - SD, SD the Moon's geocentric semidiameter at that instant |
//! | planets, stars | -34' |
//!
//! With `horizon = dip`, `h0` is lowered by `1.76' sqrt(height_of_eye_m)`. Twilight is
//! the Sun's centre at -6, -12 and -18 degrees (never with dip); dawn crosses upward,
//! dusk downward. Upper transit is `LHA = 0` and lower transit `LHA = 180` from the
//! apparent geocentric GHA (the Nautical Almanac's meridian passage). A body that never
//! crosses its `h0` inside the window is `always_above` or `always_below`; the edges of
//! the window never create events.
//!
//! # Method
//!
//! 1. The body's apparent geocentric state is evaluated exactly every 3 hours (the
//!    Moon), 4 hours (planets) or 8 hours (the Sun and stars) and interpolated in
//!    between ([`crate::sky`]'s track, under 0.01" of error), so the finder can afford
//!    a fine grid and many
//!    refinement steps. The topocentric step (Earth rotation, parallax, refraction)
//!    is exact at every evaluation.
//! 2. The altitude is sampled on a **10-minute grid** (CONVENTIONS 13.3 requires no
//!    coarser than 10 minutes for the Moon and 20 for the rest; this uses 10 for
//!    all), plus one sample beyond each end of the window.
//! 3. Every local extremum of the altitude on that grid is located to half a second
//!    (Brent's minimiser) and added to the samples. This is what makes grazing cases
//!    work: a Sun that dips below `h0` for three minutes at lower culmination near
//!    the midnight-sun latitude crosses twice inside one grid interval, which a plain
//!    sign scan would miss; the extremum sample splits the two crossings.
//! 4. Each sign change of `alt - h0` between consecutive samples is refined with
//!    Brent's method to **1 ms** (CONVENTIONS asks for 1 s or better).
//! 5. The altitude and azimuth reported with each event are the track's at the
//!    instant found: they agree with `sky_state` at that instant to under 0.01"
//!    (`tests/events_logic.rs`), without another call to the provider — which would
//!    otherwise double the cost of a year of events for an expensive body.
//!
//! Everything is generic over [`BodyEphemeris`], so the same code runs on the real
//! [`skyfix_ephemeris::body::Sky`] and on the synthetic Moon of the test suite.

mod roots;

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc, jd_tt};
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{self, ApparentState, BodyEphemeris, BodyKind, MOON, SUN};
use skyfix_ephemeris::frames::true_obliquity_rad;
use skyfix_ephemeris::topocentric::{Site, horizontal};

use crate::sky::track::Track;
pub use crate::sky::{
    ASTRONOMICAL_TWILIGHT_DEG, AlmanacError, BodyError, CIVIL_TWILIGHT_DEG,
    HORIZON_REFRACTION_ARCMIN, NAUTICAL_TWILIGHT_DEG, SUN_RISE_SET_DEG, SkyPhase, sky_phase,
};
use crate::sky::{check_jd, checked_site};
use roots::{brent_min, brent_root};

/// Spacing of the bracketing grid, minutes (CONVENTIONS 13.3: at most 10 for the Moon,
/// 20 for everything else).
pub const GRID_MINUTES: f64 = 10.0;
const GRID_DAYS: f64 = GRID_MINUTES / 1440.0;
/// Event instants are refined to this, days (1 ms; an `f64` Julian date resolves 40
/// microseconds).
const ROOT_TOL_DAYS: f64 = 0.001 / 86_400.0;
/// Altitude extrema are located to this, days (0.5 s).
const EXTREMUM_TOL_DAYS: f64 = 0.5 / 86_400.0;
/// Longest window `day_events` and `find_altitude` accept, days.
pub const MAX_WINDOW_DAYS: f64 = 400.0;
/// Most windows `day_events_batch` accepts (EXPLORER_API.md: a year of days).
pub const MAX_WINDOWS: usize = 400;
/// Dip of the sea horizon, arcminutes per square root of metres (CONVENTIONS 5).
pub const DIP_ARCMIN_PER_SQRT_M: f64 = 1.76;

// ---------------------------------------------------------------------------
// Options and wire types
// ---------------------------------------------------------------------------

/// Which horizon rise and set are measured against (CONVENTIONS 13.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Horizon {
    /// The sea-level horizon: `h0` exactly as tabulated.
    #[default]
    Standard,
    /// The sea horizon seen from `height_of_eye_m`: `h0` lowered by the dip.
    Dip,
}

/// `options_json` of `day_events`: `{"horizon": "standard" | "dip", "height_of_eye_m": 0}`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EventOptions {
    pub horizon: Horizon,
    /// Used only with `horizon = dip`.
    pub height_of_eye_m: f64,
}

impl Default for EventOptions {
    fn default() -> Self {
        EventOptions {
            horizon: Horizon::Standard,
            height_of_eye_m: 0.0,
        }
    }
}

impl EventOptions {
    /// The options if they are usable: `height_of_eye_m` finite and within 0 .. 10 000.
    pub fn checked(&self) -> Result<Self, AlmanacError> {
        let h = self.height_of_eye_m;
        if !(h.is_finite() && (0.0..=10_000.0).contains(&h)) {
            return Err(AlmanacError::invalid(format!(
                "height_of_eye_m must be between 0 and 10000 m, got {h}"
            )));
        }
        Ok(*self)
    }

    /// How far rise/set `h0` is lowered, degrees: `1.76' sqrt(height_of_eye_m)` with
    /// `horizon = dip`, zero otherwise. Twilight never uses it.
    pub fn dip_deg(&self) -> f64 {
        match self.horizon {
            Horizon::Standard => 0.0,
            Horizon::Dip => DIP_ARCMIN_PER_SQRT_M * self.height_of_eye_m.sqrt() / 60.0,
        }
    }
}

/// Event kinds, in the order used to break ties between simultaneous events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    AstronomicalDawn,
    NauticalDawn,
    CivilDawn,
    Rise,
    Transit,
    Set,
    CivilDusk,
    NauticalDusk,
    AstronomicalDusk,
    LowerTransit,
}

/// One event. `alt_deg` / `az_deg` are the topocentric geometric altitude and azimuth
/// of the body's centre at that instant (from the body's interpolated track, within
/// 0.01" of `sky_state` at the same instant).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkyEvent {
    pub kind: EventKind,
    pub jd_utc: f64,
    pub utc: String,
    pub alt_deg: f64,
    pub az_deg: f64,
}

/// A stretch of the window with one sky phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhaseSegment {
    pub jd_start: f64,
    pub jd_end: f64,
    pub phase: SkyPhase,
}

/// Everything that happens to one body inside the window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyEvents {
    pub body: String,
    /// Sorted by time; ties in [`EventKind`] order.
    pub events: Vec<SkyEvent>,
    /// Never crosses its rise/set altitude in the window and is above it throughout.
    pub always_above: bool,
    /// Never crosses its rise/set altitude in the window and is below it throughout.
    pub always_below: bool,
    /// The Sun only: hours above its rise/set altitude inside the window.
    pub day_length_h: Option<f64>,
}

/// `day_events` result (EXPLORER_API.md `DayEvents`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayEvents {
    pub jd_start: f64,
    pub jd_end: f64,
    /// A contiguous, time-ordered cover of the whole window.
    pub phases: Vec<PhaseSegment>,
    pub bodies: Vec<BodyEvents>,
    pub errors: Vec<BodyError>,
}

/// One `find_altitude` crossing. `alt_deg` is the topocentric **geometric** altitude
/// at that instant, like every other `alt_deg`; it is the requested *apparent*
/// altitude minus the display refraction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AltitudeCrossing {
    pub jd_utc: f64,
    pub utc: String,
    pub alt_deg: f64,
    pub az_deg: f64,
    pub rising: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoonPhaseKind {
    NewMoon,
    FirstQuarter,
    FullMoon,
    LastQuarter,
}

/// A principal phase of the Moon (CONVENTIONS 13.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhaseEvent {
    pub kind: MoonPhaseKind,
    pub jd_utc: f64,
    pub utc: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeasonKind {
    MarchEquinox,
    JuneSolstice,
    SeptemberEquinox,
    DecemberSolstice,
}

/// An equinox or solstice (CONVENTIONS 13.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeasonEvent {
    pub kind: SeasonKind,
    pub jd_utc: f64,
    pub utc: String,
}

/// `sidereal` result.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Sidereal {
    pub gha_aries_deg: f64,
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/// The rise/set altitude of a body's centre on the standard horizon, degrees
/// (CONVENTIONS 13.3): -50' for the Sun, `-34' - SD` for the Moon, -34' otherwise.
pub fn standard_altitude_deg(kind: BodyKind, semidiameter_arcmin: f64) -> f64 {
    match kind {
        BodyKind::Sun => SUN_RISE_SET_DEG,
        BodyKind::Moon => -(HORIZON_REFRACTION_ARCMIN + semidiameter_arcmin) / 60.0,
        BodyKind::Planet | BodyKind::Star => -HORIZON_REFRACTION_ARCMIN / 60.0,
    }
}

const TWILIGHTS: [(f64, EventKind, EventKind); 3] = [
    (
        CIVIL_TWILIGHT_DEG,
        EventKind::CivilDawn,
        EventKind::CivilDusk,
    ),
    (
        NAUTICAL_TWILIGHT_DEG,
        EventKind::NauticalDawn,
        EventKind::NauticalDusk,
    ),
    (
        ASTRONOMICAL_TWILIGHT_DEG,
        EventKind::AstronomicalDawn,
        EventKind::AstronomicalDusk,
    ),
];

/// The thresholds that bound the sky phases (CONVENTIONS 13.4). Never dipped.
const PHASE_BOUNDS_DEG: [f64; 4] = [
    SUN_RISE_SET_DEG,
    CIVIL_TWILIGHT_DEG,
    NAUTICAL_TWILIGHT_DEG,
    ASTRONOMICAL_TWILIGHT_DEG,
];

// ---------------------------------------------------------------------------
// Sampling a body along its track
// ---------------------------------------------------------------------------

/// A body's topocentric state at `x` days after the window start.
#[derive(Debug, Clone, Copy)]
struct Sample {
    x: f64,
    alt: f64,
    alt_app: f64,
    az: f64,
    sd: f64,
    gha: f64,
}

/// Evaluates one body's track from one site. Keeps a scratch state so no evaluation
/// allocates.
struct Probe<'a> {
    track: &'a Track,
    site: &'a Site,
    t0: f64,
    scratch: ApparentState,
}

impl<'a> Probe<'a> {
    fn new(track: &'a Track, site: &'a Site, t0: f64) -> Self {
        Probe {
            track,
            site,
            t0,
            scratch: track.template().clone(),
        }
    }

    fn at(&mut self, x: f64) -> Sample {
        self.track.fill(self.t0 + x, &mut self.scratch);
        let h = horizontal(&self.scratch, self.site);
        Sample {
            x,
            alt: h.alt_deg,
            alt_app: h.alt_apparent_deg,
            az: h.az_deg,
            sd: self.scratch.semidiameter_arcmin,
            gha: self.scratch.gha_deg,
        }
    }
}

/// The bracketing samples over `[0, span]`: the grid, plus every altitude extremum
/// inside the window, sorted by time.
fn scan(probe: &mut Probe, span: f64) -> Vec<Sample> {
    let n = (span / GRID_DAYS).ceil().max(1.0) as usize;
    let dx = span / n as f64;
    // grid[k] is at x = (k - 1) dx: one sample before the window and one after it, so
    // an extremum within a grid step of either edge is still seen.
    let grid: Vec<Sample> = (0..n + 3)
        .map(|k| {
            let x = if k == n + 1 {
                span
            } else {
                (k as f64 - 1.0) * dx
            };
            probe.at(x)
        })
        .collect();
    let mut out: Vec<Sample> = grid[1..=n + 1].to_vec();
    for k in 1..=n + 1 {
        let (a, b, c) = (grid[k - 1].alt, grid[k].alt, grid[k + 1].alt);
        let sign = if b >= a && b > c {
            -1.0 // a maximum: minimise -alt
        } else if b <= a && b < c {
            1.0
        } else {
            continue;
        };
        let (xe, _) = brent_min(
            |x| sign * probe.at(x).alt,
            grid[k - 1].x,
            grid[k + 1].x,
            EXTREMUM_TOL_DAYS,
        );
        if xe > 0.0 && xe < span {
            out.push(probe.at(xe));
        }
    }
    out.sort_by(|p, q| p.x.total_cmp(&q.x));
    out
}

/// Where `g` changes sign along `samples`, refined to [`ROOT_TOL_DAYS`]:
/// `(x, rising)`. `g >= 0` counts as above.
fn crossings(
    samples: &[Sample],
    probe: &mut Probe,
    g: impl Fn(&Sample) -> f64,
) -> Vec<(f64, bool)> {
    let mut out = Vec::new();
    for w in samples.windows(2) {
        let (ga, gb) = (g(&w[0]), g(&w[1]));
        let (above_a, above_b) = (ga >= 0.0, gb >= 0.0);
        if above_a != above_b {
            let x = brent_root(|x| g(&probe.at(x)), w[0].x, w[1].x, ga, gb, ROOT_TOL_DAYS);
            out.push((x, above_b));
        }
    }
    out
}

/// Instants when `LHA - offset` passes 0 going forward (upper transit for offset 0,
/// lower for 180). LHA only ever increases, so each is a clean sign change.
fn meridian_passages(samples: &[Sample], probe: &mut Probe, lon_deg: f64, offset: f64) -> Vec<f64> {
    let u = |s: &Sample| norm_180(s.gha + lon_deg - offset);
    let mut out = Vec::new();
    for w in samples.windows(2) {
        let (ua, ub) = (u(&w[0]), u(&w[1]));
        if ua < 0.0 && ub >= 0.0 && ub - ua < 90.0 {
            out.push(brent_root(
                |x| u(&probe.at(x)),
                w[0].x,
                w[1].x,
                ua,
                ub,
                ROOT_TOL_DAYS,
            ));
        }
    }
    out
}

fn check_window(jd_start: f64, jd_end: f64) -> Result<(), AlmanacError> {
    check_jd("jd_start", jd_start)?;
    check_jd("jd_end", jd_end)?;
    if jd_end <= jd_start {
        return Err(AlmanacError::invalid(format!(
            "the window must end after it starts: jd_start {jd_start}, jd_end {jd_end}"
        )));
    }
    if jd_end - jd_start > MAX_WINDOW_DAYS {
        return Err(AlmanacError::invalid(format!(
            "the window is {:.1} days long; at most {MAX_WINDOW_DAYS} days",
            jd_end - jd_start
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// day_events
// ---------------------------------------------------------------------------

/// The events one body's track yields, as offsets from the window start.
struct Found {
    events: Vec<(f64, EventKind)>,
    always_above: bool,
    always_below: bool,
    /// Days above the rise/set altitude, for the Sun.
    above_days: f64,
}

/// Crossings of constant altitudes, each solved at most once: the Sun's rise/set and
/// twilight events and the sky phases share the same four thresholds.
#[derive(Default)]
struct CrossingCache {
    entries: Vec<(u64, Vec<(f64, bool)>)>,
}

impl CrossingCache {
    fn get(&mut self, samples: &[Sample], probe: &mut Probe, deg: f64) -> Vec<(f64, bool)> {
        if let Some((_, v)) = self.entries.iter().find(|(k, _)| *k == deg.to_bits()) {
            return v.clone();
        }
        let v = crossings(samples, probe, |s| s.alt - deg);
        self.entries.push((deg.to_bits(), v.clone()));
        v
    }
}

fn find_events(
    probe: &mut Probe,
    samples: &[Sample],
    cache: &mut CrossingCache,
    kind: BodyKind,
    lon_deg: f64,
    span: f64,
    dip_deg: f64,
) -> Found {
    let g = |s: &Sample| s.alt - (standard_altitude_deg(kind, s.sd) - dip_deg);
    // Only the Moon's rise/set altitude moves (with its semidiameter).
    let rs = if kind == BodyKind::Moon {
        crossings(samples, probe, g)
    } else {
        cache.get(samples, probe, standard_altitude_deg(kind, 0.0) - dip_deg)
    };
    let mut events: Vec<(f64, EventKind)> = rs
        .iter()
        .map(|&(x, rising)| {
            (
                x,
                if rising {
                    EventKind::Rise
                } else {
                    EventKind::Set
                },
            )
        })
        .collect();
    if kind == BodyKind::Sun {
        for (deg, dawn, dusk) in TWILIGHTS {
            for (x, rising) in cache.get(samples, probe, deg) {
                events.push((x, if rising { dawn } else { dusk }));
            }
        }
    }
    for x in meridian_passages(samples, probe, lon_deg, 0.0) {
        events.push((x, EventKind::Transit));
    }
    for x in meridian_passages(samples, probe, lon_deg, 180.0) {
        events.push((x, EventKind::LowerTransit));
    }

    let above_at_start = g(&samples[0]) >= 0.0;
    let mut above = above_at_start;
    let mut since = 0.0;
    let mut above_days = 0.0;
    for &(x, rising) in &rs {
        if rising {
            since = x;
            above = true;
        } else {
            if above {
                above_days += x - since;
            }
            above = false;
        }
    }
    if above {
        above_days += span - since;
    }
    Found {
        events,
        always_above: rs.is_empty() && above_at_start,
        always_below: rs.is_empty() && !above_at_start,
        above_days,
    }
}

/// Sky phases over the window from the Sun's samples (CONVENTIONS 13.4).
fn phases(
    sun_probe: &mut Probe,
    sun_samples: &[Sample],
    cache: &mut CrossingCache,
    jd_start: f64,
    jd_end: f64,
) -> Vec<PhaseSegment> {
    let span = jd_end - jd_start;
    let mut cuts: Vec<f64> = Vec::new();
    for deg in PHASE_BOUNDS_DEG {
        cuts.extend(
            cache
                .get(sun_samples, sun_probe, deg)
                .into_iter()
                .map(|(x, _)| x),
        );
    }
    cuts.retain(|&x| x > 0.0 && x < span);
    cuts.sort_by(f64::total_cmp);
    let mut bounds = Vec::with_capacity(cuts.len() + 2);
    bounds.push(0.0);
    bounds.extend(cuts);
    bounds.push(span);

    let mut out: Vec<PhaseSegment> = Vec::new();
    for w in bounds.windows(2) {
        if w[1] <= w[0] {
            continue;
        }
        let phase = sky_phase(sun_probe.at(0.5 * (w[0] + w[1])).alt);
        let end = if w[1] == span {
            jd_end
        } else {
            jd_start + w[1]
        };
        match out.last_mut() {
            Some(last) if last.phase == phase => last.jd_end = end,
            _ => out.push(PhaseSegment {
                jd_start: out.last().map_or(jd_start, |l| l.jd_end),
                jd_end: end,
                phase,
            }),
        }
    }
    out
}

/// Rise, set, transits and (for the Sun) twilight for each body over
/// `[jd_start, jd_end]`, and the sky phases over the same window (EXPLORER_API.md
/// `day_events`). `bodies` are canonical names ([`crate::sky::resolve_bodies`]).
///
/// The Sun is always computed because the phases come from it; if it cannot be (the
/// window reaches outside its coverage) the call fails with
/// [`AlmanacError::Unavailable`]. Any other body the provider fails on is listed in
/// `errors`.
pub fn day_events(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_start: f64,
    jd_end: f64,
    bodies: &[&str],
    options: &EventOptions,
) -> Result<DayEvents, AlmanacError> {
    let site = checked_site(site)?;
    let options = options.checked()?;
    check_window(jd_start, jd_end)?;
    let span = jd_end - jd_start;
    let dip_deg = options.dip_deg();

    // Sun first (always), then every other requested body once.
    let mut names: Vec<&str> = vec![SUN];
    for &b in bodies {
        if !names.contains(&b) {
            names.push(b);
        }
    }
    let mut tracks = Track::build_many(eph, &names, jd_start, jd_end);
    let sun_track = std::mem::replace(
        &mut tracks[0],
        Err(BodyError {
            body: String::new(),
            message: String::new(),
        }),
    )
    .map_err(|e| AlmanacError::Unavailable {
        body: SUN.to_string(),
        message: format!(
            "{}; the Sun defines the day's phases, so no events can be given for this \
             window",
            e.message
        ),
    })?;
    let mut sun_probe = Probe::new(&sun_track, &site, jd_start);
    let sun_samples = scan(&mut sun_probe, span);
    let mut sun_cache = CrossingCache::default();

    let mut out = DayEvents {
        jd_start,
        jd_end,
        phases: phases(
            &mut sun_probe,
            &sun_samples,
            &mut sun_cache,
            jd_start,
            jd_end,
        ),
        bodies: Vec::with_capacity(bodies.len()),
        errors: Vec::new(),
    };

    let mut seen: Vec<&str> = Vec::new();
    for &name in bodies {
        if seen.contains(&name) {
            continue;
        }
        seen.push(name);
        let idx = names.iter().position(|n| *n == name).unwrap_or(0);
        let kind = body::kind(name).unwrap_or(BodyKind::Star);
        let body_events = if name == SUN {
            let found = find_events(
                &mut sun_probe,
                &sun_samples,
                &mut sun_cache,
                kind,
                site.lon_deg,
                span,
                dip_deg,
            );
            finish(&mut sun_probe, name, kind, found, jd_end)
        } else {
            match &tracks[idx] {
                Ok(track) => {
                    let mut probe = Probe::new(track, &site, jd_start);
                    let samples = scan(&mut probe, span);
                    let found = find_events(
                        &mut probe,
                        &samples,
                        &mut CrossingCache::default(),
                        kind,
                        site.lon_deg,
                        span,
                        dip_deg,
                    );
                    finish(&mut probe, name, kind, found, jd_end)
                }
                Err(e) => {
                    out.errors.push(e.clone());
                    continue;
                }
            }
        };
        out.bodies.push(body_events);
    }
    Ok(out)
}

/// Turn found instants into events, with the altitude and azimuth of the body's track
/// at each instant (within 0.01" of an exact evaluation; see the `sky::track` docs).
fn finish(probe: &mut Probe, name: &str, kind: BodyKind, found: Found, jd_end: f64) -> BodyEvents {
    let mut events: Vec<SkyEvent> = found
        .events
        .into_iter()
        .map(|(x, ek)| {
            let s = probe.at(x);
            let t = (probe.t0 + x).min(jd_end);
            SkyEvent {
                kind: ek,
                jd_utc: t,
                utc: format_utc(t),
                alt_deg: s.alt,
                az_deg: s.az,
            }
        })
        .collect();
    events.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc).then(a.kind.cmp(&b.kind)));
    BodyEvents {
        body: name.to_string(),
        events,
        always_above: found.always_above,
        always_below: found.always_below,
        day_length_h: (kind == BodyKind::Sun).then_some(found.above_days * 24.0),
    }
}

/// [`day_events`] for each window in turn (EXPLORER_API.md `day_events_batch`), at
/// most [`MAX_WINDOWS`].
pub fn day_events_batch(
    eph: &dyn BodyEphemeris,
    site: &Site,
    windows: &[(f64, f64)],
    bodies: &[&str],
    options: &EventOptions,
) -> Result<Vec<DayEvents>, AlmanacError> {
    if windows.len() > MAX_WINDOWS {
        return Err(AlmanacError::invalid(format!(
            "{} windows requested; at most {MAX_WINDOWS}",
            windows.len()
        )));
    }
    // One window the Sun cannot cover (e.g. the last local day of 2060 west of
    // Greenwich runs past the providers' coverage) must not sink the other 399. Such
    // a window comes back with no phases and no bodies and the reason in `errors`;
    // malformed input still fails the whole call (EXPLORER_API.md, day_events_batch).
    windows
        .iter()
        .map(
            |&(a, b)| match day_events(eph, site, a, b, bodies, options) {
                Err(AlmanacError::Unavailable { body, message }) => Ok(DayEvents {
                    jd_start: a,
                    jd_end: b,
                    phases: Vec::new(),
                    bodies: Vec::new(),
                    errors: vec![BodyError { body, message }],
                }),
                other => other,
            },
        )
        .collect()
}

// ---------------------------------------------------------------------------
// find_altitude
// ---------------------------------------------------------------------------

/// Every instant in `[jd_start, jd_end]` at which `body`'s **apparent** topocentric
/// altitude (`alt_apparent_deg`, with the site's display refraction) crosses
/// `altitude_deg` (EXPLORER_API.md `find_altitude`): "when is the Sun at 30 degrees
/// this afternoon?". Fails with [`AlmanacError::Unavailable`] if the body cannot be
/// computed over the window.
pub fn find_altitude(
    eph: &dyn BodyEphemeris,
    site: &Site,
    body: &str,
    jd_start: f64,
    jd_end: f64,
    altitude_deg: f64,
) -> Result<Vec<AltitudeCrossing>, AlmanacError> {
    let site = checked_site(site)?;
    check_window(jd_start, jd_end)?;
    if !(altitude_deg.is_finite() && (-90.0..=90.0).contains(&altitude_deg)) {
        return Err(AlmanacError::invalid(format!(
            "altitude_deg must be between -90 and 90, got {altitude_deg}"
        )));
    }
    let name = crate::sky::resolve_bodies(&[body])?[0];
    let track = Track::build_many(eph, &[name], jd_start, jd_end)
        .pop()
        .expect("one track per body")?;
    let mut probe = Probe::new(&track, &site, jd_start);
    let samples = scan(&mut probe, jd_end - jd_start);
    let found = crossings(&samples, &mut probe, |s| s.alt_app - altitude_deg);
    Ok(found
        .into_iter()
        .map(|(x, rising)| {
            let s = probe.at(x);
            let t = (jd_start + x).min(jd_end);
            AltitudeCrossing {
                jd_utc: t,
                utc: format_utc(t),
                alt_deg: s.alt,
                az_deg: s.az,
                rising,
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Moon phases and seasons (CONVENTIONS 13.5)
// ---------------------------------------------------------------------------

/// Apparent geocentric ecliptic longitude, ecliptic and equinox of date, degrees
/// `[0, 360)`, from an apparent RA/Dec of date and the true obliquity `eps_rad`.
pub fn ecliptic_longitude_deg(ra_deg: f64, dec_deg: f64, eps_rad: f64) -> f64 {
    let (sa, ca) = ra_deg.to_radians().sin_cos();
    let (sd, cd) = dec_deg.to_radians().sin_cos();
    let (se, ce) = eps_rad.sin_cos();
    norm_360((cd * sa * ce + sd * se).atan2(cd * ca).to_degrees())
}

fn unavailable(body: &str, e: impl std::fmt::Display) -> AlmanacError {
    AlmanacError::Unavailable {
        body: body.to_string(),
        message: e.to_string(),
    }
}

/// Instants in `[t0, t1]` at which an increasing angle `f(t)` (degrees, any turn)
/// passes a multiple of 90 degrees, with the quarter `0..=3` it reaches. `step_days`
/// must be short enough that `f` advances less than 90 degrees per step.
fn quarter_crossings(
    mut f: impl FnMut(f64) -> Result<f64, AlmanacError>,
    t0: f64,
    t1: f64,
    step_days: f64,
) -> Result<Vec<(f64, u32)>, AlmanacError> {
    let span = t1 - t0;
    let n = (span / step_days).ceil().max(1.0) as usize;
    let dx = span / n as f64;
    let mut out = Vec::new();
    let mut xa = 0.0;
    let mut fa = norm_360(f(t0)?);
    for k in 1..=n {
        let xb = if k == n { span } else { k as f64 * dx };
        let fb_raw = norm_360(f(t0 + xb)?);
        let fb = fa + norm_360(fb_raw - fa);
        let mut q = (fa / 90.0).floor() + 1.0;
        while q * 90.0 <= fb {
            let target = q * 90.0;
            let mut failure: Option<AlmanacError> = None;
            let x = brent_root(
                |x| match f(t0 + x) {
                    Ok(v) => norm_180(v - target),
                    Err(e) => {
                        failure.get_or_insert(e);
                        0.0
                    }
                },
                xa,
                xb,
                norm_180(fa - target),
                norm_180(fb - target),
                ROOT_TOL_DAYS,
            );
            if let Some(e) = failure {
                return Err(e);
            }
            out.push((t0 + x, (q as i64).rem_euclid(4) as u32));
            q += 1.0;
        }
        xa = xb;
        fa = fb_raw;
    }
    Ok(out)
}

/// New moon, first quarter, full moon and last quarter in `[jd_start, jd_end]`: the
/// instants when the Moon's apparent geocentric ecliptic longitude minus the Sun's
/// (ecliptic and equinox of date) is 0, 90, 180 and 270 degrees (CONVENTIONS 13.5).
///
/// Fails with [`AlmanacError::Unavailable`] when the provider cannot give the Moon or
/// the Sun over the window (the Moon provider is a stub until its agent lands).
pub fn moon_phases(
    eph: &dyn BodyEphemeris,
    jd_start: f64,
    jd_end: f64,
) -> Result<Vec<PhaseEvent>, AlmanacError> {
    check_jd("jd_start", jd_start)?;
    check_jd("jd_end", jd_end)?;
    if jd_end <= jd_start {
        return Err(AlmanacError::invalid(format!(
            "the window must end after it starts: jd_start {jd_start}, jd_end {jd_end}"
        )));
    }
    let elongation = |t: f64| -> Result<f64, AlmanacError> {
        let m = eph
            .apparent_state(MOON, t)
            .map_err(|e| unavailable(MOON, e))?;
        let s = eph
            .apparent_state(SUN, t)
            .map_err(|e| unavailable(SUN, e))?;
        let eps = true_obliquity_rad(jd_tt(t));
        Ok(ecliptic_longitude_deg(m.ra_deg, m.dec_deg, eps)
            - ecliptic_longitude_deg(s.ra_deg, s.dec_deg, eps))
    };
    // The elongation grows 10.8 to 14.4 degrees a day: two days is always < 90.
    Ok(quarter_crossings(elongation, jd_start, jd_end, 2.0)?
        .into_iter()
        .map(|(t, q)| PhaseEvent {
            kind: match q {
                0 => MoonPhaseKind::NewMoon,
                1 => MoonPhaseKind::FirstQuarter,
                2 => MoonPhaseKind::FullMoon,
                _ => MoonPhaseKind::LastQuarter,
            },
            jd_utc: t,
            utc: format_utc(t),
        })
        .collect())
}

/// The March and September equinoxes and the June and December solstices of a
/// calendar year: the instants when the Sun's apparent geocentric ecliptic longitude
/// (ecliptic and equinox of date) is 0, 90, 180 and 270 degrees (CONVENTIONS 13.5).
pub fn seasons(eph: &dyn BodyEphemeris, year: i32) -> Result<Vec<SeasonEvent>, AlmanacError> {
    if !(-4000..=10_000).contains(&year) {
        return Err(AlmanacError::invalid(format!(
            "year {year} is outside -4000 .. 10000"
        )));
    }
    let t0 = civil_to_jd(year, 1, 1);
    let t1 = civil_to_jd(year + 1, 1, 1);
    let longitude = |t: f64| -> Result<f64, AlmanacError> {
        let s = eph
            .apparent_state(SUN, t)
            .map_err(|e| unavailable(SUN, e))?;
        Ok(ecliptic_longitude_deg(
            s.ra_deg,
            s.dec_deg,
            true_obliquity_rad(jd_tt(t)),
        ))
    };
    // The Sun gains about a degree a day: four days is far below 90.
    Ok(quarter_crossings(longitude, t0, t1, 4.0)?
        .into_iter()
        .map(|(t, q)| SeasonEvent {
            kind: match q {
                0 => SeasonKind::MarchEquinox,
                1 => SeasonKind::JuneSolstice,
                2 => SeasonKind::SeptemberEquinox,
                _ => SeasonKind::DecemberSolstice,
            },
            jd_utc: t,
            utc: format_utc(t),
        })
        .collect())
}

/// Greenwich hour angle of Aries (GAST) at `jd_utc`, DUT1 = 0 (CONVENTIONS 6). Cheap:
/// no ephemeris, no coverage limit. Local sidereal angle = `gha_aries + lon_east`.
pub fn sidereal(jd_utc: f64) -> Result<Sidereal, AlmanacError> {
    check_jd("jd_utc", jd_utc)?;
    let gha_aries_deg = skyfix_ephemeris::sidereal::gha_aries_deg(jd_utc, 0.0);
    // Far enough from J2000 the sidereal-time polynomial overflows: say so rather than
    // hand back NaN as an angle.
    if !gha_aries_deg.is_finite() {
        return Err(AlmanacError::invalid(format!(
            "jd_utc {jd_utc} is too far from J2000 for sidereal time"
        )));
    }
    Ok(Sidereal { gha_aries_deg })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_altitudes_follow_conventions_13_3() {
        assert!((standard_altitude_deg(BodyKind::Sun, 16.0) * 60.0 + 50.0).abs() < 1e-12);
        assert!((standard_altitude_deg(BodyKind::Moon, 15.5) * 60.0 + 49.5).abs() < 1e-12);
        assert!((standard_altitude_deg(BodyKind::Star, 0.0) * 60.0 + 34.0).abs() < 1e-12);
        assert!((standard_altitude_deg(BodyKind::Planet, 0.3) * 60.0 + 34.0).abs() < 1e-12);
    }

    #[test]
    fn dip_lowers_the_horizon_only_when_asked() {
        let std = EventOptions {
            horizon: Horizon::Standard,
            height_of_eye_m: 9.0,
        };
        assert_eq!(std.dip_deg(), 0.0);
        let dip = EventOptions {
            horizon: Horizon::Dip,
            height_of_eye_m: 9.0,
        };
        assert!((dip.dip_deg() * 60.0 - 5.28).abs() < 1e-12);
        assert!(
            EventOptions {
                height_of_eye_m: -1.0,
                ..dip
            }
            .checked()
            .is_err()
        );
    }

    #[test]
    fn options_parse_from_the_wire_shape_and_refuse_unknown_fields() {
        let o: EventOptions =
            serde_json::from_str(r#"{"horizon": "dip", "height_of_eye_m": 4}"#).unwrap();
        assert_eq!(o.horizon, Horizon::Dip);
        let d: EventOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(d, EventOptions::default());
        assert!(serde_json::from_str::<EventOptions>(r#"{"horizon": "sea"}"#).is_err());
        assert!(serde_json::from_str::<EventOptions>(r#"{"height": 2}"#).is_err());
    }

    #[test]
    fn event_kinds_serialise_as_documented() {
        let names: Vec<String> = [
            EventKind::AstronomicalDawn,
            EventKind::NauticalDawn,
            EventKind::CivilDawn,
            EventKind::Rise,
            EventKind::Transit,
            EventKind::Set,
            EventKind::CivilDusk,
            EventKind::NauticalDusk,
            EventKind::AstronomicalDusk,
            EventKind::LowerTransit,
        ]
        .iter()
        .map(|k| serde_json::to_string(k).unwrap())
        .collect();
        assert_eq!(
            names.join(","),
            "\"astronomical_dawn\",\"nautical_dawn\",\"civil_dawn\",\"rise\",\"transit\",\
             \"set\",\"civil_dusk\",\"nautical_dusk\",\"astronomical_dusk\",\"lower_transit\""
        );
        assert_eq!(
            serde_json::to_string(&MoonPhaseKind::FirstQuarter).unwrap(),
            "\"first_quarter\""
        );
        assert_eq!(
            serde_json::to_string(&SeasonKind::SeptemberEquinox).unwrap(),
            "\"september_equinox\""
        );
    }

    #[test]
    fn ecliptic_longitude_inverts_the_equatorial_rotation() {
        let eps = 23.44f64.to_radians();
        for lam in [0.0f64, 45.0, 90.0, 179.0, 270.0, 359.5] {
            for beta in [-5.0f64, 0.0, 5.1] {
                let (sl, cl) = lam.to_radians().sin_cos();
                let (sb, cb) = beta.to_radians().sin_cos();
                let (se, ce) = eps.sin_cos();
                let x = cb * cl;
                let y = cb * sl * ce - sb * se;
                let z = cb * sl * se + sb * ce;
                let ra = norm_360(y.atan2(x).to_degrees());
                let dec = z.asin().to_degrees();
                let back = ecliptic_longitude_deg(ra, dec, eps);
                assert!(norm_180(back - lam).abs() < 1e-9, "{lam} {beta}: {back}");
            }
        }
    }

    #[test]
    fn quarter_crossings_finds_each_multiple_of_ninety_once() {
        // 10 degrees a day from 85: crossings at 90, 180, 270, 360, 450 (= 90).
        let f = |t: f64| Ok(85.0 + 10.0 * t);
        let v = quarter_crossings(f, 0.0, 40.0, 2.0).unwrap();
        let got: Vec<(f64, u32)> = v
            .iter()
            .map(|&(t, q)| ((t * 1e6).round() / 1e6, q))
            .collect();
        assert_eq!(
            got,
            vec![(0.5, 1), (9.5, 2), (18.5, 3), (27.5, 0), (36.5, 1)]
        );
    }

    #[test]
    fn sidereal_time_is_gast_with_dut1_zero() {
        let jd = 2_461_308.0;
        let s = sidereal(jd).unwrap();
        assert_eq!(
            s.gha_aries_deg,
            skyfix_ephemeris::sidereal::gha_aries_deg(jd, 0.0)
        );
        assert!(sidereal(f64::NAN).is_err());
        // Verifier regression: a finite but absurd instant returned Ok(NaN).
        for far in [1e308, -1e308] {
            assert!(sidereal(far).is_err(), "{far}");
        }
    }
}
