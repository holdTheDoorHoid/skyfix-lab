//! The pack container (EXPLORER_API "Packs") and the section layout of the series
//! payload (EXPLORER_API "Series payload (deeptime agent)").
//!
//! OWNER: deeptime agent. Everything here reads byte slices: no alignment assumptions,
//! no `unsafe`, every length checked before it is used, so a damaged or hostile file is
//! refused with a sentence rather than a panic.
//!
//! Container, little-endian:
//!
//! ```text
//! magic "SKYFIXPK" (8 bytes) | u16 format version (1) | u16 name length | name (UTF-8)
//! | u32 payload length | payload | u32 CRC-32 (IEEE, as zlib) of the payload
//! ```
//!
//! The embedded series file uses this container with the name `series`, so the core's
//! own tables go through the same parser any downloaded pack would.
//!
//! Series payload: `u32 section count`, then per section a 4-byte ASCII tag, a `u32`
//! length and that many bytes. Readers skip tags they do not know (so a later format
//! can add sections); [`Sections::require`] refuses a missing one.

/// The container magic.
pub const MAGIC: &[u8; 8] = b"SKYFIXPK";
/// The container format this build reads.
pub const FORMAT_VERSION: u16 = 1;

/// A parsed container: its name, format version and verified payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackFile<'a> {
    pub name: &'a str,
    pub version: u16,
    pub payload: &'a [u8],
    pub crc32: u32,
}

/// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), the value zlib's `crc32` and
/// the packs agent's manifest builder compute.
pub fn crc32(data: &[u8]) -> u32 {
    const fn table() -> [u32; 256] {
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
    static TABLE: [u32; 256] = table();
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/// Parse and verify a container: magic, format version, name, lengths and CRC.
pub fn parse_container(bytes: &[u8]) -> Result<PackFile<'_>, String> {
    let mut r = Reader::new(bytes, "pack");
    let magic = r.bytes(8)?;
    if magic != MAGIC {
        return Err("pack: not a SkyFix pack (bad magic)".to_string());
    }
    let version = r.u16()?;
    if version != FORMAT_VERSION {
        return Err(format!(
            "pack: format version {version}, this build reads {FORMAT_VERSION}"
        ));
    }
    let name_len = usize::from(r.u16()?);
    let name = std::str::from_utf8(r.bytes(name_len)?)
        .map_err(|_| "pack: the name is not UTF-8".to_string())?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("pack: {name:?} is not a pack name"));
    }
    let len = r.u32()? as usize;
    let payload = r.bytes(len)?;
    let crc = r.u32()?;
    if r.remaining() != 0 {
        return Err(format!(
            "pack {name}: {} bytes after the checksum",
            r.remaining()
        ));
    }
    let got = crc32(payload);
    if got != crc {
        return Err(format!(
            "pack {name}: checksum {got:08x}, the file says {crc:08x} (damaged download?)"
        ));
    }
    Ok(PackFile {
        name,
        version,
        payload,
        crc32: crc,
    })
}

/// The sections of a series payload, in file order.
#[derive(Debug, Clone)]
pub struct Sections<'a> {
    items: Vec<([u8; 4], &'a [u8])>,
}

impl<'a> Sections<'a> {
    /// Split a payload into its tagged sections.
    pub fn parse(payload: &'a [u8]) -> Result<Self, String> {
        let mut r = Reader::new(payload, "payload");
        let n = r.u32()? as usize;
        if n > 256 {
            return Err(format!("payload: {n} sections is not plausible"));
        }
        let mut items = Vec::with_capacity(n);
        for _ in 0..n {
            let t = r.bytes(4)?;
            let tag = [t[0], t[1], t[2], t[3]];
            if !tag.iter().all(u8::is_ascii_alphanumeric) {
                return Err(format!("payload: section tag {tag:?} is not ASCII"));
            }
            let len = r.u32()? as usize;
            let body = r.bytes(len)?;
            if items.iter().any(|(t, _)| *t == tag) {
                return Err(format!(
                    "payload: section {} appears twice",
                    String::from_utf8_lossy(&tag)
                ));
            }
            items.push((tag, body));
        }
        if r.remaining() != 0 {
            return Err(format!(
                "payload: {} bytes after the last section",
                r.remaining()
            ));
        }
        Ok(Sections { items })
    }

    /// The body of section `tag`, if present.
    pub fn get(&self, tag: &str) -> Option<&'a [u8]> {
        self.items
            .iter()
            .find(|(t, _)| t.as_slice() == tag.as_bytes())
            .map(|(_, b)| *b)
    }

    /// The body of section `tag`, or an error naming it.
    pub fn require(&self, tag: &str) -> Result<&'a [u8], String> {
        self.get(tag)
            .ok_or_else(|| format!("payload: section {tag} is missing"))
    }

    /// Tags in file order.
    pub fn tags(&self) -> Vec<String> {
        self.items
            .iter()
            .map(|(t, _)| String::from_utf8_lossy(t).into_owned())
            .collect()
    }
}

