//! The galactic centre's dark-sky windows, for the Milky Way planner
//! (CONVENTIONS 13.10).
//!
//! The galactic centre is Sgr A*, RA 17h 45m 40.04s, Dec −29° 00′ 28.1″ (J2000); the
//! galactic equator's north pole is RA 12h 51m 26.28s, Dec +27° 07′ 42.0″ (J2000). Both
//! are carried to the true equator and equinox of date by the star field's chain
//! (`skyfix_ephemeris::frames::apparent_radec_of_date`: frame bias, IAU 2006 precession,
//! IAU 2000B nutation, annual aberration), then seen from the site like any star
//! (CONVENTIONS 13.2). Sgr A*'s proper motion (6 mas a year) is ignored.
//!
//! A window is a stretch of the request during which, all at once,
//!
//! - the galactic centre's **apparent** altitude is at least `min_altitude_deg`
//!   (default 10°);
//! - the Sun's **geometric** altitude is at most `sun_max_altitude_deg` (default −18°,
//!   astronomical night, CONVENTIONS 13.4);
//!
//! and windows are split where the Moon rises or sets (the event finder's rise and set,
//! CONVENTIONS 13.3), each saying whether the Moon is up and how much of it is lit. The
//! **best moment** of a window is when the galactic centre stands highest in it. There
//! the **arch** is described: the galactic equator is the great circle 90° from the
//! pole, so its highest point stands `90° − h` high in the azimuth opposite the pole
//! that is above the horizon (`h` that pole's altitude), and it meets the horizon 90°
//! either side of that pole's azimuth. These are geometric directions (a band 10–20°
//! wide has no sharper edge to refract).

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, jd_tt};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::norm_360;
use skyfix_ephemeris::body::{ApparentState, BodyEphemeris, BodyKind, MOON, SUN};
use skyfix_ephemeris::frames::apparent_radec_of_date;
use skyfix_ephemeris::sidereal::gha_aries_deg;
use skyfix_ephemeris::topocentric::{Site, horizontal};
use skyfix_ephemeris::{AstroProvider, Coverage, EphemerisError};

use super::{
    EXTREMUM_TOL_DAYS, Span, check_window, find_geometric_altitude, intersect, roots,
    scan_crossings, stretches,
};
use crate::events::{EventKind, EventOptions, day_events, standard_altitude_deg};
use crate::sky::track::Track;
use crate::sky::{AlmanacError, checked_site, sky_state};

/// Sgr A*, J2000 (Reid & Brunthaler 2004, rounded as CONVENTIONS 13.10 states it).
pub const GALACTIC_CENTRE_RA_J2000_DEG: f64 = (17.0 + 45.0 / 60.0 + 40.04 / 3600.0) * 15.0;
pub const GALACTIC_CENTRE_DEC_J2000_DEG: f64 = -(29.0 + 28.1 / 3600.0);
/// The north galactic pole, J2000.
pub const GALACTIC_POLE_RA_J2000_DEG: f64 = (12.0 + 51.0 / 60.0 + 26.28 / 3600.0) * 15.0;
pub const GALACTIC_POLE_DEC_J2000_DEG: f64 = 27.0 + 7.0 / 60.0 + 42.0 / 3600.0;
pub const DEFAULT_MIN_ALTITUDE_DEG: f64 = 10.0;
pub const DEFAULT_SUN_MAX_ALTITUDE_DEG: f64 = -18.0;

const GALACTIC_CENTRE: &str = "Galactic centre";
const GALACTIC_POLE: &str = "North galactic pole";

/// A direction fixed in the ICRS (J2000), seen as a star: apparent of date, no parallax.
/// It is also a one-body [`BodyEphemeris`], so the event finder's interpolated track
/// follows it exactly as it follows a catalogue star.
#[derive(Debug, Clone, Copy)]
pub struct FixedDirection {
    pub name: &'static str,
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
}

/// The galactic centre (Sgr A*).
pub const CENTRE: FixedDirection = FixedDirection {
    name: GALACTIC_CENTRE,
    ra_j2000_deg: GALACTIC_CENTRE_RA_J2000_DEG,
    dec_j2000_deg: GALACTIC_CENTRE_DEC_J2000_DEG,
};

/// The north galactic pole.
pub const POLE: FixedDirection = FixedDirection {
    name: GALACTIC_POLE,
    ra_j2000_deg: GALACTIC_POLE_RA_J2000_DEG,
    dec_j2000_deg: GALACTIC_POLE_DEC_J2000_DEG,
};

