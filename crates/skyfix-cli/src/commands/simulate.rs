//! `skyfix simulate` and `skyfix demos`. OWNER: cli agent.
//!
//! The simulator hands back two documents and they stay apart (docs/SIMULATOR.md
//! section 1). This command writes them to two files and **never prints the truth to
//! stdout** unless `--show-truth` is given, so a demo that ends up in a terminal
//! recording, a screenshot or a pipe cannot leak the answer into the estimator's view.
//! The one thing the session legitimately discloses is its assumed position, and the
//! summary says so in words rather than leaving the reader to notice.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use skyfix_core::session;
use skyfix_core::types::{AssumedPositionRole, Session, Truth};
use skyfix_sim::experiment::truth_to_json;
use skyfix_sim::generate;

use crate::commands::scenarios;
use crate::exit;
use crate::input::{self, Format};
use crate::provider;
use crate::report;

pub struct Args {
    pub demo: Option<String>,
    pub scenario: Option<PathBuf>,
    pub out_session: Option<PathBuf>,
    pub out_truth: Option<PathBuf>,
    pub show_truth: bool,
}

pub fn run(args: &Args) -> Result<u8> {
    let scenario = scenarios::resolve(args.demo.as_deref(), args.scenario.as_deref())?;
    let astro = provider::auto_provider();
    let (session, truth) = generate::simulate(&scenario, Some(&astro))
        .map_err(|e| anyhow::anyhow!("scenario {:?}: {e}", scenario.name))?;

    let mut out = String::new();
    out.push_str(&format!("Scenario   {}\n", scenario.name));
    for (i, line) in report::wrap(&scenario.description, 76, "           ")
        .into_iter()
        .enumerate()
    {
        if i == 0 {
            out.push_str(&format!("About      {}\n", line.trim_start()));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }
    out.push_str(&format!(
        "Session    {} observation(s), first at {}\n",
        session.observations.len(),
        session
            .observations
            .first()
            .map(|o| o.utc.as_str())
            .unwrap_or("(none)")
    ));
    out.push_str(&format!("Disclosure {}\n", disclosure(&session)));

    match &args.out_session {
        Some(path) => {
            let text = serialise_session(&session, path)?;
            input::write_out(path, &text)?;
            out.push_str(&format!("Session written to {}\n", path.display()));
        }
        None => {
            out.push('\n');
            out.push_str(&serde_json::to_string_pretty(&session)?);
            out.push('\n');
        }
    }

    match &args.out_truth {
        Some(path) => {
            let text = truth_to_json(&truth).map_err(|e| anyhow::anyhow!("truth: {e}"))?;
            std::fs::write(path, format!("{text}\n"))
                .with_context(|| format!("cannot write {}", path.display()))?;
            out.push_str(&format!("Truth written to   {}\n", path.display()));
        }
        None => {
            eprintln!(
                "note: no --out-truth was given, so the truth for this run was discarded. \
                 Nothing else can score the fix without it."
            );
        }
    }

    if args.show_truth {
        out.push_str("\nTRUTH (evaluation only; never an input to a solve)\n");
        out.push_str(&truth_block(&truth));
    }

    report::emit(&out)?;
    Ok(exit::OK)
}

/// What the session tells the estimator about where the answer is.
fn disclosure(session: &Session) -> String {
    match (
        session.observer.assumed_position,
        session.observer.assumed_position_role,
    ) {
        (Some(ap), AssumedPositionRole::Initializer) => format!(
            "the session carries an assumed position of {} as an INITIALIZER, which starts \
             the iteration and never weights the answer",
            report::format_position(ap)
        ),
        (Some(ap), AssumedPositionRole::Prior { sigma_nm }) => format!(
            "the session carries an assumed position of {} as a PRIOR with a {sigma_nm} NM \
             1-sigma radius, so it is part of the answer and the fix report says so",
            report::format_position(ap)
        ),
        (Some(ap), AssumedPositionRole::Disabled) => format!(
            "the session carries an assumed position of {} but its role is disabled, so \
             nothing uses it",
            report::format_position(ap)
        ),
        (None, _) => "the session carries no assumed position at all".to_string(),
    }
}

fn truth_block(truth: &Truth) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "  position  {} ({})\n",
        report::format_position(truth.position),
        report::format_position_decimal(truth.position)
    ));
    out.push_str(&format!("  seed      {}\n", truth.seed));
    if truth.clock_offset_s != 0.0 {
        out.push_str(&format!(
            "  clock     recorded times are {:+} s from the true instants\n",
            truth.clock_offset_s
        ));
    }
    if truth.shared_altitude_bias_arcmin != 0.0 {
        out.push_str(&format!(
            "  bias      every altitude reads {:+}' \n",
            truth.shared_altitude_bias_arcmin
        ));
    }
    if !truth.wrong_sight_ids.is_empty() {
        out.push_str(&format!(
            "  blunders  {}\n",
            truth.wrong_sight_ids.join(", ")
        ));
    }
    for line in report::wrap(&truth.notes, 76, "            ") {
        out.push_str(&format!("{line}\n"));
    }
    out
}

/// JSON, or CSV when the output is named `.csv`.
fn serialise_session(session: &Session, path: &Path) -> Result<String> {
    let format = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("csv") => Format::Csv,
        Some("json") | None => Format::Json,
        Some(other) => bail!("cannot write a session as .{other}: name it .json or .csv"),
    };
    Ok(match format {
        Format::Json => {
            let mut s = serde_json::to_string_pretty(session)?;
            s.push('\n');
            s
        }
        Format::Csv => session::to_csv(session),
    })
}

// ---------------------------------------------------------------------------
// `skyfix demos`
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct DemoRow {
    name: String,
    description: String,
    sights: usize,
    needs_provider: bool,
}

pub fn run_demos(json: bool) -> Result<u8> {
    let rows: Vec<DemoRow> = scenarios::all()
        .into_iter()
        .map(|s| DemoRow {
            sights: s.schedule.count,
            // Only the named-star scenario asks an almanac for a body; every other demo
            // supplies its directions (docs/SIMULATOR.md section 8).
            needs_provider: s.sources.iter().any(|b| {
                matches!(b, skyfix_sim::scenario::BodySource::Named { .. })
            }),
            name: s.name,
            description: s.description,
        })
        .collect();

    if json {
        report::emit_line(&serde_json::to_string_pretty(&rows)?)?;
        return Ok(exit::OK);
    }

    let mut out = String::new();
    for (i, r) in rows.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "{}  ({} sight(s){})\n",
            r.name,
            r.sights,
            if r.needs_provider {
                ", needs an astronomy provider"
            } else {
                ""
            }
        ));
        for line in report::wrap(&r.description, 84, "  ") {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out.push_str(&format!(
        "\n{} packaged scenarios. Run one with:\n  skyfix simulate --demo <name> \
         --out-session s.json --out-truth s.truth.json\n  skyfix experiment --demo <name> \
         --repetitions 100\n",
        rows.len()
    ));
    report::emit(&out)?;
    Ok(exit::OK)
}
