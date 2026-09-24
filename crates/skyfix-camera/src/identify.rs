//! Closed-world star identification by pairwise angular distance.
//!
//! # Closed world: say it out loud
//!
//! The reference set is the **58 stars** of [`skyfix_ephemeris::catalog`] — the 57
//! Nautical Almanac navigational stars plus Polaris — and their `58 * 57 / 2 = 1653`
//! pair angles. Nothing else exists as far as this module is concerned.
//!
//! A real camera that can centroid a magnitude-2 star sees hundreds of stars in the
//! same frame, and most of them are not in this catalogue. Feeding such an image to
//! this module would produce dozens of unmatched centroids and would make the pair
//! voting much harder, because a wrong pair angle drawn from a large unmodelled
//! population is far more likely to land inside the tolerance. A production star
//! tracker needs a catalogue to the sensor's limiting magnitude and a real geometric
//! index (a k-vector over pair angles, or a triangle/pyramid hash), not a linear scan
//! of 1653 pairs. This is the first experiment; `docs/CAMERA.md` carries the backlog.
//!
//! What the closed world does **not** do is cheat: no position prior, no attitude
//! prior, no "stars that could be in the field" filter derived from the truth. Every
//! one of the 1653 pairs is a candidate for every measured pair, which is the honest
//! lost-in-space problem for this catalogue.
//!
//! # Algorithm
//!
//! 1. Unproject each centroid to a unit vector in the camera frame.
//! 2. Measure the angle of every centroid pair. Angles are frame-independent, so no
//!    attitude is needed and none is assumed.
//! 3. For every measured pair, find the catalogue pairs whose angle is within the
//!    tolerance (binary search over the sorted pair table) and cast a vote for each of
//!    the four `(centroid, star)` assignments that pair would imply.
//! 4. Assign greedily by vote count, one star per centroid.
//! 5. **Verify**: keep only a mutually consistent set — every surviving pair of
//!    identified stars must have the catalogue angle between them, within tolerance.
//!    Offenders are dropped one at a time, worst first. A set of three mutually
//!    consistent stars is a verified triangle; the same rule extends to any size.
//! 6. Fewer than [`IdentifyOptions::min_stars`] survivors is an explicit failure, not
//!    an empty success.
//!
//! # What the result means
//!
//! A [`Match`] says "this blob is that star". It says nothing about where the camera
//! is. Orientation follows from matches (see [`crate::attitude`]); position does not
//! follow from either without an independent local vertical.

use crate::camera::Intrinsics;
use crate::centroid::Centroid;
use crate::error::CameraError;
use crate::frames::{Vec3, angle_between, earth_fixed_from_gha_dec};
use serde::{Deserialize, Serialize};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::stars::StarProvider;

/// One catalogue star, reduced to a direction at a specific instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogueStar {
    pub name: String,
    /// Unit vector in frame C (Earth-fixed of date; see [`crate::frames`]).
    pub dir_earth_fixed: Vec3,
    pub magnitude: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PairAngle {
    angle: f64,
    a: u16,
    b: u16,
}

/// The catalogue reduced to directions and pair angles at one instant.
///
/// Built once per frame and reused by [`identify`]. The pair angles change with the
/// date (precession and proper motion move stars relative to each other by arcseconds
/// per decade), so they are computed at the observation time rather than tabulated.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogueSnapshot {
    pub utc: String,
    pub jd_utc: f64,
    stars: Vec<CatalogueStar>,
    /// Sorted by angle, ascending.
    pairs: Vec<PairAngle>,
}

impl CatalogueSnapshot {
    /// Reduce the whole catalogue at `utc`.
    pub fn at(provider: &StarProvider, utc: &str) -> Result<Self, CameraError> {
        let jd_utc = skyfix_core::time::parse_utc(utc).map_err(|e| CameraError::Time {
            utc: utc.to_string(),
            reason: e.to_string(),
        })?;
        let mut stars = Vec::new();
        for e in catalog::navigational_stars() {
            let d = provider
                .geocentric(&e.name, jd_utc)
                .map_err(|err| CameraError::Ephemeris(err.to_string()))?;
            stars.push(CatalogueStar {
                name: e.name.clone(),
                dir_earth_fixed: earth_fixed_from_gha_dec(
                    d.gha_deg.to_radians(),
                    d.dec_deg.to_radians(),
                ),
                magnitude: e.magnitude,
            });
        }
        if stars.len() > u16::MAX as usize {
            return Err(CameraError::invalid(
                "catalogue",
                "more stars than the pair index can address",
            ));
        }
        let mut pairs = Vec::with_capacity(stars.len() * stars.len().saturating_sub(1) / 2);
        for a in 0..stars.len() {
            for b in (a + 1)..stars.len() {
                pairs.push(PairAngle {
                    angle: angle_between(stars[a].dir_earth_fixed, stars[b].dir_earth_fixed),
                    a: a as u16,
                    b: b as u16,
                });
            }
        }
        pairs.sort_by(|p, q| p.angle.total_cmp(&q.angle));
        Ok(CatalogueSnapshot {
            utc: utc.to_string(),
            jd_utc,
            stars,
            pairs,
        })
    }

