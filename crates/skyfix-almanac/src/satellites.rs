//! Jupiter's Galilean moons: where Io, Europa, Ganymede and Callisto stand beside the
//! planet, and when they transit its disc, cast their shadows on it, pass behind it or
//! enter its shadow.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.10; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail".
//!
//! # Model
//!
//! - **The moons**: Lieske's E5 theory as Meeus gives it (chapter 44, the "higher
//!   accuracy" method; [`e5`]): the moons relative to Jupiter's centre in the mean
//!   ecliptic and equinox of date, rotated to the ICRS with the IAU 2006 precession.
//! - **Jupiter** and **the Earth**: heliocentric VSOP87A from the planet provider
//!   ([`skyfix_ephemeris::planets::heliocentric_position_au`]). VSOP87 gives Jupiter's
//!   system barycentre; the planet's centre is moved from it by the moons' mass-weighted
//!   offsets (up to about 200 km).
//! - **Seen from the Earth**: the moon's position is taken at its own light-time
//!   instant (Jupiter's plus `depth / c`, up to 6 s for Callisto), both directions get
//!   the Earth's annual aberration, and the moon's offset from Jupiter's centre is
//!   expressed on the sky. `x` runs along Jupiter's equator, positive west, and `y` along
//!   the projection of Jupiter's IAU north pole, both in units of Jupiter's apparent
//!   equatorial radius (71,492 km); `z` is the moon's depth along the line of sight in
//!   the same unit, positive when it is farther than Jupiter's centre.
//! - **Jupiter's disc** is the ellipse of semi-axes `a = asin(71 492 km / distance)` and
//!   `a sqrt(1 - e^2 cos^2 D)` (polar radius 66,854 km, `D` the planetocentric latitude
//!   of the viewer). A moon **transits** while its centre is inside the disc and in
//!   front of Jupiter, is **occulted** while inside and behind.
//! - **Shadows** come from the Sun's centre (a point source: the shadow edge is the
//!   middle of the penumbra, about a minute wide for Io and several for Callisto). A
//!   moon is **eclipsed** while the ray from the Sun to it (taken at its own light-time
//!   instant) passes inside Jupiter's disc as seen from the Sun, Jupiter taken when the
//!   ray passed it; its **shadow is on the disc** while the ray from the Sun past the
//!   moon (taken when the ray passed it) meets Jupiter's disc, at Jupiter's light-time
//!   instant. The shadow's position on the disc is the ray's intersection with the
//!   ellipsoid.
//! - **Times** are when the Earth sees the event. The rotation's other effects are
//!   ignored: Jupiter's atmosphere widens the effective shadow slightly and the moons
//!   fade over a minute or more.
//!
//! Validated against Skyfield with JPL's `jup365` satellite ephemeris on DE440
//! (`tests/planetdetail_galilean.rs`); the measured accuracy is in `docs/ACCURACY.md`.

mod e5;

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, jd_tt};
use skyfix_ephemeris::frames::apply_annual_aberration;
use skyfix_ephemeris::planets::{Planet, heliocentric_position_au};

use crate::eclipses::cheb::{minimise, root};
use crate::planet_geometry::{
    C_AU_PER_DAY, Mat3, RAD_TO_ARCSEC, Vec3, VecFit, add, dot, icrs_to_ecliptic_of_date,
    icrs_to_true_of_date, jd_utc_from_tt, mat_t_vec, mat_vec, norm, orientation, radec_of, scale,
    sub, sun_planet_coverage, tangent_plane, unavailable, unit,
};
use crate::sky::AlmanacError;

