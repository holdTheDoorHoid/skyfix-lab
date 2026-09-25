//! CONVENTIONS section 10: session validation and CSV round-trip.
//!
//! OWNER: core-reduce agent. The core does no file I/O: these functions take and return
//! strings; the CLI and the WASM adapter own the files.
//!
//! The CSV dialect is ours and deliberately small, so it is written by hand here rather
//! than pulling in a CSV crate that would have to build for `wasm32-unknown-unknown`:
//!
//! ```text
//! # schema=skyfix.session/1
//! # meta.name=Philadelphia three-star
//! # observer.height_of_eye_m=2
//! # observer.assumed_position=39.9526,-75.1652
//! # instrument.horizon=sea
//! id,body,utc,altitude_deg,altitude_kind,sigma_arcmin,limb,horizon,gha_deg,dec_deg,...
//! obs-1,Vega,2026-10-01T01:30:00Z,61.2345,sextant_hs,1,center,,123.4567,38.789,0,0,
//! ```
//!
//! Every session-level field rides in the `#` block; every observation is one row; an
//! empty cell means "absent" (and therefore the type's default). Fields containing a
//! comma, a quote, a newline or leading/trailing spaces are quoted in the RFC 4180 way
//! (`"` doubled inside quotes), so [`to_csv`] followed by [`from_csv`] reproduces the
//! [`Session`] exactly, including its floating-point values.

use crate::SkyfixError;
use crate::corrections::{self, CorrectionInputs};
use crate::reduce::is_sun;
use crate::types::{
    AltitudeKind, AssumedPositionRole, Clock, GeocentricDirection, HorizonMode, Instrument, LatLon,
    Limb, Observation, Observer, SESSION_SCHEMA, Session, SessionKind, SessionMeta, Warning,
};

/// Pressure outside this band (hPa) is warned about, not rejected.
pub const PRESSURE_PLAUSIBLE_HPA: (f64, f64) = (800.0, 1100.0);
/// Temperature outside this band (C) is warned about, not rejected.
pub const TEMPERATURE_PLAUSIBLE_C: (f64, f64) = (-60.0, 60.0);

/// CSV column order. `to_csv` writes exactly these; `from_csv` accepts them in any order.
pub const CSV_COLUMNS: [&str; 13] = [
    "id",
    "body",
    "utc",
    "altitude_deg",
    "altitude_kind",
    "sigma_arcmin",
    "limb",
    "horizon",
    "gha_deg",
    "dec_deg",
    "semidiameter_arcmin",
    "horizontal_parallax_arcmin",
    "notes",
];

/// Parse and validate a session JSON document. Returns warnings for non-fatal issues.
///
/// The core ships no star catalogue (that lives in `skyfix-ephemeris`), so body names
/// are not checked here: a caller that has a provider should follow this with
/// [`validate`] and the provider's body list.
pub fn parse_session(json: &str) -> Result<(Session, Vec<Warning>), SkyfixError> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| SkyfixError::InvalidField {
            field: "session".to_string(),
            message: format!("not valid JSON: {e}"),
        })?;
    // Check the schema before the strict deserialisation, so a document from another
    // version reports its schema rather than a field-by-field serde complaint.
    let schema = value.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if schema != SESSION_SCHEMA {
        return Err(SkyfixError::UnsupportedSchema(schema.to_string()));
    }
    let session: Session =
        serde_json::from_value(value).map_err(|e| SkyfixError::InvalidField {
            field: "session".to_string(),
            message: e.to_string(),
        })?;
    let warnings = validate_without_body_catalog(&session)?;
    Ok((session, warnings))
}

/// Validate an already-constructed session (ranges, finiteness, ids, timestamps, bodies).
///
/// `known_bodies` is the provider's body list; a body outside it is an error unless the
/// observation supplies its own `geocentric` direction, which makes any name acceptable
/// (that is how the "first numerical slice" fixtures work). `"HIP <number>"` is always
/// accepted as a name; whether the provider covers it is decided at reduction time.
pub fn validate(session: &Session, known_bodies: &[&str]) -> Result<Vec<Warning>, SkyfixError> {
    validate_inner(session, Some(known_bodies))
}

/// [`validate`] without the body-name check, for callers with no catalogue to hand.
pub fn validate_without_body_catalog(session: &Session) -> Result<Vec<Warning>, SkyfixError> {
    validate_inner(session, None)
}

