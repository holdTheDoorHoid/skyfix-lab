//! Altitude Correction Tables for the Sun, stars and planets, dip, and the additional
//! corrections for non-standard conditions (the Nautical Almanac's pages A2–A4 and its
//! inside front cover); the Moon's table is [`super::moon`].
//!
//! # The corrections (CONVENTIONS 5, standard conditions 1010 hPa and 10 °C)
//!
//! - **Stars and planets**: `−R(Ha)`, Bennett's refraction at the apparent altitude.
//! - **Sun**: `−R(Ha) + HP cos Ha ± SD`, with the mean solar parallax `HP` = 8.794″ and
//!   the printed table's two semidiameters: 16.15′ for October to March and 15.9′ for
//!   April to September, the middles of the Sun's semidiameter over each half-year
//!   (16.0′–16.3′ and 15.8′–16.0′). Using them costs at most 0.15′ against the day's
//!   true semidiameter, which the daily page prints. `2 SD` is a whole number of tenths
//!   (32.3′ and 31.8′), so the lower- and upper-limb columns change at the same
//!   altitudes and share one critical table.
//! - **Dip**: `1.76′ √h` for a height of eye `h` in metres (the feet column converts the
//!   height to metres first: `0.9717′ √h_ft`).
//! - **Non-standard conditions**: refraction scales with the air's density,
//!   `f = (P / 1010) × (283 / (273 + T))`, so the additional correction is
//!   `R(Ha) × (1 − f)`. The table is entered with a zone letter: 13 zones A to N (no I)
//!   of equal `f`, each 0.02 wide, zone G centred on standard conditions (`f` = 1), so
//!   zone A is `f` = 1.12 (cold, high pressure) and zone N `f` = 0.88 (hot, low
//!   pressure). The zone chart is the family of lines `P = 1010 f (273 + T) / 283`.
//!
//! # Layouts
//!
//! - 10° to 90°: three critical tables (Sun October–March, Sun April–September, stars
//!   and planets), arguments in whole minutes of arc.
//! - 0° to 10°: a direct table, every 3′ to 1° 30′, every 5′ to 6°, every 10′ to 10°;
//!   interpolate between rows.
//! - Dip: critical tables in metres (2.4–21.4 m) and feet (8.0–70.5 ft), and a short
//!   direct list for heights outside them.
//! - Additional corrections: rows 0° to 50° of apparent altitude, columns A to N.

use serde::{Deserialize, Serialize};
use skyfix_core::corrections::{dip_arcmin, parallax_in_altitude_arcmin, refraction_arcmin};

use super::moon::{MoonTable, moon_table};
use super::{
    ArcminCell, BANNER, CriticalArgument, CriticalTable, critical_on_grid, fmt_deg_min_whole,
    tenths_half_up,
};

/// Standard pressure of the tables, hPa.
pub const STANDARD_PRESSURE_HPA: f64 = 1010.0;
/// Standard temperature of the tables, °C.
pub const STANDARD_TEMPERATURE_C: f64 = 10.0;
/// The printed Sun table's semidiameter for October to March, arcminutes.
pub const SUN_SD_OCT_MAR_ARCMIN: f64 = 16.15;
/// The printed Sun table's semidiameter for April to September, arcminutes.
pub const SUN_SD_APR_SEP_ARCMIN: f64 = 15.9;
/// Mean solar horizontal parallax, 8.794″, in arcminutes.
pub const SUN_HP_ARCMIN: f64 = 8.794 / 60.0;
/// Feet to metres.
pub const M_PER_FT: f64 = 0.3048;
/// The zone letters of the non-standard conditions table.
pub const ZONE_LETTERS: [&str; 13] = [
    "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N",
];
/// Width of a zone in the density factor `f`.
pub const ZONE_WIDTH: f64 = 0.02;
/// The apparent altitudes of the non-standard conditions table, degrees.
pub const ADDITIONAL_ALTITUDES_DEG: [f64; 26] = [
    0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0, 14.0,
    16.0, 18.0, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0,
];

