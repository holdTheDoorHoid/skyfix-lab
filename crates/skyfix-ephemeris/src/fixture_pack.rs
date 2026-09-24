//! OWNER: ephemeris agent. See lib.rs.
//!
//! The honest fallback: a bundled, dated almanac pack for any body, interpolated, with
//! hard refusals outside its range. `docs/BRIEF.md` ("Offline astronomy") asks for
//! exactly this when a computed model is not available — "bundle a dated
//! fixture/almanac pack with explicit coverage and provenance, interpolate angles
//! correctly across wrapping, and refuse out-of-range queries. Label the fallback
//! honestly as limited-date operation."
//!
//! # Pack format, `skyfix.almanac_pack/1`
//!
//! ```json
//! {
//!   "schema": "skyfix.almanac_pack/1",
//!   "provider": "nautical-almanac-2026",
//!   "generator": { "tool": "...", "ephemeris": "...", "eop": "..." },
//!   "bodies": {
//!     "Moon": {
//!       "step_s": 3600,
//!       "start_utc": "2026-01-01T00:00:00Z",
//!       "rows": [[gha_deg, dec_deg, sd_arcmin, hp_arcmin], ...]
//!     }
//!   },
//!   "notes": "..."
//! }
//! ```
//!
//! Rows are on a uniform grid: row `i` is `start_utc + i * step_s`.
//!
//! # Interpolation
//!
//! Four-point cubic Lagrange on the nodes `i-1, i, i+1, i+2` whenever all four exist,
//! linear on the first and last intervals. GHA is unwrapped before interpolating and
//! renormalised after, so 359 and 1 never average to 180. Declination, semidiameter
//! and horizontal parallax are interpolated directly; none of them wraps.
//!
//! # How much the interpolation costs
//!
//! For equally spaced nodes with spacing `h`, cubic Lagrange on the central interval
//! has error at most `0.5625 h^4 max|f''''| / 4! = h^4 max|f''''| / 42.7`, and linear
//! interpolation has error at most `h^2 max|f''| / 8`.
//!
//! The Moon is the worst case in an almanac. Its hour angle is Earth rotation (exactly
//! linear in UT1) minus its apparent right ascension, so all the curvature comes from
//! the Moon. `tests/fixture_pack_interpolation.rs` measures both bounds on a synthetic
//! signal built from the Moon's real dominant frequencies and amplitudes, at the
//! 1-hour step an almanac pack would use. **Worst error, arcminutes:**
//!
//! | | GHA | Dec | SD | HP |
//! |---|---|---|---|---|
//! | cubic interior | 0.000005 | 0.000001 | <0.000001 | <0.000001 |
//! | linear end intervals | 0.0022 | 0.0078 | 0.000007 | 0.000027 |
//!
//! So a 1-hour Moon table costs essentially nothing in the interior and under 0.01' on
//! the two end intervals; [`FixturePackProvider::uses_cubic`] says which applies. The
//! cubic figure is already at the floor set by holding a Julian date in one `f64`
//! (about 4e-5 s, which is 1e-5' at the Moon's 14.5 deg/h), so a finer grid does not
//! improve it. A slower body such as the Sun is two orders better again.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, parse_utc};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::norm_360;

use crate::{AstroProvider, Coverage, EphemerisError};

pub const ALMANAC_PACK_SCHEMA: &str = "skyfix.almanac_pack/1";

/// The phrase CONVENTIONS and the brief require this fallback to be labelled with.
pub const LIMITED_DATE_NOTE: &str = "limited-date operation";

// ---------------------------------------------------------------------------
// Pack document
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlmanacPack {
    pub schema: String,
    /// Who produced the numbers; becomes part of the provider name.
    pub provider: String,
    /// Opaque provenance block, carried through untouched and shown in the coverage.
    #[serde(default)]
    pub generator: serde_json::Value,
    pub bodies: BTreeMap<String, BodyTable>,
    #[serde(default)]
    pub notes: String,
}

/// One body's uniformly sampled table. Row `i` is at `start_utc + i * step_s`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BodyTable {
    pub step_s: f64,
    pub start_utc: String,
    /// `[gha_deg, dec_deg, semidiameter_arcmin, horizontal_parallax_arcmin]`.
    pub rows: Vec<[f64; 4]>,
}