    pub fn stars(&self) -> &[CatalogueStar] {
        &self.stars
    }

    pub fn n_pairs(&self) -> usize {
        self.pairs.len()
    }

    /// Direction of a named star in frame C, if the catalogue has it.
    pub fn direction(&self, name: &str) -> Option<Vec3> {
        self.stars
            .iter()
            .find(|s| s.name == name)
            .map(|s| s.dir_earth_fixed)
    }

    /// Human-readable statement of the closed world, carried on every result so a
    /// reader of the JSON cannot miss it.
    pub fn note(&self) -> String {
        format!(
            "closed world: {} catalogue stars, {} pair angles, reduced at {}. Real \
             imagery contains stars outside this catalogue; see docs/CAMERA.md.",
            self.stars.len(),
            self.pairs.len(),
            self.utc
        )
    }

    /// Angle between two catalogue stars by index.
    fn angle(&self, a: usize, b: usize) -> f64 {
        angle_between(self.stars[a].dir_earth_fixed, self.stars[b].dir_earth_fixed)
    }

    /// Catalogue pairs whose angle lies within `tol` of `theta`.
    fn pairs_near(&self, theta: f64, tol: f64) -> &[PairAngle] {
        let lo = self.pairs.partition_point(|p| p.angle < theta - tol);
        let hi = self.pairs.partition_point(|p| p.angle <= theta + tol);
        &self.pairs[lo..hi]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct IdentifyOptions {
    /// Half-width of the pair-angle match window, radians.
    pub tolerance_rad: f64,
    /// A centroid needs at least this many votes to be assigned at all. Two votes is
    /// the minimum that can ever be verified: with three stars in the field each true
    /// star pairs with exactly two others.
    pub min_votes: usize,
    /// Fewer verified stars than this is a failure. Three is the floor: two stars
    /// share one angle, which any rotation about their common axis satisfies, so a
    /// two-star "identification" is not one.
    pub min_stars: usize,
    /// Only the brightest this many centroids are considered.
    pub max_centroids: usize,
}

impl Default for IdentifyOptions {
    fn default() -> Self {
        IdentifyOptions {
            tolerance_rad: (30.0 / 3600.0f64).to_radians(),
            min_votes: 2,
            min_stars: 3,
            max_centroids: 50,
        }
    }
}

impl IdentifyOptions {
    /// Tolerance derived from the centroid accuracy.
    ///
    /// A pair angle is the difference of two centroid directions, so its error is
    /// `sqrt(2) * sigma_px * ifov`. The window is `k` of those (default 5), with a
    /// 5-arcsecond floor so a perfect synthetic centroid still gets a window wider than
    /// the arithmetic noise, and the catalogue's own 0.02' accuracy added in quadrature.
    pub fn from_centroid_sigma(sigma_px: f64, intrinsics: &Intrinsics, k: f64) -> Self {
        let ifov = intrinsics.nominal_ifov_rad();
        let centroid_term = k * std::f64::consts::SQRT_2 * sigma_px.max(0.0) * ifov;
        let catalogue_term = (0.02f64 / 60.0).to_radians();
        let tol = (centroid_term.hypot(catalogue_term)).max((5.0 / 3600.0f64).to_radians());
        IdentifyOptions {
            tolerance_rad: tol,
            ..IdentifyOptions::default()
        }
    }
}

/// One `(centroid, star)` assignment that survived verification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Match {
    pub centroid_index: usize,
    pub star_name: String,
    /// RMS disagreement, in arcseconds, between the measured angles from this star to
    /// the other identified stars and the catalogue's angles. This is a *relative*
    /// residual: it needs no attitude and is available before one is solved.
    /// [`crate::attitude::Attitude`] reports the post-fit residual separately.
    pub residual_arcsec: f64,
    pub votes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum IdentifyStatus {
    Identified {
        n_stars: usize,
    },
    /// Fewer centroids than [`IdentifyOptions::min_stars`] were offered. There is
    /// nothing to identify and no attitude to be had; this is a *result*, not an error.
    TooFewCentroids {
        have: usize,
        need: usize,
    },
    /// Centroids were offered but no mutually consistent set of the required size came
    /// out of the voting.
    NoConsistentSet {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Identification {
    pub matches: Vec<Match>,
    /// Indices into the centroid slice that were not identified. Hot pixels, cosmic
    /// rays, stars outside the closed world, and anything the verification rejected.
    pub unmatched: Vec<usize>,
    pub status: IdentifyStatus,
    pub catalogue: String,
    pub tolerance_arcsec: f64,
    pub utc: String,
}

impl Identification {
    pub fn is_identified(&self) -> bool {
        matches!(self.status, IdentifyStatus::Identified { .. })
    }
}

/// Identify centroids against the closed-world catalogue.
///
/// Returns orientation-bearing information only: which blob is which star. No position
/// and no altitude can be derived from this result alone.
pub fn identify(
    centroids: &[Centroid],
    intrinsics: &Intrinsics,
    catalogue: &CatalogueSnapshot,
    options: &IdentifyOptions,
) -> Identification {
    let tol = options.tolerance_rad;
    let base = Identification {
        matches: Vec::new(),
        unmatched: (0..centroids.len()).collect(),
        status: IdentifyStatus::TooFewCentroids {
            have: centroids.len(),
            need: options.min_stars,
        },
        catalogue: catalogue.note(),
        tolerance_arcsec: tol.to_degrees() * 3600.0,
        utc: catalogue.utc.clone(),
    };
    let need = options.min_stars.max(3);
    if centroids.len() < need {
        return Identification {
            status: IdentifyStatus::TooFewCentroids {
                have: centroids.len(),
                need,
            },
            ..base
        };
    }

    // Only the brightest are considered; `detect` already sorts by flux.
    let used: Vec<usize> = (0..centroids.len().min(options.max_centroids)).collect();
    let dirs: Vec<Vec3> = used
        .iter()
        .map(|&i| intrinsics.unproject(centroids[i].u, centroids[i].v))
        .collect();

    // --- vote ----------------------------------------------------------------
    let n_stars = catalogue.stars.len();
    let mut votes = vec![0usize; used.len() * n_stars];
    let mut measured = vec![0.0f64; used.len() * used.len()];
    for i in 0..used.len() {
        for j in (i + 1)..used.len() {
            let theta = angle_between(dirs[i], dirs[j]);
            measured[i * used.len() + j] = theta;
            measured[j * used.len() + i] = theta;
            for p in catalogue.pairs_near(theta, tol) {
                let (a, b) = (p.a as usize, p.b as usize);
                votes[i * n_stars + a] += 1;
                votes[j * n_stars + b] += 1;
                votes[i * n_stars + b] += 1;
                votes[j * n_stars + a] += 1;
            }
        }
    }

    // --- assign greedily -----------------------------------------------------
    let mut candidates: Vec<(usize, usize, usize)> = Vec::new(); // (votes, centroid, star)
    for i in 0..used.len() {
        for s in 0..n_stars {
            let v = votes[i * n_stars + s];
            if v >= options.min_votes.max(1) {
                candidates.push((v, i, s));
            }
        }
    }
    // Descending votes; ties broken by index so the result is reproducible.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut star_of = vec![usize::MAX; used.len()];
    let mut taken = vec![false; n_stars];
    let mut vote_of = vec![0usize; used.len()];
    for (v, i, s) in candidates {
        if star_of[i] == usize::MAX && !taken[s] {
            star_of[i] = s;
            taken[s] = true;
            vote_of[i] = v;
        }
    }

    // --- verify: keep only a mutually consistent set -------------------------
    let mut keep: Vec<usize> = (0..used.len()).filter(|&i| star_of[i] != usize::MAX).collect();
    let consistent = |i: usize, j: usize, star_of: &[usize]| -> bool {
        let want = catalogue.angle(star_of[i], star_of[j]);
        (measured[i * used.len() + j] - want).abs() <= tol
    };
    loop {
        if keep.len() < 2 {
            break;
        }
        let mut worst: Option<(usize, usize)> = None; // (bad edge count, position in keep)
        for (pos, &i) in keep.iter().enumerate() {
            let bad = keep
                .iter()
                .filter(|&&j| j != i && !consistent(i, j, &star_of))
                .count();
            if bad > 0 && worst.map(|(b, _)| bad > b).unwrap_or(true) {
                worst = Some((bad, pos));
            }
        }
        match worst {
            None => break,
            Some((_, pos)) => {
                let dropped = keep.remove(pos);
                taken[star_of[dropped]] = false;
                star_of[dropped] = usize::MAX;
            }
        }
    }

    if keep.len() < need {
        let reason = format!(
            "{} centroid(s) voted, {} survived mutual-angle verification, {} required. \
             Either the field holds fewer than {} catalogue stars or the tolerance \
             ({:.1}\") is too tight for the centroid accuracy.",
            used.len(),
            keep.len(),
            need,
            need,
            tol.to_degrees() * 3600.0
        );
        return Identification {
            status: IdentifyStatus::NoConsistentSet { reason },
            ..base
        };
    }

    // --- residuals -----------------------------------------------------------
    let mut out = Vec::with_capacity(keep.len());
    for &i in &keep {
        let mut sumsq = 0.0;
        let mut n = 0.0;
        for &j in &keep {
            if j == i {
                continue;
            }
            let d = measured[i * used.len() + j] - catalogue.angle(star_of[i], star_of[j]);
            sumsq += d * d;
            n += 1.0;
        }
        let rms = if n > 0.0 { (sumsq / n).sqrt() } else { 0.0 };
        out.push(Match {
            centroid_index: used[i],
            star_name: catalogue.stars[star_of[i]].name.clone(),
            residual_arcsec: rms.to_degrees() * 3600.0,
            votes: vote_of[i],
        });
    }
    out.sort_by(|a, b| a.centroid_index.cmp(&b.centroid_index));
    let matched: Vec<usize> = out.iter().map(|m| m.centroid_index).collect();
    let unmatched: Vec<usize> = (0..centroids.len())
        .filter(|i| !matched.contains(i))
        .collect();
    Identification {
        status: IdentifyStatus::Identified {
            n_stars: out.len(),
        },
        matches: out,
        unmatched,
        ..base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::Intrinsics;
    use crate::centroid::{CentroidOptions, detect};
    use crate::frames::camera_from_enu;
    use crate::render::{RenderOptions, RenderTruth, render};
    use skyfix_core::geometry::Point;

    /// The Orion field: six catalogue stars inside a 40-degree frame.
    const ORION_UTC: &str = "2026-10-01T05:30:00Z";
    const ORION_ALT_DEG: f64 = 25.0;
    const ORION_AZ_DEG: f64 = 100.0;
    /// The briefed pointing, which holds exactly one catalogue star.
    const BRIEF_UTC: &str = "2026-10-01T01:30:00Z";

    fn philadelphia() -> Point {
        Point::from_deg(39.9526, -75.1652)
    }

    fn frame(
        utc: &str,
        alt_deg: f64,
        az_deg: f64,
        fov_deg: f64,
        opts: RenderOptions,
    ) -> (Vec<crate::centroid::Centroid>, Intrinsics, RenderTruth) {
        let k = Intrinsics::from_horizontal_fov(1024, 768, fov_deg.to_radians());
        let att = camera_from_enu(alt_deg.to_radians(), az_deg.to_radians(), 8f64.to_radians());
        let (image, truth) =
            render(utc, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        let centroids = detect(
            &image,
            &CentroidOptions {
                min_flux: 200.0,
                ..CentroidOptions::default()
            },
        );
        (centroids, k, truth)
    }

    fn names(id: &Identification) -> Vec<String> {
        let mut v: Vec<String> = id.matches.iter().map(|m| m.star_name.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn catalogue_snapshot_has_the_closed_world_it_claims() {
        let cat = CatalogueSnapshot::at(&StarProvider::new(), ORION_UTC).unwrap();
        assert_eq!(cat.stars().len(), 58);
        assert_eq!(cat.n_pairs(), 58 * 57 / 2);
        assert_eq!(cat.n_pairs(), 1653);
        assert!(cat.note().contains("closed world"));
        assert!(cat.note().contains("1653"));
        // Pair angles are sorted and lie in [0, pi].
        let mut last = -1.0;
        for p in &cat.pairs {
            assert!(p.angle >= last && p.angle <= std::f64::consts::PI);
            last = p.angle;
        }
        // Spot check against the core: Vega to Altair is about 34 degrees.
        let v = cat.direction("Vega").unwrap();
        let a = cat.direction("Altair").unwrap();
        let sep = angle_between(v, a).to_degrees();
        assert!((sep - 34.2).abs() < 0.3, "Vega-Altair separation {sep} deg");
        assert_eq!(cat.direction("Betelgeuse").is_some(), true);
        assert_eq!(cat.direction("Not A Star"), None);
        assert!(CatalogueSnapshot::at(&StarProvider::new(), "not a time").is_err());
    }

    #[test]
    fn six_stars_in_a_forty_degree_field_are_identified() {
        let (centroids, k, truth) = frame(
            ORION_UTC,
            ORION_ALT_DEG,
            ORION_AZ_DEG,
            40.0,
            RenderOptions::default(),
        );
        assert!(
            (5..=8).contains(&truth.stars.len()),
            "wanted 5-8 stars, drew {}",
            truth.stars.len()
        );
        let cat = CatalogueSnapshot::at(&StarProvider::new(), ORION_UTC).unwrap();
        let opts = IdentifyOptions::from_centroid_sigma(0.2, &k, 5.0);
        let id = identify(&centroids, &k, &cat, &opts);
        assert!(id.is_identified(), "{:?}", id.status);
        assert_eq!(id.matches.len(), truth.stars.len());
        let mut want: Vec<String> = truth.stars.iter().map(|s| s.name.clone()).collect();
        want.sort();
        assert_eq!(names(&id), want);
        // Every match is the star the renderer actually put at that pixel.
        for m in &id.matches {
            let c = centroids[m.centroid_index];
            let s = truth
                .stars
                .iter()
                .find(|s| s.name == m.star_name)
                .expect("identified a star that is not in the frame");
            assert!(
                (c.u - s.u).hypot(c.v - s.v) < 0.5,
                "{} matched a blob {:.2} px away",
                m.star_name,
                (c.u - s.u).hypot(c.v - s.v)
            );
            assert!(m.votes >= 2);
            assert!(
                m.residual_arcsec < opts.tolerance_rad.to_degrees() * 3600.0,
                "{} residual {:.1}\"",
                m.star_name,
                m.residual_arcsec
            );
        }
        assert!(id.unmatched.is_empty());
    }

    #[test]
    fn two_hot_pixels_are_left_unmatched() {
        let (centroids, k, truth) = frame(
            ORION_UTC,
            ORION_ALT_DEG,
            ORION_AZ_DEG,
            40.0,
            RenderOptions {
                hot_pixels: 2,
                seed: 4,
                ..RenderOptions::default()
            },
        );
        assert_eq!(truth.hot_pixels.len(), 2);
        assert_eq!(
            centroids.len(),
            truth.stars.len() + 2,
            "the detector should see the defects too"
        );
        let cat = CatalogueSnapshot::at(&StarProvider::new(), ORION_UTC).unwrap();
        let id = identify(
            &centroids,
            &k,
            &cat,
            &IdentifyOptions::from_centroid_sigma(0.2, &k, 5.0),
        );
        assert!(id.is_identified(), "{:?}", id.status);
        assert_eq!(id.matches.len(), truth.stars.len());
        assert_eq!(id.unmatched.len(), 2);
        // The unmatched centroids really are the defects.
        for &i in &id.unmatched {
            let c = centroids[i];
            let hit = truth
                .hot_pixels
                .iter()
                .any(|&(x, y)| (c.u - x as f64).abs() < 0.6 && (c.v - y as f64).abs() < 0.6);
            assert!(hit, "unmatched centroid at ({}, {}) is not a defect", c.u, c.v);
        }
    }

    #[test]
    fn one_missing_star_does_not_break_the_rest() {
        let (mut centroids, k, truth) = frame(
            ORION_UTC,
            ORION_ALT_DEG,
            ORION_AZ_DEG,
            40.0,
            RenderOptions::default(),
        );
        let full = truth.stars.len();
        // Remove the brightest: a cloud, a bad column, a cosmic ray, a dropped frame.
        centroids.remove(0);
        let cat = CatalogueSnapshot::at(&StarProvider::new(), ORION_UTC).unwrap();
        let id = identify(
            &centroids,
            &k,
            &cat,
            &IdentifyOptions::from_centroid_sigma(0.2, &k, 5.0),
        );
        assert!(id.is_identified(), "{:?}", id.status);
        assert_eq!(id.matches.len(), full - 1);
        assert!(id.unmatched.is_empty());
        // The surviving identifications are still correct.
        for m in &id.matches {
            let c = centroids[m.centroid_index];
            let s = truth.stars.iter().find(|s| s.name == m.star_name).unwrap();
            assert!((c.u - s.u).hypot(c.v - s.v) < 0.5);
        }
    }

    #[test]
    fn fewer_than_three_centroids_is_an_explicit_result_not_a_guess() {
        // DOCUMENTED FAILURE MODE. Two directions share exactly one angle, and every
        // rotation about the axis bisecting them preserves it, so two stars cannot
        // fix an orientation and cannot be verified. The module says so rather than
        // returning a plausible-looking pair.
        let (centroids, k, _) = frame(
            ORION_UTC,
            ORION_ALT_DEG,
            ORION_AZ_DEG,
            40.0,
            RenderOptions::default(),
        );
        let cat = CatalogueSnapshot::at(&StarProvider::new(), ORION_UTC).unwrap();
        let opts = IdentifyOptions::from_centroid_sigma(0.2, &k, 5.0);
        for n in 0..3 {
            let id = identify(&centroids[..n], &k, &cat, &opts);
            assert!(!id.is_identified());
            assert_eq!(
                id.status,
                IdentifyStatus::TooFewCentroids { have: n, need: 3 },
                "n = {n}"
            );
            assert!(id.matches.is_empty());
            assert_eq!(id.unmatched.len(), n);
            assert!(id.catalogue.contains("closed world"));
        }
        // Three is the smallest set that can succeed.
        let id = identify(&centroids[..3], &k, &cat, &opts);
        assert!(id.is_identified(), "{:?}", id.status);
    }

    #[test]
    fn the_briefed_forty_degree_field_holds_one_catalogue_star() {
        // DOCUMENTED FINDING, and the reason the end-to-end test widens the lens.
        // At Philadelphia on 2026-10-01T01:30:00Z a 40-degree frame at altitude 45,
        // azimuth 250 contains exactly one of the 58 navigational stars (Rasalhague).
        // A real camera to magnitude 6 would see well over a hundred stars there; the
        // closed world is what is thin, not the sky.
        let (centroids, k, truth) = frame(BRIEF_UTC, 45.0, 250.0, 40.0, RenderOptions::default());
        assert_eq!(truth.stars.len(), 1, "{:?}", truth.stars);
        assert_eq!(truth.stars[0].name, "Rasalhague");
        let cat = CatalogueSnapshot::at(&StarProvider::new(), BRIEF_UTC).unwrap();
        let id = identify(
            &centroids,
            &k,
            &cat,
            &IdentifyOptions::from_centroid_sigma(0.2, &k, 5.0),
        );
        assert_eq!(
            id.status,
            IdentifyStatus::TooFewCentroids { have: 1, need: 3 }
        );
        assert!(id.matches.is_empty());
    }

    #[test]
    fn a_tolerance_far_too_tight_fails_loudly() {
        let (centroids, k, _) = frame(
            ORION_UTC,
            ORION_ALT_DEG,
            ORION_AZ_DEG,
            40.0,
            RenderOptions::default(),
        );
        let cat = CatalogueSnapshot::at(&StarProvider::new(), ORION_UTC).unwrap();
        let id = identify(
            &centroids,
            &k,
            &cat,
            &IdentifyOptions {
                tolerance_rad: 1e-12,
                ..IdentifyOptions::default()
            },
        );
        assert!(!id.is_identified());
        match id.status {
            IdentifyStatus::NoConsistentSet { ref reason } => {
                assert!(reason.contains("verification"), "{reason}");
            }
            other => panic!("expected NoConsistentSet, got {other:?}"),
        }
        assert!(id.matches.is_empty());
        assert_eq!(id.unmatched.len(), centroids.len());
    }

    #[test]
    fn tolerance_from_centroid_sigma_scales_with_the_lens() {
        let narrow = Intrinsics::from_horizontal_fov(1024, 768, 10f64.to_radians());
        let wide = Intrinsics::from_horizontal_fov(1024, 768, 80f64.to_radians());
        let a = IdentifyOptions::from_centroid_sigma(0.2, &narrow, 5.0);
        let b = IdentifyOptions::from_centroid_sigma(0.2, &wide, 5.0);
        assert!(
            b.tolerance_rad > a.tolerance_rad,
            "a wider lens has coarser pixels and needs a wider window"
        );
        // A perfect centroid still gets a floor, never zero.
        let z = IdentifyOptions::from_centroid_sigma(0.0, &wide, 5.0);
        assert!(z.tolerance_rad >= (5.0 / 3600.0f64).to_radians());
        assert_eq!(z.min_stars, 3);
    }
}
