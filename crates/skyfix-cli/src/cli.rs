//! The command line itself. OWNER: cli agent.
//!
//! Every subcommand that exists in the finished tool is declared here, including the
//! ones whose implementation has not been merged yet, so `--help` describes the real
//! surface and a script written today keeps working when they are wired up.
//!
//! Angle arguments are degrees, east-positive longitude, exactly like the session files
//! (CONVENTIONS sections 1-2). Nothing on the command line is in radians.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use skyfix_core::types::{LatLon, PositionPrior};

use crate::commands::almanac::AlmanacFormat;
use crate::commands::plan::ObjectiveArg;
use crate::commands::solve;
use crate::provider::EphemerisChoice;

#[derive(Parser, Debug)]
#[command(
    name = "skyfix",
    version,
    about = "Offline celestial-navigation workbench",
    long_about = "Reduce celestial observations, solve a position fix, and say how much \
                  the answer is worth. Results go to stdout, diagnostics to stderr. Exit \
                  codes: 0 ok, 1 usage or validation error, 2 one or more sights \
                  rejected, 3 solve failed or, under --require-unique, no single fix with \
                  a 95 % ellipse, 4 the subcommand is not wired up in this build."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Check a session file and report its errors and warnings.
    Validate {
        /// Session file, .json or .csv (the format is detected from the content too).
        file: PathBuf,
        /// Print {"ok":bool,"errors":[..],"warnings":[..]} instead of sentences.
        #[arg(long)]
        json: bool,
    },

    /// Reduce every observation: corrections, Ho, and Hc/Zn/intercept at the assumed
    /// position.
    Reduce {
        file: PathBuf,
        /// Where body directions come from when an observation has no geocentric block.
        #[arg(long, value_enum, default_value_t = EphemerisChoice::Auto, value_name = "MODE")]
        ephemeris: EphemerisChoice,
        /// Print the reduced sights as JSON.
        #[arg(long, conflicts_with = "csv")]
        json: bool,
        /// Print one CSV row per sight with the numeric columns.
        #[arg(long)]
        csv: bool,
    },

    /// Solve a position fix from a session.
    Solve {
        file: PathBuf,
        #[command(flatten)]
        options: SolveFlags,
        /// Print the FixResult as JSON.
        #[arg(long)]
        json: bool,
        /// Exit 3 unless the result is a single unique fix.
        #[arg(long = "require-unique")]
        require_unique: bool,
    },

    /// List the bodies a session may name and which provider answers for each.
    Catalog {
        #[arg(long)]
        json: bool,
    },

    /// Print each ephemeris provider's coverage, accuracy and provenance.
    Coverage {
        #[arg(long)]
        json: bool,
    },

    /// Convert a session between JSON and CSV.
    Convert {
        /// Input session, .json or .csv.
        input: PathBuf,
        /// Output path; `-` writes the other format to stdout.
        output: PathBuf,
    },

    /// Generate a simulated session, with the truth written to its own file.
    Simulate {
        /// A packaged demo by name (see `skyfix demos`).
        #[arg(long, value_name = "NAME", conflicts_with = "scenario")]
        demo: Option<String>,
        /// A scenario JSON file.
        #[arg(long, value_name = "FILE")]
        scenario: Option<PathBuf>,
        /// Where to write the session the estimator will see.
        #[arg(long = "out-session", value_name = "FILE")]
        out_session: Option<PathBuf>,
        /// Where to write the truth. Never merged into the session.
        #[arg(long = "out-truth", value_name = "FILE")]
        out_truth: Option<PathBuf>,
        /// Also print the truth to stdout. Off by default so a demo cannot leak it.
        #[arg(long = "show-truth")]
        show_truth: bool,
    },

    /// Repeat a scenario many times and summarise how the errors compare with the
    /// predicted uncertainty.
    Experiment {
        /// A scenario JSON file.
        #[arg(long, value_name = "FILE")]
        scenario: Option<PathBuf>,
        /// A packaged demo by name (see `skyfix demos`).
        #[arg(long, value_name = "NAME", conflicts_with = "scenario")]
        demo: Option<String>,
        /// How many seeded repetitions to run.
        #[arg(long, default_value_t = 100, value_name = "N")]
        repetitions: u32,
        /// Where to write the per-repetition table, .json or .csv.
        #[arg(long, value_name = "FILE")]
        out: Option<PathBuf>,
        #[command(flatten)]
        options: SolveFlags,
    },

    /// List the packaged demo scenarios.
    Demos {
        #[arg(long)]
        json: bool,
    },

    /// Rank bodies worth observing from a position at a time.
    Plan {
        /// Approximate position, degrees, east-positive longitude. Disclosed in the
        /// output: a planner is allowed an approximate position, a solver is not.
        // `allow_hyphen_values`: a southern latitude starts with '-', which clap would
        // otherwise read as the start of another flag ("unexpected argument '-3' found").
        // `parse_latlon` rejects anything that is not a pair of numbers, so a mistyped
        // flag still fails, with a message about the value rather than about the flag.
        #[arg(long, value_name = "LAT,LON", value_parser = parse_latlon, allow_hyphen_values = true)]
        position: LatLon,
        /// Instant, RFC 3339 UTC with a trailing Z.
        #[arg(long, value_name = "RFC3339")]
        utc: String,
        /// Ignore bodies below this altitude, degrees.
        #[arg(long = "min-alt", default_value_t = skyfix_core::planner::DEFAULT_MIN_ALTITUDE_DEG, value_name = "DEG")]
        min_alt: f64,
        /// Ignore bodies above this altitude, degrees.
        #[arg(long = "max-alt", default_value_t = skyfix_core::planner::DEFAULT_MAX_ALTITUDE_DEG, value_name = "DEG")]
        max_alt: f64,
        /// How many bodies to recommend.
        #[arg(long, default_value_t = skyfix_core::planner::DEFAULT_SELECT, value_name = "N")]
        select: usize,
        /// What the greedy selection minimises.
        #[arg(long, value_enum, default_value_t = ObjectiveArg::MinTrace, value_name = "WHAT")]
        objective: ObjectiveArg,
        /// A session of sights already taken. They fix the starting geometry, so the
        /// recommendation is what to shoot next.
        #[arg(long, value_name = "SESSION")]
        taken: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },

    /// Print the daily pages of a nautical almanac for one UT date: GHA and Dec every hour,
    /// the stars, twilight, sunrise, sunset, moonrise and moonset.
    Almanac {
        /// The UT date, YYYY-MM-DD, from 1990-01-01 to 2060-12-31.
        #[arg(long, value_name = "YYYY-MM-DD")]
        date: String,
        /// `text`: the two pages laid out in columns; `json`: the AlmanacDay document with
        /// raw and printed values.
        #[arg(long, value_enum, default_value_t = AlmanacFormat::Text, value_name = "FORMAT")]
        format: AlmanacFormat,
    },
}

