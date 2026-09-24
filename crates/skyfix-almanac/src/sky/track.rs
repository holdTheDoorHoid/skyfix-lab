//! A body's apparent geocentric state over a window, interpolated between exact
//! evaluations of its provider.
//!
//! Event finding and sampled paths ask for a body's position hundreds of times per day
//! of window. The providers are exact but not cheap (the Sun alone is a 1020-term
//! VSOP87 series), so [`Track`] evaluates the provider at **nodes no more than 3 hours
//! apart for the Moon, 4 hours for the planets and 8 hours for the Sun and stars** and
//! interpolates between them with the 4-point Lagrange formula on the nodes around the
//! query instant. Only the slowly varying geocentric quantities are interpolated — GHA
//! (unwrapped), RA (unwrapped), declination, distance and semidiameter — and the
//! topocentric step (Earth rotation is inside GHA, parallax and refraction are applied
//! afterwards by `topocentric::horizontal`) is exact.
//!
//! Interpolation error of the cubic, `0.0234 f'''' h^4` in the middle interval and a
//! few times that at the window edges:
//!
//! - the Moon: the fourth derivative of its longitude is about 0.08 deg/day^4 (the
//!   largest periodic terms of the lunar theory), so 3-hour nodes give ~0.001";
//! - the planets: Mercury near inferior conjunction reverses its apparent motion
//!   within days (a few 1e-2 deg/day^4); 8-hour nodes measured 0.015" on it, 4-hour
//!   nodes a sixteenth of that;
//! - the Sun and stars: the fastest term is the 13.7-day nutation (0.23"), so 8-hour
//!   nodes give under 1e-4".
//!
//! `tests/track_interpolation.rs` measures it against exact evaluations of the real
//! providers and of a synthetic Moon (worst case under 0.01" for every body). 0.01" is
//! 0.0007 s of time at the horizon, so it never shows in an event time, nor in the
//! altitude and azimuth reported with it.

use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{ApparentState, BodyEphemeris};

use super::BodyError;

/// Largest spacing between exact evaluations of the Moon, days (3 hours).
pub(crate) const MOON_NODE_SPACING_DAYS: f64 = 3.0 / 24.0;
/// Largest spacing between exact evaluations of a planet, days (4 hours).
pub(crate) const PLANET_NODE_SPACING_DAYS: f64 = 4.0 / 24.0;
/// Largest spacing between exact evaluations of the Sun or a star, days (8 hours).
pub(crate) const NODE_SPACING_DAYS: f64 = 8.0 / 24.0;

/// Node spacing for `body`: the faster its apparent motion changes, the closer.
pub(crate) fn node_spacing_days(body: &str) -> f64 {
    use skyfix_ephemeris::body::BodyKind;
    match skyfix_ephemeris::body::kind(body) {
        Some(BodyKind::Moon) => MOON_NODE_SPACING_DAYS,
        Some(BodyKind::Planet) => PLANET_NODE_SPACING_DAYS,
        _ => NODE_SPACING_DAYS,
    }
}

/// One body's interpolated apparent geocentric state over `[t0, t1]`.
#[derive(Debug, Clone)]
pub(crate) struct Track {
    t0: f64,
    /// Node spacing, days.
    h: f64,
    /// Unwrapped GHA, degrees, one per node.
    gha: Vec<f64>,
    /// Unwrapped RA, degrees.
    ra: Vec<f64>,
    dec: Vec<f64>,
    /// Geocentric distance, km; empty for a body at infinity (stars).
    dist: Vec<f64>,
    sd: Vec<f64>,
    /// The state at the first node; fields that are not interpolated come from here.
    template: ApparentState,
}

/// Node instants for `[t0, t1]`: at least four, evenly spaced no more than `spacing`
/// apart, the last exactly `t1`.
fn node_times(t0: f64, t1: f64, spacing: f64) -> (Vec<f64>, f64) {
    let intervals = ((t1 - t0) / spacing).ceil().max(3.0) as usize;
    let h = (t1 - t0) / intervals as f64;
    let mut v: Vec<f64> = (0..intervals).map(|k| t0 + k as f64 * h).collect();
    v.push(t1);
    (v, h)
}

/// `prev + (x - prev)` with the difference wrapped into `(-180, 180]`.
fn unwrap(prev: f64, x: f64) -> f64 {
    prev + norm_180(x - prev)
}

/// 4-point Lagrange interpolation on equally spaced nodes `y[i0..i0 + 4]`, at `x`
/// node spacings after node `i0`.
fn lagrange4(y: &[f64], i0: usize, x: f64) -> f64 {
    let (y0, y1, y2, y3) = (y[i0], y[i0 + 1], y[i0 + 2], y[i0 + 3]);
    let (x1, x2, x3) = (x - 1.0, x - 2.0, x - 3.0);
    -y0 * x1 * x2 * x3 / 6.0 + y1 * x * x2 * x3 / 2.0 - y2 * x * x1 * x3 / 2.0
        + y3 * x * x1 * x2 / 6.0
}

