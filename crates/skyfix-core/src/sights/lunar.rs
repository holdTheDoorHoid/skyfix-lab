//! Lunar distance: Greenwich time from the Moon's angular distance to another body.
//!
//! OWNER: navigation-Moon agent. `docs/NAVIGATION_SKY.md`, "Lunar distance", explains it
//! in plain words.
//!
//! The Moon moves across the stars about its own diameter an hour, so the angle between
//! the Moon and the Sun, a star or a planet is a clock readable anywhere on Earth. A
//! navigator measures that angle between the Moon's limb and the other body; what it
//! would be from the Earth's centre (the **cleared** distance) is then looked up against
//! the ephemeris for the instant at which the two agree.
//!
//! # Clearing, rigorously
//!
//! Every step the observer's position puts into the measured angle is taken out again,
//! with nothing linearised that matters at the 0.01' level:
//!
//! 1. **Index correction**, added (CONVENTIONS section 5 step 1).
//! 2. **Semidiameters**, from the limb to the centre. The Moon's is its topocentric
//!    (augmented) semidiameter; the Sun's likewise. Refraction squeezes a disc low in the
//!    sky, so the edge is found numerically: the true limb circle is refracted point by
//!    point (CONVENTIONS Bennett formula, inverted) and the point nearest (or farthest
//!    from) the other body taken.
//! 3. **Refraction**, removed from the apparent altitudes of both centres. Refraction acts
//!    along the vertical, so the difference in azimuth between the two bodies is the same
//!    in the apparent and the true sky: it comes from the apparent triangle zenith, Moon,
//!    body, and the true topocentric distance from the true altitudes around it.
//! 4. **Parallax**, removed with the observer on the **WGS84 ellipsoid**
//!    ([`super::wgs84`]): each true topocentric direction is extended to the body's
//!    geocentric distance from the observer's real position. On the spherical Earth of
//!    CONVENTIONS section 1 the Moon's parallax is up to 0.22' out, a minute of time.
//!
//! The altitudes come from the navigator's own observations when they are given
//! (reduced through index correction and dip), otherwise they are computed from the DR
//! position at every trial instant. Azimuths always come from the DR position; they
//! decide only on which side of the Moon the body lies and the small part of the
//! parallax the ellipsoid turns sideways.
//!
//! # Finding the time
//!
//! `g(t) = cleared(t) - geocentric(t)`, with `geocentric(t)` the angle between the
//! Moon's and the body's apparent geocentric directions (CONVENTIONS section 7) from the
//! [`DirectionSource`]. `g` is sampled every 10 minutes across the search window, every
//! sign change is refined to a millisecond, and the root nearest the watch's estimate is
//! the answer; any other root is reported, never hidden. An instant at which either
//! body would be below the horizon is not a candidate.
//!
//! # How good the time is
//!
//! `sigma_t = sigma_D / |dg/dt|`. The distance changes about half an arcminute a minute,
//! so one arcminute of distance is about two minutes of time, or thirty arcminutes of
//! longitude. `sigma_D` combines, in quadrature: the measurement's sigma; the ephemeris
//! (0.02' for the Moon and 0.02' for the body); the refraction model (1 % of each
//! refraction, and CONVENTIONS section 5's extra 1' below 5 degrees, projected onto the
//! distance); observed altitudes' sigmas through the clearing's sensitivity to them;
//! and, when the caller gives one, the DR position's uncertainty. Each term is reported.

use crate::SkyfixError;
use crate::corrections::{self, SightBody};
use crate::reduce::DirectionSource;
use crate::sights::wgs84::{
    HP_RADIUS_KM, Site, Vec3, add, alt_az_from_enu, angle, cross, dot, earth_fixed_unit,
    enu_from_alt_az, range_to_radius, scale, sub, unit,
};
use crate::time::{format_utc, parse_utc};
use crate::types::{
    AltitudeKind, HorizonMode, Instrument, Limb, LunarAlternative, LunarAltitudeObservation,
    LunarAltitudes, LunarClearingStep, LunarDistanceInput, LunarDistanceResult, LunarErrorTerm,
    LunarLimb, SightObserver, Warning,
};
use crate::units::norm_360;

/// Sampling step of the search, minutes.
const GRID_STEP_MIN: f64 = 10.0;
/// Root refinement tolerance, days (one millisecond).
const ROOT_TOLERANCE_DAYS: f64 = 0.001 / 86_400.0;
/// Ephemeris error of the Moon (0.02') and of the other body (0.02'), in quadrature.
pub const EPHEMERIS_SIGMA_ARCMIN: f64 = 0.028;
/// Relative uncertainty of the refraction model (the real atmosphere against the
/// standard one at the stated pressure and temperature).
pub const REFRACTION_RELATIVE_SIGMA: f64 = 0.01;
/// A distance changing slower than this (arcmin per minute) makes a poor clock.
pub const SLOW_RATE_ARCMIN_PER_MIN: f64 = 0.25;
/// Arcminutes of longitude per second of time: 15.041' per minute over 60 s.
const LONGITUDE_ARCMIN_PER_S: f64 = crate::units::SIDEREAL_RATE_DEG_PER_HOUR / 60.0;

