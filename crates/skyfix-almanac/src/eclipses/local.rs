//! Local circumstances: what one observer sees.
//!
//! **Solar.** The observer's WGS84 position (height included) is projected on the
//! fundamental plane at every instant, `(xi, eta, zeta)`, and the classical
//! conditions of `bessel.rs` give the contacts: C1 and C4 where the distance from the
//! axis `D` equals `L1`, C2 and C3 where it equals `|L2|`, maximum where `D` is least.
//! These are the instants the *topocentric* Sun and Moon are tangent, so they include
//! the Moon's parallax exactly. The Sun's altitude and azimuth at each event are
//! CONVENTIONS 13.2 values (topocentric, geometric, centre), and an event counts as
//! visible when the Sun's centre is above `-50'`, the rise/set altitude of CONVENTIONS
//! 13.3 (upper limb on a sea-level horizon with standard refraction). Sunrise or
//! sunset inside the eclipse is reported as its own event.
//!
//! **Lunar.** Contacts are the same instants everywhere; what changes is whether the
//! Moon is up. Its altitude comes from the Moon provider through
//! `topocentric::horizontal`, and it counts as visible above `-(34' + SD)`, its
//! rise/set altitude in CONVENTIONS 13.3.

use serde::{Deserialize, Serialize};
use skyfix_ephemeris::EphemerisError;
use skyfix_ephemeris::body::{ApparentState, BodyKind};
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::{Horizontal, Site, WGS84_A_KM, horizontal};

use super::bessel::{Elements, Frame, SolarElements, Vec3, observer_rates};
use super::cheb::{root, scan_minimum};
use super::lunar::{LunarElements, LunarGlobal};
use super::solar::T_TOL_H;

/// The Sun is up when its centre is above this geometric altitude (CONVENTIONS 13.3).
pub const SUN_RISE_SET_ALT_DEG: f64 = -50.0 / 60.0;

/// Is the eclipse visible from here?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    /// The whole eclipse happens with the body up.
    Visible,
    /// The body rises or sets during the eclipse.
    PartlyBelowHorizon,
    /// The eclipse happens here geometrically, but the body is down throughout.
    BelowHorizon,
    /// No eclipse at this place (outside the penumbra's path).
    None,
}

/// What a solar eclipse looks like from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalType {
    Total,
    Annular,
    Partial,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalEventKind {
    /// Solar contacts and maximum.
    C1,
    C2,
    Max,
    C3,
    C4,
    /// Lunar contacts.
    P1,
    U1,
    U2,
    U3,
    U4,
    P4,
    Sunrise,
    Sunset,
    Moonrise,
    Moonset,
}

/// One instant of the local circumstances.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalEvent {
    pub kind: LocalEventKind,
    pub jd_utc: f64,
    pub utc: String,
    /// The eclipsed body's topocentric geometric altitude and azimuth (CONVENTIONS
    /// 13.2): the Sun for a solar eclipse, the Moon for a lunar one.
    pub alt_deg: f64,
    pub az_deg: f64,
    /// Above its rise/set altitude (see the module documentation).
    pub visible: bool,
    /// Solar contacts: where the limbs touch on the Sun's disc, measured from
    /// celestial north through east (`position_angle_deg`) and from the zenith
    /// (`vertex_angle_deg`), degrees `[0, 360)`.
    pub position_angle_deg: Option<f64>,
    pub vertex_angle_deg: Option<f64>,
    /// Solar maximum (and the visible maximum): fraction of the Sun's diameter and of
    /// its area covered.
    pub magnitude: Option<f64>,
    pub obscuration: Option<f64>,
}

/// The fraction of the Sun's disc (radius `rs`) covered by the Moon's (radius `rm`)
/// when their centres are `dist` apart, all in the same units.
pub fn obscuration(rs: f64, rm: f64, dist: f64) -> f64 {
    if dist >= rs + rm {
        return 0.0;
    }
    if dist <= (rs - rm).abs() {
        return if rm >= rs { 1.0 } else { (rm / rs).powi(2) };
    }
    let a1 = ((dist * dist + rm * rm - rs * rs) / (2.0 * dist * rm))
        .clamp(-1.0, 1.0)
        .acos();
    let a2 = ((dist * dist + rs * rs - rm * rm) / (2.0 * dist * rs))
        .clamp(-1.0, 1.0)
        .acos();
    let k = ((-dist + rm + rs) * (dist + rm - rs) * (dist - rm + rs) * (dist + rm + rs))
        .max(0.0)
        .sqrt();
    let area = rm * rm * a1 + rs * rs * a2 - 0.5 * k;
    (area / (std::f64::consts::PI * rs * rs)).clamp(0.0, 1.0)
}

