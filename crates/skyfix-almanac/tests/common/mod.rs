//! Shared test support: a synthetic Moon, a refusing provider, a brute-force event
//! finder and fixture loading.
//!
//! The Moon code paths — `h0 = -34' - SD`, topocentric parallax of a nearby body, a
//! body whose day is longer than 24 hours, Moon phases — were first proven with
//! [`SyntheticSky`], written while the real Moon provider was still a stub: the real
//! Sun and stars plus an analytic Moon built from the largest terms of the lunar theory
//! (Meeus, *Astronomical Algorithms*, chapter 47, truncated to 14 longitude, 7 latitude
//! and 5 distance terms). It is accurate to a few hundredths of a degree, which is
//! irrelevant here: it has the right rates, the right parallax (~57') and the right
//! semidiameter (~15.5'), so it proves the logic independently of the real provider.
//! The real Moon's accuracy is checked against Skyfield in `events_reference.rs`.
//! [`Refusing`] keeps the "provider cannot answer" paths tested now that every body is
//! implemented.

#![allow(dead_code)]

use std::path::PathBuf;

use skyfix_core::time::{jd_tt, jd_ut1};
use skyfix_core::types::GeocentricDirection;
use skyfix_core::units::norm_360;
use skyfix_ephemeris::body::{ApparentState, BodyEphemeris, BodyKind, MOON, Sky};
use skyfix_ephemeris::frames::{nutation_2000b_p03, true_obliquity_rad};
use skyfix_ephemeris::sidereal::gast_deg;
use skyfix_ephemeris::topocentric::{Site, horizontal};
use skyfix_ephemeris::{AstroProvider, Coverage, EphemerisError};

/// The IAU mean lunar radius, km, and the WGS84 equatorial radius, km.
pub const MOON_RADIUS_KM: f64 = 1737.4;
pub const EARTH_RADIUS_KM: f64 = 6378.137;

/// The real Sun, stars and (stub) planets, with an analytic Moon.
#[derive(Debug, Clone, Default)]
pub struct SyntheticSky {
    pub real: Sky,
}

impl SyntheticSky {
    pub fn new() -> Self {
        SyntheticSky { real: Sky::new() }
    }
}

/// Meeus chapter 47, truncated: geocentric ecliptic longitude and latitude of date
/// (degrees, mean equinox, before nutation) and distance (km).
pub fn lunar_theory(jd_tt_v: f64) -> (f64, f64, f64) {
    let t = (jd_tt_v - 2_451_545.0) / 36_525.0;
    let lp = 218.316_447_7 + 481_267.881_234_21 * t;
    let d = (297.850_192_1 + 445_267.111_403_4 * t).to_radians();
    let m = (357.529_109_2 + 35_999.050_290_9 * t).to_radians();
    let mp = (134.963_396_4 + 477_198.867_505_5 * t).to_radians();
    let f = (93.272_095_0 + 483_202.017_523_3 * t).to_radians();
    let lon = lp
        + 6.288_774 * mp.sin()
        + 1.274_027 * (2.0 * d - mp).sin()
        + 0.658_314 * (2.0 * d).sin()
        + 0.213_618 * (2.0 * mp).sin()
        - 0.185_116 * m.sin()
        - 0.114_332 * (2.0 * f).sin()
        + 0.058_793 * (2.0 * d - 2.0 * mp).sin()
        + 0.057_066 * (2.0 * d - m - mp).sin()
        + 0.053_322 * (2.0 * d + mp).sin()
        + 0.045_758 * (2.0 * d - m).sin()
        - 0.040_923 * (m - mp).sin()
        - 0.034_720 * d.sin()
        - 0.030_383 * (m + mp).sin()
        + 0.015_327 * (2.0 * d - 2.0 * f).sin();
    let lat = 5.128_122 * f.sin()
        + 0.280_602 * (mp + f).sin()
        + 0.277_693 * (mp - f).sin()
        + 0.173_237 * (2.0 * d - f).sin()
        + 0.055_413 * (2.0 * d - mp + f).sin()
        + 0.046_271 * (2.0 * d - mp - f).sin()
        + 0.032_573 * (2.0 * d + f).sin();
    let dist = 385_000.56
        - 20_905.355 * mp.cos()
        - 3_699.111 * (2.0 * d - mp).cos()
        - 2_955.968 * (2.0 * d).cos()
        - 569.925 * (2.0 * mp).cos()
        + 48.888 * m.cos();
    (lon, lat, dist)
}

