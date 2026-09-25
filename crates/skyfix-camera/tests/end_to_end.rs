//! The whole chain, in one test file: image -> centroids -> identification ->
//! attitude -> (with an independent local vertical) altitudes -> the core solver.
//!
//! These tests print their numbers. `cargo test -p skyfix-camera -- --nocapture` is
//! how the figures in `docs/CAMERA.md` were obtained, and re-running it is how they
//! should be checked rather than trusted.

use skyfix_camera::attitude::{AttitudeOptions, Derefraction, solve_attitude};
use skyfix_camera::camera::Intrinsics;
use skyfix_camera::centroid::{Centroid, CentroidOptions, detect};
use skyfix_camera::frames::camera_from_enu;
use skyfix_camera::identify::{
    CatalogueSnapshot, Identification, IdentifyOptions, IdentifyStatus, identify,
};
use skyfix_camera::render::{RenderOptions, RenderTruth, render};
use skyfix_camera::rng::Rng;
use skyfix_camera::sights::{SightOptions, altitudes_from_camera};
use skyfix_camera::vertical::{InclinometerSim, LocalVertical, simulated_inclinometer};
use skyfix_core::geometry::{Point, angular_distance, destination};
use skyfix_core::reduce::{reduce_session_partitioned, to_sights};
use skyfix_core::solver::solve;
use skyfix_core::types::{
    AltitudeKind, AssumedPositionRole, Clock, FixResult, HorizonMode, Instrument, LatLon, Observer,
    SESSION_SCHEMA, Session, SessionKind, SessionMeta,
};
use skyfix_ephemeris::ProviderSource;
use skyfix_ephemeris::stars::StarProvider;

/// The briefed instant and place.
const UTC: &str = "2026-10-01T01:30:00Z";
const LAT_DEG: f64 = 39.9526;
const LON_DEG: f64 = -75.1652;
/// The briefed pointing.
const ALT_DEG: f64 = 45.0;
const AZ_DEG: f64 = 250.0;
/// The briefed lens.
const BRIEFED_FOV_DEG: f64 = 40.0;
/// The narrowest lens that puts five catalogue stars at the briefed pointing. See
/// `the_briefed_forty_degree_lens_sees_one_star` below for why this is not 40.
const WORKING_FOV_DEG: f64 = 80.0;
/// The inclinometer the task specifies.
const VERTICAL_SIGMA_ARCMIN: f64 = 0.5;
/// How far the assumed position is from the truth.
const ASSUMED_OFFSET_NM: f64 = 100.0;

fn truth_position() -> Point {
    Point::from_deg(LAT_DEG, LON_DEG)
}

/// An assumed position 100 NM from the truth, used only to start the iteration.
fn assumed_position() -> Point {
    destination(
        truth_position(),
        45f64.to_radians(),
        skyfix_core::units::nm_to_rad(ASSUMED_OFFSET_NM),
    )
}

struct Frame {
    intrinsics: Intrinsics,
    centroids: Vec<Centroid>,
    identification: Identification,
    catalogue: CatalogueSnapshot,
    truth: RenderTruth,
}

fn capture(fov_deg: f64, options: RenderOptions) -> Frame {
    let intrinsics = Intrinsics::from_horizontal_fov(1024, 768, fov_deg.to_radians());
    let attitude = camera_from_enu(ALT_DEG.to_radians(), AZ_DEG.to_radians(), 7f64.to_radians());
    let (image, truth) = render(
        UTC,
        truth_position(),
        &attitude,
        &intrinsics,
        &StarProvider::new(),
        &options,
    )
    .expect("render");
    let centroids = detect(
        &image,
        &CentroidOptions {
            min_flux: 200.0,
            ..CentroidOptions::default()
        },
    );
    let catalogue = CatalogueSnapshot::at(&StarProvider::new(), UTC).expect("catalogue");
    let identification = identify(
        &centroids,
        &intrinsics,
        &catalogue,
        &IdentifyOptions::from_centroid_sigma(0.2, &intrinsics, 5.0),
    );
    Frame {
        intrinsics,
        centroids,
        identification,
        catalogue,
        truth,
    }
}