/// The observer against the shadow at one instant.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ObserverState {
    pub e: Elements,
    pub q: Vec3,
    /// Axis minus observer on the fundamental plane.
    pub u: f64,
    pub v: f64,
    pub delta: f64,
    pub l1: f64,
    /// Signed: negative where the eclipse is total.
    pub l2: f64,
}

impl ObserverState {
    pub(crate) fn magnitude(&self) -> f64 {
        (self.l1 - self.delta) / (self.l1 + self.l2)
    }

    pub(crate) fn obscuration(&self) -> f64 {
        obscuration(
            0.5 * (self.l1 + self.l2),
            0.5 * (self.l1 - self.l2),
            self.delta,
        )
    }

    /// Position angle of the Moon's centre from the Sun's, north through east, degrees.
    fn moon_position_angle_deg(&self) -> f64 {
        self.u.atan2(self.v).to_degrees().rem_euclid(360.0)
    }
}

pub(crate) fn observer_state(el: &SolarElements, p: Vec3, t: f64) -> ObserverState {
    let e = el.at(t);
    let q = Frame::new(e.d, e.mu).project(p);
    let (u, v) = (e.x - q[0], e.y - q[1]);
    ObserverState {
        e,
        q,
        u,
        v,
        delta: u.hypot(v),
        l1: e.l1 - q[2] * e.tan_f1,
        l2: e.l2 - q[2] * e.tan_f2,
    }
}

/// `d/dt (u^2 + v^2) / 2` for the observer.
fn approach_rate(el: &SolarElements, p: Vec3, t: f64) -> f64 {
    let s = observer_state(el, p, t);
    let r = el.rates(t);
    let qd = observer_rates(s.q, &s.e, &r);
    s.u * (r.x - qd[0]) + s.v * (r.y - qd[1])
}

/// Earth-fixed position of a site in Earth equatorial radii.
pub(crate) fn site_vector(site: &Site) -> Vec3 {
    site.position_km().map(|v| v / WGS84_A_KM)
}

fn sun_state(sun: &SunProvider, jd: f64) -> Result<ApparentState, EphemerisError> {
    let p = sun.position(jd)?;
    Ok(ApparentState {
        body: "Sun".to_string(),
        kind: BodyKind::Sun,
        jd_utc: jd,
        ra_deg: p.ra_deg,
        dec_deg: p.dec_deg,
        gha_deg: p.gha_deg,
        distance_km: Some(p.radius_au * skyfix_ephemeris::body::AU_KM),
        semidiameter_arcmin: p.semidiameter_arcmin,
        horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
        magnitude: None,
        phase_angle_deg: None,
        illuminated_fraction: None,
        elongation_deg: None,
        bright_limb_angle_deg: None,
    })
}

fn moon_state(moon: &MoonProvider, jd: f64) -> Result<ApparentState, EphemerisError> {
    let p = moon.position(jd)?;
    Ok(ApparentState {
        body: "Moon".to_string(),
        kind: BodyKind::Moon,
        jd_utc: jd,
        ra_deg: p.ra_deg,
        dec_deg: p.dec_deg,
        gha_deg: p.gha_deg,
        distance_km: Some(p.distance_km),
        semidiameter_arcmin: p.semidiameter_arcmin,
        horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
        magnitude: None,
        phase_angle_deg: None,
        illuminated_fraction: None,
        elongation_deg: None,
        bright_limb_angle_deg: None,
    })
}

/// The Sun seen from `site` at `jd`.
pub(crate) fn sun_horizontal(
    sun: &SunProvider,
    site: &Site,
    jd: f64,
) -> Result<Horizontal, EphemerisError> {
    Ok(horizontal(&sun_state(sun, jd)?, site))
}

