//! `skyfix solve`. OWNER: cli agent.
//!
//! Builds [`SolveOptions`] from the session and then from the flags — flags always win —
//! reduces every observation, solves, and prints a report that leads with the kind of
//! answer in capitals so nobody mistakes an ambiguous pair for a fix.
//!
//! The assumed position's *role* is carried through exactly as CONVENTIONS section 8
//! requires: `initializer` becomes a starting point and nothing more, `prior` becomes a
//! genuine quadratic prior whose effect is reported, and `disabled` is ignored. An
//! initializer is never quietly promoted to a prior here or anywhere below.

use std::path::Path;

use anyhow::Result;
use skyfix_core::reduce;
use skyfix_core::solver;
use skyfix_core::types::{
    AssumedPositionRole, CircleOfPosition, Conditioning, Fix, FixCandidate, FixResult, LatLon,
    PositionPrior, RobustOptions, Session, SolveOptions, Warning,
};
use skyfix_core::uncertainty;

use crate::exit;
use crate::input;
use crate::provider::{self, EphemerisChoice};
use crate::report::{self, warning_sentence};

/// Command-line overrides. Every `Option` that is `Some` replaces whatever the session
/// file said.
#[derive(Debug, Clone, Default)]
pub struct Flags {
    pub ephemeris: EphemerisChoice,
    pub json: bool,
    pub init: Option<LatLon>,
    pub no_init: bool,
    pub prior: Option<PositionPrior>,
    pub bias: bool,
    pub robust: Option<f64>,
    pub clock_sigma: Option<f64>,
    pub posterior_scaling: bool,
    pub no_multistart: bool,
    pub grid_step: Option<f64>,
    pub require_unique: bool,
    /// `--dut1`: UT1 - UTC in seconds, over the session's `clock.dut1_s`.
    pub dut1: Option<f64>,
}

