//! Compass error by azimuth and by amplitude (CONVENTIONS 14.2;
//! `docs/NAVIGATION_METHODS.md` section 9). OWNER: geomag agent.
//!
//! A navigator checks a compass against the sky: the true bearing of a body is known from
//! the ephemeris, the compass gives its compass bearing, and the difference is the
//! **compass error** `CE = true - compass` (east positive: "compass least, error east").
//! For a magnetic compass the error is the sum of the **variation** (the magnetic field's
//! declination, from the chart or a model) and the **deviation** (the compass's own
//! error, from the ship's magnetism): `deviation = CE - variation`. A gyrocompass has no
//! variation; its whole error is "gyro error".
//!
//! - **By azimuth** (Bowditch 2019, vol. 1, section 1501): the true bearing is the body's
//!   azimuth at the instant of the bearing, computed exactly: the topocentric azimuth of
//!   its centre on the WGS84 ellipsoid (the direction a compass sight follows; for the Sun
//!   and the stars it equals the CONVENTIONS 3 `Zn` to under 0.001 degree, and it is
//!   returned beside it).
//! - **By amplitude** (sections 1503-1506): the bearing of a rising or setting body, which
//!   needs no accurate time. On the **celestial horizon** (the centre's geocentric
//!   altitude 0) `sin A = sin dec / cos lat`, `A` north positive, and the true bearing is
//!   `90 - A` rising or `270 + A` setting. On the **visible horizon** the centre stands
//!   lower (dip and refraction) or, for the Moon, higher (parallax); its geocentric
//!   altitude `h` there comes from the correction chain of CONVENTIONS 5 run for a limb on
//!   the sea horizon, and the bearing is exact:
//!   `cos Z = (sin dec - sin lat sin h) / (cos lat cos h)`. The difference between the two
//!   bearings is what Bowditch's Table 23 tabulates ("correction of amplitude as observed
//!   on the visible horizon"), computed here rather than interpolated.
//!
//! The instant of an amplitude is the body's crossing of that altitude nearest the given
//! time, found on the direction source's own track, so the declination is the one at the
//! moment the bearing was taken.

use crate::SkyfixError;
use crate::corrections;
use crate::geometry::{Point, altitude_azimuth};
use crate::reduce::DirectionSource;
use crate::sights::wgs84;
use crate::time::{format_utc, parse_utc};
use crate::types::{GeocentricDirection, Limb};
use crate::units::{norm_180, norm_360};
use serde::{Deserialize, Serialize};

/// Which way the true bearing is found.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompassMethod {
    /// The body's azimuth at the instant of the bearing.
    #[default]
    Azimuth,
    /// The body's bearing as it rises or sets.
    Amplitude,
}

/// The kind of compass whose error is found.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompassKind {
    /// A magnetic compass (steering or hand-bearing): error = variation + deviation.
    #[default]
    Magnetic,
    /// A gyrocompass: the whole error is gyro error.
    Gyro,
}

/// Where the body was when an amplitude bearing was taken.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AmplitudeHorizon {
    /// The limb (or centre) on the sea horizon, as it is seen.
    #[default]
    Visible,
    /// The centre at geocentric altitude 0 (the Sun's lower limb about two thirds of a
    /// diameter above the sea horizon; the Moon's upper limb on it).
    Celestial,
}

/// Rising or setting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiseSet {
    Rising,
    Setting,
}

/// The observer (WGS84 geodetic; `height_m` above the ellipsoid, as the explorer's).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CompassObserver {
    pub lat_deg: f64,
    pub lon_deg: f64,
    #[serde(default)]
    pub height_m: f64,
}

fn default_pressure() -> f64 {
    1010.0
}

fn default_temperature() -> f64 {
    10.0
}

