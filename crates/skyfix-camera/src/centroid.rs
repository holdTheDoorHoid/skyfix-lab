//! Background, threshold, connected components, sub-pixel centroids.
//!
//! # Why the centroid is not computed over the thresholded pixels
//!
//! The obvious implementation — sum `x * I(x)` over the pixels that passed the
//! threshold — is biased. Thresholding is a non-linear operation on a noisy image, and
//! it clips the PSF asymmetrically whenever the star's centre is not at a pixel centre,
//! which is exactly the sub-pixel information being measured. So the threshold is used
//! **only to find the blob**; the centroid is then taken over a fixed square window
//! centred on the blob's peak pixel, with the background subtracted and negatives
//! clamped to zero. For a Gaussian PSF of sigma 1.5 px in a window of radius 6 px the
//! residual truncation bias is under 1e-3 px, two orders below the 0.05 px this module
//! is tested to.
//!
//! # Saturation
//!
//! A saturated core has had its peak flattened, so its centroid is pulled toward the
//! centre of the flat top and its flux is meaningless. This module does not try to
//! repair that; it sets [`Centroid::saturated`] and leaves the decision to the caller.
//! [`crate::sights`] refuses to build an observation from a saturated centroid.

use crate::render::Image;
use serde::{Deserialize, Serialize};

/// How the sky level and its scatter are estimated.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundMethod {
    /// Median of every sample; scatter from `1.4826 * MAD`. Immune to the stars, which
    /// occupy well under half the frame, and to a bimodal frame (sky over sea) in the
    /// sense that it lands on whichever part is larger. The default.
    #[default]
    Median,
    /// Iterated sigma-clipped mean. Slightly tighter than the median on a clean frame
    /// and much worse on a bimodal one.
    SigmaClippedMean { clip_sigma: f64, iterations: usize },
}

/// Sky level and its 1-sigma scatter, in counts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Background {
    pub level: f64,
    pub sigma: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Connectivity {
    Four,
    #[default]
    Eight,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CentroidOptions {
    pub background: BackgroundMethod,
    /// Detection threshold, in units of the background sigma above the background.
    ///
    /// The default is 6, not the customary 5. With `min_pixels = 1` (see below) there
    /// is no shape test to throw out a single hot sample, so the threshold has to carry
    /// the whole false-alarm budget: over a 1-megapixel Gaussian frame, 5 sigma leaves
    /// about 0.2 false pixels per frame and 6 sigma about 0.001. A pipeline with a PSF
    /// shape test can and should go back to 5.
    pub threshold_sigma: f64,
    pub connectivity: Connectivity,
    /// Half-width of the square centroid window, pixels. Use about 4 x the PSF sigma.
    pub window_radius_px: usize,
    /// Blobs with fewer pixels above the threshold are discarded. The default `1`
    /// keeps single-pixel defects, which is deliberate: a hot pixel *should* reach the
    /// identifier as an unmatched centroid so the identifier has to reject it, rather
    /// than being filtered out before the part of the pipeline under test. A real
    /// system would instead fit the PSF shape and discard anything too sharp to be a
    /// star; see `docs/CAMERA.md`.
    pub min_pixels: usize,
    /// Blobs with less background-subtracted flux than this are discarded.
    pub min_flux: f64,
    /// Counts at which the sensor saturates; a blob touching it is flagged.
    pub saturation_level: f64,
    /// Keep at most this many blobs, brightest first.
    pub max_blobs: usize,
}

impl Default for CentroidOptions {
    fn default() -> Self {
        CentroidOptions {
            background: BackgroundMethod::Median,
            threshold_sigma: 6.0,
            connectivity: Connectivity::Eight,
            window_radius_px: 6,
            min_pixels: 1,
            min_flux: 0.0,
            saturation_level: 65_535.0,
            max_blobs: 200,
        }
    }
}

/// One detection, in the pixel convention of [`crate::camera`]: pixel `(i, j)` has its
/// centre at `(u, v) = (i, j)`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Centroid {
    pub u: f64,
    pub v: f64,
    /// Background-subtracted counts summed over the centroid window, negatives
    /// included so that an empty window sums to zero rather than to a positive bias.
    pub flux: f64,
    /// Brightest single background-subtracted sample in the blob.
    pub peak: f64,
    /// Pixels above the detection threshold.
    pub n_pixels: usize,
    /// A pixel of this blob reached the saturation level. Its centroid is not
    /// trustworthy and its flux is a lower bound.
    pub saturated: bool,
}