// ---------------------------------------------------------------------------
// The formulas
// ---------------------------------------------------------------------------

/// Standard refraction at apparent altitude `ha_deg`, arcminutes (CONVENTIONS 5 step 3).
pub fn standard_refraction_arcmin(ha_deg: f64) -> f64 {
    refraction_arcmin(ha_deg, STANDARD_PRESSURE_HPA, STANDARD_TEMPERATURE_C)
}

/// The stars and planets correction, arcminutes: `−R(Ha)`.
pub fn star_correction_arcmin(ha_deg: f64) -> f64 {
    -standard_refraction_arcmin(ha_deg)
}

/// The Sun's correction without its semidiameter, arcminutes: `−R(Ha) + HP cos Ha`.
pub fn sun_centre_correction_arcmin(ha_deg: f64) -> f64 {
    -standard_refraction_arcmin(ha_deg) + parallax_in_altitude_arcmin(SUN_HP_ARCMIN, ha_deg)
}

/// The Sun's upper-limb correction in tenths and the lower limb's (`upper + 2 SD`), so
/// that the two columns change together (module docs).
fn sun_limbs_tenths(ha_deg: f64, sd_arcmin: f64) -> (i64, i64) {
    let upper = tenths_half_up(sun_centre_correction_arcmin(ha_deg) - sd_arcmin);
    let two_sd = (2.0 * sd_arcmin * 10.0).round() as i64;
    (upper + two_sd, upper)
}

/// Air density relative to the tables' standard conditions: `(P / 1010) (283 / (273 + T))`.
pub fn density_factor(temperature_c: f64, pressure_hpa: f64) -> f64 {
    (pressure_hpa / STANDARD_PRESSURE_HPA) * (283.0 / (273.0 + temperature_c))
}

/// The zone (index into [`ZONE_LETTERS`]) of a density factor, or `None` outside A to N.
pub fn zone_of_factor(f: f64) -> Option<usize> {
    let k = (6.0 - (f - 1.0) / ZONE_WIDTH).round();
    (0.0..=12.0).contains(&k).then_some(k as usize)
}

/// The density factor at the centre of zone `k` (A = 0).
pub fn zone_factor(k: usize) -> f64 {
    1.0 + (6.0 - k as f64) * ZONE_WIDTH
}

/// The additional correction for non-standard conditions, arcminutes: `R(Ha) (1 − f)`.
pub fn additional_correction_arcmin(ha_deg: f64, f: f64) -> f64 {
    standard_refraction_arcmin(ha_deg) * (1.0 - f)
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// The refraction model the tables use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefractionModel {
    pub model: String,
    pub pressure_hpa: f64,
    pub temperature_c: f64,
}

/// One row of the 0°–10° table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LowRow {
    pub alt_deg: f64,
    /// `0 03`.
    pub printed_alt: String,
    /// Lower and upper limb.
    pub sun_oct_mar: [ArcminCell; 2],
    pub sun_apr_sep: [ArcminCell; 2],
    pub stars_planets: ArcminCell,
}

/// A height of eye outside the dip critical tables.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DipRow {
    pub height: f64,
    pub printed_height: String,
    pub dip: ArcminCell,
}

/// The dip tables.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DipTables {
    pub metres: CriticalTable,
    pub feet: CriticalTable,
    /// Heights in metres below and above the critical table.
    pub more_metres: Vec<DipRow>,
    /// Heights in feet below and above the critical table.
    pub more_feet: Vec<DipRow>,
}

/// One zone of the non-standard conditions table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Zone {
    pub letter: String,
    /// The density factor the zone's corrections are computed for (its centre).
    pub factor: f64,
    pub factor_low: f64,
    pub factor_high: f64,
}

/// One apparent altitude of the non-standard conditions table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdditionalRow {
    pub alt_deg: f64,
    pub printed_alt: String,
    /// `R(Ha)` at standard conditions.
    pub standard_refraction_arcmin: f64,
    /// One correction per zone, A to N.
    pub corrections: Vec<ArcminCell>,
}

