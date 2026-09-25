//! Clear-sky solar energy on a panel: a **clear-sky estimate**, labelled as such wherever
//! it is shown (CONVENTIONS 13.10).
//!
//! # Model
//!
//! 1. **Global horizontal irradiance under a cloudless sky**, Haurwitz (1945, 1946) as
//!    given by Reno, Hansen & Stein (2012, SAND2012-2389, eq. 18):
//!    `GHI = 1098 cos z exp(-0.057 / cos z)` W/m², `z` the Sun's apparent zenith angle
//!    (90° minus `alt_apparent_deg`, CONVENTIONS 13.2), zero with the Sun down.
//! 2. **Beam and diffuse**: the clear-sky direct normal irradiance of Meinel & Meinel
//!    (1976), also as Reno, Hansen & Stein give it (eqs. 22–23):
//!    `DNI = E0 · 0.7^(AM^0.678)`, `AM = 1 / cos z`, with `E0 = 1361 W/m² / r²` the
//!    extraterrestrial normal irradiance at the Sun's distance `r` (au, from the Sun
//!    provider; 1361 W/m²: Kopp & Lean 2011, where the report's formulas use 1366–1368).
//!    The diffuse is the remainder, `DHI = GHI − DNI cos z` (held at zero or above; within
//!    a few hundredths of a degree of the horizon the beam is cut to fit). Under this pair
//!    the diffuse share is 5–10 % with the Sun high, about 20 % at 60° from the zenith and
//!    about half at 80°, the range clear skies show.
//! 3. **Plane of array**, isotropic sky (Liu & Jordan 1963): beam `DNI max(cos θ, 0)`, sky
//!    diffuse `DHI (1 + cos β) / 2`, ground-reflected `GHI ρ (1 - cos β) / 2`, with `β`
//!    the tilt, `ρ` the ground albedo (default 0.2) and `θ` the angle of incidence from
//!    the Sun's apparent direction: `cos θ = cos z cos β + sin z sin β cos(A_sun - A_panel)`.
//! 4. **Energy**: irradiance integrated over time (trapezoids for a day's samples, the
//!    midpoint rule on each local day of a year), kWh/m².
//!
//! # How far to trust it
//!
//! Reno, Hansen & Stein compared Haurwitz with measured irradiance on clear days at 30
//! U.S. sites (about 300 site-years): RMSE **6.6 %** averaged over all sites, with a small
//! mean bias, but it **underestimates at high-elevation sites** (it has no elevation
//! term) and its error varies with season and time of day. Clouds, haze beyond the
//! model's average, snow, shading, soiling, panel temperature and inverter losses are
//! **not modelled**: this is the sunlight reaching a clean panel under a cloudless sky, an
//! upper bound on what a real installation collects.

use serde::{Deserialize, Serialize};
use skyfix_ephemeris::body::{AU_KM, BodyEphemeris, SUN};
use skyfix_ephemeris::topocentric::{Site, horizontal};

use super::{check_window, clip_to_coverage, clock_offset_hours, local_date, roots, year_window};
use crate::sky::track::Track;
use crate::sky::{AlmanacError, checked_site};

/// Haurwitz's coefficients as Reno, Hansen & Stein (2012) give them (eq. 18).
pub const HAURWITZ_A_W_M2: f64 = 1098.0;
pub const HAURWITZ_B: f64 = 0.057;
/// Total solar irradiance at 1 au, W/m² (Kopp & Lean 2011).
pub const SOLAR_CONSTANT_W_M2: f64 = 1361.0;
/// Meinel & Meinel's clear-sky beam: `DNI = E0 · MEINEL_BASE^(AM^MEINEL_EXPONENT)`.
pub const MEINEL_BASE: f64 = 0.7;
pub const MEINEL_EXPONENT: f64 = 0.678;
pub const DEFAULT_ALBEDO: f64 = 0.2;
/// Longest window `solar_day` samples, days.
pub const MAX_DAY_WINDOW_DAYS: f64 = 2.0;
/// Default sample spacing, minutes, and the allowed range.
pub const DEFAULT_STEP_MINUTES: f64 = 10.0;
pub const MIN_STEP_MINUTES: f64 = 1.0;
pub const MAX_STEP_MINUTES: f64 = 60.0;