/// Sky level and scatter.
pub fn estimate_background(image: &Image, method: BackgroundMethod) -> Background {
    if image.data.is_empty() {
        return Background {
            level: 0.0,
            sigma: 0.0,
        };
    }
    match method {
        BackgroundMethod::Median => {
            let mut buf = image.data.clone();
            let level = select_median(&mut buf);
            for v in buf.iter_mut() {
                *v = (*v - level).abs();
            }
            let mad = select_median(&mut buf);
            Background {
                level,
                sigma: 1.4826 * mad,
            }
        }
        BackgroundMethod::SigmaClippedMean {
            clip_sigma,
            iterations,
        } => {
            let (mut level, mut sigma) = mean_and_sigma(&image.data);
            for _ in 0..iterations.max(1) {
                if sigma <= 0.0 || !sigma.is_finite() {
                    break;
                }
                let lo = level - clip_sigma * sigma;
                let hi = level + clip_sigma * sigma;
                let kept: Vec<f64> = image
                    .data
                    .iter()
                    .copied()
                    .filter(|v| *v >= lo && *v <= hi)
                    .collect();
                if kept.len() < 8 {
                    break;
                }
                let (l, s) = mean_and_sigma(&kept);
                level = l;
                sigma = s;
            }
            Background { level, sigma }
        }
    }
}

/// Detect blobs and centroid them. Estimates the background itself.
pub fn detect(image: &Image, options: &CentroidOptions) -> Vec<Centroid> {
    let bg = estimate_background(image, options.background);
    detect_with_background(image, bg, options)
}