/// A compass-error request (the wire format of `compass_error`, EXPLORER_API.md).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompassRequest {
    #[serde(default)]
    pub method: CompassMethod,
    pub body: String,
    /// When the bearing was taken, RFC 3339 UTC. Give this or `jd_utc`.
    #[serde(default)]
    pub utc: Option<String>,
    #[serde(default)]
    pub jd_utc: Option<f64>,
    pub observer: CompassObserver,
    /// The bearing the compass gave, degrees `[0, 360)`.
    pub compass_bearing_deg: f64,
    #[serde(default)]
    pub compass: CompassKind,
    /// The variation to reckon deviation from, east positive (e.g. from the chart's
    /// compass rose). `null`: the magnetic model's (the adapter supplies it).
    #[serde(default)]
    pub variation_deg: Option<f64>,
    /// Its 1-sigma, degrees, when known.
    #[serde(default)]
    pub variation_sigma_deg: Option<f64>,
    /// 1-sigma of the compass bearing itself, degrees, when the navigator states it.
    #[serde(default)]
    pub bearing_sigma_deg: Option<f64>,
    /// Amplitude only.
    #[serde(default)]
    pub horizon: AmplitudeHorizon,
    /// Amplitude on the visible horizon: height of eye above the sea, metres (dip).
    #[serde(default)]
    pub height_of_eye_m: f64,
    /// Amplitude on the visible horizon: which part of the disc touched it.
    #[serde(default)]
    pub limb: Limb,
    #[serde(default = "default_pressure")]
    pub pressure_hpa: f64,
    #[serde(default = "default_temperature")]
    pub temperature_c: f64,
    /// Amplitude: rising or setting; `null` = from the body's side of the meridian at
    /// the given time.
    #[serde(default)]
    pub event: Option<RiseSet>,
    /// Which magnetic model fills a missing variation (`"auto"`, `"wmm2025"`,
    /// `"igrf14"`); read by the adapter, not here.
    #[serde(default)]
    pub magnetic_model: Option<String>,
}

/// The variation a result used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VariationUsed {
    /// East positive.
    pub deg: f64,
    /// 1-sigma, degrees; `null` when not known (a chart value given without one).
    pub sigma_deg: Option<f64>,
    /// `"WMM2025"`, `"IGRF-14"` or `"given"`.
    pub source: String,
    /// `11.5° W`.
    pub text: String,
    /// The model's own sentences (zones, less certain eras).
    pub notes: Vec<String>,
}

/// The workings of an azimuth.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AzimuthDetails {
    /// Apparent geocentric GHA and declination of the body at the instant.
    pub gha_deg: f64,
    pub dec_deg: f64,
    /// Topocentric geometric altitude of the centre (no refraction).
    pub altitude_deg: f64,
    /// CONVENTIONS 3 `Zn` from the geocentric GHA/Dec, for comparison with tables.
    pub zn_spherical_deg: f64,
    /// How fast the true bearing was changing, degrees per minute of time.
    pub azimuth_rate_deg_per_min: f64,
}

/// The workings of an amplitude.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AmplitudeDetails {
    pub event: RiseSet,
    pub horizon: AmplitudeHorizon,
    /// Apparent geocentric declination at the crossing.
    pub dec_deg: f64,
    /// Amplitude on the celestial horizon, `sin A = sin dec / cos lat`, north positive;
    /// `null` when the body never reaches the celestial horizon that day.
    pub amplitude_deg: Option<f64>,
    /// `E 10.4° S`: the amplitude as Bowditch writes it (E rising, W setting).
    pub amplitude_text: Option<String>,
    /// True bearing of the centre on the celestial horizon.
    pub celestial_bearing_deg: Option<f64>,
    /// Geocentric altitude of the centre when the bearing was taken (0 on the celestial
    /// horizon).
    pub altitude_deg: f64,
    /// True bearing on the visible horizon minus on the celestial horizon, degrees (0 for
    /// a celestial-horizon bearing). Bowditch's Table 23 correction is its negative,
    /// applied to the observed bearing.
    pub visible_horizon_correction_deg: f64,
    /// The chain that gave `altitude_deg` (arcminutes): dip below the celestial horizon,
    /// refraction, semidiameter used, parallax in altitude.
    pub dip_arcmin: f64,
    pub refraction_arcmin: f64,
    pub semidiameter_arcmin: f64,
    pub parallax_arcmin: f64,
    /// How many degrees the bearing moves per degree of error in judging the altitude.
    pub bearing_per_altitude: f64,
    /// Crossing minus the given time, minutes.
    pub minutes_from_given_time: f64,
}

