//! Averaging a run of sights of one body into one sight.
//!
//! `docs/NAVIGATION_METHODS.md` section 4 is normative; this is a summary.
//!
//! A navigator takes several sights of one body over a few minutes and wants one good
//! one. The body's altitude is changing all the while, so a plain mean of the altitudes
//! at the mean time is only right if the change is a straight line. Here the *shape*
//! is predicted and only the level is fitted:
//!
//! ```text
//! p(t)  = Hc(DR(t), body(t))            the altitude the ephemeris predicts at the DR
//! Ho_i  = p(t_i) + b + e_i              one unknown, b, by weighted least squares
//! Ho(t) = p(t) + b                      the averaged sight at any chosen instant
//! ```
//!
//! `p` is computed through the ordinary geometry and the body's own ephemeris, so its
//! slope is the true rate of change at the DR (including the body's own motion and the
//! vessel's) and its small curvature comes along for free. The DR's own error enters
//! only through that slope, and weakly (15 NM off changed Vega's rate by 0.15 %).
//!
//! The averaged altitude's sigma is `sqrt(1 / sum w)` (`sigma / sqrt(N)` for equal
//! sigmas) at the weighted mean time, growing away from it by the predicted slope's own
//! uncertainty when the DR's is stated.
//!
//! **Outliers.** Each sight's residual is also taken against the line through the
//! *other* sights, divided by its own standard deviation (`normalized_loo`,
//! `r_i / (sigma_i sqrt(1 - w_i / sum w))`). Above the threshold (3) the sight is
//! flagged and, by default, left out, one at a time, worst first, while three or more
//! remain. Two sights that disagree are flagged but neither is dropped: nothing can say
//! which is wrong.
//!
//! **Free slope.** With four or more sights the slope is also fitted freely
//! (`Ho_i = p(t_i) + b + c (t_i - t_mean)`). `c / sigma` is the test that the predicted
//! slope fits the data; `|z| > 3` raises [`Warning::SlopeInconsistent`] — a wrong body,
//! a wrong time, an unreported course and speed, or a DR far off.

use super::{
    BodyTrack, MINUTES_PER_DAY, SECONDS_PER_DAY, THREE_SIGMA, check_dr, check_vessel, dr_move,
    hc_zn, nothing_usable, one_body, reduce_all, resolve_dr,
};
use crate::SkyfixError;
use crate::geometry::{Point, apply_tangent_step};
use crate::reduce::DirectionSource;
use crate::time::{format_utc, parse_utc};
use crate::types::{
    AltitudeKind, AveragedSight, AveragingOptions, CurvePoint, FreeSlopeFit, GeocentricDirection,
    Limb, Observation, ReducedSight, RunResidual, Session, Warning,
};
use crate::units::{nm_to_rad, rad_to_arcmin};

/// Points in `model_curve`.
const CURVE_POINTS: usize = 25;
/// A run longer than this (minutes) is still averaged, but flagged: the DR moves and
/// the predicted shape matters more.
pub const LONG_RUN_MINUTES: f64 = 30.0;