/// Detect blobs against a background the caller already has.
pub fn detect_with_background(
    image: &Image,
    background: Background,
    options: &CentroidOptions,
) -> Vec<Centroid> {
    let (w, h) = (image.width, image.height);
    if w == 0 || h == 0 {
        return Vec::new();
    }
    // A zero-scatter frame (a noiseless render) must still detect: fall back to a
    // small absolute threshold rather than accepting every pixel at the background.
    let sigma = if background.sigma > 0.0 {
        background.sigma
    } else {
        1e-9
    };
    let threshold = background.level + options.threshold_sigma * sigma;
    let saturated_at = options.saturation_level * (1.0 - 1e-12);

    let mut visited = vec![false; w * h];
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut blob: Vec<(usize, usize)> = Vec::new();
    let mut out: Vec<Centroid> = Vec::new();

    for start_y in 0..h {
        for start_x in 0..w {
            if visited[start_y * w + start_x] || image.at(start_x, start_y) <= threshold {
                continue;
            }
            // Flood fill with an explicit stack: recursion would blow the WASM stack
            // on a saturated frame where one blob is the whole image.
            blob.clear();
            stack.clear();
            stack.push((start_x, start_y));
            visited[start_y * w + start_x] = true;
            while let Some((x, y)) = stack.pop() {
                blob.push((x, y));
                for (nx, ny) in neighbours(x, y, w, h, options.connectivity) {
                    let idx = ny * w + nx;
                    if !visited[idx] && image.at(nx, ny) > threshold {
                        visited[idx] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            if blob.len() < options.min_pixels.max(1) {
                continue;
            }
            if let Some(c) = centroid_of(image, &blob, background.level, saturated_at, options)
                && c.flux >= options.min_flux
            {
                out.push(c);
            }
        }
    }
    out.sort_by(|a, b| b.flux.total_cmp(&a.flux));
    out.truncate(options.max_blobs);
    out
}

fn centroid_of(
    image: &Image,
    blob: &[(usize, usize)],
    background: f64,
    saturated_at: f64,
    options: &CentroidOptions,
) -> Option<Centroid> {
    let (mut px, mut py) = blob[0];
    let mut peak = image.at(px, py);
    let mut saturated = false;
    for &(x, y) in blob {
        let v = image.at(x, y);
        if v >= saturated_at {
            saturated = true;
        }
        if v > peak {
            peak = v;
            px = x;
            py = y;
        }
    }
    let r = options.window_radius_px as i64;
    let x0 = (px as i64 - r).max(0) as usize;
    let x1 = ((px as i64 + r) as usize).min(image.width - 1);
    let y0 = (py as i64 - r).max(0) as usize;
    let y1 = ((py as i64 + r) as usize).min(image.height - 1);
    // Two different sums, on purpose.
    //
    // `flux` is the plain background-subtracted sum, negatives included. Clamping it
    // at zero would bias every window upward by `area * sigma / sqrt(2 pi)` — for a
    // 13 x 13 window on an 11-count sky that is 750 counts of pure noise, enough to
    // push an empty patch of sky past any flux cut. Unclamped, an empty window sums to
    // zero within `sigma * sqrt(area)`, so `min_flux` means what it says.
    //
    // The centroid weights *are* clamped, because a negative weight can drag a
    // position outside the window entirely. The clamp biases the weights symmetrically
    // about a well-centred star, so it does not move the centroid.
    let mut flux = 0.0;
    let mut weight = 0.0;
    let mut su = 0.0;
    let mut sv = 0.0;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let value = image.at(x, y) - background;
            flux += value;
            let w = value.max(0.0);
            weight += w;
            su += w * x as f64;
            sv += w * y as f64;
        }
    }
    if weight <= 0.0 || !weight.is_finite() {
        return None;
    }
    Some(Centroid {
        u: su / weight,
        v: sv / weight,
        flux,
        peak: peak - background,
        n_pixels: blob.len(),
        saturated,
    })
}

fn neighbours(
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    c: Connectivity,
) -> impl Iterator<Item = (usize, usize)> {
    const FOUR: [(i64, i64); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];
    const EIGHT: [(i64, i64); 8] = [
        (-1, -1),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    ];
    let offsets: &'static [(i64, i64)] = match c {
        Connectivity::Four => &FOUR,
        Connectivity::Eight => &EIGHT,
    };
    offsets.iter().filter_map(move |&(dx, dy)| {
        let nx = x as i64 + dx;
        let ny = y as i64 + dy;
        if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
            Some((nx as usize, ny as usize))
        } else {
            None
        }
    })
}

/// Lower median by selection, `O(n)`. Reorders `buf`.
fn select_median(buf: &mut [f64]) -> f64 {
    if buf.is_empty() {
        return 0.0;
    }
    let k = buf.len() / 2;
    let (_, m, _) = buf.select_nth_unstable_by(k, f64::total_cmp);
    *m
}

