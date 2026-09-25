"""Build the `tides-us` pack from the cached NOAA records. Development-time only.

    python3 -m tools.tides.build            # from the repository root, after fetch.py

Reads `tools/tides/cache/` (never the network) and `tools/tides/noaa_differs.json` (the
stations the sweep found NOAA's own predictions to differ at; see the README), and
writes:

* `web/public/data/packs/tides-us-<rev>.bin`, rev = the first 16 hex digits of the
  file's SHA-256 (older `tides-us-*.bin` files are removed);
* `web/public/data/packs/tides-us.json`, the sidecar the packs plugin reads.

The binary layout is documented in `crates/skyfix-tides/src/pack.rs` and
`docs/EXPLORER_API.md` ("Tides"); the Rust decoder is the reference, and
`crates/skyfix-tides/tests/pack_real.rs` re-encodes the shipped file byte for byte.

Processing (recorded in docs/THIRD_PARTY.md):

* every station of NOAA's tide-prediction list, sorted by id;
* names as NOAA's list gives them, with words set entirely in capitals (the printed tide
  tables' convention for reference stations) put in title case, except acronyms;
* harmonic constants: amplitudes rounded to the millimetre and Greenwich phases to
  0.01° (NOAA publishes 1 mm and 0.1°, so nothing is lost); constituents of zero
  amplitude dropped;
* datums: MHHW, MHW, MTL, MLW, MLLW, LAT, HAT and NAVD88 relative to MSL, to the
  millimetre, from NOAA's datum records (all relative to the station datum);
* subordinate stations: NOAA's time differences (minutes); ratio height differences
  (x 1000) or additive ones, which NOAA serves in feet, converted to millimetres.
"""

from __future__ import annotations

import datetime as _dt
import glob
import hashlib
import json
import os
import re
import struct
import sys
import zlib

from . import noaa
from .fetch import LIST_KEY, station_key

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(REPO, "web", "public", "data", "packs")
DIFFERS = os.path.join(HERE, "noaa_differs.json")

PACK_NAME = "tides-us"
#: As in the core's pack registry (crates/skyfix-wasm/src/packs.rs, PRODUCERS).
LABEL = "US tides"
DESCRIPTION = "Tide predictions for NOAA's tide stations, mostly in the United States"

#: Mirrors `CONSTITUENTS` in crates/skyfix-tides/src/schureman.rs: NOAA's 37 standard
#: constituents in NOAA's numbering, then its extended set (Anchorage). The decoder maps
#: by name, so only the membership must agree; the Rust tests check it.
STANDARD = ("M2 S2 N2 K1 M4 O1 M6 MK3 S4 MN4 NU2 S6 MU2 2N2 OO1 LAM2 S1 M1 J1 MM SSA SA MSF "
            "MF RHO Q1 T2 R2 2Q1 P1 2SM2 M3 L2 2MK3 K2 M8 MS4").split()
EXTENDED = ("SIGMA1 MP1 CHI1 2PO1 SO1 MSN2 MNS2 OP2 MKS2 2NS2 MLN2S2 2ML2S2 SKM2 2MS2K2 "
            "MKL2S2 M2KS2 2SNMK2 2KMSN2 SO3 SK3 NO3 MK4 SN4 2MLS4 3MS4 ML4 N4 SL4 MNO5 2MO5 "
            "2MK5 MSK5 3KM5 2MP5 3MP5 MNK5 2SM6 2MN6 MSN6 2MS6 2NMLS6 2NM6 MSL6 2ML6 MSK6 "
            "2MLNS6 3MLS6 2MK6 2MNO7 2NMK7 2MSO7 MSKO7 2MSN8 3MS8 2MS8 2MN8 3MN8 2MSL8 "
            "4MLS8 3ML8 3MK8 2MSK8 2M2NK9 3MNK9 4MK9 3MSK9 4MN10 M10 3MNS10 4MS10 3MSL10 "
            "3M2S10 4MSK11 4MNS12 5MS12 4MSL12 4M2S12 TK1 RP1 KP1 THETA1 KJ2 OO2").split()
NAMES = STANDARD + EXTENDED
INDEX = {n: k for k, n in enumerate(NAMES)}

#: The datums the pack stores, in the pack's order (relative to MSL).
DATUMS = ["MHHW", "MHW", "MTL", "MLW", "MLLW", "LAT", "HAT", "NAVD88"]
DATUM_MISSING = -32768

# Flag bits (crates/skyfix-tides/src/db.rs, `flags`).
NOAA_DIFFERS = 1
NO_DATUMS = 2
NO_CONSTANTS = 4
REFERENCE_UNUSABLE = 8
NON_NAVIGATIONAL = 16