/// Average a run of sights of one body into one sight at a chosen instant.
pub fn average_sights(
    session: &Session,
    source: &dyn DirectionSource,
    options: &AveragingOptions,
) -> Result<AveragedSight, SkyfixError> {
    let (sights, mut warnings) = reduce_all(session, source);
    if sights.is_empty() {
        return Err(nothing_usable(
            "averaging",
            session.observations.len(),
            &warnings,
        ));
    }
    let body = one_body(&sights, "averaging")?;
    let dr = resolve_dr(options.dr, session).ok_or_else(|| SkyfixError::InvalidField {
        field: "options.dr".to_string(),
        message: "averaging needs a DR position (options.dr, or the session's assumed \
                  position) to predict how fast the body's altitude is changing"
            .to_string(),
    })?;
    check_dr(&dr)?;
    check_vessel(options.vessel)?;
    let threshold = if options.outlier_threshold.is_finite() && options.outlier_threshold > 0.0 {
        options.outlier_threshold
    } else {
        THREE_SIGMA
    };
    let track = BodyTrack::new(&body, &sights, source);
    let n = sights.len();
    let t_mid = sights.iter().map(|s| s.jd_utc).sum::<f64>() / n as f64;
    let dr_point = Point::from_deg(dr.lat_deg, dr.lon_deg);
    // The predicted altitude curve at the DR, arcminutes.
    let predict_at = |p: Point, t: f64| -> f64 {
        let at = dr_move(p, options.vessel, (t - t_mid) * 24.0);
        rad_to_arcmin(hc_zn(at, &track.direction(t)).0)
    };
    let predict = |t: f64| predict_at(dr_point, t);
    let ho: Vec<f64> = sights.iter().map(|s| s.ho_deg * 60.0).collect();
    let p_i: Vec<f64> = sights.iter().map(|s| predict(s.jd_utc)).collect();
    let w: Vec<f64> = sights
        .iter()
        .map(|s| 1.0 / (s.sigma_arcmin * s.sigma_arcmin))
        .collect();
    let minutes: Vec<f64> = sights
        .iter()
        .map(|s| (s.jd_utc - t_mid) * MINUTES_PER_DAY)
        .collect();

    // Predicted slope (arcmin/min) at an instant, and its own 1-sigma from the DR's
    // stated uncertainty (the slope's gradient over one NM, times that sigma).
    let step = 30.0 / SECONDS_PER_DAY;
    // The two samples are one minute apart, so their difference is already per minute.
    let slope_at = |p: Point, t: f64| predict_at(p, t + step) - predict_at(p, t - step);
    let slope_sigma_at = |t: f64| {
        dr.sigma_nm.map(|sig| {
            let d = nm_to_rad(1.0);
            let dn = (slope_at(apply_tangent_step(dr_point, d, 0.0), t)
                - slope_at(apply_tangent_step(dr_point, -d, 0.0), t))
                / 2.0;
            let de = (slope_at(apply_tangent_step(dr_point, 0.0, d), t)
                - slope_at(apply_tangent_step(dr_point, 0.0, -d), t))
                / 2.0;
            sig * dn.hypot(de)
        })
    };
    let loop_slope_sigma = slope_sigma_at(t_mid).unwrap_or(0.0);

    // --- outlier rejection, worst first, while three or more remain -------------
    // Dropping the worst sight removes exactly z_loo^2 of chi-square; freeing the slope
    // removes exactly z_slope^2. When the slope explains the misfit better, the run is
    // not a set of good sights with a bad one in it, and nothing is dropped.
    let mut used = vec![true; n];
    let mut flagged = vec![false; n];
    loop {
        let fit = level_fit(&ho, &p_i, &w, &used);
        let n_used = used.iter().filter(|u| **u).count();
        let worst = (0..n)
            .filter(|&i| used[i])
            .map(|i| (i, loo(&ho, &p_i, &w, &used, fit, i)))
            .filter(|(_, z)| z.is_finite())
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()));
        let Some((i, z)) = worst else { break };
        if z.abs() <= threshold {
            break;
        }
        if n_used >= 4
            && let Some(zs) = slope_test(&ho, &p_i, &w, &used, &minutes, loop_slope_sigma)
            && zs.abs() >= z.abs()
        {
            warnings.push(Warning::Other {
                message: format!(
                    "the sights of {body} change height at a different rate than the ephemeris \
                     predicts, and that explains the misfit better than any one bad sight does \
                     (slope z = {zs:.1} against the worst sight's {z:.1}), so no sight was \
                     dropped; check the times, the body, the DR, and the course and speed"
                ),
            });
            break;
        }
        if n_used >= 3 {
            flagged[i] = true;
            if options.reject_outliers {
                used[i] = false;
                continue;
            }
            // Flag every sight beyond the threshold, but keep them all.
            for j in (0..n).filter(|&j| used[j]) {
                let zj = loo(&ho, &p_i, &w, &used, fit, j);
                if zj.abs() > threshold {
                    flagged[j] = true;
                }
            }
            break;
        }
        // Two sights disagreeing: flag both, keep both.
        for j in (0..n).filter(|&j| used[j]) {
            flagged[j] = true;
        }
        break;
    }

    let b = level_fit(&ho, &p_i, &w, &used);
    let w_used: f64 = (0..n).filter(|&i| used[i]).map(|i| w[i]).sum();
    let t_mean_w = (0..n)
        .filter(|&i| used[i])
        .map(|i| w[i] * sights[i].jd_utc)
        .sum::<f64>()
        / w_used;
    let t_ref = match &options.reference_utc {
        Some(s) => parse_utc(s)?,
        None => t_mean_w,
    };

    // Predicted slope and curvature at the reference instant, and the slope's own
    // uncertainty from the DR's stated uncertainty. The second difference is over half
    // a minute each side, so it is divided by 0.5^2.
    let slope = slope_at(dr_point, t_ref);
    let curvature = (predict(t_ref + step) - 2.0 * predict(t_ref) + predict(t_ref - step)) / 0.25;
    let slope_sigma = slope_sigma_at(t_ref);
    let minutes_off = (t_ref - t_mean_w) * MINUTES_PER_DAY;
    let sigma = (1.0 / w_used)
        .sqrt()
        .hypot(slope_sigma.unwrap_or(0.0) * minutes_off);
    let ho_avg = predict(t_ref) + b;
    if slope_sigma.is_none() && minutes_off.abs() > 0.5 {
        warnings.push(Warning::Other {
            message: format!(
                "the averaged sight is reported {:.1} min from the middle of the run; the \
                 predicted slope's own uncertainty, which grows with that distance, is not \
                 included because your DR's uncertainty was not stated",
                minutes_off.abs()
            ),
        });
    }

    // --- residuals ---------------------------------------------------------------
    let residuals: Vec<RunResidual> = sights
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let model = p_i[i] + b;
            let r = ho[i] - model;
            RunResidual {
                id: s.id.clone(),
                utc: format_utc(s.jd_utc),
                jd_utc: s.jd_utc,
                minutes: (s.jd_utc - t_ref) * MINUTES_PER_DAY,
                ho_deg: s.ho_deg,
                model_deg: model / 60.0,
                residual_arcmin: r,
                normalized: r / s.sigma_arcmin,
                normalized_loo: Some(loo(&ho, &p_i, &w, &used, b, i)),
                used: used[i],
                outlier: flagged[i],
            }
        })
        .collect();
    let chi2: f64 = (0..n)
        .filter(|&i| used[i])
        .map(|i| {
            let r = ho[i] - p_i[i] - b;
            w[i] * r * r
        })
        .sum();
    let n_used = used.iter().filter(|u| **u).count();
    for (i, s) in sights.iter().enumerate() {
        if flagged[i] {
            warnings.push(Warning::RunOutlier {
                id: s.id.clone(),
                normalized_residual: residuals[i].normalized_loo.unwrap_or(f64::NAN),
                rejected: !used[i],
            });
        }
    }

    // --- free slope (four or more sights) ------------------------------------------
    let free_slope = if n_used >= 4 {
        let sw = w_used;
        let mut stt = 0.0;
        let mut sty = 0.0;
        let mut sy = 0.0;
        for i in (0..n).filter(|&i| used[i]) {
            let tau = (sights[i].jd_utc - t_mean_w) * MINUTES_PER_DAY;
            let y = ho[i] - p_i[i];
            stt += w[i] * tau * tau;
            sty += w[i] * tau * y;
            sy += w[i] * y;
        }
        if stt > 0.0 {
            let c = sty / stt;
            let b_free = sy / sw;
            let sigma_c = (1.0 / stt).sqrt();
            let chi2_free: f64 = (0..n)
                .filter(|&i| used[i])
                .map(|i| {
                    let tau = (sights[i].jd_utc - t_mean_w) * MINUTES_PER_DAY;
                    let r = ho[i] - p_i[i] - b_free - c * tau;
                    w[i] * r * r
                })
                .sum();
            let z = c / sigma_c.hypot(slope_sigma.unwrap_or(0.0));
            let fitted = slope + c;
            if z.abs() > THREE_SIGMA {
                warnings.push(Warning::SlopeInconsistent {
                    body: body.clone(),
                    predicted_arcmin_per_min: slope,
                    fitted_arcmin_per_min: fitted,
                    z,
                });
            }
            Some(FreeSlopeFit {
                slope_arcmin_per_min: fitted,
                slope_sigma_arcmin_per_min: sigma_c,
                ho_deg: (predict(t_ref) + b_free + c * minutes_off) / 60.0,
                sigma_arcmin: (1.0 / sw).sqrt().hypot(sigma_c * minutes_off),
                z,
                consistent: z.abs() <= THREE_SIGMA,
                chi2: chi2_free,
                dof: n_used as i64 - 2,
            })
        } else {
            None
        }
    } else {
        None
    };

    let span_min = (sights[n - 1].jd_utc - sights[0].jd_utc) * MINUTES_PER_DAY;
    if span_min > LONG_RUN_MINUTES {
        warnings.push(Warning::Other {
            message: format!(
                "this run spans {span_min:.0} minutes; averaging is meant for a few minutes of \
                 sights, and over a longer run the answer leans on the DR (and on the course \
                 and speed, if the vessel is moving)"
            ),
        });
    }

    let lo = sights[0].jd_utc.min(t_ref);
    let hi = sights[n - 1].jd_utc.max(t_ref);
    let pad = 0.1 * (hi - lo).max(1.0 / MINUTES_PER_DAY);
    let model_curve: Vec<CurvePoint> = (0..CURVE_POINTS)
        .map(|j| {
            let t = lo - pad + (hi - lo + 2.0 * pad) * j as f64 / (CURVE_POINTS - 1) as f64;
            CurvePoint {
                jd_utc: t,
                minutes: (t - t_ref) * MINUTES_PER_DAY,
                altitude_deg: (predict(t) + b) / 60.0,
            }
        })
        .collect();

    let observation = averaged_observation(
        &body,
        &sights,
        &used,
        t_ref,
        session.clock.correction_s,
        ho_avg / 60.0,
        sigma,
        slope,
        &track,
    );

    Ok(AveragedSight {
        body,
        utc: format_utc(t_ref),
        jd_utc: t_ref,
        ho_deg: ho_avg / 60.0,
        sigma_arcmin: sigma,
        n_used,
        n_total: n,
        predicted_slope_arcmin_per_min: slope,
        predicted_slope_sigma_arcmin_per_min: slope_sigma,
        predicted_curvature_arcmin_per_min2: curvature,
        chi2,
        dof: n_used as i64 - 1,
        free_slope,
        outliers: sights
            .iter()
            .zip(&flagged)
            .filter(|(_, f)| **f)
            .map(|(s, _)| s.id.clone())
            .collect(),
        residuals,
        model_curve,
        observation,
        sights,
        warnings,
    })
}

