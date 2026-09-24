//! Generates and then guards the session fixtures under `tests/data/`.
//! OWNER: cli agent.
//!
//! The fixtures are committed so that `docs/CLI.md` can quote real output and so that a
//! reviewer without a Rust toolchain can read the inputs. They are *derived*, though,
//! not typed: this test rebuilds each one from the truth position and the star provider
//! and fails if the committed file has drifted.
//!
//! To regenerate after a deliberate change:
//!
//! ```text
//! SKYFIX_WRITE_FIXTURES=1 cargo test -p skyfix-cli --test fixtures
//! ```
//!
//! A drift this test catches is a real finding, not a chore: the sessions encode a
//! particular sky, and if the star provider's numbers move, every worked example in the
//! documentation moved with them.

mod support;

use skyfix_core::types::{
    AssumedPositionRole, HorizonMode, Instrument, LatLon, Observer, TRUTH_SCHEMA, Truth,
};
use support::{PHL, SessionBuilder, data_file};

/// The four stars: a real Philadelphia sky, spread 80 to 100 degrees apart in azimuth,
/// all between 50 and 56 degrees altitude. Chosen for spread, not for brightness —
/// conditioning is what makes a fix, and it is what the brief asks the planner to rank
/// by (see `skyfix coverage` for where the directions come from).
const FOUR: [&str; 4] = ["Schedar", "Markab", "Altair", "Eltanin"];

/// An assumed position about 45 NM from the truth: far enough that a solver which
/// merely returned its starting point would fail the 10 m test by four orders of
/// magnitude.
const ASSUMED: LatLon = LatLon {
    lat_deg: 40.5,
    lon_deg: -75.8,
};

fn four_star_json() -> String {
    let mut b = SessionBuilder::new(
        "Philadelphia four-star, supplied directions",
        "Apparent geocentric directions from skyfix-ephemeris StarProvider at the stated \
         instant; each observed_ho is the exact altitude at the truth position under the \
         spherical model, with no noise. Truth lives in phl.truth.json and is never read by \
         the solver.",
    )
    .observer(Observer {
        assumed_position: Some(ASSUMED),
        assumed_position_role: AssumedPositionRole::Initializer,
        ..Observer::default()
    });
    for (i, name) in FOUR.iter().enumerate() {
        b = b.observed_ho(&format!("obs-{}", i + 1), name, PHL, 1.0);
    }
    b.json()
}

fn two_star_json() -> String {
    SessionBuilder::new(
        "Philadelphia two-star, ambiguous",
        "Two circles of position cross in two places and nothing here chooses between them. \
         No assumed position on purpose: a prior would hide the ambiguity rather than \
         resolve it.",
    )
    .observed_ho("obs-1", "Schedar", PHL, 1.0)
    .observed_ho("obs-2", "Markab", PHL, 1.0)
    .json()
}

fn one_star_json() -> String {
    SessionBuilder::new(
        "Philadelphia one-star, underdetermined",
        "One altitude is a circle of position, not a point.",
    )
    .observed_ho("obs-1", "Vega", PHL, 1.0)
    .json()
}

fn sextant_json() -> String {
    let observer = Observer {
        height_of_eye_m: 2.5,
        pressure_hpa: 1013.25,
        temperature_c: 7.5,
        assumed_position: Some(ASSUMED),
        assumed_position_role: AssumedPositionRole::Initializer,
    };
    let instrument = Instrument {
        name: "simulated sextant, 2.0' index error on the arc".to_string(),
        index_correction_arcmin: -2.0,
        horizon: HorizonMode::Sea,
    };
    let mut b = SessionBuilder::new(
        "Philadelphia four-star, raw sextant readings",
        "The same sky as phl_four_star, recorded as raw sextant_hs readings: index error 2.0' \
         on the arc, 2.5 m height of eye, 1013.25 hPa and 7.5 C. Each reading is the value \
         that reduces to the exact Ho at the truth position, so reducing it forwards must \
         land back on the truth. obs-4 was taken with a reflected artificial horizon, so its \
         reading is the double angle and its sigma describes that double angle.",
    )
    .observer(observer)
    .instrument(instrument);
    for (i, name) in FOUR.iter().enumerate() {
        let id = format!("obs-{}", i + 1);
        if i == 3 {
            b = b.sextant(&id, name, PHL, 2.0, Some(HorizonMode::ArtificialReflected));
        } else {
            b = b.sextant(&id, name, PHL, 1.0, None);
        }
    }
    b.json()
}

