//! Meteor showers: this project's own table of 32 major showers, their dates in any
//! year, and what a night at a place offers (EXPLORER_API.md, "Deep sky").
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6).
//!
//! `data/showers.txt` is written by `tools/starfield/showers.py` from
//! `tools/starfield/showers_table.txt`, compiled from IAU Meteor Data Center and IMO
//! published values (and checked against both). Activity is stored as **solar
//! longitude** (J2000), so each year's dates come from this project's own Sun:
//!
//! - `λ☉` is the Sun's apparent geocentric ecliptic longitude referred to the mean
//!   ecliptic and equinox of J2000.0: the Sun's apparent direction of date rotated back
//!   to ICRS (the transpose of the bias-precession-nutation matrix) and onto the J2000
//!   ecliptic (obliquity 84 381.406", IAU 2006);
//! - the instant of a given `λ☉` is found by Newton's method on that function (the Sun
//!   gains 0.9856 degrees a day), to 0.01 s.
//!
//! Per night: the radiant moves along its daily drift from the peak; the zenithal
//! hourly rate falls off exponentially on either side of the peak, reaching
//! `min(2, ZHR/2)` at the table's activity limits (a rough profile, labelled); the
//! observed rate is estimated as `ZHR(λ☉) sin(h) r^(LM - 6.5)`, `h` the radiant's
//! altitude and `LM` the limiting magnitude at the zenith with the Moon's light
//! ([`crate::extinction`]). All of it is an estimate, and the wire says so.

use std::sync::OnceLock;

use serde::Serialize;
use skyfix_core::time::civil_to_jd;
use skyfix_ephemeris::body::{BodyEphemeris, MOON, SUN, Sky};
use skyfix_ephemeris::frames::unit_vector_from_radec;
use skyfix_ephemeris::topocentric::Site;

use crate::StarfieldError;
use crate::extinction::{Conditions, moonlight};
use crate::observe::{Frame, Instant, Night, Sighting, local_noon_before};

const SHOWERS_TXT: &str = include_str!("../data/showers.txt");

/// Obliquity of the ecliptic at J2000.0, IAU 2006, radians.
const EPS_J2000_RAD: f64 = 84_381.406 / 3600.0 * std::f64::consts::PI / 180.0;
/// Mean motion of the Sun in longitude, degrees per day.
const SUN_DEG_PER_DAY: f64 = 0.985_647_36;

/// One shower of the table.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Shower {
    /// IAU number and three-letter code.
    pub iau: u16,
    pub code: &'static str,
    pub name: &'static str,
    /// Solar longitude (J2000) of the start, peak and end of activity, degrees.
    pub lambda_start_deg: f64,
    pub lambda_peak_deg: f64,
    pub lambda_end_deg: f64,
    /// Radiant at the peak, J2000 degrees.
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// Radiant drift, degrees of RA and of Dec per degree of solar longitude.
    pub dra_deg: f64,
    pub ddec_deg: f64,
    /// Speed at entry, km/s.
    pub v_inf_kms: f64,
    /// Population index.
    pub r: f64,
    /// Typical peak zenithal hourly rate.
    pub zhr: u16,
    /// The rate varies from year to year or the shower has had outbursts.
    pub variable: bool,
    pub parent: Option<&'static str>,
}

fn wrap180(x: f64) -> f64 {
    (x + 180.0).rem_euclid(360.0) - 180.0
}

impl Shower {
    /// Degrees of solar longitude from the peak to `lambda_deg`, `(-180, 180]`.
    fn offset(&self, lambda_deg: f64) -> f64 {
        wrap180(lambda_deg - self.lambda_peak_deg)
    }

    /// Whether the Sun at `lambda_deg` lies in the activity period.
    pub fn active(&self, lambda_deg: f64) -> bool {
        let d = self.offset(lambda_deg);
        let before = (self.lambda_peak_deg - self.lambda_start_deg).rem_euclid(360.0);
        let after = (self.lambda_end_deg - self.lambda_peak_deg).rem_euclid(360.0);
        d >= -before && d <= after
    }

