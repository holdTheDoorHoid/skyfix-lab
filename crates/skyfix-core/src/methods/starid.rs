//! Star identification: which body did the navigator shoot? `docs/NAVIGATION_METHODS.md`
//! §10 is normative (sailings agent, expansion programme).
//!
//! Given the time, the DR position, the altitude (a sextant reading, an apparent or an
//! observed altitude) and a bearing (true, magnetic or compass, corrected with the
//! variation and deviation when they are given), every candidate — the navigational
//! stars, the naked-eye planets and the Moon — is placed in the sky at the DR, and the
//! candidates are ranked by how far each lies from the observed direction.
//!
//! # Comparing like with like
//!
//! The observation is run through the correction chain as a star (CONVENTIONS section 5:
//! index correction, dip or the horizon's own step, refraction), which leaves the
//! **airless topocentric altitude** of whatever was observed. Each candidate's computed
//! altitude `Hc` (section 3) is brought to the same thing by removing its parallax in
//! altitude: `h + asin(sin HP cos h) = Hc` (0 for a star, up to 1° for the Moon). A limb
//! of the Moon is taken as its centre: 16′, far inside the tolerance.
//!
//! # The distance
//!
//! A sextant altitude is good to a minute; a hand-bearing compass to a few degrees. So
//! the tolerances are separate (default 2° in altitude, 5° in bearing), and the offset of
//! a candidate from the observed direction is measured in the observed direction's own
//! tangent plane: `y` along the vertical, `x` along the horizontal (the azimuthal
//! equidistant offset, exact at any altitude, including near the zenith where azimuth
//! loses its meaning). A candidate **matches** when `|y| ≤ tol_alt` and
//! `|x| ≤ tol_x = max(tol_bearing cos h, tol_alt)`: the bearing tolerance turned into
//! arc at the observed altitude, never tighter than the altitude's. Candidates are
//! ranked by `hypot(y / tol_alt, x / tol_x)`, which weighs each direction by how well it
//! was measured; the plain angular separation is reported beside it.
//!
//! # Seen or not
//!
//! Each candidate says whether it is bright enough for the sky at that moment, from the
//! Sun's altitude at the DR ([`limiting_magnitude`]): the observation planner's rule in
//! nautical twilight (magnitude 1.5 with the Sun at −6°, 3.0 at −12°), extended to
//! −3.0 in daylight and 4.5 in full darkness. A heuristic for a clear sky at sea, stated
//! with every result; it makes no allowance for moonlight, haze, or a body low in the
//! murk of the horizon.

use serde::{Deserialize, Serialize};

use crate::SkyfixError;
use crate::corrections::{self, CorrectionInputs, SightBody};
use crate::geometry::{Point, altitude_azimuth};
use crate::types::{
    AltitudeKind, CorrectionBreakdown, GeocentricDirection, Instrument, Limb, SightObserver,
    Warning,
};
use crate::units::{norm_180, norm_360};

/// What kind of body a candidate is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    Star,
    Planet,
    Moon,
}

/// One body the identification considers, at the instant asked about.
#[derive(Debug, Clone, PartialEq)]
pub struct StarIdCandidate {
    pub body: String,
    pub kind: CandidateKind,
    /// Apparent geocentric direction of date (CONVENTIONS section 7), with the
    /// horizontal parallax for the Moon and the planets.
    pub direction: GeocentricDirection,
    pub magnitude: Option<f64>,
    /// Offered for sights (CONVENTIONS 13.1): false for Mercury.
    pub navigational: bool,
}

/// Supplies the candidates: implemented over `skyfix-ephemeris` by the WASM adapter.
pub trait StarIdSource {
    fn name(&self) -> &str;
    /// Every candidate body at `jd_utc`.
    fn candidates(&self, jd_utc: f64) -> Result<Vec<StarIdCandidate>, String>;
    /// The Sun's apparent geocentric direction at `jd_utc`.
    fn sun(&self, jd_utc: f64) -> Result<GeocentricDirection, String>;
}

