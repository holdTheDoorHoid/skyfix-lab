//! Latitude by Polaris, solved rigorously from the altitude equation.
//!
//! `docs/NAVIGATION_METHODS.md` section 3 is normative; this is a summary.
//!
//! No table is used. With `Ho` of Polaris, its apparent GHA and declination at the
//! sight (from the ephemeris, through the ordinary direction-source plumbing) and the
//! DR longitude, the altitude equation
//!
//! ```text
//! sin Ho = sin(phi) sin(dec) + cos(phi) cos(dec) cos(LHA),   LHA = GHA + lon_DR
//! ```
//!
//! is solved for `phi` exactly ([`super::latitudes_for_altitude`]). Its sigma adds, in
//! quadrature, the altitude's sigma `sigma_Ho / |cos Zn|`, the DR longitude's
//! `|tan Zn| sigma_E` (`d(phi)/dE = -tan Zn`, CONVENTIONS 3), and the clock's
//! `|cos(phi) tan Zn| w sigma_t`. For Polaris `Zn` is within a degree or two of north
//! at ordinary latitudes, which is why the longitude hardly matters; near the pole it
//! does, and [`Warning::PolarisNearPole`] says so.
//!
//! For teaching, each sight also carries the Nautical Almanac's Polaris-table terms,
//! unrounded ([`PolarisAlmanacTerms`]): `Latitude = Ho - 1 deg + a0 + a1 + a2` with
//!
//! ```text
//! a0 = 58.8' - p0 cos h0 + (1/2) p0 sin p0 sin^2 h0 tan 50 deg
//! a1 =  0.6' + (1/2) p0 sin p0 sin^2 h0 (tan phi - tan 50 deg)
//! a2 =  0.6' - p cos h + p0 cos h0
//! ```
//!
//! where `p = 90 - dec` is Polaris' polar distance, `h = LHA Aries + SHA` its hour
//! angle, and `p0`, `h0` use the year's mean SHA and declination (the Almanac's
//! "adopted mean position"). This is the formula the printed table is computed from
//! (Nautical Almanac, explanation of the Polaris tables); the rigorous latitude is
//! what the navigator should use, the terms are what the book would have given.

use super::{
    BodyTrack, SECONDS_PER_DAY, THREE_SIGMA, check_dr, check_vessel, clock_sigma_s, dr_move, hc_zn,
    latitudes_for_altitude, nothing_usable, resolve_dr,
};
use crate::SkyfixError;
use crate::geometry::Point;
use crate::reduce::{DirectionSource, reduce_observation};
use crate::time::{civil_to_jd, format_utc, parse_utc};
use crate::types::{
    GeocentricDirection, LatitudeEstimate, PolarisAlmanacTerms, PolarisOptions, PolarisResult,
    PolarisSight, ReducedSight, Session, Warning,
};
use crate::units::{norm_180, norm_360};

/// Observer latitude above which [`Warning::PolarisNearPole`] is raised, degrees.
pub const NEAR_POLE_LATITUDE_DEG: f64 = 88.0;
/// Polaris' bearing further than this from true north raises the same warning, degrees.
pub const NEAR_POLE_AZIMUTH_DEG: f64 = 20.0;
/// The printed a1 table runs from 0 to this latitude, degrees north.
pub const PRINTED_TABLE_MAX_LAT_DEG: f64 = 68.0;
/// Samples of Polaris' position used for the year's mean (every 5 days).
const MEAN_SAMPLES: usize = 73;

/// What the Almanac-style teaching terms need beyond a direction source: the GHA of
/// Aries, and Polaris' direction on any day of the year (for the year's mean position).
/// Implemented in the WASM adapter with `skyfix-ephemeris`; the core ships no sidereal
/// time of its own.
pub trait PolarisTableSource {
    /// Greenwich hour angle of the First Point of Aries, degrees, at `jd_utc`.
    fn gha_aries_deg(&self, jd_utc: f64) -> f64;
    /// Apparent geocentric direction of Polaris at `jd_utc`.
    fn polaris(&self, jd_utc: f64) -> Result<GeocentricDirection, String>;
}

