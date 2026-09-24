//! `--zone`: the time zone a day is taken in and its times are shown in. OWNER: cli agent.
//!
//! The engine works only in UTC (CONVENTIONS 13.8), and every report prints UTC beside
//! any zone time. The web UI shows an IANA zone (`America/New_York`) through the
//! browser's `Intl`, which carries the tz database: every region's offsets and every
//! daylight-saving rule. This offline tool deliberately carries no such database — it
//! is large, it changes whenever a government moves its clocks, and it would be the only
//! thing here that goes out of date by itself — so `--zone` accepts only the zones that
//! need none:
//!
//! - `utc` (also `z` and `gmt`): UTC itself, the default;
//! - a fixed offset from UTC, as `+05:30`, `-04:00`, `+0530`, `-4` or `UTC-4`;
//! - `nautical`: the nautical zone time of the observer's longitude, zone description
//!   `ZD = round(lon_east / -15)` hours, zone time + ZD = UTC, so 75 W is ZD +5
//!   (CONVENTIONS 13.8).
//!
//! An IANA name is refused with a sentence that says why and what to type instead. It is
//! never guessed at: a wrong guess about daylight saving would put every event an hour
//! out with nothing on the screen to say so.
//!
//! `events` takes the nautical zone's longitude from its observer. `phases` and `seasons`
//! have no observer — their instants are the same everywhere on Earth — so they take
//! [`ZoneArgs`]: `--zone`, and `--lon` for the nautical zone only.

use anyhow::{Result, bail};

use super::args::parse_lon;

/// `--zone` and, for `--zone nautical` only, the `--lon` that sets it: the zone flags of a
/// command whose results do not depend on where the observer is (`phases`, `seasons`).
#[derive(clap::Args, Debug, Clone, Copy)]
pub struct ZoneArgs {
    /// The zone a date given as --from or --to is taken in, and local times are shown in
    /// beside UTC: `utc` (default), a fixed offset such as -04:00, or `nautical` for the
    /// zone time of --lon. Named zones (America/New_York) need a tz database this offline
    /// tool does not carry; see docs/CLI.md.
    #[arg(long, value_name = "ZONE", default_value = "utc", value_parser = parse_zone, allow_hyphen_values = true)]
    pub zone: Zone,
    /// East longitude, degrees (75.17 W is -75.17), for --zone nautical only: it sets the
    /// zone, ZD = round(lon / -15). Refused with any other zone, where it would do nothing.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true, value_parser = parse_lon)]
    pub lon: Option<f64>,
}

impl ZoneArgs {
    /// The zone made concrete, or why the flags contradict each other: the nautical zone
    /// needs a longitude, and a longitude with any other zone would silently do nothing.
    pub fn resolve(&self) -> Result<ResolvedZone> {
        match (self.zone, self.lon) {
            (Zone::Nautical, Some(lon)) => Ok(Zone::Nautical.resolve(lon)),
            (Zone::Nautical, None) => bail!(
                "--zone nautical is the zone time of a longitude, ZD = round(lon / -15): give \
                 the longitude with --lon DEG (east positive, so 75.17 W is -75.17)"
            ),
            (zone, None) => Ok(zone.resolve(0.0)),
            (_, Some(_)) => bail!(
                "--lon only sets the nautical zone (--zone nautical). The Moon's phases and the \
                 seasons are the same instants everywhere on Earth, so a longitude does nothing \
                 else here"
            ),
        }
    }
}

/// A parsed `--zone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Utc,
    /// Minutes east of UTC: local time = UTC + this.
    Fixed(i32),
    /// The nautical zone of the observer's longitude, resolved by [`Zone::resolve`].
    Nautical,
}

/// A zone made concrete for one observer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedZone {
    /// Local time = UTC + this many minutes.
    pub offset_minutes: i32,
    /// `UTC`, `UTC-04:00`, or `nautical ZD +5 (UTC-05:00)`.
    pub label: String,
}

impl ResolvedZone {
    pub fn is_utc(&self) -> bool {
        self.offset_minutes == 0
    }
}

/// The largest offset any real zone uses (Kiribati, UTC+14).
const MAX_OFFSET_MINUTES: i32 = 14 * 60;

/// Parse `--zone`.
pub fn parse_zone(s: &str) -> Result<Zone, String> {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    match lower.as_str() {
        "utc" | "z" | "gmt" | "ut" => return Ok(Zone::Utc),
        "nautical" | "zd" => return Ok(Zone::Nautical),
        _ => {}
    }
    let rest = lower
        .strip_prefix("utc")
        .or_else(|| lower.strip_prefix("gmt"))
        .unwrap_or(&lower);
    if let Some(minutes) = fixed_offset(rest) {
        return if minutes.abs() <= MAX_OFFSET_MINUTES {
            Ok(Zone::Fixed(minutes))
        } else {
            Err(format!(
                "--zone {t:?} is more than 14 hours from UTC, which no time zone is"
            ))
        };
    }
    if t.contains('/') || t.chars().any(|c| c.is_ascii_alphabetic()) {
        return Err(format!(
            "--zone {t:?} looks like a time-zone name. Turning a name into an offset needs the \
             tz database (every region's daylight-saving rules), which this offline tool \
             deliberately does not carry; the web UI shows named zones through the browser. \
             Give the offset that applies on the date instead, e.g. --zone -04:00 for US \
             Eastern daylight time or --zone +01:00 for Central European winter time; or \
             --zone utc; or --zone nautical for the zone time of the longitude"
        ));
    }
    Err(format!(
        "--zone {t:?} is not a zone: expected utc, nautical, or an offset such as +05:30 or -4"
    ))
}

