//! Synthetic star field: truth in, image out, truth kept separately.
//!
//! The renderer is the **simulator** half of module A and it uses the truth without
//! apology: the true observer position, the true camera attitude and the true time.
//! That is exactly what `skyfix-sim` does for sextant sessions, and for the same
//! reason — a simulator that had to estimate its own inputs would not be a simulator.
//! The honesty lives in the return type: [`render`] hands back an [`Image`] and a
//! [`RenderTruth`] as two separate values, and no estimator in this crate takes a
//! `RenderTruth` argument. The one function that reads the truth on purpose is
//! [`crate::vertical::simulated_inclinometer`], which takes it explicitly and says so
//! in its name.
//!
//! # What is modelled
//!
//! | effect | model |
//! |---|---|
//! | star direction | apparent geocentric of date from [`StarProvider`], through the true observer's ENU frame (CONVENTIONS section 7) |
//! | refraction | Bennett 1982 (CONVENTIONS section 5 step 3), applied **forward** so the image shows apparent directions, as a real camera does. Default ON. |
//! | point spread | circular Gaussian, `psf_sigma_px` |
//! | brightness | `flux = flux_scale * 10^(-0.4 m)` total counts |
//! | sky background | flat `background_level` counts |
//! | photon shot noise | Poisson on the total counts per pixel |
//! | read noise | Gaussian, `read_noise` counts |
//! | hot pixels | `hot_pixels` single-pixel defects at `hot_pixel_level` |
//! | saturation | hard clip at `saturation_level`, flagged by the centroider |
//! | sea horizon | optional step edge at altitude `-dip`, `dip = 1.76' sqrt(h_m)` |
//!
//! # What is not
//!
//! No vignetting, no flat field, no dark current gradient, no cosmic rays, no
//! atmospheric scintillation or seeing beyond the fixed Gaussian, no star colour, no
//! airmass extinction, no rolling shutter, no motion blur, no lens ghosts. A real
//! camera has all of them and `docs/CAMERA.md` keeps the list. None of them would
//! change the *structure* of the chain, which is what this module exists to prove.

use crate::camera::Intrinsics;
use crate::error::CameraError;
use crate::frames::{Rotation, Vec3, enu_from_earth_fixed, enu_from_alt_az, alt_az_from_enu};
use crate::rng::Rng;
use serde::{Deserialize, Serialize};
use skyfix_core::geometry::Point;
use skyfix_core::types::LatLon;
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::catalog;
use skyfix_ephemeris::stars::StarProvider;

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

/// A monochrome image in counts. Row-major, `data[y * width + x]`.
///
/// Deliberately not an `image` crate type: this crate must build for
/// `wasm32-unknown-unknown` with no new dependencies, and every consumer here wants
/// `f64` counts rather than clamped bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f64>,
}

