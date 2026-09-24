//! Moon and planet sights against Skyfield's sky (CONVENTIONS sections 5 and 11).
//!
//! `fixtures/reference/moon_planet_sights.json` (tools/reference/gen_moon_sights.py,
//! Skyfield + JPL DE440s) holds raw sextant readings built from the topocentric sky on
//! two Earths. Three things are checked for every case:
//!
//! 1. **Arithmetic.** `correct_sight` reproduces `chain_ho_deg`, the amended section 5
//!    chain transcribed in Python from the text, to 1e-6 arcmin.
//! 2. **The model.** On the `sphere` Earth (the Earth of CONVENTIONS section 1) the
//!    reduced Ho lands within 0.01' of the geocentric altitude at the site; on the
//!    `wgs84` Earth within the residual the file records for that body class (the
//!    Moon's is the parallax the sphere leaves out, up to about 0.22').
//! 3. **The providers.** Reduced with the auto composition (Sun, Moon, sight planets,
//!    stars) instead of the supplied DE440s directions, Ho still agrees with the
//!    provider's own Hc at the site within the sphere tolerance plus the provider's
//!    documented accuracy.
//!
//! The four `reference-moon-*` sessions are then reduced and solved end to end with
//! ephemeris "auto" and the known position recovered.

use std::collections::BTreeMap;

use serde::Deserialize;
use skyfix_core::corrections::{CorrectionInputs, SightBody, correct_sight, sight_body};
use skyfix_core::geometry::{Point, altitude_azimuth};
use skyfix_core::reduce::{DirectionSource, reduce_session_partitioned, to_sights};
use skyfix_core::solver::solve;
use skyfix_core::types::{
    AltitudeKind, FixResult, GeocentricDirection, HorizonMode, Limb, Session, SolveOptions, Truth,
};
use skyfix_ephemeris::fixture_pack::CompositeProvider;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sights::SightPlanetProvider;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::{AstroProvider, ProviderSource};

const FIXTURE: &str = "fixtures/reference/moon_planet_sights.json";

fn repo_path(rel: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn auto() -> CompositeProvider {
    CompositeProvider::new("test-auto")
        .with(SunProvider::new())
        .with(MoonProvider::new())
        .with(SightPlanetProvider::new())
        .with(StarProvider::new())
}

#[derive(Debug, Deserialize)]
struct File {
    schema: String,
    generator: Generator,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Generator {
    tolerance_arcmin: f64,
    arithmetic_tolerance_arcmin: f64,
    worst_chain_minus_expected_arcmin: BTreeMap<String, f64>,
}

#[derive(Debug, Deserialize)]
struct Site {
    lat_deg: f64,
    lon_deg: f64,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    earth: String,
    utc: String,
    site: Site,
    body: String,
    kind: String,
    limb: Limb,
    horizon: HorizonMode,
    height_of_eye_m: f64,
    index_correction_arcmin: f64,
    pressure_hpa: f64,
    temperature_c: f64,
    hs_deg: f64,
    geocentric: GeocentricDirection,
    expected_ho_deg: f64,
    chain_ho_deg: f64,
}

fn load() -> File {
    let text = std::fs::read_to_string(repo_path(FIXTURE)).expect("fixture present");
    let f: File = serde_json::from_str(&text).expect("fixture parses");
    assert_eq!(f.schema, "skyfix.reference/1");
    f
}

fn inputs<'a>(c: &'a Case, direction: GeocentricDirection) -> CorrectionInputs<'a> {
    CorrectionInputs {
        id: &c.id,
        is_sun: c.body == "Sun",
        limb: c.limb,
        horizon: c.horizon,
        index_correction_arcmin: c.index_correction_arcmin,
        height_of_eye_m: c.height_of_eye_m,
        pressure_hpa: c.pressure_hpa,
        temperature_c: c.temperature_c,
        direction: Some(direction),
    }
}

