//! Noon sight: latitude, and a weak longitude, from altitudes around meridian passage.
//!
//! `docs/NAVIGATION_METHODS.md` section 2 is normative; this is a summary.
//!
//! # The model
//!
//! Near upper meridian passage `T` (the instant `LHA = 0`, CONVENTIONS 13.3) the
//! altitude of a body follows
//!
//! ```text
//! h(t) = H0 + a (t - T) - k (t - T)^2 + (higher order)
//! k    = (1/2) w^2 cos(phi) cos(dec) / cos(H0)      w = d(LHA)/dt
//! a    = d(H0)/dt                                   declination change, vessel N-S run
//! ```
//!
//! and the latitude follows from the meridian altitude exactly (on the sphere,
//! `sin H0 = cos(phi - dec)` at `LHA = 0`): `phi = dec + (90 - H0)` when the body is
//! south of the zenith, `dec - (90 - H0)` when it is north.
//!
//! **Predicted curvature (the default).** The curve is not approximated at all: the
//! unknowns are the observer's latitude and longitude at `T`, the model altitude of
//! each sight is the exact spherical `Hc` (CONVENTIONS 3) from the sight's own
//! direction, with the observer moved along the DR track when the vessel is under
//! way, and the fit is weighted Gauss-Newton. `k` and `a` are then *reported* from
//! that exact curve. This also covers the cases the parabola gets wrong: sights far
//! from noon, and a body near the zenith, where the curve is V-shaped.
//!
//! **Fitted curvature (three or more sights).** The classic free parabola
//! `c0 + c1 t + c2 t^2`, fitted after removing the exact curve's non-parabolic
//! remainder, so that only the curvature is set free. `k_fit = -c2` is compared with
//! the predicted `k`, and `|z| > 3` raises [`Warning::CurvatureInconsistent`].
//!
//! **One altitude.** By default it is the recorded peak (`maximum`): `H0 = Ho - a^2/4k`.
//! With `ex_meridian` it is solved on the DR meridian at the recorded time, and its
//! sigma includes the DR longitude's uncertainty through `d(phi)/dE`.
//!
//! # Why the longitude is weak
//!
//! The longitude is `-GHA(T)`: the whole of it rests on *when* the flat top of the
//! curve happened. Every result that reports one also carries
//! [`Warning::FlatPeakLongitude`] and a plain-language `longitude_caveat`.

use super::{
    BodyTrack, MINUTES_PER_DAY, SECONDS_PER_DAY, THREE_SIGMA, check_dr, check_vessel,
    clock_sigma_s, dr_move, fmt_dm, fmt_lat, fmt_signed, hc_zn, inverse_2x2,
    latitudes_for_altitude, meridian_passage, nothing_usable, one_body, reduce_all, resolve_dr,
};
use crate::SkyfixError;
use crate::geometry::{Point, apply_tangent_step};
use crate::reduce::DirectionSource;
use crate::time::format_utc;
use crate::types::{
    BodyBearing, CurvatureReport, CurveMaximum, CurvePoint, DrPosition, GeocentricDirection,
    LatitudeEstimate, LongitudeEstimate, MeridianSide, NoonAlternative, NoonCurvature, NoonDrCheck,
    NoonMethod, NoonSightOptions, NoonSightResult, ReducedSight, RunResidual, Session,
    SingleAltitudeMode, TimeEstimate, VesselMotion, Warning,
};
use crate::units::{arcmin_to_rad, norm_180, rad_to_arcmin};

/// Condition number of the two-unknown normal matrix above which the run cannot time
/// the peak, and the method falls back to latitude only (the CONVENTIONS 9 limit).
pub const CONDITION_LIMIT: f64 = 1e6;
/// Meridian altitude above which [`Warning::MeridianNearZenith`] is raised, degrees.
pub const NEAR_ZENITH_DEG: f64 = 85.0;
/// A single "maximum" altitude recorded further than this from the DR's predicted
/// meridian passage (plus three times that prediction's sigma) is flagged, minutes.
pub const MAXIMUM_TIMING_MINUTES: f64 = 15.0;
/// Points in `model_curve`.
const CURVE_POINTS: usize = 49;

/// Latitude, time of meridian passage and longitude from a run of altitudes of one body
/// around meridian passage. See the module docs and docs/NAVIGATION_METHODS.md.
pub fn noon_sight(
    session: &Session,
    source: &dyn DirectionSource,
    options: &NoonSightOptions,
) -> Result<NoonSightResult, SkyfixError> {
    let (sights, mut warnings) = reduce_all(session, source);
    if sights.is_empty() {
        return Err(nothing_usable(
            "a noon sight",
            session.observations.len(),
            &warnings,
        ));
    }
    let body = one_body(&sights, "a noon sight")?;
    let dr = resolve_dr(options.dr, session).ok_or_else(|| SkyfixError::InvalidField {
        field: "options.dr".to_string(),
        message: "a noon sight needs a DR position (options.dr, or the session's assumed \
                  position): it decides which side of the zenith the body passed and when \
                  noon should be"
            .to_string(),
    })?;
    check_dr(&dr)?;
    check_vessel(options.vessel)?;
    let track = BodyTrack::new(&body, &sights, source);
    let run = Run::new(
        body,
        sights,
        track,
        options.vessel,
        dr,
        clock_sigma_s(session),
    );

    let t_dr = run.dr_passage();
    let side = run.choose_side(options.body_bearing, t_dr);

    let n = run.sights.len();
    let mut result = if n == 1 {
        match options.single_altitude {
            SingleAltitudeMode::Maximum => run.single_maximum(side, t_dr),
            SingleAltitudeMode::ExMeridian => run.ex_meridian(side, t_dr)?,
        }
    } else {
        let exact = run.curve_fit(side, t_dr);
        match exact {
            Some(exact) => {
                let free = if n >= 3 { run.free_fit(&exact) } else { None };
                if options.curvature == NoonCurvature::Fitted && n < 3 {
                    warnings.push(Warning::Other {
                        message: format!(
                            "a fitted curvature needs three or more sights and this run has \
                             {n}; the curvature predicted from the geometry was used"
                        ),
                    });
                }
                run.assemble_curve(exact, free, options.curvature, &mut warnings)
            }
            None => {
                warnings.push(Warning::Other {
                    message: "these sights span too little of the curve to time the peak \
                              (the two-unknown fit is singular), so only the latitude is \
                              reported, reducing each sight to the meridian with your DR \
                              longitude"
                        .to_string(),
                });
                run.ex_meridian(side, t_dr)?
            }
        }
    };

    run.common_warnings(&mut result, options.body_bearing, t_dr, &mut warnings);
    warnings.append(&mut result.warnings);
    result.warnings = warnings;
    Ok(result)
}

// ---------------------------------------------------------------------------
// The run and its exact model
// ---------------------------------------------------------------------------

struct Run<'a> {
    body: String,
    sights: Vec<ReducedSight>,
    track: BodyTrack<'a>,
    vessel: Option<VesselMotion>,
    dr: DrPosition,
    /// The DR position, taken to be for `t_mid`.
    dr_point: Point,
    t_mid: f64,
    clock_sigma_s: f64,
}

/// A position fit with the exact model.
#[derive(Debug, Clone)]
struct PositionFit {
    /// Observer at `t_ref`.
    p: Point,
    t_ref: f64,
    /// `(J^T W J)^-1`, radians squared, (north, east). Latitude-only fits leave the east
    /// entries at zero.
    cov: [[f64; 2]; 2],
    chi2: f64,
    /// Sum of `w cos Zn sin Zn` and `w cos^2 Zn`, for the latitude-only sensitivity.
    cross: f64,
    nn: f64,
}