/// `c / sigma` for a free slope correction `c` on the sights in use: how much better a
/// free slope fits than the predicted one (its square is the chi-square it removes).
fn slope_test(
    ho: &[f64],
    p: &[f64],
    w: &[f64],
    used: &[bool],
    minutes: &[f64],
    slope_sigma: f64,
) -> Option<f64> {
    let idx: Vec<usize> = (0..ho.len()).filter(|&i| used[i]).collect();
    let sw: f64 = idx.iter().map(|&i| w[i]).sum();
    let t_mean = idx.iter().map(|&i| w[i] * minutes[i]).sum::<f64>() / sw;
    let y_mean = idx.iter().map(|&i| w[i] * (ho[i] - p[i])).sum::<f64>() / sw;
    let stt: f64 = idx
        .iter()
        .map(|&i| w[i] * (minutes[i] - t_mean).powi(2))
        .sum();
    if stt.is_nan() || stt <= 0.0 {
        return None;
    }
    let sty: f64 = idx
        .iter()
        .map(|&i| w[i] * (minutes[i] - t_mean) * (ho[i] - p[i] - y_mean))
        .sum();
    let c = sty / stt;
    Some(c / (1.0 / stt).sqrt().hypot(slope_sigma))
}

/// The level `b` (arcmin) of `Ho_i = p_i + b` from the sights in use.
fn level_fit(ho: &[f64], p: &[f64], w: &[f64], used: &[bool]) -> f64 {
    let mut sw = 0.0;
    let mut swy = 0.0;
    for i in 0..ho.len() {
        if used[i] {
            sw += w[i];
            swy += w[i] * (ho[i] - p[i]);
        }
    }
    swy / sw
}