fn class_name(b: SightBody) -> &'static str {
    match b {
        SightBody::Sun => "sun",
        SightBody::Moon => "moon",
        SightBody::Planet => "planet",
        SightBody::Star => "star",
    }
}

#[test]
fn the_chain_reproduces_the_text_and_skyfields_sky() {
    let f = load();
    assert!(f.cases.len() > 300, "{} cases", f.cases.len());
    let mut worst_arith = 0.0f64;
    let mut worst_model: BTreeMap<String, f64> = BTreeMap::new();
    for c in &f.cases {
        let class = sight_body(&c.body);
        assert_eq!(class_name(class), c.kind, "{}: {}", c.id, c.body);
        let b = correct_sight(
            c.hs_deg,
            AltitudeKind::SextantHs,
            1.0,
            inputs(c, c.geocentric),
            class,
        )
        .unwrap_or_else(|e| panic!("{}: {e}", c.id));

        // 1. Arithmetic against the Python transcription of section 5.
        let arith = (b.ho_deg - c.chain_ho_deg).abs() * 60.0;
        worst_arith = worst_arith.max(arith);
        assert!(
            arith <= f.generator.arithmetic_tolerance_arcmin,
            "{} {}: Rust {} vs text {} ({arith:e}')",
            c.id,
            c.body,
            b.ho_deg,
            c.chain_ho_deg
        );
        // Chain continuity: the breakdown lands on Ho.
        assert_eq!(b.steps.last().unwrap().after_deg, b.ho_deg, "{}", c.id);

        // 2. The model against Skyfield's sky.
        let resid = (b.ho_deg - c.expected_ho_deg).abs() * 60.0;
        let key = format!("{}/{}", c.earth, c.kind);
        let bound = if c.earth == "sphere" {
            f.generator.tolerance_arcmin
        } else {
            f.generator.worst_chain_minus_expected_arcmin[&key] + 0.002
        };
        assert!(
            resid <= bound,
            "{} {} {} on the {} Earth: Ho {} vs geocentric {} ({resid:.4}' > {bound:.4}')",
            c.id,
            c.body,
            c.utc,
            c.earth,
            b.ho_deg,
            c.expected_ho_deg
        );
        let w = worst_model.entry(key).or_insert(0.0);
        *w = w.max(resid);
    }
    println!("worst arithmetic difference {worst_arith:.2e}'");
    for (k, v) in &worst_model {
        println!("worst |Ho - geocentric altitude| {k:<14} {v:.4}'");
    }
    // The sphere is where the chain is exact: only diurnal aberration (0.3") is left.
    for (k, v) in &worst_model {
        if k.starts_with("sphere") {
            assert!(*v < 0.01, "{k}: {v}");
        }
    }
    // The real Earth's Moon parallax is the one thing the sphere leaves out, and it is
    // not small: this is the number CONVENTIONS section 5 and ACCURACY.md quote.
    let moon = worst_model["wgs84/moon"];
    assert!((0.1..0.25).contains(&moon), "wgs84 Moon residual {moon}");
}

#[test]
fn the_auto_providers_reduce_the_same_sights() {
    let f = load();
    let provider = auto();
    let mut worst: BTreeMap<&str, f64> = BTreeMap::new();
    for c in f.cases.iter().filter(|c| c.earth == "sphere") {
        let jd = skyfix_core::time::parse_utc(&c.utc).unwrap();
        let d = provider
            .geocentric(&c.body, jd)
            .unwrap_or_else(|e| panic!("{}: {e}", c.id));
        let class = sight_body(&c.body);
        let b = correct_sight(c.hs_deg, AltitudeKind::SextantHs, 1.0, inputs(c, d), class)
            .unwrap_or_else(|e| panic!("{}: {e}", c.id));
        let (hc, _) = altitude_azimuth(
            Point::from_deg(c.site.lat_deg, c.site.lon_deg),
            d.gha_deg.to_radians(),
            d.dec_deg.to_radians(),
        );
        let resid = (b.ho_deg - hc.to_degrees()).abs() * 60.0;
        // The sphere tolerance plus each provider's documented accuracy.
        let accuracy = match class {
            SightBody::Moon => skyfix_ephemeris::moon::MOON_ACCURACY_ARCMIN,
            SightBody::Planet => 0.01,
            SightBody::Sun => 0.01,
            SightBody::Star => 0.02,
        };
        let bound = f.generator.tolerance_arcmin + accuracy;
        assert!(
            resid <= bound,
            "{} {}: provider Ho - Hc = {resid:.4}' > {bound}'",
            c.id,
            c.body
        );
        let w = worst.entry(class_name(class)).or_insert(0.0);
        *w = w.max(resid);
    }
    for (k, v) in &worst {
        println!("provider path, sphere Earth, worst |Ho - Hc| {k:<7} {v:.4}'");
    }
}

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

