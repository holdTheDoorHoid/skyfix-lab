"""Download the raw inputs of the star field. Development-time only.

    python3 -m tools.starfield.fetch

Run from the repository root. Needs network; uses only the Python standard library.
Writes into `tools/starfield/data/` (git-ignored):

* `bsc5p.txt` — NASA HEASARC's `bsc5p` table (the Yale Bright Star Catalogue, 5th
  revised edition, preliminary version, as served by HEASARC), every row, the columns
  listed in `BSC5P_COLUMNS`, from HEASARC's TAP service in its `text/plain` format.
* `bound_18.dat` — the IAU constellation boundaries of Delporte (1930) in the equator
  and equinox of B1875.0, as transcribed by Davenhall & Leggett (1989).
* `datagov_harvest_record.json` — the data.gov catalogue record for `bsc5p`, which
  carries the licence statement (`"license": "https://www.usa.gov/government-works"`).
* `provenance.json` — URL, retrieval time, size and SHA-256 of each file above.

Nothing here is a runtime dependency: the Rust crate embeds only what
`tools/starfield/build.py` derives from these files. See docs/THIRD_PARTY.md, section
"Star field and constellations".
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

TAP_SYNC = "https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync"

#: The columns we keep. `cra`/`cdec` are the catalogue's own sexagesimal J2000
#: position strings (RA to 0.1 s of time, Dec to 1 arcsec); `ra`/`dec` are HEASARC's
#: decimal-degree copies, which the text/plain format rounds to 4 decimals, so they
#: are used only as a cross-check of the sexagesimal parsing.
BSC5P_COLUMNS = [
    "hr", "name", "alt_name", "cra", "cdec", "ra", "dec",
    "vmag", "vmag_uncert", "vmag_code", "bv_color", "bv_uncert",
    "pmra", "pmdec", "parallax", "par_code", "radvel",
    "var_id", "multiple", "m_cnt", "m_id", "m_sep", "m_mdiff",
    "hd", "spect_type", "note",
]

BSC5P_QUERY = "SELECT %s FROM bsc5p ORDER BY hr" % ", ".join(BSC5P_COLUMNS)

BSC5P_URL = TAP_SYNC + "?" + urllib.parse.urlencode(
    {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "text/plain",
        "MAXREC": "20000",
        "QUERY": BSC5P_QUERY,
    }
)

BOUNDARIES_URL = "https://cdsarc.cds.unistra.fr/ftp/cats/VI/49/bound_18.dat"

DATAGOV_PAGE = "https://catalog.data.gov/dataset/bright-star-catalog"
DATAGOV_RECORD_URL = (
    "https://catalog.data.gov/harvest_record/1e27ef96-47f7-4dfb-9271-2e4f04ffa57f/raw"
)

FILES = [
    ("bsc5p.txt", BSC5P_URL),
    ("bound_18.dat", BOUNDARIES_URL),
    ("datagov_harvest_record.json", DATAGOV_RECORD_URL),
]


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "skyfix-lab-starfield/1 (python)"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    os.makedirs(DATA, exist_ok=True)
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {"retrieved_utc": now, "files": {}}
    for name, url in FILES:
        data = _get(url)
        with open(os.path.join(DATA, name), "wb") as f:
            f.write(data)
        record["files"][name] = {"url": url, "size_bytes": len(data), "sha256": sha256(data)}
        print("fetched %-30s %9d bytes  %s" % (name, len(data), sha256(data)[:16]))
    record["bsc5p_query"] = BSC5P_QUERY
    record["datagov_page"] = DATAGOV_PAGE
    lic = json.loads(open(os.path.join(DATA, "datagov_harvest_record.json"), "rb").read())
    record["datagov_license"] = lic.get("license")
    record["datagov_identifier"] = lic.get("identifier")
    record["datagov_publisher"] = (lic.get("publisher") or {}).get("name")
    record["datagov_modified"] = lic.get("modified")
    with open(os.path.join(DATA, "provenance.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, sort_keys=True)
        f.write("\n")
    if record["datagov_license"] != "https://www.usa.gov/government-works":
        print("!! data.gov licence field is %r, not U.S. Government Works: STOP and ask the "
              "owner before using this table" % (record["datagov_license"],))
        return 2
    print("licence (data.gov):", record["datagov_license"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