/// Clear a lunar distance and find the UTC at which it was taken.
pub fn lunar_distance(
    input: &LunarDistanceInput,
    source: &dyn DirectionSource,
) -> Result<LunarDistanceResult, SkyfixError> {
    // An index-error log gives the correction at the watch's estimate (CONVENTIONS
    // section 10; the index error does not change over the hours of the search).
    let resolved;
    let input = if input.instrument.index_error_log.is_empty() {
        input
    } else {
        let mut copy = input.clone();
        copy.instrument.index_correction_arcmin = crate::error_logs::effective_index_correction(
            &input.instrument,
            parse_utc(&input.utc_estimate)?,
        )?
        .0;
        resolved = copy;
        &resolved
    };
    let ctx = Context::new(input)?;
    let jd0 = parse_utc(&input.utc_estimate)?;
    let half = input.search_hours / 24.0;
    let step = GRID_STEP_MIN / 1440.0;
    let n = (2.0 * half / step).ceil() as usize;

    // Sample g over the window.
    let mut samples: Vec<(f64, Option<f64>)> = Vec::with_capacity(n + 1);
    let mut last_error: Option<String> = None;
    for k in 0..=n {
        let t = jd0 - half + (k as f64) * (2.0 * half / n as f64);
        match ctx.clear(source, t, Perturbation::NONE) {
            Ok(c) => samples.push((t, Some(c.g_deg()))),
            Err(e) => {
                last_error = Some(e);
                samples.push((t, None));
            }
        }
    }
    let mut roots: Vec<f64> = Vec::new();
    for w in samples.windows(2) {
        let ((ta, ga), (tb, gb)) = (w[0], w[1]);
        let (Some(ga), Some(gb)) = (ga, gb) else {
            continue;
        };
        if ga == 0.0 {
            roots.push(ta);
        } else if (ga < 0.0) != (gb < 0.0) {
            if let Some(r) = refine(&ctx, source, ta, ga, tb, gb) {
                roots.push(r);
            }
        }
    }
    roots.dedup_by(|a, b| (*a - *b).abs() < 1.0 / 86_400.0);
    if roots.is_empty() {
        return Err(no_root_error(input, &samples, last_error));
    }
    roots.sort_by(|a, b| (a - jd0).abs().total_cmp(&(b - jd0).abs()));
    let t = roots[0];
    ctx.report(source, t, jd0, &roots[1..])
}

// ---------------------------------------------------------------------------
// Inputs, prepared once
// ---------------------------------------------------------------------------

struct Context<'a> {
    input: &'a LunarDistanceInput,
    body: String,
    moon_limb: LunarLimb,
    body_limb: LunarLimb,
    /// The distance reading plus the index correction, degrees.
    distance_deg: f64,
    /// Observed apparent altitudes of the observed limbs (after IC and dip), degrees.
    moon_ha: Option<(f64, Limb, f64)>,
    body_ha: Option<(f64, Limb, f64)>,
    warnings: Vec<Warning>,
}

/// Small changes applied to the clearing to measure its sensitivities.
#[derive(Debug, Clone, Copy)]
struct Perturbation {
    refraction_scale: f64,
    dr_north_nm: f64,
    dr_east_nm: f64,
    moon_alt_arcmin: f64,
    body_alt_arcmin: f64,
}

impl Perturbation {
    const NONE: Perturbation = Perturbation {
        refraction_scale: 1.0,
        dr_north_nm: 0.0,
        dr_east_nm: 0.0,
        moon_alt_arcmin: 0.0,
        body_alt_arcmin: 0.0,
    };
}

