//! The description of one simulated experiment.
//!
//! A [`Scenario`] is pure data: it says what the truth is, what the sky looks like,
//! what goes wrong, and what the estimator is told. [`crate::generate::simulate`] turns
//! it into a `Session` (what the estimator sees) plus a `Truth` (what it must never see).
//!
//! Every knob here is either a *truth* knob (the value is real and hidden) or a
//! *reported* knob (the value is written into the session on purpose). They are marked
//! in the field docs; `docs/SIMULATOR.md` restates the separation.

use serde::{Deserialize, Serialize};
use skyfix_core::geometry::{self, Point};
use skyfix_core::types::{AssumedPositionRole, HorizonMode, LatLon};
use skyfix_core::units::{SIDEREAL_RATE_DEG_PER_HOUR, norm_360};

/// One experiment: truth, sky, schedule, error knobs and what the estimator is told.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Scenario {
    /// Session name; also the `Truth::session_name`.
    pub name: String,
    /// Plain-language explanation for a non-programmer: what this shows and what to
    /// look at. Copied into the session notes is *not* allowed (it may mention truth);
    /// it is a label for the demo runner.
    #[serde(default)]
    pub description: String,
    /// TRUTH. Seeds the generator. Never written into the session.
    pub seed: u64,
    /// TRUTH. The observer's real position. Never written into the session.
    pub truth: LatLon,
    /// First *true* observation time, RFC 3339 UTC with a trailing `Z`.
    pub start_utc: String,
    /// Bodies available to the schedule, before the geometry preset filters them.
    pub sources: Vec<BodySource>,
    pub schedule: Schedule,
    /// TRUTH. 1-sigma of the independent per-sight altitude noise, arcminutes.
    #[serde(default)]
    pub altitude_noise_arcmin: f64,
    /// TRUTH. Constant offset added to *every* sight's altitude, arcminutes.
    /// Positive = every altitude reads too high.
    #[serde(default)]
    pub shared_altitude_bias_arcmin: f64,
    /// TRUTH. `recorded_time - true_time`, seconds. Positive = the clock runs fast, so
    /// the timestamps written into the session are later than the real instants.
    #[serde(default)]
    pub clock_offset_s: f64,
    /// Fraction of the scheduled sights that never make it into the session.
    /// Applied as an exact count: `round(count * missing_fraction)` sights are dropped.
    #[serde(default)]
    pub missing_fraction: f64,
    /// TRUTH. One deliberate blunder.
    #[serde(default)]
    pub wrong_sight: Option<WrongSight>,
    #[serde(default)]
    pub geometry: GeometryPreset,
    #[serde(default)]
    pub altitude_kind: EmittedAltitude,
    /// REPORTED. The `sigma_arcmin` written into every observation. `None` means
    /// "report the true noise", which is the honest case; `Some(x)` is the explicit
    /// misreported-sigma knob (the estimator is told something the data does not obey).
    #[serde(default)]
    pub reported_sigma_arcmin: Option<f64>,
    /// REPORTED. `Session::clock.uncertainty_s`. This is what the estimator is told
    /// about the clock, which need not match `clock_offset_s` at all.
    #[serde(default)]
    pub reported_clock_uncertainty_s: f64,
    #[serde(default)]
    pub assumed_position: AssumedPositionSpec,
    /// Which time the body direction written into the session is evaluated at.
    #[serde(default)]
    pub almanac_lookup: AlmanacLookup,
    /// When `false`, observations whose body came from a [`BodySource::Named`] entry are
    /// emitted with no `geocentric` block, so the estimator's own provider must resolve
    /// them (at the *recorded* time, which is the clock experiment done the long way).
    /// Supplied sources always carry their direction: nothing else knows those bodies.
    #[serde(default = "default_true")]
    pub emit_supplied_directions: bool,
}

fn default_true() -> bool {
    true
}

/// Where a body direction comes from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum BodySource {
    /// A direction given outright. `gha_deg` advances linearly:
    /// `gha(t) = gha_deg_at_start + gha_rate_deg_per_hour * (t - start) / 1 h`.
    /// Declination is constant. This is the "first numerical slice" of the brief:
    /// it isolates the simulator and the solver from any astronomy implementation.
    Supplied {
        name: String,
        gha_deg_at_start: f64,
        dec_deg: f64,
        #[serde(default = "default_sidereal_rate")]
        gha_rate_deg_per_hour: f64,
    },
    /// A real body, resolved by the `AstroProvider` handed to `simulate`.
    Named { name: String },
}