    /// Radiant (J2000 degrees) with the Sun at `lambda_deg`, drifting from the peak and
    /// held at the activity limits.
    pub fn radiant_at(&self, lambda_deg: f64) -> (f64, f64) {
        let before = (self.lambda_peak_deg - self.lambda_start_deg).rem_euclid(360.0);
        let after = (self.lambda_end_deg - self.lambda_peak_deg).rem_euclid(360.0);
        let d = self.offset(lambda_deg).clamp(-before, after);
        (
            (self.ra_deg + self.dra_deg * d).rem_euclid(360.0),
            (self.dec_deg + self.ddec_deg * d).clamp(-90.0, 90.0),
        )
    }

    /// Zenithal hourly rate with the Sun at `lambda_deg`: exponential either side of the
    /// peak, `min(2, ZHR/2)` at the activity limits, zero outside them (a rough
    /// profile).
    pub fn zhr_at(&self, lambda_deg: f64) -> f64 {
        if !self.active(lambda_deg) {
            return 0.0;
        }
        let peak = f64::from(self.zhr);
        let edge = (peak / 2.0).min(2.0);
        let d = self.offset(lambda_deg);
        let span = if d < 0.0 {
            (self.lambda_peak_deg - self.lambda_start_deg).rem_euclid(360.0)
        } else {
            (self.lambda_end_deg - self.lambda_peak_deg).rem_euclid(360.0)
        };
        if span <= 0.0 {
            return peak;
        }
        peak * 10f64.powf(-(peak / edge).log10() * d.abs() / span)
    }
}

fn parse() -> Result<Vec<Shower>, StarfieldError> {
    let mut out = Vec::new();
    for line in SHOWERS_TXT.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&'static str> = line.split('|').collect();
        let bad = || StarfieldError::Data(format!("showers.txt: bad line {line:?}"));
        if f.len() != 15 {
            return Err(bad());
        }
        let n = |s: &str| s.parse::<f64>().map_err(|_| bad());
        out.push(Shower {
            iau: f[0].parse().map_err(|_| bad())?,
            code: f[1],
            name: f[2],
            lambda_start_deg: n(f[3])?,
            lambda_peak_deg: n(f[4])?,
            lambda_end_deg: n(f[5])?,
            ra_deg: n(f[6])?,
            dec_deg: n(f[7])?,
            dra_deg: n(f[8])?,
            ddec_deg: n(f[9])?,
            v_inf_kms: n(f[10])?,
            r: n(f[11])?,
            zhr: f[12].parse().map_err(|_| bad())?,
            variable: match f[13] {
                "0" => false,
                "1" => true,
                _ => return Err(bad()),
            },
            parent: (!f[14].is_empty()).then_some(f[14]),
        });
    }
    Ok(out)
}

/// The whole table, parsed on first use.
pub fn table() -> Result<&'static [Shower], StarfieldError> {
    static CELL: OnceLock<Result<Vec<Shower>, StarfieldError>> = OnceLock::new();
    CELL.get_or_init(parse)
        .as_ref()
        .map(|v| v.as_slice())
        .map_err(Clone::clone)
}

/// A shower by its IAU code or name, case ignored.
pub fn find(code_or_name: &str) -> Result<Option<&'static Shower>, StarfieldError> {
    let k = code_or_name.trim();
    Ok(table()?
        .iter()
        .find(|s| s.code.eq_ignore_ascii_case(k) || s.name.eq_ignore_ascii_case(k)))
}

// ---------------------------------------------------------------------------
// Solar longitude
// ---------------------------------------------------------------------------

/// The Sun's apparent geocentric ecliptic longitude referred to J2000, degrees `[0,
/// 360)`.
pub fn solar_longitude_j2000(sky: &Sky, jd_utc: f64) -> Result<f64, String> {
    let s = sky
        .apparent_state(SUN, jd_utc)
        .map_err(|e| format!("Sun: {e}"))?;
    let frame = Frame::at(jd_utc).map_err(|e| e.to_string())?;
    let (ra, dec) = frame.unrotate(s.ra_deg, s.dec_deg);
    let v = unit_vector_from_radec(ra, dec);
    let (se, ce) = EPS_J2000_RAD.sin_cos();
    let y = v[1] * ce + v[2] * se;
    Ok(y.atan2(v[0]).to_degrees().rem_euclid(360.0))
}