/// A validated body table with its grid resolved to Julian dates.
#[derive(Debug, Clone, PartialEq)]
struct Grid {
    start_jd: f64,
    step_days: f64,
    end_jd: f64,
    rows: Vec<[f64; 4]>,
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/// Unwrap a sequence of angles so consecutive values never jump more than 180 deg.
/// The first value is kept as given; every later one is moved by a whole number of
/// turns to sit closest to its predecessor.
fn unwrap_degrees(values: &mut [f64]) {
    for i in 1..values.len() {
        let step = values[i] - values[i - 1];
        values[i] -= 360.0 * (step / 360.0).round();
    }
}

/// Cubic Lagrange through `y` at nodes `-1, 0, 1, 2`, evaluated at `p` in `[0, 1]`.
fn lagrange4(y: [f64; 4], p: f64) -> f64 {
    let (a, b, c, d) = (p + 1.0, p, p - 1.0, p - 2.0);
    y[0] * (-b * c * d / 6.0)
        + y[1] * (a * c * d / 2.0)
        + y[2] * (-a * b * d / 2.0)
        + y[3] * (a * b * c / 6.0)
}

#[inline]
fn lerp(y0: f64, y1: f64, p: f64) -> f64 {
    y0 + (y1 - y0) * p
}

impl Grid {
    /// Interpolate all four columns at `jd`, which the caller has checked is in range.
    fn sample(&self, jd: f64) -> [f64; 4] {
        let n = self.rows.len();
        if n == 1 {
            return self.rows[0];
        }
        // Locate the interval [i, i+1] containing jd.
        let x = (jd - self.start_jd) / self.step_days;
        let i = (x.floor() as isize).clamp(0, n as isize - 2) as usize;
        let p = x - i as f64;

        // Four-point stencil i-1 .. i+2 when it exists, else the linear end segment.
        let cubic = i >= 1 && i + 2 < n;
        let mut out = [0.0f64; 4];
        for (col, slot) in out.iter_mut().enumerate() {
            *slot = if cubic {
                let mut y = [
                    self.rows[i - 1][col],
                    self.rows[i][col],
                    self.rows[i + 1][col],
                    self.rows[i + 2][col],
                ];
                if col == 0 {
                    unwrap_degrees(&mut y);
                }
                lagrange4(y, p)
            } else {
                let mut y = [self.rows[i][col], self.rows[i + 1][col]];
                if col == 0 {
                    unwrap_degrees(&mut y);
                }
                lerp(y[0], y[1], p)
            };
        }
        out[0] = norm_360(out[0]);
        out
    }

