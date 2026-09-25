//! Named lunar features: which are near the terminator tonight (the best relief), which
//! are lit, and where each appears on the disc.
//!
//! OWNER: moondetail agent (expansion programme P8). CONVENTIONS 13.12; wire format in
//! `docs/EXPLORER_API.md`, `moon_features`.
//!
//! The table (`data/lunar_features.tsv`, 150 rows) is built by `tools/moon/build.py`:
//! names, selenographic coordinates and diameters from the USGS/IAU Gazetteer of
//! Planetary Nomenclature (public domain; planetocentric, east-positive, the mean
//! Earth/polar axis frame of the LOLA control network), chosen, ranked and described by
//! this project (`tools/moon/picks.txt`). The six Apollo landing sites take the
//! coordinates of the approved feature at each landing point.
//!
//! Geometry, per feature, from [`crate::libration`]'s frame at the instant:
//!
//! - **Sun's altitude** over the feature's mean horizon: `90°` minus the angle from the
//!   sub-solar point, ignoring the Sun's 0.27° radius and the local slope. Negative on the
//!   night side. The terminator is where it is zero.
//! - **Near the terminator** (the best relief, long shadows): the feature faces the
//!   observer and the Sun stands between `−r` and `band + r` over it, `r` the feature's
//!   angular radius and `band` 10° by default, so a large feature counts while the
//!   terminator crosses any part of it.
//! - **On the disc**: the feature's centre projected as in [`crate::libration::DiscPoint`]
//!   (after libration and the position angle; `x`, `y` with the zenith up).

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_ephemeris::moon::MoonProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::topocentric::Site;

use crate::libration::{
    DiscPoint, MoonGeometry, Selenographic, angle_deg, apply_transpose, orientation_of,
};
use crate::sky::AlmanacError;

const FEATURES_TSV: &str = include_str!("../data/lunar_features.tsv");

/// The Moon's mean radius the gazetteer's diameters refer to (IAU; LOLA), km.
pub const MOON_MEAN_RADIUS_KM: f64 = 1737.4;

/// Default width of the band beyond the terminator that counts as "near", degrees of
/// the Sun's altitude (about 300 km on the ground).
pub const DEFAULT_TERMINATOR_BAND_DEG: f64 = 10.0;

/// Where the table comes from, one sentence (the `source` field of `moon_features`).
pub const SOURCE: &str = "Names, positions and sizes: USGS/IAU Gazetteer of Planetary \
     Nomenclature (U.S. Public Domain); selection, ranks and descriptions: SkyFix Lab.";

/// What kind of feature a name is, from the gazetteer's feature type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeatureKind {
    /// A dark lava plain ("sea").
    Mare,
    /// Oceanus Procellarum.
    Oceanus,
    /// A small plain ("lake").
    Lacus,
    /// A bay.
    Sinus,
    /// A marsh.
    Palus,
    /// A single mountain or dome.
    Mons,
    /// A mountain range.
    Montes,
    /// A scarp.
    Rupes,
    /// A rille (channel or trench).
    Rima,
    /// A valley.
    Vallis,
    /// A wrinkle ridge.
    Dorsum,
    /// A cape.
    Promontorium,
    /// A bright or dark marking with no relief.
    Albedo,
    Crater,
    /// An Apollo landing site.
    LandingSite,
}

impl FeatureKind {
    fn parse(s: &str) -> Option<FeatureKind> {
        Some(match s {
            "mare" => FeatureKind::Mare,
            "oceanus" => FeatureKind::Oceanus,
            "lacus" => FeatureKind::Lacus,
            "sinus" => FeatureKind::Sinus,
            "palus" => FeatureKind::Palus,
            "mons" => FeatureKind::Mons,
            "montes" => FeatureKind::Montes,
            "rupes" => FeatureKind::Rupes,
            "rima" => FeatureKind::Rima,
            "vallis" => FeatureKind::Vallis,
            "dorsum" => FeatureKind::Dorsum,
            "promontorium" => FeatureKind::Promontorium,
            "albedo" => FeatureKind::Albedo,
            "crater" => FeatureKind::Crater,
            "landing_site" => FeatureKind::LandingSite,
            _ => return None,
        })
    }

