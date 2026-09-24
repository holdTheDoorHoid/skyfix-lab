//! The Sun model against worked examples published in Jean Meeus,
//! *Astronomical Algorithms*, 2nd edition (Willmann-Bell, 1998).
//!
//! These are independent numbers: they were computed by someone else, from the same
//! theory but a different implementation, and printed in a book. They are the closest
//! thing to ground truth available without the Skyfield fixtures.

use approx::assert_relative_eq;
use skyfix_core::time::{TT_MINUS_TAI_S, civil_to_jd, delta_at};
use skyfix_ephemeris::sun::SunProvider;

/// Meeus quotes his examples in TD (= TT). Invert `jd_tt` to get the `jd_utc` this
/// crate takes. Two passes are plenty: the leap-second table is a step function of a
/// quantity that moves by 69 s.
fn jd_utc_for_tt(jd_tt_target: f64) -> f64 {
    let mut guess = jd_tt_target;
    for _ in 0..4 {
        guess = jd_tt_target - (delta_at(guess) + TT_MINUS_TAI_S) / 86_400.0;
    }
    guess
}

fn arcsec(deg: f64) -> f64 {
    deg * 3600.0
}

/// **Meeus Example 25.b** — 1992 October 13 at 0h TD, the high-accuracy (VSOP87) method.
///
/// Published results: apparent longitude `199d 54' 21".56`, apparent right ascension
/// `13h 13m 30s.749`, apparent declination `-7d 47' 01".74`, radius vector
/// `0.99760853 au`, nutation `dpsi = +15".908`, `deps = -0".308`.
///
/// The parenthesised values in the task brief (199.90895 deg, 13h13m31.4s,
/// -7d47'06") are Example 25.**a**, the *low-accuracy* method, which Meeus states is
/// good to about 0.01 deg. Both are checked here: 25.b tightly, because this crate
/// implements that method, and 25.a loosely, at the accuracy its own method claims.
#[test]
fn meeus_25b_high_accuracy_sun() {
    let jd_utc = jd_utc_for_tt(civil_to_jd(1992, 10, 13));
    let p = SunProvider::new().position(jd_utc).unwrap();

    assert_relative_eq!(p.jd_tt, 2_448_908.5, epsilon = 1e-9);

    // Radius vector, au.
    assert_relative_eq!(p.radius_au, 0.997_608_53, epsilon = 5e-8);

    // Nutation, arcseconds. Meeus uses IAU 1980; this crate uses IAU 2000B, which
    // differs from it by a few hundredths of an arcsecond.
    assert_relative_eq!(p.nutation_longitude_arcsec, 15.908, epsilon = 0.02);
    assert_relative_eq!(p.nutation_obliquity_arcsec, -0.308, epsilon = 0.02);

    // Apparent longitude 199d 54' 21".56.
    let lambda = 199.0 + 54.0 / 60.0 + 21.56 / 3600.0;
    assert!(
        arcsec((p.apparent_longitude_deg - lambda).abs()) < 0.1,
        "apparent longitude off by {:.4}\" (got {:.7} deg, Meeus {lambda:.7} deg)",
        arcsec(p.apparent_longitude_deg - lambda),
        p.apparent_longitude_deg
    );

    // Apparent RA 13h 13m 30s.749 -> degrees.
    let ra = (13.0 + 13.0 / 60.0 + 30.749 / 3600.0) * 15.0;
    assert!(
        arcsec((p.ra_deg - ra).abs()) < 0.1,
        "apparent RA off by {:.4}\" (got {:.7} deg, Meeus {ra:.7} deg)",
        arcsec(p.ra_deg - ra),
        p.ra_deg
    );

    // Apparent Dec -7d 47' 01".74.
    let dec = -(7.0 + 47.0 / 60.0 + 1.74 / 3600.0);
    assert!(
        arcsec((p.dec_deg - dec).abs()) < 0.1,
        "apparent Dec off by {:.4}\" (got {:.7} deg, Meeus {dec:.7} deg)",
        arcsec(p.dec_deg - dec),
        p.dec_deg
    );
}

/// **Meeus Example 25.a** — the same instant by the *low-accuracy* method, whose stated
/// accuracy is about 0.01 deg in longitude. Its published results are apparent
/// longitude 199.90895 deg, RA 13h13m31.4s and Dec -7d47'06".
///
/// This test exists to show that the high-accuracy model agrees with the low-accuracy
/// one to within the low-accuracy method's own error, and to pin how far apart they
/// really are: about 10.7" in longitude and RA, 4.3" in declination. Anyone comparing
/// this crate against the 25.a numbers should expect exactly that gap.
#[test]
fn meeus_25a_low_accuracy_sun_agrees_within_its_own_error() {
    let jd_utc = jd_utc_for_tt(civil_to_jd(1992, 10, 13));
    let p = SunProvider::new().position(jd_utc).unwrap();

    let d_lambda = arcsec(p.apparent_longitude_deg - 199.908_95);
    let d_ra = arcsec(p.ra_deg - (13.0 + 13.0 / 60.0 + 31.4 / 3600.0) * 15.0);
    let d_dec = arcsec(p.dec_deg + (7.0 + 47.0 / 60.0 + 6.0 / 3600.0));

    // Inside 0.01 deg = 36", the accuracy Meeus claims for the 25.a method.
    assert!(d_lambda.abs() < 36.0, "longitude gap {d_lambda:.2}\"");
    assert!(d_ra.abs() < 36.0, "RA gap {d_ra:.2}\"");
    assert!(d_dec.abs() < 36.0, "Dec gap {d_dec:.2}\"");

    // And pin the gap, so a regression that moved the model onto the low-accuracy
    // answer would be caught rather than silently accepted.
    assert!(
        (8.0..14.0).contains(&d_lambda.abs()),
        "expected the 25.a gap in longitude to be about 10.7\", got {d_lambda:.2}\""
    );
    assert!(
        (2.0..7.0).contains(&d_dec.abs()),
        "expected the 25.a gap in declination to be about 4.3\", got {d_dec:.2}\""
    );
}

/// **Meeus Example 28.b** — equation of time, 1992 October 13 at 0h TD: `E = +13m 42s.6`.
#[test]
fn meeus_28b_equation_of_time() {
    let jd_utc = jd_utc_for_tt(civil_to_jd(1992, 10, 13));
    let e = skyfix_ephemeris::sun::equation_of_time_min(jd_utc).unwrap();
    let expected = 13.0 + 42.6 / 60.0;
    assert!(
        (e - expected).abs() < 0.01,
        "equation of time {e:.5} min, Meeus {expected:.5} min"
    );
}

/// Semidiameter and horizontal parallax at the same instant, from the published
/// radius vector: `959.63" / 0.99760853 = 961.93" = 16.0322'` and
/// `8.794" / 0.99760853 = 8.8151" = 0.14692'`.
#[test]
fn meeus_25b_semidiameter_and_parallax() {
    let jd_utc = jd_utc_for_tt(civil_to_jd(1992, 10, 13));
    let p = SunProvider::new().position(jd_utc).unwrap();
    assert_relative_eq!(
        p.semidiameter_arcmin,
        959.63 / 60.0 / 0.997_608_53,
        epsilon = 1e-5
    );
    assert_relative_eq!(
        p.horizontal_parallax_arcmin,
        8.794 / 60.0 / 0.997_608_53,
        epsilon = 1e-7
    );
    // The value CONVENTIONS section 5 step 5 quotes for the Sun.
    assert_relative_eq!(p.horizontal_parallax_arcmin, 0.146, epsilon = 0.001);
}