/// A panel as the request gives it.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Panel {
    /// Degrees from horizontal, 0 (flat) to 90 (vertical).
    pub tilt_deg: f64,
    /// The direction the panel faces, degrees from true north; default: toward the
    /// equator (180 in the northern hemisphere, 0 in the southern).
    pub azimuth_deg: Option<f64>,
    /// Ground reflectance, 0 to 1; default 0.2 (grass, soil).
    pub albedo: Option<f64>,
}

/// A panel with every default resolved.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PanelUsed {
    pub tilt_deg: f64,
    pub azimuth_deg: f64,
    pub albedo: f64,
}

impl Panel {
    /// Resolve the defaults for a site and check the ranges.
    pub fn resolve(&self, site: &Site) -> Result<PanelUsed, AlmanacError> {
        let tilt = self.tilt_deg;
        if !(tilt.is_finite() && (0.0..=90.0).contains(&tilt)) {
            return Err(AlmanacError::invalid(format!(
                "tilt_deg must be between 0 and 90, got {tilt}"
            )));
        }
        let az = self
            .azimuth_deg
            .unwrap_or(if site.lat_deg >= 0.0 { 180.0 } else { 0.0 });
        if !(az.is_finite() && (-360.0..=720.0).contains(&az)) {
            return Err(AlmanacError::invalid(format!(
                "azimuth_deg must be a bearing in degrees, got {az}"
            )));
        }
        let albedo = self.albedo.unwrap_or(DEFAULT_ALBEDO);
        if !(albedo.is_finite() && (0.0..=1.0).contains(&albedo)) {
            return Err(AlmanacError::invalid(format!(
                "albedo must be between 0 and 1, got {albedo}"
            )));
        }
        Ok(PanelUsed {
            tilt_deg: tilt,
            azimuth_deg: az.rem_euclid(360.0),
            albedo,
        })
    }
}

/// Irradiance under a cloudless sky, W/m².
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ClearSky {
    /// Global horizontal (Haurwitz).
    pub ghi_w_m2: f64,
    /// Direct normal.
    pub dni_w_m2: f64,
    /// Diffuse horizontal.
    pub dhi_w_m2: f64,
    /// Extraterrestrial normal irradiance at the Sun's distance.
    pub extraterrestrial_w_m2: f64,
}

/// Clear-sky irradiance for a Sun at `apparent_zenith_deg`, `sun_distance_au` away.
pub fn clear_sky(apparent_zenith_deg: f64, sun_distance_au: f64) -> ClearSky {
    let e0 = SOLAR_CONSTANT_W_M2 / (sun_distance_au * sun_distance_au);
    let cz = apparent_zenith_deg.to_radians().cos();
    if cz <= 0.0 {
        return ClearSky {
            ghi_w_m2: 0.0,
            dni_w_m2: 0.0,
            dhi_w_m2: 0.0,
            extraterrestrial_w_m2: e0,
        };
    }
    let ghi = HAURWITZ_A_W_M2 * cz * (-HAURWITZ_B / cz).exp();
    let air_mass = 1.0 / cz;
    // Within a few hundredths of a degree of the horizon the two published fits cross;
    // the beam is cut so that it never carries more than the global irradiance.
    let dni = (e0 * MEINEL_BASE.powf(air_mass.powf(MEINEL_EXPONENT))).min(ghi / cz);
    let dhi = (ghi - dni * cz).max(0.0);
    ClearSky {
        ghi_w_m2: ghi,
        dni_w_m2: dni,
        dhi_w_m2: dhi,
        extraterrestrial_w_m2: e0,
    }
}

