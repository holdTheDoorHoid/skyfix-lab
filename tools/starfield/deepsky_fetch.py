"""Download the raw inputs of the deep-sky data. Development-time only.

    python3 -m tools.starfield.deepsky_fetch [static|wikidata|crosscheck ...]

Run from the repository root. Needs network; uses only the Python standard library.
Writes into `tools/starfield/data/deepsky/` (git-ignored), and records the URL, query,
retrieval time, size and SHA-256 of every file in `provenance.json` beside them.
With no argument every stage runs, in order.

Stages:

* `static` — files fetched as they are:
  - the IAU Meteor Data Center's list of established showers (MDC 2022, updated
    2026-09-21) and the International Meteor Organization's 2026 and 2027 meteor
    shower calendars (the 2026 one from the Internet Archive, because imo.net is being
    rebuilt and serves only the 2027 file);
  - the IAU Working Group on Star Names catalogue: the live table on exopla.net and
    the 2022 text file;
  - NASA LAMBDA's COBE/DIRBE Zodi-Subtracted Mission Average maps at 1.25 um (band
    1A) and 100 um (band 8), and the DIRBE sky-map pixel-centre coordinates.
* `wikidata` — SPARQL queries (CC0 data): the 110 Messier objects and every NGC/IC
  object and other item `tools/starfield/dso_objects.txt` lists, with their J2000
  positions and magnitudes.
* `crosscheck` — the independent references for the objects this project lists
  (`tools/starfield/dso_objects.txt`): SIMBAD (CDS) positions, magnitudes and sizes
  by TAP, Corwin's NGC/IC mean positions (VizieR VII/239A), and the integrated
  magnitudes of Harris's globular-cluster catalogue and of RC3, both from NASA
  HEASARC's TAP service.

Nothing here is a runtime dependency: the Rust crate embeds only what the build
scripts (`dso.py`, `showers.py`, `milkyway.py`, `wgsn.py`) derive from these files.
Provenance and licences: docs/THIRD_PARTY.md, section "Deep sky".
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "deepsky")
PROVENANCE = os.path.join(DATA, "provenance.json")
OBJECTS = os.path.join(HERE, "dso_objects.txt")

USER_AGENT = (
    "skyfix-lab-deepsky/1 (development-time data build; "
    "https://github.com/holdTheDoorHoid/skyfix-lab)"
)

STATIC = [
    ("iau_mdc_established_2026.txt",
     "https://www.ta3.sk/IAUC22DB/MDC2022/Etc/streamestablisheddata2026.txt"),
    ("imo_calendar_2027.pdf", "https://www.imo.net/ShCal27s.pdf"),
    ("imo_calendar_2026.pdf",
     "http://web.archive.org/web/20260308033848id_/https://imo.net/files/meteor-shower/cal2026.pdf"),
    ("wgsn_exopla.html", "https://exopla.net/star-names/modern-iau-star-names/"),
    ("wgsn_iau_csn_2022.txt", "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt"),
    ("DIRBE_BAND1A_ZSMA.FITS",
     "https://lambda.gsfc.nasa.gov/data/cobe/dirbe/zsma/DIRBE_BAND1A_ZSMA.FITS"),
    ("DIRBE_BAND08_ZSMA.FITS",
     "https://lambda.gsfc.nasa.gov/data/cobe/dirbe/zsma/DIRBE_BAND08_ZSMA.FITS"),
    ("DIRBE_SKYMAP_INFO.FITS",
     "https://lambda.gsfc.nasa.gov/data/cobe/dirbe/ancil/skyinfo/DIRBE_SKYMAP_INFO.FITS"),
]

SPARQL = "https://query.wikidata.org/sparql"
#: V band (Q4892529); Messier (Q14530), NGC (Q14534) and IC (Q741672) catalogues.
Q_MESSIER = """
SELECT ?item ?code ?ra ?dec ?mag ?band ?label WHERE {
  ?item p:P528 ?st . ?st ps:P528 ?code ; pq:P972 wd:Q14530 .
  OPTIONAL { ?item wdt:P6257 ?ra . }
  OPTIONAL { ?item wdt:P6258 ?dec . }
  OPTIONAL { ?item p:P1215 ?ms . ?ms ps:P1215 ?mag . OPTIONAL { ?ms pq:P1227 ?band . } }
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
}
"""
#: Every NGC/IC object `dso_objects.txt` lists, by its code (with or without a magnitude).
Q_CODES = """
SELECT ?item ?code ?ra ?dec ?mag ?band ?label WHERE {
  VALUES ?cat { wd:Q14534 wd:Q741672 }
  VALUES ?code { %s }
  ?item p:P528 ?st . ?st ps:P528 ?code ; pq:P972 ?cat .
  OPTIONAL { ?item wdt:P6257 ?ra . }
  OPTIONAL { ?item wdt:P6258 ?dec . }
  OPTIONAL { ?item p:P1215 ?ms . ?ms ps:P1215 ?mag . OPTIONAL { ?ms pq:P1227 ?band . } }
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
}
"""
#: Objects this project lists by Wikidata item because they have no NGC/IC number
#: (the Magellanic Clouds), or no V magnitude in Wikidata: filled in from
#: `dso_objects.txt` (`wikidata=Q...` fields) at run time.
Q_ITEMS = """
SELECT ?item ?code ?ra ?dec ?mag ?band ?label WHERE {
  VALUES ?item { %s }
  OPTIONAL { ?item p:P528 ?st . ?st ps:P528 ?code . }
  OPTIONAL { ?item wdt:P6257 ?ra . }
  OPTIONAL { ?item wdt:P6258 ?dec . }
  OPTIONAL { ?item p:P1215 ?ms . ?ms ps:P1215 ?mag . OPTIONAL { ?ms pq:P1227 ?band . } }
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
}
"""

SIMBAD_TAP = "https://simbad.u-strasbg.fr/simbad/sim-tap/sync"
#: SIMBAD identifiers are matched as SIMBAD normalises them ("M 31", "NGC 224").
Q_SIMBAD = (
    "SELECT i.id, b.main_id, b.ra, b.dec, b.otype, b.galdim_majaxis, "
    "b.galdim_minaxis, b.galdim_angle, f.V "
    "FROM ident AS i JOIN basic AS b ON i.oidref = b.oid "
    "LEFT JOIN allfluxes AS f ON f.oidref = b.oid WHERE i.id IN (%s)"
)

VIZIER_ASU = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"

HEASARC_TAP = "https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync"
#: Integrated magnitudes: Harris's catalogue of Milky Way globular clusters (1996, 2010
#: edition) and the Third Reference Catalogue of Bright Galaxies (RC3), as NASA HEASARC
#: serves them. Wikidata's V is a mixture (central stars of planetary nebulae, nuclear
#: and photographic values), so these are the integrated magnitudes the table adopts
#: for globular clusters and galaxies (dso.py).
Q_HARRIS = "SELECT name, alt_name, ra, dec, vmag FROM globclust ORDER BY name"
Q_RC3 = ("SELECT name, alt_name_1, alt_name_2, pgc_name, ra, dec, bt_mag, bv_color_tot, "
         "log_d25, log_r25 FROM rc3 WHERE bt_mag < 12.5 ORDER BY name")


def _get(url: str, data: bytes | None = None, accept: str | None = None) -> bytes:
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, data=data, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except Exception as e:  # network hiccups: retry a few times, then give up loudly
            if attempt == 3:
                raise
            print("  retry after %s" % e)
            time.sleep(5 * (attempt + 1))
    raise AssertionError("unreachable")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_provenance() -> dict:
    if os.path.exists(PROVENANCE):
        with open(PROVENANCE, encoding="utf-8") as f:
            return json.load(f)
    return {"files": {}}


def _save(prov: dict, name: str, data: bytes, url: str, query: str | None = None) -> None:
    with open(os.path.join(DATA, name), "wb") as f:
        f.write(data)
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rec = {"url": url, "retrieved_utc": now, "size_bytes": len(data), "sha256": sha256(data)}
    if query is not None:
        rec["query"] = query.strip()
    prov["files"][name] = rec
    with open(PROVENANCE, "w", encoding="utf-8") as f:
        json.dump(prov, f, indent=2, sort_keys=True)
        f.write("\n")
    print("fetched %-32s %9d bytes  %s" % (name, len(data), rec["sha256"][:16]))


def stage_static(prov: dict) -> None:
    for name, url in STATIC:
        _save(prov, name, _get(url), url)


def sparql(prov: dict, name: str, query: str) -> None:
    url = SPARQL + "?" + urllib.parse.urlencode({"query": query})
    _save(prov, name, _get(url, accept="text/csv"), SPARQL, query)


def authored_objects() -> list[dict]:
    """`dso_objects.txt` rows as dicts of raw strings (see dso.py for the format)."""
    rows = []
    with open(OBJECTS, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            cells = [c.strip() for c in line.split("|")]
            rows.append({"id": cells[0], "extra": cells[5] if len(cells) > 5 else ""})
    return rows


def extra_fields(extra: str) -> dict:
    out = {}
    for part in extra.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def stage_wikidata(prov: dict) -> None:
    sparql(prov, "wikidata_messier.csv", Q_MESSIER)
    codes = []
    for o in authored_objects():
        m = re.fullmatch(r"(NGC|IC)(\d+)", o["id"])
        if m:
            # Wikidata writes the code with one space ("NGC 5139"); ask for both forms.
            codes += ['"%s %s"' % m.groups(), '"%s%s"' % m.groups()]
    sparql(prov, "wikidata_ngcic.csv", Q_CODES % " ".join(codes))
    items = sorted({extra_fields(o["extra"])["wikidata"] for o in authored_objects()
                    if "wikidata" in extra_fields(o["extra"])})
    if items:
        sparql(prov, "wikidata_items.csv", Q_ITEMS % " ".join("wd:%s" % q for q in items))


def simbad_names(obj_id: str, extra: dict) -> list[str]:
    """Identifiers to ask SIMBAD for one listed object."""
    names = []
    m = re.fullmatch(r"(M|NGC|IC)(\d+)", obj_id)
    if m:
        names.append("%s %s" % (m.group(1), m.group(2)))
    for k in ("ngc", "simbad"):
        if k in extra:
            names.extend(x.strip() for x in extra[k].split(","))
    return names


def stage_crosscheck(prov: dict) -> None:
    objs = authored_objects()
    ids = []
    for o in objs:
        ids.extend(simbad_names(o["id"], extra_fields(o["extra"])))
    ids = sorted(set(ids))
    # SIMBAD: one query per 150 identifiers keeps the URL short.
    chunks = []
    for k in range(0, len(ids), 150):
        part = ids[k:k + 150]
        q = Q_SIMBAD % ", ".join("'%s'" % i.replace("'", "''") for i in part)
        body = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                       "QUERY": q}).encode()
        text = _get(SIMBAD_TAP, data=body).decode("utf-8")
        lines = text.strip("\n").split("\n")
        chunks.append(lines if not chunks else lines[1:])
    blob = "\n".join(line for c in chunks for line in c) + "\n"
    _save(prov, "simbad_dso.csv", blob.encode("utf-8"), SIMBAD_TAP, Q_SIMBAD % "<listed ids>")

    # Corwin's NGC/IC mean positions: every row of the catalogue's position table
    # (called `icpos`, it holds both catalogues: 9 027 NGC and 6 490 IC rows).
    q = {"-source": "VII/239A/icpos", "-out.max": "unlimited",
         "-out": "Cat,NGC/IC,n_NGC/IC,RAJ2000,DEJ2000,qPos,N,e_RAJ2000,e_DEJ2000"}
    url = VIZIER_ASU + "?" + urllib.parse.urlencode(q)
    _save(prov, "corwin_ngcic_pos.tsv", _get(url), url)

    for name, q in (("heasarc_globclust.txt", Q_HARRIS), ("heasarc_rc3.txt", Q_RC3)):
        url = HEASARC_TAP + "?" + urllib.parse.urlencode(
            {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "text/plain", "MAXREC": "50000",
             "QUERY": q})
        _save(prov, name, _get(url), HEASARC_TAP, q)


def main(argv: list[str]) -> int:
    os.makedirs(DATA, exist_ok=True)
    prov = _load_provenance()
    stages = argv or ["static", "wikidata", "crosscheck"]
    for s in stages:
        {"static": stage_static, "wikidata": stage_wikidata,
         "crosscheck": stage_crosscheck}[s](prov)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
