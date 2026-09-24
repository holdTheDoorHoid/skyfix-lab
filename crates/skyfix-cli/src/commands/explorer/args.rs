//! Flags and value parsers shared by the explorer commands. OWNER: cli agent.
//!
//! Every angle on the command line is degrees and every longitude is east-positive,
//! exactly as in the session files (CONVENTIONS sections 1-2); every instant is RFC 3339
//! UTC with a trailing `Z` (section 6). A value that is not what its flag needs is a
//! usage error (exit 1) naming the value, never a silent default.
//!
//! Southern latitudes and western longitudes start with a minus sign, which clap would
//! read as the start of another flag. `--lat`/`--lon` therefore allow negative numbers,
//! and the comma-separated forms (`--dr`, `--vessel`, `--leg`) allow hyphen values; the
//! parsers below still refuse anything that is not what they expect, so a mistyped flag
//! fails with a message about the value.

use skyfix_almanac::sky;
use skyfix_core::time::{civil_to_jd, parse_utc};
use skyfix_core::types::{DrPosition, HorizonMode, Limb, VesselMotion};
use skyfix_motion::request::RunningFixLeg;

// ---------------------------------------------------------------------------
// --format
// ---------------------------------------------------------------------------

/// `--format` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum OutputFormat {
    /// Plain text for a person: navigator-style angles, UTC with Z, sentences.
    #[default]
    Text,
    /// The engine's own result, as serde emits it (the wire shapes of
    /// docs/EXPLORER_API.md).
    Json,
}

/// `--format text|json`, and `--json` as the older commands spell it.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct FormatArgs {
    /// `text` for a person to read, `json` for a program: the engine's own result, the
    /// wire shape docs/EXPLORER_API.md documents.
    #[arg(long, value_enum, default_value_t = OutputFormat::Text, value_name = "FORMAT")]
    pub format: OutputFormat,
    /// The same as `--format json`.
    #[arg(long, conflicts_with = "format")]
    pub json: bool,
}

impl FormatArgs {
    pub fn is_json(&self) -> bool {
        self.json || self.format == OutputFormat::Json
    }
}

// ---------------------------------------------------------------------------
// Positions and the air
// ---------------------------------------------------------------------------

/// `--lat DEG --lon DEG`.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct PositionArgs {
    /// Latitude, degrees, north positive (-90 to 90).
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lat)]
    pub lat: f64,
    /// Longitude, degrees, EAST positive (-180 to 180): 75.17 W is -75.17.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lon)]
    pub lon: f64,
}

/// The air, for refraction.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct AirArgs {
    /// Air pressure, hPa, for refraction.
    #[arg(long, value_name = "HPA", default_value_t = 1010.0)]
    pub pressure: f64,
    /// Air temperature, degrees Celsius, for refraction.
    #[arg(
        long,
        value_name = "C",
        default_value_t = 10.0,
        allow_negative_numbers = true
    )]
    pub temperature: f64,
}

/// The eye and the instrument, for a predicted sextant reading.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct SightOpticsArgs {
    /// Height of eye above the sea, metres: sets the dip of the sea horizon.
    #[arg(long = "height-of-eye", value_name = "M", default_value_t = 0.0)]
    pub height_of_eye: f64,
    /// Index correction, arcminutes, ADDED to the reading. Index error "on the arc" is a
    /// negative correction (CONVENTIONS section 5).
    #[arg(
        long,
        value_name = "ARCMIN",
        default_value_t = 0.0,
        allow_negative_numbers = true
    )]
    pub ic: f64,
    /// The horizon the sextant is used against.
    #[arg(long, value_enum, default_value_t = HorizonArg::Sea, value_name = "HORIZON")]
    pub horizon: HorizonArg,
    #[command(flatten)]
    pub air: AirArgs,
}

impl SightOpticsArgs {
    pub fn observer(&self, lat_deg: f64, lon_deg: f64) -> skyfix_core::types::SightObserver {
        skyfix_core::types::SightObserver {
            lat_deg,
            lon_deg,
            height_of_eye_m: self.height_of_eye,
            pressure_hpa: self.air.pressure,
            temperature_c: self.air.temperature,
        }
    }

