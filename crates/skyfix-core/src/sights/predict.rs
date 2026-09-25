//! The predicted sextant reading (CONVENTIONS sections 3 and 5, run in reverse).
//!
//! A navigator presets the sextant before the stars come out; this module answers
//! "what will it read?". The computed altitude `Hc` of section 3 at the observer is the
//! `Ho` a perfect sight would reduce to, so the reading `Hs` is the root of
//! `correct_sight(Hs) = Hc`: the very chain [`crate::reduce`] uses, inverted
//! numerically. Nothing is re-derived, so a prediction and a reduction can never
//! disagree: reducing the predicted `Hs` gives back `Hc` to 1e-9'.
//!
//! The chain is monotonic in `Hs` (its slope is `1 - dR/dHa` over one or two), so the
//! root is bracketed from the lowest reading the horizon allows (`Ha = 0`, where the
//! refraction model of section 5 stops) and polished by regula falsi (Illinois).

use crate::SkyfixError;
use crate::corrections::{self, CorrectionInputs, SightBody};
use crate::geometry::{Point, altitude_azimuth};
use crate::types::{
    AltitudeKind, CorrectionBreakdown, GeocentricDirection, HorizonMode, Instrument, Limb,
    PredictedSight, SightObserver,
};
use crate::units::norm_360;

/// Convergence of the inversion, degrees (3.6e-9 arcseconds).
const TOLERANCE_DEG: f64 = 1e-12;

/// The reading a sextant would show for `body` from `observer` at `jd_utc`, given the
/// body's apparent geocentric `direction` (CONVENTIONS section 7) and where it came
/// from.
///
/// `limb` follows the chain's rules: lower or upper for the Sun and the Moon, and a
/// limb on a planet or star is ignored with a warning. Errors: invalid observer or
/// direction, a body below the lowest altitude the horizon lets a sextant show, and a
/// Moon direction without a horizontal parallax.
pub fn predict_sextant(
    observer: &SightObserver,
    instrument: &Instrument,
    body: &str,
    limb: Limb,
    jd_utc: f64,
    direction: GeocentricDirection,
    direction_source: &str,
) -> Result<PredictedSight, SkyfixError> {
    check_observer(observer)?;
    if !jd_utc.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: "jd_utc".to_string(),
        });
    }
    if !direction.gha_deg.is_finite() || !direction.dec_deg.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: format!("{body}: gha_deg/dec_deg"),
        });
    }
    if !(-90.0..=90.0).contains(&direction.dec_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: format!("{body}: dec_deg"),
            value: direction.dec_deg,
            min: -90.0,
            max: 90.0,
            max_exclusive: false,
        });
    }
    if !instrument.index_correction_arcmin.is_finite() {
        return Err(SkyfixError::NonFinite {
            field: "instrument.index_correction_arcmin".to_string(),
        });
    }

    let class = corrections::sight_body(body);
    let position = Point::from_deg(observer.lat_deg, observer.lon_deg);
    let (hc_rad, zn_rad) = altitude_azimuth(
        position,
        direction.gha_deg.to_radians(),
        direction.dec_deg.to_radians(),
    );
    let hc = hc_rad.to_degrees();
    let inputs = CorrectionInputs {
        id: body,
        is_sun: class == SightBody::Sun,
        limb,
        horizon: instrument.horizon,
        index_correction_arcmin: instrument.index_correction_arcmin,
        height_of_eye_m: observer.height_of_eye_m,
        pressure_hpa: observer.pressure_hpa,
        temperature_c: observer.temperature_c,
        direction: Some(direction),
    };
    let forward = |hs: f64| -> Result<CorrectionBreakdown, SkyfixError> {
        corrections::correct_sight(hs, AltitudeKind::SextantHs, 1.0, inputs, class)
    };

    let hs = invert(&forward, hc, reading_range_deg(observer, instrument), body)?;
    let breakdown = forward(hs)?;
    // Step 3 (index 2) ends at the apparent altitude: after IC and dip or halving.
    let ha = breakdown.steps[2].after_deg;
    let warnings = breakdown.warnings.clone();
    Ok(PredictedSight {
        body: body.to_string(),
        jd_utc,
        utc: crate::time::format_utc(jd_utc),
        limb,
        horizon: instrument.horizon,
        direction_source: direction_source.to_string(),
        gha_deg: norm_360(direction.gha_deg),
        dec_deg: direction.dec_deg,
        semidiameter_arcmin: direction.semidiameter_arcmin,
        horizontal_parallax_arcmin: direction.horizontal_parallax_arcmin,
        hc_deg: hc,
        zn_deg: norm_360(zn_rad.to_degrees()),
        hs_deg: hs,
        ha_deg: ha,
        corrections: breakdown,
        warnings,
    })
}

