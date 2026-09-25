//! The station index: NOAA's tide-prediction stations, their harmonic constants, datums
//! and subordinate offsets, as the `tides-us` pack carries them (see [`crate::pack`]).

use crate::predict::{NodalMode, Predictor, Term};
use crate::schureman::CONSTITUENTS;

/// A tidal (or geodetic) datum heights can be given on. Harmonic predictions are about
/// mean sea level; the others are offsets from it published by NOAA for the station's
/// tidal datum epoch (1983-2001 at most stations).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Datum {
    /// Mean higher high water.
    Mhhw,
    /// Mean high water.
    Mhw,
    /// Mean tide level (the mean of MHW and MLW).
    Mtl,
    /// Mean sea level.
    Msl,
    /// Mean low water.
    Mlw,
    /// Mean lower low water: the chart datum of U.S. charts and NOAA's default.
    Mllw,
    /// Lowest astronomical tide.
    Lat,
    /// Highest astronomical tide.
    Hat,
    /// North American Vertical Datum of 1988 (geodetic).
    Navd88,
}

/// The datums a pack stores relative to MSL, in the pack's order.
pub const STORED_DATUMS: [Datum; 8] = [
    Datum::Mhhw,
    Datum::Mhw,
    Datum::Mtl,
    Datum::Mlw,
    Datum::Mllw,
    Datum::Lat,
    Datum::Hat,
    Datum::Navd88,
];

/// Every datum in the order the station info lists them (highest tidal datum first).
pub const ALL_DATUMS: [Datum; 9] = [
    Datum::Hat,
    Datum::Mhhw,
    Datum::Mhw,
    Datum::Mtl,
    Datum::Msl,
    Datum::Mlw,
    Datum::Mllw,
    Datum::Lat,
    Datum::Navd88,
];

impl Datum {
    pub fn name(self) -> &'static str {
        match self {
            Datum::Mhhw => "MHHW",
            Datum::Mhw => "MHW",
            Datum::Mtl => "MTL",
            Datum::Msl => "MSL",
            Datum::Mlw => "MLW",
            Datum::Mllw => "MLLW",
            Datum::Lat => "LAT",
            Datum::Hat => "HAT",
            Datum::Navd88 => "NAVD88",
        }
    }

    /// Case-insensitive, after trimming; `NAVD` is accepted for `NAVD88` as NOAA does.
    pub fn parse(s: &str) -> Option<Datum> {
        let t = s.trim();
        if t.eq_ignore_ascii_case("NAVD") {
            return Some(Datum::Navd88);
        }
        ALL_DATUMS
            .iter()
            .copied()
            .find(|d| d.name().eq_ignore_ascii_case(t))
    }
}

/// A harmonic station's datums, millimetres relative to its mean sea level, in the
/// order of [`STORED_DATUMS`]; `None` where NOAA publishes none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Datums {
    pub mm_rel_msl: [Option<i16>; 8],
}

impl Datums {
    /// `datum − MSL` in metres, or `None` when not published. MSL itself is 0 when the
    /// station has any datum at all; a station without datums has only MSL (its
    /// harmonic mean), also 0.
    pub fn offset_m(&self, d: Datum) -> Option<f64> {
        if d == Datum::Msl {
            return Some(0.0);
        }
        let k = STORED_DATUMS.iter().position(|x| *x == d)?;
        self.mm_rel_msl[k].map(|mm| f64::from(mm) / 1000.0)
    }

    pub fn available(&self) -> Vec<Datum> {
        ALL_DATUMS
            .iter()
            .copied()
            .filter(|d| self.offset_m(*d).is_some())
            .collect()
    }

    pub fn any(&self) -> bool {
        self.mm_rel_msl.iter().any(Option::is_some)
    }
}

/// The character of the tide by the form number `F = (K1 + O1)/(M2 + S2)` of the
/// amplitudes (Defant's classification, as in Bowditch and NOAA's teaching material):
/// under 0.25 semidiurnal, 0.25 to 1.5 mixed mainly semidiurnal, 1.5 to 3 mixed mainly
/// diurnal, 3 and over diurnal. NOAA's own `tideType` field is sparse (it calls Boston
/// "Mixed"), so the pack does not carry it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TideType {
    Semidiurnal,
    MixedSemidiurnal,
    MixedDiurnal,
    Diurnal,
}

