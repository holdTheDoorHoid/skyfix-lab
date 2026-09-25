//! Atmospheric extinction, sky brightness and the naked-eye limiting magnitude.
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6): these models feed the Sky
//! view's magnitude cut and the "tonight" ranking, never a sight or an accuracy claim.
//! Every number here is a *model estimate*, and the wire says so.
//!
//! The models, each a published formula:
//!
//! - **Air mass** `X(h)`, Pickering (2002, *DIO* 12, 3), for the apparent altitude `h`
//!   in degrees: `X = 1 / sin(h + 244 / (165 + 47 h^1.1))`. Good to the horizon
//!   (38.7 at 0 degrees).
//! - **Extinction** `k X` magnitudes, `k` the extinction coefficient in V (0.2 on a
//!   clear mountain, 0.25 typical, 0.4 hazy; the caller chooses, 0.2 to 0.4). A star
//!   at altitude `h` looks `k (X(h) - 1)` fainter than at the zenith.
//! - **Limiting magnitude from a Bortle class**: the middle of Bortle's (2001) naked-eye
//!   limiting magnitude range for the class (class 1: 7.6-8.0 gives 7.8; class 9: 4.0).
//! - **Sky brightness and the limiting magnitude**, Schaefer's (1990) relation as
//!   commonly used with sky-quality meters:
//!   `NELM = 7.93 - 5 log10(10^(4.316 - B/5) + 1)`, `B` in V mag/arcsec^2, and its
//!   inverse. The natural night sky is never darker than about 22.0 mag/arcsec^2, so
//!   `B` is capped there.
//! - **Moonlight**, Krisciunas & Schaefer (1991, PASP 103, 1033): the sky brightness the
//!   Moon adds at a point of the sky, from the Moon's phase angle, the two zenith
//!   distances, their separation and `k`; with their dark-sky brightening toward the
//!   horizon. The brightening in magnitudes, and the limiting magnitude it leaves, follow.
//!
//! The limiting magnitude at altitude `h` is `NELM - k (X(h) - 1)`: extinction only; the
//! sky's own brightening toward the horizon (light domes, airglow) is not modelled.

use serde::{Deserialize, Serialize};

/// Extinction coefficient in V, magnitudes per air mass, when the caller gives none.
pub const K_DEFAULT: f64 = 0.25;
/// The range the caller may choose from.
pub const K_MIN: f64 = 0.2;
pub const K_MAX: f64 = 0.4;
/// Bortle class used when the caller gives neither a class nor a limiting magnitude:
/// a suburban sky.
pub const BORTLE_DEFAULT: u8 = 5;
/// Darkest natural sky, V mag/arcsec^2.
pub const DARKEST_SKY_MPSAS: f64 = 22.0;

/// Naked-eye limiting magnitude at the zenith for Bortle classes 1..=9: the middle of
/// each class's range in Bortle (2001).
const BORTLE_NELM: [f64; 9] = [7.8, 7.3, 6.8, 6.3, 5.8, 5.3, 4.8, 4.3, 4.0];

/// Pickering's (2002) air mass for an apparent altitude in degrees; `None` below the
/// horizon.
pub fn airmass(apparent_alt_deg: f64) -> Option<f64> {
    if !(0.0..=90.0 + 1e-9).contains(&apparent_alt_deg) {
        return None;
    }
    let h = apparent_alt_deg;
    let arg = h + 244.0 / (165.0 + 47.0 * h.powf(1.1));
    Some(1.0 / arg.to_radians().sin())
}

/// Total extinction, magnitudes, at an apparent altitude; `None` below the horizon.
pub fn extinction_mag(apparent_alt_deg: f64, k: f64) -> Option<f64> {
    airmass(apparent_alt_deg).map(|x| k * x)
}

/// Naked-eye limiting magnitude at the zenith for a Bortle class (1..=9).
pub fn bortle_nelm(class: u8) -> Option<f64> {
    BORTLE_NELM.get(usize::from(class).checked_sub(1)?).copied()
}

/// Schaefer's relation: naked-eye limiting magnitude for a sky of `mpsas` V
/// mag/arcsec^2.
pub fn nelm_from_sky(mpsas: f64) -> f64 {
    7.93 - 5.0 * (10f64.powf(4.316 - mpsas / 5.0) + 1.0).log10()
}

/// Inverse of [`nelm_from_sky`], capped at [`DARKEST_SKY_MPSAS`] (the relation runs off
/// to infinity as the limit approaches 7.93).
pub fn sky_from_nelm(nelm: f64) -> f64 {
    let t = 10f64.powf(1.586 - nelm / 5.0) - 1.0;
    if t <= 0.0 {
        return DARKEST_SKY_MPSAS;
    }
    (21.58 - 5.0 * t.log10()).min(DARKEST_SKY_MPSAS)
}

