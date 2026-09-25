//! What the adapters (WASM, CLI) call: station lookup, curves, high and low water and the
//! state of the tide now, as serde types (wire format: `docs/EXPLORER_API.md`, "Tides").
//!
//! Errors are strings that start with a machine-readable code and a colon:
//! `pack_not_loaded`, `unknown_station`, `datum_unavailable`, `no_prediction`,
//! `outside_range`, `bad_request`.

use serde::Serialize;
use skyfix_core::time::format_utc;

use crate::db::{Datum, Harmonic, Station, StationKind, Subordinate, TideDb, TideType, flags};
use crate::predict::{Extreme, ExtremeKind, NodalMode, jd_year_start, table_rule};

/// The label every tide result carries (EXPANSION_PLAN, tides work package).
pub const LABEL: &str =
    "US stations (NOAA); predictions, not observations; weather and surge not included";

/// First and last instants offered: 1900-01-01 to 2100-12-31 (Schureman's elements hold
/// far beyond; the constants describe today's harbours).
pub fn first_jd() -> f64 {
    jd_year_start(1900)
}
pub fn end_jd() -> f64 {
    jd_year_start(2101)
}

/// Longest `tide_extremes` window, days.
pub const MAX_EXTREMES_DAYS: f64 = 400.0;
/// Most samples one `tide_predict` call returns.
pub const MAX_SAMPLES: usize = 20_000;

pub fn pack_not_loaded() -> String {
    "pack_not_loaded: tide predictions need the tides-us pack (US stations, NOAA), which is \
     not loaded"
        .to_string()
}

// ---------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------

/// One station, as every tide result describes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TideStation {
    pub id: String,
    pub name: String,
    /// Two-letter U.S. state or territory code; `null` for a foreign port.
    pub state: Option<String>,
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// `harmonic` (NOAA "R": a full curve from harmonic constants) or `subordinate`
    /// (NOAA "S": high and low water only, from a reference station).
    pub kind: &'static str,
    pub reference_id: Option<String>,
    pub reference_name: Option<String>,
    /// `semidiurnal`, `mixed_semidiurnal`, `mixed_diurnal` or `diurnal`, by the form
    /// number (CONVENTIONS 13.11); a subordinate station reports its reference's.
    pub tide_type: Option<&'static str>,
    /// `F = (K1 + O1)/(M2 + S2)` of the harmonic constants (the reference station's for
    /// a subordinate one).
    pub form_number: Option<f64>,
    /// Datums heights can be given on, highest first.
    pub datums: Vec<&'static str>,
    /// What an empty `datum` argument means here: `MLLW`, or `MSL` without datums.
    pub default_datum: &'static str,
    /// `harmonic` (a true curve), `interpolated` (subordinate: the cosine curve between
    /// its high and low waters, an estimate) or `none` (cannot be predicted).
    pub curve: &'static str,
    /// `noaa_differs`, `no_datums`, `no_constants`, `reference_unusable`,
    /// `non_navigational`.
    pub flags: Vec<&'static str>,
    /// Plain sentences the interface should show with this station.
    pub notes: Vec<String>,
}

/// A station with its distance from a place.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TideStationNear {
    #[serde(flatten)]
    pub station: TideStation,
    pub distance_km: f64,
    pub distance_nm: f64,
    /// Initial great-circle bearing from the place to the station, degrees true.
    pub bearing_deg: f64,
}

/// One high or low water.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TideEvent {
    /// `high` or `low`.
    pub kind: &'static str,
    pub jd_utc: f64,
    pub utc: String,
    /// Above the result's datum, metres.
    pub height_m: f64,
}

/// `tide_extremes`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TideExtremes {
    pub station: TideStation,
    pub datum: &'static str,
    /// `harmonic` or `subordinate_offsets`.
    pub method: &'static str,
    pub jd_start: f64,
    pub jd_end: f64,
    /// Sorted by time; only instants inside `[jd_start, jd_end]`.
    pub extremes: Vec<TideEvent>,
    pub label: &'static str,
    pub notes: Vec<String>,
}

