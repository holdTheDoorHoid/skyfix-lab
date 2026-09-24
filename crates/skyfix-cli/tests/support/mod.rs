//! Shared test helpers: building truth-consistent sessions, and running the binary.
//! OWNER: cli agent.
//!
//! The sessions under `tests/data/` are not invented numbers. Each one is built from a
//! truth position and a real sky: the star directions come from
//! `skyfix_ephemeris::stars::StarProvider` at a stated instant, and each altitude is
//! the altitude an observer *at the truth position* would measure for that direction
//! under the spherical model (CONVENTIONS section 3). That is what makes "recover the
//! truth to within 10 metres" a meaningful assertion rather than a tautology: the
//! solver is never told the truth, and the data contains no noise for it to hide in.
//!
//! Sessions recorded as `sextant_hs` go one step further and run the correction chain
//! *backwards*, so the recorded reading is what a sextant with that index error, at
//! that height of eye, under that refraction, would actually have shown. Reducing it
//! forwards has to land back on the exact `Ho`, which is how the fixture keeps the
//! correction chain and the solver honest about each other.

#![allow(dead_code)] // each test target uses a different subset of these helpers.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use skyfix_core::corrections::{self, CorrectionInputs};
use skyfix_core::geometry::{self, Point};
use skyfix_core::time::parse_utc;
use skyfix_core::types::{
    AltitudeKind, Clock, GeocentricDirection, HorizonMode, Instrument, LatLon,
    Limb, Observation, Observer, SESSION_SCHEMA, Session, SessionKind, SessionMeta,
};
use skyfix_ephemeris::AstroProvider;
use skyfix_ephemeris::stars::StarProvider;

/// Philadelphia City Hall (CONVENTIONS section 2). The truth for every fixture here.
pub const PHL: LatLon = LatLon {
    lat_deg: 39.9526,
    lon_deg: -75.1652,
};

/// A real dark-sky instant over Philadelphia: 2026-10-01 21:30 EDT.
pub const EPOCH_UTC: &str = "2026-10-01T01:30:00Z";

/// Where the committed fixtures live.
pub fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data")
}

/// A scratch directory cargo provides for integration tests.
pub fn tmp_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
}