/// Leave-one-out normalised residual of sight `i`. For a sight in the fit it is
/// `r / (sigma sqrt(1 - w / sum w))`; for a sight already left out it is its residual
/// against the fit without it, over `sqrt(sigma^2 + 1 / sum w)`. Both are standard
/// normal when the sight is as good as its sigma says.
fn loo(ho: &[f64], p: &[f64], w: &[f64], used: &[bool], b: f64, i: usize) -> f64 {
    let sw: f64 = (0..ho.len()).filter(|&j| used[j]).map(|j| w[j]).sum();
    let r = ho[i] - p[i] - b;
    let var_i = 1.0 / w[i];
    if used[i] {
        let one_minus_h = 1.0 - w[i] / sw;
        if one_minus_h <= 1e-12 {
            return f64::NAN;
        }
        r / (var_i * one_minus_h).sqrt()
    } else {
        r / (var_i + 1.0 / sw).sqrt()
    }
}

/// The averaged sight as a session observation. `observed_ho`, so the chain never runs
/// on it again (CONVENTIONS 4). A run of supplied directions supplies one here too,
/// read off the same straight line; otherwise the provider answers at reduction time.
///
/// Its `utc` is on the session's chronometer, like the observations it averages:
/// `t_ref` (the corrected instant) minus `clock_correction_s`, so that the reducer,
/// which adds the session's correction to every recorded time (CONVENTIONS 6), brings it
/// back to `t_ref` exactly once. Written as `t_ref` itself, a session with a chronometer
/// correction would apply it twice.
#[allow(clippy::too_many_arguments)]
fn averaged_observation(
    body: &str,
    sights: &[ReducedSight],
    used: &[bool],
    t_ref: f64,
    clock_correction_s: f64,
    ho_deg: f64,
    sigma_arcmin: f64,
    slope: f64,
    track: &BodyTrack<'_>,
) -> Observation {
    let ids: Vec<&str> = sights
        .iter()
        .zip(used)
        .filter(|(_, u)| **u)
        .map(|(s, _)| s.id.as_str())
        .collect();
    let all_supplied = sights
        .iter()
        .all(|s| s.direction_source == crate::reduce::SUPPLIED_DIRECTION_SOURCE);
    let utc = format_utc(t_ref - clock_correction_s / SECONDS_PER_DAY);
    let stamp: String = utc
        .chars()
        .filter(|c| c.is_ascii_digit())
        .skip(8)
        .take(6)
        .collect();
    Observation {
        id: format!(
            "avg-{}-{stamp}",
            body.trim().to_lowercase().replace(' ', "-")
        ),
        body: body.to_string(),
        utc,
        altitude_deg: ho_deg,
        altitude_kind: AltitudeKind::ObservedHo,
        sigma_arcmin,
        limb: Limb::Center,
        horizon: None,
        geocentric: if all_supplied {
            let d = track.direction(t_ref);
            Some(GeocentricDirection {
                gha_deg: d.gha_deg,
                dec_deg: d.dec_deg,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            })
        } else {
            None
        },
        notes: format!(
            "Average of {} sights ({}) at a predicted slope of {slope:.3}′/min; fully corrected \
             (observed_ho), so no correction runs on it again. docs/NAVIGATION_METHODS.md.{}",
            ids.len(),
            ids.join(", "),
            if clock_correction_s == 0.0 {
                String::new()
            } else {
                format!(
                    " Its time is on the session's chronometer, like the sights it averages: \
                     the session's clock correction ({clock_correction_s:+.3} s) brings it to \
                     {}.",
                    format_utc(t_ref)
                )
            }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Clock, DrPosition, Instrument, LatLon, Observer, SESSION_SCHEMA, SessionMeta,
    };
    use crate::units::norm_360;

    /// A star moving at the sidereal rate.
    struct Star {
        t0: f64,
        gha0: f64,
        dec: f64,
    }
    impl DirectionSource for Star {
        fn name(&self) -> &str {
            "test star"
        }
        fn direction(&self, _b: &str, jd: f64) -> Result<GeocentricDirection, String> {
            Ok(GeocentricDirection {
                gha_deg: norm_360(self.gha0 + 360.985_647 * (jd - self.t0)),
                dec_deg: self.dec,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            })
        }
        fn gha_rate_deg_per_hour(&self, _b: &str) -> f64 {
            15.041_068_64
        }
    }

    const T0: f64 = 2_461_308.0;

    /// A run seen from `truth`, with the session's DR about 26 NM away (40.3 N 74.6 W).
    fn run(star: &Star, truth: Point, minutes: &[f64], errors: &[f64], sigma: f64) -> Session {
        let observations = minutes
            .iter()
            .zip(errors)
            .enumerate()
            .map(|(i, (m, e))| {
                let t = T0 + m / MINUTES_PER_DAY;
                let h = hc_zn(truth, &star.direction("x", t).unwrap())
                    .0
                    .to_degrees();
                Observation {
                    id: format!("s{i}"),
                    body: "Vega".to_string(),
                    utc: format_utc(t),
                    altitude_deg: h + e / 60.0,
                    altitude_kind: AltitudeKind::ObservedHo,
                    sigma_arcmin: sigma,
                    limb: Limb::Center,
                    horizon: None,
                    geocentric: None,
                    notes: String::new(),
                }
            })
            .collect();
        Session {
            schema: SESSION_SCHEMA.to_string(),
            meta: SessionMeta::default(),
            observer: Observer {
                assumed_position: Some(LatLon {
                    lat_deg: 40.3,
                    lon_deg: -74.6,
                }),
                ..Observer::default()
            },
            instrument: Instrument::default(),
            clock: Clock::default(),
            observations,
        }
    }

    fn star() -> Star {
        Star {
            t0: T0,
            gha0: 150.0,
            dec: 38.8,
        }
    }

    #[test]
    fn a_clean_run_averages_to_the_true_altitude_at_any_instant() {
        let s = star();
        let truth = Point::from_deg(40.0, -75.0);
        let minutes = [-2.0, -1.0, 0.0, 1.0, 2.5];
        let mut session = run(&s, truth, &minutes, &[0.0; 5], 1.0);
        // A DR 2 NM from the truth: the predicted slope (about 10'/min here) is then
        // wrong by under 0.01'/min, so even 4 minutes away the average is within 0.05'.
        session.observer.assumed_position = Some(LatLon {
            lat_deg: 40.0 + 2.0 / 60.0,
            lon_deg: -75.0,
        });
        for reference in [
            None,
            Some(T0 + 0.5 / MINUTES_PER_DAY),
            Some(T0 - 4.0 / MINUTES_PER_DAY),
        ] {
            let options = AveragingOptions {
                reference_utc: reference.map(format_utc),
                ..Default::default()
            };
            let a = average_sights(&session, &s, &options).unwrap();
            let truth_h = hc_zn(truth, &s.direction("x", a.jd_utc).unwrap())
                .0
                .to_degrees();
            assert!(
                (a.ho_deg - truth_h).abs() * 60.0 < 0.05,
                "{:?}: {} vs {truth_h}",
                reference,
                a.ho_deg
            );
            assert_eq!(a.n_used, 5);
            assert!(a.outliers.is_empty());
            assert_eq!(a.observation.altitude_kind, AltitudeKind::ObservedHo);
            assert!((a.observation.altitude_deg - a.ho_deg).abs() < 1e-12);
        }
        // At the weighted mean time the sigma is exactly sigma / sqrt(N).
        let a = average_sights(&session, &s, &AveragingOptions::default()).unwrap();
        assert!((a.sigma_arcmin - 1.0 / 5f64.sqrt()).abs() < 1e-12);
        assert!(a.free_slope.as_ref().unwrap().consistent);
    }

    #[test]
    fn the_averaged_observation_goes_back_into_its_session_at_the_averaged_instant() {
        // Verifier regression: the observation's utc was the corrected instant, so put
        // back into a session with a chronometer correction the reducer added the
        // correction a second time (30 s: a 5.7' intercept for Vega at Philadelphia).
        let s = star();
        let truth = Point::from_deg(40.0, -75.0);
        for correction_s in [30.0, -12.5, 0.0] {
            let mut session = run(&s, truth, &[-1.0, 0.0, 1.0], &[0.0; 3], 0.5);
            session.clock.correction_s = correction_s;
            let a = average_sights(&session, &s, &AveragingOptions::default()).unwrap();
            let mut again = session.clone();
            again.observations = vec![a.observation.clone()];
            let r = crate::reduce::reduce_observation(&again, &again.observations[0], &s).unwrap();
            assert!(
                (r.jd_utc - a.jd_utc).abs() * SECONDS_PER_DAY < 1e-3,
                "{correction_s} s: reduced at {} for an average at {}",
                format_utc(r.jd_utc),
                a.utc
            );
            assert!((r.ho_deg - a.ho_deg).abs() < 1e-12);
            assert_eq!(
                a.observation.notes.contains("chronometer"),
                correction_s != 0.0,
                "{}",
                a.observation.notes
            );
        }
    }

    #[test]
    fn a_blunder_is_found_left_out_and_named() {
        let s = star();
        let truth = Point::from_deg(40.0, -75.0);
        let minutes = [-2.0, -1.0, 0.0, 1.0, 2.0, 3.0];
        let errors = [0.3, -0.4, 6.0, 0.1, -0.2, 0.4];
        let session = run(&s, truth, &minutes, &errors, 1.0);
        let a = average_sights(&session, &s, &AveragingOptions::default()).unwrap();
        assert_eq!(a.outliers, vec!["s2".to_string()]);
        assert_eq!(a.n_used, 5);
        assert!(!a.residuals[2].used && a.residuals[2].outlier);
        assert!(a.residuals[2].normalized_loo.unwrap() > 3.0);
        assert!(a.warnings.iter().any(|w| matches!(
            w,
            Warning::RunOutlier { id, rejected: true, .. } if id == "s2"
        )));
        // Kept (flagged only) when rejection is off.
        let keep = AveragingOptions {
            reject_outliers: false,
            ..Default::default()
        };
        let a = average_sights(&session, &s, &keep).unwrap();
        assert_eq!(a.n_used, 6);
        assert_eq!(a.outliers, vec!["s2".to_string()]);
    }

    #[test]
    fn two_sights_that_disagree_are_both_flagged_and_both_kept() {
        let s = star();
        let truth = Point::from_deg(40.0, -75.0);
        let session = run(&s, truth, &[0.0, 1.0], &[0.0, 8.0], 1.0);
        let a = average_sights(&session, &s, &AveragingOptions::default()).unwrap();
        assert_eq!(a.n_used, 2);
        assert_eq!(a.outliers.len(), 2);
    }

    #[test]
    fn a_wrong_time_shows_up_as_an_inconsistent_slope() {
        let s = star();
        let truth = Point::from_deg(40.0, -75.0);
        // Sights stamped one minute apart but taken three minutes apart: the altitudes
        // change three times faster than the ephemeris says they can.
        let minutes = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
        let mut session = run(&s, truth, &[0.0, 3.0, 6.0, 9.0, 12.0, 15.0], &[0.0; 6], 0.3);
        for (o, m) in session.observations.iter_mut().zip(minutes) {
            o.utc = format_utc(T0 + m / MINUTES_PER_DAY);
        }
        let a = average_sights(&session, &s, &AveragingOptions::default()).unwrap();
        let f = a.free_slope.as_ref().unwrap();
        assert!(!f.consistent, "{f:?}");
        assert!(
            a.warnings
                .iter()
                .any(|w| matches!(w, Warning::SlopeInconsistent { .. }))
        );
    }

    #[test]
    fn the_slope_sigma_is_reported_only_when_the_dr_sigma_is_stated() {
        let s = star();
        let truth = Point::from_deg(40.0, -75.0);
        let session = run(&s, truth, &[-1.0, 0.0, 1.0], &[0.0; 3], 1.0);
        let options = AveragingOptions {
            dr: Some(DrPosition {
                lat_deg: 40.3,
                lon_deg: -74.6,
                sigma_nm: Some(30.0),
            }),
            reference_utc: Some(format_utc(T0 + 5.0 / MINUTES_PER_DAY)),
            ..Default::default()
        };
        let a = average_sights(&session, &s, &options).unwrap();
        let ss = a.predicted_slope_sigma_arcmin_per_min.unwrap();
        assert!(ss > 0.0);
        // Five minutes from the middle of the run (to the millisecond the times carry).
        let expected = (1.0f64 / 3.0).sqrt().hypot(ss * 5.0);
        assert!(
            (a.sigma_arcmin - expected).abs() < 1e-5,
            "{} vs {expected}",
            a.sigma_arcmin
        );
        let bare = AveragingOptions {
            reference_utc: Some(format_utc(T0 + 5.0 / MINUTES_PER_DAY)),
            ..Default::default()
        };
        let a = average_sights(&session, &s, &bare).unwrap();
        assert!(a.predicted_slope_sigma_arcmin_per_min.is_none());
        assert!(
            a.warnings
                .iter()
                .any(|w| matches!(w, Warning::Other { message } if message.contains("not stated")))
        );
    }
}
