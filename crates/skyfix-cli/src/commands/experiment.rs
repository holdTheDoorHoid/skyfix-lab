//! `skyfix experiment`. OWNER: cli agent.
//!
//! Runs one scenario many times with fresh seeds and prints the three numbers that
//! decide whether the uncertainty model is telling the truth (docs/SIMULATOR.md
//! section 6):
//!
//! * **coverage** — how often the truth fell inside the nominal 95 % ellipse. Reported
//!   with a Wilson interval, not only a standard error, because the binomial standard
//!   error collapses to zero exactly where the interesting scenarios land and
//!   "0.00 +/- 0.00" would read as certainty.
//! * **mean error against mean predicted sigma**, and their ratio. About 1 when the
//!   model holds; far above 1 when something shared is moving every sight at once.
//! * **the signed mean error components**, which are what separate a systematic
//!   displacement from honest scatter.
//!
//! Two demos are *supposed* to fail this: `shared-bias` and `clock-offset` are
//! correlated errors that the independent-noise model cannot describe, and a runner
//! that reported 0.95 for them would be testing nothing. The summary says so rather
//! than leaving a reader to wonder whether the tool is broken.
//!
//! Unlike `solve`, the options come from the flags laid over the *generated* session's
//! own assumed position, taken from one sample run: the session is regenerated every
//! repetition, so there is no single file to read it from. `Experiment::check()` then
//! refuses the run outright if that initializer or a prior turns out to be the truth.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use skyfix_sim::experiment::{Aggregate, Experiment, ExperimentSummary, to_csv, to_json};
use skyfix_sim::generate;

use crate::commands::{scenarios, solve};
use crate::exit;
use crate::provider;
use crate::report;

pub struct Args {
    pub demo: Option<String>,
    pub scenario: Option<PathBuf>,
    pub repetitions: u32,
    pub out: Option<PathBuf>,
    pub flags: solve::Flags,
}

pub fn run(args: &Args) -> Result<u8> {
    let scenario = scenarios::resolve(args.demo.as_deref(), args.scenario.as_deref())?;
    let astro = provider::auto_provider();

    // One sample run, only to learn what assumed position the sessions will carry, so
    // the solver is set up exactly as `skyfix solve` would set it up for one of them.
    let (sample, _) = generate::simulate(&scenario, Some(&astro))
        .map_err(|e| anyhow::anyhow!("scenario {:?}: {e}", scenario.name))?;
    let solve_options = solve::apply_flags(solve::options_from_session(&sample), &args.flags);

    let experiment = Experiment {
        scenario,
        solve_options,
        repetitions: args.repetitions,
    };
    if let Err(e) = experiment.check() {
        bail!("{e}");
    }

    let summary = skyfix_sim::experiment::run(&experiment, Some(&astro));
    if let Some(path) = &args.out {
        write_table(&summary, path)?;
        eprintln!(
            "wrote {} repetition(s) to {}",
            summary.runs.len(),
            path.display()
        );
    }
    report::emit(&render(&summary, &experiment))?;

    // A summary whose repetitions all failed is a failed experiment, not a result.
    let evaluated = summary.aggregate.evaluated;
    if summary.aggregate.repetitions == 0 {
        Ok(exit::SOLVE_FAILED)
    } else if evaluated == 0 {
        eprintln!("no repetition produced a unique fix with a usable covariance.");
        Ok(exit::SOLVE_FAILED)
    } else {
        Ok(exit::OK)
    }
}

fn write_table(summary: &ExperimentSummary, path: &Path) -> Result<()> {
    let text = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("csv") => to_csv(summary),
        Some("json") | None => {
            let mut s = to_json(summary).map_err(|e| anyhow::anyhow!("{e}"))?;
            s.push('\n');
            s
        }
        Some(other) => bail!("cannot write an experiment as .{other}: name it .json or .csv"),
    };
    std::fs::write(path, text).with_context(|| format!("cannot write {}", path.display()))
}

