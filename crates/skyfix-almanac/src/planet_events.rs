//! Planet events: oppositions, conjunctions with the Sun, greatest elongations of
//! Mercury and Venus, and each planet's closest approach to the Earth.
//!
//! OWNER: eclipse agent (sky events). CONVENTIONS 13.5 extended to the planets; wire
//! format in `docs/EXPLORER_API.md`, "Wave 2 — planet events"; accuracy in
//! `docs/ACCURACY.md`, "Planet events".
//!
//! # Definitions
//!
//! All from the apparent geocentric places of `skyfix_ephemeris::planets` (CONVENTIONS
//! section 7), the planet and the Sun taken from the same evaluation:
//!
//! - **Conjunction** and **opposition**: the planet's apparent geocentric ecliptic
//!   longitude minus the Sun's (ecliptic and equinox of date) is 0 or 180 degrees, as
//!   for the Moon's phases (13.5) and as the *Astronomical Almanac* defines them.
//!   Mercury and Venus have **inferior** conjunctions (between the Earth and the Sun:
//!   phase angle over 90 degrees) and **superior** ones (beyond the Sun); the outer
//!   planets have conjunctions and oppositions.
//! - **Greatest elongation** (Mercury and Venus): a local maximum of the elongation, the
//!   apparent angle between the planet and the Sun seen from the Earth's centre;
//!   **east** when the planet is east of the Sun in longitude (an evening star),
//!   **west** otherwise.
//! - **Closest approach** (perigee): a local minimum of the planet's geocentric
//!   distance, the light-time distance the provider reports.
//! - **Transit**: an inferior conjunction during which the planet's disc overlaps the
//!   Sun's as seen from the Earth's centre (the least separation near the conjunction
//!   is under the sum of the semidiameters, the Sun's 959.63" at 1 au).
//!
//! # Method
//!
//! Each planet is sampled on a grid (3 days for Mercury, 6 for Venus, 10 for Mars, 16
//! for the rest: finer than half the shortest interval between two events of the same
//! kind), every sign change of the longitude difference is refined by Brent's method to
//! 0.1 s, and every local extremum of the elongation or the distance by Brent's
//! minimiser to about a second. The window is clipped to the provider's coverage,
//! 1990-2060.

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_core::units::norm_180;
use skyfix_ephemeris::body::AU_KM;
use skyfix_ephemeris::frames::true_obliquity_rad;
use skyfix_ephemeris::planets::{Planet, PlanetPosition, PlanetProvider};
use skyfix_ephemeris::sun::{SUN_SEMIDIAMETER_UNIT_ARCSEC, SunProvider};

use crate::eclipses::cheb::{minimise, root};
use crate::events::ecliptic_longitude_deg;
use crate::sky::AlmanacError;

/// First and last instants covered: the planet provider's.
pub const COVERAGE_START_UTC: &str = "1990-01-01T00:00:00Z";
pub const COVERAGE_END_UTC: &str = "2060-12-31T23:59:59Z";

/// Roots to this, days (0.1 s).
const ROOT_TOL_DAYS: f64 = 1e-6;
/// Extrema to this, days (about a second; an extremum is flat, and its instant is
/// only as well defined as the ephemeris's rate).
const EXTREMUM_TOL_DAYS: f64 = 1e-5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanetEventKind {
    /// Outer planets: opposite the Sun, up all night, brightest around now.
    Opposition,
    /// Outer planets: behind the Sun, lost in its glare.
    Conjunction,
    /// Mercury and Venus: between the Earth and the Sun.
    InferiorConjunction,
    /// Mercury and Venus: beyond the Sun.
    SuperiorConjunction,
    /// Mercury and Venus: furthest east of the Sun, in the evening sky.
    GreatestElongationEast,
    /// Mercury and Venus: furthest west of the Sun, in the morning sky.
    GreatestElongationWest,
    /// Closest to the Earth.
    Perigee,
}

/// One planet event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanetEvent {
    pub kind: PlanetEventKind,
    /// Canonical name: `Mercury` .. `Neptune`.
    pub body: String,
    pub jd_utc: f64,
    pub utc: String,
    /// The apparent angle between the planet and the Sun at that instant, degrees.
    pub elongation_deg: f64,
    /// Geocentric (light-time) distance, astronomical units and kilometres.
    pub distance_au: f64,
    pub distance_km: f64,
    /// Apparent visual magnitude, when the provider models it for that geometry.
    pub magnitude: Option<f64>,
    /// Apparent geocentric right ascension and declination of date, degrees.
    pub ra_deg: f64,
    pub dec_deg: f64,
    /// Inferior conjunctions only: the planet crosses the Sun's disc (seen from the
    /// Earth's centre). Always false for other kinds.
    pub transit: bool,
}