/// The free-curvature parabola and what follows from it.
#[derive(Debug, Clone)]
struct FreeSolution {
    lat_deg: f64,
    lat_sigma_arcmin: f64,
    h0_deg: f64,
    passage_jd: f64,
    passage_sigma_fit_s: f64,
    lon_deg: f64,
    lon_sigma_fit_arcmin: f64,
    k: f64,
    k_sigma: f64,
    vertex_minutes_after_passage: f64,
    h_max_deg: f64,
    chi2: f64,
    dof: i64,
    /// `(c0, c1, c2)` in the minutes-from-exact-passage frame, and the exact curve's
    /// `(H0, a, k)` the remainder was taken against.
    coeffs: [f64; 3],
    exact_shape: [f64; 3],
    exact_passage: f64,
    exact_p: Point,
}

impl<'a> Run<'a> {
    fn new(
        body: String,
        sights: Vec<ReducedSight>,
        track: BodyTrack<'a>,
        vessel: Option<VesselMotion>,
        dr: DrPosition,
        clock_sigma_s: f64,
    ) -> Self {
        let t_mid = sights.iter().map(|s| s.jd_utc).sum::<f64>() / sights.len().max(1) as f64;
        Run {
            body,
            sights,
            track,
            vessel,
            dr_point: Point::from_deg(dr.lat_deg, dr.lon_deg),
            dr,
            t_mid,
            clock_sigma_s,
        }
    }

    fn at(&self, p_ref: Point, t_ref: f64, t: f64) -> Point {
        dr_move(p_ref, self.vessel, (t - t_ref) * 24.0)
    }

    fn dr_at(&self, t: f64) -> Point {
        self.at(self.dr_point, self.t_mid, t)
    }

    /// Exact altitude (radians) at `t` for an observer who is at `p_ref` at `t_ref`.
    fn curve(&self, p_ref: Point, t_ref: f64, t: f64) -> f64 {
        hc_zn(self.at(p_ref, t_ref, t), &self.track.direction(t)).0
    }

    /// Exact altitude and azimuth of sight `i` from its own direction.
    fn sight_model(&self, p_ref: Point, t_ref: f64, i: usize) -> (f64, f64) {
        let s = &self.sights[i];
        let d = GeocentricDirection {
            gha_deg: s.gha_deg,
            dec_deg: s.dec_deg,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        };
        hc_zn(self.at(p_ref, t_ref, s.jd_utc), &d)
    }

    fn passage(&self, p_ref: Point, t_ref: f64, t_guess: f64) -> Option<f64> {
        meridian_passage(
            &self.track,
            &|t| self.at(p_ref, t_ref, t).lon_deg(),
            t_guess,
        )
    }

    /// Meridian passage predicted from the DR longitude.
    fn dr_passage(&self) -> f64 {
        self.passage(self.dr_point, self.t_mid, self.t_mid)
            .unwrap_or(self.t_mid)
    }

    /// Rate `a` (arcmin/min) and curvature `k` (arcmin/min^2, positive for a peak) of
    /// the exact curve at `t`.
    fn shape(&self, p_ref: Point, t_ref: f64, t: f64) -> (f64, f64) {
        let step_min = 2.0;
        let h = step_min / MINUTES_PER_DAY;
        let hm = rad_to_arcmin(self.curve(p_ref, t_ref, t - h));
        let h0 = rad_to_arcmin(self.curve(p_ref, t_ref, t));
        let hp = rad_to_arcmin(self.curve(p_ref, t_ref, t + h));
        (
            (hp - hm) / (2.0 * step_min),
            -(hp - 2.0 * h0 + hm) / (2.0 * step_min * step_min),
        )
    }

    /// Rate of the body's GHA, arcminutes of arc per second of time.
    fn gha_rate_arcmin_per_s(&self, t: f64) -> f64 {
        self.track.gha_rate_deg_per_day(t) * 60.0 / SECONDS_PER_DAY
    }

    /// Rate of the LHA seen by the (possibly moving) observer, degrees per second.
    fn lha_rate_deg_per_s(&self, p_ref: Point, t_ref: f64, t: f64) -> f64 {
        let h = 30.0 / SECONDS_PER_DAY;
        let lha = |t: f64| self.track.direction(t).gha_deg + self.at(p_ref, t_ref, t).lon_deg();
        norm_180(lha(t + h) - lha(t - h)) / 60.0
    }

    fn choose_side(&self, bearing: BodyBearing, t_dr: f64) -> MeridianSide {
        match bearing {
            BodyBearing::North => MeridianSide::North,
            BodyBearing::South => MeridianSide::South,
            BodyBearing::Auto => {
                let dec = self.track.direction(t_dr).dec_deg;
                if self.dr_at(t_dr).lat_deg() >= dec {
                    MeridianSide::South
                } else {
                    MeridianSide::North
                }
            }
        }
    }

    // --- the exact fit -----------------------------------------------------

    fn chi2_at(&self, p: Point, t_ref: f64) -> f64 {
        (0..self.sights.len())
            .map(|i| {
                let (h, _) = self.sight_model(p, t_ref, i);
                let u = (self.sights[i].ho_deg.to_radians() - h)
                    / arcmin_to_rad(self.sights[i].sigma_arcmin);
                u * u
            })
            .sum()
    }

    /// `J^T W J` and `J^T W r` in the tangent plane (north, east).
    fn normal(&self, p: Point, t_ref: f64) -> ([[f64; 2]; 2], [f64; 2]) {
        let mut a = [[0.0; 2]; 2];
        let mut g = [0.0; 2];
        for (i, s) in self.sights.iter().enumerate() {
            let (h, zn) = self.sight_model(p, t_ref, i);
            let sigma = arcmin_to_rad(s.sigma_arcmin);
            let w = 1.0 / (sigma * sigma);
            let row = [zn.cos(), zn.sin()];
            let r = s.ho_deg.to_radians() - h;
            for j in 0..2 {
                g[j] += w * row[j] * r;
                for k in 0..2 {
                    a[j][k] += w * row[j] * row[k];
                }
            }
        }
        (a, g)
    }

    /// Weighted Gauss-Newton with step halving, from `p0` at `t_ref`. With
    /// `free_east = false` only the latitude moves (the ex-meridian solution).
    fn fit(&self, p0: Point, t_ref: f64, free_east: bool) -> Option<PositionFit> {
        let mut p = p0;
        let mut chi2 = self.chi2_at(p, t_ref);
        if !chi2.is_finite() {
            return None;
        }
        for _ in 0..80 {
            let (a, g) = self.normal(p, t_ref);
            let (dn, de) = if free_east {
                let (inv, cond) = inverse_2x2(a)?;
                if cond > CONDITION_LIMIT {
                    return None;
                }
                (
                    inv[0][0] * g[0] + inv[0][1] * g[1],
                    inv[1][0] * g[0] + inv[1][1] * g[1],
                )
            } else {
                if a[0][0].is_nan() || a[0][0] <= 0.0 {
                    return None;
                }
                (g[0] / a[0][0], 0.0)
            };
            if !dn.is_finite() || !de.is_finite() {
                return None;
            }
            let mut scale = 1.0;
            let mut moved = false;
            for _ in 0..30 {
                let trial = apply_tangent_step(p, scale * dn, scale * de);
                let c = self.chi2_at(trial, t_ref);
                if c.is_finite() && c <= chi2 {
                    p = trial;
                    chi2 = c;
                    moved = true;
                    break;
                }
                scale *= 0.5;
            }
            if !moved || scale * dn.hypot(de) < 1e-13 {
                break;
            }
        }
        let (a, _) = self.normal(p, t_ref);
        let cov = if free_east {
            let (inv, cond) = inverse_2x2(a)?;
            if cond > CONDITION_LIMIT {
                return None;
            }
            inv
        } else {
            if a[0][0].is_nan() || a[0][0] <= 0.0 {
                return None;
            }
            [[1.0 / a[0][0], 0.0], [0.0, 0.0]]
        };
        Some(PositionFit {
            p,
            t_ref,
            cov,
            chi2,
            cross: a[0][1],
            nn: a[0][0],
        })
    }

