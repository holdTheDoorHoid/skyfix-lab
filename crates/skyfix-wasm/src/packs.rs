//! Optional data packs: the common file header, the registry of packs this build can
//! install, and the dispatcher that hands a verified payload to the pack's producer.
//!
//! OWNER: packs agent (the mechanism). Wire format: docs/EXPLORER_API.md, "Packs";
//! rules: CONVENTIONS §15.5; TypeScript mirror: `PackEngine` in
//! `web/src/next/engine/types.ts`. A pack changes what the engine can answer, never how it
//! answers, and the core never depends on one.
//!
//! **Producers** own their payload format (documented in their own EXPLORER_API section)
//! and add ONE entry to [`PRODUCERS`]: that entry is the "match arm" of
//! EXPANSION_PLAN §5. `deep-time` (deeptime agent), `tides-us` (tides agent) and
//! `lunar-limb` (eclipselimb agent) are planned.
//!
//! ## File layout
//!
//! Little-endian, no alignment assumptions: readers work on byte slices, never on
//! reinterpreted pointers.
//!
//! | offset      | bytes | field                                                        |
//! |-------------|-------|--------------------------------------------------------------|
//! | 0           | 8     | magic `SKYFIXPK`                                             |
//! | 8           | 2     | u16 format version, [`FORMAT_VERSION`] (1)                   |
//! | 10          | 2     | u16 name length `n`                                          |
//! | 12          | n     | the pack's name, UTF-8 (`[a-z0-9][a-z0-9-]*`, ≤ 64 bytes)    |
//! | 12 + n      | 4     | u32 payload length `p`                                       |
//! | 16 + n      | p     | payload (the producer's format)                              |
//! | 16 + n + p  | 4     | u32 CRC-32 of the payload (CRC-32/ISO-HDLC: zlib's `crc32`)  |
//!
//! Nothing may follow the checksum. A producer's generator writes this layout with
//! [`encode`] (Rust) or the same ten lines in Python (`struct.pack('<8sHH', …)`,
//! `zlib.crc32(payload)`).

use std::sync::Mutex;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::{err, to_js};

/// The first eight bytes of every pack file.
pub const MAGIC: &[u8; 8] = b"SKYFIXPK";
/// The header layout this build reads and writes.
pub const FORMAT_VERSION: u16 = 1;
/// Longest pack name (it is also part of a file name: `<name>-<rev>.bin`).
pub const MAX_NAME_LEN: usize = 64;
/// Magic, version, name length, payload length and checksum: the header with an empty name.
const FIXED_BYTES: usize = 8 + 2 + 2 + 4 + 4;

/// What installing a pack reports (`PackInfo` on the wire).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackInfo {
    pub name: String,
    /// The data's own version, from the payload (for example the date it was generated).
    pub version: String,
    /// Size of the whole pack file, header included. The dispatcher sets it.
    pub bytes: u64,
    /// What the pack adds, in the producer's words (`"ephemeris:-2000..3000"`).
    pub provides: Vec<String>,
}

/// One entry of `packs()` (`PackStatus` on the wire).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackStatus {
    pub name: String,
    /// The loaded pack's version; empty until one is loaded (the site's pack manifest
    /// carries the version and size of the file it offers).
    pub version: String,
    pub label: String,
    pub description: String,
    /// The loaded pack file's size; 0 until one is loaded.
    pub bytes: u64,
    pub provides: Vec<String>,
    pub loaded: bool,
}

/// A pack this build can install.
#[derive(Clone, Copy)]
pub struct Producer {
    pub name: &'static str,
    /// Shown in Settings → Data packs ("Deep time").
    pub label: &'static str,
    /// One plain sentence ("Positions from 2000 BC to AD 3000").
    pub description: &'static str,
    pub provides: &'static [&'static str],
    /// Parses and installs a payload whose header and checksum have been verified. It must
    /// reject a malformed payload without changing anything, and a second call must
    /// replace what the first installed (a newer revision of the same pack).
    pub install: fn(&[u8]) -> Result<PackInfo, String>,
}