/// The synthetic Moon's apparent geocentric state (CONVENTIONS 7 frame, DUT1 = 0).
pub fn synthetic_moon(jd_utc: f64, sun: &ApparentState) -> ApparentState {
    let tt = jd_tt(jd_utc);
    let (lon0, lat, dist) = lunar_theory(tt);
    let lon = lon0 + nutation_2000b_p03(tt).dpsi_rad.to_degrees();
    let eps = true_obliquity_rad(tt);
    let (sl, cl) = lon.to_radians().sin_cos();
    let (sb, cb) = lat.to_radians().sin_cos();
    let (se, ce) = eps.sin_cos();
    let ra = norm_360((sl * ce * cb - sb * se).atan2(cl * cb).to_degrees());
    let dec = (sb * ce + cb * se * sl).asin().to_degrees();
    let gha = norm_360(gast_deg(jd_ut1(jd_utc, 0.0), tt) - ra);

    // Elongation and phase from the real Sun.
    let u = |ra: f64, dec: f64| {
        let (sa, ca) = ra.to_radians().sin_cos();
        let (sd, cd) = dec.to_radians().sin_cos();
        [cd * ca, cd * sa, sd]
    };
    let (a, b) = (u(ra, dec), u(sun.ra_deg, sun.dec_deg));
    let cos_e = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0);
    let elong = cos_e.acos();
    let r_sun = sun.distance_km.unwrap_or(1.496e8);
    let phase = (r_sun * elong.sin()).atan2(dist - r_sun * elong.cos());
    ApparentState {
        body: MOON.to_string(),
        kind: BodyKind::Moon,
        jd_utc,
        ra_deg: ra,
        dec_deg: dec,
        gha_deg: gha,
        distance_km: Some(dist),
        semidiameter_arcmin: (MOON_RADIUS_KM / dist).asin().to_degrees() * 60.0,
        horizontal_parallax_arcmin: (EARTH_RADIUS_KM / dist).asin().to_degrees() * 60.0,
        magnitude: None,
        phase_angle_deg: Some(phase.to_degrees()),
        illuminated_fraction: Some((1.0 + phase.cos()) / 2.0),
        elongation_deg: Some(elong.to_degrees()),
        bright_limb_angle_deg: None,
    }
}

impl AstroProvider for SyntheticSky {
    fn name(&self) -> &str {
        "synthetic sky (real Sun and stars, analytic test Moon)"
    }

    fn coverage(&self) -> Coverage {
        self.real.coverage()
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        Ok(self.apparent_state(body, jd_utc)?.direction())
    }
}

impl BodyEphemeris for SyntheticSky {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        if body.trim().eq_ignore_ascii_case(MOON) {
            let sun = self.real.apparent_state("Sun", jd_utc)?;
            Ok(synthetic_moon(jd_utc, &sun))
        } else {
            self.real.apparent_state(body, jd_utc)
        }
    }
}

/// The real sky, except that the listed bodies are refused, the way a stub provider or
/// a body outside its coverage is. Keeps the error paths tested whatever is
/// implemented.
#[derive(Debug, Clone)]
pub struct Refusing {
    pub real: Sky,
    pub refuse: Vec<&'static str>,
}

impl Refusing {
    pub fn new(refuse: &[&'static str]) -> Self {
        Refusing {
            real: Sky::new(),
            refuse: refuse.to_vec(),
        }
    }

    fn check(&self, body: &str) -> Result<(), EphemerisError> {
        let c = skyfix_ephemeris::body::canonical(body).unwrap_or(body);
        if self.refuse.contains(&c) {
            Err(EphemerisError::Data(format!(
                "{c} is refused by this test provider"
            )))
        } else {
            Ok(())
        }
    }
}

impl AstroProvider for Refusing {
    fn name(&self) -> &str {
        "refusing test sky"
    }

    fn coverage(&self) -> Coverage {
        self.real.coverage()
    }