/// The Moon seen from `site` at `jd`, and its rise/set altitude there (degrees).
fn moon_horizontal(
    moon: &MoonProvider,
    site: &Site,
    jd: f64,
) -> Result<(Horizontal, f64), EphemerisError> {
    let st = moon_state(moon, jd)?;
    let h0 = -(34.0 + st.semidiameter_arcmin) / 60.0;
    Ok((horizontal(&st, site), h0))
}

/// Instants in `[a, b]` (hours) when `alt(t) - h0(t)` changes sign, found on a grid of
/// `step` hours and refined to `T_TOL_H`. `true` for rising.
fn horizon_crossings<F>(
    mut f: F,
    a: f64,
    b: f64,
    step: f64,
) -> Result<Vec<(f64, bool)>, EphemerisError>
where
    F: FnMut(f64) -> Result<f64, EphemerisError>,
{
    let mut out = Vec::new();
    if b <= a {
        return Ok(out);
    }
    let n = ((b - a) / step).ceil().max(1.0) as usize;
    let h = (b - a) / n as f64;
    let mut t0 = a;
    let mut f0 = f(a)?;
    for i in 1..=n {
        let t1 = a + h * i as f64;
        let f1 = f(t1)?;
        if f0 * f1 < 0.0 {
            let mut err = None;
            let r = root(
                |t| match f(t) {
                    Ok(v) => v,
                    Err(e) => {
                        err = Some(e);
                        f64::NAN
                    }
                },
                t0,
                t1,
                T_TOL_H,
            );
            if let Some(e) = err {
                return Err(e);
            }
            if let Some(r) = r {
                out.push((r, f1 > f0));
            }
        }
        t0 = t1;
        f0 = f1;
    }
    Ok(out)
}

fn event(kind: LocalEventKind, jd: f64, hz: &Horizontal, visible: bool) -> LocalEvent {
    LocalEvent {
        kind,
        jd_utc: jd,
        utc: skyfix_core::time::format_utc(jd),
        alt_deg: hz.alt_deg,
        az_deg: hz.az_deg,
        visible,
        position_angle_deg: None,
        vertex_angle_deg: None,
        magnitude: None,
        obscuration: None,
    }
}

/// Local circumstances of a solar eclipse, before the caller adds its identity.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SolarLocalRaw {
    pub visibility: Visibility,
    pub local_type: LocalType,
    pub magnitude: f64,
    pub obscuration: f64,
    pub duration_s: Option<f64>,
    pub central_duration_s: Option<f64>,
    pub events: Vec<LocalEvent>,
    pub visible_max: Option<LocalEvent>,
}

/// The contacts and maximum only (no ephemeris calls): times in hours.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SolarContacts {
    pub t_max: f64,
    pub max: ObserverState,
    pub c1: Option<f64>,
    pub c2: Option<f64>,
    pub c3: Option<f64>,
    pub c4: Option<f64>,
}

pub(crate) fn solar_contacts(el: &SolarElements, p: Vec3) -> SolarContacts {
    let (lo, hi) = (el.t_lo, el.t_hi);
    let steps = ((hi - lo) * 6.0).ceil().max(12.0) as usize;
    let d2 = |t: f64| {
        let s = observer_state(el, p, t);
        s.u * s.u + s.v * s.v
    };
    let (t0, _) = scan_minimum(d2, lo, hi, steps, T_TOL_H);
    let h = (hi - lo) / steps as f64;
    let t_max = root(
        |t| approach_rate(el, p, t),
        (t0 - h).max(lo),
        (t0 + h).min(hi),
        T_TOL_H,
    )
    .unwrap_or(t0);
    let max = observer_state(el, p, t_max);
    let mut c = SolarContacts {
        t_max,
        max,
        c1: None,
        c2: None,
        c3: None,
        c4: None,
    };
    if max.magnitude() <= 0.0 {
        return c;
    }
    let pen = |t: f64| {
        let s = observer_state(el, p, t);
        s.delta - s.l1
    };
    c.c1 = root(pen, lo, t_max, T_TOL_H);
    c.c4 = root(pen, t_max, hi, T_TOL_H);
    if max.delta < max.l2.abs() {
        let umb = |t: f64| {
            let s = observer_state(el, p, t);
            s.delta - s.l2.abs()
        };
        c.c2 = root(umb, c.c1.unwrap_or(lo), t_max, T_TOL_H);
        c.c3 = root(umb, t_max, c.c4.unwrap_or(hi), T_TOL_H);
    }
    c
}

