//! Replay a celestial fix series against an independently sourced reference track.
//!
//! BRIEF section C. `docs/MOTION.md` section "Replay" is normative.
//!
//! The reference track is a sequence of [`AbsolutePosition`]s from something else — a
//! GNSS receiver, a scaled odometry integration, a surveyed route. Each celestial fix is
//! compared against the reference **interpolated to that fix's instant**, and the output
//! is one [`Disagreement`] per comparable fix plus a [`Summary`].
//!
//! # Interpolation
//!
//! Between two reference samples `A` at `t0` and `B` at `t1`, with `w = (t - t0) / (t1 - t0)`:
//!
//! - **Position**: linear on the tangent plane — the tangent-plane offset from `A` to `B`
//!   is scaled by `w` and applied as a great-circle step from `A`. At `w = 0` and `w = 1`
//!   this returns `A` and `B` exactly.
//! - **Covariance**: `(1 - w) Ca + w Cb`, plus an isotropic interpolation term with
//!   1-sigma `k * w (1 - w) * L`, where `L` is the separation of the two samples in
//!   metres and `k` is [`ReplayOptions::interpolation_sag_coefficient`] (default 1.0).
//!
//! Both choices are deliberately **conservative**. The linear blend of covariances is
//! what you get if the two samples' errors are perfectly correlated — which is the right
//! assumption for consecutive samples from one receiver sharing one bias — and it never
//! drops below the smaller of the two. Treating them as independent would give
//! `(1-w)^2 Ca + w^2 Cb`, which is smaller in the middle of a gap and would make the
//! replay flag disagreements it has no business flagging. The sag term encodes the one
//! thing linear interpolation cannot know: what the vessel did between samples. It is
//! zero at the samples, peaks at `L / 4` in the middle of the gap, and is negligible for
//! a 1 Hz track while being correctly enormous for an hourly one.
//!
//! **Extrapolation is refused.** A fix outside the reference track's time span is listed
//! in [`ReplayResult::skipped`], not compared against the nearest endpoint.

use crate::compare::{AbsolutePosition, Disagreement, disagreement};
use crate::{to_latlon, to_point};
use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{angular_distance, apply_tangent_step, tangent_offset};
use skyfix_core::time::format_utc;
use skyfix_core::units::rad_to_m;
use std::cmp::Ordering;

/// Knobs for [`replay_detailed`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ReplayOptions {
    /// Multiplier on the interpolation-sag term `w (1 - w) L`. 1.0 admits a path that
    /// bulges by up to a quarter of the sample gap; 0.0 trusts linear interpolation
    /// completely and should be used only for a densely sampled track.
    pub interpolation_sag_coefficient: f64,
}

impl Default for ReplayOptions {
    fn default() -> Self {
        ReplayOptions {
            interpolation_sag_coefficient: 1.0,
        }
    }
}

/// One comparable fix: what was compared, and the result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayPoint {
    pub utc_jd: f64,
    pub celestial: AbsolutePosition,
    /// The reference track interpolated to `utc_jd`.
    pub reference: AbsolutePosition,
    pub disagreement: Disagreement,
}

/// A fix that could not be compared, and why.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkippedFix {
    pub utc_jd: f64,
    pub source: String,
    pub reason: String,
}

/// How the whole replay went.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Summary {
    /// Fixes actually compared.
    pub n: usize,
    /// Of those, how many were beyond their modelled uncertainty.
    pub n_beyond: usize,
    /// The largest Mahalanobis distance seen, with its statement.
    pub worst: Option<Disagreement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayResult {
    pub points: Vec<ReplayPoint>,
    pub skipped: Vec<SkippedFix>,
    pub summary: Summary,
}

