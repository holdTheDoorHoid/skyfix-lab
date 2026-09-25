//! Comets and asteroids from orbital elements the user supplies: the Minor Planet
//! Center's one-line formats (MPCORB for minor planets, the comet format of
//! `CometEls.txt`), with their packed designations and dates, or elements typed in; a
//! two-body propagator in universal variables (any eccentricity); and the apparent
//! place, distance, elongation and magnitude that feed the explorer's body pipeline.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.12; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail". No dataset ships: the Minor Planet Center's files go stale in days and must
//! be credited, so the person brings the elements.
//!
//! # Model
//!
//! - **Elements** are heliocentric, osculating, referred to the J2000.0 ecliptic and
//!   equinox (obliquity 84381.448", the MPC's and Skyfield's `ECLIPJ2000`): perihelion
//!   distance `q`, eccentricity `e`, inclination, node, argument of perihelion and the
//!   time of perihelion `T` (TT). MPCORB's semimajor axis and mean anomaly at the epoch
//!   are turned into `q = a (1 - e)` and `T = epoch - M / n`, `n = k a^-1.5` with the
//!   Gaussian constant `k = 0.01720209895` (so GM_sun = k^2 au^3/day^2).
//! - **Propagation**: the two-body problem from perihelion in universal variables
//!   (Stumpff functions `C` and `S`), the universal Kepler equation
//!   `sqrt(mu) dt = e chi^3 S(alpha chi^2) + q chi` solved by the Laguerre-Conway
//!   iteration, so ellipses, parabolas and hyperbolas take one path. **No planetary
//!   perturbation**: elements drift from the real orbit within weeks to months of their
//!   epoch, fastest for near-Earth objects and for comets that pass near Jupiter; every
//!   result carries the age of its elements and a warning past 30 days.
//! - **Apparent place**: light-time iterated against the Earth's heliocentric position
//!   (the planet provider's VSOP87A), annual aberration, then the IAU 2006/2000B rotation
//!   to the true equator of date (CONVENTIONS section 7). Gravitational deflection by the
//!   Sun is omitted (under 0.02" beyond 20 degrees from the Sun).
//! - **Magnitude**: the IAU H-G system for minor planets (Bowell et al. 1989); for comets
//!   the total magnitude `m = M1 + 5 log10(delta) + K1 log10(r)`. The MPC's comet format
//!   gives `M1` and a slope `k` with `K1 = 2.5 k`.

use serde::{Deserialize, Serialize};
use skyfix_core::time::{format_utc, jd_tt, jd_ut1, parse_utc};
use skyfix_ephemeris::body::{ApparentState, BodyKind};
use skyfix_ephemeris::frames::apply_annual_aberration;
use skyfix_ephemeris::planets::heliocentric_position_au;
use skyfix_ephemeris::sidereal::gast_deg;
use skyfix_ephemeris::topocentric::{Site, WGS84_A_KM, horizontal};

use crate::planet_geometry::{
    C_AU_PER_DAY, Vec3, add, angle, icrs_to_true_of_date, mat_vec, norm, radec_of, scale, sub,
    sun_planet_coverage, unavailable, unit,
};
use crate::sky::{AlmanacError, BodyState, body_state, checked_site};

const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;
/// Gauss's gravitational constant, radians per day: GM_sun = k^2 au^3/day^2.
pub const GAUSS_K: f64 = 0.017_202_098_95;
/// Obliquity of the J2000.0 ecliptic the MPC's elements are referred to (IAU 1976).
const OBLIQUITY_J2000_ARCSEC: f64 = 84_381.448;
/// Past this many days from their epoch, results carry a staleness warning.
pub const STALE_AFTER_DAYS: f64 = 30.0;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbitClass {
    Asteroid,
    Comet,
}

/// How the body's brightness is modelled.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum MagnitudeModel {
    /// IAU H-G: absolute magnitude H, slope G.
    Hg {
        h: f64,
        g: f64,
    },
    /// Comet total magnitude `M1 + 5 log10(delta) + K1 log10(r)`.
    Comet {
        m1: f64,
        k1: f64,
    },
    None,
}

/// Heliocentric osculating elements, J2000.0 ecliptic and equinox; times TT.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrbitalElements {
    pub name: String,
    /// Unpacked designation (`"(433)"`, `"2008 AA360"`, `"C/2023 A3"`), when known.
    pub designation: Option<String>,
    pub class: OrbitClass,
    /// Osculation epoch (TT Julian date), when the source gives one.
    pub epoch_jd_tt: Option<f64>,
    pub perihelion_distance_au: f64,
    pub eccentricity: f64,
    pub inclination_deg: f64,
    pub ascending_node_deg: f64,
    pub argument_of_perihelion_deg: f64,
    /// Time of perihelion passage (TT Julian date).
    pub perihelion_jd_tt: f64,
    pub magnitude: MagnitudeModel,
    /// `"mpcorb"`, `"mpc_comet"` or `"manual"`.
    pub source: String,
}

