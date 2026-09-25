"""Join the IAU star names to the display catalogue. Development-time only.

    python3 -m tools.starfield.wgsn

Run from the repository root after `python3 -m tools.starfield.deepsky_fetch static`.
Pure standard library.

The IAU Working Group on Star Names (WGSN) keeps the IAU Catalog of Star Names. Its
live table (exopla.net) is the source; the 2022 text file is a cross-check. A star's
name and which star it names are facts, used here without on-screen credit (the docs
say "star names: IAU WGSN").

Every WGSN name whose designation is an HR number is joined to the Bright Star
Catalogue star of that number when an independent check agrees: the live table's
position within 0.2 degrees, or the 2022 file's position for the same name, or the
declination and the Bayer/Flamsteed designation (a dozen rows of the live table carry a
right ascension several degrees wrong). The existing 252 names (`crates/skyfix-starfield/data/names.txt`,
with the Nautical Almanac spellings for the navigational stars) always win: where the
WGSN spells a star's name differently, or gives a name the existing list uses for
another star, the difference is reported in the manifest and nothing changes.

Output: `crates/skyfix-starfield/data/names_wgsn.txt` (`hr|hip|name`: the HIP number of
every joined star, and its WGSN name when the star had none) and the `names` section of
`deepsky_manifest.json`.
"""

from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
import struct
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(HERE, "data", "deepsky")
DATA = os.path.join(REPO, "crates", "skyfix-starfield", "data")
OUT = os.path.join(DATA, "names_wgsn.txt")
MANIFEST = os.path.join(DATA, "deepsky_manifest.json")

MAX_SEP_DEG = 0.2


