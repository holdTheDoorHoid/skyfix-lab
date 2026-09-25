//! Lunar occultations of bright stars and planets, with local times.
//!
//! OWNER: moondetail agent (expansion programme P8). Definitions in CONVENTIONS 13.10;
//! wire format in `docs/EXPLORER_API.md`, `occultations`; accuracy in
//! `docs/ACCURACY.md`, "Moon in detail".
//!
//! # What is computed
//!
//! For one observer on the WGS84 ellipsoid and a window of up to 400 days: every
//! disappearance and reappearance of a star or a planet's centre behind the Moon's
//! **mean limb**, the instant when the topocentric angular separation of the body from the
//! Moon's centre equals the Moon's topocentric semidiameter (radius `k a`,
//! `k = 0.2725076`, `a = 6378.14 km`, the ephemeris's own). Real limbs have mountains and
//! valleys of a few kilometres, so real times differ by seconds, and by up to a minute
//! where the body meets the limb obliquely near the Moon's poles; the result says so.
//!
//! Each contact carries its position angle on the limb (from celestial north through
//! east), its vertex angle (from the zenith), the cusp angle (from the nearer cusp,
//! positive on the dark limb, as occultation observers quote it), whether it is at the
//! dark or the bright limb, the Moon's topocentric altitude and azimuth, and the Sun's
//! altitude and the sky phase (CONVENTIONS 13.4). An event whose body passes within 1′ of
//! the limb, inside or outside, is flagged a **graze**; one that misses by under 1′ is
//! reported as a near miss (no contacts), because the real limb may still hide it.
//!
//! # Method
//!
//! 1. The Moon's apparent geocentric position (true equator and equinox of date) is
//!    evaluated once a day and interpolated with eight-point Lagrange polynomials; the
//!    interpolation is within about 0.1 km (0.06″, a tenth of a second of contact time)
//!    of the direct evaluation (unit test), inside the ephemeris's own error, and makes a
//!    year of search cost a few hundred ephemeris calls instead of tens of thousands.
//! 2. Geocentric conjunctions in right ascension with every body that can come within
//!    the Moon's reach (ecliptic latitude within 7°), each refined to the least
//!    geocentric separation, kept when that is under the Moon's horizontal parallax plus
//!    its semidiameter plus 0.2°: the only conjunctions any observer on Earth can see as
//!    an occultation.
//! 3. For each, the topocentric separation minus the topocentric semidiameter is sampled
//!    every 5 minutes over ±5 hours (the observer's parallax moves the event by up to two
//!    hours), its minimum found by Brent's method, and its sign changes refined to 0.01 s.
//!    The observer's position turns with the Earth at the sidereal rate from one exact
//!    sidereal time per event.
//!
//! Stars are the 58 navigational stars (their positions exactly as the rest of the app
//! computes them) and whatever other stars the caller passes: the explorer adds the Bright
//! Star Catalogue's stars brighter than a magnitude limit, joined in the WASM adapter.
//! They are display data (CONVENTIONS 13.6): an occultation is an event, not a sight, so
//! the catalogue's arcsecond positions are ample (1″ is 2 s of time). Planets are the
//! provider's apparent places, their centres.

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, jd_tt, jd_ut1, parse_utc};
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::body::{AU_KM, ApparentState, BodyKind};
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::frames::{
    apply_annual_aberration, apply_annual_parallax, apply_solar_light_deflection,
    proper_motion_from_j2000, radec_from_vector, true_obliquity_rad,
};
use skyfix_ephemeris::moon::{EARTH_EQUATORIAL_RADIUS_KM, MOON_RADIUS_RATIO_K, MoonProvider};
use skyfix_ephemeris::planets::{Planet, PlanetProvider};
use skyfix_ephemeris::sidereal::gast_deg;
use skyfix_ephemeris::stars::{StarFrame, StarProvider};
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::{Site, horizontal};

use crate::eclipses::cheb::{minimise, root};
use crate::libration::{Vec3, angle_deg, dot, norm, north_east, scale, sub, unit, unit_radec};
use crate::sky::{AlmanacError, BodyError, SkyPhase, checked_site, sky_phase};

/// The longest window, days.
pub const MAX_WINDOW_DAYS: f64 = 400.0;
/// A body passing within this of the mean limb (inside or outside) is a graze, arcmin.
pub const GRAZE_ARCMIN: f64 = 1.0;
/// Stars farther than this from the ecliptic of J2000 can never be occulted (the Moon's
/// latitude reaches 5.3°, its parallax 1.0°, its radius 0.3°, and precession moves a
/// star's ecliptic latitude by under 0.1° in 650 years), degrees.
pub const ECLIPTIC_REACH_DEG: f64 = 7.0;
/// What the result says about the limb it uses.
pub const LIMB_NOTE: &str = "Mean lunar limb (a sphere of radius 0.2725076 × 6378.14 km). \
     The real limb's mountains and valleys move the times by seconds, and by up to a \
     minute where the body meets the limb obliquely near the Moon's poles; for a graze, \
     whether the body is hidden at all depends on the real profile.";