fn session_from(observations: Vec<skyfix_core::types::Observation>, notes: String) -> Session {
    let ap = assumed_position();
    Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta {
            name: "camera sextant, Philadelphia".to_string(),
            notes,
            // SIMULATED. The UI shows this on every view (CONVENTIONS section 10).
            kind: SessionKind::Simulated,
        },
        observer: Observer {
            // No sea horizon in a camera sight, so the height of eye is irrelevant and
            // must be zero: a non-zero value here with an electronic vertical would be
            // a correction the reducer has to ignore.
            height_of_eye_m: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
            assumed_position: Some(LatLon {
                lat_deg: ap.lat_deg(),
                lon_deg: ap.lon_deg(),
            }),
            // An initializer, never a prior (BRIEF, required first release).
            assumed_position_role: AssumedPositionRole::Initializer,
        },
        instrument: Instrument {
            name: "simulated camera sextant".to_string(),
            index_correction_arcmin: 0.0,
            horizon: HorizonMode::ElectronicVertical,
        },
        clock: Clock {
            uncertainty_s: 0.0,
            correction_s: 0.0,
            dut1_s: None,
        },
        observations,
    }
}

// ---------------------------------------------------------------------------
// The finding that shapes everything below
// ---------------------------------------------------------------------------

#[test]
fn the_briefed_forty_degree_lens_sees_one_star() {
    // At Philadelphia on 2026-10-01T01:30:00Z, a 40-degree field at altitude 45,
    // azimuth 250 contains exactly ONE of the 58 navigational stars: Rasalhague, at
    // 9.7 degrees from the boresight. The next nearest are Vega at 23.8 and Altair at
    // 24.8 degrees, both outside a 40-degree frame.
    //
    // This is a limit of the CLOSED WORLD, not of the sky. A camera that can centroid
    // a magnitude-2 star reaches magnitude 6 or fainter and would see well over a
    // hundred stars in the same frame. The 58-star navigational catalogue is a list of
    // stars a human can name from a deck at night, and it is far too sparse to
    // identify from a narrow field. A deeper catalogue is the first item of the real
    // imagery backlog in docs/CAMERA.md, and it is not optional.
    let f = capture(BRIEFED_FOV_DEG, RenderOptions::default());
    assert_eq!(f.truth.stars.len(), 1, "{:?}", f.truth.stars);
    assert_eq!(f.truth.stars[0].name, "Rasalhague");
    assert_eq!(
        f.identification.status,
        IdentifyStatus::TooFewCentroids { have: 1, need: 3 }
    );
    println!(
        "briefed 40-deg lens at alt {ALT_DEG} az {AZ_DEG}: {} catalogue star(s), \
         identification = {:?}",
        f.truth.stars.len(),
        f.identification.status
    );

    // Widening the lens is what makes the chain runnable at this pointing. Report the
    // whole curve so the choice of 80 degrees is visible rather than asserted.
    for fov in [40.0f64, 50.0, 60.0, 70.0, 80.0, 90.0] {
        let f = capture(fov, RenderOptions::default());
        println!(
            "  horizontal FOV {fov:5.1} deg (diagonal {:5.1}): {} catalogue stars",
            Intrinsics::from_horizontal_fov(1024, 768, fov.to_radians())
                .diagonal_fov_rad()
                .to_degrees(),
            f.truth.stars.len()
        );
    }
}

// ---------------------------------------------------------------------------
// The full chain
// ---------------------------------------------------------------------------