/// Compare each celestial fix against the reference track interpolated to its instant.
///
/// Returns one [`Disagreement`] per **comparable** fix, in the input order. Fixes outside
/// the reference track's time span are not compared and not extrapolated; use
/// [`replay_detailed`] to see which ones and why.
pub fn replay(
    celestial_fixes: &[AbsolutePosition],
    reference_track: &[AbsolutePosition],
) -> Vec<Disagreement> {
    replay_detailed(celestial_fixes, reference_track, &ReplayOptions::default())
        .points
        .into_iter()
        .map(|p| p.disagreement)
        .collect()
}

/// [`replay`] with the interpolated reference, the skipped fixes and the summary kept.
pub fn replay_detailed(
    celestial_fixes: &[AbsolutePosition],
    reference_track: &[AbsolutePosition],
    options: &ReplayOptions,
) -> ReplayResult {
    let mut track: Vec<&AbsolutePosition> = reference_track
        .iter()
        .filter(|p| p.utc_jd.is_finite())
        .collect();
    track.sort_by(|a, b| a.utc_jd.partial_cmp(&b.utc_jd).unwrap_or(Ordering::Equal));

    let mut points = Vec::new();
    let mut skipped = Vec::new();
    for fix in celestial_fixes {
        match interpolate(&track, fix.utc_jd, options) {
            Ok(reference) => {
                let d = disagreement(fix, &reference);
                points.push(ReplayPoint {
                    utc_jd: fix.utc_jd,
                    celestial: fix.clone(),
                    reference,
                    disagreement: d,
                });
            }
            Err(reason) => skipped.push(SkippedFix {
                utc_jd: fix.utc_jd,
                source: fix.source.clone(),
                reason,
            }),
        }
    }

    let summary = summarize_points(&points);
    ReplayResult {
        points,
        skipped,
        summary,
    }
}

/// Count the disagreements and find the worst.
pub fn summarize(disagreements: &[Disagreement]) -> Summary {
    let n_beyond = disagreements
        .iter()
        .filter(|d| d.beyond_modelled_uncertainty)
        .count();
    let worst = disagreements
        .iter()
        .max_by(|a, b| {
            a.mahalanobis
                .partial_cmp(&b.mahalanobis)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    a.separation_m
                        .partial_cmp(&b.separation_m)
                        .unwrap_or(Ordering::Equal)
                })
        })
        .cloned();
    Summary {
        n: disagreements.len(),
        n_beyond,
        worst,
    }
}

fn summarize_points(points: &[ReplayPoint]) -> Summary {
    let ds: Vec<Disagreement> = points.iter().map(|p| p.disagreement.clone()).collect();
    summarize(&ds)
}

/// The reference track at `t`, or why it cannot be had there.
fn interpolate(
    track: &[&AbsolutePosition],
    t: f64,
    options: &ReplayOptions,
) -> Result<AbsolutePosition, String> {
    if !t.is_finite() {
        return Err("the fix has no finite timestamp".to_string());
    }
    let (Some(first), Some(last)) = (track.first(), track.last()) else {
        return Err("the reference track is empty".to_string());
    };
    if t < first.utc_jd || t > last.utc_jd {
        return Err(format!(
            "{} is outside the reference track, which spans {} to {}; the track is not \
             extrapolated",
            format_utc(t),
            format_utc(first.utc_jd),
            format_utc(last.utc_jd)
        ));
    }

    // Last sample at or before t.
    let mut i = 0usize;
    for (k, p) in track.iter().enumerate() {
        if p.utc_jd <= t {
            i = k;
        } else {
            break;
        }
    }
    let a = track[i];
    let Some(b) = track.get(i + 1) else {
        // t == last sample.
        return Ok(relabel(a, t));
    };
    let span = b.utc_jd - a.utc_jd;
    if span <= 0.0 {
        return Ok(relabel(a, t));
    }
    let w = ((t - a.utc_jd) / span).clamp(0.0, 1.0);

    let pa = to_point(a.position);
    let pb = to_point(b.position);
    let (dn, de) = tangent_offset(pa, pb);
    let position = to_latlon(apply_tangent_step(pa, w * dn, w * de));

    // Conservative blend: what perfectly correlated endpoint errors would give.
    let mut cov = [[0.0f64; 2]; 2];
    for (row, (ra, rb)) in cov
        .iter_mut()
        .zip(a.covariance_ne_m2.iter().zip(b.covariance_ne_m2.iter()))
    {
        for (v, (va, vb)) in row.iter_mut().zip(ra.iter().zip(rb.iter())) {
            *v = (1.0 - w) * va + w * vb;
        }
    }
    // Plus what linear interpolation cannot know: the path between the samples.
    let gap_m = rad_to_m(angular_distance(pa, pb));
    let k = if options.interpolation_sag_coefficient.is_finite() {
        options.interpolation_sag_coefficient.abs()
    } else {
        0.0
    };
    let sag = k * w * (1.0 - w) * gap_m;
    cov[0][0] += sag * sag;
    cov[1][1] += sag * sag;

    Ok(AbsolutePosition::new(
        t,
        position,
        cov,
        format!("{} (interpolated)", a.source),
    ))
}