/// The instant near `guess` when the solar longitude is `lambda_deg`.
pub fn instant_of_solar_longitude(sky: &Sky, lambda_deg: f64, guess: f64) -> Result<f64, String> {
    let mut t = guess;
    for _ in 0..8 {
        let d = wrap180(lambda_deg - solar_longitude_j2000(sky, t)?) / SUN_DEG_PER_DAY;
        t += d;
        if d.abs() < 1e-7 {
            return Ok(t);
        }
    }
    Ok(t)
}

// ---------------------------------------------------------------------------
// A night
// ---------------------------------------------------------------------------

/// Radiant altitude above which rates are counted, degrees.
pub const MIN_RADIANT_ALT_DEG: f64 = 0.0;
/// Sampling step through the observing window, minutes.
pub const STEP_MIN: f64 = 10.0;

/// One shower through one night at one place.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShowerNight {
    pub code: &'static str,
    pub name: &'static str,
    /// Solar longitude at the middle of the observing window, and the ZHR the profile
    /// gives there.
    pub lambda_deg: f64,
    pub zhr: f64,
    /// Days from the peak to the middle of the window (negative before it).
    pub days_from_peak: f64,
    /// Radiant, J2000 degrees, at that solar longitude.
    pub radiant_ra_deg: f64,
    pub radiant_dec_deg: f64,
    /// The best hour: the highest expected rate in the window.
    pub best: Option<Sighting>,
    /// Meteors an observer might see in an hour then: `ZHR sin(h) r^(LM - 6.5)`, an
    /// estimate.
    pub expected_rate_per_hour: f64,
    /// Limiting magnitude at the zenith then, with the Moon's light.
    pub limiting_mag: Option<f64>,
    /// Hours of the window with the radiant above 20 degrees.
    pub hours_radiant_above_20: f64,
}

/// The shower through `night` (its observing window), or `None` when it is not active.
pub fn night_activity(
    sky: &Sky,
    shower: &Shower,
    night: &Night,
    conditions: &Conditions,
) -> Result<Option<ShowerNight>, String> {
    let Some((a, b)) = night.window() else {
        return Ok(None);
    };
    let mid = 0.5 * (a + b);
    let lambda = solar_longitude_j2000(sky, mid)?;
    if !shower.active(lambda) {
        return Ok(None);
    }
    let zhr = shower.zhr_at(lambda);
    let (ra0, dec0) = shower.radiant_at(lambda);
    let frame = Frame::at(mid).map_err(|e| e.to_string())?;
    let (ra, dec) = frame.apparent(ra0, dec0);
    let step = STEP_MIN / 1440.0;
    let n = ((b - a) / step).ceil().max(1.0) as usize;
    let dt = (b - a) / n as f64;
    let mut best: Option<(f64, f64, f64, crate::observe::Horizon)> = None;
    let mut above20 = 0usize;
    for k in 0..=n {
        let t = a + k as f64 * dt;
        let gast = skyfix_ephemeris::sidereal::gha_aries_deg(t, 0.0);
        let h = night.site.horizontal((gast - ra).rem_euclid(360.0), dec);
        if k < n && h.alt_apparent_deg >= 20.0 {
            above20 += 1;
        }
        if h.alt_apparent_deg <= MIN_RADIANT_ALT_DEG {
            continue;
        }
        let (malt, _, _) = night.moon_at(t);
        let ml = moonlight(
            night.moon.phase_angle_deg,
            malt,
            90.0,
            90.0 - malt,
            conditions.k,
            conditions.sky_brightness_mpsas,
        );
        let lm = conditions.nelm_brightened(ml.brightening_mag);
        let rate = zhr * h.alt_apparent_deg.to_radians().sin() * shower.r.powf(lm - 6.5);
        if best.is_none_or(|(_, r, _, _)| rate > r) {
            best = Some((t, rate, lm, h));
        }
    }
    let days_from_peak = wrap180(lambda - shower.lambda_peak_deg) / SUN_DEG_PER_DAY;
    Ok(Some(ShowerNight {
        code: shower.code,
        name: shower.name,
        lambda_deg: lambda,
        zhr,
        days_from_peak,
        radiant_ra_deg: ra0,
        radiant_dec_deg: dec0,
        best: best.map(|(t, _, _, h)| Sighting::new(t, &h)),
        expected_rate_per_hour: best.map_or(0.0, |(_, r, _, _)| r),
        limiting_mag: best.map(|(_, _, lm, _)| lm),
        hours_radiant_above_20: above20 as f64 * dt * 24.0,
    }))
}

