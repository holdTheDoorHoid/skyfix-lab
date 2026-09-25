//! A batch that runs past the providers' coverage keeps its good windows
//! (EXPLORER_API.md, day_events_batch).

use skyfix_almanac::events::{EventOptions, day_events_batch};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::topocentric::Site;

#[test]
fn a_window_past_coverage_is_reported_not_fatal() {
    let sky = Sky::new();
    let site = Site::new(39.95, -75.17);
    // Local days in New York (UTC-5): 2650-01-20 is covered; 2650-01-21 ends at
    // 2650-01-22T05:00Z, past the Sun's coverage (the validated tier ends
    // 2650-01-22T00:00Z); 2650-01-22 is wholly outside it.
    let day = |jd0: f64| (jd0 + 5.0 / 24.0, jd0 + 1.0 + 5.0 / 24.0);
    let windows = vec![day(2_688_971.5), day(2_688_972.5), day(2_688_973.5)];
    let out = day_events_batch(&sky, &site, &windows, &["Sun"], &EventOptions::default())
        .expect("the batch as a whole succeeds");
    assert_eq!(out.len(), 3);
    assert!(!out[0].phases.is_empty(), "a covered day has its phases");
    for late in &out[1..] {
        assert!(late.phases.is_empty() && late.bodies.is_empty());
        assert_eq!(late.errors.len(), 1, "{:?}", late.errors);
        assert_eq!(late.errors[0].body, "Sun");
    }
}