/// Surface brightness, V mag/arcsec^2, to nanolamberts (Krisciunas & Schaefer eq. 1).
pub fn mpsas_to_nanolamberts(mpsas: f64) -> f64 {
    34.08 * (20.7233 - 0.92104 * mpsas).exp()
}

/// Nanolamberts to V mag/arcsec^2.
pub fn nanolamberts_to_mpsas(nl: f64) -> f64 {
    (20.7233 - (nl / 34.08).ln()) / 0.92104
}

/// Krisciunas & Schaefer's air mass for a zenith distance (their eq. 3), used inside
/// their model only.
fn ks_airmass(zenith_distance_deg: f64) -> f64 {
    let s = zenith_distance_deg.to_radians().sin();
    (1.0 - 0.96 * s * s).max(1e-6).powf(-0.5)
}

/// What the Moon does to one point of the sky.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Moonlight {
    /// Sky brightness the Moon adds, nanolamberts.
    pub added_nanolamberts: f64,
    /// Dark-sky brightness at that point, nanolamberts (zenith value brightened toward
    /// the horizon).
    pub dark_nanolamberts: f64,
    /// How much brighter the sky is there, magnitudes (0 with the Moon down).
    pub brightening_mag: f64,
}

/// Krisciunas & Schaefer (1991): the Moon's contribution to the sky brightness at a
/// target.
///
/// `phase_angle_deg` is the Sun-Moon-Earth angle (0 full, 180 new),
/// `moon_alt_deg` / `target_alt_deg` apparent altitudes, `separation_deg` the
/// Moon-target angle, `k` the extinction coefficient and `dark_zenith_mpsas` the dark
/// sky at the zenith. With the Moon below the horizon it adds nothing.
pub fn moonlight(
    phase_angle_deg: f64,
    moon_alt_deg: f64,
    target_alt_deg: f64,
    separation_deg: f64,
    k: f64,
    dark_zenith_mpsas: f64,
) -> Moonlight {
    let z = (90.0 - target_alt_deg).clamp(0.0, 90.0);
    let x = ks_airmass(z);
    let b_zen = mpsas_to_nanolamberts(dark_zenith_mpsas);
    let dark = b_zen * 10f64.powf(-0.4 * k * (x - 1.0)) * x;
    if moon_alt_deg <= 0.0 || target_alt_deg <= 0.0 {
        return Moonlight {
            added_nanolamberts: 0.0,
            dark_nanolamberts: dark,
            brightening_mag: 0.0,
        };
    }
    let a = phase_angle_deg.abs().min(180.0);
    let i_star = 10f64.powf(-0.4 * (3.84 + 0.026 * a + 4.0e-9 * a.powi(4)));
    let rho = separation_deg.clamp(0.0, 180.0);
    let c = rho.to_radians().cos();
    let f = 10f64.powf(5.36) * (1.06 + c * c) + 10f64.powf(6.15 - rho / 40.0);
    let xm = ks_airmass(90.0 - moon_alt_deg.clamp(0.0, 90.0));
    let added = f * i_star * 10f64.powf(-0.4 * k * xm) * (1.0 - 10f64.powf(-0.4 * k * x));
    Moonlight {
        added_nanolamberts: added,
        dark_nanolamberts: dark,
        brightening_mag: 2.5 * ((added + dark) / dark).log10(),
    }
}

/// The observer's sky, as the caller describes it (`conditions_json`). Everything is
/// optional: `nelm` wins over `bortle`, and with neither the sky is Bortle 5.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SkyConditions {
    /// Bortle class, 1 (darkest) to 9 (inner city).
    pub bortle: Option<u8>,
    /// Naked-eye limiting magnitude at the zenith, 1 to 8.
    pub nelm: Option<f64>,
    /// Extinction coefficient in V, 0.2 to 0.4 magnitudes per air mass.
    pub k: Option<f64>,
}

/// The conditions every calculation uses, with where they came from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Conditions {
    /// The class given, or the default's.
    pub bortle: Option<u8>,
    /// Naked-eye limiting magnitude at the zenith (dark sky, no Moon).
    pub nelm: f64,
    pub k: f64,
    /// Dark-sky brightness at the zenith, V mag/arcsec^2 (Schaefer's relation, capped at
    /// 22.0).
    pub sky_brightness_mpsas: f64,
    /// `"nelm"`, `"bortle"` or `"default"`.
    pub source: &'static str,
}

