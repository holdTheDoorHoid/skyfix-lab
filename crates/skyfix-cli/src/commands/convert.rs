//! `skyfix convert`. OWNER: cli agent.
//!
//! JSON to CSV and back, through `skyfix_core::session` and nothing else. The core's
//! CSV dialect is defined to round-trip without loss, so this command is deliberately
//! thin: the only judgement it makes is which format the output is meant to be in.
//!
//! The input is validated on the way through. Converting a file that would be rejected
//! by `skyfix validate` is refused rather than quietly writing a broken file in the
//! other format.

use std::path::Path;

use anyhow::{Result, bail};
use skyfix_core::session;

use crate::exit;
use crate::input::{self, Format};
use crate::provider;
use crate::report::warning_sentence;

pub fn run(input_path: &Path, output_path: &Path) -> Result<u8> {
    let bodies = provider::known_bodies();
    let loaded = input::load(input_path, &bodies)?;
    for w in &loaded.warnings {
        eprintln!("warning: {}", warning_sentence(w));
    }

    let out_format = output_format(output_path, loaded.format)?;
    let text = match out_format {
        Format::Json => {
            let mut s = serde_json::to_string_pretty(&loaded.session)?;
            s.push('\n');
            s
        }
        Format::Csv => session::to_csv(&loaded.session),
    };
    input::write_out(output_path, &text)?;

    eprintln!(
        "converted {} ({}) to {} ({}): {} observation(s).",
        input_path.display(),
        loaded.format.name(),
        output_path.display(),
        out_format.name(),
        loaded.session.observations.len()
    );
    Ok(exit::OK)
}

/// The output format, from the output path's extension.
///
/// `-` means stdout, where there is no extension to read, so it converts to the other
/// format — which is what `convert` is for.
fn output_format(path: &Path, input_format: Format) -> Result<Format> {
    if path.as_os_str() == "-" {
        return Ok(match input_format {
            Format::Json => Format::Csv,
            Format::Csv => Format::Json,
        });
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("json") => Ok(Format::Json),
        Some("csv") => Ok(Format::Csv),
        _ => bail!(
            "cannot tell what format {} should be: name it .json or .csv, or use - for stdout",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_extension_names_the_output_format() {
        assert_eq!(
            output_format(&PathBuf::from("a.csv"), Format::Json).unwrap(),
            Format::Csv
        );
        assert_eq!(
            output_format(&PathBuf::from("a.JSON"), Format::Csv).unwrap(),
            Format::Json
        );
    }

    #[test]
    fn stdout_flips_the_format() {
        assert_eq!(
            output_format(&PathBuf::from("-"), Format::Json).unwrap(),
            Format::Csv
        );
        assert_eq!(
            output_format(&PathBuf::from("-"), Format::Csv).unwrap(),
            Format::Json
        );
    }

    #[test]
    fn an_unknown_extension_is_refused_rather_than_guessed() {
        let e = output_format(&PathBuf::from("a.txt"), Format::Json).unwrap_err();
        assert!(e.to_string().contains(".json or .csv"), "{e}");
    }
}