    pub fn instrument(&self) -> skyfix_core::types::Instrument {
        skyfix_core::types::Instrument {
            name: String::new(),
            index_correction_arcmin: self.ic,
            horizon: self.horizon.into(),
        }
    }
}

/// `--horizon` values (CONVENTIONS section 5, step 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum HorizonArg {
    /// The sea horizon: dip from the height of eye.
    #[default]
    Sea,
    /// A reflected artificial horizon: the reading is the double angle, no dip.
    #[value(alias = "artificial")]
    ArtificialReflected,
    /// An electronic or bubble vertical: no dip.
    #[value(alias = "electronic")]
    ElectronicVertical,
}

impl From<HorizonArg> for HorizonMode {
    fn from(h: HorizonArg) -> Self {
        match h {
            HorizonArg::Sea => HorizonMode::Sea,
            HorizonArg::ArtificialReflected => HorizonMode::ArtificialReflected,
            HorizonArg::ElectronicVertical => HorizonMode::ElectronicVertical,
        }
    }
}

/// `--limb` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum LimbArg {
    /// The centre (every planet and star).
    #[default]
    #[value(alias = "centre")]
    Center,
    /// The lower limb of the Sun or the Moon.
    Lower,
    /// The upper limb of the Sun or the Moon.
    Upper,
}

impl From<LimbArg> for Limb {
    fn from(l: LimbArg) -> Self {
        match l {
            LimbArg::Center => Limb::Center,
            LimbArg::Lower => Limb::Lower,
            LimbArg::Upper => Limb::Upper,
        }
    }
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

fn number(s: &str, what: &str) -> Result<f64, String> {
    let v: f64 = s
        .trim()
        .parse()
        .map_err(|_| format!("{what} {s:?} is not a number"))?;
    if v.is_finite() {
        Ok(v)
    } else {
        Err(format!("{what} {s:?} is not finite"))
    }
}

/// Latitude in degrees, `[-90, 90]`.
pub fn parse_lat(s: &str) -> Result<f64, String> {
    let v = number(s, "latitude")?;
    if (-90.0..=90.0).contains(&v) {
        Ok(v)
    } else {
        Err(format!("latitude {v} is outside [-90, 90]"))
    }
}

/// East longitude in degrees, `[-180, 180]`, with -180 written as +180 so the value is in
/// CONVENTIONS section 1's `(-180, 180]` (the same rule as `skyfix plan --position`).
pub fn parse_lon(s: &str) -> Result<f64, String> {
    let v = number(s, "longitude")?;
    if !(-180.0..=180.0).contains(&v) {
        return Err(format!(
            "longitude {v} is outside [-180, 180] (east positive: 75.17 W is -75.17)"
        ));
    }
    Ok(if v == -180.0 { 180.0 } else { v })
}

/// An RFC 3339 UTC instant with a trailing `Z`, as a `jd_utc`.
pub fn parse_instant(s: &str) -> Result<f64, String> {
    parse_utc(s).map_err(|_| {
        format!("{s:?} is not an RFC 3339 UTC instant with a trailing Z, e.g. 2026-10-01T01:30:00Z")
    })
}

/// A calendar date, `YYYY-MM-DD`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Date {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl Date {
    /// `jd_utc` of 00:00 UTC on this date.
    pub fn jd0(self) -> f64 {
        civil_to_jd(self.year, self.month, self.day)
    }
}

impl std::fmt::Display for Date {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// `YYYY-MM-DD`, a real calendar date (2026-02-30 is refused).
pub fn parse_date(s: &str) -> Result<Date, String> {
    let t = s.trim();
    let bad = || format!("{s:?} is not a date in the form YYYY-MM-DD");
    let parts: Vec<&str> = t.split('-').collect();
    if parts.len() != 3
        || parts[0].len() != 4
        || parts[1].len() != 2
        || parts[2].len() != 2
        || !parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(bad());
    }
    let year: i32 = parts[0].parse().map_err(|_| bad())?;
    let month: u32 = parts[1].parse().map_err(|_| bad())?;
    let day: u32 = parts[2].parse().map_err(|_| bad())?;
    // The core's own RFC 3339 parser knows the calendar (month lengths, leap years).
    parse_utc(&format!("{t}T00:00:00Z"))
        .map_err(|_| format!("{s:?} is not a real calendar date"))?;
    Ok(Date { year, month, day })
}

