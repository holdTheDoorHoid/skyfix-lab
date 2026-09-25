//! Flags and value parsers shared by the explorer commands. OWNER: cli agent.
//!
//! Every angle on the command line is degrees and every longitude is east-positive,
//! exactly as in the session files (CONVENTIONS sections 1-2); every instant is RFC 3339
//! with a trailing `Z` (section 6), years outside 0000-9999 in ISO 8601 expanded form
//! with a sign (`-0584-05-28T12:00:00Z`, section 15.3). A typed date is in the Julian
//! calendar up to 1582-10-04 and the Gregorian from 1582-10-15 unless `--calendar`
//! names one; the wire (JSON output, session files) is always proleptic Gregorian. A
//! value that is not what its flag needs is a usage error (exit 1) naming the value,
//! never a silent default.
//!
//! Southern latitudes and western longitudes start with a minus sign, which clap would
//! read as the start of another flag. `--lat`/`--lon` therefore allow negative numbers,
//! and the comma-separated forms (`--dr`, `--vessel`, `--leg`) allow hyphen values; the
//! parsers below still refuse anything that is not what they expect, so a mistyped flag
//! fails with a message about the value.

use std::ffi::OsString;
use std::sync::atomic::{AtomicU8, Ordering};

use skyfix_almanac::sky;
use skyfix_core::calendar::{self, Calendar};
use skyfix_core::time::{format_utc, parse_date_in, parse_instant_in};
use skyfix_core::types::{DrPosition, HorizonMode, Limb, VesselMotion};
use skyfix_motion::request::RunningFixLeg;

use crate::cli::OutputFormat;

// ---------------------------------------------------------------------------
// --format
// ---------------------------------------------------------------------------

/// `--format text|json` (the one [`OutputFormat`] `almanac` shares), and `--json` as the
/// older commands spell it.
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
// --calendar (CONVENTIONS 15.3)
// ---------------------------------------------------------------------------

/// `--calendar` values: the calendar of the dates typed and printed in this run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum CalendarArg {
    /// The Julian calendar, for every date.
    Julian,
    /// The Gregorian calendar, proleptic before 1582-10-15 (ISO 8601).
    Gregorian,
}

impl From<CalendarArg> for Calendar {
    fn from(c: CalendarArg) -> Self {
        match c {
            CalendarArg::Julian => Calendar::Julian,
            CalendarArg::Gregorian => Calendar::Gregorian,
        }
    }
}

/// The run's `--calendar`: 0 none (the display rule), 1 Julian, 2 Gregorian.
static CALENDAR: AtomicU8 = AtomicU8::new(0);

/// Set the run's calendar (`None`: Julian before 1582-10-15, Gregorian from it).
pub fn set_calendar(choice: Option<Calendar>) {
    let v = match choice {
        None => 0,
        Some(Calendar::Julian) => 1,
        Some(Calendar::Gregorian) => 2,
    };
    CALENDAR.store(v, Ordering::Relaxed);
}

/// The run's `--calendar`, or `None` for the display rule.
pub fn calendar_choice() -> Option<Calendar> {
    match CALENDAR.load(Ordering::Relaxed) {
        1 => Some(Calendar::Julian),
        2 => Some(Calendar::Gregorian),
        _ => None,
    }
}

/// `--calendar VALUE` or `--calendar=VALUE` in the raw arguments: `main` reads it before
/// clap parses them (the date flags' value parsers need it, and clap runs them in
/// order) and passes it to [`set_calendar`]. A value clap will refuse is ignored here.
pub fn scan_calendar<I: IntoIterator<Item = OsString>>(args: I) -> Option<Calendar> {
    let mut it = args.into_iter().map(|a| a.to_string_lossy().into_owned());
    let mut choice = None;
    while let Some(a) = it.next() {
        if a == "--" {
            break;
        }
        let value = if a == "--calendar" {
            it.next()
        } else {
            a.strip_prefix("--calendar=").map(str::to_string)
        };
        if let Some(c) = value.and_then(|v| v.parse::<Calendar>().ok()) {
            choice = Some(c);
        }
    }
    choice
}