/// A temperature and pressure to evaluate exactly (`Conditions` in the request). Any
/// other key is refused, as EXPLORER_API says (verify2: it was silently ignored).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Conditions {
    pub temperature_c: f64,
    pub pressure_hpa: f64,
}

/// The exact additional corrections for given conditions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConditionsResult {
    pub temperature_c: f64,
    pub pressure_hpa: f64,
    pub factor: f64,
    /// The zone letter, or `null` when the conditions are beyond zone A or N.
    pub zone: Option<String>,
    /// One per row of [`AdditionalRefraction::rows`], exact (not the zone's).
    pub corrections: Vec<ArcminCell>,
}

/// The chart's ranges (the view draws the zone lines `P = 1010 f (273 + T) / 283`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoneChart {
    pub temperature_c: [f64; 2],
    pub pressure_hpa: [f64; 2],
}

/// The additional corrections for non-standard temperature and pressure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdditionalRefraction {
    pub zones: Vec<Zone>,
    pub rows: Vec<AdditionalRow>,
    pub chart: ZoneChart,
    pub conditions: Option<ConditionsResult>,
}

/// A worked example, with the numbers the tables themselves give.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Example {
    pub title: String,
    pub text: String,
}

/// Everything on the altitude correction pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AltitudeTables {
    pub refraction: RefractionModel,
    pub sun_sd_oct_mar_arcmin: f64,
    pub sun_sd_apr_sep_arcmin: f64,
    pub sun_hp_arcmin: f64,
    /// 10°–90°, columns lower and upper limb.
    pub sun_oct_mar: CriticalTable,
    pub sun_apr_sep: CriticalTable,
    /// 10°–90°, one column.
    pub stars_planets: CriticalTable,
    /// 0°–10°.
    pub low: Vec<LowRow>,
    pub dip: DipTables,
    pub additional: AdditionalRefraction,
    pub moon: MoonTable,
    pub how_to_use: Vec<String>,
    pub examples: Vec<Example>,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Building the tables
// ---------------------------------------------------------------------------

/// A critical table over whole minutes of apparent altitude, 10° 00′ to 90° 00′.
fn altitude_critical(columns: &[&str], value: impl Fn(f64) -> Vec<i64>) -> CriticalTable {
    let (bounds, values) = critical_on_grid(600, 5400, 120, |i| value(i as f64 / 60.0));
    CriticalTable {
        argument: "apparent altitude".to_string(),
        unit: "deg_min".to_string(),
        columns: columns.iter().map(|c| (*c).to_string()).collect(),
        boundaries: bounds
            .iter()
            .map(|&i| CriticalArgument {
                value: i as f64 / 60.0,
                printed: fmt_deg_min_whole(i),
            })
            .collect(),
        values: values
            .iter()
            .map(|row| row.iter().map(|&t| ArcminCell::signed_tenths(t)).collect())
            .collect(),
    }
}

/// A dip critical table on a grid of 0.1 units of height (`to_m` converts to metres).
fn dip_critical(unit: &str, start_tenths: i64, end_tenths: i64, to_m: f64) -> CriticalTable {
    let dip_tenths = |i: i64| vec![tenths_half_up(-dip_arcmin(i as f64 / 10.0 * to_m))];
    let (bounds, values) = critical_on_grid(start_tenths, end_tenths, 20, dip_tenths);
    CriticalTable {
        argument: "height of eye".to_string(),
        unit: unit.to_string(),
        columns: vec!["Dip".to_string()],
        boundaries: bounds
            .iter()
            .map(|&i| CriticalArgument {
                value: i as f64 / 10.0,
                printed: format!("{}.{}", i / 10, i % 10),
            })
            .collect(),
        values: values
            .iter()
            .map(|row| row.iter().map(|&t| ArcminCell::signed_tenths(t)).collect())
            .collect(),
    }
}