/// The sextant readings at which the apparent altitude is 0 and 90 degrees: the range
/// the refraction model of CONVENTIONS section 5 accepts.
fn reading_range_deg(observer: &SightObserver, instrument: &Instrument) -> (f64, f64) {
    let ic = instrument.index_correction_arcmin / 60.0;
    match instrument.horizon {
        HorizonMode::Sea | HorizonMode::Shore { .. } => {
            let dip = corrections::horizon_dip_arcmin(instrument.horizon, observer.height_of_eye_m)
                / 60.0;
            (dip - ic, 90.0 + dip - ic)
        }
        HorizonMode::ArtificialReflected => (-ic, 180.0 - ic),
        HorizonMode::ElectronicVertical => (-ic, 90.0 - ic),
    }
}

/// Solve `forward(hs).ho_deg = target` within the readings the horizon allows.
///
/// A reading the chain refuses (a centre past the zenith) counts as "too high", so the
/// bracket stays valid; inside it, regula falsi with bisection whenever an end is not a
/// number.
fn invert(
    forward: &dyn Fn(f64) -> Result<CorrectionBreakdown, SkyfixError>,
    target: f64,
    range: (f64, f64),
    body: &str,
) -> Result<f64, SkyfixError> {
    let (lowest, highest) = range;
    // The lowest reading the horizon allows. Rounding can put it a hair below Ha = 0.
    let mut a = lowest;
    let lo_ho = match forward(a) {
        Ok(b) => b.ho_deg,
        Err(_) => {
            a += 1e-9;
            forward(a)?.ho_deg
        }
    };
    if target < lo_ho {
        return Err(SkyfixError::Other(format!(
            "{body} is below the visible horizon here: its computed altitude is {target:.3} deg, \
             and the lowest reading a sextant can take (apparent altitude 0 deg) corresponds \
             to {lo_ho:.3} deg"
        )));
    }
    let f = |hs: f64| match forward(hs) {
        Ok(b) => b.ho_deg - target,
        Err(_) => f64::INFINITY,
    };
    let mut fa = lo_ho - target;
    if fa == 0.0 {
        return Ok(a);
    }
    // First guess: the reading whose apparent altitude is the target, then step up.
    let slope = if highest - lowest > 91.0 { 2.0 } else { 1.0 };
    let mut b = (lowest + slope * target).clamp(a + 1e-9, highest);
    let mut fb = f(b);
    while fb < 0.0 {
        if b >= highest {
            return Err(SkyfixError::Other(format!(
                "{body}: no sextant reading reduces to {target:.4} deg"
            )));
        }
        a = b;
        fa = fb;
        b = (b + 0.5).min(highest);
        fb = f(b);
    }
    // Illinois: halve the stale end's value when the same end moves twice running.
    let mut side = 0;
    for _ in 0..300 {
        let x = if fb.is_finite() {
            let x = a - fa * (b - a) / (fb - fa);
            if x > a && x < b { x } else { 0.5 * (a + b) }
        } else {
            0.5 * (a + b)
        };
        let fx = f(x);
        if fx.abs() < TOLERANCE_DEG || (b - a) < TOLERANCE_DEG {
            return Ok(x);
        }
        if fx < 0.0 {
            a = x;
            fa = fx;
            if side == -1 && fb.is_finite() {
                fb /= 2.0;
            }
            side = -1;
        } else {
            b = x;
            fb = fx;
            if side == 1 {
                fa /= 2.0;
            }
            side = 1;
        }
    }
    Ok(0.5 * (a + b))
}

