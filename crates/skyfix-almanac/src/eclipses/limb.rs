//! The lunar limb profile: solar-eclipse contacts corrected for the Moon's mountains and
//! valleys, the profile itself for drawing, and approximate Baily's beads.
//!
//! OWNER: eclipselimb agent (expansion programme P12). Definitions: CONVENTIONS 15.6;
//! wire format: `docs/EXPLORER_API.md`, "Expansion programme P12 — the lunar limb";
//! accuracy: `docs/ACCURACY.md`, "Lunar limb"; data: `docs/THIRD_PARTY.md`, "Lunar limb
//! profile". Display only, like every eclipse quantity (CONVENTIONS 1 and 13).
//!
//! # The data: a ring around the mean limb
//!
//! The optional `lunar-limb` pack holds LRO LOLA heights (LDEM_16, 1/16 degree, about
//! 1.9 km, above the 1737.4 km reference sphere and measured from the Moon's centre of
//! mass, as the ephemeris is) resampled by `tools/limb/build.py` onto a grid that follows
//! the **mean limb**, the great circle `x = 0` of the mean Earth/polar axis frame (x toward
//! the mean sub-Earth point, z toward the north pole). A node at **axis angle** `alpha`
//! (from the north pole toward the side that appears in the east of the sky: Watts's
//! angle) and at angular distance `delta` from the mean limb (positive toward the Earth)
//! has the unit vector `(sin delta, -sin alpha cos delta, cos alpha cos delta)`. The ring
//! spans `delta` within +-12 degrees: the libration moves the limb up to about 10 degrees
//! from the mean limb, and ground 3-4 degrees behind the tangent can still stand out.
//!
//! **Frames.** LOLA's grid is in the mean Earth/polar axis frame of DE421. The orientation
//! used here, [`crate::libration::MoonFrame::matrix`], is already in that frame: Meeus's
//! principal-axis model turned by DE440's principal-axes-to-mean-Earth rotation (78.69"
//! about y; its 67.85" about z is in Meeus's prime meridian `F + 180°`), and NAIF's
//! `MOON_ME_DE440_ME421` is aligned with DE421's mean-Earth frame to about 1 m. The
//! principal-axis frame itself is 0.029° (875 m) away: no further rotation is applied,
//! and the tests hold the profile to an independent one built with NAIF's DE440 lunar
//! orientation (0.03" rms).
//!
//! # The outline an observer sees
//!
//! For one observer and instant ([`View`]): the direction from the Moon's centre to the
//! observer (optical, physical and diurnal libration together, from
//! [`crate::libration::MoonGeometry`], the orientation when the light left the Moon), and
//! for each position angle `psi` on the sky (north through east, the ring's 1/16 degree
//! apart) the half-plane through the line of sight toward `psi`. Its trace on the Moon is a
//! great circle through the sub-observer point; a point on it at `eps` from the plane of
//! the sky (positive: away from the observer), at radius `r = 1737.4 km + h`, appears at
//! `atan(r cos eps / (D + r sin eps))` from the Moon's centre (`D` the observer's
//! distance). The **outline** `rho(psi)` is the largest such angle over the slice: the
//! point that stands out furthest against the sky, on the tangent circle, in front of it
//! or behind it. Heights are sampled every 1/16 degree along the slice, bilinearly from
//! the ring, outward from the plane of the sky until no ground in the remaining rows
//! (block maxima of 1 degree) could stand out further, and never beyond 8 degrees, where
//! the sphere has fallen 17 km below the tangent.
//!
//! # Contacts
//!
//! The Sun is a disc (959.63" at 1 au, as in `bessel.rs`) whose centre `c` is taken from
//! the same Besselian elements as the mean-limb contacts, on the observer's sky about the
//! Moon's centre; the Moon is the star-shaped region inside `rho(psi)`.
//!
//! - **External** (C1, C4): the Sun's disc touches the outline from outside,
//!   `min |rho(psi) e(psi) - c| = s`.
//! - **Total** (C2, C3): the Sun's disc is inside the outline, `max (t+(psi) - rho(psi))
//!   <= 0`, `t+` the far edge of the Sun's disc along the ray at `psi`: the last sunlight
//!   goes out, and the first returns, in the deepest valley near the contact.
//! - **Annular** (C2, C3): the outline is inside the Sun's disc, `max |rho(psi) e(psi) -
//!   c| <= s`: the highest peaks decide.
//!
//! The central phase is found by scanning around the maximum with the outline of that
//! instant, in steps no longer than the time the contact function needs to reach zero at
//! the Sun's speed on the sky (so no interval is missed, and a site near the edge of the
//! path can gain or lose totality); each end is then solved with the outline at that
//! instant, over the position angles within reach of the relief. The mean-limb contacts
//! of `local.rs` (NASA's `k1`, `k2`) are untouched; each corrected contact carries the
//! difference.
//!
//! # Baily's beads
//!
//! Near second and third contact the Sun's limb and the Moon's run nearly parallel, and
//! sunlight comes through the valleys. A bead is a valley of the light margin (`t+ -
//! rho` for a total eclipse, `s - |rho e - c|` for an annular one) that stands at least
//! 0.1" above its neighbours; its instant is when that margin crosses zero, linearly in
//! time from the contact. At 1.9 km the valleys are coarser than the real ones (hundreds
//! of metres), so the beads are **approximate**: the main valleys and their order, not
//! bead-level fidelity.

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_ephemeris::EphemerisError;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::{Site, WGS84_A_KM};

use super::bessel::{Frame, K_PENUMBRA, K_UMBRA, SolarElements, sun_radius_earth_radii};
use super::local::{
    LocalEventKind, LocalType, SUN_RISE_SET_ALT_DEG, SolarLocalRaw, site_vector, solar_contacts,
    sun_horizontal,
};
use crate::libration::{
    MoonGeometry, Selenographic, Vec3, apply, dot, norm, north_east, position_angle_deg, scale,
    sub, unit,
};

/// The payload's magic (the pack's own format inside the common header).
pub const PAYLOAD_MAGIC: &[u8; 4] = b"LIMB";
/// The payload format this build reads.
pub const PAYLOAD_FORMAT: u16 = 1;
/// The pack's name in the registry and in its file name.
pub const PACK_NAME: &str = "lunar-limb";