impl FixedDirection {
    /// Apparent place of date and GHA (DUT1 = 0, CONVENTIONS 6), as a star.
    pub fn state(&self, jd_utc: f64) -> ApparentState {
        let (ra, dec) = apparent_radec_of_date(
            self.ra_j2000_deg,
            self.dec_j2000_deg,
            0.0,
            0.0,
            0.0,
            jd_tt(jd_utc),
        );
        ApparentState {
            body: self.name.to_string(),
            kind: BodyKind::Star,
            jd_utc,
            ra_deg: ra,
            dec_deg: dec,
            gha_deg: norm_360(gha_aries_deg(jd_utc, 0.0) - ra),
            distance_km: None,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
            magnitude: None,
            phase_angle_deg: None,
            illuminated_fraction: None,
            elongation_deg: None,
            bright_limb_angle_deg: None,
        }
    }
}

impl AstroProvider for FixedDirection {
    fn name(&self) -> &str {
        self.name
    }

    fn coverage(&self) -> Coverage {
        Coverage {
            start_utc: String::new(),
            end_utc: String::new(),
            bodies: vec![self.name.to_string()],
            notes: "a fixed ICRS direction carried to the date by precession, nutation and \
                    aberration"
                .to_string(),
            accuracy_arcmin: 0.01,
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        Ok(self.apparent_state(body, jd_utc)?.direction())
    }
}

impl BodyEphemeris for FixedDirection {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        if body != self.name {
            return Err(EphemerisError::UnknownBody(
                body.to_string(),
                self.name.to_string(),
            ));
        }
        if !jd_utc.is_finite() {
            return Err(EphemerisError::Data(
                "jd_utc is not a finite Julian date".to_string(),
            ));
        }
        Ok(self.state(jd_utc))
    }
}

/// `galactic_centre_windows` options.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GalacticOptions {
    /// Lowest apparent altitude of the galactic centre, degrees (default 10).
    pub min_altitude_deg: Option<f64>,
    /// Highest geometric altitude of the Sun, degrees (default -18).
    pub sun_max_altitude_deg: Option<f64>,
}

/// Where the galactic centre and the Milky Way's arch are at one instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalacticMoment {
    pub jd_utc: f64,
    pub utc: String,
    /// The galactic centre: topocentric geometric altitude, apparent altitude, azimuth.
    pub alt_deg: f64,
    pub alt_apparent_deg: f64,
    pub az_deg: f64,
    /// The galactic equator's highest point above the horizon.
    pub arch_top_alt_deg: f64,
    pub arch_top_az_deg: f64,
    /// Where the galactic equator meets the horizon, degrees, the smaller first.
    pub arch_ends_az_deg: [f64; 2],
}

/// One dark-sky window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalacticWindow {
    pub jd_start: f64,
    pub utc_start: String,
    pub jd_end: f64,
    pub utc_end: String,
    pub duration_h: f64,
    /// The Moon is above the horizon (its rise/set altitude) throughout the window.
    pub moon_up: bool,
    /// The Moon's illuminated fraction at the window's middle, 0 to 1.
    pub moon_illuminated_fraction: f64,
    /// The galactic centre at its highest in the window.
    pub best: GalacticMoment,
}

/// A fixed direction, echoed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FixedPoint {
    pub ra_j2000_deg: f64,
    pub dec_j2000_deg: f64,
}

/// `galactic_centre_windows` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalacticCentreWindows {
    pub jd_start: f64,
    pub jd_end: f64,
    pub min_altitude_deg: f64,
    pub sun_max_altitude_deg: f64,
    pub galactic_centre: FixedPoint,
    pub galactic_pole: FixedPoint,
    /// Time-ordered.
    pub windows: Vec<GalacticWindow>,
}

/// The galactic centre and the arch at `jd_utc` from `site` (module docs).
pub fn galactic_moment(site: &Site, jd_utc: f64) -> GalacticMoment {
    let c = horizontal(&CENTRE.state(jd_utc), site);
    let p = horizontal(&POLE.state(jd_utc), site);
    // The pole above the horizon (the south galactic pole when the north one is down).
    let (h, a) = if p.alt_deg >= 0.0 {
        (p.alt_deg, p.az_deg)
    } else {
        (-p.alt_deg, norm_360(p.az_deg + 180.0))
    };
    let (e1, e2) = (norm_360(a - 90.0), norm_360(a + 90.0));
    GalacticMoment {
        jd_utc,
        utc: format_utc(jd_utc),
        alt_deg: c.alt_deg,
        alt_apparent_deg: c.alt_apparent_deg,
        az_deg: c.az_deg,
        arch_top_alt_deg: 90.0 - h,
        arch_top_az_deg: norm_360(a + 180.0),
        arch_ends_az_deg: [e1.min(e2), e1.max(e2)],
    }
}