fn dip_rows(heights: &[f64], to_m: f64) -> Vec<DipRow> {
    heights
        .iter()
        .map(|&h| DipRow {
            height: h,
            printed_height: if h.fract() == 0.0 {
                format!("{h:.0}")
            } else {
                format!("{h:.1}")
            },
            dip: ArcminCell::signed(-dip_arcmin(h * to_m)),
        })
        .collect()
}

/// The rows of the 0°–10° table, in whole minutes of arc.
fn low_altitude_minutes() -> Vec<i64> {
    let mut m: Vec<i64> = (0..=90).step_by(3).collect();
    m.extend((95..=360).step_by(5));
    m.extend((370..=600).step_by(10));
    m
}

fn low_row(minutes: i64) -> LowRow {
    let ha = minutes as f64 / 60.0;
    let limbs = |sd: f64| {
        let (lower, upper) = sun_limbs_tenths(ha, sd);
        let x = sun_centre_correction_arcmin(ha);
        [
            ArcminCell {
                arcmin: x + sd,
                printed: super::fmt_signed_tenths(lower),
            },
            ArcminCell {
                arcmin: x - sd,
                printed: super::fmt_signed_tenths(upper),
            },
        ]
    };
    LowRow {
        alt_deg: ha,
        printed_alt: fmt_deg_min_whole(minutes),
        sun_oct_mar: limbs(SUN_SD_OCT_MAR_ARCMIN),
        sun_apr_sep: limbs(SUN_SD_APR_SEP_ARCMIN),
        stars_planets: ArcminCell::signed(star_correction_arcmin(ha)),
    }
}

fn additional(conditions: Option<Conditions>) -> Result<AdditionalRefraction, String> {
    let zones = (0..ZONE_LETTERS.len())
        .map(|k| {
            let f = zone_factor(k);
            Zone {
                letter: ZONE_LETTERS[k].to_string(),
                factor: f,
                factor_low: f - ZONE_WIDTH / 2.0,
                factor_high: f + ZONE_WIDTH / 2.0,
            }
        })
        .collect();
    let rows = ADDITIONAL_ALTITUDES_DEG
        .iter()
        .map(|&ha| AdditionalRow {
            alt_deg: ha,
            printed_alt: fmt_deg_min_whole((ha * 60.0).round() as i64),
            standard_refraction_arcmin: standard_refraction_arcmin(ha),
            corrections: (0..ZONE_LETTERS.len())
                .map(|k| ArcminCell::signed(additional_correction_arcmin(ha, zone_factor(k))))
                .collect(),
        })
        .collect();
    let conditions = match conditions {
        None => None,
        Some(c) => {
            if !(c.temperature_c.is_finite() && c.pressure_hpa.is_finite())
                || c.temperature_c <= -100.0
                || c.temperature_c >= 100.0
                || c.pressure_hpa <= 0.0
                || c.pressure_hpa > 1200.0
            {
                return Err(format!(
                    "conditions must be a temperature between -100 and 100 °C and a pressure \
                     between 0 and 1200 hPa, got {} °C and {} hPa",
                    c.temperature_c, c.pressure_hpa
                ));
            }
            let f = density_factor(c.temperature_c, c.pressure_hpa);
            Some(ConditionsResult {
                temperature_c: c.temperature_c,
                pressure_hpa: c.pressure_hpa,
                factor: f,
                zone: zone_of_factor(f).map(|k| ZONE_LETTERS[k].to_string()),
                corrections: ADDITIONAL_ALTITUDES_DEG
                    .iter()
                    .map(|&ha| ArcminCell::signed(additional_correction_arcmin(ha, f)))
                    .collect(),
            })
        }
    };
    Ok(AdditionalRefraction {
        zones,
        rows,
        chart: ZoneChart {
            temperature_c: [-20.0, 40.0],
            pressure_hpa: [970.0, 1050.0],
        },
        conditions,
    })
}

