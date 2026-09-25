//! Conjunctions in apparent separation (planet with planet, the Moon with a planet, a
//! planet or the Moon with one of the four bright stars near the ecliptic) and the
//! stations of the planets, where their apparent motion turns retrograde and back.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.12; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail".
//!
//! # Definitions
//!
//! - **Conjunction** here is the **closest approach**: a local minimum of the apparent
//!   geocentric separation of the two bodies' centres (both apparent places of date from
//!   the explorer's providers), reported when it is at most `max_separation_deg`. This is
//!   what a skywatcher sees; the almanac's conjunction "in right ascension" can be hours
//!   (for the Moon) or days away from it.
//! - **Position angle** is that of `body` seen from `other`, from north through east:
//!   "the Moon 1.2 deg south of Jupiter" has a position angle near 180.
//! - **Visible** (no observer): both bodies are at least `min_sun_elongation_deg` (15 deg
//!   by default) from the Sun, so the pair is not lost in its glare. With an observer,
//!   `local` finds, within 12 hours of closest approach, the moment the lower of the two
//!   stands highest while the Sun is below -6 deg (civil twilight over), from the
//!   topocentric apparent altitudes of CONVENTIONS 13.2.
//! - **The stars** are, by default, the four first-magnitude navigational stars the Moon
//!   and planets can pass: Aldebaran, Regulus, Spica and Antares (any navigational star
//!   may be named).
//! - **Stations**: the instants the apparent geocentric right ascension (true equator
//!   and equinox of date) or ecliptic longitude (true ecliptic and equinox of date)
//!   stops changing: `retrograde_begins` when it starts to decrease, `retrograde_ends`
//!   when it increases again. The explorer shows the ecliptic-longitude stations (the
//!   definition of retrograde motion); the right-ascension ones are given too, and can
//!   be a day or more apart from them.
//!
//! # Method
//!
//! Every body's apparent geocentric position vector, moved to the ICRS axes (so the
//! nutation's 13.7-day wobble is not interpolated but put back exactly), is sampled at
//! Chebyshev nodes and interpolated (`VecFit`: 16-day segments of 24 nodes for the Moon,
//! 16 to 32 days of 16 nodes for the planets; measured within 1e-4" in position and
//! 1e-4"/day in rate), separations are scanned on a grid (6 hours for the Moon, 12 hours
//! with Mercury, a day otherwise), each local minimum is refined with Brent's method, and
//! the reported quantities are recomputed exactly at the instant found. Stations are
//! roots of the rate of the longitude of date (the interpolant rotated to the date frame
//! at each call, differenced over +/-0.05 day).

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, jd_tt, jd_ut1};
use skyfix_ephemeris::frames::true_obliquity_rad;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::planets::{Planet, PlanetProvider};
use skyfix_ephemeris::sidereal::gast_deg;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::{Site, refraction_true_to_apparent_arcmin};

use crate::eclipses::cheb::{minimise, root};
use crate::planet_geometry::{
    Mat3, Vec3, VecFit, angle, clip_window, dot, icrs_to_true_of_date, mat_t_vec, mat_vec,
    planet_coverage, position_angle_deg, r3, radec_of, radec_unit, scale, sub, sun_planet_coverage,
    unavailable,
};
use crate::sky::{AlmanacError, checked_site};

const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;
/// Longest window `conjunctions` accepts, days (ten years; about a second natively).
pub const MAX_WINDOW_DAYS: f64 = 3660.0;
/// Longest window `stations` accepts, days (80 years; about a second natively).
pub const MAX_STATION_WINDOW_DAYS: f64 = 29_220.0;
/// The default stars: the first-magnitude navigational stars within reach of the Moon
/// and the planets.
pub const DEFAULT_STARS: [&str; 4] = ["Aldebaran", "Regulus", "Spica", "Antares"];

fn default_planets() -> Vec<String> {
    Planet::ALL.iter().map(|p| p.name().to_string()).collect()
}

fn default_stars() -> Vec<String> {
    DEFAULT_STARS.iter().map(|s| s.to_string()).collect()
}

fn default_true() -> bool {
    true
}

fn default_max_sep() -> f64 {
    5.0
}

fn default_min_elong() -> f64 {
    15.0
}