/// Stretches of `[t0, t1]` during which `inside(mid)` holds, cut at `cuts`.
fn spans_where(
    t0: f64,
    t1: f64,
    mut cuts: Vec<f64>,
    mut inside: impl FnMut(f64) -> Result<bool, AlmanacError>,
) -> Result<Vec<Span>, AlmanacError> {
    let mut out: Vec<Span> = Vec::new();
    for s in stretches(t0, t1, &mut cuts) {
        if inside(0.5 * (s.jd_start + s.jd_end))? {
            match out.last_mut() {
                Some(last) if last.jd_end == s.jd_start => last.jd_end = s.jd_end,
                _ => out.push(s),
            }
        }
    }
    Ok(out)
}

/// Dark-sky windows for the galactic centre over `[jd_start, jd_end]` (at most 400 days;
/// the UI passes a night, noon to noon, or a month of them) (EXPLORER_API.md
/// `galactic_centre_windows`). Fails when the Sun or the Moon cannot be computed over
/// the window.
pub fn galactic_centre_windows(
    eph: &dyn BodyEphemeris,
    site: &Site,
    jd_start: f64,
    jd_end: f64,
    options: &GalacticOptions,
) -> Result<GalacticCentreWindows, AlmanacError> {
    let site = checked_site(site)?;
    check_window(jd_start, jd_end)?;
    let min_alt = options.min_altitude_deg.unwrap_or(DEFAULT_MIN_ALTITUDE_DEG);
    let sun_max = options
        .sun_max_altitude_deg
        .unwrap_or(DEFAULT_SUN_MAX_ALTITUDE_DEG);
    for (name, v, lo, hi) in [
        ("min_altitude_deg", min_alt, -5.0, 89.0),
        ("sun_max_altitude_deg", sun_max, -30.0, 0.0),
    ] {
        if !(v.is_finite() && (lo..=hi).contains(&v)) {
            return Err(AlmanacError::invalid(format!(
                "{name} must be between {lo} and {hi}, got {v}"
            )));
        }
    }

    // The Sun at or below its limit.
    let sun_cuts: Vec<f64> = find_geometric_altitude(eph, &site, SUN, jd_start, jd_end, sun_max)?
        .into_iter()
        .map(|c| c.jd_utc)
        .collect();
    let dark = spans_where(jd_start, jd_end, sun_cuts, |t| {
        Ok(super::sun_altitude_deg(eph, &site, t)? <= sun_max)
    })?;

    // The galactic centre at or above its limit, along the event finder's track.
    let track = Track::build_many(&CENTRE, &[GALACTIC_CENTRE], jd_start, jd_end)
        .pop()
        .expect("one track")?;
    let mut scratch = track.template().clone();
    let mut alt_app = |t: f64| {
        track.fill(t, &mut scratch);
        horizontal(&scratch, &site).alt_apparent_deg
    };
    let gc_cuts: Vec<f64> = scan_crossings(
        &mut |x: f64| alt_app(jd_start + x) - min_alt,
        jd_end - jd_start,
    )
    .into_iter()
    .map(|(x, _)| jd_start + x)
    .collect();
    let up = spans_where(jd_start, jd_end, gc_cuts, |t| Ok(alt_app(t) >= min_alt))?;

    let candidates = intersect(&dark, &up);
    if candidates.is_empty() {
        return Ok(result(jd_start, jd_end, min_alt, sun_max, Vec::new()));
    }

    // The Moon's rise and set over the window split the candidates.
    let de = day_events(
        eph,
        &site,
        jd_start,
        jd_end,
        &[MOON],
        &EventOptions::default(),
    )?;
    if let Some(e) = de.errors.into_iter().next() {
        return Err(e.into());
    }
    let moon_cuts: Vec<f64> = de
        .bodies
        .iter()
        .flat_map(|b| b.events.iter())
        .filter(|e| matches!(e.kind, EventKind::Rise | EventKind::Set))
        .map(|e| e.jd_utc)
        .collect();

    let mut windows = Vec::new();
    for c in candidates {
        let mut cuts = moon_cuts.clone();
        for piece in stretches(c.jd_start, c.jd_end, &mut cuts) {
            let mid = 0.5 * (piece.jd_start + piece.jd_end);
            let s = sky_state(eph, &site, mid, &[MOON])?;
            let Some(moon) = s.bodies.first() else {
                let e = s.errors.into_iter().next().map_or_else(
                    || AlmanacError::invalid("the Moon could not be computed"),
                    AlmanacError::from,
                );
                return Err(e);
            };
            let moon_up =
                moon.alt_deg >= standard_altitude_deg(BodyKind::Moon, moon.semidiameter_arcmin);
            // The highest moment: the ends, or the culmination between them.
            let (xm, neg) = roots::brent_min(
                |t| -alt_app(t),
                piece.jd_start,
                piece.jd_end,
                EXTREMUM_TOL_DAYS,
            );
            let best_t = [
                (piece.jd_start, alt_app(piece.jd_start)),
                (piece.jd_end, alt_app(piece.jd_end)),
            ]
            .into_iter()
            .fold((xm, -neg), |acc, c| if c.1 > acc.1 { c } else { acc })
            .0;
            windows.push(GalacticWindow {
                jd_start: piece.jd_start,
                utc_start: format_utc(piece.jd_start),
                jd_end: piece.jd_end,
                utc_end: format_utc(piece.jd_end),
                duration_h: (piece.jd_end - piece.jd_start) * 24.0,
                moon_up,
                moon_illuminated_fraction: moon.illuminated_fraction.unwrap_or(0.0),
                best: galactic_moment(&site, best_t),
            });
        }
    }
    Ok(result(jd_start, jd_end, min_alt, sun_max, windows))
}