/// The worked examples, with this table's numbers (inputs from Bowditch vol. 2 ch. 6
/// and vol. 1 ch. 19).
fn examples(t: &AltitudeTables) -> Vec<Example> {
    let lookup = |table: &CriticalTable, ha: f64, col: usize| -> String {
        table
            .lookup(ha)
            .map_or_else(|| "n/a".to_string(), |v| v[col].printed.clone())
    };
    let star = lookup(&t.stars_planets, 50.0 + 26.6 / 60.0, 0);
    let sun = lookup(&t.sun_apr_sep, 51.0 + 20.4 / 60.0, 0);
    let moon_col = &t.moon.columns[3];
    let moon_upper = &moon_col.upper[6 * 3];
    let hp_index = |hp: f64| {
        t.moon
            .hp_rows
            .iter()
            .position(|&h| (h - hp).abs() < 1e-9)
            .unwrap_or(0)
    };
    let (l1, l2) = (
        &moon_col.lower_limb[hp_index(59.4)],
        &moon_col.lower_limb[hp_index(59.7)],
    );
    let l_interp = l1.printed.parse::<f64>().unwrap_or(0.0)
        + (59.6 - 59.4) / 0.3
            * (l2.printed.parse::<f64>().unwrap_or(0.0) - l1.printed.parse::<f64>().unwrap_or(0.0));
    let dip = t
        .dip
        .feet
        .lookup(38.0)
        .map_or_else(|| "n/a".to_string(), |v| v[0].printed.clone());
    vec![
        Example {
            title: "A star".to_string(),
            text: format!(
                "Deneb, apparent altitude 50° 26.6′ (Bowditch §1906): the Stars and Planets \
                 column gives {star}′, so Ho = Ha {star}′."
            ),
        },
        Example {
            title: "The Sun's lower limb".to_string(),
            text: format!(
                "2 June, height of eye 38 ft (dip {dip}′), apparent altitude 51° 20.4′ \
                 (Bowditch vol. 2 §618): the April–September lower-limb column gives {sun}′."
            ),
        },
        Example {
            title: "The Moon's lower limb".to_string(),
            text: format!(
                "Apparent altitude 18° 02.3′, HP 59.6′ (Bowditch vol. 2 §619): the upper part, \
                 18° 00′ row, gives {}′; the lower part, 15°–19° column, L at HP 59.4′ and 59.7′ \
                 gives {}′ and {}′, {:.1}′ at 59.6′. The correction is their sum, added to Ha.",
                moon_upper.printed, l1.printed, l2.printed, l_interp
            ),
        },
    ]
}

