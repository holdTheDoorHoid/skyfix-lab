"""Build the optional `lunar-limb` data pack. Development-time only.

    python3 -m tools.limb.fetch     # once: LDEM_16 into tools/limb/data/ (33 MB)
    tools/reference/.venv/bin/python -m tools.limb.build

Run from the repository root (needs numpy). Reads LDEM_16 and its label, resamples the
heights onto the limb ring of `tools/limb/ring.py`, checks the byte code decodes back
exactly, and writes

* `web/public/data/packs/lunar-limb-<rev>.bin` - the pack: the common header of
  docs/EXPLORER_API.md "Packs" (magic SKYFIXPK, format 1, the name, the payload, its
  CRC-32) around the payload below; rev = the first 16 hex digits of the file's SHA-256;
  an older lunar-limb-*.bin is removed;
* `web/public/data/packs/lunar-limb.json` - its sidecar (name, version, bytes, label,
  description, provides, and the facts below for people).

Payload, format 1 (little-endian; `str8` is a u8 length then UTF-8 bytes):

    "LIMB"        4 bytes
    u16           payload format (1)
    str8          data version (VERSION below)
    str8          source (the LOLA product)
    f64           reference radius, km (1737.4: LOLA's sphere; heights are above it)
    f64           height quantum, m (5)
    f64           grid step, degrees (1/16)
    f64           delta_min, degrees (-12: the ring's lower edge; node i is at
                  delta_min + (i + 1/2) step, node j at alpha = (j + 1/2) step)
    u16           n_alpha (5760 = 360 deg / step)
    u16           n_delta (384)
    u32           body length, bytes
    body          the byte code of tools/limb/ring.py (planar-prediction residuals)

The build is deterministic: the same LDEM_16 gives the same bytes (VERSION is fixed and
changes only with the ring or its code).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import struct
import sys
import time
import zlib

import numpy as np

from . import ring

REPO = os.path.dirname(os.path.dirname(ring.HERE))
PACKS = os.path.join(REPO, "web", "public", "data", "packs")
NAME = "lunar-limb"
VERSION = "2026-09-25"
LABEL = "Lunar limb"
DESCRIPTION = (
    "The mountains and valleys at the Moon's edge, for eclipse contact times and "
    "Baily's beads"
)
PROVIDES = ["eclipses:lunar-limb"]
PAYLOAD_FORMAT = 1


def str8(s: str) -> bytes:
    b = s.encode("utf-8")
    if len(b) > 255:
        raise SystemExit("str8 too long: %r" % s)
    return bytes([len(b)]) + b


def payload(body: bytes, source: str) -> bytes:
    head = b"LIMB" + struct.pack("<H", PAYLOAD_FORMAT) + str8(VERSION) + str8(source)
    head += struct.pack(
        "<ddddHHI",
        ring.REFERENCE_RADIUS_KM,
        ring.QUANTUM_M,
        ring.STEP_DEG,
        -ring.DELTA_HALF_DEG,
        ring.N_ALPHA,
        ring.N_DELTA,
        len(body),
    )
    return head + body


def pack_file(name: str, data: bytes) -> bytes:
    """The common pack header (docs/EXPLORER_API.md, "Packs")."""
    nb = name.encode("utf-8")
    return (
        b"SKYFIXPK"
        + struct.pack("<HH", 1, len(nb))
        + nb
        + struct.pack("<I", len(data))
        + data
        + struct.pack("<I", zlib.crc32(data) & 0xFFFFFFFF)
    )


def main() -> int:
    t0 = time.time()
    label = ring.check_label()
    source = "LRO LOLA %s %s (%s), NASA PDS Geosciences Node" % (
        label["PRODUCT_ID"],
        label["PRODUCT_VERSION_ID"],
        label["DATA_SET_ID"],
    )
    dem = ring.read_dem()
    heights = ring.resample(dem)
    q = ring.quantise(heights)
    body = ring.encode(q)
    back = ring.decode(body)
    if not np.array_equal(back, q):
        raise SystemExit("the byte code does not decode back to the ring")
    err = np.abs(q * ring.QUANTUM_M - heights).max()
    data = payload(body, source)
    blob = pack_file(NAME, data)
    rev = hashlib.sha256(blob).hexdigest()[:16]
    os.makedirs(PACKS, exist_ok=True)
    for old in os.listdir(PACKS):
        if old.startswith(NAME + "-") and old.endswith(".bin"):
            os.remove(os.path.join(PACKS, old))
    fname = "%s-%s.bin" % (NAME, rev)
    with open(os.path.join(PACKS, fname), "wb") as f:
        f.write(blob)
    gz = len(gzip.compress(blob, 9))
    sidecar = {
        "name": NAME,
        "version": VERSION,
        "bytes": len(blob),
        "label": LABEL,
        "description": DESCRIPTION,
        "provides": PROVIDES,
        "rev": rev,
        "file": fname,
        "sha256": hashlib.sha256(blob).hexdigest(),
        "gzip_bytes": gz,
        "source": source + "; U.S. Government work, no reuse restriction; cited in docs/THIRD_PARTY.md",
        "ring": {
            "reference_radius_km": ring.REFERENCE_RADIUS_KM,
            "step_deg": ring.STEP_DEG,
            "n_alpha": ring.N_ALPHA,
            "n_delta": ring.N_DELTA,
            "delta_range_deg": [-ring.DELTA_HALF_DEG, ring.DELTA_HALF_DEG],
            "height_quantum_m": ring.QUANTUM_M,
            "escapes": int(np.sum(np.abs(q - ring.predictions(q)) > 127)),
            "height_range_m": [float(q.min() * ring.QUANTUM_M), float(q.max() * ring.QUANTUM_M)],
            "max_rounding_m": round(float(err), 3),
        },
        "built_by": "tools/limb/build.py",
    }
    with open(os.path.join(PACKS, NAME + ".json"), "w", encoding="utf-8") as f:
        json.dump(sidecar, f, indent=2)
        f.write("\n")
    print(
        "%s: %d bytes (%.2f MB), gzip %d bytes (%.2f MB); %d escapes; heights %.0f..%.0f m; "
        "%.1f s"
        % (
            fname,
            len(blob),
            len(blob) / 1e6,
            gz,
            gz / 1e6,
            sidecar["ring"]["escapes"],
            sidecar["ring"]["height_range_m"][0],
            sidecar["ring"]["height_range_m"][1],
            time.time() - t0,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