pub fn render(summary: &ExperimentSummary, experiment: &Experiment) -> String {
    let a = &summary.aggregate;
    let mut out = String::new();
    out.push_str(&format!("EXPERIMENT {}\n", summary.name));
    for line in report::wrap(&summary.description, 86, "  ") {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(&format!(
        "\nRepetitions  {} run, {} scored (a repetition is scored only when it gives a \
         unique fix with a usable covariance)\n",
        a.repetitions, a.evaluated
    ));
    if !a.result_kind_counts.is_empty() {
        out.push_str(&format!(
            "Outcomes     {}\n",
            a.result_kind_counts
                .iter()
                .map(|(k, n)| format!("{k} {n}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    out.push_str("\nDoes the uncertainty describe the error?\n");
    match (a.coverage_fraction, a.coverage_ci95) {
        (Some(p), Some((lo, hi))) => {
            out.push_str(&format!(
                "  coverage of the nominal 95 % ellipse  {:.3} (Wilson 95 % interval \
                 {lo:.3} to {hi:.3})\n",
                p
            ));
        }
        (Some(p), None) => {
            out.push_str(&format!("  coverage of the nominal 95 % ellipse  {p:.3}\n"));
        }
        _ => out.push_str("  coverage of the nominal 95 % ellipse  not measurable\n"),
    }
    out.push_str(&format!(
        "  mean error                            {}\n",
        opt_m(a.mean_error_m)
    ));
    out.push_str(&format!(
        "  mean predicted sigma                  {}\n",
        opt_m(a.mean_predicted_sigma_m)
    ));
    out.push_str(&format!(
        "  RMS error / RMS predicted sigma       {}\n",
        match a.error_to_sigma_ratio {
            Some(r) => format!("{r:.2}"),
            None => "-".to_string(),
        }
    ));
    out.push_str(&format!(
        "  mean signed error                     north {}, east {}\n",
        opt_m(a.mean_error_north_m),
        opt_m(a.mean_error_east_m)
    ));
    if let Some(r) = a.mean_residual_rms_arcmin {
        out.push_str(&format!(
            "  mean residual RMS                     {r:.3} arcminutes\n"
        ));
    }

    out.push('\n');
    for line in report::wrap(&verdict(a, experiment), 86, "") {
        out.push_str(&line);
        out.push('\n');
    }

    if !summary.notes.is_empty() {
        out.push_str("\nNotes\n");
        // A hundred repetitions of the same complaint is noise; say it once with a count.
        let mut seen: Vec<(String, usize)> = Vec::new();
        for n in &summary.notes {
            let text = strip_repetition_prefix(n);
            match seen.iter_mut().find(|(s, _)| *s == text) {
                Some((_, c)) => *c += 1,
                None => seen.push((text, 1)),
            }
        }
        for (text, count) in seen {
            let line = if count > 1 {
                format!("{text} (in {count} repetitions)")
            } else {
                text
            };
            for (i, l) in report::wrap(&line, 84, "    ").into_iter().enumerate() {
                if i == 0 {
                    out.push_str(&format!("  - {}\n", l.trim_start()));
                } else {
                    out.push_str(&format!("{l}\n"));
                }
            }
        }
    }
    out
}

/// One plain paragraph saying what the numbers mean for this scenario.
fn verdict(a: &Aggregate, experiment: &Experiment) -> String {
    let correlated = experiment.scenario.shared_altitude_bias_arcmin != 0.0
        || experiment.scenario.clock_offset_s != 0.0;
    let ratio = a.error_to_sigma_ratio;

    if a.evaluated == 0 {
        return "Nothing was scored, so there is no statement to make about the uncertainty \
                model. The outcome counts above say why: an ambiguous or underdetermined \
                result is a correct answer to an under-constrained question, not a failure \
                of the solver."
            .to_string();
    }
    if correlated {
        return format!(
            "This scenario injects an error that is the same on every sight, which the \
             independent-noise model behind the ellipse cannot represent — so it is meant \
             to fail this test, and a coverage near 0.95 here would mean the runner was not \
             measuring anything. The error is about {} times the predicted sigma, and the \
             signed mean error above shows the direction it pushes. More sights would \
             shrink the ellipse and not the error.",
            ratio.map(|r| format!("{r:.0}")).unwrap_or("-".into())
        );
    }
    match (a.coverage_fraction, ratio) {
        (Some(p), Some(r)) if (0.85..=1.0).contains(&p) && r < 1.6 => format!(
            "Coverage {p:.2} and an error-to-sigma ratio of {r:.2} are what an honest \
             independent-noise model looks like: the ellipse is about the right size, and \
             the errors scatter the way it predicts."
        ),
        (Some(p), Some(r)) => format!(
            "Coverage {p:.2} with an error-to-sigma ratio of {r:.2}: the reported \
             uncertainty and the errors actually seen do not agree, so read the scenario's \
             description above for what is moving the fix before trusting the ellipse."
        ),
        _ => "Not enough scored repetitions to say whether the uncertainty describes the \
              error."
            .to_string(),
    }
}

fn strip_repetition_prefix(note: &str) -> String {
    match note.split_once(": ") {
        Some((head, rest)) if head.starts_with("repetition ") => rest.to_string(),
        _ => note.to_string(),
    }
}

fn opt_m(v: Option<f64>) -> String {
    match v {
        Some(x) => report::metres_and_nm(x),
        None => "-".to_string(),
    }
}