const MOON_RADIUS_KM: f64 = MOON_RADIUS_RATIO_K * EARTH_EQUATORIAL_RADIUS_KM;
/// Sample step of the Moon's track, days.
const TRACK_STEP: f64 = 1.0;
/// Lagrange stencil width.
const STENCIL: usize = 8;
/// Half-width of the topocentric search around a geocentric conjunction, days.
const TOPO_HALF_WIDTH: f64 = 5.0 / 24.0;
/// Topocentric sampling step, days (5 minutes).
const TOPO_STEP: f64 = 5.0 / 1440.0;
/// Contact tolerance, days (0.01 s).
const CONTACT_TOL: f64 = 0.01 / 86_400.0;
/// Margin on the geocentric reach test, degrees: covers the coarse tracks' interpolation
/// error (under 0.02° with the steps of [`coarse_step_days`]) with room to spare.
const REACH_MARGIN_DEG: f64 = 0.3;

/// Sampling step of a planet's coarse track, days: its cubic interpolation is then
/// within 0.02° (Mercury), 0.005° (Venus) and 0.01° (the rest), measured over 2025-2027.
fn coarse_step_days(p: Planet) -> f64 {
    match p {
        Planet::Mercury => 4.0,
        Planet::Venus => 8.0,
        _ => 16.0,
    }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/// A star the search can look for, with its catalogue place (ICRS at J2000.0).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StarTarget {
    /// The name the result shows: a proper name, else a designation, else `"HR n"`.
    pub name: String,
    /// Bayer or Flamsteed designation (`"η Tau"`), when there is one.
    pub designation: Option<String>,
    /// Bright Star Catalogue number, when the star comes from it.
    pub hr: Option<u32>,
    pub magnitude: f64,
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
    pub pm_ra_cosdec_mas_yr: f64,
    pub pm_dec_mas_yr: f64,
    pub parallax_mas: f64,
    /// One of the 58 navigational stars: its place then comes from the star provider,
    /// exactly as everywhere else in the app.
    pub navigational: bool,
}

/// Something the Moon can occult.
#[derive(Debug, Clone, PartialEq)]
pub enum OccultationTarget {
    Star(StarTarget),
    Planet(Planet),
}

impl OccultationTarget {
    pub fn name(&self) -> &str {
        match self {
            OccultationTarget::Star(s) => &s.name,
            OccultationTarget::Planet(p) => p.name(),
        }
    }
}

/// The 58 navigational stars as targets.
pub fn navigational_star_targets() -> Vec<OccultationTarget> {
    catalog::navigational_stars()
        .iter()
        .map(|s| {
            OccultationTarget::Star(StarTarget {
                name: s.name.clone(),
                designation: None,
                hr: None,
                magnitude: s.magnitude,
                ra_j2000_deg: s.ra_j2000_deg,
                dec_j2000_deg: s.dec_j2000_deg,
                pm_ra_cosdec_mas_yr: s.pm_ra_cosdec_mas_per_year,
                pm_dec_mas_yr: s.pm_dec_mas_per_year,
                parallax_mas: s.parallax_mas,
                navigational: true,
            })
        })
        .collect()
}

/// Mercury to Neptune as targets.
pub fn planet_targets() -> Vec<OccultationTarget> {
    Planet::ALL
        .into_iter()
        .map(OccultationTarget::Planet)
        .collect()
}

/// Ecliptic latitude of a J2000 catalogue place (mean obliquity of J2000), degrees.
fn ecliptic_latitude_j2000_deg(ra_deg: f64, dec_deg: f64) -> f64 {
    let eps = (23.439_291_1_f64).to_radians();
    let (sa, _ca) = ra_deg.to_radians().sin_cos();
    let (sd, cd) = dec_deg.to_radians().sin_cos();
    (sd * eps.cos() - cd * eps.sin() * sa)
        .clamp(-1.0, 1.0)
        .asin()
        .to_degrees()
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactKind {
    Disappearance,
    Reappearance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Limb {
    Dark,
    Bright,
}

/// A disappearance or a reappearance at the mean limb.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OccultationContact {
    pub kind: ContactKind,
    pub jd_utc: f64,
    pub utc: String,
    /// Where on the limb, from celestial north through east, degrees `[0, 360)`.
    pub position_angle_deg: f64,
    /// The same from the direction of the zenith, degrees `[0, 360)`.
    pub vertex_angle_deg: f64,
    /// From the nearer cusp along the limb, degrees in `[-90, 90]`: positive on the dark
    /// limb, negative on the bright one.
    pub cusp_angle_deg: f64,
    /// The nearer cusp: `"N"` or `"S"`.
    pub cusp: String,
    pub limb: Limb,
    /// Topocentric geometric altitude and azimuth of the Moon's centre (CONVENTIONS 13.2).
    pub moon_alt_deg: f64,
    pub moon_az_deg: f64,
    pub moon_above_horizon: bool,
    /// The Sun's topocentric geometric altitude and the sky phase it gives (13.4).
    pub sun_alt_deg: f64,
    pub sky_phase: SkyPhase,
    /// Planets: seconds the disc takes to cross the limb; 0 for a star.
    pub crossing_s: f64,
}

/// The least distance of the body from the mean limb during the event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClosestApproach {
    pub jd_utc: f64,
    pub utc: String,
    /// Distance from the mean limb, arcminutes: negative inside the disc.
    pub limb_distance_arcmin: f64,
    pub position_angle_deg: f64,
    pub moon_alt_deg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccultedKind {
    Star,
    Planet,
}

/// One occultation (or near miss) for the observer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Occultation {
    pub body: String,
    pub kind: OccultedKind,
    pub designation: Option<String>,
    pub hr: Option<u32>,
    pub magnitude: Option<f64>,
    pub navigational: bool,
    /// The mean limb hides the body; false for a near miss.
    pub occulted: bool,
    /// The body passes within 1′ of the mean limb (inside or outside).
    pub graze: bool,
    pub disappearance: Option<OccultationContact>,
    pub reappearance: Option<OccultationContact>,
    pub closest: ClosestApproach,
    /// Reappearance minus disappearance, seconds.
    pub duration_s: Option<f64>,
    /// Planets: the apparent semidiameter, arcseconds; 0 for a star.
    pub body_semidiameter_arcsec: f64,
    pub moon_illuminated_fraction: f64,
    pub waxing: bool,
    /// The Moon is above the horizon at a contact (at the closest approach for a near
    /// miss).
    pub visible: bool,
}