fn validate_inner(
    session: &Session,
    known_bodies: Option<&[&str]>,
) -> Result<Vec<Warning>, SkyfixError> {
    let mut warnings = Vec::new();

    if session.schema != SESSION_SCHEMA {
        return Err(SkyfixError::UnsupportedSchema(session.schema.clone()));
    }

    // --- observer -----------------------------------------------------------
    let o = &session.observer;
    finite("observer.height_of_eye_m", o.height_of_eye_m)?;
    if o.height_of_eye_m < 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "observer.height_of_eye_m".to_string(),
            message: format!("must be >= 0 (got {})", o.height_of_eye_m),
        });
    }
    finite("observer.pressure_hpa", o.pressure_hpa)?;
    if o.pressure_hpa <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "observer.pressure_hpa".to_string(),
            message: format!("must be > 0 (got {})", o.pressure_hpa),
        });
    }
    if o.pressure_hpa < PRESSURE_PLAUSIBLE_HPA.0 || o.pressure_hpa > PRESSURE_PLAUSIBLE_HPA.1 {
        warnings.push(Warning::Other {
            message: format!(
                "observer.pressure_hpa {} is outside the plausible band {}-{} hPa; the refraction \
                 scaling is applied as given",
                o.pressure_hpa, PRESSURE_PLAUSIBLE_HPA.0, PRESSURE_PLAUSIBLE_HPA.1
            ),
        });
    }
    finite("observer.temperature_c", o.temperature_c)?;
    if 273.0 + o.temperature_c <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "observer.temperature_c".to_string(),
            message: format!("must be above -273 C (got {})", o.temperature_c),
        });
    }
    if o.temperature_c < TEMPERATURE_PLAUSIBLE_C.0 || o.temperature_c > TEMPERATURE_PLAUSIBLE_C.1 {
        warnings.push(Warning::Other {
            message: format!(
                "observer.temperature_c {} is outside the plausible band {} to {} C; the \
                 refraction scaling is applied as given",
                o.temperature_c, TEMPERATURE_PLAUSIBLE_C.0, TEMPERATURE_PLAUSIBLE_C.1
            ),
        });
    }
    if let Some(ap) = o.assumed_position {
        finite("observer.assumed_position.lat_deg", ap.lat_deg)?;
        finite("observer.assumed_position.lon_deg", ap.lon_deg)?;
        range("observer.assumed_position.lat_deg", ap.lat_deg, -90.0, 90.0)?;
        range(
            "observer.assumed_position.lon_deg",
            ap.lon_deg,
            -180.0,
            180.0,
        )?;
    }
    if let AssumedPositionRole::Prior { sigma_nm } = o.assumed_position_role {
        finite("observer.assumed_position_role.sigma_nm", sigma_nm)?;
        if sigma_nm <= 0.0 {
            return Err(SkyfixError::InvalidField {
                field: "observer.assumed_position_role.sigma_nm".to_string(),
                message: format!("a prior needs a positive 1-sigma radius (got {sigma_nm})"),
            });
        }
        if o.assumed_position.is_none() {
            return Err(SkyfixError::InvalidField {
                field: "observer.assumed_position_role".to_string(),
                message: "role 'prior' needs an assumed_position to centre it on".to_string(),
            });
        }
    }

    // --- instrument and clock ----------------------------------------------
    finite(
        "instrument.index_correction_arcmin",
        session.instrument.index_correction_arcmin,
    )?;
    finite("clock.uncertainty_s", session.clock.uncertainty_s)?;
    if session.clock.uncertainty_s < 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "clock.uncertainty_s".to_string(),
            message: format!("must be >= 0 (got {})", session.clock.uncertainty_s),
        });
    }
    finite("clock.correction_s", session.clock.correction_s)?;
    if let Some(dut1) = session.clock.dut1_s {
        check_dut1(dut1, &mut warnings)?;
    }

    // --- observations -------------------------------------------------------
    if session.observations.is_empty() {
        warnings.push(Warning::Other {
            message: "session contains no observations; nothing to reduce or solve".to_string(),
        });
    }

    let mut seen_ids: Vec<&str> = Vec::with_capacity(session.observations.len());
    // Sights that agree in body, instant and altitude, in first-seen order so the
    // warnings come out in a deterministic sequence.
    let mut groups: Vec<SightGroup<'_>> = Vec::new();

    for (i, obs) in session.observations.iter().enumerate() {
        let at = |f: &str| format!("observations[{i}].{f}");

        if obs.id.trim().is_empty() {
            return Err(SkyfixError::InvalidField {
                field: at("id"),
                message: "must not be empty".to_string(),
            });
        }
        if seen_ids.contains(&obs.id.as_str()) {
            return Err(SkyfixError::DuplicateId(obs.id.clone()));
        }
        seen_ids.push(obs.id.as_str());

        // Timestamps: RFC 3339 UTC with a trailing Z (section 6).
        crate::time::parse_utc(&obs.utc)?;

        finite(&at("altitude_deg"), obs.altitude_deg)?;
        let horizon = obs.horizon.unwrap_or(session.instrument.horizon);
        // A reflected artificial-horizon sextant reading is the DOUBLE angle
        // (section 5), so it may legitimately run to 180 deg before halving.
        let double_angle = horizon == HorizonMode::ArtificialReflected
            && obs.altitude_kind == AltitudeKind::SextantHs;
        let max_alt = if double_angle { 180.0 } else { 90.0 };
        range(&at("altitude_deg"), obs.altitude_deg, -90.0, max_alt)?;

        finite(&at("sigma_arcmin"), obs.sigma_arcmin)?;
        if obs.sigma_arcmin <= 0.0 {
            return Err(SkyfixError::InvalidField {
                field: at("sigma_arcmin"),
                message: format!(
                    "must be > 0 (got {}); a zero sigma would give the sight infinite weight",
                    obs.sigma_arcmin
                ),
            });
        }

        let body_is_sun = is_sun(&obs.body);
        if let Some(d) = obs.geocentric {
            finite(&at("geocentric.gha_deg"), d.gha_deg)?;
            finite(&at("geocentric.dec_deg"), d.dec_deg)?;
            finite(&at("geocentric.semidiameter_arcmin"), d.semidiameter_arcmin)?;
            finite(
                &at("geocentric.horizontal_parallax_arcmin"),
                d.horizontal_parallax_arcmin,
            )?;
            if !(0.0..360.0).contains(&d.gha_deg) {
                return Err(SkyfixError::AngleOutOfRange {
                    field: at("geocentric.gha_deg"),
                    value: d.gha_deg,
                    min: 0.0,
                    max: 360.0,
                    // GHA wraps: 360 is 0, not an out-of-scale angle.
                    max_exclusive: true,
                });
            }
            range(&at("geocentric.dec_deg"), d.dec_deg, -90.0, 90.0)?;
            if d.semidiameter_arcmin < 0.0 {
                return Err(SkyfixError::InvalidField {
                    field: at("geocentric.semidiameter_arcmin"),
                    message: format!("must be >= 0 (got {})", d.semidiameter_arcmin),
                });
            }
            if d.horizontal_parallax_arcmin < 0.0 {
                return Err(SkyfixError::InvalidField {
                    field: at("geocentric.horizontal_parallax_arcmin"),
                    message: format!("must be >= 0 (got {})", d.horizontal_parallax_arcmin),
                });
            }
        } else if let Some(list) = known_bodies
            && !body_is_known(&obs.body, list)
        {
            return Err(SkyfixError::UnknownBody(obs.body.clone()));
        }

        // Limb only means something for the Sun and the Moon: warn, never reject
        // (section 10). A planet is a point, like a star.
        let class = corrections::sight_body(&obs.body);
        if obs.limb != Limb::Center
            && !matches!(
                class,
                corrections::SightBody::Sun | corrections::SightBody::Moon
            )
        {
            warnings.push(Warning::LimbIgnoredForStar { id: obs.id.clone() });
        }

        // Correction parameters that the declared altitude_kind will have to ignore.
        let ignored = corrections::ignored_correction_kinds_for(
            obs.altitude_kind,
            &CorrectionInputs {
                id: &obs.id,
                is_sun: body_is_sun,
                limb: obs.limb,
                horizon,
                index_correction_arcmin: session.instrument.index_correction_arcmin,
                height_of_eye_m: o.height_of_eye_m,
                pressure_hpa: o.pressure_hpa,
                temperature_c: o.temperature_c,
                direction: obs.geocentric,
            },
            class,
        );
        if !ignored.is_empty() {
            warnings.push(Warning::AlreadyCorrected {
                id: obs.id.clone(),
                kind: obs.altitude_kind,
                ignored,
            });
        }

        let body_folded = obs.body.trim().to_lowercase();
        let altitude_bits = obs.altitude_deg.to_bits();
        match groups.iter_mut().find(|g| {
            g.body_folded == body_folded && g.utc == obs.utc && g.altitude_bits == altitude_bits
        }) {
            Some(g) => g.ids.push(obs.id.clone()),
            None => groups.push(SightGroup {
                body_folded,
                utc: &obs.utc,
                altitude_bits,
                ids: vec![obs.id.clone()],
            }),
        }
    }

    for group in groups {
        if group.ids.len() > 1 {
            warnings.push(Warning::DuplicateObservation { ids: group.ids });
        }
    }

    Ok(warnings)
}