    /// Latitude and longitude at meridian passage from the exact curve.
    fn curve_fit(&self, side: MeridianSide, t_dr: f64) -> Option<PositionFit> {
        let best = self
            .sights
            .iter()
            .max_by(|a, b| a.ho_deg.total_cmp(&b.ho_deg))?;
        let dec = self.track.direction(t_dr).dec_deg;
        let lat0 = (dec + side_sign(side) * (90.0 - best.ho_deg)).clamp(-89.9, 89.9);
        let p0 = Point::from_deg(lat0, self.dr_at(t_dr).lon_deg());
        let mut fit = self.fit(p0, t_dr, true)?;
        // Re-centre on the fitted meridian passage so the reported position (and its
        // covariance) is the one at the instant LHA = 0.
        for _ in 0..6 {
            let t = self.passage(fit.p, fit.t_ref, fit.t_ref)?;
            if (t - fit.t_ref).abs() < 1e-9 {
                break;
            }
            let p_t = self.at(fit.p, fit.t_ref, t);
            fit = self.fit(p_t, t, true)?;
        }
        Some(fit)
    }

    /// The free-curvature parabola on the exact curve's remainder (N >= 3).
    fn free_fit(&self, exact: &PositionFit) -> Option<FreeSolution> {
        let t_pass = exact.t_ref;
        let p = exact.p;
        let h0 = rad_to_arcmin(self.curve(p, t_pass, t_pass));
        let (a, k) = self.shape(p, t_pass, t_pass);
        let mut ata = vec![vec![0.0; 3]; 3];
        let mut atb = [0.0; 3];
        let mut rows = Vec::with_capacity(self.sights.len());
        for (i, s) in self.sights.iter().enumerate() {
            let tau = (s.jd_utc - t_pass) * MINUTES_PER_DAY;
            let exact_i = rad_to_arcmin(self.sight_model(p, t_pass, i).0);
            let remainder = exact_i - (h0 + a * tau - k * tau * tau);
            let y = s.ho_deg * 60.0 - remainder;
            let w = 1.0 / (s.sigma_arcmin * s.sigma_arcmin);
            let basis = [1.0, tau, tau * tau];
            for j in 0..3 {
                atb[j] += w * basis[j] * y;
                for m in 0..3 {
                    ata[j][m] += w * basis[j] * basis[m];
                }
            }
            rows.push((basis, y, w));
        }
        let cov = crate::linalg::invert_sym_pd(&ata)?;
        let c: Vec<f64> = (0..3)
            .map(|j| (0..3).map(|m| cov[j][m] * atb[m]).sum())
            .collect();
        let (c0, c1, c2) = (c[0], c[1], c[2]);
        let k_fit = -c2;
        let k_sigma = cov[2][2].max(0.0).sqrt();
        if !k_fit.is_finite() || k_fit <= 0.0 {
            return None;
        }
        let chi2: f64 = rows
            .iter()
            .map(|(b, y, w)| {
                let r = y - (c0 * b[0] + c1 * b[1] + c2 * b[2]);
                w * r * r
            })
            .sum();
        // Meridian passage and meridian altitude from the parabola, with the rate `a`
        // of the meridian altitude taken from the geometry (docs, section 2.3).
        let tau_m = (c1 - a) / (2.0 * k_fit);
        let h0_free = c0 + (c1 * c1 - a * a) / (4.0 * k_fit);
        let d_tau = [0.0, 1.0 / (2.0 * k_fit), (c1 - a) / (2.0 * k_fit * k_fit)];
        let d_h0 = [
            1.0,
            c1 / (2.0 * k_fit),
            (c1 * c1 - a * a) / (4.0 * k_fit * k_fit),
        ];
        let quad = |u: &[f64; 3], v: &[f64; 3]| -> f64 {
            (0..3)
                .map(|j| (0..3).map(|m| u[j] * cov[j][m] * v[m]).sum::<f64>())
                .sum()
        };
        let sigma_tau_min = quad(&d_tau, &d_tau).max(0.0).sqrt();
        let sigma_h0 = quad(&d_h0, &d_h0).max(0.0).sqrt();

        let passage = t_pass + tau_m / MINUTES_PER_DAY;
        let dec = self.track.direction(passage).dec_deg;
        let side = if p.lat_deg() >= dec {
            MeridianSide::South
        } else {
            MeridianSide::North
        };
        let lat = dec + side_sign(side) * (90.0 - h0_free / 60.0);
        let lon = norm_180(-self.track.direction(passage).gha_deg);
        let sigma_t_s = sigma_tau_min * 60.0;
        let lon_sigma = self.gha_rate_arcmin_per_s(passage).abs() * sigma_t_s;
        let vertex = c1 / (2.0 * k_fit);
        Some(FreeSolution {
            lat_deg: lat,
            lat_sigma_arcmin: sigma_h0,
            h0_deg: h0_free / 60.0,
            passage_jd: passage,
            passage_sigma_fit_s: sigma_t_s,
            lon_deg: lon,
            lon_sigma_fit_arcmin: lon_sigma,
            k: k_fit,
            k_sigma,
            vertex_minutes_after_passage: vertex - tau_m,
            h_max_deg: (c0 + c1 * c1 / (4.0 * k_fit)) / 60.0,
            chi2,
            dof: self.sights.len() as i64 - 3,
            coeffs: [c0, c1, c2],
            exact_shape: [h0, a, k],
            exact_passage: t_pass,
            exact_p: p,
        })
    }

    /// The free parabola's model altitude (degrees) at `t`, remainder included.
    fn free_curve_deg(&self, f: &FreeSolution, t: f64) -> f64 {
        let tau = (t - f.exact_passage) * MINUTES_PER_DAY;
        let [h0, a, k] = f.exact_shape;
        let exact = rad_to_arcmin(self.curve(f.exact_p, f.exact_passage, t));
        let remainder = exact - (h0 + a * tau - k * tau * tau);
        let [c0, c1, c2] = f.coeffs;
        (c0 + c1 * tau + c2 * tau * tau + remainder) / 60.0
    }

    // --- assembling a curve result -------------------------------------------