impl OrbitalElements {
    fn check(&self) -> Result<(), String> {
        let ok = self.perihelion_distance_au.is_finite()
            && self.perihelion_distance_au > 0.0
            && self.eccentricity.is_finite()
            && self.eccentricity >= 0.0
            && self.eccentricity < 100.0
            && self.perihelion_jd_tt.is_finite()
            && [
                self.inclination_deg,
                self.ascending_node_deg,
                self.argument_of_perihelion_deg,
            ]
            .iter()
            .all(|v| v.is_finite());
        if ok {
            Ok(())
        } else {
            Err(format!("{}: elements out of range: {self:?}", self.name))
        }
    }

    /// The date the elements are good for: the epoch, else the perihelion.
    pub fn reference_jd_tt(&self) -> f64 {
        self.epoch_jd_tt.unwrap_or(self.perihelion_jd_tt)
    }
}

// ---------------------------------------------------------------------------
// MPC packed forms
// ---------------------------------------------------------------------------

fn base62(c: char) -> Option<u32> {
    match c {
        '0'..='9' => Some(c as u32 - '0' as u32),
        'A'..='Z' => Some(c as u32 - 'A' as u32 + 10),
        'a'..='z' => Some(c as u32 - 'a' as u32 + 36),
        _ => None,
    }
}

/// A packed permanent minor-planet number (`"00433"`, `"A1955"`, `"~0000"`).
pub fn unpack_number(p: &str) -> Option<u64> {
    let p = p.trim();
    let mut ch = p.chars();
    let first = ch.next()?;
    if first == '~' {
        let mut v: u64 = 0;
        for c in ch {
            v = v * 62 + u64::from(base62(c)?);
        }
        return (p.len() == 5).then_some(620_000 + v);
    }
    if p.len() != 5 || !p[1..].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let high = if first.is_ascii_digit() {
        u64::from(first as u32 - '0' as u32)
    } else {
        u64::from(base62(first)?)
    };
    Some(high * 10_000 + p[1..].parse::<u64>().ok()?)
}

fn century(c: char) -> Option<i32> {
    match c {
        'I' => Some(18),
        'J' => Some(19),
        'K' => Some(20),
        _ => None,
    }
}

/// A packed provisional designation of a minor planet (`"K08Aa0A"` = `2008 AA360`) or,
/// with `comet`, of a comet (`"J95A010"` = `1995 A1`, `"J94P01b"` = `1994 P1-B`).
pub fn unpack_provisional(p: &str, comet: bool) -> Option<String> {
    let c: Vec<char> = p.trim().chars().collect();
    if c.len() != 7 {
        return None;
    }
    // Survey designations: PLS2040 = 2040 P-L, T1S3138 = 3138 T-1.
    let survey: String = c[..3].iter().collect();
    let tail: String = c[3..].iter().collect();
    match survey.as_str() {
        "PLS" => return Some(format!("{tail} P-L")),
        "T1S" => return Some(format!("{tail} T-1")),
        "T2S" => return Some(format!("{tail} T-2")),
        "T3S" => return Some(format!("{tail} T-3")),
        _ => {}
    }
    let year = century(c[0])? * 100 + c[1].to_digit(10)? as i32 * 10 + c[2].to_digit(10)? as i32;
    let half = c[3];
    if !half.is_ascii_uppercase() {
        return None;
    }
    let cycle = base62(c[4])? * 10 + c[5].to_digit(10)?;
    if comet {
        let frag = c[6];
        let base = format!("{year} {half}{cycle}");
        return Some(match frag {
            '0' => base,
            f if f.is_ascii_lowercase() => format!("{base}-{}", f.to_ascii_uppercase()),
            _ => return None,
        });
    }
    let second = c[6];
    if !second.is_ascii_uppercase() {
        return None;
    }
    Some(if cycle == 0 {
        format!("{year} {half}{second}")
    } else {
        format!("{year} {half}{second}{cycle}")
    })
}

