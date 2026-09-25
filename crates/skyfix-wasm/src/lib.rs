//! WASM adapter. OWNER: web agent. Thin: parse JSON in, call the core, JSON out.
//!
//! Every export below is backed by real code. Nothing here is stubbed and nothing here
//! falls back to an approximation: a call that cannot be answered returns an `Err`
//! carrying the core's own message.
//!
//! JSON crossing this boundary is exactly `serde_json`'s encoding of the owning crate's
//! types (`Serializer::json_compatible`, so `None` is `null`, not `undefined`):
//!
//! - sessions, reductions, fixes and warnings: `skyfix_core::types`;
//! - scenarios, truth and experiment summaries: `skyfix_sim::{scenario, experiment}`;
//! - coverage: `skyfix_ephemeris::Coverage`.
//!
//! Degrees / arcminutes / metres / seconds on the wire (CONVENTIONS section 1).
//!
//! ## Astronomy
//!
//! `ephemeris_mode = "supplied"` honours only the direction written into an observation.
//! `"auto"` uses that when present and otherwise asks [`auto_provider`]:
//! `skyfix_ephemeris::fixture_pack::CompositeProvider` holding the `SunProvider`, the
//! `MoonProvider`, the `SightPlanetProvider` (Venus, Mars, Jupiter, Saturn; Venus at its
//! centre of light) and the `StarProvider`, in that order. `coverage()` reports each of
//! them separately.

// Explorer exports, one module per feature so parallel work never collides here
// (docs/EXPLORER_PLAN.md section 4). Wire formats: docs/EXPLORER_API.md.
pub mod almanac;
pub mod eclipses;
pub mod explorer;
// Expansion programme (geomag agent): magnetic field and compass error.
pub mod geomag;
pub mod misfit;
pub mod nav;
pub mod navsky;
// Optional data packs: header, registry and dispatcher (packs agent; EXPLORER_API "Packs").
pub mod packs;
pub mod planet_events;
pub mod starfield;
// Expansion programme, wave 1 (docs/EXPANSION_PLAN.md section 5): one module per agent.
pub mod timescale;
// Expansion programme (deeptime agent): coverage tiers, `explorer_coverage` and `tier_at`.
pub mod coverage;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use skyfix_core::types::{FixResult, Session, SolveOptions, Warning};
use skyfix_ephemeris::AstroProvider;
use skyfix_sim::scenario::Scenario;

// ---------------------------------------------------------------------------
// Boundary helpers
// ---------------------------------------------------------------------------

/// Serialise with JSON-compatible semantics: `Option::None` -> `null`, maps -> objects.
/// Without this, `serde_wasm_bindgen` emits `undefined` for `None` and the UI cannot
/// tell "suppressed ellipse" from "field absent".
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let ser = serde_wasm_bindgen::Serializer::json_compatible();
    value
        .serialize(&ser)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

fn err(msg: impl AsRef<str>) -> JsValue {
    JsValue::from_str(msg.as_ref())
}

/// Install the panic hook. Call once, before anything else. Idempotent.
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// `skyfix-core` crate version.
#[wasm_bindgen]
pub fn version() -> String {
    skyfix_core::VERSION.to_string()
}

// ---------------------------------------------------------------------------
// Astronomy: every provider this build has, behind one AstroProvider
// ---------------------------------------------------------------------------

/// The astronomy `ephemeris_mode = "auto"` uses: the computed Sun, the Moon, the four
/// navigational planets (Venus at its centre of light, CONVENTIONS section 5) and the
/// star catalogue. `CompositeProvider` reports the most informative failure when none of
/// them can answer, so "this provider stops in 2060" wins over "nobody has that body",
/// and "Mercury is not offered for sights" wins over both.
pub fn auto_provider() -> skyfix_ephemeris::fixture_pack::CompositeProvider {
    skyfix_ephemeris::fixture_pack::CompositeProvider::new(
        "skyfix-auto (Sun, Moon, planets, stars)",
    )
    .with(skyfix_ephemeris::sun::SunProvider::new())
    .with(skyfix_ephemeris::moon::MoonProvider::new())
    .with(skyfix_ephemeris::sights::SightPlanetProvider::new())
    .with(skyfix_ephemeris::stars::StarProvider::new())
}