/// The calendar a typed civil date is in: `choice`, else Julian up to 1582-10-04 and
/// Gregorian from 1582-10-15. The ten days between were in neither calendar where the
/// reform took effect, so without `--calendar` they are refused.
pub fn calendar_of_typed(
    choice: Option<Calendar>,
    year: i64,
    month: u32,
    day: u32,
) -> Result<Calendar, String> {
    if let Some(c) = choice {
        return Ok(c);
    }
    let key = (year, month, day);
    if key >= (1582, 10, 15) {
        Ok(Calendar::Gregorian)
    } else if key <= (1582, 10, 4) {
        Ok(Calendar::Julian)
    } else {
        Err(format!(
            "{} is in neither calendar as used: the Julian calendar ended on 1582-10-04 and \
             the Gregorian began on 1582-10-15; say which you mean with --calendar julian or \
             --calendar gregorian",
            ymd(year, month, day)
        ))
    }
}

fn ymd(year: i64, month: u32, day: u32) -> String {
    format!("{}-{month:02}-{day:02}", calendar::format_year(year))
}

/// `(year, month, day)` of `YYYY-MM-DD` (or its expanded form), checked only for shape
/// and for a day that exists in one calendar or the other.
fn raw_date(s: &str) -> Option<(i64, u32, u32)> {
    parse_date_in(s, Calendar::Julian).or_else(|| parse_date_in(s, Calendar::Gregorian))
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

/// `--lat DEG --lon DEG [--height M]`, all optional: the observer of a command that also
/// answers without one (`eclipses`, `eclipse`). Latitude and longitude come together or
/// not at all, and a height needs them.
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct OptionalSiteArgs {
    /// Observer's latitude, degrees, north positive (-90 to 90). With --lon, adds what that
    /// place sees.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lat, requires = "lon")]
    pub lat: Option<f64>,
    /// Observer's longitude, degrees, EAST positive (-180 to 180): 75.17 W is -75.17.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lon, requires = "lat")]
    pub lon: Option<f64>,
    /// Height of the site above the WGS84 ellipsoid, metres; not the height of eye.
    /// Default 0.
    #[arg(
        long,
        value_name = "M",
        allow_negative_numbers = true,
        requires = "lat"
    )]
    pub height: Option<f64>,
}

impl OptionalSiteArgs {
    /// The observer as the engine's site, or `None` when no position was given. Pressure
    /// and temperature stay at their defaults: nothing that takes this site refracts.
    pub fn site(&self) -> Option<skyfix_ephemeris::topocentric::Site> {
        match (self.lat, self.lon) {
            (Some(lat_deg), Some(lon_deg)) => Some(skyfix_ephemeris::topocentric::Site {
                lat_deg,
                lon_deg,
                height_m: self.height.unwrap_or(0.0),
                ..skyfix_ephemeris::topocentric::Site::default()
            }),
            _ => None,
        }
    }
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
            index_error_log: Vec::new(),
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

/// An RFC 3339 instant with a trailing `Z`, as a `jd_utc`, its date in the run's
/// calendar (`--calendar`, else Julian before 1582-10-15).
pub fn parse_instant(s: &str) -> Result<f64, String> {
    parse_instant_with(s, calendar_choice())
}

/// [`parse_instant`] with the calendar given (`None`: the display rule).
pub fn parse_instant_with(s: &str, choice: Option<Calendar>) -> Result<f64, String> {
    let bad = || {
        format!(
            "{s:?} is not an RFC 3339 instant with a trailing Z, e.g. 2026-10-01T01:30:00Z \
             (years outside 0000-9999 with a sign: -0584-05-28T12:00:00Z)"
        )
    };
    let t = s.trim();
    let date_part = t.split('T').next().unwrap_or_default();
    let (y, m, d) = raw_date(date_part).ok_or_else(bad)?;
    let cal = calendar_of_typed(choice, y, m, d)?;
    parse_instant_in(t, cal).map_err(|_| {
        if parse_date_in(date_part, cal).is_none() {
            format!(
                "{s:?}: {} is not a date in the {cal} calendar",
                ymd(y, m, d)
            )
        } else {
            bad()
        }
    })
}

/// A typed instant as the engine's wire string (proleptic Gregorian, `Z`): what a flag
/// that is passed on to the engine as text must carry, whatever `--calendar` says.
pub fn wire_instant(s: &str) -> Result<String, String> {
    parse_instant(s).map(format_utc)
}

/// A calendar date, `YYYY-MM-DD` or `-0584-05-28`, in its calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Date {
    /// Astronomical year (0 is 1 BC).
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub calendar: Calendar,
}

