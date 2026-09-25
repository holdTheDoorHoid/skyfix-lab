//! Where a fixed object is seen from a place, and the night the deep-sky calls share.
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6).
//!
//! - [`Frame`]: the apparent place of date of an ICRS catalogue direction (a deep-sky
//!   object, a meteor radiant, the galactic centre, or a star with its proper motion and
//!   parallax), by exactly the steps of `skyfix_ephemeris::frames::apparent_radec_of_date`
//!   (proper motion, frame bias + precession + nutation, annual parallax, solar light
//!   deflection, annual aberration) with the per-instant quantities computed once. The
//!   Greenwich hour angle is `GAST - RA` with DUT1 = 0, as for the navigational stars.
//! - [`SiteFrame`]: topocentric altitude and azimuth of such a direction from a WGS84
//!   site, the arithmetic of `skyfix_ephemeris::topocentric::horizontal` for a body
//!   without distance, with the site's axes computed once.
//! - [`Night`]: the 24 hours from local mean noon to local mean noon, the Sun's and the
//!   Moon's events in it (from `skyfix_almanac::events`, CONVENTIONS 13.3), its darkness
//!   window and the Moon's track through it.
//!
//! `tests/observe_matches_sky_state.rs` holds every one of the 58 navigational stars,
//! pushed through [`Frame`] and [`SiteFrame`], to `sky_state`'s altitude and azimuth.

use serde::Serialize;
use skyfix_almanac::events::{
    self, DayEvents, EventKind, EventOptions, SkyEvent, SkyPhase, ecliptic_longitude_deg,
};
use skyfix_almanac::sky::sample_bodies;
use skyfix_core::time::{JD_J2000, format_utc, jd_tt};
use skyfix_core::units::norm_360;
use skyfix_ephemeris::body::{BodyEphemeris, MOON, SUN, Sky};
use skyfix_ephemeris::frames::{
    EarthState, apply_annual_aberration, apply_annual_parallax, apply_solar_light_deflection,
    bias_precession_nutation_matrix, earth_state_of_date, proper_motion_from_j2000,
    radec_from_vector, true_obliquity_rad, unit_vector_from_radec,
};
use skyfix_ephemeris::sidereal::gha_aries_deg;
use skyfix_ephemeris::topocentric::{Site, horizontal, refraction_true_to_apparent_arcmin};

use crate::{StarfieldError, check_jd_utc};

type Mat3 = [[f64; 3]; 3];