/// Result of [`occultations`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OccultationList {
    pub jd_start: f64,
    pub jd_end: f64,
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    pub limb_note: String,
    /// How many bodies were searched (after the ecliptic filter).
    pub bodies_searched: usize,
    /// Sorted by the first contact (or the closest approach).
    pub events: Vec<Occultation>,
    pub errors: Vec<BodyError>,
}

/// Search options.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OccultationOptions {
    /// Keep events with the Moon below the horizon at every contact.
    pub include_below_horizon: bool,
    /// Keep near misses (the body passes outside the mean limb within 1′).
    pub include_near_misses: bool,
}

impl Default for OccultationOptions {
    fn default() -> Self {
        OccultationOptions {
            include_below_horizon: false,
            include_near_misses: true,
        }
    }
}

// ---------------------------------------------------------------------------
// The Moon's track: daily exact positions, eight-point Lagrange interpolation
// ---------------------------------------------------------------------------

pub(crate) struct MoonTrack {
    /// UTC Julian date of sample 0.
    t0: f64,
    /// Apparent geocentric position, true equator and equinox of date, km.
    pos: Vec<Vec3>,
    /// Barycentric weights of the equally spaced stencil.
    weights: [f64; STENCIL],
}

impl MoonTrack {
    /// Samples every [`TRACK_STEP`] from `lo - 4` to `hi + 4` days, clipped to `[c0, c1]`.
    pub(crate) fn new(
        moon: &MoonProvider,
        lo: f64,
        hi: f64,
        c0: f64,
        c1: f64,
    ) -> Result<MoonTrack, AlmanacError> {
        let first = (lo - 4.0).max(c0);
        let last = (hi + 4.0).min(c1);
        let n = (((last - first) / TRACK_STEP).floor() as usize + 1).max(STENCIL);
        let t0 = if first + (n - 1) as f64 * TRACK_STEP > c1 {
            c1 - (n - 1) as f64 * TRACK_STEP
        } else {
            first
        };
        let mut pos = Vec::with_capacity(n);
        for k in 0..n {
            let p = moon.position(t0 + k as f64 * TRACK_STEP).map_err(|e| {
                AlmanacError::Unavailable {
                    body: "Moon".to_string(),
                    message: e.to_string(),
                }
            })?;
            pos.push(p.apparent_km);
        }
        // w_i = (-1)^i C(n-1, i) for equally spaced nodes.
        let mut weights = [0.0; STENCIL];
        let mut c = 1.0;
        for (i, w) in weights.iter_mut().enumerate() {
            *w = if i % 2 == 0 { c } else { -c };
            c = c * (STENCIL - 1 - i) as f64 / (i + 1) as f64;
        }
        Ok(MoonTrack { t0, pos, weights })
    }

    pub(crate) fn start(&self) -> f64 {
        self.t0
    }

    pub(crate) fn end(&self) -> f64 {
        self.t0 + (self.pos.len() - 1) as f64 * TRACK_STEP
    }

    /// The Moon's apparent geocentric position at `jd` (inside the track), km.
    pub(crate) fn at(&self, jd: f64) -> Vec3 {
        let x = (jd - self.t0) / TRACK_STEP;
        let n = self.pos.len();
        let j = (x.floor() as isize - (STENCIL as isize / 2 - 1)).clamp(0, (n - STENCIL) as isize)
            as usize;
        let (mut num, mut den) = ([0.0; 3], 0.0);
        for i in 0..STENCIL {
            let d = x - (j + i) as f64;
            if d == 0.0 {
                return self.pos[j + i];
            }
            let w = self.weights[i] / d;
            den += w;
            for (k, v) in num.iter_mut().enumerate() {
                *v += w * self.pos[j + i][k];
            }
        }
        [num[0] / den, num[1] / den, num[2] / den]
    }
}

// ---------------------------------------------------------------------------
// Bodies' apparent places over a window
// ---------------------------------------------------------------------------

/// The apparent geocentric position of a target, true equator of date: a unit vector
/// for a star (infinitely far), km for a planet.
struct TargetTrack {
    /// Sample instants and positions for the conjunction search (planets move).
    times: Vec<f64>,
    pos: Vec<Vec3>,
    is_planet: bool,
    semidiameter_arcsec: f64,
    magnitude: Option<f64>,
}

