//! Subcommands whose flags are settled but whose implementation is not wired up here.
//! OWNER: cli agent.
//!
//! These exist as real clap subcommands, with the flags they will take, so that
//! `skyfix --help` and `docs/CLI.md` describe the finished tool and scripts can be
//! written against the shape now. They exit [`exit::NOT_WIRED`] (4) and say why, rather
//! than printing something that looks like a result.

use anyhow::Result;

use crate::exit;

/// Report that `name` is not wired up, and why, on stderr.
pub fn not_wired(name: &str, waiting_on: &str) -> Result<u8> {
    eprintln!("skyfix {name}: not yet wired in this build ({waiting_on}).");
    eprintln!("Its flags are final; only the implementation is missing. Exit code 4.");
    Ok(exit::NOT_WIRED)
}