/// True when the body name is Polaris (trimmed, case-insensitive).
pub fn is_polaris(body: &str) -> bool {
    body.trim().eq_ignore_ascii_case("polaris")
}

/// Latitude from one or more sights of Polaris. Non-Polaris observations in the session
/// are ignored with a warning naming them. See the module docs.
pub fn polaris_latitude(
    session: &Session,
    source: &dyn DirectionSource,
    table: Option<&dyn PolarisTableSource>,
    options: &PolarisOptions,
) -> Result<PolarisResult, SkyfixError> {
    let mut warnings: Vec<Warning> = Vec::new();
    let others: Vec<&str> = session
        .observations
        .iter()
        .filter(|o| !is_polaris(&o.body))
        .map(|o| o.id.as_str())
        .collect();
    if !others.is_empty() {
        warnings.push(Warning::Other {
            message: format!(
                "{} observation(s) that are not Polaris were ignored by the Polaris method: {}",
                others.len(),
                others.join(", ")
            ),
        });
    }
    let mut sights: Vec<ReducedSight> = Vec::new();
    let mut n_polaris = 0usize;
    for obs in session.observations.iter().filter(|o| is_polaris(&o.body)) {
        n_polaris += 1;
        match reduce_observation(session, obs, source) {
            Ok(s) => sights.push(s),
            Err(e) => warnings.push(Warning::Other {
                message: format!("{e}. This sight was not used."),
            }),
        }
    }
    if n_polaris == 0 {
        return Err(SkyfixError::InvalidField {
            field: "session.observations".to_string(),
            message: "the Polaris method needs at least one observation of Polaris".to_string(),
        });
    }
    if sights.is_empty() {
        return Err(nothing_usable("latitude by Polaris", n_polaris, &warnings));
    }
    sights.sort_by(|a, b| a.jd_utc.total_cmp(&b.jd_utc));

    let dr = resolve_dr(options.dr, session).ok_or_else(|| SkyfixError::InvalidField {
        field: "options.dr".to_string(),
        message: "latitude by Polaris needs a DR longitude (options.dr, or the session's \
                  assumed position): Polaris' correction depends on its hour angle, and the \
                  hour angle needs your longitude"
            .to_string(),
    })?;
    check_dr(&dr)?;
    check_vessel(options.vessel)?;
    let t_ref = match &options.reference_utc {
        Some(s) => parse_utc(s)?,
        None => sights.last().map_or(0.0, |s| s.jd_utc),
    };
    let dr_point = Point::from_deg(dr.lat_deg, dr.lon_deg);
    let clock = clock_sigma_s(session);
    let track = BodyTrack::new("Polaris", &sights, source);

    let mut solved: Vec<PolarisSight> = Vec::with_capacity(sights.len());
    // Latitude moved to the reference instant, independent sigma, and the two
    // correlated sensitivities (per NM east, per second of clock).
    let mut at_ref: Vec<(f64, f64, f64, f64)> = Vec::with_capacity(sights.len());
    for s in &sights {
        let dr_then = dr_move(dr_point, options.vessel, (s.jd_utc - t_ref) * 24.0);
        let lon = dr_then.lon;
        let dir = GeocentricDirection {
            gha_deg: s.gha_deg,
            dec_deg: s.dec_deg,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        };
        let candidates = latitudes_for_altitude(
            s.ho_deg.to_radians(),
            s.gha_deg.to_radians(),
            s.dec_deg.to_radians(),
            lon,
        );
        let Some(phi) = candidates
            .iter()
            .copied()
            .min_by(|a, b| (a - dr_then.lat).abs().total_cmp(&(b - dr_then.lat).abs()))
        else {
            warnings.push(Warning::Other {
                message: format!(
                    "sight {}: no latitude on your DR meridian sees Polaris at {:.4} deg at that \
                     time; check the time, the DR longitude and the sextant reading. This \
                     sight was not used.",
                    s.id, s.ho_deg
                ),
            });
            continue;
        };
        let p = Point::new(phi, lon);
        let (_, zn) = hc_zn(p, &dir);
        let cos_zn = zn.cos();
        if cos_zn.abs() < 1e-6 {
            warnings.push(Warning::Other {
                message: format!(
                    "sight {}: Polaris bears due east or west here, so its altitude says nothing \
                     about latitude. This sight was not used.",
                    s.id
                ),
            });
            continue;
        }
        let tan_zn = zn.tan();
        let lat_deg = phi.to_degrees();
        let sigma_alt = s.sigma_arcmin / cos_zn.abs();
        let per_nm = -tan_zn;
        let sigma_lon = dr.sigma_nm.map(|sig| per_nm.abs() * sig);
        let gha_rate_arcmin_per_s = track.gha_rate_deg_per_day(s.jd_utc) * 60.0 / SECONDS_PER_DAY;
        let per_s = phi.cos() * tan_zn * gha_rate_arcmin_per_s;
        let sigma_clock = per_s.abs() * clock;
        let sigma = sigma_alt.hypot(sigma_lon.unwrap_or(0.0)).hypot(sigma_clock);
        let zn_deg = norm_360(zn.to_degrees());
        if lat_deg > NEAR_POLE_LATITUDE_DEG || norm_180(zn_deg).abs() > NEAR_POLE_AZIMUTH_DEG {
            warnings.push(Warning::PolarisNearPole {
                id: s.id.clone(),
                latitude_deg: lat_deg,
                azimuth_deg: zn_deg,
            });
        }
        if (lat_deg - dr_then.lat_deg()).abs() > 1.0 {
            warnings.push(Warning::Other {
                message: format!(
                    "sight {}: the Polaris latitude {:.2} deg is more than a degree from your DR \
                     latitude {:.2} deg; check the DR, the body and the sextant reading",
                    s.id,
                    lat_deg,
                    dr_then.lat_deg()
                ),
            });
        }
        let almanac = table.and_then(|t| {
            let table_lat = if dr.lat_deg.is_finite() {
                dr_then.lat_deg()
            } else {
                lat_deg
            };
            almanac_terms(t, s, lon.to_degrees(), table_lat, lat_deg).ok()
        });
        let moved = dr_move(p, options.vessel, (t_ref - s.jd_utc) * 24.0);
        at_ref.push((moved.lat_deg(), sigma_alt, per_nm, per_s));
        solved.push(PolarisSight {
            id: s.id.clone(),
            utc: format_utc(s.jd_utc),
            jd_utc: s.jd_utc,
            ho_deg: s.ho_deg,
            gha_deg: s.gha_deg,
            dec_deg: s.dec_deg,
            dr_lon_deg: lon.to_degrees(),
            lha_deg: norm_360(s.gha_deg + lon.to_degrees()),
            azimuth_deg: zn_deg,
            latitude: LatitudeEstimate {
                lat_deg,
                sigma_arcmin: sigma,
            },
            sigma_from_altitude_arcmin: sigma_alt,
            sigma_from_longitude_arcmin: sigma_lon,
            sigma_from_clock_arcmin: sigma_clock,
            longitude_sensitivity_arcmin_per_nm: per_nm,
            correction_arcmin: (lat_deg - s.ho_deg) * 60.0,
            normalized_residual: None,
            almanac,
        });
    }
    if solved.is_empty() {
        return Err(SkyfixError::Other(
            "latitude by Polaris: no sight could be solved for latitude; see the warnings"
                .to_string(),
        ));
    }

    // Combine: independent altitude errors average down, the DR-longitude and clock
    // errors are shared by every sight and do not.
    let wsum: f64 = at_ref.iter().map(|(_, s, _, _)| 1.0 / (s * s)).sum();
    let mean = at_ref
        .iter()
        .map(|(lat, s, _, _)| lat / (s * s))
        .sum::<f64>()
        / wsum;
    let mean_nm = at_ref.iter().map(|(_, s, n, _)| n / (s * s)).sum::<f64>() / wsum;
    let mean_s = at_ref.iter().map(|(_, s, _, c)| c / (s * s)).sum::<f64>() / wsum;
    let sigma = (1.0 / wsum)
        .sqrt()
        .hypot(mean_nm.abs() * dr.sigma_nm.unwrap_or(0.0))
        .hypot(mean_s.abs() * clock);
    let n = solved.len();
    let chi2 = if n > 1 {
        let mut chi2 = 0.0;
        for (k, (lat, s, _, _)) in at_ref.iter().enumerate() {
            let r = (lat - mean) * 60.0;
            chi2 += (r / s) * (r / s);
            let w = 1.0 / (s * s);
            let z = r / (s * (1.0 - w / wsum).max(1e-12).sqrt());
            solved[k].normalized_residual = Some(z);
            if n >= 3 && z.abs() > THREE_SIGMA {
                warnings.push(Warning::RunOutlier {
                    id: solved[k].id.clone(),
                    normalized_residual: z,
                    rejected: false,
                });
            }
        }
        Some(chi2)
    } else {
        None
    };
    if dr.sigma_nm.is_none() {
        warnings.push(Warning::Other {
            message: format!(
                "your DR's uncertainty was not stated, so the Polaris latitude's sigma leaves out \
                 the longitude term (it moves {:.3}′ per NM of east-west error here)",
                mean_nm.abs()
            ),
        });
    }

    Ok(PolarisResult {
        latitude: LatitudeEstimate {
            lat_deg: mean,
            sigma_arcmin: sigma,
        },
        reference_utc: format_utc(t_ref),
        reference_jd_utc: t_ref,
        polaris: solved,
        chi2,
        dof: n as i64 - 1,
        sights,
        warnings,
    })
}

