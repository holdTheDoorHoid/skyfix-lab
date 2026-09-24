//! The packaged demo scenarios.
//!
//! The brief asks for six demonstrations. Two of them are a pair of scenarios that only
//! differ in one respect, and demo 1 has two extra variants, so there are ten scenario
//! functions:
//!
//! | # | demonstration | scenarios |
//! |---|---|---|
//! | 1 | a Philadelphia star fix that actually works | [`philadelphia_stars`] (and [`philadelphia_stars_named`], which needs a provider) |
//! | 2 | good versus clustered observation geometry | [`good_geometry`], [`clustered_geometry`] |
//! | 3 | one bad observation, visible in the residuals | [`one_bad_sight`] |
//! | 4 | a shared clock offset moving the recovered position | [`clock_offset`] |
//! | 5 | a shared altitude bias that averaging cannot remove | [`shared_bias`] |
//! | 6 | one sight, and the two-sight ambiguity | [`single_sight`], [`two_sight_ambiguous`] |
//!
//! [`philadelphia_stars_sextant`] is demo 1 again with raw sextant readings instead of
//! corrected altitudes, so the packaged set exercises the correction chain end to end.
//! [`all`] returns the eight that need no astronomy provider, in demo order.
//!
//! Every scenario here has a fixed seed, so a demo always produces the same numbers.
//!
//! All of them except [`philadelphia_stars_named`] use **supplied** body directions:
//! synthetic bodies placed at chosen altitudes and azimuths by inverting the geometry
//! (`scenario::body_at`). That is deliberate. It is the brief's "first numerical slice":
//! the demos exercise the reducer, the solver and the uncertainty model without
//! depending on any astronomy implementation, so a failure has one possible cause
//! instead of two. [`philadelphia_stars_named`] is the same experiment against real
//! stars once an `AstroProvider` can supply them.

use skyfix_core::types::{AssumedPositionRole, LatLon};

use crate::scenario::{
    AssumedPositionMode, AssumedPositionSpec, BodySource, EmittedAltitude, GeometryPreset,
    Ordering, Scenario, Schedule, WrongSight, body_at,
};

/// Philadelphia City Hall, the truth position for every demo (CONVENTIONS section 2).
pub const PHILADELPHIA: LatLon = LatLon {
    lat_deg: 39.9526,
    lon_deg: -75.1652,
};

/// The evening the demos are set on. Chosen for the packaged session files; every
/// scenario that uses supplied directions works at any date, since the bodies are
/// placed relative to the observer rather than looked up.
pub const DEMO_START_UTC: &str = "2026-10-01T01:30:00Z";

/// The real stars [`philadelphia_stars_named`] asks a provider for.
pub const PHILADELPHIA_STAR_NAMES: [&str; 6] =
    ["Vega", "Altair", "Arcturus", "Deneb", "Capella", "Polaris"];

fn dr_offset(distance_nm: f64, bearing_deg: f64) -> AssumedPositionSpec {
    AssumedPositionSpec {
        mode: AssumedPositionMode::OffsetFromTruth {
            distance_nm,
            bearing_deg,
        },
        role: AssumedPositionRole::Initializer,
    }
}

/// Five synthetic stars spread around the compass at 27 to 62 degrees altitude, which is
/// the band a navigator actually works in: high enough that refraction is small and
/// well behaved, low enough that the sight is easy to take.
fn spread_five() -> Vec<BodySource> {
    vec![
        body_at("sim-Alpha", PHILADELPHIA, 58.0, 35.0),
        body_at("sim-Bravo", PHILADELPHIA, 44.0, 105.0),
        body_at("sim-Charlie", PHILADELPHIA, 27.0, 170.0),
        body_at("sim-Delta", PHILADELPHIA, 39.0, 240.0),
        body_at("sim-Echo", PHILADELPHIA, 62.0, 310.0),
    ]
}

