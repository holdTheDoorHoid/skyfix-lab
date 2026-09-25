//! Deep-sky visibility agrees with `sky_state` (EXPLORER_API.md, "Deep sky"): the path
//! every deep-sky object, radiant and the galactic centre takes (`observe::Frame` for the
//! apparent place, `observe::SiteFrame` for altitude and azimuth) is held to the
//! explorer's own `sky_state` for all 58 navigational stars, pushed through it with their
//! navigation-catalogue places and parallaxes, at several instants and sites from the
//! equator to 78 degrees. (deeptime agent: the catalogue's stars move by rigorous space
//! motion with radial velocities, and Rigil Kentaurus on its orbit, which the frame's
//! linear-from-J2000 proper motion is not meant to reproduce; so each star enters here at
//! its barycentric place of the instant, with no proper motion, and the test isolates the
//! frame chain as it always meant to.)

use skyfix_almanac::sky::sky_state;
use skyfix_core::time::{civil_to_jd, jd_tt};
use skyfix_ephemeris::body::Sky;
use skyfix_ephemeris::catalog::navigational_stars;
use skyfix_ephemeris::topocentric::Site;
use skyfix_starfield::observe::{Frame, SiteFrame};

#[test]
fn fixed_objects_follow_sky_state_to_a_microarcsecond() {
    let sky = Sky::new();
    let sites = [
        Site {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
            height_m: 12.0,
            ..Site::default()
        },
        Site::new(0.0, 0.0),
        Site {
            lat_deg: -33.87,
            lon_deg: 151.21,
            height_m: 50.0,
            pressure_hpa: 980.0,
            temperature_c: 25.0,
        },
        Site::new(78.22, 15.65),
    ];
    let instants = [
        civil_to_jd(1995, 3, 1) + 0.1,
        civil_to_jd(2026, 9, 24) + 0.5,
        civil_to_jd(2044, 12, 31) + 0.9,
    ];
    let names: Vec<&str> = navigational_stars()
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    let (mut worst_alt, mut worst_az, mut n) = (0.0f64, 0.0f64, 0);
    for site in &sites {
        let sf = SiteFrame::new(site);
        for &jd in &instants {
            let state = sky_state(&sky, site, jd, &names).unwrap();
            assert!(state.errors.is_empty(), "{:?}", state.errors);
            let frame = Frame::at(jd).unwrap();
            for star in navigational_stars() {
                let b = state.bodies.iter().find(|b| b.body == star.name).unwrap();
                let (ra0, dec0) = skyfix_ephemeris::frames::radec_from_vector(
                    star.barycentric_direction(jd_tt(jd)),
                );
                let (ra, dec) = frame.apparent_star(ra0, dec0, 0.0, 0.0, star.parallax_mas);
                let h = sf.horizontal(frame.gha_deg(ra), dec);
                let d_alt = (h.alt_deg - b.alt_deg).abs() * 3600.0;
                let d_az = ((h.az_deg - b.az_deg + 540.0).rem_euclid(360.0) - 180.0).abs()
                    * 3600.0
                    * b.alt_deg.to_radians().cos();
                let d_app = (h.alt_apparent_deg - b.alt_apparent_deg).abs() * 3600.0;
                worst_alt = worst_alt.max(d_alt).max(d_app);
                worst_az = worst_az.max(d_az);
                n += 1;
            }
        }
    }
    println!(
        "{n} star-instants: worst altitude {worst_alt:.2e}\", azimuth on the sky {worst_az:.2e}\""
    );
    assert_eq!(n, 58 * 12);
    assert!(
        worst_alt < 1e-3 && worst_az < 1e-3,
        "{worst_alt} {worst_az}"
    );
}