/// Solver options shared by `solve` and `experiment`. Every one of these overrides
/// whatever the session file says.
#[derive(Args, Debug, Clone)]
pub struct SolveFlags {
    /// Where body directions come from when an observation has no geocentric block.
    #[arg(long, value_enum, default_value_t = EphemerisChoice::Auto, value_name = "MODE")]
    pub ephemeris: EphemerisChoice,
    /// Start the iteration here instead of at the session's assumed position. A
    /// starting point only; it never biases a converged fix.
    // `allow_hyphen_values`: see `Command::Plan::position`. Without it `--init -30,20`
    // is rejected as an unknown flag, so half the planet needs `--init=-30,20`.
    #[arg(long, value_name = "LAT,LON", value_parser = parse_latlon, conflicts_with = "no_init", allow_hyphen_values = true)]
    pub init: Option<LatLon>,
    /// Ignore the session's assumed position and rely on multistart.
    #[arg(long = "no-init")]
    pub no_init: bool,
    /// Add a genuine Gaussian position prior. Its effect on the answer is reported.
    // `allow_hyphen_values`: see `Command::Plan::position`.
    #[arg(long, value_name = "LAT,LON,SIGMA_NM", value_parser = parse_prior, allow_hyphen_values = true)]
    pub prior: Option<PositionPrior>,
    /// Estimate a shared altitude bias as a third unknown.
    #[arg(long)]
    pub bias: bool,
    /// Huber robust weighting, with an optional threshold k (default 1.5).
    #[arg(long, value_name = "K", num_args = 0..=1, default_missing_value = "1.5")]
    pub robust: Option<f64>,
    /// 1-sigma clock uncertainty in seconds, propagated east-west, never estimated.
    #[arg(long = "clock-sigma", value_name = "SECONDS")]
    pub clock_sigma: Option<f64>,
    /// Also report the chi2/dof-scaled covariance, when there are 3 or more dof.
    #[arg(long = "posterior-scaling")]
    pub posterior_scaling: bool,
    /// Only refine from the initializer; do not search the globe.
    #[arg(long = "no-multistart")]
    pub no_multistart: bool,
    /// Coarse multistart grid spacing, degrees.
    #[arg(long = "grid-step", value_name = "DEGREES")]
    pub grid_step: Option<f64>,
}

