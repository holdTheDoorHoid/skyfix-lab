//! Transits of Mercury and Venus across the Sun: the four contacts and greatest transit
//! seen from the Earth's centre, and, for an observer, the local contacts, where on the
//! Sun's limb they happen, the Sun's altitude at each and whether the transit is in
//! progress at sunrise or sunset.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.12; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail".
//!
//! # Definitions
//!
//! - **Contacts** (as NASA's catalogues define them): I and IV when the planet's disc is
//!   externally tangent to the Sun's (the separation of the centres equals the sum of
//!   the semidiameters), II and III internally tangent (their difference). **Greatest
//!   transit** is the least separation. A transit that never reaches internal tangency
//!   (a grazing one) has no II and III.
//! - **Discs**: the Sun's semidiameter is `959.63" / R` (the IAU value NASA's eclipse and
//!   transit predictions use), the planet's `asin(R_eq / delta)` with its IAU 2015
//!   equatorial radius. Both centres are the apparent geocentric places of the planet
//!   provider (the planet and the Sun from one evaluation; CONVENTIONS section 7).
//! - **Local contacts**: the same with both bodies seen from the observer's place on the
//!   WGS84 ellipsoid (the Earth-fixed frame of `skyfix_ephemeris::topocentric`): Venus's
//!   parallax is up to 32", the Sun's 8.8", so local contacts differ from the geocentric
//!   ones by up to about 7 minutes. Position angles are measured on the Sun's disc from
//!   the north point (true equator of date) through east; the vertex angle from the
//!   point nearest the zenith, `vertex = PA - q`, `q` the Sun's parallactic angle.
//! - **The Sun's altitude** is CONVENTIONS 13.2's (topocentric, geometric, centre); a
//!   contact is `visible` when the Sun is above its rise/set altitude, -50' (13.3).
//!
//! # Search
//!
//! Inferior conjunctions are predicted with Meeus's chapter 36 formulas (mean synodic
//! period plus periodic terms, about a tenth of a day), the least separation is found
//! within three days of each by Brent's method on the provider, and the contacts by
//! Brent's root finder on either side of it (to 0.01 s).

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, jd_tt};
use skyfix_core::units::norm_360;
use skyfix_ephemeris::planets::{Planet, PlanetPosition, PlanetProvider};
use skyfix_ephemeris::sun::{SUN_SEMIDIAMETER_UNIT_ARCSEC, SunProvider};
use skyfix_ephemeris::topocentric::{Site, earth_fixed_unit};

use crate::planet_geometry::{
    RAD_TO_ARCSEC, Vec3, angle, clip_window, dot, jd_utc_from_tt, norm, position_angle_deg, scale,
    sub, sun_planet_coverage, tangent_plane, unavailable,
};
use crate::planet_geometry::{minimise, root};
use crate::sky::{AlmanacError, SUN_RISE_SET_DEG, checked_site};

const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;
/// Roots to this, days (0.01 s).
const ROOT_TOL_DAYS: f64 = 1e-7;
/// Longest window `transits` searches, days (1200 years).
pub const MAX_WINDOW_DAYS: f64 = 1200.0 * 365.25;
/// Points on each drawn path, contact I to contact IV.
const PATH_POINTS: usize = 25;

/// Echo of the observer a local computation used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitObserver {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub height_m: f64,
}

/// A geocentric contact or greatest transit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitContact {
    /// `"c1"`, `"c2"`, `"greatest"`, `"c3"` or `"c4"`.
    pub kind: String,
    pub jd_utc: f64,
    pub utc: String,
    /// TT Julian date, for comparison with catalogues kept in dynamical time.
    pub jd_tt: f64,
    /// Position angle of the planet's centre on the Sun's disc, from north through east.
    pub position_angle_deg: f64,
    /// Separation of the centres, arcseconds.
    pub separation_arcsec: f64,
}

/// One point of a path across the Sun: the planet's centre relative to the Sun's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitPathPoint {
    pub jd_utc: f64,
    /// Toward celestial east and north (true equator of date), arcseconds.
    pub east_arcsec: f64,
    pub north_arcsec: f64,
}