/// Seconds per hour: the Besselian elements' time unit is the hour.
const H: f64 = 3600.0;
/// Radians per arcsecond.
const ARCSEC: f64 = std::f64::consts::PI / 648_000.0;
/// How far a slice is followed from the plane of the sky at most, degrees: at 8 degrees
/// the sphere has fallen 17 km below the tangent line, more than any relief on the Moon.
const SLICE_MAX_DEG: f64 = 8.0;
/// Rows per block of the pruning bound (1 degree at the pack's step).
const BLOCK_ROWS: usize = 16;
/// Columns either side over which a block maximum is taken: a slice drifts in axis angle
/// by at most `atan(tan 8° sin L)` across its 8 degrees (L the total libration, at most
/// about 11 degrees: 1.5 degrees, 25 columns); the bound is dropped for a slice that
/// could drift further.
const DRIFT_COLUMNS: usize = 28;
/// The most row blocks a ring may have (the parser refuses more).
const MAX_BLOCKS: usize = 64;
/// Half-width of the position angles examined for an external contact, degrees: two
/// discs of 960" touching externally part by `960" theta^2`, so relief of 7" can only
/// matter within 5 degrees of the line of centres.
const EXTERNAL_HALF_WIDTH_DEG: f64 = 12.0;
/// Extra half-width added to a central contact's window, degrees.
const CENTRAL_MARGIN_DEG: f64 = 4.0;
/// Shortest step of the scan for the central phase, hours (a quarter of a second).
const MIN_SCAN_STEP_H: f64 = 0.25 / H;
/// Bead prominence: a valley counts as its own bead when the light margin between it and
/// every deeper valley dips at least this far, arcseconds (about 175 m at the limb).
const BEAD_PROMINENCE_ARCSEC: f64 = 0.1;
/// Beads are reported within this many seconds of second and third contact.
const BEAD_WINDOW_S: f64 = 15.0;
/// At most this many beads per contact (the last to go out, the first to come on).
const MAX_BEADS: usize = 8;

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/// The lunar-limb pack's heights, decoded (see the module documentation).
#[derive(Debug, Clone, PartialEq)]
pub struct LimbRing {
    version: String,
    source: String,
    reference_radius_km: f64,
    quantum_m: f64,
    step_deg: f64,
    delta_min_deg: f64,
    n_alpha: usize,
    n_delta: usize,
    /// Quantised heights, column after column: `q[j * n_delta + i]`.
    q: Vec<i16>,
    n_blocks: usize,
    /// `block_max[j * n_blocks + b]`: the highest node of row block `b` within
    /// `DRIFT_COLUMNS` columns of column `j`, quanta.
    block_max: Vec<i16>,
    max_q: i16,
    min_q: i16,
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], String> {
        if self.b.len() - self.at < n {
            return Err(format!("the data is cut short in its {what}"));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u16(&mut self, what: &str) -> Result<u16, String> {
        let s = self.take(2, what)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self, what: &str) -> Result<u32, String> {
        let s = self.take(4, what)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn f64(&mut self, what: &str) -> Result<f64, String> {
        let s = self.take(8, what)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        let v = f64::from_le_bytes(a);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(format!("its {what} is not a number"))
        }
    }
    fn str8(&mut self, what: &str) -> Result<String, String> {
        let n = self.take(1, what)?[0] as usize;
        let s = self.take(n, what)?;
        String::from_utf8(s.to_vec()).map_err(|_| format!("its {what} is not UTF-8"))
    }
}

impl LimbRing {
    /// Parse and decode a `lunar-limb` payload (the bytes inside the common pack header).
    /// Every inconsistency is refused with its own sentence; nothing is kept from a
    /// payload that fails.
    pub fn parse(payload: &[u8]) -> Result<LimbRing, String> {
        let mut r = Reader { b: payload, at: 0 };
        if r.take(4, "magic")? != PAYLOAD_MAGIC {
            return Err("this is not lunar-limb data (no LIMB at the start)".into());
        }
        let format = r.u16("format")?;
        if format != PAYLOAD_FORMAT {
            return Err(format!(
                "lunar-limb data format {format}: this build reads format {PAYLOAD_FORMAT}"
            ));
        }
        let version = r.str8("version")?;
        let source = r.str8("source")?;
        let reference_radius_km = r.f64("reference radius")?;
        let quantum_m = r.f64("height quantum")?;
        let step_deg = r.f64("grid step")?;
        let delta_min_deg = r.f64("ring edge")?;
        let n_alpha = usize::from(r.u16("column count")?);
        let n_delta = usize::from(r.u16("row count")?);
        let body_len = r.u32("body length")? as usize;
        if !(1700.0..1780.0).contains(&reference_radius_km) {
            return Err(format!(
                "a reference radius of {reference_radius_km} km is not the Moon's"
            ));
        }
        if !(0.001..=100.0).contains(&quantum_m) {
            return Err(format!(
                "a height quantum of {quantum_m} m is not plausible"
            ));
        }
        if step_deg <= 0.0 || ((n_alpha as f64) * step_deg - 360.0).abs() > 1e-9 {
            return Err(format!(
                "{n_alpha} columns of {step_deg} degrees do not go once around the limb"
            ));
        }
        let span = n_delta as f64 * step_deg;
        let n_blocks = n_delta.div_ceil(BLOCK_ROWS);
        if n_delta < 2
            || delta_min_deg > 0.0
            || delta_min_deg + span < 0.0
            || span > 60.0
            || n_blocks > MAX_BLOCKS
        {
            return Err(format!(
                "{n_delta} rows from {delta_min_deg} degrees do not straddle the mean limb"
            ));
        }
        if payload.len() - r.at != body_len {
            return Err(format!(
                "the height data should be {body_len} bytes, the payload holds {}",
                payload.len() - r.at
            ));
        }
        let q = decode_body(&payload[r.at..], n_alpha, n_delta)?;
        let max_q = q.iter().copied().max().unwrap_or(0);
        let min_q = q.iter().copied().min().unwrap_or(0);
        let (max_m, min_m) = (f64::from(max_q) * quantum_m, f64::from(min_q) * quantum_m);
        if max_m > 25_000.0 || min_m < -25_000.0 {
            return Err(format!(
                "heights from {min_m} m to {max_m} m are not the Moon's"
            ));
        }
        let block_max = block_maxima(&q, n_alpha, n_delta, n_blocks);
        Ok(LimbRing {
            version,
            source,
            reference_radius_km,
            quantum_m,
            step_deg,
            delta_min_deg,
            n_alpha,
            n_delta,
            q,
            n_blocks,
            block_max,
            max_q,
            min_q,
        })
    }

    /// The data's version (the date the ring was built).
    pub fn version(&self) -> &str {
        &self.version
    }

    /// The topography it was built from.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The sphere heights are measured from, km (LOLA's 1737.4).
    pub fn reference_radius_km(&self) -> f64 {
        self.reference_radius_km
    }

    /// The grid step, degrees (1/16).
    pub fn step_deg(&self) -> f64 {
        self.step_deg
    }

    /// The ring's extent from the mean limb, degrees (`-12, 12`).
    pub fn delta_range_deg(&self) -> (f64, f64) {
        (
            self.delta_min_deg,
            self.delta_min_deg + self.n_delta as f64 * self.step_deg,
        )
    }

    /// Columns (axis angles) and rows (distances from the mean limb).
    pub fn shape(&self) -> (usize, usize) {
        (self.n_alpha, self.n_delta)
    }

    /// Lowest and highest ground in the ring, m.
    pub fn height_range_m(&self) -> (f64, f64) {
        (
            f64::from(self.min_q) * self.quantum_m,
            f64::from(self.max_q) * self.quantum_m,
        )
    }

    /// Height of node `(j, i)` (axis angle `(j + 1/2) step`, `delta_min + (i + 1/2)
    /// step`), m.
    pub fn node_height_m(&self, j: usize, i: usize) -> f64 {
        f64::from(self.q[j * self.n_delta + i]) * self.quantum_m
    }

    /// Height at axis angle `alpha_deg` and distance `delta_deg` from the mean limb,
    /// bilinear between the nodes, m; `None` outside the ring's rows.
    pub fn height_m(&self, alpha_deg: f64, delta_deg: f64) -> Option<f64> {
        let fa = alpha_deg.rem_euclid(360.0) / self.step_deg - 0.5;
        let fd = (delta_deg - self.delta_min_deg) / self.step_deg - 0.5;
        self.bilinear_q(fa, fd).map(|v| v * self.quantum_m)
    }

    /// Height at a selenographic place (mean Earth/polar axis frame, east longitude), m,
    /// when the place lies inside the ring.
    pub fn height_at_m(&self, s: &Selenographic) -> Option<f64> {
        let (alpha, delta) = ring_coordinates(s.unit());
        self.height_m(alpha.to_degrees(), delta.to_degrees())
    }

    /// Bilinear in quantum units at fractional node coordinates (column, row); `None`
    /// outside the rows.
    #[inline]
    fn bilinear_q(&self, fa: f64, fd: f64) -> Option<f64> {
        let max_row = (self.n_delta - 1) as f64;
        if !(0.0..=max_row).contains(&fd) {
            return None;
        }
        let i0 = (fd as usize).min(self.n_delta - 2);
        let td = fd - i0 as f64;
        let n = self.n_alpha as f64;
        let fa = if (0.0..n).contains(&fa) {
            fa
        } else {
            fa.rem_euclid(n)
        };
        let j0 = (fa as usize).min(self.n_alpha - 1);
        let ta = fa - j0 as f64;
        let j1 = if j0 + 1 == self.n_alpha { 0 } else { j0 + 1 };
        let c0 = j0 * self.n_delta + i0;
        let c1 = j1 * self.n_delta + i0;
        let q = &self.q;
        let a0 = f64::from(q[c0]) + (f64::from(q[c0 + 1]) - f64::from(q[c0])) * td;
        let a1 = f64::from(q[c1]) + (f64::from(q[c1 + 1]) - f64::from(q[c1])) * td;
        Some(a0 + (a1 - a0) * ta)
    }
}

/// Decode the body: planar-prediction residuals, one signed byte each, or the byte 0x80
/// followed by a little-endian i16 (`tools/limb/ring.py`).
fn decode_body(body: &[u8], n_alpha: usize, n_delta: usize) -> Result<Vec<i16>, String> {
    let n = n_alpha * n_delta;
    let mut q = vec![0i16; n];
    let mut at = 0usize;
    let next = |at: &mut usize, done: usize| -> Result<i32, String> {
        let Some(&b) = body.get(*at) else {
            return Err(format!("the height data ends after {done} of {n} heights"));
        };
        if b == 0x80 {
            let Some(pair) = body.get(*at + 1..*at + 3) else {
                return Err("the height data ends inside an escape".into());
            };
            *at += 3;
            Ok(i32::from(i16::from_le_bytes([pair[0], pair[1]])))
        } else {
            *at += 1;
            Ok(i32::from(b as i8))
        }
    };
    let store = |v: i32| {
        i16::try_from(v).map_err(|_| format!("a height of {v} quanta does not fit the ring"))
    };
    // The first column: differences down the column.
    let mut prev = 0i32;
    for (i, slot) in q[..n_delta].iter_mut().enumerate() {
        prev += next(&mut at, i)?;
        *slot = store(prev)?;
    }
    for j in 1..n_alpha {
        let (done, rest) = q.split_at_mut(j * n_delta);
        let left = &done[(j - 1) * n_delta..];
        let col = &mut rest[..n_delta];
        let mut up = i32::from(left[0]) + next(&mut at, j * n_delta)?;
        col[0] = store(up)?;
        for i in 1..n_delta {
            let predicted = up + i32::from(left[i]) - i32::from(left[i - 1]);
            up = predicted + next(&mut at, j * n_delta + i)?;
            col[i] = store(up)?;
        }
    }
    if at != body.len() {
        return Err(format!("{} bytes follow the last height", body.len() - at));
    }
    Ok(q)
}

/// The pruning bound's table: per column and row block, the highest node of the block
/// within `DRIFT_COLUMNS` columns either side (a circular sliding maximum, van Herk -
/// Gil - Werman, linear in the number of columns).
fn block_maxima(q: &[i16], n_alpha: usize, n_delta: usize, n_blocks: usize) -> Vec<i16> {
    let w = (2 * DRIFT_COLUMNS + 1).min(n_alpha);
    let half = w / 2;
    let mut out = vec![i16::MIN; n_alpha * n_blocks];
    let ext_len = n_alpha + w - 1;
    let mut a = vec![i16::MIN; n_alpha];
    let mut e = vec![i16::MIN; ext_len];
    let mut g = vec![i16::MIN; ext_len];
    let mut h = vec![i16::MIN; ext_len];
    for b in 0..n_blocks {
        let rows = b * BLOCK_ROWS..((b + 1) * BLOCK_ROWS).min(n_delta);
        for (j, slot) in a.iter_mut().enumerate() {
            *slot = q[j * n_delta + rows.start..j * n_delta + rows.end]
                .iter()
                .copied()
                .max()
                .unwrap_or(i16::MIN);
        }
        // e[k] = a[(k - half) mod n]: window [j - half, j + half] is e[j .. j + w).
        for (k, slot) in e.iter_mut().enumerate() {
            *slot = a[(k + n_alpha - half % n_alpha) % n_alpha];
        }
        for k in 0..ext_len {
            g[k] = if k % w == 0 { e[k] } else { g[k - 1].max(e[k]) };
        }
        for k in (0..ext_len).rev() {
            h[k] = if k % w == w - 1 || k == ext_len - 1 {
                e[k]
            } else {
                h[k + 1].max(e[k])
            };
        }
        for j in 0..n_alpha {
            out[j * n_blocks + b] = h[j].max(g[j + w - 1]);
        }
    }
    out
}

/// Axis angle and distance from the mean limb (radians) of a unit vector in the mean
/// Earth/polar axis frame; the axis angle in `[0, 2 pi)`.
pub fn ring_coordinates(u: [f64; 3]) -> (f64, f64) {
    let delta = u[0].clamp(-1.0, 1.0).asin();
    let alpha = (-u[1]).atan2(u[2]).rem_euclid(std::f64::consts::TAU);
    (alpha, delta)
}

// ---------------------------------------------------------------------------
// The outline one observer sees
// ---------------------------------------------------------------------------

/// How the Moon is turned toward one observer at one instant, in the Moon's own frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct View {
    pub jd_utc: f64,
    /// From the Moon's centre toward the observer (selenographic, unit).
    s: Vec3,
    /// Celestial north and east at the Moon's direction (selenographic, unit).
    n: Vec3,
    e: Vec3,
    /// Observer to the Moon's centre, km.
    pub distance_km: f64,
    /// The point at the centre of the disc (the topocentric libration).
    pub sub_observer: Selenographic,
    /// Position angle of the Moon's north pole, degrees.
    pub axis_position_angle_deg: f64,
}