impl SolveFlags {
    pub fn to_flags(&self, json: bool, require_unique: bool) -> solve::Flags {
        solve::Flags {
            ephemeris: self.ephemeris,
            json,
            init: self.init,
            no_init: self.no_init,
            prior: self.prior,
            bias: self.bias,
            robust: self.robust,
            clock_sigma: self.clock_sigma,
            posterior_scaling: self.posterior_scaling,
            no_multistart: self.no_multistart,
            grid_step: self.grid_step,
            require_unique,
        }
    }
}

/// `lat,lon` in degrees, longitude east-positive.
pub fn parse_latlon(s: &str) -> Result<LatLon, String> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    if parts.len() != 2 {
        return Err(format!(
            "expected lat,lon in degrees (east-positive longitude), got {s:?}"
        ));
    }
    let lat_deg = number(parts[0], "latitude")?;
    let lon_deg = number(parts[1], "longitude")?;
    check_range("latitude", lat_deg, -90.0, 90.0)?;
    check_range("longitude", lon_deg, -180.0, 180.0)?;
    Ok(LatLon {
        lat_deg,
        // CONVENTIONS section 1 normalises longitude to (-180, 180]. That range differs
        // from the one checked above at exactly one value, so -180 is rewritten as +180 --
        // the same meridian, one spelling -- and every other value is passed through
        // untouched. `norm_180` would do it by way of `rem_euclid`, which perturbs an
        // ordinary longitude in its last bits; here the output is exact. Normalising at
        // the input rather than at each print site keeps the text report and `--json`
        // saying the same thing.
        lon_deg: if lon_deg == -180.0 { 180.0 } else { lon_deg },
    })
}

/// `lat,lon,sigma_nm`: a prior's centre and its 1-sigma radius in nautical miles.
pub fn parse_prior(s: &str) -> Result<PositionPrior, String> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    if parts.len() != 3 {
        return Err(format!(
            "expected lat,lon,sigma_nm (a prior needs a 1-sigma radius), got {s:?}"
        ));
    }
    let center = parse_latlon(&parts[..2].join(","))?;
    let sigma_nm = number(parts[2], "sigma_nm")?;
    if sigma_nm <= 0.0 {
        return Err(format!(
            "a prior needs a positive 1-sigma radius in NM, got {sigma_nm}"
        ));
    }
    Ok(PositionPrior { center, sigma_nm })
}

fn number(s: &str, what: &str) -> Result<f64, String> {
    let v: f64 = s
        .parse()
        .map_err(|_| format!("{what} {s:?} is not a number"))?;
    if v.is_finite() {
        Ok(v)
    } else {
        Err(format!("{what} {s:?} is not finite"))
    }
}

