"""Build crates/skyfix-ephemeris/data/elp82b_moon_terms.json from CDS VI/79.

Development-time only (CONVENTIONS section 11): this script produces the lunar
theory data that `skyfix_ephemeris::moon` embeds with `include_str!`. It is not a
reference fixture and never reads Rust output. It needs the 36 series files of
ELP 2000-82B (Chapront-Touze & Chapront), which it downloads from the CDS on
request and always checks against the SHA-256 digests pinned below:

    tools/reference/.venv/bin/python -m tools.reference.build_moon_series --fetch
    tools/reference/.venv/bin/python -m tools.reference.build_moon_series \
        --source-dir /path/to/VI/79

What it does, in order:

1. Parses every file with the record formats of the notice (`elp82b.ps`, sect. 2.2)
   and of the reference subroutine `elp82b.f`.
2. Evaluates the complete theory exactly as `elp82b.f` does (including the
   corrections of the constants fitted to DE200/LE200, notice sect. 7) and asserts
   that it reproduces the five check values of the notice's Table H to 1e-5 km.
3. Keeps a term when its peak contribution over the coverage window,
   |A| * |t|max**p (p = the power of t that multiplies the series), reaches the
   threshold of its coordinate. Everything else is dropped.
4. Measures the truncation error: the kept series against the complete one at
   20 000 random epochs spanning the window, per coordinate and as a position
   error, plus the rigorous worst case (sum of the peak contributions of every
   dropped term).
5. Writes the kept records verbatim (the period column is dropped; it is
   informative only), the truncation block, the provenance and two kinds of
   checkpoints: the notice's own Table H values (complete theory) and the
   truncated series evaluated here at seven epochs inside the window.

The runtime model (frame rotation, light-time, apparent place) lives in
`crates/skyfix-ephemeris/src/moon.rs`; this script only has to agree with it on
the geocentric series, which the checkpoints pin.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "crates", "skyfix-ephemeris", "data", "elp82b_moon_terms.json")
DEFAULT_SOURCE = os.path.join(HERE, "data", "elp82b")

CDS_BASE = "https://cdsarc.cds.unistra.fr/ftp/cats/VI/79/"
RETRIEVED = "2026-09-24"

#: SHA-256 of the CDS VI/79 files as retrieved on RETRIEVED.
SHA256 = {
    "ELP1": "ae30cbffb83a7bd4582a83a32a322d08a48ba057a4df7bf9dd5df9f06b1688fa",
    "ELP2": "c91e5585b0a9e7bd091304b164ce89a6461acd0e439d47957c890aec1e031e08",
    "ELP3": "862a8e4c8e70ce8b28383be4c9f2e2c025a8f633d7b7a811eb3afdab4ed9f354",
    "ELP4": "f27ea439bf8f4fd35bed31c0a42de5414db07f9fcc3587237f6908891d43d773",
    "ELP5": "6803422481e4decae4a59f89d4f94c7b33af21d293d9bc807d565f51c29b9915",
    "ELP6": "2a6be4d33dfce4cf2351d295b4aade8f34cc476a97747b3eccb12763658e1fd1",
    "ELP7": "35491a0c73ff6bcb136d8f54db89d8df2fb741af43aed9707618e3a925df474d",
    "ELP8": "f3e7f4c851e7f9ac1a0556fe7e685e44612f3dca317ab605eb35f565251e020e",
    "ELP9": "574347346363df52c7602f56747b790e9cbe60152127d24451c6a1633bc79f0e",
    "ELP10": "dbd82ddc6064e4cc7b4f08fa27b2fcb48f82456ad36a850a0d3ddae098c3e2e6",
    "ELP11": "0ad7a914c9f98008a648881783c9dd4a14692ec14e2e1bfce4709c68d17bd659",
    "ELP12": "8ed7be0ab70f4ffae6b1f711cc4e915257ae5e269fbbfc5a7060f7e952728ba8",
    "ELP13": "643295b3894023b4b1bd6ee2b0ecf5d3ff23d703baccc6302caa05fa8b84f76c",
    "ELP14": "b59d8b9bbef282f2bead538d6906781257a7fb5b8699bb6adcacb070a76f1e89",
    "ELP15": "17ab0d521c178187a5de4847b6696fbcb7a55d77d776568a0c16f33fd3be342a",
    "ELP16": "2bef867d8aad4075bc2711559cf1bc42757501bb10c307ff121152bddd344a66",
    "ELP17": "6cf0746d034ac75ed60d4d16ed0de790fe5b7aad9df7b462091c38020e1b1bfc",
    "ELP18": "b1d93931f6016023c83354cd54a2614978de3b6bc5b7234537d461200f7f4753",
    "ELP19": "dd0b0bd5f5c354683f035ee8a09d82e9c138baaf27758ca311d07c76983bdd2e",
    "ELP20": "0f1d571879dc9b1a6f7698b403bef26ab151c3ec2ed42cbdec5b297cb0464a8e",
    "ELP21": "1546d0e8af01f759f9dfb7a3bf4334a3e579f59e5c22edab29d660dede2ed4b4",
    "ELP22": "44263bb254c2b6c0df963bddfd1ecfd01950668fd913f9e6ba6da6ff729f3e41",
    "ELP23": "38917cf2cbe0f9afcd271444a47066b098f9a8792836ec85dac359f4c11b9464",
    "ELP24": "ca67e5db5933887130709767c1eb3ac009e4bce596978bad7995c416ee71c59f",
    "ELP25": "fd0cb03d496cbf23bf7bebef40aa09019c6a50072fc7fd2573645f26a56ab635",
    "ELP26": "d5b2a33974b099448a35536987b2f08aff5b11d5801ffa55c87ae8a1d26e9f4f",
    "ELP27": "648379d85e1753cc37bc3852b63899d414a05d3aea1c8621dc44e9fdfff234f1",
    "ELP28": "0785b8e002887799bc303e8be1abd71c37ae9de671bffbdeb8f50998f892f18e",
    "ELP29": "816fd1a94b1cb4e2e5e6cec72971f27ad0f2bf987735d184586fdadd033c3d02",
    "ELP30": "cff5ab4c84a6a36855e5b2e2f47e1e0e1d605e789ff2954755dc64d188067a13",
    "ELP31": "c2fc53c2442c1b61404991f31c859cc5eb300eb66bb764e1f16c70fe8d199dc3",
    "ELP32": "7a07397b63d1ade0909c12be9024632de6ff27fd9e8e410e5f97f821d2390a60",
    "ELP33": "459ea9eff9a9d7b5c224245f5edb113060174b4991d3adf7d27079719bcf2339",
    "ELP34": "b83178e98bd33e8f26ef6662e03455761ffac7dae399ad1ccb4bf028c5f0e774",
    "ELP35": "692d1752a7ea28c7157dbf694750af6ea2cbf74c744c4b792a7e8bf1bb5ad7d7",
    "ELP36": "1f8eec292def5ceb4fff9a09ca678bd81e9cdc23ff7bdc802f2281c837357bda",
    "ReadMe": "5677bd763410821e561135b46594fb4f3baf5ab92f10906aa0872bb5bd8b8993",
    "elp82b.f.gz": "1c05975453551078b28bdf8519f2bc4d832e32842f666a4ad8767ac8df5572a1",
    "elp82b.ps.gz": "986c55cc674ed6955d16f550b49c8bfdd1c6868e77a5f8b787500bbd812b6979",
}

# ---------------------------------------------------------------------------
# Coverage window and truncation thresholds
# ---------------------------------------------------------------------------

JD_J2000 = 2451545.0
#: 1990-01-01T00:00Z and 2061-01-01T00:00Z (the provider answers through 2060-12-31).
JD_START = 2447892.5
JD_END = 2473825.5
T_MIN = (JD_START - JD_J2000) / 36525.0
#: The window's end plus TT - UTC (69.184 s) and a little: the argument is TDB.
T_MAX = (JD_END + 0.001 - JD_J2000) / 36525.0
T_ABS = max(abs(T_MIN), abs(T_MAX))

#: Keep a term when its peak contribution reaches this, per coordinate.
THRESHOLD = {0: 2.0e-3, 1: 2.0e-3, 2: 1.0e-2}  # arcsec, arcsec, km
COORD_NAME = {0: "longitude", 1: "latitude", 2: "distance"}
COORD_UNIT = {0: "arcsec", 1: "arcsec", 2: "km"}
ERROR_EPOCHS = 20000

# ---------------------------------------------------------------------------
# ELP 2000-82B constants, from elp82b.f (CDS VI/79) and the notice, sect. 6-8
# ---------------------------------------------------------------------------

RAD = 648000.0 / math.pi
DEG = math.pi / 180.0
ATH = 384747.9806743165
A0 = 384747.9806448954
AM = 0.074801329518
ALFA = 0.002571881335
DTASM = 2.0 * ALFA / (3.0 * AM)


def _dms(d, m, s):
    return (d + m / 60.0 + s / 3600.0) * DEG


W1 = [_dms(218, 18, 59.95571), 1732559343.73604 / RAD, -5.8883 / RAD, 0.6604e-2 / RAD, -0.3169e-4 / RAD]
W2 = [_dms(83, 21, 11.67475), 14643420.2632 / RAD, -38.2776 / RAD, -0.45047e-1 / RAD, 0.21301e-3 / RAD]
W3 = [_dms(125, 2, 40.39816), -6967919.3622 / RAD, 6.3622 / RAD, 0.7625e-2 / RAD, -0.3586e-4 / RAD]
EART = [_dms(100, 27, 59.22059), 129597742.2758 / RAD, -0.0202 / RAD, 0.9e-5 / RAD, 0.15e-6 / RAD]
PERI = [_dms(102, 56, 14.42753), 1161.2283 / RAD, 0.5327 / RAD, -0.138e-3 / RAD, 0.0]
PRECES = 5029.0966 / RAD
PLA = [
    [_dms(252, 15, 3.25986), 538101628.68898 / RAD],
    [_dms(181, 58, 47.28305), 210664136.43355 / RAD],
    [EART[0], EART[1]],
    [_dms(355, 25, 59.78866), 68905077.59284 / RAD],
    [_dms(34, 21, 5.34212), 10925660.42861 / RAD],
    [_dms(50, 4, 38.89694), 4399609.65932 / RAD],
    [_dms(314, 3, 18.01841), 1542481.19393 / RAD],
    [_dms(304, 20, 55.19575), 786550.32074 / RAD],
]
DELNU = +0.55604 / RAD / W1[1]
DELE = +0.01789 / RAD
DELG = -0.08066 / RAD
DELNP = -0.06424 / RAD / W1[1]
DELEP = -0.12879 / RAD
DEL = [
    [W1[k] - EART[k] + (math.pi if k == 0 else 0.0) for k in range(5)],  # D
    [EART[k] - PERI[k] for k in range(5)],  # l'
    [W1[k] - W2[k] for k in range(5)],  # l
    [W1[k] - W3[k] for k in range(5)],  # F
]
ZETA = [W1[0], W1[1] + PRECES]
P_LASKAR = [0.10180391e-4, 0.47020439e-6, -0.5417367e-9, -0.2507948e-11, 0.463486e-14]
Q_LASKAR = [-0.113469002e-3, 0.12372674e-6, 0.1265417e-8, -0.1371808e-11, -0.320334e-14]

#: Notice, Table H: Julian TDB date and x, y, z (km) of the complete theory,
#: inertial mean ecliptic and equinox of J2000.
TABLE_H = [
    (2469000.5, (-361602.98536, 44996.99510, -30696.65316)),
    (2449000.5, (-363132.34248, 35863.65378, -33196.00409)),
    (2429000.5, (-371577.58161, 75271.14315, -32227.94618)),
    (2409000.5, (-373896.15893, 127406.79129, -30037.79225)),
    (2389000.5, (-346331.77361, 206365.40364, -28502.11732)),
]

#: Epochs (Julian TDB dates) of the checkpoints written for the truncated series.
CHECKPOINT_JD = [
    2447892.5,  # 1990-01-01
    2449000.5,  # 1993-01-13, a Table H epoch
    2451545.0,  # J2000.0
    2461314.5625,  # 2026-10-01T01:30 TDB (approximately)
    2466154.5,  # 2040-01-01
    2469000.5,  # 2047-10-17, a Table H epoch
    2473825.5,  # 2061-01-01
]


def file_kind(n):
    """(coordinate, power of t, record kind) for ELP file number n."""
    coord = (n - 1) % 3
    if n <= 3:
        return coord, 0, "main"
    if 10 <= n <= 21:
        power = 1 if (13 <= n <= 15 or 19 <= n <= 21) else 0
        return coord, power, "planetary1" if n <= 15 else "planetary2"
    power = 0
    if 7 <= n <= 9 or 25 <= n <= 27:
        power = 1
    if 34 <= n <= 36:
        power = 2
    return coord, power, "figure"


RECORD_LAYOUT = {
    "main": "i1 i2 i3 i4 A B1 B2 B3 B4 B5 B6: multipliers of D l' l F; A in arcsec (km for "
    "distance); B1..B6 the derivatives of A with respect to the constants m, Gamma, E, e', "
    "alpha, sigma (notice sect. 2.2 a and 5)",
    "figure": "i1 i2 i3 i4 i5 phase A: multipliers of zeta D l' l F; phase in degrees; A in "
    "arcsec (km for distance) (notice sect. 2.2 b and e)",
    "planetary1": "i1..i11 phase A: multipliers of Me V T Ma J S U N D l F; phase in degrees; "
    "A in arcsec (km for distance) (notice sect. 2.2 c)",
    "planetary2": "i1..i11 phase A: multipliers of Me V T Ma J S U D l' l F; phase in degrees; "
    "A in arcsec (km for distance) (notice sect. 2.2 d)",
}


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(source_dir):
    os.makedirs(source_dir, exist_ok=True)
    for name in SHA256:
        path = os.path.join(source_dir, name)
        if os.path.exists(path):
            continue
        url = CDS_BASE + name
        print("fetching", url)
        with urllib.request.urlopen(url, timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())


def verify(source_dir):
    bad = []
    for name, digest in SHA256.items():
        path = os.path.join(source_dir, name)
        if not os.path.exists(path):
            bad.append("%s: missing" % name)
        elif sha256_of(path) != digest:
            bad.append("%s: SHA-256 differs from the pinned value" % name)
    if bad:
        raise SystemExit("CDS VI/79 files are not the pinned ones:\n  " + "\n  ".join(bad))


def parse(source_dir, n):
    """Return (title, records). Each record keeps the file's own numbers."""
    _coord, _power, kind = file_kind(n)
    path = os.path.join(source_dir, "ELP%d" % n)
    records = []
    with open(path) as f:
        title = f.readline().strip()
        for line in f:
            if not line.strip():
                continue
            if kind == "main":  # 4I3, 2X, F13.5, 6(2X, F10.2)
                ints = [int(line[3 * k:3 * k + 3]) for k in range(4)]
                a = float(line[14:27])
                b = [float(line[29 + 12 * k:39 + 12 * k]) for k in range(6)]
                records.append({"ints": ints, "a": a, "b": b})
            elif kind == "figure":  # 5I3, 1X, F9.5, 1X, F9.5, 1X, F9.3
                ints = [int(line[3 * k:3 * k + 3]) for k in range(5)]
                records.append({"ints": ints, "phase": float(line[16:25]), "a": float(line[26:35])})
            else:  # 11I3, 1X, F9.5, 1X, F9.5, 1X, F9.3
                ints = [int(line[3 * k:3 * k + 3]) for k in range(11)]
                records.append({"ints": ints, "phase": float(line[34:43]), "a": float(line[44:53])})
    return title, records


