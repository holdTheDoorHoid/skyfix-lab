//! The Earth's main magnetic field for SkyFix Lab: magnetic variation (declination),
//! dip (inclination), the field's intensities and their annual change, anywhere on or
//! above the Earth from 1900 to 2030, each with the uncertainty the model's makers state.
//!
//! CONVENTIONS section 14.5 is normative for this crate; the wire format is
//! `docs/EXPLORER_API.md`, "Expansion programme — magnetic field and compass error".
//!
//! - **WMM2025** (NOAA NCEI and the British Geological Survey), 2025.0 to 2030.0: the
//!   navigation standard. Degree 12, public domain.
//! - **IGRF-14** (IAGA), 1900.0 to 2030.0: for every earlier date. Degree 10 before 1995,
//!   13 from 2000, linear between five-yearly models, predictive secular variation after
//!   2025.0. CC BY 4.0, credited in `docs/THIRD_PARTY.md`.
//!
//! [`ModelChoice::Auto`] uses WMM2025 inside its span and IGRF-14 before it. Outside
//! 1900.0-2030.0 there is no answer ([`FieldError::Unavailable`], with the reason): the
//! field's past before 1900 and its future after 2030 are not known well enough to show a
//! variation.
//!
//! Signs: declination (variation) east positive, inclination down positive; `north_nt`,
//! `east_nt`, `down_nt` are the geodetic X, Y, Z. Positions are WGS84 geodetic latitude,
//! east longitude and height above the ellipsoid (metres); times are decimal years
//! (see [`decimal_year`]).
//!
//! Validation (`tests/`): the 100 official WMM2025 test values and the technical report's
//! Table 6 and numerical example; IAGA's twelve IGRF-14 test values; the BGS IGRF-14
//! calculator at 25 points from 1900 to 2030; NOAA's Geomag 7.0 sample output at 2015.0.

mod coeffs;
mod models;
#[cfg(test)]
mod reference_tests;
mod sh;
pub mod uncertainty;

use serde::{Deserialize, Serialize};

pub use uncertainty::Uncertainty;

/// First and last decimal years of WMM2025.
pub const WMM2025_SPAN: (f64, f64) = (2025.0, 2030.0);
/// First and last decimal years of IGRF-14.
pub const IGRF14_SPAN: (f64, f64) = (1900.0, 2030.0);
/// Lowest height accepted, metres above the ellipsoid: the WMM's stated practical lower
/// limit (1 km below the sea surface).
pub const MIN_HEIGHT_M: f64 = -1_000.0;
/// Highest height accepted, metres: the WMM military specification's 850 km.
pub const MAX_HEIGHT_M: f64 = 850_000.0;
/// Horizontal intensity below which a compass is unreliable (WMM "blackout zone"), nT.
pub const BLACKOUT_H_NT: f64 = 2_000.0;
/// Horizontal intensity below which compass accuracy may be degraded ("caution zone"), nT.
pub const CAUTION_H_NT: f64 = 6_000.0;

/// A field model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Model {
    #[serde(rename = "WMM2025")]
    Wmm2025,
    #[serde(rename = "IGRF-14")]
    Igrf14,
}

impl Model {
    /// The name as the makers write it.
    pub fn label(self) -> &'static str {
        match self {
            Model::Wmm2025 => "WMM2025",
            Model::Igrf14 => "IGRF-14",
        }
    }

    /// First and last decimal years the model covers.
    pub fn span(self) -> (f64, f64) {
        match self {
            Model::Wmm2025 => WMM2025_SPAN,
            Model::Igrf14 => IGRF14_SPAN,
        }
    }
}

/// Which model to use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelChoice {
    /// WMM2025 from 2025.0 to 2030.0, IGRF-14 from 1900.0 up to 2025.0.
    #[default]
    Auto,
    Wmm2025,
    Igrf14,
}

impl std::str::FromStr for ModelChoice {
    type Err = String;
    fn from_str(s: &str) -> Result<ModelChoice, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(ModelChoice::Auto),
            "wmm" | "wmm2025" | "wmm-2025" => Ok(ModelChoice::Wmm2025),
            "igrf" | "igrf14" | "igrf-14" => Ok(ModelChoice::Igrf14),
            other => Err(format!(
                "unknown magnetic model {other:?}: expected \"auto\", \"wmm2025\" or \"igrf14\""
            )),
        }
    }
}