/// One end of a time window: a whole date, or an instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum When {
    Date(Date),
    Instant(f64),
}

impl When {
    /// As the start of a window: a date means 00:00 UTC on it.
    pub fn start_jd(self) -> f64 {
        match self {
            When::Date(d) => d.jd0(),
            When::Instant(jd) => jd,
        }
    }

    /// As the end of a window: a date means the END of it, 00:00 UTC the next day, so
    /// `--from 2026-10-01 --to 2026-10-31` is the whole of October.
    pub fn end_jd(self) -> f64 {
        match self {
            When::Date(d) => d.jd0() + 1.0,
            When::Instant(jd) => jd,
        }
    }
}

/// `YYYY-MM-DD` or an RFC 3339 UTC instant.
pub fn parse_when(s: &str) -> Result<When, String> {
    if s.contains('T') {
        parse_instant(s).map(When::Instant)
    } else {
        parse_date(s)
            .map(When::Date)
            .map_err(|e| format!("{e}, nor an RFC 3339 UTC instant such as 2026-10-01T01:30:00Z"))
    }
}

/// `LAT,LON[,SIGMA_NM]`: a DR position and, when stated, its 1-sigma error in each of
/// north and east, nautical miles.
pub fn parse_dr(s: &str) -> Result<DrPosition, String> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    if !(2..=3).contains(&parts.len()) {
        return Err(format!(
            "expected LAT,LON or LAT,LON,SIGMA_NM (degrees, east-positive longitude), got {s:?}"
        ));
    }
    let sigma_nm = match parts.get(2) {
        Some(p) => {
            let v = number(p, "DR sigma_nm")?;
            if v <= 0.0 {
                return Err(format!(
                    "a DR sigma is a positive 1-sigma error in nautical miles, got {v}; leave \
                     it out when it is not known"
                ));
            }
            Some(v)
        }
        None => None,
    };
    Ok(DrPosition {
        lat_deg: parse_lat(parts[0])?,
        lon_deg: parse_lon(parts[1])?,
        sigma_nm,
    })
}

/// `COURSE,SPEED`: degrees true and knots over the ground.
pub fn parse_vessel(s: &str) -> Result<VesselMotion, String> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    if parts.len() != 2 {
        return Err(format!(
            "expected COURSE,SPEED (degrees true, knots), got {s:?}"
        ));
    }
    let (course_deg, speed_kn) = course_speed(parts[0], parts[1])?;
    Ok(VesselMotion {
        course_deg,
        speed_kn,
    })
}

fn course_speed(course: &str, speed: &str) -> Result<(f64, f64), String> {
    let c = number(course, "course")?;
    if !(0.0..=360.0).contains(&c) {
        return Err(format!("course {c} is outside 0 to 360 degrees true"));
    }
    let v = number(speed, "speed")?;
    if v < 0.0 {
        return Err(format!(
            "speed {v} is negative; give the course the vessel made good"
        ));
    }
    Ok((c, v))
}

/// `[START_UTC,]COURSE,SPEED`: one dead-reckoning leg. Only the first leg may leave out
/// its start (it then starts at the earliest sight); the engine enforces that.
pub fn parse_leg(s: &str) -> Result<RunningFixLeg, String> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    let (start_utc, course, speed) = match parts.as_slice() {
        [course, speed] => (None, *course, *speed),
        [start, course, speed] => {
            parse_instant(start)?;
            (Some(start.to_string()), *course, *speed)
        }
        _ => {
            return Err(format!(
                "expected [START_UTC,]COURSE,SPEED, e.g. 2026-10-01T00:00:00Z,45,12, got {s:?}"
            ));
        }
    };
    let (course_deg, speed_kn) = course_speed(course, speed)?;
    Ok(RunningFixLeg {
        start_utc,
        course_deg,
        speed_kn,
    })
}

/// A resolved `--bodies` list: canonical names, in the order given, no duplicates.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyList(pub Vec<&'static str>);

