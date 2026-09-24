//! Identified stars plus a local vertical become observations the core can reduce.
//!
//! # The signature is the argument
//!
//! [`altitudes_from_camera`] takes a `&LocalVertical`. Not an `Option`, not a default,
//! not something it can work out from the star field. Without a vertical there is no
//! call to make, and that is the BRIEF's non-negotiable item 2 written as a function
//! signature: an image gives orientation, and orientation plus gravity gives altitudes,
//! and altitudes plus time give a position. Take gravity away and the chain stops.
//!
//! Note also what this function does **not** need: the attitude. The altitude of a star
//! is the angle between its direction in the camera frame and the local vertical in the
//! same frame, and both of those are available before any rotation is solved. Attitude
//! and altitude are two independent products of the same image, which is exactly why
//! they are separate deliverables.
//!
//! # What the camera measures, in the core's vocabulary
//!
//! | field | value | why |
//! |---|---|---|
//! | `altitude_kind` | [`AltitudeKind::ApparentHa`] | the camera sees the **refracted** sky, so the angle from the vertical is `Ha`. The core then subtracts Bennett refraction (CONVENTIONS section 5 step 3) to reach `Ho`. Claiming `ObservedHo` here would skip refraction entirely and bias every fix by one to three arcminutes. |
//! | `horizon` | [`HorizonMode::ElectronicVertical`] | there is no sea horizon in the measurement and therefore **no dip**. The index correction is the instrument's zero offset; for a camera it is zero unless the vertical is known to be offset. |
//! | `sigma_arcmin` | centroid and vertical terms in quadrature | see below |
//! | `geocentric` | `None` | the provider supplies GHA/Dec at reduction time. Filling it here would duplicate the ephemeris and let the two drift apart. |
//! | `limb` | [`Limb::Center`] | a star is a point source. |
//!
//! # The error budget of one camera sight
//!
//! ```text
//! sigma^2 = (centroid_sigma_px * angular_scale_at(u, v))^2   per-star, random
//!         + (vertical.sigma_arcmin)^2                        COMMON to every star
//! ```
//!
//! The two terms are not the same kind of error, and the second is the dangerous one.
//! The centroid term is independent per star, so five stars beat one by `sqrt(5)`. The
//! vertical term is a single tilt shared by every sight in the frame: it moves them all
//! the same way and averaging does nothing (BRIEF non-negotiable item 6). A camera
//! sextant is a vertical-measuring instrument that happens to have a lens on it.
//!
//! They are nevertheless combined into one `sigma_arcmin` here, because
//! `skyfix.session/1` has one sigma per observation and the core's model
//! (CONVENTIONS section 8) treats sights as independent. That is a deliberate,
//! documented approximation: it gets the *size* of the uncertainty right and the
//! *correlation* wrong, which makes the reported ellipse optimistic in the direction
//! the vertical tilts. [`CameraSights::shared_vertical_sigma_arcmin`] carries the
//! common part separately so a caller can say so, and `docs/CAMERA.md` records that
//! modelling it properly needs a shared-bias term the solver already supports
//! (`estimate_shared_bias`) or a full covariance the session schema does not yet have.

use crate::camera::Intrinsics;
use crate::centroid::Centroid;
use crate::error::CameraError;
use crate::identify::Match;
use crate::vertical::LocalVertical;
use serde::{Deserialize, Serialize};
use skyfix_core::types::{AltitudeKind, HorizonMode, Limb, Observation};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SightOptions {
    /// 1-sigma centroid accuracy, pixels. The same number the identification tolerance
    /// was derived from.
    pub centroid_sigma_px: f64,
    /// Prefix for generated observation ids: `"cam"` gives `cam-1`, `cam-2`, ...
    pub id_prefix: String,
    /// Reject sights below this apparent altitude. CONVENTIONS section 5 rejects
    /// refraction below 0 degrees outright and flags below 10; the default 5 keeps
    /// camera sights inside the part of Bennett's range the core will not inflate.
    pub min_altitude_deg: f64,
    /// Reject centroids whose blob touched saturation. A flat-topped core centroids to
    /// the middle of the flat top, not to the star.
    pub reject_saturated: bool,
    /// Floor on the reported sigma, arcminutes. Nothing about a camera sight is better
    /// than this, whatever the arithmetic says.
    pub sigma_floor_arcmin: f64,
}