/// What `conjunctions` looks for (EXPLORER_API.md `ConjunctionOptions`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConjunctionOptions {
    /// Planets taken into account (default all seven).
    #[serde(default = "default_planets")]
    pub planets: Vec<String>,
    /// Include the Moon (with the planets and the stars).
    #[serde(default = "default_true")]
    pub moon: bool,
    /// Stars (navigational star names); default the four of `DEFAULT_STARS`.
    #[serde(default = "default_stars")]
    pub stars: Vec<String>,
    /// Largest separation reported, degrees (0.1 to 20).
    #[serde(default = "default_max_sep")]
    pub max_separation_deg: f64,
    /// Least elongation from the Sun for `visible`, degrees.
    #[serde(default = "default_min_elong")]
    pub min_sun_elongation_deg: f64,
    /// An observer for `local` (EXPLORER_API observer object); none by default.
    #[serde(default)]
    pub observer: Option<Site>,
}

impl Default for ConjunctionOptions {
    fn default() -> Self {
        ConjunctionOptions {
            planets: default_planets(),
            moon: true,
            stars: default_stars(),
            max_separation_deg: default_max_sep(),
            min_sun_elongation_deg: default_min_elong(),
            observer: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConjunctionKind {
    PlanetPlanet,
    MoonPlanet,
    PlanetStar,
    MoonStar,
}

/// The best moment to look, for an observer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConjunctionView {
    pub jd_utc: f64,
    pub utc: String,
    /// Apparent (refracted) topocentric altitudes, degrees.
    pub body_alt_deg: f64,
    pub other_alt_deg: f64,
    /// The Sun's topocentric geometric altitude, degrees.
    pub sun_alt_deg: f64,
}

/// What an observer sees of a conjunction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConjunctionLocal {
    /// Apparent altitudes at the instant of closest approach, degrees.
    pub body_alt_deg: f64,
    pub other_alt_deg: f64,
    pub sun_alt_deg: f64,
    /// Within 12 hours of closest approach, the moment the lower body stands highest
    /// with the Sun below -6 degrees; `None` when both are never up in a dark enough sky.
    pub best: Option<ConjunctionView>,
}

/// One closest approach.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conjunction {
    pub kind: ConjunctionKind,
    /// The moving body: the Moon, else the planet (the inner of two planets).
    pub body: String,
    pub other: String,
    pub jd_utc: f64,
    pub utc: String,
    pub separation_deg: f64,
    /// Of `body` seen from `other`, north through east, degrees.
    pub position_angle_deg: f64,
    /// Apparent geocentric right ascension and declination of `body`, degrees.
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub body_elongation_deg: f64,
    pub other_elongation_deg: f64,
    pub body_magnitude: Option<f64>,
    pub other_magnitude: Option<f64>,
    /// Both at least `min_sun_elongation_deg` from the Sun.
    pub visible: bool,
    pub local: Option<ConjunctionLocal>,
}

/// `conjunctions` result (EXPLORER_API.md `ConjunctionList`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConjunctionList {
    pub jd_start: f64,
    pub jd_end: f64,
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    /// Sorted by time.
    pub conjunctions: Vec<Conjunction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationKind {
    RetrogradeBegins,
    RetrogradeEnds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationCoordinate {
    EclipticLongitude,
    RightAscension,
}

/// One station.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub body: String,
    pub kind: StationKind,
    pub coordinate: StationCoordinate,
    pub jd_utc: f64,
    pub utc: String,
    /// The coordinate's value at the station (longitude or right ascension), degrees.
    pub angle_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub ecliptic_longitude_deg: f64,
    pub elongation_deg: f64,
    pub magnitude: Option<f64>,
}

/// `stations` result (EXPLORER_API.md `StationList`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StationList {
    pub jd_start: f64,
    pub jd_end: f64,
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    /// Sorted by time; both coordinates.
    pub stations: Vec<Station>,
    /// The coordinate the explorer shows: `"ecliptic_longitude"`.
    pub ui_coordinate: StationCoordinate,
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Body {
    Moon,
    Planet(Planet),
    Star(String),
}

impl Body {
    fn name(&self) -> String {
        match self {
            Body::Moon => "Moon".to_string(),
            Body::Planet(p) => p.name().to_string(),
            Body::Star(s) => s.clone(),
        }
    }