impl Image {
    pub fn new(width: usize, height: usize, fill: f64) -> Self {
        Image {
            width,
            height,
            data: vec![fill; width * height],
        }
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f64 {
        self.data[y * self.width + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, value: f64) {
        self.data[y * self.width + x] = value;
    }

    #[inline]
    pub fn add(&mut self, x: usize, y: usize, value: f64) {
        self.data[y * self.width + x] += value;
    }

    /// Binary 16-bit PGM (`P5`) bytes, linearly mapping `[black, white]` to
    /// `[0, 65535]`. Returns bytes; writes no file — this crate has no file I/O.
    pub fn to_pgm(&self, black: f64, white: f64) -> Vec<u8> {
        let span = if white > black { white - black } else { 1.0 };
        let mut out = format!("P5\n{} {}\n65535\n", self.width, self.height).into_bytes();
        out.reserve(self.data.len() * 2);
        for &v in &self.data {
            let scaled = ((v - black) / span * 65535.0).round();
            let clamped = if scaled.is_finite() {
                scaled.clamp(0.0, 65535.0) as u16
            } else {
                0
            };
            out.extend_from_slice(&clamped.to_be_bytes());
        }
        out
    }

    /// Smallest and largest sample, for choosing PGM limits.
    pub fn range(&self) -> (f64, f64) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for &v in &self.data {
            if v < lo {
                lo = v;
            }
            if v > hi {
                hi = v;
            }
        }
        if self.data.is_empty() { (0.0, 0.0) } else { (lo, hi) }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// An optional sea horizon drawn at altitude `-dip`.
///
/// The edge is the exact box-filtered step: a pixel straddling the horizon takes the
/// area-weighted mix of sky and sea. That makes the sub-pixel edge position recoverable
/// by the derivative centroid that [`crate::vertical::vertical_from_horizon_line`] uses,
/// and a real (anti-aliased, diffraction-limited) horizon behaves the same way to first
/// order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SeaHorizon {
    /// Height of eye, metres. `dip = 1.76' sqrt(h)` (CONVENTIONS section 5 step 2).
    pub height_of_eye_m: f64,
    /// Counts below the horizon. The sky above keeps `background_level`.
    pub sea_level: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RenderOptions {
    /// Gaussian point-spread sigma, pixels. Below about 0.7 px the PSF is undersampled
    /// and sub-pixel centroiding degrades; 1.0 to 2.0 is the useful range.
    pub psf_sigma_px: f64,
    /// Total counts of a magnitude-0 star.
    pub flux_scale: f64,
    /// Stars fainter than this are not drawn. The catalogue only reaches about +2.1.
    pub magnitude_limit: f64,
    /// Flat sky background, counts.
    pub background_level: f64,
    /// Gaussian read noise, counts, 1 sigma. Zero for a noiseless render.
    pub read_noise: f64,
    /// Poisson photon noise on the total counts of each pixel.
    pub shot_noise: bool,
    /// Number of single-pixel defects.
    pub hot_pixels: usize,
    /// Counts a hot pixel reads out at.
    pub hot_pixel_level: f64,
    /// Hard clip, counts. A 16-bit sensor saturates at 65535.
    pub saturation_level: f64,
    /// Render apparent (refracted) directions rather than geometric ones. Default `true`:
    /// a real camera sees the refracted sky, and CONVENTIONS section 5 has the core
    /// remove refraction later. Turning this off makes the image physically wrong and
    /// is only useful for isolating geometry in a test.
    pub apply_refraction: bool,
    pub pressure_hpa: f64,
    pub temperature_c: f64,
    /// Draw a sea horizon.
    pub sea_horizon: Option<SeaHorizon>,
    /// Seed for noise and hot-pixel placement.
    pub seed: u64,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            psf_sigma_px: 1.5,
            flux_scale: 30_000.0,
            magnitude_limit: 6.0,
            background_level: 100.0,
            read_noise: 5.0,
            shot_noise: true,
            hot_pixels: 0,
            hot_pixel_level: 60_000.0,
            saturation_level: 65_535.0,
            apply_refraction: true,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
            sea_horizon: None,
            seed: 1,
        }
    }
}

impl RenderOptions {
    /// Noiseless: no read noise, no shot noise, no hot pixels. Everything else as
    /// given. Used by the centroid accuracy test, where any noise would mask the bias
    /// being measured.
    pub fn noiseless(self) -> Self {
        RenderOptions {
            read_noise: 0.0,
            shot_noise: false,
            hot_pixels: 0,
            ..self
        }
    }
}

// ---------------------------------------------------------------------------
// Truth
// ---------------------------------------------------------------------------

/// One star as the renderer placed it. Estimator code never sees this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrueStar {
    pub name: String,
    pub magnitude: f64,
    /// Pixel coordinates of the centre of the PSF.
    pub u: f64,
    pub v: f64,
    /// Geometric (unrefracted) altitude at the true observer, degrees. This is `Ho`.
    pub true_altitude_deg: f64,
    /// Altitude as drawn: refracted when `apply_refraction`, else equal to the above.
    /// This is `Ha`, the angle a perfect camera would measure from the local vertical.
    pub apparent_altitude_deg: f64,
    pub azimuth_deg: f64,
    /// Unit direction in the camera frame, as drawn.
    pub dir_camera: Vec3,
    /// Total counts placed on the sensor for this star.
    pub flux: f64,
}