fn apply(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn apply_t(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

/// Angle between two directions given as RA/Dec, degrees.
pub fn separation_deg(ra1: f64, dec1: f64, ra2: f64, dec2: f64) -> f64 {
    let u = unit_vector_from_radec(ra1, dec1);
    let v = unit_vector_from_radec(ra2, dec2);
    let c = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let s = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
    s.atan2(u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
        .to_degrees()
}

/// Everything an apparent place needs that depends only on the instant.
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub jd_utc: f64,
    jd_tt: f64,
    bpn: Mat3,
    earth: EarthState,
    /// GAST with DUT1 = 0, degrees.
    pub gha_aries_deg: f64,
}

impl Frame {
    /// The frame at `jd_utc`, inside the star field's range (1800-2200).
    pub fn at(jd_utc: f64) -> Result<Frame, StarfieldError> {
        check_jd_utc(jd_utc)?;
        let t = jd_tt(jd_utc);
        Ok(Frame {
            jd_utc,
            jd_tt: t,
            bpn: bias_precession_nutation_matrix(t),
            earth: earth_state_of_date(t),
            gha_aries_deg: gha_aries_deg(jd_utc, 0.0),
        })
    }

    /// Apparent RA `[0, 360)` and Dec of date, degrees, of an ICRS direction at epoch
    /// J2000.0 with no proper motion and no parallax.
    pub fn apparent(&self, ra_j2000_deg: f64, dec_j2000_deg: f64) -> (f64, f64) {
        self.apparent_star(ra_j2000_deg, dec_j2000_deg, 0.0, 0.0, 0.0)
    }

    /// The same for a catalogue star, with its proper motion (mas/yr, `mu_alpha cos
    /// delta`) and parallax (mas): the chain and the order of
    /// `frames::apparent_radec_of_date`.
    pub fn apparent_star(
        &self,
        ra_j2000_deg: f64,
        dec_j2000_deg: f64,
        pm_ra_cosdec_mas_yr: f64,
        pm_dec_mas_yr: f64,
        parallax_mas: f64,
    ) -> (f64, f64) {
        let p = if pm_ra_cosdec_mas_yr == 0.0 && pm_dec_mas_yr == 0.0 {
            unit_vector_from_radec(ra_j2000_deg, dec_j2000_deg)
        } else {
            proper_motion_from_j2000(
                ra_j2000_deg,
                dec_j2000_deg,
                pm_ra_cosdec_mas_yr,
                pm_dec_mas_yr,
                self.jd_tt,
            )
        };
        let p = apply(&self.bpn, p);
        let p = apply_annual_parallax(p, parallax_mas, self.earth.pos_au);
        let p = apply_solar_light_deflection(p, self.earth.pos_au);
        let p = apply_annual_aberration(p, self.earth.vel_c);
        radec_from_vector(p)
    }

    /// The rotation part only (bias, precession, nutation): an ICRS direction in the
    /// true equator and equinox of date, for label positions and radiants.
    pub fn rotate(&self, ra_j2000_deg: f64, dec_j2000_deg: f64) -> (f64, f64) {
        radec_from_vector(apply(
            &self.bpn,
            unit_vector_from_radec(ra_j2000_deg, dec_j2000_deg),
        ))
    }

    /// The inverse rotation: a direction of date back to ICRS.
    pub fn unrotate(&self, ra_deg: f64, dec_deg: f64) -> (f64, f64) {
        radec_from_vector(apply_t(&self.bpn, unit_vector_from_radec(ra_deg, dec_deg)))
    }

    /// Greenwich hour angle of an apparent RA at this instant, `[0, 360)`.
    pub fn gha_deg(&self, ra_deg: f64) -> f64 {
        norm_360(self.gha_aries_deg - ra_deg)
    }

    pub fn jd_tt(&self) -> f64 {
        self.jd_tt
    }
}

/// A point on the sky seen from the site.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Horizon {
    /// Topocentric geometric altitude (CONVENTIONS 13.2).
    pub alt_deg: f64,
    pub az_deg: f64,
    /// `alt_deg` plus display refraction.
    pub alt_apparent_deg: f64,
}

/// A site with its local axes computed once.
#[derive(Debug, Clone, Copy)]
pub struct SiteFrame {
    pub site: Site,
    axes: [[f64; 3]; 3],
}

impl SiteFrame {
    pub fn new(site: &Site) -> SiteFrame {
        SiteFrame {
            site: *site,
            axes: site.enu_axes(),
        }
    }

    /// Altitude and azimuth of a direction without distance (a star, a deep-sky object)
    /// with apparent GHA and Dec of date: `topocentric::horizontal`'s arithmetic.
    pub fn horizontal(&self, gha_deg: f64, dec_deg: f64) -> Horizon {
        let (g, d) = (gha_deg.to_radians(), dec_deg.to_radians());
        let u = [d.cos() * g.cos(), -d.cos() * g.sin(), d.sin()];
        let [e, n, up] = self.axes;
        let ve = u[0] * e[0] + u[1] * e[1] + u[2] * e[2];
        let vn = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
        let vu = u[0] * up[0] + u[1] * up[1] + u[2] * up[2];
        let alt_deg = vu.atan2(ve.hypot(vn)).to_degrees();
        Horizon {
            alt_deg,
            az_deg: ve.atan2(vn).to_degrees().rem_euclid(360.0),
            alt_apparent_deg: alt_deg
                + refraction_true_to_apparent_arcmin(
                    alt_deg,
                    self.site.pressure_hpa,
                    self.site.temperature_c,
                ) / 60.0,
        }
    }
}

/// An instant on the wire: Julian date and its RFC 3339 string.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Instant {
    pub jd_utc: f64,
    pub utc: String,
}

impl Instant {
    pub fn new(jd_utc: f64) -> Instant {
        Instant {
            jd_utc,
            utc: format_utc(jd_utc),
        }
    }
}

/// An instant with the place of the object then.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Sighting {
    pub jd_utc: f64,
    pub utc: String,
    pub alt_deg: f64,
    pub az_deg: f64,
    /// Compass point of `az_deg`: `"N"`, `"NNE"`, ...
    pub direction: &'static str,
}

const POINTS: [&str; 16] = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW",
    "NNW",
];

/// The 16-point compass name of an azimuth.
pub fn compass(az_deg: f64) -> &'static str {
    POINTS[((az_deg.rem_euclid(360.0) / 22.5).round() as usize) % 16]
}