/// Local circumstances of a solar eclipse at `site`.
pub(crate) fn solar_local(
    el: &SolarElements,
    sun: &SunProvider,
    site: &Site,
) -> Result<SolarLocalRaw, EphemerisError> {
    let p = site_vector(site);
    let c = solar_contacts(el, p);
    let mag = c.max.magnitude();
    let none = SolarLocalRaw {
        visibility: Visibility::None,
        local_type: LocalType::None,
        magnitude: 0.0,
        obscuration: 0.0,
        duration_s: None,
        central_duration_s: None,
        events: Vec::new(),
        visible_max: None,
    };
    let (Some(c1), Some(c4)) = (c.c1, c.c4) else {
        return Ok(none);
    };
    if mag <= 0.0 {
        return Ok(none);
    }
    let local_type = match (c.c2, c.c3) {
        (Some(_), Some(_)) if c.max.l2 < 0.0 => LocalType::Total,
        (Some(_), Some(_)) => LocalType::Annular,
        _ => LocalType::Partial,
    };
    let total = local_type == LocalType::Total;

    let mut events = Vec::new();
    let contact =
        |kind: LocalEventKind, t: f64, internal: bool| -> Result<LocalEvent, EphemerisError> {
            let jd = el.jd(t);
            let hz = sun_horizontal(sun, site, jd)?;
            let s = observer_state(el, p, t);
            let mut ev = event(kind, jd, &hz, hz.alt_deg > SUN_RISE_SET_ALT_DEG);
            // Where the limbs touch: toward the Moon's centre for the external contacts
            // and inside an annulus, away from it when the Moon covers the Sun.
            let pa = s.moon_position_angle_deg() + if internal && total { 180.0 } else { 0.0 };
            let pa = pa.rem_euclid(360.0);
            ev.position_angle_deg = Some(pa);
            ev.vertex_angle_deg = Some((pa - hz.parallactic_angle_deg).rem_euclid(360.0));
            Ok(ev)
        };
    events.push(contact(LocalEventKind::C1, c1, false)?);
    if let Some(t) = c.c2 {
        events.push(contact(LocalEventKind::C2, t, true)?);
    }
    let jd_max = el.jd(c.t_max);
    let hz_max = sun_horizontal(sun, site, jd_max)?;
    let mut max_ev = event(
        LocalEventKind::Max,
        jd_max,
        &hz_max,
        hz_max.alt_deg > SUN_RISE_SET_ALT_DEG,
    );
    max_ev.magnitude = Some(mag);
    max_ev.obscuration = Some(c.max.obscuration());
    events.push(max_ev.clone());
    if let Some(t) = c.c3 {
        events.push(contact(LocalEventKind::C3, t, true)?);
    }
    events.push(contact(LocalEventKind::C4, c4, false)?);

    // Sunrise and sunset during the eclipse.
    let crossings = horizon_crossings(
        |t| Ok(sun_horizontal(sun, site, el.jd(t))?.alt_deg - SUN_RISE_SET_ALT_DEG),
        c1,
        c4,
        5.0 / 60.0,
    )?;
    let mut horizon_events = Vec::new();
    for (t, rising) in &crossings {
        let jd = el.jd(*t);
        let hz = sun_horizontal(sun, site, jd)?;
        let kind = if *rising {
            LocalEventKind::Sunrise
        } else {
            LocalEventKind::Sunset
        };
        let mut ev = event(kind, jd, &hz, true);
        let s = observer_state(el, p, *t);
        ev.magnitude = Some(s.magnitude().max(0.0));
        ev.obscuration = Some(s.obscuration());
        horizon_events.push((*t, ev));
    }
    events.extend(horizon_events.iter().map(|(_, e)| e.clone()));
    events.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));

    let any_visible = events.iter().any(|e| e.visible);
    let all_visible = events.iter().all(|e| e.visible) && crossings.is_empty();
    let visibility = if all_visible {
        Visibility::Visible
    } else if !any_visible && crossings.is_empty() {
        Visibility::BelowHorizon
    } else {
        Visibility::PartlyBelowHorizon
    };
    let visible_max = if max_ev.visible {
        Some(max_ev)
    } else if visibility == Visibility::PartlyBelowHorizon {
        // Magnitude grows toward the maximum, so the best the observer sees is at the
        // sunrise or sunset nearest to it.
        horizon_events
            .iter()
            .min_by(|a, b| (a.0 - c.t_max).abs().total_cmp(&(b.0 - c.t_max).abs()))
            .map(|(_, e)| e.clone())
    } else {
        None
    };
    Ok(SolarLocalRaw {
        visibility,
        local_type,
        magnitude: mag,
        obscuration: c.max.obscuration(),
        duration_s: Some((c4 - c1) * 3600.0),
        central_duration_s: match (c.c2, c.c3) {
            (Some(a), Some(b)) => Some((b - a) * 3600.0),
            _ => None,
        },
        events,
        visible_max,
    })
}

