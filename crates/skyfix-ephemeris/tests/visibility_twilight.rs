//! The Sun-altitude flag: the one piece of "weather" the planner models, and it is not
//! weather at all — it is geometry, supplied by the caller.

use skyfix_core::planner::Candidate;
use skyfix_ephemeris::visibility::{
    CIVIL_TWILIGHT_DEG, NAUTICAL_TWILIGHT_DEG, NOTE_DARK, NOTE_NAUTICAL, NOTE_SUN_UNKNOWN,
    NOTE_TOO_BRIGHT, sun_altitude_flag, sun_altitude_note,
};

#[test]
fn the_three_bands_and_the_honest_fourth_case() {
    assert_eq!(sun_altitude_note(Some(30.0)), NOTE_TOO_BRIGHT);
    assert_eq!(sun_altitude_note(Some(0.0)), NOTE_TOO_BRIGHT);
    assert_eq!(sun_altitude_note(Some(-5.9)), NOTE_TOO_BRIGHT);
    // The boundaries themselves belong to the nautical-twilight band.
    assert_eq!(sun_altitude_note(Some(CIVIL_TWILIGHT_DEG)), NOTE_NAUTICAL);
    assert_eq!(sun_altitude_note(Some(-9.0)), NOTE_NAUTICAL);
    assert_eq!(
        sun_altitude_note(Some(NAUTICAL_TWILIGHT_DEG)),
        NOTE_NAUTICAL
    );
    assert_eq!(sun_altitude_note(Some(-12.1)), NOTE_DARK);
    assert_eq!(sun_altitude_note(Some(-60.0)), NOTE_DARK);
    // No Sun provider, no guess.
    assert_eq!(sun_altitude_note(None), NOTE_SUN_UNKNOWN);
    assert_eq!(sun_altitude_note(Some(f64::NAN)), NOTE_SUN_UNKNOWN);

    // The sentences say the useful thing, not just a band name.
    assert!(NOTE_NAUTICAL.contains("horizon and stars both visible"));
    assert!(NOTE_DARK.contains("artificial horizon or electronic vertical"));
}

#[test]
fn the_flag_reaches_stars_and_leaves_the_sun_alone() {
    let mut candidates = vec![
        Candidate::new("Vega", 61.0, 280.0, 1.0),
        Candidate::new("Sun", 20.0, 180.0, 1.0),
        Candidate::new("Altair", 54.0, 214.0, 1.0),
    ];
    sun_altitude_flag(&mut candidates, Some(-9.0));
    assert_eq!(candidates[0].note, NOTE_NAUTICAL);
    assert_eq!(candidates[2].note, NOTE_NAUTICAL);
    assert_eq!(
        candidates[1].note, "",
        "telling a Sun sight that the sky is too bright for stars is nonsense"
    );

    // Case-insensitive on the body name, as everywhere else in the project.
    let mut sun = vec![Candidate::new("sun", 20.0, 180.0, 1.0)];
    sun_altitude_flag(&mut sun, Some(-9.0));
    assert_eq!(sun[0].note, "");
}

#[test]
fn an_existing_note_is_kept_and_the_flag_is_never_doubled() {
    let mut candidates = vec![Candidate {
        body: "Vega".to_string(),
        altitude_deg: 61.0,
        azimuth_deg: 280.0,
        sigma_arcmin: 1.0,
        magnitude: Some(0.03),
        note: "shot from the marina".to_string(),
    }];
    sun_altitude_flag(&mut candidates, Some(-20.0));
    assert_eq!(
        candidates[0].note,
        format!("shot from the marina; {NOTE_DARK}")
    );
    // Applying it twice must not stutter.
    sun_altitude_flag(&mut candidates, Some(-20.0));
    assert_eq!(
        candidates[0].note,
        format!("shot from the marina; {NOTE_DARK}")
    );
    assert_eq!(candidates[0].note.matches(NOTE_DARK).count(), 1);

    // An empty list is fine.
    sun_altitude_flag(&mut [], Some(-20.0));
}

#[test]
fn an_unknown_sun_altitude_says_so_rather_than_assuming_darkness() {
    let mut candidates = vec![Candidate::new("Vega", 61.0, 280.0, 1.0)];
    sun_altitude_flag(&mut candidates, None);
    assert_eq!(candidates[0].note, NOTE_SUN_UNKNOWN);
    assert!(
        !candidates[0].note.contains("stars visible"),
        "an unknown Sun altitude must not be reported as a usable observing condition"
    );
}
