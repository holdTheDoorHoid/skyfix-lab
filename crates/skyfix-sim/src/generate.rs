//! Turning a [`Scenario`] into a `Session` (what the estimator sees) and a `Truth`
//! (what it must never see).
//!
//! The separation is structural, not a matter of discipline: [`simulate`] returns two
//! documents, the truth position is only ever written into the second one, and nothing
//! in this crate passes a truth value into `SolveOptions`. `docs/SIMULATOR.md` states
//! the guarantee and the test `truth_never_appears_in_the_session` enforces it by
//! searching the serialised session for the truth coordinates and the seed.
//!
//! Sign conventions, restated here because they are the two easiest things to get
//! backwards:
//!
//! - `clock_offset_s = recorded_time - true_time`. A positive offset means the
//!   timestamps written into the session are **later** than the instants the sights
//!   were really taken at.
//! - `shared_altitude_bias_arcmin` is **added** to every true altitude. A positive bias
//!   means every sight reads too high.
//!
//! Every error knob is applied in `Ho` space, to the fully corrected altitude, so the
//! altitude the estimator ends up with is exactly
//! `Ho_true + bias + noise + blunder`. When the session emits raw sextant readings the
//! simulator then runs that `Ho` *backwards* through the correction chain
//! ([`crate::optics`]); a reducer running the chain forwards recovers the same `Ho`.

use skyfix_core::geometry;
use skyfix_core::time;
use skyfix_core::types::{
    AltitudeKind, AssumedPositionRole, Clock, GeocentricDirection, Instrument, LatLon, Limb,
    Observation, Observer, SESSION_SCHEMA, Session, SessionKind, SessionMeta, TRUTH_SCHEMA, Truth,
};
use skyfix_core::units::{nm_to_rad, norm_360, rad_to_deg};
use skyfix_ephemeris::AstroProvider;

use crate::optics;
use crate::rng::Rng;
use crate::scenario::{
    AlmanacLookup, AssumedPositionMode, BodySource, EmittedAltitude, GeometryPreset, Ordering,
    Scenario, WrongSight,
};

/// Everything one run of the simulator produced. `session` goes to the estimator;
/// `truth` and `sights` are for the evaluation view only.
#[derive(Debug, Clone)]
pub struct Simulation {
    pub session: Session,
    pub truth: Truth,
    /// One entry per **emitted** observation, in the same order.
    pub sights: Vec<TruthSight>,
}

/// The hidden state behind one emitted observation.
#[derive(Debug, Clone, PartialEq)]
pub struct TruthSight {
    pub id: String,
    pub body: String,
    /// The instant the sight was really taken (never written into the session).
    pub true_utc: String,
    pub true_jd_utc: f64,
    /// The timestamp the session records for it.
    pub recorded_utc: String,
    /// True altitude at the truth position and the true time, degrees.
    pub true_altitude_deg: f64,
    /// True azimuth at the truth position and the true time, degrees.
    pub true_azimuth_deg: f64,
    /// The independent noise draw for this sight, arcminutes.
    pub noise_arcmin: f64,
    /// The shared bias, arcminutes (identical for every sight).
    pub bias_arcmin: f64,
    /// The deliberate blunder, arcminutes (0 for every sight but at most one).
    pub blunder_arcmin: f64,
    /// `true_altitude_deg` plus every error above, in degrees. This is the `Ho` the
    /// estimator will reconstruct.
    pub emitted_ho_deg: f64,
}

impl TruthSight {
    /// Total altitude error of this sight, arcminutes.
    pub fn total_error_arcmin(&self) -> f64 {
        self.noise_arcmin + self.bias_arcmin + self.blunder_arcmin
    }
}

/// Generate a session and its truth document. `provider` is required only if the
/// scenario names real bodies; scenarios built from supplied directions need none.
pub fn simulate(
    scenario: &Scenario,
    provider: Option<&dyn AstroProvider>,
) -> Result<(Session, Truth), String> {
    let s = simulate_detailed(scenario, provider)?;
    Ok((s.session, s.truth))
}

