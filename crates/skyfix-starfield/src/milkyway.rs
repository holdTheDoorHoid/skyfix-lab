//! The Milky Way outline: this project's own isophotes from NASA's COBE/DIRBE maps
//! (EXPLORER_API.md, "Deep sky", `milky_way_outline`).
//!
//! OWNER: deepsky agent. Display only (CONVENTIONS 13.6): a picture of where the Milky
//! Way's glow is, in four steps of brightness, not a measurement.
//!
//! `data/milkyway.bin` is written by `tools/starfield/milkyway.py` (the processing is
//! documented there and in docs/THIRD_PARTY.md, "Deep sky"). Little-endian:
//!
//! | bytes | field |
//! |---|---|
//! | 8 | magic `SKYFIXMW` |
//! | 2 | format version (1) |
//! | 2 | level count `L` |
//! | 4 L | each level's threshold, `f32` (DIRBE 1.25 um MJy/sr after the dust weighting) |
//! | 4 | ring count |
//! | per ring | `u8` level index, `u32` point count `n`, the first point as `u16` RA and `i16` Dec in units of 0.01 degree (ICRS/J2000), then `n - 1` pairs of zigzag LEB128 varints: the RA step (wrapped to within half a turn) and the Dec step, same units |
//!
//! The dust weighting darkens the whole Galactic plane where the 100 um emission is
//! strong, so the brighter levels show the Great Rift but also darken low-dust windows
//! on the plane (the Sagittarius Star Cloud, M24) more than the eye sees them.
//!
//! Every ring is closed (the decoder repeats its first point at the end, as the
//! constellation boundaries do) and oriented: for consecutive points `a`, `b` as unit
//! vectors, the brighter side of the ring is the one `a × b` points to. Rings of one level
//! may be nested (a darker hole inside a brighter region); filling a level by the
//! even-odd rule, or by the orientation, gives the same region.

use std::sync::OnceLock;

use serde::Serialize;

use crate::StarfieldError;

const MILKYWAY_BIN: &[u8] = include_bytes!("../data/milkyway.bin");
const MAGIC: &[u8; 8] = b"SKYFIXMW";
const VERSION: u16 = 1;
const UNIT_DEG: f64 = 0.01;
const FULL_TURN: i64 = 36_000;

/// One closed, oriented ring of one brightness level, ICRS (J2000) degrees.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ring {
    /// Index into [`Outline::levels`]: 0 the faintest glow, the last the brightest.
    pub level: u8,
    pub ra_deg: Vec<f64>,
    pub dec_deg: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Outline {
    /// Thresholds of the levels in the processed 1.25 um brightness (MJy/sr), faintest
    /// first; only their order matters for drawing.
    pub levels: Vec<f64>,
    pub rings: Vec<Ring>,
}

/// Provenance, one sentence.
pub const SOURCE: &str = "SkyFix Lab's own isophotes of the Milky Way, derived from NASA \
     COBE/DIRBE Zodi-Subtracted Mission Average maps (1.25 um starlight, weakened by the \
     100 um dust so the dark lanes show), smoothed 1.5 degrees and simplified to 0.2 degrees.";

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], StarfieldError> {
        let s = self
            .b
            .get(self.at..self.at + n)
            .ok_or_else(|| StarfieldError::Data("milkyway.bin: truncated".into()))?;
        self.at += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, StarfieldError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, StarfieldError> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }

    fn u32(&mut self) -> Result<u32, StarfieldError> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }

    fn varint(&mut self) -> Result<i64, StarfieldError> {
        let mut v: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = self.u8()?;
            v |= u64::from(byte & 0x7F) << shift;
            if byte & 0x80 == 0 {
                // Zigzag.
                return Ok((v >> 1) as i64 ^ -((v & 1) as i64));
            }
        }
        Err(StarfieldError::Data("milkyway.bin: varint too long".into()))
    }
}

pub(crate) fn parse_from(bin: &[u8]) -> Result<Outline, StarfieldError> {
    let bad = |m: &str| StarfieldError::Data(format!("milkyway.bin: {m}"));
    let mut r = Reader { b: bin, at: 0 };
    if r.take(8)? != MAGIC {
        return Err(bad("bad magic"));
    }
    if r.u16()? != VERSION {
        return Err(bad("unknown format version"));
    }
    let nlev = usize::from(r.u16()?);
    let mut levels = Vec::with_capacity(nlev);
    for _ in 0..nlev {
        let s = r.take(4)?;
        levels.push(f64::from(f32::from_le_bytes([s[0], s[1], s[2], s[3]])));
    }
    let nrings = r.u32()? as usize;
    let mut rings = Vec::with_capacity(nrings);
    for _ in 0..nrings {
        let level = r.u8()?;
        if usize::from(level) >= nlev {
            return Err(bad("ring level out of range"));
        }
        let n = r.u32()? as usize;
        if !(3..=100_000).contains(&n) {
            return Err(bad("implausible ring length"));
        }
        let mut ra = i64::from(r.u16()?);
        let mut dec = i64::from(r.u16()? as i16);
        let mut ring = Ring {
            level,
            ra_deg: Vec::with_capacity(n + 1),
            dec_deg: Vec::with_capacity(n + 1),
        };
        for k in 0..n {
            if k > 0 {
                ra = (ra + r.varint()?).rem_euclid(FULL_TURN);
                dec += r.varint()?;
            }
            if dec.abs() > 9_000 {
                return Err(bad("declination out of range"));
            }
            ring.ra_deg.push(ra as f64 * UNIT_DEG);
            ring.dec_deg.push(dec as f64 * UNIT_DEG);
        }
        ring.ra_deg.push(ring.ra_deg[0]);
        ring.dec_deg.push(ring.dec_deg[0]);
        rings.push(ring);
    }
    if r.at != bin.len() {
        return Err(bad("trailing bytes"));
    }
    Ok(Outline { levels, rings })
}