/// Every pack this build can install.
///
/// PRODUCERS: add one entry here, and nothing else in this file, in this form:
///
/// ```text
/// Producer {
///     name: "deep-time",
///     label: "Deep time",
///     description: "Positions from 2000 BC to AD 3000",
///     provides: &["ephemeris:-2000..3000"],
///     install: crate::coverage::install_deep_time,
/// },
/// ```
pub const PRODUCERS: &[Producer] = &[
    // ---- producer entries start (one per pack; the planner union-merges them) ----
    // tides agent: NOAA tide stations (EXPLORER_API "Expansion programme — tides").
    Producer {
        name: "tides-us",
        label: "US tides",
        description: "Tide predictions for NOAA's tide stations, mostly in the United States",
        provides: &["tides:us"],
        install: crate::tides::install_tides_us,
    },
    // ---- producer entries end ----
];

/// A pack file's header, borrowed from the file's bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header<'a> {
    pub format_version: u16,
    pub name: &'a str,
    pub payload: &'a [u8],
    pub crc32: u32,
}

// ---------------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------------

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
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
        table[i] = c;
        i += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32/ISO-HDLC (the one in zlib, PNG, gzip and Python's `zlib.crc32`): reflected
/// polynomial 0xEDB88320, initial value and final XOR 0xFFFFFFFF.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

// ---------------------------------------------------------------------------------
// Reading and writing the header
// ---------------------------------------------------------------------------------

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Is `name` a valid pack name: `[a-z0-9][a-z0-9-]*`, at most [`MAX_NAME_LEN`] bytes?
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_NAME_LEN
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Read and verify a pack file's header and checksum. Every way a file can be wrong gets
/// its own sentence; nothing here trusts a length it has not checked against the file.
pub fn parse(bytes: &[u8]) -> Result<Header<'_>, String> {
    if bytes.len() < MAGIC.len() || &bytes[..MAGIC.len()] != MAGIC {
        return Err("not a SkyFix Lab data pack: the file does not start with SKYFIXPK".into());
    }
    if bytes.len() < 12 {
        return Err(format!(
            "the pack file is cut short: {} bytes, too few for its header",
            bytes.len()
        ));
    }
    let format_version = u16_at(bytes, 8);
    if format_version != FORMAT_VERSION {
        return Err(format!(
            "pack format version {format_version}: this build of SkyFix Lab reads version {FORMAT_VERSION}"
        ));
    }
    let name_len = usize::from(u16_at(bytes, 10));
    if bytes.len() < FIXED_BYTES + name_len {
        return Err(format!(
            "the pack file is cut short: {} bytes, too few for a header with a {name_len}-byte name",
            bytes.len()
        ));
    }
    let name = std::str::from_utf8(&bytes[12..12 + name_len])
        .map_err(|_| "the pack's name is not valid UTF-8".to_string())?;
    if !valid_name(name) {
        return Err(format!(
            "pack name {name:?}: a name is 1 to {MAX_NAME_LEN} lowercase letters, digits and hyphens"
        ));
    }
    let at = 12 + name_len;
    let payload_len = u32_at(bytes, at) as usize;
    let available = bytes.len() - at - 8;
    if payload_len > available {
        return Err(format!(
            "the {name} pack is cut short: its header announces {payload_len} bytes of data, the file holds {available}"
        ));
    }
    if payload_len < available {
        return Err(format!(
            "the {name} pack has {} unexpected bytes after its checksum",
            available - payload_len
        ));
    }
    let payload = &bytes[at + 4..at + 4 + payload_len];
    let stored = u32_at(bytes, at + 4 + payload_len);
    let actual = crc32(payload);
    if stored != actual {
        return Err(format!(
            "the {name} pack is damaged: its checksum is {actual:08x}, the file says {stored:08x}"
        ));
    }
    Ok(Header {
        format_version,
        name,
        payload,
        crc32: stored,
    })
}

/// Write a pack file around `payload` (producers' generators, and the tests).
pub fn encode(name: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
    if !valid_name(name) {
        return Err(format!(
            "pack name {name:?}: a name is 1 to {MAX_NAME_LEN} lowercase letters, digits and hyphens"
        ));
    }
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| format!("the {name} pack's data is over 4 GiB"))?;
    let mut out = Vec::with_capacity(FIXED_BYTES + name.len() + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&payload_len.to_le_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&crc32(payload).to_le_bytes());
    Ok(out)
}

// ---------------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------------

/// A pack installed in this page session, and the payload it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub info: PackInfo,
    crc32: u32,
    payload_len: usize,
}

/// The registry and what has been loaded from it. The module has one ([`install`],
/// [`load`], [`status`]); tests make their own with test producers.
pub struct Packs<'p> {
    producers: &'p [Producer],
    loaded: Vec<Loaded>,
}

