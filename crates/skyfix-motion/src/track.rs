//! Dead reckoning: a piecewise-constant-velocity track and the covariance of the
//! displacement it predicts.
//!
//! CONVENTIONS section 1 (units), section 2 (north/east signs), section 6 (`jd_utc`).
//! `docs/MOTION.md` section "The dead-reckoning model" is normative for the formulae.
//!
//! # The track
//!
//! A [`Track`] is a list of [`Leg`]s. Each leg starts at a `jd_utc` instant and holds a
//! constant course and speed until the next leg starts (or until the track's optional
//! end). Before the first leg the vessel is treated as **stationary**, which is a silent
//! assumption unless someone checks, so [`Track::covers`] exists and
//! [`crate::running_fix`] warns when a sight falls outside the track.
//!
//! # Displacement
//!
//! [`Track::position_offset`] integrates the velocity over an interval and returns the
//! flat tangent-plane displacement `(north_nm, east_nm)`:
//!
//! ```text
//! north = sum_i  v_i * T_i * cos(c_i)          T_i in hours, v_i in knots
//! east  = sum_i  v_i * T_i * sin(c_i)          so v_i * T_i is nautical miles
//! ```
//!
//! [`Track::advance`] applies the same run to an actual position, one leg at a time, as a
//! great-circle step (`skyfix_core::geometry::destination`). A leg is therefore modelled
//! as a **great-circle segment on its initial course**, not as a rhumb line; over the
//! tens of nautical miles a running fix spans the two differ by far less than the
//! dead-reckoning uncertainty itself, and the choice is stated rather than assumed.
//!
//! Running the interval backwards is *not* a walk on reciprocal courses: on a sphere the
//! back-azimuth of a great-circle leg differs from `course + 180` by the convergence of
//! the meridians, which for a 30 NM run at 40 N is about 200 m of position. The backward
//! direction instead **inverts the forward walk numerically** (a few fixed-point steps
//! from the reciprocal-bearing guess), so `advance(advance(p, a, b), b, a) == p` holds to
//! machine precision. See `docs/MOTION.md`.
//!
//! # Time resolution
//!
//! Times are `jd_utc` (`f64`). Near 2026 one ulp is about 4.7e-10 days, so a difference of
//! two Julian dates resolves about 40 microseconds; at 12 knots that is a quarter of a
//! millimetre of run. Every distance below therefore carries a sub-millimetre jitter that
//! is a property of the time representation, not of this model.
//!
//! # Displacement uncertainty
//!
//! [`MotionUncertainty`] carries three terms. The first two are **biases held for the
//! whole run** — a speed-log scale error and a compass/steering error do not resample
//! themselves every leg (BRIEF "non-negotiable physical distinctions" item 6: repeating a
//! measurement does not average away a common bias). The third is a genuine random walk.
//!
//! For segments `i` with duration `T_i` (hours), distance `d_i = v_i T_i` (NM), along-track
//! unit vector `u_i = (cos c_i, sin c_i)` and cross-track unit vector
//! `n_i = (-sin c_i, cos c_i)`, both in `(north, east)`:
//!
//! ```text
//! A = sum_i T_i u_i           NM per knot of speed error   (along-track sensitivity)
//! B = sum_i d_i n_i           NM per radian of course error (cross-track sensitivity)
//!
//! C = sigma_v^2 A A^T  +  sigma_c^2 B B^T  +  q^2 T_total I
//! ```
//!
//! with `sigma_v` in knots, `sigma_c` in radians, `q` in NM per sqrt(hour) and `T_total`
//! in hours. `C` is the 2x2 covariance of the displacement in NM^2, rows and columns
//! `(north, east)`.
//!
//! For a single leg this reduces to the textbook form: the along-track standard deviation
//! is `sigma_v * T`, the cross-track standard deviation is `d * sigma_c`, and the ellipse
//! is oriented along and across the course. Because `A` and `B` are *sums* of vectors,
//! two legs on reciprocal courses partially cancel the bias terms — which is correct, and
//! is exactly what an independent-per-leg model would get wrong.

use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{Point, apply_tangent_step, destination, tangent_offset};
use skyfix_core::units::{NM_M, nm_to_rad};
use std::cmp::Ordering;
use std::f64::consts::PI;