FEET = 0.3048

#: Words written in capitals that stay so.
ACRONYMS = {"ICWW", "USCG", "NERR", "NOAA", "CBBT", "ICW", "AFB", "GPS", "PGA", "HVN", "HBR",
            "NAB", "MSF", "USN", "NAS", "LORAN"}


def tidy_name(name: str) -> str:
    def fix(m: re.Match) -> str:
        w = m.group(0)
        if w in ACRONYMS or len(w) < 3:
            return w
        return w[0] + w[1:].lower()
    name = re.sub(r"\b[A-Z][A-Z']+\b(?!\.)", fix, name)
    return re.sub(r"\bST\.", "St.", name)


def str8(s: str) -> bytes:
    b = s.encode("utf-8")
    if len(b) > 255:
        raise SystemExit("string too long: %r" % s)
    return bytes([len(b)]) + b


def micro(deg: float) -> int:
    return int(round(deg * 1e6))


def datums_rel_msl(rec: dict):
    dat = rec.get("datums") or {}
    vals = {d["name"]: d["value"] for d in (dat.get("datums") or []) if d.get("value") is not None}
    if dat.get("LAT") is not None:
        vals["LAT"] = dat["LAT"]
    if dat.get("HAT") is not None:
        vals["HAT"] = dat["HAT"]
    if dat.get("units") not in (None, "meters"):
        raise SystemExit("datums not in metres for %s" % rec["id"])
    if "MSL" not in vals:
        return None
    out = []
    for d in DATUMS:
        if d in vals:
            mm = int(round((vals[d] - vals["MSL"]) * 1000))
            if not -32767 <= mm <= 32767:
                print("  %s: %s - MSL = %d mm does not fit; dropped" % (rec["id"], d, mm))
                mm = DATUM_MISSING
            out.append(mm)
        else:
            out.append(DATUM_MISSING)
    return out


def constants(rec: dict):
    hc = rec.get("harmonicConstituents") or {}
    if hc.get("units") not in (None, "meters"):
        raise SystemExit("constants not in metres for %s" % rec["id"])
    terms = []
    for c in hc.get("HarmonicConstituents") or []:
        if c["amplitude"] == 0:
            continue
        if c["name"] not in INDEX:
            raise SystemExit("station %s: constituent %s is not in the table (add it to "
                             "schureman.rs and here)" % (rec["id"], c["name"]))
        amp = int(round(c["amplitude"] * 1000))
        ph = int(round((c["phase_GMT"] % 360.0) * 100)) % 36000
        terms.append((INDEX[c["name"]], amp, ph))
    return sorted(terms)