impl<'p> Packs<'p> {
    pub fn new(producers: &'p [Producer]) -> Self {
        Self {
            producers,
            loaded: Vec::new(),
        }
    }

    fn producer(&self, name: &str) -> Result<&'p Producer, String> {
        self.producers
            .iter()
            .find(|p| p.name == name)
            .ok_or_else(|| unknown_pack(name, self.producers))
    }

    /// Hand a verified payload to its producer (the contract's `install(name, payload)`).
    /// `file_bytes` is the size of the whole file, reported as `PackInfo::bytes`.
    fn install_payload(
        &mut self,
        name: &str,
        payload: &[u8],
        crc: u32,
        file_bytes: usize,
    ) -> Result<PackInfo, String> {
        let producer = self.producer(name)?;
        // Idempotent: the same pack again (a second start-up load, a second Get) changes
        // nothing and does not run the producer twice.
        if let Some(done) = self
            .loaded
            .iter()
            .find(|l| l.info.name == name && l.crc32 == crc && l.payload_len == payload.len())
        {
            return Ok(done.info.clone());
        }
        let mut info = (producer.install)(payload).map_err(|e| format!("the {name} pack: {e}"))?;
        if info.name != name {
            return Err(format!(
                "the {name} pack's installer reported itself as {:?}",
                info.name
            ));
        }
        info.bytes = file_bytes as u64;
        if info.provides.is_empty() {
            info.provides = producer.provides.iter().map(|s| s.to_string()).collect();
        }
        self.loaded.retain(|l| l.info.name != name);
        self.loaded.push(Loaded {
            info: info.clone(),
            crc32: crc,
            payload_len: payload.len(),
        });
        Ok(info)
    }

    /// Install a payload whose header has already been read (`install(name, payload)`).
    pub fn install(&mut self, name: &str, payload: &[u8]) -> Result<PackInfo, String> {
        let crc = crc32(payload);
        self.install_payload(name, payload, crc, FIXED_BYTES + name.len() + payload.len())
    }

    /// Parse, verify and install a whole pack file that should be the pack `name`.
    pub fn load(&mut self, name: &str, file: &[u8]) -> Result<PackInfo, String> {
        let header = parse(file)?;
        if header.name != name {
            return Err(format!(
                "this file is the {} pack, not the {name} pack",
                header.name
            ));
        }
        self.install_payload(name, header.payload, header.crc32, file.len())
    }

    /// Every pack this build can install, with what is loaded.
    pub fn status(&self) -> Vec<PackStatus> {
        self.producers
            .iter()
            .map(|p| {
                let loaded = self.loaded.iter().find(|l| l.info.name == p.name);
                PackStatus {
                    name: p.name.to_string(),
                    version: loaded.map(|l| l.info.version.clone()).unwrap_or_default(),
                    label: p.label.to_string(),
                    description: p.description.to_string(),
                    bytes: loaded.map_or(0, |l| l.info.bytes),
                    provides: loaded.map_or_else(
                        || p.provides.iter().map(|s| s.to_string()).collect(),
                        |l| l.info.provides.clone(),
                    ),
                    loaded: loaded.is_some(),
                }
            })
            .collect()
    }

    /// Names of the packs loaded so far (for `explorer_coverage`'s `packs_loaded`).
    pub fn loaded_names(&self) -> Vec<String> {
        self.loaded.iter().map(|l| l.info.name.clone()).collect()
    }
}

fn unknown_pack(name: &str, producers: &[Producer]) -> String {
    if producers.is_empty() {
        format!("no pack called {name:?} in this build: it can install no packs yet")
    } else {
        let known: Vec<&str> = producers.iter().map(|p| p.name).collect();
        format!(
            "no pack called {name:?} in this build: it can install {}",
            known.join(", ")
        )
    }
}

/// The module's registry. The page is single-threaded; the mutex only keeps the global
/// sound (and native tests, which run on several threads, use their own [`Packs`]).
static GLOBAL: Mutex<Packs<'static>> = Mutex::new(Packs {
    producers: PRODUCERS,
    loaded: Vec::new(),
});