/// Hours in one Julian day.
pub const HOURS_PER_DAY: f64 = 24.0;

/// One constant-velocity leg of a dead-reckoning track.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Leg {
    /// Instant the leg begins, `jd_utc` (CONVENTIONS section 6).
    pub start_utc_jd: f64,
    /// Course made good, degrees true, clockwise from north.
    pub course_deg: f64,
    /// Speed made good over the ground, knots.
    pub speed_kn: f64,
}

impl Leg {
    pub fn new(start_utc_jd: f64, course_deg: f64, speed_kn: f64) -> Self {
        Leg {
            start_utc_jd,
            course_deg,
            speed_kn,
        }
    }

    fn is_usable(&self) -> bool {
        self.start_utc_jd.is_finite() && self.course_deg.is_finite() && self.speed_kn.is_finite()
    }
}

/// A piece of one leg clipped to a requested interval, in time order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    /// Duration of the clipped piece, hours.
    pub hours: f64,
    /// Course of the parent leg, radians clockwise from north.
    pub course_rad: f64,
    /// Distance run over the clipped piece, nautical miles.
    pub distance_nm: f64,
}

/// A dead-reckoning track: legs of constant course and speed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Track {
    legs: Vec<Leg>,
    /// Optional end of the track. `None` means the last leg runs on indefinitely.
    end_utc_jd: Option<f64>,
}

impl Track {
    /// A track whose last leg runs on indefinitely. Legs are sorted by start time;
    /// non-finite legs are dropped.
    pub fn new(legs: Vec<Leg>) -> Self {
        Track {
            legs: sorted(legs),
            end_utc_jd: None,
        }
    }

    /// A track that stops at `end_utc_jd`; after it the vessel is treated as stationary.
    pub fn with_end(legs: Vec<Leg>, end_utc_jd: f64) -> Self {
        Track {
            legs: sorted(legs),
            end_utc_jd: Some(end_utc_jd),
        }
    }

    /// A single constant course and speed beginning at `start_utc_jd`.
    pub fn constant(start_utc_jd: f64, course_deg: f64, speed_kn: f64) -> Self {
        Track::new(vec![Leg::new(start_utc_jd, course_deg, speed_kn)])
    }

    pub fn legs(&self) -> &[Leg] {
        &self.legs
    }

    pub fn end_utc_jd(&self) -> Option<f64> {
        self.end_utc_jd
    }

    pub fn is_empty(&self) -> bool {
        self.legs.is_empty()
    }

    /// `(first leg start, end)` in `jd_utc`; the end is `+inf` for an open-ended track.
    pub fn span(&self) -> Option<(f64, f64)> {
        let first = self.legs.first()?.start_utc_jd;
        Some((first, self.end_utc_jd.unwrap_or(f64::INFINITY)))
    }

    /// Does the track actually describe the whole interval? Outside it the vessel is
    /// silently treated as stationary, so callers that care must ask.
    pub fn covers(&self, from_utc_jd: f64, to_utc_jd: f64) -> bool {
        let Some((start, end)) = self.span() else {
            return false;
        };
        let (lo, hi) = order(from_utc_jd, to_utc_jd);
        lo.is_finite() && hi.is_finite() && lo >= start && hi <= end
    }

    /// The legs clipped to `[lo, hi]`, in time order. `lo <= hi` is required; outside the
    /// track the vessel contributes nothing.
    pub fn segments(&self, lo: f64, hi: f64) -> Vec<Segment> {
        let mut out = Vec::new();
        if !lo.is_finite() || !hi.is_finite() || hi <= lo {
            return out;
        }
        let end = self.end_utc_jd.unwrap_or(f64::INFINITY);
        for (i, leg) in self.legs.iter().enumerate() {
            let leg_end = self
                .legs
                .get(i + 1)
                .map_or(end, |next| next.start_utc_jd.min(end));
            let a = leg.start_utc_jd.max(lo);
            let b = leg_end.min(hi);
            if b > a {
                let hours = (b - a) * HOURS_PER_DAY;
                out.push(Segment {
                    hours,
                    course_rad: leg.course_deg.to_radians(),
                    distance_nm: leg.speed_kn * hours,
                });
            }
        }
        out
    }