impl View {
    pub(crate) fn of(g: &MoonGeometry) -> View {
        let to_observer = sub(g.observer_km, g.moon_km);
        let distance_km = norm(to_observer);
        let u = g.toward_moon();
        let (n, e) = north_east(u);
        let m = &g.frame.matrix;
        View {
            jd_utc: g.jd_utc,
            s: unit(apply(m, scale(to_observer, 1.0 / distance_km))),
            n: apply(m, n),
            e: apply(m, e),
            distance_km,
            sub_observer: g.frame.selenographic(to_observer),
            axis_position_angle_deg: position_angle_deg(u, g.frame.pole()),
        }
    }
}

/// `asin` for the small arguments of the ring (its rows reach sin 12° = 0.208): to 1e-10
/// rad up to |x| = 0.22, the library's beyond.
#[inline]
fn small_asin(x: f64) -> f64 {
    if x.abs() > 0.22 {
        return x.asin();
    }
    let x2 = x * x;
    x * (1.0
        + x2 * (1.0 / 6.0
            + x2 * (3.0 / 40.0 + x2 * (5.0 / 112.0 + x2 * (35.0 / 1152.0 + x2 * (63.0 / 2816.0))))))
}

/// The slicing of one view: what every slice shares.
struct Slicer<'a> {
    ring: &'a LimbRing,
    v: &'a View,
    /// `(sin, cos)` of `m` steps, `m = 0 ..= m_max`.
    trig: Vec<(f64, f64)>,
    r0: f64,
    km_per_q: f64,
    step_rad: f64,
    drift_limit_rad: f64,
}

/// The highest point of one slice: `a = r cos eps`, `b = r sin eps` (km), so that at a
/// distance `D` it appears `atan(a / (D + b))` from the Moon's centre. `a` is NaN when
/// the slice's tangent point is outside the ring.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Crest {
    pub a: f64,
    pub b: f64,
    /// Where it lies from the plane of the sky along the slice, degrees (positive:
    /// behind, away from the observer).
    pub eps_deg: f64,
}

impl<'a> Slicer<'a> {
    fn new(ring: &'a LimbRing, v: &'a View) -> Self {
        let step_rad = ring.step_deg.to_radians();
        let m_max = (SLICE_MAX_DEG / ring.step_deg).ceil() as usize;
        Slicer {
            ring,
            v,
            trig: (0..=m_max)
                .map(|m| (m as f64 * step_rad).sin_cos())
                .collect(),
            r0: ring.reference_radius_km,
            km_per_q: ring.quantum_m / 1000.0,
            step_rad,
            drift_limit_rad: (DRIFT_COLUMNS - 2) as f64 * step_rad,
        }
    }

    /// The crest of the slice at position angle `psi` (radians), and whether the slice
    /// ran off the ring before it could stop.
    fn slice(&self, psi: f64) -> (Crest, bool) {
        let ring = self.ring;
        let v = self.v;
        let (sp, cp) = psi.sin_cos();
        let q = [
            cp * v.n[0] + sp * v.e[0],
            cp * v.n[1] + sp * v.e[1],
            cp * v.n[2] + sp * v.e[2],
        ];
        let s = v.s;
        let d = v.distance_km;
        let step = ring.step_deg;
        let (alpha0, _) = ring_coordinates(q);
        let fa0 = alpha0.to_degrees() / step - 0.5;
        // Axis angle along the slice: alpha = atan2(-P_y, P_z), and (-P_y, P_z) is
        // cos eps v0 + sin eps w; measured from the second component toward the first,
        // the turn from v0 is atan(sin eps (v0[1] w[0] - v0[0] w[1]) / (cos eps |v0|^2 +
        // sin eps v0.w)).
        let v0 = [-q[1], q[2]];
        let w = [s[1], -s[2]];
        let v0v0 = v0[0] * v0[0] + v0[1] * v0[1];
        let cross = v0[1] * w[0] - v0[0] * w[1];
        let dotw = v0[0] * w[0] + v0[1] * w[1];
        let inv_step_rad = 1.0 / self.step_rad;
        // The row bounds hold only while the slice stays within the block maxima's
        // columns: check the furthest drift once.
        let (se_far, ce_far) = *self.trig.last().unwrap_or(&(0.0, 1.0));
        let t_far = se_far * cross.abs() / (ce_far * v0v0 - se_far * dotw.abs()).max(1e-9);
        let pruned_by_blocks = t_far.atan() <= self.drift_limit_rad;
        let nb = ring.n_blocks;
        let mut prefix = [i16::MIN; MAX_BLOCKS];
        let mut suffix = [i16::MIN; MAX_BLOCKS];
        if pruned_by_blocks {
            let col = ((alpha0.to_degrees() / step) as usize) % ring.n_alpha;
            let blocks = &ring.block_max[col * nb..(col + 1) * nb];
            let mut m = i16::MIN;
            for (b, &x) in blocks.iter().enumerate() {
                m = m.max(x);
                prefix[b] = m;
            }
            let mut m = i16::MIN;
            for (b, &x) in blocks.iter().enumerate().rev() {
                m = m.max(x);
                suffix[b] = m;
            }
        }
        let last_block = nb - 1;
        let mut best = Crest {
            a: f64::NAN,
            b: 0.0,
            eps_deg: 0.0,
        };
        let mut best_ratio = f64::NEG_INFINITY;
        let mut truncated = false;
        // Side 0 goes behind the limb (away from the observer, rows decreasing), side 1
        // in front of it (rows increasing).
        let mut alive = [true, true];
        let m_max = self.trig.len() - 1;
        for m in 0..=m_max {
            let (se_abs, ce) = self.trig[m];
            for (side, live) in alive.iter_mut().enumerate() {
                if !*live || (m == 0 && side == 1) {
                    continue;
                }
                let se = if side == 0 { se_abs } else { -se_abs };
                let px = ce * q[0] - se * s[0];
                let delta = small_asin(px);
                let t = se * cross / (ce * v0v0 + se * dotw);
                let dalpha = t * (1.0 - t * t * (1.0 / 3.0 - t * t * 0.2));
                let fa = fa0 + dalpha * inv_step_rad;
                let fd = (delta.to_degrees() - ring.delta_min_deg) / step - 0.5;
                let Some(hq) = ring.bilinear_q(fa, fd) else {
                    truncated = true;
                    *live = false;
                    continue;
                };
                let r = self.r0 + hq * self.km_per_q;
                let (a, b) = (r * ce, r * se);
                let ratio = a / (d + b);
                if ratio > best_ratio {
                    best_ratio = ratio;
                    best = Crest {
                        a,
                        b,
                        eps_deg: if side == 0 { 1.0 } else { -1.0 } * m as f64 * step,
                    };
                }
                if m == m_max {
                    continue;
                }
                // The rest of this side: rows beyond this sample (its bilinear cell
                // included), at least one more step out.
                let hb = if pruned_by_blocks {
                    let row = fd.max(0.0) as usize;
                    if side == 0 {
                        prefix[((row + 1) / BLOCK_ROWS).min(last_block)]
                    } else {
                        suffix[(row / BLOCK_ROWS).min(last_block)]
                    }
                } else {
                    ring.max_q
                };
                let rb = self.r0 + f64::from(hb) * self.km_per_q;
                let (se_n, ce_n) = self.trig[m + 1];
                let bound = if side == 0 {
                    rb * ce_n / (d + rb * se_n)
                } else if se_n * d >= rb {
                    rb * ce_n / (d - rb * se_n)
                } else {
                    rb / (d * d - rb * rb).sqrt()
                };
                if bound <= best_ratio {
                    *live = false;
                }
            }
            if alive.iter().all(|live| !live) {
                break;
            }
        }
        (best, truncated)
    }
}