/// `+05:30`, `-04:00`, `+0530`, `-4`, `+5:30`: minutes east of UTC. The sign is required,
/// so a bare number is never taken for hours or minutes by accident.
fn fixed_offset(s: &str) -> Option<i32> {
    let (sign, digits) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = match digits.split_once(':') {
        Some((h, m)) => (h, m),
        None if digits.len() == 4 => digits.split_at(2),
        None => (digits, "0"),
    };
    let ok = |p: &str| !p.is_empty() && p.len() <= 2 && p.bytes().all(|b| b.is_ascii_digit());
    if !ok(h) || !ok(m) {
        return None;
    }
    let (h, m): (i32, i32) = (h.parse().ok()?, m.parse().ok()?);
    if m >= 60 {
        return None;
    }
    Some(sign * (h * 60 + m))
}

/// `UTC`, or `UTC+05:30` / `UTC-04:00`.
pub fn offset_label(minutes: i32) -> String {
    if minutes == 0 {
        return "UTC".to_string();
    }
    let sign = if minutes < 0 { '-' } else { '+' };
    let a = minutes.abs();
    format!("UTC{sign}{:02}:{:02}", a / 60, a % 60)
}

impl Zone {
    /// The offset and label for an observer at east longitude `lon_deg`.
    pub fn resolve(self, lon_deg: f64) -> ResolvedZone {
        match self {
            Zone::Utc => ResolvedZone {
                offset_minutes: 0,
                label: "UTC".to_string(),
            },
            Zone::Fixed(m) => ResolvedZone {
                offset_minutes: m,
                label: offset_label(m),
            },
            Zone::Nautical => {
                // CONVENTIONS 13.8: ZD = round(lon_east / -15); zone time + ZD = UTC.
                let zd = (lon_deg / -15.0).round() as i32;
                let offset = -zd * 60;
                ResolvedZone {
                    offset_minutes: offset,
                    label: format!("nautical ZD {zd:+} ({})", offset_label(offset)),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_offsets_and_the_nautical_zone_parse() {
        assert_eq!(parse_zone("utc").unwrap(), Zone::Utc);
        assert_eq!(parse_zone(" Z ").unwrap(), Zone::Utc);
        assert_eq!(parse_zone("+05:30").unwrap(), Zone::Fixed(330));
        assert_eq!(parse_zone("-04:00").unwrap(), Zone::Fixed(-240));
        assert_eq!(parse_zone("+0530").unwrap(), Zone::Fixed(330));
        assert_eq!(parse_zone("-4").unwrap(), Zone::Fixed(-240));
        assert_eq!(parse_zone("UTC-4").unwrap(), Zone::Fixed(-240));
        assert_eq!(parse_zone("utc+5:45").unwrap(), Zone::Fixed(345));
        assert_eq!(parse_zone("nautical").unwrap(), Zone::Nautical);
    }

    #[test]
    fn names_and_nonsense_are_refused_with_a_reason() {
        let e = parse_zone("America/New_York").unwrap_err();
        assert!(e.contains("tz database") && e.contains("-04:00"), "{e}");
        assert!(parse_zone("EST").unwrap_err().contains("time-zone name"));
        assert!(parse_zone("+15:00").unwrap_err().contains("14 hours"));
        assert!(parse_zone("+05:75").is_err());
        assert!(parse_zone("5").is_err(), "an offset needs its sign");
    }

    #[test]
    fn the_nautical_zone_follows_the_longitude() {
        // 75 W is ZD +5: zone time + 5 h = UTC.
        let z = Zone::Nautical.resolve(-75.1652);
        assert_eq!(z.offset_minutes, -300);
        assert_eq!(z.label, "nautical ZD +5 (UTC-05:00)");
        assert_eq!(Zone::Nautical.resolve(151.2).offset_minutes, 600);
        assert_eq!(Zone::Nautical.resolve(3.0).label, "nautical ZD +0 (UTC)");
        assert_eq!(Zone::Fixed(330).resolve(0.0).label, "UTC+05:30");
        assert!(Zone::Utc.resolve(-75.0).is_utc());
    }

    #[test]
    fn without_an_observer_the_nautical_zone_needs_lon_and_nothing_else_takes_it() {
        let args = |zone: Zone, lon: Option<f64>| ZoneArgs { zone, lon }.resolve();
        assert_eq!(
            args(Zone::Nautical, Some(-75.17)).unwrap().label,
            "nautical ZD +5 (UTC-05:00)"
        );
        assert!(
            args(Zone::Nautical, None)
                .unwrap_err()
                .to_string()
                .contains("--lon")
        );
        assert_eq!(args(Zone::Fixed(-240), None).unwrap().offset_minutes, -240);
        assert!(args(Zone::Utc, None).unwrap().is_utc());
        for zone in [Zone::Utc, Zone::Fixed(60)] {
            let e = args(zone, Some(10.0)).unwrap_err().to_string();
            assert!(e.contains("only sets the nautical zone"), "{e}");
        }
    }
}