/// A packed date (`"K2669"` = 2026 June 9.0 TT) as a Julian date.
pub fn unpack_epoch(p: &str) -> Option<f64> {
    let c: Vec<char> = p.trim().chars().collect();
    if c.len() != 5 {
        return None;
    }
    let year = century(c[0])? * 100 + c[1].to_digit(10)? as i32 * 10 + c[2].to_digit(10)? as i32;
    let code = |x: char| -> Option<u32> {
        let v = base62(x)?;
        (1..=31).contains(&v).then_some(v)
    };
    let (month, day) = (code(c[3])?, code(c[4])?);
    if month > 12 {
        return None;
    }
    Some(skyfix_core::time::civil_to_jd(year, month, day))
}

fn field(line: &str, from: usize, to: usize) -> &str {
    // Columns are 1-based and inclusive, as the MPC documents them.
    let bytes = line.as_bytes();
    if from > bytes.len() {
        return "";
    }
    let to = to.min(bytes.len());
    std::str::from_utf8(&bytes[from - 1..to])
        .unwrap_or("")
        .trim()
}

fn num(line: &str, from: usize, to: usize, what: &str) -> Result<f64, String> {
    let s = field(line, from, to);
    s.parse::<f64>()
        .map_err(|_| format!("column {from}-{to} ({what}) is not a number: {s:?}"))
}

/// One MPCORB line (MPOrbitFormat).
pub fn parse_mpcorb_line(line: &str) -> Result<OrbitalElements, String> {
    let packed = field(line, 1, 7);
    let epoch = unpack_epoch(field(line, 21, 25)).ok_or_else(|| {
        format!(
            "columns 21-25 are not a packed epoch: {:?}",
            field(line, 21, 25)
        )
    })?;
    let m = num(line, 27, 35, "mean anomaly")?;
    let peri = num(line, 38, 46, "argument of perihelion")?;
    let node = num(line, 49, 57, "node")?;
    let inc = num(line, 60, 68, "inclination")?;
    let e = num(line, 71, 79, "eccentricity")?;
    let a = num(line, 93, 103, "semimajor axis")?;
    if !(e < 1.0 && a > 0.0) {
        return Err(format!(
            "an MPCORB orbit needs e < 1 and a > 0 (e = {e}, a = {a})"
        ));
    }
    let h = field(line, 9, 13).parse::<f64>().ok();
    let g = field(line, 15, 19).parse::<f64>().unwrap_or(0.15);
    let n = GAUSS_K / (a * a * a).sqrt();
    let designation = unpack_number(packed)
        .map(|n| format!("({n})"))
        .or_else(|| unpack_provisional(packed, false));
    let readable = field(line, 167, 194);
    let name = if readable.is_empty() {
        designation.clone().unwrap_or_else(|| packed.to_string())
    } else {
        readable.to_string()
    };
    Ok(OrbitalElements {
        name,
        designation,
        class: OrbitClass::Asteroid,
        epoch_jd_tt: Some(epoch),
        perihelion_distance_au: a * (1.0 - e),
        eccentricity: e,
        inclination_deg: inc,
        ascending_node_deg: node,
        argument_of_perihelion_deg: peri,
        perihelion_jd_tt: epoch - m.to_radians() / n,
        magnitude: match h {
            Some(h) => MagnitudeModel::Hg { h, g },
            None => MagnitudeModel::None,
        },
        source: "mpcorb".to_string(),
    })
}

