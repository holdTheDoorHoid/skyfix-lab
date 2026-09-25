//! The Polaris (Pole Star) tables for a calendar year: a0, a1, a2 and the azimuth.
//!
//! The Nautical Almanac's explanation of these tables gives the formula they tabulate:
//!
//! ```text
//! Latitude − Ho = −p cos h + ½ p sin p sin² h tan(Latitude)
//! a0 = 58.8′ − p0 cos h0 + ½ p0 sin p0 sin² h0 tan 50°     (LHA Aries)
//! a1 =  0.6′ + ½ p0 sin p0 sin² h0 (tan φ − tan 50°)         (LHA Aries, latitude)
//! a2 =  0.6′ − p cos h + p0 cos h0                            (LHA Aries, date)
//! Latitude = Ho − 1° + a0 + a1 + a2
//! ```
//!
//! with `p = 90° − Dec` Polaris' polar distance, `h = LHA Aries + SHA` its hour angle, and
//! `p0`, `h0` from an adopted mean position for the year. This module follows the
//! printed layout exactly: 36 columns of 10° of LHA Aries; in each, a0 for every whole
//! degree (rows 0 to 10, the last repeating the next column's first), a1 for latitudes
//! 0°–68°, a2 for each month, and the azimuth for latitudes 0°–65°.
//!
//! - **Adopted mean position**: the mean of Polaris' apparent SHA and Dec at 0h UT every 5
//!   days through the year (73 samples from January 1), the definition this project's
//!   Polaris method already uses for its teaching terms
//!   (`skyfix_core::methods::polaris::almanac_terms`).
//! - **a1, a2 and the azimuth** are computed for the middle of each column (its first
//!   degree + 5°); **a2** with Polaris' apparent place at the middle of the month; the
//!   **azimuth** from the mean position, `tan Z = −sin h / (cos φ tan δ − sin φ cos h)`.
//!
//! Against the printed 2016 page (LHA 120°–239°, as Bowditch reproduces it): every a1 and
//! every azimuth is identical. The printed page's adopted mean position, recovered from
//! its a0 column (with it the formula prints all 132 entries), is SHA 316° 47′,
//! Dec N 89° 20.0′, rounded values; this module's differs by 1.9′ of SHA and 0.09′ of Dec,
//! so a0 and a2 split the same total differently and the sum a0 + a2 agrees with the
//! printed page within 0.1′ everywhere.
//!
//! The formula is second order in `p`. Its own error, reported for the year as
//! `formula_error_arcmin` (the worst over latitudes 0°–68° and every hour angle), is
//! 0.006′ in 2026 and passes 0.1′ when Polaris is more than about 1.6° from the pole
//! (before about 1800 and after about 2450): the table then carries a warning.

use serde::{Deserialize, Serialize};
use skyfix_core::calendar::{Calendar, days_in_month};
use skyfix_core::units::{norm_180, norm_360};
use skyfix_ephemeris::body::{BodyEphemeris, SUN};

use super::planets::jd_of;
use super::{ArcminCell, BANNER, DegCell, fmt_deg_min_tenths, tenths_half_up};
use crate::pages::fmt_dec;
use crate::sky::AlmanacError;

/// Latitudes of the a1 rows, degrees north.
pub const A1_LATITUDES: [f64; 13] = [
    0.0, 10.0, 20.0, 30.0, 40.0, 45.0, 50.0, 55.0, 60.0, 62.0, 64.0, 66.0, 68.0,
];
/// Latitudes of the azimuth rows, degrees north.
pub const AZIMUTH_LATITUDES: [f64; 7] = [0.0, 20.0, 40.0, 50.0, 55.0, 60.0, 65.0];
/// Samples of the adopted mean position: every 5 days from January 1.
pub const MEAN_SAMPLES: usize = 73;
/// Beyond this formula error the table carries a warning, arcminutes.
pub const FORMULA_WARNING_ARCMIN: f64 = 0.1;

/// Polaris' apparent place in the middle of a month (for a2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonthPlace {
    pub month: u32,
    pub jd_utc: f64,
    pub sha_deg: f64,
    pub dec_deg: f64,
}