/// Irradiance on a tilted panel, W/m².
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PlaneOfArray {
    pub beam_w_m2: f64,
    pub sky_diffuse_w_m2: f64,
    pub ground_w_m2: f64,
    pub total_w_m2: f64,
    /// Angle between the Sun and the panel's normal, degrees (over 90: the Sun is behind
    /// the panel).
    pub incidence_deg: f64,
}

/// The isotropic-sky plane-of-array irradiance for a Sun at `apparent_zenith_deg`,
/// `sun_az_deg`.
pub fn plane_of_array(
    cs: &ClearSky,
    apparent_zenith_deg: f64,
    sun_az_deg: f64,
    panel: &PanelUsed,
) -> PlaneOfArray {
    let (sz, cz) = apparent_zenith_deg.to_radians().sin_cos();
    let (sb, cb) = panel.tilt_deg.to_radians().sin_cos();
    let cos_theta =
        (cz * cb + sz * sb * (sun_az_deg - panel.azimuth_deg).to_radians().cos()).clamp(-1.0, 1.0);
    let beam = cs.dni_w_m2 * cos_theta.max(0.0);
    let sky = cs.dhi_w_m2 * (1.0 + cb) / 2.0;
    let ground = cs.ghi_w_m2 * panel.albedo * (1.0 - cb) / 2.0;
    PlaneOfArray {
        beam_w_m2: beam,
        sky_diffuse_w_m2: sky,
        ground_w_m2: ground,
        total_w_m2: beam + sky + ground,
        incidence_deg: cos_theta.acos().to_degrees(),
    }
}

/// What the model is and how far to trust it: shown with every solar result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarModel {
    pub label: String,
    pub clear_sky: String,
    pub diffuse_split: String,
    pub transposition: String,
    pub typical_error: String,
    pub not_modelled: String,
}

/// The fixed description of the model (module docs).
pub fn solar_model() -> SolarModel {
    SolarModel {
        label: "clear-sky estimate".to_string(),
        clear_sky: "Haurwitz (1945): GHI = 1098 cos z exp(-0.057 / cos z) W/m2, z the Sun's \
                    apparent zenith angle (coefficients as in Reno, Hansen & Stein 2012, \
                    SAND2012-2389, eq. 18)"
            .to_string(),
        diffuse_split: "beam: Meinel & Meinel (1976), DNI = E0 0.7^(AM^0.678), AM = 1 / cos z \
                        (Reno, Hansen & Stein 2012, eqs. 22-23), E0 = 1361 W/m2 at 1 au \
                        (Kopp & Lean 2011) scaled by the Sun's distance; diffuse: the \
                        remainder, GHI - DNI cos z"
            .to_string(),
        transposition: "isotropic sky (Liu & Jordan 1963) with ground reflection; the angle \
                        of incidence from the Sun's apparent position"
            .to_string(),
        typical_error: "about 7 %: RMSE 6.6 % of measured clear-sky irradiance averaged over 30 \
                        U.S. sites, small mean bias (Reno, Hansen & Stein 2012); it \
                        underestimates at high-elevation sites (no elevation term) and its error \
                        varies with season and time of day"
            .to_string(),
        not_modelled: "clouds, haze beyond the model's average, snow, shading, soiling, panel \
                       temperature and inverter losses: this is the sunlight on a clean panel \
                       under a cloudless sky, an upper bound on what a real installation \
                       collects"
            .to_string(),
    }
}

// ---------------------------------------------------------------------------
// The Sun along a track
// ---------------------------------------------------------------------------

/// Where the Sun is at one instant, for irradiance.
#[derive(Debug, Clone, Copy)]
struct SunSample {
    alt_apparent_deg: f64,
    az_deg: f64,
    distance_au: f64,
}

struct SunProbe<'a> {
    track: &'a Track,
    site: &'a Site,
    scratch: skyfix_ephemeris::body::ApparentState,
}

