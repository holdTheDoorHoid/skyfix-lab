//! The commands that give the command line the explorer's engine. OWNER: cli agent.
//!
//! The explorer redesign added sky state, almanac events, the navigation methods and
//! Moon and planet sights to the engine, and the browser reaches them through WASM
//! (docs/EXPLORER_API.md). These commands make every one of them scriptable offline:
//!
//! | command | engine |
//! |---|---|
//! | `sky` | `skyfix_almanac::sky::sky_state`, constellations from `skyfix_starfield` |
//! | `events` | `skyfix_almanac::events::day_events` |
//! | `phases`, `seasons` | `skyfix_almanac::events::{moon_phases, seasons}` |
//! | `eclipses`, `eclipse` | `skyfix_almanac::eclipses::Eclipses::{find, by_id, local, path}` |
//! | `planet-events` | `skyfix_almanac::planet_events::planet_events` |
//! | `noon`, `polaris`, `average` | `skyfix_core::methods::{noon, polaris, averaging}` |
//! | `running-fix` | `skyfix_motion::request::running_fix_session` |
//! | `predict` | `skyfix_core::sights::predict::predict_sextant` |
//! | `lunar` | `skyfix_core::sights::lunar::lunar_distance` |
//! | `plan-sights` | `skyfix_ephemeris::visibility::plan_sights` |
//!
//! Nothing here computes astronomy or navigation: each command parses flags, calls the
//! engine function the WASM export calls, and prints its result — `--format json` as
//! serde emits it (the wire shape), `--format text` in navigator style (degrees and
//! decimal arcminutes, UTC with `Z`). Exit codes are `crate::exit`'s.
//!
//! These subcommands are one [`ExplorerCommand`] enum, flattened into the top-level
//! command list by a single variant in `cli.rs`, so they arrive as one self-contained
//! module.

pub mod args;
pub mod average;
pub mod eclipse;
pub mod eclipses;
pub mod events;
pub mod lunar;
pub mod methods;
pub mod noon;
pub mod phases;
pub mod plan_sights;
pub mod planet_events;
pub mod polaris;
pub mod predict;
pub mod running_fix;
pub mod sky;
pub mod text;
pub mod zone;

use anyhow::Result;
use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub enum ExplorerCommand {
    /// The whole sky from a place at an instant: altitude, azimuth, GHA, Dec, magnitude,
    /// phase and constellation of every body.
    Sky(sky::Args),

    /// One day's rise, set, transit and twilights, and the sky phases, in a chosen zone.
    Events(events::Args),

    /// New moon, first quarter, full moon and last quarter between two dates.
    Phases(phases::PhasesArgs),

    /// The equinoxes and solstices of a year.
    Seasons(phases::SeasonsArgs),

    /// Every solar and lunar eclipse in a window, and with --lat --lon whether each is
    /// seen from there.
    Eclipses(eclipses::Args),

    /// One eclipse: its contacts, what a place sees (--lat --lon), or its path (--path).
    Eclipse(eclipse::Args),

    /// Oppositions, conjunctions (and transits), greatest elongations and closest
    /// approaches of the planets in a window.
    PlanetEvents(planet_events::Args),

    /// Latitude, meridian passage and a (weak) longitude from a run of sights of one body
    /// around its meridian passage.
    Noon(noon::Args),

    /// Latitude from sights of Polaris, with the Nautical Almanac's a0, a1, a2 terms.
    Polaris(polaris::Args),

    /// Average a run of sights of one body into one sight, ready for a fix.
    Average(average::Args),

    /// A fix from sights taken under way, advanced along the dead-reckoning track to one
    /// instant.
    RunningFix(running_fix::Args),

    /// The predicted sextant reading and bearing of a body from a place at an instant.
    Predict(predict::Args),

    /// Clear a lunar distance and find the UTC it was taken at.
    Lunar(lunar::Args),

    /// Tonight's sights: the next evening and morning nautical twilight and the bodies
    /// to shoot in each, with their predicted readings.
    PlanSights(plan_sights::Args),
}

/// Run one explorer command, returning the exit code it earned.
pub fn run(command: ExplorerCommand) -> Result<u8> {
    match command {
        ExplorerCommand::Sky(a) => sky::run(&a),
        ExplorerCommand::Events(a) => events::run(&a),
        ExplorerCommand::Phases(a) => phases::run_phases(&a),
        ExplorerCommand::Seasons(a) => phases::run_seasons(&a),
        ExplorerCommand::Eclipses(a) => eclipses::run(&a),
        ExplorerCommand::Eclipse(a) => eclipse::run(&a),
        ExplorerCommand::PlanetEvents(a) => planet_events::run(&a),
        ExplorerCommand::Noon(a) => noon::run(&a),
        ExplorerCommand::Polaris(a) => polaris::run(&a),
        ExplorerCommand::Average(a) => average::run(&a),
        ExplorerCommand::RunningFix(a) => running_fix::run(&a),
        ExplorerCommand::Predict(a) => predict::run(&a),
        ExplorerCommand::Lunar(a) => lunar::run(&a),
        ExplorerCommand::PlanSights(a) => plan_sights::run(&a),
    }
}