impl TargetTrack {
    fn at(&self, jd: f64) -> Vec3 {
        if self.times.len() == 1 {
            return self.pos[0];
        }
        // Cubic Lagrange through the four samples around jd (planets move slowly).
        let n = self.times.len();
        let k = match self.times.iter().position(|&t| t > jd) {
            Some(k) => k,
            None => n,
        };
        let j = (k as isize - 2).clamp(0, n as isize - 4) as usize;
        let mut out = [0.0; 3];
        for i in j..j + 4 {
            let mut w = 1.0;
            for m in j..j + 4 {
                if m != i {
                    w *= (jd - self.times[m]) / (self.times[i] - self.times[m]);
                }
            }
            for (c, o) in out.iter_mut().enumerate() {
                *o += w * self.pos[i][c];
            }
        }
        out
    }
}

/// Apparent place of a catalogue star at `jd_utc`, true equator and equinox of date:
/// the chain of `skyfix_ephemeris::frames` (proper motion, bias-precession-nutation,
/// parallax, deflection, aberration).
fn star_direction(s: &StarTarget, jd_utc: f64) -> Result<Vec3, String> {
    if s.navigational {
        let (ra, dec) = StarProvider::new()
            .apparent_radec_deg(&s.name, jd_utc)
            .map_err(|e| e.to_string())?;
        return Ok(unit_radec(ra, dec));
    }
    let f = StarFrame::cached(jd_tt(jd_utc));
    let p = proper_motion_from_j2000(
        s.ra_j2000_deg,
        s.dec_j2000_deg,
        s.pm_ra_cosdec_mas_yr,
        s.pm_dec_mas_yr,
        f.jd_tt,
    );
    let m = &f.bpn;
    let p = [dot(m[0], p), dot(m[1], p), dot(m[2], p)];
    let p = apply_annual_parallax(p, s.parallax_mas, f.earth.pos_au);
    let p = apply_solar_light_deflection(p, f.earth.pos_au);
    let p = apply_annual_aberration(p, f.earth.vel_c);
    let (ra, dec) = radec_from_vector(p);
    Ok(unit_radec(ra, dec))
}

