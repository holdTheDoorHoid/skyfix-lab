//! Index-error and watch logs (CONVENTIONS section 10; sailings agent, expansion
//! programme).
//!
//! A navigator measures the sextant's index error and compares the watch with a time
//! signal every so often and writes both down. A session may carry those logs:
//! `instrument.index_error_log: [{utc, ic_arcmin, note}]` and
//! `clock.watch_log: [{utc, correction_s, note}]`. When a log has entries, the value at
//! a sight's time is taken from it instead of the session's single
//! `index_correction_arcmin` or `correction_s`:
//!
//! - between two entries: **linear interpolation** (a watch's rate is steady between
//!   comparisons; an index error moves slowly with temperature and handling);
//! - at an entry's instant: that entry;
//! - a log of one entry: that entry, at any time;
//! - before the first or after the last entry: the nearest entry's value **held**, not
//!   extrapolated, and the sight carries [`Warning::ErrorLogOutsideSpan`] saying how far
//!   outside it is (a watch that gained two seconds a day and was last compared five days
//!   ago is ten seconds out, which the navigator should see rather than have guessed).
//!
//! The watch log is read at the sight's *recorded* time (the watch's reading), the index
//! log at the corrected time; the difference is the correction times the log's rate,
//! microseconds. [`crate::reduce::reduce_observation`] records which value it used in
//! the reduced sight (`index_correction_from_log`, `clock_correction_from_log`) and in the
//! index-correction step's note.

use crate::SkyfixError;
use crate::time::parse_utc;
use crate::types::{Clock, Instrument, LogMethod, LogPoint, LoggedValue, Session, Warning};

/// Which log, for field names and warnings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    IndexError,
    Watch,
}

impl LogKind {
    pub fn name(self) -> &'static str {
        match self {
            LogKind::IndexError => "index_error_log",
            LogKind::Watch => "watch_log",
        }
    }

    fn field(self) -> &'static str {
        match self {
            LogKind::IndexError => "instrument.index_error_log",
            LogKind::Watch => "clock.watch_log",
        }
    }

    fn unit(self) -> &'static str {
        match self {
            LogKind::IndexError => "′",
            LogKind::Watch => " s",
        }
    }

    fn what(self) -> &'static str {
        match self {
            LogKind::IndexError => "index-error log",
            LogKind::Watch => "watch log",
        }
    }
}

/// A parsed, time-ordered log: `(jd, value, utc as written)`.
type Parsed = Vec<(f64, f64, String)>;

fn parse(
    kind: LogKind,
    entries: impl Iterator<Item = (String, f64)>,
) -> Result<Parsed, SkyfixError> {
    let mut out: Parsed = Vec::new();
    for (i, (utc, value)) in entries.enumerate() {
        let jd = parse_utc(&utc).map_err(|_| SkyfixError::InvalidField {
            field: format!("{}[{i}].utc", kind.field()),
            message: format!("{utc:?} is not an RFC 3339 UTC time ending in Z"),
        })?;
        if !value.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: format!(
                    "{}[{i}].{}",
                    kind.field(),
                    match kind {
                        LogKind::IndexError => "ic_arcmin",
                        LogKind::Watch => "correction_s",
                    }
                ),
            });
        }
        out.push((jd, value, utc));
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    if let Some(w) = out.windows(2).find(|w| w[0].0 == w[1].0) {
        return Err(SkyfixError::InvalidField {
            field: kind.field().to_string(),
            message: format!("two entries at the same instant, {}", w[0].2),
        });
    }
    Ok(out)
}

fn index_log(instrument: &Instrument) -> Result<Parsed, SkyfixError> {
    parse(
        LogKind::IndexError,
        instrument
            .index_error_log
            .iter()
            .map(|e| (e.utc.clone(), e.ic_arcmin)),
    )
}

fn watch_log(clock: &Clock) -> Result<Parsed, SkyfixError> {
    parse(
        LogKind::Watch,
        clock
            .watch_log
            .iter()
            .map(|e| (e.utc.clone(), e.correction_s)),
    )
}

fn point(e: &(f64, f64, String)) -> LogPoint {
    LogPoint {
        utc: e.2.clone(),
        value: e.1,
    }
}