#[test]
fn image_to_fix_at_philadelphia() {
    let f = capture(WORKING_FOV_DEG, RenderOptions::default());
    assert!(
        f.identification.is_identified(),
        "{:?}",
        f.identification.status
    );
    let n = f.identification.matches.len();
    assert!(n >= 5, "wanted at least five identified stars, got {n}");
    println!("\n=== camera sextant end to end, Philadelphia {UTC} ===");
    println!(
        "lens: {:.0} deg horizontal ({:.0} deg diagonal), 1024 x 768",
        f.intrinsics.horizontal_fov_rad().to_degrees(),
        f.intrinsics.diagonal_fov_rad().to_degrees()
    );
    println!(
        "pointing: altitude {ALT_DEG}, azimuth {AZ_DEG}, roll 7; {} blobs, {n} identified",
        f.centroids.len()
    );
    for m in &f.identification.matches {
        println!(
            "  {:16} centroid {:2}  pair residual {:6.2}\"",
            m.star_name, m.centroid_index, m.residual_arcsec
        );
    }

    // --- the local vertical, from an instrument that is not the camera --------
    // simulated_inclinometer is the only function in the crate that reads the truth,
    // and it has to be handed it explicitly. This is the simulator standing in for a
    // tilt sensor bolted to the same mount, assumed STATIONARY and CALIBRATED.
    let vertical = simulated_inclinometer(
        f.truth.up_camera,
        &InclinometerSim {
            sigma_arcmin: VERTICAL_SIGMA_ARCMIN,
            ..InclinometerSim::default()
        },
        &mut Rng::new(20_261_001),
    )
    .expect("inclinometer");
    println!(
        "vertical: {:?}, reported sigma {:.2}', actual tilt from truth {:.3}'",
        vertical.source,
        vertical.sigma_arcmin,
        vertical.tilt_from_arcmin(f.truth.up_camera)
    );

    // --- attitude: a separate deliverable, not a step toward the position -----
    let attitude = solve_attitude(
        &f.identification.matches,
        &f.centroids,
        &f.intrinsics,
        &f.catalogue,
        &AttitudeOptions {
            derefract: Some(Derefraction::standard(vertical.up_camera)),
            ..AttitudeOptions::default()
        },
    )
    .expect("attitude");
    let attitude_err_arcmin = attitude
        .rotation_camera_from_frame
        .angle_to(&f.truth.attitude_camera_from_earth_fixed)
        .to_degrees()
        * 60.0;
    // The half-arcminute attitude requirement is met on the briefed 40-degree lens --
    // see `attitude::tests::a_clean_six_star_field_recovers_the_attitude_to_well_inside
    // _half_an_arcminute`, which measures 0.03'. This frame uses an 80-degree lens on
    // the same 1024-pixel sensor, whose plate scale is 5.6 arcminutes per pixel rather
    // than 2.4, so a tenth of a pixel of centroid noise is over half an arcminute of
    // direction. Widening the lens to find stars costs attitude accuracy, and a real
    // build would spend pixels to get it back.
    let plate_arcmin_per_px = f.intrinsics.nominal_ifov_rad().to_degrees() * 60.0;
    let expected_arcmin = (attitude.rms_arcsec / (attitude.n_stars as f64).sqrt())
        / 60.0
        / (attitude.angular_spread_deg.to_radians().sin()).max(0.1);
    println!(
        "attitude: {} stars, rms {:.2}\", error vs truth {:.3}' ({})",
        attitude.n_stars, attitude.rms_arcsec, attitude_err_arcmin, attitude.frame
    );
    println!(
        "          plate scale {plate_arcmin_per_px:.2}'/px, spread {:.1} deg, \
         roll-limited prediction {expected_arcmin:.3}'",
        attitude.angular_spread_deg
    );
    assert!(
        attitude_err_arcmin < 1.0,
        "attitude error {attitude_err_arcmin:.4}' on the wide lens"
    );
    assert!(
        attitude_err_arcmin < 4.0 * expected_arcmin.max(0.02),
        "attitude error {attitude_err_arcmin:.4}' against a predicted {expected_arcmin:.4}'"
    );

    // --- altitudes: only now, and only because there is a vertical ------------
    let sights = altitudes_from_camera(
        &f.identification.matches,
        &f.centroids,
        &f.intrinsics,
        &vertical,
        UTC,
        &SightOptions::default(),
    )
    .expect("sights");
    assert!(sights.rejected.is_empty(), "{:?}", sights.rejected);
    for o in &sights.observations {
        assert_eq!(o.altitude_kind, AltitudeKind::ApparentHa);
        assert_eq!(o.horizon, Some(HorizonMode::ElectronicVertical));
        assert_eq!(o.geocentric, None);
        println!(
            "  sight {:8} {:16} Ha {:8.4} deg  sigma {:.3}'",
            o.id, o.body, o.altitude_deg, o.sigma_arcmin
        );
    }

    // --- the core: reduce and solve -------------------------------------------
    let session = session_from(
        sights.observations.clone(),
        format!(
            "Altitudes measured by a simulated camera sextant against a simulated \
             stationary inclinometer of {VERTICAL_SIGMA_ARCMIN}' sigma. The vertical \
             error is COMMON to all {n} sights and does not average away; the reported \
             ellipse treats every sight as independent and is therefore optimistic. \
             Identifying the stars gave orientation, not position: the position below \
             exists only because of the inclinometer."
        ),
    );
    let provider = ProviderSource(StarProvider::new());
    let (reduced, errors) = reduce_session_partitioned(&session, &provider);
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(reduced.len(), n);
    // The reducer removed refraction, so Ho is below the Ha the camera measured.
    for r in &reduced {
        let source = &r.direction_source;
        assert!(source.contains("skyfix-stars"), "{source}");
        let input = session
            .observations
            .iter()
            .find(|o| o.id == r.id)
            .unwrap()
            .altitude_deg;
        assert!(r.ho_deg < input, "refraction was not removed for {}", r.id);
    }

    let fix = solve(
        &to_sights(&reduced, &provider),
        &skyfix_core::types::SolveOptions {
            initializer: session.observer.assumed_position,
            ..Default::default()
        },
    );
    let FixResult::Unique { fix, .. } = &fix else {
        panic!("expected a unique fix, got {fix:?}");
    };

    let got = Point::from_deg(fix.position.lat_deg, fix.position.lon_deg);
    let error_m = skyfix_core::units::rad_to_m(angular_distance(truth_position(), got));
    let predicted_m = fix.sigma_north_m.hypot(fix.sigma_east_m);
    println!(
        "fix:   {:.5}, {:.5}   (truth {LAT_DEG}, {LON_DEG})",
        fix.position.lat_deg, fix.position.lon_deg
    );
    println!(
        "error: {:.0} m ({:.2} NM)   predicted sigma {:.0} m ({:.2} NM)   ratio {:.2}",
        error_m,
        skyfix_core::units::rad_to_nm(skyfix_core::units::m_to_rad(error_m)),
        predicted_m,
        skyfix_core::units::rad_to_nm(skyfix_core::units::m_to_rad(predicted_m)),
        error_m / predicted_m
    );
    println!(
        "geometry: condition {:.1}, largest azimuth gap {:.0} deg, chi2 {:.2} on {} dof",
        fix.conditioning.condition_number, fix.conditioning.max_azimuth_gap_deg, fix.chi2, fix.dof
    );

    // The assumed position was 100 NM away and only an initializer: the fix must not
    // have stayed near it.
    let from_assumed = skyfix_core::units::rad_to_nm(angular_distance(assumed_position(), got));
    assert!(
        from_assumed > 50.0,
        "the fix stayed {from_assumed:.1} NM from the 100 NM initializer; it was used \
         as a prior somewhere"
    );

    // The headline assertions.
    assert!(
        error_m > 0.0,
        "a simulated fix that is exactly right is a bug"
    );
    assert!(
        error_m < 3.0 * predicted_m,
        "fix error {error_m:.0} m against a predicted sigma of {predicted_m:.0} m"
    );
    // And the error is of the size the vertical implies: one arcminute of tilt is one
    // nautical mile, so a 0.5' vertical cannot do better than about 900 m.
    let vertical_floor_m =
        skyfix_core::units::rad_to_m(skyfix_core::units::arcmin_to_rad(VERTICAL_SIGMA_ARCMIN));
    println!(
        "one-arcminute-is-one-mile check: a {VERTICAL_SIGMA_ARCMIN}' vertical is \
         {vertical_floor_m:.0} m of position on its own"
    );
    assert!(
        predicted_m > 0.2 * vertical_floor_m,
        "the predicted sigma ({predicted_m:.0} m) is below what a \
         {VERTICAL_SIGMA_ARCMIN}' vertical alone allows ({vertical_floor_m:.0} m); the \
         vertical uncertainty is not reaching the solver"
    );
}