/// Where a compass stands, by the horizontal intensity (WMM2025 technical report 1.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Zone {
    /// `H >= 6000 nT`.
    Normal,
    /// `2000 <= H < 6000 nT`: compass accuracy may be degraded.
    Caution,
    /// `H < 2000 nT`: compass readings unreliable; declination errors up to 180 degrees.
    Blackout,
}

impl Zone {
    pub fn of(horizontal_nt: f64) -> Zone {
        if horizontal_nt < BLACKOUT_H_NT {
            Zone::Blackout
        } else if horizontal_nt < CAUTION_H_NT {
            Zone::Caution
        } else {
            Zone::Normal
        }
    }
}

/// Annual rate of change of each element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnnualChange {
    pub declination_deg_per_year: f64,
    pub inclination_deg_per_year: f64,
    pub horizontal_nt_per_year: f64,
    pub north_nt_per_year: f64,
    pub east_nt_per_year: f64,
    pub down_nt_per_year: f64,
    pub total_nt_per_year: f64,
}

/// The field at one place and time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MagneticField {
    pub model: Model,
    pub decimal_year: f64,
    pub lat_deg: f64,
    /// East longitude, normalised to (-180, 180].
    pub lon_deg: f64,
    pub height_m: f64,
    /// Magnetic variation: the angle from true north to magnetic north, east positive.
    pub declination_deg: f64,
    /// Dip: the angle of the field below the horizontal, down positive.
    pub inclination_deg: f64,
    pub horizontal_nt: f64,
    /// X, toward geodetic north.
    pub north_nt: f64,
    /// Y, toward east.
    pub east_nt: f64,
    /// Z, down along the ellipsoid normal.
    pub down_nt: f64,
    pub total_nt: f64,
    pub annual_change: AnnualChange,
    pub uncertainty: Uncertainty,
    pub zone: Zone,
    /// The date is past 2025.0, the models' last main-field epoch: the value extrapolates
    /// a forecast rate of change (WMM2025 always is; IGRF-14 after 2025.0).
    pub forecast: bool,
    /// Plain sentences about this value (zones, less certain eras, forecasts).
    pub notes: Vec<String>,
}

/// Why there is no value.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldError {
    /// Malformed input: not a number, or a latitude beyond the poles.
    Invalid(String),
    /// A well-formed request no model answers (the date or the height), with the reason.
    Unavailable(String),
}

