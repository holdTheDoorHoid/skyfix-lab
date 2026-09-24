//! The simulator's own dip and refraction, and the **reverse** correction chain.
//!
//! CONVENTIONS section 5 describes how a reducer turns a raw sextant reading `Hs` into a
//! fully corrected altitude `Ho`. The simulator needs the opposite: it knows the true
//! `Ho` and must invent the raw reading a navigator would have written down.
//!
//! These functions deliberately **do not** call `skyfix_core::corrections`. If the
//! simulator used the reducer's own code, a sign error in the chain would cancel out and
//! the round-trip test would pass while both halves were wrong. Two independent
//! implementations of the same published formulae can only agree when both are right, so
//! this module restates them:
//!
//! - Dip (sea horizon only): `D = 1.76' * sqrt(height_of_eye_m)`.
//! - Refraction (Bennett 1982): `R' = cot(Ha + 7.31 / (Ha + 4.4))`, `Ha` in degrees,
//!   scaled by `(P / 1010 hPa) * (283 / (273 + T_C))`.
//!
//! Forward (sea horizon, star, centre limb: no semidiameter, no parallax):
//!
//! ```text
//! Ha = Hs + IC - D          (index correction added, dip subtracted)
//! Ho = Ha - R(Ha)           (refraction subtracted)
//! ```
//!
//! Reverse, which is what the simulator runs:
//!
//! ```text
//! Ha = Ho + R(Ha)           solved by fixed-point iteration, because R depends on Ha
//! Hs = Ha - IC + D
//! ```
//!
//! The fixed point converges because `|dR/dHa| < 0.22` everywhere Bennett is valid; it is
//! worst at the horizon and negligible above 10 degrees.

/// Standard-atmosphere reference pressure, hPa (CONVENTIONS section 5).
pub const STANDARD_PRESSURE_HPA: f64 = 1010.0;
/// Standard-atmosphere reference temperature, degrees Celsius.
pub const STANDARD_TEMPERATURE_C: f64 = 10.0;

/// Dip of the sea horizon in arcminutes for a height of eye in metres.
/// `0` for a height of zero; negative heights are a caller error and are clamped to 0.
pub fn dip_arcmin(height_of_eye_m: f64) -> f64 {
    1.76 * height_of_eye_m.max(0.0).sqrt()
}

/// Bennett (1982) refraction in arcminutes for an apparent altitude in degrees, scaled
/// for pressure and temperature. The caller enforces the validity range (`Ha >= 0`).
pub fn refraction_arcmin(apparent_altitude_deg: f64, pressure_hpa: f64, temperature_c: f64) -> f64 {
    let ha = apparent_altitude_deg;
    let x_deg = ha + 7.31 / (ha + 4.4);
    let cot = 1.0 / x_deg.to_radians().tan();
    cot * (pressure_hpa / STANDARD_PRESSURE_HPA) * (283.0 / (273.0 + temperature_c))
}

/// Forward chain, sea horizon, star, centre limb: raw reading -> observed altitude.
/// Present so the reverse chain can be round-trip tested inside this crate.
pub fn hs_to_ho(
    hs_deg: f64,
    index_correction_arcmin: f64,
    height_of_eye_m: f64,
    pressure_hpa: f64,
    temperature_c: f64,
) -> Result<f64, String> {
    let ha = hs_deg + (index_correction_arcmin - dip_arcmin(height_of_eye_m)) / 60.0;
    if ha < 0.0 {
        return Err(format!(
            "apparent altitude {ha:.4} deg is below the horizon: Bennett refraction is not \
             defined there (CONVENTIONS section 5, RefractionOutOfRange)"
        ));
    }
    Ok(ha - refraction_arcmin(ha, pressure_hpa, temperature_c) / 60.0)
}