/// The bodies the planner ranks: the Moon, the navigational planets and the stars, each
/// only when its provider is validated for sights (`skyfix_ephemeris::sights`). The Sun
/// is not a candidate — it is the thing that decides whether the stars are visible at
/// all.
fn planner_bodies() -> Vec<String> {
    skyfix_ephemeris::sights::sight_bodies()
        .into_iter()
        .filter(|b| *b != skyfix_ephemeris::body::SUN)
        .map(str::to_string)
        .collect()
}

/// The direction source `reduce` and `solve` use for a given `ephemeris_mode`.
///
/// Both modes honour a supplied `geocentric` first: that is decided inside
/// `skyfix_core::reduce::reduce_observation`, not here. The `auto` providers take the
/// session's DUT1 (`clock.dut1_s`; moonshape, expansion programme: `nav::session_source`).
fn direction_source(
    mode: &str,
    session: &Session,
) -> Result<Box<dyn skyfix_core::reduce::DirectionSource>, JsValue> {
    nav::session_source(mode, session).map_err(err)
}

// ---------------------------------------------------------------------------
// Wire shapes owned by this adapter
// ---------------------------------------------------------------------------

/// `parse_session` result: `{ "session": Session, "warnings": [Warning] }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedSession {
    pub session: Session,
    pub warnings: Vec<Warning>,
}

/// One element of the `reduce` array. A rejected sight does not abort the batch.
///
/// `{"status":"ok","sight":{...ReducedSight}}` or
/// `{"status":"error","id":"obs-3","message":"..."}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReduceEntry {
    Ok {
        sight: Box<skyfix_core::types::ReducedSight>,
    },
    Error {
        id: String,
        message: String,
    },
}

/// `simulate` result. Truth is a *sibling* of the session, never inside it
/// (CONVENTIONS section 11; BRIEF "Simulator").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationOutput {
    pub session: Session,
    pub truth: skyfix_core::types::Truth,
}

/// One packaged demo: the simulator's own scenario, with its own name and description.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemoEntry {
    pub name: String,
    pub description: String,
    /// True when the scenario names real bodies, so `simulate` needs the provider.
    pub requires_provider: bool,
    pub scenario: Scenario,
}

/// What `coverage()` reports: one entry per offline astronomy provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageReport {
    pub providers: Vec<ProviderCoverage>,
    /// Which `ephemeris_mode` strings `reduce` accepts in this build.
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCoverage {
    pub provider: String,
    pub start_utc: String,
    pub end_utc: String,
    pub bodies: Vec<String>,
    pub notes: String,
    pub accuracy_arcmin: f64,
}

/// Repetition cap for [`experiment`]. The solver runs on the browser's main thread, so
/// an unbounded repetition count would freeze the tab rather than produce a result.
pub const MAX_REPETITIONS: u32 = 1000;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Parse + validate a session document. Returns `{session, warnings}`.
///
/// A body this build's providers do not know is reported as a warning, not an error:
/// the observation may still carry its own direction, and the Observations view must be
/// able to load a half-finished file rather than refusing it.
#[wasm_bindgen]
pub fn parse_session(json: &str) -> Result<JsValue, JsValue> {
    let (session, mut warnings) =
        skyfix_core::session::parse_session(json).map_err(|e| err(e.to_string()))?;
    let known = auto_provider().coverage().bodies;
    let known_refs: Vec<&str> = known.iter().map(String::as_str).collect();
    match skyfix_core::session::validate(&session, &known_refs) {
        Ok(more) => {
            for w in more {
                if !warnings.contains(&w) {
                    warnings.push(w);
                }
            }
        }
        Err(e) => warnings.push(Warning::Other {
            message: format!(
                "{e}. The session loaded anyway; supply a geocentric direction for that \
                 observation, or correct the body name."
            ),
        }),
    }
    to_js(&ParsedSession { session, warnings })
}

/// Reduce every observation in a session.
///
/// `ephemeris_mode`:
/// - `"supplied"` — only `observation.geocentric` is honoured (the "first numerical
///   slice"); a sight without one is reported as an error entry.
/// - `"auto"` — supplied direction wins, otherwise the bundled offline provider.
///
/// Returns an array of [`ReduceEntry`], one per observation, in input order.
#[wasm_bindgen]
pub fn reduce(session_json: &str, ephemeris_mode: &str) -> Result<JsValue, JsValue> {
    let (session, _warnings) =
        skyfix_core::session::parse_session(session_json).map_err(|e| err(e.to_string()))?;
    let source = direction_source(ephemeris_mode, &session)?;
    let entries: Vec<ReduceEntry> = skyfix_core::reduce::reduce_session(&session, source.as_ref())
        .into_iter()
        .zip(session.observations.iter())
        .map(|(result, obs)| match result {
            Ok(sight) => ReduceEntry::Ok {
                sight: Box::new(sight),
            },
            Err(e) => ReduceEntry::Error {
                id: obs.id.clone(),
                message: e.to_string(),
            },
        })
        .collect();
    to_js(&entries)
}