/// Plain-words compass direction for a sentence: "north-east", "south".
pub fn compass_words(az_deg: f64) -> &'static str {
    const WORDS: [&str; 8] = [
        "north",
        "north-east",
        "east",
        "south-east",
        "south",
        "south-west",
        "west",
        "north-west",
    ];
    WORDS[((az_deg.rem_euclid(360.0) / 45.0).round() as usize) % 8]
}

/// Plain words for where something is: "high in the south-east" (60 degrees up or
/// more), "in the west" (30 to 60), "low in the north" (below 30).
pub fn place_words(alt_deg: f64, az_deg: f64) -> String {
    let lead = match alt_deg {
        a if a >= 60.0 => "high in the ",
        a if a >= 30.0 => "in the ",
        _ => "low in the ",
    };
    let mut s = String::from(lead);
    s.push_str(compass_words(az_deg));
    s
}

impl Sighting {
    pub fn new(jd_utc: f64, h: &Horizon) -> Sighting {
        Sighting {
            jd_utc,
            utc: format_utc(jd_utc),
            alt_deg: h.alt_apparent_deg,
            az_deg: h.az_deg,
            direction: compass(h.az_deg),
        }
    }
}

// ---------------------------------------------------------------------------
// The night
// ---------------------------------------------------------------------------

/// How dark the night gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Darkness {
    /// The Sun goes below -18 degrees: full darkness.
    Night,
    /// It reaches -12 but not -18: the sky never gets fully dark.
    AstronomicalTwilight,
    /// It reaches -6 but not -12.
    NauticalTwilight,
    /// It never goes below -6 (or never sets).
    None,
}

/// The observing window of a night.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DarkWindow {
    /// What the window is: full darkness, or the darkest the night gets.
    pub kind: Darkness,
    pub start: Instant,
    pub end: Instant,
    pub hours: f64,
}

/// The Moon through the night.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MoonNight {
    /// Illuminated fraction at the middle of the observing window (or of the night).
    pub illuminated_fraction: f64,
    /// Sun-Moon-Earth angle then, degrees (0 full, 180 new).
    pub phase_angle_deg: f64,
    /// `"new"`, `"waxing crescent"`, `"first quarter"`, `"waxing gibbous"`, `"full"`,
    /// `"waning gibbous"`, `"last quarter"`, `"waning crescent"`.
    pub phase: &'static str,
    pub waxing: bool,
    pub rise: Option<Instant>,
    pub set: Option<Instant>,
    /// Hours of the observing window with the Moon above the horizon.
    pub up_hours: f64,
    /// Hours of the observing window with the Moon below it.
    pub down_hours: f64,
}

/// The Sun's events of the night (standard horizon, CONVENTIONS 13.3).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SunNight {
    pub set: Option<Instant>,
    pub civil_dusk: Option<Instant>,
    pub nautical_dusk: Option<Instant>,
    pub astronomical_dusk: Option<Instant>,
    pub astronomical_dawn: Option<Instant>,
    pub nautical_dawn: Option<Instant>,
    pub civil_dawn: Option<Instant>,
    pub rise: Option<Instant>,
}

/// One night at one place.
pub struct Night {
    pub site: SiteFrame,
    /// Local mean noon to the next local mean noon.
    pub start_jd: f64,
    pub end_jd: f64,
    pub dark: Option<DarkWindow>,
    pub sun: SunNight,
    pub moon: MoonNight,
    /// The Moon every `MOON_STEP_MIN` minutes over `[start_jd, end_jd]`: apparent
    /// altitude, and apparent RA/Dec of date.
    moon_t0: f64,
    moon_alt: Vec<f64>,
    moon_ra: Vec<f64>,
    moon_dec: Vec<f64>,
    phases: Vec<(f64, f64, SkyPhase)>,
    /// `(t, GAST)` at the middle of each `GRID_STEP_MIN` step of the observing window,
    /// computed once for every object the night is asked about.
    grid: std::cell::OnceCell<Vec<(f64, f64)>>,
}

/// Which sky phases count as dark enough for a darkness tier.
type PhaseTest = fn(SkyPhase) -> bool;

/// Step of the observing window's sampling grid, minutes.
pub const GRID_STEP_MIN: f64 = 5.0;
/// Sidereal rate, degrees of GAST per day.
pub const SIDEREAL_DEG_PER_DAY: f64 = 360.985_647_366_29;