fn planet_vector(
    planets: &PlanetProvider,
    p: Planet,
    jd: f64,
) -> Result<(Vec3, f64, Option<f64>), String> {
    let pos = planets.position(p, jd).map_err(|e| e.to_string())?;
    Ok((
        scale(unit_radec(pos.ra_deg, pos.dec_deg), pos.distance_au * AU_KM),
        pos.semidiameter_arcmin * 60.0,
        pos.magnitude,
    ))
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/// The observer at one event: the site's Earth-fixed position turned by a sidereal
/// time that is exact at `t_ref` and advances at the sidereal rate.
struct Observer {
    ecef_km: Vec3,
    up_ecef: Vec3,
    t_ref: f64,
    gast_ref_rad: f64,
    rate_rad_per_day: f64,
}

impl Observer {
    fn new(site: &Site, t_ref: f64, dut1_s: f64) -> Observer {
        let g = |t: f64| gast_deg(jd_ut1(t, dut1_s), jd_tt(t)).to_radians();
        let h = 1.0 / 24.0;
        let (a, b) = (g(t_ref - h), g(t_ref + h));
        let d = (b - a).rem_euclid(std::f64::consts::TAU);
        Observer {
            ecef_km: site.position_km(),
            up_ecef: site.enu_axes()[2],
            t_ref,
            gast_ref_rad: g(t_ref),
            rate_rad_per_day: d / (2.0 * h),
        }
    }

    fn rotate(&self, v: Vec3, t: f64) -> Vec3 {
        let g = self.gast_ref_rad + self.rate_rad_per_day * (t - self.t_ref);
        let (s, c) = g.sin_cos();
        [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
    }

    fn position(&self, t: f64) -> Vec3 {
        self.rotate(self.ecef_km, t)
    }

    fn zenith(&self, t: f64) -> Vec3 {
        self.rotate(self.up_ecef, t)
    }
}

/// Distance of the body from the mean limb seen from the observer, degrees: the
/// topocentric separation minus the topocentric semidiameter (negative inside).
fn limb_distance_deg(moon: &MoonTrack, target: &TargetTrack, obs: &Observer, t: f64) -> f64 {
    let o = obs.position(t);
    let m = sub(moon.at(t), o);
    let b = if target.is_planet {
        sub(target.at(t), o)
    } else {
        target.at(t)
    };
    let sd = (MOON_RADIUS_KM / norm(m)).asin().to_degrees();
    angle_deg(m, b) - sd
}

/// Everything an event needs to know about the search: the providers, the observer, the
/// tracks.
struct Search<'a> {
    moon: &'a MoonTrack,
    sun: &'a SunProvider,
    site: &'a Site,
    /// UT1 - UTC of the Moon provider, seconds (0 in the explorer, CONVENTIONS 13.2).
    dut1_s: f64,
}

impl Search<'_> {
    /// The Moon as an [`ApparentState`] at `t` (interpolated place, exact sidereal time),
    /// for the shared topocentric altitude and azimuth.
    fn moon_state(&self, t: f64) -> ApparentState {
        let v = self.moon.at(t);
        let (ra, dec) = radec_from_vector(v);
        let gast = gast_deg(jd_ut1(t, self.dut1_s), jd_tt(t));
        ApparentState {
            body: "Moon".to_string(),
            kind: BodyKind::Moon,
            jd_utc: t,
            ra_deg: ra,
            dec_deg: dec,
            gha_deg: norm_360(gast - ra),
            distance_km: Some(norm(v)),
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
            magnitude: None,
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        }
    }

    fn sun_vector(&self, t: f64) -> Result<(Vec3, ApparentState), String> {
        let s = self.sun.position(t).map_err(|e| e.to_string())?;
        let state = ApparentState {
            body: "Sun".to_string(),
            kind: BodyKind::Sun,
            jd_utc: t,
            ra_deg: s.ra_deg,
            dec_deg: s.dec_deg,
            gha_deg: s.gha_deg,
            distance_km: Some(s.radius_au * AU_KM),
            semidiameter_arcmin: s.semidiameter_arcmin,
            horizontal_parallax_arcmin: s.horizontal_parallax_arcmin,
            magnitude: None,
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        };
        Ok((
            scale(unit_radec(s.ra_deg, s.dec_deg), s.radius_au * AU_KM),
            state,
        ))
    }

    fn contact(
        &self,
        kind: ContactKind,
        t: f64,
        target: &TargetTrack,
        obs: &Observer,
    ) -> Result<OccultationContact, String> {
        let o = obs.position(t);
        let m = self.moon.at(t);
        let u = unit(sub(m, o));
        let b = if target.is_planet {
            unit(sub(target.at(t), o))
        } else {
            target.at(t)
        };
        let (n, e) = north_east(u);
        let pa = norm_360(dot(b, e).atan2(dot(b, n)).to_degrees());
        let z = obs.zenith(t);
        let q = dot(z, e).atan2(dot(z, n)).to_degrees();
        let (sun_km, sun_state) = self.sun_vector(t)?;
        let to_sun = sub(sun_km, m);
        let chi = norm_360(dot(to_sun, e).atan2(dot(to_sun, n)).to_degrees());
        let off = norm_180(pa - chi);
        let limb = if off.abs() < 90.0 {
            Limb::Bright
        } else {
            Limb::Dark
        };
        let cusp_angle = off.abs() - 90.0;
        // The nearer cusp, at chi + 90 or chi - 90; north when it lies toward north.
        let cusp_pa = if off >= 0.0 { chi + 90.0 } else { chi - 90.0 };
        let cusp = if cusp_pa.to_radians().cos() >= 0.0 {
            "N"
        } else {
            "S"
        };
        let mh = horizontal(&self.moon_state(t), self.site);
        let sh = horizontal(&sun_state, self.site);
        let crossing_s = if target.is_planet && target.semidiameter_arcsec > 0.0 {
            let h = 1.0 / 86_400.0;
            let rate = (limb_distance_deg(self.moon, target, obs, t + h)
                - limb_distance_deg(self.moon, target, obs, t - h))
                / (2.0 * h * 86_400.0)
                * 3600.0;
            if rate.abs() > 1e-9 {
                2.0 * target.semidiameter_arcsec / rate.abs()
            } else {
                0.0
            }
        } else {
            0.0
        };
        Ok(OccultationContact {
            kind,
            jd_utc: t,
            utc: format_utc(t),
            position_angle_deg: pa,
            vertex_angle_deg: norm_360(pa - q),
            cusp_angle_deg: cusp_angle,
            cusp: cusp.to_string(),
            limb,
            moon_alt_deg: mh.alt_deg,
            moon_az_deg: mh.az_deg,
            moon_above_horizon: mh.alt_deg > 0.0,
            sun_alt_deg: sh.alt_deg,
            sky_phase: sky_phase(sh.alt_deg),
            crossing_s,
        })
    }
}