/// The four moons, in order from Jupiter.
pub const MOONS: [&str; 4] = ["Io", "Europa", "Ganymede", "Callisto"];
/// Their sidereal periods, days (for the event search's step).
const PERIODS_DAYS: [f64; 4] = [1.769_137_786, 3.551_181_041, 7.154_553_096, 16.689_017_0];
/// GM of each moon and of the whole Jupiter system, km^3/s^2 (JPL jup365 / DE440).
const GM_MOONS: [f64; 4] = [5_959.915_466, 3_202.712_100, 9_887.832_753, 7_179.283_403];
const GM_SYSTEM: f64 = 126_712_764.1;
/// Jupiter's radii, km (IAU 2015).
const R_EQ_KM: f64 = 71_492.0;
const R_POL_KM: f64 = 66_854.0;
const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;
/// Accuracy of the moons' offsets from Jupiter, arcseconds, measured against jup365
/// (docs/ACCURACY.md, "Planet detail"): the worst case, rounded up.
pub const ACCURACY_ARCSEC: f64 = 0.5;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Jupiter as the moons' diagram needs it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JupiterFrame {
    pub distance_au: f64,
    pub light_time_s: f64,
    /// Apparent equatorial and polar radii of the disc, arcseconds.
    pub equatorial_radius_arcsec: f64,
    pub polar_radius_arcsec: f64,
    /// Position angle of Jupiter's north pole, north through east, degrees.
    pub pole_position_angle_deg: f64,
    /// Planetocentric latitude of the Earth seen from Jupiter, degrees.
    pub sub_earth_lat_deg: f64,
    /// Apparent geocentric right ascension and declination of Jupiter's centre, degrees.
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// Angle between Jupiter and the Sun seen from the Earth, degrees.
    pub elongation_deg: f64,
}

/// One moon at one instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalileanMoon {
    pub name: String,
    /// Along Jupiter's equator, positive west, in Jupiter's apparent equatorial radii.
    pub x_rj: f64,
    /// Toward Jupiter's projected north pole, same unit.
    pub y_rj: f64,
    /// Depth along the line of sight, same unit; positive = farther than Jupiter.
    pub z_rj: f64,
    /// Offset from Jupiter's centre on the sky (true equator of date), arcseconds.
    pub offset_east_arcsec: f64,
    pub offset_north_arcsec: f64,
    /// Apparent geocentric right ascension and declination, degrees.
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// Nearer the Earth than Jupiter's centre.
    pub in_front: bool,
    /// In front of Jupiter's disc.
    pub in_transit: bool,
    /// Behind Jupiter's disc.
    pub occulted: bool,
    /// In Jupiter's shadow.
    pub eclipsed: bool,
    /// Its shadow falls on Jupiter.
    pub shadow_on_disc: bool,
    /// Where that shadow is on the disc (same axes and unit as `x_rj`, `y_rj`).
    pub shadow_x_rj: Option<f64>,
    pub shadow_y_rj: Option<f64>,
}

/// `galilean_moons` result (EXPLORER_API.md `GalileanMoons`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalileanMoons {
    pub jd_utc: f64,
    pub utc: String,
    pub jupiter: JupiterFrame,
    pub moons: Vec<GalileanMoon>,
    pub theory: String,
    /// Accuracy of the moons' offsets from Jupiter, arcseconds (measured, worst case).
    pub accuracy_arcsec: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhenomenonKind {
    /// The moon crosses Jupiter's disc.
    Transit,
    /// Its shadow crosses the disc.
    ShadowTransit,
    /// The moon is hidden behind Jupiter.
    Occultation,
    /// The moon is in Jupiter's shadow.
    Eclipse,
}

/// The start or end of a phenomenon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhenomenonInstant {
    pub jd_utc: f64,
    pub utc: String,
    /// Whether the Earth can see this moment happen: an eclipse's start or end is hidden
    /// while the moon is behind Jupiter, an occultation's while the moon is eclipsed.
    pub observable: bool,
}

/// One transit, shadow transit, occultation or eclipse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalileanPhenomenon {
    pub moon: String,
    pub kind: PhenomenonKind,
    pub start: PhenomenonInstant,
    pub end: PhenomenonInstant,
    /// Jupiter's angle from the Sun at the start, degrees (nothing is visible within
    /// about 15 degrees of the Sun).
    pub jupiter_elongation_deg: f64,
}

/// `galilean_events` result (EXPLORER_API.md `GalileanEvents`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalileanEvents {
    pub jd_start: f64,
    pub jd_end: f64,
    pub truncated: bool,
    /// Every phenomenon overlapping the window, sorted by start.
    pub phenomena: Vec<GalileanPhenomenon>,
    pub conventions: String,
}