/// A local contact, greatest transit, sunrise or sunset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitLocalEvent {
    /// `"c1"`, `"c2"`, `"greatest"`, `"c3"`, `"c4"`, `"sunrise"` or `"sunset"`.
    pub kind: String,
    pub jd_utc: f64,
    pub utc: String,
    /// The Sun's topocentric geometric altitude and azimuth, degrees.
    pub sun_alt_deg: f64,
    pub sun_az_deg: f64,
    /// The Sun is above its rise/set altitude (-50').
    pub visible: bool,
    /// Where the planet is on the Sun's disc: from north, and from the zenith point.
    pub position_angle_deg: f64,
    pub vertex_angle_deg: f64,
    /// Separation of the centres seen from the observer, arcseconds.
    pub separation_arcsec: f64,
}

/// What one observer sees of a transit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitLocal {
    pub observer: TransitObserver,
    /// `"visible"` (the Sun is up throughout), `"partly_below_horizon"` (it rises or
    /// sets during the transit; the `sunrise`/`sunset` event is listed) or
    /// `"below_horizon"` (it is down throughout); `"none"` when, seen from here, the
    /// planet misses the Sun (possible only near a geocentric graze).
    pub visibility: String,
    pub events: Vec<TransitLocalEvent>,
    pub path: Vec<TransitPathPoint>,
}

/// One transit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transit {
    /// `"2012-06-06-venus"`: the UTC date of greatest transit and the planet.
    pub id: String,
    pub planet: String,
    /// Seen from the Earth's centre, in time order.
    pub contacts: Vec<TransitContact>,
    pub min_separation_arcsec: f64,
    pub sun_semidiameter_arcsec: f64,
    pub planet_semidiameter_arcsec: f64,
    /// The planet never gets wholly inside the Sun's disc (no contacts II and III).
    pub grazing: bool,
    /// Duration from contact I to IV, seconds.
    pub duration_s: f64,
    /// The geocentric path, contact I to contact IV.
    pub path: Vec<TransitPathPoint>,
    /// TT - UTC used, seconds.
    pub tt_minus_utc_s: f64,
    /// Present when an observer was given.
    pub local: Option<TransitLocal>,
}

/// `transits` result (EXPLORER_API.md `TransitList`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitList {
    pub jd_start: f64,
    pub jd_end: f64,
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    pub transits: Vec<Transit>,
    pub conventions: String,
}

// ---------------------------------------------------------------------------
// Prediction of inferior conjunctions (Meeus chapter 36)
// ---------------------------------------------------------------------------

/// `(A, B, M0, M1)` of Meeus's table 36.A and the table 36.B periodic terms: the
/// constant polynomial, then (sin kM, cos kM) polynomial pairs, each `[c0, c1, c2]` in T.
struct Predictor {
    a: f64,
    b: f64,
    m0: f64,
    m1: f64,
    terms: &'static [[f64; 3]],
}

const MERCURY: Predictor = Predictor {
    a: 2_451_612.023,
    b: 115.877_477_1,
    m0: 63.5867,
    m1: 114.208_874_2,
    terms: &[
        [0.0545, 0.0002, 0.0],
        [-6.2008, 0.0074, 0.00003],
        [-3.2750, -0.0197, 0.00001],
        [0.4737, -0.0052, -0.00001],
        [0.8111, 0.0033, -0.00002],
        [0.0037, 0.0018, 0.0],
        [-0.1768, 0.0, 0.00001],
        [-0.0211, -0.0004, 0.0],
        [0.0326, -0.0003, 0.0],
        [0.0083, 0.0001, 0.0],
        [-0.0040, 0.0001, 0.0],
    ],
};

const VENUS: Predictor = Predictor {
    a: 2_451_996.706,
    b: 583.921_361,
    m0: 82.7311,
    m1: 215.513_058,
    terms: &[
        [-0.0096, 0.0002, -0.00001],
        [2.0009, -0.0033, -0.00001],
        [0.5980, -0.0104, 0.00001],
        [0.0967, -0.0018, -0.00003],
        [0.0913, 0.0009, -0.00002],
        [0.0046, -0.0002, 0.0],
        [0.0079, 0.0001, 0.0],
    ],
};