fn with_global<R>(f: impl FnOnce(&mut Packs<'static>) -> R) -> R {
    let mut guard = GLOBAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

/// Install a verified payload (EXPLORER_API "Packs": `install(name, payload)`).
pub fn install(name: &str, payload: &[u8]) -> Result<PackInfo, String> {
    with_global(|p| p.install(name, payload))
}

/// Parse, verify and install a pack file.
pub fn load(name: &str, file: &[u8]) -> Result<PackInfo, String> {
    with_global(|p| p.load(name, file))
}

/// The registry with what is loaded.
pub fn status() -> Vec<PackStatus> {
    with_global(|p| p.status())
}

/// Names of the packs loaded in this page session.
pub fn loaded_names() -> Vec<String> {
    with_global(|p| p.loaded_names())
}

// ---------------------------------------------------------------------------------
// WASM exports
// ---------------------------------------------------------------------------------

/// The packs this build can install, and which are loaded: `PackStatus[]`.
#[wasm_bindgen]
pub fn packs() -> Result<JsValue, JsValue> {
    to_js(&status())
}

/// Parse, verify and install a pack file (`bytes`: a `Uint8Array`), returning `PackInfo`.
/// Throws a string when the magic, format version, name or checksum is wrong, when this
/// build has no such pack, or when the producer rejects the data. Idempotent.
#[wasm_bindgen]
pub fn load_pack(name: &str, bytes: &[u8]) -> Result<JsValue, JsValue> {
    to_js(&load(name, bytes).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A test producer's payload: `version\0` then any bytes; "bad" is rejected.
    fn install_sample(payload: &[u8]) -> Result<PackInfo, String> {
        let end = payload
            .iter()
            .position(|b| *b == 0)
            .ok_or("no version in the sample payload")?;
        let version = std::str::from_utf8(&payload[..end]).map_err(|e| e.to_string())?;
        if version == "bad" {
            return Err("the sample data is bad".into());
        }
        Ok(PackInfo {
            name: "sample-pack".into(),
            version: version.into(),
            bytes: 0,
            provides: vec![],
        })
    }

    /// Installs of the "counted" pack; only `loading_the_same_pack_again_changes_nothing`
    /// uses that pack, so parallel tests cannot disturb the count.
    static COUNTED_INSTALLS: AtomicUsize = AtomicUsize::new(0);

    fn install_counted(_: &[u8]) -> Result<PackInfo, String> {
        COUNTED_INSTALLS.fetch_add(1, Ordering::SeqCst);
        Ok(PackInfo {
            name: "counted".into(),
            version: "1".into(),
            bytes: 0,
            provides: vec!["test:counted".into()],
        })
    }

    fn install_liar(_: &[u8]) -> Result<PackInfo, String> {
        Ok(PackInfo {
            name: "someone-else".into(),
            version: "1".into(),
            bytes: 0,
            provides: vec![],
        })
    }

    const TEST_PRODUCERS: &[Producer] = &[
        Producer {
            name: "sample-pack",
            label: "Sample",
            description: "A pack for tests",
            provides: &["test:sample"],
            install: install_sample,
        },
        Producer {
            name: "liar",
            label: "Liar",
            description: "Reports the wrong name",
            provides: &[],
            install: install_liar,
        },
        Producer {
            name: "counted",
            label: "Counted",
            description: "Counts its installs",
            provides: &[],
            install: install_counted,
        },
    ];

    fn sample(version: &str, rest: &[u8]) -> Vec<u8> {
        let mut payload = version.as_bytes().to_vec();
        payload.push(0);
        payload.extend_from_slice(rest);
        encode("sample-pack", &payload).unwrap()
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        // The catalogue check value of CRC-32/ISO-HDLC, and zlib.crc32(b"").
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
        assert_eq!(
            crc32(b"The quick brown fox jumps over the lazy dog"),
            0x414F_A339
        );
    }

    #[test]
    fn the_header_is_laid_out_as_documented() {
        let file = encode("ab", &[1, 2, 3]).unwrap();
        assert_eq!(&file[..8], b"SKYFIXPK");
        assert_eq!(&file[8..10], &[1, 0]); // format version 1, little-endian
        assert_eq!(&file[10..12], &[2, 0]); // name length
        assert_eq!(&file[12..14], b"ab");
        assert_eq!(&file[14..18], &[3, 0, 0, 0]); // payload length
        assert_eq!(&file[18..21], &[1, 2, 3]);
        assert_eq!(&file[21..25], &crc32(&[1, 2, 3]).to_le_bytes());
        assert_eq!(file.len(), 25);
        let h = parse(&file).unwrap();
        assert_eq!(
            (h.format_version, h.name, h.payload),
            (1, "ab", &[1u8, 2, 3][..])
        );
    }

    #[test]
    fn an_empty_payload_is_a_valid_pack() {
        let file = encode("empty", &[]).unwrap();
        assert_eq!(parse(&file).unwrap().payload, &[] as &[u8]);
    }

    #[test]
    fn parsing_never_assumes_alignment() {
        // The same pack at every offset inside a larger buffer (as a Uint8Array view onto
        // someone else's ArrayBuffer can be): read identically from each.
        let file = sample("2026-09-24", &[9; 13]);
        let mut buffer = vec![0u8; file.len() + 8];
        for offset in 0..8 {
            buffer[offset..offset + file.len()].copy_from_slice(&file);
            let h = parse(&buffer[offset..offset + file.len()]).unwrap();
            assert_eq!(h.name, "sample-pack");
            assert_eq!(h.payload.len(), 11 + 13);
        }
    }

    #[test]
    fn every_kind_of_bad_file_is_refused_with_its_own_sentence() {
        let good = sample("v1", b"data");
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (vec![], "does not start with SKYFIXPK"),
            (b"GIF89a..........".to_vec(), "does not start with SKYFIXPK"),
            (good[..10].to_vec(), "cut short"),
            (
                {
                    let mut f = good.clone();
                    f[8] = 2;
                    f
                },
                "format version 2",
            ),
            (
                {
                    let mut f = good.clone();
                    f[10] = 200; // a name longer than the file
                    f
                },
                "cut short",
            ),
            (good[..good.len() - 1].to_vec(), "cut short"),
            (
                {
                    let mut f = good.clone();
                    f.push(0);
                    f
                },
                "1 unexpected bytes after its checksum",
            ),
            (
                {
                    let mut f = good.clone();
                    let last = f.len() - 5;
                    f[last] ^= 0x40; // one bit of the payload flipped
                    f
                },
                "is damaged",
            ),
            (
                {
                    let mut f = good.clone();
                    f[12] = b'S'; // "Sample-pack"
                    f
                },
                "lowercase letters",
            ),
            (
                {
                    let mut f = good.clone();
                    f[12] = 0xFF;
                    f
                },
                "not valid UTF-8",
            ),
        ];
        for (file, words) in cases {
            let e = parse(&file).unwrap_err();
            assert!(e.contains(words), "expected {words:?} in {e:?}");
        }
    }

    #[test]
    fn names_are_checked_when_writing_too() {
        assert!(encode("", &[]).is_err());
        assert!(encode("Deep-time", &[]).is_err());
        assert!(encode("-x", &[]).is_err());
        assert!(encode(&"a".repeat(65), &[]).is_err());
        assert!(encode(&"a".repeat(64), &[]).is_ok());
        assert!(encode("deep-time", &[]).is_ok());
    }

    #[test]
    fn a_pack_loads_into_its_producer_and_shows_as_loaded() {
        let mut packs = Packs::new(TEST_PRODUCERS);
        let before = packs.status();
        assert_eq!(before.len(), 3);
        assert!(!before[0].loaded);
        assert_eq!(before[0].version, "");
        assert_eq!(before[0].provides, vec!["test:sample".to_string()]);

        let file = sample("2026-09-24", b"payload");
        let info = packs.load("sample-pack", &file).unwrap();
        assert_eq!(
            info,
            PackInfo {
                name: "sample-pack".into(),
                version: "2026-09-24".into(),
                bytes: file.len() as u64,
                provides: vec!["test:sample".into()],
            }
        );
        let after = packs.status();
        assert!(after[0].loaded);
        assert_eq!(after[0].version, "2026-09-24");
        assert_eq!(after[0].bytes, file.len() as u64);
        assert!(!after[1].loaded);
        assert_eq!(packs.loaded_names(), vec!["sample-pack".to_string()]);
    }

    #[test]
    fn loading_the_same_pack_again_changes_nothing() {
        let mut packs = Packs::new(TEST_PRODUCERS);
        let file = encode("counted", b"same bytes").unwrap();
        let first = packs.load("counted", &file).unwrap();
        let second = packs.load("counted", &file).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            COUNTED_INSTALLS.load(Ordering::SeqCst),
            1,
            "the installer ran twice"
        );
        assert_eq!(packs.loaded_names(), vec!["counted".to_string()]);
        // Different bytes for the same pack do run it again (a newer revision).
        packs
            .load("counted", &encode("counted", b"other bytes").unwrap())
            .unwrap();
        assert_eq!(COUNTED_INSTALLS.load(Ordering::SeqCst), 2);
        assert_eq!(packs.loaded_names().len(), 1);
    }

    #[test]
    fn a_newer_revision_replaces_the_older_one() {
        let mut packs = Packs::new(TEST_PRODUCERS);
        packs.load("sample-pack", &sample("old", b"1")).unwrap();
        packs.load("sample-pack", &sample("new", b"22")).unwrap();
        let s = packs.status();
        assert_eq!(s[0].version, "new");
        assert_eq!(packs.loaded_names(), vec!["sample-pack".to_string()]);
    }

    #[test]
    fn a_file_for_another_pack_or_an_unknown_pack_is_refused() {
        let mut packs = Packs::new(TEST_PRODUCERS);
        let e = packs.load("liar", &sample("v", b"")).unwrap_err();
        assert_eq!(e, "this file is the sample-pack pack, not the liar pack");
        let other = encode("tides-us", b"whatever").unwrap();
        let e = packs.load("tides-us", &other).unwrap_err();
        assert_eq!(
            e,
            "no pack called \"tides-us\" in this build: it can install sample-pack, liar, counted"
        );
        assert!(packs.loaded_names().is_empty());
    }

    #[test]
    fn a_producer_that_refuses_leaves_nothing_loaded() {
        let mut packs = Packs::new(TEST_PRODUCERS);
        let e = packs.load("sample-pack", &sample("bad", b"")).unwrap_err();
        assert_eq!(e, "the sample-pack pack: the sample data is bad");
        assert!(!packs.status()[0].loaded);
        let e = packs
            .load("liar", &encode("liar", b"anything").unwrap())
            .unwrap_err();
        assert!(e.contains("reported itself as \"someone-else\""), "{e}");
        assert!(packs.loaded_names().is_empty());
    }

    #[test]
    fn install_takes_a_payload_whose_header_was_already_read() {
        let mut packs = Packs::new(TEST_PRODUCERS);
        let info = packs.install("sample-pack", b"v9\0rest").unwrap();
        assert_eq!(info.version, "v9");
        assert_eq!(
            info.bytes as usize,
            encode("sample-pack", b"v9\0rest").unwrap().len()
        );
    }

    #[test]
    fn this_build_knows_no_packs_yet_and_says_so() {
        // Producers add entries to PRODUCERS; until then the module's registry is empty
        // and every name is refused with a sentence that says why.
        let known: Vec<&str> = PRODUCERS.iter().map(|p| p.name).collect();
        if known.is_empty() {
            assert!(status().is_empty());
            let e = load("deep-time", &encode("deep-time", b"").unwrap()).unwrap_err();
            assert_eq!(
                e,
                "no pack called \"deep-time\" in this build: it can install no packs yet"
            );
        }
        for p in PRODUCERS {
            assert!(valid_name(p.name), "{}", p.name);
            assert!(
                !p.label.is_empty() && !p.description.is_empty(),
                "{}",
                p.name
            );
        }
        let mut names = known.clone();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), known.len(), "a pack name is registered twice");
    }

    /// Every pack committed to the site (`web/public/data/packs/<name>-<rev>.bin`, with its
    /// `<name>.json` sidecar) must install into this build: a producer that changes its
    /// payload format without regenerating its pack fails here, not in someone's browser.
    #[test]
    fn every_pack_committed_to_the_site_installs() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/public/data/packs");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return; // no packs directory: nothing committed yet
        };
        let mut packs = Packs::new(PRODUCERS);
        let files: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        for sidecar in files.iter().filter(|f| f.ends_with(".json")) {
            let name = sidecar.trim_end_matches(".json");
            let bins: Vec<&String> = files
                .iter()
                .filter(|f| {
                    f.ends_with(".bin")
                        && f.strip_prefix(name)
                            .and_then(|rest| rest.strip_prefix('-'))
                            .is_some_and(|rev| {
                                rev.len() == 20 && rev[..16].bytes().all(|c| c.is_ascii_hexdigit())
                            })
                })
                .collect();
            assert_eq!(
                bins.len(),
                1,
                "{name}: expected one {name}-<rev>.bin, found {bins:?}"
            );
            let bytes = std::fs::read(dir.join(bins[0])).unwrap();
            packs
                .load(name, &bytes)
                .unwrap_or_else(|e| panic!("{}: {e}", bins[0]));
        }
    }
}