/// One comet line in the MPC's "Ephemerides and Orbital Elements" format (the layout of
/// `CometEls.txt`).
pub fn parse_comet_line(line: &str) -> Result<OrbitalElements, String> {
    let year: i32 = field(line, 15, 18).parse().map_err(|_| {
        format!(
            "columns 15-18 are not a perihelion year: {:?}",
            field(line, 15, 18)
        )
    })?;
    let month: u32 = field(line, 20, 21)
        .parse()
        .map_err(|_| "columns 20-21 are not a perihelion month".to_string())?;
    let day = num(line, 23, 29, "perihelion day")?;
    let q = num(line, 31, 39, "perihelion distance")?;
    let e = num(line, 42, 49, "eccentricity")?;
    let peri = num(line, 52, 59, "argument of perihelion")?;
    let node = num(line, 62, 69, "node")?;
    let inc = num(line, 72, 79, "inclination")?;
    if !(1..=12).contains(&month) {
        return Err(format!("perihelion month {month}"));
    }
    let tp = skyfix_core::time::civil_to_jd(year, month, 1) + day - 1.0;
    let epoch = {
        let s = field(line, 82, 89);
        (s.len() == 8)
            .then(|| {
                let y: i32 = s[..4].parse().ok()?;
                let m: u32 = s[4..6].parse().ok()?;
                let d: u32 = s[6..8].parse().ok()?;
                Some(skyfix_core::time::civil_to_jd(y, m, d))
            })
            .flatten()
    };
    let m1 = field(line, 92, 95).parse::<f64>().ok();
    let k = field(line, 97, 100).parse::<f64>().ok();
    let number = field(line, 1, 4);
    let kind = field(line, 5, 5);
    let packed = field(line, 6, 12);
    let designation = if !number.is_empty() {
        number
            .parse::<u32>()
            .ok()
            .map(|n| format!("{n}{}", if kind.is_empty() { "P" } else { kind }))
    } else {
        unpack_provisional(packed, true).map(|d| format!("{kind}/{d}"))
    };
    let readable = field(line, 103, 158);
    let name = if readable.is_empty() {
        designation.clone().unwrap_or_else(|| packed.to_string())
    } else {
        readable.to_string()
    };
    Ok(OrbitalElements {
        name,
        designation,
        class: OrbitClass::Comet,
        epoch_jd_tt: epoch,
        perihelion_distance_au: q,
        eccentricity: e,
        inclination_deg: inc,
        ascending_node_deg: node,
        argument_of_perihelion_deg: peri,
        perihelion_jd_tt: tp,
        magnitude: match (m1, k) {
            (Some(m1), Some(k)) => MagnitudeModel::Comet { m1, k1: 2.5 * k },
            (Some(m1), None) => MagnitudeModel::Comet { m1, k1: 10.0 },
            _ => MagnitudeModel::None,
        },
        source: "mpc_comet".to_string(),
    })
}

/// Elements typed in by hand (EXPLORER_API.md `ManualElements`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualElements {
    pub name: String,
    #[serde(default)]
    pub class: Option<OrbitClass>,
    #[serde(default)]
    pub epoch_jd_tt: Option<f64>,
    /// The epoch as an RFC 3339 string read on the TT scale.
    #[serde(default)]
    pub epoch_tt: Option<String>,
    #[serde(default)]
    pub q_au: Option<f64>,
    #[serde(default)]
    pub a_au: Option<f64>,
    pub e: f64,
    pub i_deg: f64,
    pub node_deg: f64,
    pub peri_deg: f64,
    #[serde(default)]
    pub tp_jd_tt: Option<f64>,
    #[serde(default)]
    pub tp_tt: Option<String>,
    /// Mean anomaly at the epoch (elliptic orbits), instead of the perihelion time.
    #[serde(default)]
    pub mean_anomaly_deg: Option<f64>,
    #[serde(default)]
    pub h: Option<f64>,
    #[serde(default)]
    pub g: Option<f64>,
    #[serde(default)]
    pub m1: Option<f64>,
    #[serde(default)]
    pub k1: Option<f64>,
}

fn tt_of(jd: Option<f64>, iso: &Option<String>, what: &str) -> Result<Option<f64>, String> {
    match (jd, iso) {
        (Some(j), _) => Ok(Some(j)),
        (None, Some(s)) => parse_utc(s)
            .map(Some)
            .map_err(|_| format!("{what}: {s:?} is not an RFC 3339 time")),
        (None, None) => Ok(None),
    }
}

impl ManualElements {
    pub fn into_elements(self) -> Result<OrbitalElements, String> {
        let epoch = tt_of(self.epoch_jd_tt, &self.epoch_tt, "epoch_tt")?;
        let e = self.e;
        let q = match (self.q_au, self.a_au) {
            (Some(q), _) => q,
            (None, Some(a)) if e < 1.0 => a * (1.0 - e),
            (None, Some(a)) if e > 1.0 && a < 0.0 => a * (1.0 - e),
            _ => return Err(format!("{}: give q_au, or a_au with e != 1", self.name)),
        };
        let tp = match (
            tt_of(self.tp_jd_tt, &self.tp_tt, "tp_tt")?,
            self.mean_anomaly_deg,
        ) {
            (Some(tp), _) => tp,
            (None, Some(m)) => {
                let ep = epoch.ok_or_else(|| {
                    format!("{}: a mean anomaly needs the epoch it refers to", self.name)
                })?;
                if e >= 1.0 {
                    return Err(format!("{}: a mean anomaly needs e < 1", self.name));
                }
                let a = q / (1.0 - e);
                ep - m.to_radians() / (GAUSS_K / (a * a * a).sqrt())
            }
            (None, None) => {
                return Err(format!(
                    "{}: give the perihelion time (tp_jd_tt / tp_tt) or a mean anomaly",
                    self.name
                ));
            }
        };
        let class = self.class.unwrap_or(if self.m1.is_some() || e >= 0.95 {
            OrbitClass::Comet
        } else {
            OrbitClass::Asteroid
        });
        let magnitude = match (self.h, self.m1) {
            (Some(h), _) => MagnitudeModel::Hg {
                h,
                g: self.g.unwrap_or(0.15),
            },
            (None, Some(m1)) => MagnitudeModel::Comet {
                m1,
                k1: self.k1.unwrap_or(10.0),
            },
            _ => MagnitudeModel::None,
        };
        let out = OrbitalElements {
            name: self.name,
            designation: None,
            class,
            epoch_jd_tt: epoch,
            perihelion_distance_au: q,
            eccentricity: e,
            inclination_deg: self.i_deg,
            ascending_node_deg: self.node_deg,
            argument_of_perihelion_deg: self.peri_deg,
            perihelion_jd_tt: tp,
            magnitude,
            source: "manual".to_string(),
        };
        out.check()?;
        Ok(out)
    }
}