/// One 10° column of LHA Aries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolarisColumn {
    /// 0, 10, …, 350.
    pub from_deg: u32,
    /// 11 rows: LHA Aries `from_deg` + 0 … + 10, printed `0 49.9`.
    pub a0: Vec<ArcminCell>,
    /// One per [`A1_LATITUDES`], printed `0.3`.
    pub a1: Vec<ArcminCell>,
    /// January to December.
    pub a2: Vec<ArcminCell>,
    /// One per [`AZIMUTH_LATITUDES`], printed `359.3`.
    pub azimuth: Vec<DegCell>,
}

/// The adopted mean position as printed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeanPositionText {
    pub sha: String,
    pub dec: String,
}

/// The worked example, computed with this table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolarisExample {
    pub text: String,
    pub lha_aries_deg: f64,
    pub a0_arcmin: f64,
    pub a1_arcmin: f64,
    pub a2_arcmin: f64,
    pub latitude_deg: f64,
    /// The latitude solved rigorously from the same altitude, for comparison.
    pub rigorous_latitude_deg: f64,
}

/// The Polaris tables for a year.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolarisTable {
    pub year: i64,
    pub calendar: Calendar,
    pub mean_sha_deg: f64,
    pub mean_dec_deg: f64,
    pub printed_mean: MeanPositionText,
    pub polar_distance_arcmin: f64,
    /// The second-order formula's own worst error this year, arcminutes.
    pub formula_error_arcmin: f64,
    pub a1_latitudes: Vec<f64>,
    pub azimuth_latitudes: Vec<f64>,
    pub months: Vec<MonthPlace>,
    /// 36 columns, LHA Aries 0°–9° to 350°–359°.
    pub columns: Vec<PolarisColumn>,
    pub how_to_use: String,
    pub example: Option<PolarisExample>,
    pub notes: Vec<String>,
    pub warnings: Vec<String>,
}

fn tan50() -> f64 {
    50f64.to_radians().tan()
}

/// `½ p0 sin p0 sin² h0` (arcminutes), the second term without its `tan`.
fn second(p0_arcmin: f64, h0_deg: f64) -> f64 {
    0.5 * p0_arcmin * (p0_arcmin / 60.0).to_radians().sin() * h0_deg.to_radians().sin().powi(2)
}

/// a0 for LHA Aries `lha_deg`.
pub fn a0_arcmin(lha_deg: f64, sha0_deg: f64, dec0_deg: f64) -> f64 {
    let p0 = (90.0 - dec0_deg) * 60.0;
    let h0 = lha_deg + sha0_deg;
    58.8 - p0 * h0.to_radians().cos() + second(p0, h0) * tan50()
}

/// a1 for LHA Aries `lha_deg` and latitude `lat_deg`.
pub fn a1_arcmin(lha_deg: f64, lat_deg: f64, sha0_deg: f64, dec0_deg: f64) -> f64 {
    let p0 = (90.0 - dec0_deg) * 60.0;
    let h0 = lha_deg + sha0_deg;
    0.6 + second(p0, h0) * (lat_deg.to_radians().tan() - tan50())
}

/// a2 for LHA Aries `lha_deg` with Polaris at `(sha_deg, dec_deg)`.
pub fn a2_arcmin(lha_deg: f64, sha_deg: f64, dec_deg: f64, sha0_deg: f64, dec0_deg: f64) -> f64 {
    let p = (90.0 - dec_deg) * 60.0;
    let p0 = (90.0 - dec0_deg) * 60.0;
    0.6 - p * (lha_deg + sha_deg).to_radians().cos() + p0 * (lha_deg + sha0_deg).to_radians().cos()
}

/// Polaris' true azimuth from latitude `lat_deg`, degrees `[0, 360)`.
pub fn azimuth_deg(lha_deg: f64, lat_deg: f64, sha_deg: f64, dec_deg: f64) -> f64 {
    let h = (lha_deg + sha_deg).to_radians();
    let (phi, dec) = (lat_deg.to_radians(), dec_deg.to_radians());
    norm_360(
        (-h.sin())
            .atan2(phi.cos() * dec.tan() - phi.sin() * h.cos())
            .to_degrees(),
    )
}

