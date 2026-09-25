//! Deep-sky visibility agrees with `sky_state` (EXPLORER_API.md, "Deep sky"): the path
//! every deep-sky object, radiant and the galactic centre takes (`observe::Frame` for the
//! apparent place, `observe::SiteFrame` for altitude and azimuth) is held to the
//! explorer's own `sky_state` for all 58 navigational stars, pushed through it with their
//! navigation-catalogue positions, proper motions and parallaxes, at several instants
//! and sites from the equator to 78 degrees.

use skyfix_almanac::sky::sky_state;
use skyfix_core::time::civil_to_jd;
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
                let (ra, dec) = frame.apparent_star(
                    star.ra_j2000_deg,
                    star.dec_j2000_deg,
                    star.pm_ra_cosdec_mas_per_year,
                    star.pm_dec_mas_per_year,
                    star.parallax_mas,
                );
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