/// The Nautical Almanac Polaris-table terms for one sight, unrounded.
pub fn almanac_terms(
    table: &dyn PolarisTableSource,
    sight: &ReducedSight,
    lon_deg: f64,
    table_lat_deg: f64,
    rigorous_lat_deg: f64,
) -> Result<PolarisAlmanacTerms, String> {
    let jd = sight.jd_utc;
    let gha_aries = table.gha_aries_deg(jd);
    let lha_aries = norm_360(gha_aries + lon_deg);
    let sha = norm_360(sight.gha_deg - gha_aries);
    let (sha0, dec0) = annual_mean(table, jd)?;
    let arcmin = |deg: f64| deg * 60.0;
    let p = arcmin(90.0 - sight.dec_deg);
    let p0 = arcmin(90.0 - dec0);
    let h = (lha_aries + sha).to_radians();
    let h0 = (lha_aries + sha0).to_radians();
    let second0 = 0.5 * p0 * (p0 / 60.0).to_radians().sin() * h0.sin().powi(2);
    let tan50 = 50f64.to_radians().tan();
    let a0 = 58.8 - p0 * h0.cos() + second0 * tan50;
    let a1 = 0.6 + second0 * (table_lat_deg.to_radians().tan() - tan50);
    let a2 = 0.6 - p * h.cos() + p0 * h0.cos();
    let latitude_deg = sight.ho_deg + (-60.0 + a0 + a1 + a2) / 60.0;
    let within = (0.0..=PRINTED_TABLE_MAX_LAT_DEG).contains(&table_lat_deg);
    let mut note = format!(
        "Unrounded Nautical Almanac Polaris-table terms: a0 from LHA Aries {:.2}° with the \
         year's mean position of Polaris (SHA {:.2}°, Dec {:.4}°) at latitude 50°; a1 for \
         latitude {:.1}°; a2 for this date. The printed table rounds each to 0.1′ and \
         interpolates, so expect it to differ from these by a tenth or two.",
        lha_aries, sha0, dec0, table_lat_deg
    );
    if !within {
        note.push_str(&format!(
            " The printed a1 table runs from 0° to {PRINTED_TABLE_MAX_LAT_DEG}° N; at \
             {table_lat_deg:.1}° a navigator could not use it, and only the rigorous \
             latitude applies."
        ));
    }
    Ok(PolarisAlmanacTerms {
        lha_aries_deg: lha_aries,
        a0_arcmin: a0,
        a1_arcmin: a1,
        a2_arcmin: a2,
        latitude_deg,
        difference_arcmin: (rigorous_lat_deg - latitude_deg) * 60.0,
        table_latitude_deg: table_lat_deg,
        mean_sha_deg: sha0,
        mean_dec_deg: dec0,
        within_printed_table: within,
        note,
    })
}

