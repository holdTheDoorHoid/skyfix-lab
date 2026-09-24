//! The state of the whole sky from one place at one instant (`sky_state`) and sampled
//! tracks (`sample_bodies`).
//!
//! OWNER: events agent. CONVENTIONS 13.2 and 13.4; wire format in EXPLORER_API.md.
//!
//! Everything here is generic over [`BodyEphemeris`], so it runs on the real
//! [`skyfix_ephemeris::body::Sky`] and on synthetic providers in tests alike. A body a
//! provider cannot answer for (outside its coverage, or a provider that is not
//! implemented) is reported in `errors` and left out of the result: nothing here ever
//! invents a position.
//!
//! Two altitude families appear side by side and are never mixed (CONVENTIONS 13.2):
//!
//! - `alt_deg` / `az_deg` / `alt_apparent_deg`: topocentric, WGS84 site, parallax
//!   applied, from [`skyfix_ephemeris::topocentric::horizontal`] — what the sky looks
//!   like from the place;
//! - `hc_deg` / `zn_deg`: CONVENTIONS section 3 on the geocentric GHA/Dec, from
//!   [`skyfix_core::geometry::altitude_azimuth`] — what a navigator's tables give.

pub(crate) mod track;

use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{Point, altitude_azimuth};
use skyfix_core::time::format_utc;
use skyfix_core::types::LatLon;
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{self, ApparentState, BodyEphemeris, BodyKind, SUN, Sky};
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::topocentric::{Horizontal, Site, horizontal};

use track::Track;

// ---------------------------------------------------------------------------
// Thresholds (CONVENTIONS 13.3 and 13.4)
// ---------------------------------------------------------------------------

/// The Sun's standard rise/set altitude of its centre: -50' (34' refraction + 16'
/// semidiameter), degrees.
pub const SUN_RISE_SET_DEG: f64 = -50.0 / 60.0;
/// Standard horizon refraction, arcminutes: `h0 = -34'` for planets and stars, and
/// `-34' - SD` for the Moon.
pub const HORIZON_REFRACTION_ARCMIN: f64 = 34.0;
/// Civil, nautical and astronomical twilight: the Sun's centre at these altitudes.
pub const CIVIL_TWILIGHT_DEG: f64 = -6.0;
pub const NAUTICAL_TWILIGHT_DEG: f64 = -12.0;
pub const ASTRONOMICAL_TWILIGHT_DEG: f64 = -18.0;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why an almanac call could not produce a result at all.
///
/// A body that merely cannot be computed is not an error of the call: it goes into
/// the result's `errors` list. These are the cases where the whole answer is
/// impossible.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AlmanacError {
    /// Malformed input: out-of-range numbers, an empty or reversed window, too many
    /// samples. The caller must change the request.
    #[error("{0}")]
    Invalid(String),
    /// A body the answer cannot do without could not be computed: the Sun, which
    /// defines `sun_altitude_deg`, `sky_phase` and the day's `phases`; or the body a
    /// single-body call is about.
    #[error("{body}: {message}")]
    Unavailable { body: String, message: String },
}

impl AlmanacError {
    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        AlmanacError::Invalid(msg.into())
    }
}

/// A body that was requested but could not be computed, with the provider's reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyError {
    pub body: String,
    pub message: String,
}

impl From<BodyError> for AlmanacError {
    fn from(e: BodyError) -> Self {
        AlmanacError::Unavailable {
            body: e.body,
            message: e.message,
        }
    }
}

// ---------------------------------------------------------------------------
// Sky phases (CONVENTIONS 13.4)
// ---------------------------------------------------------------------------

/// The sky's brightness band, from the Sun's topocentric geometric altitude.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkyPhase {
    Day,
    Civil,
    Nautical,
    Astronomical,
    Night,
}