pub fn data_file(name: &str) -> PathBuf {
    data_dir().join(name)
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

/// Apparent geocentric direction of a star at `utc`, from the merged star provider.
pub fn star_direction(name: &str, utc: &str) -> GeocentricDirection {
    let jd = parse_utc(utc).expect("fixture timestamps are valid");
    StarProvider::new()
        .geocentric(name, jd)
        .unwrap_or_else(|e| panic!("provider has no {name}: {e}"))
}

/// The altitude an observer at `at` measures for `dir`, degrees (CONVENTIONS section 3).
pub fn exact_ho_deg(at: LatLon, dir: &GeocentricDirection) -> f64 {
    let p = Point::from_deg(at.lat_deg, at.lon_deg);
    geometry::altitude(p, dir.gha_deg.to_radians(), dir.dec_deg.to_radians()).to_degrees()
}

/// The azimuth of `dir` from `at`, degrees clockwise from north.
pub fn azimuth_deg(at: LatLon, dir: &GeocentricDirection) -> f64 {
    let p = Point::from_deg(at.lat_deg, at.lon_deg);
    let (_, zn) = geometry::altitude_azimuth(p, dir.gha_deg.to_radians(), dir.dec_deg.to_radians());
    skyfix_core::units::norm_360(zn.to_degrees())
}

// ---------------------------------------------------------------------------
// Building sessions
// ---------------------------------------------------------------------------

pub struct SessionBuilder {
    pub session: Session,
}

impl SessionBuilder {
    pub fn new(name: &str, notes: &str) -> Self {
        SessionBuilder {
            session: Session {
                schema: SESSION_SCHEMA.to_string(),
                meta: SessionMeta {
                    name: name.to_string(),
                    notes: notes.to_string(),
                    kind: SessionKind::Simulated,
                },
                observer: Observer::default(),
                instrument: Instrument::default(),
                clock: Clock::default(),
                observations: Vec::new(),
            },
        }
    }

    pub fn observer(mut self, o: Observer) -> Self {
        self.session.observer = o;
        self
    }

    pub fn instrument(mut self, i: Instrument) -> Self {
        self.session.instrument = i;
        self
    }

    /// A fully corrected sight: `Ho` exactly as seen from `truth`, direction supplied.
    pub fn observed_ho(mut self, id: &str, body: &str, truth: LatLon, sigma_arcmin: f64) -> Self {
        let dir = star_direction(body, EPOCH_UTC);
        self.session.observations.push(Observation {
            id: id.to_string(),
            body: body.to_string(),
            utc: EPOCH_UTC.to_string(),
            altitude_deg: round12(exact_ho_deg(truth, &dir)),
            altitude_kind: AltitudeKind::ObservedHo,
            sigma_arcmin,
            limb: Limb::Center,
            horizon: None,
            geocentric: Some(round_direction(&dir)),
            notes: String::new(),
        });
        self
    }

    /// A raw sextant reading that reduces to the exact `Ho` seen from `truth`.
    pub fn sextant(
        mut self,
        id: &str,
        body: &str,
        truth: LatLon,
        sigma_arcmin: f64,
        horizon: Option<HorizonMode>,
    ) -> Self {
        let dir = round_direction(&star_direction(body, EPOCH_UTC));
        let target_ho = exact_ho_deg(truth, &dir);
        let mut obs = Observation {
            id: id.to_string(),
            body: body.to_string(),
            utc: EPOCH_UTC.to_string(),
            altitude_deg: target_ho,
            altitude_kind: AltitudeKind::SextantHs,
            sigma_arcmin,
            limb: Limb::Center,
            horizon,
            geocentric: Some(dir),
            notes: String::new(),
        };
        obs.altitude_deg = round12(hs_for_ho(&self.session, &obs, target_ho));
        self.session.observations.push(obs);
        self
    }

    pub fn build(self) -> Session {
        self.session
    }

    pub fn json(self) -> String {
        to_json(&self.session)
    }
}

/// The sextant reading whose reduction lands on `target_ho_deg`.
///
/// Newton on the forward chain. `dHo/dHs` is 1 for a sea horizon and 0.5 for a
/// reflected artificial horizon, so the slope is measured rather than assumed.
pub fn hs_for_ho(session: &Session, obs: &Observation, target_ho_deg: f64) -> f64 {
    let forward = |hs: f64| -> f64 {
        let horizon = obs.horizon.unwrap_or(session.instrument.horizon);
        corrections::correct(
            hs,
            obs.altitude_kind,
            obs.sigma_arcmin,
            CorrectionInputs {
                id: &obs.id,
                is_sun: skyfix_core::reduce::is_sun(&obs.body),
                limb: obs.limb,
                horizon,
                index_correction_arcmin: session.instrument.index_correction_arcmin,
                height_of_eye_m: session.observer.height_of_eye_m,
                pressure_hpa: session.observer.pressure_hpa,
                temperature_c: session.observer.temperature_c,
                direction: obs.geocentric,
            },
        )
        .expect("the fixture chain is well formed")
        .ho_deg
    };

    let mut hs = match obs.horizon.unwrap_or(session.instrument.horizon) {
        HorizonMode::ArtificialReflected => target_ho_deg * 2.0,
        _ => target_ho_deg,
    };
    for _ in 0..12 {
        let ho = forward(hs);
        let slope = (forward(hs + 1e-4) - ho) / 1e-4;
        let step = (target_ho_deg - ho) / slope;
        hs += step;
        if step.abs() < 1e-13 {
            break;
        }
    }
    hs
}

/// Twelve decimals: far finer than any angle here, and stable across platforms.
fn round12(v: f64) -> f64 {
    (v * 1e12).round() / 1e12
}

fn round_direction(d: &GeocentricDirection) -> GeocentricDirection {
    GeocentricDirection {
        gha_deg: round12(d.gha_deg),
        dec_deg: round12(d.dec_deg),
        semidiameter_arcmin: d.semidiameter_arcmin,
        horizontal_parallax_arcmin: d.horizontal_parallax_arcmin,
    }
}

pub fn to_json(session: &Session) -> String {
    let mut s = serde_json::to_string_pretty(session).expect("a session always serialises");
    s.push('\n');
    s
}

/// Strip the `geocentric` block from every observation, forcing the provider path.
pub fn without_directions(session: &Session) -> Session {
    let mut s = session.clone();
    for o in &mut s.observations {
        o.geocentric = None;
    }
    s
}

/// Write `text` into the cargo scratch directory and return the path.
pub fn write_tmp(name: &str, text: &str) -> PathBuf {
    let dir = tmp_dir();
    std::fs::create_dir_all(&dir).expect("cargo's scratch directory is writable");
    let path = dir.join(name);
    std::fs::write(&path, text).expect("cargo's scratch directory is writable");
    path
}

// ---------------------------------------------------------------------------
// Running the binary
// ---------------------------------------------------------------------------

pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Run {
    fn from(output: Output) -> Self {
        Run {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    /// Assert the exit code, printing both streams when it is wrong.
    pub fn expect_code(self, code: i32) -> Self {
        assert_eq!(
            self.code, code,
            "expected exit {code}, got {}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            self.code, self.stdout, self.stderr
        );
        self
    }

    pub fn expect_stdout(self, needle: &str) -> Self {
        assert!(
            self.stdout.contains(needle),
            "stdout does not contain {needle:?}\n--- stdout ---\n{}",
            self.stdout
        );
        self
    }

    pub fn expect_stderr(self, needle: &str) -> Self {
        assert!(
            self.stderr.contains(needle),
            "stderr does not contain {needle:?}\n--- stderr ---\n{}",
            self.stderr
        );
        self
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.stdout)
            .unwrap_or_else(|e| panic!("stdout is not JSON ({e}):\n{}", self.stdout))
    }
}

/// Run the built `skyfix` binary with the given arguments.
pub fn skyfix<I, S>(args: I) -> Run
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = Command::new(env!("CARGO_BIN_EXE_skyfix"))
        .args(args)
        .output()
        .expect("the skyfix binary was built by cargo test");
    Run::from(output)
}

/// Great-circle distance between two positions, metres.
pub fn distance_m(a: LatLon, b: LatLon) -> f64 {
    let d = geometry::angular_distance(
        Point::from_deg(a.lat_deg, a.lon_deg),
        Point::from_deg(b.lat_deg, b.lon_deg),
    );
    skyfix_core::units::rad_to_m(d)
}
