//! `skyfix plan`. OWNER: cli agent.
//!
//! Ranks the bodies worth shooting from an approximate position at a given instant, by
//! what each one does to the *conditioning* of the fix rather than by how bright it is
//! (docs/PLANNER.md). A very bright star at an azimuth you already have adds almost
//! nothing; a dim one at right angles to everything else can halve the ellipse.
//!
//! Two things this command discloses rather than hides:
//!
//! * **The position is an input.** A planner is allowed an approximate position where a
//!   solver is not, and the plan's notes say which position it rested on, printed
//!   verbatim.
//! * **Visibility is geometric only.** Nothing here knows about cloud, haze, a building
//!   or the Moon. The one atmospheric input is the Sun's altitude, computed here with
//!   `SunProvider`, and it only attaches the twilight sentence — it never removes a body.
//!
//! `--taken` reads a session of sights already made and folds them into the starting
//! geometry, so the recommendation is what to shoot *next*. Their azimuths are computed
//! at the plan's own position, not at the session's assumed position, so a session with
//! no assumed position still works and every azimuth in the plan is measured from the
//! same place.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use skyfix_core::geometry::{self, Point};
use skyfix_core::planner::{
    self, Candidate, ExcludedBody, Objective, Plan, PlanMetrics, PlanOptions, PlannedBody,
};
use skyfix_core::types::LatLon;
use skyfix_ephemeris::visibility;
use skyfix_ephemeris::{AstroProvider, catalog, sun::SunProvider};

use crate::exit;
use crate::input;
use crate::provider::{self, EphemerisChoice};
use crate::report;

/// `--objective` values. The long names live in `Objective::description`, which the plan
/// prints verbatim, so these are only the spellings a user types.
///
/// The shared `Min` prefix is the point, not an accident: clap kebab-cases these into
/// `min-trace`, `min-max-eigen` and `min-condition`, every one of them names a quantity
/// being minimised, and the spellings are a published interface.
#[allow(
    clippy::enum_variant_names,
    reason = "the variant names are the flag spellings"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum ObjectiveArg {
    /// A-optimal: minimise the overall size of the fix. The right default.
    #[default]
    MinTrace,
    /// E-optimal: minimise the worst direction, driving toward a round ellipse.
    MinMaxEigen,
    /// Minimise the ellipse's aspect ratio. Shape only; blind to size.
    MinCondition,
}

impl From<ObjectiveArg> for Objective {
    fn from(a: ObjectiveArg) -> Self {
        match a {
            ObjectiveArg::MinTrace => Objective::MinTrace,
            ObjectiveArg::MinMaxEigen => Objective::MinMaxEigenvalue,
            ObjectiveArg::MinCondition => Objective::MinConditionNumber,
        }
    }
}

pub struct Args {
    pub position: LatLon,
    pub utc: String,
    pub min_alt: f64,
    pub max_alt: f64,
    pub select: usize,
    pub objective: ObjectiveArg,
    pub taken: Option<PathBuf>,
    pub json: bool,
}