/// The Moon's outline for one observer at one instant, over some position-angle bins
/// (bin `k` at `psi = k step`, the ring's step).
#[derive(Debug, Clone)]
pub(crate) struct Outline {
    pub view: View,
    pub step_rad: f64,
    /// The bins computed, in increasing position angle around the window (wrapping).
    pub bins: Vec<usize>,
    pub crests: Vec<Crest>,
    /// Some slice ran off the ring before it could stop (ground beyond the ring's
    /// +-12 degrees might have stood out; never seen for an eclipse of 1550-2650).
    pub truncated: bool,
}

impl Outline {
    /// Position angle of bin `k`, radians.
    pub(crate) fn psi(&self, k: usize) -> f64 {
        k as f64 * self.step_rad
    }

    /// The outline as angles for an observer `distance_km` from the Moon.
    pub(crate) fn table(&self, distance_km: f64) -> Table {
        let n = self.bins.len();
        let mut t = Table {
            bins: self.bins.clone(),
            sin: Vec::with_capacity(n),
            cos: Vec::with_capacity(n),
            rho: Vec::with_capacity(n),
            distance_km,
        };
        for (&k, c) in self.bins.iter().zip(&self.crests) {
            let (sp, cp) = self.psi(k).sin_cos();
            t.sin.push(sp);
            t.cos.push(cp);
            t.rho.push((c.a / (distance_km + c.b)).atan());
        }
        t
    }
}

/// An outline as angles: per bin, `sin psi`, `cos psi` and `rho` (radians; NaN where the
/// ring does not reach) at `distance_km`.
#[derive(Debug, Clone)]
pub(crate) struct Table {
    pub bins: Vec<usize>,
    sin: Vec<f64>,
    cos: Vec<f64>,
    pub rho: Vec<f64>,
    pub distance_km: f64,
}

/// The outline of `v` over `bins` (every bin of the ring when `None`).
pub(crate) fn outline(ring: &LimbRing, v: View, bins: Option<Vec<usize>>) -> Outline {
    let bins = bins.unwrap_or_else(|| (0..ring.n_alpha).collect());
    let slicer = Slicer::new(ring, &v);
    let mut truncated = false;
    let crests = bins
        .iter()
        .map(|&k| {
            let (c, t) = slicer.slice(k as f64 * slicer.step_rad);
            truncated |= t;
            c
        })
        .collect();
    Outline {
        view: v,
        step_rad: slicer.step_rad,
        bins,
        crests,
        truncated,
    }
}

/// Bins within `half_width` radians of `psi`, in order around the window (all of them,
/// from 0, when that covers the circle).
pub(crate) fn window(n: usize, step_rad: f64, psi: f64, half_width: f64) -> Vec<usize> {
    let h = (half_width / step_rad).ceil() as i64;
    if half_width >= std::f64::consts::PI || 2 * h + 1 >= n as i64 {
        return (0..n).collect();
    }
    let c = (psi.rem_euclid(std::f64::consts::TAU) / step_rad).round() as i64;
    (c - h..=c + h)
        .map(|k| k.rem_euclid(n as i64) as usize)
        .collect()
}

// ---------------------------------------------------------------------------
// The Sun against the outline
// ---------------------------------------------------------------------------

/// The Sun and the Moon on the observer's sky at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Sky {
    /// The Sun's centre from the Moon's, toward celestial east and north, radians of arc
    /// (azimuthal equidistant about the Moon's centre).
    pub c: [f64; 2],
    /// The Sun's semidiameter, rad.
    pub s: f64,
    /// Observer to the Moon's centre, km.
    pub distance_km: f64,
    /// The mean-limb Moon (NASA's `k1` and `k2`), rad.
    pub rho_k1: f64,
    pub rho_k2: f64,
}

/// The Sun's centre from the Moon's on the sky seen along `um` toward the Moon, `us`
/// toward the Sun (unit vectors in a frame whose z axis is the celestial pole of date).
fn offset(um: Vec3, us: Vec3) -> [f64; 2] {
    let (n, east) = north_east(um);
    let cr = [
        um[1] * us[2] - um[2] * us[1],
        um[2] * us[0] - um[0] * us[2],
        um[0] * us[1] - um[1] * us[0],
    ];
    let theta = norm(cr).atan2(dot(um, us));
    let (ce, cn) = (dot(us, east), dot(us, n));
    let h = ce.hypot(cn);
    if h > 0.0 {
        [theta * ce / h, theta * cn / h]
    } else {
        [0.0, 0.0]
    }
}

/// [`Sky`] at `t` hours for an observer at Earth-fixed `p` (Earth radii), from the
/// Besselian elements: the geometry of the mean-limb contacts.
pub(crate) fn sky_at(el: &SolarElements, p: Vec3, t: f64) -> Sky {
    let e = el.at(t);
    let f = Frame::new(e.d, e.mu);
    let sec1 = e.tan_f1.hypot(1.0);
    // l1 = zm tan f1 + k1 sec f1, and sin f1 = (R_sun + k1) / G.
    let zm = (e.l1 - K_PENUMBRA * sec1) / e.tan_f1;
    let g = (sun_radius_earth_radii() + K_PENUMBRA) * sec1 / e.tan_f1;
    let moon = [
        e.x * f.x[0] + e.y * f.y[0] + zm * f.z[0],
        e.x * f.x[1] + e.y * f.y[1] + zm * f.z[1],
        e.x * f.x[2] + e.y * f.y[2] + zm * f.z[2],
    ];
    let sun = [
        moon[0] + g * f.z[0],
        moon[1] + g * f.z[1],
        moon[2] + g * f.z[2],
    ];
    let to_moon = sub(moon, p);
    let to_sun = sub(sun, p);
    let (dm, ds) = (norm(to_moon), norm(to_sun));
    Sky {
        c: offset(scale(to_moon, 1.0 / dm), scale(to_sun, 1.0 / ds)),
        s: (sun_radius_earth_radii() / ds).asin(),
        distance_km: dm * WGS84_A_KM,
        rho_k1: (K_PENUMBRA / dm).asin(),
        rho_k2: (K_UMBRA / dm).asin(),
    }
}

/// [`Sky`] from the ephemeris directly, for an outline at any instant.
pub(crate) fn sky_of(g: &MoonGeometry) -> Sky {
    let to_moon = g.line_of_sight_km();
    let to_sun = sub(g.sun_km, g.observer_km);
    let (dm, ds) = (norm(to_moon), norm(to_sun));
    Sky {
        c: offset(scale(to_moon, 1.0 / dm), scale(to_sun, 1.0 / ds)),
        s: (sun_radius_earth_radii() * WGS84_A_KM / ds).asin(),
        distance_km: dm,
        rho_k1: (K_PENUMBRA * WGS84_A_KM / dm).asin(),
        rho_k2: (K_UMBRA * WGS84_A_KM / dm).asin(),
    }
}

/// Which contact condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Condition {
    /// C1 / C4: the discs touch from outside.
    External,
    /// C2 / C3 of a total eclipse: the Sun's disc inside the outline.
    Total,
    /// C2 / C3 of an annular eclipse: the outline inside the Sun's disc.
    Annular,
}

/// The contact function on `tab` (radians of arc; zero at the contact) and the index of
/// the deciding bin in the table. External: positive while the discs are apart. Total
/// and annular: negative while the central phase is on. `None` when no bin applies.
pub(crate) fn condition(tab: &Table, sky: &Sky, cond: Condition) -> Option<(f64, usize)> {
    let (cx, cy) = (sky.c[0], sky.c[1]);
    let s = sky.s;
    // The outline's angles scale as 1 / (D + b), b << D: rescale to this instant.
    let scale = tab.distance_km / sky.distance_km;
    let mut best = f64::NEG_INFINITY;
    let mut at = usize::MAX;
    match cond {
        Condition::External => {
            // Maximise -(distance - s) (the nearest outline point).
            for i in 0..tab.rho.len() {
                let rho = tab.rho[i] * scale;
                let (dx, dy) = (rho * tab.sin[i] - cx, rho * tab.cos[i] - cy);
                let v = s - dx.hypot(dy);
                if v > best {
                    best = v;
                    at = i;
                }
            }
            (at != usize::MAX).then_some((-best, at))
        }
        Condition::Total => {
            for i in 0..tab.rho.len() {
                let rho = tab.rho[i] * scale;
                let along = cx * tab.sin[i] + cy * tab.cos[i];
                let across = cx * tab.cos[i] - cy * tab.sin[i];
                let disc = s * s - across * across;
                if disc < 0.0 {
                    continue;
                }
                let t_plus = along + disc.sqrt();
                if t_plus < 0.0 {
                    continue;
                }
                let v = t_plus - rho;
                if v > best {
                    best = v;
                    at = i;
                }
            }
            (at != usize::MAX).then_some((best, at))
        }
        Condition::Annular => {
            for i in 0..tab.rho.len() {
                let rho = tab.rho[i] * scale;
                let (dx, dy) = (rho * tab.sin[i] - cx, rho * tab.cos[i] - cy);
                let v = dx.hypot(dy) - s;
                if v > best {
                    best = v;
                    at = i;
                }
            }
            (at != usize::MAX).then_some((best, at))
        }
    }
}