/// Parse elements from text: MPCORB lines and MPC comet lines (header and blank lines
/// skipped), or JSON (one object or an array) of `ManualElements` or of
/// `OrbitalElements`. Every body found, or the first line that is neither.
pub fn parse_orbits(text: &str) -> Result<Vec<OrbitalElements>, String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let v: serde_json::Value =
            serde_json::from_str(trimmed).map_err(|e| format!("elements JSON: {e}"))?;
        let items = match v {
            serde_json::Value::Array(a) => a,
            o => vec![o],
        };
        return items
            .into_iter()
            .map(|item| {
                if item.get("perihelion_distance_au").is_some() {
                    let el: OrbitalElements =
                        serde_json::from_value(item).map_err(|e| format!("elements JSON: {e}"))?;
                    el.check()?;
                    Ok(el)
                } else {
                    serde_json::from_value::<ManualElements>(item)
                        .map_err(|e| format!("elements JSON: {e}"))?
                        .into_elements()
                }
            })
            .collect();
    }
    let mut out = Vec::new();
    for (k, raw) in text.lines().enumerate() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.starts_with("---") || line.len() < 80 {
            continue;
        }
        // MPCORB: a packed epoch in 21-25 and numbers from 27; the comet layout has the
        // perihelion year in 15-18 and a blank in 19.
        let looks_mpcorb = unpack_epoch(field(line, 21, 25)).is_some()
            && field(line, 27, 35).parse::<f64>().is_ok();
        let looks_comet = field(line, 15, 18).parse::<i32>().is_ok()
            && line.as_bytes().get(18) == Some(&b' ')
            && field(line, 31, 39).parse::<f64>().is_ok();
        let parsed = if looks_mpcorb {
            parse_mpcorb_line(line)
        } else if looks_comet {
            parse_comet_line(line)
        } else if out.is_empty() && k < 60 {
            // MPCORB's header.
            continue;
        } else {
            Err("neither an MPCORB line nor an MPC comet line".to_string())
        };
        let el = parsed.map_err(|e| format!("line {}: {e}", k + 1))?;
        el.check()?;
        out.push(el);
    }
    if out.is_empty() {
        return Err("no orbital elements found".to_string());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Two-body propagation in universal variables
// ---------------------------------------------------------------------------

/// Stumpff functions `C(z)` and `S(z)`. Their power series for `|z| < 1` (the closed
/// forms lose digits to cancellation there, which near-parabolic orbits live in), the
/// closed forms beyond.
fn stumpff(z: f64) -> (f64, f64) {
    if z.abs() < 1.0 {
        // C = sum (-z)^k / (2k+2)!, S = sum (-z)^k / (2k+3)!; 16 terms reach 1e-30.
        let (mut c, mut s) = (0.0, 0.0);
        let (mut tc, mut ts) = (0.5, 1.0 / 6.0);
        for k in 0..16 {
            c += tc;
            s += ts;
            let k = k as f64;
            tc *= -z / ((2.0 * k + 3.0) * (2.0 * k + 4.0));
            ts *= -z / ((2.0 * k + 4.0) * (2.0 * k + 5.0));
        }
        (c, s)
    } else if z > 0.0 {
        let r = z.sqrt();
        ((1.0 - r.cos()) / z, (r - r.sin()) / (z * r))
    } else {
        let r = (-z).sqrt();
        ((r.cosh() - 1.0) / -z, (r.sinh() - r) / (-z * r))
    }
}

/// Heliocentric position (au), J2000.0 ecliptic axes, `dt` days after perihelion.
pub fn position_ecliptic_au(el: &OrbitalElements, dt_days: f64) -> Result<Vec3, String> {
    let mu = GAUSS_K * GAUSS_K;
    let (q, e) = (el.perihelion_distance_au, el.eccentricity);
    let alpha = (1.0 - e) / q;
    let target = mu.sqrt() * dt_days;
    let f = |chi: f64| {
        let z = alpha * chi * chi;
        let (c, s) = stumpff(z);
        let fv = e * chi * chi * chi * s + q * chi - target;
        let r = e * chi * chi * c + q;
        let r2 = e * chi * (1.0 - z * s);
        (fv, r, r2)
    };
    // Starting value (Vallado): mean anomaly for ellipses, the logarithmic estimate for
    // clear hyperbolas, Barker's parabola for everything near e = 1.
    let barker = || {
        let p = 2.0 * q;
        let s = 0.5 * (1.0 / (3.0 * (mu / (p * p * p)).sqrt() * dt_days)).atan();
        let w = s.tan().cbrt().atan();
        p.sqrt() * 2.0 / (2.0 * w).tan()
    };
    let mut chi = if dt_days == 0.0 {
        0.0
    } else if e < 0.99 {
        target * alpha
    } else if e > 1.01 {
        let a = 1.0 / alpha;
        let arg = (-2.0 * mu * alpha * dt_days.abs()) / ((-mu * a).sqrt() * e);
        if arg > 1.5 {
            dt_days.signum() * (-a).sqrt() * arg.ln()
        } else {
            barker()
        }
    } else {
        barker()
    };
    let mut converged = dt_days == 0.0;
    for _ in 0..200 {
        if converged {
            break;
        }
        let (fv, d1, d2) = f(chi);
        // Laguerre-Conway, n = 5.
        let n = 5.0;
        let disc = ((n - 1.0) * (n - 1.0) * d1 * d1 - n * (n - 1.0) * fv * d2)
            .abs()
            .sqrt();
        let denom = d1 + d1.signum() * disc;
        let step = n * fv / denom;
        chi -= step;
        converged = step.abs() <= 1e-12 * chi.abs().max(1.0);
    }
    if !converged || !chi.is_finite() {
        return Err(format!(
            "{}: Kepler's equation did not converge {dt_days} days from perihelion",
            el.name
        ));
    }
    let z = alpha * chi * chi;
    let (c, s) = stumpff(z);
    let fcoef = 1.0 - chi * chi * c / q;
    let gcoef = dt_days - chi * chi * chi * s / mu.sqrt();
    let vp = (mu * (1.0 + e) / q).sqrt();
    let (x, y) = (fcoef * q, gcoef * vp);
    let (w, i, o) = (
        el.argument_of_perihelion_deg.to_radians(),
        el.inclination_deg.to_radians(),
        el.ascending_node_deg.to_radians(),
    );
    let (sw, cw) = w.sin_cos();
    let (si, ci) = i.sin_cos();
    let (so, co) = o.sin_cos();
    let p = [cw * co - sw * so * ci, cw * so + sw * co * ci, sw * si];
    let qv = [-sw * co - cw * so * ci, -sw * so + cw * co * ci, cw * si];
    Ok(add(scale(p, x), scale(qv, y)))
}

/// Heliocentric position (au) on the equatorial axes the planet provider uses (J2000.0,
/// treated as the ICRS), at TT Julian date `jd_tt`.
pub fn heliocentric_au(el: &OrbitalElements, jd_tt: f64) -> Result<Vec3, String> {
    let v = position_ecliptic_au(el, jd_tt - el.perihelion_jd_tt)?;
    let (s, c) = (OBLIQUITY_J2000_ARCSEC / 3600.0).to_radians().sin_cos();
    Ok([v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c])
}

// ---------------------------------------------------------------------------
// Apparent place and the explorer's body state
// ---------------------------------------------------------------------------

/// Where the body is at one instant, geocentric.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrbitPosition {
    pub name: String,
    pub class: OrbitClass,
    pub jd_utc: f64,
    pub utc: String,
    /// Apparent geocentric right ascension and declination of date, degrees.
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub gha_deg: f64,
    /// Light-time distance from the Earth's centre, and from the Sun.
    pub distance_au: f64,
    pub heliocentric_distance_au: f64,
    pub light_time_s: f64,
    /// Sun-body angle seen from the Earth, and Sun-body-Earth angle, degrees.
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub magnitude: Option<f64>,
    /// Days between this instant and the elements' epoch (or perihelion time).
    pub elements_age_days: f64,
    pub warnings: Vec<String>,
}