/// CONVENTIONS 13.4: `day` when `h > -50'`; `civil` when `-6 < h <= -50'`; `nautical`
/// when `-12 < h <= -6`; `astronomical` when `-18 < h <= -12`; `night` when
/// `h <= -18` degrees. `h` is the Sun's `alt_deg`.
pub fn sky_phase(sun_alt_deg: f64) -> SkyPhase {
    if sun_alt_deg > SUN_RISE_SET_DEG {
        SkyPhase::Day
    } else if sun_alt_deg > CIVIL_TWILIGHT_DEG {
        SkyPhase::Civil
    } else if sun_alt_deg > NAUTICAL_TWILIGHT_DEG {
        SkyPhase::Nautical
    } else if sun_alt_deg > ASTRONOMICAL_TWILIGHT_DEG {
        SkyPhase::Astronomical
    } else {
        SkyPhase::Night
    }
}

// ---------------------------------------------------------------------------
// Bodies: the registry as the explorer sees it, and name resolution
// ---------------------------------------------------------------------------

/// One entry of `explorer_bodies`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyInfo {
    pub body: String,
    pub kind: BodyKind,
    /// CONVENTIONS 13.1: Sun, Moon, Venus, Mars, Jupiter, Saturn and the 58 stars.
    pub navigational: bool,
    /// Catalogue magnitude for stars; `None` otherwise.
    pub magnitude: Option<f64>,
}

/// Every body the explorer knows, in registry order: Sun, Moon, Mercury ... Neptune,
/// then the stars in catalogue order.
pub fn body_catalogue() -> Vec<BodyInfo> {
    Sky::new()
        .bodies()
        .into_iter()
        .map(|name| {
            let kind = body::kind(name).unwrap_or(BodyKind::Star);
            BodyInfo {
                body: name.to_string(),
                kind,
                navigational: body::is_navigational(name),
                magnitude: match kind {
                    BodyKind::Star => catalog::find(name).map(|s| s.magnitude),
                    _ => None,
                },
            }
        })
        .collect()
}

/// The named body groups of EXPLORER_API.md ("Body lists"), case-insensitive:
/// `all` (Sun, Moon, Mercury ... Neptune, the stars), `solar_system` (Sun, Moon,
/// Mercury ... Neptune) and `navigational` (Sun, Moon, Venus, Mars, Jupiter, Saturn,
/// the stars). `None` for any other name.
pub fn body_group(name: &str) -> Option<Vec<&'static str>> {
    let all = Sky::new().bodies();
    match name.trim().to_ascii_lowercase().as_str() {
        "all" => Some(all),
        "solar_system" => Some(
            all.into_iter()
                .filter(|b| !matches!(body::kind(b), Some(BodyKind::Star)))
                .collect(),
        ),
        "navigational" => Some(
            all.into_iter()
                .filter(|b| body::is_navigational(b))
                .collect(),
        ),
        _ => None,
    }
}