/// Spacing of the Moon's samples through the night, minutes.
pub const MOON_STEP_MIN: f64 = 10.0;

/// Local mean noon (12:00 at the observer's longitude) at or before `jd_utc`.
pub fn local_noon_before(lon_deg: f64, jd_utc: f64) -> f64 {
    // Julian dates turn over at Greenwich noon; local mean noon is lon/360 of a day
    // earlier.
    let shift = lon_deg / 360.0;
    (jd_utc + shift).floor() - shift
}

fn first(ev: &[SkyEvent], kind: EventKind) -> Option<Instant> {
    ev.iter()
        .find(|e| e.kind == kind)
        .map(|e| Instant::new(e.jd_utc))
}

fn body_events<'a>(d: &'a DayEvents, body: &str) -> &'a [SkyEvent] {
    d.bodies
        .iter()
        .find(|b| b.body == body)
        .map_or(&[][..], |b| &b.events[..])
}

/// The longest run of consecutive phase segments for which `pred` holds.
fn longest_run(
    phases: &[(f64, f64, SkyPhase)],
    pred: &dyn Fn(SkyPhase) -> bool,
) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    let mut run: Option<(f64, f64)> = None;
    for &(a, b, p) in phases {
        run = if pred(p) {
            Some(run.map_or((a, b), |(s, _)| (s, b)))
        } else {
            None
        };
        if let Some(r) = run {
            if best.is_none_or(|x| r.1 - r.0 > x.1 - x.0) {
                best = Some(r);
            }
        }
    }
    best
}

/// The Moon's phase name from its illuminated fraction and whether it is waxing.
pub fn phase_name(fraction: f64, waxing: bool) -> &'static str {
    match (fraction, waxing) {
        (f, _) if f < 0.03 => "new",
        (f, _) if f > 0.97 => "full",
        (f, true) if (0.45..=0.55).contains(&f) => "first quarter",
        (f, false) if (0.45..=0.55).contains(&f) => "last quarter",
        (f, true) if f < 0.45 => "waxing crescent",
        (_, true) => "waxing gibbous",
        (f, false) if f < 0.45 => "waning crescent",
        (_, false) => "waning gibbous",
    }
}

impl Night {
    /// The night at `site` that `jd_utc` belongs to: the 24 hours from the local mean
    /// noon at or before it, or the next ones once the Sun has risen that morning (so
    /// "tonight" asked at 10:00 is the coming night, asked at 02:00 the current one).
    pub fn containing(sky: &Sky, site: &Site, jd_utc: f64) -> Result<Night, String> {
        let mut start = local_noon_before(site.lon_deg, jd_utc);
        if jd_utc - start > 0.5 {
            let sun = sky
                .apparent_state(SUN, jd_utc)
                .map_err(|e| format!("Sun: {e}"))?;
            if horizontal(&sun, site).alt_deg > events::SUN_RISE_SET_DEG {
                start += 1.0;
            }
        }
        Night::starting(sky, site, start)
    }

