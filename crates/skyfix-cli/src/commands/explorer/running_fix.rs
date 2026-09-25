//! `skyfix running-fix`: a fix from sights taken under way. OWNER: cli agent.
//!
//! `skyfix_motion::request::running_fix_session`, the same function the WASM
//! `running_fix` export calls (docs/MOTION.md; docs/NAVIGATION_METHODS.md section 5):
//! each sight's geographic position is advanced along the dead-reckoning track to one
//! instant, the track's uncertainty is folded into each sight's sigma along its line of
//! sight, and the equivalent stationary sights are solved by the ordinary solver.
//!
//! The solver options are built exactly as `skyfix solve` builds them — the session's
//! assumed position in its declared role, its clock uncertainty, then every solve flag —
//! so a running fix of sights taken at one place is the same fix `solve` gives.
//! `--format json` is the `RunningFixOutput` (EXPLORER_API.md `running_fix`), whose
//! `result` is the `FixResult` `solve --json` prints.

use std::path::PathBuf;

use anyhow::{Result, anyhow};
use skyfix_core::types::{FixResult, SolveOptions};
use skyfix_motion::request::{
    MotionUncertaintyInput, RunningFixLeg, RunningFixOutput, RunningFixRequest, running_fix_session,
};

use super::args::{FormatArgs, parse_leg, wire_instant};
use super::methods::{self, labelled};
use super::text;
use crate::cli::SolveFlags;
use crate::commands::solve;
use crate::exit;
use crate::provider;
use crate::report;
use skyfix_core::time::parse_utc;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Session file (.json or .csv) with the sights, taken while under way.
    pub session: PathBuf,
    /// One dead-reckoning leg, [START_UTC,]COURSE_DEG,SPEED_KN; repeat for each leg in
    /// time order. Only the first may leave out its start: it then starts at the first
    /// sight. Before the first leg and after --end-utc the vessel is stationary.
    #[arg(
        long = "leg",
        value_name = "[START,]COURSE,SPEED",
        value_parser = parse_leg,
        required = true,
        allow_hyphen_values = true
    )]
    pub legs: Vec<RunningFixLeg>,
    /// When the track stops, RFC 3339 UTC.
    #[arg(long = "end-utc", value_name = "RFC3339")]
    pub end_utc: Option<String>,
    /// The instant the fix is for, RFC 3339 UTC. Default: the last sight.
    #[arg(long = "reference-utc", value_name = "RFC3339")]
    pub reference_utc: Option<String>,
    /// 1-sigma error of the speed made good, knots. Leave all three motion sigmas out
    /// and the run between the sights is treated as exact, which the report says.
    #[arg(long = "speed-sigma", value_name = "KN", default_value_t = 0.0)]
    pub speed_sigma: f64,
    /// 1-sigma error of the course made good, degrees.
    #[arg(long = "course-sigma", value_name = "DEG", default_value_t = 0.0)]
    pub course_sigma: f64,
    /// Random-walk position error, nautical miles per square root of an hour.
    #[arg(
        long = "random-walk",
        value_name = "NM_PER_SQRT_H",
        default_value_t = 0.0
    )]
    pub random_walk: f64,
    #[command(flatten)]
    pub solve: SolveFlags,
    /// Exit 3 unless the result is a single unique fix with a 95 % ellipse.
    #[arg(long = "require-unique")]
    pub require_unique: bool,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// The request the flags describe, with the solver options `skyfix solve` would build
/// for this session.
pub fn request(a: &Args, session: &skyfix_core::types::Session) -> Result<RunningFixRequest> {
    // As the engine's wire strings: the flags may be typed in the Julian calendar.
    let wire = |flag: &str, value: &Option<String>| -> Result<Option<String>> {
        match value {
            Some(u) => Ok(Some(wire_instant(u).map_err(|e| anyhow!("{flag}: {e}"))?)),
            None => Ok(None),
        }
    };
    let end_utc = wire("--end-utc", &a.end_utc)?;
    let reference_utc = wire("--reference-utc", &a.reference_utc)?;
    let flags = a.solve.to_flags(false, a.require_unique);
    Ok(RunningFixRequest {
        reference_utc,
        legs: a.legs.clone(),
        end_utc,
        motion_uncertainty: MotionUncertaintyInput {
            speed_sigma_kn: a.speed_sigma,
            course_sigma_deg: a.course_sigma,
            random_walk_nm_per_sqrt_hour: a.random_walk,
        },
        options: solve::build_options(session, &flags),
    })
}