impl<'a> Context<'a> {
    fn new(input: &'a LunarDistanceInput) -> Result<Context<'a>, SkyfixError> {
        let o = &input.observer;
        check_observer(o)?;
        let class = corrections::sight_body(&input.body);
        if class == SightBody::Moon {
            return Err(SkyfixError::InvalidField {
                field: "body".to_string(),
                message: "a lunar distance is measured from the Moon to another body: the Sun, \
                          a star or a planet"
                    .to_string(),
            });
        }
        for (field, v) in [
            ("distance_deg", input.distance_deg),
            ("sigma_arcmin", input.sigma_arcmin),
            ("search_hours", input.search_hours),
            ("dr_uncertainty_nm", input.dr_uncertainty_nm),
            (
                "instrument.index_correction_arcmin",
                input.instrument.index_correction_arcmin,
            ),
        ] {
            if !v.is_finite() {
                return Err(SkyfixError::NonFinite {
                    field: field.to_string(),
                });
            }
        }
        let distance_deg = input.distance_deg + input.instrument.index_correction_arcmin / 60.0;
        if !(0.5..179.5).contains(&distance_deg) {
            return Err(SkyfixError::InvalidField {
                field: "distance_deg".to_string(),
                message: format!(
                    "{distance_deg:.3} deg after the index correction: a lunar distance lies \
                     between 0.5 and 179.5 deg"
                ),
            });
        }
        if input.sigma_arcmin <= 0.0 {
            return Err(SkyfixError::InvalidField {
                field: "sigma_arcmin".to_string(),
                message: "must be greater than 0".to_string(),
            });
        }
        if !(0.0..=48.0).contains(&input.search_hours) || input.search_hours == 0.0 {
            return Err(SkyfixError::InvalidField {
                field: "search_hours".to_string(),
                message: format!("must be in (0, 48] (got {})", input.search_hours),
            });
        }
        if input.dr_uncertainty_nm < 0.0 {
            return Err(SkyfixError::InvalidField {
                field: "dr_uncertainty_nm".to_string(),
                message: "must be >= 0".to_string(),
            });
        }
        if input.moon_limb == LunarLimb::Center {
            return Err(SkyfixError::InvalidField {
                field: "moon_limb".to_string(),
                message: "the Moon's centre cannot be seen: measure to its near or far limb"
                    .to_string(),
            });
        }
        let mut warnings = Vec::new();
        let body_limb = match (class, input.body_limb) {
            (SightBody::Sun, None) => LunarLimb::Near,
            (SightBody::Sun, Some(l)) => l,
            (_, None) | (_, Some(LunarLimb::Center)) => LunarLimb::Center,
            (_, Some(_)) => {
                warnings.push(Warning::LimbIgnoredForStar {
                    id: format!("lunar distance to {}", input.body),
                });
                LunarLimb::Center
            }
        };
        let moon_ha = input
            .moon_altitude
            .map(|a| apparent_of(&a, o, &input.instrument, "moon_altitude"))
            .transpose()?;
        if let Some(a) = input.moon_altitude
            && a.limb == Limb::Center
        {
            warnings.push(Warning::Other {
                message: "lunar distance: the Moon's observed altitude was given for its \
                          centre, which cannot be seen; if it was the lower or upper limb, \
                          say so, or the altitude is 15' to 17' out"
                    .to_string(),
            });
        }
        // A planet or a star is a point: its altitude is its centre's, whatever limb the
        // record names (the correction chain treats it the same way).
        let body_ha = input
            .body_altitude
            .map(|a| apparent_of(&a, o, &input.instrument, "body_altitude"))
            .transpose()?
            .map(|(ha, limb, sigma)| {
                if class == SightBody::Sun {
                    (ha, limb, sigma)
                } else {
                    (ha, Limb::Center, sigma)
                }
            });
        if let Some(a) = input.body_altitude
            && a.limb != Limb::Center
            && class != SightBody::Sun
        {
            warnings.push(Warning::LimbIgnoredForStar {
                id: format!("{} altitude", input.body),
            });
        }
        Ok(Context {
            input,
            body: input.body.trim().to_string(),
            moon_limb: input.moon_limb,
            body_limb,
            distance_deg,
            moon_ha,
            body_ha,
            warnings,
        })
    }
}

/// An observed altitude reduced to the apparent altitude of the observed limb, with the
/// limb and the altitude's sigma (halved for a reflected horizon's double angle).
fn apparent_of(
    a: &LunarAltitudeObservation,
    o: &SightObserver,
    instrument: &Instrument,
    field: &str,
) -> Result<(f64, Limb, f64), SkyfixError> {
    if !a.altitude_deg.is_finite() || !a.sigma_arcmin.is_finite() || a.sigma_arcmin <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: field.to_string(),
            message: "altitude and sigma must be finite, sigma positive".to_string(),
        });
    }
    let ic = instrument.index_correction_arcmin / 60.0;
    let (ha, sigma) = match a.altitude_kind {
        AltitudeKind::SextantHs => match instrument.horizon {
            HorizonMode::Sea | HorizonMode::Shore { .. } => (
                a.altitude_deg + ic
                    - corrections::horizon_dip_arcmin(instrument.horizon, o.height_of_eye_m) / 60.0,
                a.sigma_arcmin,
            ),
            HorizonMode::ArtificialReflected => ((a.altitude_deg + ic) / 2.0, a.sigma_arcmin / 2.0),
            HorizonMode::ElectronicVertical => (a.altitude_deg + ic, a.sigma_arcmin),
        },
        AltitudeKind::ApparentHa => (a.altitude_deg, a.sigma_arcmin),
        AltitudeKind::ObservedHo => {
            return Err(SkyfixError::InvalidField {
                field: field.to_string(),
                message: "a lunar distance needs the altitude as observed (sextant_hs or \
                          apparent_ha): clearing removes refraction and parallax itself"
                    .to_string(),
            });
        }
    };
    if !(0.0..=90.0).contains(&ha) {
        return Err(SkyfixError::InvalidField {
            field: field.to_string(),
            message: format!(
                "apparent altitude {ha:.4} deg is outside [0, 90]: the refraction model \
                 needs Ha >= 0 (RefractionOutOfRange)"
            ),
        });
    }
    Ok((ha, a.limb, sigma))
}

// ---------------------------------------------------------------------------
// The clearing at one trial instant
// ---------------------------------------------------------------------------

/// One body as seen from the DR position at a trial instant.
#[derive(Debug, Clone, Copy)]
struct Seen {
    /// Earth-fixed unit vector of the apparent geocentric direction.
    geo_unit: Vec3,
    /// Geocentric distance, km (`None` for a star).
    distance_km: Option<f64>,
    /// Airless topocentric altitude and azimuth of the centre, degrees (computed).
    true_alt_deg: f64,
    az_deg: f64,
    /// Topocentric semidiameter, arcminutes (0 for a point).
    sd_topo_arcmin: f64,
}

/// Every quantity of one clearing, degrees unless named otherwise.
#[derive(Debug, Clone, Copy)]
struct Clearing {
    distance_deg: f64,
    moon_offset_arcmin: f64,
    body_offset_arcmin: f64,
    apparent_deg: f64,
    topocentric_deg: f64,
    cleared_deg: f64,
    geocentric_deg: f64,
    moon_apparent_deg: f64,
    body_apparent_deg: f64,
    moon_true_deg: f64,
    body_true_deg: f64,
    moon_az_deg: f64,
    body_az_deg: f64,
    moon_computed_apparent_deg: f64,
    body_computed_apparent_deg: f64,
    /// Cosine of the angle at each body between the zenith and the arc to the other.
    moon_cos_psi: f64,
    body_cos_psi: f64,
    /// The apparent triangle could not close (|cos dA| > 1 before clamping).
    triangle_clamped: bool,
}

impl Clearing {
    fn g_deg(&self) -> f64 {
        self.cleared_deg - self.geocentric_deg
    }
}