impl<'a> SunProbe<'a> {
    fn new(track: &'a Track, site: &'a Site) -> Self {
        SunProbe {
            track,
            site,
            scratch: track.template().clone(),
        }
    }

    fn at(&mut self, t: f64) -> SunSample {
        self.track.fill(t, &mut self.scratch);
        let h = horizontal(&self.scratch, self.site);
        SunSample {
            alt_apparent_deg: h.alt_apparent_deg,
            az_deg: h.az_deg,
            distance_au: self.scratch.distance_km.unwrap_or(AU_KM) / AU_KM,
        }
    }
}

fn sun_track(eph: &dyn BodyEphemeris, t0: f64, t1: f64) -> Result<Track, AlmanacError> {
    Ok(Track::build_many(eph, &[SUN], t0, t1)
        .pop()
        .expect("one track per body")?)
}

fn check_step(step_minutes: f64) -> Result<(), AlmanacError> {
    if step_minutes.is_finite() && (MIN_STEP_MINUTES..=MAX_STEP_MINUTES).contains(&step_minutes) {
        Ok(())
    } else {
        Err(AlmanacError::invalid(format!(
            "step_minutes must be between {MIN_STEP_MINUTES} and {MAX_STEP_MINUTES}, got \
             {step_minutes}"
        )))
    }
}

// ---------------------------------------------------------------------------
// A day
// ---------------------------------------------------------------------------

/// One sample of `solar_day`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SolarSample {
    pub jd_utc: f64,
    pub sun_alt_apparent_deg: f64,
    pub sun_az_deg: f64,
    pub ghi_w_m2: f64,
    pub dni_w_m2: f64,
    pub dhi_w_m2: f64,
    /// Total on the panel.
    pub poa_w_m2: f64,
    /// Angle of incidence on the panel, degrees; `None` with the Sun down.
    pub incidence_deg: Option<f64>,
}

/// `solar_day` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarDay {
    pub jd_start: f64,
    pub jd_end: f64,
    pub step_minutes: f64,
    pub panel: PanelUsed,
    pub samples: Vec<SolarSample>,
    /// Energy on the panel over the window, kWh/m² (trapezoids between samples).
    pub poa_kwh_m2: f64,
    /// Energy on a horizontal surface, kWh/m².
    pub ghi_kwh_m2: f64,
    /// Direct-normal energy (a panel that tracks the Sun, beam only), kWh/m².
    pub dni_kwh_m2: f64,
    pub peak_poa_w_m2: f64,
    pub model: SolarModel,
}