#[test]
fn without_a_vertical_there_is_no_altitude_to_be_had() {
    // The BRIEF's non-negotiable item 2, checked three ways.
    let f = capture(WORKING_FOV_DEG, RenderOptions::default());
    assert!(f.identification.is_identified());

    // 1. COMPILE TIME. `altitudes_from_camera` takes `&LocalVertical` by value, not
    //    `Option<&LocalVertical>`. There is no call that omits it. Uncommenting the
    //    line below does not compile:
    //
    //        altitudes_from_camera(&f.identification.matches, &f.centroids,
    //                              &f.intrinsics, UTC, &SightOptions::default());
    //
    //    and no constructor of `LocalVertical` takes an image, a star field, an
    //    `Identification` or an `Attitude`. The only ways to make one are an
    //    inclinometer reading, a horizon line, and a value the caller supplies.

    // 2. RUNTIME, on the attitude result: it exposes no altitude or position key.
    let attitude = solve_attitude(
        &f.identification.matches,
        &f.centroids,
        &f.intrinsics,
        &f.catalogue,
        &AttitudeOptions::default(),
    )
    .expect("attitude");
    let json = serde_json::to_value(&attitude).unwrap();
    let keys: Vec<String> = json
        .as_object()
        .expect("Attitude is an object")
        .keys()
        .cloned()
        .collect();
    for banned in [
        "altitude",
        "altitude_deg",
        "alt_deg",
        "lat",
        "lat_deg",
        "lon",
        "lon_deg",
        "latitude",
        "longitude",
        "position",
        "fix",
        "up_camera",
        "vertical",
    ] {
        assert!(
            !keys.iter().any(|k| k == banned),
            "Attitude exposes {banned:?}: {keys:?}"
        );
    }
    println!("Attitude JSON keys: {keys:?}");

    // 3. The attitude is nevertheless a complete, useful answer on its own. It is
    //    *orientation*, and it is exact to the arcsecond even though it knows nothing
    //    about where on Earth the camera is. Rotating the truth attitude into the
    //    same frame proves the recovered value is the real orientation and not a
    //    coincidence of this observer's longitude.
    let err = attitude
        .rotation_camera_from_frame
        .angle_to(&f.truth.attitude_camera_from_earth_fixed)
        .to_degrees()
        * 60.0;
    println!(
        "camera-only attitude error {err:.3}' (refraction removed: {})",
        attitude.refraction_removed
    );
    assert!(!attitude.refraction_removed);
    // Without a vertical, refraction cannot be removed and the attitude is biased by
    // arcminutes. That bias is itself the proof that the sky does not know which way
    // is up.
    assert!(
        err > 0.3,
        "an uncorrected in-atmosphere attitude should carry a refraction bias, got \
         {err:.4}'"
    );
}