/// The light margin at table index `i` (positive: sunlight passes), radians: the Sun's
/// far edge beyond the outline along the ray (total), or the outline point's depth
/// inside the Sun's disc (annular).
fn light_margin(tab: &Table, i: usize, sky: &Sky, cond: Condition) -> Option<f64> {
    let rho = tab.rho[i] * tab.distance_km / sky.distance_km;
    let (cx, cy) = (sky.c[0], sky.c[1]);
    match cond {
        Condition::Total => {
            let along = cx * tab.sin[i] + cy * tab.cos[i];
            let across = cx * tab.cos[i] - cy * tab.sin[i];
            let disc = sky.s * sky.s - across * across;
            (disc >= 0.0).then(|| along + disc.sqrt() - rho)
        }
        Condition::Annular => {
            let (dx, dy) = (rho * tab.sin[i] - cx, rho * tab.cos[i] - cy);
            Some(sky.s - dx.hypot(dy))
        }
        Condition::External => None,
    }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// One limb-corrected contact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimbContact {
    /// `c1`, `c2`, `c3` or `c4`.
    pub kind: LocalEventKind,
    pub jd_utc: f64,
    pub utc: String,
    /// The mean-limb instant this corrects, and the correction (limb minus mean), s;
    /// `null` when the mean limb has no such contact (a central phase gained at the
    /// edge of the path).
    pub mean_jd_utc: Option<f64>,
    pub correction_s: Option<f64>,
    /// Where the limbs meet on the Sun's disc, from celestial north through east (as the
    /// mean-limb events: the point of the Moon's limb, measured from the Sun's centre)
    /// and from the zenith.
    pub position_angle_deg: f64,
    pub vertex_angle_deg: f64,
    /// The same point from the Moon's centre (the profile's position angle), and the
    /// profile's height there above the 1737.4 km sphere, arcseconds.
    pub limb_position_angle_deg: f64,
    pub limb_height_arcsec: f64,
    /// The Sun at that instant (CONVENTIONS 13.2), and whether it is up (13.3).
    pub alt_deg: f64,
    pub az_deg: f64,
    pub visible: bool,
    /// The Sun's disc against the profile at that instant: its centre from the Moon's
    /// (east, north) and its semidiameter, arcseconds.
    pub sun_offset_east_arcsec: f64,
    pub sun_offset_north_arcsec: f64,
    pub sun_radius_arcsec: f64,
}

/// One approximate Baily's bead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bead {
    /// `c2` (goes out before second contact) or `c3` (comes on after third contact).
    pub contact: LocalEventKind,
    pub jd_utc: f64,
    pub utc: String,
    /// Before second contact negative, after third contact positive.
    pub seconds_from_contact: f64,
    /// Where on the Sun's disc (from its centre, north through east) and from the zenith.
    pub position_angle_deg: f64,
    pub vertex_angle_deg: f64,
    /// The valley on the Moon's limb, from the Moon's centre, and its height, arcsec.
    pub limb_position_angle_deg: f64,
    pub limb_height_arcsec: f64,
}

/// The outline for drawing, at the instant of maximum eclipse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimbProfile {
    pub jd_utc: f64,
    pub utc: String,
    /// Bin `k` is at position angle `start_deg + k step_deg` on the sky (from the
    /// Moon's centre, celestial north through east).
    pub start_deg: f64,
    pub step_deg: f64,
    /// Height of the outline above the 1737.4 km sphere as seen from here, arcseconds,
    /// to 0.001"; `null` where the ring does not reach.
    pub height_arcsec: Vec<Option<f64>>,
    pub reference_radius_km: f64,
    /// The 1737.4 km sphere's semidiameter as seen here, arcseconds.
    pub reference_radius_arcsec: f64,
    /// The mean-limb Moon of the other results (NASA's `k1`, `k2`) against it, arcsec.
    pub mean_limb_k1_arcsec: f64,
    pub mean_limb_k2_arcsec: f64,
    /// The Sun: its semidiameter and its centre from the Moon's (east, north), arcsec.
    pub sun_radius_arcsec: f64,
    pub sun_offset_east_arcsec: f64,
    pub sun_offset_north_arcsec: f64,
    /// The Moon's north pole on the sky, and the zenith (parallactic angle), degrees.
    pub axis_position_angle_deg: f64,
    pub parallactic_angle_deg: f64,
    /// The topocentric libration (the point at the centre of the disc), degrees.
    pub libration_lon_deg: f64,
    pub libration_lat_deg: f64,
    pub moon_distance_km: f64,
    /// Some slice reached the edge of the ring's +-12 degrees before the ground beyond
    /// could be ruled out (never for an eclipse of 1550-2650; a warning if it happens).
    pub ring_truncated: bool,
}

/// The limb-corrected local circumstances (`options.limb`), or why there are none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolarLimb {
    /// The `lunar-limb` pack is loaded (else only `note` is filled).
    pub loaded: bool,
    pub pack_version: Option<String>,
    /// A sentence to show beside the times.
    pub note: String,
    /// The terrain's horizontal resolution, km (LDEM_16: 1.9).
    pub resolution_km: Option<f64>,
    /// Limb-corrected: may differ from the mean limb's near the edge of the path.
    pub local_type: Option<LocalType>,
    /// `c1`, `c2`, `c3`, `c4` as they occur, limb-corrected, in time order.
    pub contacts: Vec<LimbContact>,
    /// First to fourth contact, s.
    pub duration_s: Option<f64>,
    /// Second to third contact, and its difference from the mean limb's, s.
    pub central_duration_s: Option<f64>,
    pub central_duration_correction_s: Option<f64>,
    /// The central phase is broken: sunlight returns through a valley between second and
    /// third contact (a graze near the edge of the path).
    pub interrupted: bool,
    pub profile: Option<LimbProfile>,
    /// Approximate: the valleys of a 1.9 km model, before second and after third contact.
    pub beads: Vec<Bead>,
}

/// The note shown when the pack is not loaded.
pub const NOT_LOADED_NOTE: &str = "Mean limb: the Moon is taken as a smooth sphere, so second \
     and third contact can be a few seconds off. Get the Lunar limb data pack (Settings → Data \
     packs) to correct them for the Moon's mountains and valleys.";

/// The note shown with corrected contacts.
pub const LOADED_NOTE: &str = "Corrected for the Moon's mountains and valleys (LRO LOLA \
     topography, 1.9 km resolution): second and third contact within about 2 s of NASA's \
     predictions. Baily's beads are approximate: real beads shine through valleys a few \
     hundred metres wide.";