/// Clear-sky irradiance on `panel` over `[jd_start, jd_end]` (at most two days; the UI
/// passes one local day) every `step_minutes`, and the energy (EXPLORER_API.md
/// `solar_day`).
pub fn solar_day(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_start: f64,
    jd_end: f64,
    panel: &Panel,
    step_minutes: f64,
) -> Result<SolarDay, AlmanacError> {
    let site = checked_site(site)?;
    check_window(jd_start, jd_end)?;
    if jd_end - jd_start > MAX_DAY_WINDOW_DAYS {
        return Err(AlmanacError::invalid(format!(
            "solar_day covers at most {MAX_DAY_WINDOW_DAYS} days, got {:.2}",
            jd_end - jd_start
        )));
    }
    check_step(step_minutes)?;
    let panel = panel.resolve(&site)?;
    let track = sun_track(eph, jd_start, jd_end)?;
    let mut probe = SunProbe::new(&track, &site);
    let step = step_minutes / 1440.0;
    let count = ((jd_end - jd_start) / step + 1e-9).floor() as usize + 1;
    let mut samples = Vec::with_capacity(count);
    for k in 0..count {
        let t = jd_start + k as f64 * step;
        let s = probe.at(t);
        let z = 90.0 - s.alt_apparent_deg;
        let cs = clear_sky(z, s.distance_au);
        let up = s.alt_apparent_deg > 0.0;
        let poa = plane_of_array(&cs, z, s.az_deg, &panel);
        samples.push(SolarSample {
            jd_utc: t,
            sun_alt_apparent_deg: s.alt_apparent_deg,
            sun_az_deg: s.az_deg,
            ghi_w_m2: cs.ghi_w_m2,
            dni_w_m2: cs.dni_w_m2,
            dhi_w_m2: cs.dhi_w_m2,
            poa_w_m2: if up { poa.total_w_m2 } else { 0.0 },
            incidence_deg: up.then_some(poa.incidence_deg),
        });
    }
    let hours = |f: fn(&SolarSample) -> f64| -> f64 {
        samples
            .windows(2)
            .map(|w| 0.5 * (f(&w[0]) + f(&w[1])) * (w[1].jd_utc - w[0].jd_utc) * 24.0)
            .sum::<f64>()
            / 1000.0
    };
    let poa_kwh_m2 = hours(|s| s.poa_w_m2);
    let ghi_kwh_m2 = hours(|s| s.ghi_w_m2);
    let dni_kwh_m2 = hours(|s| s.dni_w_m2);
    let peak_poa_w_m2 = samples.iter().map(|s| s.poa_w_m2).fold(0.0, f64::max);
    Ok(SolarDay {
        jd_start,
        jd_end,
        step_minutes,
        panel,
        samples,
        poa_kwh_m2,
        ghi_kwh_m2,
        dni_kwh_m2,
        peak_poa_w_m2,
        model: solar_model(),
    })
}

// ---------------------------------------------------------------------------
// A year, and the best tilt
// ---------------------------------------------------------------------------

/// `solar_year` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolarYearRequest {
    pub year: i32,
    #[serde(default)]
    pub panel: Panel,
    /// The clock the local days are laid out on; default local mean time.
    #[serde(default)]
    pub utc_offset_hours: Option<f64>,
    /// Integration step, minutes (default 10).
    #[serde(default)]
    pub step_minutes: Option<f64>,
    /// Also search the tilt that collects the most in the year, for the panel's azimuth.
    #[serde(default)]
    pub optimise_tilt: bool,
}

/// One local day's energy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarDayTotal {
    pub date: String,
    pub jd_start: f64,
    pub poa_kwh_m2: f64,
    pub ghi_kwh_m2: f64,
}

/// One month's energy (local calendar month).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarMonth {
    pub month: u32,
    pub days: u32,
    pub poa_kwh_m2: f64,
    pub ghi_kwh_m2: f64,
}

/// The tilt that collects the most clear-sky energy in the year for the panel's azimuth.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OptimalTilt {
    pub tilt_deg: f64,
    pub azimuth_deg: f64,
    /// The year's energy at that tilt, kWh/m².
    pub poa_kwh_m2: f64,
}

/// `solar_year` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarYear {
    pub year: i32,
    pub utc_offset_hours: f64,
    pub step_minutes: f64,
    pub panel: PanelUsed,
    pub jd_start: f64,
    pub jd_end: f64,
    /// The local year reaches outside the coverage; the days outside are left out.
    pub truncated: bool,
    pub days: Vec<SolarDayTotal>,
    pub months: Vec<SolarMonth>,
    /// The year's energy on the panel and on a horizontal surface, kWh/m².
    pub poa_kwh_m2: f64,
    pub ghi_kwh_m2: f64,
    pub optimal: Option<OptimalTilt>,
    pub model: SolarModel,
}

/// One daylight sample of the year, kept for the tilt search: everything
/// [`plane_of_array`] needs that does not depend on the tilt.
#[derive(Debug, Clone, Copy)]
struct Lit {
    day: usize,
    /// cos and sin of the apparent zenith angle.
    cz: f64,
    sz: f64,
    /// cos(A_sun - A_panel).
    cos_daz: f64,
    ghi: f64,
    dni: f64,
    dhi: f64,
}