/// What the bearing was measured with.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BearingKind {
    /// True bearing. Default.
    #[default]
    True,
    /// Magnetic: the variation is added.
    Magnetic,
    /// Compass: the deviation and the variation are added.
    Compass,
}

fn default_altitude_tolerance() -> f64 {
    2.0
}
fn default_bearing_tolerance() -> f64 {
    5.0
}

/// `star_identify(request_json)`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StarIdRequest {
    /// The sight's time, RFC 3339 UTC (already corrected for the watch's error).
    pub utc: String,
    /// DR position, height of eye, pressure and temperature (the chain's inputs).
    pub observer: SightObserver,
    /// Index correction (or its log) and horizon.
    #[serde(default)]
    pub instrument: Instrument,
    pub altitude_deg: f64,
    /// `sextant_hs` (default), `apparent_ha` or `observed_ho` (corrected as for a star).
    #[serde(default)]
    pub altitude_kind: AltitudeKind,
    pub bearing_deg: f64,
    #[serde(default)]
    pub bearing_kind: BearingKind,
    /// Degrees, east positive (added to a magnetic or compass bearing).
    #[serde(default)]
    pub variation_deg: Option<f64>,
    /// Degrees, east positive (added to a compass bearing).
    #[serde(default)]
    pub deviation_deg: Option<f64>,
    #[serde(default = "default_altitude_tolerance")]
    pub altitude_tolerance_deg: f64,
    #[serde(default = "default_bearing_tolerance")]
    pub bearing_tolerance_deg: f64,
}

/// One ranked candidate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StarIdMatch {
    /// 1-based position in the ranking.
    pub rank: usize,
    pub body: String,
    pub kind: CandidateKind,
    pub navigational: bool,
    /// The body's airless topocentric altitude at the DR (parallax removed), degrees.
    pub altitude_deg: f64,
    /// True azimuth at the DR, degrees.
    pub azimuth_deg: f64,
    /// Observed minus the body's, degrees.
    pub delta_altitude_deg: f64,
    /// Observed true bearing minus the body's azimuth, degrees, `(-180, 180]`.
    pub delta_bearing_deg: f64,
    /// Angular distance between the observed direction and the body, degrees.
    pub separation_deg: f64,
    /// `hypot(vertical / tol_alt, horizontal / tol_x)`: the ranking key.
    pub score: f64,
    pub within_tolerance: bool,
    pub magnitude: Option<f64>,
    /// Bright enough for the sky at that moment ([`limiting_magnitude`]); `None` when the
    /// magnitude is not known.
    pub bright_enough: Option<bool>,
}

/// The identification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StarIdResult {
    pub utc: String,
    pub jd_utc: f64,
    /// The observation after the chain: airless topocentric altitude, degrees.
    pub observed_altitude_deg: f64,
    /// The bearing as a true bearing, degrees.
    pub observed_bearing_deg: f64,
    /// The chain run on the observation as for a star.
    pub corrections: CorrectionBreakdown,
    pub altitude_tolerance_deg: f64,
    pub bearing_tolerance_deg: f64,
    /// The Sun's altitude at the DR, degrees.
    pub sun_altitude_deg: f64,
    /// CONVENTIONS 13.4: `day`, `civil`, `nautical`, `astronomical` or `night`.
    pub sky: String,
    pub limiting_magnitude: f64,
    /// Every candidate within the tolerances, best first, then (when fewer than three
    /// match) the nearest others, flagged `within_tolerance = false`.
    pub candidates: Vec<StarIdMatch>,
    /// The best match, if any.
    pub best: Option<String>,
    /// More than one body fits within the tolerances.
    pub ambiguous: bool,
    /// The answer in one or two plain sentences.
    pub message: String,
    pub source: String,
    pub warnings: Vec<Warning>,
    pub notes: Vec<String>,
}