impl Predictor {
    /// JDE of the `k`-th inferior conjunction from the reference one.
    fn jde(&self, k: f64) -> f64 {
        let jde0 = self.a + k * self.b;
        let m = (self.m0 + k * self.m1).rem_euclid(360.0).to_radians();
        let t = (jde0 - 2_451_545.0) / 36_525.0;
        let poly = |c: &[f64; 3]| c[0] + t * (c[1] + t * c[2]);
        let mut sum = poly(&self.terms[0]);
        for (i, pair) in self.terms[1..].chunks(2).enumerate() {
            let arg = (i + 1) as f64 * m;
            sum += arg.sin() * poly(&pair[0]) + arg.cos() * poly(&pair[1]);
        }
        jde0 + sum
    }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// The planet and the Sun from one provider evaluation, as vectors in the Earth-fixed
/// frame of date (x to Greenwich, z to the true pole), km, from the Earth's centre.
struct Pair {
    position: PlanetPosition,
    planet: Vec3,
    sun: Vec3,
}

fn pair(
    provider: &PlanetProvider,
    planet: Planet,
    sun_r_au: f64,
    jd_utc: f64,
) -> Result<Pair, AlmanacError> {
    let p = provider
        .position(planet, jd_utc)
        .map_err(|e| unavailable(planet.name(), e))?;
    let sun_gha = norm_360(p.gast_deg - p.sun_ra_deg);
    Ok(Pair {
        planet: scale(
            earth_fixed_unit(p.gha_deg, p.dec_deg),
            p.distance_au * AU_KM,
        ),
        sun: scale(earth_fixed_unit(sun_gha, p.sun_dec_deg), sun_r_au * AU_KM),
        position: p,
    })
}

/// Separation (arcsec), semidiameters (arcsec) and the planet's position angle on the
/// Sun (degrees), seen from `site_km` (Earth-fixed; zero for the Earth's centre).
struct View {
    separation: f64,
    sd_sun: f64,
    sd_planet: f64,
    pa: f64,
    /// The planet's offset from the Sun's centre, east and north, arcseconds.
    east: f64,
    north: f64,
}

fn view(pr: &Pair, planet: Planet, site_km: Vec3) -> View {
    let p = sub(pr.planet, site_km);
    let s = sub(pr.sun, site_km);
    let sun_radius_km = SUN_SEMIDIAMETER_UNIT_ARCSEC / RAD_TO_ARCSEC * AU_KM;
    let (e, n) = tangent_plane(s, p);
    View {
        separation: angle(p, s) * RAD_TO_ARCSEC,
        sd_sun: (sun_radius_km / norm(s)).asin() * RAD_TO_ARCSEC,
        sd_planet: (planet.equatorial_radius_km() / norm(p)).asin() * RAD_TO_ARCSEC,
        pa: position_angle_deg(s, p),
        east: e * RAD_TO_ARCSEC,
        north: n * RAD_TO_ARCSEC,
    }
}

struct Searcher<'a> {
    provider: &'a PlanetProvider,
    planet: Planet,
    sun_r_au: f64,
    site_km: Vec3,
    failure: std::cell::RefCell<Option<AlmanacError>>,
}

impl Searcher<'_> {
    fn at(&self, jd: f64) -> Option<View> {
        match pair(self.provider, self.planet, self.sun_r_au, jd) {
            Ok(pr) => Some(view(&pr, self.planet, self.site_km)),
            Err(e) => {
                self.failure.borrow_mut().get_or_insert(e);
                None
            }
        }
    }

    fn separation(&self, jd: f64) -> f64 {
        self.at(jd).map_or(f64::NAN, |v| v.separation)
    }

    /// `separation - (SD_sun + sign * SD_planet)`.
    fn contact_fn(&self, sign: f64) -> impl Fn(f64) -> f64 + '_ {
        move |jd| {
            self.at(jd)
                .map_or(f64::NAN, |v| v.separation - (v.sd_sun + sign * v.sd_planet))
        }
    }

    /// Greatest transit near `guess` and the contacts around it: `(t_greatest,
    /// [c1, c2, c3, c4])`, contacts `None` when they do not happen. `None` overall when
    /// there is no transit.
    fn contacts(&self, lo: f64, hi: f64) -> Option<(f64, [Option<f64>; 4])> {
        let (tm, sep) = minimise(&|t| self.separation(t), lo, hi, 1e-7);
        let v = self.at(tm)?;
        if sep.is_nan() || sep >= v.sd_sun + v.sd_planet {
            return None;
        }
        let ext = self.contact_fn(1.0);
        let int = self.contact_fn(-1.0);
        let half = 0.5;
        let c1 = root(&ext, tm - half, tm, ROOT_TOL_DAYS);
        let c4 = root(&ext, tm, tm + half, ROOT_TOL_DAYS);
        let (c2, c3) = if sep < v.sd_sun - v.sd_planet {
            (
                root(&int, tm - half, tm, ROOT_TOL_DAYS),
                root(&int, tm, tm + half, ROOT_TOL_DAYS),
            )
        } else {
            (None, None)
        };
        Some((tm, [c1, c2, c3, c4]))
    }
}