pub fn run(a: &Args) -> Result<u8> {
    let session = methods::load(&a.session)?;
    let request = request(a, &session)?;
    let source = provider::direction_source(a.solve.ephemeris);
    let r = running_fix_session(&session, &request, source.as_ref()).map_err(|e| anyhow!(e))?;

    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&r)?)?;
    } else {
        // `solve`'s own header: the assumed position is shown in its declared role, which
        // is what it is to the solver here too.
        let used_provider = r
            .sights
            .iter()
            .find(|s| s.direction_source != skyfix_core::reduce::SUPPLIED_DIRECTION_SOURCE)
            .map(|s| s.direction_source.clone());
        let mut out = String::from("RUNNING FIX\n");
        out.push_str(&crate::commands::reduce::session_header(
            &session,
            a.solve.ephemeris,
            &used_provider,
        ));
        out.push_str(&render(&r, &request, &request.options));
        report::emit(&out)?;
    }

    let mut code = methods::exit_for(
        session.observations.len() - r.sights.len(),
        session.observations.len(),
    );
    if matches!(r.result, FixResult::Failed { .. }) {
        code = exit::worse(code, exit::SOLVE_FAILED);
    } else if a.require_unique
        && let Some(why) = solve::not_a_usable_single_position(&r.result)
    {
        eprintln!("--require-unique was given and {why}");
        code = exit::worse(code, exit::SOLVE_FAILED);
    }
    Ok(code)
}

pub fn render(r: &RunningFixOutput, request: &RunningFixRequest, options: &SolveOptions) -> String {
    let mut out = String::new();
    labelled(
        "Reference",
        &format!(
            "{} ({})",
            text::utc(r.reference_jd_utc),
            if request.reference_utc.is_some() {
                "--reference-utc"
            } else {
                "the last sight"
            }
        ),
        &mut out,
    );
    for (i, leg) in request.legs.iter().enumerate() {
        let from = match &leg.start_utc {
            // The request carries wire strings (proleptic Gregorian).
            Some(u) => parse_utc(u).map_or_else(|_| u.clone(), text::utc),
            None => "the first sight".to_string(),
        };
        labelled(
            if i == 0 { "Track" } else { "" },
            &format!(
                "from {from}: course {} at {} kn",
                text::course(leg.course_deg),
                leg.speed_kn
            ),
            &mut out,
        );
    }
    if let Some(end) = &request.end_utc {
        labelled(
            "",
            &format!(
                "ends {}: stationary after it",
                parse_utc(end).map_or_else(|_| end.clone(), text::utc)
            ),
            &mut out,
        );
    }
    let m = &request.motion_uncertainty;
    let motion = if m.speed_sigma_kn == 0.0
        && m.course_sigma_deg == 0.0
        && m.random_walk_nm_per_sqrt_hour == 0.0
    {
        "not stated: the run between the sights is treated as exact".to_string()
    } else {
        format!(
            "1-sigma speed {} kn, course {} deg, random walk {} NM per sqrt(hour)",
            m.speed_sigma_kn, m.course_sigma_deg, m.random_walk_nm_per_sqrt_hour
        )
    };
    labelled("Motion", &motion, &mut out);
    let advance = match (r.applied, r.reference_estimate) {
        (true, Some(p)) => format!(
            "applied in {} pass(es), linearised at {} ({})",
            r.passes,
            report::format_position(p),
            report::format_position_decimal(p)
        ),
        _ => "NOT applied: the sights were solved as if the vessel had stood still (the \
              warnings say why)"
            .to_string(),
    };
    labelled("Advance", &advance, &mut out);

    if !r.inflations.is_empty() {
        out.push_str("\nWhat the dead reckoning adds to each sight's sigma\n");
        out.push_str(&format!(
            "  {}{:>9}{:>9}{:>10}{:>10}{:>10}{:>10}\n",
            report::pad("id", 10),
            "h to ref",
            "run NM",
            "Zn",
            "sight '",
            "motion '",
            "total '"
        ));
        for i in &r.inflations {
            out.push_str(&format!(
                "  {}{:>9}{:>9.1}{:>10}{:>10.2}{:>10.2}{:>10.2}\n",
                report::pad(&i.id, 10),
                text::signed_fixed(i.hours_to_reference, 2),
                i.run_nm,
                text::dm360(i.zn_deg),
                i.sigma_sight_arcmin,
                i.sigma_motion_arcmin,
                i.sigma_total_arcmin
            ));
        }
    }
    out.push('\n');
    out.push_str(&solve::render(&r.result, options));
    methods::workings_note(&mut out);
    out
}