fn default_sidereal_rate() -> f64 {
    SIDEREAL_RATE_DEG_PER_HOUR
}

impl BodySource {
    pub fn name(&self) -> &str {
        match self {
            BodySource::Supplied { name, .. } | BodySource::Named { name } => name,
        }
    }
}

/// How many sights, how far apart, and in what body order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schedule {
    /// Number of sights *scheduled* (before `missing_fraction` drops any).
    pub count: usize,
    /// True seconds between consecutive scheduled sights.
    pub spacing_s: f64,
    #[serde(default)]
    pub ordering: Ordering,
}

impl Schedule {
    pub fn new(count: usize, spacing_s: f64, ordering: Ordering) -> Self {
        Schedule {
            count,
            spacing_s,
            ordering,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Ordering {
    /// Body `i % n_bodies` for scheduled sight `i`: one round of the sky, then another.
    #[default]
    RoundRobin,
    /// All the sights of the first body, then all of the second, and so on. The
    /// remainder of `count / n_bodies` goes to the earliest bodies, one each.
    Sequential,
}

/// A deliberate blunder in one record.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WrongSight {
    /// 0-based index into the **emitted** observation list (after `missing_fraction`
    /// has dropped sights), so "the third sight you can see" is unambiguous.
    pub index: usize,
    /// Arcminutes added to that one altitude, on top of noise and bias.
    pub error_arcmin: f64,
}

/// Which bodies the schedule is allowed to use.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "preset", rename_all = "snake_case")]
pub enum GeometryPreset {
    /// Use `sources` exactly as listed.
    #[default]
    AsGiven,
    /// Keep only the bodies whose azimuths *at the truth position and the start time*
    /// fall inside one `window_deg` window. The window is chosen to contain as many
    /// bodies as possible (ties go to the lowest source index). If no window holds two
    /// bodies, the two closest in azimuth are kept, and the scenario is still a valid
    /// (very poor) geometry.
    Clustered { window_deg: f64 },
    /// Reorder the bodies by greedy farthest-point selection in azimuth at the truth
    /// position and start time, so a round-robin schedule walks the best-separated
    /// bodies first. `keep` optionally truncates to that many bodies.
    WellSpread {
        #[serde(default)]
        keep: Option<usize>,
    },
}

/// What kind of altitude goes into the session's `altitude_deg` field.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EmittedAltitude {
    /// Already fully corrected. The reducer has nothing to do.
    #[default]
    ObservedHo,
    /// A raw sextant reading over a natural sea horizon, produced by running the
    /// CONVENTIONS section 5 chain **backwards** (see `docs/SIMULATOR.md`).
    SextantHs {
        height_of_eye_m: f64,
        /// Signed, arcminutes, as it will appear in `Instrument::index_correction_arcmin`
        /// (it is *added* to the reading by the reducer).
        index_correction_arcmin: f64,
        #[serde(default = "default_pressure_hpa")]
        pressure_hpa: f64,
        #[serde(default = "default_temperature_c")]
        temperature_c: f64,
    },
}

fn default_pressure_hpa() -> f64 {
    1010.0
}
fn default_temperature_c() -> f64 {
    10.0
}

impl EmittedAltitude {
    /// The horizon mode the emitted session declares. Only the sea horizon is simulated.
    pub fn horizon(&self) -> HorizonMode {
        HorizonMode::Sea
    }
}

/// The assumed position written into the session, and what the solver may do with it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct AssumedPositionSpec {
    pub mode: AssumedPositionMode,
    /// `initializer` (the default and the only safe choice for an experiment),
    /// `prior` with a sigma, or `disabled`.
    pub role: AssumedPositionRole,
}