    /// Flat tangent-plane displacement over `[from, to]`, `(north_nm, east_nm)`.
    /// Reversing the interval negates the result.
    pub fn position_offset(&self, from_utc_jd: f64, to_utc_jd: f64) -> (f64, f64) {
        if !from_utc_jd.is_finite() || !to_utc_jd.is_finite() {
            return (0.0, 0.0);
        }
        let sign = if to_utc_jd >= from_utc_jd { 1.0 } else { -1.0 };
        let (lo, hi) = order(from_utc_jd, to_utc_jd);
        let (mut north, mut east) = (0.0, 0.0);
        for s in self.segments(lo, hi) {
            let (sc, cc) = s.course_rad.sin_cos();
            north += s.distance_nm * cc;
            east += s.distance_nm * sc;
        }
        (sign * north, sign * east)
    }

    /// Same run as [`Track::position_offset`], but applied to a real position: one
    /// great-circle step per leg. `to < from` runs the track backwards and is the exact
    /// inverse of the forward walk (see the module docs on why reciprocal bearings are
    /// not).
    pub fn advance(&self, start: Point, from_utc_jd: f64, to_utc_jd: f64) -> Point {
        if !from_utc_jd.is_finite() || !to_utc_jd.is_finite() {
            return start;
        }
        if to_utc_jd >= from_utc_jd {
            self.walk_forward(start, from_utc_jd, to_utc_jd)
        } else {
            self.walk_backward(start, to_utc_jd, from_utc_jd)
        }
    }

    /// The vessel's position at `hi` given its position at `lo`, `lo <= hi`.
    fn walk_forward(&self, start: Point, lo: f64, hi: f64) -> Point {
        let mut p = start;
        for s in self.segments(lo, hi) {
            if s.distance_nm == 0.0 {
                continue;
            }
            // A negative distance (a negative speed) runs the leg astern; `destination`
            // handles the sign through the trigonometry, so no special case is needed.
            p = destination(p, s.course_rad, nm_to_rad(s.distance_nm));
        }
        p
    }

    /// The vessel's position at `lo` given its position at `hi`: the `q` with
    /// `walk_forward(q, lo, hi) == end`.
    ///
    /// The forward walk is very nearly an isometry — its derivative differs from the
    /// identity only by the meridian convergence over the run — so the fixed-point
    /// iteration `q <- q + (end - walk_forward(q))` contracts by roughly 1e-3 per step
    /// and reaches machine precision from the reciprocal-bearing guess in three or four.
    fn walk_backward(&self, end: Point, lo: f64, hi: f64) -> Point {
        let mut segments = self.segments(lo, hi);
        segments.reverse();
        let mut q = end;
        for s in segments {
            if s.distance_nm == 0.0 {
                continue;
            }
            q = destination(q, s.course_rad + PI, nm_to_rad(s.distance_nm));
        }
        for _ in 0..8 {
            let forward = self.walk_forward(q, lo, hi);
            let (dn, de) = tangent_offset(forward, end);
            if dn == 0.0 && de == 0.0 {
                break;
            }
            q = apply_tangent_step(q, dn, de);
            if dn.hypot(de) < 1e-15 {
                break;
            }
        }
        q
    }

    /// Total distance run over `[from, to]`, nautical miles (path length, not the
    /// straight-line displacement).
    pub fn distance_run_nm(&self, from_utc_jd: f64, to_utc_jd: f64) -> f64 {
        let (lo, hi) = order(from_utc_jd, to_utc_jd);
        self.segments(lo, hi)
            .iter()
            .map(|s| s.distance_nm.abs())
            .sum()
    }
}

/// The three terms of the dead-reckoning error model. See the module docs for the
/// covariance formula and for why the first two are biases rather than per-leg noise.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct MotionUncertainty {
    /// 1-sigma speed error, knots. A log scale error: held for the whole run.
    pub speed_sigma_kn: f64,
    /// 1-sigma course error, degrees. A compass/steering error: held for the whole run.
    pub course_sigma_deg: f64,
    /// Isotropic random walk, NM per sqrt(hour): set, current and steering wander.
    pub random_walk_nm_per_sqrt_hour: f64,
}