fn result(
    jd_start: f64,
    jd_end: f64,
    min_alt: f64,
    sun_max: f64,
    windows: Vec<GalacticWindow>,
) -> GalacticCentreWindows {
    GalacticCentreWindows {
        jd_start,
        jd_end,
        min_altitude_deg: min_alt,
        sun_max_altitude_deg: sun_max,
        galactic_centre: FixedPoint {
            ra_j2000_deg: GALACTIC_CENTRE_RA_J2000_DEG,
            dec_j2000_deg: GALACTIC_CENTRE_DEC_J2000_DEG,
        },
        galactic_pole: FixedPoint {
            ra_j2000_deg: GALACTIC_POLE_RA_J2000_DEG,
            dec_j2000_deg: GALACTIC_POLE_DEC_J2000_DEG,
        },
        windows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constants_are_the_stated_coordinates() {
        assert!((GALACTIC_CENTRE_RA_J2000_DEG - 266.416_833).abs() < 1e-6);
        assert!((GALACTIC_CENTRE_DEC_J2000_DEG + 29.007_806).abs() < 1e-6);
        assert!((GALACTIC_POLE_RA_J2000_DEG - 192.859_5).abs() < 1e-6);
        assert!((GALACTIC_POLE_DEC_J2000_DEG - 27.128_333).abs() < 1e-6);
    }

    #[test]
    fn the_centre_lies_on_the_galactic_equator() {
        // 90 degrees from the pole, to the rounding of the published coordinates (the
        // IAU pole and Sgr A* differ by 0.07 degree from exact perpendicularity: Sgr A*
        // is not exactly at l = 0, b = 0).
        let u = |ra: f64, dec: f64| {
            let (sa, ca) = ra.to_radians().sin_cos();
            let (sd, cd) = dec.to_radians().sin_cos();
            [cd * ca, cd * sa, sd]
        };
        let c = u(GALACTIC_CENTRE_RA_J2000_DEG, GALACTIC_CENTRE_DEC_J2000_DEG);
        let p = u(GALACTIC_POLE_RA_J2000_DEG, GALACTIC_POLE_DEC_J2000_DEG);
        let dot: f64 = c.iter().zip(p).map(|(a, b)| a * b).sum();
        let sep = dot.acos().to_degrees();
        assert!((sep - 90.0).abs() < 0.1, "{sep}");
    }

    #[test]
    fn the_arch_is_perpendicular_to_the_pole() {
        let site = Site::new(-31.3, 149.1);
        let jd = skyfix_core::time::civil_to_jd(2026, 6, 15) + 0.55;
        let m = galactic_moment(&site, jd);
        assert!((0.0..=90.0).contains(&m.arch_top_alt_deg));
        let d = norm_360(m.arch_ends_az_deg[1] - m.arch_ends_az_deg[0]);
        assert!((d - 180.0).abs() < 1e-9, "{m:?}");
        // The top is halfway between the two ends.
        let mid = norm_360(m.arch_ends_az_deg[0] + 90.0);
        let off = (norm_360(m.arch_top_az_deg - mid + 180.0) - 180.0).abs();
        assert!(off < 1e-9 || (off - 180.0).abs() < 1e-9, "{m:?}");
    }
}