    /// Apparent geocentric position of date: km for the Moon and planets, a unit vector
    /// for a star; with its magnitude.
    fn state(&self, jd_utc: f64) -> Result<(Vec3, Option<f64>), AlmanacError> {
        match self {
            Body::Moon => {
                let m = MoonProvider::new()
                    .position(jd_utc)
                    .map_err(|e| unavailable("Moon", e))?;
                Ok((scale(radec_unit(m.ra_deg, m.dec_deg), m.distance_km), None))
            }
            Body::Planet(p) => {
                let pos = PlanetProvider::new()
                    .position(*p, jd_utc)
                    .map_err(|e| unavailable(p.name(), e))?;
                Ok((
                    scale(radec_unit(pos.ra_deg, pos.dec_deg), pos.distance_au * AU_KM),
                    pos.magnitude,
                ))
            }
            Body::Star(s) => {
                let sp = StarProvider::new();
                let (ra, dec) = sp
                    .apparent_radec_deg(s, jd_utc)
                    .map_err(|e| unavailable(s, e))?;
                Ok((radec_unit(ra, dec), sp.magnitude(s).ok()))
            }
        }
    }

    /// Interpolation segment (days) and nodes for this body. The interpolated vectors
    /// are ICRS (the nutation's 13.7-day wobble is put back exactly at evaluation), and
    /// the fastest term left is the Earth's monthly swing about the Earth-Moon
    /// barycentre (24" of Venus near inferior conjunction): 16 nodes on 32 days keep
    /// positions within 1e-6" and rates within 1e-5"/day.
    fn fit_plan(&self) -> (f64, usize) {
        match self {
            Body::Moon => (16.0, 24),
            // Venus and Mars pass within 0.3-0.4 au, where the Earth's monthly swing and
            // their own turning need the shorter segments.
            Body::Planet(Planet::Mercury | Planet::Venus | Planet::Mars) => (16.0, 16),
            Body::Planet(_) => (32.0, 16),
            Body::Star(_) => (128.0, 8),
        }
    }

    /// The apparent position of `state`, moved to the ICRS axes (the inverse of the
    /// bias-precession-nutation rotation of date).
    fn state_icrs(&self, jd_utc: f64) -> Result<Vec3, AlmanacError> {
        let v = self.state(jd_utc)?.0;
        Ok(mat_t_vec(&icrs_to_true_of_date(jd_tt(jd_utc)), v))
    }
}

fn sun_vector(jd_utc: f64) -> Result<Vec3, AlmanacError> {
    let s = SunProvider::new()
        .position(jd_utc)
        .map_err(|e| unavailable("Sun", e))?;
    Ok(scale(radec_unit(s.ra_deg, s.dec_deg), s.radius_au * AU_KM))
}

fn sun_vector_icrs(jd_utc: f64) -> Result<Vec3, AlmanacError> {
    Ok(mat_t_vec(
        &icrs_to_true_of_date(jd_tt(jd_utc)),
        sun_vector(jd_utc)?,
    ))
}

/// An ICRS interpolant of `body`'s apparent geocentric position.
fn fit_body(body: &Body, a: f64, b: f64) -> Result<VecFit, AlmanacError> {
    let (seg, n) = body.fit_plan();
    VecFit::new(|t| body.state_icrs(t), a, b, seg, n)
}

// ---------------------------------------------------------------------------
// Conjunctions
// ---------------------------------------------------------------------------

/// An observer's view: the site's position and axes, computed once for every instant and
/// body a search looks at.
struct Topo<'a> {
    site: &'a Site,
    position_km: Vec3,
    enu: [Vec3; 3],
}

