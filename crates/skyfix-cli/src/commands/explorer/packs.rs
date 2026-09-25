//! Optional data packs from the command line: the global `--pack FILE` and `packs`.
//! OWNER: cli3 agent.
//!
//! The site keeps a pack it has fetched and loads it into the engine at start-up
//! (EXPLORER_API.md "Packs", CONVENTIONS 15.5); `--pack` does the same for one run, with
//! a file committed under `web/public/data/packs/` (or any copy of one). The loading is
//! the site's own: `skyfix_wasm::packs::load` checks the common header and the CRC-32 and
//! hands the payload to the pack's producer (`tides-us` to the tide engine, `lunar-limb`
//! to the eclipse engine), so a file the site would refuse is refused here with the same
//! sentence. `packs` prints `packs()`: every pack this build can install, and which are
//! loaded.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use skyfix_wasm::packs::{self as wasm_packs, PackInfo, PackStatus};

use super::args::FormatArgs;
use super::wire::{Align, Table, emit_json, push_note};
use crate::exit;
use crate::report;

/// The pack file `path` names: the file itself, or, when `DIR/NAME` does not exist, the
/// one `NAME-<rev>.bin` in `DIR` (`web/public/data/packs/tides-us`), so a script does not
/// break when a pack is rebuilt and its revision changes.
pub fn resolve(path: &Path) -> Result<PathBuf> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        bail!("--pack {}: no such file", path.display());
    };
    let dir = if dir.as_os_str().is_empty() {
        Path::new(".")
    } else {
        dir
    };
    let prefix = format!("{}-", name.to_string_lossy());
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    let f = p.file_name().map(|f| f.to_string_lossy().into_owned());
                    f.is_some_and(|f| f.starts_with(&prefix) && f.ends_with(".bin"))
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => bail!(
            "--pack {}: no such file, and no {prefix}<rev>.bin in {}",
            path.display(),
            dir.display()
        ),
        _ => bail!(
            "--pack {}: {} files match {prefix}<rev>.bin in {}; name one",
            path.display(),
            found.len(),
            dir.display()
        ),
    }
}

/// Read, verify and install one pack file, as the site does with a saved pack.
pub fn load(path: &Path) -> Result<PackInfo> {
    let file = resolve(path)?;
    let bytes = std::fs::read(&file).with_context(|| format!("--pack {}", file.display()))?;
    let name = wasm_packs::parse(&bytes)
        .map_err(|e| anyhow!("--pack {}: {e}", file.display()))?
        .name
        .to_string();
    wasm_packs::load(&name, &bytes).map_err(|e| anyhow!("--pack {}: {e}", file.display()))
}

/// Load every `--pack` of the run, in order, before the command runs.
pub fn load_all(paths: &[PathBuf]) -> Result<()> {
    for p in paths {
        load(p)?;
    }
    Ok(())
}

#[derive(clap::Args, Debug)]
pub struct PacksArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run(a: &PacksArgs) -> Result<u8> {
    let status = wasm_packs::status();
    if a.format.is_json() {
        emit_json(&status)?;
    } else {
        report::emit(&render(&status))?;
    }
    Ok(exit::OK)
}

fn render(status: &[PackStatus]) -> String {
    let mut out = String::from("DATA PACKS\n\n");
    let mut t = Table::new(&[
        ("pack", Align::Left),
        ("loaded", Align::Left),
        ("version", Align::Left),
        ("bytes", Align::Right),
        ("provides", Align::Left),
        ("", Align::Left),
    ]);
    for p in status {
        t.row(vec![
            p.name.clone(),
            if p.loaded { "yes" } else { "no" }.to_string(),
            if p.version.is_empty() {
                "-".to_string()
            } else {
                p.version.clone()
            },
            if p.loaded {
                p.bytes.to_string()
            } else {
                "-".to_string()
            },
            p.provides.join(", "),
            format!("{}: {}", p.label, p.description),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "A pack is loaded for one run with --pack FILE, a file from web/public/data/packs/ \
         (the site's copies), or --pack DIR/NAME for the one NAME-<rev>.bin in DIR. It \
         changes what the engine can answer, never how (CONVENTIONS 15.5).",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packs_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs")
    }

    #[test]
    fn a_name_in_the_packs_folder_finds_its_one_file() {
        let f = resolve(&packs_dir().join("tides-us")).unwrap();
        let n = f.file_name().unwrap().to_string_lossy().into_owned();
        assert!(n.starts_with("tides-us-") && n.ends_with(".bin"), "{n}");
        assert_eq!(resolve(&f).unwrap(), f);
        let e = resolve(&packs_dir().join("deep-space"))
            .unwrap_err()
            .to_string();
        assert!(e.contains("no such file"), "{e}");
    }
}