/// Derive the initializer and the prior from the session when the options leave them
/// unset. `SolveOptions.prior` wins over `assumed_position_role = prior`
/// (`skyfix_core::types::SolveOptions`), and a `prior` is never silently promoted from
/// an `initializer`.
fn apply_session_position(session: &Session, options: &mut SolveOptions) {
    use skyfix_core::types::{AssumedPositionRole, PositionPrior};
    let Some(centre) = session.observer.assumed_position else {
        return;
    };
    match session.observer.assumed_position_role {
        AssumedPositionRole::Initializer => {
            if options.initializer.is_none() {
                options.initializer = Some(centre);
            }
        }
        AssumedPositionRole::Prior { sigma_nm } => {
            if options.prior.is_none() {
                options.prior = Some(PositionPrior {
                    center: centre,
                    sigma_nm,
                });
            }
            if options.initializer.is_none() {
                options.initializer = Some(centre);
            }
        }
        AssumedPositionRole::Disabled => {}
    }
}

/// Solve a fix. `options_json` is a `skyfix_core::types::SolveOptions` document; every
/// field has a serde default, so `"{}"` is a valid document meaning "all defaults".
/// Returns a `FixResult`.
#[wasm_bindgen]
pub fn solve(
    session_json: &str,
    options_json: &str,
    ephemeris_mode: &str,
) -> Result<JsValue, JsValue> {
    let (session, _warnings) =
        skyfix_core::session::parse_session(session_json).map_err(|e| err(e.to_string()))?;
    let trimmed = options_json.trim();
    let mut options: SolveOptions = if trimmed.is_empty() {
        SolveOptions::default()
    } else {
        serde_json::from_str(trimmed).map_err(|e| err(format!("solve options: {e}")))?
    };
    apply_session_position(&session, &mut options);
    if options.clock_uncertainty_s == 0.0 {
        options.clock_uncertainty_s = session.clock.uncertainty_s;
    }

    let source = direction_source(ephemeris_mode, &session)?;
    let (reduced, rejected) =
        skyfix_core::reduce::reduce_session_partitioned(&session, source.as_ref());
    if reduced.is_empty() {
        let reason = if rejected.is_empty() {
            "the session has no observations".to_string()
        } else {
            format!(
                "every observation was rejected before the solver: {}",
                rejected
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        };
        return to_js(&FixResult::Failed {
            reason,
            warnings: vec![],
        });
    }
    let sights = skyfix_core::reduce::to_sights(&reduced, source.as_ref());
    let mut result = skyfix_core::solver::solve(&sights, &options);
    // A sight the reducer threw out never reaches the solver, so the solver cannot warn
    // about it. Carry those failures onto the result rather than dropping them.
    if !rejected.is_empty() {
        let extra: Vec<Warning> = rejected
            .iter()
            .map(|e| Warning::Other {
                message: format!("{e}. This sight was not used in the fix."),
            })
            .collect();
        let warnings = match &mut result {
            FixResult::Underdetermined { warnings, .. }
            | FixResult::Ambiguous { warnings, .. }
            | FixResult::Unique { warnings, .. }
            | FixResult::Failed { warnings, .. } => warnings,
        };
        warnings.extend(extra);
    }
    to_js(&result)
}

/// `n` points around the circle of position of angular radius `zenith_distance_deg`
/// about the body's geographic position, as `[[lat_deg, lon_deg], ...]`, starting due
/// north of the GP and running clockwise. Longitudes are in `(-180, 180]`, so a circle
/// crossing the antimeridian produces a jump the caller must split on.
#[wasm_bindgen]
pub fn circle_points(lat_gp: f64, lon_gp: f64, zenith_distance_deg: f64, n: usize) -> JsValue {
    let gp = skyfix_core::geometry::Point::from_deg(lat_gp, lon_gp);
    let points: Vec<[f64; 2]> =
        skyfix_core::geometry::circle_of_position(gp, zenith_distance_deg.to_radians(), n.max(3))
            .into_iter()
            .map(|p| [p.lat_deg(), p.lon_deg()])
            .collect();
    to_js(&points).unwrap_or(JsValue::NULL)
}

/// Generate a simulated session and its truth from a `skyfix_sim::scenario::Scenario`.
/// Returns `{session, truth}`. The truth is never written into the session
/// (BRIEF "Simulator"; docs/SIMULATOR.md).
#[wasm_bindgen]
pub fn simulate(scenario_json: &str) -> Result<JsValue, JsValue> {
    let scenario: Scenario =
        serde_json::from_str(scenario_json).map_err(|e| err(format!("scenario: {e}")))?;
    scenario.check().map_err(err)?;
    let provider = auto_provider();
    let (session, truth) =
        skyfix_sim::generate::simulate(&scenario, Some(&provider)).map_err(err)?;
    to_js(&SimulationOutput { session, truth })
}

/// The packaged demonstrations, in demo order, each with the simulator's own name and
/// plain-language description. `skyfix_sim::demos::all` leaves out the scenario that
/// needs an astronomy provider and the raw-sextant variant; both are included here,
/// next to the demo they belong to, and flagged.
#[wasm_bindgen]
pub fn demos() -> JsValue {
    let mut entries: Vec<DemoEntry> = Vec::new();
    let mut push = |scenario: Scenario, requires_provider: bool| {
        entries.push(DemoEntry {
            name: scenario.name.clone(),
            description: scenario.description.clone(),
            requires_provider,
            scenario,
        });
    };
    let all = skyfix_sim::demos::all();
    let mut iter = all.into_iter();
    if let Some(first) = iter.next() {
        push(first, false);
        push(skyfix_sim::demos::philadelphia_stars_named(), true);
        push(skyfix_sim::demos::philadelphia_stars_sextant(), false);
    }
    for scenario in iter {
        push(scenario, false);
    }
    to_js(&entries).unwrap_or(JsValue::NULL)
}

/// Run a `skyfix_sim::experiment::Experiment` (a scenario, solve options and a
/// repetition count) and return its `ExperimentSummary`: every run, plus the aggregate
/// with the coverage fraction and its Wilson interval.
///
/// The solver runs on this thread, so the repetition count is capped at
/// [`MAX_REPETITIONS`].
#[wasm_bindgen]
pub fn experiment(experiment_json: &str) -> Result<JsValue, JsValue> {
    let exp: skyfix_sim::experiment::Experiment =
        serde_json::from_str(experiment_json).map_err(|e| err(format!("experiment: {e}")))?;
    exp.check().map_err(err)?;
    if exp.repetitions > MAX_REPETITIONS {
        return Err(err(format!(
            "repetitions {} exceeds the browser cap of {MAX_REPETITIONS}: the solver runs \
             on this thread and would stop the page responding",
            exp.repetitions
        )));
    }
    let provider = auto_provider();
    let summary = skyfix_sim::experiment::run(&exp, Some(&provider));
    to_js(&summary)
}

/// Body names the UI offers in the observation body field: the Sun, the Moon, Venus,
/// Mars, Jupiter and Saturn, then every star the compiled catalogue answers to, in
/// catalogue order — every body validated for sights (`skyfix_ephemeris::sights`). The
/// field still accepts any name typed into it, and a supplied `geocentric` direction
/// makes any name work.
#[wasm_bindgen]
pub fn catalog() -> JsValue {
    let mut names = vec!["Sun".to_string()];
    names.extend(planner_bodies());
    to_js(&names).unwrap_or(JsValue::NULL)
}

/// Offline astronomy coverage, one record per provider, verbatim for the About view.
/// No network, ever.
#[wasm_bindgen]
pub fn coverage() -> JsValue {
    let providers: Vec<ProviderCoverage> = [
        Box::new(skyfix_ephemeris::sun::SunProvider::new()) as Box<dyn AstroProvider>,
        Box::new(skyfix_ephemeris::moon::MoonProvider::new()) as Box<dyn AstroProvider>,
        Box::new(skyfix_ephemeris::sights::SightPlanetProvider::new()) as Box<dyn AstroProvider>,
        Box::new(skyfix_ephemeris::stars::StarProvider::new()) as Box<dyn AstroProvider>,
    ]
    .iter()
    .map(|p| {
        let c = p.coverage();
        ProviderCoverage {
            provider: p.name().to_string(),
            start_utc: c.start_utc,
            end_utc: c.end_utc,
            bodies: c.bodies,
            notes: c.notes,
            accuracy_arcmin: c.accuracy_arcmin,
        }
    })
    .collect();
    to_js(&CoverageReport {
        providers,
        modes: vec!["supplied".to_string(), "auto".to_string()],
    })
    .unwrap_or(JsValue::NULL)
}

/// Rank the bodies worth observing from an APPROXIMATE position at a given time.
///
/// `position_json` is a `skyfix_core::types::LatLon`; `options_json` is a
/// `skyfix_core::planner::PlanOptions` (every field defaults, so `"{}"` is valid).
/// Returns a `skyfix_core::planner::Plan`.
///
/// The planner needs a position to predict from, and every plan it returns names the
/// position it assumed (docs/PLANNER.md). That approximate position is a planning input
/// only: it never becomes a prior on a fix.
///
/// The Sun altitude that decides the twilight flag is computed here from the same
/// `SunProvider` the reducer would use, rather than being left to the caller.
#[wasm_bindgen]
pub fn plan(position_json: &str, utc: &str, options_json: &str) -> Result<JsValue, JsValue> {
    let position: skyfix_core::types::LatLon =
        serde_json::from_str(position_json).map_err(|e| err(format!("position: {e}")))?;
    let trimmed = options_json.trim();
    let options: skyfix_core::planner::PlanOptions = if trimmed.is_empty() {
        Default::default()
    } else {
        serde_json::from_str(trimmed).map_err(|e| err(format!("plan options: {e}")))?
    };
    // DUT1 through the single lookup at the plan's instant (moonshape, expansion
    // programme): the engine's own value, there being no session here.
    let dut1_s = skyfix_core::time::parse_utc(utc)
        .map(|jd| skyfix_core::time::dut1_s(jd, None))
        .unwrap_or(0.0);
    let provider = nav::auto_provider_with_dut1(dut1_s);
    let sun_altitude_deg = sun_altitude(&provider, position, utc);
    let plan = skyfix_ephemeris::visibility::plan_at(
        &provider,
        &planner_bodies(),
        position,
        utc,
        &options,
        sun_altitude_deg,
    )
    .map_err(|e| err(e.to_string()))?;
    to_js(&plan)
}

/// Geometric altitude of the Sun at `position` and `utc`, or `None` when the Sun cannot
/// be resolved there (outside coverage, say). Refraction is not applied: the twilight
/// thresholds are defined on the geometric altitude.
fn sun_altitude(
    provider: &dyn AstroProvider,
    position: skyfix_core::types::LatLon,
    utc: &str,
) -> Option<f64> {
    let jd = skyfix_core::time::parse_utc(utc).ok()?;
    let d = provider.geocentric("Sun", jd).ok()?;
    let observer = skyfix_core::geometry::Point::from_deg(position.lat_deg, position.lon_deg);
    let (h, _zn) = skyfix_core::geometry::altitude_azimuth(
        observer,
        d.gha_deg.to_radians(),
        d.dec_deg.to_radians(),
    );
    Some(h.to_degrees())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_the_compiled_star_list() {
        let names = skyfix_ephemeris::catalog::names();
        assert!(names.len() >= 57, "only {} stars", names.len());
        assert!(names.contains(&"Vega"));
        assert!(names.contains(&"Polaris"));
    }

    #[test]
    fn the_auto_provider_answers_both_the_sun_and_the_stars() {
        let p = auto_provider();
        let jd = 2_461_314.562_5; // 2026-10-01T01:30Z
        assert!(p.geocentric("Vega", jd).is_ok(), "no Vega");
        assert!(p.geocentric("Sun", jd).is_ok(), "no Sun");
        let e = p.geocentric("Ceres", jd).unwrap_err();
        assert!(e.to_string().contains("Ceres"), "unhelpful message: {e}");
    }

    #[test]
    fn the_catalogue_offered_to_the_body_field_starts_with_the_sun() {
        let mut names = vec!["Sun".to_string()];
        names.extend(planner_bodies());
        assert_eq!(names[0], "Sun");
        assert!(names.contains(&"Polaris".to_string()));
        assert!(names.len() >= 58, "only {} bodies", names.len());
    }

    #[test]
    fn the_planner_ranks_stars_and_reports_the_position_it_assumed() {
        let position = skyfix_core::types::LatLon {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
        };
        let provider = auto_provider();
        let utc = "2026-10-01T01:30:00Z";
        let sun = sun_altitude(&provider, position, utc).expect("a Sun altitude");
        assert!(
            sun < 0.0,
            "the demo evening should be after sunset, got {sun}"
        );
        let plan = skyfix_ephemeris::visibility::plan_at(
            &provider,
            &planner_bodies(),
            position,
            utc,
            &Default::default(),
            Some(sun),
        )
        .unwrap();
        assert_eq!(plan.approximate_position, position);
        assert!(!plan.bodies.is_empty(), "nothing was ranked");
        assert!(
            !plan.notes.is_empty(),
            "a plan must disclose its assumptions"
        );
    }

    #[test]
    fn every_demo_scenario_passes_its_own_check() {
        for scenario in skyfix_sim::demos::all() {
            scenario
                .check()
                .unwrap_or_else(|e| panic!("{}: {e}", scenario.name));
        }
        skyfix_sim::demos::philadelphia_stars_named()
            .check()
            .unwrap();
        skyfix_sim::demos::philadelphia_stars_sextant()
            .check()
            .unwrap();
    }

    #[test]
    fn the_named_star_demo_resolves_against_the_compiled_catalogue() {
        let provider = auto_provider();
        let scenario = skyfix_sim::demos::philadelphia_stars_named();
        let (session, truth) = skyfix_sim::generate::simulate(&scenario, Some(&provider))
            .expect("the star provider should cover the demo evening");
        assert_eq!(session.observations.len(), 6);
        assert_eq!(truth.position, scenario.truth);
        // The session may *say* that a DR position is derived from the truth — the
        // simulator discloses that in words — but no truth coordinate may appear in it.
        let json = serde_json::to_string(&session).unwrap();
        for number in [
            format!("{}", scenario.truth.lat_deg),
            format!("{}", scenario.truth.lon_deg),
        ] {
            assert!(
                !json.contains(&number),
                "the session leaks the truth coordinate {number}"
            );
        }
        assert!(
            !json.contains(&format!("{}", scenario.seed)),
            "the session leaks the seed"
        );
    }

    #[test]
    fn a_default_solve_options_document_is_just_an_empty_object() {
        let options: SolveOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(options, SolveOptions::default());
    }

    #[test]
    fn solve_options_prior_wins_over_the_session_role() {
        use skyfix_core::types::{AssumedPositionRole, LatLon, PositionPrior};
        let mut session = Session {
            schema: skyfix_core::types::SESSION_SCHEMA.to_string(),
            meta: Default::default(),
            observer: Default::default(),
            instrument: Default::default(),
            clock: Default::default(),
            observations: vec![],
        };
        session.observer.assumed_position = Some(LatLon {
            lat_deg: 40.0,
            lon_deg: -75.0,
        });
        session.observer.assumed_position_role = AssumedPositionRole::Prior { sigma_nm: 20.0 };

        // Nothing set: the session's prior is adopted, and it also seeds the search.
        let mut derived = SolveOptions::default();
        apply_session_position(&session, &mut derived);
        assert_eq!(derived.prior.unwrap().sigma_nm, 20.0);
        assert!(derived.initializer.is_some());

        // Explicit option: left alone.
        let explicit = PositionPrior {
            center: LatLon {
                lat_deg: 0.0,
                lon_deg: 0.0,
            },
            sigma_nm: 3.0,
        };
        let mut given = SolveOptions {
            prior: Some(explicit),
            ..Default::default()
        };
        apply_session_position(&session, &mut given);
        assert_eq!(given.prior.unwrap(), explicit);
    }

    #[test]
    fn an_initializer_is_never_promoted_to_a_prior() {
        use skyfix_core::types::{AssumedPositionRole, LatLon};
        let mut session = Session {
            schema: skyfix_core::types::SESSION_SCHEMA.to_string(),
            meta: Default::default(),
            observer: Default::default(),
            instrument: Default::default(),
            clock: Default::default(),
            observations: vec![],
        };
        session.observer.assumed_position = Some(LatLon {
            lat_deg: 40.0,
            lon_deg: -75.0,
        });
        session.observer.assumed_position_role = AssumedPositionRole::Initializer;
        let mut options = SolveOptions::default();
        apply_session_position(&session, &mut options);
        assert!(options.prior.is_none());
        assert!(options.initializer.is_some());
    }

    #[test]
    fn reduce_entry_is_tagged_by_status() {
        let e = ReduceEntry::Error {
            id: "obs-1".into(),
            message: "boom".into(),
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"status":"error","id":"obs-1","message":"boom"}"#
        );
    }
}

// Expansion programme, suntools agent (P7): golden and blue hour, azimuth search,
// alignments, analemma, sun path, equation of time, clear-sky energy, Milky Way windows.
// Wire format: docs/EXPLORER_API.md, "Expansion programme — sun tools".
pub mod suntools;