fn truth_json() -> String {
    let truth = Truth {
        schema: TRUTH_SCHEMA.to_string(),
        session_name: "Philadelphia four-star".to_string(),
        position: PHL,
        seed: 0,
        clock_offset_s: 0.0,
        shared_altitude_bias_arcmin: 0.0,
        wrong_sight_ids: Vec::new(),
        notes: "Philadelphia City Hall. Noise-free fixtures: the only error in a fix from \
                these sessions is numerical."
            .to_string(),
    };
    let mut s = serde_json::to_string_pretty(&truth).expect("truth serialises");
    s.push('\n');
    s
}

/// How far a committed number may sit from a freshly generated one: 1e-8 degrees is
/// 0.04 milliarcseconds, under a tenth of a millimetre of position. Anything a reader
/// would call a change in the sky is orders of magnitude larger.
const NUMERIC_TOLERANCE: f64 = 1e-8;

#[test]
fn committed_fixtures_match_their_generator() {
    let wanted: Vec<(&str, String)> = vec![
        ("phl_four_star.session.json", four_star_json()),
        ("phl_two_star.session.json", two_star_json()),
        ("phl_one_star.session.json", one_star_json()),
        ("phl_sextant.session.json", sextant_json()),
        ("phl.truth.json", truth_json()),
    ];

    let write = std::env::var("SKYFIX_WRITE_FIXTURES").is_ok();
    if write {
        std::fs::create_dir_all(support::data_dir()).expect("tests/data is writable");
    }
    for (name, text) in wanted {
        let path = data_file(name);
        if write {
            std::fs::write(&path, &text).expect("tests/data is writable");
            continue;
        }
        let found = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "cannot read {}: {e}. Regenerate with \
                 SKYFIX_WRITE_FIXTURES=1 cargo test -p skyfix-cli --test fixtures",
                path.display()
            )
        });
        let committed: serde_json::Value =
            serde_json::from_str(&found).expect("the committed fixture is JSON");
        let generated: serde_json::Value =
            serde_json::from_str(&text).expect("the generator emits JSON");
        if let Err(what) = support::json_close(&committed, &generated, NUMERIC_TOLERANCE, name) {
            panic!(
                "{} has drifted from its generator: {what}. If the sky model changed on \
                 purpose, regenerate with SKYFIX_WRITE_FIXTURES=1 and re-check every worked \
                 example in docs/CLI.md",
                path.display()
            );
        }
    }
}

/// The point of the fixtures: reducing them at the truth position gives a zero
/// intercept. If this fails, the fixtures no longer describe the truth they claim to.
#[test]
fn every_fixture_altitude_is_the_truth_altitude() {
    for name in [
        "phl_four_star.session.json",
        "phl_two_star.session.json",
        "phl_one_star.session.json",
        "phl_sextant.session.json",
    ] {
        let text = std::fs::read_to_string(data_file(name)).expect("fixture exists");
        let (session, _) = skyfix_core::session::parse_session(&text).expect("fixture is valid");
        let mut at_truth = session.clone();
        at_truth.observer.assumed_position = Some(PHL);
        at_truth.observer.assumed_position_role = AssumedPositionRole::Initializer;
        let reduced = skyfix_core::reduce::reduce_session(
            &at_truth,
            &skyfix_core::reduce::SuppliedOnly,
        );
        for r in reduced {
            let r = r.unwrap_or_else(|e| panic!("{name}: {e}"));
            let intercept = r.intercept_nm.expect("the truth position was supplied");
            assert!(
                intercept.abs() < 1e-9,
                "{name} {}: intercept {intercept} NM at the truth position, expected 0",
                r.id
            );
        }
    }
}

/// The sextant fixture must exercise the whole chain, or it is not testing it.
#[test]
fn the_sextant_fixture_exercises_every_correction_kind() {
    use skyfix_core::types::CorrectionKind::*;

    let text = std::fs::read_to_string(data_file("phl_sextant.session.json")).expect("fixture");
    let (session, _) = skyfix_core::session::parse_session(&text).expect("valid");
    let reduced =
        skyfix_core::reduce::reduce_session(&session, &skyfix_core::reduce::SuppliedOnly);
    let mut applied = std::collections::BTreeSet::new();
    for r in reduced {
        for step in &r.expect("reduces").corrections.steps {
            if step.applied {
                applied.insert(format!("{:?}", step.kind));
            }
        }
    }
    for kind in [IndexCorrection, Dip, ArtificialHorizonHalving, Refraction] {
        assert!(
            applied.contains(&format!("{kind:?}")),
            "{kind:?} is never applied in the sextant fixture; applied = {applied:?}"
        );
    }
    // Semidiameter and parallax are Sun-only (CONVENTIONS section 5) and no provider in
    // this build covers the Sun, so they are exercised by every_field.session.json,
    // which supplies the Sun's direction by hand.
}