fn relabel(p: &AbsolutePosition, t: f64) -> AbsolutePosition {
    AbsolutePosition::new(t, p.position, p.covariance_ne_m2, p.source.clone())
}

/// The replay as CSV, one row per compared fix. Skipped fixes are emitted as `#` comment
/// lines so a reader cannot mistake a short file for a clean one.
pub fn to_csv(result: &ReplayResult) -> String {
    let mut out = String::new();
    out.push_str(
        "utc,celestial_source,celestial_lat_deg,celestial_lon_deg,reference_source,\
         reference_lat_deg,reference_lon_deg,separation_m,mahalanobis,chi2_p_value,\
         beyond_modelled_uncertainty,statement\n",
    );
    for p in &result.points {
        let d = &p.disagreement;
        out.push_str(&format!(
            "{},{},{:.6},{:.6},{},{:.6},{:.6},{:.3},{:.4},{:.6e},{},{}\n",
            format_utc(p.utc_jd),
            csv_field(&p.celestial.source),
            p.celestial.position.lat_deg,
            p.celestial.position.lon_deg,
            csv_field(&p.reference.source),
            p.reference.position.lat_deg,
            p.reference.position.lon_deg,
            d.separation_m,
            d.mahalanobis,
            d.chi2_p_value,
            d.beyond_modelled_uncertainty,
            csv_field(&d.statement),
        ));
    }
    for s in &result.skipped {
        out.push_str(&format!(
            "# skipped {} ({}): {}\n",
            format_utc(s.utc_jd),
            s.source,
            s.reason
        ));
    }
    out.push_str(&format!(
        "# summary: n={} n_beyond={} worst_mahalanobis={}\n",
        result.summary.n,
        result.summary.n_beyond,
        result
            .summary
            .worst
            .as_ref()
            .map_or("none".to_string(), |w| format!("{:.4}", w.mahalanobis))
    ));
    out
}

