//! The Nautical Almanac's tables beyond the daily pages, computed from formulas:
//! Conversion of Arc to Time, the Increments and Corrections, the Altitude Correction
//! Tables (Sun, stars and planets; the Moon's two-part table; dip; the additional
//! corrections for non-standard conditions and for Venus and Mars) and the Polaris
//! (Pole Star) tables.
//!
//! OWNER: almanac2 agent (expansion programme Q7). Definitions: CONVENTIONS 13.9.1; wire
//! format: EXPLORER_API.md "Expansion programme — almanac tables and three-day pages".
//!
//! # Where the numbers come from
//!
//! - **Arc to time** and **increments** are pure arithmetic, done in integers so that
//!   exact halves round the way the printed tables round them (up).
//! - **Altitude corrections** are this project's correction chain (CONVENTIONS 5):
//!   Bennett's refraction at 1010 hPa and 10 °C, the Sun's parallax `HP cos Ha`, the
//!   Moon's augmented semidiameter and rigorous parallax, and the dip `1.76′ √h`. They
//!   are laid out, rounded and split exactly as the printed Nautical Almanac lays out,
//!   rounds and splits its own; the construction constants the printed tables choose
//!   (the Sun's two half-year semidiameters, the Moon's mean horizontal parallax of
//!   57.7′ and the offsets of its two parts) are the printed tables'. So a navigator who
//!   corrects a sight with these tables gets the Ho this project's own reduction gets, to
//!   the tables' rounding. The printed almanac's refraction is a slightly different
//!   model: its entries can differ from these by 0.1′ (the one model difference; the
//!   accuracy notes measure it against the published examples).
//! - **Venus and Mars** (the additional correction) and **Polaris** need the ephemeris:
//!   the planets' horizontal parallax through the year, and Polaris' apparent place.
//!
//! # Rounding rules (CONVENTIONS 13.9.1)
//!
//! - Every value is rounded to the printed precision, exact halves **up** (toward
//!   `+∞`), as the printed tables do (`0′ 01″` of the Sun's increment is 0.25′ and is
//!   printed `0 00.3`).
//! - A **critical table** (the 10°–90° altitude corrections, dip, the Venus and Mars
//!   corrections) prints only the arguments at which the rounded correction changes. Each
//!   boundary is the last argument, at the printed precision, that still takes the
//!   correction *above* it, so an argument given to the printed precision always gets
//!   the correctly rounded correction; an argument exactly equal to a boundary takes the
//!   correction above it ("in critical cases ascend", Bowditch vol. 2 §614).

use serde::{Deserialize, Serialize};

pub mod altitude;
pub mod arc_time;
pub mod increments;
pub mod moon;
pub mod planets;
pub mod polaris;

pub use altitude::{AltitudeTables, Conditions, altitude_tables};
pub use arc_time::{ArcToTime, arc_to_time};
pub use increments::{IncrementsMinute, increments};
pub use moon::{MoonTable, moon_table};
pub use planets::{PlanetCorrections, planet_corrections};
pub use polaris::{PolarisTable, polaris_table};

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/// A tabulated quantity in arcminutes: the value and, under `printed`, the text the
/// table prints. For a critical table's interval the value is the rounded correction
/// itself (the exact correction varies across the interval).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArcminCell {
    pub arcmin: f64,
    pub printed: String,
}

impl ArcminCell {
    /// A signed correction to 0.1′: `+15.3`, `-0.8`, `0.0`.
    pub fn signed(arcmin: f64) -> ArcminCell {
        ArcminCell {
            arcmin,
            printed: fmt_signed_tenths(tenths_half_up(arcmin)),
        }
    }

    /// An unsigned quantity to 0.1′ (a minus sign only when it is negative): `62.5`.
    pub fn plain(arcmin: f64) -> ArcminCell {
        ArcminCell {
            arcmin,
            printed: fmt_tenths(tenths_half_up(arcmin)),
        }
    }

