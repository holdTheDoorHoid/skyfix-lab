//! The Earth's perihelion and aphelion: the instants its centre is nearest to and
//! farthest from the Sun's in a calendar year.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.12; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail".
//!
//! The distance is the heliocentric radius vector of the Earth's centre (not of the
//! Earth-Moon barycentre) from the Sun provider's VSOP87D series (the one that also
//! sizes the Sun's disc), geometric. The Moon swings the Earth about the barycentre by
//! 4,700 km, which moves these instants by up to a day and a half from the barycentre's
//! smooth ones (Meeus chapter 38): that is why the date of perihelion wanders between
//! January 1 and 5. The minimum is flat (the distance changes by 740 km a day squared
//! there), so a 1e-8 au wobble of the series moves it by a minute: the planet
//! provider's VSOP87A Earth, truncated more deeply, put it up to 5 minutes from DE440s,
//! the Sun's series 1 minute. The distance is sampled daily from 10 days before the year
//! to 10 days after it and every local extremum is refined with Brent's method.

use serde::{Deserialize, Serialize};
use skyfix_core::time::{civil_to_jd, format_utc};
use skyfix_ephemeris::sun::SunProvider;

use crate::eclipses::cheb::minimise;
use crate::planet_geometry::{sun_planet_coverage, unavailable};
use crate::sky::AlmanacError;

const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApsisKind {
    Perihelion,
    Aphelion,
}

/// One passage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApsisEvent {
    pub kind: ApsisKind,
    pub jd_utc: f64,
    pub utc: String,
    /// Earth-Sun distance at that instant.
    pub distance_au: f64,
    pub distance_km: f64,
}

/// `earth_apsides` result (EXPLORER_API.md `EarthApsides`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EarthApsides {
    pub year: i32,
    /// In time order: normally one perihelion (early January) and one aphelion (early
    /// July).
    pub events: Vec<ApsisEvent>,
}

fn distance_au(jd_utc: f64) -> Result<f64, AlmanacError> {
    SunProvider::new()
        .position(jd_utc)
        .map(|p| p.radius_au)
        .map_err(|e| unavailable("Sun", e))
}

/// The Earth's perihelion and aphelion in calendar `year` (UTC).
pub fn earth_apsides(year: i32) -> Result<EarthApsides, AlmanacError> {
    let (lo, hi) = sun_planet_coverage();
    let (a, b) = (civil_to_jd(year, 1, 1), civil_to_jd(year + 1, 1, 1));
    if a < lo || b > hi + 1.0 {
        return Err(AlmanacError::Invalid(format!(
            "earth_apsides: {year} is outside the coverage ({} .. {})",
            format_utc(lo),
            format_utc(hi)
        )));
    }
    let (sa, sb) = ((a - 10.0).max(lo), (b + 10.0).min(hi));
    let n = (sb - sa).ceil() as usize;
    let h = (sb - sa) / n as f64;
    let mut r = Vec::with_capacity(n + 1);
    for i in 0..=n {
        r.push(distance_au(sa + h * i as f64)?);
    }
    let mut events = Vec::new();
    let failure = std::cell::RefCell::new(None);
    let dist = |t: f64| match distance_au(t) {
        Ok(v) => v,
        Err(e) => {
            failure.borrow_mut().get_or_insert(e);
            f64::NAN
        }
    };
    for k in 1..n {
        let (p, q, s) = (r[k - 1], r[k], r[k + 1]);
        let kind = if q < p && q <= s {
            ApsisKind::Perihelion
        } else if q > p && q >= s {
            ApsisKind::Aphelion
        } else {
            continue;
        };
        let (t0, t1) = (sa + h * (k - 1) as f64, sa + h * (k + 1) as f64);
        let sign = if kind == ApsisKind::Perihelion {
            1.0
        } else {
            -1.0
        };
        let (t, v) = minimise(|t| sign * dist(t), t0, t1, 1e-6);
        if t >= a && t < b {
            let d = sign * v;
            events.push(ApsisEvent {
                kind,
                jd_utc: t,
                utc: format_utc(t),
                distance_au: d,
                distance_km: d * AU_KM,
            });
        }
    }
    if let Some(e) = failure.into_inner() {
        return Err(e);
    }
    events.sort_by(|x, y| x.jd_utc.total_cmp(&y.jd_utc));
    Ok(EarthApsides { year, events })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perihelion_in_early_january_aphelion_in_early_july() {
        let ap = earth_apsides(2026).unwrap();
        assert_eq!(ap.events.len(), 2, "{ap:?}");
        assert_eq!(ap.events[0].kind, ApsisKind::Perihelion);
        assert!(ap.events[0].utc.starts_with("2026-01-0"), "{ap:?}");
        assert!((0.9832..0.9834).contains(&ap.events[0].distance_au));
        assert_eq!(ap.events[1].kind, ApsisKind::Aphelion);
        assert!(ap.events[1].utc.starts_with("2026-07-0"), "{ap:?}");
        assert!(earth_apsides(1500).is_err());
    }
}