    /// The night from the local mean noon `start_jd`.
    pub fn starting(sky: &Sky, site: &Site, start_jd: f64) -> Result<Night, String> {
        let end_jd = start_jd + 1.0;
        check_jd_utc(start_jd).map_err(|e| e.to_string())?;
        check_jd_utc(end_jd).map_err(|e| e.to_string())?;
        let d = events::day_events(
            sky,
            site,
            start_jd,
            end_jd,
            &[SUN, MOON],
            &EventOptions::default(),
        )
        .map_err(|e| e.to_string())?;
        if let Some(e) = d.errors.first() {
            return Err(format!("{}: {}", e.body, e.message));
        }
        let phases: Vec<(f64, f64, SkyPhase)> = d
            .phases
            .iter()
            .map(|p| (p.jd_start, p.jd_end, p.phase))
            .collect();
        let sun_ev = body_events(&d, SUN);
        let moon_ev = body_events(&d, MOON);
        let sun = SunNight {
            set: first(sun_ev, EventKind::Set),
            civil_dusk: first(sun_ev, EventKind::CivilDusk),
            nautical_dusk: first(sun_ev, EventKind::NauticalDusk),
            astronomical_dusk: first(sun_ev, EventKind::AstronomicalDusk),
            astronomical_dawn: first(sun_ev, EventKind::AstronomicalDawn),
            nautical_dawn: first(sun_ev, EventKind::NauticalDawn),
            civil_dawn: first(sun_ev, EventKind::CivilDawn),
            rise: first(sun_ev, EventKind::Rise),
        };

        // Darkness: the longest run of consecutive phases at least this dark.
        let tiers: [(Darkness, PhaseTest); 3] = [
            (Darkness::Night, |p| p == SkyPhase::Night),
            (Darkness::AstronomicalTwilight, |p| {
                matches!(p, SkyPhase::Night | SkyPhase::Astronomical)
            }),
            (Darkness::NauticalTwilight, |p| {
                matches!(
                    p,
                    SkyPhase::Night | SkyPhase::Astronomical | SkyPhase::Nautical
                )
            }),
        ];
        let dark = tiers.iter().find_map(|(kind, f)| {
            longest_run(&phases, &|p| f(p)).map(|(a, b)| DarkWindow {
                kind: *kind,
                start: Instant::new(a),
                end: Instant::new(b),
                hours: (b - a) * 24.0,
            })
        });

        // The Moon's track, and its phase at the middle of the window.
        let s = sample_bodies(sky, site, &[MOON], start_jd, end_jd, MOON_STEP_MIN)
            .map_err(|e| e.to_string())?;
        if let Some(e) = s.errors.first() {
            return Err(format!("{}: {}", e.body, e.message));
        }
        let mt = &s.bodies[0];
        let n = s.jd_utc.len();
        let mut moon_ra = Vec::with_capacity(n);
        for (k, &t) in s.jd_utc.iter().enumerate() {
            moon_ra.push(norm_360(gha_aries_deg(t, 0.0) - mt.gha_deg[k]));
        }
        let mid = dark
            .as_ref()
            .map_or(start_jd + 0.5, |w| 0.5 * (w.start.jd_utc + w.end.jd_utc));
        let m = sky
            .apparent_state(MOON, mid)
            .map_err(|e| format!("Moon: {e}"))?;
        let sn = sky
            .apparent_state(SUN, mid)
            .map_err(|e| format!("Sun: {e}"))?;
        let eps = true_obliquity_rad(jd_tt(mid));
        let elong = norm_360(
            ecliptic_longitude_deg(m.ra_deg, m.dec_deg, eps)
                - ecliptic_longitude_deg(sn.ra_deg, sn.dec_deg, eps),
        );
        let waxing = elong < 180.0;
        let fraction = m.illuminated_fraction.unwrap_or(0.0);

        let mut night = Night {
            site: SiteFrame::new(site),
            start_jd,
            end_jd,
            dark,
            sun,
            moon: MoonNight {
                illuminated_fraction: fraction,
                phase_angle_deg: m.phase_angle_deg.unwrap_or(180.0),
                phase: phase_name(fraction, waxing),
                waxing,
                rise: first(moon_ev, EventKind::Rise),
                set: first(moon_ev, EventKind::Set),
                up_hours: 0.0,
                down_hours: 0.0,
            },
            moon_t0: start_jd,
            moon_alt: mt.alt_apparent_deg.clone(),
            moon_ra,
            moon_dec: mt.dec_deg.clone(),
            phases,
            grid: std::cell::OnceCell::new(),
        };
        if let Some(w) = night.dark.clone() {
            let (up, total) =
                night.fraction_of(w.start.jd_utc, w.end.jd_utc, &|t| night.moon_at(t).0 > 0.0);
            night.moon.up_hours = up * 24.0;
            night.moon.down_hours = (total - up) * 24.0;
        }
        Ok(night)
    }

    /// Days of `[a, b]` for which `pred` holds, sampled every minute, and `b - a`.
    fn fraction_of(&self, a: f64, b: f64, pred: &dyn Fn(f64) -> bool) -> (f64, f64) {
        let step = 1.0 / 1440.0;
        let n = ((b - a) / step).ceil().max(1.0) as usize;
        let dt = (b - a) / n as f64;
        let hits = (0..n).filter(|&k| pred(a + (k as f64 + 0.5) * dt)).count();
        (hits as f64 * dt, b - a)
    }