/// The value of a (non-empty, sorted) log at `jd`.
fn read(kind: LogKind, log: &Parsed, jd: f64) -> LoggedValue {
    let u = kind.unit();
    let first = &log[0];
    let last = &log[log.len() - 1];
    if log.len() == 1 {
        return LoggedValue {
            value: first.1,
            method: LogMethod::OnlyEntry,
            from: Some(point(first)),
            to: None,
            hours_outside: 0.0,
            note: format!(
                "from the {} ({:+.3}{u}, its only entry, {})",
                kind.what(),
                first.1,
                first.2
            ),
        };
    }
    if jd < first.0 {
        let hours = (first.0 - jd) * 24.0;
        return LoggedValue {
            value: first.1,
            method: LogMethod::HeldBeforeFirst,
            from: Some(point(first)),
            to: None,
            hours_outside: hours,
            note: format!(
                "from the {}: its first entry ({:+.3}{u}, {}) held, {hours:.1} h before it",
                kind.what(),
                first.1,
                first.2
            ),
        };
    }
    if jd > last.0 {
        let hours = (jd - last.0) * 24.0;
        return LoggedValue {
            value: last.1,
            method: LogMethod::HeldAfterLast,
            from: Some(point(last)),
            to: None,
            hours_outside: hours,
            note: format!(
                "from the {}: its last entry ({:+.3}{u}, {}) held, {hours:.1} h after it",
                kind.what(),
                last.1,
                last.2
            ),
        };
    }
    let k = log
        .iter()
        .rposition(|e| e.0 <= jd)
        .expect("jd is inside the log");
    let a = &log[k];
    if a.0 == jd || k + 1 == log.len() {
        return LoggedValue {
            value: a.1,
            method: LogMethod::AtEntry,
            from: Some(point(a)),
            to: None,
            hours_outside: 0.0,
            note: format!(
                "from the {}: its entry of {} ({:+.3}{u})",
                kind.what(),
                a.2,
                a.1
            ),
        };
    }
    let b = &log[k + 1];
    let f = (jd - a.0) / (b.0 - a.0);
    let value = a.1 + f * (b.1 - a.1);
    LoggedValue {
        value,
        method: LogMethod::Interpolated,
        from: Some(point(a)),
        to: Some(point(b)),
        hours_outside: 0.0,
        note: format!(
            "interpolated from the {} between {} ({:+.3}{u}) and {} ({:+.3}{u})",
            kind.what(),
            a.2,
            a.1,
            b.2,
            b.1
        ),
    }
}

/// The index correction (arcminutes) for a sight at `jd_utc`, and, when it came from
/// `instrument.index_error_log`, how.
pub fn effective_index_correction(
    instrument: &Instrument,
    jd_utc: f64,
) -> Result<(f64, Option<LoggedValue>), SkyfixError> {
    if instrument.index_error_log.is_empty() {
        return Ok((instrument.index_correction_arcmin, None));
    }
    let log = index_log(instrument)?;
    let v = read(LogKind::IndexError, &log, jd_utc);
    Ok((v.value, Some(v)))
}

/// The chronometer correction (seconds, added) for a sight recorded at `jd_recorded`,
/// and, when it came from `clock.watch_log`, how.
pub fn effective_clock_correction(
    clock: &Clock,
    jd_recorded: f64,
) -> Result<(f64, Option<LoggedValue>), SkyfixError> {
    if clock.watch_log.is_empty() {
        return Ok((clock.correction_s, None));
    }
    let log = watch_log(clock)?;
    let v = read(LogKind::Watch, &log, jd_recorded);
    Ok((v.value, Some(v)))
}

/// The chronometer correction `c` (seconds) whose recorded time `r` satisfies
/// `r + c(r) = jd_corrected`: what to subtract from a corrected instant to write it on the
/// session's watch, so that the reducer brings it back exactly (the averaged sight of
/// `crate::methods::averaging`). The single `correction_s` when there is no log; with a
/// log, two fixed-point steps (the log's slope is seconds per day, so the second step
/// changes nothing measurable). A log that cannot be read falls back to `correction_s`:
/// the session's validation reports it.
pub fn clock_correction_for_corrected(clock: &Clock, jd_corrected: f64) -> f64 {
    if clock.watch_log.is_empty() {
        return clock.correction_s;
    }
    let Ok(log) = watch_log(clock) else {
        return clock.correction_s;
    };
    let mut c = read(LogKind::Watch, &log, jd_corrected).value;
    for _ in 0..3 {
        c = read(LogKind::Watch, &log, jd_corrected - c / 86_400.0).value;
    }
    c
}

/// The warning for a value held outside its log.
pub fn outside_warning(id: &str, kind: LogKind, v: &LoggedValue) -> Option<Warning> {
    matches!(
        v.method,
        LogMethod::HeldBeforeFirst | LogMethod::HeldAfterLast
    )
    .then(|| Warning::ErrorLogOutsideSpan {
        id: id.to_string(),
        log: kind.name().to_string(),
        held_value: v.value,
        hours_outside: v.hours_outside,
    })
}