def fold(s: str) -> str:
    """Case, accents, spaces and punctuation removed: "Al Na'ir" -> "alnair"."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s.lower())


GREEK = "αβγδεζηθικλμνξοπρστυφχψω"
#: The 88 IAU abbreviations in the order stars.bin stores them (bsc.CONSTELLATIONS).
from .bsc import CONSTELLATIONS  # noqa: E402


def read_stars():
    """HR -> (ra_deg, dec_deg, vmag, designation) from stars.bin (layout: catalog.rs).
    The designation is "ζ UMa" (superscripts dropped) or "95 Her", or ""."""
    blob = open(os.path.join(DATA, "stars.bin"), "rb").read()
    assert blob[:8] == b"SKYFIXSF"
    _, rec, n = struct.unpack("<HHI", blob[8:16])
    out = {}
    for k in range(n):
        r = blob[16 + k * rec:16 + (k + 1) * rec]
        hr, ra, dec = struct.unpack("<HIi", r[:10])
        vmag = struct.unpack("<h", r[16:18])[0] / 100.0
        bayer, _sup, flam, con = struct.unpack("<BBHB", r[20:25])
        abbr = CONSTELLATIONS[con][0] if con != 255 else ""
        desig = []
        if bayer:
            desig.append("%s %s" % (GREEK[bayer - 1], abbr))
        if flam:
            desig.append("%d %s" % (flam, abbr))
        out[hr] = (ra / 2400.0, dec / 3600.0, vmag, desig)
    return out


def norm_desig(d: str) -> str:
    """"τ2 Aqr" -> "τ Aqr"; "95 Her" stays."""
    d = " ".join(d.split())
    return re.sub(r"^([^\W\d_])[\d¹²³⁴⁵⁶⁷⁸⁹]+ ", r"\1 ", d)


def read_existing():
    names = {}
    with open(os.path.join(DATA, "names.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                hr, name = line.split("|", 1)
                names[int(hr)] = name
    return names


def read_exopla():
    s = open(os.path.join(RAW, "wgsn_exopla.html"), encoding="utf-8").read()
    i = s.index('<table id="table_1"')
    t = s[i:s.index("</table>", i)]
    head = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
            for c in re.findall(r"<th[^>]*>(.*?)</th>", t, re.S)]
    rows = []
    for r in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S)[1:]:
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        rows.append(dict(zip(head, cells)))
    return rows


def read_csn():
    """The 2022 text file: {fold(name): (HR, ra_deg, dec_deg)} for the names with an HR
    designation (RA and Dec are the two columns before the adoption date)."""
    out = {}
    with open(os.path.join(RAW, "wgsn_iau_csn_2022.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith(("#", "$")) or not line.strip():
                continue
            m = re.match(r"(\S.*?)\s{2,}(\S.*?)\s{2,}HR (\d+)\s", line)
            d = re.search(r"\s(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+\d{4}-\d\d-\d\d", line)
            if m and d:
                out[fold(m.group(1))] = (int(m.group(3)), float(d.group(1)), float(d.group(2)))
    return out


def sep_deg(a, b):
    ra1, d1 = map(math.radians, a)
    ra2, d2 = map(math.radians, b)
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(ra1 - ra2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def main() -> int:
    stars = read_stars()
    existing = read_existing()
    existing_fold = {fold(n): hr for hr, n in existing.items()}
    csn = read_csn()
    rows = read_exopla()

    joined, added, agree, spelled, taken, missing, far, not_hr, csn_diff, via = [], [], [], [], [], [], [], [], [], []
    seen_hr = {}
    for r in rows:
        name, desig = r["proper names"], r["Designation"]
        m = re.fullmatch(r"HR (\d+)", desig)
        if not m:
            not_hr.append(name)
            continue
        hr = int(m.group(1))
        if hr not in stars:
            missing.append("%s (HR %d)" % (name, hr))
            continue
        # The join by HR is accepted when any independent check agrees: the live
        # table's position; the 2022 file's position for the same name; or the live
        # table's declination and Bayer/Flamsteed designation (some rows of the live
        # table carry a wrong right ascension, e.g. Mira and Mizar, 4-6 degrees off,
        # while their declination and designation are right).
        try:
            pos = (float(r["RA"]), float(r["DEC"]))
        except ValueError:
            pos = None
        here = stars[hr]
        desig_ok = bool(r.get("Bayer ID")) and norm_desig(r["Bayer ID"]) in here[3]
        how = None
        if pos is not None and sep_deg(pos, here[:2]) <= MAX_SEP_DEG:
            how = "position"
        elif fold(name) in csn and csn[fold(name)][0] == hr and \
                sep_deg(csn[fold(name)][1:], here[:2]) <= MAX_SEP_DEG:
            how = "2022 file position"
        elif desig_ok and (pos is None or abs(pos[1] - here[1]) <= MAX_SEP_DEG):
            how = "declination and designation" if pos is not None else "designation"
        if how is None:
            far.append("%s: HR %d is %s from the WGSN position and the designations differ" % (
                name, hr, "n/a" if pos is None else "%.2f deg" % sep_deg(pos, here[:2])))
            continue
        if how != "position":
            via.append("%s (HR %d): %s" % (name, hr, how))
        if hr in seen_hr:
            far.append("%s: HR %d already named %s by the WGSN table" % (name, hr, seen_hr[hr]))
            continue
        seen_hr[hr] = name
        if fold(name) in csn and csn[fold(name)][0] != hr:
            csn_diff.append("%s: HR %d here, HR %d in the 2022 file" % (name, hr, csn[fold(name)][0]))
        hip = int(r["HIP"]) if r.get("HIP", "").isdigit() else 0
        if hr in existing:
            if fold(existing[hr]) == fold(name):
                agree.append(name)
                if existing[hr] != name:
                    spelled.append("HR %d: ours %r, WGSN %r (same name; ours kept)" % (hr, existing[hr], name))
            else:
                spelled.append("HR %d: ours %r, WGSN %r (ours kept)" % (hr, existing[hr], name))
            joined.append((hr, hip, ""))
        elif fold(name) in existing_fold:
            taken.append("%s: WGSN HR %d, ours HR %d (ours kept)" % (name, hr, existing_fold[fold(name)]))
            joined.append((hr, hip, ""))
        else:
            added.append(name)
            joined.append((hr, hip, name))

    joined.sort()
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("# Generated by tools/starfield/wgsn.py; do not edit by hand. Display-only data\n"
                "# (CONVENTIONS 13.6). Star names: IAU WGSN (the IAU Catalog of Star Names),\n"
                "# joined by HR number to the Bright Star Catalogue. names.txt wins where both\n"
                "# name a star. hr|hip|name (name empty: the star keeps its names.txt name).\n")
        for hr, hip, name in joined:
            f.write("%d|%d|%s\n" % (hr, hip, name))

    manifest = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)
    with open(os.path.join(RAW, "provenance.json"), encoding="utf-8") as f:
        prov = json.load(f)["files"]
    manifest["names"] = {
        "generator": "tools/starfield/wgsn.py",
        "inputs": {k: {kk: prov[k][kk] for kk in ("url", "retrieved_utc", "size_bytes", "sha256")}
                   for k in ("wgsn_exopla.html", "wgsn_iau_csn_2022.txt")},
        "wgsn_names": len(rows),
        "with_hr_designation": len(rows) - len(not_hr),
        "joined": len(joined),
        "names_added": len(added),
        "existing_names": len(existing),
        "existing_agreeing_with_wgsn": len(agree),
        "spelling_differences_kept_ours": spelled,
        "wgsn_names_ours_uses_for_another_star": taken,
        "hr_not_in_display_catalogue": missing,
        "position_or_duplicate_rejections": far,
        "joined_by_a_check_other_than_the_live_position": via,
        "differences_from_the_2022_file": csn_diff,
        "bytes": os.path.getsize(OUT),
        "sha256": hashlib.sha256(open(OUT, "rb").read()).hexdigest(),
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    s = manifest["names"]
    print("WGSN %d names, %d with HR; joined %d; added %d; existing %d, agreeing %d" % (
        s["wgsn_names"], s["with_hr_designation"], s["joined"], s["names_added"],
        s["existing_names"], s["existing_agreeing_with_wgsn"]))
    for k in ("spelling_differences_kept_ours", "wgsn_names_ours_uses_for_another_star",
              "hr_not_in_display_catalogue", "position_or_duplicate_rejections",
              "joined_by_a_check_other_than_the_live_position",
              "differences_from_the_2022_file"):
        print("%s (%d):" % (k, len(s[k])))
        for x in s[k]:
            print("   ", x)
    return 0


if __name__ == "__main__":
    sys.exit(main())