/// The faintest magnitude worth expecting to see for a Sun at `sun_altitude_deg`
/// (a heuristic for a clear sky at sea): −3.0 in daylight (Venus near its brightest),
/// rising 0.75 a degree through civil twilight to 1.5 with the Sun at −6°, then the
/// observation planner's 0.25 a degree (`skyfix_ephemeris::visibility::
/// twilight_limiting_magnitude`) to 3.0 at −12°, and on at 0.25 a degree to 4.5 at −18°
/// and below. Continuous.
pub fn limiting_magnitude(sun_altitude_deg: f64) -> f64 {
    let h = sun_altitude_deg;
    if h >= 0.0 {
        -3.0
    } else if h > -6.0 {
        -3.0 + 0.75 * (-h)
    } else if h > -12.0 {
        1.5 + 0.25 * (-6.0 - h)
    } else {
        (3.0 + 0.25 * (-12.0 - h)).min(4.5)
    }
}

/// CONVENTIONS 13.4 sky phase for a Sun altitude.
pub fn sky_phase(sun_altitude_deg: f64) -> &'static str {
    let h = sun_altitude_deg;
    if h > -50.0 / 60.0 {
        "day"
    } else if h > -6.0 {
        "civil"
    } else if h > -12.0 {
        "nautical"
    } else if h > -18.0 {
        "astronomical"
    } else {
        "night"
    }
}

/// The airless topocentric altitude of a body whose geocentric `hc` (degrees) and
/// horizontal parallax are given: the `h` with `h + asin(sin HP cos h) = Hc`.
pub fn topocentric_altitude_deg(hc_deg: f64, horizontal_parallax_arcmin: f64) -> f64 {
    if horizontal_parallax_arcmin == 0.0 {
        return hc_deg;
    }
    let mut h = hc_deg;
    for _ in 0..6 {
        h = hc_deg
            - corrections::rigorous_parallax_in_altitude_arcmin(horizontal_parallax_arcmin, h)
                / 60.0;
    }
    h
}