impl SolarLimb {
    /// What `options.limb` reports without the pack.
    pub fn not_loaded() -> SolarLimb {
        SolarLimb {
            loaded: false,
            pack_version: None,
            note: NOT_LOADED_NOTE.to_string(),
            resolution_km: None,
            local_type: None,
            contacts: Vec::new(),
            duration_s: None,
            central_duration_s: None,
            central_duration_correction_s: None,
            interrupted: false,
            profile: None,
            beads: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Everything the correction needs for one eclipse and one observer.
struct Ctx<'a> {
    ring: &'a LimbRing,
    el: &'a SolarElements,
    sun: &'a SunProvider,
    moon: &'a MoonProvider,
    site: &'a Site,
    p: Vec3,
}

impl Ctx<'_> {
    fn view_at(&self, t: f64) -> Result<View, EphemerisError> {
        let g = MoonGeometry::new(self.moon, self.sun, Some(self.site), self.el.jd(t))
            .map_err(|e| EphemerisError::Data(e.to_string()))?;
        Ok(View::of(&g))
    }

    fn outline_at(&self, t: f64, bins: Option<Vec<usize>>) -> Result<Outline, EphemerisError> {
        Ok(outline(self.ring, self.view_at(t)?, bins))
    }

    fn sky(&self, t: f64) -> Sky {
        sky_at(self.el, self.p, t)
    }

    /// The ring's whole relief, radians at `distance_km`.
    fn relief(&self, distance_km: f64) -> f64 {
        let (lo, hi) = self.ring.height_range_m();
        (hi - lo) / 1000.0 / distance_km
    }

    /// The Sun's speed across the Moon on the sky around `t`, rad per hour.
    fn sun_speed(&self, t: f64) -> f64 {
        let dt = 30.0 / H;
        let (a, b) = (self.sky(t - dt), self.sky(t + dt));
        (b.c[0] - a.c[0]).hypot(b.c[1] - a.c[1]) / (2.0 * dt)
    }
}

/// A root of `f` in `[a, b]` (hours) to 0.36 ms, when it is bracketed.
fn solve(f: impl FnMut(f64) -> f64, a: f64, b: f64) -> Option<f64> {
    super::cheb::root(f, a, b, super::solar::T_TOL_H)
}

/// The condition on `tab` as a function of time (NaN when no bin applies).
fn condition_at(ctx: &Ctx, tab: &Table, cond: Condition, t: f64) -> f64 {
    condition(tab, &ctx.sky(t), cond).map_or(f64::NAN, |(v, _)| v)
}

/// Solve the condition on `tab` near `t0` (hours): bracket outward in steps of 2, 6, 18,
/// 54 and 162 s and take the root nearest `t0`.
fn solve_near(ctx: &Ctx, tab: &Table, cond: Condition, t0: f64) -> Option<f64> {
    let f = |t: f64| condition_at(ctx, tab, cond, t);
    let f0 = f(t0);
    if !f0.is_finite() {
        return None;
    }
    if f0 == 0.0 {
        return Some(t0);
    }
    for w in [2.0, 6.0, 18.0, 54.0, 162.0] {
        let (lo, hi) = (t0 - w / H, t0 + w / H);
        let (flo, fhi) = (f(lo), f(hi));
        let lo_ok = flo.is_finite() && flo * f0 <= 0.0;
        let hi_ok = fhi.is_finite() && fhi * f0 <= 0.0;
        let before = if lo_ok { solve(f, lo, t0) } else { None };
        let after = if hi_ok { solve(f, t0, hi) } else { None };
        match (before, after) {
            (Some(a), Some(b)) => return Some(if t0 - a <= b - t0 { a } else { b }),
            (Some(a), None) => return Some(a),
            (None, Some(b)) => return Some(b),
            (None, None) => {}
        }
    }
    None
}

/// The central phase against the outline of the maximum, `tab`: from `a` to `b` hours in
/// steps no longer than the time the condition needs to reach zero at speed `lip` (rad
/// per hour, an upper bound on its rate), each sign change refined. `(start, end)` pairs,
/// hours; `None` for an end outside `[a, b]`.
fn central_intervals(
    ctx: &Ctx,
    tab: &Table,
    cond: Condition,
    a: f64,
    b: f64,
    lip: f64,
) -> Vec<(Option<f64>, Option<f64>)> {
    let f = |t: f64| condition_at(ctx, tab, cond, t);
    let mut out = Vec::new();
    let mut t_prev = a;
    let mut f_prev = f(a);
    let mut start: Option<Option<f64>> = (f_prev < 0.0).then_some(None);
    while t_prev < b {
        let step = if f_prev.is_finite() {
            (f_prev.abs() / lip).max(MIN_SCAN_STEP_H)
        } else {
            MIN_SCAN_STEP_H
        };
        let t = (t_prev + step).min(b);
        let ft = f(t);
        if f_prev.is_finite() && ft.is_finite() {
            if f_prev >= 0.0 && ft < 0.0 {
                start = Some(solve(f, t_prev, t));
            } else if f_prev < 0.0 && ft >= 0.0 {
                out.push((start.take().flatten(), solve(f, t_prev, t)));
            }
        }
        t_prev = t;
        f_prev = ft;
    }
    if let Some(s) = start {
        out.push((s, None));
    }
    out
}

/// The contact at `t` (hours) decided by table index `i` of `tab`.
fn contact_record(
    ctx: &Ctx,
    tab: &Table,
    kind: LocalEventKind,
    t: f64,
    i: usize,
    mean: Option<f64>,
) -> Result<LimbContact, EphemerisError> {
    let jd = ctx.el.jd(t);
    let sky = ctx.sky(t);
    let rho = tab.rho[i] * tab.distance_km / sky.distance_km;
    let (x, y) = (rho * tab.sin[i], rho * tab.cos[i]);
    let pa = (x - sky.c[0])
        .atan2(y - sky.c[1])
        .to_degrees()
        .rem_euclid(360.0);
    let hz = sun_horizontal(ctx.sun, ctx.site, jd)?;
    let reference = (ctx.ring.reference_radius_km / sky.distance_km).asin();
    Ok(LimbContact {
        kind,
        jd_utc: jd,
        utc: format_utc(jd),
        mean_jd_utc: mean.map(|m| ctx.el.jd(m)),
        correction_s: mean.map(|m| (t - m) * H),
        position_angle_deg: pa,
        vertex_angle_deg: (pa - hz.parallactic_angle_deg).rem_euclid(360.0),
        limb_position_angle_deg: (tab.bins[i] as f64 * ctx.ring.step_deg).rem_euclid(360.0),
        limb_height_arcsec: round3((rho - reference) / ARCSEC),
        alt_deg: hz.alt_deg,
        az_deg: hz.az_deg,
        visible: hz.alt_deg > SUN_RISE_SET_ALT_DEG,
        sun_offset_east_arcsec: round3(sky.c[0] / ARCSEC),
        sun_offset_north_arcsec: round3(sky.c[1] / ARCSEC),
        sun_radius_arcsec: round3(sky.s / ARCSEC),
    })
}

/// Solve an external contact near the mean-limb instant `t_mean` (hours).
fn external_contact(
    ctx: &Ctx,
    kind: LocalEventKind,
    t_mean: f64,
) -> Result<Option<LimbContact>, EphemerisError> {
    let sky = ctx.sky(t_mean);
    let psi_c = sky.c[0].atan2(sky.c[1]);
    let bins = window(
        ctx.ring.n_alpha,
        ctx.ring.step_deg.to_radians(),
        psi_c,
        EXTERNAL_HALF_WIDTH_DEG.to_radians(),
    );
    let o = ctx.outline_at(t_mean, Some(bins))?;
    let tab = o.table(o.view.distance_km);
    let Some(t) = solve_near(ctx, &tab, Condition::External, t_mean) else {
        return Ok(None);
    };
    let Some((_, i)) = condition(&tab, &ctx.sky(t), Condition::External) else {
        return Ok(None);
    };
    contact_record(ctx, &tab, kind, t, i, Some(t_mean)).map(Some)
}

/// A central contact near `t_scan` (found against the maximum's outline): solved with
/// the outline of that instant over the position angles within reach of the relief.
/// Returns the contact's time, its outline table and the deciding index.
fn central_contact(
    ctx: &Ctx,
    tab_max: &Table,
    cond: Condition,
    t_scan: f64,
) -> Result<Option<(f64, Table, usize)>, EphemerisError> {
    let sky = ctx.sky(t_scan);
    let Some((_, i0)) = condition(tab_max, &sky, cond) else {
        return Ok(None);
    };
    // The Sun's limb and the Moon's part as d (1 - cos theta) from the deciding point
    // (d the distance between the centres): only within the relief do other position
    // angles compete.
    let d = sky.c[0].hypot(sky.c[1]);
    let relief = 1.5 * ctx.relief(sky.distance_km) + 2.0 * ARCSEC;
    let half = if relief >= 2.0 * d {
        std::f64::consts::PI
    } else {
        (1.0 - relief / d).clamp(-1.0, 1.0).acos() + CENTRAL_MARGIN_DEG.to_radians()
    };
    let psi0 = tab_max.bins[i0] as f64 * ctx.ring.step_deg.to_radians();
    let bins = window(ctx.ring.n_alpha, ctx.ring.step_deg.to_radians(), psi0, half);
    let o = ctx.outline_at(t_scan, Some(bins))?;
    let tab = o.table(o.view.distance_km);
    let Some(t) = solve_near(ctx, &tab, cond, t_scan) else {
        return Ok(None);
    };
    let Some((_, i)) = condition(&tab, &ctx.sky(t), cond) else {
        return Ok(None);
    };
    Ok(Some((t, tab, i)))
}

/// Approximate beads around a central contact at `t_c` (hours): the valleys of the light
/// margin in `tab` and when each crosses zero.
fn beads_near(
    ctx: &Ctx,
    tab: &Table,
    cond: Condition,
    t_c: f64,
    contact: LocalEventKind,
) -> Result<Vec<Bead>, EphemerisError> {
    let before = contact == LocalEventKind::C2;
    let dt = if before { -1.0 / H } else { 1.0 / H };
    let (sky0, sky1) = (ctx.sky(t_c), ctx.sky(t_c + dt));
    let n = tab.rho.len();
    let m0: Vec<Option<f64>> = (0..n).map(|i| light_margin(tab, i, &sky0, cond)).collect();
    let m1: Vec<Option<f64>> = (0..n).map(|i| light_margin(tab, i, &sky1, cond)).collect();
    // Local maxima of the margin over two bins either side (the window is contiguous).
    let mut cands: Vec<usize> = (2..n.saturating_sub(2))
        .filter(|&i| {
            m0[i].is_some_and(|v| {
                [m0[i - 2], m0[i - 1], m0[i + 1], m0[i + 2]]
                    .iter()
                    .all(|x| x.is_some_and(|x| v >= x))
            })
        })
        .collect();
    // Deepest valleys first; a candidate joins when the margin between it and every
    // valley already taken dips by the prominence below it.
    cands.sort_by(|&a, &b| m0[b].unwrap_or(0.0).total_cmp(&m0[a].unwrap_or(0.0)));
    let prom = BEAD_PROMINENCE_ARCSEC * ARCSEC;
    let mut taken: Vec<usize> = Vec::new();
    for &i in &cands {
        let v = m0[i].unwrap_or(f64::NEG_INFINITY);
        let separate = taken.iter().all(|&j| {
            let (lo, hi) = if i < j { (i, j) } else { (j, i) };
            let dip = (lo..=hi)
                .filter_map(|x| m0[x])
                .fold(f64::INFINITY, f64::min);
            v - dip >= prom
        });
        if separate {
            taken.push(i);
        }
    }
    let reference = |sky: &Sky| (ctx.ring.reference_radius_km / sky.distance_km).asin();
    let mut out = Vec::new();
    for i in taken {
        let (Some(a), Some(b)) = (m0[i], m1[i]) else {
            continue;
        };
        // The margin, linear in time, is zero at t_c - a / rate (rate per hour).
        let rate = (b - a) / dt;
        if rate.abs() < 1e-12 {
            continue;
        }
        let t = t_c - a / rate;
        let secs = (t - t_c) * H;
        let right_side = if before { secs <= 1e-6 } else { secs >= -1e-6 };
        if !right_side || secs.abs() > BEAD_WINDOW_S {
            continue;
        }
        let sky = ctx.sky(t);
        let rho = tab.rho[i] * tab.distance_km / sky.distance_km;
        let (x, y) = (rho * tab.sin[i], rho * tab.cos[i]);
        let pa = (x - sky.c[0])
            .atan2(y - sky.c[1])
            .to_degrees()
            .rem_euclid(360.0);
        let jd = ctx.el.jd(t);
        let hz = sun_horizontal(ctx.sun, ctx.site, jd)?;
        out.push(Bead {
            contact,
            jd_utc: jd,
            utc: format_utc(jd),
            seconds_from_contact: round3(secs),
            position_angle_deg: pa,
            vertex_angle_deg: (pa - hz.parallactic_angle_deg).rem_euclid(360.0),
            limb_position_angle_deg: (tab.bins[i] as f64 * ctx.ring.step_deg).rem_euclid(360.0),
            limb_height_arcsec: round3((rho - reference(&sky)) / ARCSEC),
        });
    }
    out.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));
    if before {
        // The last to go out matter most.
        let skip = out.len().saturating_sub(MAX_BEADS);
        out.drain(..skip);
    } else {
        out.truncate(MAX_BEADS);
    }
    Ok(out)
}