/// All the altitude correction tables. `conditions` adds the exact additional
/// corrections for one temperature and pressure.
pub fn altitude_tables(conditions: Option<Conditions>) -> Result<AltitudeTables, String> {
    let sun_oct_mar = altitude_critical(&["Lower limb", "Upper limb"], |ha| {
        let (l, u) = sun_limbs_tenths(ha, SUN_SD_OCT_MAR_ARCMIN);
        vec![l, u]
    });
    let sun_apr_sep = altitude_critical(&["Lower limb", "Upper limb"], |ha| {
        let (l, u) = sun_limbs_tenths(ha, SUN_SD_APR_SEP_ARCMIN);
        vec![l, u]
    });
    let stars_planets = altitude_critical(&["Corr"], |ha| {
        vec![tenths_half_up(star_correction_arcmin(ha))]
    });
    let low = low_altitude_minutes().into_iter().map(low_row).collect();
    let dip = DipTables {
        metres: dip_critical("m", 24, 214, 1.0),
        feet: dip_critical("ft", 80, 705, M_PER_FT),
        more_metres: dip_rows(
            &[
                1.0, 1.5, 2.0, 22.0, 24.0, 26.0, 28.0, 30.0, 32.0, 34.0, 36.0, 38.0, 40.0,
            ],
            1.0,
        ),
        more_feet: dip_rows(
            &[
                2.0, 4.0, 6.0, 75.0, 80.0, 85.0, 90.0, 95.0, 100.0, 105.0, 110.0, 115.0, 120.0,
                125.0, 130.0,
            ],
            M_PER_FT,
        ),
    };
    let mut t = AltitudeTables {
        refraction: RefractionModel {
            model: "Bennett (1982), CONVENTIONS 5".to_string(),
            pressure_hpa: STANDARD_PRESSURE_HPA,
            temperature_c: STANDARD_TEMPERATURE_C,
        },
        sun_sd_oct_mar_arcmin: SUN_SD_OCT_MAR_ARCMIN,
        sun_sd_apr_sep_arcmin: SUN_SD_APR_SEP_ARCMIN,
        sun_hp_arcmin: SUN_HP_ARCMIN,
        sun_oct_mar,
        sun_apr_sep,
        stars_planets,
        low,
        dip,
        additional: additional(conditions)?,
        moon: moon_table(),
        how_to_use: vec![
            "First correct the sextant altitude for index error and dip (the dip table, \
             always subtracted) to get the apparent altitude, Ha."
                .to_string(),
            "Sun, stars and planets: enter the table for the body with Ha (from 10° the \
             critical tables: the correction between the two altitudes either side of Ha; \
             exactly on one, the one above it). Below 10°, the 0°–10° table, interpolating."
                .to_string(),
            "Venus and Mars take the additional correction for the date as well; the Moon has \
             its own two-part table. In unusual temperature or pressure, add the correction \
             for the zone of the conditions."
                .to_string(),
        ],
        examples: Vec::new(),
        notes: vec![
            "Refraction: Bennett (1982) at 1010 hPa and 10 °C, the model this project's own \
             sight reductions use (CONVENTIONS 5). The printed Nautical Almanac's refraction \
             is a slightly different model, so an entry here can differ from the printed one \
             by 0.1′ (the published examples checked differ by at most that), less than \
             refraction near the horizon varies from day to day."
                .to_string(),
            "Sun: mean parallax 8.794″; semidiameter 16.15′ October–March and 15.9′ \
             April–September, as in the printed tables (within 0.15′ of the day's)."
                .to_string(),
            "Dip = 1.76′ √(height in metres); feet are converted to metres first.".to_string(),
            "Non-standard conditions: zones of equal air density f = (P/1010) × 283/(273 + T), \
             each 0.02 wide, zone G at standard conditions. These are this project's zones: \
             the printed almanac draws its own on its graph."
                .to_string(),
            BANNER.to_string(),
        ],
    };
    t.examples = examples(&t);
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_tables_give_the_rounded_correction_for_every_whole_minute() {
        let t = altitude_tables(None).unwrap();
        for m in 601..=5400 {
            let ha = m as f64 / 60.0;
            let star = t.stars_planets.lookup(ha).unwrap()[0].arcmin;
            assert_eq!(
                (star * 10.0).round() as i64,
                tenths_half_up(star_correction_arcmin(ha)),
                "{m}"
            );
            let sun = t.sun_oct_mar.lookup(ha).unwrap();
            let (l, u) = sun_limbs_tenths(ha, SUN_SD_OCT_MAR_ARCMIN);
            assert_eq!((sun[0].arcmin * 10.0).round() as i64, l);
            assert_eq!((sun[1].arcmin * 10.0).round() as i64, u);
        }
        // The first interval begins below 10° and the last ends at 90°.
        for table in [&t.stars_planets, &t.sun_oct_mar, &t.sun_apr_sep] {
            assert!(table.boundaries[0].value < 10.0);
            assert_eq!(table.boundaries.last().unwrap().printed, "90 00");
            assert_eq!(table.boundaries.len(), table.values.len() + 1);
        }
        // Lower minus upper limb is always 2 SD.
        for row in &t.sun_oct_mar.values {
            assert!(((row[0].arcmin - row[1].arcmin) - 32.3).abs() < 1e-9);
        }
        for row in &t.sun_apr_sep.values {
            assert!(((row[0].arcmin - row[1].arcmin) - 31.8).abs() < 1e-9);
        }
    }

    /// Bowditch (vol. 1 ch. 19, 2019; vol. 2 ch. 6, 2024) with the printed tables; the
    /// ones this model reproduces exactly (the others are in the reference test).
    #[test]
    fn published_examples_this_model_reproduces() {
        let t = altitude_tables(None).unwrap();
        let get = |table: &CriticalTable, d: f64, m: f64, col: usize| {
            table.lookup(d + m / 60.0).unwrap()[col].printed.clone()
        };
        assert_eq!(get(&t.stars_planets, 50.0, 26.6, 0), "-0.8"); // Deneb
        assert_eq!(get(&t.stars_planets, 29.0, 35.2, 0), "-1.7"); // Mars 2016
        assert_eq!(get(&t.stars_planets, 44.0, 16.2, 0), "-1.0"); // Venus 2024
        assert_eq!(get(&t.sun_oct_mar, 45.0, 46.2, 0), "+15.3"); // LAN 2016
        assert_eq!(get(&t.sun_apr_sep, 51.0, 20.4, 0), "+15.2"); // Sun L 2024
        assert_eq!(get(&t.sun_apr_sep, 32.0, 42.4, 1), "-17.3"); // Sun U 2024
        assert_eq!(get(&t.sun_apr_sep, 61.0, 25.4, 0), "+15.4"); // back sight 2024
        let dip_ft = |h: f64| t.dip.feet.lookup(h).unwrap()[0].printed.clone();
        for (h, d) in [
            (68.0, "-8.0"),
            (38.0, "-6.0"),
            (45.0, "-6.5"),
            (32.0, "-5.5"),
            (28.0, "-5.1"),
            (50.0, "-6.9"),
            (24.0, "-4.8"),
            (33.0, "-5.6"),
            (17.0, "-4.0"),
        ] {
            assert_eq!(dip_ft(h), d, "{h} ft");
        }
        assert_eq!(t.dip.more_feet[3].printed_height, "75");
    }

    #[test]
    fn zones_and_conditions() {
        assert_eq!(zone_of_factor(1.0), Some(6));
        assert_eq!(ZONE_LETTERS[zone_of_factor(1.0).unwrap()], "G");
        // Bowditch §1907 (88 °F, 982 hPa) is zone M.
        let f = density_factor((88.0 - 32.0) / 1.8, 982.0);
        assert_eq!(ZONE_LETTERS[zone_of_factor(f).unwrap()], "M");
        assert_eq!(zone_of_factor(1.2), None);
        let t = altitude_tables(Some(Conditions {
            temperature_c: (88.0 - 32.0) / 1.8,
            pressure_hpa: 982.0,
        }))
        .unwrap();
        let c = t.additional.conditions.unwrap();
        assert_eq!(c.zone.as_deref(), Some("M"));
        assert!(c.corrections[0].arcmin > 3.0);
        // Zone G is zero everywhere; A negative (more refraction), N positive.
        for row in &t.additional.rows {
            assert_eq!(row.corrections[6].printed, "0.0");
            assert!(row.corrections[0].arcmin < 0.0 && row.corrections[12].arcmin > 0.0);
        }
        assert!(
            altitude_tables(Some(Conditions {
                temperature_c: f64::NAN,
                pressure_hpa: 1000.0
            }))
            .is_err()
        );
    }

    #[test]
    fn the_low_table_is_direct_and_continuous_with_the_critical_one() {
        let t = altitude_tables(None).unwrap();
        assert_eq!(t.low.first().unwrap().printed_alt, "0 00");
        assert_eq!(t.low.last().unwrap().printed_alt, "10 00");
        assert_eq!(t.low.len(), 31 + 54 + 24);
        let last = t.low.last().unwrap();
        let crit = t.stars_planets.lookup(10.0).unwrap();
        assert_eq!(last.stars_planets.printed, crit[0].printed);
    }
}