/// As [`simulate`], but also returns the per-sight truth. Evaluation code uses this;
/// the estimator never does.
pub fn simulate_detailed(
    scenario: &Scenario,
    provider: Option<&dyn AstroProvider>,
) -> Result<Simulation, String> {
    scenario.check()?;
    let reported_sigma = scenario.effective_reported_sigma_arcmin()?;
    let jd_start = time::parse_utc(&scenario.start_utc)
        .map_err(|e| format!("scenario {:?}: start_utc: {e}", scenario.name))?;
    let truth_point = scenario.truth_point();

    let bodies = select_bodies(scenario, jd_start, provider)?;
    let n_bodies = bodies.len();
    let count = scenario.schedule.count;

    // --- the whole random stream, drawn in one documented order ---------------
    // 1. one normal per SCHEDULED sight, in schedule order, whether or not the
    //    scenario has any noise. Drawing unconditionally keeps a sight's noise the
    //    same when other knobs change.
    // 2. the drop permutation, only when something is actually dropped.
    let mut rng = Rng::new(scenario.seed);
    let noise_arcmin: Vec<f64> = (0..count)
        .map(|_| rng.normal() * scenario.altitude_noise_arcmin)
        .collect();
    let n_drop = ((count as f64) * scenario.missing_fraction).round() as usize;
    let n_drop = n_drop.min(count);
    let mut dropped = vec![false; count];
    if n_drop > 0 {
        let mut order: Vec<usize> = (0..count).collect();
        rng.shuffle(&mut order);
        for &i in &order[..n_drop] {
            dropped[i] = true;
        }
    }
    let kept: Vec<usize> = (0..count).filter(|i| !dropped[*i]).collect();
    if kept.is_empty() {
        return Err(format!(
            "scenario {:?}: missing_fraction {} dropped all {count} scheduled sights",
            scenario.name, scenario.missing_fraction
        ));
    }
    if let Some(w) = scenario.wrong_sight
        && w.index >= kept.len()
    {
        return Err(format!(
            "scenario {:?}: wrong_sight.index {} is out of range: only {} sights are emitted \
             (the index counts emitted sights, after missing_fraction has dropped any)",
            scenario.name,
            w.index,
            kept.len()
        ));
    }

    // --- emit ----------------------------------------------------------------
    let mut observations = Vec::with_capacity(kept.len());
    let mut sights = Vec::with_capacity(kept.len());
    let mut wrong_ids = Vec::new();

    for (emitted_index, &slot) in kept.iter().enumerate() {
        let source = &scenario.sources
            [bodies[body_for_slot(slot, count, n_bodies, scenario.schedule.ordering)]];
        let id = format!("obs-{}", emitted_index + 1);

        let jd_true = jd_start + slot as f64 * scenario.schedule.spacing_s / 86_400.0;
        let recorded_utc = format_utc_snapped(jd_true + scenario.clock_offset_s / 86_400.0);
        // Re-parse so the direction is evaluated at exactly the instant the session
        // records, not at a float that rounds to it. The difference is sub-millisecond.
        let jd_recorded = time::parse_utc(&recorded_utc).map_err(|e| {
            format!(
                "scenario {:?}: emitted timestamp {recorded_utc}: {e}",
                scenario.name
            )
        })?;

        let true_dir = direction_of(source, jd_true, jd_start, provider, &scenario.name)?;
        let (h_rad, zn_rad) = geometry::altitude_azimuth(
            truth_point,
            true_dir.gha_deg.to_radians(),
            true_dir.dec_deg.to_radians(),
        );
        let true_altitude_deg = rad_to_deg(h_rad);
        if true_altitude_deg < 0.0 {
            return Err(format!(
                "scenario {:?}: body {:?} is {:.2} deg BELOW the horizon at {} \
                 (a sight of it could not have been taken)",
                scenario.name,
                source.name(),
                -true_altitude_deg,
                format_utc_snapped(jd_true)
            ));
        }

        let blunder_arcmin = match scenario.wrong_sight {
            Some(WrongSight {
                index,
                error_arcmin,
            }) if index == emitted_index => {
                wrong_ids.push(id.clone());
                error_arcmin
            }
            _ => 0.0,
        };
        let bias_arcmin = scenario.shared_altitude_bias_arcmin;
        let noise = noise_arcmin[slot];
        let emitted_ho_deg = true_altitude_deg + (bias_arcmin + noise + blunder_arcmin) / 60.0;

        // The direction the session carries: looked up at the time the estimator
        // believes (the default), or at the true time as a control.
        let jd_lookup = match scenario.almanac_lookup {
            AlmanacLookup::RecordedTime => jd_recorded,
            AlmanacLookup::TrueTime => jd_true,
        };
        let emitted_dir =
            if matches!(source, BodySource::Supplied { .. }) || scenario.emit_supplied_directions {
                Some(direction_of(
                    source,
                    jd_lookup,
                    jd_start,
                    provider,
                    &scenario.name,
                )?)
            } else {
                None
            };

        let (altitude_deg, altitude_kind) = match scenario.altitude_kind {
            EmittedAltitude::ObservedHo => (emitted_ho_deg, AltitudeKind::ObservedHo),
            EmittedAltitude::SextantHs {
                height_of_eye_m,
                index_correction_arcmin,
                pressure_hpa,
                temperature_c,
            } => {
                let hs = optics::ho_to_hs(
                    emitted_ho_deg,
                    index_correction_arcmin,
                    height_of_eye_m,
                    pressure_hpa,
                    temperature_c,
                )
                .map_err(|e| {
                    format!(
                        "scenario {:?}: sight {id} of {:?}: reverse correction chain: {e}",
                        scenario.name,
                        source.name()
                    )
                })?;
                (hs, AltitudeKind::SextantHs)
            }
        };

        observations.push(Observation {
            id: id.clone(),
            body: source.name().to_string(),
            utc: recorded_utc.clone(),
            altitude_deg,
            altitude_kind,
            sigma_arcmin: reported_sigma,
            limb: Limb::Center,
            horizon: None,
            geocentric: emitted_dir,
            notes: String::new(),
        });
        sights.push(TruthSight {
            id,
            body: source.name().to_string(),
            true_utc: format_utc_snapped(jd_true),
            true_jd_utc: jd_true,
            recorded_utc,
            true_altitude_deg,
            true_azimuth_deg: norm_360(rad_to_deg(zn_rad)),
            noise_arcmin: noise,
            bias_arcmin,
            blunder_arcmin,
            emitted_ho_deg,
        });
    }

    let (assumed_position, assumed_note) = assumed_position_of(scenario);
    let (observer_height_m, pressure_hpa, temperature_c, index_correction_arcmin) =
        match scenario.altitude_kind {
            EmittedAltitude::ObservedHo => (0.0, 1010.0, 10.0, 0.0),
            EmittedAltitude::SextantHs {
                height_of_eye_m,
                index_correction_arcmin,
                pressure_hpa,
                temperature_c,
            } => (
                height_of_eye_m,
                pressure_hpa,
                temperature_c,
                index_correction_arcmin,
            ),
        };

    let session = Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta {
            name: scenario.name.clone(),
            notes: session_notes(scenario, &assumed_note),
            kind: SessionKind::Simulated,
        },
        observer: Observer {
            height_of_eye_m: observer_height_m,
            pressure_hpa,
            temperature_c,
            assumed_position,
            assumed_position_role: scenario.assumed_position.role,
        },
        instrument: Instrument {
            name: "simulated".to_string(),
            index_correction_arcmin,
            horizon: scenario.altitude_kind.horizon(),
            index_error_log: Vec::new(),
        },
        clock: Clock {
            uncertainty_s: scenario.reported_clock_uncertainty_s,
            correction_s: 0.0,
            dut1_s: None,
            watch_log: Vec::new(),
        },
        observations,
    };

    let truth = Truth {
        schema: TRUTH_SCHEMA.to_string(),
        session_name: scenario.name.clone(),
        position: scenario.truth,
        seed: scenario.seed,
        clock_offset_s: scenario.clock_offset_s,
        shared_altitude_bias_arcmin: scenario.shared_altitude_bias_arcmin,
        wrong_sight_ids: wrong_ids,
        notes: truth_notes(scenario, &sights, n_drop, reported_sigma),
    };

    Ok(Simulation {
        session,
        truth,
        sights,
    })
}

/// Format a Julian date as the session timestamp.
///
/// `time::format_utc` truncates to the millisecond, and a Julian date only resolves
/// about 40 microseconds in 2026, so a whole-second instant can arrive as `...59.999Z`.
/// Snapping to the nearest millisecond first, then nudging a tenth of a millisecond so
/// the truncation lands on that millisecond, keeps the recorded times the ones the
/// schedule actually asked for. The adjustment is under half a millisecond, which is
/// 0.000002 degrees of GHA: far below anything in this project.
fn format_utc_snapped(jd_utc: f64) -> String {
    const MS_PER_DAY: f64 = 86_400_000.0;
    let ms = ((jd_utc - time::JD_UNIX_EPOCH) * MS_PER_DAY).round();
    let snapped = time::JD_UNIX_EPOCH + ms / MS_PER_DAY;
    time::format_utc(snapped + 1e-4 / 86_400.0)
}