/// Polaris' mean SHA and declination over the calendar year containing `jd_utc`.
fn annual_mean(table: &dyn PolarisTableSource, jd_utc: f64) -> Result<(f64, f64), String> {
    let year: i32 = format_utc(jd_utc)
        .get(..4)
        .and_then(|y| y.parse().ok())
        .ok_or_else(|| format!("cannot find the year of JD {jd_utc}"))?;
    let start = civil_to_jd(year, 1, 1);
    let mut sha_first: Option<f64> = None;
    let mut sha_sum = 0.0;
    let mut dec_sum = 0.0;
    for k in 0..MEAN_SAMPLES {
        let jd = start + 5.0 * k as f64;
        let d = table.polaris(jd)?;
        let sha = norm_360(d.gha_deg - table.gha_aries_deg(jd));
        let first = *sha_first.get_or_insert(sha);
        sha_sum += first + norm_180(sha - first);
        dec_sum += d.dec_deg;
    }
    let n = MEAN_SAMPLES as f64;
    Ok((norm_360(sha_sum / n), dec_sum / n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AltitudeKind, Clock, DrPosition, Instrument, LatLon, Limb, Observation, Observer,
        SESSION_SCHEMA, SessionMeta,
    };

    /// A Polaris-like star: fixed SHA and declination, sidereal GHA; Aries' GHA from a
    /// linear sidereal time. Enough to test the algebra without an ephemeris.
    struct FakeSky {
        sha: f64,
        dec: f64,
    }

    const T0: f64 = 2_461_308.0;
    const SIDEREAL_DEG_PER_DAY: f64 = 360.985_647;

    impl FakeSky {
        fn aries(&self, jd: f64) -> f64 {
            norm_360(100.0 + SIDEREAL_DEG_PER_DAY * (jd - T0))
        }
    }

    impl DirectionSource for FakeSky {
        fn name(&self) -> &str {
            "fake sky"
        }
        fn direction(&self, body: &str, jd: f64) -> Result<GeocentricDirection, String> {
            if !is_polaris(body) {
                return Err(format!("no {body}"));
            }
            Ok(GeocentricDirection {
                gha_deg: norm_360(self.aries(jd) + self.sha),
                dec_deg: self.dec,
                semidiameter_arcmin: 0.0,
                horizontal_parallax_arcmin: 0.0,
            })
        }
        fn gha_rate_deg_per_hour(&self, _body: &str) -> f64 {
            SIDEREAL_DEG_PER_DAY / 24.0
        }
    }

    impl PolarisTableSource for FakeSky {
        fn gha_aries_deg(&self, jd: f64) -> f64 {
            self.aries(jd)
        }
        fn polaris(&self, jd: f64) -> Result<GeocentricDirection, String> {
            self.direction("Polaris", jd)
        }
    }

    fn polaris_obs(id: &str, sky: &FakeSky, truth: Point, jd: f64, sigma: f64) -> Observation {
        let d = sky.direction("Polaris", jd).unwrap();
        let h = hc_zn(truth, &d).0.to_degrees();
        Observation {
            id: id.to_string(),
            body: "Polaris".to_string(),
            utc: format_utc(jd),
            altitude_deg: h,
            altitude_kind: AltitudeKind::ObservedHo,
            sigma_arcmin: sigma,
            limb: Limb::Center,
            horizon: None,
            geocentric: None,
            notes: String::new(),
        }
    }

    fn session(obs: Vec<Observation>) -> Session {
        Session {
            schema: SESSION_SCHEMA.to_string(),
            meta: SessionMeta::default(),
            observer: Observer::default(),
            instrument: Instrument::default(),
            clock: Clock::default(),
            observations: obs,
        }
    }

    #[test]
    fn a_noise_free_sight_gives_the_true_latitude_at_every_hour_angle() {
        let sky = FakeSky {
            sha: 317.0,
            dec: 89.35,
        };
        for &lat in &[2.0, 25.0, 40.8, 60.0, 75.0] {
            for hour in 0..12 {
                let jd = T0 + hour as f64 / 12.0;
                let truth = Point::from_deg(lat, -43.4);
                let s = session(vec![polaris_obs("p", &sky, truth, jd, 0.5)]);
                let options = PolarisOptions {
                    dr: Some(DrPosition {
                        lat_deg: lat + 0.3,
                        lon_deg: -43.4,
                        sigma_nm: Some(20.0),
                    }),
                    ..Default::default()
                };
                let r = polaris_latitude(&s, &sky, Some(&sky), &options).unwrap();
                assert!(
                    (r.latitude.lat_deg - lat).abs() * 60.0 < 1e-7,
                    "lat {lat} hour {hour}: {}",
                    r.latitude.lat_deg
                );
                let ps = &r.polaris[0];
                // The whole correction is at most the polar distance.
                assert!(ps.correction_arcmin.abs() <= 0.66 * 60.0 + 0.5);
                // The almanac formula agrees with the rigorous answer to a small fraction
                // of an arcminute inside the printed table's range.
                let a = ps.almanac.as_ref().unwrap();
                if lat <= 68.0 {
                    assert!(a.within_printed_table);
                    assert!(a.difference_arcmin.abs() < 0.2, "{lat}/{hour}: {a:?}");
                    assert!(a.a0_arcmin > 0.0 && a.a1_arcmin > 0.0 && a.a2_arcmin > 0.0);
                } else {
                    assert!(!a.within_printed_table);
                }
            }
        }
    }

    #[test]
    fn the_longitude_sensitivity_is_minus_tan_azimuth_and_enters_the_sigma() {
        let sky = FakeSky {
            sha: 317.0,
            dec: 89.35,
        };
        // Six hours of sidereal time from transit: Polaris is at its greatest azimuth.
        let jd = T0 + 0.25;
        let truth = Point::from_deg(45.0, 10.0);
        let s = session(vec![polaris_obs("p", &sky, truth, jd, 0.5)]);
        let dr = |sigma| PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: 45.0,
                lon_deg: 10.0,
                sigma_nm: sigma,
            }),
            ..Default::default()
        };
        let r = polaris_latitude(&s, &sky, None, &dr(Some(30.0))).unwrap();
        let ps = &r.polaris[0];
        let zn = ps.azimuth_deg.to_radians();
        assert!((ps.longitude_sensitivity_arcmin_per_nm + zn.tan()).abs() < 1e-12);
        assert!((ps.sigma_from_longitude_arcmin.unwrap() - zn.tan().abs() * 30.0).abs() < 1e-9);
        // Numerically: moving the DR 30 NM east moves the latitude by sensitivity * 30.
        let shifted = PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: 45.0,
                lon_deg: 10.0 + 0.5 / 45f64.to_radians().cos(),
                sigma_nm: Some(30.0),
            }),
            ..Default::default()
        };
        let r2 = polaris_latitude(&s, &sky, None, &shifted).unwrap();
        let moved = (r2.latitude.lat_deg - r.latitude.lat_deg) * 60.0;
        assert!(
            (moved - ps.longitude_sensitivity_arcmin_per_nm * 30.0).abs() < 0.01,
            "{moved} vs {}",
            ps.longitude_sensitivity_arcmin_per_nm * 30.0
        );
        // Without a stated DR uncertainty the term is missing and the result says so.
        let r3 = polaris_latitude(&s, &sky, None, &dr(None)).unwrap();
        assert!(r3.polaris[0].sigma_from_longitude_arcmin.is_none());
        assert!(
            r3.warnings
                .iter()
                .any(|w| matches!(w, Warning::Other { message } if message.contains("not stated")))
        );
    }

    #[test]
    fn near_the_pole_the_result_warns() {
        let sky = FakeSky {
            sha: 317.0,
            dec: 89.35,
        };
        let truth = Point::from_deg(89.0, 0.0);
        let s = session(vec![polaris_obs("p", &sky, truth, T0 + 0.25, 0.5)]);
        let options = PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: 88.9,
                lon_deg: 0.0,
                sigma_nm: Some(5.0),
            }),
            ..Default::default()
        };
        let r = polaris_latitude(&s, &sky, Some(&sky), &options).unwrap();
        assert!((r.latitude.lat_deg - 89.0).abs() * 60.0 < 1e-6);
        assert!(
            r.warnings
                .iter()
                .any(|w| matches!(w, Warning::PolarisNearPole { .. }))
        );
        assert!(!r.polaris[0].almanac.as_ref().unwrap().within_printed_table);
    }

    #[test]
    fn several_sights_combine_with_the_shared_longitude_error_kept_whole() {
        let sky = FakeSky {
            sha: 317.0,
            dec: 89.35,
        };
        let truth = Point::from_deg(41.0, -70.0);
        let obs: Vec<Observation> = (0..4)
            .map(|k| {
                polaris_obs(
                    &format!("p{k}"),
                    &sky,
                    truth,
                    T0 + 0.25 + k as f64 * 0.002,
                    1.0,
                )
            })
            .collect();
        let s = session(obs);
        let options = PolarisOptions {
            dr: Some(DrPosition {
                lat_deg: 41.2,
                lon_deg: -70.0,
                sigma_nm: Some(60.0),
            }),
            ..Default::default()
        };
        let r = polaris_latitude(&s, &sky, None, &options).unwrap();
        assert!((r.latitude.lat_deg - 41.0).abs() * 60.0 < 1e-6);
        assert_eq!(r.dof, 3);
        let single = &r.polaris[0];
        // Four sights halve the altitude part but not the DR-longitude part.
        let expected = (single.sigma_from_altitude_arcmin / 2.0)
            .hypot(single.sigma_from_longitude_arcmin.unwrap());
        assert!(
            (r.latitude.sigma_arcmin - expected).abs() < 0.02 * expected,
            "{} vs {expected}",
            r.latitude.sigma_arcmin
        );
    }

    #[test]
    fn other_bodies_are_ignored_and_no_polaris_is_an_error() {
        let sky = FakeSky {
            sha: 317.0,
            dec: 89.35,
        };
        let truth = Point::from_deg(41.0, -70.0);
        let mut obs = vec![polaris_obs("p", &sky, truth, T0, 1.0)];
        let mut vega = obs[0].clone();
        vega.id = "v".into();
        vega.body = "Vega".into();
        obs.push(vega.clone());
        let mut s = session(obs);
        s.observer.assumed_position = Some(LatLon {
            lat_deg: 41.0,
            lon_deg: -70.0,
        });
        let r = polaris_latitude(&s, &sky, None, &PolarisOptions::default()).unwrap();
        assert_eq!(r.polaris.len(), 1);
        assert!(
            r.warnings.iter().any(
                |w| matches!(w, Warning::Other { message } if message.contains("not Polaris"))
            )
        );
        s.observations = vec![vega];
        assert!(polaris_latitude(&s, &sky, None, &PolarisOptions::default()).is_err());
    }
}