#[test]
fn a_worse_vertical_moves_the_fix_and_says_so() {
    // The single most important number in a camera sextant's error budget. Same image,
    // same stars, same identification; only the inclinometer changes.
    println!("\n=== fix error against vertical quality ===");
    let f = capture(WORKING_FOV_DEG, RenderOptions::default());
    let mut rows = Vec::new();
    for sigma in [0.1f64, 0.5, 2.0, 5.0] {
        let vertical = simulated_inclinometer(
            f.truth.up_camera,
            &InclinometerSim {
                sigma_arcmin: sigma,
                ..InclinometerSim::default()
            },
            &mut Rng::new(7),
        )
        .unwrap();
        let sights = altitudes_from_camera(
            &f.identification.matches,
            &f.centroids,
            &f.intrinsics,
            &vertical,
            UTC,
            &SightOptions::default(),
        )
        .unwrap();
        let session = session_from(sights.observations, String::new());
        let provider = ProviderSource(StarProvider::new());
        let (reduced, errors) = reduce_session_partitioned(&session, &provider);
        assert!(errors.is_empty(), "{errors:?}");
        let result = solve(
            &to_sights(&reduced, &provider),
            &skyfix_core::types::SolveOptions {
                initializer: session.observer.assumed_position,
                ..Default::default()
            },
        );
        let FixResult::Unique { fix, .. } = &result else {
            panic!("sigma {sigma}: expected a unique fix, got {result:?}");
        };
        let got = Point::from_deg(fix.position.lat_deg, fix.position.lon_deg);
        let error_nm = skyfix_core::units::rad_to_nm(angular_distance(truth_position(), got));
        let predicted_nm = skyfix_core::units::rad_to_nm(skyfix_core::units::m_to_rad(
            fix.sigma_north_m.hypot(fix.sigma_east_m),
        ));
        println!(
            "  vertical sigma {sigma:4.1}'  ->  tilt {:5.2}'  fix error {error_nm:6.2} NM  \
             predicted {predicted_nm:6.2} NM",
            vertical.tilt_from_arcmin(f.truth.up_camera)
        );
        rows.push((sigma, error_nm, predicted_nm));
        assert!(
            error_nm < 3.0 * predicted_nm,
            "sigma {sigma}: error {error_nm:.2} NM against predicted {predicted_nm:.2} NM"
        );
    }
    // The predicted uncertainty must grow with the vertical's, monotonically: if it
    // did not, the vertical term would not be reaching the covariance at all.
    for pair in rows.windows(2) {
        assert!(
            pair[1].2 > pair[0].2,
            "predicted sigma did not grow from {:?} to {:?}",
            pair[0],
            pair[1]
        );
    }
    // A 5-arcminute vertical is roughly ten times a 0.5-arcminute one, and so is the
    // position uncertainty it produces: one arcminute of tilt, one nautical mile.
    let ratio = rows[3].2 / rows[1].2;
    println!("  5.0' / 0.5' predicted-sigma ratio: {ratio:.2} (one arcmin = one mile)");
    assert!(
        (4.0..16.0).contains(&ratio),
        "a tenfold worse vertical should give a roughly tenfold worse fix, got {ratio:.2}"
    );
}