pub fn run(path: &Path, flags: &Flags) -> Result<u8> {
    let bodies = provider::known_bodies();
    let mut loaded = input::load(path, &bodies)?;
    for w in &loaded.warnings {
        eprintln!("warning: {}", warning_sentence(w));
    }

    // `--dut1` wins over the session's clock.dut1_s (expansion programme).
    if let Some(d) = flags.dut1 {
        loaded.session.clock.dut1_s = Some(d);
    }
    let source = provider::session_source(flags.ephemeris, &loaded.session);
    let (reduced, errors) = reduce::reduce_session_partitioned(&loaded.session, source.as_ref());
    for e in &errors {
        eprintln!("rejected: {e}");
    }

    let options = build_options(&loaded.session, flags);
    let sights = reduce::to_sights(&reduced, source.as_ref());
    let result = solver::solve(&sights, &options);

    let used_provider = reduced
        .iter()
        .find(|r| r.direction_source != reduce::SUPPLIED_DIRECTION_SOURCE)
        .map(|r| r.direction_source.clone());

    if flags.json {
        report::emit_line(&serde_json::to_string_pretty(&result)?)?;
    } else {
        let mut out = crate::commands::reduce::session_header(
            &loaded.session,
            flags.ephemeris,
            &used_provider,
        );
        out.push('\n');
        out.push_str(&render(&result, &options));
        report::emit(&out)?;
    }
    if let Some(w) = provider_note(&reduced) {
        eprintln!("note: {}", warning_sentence(&w));
    }

    let mut code = if errors.is_empty() {
        exit::OK
    } else {
        // "the fix below" is a promise, so it is only made when there is one.
        if reduced.is_empty() {
            eprintln!(
                "all {} sight(s) were rejected; there is nothing left to solve.",
                errors.len()
            );
        } else {
            eprintln!(
                "{} of {} sight(s) were rejected; the fix below uses the remaining {}.",
                errors.len(),
                loaded.session.observations.len(),
                reduced.len()
            );
        }
        exit::SIGHTS_REJECTED
    };

    if matches!(result, FixResult::Failed { .. }) {
        code = exit::worse(code, exit::SOLVE_FAILED);
    } else if flags.require_unique
        && let Some(why) = not_a_usable_single_position(&result)
    {
        eprintln!("--require-unique was given and {why}");
        code = exit::worse(code, exit::SOLVE_FAILED);
    }
    Ok(code)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Session first, flags second. Only `initializer` is taken from an assumed position
/// whose role is `initializer`; a `prior` role becomes a prior and nothing else, so an
/// assumed position can never act as both.
pub fn build_options(session: &Session, flags: &Flags) -> SolveOptions {
    apply_flags(options_from_session(session), flags)
}

/// The session's own contribution: the assumed position in whatever role it declares,
/// and the clock uncertainty to propagate (CONVENTIONS sections 6 and 8).
pub fn options_from_session(session: &Session) -> SolveOptions {
    let mut o = SolveOptions::default();
    if let Some(ap) = session.observer.assumed_position {
        match session.observer.assumed_position_role {
            AssumedPositionRole::Initializer => o.initializer = Some(ap),
            AssumedPositionRole::Prior { sigma_nm } => {
                o.prior = Some(PositionPrior {
                    center: ap,
                    sigma_nm,
                })
            }
            AssumedPositionRole::Disabled => {}
        }
    }
    o.clock_uncertainty_s = session.clock.uncertainty_s;
    o
}

/// Lay the command-line flags over whatever options were built so far. Every flag that
/// is present wins.
pub fn apply_flags(mut o: SolveOptions, flags: &Flags) -> SolveOptions {
    if flags.no_init {
        o.initializer = None;
    }
    if let Some(p) = flags.init {
        o.initializer = Some(p);
    }
    if let Some(p) = flags.prior {
        o.prior = Some(p);
    }
    o.estimate_shared_bias = flags.bias;
    if let Some(k) = flags.robust {
        o.robust = Some(RobustOptions {
            huber_k: k,
            ..RobustOptions::default()
        });
    }
    if let Some(s) = flags.clock_sigma {
        o.clock_uncertainty_s = s;
    }
    o.posterior_scaling = flags.posterior_scaling;
    if flags.no_multistart {
        o.multistart.enabled = false;
    }
    if let Some(g) = flags.grid_step {
        o.multistart.grid_step_deg = g;
    }
    o
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The whole report as one string, so tests can assert on it without a subprocess.
pub fn render(result: &FixResult, options: &SolveOptions) -> String {
    let mut out = String::new();
    match result {
        FixResult::Unique {
            fix,
            alternatives,
            circles,
            warnings,
        } => {
            out.push_str("UNIQUE FIX\n");
            render_fix(fix, options, &mut out);
            render_circles(circles, &mut out);
            if !alternatives.is_empty() {
                out.push_str("\nRejected alternatives\n");
                for (i, c) in alternatives.iter().enumerate() {
                    out.push_str(&format!(
                        "  {}. {} ({})  delta chi2 {:.3} worse than the fix\n",
                        i + 1,
                        report::format_position(c.position),
                        report::format_position_decimal(c.position),
                        c.delta_chi2_from_best
                    ));
                }
            }
            report::warning_block(warnings, &mut out);
        }
        FixResult::Ambiguous {
            candidates,
            circles,
            warnings,
        } => {
            out.push_str(&format!("AMBIGUOUS: {} CANDIDATES\n", candidates.len()));
            for (i, c) in candidates.iter().enumerate() {
                render_candidate(i + 1, c, &mut out);
            }
            out.push('\n');
            // The headline goes out unwrapped: it is the sentence a reader scanning the
            // output is looking for, and a line break through the middle of it would
            // make it harder to find and harder to grep for.
            out.push_str(&format!(
                "These observations cannot distinguish the {} candidates.\n",
                candidates.len()
            ));
            for line in report::wrap(AMBIGUITY_REMEDY, 88, "") {
                out.push_str(&line);
                out.push('\n');
            }
            render_circles(circles, &mut out);
            report::warning_block(warnings, &mut out);
        }
        FixResult::Underdetermined {
            circles,
            reason,
            warnings,
        } => {
            out.push_str("UNDERDETERMINED\n");
            out.push_str(&format!("Reason  {reason}\n"));
            render_circles(circles, &mut out);
            out.push('\n');
            let (headline, remedy) = underdetermined_sentences(circles.len());
            out.push_str(headline);
            out.push('\n');
            for line in report::wrap(remedy, 88, "") {
                out.push_str(&line);
                out.push('\n');
            }
            report::warning_block(warnings, &mut out);
        }
        FixResult::Failed { reason, warnings } => {
            out.push_str("FAILED\n");
            out.push_str(&format!("Reason  {reason}\n"));
            report::warning_block(warnings, &mut out);
        }
    }
    out
}

fn render_fix(fix: &Fix, options: &SolveOptions, out: &mut String) {
    out.push_str(&format!(
        "Position     {}\n             {}\n",
        report::format_position_decimal(fix.position),
        report::format_position(fix.position)
    ));
    out.push_str(&format!(
        "Uncertainty  sigma north {}, sigma east {}\n",
        report::metres_and_nm(fix.sigma_north_m),
        report::metres_and_nm(fix.sigma_east_m)
    ));
    out.push_str(&format!(
        "             clock contribution to east {}\n",
        report::metres_and_nm(fix.clock_sigma_east_m)
    ));
    match (&fix.ellipse95, &fix.ellipse_suppressed_reason) {
        (Some(e), _) => {
            out.push_str(&format!(
                "Ellipse 95%  semi-major {:.1} m, semi-minor {:.1} m, orientation {:.1} deg \
                 clockwise from north\n",
                e.semi_major_m, e.semi_minor_m, e.orientation_deg
            ));
            // The model string is printed verbatim: it is the honest label on the number.
            out.push_str(&format!("             model: {}\n", e.model));
        }
        (None, Some(reason)) => {
            out.push_str(&format!("Ellipse 95%  not reported: {reason}\n"));
        }
        (None, None) => {
            out.push_str("Ellipse 95%  not reported, and no reason was given\n");
        }
    }
    if let Some(b) = fix.shared_bias_arcmin {
        out.push_str(&format!(
            "Shared bias  {b:+.3}' estimated as a third unknown and removed from every \
             residual\n"
        ));
    }
    if let Some(p) = &fix.posterior_scaled {
        out.push_str(&format!(
            "Posterior    s^2 = chi2/dof = {:.4}, scaled sigma north {:.1} m, east {:.1} m\n",
            p.scale_factor_s2,
            p.covariance_ne_m2[0][0].max(0.0).sqrt(),
            p.covariance_ne_m2[1][1].max(0.0).sqrt()
        ));
        if let Some(e) = &p.ellipse95 {
            out.push_str(&format!(
                "             scaled ellipse semi-major {:.1} m, semi-minor {:.1} m\n",
                e.semi_major_m, e.semi_minor_m
            ));
        }
    }
    out.push_str(&format!(
        "Fit          chi2 {:.4} on {} degree(s) of freedom, {} after {} iteration(s)\n",
        fix.chi2,
        fix.dof,
        if fix.converged {
            "converged"
        } else {
            "NOT converged"
        },
        fix.iterations
    ));

    out.push_str("\nResiduals\n");
    out.push_str(&format!(
        "  {}{}{:>12}{:>9}{:>9}{:>8}{:>8}{:>14}\n",
        report::pad("id", 10),
        report::pad("body", 18),
        "Hc deg",
        "Zn deg",
        "resid '",
        "norm",
        "weight",
        "intercept NM"
    ));
    for r in &fix.residuals {
        out.push_str(&format!(
            "  {}{}{:>12.6}{:>9.1}{:>9.2}{:>8.2}{:>8.2}{:>14.2}\n",
            report::pad(&r.id, 10),
            report::pad(&r.body, 18),
            r.hc_deg,
            r.zn_deg,
            r.residual_arcmin,
            r.normalized,
            r.weight,
            r.intercept_nm
        ));
    }

    out.push_str("\nConditioning\n");
    out.push_str(&format!(
        "  condition number {:.2}, rank {} of {} ({}), max azimuth gap {:.1} deg, dilution \
         {:.1} m per arcminute\n",
        fix.conditioning.condition_number,
        fix.conditioning.rank,
        if options.estimate_shared_bias { 3 } else { 2 },
        if fix.conditioning.columns.is_empty() {
            "position (north, east)"
        } else {
            &fix.conditioning.columns
        },
        fix.conditioning.max_azimuth_gap_deg,
        fix.conditioning.geometric_dilution_m_per_arcmin
    ));
    for line in report::wrap(&conditioning_sentence(&fix.conditioning), 86, "  ") {
        out.push_str(&line);
        out.push('\n');
    }

    if let Some(p) = &fix.prior {
        out.push_str("\nPrior\n");
        out.push_str(&format!(
            "  centre {} ({}), 1-sigma {} NM\n",
            report::format_position(p.center),
            report::format_position_decimal(p.center),
            p.sigma_nm
        ));
        match p.fix_without_prior {
            Some(w) => out.push_str(&format!(
                "  without the prior the observations alone give {} ({})\n",
                report::format_position(w),
                report::format_position_decimal(w)
            )),
            None => out.push_str(
                "  the observations alone do not give a fix, so the prior is doing the work\n",
            ),
        }
        out.push_str(&format!("  the prior moved the fix {:.1} m\n", p.shift_m));
    }

    if let Some(r) = &fix.robust {
        out.push_str("\nRobust weighting\n");
        out.push_str(&format!("  Huber k = {}\n", r.huber_k));
        if r.downweighted_ids.is_empty() {
            out.push_str("  no sight was downweighted\n");
        } else {
            out.push_str(&format!(
                "  downweighted: {}\n",
                r.downweighted_ids.join(", ")
            ));
        }
        for line in report::wrap(&r.note, 86, "  ") {
            out.push_str(&line);
            out.push('\n');
        }
    }
}

fn render_candidate(n: usize, c: &FixCandidate, out: &mut String) {
    out.push_str(&format!("Candidate {n}\n"));
    out.push_str(&format!(
        "  Position  {}\n            {}\n",
        report::format_position_decimal(c.position),
        report::format_position(c.position)
    ));
    let bias = match c.shared_bias_arcmin {
        Some(b) => format!(", shared bias {b:+.3}'"),
        None => String::new(),
    };
    out.push_str(&format!(
        "  chi2 {:.4}, delta chi2 from best {:.4}, {} after {} iteration(s){bias}\n",
        c.chi2,
        c.delta_chi2_from_best,
        if c.converged {
            "converged"
        } else {
            "NOT converged"
        },
        c.iterations
    ));
}

fn render_circles(circles: &[CircleOfPosition], out: &mut String) {
    if circles.is_empty() {
        return;
    }
    out.push_str("\nCircles of position\n");
    for c in circles {
        out.push_str(&format!(
            "  {}  {}  GP {} ({})  zenith distance {:.4} deg, radius {:.1} NM\n",
            c.id,
            c.body,
            report::format_position(c.gp),
            report::format_position_decimal(c.gp),
            c.zenith_distance_deg,
            c.zenith_distance_deg * 60.0
        ));
    }
}

/// Why `--require-unique` is not satisfied, or `None` when it is.
///
/// A unique fix whose ellipse was suppressed is not a single position a script may act
/// on: the ellipse is withheld exactly when the geometry is rank-deficient, effectively
/// singular, or the iteration did not converge (CONVENTIONS section 9), and in every one
/// of those cases the position is a number without an uncertainty to go with it.
/// `--require-unique` therefore demands both.
pub fn not_a_usable_single_position(result: &FixResult) -> Option<String> {
    match result {
        FixResult::Unique { fix, .. } => {
            if fix.ellipse95.is_some() {
                return None;
            }
            let reason = fix
                .ellipse_suppressed_reason
                .clone()
                .unwrap_or_else(|| "no reason was recorded".to_string());
            Some(format!(
                "the fix carries no 95 % ellipse, so it is a position with no stated \
                 uncertainty: {reason}"
            ))
        }
        _ => Some("the result is not a unique fix.".to_string()),
    }
}

/// What would settle an ambiguity, in the terms a navigator can act on.
const AMBIGUITY_REMEDY: &str = "Every candidate fits the sights about equally well, so promoting one of them would be \
     false precision. One more sight of a body 60 to 120 degrees away in azimuth from those \
     already used would separate them, and so would any independent knowledge of position good \
     to less than the distance between the candidates — declared as a prior, so that the \
     reported uncertainty includes it.";

/// The headline sentence, which is printed unwrapped, and the paragraph that follows it.
///
/// The headline is deliberately short enough to survive on one line: it is the finding,
/// and a line break through the middle of it would make the output harder to read and
/// harder to search.
fn underdetermined_sentences(circles: usize) -> (&'static str, &'static str) {
    if circles == 0 {
        // No "circle above": nothing was printed, so nothing may be referred to.
        (
            "Geometrically: there is nothing here to place you.",
            "No sight survived reduction, so there is not even a circle of position to draw. \
             The rejections are named above; fix those and solve again.",
        )
    } else if circles == 1 {
        (
            "Geometrically: one sight constrains you to a circle, not a point.",
            "Every position on the circle above fits the observation exactly as well as every \
             other, so there is no position to report and none is reported. A second body, at \
             an azimuth well away from the first, is what turns a circle into a pair of points.",
        )
    } else {
        (
            "Geometrically: these sights constrain you to a line, not a point.",
            "Their circles of position are parallel or tangent where they meet, so moving along \
             that line changes no predicted altitude enough to notice. A body at a different \
             azimuth is what breaks it.",
        )
    }
}

/// One plain sentence about the geometry, keyed off the same thresholds the core uses
/// to decide that a geometry is poor.
fn conditioning_sentence(c: &Conditioning) -> String {
    let dilution = c.geometric_dilution_m_per_arcmin;
    if uncertainty::is_poor_geometry(c) {
        format!(
            "Each arcminute of altitude error moves this fix about {dilution:.0} m, and with a \
             {:.0} degree gap between sight azimuths the geometry is poor: the sights are bunched \
             to one side, so the position across that gap rests on very little.",
            c.max_azimuth_gap_deg
        )
    } else {
        format!(
            "Each arcminute of altitude error moves this fix about {dilution:.0} m, and the \
             largest gap between sight azimuths is {:.0} degrees, which is a usable spread.",
            c.max_azimuth_gap_deg
        )
    }
}

/// A one-line note naming any ephemeris provider that was actually consulted, so the
/// caller knows the answer depends on a model and not only on the file.
pub fn provider_note(reduced: &[skyfix_core::types::ReducedSight]) -> Option<Warning> {
    let name = reduced
        .iter()
        .find(|r| r.direction_source != reduce::SUPPLIED_DIRECTION_SOURCE)
        .map(|r| r.direction_source.clone())?;
    let coverage = provider::coverage_summary(&name)?;
    Some(Warning::EphemerisCoverageLimited {
        provider: name,
        coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::types::{Clock, ErrorEllipse, Instrument, Observer, SessionMeta};

    fn session_with(role: AssumedPositionRole, ap: Option<LatLon>, clock_s: f64) -> Session {
        Session {
            schema: skyfix_core::types::SESSION_SCHEMA.to_string(),
            meta: SessionMeta::default(),
            observer: Observer {
                assumed_position: ap,
                assumed_position_role: role,
                ..Observer::default()
            },
            instrument: Instrument::default(),
            clock: Clock {
                uncertainty_s: clock_s,
                correction_s: 0.0,
                dut1_s: None,
            },
            observations: Vec::new(),
        }
    }

    const AP: LatLon = LatLon {
        lat_deg: 40.0,
        lon_deg: -75.0,
    };

    #[test]
    fn initializer_role_never_becomes_a_prior() {
        let s = session_with(AssumedPositionRole::Initializer, Some(AP), 0.0);
        let o = build_options(&s, &Flags::default());
        assert_eq!(o.initializer, Some(AP));
        assert_eq!(o.prior, None);
    }

    #[test]
    fn prior_role_becomes_a_prior_and_not_an_initializer() {
        let s = session_with(AssumedPositionRole::Prior { sigma_nm: 20.0 }, Some(AP), 0.0);
        let o = build_options(&s, &Flags::default());
        assert_eq!(o.initializer, None);
        assert_eq!(
            o.prior,
            Some(PositionPrior {
                center: AP,
                sigma_nm: 20.0
            })
        );
    }

    #[test]
    fn disabled_role_contributes_nothing() {
        let s = session_with(AssumedPositionRole::Disabled, Some(AP), 0.0);
        let o = build_options(&s, &Flags::default());
        assert_eq!(o.initializer, None);
        assert_eq!(o.prior, None);
    }

    #[test]
    fn clock_uncertainty_comes_from_the_file_and_the_flag_overrides_it() {
        let s = session_with(AssumedPositionRole::Initializer, Some(AP), 0.5);
        assert_eq!(
            build_options(&s, &Flags::default()).clock_uncertainty_s,
            0.5
        );
        let flags = Flags {
            clock_sigma: Some(2.0),
            ..Flags::default()
        };
        assert_eq!(build_options(&s, &flags).clock_uncertainty_s, 2.0);
    }

    #[test]
    fn flags_override_the_file() {
        let s = session_with(AssumedPositionRole::Initializer, Some(AP), 0.0);
        let other = LatLon {
            lat_deg: 10.0,
            lon_deg: 20.0,
        };
        let flags = Flags {
            init: Some(other),
            prior: Some(PositionPrior {
                center: other,
                sigma_nm: 5.0,
            }),
            bias: true,
            robust: Some(2.0),
            posterior_scaling: true,
            no_multistart: true,
            grid_step: Some(4.0),
            ..Flags::default()
        };
        let o = build_options(&s, &flags);
        assert_eq!(o.initializer, Some(other));
        assert_eq!(o.prior.map(|p| p.sigma_nm), Some(5.0));
        assert!(o.estimate_shared_bias);
        assert_eq!(o.robust.map(|r| r.huber_k), Some(2.0));
        assert!(o.posterior_scaling);
        assert!(!o.multistart.enabled);
        assert_eq!(o.multistart.grid_step_deg, 4.0);
    }

    #[test]
    fn no_init_wins_over_the_file_but_loses_to_an_explicit_init() {
        let s = session_with(AssumedPositionRole::Initializer, Some(AP), 0.0);
        let flags = Flags {
            no_init: true,
            ..Flags::default()
        };
        assert_eq!(build_options(&s, &flags).initializer, None);
    }

    #[test]
    fn failed_and_underdetermined_lead_with_their_kind() {
        let failed = FixResult::Failed {
            reason: "nothing converged".into(),
            warnings: vec![],
        };
        let text = render(&failed, &SolveOptions::default());
        assert!(text.starts_with("FAILED\n"), "{text}");
        assert!(text.contains("nothing converged"), "{text}");

        let under = FixResult::Underdetermined {
            circles: vec![CircleOfPosition {
                id: "obs-1".into(),
                body: "Vega".into(),
                gp: AP,
                zenith_distance_deg: 30.0,
            }],
            reason: "1 usable sight".into(),
            warnings: vec![],
        };
        let text = render(&under, &SolveOptions::default());
        assert!(text.starts_with("UNDERDETERMINED\n"), "{text}");
        assert!(
            report::flatten(&text).contains("one sight constrains you to a circle, not a point"),
            "{text}"
        );
        assert!(text.contains("1800.0 NM"), "radius in NM missing: {text}");
    }

    /// With no circles there is no "circle above" to refer to, and the narrative must not
    /// invent one. This is what a session whose every sight was rejected produces.
    #[test]
    fn an_underdetermined_result_with_no_circles_promises_none() {
        let under = FixResult::Underdetermined {
            circles: vec![],
            reason: "no usable sights".into(),
            warnings: vec![],
        };
        let flat = report::flatten(&render(&under, &SolveOptions::default()));
        assert!(!flat.contains("circle above"), "{flat}");
        assert!(
            !flat.contains("one sight constrains you to a circle"),
            "{flat}"
        );
        assert!(flat.contains("not even a circle of position"), "{flat}");
    }

    /// A `Fix` may legally carry `ellipse95: None` with `ellipse_suppressed_reason` set
    /// (CONVENTIONS section 9), and the WASM adapter and UI can hand one over. A position
    /// with no stated uncertainty is not a single position a script may act on, so
    /// `--require-unique` refuses it and says which of its two conditions failed.
    #[test]
    fn require_unique_is_not_satisfied_by_a_fix_without_an_ellipse() {
        let with_ellipse = unique_result(Some(ErrorEllipse {
            semi_major_m: 100.0,
            semi_minor_m: 90.0,
            orientation_deg: 10.0,
            confidence: 0.95,
            model: skyfix_core::uncertainty::ELLIPSE_MODEL.to_string(),
        }));
        assert_eq!(not_a_usable_single_position(&with_ellipse), None);

        let without = unique_result(None);
        let why = not_a_usable_single_position(&without).expect("must refuse");
        assert!(why.contains("no 95 % ellipse"), "{why}");
        assert!(why.contains("effectively singular"), "{why}");

        // The other kinds are refused as before.
        for other in [
            FixResult::Failed {
                reason: "x".into(),
                warnings: vec![],
            },
            FixResult::Underdetermined {
                circles: vec![],
                reason: "x".into(),
                warnings: vec![],
            },
            FixResult::Ambiguous {
                candidates: vec![],
                circles: vec![],
                warnings: vec![],
            },
        ] {
            assert!(
                not_a_usable_single_position(&other)
                    .is_some_and(|w| w.contains("not a unique fix"))
            );
        }
    }

    /// A `unique` result carrying `ellipse`, for the predicate above.
    fn unique_result(ellipse: Option<ErrorEllipse>) -> FixResult {
        let suppressed = ellipse.is_none().then(|| {
            "condition number 1.430e8 is at or beyond 1e6: the geometry is effectively \
             singular"
                .to_string()
        });
        FixResult::Unique {
            fix: skyfix_core::types::Fix {
                position: AP,
                shared_bias_arcmin: None,
                covariance_ne_m2: [[1.0, 0.0], [0.0, 1.0]],
                sigma_north_m: 1.0,
                sigma_east_m: 1.0,
                clock_sigma_east_m: 0.0,
                ellipse95: ellipse,
                ellipse_suppressed_reason: suppressed,
                posterior_scaled: None,
                residuals: vec![],
                chi2: 0.0,
                dof: 1,
                conditioning: skyfix_core::types::Conditioning {
                    singular_values: vec![1.0, 1.0],
                    condition_number: 1.0,
                    rank: 2,
                    geometric_dilution_m_per_arcmin: 1852.0,
                    max_azimuth_gap_deg: 90.0,
                    columns: "position (north, east)".to_string(),
                },
                iterations: 3,
                converged: true,
                prior: None,
                robust: None,
            },
            alternatives: vec![],
            circles: vec![],
            warnings: vec![],
        }
    }
}