/// The replay as JSON. Round-trips through [`ReplayResult`].
pub fn to_json(result: &ReplayResult) -> String {
    serde_json::to_string_pretty(result).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use skyfix_core::types::LatLon;
    use skyfix_core::units::m_to_rad;

    const T0: f64 = 2_461_314.5;
    const HOUR: f64 = 1.0 / 24.0;

    fn gnss(t: f64, lat: f64, lon: f64, sigma: f64) -> AbsolutePosition {
        AbsolutePosition::isotropic(
            t,
            LatLon {
                lat_deg: lat,
                lon_deg: lon,
            },
            sigma,
            "GNSS receiver",
        )
    }

    fn offset_from(p: &AbsolutePosition, north_m: f64, east_m: f64) -> LatLon {
        to_latlon(apply_tangent_step(
            to_point(p.position),
            m_to_rad(north_m),
            m_to_rad(east_m),
        ))
    }

    #[test]
    fn interpolation_hits_the_endpoints_exactly() {
        let track = [
            gnss(T0, 40.0, -70.0, 5.0),
            gnss(T0 + HOUR, 40.1, -69.9, 7.0),
        ];
        let refs: Vec<&AbsolutePosition> = track.iter().collect();
        let opts = ReplayOptions::default();
        let a = interpolate(&refs, T0, &opts).unwrap();
        assert_relative_eq!(a.position.lat_deg, 40.0, epsilon = 1e-12);
        assert_relative_eq!(a.covariance_ne_m2[0][0], 25.0, epsilon = 1e-9);
        let b = interpolate(&refs, T0 + HOUR, &opts).unwrap();
        assert_relative_eq!(b.position.lat_deg, 40.1, epsilon = 1e-12);
        assert_relative_eq!(b.covariance_ne_m2[0][0], 49.0, epsilon = 1e-9);
    }

    #[test]
    fn interpolation_is_conservative_in_the_middle_of_a_gap() {
        let track = [
            gnss(T0, 40.0, -70.0, 5.0),
            gnss(T0 + HOUR, 40.0, -70.0, 5.0),
        ];
        let refs: Vec<&AbsolutePosition> = track.iter().collect();
        // Both samples identical: the blend alone is exactly 25 m^2, and the sag term is
        // zero because the samples coincide.
        let mid = interpolate(&refs, T0 + 0.5 * HOUR, &ReplayOptions::default()).unwrap();
        assert_relative_eq!(mid.covariance_ne_m2[0][0], 25.0, epsilon = 1e-9);

        // Separated samples: the sag term is (L / 4)^2 at the midpoint.
        let far = [
            gnss(T0, 40.0, -70.0, 5.0),
            AbsolutePosition::isotropic(
                T0 + HOUR,
                offset_from(&track[0], 4000.0, 0.0),
                5.0,
                "GNSS receiver",
            ),
        ];
        let refs: Vec<&AbsolutePosition> = far.iter().collect();
        let mid = interpolate(&refs, T0 + 0.5 * HOUR, &ReplayOptions::default()).unwrap();
        let expected = 25.0 + (4000.0f64 / 4.0).powi(2);
        assert_relative_eq!(mid.covariance_ne_m2[0][0], expected, epsilon = 1.0);
        // Midway in position, too.
        let (n, _) = tangent_offset(to_point(far[0].position), to_point(mid.position));
        assert_relative_eq!(rad_to_m(n), 2000.0, epsilon = 1.0);

        // Turning the sag term off leaves only the blend.
        let tight = interpolate(
            &refs,
            T0 + 0.5 * HOUR,
            &ReplayOptions {
                interpolation_sag_coefficient: 0.0,
            },
        )
        .unwrap();
        assert_relative_eq!(tight.covariance_ne_m2[0][0], 25.0, epsilon = 1e-9);
    }

    #[test]
    fn fixes_outside_the_track_are_skipped_not_extrapolated() {
        let track = vec![
            gnss(T0, 40.0, -70.0, 5.0),
            gnss(T0 + HOUR, 40.0, -70.0, 5.0),
        ];
        let fixes = vec![
            AbsolutePosition::isotropic(T0 - HOUR, track[0].position, 900.0, "celestial fix"),
            AbsolutePosition::isotropic(T0 + 0.5 * HOUR, track[0].position, 900.0, "celestial fix"),
            AbsolutePosition::isotropic(T0 + 2.0 * HOUR, track[0].position, 900.0, "celestial fix"),
        ];
        let result = replay_detailed(&fixes, &track, &ReplayOptions::default());
        assert_eq!(result.points.len(), 1);
        assert_eq!(result.skipped.len(), 2);
        assert!(
            result.skipped[0].reason.contains("not"),
            "{:?}",
            result.skipped[0]
        );
        assert!(result.skipped[0].reason.contains("extrapolated"));
        assert_eq!(result.summary.n, 1);
        assert_eq!(result.summary.n_beyond, 0);

        // An empty track skips everything.
        let empty = replay_detailed(&fixes, &[], &ReplayOptions::default());
        assert_eq!(empty.points.len(), 0);
        assert_eq!(empty.skipped.len(), 3);
        assert!(empty.summary.worst.is_none());
    }

    #[test]
    fn replay_flags_the_displaced_fix_and_summarises() {
        let track: Vec<AbsolutePosition> = (0..5)
            .map(|i| gnss(T0 + f64::from(i) * HOUR, 40.0, -70.0, 5.0))
            .collect();
        let sigma_m = 200.0;
        let mut fixes = Vec::new();
        for i in 0..4 {
            // Three agree, one is 2 km north.
            let north = if i == 2 { 2000.0 } else { 0.0 };
            fixes.push(AbsolutePosition::isotropic(
                T0 + (f64::from(i) + 0.5) * HOUR,
                offset_from(&track[0], north, 0.0),
                sigma_m,
                "celestial running fix",
            ));
        }
        let disagreements = replay(&fixes, &track);
        assert_eq!(disagreements.len(), 4);
        assert_eq!(
            disagreements
                .iter()
                .filter(|d| d.beyond_modelled_uncertainty)
                .count(),
            1
        );
        let summary = summarize(&disagreements);
        assert_eq!(summary.n, 4);
        assert_eq!(summary.n_beyond, 1);
        let worst = summary.worst.expect("a worst point");
        assert_relative_eq!(worst.separation_m, 2000.0, epsilon = 1.0);
        assert!(worst.statement.contains("celestial running fix"));
    }

    #[test]
    fn csv_and_json_round_trip() {
        let track = vec![
            gnss(T0, 40.0, -70.0, 5.0),
            gnss(T0 + 2.0 * HOUR, 40.0, -70.0, 5.0),
        ];
        let fixes = vec![
            AbsolutePosition::isotropic(
                T0 + HOUR,
                offset_from(&track[0], 3000.0, 0.0),
                200.0,
                "celestial running fix",
            ),
            AbsolutePosition::isotropic(T0 + 5.0 * HOUR, track[0].position, 200.0, "late fix"),
        ];
        let result = replay_detailed(&fixes, &track, &ReplayOptions::default());
        let csv = to_csv(&result);
        let lines: Vec<&str> = csv.lines().collect();
        assert!(lines[0].starts_with("utc,celestial_source,"));
        assert_eq!(lines.len(), 4, "header, one row, one skip, one summary");
        assert!(lines[1].contains("celestial running fix"));
        // The statement contains commas, so it must be quoted.
        assert!(lines[1].contains("\"Estimate A ("));
        assert!(lines[2].starts_with("# skipped"));
        assert!(lines[3].starts_with("# summary: n=1 n_beyond=1"));

        let json = to_json(&result);
        let back: ReplayResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back, result);
    }

    #[test]
    fn duplicate_and_unsorted_reference_samples_are_handled() {
        let track = vec![
            gnss(T0 + 2.0 * HOUR, 40.2, -70.0, 5.0),
            gnss(T0, 40.0, -70.0, 5.0),
            gnss(T0, 40.0, -70.0, 5.0),
            gnss(f64::NAN, 0.0, 0.0, 5.0),
        ];
        let fixes = vec![AbsolutePosition::isotropic(
            T0 + HOUR,
            LatLon {
                lat_deg: 40.1,
                lon_deg: -70.0,
            },
            5000.0,
            "celestial fix",
        )];
        let result = replay_detailed(&fixes, &track, &ReplayOptions::default());
        assert_eq!(result.points.len(), 1);
        assert_relative_eq!(
            result.points[0].reference.position.lat_deg,
            40.1,
            epsilon = 1e-3
        );
        assert!(!result.points[0].disagreement.beyond_modelled_uncertainty);
    }
}
