"""Build the deep-sky object table. Development-time only.

    python3 -m tools.starfield.dso

Run from the repository root after `python3 -m tools.starfield.deepsky_fetch`. Pure
standard library.

Inputs:

* `tools/starfield/dso_objects.txt` — this project's own list: which objects, their
  types, common names and one-line descriptions (authored; see its header for the
  selection rule);
* `tools/starfield/data/deepsky/wikidata_*.csv` — J2000 positions and V magnitudes
  from Wikidata (CC0), the values that ship;
* `tools/starfield/data/deepsky/simbad_dso.csv` and `corwin_ngcic_pos.tsv` — two
  independent references (SIMBAD; Corwin's NGC/IC positions, VizieR VII/239A), used
  only to check Wikidata and, for SIMBAD, to supply apparent sizes where the list does
  not give one (sizes are rounded to two significant figures: display facts).

Outputs:

* `crates/skyfix-starfield/data/dso.txt` — one object per line,
  `id|type|ra_deg|dec_deg|vmag|major_arcmin|minor_arcmin|name|description|cross_ids`;
* `fixtures/reference/dso_positions.json` — every listed object's position in all
  three sources, for `crates/skyfix-starfield/tests/dso_reference.rs`;
* the `dso` section of `crates/skyfix-starfield/data/deepsky_manifest.json`.

Every disagreement beyond the tolerances below stops the build with the object named,
so a Wikidata error cannot ship silently.
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(HERE, "data", "deepsky")
AUTHORED = os.path.join(HERE, "dso_objects.txt")
OUT = os.path.join(REPO, "crates", "skyfix-starfield", "data", "dso.txt")
FIXTURE = os.path.join(REPO, "fixtures", "reference", "dso_positions.json")
MANIFEST = os.path.join(REPO, "crates", "skyfix-starfield", "data", "deepsky_manifest.json")

V_BAND = "http://www.wikidata.org/entity/Q4892529"
TYPES = {"oc", "gc", "pn", "en", "rn", "snr", "cn", "sg", "eg", "lg", "ig", "ds", "as", "sc"}

#: A shipped (Wikidata) position may differ from SIMBAD's and Corwin's by at most
#: max(ABS, FRACTION x the object's major axis): extended objects have no single centre,
#: and references measure it differently.
POS_TOL_ABS_ARCMIN = 1.0
POS_TOL_FRACTION = 0.25
#: Objects with no defined centre are held to half their major axis instead: open
#: clusters, asterisms and star clouds (catalogues adopt different membership studies'
#: centres) and nebulae at least 30' across (the NGC/IC position is the discoverer's
#: estimate of a region, and Wikidata and SIMBAD quote different parts).
LOOSE_TYPES = {"oc", "as", "sc"}
LARGE_NEBULA_ARCMIN = 30.0
LOOSE_FRACTION = 0.5
#: The magnitudes of extended objects differ between catalogues by several tenths.
V_TOL = 1.0
#: Types that may ship without a magnitude.
NO_MAGNITUDE_OK = {"en", "rn", "snr", "sc"}
GALAXIES = {"sg", "eg", "lg", "ig"}
#: dso_objects.txt's selection rule for objects outside Messier's list.
RULE_V_LIMIT = {"oc": 5.0, "cn": 5.0, "gc": 7.5, "sg": 9.5, "eg": 9.5, "lg": 9.5, "ig": 9.5,
                "pn": 9.5}
OUTSIDE_NGC_IC = {"Mel25", "Mel20", "Mel111", "Cr399"}


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------


def read_authored():
    rows = []
    with open(AUTHORED, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            cells = [c.strip() for c in line.split("|")]
            while len(cells) < 6:
                cells.append("")
            oid, typ, size, name, desc, extra = cells[:6]
            if typ not in TYPES:
                raise ValueError("dso_objects.txt:%d: unknown type %r" % (n, typ))
            if "|" in name or "|" in desc:
                raise ValueError("dso_objects.txt:%d: '|' in a text field" % n)
            fields = {}
            for part in extra.split(";"):
                part = part.strip()
                if part:
                    k, v = part.split("=", 1)
                    fields[k.strip()] = v.strip()
            rows.append({"id": oid, "type": typ, "size": size, "name": name, "desc": desc,
                         "extra": fields, "line": n})
    ids = [r["id"] for r in rows]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError("listed twice: %s" % ", ".join(dup))
    return rows


def norm_code(code: str) -> str:
    """`M1`, `M 1`, `NGC  224` -> `M 1`, `NGC 224`; `NAME LMC` stays."""
    code = " ".join(code.split())
    m = re.fullmatch(r"(M|NGC|IC)\s*(\d+)", code)
    return "%s %d" % (m.group(1), int(m.group(2))) if m else code


def read_wikidata():
    """{code or QID: {"qid", "ra": set, "dec": set, "v": set, "label"}}."""
    by_item = {}
    for name in ("wikidata_messier.csv", "wikidata_ngcic.csv", "wikidata_items.csv"):
        path = os.path.join(RAW, name)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                qid = r["item"].rsplit("/", 1)[-1]
                it = by_item.setdefault(qid, {"qid": qid, "codes": set(), "ra": set(),
                                              "dec": set(), "v": set(), "label": ""})
                if r.get("code"):
                    it["codes"].add(norm_code(r["code"]))
                if r.get("ra"):
                    it["ra"].add(float(r["ra"]))
                if r.get("dec"):
                    it["dec"].add(float(r["dec"]))
                if r.get("mag") and r.get("band") == V_BAND:
                    it["v"].add(float(r["mag"]))
                if r.get("label"):
                    it["label"] = r["label"]
    by_code = {}
    for it in by_item.values():
        for c in it["codes"]:
            by_code.setdefault(c, []).append(it)
    return by_item, by_code


def read_simbad():
    out = {}
    with open(os.path.join(RAW, "simbad_dso.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            key = norm_code(r["id"])
            out[key] = {
                "main_id": " ".join(r["main_id"].split()),
                "ra": float(r["ra"]), "dec": float(r["dec"]), "otype": r["otype"],
                "maj": float(r["galdim_majaxis"]) if r["galdim_majaxis"] else None,
                "min": float(r["galdim_minaxis"]) if r["galdim_minaxis"] else None,
                "v": float(r["V"]) if r["V"] else None,
            }
    return out


def read_heasarc(name: str):
    """A HEASARC text/plain TAP result as a list of dicts of stripped strings."""
    rows = []
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        lines = [l for l in f.read().split("\n") if l.strip() and not l.startswith("Number of")]
    header = [h.strip() for h in lines[0].split("|")]
    for line in lines[1:]:
        cells = [c.strip() for c in line.split("|")]
        rows.append({h: (None if c in ("", "null") else c) for h, c in zip(header, cells)})
    return rows


def read_harris():
    """{"NGC 104": V_t, "M 4": V_t, ...}: Harris's integrated V of globular clusters."""
    out = {}
    for r in read_heasarc("heasarc_globclust.txt"):
        if r["vmag"] is None:
            continue
        for k in ("name", "alt_name"):
            if r[k]:
                out[norm_code(r[k])] = float(r["vmag"])
    return out