# ---------------------------------------------------------------------------
# The theory, exactly as elp82b.f evaluates it
# ---------------------------------------------------------------------------


def main_amplitude(n, rec):
    """Amplitude after the corrections fitted to DE200/LE200 (notice sect. 7)."""
    a = rec["a"]
    b = rec["b"]
    if n == 3:
        a = a - 2.0 * a * DELNU / 3.0
    tgv = b[0] + DTASM * b[4]
    return a + tgv * (DELNP - AM * DELNU) + b[1] * DELG + b[2] * DELE + b[3] * DELEP


def argument_poly(n, rec):
    """Coefficients (radians, per century**k) of the argument of one record."""
    _coord, _power, kind = file_kind(n)
    ints = rec["ints"]
    if kind == "main":
        poly = [sum(ints[i] * DEL[i][k] for i in range(4)) for k in range(5)]
        if n == 3:
            poly[0] += math.pi / 2.0  # distance series are cosines
        return poly
    ph = [rec["phase"] * DEG, 0.0]
    for k in range(2):
        if kind == "figure":
            ph[k] += ints[0] * ZETA[k] + sum(ints[i + 1] * DEL[i][k] for i in range(4))
        elif kind == "planetary1":
            ph[k] += ints[8] * DEL[0][k] + ints[9] * DEL[2][k] + ints[10] * DEL[3][k]
            ph[k] += sum(ints[i] * PLA[i][k] for i in range(8))
        else:
            ph[k] += sum(ints[i + 7] * DEL[i][k] for i in range(4))
            ph[k] += sum(ints[i] * PLA[i][k] for i in range(7))
    return ph + [0.0, 0.0, 0.0]