/// A compass error, its breakdown and its sentence (EXPLORER_API "compass_error").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompassErrorResult {
    pub method: CompassMethod,
    pub body: String,
    pub compass: CompassKind,
    /// The instant the true bearing is for: the bearing's (azimuth) or the horizon
    /// crossing's (amplitude).
    pub jd_utc: f64,
    pub utc: String,
    pub true_bearing_deg: f64,
    pub compass_bearing_deg: f64,
    /// True minus compass, (-180, 180], east positive.
    pub compass_error_deg: f64,
    /// `3.2° W`.
    pub compass_error_text: String,
    /// 1-sigma of the compass error, when the bearing's own sigma is stated.
    pub compass_error_sigma_deg: Option<f64>,
    /// Magnetic compass only.
    pub variation: Option<VariationUsed>,
    /// `compass error - variation`, east positive (magnetic compass with a variation).
    pub deviation_deg: Option<f64>,
    /// 1-sigma of the deviation: the variation's, combined with the bearing's when stated.
    pub deviation_sigma_deg: Option<f64>,
    pub deviation_text: Option<String>,
    /// `Compass error 3.2° W; variation 11.5° W; deviation 8.3° E.`
    pub sentence: String,
    /// `The Sun bore 262.1° true at 21:15:00 UTC; the compass read 262.5°.`
    pub explanation: String,
    pub azimuth: Option<AzimuthDetails>,
    pub amplitude: Option<AmplitudeDetails>,
    /// Where the body's direction came from.
    pub direction_source: String,
    /// Plain sentences: checks worth making, and the variation model's own notes.
    pub notes: Vec<String>,
}

/// A variation from a model at an instant (`jd_utc`), or why there is none.
pub type VariationModel<'a> = &'a dyn Fn(f64) -> Result<VariationUsed, String>;