    /// The Moon at `t` inside the night: apparent altitude, apparent RA and Dec of date
    /// (linear between the 10-minute samples; the Moon moves 0.1 degree in that time).
    pub fn moon_at(&self, t: f64) -> (f64, f64, f64) {
        let step = MOON_STEP_MIN / 1440.0;
        let x = ((t - self.moon_t0) / step).clamp(0.0, (self.moon_alt.len() - 1) as f64);
        let k = (x.floor() as usize).min(self.moon_alt.len().saturating_sub(2));
        let f = x - k as f64;
        let lerp = |v: &[f64]| v[k] + f * (v[k + 1] - v[k]);
        let dra = (self.moon_ra[k + 1] - self.moon_ra[k] + 540.0).rem_euclid(360.0) - 180.0;
        (
            lerp(&self.moon_alt),
            norm_360(self.moon_ra[k] + f * dra),
            lerp(&self.moon_dec),
        )
    }

    /// The observing window cut into `GRID_STEP_MIN` steps: `(t, GAST)` at the middle
    /// of each, and the step in days. Empty without a window.
    pub fn grid(&self) -> (&[(f64, f64)], f64) {
        let Some((a, b)) = self.window() else {
            return (&[], 0.0);
        };
        let step = GRID_STEP_MIN / 1440.0;
        let n = ((b - a) / step).ceil().max(1.0) as usize;
        let dt = (b - a) / n as f64;
        let g = self.grid.get_or_init(|| {
            (0..n)
                .map(|k| {
                    let t = a + (k as f64 + 0.5) * dt;
                    (t, gha_aries_deg(t, 0.0))
                })
                .collect()
        });
        (g, dt)
    }

    /// The longest run of consecutive sky phases for which `pred` holds.
    pub fn run(&self, pred: &dyn Fn(SkyPhase) -> bool) -> Option<(f64, f64)> {
        longest_run(&self.phases, pred)
    }

    /// The sky phase at `t` (CONVENTIONS 13.4).
    pub fn phase_at(&self, t: f64) -> Option<SkyPhase> {
        self.phases
            .iter()
            .find(|&&(a, b, _)| t >= a && t <= b)
            .map(|&(_, _, p)| p)
    }

    /// The Sun below `-18` degrees at `t`.
    pub fn is_dark(&self, t: f64) -> bool {
        self.phase_at(t) == Some(SkyPhase::Night)
    }

    /// The observing window: the darkness, or the night's darkest stretch, or `None`
    /// when the Sun never goes below -6 degrees.
    pub fn window(&self) -> Option<(f64, f64)> {
        self.dark.as_ref().map(|w| (w.start.jd_utc, w.end.jd_utc))
    }

    /// Summary for the wire.
    pub fn summary(&self) -> NightSummary {
        NightSummary {
            start: Instant::new(self.start_jd),
            end: Instant::new(self.end_jd),
            darkness: self.dark.clone(),
            sun: self.sun.clone(),
            moon: self.moon.clone(),
        }
    }
}

/// A night as the wire carries it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NightSummary {
    /// Local mean noon to local mean noon.
    pub start: Instant,
    pub end: Instant,
    /// `null` when the Sun never goes below -6 degrees.
    pub darkness: Option<DarkWindow>,
    pub sun: SunNight,
    pub moon: MoonNight,
}

/// Indices of `keys` from the largest key to the smallest (ties in index order). One
/// sort shared by every ranking in the crate, instead of one per element type.
pub fn order_desc(keys: &[f64]) -> Vec<usize> {
    // Insertion sort: the lists are a few hundred long at most, and it is a few dozen
    // bytes of code instead of a quicksort per call site.
    let mut idx: Vec<usize> = Vec::with_capacity(keys.len());
    for i in 0..keys.len() {
        let at = idx.partition_point(|&j: &usize| keys[j] >= keys[i]);
        idx.insert(at, i);
    }
    idx
}

/// Reorder `items` by `keys`, largest first, keeping at most `limit`.
pub fn take_ordered<T>(items: Vec<T>, keys: &[f64], limit: usize) -> Vec<T> {
    let order = order_desc(keys);
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    order
        .into_iter()
        .take(limit)
        .filter_map(|i| slots[i].take())
        .collect()
}

