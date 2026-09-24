//! `skyfix` command-line interface. OWNER: cli agent.
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "skyfix",
    version,
    about = "Offline celestial-navigation workbench"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Reduce a session: corrections, Hc, Zn and intercepts at the assumed position.
    Reduce,
    /// Solve a position fix from a session.
    Solve,
    /// Generate a simulated session (truth written separately).
    Simulate,
    /// Validate a session or fixture file.
    Validate,
    /// Rank bodies for an upcoming observation.
    Plan,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        _ => anyhow::bail!("not implemented yet (skyfix-core {})", skyfix_core::VERSION),
    }
}