/// The outline, decoded on first use.
pub fn outline() -> Result<&'static Outline, StarfieldError> {
    static CELL: OnceLock<Result<Outline, StarfieldError>> = OnceLock::new();
    CELL.get_or_init(|| parse_from(MILKYWAY_BIN))
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_ephemeris::frames::unit_vector_from_radec;

    fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    }

    fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    /// Whether the great-circle arcs a-b and c-d cross (arcs shorter than 180 degrees):
    /// one of the two points where their circles meet lies on both arcs.
    fn arcs_cross(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> bool {
        let n1 = cross(a, b);
        let n2 = cross(c, d);
        let x = cross(n1, n2);
        if dot(x, x) < 1e-30 {
            return false;
        }
        let on = |p: [f64; 3], a: [f64; 3], b: [f64; 3], n: [f64; 3]| {
            dot(cross(a, p), n) >= 0.0 && dot(cross(p, b), n) >= 0.0
        };
        [x, [-x[0], -x[1], -x[2]]]
            .into_iter()
            .any(|p| on(p, a, b, n1) && on(p, c, d, n2))
    }

    /// Inside a level's region: an odd number of crossings of that level's rings on the
    /// way from the north galactic pole (outside every level) to the point, the way
    /// split in two arcs so neither reaches 180 degrees.
    fn inside(o: &Outline, level: u8, ra: f64, dec: f64) -> bool {
        let ngp = unit_vector_from_radec(192.859_508, 27.128_336);
        let p = unit_vector_from_radec(ra, dec);
        let mid = {
            let m = [ngp[0] + p[0], ngp[1] + p[1], ngp[2] + p[2]];
            let n = dot(m, m).sqrt();
            if n < 1e-9 {
                unit_vector_from_radec(0.0, 0.0)
            } else {
                [m[0] / n, m[1] / n, m[2] / n]
            }
        };
        let mut count = 0;
        for ring in o.rings.iter().filter(|r| r.level == level) {
            for k in 0..ring.ra_deg.len() - 1 {
                let a = unit_vector_from_radec(ring.ra_deg[k], ring.dec_deg[k]);
                let b = unit_vector_from_radec(ring.ra_deg[k + 1], ring.dec_deg[k + 1]);
                count += usize::from(arcs_cross(ngp, mid, a, b));
                count += usize::from(arcs_cross(mid, p, a, b));
            }
        }
        count % 2 == 1
    }

    #[test]
    fn the_outline_decodes_and_every_ring_is_closed() {
        let o = outline().unwrap();
        assert_eq!(o.levels.len(), 4);
        assert!(o.levels.windows(2).all(|w| w[0] < w[1]));
        assert!(
            o.rings.len() >= 10 && o.rings.len() <= 200,
            "{}",
            o.rings.len()
        );
        for r in &o.rings {
            assert_eq!(r.ra_deg.len(), r.dec_deg.len());
            assert_eq!(r.ra_deg.first(), r.ra_deg.last());
            assert!(r.ra_deg.iter().all(|a| (0.0..360.0).contains(a)));
            assert!(r.dec_deg.iter().all(|d| d.abs() <= 90.0));
        }
        let points: usize = o.rings.iter().map(|r| r.ra_deg.len() - 1).sum();
        assert!((500..20_000).contains(&points), "{points}");
        assert!(parse_from(b"nonsense").is_err());
        let mut short = MILKYWAY_BIN.to_vec();
        short.truncate(short.len() - 1);
        assert!(parse_from(&short).is_err());
    }

    #[test]
    fn the_glow_is_where_the_milky_way_is() {
        let o = outline().unwrap();
        // The faintest level covers the band: Cygnus, the anticentre in Auriga, Crux,
        // Sagittarius; never the galactic poles or Orion's belt region 25 degrees off it.
        for (what, ra, dec) in [
            ("Sadr, Cygnus", 305.56, 40.26),
            ("the anticentre", 86.4, 28.9),
            ("Crux", 187.0, -60.0),
            ("the Sagittarius star cloud (M24)", 274.2, -18.55),
            ("Carina", 160.0, -59.5),
        ] {
            assert!(inside(o, 0, ra, dec), "{what}");
        }
        for (what, ra, dec) in [
            ("the north galactic pole region", 190.0, 20.0),
            ("the south galactic pole", 12.86, -27.13),
            ("Leo", 160.0, 15.0),
            ("the Large Magellanic Cloud (masked)", 80.9, -69.8),
        ] {
            assert!(!inside(o, 0, ra, dec), "{what}");
        }
        // South of the dust lane toward the Galactic centre (Baade's window) the glow
        // reaches the brighter levels; the centre itself lies in the lane. (The 100 um
        // dust screen darkens the whole plane, so low-dust windows on it, such as the
        // Sagittarius Star Cloud, M24, come out darker than the eye sees them: a known
        // limitation of the proxy, stated in docs/ACCURACY.md.)
        assert!(inside(o, 2, 270.9, -30.0));
        assert!(!inside(o, 3, 266.4, -29.0));
    }
}
