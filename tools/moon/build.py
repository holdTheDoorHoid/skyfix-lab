"""Build the named-lunar-feature table the core embeds. Development-time only.

    python3 -m tools.moon.build

Run from the repository root after `python3 -m tools.moon.fetch`. Uses only the Python
standard library. Reads the gazetteer pages in `tools/moon/data/` and the list this
project authored, `tools/moon/picks.txt` (names, ranks and one-line descriptions).
Writes:

* `crates/skyfix-almanac/data/lunar_features.tsv` — one row per feature:
  `name <TAB> kind <TAB> lat_deg <TAB> lon_deg <TAB> diameter_km <TAB> rank <TAB> description`
  (selenographic, planetocentric, east-positive, as the gazetteer gives them);
* `crates/skyfix-almanac/data/lunar_features.manifest.json` — the inputs with SHA-256,
  the gazetteer feature id behind every row, counts, and the checks below.

Every check either passes or stops the build; nothing is silently accepted.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

from . import gazetteer

REPO = os.path.dirname(os.path.dirname(gazetteer.HERE))
OUT_DIR = os.path.join(REPO, "crates", "skyfix-almanac", "data")
OUT_TSV = os.path.join(OUT_DIR, "lunar_features.tsv")
OUT_MANIFEST = os.path.join(OUT_DIR, "lunar_features.manifest.json")
PICKS = os.path.join(gazetteer.HERE, "picks.txt")
PROVENANCE = os.path.join(gazetteer.DATA, "provenance.json")

#: The gazetteer's feature types, as the kinds the engine reports.
KINDS = {
    "Mare, maria": "mare",
    "Oceanus, oceani": "oceanus",
    "Lacus, lacūs": "lacus",
    "Sinus, sinūs": "sinus",
    "Palus, paludes": "palus",
    "Rupes, rupēs": "rupes",
    "Rima, rimae": "rima",
    "Vallis, valles": "vallis",
    "Dorsum, dorsa": "dorsum",
    "Promontorium, promontoria": "promontorium",
    "Albedo Feature": "albedo",
    "Crater, craters": "crater",
}


def kind_of(row: dict) -> str:
    if row["type"] == "Mons, montes":
        return "montes" if row["name"].startswith("Montes ") else "mons"
    return KINDS[row["type"]]


def read_picks() -> list[dict]:
    picks = []
    with open(PICKS, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split(" | ")]
            if len(parts) not in (3, 4):
                raise ValueError("picks.txt:%d: expected 3 or 4 fields" % n)
            name, rank, desc = parts[0], int(parts[1]), parts[2]
            source = None
            if len(parts) == 4:
                if not parts[3].startswith("source="):
                    raise ValueError("picks.txt:%d: fourth field must be source=" % n)
                source = parts[3][len("source="):]
            if rank not in (1, 2, 3):
                raise ValueError("picks.txt:%d: rank must be 1, 2 or 3" % n)
            if not desc or len(desc) > 80 or "\t" in desc:
                raise ValueError("picks.txt:%d: description must be 1-80 chars, no tabs" % n)
            picks.append({"name": name, "rank": rank, "description": desc, "source": source})
    return picks


def sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main() -> int:
    rows = gazetteer.load_all()
    by_name: dict[str, dict] = {}
    for r in rows:
        if r["name"] in by_name:
            raise ValueError("gazetteer name %r is not unique" % r["name"])
        by_name[r["name"]] = r
    picks = read_picks()
    names = [p["name"] for p in picks]
    if len(set(names)) != len(names):
        raise ValueError("a name is picked twice")

    out_rows = []
    manifest_rows = []
    for p in picks:
        if p["source"] is not None:
            if not p["name"].startswith("Apollo "):
                raise ValueError("%s: only landing sites take a source" % p["name"])
            r = by_name[p["source"]]
            if r["type"] not in ("Statio", "Astronaut-named features"):
                raise ValueError("%s: source %s is a %s" % (p["name"], r["name"], r["type"]))
            kind, diameter = "landing_site", 0.0
        else:
            if p["name"] not in by_name:
                raise ValueError("%s is not an approved name in the fetched gazetteer" % p["name"])
            r = by_name[p["name"]]
            kind, diameter = kind_of(r), r["diameter_km"]
            if diameter is None or diameter <= 0:
                raise ValueError("%s has no diameter" % p["name"])
        lat, lon = r["lat_deg"], r["lon_deg"]
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("%s: coordinates out of range" % p["name"])
        out_rows.append((p["name"], kind, lat, lon, diameter, p["rank"], p["description"]))
        manifest_rows.append(
            {
                "name": p["name"],
                "gazetteer_id": r["id"],
                "gazetteer_name": r["name"],
                "gazetteer_type": r["type"],
                "gazetteer_last_updated": r["last_updated"],
            }
        )

    with open(PROVENANCE, encoding="utf-8") as f:
        prov = json.load(f)
    header = [
        "# Named lunar features for SkyFix Lab (skyfix_almanac::lunar_features).",
        "# Generated by tools/moon/build.py; do not edit by hand.",
        "# Names, coordinates and diameters: USGS/IAU Gazetteer of Planetary Nomenclature,",
        "# https://planetarynames.wr.usgs.gov/ (approved Moon features), retrieved %s;"
        % prov["retrieved_utc"],
        "# U.S. Public Domain (USGS). Selection, ranks and descriptions: SkyFix Lab.",
        "# Selenographic, planetocentric, east-positive longitude, degrees; diameter km.",
        "# name\tkind\tlat_deg\tlon_deg\tdiameter_km\trank\tdescription",
    ]
    lines = header + [
        "%s\t%s\t%.2f\t%.2f\t%.2f\t%d\t%s" % (n, k, la, lo, d, rk, de)
        for (n, k, la, lo, d, rk, de) in out_rows
    ]
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_TSV, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    counts: dict[str, int] = {}
    for row in out_rows:
        counts[row[1]] = counts.get(row[1], 0) + 1
    manifest = {
        "generator": "tools/moon/build.py",
        "source": "USGS/IAU Gazetteer of Planetary Nomenclature, approved Moon features",
        "source_url": "https://planetarynames.wr.usgs.gov/",
        "retrieved_utc": prov["retrieved_utc"],
        "licence": "U.S. Public Domain: 'USGS-authored or produced data and information are "
        "considered to be in the U.S. Public Domain' (%s); credit requested, not required"
        % "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
        "coordinates": "selenographic, planetocentric, east-positive, degrees; the "
        "gazetteer's current control network (LOLA 2011), 0.01 deg precision",
        "inputs": {
            name: {"sha256": facts["sha256"], "size_bytes": facts["size_bytes"]}
            for name, facts in sorted(prov["files"].items())
        },
        "picks_sha256": sha256_file(PICKS),
        "gazetteer_features_read": len(rows),
        "features": len(out_rows),
        "by_kind": dict(sorted(counts.items())),
        "by_rank": {
            str(k): sum(1 for r in out_rows if r[5] == k) for k in (1, 2, 3)
        },
        "output_bytes": os.path.getsize(OUT_TSV),
        "output_sha256": sha256_file(OUT_TSV),
        "rows": manifest_rows,
    }
    with open(OUT_MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(
        "wrote %d features (%d bytes) from %d gazetteer rows"
        % (len(out_rows), manifest["output_bytes"], len(rows))
    )
    print("by kind:", manifest["by_kind"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