/// Canonical spellings for a list of names (trimmed, case-insensitive; stars also by
/// `"HIP <n>"`), in the order given, without duplicates. An unknown name is an error
/// of the request, not a body error.
pub fn resolve_bodies<S: AsRef<str>>(names: &[S]) -> Result<Vec<&'static str>, AlmanacError> {
    let mut out: Vec<&'static str> = Vec::with_capacity(names.len());
    for n in names {
        let c = body::canonical(n.as_ref()).ok_or_else(|| {
            AlmanacError::invalid(format!(
                "unknown body {:?}: expected Sun, Moon, a planet (Mercury ... Neptune) or \
                 one of the navigational stars",
                n.as_ref()
            ))
        })?;
        if !out.contains(&c) {
            out.push(c);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/// Check an observing site and normalise its longitude to `(-180, 180]`.
///
/// Latitude `[-90, 90]`; height above the ellipsoid within -1 km .. 100 km; pressure
/// `0 ..= 2000` hPa (0 turns refraction off); temperature above absolute zero and
/// below 100 C. Everything must be finite.
pub fn checked_site(site: &Site) -> Result<Site, AlmanacError> {
    let finite = [
        ("lat_deg", site.lat_deg),
        ("lon_deg", site.lon_deg),
        ("height_m", site.height_m),
        ("pressure_hpa", site.pressure_hpa),
        ("temperature_c", site.temperature_c),
    ];
    for (name, v) in finite {
        if !v.is_finite() {
            return Err(AlmanacError::invalid(format!(
                "observer {name} must be a finite number, got {v}"
            )));
        }
    }
    if !(-90.0..=90.0).contains(&site.lat_deg) {
        return Err(AlmanacError::invalid(format!(
            "observer lat_deg {} is outside [-90, 90]",
            site.lat_deg
        )));
    }
    if !(-1000.0..=100_000.0).contains(&site.height_m) {
        return Err(AlmanacError::invalid(format!(
            "observer height_m {} is outside -1000 .. 100000 m (height above the WGS84 \
             ellipsoid, not the height of eye)",
            site.height_m
        )));
    }
    if !(0.0..=2000.0).contains(&site.pressure_hpa) {
        return Err(AlmanacError::invalid(format!(
            "observer pressure_hpa {} is outside 0 .. 2000",
            site.pressure_hpa
        )));
    }
    if !(site.temperature_c > -273.15 && site.temperature_c < 100.0) {
        return Err(AlmanacError::invalid(format!(
            "observer temperature_c {} is outside -273.15 .. 100",
            site.temperature_c
        )));
    }
    // Only wrap a longitude that needs it: `norm_180` goes through [0, 360) and would
    // perturb the last bits of an in-range west longitude.
    let lon_deg = if site.lon_deg > -180.0 && site.lon_deg <= 180.0 {
        site.lon_deg
    } else {
        norm_180(site.lon_deg)
    };
    Ok(Site { lon_deg, ..*site })
}

pub(crate) fn check_jd(name: &str, jd: f64) -> Result<(), AlmanacError> {
    if jd.is_finite() {
        Ok(())
    } else {
        Err(AlmanacError::invalid(format!(
            "{name} must be a finite Julian date, got {jd}"
        )))
    }
}

// ---------------------------------------------------------------------------
// sky_state
// ---------------------------------------------------------------------------

/// One body as seen from the observer at one instant (EXPLORER_API.md `BodyState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyState {
    pub body: String,
    pub kind: BodyKind,
    /// Apparent geocentric of date (CONVENTIONS section 7), `[0, 360)`.
    pub gha_deg: f64,
    pub dec_deg: f64,
    pub sha_deg: f64,
    pub ra_deg: f64,
    /// Ground point: latitude = Dec, longitude = -GHA in `(-180, 180]`.
    pub gp: LatLon,
    /// Topocentric geometric altitude of the centre (CONVENTIONS 13.2).
    pub alt_deg: f64,
    pub az_deg: f64,
    /// `alt_deg` plus display refraction.
    pub alt_apparent_deg: f64,
    /// CONVENTIONS section 3 from `gha_deg`/`dec_deg` (geocentric, no parallax).
    pub hc_deg: f64,
    pub zn_deg: f64,
    /// Upper limb above the sea-level horizon: `alt_apparent_deg + SD > 0`.
    pub above_horizon: bool,
    pub distance_km: Option<f64>,
    pub semidiameter_arcmin: f64,
    pub horizontal_parallax_arcmin: f64,
    pub magnitude: Option<f64>,
    pub phase_angle_deg: Option<f64>,
    pub illuminated_fraction: Option<f64>,
    pub elongation_deg: Option<f64>,
    pub bright_limb_angle_deg: Option<f64>,
    pub parallactic_angle_deg: f64,
    /// IAU abbreviation from `skyfix-starfield`; always `None` in this crate, which
    /// must not depend on the star field (CONVENTIONS 13.6). The WASM layer fills it.
    pub constellation: Option<String>,
}

/// The whole sky at one instant (EXPLORER_API.md `SkyState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkyState {
    pub jd_utc: f64,
    pub utc: String,
    /// GHA of Aries (GAST) consistent with every GHA in `bodies`: taken from the Sun's
    /// state as `GHA + RA`, so it carries the provider's own DUT1 (0 for the explorer).
    pub gha_aries_deg: f64,
    /// The Sun's topocentric geometric altitude, `alt_deg`.
    pub sun_altitude_deg: f64,
    pub sky_phase: SkyPhase,
    pub bodies: Vec<BodyState>,
    pub errors: Vec<BodyError>,
}