impl TideType {
    pub fn from_form_number(f: f64) -> TideType {
        if f < 0.25 {
            TideType::Semidiurnal
        } else if f < 1.5 {
            TideType::MixedSemidiurnal
        } else if f < 3.0 {
            TideType::MixedDiurnal
        } else {
            TideType::Diurnal
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TideType::Semidiurnal => "semidiurnal",
            TideType::MixedSemidiurnal => "mixed_semidiurnal",
            TideType::MixedDiurnal => "mixed_diurnal",
            TideType::Diurnal => "diurnal",
        }
    }
}

/// How a subordinate station's heights follow its reference station's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HeightAdjust {
    /// Multiply the reference station's height above its MLLW.
    Ratio { high: f64, low: f64 },
    /// Add metres to the reference station's height above its MLLW.
    Additive { high_m: f64, low_m: f64 },
}

/// A harmonic ("R") station.
#[derive(Debug, Clone, PartialEq)]
pub struct Harmonic {
    pub datums: Datums,
    /// (index into [`CONSTITUENTS`], amplitude m, Greenwich phase degrees), the
    /// constituents NOAA publishes with a non-zero amplitude, in index order.
    pub terms: Vec<(u8, f64, f64)>,
}

impl Harmonic {
    fn amplitude(&self, name: &str) -> f64 {
        let k = crate::schureman::index_of(name).expect("a standard constituent");
        self.terms
            .iter()
            .find(|t| usize::from(t.0) == k)
            .map_or(0.0, |t| t.1)
    }

    /// `F = (K1 + O1)/(M2 + S2)`; `None` without semidiurnal or diurnal constants.
    pub fn form_number(&self) -> Option<f64> {
        let semi = self.amplitude("M2") + self.amplitude("S2");
        let diurnal = self.amplitude("K1") + self.amplitude("O1");
        if semi > 0.0 {
            Some(diurnal / semi)
        } else if diurnal > 0.0 {
            Some(f64::INFINITY)
        } else {
            None
        }
    }

    pub fn tide_type(&self) -> Option<TideType> {
        self.form_number().map(TideType::from_form_number)
    }

    pub fn predictor(&self, mode: NodalMode) -> Predictor {
        Predictor::new(
            self.terms
                .iter()
                .map(|&(k, amplitude_m, phase_deg)| Term {
                    constituent: &CONSTITUENTS[usize::from(k)],
                    amplitude_m,
                    phase_deg,
                })
                .collect(),
            mode,
        )
    }
}

/// A subordinate ("S") station: NOAA predicts only its high and low waters, from its
/// reference station's with time and height offsets.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Subordinate {
    /// Index of the reference station in [`TideDb::stations`].
    pub reference: u32,
    pub time_high_min: i16,
    pub time_low_min: i16,
    pub heights: HeightAdjust,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StationKind {
    Harmonic(Harmonic),
    Subordinate(Subordinate),
}

/// Flag bits of a station record. (NOAA's list has no country field and leaves the
/// state empty for many U.S. stations too, so no "outside the U.S." flag is derived.)
pub mod flags {
    /// NOAA's own predictions for this station differ from what its published constants
    /// give by more than the validation tolerance (the pipeline's sweep found it).
    pub const NOAA_DIFFERS: u8 = 1;
    /// Harmonic station without published tidal datums: heights about MSL only.
    pub const NO_DATUMS: u8 = 2;
    /// Harmonic station for which NOAA publishes no harmonic constants: no prediction.
    pub const NO_CONSTANTS: u8 = 4;
    /// Subordinate station whose reference station has no constants or no MLLW datum:
    /// nothing can be predicted.
    pub const REFERENCE_UNUSABLE: u8 = 8;
    /// NOAA marks the station "non-navigational".
    pub const NON_NAVIGATIONAL: u8 = 16;
}

#[derive(Debug, Clone, PartialEq)]
pub struct Station {
    /// NOAA's station id (`9414290`, `TEC4623`).
    pub id: String,
    pub name: String,
    /// Two-letter U.S. state or territory code; empty for a foreign port.
    pub state: String,
    pub lat_deg: f64,
    /// East positive.
    pub lon_deg: f64,
    pub flags: u8,
    pub kind: StationKind,
}