/// Observations that agree in body, instant and altitude: the same sight written down
/// twice, which is a warning rather than an error (it is legal, just rarely intended).
struct SightGroup<'a> {
    body_folded: String,
    utc: &'a str,
    altitude_bits: u64,
    ids: Vec<String>,
}

/// A body is known when the provider lists it (case-insensitively) or when it is a
/// `HIP <number>` designation (CONVENTIONS section 10).
fn body_is_known(body: &str, known: &[&str]) -> bool {
    let b = body.trim();
    if b.is_empty() {
        return false;
    }
    if known.iter().any(|k| k.trim().eq_ignore_ascii_case(b)) {
        return true;
    }
    if let Some(rest) = b.get(..3)
        && rest.eq_ignore_ascii_case("hip")
    {
        let n = b[3..].trim();
        return !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// The largest `clock.dut1_s` accepted, seconds. The IERS keeps UT1 - UTC within
/// 0.9 s while leap seconds last (to 2035) and time signals broadcast it to 0.1 s
/// within that; a larger value is warned about. Beyond a minute it is refused: UT1 - UTC
/// has never come near it, and such a value is almost certainly not in seconds.
pub const DUT1_LIMIT_S: f64 = 60.0;

/// `clock.dut1_s` (expansion programme, moonshape): finite, at most [`DUT1_LIMIT_S`],
/// and warned about beyond 0.9 s.
fn check_dut1(dut1: f64, warnings: &mut Vec<Warning>) -> Result<(), SkyfixError> {
    finite("clock.dut1_s", dut1)?;
    if dut1.abs() > DUT1_LIMIT_S {
        return Err(SkyfixError::InvalidField {
            field: "clock.dut1_s".to_string(),
            message: format!(
                "UT1 - UTC of {dut1} s is not plausible (the IERS keeps it within 0.9 s, and \
                 it has never come near {DUT1_LIMIT_S} s); give it in seconds, or leave it \
                 out for the automatic value"
            ),
        });
    }
    if dut1.abs() > 0.9 {
        warnings.push(Warning::Other {
            message: format!(
                "clock.dut1_s = {dut1} s is outside the 0.9 s the IERS keeps UT1 - UTC \
                 within while leap seconds last: it moves every Greenwich hour angle by \
                 {:.2}' and is used as given; check it is in seconds",
                dut1 * 15.041_068_64 / 60.0
            ),
        });
    }
    Ok(())
}

fn finite(field: &str, value: f64) -> Result<(), SkyfixError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(SkyfixError::NonFinite {
            field: field.to_string(),
        })
    }
}