impl<'a> Topo<'a> {
    fn new(site: &'a Site) -> Topo<'a> {
        Topo {
            site,
            position_km: site.position_km(),
            enu: site.enu_axes(),
        }
    }

    /// The Earth's rotation at an instant (GAST, DUT1 = 0: CONVENTIONS 13.2), shared by
    /// the bodies seen then.
    fn rotation(jd_utc: f64) -> Mat3 {
        r3(gast_deg(jd_ut1(jd_utc, 0.0), jd_tt(jd_utc)).to_radians())
    }

    /// Topocentric altitude, degrees, of a geocentric vector of date `v` (km; a unit
    /// vector for a star), with the refraction of CONVENTIONS 13.2 when `refract`.
    fn altitude(&self, rotation: &Mat3, v: Vec3, star: bool, refract: bool) -> f64 {
        let ef = mat_vec(rotation, v);
        let t = if star { ef } else { sub(ef, self.position_km) };
        let [e, n, up] = self.enu;
        let alt = dot(t, up).atan2(dot(t, e).hypot(dot(t, n))).to_degrees();
        if refract {
            alt + refraction_true_to_apparent_arcmin(
                alt,
                self.site.pressure_hpa,
                self.site.temperature_c,
            ) / 60.0
        } else {
            alt
        }
    }
}

fn parse_bodies(opts: &ConjunctionOptions) -> Result<(Vec<Body>, Vec<Body>), AlmanacError> {
    let mut planets = Vec::new();
    for name in &opts.planets {
        let p = Planet::from_name(name).ok_or_else(|| {
            AlmanacError::Invalid(format!(
                "conjunctions: {name:?} is not a planet (Mercury..Neptune)"
            ))
        })?;
        if !planets.contains(&p) {
            planets.push(p);
        }
    }
    // In the Sun-outward order whatever the request's, so `body` is the inner planet.
    planets.sort_by_key(|p| Planet::ALL.iter().position(|q| q == p));
    let planets: Vec<Body> = planets.into_iter().map(Body::Planet).collect();
    let mut stars = Vec::new();
    for name in &opts.stars {
        let entry = skyfix_ephemeris::catalog::find(name).ok_or_else(|| {
            AlmanacError::Invalid(format!("conjunctions: {name:?} is not a navigational star"))
        })?;
        let b = Body::Star(entry.name.to_string());
        if !stars.contains(&b) {
            stars.push(b);
        }
    }
    Ok((planets, stars))
}

/// Every closest approach in `[jd_start, jd_end]` (UTC Julian dates) that `options`
/// asks for.
pub fn conjunctions(
    jd_start: f64,
    jd_end: f64,
    options: &ConjunctionOptions,
) -> Result<ConjunctionList, AlmanacError> {
    if !(0.1..=20.0).contains(&options.max_separation_deg) {
        return Err(AlmanacError::Invalid(format!(
            "conjunctions: max_separation_deg must be 0.1 to 20 (got {})",
            options.max_separation_deg
        )));
    }
    let site = options.observer.as_ref().map(checked_site).transpose()?;
    let (planets, stars) = parse_bodies(options)?;
    let (lo, hi) = coverage_with_moon(options.moon);
    let (a, b, truncated) = clip_window("conjunctions", jd_start, jd_end, lo, hi, MAX_WINDOW_DAYS)?;
    let mut out = Vec::new();
    if a < b {
        let pad = 2.0;
        let (fa, fb) = ((a - pad).max(lo), (b + pad).min(hi));
        let mut bodies: Vec<Body> = Vec::new();
        if options.moon {
            bodies.push(Body::Moon);
        }
        bodies.extend(planets.iter().cloned());
        bodies.extend(stars.iter().cloned());
        let fits = bodies
            .iter()
            .map(|body| fit_body(body, fa, fb))
            .collect::<Result<Vec<_>, _>>()?;
        let sun = VecFit::new(sun_vector_icrs, fa, fb, 32.0, 12)?;
        let is_star = |k: usize| matches!(bodies[k], Body::Star(_));
        let mut pairs = Vec::new();
        for i in 0..bodies.len() {
            for j in i + 1..bodies.len() {
                if is_star(i) && is_star(j) {
                    continue;
                }
                let kind = match (&bodies[i], &bodies[j]) {
                    (Body::Moon, Body::Planet(_)) => ConjunctionKind::MoonPlanet,
                    (Body::Moon, Body::Star(_)) => ConjunctionKind::MoonStar,
                    (Body::Planet(_), Body::Planet(_)) => ConjunctionKind::PlanetPlanet,
                    (Body::Planet(_), Body::Star(_)) => ConjunctionKind::PlanetStar,
                    _ => continue,
                };
                pairs.push((i, j, kind));
            }
        }
        for (i, j, kind) in pairs {
            let step = match (&bodies[i], &bodies[j]) {
                (Body::Moon, _) => 0.25,
                (Body::Planet(Planet::Mercury), _) | (_, Body::Planet(Planet::Mercury)) => 0.5,
                _ => 1.0,
            };
            let sep = |t: f64| angle(fits[i].eval(t), fits[j].eval(t));
            let n = ((fb - fa) / step).ceil() as usize;
            let h = (fb - fa) / n as f64;
            let s: Vec<f64> = (0..=n).map(|k| sep(fa + h * k as f64)).collect();
            for k in 1..n {
                if !(s[k] < s[k - 1] && s[k] <= s[k + 1]) {
                    continue;
                }
                let (t0, t1) = (fa + h * (k - 1) as f64, fa + h * (k + 1) as f64);
                let (t, v) = minimise(sep, t0, t1, 1e-8);
                if t < a || t > b || v.to_degrees() > options.max_separation_deg + 0.01 {
                    continue;
                }
                let c = conjunction(
                    &bodies[i],
                    &bodies[j],
                    kind,
                    t,
                    options,
                    site.as_ref(),
                    &fits[i],
                    &fits[j],
                    &sun,
                )?;
                if c.separation_deg <= options.max_separation_deg {
                    out.push(c);
                }
            }
        }
    }
    out.sort_by(|x, y| x.jd_utc.total_cmp(&y.jd_utc));
    Ok(ConjunctionList {
        jd_start: a,
        jd_end: b,
        truncated,
        coverage_start_utc: format_utc(lo),
        coverage_end_utc: format_utc(hi),
        conjunctions: out,
    })
}

fn coverage_with_moon(moon: bool) -> (f64, f64) {
    use skyfix_ephemeris::AstroProvider;
    let (mut lo, mut hi) = sun_planet_coverage();
    let parse = |s: &str| skyfix_core::time::parse_utc(s).unwrap_or(f64::NAN);
    for c in [StarProvider::new().coverage()]
        .into_iter()
        .chain(moon.then(|| MoonProvider::new().coverage()))
    {
        lo = lo.max(parse(&c.start_utc));
        hi = hi.min(parse(&c.end_utc));
    }
    (lo, hi)
}

#[allow(clippy::too_many_arguments)]
fn conjunction(
    body: &Body,
    other: &Body,
    kind: ConjunctionKind,
    t: f64,
    options: &ConjunctionOptions,
    site: Option<&Site>,
    fit_body: &VecFit,
    fit_other: &VecFit,
    sun: &VecFit,
) -> Result<Conjunction, AlmanacError> {
    let (vb, mb) = body.state(t)?;
    let (vo, mo) = other.state(t)?;
    let vs = sun_vector(t)?;
    let (ra, dec) = radec_of(vb);
    let eb = angle(vb, vs).to_degrees();
    let eo = angle(vo, vs).to_degrees();
    let local = site.map(|site| {
        let star_o = matches!(other, Body::Star(_));
        // One rotation to the true equator of date serves the whole day either side: it
        // turns by under 0.1" in 12 hours.
        let bpn = icrs_to_true_of_date(jd_tt(t));
        let date = |v: Vec3| mat_vec(&bpn, v);
        let topo = Topo::new(site);
        let sun_alt = |rot: &Mat3, t: f64| topo.altitude(rot, date(sun.eval(t)), false, false);
        let pair_alts = |rot: &Mat3, t: f64| {
            (
                topo.altitude(rot, date(fit_body.eval(t)), false, true),
                topo.altitude(rot, date(fit_other.eval(t)), star_o, true),
            )
        };
        let mut best: Option<ConjunctionView> = None;
        let steps = 96;
        for k in 0..=steps {
            let tk = t - 0.5 + k as f64 / steps as f64;
            let rot = Topo::rotation(tk);
            let hs = sun_alt(&rot, tk);
            if hs > -6.0 {
                continue;
            }
            let (hb, ho) = pair_alts(&rot, tk);
            if hb.min(ho) <= 0.0 {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|b| hb.min(ho) > b.body_alt_deg.min(b.other_alt_deg))
            {
                best = Some(ConjunctionView {
                    jd_utc: tk,
                    utc: format_utc(tk),
                    body_alt_deg: hb,
                    other_alt_deg: ho,
                    sun_alt_deg: hs,
                });
            }
        }
        let rot = Topo::rotation(t);
        let (hb, ho) = pair_alts(&rot, t);
        ConjunctionLocal {
            body_alt_deg: hb,
            other_alt_deg: ho,
            sun_alt_deg: sun_alt(&rot, t),
            best,
        }
    });
    Ok(Conjunction {
        kind,
        body: body.name(),
        other: other.name(),
        jd_utc: t,
        utc: format_utc(t),
        separation_deg: angle(vb, vo).to_degrees(),
        position_angle_deg: position_angle_deg(vo, vb),
        ra_deg: ra,
        dec_deg: dec,
        body_elongation_deg: eb,
        other_elongation_deg: eo,
        body_magnitude: mb,
        other_magnitude: mo,
        visible: eb >= options.min_sun_elongation_deg && eo >= options.min_sun_elongation_deg,
        local,
    })
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/// The apparent right ascension, or ecliptic longitude (true ecliptic and equinox of
/// date), of an ICRS interpolant at `t`, radians. The rotation to the date frame is exact
/// at every call, so the nutation's short terms (0.2" at 13.7 days, a real part of the
/// apparent motion) are in it.
fn longitude_of_date(fit: &VecFit, t: f64, ecliptic: bool) -> f64 {
    let jt = jd_tt(t);
    let p = mat_vec(&icrs_to_true_of_date(jt), fit.eval(t));
    if ecliptic {
        let (se, ce) = true_obliquity_rad(jt).sin_cos();
        (p[1] * ce + p[2] * se).atan2(p[0])
    } else {
        p[1].atan2(p[0])
    }
}

/// Rate of that longitude, radians per day: a central difference over +/-0.05 day (its
/// truncation error is under 1e-5"/day even for Neptune).
fn longitude_rate(fit: &VecFit, t: f64, ecliptic: bool) -> f64 {
    let h = 0.05;
    let d = longitude_of_date(fit, t + h, ecliptic) - longitude_of_date(fit, t - h, ecliptic);
    let d =
        (d + std::f64::consts::PI).rem_euclid(2.0 * std::f64::consts::PI) - std::f64::consts::PI;
    d / (2.0 * h)
}

/// Every station of Mercury to Neptune in right ascension and in ecliptic longitude in
/// `[jd_start, jd_end]` (UTC Julian dates).
pub fn stations(jd_start: f64, jd_end: f64) -> Result<StationList, AlmanacError> {
    let (lo, hi) = planet_coverage();
    let (a, b, truncated) = clip_window(
        "stations",
        jd_start,
        jd_end,
        lo,
        hi,
        MAX_STATION_WINDOW_DAYS,
    )?;
    let mut out = Vec::new();
    if a < b {
        for planet in Planet::ALL {
            let body = Body::Planet(planet);
            let pad = 5.0;
            let (fa, fb) = ((a - pad).max(lo), (b + pad).min(hi));
            let fit = fit_body(&body, fa, fb)?;
            let step = match planet {
                Planet::Mercury => 2.0,
                Planet::Venus | Planet::Mars => 4.0,
                _ => 8.0,
            };
            for coord in [
                StationCoordinate::EclipticLongitude,
                StationCoordinate::RightAscension,
            ] {
                let ecl = coord == StationCoordinate::EclipticLongitude;
                let rate = |t: f64| longitude_rate(&fit, t, ecl);
                let n = ((fb - fa) / step).ceil() as usize;
                let h = (fb - fa) / n as f64;
                let mut prev = (fa, rate(fa));
                for k in 1..=n {
                    let t1 = fa + h * k as f64;
                    let r1 = rate(t1);
                    if prev.1 * r1 < 0.0 {
                        if let Some(t) = root(rate, prev.0, t1, 1e-8) {
                            if t >= a && t <= b {
                                let kind = if prev.1 > 0.0 {
                                    StationKind::RetrogradeBegins
                                } else {
                                    StationKind::RetrogradeEnds
                                };
                                out.push(station(planet, kind, coord, t)?);
                            }
                        }
                    }
                    prev = (t1, r1);
                }
            }
        }
    }
    out.sort_by(|x, y| x.jd_utc.total_cmp(&y.jd_utc));
    Ok(StationList {
        jd_start: a,
        jd_end: b,
        truncated,
        coverage_start_utc: format_utc(lo),
        coverage_end_utc: format_utc(hi),
        stations: out,
        ui_coordinate: StationCoordinate::EclipticLongitude,
    })
}

fn station(
    planet: Planet,
    kind: StationKind,
    coordinate: StationCoordinate,
    t: f64,
) -> Result<Station, AlmanacError> {
    let p = PlanetProvider::new()
        .position(planet, t)
        .map_err(|e| unavailable(planet.name(), e))?;
    let lon =
        crate::events::ecliptic_longitude_deg(p.ra_deg, p.dec_deg, true_obliquity_rad(p.jd_tt));
    Ok(Station {
        body: planet.name().to_string(),
        kind,
        coordinate,
        jd_utc: t,
        utc: format_utc(t),
        angle_deg: match coordinate {
            StationCoordinate::EclipticLongitude => lon,
            StationCoordinate::RightAscension => p.ra_deg,
        },
        ra_deg: p.ra_deg,
        dec_deg: p.dec_deg,
        ecliptic_longitude_deg: lon,
        elongation_deg: p.elongation_deg,
        magnitude: p.magnitude,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn fits_follow_the_providers() {
        // Saturn at a station (2024 July), Venus at inferior conjunction (2025 March,
        // 0.28 au: the Earth's monthly swing is 24" there) and the Moon; the fits placed
        // differently by a short and a long window.
        for (body, t0) in [
            (Body::Planet(Planet::Saturn), civil_to_jd(2024, 7, 2)),
            (Body::Planet(Planet::Venus), civil_to_jd(2025, 3, 23)),
            (Body::Moon, civil_to_jd(2025, 3, 23)),
        ] {
            for (a, b) in [(t0 - 20.0, t0 + 20.0), (t0 - 3000.0, t0 + 3000.0)] {
                let fit = fit_body(&body, a, b).unwrap();
                let (mut pos, mut rate) = (0.0f64, 0.0f64);
                for k in 0..=40 {
                    let t = t0 - 2.0 + k as f64 * 0.1;
                    let exact = body.state_icrs(t).unwrap();
                    pos = pos.max(angle(fit.eval(t), exact) * 206_264.8);
                    // The longitude's rate against exact positions differenced the same way.
                    let exact_lon = |t: f64| {
                        let p = body.state(t).unwrap().0;
                        let (se, ce) = true_obliquity_rad(jd_tt(t)).sin_cos();
                        (p[1] * ce + p[2] * se).atan2(p[0])
                    };
                    let h = 0.05;
                    let want = (exact_lon(t + h) - exact_lon(t - h)) / (2.0 * h);
                    rate = rate.max((longitude_rate(&fit, t, true) - want).abs() * 206_264.8);
                }
                println!(
                    "{body:?} window {:.0}: position {pos:.2e}\", rate {rate:.2e}\"/day",
                    b - a
                );
                assert!(pos < 1e-4 && rate < 1e-4, "{body:?}: {pos} {rate}");
            }
        }
    }

    #[test]
    fn the_great_conjunction_of_2020() {
        // Jupiter and Saturn, 2020 December 21: 0.10 degrees apart.
        let opts = ConjunctionOptions {
            moon: false,
            stars: vec![],
            // Listed outer first: `body` is still the inner planet.
            planets: vec!["Saturn".into(), "Jupiter".into()],
            ..ConjunctionOptions::default()
        };
        let l = conjunctions(civil_to_jd(2020, 12, 1), civil_to_jd(2021, 1, 1), &opts).unwrap();
        assert_eq!(l.conjunctions.len(), 1, "{l:?}");
        let c = &l.conjunctions[0];
        assert!(c.utc.starts_with("2020-12-21"), "{c:?}");
        assert!((c.separation_deg - 0.102).abs() < 0.002, "{c:?}");
        assert_eq!(c.body, "Jupiter");
    }

    #[test]
    fn mars_turns_retrograde_in_december_2024() {
        let s = stations(civil_to_jd(2024, 11, 1), civil_to_jd(2025, 3, 1)).unwrap();
        let mars: Vec<&Station> = s
            .stations
            .iter()
            .filter(|x| x.body == "Mars" && x.coordinate == StationCoordinate::EclipticLongitude)
            .collect();
        assert_eq!(mars.len(), 2, "{mars:?}");
        assert_eq!(mars[0].kind, StationKind::RetrogradeBegins);
        assert!(mars[0].utc.starts_with("2024-12-0"), "{mars:?}");
        assert_eq!(mars[1].kind, StationKind::RetrogradeEnds);
        assert!(mars[1].utc.starts_with("2025-02-2"), "{mars:?}");
    }
}