impl std::fmt::Display for FieldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FieldError::Invalid(s) | FieldError::Unavailable(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for FieldError {}

/// The model [`ModelChoice`] selects at decimal year `t`, or why none does.
pub fn select_model(t: f64, choice: ModelChoice) -> Result<Model, FieldError> {
    let (w0, w1) = WMM2025_SPAN;
    let (i0, i1) = IGRF14_SPAN;
    let before = || {
        FieldError::Unavailable(format!(
            "No magnetic variation for {}: the models start in 1900 (IGRF-14), and the \
             field's earlier changes are not known well enough to show one.",
            year_words(t)
        ))
    };
    let after = || {
        FieldError::Unavailable(format!(
            "No magnetic variation for {}: WMM2025 and IGRF-14 end in 2030, and the \
             field's later changes cannot be predicted.",
            year_words(t)
        ))
    };
    match choice {
        ModelChoice::Auto => {
            if (w0..=w1).contains(&t) {
                Ok(Model::Wmm2025)
            } else if (i0..w0).contains(&t) {
                Ok(Model::Igrf14)
            } else if t < i0 {
                Err(before())
            } else {
                Err(after())
            }
        }
        ModelChoice::Wmm2025 => {
            if (w0..=w1).contains(&t) {
                Ok(Model::Wmm2025)
            } else {
                Err(FieldError::Unavailable(format!(
                    "WMM2025 covers 2025.0 to 2030.0, not {}; IGRF-14 covers 1900 to 2030.",
                    year_words(t)
                )))
            }
        }
        ModelChoice::Igrf14 => {
            if (i0..=i1).contains(&t) {
                Ok(Model::Igrf14)
            } else if t < i0 {
                Err(before())
            } else {
                Err(after())
            }
        }
    }
}

fn year_words(t: f64) -> String {
    if t.is_finite() && t.abs() < 1e7 {
        format!("{:.1}", t)
    } else {
        format!("{t}")
    }
}

/// The field at a WGS84 geodetic point and decimal year.
pub fn field(
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
    decimal_year: f64,
    choice: ModelChoice,
) -> Result<MagneticField, FieldError> {
    for (name, v) in [
        ("lat_deg", lat_deg),
        ("lon_deg", lon_deg),
        ("height_m", height_m),
        ("decimal_year", decimal_year),
    ] {
        if !v.is_finite() {
            return Err(FieldError::Invalid(format!(
                "{name} must be a finite number, got {v}"
            )));
        }
    }
    if !(-90.0..=90.0).contains(&lat_deg) {
        return Err(FieldError::Invalid(format!(
            "lat_deg {lat_deg} is outside [-90, 90]"
        )));
    }
    let model = select_model(decimal_year, choice)?;
    if !(MIN_HEIGHT_M..=MAX_HEIGHT_M).contains(&height_m) {
        return Err(FieldError::Unavailable(format!(
            "The magnetic models are specified from 1 km below sea level to 850 km above the \
             ellipsoid; {height_m} m is outside that."
        )));
    }
    let gauss = match model {
        Model::Wmm2025 => models::wmm2025_at(decimal_year),
        Model::Igrf14 => models::igrf14_at(decimal_year),
    };
    let lon = normalize_lon(lon_deg);
    let e = sh::elements(&gauss, lat_deg.to_radians(), lon.to_radians(), height_m);
    let uncertainty = match model {
        Model::Wmm2025 => uncertainty::wmm2025(e.h),
        Model::Igrf14 => uncertainty::igrf14(e.h, decimal_year),
    };
    let zone = Zone::of(e.h);
    let forecast = decimal_year > WMM2025_SPAN.0;
    let mut notes = Vec::new();
    match zone {
        Zone::Blackout => notes.push(format!(
            "Blackout zone: the horizontal field is only {:.0} nT (under 2000 nT), so a \
             magnetic compass is unreliable here and the variation can be wrong by tens of \
             degrees (WMM military specification).",
            e.h
        )),
        Zone::Caution => notes.push(format!(
            "Caution zone: the horizontal field is only {:.0} nT (under 6000 nT) near the \
             magnetic pole, so compass accuracy may be degraded.",
            e.h
        )),
        Zone::Normal => {}
    }
    if model == Model::Igrf14 {
        let s = uncertainty::igrf14_era_factor(decimal_year);
        if decimal_year < 1945.0 {
            notes.push(
                "Before 1945 IGRF-14 rests on non-definitive models built from sparse \
                 surveys; the stated uncertainty is widened for that."
                    .to_string(),
            );
        } else if s > 1.05 && decimal_year < 1965.0 {
            notes.push(format!(
                "IGRF-14's models of 1945-1960 are less certain than later ones; the stated \
                 uncertainty is widened {s:.2} times for {}.",
                decimal_year.floor()
            ));
        }
        if forecast {
            notes.push(
                "After 2025.0 IGRF-14 extrapolates a forecast rate of change; WMM2025 is the \
                 navigation model for these years."
                    .to_string(),
            );
        }
    }
    Ok(MagneticField {
        model,
        decimal_year,
        lat_deg,
        lon_deg: lon,
        height_m,
        declination_deg: e.d_rad.to_degrees(),
        inclination_deg: e.i_rad.to_degrees(),
        horizontal_nt: e.h,
        north_nt: e.x,
        east_nt: e.y,
        down_nt: e.z,
        total_nt: e.f,
        annual_change: AnnualChange {
            declination_deg_per_year: e.d_dot_rad.to_degrees(),
            inclination_deg_per_year: e.i_dot_rad.to_degrees(),
            horizontal_nt_per_year: e.h_dot,
            north_nt_per_year: e.x_dot,
            east_nt_per_year: e.y_dot,
            down_nt_per_year: e.z_dot,
            total_nt_per_year: e.f_dot,
        },
        uncertainty,
        zone,
        forecast,
        notes,
    })
}

/// [`field`] at a `jd_utc` instant (the explorer's clock; see [`decimal_year`]).
pub fn field_at_jd(
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
    jd_utc: f64,
    choice: ModelChoice,
) -> Result<MagneticField, FieldError> {
    if !jd_utc.is_finite() {
        return Err(FieldError::Invalid(format!(
            "jd_utc must be a finite number, got {jd_utc}"
        )));
    }
    field(lat_deg, lon_deg, height_m, decimal_year(jd_utc), choice)
}

/// Decimal year of a Julian Date on the UTC-based clock: `Y + (jd - JD(Y-01-01 00:00)) /
/// (days in Y)`, proleptic Gregorian. At 00:00 UTC it equals the WMM software's
/// `Y + (day of year - 1)/(days in year)`; the BGS calculator reads a date as its middle
/// (12:00). The models change by at most a few hundredths of a degree a year, so the
/// convention matters at the level of 0.0003 degree.
pub fn decimal_year(jd_utc: f64) -> f64 {
    let days = jd_utc - 2_440_587.5; // days since 1970-01-01T00:00
    let z = days.floor() as i64;
    let (y, _, _) = civil_from_days(z);
    let start = days_from_civil(y, 1, 1) as f64;
    let end = days_from_civil(y + 1, 1, 1) as f64;
    y as f64 + (days - start) / (end - start)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Proleptic Gregorian `(year, month, day)` of a day number since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn normalize_lon(lon: f64) -> f64 {
    let x = (lon + 180.0).rem_euclid(360.0) - 180.0;
    if x == -180.0 { 180.0 } else { x }
}

/// `11.5° W`, `3.0° E`, or `0.0°` when it rounds to zero: an angle east positive.
pub fn format_east_west(deg: f64, decimals: usize) -> String {
    let scale = 10f64.powi(decimals as i32);
    let rounded = (deg.abs() * scale).round() / scale;
    if rounded == 0.0 {
        format!("{:.*}°", decimals, 0.0)
    } else {
        format!(
            "{:.*}° {}",
            decimals,
            rounded,
            if deg < 0.0 { "W" } else { "E" }
        )
    }
}

impl MagneticField {
    /// `11.5° W`.
    pub fn variation_text(&self) -> String {
        format_east_west(self.declination_deg, 1)
    }

    /// `5.1′ E a year`: the chart's "annual change", in arcminutes.
    pub fn annual_change_text(&self) -> String {
        let arcmin = self.annual_change.declination_deg_per_year * 60.0;
        let rounded = (arcmin.abs() * 10.0).round() / 10.0;
        if rounded == 0.0 {
            "no change a year".to_string()
        } else {
            format!(
                "{rounded:.1}′ {} a year",
                if arcmin < 0.0 { "W" } else { "E" }
            )
        }
    }

    /// `Variation 11.5° W ±0.4° (WMM2025), changing 5.1′ E a year.`
    pub fn sentence(&self) -> String {
        let change = self.annual_change_text();
        let change = if change == "no change a year" {
            "with no measurable annual change".to_string()
        } else {
            format!("changing {change}")
        };
        format!(
            "Variation {} ±{:.1}° ({}), {change}.",
            self.variation_text(),
            self.uncertainty.declination_deg,
            self.model.label()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const J2000: f64 = 2_451_545.0; // 2000-01-01T12:00 UTC

    #[test]
    fn decimal_years_follow_the_calendar() {
        assert!((decimal_year(J2000) - (2000.0 + 0.5 / 366.0)).abs() < 1e-12);
        // 2025-01-01T00:00 and 2030-01-01T00:00.
        assert_eq!(decimal_year(2_460_676.5), 2025.0);
        assert_eq!(decimal_year(2_462_502.5), 2030.0);
        // 1900 is not a leap year; 1900-03-01T00:00 is day 59.
        assert!((decimal_year(2_415_079.5) - (1900.0 + 59.0 / 365.0)).abs() < 1e-12);
        for (y, m, d) in [(1900, 1, 1), (1972, 2, 29), (2024, 12, 31), (2100, 3, 1)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
    }

    #[test]
    fn the_auto_choice_uses_wmm_in_its_span_and_igrf_before() {
        assert_eq!(select_model(2027.3, ModelChoice::Auto), Ok(Model::Wmm2025));
        assert_eq!(select_model(2025.0, ModelChoice::Auto), Ok(Model::Wmm2025));
        assert_eq!(select_model(2030.0, ModelChoice::Auto), Ok(Model::Wmm2025));
        assert_eq!(select_model(2024.99, ModelChoice::Auto), Ok(Model::Igrf14));
        assert_eq!(select_model(1900.0, ModelChoice::Auto), Ok(Model::Igrf14));
        assert_eq!(select_model(2027.0, ModelChoice::Igrf14), Ok(Model::Igrf14));
        for (t, word) in [(1899.9, "1900"), (2030.01, "2030"), (-500.0, "1900")] {
            match select_model(t, ModelChoice::Auto) {
                Err(FieldError::Unavailable(s)) => assert!(s.contains(word), "{s}"),
                other => panic!("{t}: {other:?}"),
            }
        }
        assert!(select_model(2020.0, ModelChoice::Wmm2025).is_err());
        assert_eq!("IGRF-14".parse::<ModelChoice>(), Ok(ModelChoice::Igrf14));
        assert!("chaos".parse::<ModelChoice>().is_err());
    }

    #[test]
    fn bad_input_is_invalid_and_unanswerable_input_is_unavailable() {
        assert!(matches!(
            field(f64::NAN, 0.0, 0.0, 2026.0, ModelChoice::Auto),
            Err(FieldError::Invalid(_))
        ));
        assert!(matches!(
            field(91.0, 0.0, 0.0, 2026.0, ModelChoice::Auto),
            Err(FieldError::Invalid(_))
        ));
        assert!(matches!(
            field(0.0, 0.0, 900_000.0, 2026.0, ModelChoice::Auto),
            Err(FieldError::Unavailable(_))
        ));
        assert!(matches!(
            field(0.0, 0.0, 0.0, 1850.0, ModelChoice::Auto),
            Err(FieldError::Unavailable(_))
        ));
    }

    #[test]
    fn east_west_text_rounds_and_names_the_side() {
        assert_eq!(format_east_west(-11.46, 1), "11.5° W");
        assert_eq!(format_east_west(3.0, 1), "3.0° E");
        assert_eq!(format_east_west(-0.04, 1), "0.0°");
        assert_eq!(format_east_west(0.25, 2), "0.25° E");
    }

    #[test]
    fn philadelphia_in_2026_has_a_westerly_variation_and_a_sentence() {
        let f = field(39.9526, -75.1652, 0.0, 2026.7, ModelChoice::Auto).unwrap();
        assert_eq!(f.model, Model::Wmm2025);
        assert!(
            f.declination_deg < -10.0 && f.declination_deg > -13.0,
            "{f:?}"
        );
        assert_eq!(f.zone, Zone::Normal);
        assert!(f.forecast);
        let s = f.sentence();
        assert!(
            s.starts_with("Variation 1") && s.contains("° W ±0.4° (WMM2025)"),
            "{s}"
        );
        // The same point in 1950 comes from IGRF-14.
        let old = field(39.9526, -75.1652, 0.0, 1950.0, ModelChoice::Auto).unwrap();
        assert_eq!(old.model, Model::Igrf14);
        assert!(!old.forecast);
        assert!(old.uncertainty.declination_deg > f.uncertainty.declination_deg);
    }

    #[test]
    fn at_the_published_dip_poles_the_field_is_vertical_and_the_zone_is_blackout() {
        // WMM2025 technical report, Table 4: model dip poles at 2025.0, to 0.01 degree
        // (about 1 km), where the horizontal field grows some 10 nT per km.
        for (lat, lon) in [(85.76, 139.29), (-63.85, 135.08)] {
            let f = field(lat, lon, 0.0, 2025.0, ModelChoice::Auto).unwrap();
            assert!(f.horizontal_nt < 30.0, "{lat} {lon}: H {}", f.horizontal_nt);
            assert!(f.inclination_deg.abs() > 89.9);
            assert_eq!(f.zone, Zone::Blackout, "{f:?}");
            assert!(f.uncertainty.declination_deg > 90.0);
            assert!(f.notes[0].starts_with("Blackout zone"));
        }
        let lon = field(10.0, 540.0, 0.0, 2026.0, ModelChoice::Auto).unwrap();
        assert_eq!(lon.lon_deg, 180.0);
    }
}