fn sun_radius_au(jd_utc: f64) -> Result<f64, AlmanacError> {
    Ok(SunProvider::new()
        .position(jd_utc)
        .map_err(|e| unavailable("Sun", e))?
        .radius_au)
}

/// The Sun's topocentric geometric altitude and azimuth and its parallactic angle, from
/// `site` (degrees).
fn sun_horizon(pr: &Pair, site: &Site) -> (f64, f64, f64) {
    let s = sub(pr.sun, site.position_km());
    let [e, n, up] = site.enu_axes();
    let alt = dot(s, up).atan2(dot(s, e).hypot(dot(s, n))).to_degrees();
    let az = dot(s, e).atan2(dot(s, n)).to_degrees().rem_euclid(360.0);
    let p = &pr.position;
    let sun_gha = norm_360(p.gast_deg - p.sun_ra_deg);
    let lha = (sun_gha + site.lon_deg).to_radians();
    let (phi, dec) = (site.lat_deg.to_radians(), p.sun_dec_deg.to_radians());
    let q = lha
        .sin()
        .atan2(phi.tan() * dec.cos() - dec.sin() * lha.cos())
        .to_degrees();
    (alt, az, q)
}

fn path(s: &Searcher, a: f64, b: f64) -> Vec<TransitPathPoint> {
    (0..PATH_POINTS)
        .filter_map(|i| {
            let t = a + (b - a) * i as f64 / (PATH_POINTS - 1) as f64;
            s.at(t).map(|v| TransitPathPoint {
                jd_utc: t,
                east_arcsec: v.east,
                north_arcsec: v.north,
            })
        })
        .collect()
}

const CONTACT_NAMES: [&str; 4] = ["c1", "c2", "c3", "c4"];

fn local(
    provider: &PlanetProvider,
    planet: Planet,
    sun_r_au: f64,
    site: &Site,
    geocentric: (f64, f64),
) -> Result<TransitLocal, AlmanacError> {
    let s = Searcher {
        provider,
        planet,
        sun_r_au,
        site_km: site.position_km(),
        failure: std::cell::RefCell::new(None),
    };
    // The local transit is within about 8 minutes of the geocentric one.
    let pad = 0.02;
    let (g0, g4) = geocentric;
    let found = s.contacts(g0 - pad, g4 + pad);
    if let Some(e) = s.failure.borrow_mut().take() {
        return Err(e);
    }
    let observer = TransitObserver {
        lat_deg: site.lat_deg,
        lon_deg: site.lon_deg,
        height_m: site.height_m,
    };
    let Some((tm, contacts)) = found else {
        // Seen from here the planet misses the Sun (possible only for a geocentric
        // graze).
        return Ok(TransitLocal {
            observer,
            visibility: "none".to_string(),
            events: Vec::new(),
            path: Vec::new(),
        });
    };
    let mut marks: Vec<(String, f64)> = Vec::new();
    for (name, t) in CONTACT_NAMES.iter().zip(contacts) {
        if let Some(t) = t {
            marks.push((name.to_string(), t));
        }
    }
    marks.push(("greatest".to_string(), tm));
    let (t_first, t_last) = (contacts[0].unwrap_or(tm), contacts[3].unwrap_or(tm));
    // Sunrise and sunset inside the transit.
    let sun_alt = |t: f64| -> f64 {
        pair(provider, planet, sun_r_au, t).map_or(f64::NAN, |pr| sun_horizon(&pr, site).0)
            - SUN_RISE_SET_DEG
    };
    let n = (((t_last - t_first) * 24.0 * 6.0).ceil() as usize).max(1);
    let h = (t_last - t_first) / n as f64;
    let mut prev = (t_first, sun_alt(t_first));
    for i in 1..=n {
        let t = t_first + h * i as f64;
        let v = sun_alt(t);
        if prev.1 * v < 0.0 {
            if let Some(tr) = root(&sun_alt, prev.0, t, 1e-7) {
                let name = if prev.1 < 0.0 { "sunrise" } else { "sunset" };
                marks.push((name.to_string(), tr));
            }
        }
        prev = (t, v);
    }
    marks.sort_by(|x, y| x.1.total_cmp(&y.1));
    let mut events = Vec::with_capacity(marks.len());
    for (kind, t) in marks {
        let pr = pair(provider, planet, sun_r_au, t)?;
        let v = view(&pr, planet, site.position_km());
        let (alt, az, q) = sun_horizon(&pr, site);
        events.push(TransitLocalEvent {
            kind,
            jd_utc: t,
            utc: format_utc(t),
            sun_alt_deg: alt,
            sun_az_deg: az,
            visible: alt > SUN_RISE_SET_DEG - 1e-9,
            position_angle_deg: v.pa,
            vertex_angle_deg: (v.pa - q).rem_euclid(360.0),
            separation_arcsec: v.separation,
        });
    }
    let contact_events: Vec<&TransitLocalEvent> = events
        .iter()
        .filter(|e| e.kind != "sunrise" && e.kind != "sunset")
        .collect();
    let up = contact_events.iter().filter(|e| e.visible).count();
    let crossings = events.len() - contact_events.len();
    let visibility = if crossings == 0 && up == contact_events.len() {
        "visible"
    } else if crossings == 0 && up == 0 {
        "below_horizon"
    } else {
        "partly_below_horizon"
    };
    Ok(TransitLocal {
        observer,
        visibility: visibility.to_string(),
        events,
        path: path(&s, t_first, t_last),
    })
}