impl Station {
    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }

    pub fn is_harmonic(&self) -> bool {
        matches!(self.kind, StationKind::Harmonic(_))
    }
}

/// Every station of a loaded pack.
#[derive(Debug, Clone, PartialEq)]
pub struct TideDb {
    /// The pack's data version (NOAA retrieval date, `YYYY-MM-DD`).
    pub version: String,
    pub stations: Vec<Station>,
    /// Indices of `stations` sorted by id.
    by_id: Vec<u32>,
}

impl TideDb {
    pub fn new(version: String, stations: Vec<Station>) -> TideDb {
        let mut by_id: Vec<u32> = (0..stations.len() as u32).collect();
        by_id.sort_by(|&a, &b| stations[a as usize].id.cmp(&stations[b as usize].id));
        TideDb {
            version,
            stations,
            by_id,
        }
    }

    /// The index of the station with this id (exact, then case-insensitive).
    pub fn index_of(&self, id: &str) -> Option<usize> {
        let id = id.trim();
        if let Ok(k) = self
            .by_id
            .binary_search_by(|&i| self.stations[i as usize].id.as_str().cmp(id))
        {
            return Some(self.by_id[k] as usize);
        }
        self.stations
            .iter()
            .position(|s| s.id.eq_ignore_ascii_case(id))
    }

    pub fn get(&self, id: &str) -> Option<&Station> {
        self.index_of(id).map(|k| &self.stations[k])
    }

    pub fn harmonic_count(&self) -> usize {
        self.stations.iter().filter(|s| s.is_harmonic()).count()
    }

    /// The `n` stations nearest to a place, nearest first: `(index, distance km,
    /// initial great-circle bearing from the place, degrees)`. Spherical Earth of mean
    /// radius 6371.0088 km (distances within 0.5 % of the ellipsoid's).
    pub fn nearest(&self, lat_deg: f64, lon_deg: f64, n: usize) -> Vec<(usize, f64, f64)> {
        let mut all: Vec<(usize, f64, f64)> = self
            .stations
            .iter()
            .enumerate()
            .map(|(k, s)| {
                let (d, b) = distance_bearing(lat_deg, lon_deg, s.lat_deg, s.lon_deg);
                (k, d, b)
            })
            .collect();
        all.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        all.truncate(n);
        all
    }
}

/// Mean Earth radius (IUGG), km.
pub const EARTH_RADIUS_KM: f64 = 6371.0088;

/// Great-circle distance (km, haversine) and initial bearing (degrees from true north,
/// `[0, 360)`) from point 1 to point 2.
pub fn distance_bearing(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> (f64, f64) {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dl = (lon2 - lon1).to_radians();
    let dp = p2 - p1;
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    let d = 2.0 * EARTH_RADIUS_KM * a.sqrt().min(1.0).asin();
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    let mut b = y.atan2(x).to_degrees().rem_euclid(360.0);
    if b >= 360.0 {
        b = 0.0;
    }
    (d, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datum_names_parse_back() {
        for d in ALL_DATUMS {
            assert_eq!(Datum::parse(d.name()), Some(d));
            assert_eq!(Datum::parse(&d.name().to_lowercase()), Some(d));
        }
        assert_eq!(Datum::parse(" navd "), Some(Datum::Navd88));
        assert_eq!(Datum::parse("STND"), None);
    }

    #[test]
    fn distances_and_bearings() {
        // One degree of latitude is 111.195 km on the mean sphere.
        let (d, b) = distance_bearing(0.0, 0.0, 1.0, 0.0);
        assert!((d - 111.195).abs() < 0.001, "{d}");
        assert!(b.abs() < 1e-9);
        let (_, b) = distance_bearing(0.0, 0.0, 0.0, 1.0);
        assert!((b - 90.0).abs() < 1e-9);
        let (_, b) = distance_bearing(10.0, 0.0, 9.0, 0.0);
        assert!((b - 180.0).abs() < 1e-9);
        let (d, _) = distance_bearing(40.0, 179.5, 40.0, -179.5);
        assert!((d - 85.18).abs() < 0.05, "across the antimeridian: {d}");
    }
}