/// Years since J2000.0 of a UTC instant (for drift and display only).
pub fn years_since_j2000(jd_utc: f64) -> f64 {
    (jd_utc - JD_J2000) / 365.25
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;
    use skyfix_ephemeris::frames::apparent_radec_of_date;

    #[test]
    fn a_fixed_object_follows_the_ephemeris_chain() {
        let jd = civil_to_jd(2026, 9, 24) + 0.25;
        let f = Frame::at(jd).unwrap();
        for (ra, dec) in [
            (10.6847, 41.269),
            (83.82, -5.39),
            (266.4168, -29.0078),
            (0.0, 89.9),
        ] {
            let (a, d) = f.apparent(ra, dec);
            let (a2, d2) = apparent_radec_of_date(ra, dec, 0.0, 0.0, 0.0, jd_tt(jd));
            assert!(separation_deg(a, d, a2, d2) * 3.6e6 < 0.01, "{ra} {dec}");
            // The rotation alone is within aberration and deflection (< 21") of it.
            let (r, s) = f.rotate(ra, dec);
            assert!(separation_deg(a, d, r, s) * 3600.0 < 21.0);
            let (u, v) = f.unrotate(r, s);
            assert!(separation_deg(u, v, ra, dec) * 3.6e6 < 1.0);
        }
        assert!(Frame::at(f64::NAN).is_err());
        assert!(Frame::at(1.0e7).is_err());
    }

    #[test]
    fn local_noon_and_compass_points() {
        // Philadelphia, 75.17 W: local mean noon is 17:00:41 UT.
        let jd = civil_to_jd(2026, 9, 24) + 0.9; // 21:36 UT
        let n = local_noon_before(-75.1652, jd);
        let frac = (n - civil_to_jd(2026, 9, 24)) * 24.0;
        assert!((frac - (12.0 + 75.1652 / 15.0)).abs() < 1e-6, "{frac}");
        assert!(n <= jd && jd - n < 1.0);
        assert_eq!(compass(0.0), "N");
        assert_eq!(compass(44.0), "NE");
        assert_eq!(compass(359.0), "N");
        assert_eq!(compass_words(135.0), "south-east");
        assert_eq!(phase_name(0.5, true), "first quarter");
        assert_eq!(phase_name(0.2, false), "waning crescent");
        assert_eq!(phase_name(0.99, false), "full");
    }

    #[test]
    fn a_night_has_its_darkness_and_the_moon() {
        let sky = Sky::new();
        let site = Site {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
            height_m: 12.0,
            ..Site::default()
        };
        // 2026-09-24 22:00 UT (18:00 EDT): tonight is the night starting today.
        let jd = civil_to_jd(2026, 9, 24) + 22.0 / 24.0;
        let n = Night::containing(&sky, &site, jd).unwrap();
        assert!(n.start_jd <= jd && jd < n.end_jd);
        let w = n.dark.as_ref().unwrap();
        assert_eq!(w.kind, Darkness::Night);
        // Late September at 40 N: about 9 hours of full darkness.
        assert!((8.0..10.5).contains(&w.hours), "{}", w.hours);
        assert_eq!(
            n.sun.astronomical_dusk.as_ref().unwrap().jd_utc,
            w.start.jd_utc
        );
        assert!(n.is_dark(0.5 * (w.start.jd_utc + w.end.jd_utc)));
        assert!((n.moon.up_hours + n.moon.down_hours - w.hours).abs() < 0.05);
        // At 16:00 UT the next day (noon EDT) the night asked for is the coming one.
        let later = Night::containing(&sky, &site, jd + 0.75).unwrap();
        assert!((later.start_jd - n.start_jd - 1.0).abs() < 1e-9);
        // At 06:00 UT (02:00 EDT), still tonight.
        let early = Night::containing(&sky, &site, jd + 8.0 / 24.0).unwrap();
        assert!((early.start_jd - n.start_jd).abs() < 1e-9);
        // The Moon's interpolated place agrees with an exact evaluation to 0.01 deg.
        let t = n.start_jd + 0.37;
        let (alt, ra, dec) = n.moon_at(t);
        let m = sky.apparent_state(MOON, t).unwrap();
        let h = horizontal(&m, &site);
        assert!(
            (alt - h.alt_apparent_deg).abs() < 0.01,
            "{alt} {}",
            h.alt_apparent_deg
        );
        assert!(separation_deg(ra, dec, m.ra_deg, m.dec_deg) < 0.01);
    }

    #[test]
    fn midsummer_far_north_never_gets_dark() {
        let sky = Sky::new();
        let site = Site::new(64.1, -21.9); // Reykjavik
        let n = Night::containing(&sky, &site, civil_to_jd(2026, 6, 21)).unwrap();
        let w = n.dark.as_ref();
        assert!(w.is_none_or(|w| w.kind != Darkness::Night), "{w:?}");
    }
}