/// `all`, `solar_system`, `navigational`, or a comma-separated list of names and
/// groups. Names match case-insensitively (stars also as `HIP <number>`); `solar-system`
/// is accepted for `solar_system`.
pub fn parse_bodies(s: &str) -> Result<BodyList, String> {
    let mut out: Vec<&'static str> = Vec::new();
    for item in s.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err(format!("--bodies {s:?} has an empty name in it"));
        }
        let names = match sky::body_group(item).or_else(|| sky::body_group(&item.replace('-', "_")))
        {
            Some(group) => group,
            None => sky::resolve_bodies(&[item]).map_err(|e| {
                format!(
                    "{e}. The groups are all, solar_system and navigational; `skyfix catalog` \
                     lists the star names"
                )
            })?,
        };
        for n in names {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    if out.is_empty() {
        return Err("--bodies names no body".to_string());
    }
    Ok(BodyList(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latitudes_and_longitudes_are_checked_and_normalised() {
        assert_eq!(parse_lat("-33.87").unwrap(), -33.87);
        assert!(parse_lat("91").is_err() && parse_lat("north").is_err());
        assert!(parse_lat("nan").is_err());
        assert_eq!(parse_lon("-75.1652").unwrap(), -75.1652);
        assert_eq!(parse_lon("-180").unwrap(), 180.0);
        assert!(parse_lon("181").is_err());
    }

    #[test]
    fn dates_must_be_real_and_in_one_form() {
        assert_eq!(
            parse_date("2026-09-24").unwrap(),
            Date {
                year: 2026,
                month: 9,
                day: 24
            }
        );
        assert_eq!(parse_date("2026-09-24").unwrap().to_string(), "2026-09-24");
        for bad in [
            "2026-02-30",
            "2026-9-24",
            "24/09/2026",
            "2026-09-24T00:00:00Z",
            "",
        ] {
            assert!(parse_date(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_date_ends_a_window_at_the_next_midnight() {
        let w = parse_when("2026-10-31").unwrap();
        assert_eq!(w.end_jd() - w.start_jd(), 1.0);
        let i = parse_when("2026-10-01T12:00:00Z").unwrap();
        assert_eq!(i.start_jd(), i.end_jd());
        assert!(parse_when("2026-10-01T12:00:00").is_err());
    }

    #[test]
    fn a_dr_may_carry_a_sigma_and_a_vessel_needs_both_numbers() {
        let d = parse_dr("39.7793,-75.2953,10").unwrap();
        assert_eq!(
            (d.lat_deg, d.lon_deg, d.sigma_nm),
            (39.7793, -75.2953, Some(10.0))
        );
        assert_eq!(parse_dr("40,-75").unwrap().sigma_nm, None);
        assert!(parse_dr("40,-75,0").is_err());
        assert!(parse_dr("40").is_err());
        let v = parse_vessel("45,12").unwrap();
        assert_eq!((v.course_deg, v.speed_kn), (45.0, 12.0));
        assert!(parse_vessel("45").is_err() && parse_vessel("400,12").is_err());
        assert!(parse_vessel("45,-3").is_err());
    }

    #[test]
    fn legs_take_an_optional_start() {
        let l = parse_leg("45,12").unwrap();
        assert_eq!((l.start_utc, l.course_deg, l.speed_kn), (None, 45.0, 12.0));
        let l = parse_leg("2026-10-01T02:00:00Z, 90, 10").unwrap();
        assert_eq!(l.start_utc.as_deref(), Some("2026-10-01T02:00:00Z"));
        assert!(parse_leg("yesterday,90,10").is_err());
        assert!(parse_leg("90").is_err());
    }

    #[test]
    fn body_lists_take_groups_and_names_in_order_without_duplicates() {
        assert_eq!(parse_bodies("all").unwrap().0.len(), 67);
        assert_eq!(parse_bodies("solar-system").unwrap().0.len(), 9);
        assert_eq!(parse_bodies("navigational").unwrap().0.len(), 64);
        assert_eq!(
            parse_bodies(" vega, SUN,Vega , hip 32349").unwrap().0,
            vec!["Vega", "Sun", "Sirius"]
        );
        let e = parse_bodies("Sun,Vulcan").unwrap_err();
        assert!(e.contains("Vulcan") && e.contains("skyfix catalog"), "{e}");
        assert!(parse_bodies("Sun,,Moon").is_err());
    }
}