/// Result of [`planet_events`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanetEventList {
    /// The window actually searched: the request clipped to the coverage.
    pub jd_start: f64,
    pub jd_end: f64,
    /// True when the request extended beyond the coverage.
    pub truncated: bool,
    pub coverage_start_utc: String,
    pub coverage_end_utc: String,
    /// Sorted by time.
    pub events: Vec<PlanetEvent>,
}

fn coverage() -> (f64, f64) {
    (
        civil_to_jd(1990, 1, 1),
        civil_to_jd(2060, 12, 31) + 86_399.0 / 86_400.0,
    )
}

fn inner(planet: Planet) -> bool {
    matches!(planet, Planet::Mercury | Planet::Venus)
}

/// Grid step, days: under half the shortest interval between two events of one kind.
fn step_days(planet: Planet) -> f64 {
    match planet {
        Planet::Mercury => 3.0,
        Planet::Venus => 6.0,
        Planet::Mars => 10.0,
        _ => 16.0,
    }
}

/// The quantities the finder follows.
#[derive(Debug, Clone, Copy)]
struct Sample {
    /// Planet minus Sun, apparent ecliptic longitude of date, `(-180, 180]` degrees.
    dlon: f64,
    elongation: f64,
    distance: f64,
}

fn sample(p: &PlanetPosition) -> Sample {
    let eps = true_obliquity_rad(p.jd_tt);
    let lp = ecliptic_longitude_deg(p.ra_deg, p.dec_deg, eps);
    let ls = ecliptic_longitude_deg(p.sun_ra_deg, p.sun_dec_deg, eps);
    Sample {
        dlon: norm_180(lp - ls),
        elongation: p.elongation_deg,
        distance: p.distance_au,
    }
}

struct Finder<'a> {
    provider: &'a PlanetProvider,
    sun: SunProvider,
    planet: Planet,
    /// Abscissa origin (a UTC Julian date): the finder works in days from it, never in
    /// raw Julian dates, whose `f64` resolution is 40 microseconds.
    t0: f64,
    lo: f64,
    hi: f64,
}