/// Build a [`BodyState`] from a provider state and its topocentric view.
pub fn body_state(st: &ApparentState, h: &Horizontal, site: &Site) -> BodyState {
    let (hc, zn) = altitude_azimuth(
        Point::from_deg(site.lat_deg, site.lon_deg),
        st.gha_deg.to_radians(),
        st.dec_deg.to_radians(),
    );
    BodyState {
        body: st.body.clone(),
        kind: st.kind,
        gha_deg: st.gha_deg,
        dec_deg: st.dec_deg,
        sha_deg: st.sha_deg(),
        ra_deg: st.ra_deg,
        gp: LatLon {
            lat_deg: st.dec_deg,
            lon_deg: norm_180(-st.gha_deg),
        },
        alt_deg: h.alt_deg,
        az_deg: h.az_deg,
        alt_apparent_deg: h.alt_apparent_deg,
        hc_deg: hc.to_degrees(),
        zn_deg: norm_360(zn.to_degrees()),
        above_horizon: h.alt_apparent_deg + st.semidiameter_arcmin / 60.0 > 0.0,
        distance_km: st.distance_km,
        semidiameter_arcmin: st.semidiameter_arcmin,
        horizontal_parallax_arcmin: st.horizontal_parallax_arcmin,
        magnitude: st.magnitude,
        phase_angle_deg: st.phase_angle_deg,
        illuminated_fraction: st.illuminated_fraction,
        elongation_deg: st.elongation_deg,
        bright_limb_angle_deg: st.bright_limb_angle_deg,
        parallactic_angle_deg: h.parallactic_angle_deg,
        constellation: None,
    }
}