/// Find the compass error (CONVENTIONS 14.2). `variation_model` supplies the variation
/// when the request gives none (for a magnetic compass).
pub fn compass_error(
    req: &CompassRequest,
    source: &dyn DirectionSource,
    variation_model: Option<VariationModel<'_>>,
) -> Result<CompassErrorResult, SkyfixError> {
    check_request(req)?;
    let jd_given = match (&req.utc, req.jd_utc) {
        (Some(s), None) => parse_utc(s)?,
        (None, Some(jd)) => jd,
        (Some(_), Some(_)) => return Err(invalid("utc", "give utc or jd_utc, not both")),
        (None, None) => return Err(invalid("utc", "the time of the bearing is required")),
    };
    let obs = req.observer;
    let body = req.body.trim().to_string();
    let direction = |jd: f64| -> Result<GeocentricDirection, SkyfixError> {
        source.direction(&body, jd).map_err(|reason| {
            SkyfixError::Other(format!(
                "no direction for the {body} at {}: {reason}",
                format_utc(jd)
            ))
        })
    };
    let mut notes: Vec<String> = Vec::new();
    let (jd, true_bearing, azimuth, amplitude) = match req.method {
        CompassMethod::Azimuth => {
            let d = direction(jd_given)?;
            let (alt, az) = topocentric_alt_az(&obs, &d);
            let (_, zn) = altitude_azimuth(
                Point::from_deg(obs.lat_deg, obs.lon_deg),
                d.gha_deg.to_radians(),
                d.dec_deg.to_radians(),
            );
            let h = 30.0 / 86_400.0;
            let rate = match (direction(jd_given - h), direction(jd_given + h)) {
                (Ok(a), Ok(b)) => {
                    let za = topocentric_alt_az(&obs, &a).1;
                    let zb = topocentric_alt_az(&obs, &b).1;
                    norm_180(zb - za)
                }
                _ => 0.0,
            };
            if alt < -1.0 {
                notes.push(format!(
                    "The {body} was {:.1}° below the horizon at that time: check the time, \
                     the date and the body.",
                    -alt
                ));
            }
            if rate.abs() > 0.3 {
                notes.push(format!(
                    "Its bearing was changing {:.2}° a minute, so each 10 seconds of error in \
                     the time moves the true bearing {:.2}°.",
                    rate.abs(),
                    rate.abs() / 6.0
                ));
            }
            let details = AzimuthDetails {
                gha_deg: norm_360(d.gha_deg),
                dec_deg: d.dec_deg,
                altitude_deg: alt,
                zn_spherical_deg: norm_360(zn.to_degrees()),
                azimuth_rate_deg_per_min: rate,
            };
            (jd_given, az, Some(details), None)
        }
        CompassMethod::Amplitude => {
            let (jd, bearing, details) = amplitude(req, &body, jd_given, &direction)?;
            if details.minutes_from_given_time.abs() > 30.0 {
                notes.push(format!(
                    "The {body} {} {:.0} minutes {} the time given; the amplitude is for that \
                     moment.",
                    match details.event {
                        RiseSet::Rising => "rose",
                        RiseSet::Setting => "set",
                    },
                    details.minutes_from_given_time.abs(),
                    if details.minutes_from_given_time > 0.0 {
                        "after"
                    } else {
                        "before"
                    }
                ));
            }
            if details.bearing_per_altitude > 1.5 {
                notes.push(format!(
                    "The {body} meets the horizon at a shallow angle here: judging its centre \
                     0.1° high or low moves the bearing {:.2}°.",
                    0.1 * details.bearing_per_altitude
                ));
            }
            (jd, bearing, None, Some(details))
        }
    };

    let compass_error_deg = norm_180(true_bearing - req.compass_bearing_deg);
    let variation = match req.compass {
        CompassKind::Gyro => None,
        CompassKind::Magnetic => match req.variation_deg {
            Some(v) => Some(VariationUsed {
                deg: v,
                sigma_deg: req.variation_sigma_deg,
                source: "given".to_string(),
                text: east_west(v),
                notes: Vec::new(),
            }),
            None => match variation_model {
                Some(model) => match model(jd) {
                    Ok(v) => Some(v),
                    Err(reason) => {
                        notes.push(format!("No variation from the magnetic model: {reason}"));
                        None
                    }
                },
                None => None,
            },
        },
    };
    if req.compass == CompassKind::Magnetic && variation.is_none() {
        notes.push(
            "Give the variation (from the chart's compass rose) to split the compass error \
             into variation and deviation."
                .to_string(),
        );
    }
    if let Some(v) = &variation {
        notes.extend(v.notes.iter().cloned());
    }
    let deviation_deg = variation
        .as_ref()
        .map(|v| norm_180(compass_error_deg - v.deg));
    let deviation_sigma_deg =
        variation
            .as_ref()
            .and_then(|v| match (v.sigma_deg, req.bearing_sigma_deg) {
                (Some(a), Some(b)) => Some(a.hypot(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            });
    let ce_text = east_west(compass_error_deg);
    let sentence = match (req.compass, &variation, deviation_deg) {
        (CompassKind::Gyro, _, _) => format!("Gyro error {ce_text}."),
        (CompassKind::Magnetic, Some(v), Some(dev)) => format!(
            "Compass error {ce_text}; variation {}; deviation {}.",
            v.text,
            east_west(dev)
        ),
        _ => format!("Compass error {ce_text}."),
    };
    let utc = format_utc(jd);
    let clock = utc.get(11..19).unwrap_or(&utc).to_string();
    let compass_word = match req.compass {
        CompassKind::Magnetic => "compass",
        CompassKind::Gyro => "gyrocompass",
    };
    let explanation = match (&azimuth, &amplitude) {
        (Some(a), _) => format!(
            "The {body} bore {:.1}° true at {clock} UTC, {:.1}° high; the {compass_word} \
             read {:.1}°.",
            true_bearing, a.altitude_deg, req.compass_bearing_deg
        ),
        (_, Some(a)) => format!(
            "The {body} {} bearing {:.1}° true{} at {clock} UTC with its {} on the {} \
             horizon; the {compass_word} read {:.1}°.",
            match a.event {
                RiseSet::Rising => "rose",
                RiseSet::Setting => "set",
            },
            true_bearing,
            a.amplitude_text
                .as_ref()
                .map(|t| format!(" (amplitude {t})"))
                .unwrap_or_default(),
            match (a.horizon, req.limb) {
                (AmplitudeHorizon::Celestial, _) | (_, Limb::Center) => "centre",
                (_, Limb::Lower) => "lower limb",
                (_, Limb::Upper) => "upper limb",
            },
            match a.horizon {
                AmplitudeHorizon::Visible => "visible",
                AmplitudeHorizon::Celestial => "celestial",
            },
            req.compass_bearing_deg
        ),
        _ => String::new(),
    };
    Ok(CompassErrorResult {
        method: req.method,
        body,
        compass: req.compass,
        jd_utc: jd,
        utc,
        true_bearing_deg: norm_360(true_bearing),
        compass_bearing_deg: req.compass_bearing_deg,
        compass_error_deg,
        compass_error_text: ce_text,
        compass_error_sigma_deg: req.bearing_sigma_deg,
        deviation_text: deviation_deg.map(east_west),
        variation,
        deviation_deg,
        deviation_sigma_deg,
        sentence,
        explanation,
        azimuth,
        amplitude,
        direction_source: source.name().to_string(),
        notes,
    })
}

fn invalid(field: &str, message: &str) -> SkyfixError {
    SkyfixError::InvalidField {
        field: field.to_string(),
        message: message.to_string(),
    }
}

fn check_request(req: &CompassRequest) -> Result<(), SkyfixError> {
    let o = req.observer;
    for (name, v) in [
        ("observer.lat_deg", o.lat_deg),
        ("observer.lon_deg", o.lon_deg),
        ("observer.height_m", o.height_m),
        ("compass_bearing_deg", req.compass_bearing_deg),
        ("height_of_eye_m", req.height_of_eye_m),
        ("pressure_hpa", req.pressure_hpa),
        ("temperature_c", req.temperature_c),
    ] {
        if !v.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: name.to_string(),
            });
        }
    }
    if !(-90.0..=90.0).contains(&o.lat_deg) {
        return Err(invalid("observer.lat_deg", "must be within [-90, 90]"));
    }
    if !(0.0..360.0).contains(&req.compass_bearing_deg) {
        return Err(invalid(
            "compass_bearing_deg",
            "a compass bearing is within [0, 360)",
        ));
    }
    if req.height_of_eye_m < 0.0 {
        return Err(invalid("height_of_eye_m", "must be 0 or more"));
    }
    if !(100.0..=1100.0).contains(&req.pressure_hpa) || !(-60.0..=60.0).contains(&req.temperature_c)
    {
        return Err(invalid(
            "pressure_hpa",
            "pressure 100-1100 hPa and temperature -60 to 60 C are the refraction model's range",
        ));
    }
    for (name, v) in [
        ("variation_deg", req.variation_deg),
        ("variation_sigma_deg", req.variation_sigma_deg),
        ("bearing_sigma_deg", req.bearing_sigma_deg),
        ("jd_utc", req.jd_utc),
    ] {
        if let Some(x) = v
            && !x.is_finite()
        {
            return Err(SkyfixError::NonFinite {
                field: name.to_string(),
            });
        }
    }
    if let Some(v) = req.variation_deg
        && !(-180.0..=180.0).contains(&v)
    {
        return Err(invalid("variation_deg", "must be within [-180, 180]"));
    }
    for (name, v) in [
        ("variation_sigma_deg", req.variation_sigma_deg),
        ("bearing_sigma_deg", req.bearing_sigma_deg),
    ] {
        if let Some(x) = v
            && x <= 0.0
        {
            return Err(invalid(name, "a standard deviation is greater than 0"));
        }
    }
    if req.body.trim().is_empty() {
        return Err(invalid("body", "name the body whose bearing was taken"));
    }
    Ok(())
}