/// Reverse of the refraction step: the apparent altitude whose refraction correction
/// yields `ho_deg`. Fixed-point iteration, converged to better than 1e-12 degrees
/// (6 microarcseconds), which is far below any quantity in this project.
pub fn ho_to_ha(ho_deg: f64, pressure_hpa: f64, temperature_c: f64) -> Result<f64, String> {
    let mut ha = ho_deg;
    for _ in 0..200 {
        // Bennett is evaluated at the current iterate; keep it inside its domain.
        let probe = ha.max(0.0);
        let next = ho_deg + refraction_arcmin(probe, pressure_hpa, temperature_c) / 60.0;
        if (next - ha).abs() < 1e-12 {
            ha = next;
            if ha < 0.0 {
                return Err(format!(
                    "observed altitude {ho_deg:.4} deg implies an apparent altitude below the \
                     horizon: the refraction model has no valid inverse there"
                ));
            }
            return Ok(ha);
        }
        ha = next;
    }
    Err(format!(
        "refraction inversion did not converge for Ho = {ho_deg} deg"
    ))
}

/// Full reverse chain, sea horizon, star, centre limb: observed altitude -> raw reading.
///
/// `index_correction_arcmin` is the value the session will declare in
/// `Instrument::index_correction_arcmin`, i.e. the quantity the reducer *adds*.
pub fn ho_to_hs(
    ho_deg: f64,
    index_correction_arcmin: f64,
    height_of_eye_m: f64,
    pressure_hpa: f64,
    temperature_c: f64,
) -> Result<f64, String> {
    let ha = ho_to_ha(ho_deg, pressure_hpa, temperature_c)?;
    Ok(ha + (dip_arcmin(height_of_eye_m) - index_correction_arcmin) / 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dip_matches_the_almanac_and_the_imperial_form() {
        assert_eq!(dip_arcmin(0.0), 0.0);
        assert_eq!(dip_arcmin(-3.0), 0.0, "negative heights clamp, not NaN");
        // 1.76 sqrt(metres).
        assert!((dip_arcmin(4.0) - 3.52).abs() < 1e-12);
        assert!((dip_arcmin(2.0) - 2.489_015_869_776_647_3).abs() < 1e-15);
        // CONVENTIONS section 5: "equals 0.97' sqrt(height_ft)". The two constants
        // differ by 0.19 %, which is the rounding in the published pair, not an error.
        for h_m in [1.0, 2.0, 5.0, 10.0, 25.0] {
            let imperial = 0.97 * (h_m / 0.3048_f64).sqrt();
            let rel = (dip_arcmin(h_m) - imperial).abs() / imperial;
            assert!(rel < 0.005, "height {h_m} m: {rel} relative difference");
        }
    }

    #[test]
    fn bennett_refraction_matches_published_values() {
        // Regression values computed from the CONVENTIONS section 5 formula, checked
        // against the standard Nautical Almanac refraction figures in the comment.
        let cases = [
            (0.0, 34.477_533_743, 34.5), // horizon
            (5.0, 9.883_144_234, 9.9),   // the low-altitude sigma-inflation threshold
            (10.0, 5.391_505_468, 5.3),  // the low-altitude flag threshold
            (20.0, 2.703_410_700, 2.6),  // mid sky
            (45.0, 0.994_847_968, 1.0),  // the usual worked example
            (60.0, 0.574_711_802, 0.6),  //
        ];
        for (ha, exact, almanac) in cases {
            let r = refraction_arcmin(ha, STANDARD_PRESSURE_HPA, STANDARD_TEMPERATURE_C);
            assert!(
                (r - exact).abs() < 1e-9,
                "Bennett at {ha} deg: got {r}, pinned {exact}"
            );
            assert!(
                (r - almanac).abs() < 0.12,
                "Bennett at {ha} deg: {r} is not within 0.12' of the almanac value {almanac}"
            );
        }
        // At the zenith Bennett overshoots by a fraction of an arcsecond and goes
        // very slightly negative. That is the published model's own behaviour.
        let z = refraction_arcmin(90.0, STANDARD_PRESSURE_HPA, STANDARD_TEMPERATURE_C);
        assert!(z.abs() < 0.002, "zenith refraction {z}");
        // Monotonically decreasing with altitude.
        let mut prev = f64::INFINITY;
        for i in 0..=90 {
            let r = refraction_arcmin(i as f64, STANDARD_PRESSURE_HPA, STANDARD_TEMPERATURE_C);
            assert!(r < prev, "refraction not decreasing at {i} deg");
            prev = r;
        }
    }

    #[test]
    fn refraction_scales_with_pressure_and_temperature() {
        let base = refraction_arcmin(30.0, 1010.0, 10.0);
        // Half the pressure, half the refraction.
        let half = refraction_arcmin(30.0, 505.0, 10.0);
        assert!((half - base / 2.0).abs() < 1e-12);
        // Colder air is denser: more refraction.
        assert!(refraction_arcmin(30.0, 1010.0, -10.0) > base);
        assert!(refraction_arcmin(30.0, 1010.0, 30.0) < base);
        // The published scale factor, exactly.
        let want = base * (980.0 / 1010.0) * (283.0 / (273.0 + 25.0));
        assert!((refraction_arcmin(30.0, 980.0, 25.0) - want).abs() < 1e-12);
    }

    #[test]
    fn reverse_chain_round_trips_against_the_forward_chain() {
        // Every combination a scenario can ask for.
        for ho in [0.5, 2.0, 5.0, 12.0, 25.0, 40.0, 61.0, 80.0, 89.5] {
            for hoe in [0.0, 2.0, 5.5, 20.0] {
                for ic in [-2.5, 0.0, 1.75] {
                    for (p, t) in [(1010.0, 10.0), (980.0, 25.0), (1030.0, -5.0)] {
                        let hs = ho_to_hs(ho, ic, hoe, p, t).unwrap();
                        let back = hs_to_ho(hs, ic, hoe, p, t).unwrap();
                        assert!(
                            (back - ho).abs() < 1e-11,
                            "Ho {ho} hoe {hoe} ic {ic} P {p} T {t}: reversed to Hs {hs}, \
                             forward gave {back}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn reverse_chain_signs_are_the_documented_ones() {
        // A raw reading is always HIGHER than the observed altitude at a positive height
        // of eye with no index correction: dip is subtracted going forwards, so it must
        // be added coming back, and refraction likewise.
        let ho = 30.0;
        let hs = ho_to_hs(ho, 0.0, 4.0, 1010.0, 10.0).unwrap();
        let dip = dip_arcmin(4.0);
        let ha = ho_to_ha(ho, 1010.0, 10.0).unwrap();
        assert!(hs > ho);
        assert!((ha - ho) * 60.0 > 1.0, "refraction must raise Ha above Ho");
        assert!((hs - (ha + dip / 60.0)).abs() < 1e-12);
        // Index correction is ADDED by the reducer, so a positive IC lowers the reading.
        let hs_pos_ic = ho_to_hs(ho, 2.0, 4.0, 1010.0, 10.0).unwrap();
        assert!((hs_pos_ic - (hs - 2.0 / 60.0)).abs() < 1e-12);
        // CONVENTIONS section 5: index error 2.0' ON THE ARC gives IC = -2.0', and that
        // raises the raw reading by 2.0'.
        let hs_on_arc = ho_to_hs(ho, -2.0, 4.0, 1010.0, 10.0).unwrap();
        assert!((hs_on_arc - (hs + 2.0 / 60.0)).abs() < 1e-12);
    }

    #[test]
    fn inversion_is_exact_at_the_pinned_bennett_values() {
        // Ha -> Ho -> Ha must return the same apparent altitude.
        for ha in [0.0, 1.0, 5.0, 10.0, 20.0, 45.0, 60.0, 89.0] {
            let ho = ha - refraction_arcmin(ha, 1010.0, 10.0) / 60.0;
            let back = ho_to_ha(ho, 1010.0, 10.0).unwrap();
            assert!((back - ha).abs() < 1e-11, "Ha {ha} -> Ho {ho} -> {back}");
        }
    }

    #[test]
    fn below_the_horizon_is_refused_not_fudged() {
        // Ho far below the horizon has no valid apparent altitude.
        assert!(ho_to_ha(-5.0, 1010.0, 10.0).is_err());
        assert!(ho_to_hs(-5.0, 0.0, 2.0, 1010.0, 10.0).is_err());
        // A reading that corrects to a negative apparent altitude is refused too.
        assert!(hs_to_ho(-1.0, 0.0, 10.0, 1010.0, 10.0).is_err());
        // Ho just below zero is still valid: refraction lifts the body into view.
        let ha = ho_to_ha(-0.4, 1010.0, 10.0).unwrap();
        assert!(ha > 0.0 && ha < 0.3, "Ha {ha}");
    }
}