/// Metres between two positions on the CONVENTIONS section 1 sphere.
fn miss_m(a: skyfix_core::types::LatLon, b: skyfix_core::types::LatLon) -> f64 {
    skyfix_core::units::rad_to_m(skyfix_core::geometry::angular_distance(
        Point::from_deg(a.lat_deg, a.lon_deg),
        Point::from_deg(b.lat_deg, b.lon_deg),
    ))
}

fn solve_session(name: &str) -> (f64, Session, Vec<skyfix_core::types::Sight>) {
    let session: Session = serde_json::from_str(
        &std::fs::read_to_string(repo_path(&format!("fixtures/sessions/{name}.json")))
            .expect("session present"),
    )
    .expect("session parses");
    let truth: Truth = serde_json::from_str(
        &std::fs::read_to_string(repo_path(&format!("fixtures/expected/{name}.truth.json")))
            .expect("truth present"),
    )
    .expect("truth parses");
    skyfix_core::session::validate(&session, &skyfix_ephemeris::sights::sight_bodies())
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    let source = ProviderSource(auto());
    let (reduced, rejected) = reduce_session_partitioned(&session, &source);
    assert!(rejected.is_empty(), "{name}: {rejected:?}");
    for r in &reduced {
        assert!(
            r.observation_uses_provider(),
            "{name} {}: every direction must come from the ephemeris",
            r.id
        );
    }
    let sights = to_sights(&reduced, &source);
    let options = SolveOptions {
        initializer: session.observer.assumed_position,
        ..SolveOptions::default()
    };
    match solve(&sights, &options) {
        FixResult::Unique { fix, .. } => (miss_m(fix.position, truth.position), session, sights),
        other => panic!("{name}: expected a unique fix, got {other:?}"),
    }
}

trait UsesProvider {
    fn observation_uses_provider(&self) -> bool;
}

impl UsesProvider for skyfix_core::types::ReducedSight {
    fn observation_uses_provider(&self) -> bool {
        self.direction_source != skyfix_core::reduce::SUPPLIED_DIRECTION_SOURCE
    }
}

#[test]
fn moon_and_planet_sessions_recover_the_known_position() {
    // On the spherical Earth CONVENTIONS section 1 reduces on, the only errors left are
    // the providers' (0.02' at most) and diurnal aberration: tens of metres at most.
    // On the WGS84 Earth the Moon's parallax differs from the sphere's by up to 0.22',
    // which moves these fixes by a few tens of metres more (docs/NAVIGATION_SKY.md).
    for (name, bound_m) in [
        ("reference-moon-planets-atlantic-sphere", 15.0),
        ("reference-moon-venus-timor-sphere", 15.0),
        ("reference-moon-planets-atlantic", 60.0),
        ("reference-moon-venus-timor", 80.0),
    ] {
        let (miss, session, sights) = solve_session(name);
        println!("{name}: fix {miss:.1} m from the truth");
        assert!(miss <= bound_m, "{name}: {miss:.1} m > {bound_m} m");

        // Every Moon and planet sight carries its own GHA rate (CONVENTIONS 13.1); the
        // stars keep the sidereal rate bit for bit.
        for (obs, s) in session.observations.iter().zip(&sights) {
            let rate = s.gha_rate_rad_per_s.to_degrees() * 3600.0;
            match sight_body(&obs.body) {
                SightBody::Moon => assert!((14.0..15.0).contains(&rate), "{name} Moon {rate}"),
                SightBody::Planet => {
                    assert!((rate - 15.0411).abs() < 0.08, "{name} {} {rate}", obs.body)
                }
                SightBody::Star => assert_eq!(
                    s.gha_rate_rad_per_s,
                    skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR.to_radians() / 3600.0
                ),
                SightBody::Sun => {}
            }
        }
    }
}