impl SkyConditions {
    /// Check and resolve. Out-of-range values are an error, never clamped silently.
    pub fn resolve(&self) -> Result<Conditions, String> {
        let k = self.k.unwrap_or(K_DEFAULT);
        if !(k.is_finite() && (K_MIN..=K_MAX).contains(&k)) {
            return Err(format!(
                "k must be between {K_MIN} and {K_MAX} magnitudes per air mass, got {k}"
            ));
        }
        let (bortle, nelm, source) = match (self.nelm, self.bortle) {
            (Some(n), _) => {
                if !(n.is_finite() && (1.0..=8.0).contains(&n)) {
                    return Err(format!("nelm must be between 1 and 8, got {n}"));
                }
                (self.bortle, n, "nelm")
            }
            (None, Some(b)) => {
                let n = bortle_nelm(b)
                    .ok_or_else(|| format!("bortle must be a class from 1 to 9, got {b}"))?;
                (Some(b), n, "bortle")
            }
            (None, None) => (
                Some(BORTLE_DEFAULT),
                BORTLE_NELM[usize::from(BORTLE_DEFAULT) - 1],
                "default",
            ),
        };
        if let Some(b) = bortle {
            if !(1..=9).contains(&b) {
                return Err(format!("bortle must be a class from 1 to 9, got {b}"));
            }
        }
        Ok(Conditions {
            bortle,
            nelm,
            k,
            sky_brightness_mpsas: sky_from_nelm(nelm),
            source,
        })
    }
}

impl Conditions {
    /// Limiting magnitude at an apparent altitude, extinction only; `None` below the
    /// horizon.
    pub fn limiting_mag_at(&self, apparent_alt_deg: f64) -> Option<f64> {
        airmass(apparent_alt_deg).map(|x| self.nelm - self.k * (x - 1.0))
    }

    /// Limiting magnitude at the zenith with the sky brightened by `brightening_mag`
    /// (moonlight): the change Schaefer's relation gives, applied to this observer's
    /// own limit.
    pub fn nelm_brightened(&self, brightening_mag: f64) -> f64 {
        let dark = self.sky_brightness_mpsas;
        self.nelm + nelm_from_sky(dark - brightening_mag.max(0.0)) - nelm_from_sky(dark)
    }
}

/// `extinction(conditions_json)`: the model and a table every degree of apparent
/// altitude from 0 to 90 for the Sky view's magnitude cut.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExtinctionTable {
    pub conditions: Conditions,
    pub alt_deg: Vec<f64>,
    pub airmass: Vec<f64>,
    /// `k X`, magnitudes.
    pub extinction_mag: Vec<f64>,
    /// `nelm - k (X - 1)`.
    pub limiting_mag: Vec<f64>,
    /// One sentence naming the models.
    pub model: &'static str,
}

/// The sentence every extinction result carries.
pub const MODEL: &str = "Estimate. Air mass from Pickering (2002); extinction k times the \
     air mass; the limiting magnitude falls by k (X - 1) away from the zenith; Bortle \
     classes use the middle of Bortle's (2001) limiting-magnitude range; sky brightness \
     from Schaefer's (1990) relation; moonlight from Krisciunas & Schaefer (1991).";