    /// True when this sample used the 4-point stencil rather than a linear end segment.
    fn uses_cubic(&self, jd: f64) -> bool {
        let n = self.rows.len();
        if n < 4 {
            return false;
        }
        let x = (jd - self.start_jd) / self.step_days;
        let i = (x.floor() as isize).clamp(0, n as isize - 2) as usize;
        i >= 1 && i + 2 < n
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/// Serves body directions by interpolating a bundled almanac pack. Limited-date.
#[derive(Debug, Clone, PartialEq)]
pub struct FixturePackProvider {
    name: String,
    pack_notes: String,
    generator: serde_json::Value,
    /// Body name (as written in the pack) -> grid. Lookup is case-insensitive.
    grids: BTreeMap<String, Grid>,
}

impl FixturePackProvider {
    /// Parse and validate a `skyfix.almanac_pack/1` document.
    ///
    /// Rejects: the wrong schema, an empty pack, a body with no rows, a non-positive or
    /// non-finite step, an unparseable `start_utc`, and any non-finite or out-of-range
    /// value in a row. A pack that gets past this can always be interpolated.
    pub fn from_json(json: &str) -> Result<Self, EphemerisError> {
        let pack: AlmanacPack =
            serde_json::from_str(json).map_err(|e| EphemerisError::Data(format!("{e}")))?;
        Self::from_pack(&pack)
    }

    pub fn from_pack(pack: &AlmanacPack) -> Result<Self, EphemerisError> {
        if pack.schema != ALMANAC_PACK_SCHEMA {
            return Err(EphemerisError::Data(format!(
                "almanac pack declares schema {:?}, expected {ALMANAC_PACK_SCHEMA:?}",
                pack.schema
            )));
        }
        if pack.bodies.is_empty() {
            return Err(EphemerisError::Data(
                "almanac pack contains no bodies".to_string(),
            ));
        }
        let mut grids = BTreeMap::new();
        for (body, table) in &pack.bodies {
            if table.rows.is_empty() {
                return Err(EphemerisError::Data(format!(
                    "almanac pack body {body:?} has no rows"
                )));
            }
            if !table.step_s.is_finite() || table.step_s <= 0.0 {
                return Err(EphemerisError::Data(format!(
                    "almanac pack body {body:?} has step_s {}, which must be positive",
                    table.step_s
                )));
            }
            let start_jd = parse_utc(&table.start_utc).map_err(|e| {
                EphemerisError::Data(format!(
                    "almanac pack body {body:?} has an unusable start_utc: {e}"
                ))
            })?;
            for (i, row) in table.rows.iter().enumerate() {
                if !row.iter().all(|v| v.is_finite()) {
                    return Err(EphemerisError::Data(format!(
                        "almanac pack body {body:?} row {i} contains a non-finite value"
                    )));
                }
                if row[1].abs() > 90.0 {
                    return Err(EphemerisError::Data(format!(
                        "almanac pack body {body:?} row {i} has declination {}, outside [-90, 90]",
                        row[1]
                    )));
                }
                if row[2] < 0.0 || row[3] < 0.0 {
                    return Err(EphemerisError::Data(format!(
                        "almanac pack body {body:?} row {i} has a negative semidiameter or parallax"
                    )));
                }
            }
            let step_days = table.step_s / 86_400.0;
            let end_jd = start_jd + step_days * (table.rows.len() - 1) as f64;
            grids.insert(
                body.clone(),
                Grid {
                    start_jd,
                    step_days,
                    end_jd,
                    rows: table.rows.clone(),
                },
            );
        }
        Ok(FixturePackProvider {
            name: format!("FixturePackProvider[{}]", pack.provider),
            pack_notes: pack.notes.clone(),
            generator: pack.generator.clone(),
            grids,
        })
    }

    fn grid(&self, body: &str) -> Option<(&str, &Grid)> {
        self.grids
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(body))
            .map(|(k, g)| (k.as_str(), g))
    }

    /// Bodies this pack carries, in the spelling the pack uses.
    pub fn bodies(&self) -> Vec<String> {
        self.grids.keys().cloned().collect()
    }

    /// `(start_utc, end_utc)` for one body, or `None` if the pack does not carry it.
    pub fn body_range(&self, body: &str) -> Option<(String, String)> {
        self.grid(body)
            .map(|(_, g)| (format_utc(g.start_jd), format_utc(g.end_jd)))
    }

    /// The provenance block the pack shipped, untouched.
    pub fn generator(&self) -> &serde_json::Value {
        &self.generator
    }

    /// True when a query at `jd_utc` would be served by the 4-point stencil rather than
    /// a linear end segment. The end segments carry a larger interpolation error.
    pub fn uses_cubic(&self, body: &str, jd_utc: f64) -> bool {
        self.grid(body).is_some_and(|(_, g)| g.uses_cubic(jd_utc))
    }
}

impl AstroProvider for FixturePackProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn coverage(&self) -> Coverage {
        // start/end are the envelope of every body; per-body ranges go in the notes,
        // because a query inside the envelope can still miss a particular body.
        let start = self
            .grids
            .values()
            .map(|g| g.start_jd)
            .fold(f64::INFINITY, f64::min);
        let end = self
            .grids
            .values()
            .map(|g| g.end_jd)
            .fold(f64::NEG_INFINITY, f64::max);
        let per_body = self
            .grids
            .iter()
            .map(|(b, g)| {
                format!(
                    "{b} {} .. {} every {:.0} s",
                    format_utc(g.start_jd),
                    format_utc(g.end_jd),
                    g.step_days * 86_400.0
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let extra = if self.pack_notes.is_empty() {
            String::new()
        } else {
            format!(" Pack notes: {}", self.pack_notes)
        };
        Coverage {
            start_utc: format_utc(start),
            end_utc: format_utc(end),
            bodies: self.bodies(),
            notes: format!(
                "Tabulated almanac pack, {LIMITED_DATE_NOTE}: outside the tabulated range this \
                 provider refuses rather than extrapolating. Ranges are the envelope of all \
                 bodies; per body: {per_body}. Directions are interpolated (4-point cubic \
                 Lagrange, linear on the first and last interval, GHA unwrapped across 360). \
                 Accuracy is the generating source's accuracy plus the interpolation error.{extra}"
            ),
            // Interpolation alone; the pack's own accuracy is the generator's and is
            // reported in `generator()`, not claimed here.
            accuracy_arcmin: 0.05,
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        if !jd_utc.is_finite() {
            return Err(EphemerisError::Data(
                "jd_utc is not a finite Julian date".to_string(),
            ));
        }
        let Some((name, grid)) = self.grid(body) else {
            return Err(EphemerisError::UnknownBody(
                body.to_string(),
                self.name.clone(),
            ));
        };
        if jd_utc < grid.start_jd || jd_utc > grid.end_jd {
            return Err(EphemerisError::OutOfCoverage {
                provider: self.name.clone(),
                jd_utc,
                coverage: format!(
                    "{name}: {} .. {}",
                    format_utc(grid.start_jd),
                    format_utc(grid.end_jd)
                ),
            });
        }
        let r = grid.sample(jd_utc);
        Ok(GeocentricDirection {
            gha_deg: r[0],
            dec_deg: r[1],
            semidiameter_arcmin: r[2],
            horizontal_parallax_arcmin: r[3],
        })
    }
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/// Tries providers in order and reports which one answered.
///
/// The usual order is the computed models first and the dated pack last:
/// `SunProvider -> StarProvider -> FixturePackProvider`. [`CompositeProvider::resolve`]
/// returns the answering provider's name so the CLI can print
/// `direction from: SunProvider`.
pub struct CompositeProvider {
    name: String,
    providers: Vec<Box<dyn AstroProvider>>,
}

impl std::fmt::Debug for CompositeProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompositeProvider")
            .field("name", &self.name)
            .field(
                "providers",
                &self.providers.iter().map(|p| p.name()).collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// How informative a failure is. "This provider stops in 2026" beats "nobody here has
/// a Moon", because it tells the user what to change.
fn failure_rank(e: &EphemerisError) -> u8 {
    match e {
        EphemerisError::UnknownBody(..) => 0,
        EphemerisError::Data(_) => 1,
        EphemerisError::OutOfCoverage { .. } => 2,
    }
}

impl CompositeProvider {
    pub fn new(name: impl Into<String>) -> Self {
        CompositeProvider {
            name: name.into(),
            providers: Vec::new(),
        }
    }

    /// Append a provider. Order is priority order.
    #[must_use]
    pub fn with(mut self, provider: impl AstroProvider + 'static) -> Self {
        self.providers.push(Box::new(provider));
        self
    }

    pub fn push(&mut self, provider: Box<dyn AstroProvider>) {
        self.providers.push(provider);
    }

    /// The providers in priority order.
    pub fn provider_names(&self) -> Vec<&str> {
        self.providers.iter().map(|p| p.name()).collect()
    }

    /// Resolve `body` at `jd_utc`, returning the direction and the name of the provider
    /// that supplied it.
    ///
    /// Every provider is tried in order. If none succeeds, the most informative failure
    /// is returned: an `OutOfCoverage` from a provider that *does* carry the body beats
    /// an `UnknownBody`, because "this provider stops in 2026" is more useful than
    /// "nobody here has a Moon".
    pub fn resolve(
        &self,
        body: &str,
        jd_utc: f64,
    ) -> Result<(GeocentricDirection, &str), EphemerisError> {
        let mut best: Option<EphemerisError> = None;
        for p in &self.providers {
            match p.geocentric(body, jd_utc) {
                Ok(d) => return Ok((d, p.name())),
                Err(e) => {
                    // Keep the most informative failure; ties go to the first provider.
                    if best
                        .as_ref()
                        .is_none_or(|b| failure_rank(&e) > failure_rank(b))
                    {
                        best = Some(e);
                    }
                }
            }
        }
        Err(best.unwrap_or_else(|| {
            EphemerisError::UnknownBody(
                body.to_string(),
                format!("{} (no providers configured)", self.name),
            )
        }))
    }
}

impl AstroProvider for CompositeProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn coverage(&self) -> Coverage {
        let covs: Vec<Coverage> = self.providers.iter().map(|p| p.coverage()).collect();
        let mut bodies: Vec<String> = Vec::new();
        for c in &covs {
            for b in &c.bodies {
                if !bodies.iter().any(|x| x.eq_ignore_ascii_case(b)) {
                    bodies.push(b.clone());
                }
            }
        }
        let start = covs
            .iter()
            .filter_map(|c| parse_utc(&c.start_utc).ok())
            .fold(f64::INFINITY, f64::min);
        let end = covs
            .iter()
            .filter_map(|c| parse_utc(&c.end_utc).ok())
            .fold(f64::NEG_INFINITY, f64::max);
        let per_provider = self
            .providers
            .iter()
            .zip(&covs)
            .map(|(p, c)| {
                format!(
                    "{} ({} .. {}, bodies: {})",
                    p.name(),
                    c.start_utc,
                    c.end_utc,
                    c.bodies.join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        Coverage {
            start_utc: if start.is_finite() {
                format_utc(start)
            } else {
                String::new()
            },
            end_utc: if end.is_finite() {
                format_utc(end)
            } else {
                String::new()
            },
            bodies,
            notes: format!(
                "Tried in this order: {per_provider}. The start and end above are the envelope \
                 of all of them, so a time inside that envelope can still be outside the \
                 provider that carries a particular body; the refusal names the range that \
                 actually applied."
            ),
            accuracy_arcmin: covs
                .iter()
                .map(|c| c.accuracy_arcmin)
                .fold(0.0f64, f64::max),
        }
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        self.resolve(body, jd_utc).map(|(d, _)| d)
    }
}

// ---------------------------------------------------------------------------
// Unit tests for the private interpolation kernels.
// Behavioural tests live in `tests/fixture_pack_*.rs`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn unwrapping_never_averages_across_the_seam() {
        let mut v = [359.0, 1.0, 3.0, 5.0];
        unwrap_degrees(&mut v);
        assert_eq!(v, [359.0, 361.0, 363.0, 365.0]);

        // Backwards across the seam.
        let mut v = [1.0, 359.0, 357.0];
        unwrap_degrees(&mut v);
        assert_eq!(v, [1.0, -1.0, -3.0]);

        // A genuine 180 deg step is ambiguous; it must not blow up.
        let mut v = [0.0, 180.0];
        unwrap_degrees(&mut v);
        assert!(v[1].abs() == 180.0);

        // No seam: untouched.
        let mut v = [10.0, 20.0, 30.0];
        unwrap_degrees(&mut v);
        assert_eq!(v, [10.0, 20.0, 30.0]);
    }

    #[test]
    fn lagrange4_reproduces_its_nodes_and_is_exact_on_cubics() {
        let f = |x: f64| 2.0 - 3.0 * x + 0.5 * x * x - 0.25 * x * x * x;
        let y = [f(-1.0), f(0.0), f(1.0), f(2.0)];
        for p in [0.0, 1.0] {
            assert_relative_eq!(lagrange4(y, p), f(p), epsilon = 1e-12);
        }
        for i in 0..=20 {
            let p = f64::from(i) / 20.0;
            assert_relative_eq!(lagrange4(y, p), f(p), epsilon = 1e-12);
        }
        // Partition of unity: a constant stays constant.
        assert_relative_eq!(lagrange4([7.0; 4], 0.37), 7.0, epsilon = 1e-12);
    }

    #[test]
    fn lerp_hits_both_ends() {
        assert_relative_eq!(lerp(3.0, 9.0, 0.0), 3.0);
        assert_relative_eq!(lerp(3.0, 9.0, 1.0), 9.0);
        assert_relative_eq!(lerp(3.0, 9.0, 0.25), 4.5);
    }
}