pub fn run(args: &Args) -> Result<u8> {
    let astro = provider::auto_provider();

    // The twilight flag. An instant outside the Sun provider's coverage is not fatal:
    // the plan then says "Sun altitude unknown" rather than inventing a sky.
    let sun_altitude_deg = sun_altitude(args.position, &args.utc);

    let mut extra_notes = Vec::new();
    let already_taken = match &args.taken {
        Some(path) => {
            let (candidates, note) = taken_from_session(path, args.position)?;
            extra_notes.push(note);
            candidates
        }
        None => Vec::new(),
    };

    let options = PlanOptions {
        select: args.select,
        min_altitude_deg: args.min_alt,
        max_altitude_deg: args.max_alt,
        already_taken,
        objective: args.objective.into(),
        base_sigma_arcmin: planner::DEFAULT_BASE_SIGMA_ARCMIN,
    };

    let names: Vec<String> = provider::known_bodies()
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut plan = visibility::plan_at(
        &astro,
        &names,
        args.position,
        &args.utc,
        &options,
        sun_altitude_deg,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    plan.notes.extend(extra_notes);

    if args.json {
        report::emit_line(&serde_json::to_string_pretty(&plan)?)?;
    } else {
        report::emit(&render(&plan, sun_altitude_deg))?;
    }
    Ok(exit::OK)
}

/// The Sun's geometric altitude at this place and instant, or `None` when the provider
/// cannot answer (outside coverage, or an unparseable timestamp).
fn sun_altitude(position: LatLon, utc: &str) -> Option<f64> {
    let jd = skyfix_core::time::parse_utc(utc).ok()?;
    let d = SunProvider::new().geocentric("Sun", jd).ok()?;
    let observer = Point::from_deg(position.lat_deg, position.lon_deg);
    let h = geometry::altitude(observer, d.gha_deg.to_radians(), d.dec_deg.to_radians());
    Some(h.to_degrees())
}

/// Sights already taken, as planner candidates measured from the plan's own position.
///
/// Every sight is reduced first, so a record that supplies its own direction and one the
/// provider resolves are treated identically, and the sigma is the reduced sigma — the
/// one an artificial-horizon halving or a low-altitude inflation already adjusted.
fn taken_from_session(path: &Path, at: LatLon) -> Result<(Vec<Candidate>, String)> {
    let bodies = provider::known_bodies();
    let loaded =
        input::load(path, &bodies).with_context(|| format!("--taken {}", path.display()))?;
    let source = provider::direction_source(EphemerisChoice::Auto);
    let (reduced, errors) =
        skyfix_core::reduce::reduce_session_partitioned(&loaded.session, source.as_ref());
    for e in &errors {
        eprintln!("--taken: skipping a sight: {e}");
    }

    let observer = Point::from_deg(at.lat_deg, at.lon_deg);
    let candidates: Vec<Candidate> = reduced
        .iter()
        .map(|r| {
            let (h, zn) = geometry::altitude_azimuth(
                observer,
                r.gha_deg.to_radians(),
                r.dec_deg.to_radians(),
            );
            Candidate {
                body: r.body.clone(),
                altitude_deg: h.to_degrees(),
                azimuth_deg: zn.to_degrees().rem_euclid(360.0),
                sigma_arcmin: r.sigma_arcmin,
                magnitude: catalog::find(&r.body).map(|s| s.magnitude),
                note: format!("already taken as {}", r.id),
            }
        })
        .collect();

    let note = format!(
        "{} sight(s) already taken were read from {} and fixed the starting geometry; \
         their azimuths were recomputed at the approximate position above, not at the \
         session's own assumed position",
        candidates.len(),
        path.display()
    );
    Ok((candidates, note))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

pub fn render(plan: &Plan, sun_altitude_deg: Option<f64>) -> String {
    let mut out = String::new();
    out.push_str("OBSERVATION PLAN\n");
    out.push_str(&format!(
        "Position   {} ({})\n",
        report::format_position(plan.approximate_position),
        report::format_position_decimal(plan.approximate_position)
    ));
    out.push_str(&format!("Time       {}\n", plan.utc));
    out.push_str(&format!(
        "Sun        {}, so {}\n",
        match sun_altitude_deg {
            Some(a) => format!("altitude {a:+.1} deg"),
            None => "altitude unknown".to_string(),
        },
        visibility::sun_altitude_note(sun_altitude_deg)
    ));
    out.push_str(&format!("Objective  {}\n", plan.objective.description()));

    out.push_str("\nShoot in this order\n");
    if plan.bodies.is_empty() {
        out.push_str("  nothing to recommend: no body survived the altitude window\n");
    } else {
        out.push_str(&format!(
            "  {}{}{:>7}{:>8}{:>7}{:>9}{:>12}\n",
            report::pad("#", 4),
            report::pad("body", 18),
            "alt",
            "Zn",
            "mag",
            "sigma '",
            "score"
        ));
        for b in &plan.bodies {
            out.push_str(&body_row(b));
        }
        out.push('\n');
        for b in &plan.bodies {
            for (i, line) in report::wrap(&b.rationale, 84, "       ")
                .into_iter()
                .enumerate()
            {
                if i == 0 {
                    out.push_str(&format!(
                        "  {}  {}\n",
                        report::pad(&format!("{}.", b.step), 3),
                        line.trim_start()
                    ));
                } else {
                    out.push_str(&format!("{line}\n"));
                }
            }
        }
        // The units belong with the numbers, and they change with the objective and
        // with whether the geometry was still rank-deficient at that step.
        let mut units: Vec<String> = Vec::new();
        for b in &plan.bodies {
            if !units.contains(&b.score_units) {
                units.push(b.score_units.clone());
            }
        }
        for u in units {
            for line in report::wrap(&format!("score is in {u}"), 86, "  ") {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }

    out.push_str("\nPredicted quality, sight by sight\n");
    out.push_str(&format!(
        "  {}{:>8}{:>12}{:>12}{:>12}{:>12}{:>10}{:>8}{:>8}\n",
        report::pad("step", 8),
        "sights",
        "sigma N m",
        "sigma E m",
        "semi-maj m",
        "semi-min m",
        "axis",
        "cond",
        "gap deg"
    ));
    for (i, m) in plan.progression.iter().enumerate() {
        let label = if i == 0 {
            "before".to_string()
        } else {
            format!("+{i}")
        };
        out.push_str(&metrics_row(&label, m));
    }
    out.push_str(&summary_sentence(plan));

    if !plan.excluded.is_empty() {
        out.push_str("\nExcluded\n");
        for e in &plan.excluded {
            out.push_str(&excluded_row(e));
        }
    }

    // Verbatim: a disclosure that has been reworded is no longer the disclosure the
    // planner made. One note per line, unwrapped, so the text is byte-identical to what
    // `--json` carries.
    out.push_str("\nNotes\n");
    for n in &plan.notes {
        out.push_str(&format!("  - {n}\n"));
    }
    out
}

fn body_row(b: &PlannedBody) -> String {
    format!(
        "  {}{}{:>7.1}{:>8.1}{:>7}{:>9.2}{:>12.1}\n",
        report::pad(&b.step.to_string(), 4),
        report::pad(&b.body, 18),
        b.altitude_deg,
        b.azimuth_deg,
        match b.magnitude {
            Some(m) => format!("{m:.2}"),
            None => "-".to_string(),
        },
        b.sigma_arcmin,
        b.score
    )
}

fn metrics_row(label: &str, m: &PlanMetrics) -> String {
    format!(
        "  {}{:>8}{:>12}{:>12}{:>12}{:>12}{:>10}{:>8}{:>8.1}\n",
        report::pad(label, 8),
        m.sight_count,
        report::opt_num(m.sigma_north_m, 1),
        report::opt_num(m.sigma_east_m, 1),
        report::opt_num(m.semi_major_sigma_m, 1),
        report::opt_num(m.semi_minor_sigma_m, 1),
        match m.semi_major_azimuth_deg {
            Some(a) => planner::axis_name(a),
            None => "-",
        },
        report::opt_num(m.condition_number, 2),
        m.max_azimuth_gap_deg
    )
}

fn excluded_row(e: &ExcludedBody) -> String {
    let mut out = String::new();
    for (i, line) in report::wrap(&e.reason, 84, "        ")
        .into_iter()
        .enumerate()
    {
        if i == 0 {
            out.push_str(&format!(
                "  {}alt {:>5.1}  Zn {:>5.1}  {}\n",
                report::pad(&e.body, 18),
                e.altitude_deg,
                e.azimuth_deg,
                line.trim_start()
            ));
        } else {
            out.push_str(&format!("{line}\n"));
        }
    }
    out
}

/// One plain sentence about what the plan buys, in the units a navigator cares about.
fn summary_sentence(plan: &Plan) -> String {
    let sentence = match (
        plan.baseline.trace_sigma_m,
        plan.predicted.trace_sigma_m,
        plan.baseline.singular,
    ) {
        (_, None, _) => "Even with every body above, the geometry stays rank-deficient: \
                         these sights cannot fix a position on their own."
            .to_string(),
        (_, Some(after), true) => format!(
            "Before these sights there is no position at all — fewer than two independent \
             azimuths, so no covariance exists. Afterwards the predicted fix is about \
             {after:.0} m overall."
        ),
        (Some(before), Some(after), false) => format!(
            "Taking all {} brings the predicted fix from about {before:.0} m overall to \
             about {after:.0} m, a factor of {:.1}.",
            plan.bodies.len(),
            if after > 0.0 {
                before / after
            } else {
                f64::NAN
            }
        ),
        (None, Some(after), false) => {
            format!("The predicted fix after these sights is about {after:.0} m overall.")
        }
    };
    let mut out = String::from("\n");
    for line in report::wrap(&sentence, 86, "") {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objective_names_map_onto_the_core_enum() {
        assert_eq!(Objective::from(ObjectiveArg::MinTrace), Objective::MinTrace);
        assert_eq!(
            Objective::from(ObjectiveArg::MinMaxEigen),
            Objective::MinMaxEigenvalue
        );
        assert_eq!(
            Objective::from(ObjectiveArg::MinCondition),
            Objective::MinConditionNumber
        );
        // The default the CLI offers is the default the core intends.
        assert_eq!(
            Objective::from(ObjectiveArg::default()),
            Objective::default()
        );
    }

    #[test]
    fn the_sun_is_below_the_horizon_over_philadelphia_at_the_demo_instant() {
        let a = sun_altitude(
            LatLon {
                lat_deg: 39.9526,
                lon_deg: -75.1652,
            },
            "2026-10-01T01:30:00Z",
        )
        .expect("the Sun provider covers 2026");
        // 21:30 local on 1 October: well past nautical twilight.
        assert!(
            a < visibility::NAUTICAL_TWILIGHT_DEG,
            "Sun altitude {a} should be below {}",
            visibility::NAUTICAL_TWILIGHT_DEG
        );
        assert_eq!(
            visibility::sun_altitude_note(Some(a)),
            visibility::NOTE_DARK
        );
    }

    #[test]
    fn an_instant_outside_coverage_yields_no_sun_altitude_rather_than_a_guess() {
        let p = LatLon {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
        };
        assert!(sun_altitude(p, "1850-01-01T00:00:00Z").is_none());
        assert!(sun_altitude(p, "not a timestamp").is_none());
        assert_eq!(
            visibility::sun_altitude_note(None),
            visibility::NOTE_SUN_UNKNOWN
        );
    }
}