/// Everything the renderer knew and the estimator must not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderTruth {
    pub utc: String,
    pub jd_utc: f64,
    /// The observer position the image was drawn from.
    pub observer: LatLon,
    pub attitude_camera_from_enu: Rotation,
    /// The same attitude referred to the Earth-fixed frame of date at `utc`; this is
    /// what [`crate::attitude::solve_attitude`] tries to recover.
    pub attitude_camera_from_earth_fixed: Rotation,
    /// The local vertical in camera coordinates. An estimator may only obtain this
    /// from an instrument, never from the stars.
    pub up_camera: Vec3,
    pub stars: Vec<TrueStar>,
    /// Dip in arcminutes and the pixel row of the horizon at the image centre column,
    /// when a sea horizon was drawn.
    pub horizon: Option<TrueHorizon>,
    /// `(x, y)` of each hot pixel.
    pub hot_pixels: Vec<(usize, usize)>,
    pub refraction_applied: bool,
    pub options: RenderOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TrueHorizon {
    pub height_of_eye_m: f64,
    pub dip_arcmin: f64,
    /// Altitude of the horizon, degrees: `-dip`.
    pub altitude_deg: f64,
    /// Row of the horizon in the centre column, pixels, or `None` if it is off-sensor.
    pub center_row: Option<f64>,
}

// ---------------------------------------------------------------------------
// Refraction (forward)
// ---------------------------------------------------------------------------

/// Bennett refraction in arcminutes for an **apparent** altitude in degrees.
///
/// Restated here rather than called from `skyfix_core::corrections` on purpose: the
/// renderer is the other half of a round trip with the reducer, and if both halves
/// shared one implementation a sign error would cancel and the end-to-end test would
/// pass while both were wrong. `skyfix-sim::optics` restates it for the same reason.
pub fn refraction_arcmin(apparent_altitude_deg: f64, pressure_hpa: f64, temperature_c: f64) -> f64 {
    let x_deg = apparent_altitude_deg + 7.31 / (apparent_altitude_deg + 4.4);
    let cot = 1.0 / x_deg.to_radians().tan();
    cot * (pressure_hpa / 1010.0) * (283.0 / (273.0 + temperature_c))
}

/// Invert it: the apparent altitude whose refraction takes it back to `ho_deg`.
///
/// `Ha = Ho + R(Ha)`, solved by fixed-point iteration. `|dR/dHa| < 0.22` everywhere
/// Bennett is valid, so the iteration contracts; it is worst at the horizon and
/// negligible above 10 degrees.
pub fn apparent_altitude_deg(ho_deg: f64, pressure_hpa: f64, temperature_c: f64) -> f64 {
    let mut ha = ho_deg + refraction_arcmin(ho_deg, pressure_hpa, temperature_c) / 60.0;
    for _ in 0..60 {
        let next = ho_deg + refraction_arcmin(ha, pressure_hpa, temperature_c) / 60.0;
        if (next - ha).abs() < 1e-12 {
            ha = next;
            break;
        }
        ha = next;
    }
    ha
}