    /// A rounded correction given in tenths of an arcminute (a critical table's value).
    pub fn signed_tenths(tenths: i64) -> ArcminCell {
        ArcminCell {
            arcmin: tenths as f64 / 10.0,
            printed: fmt_signed_tenths(tenths),
        }
    }

    /// An angle printed as degrees and minutes to 0.1′: `0 14.3`, `1 03.8`.
    pub fn deg_min(arcmin: f64) -> ArcminCell {
        ArcminCell {
            arcmin,
            printed: fmt_deg_min_tenths(tenths_half_up(arcmin)),
        }
    }
}

/// A tabulated angle in degrees to 0.1° (the Polaris azimuth): `359.3`, `0.2`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DegCell {
    pub deg: f64,
    pub printed: String,
}

/// One boundary argument of a critical table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriticalArgument {
    /// The argument at the printed precision, in the table's unit (degrees for
    /// altitudes, metres or feet for heights of eye).
    pub value: f64,
    /// As printed: `9 55` (degrees and whole minutes), `2.4` (metres), `41` (degrees).
    pub printed: String,
}

/// A critical table: `n + 1` boundary arguments and `n` intervals.
///
/// An argument strictly above `boundaries[k]` and at most `boundaries[k + 1]` takes
/// `values[k]`, one cell per column (`columns`); an argument equal to a boundary takes
/// the value above it. Arguments are increasing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CriticalTable {
    /// What the argument is, in words.
    pub argument: String,
    /// `deg_min`, `deg`, `m` or `ft`.
    pub unit: String,
    /// The column headings (`Lower limb`, `Upper limb`, `Corr`).
    pub columns: Vec<String>,
    pub boundaries: Vec<CriticalArgument>,
    pub values: Vec<Vec<ArcminCell>>,
}

impl CriticalTable {
    /// The corrections (one per column) for an argument, by the table's own rules, or
    /// `None` outside `(first boundary, last boundary]`.
    pub fn lookup(&self, argument: f64) -> Option<&[ArcminCell]> {
        let first = self.boundaries.first()?.value;
        let last = self.boundaries.last()?.value;
        if !(argument > first && argument <= last) {
            return None;
        }
        let k = self
            .boundaries
            .iter()
            .position(|b| argument <= b.value)?
            .checked_sub(1)?;
        self.values.get(k).map(Vec::as_slice)
    }
}

/// Build a critical table on an integer grid of arguments.
///
/// `value(i)` is the tuple of rounded corrections (tenths of an arcminute) at the grid
/// argument `i` (in units of the printed precision). The table covers the grid from
/// `start` to `end`; its first boundary is the last grid point below `start` whose
/// corrections differ from those at `start` (so the first interval is whole, as the
/// printed tables begin theirs), searched at most `lookback` points down.
pub(crate) fn critical_on_grid(
    start: i64,
    end: i64,
    lookback: i64,
    value: impl Fn(i64) -> Vec<i64>,
) -> (Vec<i64>, Vec<Vec<i64>>) {
    let at_start = value(start);
    let mut first = start;
    for i in (start - lookback..start).rev() {
        if value(i) != at_start {
            first = i;
            break;
        }
    }
    let mut boundaries = vec![first];
    let mut values = Vec::new();
    let mut current = value(first + 1);
    for i in (first + 1)..end {
        let next = value(i + 1);
        if next != current {
            boundaries.push(i);
            values.push(std::mem::replace(&mut current, next));
        }
    }
    boundaries.push(end);
    values.push(current);
    (boundaries, values)
}

// ---------------------------------------------------------------------------
// Rounding and printing
// ---------------------------------------------------------------------------

/// `x` in tenths, rounded half up (toward `+∞`): 0.25 is 3 tenths, -5.25 is -52.
pub fn tenths_half_up(x: f64) -> i64 {
    (x * 10.0 + 0.5).floor() as i64
}