pub fn table(c: &Conditions) -> ExtinctionTable {
    let mut t = ExtinctionTable {
        conditions: *c,
        alt_deg: Vec::with_capacity(91),
        airmass: Vec::with_capacity(91),
        extinction_mag: Vec::with_capacity(91),
        limiting_mag: Vec::with_capacity(91),
        model: MODEL,
    };
    for a in 0..=90 {
        let h = f64::from(a);
        let x = airmass(h).unwrap_or(f64::NAN);
        t.alt_deg.push(h);
        t.airmass.push(x);
        t.extinction_mag.push(c.k * x);
        t.limiting_mag.push(c.nelm - c.k * (x - 1.0));
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pickering_air_mass_is_one_at_the_zenith_and_about_38_at_the_horizon() {
        assert!((airmass(90.0).unwrap() - 1.0).abs() < 1e-4);
        assert!((airmass(30.0).unwrap() - 1.995).abs() < 0.01);
        assert!((airmass(0.0).unwrap() - 38.7).abs() < 0.2);
        assert!(airmass(-0.5).is_none());
        // Monotonic.
        let mut last = f64::INFINITY;
        for a in 0..=90 {
            let x = airmass(f64::from(a)).unwrap();
            assert!(x < last);
            last = x;
        }
    }

    #[test]
    fn schaefers_relation_round_trips_and_is_capped_at_the_natural_sky() {
        for b in [17.0, 18.5, 19.5, 20.5, 21.5, 21.9] {
            let n = nelm_from_sky(b);
            assert!((sky_from_nelm(n) - b).abs() < 1e-9, "{b}");
        }
        // The formula's values (hand evaluation): 21.0 mag/arcsec^2 gives 6.12, 19.0
        // gives 4.77.
        assert!((nelm_from_sky(21.0) - 6.12).abs() < 0.01);
        assert!((nelm_from_sky(19.0) - 4.77).abs() < 0.01);
        assert_eq!(sky_from_nelm(7.8), DARKEST_SKY_MPSAS);
        assert_eq!(sky_from_nelm(8.0), DARKEST_SKY_MPSAS);
    }

    #[test]
    fn bortle_classes_follow_bortles_table_and_bad_input_is_refused() {
        assert_eq!(bortle_nelm(1), Some(7.8));
        assert_eq!(bortle_nelm(5), Some(5.8));
        assert_eq!(bortle_nelm(9), Some(4.0));
        assert_eq!(bortle_nelm(0), None);
        assert_eq!(bortle_nelm(10), None);
        let d = SkyConditions::default().resolve().unwrap();
        assert_eq!(
            (d.bortle, d.nelm, d.k, d.source),
            (Some(5), 5.8, 0.25, "default")
        );
        let n = SkyConditions {
            nelm: Some(6.4),
            bortle: Some(8),
            k: Some(0.3),
        }
        .resolve()
        .unwrap();
        assert_eq!((n.nelm, n.k, n.source), (6.4, 0.3, "nelm"));
        for bad in [
            SkyConditions {
                k: Some(0.5),
                ..Default::default()
            },
            SkyConditions {
                bortle: Some(0),
                ..Default::default()
            },
            SkyConditions {
                nelm: Some(9.0),
                ..Default::default()
            },
            SkyConditions {
                k: Some(f64::NAN),
                ..Default::default()
            },
        ] {
            assert!(bad.resolve().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn moonlight_matches_a_hand_evaluation_of_the_published_equations() {
        // A full Moon 60 degrees up, the target 30 degrees from it at 45 degrees,
        // k = 0.172, a dark zenith of 21.587 V mag/arcsec^2 (79.0 nL). By hand from
        // K&S's equations 1-3 and 15-21: f(30) = 665 836, I* = 0.029 11, the Moon's
        // light through 1.147 air masses 0.8338, the target's column 0.1973, so the Moon
        // adds 3 189 nL to a dark sky of 103.0 nL there: 3.76 magnitudes brighter.
        let m = moonlight(0.0, 60.0, 45.0, 30.0, 0.172, 21.587);
        assert!((m.added_nanolamberts - 3189.0).abs() < 3.0, "{m:?}");
        assert!((m.dark_nanolamberts - 103.0).abs() < 0.3, "{m:?}");
        assert!((m.brightening_mag - 3.76).abs() < 0.01, "{m:?}");
        // A new Moon (phase angle 180) adds almost nothing; a Moon below the horizon
        // adds nothing at all.
        assert!(moonlight(179.0, 60.0, 45.0, 30.0, 0.2, 21.5).brightening_mag < 0.05);
        assert_eq!(
            moonlight(0.0, -1.0, 45.0, 30.0, 0.2, 21.5).brightening_mag,
            0.0
        );
        // Farther from the Moon, less light.
        let near = moonlight(40.0, 40.0, 40.0, 20.0, 0.25, 21.0).brightening_mag;
        let far = moonlight(40.0, 40.0, 40.0, 100.0, 0.25, 21.0).brightening_mag;
        assert!(near > far && far > 0.0, "{near} {far}");
        // Surface brightness units round-trip.
        assert!((nanolamberts_to_mpsas(mpsas_to_nanolamberts(20.3)) - 20.3).abs() < 1e-12);
    }

    #[test]
    fn moonlight_lowers_the_limiting_magnitude() {
        let c = SkyConditions::default().resolve().unwrap();
        assert!((c.nelm_brightened(0.0) - c.nelm).abs() < 1e-12);
        let lower = c.nelm_brightened(2.0);
        assert!(lower < c.nelm - 0.8 && lower > c.nelm - 2.5, "{lower}");
    }

    #[test]
    fn the_table_covers_every_degree() {
        let c = SkyConditions::default().resolve().unwrap();
        let t = table(&c);
        assert_eq!(t.alt_deg.len(), 91);
        assert!((t.limiting_mag[90] - c.nelm).abs() < 1e-3);
        assert!(t.limiting_mag[10] < t.limiting_mag[45]);
        assert!((t.extinction_mag[90] - c.k).abs() < 1e-3);
    }
}