def main() -> int:
    client = noaa.Client(offline=True)
    listing = client.read(LIST_KEY)["stations"]
    listing = sorted(listing, key=lambda s: s["id"])
    index = {s["id"]: k for k, s in enumerate(listing)}
    differs = {}
    if os.path.exists(DIFFERS):
        with open(DIFFERS, encoding="utf-8") as f:
            differs = json.load(f)["stations"]
    retrieved = [client.manifest[LIST_KEY]["retrieved_utc"]]

    records = {}
    for s in listing:
        if s["type"] == "R":
            records[s["id"]] = client.read(station_key(s["id"]))["stations"][0]
            retrieved.append(client.manifest[station_key(s["id"])]["retrieved_utc"])

    def usable_reference(ref_id: str) -> bool:
        rec = records.get(ref_id)
        if rec is None:
            return False
        d = datums_rel_msl(rec)
        return bool(constants(rec)) and d is not None and d[DATUMS.index("MLLW")] != DATUM_MISSING

    body = bytearray()
    counts = {"harmonic": 0, "subordinate": 0, "flags": {}}
    for s in listing:
        sid = s["id"]
        flags = 0
        if sid in differs:
            flags |= NOAA_DIFFERS
        rec = records.get(sid)
        if rec is not None and rec.get("nonNavigational"):
            flags |= NON_NAVIGATIONAL
        head = (str8(sid) + str8(tidy_name(s["name"])) + str8(s.get("state") or "")
                + struct.pack("<ii", micro(s["lat"]), micro(s["lng"])))
        if s["type"] == "R":
            counts["harmonic"] += 1
            d = datums_rel_msl(rec)
            terms = constants(rec)
            if d is None:
                flags |= NO_DATUMS
                d = [DATUM_MISSING] * len(DATUMS)
            if not terms:
                flags |= NO_CONSTANTS
            rec_bytes = bytearray(head + bytes([0, flags]) + struct.pack("<8h", *d))
            bits = bytearray(5)
            standard = [t for t in terms if t[0] < len(STANDARD)]
            extra = [t for t in terms if t[0] >= len(STANDARD)]
            for k, _, _ in standard:
                bits[k // 8] |= 1 << (k % 8)
            rec_bytes += bits
            for _, amp, ph in standard:
                rec_bytes += struct.pack("<HH", amp, ph)
            rec_bytes += bytes([len(extra)])
            for k, amp, ph in extra:
                rec_bytes += struct.pack("<BHH", k, amp, ph)
            body += rec_bytes
        else:
            counts["subordinate"] += 1
            off = s["tidepredoffsets"]
            ref = off["refStationId"]
            if ref not in index or listing[index[ref]]["type"] != "R" or not usable_reference(ref):
                flags |= REFERENCE_UNUSABLE
            # A reference outside the list or not harmonic still needs a valid index for
            # the decoder: point at the station itself only if it is harmonic, else at
            # the first harmonic station (the flag makes it unusable either way).
            if ref in index and listing[index[ref]]["type"] == "R":
                ref_index = index[ref]
            else:
                ref_index = next(k for k, x in enumerate(listing) if x["type"] == "R")
            kind = off["heightAdjustedType"]
            if kind == "R":
                ht, hi, lo = 0, off["heightOffsetHighTide"] * 1000, off["heightOffsetLowTide"] * 1000
            elif kind == "F":
                ht = 1
                hi = off["heightOffsetHighTide"] * FEET * 1000
                lo = off["heightOffsetLowTide"] * FEET * 1000
            else:
                raise SystemExit("station %s: height type %r" % (sid, kind))
            body += head + bytes([1, flags]) + struct.pack(
                "<HhhBhh", ref_index, off["timeOffsetHighTide"], off["timeOffsetLowTide"], ht,
                int(round(hi)), int(round(lo)))
        for bit, name in ((NOAA_DIFFERS, "noaa_differs"), (NO_DATUMS, "no_datums"),
                          (NO_CONSTANTS, "no_constants"), (REFERENCE_UNUSABLE,
                                                           "reference_unusable"),
                          (NON_NAVIGATIONAL, "non_navigational")):
            if flags & bit:
                counts["flags"][name] = counts["flags"].get(name, 0) + 1

    version = max(retrieved)[:10]
    payload = bytearray(b"TIDE" + struct.pack("<H", 1) + str8(version))
    payload += bytes([len(NAMES)]) + b"".join(str8(n) for n in NAMES)
    payload += bytes([len(STANDARD)]) + struct.pack("<I", len(listing)) + body
    payload = bytes(payload)
    name = PACK_NAME.encode()
    blob = (b"SKYFIXPK" + struct.pack("<HH", 1, len(name)) + name
            + struct.pack("<I", len(payload)) + payload
            + struct.pack("<I", zlib.crc32(payload) & 0xFFFFFFFF))
    sha = hashlib.sha256(blob).hexdigest()
    rev = sha[:16]
    os.makedirs(OUT_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUT_DIR, PACK_NAME + "-*.bin")):
        os.remove(old)
    fname = "%s-%s.bin" % (PACK_NAME, rev)
    with open(os.path.join(OUT_DIR, fname), "wb") as f:
        f.write(blob)
    gz = len(zlib.compress(blob, 9))
    sidecar = {
        "name": PACK_NAME,
        "version": version,
        "rev": rev,
        "file": fname,
        "bytes": len(blob),
        "sha256": sha,
        "label": LABEL,
        "description": DESCRIPTION,
        "provides": ["tides:us"],
        "stations": {"harmonic": counts["harmonic"], "subordinate": counts["subordinate"],
                     "flags": counts["flags"]},
        "source": "NOAA CO-OPS (tidesandcurrents.noaa.gov), retrieved %s to %s; public "
                  "domain (U.S. Government work). See docs/THIRD_PARTY.md." % (
                      min(retrieved)[:10], version),
        "built_by": "tools/tides/build.py",
    }
    with open(os.path.join(OUT_DIR, PACK_NAME + ".json"), "w", encoding="utf-8") as f:
        json.dump(sidecar, f, indent=2)
        f.write("\n")
    print("wrote web/public/data/packs/%s: %d bytes (%d deflated), %d stations "
          "(%d harmonic, %d subordinate), flags %s" % (
              fname, len(blob), gz, len(listing), counts["harmonic"], counts["subordinate"],
              counts["flags"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