/// `15.3`, `-0.8` from tenths.
pub fn fmt_tenths(t: i64) -> String {
    let sign = if t < 0 { "-" } else { "" };
    format!("{sign}{}.{}", t.abs() / 10, t.abs() % 10)
}

/// `+15.3`, `-0.8`, `0.0` from tenths.
pub fn fmt_signed_tenths(t: i64) -> String {
    match t.signum() {
        1 => format!("+{}", fmt_tenths(t)),
        _ => fmt_tenths(t),
    }
}

/// Degrees and minutes to 0.1′ from tenths of an arcminute: `0 14.3`, `14 39.2`,
/// `-0 12.3`.
pub fn fmt_deg_min_tenths(t: i64) -> String {
    let sign = if t < 0 { "-" } else { "" };
    let a = t.abs();
    format!("{sign}{} {:02}.{}", a / 600, (a % 600) / 10, a % 10)
}

/// Degrees and whole minutes from whole minutes of arc: `9 55`, `90 00`.
pub fn fmt_deg_min_whole(minutes: i64) -> String {
    let sign = if minutes < 0 { "-" } else { "" };
    let a = minutes.abs();
    format!("{sign}{} {:02}", a / 60, a % 60)
}

/// The notes every table page prints: the honesty line.
pub const BANNER: &str = "Simulation and analysis workbench. Not a navigation instrument.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_half_up_and_printing_matches_the_printed_tables() {
        assert_eq!(tenths_half_up(0.25), 3);
        assert_eq!(tenths_half_up(0.35), 4);
        assert_eq!(tenths_half_up(-5.25), -52);
        assert_eq!(tenths_half_up(-5.26), -53);
        assert_eq!(fmt_tenths(153), "15.3");
        assert_eq!(fmt_tenths(-8), "-0.8");
        assert_eq!(fmt_signed_tenths(153), "+15.3");
        assert_eq!(fmt_signed_tenths(0), "0.0");
        assert_eq!(fmt_signed_tenths(-8), "-0.8");
        assert_eq!(fmt_deg_min_tenths(143), "0 14.3");
        assert_eq!(fmt_deg_min_tenths(8792), "14 39.2");
        assert_eq!(fmt_deg_min_tenths(638), "1 03.8");
        assert_eq!(fmt_deg_min_tenths(-123), "-0 12.3");
        assert_eq!(fmt_deg_min_whole(595), "9 55");
        assert_eq!(fmt_deg_min_whole(5400), "90 00");
    }

    #[test]
    fn critical_tables_start_whole_and_ascend_at_boundaries() {
        // A correction that is -(i / 10) rounded: changes every 10 grid points.
        let f = |i: i64| vec![-((i + 5).div_euclid(10))];
        let (b, v) = critical_on_grid(20, 45, 30, f);
        // At 20 the value is -2 (i = 15..=24); the previous run ends at 14.
        assert_eq!(b, vec![14, 24, 34, 44, 45]);
        assert_eq!(v, vec![vec![-2], vec![-3], vec![-4], vec![-5]]);
        let table = CriticalTable {
            argument: "x".into(),
            unit: "m".into(),
            columns: vec!["Corr".into()],
            boundaries: b
                .iter()
                .map(|&x| CriticalArgument {
                    value: x as f64,
                    printed: x.to_string(),
                })
                .collect(),
            values: v
                .iter()
                .map(|r| r.iter().map(|&t| ArcminCell::signed_tenths(t)).collect())
                .collect(),
        };
        // Exactly at a boundary: the value above it.
        assert_eq!(table.lookup(24.0).unwrap()[0].arcmin, -0.2);
        assert_eq!(table.lookup(24.5).unwrap()[0].arcmin, -0.3);
        assert_eq!(table.lookup(14.0), None);
        assert_eq!(table.lookup(45.0).unwrap()[0].arcmin, -0.5);
        assert_eq!(table.lookup(45.1), None);
    }
}