    /// Features whose look depends on shadows: everything but an albedo marking.
    pub fn has_relief(self) -> bool {
        self != FeatureKind::Albedo
    }
}

/// One row of the table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LunarFeature {
    /// As the gazetteer spells it (`"Apollo 11"` for a landing site).
    pub name: String,
    pub kind: FeatureKind,
    /// Selenographic latitude and east longitude of the centre, degrees.
    pub lat_deg: f64,
    pub lon_deg: f64,
    /// Diameter (or length, for rilles, valleys and ranges), km; 0 for a landing site.
    pub diameter_km: f64,
    /// 1 = a showpiece, 2 = notable, 3 = more to find.
    pub rank: u8,
    /// One line in plain words.
    pub description: String,
}

impl LunarFeature {
    /// Angular radius on the Moon, degrees.
    pub fn radius_deg(&self) -> f64 {
        (self.diameter_km / 2.0 / MOON_MEAN_RADIUS_KM).to_degrees()
    }

    pub fn selenographic(&self) -> Selenographic {
        Selenographic {
            lat_deg: self.lat_deg,
            lon_deg: self.lon_deg,
        }
    }
}

fn parse_table(text: &str) -> Result<Vec<LunarFeature>, String> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 7 {
            return Err(format!("lunar_features.tsv:{}: {} fields", n + 1, f.len()));
        }
        let num = |s: &str, what: &str| -> Result<f64, String> {
            s.parse::<f64>()
                .map_err(|e| format!("lunar_features.tsv:{}: {what}: {e}", n + 1))
        };
        let kind = FeatureKind::parse(f[1])
            .ok_or_else(|| format!("lunar_features.tsv:{}: kind {:?}", n + 1, f[1]))?;
        let rank = f[5]
            .parse::<u8>()
            .map_err(|e| format!("lunar_features.tsv:{}: rank: {e}", n + 1))?;
        out.push(LunarFeature {
            name: f[0].to_string(),
            kind,
            lat_deg: num(f[2], "lat")?,
            lon_deg: num(f[3], "lon")?,
            diameter_km: num(f[4], "diameter")?,
            rank,
            description: f[6].to_string(),
        });
    }
    Ok(out)
}

fn table() -> Result<&'static [LunarFeature], AlmanacError> {
    static TABLE: OnceLock<Result<Vec<LunarFeature>, String>> = OnceLock::new();
    match TABLE.get_or_init(|| parse_table(FEATURES_TSV)) {
        Ok(v) => Ok(v.as_slice()),
        Err(e) => Err(AlmanacError::invalid(format!(
            "the embedded lunar feature table is damaged: {e}"
        ))),
    }
}

/// The named features, in table order (maria, bays, ranges, rilles, craters, landing
/// sites).
pub fn lunar_features() -> Result<&'static [LunarFeature], AlmanacError> {
    table()
}

/// One feature at one instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureState {
    #[serde(flatten)]
    pub feature: LunarFeature,
    /// The Sun's altitude over the feature's mean horizon, degrees (negative: night).
    pub sun_altitude_deg: f64,
    /// The Sun is up there.
    pub lit: bool,
    /// It is lunar morning there (the Sun climbing; the feature is near the sunrise
    /// terminator when the Sun is low), false in the afternoon.
    pub morning: bool,
    /// The terminator crosses the feature or lies within the band beyond its edge, and
    /// the feature faces the observer: long shadows, the best relief.
    pub near_terminator: bool,
    /// The feature's centre faces the observer.
    pub visible: bool,
    /// Angle from the centre of the disc as the observer sees it: 0 at the centre, 90 at
    /// the limb (foreshortened near it), over 90 on the far side, degrees.
    pub angle_from_disc_centre_deg: f64,
    /// Where it appears on the disc (disc radii; `x`, `y` with the zenith up).
    pub disc: DiscPoint,
}