impl Finder<'_> {
    fn at(&self, x: f64) -> Result<PlanetPosition, AlmanacError> {
        self.provider
            .position(self.planet, self.t0 + x)
            .map_err(|e| AlmanacError::Unavailable {
                body: self.planet.name().to_string(),
                message: e.to_string(),
            })
    }

    /// A function of the abscissa that records the first provider error.
    fn quantity<'s>(
        &'s self,
        pick: impl Fn(Sample) -> f64 + 's,
        failure: &'s std::cell::RefCell<Option<AlmanacError>>,
    ) -> impl FnMut(f64) -> f64 + 's {
        move |x| match self.at(x) {
            Ok(p) => pick(sample(&p)),
            Err(e) => {
                failure.borrow_mut().get_or_insert(e);
                f64::NAN
            }
        }
    }

    fn event(&self, kind: PlanetEventKind, x: f64) -> Result<PlanetEvent, AlmanacError> {
        let p = self.at(x)?;
        let jd = self.t0 + x;
        let transit = if kind == PlanetEventKind::InferiorConjunction {
            self.transit(x, &p)?
        } else {
            false
        };
        Ok(PlanetEvent {
            kind,
            body: self.planet.name().to_string(),
            jd_utc: jd,
            utc: format_utc(jd),
            elongation_deg: p.elongation_deg,
            distance_au: p.distance_au,
            distance_km: p.distance_au * AU_KM,
            magnitude: p.magnitude,
            ra_deg: p.ra_deg,
            dec_deg: p.dec_deg,
            transit,
        })
    }

    /// Does the planet cross the Sun's disc near the inferior conjunction at `x`?
    fn transit(&self, x: f64, at_conj: &PlanetPosition) -> Result<bool, AlmanacError> {
        // A transit needs the planet within about a degree of the Sun at conjunction.
        if at_conj.elongation_deg > 1.0 {
            return Ok(false);
        }
        let failure = std::cell::RefCell::new(None);
        let sep = self.quantity(|s| s.elongation, &failure);
        let (a, b) = ((x - 1.0).max(self.lo), (x + 1.0).min(self.hi));
        let (xm, min_sep) = minimise(sep, a, b, EXTREMUM_TOL_DAYS);
        if let Some(e) = failure.into_inner() {
            return Err(e);
        }
        let p = self.at(xm)?;
        let sun = self
            .sun
            .position(self.t0 + xm)
            .map_err(|e| AlmanacError::Unavailable {
                body: "Sun".to_string(),
                message: e.to_string(),
            })?;
        let sd_sun_deg = SUN_SEMIDIAMETER_UNIT_ARCSEC / 3600.0 / sun.radius_au;
        Ok(min_sep < sd_sun_deg + p.semidiameter_arcmin / 60.0)
    }

    fn run(&self, from: f64, to: f64) -> Result<Vec<PlanetEvent>, AlmanacError> {
        let step = step_days(self.planet);
        // Grid from one step before the window to one after (inside the coverage), so
        // an event near either end is still bracketed.
        let (a, b) = ((from - step).max(self.lo), (to + step).min(self.hi));
        let n = ((b - a) / step).ceil().max(2.0) as usize;
        let h = (b - a) / n as f64;
        let xs: Vec<f64> = (0..=n).map(|k| a + h * k as f64).collect();
        let mut samples = Vec::with_capacity(xs.len());
        for &x in &xs {
            samples.push(sample(&self.at(x)?));
        }
        let failure = std::cell::RefCell::new(None);
        let mut found: Vec<(f64, PlanetEventKind)> = Vec::new();
        let inner = inner(self.planet);
        for k in 0..n {
            let (s0, s1) = (samples[k], samples[k + 1]);
            let (xa, xb) = (xs[k], xs[k + 1]);
            // Conjunction: the longitude difference through 0 (not through 180).
            if s0.dlon.abs() < 90.0 && s1.dlon.abs() < 90.0 && s0.dlon * s1.dlon <= 0.0 {
                let f = self.quantity(|s| s.dlon, &failure);
                if let Some(x) = root(f, xa, xb, ROOT_TOL_DAYS) {
                    let kind = if inner {
                        if self.at(x)?.phase_angle_deg > 90.0 {
                            PlanetEventKind::InferiorConjunction
                        } else {
                            PlanetEventKind::SuperiorConjunction
                        }
                    } else {
                        PlanetEventKind::Conjunction
                    };
                    found.push((x, kind));
                }
            }
            // Opposition: through 180.
            let (o0, o1) = (norm_180(s0.dlon - 180.0), norm_180(s1.dlon - 180.0));
            if !inner && o0.abs() < 90.0 && o1.abs() < 90.0 && o0 * o1 <= 0.0 {
                let f = self.quantity(|s| norm_180(s.dlon - 180.0), &failure);
                if let Some(x) = root(f, xa, xb, ROOT_TOL_DAYS) {
                    found.push((x, PlanetEventKind::Opposition));
                }
            }
        }
        for k in 1..n {
            let (sp, s, sn) = (samples[k - 1], samples[k], samples[k + 1]);
            let (xa, xb) = (xs[k - 1], xs[k + 1]);
            if inner && s.elongation > sp.elongation && s.elongation >= sn.elongation {
                let f = self.quantity(|s| -s.elongation, &failure);
                let (x, _) = minimise(f, xa, xb, EXTREMUM_TOL_DAYS);
                let east = self.at(x).map(|p| sample(&p).dlon > 0.0)?;
                found.push((
                    x,
                    if east {
                        PlanetEventKind::GreatestElongationEast
                    } else {
                        PlanetEventKind::GreatestElongationWest
                    },
                ));
            }
            if s.distance < sp.distance && s.distance <= sn.distance {
                let f = self.quantity(|s| s.distance, &failure);
                let (x, _) = minimise(f, xa, xb, EXTREMUM_TOL_DAYS);
                found.push((x, PlanetEventKind::Perigee));
            }
        }
        if let Some(e) = failure.into_inner() {
            return Err(e);
        }
        let mut out = Vec::new();
        for (x, kind) in found {
            if x >= from && x <= to {
                out.push(self.event(kind, x)?);
            }
        }
        Ok(out)
    }
}