fn magnitude(el: &OrbitalElements, r: f64, delta: f64, phase_deg: f64) -> Option<f64> {
    let m = match el.magnitude {
        MagnitudeModel::Hg { h, g } => {
            let t = (phase_deg.to_radians() / 2.0).tan();
            let p1 = (-3.33 * t.powf(0.63)).exp();
            let p2 = (-1.87 * t.powf(1.22)).exp();
            h + 5.0 * (r * delta).log10() - 2.5 * ((1.0 - g) * p1 + g * p2).log10()
        }
        MagnitudeModel::Comet { m1, k1 } => m1 + 5.0 * delta.log10() + k1 * r.log10(),
        MagnitudeModel::None => return None,
    };
    m.is_finite().then_some(m)
}

/// The apparent geocentric place of `el` at `jd_utc`.
pub fn orbit_position(el: &OrbitalElements, jd_utc: f64) -> Result<OrbitPosition, AlmanacError> {
    let (lo, hi) = sun_planet_coverage();
    if !jd_utc.is_finite() || jd_utc < lo || jd_utc > hi {
        return Err(AlmanacError::Unavailable {
            body: el.name.clone(),
            message: format!(
                "custom bodies are computed where the Earth's ephemeris answers ({} .. {})",
                format_utc(lo),
                format_utc(hi)
            ),
        });
    }
    let t = jd_tt(jd_utc);
    let earth = heliocentric_position_au("Earth", t).map_err(|e| unavailable("Earth", e))?;
    let h = 0.01;
    let earth_vel = scale(
        sub(
            heliocentric_position_au("Earth", t + h).map_err(|e| unavailable("Earth", e))?,
            heliocentric_position_au("Earth", t - h).map_err(|e| unavailable("Earth", e))?,
        ),
        0.5 / h,
    );
    let err = |m: String| AlmanacError::Unavailable {
        body: el.name.clone(),
        message: m,
    };
    let mut tau = 0.0;
    let mut body = heliocentric_au(el, t).map_err(err)?;
    for _ in 0..6 {
        let next = norm(sub(body, earth)) / C_AU_PER_DAY;
        let done = (next - tau).abs() < 1e-11;
        tau = next;
        body = heliocentric_au(el, t - tau).map_err(err)?;
        if done {
            break;
        }
    }
    let astrometric = sub(body, earth);
    let vc = scale(earth_vel, 1.0 / C_AU_PER_DAY);
    let bpn = icrs_to_true_of_date(t);
    let app = mat_vec(&bpn, apply_annual_aberration(unit(astrometric), vc));
    let sun_app = mat_vec(&bpn, apply_annual_aberration(unit(scale(earth, -1.0)), vc));
    let (ra, dec) = radec_of(app);
    let gha = (gast_deg(jd_ut1(jd_utc, 0.0), t) - ra).rem_euclid(360.0);
    let (delta, r) = (norm(astrometric), norm(body));
    let phase = angle(scale(body, -1.0), scale(astrometric, -1.0)).to_degrees();
    let age = t - el.reference_jd_tt();
    let mut warnings = Vec::new();
    if age.abs() > STALE_AFTER_DAYS {
        warnings.push(format!(
            "These elements are {:.0} days from their epoch. An unperturbed orbit drifts \
             from the real one within weeks to months (fastest for near-Earth objects and \
             comets passing Jupiter): fetch current elements for positions better than a \
             few arcminutes.",
            age.abs()
        ));
    }
    Ok(OrbitPosition {
        name: el.name.clone(),
        class: el.class,
        jd_utc,
        utc: format_utc(jd_utc),
        ra_deg: ra,
        dec_deg: dec,
        gha_deg: gha,
        distance_au: delta,
        heliocentric_distance_au: r,
        light_time_s: tau * 86_400.0,
        elongation_deg: angle(app, sun_app).to_degrees(),
        phase_angle_deg: phase,
        magnitude: magnitude(el, r, delta, phase),
        elements_age_days: age,
        warnings,
    })
}