def read_rc3():
    """{"NGC 224": (B_T, (B-V)_T or None)} from RC3."""
    out = {}
    for r in read_heasarc("heasarc_rc3.txt"):
        if r["bt_mag"] is None:
            continue
        val = (float(r["bt_mag"]), float(r["bv_color_tot"]) if r["bv_color_tot"] else None)
        for k in ("name", "alt_name_1", "alt_name_2"):
            if r[k]:
                out.setdefault(norm_code(r[k]), val)
    return out


def sexa(s: str, hours: bool) -> float:
    parts = s.split()
    sign = -1.0 if parts[0].startswith("-") else 1.0
    a, b, c = abs(float(parts[0])), float(parts[1]), float(parts[2])
    v = sign * (a + b / 60.0 + c / 3600.0)
    return v * 15.0 if hours else v


def read_corwin():
    """{"NGC 224": (ra_deg, dec_deg)} from the main (component-free) row of each object."""
    out = {}
    with open(os.path.join(RAW, "corwin_ngcic_pos.tsv"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            cells = line.rstrip("\n").split("\t")
            # The main row of an object has no component name; its remark column is
            # empty or only an identity ("=N2478", "=?N6777").
            if len(cells) < 5 or cells[0] not in ("N", "I"):
                continue
            if not re.fullmatch(r"(=\S+)?", cells[2].strip()):
                continue
            key = "%s %d" % ("NGC" if cells[0] == "N" else "IC", int(cells[1]))
            out.setdefault(key, (sexa(cells[3], True), sexa(cells[4], False)))
    return out


# ---------------------------------------------------------------------------
# Geometry and rounding
# ---------------------------------------------------------------------------


def unit(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def sep_arcmin(a, b):
    u, v = unit(*a), unit(*b)
    c = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    s = math.sqrt(sum(x * x for x in c))
    return math.degrees(math.atan2(s, sum(x * y for x, y in zip(u, v)))) * 60.0


def two_sig(x: float) -> float:
    if x <= 0:
        return 0.0
    e = math.floor(math.log10(x))
    q = 10.0 ** (e - 1)
    return round(round(x / q) * q, 6)


def fmt_num(x: float) -> str:
    s = ("%.6f" % x).rstrip("0").rstrip(".")
    return s if s else "0"


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def lookup_wikidata(obj, by_item, by_code):
    extra = obj["extra"]
    if "wikidata" in extra:
        it = by_item.get(extra["wikidata"])
        return [it] if it else []
    code = norm_code(re.sub(r"^(M|NGC|IC)(\d+)$", r"\1 \2", obj["id"]))
    return by_code.get(code, [])


def simbad_keys(obj):
    oid, extra = obj["id"], obj["extra"]
    keys = []
    m = re.fullmatch(r"(M|NGC|IC)(\d+)", oid)
    if m:
        keys.append("%s %s" % (m.group(1), int(m.group(2))))
    if "simbad" in extra:
        keys.extend(norm_code(x) for x in extra["simbad"].split(","))
    if "ngc" in extra:
        keys.extend(norm_code(x) for x in extra["ngc"].split(","))
    return keys


def corwin_key(obj):
    if obj["extra"].get("corwin") == "none":
        return None
    m = re.fullmatch(r"(NGC|IC)(\d+)", obj["id"])
    if m:
        return "%s %d" % (m.group(1), int(m.group(2)))
    if "ngc" in obj["extra"]:
        return norm_code(obj["extra"]["ngc"].split(",")[0])
    return None


def label_of(oid: str) -> str:
    m = re.fullmatch(r"(NGC|IC)(\d+)", oid)
    return "%s %s" % (m.group(1), m.group(2)) if m else oid


def main() -> int:
    authored = read_authored()
    by_item, by_code = read_wikidata()
    simbad = read_simbad()
    corwin = read_corwin()
    harris = read_harris()
    rc3 = read_rc3()

    # The median (B-V)_T of the listed galaxies RC3 gives a colour for, used for the few
    # it gives only B_T.
    colours = []
    for obj in authored:
        if obj["type"] in GALAXIES:
            for k in [norm_code(re.sub(r"^(M|NGC|IC)(\d+)$", r"\1 \2", obj["id"]))] + simbad_keys(obj):
                if k in rc3:
                    if rc3[k][1] is not None:
                        colours.append(rc3[k][1])
                    break
    median_bv = round(statistics.median(colours), 2)

    problems, notes, rows, fixture = [], [], [], []
    for obj in authored:
        oid = obj["id"]
        sb = None
        for k in simbad_keys(obj):
            if k in simbad:
                sb = simbad[k]
                break
        if sb is None:
            problems.append("%s: not found in SIMBAD (%s)" % (oid, simbad_keys(obj)))
            continue
        items = lookup_wikidata(obj, by_item, by_code)
        # A code can sit on more than one item (an object and a member star, a
        # duplicate); keep the ones with a position, and insist on exactly one.
        items = [it for it in items if it["ra"] and it["dec"]]
        if len(items) != 1:
            problems.append("%s: %d Wikidata items with a position (%s)" % (
                oid, len(items), ", ".join(it["qid"] for it in items)))
            continue
        it = items[0]
        # Several RA or Dec statements (a rounded older value beside a precise one):
        # the statement nearest SIMBAD's ships, and must still pass both checks below.
        ra = min(it["ra"], key=lambda r: abs(((r - sb["ra"] + 180.0) % 360.0) - 180.0))
        dec = min(it["dec"], key=lambda d: abs(d - sb["dec"]))
        if len(it["ra"]) > 1 or len(it["dec"]) > 1:
            ras, decs = sorted(it["ra"]), sorted(it["dec"])
            spread = sep_arcmin((ras[0], decs[0]), (ras[-1], decs[-1]))
            notes.append("%s: Wikidata %s has RA %s and Dec %s (%.3f' apart); the values "
                         "nearest SIMBAD's ship" % (oid, it["qid"], ras, decs, spread))
        ck = corwin_key(obj)
        cw = corwin.get(ck) if ck else None
        if ck and cw is None:
            problems.append("%s: %s not in Corwin's table" % (oid, ck))
            continue

        # Size: authored, else SIMBAD's, rounded to two significant figures.
        if obj["size"]:
            parts = [float(x) for x in obj["size"].split("x")]
            maj, mnr = parts[0], parts[1] if len(parts) > 1 else parts[0]
            size_src = "authored"
        elif sb["maj"]:
            maj = two_sig(sb["maj"])
            mnr = two_sig(sb["min"]) if sb["min"] else maj
            size_src = "simbad"
        else:
            problems.append("%s: no size (SIMBAD has none; give one in dso_objects.txt)" % oid)
            continue

        loose = obj["type"] in LOOSE_TYPES or (
            obj["type"] in ("en", "rn", "snr") and maj >= LARGE_NEBULA_ARCMIN)
        tol = max(POS_TOL_ABS_ARCMIN, (LOOSE_FRACTION if loose else POS_TOL_FRACTION) * maj)
        d_sb = sep_arcmin((ra, dec), (sb["ra"], sb["dec"]))
        d_cw = sep_arcmin((ra, dec), cw) if cw else None
        if d_sb > tol:
            problems.append("%s: Wikidata %s is %.2f' from SIMBAD %s (tolerance %.1f')" % (
                oid, it["qid"], d_sb, sb["main_id"], tol))
        if d_cw is not None and d_cw > tol:
            problems.append("%s: Wikidata %s is %.2f' from Corwin %s (tolerance %.1f')" % (
                oid, it["qid"], d_cw, ck, tol))

        # Magnitude, integrated V. Wikidata's V is a mixture (it copies SIMBAD, whose V
        # is the central star of a planetary nebula, a nucleus or a photographic value
        # for some galaxies), so each class takes its standard integrated magnitude:
        # globular clusters Harris's V_t, galaxies RC3's V_T = B_T - (B-V)_T, planetary
        # nebulae the visual magnitude written in dso_objects.txt, everything else
        # Wikidata's V (with several, the one nearest SIMBAD's). An authored `v=`
        # (with `vsrc=`) is used where the class source has no value or is wrong.
        vs = sorted(it["v"])
        keys = [norm_code(re.sub(r"^(M|NGC|IC)(\d+)$", r"\1 \2", oid))] + simbad_keys(obj)
        v_wd = (min(vs, key=lambda x: abs(x - sb["v"])) if sb["v"] is not None else
                statistics.median(vs)) if vs else None
        v, v_src = None, None
        if "v" in obj["extra"]:
            v, v_src = float(obj["extra"]["v"]), "authored: " + obj["extra"].get("vsrc", "")
            if not obj["extra"].get("vsrc"):
                problems.append("%s: v= without vsrc=" % oid)
        elif obj["type"] == "gc":
            hv = next((harris[k] for k in keys if k in harris), None)
            if hv is None:
                problems.append("%s: not in Harris's catalogue" % oid)
                continue
            v, v_src = hv, "harris"
        elif obj["type"] in GALAXIES:
            rc = next((rc3[k] for k in keys if k in rc3), None)
            if rc is None:
                problems.append("%s: not in RC3; give v= and vsrc=" % oid)
                continue
            if rc[1] is None:
                # RC3 gives B_T but no colour: V from the median colour of the listed
                # galaxies that have one.
                v, v_src = round(rc[0] - median_bv, 2), "rc3_bt_median_colour"
            else:
                v, v_src = round(rc[0] - rc[1], 2), "rc3"
        elif obj["type"] == "pn":
            problems.append("%s: planetary nebulae need v= (Wikidata gives the central "
                            "star: %s)" % (oid, vs))
            continue
        elif vs:
            v, v_src = v_wd, "wikidata"
            if sb["v"] is not None and abs(v - sb["v"]) > V_TOL:
                problems.append("%s: Wikidata V %s vs SIMBAD V %.2f" % (oid, vs, sb["v"]))
        elif obj["type"] in NO_MAGNITUDE_OK:
            # Nebulae and star clouds: an integrated V is rarely measured and would
            # say little about visibility; the table leaves it empty.
            v, v_src = None, "none"
        else:
            problems.append("%s: Wikidata %s has no V magnitude (SIMBAD: %s)" % (oid, it["qid"], sb["v"]))
            continue
        if v is not None and v_wd is not None and abs(v - v_wd) > V_TOL:
            notes.append("%s: adopted V %.2f (%s); Wikidata has %s" % (oid, v, v_src, vs))

        # The selection rule of dso_objects.txt, checked (Messier's list and the four
        # clusters outside the NGC/IC are in by definition).
        if not re.fullmatch(r"M\d+", oid) and oid not in OUTSIDE_NGC_IC:
            limit = RULE_V_LIMIT.get(obj["type"])
            if limit is not None and (v is None or v > limit):
                problems.append("%s: V %s fails the selection rule (%s: V <= %s)" % (oid, v, obj["type"], limit))
            if obj["type"] in ("en", "rn", "snr") and (maj < 30.0 or not obj["name"]):
                problems.append("%s: nebulae are selected at 30' or more with a common name" % oid)

        cross = []
        if "ngc" in obj["extra"]:
            cross = [" ".join(x.split()) for x in obj["extra"]["ngc"].split(",")]
        rows.append((oid, obj["type"], ra, dec, v, maj, mnr, obj["name"], obj["desc"], cross))
        fixture.append({
            "id": oid, "type": obj["type"], "major_arcmin": maj,
            "wikidata": {"item": it["qid"], "ra_deg": ra, "dec_deg": dec, "v": v,
                         "v_values": vs},
            "simbad": {"main_id": sb["main_id"], "ra_deg": sb["ra"], "dec_deg": sb["dec"],
                       "v": sb["v"], "otype": sb["otype"]},
            "corwin": {"id": ck, "ra_deg": cw[0], "dec_deg": cw[1]} if cw else None,
            "sep_simbad_arcmin": round(d_sb, 3),
            "sep_corwin_arcmin": None if d_cw is None else round(d_cw, 3),
            "tolerance_arcmin": tol,
            "v_source": v_src, "size_source": size_src,
        })

    for n in notes:
        print("note:", n)
    if problems:
        print("\n%d problem(s):" % len(problems))
        for p in problems:
            print("  " + p)
        return 1

    # ---- Write outputs ----
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("# Generated by tools/starfield/dso.py from tools/starfield/dso_objects.txt;\n"
                "# do not edit by hand. Display-only data (CONVENTIONS 13.6).\n"
                "# Positions (ICRS/J2000, degrees) and V magnitudes: Wikidata (CC0), checked\n"
                "# against SIMBAD and Corwin (2004). Types, sizes (arcmin), names and\n"
                "# descriptions: SkyFix Lab. Provenance: docs/THIRD_PARTY.md, \"Deep sky\".\n"
                "# id|type|ra_deg|dec_deg|vmag|major_arcmin|minor_arcmin|name|description|cross_ids\n")
        for oid, typ, ra, dec, v, maj, mnr, name, desc, cross in rows:
            f.write("%s|%s|%.4f|%+.4f|%s|%s|%s|%s|%s|%s\n" % (
                oid, typ, ra, dec, "" if v is None else "%.1f" % v, fmt_num(maj), fmt_num(mnr),
                name, desc, ",".join(cross)))

    seps_sb = [x["sep_simbad_arcmin"] for x in fixture]
    seps_cw = [x["sep_corwin_arcmin"] for x in fixture if x["sep_corwin_arcmin"] is not None]
    summary = {
        "objects": len(rows),
        "messier": sum(1 for r in rows if re.fullmatch(r"M\d+", r[0])),
        "by_type": {t: sum(1 for r in rows if r[1] == t) for t in sorted(TYPES)},
        "southern": sum(1 for r in rows if r[3] < 0),
        "sep_simbad_arcmin": {"median": round(statistics.median(seps_sb), 3), "max": max(seps_sb)},
        "sep_corwin_arcmin": {"count": len(seps_cw), "median": round(statistics.median(seps_cw), 3),
                              "max": max(seps_cw)},
        "v_sources": {s: sum(1 for x in fixture if x["v_source"] == s)
                      for s in sorted({x["v_source"] for x in fixture})},
        "size_sources": {s: sum(1 for x in fixture if x["size_source"] == s)
                         for s in sorted({x["size_source"] for x in fixture})},
        "median_galaxy_colour_bv": median_bv,
        "galaxies_with_rc3_colour": len(colours),
        "notes": notes,
        "bytes": os.path.getsize(OUT),
    }
    with open(FIXTURE, "w", encoding="utf-8") as f:
        json.dump({
            "schema": "skyfix.reference/1",
            "generator": "tools/starfield/dso.py",
            "description": "Deep-sky object positions: the shipped Wikidata value and two "
                           "independent references (SIMBAD; Corwin 2004, VizieR VII/239A). "
                           "Display-only data, CONVENTIONS 13.6.",
            "tolerance": {"abs_arcmin": POS_TOL_ABS_ARCMIN, "fraction_of_major_axis": POS_TOL_FRACTION,
                          "loose_types": sorted(LOOSE_TYPES), "large_nebula_arcmin": LARGE_NEBULA_ARCMIN,
                          "loose_fraction": LOOSE_FRACTION, "v_mag": V_TOL},
            "summary": {k: v for k, v in summary.items() if k != "notes"},
            "objects": fixture,
        }, f, indent=1, ensure_ascii=False)
        f.write("\n")

    manifest = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)
    with open(os.path.join(RAW, "provenance.json"), encoding="utf-8") as f:
        prov = json.load(f)["files"]
    manifest["dso"] = {
        "generator": "tools/starfield/dso.py",
        "inputs": {k: {kk: prov[k][kk] for kk in ("url", "retrieved_utc", "size_bytes", "sha256")}
                   for k in ("wikidata_messier.csv", "wikidata_ngcic.csv", "wikidata_items.csv",
                             "simbad_dso.csv", "corwin_ngcic_pos.tsv", "heasarc_globclust.txt",
                             "heasarc_rc3.txt")},
        "authored_sha256": __import__("hashlib").sha256(open(AUTHORED, "rb").read()).hexdigest(),
        "summary": summary,
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "notes"}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