impl Default for AssumedPositionSpec {
    fn default() -> Self {
        AssumedPositionSpec {
            mode: AssumedPositionMode::OffsetFromTruth {
                distance_nm: 30.0,
                bearing_deg: 45.0,
            },
            role: AssumedPositionRole::Initializer,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AssumedPositionMode {
    /// No assumed position at all; the solver must find the fix by multistart.
    None,
    /// A dead-reckoning position `distance_nm` from the truth along `bearing_deg`.
    /// This is the realistic case: a navigator knows roughly where they are. It leaks a
    /// *bounded* amount of truth (the fix is within `distance_nm` of it) and that is
    /// stated in the session notes and in `docs/SIMULATOR.md`.
    OffsetFromTruth { distance_nm: f64, bearing_deg: f64 },
    /// A position chosen by the scenario author, unrelated to the truth.
    Explicit(LatLon),
    /// The truth itself. Only for deliberately studying initialisation; the emitted
    /// session says so in `meta.notes`, because it is not an honest experiment.
    Truth,
}

/// Which instant the direction written into the session is evaluated at.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlmanacLookup {
    /// The estimator has a correct almanac but a wrong clock: it looks the body up at
    /// the time it believes. This is what makes a clock offset move the fix.
    #[default]
    RecordedTime,
    /// The direction is the true one regardless of the recorded timestamp. A clock
    /// offset then has no effect at all, which is a useful control case.
    TrueTime,
}

impl Scenario {
    /// A minimal scenario: truth, start time, bodies, schedule. Everything else default
    /// (no noise, no bias, no clock offset, nothing missing, `observed_ho` records).
    pub fn new(
        name: impl Into<String>,
        seed: u64,
        truth: LatLon,
        start_utc: impl Into<String>,
        sources: Vec<BodySource>,
        schedule: Schedule,
    ) -> Self {
        Scenario {
            name: name.into(),
            description: String::new(),
            seed,
            truth,
            start_utc: start_utc.into(),
            sources,
            schedule,
            altitude_noise_arcmin: 0.0,
            shared_altitude_bias_arcmin: 0.0,
            clock_offset_s: 0.0,
            missing_fraction: 0.0,
            wrong_sight: None,
            geometry: GeometryPreset::AsGiven,
            altitude_kind: EmittedAltitude::ObservedHo,
            reported_sigma_arcmin: None,
            reported_clock_uncertainty_s: 0.0,
            assumed_position: AssumedPositionSpec::default(),
            almanac_lookup: AlmanacLookup::RecordedTime,
            emit_supplied_directions: true,
        }
    }

    /// The truth position as a geometry `Point`.
    pub fn truth_point(&self) -> Point {
        Point::from_deg(self.truth.lat_deg, self.truth.lon_deg)
    }

    /// The sigma written into every observation, or an explanation of why there is none.
    /// A session with `sigma_arcmin <= 0` is invalid (CONVENTIONS section 10), so a
    /// noise-free scenario must set `reported_sigma_arcmin` explicitly.
    pub fn effective_reported_sigma_arcmin(&self) -> Result<f64, String> {
        let s = self
            .reported_sigma_arcmin
            .unwrap_or(self.altitude_noise_arcmin);
        if !(s.is_finite() && s > 0.0) {
            return Err(format!(
                "scenario {:?}: reported sigma is {s}; set reported_sigma_arcmin explicitly \
                 (a session with sigma_arcmin <= 0 is invalid)",
                self.name
            ));
        }
        Ok(s)
    }

    /// Structural check of the knobs. Does not touch the sky or the clock.
    pub fn check(&self) -> Result<(), String> {
        let bad = |m: String| Err(format!("scenario {:?}: {m}", self.name));
        if self.name.is_empty() {
            return Err("scenario name must not be empty".into());
        }
        if self.sources.is_empty() {
            return bad("no body sources".into());
        }
        if self.schedule.count == 0 {
            return bad("schedule.count must be at least 1".into());
        }
        if !self.schedule.spacing_s.is_finite() || self.schedule.spacing_s < 0.0 {
            return bad(format!(
                "schedule.spacing_s must be finite and >= 0 (got {})",
                self.schedule.spacing_s
            ));
        }
        for (f, v) in [
            ("truth.lat_deg", self.truth.lat_deg),
            ("truth.lon_deg", self.truth.lon_deg),
            ("altitude_noise_arcmin", self.altitude_noise_arcmin),
            (
                "shared_altitude_bias_arcmin",
                self.shared_altitude_bias_arcmin,
            ),
            ("clock_offset_s", self.clock_offset_s),
            ("missing_fraction", self.missing_fraction),
            (
                "reported_clock_uncertainty_s",
                self.reported_clock_uncertainty_s,
            ),
        ] {
            if !v.is_finite() {
                return bad(format!("{f} is not finite"));
            }
        }
        if !(-90.0..=90.0).contains(&self.truth.lat_deg) {
            return bad(format!(
                "truth.lat_deg {} outside [-90, 90]",
                self.truth.lat_deg
            ));
        }
        if self.truth.lon_deg <= -180.0 || self.truth.lon_deg > 180.0 {
            return bad(format!(
                "truth.lon_deg {} outside (-180, 180]",
                self.truth.lon_deg
            ));
        }
        if self.altitude_noise_arcmin < 0.0 {
            return bad("altitude_noise_arcmin must be >= 0 (it is a 1-sigma)".into());
        }
        if !(0.0..=1.0).contains(&self.missing_fraction) {
            return bad(format!(
                "missing_fraction {} outside [0, 1]",
                self.missing_fraction
            ));
        }
        if self.reported_clock_uncertainty_s < 0.0 {
            return bad("reported_clock_uncertainty_s must be >= 0".into());
        }
        if let Some(w) = self.wrong_sight
            && !w.error_arcmin.is_finite()
        {
            return bad("wrong_sight.error_arcmin is not finite".into());
        }
        for s in &self.sources {
            if s.name().is_empty() {
                return bad("a body source has an empty name".into());
            }
            if let BodySource::Supplied {
                name,
                gha_deg_at_start,
                dec_deg,
                gha_rate_deg_per_hour,
            } = s
            {
                if !gha_deg_at_start.is_finite()
                    || !dec_deg.is_finite()
                    || !gha_rate_deg_per_hour.is_finite()
                {
                    return bad(format!("supplied source {name:?} has a non-finite field"));
                }
                if !(-90.0..=90.0).contains(dec_deg) {
                    return bad(format!(
                        "supplied source {name:?}: dec_deg {dec_deg} outside [-90, 90]"
                    ));
                }
            }
        }
        if let GeometryPreset::Clustered { window_deg } = self.geometry
            && !(window_deg.is_finite() && (0.0..=360.0).contains(&window_deg))
        {
            return bad(format!(
                "clustered window_deg {window_deg} outside [0, 360]"
            ));
        }
        if let EmittedAltitude::SextantHs {
            height_of_eye_m,
            index_correction_arcmin,
            pressure_hpa,
            temperature_c,
        } = self.altitude_kind
        {
            if !height_of_eye_m.is_finite() || height_of_eye_m < 0.0 {
                return bad("sextant_hs height_of_eye_m must be finite and >= 0".into());
            }
            if !index_correction_arcmin.is_finite() {
                return bad("sextant_hs index_correction_arcmin is not finite".into());
            }
            if !(pressure_hpa.is_finite() && pressure_hpa > 0.0) {
                return bad("sextant_hs pressure_hpa must be finite and > 0".into());
            }
            if !temperature_c.is_finite() || temperature_c <= -273.15 {
                return bad("sextant_hs temperature_c must be above absolute zero".into());
            }
        }
        if let AssumedPositionSpec {
            mode:
                AssumedPositionMode::OffsetFromTruth {
                    distance_nm,
                    bearing_deg,
                },
            ..
        } = self.assumed_position
            && (!distance_nm.is_finite() || distance_nm < 0.0 || !bearing_deg.is_finite())
        {
            return bad(
                "assumed_position offset must have a finite bearing and distance >= 0".into(),
            );
        }
        self.effective_reported_sigma_arcmin()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Inverted geometry: place a body where you want it
// ---------------------------------------------------------------------------

/// Apparent geocentric GHA/declination (degrees) that puts a body at exactly
/// `altitude_deg` and true azimuth `azimuth_deg` as seen from `observer`.
///
/// The body's geographic position is the point `90 deg - h` away from the observer along
/// the bearing `Zn` (CONVENTIONS section 3: the circle of position has angular radius
/// equal to the zenith distance, and the GP lies toward the body). From the GP,
/// `dec = lat_gp` and `GHA = -lon_gp` normalised to `[0, 360)` (section 2).
///
/// This is the *inverse* of `geometry::altitude_azimuth`, and the round trip is tested
/// to 1e-9 radians. It is the only way scenarios choose their synthetic bodies, so a
/// demo can promise "this star sits 40 degrees up in the north-east" and mean it.
pub fn gha_dec_for(observer: LatLon, altitude_deg: f64, azimuth_deg: f64) -> (f64, f64) {
    let obs = Point::from_deg(observer.lat_deg, observer.lon_deg);
    let zenith_distance = (90.0 - altitude_deg).to_radians();
    let gp = geometry::destination(obs, azimuth_deg.to_radians(), zenith_distance);
    (norm_360(-gp.lon_deg()), gp.lat_deg())
}

/// A [`BodySource::Supplied`] placed at a chosen altitude and azimuth at the scenario's
/// start time, drifting west at the sidereal rate afterwards.
pub fn body_at(
    name: impl Into<String>,
    observer: LatLon,
    altitude_deg: f64,
    azimuth_deg: f64,
) -> BodySource {
    let (gha_deg_at_start, dec_deg) = gha_dec_for(observer, altitude_deg, azimuth_deg);
    BodySource::Supplied {
        name: name.into(),
        gha_deg_at_start,
        dec_deg,
        gha_rate_deg_per_hour: SIDEREAL_RATE_DEG_PER_HOUR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::units::rad_to_deg;

    const PHL: LatLon = LatLon {
        lat_deg: 39.9526,
        lon_deg: -75.1652,
    };

    #[test]
    fn inverted_geometry_round_trips_to_1e9() {
        let obs = Point::from_deg(PHL.lat_deg, PHL.lon_deg);
        for &h in &[0.5, 5.0, 25.0, 40.0, 62.5, 80.0, 89.0] {
            for zn in (0..360).step_by(17) {
                let zn = zn as f64;
                let (gha, dec) = gha_dec_for(PHL, h, zn);
                assert!((0.0..360.0).contains(&gha), "gha {gha} out of range");
                assert!((-90.0..=90.0).contains(&dec), "dec {dec} out of range");
                let (h_back, zn_back) =
                    geometry::altitude_azimuth(obs, gha.to_radians(), dec.to_radians());
                assert!(
                    (rad_to_deg(h_back) - h).abs() < 1e-9,
                    "altitude: wanted {h}, got {}",
                    rad_to_deg(h_back)
                );
                let dz = (rad_to_deg(zn_back) - zn + 540.0) % 360.0 - 180.0;
                assert!(
                    dz.abs() < 1e-9,
                    "azimuth: wanted {zn}, got {}",
                    rad_to_deg(zn_back)
                );
            }
        }
    }

    #[test]
    fn inverted_geometry_handles_the_poles_and_the_dateline() {
        // Near the pole every azimuth is meaningful but longitudes crowd together.
        let near_pole = LatLon {
            lat_deg: 89.5,
            lon_deg: 179.9,
        };
        let obs = Point::from_deg(near_pole.lat_deg, near_pole.lon_deg);
        for zn in [0.0, 90.0, 179.0, 271.0, 359.0] {
            let (gha, dec) = gha_dec_for(near_pole, 30.0, zn);
            let (h, z) = geometry::altitude_azimuth(obs, gha.to_radians(), dec.to_radians());
            assert!((rad_to_deg(h) - 30.0).abs() < 1e-9);
            let dz = (rad_to_deg(z) - zn + 540.0) % 360.0 - 180.0;
            assert!(dz.abs() < 1e-9, "zn {zn} -> {}", rad_to_deg(z));
        }
        // A body directly overhead: GP = observer.
        let (gha, dec) = gha_dec_for(PHL, 90.0, 0.0);
        assert!((dec - PHL.lat_deg).abs() < 1e-12);
        assert!((gha - norm_360(-PHL.lon_deg)).abs() < 1e-12);
    }

    #[test]
    fn body_at_uses_the_sidereal_rate() {
        match body_at("sim-A", PHL, 45.0, 90.0) {
            BodySource::Supplied {
                name,
                gha_rate_deg_per_hour,
                dec_deg,
                ..
            } => {
                assert_eq!(name, "sim-A");
                assert_eq!(gha_rate_deg_per_hour, SIDEREAL_RATE_DEG_PER_HOUR);
                assert!(dec_deg.is_finite());
            }
            other => panic!("expected a supplied source, got {other:?}"),
        }
    }

    fn base() -> Scenario {
        Scenario::new(
            "t",
            1,
            PHL,
            "2026-10-01T01:30:00Z",
            vec![
                body_at("a", PHL, 40.0, 45.0),
                body_at("b", PHL, 40.0, 135.0),
            ],
            Schedule::new(2, 60.0, Ordering::RoundRobin),
        )
    }

    #[test]
    fn scenario_round_trips_through_json() {
        let mut s = base();
        s.altitude_noise_arcmin = 0.7;
        s.shared_altitude_bias_arcmin = 3.0;
        s.clock_offset_s = 60.0;
        s.wrong_sight = Some(WrongSight {
            index: 1,
            error_arcmin: 8.0,
        });
        s.geometry = GeometryPreset::Clustered { window_deg: 30.0 };
        s.altitude_kind = EmittedAltitude::SextantHs {
            height_of_eye_m: 2.5,
            index_correction_arcmin: -2.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        };
        s.assumed_position = AssumedPositionSpec {
            mode: AssumedPositionMode::Explicit(LatLon {
                lat_deg: 40.5,
                lon_deg: -75.5,
            }),
            role: AssumedPositionRole::Prior { sigma_nm: 20.0 },
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Scenario = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
        // Tagged enums keep their discriminator names stable for the CLI and the UI.
        assert!(json.contains(r#""preset":"clustered""#));
        assert!(json.contains(r#""kind":"sextant_hs""#));
        assert!(json.contains(r#""mode":"explicit""#));
        assert!(json.contains(r#""source":"supplied""#));
    }

    #[test]
    fn scenario_defaults_are_a_clean_experiment() {
        let s = base();
        assert_eq!(s.geometry, GeometryPreset::AsGiven);
        assert_eq!(s.altitude_kind, EmittedAltitude::ObservedHo);
        assert_eq!(s.almanac_lookup, AlmanacLookup::RecordedTime);
        assert!(s.emit_supplied_directions);
        assert_eq!(
            s.assumed_position.role,
            AssumedPositionRole::Initializer,
            "an assumed position must never default to a prior"
        );
        assert!(matches!(
            s.assumed_position.mode,
            AssumedPositionMode::OffsetFromTruth { .. }
        ));
    }

    #[test]
    fn check_rejects_bad_knobs() {
        assert!(
            base().check().is_err(),
            "zero noise needs an explicit sigma"
        );

        let mut s = base();
        s.reported_sigma_arcmin = Some(1.0);
        s.check().unwrap();

        let mut bad = s.clone();
        bad.missing_fraction = 1.5;
        assert!(bad.check().unwrap_err().contains("missing_fraction"));

        let mut bad = s.clone();
        bad.truth.lat_deg = 91.0;
        assert!(bad.check().unwrap_err().contains("lat_deg"));

        let mut bad = s.clone();
        bad.truth.lon_deg = -180.0;
        assert!(bad.check().unwrap_err().contains("lon_deg"));

        let mut bad = s.clone();
        bad.schedule.count = 0;
        assert!(bad.check().unwrap_err().contains("count"));

        let mut bad = s.clone();
        bad.sources.clear();
        assert!(bad.check().unwrap_err().contains("no body sources"));

        let mut bad = s.clone();
        bad.altitude_noise_arcmin = -1.0;
        assert!(bad.check().unwrap_err().contains("1-sigma"));

        let mut bad = s.clone();
        bad.reported_sigma_arcmin = Some(0.0);
        assert!(bad.check().unwrap_err().contains("reported sigma"));

        let mut bad = s.clone();
        bad.altitude_kind = EmittedAltitude::SextantHs {
            height_of_eye_m: -1.0,
            index_correction_arcmin: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        };
        assert!(bad.check().unwrap_err().contains("height_of_eye_m"));

        let mut bad = s.clone();
        bad.sources = vec![BodySource::Supplied {
            name: "x".into(),
            gha_deg_at_start: 0.0,
            dec_deg: 95.0,
            gha_rate_deg_per_hour: 15.0,
        }];
        assert!(bad.check().unwrap_err().contains("dec_deg"));

        let mut bad = s;
        bad.geometry = GeometryPreset::Clustered { window_deg: 400.0 };
        assert!(bad.check().unwrap_err().contains("window_deg"));
    }

    #[test]
    fn effective_sigma_prefers_the_explicit_knob() {
        let mut s = base();
        s.altitude_noise_arcmin = 0.3;
        assert_eq!(s.effective_reported_sigma_arcmin().unwrap(), 0.3);
        s.reported_sigma_arcmin = Some(1.5);
        assert_eq!(s.effective_reported_sigma_arcmin().unwrap(), 1.5);
    }
}