/// `tide_predict`: heights at `jd_start + k·step` (the adapter turns the two vectors
/// into `Float64Array`s).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TideCurve {
    pub station: TideStation,
    pub datum: &'static str,
    /// `harmonic` or `interpolated` (subordinate stations).
    pub method: &'static str,
    pub jd_start: f64,
    pub jd_end: f64,
    pub step_min: f64,
    pub jd_utc: Vec<f64>,
    pub height_m: Vec<f64>,
    pub label: &'static str,
    pub notes: Vec<String>,
}

/// `tide_now`: the tide at one instant and the high and low waters around it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TideNow {
    pub station: TideStation,
    pub datum: &'static str,
    /// `harmonic` or `interpolated`.
    pub method: &'static str,
    pub jd_utc: f64,
    pub utc: String,
    pub height_m: f64,
    /// Rate of rise, metres per hour (negative when falling).
    pub rate_m_per_h: f64,
    /// `rising` or `falling`.
    pub state: &'static str,
    pub previous: Option<TideEvent>,
    pub next: Option<TideEvent>,
    pub next_high: Option<TideEvent>,
    pub next_low: Option<TideEvent>,
    pub label: &'static str,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------------------
// Station descriptions
// ---------------------------------------------------------------------------------------

fn flag_names(f: u8) -> Vec<&'static str> {
    [
        (flags::NOAA_DIFFERS, "noaa_differs"),
        (flags::NO_DATUMS, "no_datums"),
        (flags::NO_CONSTANTS, "no_constants"),
        (flags::REFERENCE_UNUSABLE, "reference_unusable"),
        (flags::NON_NAVIGATIONAL, "non_navigational"),
    ]
    .iter()
    .filter(|(bit, _)| f & bit != 0)
    .map(|(_, n)| *n)
    .collect()
}

fn datum_list(db: &TideDb, s: &Station) -> Vec<Datum> {
    match &s.kind {
        StationKind::Harmonic(h) if h.terms.is_empty() => Vec::new(),
        StationKind::Harmonic(h) => h.datums.available(),
        StationKind::Subordinate(_) => {
            if usable_reference(db, s).is_some() {
                vec![Datum::Mllw]
            } else {
                Vec::new()
            }
        }
    }
}

/// The reference station of a subordinate one, when it can give MLLW heights.
fn usable_reference<'a>(db: &'a TideDb, s: &Station) -> Option<(&'a Station, &'a Harmonic)> {
    let StationKind::Subordinate(sub) = &s.kind else {
        return None;
    };
    if s.has(flags::REFERENCE_UNUSABLE) {
        return None;
    }
    let r = db.stations.get(sub.reference as usize)?;
    match &r.kind {
        StationKind::Harmonic(h)
            if !h.terms.is_empty() && h.datums.offset_m(Datum::Mllw).is_some() =>
        {
            Some((r, h))
        }
        _ => None,
    }
}

