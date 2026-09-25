//! The uncertainty returned with every value (CONVENTIONS 14.1), one standard deviation.
//!
//! - **WMM2025**: NOAA NCEI's published error model (WMM2025 technical report section 3.4;
//!   <https://www.ncei.noaa.gov/products/world-magnetic-model/accuracy-limitations-magnetic-poles-error-model>):
//!   X 137 nT, Y 89 nT, Z 141 nT, H 133 nT, F 138 nT, I 0.20 deg and
//!   `D = sqrt(0.26^2 + (5417 / H)^2)` deg with H in nT, capped at 180 deg. It includes the
//!   crustal and disturbance fields a compass feels but the model leaves out, and the
//!   growth of the forecast error to 2030.
//! - **IGRF-14** (this project's composition of published figures, stated as such):
//!   Beggan (2022)'s evidence-based global standard deviations for 1980-2020 (repeat
//!   stations and observatories against the IGRF, as BGS publishes them): X 144 nT,
//!   Y 136 nT, Z 293 nT, H 135 nT, F 178 nT, I 0.29 deg; the declination takes the same
//!   `sqrt(0.26^2 + (5417/H)^2)` form, whose global mean (0.41 deg, WMM report) matches the
//!   IGRF's 0.39 deg. Every figure is widened by `s = sqrt(1 + (0.5 e / 136)^2)`, where `e`
//!   is the model's own global rms vector error in that year from the IAGA health warning
//!   (F. J. Lowes): 100 nT for 1900-1940, 300 falling to 100 nT over 1945-1960, 50 nT for
//!   1965-1995, 10 nT in 2000, 5 nT for 2005-2020, 10 nT at 2025.0, and after 2025 the
//!   forecast rate's typical 20 nT/yr error (`sqrt(10^2 + (20 dt)^2)`). `0.5 e` is the
//!   per-horizontal-component share of a vector error (5 of 10 nT, the same warning).

/// One standard deviation of each element (CONVENTIONS 14.1).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Uncertainty {
    /// Declination (variation), degrees.
    pub declination_deg: f64,
    /// Inclination (dip), degrees.
    pub inclination_deg: f64,
    pub horizontal_nt: f64,
    pub north_nt: f64,
    pub east_nt: f64,
    pub down_nt: f64,
    pub total_nt: f64,
    /// Where the numbers come from, in a sentence.
    pub basis: String,
}

/// Declination uncertainty, degrees, of the WMM2025 error model.
pub fn wmm2025_declination_sigma_deg(horizontal_nt: f64) -> f64 {
    if horizontal_nt <= 0.0 {
        return 180.0;
    }
    (0.26f64.powi(2) + (5417.0 / horizontal_nt).powi(2))
        .sqrt()
        .min(180.0)
}

pub(crate) fn wmm2025(horizontal_nt: f64) -> Uncertainty {
    Uncertainty {
        declination_deg: wmm2025_declination_sigma_deg(horizontal_nt),
        inclination_deg: 0.20,
        horizontal_nt: 133.0,
        north_nt: 137.0,
        east_nt: 89.0,
        down_nt: 141.0,
        total_nt: 138.0,
        basis: "WMM2025 error model (NOAA NCEI): one standard deviation between a \
                measurement and the model, crustal and disturbance fields included; \
                declination sqrt(0.26^2 + (5417/H)^2) degrees"
            .to_string(),
    }
}

/// The IGRF's own global rms vector error in decimal year `t`, nT (IAGA health warning).
pub fn igrf14_model_error_nt(t: f64) -> f64 {
    let lerp = |t0: f64, t1: f64, v0: f64, v1: f64| v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    if t < 1945.0 {
        100.0
    } else if t < 1960.0 {
        lerp(1945.0, 1960.0, 300.0, 100.0)
    } else if t < 1965.0 {
        lerp(1960.0, 1965.0, 100.0, 50.0)
    } else if t < 1995.0 {
        50.0
    } else if t < 2000.0 {
        lerp(1995.0, 2000.0, 50.0, 10.0)
    } else if t < 2005.0 {
        lerp(2000.0, 2005.0, 10.0, 5.0)
    } else if t < 2020.0 {
        5.0
    } else if t < 2025.0 {
        lerp(2020.0, 2025.0, 5.0, 10.0)
    } else {
        (10.0f64.powi(2) + (20.0 * (t - 2025.0)).powi(2)).sqrt()
    }
}

/// The factor every IGRF-14 uncertainty is widened by in decimal year `t`.
pub fn igrf14_era_factor(t: f64) -> f64 {
    (1.0 + (0.5 * igrf14_model_error_nt(t) / 136.0).powi(2)).sqrt()
}

pub(crate) fn igrf14(horizontal_nt: f64, t: f64) -> Uncertainty {
    let s = igrf14_era_factor(t);
    let e = igrf14_model_error_nt(t);
    Uncertainty {
        declination_deg: (s * wmm2025_declination_sigma_deg(horizontal_nt)).min(180.0),
        inclination_deg: 0.29 * s,
        horizontal_nt: 135.0 * s,
        north_nt: 144.0 * s,
        east_nt: 136.0 * s,
        down_nt: 293.0 * s,
        total_nt: 178.0 * s,
        basis: format!(
            "IGRF-14: global standard deviations of Beggan (2022) for 1980-2020 \
             (declination in the WMM2025 form, sqrt(0.26^2 + (5417/H)^2) degrees), widened \
             {s:.2} times for the model's own error in that year (about {e:.0} nT rms, IAGA)"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wmm_declination_error_follows_the_published_formula() {
        // 0.29 deg at the strongest horizontal field (41 875 nT, WMM report).
        assert!((wmm2025_declination_sigma_deg(41_875.0) - 0.290).abs() < 0.001);
        // Grows like 5417/H near the poles and is capped at 180 degrees.
        assert!((wmm2025_declination_sigma_deg(2000.0) - 2.721).abs() < 0.001);
        assert_eq!(wmm2025_declination_sigma_deg(1.0), 180.0);
        assert_eq!(wmm2025_declination_sigma_deg(0.0), 180.0);
    }

    #[test]
    fn the_igrf_is_widened_where_iaga_says_it_is_less_certain() {
        assert!((igrf14_era_factor(2010.0) - 1.0).abs() < 1e-3);
        assert!(igrf14_era_factor(1945.0) > 1.45 && igrf14_era_factor(1945.0) < 1.55);
        assert!((igrf14_model_error_nt(1952.5) - 200.0).abs() < 1e-9);
        assert!((igrf14_model_error_nt(2030.0) - 100.5).abs() < 0.1);
        let u = igrf14(20_000.0, 1985.0);
        assert!((u.declination_deg - 0.38).abs() < 0.01, "{u:?}");
    }
}