fn mean_and_sigma(values: &[f64]) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let var = values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n;
    (mean, var.max(0.0).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::Intrinsics;
    use crate::frames::camera_from_enu;
    use crate::render::{RenderOptions, render};
    use crate::rng::Rng;
    use approx::assert_relative_eq;
    use skyfix_core::geometry::Point;
    use skyfix_ephemeris::stars::StarProvider;

    const UTC: &str = "2026-10-01T05:30:00Z";
    fn philadelphia() -> Point {
        Point::from_deg(39.9526, -75.1652)
    }

    /// Draw one Gaussian by hand so the test knows the true centre exactly.
    fn one_star(width: usize, height: usize, u: f64, v: f64, flux: f64, sigma: f64) -> Image {
        let mut img = Image::new(width, height, 0.0);
        let s2 = 2.0 * sigma * sigma;
        let peak = flux / (std::f64::consts::TAU * sigma * sigma);
        for y in 0..height {
            for x in 0..width {
                let dx = x as f64 - u;
                let dy = y as f64 - v;
                img.add(x, y, peak * (-(dx * dx + dy * dy) / s2).exp());
            }
        }
        img
    }

    #[test]
    fn sub_pixel_accuracy_on_a_noiseless_gaussian() {
        let opts = CentroidOptions {
            min_flux: 10.0,
            ..CentroidOptions::default()
        };
        let mut worst: f64 = 0.0;
        // Sweep the sub-pixel phase: this is where a thresholded centroid goes wrong.
        for i in 0..11 {
            for j in 0..11 {
                let u = 20.0 + i as f64 * 0.1;
                let v = 20.0 + j as f64 * 0.1;
                let img = one_star(41, 41, u, v, 20_000.0, 1.5);
                let found = detect(&img, &opts);
                assert_eq!(found.len(), 1, "expected one blob at ({u}, {v})");
                let c = found[0];
                worst = worst.max((c.u - u).abs()).max((c.v - v).abs());
                assert!(!c.saturated);
                // The window is 4 sigma, so it misses about 2e-5 of a Gaussian.
                assert_relative_eq!(c.flux, 20_000.0, max_relative = 1e-4);
            }
        }
        assert!(worst < 0.05, "worst sub-pixel error {worst} px");
        // In fact it is far better than the requirement; pin that too so a regression
        // to a thresholded centroid (about 0.03 px of phase error) would be caught.
        assert!(worst < 2e-3, "worst sub-pixel error {worst} px");
    }

    #[test]
    fn centroids_stay_accurate_with_noise_and_improve_with_signal() {
        // Two flux levels, so the test measures the *scaling* rather than asserting a
        // number that depends on one seed. Centroid noise is dominated by the sky and
        // read noise inside the window, both of which enter as 1 / flux.
        let mut rms = Vec::new();
        for flux in [20_000.0, 200_000.0] {
            let mut rng = Rng::new(3);
            let mut sumsq = 0.0;
            let mut worst: f64 = 0.0;
            let n = 40;
            for i in 0..n {
                let u = 20.0 + (i as f64) * 0.025;
                let v = 20.37;
                let mut img = one_star(41, 41, u, v, flux, 1.5);
                for p in img.data.iter_mut() {
                    *p = rng.poisson(*p + 100.0) + rng.normal_with(0.0, 5.0);
                }
                let found = detect(
                    &img,
                    &CentroidOptions {
                        min_flux: 500.0,
                        ..CentroidOptions::default()
                    },
                );
                assert_eq!(found.len(), 1, "noise created or destroyed a blob");
                let c = found[0];
                let e = (c.u - u).hypot(c.v - v);
                sumsq += e * e;
                worst = worst.max(e);
                assert!(!c.saturated);
            }
            rms.push((sumsq / n as f64).sqrt());
            assert!(worst < 0.2, "flux {flux}: worst centroid error {worst} px");
        }
        assert!(
            rms[1] < 0.4 * rms[0],
            "ten times the signal should cut the centroid noise by roughly ten: {rms:?}"
        );
        assert!(rms[1] < 0.01, "bright-star centroid rms {} px", rms[1]);
    }

    #[test]
    fn background_estimators_agree_on_a_clean_frame() {
        let mut rng = Rng::new(11);
        let mut img = Image::new(200, 200, 0.0);
        for p in img.data.iter_mut() {
            *p = 500.0 + rng.normal_with(0.0, 12.0);
        }
        let med = estimate_background(&img, BackgroundMethod::Median);
        let clipped = estimate_background(
            &img,
            BackgroundMethod::SigmaClippedMean {
                clip_sigma: 3.0,
                iterations: 5,
            },
        );
        assert_relative_eq!(med.level, 500.0, epsilon = 0.5);
        assert_relative_eq!(clipped.level, 500.0, epsilon = 0.5);
        assert_relative_eq!(med.sigma, 12.0, max_relative = 0.05);
        assert_relative_eq!(clipped.sigma, 12.0, max_relative = 0.05);
        // The median is the one that survives bright contamination: fill a fifth of
        // the frame with a huge value and watch the clipped mean move much further.
        for p in img.data.iter_mut().take(200 * 40) {
            *p = 50_000.0;
        }
        let med2 = estimate_background(&img, BackgroundMethod::Median);
        let clipped2 = estimate_background(
            &img,
            BackgroundMethod::SigmaClippedMean {
                clip_sigma: 3.0,
                iterations: 5,
            },
        );
        // Contaminating 20 % of the frame moves the median to the 62.5th percentile,
        // which for a Gaussian is 0.319 sigma = 3.8 counts. It moves, but boundedly.
        assert_relative_eq!(med2.level, 500.0 + 0.319 * 12.0, epsilon = 1.0);
        assert!(
            (clipped2.level - 500.0).abs() > (med2.level - 500.0).abs(),
            "clipped {} vs median {}",
            clipped2.level,
            med2.level
        );
        assert_eq!(
            estimate_background(&Image::new(0, 0, 0.0), BackgroundMethod::Median),
            Background {
                level: 0.0,
                sigma: 0.0
            }
        );
        assert_eq!(BackgroundMethod::default(), BackgroundMethod::Median);
    }

    #[test]
    fn saturation_size_and_flux_rejection() {
        // Saturated core.
        let mut img = one_star(41, 41, 20.0, 20.0, 2_000_000.0, 1.5);
        for p in img.data.iter_mut() {
            *p = p.min(4095.0);
        }
        let opts = CentroidOptions {
            saturation_level: 4095.0,
            ..CentroidOptions::default()
        };
        let found = detect(&img, &opts);
        assert_eq!(found.len(), 1);
        assert!(found[0].saturated, "a clipped core must be flagged");

        // Single-pixel defect: kept by default (min_pixels 1), dropped at min_pixels 2.
        let mut hot = Image::new(41, 41, 100.0);
        hot.set(10, 30, 60_000.0);
        assert_eq!(detect(&hot, &CentroidOptions::default()).len(), 1);
        assert_eq!(
            detect(
                &hot,
                &CentroidOptions {
                    min_pixels: 2,
                    ..CentroidOptions::default()
                }
            )
            .len(),
            0
        );
        // ... and by a flux cut.
        assert_eq!(
            detect(
                &hot,
                &CentroidOptions {
                    min_flux: 1e6,
                    ..CentroidOptions::default()
                }
            )
            .len(),
            0
        );
        // Empty and flat frames produce nothing and do not panic.
        assert!(detect(&Image::new(0, 0, 0.0), &CentroidOptions::default()).is_empty());
        assert!(detect(&Image::new(8, 8, 42.0), &CentroidOptions::default()).is_empty());
    }

    #[test]
    fn four_and_eight_connectivity_split_a_diagonal_pair() {
        let mut img = Image::new(21, 21, 0.0);
        img.set(10, 10, 1000.0);
        img.set(11, 11, 1000.0);
        let four = detect(
            &img,
            &CentroidOptions {
                connectivity: Connectivity::Four,
                window_radius_px: 0,
                ..CentroidOptions::default()
            },
        );
        let eight = detect(
            &img,
            &CentroidOptions {
                connectivity: Connectivity::Eight,
                window_radius_px: 0,
                ..CentroidOptions::default()
            },
        );
        assert_eq!(four.len(), 2, "4-connectivity must separate a diagonal");
        assert_eq!(eight.len(), 1, "8-connectivity must join a diagonal");
        assert_eq!(eight[0].n_pixels, 2);
    }

    #[test]
    fn centroids_of_a_rendered_field_land_on_the_true_stars() {
        // The whole point: run the real renderer and check the detector against the
        // truth it was not given.
        let k = Intrinsics::from_horizontal_fov(1024, 768, 40f64.to_radians());
        let att = camera_from_enu(25f64.to_radians(), 100f64.to_radians(), 0.0);
        let opts = RenderOptions::default().noiseless();
        let (image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        assert!(truth.stars.len() >= 5, "want a crowded field for this test");
        let found = detect(
            &image,
            &CentroidOptions {
                min_flux: 100.0,
                ..CentroidOptions::default()
            },
        );
        assert_eq!(found.len(), truth.stars.len(), "blob count");
        let mut worst: f64 = 0.0;
        for s in &truth.stars {
            let best = found
                .iter()
                .min_by(|a, b| {
                    (a.u - s.u)
                        .hypot(a.v - s.v)
                        .total_cmp(&(b.u - s.u).hypot(b.v - s.v))
                })
                .unwrap();
            worst = worst.max((best.u - s.u).hypot(best.v - s.v));
        }
        assert!(
            worst < 0.05,
            "worst rendered-star centroid error {worst} px"
        );
        // Brightest first.
        for pair in found.windows(2) {
            assert!(pair[0].flux >= pair[1].flux);
        }
    }
}
