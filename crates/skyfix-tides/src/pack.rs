//! The `tides-us` pack: the common pack header of `docs/EXPLORER_API.md` ("Packs") and
//! this pack's payload.
//!
//! Header (little-endian): magic `SKYFIXPK`, u16 format version (1), u16 name length,
//! name (UTF-8), u32 payload length, payload, u32 CRC-32 (IEEE) of the payload. Nothing
//! may follow the CRC.
//!
//! Payload, format 1 (little-endian, byte-packed; `str8` is a u8 length then bytes):
//!
//! ```text
//! "TIDE"                 4 bytes
//! u16                    payload format (1)
//! str8                   data version: NOAA retrieval date, YYYY-MM-DD
//! u8 K, K × str8         constituent names (NOAA's 37 standard ones in NOAA's order,
//!                        then NOAA's extended set)
//! u8 B                   how many leading names the per-station bitmap covers (37)
//! u32 S                  station count, then S records sorted by id:
//!   str8 id, str8 name (UTF-8), str8 state (may be empty)
//!   i32 latitude, i32 longitude        microdegrees, east positive
//!   u8 kind                            0 harmonic, 1 subordinate
//!   u8 flags                           db::flags
//!   harmonic:
//!     8 × i16                          MHHW, MHW, MTL, MLW, MLLW, LAT, HAT, NAVD88 in mm
//!                                      relative to MSL; -32768 = not published
//!     ceil(B/8) bytes                  presence bitmap of names 0..B, name k in bit k%8
//!                                      of byte k/8
//!     per present name, in order:      u16 amplitude (mm), u16 Greenwich phase (0.01°)
//!     u8 E, E × (u8 name index ≥ B,    further constituents (Anchorage's extended set)
//!                u16 amplitude, u16 phase)
//!   subordinate:
//!     u16 reference                    index of the reference station in this list
//!     i16 high, i16 low                time offsets, minutes
//!     u8 height type                   0 ratio, 1 additive
//!     i16 high, i16 low                ratio × 1000, or additive offset in mm
//! ```

use std::fmt;

use crate::db::{Datums, Harmonic, HeightAdjust, Station, StationKind, Subordinate, TideDb};
use crate::schureman::{CONSTITUENTS, NOAA_STANDARD, index_of};

pub const PACK_MAGIC: &[u8; 8] = b"SKYFIXPK";
pub const PACK_FORMAT: u16 = 1;
pub const PACK_NAME: &str = "tides-us";
pub const PAYLOAD_MAGIC: &[u8; 4] = b"TIDE";
pub const PAYLOAD_FORMAT: u16 = 1;
/// The "not published" sentinel of a datum.
pub const DATUM_MISSING: i16 = i16::MIN;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackError(pub String);

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PackError {}

fn perr(msg: impl Into<String>) -> PackError {
    PackError(msg.into())
}

// ---------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, reflected, as zlib's crc32)
// ---------------------------------------------------------------------------------------

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