/// Every transit of Mercury and Venus with greatest transit in `[jd_start, jd_end]`
/// (UTC Julian dates), with local circumstances when `site` is given.
pub fn transits(
    provider: &PlanetProvider,
    jd_start: f64,
    jd_end: f64,
    site: Option<&Site>,
) -> Result<TransitList, AlmanacError> {
    let (lo, hi) = sun_planet_coverage();
    let (a, b, truncated) = clip_window("transits", jd_start, jd_end, lo, hi, MAX_WINDOW_DAYS)?;
    let site = site.map(checked_site).transpose()?;
    let mut out = Vec::new();
    if a <= b {
        for (planet, pred) in [(Planet::Mercury, &MERCURY), (Planet::Venus, &VENUS)] {
            let k0 = ((jd_tt(a) - pred.a) / pred.b).floor() - 1.0;
            let k1 = ((jd_tt(b) - pred.a) / pred.b).ceil() + 1.0;
            let mut k = k0;
            while k <= k1 {
                let guess = jd_utc_from_tt(pred.jde(k));
                k += 1.0;
                let (g_lo, g_hi) = (guess - 3.0, guess + 3.0);
                if g_hi < a - 1.0 || g_lo > b + 1.0 || g_lo < lo || g_hi > hi {
                    continue;
                }
                let sun_r_au = sun_radius_au(guess)?;
                let s = Searcher {
                    provider,
                    planet,
                    sun_r_au,
                    site_km: [0.0; 3],
                    failure: std::cell::RefCell::new(None),
                };
                // A transit needs the planet within about 0.3 degrees of the Sun: skip
                // conjunctions that pass wide without the full search.
                let near = [-2.0, -1.0, 0.0, 1.0, 2.0]
                    .iter()
                    .map(|d| s.separation(guess + d))
                    .fold(f64::INFINITY, f64::min);
                if let Some(e) = s.failure.borrow_mut().take() {
                    return Err(e);
                }
                if near > 3.0 * 3600.0 {
                    continue;
                }
                let found = s.contacts(g_lo, g_hi);
                if let Some(e) = s.failure.borrow_mut().take() {
                    return Err(e);
                }
                let Some((tm, c)) = found else { continue };
                if tm < a || tm > b {
                    continue;
                }
                // The Sun's distance at greatest transit (it changes by 1e-5 in a day).
                let sun_r_au = sun_radius_au(tm)?;
                let s = Searcher { sun_r_au, ..s };
                let (tm, c) = s.contacts(tm - 0.3, tm + 0.3).unwrap_or((tm, c));
                out.push(transit(provider, &s, planet, tm, c, site.as_ref())?);
            }
        }
    }
    out.sort_by(|x, y| x.contacts[0].jd_utc.total_cmp(&y.contacts[0].jd_utc));
    Ok(TransitList {
        jd_start: a,
        jd_end: b,
        truncated,
        coverage_start_utc: format_utc(lo),
        coverage_end_utc: format_utc(hi),
        transits: out,
        conventions: "Contacts I and IV: the discs externally tangent; II and III internally \
                      tangent; greatest transit: the least separation of the centres. The \
                      Sun's semidiameter is 959.63\"/R, the planet's from its IAU 2015 \
                      equatorial radius. Geocentric times are for the Earth's centre; local \
                      times for the observer on the WGS84 ellipsoid. Position angles are on \
                      the Sun's disc from the north point through east (vertex angles from \
                      the zenith point)."
            .to_string(),
    })
}

