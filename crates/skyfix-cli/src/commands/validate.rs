//! `skyfix validate`. OWNER: cli agent.
//!
//! Parses a session in whichever format it is, checks it against
//! `skyfix_core::session::validate` with the CLI's body list, and reports what it found
//! in sentences. Errors stop the session from being usable at all (exit 1); warnings do
//! not (exit 0), because every one of them describes something legal but worth knowing.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::exit;
use crate::input;
use crate::provider;
use crate::report::{self, warning_sentence};

#[derive(Serialize)]
struct ValidateJson {
    ok: bool,
    errors: Vec<String>,
    warnings: Vec<String>,
}

pub fn run(path: &Path, json: bool) -> Result<u8> {
    let bodies = provider::known_bodies();
    let (code, text) = match input::load(path, &bodies) {
        Ok(loaded) => {
            let warnings: Vec<String> = loaded.warnings.iter().map(warning_sentence).collect();
            let text = if json {
                serde_json::to_string_pretty(&ValidateJson {
                    ok: true,
                    errors: Vec::new(),
                    warnings,
                })?
            } else {
                let mut out = format!(
                    "{} is a valid {} session: {} observation(s), read as {}.\n",
                    path.display(),
                    skyfix_core::types::SESSION_SCHEMA,
                    loaded.session.observations.len(),
                    loaded.format.name()
                );
                if warnings.is_empty() {
                    out.push_str("No warnings.\n");
                } else {
                    out.push_str("\nWarnings\n");
                    for w in &warnings {
                        out.push_str(&bullet(w));
                    }
                }
                out.pop();
                out
            };
            (exit::OK, text)
        }
        Err(e) => {
            // `{:#}` walks the anyhow context chain, so the hint added in `input` and
            // the core's own message both survive into the report.
            let message = format!("{e:#}");
            let text = if json {
                serde_json::to_string_pretty(&ValidateJson {
                    ok: false,
                    errors: vec![message],
                    warnings: Vec::new(),
                })?
            } else {
                let mut out = format!("{} is not a valid session.\n\nErrors\n", path.display());
                out.push_str(&bullet(&message));
                out.pop();
                out
            };
            (exit::USAGE, text)
        }
    };
    report::emit_line(&text)?;
    Ok(code)
}

fn bullet(sentence: &str) -> String {
    let mut out = String::new();
    for (i, line) in report::wrap(sentence, 86, "    ").into_iter().enumerate() {
        if i == 0 {
            out.push_str(&format!("  - {}\n", line.trim_start()));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }
    out
}