/// `3.2° W`, `8.3° E`, `0.0°`.
pub fn east_west(deg: f64) -> String {
    let rounded = (deg.abs() * 10.0).round() / 10.0;
    if rounded == 0.0 {
        "0.0°".to_string()
    } else {
        format!("{rounded:.1}° {}", if deg < 0.0 { "W" } else { "E" })
    }
}

/// Topocentric geometric altitude and azimuth (degrees) of a body's centre from a WGS84
/// site: the body's distance from its horizontal parallax (stars at infinity).
pub fn topocentric_alt_az(obs: &CompassObserver, d: &GeocentricDirection) -> (f64, f64) {
    let site = wgs84::Site::new(obs.lat_deg, obs.lon_deg);
    let pos = wgs84::add(
        site.position_km,
        wgs84::scale(site.up, obs.height_m / 1000.0),
    );
    let u = wgs84::earth_fixed_unit(d.gha_deg, d.dec_deg);
    let hp = (d.horizontal_parallax_arcmin / 60.0).to_radians();
    let v = if hp > 0.0 {
        wgs84::sub(wgs84::scale(u, wgs84::HP_RADIUS_KM / hp.sin()), pos)
    } else {
        u
    };
    wgs84::alt_az_from_enu(site.to_enu(v))
}

/// Amplitude on the celestial horizon, degrees north positive: `sin A = sin dec / cos lat`
/// (Bowditch 1503). `None` when the body does not reach the celestial horizon.
pub fn celestial_amplitude_deg(lat_deg: f64, dec_deg: f64) -> Option<f64> {
    let s = dec_deg.to_radians().sin() / lat_deg.to_radians().cos();
    (s.abs() <= 1.0).then(|| s.asin().to_degrees())
}

/// True bearing of a body of declination `dec_deg` when its centre stands at geocentric
/// altitude `h_deg`, rising or setting (Bowditch 1506: the altitude-azimuth formula).
/// `None` when it never stands at that altitude.
pub fn bearing_at_altitude_deg(
    lat_deg: f64,
    dec_deg: f64,
    h_deg: f64,
    event: RiseSet,
) -> Option<f64> {
    let (sl, cl) = lat_deg.to_radians().sin_cos();
    let (sh, ch) = h_deg.to_radians().sin_cos();
    let c = (dec_deg.to_radians().sin() - sl * sh) / (cl * ch);
    if !c.is_finite() || c.abs() > 1.0 {
        return None;
    }
    let z = c.acos().to_degrees();
    Some(match event {
        RiseSet::Rising => z,
        RiseSet::Setting => norm_360(360.0 - z),
    })
}