impl Context<'_> {
    fn site(&self, p: Perturbation) -> Site {
        let o = &self.input.observer;
        let lat = o.lat_deg + p.dr_north_nm / 60.0;
        let lon = o.lon_deg + p.dr_east_nm / (60.0 * lat.to_radians().cos().max(1e-6));
        Site::new(lat.clamp(-90.0, 90.0), lon)
    }

    fn seen(
        &self,
        source: &dyn DirectionSource,
        body: &str,
        t: f64,
        site: &Site,
    ) -> Result<Seen, String> {
        let d = source.direction(body, t)?;
        if !(d.gha_deg.is_finite() && d.dec_deg.is_finite()) {
            return Err(format!("{body}: the direction is not finite"));
        }
        let geo_unit = earth_fixed_unit(d.gha_deg, d.dec_deg);
        let hp = d.horizontal_parallax_arcmin;
        let distance_km = (hp > 0.0).then(|| HP_RADIUS_KM / (hp / 60.0).to_radians().sin());
        let v = match distance_km {
            Some(r) => sub(scale(geo_unit, r), site.position_km),
            None => geo_unit,
        };
        let (alt, az) = alt_az_from_enu(site.to_enu(v));
        let sd_topo_arcmin = match distance_km {
            Some(r) if d.semidiameter_arcmin > 0.0 => {
                let radius = r * (d.semidiameter_arcmin / 60.0).to_radians().sin();
                (radius / crate::sights::wgs84::norm(v))
                    .clamp(-1.0, 1.0)
                    .asin()
                    .to_degrees()
                    * 60.0
            }
            _ => 0.0,
        };
        Ok(Seen {
            geo_unit,
            distance_km,
            true_alt_deg: alt,
            az_deg: az,
            sd_topo_arcmin,
        })
    }

    /// Apparent and true topocentric altitudes of a centre: from the observation when
    /// there is one, otherwise computed.
    fn centre_altitudes(
        &self,
        seen: &Seen,
        observed: Option<(f64, Limb, f64)>,
        extra_arcmin: f64,
        scale_r: f64,
        name: &str,
    ) -> Result<(f64, f64), String> {
        let o = &self.input.observer;
        match observed {
            Some((ha, limb, _)) => {
                let ha = ha + extra_arcmin / 60.0;
                let limb_true = ha
                    - scale_r * corrections::refraction_arcmin(ha, o.pressure_hpa, o.temperature_c)
                        / 60.0;
                let sign = match limb {
                    Limb::Lower => 1.0,
                    Limb::Upper => -1.0,
                    Limb::Center => 0.0,
                };
                let h_true = limb_true + sign * seen.sd_topo_arcmin / 60.0;
                let h_app = apparent_from_true(h_true, o, scale_r).ok_or_else(|| {
                    format!("{name}: the observed altitude leaves the centre below the horizon")
                })?;
                Ok((h_app, h_true))
            }
            None => {
                let h_true = seen.true_alt_deg + extra_arcmin / 60.0;
                let h_app = apparent_from_true(h_true, o, scale_r)
                    .ok_or_else(|| format!("{name} is below the horizon at this instant"))?;
                Ok((h_app, h_true))
            }
        }
    }

    fn clear(
        &self,
        source: &dyn DirectionSource,
        t: f64,
        p: Perturbation,
    ) -> Result<Clearing, String> {
        let o = &self.input.observer;
        let site = self.site(p);
        let moon = self.seen(source, "Moon", t, &site)?;
        let body = self.seen(source, &self.body, t, &site)?;

        let (h_m_app, h_m) = self.centre_altitudes(
            &moon,
            self.moon_ha,
            p.moon_alt_arcmin,
            p.refraction_scale,
            "the Moon",
        )?;
        let (h_b_app, h_b) = self.centre_altitudes(
            &body,
            self.body_ha,
            p.body_alt_arcmin,
            p.refraction_scale,
            &self.body,
        )?;
        let moon_computed = apparent_from_true(moon.true_alt_deg, o, 1.0).unwrap_or(f64::NAN);
        let body_computed = apparent_from_true(body.true_alt_deg, o, 1.0).unwrap_or(f64::NAN);

        // Apparent directions of the two centres (azimuths from the DR position).
        let p_m = enu_from_alt_az(h_m_app, moon.az_deg);
        let p_b = enu_from_alt_az(h_b_app, body.az_deg);

        // Semidiameters along the arc, from the refracted discs.
        let moon_offset = limb_offset(
            (h_m, moon.az_deg),
            moon.sd_topo_arcmin,
            p_b,
            self.moon_limb == LunarLimb::Far,
            o,
            p.refraction_scale,
        );
        let body_offset = if self.body_limb == LunarLimb::Center || body.sd_topo_arcmin == 0.0 {
            0.0
        } else {
            limb_offset(
                (h_b, body.az_deg),
                body.sd_topo_arcmin,
                p_m,
                self.body_limb == LunarLimb::Far,
                o,
                p.refraction_scale,
            )
        };
        let apparent = (self.distance_deg + (moon_offset + body_offset) / 60.0).to_radians();

        // The apparent triangle zenith-Moon-body gives the azimuth difference, which
        // refraction does not change.
        let (sm, cm) = h_m_app.to_radians().sin_cos();
        let (sb, cb) = h_b_app.to_radians().sin_cos();
        let cos_da_raw = (apparent.cos() - sm * sb) / (cm * cb);
        let triangle_clamped = cos_da_raw.abs() > 1.0 + 1e-12;
        let da = cos_da_raw.clamp(-1.0, 1.0).acos();
        let (tsm, tcm) = h_m.to_radians().sin_cos();
        let (tsb, tcb) = h_b.to_radians().sin_cos();
        // The true topocentric distance with the unclamped cosine: Borda's clearing
        // formula, the same triangle written without the azimuth difference. Where the
        // triangle cannot quite close (an observed altitude combined with a computed one
        // at a trial instant, or refraction near the horizon) it continues smoothly and
        // keeps the measured distance; clamping the azimuth difference there instead put
        // the bodies in one vertical and threw the measured distance away, which folded
        // the search function over and hid the true root (docs/NAVIGATION_SKY.md).
        let topocentric = (tsm * tsb + tcm * tcb * cos_da_raw).clamp(-1.0, 1.0).acos();

        // Parallax on the WGS84 Earth: true topocentric directions extended to each
        // body's geocentric distance from the observer's real position.
        let side = ((body.az_deg - moon.az_deg + 540.0).rem_euclid(360.0) - 180.0).signum();
        let az_b = moon.az_deg + side * da.to_degrees();
        let tau_m = site.from_enu(enu_from_alt_az(h_m, moon.az_deg));
        let tau_b = site.from_enu(enu_from_alt_az(h_b, az_b));
        let g_m = match moon.distance_km {
            Some(r) => add(
                site.position_km,
                scale(tau_m, range_to_radius(&site, tau_m, r)),
            ),
            None => return Err("the Moon's horizontal parallax is missing".to_string()),
        };
        let g_b = match body.distance_km {
            Some(r) => add(
                site.position_km,
                scale(tau_b, range_to_radius(&site, tau_b, r)),
            ),
            None => tau_b,
        };
        // Where the triangle closes this is exactly the angle between the geocentric
        // positions. Where it does not, the parallax is the change the nearest closing
        // triangle (the bodies in one vertical) sees, applied to Borda's distance.
        let cleared = if triangle_clamped {
            (topocentric + angle(g_m, g_b) - angle(tau_m, tau_b)).to_degrees()
        } else {
            angle(g_m, g_b).to_degrees()
        };
        let geocentric = angle(moon.geo_unit, body.geo_unit).to_degrees();

        let (sd, cd) = apparent.sin_cos();
        let cos_psi = |s_self: f64, c_self: f64, s_other: f64| {
            if c_self.abs() < 1e-12 || sd.abs() < 1e-12 {
                0.0
            } else {
                ((s_other - s_self * cd) / (c_self * sd)).clamp(-1.0, 1.0)
            }
        };
        Ok(Clearing {
            distance_deg: self.distance_deg,
            moon_offset_arcmin: moon_offset,
            body_offset_arcmin: body_offset,
            apparent_deg: apparent.to_degrees(),
            topocentric_deg: topocentric.to_degrees(),
            cleared_deg: cleared,
            geocentric_deg: geocentric,
            moon_apparent_deg: h_m_app,
            body_apparent_deg: h_b_app,
            moon_true_deg: h_m,
            body_true_deg: h_b,
            moon_az_deg: moon.az_deg,
            body_az_deg: norm_360(az_b),
            moon_computed_apparent_deg: moon_computed,
            body_computed_apparent_deg: body_computed,
            moon_cos_psi: cos_psi(sm, cm, sb),
            body_cos_psi: cos_psi(sb, cb, sm),
            triangle_clamped,
        })
    }
}