/// The latitude solved exactly from `sin Ho = sin φ sin δ + cos φ cos δ cos h`, near `Ho`.
pub fn rigorous_latitude_deg(ho_deg: f64, dec_deg: f64, h_deg: f64) -> f64 {
    let (dec, h, ho) = (
        dec_deg.to_radians(),
        h_deg.to_radians(),
        ho_deg.to_radians(),
    );
    let mut phi = ho;
    for _ in 0..40 {
        let f = phi.sin() * dec.sin() + phi.cos() * dec.cos() * h.cos() - ho.sin();
        let fp = phi.cos() * dec.sin() - phi.sin() * dec.cos() * h.cos();
        let step = f / fp;
        phi -= step;
        if step.abs() < 1e-15 {
            break;
        }
    }
    phi.to_degrees()
}

/// The second-order formula's worst error for a polar distance, over latitudes 0°–68°
/// and hour angles every 2°, arcminutes.
pub fn formula_error_arcmin(p_deg: f64) -> f64 {
    let dec = 90.0 - p_deg;
    let p = p_deg * 60.0;
    let mut worst: f64 = 0.0;
    for lat in 0..=68 {
        let phi = f64::from(lat).to_radians();
        for k in 0..180 {
            let h = f64::from(2 * k);
            let hr = h.to_radians();
            let sin_ho =
                phi.sin() * dec.to_radians().sin() + phi.cos() * dec.to_radians().cos() * hr.cos();
            let ho = sin_ho.clamp(-1.0, 1.0).asin().to_degrees();
            let formula = ho
                + (-p * hr.cos()
                    + 0.5 * p * (p / 60.0).to_radians().sin() * hr.sin().powi(2) * phi.tan())
                    / 60.0;
            worst = worst.max((formula - f64::from(lat)).abs() * 60.0);
        }
    }
    worst
}

fn azimuth_cell(deg: f64) -> DegCell {
    let t = tenths_half_up(deg).rem_euclid(3600);
    DegCell {
        deg,
        printed: format!("{}.{}", t / 10, t % 10),
    }
}

/// Linear interpolation of a0 between whole degrees, as the navigator does.
fn a0_interpolated(columns: &[PolarisColumn], lha: f64) -> f64 {
    let lha = norm_360(lha);
    let d = lha.floor();
    let col = (d as usize / 10).min(35);
    let row = d as usize - 10 * col;
    let v = |r: usize| -> f64 {
        let text = &columns[col].a0[r].printed;
        let neg = text.starts_with('-');
        let parts: Vec<f64> = text
            .trim_start_matches('-')
            .split(' ')
            .map(|x| x.parse().unwrap_or(0.0))
            .collect();
        let m = parts[0] * 60.0 + parts.get(1).copied().unwrap_or(0.0);
        if neg { -m } else { m }
    };
    v(row) + (lha - d) * (v(row + 1) - v(row))
}