/// Six synthetic stars, three of them bunched into a 30 degree window in the north-east.
/// The same list serves the good and the clustered scenario; only the preset differs.
fn clusterable_six() -> Vec<BodySource> {
    vec![
        body_at("sim-North", PHILADELPHIA, 42.0, 20.0),
        body_at("sim-NorthEast", PHILADELPHIA, 55.0, 35.0),
        body_at("sim-EastNorthEast", PHILADELPHIA, 33.0, 48.0),
        body_at("sim-SouthEast", PHILADELPHIA, 61.0, 140.0),
        body_at("sim-SouthWest", PHILADELPHIA, 28.0, 225.0),
        body_at("sim-NorthWest", PHILADELPHIA, 47.0, 300.0),
    ]
}

// ---------------------------------------------------------------------------
// 1. A Philadelphia star fix
// ---------------------------------------------------------------------------

/// Demo 1: a stationary observer near Philadelphia takes five star sights.
pub fn philadelphia_stars() -> Scenario {
    let mut s = Scenario::new(
        "philadelphia-stars",
        2_026_100_101,
        PHILADELPHIA,
        DEMO_START_UTC,
        spread_five(),
        Schedule::new(5, 120.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 0.8;
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
The ordinary case, and the one to read first. Someone standing still near Philadelphia \
takes five star sights two minutes apart, at five stars spread right round the compass \
from 27 to 62 degrees above the horizon. Each sight is off by a small random amount \
(under an arcminute, which is about the best a careful sextant observer manages), and \
the errors are independent: one sight reading high tells you nothing about the next. \
The position the solver hands back should land within a few hundred metres of where the \
observer really was, the 95 per cent ellipse should be a few hundred metres across, and \
the leftover residuals should be about the size of the noise. \
Look at: the fix, the ellipse, and the residual column. This is what healthy output \
looks like, so that the next five demos are recognisable as unhealthy."
        .to_string();
    s
}

/// Demo 1 against real stars. Needs an `AstroProvider` that covers the six navigational
/// stars in [`PHILADELPHIA_STAR_NAMES`] on the demo evening; use [`philadelphia_stars`]
/// until one does.
pub fn philadelphia_stars_named() -> Scenario {
    let mut s = Scenario::new(
        "philadelphia-stars-real",
        2_026_100_102,
        PHILADELPHIA,
        DEMO_START_UTC,
        PHILADELPHIA_STAR_NAMES
            .iter()
            .map(|n| BodySource::Named {
                name: (*n).to_string(),
            })
            .collect(),
        Schedule::new(6, 120.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 0.8;
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
The same experiment as the Philadelphia star demo, but with six real navigational stars \
(Vega, Altair, Arcturus, Deneb, Capella and Polaris) looked up in the almanac instead of \
invented. It needs an astronomy provider that covers those stars on that evening, and it \
is the scenario to run once one exists: if it agrees with the synthetic version, the \
astronomy and the navigation are both working; if only this one fails, the astronomy is \
the part to look at."
        .to_string();
    s
}

// ---------------------------------------------------------------------------
// 2. Good versus clustered geometry
// ---------------------------------------------------------------------------

/// Demo 2a: six stars spread around the compass.
pub fn good_geometry() -> Scenario {
    let mut s = Scenario::new(
        "good-geometry",
        2_026_100_201,
        PHILADELPHIA,
        DEMO_START_UTC,
        clusterable_six(),
        Schedule::new(6, 60.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 1.0;
    s.geometry = GeometryPreset::WellSpread { keep: None };
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
Half of the geometry comparison. Six sights, one arcminute of noise each, at stars \
spread right around the compass. Run it beside the clustered scenario: the two use the \
same stars, the same number of sights, the same noise and the same random seed, so the \
ONLY difference between them is which direction the observer was looking. \
Look at: the size of the 95 per cent ellipse and the condition number. Keep both to \
compare against the clustered run."
        .to_string();
    s
}

/// Demo 2b: the same six stars, restricted to a 30 degree window of azimuth.
pub fn clustered_geometry() -> Scenario {
    let mut s = Scenario::new(
        "clustered-geometry",
        2_026_100_201,
        PHILADELPHIA,
        DEMO_START_UTC,
        clusterable_six(),
        Schedule::new(6, 60.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 1.0;
    s.geometry = GeometryPreset::Clustered { window_deg: 30.0 };
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
The other half of the geometry comparison, and the cautionary one. The same six stars \
and the same noise, but only the three inside a 30 degree window in the north-east are \
used: the observer shot everything in one direction, perhaps because that was the only \
clear patch of sky. \
Every sight still constrains the position to a circle, but three nearly parallel circles \
pin down how far along one line you are and say almost nothing about where you are \
across it. Expect a fix that is much further from the truth, and an error ellipse that \
is long, thin, and honest about it. \
Look at: the ellipse is not just bigger, it is a different SHAPE. The solver knows the \
geometry was poor and says so; the danger would be a solver that reported the same \
confidence for both runs."
        .to_string();
    s
}

// ---------------------------------------------------------------------------
// 3. One bad sight
// ---------------------------------------------------------------------------

/// Demo 3: five sights, the third of them 8 arcminutes too high.
pub fn one_bad_sight() -> Scenario {
    let mut s = Scenario::new(
        "one-bad-sight",
        2_026_100_301,
        PHILADELPHIA,
        DEMO_START_UTC,
        spread_five(),
        Schedule::new(5, 60.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 0.5;
    s.wrong_sight = Some(WrongSight {
        index: 2,
        error_arcmin: 8.0,
    });
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
Five sights, four of them ordinary and one of them wrong: the third sight reads 8 \
arcminutes too high, the sort of mistake that comes from misreading the sextant drum or \
writing down the wrong minute. \
Least squares does not throw it out. It splits the difference, so the fix moves a few \
miles and EVERY residual grows a little, while the bad sight keeps the biggest one. \
Look at: the residual column. One value stands far outside the rest, which is the \
signal that something is wrong with a sight rather than with the position. Then try \
turning on robust weighting and watch the fix move back toward the truth while the \
report says, explicitly, that a sight was downweighted and that the uncertainty is now \
approximate."
        .to_string();
    s
}

// ---------------------------------------------------------------------------
// 4. A shared clock offset
// ---------------------------------------------------------------------------

/// Demo 4: every timestamp is 60 seconds late.
///
/// Noise-free on purpose, so the displacement is exactly the predicted one and nothing
/// else. Raise `altitude_noise_arcmin` for a realistic version.
pub fn clock_offset() -> Scenario {
    let mut s = Scenario::new(
        "clock-offset",
        2_026_100_401,
        PHILADELPHIA,
        DEMO_START_UTC,
        spread_five(),
        Schedule::new(5, 60.0, Ordering::RoundRobin),
    );
    s.clock_offset_s = 60.0;
    s.altitude_noise_arcmin = 0.0;
    s.reported_sigma_arcmin = Some(1.0);
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
Five perfect sights, taken with a watch that is one minute fast. Nothing else is wrong: \
no noise, no bias, no blunder. \
The sky turns 15.04 degrees an hour, so a minute of clock error moves every star's \
tabulated position 0.2507 degrees west, and the only way to reconcile that with what was \
measured is to place the observer 0.2507 degrees of longitude further west too. At \
Philadelphia's latitude that is about 21.3 kilometres, or 11.5 nautical miles. Latitude \
is untouched. \
Look at: the fix is wrong by 21 kilometres and the residuals are ZERO. The data is \
perfectly self-consistent; there is nothing in it to notice. Clock error and longitude \
are the same unknown for star sights, which is why the solver does not offer to estimate \
both. The honest response is to feed the clock's uncertainty in as `clock_uncertainty_s` \
and watch the east-west part of the error ellipse grow to cover it."
        .to_string();
    s
}

// ---------------------------------------------------------------------------
// 5. A shared altitude bias
// ---------------------------------------------------------------------------

/// Demo 5: 24 sights of three stars, every one 3 arcminutes too high.
///
/// The three azimuths (45, 95, 145 degrees) are deliberately lopsided. Three azimuths
/// exactly 120 degrees apart would absorb a shared bias entirely into the residuals and
/// leave the position untouched, which is the special case people wrongly generalise
/// from. Real sights are rarely that symmetric.
pub fn shared_bias() -> Scenario {
    let mut s = Scenario::new(
        "shared-bias",
        2_026_100_501,
        PHILADELPHIA,
        DEMO_START_UTC,
        vec![
            body_at("sim-NorthEast", PHILADELPHIA, 35.0, 45.0),
            body_at("sim-East", PHILADELPHIA, 50.0, 95.0),
            body_at("sim-SouthEast", PHILADELPHIA, 30.0, 145.0),
        ],
        Schedule::new(24, 60.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 0.3;
    s.shared_altitude_bias_arcmin = 3.0;
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
Twenty-four sights of three stars, a minute apart, taken with an instrument that reads 3 \
arcminutes too high on every single one. The random part of each sight is tiny, a third \
of an arcminute. \
Twenty-four sights sounds like plenty, and for random error it is: averaging them shrinks \
the random scatter by a factor of about five, and the solver correctly reports an error \
ellipse only a couple of hundred metres across. But averaging cannot touch an error that \
is the same on every sight. The fix ends up several kilometres from the truth, roughly \
thirty times further out than the ellipse claims. \
Look at: three numbers side by side. The predicted uncertainty is small. The actual error \
is large. The residuals are innocent, because the bias has been quietly absorbed into the \
position rather than left in the leftovers. Taking more sights makes the ellipse smaller \
and the answer no better. This is the difference between random error and systematic \
error, and it is why an instrument's index error has to be measured rather than averaged \
away."
        .to_string();
    s
}

// ---------------------------------------------------------------------------
// 6. One sight, and two
// ---------------------------------------------------------------------------

/// Demo 6a: a single sight. There is no fix, only a circle.
pub fn single_sight() -> Scenario {
    let mut s = Scenario::new(
        "single-sight",
        2_026_100_601,
        PHILADELPHIA,
        DEMO_START_UTC,
        vec![body_at("sim-Alpha", PHILADELPHIA, 45.0, 45.0)],
        Schedule::new(1, 0.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 0.0;
    s.reported_sigma_arcmin = Some(1.0);
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
One sight of one star. Measuring how high a star stands tells you that you are somewhere \
on a circle drawn on the Earth, centred under that star: it does not tell you where on \
that circle. The circle here has a radius of about 2 700 nautical miles. \
Look at: the result is reported as UNDERDETERMINED, with the circle returned and no \
position. That is the correct answer, and it is the point of the demo. A tool that \
offers a latitude and longitude here, perhaps by quietly using the assumed position to \
pick a spot, would be inventing precision that the measurement does not contain."
        .to_string();
    s
}

/// Demo 6b: two sights. Two circles cross in two places.
pub fn two_sight_ambiguous() -> Scenario {
    let mut s = Scenario::new(
        "two-sight-ambiguous",
        2_026_100_602,
        PHILADELPHIA,
        DEMO_START_UTC,
        vec![
            body_at("sim-Alpha", PHILADELPHIA, 40.0, 45.0),
            body_at("sim-Bravo", PHILADELPHIA, 40.0, 135.0),
        ],
        Schedule::new(2, 0.0, Ordering::RoundRobin),
    );
    s.altitude_noise_arcmin = 0.0;
    s.reported_sigma_arcmin = Some(1.0);
    s.assumed_position = dr_offset(25.0, 300.0);
    s.description = "\
Two sights, of two stars 90 degrees apart in bearing. Two circles on a sphere cross in \
two places, and both of them fit the measurements exactly: one is where the observer \
really was, the other is far away, typically on the other side of the world. \
Look at: the result is reported as AMBIGUOUS, with both candidates listed and neither \
promoted. Nothing in the two sights chooses between them. A navigator resolves this with \
outside knowledge (a dead-reckoning position, or which ocean the ship is in), and this \
tool will only use that knowledge if you declare it as a prior and accept that the \
reported uncertainty then includes it. Add a third star in a different direction and the \
ambiguity disappears on its own."
        .to_string();
    s
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/// Every demo scenario that runs without an astronomy provider, in demo order.
pub fn all() -> Vec<Scenario> {
    vec![
        philadelphia_stars(),
        good_geometry(),
        clustered_geometry(),
        one_bad_sight(),
        clock_offset(),
        shared_bias(),
        single_sight(),
        two_sight_ambiguous(),
    ]
}

/// Scenario names in the order [`all`] returns them, for a CLI listing.
pub fn names() -> Vec<String> {
    all().into_iter().map(|s| s.name).collect()
}

/// Look a demo up by name.
///
/// Covers all ten packaged scenarios, including the two [`all`] leaves out:
/// [`philadelphia_stars_named`], which needs an astronomy provider, and
/// [`philadelphia_stars_sextant`], which emits raw sextant readings. `docs/SIMULATOR.md`
/// section 8 lists all ten, so a lookup that reached only eight of them made the
/// documentation wrong.
pub fn by_name(name: &str) -> Option<Scenario> {
    if name == "philadelphia-stars-real" {
        return Some(philadelphia_stars_named());
    }
    if name == "philadelphia-stars-sextant" {
        return Some(philadelphia_stars_sextant());
    }
    all().into_iter().find(|s| s.name == name)
}

/// A scenario emitting raw sextant readings instead of corrected altitudes, so the demo
/// set exercises the correction chain end to end. Same sky as the Philadelphia demo.
pub fn philadelphia_stars_sextant() -> Scenario {
    let mut s = philadelphia_stars();
    s.name = "philadelphia-stars-sextant".to_string();
    s.seed = 2_026_100_103;
    s.altitude_kind = EmittedAltitude::SextantHs {
        height_of_eye_m: 2.0,
        index_correction_arcmin: -1.5,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
    };
    s.description = "\
The Philadelphia star fix again, but the session records what the observer actually read \
off the sextant rather than a corrected altitude. The index error is 1.5 arcminutes on \
the arc, the observer's eye is 2 metres above the sea, and the air is at the standard \
1010 hectopascals and 10 degrees. \
The tool has to undo all of that before it can use the sights: add the index correction, \
subtract the dip of the horizon, subtract refraction. \
Look at: the correction table, one row per step, with the amount and the sign of each. \
The fix should come out in the same place as the corrected-altitude version. If it does \
not, the correction chain is the thing to look at, not the solver."
        .to_string();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::experiment::{bias_shift_ne_m, clock_longitude_shift_deg};
    use crate::generate::simulate_detailed;
    use skyfix_core::time;
    use skyfix_core::types::{AltitudeKind, SESSION_SCHEMA, SessionKind};
    use skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR;

    /// Structural validation, standing in for `skyfix_core::session::validate` until the
    /// reduce agent lands it. Checks what CONVENTIONS section 10 says makes a session
    /// well formed.
    fn validate_structure(session: &skyfix_core::types::Session) -> Result<(), String> {
        if session.schema != SESSION_SCHEMA {
            return Err(format!("schema {:?}", session.schema));
        }
        if session.observations.is_empty() {
            return Err("no observations".into());
        }
        let mut ids: Vec<&str> = session.observations.iter().map(|o| o.id.as_str()).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != n {
            return Err("duplicate observation ids".into());
        }
        for o in &session.observations {
            if o.id.is_empty() || o.body.is_empty() {
                return Err(format!("observation {:?}: empty id or body", o.id));
            }
            time::parse_utc(&o.utc).map_err(|e| format!("observation {}: {e}", o.id))?;
            if !o.altitude_deg.is_finite() || !(-90.0..=90.0).contains(&o.altitude_deg) {
                return Err(format!("observation {}: altitude {}", o.id, o.altitude_deg));
            }
            if !(o.sigma_arcmin.is_finite() && o.sigma_arcmin > 0.0) {
                return Err(format!("observation {}: sigma {}", o.id, o.sigma_arcmin));
            }
            if let Some(g) = o.geocentric {
                if !(0.0..360.0).contains(&g.gha_deg) {
                    return Err(format!("observation {}: gha {}", o.id, g.gha_deg));
                }
                if !(-90.0..=90.0).contains(&g.dec_deg) {
                    return Err(format!("observation {}: dec {}", o.id, g.dec_deg));
                }
            }
        }
        if let Some(p) = session.observer.assumed_position {
            if !(-90.0..=90.0).contains(&p.lat_deg) || p.lon_deg <= -180.0 || p.lon_deg > 180.0 {
                return Err(format!("assumed position {p:?}"));
            }
        }
        if !(session.observer.pressure_hpa.is_finite() && session.observer.pressure_hpa > 0.0) {
            return Err("pressure".into());
        }
        if session.observer.height_of_eye_m < 0.0 {
            return Err("height of eye".into());
        }
        Ok(())
    }

    #[test]
    fn every_demo_generates_and_validates() {
        let mut demos = all();
        demos.push(philadelphia_stars_sextant());
        assert_eq!(demos.len(), 9);
        for s in demos {
            let name = s.name.clone();
            s.check().unwrap_or_else(|e| panic!("{name}: {e}"));
            let sim = simulate_detailed(&s, None).unwrap_or_else(|e| panic!("{name}: {e}"));
            validate_structure(&sim.session).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(sim.session.meta.kind, SessionKind::Simulated, "{name}");
            assert_eq!(sim.session.meta.name, name);
            assert_eq!(sim.truth.session_name, name);
            assert_eq!(sim.truth.position, PHILADELPHIA, "{name}");
            assert!(!s.description.is_empty(), "{name} has no description");
            assert!(
                s.description.contains("Look at"),
                "{name}: the description must say what to look at"
            );
            // Every body is above the horizon for every sight, by construction.
            for t in &sim.sights {
                assert!(
                    t.true_altitude_deg > 0.0,
                    "{name}: {} below horizon",
                    t.body
                );
            }
        }
    }

    #[test]
    fn demo_names_are_unique_and_findable() {
        let names = names();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len());
        for n in &names {
            assert_eq!(by_name(n).unwrap().name, *n);
        }
        // The two that `all()` leaves out must still be findable: docs/SIMULATOR.md
        // section 8 lists ten packaged scenarios, and a lookup reaching only eight
        // would make that documentation wrong.
        for extra in ["philadelphia-stars-real", "philadelphia-stars-sextant"] {
            assert_eq!(
                by_name(extra).unwrap().name,
                extra,
                "{extra} is unreachable"
            );
            assert!(
                !names.contains(&extra.to_string()),
                "{extra} is in all() now"
            );
        }
        assert!(by_name("nope").is_none());
    }

    #[test]
    fn demo_1_is_a_clean_well_spread_five_sight_fix() {
        let sim = simulate_detailed(&philadelphia_stars(), None).unwrap();
        assert_eq!(sim.session.observations.len(), 5);
        let az: Vec<f64> = sim.sights.iter().map(|s| s.true_azimuth_deg).collect();
        // Five sights covering the whole compass: no gap wider than 120 degrees.
        let mut sorted = az.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut gaps: Vec<f64> = sorted.windows(2).map(|w| w[1] - w[0]).collect();
        gaps.push(360.0 - (sorted[4] - sorted[0]));
        assert!(gaps.iter().all(|g| *g < 120.0), "azimuths {sorted:?}");
        for t in &sim.sights {
            assert!(
                (20.0..70.0).contains(&t.true_altitude_deg),
                "{} at {} deg",
                t.body,
                t.true_altitude_deg
            );
            assert!(t.noise_arcmin.abs() < 5.0 * 0.8);
        }
        assert_eq!(sim.truth.shared_altitude_bias_arcmin, 0.0);
        assert_eq!(sim.truth.clock_offset_s, 0.0);
        assert!(sim.truth.wrong_sight_ids.is_empty());
    }

    #[test]
    fn demo_2_differs_only_in_geometry() {
        let good = simulate_detailed(&good_geometry(), None).unwrap();
        let bad = simulate_detailed(&clustered_geometry(), None).unwrap();
        assert_eq!(good.session.observations.len(), 6);
        assert_eq!(bad.session.observations.len(), 6);
        assert_eq!(
            good.truth.seed, bad.truth.seed,
            "same seed, same noise draws"
        );
        // The same noise values, attached to the same schedule slots.
        for (a, b) in good.sights.iter().zip(&bad.sights) {
            assert_eq!(a.noise_arcmin, b.noise_arcmin);
        }
        // The clustered run uses three bodies inside a 30 degree window; the good one
        // uses all six, spread.
        let bad_bodies: std::collections::BTreeSet<&str> =
            bad.sights.iter().map(|s| s.body.as_str()).collect();
        assert_eq!(bad_bodies.len(), 3, "{bad_bodies:?}");
        let good_bodies: std::collections::BTreeSet<&str> =
            good.sights.iter().map(|s| s.body.as_str()).collect();
        assert_eq!(good_bodies.len(), 6);
        let spread = |sim: &crate::generate::Simulation| {
            let mut az: Vec<f64> = sim.sights.iter().map(|s| s.true_azimuth_deg).collect();
            az.sort_by(|a, b| a.partial_cmp(b).unwrap());
            az[az.len() - 1] - az[0]
        };
        assert!(spread(&bad) < 35.0, "clustered spread {}", spread(&bad));
        assert!(spread(&good) > 250.0, "good spread {}", spread(&good));
    }

    #[test]
    fn demo_3_puts_eight_arcminutes_on_exactly_one_sight() {
        let sim = simulate_detailed(&one_bad_sight(), None).unwrap();
        assert_eq!(sim.truth.wrong_sight_ids, vec!["obs-3".to_string()]);
        let blunders: Vec<f64> = sim.sights.iter().map(|s| s.blunder_arcmin).collect();
        assert_eq!(blunders, vec![0.0, 0.0, 8.0, 0.0, 0.0]);
        // The bad sight really is about 8 arcminutes off, noise included.
        let bad = &sim.sights[2];
        assert!((bad.total_error_arcmin() - 8.0).abs() < 2.0);
        // ...and it is far outside what the others do.
        for (i, t) in sim.sights.iter().enumerate() {
            if i != 2 {
                assert!(t.total_error_arcmin().abs() < 2.0, "sight {i}");
            }
        }
    }

    #[test]
    fn demo_4_shifts_every_timestamp_by_a_minute() {
        let s = clock_offset();
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(sim.truth.clock_offset_s, 60.0);
        for (obs, t) in sim.session.observations.iter().zip(&sim.sights) {
            let d = (time::parse_utc(&obs.utc).unwrap() - t.true_jd_utc) * 86_400.0;
            assert!((d - 60.0).abs() < 1e-3, "{d}");
            // Noise free: the altitude in the session is the true altitude.
            assert!((obs.altitude_deg - t.true_altitude_deg).abs() < 1e-12);
        }
        // The predicted longitude displacement, stated in the description.
        let shift = clock_longitude_shift_deg(SIDEREAL_RATE_DEG_PER_HOUR, 60.0);
        assert!(
            (shift + 0.250_684).abs() < 1e-6,
            "the description promises 0.2507 deg west, got {shift}"
        );
        assert!(s.description.contains("0.2507"));
    }

    #[test]
    fn demo_5_bias_moves_the_fix_kilometres_while_the_ellipse_stays_small() {
        let s = shared_bias();
        let sim = simulate_detailed(&s, None).unwrap();
        assert_eq!(sim.session.observations.len(), 24);
        assert_eq!(sim.truth.shared_altitude_bias_arcmin, 3.0);
        // Every sight carries the same bias.
        assert!(sim.sights.iter().all(|t| t.bias_arcmin == 3.0));
        // Three bodies, eight sights each.
        let mut counts = std::collections::BTreeMap::new();
        for t in &sim.sights {
            *counts.entry(t.body.clone()).or_insert(0) += 1;
        }
        assert_eq!(counts.len(), 3);
        assert!(counts.values().all(|c| *c == 8), "{counts:?}");

        let az: Vec<f64> = sim.sights.iter().map(|t| t.true_azimuth_deg).collect();
        let sig: Vec<f64> = sim
            .session
            .observations
            .iter()
            .map(|o| o.sigma_arcmin)
            .collect();
        let (dn, de) = bias_shift_ne_m(&az, &sig, 3.0).unwrap();
        // Regression values for the planner to check the solver against, computed from
        // the closed form on this scenario's own azimuths (2026-09-23). The azimuths
        // drift a little over the 23 minutes of the schedule, so these are not the
        // textbook values for 45/95/145 degrees exactly.
        assert!((dn + 846.45).abs() < 0.5, "north shift {dn} m");
        assert!((de - 6_964.31).abs() < 0.5, "east shift {de} m");
        assert!((dn.hypot(de) - 7_015.56).abs() < 0.5);

        // The predicted 1-sigma from 24 sights at 0.3 arcminutes is a couple of hundred
        // metres: the error is more than twenty times the uncertainty.
        let (mut m00, mut m01, mut m11) = (0.0, 0.0, 0.0);
        for (z, sg) in az.iter().zip(&sig) {
            let w = 1.0 / (sg * sg);
            let (sn, cs) = z.to_radians().sin_cos();
            m00 += w * cs * cs;
            m01 += w * cs * sn;
            m11 += w * sn * sn;
        }
        let det = m00 * m11 - m01 * m01;
        let sigma_n_m = (m11 / det).sqrt() * 1852.0;
        let sigma_e_m = (m00 / det).sqrt() * 1852.0;
        assert!(
            (sigma_n_m - 177.56).abs() < 0.5,
            "sigma north {sigma_n_m} m"
        );
        assert!((sigma_e_m - 147.68).abs() < 0.5, "sigma east {sigma_e_m} m");
        let predicted = sigma_n_m.hypot(sigma_e_m);
        assert!(
            (predicted - 230.95).abs() < 0.5,
            "radial sigma {predicted} m"
        );
        let ratio = dn.hypot(de) / predicted;
        assert!(
            (ratio - 30.38).abs() < 0.1,
            "error / predicted sigma = {ratio}"
        );
    }

    #[test]
    fn demo_6_is_one_sight_and_two() {
        let one = simulate_detailed(&single_sight(), None).unwrap();
        assert_eq!(one.session.observations.len(), 1);
        let two = simulate_detailed(&two_sight_ambiguous(), None).unwrap();
        assert_eq!(two.session.observations.len(), 2);
        // The two bodies are 90 degrees apart in azimuth, which is the best possible
        // two-sight geometry and still ambiguous.
        let a = two.sights[0].true_azimuth_deg;
        let b = two.sights[1].true_azimuth_deg;
        assert!(((b - a).abs() - 90.0).abs() < 1e-6, "{a} and {b}");
        // Both are noise free, so the ambiguity is geometric rather than numerical.
        assert!(two.sights.iter().all(|t| t.noise_arcmin == 0.0));
    }

    #[test]
    fn the_sextant_demo_emits_raw_readings_with_the_instrument_declared() {
        let sim = simulate_detailed(&philadelphia_stars_sextant(), None).unwrap();
        assert_eq!(sim.session.observer.height_of_eye_m, 2.0);
        assert_eq!(sim.session.instrument.index_correction_arcmin, -1.5);
        for (obs, t) in sim.session.observations.iter().zip(&sim.sights) {
            assert_eq!(obs.altitude_kind, AltitudeKind::SextantHs);
            // The raw reading differs from the corrected altitude by dip + refraction
            // + the index correction: a few arcminutes, and always upward here.
            let diff_arcmin = (obs.altitude_deg - t.emitted_ho_deg) * 60.0;
            assert!(
                (2.0..8.0).contains(&diff_arcmin),
                "{}: raw reading is {diff_arcmin} arcmin above Ho",
                obs.id
            );
        }
        assert!(sim.session.meta.notes.contains("raw sextant readings"));
    }

    #[test]
    fn demos_are_stable_across_calls() {
        for (a, b) in all().into_iter().zip(all()) {
            assert_eq!(a, b, "a demo scenario must be a constant");
        }
        let x = serde_json::to_string(&simulate_detailed(&shared_bias(), None).unwrap().session)
            .unwrap();
        let y = serde_json::to_string(&simulate_detailed(&shared_bias(), None).unwrap().session)
            .unwrap();
        assert_eq!(x, y);
    }

    #[test]
    fn no_demo_hands_the_solver_the_truth() {
        let mut demos = all();
        demos.push(philadelphia_stars_named());
        demos.push(philadelphia_stars_sextant());
        for s in demos {
            assert!(
                !matches!(s.assumed_position.mode, AssumedPositionMode::Truth),
                "{}: a packaged demo must not use the truth as its assumed position",
                s.name
            );
            assert_eq!(
                s.assumed_position.role,
                AssumedPositionRole::Initializer,
                "{}: a packaged demo's assumed position must stay an initializer",
                s.name
            );
        }
    }
}