impl Track {
    /// Build a track for each body over `[t0, t1]` (`t1 > t0`).
    ///
    /// Within each node spacing ([`node_spacing_days`]) the provider is called
    /// **instant by instant** (every body at the first node, then every body at the
    /// second, ...), so providers that share work between bodies at one instant — the
    /// star provider's frame — do it once per node. A body the provider cannot answer
    /// for at some node comes back as its error.
    pub(crate) fn build_many(
        eph: &dyn BodyEphemeris,
        bodies: &[&str],
        t0: f64,
        t1: f64,
    ) -> Vec<Result<Track, BodyError>> {
        let spacing: Vec<f64> = bodies.iter().map(|b| node_spacing_days(b)).collect();
        let mut out: Vec<Result<Track, BodyError>> = spacing
            .iter()
            .map(|&sp| {
                let (times, h) = node_times(t0, t1, sp);
                Ok(Track {
                    t0,
                    h,
                    gha: Vec::with_capacity(times.len()),
                    ra: Vec::with_capacity(times.len()),
                    dec: Vec::with_capacity(times.len()),
                    dist: Vec::new(),
                    sd: Vec::with_capacity(times.len()),
                    template: placeholder_state(),
                })
            })
            .collect();
        for class in [
            NODE_SPACING_DAYS,
            PLANET_NODE_SPACING_DAYS,
            MOON_NODE_SPACING_DAYS,
        ] {
            let (times, _) = node_times(t0, t1, class);
            for (k, &t) in times.iter().enumerate() {
                for ((body, slot), &sp) in bodies.iter().zip(out.iter_mut()).zip(&spacing) {
                    if sp != class {
                        continue;
                    }
                    let Ok(track) = slot else { continue };
                    match eph.apparent_state(body, t) {
                        Ok(st) => track.push(k, st),
                        Err(e) => {
                            *slot = Err(BodyError {
                                body: (*body).to_string(),
                                message: e.to_string(),
                            })
                        }
                    }
                }
            }
        }
        out
    }

    fn push(&mut self, k: usize, st: ApparentState) {
        if k == 0 {
            self.gha.push(st.gha_deg);
            self.ra.push(st.ra_deg);
        } else {
            let (g, r) = (self.gha[k - 1], self.ra[k - 1]);
            self.gha.push(unwrap(g, st.gha_deg));
            self.ra.push(unwrap(r, st.ra_deg));
        }
        self.dec.push(st.dec_deg);
        if let Some(d) = st.distance_km {
            self.dist.push(d);
        }
        self.sd.push(st.semidiameter_arcmin);
        if k == 0 {
            self.template = st;
        }
    }

    /// The first node's exact state (for the fields that are not interpolated).
    pub(crate) fn template(&self) -> &ApparentState {
        &self.template
    }

    /// Stencil start and position within it for instant `t`.
    fn stencil(&self, t: f64) -> (usize, f64) {
        let n = self.gha.len();
        let s = (t - self.t0) / self.h;
        let i = (s.floor().max(0.0) as usize).min(n - 2);
        let i0 = i.saturating_sub(1).min(n - 4);
        (i0, s - i0 as f64)
    }

    /// Overwrite the interpolated fields of `scratch` with this track's state at `t`:
    /// `jd_utc`, `gha_deg`, `ra_deg`, `dec_deg`, `distance_km`, `semidiameter_arcmin`.
    /// Everything else is left as it was (start from [`Track::template`]).
    pub(crate) fn fill(&self, t: f64, scratch: &mut ApparentState) {
        let (i0, x) = self.stencil(t);
        scratch.jd_utc = t;
        scratch.gha_deg = norm_360(lagrange4(&self.gha, i0, x));
        scratch.ra_deg = norm_360(lagrange4(&self.ra, i0, x));
        scratch.dec_deg = lagrange4(&self.dec, i0, x).clamp(-90.0, 90.0);
        scratch.distance_km = if self.dist.is_empty() {
            None
        } else {
            Some(lagrange4(&self.dist, i0, x))
        };
        scratch.semidiameter_arcmin = lagrange4(&self.sd, i0, x);
    }
}

/// An inert state used only until the first node arrives.
fn placeholder_state() -> ApparentState {
    ApparentState {
        body: String::new(),
        kind: skyfix_ephemeris::body::BodyKind::Star,
        jd_utc: 0.0,
        ra_deg: 0.0,
        dec_deg: 0.0,
        gha_deg: 0.0,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lagrange4_reproduces_cubics_exactly() {
        let f = |x: f64| 2.0 - 3.0 * x + 0.5 * x * x - 0.25 * x * x * x;
        let y: Vec<f64> = (0..6).map(|k| f(k as f64)).collect();
        for i0 in 0..3 {
            for j in 0..=30 {
                let x = j as f64 / 10.0;
                let got = lagrange4(&y, i0, x);
                assert!((got - f(i0 as f64 + x)).abs() < 1e-12, "{i0} {x}");
            }
        }
    }

    #[test]
    fn nodes_cover_the_window_evenly_and_end_on_it() {
        for (t0, t1) in [(0.0, 1.0), (10.0, 10.01), (5.0, 405.0)] {
            let (v, h) = node_times(t0, t1, MOON_NODE_SPACING_DAYS);
            assert!(v.len() >= 4);
            assert_eq!(v[0], t0);
            assert_eq!(*v.last().unwrap(), t1);
            assert!(h <= MOON_NODE_SPACING_DAYS + 1e-15);
            for w in v.windows(2) {
                assert!((w[1] - w[0] - h).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn node_spacing_follows_how_fast_the_motion_changes() {
        assert_eq!(node_spacing_days("moon"), MOON_NODE_SPACING_DAYS);
        for p in ["Mercury", "venus", "Neptune"] {
            assert_eq!(node_spacing_days(p), PLANET_NODE_SPACING_DAYS);
        }
        for b in ["Sun", "Vega", "Polaris"] {
            assert_eq!(node_spacing_days(b), NODE_SPACING_DAYS);
        }
    }

    #[test]
    fn unwrap_follows_the_short_way_round() {
        assert_eq!(unwrap(350.0, 10.0), 370.0);
        assert_eq!(unwrap(10.0, 350.0), -10.0);
        assert_eq!(unwrap(720.0 + 5.0, 50.0), 770.0);
    }
}