/// Every opposition, conjunction with the Sun, greatest elongation and closest
/// approach of Mercury to Neptune in `[jd_start, jd_end]` (UTC Julian dates), in time
/// order. The window is clipped to the coverage (1990-2060).
pub fn planet_events(
    provider: &PlanetProvider,
    jd_start: f64,
    jd_end: f64,
) -> Result<PlanetEventList, AlmanacError> {
    if !jd_start.is_finite() || !jd_end.is_finite() || jd_end < jd_start {
        return Err(AlmanacError::Invalid(format!(
            "planet events need a finite window with jd_end >= jd_start (got {jd_start}, {jd_end})"
        )));
    }
    let (lo, hi) = coverage();
    let (a, b) = (jd_start.max(lo), jd_end.min(hi));
    let truncated = a > jd_start || b < jd_end;
    let mut events = Vec::new();
    if a <= b {
        let sun = SunProvider::with_dut1_s(provider.dut1_s());
        for planet in Planet::ALL {
            let finder = Finder {
                provider,
                sun,
                planet,
                t0: a,
                lo: lo - a,
                hi: hi - a,
            };
            events.extend(finder.run(0.0, b - a)?);
        }
    }
    events.sort_by(|x, y| x.jd_utc.total_cmp(&y.jd_utc));
    Ok(PlanetEventList {
        jd_start: a,
        jd_end: b,
        truncated,
        coverage_start_utc: COVERAGE_START_UTC.to_string(),
        coverage_end_utc: COVERAGE_END_UTC.to_string(),
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_year_of_events_has_the_expected_shape() {
        // 2024: Jupiter's conjunction (May 18) and opposition (Dec 7), Mars reaches
        // neither, Mercury four western and three eastern elongations, Venus a superior
        // conjunction (June 4).
        let list = planet_events(
            &PlanetProvider::new(),
            civil_to_jd(2024, 1, 1),
            civil_to_jd(2025, 1, 1),
        )
        .unwrap();
        assert!(!list.truncated);
        let count = |body: &str, kind: PlanetEventKind| {
            list.events
                .iter()
                .filter(|e| e.body == body && e.kind == kind)
                .count()
        };
        assert_eq!(count("Jupiter", PlanetEventKind::Opposition), 1);
        assert_eq!(count("Jupiter", PlanetEventKind::Conjunction), 1);
        assert_eq!(count("Mars", PlanetEventKind::Opposition), 0);
        assert_eq!(count("Venus", PlanetEventKind::SuperiorConjunction), 1);
        assert_eq!(count("Mercury", PlanetEventKind::GreatestElongationEast), 3);
        assert_eq!(count("Mercury", PlanetEventKind::GreatestElongationWest), 4);
        let jup = list
            .events
            .iter()
            .find(|e| e.body == "Jupiter" && e.kind == PlanetEventKind::Opposition)
            .unwrap();
        assert!(jup.utc.starts_with("2024-12-07"), "{}", jup.utc);
        assert!(jup.elongation_deg > 175.0);
        assert!(list.events.windows(2).all(|w| w[0].jd_utc <= w[1].jd_utc));
        for e in &list.events {
            if matches!(
                e.kind,
                PlanetEventKind::GreatestElongationEast | PlanetEventKind::GreatestElongationWest
            ) {
                let limit = if e.body == "Mercury" { 29.0 } else { 48.0 };
                assert!((17.0..limit).contains(&e.elongation_deg), "{e:?}");
            }
        }
    }

    #[test]
    fn windows_are_clipped_and_checked() {
        let p = PlanetProvider::new();
        assert!(planet_events(&p, f64::NAN, 2_460_000.5).is_err());
        assert!(planet_events(&p, 2_460_001.5, 2_460_000.5).is_err());
        let l = planet_events(&p, civil_to_jd(1980, 1, 1), civil_to_jd(1980, 2, 1)).unwrap();
        assert!(l.truncated && l.events.is_empty());
        let l = planet_events(&p, civil_to_jd(2060, 12, 1), civil_to_jd(2061, 6, 1)).unwrap();
        assert!(l.truncated);
    }

    #[test]
    fn the_transits_of_mercury_in_2016_and_2019() {
        let p = PlanetProvider::new();
        for (y, m, d) in [(2016, 5, 9), (2019, 11, 11)] {
            let jd = civil_to_jd(y, m, d);
            let list = planet_events(&p, jd - 2.0, jd + 2.0).unwrap();
            let conj = list
                .events
                .iter()
                .find(|e| e.kind == PlanetEventKind::InferiorConjunction)
                .unwrap();
            assert!(conj.transit, "{conj:?}");
        }
        // The inferior conjunction of 2024-04-11 passes 2.2 degrees from the Sun's
        // centre: no transit.
        let jd = civil_to_jd(2024, 4, 11);
        let list = planet_events(&p, jd - 3.0, jd + 3.0).unwrap();
        let conj = list
            .events
            .iter()
            .find(|e| e.kind == PlanetEventKind::InferiorConjunction)
            .unwrap();
        assert!(!conj.transit, "{conj:?}");
    }
}