/// Dip of the sea horizon, arcminutes (CONVENTIONS section 5 step 2).
pub fn dip_arcmin(height_of_eye_m: f64) -> f64 {
    1.76 * height_of_eye_m.max(0.0).sqrt()
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/// Draw the sky the camera would see, and hand back the truth separately.
///
/// `observer_truth` is where the camera really is and `camera_from_enu_truth` is where
/// it really points; neither is ever estimated from the image.
pub fn render(
    utc: &str,
    observer_truth: Point,
    camera_from_enu_truth: &Rotation,
    intrinsics: &Intrinsics,
    provider: &StarProvider,
    options: &RenderOptions,
) -> Result<(Image, RenderTruth), CameraError> {
    validate(intrinsics, options)?;
    let jd_utc = skyfix_core::time::parse_utc(utc).map_err(|e| CameraError::Time {
        utc: utc.to_string(),
        reason: e.to_string(),
    })?;

    let e_from_c = enu_from_earth_fixed(observer_truth);
    let k_from_e = *camera_from_enu_truth;
    let k_from_c = k_from_e.compose(&e_from_c);
    let up_camera = k_from_e.rotate([0.0, 0.0, 1.0]);

    // --- place the stars -----------------------------------------------------
    let margin_px = (4.0 * options.psf_sigma_px).ceil().max(1.0);
    let mut stars: Vec<TrueStar> = Vec::new();
    for entry in catalog::navigational_stars() {
        if entry.magnitude > options.magnitude_limit {
            continue;
        }
        let dir = provider
            .geocentric(&entry.name, jd_utc)
            .map_err(|e| CameraError::Ephemeris(e.to_string()))?;
        let (alt, az) = skyfix_core::geometry::altitude_azimuth(
            observer_truth,
            dir.gha_deg.to_radians(),
            dir.dec_deg.to_radians(),
        );
        let true_altitude_deg = alt.to_degrees();
        if true_altitude_deg < 0.0 {
            // Below the geometric horizon. Bennett is not valid there (CONVENTIONS
            // section 5 step 3 rejects Ha < 0), so the renderer refuses to invent it.
            continue;
        }
        let apparent_alt_deg = if options.apply_refraction {
            apparent_altitude_deg(
                true_altitude_deg,
                options.pressure_hpa,
                options.temperature_c,
            )
        } else {
            true_altitude_deg
        };
        let dir_enu = enu_from_alt_az(apparent_alt_deg.to_radians(), az);
        let dir_camera = k_from_e.rotate(dir_enu);
        let Some((u, v)) = intrinsics.project_unclipped(dir_camera) else {
            continue;
        };
        if u < -margin_px
            || v < -margin_px
            || u > intrinsics.width as f64 - 1.0 + margin_px
            || v > intrinsics.height as f64 - 1.0 + margin_px
        {
            continue;
        }
        stars.push(TrueStar {
            name: entry.name.clone(),
            magnitude: entry.magnitude,
            u,
            v,
            true_altitude_deg,
            apparent_altitude_deg: apparent_alt_deg,
            azimuth_deg: az.to_degrees(),
            dir_camera,
            flux: options.flux_scale * 10f64.powf(-0.4 * entry.magnitude),
        });
    }
    stars.sort_by(|a, b| a.name.cmp(&b.name));

    // --- background and the optional sea horizon -----------------------------
    let mut image = Image::new(
        intrinsics.width,
        intrinsics.height,
        options.background_level,
    );
    let horizon = match options.sea_horizon {
        None => None,
        Some(sea) => {
            let dip = dip_arcmin(sea.height_of_eye_m);
            let horizon_alt_rad = -(dip / 60.0).to_radians();
            let center_row = draw_sea_horizon(
                &mut image,
                intrinsics,
                &k_from_e,
                horizon_alt_rad,
                options.background_level,
                sea.sea_level,
            );
            Some(TrueHorizon {
                height_of_eye_m: sea.height_of_eye_m,
                dip_arcmin: dip,
                altitude_deg: -dip / 60.0,
                center_row,
            })
        }
    };

    // --- point spread --------------------------------------------------------
    let two_sigma2 = 2.0 * options.psf_sigma_px * options.psf_sigma_px;
    let peak_scale = 1.0 / (std::f64::consts::TAU * options.psf_sigma_px * options.psf_sigma_px);
    let radius = margin_px as i64;
    for star in &stars {
        let x0 = (star.u.round() as i64 - radius).max(0);
        let x1 = (star.u.round() as i64 + radius).min(intrinsics.width as i64 - 1);
        let y0 = (star.v.round() as i64 - radius).max(0);
        let y1 = (star.v.round() as i64 + radius).min(intrinsics.height as i64 - 1);
        for y in y0..=y1 {
            let dy = y as f64 - star.v;
            for x in x0..=x1 {
                let dx = x as f64 - star.u;
                let e = (-(dx * dx + dy * dy) / two_sigma2).exp();
                image.add(x as usize, y as usize, star.flux * peak_scale * e);
            }
        }
    }

    // --- noise, defects, saturation -----------------------------------------
    let mut rng = Rng::new(options.seed);
    if options.shot_noise {
        for v in image.data.iter_mut() {
            *v = rng.poisson(*v);
        }
    }
    if options.read_noise > 0.0 {
        for v in image.data.iter_mut() {
            *v += rng.normal_with(0.0, options.read_noise);
        }
    }
    let mut hot_pixels = Vec::with_capacity(options.hot_pixels);
    for _ in 0..options.hot_pixels {
        let x = rng.below(intrinsics.width as u64) as usize;
        let y = rng.below(intrinsics.height as u64) as usize;
        image.set(x, y, options.hot_pixel_level);
        hot_pixels.push((x, y));
    }
    for v in image.data.iter_mut() {
        *v = v.clamp(0.0, options.saturation_level);
    }

    let truth = RenderTruth {
        utc: utc.to_string(),
        jd_utc,
        observer: LatLon {
            lat_deg: observer_truth.lat_deg(),
            lon_deg: observer_truth.lon_deg(),
        },
        attitude_camera_from_enu: k_from_e,
        attitude_camera_from_earth_fixed: k_from_c,
        up_camera,
        stars,
        horizon,
        hot_pixels,
        refraction_applied: options.apply_refraction,
        options: *options,
    };
    Ok((image, truth))
}

/// The sky/sea step, column by column.
///
/// For each column the horizon row is found by bisecting the altitude along the column
/// (altitude is monotonic down a column for any camera that is not looking within a
/// pixel of the zenith or nadir), then the column is filled with the exact
/// box-filtered step: a pixel whose centre is `d` above the edge takes a sky fraction
/// of `clamp(d + 0.5, 0, 1)`. Returns the horizon row in the centre column.
fn draw_sea_horizon(
    image: &mut Image,
    intrinsics: &Intrinsics,
    camera_from_enu: &Rotation,
    horizon_alt_rad: f64,
    sky_level: f64,
    sea_level: f64,
) -> Option<f64> {
    let enu_from_camera = camera_from_enu.inverse();
    let alt_at = |u: f64, v: f64| -> f64 {
        let d = enu_from_camera.rotate(intrinsics.unproject(u, v));
        alt_az_from_enu(d).0
    };
    let top = -0.5;
    let bottom = intrinsics.height as f64 - 0.5;
    let mut center_row = None;
    for x in 0..intrinsics.width {
        let u = x as f64;
        let a_top = alt_at(u, top) - horizon_alt_rad;
        let a_bottom = alt_at(u, bottom) - horizon_alt_rad;
        let edge = if a_top <= 0.0 {
            Some(top) // horizon above the frame: the whole column is sea
        } else if a_bottom >= 0.0 {
            None // horizon below the frame: the whole column is sky
        } else {
            let (mut lo, mut hi) = (top, bottom);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if alt_at(u, mid) - horizon_alt_rad > 0.0 {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            Some(0.5 * (lo + hi))
        };
        if x == intrinsics.width / 2 {
            center_row = edge.filter(|e| *e > top);
        }
        let Some(edge) = edge else { continue };
        for y in 0..intrinsics.height {
            let sky_fraction = (edge - y as f64 + 0.5).clamp(0.0, 1.0);
            image.set(x, y, sea_level + (sky_level - sea_level) * sky_fraction);
        }
    }
    center_row
}

fn validate(intrinsics: &Intrinsics, options: &RenderOptions) -> Result<(), CameraError> {
    if intrinsics.width == 0 || intrinsics.height == 0 {
        return Err(CameraError::invalid("intrinsics", "zero-sized image"));
    }
    if !(intrinsics.fx.is_finite() && intrinsics.fy.is_finite())
        || intrinsics.fx <= 0.0
        || intrinsics.fy <= 0.0
    {
        return Err(CameraError::invalid("intrinsics.fx/fy", "must be positive"));
    }
    if !(options.psf_sigma_px > 0.0) || !options.psf_sigma_px.is_finite() {
        return Err(CameraError::invalid(
            "render.psf_sigma_px",
            "must be a positive, finite number of pixels",
        ));
    }
    if !(options.saturation_level > 0.0) {
        return Err(CameraError::invalid(
            "render.saturation_level",
            "must be positive",
        ));
    }
    if options.background_level < 0.0 || options.read_noise < 0.0 {
        return Err(CameraError::invalid(
            "render.background_level/read_noise",
            "must not be negative",
        ));
    }
    if let Some(sea) = options.sea_horizon
        && (!sea.height_of_eye_m.is_finite() || sea.height_of_eye_m < 0.0)
    {
        return Err(CameraError::invalid(
            "render.sea_horizon.height_of_eye_m",
            "must be a non-negative height in metres",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{angle_between, camera_from_enu};
    use approx::assert_relative_eq;

    const UTC: &str = "2026-10-01T05:30:00Z";
    fn philadelphia() -> Point {
        Point::from_deg(39.9526, -75.1652)
    }

    #[test]
    fn refraction_round_trip_matches_the_core() {
        for ho in [0.5_f64, 5.0, 20.0, 45.0, 80.0, 89.9] {
            let ha = apparent_altitude_deg(ho, 1010.0, 10.0);
            let back = ha - refraction_arcmin(ha, 1010.0, 10.0) / 60.0;
            assert_relative_eq!(back, ho, epsilon = 1e-10);
            // And this crate's restatement agrees with skyfix_core's own.
            assert_relative_eq!(
                refraction_arcmin(ha, 1010.0, 10.0),
                skyfix_core::corrections::refraction_arcmin(ha, 1010.0, 10.0),
                epsilon = 1e-12
            );
            assert!(ha > ho, "refraction must raise a body");
        }
        assert_relative_eq!(dip_arcmin(4.0), 3.52, epsilon = 1e-12);
        assert_relative_eq!(dip_arcmin(-1.0), 0.0);
    }

    #[test]
    fn stars_land_where_the_truth_says_they_do() {
        let k = Intrinsics::from_horizontal_fov(512, 384, 40f64.to_radians());
        let att = camera_from_enu(45f64.to_radians(), 250f64.to_radians(), 0.0);
        let opts = RenderOptions::default().noiseless();
        let (image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        assert_eq!(image.width, 512);
        assert_eq!(image.data.len(), 512 * 384);
        assert!(!truth.stars.is_empty(), "no stars in the field");
        for s in &truth.stars {
            // The recorded camera direction projects to the recorded pixel.
            let (u, v) = k.project_unclipped(s.dir_camera).unwrap();
            assert_relative_eq!(u, s.u, epsilon = 1e-9);
            assert_relative_eq!(v, s.v, epsilon = 1e-9);
            // Refraction raised it, by the Bennett amount, at unchanged azimuth.
            assert!(s.apparent_altitude_deg > s.true_altitude_deg);
            assert_relative_eq!(
                s.apparent_altitude_deg - s.true_altitude_deg,
                refraction_arcmin(s.apparent_altitude_deg, 1010.0, 10.0) / 60.0,
                epsilon = 1e-10
            );
            // Its altitude measured from the true vertical is the apparent altitude.
            let alt = crate::frames::dot(s.dir_camera, truth.up_camera).asin();
            assert_relative_eq!(
                alt.to_degrees(),
                s.apparent_altitude_deg,
                epsilon = 1e-10
            );
        }
        // The truth attitude is the one we asked for, in both frames.
        assert!(truth.attitude_camera_from_enu.angle_to(&att) < 1e-14);
        let back = truth
            .attitude_camera_from_earth_fixed
            .compose(&enu_from_earth_fixed(philadelphia()).inverse());
        assert!(back.angle_to(&att) < 1e-13);
        assert!(truth.refraction_applied);
    }

    #[test]
    fn turning_refraction_off_lowers_every_star() {
        // The Orion field: six catalogue stars in one 40-degree frame.
        let k = Intrinsics::from_horizontal_fov(256, 192, 40f64.to_radians());
        let att = camera_from_enu(25f64.to_radians(), 100f64.to_radians(), 0.0);
        let on = RenderOptions::default().noiseless();
        let off = RenderOptions {
            apply_refraction: false,
            ..on
        };
        let (_, t_on) = render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &on).unwrap();
        let (_, t_off) = render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &off).unwrap();
        assert!(!t_off.refraction_applied);
        let mut compared = 0;
        for a in &t_on.stars {
            if let Some(b) = t_off.stars.iter().find(|s| s.name == a.name) {
                assert_relative_eq!(
                    b.apparent_altitude_deg,
                    b.true_altitude_deg,
                    epsilon = 1e-12
                );
                assert!(a.apparent_altitude_deg > b.apparent_altitude_deg);
                // Refraction moves a star by arcminutes, never by degrees: at the
                // bottom of this frame (about 15 deg) Bennett gives 3.5'.
                let moved = angle_between(a.dir_camera, b.dir_camera);
                assert!(moved > 0.0 && moved < 0.01, "moved {moved} rad");
                compared += 1;
            }
        }
        assert!(compared > 0, "the two renders shared no stars");
    }

    #[test]
    fn noise_defects_and_saturation_behave() {
        let k = Intrinsics::from_horizontal_fov(128, 96, 30f64.to_radians());
        let att = camera_from_enu(45f64.to_radians(), 250f64.to_radians(), 0.0);
        let opts = RenderOptions {
            hot_pixels: 3,
            hot_pixel_level: 1e9, // above saturation on purpose
            saturation_level: 4095.0,
            background_level: 200.0,
            read_noise: 8.0,
            shot_noise: true,
            seed: 77,
            ..RenderOptions::default()
        };
        let (image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        assert_eq!(truth.hot_pixels.len(), 3);
        for &(x, y) in &truth.hot_pixels {
            assert_relative_eq!(image.at(x, y), 4095.0);
        }
        let (lo, hi) = image.range();
        assert!(lo >= 0.0 && hi <= 4095.0, "clipping failed: {lo}..{hi}");
        // The background is noisy but centred on the requested level.
        let mean = image.data.iter().sum::<f64>() / image.data.len() as f64;
        assert!((mean - 200.0).abs() < 25.0, "background mean {mean}");
        // Determinism: the same seed reproduces the image bit for bit.
        let (again, _) = render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        assert_eq!(image, again);
        let other = RenderOptions { seed: 78, ..opts };
        let (different, _) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &other).unwrap();
        assert_ne!(image, different);
    }

    #[test]
    fn the_sea_horizon_sits_at_minus_dip() {
        let k = Intrinsics::from_horizontal_fov(160, 120, 30f64.to_radians());
        // Point at the horizon so the line crosses the frame.
        let att = camera_from_enu(0.0, 180f64.to_radians(), 0.0);
        let opts = RenderOptions {
            sea_horizon: Some(SeaHorizon {
                height_of_eye_m: 9.0,
                sea_level: 10.0,
            }),
            background_level: 400.0,
            // No stars: this test is about the edge, and a PSF on the line would add
            // transitions the column check below would (correctly) object to.
            magnitude_limit: -10.0,
            ..RenderOptions::default().noiseless()
        };
        let (image, truth) =
            render(UTC, philadelphia(), &att, &k, &StarProvider::new(), &opts).unwrap();
        let h = truth.horizon.expect("horizon truth");
        assert_relative_eq!(h.dip_arcmin, 1.76 * 3.0, epsilon = 1e-12);
        let row = h.center_row.expect("horizon should cross the centre column");
        // Below the line is sea, above is sky, and the crossing row is where the
        // altitude equals -dip.
        let x = k.width / 2;
        assert_relative_eq!(image.at(x, (row - 3.0) as usize), 400.0, epsilon = 1e-9);
        assert_relative_eq!(image.at(x, (row + 3.0) as usize), 10.0, epsilon = 1e-9);
        let enu_from_camera = att.inverse();
        let d = enu_from_camera.rotate(k.unproject(x as f64, row));
        assert_relative_eq!(
            alt_az_from_enu(d).0.to_degrees() * 60.0,
            -h.dip_arcmin,
            epsilon = 1e-6
        );
        // Every column has exactly one edge and the same sky/sea totals either side.
        for x in 0..k.width {
            let crossings = (1..k.height)
                .filter(|&y| (image.at(x, y) - image.at(x, y - 1)).abs() > 1e-9)
                .count();
            assert!(crossings <= 2, "column {x} has {crossings} transitions");
        }
    }

    #[test]
    fn pgm_export_has_the_right_header_and_size() {
        let mut img = Image::new(3, 2, 0.0);
        img.set(0, 0, 100.0);
        img.set(2, 1, 50.0);
        let pgm = img.to_pgm(0.0, 100.0);
        assert!(pgm.starts_with(b"P5\n3 2\n65535\n"));
        let header = b"P5\n3 2\n65535\n".len();
        assert_eq!(pgm.len(), header + 3 * 2 * 2);
        assert_eq!(&pgm[header..header + 2], &[0xFF, 0xFF]); // 100 -> 65535
        assert_eq!(&pgm[header + 2..header + 4], &[0x00, 0x00]);
        // Degenerate range and non-finite samples do not panic.
        let mut bad = Image::new(1, 1, f64::NAN);
        assert_eq!(bad.to_pgm(0.0, 0.0).len(), b"P5\n1 1\n65535\n".len() + 2);
        bad.set(0, 0, 7.0);
        assert_eq!(bad.range(), (7.0, 7.0));
        assert_eq!(Image::new(0, 0, 0.0).range(), (0.0, 0.0));
    }

    #[test]
    fn invalid_options_are_refused() {
        let k = Intrinsics::from_horizontal_fov(16, 16, 30f64.to_radians());
        let att = Rotation::IDENTITY;
        let p = StarProvider::new();
        let bad_sigma = RenderOptions {
            psf_sigma_px: 0.0,
            ..RenderOptions::default()
        };
        assert!(render(UTC, philadelphia(), &att, &k, &p, &bad_sigma).is_err());
        let bad_sat = RenderOptions {
            saturation_level: -1.0,
            ..RenderOptions::default()
        };
        assert!(render(UTC, philadelphia(), &att, &k, &p, &bad_sat).is_err());
        let bad_height = RenderOptions {
            sea_horizon: Some(SeaHorizon {
                height_of_eye_m: -2.0,
                sea_level: 0.0,
            }),
            ..RenderOptions::default()
        };
        assert!(render(UTC, philadelphia(), &att, &k, &p, &bad_height).is_err());
        let zero = Intrinsics::from_horizontal_fov(0, 4, 1.0);
        assert!(render(UTC, philadelphia(), &att, &zero, &p, &RenderOptions::default()).is_err());
        // A timestamp the core rejects.
        assert!(
            render(
                "2026-10-01 01:30:00",
                philadelphia(),
                &att,
                &k,
                &p,
                &RenderOptions::default()
            )
            .is_err()
        );
        // Outside the provider's coverage.
        assert!(
            render(
                "1899-01-01T00:00:00Z",
                philadelphia(),
                &att,
                &k,
                &p,
                &RenderOptions::default()
            )
            .is_err()
        );
    }
}