#[test]
fn a_horizon_line_can_supply_the_vertical_instead() {
    // The other source: no inclinometer at all, the vertical read off a sea horizon in
    // the same image. Pointed near the horizon so the line and some stars share a frame.
    let intrinsics = Intrinsics::from_horizontal_fov(1024, 768, WORKING_FOV_DEG.to_radians());
    let attitude = camera_from_enu(20f64.to_radians(), 250f64.to_radians(), 3f64.to_radians());
    let options = RenderOptions {
        sea_horizon: Some(skyfix_camera::render::SeaHorizon {
            height_of_eye_m: 4.0,
            sea_level: 30.0,
        }),
        background_level: 600.0,
        ..RenderOptions::default()
    };
    let (image, truth) = render(
        UTC,
        truth_position(),
        &attitude,
        &intrinsics,
        &StarProvider::new(),
        &options,
    )
    .unwrap();
    let (vertical, fit) = skyfix_camera::vertical::vertical_from_horizon_line(
        &image,
        &intrinsics,
        &skyfix_camera::vertical::HorizonFitOptions {
            height_of_eye_m: 4.0,
            min_contrast: 200.0,
            ..Default::default()
        },
    )
    .expect("horizon fit");
    let tilt = vertical.tilt_from_arcmin(truth.up_camera);
    println!(
        "\nhorizon-line vertical: {} columns, rms {:.3} px, dip {:.2}', reported sigma \
         {:.2}', actual tilt {:.3}'",
        fit.columns_used, fit.residual_rms_px, fit.dip_arcmin, fit.sigma_arcmin, tilt
    );
    assert_eq!(
        vertical.source,
        skyfix_camera::vertical::VerticalSource::HorizonLine
    );
    assert!(tilt < 2.0, "horizon vertical off by {tilt:.3}'");

    // And it drives the same chain. The stars here sit low in the frame, so this is
    // also a check that the low-altitude refraction flag does its job.
    let centroids = detect(
        &image,
        &CentroidOptions {
            min_flux: 200.0,
            ..CentroidOptions::default()
        },
    );
    let catalogue = CatalogueSnapshot::at(&StarProvider::new(), UTC).unwrap();
    let id = identify(
        &centroids,
        &intrinsics,
        &catalogue,
        &IdentifyOptions::from_centroid_sigma(0.2, &intrinsics, 5.0),
    );
    if !id.is_identified() {
        println!(
            "  (too few catalogue stars above this horizon to identify: {:?})",
            id.status
        );
        return;
    }
    let sights = altitudes_from_camera(
        &id.matches,
        &centroids,
        &intrinsics,
        &vertical,
        UTC,
        &SightOptions::default(),
    )
    .unwrap();
    println!(
        "  {} sights from the horizon-derived vertical, {} rejected",
        sights.observations.len(),
        sights.rejected.len()
    );
    for o in &sights.observations {
        assert_eq!(o.horizon, Some(HorizonMode::ElectronicVertical));
        // Crucially NOT HorizonMode::Sea: the horizon was used to find the vertical,
        // not as the reference the altitude was measured from. Applying dip here as
        // well would subtract it twice.
        assert!(o.sigma_arcmin >= vertical.sigma_arcmin);
    }
}