pub fn describe(db: &TideDb, s: &Station) -> TideStation {
    let datums = datum_list(db, s);
    let default_datum = if datums.contains(&Datum::Mllw) {
        "MLLW"
    } else {
        "MSL"
    };
    let mut notes = Vec::new();
    let (kind, reference, form_number, curve) = match &s.kind {
        StationKind::Harmonic(h) => (
            "harmonic",
            None,
            h.form_number(),
            if h.terms.is_empty() {
                "none"
            } else {
                "harmonic"
            },
        ),
        StationKind::Subordinate(sub) => {
            let r = db.stations.get(sub.reference as usize);
            let form = r.and_then(|r| match &r.kind {
                StationKind::Harmonic(h) => h.form_number(),
                StationKind::Subordinate(_) => None,
            });
            let usable = usable_reference(db, s).is_some();
            if usable {
                notes.push(format!(
                    "Subordinate station: NOAA gives only high and low water here, from {} \
                     with time and height differences. The curve between them is the \
                     traditional cosine interpolation, an estimate.",
                    r.map(|r| r.name.as_str())
                        .unwrap_or("its reference station")
                ));
            }
            (
                "subordinate",
                r,
                form,
                if usable { "interpolated" } else { "none" },
            )
        }
    };
    let tide_type = form_number.map(|f| TideType::from_form_number(f).name());
    if s.has(flags::NOAA_DIFFERS) {
        notes.push(
            "NOAA's own published predictions here differ from what its published harmonic \
             constants give by more than 2 minutes or 5 cm; treat these as approximate."
                .into(),
        );
    }
    if s.has(flags::NO_DATUMS) {
        notes.push(
            "NOAA publishes no tidal datums here: heights are about mean sea level only.".into(),
        );
    }
    if curve == "none" {
        notes.push(if s.is_harmonic() {
            "No prediction is possible here: NOAA publishes no harmonic constants for this \
             station."
                .to_string()
        } else {
            "No prediction is possible here: the reference station has no harmonic constants \
             or no chart datum."
                .to_string()
        });
    }
    if s.has(flags::NON_NAVIGATIONAL) {
        notes.push("NOAA marks this station non-navigational.".into());
    }
    TideStation {
        id: s.id.clone(),
        name: s.name.clone(),
        state: (!s.state.is_empty()).then(|| s.state.clone()),
        lat_deg: s.lat_deg,
        lon_deg: s.lon_deg,
        kind,
        reference_id: reference.map(|r| r.id.clone()),
        reference_name: reference.map(|r| r.name.clone()),
        tide_type,
        form_number,
        datums: datums.iter().map(|d| d.name()).collect(),
        default_datum,
        curve,
        flags: flag_names(s.flags),
        notes,
    }
}

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

fn station<'a>(db: &'a TideDb, id: &str) -> Result<&'a Station, String> {
    db.get(id).ok_or_else(|| {
        format!(
            "unknown_station: no tide station {:?} in the tides-us pack",
            id.trim()
        )
    })
}

fn check_jd(jd: f64, what: &str) -> Result<(), String> {
    if !jd.is_finite() {
        return Err(format!("bad_request: {what} is not a number"));
    }
    if jd < first_jd() || jd >= end_jd() {
        return Err(format!(
            "outside_range: tide predictions are offered from 1900 to 2100; {what} is {}",
            format_utc(jd)
        ));
    }
    Ok(())
}

fn check_window(jd_start: f64, jd_end: f64) -> Result<(), String> {
    check_jd(jd_start, "jd_start")?;
    check_jd(jd_end, "jd_end")?;
    if jd_end < jd_start {
        return Err("bad_request: jd_end is before jd_start".into());
    }
    Ok(())
}