fn transit(
    provider: &PlanetProvider,
    s: &Searcher,
    planet: Planet,
    tm: f64,
    c: [Option<f64>; 4],
    site: Option<&Site>,
) -> Result<Transit, AlmanacError> {
    let mut contacts = Vec::new();
    let mut marks: Vec<(&str, f64)> = CONTACT_NAMES
        .iter()
        .zip(c)
        .filter_map(|(n, t)| t.map(|t| (*n, t)))
        .collect();
    marks.push(("greatest", tm));
    marks.sort_by(|x, y| x.1.total_cmp(&y.1));
    let mut greatest_view = None;
    for (kind, t) in marks {
        let v = s.at(t).ok_or_else(|| {
            s.failure
                .borrow_mut()
                .take()
                .unwrap_or_else(|| unavailable(planet.name(), "no position"))
        })?;
        contacts.push(TransitContact {
            kind: kind.to_string(),
            jd_utc: t,
            utc: format_utc(t),
            jd_tt: jd_tt(t),
            position_angle_deg: v.pa,
            separation_arcsec: v.separation,
        });
        if kind == "greatest" {
            greatest_view = Some(v);
        }
    }
    let g = greatest_view.expect("greatest transit is always listed");
    let (t1, t4) = (c[0].unwrap_or(tm), c[3].unwrap_or(tm));
    // The date part of the timestamp, whole for an expanded year too (verify2: `[..10]`
    // would cut `-0584-05-22` to `-0584-05-2`).
    let date = crate::sun_tools::local_date(tm, 0.0);
    let local = match site {
        Some(site) => Some(local(provider, planet, s.sun_r_au, site, (t1, t4))?),
        None => None,
    };
    Ok(Transit {
        id: format!("{date}-{}", planet.name().to_lowercase()),
        planet: planet.name().to_string(),
        contacts,
        min_separation_arcsec: g.separation,
        sun_semidiameter_arcsec: g.sd_sun,
        planet_semidiameter_arcsec: g.sd_planet,
        grazing: c[1].is_none() || c[2].is_none(),
        duration_s: (t4 - t1) * 86_400.0,
        path: path(s, t1, t4),
        tt_minus_utc_s: (jd_tt(tm) - tm) * 86_400.0,
        local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn meeus_predictions_land_near_real_inferior_conjunctions() {
        // Meeus example 36.a: the inferior conjunction of Mercury nearest 1993.75 is at
        // JDE 2449297.645 (1993 November 6.1).
        let k = ((1993.75 * 365.2425 + 1_721_060.0 - MERCURY.a) / MERCURY.b + 0.5).floor();
        assert!(
            (MERCURY.jde(k) - 2_449_297.645).abs() < 0.001,
            "{}",
            MERCURY.jde(k)
        );
    }

    #[test]
    fn the_transits_of_2016_to_2019() {
        let p = PlanetProvider::new();
        let list = transits(&p, civil_to_jd(2016, 1, 1), civil_to_jd(2020, 1, 1), None).unwrap();
        let ids: Vec<&str> = list.transits.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["2016-05-09-mercury", "2019-11-11-mercury"]);
        let t = &list.transits[1];
        let kinds: Vec<&str> = t.contacts.iter().map(|c| c.kind.as_str()).collect();
        assert_eq!(kinds, ["c1", "c2", "greatest", "c3", "c4"]);
        // 2019: a near-central transit, least separation 76".
        assert!((t.min_separation_arcsec - 75.9).abs() < 1.0, "{t:?}");
        assert!(!t.grazing && t.path.len() == PATH_POINTS);
    }
}
