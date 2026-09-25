//! Shared helpers for the navigation-method integration tests (tests/nav_methods_*.rs).
//! Not every test file uses every helper.
#![allow(dead_code)]

use serde_json::Value;
use skyfix_core::methods::polaris::PolarisTableSource;
use skyfix_core::types::{
    AltitudeKind, Clock, GeocentricDirection, HorizonMode, Instrument, Limb, Observation, Observer,
    SESSION_SCHEMA, Session, SessionMeta,
};
use skyfix_ephemeris::fixture_pack::CompositeProvider;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::{AstroProvider, ProviderSource};

pub const NAV_FIXTURE: &str = include_str!("../../../../fixtures/reference/nav_methods.json");
pub const BOOK_FIXTURE: &str =
    include_str!("../../../../fixtures/reference/bowditch_worked_examples.json");

/// The same astronomy the WASM adapter's `auto` mode uses: the Sun, then the stars.
pub fn provider() -> ProviderSource<CompositeProvider> {
    ProviderSource(
        CompositeProvider::new("skyfix-auto (Sun, stars)")
            .with(SunProvider::new())
            .with(StarProvider::new()),
    )
}

/// GHA Aries and Polaris from `skyfix-ephemeris`, with DUT1 = 0 (CONVENTIONS 6).
pub struct EphemerisTable;

impl PolarisTableSource for EphemerisTable {
    fn gha_aries_deg(&self, jd_utc: f64) -> f64 {
        skyfix_ephemeris::sidereal::gha_aries_deg(jd_utc, 0.0)
    }
    fn polaris(&self, jd_utc: f64) -> Result<GeocentricDirection, String> {
        StarProvider::new()
            .geocentric("Polaris", jd_utc)
            .map_err(|e| e.to_string())
    }
}

/// The parsed fixture, parsed once per test binary (the Monte Carlo tests ask often).
pub fn nav_fixture() -> Value {
    static PARSED: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    PARSED
        .get_or_init(|| serde_json::from_str(NAV_FIXTURE).expect("nav_methods.json parses"))
        .clone()
}

fn observer_settings() -> &'static Value {
    static SETTINGS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    SETTINGS.get_or_init(|| nav_fixture()["generator"]["observer_for_sextant_readings"].clone())
}

pub fn book_case(name: &str) -> Value {
    let doc: Value = serde_json::from_str(BOOK_FIXTURE).expect("bowditch fixture parses");
    doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no case {name}"))
        .clone()
}

pub fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

pub fn s(v: &Value) -> String {
    v.as_str()
        .unwrap_or_else(|| panic!("not a string: {v}"))
        .to_string()
}

/// The observer the fixture's sextant readings were generated for.
pub fn fixture_session(observations: Vec<Observation>) -> Session {
    let o = observer_settings();
    Session {
        schema: SESSION_SCHEMA.to_string(),
        meta: SessionMeta::default(),
        observer: Observer {
            height_of_eye_m: f(&o["height_of_eye_m"]),
            pressure_hpa: f(&o["pressure_hpa"]),
            temperature_c: f(&o["temperature_c"]),
            ..Observer::default()
        },
        instrument: Instrument {
            name: "fixture".into(),
            index_correction_arcmin: f(&o["index_correction_arcmin"]),
            horizon: HorizonMode::Sea,
            index_error_log: Vec::new(),
        },
        clock: Clock::default(),
        observations,
    }
}

fn limb(v: &Value) -> Limb {
    match v.as_str().unwrap_or("center") {
        "lower" => Limb::Lower,
        "upper" => Limb::Upper,
        _ => Limb::Center,
    }
}

/// A fixture sight as a raw sextant reading, with no supplied direction: the provider
/// computes it, so the whole chain (ephemeris, corrections, method) is exercised.
pub fn sextant_observation(sight: &Value, body: &str, sigma: f64) -> Observation {
    Observation {
        id: s(&sight["id"]),
        body: body.to_string(),
        utc: s(&sight["utc"]),
        altitude_deg: f(&sight["hs_deg"]),
        altitude_kind: AltitudeKind::SextantHs,
        sigma_arcmin: sigma,
        limb: limb(&sight["limb"]),
        horizon: None,
        geocentric: None,
        notes: String::new(),
    }
}

/// A fixture sight as a fully corrected altitude plus `noise_arcmin`, with the
/// fixture's own (Skyfield) direction supplied: fast, and independent of our ephemeris.
pub fn observed_with_direction(
    sight: &Value,
    body: &str,
    sigma: f64,
    noise_arcmin: f64,
) -> Observation {
    Observation {
        id: s(&sight["id"]),
        body: body.to_string(),
        utc: s(&sight["utc"]),
        altitude_deg: f(&sight["ho_deg"]) + noise_arcmin / 60.0,
        altitude_kind: AltitudeKind::ObservedHo,
        sigma_arcmin: sigma,
        limb: Limb::Center,
        horizon: None,
        geocentric: Some(GeocentricDirection {
            gha_deg: f(&sight["gha_deg"]),
            dec_deg: f(&sight["dec_deg"]),
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        }),
        notes: String::new(),
    }
}

/// Seeded standard normal deviates: splitmix64 into Box-Muller. Deterministic, so every
/// coverage number the tests print is reproducible.
pub struct Normal {
    state: u64,
    spare: Option<f64>,
}

impl Normal {
    pub fn new(seed: u64) -> Self {
        Normal {
            state: seed,
            spare: None,
        }
    }

    fn uniform(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        ((z >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }

    pub fn next(&mut self) -> f64 {
        if let Some(z) = self.spare.take() {
            return z;
        }
        let r = (-2.0 * self.uniform().ln()).sqrt();
        let t = std::f64::consts::TAU * self.uniform();
        self.spare = Some(r * t.sin());
        r * t.cos()
    }
}

/// Coverage summary of normalised errors `e / sigma`: the fraction inside 1.96 and the
/// mean square (1 when the sigmas are right).
pub struct Coverage {
    pub n: usize,
    pub inside_95: f64,
    pub mean_square: f64,
}

pub fn coverage(z: &[f64]) -> Coverage {
    let n = z.len();
    let inside = z.iter().filter(|v| v.abs() <= 1.959_964).count() as f64 / n as f64;
    let ms = z.iter().map(|v| v * v).sum::<f64>() / n as f64;
    Coverage {
        n,
        inside_95: inside,
        mean_square: ms,
    }
}

/// Assert a coverage is what honest sigmas give: 95 % inside 1.96 sigma within three
/// binomial standard deviations, and a mean square within three standard deviations of
/// a chi-square mean (sqrt(2/n)).
pub fn assert_honest(label: &str, c: &Coverage) {
    let n = c.n as f64;
    let binomial = 3.0 * (0.95f64 * 0.05 / n).sqrt();
    let chi = 3.0 * (2.0 / n).sqrt();
    println!(
        "{label}: n = {}, inside 95 % = {:.1} %, mean (e/sigma)^2 = {:.3}",
        c.n,
        100.0 * c.inside_95,
        c.mean_square
    );
    assert!(
        (c.inside_95 - 0.95).abs() <= binomial,
        "{label}: {:.3} inside 1.96 sigma (allowed 0.95 +/- {binomial:.3})",
        c.inside_95
    );
    assert!(
        (c.mean_square - 1.0).abs() <= chi,
        "{label}: mean square {:.3} (allowed 1 +/- {chi:.3})",
        c.mean_square
    );
}
