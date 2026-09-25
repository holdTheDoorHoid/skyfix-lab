"""VSOP87A reading, evaluation and truncation (Bretagnon & Francou 1988, CDS VI/81).

Development-time only (CONVENTIONS section 11). Shared by `build_series.py`, which
writes the series the Rust Sun and planet providers embed, and by the validation
generators. Nothing here is a runtime dependency.

VSOP87A is heliocentric rectangular X, Y, Z in au, referred to the dynamical ecliptic
and equinox J2000, as functions of TT (T in thousands of Julian years from J2000).
Every term is `A * T**n * cos(B + C * T)`.
"""

from __future__ import annotations

import hashlib
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
#: Where `make -C tools/reference vsop87` puts the catalogue files.
DEFAULT_SOURCE = os.path.join(HERE, "data", "vsop87")
#: The copy the accuracy audit used (same files, same SHA-256).
ALT_SOURCE = os.path.join(HERE, "data", "series", "vsop87")
URL = "https://cdsarc.cds.unistra.fr/ftp/cats/VI/81/"
RETRIEVED = "2026-09-24"
JD_J2000 = 2451545.0
TJY_DAYS = 365250.0

#: name, VSOP87A file, body name in vsop87.chk
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

#: SHA-256 of the CDS VI/81 files (retrieved 2026-09-24; the same values as
#: gen_vsop87a.py recorded).
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
ROTATION_TO_EQUATOR = np.array([
    [1.000000000000, 0.000000440360, -0.000000190919],
    [-0.000000479966, 0.917482137087, -0.397776982902],
    [0.000000000000, 0.397776982902, 0.917482137087],
])


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_source(source=None):
    for cand in [source, DEFAULT_SOURCE, ALT_SOURCE]:
        if cand and os.path.exists(os.path.join(cand, "VSOP87A.ear")):
            return cand
    raise SystemExit(
        "VSOP87A files not found; fetch them with `make -C tools/reference vsop87` "
        "(CDS VI/81 into %s)" % DEFAULT_SOURCE)


def verify(source, names):
    rows = []
    for name in names:
        path = os.path.join(source, name)
        digest = sha256(path)
        if digest != SHA256[name]:
            raise SystemExit("%s has SHA-256 %s, expected %s" % (path, digest, SHA256[name]))
        rows.append({"file": name, "url": URL + name, "sha256": digest,
                     "bytes": os.path.getsize(path)})
    return rows


class Terms:
    """All terms of one body as flat arrays: coord (0..2), power, A, B, C."""

    def __init__(self, coord, power, A, B, C):
        self.coord = np.asarray(coord, dtype=np.int64)
        self.power = np.asarray(power, dtype=np.int64)
        self.A = np.asarray(A, dtype=float)
        self.B = np.asarray(B, dtype=float)
        self.C = np.asarray(C, dtype=float)

    def __len__(self):
        return len(self.A)

    def subset(self, mask):
        return Terms(self.coord[mask], self.power[mask], self.A[mask], self.B[mask], self.C[mask])

    def xyz(self, T, mask=None, derivative=False, chunk=256):
        """Vector sum at times T (thousands of Julian years of TT). Shape (3, len(T)).
        With `derivative`, d/dT instead (au per thousand years)."""
        T = np.atleast_1d(np.asarray(T, dtype=float))
        idx = np.arange(len(self)) if mask is None else np.flatnonzero(mask)
        out = np.zeros((3, T.size))
        for s in range(0, len(idx), chunk):
            j = idx[s:s + chunk]
            a = self.power[j][:, None]
            A, B, C = self.A[j][:, None], self.B[j][:, None], self.C[j][:, None]
            arg = B + C * T[None, :]
            if derivative:
                tpm1 = np.where(a > 0, T[None, :] ** np.maximum(a - 1, 0), 0.0)
                val = -A * C * np.sin(arg) * T[None, :] ** a + a * A * np.cos(arg) * tpm1
            else:
                val = A * np.cos(arg) * T[None, :] ** a
            for k in range(3):
                sel = self.coord[j] == k
                if sel.any():
                    out[k] += val[sel].sum(0)
        return out


def parse(path):
    """One VSOP87A file -> Terms, in the file's order (decreasing amplitude within
    each coordinate and power). Header records carry `ic` in column 42, `it` in
    column 60 and the count in columns 61-67; term records A in columns 80-97, B in
    98-111, C in 112-131 (vsop87.txt)."""
    coord, power, A, B, C = [], [], [], [], []
    counts = {}
    cur = None
    with open(path, encoding="ascii") as f:
        for line in f:
            if line.startswith(" VSOP87"):
                ic, it, n = int(line[41]), int(line[59]), int(line[60:67])
                counts[(ic, it)] = n
                cur = (ic - 1, it)
            elif line.strip():
                coord.append(cur[0])
                power.append(cur[1])
                A.append(float(line[79:97]))
                B.append(float(line[97:111]))
                C.append(float(line[111:131]))
    t = Terms(coord, power, A, B, C)
    for (ic, it), n in counts.items():
        got = int(((t.coord == ic - 1) & (t.power == it)).sum())
        if got != n:
            raise ValueError("%s: series %d/%d has %d terms, header says %d" % (path, ic, it, got, n))
    return t


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
            out[(body, jd)] = ([float(p[1]), float(p[4]), float(p[7])],
                               [float(v[1]), float(v[4]), float(v[7])])
    return out


def load_all(source=None, check=True):
    """{name: Terms} for the Earth and the seven planets, verified against
    vsop87.chk at J2000 (the catalogue's own published values)."""
    source = find_source(source)
    prov = verify(source, [b[1] for b in BODIES] + ["vsop87.chk", "vsop87.txt"])
    series = {name: parse(os.path.join(source, fname)) for name, fname, _ in BODIES}
    if check:
        chk = parse_checks(os.path.join(source, "vsop87.chk"))
        for name, _, chk_name in BODIES:
            xyz, vxyz = chk[(chk_name, JD_J2000)]
            p = series[name].xyz(np.array([0.0]))[:, 0]
            v = series[name].xyz(np.array([0.0]), derivative=True)[:, 0] / TJY_DAYS
            if np.abs(p - xyz).max() > 1e-10 or np.abs(v - vxyz).max() > 2e-10:
                raise SystemExit("%s: full series disagrees with vsop87.chk" % name)
    return series, prov, source


def tjy(jd):
    return (np.asarray(jd, dtype=float) - JD_J2000) / TJY_DAYS