    fn assemble_curve(
        &self,
        exact: PositionFit,
        free: Option<FreeSolution>,
        curvature: NoonCurvature,
        warnings: &mut Vec<Warning>,
    ) -> NoonSightResult {
        let t_pass = exact.t_ref;
        let p = exact.p;
        let (a, k) = self.shape(p, t_pass, t_pass);
        let dec = self.track.direction(t_pass).dec_deg;
        let lat = p.lat_deg();
        let h0 = 90.0 - (lat - dec).abs();

        let clock = self.clock_sigma_s;
        let gha_rate = self.gha_rate_arcmin_per_s(t_pass).abs();
        let lha_rate = self.lha_rate_deg_per_s(p, t_pass, t_pass).abs();
        let cos_lat = p.lat.cos().abs().max(1e-12);
        let lon_fit = rad_to_arcmin(exact.cov[1][1].max(0.0).sqrt() / cos_lat);
        let lon_clock = gha_rate * clock;
        let exact_lon = LongitudeEstimate {
            lon_deg: p.lon_deg(),
            sigma_arcmin: lon_fit.hypot(lon_clock),
            sigma_nm: lon_fit.hypot(lon_clock) * cos_lat,
            clock_sigma_arcmin: lon_clock,
        };
        let exact_t_sigma = (lon_fit / 60.0 / lha_rate.max(1e-12)).hypot(clock);
        let exact_lat = LatitudeEstimate {
            lat_deg: lat,
            sigma_arcmin: rad_to_arcmin(exact.cov[0][0].max(0.0).sqrt()),
        };
        let exact_dof = self.sights.len() as i64 - 2;

        let free_report = free.as_ref().map(|f| {
            let z = (f.k - k) / f.k_sigma.max(1e-300);
            (f.k, f.k_sigma, z)
        });
        if let Some((kf, _, z)) = free_report
            && z.abs() > THREE_SIGMA
        {
            warnings.push(Warning::CurvatureInconsistent {
                body: self.body.clone(),
                predicted_arcmin_per_min2: k,
                fitted_arcmin_per_min2: kf,
                z,
            });
        }
        let curvature_report = CurvatureReport {
            predicted_arcmin_per_min2: k,
            rate_at_passage_arcmin_per_min: a,
            max_minus_meridian_arcmin: if k > 0.0 { a * a / (4.0 * k) } else { 0.0 },
            fitted_arcmin_per_min2: free_report.map(|r| r.0),
            fitted_sigma_arcmin_per_min2: free_report.map(|r| r.1),
            z: free_report.map(|r| r.2),
            consistent: free_report.map(|r| r.2.abs() <= THREE_SIGMA),
        };

        let free_answers = free.as_ref().map(|f| {
            let lon_clock = self.gha_rate_arcmin_per_s(f.passage_jd).abs() * clock;
            let cos_f = f.lat_deg.to_radians().cos().abs().max(1e-12);
            let sigma = f.lon_sigma_fit_arcmin.hypot(lon_clock);
            (
                LatitudeEstimate {
                    lat_deg: f.lat_deg,
                    sigma_arcmin: f.lat_sigma_arcmin,
                },
                TimeEstimate {
                    utc: format_utc(f.passage_jd),
                    jd_utc: f.passage_jd,
                    sigma_s: f.passage_sigma_fit_s.hypot(clock),
                },
                LongitudeEstimate {
                    lon_deg: f.lon_deg,
                    sigma_arcmin: sigma,
                    sigma_nm: sigma * cos_f,
                    clock_sigma_arcmin: lon_clock,
                },
            )
        });

        let exact_passage = TimeEstimate {
            utc: format_utc(t_pass),
            jd_utc: t_pass,
            sigma_s: exact_t_sigma,
        };
        let use_free = curvature == NoonCurvature::Fitted && free.is_some();

        let (method, latitude, h0_out, passage, longitude, chi2, dof, alternative) =
            if let (true, Some(f), Some((flat, fpass, flon))) =
                (use_free, free.as_ref(), free_answers.clone())
            {
                (
                    NoonMethod::CurveFitFreeCurvature,
                    flat,
                    f.h0_deg,
                    fpass,
                    flon,
                    f.chi2,
                    f.dof,
                    Some(NoonAlternative {
                        method: NoonMethod::CurveFit,
                        latitude: exact_lat,
                        meridian_altitude_deg: h0,
                        meridian_passage: Some(exact_passage.clone()),
                        longitude: Some(exact_lon),
                        chi2: exact.chi2,
                        dof: exact_dof,
                    }),
                )
            } else {
                (
                    NoonMethod::CurveFit,
                    exact_lat,
                    h0,
                    exact_passage.clone(),
                    exact_lon,
                    exact.chi2,
                    exact_dof,
                    free.as_ref()
                        .zip(free_answers.clone())
                        .map(|(f, (flat, fpass, flon))| NoonAlternative {
                            method: NoonMethod::CurveFitFreeCurvature,
                            latitude: flat,
                            meridian_altitude_deg: f.h0_deg,
                            meridian_passage: Some(fpass),
                            longitude: Some(flon),
                            chi2: f.chi2,
                            dof: f.dof,
                        }),
                )
            };
        let passage_jd = passage.jd_utc;
        let dec_out = self.track.direction(passage_jd).dec_deg;
        let side_out = if latitude.lat_deg >= dec_out {
            MeridianSide::South
        } else {
            MeridianSide::North
        };

        // Residuals and the plotted curve come from the chosen model.
        let (residuals, model_curve, maximum) = if use_free {
            let f = free.as_ref().expect("use_free implies a free fit");
            let residuals = self.residuals(passage_jd, |_, s| self.free_curve_deg(f, s.jd_utc));
            let curve = self.sample_curve(passage_jd, |t| self.free_curve_deg(f, t));
            let t_max = passage_jd + f.vertex_minutes_after_passage / MINUTES_PER_DAY;
            let maximum = CurveMaximum {
                utc: format_utc(t_max),
                jd_utc: t_max,
                altitude_deg: f.h_max_deg,
                seconds_after_passage: f.vertex_minutes_after_passage * 60.0,
            };
            (residuals, curve, Some(maximum))
        } else {
            let residuals = self.residuals(passage_jd, |i, _| {
                self.sight_model(p, t_pass, i).0.to_degrees()
            });
            let curve = self.sample_curve(passage_jd, |t| self.curve(p, t_pass, t).to_degrees());
            (residuals, curve, Some(self.exact_maximum(p, t_pass, a, k)))
        };

        let lat_rule = latitude_rule(&self.body, side_out, h0_out, dec_out, latitude.lat_deg);
        let caveat = flat_peak_caveat(&self.body, k, &passage, &longitude);
        warnings.push(Warning::FlatPeakLongitude {
            body: self.body.clone(),
            sigma_time_s: passage.sigma_s,
            sigma_lon_arcmin: longitude.sigma_arcmin,
            sigma_east_nm: longitude.sigma_nm,
        });
        let before = self.sights.iter().filter(|s| s.jd_utc < passage_jd).count();
        let after = self.sights.len() - before;
        if before == 0 || after == 0 {
            warnings.push(Warning::OneSidedRun {
                body: self.body.clone(),
                before,
                after,
            });
        }
        let dr_check = self.dr_check(passage_jd, latitude.lat_deg, Some(longitude.lon_deg));

        NoonSightResult {
            body: self.body.clone(),
            method,
            n_sights: self.sights.len(),
            side: side_out,
            latitude,
            meridian_altitude_deg: h0_out,
            declination_deg: dec_out,
            zenith_distance_deg: 90.0 - h0_out,
            latitude_rule: lat_rule,
            meridian_passage: Some(passage),
            longitude: Some(longitude),
            longitude_caveat: caveat,
            longitude_sensitivity_arcmin_per_nm: None,
            maximum,
            curvature: curvature_report,
            alternative,
            dr_check,
            chi2,
            dof,
            residuals,
            model_curve,
            sights: self.sights.clone(),
            warnings: Vec::new(),
        }
    }

    /// The highest point of the exact curve, by Newton on its slope.
    fn exact_maximum(&self, p: Point, t_pass: f64, a: f64, k: f64) -> CurveMaximum {
        let mut t = t_pass;
        if k > 0.0 {
            t += a / (2.0 * k) / MINUTES_PER_DAY;
            for _ in 0..6 {
                let (slope, curv) = self.shape(p, t_pass, t);
                if curv.is_nan() || curv <= 0.0 {
                    break;
                }
                let step = slope / (2.0 * curv) / MINUTES_PER_DAY;
                t += step;
                if step.abs() < 1e-10 {
                    break;
                }
            }
        }
        CurveMaximum {
            utc: format_utc(t),
            jd_utc: t,
            altitude_deg: self.curve(p, t_pass, t).to_degrees(),
            seconds_after_passage: (t - t_pass) * SECONDS_PER_DAY,
        }
    }

