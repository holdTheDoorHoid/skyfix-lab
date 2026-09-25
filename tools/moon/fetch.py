"""Download the approved lunar names this project picks from. Development-time only.

    python3 -m tools.moon.fetch

Run from the repository root. Needs network; uses only the Python standard library.
Writes into `tools/moon/data/` (git-ignored):

* `usgs_<type>.html` — the USGS/IAU Gazetteer of Planetary Nomenclature's search result
  page for the approved Moon features of one feature type (target `16_Moon`, approval
  status `5_Adopted by IAU`). The site offers no server-side CSV: its "CSV" button
  exports the HTML table in the browser, so the page itself is the raw download, and
  `tools/moon/build.py` reads the same table cells that button would export.
* `usgs_copyrights.html` — the USGS page stating the terms (quoted in
  `docs/THIRD_PARTY.md`).
* `provenance.json` — URL, form fields, retrieval time, size and SHA-256 of each file.

The gazetteer's coordinates are planetocentric, east-positive, in the Moon's mean
Earth/polar axis frame (the LOLA 2011 control network), with about 0.01 deg precision;
see docs/THIRD_PARTY.md, "Named lunar features". Nothing here is a runtime dependency:
the Rust crate embeds only the ~150-row table `tools/moon/build.py` derives.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

SEARCH_URL = "https://planetarynames.wr.usgs.gov/SearchResults"
TERMS_URL = "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits"

#: The feature types the picks come from, as the search form names them.
FEATURE_TYPES = [
    "25_Mare, maria",
    "28_Oceanus, oceani",
    "19_Lacus, lacūs",
    "40_Sinus, sinūs",
    "29_Palus, paludes",
    "27_Mons, montes",
    "38_Rupes, rupēs",
    "37_Rima, rimae",
    "46_Vallis, valles",
    "34_Promontorium, promontoria",
    "10_Dorsum, dorsa",
    "1_Albedo Feature",
    "59_Statio",
    "20_Astronaut-named features",
    "9_Crater, craters",
]


def slug(feature_type: str) -> str:
    code, name = feature_type.split("_", 1)
    word = name.split(",")[0].strip().lower().replace(" ", "-")
    return "%s_%s" % (code, word)


def _post(url: str, fields: dict) -> bytes:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": "skyfix-lab-moon/1 (python)",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "skyfix-lab-moon/1 (python)"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def page_text(raw: bytes) -> str:
    """The visible text of an HTML page: tags dropped, entities decoded, spaces folded."""
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", text).replace(" .", ".")


def main() -> int:
    os.makedirs(DATA, exist_ok=True)
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {"retrieved_utc": now, "search_url": SEARCH_URL, "files": {}}
    for ft in FEATURE_TYPES:
        fields = {
            "Target": "16_Moon",
            "Feature Type": ft,
            "Approval Status": "5_Adopted by IAU",
        }
        data = _post(SEARCH_URL, fields)
        name = "usgs_%s.html" % slug(ft)
        with open(os.path.join(DATA, name), "wb") as f:
            f.write(data)
        record["files"][name] = {
            "method": "POST",
            "url": SEARCH_URL,
            "form": fields,
            "size_bytes": len(data),
            "sha256": sha256(data),
        }
        print("fetched %-34s %9d bytes  %s" % (name, len(data), sha256(data)[:16]))
    terms = _get(TERMS_URL)
    with open(os.path.join(DATA, "usgs_copyrights.html"), "wb") as f:
        f.write(terms)
    record["files"]["usgs_copyrights.html"] = {
        "method": "GET",
        "url": TERMS_URL,
        "size_bytes": len(terms),
        "sha256": sha256(terms),
    }
    phrase = "considered to be in the U.S. Public Domain"
    record["terms_phrase_found"] = phrase in page_text(terms)
    with open(os.path.join(DATA, "provenance.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    if not record["terms_phrase_found"]:
        print("!! the USGS terms page no longer says %r: STOP and re-read the terms "
              "before using this table" % phrase)
        return 2
    print("terms: USGS-authored data 'considered to be in the U.S. Public Domain'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