#[test]
fn venus_sights_refer_to_the_centre_of_light() {
    // The Timor session's Venus is a crescent: reducing it against the geometric centre
    // instead of the centre of light moves its line of position by about 0.2'.
    let session: Session = serde_json::from_str(
        &std::fs::read_to_string(repo_path(
            "fixtures/sessions/reference-moon-venus-timor-sphere.json",
        ))
        .unwrap(),
    )
    .unwrap();
    let truth: Truth = serde_json::from_str(
        &std::fs::read_to_string(repo_path(
            "fixtures/expected/reference-moon-venus-timor-sphere.truth.json",
        ))
        .unwrap(),
    )
    .unwrap();
    let venus = session
        .observations
        .iter()
        .find(|o| o.body == "Venus")
        .unwrap();
    let jd = skyfix_core::time::parse_utc(&venus.utc).unwrap();
    let observer = Point::from_deg(truth.position.lat_deg, truth.position.lon_deg);
    let hc = |d: GeocentricDirection| {
        altitude_azimuth(observer, d.gha_deg.to_radians(), d.dec_deg.to_radians())
            .0
            .to_degrees()
    };
    let light = SightPlanetProvider::new().geocentric("Venus", jd).unwrap();
    let centre = skyfix_ephemeris::planets::PlanetProvider::new()
        .geocentric("Venus", jd)
        .unwrap();
    let mut s = session.clone();
    s.observations.retain(|o| o.body == "Venus");
    let (reduced, _) = reduce_session_partitioned(&s, &ProviderSource(auto()));
    let ho = reduced[0].ho_deg;
    let with_light = (ho - hc(light)) * 60.0;
    let with_centre = (ho - hc(centre)) * 60.0;
    println!(
        "Venus intercept at the truth: centre of light {with_light:.4}', geometric centre {with_centre:.4}'"
    );
    assert!(with_light.abs() < 0.02, "{with_light}");
    assert!(with_centre.abs() > 0.1, "{with_centre}");
}

#[test]
fn a_moon_sight_without_horizontal_parallax_is_refused() {
    let dir = GeocentricDirection {
        gha_deg: 10.0,
        dec_deg: 5.0,
        semidiameter_arcmin: 16.0,
        horizontal_parallax_arcmin: 0.0,
    };
    let inputs = CorrectionInputs {
        id: "m",
        is_sun: false,
        limb: Limb::Lower,
        horizon: HorizonMode::Sea,
        index_correction_arcmin: 0.0,
        height_of_eye_m: 2.0,
        pressure_hpa: 1010.0,
        temperature_c: 10.0,
        direction: Some(dir),
    };
    let e = correct_sight(30.0, AltitudeKind::SextantHs, 1.0, inputs, SightBody::Moon).unwrap_err();
    assert!(e.to_string().contains("horizontal parallax"), "{e}");
    // An observed_ho Moon record needs no parallax: nothing runs.
    let ok = correct_sight(30.0, AltitudeKind::ObservedHo, 1.0, inputs, SightBody::Moon).unwrap();
    assert_eq!(ok.ho_deg, 30.0);
}