/// The drawn profile from a full outline, with the Sun of `sky`.
fn profile_from(
    ring: &LimbRing,
    o: &Outline,
    sky: &Sky,
    jd: f64,
    parallactic_angle_deg: f64,
) -> LimbProfile {
    let reference = (ring.reference_radius_km / sky.distance_km).asin();
    let tab = o.table(sky.distance_km);
    let mut height_arcsec = vec![None; ring.n_alpha];
    for (i, &k) in tab.bins.iter().enumerate() {
        let r = tab.rho[i];
        if r.is_finite() {
            height_arcsec[k] = Some(round3((r - reference) / ARCSEC));
        }
    }
    let v = &o.view;
    LimbProfile {
        jd_utc: jd,
        utc: format_utc(jd),
        start_deg: 0.0,
        step_deg: ring.step_deg,
        height_arcsec,
        reference_radius_km: ring.reference_radius_km,
        reference_radius_arcsec: round3(reference / ARCSEC),
        mean_limb_k1_arcsec: round3((sky.rho_k1 - reference) / ARCSEC),
        mean_limb_k2_arcsec: round3((sky.rho_k2 - reference) / ARCSEC),
        sun_radius_arcsec: round3(sky.s / ARCSEC),
        sun_offset_east_arcsec: round3(sky.c[0] / ARCSEC),
        sun_offset_north_arcsec: round3(sky.c[1] / ARCSEC),
        axis_position_angle_deg: v.axis_position_angle_deg,
        parallactic_angle_deg,
        libration_lon_deg: v.sub_observer.lon_deg,
        libration_lat_deg: v.sub_observer.lat_deg,
        moon_distance_km: v.distance_km,
        ring_truncated: o.truncated,
    }
}

/// The Moon's outline as `site` sees it at `jd_utc`, with the Sun's place from the
/// ephemeris: at any instant, not only an eclipse's.
pub fn profile_at(
    ring: &LimbRing,
    moon: &MoonProvider,
    sun: &SunProvider,
    site: &Site,
    jd_utc: f64,
) -> Result<LimbProfile, EphemerisError> {
    let g = MoonGeometry::new(moon, sun, Some(site), jd_utc)
        .map_err(|e| EphemerisError::Data(e.to_string()))?;
    let o = outline(ring, View::of(&g), None);
    let hz = sun_horizontal(sun, site, jd_utc)?;
    Ok(profile_from(
        ring,
        &o,
        &sky_of(&g),
        jd_utc,
        hz.parallactic_angle_deg,
    ))
}