// ---------------------------------------------------------------------------
// Ephemeris of the Earth and Jupiter's barycentre, exact or interpolated
// ---------------------------------------------------------------------------

enum Helio {
    Exact,
    Fitted { earth: VecFit, jupiter: VecFit },
}

impl Helio {
    fn fitted(jd_tt_lo: f64, jd_tt_hi: f64) -> Result<Helio, AlmanacError> {
        let earth = VecFit::new(
            |t| heliocentric_position_au("Earth", t).map_err(|e| unavailable("Earth", e)),
            jd_tt_lo,
            jd_tt_hi,
            4.0,
            14,
        )?;
        let jupiter = VecFit::new(
            |t| heliocentric_position_au("Jupiter", t).map_err(|e| unavailable("Jupiter", e)),
            jd_tt_lo,
            jd_tt_hi,
            16.0,
            12,
        )?;
        Ok(Helio::Fitted { earth, jupiter })
    }

    fn earth(&self, t: f64) -> Result<(Vec3, Vec3), AlmanacError> {
        match self {
            Helio::Exact => {
                let p =
                    heliocentric_position_au("Earth", t).map_err(|e| unavailable("Earth", e))?;
                let h = 0.01;
                let a = heliocentric_position_au("Earth", t + h)
                    .map_err(|e| unavailable("Earth", e))?;
                let b = heliocentric_position_au("Earth", t - h)
                    .map_err(|e| unavailable("Earth", e))?;
                Ok((p, scale(sub(a, b), 0.5 / h)))
            }
            Helio::Fitted { earth, .. } => Ok((earth.eval(t), earth.rate(t))),
        }
    }