// ---------------------------------------------------------------------------
// Body directions
// ---------------------------------------------------------------------------

/// The apparent geocentric direction of one source at `jd_utc`.
///
/// A supplied source advances linearly in GHA from its value at the scenario start;
/// its declination is constant. A named source is asked of the provider, which must be
/// present.
pub fn direction_of(
    source: &BodySource,
    jd_utc: f64,
    jd_start: f64,
    provider: Option<&dyn AstroProvider>,
    scenario_name: &str,
) -> Result<GeocentricDirection, String> {
    match source {
        BodySource::Supplied {
            gha_deg_at_start,
            dec_deg,
            gha_rate_deg_per_hour,
            ..
        } => {
            let hours = (jd_utc - jd_start) * 24.0;
            Ok(GeocentricDirection {
                gha_deg: norm_360(gha_deg_at_start + gha_rate_deg_per_hour * hours),
                dec_deg: *dec_deg,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            })
        }
        BodySource::Named { name } => {
            let p = provider.ok_or_else(|| {
                format!(
                    "scenario {scenario_name:?}: body {name:?} is a named body but no \
                     AstroProvider was supplied to simulate()"
                )
            })?;
            p.geocentric(name, jd_utc)
                .map_err(|e| format!("scenario {scenario_name:?}: provider {:?}: {e}", p.name()))
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry presets
// ---------------------------------------------------------------------------

/// Indices into `scenario.sources`, filtered and ordered by the geometry preset.
fn select_bodies(
    scenario: &Scenario,
    jd_start: f64,
    provider: Option<&dyn AstroProvider>,
) -> Result<Vec<usize>, String> {
    let n = scenario.sources.len();
    match scenario.geometry {
        GeometryPreset::AsGiven => Ok((0..n).collect()),
        GeometryPreset::Clustered { window_deg } => {
            let az = azimuths_at_truth(scenario, jd_start, provider)?;
            Ok(cluster_within_window(&az, window_deg))
        }
        GeometryPreset::WellSpread { keep } => {
            let az = azimuths_at_truth(scenario, jd_start, provider)?;
            let subset = match keep {
                Some(k) if k > 0 && k < az.len() => best_spread_subset(&az, k),
                _ => (0..az.len()).collect(),
            };
            Ok(spread_order(&az, &subset))
        }
    }
}

/// True azimuths of every source at the truth position and the start time, degrees.
/// This uses the truth on purpose: it is a *scenario authoring* decision about which
/// bodies the navigator chose to shoot, and only the resulting body list reaches the
/// session.
fn azimuths_at_truth(
    scenario: &Scenario,
    jd_start: f64,
    provider: Option<&dyn AstroProvider>,
) -> Result<Vec<f64>, String> {
    let truth = scenario.truth_point();
    scenario
        .sources
        .iter()
        .map(|s| {
            let d = direction_of(s, jd_start, jd_start, provider, &scenario.name)?;
            let (_, zn) =
                geometry::altitude_azimuth(truth, d.gha_deg.to_radians(), d.dec_deg.to_radians());
            Ok(norm_360(rad_to_deg(zn)))
        })
        .collect()
}

/// Forward angular distance from `a` to `b` going clockwise, `[0, 360)`.
fn forward_gap(a: f64, b: f64) -> f64 {
    norm_360(b - a)
}

/// Smallest angular separation between two azimuths, `[0, 180]`.
fn azimuth_separation(a: f64, b: f64) -> f64 {
    let d = forward_gap(a, b);
    d.min(360.0 - d)
}

/// Indices of the bodies inside the fullest `window_deg` window, in azimuth order from
/// the window's start. Falls back to the closest pair when no window holds two.
fn cluster_within_window(azimuths: &[f64], window_deg: f64) -> Vec<usize> {
    let n = azimuths.len();
    if n <= 2 {
        return (0..n).collect();
    }
    let mut best: Vec<usize> = Vec::new();
    for i in 0..n {
        let mut members: Vec<usize> = (0..n)
            .filter(|&j| forward_gap(azimuths[i], azimuths[j]) <= window_deg)
            .collect();
        members.sort_by(|&a, &b| {
            forward_gap(azimuths[i], azimuths[a])
                .partial_cmp(&forward_gap(azimuths[i], azimuths[b]))
                .unwrap()
                .then(a.cmp(&b))
        });
        if members.len() > best.len() {
            best = members;
        }
    }
    if best.len() >= 2 {
        return best;
    }
    // No window holds two bodies: keep the closest pair, in source order, so the
    // scenario is still a (terrible) two-body geometry rather than an error.
    let mut pair = (0usize, 1usize);
    let mut sep = f64::INFINITY;
    for i in 0..n {
        for j in (i + 1)..n {
            let d = azimuth_separation(azimuths[i], azimuths[j]);
            if d < sep {
                sep = d;
                pair = (i, j);
            }
        }
    }
    vec![pair.0, pair.1]
}

/// Smallest gap between consecutive azimuths around the whole circle, degrees. A set of
/// `k` azimuths spread perfectly evenly scores `360 / k`; a tightly clustered set scores
/// near zero. This is the quantity `well_spread` maximises.
fn min_circular_gap(azimuths: &[f64], subset: &[usize]) -> f64 {
    if subset.len() < 2 {
        return 0.0;
    }
    let mut az: Vec<f64> = subset.iter().map(|&i| azimuths[i]).collect();
    az.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut worst = 360.0 - (az[az.len() - 1] - az[0]);
    for w in az.windows(2) {
        worst = worst.min(w[1] - w[0]);
    }
    worst
}

/// The `k` bodies whose azimuths are spread most evenly around the compass, by exhaustive
/// search over subsets (the body lists here are a handful of stars, so this is cheap).
/// Above 20 000 combinations it falls back to the greedy farthest-point order, which is
/// the usual 2-approximation.
fn best_spread_subset(azimuths: &[f64], k: usize) -> Vec<usize> {
    let n = azimuths.len();
    if k == 0 || k >= n {
        return (0..n).collect();
    }
    if k == 1 {
        return vec![0];
    }
    let mut combinations: u64 = 1;
    for i in 0..k {
        combinations = combinations.saturating_mul((n - i) as u64) / (i as u64 + 1);
        if combinations > 20_000 {
            let mut o = spread_order(azimuths, &(0..n).collect::<Vec<_>>());
            o.truncate(k);
            o.sort_unstable();
            return o;
        }
    }
    let mut idx: Vec<usize> = (0..k).collect();
    let mut best: Vec<usize> = idx.clone();
    let mut best_score = min_circular_gap(azimuths, &idx);
    loop {
        // Advance the combination in lexicographic order.
        let mut i = k;
        loop {
            if i == 0 {
                return best;
            }
            i -= 1;
            if idx[i] != i + n - k {
                break;
            }
        }
        idx[i] += 1;
        for j in (i + 1)..k {
            idx[j] = idx[j - 1] + 1;
        }
        let score = min_circular_gap(azimuths, &idx);
        // Strictly greater keeps the lexicographically first of any tie.
        if score > best_score + 1e-9 {
            best_score = score;
            best = idx.clone();
        }
    }
}

/// Greedy farthest-point ordering in azimuth over `candidates`: the first candidate,
/// then repeatedly the one furthest (in minimum circular distance) from everything
/// already chosen. A truncated round-robin schedule then still walks separated bodies.
fn spread_order(azimuths: &[f64], candidates: &[usize]) -> Vec<usize> {
    if candidates.len() <= 1 {
        return candidates.to_vec();
    }
    let mut chosen = vec![candidates[0]];
    let mut remaining: Vec<usize> = candidates[1..].to_vec();
    while !remaining.is_empty() {
        let mut best = 0usize;
        let mut best_score = -1.0f64;
        for (pos, &cand) in remaining.iter().enumerate() {
            let score = chosen
                .iter()
                .map(|&c| azimuth_separation(azimuths[c], azimuths[cand]))
                .fold(f64::INFINITY, f64::min);
            if score > best_score + 1e-9 {
                best_score = score;
                best = pos;
            }
        }
        chosen.push(remaining.remove(best));
    }
    chosen
}

/// Which body (as an index into the *selected* list) scheduled sight `slot` belongs to.
fn body_for_slot(slot: usize, count: usize, n_bodies: usize, ordering: Ordering) -> usize {
    match ordering {
        Ordering::RoundRobin => slot % n_bodies,
        Ordering::Sequential => {
            let base = count / n_bodies;
            let rem = count % n_bodies;
            let mut acc = 0usize;
            for b in 0..n_bodies {
                let k = base + usize::from(b < rem);
                if slot < acc + k {
                    return b;
                }
                acc += k;
            }
            n_bodies - 1
        }
    }
}

// ---------------------------------------------------------------------------
// Assumed position and notes
// ---------------------------------------------------------------------------

fn assumed_position_of(scenario: &Scenario) -> (Option<LatLon>, String) {
    match scenario.assumed_position.mode {
        AssumedPositionMode::None => (
            None,
            "No assumed position: the solver must find the fix by multistart.".to_string(),
        ),
        AssumedPositionMode::OffsetFromTruth {
            distance_nm,
            bearing_deg,
        } => {
            let p = geometry::destination(
                scenario.truth_point(),
                bearing_deg.to_radians(),
                nm_to_rad(distance_nm),
            );
            (
                Some(LatLon {
                    lat_deg: p.lat_deg(),
                    lon_deg: p.lon_deg(),
                }),
                format!(
                    "Assumed position: a dead-reckoning position a fixed distance and bearing \
                     from the observer's real position, as a navigator's DR would be. It is \
                     within {distance_nm:.0} nautical miles of the answer, which is disclosed \
                     here because it is the only truth-derived number in this file."
                ),
            )
        }
        AssumedPositionMode::Explicit(p) => (
            Some(p),
            "Assumed position: chosen by the scenario author, unrelated to the observer's \
             real position."
                .to_string(),
        ),
        AssumedPositionMode::Truth => (
            Some(scenario.truth),
            "Assumed position: THE OBSERVER'S TRUE POSITION. This session is not a blind \
             experiment. The scenario asked for this deliberately, to study initialisation; \
             any accuracy it appears to show is not evidence about the solver."
                .to_string(),
        ),
    }
}

fn session_notes(scenario: &Scenario, assumed_note: &str) -> String {
    let mut knobs: Vec<&str> = Vec::new();
    if scenario.altitude_noise_arcmin > 0.0 {
        knobs.push("independent random noise on each sight's altitude");
    }
    if scenario.shared_altitude_bias_arcmin != 0.0 {
        knobs.push(
            "a shared altitude bias affecting every sight by the same amount (averaging \
             more sights cannot remove it)",
        );
    }
    if scenario.clock_offset_s != 0.0 {
        knobs.push(
            "a constant offset in the recorded timestamps (the instants below are not the \
             instants the sights were taken at)",
        );
    }
    if scenario.missing_fraction > 0.0 {
        knobs.push("some scheduled sights were dropped before this file was written");
    }
    if scenario.wrong_sight.is_some() {
        knobs.push("exactly one sight carries a deliberate blunder");
    }
    if scenario.altitude_noise_arcmin > 0.0
        && scenario
            .reported_sigma_arcmin
            .is_some_and(|r| r != scenario.altitude_noise_arcmin)
    {
        knobs.push(
            "the sigma reported on each sight was set by hand and need not match the noise \
             the data actually carries",
        );
    }
    if matches!(scenario.almanac_lookup, AlmanacLookup::TrueTime) {
        knobs.push(
            "the body directions below are the true ones regardless of the recorded \
             timestamps (a control case)",
        );
    }
    if matches!(scenario.altitude_kind, EmittedAltitude::SextantHs { .. }) {
        knobs.push(
            "the altitudes below are raw sextant readings: index correction, dip and \
             refraction have NOT been applied",
        );
    }

    let mut s = String::from(
        "Simulated session generated by skyfix-sim. The observer's real position, the \
         random seed and the size of every effect listed below are recorded in a separate \
         truth document and are deliberately absent from this file. ",
    );
    if knobs.is_empty() {
        s.push_str("This is a clean session: no noise, no bias, no clock offset, nothing missing.");
    } else {
        s.push_str("What was done to this data, in words and without numbers: ");
        s.push_str(&knobs.join("; "));
        s.push('.');
    }
    s.push(' ');
    s.push_str(assumed_note);
    s
}

fn truth_notes(
    scenario: &Scenario,
    sights: &[TruthSight],
    n_dropped: usize,
    reported_sigma: f64,
) -> String {
    let bodies: Vec<&str> = {
        let mut v: Vec<&str> = sights.iter().map(|s| s.body.as_str()).collect();
        v.dedup();
        v
    };
    let mut s = format!(
        "Truth for the simulated session {:?}. Scheduled sights: {}; dropped: {}; emitted: {}. \
         Bodies in emission order: {}. \
         True per-sight altitude noise 1-sigma: {:.4} arcmin; sigma reported to the estimator: \
         {:.4} arcmin. Shared altitude bias: {:+.4} arcmin (added to every altitude). \
         Clock offset: {:+.4} s, defined as recorded_time - true_time. \
         Clock uncertainty reported to the estimator: {:.4} s. \
         Emitted altitude kind: {}. Geometry preset: {}. Almanac lookup: {}.",
        scenario.name,
        scenario.schedule.count,
        n_dropped,
        sights.len(),
        bodies.join(", "),
        scenario.altitude_noise_arcmin,
        reported_sigma,
        scenario.shared_altitude_bias_arcmin,
        scenario.clock_offset_s,
        scenario.reported_clock_uncertainty_s,
        match scenario.altitude_kind {
            EmittedAltitude::ObservedHo => "observed_ho",
            EmittedAltitude::SextantHs { .. } => "sextant_hs (sea horizon, reverse chain)",
        },
        match scenario.geometry {
            GeometryPreset::AsGiven => "as_given".to_string(),
            GeometryPreset::Clustered { window_deg } =>
                format!("clustered, {window_deg} deg window"),
            GeometryPreset::WellSpread { keep } => format!("well_spread, keep {keep:?}"),
        },
        match scenario.almanac_lookup {
            AlmanacLookup::RecordedTime => "recorded time (the estimator's clock)",
            AlmanacLookup::TrueTime => "true time (control)",
        },
    );
    if let Some(w) = scenario.wrong_sight {
        s.push_str(&format!(
            " Deliberate blunder: {:+.4} arcmin on emitted sight index {} ({}).",
            w.error_arcmin,
            w.index,
            sights
                .get(w.index)
                .map(|x| x.id.as_str())
                .unwrap_or("out of range"),
        ));
    }
    if matches!(
        scenario.assumed_position.mode,
        AssumedPositionMode::OffsetFromTruth { .. } | AssumedPositionMode::Truth
    ) {
        s.push_str(
            " The session's assumed position is derived from the truth: see its notes for \
             exactly how much that discloses.",
        );
    }
    if !matches!(
        scenario.assumed_position.role,
        AssumedPositionRole::Initializer
    ) {
        s.push_str(" NOTE: the assumed position is not a plain initializer in this scenario.");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{AssumedPositionSpec, Schedule, body_at};

    const PHL: LatLon = LatLon {
        lat_deg: 39.9526,
        lon_deg: -75.1652,
    };

    fn five_bodies() -> Vec<BodySource> {
        vec![
            body_at("sim-A", PHL, 58.0, 35.0),
            body_at("sim-B", PHL, 44.0, 105.0),
            body_at("sim-C", PHL, 27.0, 170.0),
            body_at("sim-D", PHL, 39.0, 240.0),
            body_at("sim-E", PHL, 62.0, 310.0),
        ]
    }

    fn base() -> Scenario {
        let mut s = Scenario::new(
            "unit",
            42,
            PHL,
            "2026-10-01T01:30:00Z",
            five_bodies(),
            Schedule::new(5, 120.0, Ordering::RoundRobin),
        );
        s.reported_sigma_arcmin = Some(1.0);
        s
    }

    #[test]
    fn bodies_land_where_the_scenario_put_them() {
        // Zero spacing puts every sight at the start time, where `body_at` placed the
        // bodies. With a real spacing they drift west at the sidereal rate instead.
        let mut s = base();
        s.schedule = Schedule::new(5, 0.0, Ordering::RoundRobin);
        let sim = simulate_detailed(&s, None).unwrap();
        let wanted = [
            (58.0, 35.0),
            (44.0, 105.0),
            (27.0, 170.0),
            (39.0, 240.0),
            (62.0, 310.0),
        ];
        for (s, (h, zn)) in sim.sights.iter().zip(wanted) {
            assert!(
                (s.true_altitude_deg - h).abs() < 1e-9,
                "{}: {}",
                s.body,
                s.true_altitude_deg
            );
            let dz = (s.true_azimuth_deg - zn + 540.0) % 360.0 - 180.0;
            assert!(dz.abs() < 1e-9, "{}: {}", s.body, s.true_azimuth_deg);
        }
    }

    #[test]
    fn a_clean_scenario_emits_the_true_altitudes() {
        let sim = simulate_detailed(&base(), None).unwrap();
        for (obs, truth) in sim.session.observations.iter().zip(&sim.sights) {
            assert_eq!(obs.altitude_kind, AltitudeKind::ObservedHo);
            assert!((obs.altitude_deg - truth.true_altitude_deg).abs() < 1e-12);
            assert_eq!(truth.noise_arcmin, 0.0);
            assert_eq!(obs.sigma_arcmin, 1.0);
            assert_eq!(obs.limb, Limb::Center);
            assert!(obs.geocentric.is_some());
        }
        assert_eq!(sim.session.meta.kind, SessionKind::Simulated);
        assert_eq!(sim.session.schema, SESSION_SCHEMA);
        assert_eq!(sim.truth.schema, TRUTH_SCHEMA);
    }

    #[test]
    fn round_robin_and_sequential_orderings() {
        let mut s = base();
        s.schedule = Schedule::new(7, 60.0, Ordering::RoundRobin);
        let names: Vec<String> = simulate_detailed(&s, None)
            .unwrap()
            .session
            .observations
            .iter()
            .map(|o| o.body.clone())
            .collect();
        assert_eq!(
            names,
            [
                "sim-A", "sim-B", "sim-C", "sim-D", "sim-E", "sim-A", "sim-B"
            ]
        );

        s.schedule = Schedule::new(7, 60.0, Ordering::Sequential);
        let names: Vec<String> = simulate_detailed(&s, None)
            .unwrap()
            .session
            .observations
            .iter()
            .map(|o| o.body.clone())
            .collect();
        // 7 sights over 5 bodies: 2, 2, 1, 1, 1.
        assert_eq!(
            names,
            [
                "sim-A", "sim-A", "sim-B", "sim-B", "sim-C", "sim-D", "sim-E"
            ]
        );
    }

    #[test]
    fn body_for_slot_covers_every_sight_exactly_once() {
        for count in 1..20usize {
            for n in 1..7usize {
                let mut seen = vec![0usize; n];
                for slot in 0..count {
                    seen[body_for_slot(slot, count, n, Ordering::Sequential)] += 1;
                }
                assert_eq!(seen.iter().sum::<usize>(), count);
                let (lo, hi) = (*seen.iter().min().unwrap(), *seen.iter().max().unwrap());
                assert!(hi - lo <= 1, "count {count} bodies {n}: {seen:?}");
            }
        }
    }

    #[test]
    fn timestamps_advance_by_the_schedule_spacing() {
        let sim = simulate_detailed(&base(), None).unwrap();
        let t: Vec<f64> = sim
            .session
            .observations
            .iter()
            .map(|o| time::parse_utc(&o.utc).unwrap())
            .collect();
        for w in t.windows(2) {
            assert!(((w[1] - w[0]) * 86_400.0 - 120.0).abs() < 1e-3);
        }
    }

    #[test]
    fn clock_offset_shifts_recorded_times_forward_for_a_positive_offset() {
        let mut s = base();
        s.clock_offset_s = 60.0;
        let sim = simulate_detailed(&s, None).unwrap();
        for (obs, truth) in sim.session.observations.iter().zip(&sim.sights) {
            let recorded = time::parse_utc(&obs.utc).unwrap();
            let delta_s = (recorded - truth.true_jd_utc) * 86_400.0;
            assert!(
                (delta_s - 60.0).abs() < 1e-3,
                "recorded - true = {delta_s}, expected +60 (clock_offset_s = recorded - true)"
            );
        }
        // A negative offset records times EARLIER than the truth.
        s.clock_offset_s = -90.0;
        let sim = simulate_detailed(&s, None).unwrap();
        for (obs, truth) in sim.session.observations.iter().zip(&sim.sights) {
            let delta_s = (time::parse_utc(&obs.utc).unwrap() - truth.true_jd_utc) * 86_400.0;
            assert!((delta_s + 90.0).abs() < 1e-3, "{delta_s}");
        }
    }

    #[test]
    fn clock_offset_moves_the_supplied_gha_by_the_sidereal_rate() {
        use skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR;
        let clean = simulate_detailed(&base(), None).unwrap();
        let mut s = base();
        s.clock_offset_s = 60.0;
        let offset = simulate_detailed(&s, None).unwrap();
        let expected = SIDEREAL_RATE_DEG_PER_HOUR * 60.0 / 3600.0;
        for (a, b) in clean
            .session
            .observations
            .iter()
            .zip(&offset.session.observations)
        {
            let d = b.geocentric.unwrap().gha_deg - a.geocentric.unwrap().gha_deg;
            assert!(
                (d - expected).abs() < 1e-6,
                "GHA moved {d} deg, expected {expected}"
            );
            // The altitude is unchanged: the sight itself was taken at the true time.
            assert!((a.altitude_deg - b.altitude_deg).abs() < 1e-12);
        }
        // The control case leaves the direction alone entirely.
        s.almanac_lookup = AlmanacLookup::TrueTime;
        let control = simulate_detailed(&s, None).unwrap();
        for (a, b) in clean
            .session
            .observations
            .iter()
            .zip(&control.session.observations)
        {
            assert!((a.geocentric.unwrap().gha_deg - b.geocentric.unwrap().gha_deg).abs() < 1e-12);
        }
    }

    #[test]
    fn noise_and_bias_land_in_the_altitudes_with_the_documented_signs() {
        let mut s = base();
        s.altitude_noise_arcmin = 0.8;
        s.shared_altitude_bias_arcmin = 3.0;
        let sim = simulate_detailed(&s, None).unwrap();
        for (obs, t) in sim.session.observations.iter().zip(&sim.sights) {
            let applied = (obs.altitude_deg - t.true_altitude_deg) * 60.0;
            assert!((applied - (t.noise_arcmin + 3.0)).abs() < 1e-9);
            assert_eq!(t.bias_arcmin, 3.0);
        }
        // A positive bias raises every altitude.
        assert!(
            sim.session
                .observations
                .iter()
                .zip(&sim.sights)
                .all(|(o, t)| o.altitude_deg > t.true_altitude_deg - 3.0 / 60.0)
        );
    }

    #[test]
    fn noise_draws_do_not_move_when_other_knobs_change() {
        let mut a = base();
        a.altitude_noise_arcmin = 1.0;
        let mut b = a.clone();
        b.shared_altitude_bias_arcmin = 5.0;
        b.clock_offset_s = 30.0;
        let sa = simulate_detailed(&a, None).unwrap();
        let sb = simulate_detailed(&b, None).unwrap();
        for (x, y) in sa.sights.iter().zip(&sb.sights) {
            assert_eq!(x.noise_arcmin, y.noise_arcmin);
        }
    }

    #[test]
    fn the_wrong_sight_lands_on_the_named_record_only() {
        let mut s = base();
        s.wrong_sight = Some(WrongSight {
            index: 2,
            error_arcmin: 8.0,
        });
        let sim = simulate_detailed(&s, None).unwrap();
        for (i, t) in sim.sights.iter().enumerate() {
            let want = if i == 2 { 8.0 } else { 0.0 };
            assert_eq!(t.blunder_arcmin, want, "sight {i}");
            let applied = (sim.session.observations[i].altitude_deg - t.true_altitude_deg) * 60.0;
            assert!((applied - want).abs() < 1e-9);
        }
        assert_eq!(sim.truth.wrong_sight_ids, vec!["obs-3".to_string()]);

        // Out of range is an error, not a silent no-op.
        s.wrong_sight = Some(WrongSight {
            index: 99,
            error_arcmin: 8.0,
        });
        assert!(
            simulate_detailed(&s, None)
                .unwrap_err()
                .contains("out of range")
        );
    }

    #[test]
    fn missing_fraction_drops_an_exact_count() {
        let mut s = base();
        s.schedule = Schedule::new(20, 60.0, Ordering::RoundRobin);
        for (frac, expect) in [(0.0, 20), (0.25, 15), (0.5, 10), (0.1, 18), (0.95, 1)] {
            s.missing_fraction = frac;
            let sim = simulate_detailed(&s, None).unwrap();
            assert_eq!(sim.session.observations.len(), expect, "fraction {frac}");
            // Ids are renumbered over the emitted sights and stay unique.
            let ids: Vec<&str> = sim
                .session
                .observations
                .iter()
                .map(|o| o.id.as_str())
                .collect();
            let mut sorted = ids.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), ids.len());
            assert_eq!(ids[0], "obs-1");
        }
        s.missing_fraction = 1.0;
        assert!(
            simulate_detailed(&s, None)
                .unwrap_err()
                .contains("dropped all")
        );
    }

    #[test]
    fn missing_sights_leave_gaps_in_the_true_times() {
        let mut s = base();
        s.schedule = Schedule::new(10, 60.0, Ordering::RoundRobin);
        s.missing_fraction = 0.4;
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(sim.sights.len(), 6);
        let jd0 = time::parse_utc("2026-10-01T01:30:00Z").unwrap();
        let slots: Vec<i64> = sim
            .sights
            .iter()
            .map(|t| ((t.true_jd_utc - jd0) * 86_400.0 / 60.0).round() as i64)
            .collect();
        assert!(slots.windows(2).all(|w| w[1] > w[0]), "slots {slots:?}");
        assert!(slots.iter().all(|&x| (0..10).contains(&x)));
        assert!(
            slots != vec![0, 1, 2, 3, 4, 5],
            "some slots must be skipped"
        );
    }

    #[test]
    fn sextant_readings_reduce_back_to_the_emitted_ho() {
        let mut s = base();
        s.altitude_noise_arcmin = 0.7;
        s.shared_altitude_bias_arcmin = 2.0;
        s.altitude_kind = EmittedAltitude::SextantHs {
            height_of_eye_m: 2.5,
            index_correction_arcmin: -2.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        };
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(sim.session.observer.height_of_eye_m, 2.5);
        assert_eq!(sim.session.instrument.index_correction_arcmin, -2.0);
        assert_eq!(
            sim.session.instrument.horizon,
            skyfix_core::types::HorizonMode::Sea
        );
        for (obs, t) in sim.session.observations.iter().zip(&sim.sights) {
            assert_eq!(obs.altitude_kind, AltitudeKind::SextantHs);
            // Raw readings are higher than the corrected altitude here: dip plus
            // refraction outweigh the (negative) index correction... check by running
            // the forward chain, which is the reducer's job.
            let ho = optics::hs_to_ho(obs.altitude_deg, -2.0, 2.5, 1010.0, 10.0).unwrap();
            assert!(
                (ho - t.emitted_ho_deg).abs() < 1e-11,
                "{}: reduced to {ho}, emitted Ho {}",
                obs.id,
                t.emitted_ho_deg
            );
        }
    }

    #[test]
    fn a_body_below_the_horizon_is_refused() {
        let mut s = base();
        s.sources = vec![BodySource::Supplied {
            name: "below".into(),
            // GP on the far side of the Earth from Philadelphia.
            gha_deg_at_start: norm_360(-(-75.1652 + 180.0)),
            dec_deg: -39.9526,
            gha_rate_deg_per_hour: 0.0,
        }];
        s.schedule = Schedule::new(1, 0.0, Ordering::RoundRobin);
        let err = simulate_detailed(&s, None).unwrap_err();
        assert!(err.contains("BELOW the horizon"), "{err}");
    }

    #[test]
    fn assumed_position_is_offset_from_the_truth_by_default() {
        let sim = simulate_detailed(&base(), None).unwrap();
        let ap = sim.session.observer.assumed_position.unwrap();
        assert_ne!(ap.lat_deg, PHL.lat_deg);
        assert_ne!(ap.lon_deg, PHL.lon_deg);
        let d = geometry::angular_distance(
            geometry::Point::from_deg(ap.lat_deg, ap.lon_deg),
            geometry::Point::from_deg(PHL.lat_deg, PHL.lon_deg),
        );
        assert!((skyfix_core::units::rad_to_nm(d) - 30.0).abs() < 1e-6);
        assert_eq!(
            sim.session.observer.assumed_position_role,
            AssumedPositionRole::Initializer
        );
        assert!(sim.session.meta.notes.contains("dead-reckoning"));
    }

    #[test]
    fn assumed_position_modes() {
        let mut s = base();
        s.assumed_position = AssumedPositionSpec {
            mode: AssumedPositionMode::None,
            role: AssumedPositionRole::Disabled,
        };
        let sim = simulate_detailed(&s, None).unwrap();
        assert!(sim.session.observer.assumed_position.is_none());

        s.assumed_position = AssumedPositionSpec {
            mode: AssumedPositionMode::Explicit(LatLon {
                lat_deg: 41.0,
                lon_deg: -74.0,
            }),
            role: AssumedPositionRole::Initializer,
        };
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(
            sim.session.observer.assumed_position.unwrap(),
            LatLon {
                lat_deg: 41.0,
                lon_deg: -74.0
            }
        );

        // The truth as an assumed position must announce itself loudly.
        s.assumed_position = AssumedPositionSpec {
            mode: AssumedPositionMode::Truth,
            role: AssumedPositionRole::Initializer,
        };
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(sim.session.observer.assumed_position.unwrap(), PHL);
        assert!(
            sim.session.meta.notes.contains("TRUE POSITION"),
            "notes: {}",
            sim.session.meta.notes
        );
    }

    #[test]
    fn clustered_geometry_keeps_the_fullest_window() {
        // 20, 35, 48 are inside a 30 degree window; 140, 225, 300 are not.
        let az = [20.0, 35.0, 48.0, 140.0, 225.0, 300.0];
        assert_eq!(cluster_within_window(&az, 30.0), vec![0, 1, 2]);
        // Wrap-around windows work: 350, 5, 15 span the north point.
        let az = [350.0, 5.0, 15.0, 120.0, 200.0];
        assert_eq!(cluster_within_window(&az, 30.0), vec![0, 1, 2]);
        // Nothing within the window: keep the closest pair rather than failing.
        let az = [0.0, 90.0, 175.0, 260.0];
        assert_eq!(cluster_within_window(&az, 5.0), vec![1, 2]);
        // Degenerate sizes.
        assert_eq!(cluster_within_window(&[10.0], 30.0), vec![0]);
        assert_eq!(cluster_within_window(&[10.0, 200.0], 30.0), vec![0, 1]);
    }

    #[test]
    fn clustered_preset_narrows_the_scenario_to_one_quadrant() {
        let mut s = base();
        s.sources = vec![
            body_at("N", PHL, 42.0, 20.0),
            body_at("NNE", PHL, 55.0, 35.0),
            body_at("NE", PHL, 33.0, 48.0),
            body_at("SE", PHL, 61.0, 140.0),
            body_at("SW", PHL, 28.0, 225.0),
            body_at("NW", PHL, 47.0, 300.0),
        ];
        s.schedule = Schedule::new(6, 60.0, Ordering::RoundRobin);
        s.geometry = GeometryPreset::Clustered { window_deg: 30.0 };
        let sim = simulate_detailed(&s, None).unwrap();
        let used: Vec<&str> = sim.sights.iter().map(|x| x.body.as_str()).collect();
        assert_eq!(used, ["N", "NNE", "NE", "N", "NNE", "NE"]);
        // Every sight is within 30 degrees of azimuth of every other, which is the point.
        let spread = sim
            .sights
            .iter()
            .map(|x| x.true_azimuth_deg)
            .fold((f64::MAX, f64::MIN), |(lo, hi), z| (lo.min(z), hi.max(z)));
        assert!(spread.1 - spread.0 < 32.0, "azimuth spread {spread:?}");
    }

    #[test]
    fn well_spread_selects_the_evenest_subset_and_orders_it() {
        // Perfectly even triples score 120 degrees; the evenest subset wins.
        let az = [0.0, 5.0, 118.0, 122.0, 241.0];
        // {0, 122, 241} has a smallest gap of 119 degrees; {0, 118, 241} only 118.
        assert_eq!(best_spread_subset(&az, 3), vec![0, 3, 4]);
        assert!((min_circular_gap(&az, &[0, 3, 4]) - 119.0).abs() < 1e-9);
        assert!((min_circular_gap(&az, &[0, 2, 4]) - 118.0).abs() < 1e-9);
        assert!(min_circular_gap(&az, &[0, 1, 2]) < 6.0);
        // Pairs want to be opposite.
        assert_eq!(best_spread_subset(&[0.0, 90.0, 182.0], 2), vec![0, 2]);
        // Degenerate k.
        assert_eq!(best_spread_subset(&az, 0), vec![0, 1, 2, 3, 4]);
        assert_eq!(best_spread_subset(&az, 9), vec![0, 1, 2, 3, 4]);
        assert_eq!(best_spread_subset(&az, 1), vec![0]);

        // Ordering: the first candidate, then the furthest, then the furthest from both.
        let all = vec![0, 1, 2, 3];
        assert_eq!(
            spread_order(&[0.0, 10.0, 180.0, 90.0], &all),
            vec![0, 2, 3, 1]
        );
        assert_eq!(spread_order(&[0.0], &[0]), vec![0]);
        assert_eq!(spread_order(&[], &[]), Vec::<usize>::new());

        // End to end: three of the five demo bodies, spread as evenly as they can be.
        let mut s = base();
        s.geometry = GeometryPreset::WellSpread { keep: Some(3) };
        s.schedule = Schedule::new(3, 60.0, Ordering::RoundRobin);
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(sim.sights.len(), 3);
        let mut az: Vec<f64> = sim.sights.iter().map(|x| x.true_azimuth_deg).collect();
        az.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut gaps: Vec<f64> = az.windows(2).map(|w| w[1] - w[0]).collect();
        gaps.push(360.0 - (az[az.len() - 1] - az[0]));
        assert!(
            gaps.iter().all(|g| *g < 180.0),
            "azimuths {az:?} gaps {gaps:?}"
        );
        // Keeping everything leaves every body in, reordered for spread.
        s.geometry = GeometryPreset::WellSpread { keep: None };
        s.schedule = Schedule::new(5, 60.0, Ordering::RoundRobin);
        let sim = simulate_detailed(&s, None).unwrap();
        let mut used: Vec<&str> = sim.sights.iter().map(|x| x.body.as_str()).collect();
        used.sort_unstable();
        assert_eq!(used, ["sim-A", "sim-B", "sim-C", "sim-D", "sim-E"]);
    }

    #[test]
    fn named_bodies_need_a_provider() {
        let mut s = base();
        s.sources = vec![BodySource::Named {
            name: "Vega".into(),
        }];
        s.schedule = Schedule::new(1, 0.0, Ordering::RoundRobin);
        let err = simulate_detailed(&s, None).unwrap_err();
        assert!(
            err.contains("no \nAstroProvider") || err.contains("AstroProvider"),
            "{err}"
        );
    }

    #[test]
    fn identical_seeds_give_byte_identical_sessions() {
        let mut s = base();
        s.altitude_noise_arcmin = 1.2;
        s.missing_fraction = 0.2;
        s.schedule = Schedule::new(10, 45.0, Ordering::RoundRobin);
        let a = serde_json::to_string(&simulate(&s, None).unwrap().0).unwrap();
        let b = serde_json::to_string(&simulate(&s, None).unwrap().0).unwrap();
        assert_eq!(a, b);
        let mut t = s.clone();
        t.seed += 1;
        let c = serde_json::to_string(&simulate(&t, None).unwrap().0).unwrap();
        assert_ne!(a, c, "a different seed must give different data");
    }

    #[test]
    fn truth_never_appears_in_the_session() {
        let mut s = base();
        s.altitude_noise_arcmin = 1.0;
        s.shared_altitude_bias_arcmin = 3.0;
        s.clock_offset_s = 60.0;
        s.wrong_sight = Some(WrongSight {
            index: 1,
            error_arcmin: 8.0,
        });
        // A distinctive seed: a short one like 42 appears inside ordinary floats by
        // coincidence and would make this test lie in both directions.
        s.seed = 9_123_456_789;
        let (session, truth) = simulate(&s, None).unwrap();
        let json = serde_json::to_string_pretty(&session).unwrap();
        for needle in ["39.9526", "75.1652", "9123456789"] {
            assert!(
                !json.contains(needle),
                "the session leaks {needle:?}:\n{json}"
            );
        }
        // ...and the truth document has all of it.
        assert_eq!(truth.position, PHL);
        assert_eq!(truth.seed, 9_123_456_789);
        assert_eq!(truth.clock_offset_s, 60.0);
        assert_eq!(truth.shared_altitude_bias_arcmin, 3.0);
        assert_eq!(truth.wrong_sight_ids, vec!["obs-2".to_string()]);
        assert!(truth.notes.contains("recorded_time - true_time"));
    }

    #[test]
    fn session_notes_describe_knobs_without_numbers() {
        let mut s = base();
        s.altitude_noise_arcmin = 1.0;
        s.shared_altitude_bias_arcmin = 3.0;
        s.clock_offset_s = 60.0;
        s.missing_fraction = 0.2;
        s.wrong_sight = Some(WrongSight {
            index: 0,
            error_arcmin: 8.0,
        });
        let (session, _) = simulate(&s, None).unwrap();
        let n = &session.meta.notes;
        for phrase in [
            "independent random noise",
            "shared altitude bias",
            "constant offset in the recorded timestamps",
            "dropped",
            "deliberate blunder",
        ] {
            assert!(n.contains(phrase), "notes missing {phrase:?}: {n}");
        }
        // No numeric truth in the notes: the only digits allowed are in the assumed
        // position sentence, which discloses its own distance on purpose.
        let head = n.split("Assumed position").next().unwrap();
        assert!(
            !head.chars().any(|c| c.is_ascii_digit()),
            "notes carry numbers: {head}"
        );
    }

    #[test]
    fn a_clean_scenario_says_so() {
        let (session, _) = simulate(&base(), None).unwrap();
        assert!(session.meta.notes.contains("clean session"));
    }
}
