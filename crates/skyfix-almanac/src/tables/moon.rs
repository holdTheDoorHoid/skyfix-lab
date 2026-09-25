//! Altitude Correction Tables for the Moon (the Nautical Almanac's inside back cover and
//! the page facing it), in two parts.
//!
//! The Moon's correction depends on its apparent altitude `Ha` and its horizontal
//! parallax `HP` (54′ to 61.5′). This project's chain (CONVENTIONS 5) gives it exactly:
//!
//! ```text
//! C(Ha, HP, limb) = Ho − Ha,   Ho from Ha by: refraction R(Ha) (Bennett, 1010 hPa, 10 °C);
//!                              the limb to the centre with the augmented semidiameter
//!                              SD' (SD = asin(0.2725076 sin HP)); the rigorous parallax
//!                              asin(sin HP cos h) at the centre's airless altitude h.
//! ```
//!
//! The printed table splits it the way the Nautical Almanac does:
//!
//! - **Upper part**, argument `Ha` every 10′ from 0° to 89° 50′: `C(Ha, 57.7′, lower) − 5′`,
//!   the lower-limb correction at the table's mean horizontal parallax 57.7′.
//! - **Lower part**, arguments `HP` (54.0′ to 61.5′ every 0.3′) in the same 5° column as
//!   the upper part's entry, evaluated at the column's middle altitude (2.5°, 7.5°, …):
//!   `L = C(Ha_c, HP, lower) − C(Ha_c, 57.7′, lower) + 5′` and
//!   `U = C(Ha_c, HP, upper) − C(Ha_c, 57.7′, lower) + 35′`.
//! - **Use**: upper part + L (lower limb), or upper part + U − 30′ (upper limb). The 5′
//!   and 35′ keep every entry positive; the 30′ taken off the upper limb gives them back.
//!
//! Evaluating the lower part at the column's middle altitude, and the upper part's 10′
//! rows, are the table's own approximations; the reference test measures how far the
//! two parts together can be from the exact correction.

use serde::{Deserialize, Serialize};
use skyfix_core::corrections::{limb_to_centre, rigorous_parallax_in_altitude_arcmin};

use super::altitude::standard_refraction_arcmin;
use super::{ArcminCell, BANNER};

/// The printed table's mean horizontal parallax, arcminutes.
pub const HP0_ARCMIN: f64 = 57.7;
/// The Moon's radius in units of the Earth's equatorial radius (IAU), as the ephemeris
/// uses it: `SD = asin(k sin HP)`.
pub const MOON_K: f64 = 0.272_507_6;
/// What the lower part adds (lower limb) and what the upper part takes off.
pub const LOWER_OFFSET_ARCMIN: f64 = 5.0;
/// What the lower part adds for the upper limb (30′ of it is subtracted in use).
pub const UPPER_OFFSET_ARCMIN: f64 = 35.0;
/// The horizontal parallaxes of the lower part: 54.0′ to 61.5′ every 0.3′.
pub fn hp_rows() -> Vec<f64> {
    (0..26).map(|k| 54.0 + 0.3 * f64::from(k)).collect()
}

/// Which limb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoonLimb {
    Lower,
    Upper,
}

/// The exact correction `Ho − Ha` of the chain for the Moon, arcminutes.
pub fn moon_correction_arcmin(ha_deg: f64, hp_arcmin: f64, limb: MoonLimb) -> f64 {
    let r = standard_refraction_arcmin(ha_deg);
    let airless = ha_deg - r / 60.0;
    let sd = (MOON_K * (hp_arcmin / 60.0).to_radians().sin())
        .asin()
        .to_degrees()
        * 60.0;
    let sign = match limb {
        MoonLimb::Lower => 1.0,
        MoonLimb::Upper => -1.0,
    };
    let (_, centre) = limb_to_centre(airless, sign, sd, hp_arcmin);
    let p = rigorous_parallax_in_altitude_arcmin(hp_arcmin, centre);
    (centre + p / 60.0 - ha_deg) * 60.0
}

/// One 5° column of the table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonColumn {
    /// 0, 5, …, 85: the column covers `from_deg`° 00′ to `from_deg + 4`° 50′.
    pub from_deg: u32,
    /// 30 entries of the upper part: row `(deg − from_deg) × 6 + minutes / 10`.
    pub upper: Vec<ArcminCell>,
    /// The altitude the lower part is evaluated at: the column's middle.
    pub lower_alt_deg: f64,
    /// The lower part, one entry per [`MoonTable::hp_rows`]: lower limb (L).
    pub lower_limb: Vec<ArcminCell>,
    /// Upper limb (U); subtract 30′ in use.
    pub upper_limb: Vec<ArcminCell>,
}

/// The Moon's altitude correction table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonTable {
    pub hp0_arcmin: f64,
    /// 54.0′ to 61.5′ every 0.3′.
    pub hp_rows: Vec<f64>,
    /// 18 columns, 0°–4° to 85°–89°.
    pub columns: Vec<MoonColumn>,
    pub how_to_use: String,
    pub notes: Vec<String>,
}