impl Lit {
    /// [`plane_of_array`]'s total for a tilt given by its cosine and sine.
    fn poa(&self, cb: f64, sb: f64, albedo: f64) -> f64 {
        let cos_theta = self.cz * cb + self.sz * sb * self.cos_daz;
        self.dni * cos_theta.max(0.0)
            + self.dhi * (1.0 + cb) / 2.0
            + self.ghi * albedo * (1.0 - cb) / 2.0
    }
}

/// The year's plane-of-array irradiance summed over the daylight samples, W/m².
fn poa_sum(lit: &[Lit], tilt_deg: f64, albedo: f64) -> f64 {
    let (sb, cb) = tilt_deg.to_radians().sin_cos();
    lit.iter().map(|l| l.poa(cb, sb, albedo)).sum()
}

/// Clear-sky energy on `request.panel` for every local day of a year, by month and in
/// total, and optionally the best tilt (EXPLORER_API.md `solar_year`).
pub fn solar_year(
    eph: &dyn BodyEphemeris,
    site: &Site,
    request: &SolarYearRequest,
) -> Result<SolarYear, AlmanacError> {
    let site = checked_site(site)?;
    let panel = request.panel.resolve(&site)?;
    let step_minutes = request.step_minutes.unwrap_or(DEFAULT_STEP_MINUTES);
    check_step(step_minutes)?;
    let offset = clock_offset_hours(request.utc_offset_hours, &site)?;
    let (y0, y1) = year_window(request.year, offset)?;
    let w = clip_to_coverage(eph, y0, y1)?;
    let n_days = (y1 - y0).round() as usize;
    let first = (0..n_days).find(|&i| y0 + i as f64 >= w.start - 1e-9);
    let last = (0..n_days)
        .rev()
        .find(|&i| y0 + i as f64 + 1.0 <= w.end + 1e-9);
    let (Some(first), Some(last)) = (first, last) else {
        return Err(AlmanacError::invalid(format!(
            "no whole local day of {} is inside the coverage",
            request.year
        )));
    };
    if last < first {
        return Err(AlmanacError::invalid(format!(
            "no whole local day of {} is inside the coverage",
            request.year
        )));
    }
    let a = y0 + first as f64;
    let b = y0 + last as f64 + 1.0;
    check_window(a, b)?;
    let track = sun_track(eph, a, b)?;
    let mut probe = SunProbe::new(&track, &site);
    let per_day = (1440.0 / step_minutes).round().max(1.0) as usize;
    let dt_h = 24.0 / per_day as f64;

    let mut lit: Vec<Lit> = Vec::new();
    let mut days: Vec<SolarDayTotal> = Vec::with_capacity(last - first + 1);
    for i in first..=last {
        let d0 = y0 + i as f64;
        let mut ghi_wh = 0.0;
        for j in 0..per_day {
            let t = d0 + (j as f64 + 0.5) * dt_h / 24.0;
            let s = probe.at(t);
            if s.alt_apparent_deg <= 0.0 {
                continue;
            }
            let z = 90.0 - s.alt_apparent_deg;
            let cs = clear_sky(z, s.distance_au);
            ghi_wh += cs.ghi_w_m2 * dt_h;
            let (sz, cz) = z.to_radians().sin_cos();
            lit.push(Lit {
                day: days.len(),
                cz,
                sz,
                cos_daz: (s.az_deg - panel.azimuth_deg).to_radians().cos(),
                ghi: cs.ghi_w_m2,
                dni: cs.dni_w_m2,
                dhi: cs.dhi_w_m2,
            });
        }
        days.push(SolarDayTotal {
            date: local_date(d0 + 0.5, offset),
            jd_start: d0,
            poa_kwh_m2: 0.0,
            ghi_kwh_m2: ghi_wh / 1000.0,
        });
    }
    let (sb, cb) = panel.tilt_deg.to_radians().sin_cos();
    for l in &lit {
        days[l.day].poa_kwh_m2 += l.poa(cb, sb, panel.albedo) * dt_h / 1000.0;
    }

    let mut months: Vec<SolarMonth> = Vec::new();
    for d in &days {
        let month = d
            .date
            .rsplit('-')
            .nth(1)
            .and_then(|m| m.parse::<u32>().ok())
            .unwrap_or(0);
        match months.last_mut() {
            Some(m) if m.month == month => {
                m.days += 1;
                m.poa_kwh_m2 += d.poa_kwh_m2;
                m.ghi_kwh_m2 += d.ghi_kwh_m2;
            }
            _ => months.push(SolarMonth {
                month,
                days: 1,
                poa_kwh_m2: d.poa_kwh_m2,
                ghi_kwh_m2: d.ghi_kwh_m2,
            }),
        }
    }
    let poa_kwh_m2 = days.iter().map(|d| d.poa_kwh_m2).sum();
    let ghi_kwh_m2 = days.iter().map(|d| d.ghi_kwh_m2).sum();

    let optimal = request.optimise_tilt.then(|| {
        let energy = |tilt: f64| poa_sum(&lit, tilt, panel.albedo) * dt_h / 1000.0;
        let (tilt, neg) = roots::brent_min(|t| -energy(t), 0.0, 90.0, 0.01);
        // Brent's minimiser never evaluates the ends; a flat or vertical optimum is
        // checked explicitly.
        let (tilt, best) = [(0.0, energy(0.0)), (90.0, energy(90.0))]
            .into_iter()
            .fold((tilt, -neg), |acc, c| if c.1 > acc.1 { c } else { acc });
        OptimalTilt {
            tilt_deg: tilt,
            azimuth_deg: panel.azimuth_deg,
            poa_kwh_m2: best,
        }
    });

    Ok(SolarYear {
        year: request.year,
        utc_offset_hours: offset,
        step_minutes,
        panel,
        jd_start: a,
        jd_end: b,
        truncated: w.truncated || a > y0 || b < y1,
        days,
        months,
        poa_kwh_m2,
        ghi_kwh_m2,
        optimal,
        model: solar_model(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haurwitz_as_published() {
        // Reno, Hansen & Stein (2012) eq. 18 at a few zenith angles, by hand.
        for (z, expect) in [
            (0.0, 1098.0 * (-0.057f64).exp()),
            (60.0, 549.0 * (-0.114f64).exp()),
            (
                80.0,
                1098.0 * 80f64.to_radians().cos() * (-0.057 / 80f64.to_radians().cos()).exp(),
            ),
        ] {
            let cs = clear_sky(z, 1.0);
            assert!((cs.ghi_w_m2 - expect).abs() < 1e-9, "{z}: {}", cs.ghi_w_m2);
        }
        assert_eq!(clear_sky(90.0, 1.0).ghi_w_m2, 0.0);
        assert_eq!(clear_sky(95.0, 1.0).dni_w_m2, 0.0);
    }

    #[test]
    fn meinel_as_published() {
        // Reno, Hansen & Stein (2012) eqs. 22-23: DNI = I0 0.7^(AM^0.678), AM = sec z.
        for z in [0.0f64, 30.0, 60.0, 75.0] {
            let am = 1.0 / z.to_radians().cos();
            let expect = 1361.0 * 0.7f64.powf(am.powf(0.678));
            let cs = clear_sky(z, 1.0);
            assert!((cs.dni_w_m2 - expect).abs() < 1e-9, "{z}: {}", cs.dni_w_m2);
        }
        // At perihelion the extraterrestrial irradiance is 3.4 % higher.
        let jan = clear_sky(0.0, 0.983_29);
        assert!((jan.extraterrestrial_w_m2 / 1361.0 - 1.0 / 0.983_29f64.powi(2)).abs() < 1e-12);
    }

    #[test]
    fn the_split_conserves_global_irradiance_with_a_clear_sky_diffuse_share() {
        let mut last = 0.0;
        for z in [0.0, 20.0, 45.0, 60.0, 70.0, 80.0, 85.0, 88.0, 89.9, 89.99] {
            for r in [0.983_29, 1.0, 1.016_71] {
                let cs = clear_sky(z, r);
                let cz = f64::to_radians(z).cos();
                assert!(
                    (cs.dni_w_m2 * cz + cs.dhi_w_m2 - cs.ghi_w_m2).abs() < 1e-9,
                    "{z}: {cs:?}"
                );
                assert!(cs.dhi_w_m2 >= 0.0 && cs.dni_w_m2 >= 0.0);
                assert!(cs.dni_w_m2 < cs.extraterrestrial_w_m2);
            }
            // The diffuse share grows toward the horizon: 5-10 % overhead, about 20 % at
            // 60 degrees, about half at 80.
            let cs = clear_sky(z, 1.0);
            if cs.ghi_w_m2 < 1.0 {
                continue; // a thousandth of a watt within 0.1 degree of the horizon
            }
            let kd = cs.dhi_w_m2 / cs.ghi_w_m2;
            assert!(kd >= last - 1e-12, "{z}: diffuse share {kd} after {last}");
            last = kd;
            let (lo, hi) = match z as i64 {
                0 => (0.05, 0.10),
                60 => (0.15, 0.25),
                80 => (0.40, 0.55),
                _ => (0.0, 1.0),
            };
            assert!(kd >= lo && kd <= hi, "{z}: diffuse share {kd}");
        }
    }

    #[test]
    fn a_flat_panel_gets_the_global_irradiance_and_a_facing_one_the_beam() {
        let cs = clear_sky(35.0, 1.0);
        let flat = PanelUsed {
            tilt_deg: 0.0,
            azimuth_deg: 180.0,
            albedo: 0.2,
        };
        let p = plane_of_array(&cs, 35.0, 150.0, &flat);
        assert!((p.total_w_m2 - cs.ghi_w_m2).abs() < 1e-9);
        assert!((p.incidence_deg - 35.0).abs() < 1e-9);
        let facing = PanelUsed {
            tilt_deg: 35.0,
            azimuth_deg: 150.0,
            albedo: 0.0,
        };
        let q = plane_of_array(&cs, 35.0, 150.0, &facing);
        assert!(q.incidence_deg.abs() < 1e-6);
        assert!((q.beam_w_m2 - cs.dni_w_m2).abs() < 1e-9);
        // The Sun behind a vertical panel: no beam, half the sky, half the ground.
        let behind = PanelUsed {
            tilt_deg: 90.0,
            azimuth_deg: 330.0,
            albedo: 0.2,
        };
        let r = plane_of_array(&cs, 35.0, 150.0, &behind);
        assert_eq!(r.beam_w_m2, 0.0);
        assert!((r.sky_diffuse_w_m2 - cs.dhi_w_m2 / 2.0).abs() < 1e-9);
        assert!((r.ground_w_m2 - cs.ghi_w_m2 * 0.1).abs() < 1e-9);
    }

    #[test]
    fn panels_resolve_their_defaults() {
        let north = Site::new(40.0, -75.0);
        let south = Site::new(-33.9, 18.4);
        let p = Panel {
            tilt_deg: 30.0,
            ..Panel::default()
        };
        assert_eq!(p.resolve(&north).unwrap().azimuth_deg, 180.0);
        assert_eq!(p.resolve(&south).unwrap().azimuth_deg, 0.0);
        assert_eq!(p.resolve(&north).unwrap().albedo, 0.2);
        assert!(
            Panel {
                tilt_deg: 91.0,
                ..p
            }
            .resolve(&north)
            .is_err()
        );
        assert!(
            Panel {
                albedo: Some(1.5),
                ..p
            }
            .resolve(&north)
            .is_err()
        );
    }
}