    fn jupiter(&self, t: f64) -> Result<(Vec3, Vec3), AlmanacError> {
        match self {
            Helio::Exact => {
                let f = |t| {
                    heliocentric_position_au("Jupiter", t).map_err(|e| unavailable("Jupiter", e))
                };
                let p = f(t)?;
                let h = 0.05;
                Ok((p, scale(sub(f(t + h)?, f(t - h)?), 0.5 / h)))
            }
            Helio::Fitted { jupiter, .. } => Ok((jupiter.eval(t), jupiter.rate(t))),
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry at one instant
// ---------------------------------------------------------------------------

/// A view of the system from one place: where each moon (or its shadow ray) projects
/// on Jupiter's disc.
#[derive(Debug, Clone, Copy, Default)]
struct Projection {
    /// Along the equator (west positive) and toward the pole, radians on the sky.
    x: f64,
    y: f64,
    /// Semi-axes of the disc, radians.
    a: f64,
    b: f64,
    /// Positive: farther from the viewer than Jupiter's centre, km.
    depth_km: f64,
}

impl Projection {
    /// `(x/a)^2 + (y/b)^2 - 1`: negative inside the disc.
    fn margin(&self) -> f64 {
        (self.x / self.a).powi(2) + (self.y / self.b).powi(2) - 1.0
    }

    fn inside(&self) -> bool {
        self.margin() < 0.0
    }
}

/// Project the direction `target` about the direction of Jupiter's centre `centre`
/// (both seen from the viewer, in the same frame; any lengths), Jupiter being `dist_km`
/// away, with its pole `pole` in that frame. `depth_km` is left 0 for the caller.
fn project(centre: Vec3, dist_km: f64, target: Vec3, pole: Vec3, e2: f64) -> Projection {
    let (xi, eta) = tangent_plane(centre, target);
    let pa = crate::planet_geometry::axis_position_angle_deg(centre, pole).to_radians();
    let (sp, cp) = pa.sin_cos();
    let a = (R_EQ_KM / dist_km).asin();
    let lat = (-dot(unit(centre), pole)).clamp(-1.0, 1.0).asin();
    Projection {
        x: -xi * cp + eta * sp,
        y: xi * sp + eta * cp,
        a,
        b: a * (1.0 - e2 * lat.cos().powi(2)).sqrt(),
        depth_km: 0.0,
    }
}

/// The depth of `target` beyond `centre` along the line of sight to `centre`, km (both
/// vectors from the viewer, km).
fn depth_beyond(centre: Vec3, target: Vec3) -> f64 {
    dot(sub(target, centre), unit(centre))
}

/// Everything about the system at one Earth instant.
struct SystemState {
    jd_tt: f64,
    tau_days: f64,
    /// Jupiter's centre relative to the Earth, astrometric, ICRS, km.
    centre_astrometric: Vec3,
    /// The Earth's heliocentric velocity over c.
    earth_vel_c: Vec3,
    pole: Vec3,
    /// Each moon relative to the Earth, astrometric, ICRS, km (at its light-time instant).
    moon_astrometric: [Vec3; 4],
    earth: [Projection; 4],
    eclipse: [Projection; 4],
    shadow: [Projection; 4],
    /// Shadow rays: a point on each (the moon, heliocentric km) and its direction.
    shadow_ray: [(Vec3, Vec3); 4],
    centre_helio_km: Vec3,
}

struct Moons {
    at: f64,
    s: [Vec3; 4],
    v: [Vec3; 4],
}

impl Moons {
    /// The four moons relative to Jupiter's centre (ICRS, km) at `jd_theory`, with
    /// velocities (km/day) to move each to a nearby instant.
    fn new(jd_theory: f64, jd_frame: f64) -> Moons {
        let m = icrs_to_ecliptic_of_date(jd_frame);
        let icrs = |p: e5::E5Positions| -> [Vec3; 4] {
            p.moons.map(|v| mat_t_vec(&m, scale(v, e5::E5_UNIT_KM)))
        };
        let h = 60.0 / 86_400.0;
        let s = icrs(e5::positions(jd_theory, jd_frame));
        let s2 = icrs(e5::positions(jd_theory + h, jd_frame));
        let v = std::array::from_fn(|k| scale(sub(s2[k], s[k]), 1.0 / h));
        Moons {
            at: jd_theory,
            s,
            v,
        }
    }

    fn at(&self, k: usize, jd: f64) -> Vec3 {
        add(self.s[k], scale(self.v[k], jd - self.at))
    }

    /// Jupiter's centre relative to the system barycentre, km.
    fn centre_offset(&self, jd: f64) -> Vec3 {
        GM_MOONS.iter().enumerate().fold([0.0; 3], |c, (k, gm)| {
            add(c, scale(self.at(k, jd), -gm / GM_SYSTEM))
        })
    }
}

fn state(helio: &Helio, jd_utc: f64) -> Result<SystemState, AlmanacError> {
    let t = jd_tt(jd_utc);
    let (earth, earth_vel) = helio.earth(t)?;
    let earth_km = scale(earth, AU_KM);
    // Light-time to Jupiter's barycentre (the centre is within 200 km of it: 0.7 ms).
    let mut tau = 0.0;
    let mut jup = helio.jupiter(t)?;
    for _ in 0..3 {
        tau = norm(sub(jup.0, earth)) / C_AU_PER_DAY;
        jup = helio.jupiter(t - tau)?;
    }
    let t_j = t - tau;
    let moons = Moons::new(t_j, t);
    let centre_helio_km = add(scale(jup.0, AU_KM), moons.centre_offset(t_j));
    let jup_vel_km = scale(jup.1, AU_KM);
    let centre_astrometric = sub(centre_helio_km, earth_km);
    let u = unit(centre_astrometric);
    let pole = orientation(Planet::Jupiter, t_j).pole;
    let earth_vel_c = scale(earth_vel, 1.0 / C_AU_PER_DAY);
    let e2 = 1.0 - (R_POL_KM / R_EQ_KM).powi(2);
    let c_km_day = crate::planet_geometry::C_KM_S * 86_400.0;
    let apparent = |v: Vec3| apply_annual_aberration(unit(v), earth_vel_c);
    let centre_app = apparent(centre_astrometric);

    let mut out = SystemState {
        jd_tt: t,
        tau_days: tau,
        centre_astrometric,
        earth_vel_c,
        pole,
        moon_astrometric: [[0.0; 3]; 4],
        earth: [Projection::default(); 4],
        eclipse: [Projection::default(); 4],
        shadow: [Projection::default(); 4],
        shadow_ray: [([0.0; 3], [0.0; 3]); 4],
        centre_helio_km,
    };
    for k in 0..4 {
        // Seen from the Earth, at the moon's own light-time instant.
        let depth = dot(moons.at(k, t_j), u);
        let t_m = t_j - depth / c_km_day;
        // Barycentre, then Jupiter's centre about it, then the moon about the centre.
        let moon_helio = add(
            add(scale(jup.0, AU_KM), scale(jup_vel_km, t_m - t_j)),
            add(moons.centre_offset(t_m), moons.at(k, t_m)),
        );
        let moon_astro = sub(moon_helio, earth_km);
        out.moon_astrometric[k] = moon_astro;
        let mut p = project(
            centre_app,
            norm(centre_astrometric),
            apparent(moon_astro),
            pole,
            e2,
        );
        p.depth_km = depth_beyond(centre_astrometric, moon_astro);
        out.earth[k] = p;

        // Eclipse: the Sun's ray reaches the moon at t_m; Jupiter's centre when the ray
        // passed it, delta earlier.
        let jhat = unit(centre_helio_km);
        let delta = dot(sub(moon_helio, centre_helio_km), jhat) / c_km_day;
        let centre_then = sub(centre_helio_km, scale(jup_vel_km, delta + (t_j - t_m)));
        let mut p = project(centre_then, norm(centre_then), moon_helio, pole, e2);
        p.depth_km = depth_beyond(centre_then, moon_helio);
        out.eclipse[k] = p;

        // Shadow: the ray reaches Jupiter at t_j; the moon when it passed, delta earlier.
        let s_now = moons.at(k, t_j);
        let delta = -dot(s_now, jhat) / c_km_day;
        let t_p = t_j - delta;
        let moon_then = add(
            sub(centre_helio_km, scale(jup_vel_km, delta)),
            moons.at(k, t_p),
        );
        let mut p = project(centre_helio_km, norm(centre_helio_km), moon_then, pole, e2);
        p.depth_km = depth_beyond(centre_helio_km, moon_then);
        out.shadow[k] = p;
        out.shadow_ray[k] = (moon_then, unit(moon_then));
    }
    Ok(out)
}

/// Where the ray `point + s * dir` first meets Jupiter's ellipsoid (centre `centre`,
/// pole `pole`), if it does.
fn ray_hits_jupiter(point: Vec3, dir: Vec3, centre: Vec3, pole: Vec3) -> Option<Vec3> {
    // Scale the polar axis to make the ellipsoid a sphere of radius R_EQ.
    let k = R_EQ_KM / R_POL_KM;
    let stretch = |v: Vec3| add(v, scale(pole, (k - 1.0) * dot(v, pole)));
    let o = stretch(sub(point, centre));
    let d = stretch(dir);
    let (a, b, c) = (dot(d, d), 2.0 * dot(o, d), dot(o, o) - R_EQ_KM * R_EQ_KM);
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return None;
    }
    let s = (-b - disc.sqrt()) / (2.0 * a);
    (s > 0.0).then(|| add(point, scale(dir, s)))
}

// ---------------------------------------------------------------------------
// Positions at an instant
// ---------------------------------------------------------------------------

/// The four moons at `jd_utc`.
pub fn galilean_moons(jd_utc: f64) -> Result<GalileanMoons, AlmanacError> {
    let (lo, hi) = sun_planet_coverage();
    if !jd_utc.is_finite() || jd_utc < lo || jd_utc > hi {
        return Err(AlmanacError::Unavailable {
            body: "Jupiter".to_string(),
            message: format!(
                "the Galilean moons are computed where the Sun and planet providers answer \
                 ({} .. {}); jd_utc {jd_utc} is outside",
                format_utc(lo),
                format_utc(hi)
            ),
        });
    }
    let st = state(&Helio::Exact, jd_utc)?;
    let bpn: Mat3 = icrs_to_true_of_date(st.jd_tt);
    let apparent_date = |v: Vec3| mat_vec(&bpn, apply_annual_aberration(unit(v), st.earth_vel_c));
    let centre_date = apparent_date(st.centre_astrometric);
    let pole_date = mat_vec(&bpn, st.pole);
    let e2 = 1.0 - (R_POL_KM / R_EQ_KM).powi(2);
    let dist_km = norm(st.centre_astrometric);
    let frame = project(centre_date, dist_km, centre_date, pole_date, e2);
    let (ra, dec) = radec_of(centre_date);
    let sun_dir = mat_vec(
        &bpn,
        apply_annual_aberration(
            unit(scale(sub(st.centre_helio_km, st.centre_astrometric), -1.0)),
            st.earth_vel_c,
        ),
    );
    let rj = frame.a;
    let mut moons = Vec::with_capacity(4);
    for (k, name) in MOONS.iter().enumerate() {
        let md = apparent_date(st.moon_astrometric[k]);
        let p = project(centre_date, dist_km, md, pole_date, e2);
        let (east, north) = tangent_plane(centre_date, md);
        let (mra, mdec) = radec_of(md);
        let e = &st.earth[k];
        let transit = e.inside() && e.depth_km < 0.0;
        let occulted = e.inside() && e.depth_km > 0.0;
        let eclipsed = st.eclipse[k].inside() && st.eclipse[k].depth_km > 0.0;
        let shadow_on = st.shadow[k].inside() && st.shadow[k].depth_km < 0.0;
        let shadow = if shadow_on {
            let (point, dir) = st.shadow_ray[k];
            ray_hits_jupiter(point, dir, st.centre_helio_km, st.pole).map(|hit| {
                let earth_helio = sub(st.centre_helio_km, st.centre_astrometric);
                let sp = project(
                    centre_date,
                    dist_km,
                    apparent_date(sub(hit, earth_helio)),
                    pole_date,
                    e2,
                );
                (sp.x / rj, sp.y / rj)
            })
        } else {
            None
        };
        moons.push(GalileanMoon {
            name: name.to_string(),
            x_rj: p.x / rj,
            y_rj: p.y / rj,
            z_rj: e.depth_km / R_EQ_KM,
            offset_east_arcsec: east * RAD_TO_ARCSEC,
            offset_north_arcsec: north * RAD_TO_ARCSEC,
            ra_deg: mra,
            dec_deg: mdec,
            in_front: e.depth_km < 0.0,
            in_transit: transit,
            occulted,
            eclipsed,
            shadow_on_disc: shadow_on,
            shadow_x_rj: shadow.map(|s| s.0),
            shadow_y_rj: shadow.map(|s| s.1),
        });
    }
    Ok(GalileanMoons {
        jd_utc,
        utc: format_utc(jd_utc),
        jupiter: JupiterFrame {
            distance_au: dist_km / AU_KM,
            light_time_s: st.tau_days * 86_400.0,
            equatorial_radius_arcsec: frame.a * RAD_TO_ARCSEC,
            polar_radius_arcsec: frame.b * RAD_TO_ARCSEC,
            pole_position_angle_deg: crate::planet_geometry::axis_position_angle_deg(
                centre_date,
                pole_date,
            ),
            sub_earth_lat_deg: (-dot(unit(st.centre_astrometric), st.pole))
                .asin()
                .to_degrees(),
            ra_deg: ra,
            dec_deg: dec,
            elongation_deg: crate::planet_geometry::angle(centre_date, sun_dir).to_degrees(),
        },
        moons,
        theory: "Lieske E5 (Meeus, Astronomical Algorithms, chapter 44, higher accuracy), \
                 Jupiter and the Earth from VSOP87A"
            .to_string(),
        accuracy_arcsec: ACCURACY_ARCSEC,
    })
}

// ---------------------------------------------------------------------------
// Phenomena in a window
// ---------------------------------------------------------------------------

/// Longest window `galilean_events` accepts, days.
pub const MAX_EVENT_WINDOW_DAYS: f64 = 400.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Earth,
    Eclipse,
    Shadow,
}

fn view_of(st: &SystemState, v: View, k: usize) -> Projection {
    match v {
        View::Earth => st.earth[k],
        View::Eclipse => st.eclipse[k],
        View::Shadow => st.shadow[k],
    }
}

/// Every transit, shadow transit, occultation and eclipse of the four moons that
/// overlaps `[jd_start, jd_end]` (UTC Julian dates).
pub fn galilean_events(jd_start: f64, jd_end: f64) -> Result<GalileanEvents, AlmanacError> {
    let (lo, hi) = sun_planet_coverage();
    let (a, b, truncated) = crate::planet_geometry::clip_window(
        "galilean_events",
        jd_start,
        jd_end,
        lo,
        hi,
        MAX_EVENT_WINDOW_DAYS,
    )?;
    let mut phenomena = Vec::new();
    if a < b {
        // Search a little beyond the window so phenomena in progress at its edges are
        // found whole (Callisto's longest lasts under 5 hours), inside the coverage.
        let pad = 0.3;
        let (sa, sb) = ((a - pad).max(lo), (b + pad).min(hi));
        let helio = Helio::fitted(jd_tt(sa) - 0.1, jd_tt(sb) + 0.1)?;
        let failure = std::cell::RefCell::new(None::<AlmanacError>);
        let eval = |jd: f64| -> Option<SystemState> {
            match state(&helio, jd) {
                Ok(s) => Some(s),
                Err(e) => {
                    failure.borrow_mut().get_or_insert(e);
                    None
                }
            }
        };
        // One grid for all four moons at Io's pace, 16 samples per orbit.
        let step = PERIODS_DAYS[0] / 16.0;
        let n = ((sb - sa) / step).ceil().max(1.0) as usize;
        let h = (sb - sa) / n as f64;
        let grid: Vec<(f64, SystemState)> = (0..=n)
            .filter_map(|i| {
                let t = sa + h * i as f64;
                eval(t).map(|s| (t, s))
            })
            .collect();
        if let Some(e) = failure.borrow_mut().take() {
            return Err(e);
        }
        for (k, name) in MOONS.iter().enumerate() {
            for view in [View::Earth, View::Eclipse, View::Shadow] {
                for w in grid.windows(2) {
                    let (t0, s0) = (&w[0].0, &w[0].1);
                    let (t1, s1) = (&w[1].0, &w[1].1);
                    let (x0, x1) = (view_of(s0, view, k).x, view_of(s1, view, k).x);
                    if x0 * x1 > 0.0 || (x0 == 0.0 && x1 == 0.0) {
                        continue;
                    }
                    // Only the conjunction whose depth suits the view.
                    let dep = view_of(s0, view, k).depth_km + view_of(s1, view, k).depth_km;
                    if view == View::Eclipse && dep < 0.0 || view == View::Shadow && dep > 0.0 {
                        continue;
                    }
                    let x_at = |t: f64| eval(t).map_or(f64::NAN, |s| view_of(&s, view, k).x);
                    let Some(tc) = root(x_at, *t0, *t1, 1e-6) else {
                        continue;
                    };
                    let margin =
                        |t: f64| eval(t).map_or(f64::NAN, |s| view_of(&s, view, k).margin());
                    let hw = 1.5 / 24.0;
                    let (tm, fm) = minimise(margin, tc - hw, tc + hw, 1e-6);
                    if fm.is_nan() || fm >= 0.0 {
                        continue;
                    }
                    let quarter = PERIODS_DAYS[k] / 4.0;
                    let t_in = root(margin, tm - quarter, tm, 1e-7);
                    let t_out = root(margin, tm, tm + quarter, 1e-7);
                    let (Some(t_in), Some(t_out)) = (t_in, t_out) else {
                        continue;
                    };
                    if t_out < a || t_in > b {
                        continue;
                    }
                    let Some(mid) = eval(tm) else { continue };
                    let kind = match view {
                        View::Earth if mid.earth[k].depth_km < 0.0 => PhenomenonKind::Transit,
                        View::Earth => PhenomenonKind::Occultation,
                        View::Eclipse => PhenomenonKind::Eclipse,
                        View::Shadow => PhenomenonKind::ShadowTransit,
                    };
                    let instant = |t: f64| -> PhenomenonInstant {
                        let observable = match (kind, eval(t)) {
                            (PhenomenonKind::Eclipse, Some(s)) => {
                                !(s.earth[k].inside() && s.earth[k].depth_km > 0.0)
                            }
                            (PhenomenonKind::Occultation, Some(s)) => {
                                !(s.eclipse[k].inside() && s.eclipse[k].depth_km > 0.0)
                            }
                            _ => true,
                        };
                        PhenomenonInstant {
                            jd_utc: t,
                            utc: format_utc(t),
                            observable,
                        }
                    };
                    let st0 = eval(t_in);
                    let elong = st0.map_or(f64::NAN, |s| {
                        let sun = scale(sub(s.centre_helio_km, s.centre_astrometric), -1.0);
                        crate::planet_geometry::angle(s.centre_astrometric, sun).to_degrees()
                    });
                    phenomena.push(GalileanPhenomenon {
                        moon: name.to_string(),
                        kind,
                        start: instant(t_in),
                        end: instant(t_out),
                        jupiter_elongation_deg: elong,
                    });
                }
            }
        }
        if let Some(e) = failure.borrow_mut().take() {
            return Err(e);
        }
    }
    phenomena.sort_by(|x, y| x.start.jd_utc.total_cmp(&y.start.jd_utc));
    Ok(GalileanEvents {
        jd_start: a,
        jd_end: b,
        truncated,
        phenomena,
        conventions: "Times when the Earth sees them (UTC). Transits and occultations: the \
                      moon's centre crossing the limb of Jupiter's oblate disc. Eclipses and \
                      shadow transits: the shadow of Jupiter or of the moon cast by the Sun's \
                      centre (the middle of the penumbra; the fading lasts from about a \
                      minute for Io to several for Callisto). Moons by Lieske's E5 theory \
                      (Meeus chapter 44)."
            .to_string(),
    })
}

#[doc(hidden)]
pub fn _jd_utc_from_tt(jd_tt: f64) -> f64 {
    jd_utc_from_tt(jd_tt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn meeus_example_44b() {
        // Meeus, Astronomical Algorithms, example 44.b: 1992 December 16 at 0h UT (JDE
        // 2448972.50068). His X and Y are in E5's Jupiter radius (71,398 km) and along
        // E5's own pole; ours in 71,492 km along the IAU pole, and our Jupiter and Earth
        // come from VSOP87A rather than his VSOP87D.
        let jd = jd_utc_from_tt(2_448_972.500_68);
        let m = galilean_moons(jd).unwrap();
        let meeus = [
            (-3.4503, 0.2137),
            (7.4418, 0.2752),
            (1.2010, 0.5900),
            (7.0720, 1.0290),
        ];
        let unit_ratio = R_EQ_KM / e5::E5_UNIT_KM;
        for (moon, (x, y)) in m.moons.iter().zip(meeus) {
            let (mx, my) = (moon.x_rj * unit_ratio, moon.y_rj * unit_ratio);
            assert!((mx - x).abs() < 0.002, "{moon:?} vs {x}");
            assert!((my - y).abs() < 0.002, "{moon:?} vs {y}");
        }
    }

    #[test]
    fn four_moons_near_jupiter() {
        let m = galilean_moons(civil_to_jd(2026, 1, 10) + 8.0 / 24.0).unwrap();
        assert_eq!(m.moons.len(), 4);
        for (k, moon) in m.moons.iter().enumerate() {
            let r = (moon.x_rj.powi(2) + moon.y_rj.powi(2) + moon.z_rj.powi(2)).sqrt();
            let mean = [5.9, 9.4, 15.0, 26.4][k];
            assert!((r / mean - 1.0).abs() < 0.03, "{moon:?}");
            assert!(moon.y_rj.abs() < 1.5, "{moon:?}");
        }
        assert!(
            (m.jupiter.equatorial_radius_arcsec - 23.3).abs() < 0.3,
            "{m:?}"
        );
    }
}