static CRC_TABLE: [u32; 256] = crc_table();

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], PackError> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&e| e <= self.b.len())
            .ok_or_else(|| perr(format!("truncated tides-us payload reading {what}")))?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self, what: &str) -> Result<u8, PackError> {
        Ok(self.take(1, what)?[0])
    }
    fn u16(&mut self, what: &str) -> Result<u16, PackError> {
        let s = self.take(2, what)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn i16(&mut self, what: &str) -> Result<i16, PackError> {
        let s = self.take(2, what)?;
        Ok(i16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self, what: &str) -> Result<u32, PackError> {
        let s = self.take(4, what)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn i32(&mut self, what: &str) -> Result<i32, PackError> {
        let s = self.take(4, what)?;
        Ok(i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn str8(&mut self, what: &str) -> Result<String, PackError> {
        let n = usize::from(self.u8(what)?);
        let s = self.take(n, what)?;
        String::from_utf8(s.to_vec()).map_err(|_| perr(format!("{what} is not UTF-8")))
    }
}

/// Split a whole pack file into `(name, payload)`, checking the magic, the format
/// version, the lengths and the CRC.
pub fn parse_file(bytes: &[u8]) -> Result<(String, &[u8]), PackError> {
    let mut c = Cursor { b: bytes, at: 0 };
    if c.take(8, "the magic")? != PACK_MAGIC {
        return Err(perr("not a SkyFix Lab pack (bad magic)"));
    }
    let version = c.u16("the format version")?;
    if version != PACK_FORMAT {
        return Err(perr(format!(
            "pack format {version} is not supported (expected {PACK_FORMAT})"
        )));
    }
    let n = usize::from(c.u16("the name length")?);
    let name = String::from_utf8(c.take(n, "the name")?.to_vec())
        .map_err(|_| perr("pack name is not UTF-8"))?;
    let len = c.u32("the payload length")? as usize;
    let payload = c.take(len, "the payload")?;
    let crc = c.u32("the CRC")?;
    if c.at != bytes.len() {
        return Err(perr(format!(
            "{} unexpected bytes after the pack's CRC",
            bytes.len() - c.at
        )));
    }
    let got = crc32(payload);
    if got != crc {
        return Err(perr(format!(
            "pack {name:?} is damaged: CRC-32 {got:08x}, header says {crc:08x}"
        )));
    }
    Ok((name, payload))
}

/// Parse a whole `tides-us` file.
pub fn decode_file(bytes: &[u8]) -> Result<TideDb, PackError> {
    let (name, payload) = parse_file(bytes)?;
    if name != PACK_NAME {
        return Err(perr(format!(
            "this is the {name:?} pack, not {PACK_NAME:?}"
        )));
    }
    decode_payload(payload)
}

/// Parse the `tides-us` payload (what the pack dispatcher hands over).
pub fn decode_payload(payload: &[u8]) -> Result<TideDb, PackError> {
    let mut c = Cursor { b: payload, at: 0 };
    if c.take(4, "the payload magic")? != PAYLOAD_MAGIC {
        return Err(perr("not a tides-us payload (bad magic)"));
    }
    let format = c.u16("the payload format")?;
    if format != PAYLOAD_FORMAT {
        return Err(perr(format!(
            "tides-us payload format {format} is not supported (expected {PAYLOAD_FORMAT})"
        )));
    }
    let version = c.str8("the data version")?;
    let k = usize::from(c.u8("the constituent count")?);
    let mut map = Vec::with_capacity(k);
    for _ in 0..k {
        let name = c.str8("a constituent name")?;
        let idx = index_of(&name)
            .ok_or_else(|| perr(format!("unknown constituent {name:?} in the pack")))?;
        map.push(idx as u8);
    }
    let bitmap_names = usize::from(c.u8("the bitmap width")?);
    if bitmap_names > k {
        return Err(perr("bitmap wider than the constituent list"));
    }
    let bitmap_len = bitmap_names.div_ceil(8);
    let n = c.u32("the station count")? as usize;
    if n > 100_000 {
        return Err(perr(format!("implausible station count {n}")));
    }
    let mut stations = Vec::with_capacity(n);
    for _ in 0..n {
        let id = c.str8("a station id")?;
        let name = c.str8("a station name")?;
        let state = c.str8("a state code")?;
        // Division (not multiplication by 1e-6) gives the double nearest the decimal.
        let lat = f64::from(c.i32("a latitude")?) / 1e6;
        let lon = f64::from(c.i32("a longitude")?) / 1e6;
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return Err(perr(format!("station {id}: position out of range")));
        }
        let kind = c.u8("a station kind")?;
        let flags = c.u8("station flags")?;
        let kind = match kind {
            0 => {
                let mut datums = Datums::default();
                for slot in &mut datums.mm_rel_msl {
                    let v = c.i16("a datum")?;
                    *slot = (v != DATUM_MISSING).then_some(v);
                }
                let bits = c.take(bitmap_len, "a constituent bitmap")?.to_vec();
                let mut terms = Vec::new();
                let mut term = |c: &mut Cursor, idx: u8| -> Result<(), PackError> {
                    let amp = f64::from(c.u16("an amplitude")?) / 1000.0;
                    let ph = c.u16("a phase")?;
                    if ph >= 36_000 {
                        return Err(perr(format!("station {id}: phase {ph}")));
                    }
                    terms.push((idx, amp, f64::from(ph) / 100.0));
                    Ok(())
                };
                for (j, &idx) in map.iter().take(bitmap_names).enumerate() {
                    if bits[j / 8] & (1 << (j % 8)) != 0 {
                        term(&mut c, idx)?;
                    }
                }
                let extra = c.u8("the extra term count")?;
                for _ in 0..extra {
                    let j = usize::from(c.u8("an extra term's name")?);
                    if j < bitmap_names || j >= k {
                        return Err(perr(format!("station {id}: extra term name {j}")));
                    }
                    term(&mut c, map[j])?;
                }
                terms.sort_by_key(|t| t.0);
                if terms.windows(2).any(|w| w[0].0 == w[1].0) {
                    return Err(perr(format!("station {id}: a constituent twice")));
                }
                StationKind::Harmonic(Harmonic { datums, terms })
            }
            1 => {
                let reference = u32::from(c.u16("a reference index")?);
                if reference as usize >= n {
                    return Err(perr(format!("station {id}: reference index {reference}")));
                }
                let time_high_min = c.i16("a time offset")?;
                let time_low_min = c.i16("a time offset")?;
                let ht = c.u8("a height type")?;
                let (hi, lo) = (
                    f64::from(c.i16("a height offset")?),
                    f64::from(c.i16("a height offset")?),
                );
                let heights = match ht {
                    0 => HeightAdjust::Ratio {
                        high: hi / 1000.0,
                        low: lo / 1000.0,
                    },
                    1 => HeightAdjust::Additive {
                        high_m: hi / 1000.0,
                        low_m: lo / 1000.0,
                    },
                    _ => return Err(perr(format!("station {id}: height type {ht}"))),
                };
                StationKind::Subordinate(Subordinate {
                    reference,
                    time_high_min,
                    time_low_min,
                    heights,
                })
            }
            _ => return Err(perr(format!("station {id}: kind {kind}"))),
        };
        stations.push(Station {
            id,
            name,
            state,
            lat_deg: lat,
            lon_deg: lon,
            flags,
            kind,
        });
    }
    if c.at != payload.len() {
        return Err(perr(format!(
            "{} unexpected bytes after the last station",
            payload.len() - c.at
        )));
    }
    for s in &stations {
        if let StationKind::Subordinate(sub) = &s.kind {
            if !stations[sub.reference as usize].is_harmonic() {
                return Err(perr(format!(
                    "station {}: its reference is not a harmonic station",
                    s.id
                )));
            }
        }
    }
    Ok(TideDb::new(version, stations))
}

// ---------------------------------------------------------------------------------------
// Writing (tests and tools; the pipeline in tools/tides writes the same bytes)
// ---------------------------------------------------------------------------------------

fn put_str8(out: &mut Vec<u8>, s: &str) -> Result<(), PackError> {
    let n = u8::try_from(s.len()).map_err(|_| perr(format!("string too long: {s:?}")))?;
    out.push(n);
    out.extend_from_slice(s.as_bytes());
    Ok(())
}

fn micro(deg: f64) -> i32 {
    (deg * 1e6).round() as i32
}

/// Encode a database as a payload (stations in the order given; the pipeline sorts
/// them by id).
pub fn encode_payload(db: &TideDb) -> Result<Vec<u8>, PackError> {
    let mut out = Vec::new();
    out.extend_from_slice(PAYLOAD_MAGIC);
    out.extend_from_slice(&PAYLOAD_FORMAT.to_le_bytes());
    put_str8(&mut out, &db.version)?;
    out.push(CONSTITUENTS.len() as u8);
    for c in &CONSTITUENTS {
        put_str8(&mut out, c.name)?;
    }
    out.push(NOAA_STANDARD as u8);
    out.extend_from_slice(&(db.stations.len() as u32).to_le_bytes());
    let bitmap_len = NOAA_STANDARD.div_ceil(8);
    for s in &db.stations {
        put_str8(&mut out, &s.id)?;
        put_str8(&mut out, &s.name)?;
        put_str8(&mut out, &s.state)?;
        out.extend_from_slice(&micro(s.lat_deg).to_le_bytes());
        out.extend_from_slice(&micro(s.lon_deg).to_le_bytes());
        match &s.kind {
            StationKind::Harmonic(h) => {
                out.push(0);
                out.push(s.flags);
                for v in h.datums.mm_rel_msl {
                    out.extend_from_slice(&v.unwrap_or(DATUM_MISSING).to_le_bytes());
                }
                let mut terms = h.terms.clone();
                terms.sort_by_key(|t| t.0);
                let (standard, extra): (Vec<_>, Vec<_>) = terms
                    .into_iter()
                    .partition(|t| usize::from(t.0) < NOAA_STANDARD);
                let mut bits = vec![0u8; bitmap_len];
                for t in &standard {
                    bits[usize::from(t.0) / 8] |= 1 << (t.0 % 8);
                }
                out.extend_from_slice(&bits);
                let put = |out: &mut Vec<u8>, amp: f64, ph: f64| -> Result<(), PackError> {
                    let a = (amp * 1000.0).round();
                    let p = (ph.rem_euclid(360.0) * 100.0).round() % 36_000.0;
                    if !(0.0..=65_535.0).contains(&a) {
                        return Err(perr(format!("station {}: amplitude {amp}", s.id)));
                    }
                    out.extend_from_slice(&(a as u16).to_le_bytes());
                    out.extend_from_slice(&(p as u16).to_le_bytes());
                    Ok(())
                };
                for &(_, amp, ph) in &standard {
                    put(&mut out, amp, ph)?;
                }
                let n = u8::try_from(extra.len()).map_err(|_| perr("too many extra terms"))?;
                out.push(n);
                for &(k, amp, ph) in &extra {
                    out.push(k);
                    put(&mut out, amp, ph)?;
                }
            }
            StationKind::Subordinate(sub) => {
                out.push(1);
                out.push(s.flags);
                let r =
                    u16::try_from(sub.reference).map_err(|_| perr("reference index beyond u16"))?;
                out.extend_from_slice(&r.to_le_bytes());
                out.extend_from_slice(&sub.time_high_min.to_le_bytes());
                out.extend_from_slice(&sub.time_low_min.to_le_bytes());
                let (t, hi, lo) = match sub.heights {
                    HeightAdjust::Ratio { high, low } => (0u8, high, low),
                    HeightAdjust::Additive { high_m, low_m } => (1u8, high_m, low_m),
                };
                out.push(t);
                out.extend_from_slice(&((hi * 1000.0).round() as i16).to_le_bytes());
                out.extend_from_slice(&((lo * 1000.0).round() as i16).to_le_bytes());
            }
        }
    }
    Ok(out)
}

/// Wrap a payload in the common pack header.
pub fn wrap_file(name: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 32);
    out.extend_from_slice(PACK_MAGIC);
    out.extend_from_slice(&PACK_FORMAT.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&crc32(payload).to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::flags;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    pub(crate) fn sample_db() -> TideDb {
        let datums = Datums {
            mm_rel_msl: [
                Some(829),
                Some(643),
                Some(19),
                Some(-605),
                Some(-951),
                Some(-1546),
                Some(1255),
                None,
            ],
        };
        TideDb::new(
            "2026-09-25".into(),
            vec![
                Station {
                    id: "9414290".into(),
                    name: "San Francisco".into(),
                    state: "CA".into(),
                    lat_deg: 37.806305,
                    lon_deg: -122.46589,
                    flags: 0,
                    kind: StationKind::Harmonic(Harmonic {
                        datums,
                        // M2, K1, MS4 and one of the extended set (2MS6, index 76).
                        terms: vec![
                            (0, 0.576, 208.2),
                            (3, 0.37, 225.4),
                            (36, 0.01, 149.0),
                            (76, 0.144, 59.4),
                        ],
                    }),
                },
                Station {
                    id: "9414305".into(),
                    name: "North Point, Pier 41".into(),
                    state: "CA".into(),
                    lat_deg: 37.81,
                    lon_deg: -122.413,
                    flags: flags::NON_NAVIGATIONAL,
                    kind: StationKind::Subordinate(Subordinate {
                        reference: 0,
                        time_high_min: 12,
                        time_low_min: -3,
                        heights: HeightAdjust::Ratio {
                            high: 0.98,
                            low: 1.01,
                        },
                    }),
                },
            ],
        )
    }

    #[test]
    fn a_pack_round_trips() {
        let db = sample_db();
        let payload = encode_payload(&db).unwrap();
        let file = wrap_file(PACK_NAME, &payload);
        let back = decode_file(&file).unwrap();
        assert_eq!(back, db);
        assert_eq!(encode_payload(&back).unwrap(), payload);
    }

    #[test]
    fn damaged_or_foreign_packs_are_refused_with_the_reason() {
        let payload = encode_payload(&sample_db()).unwrap();
        let file = wrap_file(PACK_NAME, &payload);
        let mut bad = file.clone();
        bad[40] ^= 0x55;
        assert!(decode_file(&bad).unwrap_err().0.contains("CRC-32"));
        let mut bad = file.clone();
        bad[0] = b'X';
        assert!(decode_file(&bad).unwrap_err().0.contains("magic"));
        let other = wrap_file("deep-time", &payload);
        assert!(decode_file(&other).unwrap_err().0.contains("deep-time"));
        assert!(decode_file(&file[..file.len() - 1]).is_err());
        let mut longer = file.clone();
        longer.push(0);
        assert!(decode_file(&longer).unwrap_err().0.contains("after"));
        assert!(
            decode_payload(&payload[..payload.len() - 3])
                .unwrap_err()
                .0
                .contains("truncated")
        );
    }
}
