//! Reading session files. OWNER: cli agent.
//!
//! The numerical core does no file I/O (CONVENTIONS, `skyfix-core::session`): it takes
//! and returns strings. This module is the whole of the CLI's filesystem contact for
//! input — it reads the bytes, decides whether they are JSON or CSV, hands the text to
//! the core codec, and then always runs [`skyfix_core::session::validate`] against the
//! body list so a CSV file gets exactly the same checks a JSON file does (`from_csv`
//! deliberately parses without validating).

use std::path::Path;

use anyhow::{Context, Result};
use skyfix_core::SkyfixError;
use skyfix_core::session;
use skyfix_core::types::{Session, Warning};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Csv,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Json => "json",
            Format::Csv => "csv",
        }
    }
}

/// Decide the format from the extension, falling back to the content.
///
/// The content sniff exists because sessions arrive as `session.txt` and as pipes from
/// other tools often enough to be worth handling: a `{` starts JSON, and our CSV
/// dialect always begins with the `# schema=` header block or the column row.
pub fn detect_format(path: &Path, text: &str) -> Format {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("json") => return Format::Json,
        Some("csv") => return Format::Csv,
        _ => {}
    }
    if text.trim_start().starts_with('{') {
        Format::Json
    } else {
        Format::Csv
    }
}

/// A session as read from disk, with everything the caller needs to report on it.
pub struct Loaded {
    pub session: Session,
    pub warnings: Vec<Warning>,
    pub format: Format,
}

/// Read the file, parse it in whichever format it is, and validate it.
///
/// `known_bodies` is the union of every body the CLI can name (see
/// [`crate::provider::known_bodies`]); an observation that supplies its own
/// `geocentric` block is exempt from that check by the core's own rule.
pub fn load(path: &Path, known_bodies: &[&str]) -> Result<Loaded> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let format = detect_format(path, &text);
    let session = parse(&text, format, path)?;
    let warnings = session::validate(&session, known_bodies)
        .map_err(|e| describe(e, path))
        .with_context(|| format!("{} is not a valid session", path.display()))?;
    Ok(Loaded {
        session,
        warnings,
        format,
    })
}

/// Parse without validating — used by `load`, and on its own where the caller wants to
/// separate a parse failure from a validation failure.
pub fn parse(text: &str, format: Format, path: &Path) -> Result<Session> {
    let parsed = match format {
        // `parse_session` checks the schema first, then deserialises strictly, then
        // validates without a body catalogue; `load` adds the body check afterwards.
        Format::Json => session::parse_session(text).map(|(s, _)| s),
        Format::Csv => session::from_csv(text),
    };
    parsed
        .map_err(|e| describe(e, path))
        .with_context(|| format!("cannot parse {} as {}", path.display(), format.name()))
}

/// Turn a [`SkyfixError`] into an `anyhow` error, adding the hint that most often
/// unsticks the user for the two failures that are usually a wrong file, not a wrong
/// value.
fn describe(e: SkyfixError, path: &Path) -> anyhow::Error {
    let hint = match &e {
        SkyfixError::UnsupportedSchema(found) if found.is_empty() => Some(format!(
            "{} has no \"schema\" field; a session file must start with \
             \"schema\": \"{}\"",
            path.display(),
            skyfix_core::types::SESSION_SCHEMA
        )),
        SkyfixError::UnknownBody(body) => Some(format!(
            "body {body:?} is not in the catalogue; run `skyfix catalog` for the list, or give \
             the observation its own \"geocentric\" block"
        )),
        _ => None,
    };
    match hint {
        Some(h) => anyhow::Error::new(e).context(h),
        None => anyhow::Error::new(e),
    }
}

/// Write `text` to `path`, or to stdout when `path` is `-`.
pub fn write_out(path: &Path, text: &str) -> Result<()> {
    if path.as_os_str() == "-" {
        crate::report::emit(text)?;
        return Ok(());
    }
    std::fs::write(path, text).with_context(|| format!("cannot write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn extension_decides_first() {
        assert_eq!(
            detect_format(&PathBuf::from("a.json"), "# schema=x"),
            Format::Json
        );
        assert_eq!(detect_format(&PathBuf::from("a.CSV"), "{}"), Format::Csv);
    }

    #[test]
    fn content_decides_when_the_extension_does_not() {
        assert_eq!(
            detect_format(&PathBuf::from("session"), "  {\"schema\": \"x\"}"),
            Format::Json
        );
        assert_eq!(
            detect_format(&PathBuf::from("session.txt"), "# schema=skyfix.session/1\n"),
            Format::Csv
        );
    }
}