/// Every occultation (and near miss) of `targets` by the Moon seen from `site` with a
/// contact or closest approach in `[jd_start, jd_end]` (UTC Julian dates, at most
/// [`MAX_WINDOW_DAYS`]), clipped to the Moon's coverage.
#[allow(clippy::too_many_arguments)]
pub fn occultations(
    moon: &MoonProvider,
    sun: &SunProvider,
    planets: &PlanetProvider,
    site: &Site,
    jd_start: f64,
    jd_end: f64,
    targets: &[OccultationTarget],
    options: &OccultationOptions,
) -> Result<OccultationList, AlmanacError> {
    let site = checked_site(site)?;
    if !(jd_start.is_finite() && jd_end.is_finite()) || jd_end <= jd_start {
        return Err(AlmanacError::invalid(format!(
            "the window must be finite and end after it starts: jd_start {jd_start}, jd_end {jd_end}"
        )));
    }
    if jd_end - jd_start > MAX_WINDOW_DAYS {
        return Err(AlmanacError::invalid(format!(
            "the window is {:.0} days; at most {MAX_WINDOW_DAYS:.0}",
            jd_end - jd_start
        )));
    }
    let cov = moon.coverage();
    let c0 = parse_utc(&cov.start_utc).map_err(|e| AlmanacError::invalid(e.to_string()))?;
    let c1 = parse_utc(&cov.end_utc).map_err(|e| AlmanacError::invalid(e.to_string()))?;
    let (lo, hi) = (jd_start.max(c0), jd_end.min(c1));
    let mut out = OccultationList {
        jd_start: lo,
        jd_end: hi,
        truncated: lo > jd_start || hi < jd_end,
        coverage_start_utc: cov.start_utc.clone(),
        coverage_end_utc: cov.end_utc.clone(),
        limb_note: LIMB_NOTE.to_string(),
        bodies_searched: 0,
        events: Vec::new(),
        errors: Vec::new(),
    };
    if hi <= lo {
        return Ok(out);
    }
    let track = MoonTrack::new(moon, lo, hi, c0, c1)?;
    let search = Search {
        moon: &track,
        sun,
        site: &site,
        dut1_s: moon.dut1_s(),
    };
    let (s0, s1) = (track.start(), track.end());

    // The Moon's right ascension at the track's samples, for the conjunction scan.
    // Half a day beyond each end, so that an event whose contacts fall just inside the
    // window but whose conjunction falls just outside is still found.
    let (scan0, scan1) = ((lo - 0.5).max(s0), (hi + 0.5).min(s1));
    let days: Vec<f64> = {
        let mut v = Vec::new();
        let mut t = scan0;
        while t < scan1 {
            v.push(t);
            t += 0.25;
        }
        v.push(scan1);
        v
    };
    let moon_dirs: Vec<Vec3> = days.iter().map(|&t| unit(track.at(t))).collect();

    for target in targets {
        // Build the target's track, skipping stars out of the Moon's reach.
        let tt = match target {
            OccultationTarget::Star(s) => {
                if ecliptic_latitude_j2000_deg(s.ra_j2000_deg, s.dec_j2000_deg).abs()
                    > ECLIPTIC_REACH_DEG
                {
                    continue;
                }
                let mid = 0.5 * (lo + hi);
                match star_direction(s, mid) {
                    Ok(u) => TargetTrack {
                        times: vec![mid],
                        pos: vec![u],
                        is_planet: false,
                        semidiameter_arcsec: 0.0,
                        magnitude: Some(s.magnitude),
                    },
                    Err(message) => {
                        out.errors.push(BodyError {
                            body: s.name.clone(),
                            message,
                        });
                        continue;
                    }
                }
            }
            OccultationTarget::Planet(p) => {
                // At least four samples, for the cubic interpolation.
                let h = coarse_step_days(*p);
                let (start, end) = ((lo - 2.0 * h).max(c0), (hi + 2.0 * h).min(c1));
                let step = (end - start) / ((end - start) / h).ceil().max(3.0);
                let n = ((end - start) / step).round() as usize;
                let times: Vec<f64> = (0..=n).map(|k| start + k as f64 * step).collect();
                let mut pos = Vec::with_capacity(times.len());
                let mut failed = None;
                for &t in &times {
                    match planet_vector(planets, *p, t) {
                        Ok((v, _, _)) => pos.push(v),
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                if let Some(message) = failed {
                    out.errors.push(BodyError {
                        body: p.name().to_string(),
                        message,
                    });
                    continue;
                }
                TargetTrack {
                    times,
                    pos,
                    is_planet: true,
                    semidiameter_arcsec: 0.0,
                    magnitude: None,
                }
            }
        };
        out.bodies_searched += 1;

        // Conjunctions in right ascension: the Moon passes the body eastward.
        let mut conj = Vec::new();
        let ra_diff = |k: usize| -> f64 {
            let b = unit(tt.at(days[k]));
            let (rm, _) = radec_from_vector(moon_dirs[k]);
            let (rb, _) = radec_from_vector(b);
            norm_180(rm - rb)
        };
        let mut prev = ra_diff(0);
        for k in 1..days.len() {
            let cur = ra_diff(k);
            if prev < 0.0 && cur >= 0.0 && cur - prev < 90.0 {
                conj.push((days[k - 1], days[k]));
            }
            prev = cur;
        }

        for (a, b) in conj {
            match self::event(&search, &tt, target, a, b, planets, lo, hi, options) {
                Ok(Some(ev)) => out.events.push(ev),
                Ok(None) => {}
                Err(message) => out.errors.push(BodyError {
                    body: target.name().to_string(),
                    message,
                }),
            }
        }
    }
    out.events
        .sort_by(|x, y| first_instant(x).total_cmp(&first_instant(y)));
    Ok(out)
}

fn first_instant(e: &Occultation) -> f64 {
    e.disappearance
        .as_ref()
        .map(|c| c.jd_utc)
        .or(e.reappearance.as_ref().map(|c| c.jd_utc))
        .unwrap_or(e.closest.jd_utc)
}

/// The event (if any) of one conjunction bracketed by `[a, b]`.
#[allow(clippy::too_many_arguments)]
fn event(
    search: &Search<'_>,
    coarse: &TargetTrack,
    target: &OccultationTarget,
    a: f64,
    b: f64,
    planets: &PlanetProvider,
    lo: f64,
    hi: f64,
    options: &OccultationOptions,
) -> Result<Option<Occultation>, String> {
    let track = search.moon;
    let (s0, s1) = (track.start(), track.end());
    // The least geocentric separation near the conjunction, from the coarse track; far
    // beyond any observer's reach, stop before evaluating the body again.
    let geo_sep = |t: f64| angle_deg(track.at(t), coarse.at(t));
    let (t_conj, sep_coarse) = minimise(geo_sep, a - 0.25, b + 0.25, 1e-5);
    let reach = |t: f64| {
        let d = norm(track.at(t));
        (EARTH_EQUATORIAL_RADIUS_KM / d).asin().to_degrees()
            + (MOON_RADIUS_KM / d).asin().to_degrees()
    };
    if sep_coarse > reach(t_conj) + REACH_MARGIN_DEG {
        return Ok(None);
    }
    // A precise track of the body around the conjunction.
    let fine = match target {
        OccultationTarget::Star(s) => {
            let u = star_direction(s, t_conj)?;
            TargetTrack {
                times: vec![t_conj],
                pos: vec![u],
                is_planet: false,
                semidiameter_arcsec: 0.0,
                magnitude: Some(s.magnitude),
            }
        }
        OccultationTarget::Planet(p) => {
            let times: Vec<f64> = [-0.3, -0.1, 0.1, 0.3]
                .iter()
                .map(|d| (t_conj + d).clamp(s0, s1))
                .collect();
            if times.windows(2).any(|w| w[1] - w[0] < 0.05) {
                // Squeezed against the end of the coverage: nothing to report there.
                return Ok(None);
            }
            let mut pos = Vec::new();
            let (mut sd, mut mag) = (0.0, None);
            for &t in &times {
                let (v, s, m) = planet_vector(planets, *p, t)?;
                pos.push(v);
                sd = s;
                mag = m;
            }
            TargetTrack {
                times,
                pos,
                is_planet: true,
                semidiameter_arcsec: sd,
                magnitude: mag,
            }
        }
    };
    let (t_min, sep_min) = minimise(
        |t| angle_deg(track.at(t), fine.at(t)),
        t_conj - 0.25,
        t_conj + 0.25,
        1e-6,
    );
    // Beyond the reach of any observer: horizontal parallax + semidiameter + margin.
    if sep_min > reach(t_min) + 0.05 {
        return Ok(None);
    }

    // Topocentric: sample, find the least limb distance and the contacts.
    let obs = Observer::new(search.site, t_min, search.dut1_s);
    let w0 = (t_min - TOPO_HALF_WIDTH).max(s0);
    let w1 = (t_min + TOPO_HALF_WIDTH).min(s1);
    let n = ((w1 - w0) / TOPO_STEP).ceil() as usize;
    let ts: Vec<f64> = (0..=n)
        .map(|k| w0 + (w1 - w0) * k as f64 / n as f64)
        .collect();
    let fs: Vec<f64> = ts
        .iter()
        .map(|&t| limb_distance_deg(track, &fine, &obs, t))
        .collect();
    let (mut imin, mut fmin) = (0, f64::INFINITY);
    for (i, &f) in fs.iter().enumerate() {
        if f < fmin {
            imin = i;
            fmin = f;
        }
    }
    let graze_deg = GRAZE_ARCMIN / 60.0;
    if fmin > graze_deg + 0.05 {
        return Ok(None);
    }
    let (ta, tb) = (ts[imin.saturating_sub(1)], ts[(imin + 1).min(n)]);
    let (t_close, f_close) = minimise(|t| limb_distance_deg(track, &fine, &obs, t), ta, tb, 1e-7);
    if f_close > graze_deg {
        return Ok(None);
    }
    let mut disappearance = None;
    let mut reappearance = None;
    for i in 0..n {
        let (f0, f1) = (fs[i], fs[i + 1]);
        if (f0 > 0.0) == (f1 > 0.0) {
            continue;
        }
        let Some(t) = root(
            |t| limb_distance_deg(track, &fine, &obs, t),
            ts[i],
            ts[i + 1],
            CONTACT_TOL,
        ) else {
            continue;
        };
        if f0 > 0.0 && disappearance.is_none() && t <= t_close {
            disappearance = Some(search.contact(ContactKind::Disappearance, t, &fine, &obs)?);
        } else if f0 <= 0.0 && reappearance.is_none() && t >= t_close {
            reappearance = Some(search.contact(ContactKind::Reappearance, t, &fine, &obs)?);
        }
    }
    let occulted = f_close < 0.0;
    if occulted && (disappearance.is_none() || reappearance.is_none()) {
        // An occultation cut by the ends of the track (the edge of the coverage).
        if disappearance.is_none() && reappearance.is_none() {
            return Ok(None);
        }
    }
    if !occulted && !options.include_near_misses {
        return Ok(None);
    }
    // The event belongs to the window if any of its instants does.
    let instants: Vec<f64> = [
        disappearance.as_ref().map(|c| c.jd_utc),
        reappearance.as_ref().map(|c| c.jd_utc),
        Some(t_close),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !instants.iter().any(|&t| t >= lo && t <= hi) {
        return Ok(None);
    }
    // The closest approach.
    let close_contact = search.contact(ContactKind::Disappearance, t_close, &fine, &obs)?;
    let visible = if occulted {
        disappearance.as_ref().is_some_and(|c| c.moon_above_horizon)
            || reappearance.as_ref().is_some_and(|c| c.moon_above_horizon)
    } else {
        close_contact.moon_above_horizon
    };
    if !visible && !options.include_below_horizon {
        return Ok(None);
    }
    // The Moon's phase at closest approach.
    let (sun_km, _) = search.sun_vector(t_close)?;
    let m = track.at(t_close);
    let psi = angle_deg(m, sun_km).to_radians();
    let big_r = norm(sun_km);
    let dm = norm(m);
    let phase = (big_r * psi.sin()).atan2(dm - big_r * psi.cos());
    let eps = true_obliquity_rad(jd_tt(t_close));
    let ecl_lon = |v: Vec3| -> f64 {
        let (se, ce) = eps.sin_cos();
        (v[1] * ce + v[2] * se).atan2(v[0]).to_degrees()
    };
    let waxing = norm_360(ecl_lon(m) - ecl_lon(sun_km)) < 180.0;
    let (kind, designation, hr, magnitude, navigational, name) = match target {
        OccultationTarget::Star(s) => (
            OccultedKind::Star,
            s.designation.clone(),
            s.hr,
            Some(s.magnitude),
            s.navigational,
            s.name.clone(),
        ),
        OccultationTarget::Planet(p) => (
            OccultedKind::Planet,
            None,
            None,
            fine.magnitude,
            skyfix_ephemeris::body::is_navigational(p.name()),
            p.name().to_string(),
        ),
    };
    let duration_s = match (&disappearance, &reappearance) {
        (Some(d), Some(r)) => Some((r.jd_utc - d.jd_utc) * 86_400.0),
        _ => None,
    };
    Ok(Some(Occultation {
        body: name,
        kind,
        designation,
        hr,
        magnitude,
        navigational,
        occulted,
        graze: f_close > -graze_deg,
        disappearance,
        reappearance,
        closest: ClosestApproach {
            jd_utc: t_close,
            utc: format_utc(t_close),
            limb_distance_arcmin: f_close * 60.0,
            position_angle_deg: close_contact.position_angle_deg,
            moon_alt_deg: close_contact.moon_alt_deg,
        },
        duration_s,
        body_semidiameter_arcsec: fine.semidiameter_arcsec,
        moon_illuminated_fraction: (1.0 + phase.cos()) / 2.0,
        waxing,
        visible,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn the_moon_track_interpolates_to_a_tenth_of_a_kilometre() {
        let moon = MoonProvider::new();
        let (lo, hi) = (civil_to_jd(2026, 1, 1), civil_to_jd(2026, 4, 1));
        let c0 = civil_to_jd(1990, 1, 1);
        let c1 = civil_to_jd(2061, 1, 1);
        let track = MoonTrack::new(&moon, lo, hi, c0, c1).unwrap();
        let mut worst = 0.0f64;
        for k in 0..300 {
            let t = lo + (hi - lo) * (k as f64 + 0.37) / 300.0;
            let exact = moon.position(t).unwrap().apparent_km;
            worst = worst.max(norm(sub(track.at(t), exact)));
        }
        // 0.2 km is 0.1 arcsecond at the Moon's distance, 0.2 s of contact time.
        assert!(worst < 0.2, "worst interpolation error {worst} km");
    }

    #[test]
    fn the_track_works_at_the_edge_of_the_coverage() {
        let moon = MoonProvider::new();
        let c0 = civil_to_jd(1990, 1, 1);
        let c1 = parse_utc(&moon.coverage().end_utc).unwrap();
        let track = MoonTrack::new(&moon, c1 - 10.0, c1, c0, c1).unwrap();
        assert!(track.end() <= c1 + 1e-9);
        let t = c1 - 0.3;
        let exact = moon.position(t).unwrap().apparent_km;
        assert!(norm(sub(track.at(t), exact)) < 0.5);
    }

    #[test]
    fn stars_far_from_the_ecliptic_are_out_of_reach() {
        // Polaris and Sirius cannot be occulted; Regulus, Spica, Antares, Aldebaran can.
        let lat = |name: &str| {
            let s = catalog::find(name).unwrap();
            ecliptic_latitude_j2000_deg(s.ra_j2000_deg, s.dec_j2000_deg)
        };
        assert!(lat("Polaris").abs() > ECLIPTIC_REACH_DEG);
        assert!(lat("Sirius").abs() > ECLIPTIC_REACH_DEG);
        for s in ["Regulus", "Spica", "Antares", "Aldebaran"] {
            assert!(lat(s).abs() < 6.0, "{s} {}", lat(s));
        }
    }

    #[test]
    fn options_reject_bad_windows() {
        let (m, s, p) = (
            MoonProvider::new(),
            SunProvider::new(),
            PlanetProvider::new(),
        );
        let site = Site::new(40.0, -75.0);
        let t = navigational_star_targets();
        let o = OccultationOptions::default();
        assert!(occultations(&m, &s, &p, &site, 2_461_000.0, 2_460_000.0, &t, &o).is_err());
        assert!(occultations(&m, &s, &p, &site, 2_460_000.0, 2_460_500.0, &t, &o).is_err());
        let bad = Site::new(95.0, 0.0);
        assert!(occultations(&m, &s, &p, &bad, 2_460_000.0, 2_460_010.0, &t, &o).is_err());
    }
}