impl Date {
    /// `jd_utc` of 00:00 on this date (the app's clock: UTC 1972-2035, UT outside).
    pub fn jd0(self) -> f64 {
        calendar::jdn_from_civil(self.calendar, i64::from(self.year), self.month, self.day) as f64
            - 0.5
    }
}

impl std::fmt::Display for Date {
    /// The date as typed, in its calendar; a Julian date says so.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", ymd(i64::from(self.year), self.month, self.day))?;
        if self.calendar == Calendar::Julian {
            write!(f, " (Julian)")?;
        }
        Ok(())
    }
}

/// `YYYY-MM-DD` (or `-0584-05-28`, `+12345-01-01`), a real date in the run's calendar
/// (2026-02-30 is refused; 1500-02-29 is a Julian date only).
pub fn parse_date(s: &str) -> Result<Date, String> {
    parse_date_with(s, calendar_choice())
}

/// [`parse_date`] with the calendar given (`None`: the display rule).
pub fn parse_date_with(s: &str, choice: Option<Calendar>) -> Result<Date, String> {
    let t = s.trim();
    let bad = || {
        format!(
            "{s:?} is not a date in the form YYYY-MM-DD (years outside 0000-9999 with a sign: \
             -0584-05-28)"
        )
    };
    let (y, m, d) = raw_date(t).ok_or_else(bad)?;
    let cal = calendar_of_typed(choice, y, m, d)?;
    if parse_date_in(t, cal).is_none() {
        return Err(format!("{s:?} is not a date in the {cal} calendar"));
    }
    let year = i32::try_from(y).map_err(|_| bad())?;
    Ok(Date {
        year,
        month: m,
        day: d,
        calendar: cal,
    })
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
        self.start_jd_in(0)
    }

    /// As the end of a window: a date means the END of it, 00:00 UTC the next day, so
    /// `--from 2026-10-01 --to 2026-10-31` is the whole of October.
    pub fn end_jd(self) -> f64 {
        self.end_jd_in(0)
    }

    /// As the start of a window, a date being a date in a zone `offset_minutes` east of
    /// UTC (`--zone`): it starts at local midnight. An instant is an instant.
    pub fn start_jd_in(self, offset_minutes: i32) -> f64 {
        match self {
            When::Date(d) => d.jd0() - f64::from(offset_minutes) / 1440.0,
            When::Instant(jd) => jd,
        }
    }

    /// As the end of a window, a date in that zone: it ends at the next local midnight.
    pub fn end_jd_in(self, offset_minutes: i32) -> f64 {
        match self {
            When::Date(d) => d.jd0() + 1.0 - f64::from(offset_minutes) / 1440.0,
            When::Instant(jd) => jd,
        }
    }
}