// ---------------------------------------------------------------------------
// A year
// ---------------------------------------------------------------------------

/// One shower's dates in a year.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShowerDates {
    #[serde(flatten)]
    pub shower: &'static Shower,
    /// The peak in the calendar year asked for; start and end around it (the start
    /// may fall in the year before, the end in the year after).
    pub peak: Instant,
    pub start: Instant,
    pub end: Instant,
    /// Geocentric illuminated fraction of the Moon at the peak.
    pub moon_illuminated_fraction: f64,
    /// With an observer: the night nearest the peak.
    pub at_site: Option<ShowerNight>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShowerYear {
    pub year: i32,
    pub showers: Vec<ShowerDates>,
    /// Showers that could not be computed (outside the Sun's coverage), with why.
    pub errors: Vec<ShowerError>,
    pub source: &'static str,
    pub rate_model: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShowerError {
    pub code: &'static str,
    pub message: String,
}

pub const SOURCE: &str = "SkyFix Lab's own table of 32 IAU-established showers, compiled \
     from IAU Meteor Data Center and IMO published values; dates from SkyFix Lab's Sun.";
pub const RATE_MODEL: &str = "Estimate. ZHR falls off exponentially from the peak to the \
     activity limits; expected rate = ZHR x sin(radiant altitude) x r^(LM - 6.5), LM the \
     naked-eye limit at the zenith with the Moon's light (Krisciunas & Schaefer 1991). \
     Real rates vary from year to year.";

fn dates(sky: &Sky, s: &Shower, year: i32) -> Result<(f64, f64, f64), String> {
    let jan1 = civil_to_jd(year, 1, 1);
    let l0 = solar_longitude_j2000(sky, jan1)?;
    let guess = jan1 + (s.lambda_peak_deg - l0).rem_euclid(360.0) / SUN_DEG_PER_DAY;
    let mut peak = instant_of_solar_longitude(sky, s.lambda_peak_deg, guess)?;
    // Keep the peak inside the calendar year (the linear guess can land a day out).
    if peak < jan1 {
        peak = instant_of_solar_longitude(sky, s.lambda_peak_deg, peak + 365.2422)?;
    } else if peak >= civil_to_jd(year + 1, 1, 1) {
        peak = instant_of_solar_longitude(sky, s.lambda_peak_deg, peak - 365.2422)?;
    }
    let before = (s.lambda_peak_deg - s.lambda_start_deg).rem_euclid(360.0);
    let after = (s.lambda_end_deg - s.lambda_peak_deg).rem_euclid(360.0);
    let start =
        instant_of_solar_longitude(sky, s.lambda_start_deg, peak - before / SUN_DEG_PER_DAY)?;
    let end = instant_of_solar_longitude(sky, s.lambda_end_deg, peak + after / SUN_DEG_PER_DAY)?;
    Ok((start, peak, end))
}

/// Every shower's dates in `year`, and with a site the night nearest each peak.
pub fn year(
    sky: &Sky,
    year: i32,
    site: Option<&Site>,
    conditions: &Conditions,
) -> Result<ShowerYear, String> {
    let mut out = ShowerYear {
        year,
        showers: Vec::new(),
        errors: Vec::new(),
        source: SOURCE,
        rate_model: RATE_MODEL,
    };
    for s in table().map_err(|e| e.to_string())? {
        let r = (|| -> Result<ShowerDates, String> {
            let (start, peak, end) = dates(sky, s, year)?;
            let m = sky
                .apparent_state(MOON, peak)
                .map_err(|e| format!("Moon: {e}"))?;
            let at_site = match site {
                Some(site) => {
                    // The night whose local midnight is nearest the peak: the one
                    // starting at the local noon before it.
                    let night = Night::starting(sky, site, local_noon_before(site.lon_deg, peak))?;
                    night_activity(sky, s, &night, conditions)?
                }
                None => None,
            };
            Ok(ShowerDates {
                shower: s,
                peak: Instant::new(peak),
                start: Instant::new(start),
                end: Instant::new(end),
                moon_illuminated_fraction: m.illuminated_fraction.unwrap_or(0.0),
                at_site,
            })
        })();
        match r {
            Ok(d) => out.showers.push(d),
            Err(message) => out.errors.push(ShowerError {
                code: s.code,
                message,
            }),
        }
    }
    if out.showers.is_empty() {
        return Err(out
            .errors
            .first()
            .map_or_else(|| "no showers".to_string(), |e| e.message.clone()));
    }
    out.showers
        .sort_by(|a, b| a.peak.jd_utc.total_cmp(&b.peak.jd_utc));
    Ok(out)
}

/// The radiant of a shower as a direction of date at `jd_utc` (for search and the Sky
/// view), J2000 held at the activity limits outside them.
pub fn radiant_of_date(sky: &Sky, s: &Shower, jd_utc: f64) -> Result<(f64, f64), String> {
    let lambda = solar_longitude_j2000(sky, jd_utc)?;
    let (ra, dec) = s.radiant_at(lambda);
    let frame = Frame::at(jd_utc).map_err(|e| e.to_string())?;
    Ok(frame.apparent(ra, dec))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_parses() {
        let t = table().unwrap();
        assert_eq!(t.len(), 32);
        let per = find("per").unwrap().unwrap();
        assert_eq!((per.iau, per.name, per.zhr), (7, "Perseids", 100));
        assert_eq!(per.parent, Some("109P/Swift-Tuttle"));
        assert!(find("Geminids").unwrap().is_some());
        assert!(find("XXX").unwrap().is_none());
    }

    #[test]
    fn activity_profile_and_drift() {
        let per = find("PER").unwrap().unwrap();
        assert!(per.active(140.0) && per.active(114.0) && per.active(151.0));
        assert!(!per.active(160.0) && !per.active(100.0));
        assert_eq!(per.zhr_at(140.0), 100.0);
        assert!((per.zhr_at(per.lambda_end_deg) - 2.0).abs() < 1e-9);
        assert!((per.zhr_at(per.lambda_start_deg) - 2.0).abs() < 1e-9);
        assert_eq!(per.zhr_at(170.0), 0.0);
        let (ra, dec) = per.radiant_at(130.0);
        assert!((ra - (48.0 - 14.0)).abs() < 1e-9 && (dec - (58.0 - 2.1)).abs() < 1e-9);
        // The Quadrantids' activity crosses no 0/360 boundary but the year: fine; a
        // shower whose limits wrap is handled by the modular arithmetic.
        let qua = find("QUA").unwrap().unwrap();
        assert!(qua.active(280.0) && !qua.active(300.0));
    }

    #[test]
    fn the_solar_longitude_is_zero_at_the_march_equinox() {
        // The equinox is where the apparent longitude *of date* is 0; the J2000
        // longitude is then smaller by the precession since 2000 (26.2 years x 50.3"),
        // about 0.366 degrees, give or take nutation (under 20").
        let sky = Sky::new();
        let equinox = skyfix_almanac::events::seasons(&sky, 2026).unwrap()[0].jd_utc;
        let l = solar_longitude_j2000(&sky, equinox).unwrap();
        let expected = 360.0 - 26.22 * 50.29 / 3600.0;
        assert!((l - expected).abs() < 0.01, "{l} vs {expected}");
        let t = instant_of_solar_longitude(&sky, l, equinox + 3.0).unwrap();
        assert!((t - equinox).abs() * 86_400.0 < 0.01);
    }
}