    fn residuals(
        &self,
        reference: f64,
        model_deg: impl Fn(usize, &ReducedSight) -> f64,
    ) -> Vec<RunResidual> {
        self.sights
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let m = model_deg(i, s);
                let r = (s.ho_deg - m) * 60.0;
                RunResidual {
                    id: s.id.clone(),
                    utc: format_utc(s.jd_utc),
                    jd_utc: s.jd_utc,
                    minutes: (s.jd_utc - reference) * MINUTES_PER_DAY,
                    ho_deg: s.ho_deg,
                    model_deg: m,
                    residual_arcmin: r,
                    normalized: r / s.sigma_arcmin,
                    normalized_loo: None,
                    used: true,
                    outlier: false,
                }
            })
            .collect()
    }

    /// The model curve over the run and a margin around `reference`.
    fn sample_curve(&self, reference: f64, model_deg: impl Fn(f64) -> f64) -> Vec<CurvePoint> {
        let first = self.sights.first().map_or(reference, |s| s.jd_utc);
        let last = self.sights.last().map_or(reference, |s| s.jd_utc);
        let margin = 5.0 / MINUTES_PER_DAY;
        let lo = first.min(reference - margin);
        let hi = last.max(reference + margin);
        let pad = 0.1 * (hi - lo);
        let (lo, hi) = (lo - pad, hi + pad);
        (0..CURVE_POINTS)
            .map(|j| {
                let t = lo + (hi - lo) * j as f64 / (CURVE_POINTS - 1) as f64;
                CurvePoint {
                    jd_utc: t,
                    minutes: (t - reference) * MINUTES_PER_DAY,
                    altitude_deg: model_deg(t),
                }
            })
            .collect()
    }

    fn dr_check(&self, t: f64, lat_deg: f64, lon_deg: Option<f64>) -> NoonDrCheck {
        let t_dr = self.dr_passage();
        let dr_then = self.dr_at(t);
        let predicted_passage_sigma_s = self.dr.sigma_nm.map(|s| {
            let cos_lat = self.dr_point.lat.cos().abs().max(1e-12);
            let rate = self
                .lha_rate_deg_per_s(self.dr_point, self.t_mid, t_dr)
                .abs();
            (s / cos_lat) / 60.0 / rate.max(1e-12)
        });
        NoonDrCheck {
            predicted_passage_utc: format_utc(t_dr),
            predicted_passage_jd_utc: t_dr,
            predicted_passage_sigma_s,
            latitude_difference_arcmin: (lat_deg - dr_then.lat_deg()) * 60.0,
            longitude_difference_arcmin: lon_deg.map(|l| norm_180(l - dr_then.lon_deg()) * 60.0),
        }
    }

    // --- one altitude, and latitude only ---------------------------------------

    /// One altitude recorded at the peak: `H0 = Ho - a^2 / 4k`.
    fn single_maximum(&self, side: MeridianSide, t_dr: f64) -> NoonSightResult {
        let s = &self.sights[0];
        let p_dr = self.dr_at(t_dr);
        let (a, k) = self.shape(p_dr, t_dr, t_dr);
        let correction = if k > 0.0 { a * a / (4.0 * k) } else { 0.0 };
        let h0 = s.ho_deg - correction / 60.0;
        let dec = s.dec_deg;
        let lat = dec + side_sign(side) * (90.0 - h0);
        let latitude = LatitudeEstimate {
            lat_deg: lat,
            sigma_arcmin: s.sigma_arcmin,
        };
        let p = Point::from_deg(lat, p_dr.lon_deg());
        let residuals = self.residuals(t_dr, |_, s| s.ho_deg);
        let curve = self.sample_curve(t_dr, |t| self.curve(p, t_dr, t).to_degrees());
        NoonSightResult {
            body: self.body.clone(),
            method: NoonMethod::MaximumAltitude,
            n_sights: 1,
            side,
            latitude,
            meridian_altitude_deg: h0,
            declination_deg: dec,
            zenith_distance_deg: 90.0 - h0,
            latitude_rule: latitude_rule(&self.body, side, h0, dec, lat),
            meridian_passage: None,
            longitude: None,
            longitude_caveat: format!(
                "One altitude cannot time the peak: near noon the {} hangs at almost the same \
                 height for minutes, so no longitude comes from this sight. It was taken as \
                 the meridian altitude (the highest the {} rose); only the latitude is measured.",
                self.body, self.body
            ),
            longitude_sensitivity_arcmin_per_nm: None,
            maximum: None,
            curvature: CurvatureReport {
                predicted_arcmin_per_min2: k,
                rate_at_passage_arcmin_per_min: a,
                max_minus_meridian_arcmin: correction,
                fitted_arcmin_per_min2: None,
                fitted_sigma_arcmin_per_min2: None,
                z: None,
                consistent: None,
            },
            alternative: None,
            dr_check: self.dr_check(s.jd_utc, lat, None),
            chi2: 0.0,
            dof: 0,
            residuals,
            model_curve: curve,
            sights: self.sights.clone(),
            warnings: Vec::new(),
        }
    }

    /// Latitude only: every sight reduced to the meridian on the DR longitude, the
    /// altitude equation solved exactly (the ex-meridian method, generalised).
    fn ex_meridian(&self, side: MeridianSide, t_dr: f64) -> Result<NoonSightResult, SkyfixError> {
        let p_dr = self.dr_at(t_dr);
        // Start from the sight nearest noon, solved on the DR meridian.
        let nearest = self
            .sights
            .iter()
            .min_by(|a, b| (a.jd_utc - t_dr).abs().total_cmp(&(b.jd_utc - t_dr).abs()))
            .expect("a run has at least one sight");
        let lon_then = self.dr_at(nearest.jd_utc).lon;
        let dec_then = nearest.dec_deg;
        let candidates = latitudes_for_altitude(
            nearest.ho_deg.to_radians(),
            nearest.gha_deg.to_radians(),
            nearest.dec_deg.to_radians(),
            lon_then,
        );
        let wanted = |phi: f64| match side {
            MeridianSide::South => phi.to_degrees() >= dec_then,
            MeridianSide::North => phi.to_degrees() < dec_then,
        };
        let lat0 = candidates
            .iter()
            .copied()
            .filter(|&c| wanted(c))
            .min_by(|a, b| (a - p_dr.lat).abs().total_cmp(&(b - p_dr.lat).abs()))
            .or_else(|| candidates.first().copied())
            .ok_or_else(|| SkyfixError::Rejected {
                id: nearest.id.clone(),
                reason: format!(
                    "no latitude on your DR meridian sees the {} at {:.4} deg at that time; check \
                     the time, the DR longitude and the sextant reading",
                    self.body, nearest.ho_deg
                ),
            })?;
        let fit = self
            .fit(Point::new(lat0, p_dr.lon), t_dr, false)
            .ok_or_else(|| {
                SkyfixError::Other(
                    "the latitude-only noon solution did not converge: the sights do not \
                     constrain the latitude (the body is too far from the meridian)"
                        .to_string(),
                )
            })?;
        let p = fit.p;
        let dec = self.track.direction(t_dr).dec_deg;
        let lat = p.lat_deg();
        let side_out = if lat >= dec {
            MeridianSide::South
        } else {
            MeridianSide::North
        };
        let h0 = 90.0 - (lat - dec).abs();
        // d(phi)/dE, dimensionless (NM of latitude per NM of east-west DR error).
        let sensitivity = -fit.cross / fit.nn;
        let sigma_fit = rad_to_arcmin(fit.cov[0][0].max(0.0).sqrt());
        let sigma_lon = self.dr.sigma_nm.map(|s| sensitivity.abs() * s);
        let cos_lat = p.lat.cos().abs();
        let sigma_clock = sensitivity.abs()
            * self.gha_rate_arcmin_per_s(t_dr).abs()
            * cos_lat
            * self.clock_sigma_s;
        let sigma = sigma_fit.hypot(sigma_lon.unwrap_or(0.0)).hypot(sigma_clock);
        let (a, k) = self.shape(p, t_dr, t_dr);
        let residuals = self.residuals(t_dr, |i, _| self.sight_model(p, t_dr, i).0.to_degrees());
        let curve = self.sample_curve(t_dr, |t| self.curve(p, t_dr, t).to_degrees());
        let n = self.sights.len();
        let mut caveat = format!(
            "{} cannot time the peak, so no longitude is measured. The latitude was found by \
             reducing {} to the meridian with your DR longitude: it moves {:.2}′ for every \
             nautical mile your DR is wrong east or west",
            if n == 1 {
                "One altitude".to_string()
            } else {
                format!("These {n} altitudes")
            },
            if n == 1 { "it" } else { "them" },
            sensitivity.abs()
        );
        match self.dr.sigma_nm {
            Some(s) => caveat.push_str(&format!(
                ", which with your stated ±{s:.1} NM is ±{:.2}′ and is included in the sigma.",
                sensitivity.abs() * s
            )),
            None => caveat.push_str(
                ". Your DR's uncertainty was not stated, so that term is NOT in the sigma.",
            ),
        }
        let mut chi2 = fit.chi2;
        if !chi2.is_finite() {
            chi2 = 0.0;
        }
        Ok(NoonSightResult {
            body: self.body.clone(),
            method: NoonMethod::ExMeridian,
            n_sights: n,
            side: side_out,
            latitude: LatitudeEstimate {
                lat_deg: lat,
                sigma_arcmin: sigma,
            },
            meridian_altitude_deg: h0,
            declination_deg: dec,
            zenith_distance_deg: 90.0 - h0,
            latitude_rule: latitude_rule(&self.body, side_out, h0, dec, lat),
            meridian_passage: None,
            longitude: None,
            longitude_caveat: caveat,
            longitude_sensitivity_arcmin_per_nm: Some(sensitivity),
            maximum: None,
            curvature: CurvatureReport {
                predicted_arcmin_per_min2: k,
                rate_at_passage_arcmin_per_min: a,
                max_minus_meridian_arcmin: if k > 0.0 { a * a / (4.0 * k) } else { 0.0 },
                fitted_arcmin_per_min2: None,
                fitted_sigma_arcmin_per_min2: None,
                z: None,
                consistent: None,
            },
            alternative: None,
            dr_check: self.dr_check(t_dr, lat, None),
            chi2,
            dof: n as i64 - 1,
            residuals,
            model_curve: curve,
            sights: self.sights.clone(),
            warnings: Vec::new(),
        })
    }

    // --- warnings every noon result is checked for ------------------------------

    fn common_warnings(
        &self,
        result: &mut NoonSightResult,
        bearing: BodyBearing,
        t_dr: f64,
        warnings: &mut Vec<Warning>,
    ) {
        if result.meridian_altitude_deg > NEAR_ZENITH_DEG {
            warnings.push(Warning::MeridianNearZenith {
                body: self.body.clone(),
                meridian_altitude_deg: result.meridian_altitude_deg,
            });
        }
        // The answer for the other side of the zenith, and whether the DR tells them apart.
        let lat = result.latitude.lat_deg;
        let other = result.declination_deg - side_sign(result.side) * result.zenith_distance_deg;
        let instant = result.meridian_passage.as_ref().map_or(t_dr, |p| p.jd_utc);
        let dr_lat = self.dr_at(instant).lat_deg();
        let separation = (lat - other).abs();
        let ambiguous = (dr_lat - lat).abs() > (dr_lat - other).abs()
            || (bearing == BodyBearing::Auto && (dr_lat - lat).abs() > separation / 3.0);
        if ambiguous && (-90.0..=90.0).contains(&other) {
            warnings.push(Warning::MeridianSideAmbiguous {
                body: self.body.clone(),
                latitude_deg: lat,
                other_latitude_deg: other,
            });
        }
        if result.method == NoonMethod::MaximumAltitude {
            let s = &self.sights[0];
            let minutes = (s.jd_utc - t_dr) * MINUTES_PER_DAY;
            let allowance = MAXIMUM_TIMING_MINUTES
                + 3.0 * result.dr_check.predicted_passage_sigma_s.unwrap_or(0.0) / 60.0;
            if minutes.abs() > allowance {
                warnings.push(Warning::NotAtMeridianPassage {
                    id: s.id.clone(),
                    minutes_from_passage: minutes,
                });
            }
        }
        if result.method == NoonMethod::ExMeridian && self.dr.sigma_nm.is_none() {
            warnings.push(Warning::Other {
                message: format!(
                    "the latitude was reduced to the meridian with your DR longitude, whose \
                     uncertainty you did not state, so its sigma leaves that term out (it \
                     moves {:.2}′ per NM of east-west error)",
                    result
                        .longitude_sensitivity_arcmin_per_nm
                        .unwrap_or(0.0)
                        .abs()
                ),
            });
        }
    }
}

