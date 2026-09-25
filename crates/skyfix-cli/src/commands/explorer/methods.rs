//! What `noon`, `polaris`, `average` and `running-fix` share. OWNER: cli agent.
//!
//! Each reads a session exactly as `skyfix reduce` and `skyfix solve` do (JSON or CSV,
//! validated against the body list), uses the same `--ephemeris` direction source, and
//! hands the session to the engine, which reduces every sight once (CONVENTIONS 14). A
//! sight the reducer rejects comes back as a warning on the result and earns exit code 2,
//! as a rejected sight does for `reduce` and `solve`.

use std::path::Path;

use anyhow::Result;
use skyfix_core::reduce::{DirectionSource, SUPPLIED_DIRECTION_SOURCE};
use skyfix_core::types::{
    DrPosition, ReducedSight, RunResidual, Session, SessionKind, VesselMotion,
};

use super::text;
use crate::exit;
use crate::input;
use crate::provider::{self, EphemerisChoice};
use crate::report::{self, warning_sentence};

/// Read and validate a session, printing its validation warnings to stderr.
pub fn load(path: &Path) -> Result<Session> {
    let bodies = provider::known_bodies();
    let loaded = input::load(path, &bodies)?;
    for w in &loaded.warnings {
        eprintln!("warning: {}", warning_sentence(w));
    }
    Ok(loaded.session)
}

/// The direction source for `--ephemeris`, as `reduce` and `solve` use it, with the
/// session's DUT1 (apply `--dut1` to the session first; expansion programme).
pub fn source(choice: EphemerisChoice, session: &Session) -> Box<dyn DirectionSource> {
    provider::session_source(choice, session)
}

/// `Session`, `Ephemeris` and `DR` lines. `dr` is the DR the method used: the flag's,
/// else the session's assumed position (`skyfix_core::methods::resolve_dr`).
pub fn header(
    session: &Session,
    ephemeris: EphemerisChoice,
    sights: &[ReducedSight],
    dr_flag: Option<DrPosition>,
    vessel: Option<VesselMotion>,
) -> String {
    let mut out = String::new();
    let kind = match session.meta.kind {
        SessionKind::Simulated => "simulated",
        SessionKind::Real => "real",
    };
    let name = if session.meta.name.is_empty() {
        "(unnamed)"
    } else {
        &session.meta.name
    };
    out.push_str(&format!("Session    {name} ({kind})\n"));
    let used = sights
        .iter()
        .find(|s| s.direction_source != SUPPLIED_DIRECTION_SOURCE)
        .map(|s| s.direction_source.as_str());
    out.push_str(&format!(
        "Ephemeris  {} -> {}\n",
        ephemeris.name(),
        used.unwrap_or("supplied directions only")
    ));
    match skyfix_core::methods::resolve_dr(dr_flag, session) {
        Some(dr) => labelled("DR", &dr_words(&dr, dr_flag.is_some()), &mut out),
        None => out.push_str("DR         none\n"),
    }
    if let Some(v) = vessel {
        out.push_str(&format!(
            "Vessel     course {} at {} kn over the ground\n",
            text::course(v.course_deg),
            v.speed_kn
        ));
    }
    out
}

fn dr_words(dr: &DrPosition, from_flag: bool) -> String {
    let p = skyfix_core::types::LatLon {
        lat_deg: dr.lat_deg,
        lon_deg: dr.lon_deg,
    };
    format!(
        "{} ({}), {}, from {}",
        report::format_position(p),
        report::format_position_decimal(p),
        match dr.sigma_nm {
            Some(s) => format!("sigma {s} NM"),
            None => "sigma not stated".to_string(),
        },
        if from_flag {
            "--dr"
        } else {
            "the session's assumed position"
        }
    )
}

/// A latitude as `39 57.16' N (39.952583)  sigma 0.11'`.
pub fn latitude_line(lat_deg: f64, sigma_arcmin: f64) -> String {
    format!(
        "{} ({lat_deg:.6})  sigma {sigma_arcmin:.2}'",
        report::format_lat(lat_deg)
    )
}

/// Label then wrapped text, the label in a 11-column gutter.
pub fn labelled(label: &str, body: &str, out: &mut String) {
    for (i, line) in report::wrap(body, 78, "           ")
        .into_iter()
        .enumerate()
    {
        if i == 0 {
            out.push_str(&format!(
                "{}{}\n",
                report::pad(label, 11),
                line.trim_start()
            ));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }
}

/// A run's residuals against the method's model (docs/NAVIGATION_METHODS.md 2, 4).
pub fn residual_table(residuals: &[RunResidual], out: &mut String) {
    let loo = residuals.iter().any(|r| r.normalized_loo.is_some());
    out.push_str(&format!(
        "  {}{}{:>8}{:>12}{:>12}{:>9}{:>8}{}  used\n",
        report::pad("id", 10),
        report::pad("UTC", 22),
        "min",
        "Ho deg",
        "model deg",
        "resid '",
        "norm",
        if loo {
            format!("{:>8}", "loo")
        } else {
            String::new()
        }
    ));
    for r in residuals {
        out.push_str(&format!(
            "  {}{}{:>8}{:>12.6}{:>12.6}{:>9}{:>8}{}  {}{}\n",
            report::pad(&r.id, 10),
            report::pad(&text::utc(r.jd_utc), 22),
            text::fixed(r.minutes, 2),
            r.ho_deg,
            r.model_deg,
            text::fixed(r.residual_arcmin, 2),
            text::fixed(r.normalized, 2),
            if loo {
                text::opt(r.normalized_loo, 8, 2)
            } else {
                String::new()
            },
            if r.used { "yes" } else { "no" },
            if r.outlier { "  OUTLIER" } else { "" }
        ));
    }
}

/// The warnings a method returned, as sentences.
pub fn warnings(ws: &[skyfix_core::types::Warning], out: &mut String) {
    report::warning_block(ws, out);
}

/// Exit code 2 when `rejected` sights were left out, with the sentence to stderr.
pub fn exit_for(rejected: usize, considered: usize) -> u8 {
    if rejected == 0 {
        return exit::OK;
    }
    eprintln!(
        "{rejected} of {considered} sight(s) were rejected; the result uses the rest (the \
         warnings name them)."
    );
    exit::SIGHTS_REJECTED
}

/// The note every method's text ends with.
pub fn workings_note(out: &mut String) {
    out.push('\n');
    for line in report::wrap(
        "Every sight's correction chain is in --format json (sights), and skyfix reduce \
         prints it step by step. This is a simulation and analysis workbench, not a \
         navigation instrument.",
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
}