#[test]
fn the_provider_source_gives_the_moon_its_own_rate_and_the_stars_their_old_one() {
    let source = ProviderSource(auto());
    let jd = skyfix_core::time::parse_utc("2026-10-01T01:30:00Z").unwrap();
    let moon = source.gha_rate_deg_per_hour_at("Moon", jd);
    let sky = skyfix_ephemeris::body::Sky::new();
    use skyfix_ephemeris::body::BodyEphemeris;
    let exact = sky.gha_rate_deg_per_hour("Moon", jd).unwrap();
    assert!((moon - exact).abs() < 1e-9, "{moon} vs {exact}");
    assert!((14.1..14.9).contains(&moon), "{moon}");
    assert_eq!(
        source.gha_rate_deg_per_hour_at("Vega", jd),
        skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR
    );
    assert_eq!(
        source.gha_rate_deg_per_hour_at(" sun ", jd),
        skyfix_core::units::SOLAR_RATE_DEG_PER_HOUR
    );
    // Without an instant the Moon falls back to its mean rate, never the sidereal one.
    assert_eq!(
        source.gha_rate_deg_per_hour("Moon"),
        skyfix_core::units::MEAN_LUNAR_RATE_DEG_PER_HOUR
    );
}

#[test]
fn a_source_without_an_ephemeris_gives_the_moon_its_mean_rate() {
    let s = skyfix_core::reduce::SuppliedOnly;
    assert_eq!(
        s.gha_rate_deg_per_hour_at("Moon", 2.46e6),
        skyfix_core::units::MEAN_LUNAR_RATE_DEG_PER_HOUR
    );
    assert_eq!(
        s.gha_rate_deg_per_hour_at("Vega", 2.46e6),
        skyfix_core::units::SIDEREAL_RATE_DEG_PER_HOUR
    );
    assert_eq!(
        s.gha_rate_deg_per_hour_at("sun", 2.46e6),
        skyfix_core::units::SOLAR_RATE_DEG_PER_HOUR
    );
}

#[test]
fn a_limb_is_expected_on_the_moon_and_ignored_on_a_planet() {
    use skyfix_core::types::{CorrectionKind, Warning};
    let text = std::fs::read_to_string(repo_path(
        "fixtures/sessions/reference-moon-planets-atlantic.json",
    ))
    .unwrap();
    let mut session: Session = serde_json::from_str(&text).unwrap();
    for o in &mut session.observations {
        if o.body == "Jupiter" {
            o.limb = Limb::Lower;
        }
    }
    let bodies = skyfix_ephemeris::sights::sight_bodies();
    let warnings = skyfix_core::session::validate(&session, &bodies).unwrap();
    let limb_warnings: Vec<&Warning> = warnings
        .iter()
        .filter(|w| matches!(w, Warning::LimbIgnoredForStar { .. }))
        .collect();
    // The Moon's lower limb is expected; Jupiter's is not.
    assert_eq!(limb_warnings.len(), 1, "{warnings:?}");
    assert!(matches!(limb_warnings[0], Warning::LimbIgnoredForStar { id } if id == "obs-5"));
    // A Moon record already reduced ignores its limb and parallax, and says so.
    let obs = session
        .observations
        .iter_mut()
        .find(|o| o.body == "Moon")
        .unwrap();
    obs.altitude_kind = AltitudeKind::ObservedHo;
    obs.geocentric = Some(GeocentricDirection {
        gha_deg: 10.0,
        dec_deg: 10.0,
        semidiameter_arcmin: 16.0,
        horizontal_parallax_arcmin: 59.0,
    });
    let warnings = skyfix_core::session::validate(&session, &bodies).unwrap();
    assert!(
        warnings.iter().any(|w| matches!(
            w,
            Warning::AlreadyCorrected { ignored, .. }
                if ignored.contains(&CorrectionKind::Semidiameter)
                    && ignored.contains(&CorrectionKind::Parallax)
        )),
        "{warnings:?}"
    );
}
