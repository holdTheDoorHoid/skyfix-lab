//! `skyfix reduce`. OWNER: cli agent.
//!
//! One observation at a time: where the body direction came from, every correction step
//! with its before/after altitude, the resulting `Ho` and its sigma, and — only when the
//! session carries an assumed position — `Hc`, `Zn` and the intercept (CONVENTIONS
//! sections 3-5).
//!
//! A rejected sight never discards the others: the rest are still reduced and printed,
//! the rejections go to stderr, and the exit code says some were lost.

use std::path::Path;

use anyhow::Result;
use serde_json::json;
use skyfix_core::reduce;
use skyfix_core::types::{
    AssumedPositionRole, CorrectionStep, ReducedSight, Session, SessionKind, Warning,
};

use crate::exit;
use crate::input;
use crate::provider::{self, EphemerisChoice};
use crate::report::{self, warning_sentence};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    Text,
    Json,
    Csv,
}

pub fn run(path: &Path, ephemeris: EphemerisChoice, output: Output) -> Result<u8> {
    let bodies = provider::known_bodies();
    let loaded = input::load(path, &bodies)?;
    for w in &loaded.warnings {
        eprintln!("warning: {}", warning_sentence(w));
    }

    let source = provider::direction_source(ephemeris);
    let results = reduce::reduce_session(&loaded.session, source.as_ref());

    let mut failures = 0usize;
    let mut used_provider: Option<String> = None;
    for r in results.iter().flatten() {
        if r.direction_source != reduce::SUPPLIED_DIRECTION_SOURCE && used_provider.is_none() {
            used_provider = Some(r.direction_source.clone());
        }
    }

    let mut out = String::new();
    match output {
        Output::Text => {
            out.push_str(&session_header(&loaded.session, ephemeris, &used_provider));
            for (obs, r) in loaded.session.observations.iter().zip(results.iter()) {
                match r {
                    Ok(s) => out.push_str(&sight_block(s, &loaded.session)),
                    Err(e) => {
                        failures += 1;
                        out.push_str(&format!("\n{}  {}  REJECTED\n  {e}\n", obs.id, obs.body));
                    }
                }
            }
        }
        Output::Json => {
            let mut items = Vec::with_capacity(results.len());
            for (obs, r) in loaded.session.observations.iter().zip(results.iter()) {
                match r {
                    Ok(s) => items.push(serde_json::to_value(s)?),
                    Err(e) => {
                        failures += 1;
                        items.push(json!({"id": obs.id, "error": e.to_string()}));
                    }
                }
            }
            out.push_str(&serde_json::to_string_pretty(&items)?);
            out.push('\n');
        }
        Output::Csv => {
            out.push_str(
                "id,body,utc,direction_source,gha_deg,dec_deg,ho_deg,sigma_arcmin,hc_deg,\
                 zn_deg,intercept_nm\n",
            );
            for (obs, r) in loaded.session.observations.iter().zip(results.iter()) {
                match r {
                    Ok(s) => {
                        out.push_str(&csv_row(s));
                        out.push('\n');
                    }
                    Err(e) => {
                        failures += 1;
                        eprintln!("rejected {}: {e}", obs.id);
                    }
                }
            }
        }
    }
    report::emit(&out)?;

    if let Some(name) = &used_provider
        && let Some(coverage) = provider::coverage_summary(name)
    {
        eprintln!(
            "note: {}",
            warning_sentence(&Warning::EphemerisCoverageLimited {
                provider: name.clone(),
                coverage,
            })
        );
    }

    if failures > 0 {
        eprintln!(
            "{failures} of {} sight(s) were rejected; the rest were reduced.",
            results.len()
        );
        Ok(exit::SIGHTS_REJECTED)
    } else {
        Ok(exit::OK)
    }
}

/// The three lines of context every reduction needs: which session, which ephemeris,
/// and which assumed position the intercepts are measured from.
pub fn session_header(
    session: &Session,
    ephemeris: EphemerisChoice,
    used_provider: &Option<String>,
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
    out.push_str(&format!(
        "Ephemeris  {}{}\n",
        ephemeris.name(),
        match used_provider {
            Some(p) => format!(" -> {p}"),
            None => " -> supplied directions only".to_string(),
        }
    ));
    match session.observer.assumed_position {
        Some(ap) => {
            let role = match session.observer.assumed_position_role {
                AssumedPositionRole::Initializer => "initializer (starting point only)".to_string(),
                AssumedPositionRole::Prior { sigma_nm } => {
                    format!("prior, 1-sigma {sigma_nm} NM")
                }
                AssumedPositionRole::Disabled => "disabled".to_string(),
            };
            out.push_str(&format!(
                "Assumed    {} ({}), role {role}\n",
                report::format_position(ap),
                report::format_position_decimal(ap)
            ));
        }
        None => {
            out.push_str("Assumed    none: Hc, Zn and the intercept need an assumed position\n")
        }
    }
    out
}

fn sight_block(s: &ReducedSight, session: &Session) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "\n{}  {}  {}  direction: {}\n",
        s.id, s.body, s.utc, s.direction_source
    ));
    out.push_str(&format!(
        "  GHA {:.4} deg   Dec {:+.4} deg\n",
        s.gha_deg, s.dec_deg
    ));
    out.push_str(&format!(
        "  {}{}{:>11}{:>12}{:>9}  note\n",
        report::pad("step", 28),
        report::pad("applied", 9),
        "before deg",
        "after deg",
        "delta '"
    ));
    for step in &s.corrections.steps {
        out.push_str(&step_row(step));
    }
    out.push_str(&format!(
        "  Ho {:.6} deg   sigma {:.2}'\n",
        s.ho_deg, s.sigma_arcmin
    ));
    match (s.hc_deg, s.zn_deg, s.intercept_nm) {
        (Some(hc), Some(zn), Some(a)) => out.push_str(&format!(
            "  Hc {hc:.6} deg   Zn {zn:.1} deg   intercept {}\n",
            report::intercept(a)
        )),
        _ => {
            if session.observer.assumed_position.is_none() {
                out.push_str("  Hc, Zn and intercept: no assumed position in this session\n");
            }
        }
    }
    for w in &s.warnings {
        for (i, line) in report::wrap(&warning_sentence(w), 84, "      ")
            .into_iter()
            .enumerate()
        {
            if i == 0 {
                out.push_str(&format!("    - {}\n", line.trim_start()));
            } else {
                out.push_str(&format!("{line}\n"));
            }
        }
    }
    out
}

fn step_row(step: &CorrectionStep) -> String {
    format!(
        "  {}{}{:>11.6}{:>12.6}{:>9.2}  {}\n",
        report::pad(report::correction_kind_name(step.kind), 28),
        report::pad(if step.applied { "yes" } else { "no" }, 9),
        step.before_deg,
        step.after_deg,
        step.delta_arcmin,
        // A note is free text from the core. Flattening it keeps one step on one row,
        // so the columns stay readable even if a future note gains a line break.
        report::flatten(&step.note)
    )
}

fn csv_row(s: &ReducedSight) -> String {
    let cells = [
        report::csv_field(&s.id),
        report::csv_field(&s.body),
        report::csv_field(&s.utc),
        report::csv_field(&s.direction_source),
        format!("{:.6}", s.gha_deg),
        format!("{:.6}", s.dec_deg),
        format!("{:.6}", s.ho_deg),
        format!("{:.4}", s.sigma_arcmin),
        report::opt_num(s.hc_deg, 6),
        report::opt_num(s.zn_deg, 4),
        report::opt_num(s.intercept_nm, 4),
    ];
    cells.join(",")
}
