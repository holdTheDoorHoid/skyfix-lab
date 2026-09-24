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
use skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR;
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

/// For a clock scenario: the shift in longitude, and why a due-west shift still shows a
/// small north component in the signed mean above.
///
/// `mean_error_north_m` and `mean_error_east_m` are a tangent-plane decomposition taken
/// along the great circle from the truth to the fix. A displacement due west along a
/// *parallel* is not a great circle, so its initial bearing is a fraction of a degree
/// poleward of 270 and the north component is small but not zero. Nothing about the
/// latitude has moved, and docs/SIMULATOR.md section 2 says so; without this sentence the
/// reader has only the table, which looks like a latitude error.
fn clock_shift_sentence(experiment: &Experiment) -> String {
    let dt = experiment.scenario.clock_offset_s;
    if dt == 0.0 || experiment.scenario.shared_altitude_bias_arcmin != 0.0 {
        return String::new();
    }
    let shift_deg =
        skyfix_sim::experiment::clock_longitude_shift_deg(SIDEREAL_RATE_DEG_PER_HOUR, dt);
    format!(
        " In longitude that is {shift_deg:+.6} degrees, and the latitude has not moved: the \
         small north component above is the great-circle decomposition of a shift along a \
         parallel, not a change of latitude."
    )
}

/// Error-to-sigma ratios that count as agreement between the ellipse and the errors.
///
/// docs/SIMULATOR.md section 6: under a correct model `E[|e|^2] = sigma_north^2 +
/// sigma_east^2`, so the ratio should be about 1. The band is two-sided and generous:
/// the sampling error of an RMS over `n` runs is roughly `1 / (2 sqrt(n))`, which is
/// 0.11 at 20 repetitions, so 0.6 to 1.6 admits honest scatter at every repetition count
/// the CLI defaults to while still catching an ellipse that is half or double the size
/// the errors call for.
const RATIO_BAND: std::ops::RangeInclusive<f64> = 0.6..=1.6;

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
             shrink the ellipse and not the error.{}",
            ratio.map(|r| format!("{r:.0}")).unwrap_or("-".into()),
            clock_shift_sentence(experiment)
        );
    }
    match (a.coverage_fraction, ratio) {
        (Some(p), Some(r)) if (0.85..=1.0).contains(&p) && RATIO_BAND.contains(&r) => format!(
            "Coverage {p:.2} and an error-to-sigma ratio of {r:.2} are what an honest \
             independent-noise model looks like: the ellipse is about the right size, and \
             the errors scatter the way it predicts."
        ),
        (Some(p), Some(r)) => {
            // The band is two-sided on purpose. An ellipse ten times too big also fails to
            // describe the error, and reporting it as healthy would be exactly the flattery
            // this runner exists to prevent (docs/SIMULATOR.md section 6: the ratio should
            // be about 1).
            let direction = if r < *RATIO_BAND.start() {
                " The predicted uncertainty is too large relative to the observed error: the \
                 ellipse covers the truth, but it claims less than the sights can support."
            } else if r > *RATIO_BAND.end() {
                " The predicted uncertainty is too small relative to the observed error: the \
                 ellipse is narrower than the errors actually seen."
            } else {
                ""
            };
            format!(
                "Coverage {p:.2} with an error-to-sigma ratio of {r:.2}: the reported \
                 uncertainty and the errors actually seen do not agree, so read the scenario's \
                 description above for what is moving the fix before trusting the \
                 ellipse.{direction}"
            )
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_sim::demos;

    fn scored(coverage: f64, ratio: f64) -> Aggregate {
        Aggregate {
            repetitions: 50,
            evaluated: 50,
            coverage_fraction: Some(coverage),
            error_to_sigma_ratio: Some(ratio),
            ..Default::default()
        }
    }

    /// docs/SIMULATOR.md section 6: the ratio should be about 1. An ellipse ten times too
    /// big fails to describe the error just as an ellipse half the size does, so the band
    /// is two-sided and the sentence says which way it is wrong.
    #[test]
    fn the_verdict_band_on_the_error_to_sigma_ratio_is_two_sided() {
        let clean = Experiment::new(demos::philadelphia_stars(), 50);

        for r in [0.6, 0.93, 1.0, 1.05, 1.6] {
            let v = verdict(&scored(0.96, r), &clean);
            assert!(
                v.contains("are what an honest"),
                "ratio {r} should read as healthy: {v}"
            );
        }

        // Too large an ellipse: high coverage, tiny ratio. This is the case a one-sided
        // `r < 1.6` band endorsed.
        let v = verdict(&scored(1.0, 0.10), &clean);
        assert!(!v.contains("are what an honest"), "{v}");
        assert!(
            v.contains("predicted uncertainty is too large relative to the observed error"),
            "{v}"
        );

        // Too small an ellipse.
        let v = verdict(&scored(0.40, 7.57), &clean);
        assert!(!v.contains("are what an honest"), "{v}");
        assert!(
            v.contains("predicted uncertainty is too small relative to the observed error"),
            "{v}"
        );

        // Coverage out of band with a healthy ratio: still a disagreement, but the ratio
        // is not the thing to blame, so neither direction is asserted.
        let v = verdict(&scored(0.50, 1.0), &clean);
        assert!(!v.contains("are what an honest"), "{v}");
        assert!(!v.contains("predicted uncertainty is too"), "{v}");
    }

    /// The signed mean error of a pure clock offset shows a small north component because
    /// the components are a great-circle decomposition of a shift along a parallel.
    /// docs/SIMULATOR.md section 2 says latitude is untouched; the report must agree.
    #[test]
    fn a_clock_scenario_explains_its_small_north_component() {
        let clock = Experiment::new(demos::clock_offset(), 50);
        let v = verdict(&scored(0.0, 12.87), &clock);
        assert!(v.contains("-0.250684 degrees"), "{v}");
        assert!(v.contains("the latitude has not moved"), "{v}");
        assert!(v.contains("great-circle decomposition"), "{v}");

        // A shared bias is not a clock offset, and must not claim a longitude shift.
        let bias = Experiment::new(demos::shared_bias(), 50);
        let v = verdict(&scored(0.0, 30.45), &bias);
        assert!(!v.contains("degrees of longitude"), "{v}");
        assert!(!v.contains("the latitude has not moved"), "{v}");

        // An uncorrelated scenario says nothing about longitude at all.
        let clean = Experiment::new(demos::philadelphia_stars(), 50);
        assert!(!verdict(&scored(0.96, 1.02), &clean).contains("latitude has not moved"));
    }
}