/// `E 10.4° S` / `W 32.7° N`.
pub fn amplitude_text(amplitude_deg: f64, event: RiseSet) -> String {
    let side = match event {
        RiseSet::Rising => "E",
        RiseSet::Setting => "W",
    };
    format!(
        "{side} {:.1}° {}",
        amplitude_deg.abs(),
        if amplitude_deg < 0.0 { "S" } else { "N" }
    )
}

/// The chain for a limb on the visible horizon (CONVENTIONS 5, run for `Hs = 0`): the
/// geocentric altitude of the centre and the steps, arcminutes.
struct HorizonChain {
    altitude_deg: f64,
    dip_arcmin: f64,
    refraction_arcmin: f64,
    semidiameter_arcmin: f64,
    parallax_arcmin: f64,
}

fn horizon_altitude(req: &CompassRequest, d: &GeocentricDirection) -> HorizonChain {
    if req.horizon == AmplitudeHorizon::Celestial {
        return HorizonChain {
            altitude_deg: 0.0,
            dip_arcmin: 0.0,
            refraction_arcmin: 0.0,
            semidiameter_arcmin: 0.0,
            parallax_arcmin: 0.0,
        };
    }
    // The limb on the sea horizon: apparent altitude = -dip (step 2).
    let dip = corrections::dip_arcmin(req.height_of_eye_m);
    let ha = -dip / 60.0;
    // Refraction at that apparent altitude (step 3; Bennett, smooth a degree below 0).
    let r = corrections::refraction_arcmin(ha, req.pressure_hpa, req.temperature_c);
    let h_limb = ha - r / 60.0;
    // Semidiameter (step 4): the centre above a lower limb, below an upper one.
    let sign = match req.limb {
        Limb::Center => 0.0,
        Limb::Lower => 1.0,
        Limb::Upper => -1.0,
    };
    let (sd, h_centre) = if sign == 0.0 || d.semidiameter_arcmin <= 0.0 {
        (0.0, h_limb)
    } else {
        corrections::limb_to_centre(
            h_limb,
            sign,
            d.semidiameter_arcmin,
            d.horizontal_parallax_arcmin,
        )
    };
    // Parallax (step 5), exact on the sphere.
    let p =
        corrections::rigorous_parallax_in_altitude_arcmin(d.horizontal_parallax_arcmin, h_centre);
    HorizonChain {
        altitude_deg: h_centre + p / 60.0,
        dip_arcmin: dip,
        refraction_arcmin: r,
        semidiameter_arcmin: sd,
        parallax_arcmin: p,
    }
}

/// Search step for the horizon crossing, days (5 minutes: the Moon's altitude cannot turn
/// back within it), and the half-width of the search, days.
const CROSSING_STEP: f64 = 5.0 / 1440.0;
const CROSSING_HALF_WINDOW: f64 = 0.5;