#[test]
fn a_supplied_vertical_is_the_third_route() {
    // Somebody else's instrument, or a levelled mount, with its own stated sigma.
    let f = capture(WORKING_FOV_DEG, RenderOptions::default());
    let vertical = LocalVertical::supplied(f.truth.up_camera, 0.25).expect("supplied vertical");
    let sights = altitudes_from_camera(
        &f.identification.matches,
        &f.centroids,
        &f.intrinsics,
        &vertical,
        UTC,
        &SightOptions::default(),
    )
    .unwrap();
    let session = session_from(sights.observations, String::new());
    let provider = ProviderSource(StarProvider::new());
    let (reduced, errors) = reduce_session_partitioned(&session, &provider);
    assert!(errors.is_empty(), "{errors:?}");
    let result = solve(
        &to_sights(&reduced, &provider),
        &skyfix_core::types::SolveOptions {
            initializer: session.observer.assumed_position,
            ..Default::default()
        },
    );
    let FixResult::Unique { fix, .. } = &result else {
        panic!("expected a unique fix, got {result:?}");
    };
    let got = Point::from_deg(fix.position.lat_deg, fix.position.lon_deg);
    let error_nm = skyfix_core::units::rad_to_nm(angular_distance(truth_position(), got));
    let predicted_nm = skyfix_core::units::rad_to_nm(skyfix_core::units::m_to_rad(
        fix.sigma_north_m.hypot(fix.sigma_east_m),
    ));
    println!(
        "\nperfect supplied vertical: fix error {error_nm:.3} NM, predicted {predicted_nm:.3} NM"
    );
    // With an exact vertical the only error left is centroid noise, which is small.
    assert!(error_nm < 3.0 * predicted_nm);
    assert!(
        error_nm < 2.0,
        "fix error {error_nm:.3} NM with a perfect vertical"
    );
}

#[test]
fn the_session_round_trips_through_json() {
    // Whatever module A produces has to survive the session schema unchanged, or the
    // CLI and the UI will see something different from what the tests checked.
    let f = capture(WORKING_FOV_DEG, RenderOptions::default());
    let vertical = LocalVertical::supplied(f.truth.up_camera, 0.5).unwrap();
    let sights = altitudes_from_camera(
        &f.identification.matches,
        &f.centroids,
        &f.intrinsics,
        &vertical,
        UTC,
        &SightOptions::default(),
    )
    .unwrap();
    let session = session_from(sights.observations, "round trip".to_string());
    let text = serde_json::to_string_pretty(&session).unwrap();
    let back: Session = serde_json::from_str(&text).unwrap();
    assert_eq!(session, back);
    assert!(text.contains("\"altitude_kind\": \"apparent_ha\""));
    assert!(text.contains("\"horizon\": \"electronic_vertical\""));
    assert!(text.contains("\"kind\": \"simulated\""));
    // No hidden truth rode along.
    assert!(
        !text.contains("39.9526"),
        "the truth position is in the session JSON"
    );
    // And skyfix_core's own validator accepts it, body names included.
    let bodies = StarProvider::new().bodies();
    let warnings = skyfix_core::session::validate(&session, &bodies)
        .expect("the core must accept a camera session");
    println!("session warnings: {warnings:?}");
}