/// Local visibility of a lunar eclipse.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LunarLocalRaw {
    pub visibility: Visibility,
    pub events: Vec<LocalEvent>,
}

pub(crate) fn lunar_local(
    el: &LunarElements,
    g: &LunarGlobal,
    moon: &MoonProvider,
    site: &Site,
) -> Result<LunarLocalRaw, EphemerisError> {
    let mut contacts = vec![
        (LocalEventKind::P1, g.p1),
        (LocalEventKind::U1, g.u1),
        (LocalEventKind::U2, g.u2),
        (LocalEventKind::Max, Some(g.t_ge)),
        (LocalEventKind::U3, g.u3),
        (LocalEventKind::U4, g.u4),
        (LocalEventKind::P4, g.p4),
    ];
    contacts.retain(|(_, t)| t.is_some());
    let mut events = Vec::new();
    for (kind, t) in &contacts {
        let jd = el.jd(t.unwrap_or(g.t_ge));
        let (hz, h0) = moon_horizontal(moon, site, jd)?;
        events.push(event(*kind, jd, &hz, hz.alt_deg > h0));
    }
    let first = g.p1.unwrap_or(el.t_lo);
    let last = g.p4.unwrap_or(el.t_hi);
    let crossings = horizon_crossings(
        |t| {
            let (hz, h0) = moon_horizontal(moon, site, el.jd(t))?;
            Ok(hz.alt_deg - h0)
        },
        first,
        last,
        10.0 / 60.0,
    )?;
    for (t, rising) in &crossings {
        let jd = el.jd(*t);
        let (hz, _) = moon_horizontal(moon, site, jd)?;
        let kind = if *rising {
            LocalEventKind::Moonrise
        } else {
            LocalEventKind::Moonset
        };
        events.push(event(kind, jd, &hz, true));
    }
    events.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));
    let any_visible = events.iter().any(|e| e.visible);
    let all_visible = events.iter().all(|e| e.visible) && crossings.is_empty();
    let visibility = if all_visible {
        Visibility::Visible
    } else if !any_visible && crossings.is_empty() {
        Visibility::BelowHorizon
    } else {
        Visibility::PartlyBelowHorizon
    };
    Ok(LunarLocalRaw { visibility, events })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obscuration_limits_and_symmetry() {
        assert_eq!(obscuration(1.0, 1.0, 2.5), 0.0);
        assert_eq!(obscuration(1.0, 1.05, 0.02), 1.0);
        assert!((obscuration(1.0, 0.9, 0.05) - 0.81).abs() < 1e-12);
        // Equal discs half a radius apart: a textbook lens.
        let lens = obscuration(1.0, 1.0, 1.0);
        let exact = (2.0 * std::f64::consts::PI / 3.0 - 3f64.sqrt() / 2.0) / std::f64::consts::PI;
        assert!((lens - exact).abs() < 1e-12, "{lens} {exact}");
        // Continuous at external and internal tangency.
        assert!(obscuration(1.0, 0.5, 1.5 - 1e-9) < 1e-6);
        assert!((obscuration(1.0, 0.5, 0.5 + 1e-9) - 0.25).abs() < 1e-6);
    }
}