fn check_observer(o: &SightObserver) -> Result<(), SkyfixError> {
    for (field, v) in [
        ("observer.lat_deg", o.lat_deg),
        ("observer.lon_deg", o.lon_deg),
        ("observer.height_of_eye_m", o.height_of_eye_m),
        ("observer.pressure_hpa", o.pressure_hpa),
        ("observer.temperature_c", o.temperature_c),
    ] {
        if !v.is_finite() {
            return Err(SkyfixError::NonFinite {
                field: field.to_string(),
            });
        }
    }
    if !(-90.0..=90.0).contains(&o.lat_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: "observer.lat_deg".to_string(),
            value: o.lat_deg,
            min: -90.0,
            max: 90.0,
            max_exclusive: false,
        });
    }
    if !(-180.0..=180.0).contains(&o.lon_deg) {
        return Err(SkyfixError::AngleOutOfRange {
            field: "observer.lon_deg".to_string(),
            value: o.lon_deg,
            min: -180.0,
            max: 180.0,
            max_exclusive: false,
        });
    }
    if o.height_of_eye_m < 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "observer.height_of_eye_m".to_string(),
            message: format!("must be >= 0 (got {})", o.height_of_eye_m),
        });
    }
    if o.pressure_hpa <= 0.0 || 273.0 + o.temperature_c <= 0.0 {
        return Err(SkyfixError::InvalidField {
            field: "observer.pressure_hpa/temperature_c".to_string(),
            message: "pressure must be positive and temperature above -273 C".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Warning;

    fn observer() -> SightObserver {
        SightObserver {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
            height_of_eye_m: 3.0,
            pressure_hpa: 1010.0,
            temperature_c: 10.0,
        }
    }

    fn reduce(p: &PredictedSight, observer: &SightObserver, instrument: &Instrument) -> f64 {
        corrections::correct_sight(
            p.hs_deg,
            AltitudeKind::SextantHs,
            1.0,
            CorrectionInputs {
                id: "x",
                is_sun: p.body == "Sun",
                limb: p.limb,
                horizon: instrument.horizon,
                index_correction_arcmin: instrument.index_correction_arcmin,
                height_of_eye_m: observer.height_of_eye_m,
                pressure_hpa: observer.pressure_hpa,
                temperature_c: observer.temperature_c,
                direction: Some(GeocentricDirection {
                    gha_deg: p.gha_deg,
                    dec_deg: p.dec_deg,
                    semidiameter_arcmin: p.semidiameter_arcmin,
                    horizontal_parallax_arcmin: p.horizontal_parallax_arcmin,
                }),
            },
            corrections::sight_body(&p.body),
        )
        .unwrap()
        .ho_deg
    }

    #[test]
    fn a_prediction_reduces_back_to_its_computed_altitude_for_every_body_and_horizon() {
        let obs = observer();
        let moon = GeocentricDirection {
            gha_deg: 100.0,
            dec_deg: 20.0,
            semidiameter_arcmin: 16.3,
            horizontal_parallax_arcmin: 59.8,
        };
        let sun = GeocentricDirection {
            gha_deg: 60.0,
            dec_deg: -3.0,
            semidiameter_arcmin: 16.0,
            horizontal_parallax_arcmin: 0.15,
        };
        let venus = GeocentricDirection {
            gha_deg: 110.0,
            dec_deg: 5.0,
            semidiameter_arcmin: 0.4,
            horizontal_parallax_arcmin: 0.5,
        };
        let vega = GeocentricDirection {
            gha_deg: 70.0,
            dec_deg: 38.8,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        };
        for horizon in [
            HorizonMode::Sea,
            HorizonMode::ArtificialReflected,
            HorizonMode::ElectronicVertical,
        ] {
            let instrument = Instrument {
                name: String::new(),
                index_correction_arcmin: -1.3,
                horizon,
            };
            for (body, dir, limb) in [
                ("Moon", moon, Limb::Lower),
                ("Moon", moon, Limb::Upper),
                ("Sun", sun, Limb::Lower),
                ("Venus", venus, Limb::Center),
                ("Vega", vega, Limb::Center),
            ] {
                let p = predict_sextant(&obs, &instrument, body, limb, 2.46e6, dir, "test")
                    .unwrap_or_else(|e| panic!("{body} {horizon:?}: {e}"));
                assert_eq!(p.corrections.ho_deg, reduce(&p, &obs, &instrument));
                assert!(
                    (p.corrections.ho_deg - p.hc_deg).abs() < 1e-11,
                    "{body} {horizon:?}: {} vs {}",
                    p.corrections.ho_deg,
                    p.hc_deg
                );
                if horizon == HorizonMode::ArtificialReflected {
                    assert!(
                        (p.hs_deg - (2.0 * p.ha_deg + 1.3 / 60.0)).abs() < 1e-9,
                        "the double angle"
                    );
                }
            }
        }
    }

    #[test]
    fn the_moons_reading_is_about_a_degree_below_its_computed_altitude() {
        // Parallax (up to 61') more than cancels refraction and the semidiameter: a
        // navigator who preset Hc would not find the Moon in the telescope.
        let obs = SightObserver {
            height_of_eye_m: 0.0,
            ..observer()
        };
        let p = predict_sextant(
            &obs,
            &Instrument::default(),
            "Moon",
            Limb::Lower,
            2.46e6,
            GeocentricDirection {
                gha_deg: 75.1652 + 30.0,
                dec_deg: 10.0,
                semidiameter_arcmin: 16.5,
                horizontal_parallax_arcmin: 60.5,
            },
            "test",
        )
        .unwrap();
        let drop = (p.hc_deg - p.hs_deg) * 60.0;
        assert!((30.0..60.0).contains(&drop), "{drop}'");
    }

    #[test]
    fn a_body_below_the_horizon_has_no_reading_and_a_limb_on_a_planet_is_a_warning() {
        let obs = observer();
        let below = GeocentricDirection {
            gha_deg: 75.1652 + 120.0,
            dec_deg: -30.0,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        };
        let e = predict_sextant(
            &obs,
            &Instrument::default(),
            "Sirius",
            Limb::Center,
            2.46e6,
            below,
            "t",
        )
        .unwrap_err();
        assert!(e.to_string().contains("below the visible horizon"), "{e}");

        let up = GeocentricDirection {
            gha_deg: 75.1652,
            dec_deg: 10.0,
            semidiameter_arcmin: 0.2,
            horizontal_parallax_arcmin: 0.3,
        };
        let p = predict_sextant(
            &obs,
            &Instrument::default(),
            "Jupiter",
            Limb::Lower,
            2.46e6,
            up,
            "t",
        )
        .unwrap();
        assert!(
            p.warnings
                .iter()
                .any(|w| matches!(w, Warning::LimbIgnoredForStar { .. })),
            "{:?}",
            p.warnings
        );
    }

    #[test]
    fn nonsense_observers_are_refused() {
        let mut o = observer();
        o.lat_deg = 91.0;
        let d = GeocentricDirection {
            gha_deg: 0.0,
            dec_deg: 0.0,
            semidiameter_arcmin: 0.0,
            horizontal_parallax_arcmin: 0.0,
        };
        assert!(
            predict_sextant(
                &o,
                &Instrument::default(),
                "Vega",
                Limb::Center,
                2.46e6,
                d,
                "t"
            )
            .is_err()
        );
        let mut o = observer();
        o.height_of_eye_m = f64::NAN;
        assert!(
            predict_sextant(
                &o,
                &Instrument::default(),
                "Vega",
                Limb::Center,
                2.46e6,
                d,
                "t"
            )
            .is_err()
        );
    }
}