impl Default for SightOptions {
    fn default() -> Self {
        SightOptions {
            centroid_sigma_px: 0.2,
            id_prefix: "cam".to_string(),
            min_altitude_deg: 5.0,
            reject_saturated: true,
            sigma_floor_arcmin: 0.05,
        }
    }
}

/// Why a match did not become an observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedSight {
    pub star_name: String,
    pub centroid_index: usize,
    pub reason: String,
}

/// The observations, plus the parts of their uncertainty the session schema cannot
/// express.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CameraSights {
    pub observations: Vec<Observation>,
    pub rejected: Vec<RejectedSight>,
    /// The part of every sight's sigma that is **common** to all of them: the tilt of
    /// the local vertical. Averaging does not reduce it.
    pub shared_vertical_sigma_arcmin: f64,
    /// Where the vertical came from, in words, for the session notes.
    pub vertical_source: String,
}

/// Turn identified stars into `skyfix.session/1` observations.
///
/// The `vertical` argument is mandatory and is the whole point; see the module docs.
/// `utc` is the exposure time, which must already be the time the *sky* was at — this
/// crate does not model shutter latency or rolling shutter.
pub fn altitudes_from_camera(
    matches: &[Match],
    centroids: &[Centroid],
    intrinsics: &Intrinsics,
    vertical: &LocalVertical,
    utc: &str,
    options: &SightOptions,
) -> Result<CameraSights, CameraError> {
    // Validate the time even though nothing here uses the number: an observation with
    // an unparseable timestamp would be rejected later, further from the cause.
    skyfix_core::time::parse_utc(utc).map_err(|e| CameraError::Time {
        utc: utc.to_string(),
        reason: e.to_string(),
    })?;
    if !options.centroid_sigma_px.is_finite() || options.centroid_sigma_px < 0.0 {
        return Err(CameraError::invalid(
            "sights.centroid_sigma_px",
            "must be finite and non-negative",
        ));
    }

    let mut observations = Vec::with_capacity(matches.len());
    let mut rejected = Vec::new();
    for m in matches {
        let Some(c) = centroids.get(m.centroid_index) else {
            return Err(CameraError::invalid(
                "sights.matches",
                format!(
                    "match names centroid {} but only {} were given",
                    m.centroid_index,
                    centroids.len()
                ),
            ));
        };
        if options.reject_saturated && c.saturated {
            rejected.push(RejectedSight {
                star_name: m.star_name.clone(),
                centroid_index: m.centroid_index,
                reason: "the blob reached saturation; its centroid is the middle of a \
                         flat top, not the star"
                    .to_string(),
            });
            continue;
        }
        let dir = intrinsics.unproject(c.u, c.v);
        let altitude_deg = vertical.altitude_of(dir).to_degrees();
        if !altitude_deg.is_finite() || altitude_deg < options.min_altitude_deg {
            rejected.push(RejectedSight {
                star_name: m.star_name.clone(),
                centroid_index: m.centroid_index,
                reason: format!(
                    "apparent altitude {altitude_deg:.3} deg is below the {:.1} deg \
                     floor, where the refraction model is unreliable",
                    options.min_altitude_deg
                ),
            });
            continue;
        }
        // Per-star random term: the centroid error through the local plate scale.
        let centroid_arcmin =
            options.centroid_sigma_px * intrinsics.angular_scale_at(c.u, c.v).to_degrees() * 60.0;
        let sigma_arcmin = centroid_arcmin
            .hypot(vertical.sigma_arcmin)
            .max(options.sigma_floor_arcmin);
        observations.push(Observation {
            id: format!("{}-{}", options.id_prefix, observations.len() + 1),
            body: m.star_name.clone(),
            utc: utc.to_string(),
            altitude_deg,
            // The camera measured the refracted sky: this is Ha, not Ho.
            altitude_kind: AltitudeKind::ApparentHa,
            sigma_arcmin,
            limb: Limb::Center,
            // No sea horizon in the measurement, so no dip.
            horizon: Some(HorizonMode::ElectronicVertical),
            // The ephemeris provider fills this at reduction time.
            geocentric: None,
            notes: format!(
                "camera sight: centroid ({:.3}, {:.3}) px, flux {:.0}, identification \
                 residual {:.1}\"; sigma = {:.3}' centroid + {:.3}' vertical ({:?}) in \
                 quadrature. The vertical term is COMMON to every sight in this frame.",
                c.u,
                c.v,
                c.flux,
                m.residual_arcsec,
                centroid_arcmin,
                vertical.sigma_arcmin,
                vertical.source
            ),
        });
    }

    Ok(CameraSights {
        observations,
        rejected,
        shared_vertical_sigma_arcmin: vertical.sigma_arcmin,
        vertical_source: format!("{:?}", vertical.source),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::centroid::{CentroidOptions, detect};
    use crate::frames::camera_from_enu;
    use crate::identify::{CatalogueSnapshot, IdentifyOptions, identify};
    use crate::render::{RenderOptions, render};
    use crate::rng::Rng;
    use crate::vertical::{InclinometerSim, simulated_inclinometer};
    use approx::assert_relative_eq;
    use skyfix_core::geometry::Point;
    use skyfix_ephemeris::stars::StarProvider;

    const UTC: &str = "2026-10-01T05:30:00Z";
    fn philadelphia() -> Point {
        Point::from_deg(39.9526, -75.1652)
    }

    fn pipeline() -> (
        Vec<Match>,
        Vec<Centroid>,
        Intrinsics,
        LocalVertical,
        crate::render::RenderTruth,
    ) {
        pipeline_with(RenderOptions::default())
    }

    fn pipeline_with(
        options: RenderOptions,
    ) -> (
        Vec<Match>,
        Vec<Centroid>,
        Intrinsics,
        LocalVertical,
        crate::render::RenderTruth,
    ) {
        let k = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians());
        let att = camera_from_enu(25f64.to_radians(), 100f64.to_radians(), 6f64.to_radians());
        let (image, truth) = render(
            UTC,
            philadelphia(),
            &att,
            &k,
            &StarProvider::new(),
            &options,
        )
        .unwrap();
        let centroids = detect(
            &image,
            &CentroidOptions {
                min_flux: 200.0,
                ..CentroidOptions::default()
            },
        );
        let cat = CatalogueSnapshot::at(&StarProvider::new(), UTC).unwrap();
        let id = identify(
            &centroids,
            &k,
            &cat,
            &IdentifyOptions::from_centroid_sigma(0.2, &k, 5.0),
        );
        assert!(id.is_identified(), "{:?}", id.status);
        let v = simulated_inclinometer(
            truth.up_camera,
            &InclinometerSim::default(),
            &mut Rng::new(99),
        )
        .unwrap();
        (id.matches, centroids, k, v, truth)
    }

    #[test]
    fn observations_carry_the_conventions_a_camera_sight_must() {
        let (matches, centroids, k, v, truth) = pipeline();
        let out =
            altitudes_from_camera(&matches, &centroids, &k, &v, UTC, &SightOptions::default())
                .unwrap();
        assert_eq!(out.observations.len(), matches.len());
        assert!(out.rejected.is_empty());
        assert_relative_eq!(out.shared_vertical_sigma_arcmin, 0.5);
        assert!(out.vertical_source.contains("Inclinometer"));
        for (i, o) in out.observations.iter().enumerate() {
            assert_eq!(o.id, format!("cam-{}", i + 1));
            assert_eq!(o.utc, UTC);
            // The camera sees the refracted sky: apparent Ha, electronic vertical, no
            // dip, no supplied direction, centre limb.
            assert_eq!(o.altitude_kind, AltitudeKind::ApparentHa);
            assert_eq!(o.horizon, Some(HorizonMode::ElectronicVertical));
            assert_eq!(o.geocentric, None);
            assert_eq!(o.limb, Limb::Center);
            assert!(
                o.sigma_arcmin > 0.5 && o.sigma_arcmin < 1.0,
                "{}",
                o.sigma_arcmin
            );
            assert!(o.notes.contains("COMMON"));
            // And the altitude really is the star's APPARENT altitude, which the
            // renderer recorded independently.
            let s = truth.stars.iter().find(|s| s.name == o.body).unwrap();
            let err_arcmin = (o.altitude_deg - s.apparent_altitude_deg).abs() * 60.0;
            assert!(
                err_arcmin < 3.0,
                "{}: measured {:.5} deg against a true apparent {:.5} deg ({err_arcmin:.3}')",
                o.body,
                o.altitude_deg,
                s.apparent_altitude_deg
            );
            // ... NOT its geometric altitude. Refraction is still in the number, which
            // is exactly what altitude_kind = apparent_ha promises the reducer.
            assert!(o.altitude_deg > s.true_altitude_deg);
        }
    }

    #[test]
    fn a_perfect_vertical_gives_the_apparent_altitude_to_arcseconds() {
        // Isolate the vertical: hand in the truth as a supplied vertical and see what
        // the optics alone are worth.
        let (matches, centroids, k, _, truth) = pipeline();
        let perfect = LocalVertical::supplied(truth.up_camera, 0.001).unwrap();
        let out = altitudes_from_camera(
            &matches,
            &centroids,
            &k,
            &perfect,
            UTC,
            &SightOptions::default(),
        )
        .unwrap();
        let mut worst: f64 = 0.0;
        for o in &out.observations {
            let s = truth.stars.iter().find(|s| s.name == o.body).unwrap();
            worst = worst.max((o.altitude_deg - s.apparent_altitude_deg).abs() * 3600.0);
        }
        // What is left is centroid noise on the faintest stars in the frame, and it is
        // inside the 0.49' (29") sigma the sights report. The reported sigma is
        // therefore conservative rather than optimistic, which is the direction an
        // error budget is allowed to be wrong in.
        assert!(worst < 40.0, "worst altitude error {worst:.2} arcsec");

        // With no photons wasted on noise, the optics and the frames are exact: the
        // whole chain from pixel to altitude is good to a hundredth of an arcsecond.
        let (m2, c2, k2, _, t2) = pipeline_with(RenderOptions::default().noiseless());
        let perfect2 = LocalVertical::supplied(t2.up_camera, 0.001).unwrap();
        let clean =
            altitudes_from_camera(&m2, &c2, &k2, &perfect2, UTC, &SightOptions::default()).unwrap();
        let mut worst_clean: f64 = 0.0;
        for o in &clean.observations {
            let s = t2.stars.iter().find(|s| s.name == o.body).unwrap();
            worst_clean =
                worst_clean.max((o.altitude_deg - s.apparent_altitude_deg).abs() * 3600.0);
        }
        assert!(
            worst_clean < 0.1,
            "noiseless altitude error {worst_clean:.4} arcsec"
        );
    }

    #[test]
    fn the_vertical_moves_every_sight_the_same_way() {
        // BRIEF non-negotiable item 6: a common tilt is not noise. Tilt the vertical by
        // 3 arcminutes and watch every altitude move together, not scatter.
        let (matches, centroids, k, _, truth) = pipeline();
        let opts = SightOptions::default();
        let straight = LocalVertical::supplied(truth.up_camera, 0.001).unwrap();
        let tilted_up =
            crate::frames::Rotation::about_axis([1.0, 0.0, 0.0], (3.0f64 / 60.0).to_radians())
                .rotate(truth.up_camera);
        let tilted = LocalVertical::supplied(tilted_up, 0.001).unwrap();
        let a = altitudes_from_camera(&matches, &centroids, &k, &straight, UTC, &opts).unwrap();
        let b = altitudes_from_camera(&matches, &centroids, &k, &tilted, UTC, &opts).unwrap();
        let shifts: Vec<f64> = a
            .observations
            .iter()
            .zip(&b.observations)
            .map(|(x, y)| (y.altitude_deg - x.altitude_deg) * 60.0)
            .collect();
        let mean = shifts.iter().sum::<f64>() / shifts.len() as f64;
        let spread = shifts
            .iter()
            .map(|s| (s - mean).abs())
            .fold(0.0f64, f64::max);
        assert!(
            mean.abs() > 0.3,
            "a 3' tilt should move the sights: mean shift {mean:.3}'"
        );
        assert!(
            spread < 3.0,
            "the shift is a common tilt, not independent noise: spread {spread:.3}'"
        );
    }

    #[test]
    fn saturated_low_and_broken_sights_are_rejected_with_reasons() {
        let (matches, mut centroids, k, v, _) = pipeline();
        // Saturate the first matched star's blob.
        let first = matches[0].centroid_index;
        centroids[first].saturated = true;
        let out =
            altitudes_from_camera(&matches, &centroids, &k, &v, UTC, &SightOptions::default())
                .unwrap();
        assert_eq!(out.observations.len(), matches.len() - 1);
        assert_eq!(out.rejected.len(), 1);
        assert!(out.rejected[0].reason.contains("saturation"));
        // Keeping them is opt-in.
        let kept = altitudes_from_camera(
            &matches,
            &centroids,
            &k,
            &v,
            UTC,
            &SightOptions {
                reject_saturated: false,
                ..SightOptions::default()
            },
        )
        .unwrap();
        assert_eq!(kept.observations.len(), matches.len());

        // A vertical pointing the wrong way puts every star below the altitude floor.
        let upside_down =
            LocalVertical::supplied([-v.up_camera[0], -v.up_camera[1], -v.up_camera[2]], 0.5)
                .unwrap();
        let none = altitudes_from_camera(
            &matches,
            &centroids,
            &k,
            &upside_down,
            UTC,
            &SightOptions::default(),
        )
        .unwrap();
        assert!(none.observations.is_empty());
        assert_eq!(none.rejected.len(), matches.len());
        assert!(
            none.rejected.iter().any(|r| r.reason.contains("below")),
            "{:?}",
            none.rejected
        );

        // Malformed inputs.
        assert!(
            altitudes_from_camera(&matches, &[], &k, &v, UTC, &SightOptions::default()).is_err()
        );
        assert!(
            altitudes_from_camera(
                &matches,
                &centroids,
                &k,
                &v,
                "01:30 on the first",
                &SightOptions::default()
            )
            .is_err()
        );
        assert!(
            altitudes_from_camera(
                &matches,
                &centroids,
                &k,
                &v,
                UTC,
                &SightOptions {
                    centroid_sigma_px: f64::NAN,
                    ..SightOptions::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn sigma_combines_the_centroid_and_the_vertical_in_quadrature() {
        let (matches, centroids, k, _, truth) = pipeline();
        let tiny = LocalVertical::supplied(truth.up_camera, 0.01).unwrap();
        let coarse = LocalVertical::supplied(truth.up_camera, 5.0).unwrap();
        let opts = SightOptions::default();
        let a = altitudes_from_camera(&matches, &centroids, &k, &tiny, UTC, &opts).unwrap();
        let b = altitudes_from_camera(&matches, &centroids, &k, &coarse, UTC, &opts).unwrap();
        // With a near-perfect vertical only the centroid term is left: 0.2 px on a
        // 1024 px / 40 degree lens is 0.2 * 2.44' = 0.49'.
        assert_relative_eq!(a.observations[0].sigma_arcmin, 0.49, max_relative = 0.15);
        // With a 5' vertical the quadrature sum is dominated by it.
        let want = (a.observations[0].sigma_arcmin.powi(2) - 0.01f64.powi(2) + 25.0).sqrt();
        assert_relative_eq!(b.observations[0].sigma_arcmin, want, max_relative = 1e-9);
        assert!(b.observations[0].sigma_arcmin > 5.0);
        assert_relative_eq!(b.shared_vertical_sigma_arcmin, 5.0);
        // The floor bites when both terms vanish.
        let floored = altitudes_from_camera(
            &matches,
            &centroids,
            &k,
            &LocalVertical::supplied(truth.up_camera, 1e-6).unwrap(),
            UTC,
            &SightOptions {
                centroid_sigma_px: 0.0,
                sigma_floor_arcmin: 0.25,
                ..opts
            },
        )
        .unwrap();
        assert_relative_eq!(floored.observations[0].sigma_arcmin, 0.25);
    }
}