/// The Moon's two-part table.
pub fn moon_table() -> MoonTable {
    let hps = hp_rows();
    let columns = (0..18u32)
        .map(|c| {
            let from_deg = 5 * c;
            let upper = (0..30)
                .map(|r| {
                    let ha = f64::from(from_deg) + f64::from(r) / 6.0;
                    ArcminCell::plain(
                        moon_correction_arcmin(ha, HP0_ARCMIN, MoonLimb::Lower)
                            - LOWER_OFFSET_ARCMIN,
                    )
                })
                .collect();
            let mid = f64::from(from_deg) + 2.5;
            let base = moon_correction_arcmin(mid, HP0_ARCMIN, MoonLimb::Lower);
            let lower_limb = hps
                .iter()
                .map(|&hp| {
                    ArcminCell::plain(
                        moon_correction_arcmin(mid, hp, MoonLimb::Lower) - base
                            + LOWER_OFFSET_ARCMIN,
                    )
                })
                .collect();
            let upper_limb = hps
                .iter()
                .map(|&hp| {
                    ArcminCell::plain(
                        moon_correction_arcmin(mid, hp, MoonLimb::Upper) - base
                            + UPPER_OFFSET_ARCMIN,
                    )
                })
                .collect();
            MoonColumn {
                from_deg,
                upper,
                lower_alt_deg: mid,
                lower_limb,
                upper_limb,
            }
        })
        .collect();
    MoonTable {
        hp0_arcmin: HP0_ARCMIN,
        hp_rows: hps,
        columns,
        how_to_use: "Correct the sextant altitude for index error and dip to get Ha. Take the \
                     first correction from the upper part, in the column of Ha's degrees, on \
                     the row of its minutes (every 10′; interpolate if you like). Take the \
                     second from the lower part, in the same column, on the row of the HP the \
                     daily page gives for the hour (interpolating between rows), under L for \
                     the lower limb or U for the upper. Add both to Ha; for the upper limb \
                     also subtract 30′."
            .to_string(),
        notes: vec![
            "Computed with this project's chain (CONVENTIONS 5): Bennett's refraction, the \
             Moon's semidiameter asin(0.2725076 sin HP) augmented for altitude, and the \
             parallax asin(sin HP cos h). The printed Nautical Almanac's refraction differs \
             slightly, so its upper part can differ from this one by 0.1′."
                .to_string(),
            "Upper part: the lower-limb correction at HP 57.7′, less 5′. Lower part: the \
             change for the actual HP at the column's middle altitude, plus 5′ (L) or 35′ (U)."
                .to_string(),
            BANNER.to_string(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parts_add_up_to_the_chain() {
        let t = moon_table();
        assert_eq!(t.columns.len(), 18);
        assert_eq!(t.hp_rows.len(), 26);
        assert!((t.hp_rows[25] - 61.5).abs() < 1e-9);
        // HP 57.7' falls between the rows 57.6' and 57.9', so their L entries bracket the
        // 5' the lower part adds at the mean parallax.
        for c in &t.columns {
            let (a, b) = (&c.lower_limb[12], &c.lower_limb[13]);
            let (a, b): (f64, f64) = (a.printed.parse().unwrap(), b.printed.parse().unwrap());
            assert!(a <= 5.0 && b >= 5.0, "{} {a} {b}", c.from_deg);
        }
        // Two parts against the exact chain at the rows: within 0.25' everywhere.
        let mut worst: f64 = 0.0;
        for c in &t.columns {
            for (r, up) in c.upper.iter().enumerate() {
                let ha = f64::from(c.from_deg) + r as f64 / 6.0;
                for (k, &hp) in t.hp_rows.iter().enumerate() {
                    let up_p: f64 = up.printed.parse().unwrap();
                    let lo_p: f64 = c.lower_limb[k].printed.parse().unwrap();
                    let exact = moon_correction_arcmin(ha, hp, MoonLimb::Lower);
                    worst = worst.max((up_p + lo_p - exact).abs());
                    let uu: f64 = c.upper_limb[k].printed.parse().unwrap();
                    let exact_u = moon_correction_arcmin(ha, hp, MoonLimb::Upper);
                    worst = worst.max((up_p + uu - 30.0 - exact_u).abs());
                }
            }
        }
        println!(
            "the Moon's two-part table against the exact chain at its rows: worst {worst:.3}'"
        );
        assert!(worst < 0.25, "two-part table off by {worst}'");
    }

    #[test]
    fn a_lower_limb_on_the_horizon_and_at_the_zenith_is_sensible() {
        // Ha 0: -R (34.5') + SD (15.7') + HP (57.7') = about 38.9'.
        let c0 = moon_correction_arcmin(0.0, 57.7, MoonLimb::Lower);
        assert!((c0 - 38.9).abs() < 0.15, "{c0}");
        // Upper limb: 2 SD' less.
        let u0 = moon_correction_arcmin(0.0, 57.7, MoonLimb::Upper);
        assert!(((c0 - u0) - 31.45).abs() < 0.1, "{}", c0 - u0);
        // Near the zenith the parallax vanishes: SD' (augmented) remains.
        let c89 = moon_correction_arcmin(89.8, 57.7, MoonLimb::Lower);
        assert!(c89 > 15.7 && c89 < 16.3, "{c89}");
    }
}