/// The state of every requested body from `site` at `jd_utc` (EXPLORER_API.md
/// `sky_state`).
///
/// `bodies` are names the provider knows (resolve them with [`resolve_bodies`]
/// first); a body the provider fails on goes into `errors`. The Sun is always
/// computed, whether requested or not, because `sun_altitude_deg` and `sky_phase`
/// are defined by it: if the Sun itself cannot be computed (outside its coverage) the
/// call fails with [`AlmanacError::Unavailable`].
pub fn sky_state(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_utc: f64,
    bodies: &[&str],
) -> Result<SkyState, AlmanacError> {
    check_jd("jd_utc", jd_utc)?;
    let site = checked_site(site)?;
    let sun = eph
        .apparent_state(SUN, jd_utc)
        .map_err(|e| AlmanacError::Unavailable {
            body: SUN.to_string(),
            message: format!(
                "{e}; the Sun defines sun_altitude_deg and sky_phase, so the sky state \
                 cannot be computed at this instant"
            ),
        })?;
    let sun_h = horizontal(&sun, &site);
    let mut out = SkyState {
        jd_utc,
        utc: format_utc(jd_utc),
        gha_aries_deg: norm_360(sun.gha_deg + sun.ra_deg),
        sun_altitude_deg: sun_h.alt_deg,
        sky_phase: sky_phase(sun_h.alt_deg),
        bodies: Vec::with_capacity(bodies.len()),
        errors: Vec::new(),
    };
    for &name in bodies {
        let st = if name == SUN {
            Ok(sun.clone())
        } else {
            eph.apparent_state(name, jd_utc)
        };
        match st {
            Ok(st) => {
                let h = if name == SUN {
                    sun_h
                } else {
                    horizontal(&st, &site)
                };
                out.bodies.push(body_state(&st, &h, &site));
            }
            Err(e) => out.errors.push(BodyError {
                body: name.to_string(),
                message: e.to_string(),
            }),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// sample_bodies
// ---------------------------------------------------------------------------

/// Largest number of samples `sample_bodies` returns per body (EXPLORER_API.md).
pub const MAX_SAMPLES: usize = 20_000;

/// One body's samples; every array has one entry per `Sampled::jd_utc`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SampledBody {
    pub body: String,
    pub alt_deg: Vec<f64>,
    pub alt_apparent_deg: Vec<f64>,
    pub az_deg: Vec<f64>,
    pub gha_deg: Vec<f64>,
    pub dec_deg: Vec<f64>,
}

/// `sample_bodies` result. The WASM layer turns the vectors into `Float64Array`s.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sampled {
    pub jd_utc: Vec<f64>,
    pub bodies: Vec<SampledBody>,
    pub errors: Vec<BodyError>,
}

/// Instants `jd_start + k * step` for `k = 0, 1, ...` while not after `jd_end`.
fn sample_times(jd_start: f64, jd_end: f64, step_minutes: f64) -> Result<Vec<f64>, AlmanacError> {
    check_jd("jd_start", jd_start)?;
    check_jd("jd_end", jd_end)?;
    if jd_end < jd_start {
        return Err(AlmanacError::invalid(format!(
            "jd_end {jd_end} is before jd_start {jd_start}"
        )));
    }
    if !(step_minutes.is_finite() && step_minutes > 0.0) {
        return Err(AlmanacError::invalid(format!(
            "step_minutes must be a positive number, got {step_minutes}"
        )));
    }
    let step = step_minutes / 1440.0;
    // The 1e-9 absorbs rounding when the span is an exact multiple of the step.
    let count = ((jd_end - jd_start) / step + 1e-9).floor() + 1.0;
    if count > MAX_SAMPLES as f64 {
        return Err(AlmanacError::invalid(format!(
            "{count} samples requested; at most {MAX_SAMPLES} per body (widen \
             step_minutes or shorten the window)"
        )));
    }
    Ok((0..count as usize)
        .map(|k| jd_start + k as f64 * step)
        .collect())
}

/// Sample each body's position from `site` every `step_minutes` over
/// `[jd_start, jd_end]` (EXPLORER_API.md `sample_bodies`): for map paths and charts.
///
/// Values come from a [`track::Track`]: the provider is evaluated exactly at nodes no
/// more than 3 hours apart for the Moon, 4 for the planets and 8 for the Sun and stars,
/// and interpolated in between (under 0.01" of error, measured in
/// `tests/track_interpolation.rs`), which makes a day of one-minute samples cost a few
/// exact evaluations instead of 1440. The topocentric step is exact at every sample.
/// Short requests (no more samples than a Moon track would need nodes) are evaluated
/// exactly.
pub fn sample_bodies(
    eph: &dyn BodyEphemeris,
    site: &Site,
    bodies: &[&str],
    jd_start: f64,
    jd_end: f64,
    step_minutes: f64,
) -> Result<Sampled, AlmanacError> {
    let site = checked_site(site)?;
    let times = sample_times(jd_start, jd_end, step_minutes)?;
    let mut out = Sampled {
        jd_utc: times.clone(),
        bodies: Vec::with_capacity(bodies.len()),
        errors: Vec::new(),
    };
    let first = times[0];
    let last = *times.last().unwrap_or(&first);
    let nodes_needed = ((last - first) / track::MOON_NODE_SPACING_DAYS).ceil() as usize + 4;
    let use_tracks = times.len() > 2 * nodes_needed && last > first;

    let empty = |name: &str| SampledBody {
        body: name.to_string(),
        alt_deg: Vec::with_capacity(times.len()),
        alt_apparent_deg: Vec::with_capacity(times.len()),
        az_deg: Vec::with_capacity(times.len()),
        gha_deg: Vec::with_capacity(times.len()),
        dec_deg: Vec::with_capacity(times.len()),
    };
    let push = |s: &mut SampledBody, st: &ApparentState, h: &Horizontal| {
        s.alt_deg.push(h.alt_deg);
        s.alt_apparent_deg.push(h.alt_apparent_deg);
        s.az_deg.push(h.az_deg);
        s.gha_deg.push(st.gha_deg);
        s.dec_deg.push(st.dec_deg);
    };

    if use_tracks {
        for (name, track) in bodies
            .iter()
            .zip(Track::build_many(eph, bodies, first, last))
        {
            match track {
                Ok(track) => {
                    let mut s = empty(name);
                    let mut scratch = track.template().clone();
                    for &t in &times {
                        track.fill(t, &mut scratch);
                        let h = horizontal(&scratch, &site);
                        push(&mut s, &scratch, &h);
                    }
                    out.bodies.push(s);
                }
                Err(e) => out.errors.push(e),
            }
        }
    } else {
        // Instant by instant, so providers that share work across bodies can.
        let mut rows: Vec<Result<SampledBody, BodyError>> =
            bodies.iter().map(|b| Ok(empty(b))).collect();
        for &t in &times {
            for (name, row) in bodies.iter().zip(rows.iter_mut()) {
                let Ok(s) = row else { continue };
                match eph.apparent_state(name, t) {
                    Ok(st) => {
                        let h = horizontal(&st, &site);
                        push(s, &st, &h);
                    }
                    Err(e) => {
                        *row = Err(BodyError {
                            body: (*name).to_string(),
                            message: e.to_string(),
                        })
                    }
                }
            }
        }
        for row in rows {
            match row {
                Ok(s) => out.bodies.push(s),
                Err(e) => out.errors.push(e),
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sky_phase_bands_follow_conventions_13_4() {
        assert_eq!(sky_phase(10.0), SkyPhase::Day);
        assert_eq!(sky_phase(-0.8), SkyPhase::Day);
        assert_eq!(sky_phase(SUN_RISE_SET_DEG), SkyPhase::Civil);
        assert_eq!(sky_phase(-5.999), SkyPhase::Civil);
        assert_eq!(sky_phase(-6.0), SkyPhase::Nautical);
        assert_eq!(sky_phase(-12.0), SkyPhase::Astronomical);
        assert_eq!(sky_phase(-17.99), SkyPhase::Astronomical);
        assert_eq!(sky_phase(-18.0), SkyPhase::Night);
        assert_eq!(sky_phase(-90.0), SkyPhase::Night);
    }

    #[test]
    fn groups_have_the_documented_members() {
        let all = body_group("all").unwrap();
        assert_eq!(all.len(), 2 + 7 + 58);
        assert_eq!(&all[..3], &["Sun", "Moon", "Mercury"]);
        let ss = body_group(" Solar_System ").unwrap();
        assert_eq!(
            ss,
            vec![
                "Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"
            ]
        );
        let nav = body_group("navigational").unwrap();
        assert_eq!(nav.len(), 2 + 4 + 58);
        assert!(!nav.contains(&"Mercury") && !nav.contains(&"Neptune"));
        assert!(body_group("stars").is_none());
    }

    #[test]
    fn names_resolve_to_canonical_spellings_once() {
        let v = resolve_bodies(&[" sun", "VEGA", "hip 91262", "al nair", "Moon"]).unwrap();
        assert_eq!(v, vec!["Sun", "Vega", "Al Na'ir", "Moon"]);
        let e = resolve_bodies(&["Vulcan"]).unwrap_err();
        assert!(e.to_string().contains("Vulcan"), "{e}");
    }

    #[test]
    fn the_catalogue_marks_navigational_bodies_and_star_magnitudes() {
        let c = body_catalogue();
        assert_eq!(c.len(), 67);
        let get = |n: &str| c.iter().find(|b| b.body == n).unwrap();
        assert!(get("Moon").navigational && get("Moon").magnitude.is_none());
        assert!(!get("Uranus").navigational);
        assert_eq!(get("Venus").kind, BodyKind::Planet);
        let sirius = get("Sirius");
        assert!(sirius.navigational && sirius.kind == BodyKind::Star);
        assert!((sirius.magnitude.unwrap() + 1.44).abs() < 0.1);
    }

    #[test]
    fn sites_are_checked_and_longitude_normalised() {
        let ok = checked_site(&Site::new(10.0, 190.0)).unwrap();
        assert_eq!(ok.lon_deg, -170.0);
        assert!(checked_site(&Site::new(91.0, 0.0)).is_err());
        assert!(checked_site(&Site::new(f64::NAN, 0.0)).is_err());
        let hot = Site {
            temperature_c: -300.0,
            ..Site::new(0.0, 0.0)
        };
        assert!(checked_site(&hot).is_err());
    }

    #[test]
    fn sample_times_include_the_end_when_it_is_on_the_grid() {
        let t = sample_times(100.0, 101.0, 60.0).unwrap();
        assert_eq!(t.len(), 25);
        assert!((t[24] - 101.0).abs() < 1e-9);
        assert_eq!(sample_times(5.0, 5.0, 1.0).unwrap(), vec![5.0]);
        assert!(sample_times(0.0, 20.0, 1.0).is_err(), "28 801 samples");
        assert!(sample_times(1.0, 0.0, 1.0).is_err());
        assert!(sample_times(0.0, 1.0, 0.0).is_err());
    }
}