/// The explorer's `BodyState` for a custom body seen from `site` (the same topocentric
/// pipeline as `sky_state`, CONVENTIONS 13.2), with the orbit's own quantities.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomBodyState {
    pub state: BodyState,
    pub position: OrbitPosition,
}

pub fn custom_body_state(
    el: &OrbitalElements,
    site: &Site,
    jd_utc: f64,
) -> Result<CustomBodyState, AlmanacError> {
    let site = checked_site(site)?;
    let p = orbit_position(el, jd_utc)?;
    let dist_km = p.distance_au * AU_KM;
    let st = ApparentState {
        body: el.name.clone(),
        kind: BodyKind::Planet,
        jd_utc,
        ra_deg: p.ra_deg,
        dec_deg: p.dec_deg,
        gha_deg: p.gha_deg,
        distance_km: Some(dist_km),
        semidiameter_arcmin: 0.0,
        horizontal_parallax_arcmin: (WGS84_A_KM / dist_km).asin().to_degrees() * 60.0,
        magnitude: p.magnitude,
        phase_angle_deg: Some(p.phase_angle_deg),
        illuminated_fraction: None,
        elongation_deg: Some(p.elongation_deg),
        bright_limb_angle_deg: None,
    };
    let h = horizontal(&st, &site);
    Ok(CustomBodyState {
        state: body_state(&st, &h, &site),
        position: p,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_forms_from_the_mpc_documentation() {
        for (p, want) in [
            ("J95X00A", "1995 XA"),
            ("J95X01L", "1995 XL1"),
            ("J95F13B", "1995 FB13"),
            ("J98SA8Q", "1998 SQ108"),
            ("J98SC7V", "1998 SV127"),
            ("J98SG2S", "1998 SS162"),
            ("K99AJ3Z", "2099 AZ193"),
            ("K08Aa0A", "2008 AA360"),
            ("K07Tf8A", "2007 TA418"),
            ("PLS2040", "2040 P-L"),
            ("T1S3138", "3138 T-1"),
        ] {
            assert_eq!(unpack_provisional(p, false).as_deref(), Some(want), "{p}");
        }
        for (p, want) in [
            ("J95A010", "1995 A1"),
            ("J94P01b", "1994 P1-B"),
            ("K48X130", "2048 X13"),
            ("K33L89c", "2033 L89-C"),
            ("K88AA30", "2088 A103"),
        ] {
            assert_eq!(unpack_provisional(p, true).as_deref(), Some(want), "{p}");
        }
        for (p, n) in [
            ("03202", 3202),
            ("50000", 50000),
            ("A0345", 100_345),
            ("a0017", 360_017),
            ("K3289", 203_289),
            ("~0000", 620_000),
            ("~000z", 620_061),
            ("~AZaz", 3_140_113),
            ("~zzzz", 15_396_335),
        ] {
            assert_eq!(unpack_number(p), Some(n), "{p}");
        }
        assert_eq!(
            unpack_epoch("K2669"),
            Some(skyfix_core::time::civil_to_jd(2026, 6, 9))
        );
    }

    #[test]
    fn universal_variables_agree_with_keplers_equation() {
        // An ellipse (e = 0.5, a = 2): after a quarter period the classical solution.
        let el = OrbitalElements {
            name: "test".into(),
            designation: None,
            class: OrbitClass::Asteroid,
            epoch_jd_tt: None,
            perihelion_distance_au: 1.0,
            eccentricity: 0.5,
            inclination_deg: 0.0,
            ascending_node_deg: 0.0,
            argument_of_perihelion_deg: 0.0,
            perihelion_jd_tt: 0.0,
            magnitude: MagnitudeModel::None,
            source: "manual".into(),
        };
        let a = 2.0f64;
        let n = GAUSS_K / a.powf(1.5);
        for m in [0.3f64, 1.5, 3.0, -2.0] {
            let mut ecc = m;
            for _ in 0..50 {
                ecc -= (ecc - 0.5 * ecc.sin() - m) / (1.0 - 0.5 * ecc.cos());
            }
            let (x, y) = (
                a * (ecc.cos() - 0.5),
                a * (1.0f64 - 0.25).sqrt() * ecc.sin(),
            );
            let p = position_ecliptic_au(&el, m / n).unwrap();
            assert!(
                (p[0] - x).abs() < 1e-12 && (p[1] - y).abs() < 1e-12,
                "{m}: {p:?}"
            );
        }
        // Parabola and hyperbola: the radius obeys r = q (1 + e) / (1 + e cos v).
        for e in [1.0, 1.0000001, 1.2, 3.0] {
            let el = OrbitalElements {
                eccentricity: e,
                ..el.clone()
            };
            for dt in [-500.0, -3.0, 0.5, 40.0, 2000.0] {
                let p = position_ecliptic_au(&el, dt).unwrap();
                let (r, v) = (norm(p), p[1].atan2(p[0]));
                let want = (1.0 + e) / (1.0 + e * v.cos());
                assert!(
                    (r / want - 1.0).abs() < 1e-10,
                    "e {e} dt {dt}: {r} vs {want}"
                );
            }
        }
    }
}