/// The limb-corrected local circumstances of a solar eclipse at `site`, from the same
/// Besselian elements and providers as the mean-limb result `mean`.
pub(crate) fn solar_limb(
    ring: &LimbRing,
    el: &SolarElements,
    sun: &SunProvider,
    moon: &MoonProvider,
    site: &Site,
    mean: &SolarLocalRaw,
) -> Result<SolarLimb, EphemerisError> {
    let p = site_vector(site);
    let ctx = Ctx {
        ring,
        el,
        sun,
        moon,
        site,
        p,
    };
    let mc = solar_contacts(el, p);
    let mut limb = SolarLimb {
        loaded: true,
        pack_version: Some(ring.version().to_string()),
        note: LOADED_NOTE.to_string(),
        resolution_km: Some(round3(
            ring.step_deg().to_radians() * ring.reference_radius_km(),
        )),
        local_type: Some(LocalType::None),
        contacts: Vec::new(),
        duration_s: None,
        central_duration_s: None,
        central_duration_correction_s: None,
        interrupted: false,
        profile: None,
        beads: Vec::new(),
    };
    let (Some(c1m), Some(c4m)) = (mc.c1, mc.c4) else {
        return Ok(limb);
    };
    if mean.local_type == LocalType::None {
        return Ok(limb);
    }
    // The outline at the maximum: the drawing, and the scan for the central phase.
    let o_max = ctx.outline_at(mc.t_max, None)?;
    let sky_max = ctx.sky(mc.t_max);
    let hz_max = sun_horizontal(sun, site, el.jd(mc.t_max))?;
    limb.profile = Some(profile_from(
        ring,
        &o_max,
        &sky_max,
        el.jd(mc.t_max),
        hz_max.parallactic_angle_deg,
    ));
    let tab_max = o_max.table(o_max.view.distance_km);

    let mut contacts = Vec::new();
    for (kind, tm) in [(LocalEventKind::C1, c1m), (LocalEventKind::C4, c4m)] {
        if let Some(c) = external_contact(&ctx, kind, tm)? {
            contacts.push(c);
        }
    }

    // The central phase: total when the Moon's umbral cone reaches the observer.
    let cond = if mc.max.l2 < 0.0 {
        Condition::Total
    } else {
        Condition::Annular
    };
    // How long it can last at most: the Sun's centre must stay within rho_max - s of the
    // Moon's (total) or s - rho_min (annular), and it moves at `speed`.
    let finite = || tab_max.rho.iter().copied().filter(|r| r.is_finite());
    let reach = match cond {
        Condition::Total => finite().fold(f64::NEG_INFINITY, f64::max) - sky_max.s,
        _ => sky_max.s - finite().fold(f64::INFINITY, f64::min),
    };
    let speed = ctx.sun_speed(mc.t_max);
    let mut local_type = LocalType::Partial;
    if reach > 0.0 && speed > 0.0 {
        let half = reach / (0.8 * speed) + 10.0 / H;
        let (a, b) = (
            (mc.t_max - half).max(el.t_lo),
            (mc.t_max + half).min(el.t_hi),
        );
        let intervals = central_intervals(&ctx, &tab_max, cond, a, b, 1.5 * speed);
        if !intervals.is_empty() {
            local_type = if cond == Condition::Total {
                LocalType::Total
            } else {
                LocalType::Annular
            };
            limb.interrupted = intervals.len() > 1;
            let (mut t2, mut t3) = (None, None);
            if let Some(ts) = intervals.first().and_then(|iv| iv.0)
                && let Some((t, tab, i)) = central_contact(&ctx, &tab_max, cond, ts)?
            {
                contacts.push(contact_record(&ctx, &tab, LocalEventKind::C2, t, i, mc.c2)?);
                limb.beads
                    .extend(beads_near(&ctx, &tab, cond, t, LocalEventKind::C2)?);
                t2 = Some(t);
            }
            if let Some(ts) = intervals.last().and_then(|iv| iv.1)
                && let Some((t, tab, i)) = central_contact(&ctx, &tab_max, cond, ts)?
            {
                contacts.push(contact_record(&ctx, &tab, LocalEventKind::C3, t, i, mc.c3)?);
                limb.beads
                    .extend(beads_near(&ctx, &tab, cond, t, LocalEventKind::C3)?);
                t3 = Some(t);
            }
            if let (Some(a), Some(b)) = (t2, t3) {
                let d = (b - a) * H;
                limb.central_duration_s = Some(d);
                limb.central_duration_correction_s = mean.central_duration_s.map(|m| d - m);
            }
        }
    }
    contacts.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));
    let first = contacts.iter().find(|c| c.kind == LocalEventKind::C1);
    let last = contacts.iter().find(|c| c.kind == LocalEventKind::C4);
    if let (Some(a), Some(b)) = (first, last) {
        limb.duration_s = Some((b.jd_utc - a.jd_utc) * 86_400.0);
    }
    limb.contacts = contacts;
    limb.local_type = Some(local_type);
    Ok(limb)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lunar-limb payload for a ring of any heights.
    pub(crate) fn synthetic_payload(
        n_alpha: usize,
        n_delta: usize,
        step: f64,
        quantum: f64,
        height: impl Fn(usize, usize) -> f64,
    ) -> Vec<u8> {
        let mut q = vec![0i32; n_alpha * n_delta];
        for j in 0..n_alpha {
            for i in 0..n_delta {
                q[j * n_delta + i] = (height(j, i) / quantum).round() as i32;
            }
        }
        let mut body = Vec::new();
        for j in 0..n_alpha {
            for i in 0..n_delta {
                let at = |jj: usize, ii: usize| q[jj * n_delta + ii];
                let p = match (j, i) {
                    (0, 0) => 0,
                    (0, _) => at(0, i - 1),
                    (_, 0) => at(j - 1, 0),
                    _ => at(j, i - 1) + at(j - 1, i) - at(j - 1, i - 1),
                };
                let r = at(j, i) - p;
                if (-127..=127).contains(&r) {
                    body.push(r as i8 as u8);
                } else {
                    body.push(0x80);
                    body.extend_from_slice(&(r as i16).to_le_bytes());
                }
            }
        }
        let mut out = b"LIMB".to_vec();
        out.extend_from_slice(&1u16.to_le_bytes());
        for s in ["test", "synthetic"] {
            out.push(s.len() as u8);
            out.extend_from_slice(s.as_bytes());
        }
        for v in [1737.4, quantum, step, -(n_delta as f64) * step / 2.0] {
            out.extend_from_slice(&f64::to_le_bytes(v));
        }
        out.extend_from_slice(&(n_alpha as u16).to_le_bytes());
        out.extend_from_slice(&(n_delta as u16).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn the_byte_code_round_trips_with_escapes() {
        // Steep enough that some residuals need the escape.
        let f = |j: usize, i: usize| ((j * 37 + i * 101) % 997) as f64 * 5.0 - 2000.0;
        let payload = synthetic_payload(360, 16, 1.0, 5.0, f);
        let ring = LimbRing::parse(&payload).unwrap();
        for j in 0..360 {
            for i in 0..16 {
                assert_eq!(ring.node_height_m(j, i), (f(j, i) / 5.0).round() * 5.0);
            }
        }
        assert_eq!(ring.shape(), (360, 16));
        assert_eq!(ring.delta_range_deg(), (-8.0, 8.0));
        assert_eq!(ring.height_range_m(), (-2000.0, 2980.0));
    }

    #[test]
    fn a_damaged_payload_is_refused_with_its_own_sentence() {
        let good = synthetic_payload(360, 16, 1.0, 5.0, |_, _| 100.0);
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (b"LIMX".to_vec(), "no LIMB"),
            (
                {
                    let mut p = good.clone();
                    p[4] = 2;
                    p
                },
                "format 2",
            ),
            (good[..good.len() - 1].to_vec(), "should be"),
            (
                {
                    let mut p = good.clone();
                    p.push(0);
                    p
                },
                "should be",
            ),
        ];
        for (p, words) in cases {
            let e = LimbRing::parse(&p).unwrap_err();
            assert!(e.contains(words), "{words:?} not in {e:?}");
        }
        // 359 columns of 1 degree do not close the circle.
        let short = synthetic_payload(359, 16, 1.0, 5.0, |_, _| 0.0);
        assert!(LimbRing::parse(&short).unwrap_err().contains("once around"));
    }

    #[test]
    fn block_maxima_are_the_sliding_maxima_they_claim() {
        let f = |j: usize, i: usize| (((j * 7919 + i * 104_729) % 3001) as f64 - 1500.0) * 5.0;
        let (na, nd) = (720, 40);
        let ring = LimbRing::parse(&synthetic_payload(na, nd, 0.5, 5.0, f)).unwrap();
        let nb = ring.n_blocks;
        assert_eq!(nb, 3);
        for j in 0..na {
            for b in 0..nb {
                let mut want = i16::MIN;
                for o in 0..=2 * DRIFT_COLUMNS {
                    let jj = (j + na + o - DRIFT_COLUMNS) % na;
                    for i in b * BLOCK_ROWS..((b + 1) * BLOCK_ROWS).min(nd) {
                        want = want.max(ring.q[jj * nd + i]);
                    }
                }
                assert_eq!(ring.block_max[j * nb + b], want, "column {j} block {b}");
            }
        }
    }

    #[test]
    fn ring_coordinates_invert_the_node_vector() {
        for (a, d) in [(0.3f64, 0.1f64), (2.0, -0.2), (4.5, 0.05), (6.0, 0.0)] {
            let u = [d.sin(), -a.sin() * d.cos(), a.cos() * d.cos()];
            let (aa, dd) = ring_coordinates(u);
            assert!((aa - a).abs() < 1e-12 && (dd - d).abs() < 1e-12);
        }
        // The north pole is axis angle 0; selenographic west (lon -90) is 90 degrees.
        let (a, _) = ring_coordinates([0.0, 0.0, 1.0]);
        assert!(a.abs() < 1e-12);
        let (a, _) = ring_coordinates([0.0, -1.0, 0.0]);
        assert!((a.to_degrees() - 90.0).abs() < 1e-9);
    }

    #[test]
    fn small_asin_matches_the_library() {
        for i in -300..=300 {
            let x = i as f64 * 0.001;
            assert!((small_asin(x) - x.asin()).abs() < 1e-10, "{x}");
        }
    }

    /// A view from direction `s` (selenographic, toward the observer) at `distance_km`,
    /// with the lunar pole standing in for the celestial pole (as `north_east` builds
    /// north and east from the true pole).
    fn view_from(s: Vec3, distance_km: f64) -> View {
        let s = unit(s);
        let u = scale(s, -1.0);
        let cross = |a: Vec3, b: Vec3| {
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ]
        };
        let e = unit(cross([0.0, 0.0, 1.0], u));
        let n = cross(u, e);
        View {
            jd_utc: 0.0,
            s,
            n,
            e,
            distance_km,
            sub_observer: Selenographic {
                lat_deg: s[2].asin().to_degrees(),
                lon_deg: s[1].atan2(s[0]).to_degrees(),
            },
            axis_position_angle_deg: 0.0,
        }
    }

    #[test]
    fn a_flat_ring_gives_the_sphere_and_one_mountain_stands_out_where_it_should() {
        // Heights 0 everywhere: the outline is the sphere's tangent circle, asin(R / D).
        let (na, nd, step) = (1440, 96, 0.25);
        let flat = LimbRing::parse(&synthetic_payload(na, nd, step, 5.0, |_, _| 0.0)).unwrap();
        let d = 380_000.0;
        for s in [[1.0, 0.0, 0.0], [0.99, 0.1, -0.08]] {
            let v = view_from(s, d);
            let o = outline(&flat, v, None);
            let tab = o.table(d);
            // Sampled every quarter degree along the slice, the tangent point is missed by
            // at most 0.13 degree: 1e-10 rad below the sphere's asin(R / D).
            let want = (1737.4f64 / d).asin();
            for r in &tab.rho {
                assert!(*r <= want + 1e-15 && want - r < 2e-10, "{r} {want}");
            }
        }
        // A 5 km column of mountains 2 degrees behind the mean limb at axis angle 90
        // (selenographic west, lon -90, seen at position angle 90 from straight in
        // front): h = 5 km at 2 degrees behind stands 5 - R (1 - cos 2) = 3.94 km out.
        let mountain = |j: usize, i: usize| {
            let alpha = (j as f64 + 0.5) * step;
            let delta = -12.0 + (i as f64 + 0.5) * step;
            if (alpha - 90.0).abs() < 1.0 && (delta + 2.0).abs() < 0.3 {
                5000.0
            } else {
                0.0
            }
        };
        let ring = LimbRing::parse(&synthetic_payload(na, nd, step, 5.0, mountain)).unwrap();
        let v = view_from([1.0, 0.0, 0.0], d);
        let o = outline(&ring, v, None);
        let tab = o.table(d);
        let k90 = (90.0 / step) as usize;
        let i = tab.bins.iter().position(|&k| k == k90).unwrap();
        let r = tab.rho[i];
        let want = ((1737.4 + 5.0) * 2f64.to_radians().cos())
            / (d + (1737.4 + 5.0) * 2f64.to_radians().sin());
        assert!((r - want.atan()).abs() < 2e-10, "{r} {}", want.atan());
        assert!((o.crests[i].eps_deg - 2.0).abs() < 1e-9);
        // Opposite, at position angle 270, nothing: the sphere.
        let i = tab.bins.iter().position(|&k| k == k90 * 3).unwrap();
        assert!(((1737.4f64 / d).asin() - tab.rho[i]).abs() < 2e-10);
    }
}