/// The features at one instant. Wire shape: `docs/EXPLORER_API.md`, `moon_features`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoonFeatures {
    pub jd_utc: f64,
    pub utc: String,
    pub topocentric: bool,
    pub colongitude_deg: f64,
    pub sub_solar: Selenographic,
    pub sub_observer: Selenographic,
    pub axis_position_angle_deg: f64,
    pub parallactic_angle_deg: Option<f64>,
    pub illuminated_fraction: f64,
    pub waxing: bool,
    /// The band used for `near_terminator`, degrees.
    pub terminator_band_deg: f64,
    /// Names of the features near the terminator that face the observer and have relief,
    /// best first: by rank, then the lowest Sun (the longest shadows) first.
    pub tonight: Vec<String>,
    /// Every feature, in table order.
    pub features: Vec<FeatureState>,
    pub source: String,
}

/// The named features at `jd_utc` seen from `site` (or the Earth's centre), with the
/// default terminator band.
pub fn moon_features(
    moon: &MoonProvider,
    sun: &SunProvider,
    site: Option<&Site>,
    jd_utc: f64,
) -> Result<MoonFeatures, AlmanacError> {
    moon_features_with_band(moon, sun, site, jd_utc, DEFAULT_TERMINATOR_BAND_DEG)
}

/// [`moon_features`] with a chosen terminator band (0 to 90 degrees).
pub fn moon_features_with_band(
    moon: &MoonProvider,
    sun: &SunProvider,
    site: Option<&Site>,
    jd_utc: f64,
    band_deg: f64,
) -> Result<MoonFeatures, AlmanacError> {
    if !(0.0..=90.0).contains(&band_deg) {
        return Err(AlmanacError::invalid(format!(
            "terminator band {band_deg} deg is outside 0..90"
        )));
    }
    let rows = table()?;
    let g = MoonGeometry::new(moon, sun, site, jd_utc)?;
    let o = orientation_of(&g);
    let frame = &g.frame;
    let s_sun = o.sub_solar.unit();
    let s_obs = o.sub_observer.unit();
    let l0 = o.sub_solar.lon_deg;
    let mut features = Vec::with_capacity(rows.len());
    for f in rows {
        let sel = f.selenographic();
        let v = sel.unit();
        let sun_alt = 90.0 - angle_deg(v, s_sun);
        let r = f.radius_deg();
        // The lunar hour angle of the Sun: the feature's longitude minus the sub-solar
        // longitude; negative before local noon.
        let h = skyfix_core::units::norm_180(f.lon_deg - l0);
        let disc = g.disc(apply_transpose(&frame.matrix, v));
        let near = disc.visible && sun_alt > -r && sun_alt < band_deg + r;
        features.push(FeatureState {
            feature: f.clone(),
            sun_altitude_deg: sun_alt,
            lit: sun_alt > 0.0,
            morning: h < 0.0,
            near_terminator: near,
            visible: disc.visible,
            angle_from_disc_centre_deg: angle_deg(v, s_obs),
            disc,
        });
    }
    let mut tonight: Vec<&FeatureState> = features
        .iter()
        .filter(|s| s.near_terminator && s.feature.kind.has_relief())
        .collect();
    tonight.sort_by(|a, b| {
        a.feature
            .rank
            .cmp(&b.feature.rank)
            .then(a.sun_altitude_deg.total_cmp(&b.sun_altitude_deg))
    });
    Ok(MoonFeatures {
        jd_utc,
        utc: format_utc(jd_utc),
        topocentric: o.topocentric,
        colongitude_deg: o.colongitude_deg,
        sub_solar: o.sub_solar,
        sub_observer: o.sub_observer,
        axis_position_angle_deg: o.axis_position_angle_deg,
        parallactic_angle_deg: o.parallactic_angle_deg,
        illuminated_fraction: o.illuminated_fraction,
        waxing: o.waxing,
        terminator_band_deg: band_deg,
        tonight: tonight.iter().map(|s| s.feature.name.clone()).collect(),
        features,
        source: SOURCE.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn the_table_is_whole_and_sane() {
        let t = lunar_features().unwrap();
        assert_eq!(t.len(), 150);
        let mut names: Vec<&str> = t.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 150, "names are unique");
        for f in t {
            assert!((-90.0..=90.0).contains(&f.lat_deg), "{}", f.name);
            assert!((-180.0..=180.0).contains(&f.lon_deg), "{}", f.name);
            assert!((1..=3).contains(&f.rank), "{}", f.name);
            assert!(!f.description.is_empty() && f.description.len() <= 80);
            if f.kind == FeatureKind::LandingSite {
                assert_eq!(f.diameter_km, 0.0);
                assert!(f.name.starts_with("Apollo "));
            } else {
                assert!(f.diameter_km > 0.0, "{}", f.name);
            }
        }
        let find = |n: &str| t.iter().find(|f| f.name == n).unwrap();
        // A few well-known places, to the gazetteer's 0.01 degree.
        let tycho = find("Tycho");
        assert!((tycho.lat_deg + 43.30).abs() < 0.02 && (tycho.lon_deg + 11.22).abs() < 0.02);
        let a11 = find("Apollo 11");
        assert!((a11.lat_deg - 0.67).abs() < 0.02 && (a11.lon_deg - 23.47).abs() < 0.02);
        assert_eq!(find("Mare Tranquillitatis").kind, FeatureKind::Mare);
        assert_eq!(find("Montes Apenninus").kind, FeatureKind::Montes);
        assert_eq!(find("Mons Pico").kind, FeatureKind::Mons);
        assert_eq!(find("Reiner Gamma").kind, FeatureKind::Albedo);
        assert_eq!(
            t.iter()
                .filter(|f| f.kind == FeatureKind::LandingSite)
                .count(),
            6
        );
    }

    #[test]
    fn full_moon_lights_the_near_side_and_new_moon_darkens_it() {
        let (moon, sun) = (MoonProvider::new(), SunProvider::new());
        // Full Moon 2026-01-03 10:03 UTC; new Moon 2026-01-18 19:52 UTC.
        let full = moon_features(&moon, &sun, None, civil_to_jd(2026, 1, 3) + 10.0 / 24.0).unwrap();
        let new = moon_features(&moon, &sun, None, civil_to_jd(2026, 1, 18) + 20.0 / 24.0).unwrap();
        let near_centre = |s: &FeatureState| s.angle_from_disc_centre_deg < 60.0;
        assert!(
            full.features
                .iter()
                .filter(|s| near_centre(s))
                .all(|s| s.lit)
        );
        assert!(
            new.features
                .iter()
                .filter(|s| near_centre(s))
                .all(|s| !s.lit)
        );
        assert!(full.illuminated_fraction > 0.99 && new.illuminated_fraction < 0.01);
    }

    #[test]
    fn first_quarter_puts_the_central_features_on_the_terminator() {
        // First quarter 2026-01-26 04:47 UTC: the terminator runs close to the central
        // meridian, lit to the east (positive longitudes).
        let (moon, sun) = (MoonProvider::new(), SunProvider::new());
        let site = Site::new(39.95, -75.17);
        let r = moon_features(
            &moon,
            &sun,
            Some(&site),
            civil_to_jd(2026, 1, 26) + 4.8 / 24.0,
        )
        .unwrap();
        assert!(
            r.colongitude_deg < 6.0 || r.colongitude_deg > 354.0,
            "{}",
            r.colongitude_deg
        );
        let get = |n: &str| r.features.iter().find(|s| s.feature.name == n).unwrap();
        let tq = get("Mare Tranquillitatis");
        assert!(tq.lit && !tq.near_terminator, "{tq:?}");
        assert!(!get("Mare Humorum").lit);
        assert!(get("Sinus Medii").near_terminator);
        assert!(
            r.tonight
                .iter()
                .any(|n| n == "Sinus Medii" || n == "Ptolemaeus")
        );
        // Lunar morning at the terminator after new Moon.
        assert!(get("Sinus Medii").morning);
        // The ranking puts showpieces first.
        let ranks: Vec<u8> = r.tonight.iter().map(|n| get(n).feature.rank).collect();
        assert!(ranks.windows(2).all(|w| w[0] <= w[1]), "{ranks:?}");
    }
}