/// The apparent altitude `H` whose refraction brings it down to `h_true`:
/// `H - R(H) = h_true` with the CONVENTIONS section 5 Bennett formula. `None` when the
/// body would be below the apparent horizon (the model stops at `H = 0`).
fn apparent_from_true(h_true: f64, o: &SightObserver, scale_r: f64) -> Option<f64> {
    let r = |h: f64| {
        scale_r * corrections::refraction_arcmin(h, o.pressure_hpa, o.temperature_c) / 60.0
    };
    if h_true + r(0.0) < 0.0 {
        return None;
    }
    let mut h = (h_true + r(h_true.max(0.0))).max(0.0);
    for _ in 0..200 {
        let next = h_true + r(h);
        if next < 0.0 {
            return None;
        }
        if (next - h).abs() < 1e-13 {
            return Some(next);
        }
        h = next;
    }
    Some(h)
}

/// A point on the true limb: the small circle of radius `sd` (radians) about the unit
/// vector `u` (local east, north, up), `theta` measured from the upward tangent.
fn limb_point(u: Vec3, sd: f64, theta: f64) -> Vec3 {
    let zenith = [0.0, 0.0, 1.0];
    let mut e1 = sub(zenith, scale(u, dot(zenith, u)));
    if crate::sights::wgs84::norm(e1) < 1e-12 {
        e1 = [0.0, 1.0, 0.0];
    }
    let e1 = unit(e1);
    let e2 = cross(u, e1);
    add(
        scale(u, sd.cos()),
        scale(
            add(scale(e1, theta.cos()), scale(e2, theta.sin())),
            sd.sin(),
        ),
    )
}

/// The apparent (refracted) image of a true local direction.
fn refract(v: Vec3, o: &SightObserver, scale_r: f64) -> Vec3 {
    let (alt, az) = alt_az_from_enu(v);
    let app = apparent_from_true(alt, o, scale_r).unwrap_or(alt);
    enu_from_alt_az(app, az)
}