/// Unit vector of an altitude and azimuth (degrees) in (north, east, up).
fn unit(h_deg: f64, z_deg: f64) -> [f64; 3] {
    let (sh, ch) = h_deg.to_radians().sin_cos();
    let (sz, cz) = z_deg.to_radians().sin_cos();
    [ch * cz, ch * sz, sh]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Offset of `(h, z)` from the observed `(h0, z0)` in the observed direction's tangent
/// plane, azimuthal equidistant: `(vertical, horizontal, separation)`, degrees.
fn offset(h0: f64, z0: f64, h: f64, z: f64) -> (f64, f64, f64) {
    let u0 = unit(h0, z0);
    let u = unit(h, z);
    let (sh0, ch0) = h0.to_radians().sin_cos();
    let (sz0, cz0) = z0.to_radians().sin_cos();
    let up = [-sh0 * cz0, -sh0 * sz0, ch0];
    let across = [-sz0, cz0, 0.0];
    let c = [
        u0[1] * u[2] - u0[2] * u[1],
        u0[2] * u[0] - u0[0] * u[2],
        u0[0] * u[1] - u0[1] * u[0],
    ];
    let sep = dot(c, c).sqrt().atan2(dot(u0, u)).to_degrees();
    let theta = dot(u, across).atan2(dot(u, up));
    (sep * theta.cos(), sep * theta.sin(), sep)
}

/// Identify the body of one sight (docs/NAVIGATION_METHODS.md §10).
pub fn star_identify(
    req: &StarIdRequest,
    source: &dyn StarIdSource,
) -> Result<StarIdResult, SkyfixError> {
    let jd = crate::time::parse_utc(&req.utc)?;
    let o = &req.observer;
    crate::sailings::dr::check_position(
        "observer",
        crate::types::LatLon {
            lat_deg: o.lat_deg,
            lon_deg: o.lon_deg,
        },
    )?;
    for (name, v) in [
        ("altitude_deg", req.altitude_deg),
        ("bearing_deg", req.bearing_deg),
        ("altitude_tolerance_deg", req.altitude_tolerance_deg),
        ("bearing_tolerance_deg", req.bearing_tolerance_deg),
    ] {
        if !v.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: name.to_string(),
            });
        }
    }
    if req.altitude_tolerance_deg <= 0.0 || req.bearing_tolerance_deg <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "altitude_tolerance_deg/bearing_tolerance_deg".to_string(),
            message: "tolerances must be greater than zero".to_string(),
        });
    }
    let mut notes = Vec::new();

    // --- the bearing, made true --------------------------------------------------
    let finite_or = |v: Option<f64>, name: &str| -> Result<f64, SkyfixError> {
        match v {
            Some(x) if !x.is_finite() => Err(SkyfixError::NonFinite {
                field: name.to_string(),
            }),
            Some(x) => Ok(x),
            None => Ok(0.0),
        }
    };
    let variation = finite_or(req.variation_deg, "variation_deg")?;
    let deviation = finite_or(req.deviation_deg, "deviation_deg")?;
    let bearing = match req.bearing_kind {
        BearingKind::True => req.bearing_deg,
        BearingKind::Magnetic | BearingKind::Compass => {
            if req.variation_deg.is_none() {
                notes.push(format!(
                    "No variation was given, so the {} bearing is used as if it were true: \
                     where the variation is large, give it or widen the bearing tolerance.",
                    if req.bearing_kind == BearingKind::Magnetic {
                        "magnetic"
                    } else {
                        "compass"
                    }
                ));
            }
            if req.bearing_kind == BearingKind::Compass && req.deviation_deg.is_none() {
                notes.push(
                    "No deviation was given for the compass bearing: taken as 0°.".to_string(),
                );
            }
            let dev = if req.bearing_kind == BearingKind::Compass {
                deviation
            } else {
                0.0
            };
            req.bearing_deg + dev + variation
        }
    };
    let bearing = norm_360(bearing);

    // --- the altitude, through the chain as a star ---------------------------------
    let (ic, _) = crate::error_logs::effective_index_correction(&req.instrument, jd)?;
    let breakdown = corrections::correct_sight(
        req.altitude_deg,
        req.altitude_kind,
        1.0,
        CorrectionInputs {
            id: "sight",
            is_sun: false,
            limb: Limb::Center,
            horizon: req.instrument.horizon,
            index_correction_arcmin: ic,
            height_of_eye_m: o.height_of_eye_m,
            pressure_hpa: o.pressure_hpa,
            temperature_c: o.temperature_c,
            direction: None,
        },
        SightBody::Star,
    )?;
    let h0 = breakdown.ho_deg;
    let warnings = breakdown.warnings.clone();

    // --- the sky: the Sun and the candidates ---------------------------------------
    let dr = Point::from_deg(o.lat_deg, o.lon_deg);
    let sun = source.sun(jd).map_err(SkyfixError::Other)?;
    let sun_alt = altitude_azimuth(dr, sun.gha_deg.to_radians(), sun.dec_deg.to_radians())
        .0
        .to_degrees();
    let limit = limiting_magnitude(sun_alt);
    let tol_h = req.altitude_tolerance_deg;
    let tol_x = (req.bearing_tolerance_deg * h0.to_radians().cos()).max(tol_h);
    let mut ranked: Vec<StarIdMatch> = Vec::new();
    for c in source.candidates(jd).map_err(SkyfixError::Other)? {
        let (hc, zn) = altitude_azimuth(
            dr,
            c.direction.gha_deg.to_radians(),
            c.direction.dec_deg.to_radians(),
        );
        let h = topocentric_altitude_deg(hc.to_degrees(), c.direction.horizontal_parallax_arcmin);
        let z = norm_360(zn.to_degrees());
        // Far below the horizon a body cannot be the one observed; keep the work small.
        if h < -tol_h - 3.0 {
            continue;
        }
        let (y, x, sep) = offset(h0, bearing, h, z);
        let within = y.abs() <= tol_h && x.abs() <= tol_x;
        ranked.push(StarIdMatch {
            rank: 0,
            body: c.body,
            kind: c.kind,
            navigational: c.navigational,
            altitude_deg: h,
            azimuth_deg: z,
            delta_altitude_deg: h0 - h,
            delta_bearing_deg: norm_180(bearing - z),
            separation_deg: sep,
            score: (y / tol_h).hypot(x / tol_x),
            within_tolerance: within,
            bright_enough: c.magnitude.map(|m| m <= limit),
            magnitude: c.magnitude,
        });
    }
    ranked.sort_by(|a, b| {
        b.within_tolerance
            .cmp(&a.within_tolerance)
            .then(a.score.total_cmp(&b.score))
    });
    let n_match = ranked.iter().filter(|m| m.within_tolerance).count();
    ranked.truncate(n_match + 3usize.saturating_sub(n_match));
    for (i, m) in ranked.iter_mut().enumerate() {
        m.rank = i + 1;
    }

    let describe = |m: &StarIdMatch| {
        format!(
            "{} ({:.1}° away: the sight is {:.1}° {} and its bearing {:.1}° {})",
            m.body,
            m.separation_deg,
            m.delta_altitude_deg.abs(),
            if m.delta_altitude_deg >= 0.0 {
                "higher"
            } else {
                "lower"
            },
            m.delta_bearing_deg.abs(),
            if m.delta_bearing_deg >= 0.0 {
                "greater"
            } else {
                "less"
            },
        )
    };
    let best = ranked
        .first()
        .filter(|m| m.within_tolerance)
        .map(|m| m.body.clone());
    let message = match n_match {
        0 => {
            let nearest = ranked
                .first()
                .map(describe)
                .unwrap_or_else(|| "none above the horizon".to_string());
            format!(
                "Nothing lies within {tol_h:.1}° of altitude and {:.1}° of bearing of the \
                 observation. Nearest: {nearest}. Check the time, the DR, whether the altitude \
                 is a sextant reading or corrected, and whether the bearing is true or by compass.",
                req.bearing_tolerance_deg
            )
        }
        1 => {
            let m = &ranked[0];
            format!(
                "{}{}",
                describe(m),
                match m.bright_enough {
                    Some(false) => format!(
                        ". It is fainter (magnitude {:.1}) than the {} sky usually shows (about {limit:.1}): be sure of it.",
                        m.magnitude.unwrap_or(f64::NAN),
                        sky_phase(sun_alt)
                    ),
                    _ => ".".to_string(),
                }
            )
        }
        n => format!(
            "{n} bodies fit within the tolerances; the best is {}. The next is {}. A better \
             bearing, or a second body, would tell them apart.",
            describe(&ranked[0]),
            describe(&ranked[1])
        ),
    };
    notes.push(format!(
        "Brightness: bodies up to magnitude {limit:.1} are counted as visible with the Sun at \
         {sun_alt:.1}° ({} sky), a clear-sky heuristic with no allowance for moonlight, haze \
         or a body low in the horizon's murk.",
        sky_phase(sun_alt)
    ));
    Ok(StarIdResult {
        utc: crate::time::format_utc(jd),
        jd_utc: jd,
        observed_altitude_deg: h0,
        observed_bearing_deg: bearing,
        corrections: breakdown,
        altitude_tolerance_deg: tol_h,
        bearing_tolerance_deg: req.bearing_tolerance_deg,
        sun_altitude_deg: sun_alt,
        sky: sky_phase(sun_alt).to_string(),
        limiting_magnitude: limit,
        best,
        ambiguous: n_match > 1,
        candidates: ranked,
        message,
        source: source.name().to_string(),
        warnings,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sky of a few fixed bodies, and a Sun well below the horizon at the test place.
    struct Sky(Vec<StarIdCandidate>);

    impl StarIdSource for Sky {
        fn name(&self) -> &str {
            "test sky"
        }
        fn candidates(&self, _: f64) -> Result<Vec<StarIdCandidate>, String> {
            Ok(self.0.clone())
        }
        fn sun(&self, _: f64) -> Result<GeocentricDirection, String> {
            Ok(dir(180.0 + 70.0, -20.0, 0.0))
        }
    }

    fn dir(gha: f64, dec: f64, hp: f64) -> GeocentricDirection {
        GeocentricDirection {
            gha_deg: norm_360(gha),
            dec_deg: dec,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: hp,
        }
    }

    fn star(name: &str, gha: f64, dec: f64, mag: f64) -> StarIdCandidate {
        StarIdCandidate {
            body: name.to_string(),
            kind: CandidateKind::Star,
            direction: dir(gha, dec, 0.0),
            magnitude: Some(mag),
            navigational: true,
        }
    }

    fn sky() -> Sky {
        Sky(vec![
            star("A", 60.0, 40.0, 1.0),
            star("B", 75.0, 20.0, 2.0),
            star("C", 20.0, 60.0, 0.5),
            StarIdCandidate {
                body: "Moon".to_string(),
                kind: CandidateKind::Moon,
                direction: dir(110.0, 10.0, 57.0),
                magnitude: Some(-10.0),
                navigational: true,
            },
        ])
    }

    fn observer() -> SightObserver {
        SightObserver {
            lat_deg: 40.0,
            lon_deg: -70.0,
            height_of_eye_m: 0.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        }
    }

    fn request(h: f64, z: f64, kind: AltitudeKind) -> StarIdRequest {
        StarIdRequest {
            utc: "2026-10-01T00:00:00Z".to_string(),
            observer: observer(),
            instrument: Instrument::default(),
            altitude_deg: h,
            altitude_kind: kind,
            bearing_deg: z,
            bearing_kind: BearingKind::True,
            variation_deg: None,
            deviation_deg: None,
            altitude_tolerance_deg: 2.0,
            bearing_tolerance_deg: 5.0,
        }
    }

    fn truth(c: &StarIdCandidate) -> (f64, f64) {
        let (h, z) = altitude_azimuth(
            Point::from_deg(40.0, -70.0),
            c.direction.gha_deg.to_radians(),
            c.direction.dec_deg.to_radians(),
        );
        (
            topocentric_altitude_deg(h.to_degrees(), c.direction.horizontal_parallax_arcmin),
            norm_360(z.to_degrees()),
        )
    }

    #[test]
    fn each_body_is_recovered_from_its_own_direction() {
        let s = sky();
        for c in &s.0 {
            let (h, z) = truth(c);
            let r = star_identify(&request(h, z, AltitudeKind::ObservedHo), &s).unwrap();
            assert_eq!(r.best.as_deref(), Some(c.body.as_str()), "{}", r.message);
            assert!(r.candidates[0].separation_deg < 1e-9);
        }
    }

    #[test]
    fn nothing_matches_says_so_and_names_the_nearest() {
        let s = sky();
        let (h, z) = truth(&s.0[0]);
        let r = star_identify(&request(h + 6.0, z, AltitudeKind::ObservedHo), &s).unwrap();
        assert!(r.best.is_none());
        assert!(
            r.message.starts_with("Nothing lies within"),
            "{}",
            r.message
        );
        assert!(r.candidates.iter().all(|m| !m.within_tolerance));
        assert!(r.candidates.len() <= 3);
    }

    #[test]
    fn the_altitude_weighs_more_than_the_bearing() {
        // Two bodies: one 0.3 deg off in altitude and 4 deg in bearing, one 1.9 deg off in
        // altitude and 0.5 deg in bearing: both match; the first fits the better-measured
        // quantity and ranks first, although its angular separation is larger.
        let obs = (30.0, 200.0);
        let place = |dh: f64, dz: f64| {
            // Put a star at the requested altitude and azimuth by inverting the geometry.
            let p = Point::from_deg(40.0, -70.0);
            let (h, z) = ((obs.0 - dh).to_radians(), (obs.1 - dz).to_radians());
            let dec = (p.lat.sin() * h.sin() + p.lat.cos() * h.cos() * z.cos()).asin();
            let lha =
                (-h.cos() * z.sin()).atan2(p.lat.cos() * h.sin() - p.lat.sin() * h.cos() * z.cos());
            dir(lha.to_degrees() - p.lon_deg(), dec.to_degrees(), 0.0)
        };
        let s = Sky(vec![
            StarIdCandidate {
                direction: place(0.3, 4.0),
                ..star("steady", 0.0, 0.0, 1.0)
            },
            StarIdCandidate {
                direction: place(1.9, 0.5),
                ..star("near", 0.0, 0.0, 1.0)
            },
        ]);
        let r = star_identify(&request(obs.0, obs.1, AltitudeKind::ObservedHo), &s).unwrap();
        assert!(r.ambiguous);
        assert_eq!(r.best.as_deref(), Some("steady"), "{:?}", r.candidates);
        assert!(r.candidates[0].separation_deg > r.candidates[1].separation_deg);
    }

    #[test]
    fn a_compass_bearing_is_corrected_and_the_chain_runs_on_hs() {
        let s = sky();
        let (h, z) = truth(&s.0[1]);
        // Sextant reading: add refraction back, and the dip for 3 m, less an IC of -1'.
        let ha = h + crate::corrections::refraction_arcmin(h, 1010.0, 10.0) / 60.0;
        let hs = ha + crate::corrections::dip_arcmin(3.0) / 60.0 + 1.0 / 60.0;
        let mut req = request(hs, z - 12.0 - 2.0, AltitudeKind::SextantHs);
        req.observer.height_of_eye_m = 3.0;
        req.instrument.index_correction_arcmin = -1.0;
        req.bearing_kind = BearingKind::Compass;
        req.variation_deg = Some(12.0);
        req.deviation_deg = Some(2.0);
        let r = star_identify(&req, &s).unwrap();
        assert_eq!(r.best.as_deref(), Some("B"));
        assert!((r.observed_bearing_deg - z).abs() < 1e-9);
        assert!(
            (r.observed_altitude_deg - h).abs() < 0.002,
            "{}",
            r.observed_altitude_deg
        );
        // Without the variation the bearing is 12 deg out, and the note says why.
        req.variation_deg = None;
        let r = star_identify(&req, &s).unwrap();
        assert!(r.notes.iter().any(|n| n.contains("No variation")));
    }

    #[test]
    fn the_brightness_rule_is_continuous_and_matches_the_planner_in_twilight() {
        let mut prev = limiting_magnitude(10.0);
        let mut h = 10.0;
        while h > -30.0 {
            h -= 0.01;
            let m = limiting_magnitude(h);
            assert!(m >= prev - 1e-12 && m - prev < 0.01, "{h}");
            prev = m;
        }
        assert_eq!(limiting_magnitude(-6.0), 1.5);
        assert_eq!(limiting_magnitude(-12.0), 3.0);
        assert_eq!(limiting_magnitude(-40.0), 4.5);
        assert_eq!(sky_phase(-8.0), "nautical");
    }

    #[test]
    fn the_moon_is_compared_at_its_topocentric_altitude() {
        let hc = 40.0;
        let h = topocentric_altitude_deg(hc, 57.0);
        let p = crate::corrections::rigorous_parallax_in_altitude_arcmin(57.0, h);
        assert!((h + p / 60.0 - hc).abs() < 1e-12);
        assert!((hc - h) * 60.0 > 40.0);
    }
}