/// A bounds-checked little-endian reader over a byte slice.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    what: &'static str,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], what: &'static str) -> Self {
        Reader { buf, pos: 0, what }
    }

    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.remaining() {
            return Err(format!(
                "{}: truncated ({} bytes wanted at offset {}, {} left)",
                self.what,
                n,
                self.pos,
                self.remaining()
            ));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let s = self.bytes(N)?;
        let mut a = [0u8; N];
        a.copy_from_slice(s);
        Ok(a)
    }

    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.array::<1>()?[0])
    }

    pub fn i8(&mut self) -> Result<i8, String> {
        Ok(i8::from_le_bytes(self.array::<1>()?))
    }

    pub fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.array::<2>()?))
    }

    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.array::<4>()?))
    }

    pub fn f32(&mut self) -> Result<f32, String> {
        let v = f32::from_le_bytes(self.array::<4>()?);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(format!(
                "{}: a non-finite number at offset {}",
                self.what,
                self.pos - 4
            ))
        }
    }

    pub fn f64(&mut self) -> Result<f64, String> {
        let v = f64::from_le_bytes(self.array::<8>()?);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(format!(
                "{}: a non-finite number at offset {}",
                self.what,
                self.pos - 8
            ))
        }
    }

    /// A count that must fit what is left, `per_item` bytes each (so a corrupt count
    /// cannot ask for gigabytes before the read fails).
    pub fn count(&mut self, per_item: usize) -> Result<usize, String> {
        let n = self.u32()? as usize;
        if n.saturating_mul(per_item.max(1)) > self.remaining() {
            return Err(format!(
                "{}: a count of {n} items does not fit the {} bytes left",
                self.what,
                self.remaining()
            ));
        }
        Ok(n)
    }

    /// Fail unless every byte was consumed.
    pub fn finish(&self) -> Result<(), String> {
        if self.remaining() == 0 {
            Ok(())
        } else {
            Err(format!(
                "{}: {} unread bytes at the end",
                self.what,
                self.remaining()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(name: &str, payload: &[u8]) -> Vec<u8> {
        let mut v = MAGIC.to_vec();
        v.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        v.extend_from_slice(&(name.len() as u16).to_le_bytes());
        v.extend_from_slice(name.as_bytes());
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(payload);
        v.extend_from_slice(&crc32(payload).to_le_bytes());
        v
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        // The CRC-32 check value: "123456789" -> 0xCBF43926 (zlib, PNG, Ethernet).
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn a_good_container_parses() {
        let f = build("series", b"hello");
        let p = parse_container(&f).unwrap();
        assert_eq!(p.name, "series");
        assert_eq!(p.version, 1);
        assert_eq!(p.payload, b"hello");
    }

    #[test]
    fn damaged_containers_are_refused_with_a_reason() {
        let good = build("series", b"hello world");
        // Every truncation is refused, never a panic.
        for n in 0..good.len() {
            assert!(parse_container(&good[..n]).is_err(), "prefix of {n} bytes");
        }
        let mut bad_magic = good.clone();
        bad_magic[0] = b'X';
        assert!(parse_container(&bad_magic).unwrap_err().contains("magic"));
        let mut bad_version = good.clone();
        bad_version[8] = 2;
        assert!(
            parse_container(&bad_version)
                .unwrap_err()
                .contains("version")
        );
        let mut bad_crc = good.clone();
        let last = bad_crc.len() - 6;
        bad_crc[last] ^= 1;
        assert!(parse_container(&bad_crc).unwrap_err().contains("checksum"));
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(parse_container(&trailing).is_err());
        assert!(parse_container(&build("no/slash", b"x")).is_err());
        assert!(parse_container(&build("", b"x")).is_err());
    }

    #[test]
    fn sections_split_and_refuse_nonsense() {
        let mut p = 2u32.to_le_bytes().to_vec();
        p.extend_from_slice(b"META");
        p.extend_from_slice(&3u32.to_le_bytes());
        p.extend_from_slice(b"abc");
        p.extend_from_slice(b"VSOP");
        p.extend_from_slice(&1u32.to_le_bytes());
        p.push(7);
        let s = Sections::parse(&p).unwrap();
        assert_eq!(s.tags(), vec!["META", "VSOP"]);
        assert_eq!(s.require("META").unwrap(), b"abc");
        assert_eq!(s.get("VSOP").unwrap(), &[7]);
        assert!(s.require("ELPS").unwrap_err().contains("ELPS"));
        // Truncated, duplicated, trailing bytes, silly counts.
        assert!(Sections::parse(&p[..p.len() - 1]).is_err());
        let mut dup = 2u32.to_le_bytes().to_vec();
        for _ in 0..2 {
            dup.extend_from_slice(b"META");
            dup.extend_from_slice(&0u32.to_le_bytes());
        }
        assert!(Sections::parse(&dup).unwrap_err().contains("twice"));
        let mut extra = p.clone();
        extra.push(0);
        assert!(Sections::parse(&extra).is_err());
        assert!(Sections::parse(&u32::MAX.to_le_bytes()).is_err());
    }

    #[test]
    fn the_reader_checks_every_read() {
        let data = [1u8, 0, 0, 0, 0xFF, 0xFF, 0x7F, 0x7F];
        let mut r = Reader::new(&data, "t");
        assert_eq!(r.u32().unwrap(), 1);
        assert!(r.f64().is_err()); // only 4 bytes left
        let mut r = Reader::new(&data, "t");
        r.bytes(4).unwrap();
        // 0x7F7FFFFF is f32::MAX: finite.
        assert!(r.f32().is_ok());
        let nan = f32::NAN.to_le_bytes();
        assert!(Reader::new(&nan, "t").f32().is_err());
        let mut r = Reader::new(&[5, 0, 0, 0, 1, 2], "t");
        assert!(r.count(1).is_err()); // 5 items, 2 bytes left
    }
}