    fn geocentric(&self, body: &str, jd_utc: f64) -> Result<GeocentricDirection, EphemerisError> {
        self.check(body)?;
        self.real.geocentric(body, jd_utc)
    }
}

impl BodyEphemeris for Refusing {
    fn apparent_state(&self, body: &str, jd_utc: f64) -> Result<ApparentState, EphemerisError> {
        self.check(body)?;
        self.real.apparent_state(body, jd_utc)
    }
}

// ---------------------------------------------------------------------------
// Brute force: exact evaluation on a dense grid, linear interpolation
// ---------------------------------------------------------------------------

/// One exact evaluation: instant, topocentric geometric altitude, azimuth,
/// semidiameter (arcmin) and GHA.
#[derive(Debug, Clone, Copy)]
pub struct Exact {
    pub t: f64,
    pub alt: f64,
    pub az: f64,
    pub sd: f64,
    pub gha: f64,
}

/// Evaluate `body` **exactly** every `step_s` seconds over `[t0, t1]` (both ends
/// included). Independent of the event finder's track, extremum insertion and Brent
/// refinement.
pub fn dense_exact(
    eph: &dyn BodyEphemeris,
    body: &str,
    site: &Site,
    t0: f64,
    t1: f64,
    step_s: f64,
) -> Vec<Exact> {
    let n = ((t1 - t0) * 86_400.0 / step_s).ceil() as usize;
    let dt = (t1 - t0) / n as f64;
    (0..=n)
        .map(|k| {
            let t = if k == n { t1 } else { t0 + k as f64 * dt };
            let st = eph.apparent_state(body, t).unwrap();
            let h = horizontal(&st, site);
            Exact {
                t,
                alt: h.alt_deg,
                az: h.az_deg,
                sd: st.semidiameter_arcmin,
                gha: st.gha_deg,
            }
        })
        .collect()
}

/// Sign changes of `g` along dense exact samples, located by linear interpolation:
/// `(jd, rising)`.
pub fn brute_crossings(samples: &[Exact], g: impl Fn(&Exact) -> f64) -> Vec<(f64, bool)> {
    let mut out = Vec::new();
    for w in samples.windows(2) {
        let (ga, gb) = (g(&w[0]), g(&w[1]));
        if (ga >= 0.0) != (gb >= 0.0) {
            let f = ga / (ga - gb);
            out.push((w[0].t + f * (w[1].t - w[0].t), gb >= 0.0));
        }
    }
    out
}

/// Upper (`offset` 0) or lower (`offset` 180) meridian passages along dense samples.
pub fn brute_transits(samples: &[Exact], lon_deg: f64, offset: f64) -> Vec<f64> {
    let u = |e: &Exact| skyfix_core::units::norm_180(e.gha + lon_deg - offset);
    let mut out = Vec::new();
    for w in samples.windows(2) {
        let (ua, ub) = (u(&w[0]), u(&w[1]));
        if ua < 0.0 && ub >= 0.0 && ub - ua < 90.0 {
            let f = ua / (ua - ub);
            out.push(w[0].t + f * (w[1].t - w[0].t));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/reference")
        .join(name)
}

/// Load a `skyfix.reference/1` fixture as JSON.
pub fn load_fixture(name: &str) -> serde_json::Value {
    let path = fixture_path(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["schema"], "skyfix.reference/1", "{name}");
    v
}

/// Written while the Moon and planet providers were stubs, this used to return true
/// (and the tests calling it skipped, with a note on stderr that `cargo test` hides) when
/// the provider refused `body` at `jd`. Every provider is real now, so a refusal is a
/// regression: it fails the test, and the function always returns false.
pub fn skip_if_stub(body: &str, jd: f64, test: &str) -> bool {
    if let Err(e) = Sky::new().apparent_state(body, jd) {
        panic!(
            "{test}: the {body} provider refused JD {jd} ({e}); the Moon and planet \
             providers are real, so this is a regression, not a stub to skip"
        );
    }
    false
}

pub fn site_of(v: &serde_json::Value) -> Site {
    Site {
        lat_deg: v["lat_deg"].as_f64().unwrap(),
        lon_deg: v["lon_deg"].as_f64().unwrap(),
        height_m: v["height_m"].as_f64().unwrap_or(0.0),
        ..Site::default()
    }
}
