"""crates/skyfix-ephemeris/data/vsop87a_planets.json -- truncated VSOP87A series.

Development-time only (CONVENTIONS section 11). Nothing here is a runtime
dependency: the Rust planet provider reads the JSON this writes, and nothing else.

Input: the CDS catalogue VI/81 (Bretagnon & Francou 1988) files

    VSOP87A.ear VSOP87A.mer VSOP87A.ven VSOP87A.mar
    VSOP87A.jup VSOP87A.sat VSOP87A.ura VSOP87A.nep   vsop87.chk

from https://cdsarc.cds.unistra.fr/ftp/cats/VI/81/, downloaded into
tools/reference/data/vsop87/ (git-ignored; `make -C tools/reference vsop87`), or
any directory given with --source. The script refuses files whose SHA-256 is not
the one recorded below, so a regenerated data file always comes from the same
published series.

VSOP87A is heliocentric rectangular X, Y, Z in au, referred to the dynamical
ecliptic and equinox J2000, as functions of TT. The EARTH series is used, not the
Earth-Moon barycentre: the EMB sits up to 4 700 km from the Earth, which is several
arcseconds of Venus near inferior conjunction.

Truncation rule (the same idea as the Sun's VSOP87D file, but judged on the
*measured* error, because the worst-case sum over thousands of dropped terms is
about ten times the error that actually occurs and would force two to three times
as many terms):

  * a term  A T^a cos(B + C T)  is kept when its peak contribution over the
    window, |A| * T_abs^a, exceeds a per-body threshold;
  * the threshold is the largest one for which the vector sum of every dropped
    term, evaluated on a 1-day grid across the window, stays inside the body's
    budget with a 10 % margin, and the result is then re-measured on a 6-hour
    grid, which must also be inside the budget;
  * the budget is 0.2 arcsec of geocentric direction at the body's closest
    approach to the Earth in the window: budget_au = 0.2" x min distance. For the
    Earth, whose error moves every planet, the closest approach of any planet
    (Venus at inferior conjunction) is used.

The window is 1989-12-31 to 2061-01-02 TT: the provider's coverage (1990-01-01 to
2060-12-31) plus a day either side, because light-time evaluates Neptune up to
4.2 hours before the requested instant.

Run from the repository root:

    tools/reference/.venv/bin/python -m tools.reference.gen_vsop87a [--source DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

import numpy as np

from . import common as c

ARCSEC = math.pi / 648000.0
JD_J2000 = 2451545.0
TJY_DAYS = 365250.0

#: 1989-12-31T00:00 TT and 2061-01-02T00:00 TT.
WINDOW_JD = (2447891.5, 2473826.5)
T_ABS = max(abs(w - JD_J2000) for w in WINDOW_JD) / TJY_DAYS

SELECT_STEP_DAYS = 1.0
VERIFY_STEP_DAYS = 0.25
MARGIN = 0.9
BUDGET_ARCSEC = 0.2

OUT = os.path.join(c.REPO, "crates", "skyfix-ephemeris", "data", "vsop87a_planets.json")
DEFAULT_SOURCE = os.path.join(c.DATA, "vsop87")
URL = "https://cdsarc.cds.unistra.fr/ftp/cats/VI/81/"
RETRIEVED = "2026-09-24"

#: name in the output, VSOP87A file, body name in vsop87.chk
BODIES = [
    ("Earth", "VSOP87A.ear", "EARTH"),
    ("Mercury", "VSOP87A.mer", "MERCURY"),
    ("Venus", "VSOP87A.ven", "VENUS"),
    ("Mars", "VSOP87A.mar", "MARS"),
    ("Jupiter", "VSOP87A.jup", "JUPITER"),
    ("Saturn", "VSOP87A.sat", "SATURN"),
    ("Uranus", "VSOP87A.ura", "URANUS"),
    ("Neptune", "VSOP87A.nep", "NEPTUNE"),
]

#: SHA-256 of the files as retrieved on RETRIEVED.
SHA256 = {
    "VSOP87A.ear": "69d0b4c7525f094a03099e64558321eb64f2402a478472ee537239bcc59b7cb6",
    "VSOP87A.mer": "01f6f82af31f347fc50affaa920d653e441fc74f2b4738166528adc4c78fa870",
    "VSOP87A.ven": "ecaeceff071db6692820d962ffabfdb7de438db44145bfe0cbcda70f8dbed2a8",
    "VSOP87A.mar": "2c1e9b5cd68276138c2f99506d348e626abe0a5c600b4e50bb588d568b0d13fe",
    "VSOP87A.jup": "212bcea552e759fa0a9d732680c05120de2c15d36049b2f6d115ceb25b03d405",
    "VSOP87A.sat": "2e72d18684246e2ecd143e35736b45b101cdd06bbcaf2f2502e348c233abff29",
    "VSOP87A.ura": "6fb9626c770eb9972a86050e151cc866e703f503261c79ba0691160e727bf0b9",
    "VSOP87A.nep": "4ad09bd799336d8f76dcf6f98be57c45d7289db134556c204f098d6bbf888f3a",
    "vsop87.chk": "f8fa52449262be05a22a96840c1acbad0b35c8999e00b5c0477ba8a91a67a51a",
    "vsop87.txt": "8e2067276413f2feffde70a4292d8b3dc70b8c0355ff5d00a7ccdf4c3af5f121",
}

#: vsop87.txt, "REFERENCE SYSTEM": VSOP87A ecliptic J2000 -> equator J2000 (FK5).
ROTATION_TO_EQUATOR = [
    [1.000000000000, 0.000000440360, -0.000000190919],
    [-0.000000479966, 0.917482137087, -0.397776982902],
    [0.000000000000, 0.397776982902, 0.917482137087],
]


# ---------------------------------------------------------------------------
# Reading the catalogue
# ---------------------------------------------------------------------------


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_series(path):
    """Return {coord 1..3: [terms for T^0, T^1, ...]}, each term (A, B, C).

    Header records (vsop87.txt): `ic` in column 42, `it` in column 60, `in` in
    columns 61-67. Term records: A in columns 80-97, B in 98-111, C in 112-131.
    The terms keep the file's order (decreasing amplitude).
    """
    series = {}
    cur = None
    counts = {}
    with open(path, encoding="ascii") as f:
        for line in f:
            if line.startswith(" VSOP87"):
                ic, it, n = int(line[41]), int(line[59]), int(line[60:67])
                series.setdefault(ic, {})[it] = []
                counts[(ic, it)] = n
                cur = (ic, it)
            elif line.strip():
                a_text, b_text, c_text = line[79:97], line[97:111], line[111:131]
                series[cur[0]][cur[1]].append((float(a_text), float(b_text), float(c_text)))
    for (ic, it), n in counts.items():
        if len(series[ic][it]) != n:
            raise ValueError("%s: series %d/%d has %d terms, header says %d"
                             % (path, ic, it, len(series[ic][it]), n))
    return {ic: [series[ic].get(a, []) for a in range(max(series[ic]) + 1)] for ic in (1, 2, 3)}


def parse_checks(path):
    """VSOP87A check values from vsop87.chk: {(BODY, jd): (xyz, vxyz)}."""
    out = {}
    with open(path, encoding="ascii") as f:
        lines = f.read().splitlines()
    for i, line in enumerate(lines):
        if line.startswith(" VSOP87A "):
            body = line[10:22].strip()
            jd = float(line.split("JD")[1].split()[0])
            p = lines[i + 1].split()
            v = lines[i + 2].split()
            xyz = [float(p[1]), float(p[4]), float(p[7])]
            vxyz = [float(v[1]), float(v[4]), float(v[7])]
            out[(body, jd)] = (xyz, vxyz)
    return out


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def flatten(ser):
    """Rows (coord, power, index, A, B, C, peak) for every term."""
    rows = []
    for ic in (1, 2, 3):
        for a, terms in enumerate(ser[ic]):
            for j, (A, B, C) in enumerate(terms):
                rows.append((ic, a, j, A, B, C, abs(A) * T_ABS ** a))
    return np.array(rows)


def sum_rows(rows, T, derivative=False):
    """Vector sum of the given term rows at times T (tjy). Shape (3, len(T))."""
    out = np.zeros((3, T.size))
    for start in range(0, len(rows), 256):
        r = rows[start:start + 256]
        ic = r[:, 0].astype(int)
        a = r[:, 1][:, None]
        A, B, C = r[:, 3][:, None], r[:, 4][:, None], r[:, 5][:, None]
        arg = B + C * T[None, :]
        tp = T[None, :] ** a
        if derivative:
            val = -A * C * np.sin(arg) * tp + np.where(
                a > 0, a * A * np.cos(arg) * T[None, :] ** np.maximum(a - 1, 0), 0.0
            )
        else:
            val = A * np.cos(arg) * tp
        for k in (1, 2, 3):
            sel = ic == k
            if sel.any():
                out[k - 1] += val[sel].sum(0)
    return out


def grid(step_days):
    jd = np.arange(WINDOW_JD[0], WINDOW_JD[1] + 1e-9, step_days)
    return jd, (jd - JD_J2000) / TJY_DAYS


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------


def choose_threshold(rows, budget_au, T):
    """Fewest kept terms (largest peak threshold) whose dropped remainder stays
    inside MARGIN * budget on the grid T. Returns (threshold, kept mask)."""
    peaks = np.sort(rows[:, 6])[::-1]
    lo, hi = 1, len(peaks) - 1

    def ok(n_keep):
        drop = rows[:, 6] <= peaks[n_keep]
        err = np.linalg.norm(sum_rows(rows[drop], T), axis=0).max()
        return err <= MARGIN * budget_au

    while lo < hi:
        mid = (lo + hi) // 2
        if ok(mid):
            hi = mid
        else:
            lo = mid + 1
    threshold = peaks[lo]
    return threshold, rows[:, 6] > threshold


DE440S_KEYS = {
    "Mercury": "mercury",
    "Venus": "venus",
    "Mars": "mars barycenter",
    "Jupiter": "jupiter barycenter",
    "Saturn": "saturn barycenter",
    "Uranus": "uranus barycenter",
    "Neptune": "neptune barycenter",
}


def dense_vs_de440s(jd, pos_at):
    """{planet: stats} comparing geometric geocentric directions from the truncated
    series (rotated to the equator with ROTATION_TO_EQUATOR) with DE440s, both
    heliocentric, at TDB = the given Julian dates."""
    if not os.path.exists(c.EPHEMERIS_CROSSCHECK_FILE):
        print("   DE440s not found; dense comparison skipped")
        return {}
    eph = c.load_ephemeris(c.EPHEMERIS_CROSSCHECK_FILE)
    ts = c.load_timescale()
    t = ts.tdb_jd(jd)
    T = (jd - JD_J2000) / TJY_DAYS
    rot = np.array(ROTATION_TO_EQUATOR)
    sun = eph["sun"].at(t).position.au
    e_de = eph["earth"].at(t).position.au - sun
    e_vs = rot @ pos_at("Earth", T)
    out = {}
    for name, key in DE440S_KEYS.items():
        g_de = eph[key].at(t).position.au - sun - e_de
        g_vs = rot @ pos_at(name, T) - e_vs
        u_de = g_de / np.linalg.norm(g_de, axis=0)
        u_vs = g_vs / np.linalg.norm(g_vs, axis=0)
        sep = np.arctan2(np.linalg.norm(np.cross(u_de.T, u_vs.T), axis=1),
                         (u_de * u_vs).sum(0)) / ARCSEC
        ra_de, ra_vs = np.arctan2(u_de[1], u_de[0]), np.arctan2(u_vs[1], u_vs[0])
        d_ra = (ra_vs - ra_de + np.pi) % (2 * np.pi) - np.pi
        d_dec = np.arcsin(np.clip(u_vs[2], -1, 1)) - np.arcsin(np.clip(u_de[2], -1, 1))
        out[name] = {
            "epochs": int(jd.size),
            "step_days": c.Num(float(jd[1] - jd[0]), 2),
            "max_separation_arcsec": c.Num(float(sep.max()), 4),
            "max_ra_arcmin": c.Num(float(np.abs(d_ra).max()) / ARCSEC / 60.0, 5),
            "max_dec_arcmin": c.Num(float(np.abs(d_dec).max()) / ARCSEC / 60.0, 5),
            "worst_jd_tdb": c.Num(float(jd[sep.argmax()]), 1),
        }
        print("   %-8s vs DE440s daily: separation %.4f\", RA %.5f', Dec %.5f'"
              % (name, sep.max(), out[name]["max_ra_arcmin"].v, out[name]["max_dec_arcmin"].v))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", default=DEFAULT_SOURCE,
                    help="directory holding the VI/81 files (default %(default)s)")
    args = ap.parse_args(argv)

    files = {}
    for name in [b[1] for b in BODIES] + ["vsop87.chk", "vsop87.txt"]:
        path = os.path.join(args.source, name)
        if not os.path.exists(path):
            print("missing %s -- fetch it with:\n  curl -fsSL -o %s %s%s"
                  % (path, path, URL, name))
            return 1
        digest = sha256(path)
        if digest != SHA256[name]:
            print("%s has SHA-256 %s, expected %s" % (path, digest, SHA256[name]))
            return 1
        files[name] = {"file": name, "url": URL + name, "sha256": digest,
                       "size_bytes": os.path.getsize(path)}

    series = {name: parse_series(os.path.join(args.source, fname)) for name, fname, _ in BODIES}
    checks = parse_checks(os.path.join(args.source, "vsop87.chk"))
    rows = {name: flatten(series[name]) for name, _, _ in BODIES}

    # 1. The full series must reproduce the catalogue's own check values.
    worst_chk = 0.0
    for name, _, chk_name in BODIES:
        xyz, vxyz = checks[(chk_name, JD_J2000)]
        T0 = np.array([0.0])
        p = sum_rows(rows[name], T0)[:, 0]
        v = sum_rows(rows[name], T0, derivative=True)[:, 0] / TJY_DAYS
        worst_chk = max(worst_chk, float(np.abs(p - xyz).max()))
        # vsop87.chk prints 10 decimals, so agreement is to its rounding.
        if np.abs(p - xyz).max() > 1e-10 or np.abs(v - vxyz).max() > 2e-10:
            raise SystemExit("%s: full series disagrees with vsop87.chk: %s vs %s"
                             % (name, p, xyz))
    print("   full series reproduce vsop87.chk at J2000 to %.1e au" % worst_chk)

    # 2. Geometry: closest approach of each planet to the Earth in the window.
    jd_sel, T_sel = grid(SELECT_STEP_DAYS)
    full = {name: sum_rows(rows[name], T_sel) for name, _, _ in BODIES}
    min_dist = {}
    for name, _, _ in BODIES[1:]:
        min_dist[name] = float(np.linalg.norm(full[name] - full["Earth"], axis=0).min())
    min_dist["Earth"] = min(min_dist.values())

    # 3. Choose thresholds on the 1-day grid.
    kept = {}
    thresholds = {}
    budgets = {}
    for name, _, _ in BODIES:
        budgets[name] = BUDGET_ARCSEC * ARCSEC * min_dist[name]
        thresholds[name], kept[name] = choose_threshold(rows[name], budgets[name], T_sel)
        print("   %-8s keep %5d of %5d  (threshold %.3e au, budget %.3e au)"
              % (name, kept[name].sum(), len(rows[name]), thresholds[name], budgets[name]))

    # 4. Re-measure on the 6-hour grid: heliocentric vector error, the Earth's
    #    velocity error, and the geocentric direction error of every planet
    #    (planet and Earth truncation together, at the actual geometry).
    jd_ver, T_ver = grid(VERIFY_STEP_DAYS)
    err = {}
    pos = {}
    for name, _, _ in BODIES:
        drop = ~kept[name]
        err[name] = sum_rows(rows[name][drop], T_ver)
        pos[name] = sum_rows(rows[name][~drop], T_ver)
    derr_earth = sum_rows(rows["Earth"][~kept["Earth"]], T_ver, derivative=True) / TJY_DAYS
    report = {}
    for name, _, _ in BODIES:
        helio = float(np.linalg.norm(err[name], axis=0).max())
        if helio > budgets[name]:
            raise SystemExit("%s: re-measured error %.3e au exceeds its budget %.3e au"
                             % (name, helio, budgets[name]))
        entry = {
            "budget_au": c.Num(budgets[name], 12),
            "closest_approach_au": c.Num(min_dist[name], 6),
            "threshold_peak_au": c.Num(thresholds[name], 14),
            "terms_kept": int(kept[name].sum()),
            "terms_total": int(len(rows[name])),
            "terms_kept_xyz": [int(((rows[name][:, 0] == k) & kept[name]).sum()) for k in (1, 2, 3)],
            "measured_max_error_au": c.Num(helio, 12),
        }
        if name == "Earth":
            entry["measured_max_velocity_error_au_per_day"] = c.Num(
                float(np.linalg.norm(derr_earth, axis=0).max()), 14)
        else:
            g = pos[name] - pos["Earth"]
            d = err[name] - err["Earth"]
            u = g / np.linalg.norm(g, axis=0)
            perp = d - u * (d * u).sum(0)
            ang = np.linalg.norm(perp, axis=0) / np.linalg.norm(g, axis=0) / ARCSEC
            entry["measured_max_geocentric_error_arcsec"] = c.Num(float(ang.max()), 4)
            entry["measured_max_geocentric_error_jd_tt"] = c.Num(float(jd_ver[ang.argmax()]), 2)
        report[name] = entry
        print("   %-8s re-measured on %d epochs: %.3e au%s"
              % (name, T_ver.size, helio,
                 "" if name == "Earth" else ", geocentric %.4f\"" %
                 entry["measured_max_geocentric_error_arcsec"].v))

    # 5. Dense comparison with JPL DE440s: the *truncated* series against the
    #    numerical ephemeris every day of the window, as geometric geocentric
    #    directions on the equatorial axes. The fixtures test the whole apparent-place
    #    pipeline at a few hundred epochs; this bounds the theory's own error between
    #    them. Skipped (and recorded as skipped) if DE440s is not present.
    dense = dense_vs_de440s(jd_sel, pos_at=lambda name, T: sum_rows(rows[name][kept[name]], T))
    for name in report:
        if name in dense:
            report[name]["dense_vs_de440s"] = dense[name]

    # 6. Checkpoints: the catalogue's own J2000 values, and the full series at
    #    eight instants spread over the window, so the Rust side can prove the
    #    embedded file is intact and truncated as recorded.
    checkpoints = []
    check_jds = [2447892.5, 2451545.0, 2455197.5, 2458849.5, 2462502.5, 2466154.5,
                 2469807.5, 2473825.5]
    for name, _, chk_name in BODIES:
        xyz, vxyz = checks[(chk_name, JD_J2000)]
        checkpoints.append(c.Inline({
            "body": name,
            "jd_tt": c.Num(JD_J2000, 1),
            "xyz_au": c.Inline([c.Num(v, 10) for v in xyz]),
            "source": "vsop87.chk (CDS VI/81), VSOP87A %s JD2451545.0" % chk_name,
        }))
        for jd in check_jds:
            T = np.array([(jd - JD_J2000) / TJY_DAYS])
            p = sum_rows(rows[name], T)[:, 0]
            checkpoints.append(c.Inline({
                "body": name,
                "jd_tt": c.Num(jd, 1),
                "xyz_au": c.Inline([c.Num(v, 13) for v in p]),
                "source": "full VSOP87A series",
            }))

    doc = {
        "schema": "skyfix.vsop87a_trunc/1",
        "source": {
            "catalogue": "VI/81  Planetary Solutions VSOP87 (Bretagnon P., Francou G., 1988)",
            "reference": "Astron. Astrophys. 202, 309 (1988), 1988A&A...202..309B",
            "url": URL,
            "retrieved_utc": RETRIEVED,
            "files": [files[n] for n in sorted(files)],
            "licence": (
                "CDS/VizieR catalogue data, freely usable with acknowledgement of the "
                "Centre de Donnees astronomiques de Strasbourg and citation of "
                "Bretagnon & Francou (1988)"
            ),
            "frame": (
                "heliocentric rectangular X, Y, Z in au; dynamical ecliptic and equinox "
                "J2000 (vsop87.txt, REFERENCE SYSTEM)"
            ),
            "rotation_to_equator_j2000": [
                c.Inline([c.Num(v, 12) for v in row]) for row in ROTATION_TO_EQUATOR
            ],
            "rotation_note": (
                "vsop87.txt gives this matrix as the rotation from the VSOP87A ecliptic "
                "frame to the FK5 equator J2000. The frame it produces is DE200's, which "
                "is within about 0.03 arcsec of the ICRS; measured against DE440s it "
                "fits better without the FK5-to-ICRS frame bias than with it, so none "
                "is applied."
            ),
            "time_argument": (
                "T = (JD - 2451545.0) / 365250, thousands of Julian years of dynamical "
                "time; vsop87.txt: TT = TAI + 32.184 s may be used"
            ),
            "term": "A * T**n * cos(B + C * T); A in au, B in rad, C in rad per thousand years",
            "earth_not_emb": (
                "VSOP87A.ear is the Earth itself. The Earth-Moon barycentre (VSOP87A.emb) "
                "is up to 4 700 km away, several arcseconds of Venus near inferior "
                "conjunction."
            ),
            "stated_precision": (
                "vsop87.txt: 1 arcsec over 4000 years around J2000 for Mercury to Mars, "
                "2000 years for Jupiter and Saturn, 6000 years for Uranus and Neptune; "
                "relative precision p0 (1e-8) Mercury 0.6, Venus 2.5, Earth 2.5, Mars 10, "
                "Jupiter 35, Saturn 70, Uranus 8, Neptune 42. The series were fitted to "
                "JPL DE200."
            ),
        },
        "truncation": {
            "rule": (
                "keep a term when |A| * T_abs**n exceeds the body's threshold; the "
                "threshold is the largest for which the vector sum of the dropped terms, "
                "evaluated every %g days over the window, stays inside %g of the budget; "
                "then re-measured every %g days, where it must stay inside the budget. "
                "Budget: %g arcsec of geocentric direction at the body's closest approach "
                "to the Earth in the window (for the Earth itself, the closest approach "
                "of any planet)."
                % (SELECT_STEP_DAYS, MARGIN, VERIFY_STEP_DAYS, BUDGET_ARCSEC)
            ),
            "window_jd_tt": c.Inline([c.Num(WINDOW_JD[0], 1), c.Num(WINDOW_JD[1], 1)]),
            "window_utc": "1989-12-31 .. 2061-01-02 (coverage 1990-01-01 .. 2060-12-31 plus a day either side for light-time)",
            "t_abs": c.Num(T_ABS, 12),
            "budget_arcsec": c.Num(BUDGET_ARCSEC, 2),
            "verify_step_days": c.Num(VERIFY_STEP_DAYS, 2),
            "verify_epochs": int(T_ver.size),
            "bodies": report,
            "terms_kept": int(sum(k.sum() for k in kept.values())),
            "terms_total": int(sum(len(r) for r in rows.values())),
        },
        "checkpoints": checkpoints,
    }

    text = render(doc, series, kept)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %s  %.1f KiB, %d of %d terms"
          % (os.path.relpath(OUT, c.REPO), len(text) / 1024.0,
             doc["truncation"]["terms_kept"], doc["truncation"]["terms_total"]))
    return 0


def render(doc, series, kept):
    """The header through the common deterministic writer, then the series one term
    per line (shortest round-trip floats), so the file stays diffable and small."""
    head = c._render(doc, 0)
    assert head.endswith("\n}")
    parts = [head[:-2] + ',\n "bodies": {\n']
    names = [b[0] for b in BODIES]
    for bi, name in enumerate(names):
        parts.append('  "%s": {\n' % name)
        # `kept[name]` is aligned with flatten(): coordinate, then power, then the
        # file's term order. Walk the series in that same order.
        kmask = iter(kept[name])
        for ci, coord in enumerate("xyz"):
            ic = ci + 1
            parts.append('   "%s": [\n' % coord)
            powers = series[name][ic]
            for a, terms in enumerate(powers):
                sel = [t for t in terms if next(kmask)]
                body = ",\n".join("[%s,%s,%s]" % (repr(A), repr(B), repr(C)) for A, B, C in sel)
                parts.append("    [\n" + body + ("\n" if sel else "") + "    ]")
                parts.append(",\n" if a < len(powers) - 1 else "\n")
            parts.append("   ]" + (",\n" if ci < 2 else "\n"))
        parts.append("  }" + (",\n" if bi < len(names) - 1 else "\n"))
    parts.append(" }\n}\n")
    text = "".join(parts)
    json.loads(text)  # must be valid JSON
    return text


if __name__ == "__main__":
    sys.exit(main())
