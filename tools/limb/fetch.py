"""Download the lunar topography the `lunar-limb` pack is built from. Development-time only.

    python3 -m tools.limb.fetch

Run from the repository root. Needs network; standard library only. Writes into
`tools/limb/data/` (git-ignored, never committed):

* `ldem_16.img` - LRO LOLA gridded topography, LDEM_16 (16 pixels per degree, about
  1.9 km; 33 177 600 bytes): 2880 lines x 5760 samples of little-endian int16, height
  above the 1737.4 km reference sphere = DN x 0.5 m, simple cylindrical, pixel-registered
  (line 0 at latitude 89.96875 N, sample 0 at east longitude 0.03125), in the
  "MEAN EARTH/POLAR AXIS OF DE421" frame. NASA Planetary Data System, Geosciences Node,
  data set LRO-L-LOLA-4-GDR-V1.0 (product version V3.1).
* `ldem_16.lbl` - its PDS3 label, which `tools/limb/ring.py` reads and checks before
  trusting the layout above.
* `provenance.json` - URL, size, SHA-256 and retrieval time of each file.

The download was approved for this project on 2026-09-25 (33 MB). NASA mission data in
the PDS carry no reuse restriction; the PDS asks that publications cite the product (see
docs/THIRD_PARTY.md, "Lunar limb profile"). Nothing here is a runtime dependency: the
site ships only the resampled ring that `tools/limb/build.py` writes.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

BASE = (
    "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/"
    "data/lola_gdr/cylindrical/img/"
)
FILES = {
    "ldem_16.lbl": None,
    # The size the PDS lists; a different size means a different product: stop.
    "ldem_16.img": 33_177_600,
}


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download(url: str, path: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "skyfix-lab-limb/1 (python)"})
    tmp = path + ".part"
    with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
        while True:
            block = r.read(1 << 20)
            if not block:
                break
            f.write(block)
    os.replace(tmp, path)


def main() -> int:
    os.makedirs(DATA, exist_ok=True)
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {"retrieved_utc": now, "base_url": BASE, "files": {}}
    for name, size in FILES.items():
        path = os.path.join(DATA, name)
        if not os.path.exists(path) or (size is not None and os.path.getsize(path) != size):
            print("downloading %s ..." % name)
            download(BASE + name, path)
        got = os.path.getsize(path)
        if size is not None and got != size:
            print("!! %s is %d bytes, the PDS lists %d: not the product this pack was "
                  "built from" % (name, got, size))
            return 2
        record["files"][name] = {"url": BASE + name, "size_bytes": got, "sha256": sha256_of(path)}
        print("%-12s %10d bytes  sha256 %s" % (name, got, record["files"][name]["sha256"]))
    with open(os.path.join(DATA, "provenance.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, sort_keys=True)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