/// `[start, end]` of a `--from`/`--to` window, a date being a date in the zone
/// `offset_minutes` east of UTC (0: UTC), or why the window is empty.
pub fn window(from: When, to: When, offset_minutes: i32) -> anyhow::Result<(f64, f64)> {
    let (start, end) = (
        from.start_jd_in(offset_minutes),
        to.end_jd_in(offset_minutes),
    );
    if end <= start {
        anyhow::bail!(
            "--to must come after --from (a date as --to means the end of that day): {} is not \
             after {}",
            super::text::utc(end),
            super::text::utc(start)
        );
    }
    Ok((start, end))
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
        [start, course, speed] => (Some(wire_instant(start)?), *course, *speed),
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

// ---------------------------------------------------------------------------
// --dut1 (moonshape, expansion programme): UT1 - UTC from the time signal
// ---------------------------------------------------------------------------

/// `--dut1 SECONDS`, on every command that reduces, predicts or plans.
#[derive(clap::Args, Debug, Clone, Copy, Default)]
pub struct Dut1Args {
    /// UT1 - UTC in seconds, from the time signal or IERS Bulletin A (|DUT1| is at most
    /// 0.9 s). Overrides a session's clock.dut1_s. Without either the engine's own
    /// value is used (0 s for now): unknown by up to 0.9 s, 0.23' of longitude.
    #[arg(long, value_name = "SECONDS", allow_negative_numbers = true, value_parser = parse_dut1)]
    pub dut1: Option<f64>,
}

impl Dut1Args {
    /// Put the flag into a session: the command line wins over the file.
    pub fn apply(&self, session: &mut skyfix_core::types::Session) {
        if let Some(d) = self.dut1 {
            session.clock.dut1_s = Some(d);
        }
    }

    /// DUT1 for an instant when there is no session: the flag, else the engine's value
    /// (`skyfix_core::time::dut1_s`).
    pub fn at(&self, jd_utc: f64) -> f64 {
        skyfix_core::time::dut1_s(jd_utc, self.dut1)
    }
}

/// A DUT1 in seconds: finite and at most `skyfix_core::session::DUT1_LIMIT_S`, the
/// session's own rule. Beyond 0.9 s it is accepted and warned about on standard error.
pub fn parse_dut1(s: &str) -> Result<f64, String> {
    let v: f64 = s
        .trim()
        .parse()
        .map_err(|_| format!("--dut1 {s:?} is not a number of seconds"))?;
    if !v.is_finite() || v.abs() > skyfix_core::session::DUT1_LIMIT_S {
        return Err(format!(
            "--dut1 {s}: UT1 - UTC is within 0.9 s (IERS); give it in seconds, at most {} s",
            skyfix_core::session::DUT1_LIMIT_S
        ));
    }
    if v.abs() > 0.9 {
        eprintln!(
            "warning: --dut1 {v} s is outside the 0.9 s the IERS keeps UT1 - UTC within; used \
             as given"
        );
    }
    Ok(v)
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
            parse_date_with("2026-09-24", None).unwrap(),
            Date {
                year: 2026,
                month: 9,
                day: 24,
                calendar: Calendar::Gregorian
            }
        );
        assert_eq!(
            parse_date_with("2026-09-24", None).unwrap().to_string(),
            "2026-09-24"
        );
        for bad in [
            "2026-02-30",
            "2026-9-24",
            "24/09/2026",
            "2026-09-24T00:00:00Z",
            "584-05-28",
            "12345-01-01",
            "",
        ] {
            assert!(parse_date_with(bad, None).is_err(), "{bad}");
        }
    }

    #[test]
    fn dates_before_the_reform_are_julian_unless_told_otherwise() {
        let d = parse_date_with("-0584-05-28", None).unwrap();
        assert_eq!(
            (d.year, d.month, d.day, d.calendar),
            (-584, 5, 28, Calendar::Julian)
        );
        assert_eq!(d.jd0(), 1_507_899.5);
        assert_eq!(d.to_string(), "-0584-05-28 (Julian)");
        let g = parse_date_with("-0584-05-22", Some(Calendar::Gregorian)).unwrap();
        assert_eq!(g.jd0(), d.jd0());
        // 1500-02-29 exists only in the Julian calendar; 1582-10-10 in neither as used.
        assert!(parse_date_with("1500-02-29", None).is_ok());
        let e = parse_date_with("1500-02-29", Some(Calendar::Gregorian)).unwrap_err();
        assert!(e.contains("Gregorian"), "{e}");
        let e = parse_date_with("1582-10-10", None).unwrap_err();
        assert!(e.contains("--calendar"), "{e}");
        assert!(parse_date_with("1582-10-10", Some(Calendar::Julian)).is_ok());
        assert_eq!(parse_date_with("+12345-01-01", None).unwrap().year, 12_345);
        // The reform itself: Julian 1582-10-04 is followed by Gregorian 1582-10-15.
        let a = parse_date_with("1582-10-04", None).unwrap().jd0();
        let b = parse_date_with("1582-10-15", None).unwrap().jd0();
        assert_eq!(b - a, 1.0);
    }

    #[test]
    fn instants_take_expanded_years_and_the_calendar() {
        let j = parse_instant_with("-0584-05-28T12:00:00Z", None).unwrap();
        assert_eq!(j, 1_507_900.0);
        assert_eq!(
            parse_instant_with("-0584-05-22T12:00:00Z", Some(Calendar::Gregorian)).unwrap(),
            j
        );
        assert_eq!(
            parse_instant_with("2026-10-01T01:30:00Z", Some(Calendar::Gregorian)).unwrap(),
            parse_instant_with("2026-10-01T01:30:00Z", None).unwrap()
        );
        // Julian 2026-09-11 is Gregorian 2026-09-24.
        assert_eq!(
            parse_instant_with("2026-09-11T12:00:00Z", Some(Calendar::Julian)).unwrap(),
            2_461_308.0
        );
        assert!(parse_instant_with("1582-10-10T00:00:00Z", None).is_err());
        assert!(parse_instant_with("2026-10-01T01:30:00+00:00", None).is_err());
        assert!(parse_instant_with("1500-02-29T00:00:00Z", Some(Calendar::Gregorian)).is_err());
    }

    #[test]
    fn the_calendar_flag_is_read_before_clap() {
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            scan_calendar(os(&["skyfix", "sky", "--calendar", "julian"])),
            Some(Calendar::Julian)
        );
        assert_eq!(
            scan_calendar(os(&["skyfix", "--calendar=gregorian", "sky"])),
            Some(Calendar::Gregorian)
        );
        assert_eq!(
            scan_calendar(os(&["skyfix", "sky", "--", "--calendar", "julian"])),
            None
        );
        assert_eq!(
            scan_calendar(os(&["skyfix", "sky", "--calendar", "mayan"])),
            None
        );
        assert_eq!(scan_calendar(os(&["skyfix", "sky"])), None);
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
    fn a_date_in_a_zone_runs_from_local_midnight_and_an_instant_does_not_move() {
        use super::super::text::utc;
        let w = parse_when("2026-09-01").unwrap();
        assert_eq!(utc(w.start_jd_in(-240)), "2026-09-01T04:00:00Z");
        assert_eq!(utc(w.end_jd_in(-240)), "2026-09-02T04:00:00Z");
        assert_eq!(utc(w.start_jd_in(330)), "2026-08-31T18:30:00Z");
        // UTC is exactly the zone-free window, not merely close to it.
        assert_eq!(w.start_jd_in(0), w.start_jd());
        assert_eq!(w.end_jd_in(0), w.end_jd());
        let i = parse_when("2026-09-01T12:00:00Z").unwrap();
        assert_eq!(i.start_jd_in(-240), i.start_jd());
        assert_eq!(i.end_jd_in(600), i.end_jd());
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
        // The start goes to the engine as its wire string, whatever --calendar says.
        let l = parse_leg("2026-10-01T02:00:00Z, 90, 10").unwrap();
        assert_eq!(l.start_utc.as_deref(), Some("2026-10-01T02:00:00.000Z"));
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

    #[test]
    fn dut1_is_seconds_within_the_sessions_limit() {
        assert_eq!(parse_dut1("-0.2").unwrap(), -0.2);
        assert_eq!(parse_dut1(" 0.35 ").unwrap(), 0.35);
        assert_eq!(parse_dut1("1.5").unwrap(), 1.5);
        for bad in ["", "fast", "NaN", "inf", "300", "-61"] {
            assert!(parse_dut1(bad).is_err(), "{bad}");
        }
        let mut session: skyfix_core::types::Session = serde_json::from_str(
            r#"{"schema": "skyfix.session/1", "clock": {"dut1_s": 0.1}, "observations": []}"#,
        )
        .unwrap();
        Dut1Args { dut1: None }.apply(&mut session);
        assert_eq!(session.clock.dut1_s, Some(0.1));
        Dut1Args { dut1: Some(-0.3) }.apply(&mut session);
        assert_eq!(session.clock.dut1_s, Some(-0.3));
        assert_eq!(Dut1Args { dut1: Some(0.4) }.at(2.46e6), 0.4);
        // Without a value the engine's own lookup answers: the IERS history inside its
        // span (CONVENTIONS 15.2), which is within the 0.9 s the IERS keeps UT1 - UTC to.
        let automatic = Dut1Args { dut1: None }.at(2.46e6);
        assert_eq!(automatic, skyfix_core::time::dut1_s(2.46e6, None));
        assert!(automatic.abs() <= 0.9, "{automatic}");
    }
}