/// The Polaris tables for `year` in `calendar`.
pub fn polaris_table(
    eph: &dyn BodyEphemeris,
    year: i64,
    calendar: Calendar,
) -> Result<PolarisTable, AlmanacError> {
    if !(-100_000..=100_000).contains(&year) {
        return Err(AlmanacError::Invalid(format!(
            "year {year} is out of range"
        )));
    }
    let unavailable = |e: skyfix_ephemeris::EphemerisError| AlmanacError::Unavailable {
        body: "Polaris".to_string(),
        message: format!("{e}; the Polaris tables for {year} need its place through the year"),
    };
    let start = jd_of(calendar, year, 1, 1);
    // The adopted mean position.
    let mut sha_sum = 0.0;
    let mut dec_sum = 0.0;
    let mut first: Option<f64> = None;
    for k in 0..MEAN_SAMPLES {
        let st = eph
            .apparent_state("Polaris", start + 5.0 * k as f64)
            .map_err(unavailable)?;
        let s = st.sha_deg();
        let f = *first.get_or_insert(s);
        sha_sum += f + norm_180(s - f);
        dec_sum += st.dec_deg;
    }
    let n = MEAN_SAMPLES as f64;
    let (sha0, dec0) = (norm_360(sha_sum / n), dec_sum / n);
    // Polaris in the middle of each month.
    let mut months = Vec::with_capacity(12);
    for m in 1..=12u32 {
        let days = days_in_month(calendar, year, m).unwrap_or(30);
        let jd = jd_of(calendar, year, m, 1) + f64::from(days) / 2.0;
        let st = eph.apparent_state("Polaris", jd).map_err(unavailable)?;
        months.push(MonthPlace {
            month: m,
            jd_utc: jd,
            sha_deg: st.sha_deg(),
            dec_deg: st.dec_deg,
        });
    }
    let columns: Vec<PolarisColumn> = (0..36u32)
        .map(|c| {
            let from = f64::from(10 * c);
            let mid = from + 5.0;
            PolarisColumn {
                from_deg: 10 * c,
                a0: (0..=10)
                    .map(|r| ArcminCell::deg_min(a0_arcmin(from + f64::from(r), sha0, dec0)))
                    .collect(),
                a1: A1_LATITUDES
                    .iter()
                    .map(|&lat| ArcminCell::plain(a1_arcmin(mid, lat, sha0, dec0)))
                    .collect(),
                a2: months
                    .iter()
                    .map(|m| ArcminCell::plain(a2_arcmin(mid, m.sha_deg, m.dec_deg, sha0, dec0)))
                    .collect(),
                azimuth: AZIMUTH_LATITUDES
                    .iter()
                    .map(|&lat| azimuth_cell(azimuth_deg(mid, lat, sha0, dec0)))
                    .collect(),
            }
        })
        .collect();
    let polar_distance_arcmin = (90.0 - dec0) * 60.0;
    let formula_error = formula_error_arcmin(90.0 - dec0);
    let mut warnings = Vec::new();
    if formula_error > FORMULA_WARNING_ARCMIN {
        warnings.push(format!(
            "Polaris is {:.2}° from the pole in {year}: the tables' second-order formula is off \
             by up to {formula_error:.2}′ this year. Use the latitude solved exactly (Navigate, \
             Polaris) rather than these tables.",
            polar_distance_arcmin / 60.0
        ));
    }
    // The worked example: the Nautical Almanac's own illustration (2016 April 21,
    // 23h 18m 56s UT, W 37° 14′, Ho 49° 31.6′), for this year.
    let example = (|| -> Option<PolarisExample> {
        let jd = jd_of(calendar, year, 4, 21) + (23.0 + 18.0 / 60.0 + 56.0 / 3600.0) / 24.0;
        let sun = eph.apparent_state(SUN, jd).ok()?;
        let gha_aries = norm_360(sun.gha_deg + sun.ra_deg);
        let lon = -(37.0 + 14.0 / 60.0);
        let lha = norm_360(gha_aries + lon);
        let ho = 49.0 + 31.6 / 60.0;
        let col = (lha / 10.0).floor() as usize % 36;
        let a0 = a0_interpolated(&columns, lha);
        let a1: f64 = columns[col].a1[6].printed.parse().ok()?;
        let a2: f64 = columns[col].a2[3].printed.parse().ok()?;
        let latitude = ho + (a0 + a1 + a2 - 60.0) / 60.0;
        let polaris = eph.apparent_state("Polaris", jd).ok()?;
        let rigorous = rigorous_latitude_deg(ho, polaris.dec_deg, lha + polaris.sha_deg());
        Some(PolarisExample {
            text: format!(
                "On April 21 at 23h 18m 56s UT in longitude W 37° 14′, Ho of Polaris 49° 31.6′ \
                 (the Nautical Almanac's own illustration, for 2016). LHA Aries {}: a0 {} \
                 (interpolated), a1 {} (latitude 50° approx.), a2 {} (April). Latitude = Ho − 1° \
                 + a0 + a1 + a2 = {}.",
                fmt_deg_min_tenths(tenths_half_up(lha * 60.0)),
                fmt_deg_min_tenths(tenths_half_up(a0)),
                columns[col].a1[6].printed,
                columns[col].a2[3].printed,
                fmt_dec(latitude),
            ),
            lha_aries_deg: lha,
            a0_arcmin: a0,
            a1_arcmin: a1,
            a2_arcmin: a2,
            latitude_deg: latitude,
            rigorous_latitude_deg: rigorous,
        })
    })();
    Ok(PolarisTable {
        year,
        calendar,
        mean_sha_deg: sha0,
        mean_dec_deg: dec0,
        printed_mean: MeanPositionText {
            sha: fmt_deg_min_tenths(tenths_half_up(sha0 * 60.0)),
            dec: fmt_dec(dec0),
        },
        polar_distance_arcmin,
        formula_error_arcmin: formula_error,
        a1_latitudes: A1_LATITUDES.to_vec(),
        azimuth_latitudes: AZIMUTH_LATITUDES.to_vec(),
        months,
        columns,
        how_to_use: "Find LHA Aries for the time of the sight (GHA Aries, from the daily page \
                     and the increments, plus east longitude or minus west). In its 10° column \
                     take a0, interpolating between whole degrees; a1 for the latitude \
                     (nearest row, no need to interpolate); a2 for the month. Latitude = Ho − \
                     1° + a0 + a1 + a2. The azimuth rows give Polaris' true bearing, for \
                     checking a compass."
            .to_string(),
        example,
        notes: vec![
            format!(
                "a0 is for Polaris' mean position in {} (SHA {}, Dec {}) at latitude 50°; a1 \
                 corrects for the latitude and a2 for the month, from the middle of each 10° \
                 column. The three constants 58.8′ + 0.6′ + 0.6′ make 1°.",
                year,
                fmt_deg_min_tenths(tenths_half_up(sha0 * 60.0)),
                fmt_dec(dec0)
            ),
            "The printed Nautical Almanac adopts a slightly different mean position (rounded), \
             so its a0 and a2 can each differ from these by 0.1′ while their sum agrees."
                .to_string(),
            BANNER.to_string(),
        ],
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_ephemeris::body::Sky;

    #[test]
    fn the_2016_illustration_and_bowditch_1912() {
        let t = polaris_table(&Sky::new(), 2016, Calendar::Gregorian).unwrap();
        assert_eq!(t.columns.len(), 36);
        assert!(t.warnings.is_empty());
        assert!(t.formula_error_arcmin < 0.01, "{}", t.formula_error_arcmin);
        let e = t.example.as_ref().unwrap();
        // The Almanac: LHA Aries 162° 57′, a0 1° 18.9′, a1 0.6′, a2 0.9′, latitude 49° 52.0′.
        assert!(
            (e.lha_aries_deg - (162.0 + 57.0 / 60.0)).abs() < 0.5 / 60.0,
            "{}",
            e.lha_aries_deg
        );
        assert!((e.a0_arcmin - 78.9).abs() < 0.06, "{}", e.a0_arcmin);
        assert_eq!(e.a1_arcmin, 0.6);
        assert_eq!(e.a2_arcmin, 0.9);
        assert!((e.latitude_deg - (49.0 + 52.0 / 60.0)).abs() * 60.0 < 0.1);
        assert!((e.latitude_deg - e.rigorous_latitude_deg).abs() * 60.0 < 0.1);
        // Bowditch §1912: column 120°-129°, a1 at 40° 0.5′, a2 in March 0.9′.
        let c = &t.columns[12];
        assert_eq!(c.from_deg, 120);
        assert_eq!(c.a1[4].printed, "0.5");
        assert_eq!(c.a2[2].printed, "0.9");
        // Row 10 repeats the next column's row 0.
        for k in 0..35 {
            assert_eq!(t.columns[k].a0[10].printed, t.columns[k + 1].a0[0].printed);
        }
    }

    #[test]
    fn the_formula_error_grows_as_the_cube_of_the_polar_distance() {
        let e = |p: f64| formula_error_arcmin(p);
        assert!(e(0.64) < 0.01);
        assert!(e(1.5) < 0.1);
        assert!(e(2.0) > 0.15 && e(2.0) < 0.25, "{}", e(2.0));
        // Exact altitude in, exact latitude out.
        let lat = rigorous_latitude_deg(40.0, 89.3, 100.0);
        let back = (lat.to_radians().sin() * 89.3f64.to_radians().sin()
            + lat.to_radians().cos() * 89.3f64.to_radians().cos() * 100f64.to_radians().cos())
        .asin()
        .to_degrees();
        assert!((back - 40.0).abs() < 1e-12);
    }
}
