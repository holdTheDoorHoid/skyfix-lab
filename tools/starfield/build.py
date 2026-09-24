"""Build the star field's embedded data. Development-time only.

    tools/reference/.venv/bin/python -m tools.starfield.build

Run from the repository root after `python3 -m tools.starfield.fetch`. Needs the
reference virtualenv (Skyfield) for the B1875 frame and for the boundary cross-check.

Reads `tools/starfield/data/` (the raw downloads) and the two files authored for this
project, `tools/starfield/names.txt` and `tools/starfield/figures.txt`. Writes
`crates/skyfix-starfield/data/`:

* `stars.bin` — one 25-byte little-endian record per star, HR order (layout below);
* `names.txt` — `HR|name`;
* `figures.txt` — `abbr|name|label_ra_deg|label_dec_deg|HR-HR HR-HR ...`;
* `boundaries.txt` — `abbr|part|ra_s,dec_arcmin ...`, B1875 corners;
* `manifest.json` — inputs with SHA-256, counts, exclusions and check results.

Every check below either passes or stops the build; nothing is silently accepted.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import struct
import sys

from . import bsc, sky

OUT = os.path.join(bsc.REPO, "crates", "skyfix-starfield", "data")
NAMES_SRC = os.path.join(bsc.HERE, "names.txt")
FIGURES_SRC = os.path.join(bsc.HERE, "figures.txt")
NAV_FILE = os.path.join(bsc.REPO, "fixtures", "reference", "navigational_stars_hip.json")

MAGIC = b"SKYFIXSF"
VERSION = 1
# hr u16, ra u32 (0.1 s), dec i32 (arcsec), pm_ra i16, pm_dec i16 (mas/yr),
# parallax u16 (mas), vmag i16, bv i16 (0.01 mag; -32768 unknown),
# bayer u8, superscript u8, flamsteed u16, constellation u8 (255 none).
RECORD = struct.Struct("<HIihhHhhBBHB")
assert RECORD.size == 25
BV_UNKNOWN = -32768

#: Entries left out on purpose, with the reason. The 14 non-stellar objects are found
#: by bsc.load_stars (no catalogue position, magnitude or proper motion).
EXCLUDE = {
    5958: (
        "T CrB, a recurrent nova. The catalogue's V 2.0 (code H, the original Harvard "
        "magnitude) is its 1866 outburst peak; between outbursts it sits near V 10, far "
        "below the naked-eye limit, so drawing it as a second-magnitude star would put "
        "a star in Corona Borealis that is not there."
    ),
}

#: A figure star may lie outside its constellation's boundary only by this much
#: (Alpheratz, alpha Andromedae, closes the Square of Pegasus; Elnath, beta Tauri,
#: closes the pentagon of Auriga).
MAX_OUTSIDE_DEG = 2.0
#: No stick-figure segment may be longer than this.
MAX_SEGMENT_DEG = 25.0


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Designation resolution
# ---------------------------------------------------------------------------


class Resolver:
    def __init__(self, stars):
        self.by_hr = {s.hr: s for s in stars}
        self.bayer = {}
        self.flamsteed = {}
        for s in stars:
            if s.const == 255:
                continue
            if s.bayer:
                self.bayer.setdefault((s.bayer, s.const), []).append(s)
            if s.flamsteed:
                self.flamsteed.setdefault((s.flamsteed, s.const), []).append(s)
        self.notes = []

    def resolve(self, text):
        t = " ".join(text.split())
        m = re.fullmatch(r"HR (\d+)", t)
        if m:
            hr = int(m.group(1))
            if hr not in self.by_hr:
                raise KeyError("%s: no such star in the display catalogue" % t)
            return self.by_hr[hr]
        m = re.fullmatch(r"(\d+) ([A-Z][A-Za-z]{2})", t)
        if m:
            key = (int(m.group(1)), bsc.ABBR_INDEX.get(m.group(2), -1))
            cands = self.flamsteed.get(key, [])
            return self._pick(t, cands)
        m = re.fullmatch(r"([A-Z][a-z]{1,2})(\d)? ([A-Z][A-Za-z]{2})", t)
        if m:
            g = bsc.GREEK_CODE.get(m.group(1))
            c = bsc.ABBR_INDEX.get(m.group(3))
            if g is None or c is None:
                raise KeyError("%s: unknown Greek letter or constellation" % t)
            cands = self.bayer.get((g, c), [])
            if m.group(2):
                cands = [s for s in cands if s.bayer_sup == int(m.group(2))]
            return self._pick(t, cands)
        raise KeyError("%r is not a designation" % text)

    def _pick(self, t, cands):
        if not cands:
            raise KeyError("%s: not in the catalogue" % t)
        best = min(cands, key=lambda s: (s.vmag_centi, s.hr))
        if len(cands) > 1:
            self.notes.append(
                "%s matches %s; using HR %d (V %.2f), the brightest"
                % (t, ", ".join("HR %d" % s.hr for s in cands), best.hr, best.vmag)
            )
        return best


def read_names(resolver):
    names = []
    seen_hr, seen_name = {}, {}
    with open(NAMES_SRC, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            desig, name = (x.strip() for x in line.split("=", 1))
            s = resolver.resolve(desig)
            if s.hr in seen_hr:
                raise ValueError("names.txt:%d: HR %d already named %r" % (n, s.hr, seen_hr[s.hr]))
            if name in seen_name:
                raise ValueError("names.txt:%d: %r used twice" % (n, name))
            seen_hr[s.hr] = name
            seen_name[name] = s.hr
            names.append((s, name, desig))
    return names


def read_figures(resolver):
    figs = {}
    with open(FIGURES_SRC, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            abbr, chain = line.split(":", 1)
            abbr = abbr.strip()
            if abbr not in bsc.ABBR_INDEX:
                raise ValueError("figures.txt:%d: unknown constellation %r" % (n, abbr))
            stars = [resolver.resolve(x) for x in chain.split(" - ")]
            if len(stars) < 2:
                raise ValueError("figures.txt:%d: a chain needs two stars" % n)
            segs = figs.setdefault(abbr, [])
            for a, b in zip(stars, stars[1:]):
                if a.hr == b.hr:
                    raise ValueError("figures.txt:%d: zero-length segment at HR %d" % (n, a.hr))
                key = (min(a.hr, b.hr), max(a.hr, b.hr))
                if key in [(min(x.hr, y.hr), max(x.hr, y.hr)) for x, y in segs]:
                    raise ValueError("figures.txt:%d: segment HR %d-%d drawn twice" % (n, *key))
                segs.append((a, b))
    missing = [a for a, _ in bsc.CONSTELLATIONS if a not in figs]
    if missing:
        raise ValueError("no figure for %s" % ", ".join(missing))
    return figs


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def sep_deg(u, v):
    d = max(-1.0, min(1.0, sum(a * b for a, b in zip(u, v))))
    return math.degrees(math.acos(d))


def star_unit(s):
    return sky.unit(s.ra_deg, s.dec_deg)


def b1875_of(m, u):
    ra, dec = sky.radec_deg(sky.mat_vec(m, u))
    return ra / 15.0, dec


def constellation_of(regions, m, u):
    ra_h, dec = b1875_of(m, u)
    found = sky.lookup_b1875(regions, ra_h, dec)
    if len(found) != 1:
        raise ValueError("point in %d regions" % len(found))
    return found[0], ra_h, dec


def label_point(abbr, fig_stars, regions, m):
    """The label goes at the figure's centre when that is comfortably inside the
    boundary; otherwise at the interior point nearest that centre which is at least
    `want` degrees from the boundary. Returns J2000 (ra_deg, dec_deg) and notes."""
    vs = [star_unit(s) for s in fig_stars]
    c = [sum(v[i] for v in vs) for i in range(3)]
    norm = math.sqrt(sum(x * x for x in c))
    c = [x / norm for x in c]
    own = [r for r in regions if r.abbr == abbr]

    def inset(ra_h, dec):
        inside = [r for r in own if r.contains(ra_h % 24.0, dec)]
        if not inside:
            return -1.0
        return inside[0].distance_to_boundary_deg(ra_h % 24.0, dec)

    cra, cdec = b1875_of(m, c)
    # Grid of interior points (B1875), 0.25 deg in declination.
    grid = []
    for r in own:
        decs = [d / 60.0 for _, d in r.verts]
        lo_d, hi_d = min(decs), max(decs)
        if r.winding_s != 0:
            lo_d, hi_d = (lo_d, 90.0) if r.contains_ncp else (-90.0, hi_d)
            ra0, ra_lo, ra_hi = 0.0, 0.0, 24.0
        else:
            ra0 = r.verts[0][0] / 3600.0
            offs = [((a / 3600.0 - ra0 + 12.0) % 24.0) - 12.0 for a, _ in r.verts]
            ra_lo, ra_hi = min(offs), max(offs)
        d = lo_d + 0.125
        while d < hi_d:
            step_h = 0.25 / 15.0 / max(math.cos(math.radians(d)), 0.02)
            a = ra_lo + step_h / 2.0
            while a < ra_hi:
                ra_h = (ra0 + a) % 24.0
                if r.contains(ra_h, d):
                    grid.append((ra_h, d, r.distance_to_boundary_deg(ra_h, d)))
                a += step_h
            d += 0.25
    if not grid:
        raise ValueError("%s: no interior grid point" % abbr)
    deepest = max(g[2] for g in grid)
    want = min(1.5, 0.5 * deepest)
    here = inset(cra, cdec)
    if here >= want:
        ra_h, dec, why = cra, cdec, "figure centre"
    else:
        cu = sky.unit(cra * 15.0, cdec)
        ok = [g for g in grid if g[2] >= want]
        ra_h, dec, _ = min(ok, key=lambda g: sep_deg(cu, sky.unit(g[0] * 15.0, g[1])))
        why = "nearest interior point %.2f deg inside the boundary (figure centre is %s)" % (
            want, "outside" if here < 0 else "%.2f deg inside" % here)
    j = sky.mat_t_vec(m, sky.unit(ra_h * 15.0, dec))
    ra_j, dec_j = sky.radec_deg(j)
    return ra_j, dec_j, why


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_boundaries_against_skyfield(regions):
    """Every cell of Skyfield's constellation grid (built from Roman 1987, an
    independent digitisation of Delporte 1930) must fall in the same constellation."""
    from skyfield.functions import load_bundled_npy

    a = load_bundled_npy("constellations.npz")
    sra, sdec = list(a["sorted_ra"]), list(a["sorted_dec"])
    grid, names = a["radec_to_index"], a["indexed_abbreviations"]
    ra_edges = [0.0] + sra + [24.0]
    dec_edges = [-90.0] + sdec + [90.0]
    cells = mismatches = 0
    for i in range(len(sra) + 1):
        for j in range(len(sdec) + 1):
            ra = (ra_edges[i] + ra_edges[i + 1]) / 2.0
            dec = (dec_edges[j] + dec_edges[j + 1]) / 2.0
            mine = [r.abbr for r in sky.lookup_b1875(regions, ra, dec)]
            cells += 1
            if mine != [str(names[grid[i, j]])]:
                mismatches += 1
    lines_ra = set(int(round(x * 3600)) for x in sra)
    lines_dec = set(int(round(x * 60)) for x in sdec)
    mine_ra = set(v[0] for r in regions for v in r.verts) - {0}
    mine_dec = set(v[1] for r in regions for v in r.verts)
    return {
        "cells_compared": cells,
        "cells_disagreeing": mismatches,
        "grid_lines_identical": lines_ra == mine_ra and lines_dec == mine_dec,
    }


def check_vertex_grid(regions):
    """Every point on the grid of boundary RA and Dec values (all exactly on a
    boundary) belongs to exactly one region under the half-open rules."""
    ras = sorted(set(v[0] for r in regions for v in r.verts))
    decs = sorted(set(v[1] for r in regions for v in r.verts))
    bad = 0
    for a in ras:
        for d in decs:
            if len(sky.lookup_b1875(regions, a / 3600.0, d / 60.0)) != 1:
                bad += 1
    return {"points": len(ras) * len(decs), "not_exactly_one_region": bad}


def check_navigational_names(names, resolver):
    with open(NAV_FILE, encoding="utf-8") as f:
        nav = json.load(f)
    by_name = {n: s for s, n, _ in names}
    report = []
    for c in nav["cases"]:
        s = by_name.get(c["name"])
        if s is None:
            raise ValueError("navigational star %r has no entry in names.txt" % c["name"])
        # The Hipparcos file is at epoch J1991.25; 1' covers 8.75 years of the largest
        # proper motion (Rigil Kentaurus, 3.7"/yr) many times over.
        sep = sep_deg(star_unit(s), sky.unit(c["ra_deg"], c["dec_deg"])) * 3600.0
        dm = s.vmag - c["mag"]
        if sep > 60.0 or abs(dm) > 1.0:
            raise ValueError("%s -> HR %d is %.1f\" and %.2f mag from HIP %d"
                             % (c["name"], s.hr, sep, dm, c["hip"]))
        report.append((c["name"], s.hr, sep, dm))
    return report


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    stars_all, skipped = bsc.load_stars()
    excluded = [(s.hr, s.raw["var_id"].strip() or s.ascii_designation(), EXCLUDE[s.hr])
                for s in stars_all if s.hr in EXCLUDE]
    stars = [s for s in stars_all if s.hr not in EXCLUDE]
    if len(excluded) != len(EXCLUDE):
        raise ValueError("an excluded HR number was not found")

    resolver = Resolver(stars)
    names = read_names(resolver)
    figs = read_figures(resolver)

    regions = sky.load_regions()
    m = sky.icrs_to_mean_b1875_matrix()

    vertex_grid = check_vertex_grid(regions)
    if vertex_grid["not_exactly_one_region"]:
        raise ValueError("boundary polygons overlap or leave gaps: %r" % vertex_grid)
    skyfield_grid = check_boundaries_against_skyfield(regions)
    if skyfield_grid["cells_disagreeing"] or not skyfield_grid["grid_lines_identical"]:
        raise ValueError("boundaries disagree with Skyfield's grid: %r" % skyfield_grid)

    nav_report = check_navigational_names(names, resolver)

    # Figure checks.
    outside, longest, fig_rows, label_notes = [], [], [], []
    total_segments = 0
    for abbr, name in bsc.CONSTELLATIONS:
        segs = figs[abbr]
        members = {}
        for a, b in segs:
            members[a.hr] = a
            members[b.hr] = b
            length = sep_deg(star_unit(a), star_unit(b))
            longest.append((length, abbr, a.ascii_designation(), b.ascii_designation()))
            if length > MAX_SEGMENT_DEG:
                raise ValueError("%s: segment %s - %s is %.1f deg" % (
                    abbr, a.ascii_designation(), b.ascii_designation(), length))
        for s in members.values():
            reg, ra_h, dec = constellation_of(regions, m, star_unit(s))
            if reg.abbr != abbr:
                own = [r for r in regions if r.abbr == abbr]
                dist = min(r.distance_to_boundary_deg(ra_h, dec) for r in own)
                if dist > MAX_OUTSIDE_DEG:
                    raise ValueError("%s: %s (HR %d) lies in %s, %.2f deg outside" % (
                        abbr, s.ascii_designation(), s.hr, reg.abbr, dist))
                outside.append((abbr, s.ascii_designation(), s.hr, reg.abbr, dist))
        ra_l, dec_l, why = label_point(abbr, list(members.values()), regions, m)
        if why != "figure centre":
            label_notes.append("%s: %s" % (abbr, why))
        total_segments += len(segs)
        fig_rows.append((abbr, name, ra_l, dec_l, segs))
    longest.sort(reverse=True)

    # ---- Write outputs ----
    os.makedirs(OUT, exist_ok=True)
    blob = bytearray(MAGIC)
    blob += struct.pack("<HHI", VERSION, RECORD.size, len(stars))
    for s in stars:
        blob += RECORD.pack(
            s.hr, s.ra_tenth_s, s.dec_arcsec, s.pm_ra_mas, s.pm_dec_mas, s.parallax_mas,
            s.vmag_centi, BV_UNKNOWN if s.bv_centi is None else s.bv_centi,
            s.bayer, s.bayer_sup, s.flamsteed, s.const,
        )
    with open(os.path.join(OUT, "stars.bin"), "wb") as f:
        f.write(blob)

    header = (
        "# Generated by tools/starfield/build.py; do not edit by hand.\n"
        "# Display-only data (CONVENTIONS 13.6). Provenance: docs/THIRD_PARTY.md,\n"
        "# section \"Star field and constellations\".\n"
    )
    with open(os.path.join(OUT, "names.txt"), "w", encoding="utf-8") as f:
        f.write(header)
        f.write("# HR|name. Star names are facts; for the 58 navigational stars the spelling\n"
                "# is the Nautical Almanac's.\n")
        for s, name, _ in sorted(names, key=lambda x: x[0].hr):
            f.write("%d|%s\n" % (s.hr, name))

    with open(os.path.join(OUT, "figures.txt"), "w", encoding="utf-8") as f:
        f.write(header)
        f.write("# Constellation figures: this project's own drawing (MIT OR Apache-2.0),\n"
                "# authored in tools/starfield/figures.txt by designation.\n"
                "# abbr|name|label_ra_deg|label_dec_deg|segments as HR-HR pairs.\n"
                "# Label positions are ICRS (J2000) directions.\n")
        for abbr, name, ra_l, dec_l, segs in fig_rows:
            f.write("%s|%s|%.4f|%+.4f|%s\n" % (
                abbr, name, ra_l, dec_l, " ".join("%d-%d" % (a.hr, b.hr) for a, b in segs)))

    polys = bsc.load_boundaries()
    with open(os.path.join(OUT, "boundaries.txt"), "w", encoding="utf-8") as f:
        f.write(header)
        f.write("# IAU constellation boundaries (Delporte 1930), mean equator and equinox of\n"
                "# B1875.0: abbr|part|corners as RA seconds of time,Dec arcminutes.\n"
                "# Every edge is an arc of an hour circle or of a parallel; the last corner\n"
                "# joins the first. Octans' three plotting points at the south pole (added\n"
                "# by the digital transcription, not boundary corners) are removed.\n")
        for p in polys:
            verts = [(ra % sky.DAY_S, dec) for ra, dec in p.vertices if abs(dec) != 90 * 60]
            part = p.key[3:] if p.key.startswith("SER") else ""
            f.write("%s|%s|%s\n" % (p.abbr, part, " ".join("%d,%d" % v for v in verts)))

    prov_path = os.path.join(bsc.DATA, "provenance.json")
    with open(prov_path, encoding="utf-8") as f:
        prov = json.load(f)
    manifest = {
        "generator": "tools/starfield/build.py",
        "inputs": {
            "bsc5p.txt": prov["files"]["bsc5p.txt"],
            "bound_18.dat": prov["files"]["bound_18.dat"],
            "datagov_harvest_record.json": prov["files"]["datagov_harvest_record.json"],
            "retrieved_utc": prov["retrieved_utc"],
            "bsc5p_query": prov["bsc5p_query"],
            "names.txt (authored)": {"sha256": sha256_file(NAMES_SRC)},
            "figures.txt (authored)": {"sha256": sha256_file(FIGURES_SRC)},
        },
        "licence": {
            "stars": "U.S. Government Work: data.gov lists %s with licence %s (publisher: %s, "
                     "modified %s)" % (prov["datagov_identifier"], prov["datagov_license"],
                                       prov["datagov_publisher"], prov["datagov_modified"]),
            "figures": "this project's own drawing, MIT OR Apache-2.0",
            "boundaries": "IAU definitions of Delporte (1930): published facts, public domain",
            "names": "facts",
        },
        "counts": {
            "bsc5p_rows": len(stars_all) + len(skipped),
            "stars": len(stars),
            "skipped_non_stellar": len(skipped),
            "excluded": len(excluded),
            "without_bv": sum(1 for s in stars if s.bv_centi is None),
            "with_designation": sum(1 for s in stars if s.designation()),
            "names": len(names),
            "figures": len(fig_rows),
            "figure_segments": total_segments,
            "boundary_polygons": len(polys),
            "boundary_corners": sum(len([v for v in p.vertices if abs(v[1]) != 5400]) for p in polys),
        },
        "skipped_non_stellar": [{"hr": hr, "catalogue_name": n} for hr, n, _ in skipped],
        "excluded": [{"hr": hr, "name": n, "reason": r} for hr, n, r in excluded],
        "stars_bin": {
            "magic": MAGIC.decode(),
            "version": VERSION,
            "record_bytes": RECORD.size,
            "layout": "hr u16, ra u32 (0.1 s of time, J2000), dec i32 (arcsec, J2000), "
                      "pm_ra i16 (mas/yr, mu_alpha cos delta), pm_dec i16 (mas/yr), "
                      "parallax u16 (mas; negative published values stored as 0), "
                      "vmag i16 (0.01 mag), bv i16 (0.01 mag, -32768 unknown), "
                      "bayer u8 (0 none, 1-24 alpha-omega), superscript u8, flamsteed u16, "
                      "constellation u8 (index into the 88, alphabetical by IAU "
                      "abbreviation as in bsc.CONSTELLATIONS; 255 none); little-endian",
            "bytes": len(blob),
            "sha256": hashlib.sha256(bytes(blob)).hexdigest(),
        },
        "checks": {
            "boundary_vertex_grid": vertex_grid,
            "boundaries_vs_skyfield_grid": skyfield_grid,
            "figure_stars_outside_their_constellation": [
                {"figure": a, "star": d, "hr": hr, "lies_in": c, "deg_outside": round(x, 3)}
                for a, d, hr, c, x in outside
            ],
            "longest_segments_deg": [
                {"figure": a, "from": x, "to": y, "deg": round(length, 2)}
                for length, a, x, y in longest[:8]
            ],
            "labels_moved_off_the_figure_centre": label_notes,
            "navigational_names": {
                "count": len(nav_report),
                "max_separation_arcsec_vs_hipparcos_j1991_25": round(max(r[2] for r in nav_report), 2),
                "max_abs_mag_difference": round(max(abs(r[3]) for r in nav_report), 2),
            },
            "multiple_catalogue_matches_resolved_to_brightest": sorted(set(resolver.notes)),
        },
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")

    sizes = {n: os.path.getsize(os.path.join(OUT, n)) for n in sorted(os.listdir(OUT))}
    print("stars %d (skipped %d non-stellar, excluded %d)" % (len(stars), len(skipped), len(excluded)))
    print("names %d, figures %d with %d segments" % (len(names), len(fig_rows), total_segments))
    print("boundaries: vertex grid %r; Skyfield grid %r" % (vertex_grid, skyfield_grid))
    print("figure stars outside their constellation:", outside)
    print("longest segments:", [(round(x[0], 1),) + x[1:] for x in longest[:5]])
    print("labels moved:", label_notes)
    print("data sizes:", sizes, "total", sum(v for k, v in sizes.items() if k != "manifest.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