fn amplitude(
    req: &CompassRequest,
    body: &str,
    jd_given: f64,
    direction: &dyn Fn(f64) -> Result<GeocentricDirection, SkyfixError>,
) -> Result<(f64, f64, AmplitudeDetails), SkyfixError> {
    let obs = req.observer;
    let p = Point::from_deg(obs.lat_deg, obs.lon_deg);
    let d0 = direction(jd_given)?;
    let event = req.event.unwrap_or_else(|| {
        // West of the meridian (LHA 0-180) the body is setting.
        let lha = norm_360(d0.gha_deg + obs.lon_deg);
        if lha > 0.0 && lha < 180.0 {
            RiseSet::Setting
        } else {
            RiseSet::Rising
        }
    });
    let mut chain = horizon_altitude(req, &d0);
    let hc = |jd: f64| -> Option<f64> {
        let d = direction(jd).ok()?;
        let (h, _) = altitude_azimuth(p, d.gha_deg.to_radians(), d.dec_deg.to_radians());
        Some(h.to_degrees())
    };
    let mut jd_cross = None;
    for _ in 0..2 {
        let target = chain.altitude_deg;
        let f = |jd: f64| hc(jd).map(|h| h - target);
        let found = nearest_crossing(&f, jd_given, event).ok_or_else(|| {
            SkyfixError::Other(format!(
                "The {body} does not {} at {:.4}° {:.4}° within 12 hours of the given time: \
                 no amplitude.",
                match event {
                    RiseSet::Rising => "rise",
                    RiseSet::Setting => "set",
                },
                obs.lat_deg,
                obs.lon_deg
            ))
        })?;
        jd_cross = Some(found);
        // Semidiameter and parallax at the crossing itself, then solve once more.
        chain = horizon_altitude(req, &direction(found)?);
    }
    let jd = jd_cross.unwrap_or(jd_given);
    let d = direction(jd)?;
    let h = chain.altitude_deg;
    let bearing = bearing_at_altitude_deg(obs.lat_deg, d.dec_deg, h, event).ok_or_else(|| {
        SkyfixError::Other(format!(
            "The {body} does not reach an altitude of {h:.2}° at latitude {:.4}°.",
            obs.lat_deg
        ))
    })?;
    let amplitude_deg = celestial_amplitude_deg(obs.lat_deg, d.dec_deg);
    let celestial_bearing = amplitude_deg.map(|a| match event {
        RiseSet::Rising => norm_360(90.0 - a),
        RiseSet::Setting => norm_360(270.0 + a),
    });
    let correction = celestial_bearing.map_or(0.0, |c| norm_180(bearing - c));
    let dh = 0.01;
    let sensitivity = match (
        bearing_at_altitude_deg(obs.lat_deg, d.dec_deg, h - dh, event),
        bearing_at_altitude_deg(obs.lat_deg, d.dec_deg, h + dh, event),
    ) {
        (Some(a), Some(b)) => (norm_180(b - a) / (2.0 * dh)).abs(),
        _ => f64::INFINITY,
    };
    Ok((
        jd,
        bearing,
        AmplitudeDetails {
            event,
            horizon: req.horizon,
            dec_deg: d.dec_deg,
            amplitude_deg,
            amplitude_text: amplitude_deg.map(|a| amplitude_text(a, event)),
            celestial_bearing_deg: celestial_bearing,
            altitude_deg: h,
            visible_horizon_correction_deg: if req.horizon == AmplitudeHorizon::Visible {
                correction
            } else {
                0.0
            },
            dip_arcmin: chain.dip_arcmin,
            refraction_arcmin: chain.refraction_arcmin,
            semidiameter_arcmin: chain.semidiameter_arcmin,
            parallax_arcmin: chain.parallax_arcmin,
            bearing_per_altitude: sensitivity,
            minutes_from_given_time: (jd - jd_given) * 1440.0,
        },
    ))
}