impl Default for MotionUncertainty {
    /// No modelled motion uncertainty. Deliberately zero rather than a plausible-looking
    /// default: an unstated DR uncertainty is the thing this module exists to prevent.
    fn default() -> Self {
        MotionUncertainty {
            speed_sigma_kn: 0.0,
            course_sigma_deg: 0.0,
            random_walk_nm_per_sqrt_hour: 0.0,
        }
    }
}

impl MotionUncertainty {
    pub fn new(
        speed_sigma_kn: f64,
        course_sigma_deg: f64,
        random_walk_nm_per_sqrt_hour: f64,
    ) -> Self {
        MotionUncertainty {
            speed_sigma_kn,
            course_sigma_deg,
            random_walk_nm_per_sqrt_hour,
        }
    }

    pub fn is_zero(&self) -> bool {
        self.speed_sigma_kn == 0.0
            && self.course_sigma_deg == 0.0
            && self.random_walk_nm_per_sqrt_hour == 0.0
    }

    /// Covariance of the displacement over `[from, to]`, NM^2, rows/cols `(north, east)`.
    /// Symmetric in the direction of time: reversing the interval leaves it unchanged.
    pub fn displacement_covariance_nm2(
        &self,
        track: &Track,
        from_utc_jd: f64,
        to_utc_jd: f64,
    ) -> [[f64; 2]; 2] {
        let (lo, hi) = order(from_utc_jd, to_utc_jd);
        // A: NM per knot of speed bias. B: NM per radian of course bias.
        let (mut a_n, mut a_e) = (0.0, 0.0);
        let (mut b_n, mut b_e) = (0.0, 0.0);
        let mut hours = 0.0;
        for s in track.segments(lo, hi) {
            let (sc, cc) = s.course_rad.sin_cos();
            a_n += s.hours * cc;
            a_e += s.hours * sc;
            b_n += s.distance_nm * -sc;
            b_e += s.distance_nm * cc;
            hours += s.hours;
        }
        let sv = guard(self.speed_sigma_kn);
        let scr = guard(self.course_sigma_deg).to_radians();
        let q = guard(self.random_walk_nm_per_sqrt_hour);
        let walk = q * q * hours;

        let nn = sv * sv * a_n * a_n + scr * scr * b_n * b_n + walk;
        let ee = sv * sv * a_e * a_e + scr * scr * b_e * b_e + walk;
        let ne = sv * sv * a_n * a_e + scr * scr * b_n * b_e;
        [[nn, ne], [ne, ee]]
    }

    /// The same covariance in radians of arc squared — the unit the sight Jacobian row
    /// `[cos Zn, sin Zn]` expects (CONVENTIONS section 3).
    pub fn displacement_covariance_rad2(
        &self,
        track: &Track,
        from_utc_jd: f64,
        to_utc_jd: f64,
    ) -> [[f64; 2]; 2] {
        let k = nm_to_rad(1.0);
        scale_cov(
            self.displacement_covariance_nm2(track, from_utc_jd, to_utc_jd),
            k * k,
        )
    }

    /// The same covariance in metres squared, for comparison with GNSS covariances.
    pub fn displacement_covariance_m2(
        &self,
        track: &Track,
        from_utc_jd: f64,
        to_utc_jd: f64,
    ) -> [[f64; 2]; 2] {
        scale_cov(
            self.displacement_covariance_nm2(track, from_utc_jd, to_utc_jd),
            NM_M * NM_M,
        )
    }
}

fn scale_cov(c: [[f64; 2]; 2], k: f64) -> [[f64; 2]; 2] {
    [[c[0][0] * k, c[0][1] * k], [c[1][0] * k, c[1][1] * k]]
}

fn guard(x: f64) -> f64 {
    if x.is_finite() { x.abs() } else { 0.0 }
}

fn order(a: f64, b: f64) -> (f64, f64) {
    if b >= a { (a, b) } else { (b, a) }
}