fn range(field: &str, value: f64, min: f64, max: f64) -> Result<(), SkyfixError> {
    if value < min || value > max {
        Err(SkyfixError::AngleOutOfRange {
            field: field.to_string(),
            value,
            min,
            max,
            max_exclusive: false,
        })
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/// CSV with a `#`-prefixed header block for session-level fields and one row per observation.
pub fn to_csv(session: &Session) -> String {
    let mut out = String::new();
    let mut head = |k: &str, v: String| {
        out.push_str("# ");
        out.push_str(k);
        out.push('=');
        out.push_str(&escape_header_value(&v));
        out.push('\n');
    };

    head("schema", session.schema.clone());
    head("meta.name", session.meta.name.clone());
    head("meta.notes", session.meta.notes.clone());
    head(
        "meta.kind",
        session_kind_name(session.meta.kind).to_string(),
    );
    head(
        "observer.height_of_eye_m",
        num(session.observer.height_of_eye_m),
    );
    head("observer.pressure_hpa", num(session.observer.pressure_hpa));
    head(
        "observer.temperature_c",
        num(session.observer.temperature_c),
    );
    if let Some(ap) = session.observer.assumed_position {
        head(
            "observer.assumed_position",
            format!("{},{}", num(ap.lat_deg), num(ap.lon_deg)),
        );
    }
    head(
        "observer.assumed_position_role",
        match session.observer.assumed_position_role {
            AssumedPositionRole::Initializer => "initializer".to_string(),
            AssumedPositionRole::Prior { sigma_nm } => format!("prior,{}", num(sigma_nm)),
            AssumedPositionRole::Disabled => "disabled".to_string(),
        },
    );
    head("instrument.name", session.instrument.name.clone());
    head(
        "instrument.index_correction_arcmin",
        num(session.instrument.index_correction_arcmin),
    );
    head(
        "instrument.horizon",
        corrections::horizon_name(session.instrument.horizon).to_string(),
    );
    head("clock.uncertainty_s", num(session.clock.uncertainty_s));
    head("clock.correction_s", num(session.clock.correction_s));
    // Written only when given, like the JSON field, so a session without it is
    // byte-for-byte what it was before the field existed.
    if let Some(dut1) = session.clock.dut1_s {
        head("clock.dut1_s", num(dut1));
    }

    out.push_str(&CSV_COLUMNS.join(","));
    out.push('\n');

    for obs in &session.observations {
        let (gha, dec, sd, hp) = match obs.geocentric {
            Some(d) => (
                num(d.gha_deg),
                num(d.dec_deg),
                num(d.semidiameter_arcmin),
                num(d.horizontal_parallax_arcmin),
            ),
            None => (String::new(), String::new(), String::new(), String::new()),
        };
        let cells = [
            obs.id.clone(),
            obs.body.clone(),
            obs.utc.clone(),
            num(obs.altitude_deg),
            corrections::kind_name(obs.altitude_kind).to_string(),
            num(obs.sigma_arcmin),
            corrections::limb_name(obs.limb).to_string(),
            obs.horizon
                .map(corrections::horizon_name)
                .unwrap_or("")
                .to_string(),
            gha,
            dec,
            sd,
            hp,
            obs.notes.clone(),
        ];
        let row: Vec<String> = cells.iter().map(|c| escape_cell(c)).collect();
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

pub fn from_csv(csv: &str) -> Result<Session, SkyfixError> {
    let mut session = Session {
        schema: String::new(),
        meta: SessionMeta::default(),
        observer: Observer::default(),
        instrument: Instrument::default(),
        clock: Clock::default(),
        observations: Vec::new(),
    };
    let mut saw_schema = false;

    // The `#` block always precedes the data, so it can be split off line by line;
    // only data rows may contain quoted newlines.
    let mut body_start = 0usize;
    for line in csv.split_inclusive('\n') {
        // Strip the line terminator only: a header VALUE may legitimately end in a
        // space, and trimming the whole line would silently eat it.
        let raw = line.trim_end_matches('\n').trim_end_matches('\r');
        if !(raw.trim().is_empty() || raw.trim_start().starts_with('#')) {
            break;
        }
        body_start += line.len();
        if let Some(entry) = raw.trim_start().strip_prefix('#') {
            // One optional space after the '#' is punctuation, not part of the key.
            let entry = entry.strip_prefix(' ').unwrap_or(entry);
            if entry.trim().is_empty() {
                continue;
            }
            let (key, value) = entry
                .split_once('=')
                .ok_or_else(|| SkyfixError::InvalidField {
                    field: format!("# {}", entry.trim()),
                    message: "session header lines must read '# key=value'".to_string(),
                })?;
            let key = key.trim();
            let value = unescape_header_value(value);
            apply_header(&mut session, key, &value)?;
            if key == "schema" {
                saw_schema = true;
            }
        }
    }
    if !saw_schema {
        return Err(SkyfixError::UnsupportedSchema(String::new()));
    }
    if session.schema != SESSION_SCHEMA {
        return Err(SkyfixError::UnsupportedSchema(session.schema.clone()));
    }

    let records = parse_records(&csv[body_start..])?;
    let Some((header, rows)) = records.split_first() else {
        return Err(SkyfixError::InvalidField {
            field: "csv".to_string(),
            message: format!(
                "no header row; expected the columns {}",
                CSV_COLUMNS.join(",")
            ),
        });
    };

    // Columns may appear in any order; unknown names are a typo, not a silent drop.
    let mut index_of: Vec<(String, usize)> = Vec::with_capacity(header.len());
    for (i, name) in header.iter().enumerate() {
        let name = name.trim().to_string();
        if !CSV_COLUMNS.contains(&name.as_str()) {
            return Err(SkyfixError::InvalidField {
                field: format!("csv column {:?}", name),
                message: format!("unknown column; expected one of {}", CSV_COLUMNS.join(",")),
            });
        }
        if index_of.iter().any(|(n, _)| *n == name) {
            return Err(SkyfixError::InvalidField {
                field: format!("csv column {:?}", name),
                message: "appears twice in the header row".to_string(),
            });
        }
        index_of.push((name, i));
    }
    for required in ["id", "body", "utc", "altitude_deg"] {
        if !index_of.iter().any(|(n, _)| n == required) {
            return Err(SkyfixError::InvalidField {
                field: format!("csv column {required:?}"),
                message: "required column is missing".to_string(),
            });
        }
    }

    for (r, row) in rows.iter().enumerate() {
        if row.len() == 1 && row[0].trim().is_empty() {
            continue; // blank line between rows
        }
        if row.len() > header.len() {
            return Err(SkyfixError::InvalidField {
                field: format!("csv row {}", r + 1),
                message: format!(
                    "{} cells for {} columns (quote any field that contains a comma)",
                    row.len(),
                    header.len()
                ),
            });
        }
        let cell = |name: &str| -> &str {
            index_of
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, i)| row.get(*i))
                .map(String::as_str)
                .unwrap_or("")
        };
        let where_ = |name: &str| format!("csv row {} column {name}", r + 1);

        let gha = cell("gha_deg").trim();
        let dec = cell("dec_deg").trim();
        let sd = cell("semidiameter_arcmin").trim();
        let hp = cell("horizontal_parallax_arcmin").trim();
        let geocentric = match (gha.is_empty(), dec.is_empty()) {
            (true, true) => {
                if !sd.is_empty() || !hp.is_empty() {
                    return Err(SkyfixError::InvalidField {
                        field: where_("semidiameter_arcmin/horizontal_parallax_arcmin"),
                        message: "given without gha_deg and dec_deg; a direction needs both"
                            .to_string(),
                    });
                }
                None
            }
            (false, false) => Some(GeocentricDirection {
                gha_deg: number(gha, &where_("gha_deg"))?,
                dec_deg: number(dec, &where_("dec_deg"))?,
                semidiameter_arcmin: number_or(sd, 0.0, &where_("semidiameter_arcmin"))?,
                horizontal_parallax_arcmin: number_or(
                    hp,
                    0.0,
                    &where_("horizontal_parallax_arcmin"),
                )?,
            }),
            _ => {
                return Err(SkyfixError::InvalidField {
                    field: where_("gha_deg/dec_deg"),
                    message: "supply both or neither".to_string(),
                });
            }
        };

        session.observations.push(Observation {
            id: cell("id").to_string(),
            body: cell("body").to_string(),
            utc: cell("utc").to_string(),
            altitude_deg: number(cell("altitude_deg").trim(), &where_("altitude_deg"))?,
            altitude_kind: parse_altitude_kind(
                cell("altitude_kind").trim(),
                &where_("altitude_kind"),
            )?,
            sigma_arcmin: number_or(cell("sigma_arcmin").trim(), 1.0, &where_("sigma_arcmin"))?,
            limb: parse_limb(cell("limb").trim(), &where_("limb"))?,
            horizon: parse_horizon_opt(cell("horizon").trim(), &where_("horizon"))?,
            geocentric,
            notes: cell("notes").to_string(),
        });
    }

    Ok(session)
}

// --- CSV helpers -----------------------------------------------------------

/// Shortest decimal that parses back to the same `f64`, so the CSV round-trips exactly.
fn num(x: f64) -> String {
    format!("{x}")
}

fn number(s: &str, field: &str) -> Result<f64, SkyfixError> {
    s.parse::<f64>().map_err(|_| SkyfixError::InvalidField {
        field: field.to_string(),
        message: format!("{s:?} is not a number"),
    })
}

fn number_or(s: &str, default: f64, field: &str) -> Result<f64, SkyfixError> {
    if s.is_empty() {
        Ok(default)
    } else {
        number(s, field)
    }
}

fn parse_altitude_kind(s: &str, field: &str) -> Result<AltitudeKind, SkyfixError> {
    match s {
        "" | "sextant_hs" => Ok(AltitudeKind::SextantHs),
        "apparent_ha" => Ok(AltitudeKind::ApparentHa),
        "observed_ho" => Ok(AltitudeKind::ObservedHo),
        other => Err(SkyfixError::InvalidField {
            field: field.to_string(),
            message: format!(
                "unknown altitude_kind {other:?}; expected sextant_hs, apparent_ha or observed_ho"
            ),
        }),
    }
}

fn parse_limb(s: &str, field: &str) -> Result<Limb, SkyfixError> {
    match s {
        "" | "center" => Ok(Limb::Center),
        "lower" => Ok(Limb::Lower),
        "upper" => Ok(Limb::Upper),
        other => Err(SkyfixError::InvalidField {
            field: field.to_string(),
            message: format!("unknown limb {other:?}; expected center, lower or upper"),
        }),
    }
}

fn parse_horizon(s: &str, field: &str) -> Result<HorizonMode, SkyfixError> {
    match s {
        "sea" => Ok(HorizonMode::Sea),
        "artificial_reflected" => Ok(HorizonMode::ArtificialReflected),
        "electronic_vertical" => Ok(HorizonMode::ElectronicVertical),
        other => Err(SkyfixError::InvalidField {
            field: field.to_string(),
            message: format!(
                "unknown horizon {other:?}; expected sea, artificial_reflected or \
                 electronic_vertical"
            ),
        }),
    }
}

fn parse_horizon_opt(s: &str, field: &str) -> Result<Option<HorizonMode>, SkyfixError> {
    if s.is_empty() {
        Ok(None)
    } else {
        parse_horizon(s, field).map(Some)
    }
}

fn session_kind_name(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Simulated => "simulated",
        SessionKind::Real => "real",
    }
}

fn apply_header(session: &mut Session, key: &str, value: &str) -> Result<(), SkyfixError> {
    let field = format!("# {key}");
    let number_here = |v: &str| number(v.trim(), &field);
    match key {
        // An identifier, not free text: stray whitespace around it is not meaningful.
        "schema" => session.schema = value.trim().to_string(),
        "meta.name" => session.meta.name = value.to_string(),
        "meta.notes" => session.meta.notes = value.to_string(),
        "meta.kind" => {
            session.meta.kind = match value.trim() {
                "simulated" => SessionKind::Simulated,
                "real" => SessionKind::Real,
                other => {
                    return Err(SkyfixError::InvalidField {
                        field,
                        message: format!("unknown meta.kind {other:?}; expected simulated or real"),
                    });
                }
            }
        }
        "observer.height_of_eye_m" => session.observer.height_of_eye_m = number_here(value)?,
        "observer.pressure_hpa" => session.observer.pressure_hpa = number_here(value)?,
        "observer.temperature_c" => session.observer.temperature_c = number_here(value)?,
        "observer.assumed_position" => {
            let (lat, lon) = value
                .split_once(',')
                .ok_or_else(|| SkyfixError::InvalidField {
                    field: field.clone(),
                    message: format!("expected 'lat,lon' in degrees (got {value:?})"),
                })?;
            session.observer.assumed_position = Some(LatLon {
                lat_deg: number(lat.trim(), &field)?,
                lon_deg: number(lon.trim(), &field)?,
            });
        }
        "observer.assumed_position_role" => {
            let v = value.trim();
            session.observer.assumed_position_role = if v == "initializer" {
                AssumedPositionRole::Initializer
            } else if v == "disabled" {
                AssumedPositionRole::Disabled
            } else if let Some(sigma) = v.strip_prefix("prior") {
                let sigma = sigma.trim_start().strip_prefix(',').ok_or_else(|| {
                    SkyfixError::InvalidField {
                        field: field.clone(),
                        message: "role 'prior' needs its 1-sigma radius: 'prior,<sigma_nm>'"
                            .to_string(),
                    }
                })?;
                AssumedPositionRole::Prior {
                    sigma_nm: number(sigma.trim(), &field)?,
                }
            } else {
                return Err(SkyfixError::InvalidField {
                    field,
                    message: format!(
                        "unknown role {v:?}; expected initializer, prior,<sigma_nm> or disabled"
                    ),
                });
            };
        }
        "instrument.name" => session.instrument.name = value.to_string(),
        "instrument.index_correction_arcmin" => {
            session.instrument.index_correction_arcmin = number_here(value)?;
        }
        "instrument.horizon" => {
            session.instrument.horizon = parse_horizon(value.trim(), &field)?;
        }
        "clock.uncertainty_s" => session.clock.uncertainty_s = number_here(value)?,
        "clock.correction_s" => session.clock.correction_s = number_here(value)?,
        // Empty means "automatic", as an absent JSON field does.
        "clock.dut1_s" => {
            session.clock.dut1_s = if value.trim().is_empty() {
                None
            } else {
                Some(number_here(value)?)
            };
        }
        other => {
            return Err(SkyfixError::InvalidField {
                field: format!("# {other}"),
                message: "unknown session header key".to_string(),
            });
        }
    }
    Ok(())
}

/// Header values are one per line, so a literal newline or backslash is escaped.
fn escape_header_value(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out
}

fn unescape_header_value(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn escape_cell(cell: &str) -> String {
    let needs_quotes = cell.contains([',', '"', '\n', '\r'])
        || cell.starts_with(' ')
        || cell.ends_with(' ')
        || cell.starts_with('#');
    if needs_quotes {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell.to_string()
    }
}

/// RFC 4180-style record splitter: commas separate fields, `"` quotes a field, `""` is a
/// literal quote inside one, and a newline inside quotes belongs to the field.
fn parse_records(text: &str) -> Result<Vec<Vec<String>>, SkyfixError> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut quoted_field = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() && !quoted_field => {
                in_quotes = true;
                quoted_field = true;
            }
            ',' => {
                record.push(std::mem::take(&mut field));
                quoted_field = false;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    continue; // CRLF: let the \n end the record
                }
                record.push(std::mem::take(&mut field));
                quoted_field = false;
                records.push(std::mem::take(&mut record));
            }
            '\n' => {
                record.push(std::mem::take(&mut field));
                quoted_field = false;
                records.push(std::mem::take(&mut record));
            }
            _ => field.push(c),
        }
    }
    if in_quotes {
        return Err(SkyfixError::InvalidField {
            field: "csv".to_string(),
            message: "unterminated quoted field".to_string(),
        });
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    // A `#` line after the data has started is still a comment, not a row.
    records.retain(|r| {
        !(r.len() == 1 && (r[0].trim().is_empty() || r[0].trim_start().starts_with('#')))
    });
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_names_are_matched_case_insensitively_and_hip_is_always_allowed() {
        let known = ["Vega", "Rigil Kentaurus", "Sun"];
        assert!(body_is_known("vega", &known));
        assert!(body_is_known(" Rigil Kentaurus ", &known));
        assert!(body_is_known("HIP 91262", &known));
        assert!(body_is_known("hip12345", &known));
        assert!(!body_is_known("Hipparchus", &known));
        assert!(!body_is_known("Betelgeuse", &known));
        assert!(!body_is_known("", &known));
    }

    #[test]
    fn records_split_on_quotes_commas_and_embedded_newlines() {
        let r = parse_records("a,b,c\n\"x,1\",\"he said \"\"hi\"\"\",\"two\nlines\"\n").unwrap();
        assert_eq!(r[0], vec!["a", "b", "c"]);
        assert_eq!(r[1], vec!["x,1", "he said \"hi\"", "two\nlines"]);
    }

    #[test]
    fn header_values_survive_newlines_and_backslashes() {
        let v = "line one\nline\\two\r";
        assert_eq!(unescape_header_value(&escape_header_value(v)), v);
    }

    #[test]
    fn floats_round_trip_through_the_cell_format() {
        for x in [0.1, 1.0 / 3.0, -75.1652, 1e-9, 6_366_707.02, 61.2345] {
            assert_eq!(num(x).parse::<f64>().unwrap(), x);
        }
    }
}