class Term:
    __slots__ = ("file", "coord", "power", "amp", "poly", "rec", "peak")

    def __init__(self, n, rec):
        self.file = n
        self.coord, self.power, kind = file_kind(n)
        self.amp = main_amplitude(n, rec) if kind == "main" else rec["a"]
        self.poly = argument_poly(n, rec)
        self.rec = rec
        self.peak = abs(self.amp) * T_ABS ** self.power

    def value(self, t, tp):
        p = self.poly
        y = p[0] + p[1] * t + p[2] * tp[2] + p[3] * tp[3] + p[4] * tp[4]
        return self.amp * tp[self.power] * np.sin(y)


def series(terms, t):
    t = np.atleast_1d(np.asarray(t, dtype=float))
    tp = [np.ones_like(t), t, t * t, t ** 3, t ** 4]
    out = np.zeros((3, t.size))
    for term in terms:
        out[term.coord] += term.value(t, tp)
    return out


def to_ecliptic_j2000(sums, t):
    """elp82b.f's change of coordinates: km, inertial mean ecliptic and equinox J2000."""
    t = np.atleast_1d(np.asarray(t, dtype=float))
    v = sums[0] / RAD + W1[0] + W1[1] * t + W1[2] * t ** 2 + W1[3] * t ** 3 + W1[4] * t ** 4
    u = sums[1] / RAD
    r = sums[2] * A0 / ATH
    x1 = r * np.cos(u)
    x2 = x1 * np.sin(v)
    x1 = x1 * np.cos(v)
    x3 = r * np.sin(u)
    pw = sum(P_LASKAR[k] * t ** k for k in range(5)) * t
    qw = sum(Q_LASKAR[k] * t ** k for k in range(5)) * t
    ra = 2.0 * np.sqrt(1 - pw * pw - qw * qw)
    pwqw = 2.0 * pw * qw
    pw2 = 1 - 2.0 * pw * pw
    qw2 = 1 - 2.0 * qw * qw
    pw = pw * ra
    qw = qw * ra
    return np.array([
        pw2 * x1 + pwqw * x2 + pw * x3,
        pwqw * x1 + qw2 * x2 - qw * x3,
        -pw * x1 + qw * x2 + (pw2 + qw2 - 1) * x3,
    ])


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def fmt_record(n, rec):
    """The record exactly as the file states it (period column dropped)."""
    _coord, _power, kind = file_kind(n)
    parts = [str(i) for i in rec["ints"]]
    if kind == "main":
        parts.append("%.5f" % rec["a"])
        parts.extend("%.2f" % b for b in rec["b"])
    else:
        parts.append("%.5f" % rec["phase"])
        parts.append("%.5f" % rec["a"])
    return "[" + ",".join(p if p not in ("-0.00", "-0.00000") else p[1:] for p in parts) + "]"