fn sorted(mut legs: Vec<Leg>) -> Vec<Leg> {
    legs.retain(Leg::is_usable);
    legs.sort_by(|a, b| {
        a.start_utc_jd
            .partial_cmp(&b.start_utc_jd)
            .unwrap_or(Ordering::Equal)
    });
    legs
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use skyfix_core::geometry::angular_distance;
    use skyfix_core::linalg::eigen_sym2;
    use skyfix_core::units::rad_to_nm;

    /// 2026-10-01T00:00:00Z, the epoch every track test hangs off.
    const T0: f64 = 2_461_314.5;
    const HOUR: f64 = 1.0 / 24.0;
    /// A Julian-date difference near 2026 resolves about 40 microseconds; at these
    /// speeds that is well under a millimetre, so distances are checked to 1e-6 NM.
    const JD_NM: f64 = 1e-6;

    #[test]
    fn three_hours_at_ten_knots_on_045() {
        let track = Track::constant(T0, 45.0, 10.0);
        let (n, e) = track.position_offset(T0, T0 + 3.0 * HOUR);
        // 30 NM on 045: 30 / sqrt(2) = 21.2132 NM north and east.
        assert_relative_eq!(n, 21.213_203_435_596_43, epsilon = JD_NM);
        assert_relative_eq!(e, 21.213_203_435_596_43, epsilon = JD_NM);
        assert_relative_eq!(n.hypot(e), 30.0, epsilon = JD_NM);
        assert_relative_eq!(
            track.distance_run_nm(T0, T0 + 3.0 * HOUR),
            30.0,
            epsilon = JD_NM
        );
    }

    #[test]
    fn reversing_the_interval_negates_the_offset_and_inverts_the_advance() {
        let track = Track::constant(T0, 45.0, 10.0);
        let (n, e) = track.position_offset(T0, T0 + 3.0 * HOUR);
        let (rn, re) = track.position_offset(T0 + 3.0 * HOUR, T0);
        assert_relative_eq!(rn, -n, epsilon = 1e-12);
        assert_relative_eq!(re, -e, epsilon = 1e-12);

        let start = Point::from_deg(40.0, -70.0);
        let end = track.advance(start, T0, T0 + 3.0 * HOUR);
        let back = track.advance(end, T0 + 3.0 * HOUR, T0);
        assert_relative_eq!(back.lat, start.lat, epsilon = 1e-14);
        assert_relative_eq!(back.lon, start.lon, epsilon = 1e-14);
        // The great-circle run is 30 NM long.
        assert_relative_eq!(rad_to_nm(angular_distance(start, end)), 30.0, epsilon = JD_NM);

        // A reciprocal-bearing walk would NOT have got back: on a sphere the back-azimuth
        // of a 30 NM leg at 40 N differs from course + 180 by the meridian convergence.
        let naive = destination(end, 45.0_f64.to_radians() + PI, nm_to_rad(30.0));
        let naive_error_m = rad_to_nm(angular_distance(naive, start)) * NM_M;
        assert!(
            naive_error_m > 100.0,
            "the reciprocal-bearing shortcut should be visibly wrong, was {naive_error_m} m"
        );
        assert!(rad_to_nm(angular_distance(back, start)) * NM_M < 1e-6);
    }

    #[test]
    fn backward_walk_inverts_multi_leg_tracks_at_high_latitude() {
        let track = Track::new(vec![
            Leg::new(T0, 300.0, 18.0),
            Leg::new(T0 + 1.5 * HOUR, 20.0, 14.0),
            Leg::new(T0 + 4.0 * HOUR, 175.0, 9.0),
        ]);
        for (lat, lon) in [(40.0, -70.0), (62.0, 5.0), (-35.0, 173.0), (1.0, -179.5)] {
            let start = Point::from_deg(lat, lon);
            let end = track.advance(start, T0, T0 + 6.0 * HOUR);
            let back = track.advance(end, T0 + 6.0 * HOUR, T0);
            let err_m = rad_to_nm(angular_distance(back, start)) * NM_M;
            assert!(err_m < 1e-6, "round trip at {lat},{lon} was {err_m} m");
        }
    }

    #[test]
    fn multiple_legs_integrate_piecewise_and_a_reciprocal_leg_cancels() {
        let track = Track::new(vec![
            Leg::new(T0, 90.0, 12.0),             // 2 h due east  -> 24 NM east
            Leg::new(T0 + 2.0 * HOUR, 0.0, 6.0),  // 1 h due north ->  6 NM north
            Leg::new(T0 + 3.0 * HOUR, 270.0, 12.0), // 2 h due west -> 24 NM west
        ]);
        let (n, e) = track.position_offset(T0, T0 + 5.0 * HOUR);
        assert_relative_eq!(n, 6.0, epsilon = JD_NM);
        assert_relative_eq!(e, 0.0, epsilon = JD_NM);
        // Path length is 54 NM even though the displacement is 6 NM.
        assert_relative_eq!(
            track.distance_run_nm(T0, T0 + 5.0 * HOUR),
            54.0,
            epsilon = JD_NM
        );
        // A sub-interval clips both ends of a leg.
        let (n2, e2) = track.position_offset(T0 + 1.0 * HOUR, T0 + 2.5 * HOUR);
        assert_relative_eq!(n2, 3.0, epsilon = JD_NM);
        assert_relative_eq!(e2, 12.0, epsilon = JD_NM);
    }

    #[test]
    fn before_the_first_leg_the_vessel_is_stationary_and_covers_says_so() {
        let track = Track::constant(T0, 45.0, 10.0);
        let (n, e) = track.position_offset(T0 - 2.0 * HOUR, T0);
        assert_eq!((n, e), (0.0, 0.0));
        assert!(!track.covers(T0 - 1.0 * HOUR, T0 + 1.0 * HOUR));
        assert!(track.covers(T0, T0 + 100.0 * HOUR));

        let bounded = Track::with_end(vec![Leg::new(T0, 45.0, 10.0)], T0 + 3.0 * HOUR);
        assert!(bounded.covers(T0, T0 + 3.0 * HOUR));
        assert!(!bounded.covers(T0, T0 + 4.0 * HOUR));
        // Past the end the vessel stops.
        let (n, _) = bounded.position_offset(T0, T0 + 10.0 * HOUR);
        assert_relative_eq!(n, 21.213_203_435_596_43, epsilon = JD_NM);
    }

    #[test]
    fn covariance_is_oriented_along_and_across_the_course() {
        let track = Track::constant(T0, 45.0, 10.0);
        let mu = MotionUncertainty::new(0.5, 2.0, 0.0);
        let c = mu.displacement_covariance_nm2(&track, T0, T0 + 3.0 * HOUR);

        // Along-track variance: (sigma_v * T)^2 = (0.5 * 3)^2 = 2.25 NM^2.
        // Cross-track variance: (d * sigma_c)^2 = (30 * 2 deg in rad)^2.
        let along = 1.5_f64 * 1.5;
        let cross = (30.0 * 2.0_f64.to_radians()).powi(2);
        let (values, vectors) = eigen_sym2(c);
        assert_relative_eq!(values[0], along, epsilon = 1e-9);
        assert_relative_eq!(values[1], cross, epsilon = 1e-9);
        // Major axis points along 045.
        let major_az = vectors[1][0].atan2(vectors[0][0]).to_degrees().rem_euclid(180.0);
        assert_relative_eq!(major_az, 45.0, epsilon = 1e-9);

        // Equal north/east variance and positive correlation on a 045 course.
        assert_relative_eq!(c[0][0], c[1][1], epsilon = 1e-12);
        assert!(c[0][1] > 0.0);
        assert_relative_eq!(c[0][0], 0.5 * (along + cross), epsilon = 1e-9);
        assert_relative_eq!(c[0][1], 0.5 * (along - cross), epsilon = 1e-9);
    }

    #[test]
    fn covariance_grows_with_time() {
        let track = Track::constant(T0, 45.0, 10.0);
        let mu = MotionUncertainty::new(0.5, 2.0, 0.3);
        let mut previous = 0.0;
        for hours in [0.5, 1.0, 1.5, 2.0, 3.0, 6.0] {
            let c = mu.displacement_covariance_nm2(&track, T0, T0 + hours * HOUR);
            let trace = c[0][0] + c[1][1];
            assert!(trace > previous, "trace must grow: {trace} <= {previous}");
            previous = trace;
        }
        // Time-symmetric.
        let forward = mu.displacement_covariance_nm2(&track, T0, T0 + 3.0 * HOUR);
        let backward = mu.displacement_covariance_nm2(&track, T0 + 3.0 * HOUR, T0);
        assert_eq!(forward, backward);
        // A zero-length interval has zero covariance.
        let zero = mu.displacement_covariance_nm2(&track, T0, T0);
        assert_eq!(zero, [[0.0, 0.0], [0.0, 0.0]]);
    }

    #[test]
    fn random_walk_is_isotropic_and_linear_in_time() {
        let track = Track::constant(T0, 45.0, 10.0);
        let mu = MotionUncertainty::new(0.0, 0.0, 0.4);
        let c1 = mu.displacement_covariance_nm2(&track, T0, T0 + 1.0 * HOUR);
        let c4 = mu.displacement_covariance_nm2(&track, T0, T0 + 4.0 * HOUR);
        assert_relative_eq!(c1[0][0], 0.16, epsilon = 1e-8);
        assert_relative_eq!(c1[1][1], 0.16, epsilon = 1e-8);
        assert_eq!(c1[0][1], 0.0);
        assert_relative_eq!(c4[0][0], 0.64, epsilon = 1e-8);
    }

    #[test]
    fn a_shared_speed_bias_partially_cancels_on_reciprocal_legs() {
        // Out and back on the same speed: the along-track bias cancels exactly, which an
        // independent-per-leg model would instead report as sqrt(2) times one leg.
        let track = Track::new(vec![
            Leg::new(T0, 0.0, 10.0),
            Leg::new(T0 + 1.0 * HOUR, 180.0, 10.0),
        ]);
        let mu = MotionUncertainty::new(0.5, 0.0, 0.0);
        let c = mu.displacement_covariance_nm2(&track, T0, T0 + 2.0 * HOUR);
        // One leg alone would contribute (0.5 kn * 1 h)^2 = 0.25 NM^2.
        let one_leg = mu.displacement_covariance_nm2(&track, T0, T0 + 1.0 * HOUR);
        assert_relative_eq!(one_leg[0][0], 0.25, epsilon = 1e-8);
        assert!(c[0][0] < 1e-12, "north variance {} should cancel", c[0][0]);
        assert!(c[1][1] < 1e-12, "east variance {} should cancel", c[1][1]);
    }

    #[test]
    fn unit_conversions_are_consistent() {
        let track = Track::constant(T0, 45.0, 10.0);
        let mu = MotionUncertainty::new(0.5, 2.0, 0.1);
        let nm2 = mu.displacement_covariance_nm2(&track, T0, T0 + 3.0 * HOUR);
        let m2 = mu.displacement_covariance_m2(&track, T0, T0 + 3.0 * HOUR);
        let rad2 = mu.displacement_covariance_rad2(&track, T0, T0 + 3.0 * HOUR);
        assert_relative_eq!(m2[0][0], nm2[0][0] * NM_M * NM_M, epsilon = 1e-6);
        assert_relative_eq!(rad_to_nm(rad2[0][0].sqrt()), nm2[0][0].sqrt(), epsilon = 1e-12);
    }

    #[test]
    fn malformed_input_is_dropped_not_propagated() {
        let track = Track::new(vec![
            Leg::new(f64::NAN, 45.0, 10.0),
            Leg::new(T0, f64::INFINITY, 10.0),
            Leg::new(T0, 45.0, 10.0),
        ]);
        assert_eq!(track.legs().len(), 1);
        let (n, e) = track.position_offset(f64::NAN, T0);
        assert_eq!((n, e), (0.0, 0.0));
        let start = Point::from_deg(40.0, -70.0);
        assert_eq!(track.advance(start, f64::NAN, T0), start);
        assert!(Track::default().span().is_none());
        assert!(Track::default().is_empty());
    }

    #[test]
    fn legs_are_sorted_on_construction() {
        let track = Track::new(vec![
            Leg::new(T0 + 2.0 * HOUR, 90.0, 5.0),
            Leg::new(T0, 0.0, 5.0),
        ]);
        assert_eq!(track.legs()[0].course_deg, 0.0);
        let (n, e) = track.position_offset(T0, T0 + 3.0 * HOUR);
        assert_relative_eq!(n, 10.0, epsilon = JD_NM);
        assert_relative_eq!(e, 5.0, epsilon = JD_NM);
    }
}