/// How much nearer (positive) or farther (negative) the observed limb is than the
/// centre, arcminutes, seen from the apparent point `target`: the disc of true centre
/// `(alt, az)` and topocentric semidiameter `sd_arcmin` is refracted point by point and
/// the nearest (or, for the far limb, farthest) point found by golden-section search.
fn limb_offset(
    centre: (f64, f64),
    sd_arcmin: f64,
    target: Vec3,
    far: bool,
    o: &SightObserver,
    scale_r: f64,
) -> f64 {
    if sd_arcmin <= 0.0 {
        return 0.0;
    }
    let u = enu_from_alt_az(centre.0, centre.1);
    let sd = (sd_arcmin / 60.0).to_radians();
    let centre_app = refract(u, o, scale_r);
    let base = angle(target, centre_app);
    // Start from the direction toward (or away from) the target in the tangent plane.
    let zenith = [0.0, 0.0, 1.0];
    let mut e1 = sub(zenith, scale(u, dot(zenith, u)));
    if crate::sights::wgs84::norm(e1) < 1e-12 {
        e1 = [0.0, 1.0, 0.0];
    }
    let e1 = unit(e1);
    let e2 = cross(u, e1);
    let w = sub(target, scale(u, dot(target, u)));
    let mut theta0 = dot(w, e2).atan2(dot(w, e1));
    if far {
        theta0 += std::f64::consts::PI;
    }
    let sign = if far { -1.0 } else { 1.0 };
    let f = |th: f64| sign * angle(target, refract(limb_point(u, sd, th), o, scale_r));
    let (mut a, mut b) = (theta0 - 0.5, theta0 + 0.5);
    let g = (5f64.sqrt() - 1.0) / 2.0;
    let (mut c, mut d) = (b - g * (b - a), a + g * (b - a));
    let (mut fc, mut fd) = (f(c), f(d));
    for _ in 0..80 {
        if (b - a).abs() < 1e-12 {
            break;
        }
        if fc < fd {
            b = d;
            d = c;
            fd = fc;
            c = b - g * (b - a);
            fc = f(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + g * (b - a);
            fd = f(d);
        }
    }
    let extreme = sign * f(0.5 * (a + b));
    (base - extreme).to_degrees() * 60.0
}

/// Illinois-modified regula falsi on `g` between two samples of opposite sign.
fn refine(
    ctx: &Context<'_>,
    source: &dyn DirectionSource,
    mut a: f64,
    mut fa: f64,
    mut b: f64,
    mut fb: f64,
) -> Option<f64> {
    let mut side = 0;
    for _ in 0..100 {
        let t = (a * fb - b * fa) / (fb - fa);
        let t = if t.is_finite() && t > a && t < b {
            t
        } else {
            0.5 * (a + b)
        };
        let ft = ctx.clear(source, t, Perturbation::NONE).ok()?.g_deg();
        if ft == 0.0 || (b - a).abs() < ROOT_TOLERANCE_DAYS {
            return Some(t);
        }
        if (ft < 0.0) == (fa < 0.0) {
            a = t;
            fa = ft;
            if side == -1 {
                fb /= 2.0;
            }
            side = -1;
        } else {
            b = t;
            fb = ft;
            if side == 1 {
                fa /= 2.0;
            }
            side = 1;
        }
    }
    Some(0.5 * (a + b))
}

fn no_root_error(
    input: &LunarDistanceInput,
    samples: &[(f64, Option<f64>)],
    last_error: Option<String>,
) -> SkyfixError {
    let usable: Vec<(f64, f64)> = samples
        .iter()
        .filter_map(|(t, g)| g.map(|g| (*t, g)))
        .collect();
    if usable.is_empty() {
        return SkyfixError::Other(format!(
            "lunar distance to {}: no instant within {} h of {} could be cleared ({})",
            input.body,
            input.search_hours,
            input.utc_estimate,
            last_error.unwrap_or_else(|| "no samples".to_string())
        ));
    }
    let (lo, hi) = usable
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), (_, g)| {
            (lo.min(*g), hi.max(*g))
        });
    SkyfixError::Other(format!(
        "lunar distance to {}: the cleared distance never equals the Moon-{} distance within \
         {} h of {} (it stays {:.1}' to {:.1}' {} it); check the reading, the limbs, the body \
         and the estimate",
        input.body,
        input.body,
        input.search_hours,
        input.utc_estimate,
        lo.abs().min(hi.abs()) * 60.0,
        lo.abs().max(hi.abs()) * 60.0,
        if lo > 0.0 { "above" } else { "below" }
    ))
}

// ---------------------------------------------------------------------------
// The report at the instant found
// ---------------------------------------------------------------------------