def dumps(obj, indent=1, level=0):
    """Small deterministic JSON writer: records one per line, everything else pretty."""
    pad = " " * (indent * level)
    pad1 = " " * (indent * (level + 1))
    if isinstance(obj, RawRows):
        if not obj.rows:
            return "[]"
        return "[\n" + ",\n".join(pad1 + r for r in obj.rows) + "\n" + pad + "]"
    if isinstance(obj, dict):
        items = [pad1 + json.dumps(k) + ": " + dumps(v, indent, level + 1) for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, list):
        if all(not isinstance(x, (dict, list, RawRows)) for x in obj):
            return "[" + ", ".join(json.dumps(x) for x in obj) + "]"
        return "[\n" + ",\n".join(pad1 + dumps(x, indent, level + 1) for x in obj) + "\n" + pad + "]"
    return json.dumps(obj)


class RawRows:
    def __init__(self, rows):
        self.rows = rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source-dir", default=DEFAULT_SOURCE)
    ap.add_argument("--fetch", action="store_true", help="download missing files from the CDS")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args(argv)

    if args.fetch:
        fetch(args.source_dir)
    verify(args.source_dir)

    files = {}
    all_terms = []
    for n in range(1, 37):
        title, recs = parse(args.source_dir, n)
        terms = [Term(n, r) for r in recs]
        files[n] = (title, recs, terms)
        all_terms.extend(terms)
    print("parsed %d terms from 36 files" % len(all_terms))

    # 2. The complete theory must reproduce the notice's Table H.
    worst_h = 0.0
    for jd, xyz in TABLE_H:
        t = (jd - JD_J2000) / 36525.0
        got = to_ecliptic_j2000(series(all_terms, [t]), [t])[:, 0]
        worst_h = max(worst_h, float(np.abs(got - np.array(xyz)).max()))
    if worst_h > 1e-5:
        raise SystemExit("complete series misses Table H by %.3g km" % worst_h)
    print("complete series reproduces Table H to %.2g km" % worst_h)

    # 3. Truncate.
    kept = [tm for tm in all_terms if tm.peak >= THRESHOLD[tm.coord]]
    dropped = [tm for tm in all_terms if tm.peak < THRESHOLD[tm.coord]]

    # 4. Measure.
    rng = np.random.default_rng(20260924)
    t = np.sort(rng.uniform(T_MIN, T_MAX, ERROR_EPOCHS))
    full = series(all_terms, t)
    trunc = series(kept, t)
    d = trunc - full
    xyz_full = to_ecliptic_j2000(full, t)
    xyz_trunc = to_ecliptic_j2000(trunc, t)
    r = np.linalg.norm(xyz_full, axis=0)
    cosang = np.sum(xyz_full * xyz_trunc, axis=0) / (r * np.linalg.norm(xyz_trunc, axis=0))
    ang = np.arccos(np.clip(cosang, -1.0, 1.0)) * RAD
    bound = {c: sum(tm.peak for tm in dropped if tm.coord == c) for c in range(3)}
    measured = {c: float(np.abs(d[c]).max()) for c in range(3)}
    truncation = {
        "rule": (
            "keep a term when its peak contribution over the coverage window, |A| * t_abs**p, "
            "reaches the threshold of its coordinate (A after the DE200/LE200 corrections for the "
            "main problem; p = 1 for the /t files, 2 for ELP34-36, else 0; t in Julian centuries "
            "of TDB from J2000)"
        ),
        "t_abs": T_ABS,
        "threshold_longitude_arcsec": THRESHOLD[0],
        "threshold_latitude_arcsec": THRESHOLD[1],
        "threshold_distance_km": THRESHOLD[2],
        "terms_kept": len(kept),
        "terms_total": len(all_terms),
        "measured_over_epochs": ERROR_EPOCHS,
        "measured_max_error_longitude_arcsec": measured[0],
        "measured_max_error_latitude_arcsec": measured[1],
        "measured_max_error_distance_km": measured[2],
        "measured_max_error_direction_arcsec": float(ang.max()),
        "dropped_worstcase_longitude_arcsec": bound[0],
        "dropped_worstcase_latitude_arcsec": bound[1],
        "dropped_worstcase_distance_km": bound[2],
    }
    for k, v in truncation.items():
        print("  %-40s %s" % (k, v))

    # 5. Checkpoints.
    checkpoints = []
    for jd, xyz in TABLE_H:
        checkpoints.append({
            "jd_tdb": jd,
            "xyz_km": list(xyz),
            "series": "complete",
            "source": "ELP 2000-82B notice (CDS VI/79 elp82b.ps), Table H, PREC = 0: all %d terms"
            % len(all_terms),
        })
    tc = np.array([(jd - JD_J2000) / 36525.0 for jd in CHECKPOINT_JD])
    xyz_c = to_ecliptic_j2000(series(kept, tc), tc)
    sums_c = series(kept, tc)
    for i, jd in enumerate(CHECKPOINT_JD):
        checkpoints.append({
            "jd_tdb": jd,
            "xyz_km": [float(x) for x in xyz_c[:, i]],
            "sums": [float(x) for x in sums_c[:, i]],
            "series": "truncated",
            "source": "this file's kept terms, evaluated by tools/reference/build_moon_series.py",
        })

    out_files = []
    for n in range(1, 37):
        title, recs, terms = files[n]
        coord, power, kind = file_kind(n)
        rows = [fmt_record(n, tm.rec) for tm in terms if tm.peak >= THRESHOLD[tm.coord]]
        # the verbatim rows must parse back to the same numbers
        for row, tm in zip(rows, [tm for tm in terms if tm.peak >= THRESHOLD[tm.coord]]):
            vals = json.loads(row)
            if kind == "main":
                expect = tm.rec["ints"] + [tm.rec["a"]] + tm.rec["b"]
            else:
                expect = tm.rec["ints"] + [tm.rec["phase"], tm.rec["a"]]
            assert vals == expect, (n, row, expect)
        out_files.append({
            "file": n,
            "title": title,
            "coordinate": COORD_NAME[coord],
            "unit": COORD_UNIT[coord],
            "t_power": power,
            "record": RECORD_LAYOUT[kind],
            "terms_total": len(recs),
            "terms_kept": len(rows),
            "rows": RawRows(rows),
        })

    doc = {
        "schema": "skyfix.elp82b_trunc/1",
        "body": "Moon",
        "source": {
            "catalogue": "VI/79  Lunar Solution ELP 2000-82B (Chapront-Touze+, 1988)",
            "references": [
                "Chapront-Touze M., Chapront J., 1983, A&A 124, 50 (1983A&A...124...50C)",
                "Chapront-Touze M., Chapront J., 1988, A&A 190, 342 (1988A&A...190..342C)",
            ],
            "url": CDS_BASE,
            "retrieved_utc": RETRIEVED,
            "sha256": {k: SHA256[k] for k in SHA256},
            "constants": "fitted to JPL DE200/LE200; the corrections of the notice, sect. 7, are applied to the main problem as elp82b.f does",
            "frame": "geocentric; longitude and latitude on the inertial mean ecliptic of date from the departure point gamma'2000, then Laskar's P, Q to the inertial mean ecliptic and equinox of J2000 (notice sect. 8)",
            "time_argument": "t = (JD_TDB - 2451545.0) / 36525",
            "record_period_column": "dropped (informative only)",
            "generator": "tools/reference/build_moon_series.py",
        },
        "coverage": {"jd_start": JD_START, "jd_end": JD_END, "t_min": T_MIN, "t_max": T_MAX},
        "truncation": truncation,
        "files": out_files,
        "checkpoints": checkpoints,
    }
    text = dumps(doc) + "\n"
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %s (%.1f KiB, %d of %d terms)" % (os.path.relpath(args.out, REPO), len(text) / 1024.0,
                                                     len(kept), len(all_terms)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