/// Resolve the `datum` argument for a station (empty: its default).
fn resolve_datum(db: &TideDb, s: &Station, datum: &str) -> Result<Datum, String> {
    let available = datum_list(db, s);
    if available.is_empty() {
        return Err(format!(
            "no_prediction: station {} ({}) cannot be predicted: {}",
            s.id,
            s.name,
            if s.is_harmonic() {
                "NOAA publishes no harmonic constants for it"
            } else {
                "its reference station has no harmonic constants or no chart datum"
            }
        ));
    }
    if datum.trim().is_empty() {
        return Ok(if available.contains(&Datum::Mllw) {
            Datum::Mllw
        } else {
            Datum::Msl
        });
    }
    let d = Datum::parse(datum).ok_or_else(|| {
        format!(
            "bad_request: unknown datum {:?}; expected one of MLLW, MLW, MSL, MTL, MHW, MHHW, \
             LAT, HAT, NAVD88",
            datum.trim()
        )
    })?;
    if !available.contains(&d) {
        return Err(format!(
            "datum_unavailable: {} is not available at {} ({}); available: {}",
            d.name(),
            s.id,
            s.name,
            available
                .iter()
                .map(|d| d.name())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(d)
}

fn event(e: &Extreme) -> TideEvent {
    TideEvent {
        kind: match e.kind {
            ExtremeKind::High => "high",
            ExtremeKind::Low => "low",
        },
        jd_utc: e.jd_utc,
        utc: format_utc(e.jd_utc),
        height_m: e.height_m,
    }
}

fn common_notes(d: Datum) -> Vec<String> {
    vec![format!(
        "Heights above {} ({}), NOAA's tidal datum epoch (1983-2001 at most stations); \
         sea-level change since then is not included.",
        d.name(),
        match d {
            Datum::Mllw => "mean lower low water, the chart datum of U.S. charts",
            Datum::Mlw => "mean low water",
            Datum::Msl => "mean sea level",
            Datum::Mtl => "mean tide level",
            Datum::Mhw => "mean high water",
            Datum::Mhhw => "mean higher high water",
            Datum::Lat => "lowest astronomical tide",
            Datum::Hat => "highest astronomical tide",
            Datum::Navd88 => "the NAVD88 geodetic datum",
        }
    )]
}

/// The tide table of a harmonic station about datum `d`, over `[a, b]` (NOAA's rule for
/// ripples applied, `predict::table_rule`).
fn harmonic_extremes(h: &Harmonic, d: Datum, a: f64, b: f64) -> Vec<Extreme> {
    let off = h.datums.offset_m(d).unwrap_or(0.0);
    h.predictor(NodalMode::MidYear)
        .table_extremes(a, b)
        .into_iter()
        .map(|e| Extreme {
            height_m: e.height_m - off,
            ..e
        })
        .collect()
}

/// The tide table of a subordinate station on its MLLW, over `[a, b]`: the reference
/// station's high and low waters with the differences applied, then NOAA's ripple rule
/// on the result (NOAA applies it to the subordinate list, not the reference's: a pair
/// the offsets make deeper stays, as at Christmas Island).
fn subordinate_extremes(sub: &Subordinate, reference: &Harmonic, a: f64, b: f64) -> Vec<Extreme> {
    let span = f64::from(
        sub.time_high_min
            .unsigned_abs()
            .max(sub.time_low_min.unsigned_abs()),
    );
    let pad = (span + 30.0) / 1440.0 + 0.25;
    let off = reference.datums.offset_m(Datum::Mllw).unwrap_or(0.0);
    let raw: Vec<Extreme> = reference
        .predictor(NodalMode::MidYear)
        .extremes(a - pad, b + pad)
        .into_iter()
        .map(|e| Extreme {
            height_m: e.height_m - off,
            ..e
        })
        .collect();
    table_rule(&sub.apply(&raw))
        .into_iter()
        .filter(|e| e.jd_utc >= a && e.jd_utc <= b)
        .collect()
}

/// Extremes for any station on datum `d` (already resolved), `[a, b]`.
fn station_extremes(db: &TideDb, s: &Station, d: Datum, a: f64, b: f64) -> Vec<Extreme> {
    match &s.kind {
        StationKind::Harmonic(h) => harmonic_extremes(h, d, a, b),
        StationKind::Subordinate(sub) => match usable_reference(db, s) {
            Some((_, rh)) => subordinate_extremes(sub, rh, a, b),
            None => Vec::new(),
        },
    }
}

/// The cosine interpolation between two extremes (NOAA Tide Tables, Table 3): height
/// and rate (m/h) at `t`.
fn cosine_between(e1: &Extreme, e2: &Extreme, t: f64) -> (f64, f64) {
    let span = e2.jd_utc - e1.jd_utc;
    if span <= 0.0 {
        return (e1.height_m, 0.0);
    }
    let x = ((t - e1.jd_utc) / span).clamp(0.0, 1.0);
    let dh = e2.height_m - e1.height_m;
    let h = e1.height_m + dh * (1.0 - (std::f64::consts::PI * x).cos()) / 2.0;
    let rate = dh * std::f64::consts::PI / (2.0 * span * 24.0) * (std::f64::consts::PI * x).sin();
    (h, rate)
}

/// The two consecutive extremes around `t` in a sorted list.
fn bracket(ex: &[Extreme], t: f64) -> Option<(&Extreme, &Extreme)> {
    let k = ex.partition_point(|e| e.jd_utc <= t);
    if k == 0 || k >= ex.len() {
        return None;
    }
    Some((&ex[k - 1], &ex[k]))
}

/// The `n` stations nearest to a place (1 to 100), nearest first.
pub fn stations_near(
    db: &TideDb,
    lat_deg: f64,
    lon_deg: f64,
    n: u32,
) -> Result<Vec<TideStationNear>, String> {
    if !(lat_deg.is_finite() && (-90.0..=90.0).contains(&lat_deg)) {
        return Err(format!(
            "bad_request: latitude {lat_deg} is outside -90..90"
        ));
    }
    if !(lon_deg.is_finite() && (-360.0..=360.0).contains(&lon_deg)) {
        return Err(format!(
            "bad_request: longitude {lon_deg} is outside -360..360"
        ));
    }
    let n = n.clamp(1, 100) as usize;
    Ok(db
        .nearest(lat_deg, lon_deg, n)
        .into_iter()
        .map(|(k, d, b)| TideStationNear {
            station: describe(db, &db.stations[k]),
            distance_km: d,
            distance_nm: d / 1.852,
            bearing_deg: b,
        })
        .collect())
}

/// One station by id.
pub fn station_by_id(db: &TideDb, id: &str) -> Result<TideStation, String> {
    Ok(describe(db, station(db, id)?))
}

/// High and low water in `[jd_start, jd_end]` (at most 400 days).
pub fn extremes(
    db: &TideDb,
    id: &str,
    jd_start: f64,
    jd_end: f64,
    datum: &str,
) -> Result<TideExtremes, String> {
    let s = station(db, id)?;
    check_window(jd_start, jd_end)?;
    if jd_end - jd_start > MAX_EXTREMES_DAYS {
        return Err(format!(
            "bad_request: at most {MAX_EXTREMES_DAYS} days of high and low water per call"
        ));
    }
    let d = resolve_datum(db, s, datum)?;
    let list = station_extremes(db, s, d, jd_start, jd_end);
    let mut notes = common_notes(d);
    let method = if s.is_harmonic() {
        "harmonic"
    } else {
        notes.push(
            "Times and heights from the reference station's high and low water with NOAA's \
             published differences."
                .into(),
        );
        "subordinate_offsets"
    };
    Ok(TideExtremes {
        station: describe(db, s),
        datum: d.name(),
        method,
        jd_start,
        jd_end,
        extremes: list.iter().map(event).collect(),
        label: LABEL,
        notes,
    })
}

/// Heights every `step_min` minutes (0.5 to 1440) from `jd_start` while not after
/// `jd_end`, at most 20 000 samples.
pub fn predict(
    db: &TideDb,
    id: &str,
    jd_start: f64,
    jd_end: f64,
    step_min: f64,
    datum: &str,
) -> Result<TideCurve, String> {
    let s = station(db, id)?;
    check_window(jd_start, jd_end)?;
    if !(step_min.is_finite() && (0.5..=1440.0).contains(&step_min)) {
        return Err("bad_request: step_min must be between 0.5 and 1440 minutes".into());
    }
    let step = step_min / 1440.0;
    let n = ((jd_end - jd_start) / step + 1e-9).floor() as usize + 1;
    if n > MAX_SAMPLES {
        return Err(format!(
            "bad_request: {n} samples requested; at most {MAX_SAMPLES} per call"
        ));
    }
    let d = resolve_datum(db, s, datum)?;
    let mut notes = common_notes(d);
    let (method, jd_utc, height_m) = match &s.kind {
        StationKind::Harmonic(h) => {
            let off = h.datums.offset_m(d).unwrap_or(0.0);
            let (t, hs) = h
                .predictor(NodalMode::MidYear)
                .sample(jd_start, jd_end, step);
            ("harmonic", t, hs.into_iter().map(|x| x - off).collect())
        }
        StationKind::Subordinate(_) => {
            notes.push(
                "NOAA publishes only high and low water for this station; the curve between \
                 them is the cosine interpolation of NOAA's Tide Tables (Table 3), an \
                 estimate, not a harmonic prediction."
                    .into(),
            );
            let ex = station_extremes(db, s, d, jd_start - 1.5, jd_end + 1.5);
            let mut t = Vec::with_capacity(n);
            let mut hs = Vec::with_capacity(n);
            for k in 0..n {
                let jd = jd_start + k as f64 * step;
                if let Some((e1, e2)) = bracket(&ex, jd) {
                    t.push(jd);
                    hs.push(cosine_between(e1, e2, jd).0);
                }
            }
            ("interpolated", t, hs)
        }
    };
    Ok(TideCurve {
        station: describe(db, s),
        datum: d.name(),
        method,
        jd_start,
        jd_end,
        step_min,
        jd_utc,
        height_m,
        label: LABEL,
        notes,
    })
}

/// The tide at `jd`: height, rate, rising or falling, and the high and low waters around.
pub fn now(db: &TideDb, id: &str, jd: f64, datum: &str) -> Result<TideNow, String> {
    let s = station(db, id)?;
    check_jd(jd, "jd_utc")?;
    let d = resolve_datum(db, s, datum)?;
    // Extremes from 1.5 days before to 3 days after (diurnal ports can go a day and a
    // half between a high and the next low near the Moon's equator crossings).
    let ex = station_extremes(db, s, d, jd - 1.5, jd + 3.0);
    let (method, height_m, rate) = match &s.kind {
        StationKind::Harmonic(h) => {
            let off = h.datums.offset_m(d).unwrap_or(0.0);
            let (hh, r, _) = h.predictor(NodalMode::MidYear).eval(jd);
            ("harmonic", hh - off, r)
        }
        StationKind::Subordinate(_) => {
            let (e1, e2) = bracket(&ex, jd).ok_or_else(|| {
                format!(
                    "no_prediction: no high and low water around {}",
                    format_utc(jd)
                )
            })?;
            let (hh, r) = cosine_between(e1, e2, jd);
            ("interpolated", hh, r)
        }
    };
    let k = ex.partition_point(|e| e.jd_utc <= jd);
    let previous = k.checked_sub(1).map(|i| event(&ex[i]));
    let after = &ex[k..];
    let next = after.first().map(event);
    let next_high = after
        .iter()
        .find(|e| e.kind == ExtremeKind::High)
        .map(event);
    let next_low = after.iter().find(|e| e.kind == ExtremeKind::Low).map(event);
    let state = if rate > 0.0 {
        "rising"
    } else if rate < 0.0 {
        "falling"
    } else if next.as_ref().is_some_and(|e| e.kind == "high") {
        "rising"
    } else {
        "falling"
    };
    let mut notes = common_notes(d);
    if method == "interpolated" {
        notes.push(
            "Height and rate between high and low water by the cosine interpolation of \
             NOAA's Tide Tables (Table 3), an estimate."
                .into(),
        );
    }
    Ok(TideNow {
        station: describe(db, s),
        datum: d.name(),
        method,
        jd_utc: jd,
        utc: format_utc(jd),
        height_m,
        rate_m_per_h: rate,
        state,
        previous,
        next,
        next_high,
        next_low,
        label: LABEL,
        notes,
    })
}
