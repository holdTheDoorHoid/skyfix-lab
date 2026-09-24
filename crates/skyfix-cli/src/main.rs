//! `skyfix` command-line interface. OWNER: cli agent.
//!
//! Results go to stdout, diagnostics to stderr, and the exit code says what happened:
//!
//! | code | meaning |
//! |---|---|
//! | 0 | everything asked for was done |
//! | 1 | usage, unreadable file, parse or validation error |
//! | 2 | one or more sights rejected; the rest were still printed |
//! | 3 | the solve failed, or `--require-unique` and the result was not unique |
//! | 4 | the subcommand is not wired up in this build |
//!
//! Clap's own usage errors exit 2 by default, which would collide with "some sights
//! were rejected", so the parse is done by hand here and mapped onto code 1.

mod cli;
mod commands;
mod exit;
mod input;
mod provider;
mod report;

use std::process::ExitCode;

use clap::Parser;
use clap::error::ErrorKind;

use cli::{Cli, Command};
use commands::reduce::Output;

fn main() -> ExitCode {
    let parsed = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            // `--help` and `--version` arrive here as "errors"; they are successes, and
            // clap prints them to stdout. Everything else is a usage error: code 1.
            let code = match e.kind() {
                ErrorKind::DisplayHelp
                | ErrorKind::DisplayVersion
                | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => exit::OK,
                _ => exit::USAGE,
            };
            let _ = e.print();
            return ExitCode::from(code);
        }
    };

    match dispatch(parsed) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(exit::USAGE)
        }
    }
}

fn dispatch(parsed: Cli) -> anyhow::Result<u8> {
    match parsed.command {
        Command::Validate { file, json } => commands::validate::run(&file, json),

        Command::Reduce {
            file,
            ephemeris,
            json,
            csv,
        } => {
            let output = if json {
                Output::Json
            } else if csv {
                Output::Csv
            } else {
                Output::Text
            };
            commands::reduce::run(&file, ephemeris, output)
        }

        Command::Solve {
            file,
            options,
            json,
            require_unique,
        } => commands::solve::run(&file, &options.to_flags(json, require_unique)),

        Command::Catalog { json } => commands::catalog::run_catalog(json),
        Command::Coverage { json } => commands::catalog::run_coverage(json),
        Command::Convert { input, output } => commands::convert::run(&input, &output),

        Command::Simulate {
            demo,
            scenario,
            out_session,
            out_truth,
            show_truth,
        } => commands::simulate::run(&commands::simulate::Args {
            demo,
            scenario,
            out_session,
            out_truth,
            show_truth,
        }),

        Command::Experiment {
            scenario,
            demo,
            repetitions,
            out,
            options,
        } => commands::experiment::run(&commands::experiment::Args {
            demo,
            scenario,
            repetitions,
            out,
            flags: options.to_flags(false, false),
        }),

        Command::Demos { json } => commands::simulate::run_demos(json),
        Command::Plan { .. } => {
            commands::stubs::not_wired("plan", "skyfix_core::planner is still a stub")
        }
    }
}