/// Validation of both logs (called from [`crate::session::validate`]): times in RFC 3339
/// `Z` form, finite values, no two entries at one instant; a note when a single value is
/// set beside a log that replaces it.
pub fn validate_logs(session: &Session) -> Result<Vec<Warning>, SkyfixError> {
    let mut warnings = Vec::new();
    if !session.instrument.index_error_log.is_empty() {
        index_log(&session.instrument)?;
        if session.instrument.index_correction_arcmin != 0.0 {
            warnings.push(Warning::Other {
                message: format!(
                    "instrument.index_correction_arcmin ({:+.3}') is not used: the \
                     index_error_log is, interpolated at each sight's time",
                    session.instrument.index_correction_arcmin
                ),
            });
        }
    }
    if !session.clock.watch_log.is_empty() {
        watch_log(&session.clock)?;
        if session.clock.correction_s != 0.0 {
            warnings.push(Warning::Other {
                message: format!(
                    "clock.correction_s ({:+.3} s) is not used: the watch_log is, interpolated \
                     at each sight's recorded time",
                    session.clock.correction_s
                ),
            });
        }
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{IndexErrorLogEntry, WatchLogEntry};

    fn jd(s: &str) -> f64 {
        parse_utc(s).unwrap()
    }

    fn instrument(entries: &[(&str, f64)]) -> Instrument {
        Instrument {
            index_correction_arcmin: -9.0,
            index_error_log: entries
                .iter()
                .map(|(u, v)| IndexErrorLogEntry {
                    utc: u.to_string(),
                    ic_arcmin: *v,
                    note: String::new(),
                })
                .collect(),
            ..Instrument::default()
        }
    }

    #[test]
    fn interpolates_between_entries_and_holds_outside() {
        // Written out of order on purpose: the log is sorted by time.
        let i = instrument(&[
            ("2026-09-10T00:00:00Z", -1.5),
            ("2026-09-01T00:00:00Z", -1.2),
        ]);
        let (v, l) = effective_index_correction(&i, jd("2026-09-04T00:00:00Z")).unwrap();
        assert!((v + 1.3).abs() < 1e-12, "{v}");
        let l = l.unwrap();
        assert_eq!(l.method, LogMethod::Interpolated);
        assert_eq!(l.from.unwrap().value, -1.2);
        assert!(l.note.contains("between"), "{}", l.note);
        let (v, l) = effective_index_correction(&i, jd("2026-09-12T12:00:00Z")).unwrap();
        assert_eq!(v, -1.5);
        let l = l.unwrap();
        assert_eq!(l.method, LogMethod::HeldAfterLast);
        assert!((l.hours_outside - 60.0).abs() < 1e-6);
        assert!(outside_warning("s1", LogKind::IndexError, &l).is_some());
        let (_, l) = effective_index_correction(&i, jd("2026-09-01T00:00:00Z")).unwrap();
        assert_eq!(l.unwrap().method, LogMethod::AtEntry);
        // No log: the single value, and nothing to report.
        let (v, l) =
            effective_index_correction(&instrument(&[]), jd("2026-09-04T00:00:00Z")).unwrap();
        assert_eq!((v, l), (-9.0, None));
        // One entry: constant, no warning.
        let (v, l) =
            effective_index_correction(&instrument(&[("2026-09-01T00:00:00Z", 0.4)]), 0.0).unwrap();
        assert_eq!(v, 0.4);
        assert!(outside_warning("s", LogKind::IndexError, &l.unwrap()).is_none());
    }

    #[test]
    fn a_bad_log_is_refused_with_the_entry_named() {
        let e = effective_index_correction(&instrument(&[("yesterday", 0.1)]), 0.0).unwrap_err();
        assert!(e.to_string().contains("index_error_log[0].utc"), "{e}");
        let e = effective_index_correction(
            &instrument(&[("2026-09-01T00:00:00Z", 0.1), ("2026-09-01T00:00:00Z", 0.2)]),
            0.0,
        )
        .unwrap_err();
        assert!(e.to_string().contains("same instant"), "{e}");
        let e = effective_index_correction(&instrument(&[("2026-09-01T00:00:00Z", f64::NAN)]), 0.0)
            .unwrap_err();
        assert!(e.to_string().contains("ic_arcmin"), "{e}");
    }

    #[test]
    fn the_corrected_instant_inverts_the_watch_log() {
        let clock = Clock {
            correction_s: 0.0,
            uncertainty_s: 0.0,
            watch_log: vec![
                WatchLogEntry {
                    utc: "2026-09-01T00:00:00Z".to_string(),
                    correction_s: 10.0,
                    note: String::new(),
                },
                WatchLogEntry {
                    utc: "2026-09-11T00:00:00Z".to_string(),
                    correction_s: -10.0,
                    note: String::new(),
                },
            ],
        };
        let t = jd("2026-09-06T00:00:00Z");
        let c = clock_correction_for_corrected(&clock, t);
        let recorded = t - c / 86_400.0;
        let (c2, _) = effective_clock_correction(&clock, recorded).unwrap();
        assert!(((recorded + c2 / 86_400.0) - t).abs() * 86_400.0 < 1e-6);
    }
}