impl Context<'_> {
    fn report(
        &self,
        source: &dyn DirectionSource,
        t: f64,
        jd0: f64,
        others: &[f64],
    ) -> Result<LunarDistanceResult, SkyfixError> {
        let fail = |e: String| SkyfixError::Other(format!("lunar distance: {e}"));
        let c = self.clear(source, t, Perturbation::NONE).map_err(fail)?;
        // Rates over one minute centred on t, arcminutes per minute of time.
        let dt = 30.0 / 86_400.0;
        let before = self
            .clear(source, t - dt, Perturbation::NONE)
            .map_err(fail)?;
        let after = self
            .clear(source, t + dt, Perturbation::NONE)
            .map_err(fail)?;
        let g_rate = (after.g_deg() - before.g_deg()) * 60.0;
        let d_rate = (after.geocentric_deg - before.geocentric_deg) * 60.0;
        let per_s = g_rate.abs() / 60.0; // arcmin of g per second of time

        // Sensitivities, arcminutes of cleared distance.
        let moved = |p: Perturbation| -> Result<f64, SkyfixError> {
            Ok((self.clear(source, t, p).map_err(fail)?.cleared_deg - c.cleared_deg) * 60.0)
        };
        let refraction = moved(Perturbation {
            refraction_scale: 1.0 + REFRACTION_RELATIVE_SIGMA,
            ..Perturbation::NONE
        })?
        .abs();
        let dr_north = moved(Perturbation {
            dr_north_nm: 10.0,
            ..Perturbation::NONE
        })?;
        let dr_east = moved(Perturbation {
            dr_east_nm: 10.0,
            ..Perturbation::NONE
        })?;

        let mut budget: Vec<(String, f64)> = vec![
            ("measurement".to_string(), self.input.sigma_arcmin),
            (
                "ephemeris (Moon and body)".to_string(),
                EPHEMERIS_SIGMA_ARCMIN,
            ),
            ("refraction model (1 %)".to_string(), refraction),
        ];
        let mut warnings = self.warnings.clone();
        for (name, h_app, cos_psi) in [
            ("the Moon", c.moon_apparent_deg, c.moon_cos_psi),
            (self.body.as_str(), c.body_apparent_deg, c.body_cos_psi),
        ] {
            if h_app < corrections::LOW_ALTITUDE_FLAG_THRESHOLD_DEG {
                let added = if h_app < corrections::LOW_ALTITUDE_SIGMA_THRESHOLD_DEG {
                    corrections::LOW_ALTITUDE_SIGMA_ARCMIN
                } else {
                    0.0
                };
                warnings.push(Warning::LowAltitudeRefraction {
                    id: format!("lunar distance: {name}"),
                    apparent_altitude_deg: h_app,
                    sigma_added_arcmin: added,
                });
                if added > 0.0 {
                    budget.push((
                        format!("low-altitude refraction, {name}"),
                        added * cos_psi.abs(),
                    ));
                }
            }
        }
        for (name, obs, which) in [
            ("observed Moon altitude", self.moon_ha, 0),
            ("observed body altitude", self.body_ha, 1),
        ] {
            if let Some((_, _, sigma)) = obs {
                let p = if which == 0 {
                    Perturbation {
                        moon_alt_arcmin: 1.0,
                        ..Perturbation::NONE
                    }
                } else {
                    Perturbation {
                        body_alt_arcmin: 1.0,
                        ..Perturbation::NONE
                    }
                };
                budget.push((name.to_string(), moved(p)?.abs() * sigma));
            }
        }
        if self.input.dr_uncertainty_nm > 0.0 {
            budget.push((
                "DR position".to_string(),
                dr_north.hypot(dr_east) * self.input.dr_uncertainty_nm / 10.0,
            ));
        }
        let sigma_d = budget.iter().map(|(_, v)| v * v).sum::<f64>().sqrt();
        let sigma_s = if per_s > 0.0 {
            sigma_d / per_s
        } else {
            f64::INFINITY
        };
        let error_budget = budget
            .into_iter()
            .map(|(name, v)| LunarErrorTerm {
                name,
                distance_arcmin: v,
                time_s: if per_s > 0.0 {
                    v / per_s
                } else {
                    f64::INFINITY
                },
            })
            .collect();

        let mut notes = vec![
            "cleared rigorously: semidiameters from the refracted discs, refraction removed \
             along the vertical, parallax removed with the observer on the WGS84 ellipsoid \
             (docs/NAVIGATION_SKY.md)"
                .to_string(),
            format!(
                "one arcminute of distance is {:.0} s of time here, and one second of time is \
                 {:.3}' of longitude",
                if per_s > 0.0 {
                    1.0 / per_s
                } else {
                    f64::INFINITY
                },
                LONGITUDE_ARCMIN_PER_S
            ),
        ];
        if g_rate.abs() < SLOW_RATE_ARCMIN_PER_MIN {
            warnings.push(Warning::Other {
                message: format!(
                    "lunar distance to {}: the distance changes only {:.2}' per minute here, so \
                     each 0.1' of error is {:.0} s of time; a body nearer the Moon's path \
                     makes a better clock",
                    self.body,
                    g_rate.abs(),
                    6.0 / g_rate.abs().max(1e-9)
                ),
            });
        }
        if c.triangle_clamped {
            warnings.push(Warning::Other {
                message: format!(
                    "lunar distance to {}: the distance and the two altitudes do not form a \
                     triangle (an altitude or the distance is off); the distance was cleared \
                     with Borda's formula, which does not need the triangle to close, and the \
                     parallax with the nearest triangle that does",
                    self.body
                ),
            });
        }
        if !others.is_empty() {
            warnings.push(Warning::Other {
                message: format!(
                    "lunar distance to {}: the same distance also occurs at {} within the \
                     search window; the instant nearest the watch's estimate was taken",
                    self.body,
                    others
                        .iter()
                        .map(|t| format_utc(*t))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
        }
        for (name, obs, observed, computed) in [
            (
                "Moon",
                self.moon_ha,
                c.moon_apparent_deg,
                c.moon_computed_apparent_deg,
            ),
            (
                self.body.as_str(),
                self.body_ha,
                c.body_apparent_deg,
                c.body_computed_apparent_deg,
            ),
        ] {
            if obs.is_some() && computed.is_finite() {
                let diff = (observed - computed) * 60.0;
                if diff.abs() > 30.0 {
                    notes.push(format!(
                        "the observed {name} altitude is {diff:+.0}' from the one computed at \
                         the DR position for the instant found: the DR position is well off, \
                         or the altitude belongs to another moment"
                    ));
                }
            }
        }

        let clearing = vec![
            step(
                "index_correction",
                self.input.distance_deg,
                c.distance_deg,
                format!(
                    "index correction {:+.2}' added to the sextant reading",
                    self.input.instrument.index_correction_arcmin
                ),
            ),
            step(
                "moon_semidiameter",
                c.distance_deg,
                c.distance_deg + c.moon_offset_arcmin / 60.0,
                format!(
                    "Moon's {} limb: topocentric semidiameter along the arc, refracted disc \
                     ({:+.3}')",
                    limb_name(self.moon_limb),
                    c.moon_offset_arcmin
                ),
            ),
            step(
                "body_semidiameter",
                c.distance_deg + c.moon_offset_arcmin / 60.0,
                c.apparent_deg,
                if self.body_limb == LunarLimb::Center {
                    format!("{}: a point, no semidiameter", self.body)
                } else {
                    format!(
                        "{}'s {} limb: semidiameter along the arc, refracted disc ({:+.3}')",
                        self.body,
                        limb_name(self.body_limb),
                        c.body_offset_arcmin
                    )
                },
            ),
            step(
                "refraction",
                c.apparent_deg,
                c.topocentric_deg,
                format!(
                    "refraction removed: Moon at {:.2} deg apparent, {} at {:.2} deg",
                    c.moon_apparent_deg, self.body, c.body_apparent_deg
                ),
            ),
            step(
                "parallax",
                c.topocentric_deg,
                c.cleared_deg,
                "parallax removed with the observer on the WGS84 ellipsoid at the DR position"
                    .to_string(),
            ),
        ];
        let lat = self.input.observer.lat_deg.to_radians().cos();
        Ok(LunarDistanceResult {
            body: self.body.clone(),
            jd_utc: t,
            utc: format_utc(t),
            utc_minus_estimate_s: (t - jd0) * 86_400.0,
            sigma_s,
            longitude_sigma_arcmin: sigma_s * LONGITUDE_ARCMIN_PER_S,
            longitude_sigma_nm: sigma_s * LONGITUDE_ARCMIN_PER_S * lat,
            apparent_distance_deg: c.apparent_deg,
            cleared_distance_deg: c.cleared_deg,
            distance_rate_arcmin_per_min: d_rate,
            clearing,
            altitudes: LunarAltitudes {
                moon_source: source_name(self.moon_ha.is_some()),
                body_source: source_name(self.body_ha.is_some()),
                moon_apparent_deg: c.moon_apparent_deg,
                body_apparent_deg: c.body_apparent_deg,
                moon_true_deg: c.moon_true_deg,
                body_true_deg: c.body_true_deg,
                moon_azimuth_deg: c.moon_az_deg,
                body_azimuth_deg: c.body_az_deg,
                moon_computed_apparent_deg: c.moon_computed_apparent_deg,
                body_computed_apparent_deg: c.body_computed_apparent_deg,
            },
            error_budget,
            dr_sensitivity_arcmin_per_10nm: [dr_north, dr_east],
            alternatives: others
                .iter()
                .map(|t| LunarAlternative {
                    jd_utc: *t,
                    utc: format_utc(*t),
                })
                .collect(),
            warnings,
            notes,
        })
    }
}

fn step(kind: &str, before: f64, after: f64, note: String) -> LunarClearingStep {
    LunarClearingStep {
        kind: kind.to_string(),
        before_deg: before,
        after_deg: after,
        delta_arcmin: (after - before) * 60.0,
        note,
    }
}

fn limb_name(l: LunarLimb) -> &'static str {
    match l {
        LunarLimb::Near => "near",
        LunarLimb::Far => "far",
        LunarLimb::Center => "centre",
    }
}

fn source_name(observed: bool) -> String {
    if observed { "observed" } else { "computed" }.to_string()
}

fn check_observer(o: &SightObserver) -> Result<(), SkyfixError> {
    for (field, v) in [
        ("observer.lat_deg", o.lat_deg),
        ("observer.lon_deg", o.lon_deg),
        ("observer.height_of_eye_m", o.height_of_eye_m),
        ("observer.pressure_hpa", o.pressure_hpa),
        ("observer.temperature_c", o.temperature_c),
    ] {
        if !v.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: field.to_string(),
            });
        }
    }
    if !(-90.0..=90.0).contains(&o.lat_deg) || !(-180.0..=180.0).contains(&o.lon_deg) {
        return Err(SkyfixError::InvalidField {
            field: "observer".to_string(),
            message: "latitude must be in [-90, 90] and longitude in [-180, 180]".to_string(),
        });
    }
    if o.height_of_eye_m < 0.0 || o.pressure_hpa <= 0.0 || 273.0 + o.temperature_c <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "observer".to_string(),
            message: "height of eye must be >= 0, pressure positive, temperature above -273 C"
                .to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o() -> SightObserver {
        SightObserver {
            lat_deg: 30.0,
            lon_deg: -40.0,
            height_of_eye_m: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        }
    }

    #[test]
    fn the_refraction_inverse_undoes_bennett() {
        for h_app in [0.0, 0.5, 3.0, 10.0, 45.0, 89.0] {
            let h_true = h_app - corrections::refraction_arcmin(h_app, 1010.0, 10.0) / 60.0;
            let back = apparent_from_true(h_true, &o(), 1.0).unwrap();
            assert!((back - h_app).abs() < 1e-10, "{h_app}: {back}");
        }
        assert!(apparent_from_true(-1.0, &o(), 1.0).is_none());
    }

    #[test]
    fn a_disc_high_in_the_sky_offsets_by_its_semidiameter() {
        // At 60 degrees refraction hardly squeezes the disc: the near limb is SD nearer.
        let target = enu_from_alt_az(60.0, 90.0);
        let near = limb_offset((60.0, 40.0), 16.0, target, false, &o(), 1.0);
        let far = limb_offset((60.0, 40.0), 16.0, target, true, &o(), 1.0);
        assert!((near - 16.0).abs() < 0.01, "{near}");
        assert!((far + 16.0).abs() < 0.01, "{far}");
    }

    #[test]
    fn a_low_disc_is_squeezed_vertically_but_not_sideways() {
        // At 5 degrees apparent the vertical semidiameter is about 0.5' short; a target
        // due east along the horizon sees nearly the full semidiameter.
        let sideways = limb_offset(
            (5.0, 90.0),
            16.0,
            enu_from_alt_az(5.0, 150.0),
            false,
            &o(),
            1.0,
        );
        let upward = limb_offset(
            (5.0, 90.0),
            16.0,
            enu_from_alt_az(60.0, 90.0),
            false,
            &o(),
            1.0,
        );
        assert!((sideways - 16.0).abs() < 0.05, "{sideways}");
        assert!(upward < 15.8 && upward > 15.0, "{upward}");
    }
}