/// The root of `f` (altitude minus the target) nearest `jd0` within half a day either
/// side, crossing upward for a rising and downward for a setting; bisection to 0.01 s.
fn nearest_crossing(f: &dyn Fn(f64) -> Option<f64>, jd0: f64, event: RiseSet) -> Option<f64> {
    let n = (CROSSING_HALF_WINDOW / CROSSING_STEP).ceil() as i64;
    let mut best: Option<(f64, f64, f64)> = None; // (distance, a, b)
    let mut prev: Option<(f64, f64)> = None;
    for i in -n..=n {
        let t = jd0 + i as f64 * CROSSING_STEP;
        let Some(v) = f(t) else {
            prev = None;
            continue;
        };
        if let Some((tp, vp)) = prev {
            let crosses = match event {
                RiseSet::Rising => vp < 0.0 && v >= 0.0,
                RiseSet::Setting => vp >= 0.0 && v < 0.0,
            };
            if crosses {
                let mid = 0.5 * (tp + t);
                let dist = (mid - jd0).abs();
                if best.is_none_or(|(bd, _, _)| dist < bd) {
                    best = Some((dist, tp, t));
                }
            }
        }
        prev = Some((t, v));
    }
    let (_, mut a, mut b) = best?;
    let mut fa = f(a)?;
    for _ in 0..40 {
        let m = 0.5 * (a + b);
        let fm = f(m)?;
        if (fm < 0.0) == (fa < 0.0) {
            a = m;
            fa = fm;
        } else {
            b = m;
        }
        if (b - a) * 86_400.0 < 0.01 {
            break;
        }
    }
    Some(0.5 * (a + b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn east_west_is_the_navigators_rule() {
        // "Compass least, error east": true 124.0, compass 124.8 is 0.8 W.
        assert_eq!(east_west(norm_180(124.0 - 124.8)), "0.8° W");
        assert_eq!(east_west(norm_180(2.0 - 358.5)), "3.5° E");
        assert_eq!(east_west(0.04), "0.0°");
    }

    #[test]
    fn bowditch_1504_amplitude_on_the_celestial_horizon() {
        // Lat 51°24.6' N, dec N 19°40.4', setting; Bowditch interpolates Table 22 to
        // W 32.6° N, true 302.6°, and 303° pgc gives 0.4° W.
        let lat = 51.0 + 24.6 / 60.0;
        let dec = 19.0 + 40.4 / 60.0;
        let a = celestial_amplitude_deg(lat, dec).unwrap();
        assert!((a - 32.6).abs() < 0.1, "{a}");
        let zn = bearing_at_altitude_deg(lat, dec, 0.0, RiseSet::Setting).unwrap();
        assert!((zn - (270.0 + a)).abs() < 1e-9);
        assert!((zn - 302.6).abs() < 0.1);
        assert_eq!(amplitude_text(a, RiseSet::Setting), "W 32.7° N");
        let ce = norm_180(zn - 303.0);
        assert!((ce - -0.4).abs() < 0.1, "{ce}");
    }

    #[test]
    fn bowditch_1505_and_1506_amplitude_on_the_visible_horizon() {
        // Lat 59°47' N, dec S 5°11.3', sunrise on the visible horizon at 098.5° pgc.
        // 1505 (tables): amplitude 10.3° S, true 100.3° on the celestial horizon, Table 23
        // brings the observed bearing to 099.7°, gyro error 0.6° E. 1506 (formula, the
        // Sun's centre at Hc = -0.7°): amplitude 9.1°, true 099.1°, error 0.6° E.
        let lat = 59.0 + 47.0 / 60.0;
        let dec = -(5.0 + 11.3 / 60.0);
        let a = celestial_amplitude_deg(lat, dec).unwrap();
        assert!((a - -10.3).abs() < 0.1, "{a}");
        let celestial = bearing_at_altitude_deg(lat, dec, 0.0, RiseSet::Rising).unwrap();
        let visible = bearing_at_altitude_deg(lat, dec, -0.7, RiseSet::Rising).unwrap();
        assert!((visible - 99.1).abs() < 0.05, "{visible}");
        // Table 23's correction, applied to the observed bearing: +1.2°.
        let table23 = celestial - visible;
        assert!((table23 - 1.2).abs() < 0.05, "{table23}");
        let error = norm_180(visible - 98.5);
        assert!((error - 0.6).abs() < 0.05, "{error}");
    }

    #[test]
    fn the_visible_horizon_chain_gives_bowditchs_minus_0_7_for_a_bridge_height() {
        // The Sun's centre on the sea horizon from 16 m: dip 7.0', refraction 36.0',
        // parallax +0.15': about -0.72°, Bowditch's -0.7°.
        let req = CompassRequest {
            method: CompassMethod::Amplitude,
            body: "Sun".into(),
            utc: None,
            jd_utc: Some(2_461_000.0),
            observer: CompassObserver {
                lat_deg: 50.0,
                lon_deg: 0.0,
                height_m: 0.0,
            },
            compass_bearing_deg: 90.0,
            compass: CompassKind::Gyro,
            variation_deg: None,
            variation_sigma_deg: None,
            bearing_sigma_deg: None,
            horizon: AmplitudeHorizon::Visible,
            height_of_eye_m: 16.0,
            limb: Limb::Center,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
            event: None,
            magnetic_model: None,
        };
        let sun = GeocentricDirection {
            gha_deg: 0.0,
            dec_deg: 0.0,
            semidiameter_arcmin: 16.0,
            horizontal_parallax_arcmin: 0.1462,
        };
        let c = horizon_altitude(&req, &sun);
        assert!((c.dip_arcmin - 7.04).abs() < 0.01);
        assert!((c.altitude_deg - -0.71).abs() < 0.02, "{}", c.altitude_deg);
        // The Moon's parallax lifts it: the centre stands about 0.25° above the celestial
        // horizon, which is why Bowditch applies half the Sun's correction the other way.
        let moon = GeocentricDirection {
            horizontal_parallax_arcmin: 57.0,
            semidiameter_arcmin: 15.5,
            ..sun
        };
        let m = horizon_altitude(&req, &moon);
        assert!(
            m.altitude_deg > 0.2 && m.altitude_deg < 0.3,
            "{}",
            m.altitude_deg
        );
    }
}