fn check_range(what: &str, v: f64, min: f64, max: f64) -> Result<(), String> {
    if v < min || v > max {
        Err(format!("{what} {v} is outside [{min}, {max}]"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn latlon_parses_east_positive_degrees() {
        let p = parse_latlon("39.9526,-75.1652").unwrap();
        assert_eq!(p.lat_deg, 39.9526);
        assert_eq!(p.lon_deg, -75.1652);
        assert_eq!(parse_latlon(" 40 , 75 ").unwrap().lon_deg, 75.0);
    }

    /// CONVENTIONS section 1: longitude is `(-180, 180]`, so the antimeridian has one
    /// spelling. `plan --position 0,-180` used to print `-180.000000`, which is outside
    /// the documented range, and `--json` carried the same value.
    #[test]
    fn the_antimeridian_is_normalised_to_plus_one_eighty() {
        assert_eq!(parse_latlon("0,-180").unwrap().lon_deg, 180.0);
        assert_eq!(parse_latlon("0,180").unwrap().lon_deg, 180.0);
        // Nothing else moves, not even in the last bits: these must stay exact.
        for lon in [
            "-179.9999",
            "-75.1652",
            "-0.0001",
            "0",
            "75.1652",
            "179.9999",
        ] {
            let got = parse_latlon(&format!("10,{lon}")).unwrap().lon_deg;
            assert_eq!(
                got,
                lon.parse::<f64>().unwrap(),
                "longitude {lon} was perturbed"
            );
        }
    }

    #[test]
    fn latlon_refuses_nonsense_rather_than_defaulting() {
        assert!(parse_latlon("39.9526").is_err());
        assert!(parse_latlon("39.9526,-75,1").is_err());
        assert!(parse_latlon("north,west").is_err());
        assert!(parse_latlon("91,0").is_err());
        assert!(parse_latlon("0,181").is_err());
        assert!(parse_latlon("nan,0").is_err());
    }

    #[test]
    fn prior_needs_a_positive_sigma() {
        let p = parse_prior("39.9526,-75.1652,20").unwrap();
        assert_eq!(p.sigma_nm, 20.0);
        assert!(parse_prior("39.9526,-75.1652").is_err());
        assert!(parse_prior("39.9526,-75.1652,0").is_err());
        assert!(parse_prior("39.9526,-75.1652,-5").is_err());
    }

    #[test]
    fn robust_takes_an_optional_threshold() {
        let cli = Cli::try_parse_from(["skyfix", "solve", "s.json", "--robust"]).unwrap();
        let Command::Solve { options, .. } = cli.command else {
            panic!("expected solve")
        };
        assert_eq!(options.robust, Some(1.5));

        let cli = Cli::try_parse_from(["skyfix", "solve", "s.json", "--robust", "2.5"]).unwrap();
        let Command::Solve { options, .. } = cli.command else {
            panic!("expected solve")
        };
        assert_eq!(options.robust, Some(2.5));

        let cli = Cli::try_parse_from(["skyfix", "solve", "s.json"]).unwrap();
        let Command::Solve { options, .. } = cli.command else {
            panic!("expected solve")
        };
        assert_eq!(options.robust, None);
    }

    /// Longitude is east-positive and latitude is north-positive (CONVENTIONS section 2),
    /// so most of the world's positions start with a minus sign. Clap reads a leading '-'
    /// as a flag unless the argument allows hyphen values, which made `--init -30,20`
    /// fail with "unexpected argument '-3' found" and forced `--init=-30,20`.
    #[test]
    fn southern_and_western_positions_parse_in_the_space_separated_form() {
        let cli =
            Cli::try_parse_from(["skyfix", "solve", "s.json", "--init", "-33.87,151.21"]).unwrap();
        let Command::Solve { options, .. } = cli.command else {
            panic!("expected solve")
        };
        assert_eq!(options.init.unwrap().lat_deg, -33.87);

        let cli = Cli::try_parse_from(["skyfix", "solve", "s.json", "--prior", "-33.87,-70.67,15"])
            .unwrap();
        let Command::Solve { options, .. } = cli.command else {
            panic!("expected solve")
        };
        let p = options.prior.unwrap();
        assert_eq!(
            (p.center.lat_deg, p.center.lon_deg, p.sigma_nm),
            (-33.87, -70.67, 15.0)
        );

        let cli = Cli::try_parse_from([
            "skyfix",
            "plan",
            "--position",
            "-45.0,-73.0",
            "--utc",
            "2026-10-01T01:30:00Z",
        ])
        .unwrap();
        let Command::Plan { position, .. } = cli.command else {
            panic!("expected plan")
        };
        assert_eq!((position.lat_deg, position.lon_deg), (-45.0, -73.0));

        // A mistyped flag after `--init` is still an error: it is not a position.
        assert!(Cli::try_parse_from(["skyfix", "solve", "s.json", "--init", "--json"]).is_err());
    }

    #[test]
    fn init_and_no_init_cannot_both_be_given() {
        assert!(
            Cli::try_parse_from(["skyfix", "solve", "s.json", "--init", "40,-75", "--no-init"])
                .is_err()
        );
    }

    #[test]
    fn reduce_json_and_csv_cannot_both_be_given() {
        assert!(Cli::try_parse_from(["skyfix", "reduce", "s.json", "--json", "--csv"]).is_err());
    }
}