fn side_sign(side: MeridianSide) -> f64 {
    match side {
        MeridianSide::South => 1.0,
        MeridianSide::North => -1.0,
    }
}

/// The latitude rule in words, with the numbers (north positive).
fn latitude_rule(body: &str, side: MeridianSide, h0: f64, dec: f64, lat: f64) -> String {
    let z = 90.0 - h0;
    match side {
        MeridianSide::South => format!(
            "The {body} crossed your meridian SOUTH of the zenith, so latitude = declination + \
             zenith distance, counting north as positive: {} + {} = {} ({}). Zenith distance = \
             90° − meridian altitude {}.",
            fmt_signed(dec),
            fmt_dm(z),
            fmt_signed(lat),
            fmt_lat(lat),
            fmt_dm(h0)
        ),
        MeridianSide::North => format!(
            "The {body} crossed your meridian NORTH of the zenith, so latitude = declination − \
             zenith distance, counting north as positive: {} − {} = {} ({}). Zenith distance = \
             90° − meridian altitude {}.",
            fmt_signed(dec),
            fmt_dm(z),
            fmt_signed(lat),
            fmt_lat(lat),
            fmt_dm(h0)
        ),
    }
}

/// The plain-language flat-peak caveat that travels with every noon longitude.
fn flat_peak_caveat(
    body: &str,
    k: f64,
    passage: &TimeEstimate,
    longitude: &LongitudeEstimate,
) -> String {
    let within_1_arcmin = if k > 0.0 {
        (1.0 / k).sqrt()
    } else {
        f64::INFINITY
    };
    format!(
        "Near noon the {body}'s height hardly changes: for about {within_1_arcmin:.0} minutes \
         either side of the peak it is within 1′ of its highest. The time of the peak — and \
         the longitude, which is nothing but that time — is therefore uncertain by ±{:.0} s \
         (1 sigma): ±{:.1}′ of longitude, ±{:.1} NM east–west. The latitude does not suffer \
         from this: it comes from how HIGH the peak is, not WHEN it happened. Every 4 seconds \
         of timing error move the longitude 1′.",
        passage.sigma_s, longitude.sigma_arcmin, longitude.sigma_nm
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reduce::DirectionSource;
    use crate::types::{
        AltitudeKind, Clock, GeocentricDirection, Instrument, LatLon, Limb, Observation, Observer,
        SESSION_SCHEMA, SessionMeta,
    };

    /// A synthetic Sun: GHA advancing at exactly 15 deg/h from `gha0` at `t0`, and a
    /// declination changing linearly. Semidiameter/parallax zero (centre sights).
    struct SyntheticSun {
        t0: f64,
        gha0: f64,
        dec0: f64,
        dec_rate_deg_per_h: f64,
    }

    impl DirectionSource for SyntheticSun {
        fn name(&self) -> &str {
            "synthetic sun"
        }
        fn direction(&self, _body: &str, jd: f64) -> Result<GeocentricDirection, String> {
            let hours = (jd - self.t0) * 24.0;
            Ok(GeocentricDirection {
                gha_deg: crate::units::norm_360(self.gha0 + 15.0 * hours),
                dec_deg: self.dec0 + self.dec_rate_deg_per_h * hours,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            })
        }
        fn gha_rate_deg_per_hour(&self, _body: &str) -> f64 {
            15.0
        }
    }

    const T0: f64 = 2_461_308.0; // 2026-09-24T12:00Z

    fn session_with(obs: Vec<Observation>, dr: LatLon) -> Session {
        Session {
            schema: SESSION_SCHEMA.to_string(),
            meta: SessionMeta::default(),
            observer: Observer {
                assumed_position: Some(dr),
                ..Observer::default()
            },
            instrument: Instrument::default(),
            clock: Clock::default(),
            observations: obs,
        }
    }

    /// Exact centre altitudes of the synthetic Sun seen by an observer who is at
    /// `truth` at `t_ref` and runs with `vessel`.
    fn run_sights(
        sun: &SyntheticSun,
        truth: Point,
        t_ref: f64,
        vessel: Option<VesselMotion>,
        minutes: &[f64],
        sigma: f64,
    ) -> Vec<Observation> {
        minutes
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let t = t_ref + m / MINUTES_PER_DAY;
                let d = sun.direction("Sun", t).unwrap();
                let p = dr_move(truth, vessel, m / 60.0);
                let h = hc_zn(p, &d).0.to_degrees();
                Observation {
                    id: format!("s{i}"),
                    body: "Sun".to_string(),
                    utc: format_utc(t),
                    altitude_deg: h,
                    altitude_kind: AltitudeKind::ObservedHo,
                    sigma_arcmin: sigma,
                    limb: Limb::Center,
                    horizon: None,
                    geocentric: None,
                    notes: String::new(),
                }
            })
            .collect()
    }

    /// Meridian passage of the synthetic Sun for a stationary observer at `lon`.
    fn passage_for(sun: &SyntheticSun, lon_deg: f64) -> f64 {
        // GHA = gha0 + 15 h = -lon  ->  h = (-lon - gha0) / 15, wrapped to the nearest.
        let hours = norm_180(-lon_deg - sun.gha0) / 15.0;
        sun.t0 + hours / 24.0
    }

    #[test]
    fn a_noise_free_run_recovers_latitude_and_passage_exactly() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: -4.0,
            dec_rate_deg_per_h: 0.0,
        };
        let truth = Point::from_deg(39.8, -44.55);
        let t_pass = passage_for(&sun, -44.55);
        let minutes: Vec<f64> = (-10..=10).map(|m| m as f64 * 2.0).collect();
        let obs = run_sights(&sun, truth, t_pass, None, &minutes, 0.5);
        let session = session_with(
            obs,
            LatLon {
                lat_deg: 39.5,
                lon_deg: -44.0,
            },
        );
        let r = noon_sight(&session, &sun, &NoonSightOptions::default()).unwrap();
        assert_eq!(r.method, NoonMethod::CurveFit);
        assert_eq!(r.side, MeridianSide::South);
        assert!((r.latitude.lat_deg - 39.8).abs() * 60.0 < 1e-6, "{r:?}");
        let p = r.meridian_passage.as_ref().unwrap();
        assert!((p.jd_utc - t_pass).abs() * SECONDS_PER_DAY < 1e-3);
        let lon = r.longitude.unwrap();
        assert!((lon.lon_deg + 44.55).abs() * 60.0 < 1e-5);
        // Meridian altitude is exactly 90 - (lat - dec).
        assert!((r.meridian_altitude_deg - (90.0 - 43.8)).abs() < 1e-9);
        // The longitude is always accompanied by its caveat.
        assert!(
            r.warnings
                .iter()
                .any(|w| matches!(w, Warning::FlatPeakLongitude { .. }))
        );
        assert!(r.longitude_caveat.contains("HIGH"));
        // Predicted and fitted curvature agree on noise-free data.
        let c = &r.curvature;
        assert!(c.consistent.unwrap());
        assert!((c.fitted_arcmin_per_min2.unwrap() - c.predicted_arcmin_per_min2).abs() < 1e-6);
        // k = (1/2) w^2 cos(phi) cos(dec) / cos(H0), w = 15 deg/h in rad/min.
        let w = (15.0f64 / 60.0).to_radians();
        let k = 0.5 * w * w * 39.8f64.to_radians().cos() * 4.0f64.to_radians().cos()
            / (90.0f64 - 43.8).to_radians().cos();
        assert!(
            (c.predicted_arcmin_per_min2 - rad_to_arcmin(k)).abs() < 1e-4,
            "{} vs {}",
            c.predicted_arcmin_per_min2,
            rad_to_arcmin(k)
        );
    }

    #[test]
    fn a_vessel_running_north_peaks_before_meridian_passage() {
        // Moving north at 12 kn toward a Sun that is south: the meridian altitude falls
        // 12'/h, so the peak comes a/(2k) before LHA = 0 and the latitude is taken at T.
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: 10.0,
            dec_rate_deg_per_h: 0.0,
        };
        let vessel = Some(VesselMotion {
            course_deg: 0.0,
            speed_kn: 12.0,
        });
        let truth = Point::from_deg(45.0, -30.0);
        let t_pass = passage_for(&sun, -30.0);
        let minutes: Vec<f64> = (-8..=8).map(|m| m as f64 * 3.0).collect();
        let obs = run_sights(&sun, truth, t_pass, vessel, &minutes, 0.3);
        let session = session_with(
            obs,
            LatLon {
                lat_deg: 44.8,
                lon_deg: -30.3,
            },
        );
        let options = NoonSightOptions {
            vessel,
            ..Default::default()
        };
        let r = noon_sight(&session, &sun, &options).unwrap();
        assert!(
            (r.latitude.lat_deg - 45.0).abs() * 60.0 < 1e-5,
            "{}",
            r.latitude.lat_deg
        );
        let p = r.meridian_passage.as_ref().unwrap();
        assert!((p.jd_utc - t_pass).abs() * SECONDS_PER_DAY < 0.01);
        let m = r.maximum.as_ref().unwrap();
        // a = -12'/h = -0.2'/min; the peak is a/(2k) minutes from passage: before it.
        let expected_s = r.curvature.rate_at_passage_arcmin_per_min
            / (2.0 * r.curvature.predicted_arcmin_per_min2)
            * 60.0;
        assert!((r.curvature.rate_at_passage_arcmin_per_min + 0.2).abs() < 1e-3);
        assert!(
            m.seconds_after_passage < -60.0,
            "{}",
            m.seconds_after_passage
        );
        assert!((m.seconds_after_passage - expected_s).abs() < 1.0);
    }

    #[test]
    fn the_free_curvature_fit_agrees_on_clean_data_and_flags_a_wrong_speed() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 100.0,
            dec0: 20.0,
            dec_rate_deg_per_h: 0.01,
        };
        let truth = Point::from_deg(-10.0, 90.0);
        let t_pass = passage_for(&sun, 90.0);
        let minutes: Vec<f64> = (-15..=15).map(|m| m as f64 * 2.0).collect();
        let obs = run_sights(&sun, truth, t_pass, None, &minutes, 0.1);
        let session = session_with(
            obs.clone(),
            LatLon {
                lat_deg: -10.2,
                lon_deg: 89.7,
            },
        );
        let fitted = NoonSightOptions {
            curvature: NoonCurvature::Fitted,
            ..Default::default()
        };
        let r = noon_sight(&session, &sun, &fitted).unwrap();
        assert_eq!(r.method, NoonMethod::CurveFitFreeCurvature);
        assert_eq!(r.side, MeridianSide::North);
        assert!((r.latitude.lat_deg + 10.0).abs() * 60.0 < 1e-6);
        assert_eq!(r.alternative.as_ref().unwrap().method, NoonMethod::CurveFit);

        // Sights taken while steaming east at 20 kn but reported as stationary: the LHA
        // runs 2.3 % faster than predicted, the curve is 4.5 % sharper, and with 31
        // sights of 0.1' the free curvature sees it many sigma away.
        let fast = Some(VesselMotion {
            course_deg: 90.0,
            speed_kn: 20.0,
        });
        let obs = run_sights(&sun, truth, t_pass, fast, &minutes, 0.1);
        let session = session_with(
            obs,
            LatLon {
                lat_deg: -10.2,
                lon_deg: 89.7,
            },
        );
        let r = noon_sight(&session, &sun, &NoonSightOptions::default()).unwrap();
        assert_eq!(r.curvature.consistent, Some(false), "{:?}", r.curvature);
        assert!(
            r.warnings
                .iter()
                .any(|w| matches!(w, Warning::CurvatureInconsistent { .. }))
        );
    }

    #[test]
    fn one_altitude_gives_latitude_only_and_says_why() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: -4.165,
            dec_rate_deg_per_h: 0.0,
        };
        let truth = Point::from_deg(39.81, -44.55);
        let t_pass = passage_for(&sun, -44.55);
        let obs = run_sights(&sun, truth, t_pass, None, &[0.0], 0.2);
        let session = session_with(
            obs,
            LatLon {
                lat_deg: 39.82,
                lon_deg: -44.55,
            },
        );
        let r = noon_sight(&session, &sun, &NoonSightOptions::default()).unwrap();
        assert_eq!(r.method, NoonMethod::MaximumAltitude);
        assert!((r.latitude.lat_deg - 39.81).abs() * 60.0 < 1e-6);
        assert!(r.longitude.is_none());
        assert!(r.meridian_passage.is_none());
        assert!(r.longitude_caveat.contains("cannot time the peak"));
        assert!(r.latitude_rule.contains("SOUTH"));

        // The same sight as ex-meridian: the same latitude, plus a longitude sensitivity.
        let ex = NoonSightOptions {
            single_altitude: SingleAltitudeMode::ExMeridian,
            dr: Some(DrPosition {
                lat_deg: 39.82,
                lon_deg: -44.55,
                sigma_nm: Some(10.0),
            }),
            ..Default::default()
        };
        let r = noon_sight(&session, &sun, &ex).unwrap();
        assert_eq!(r.method, NoonMethod::ExMeridian);
        assert!((r.latitude.lat_deg - 39.81).abs() * 60.0 < 1e-6);
        // At meridian passage the altitude does not depend on longitude at all.
        assert!(r.longitude_sensitivity_arcmin_per_nm.unwrap().abs() < 1e-6);
    }

    #[test]
    fn an_ex_meridian_sight_off_noon_depends_on_the_dr_longitude() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: 5.0,
            dec_rate_deg_per_h: 0.0,
        };
        let truth = Point::from_deg(30.0, 20.0);
        let t_pass = passage_for(&sun, 20.0);
        // Twenty minutes after noon.
        let obs = run_sights(&sun, truth, t_pass, None, &[20.0], 0.5);
        let session = session_with(
            obs,
            LatLon {
                lat_deg: 30.1,
                lon_deg: 20.0,
            },
        );
        let options = NoonSightOptions {
            single_altitude: SingleAltitudeMode::ExMeridian,
            ..Default::default()
        };
        let r = noon_sight(&session, &sun, &options).unwrap();
        assert!((r.latitude.lat_deg - 30.0).abs() * 60.0 < 1e-6);
        let s = r.longitude_sensitivity_arcmin_per_nm.unwrap();
        // Afternoon Sun is south-west: moving east raises it, so a DR too far east
        // implies too low an altitude-at-noon: d(phi)/dE = -tan(Zn) > 0 here? Just size.
        assert!(s.abs() > 0.05 && s.abs() < 0.5, "{s}");
        // No stated DR uncertainty: the result says the term is missing.
        assert!(
            r.warnings.iter().any(
                |w| matches!(w, Warning::Other { message } if message.contains("did not state"))
            )
        );
    }

    #[test]
    fn a_body_near_the_zenith_and_an_unclear_side_are_flagged() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: 20.0,
            dec_rate_deg_per_h: 0.0,
        };
        // Observer 1.5 deg south of the Sun's declination: meridian altitude 88.5 deg.
        let truth = Point::from_deg(18.5, -60.0);
        let t_pass = passage_for(&sun, -60.0);
        let minutes: Vec<f64> = (-6..=6).map(|m| m as f64).collect();
        let obs = run_sights(&sun, truth, t_pass, None, &minutes, 0.3);
        // A DR almost on the declination: it cannot tell north from south.
        let session = session_with(
            obs,
            LatLon {
                lat_deg: 19.8,
                lon_deg: -60.1,
            },
        );
        let options = NoonSightOptions {
            body_bearing: BodyBearing::North,
            ..Default::default()
        };
        let r = noon_sight(&session, &sun, &options).unwrap();
        assert!(
            (r.latitude.lat_deg - 18.5).abs() * 60.0 < 1e-4,
            "{}",
            r.latitude.lat_deg
        );
        assert!(
            r.warnings
                .iter()
                .any(|w| matches!(w, Warning::MeridianNearZenith { .. }))
        );
        // The exact model handles the V-shaped top: passage still recovered.
        let p = r.meridian_passage.as_ref().unwrap();
        assert!((p.jd_utc - t_pass).abs() * SECONDS_PER_DAY < 0.01);

        let auto = session_with(
            run_sights(&sun, truth, t_pass, None, &[0.0], 0.3),
            LatLon {
                lat_deg: 19.95,
                lon_deg: -60.0,
            },
        );
        let r = noon_sight(&auto, &sun, &NoonSightOptions::default()).unwrap();
        assert!(
            r.warnings
                .iter()
                .any(|w| matches!(w, Warning::MeridianSideAmbiguous { .. })),
            "{:?}",
            r.warnings
        );
    }

    #[test]
    fn a_one_sided_run_and_a_mixed_body_run_are_reported() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: 0.0,
            dec_rate_deg_per_h: 0.0,
        };
        let truth = Point::from_deg(40.0, 0.0);
        let t_pass = passage_for(&sun, 0.0);
        let minutes = [-30.0, -25.0, -20.0, -15.0, -10.0];
        let obs = run_sights(&sun, truth, t_pass, None, &minutes, 0.2);
        let session = session_with(
            obs.clone(),
            LatLon {
                lat_deg: 40.1,
                lon_deg: 0.1,
            },
        );
        let r = noon_sight(&session, &sun, &NoonSightOptions::default()).unwrap();
        assert!(r.warnings.iter().any(|w| matches!(
            w,
            Warning::OneSidedRun {
                before: 5,
                after: 0,
                ..
            }
        )));
        let mut mixed = obs;
        mixed[1].body = "Vega".to_string();
        let session = session_with(
            mixed,
            LatLon {
                lat_deg: 40.1,
                lon_deg: 0.1,
            },
        );
        let e = noon_sight(&session, &sun, &NoonSightOptions::default()).unwrap_err();
        assert!(e.to_string().contains("ONE body"), "{e}");
    }

    #[test]
    fn a_run_needs_a_dr() {
        let sun = SyntheticSun {
            t0: T0,
            gha0: 0.0,
            dec0: 0.0,
            dec_rate_deg_per_h: 0.0,
        };
        let obs = run_sights(&sun, Point::from_deg(40.0, 0.0), T0, None, &[0.0], 0.2);
        let mut session = session_with(
            obs,
            LatLon {
                lat_deg: 40.0,
                lon_deg: 0.0,
            },
        );
        session.observer.assumed_position = None;
        let e = noon_sight(&session, &sun, &NoonSightOptions::default()).unwrap_err();
        assert!(e.to_string().contains("DR position"), "{e}");
    }
}
