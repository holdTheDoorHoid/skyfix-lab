"""ELP/MPP02 lunar theory (Chapront & Francou 2003), a numpy port of SYRTE's ELPMPP02.for.

Development-time only (CONVENTIONS section 11). Nothing here is a runtime dependency:
the Rust Moon provider reads the binary series file `build_series.py` writes, and the
generator uses this module to truncate the series, to verify the truncation and to
compare the theory with JPL DE440/DE441.

The six series files (ELP_MAIN.S1-S3, ELP_PERT.S1-S3) are SYRTE's, distributed with
the explanatory note `elpmpp02.pdf` and the Fortran routine `ELPMPP02.for`. The
official directory ftp://cyrano-se.obspm.fr/pub/2_lunar_solutions/2_elpmpp02/ was
unreachable on 2026-09-24; the files were fetched from the verbatim mirror
https://github.com/THRASTRO/ephem.js/tree/develop/src/elpmpp02/data and are pinned by
SHA-256 below (the byte sizes match the archived 2025 listing of the official
directory). `make -C tools/reference elpmpp02` fetches them.

The port follows `ELPMPP02.for` (INITIAL, READFILE, EVALUATE) statement by statement:

* INITIAL: the constants and the two sets of fitted corrections, icor = 0 (LLR) and
  icor = 1 (DE405, with the additive secular corrections of the note's Table 6 that
  keep the solution close to DE406 over six millennia);
* READFILE: main-problem amplitudes corrected with the partial derivatives B1..B5,
  perturbation terms as amplitude and phase from their sine and cosine coefficients;
* EVALUATE: the series, the mean longitude W1, the ratio a0(DE405)/a0(ELP) on the
  distance, and Laskar's P, Q rotation from the inertial mean ecliptic of date to the
  inertial mean ecliptic and equinox of J2000.

Check values: the note's Table 8 (five dates per constant set) are reproduced to the
printed 1e-5 km by `self_test()`.
"""

from __future__ import annotations

import hashlib
import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SOURCE = os.path.join(HERE, "data", "series", "elpmpp02")
MIRROR = "https://raw.githubusercontent.com/THRASTRO/ephem.js/develop/src/elpmpp02/data/"
OFFICIAL = "ftp://cyrano-se.obspm.fr/pub/2_lunar_solutions/2_elpmpp02/"
RETRIEVED = "2026-09-24"

FILES = {
    # name: (bytes, sha256)
    "ELP_MAIN.S1": (103360, "3602147c43b77f86394c9034ea0e66807c6a674eeac87ada2a23aecd328706f1"),
    "ELP_MAIN.S2": (92755, "c06fca782f973a5365a4a19dd8b8a2a5ce711063e007ad929be6206686e459b8"),
    "ELP_MAIN.S3": (71141, "22f2cebde62d7451bc984ea67716b32091848c6f33ce746a9d1ba5de76074a56"),
    "ELP_PERT.S1": (1209918, "222b2895f476370e93b05c50bc207d5f637ca3cd7002f848054ff44b9f1742ba"),
    "ELP_PERT.S2": (668038, "0fd9af9d5e79fb9315c2ea295c8abe8f1ca385401fa93c8a032d64eb45c7d209"),
    "ELP_PERT.S3": (1281928, "15123e2eb0683ebffacc2b67339693532060a4db1f9c26eba502e0dad941d216"),
    "ELPMPP02.for": (28063, "b7b9709329f35a6fb6c0e534d3fbebd091ff82edd4e06ab34be70f6dba43db5a"),
    "README.TXT": (4445, "aee2edbd7cc679fd6f1e871fb017493f075a6befc7f720f4f6bb8ee2b56e7fd8"),
    "elpmpp02.pdf": (215008, "08b988dda14deb8850f82ea4077115a6d44251c325dd48de137b15bc5c0c2c93"),
}

CPI = 3.141592653589793
RAD = 648000.0 / CPI  # arcseconds per radian, as the Fortran defines it
DEG = CPI / 180.0
SC = 36525.0
A405 = 384747.9613701725
AELP = 384747.980674318

#: Laskar (1986) P and Q, coefficients of t..t^5 (the note, section 5.1).
P_COEF = (0.10180391e-04, 0.47020439e-06, -0.5417367e-09, -0.2507948e-11, 0.463486e-14)
Q_COEF = (-0.113469002e-03, 0.12372674e-06, 0.1265417e-08, -0.1371808e-11, -0.320334e-14)

#: The note's Table 7: position of the inertial mean ecliptic of J2000 in the frame
#: fitted with each constant set (arcseconds): epsilon - 23 26' 21", phi.
TABLE7 = {
    "ICRS": (0.41100, -0.05542),
    "MCEP": (0.40564, -0.01460),
    "JPL405": (0.40960, -0.05028),
}

#: The note's Table 8 check values: JD (TDB) -> X, Y, Z km and X', Y', Z' km/day.
TABLE8 = {
    0: [
        (2444239.5, (43890.28240, 381188.72745, -31633.38165), (-87516.19748, 13707.66444, 2754.22124)),
        (2446239.5, (-313664.59645, 212007.26674, 33744.75120), (-47315.91281, -75710.87501, -1475.62869)),
        (2448239.5, (-273220.06067, -296859.76822, -34604.35700), (60542.32759, -58162.31674, 2270.88691)),
        (2450239.5, (171613.14280, -318097.33750, 31293.54824), (83266.77990, 42585.83028, -1695.82611)),
        (2452239.5, (396530.00635, 47487.92249, -36085.30903), (-12664.28694, 83512.75719, 1507.36756)),
    ],
    1: [
        (2500000.5, (274034.59103, 252067.53689, -18998.75519), (-62463.61338, 65693.96392, 6595.32890)),
        (2300000.5, (353104.31359, -195254.11808, 34943.54592), (39543.13678, 74373.18070, -700.65351)),
        (2100000.5, (-19851.27674, -385646.17717, -27597.66134), (87539.40744, -7599.68484, -4960.44360)),
        (1900000.5, (-370342.79254, -37574.25533, -4527.91840), (12255.28746, -89710.97508, 7649.44285)),
        (1700000.5, (-164673.04720, 367791.71329, 31603.98027), (-75884.68815, -35802.26558, -4239.59895)),
    ],
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_files(source=DEFAULT_SOURCE, names=None):
    """Refuse files that are not the pinned SYRTE originals. Returns provenance rows."""
    rows = []
    for name in names or FILES:
        size, digest = FILES[name]
        path = os.path.join(source, name)
        if not os.path.exists(path):
            raise SystemExit(
                "missing %s -- fetch it with `make -C tools/reference elpmpp02` or\n"
                "  curl -fsSL -o %s %s%s" % (path, path, MIRROR, name)
            )
        got = sha256(path)
        if got != digest or os.path.getsize(path) != size:
            raise SystemExit("%s: SHA-256 %s / %d B, expected %s / %d B"
                             % (path, got, os.path.getsize(path), digest, size))
        rows.append({"file": name, "bytes": size, "sha256": digest,
                     "url": MIRROR + name})
    return rows


def dms(d, m, s):
    return (d + m / 60.0 + s / 3600.0) * DEG


class Constants:
    """INITIAL(icor): every constant the evaluation needs, radians and rad/cy^k."""

    def __init__(self, icor=1):
        self.icor = icor
        bp = np.array([[0.311079095, -0.103837907],
                       [-0.4482398e-2, 0.6682870e-3],
                       [-0.110248500e-2, -0.129807200e-2],
                       [0.1056062e-2, -0.1780280e-3],
                       [0.50928e-4, -0.37342e-4]])  # bp(i, j) with i = 1..5, j = 1..2
        dprec = -0.29965
        am = 0.074801329
        alpha = 0.002571881
        self.am = am
        self.dtasm = (2.0 * alpha) / (3.0 * am)
        xa = (2.0 * alpha) / 3.0
        if icor == 1:
            dw1_0, dw2_0, dw3_0 = -0.07008, 0.20794, -0.07215
            deart_0, dperi = -0.00033, -0.00749
            dw1_1, dgam, de = -0.35106, 0.00085, -0.00006
            deart_1, dep = 0.00732, 0.00224
            dw2_1, dw3_1, dw1_2 = 0.08017, -0.04317, -0.03743
        else:
            dw1_0, dw2_0, dw3_0 = -0.10525, 0.16826, -0.10760
            deart_0, dperi = -0.04012, -0.04854
            dw1_1, dgam, de = -0.32311, 0.00069, +0.00005
            deart_1, dep = 0.01442, 0.00226
            dw2_1, dw3_1, dw1_2 = 0.08017, -0.04317, -0.03794
        w = np.zeros((3, 5))
        w[0] = [dms(218, 18, 59.95571 + dw1_0), (1732559343.73604 + dw1_1) / RAD,
                (-6.8084 + dw1_2) / RAD, 0.66040e-2 / RAD, -0.31690e-4 / RAD]
        w[1] = [dms(83, 21, 11.67475 + dw2_0), (14643420.3171 + dw2_1) / RAD,
                (-38.2631) / RAD, -0.45047e-1 / RAD, 0.21301e-3 / RAD]
        w[2] = [dms(125, 2, 40.39816 + dw3_0), (-6967919.5383 + dw3_1) / RAD,
                (6.3590) / RAD, 0.76250e-2 / RAD, -0.35860e-4 / RAD]
        eart = np.array([dms(100, 27, 59.13885 + deart_0), (129597742.29300 + deart_1) / RAD,
                         -0.020200 / RAD, 0.90000e-5 / RAD, 0.15000e-6 / RAD])
        peri = np.array([dms(102, 56, 14.45766 + dperi), 1161.24342 / RAD,
                         0.529265 / RAD, -0.11814e-3 / RAD, 0.11379e-4 / RAD])
        if icor == 1:
            w[0, 3] -= 0.00018865 / RAD
            w[0, 4] -= 0.00001024 / RAD
            w[1, 2] += 0.00470602 / RAD
            w[1, 3] -= 0.00025213 / RAD
            w[2, 2] -= 0.00261070 / RAD
            w[2, 3] -= 0.00010712 / RAD
        x2 = w[1, 1] / w[0, 1]
        x3 = w[2, 1] / w[0, 1]
        y2 = am * bp[0, 0] + xa * bp[4, 0]
        y3 = am * bp[0, 1] + xa * bp[4, 1]
        d21, d22, d23, d24, d25 = x2 - y2, w[0, 1] * bp[1, 0], w[0, 1] * bp[2, 0], w[0, 1] * bp[3, 0], y2 / am
        d31, d32, d33, d34, d35 = x3 - y3, w[0, 1] * bp[1, 1], w[0, 1] * bp[2, 1], w[0, 1] * bp[3, 1], y3 / am
        cw2_1 = d21 * dw1_1 + d25 * deart_1 + d22 * dgam + d23 * de + d24 * dep
        cw3_1 = d31 * dw1_1 + d35 * deart_1 + d32 * dgam + d33 * de + d34 * dep
        w[1, 1] += cw2_1 / RAD
        w[2, 1] += cw3_1 / RAD
        dl = np.zeros((4, 5))
        dl[0] = w[0] - eart  # D
        dl[1] = w[0] - w[2]  # F
        dl[2] = w[0] - w[1]  # l
        dl[3] = eart - peri  # l'
        dl[0, 0] += CPI
        p = np.zeros((8, 5))
        p[:, 0] = [dms(252, 15, 3.216919), dms(181, 58, 44.758419), dms(100, 27, 59.138850),
                   dms(355, 26, 3.642778), dms(34, 21, 5.379392), dms(50, 4, 38.902495),
                   dms(314, 3, 4.354234), dms(304, 20, 56.808371)]
        p[:, 1] = np.array([538101628.66888, 210664136.45777, 129597742.29300, 68905077.65936,
                            10925660.57335, 4399609.33632, 1542482.57845, 786547.89700]) / RAD
        zeta = w[0].copy()
        zeta[1] = w[0, 1] + (5029.0966 + dprec) / RAD
        self.w, self.eart, self.peri, self.dl, self.p, self.zeta = w, eart, peri, dl, p, zeta
        self.delnu = (+0.55604 + dw1_1) / RAD / w[0, 1]
        self.dele = (+0.01789 + de) / RAD
        self.delg = (-0.08066 + dgam) / RAD
        self.delnp = (-0.06424 + deart_1) / RAD / w[0, 1]
        self.delep = (-0.12879 + dep) / RAD


def _fortran_float(text):
    return float(text.replace("D", "E").replace("d", "e"))


def read_main(path):
    """ELP_MAIN.Sn: rows (i1..i4, A, B1..B6). Format 4i3,2x,f13.5,6f12.2."""
    with open(path, encoding="ascii") as f:
        lines = f.read().splitlines()
    n = int(lines[0][25:35])
    rows = []
    for line in lines[1:1 + n]:
        ilu = [int(line[3 * k:3 * k + 3]) for k in range(4)]
        a = float(line[14:27])
        b = [float(line[27 + 12 * k:39 + 12 * k]) for k in range(6)]
        rows.append((ilu, a, b))
    if len(rows) != n:
        raise ValueError("%s: %d rows, header says %d" % (path, len(rows), n))
    return rows


def read_pert(path):
    """ELP_PERT.Sn: {power: rows (S, C, i1..i13)}. Header 25x,2i10; rows i5,2d20.13,16i3."""
    with open(path, encoding="ascii") as f:
        lines = f.read().splitlines()
    out = {}
    i = 0
    while i < len(lines):
        head = lines[i]
        if not head.strip():
            i += 1
            continue
        n, power = int(head[25:35]), int(head[35:45])
        rows = []
        for line in lines[i + 1:i + 1 + n]:
            s = _fortran_float(line[5:25])
            c = _fortran_float(line[25:45])
            ifi = [int(line[45 + 3 * k:48 + 3 * k]) for k in range(16)]
            rows.append((s, c, ifi[:13]))
            if any(ifi[13:]):
                raise ValueError("%s: multipliers 14-16 are not zero: %r" % (path, line))
        out[power] = rows
        i += 1 + n
    return out


class Series:
    """The whole theory as flat arrays, ready for vectorised evaluation.

    Every term is `amp * t**power * sin(arg(t))` with `arg(t) = sum_k fk[k] t**k`,
    coordinate `coord` (0 longitude, 1 latitude, 2 distance), exactly as EVALUATE sums
    it. `kind` is 0 for the main problem, 1 for the perturbations; `mult` keeps the
    integer multipliers (4 for the main problem, 13 for the perturbations) and `raw`
    the published amplitude (A, or S and C) for the binary writer.
    """

    def __init__(self, source=DEFAULT_SOURCE, icor=1, verify=True):
        if verify:
            self.provenance = verify_files(source)
        k = Constants(icor)
        self.k = k
        coord, power, kind, amp, fk, mult, raw = [], [], [], [], [], [], []
        for iv in range(3):
            for ilu, a, b in read_main(os.path.join(source, "ELP_MAIN.S%d" % (iv + 1))):
                tgv = b[0] + k.dtasm * b[4]
                if iv == 2:
                    a = a - 2.0 * a * k.delnu / 3.0
                x = a + tgv * (k.delnp - k.am * k.delnu) + b[1] * k.delg + b[2] * k.dele + b[3] * k.delep
                f = np.array([sum(ilu[i] * k.dl[i, kk] for i in range(4)) for kk in range(5)])
                if iv == 2:
                    f[0] += CPI / 2.0
                coord.append(iv); power.append(0); kind.append(0); amp.append(x); fk.append(f)
                mult.append(tuple(ilu) + (0,) * 9); raw.append((a, 0.0))
        for iv in range(3):
            groups = read_pert(os.path.join(source, "ELP_PERT.S%d" % (iv + 1)))
            for it, rows in sorted(groups.items()):
                for s, c, ifi in rows:
                    x = math.sqrt(c * c + s * s)
                    pha = math.atan2(c, s)
                    if pha < 0.0:
                        pha += 2.0 * CPI
                    f = np.zeros(5)
                    for kk in range(5):
                        v = pha if kk == 0 else 0.0
                        for i in range(4):
                            v += ifi[i] * k.dl[i, kk]
                        for i in range(4, 12):
                            v += ifi[i] * k.p[i - 4, kk]
                        v += ifi[12] * k.zeta[kk]
                        f[kk] = v
                    coord.append(iv); power.append(it); kind.append(1); amp.append(x); fk.append(f)
                    mult.append(tuple(ifi)); raw.append((s, c))
        self.coord = np.array(coord)
        self.power = np.array(power)
        self.kind = np.array(kind)
        self.amp = np.array(amp)
        self.fk = np.array(fk)
        self.mult = np.array(mult, dtype=np.int64)
        self.raw = np.array(raw)

    def __len__(self):
        return len(self.amp)

    def sums(self, t, mask=None, chunk=512):
        """Series sums V (arcsec), U (arcsec), r (km, before a405/aelp) at times t
        (Julian centuries of TDB from J2000). Returns an array (3, len(t))."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        idx = np.arange(len(self)) if mask is None else np.flatnonzero(mask)
        out = np.zeros((3, t.size))
        tp = np.vstack([t ** k for k in range(5)])  # (5, n)
        for s in range(0, len(idx), chunk):
            j = idx[s:s + chunk]
            arg = self.fk[j] @ tp  # (m, n)
            val = self.amp[j][:, None] * np.sin(arg) * tp[self.power[j]]
            for iv in range(3):
                sel = self.coord[j] == iv
                if sel.any():
                    out[iv] += val[sel].sum(0)
        return out

    def ecliptic_j2000_km(self, t, mask=None, w1_extra=None):
        """Geocentric X, Y, Z (km) in the inertial mean ecliptic and equinox of J2000.

        `w1_extra` (optional, arcseconds per century**k, k = 0..) is an additive
        correction to the mean longitude W1 that this module's callers may fit; it
        enters the longitude only (the note's Table 6 corrections enter the same way
        in the Fortran through w(1, k))."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        s = self.sums(t, mask)
        w = self.k.w[0]
        v = s[0] / RAD + (w[0] + w[1] * t + w[2] * t ** 2 + w[3] * t ** 3 + w[4] * t ** 4)
        if w1_extra is not None:
            v = v + sum(c * t ** k for k, c in enumerate(w1_extra)) / RAD
        u = s[1] / RAD
        r = s[2] * A405 / AELP
        return laskar_to_j2000(t, r * np.cos(u) * np.cos(v), r * np.cos(u) * np.sin(v), r * np.sin(u))

    def state_j2000(self, t, mask=None):
        """Position (km) and velocity (km/day) by EVALUATE's own analytical derivative,
        for the Table 8 check values (which print both)."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        idx = np.arange(len(self)) if mask is None else np.flatnonzero(mask)
        v = np.zeros((6, t.size))
        tp = np.vstack([t ** k for k in range(5)])
        dtp = np.vstack([k * t ** max(k - 1, 0) if k else 0 * t for k in range(5)])
        for s in range(0, len(idx), 512):
            j = idx[s:s + 512]
            y = self.fk[j] @ tp
            yp = self.fk[j] @ dtp
            x = self.amp[j][:, None]
            pw = self.power[j][:, None]
            tpw = tp[self.power[j]]
            xp = np.where(pw > 0, pw * x * tp[np.maximum(self.power[j] - 1, 0)], 0.0)
            val = x * tpw * np.sin(y)
            dval = xp * np.sin(y) + x * tpw * yp * np.cos(y)
            for iv in range(3):
                sel = self.coord[j] == iv
                v[iv] += val[sel].sum(0)
                v[iv + 3] += dval[sel].sum(0)
        w = self.k.w[0]
        v[0] = v[0] / RAD + w[0] + w[1] * t + w[2] * t ** 2 + w[3] * t ** 3 + w[4] * t ** 4
        v[1] = v[1] / RAD
        v[2] = v[2] * A405 / AELP
        v[3] = v[3] / RAD + w[1] + 2 * w[2] * t + 3 * w[3] * t ** 2 + 4 * w[4] * t ** 3
        v[4] = v[4] / RAD
        # EVALUATE leaves the distance rate v(6) in km per century, unscaled.
        clamb, slamb, cbeta, sbeta = np.cos(v[0]), np.sin(v[0]), np.cos(v[1]), np.sin(v[1])
        cw, sw = v[2] * cbeta, v[2] * sbeta
        x1, x2, x3 = cw * clamb, cw * slamb, sw
        xp1 = (v[5] * cbeta - v[4] * sw) * clamb - v[3] * x2
        xp2 = (v[5] * cbeta - v[4] * sw) * slamb + v[3] * x1
        xp3 = v[5] * sbeta + v[4] * cw
        p1, p2, p3, p4, p5 = P_COEF
        q1, q2, q3, q4, q5 = Q_COEF
        pw_ = (p1 + p2 * t + p3 * t ** 2 + p4 * t ** 3 + p5 * t ** 4) * t
        qw_ = (q1 + q2 * t + q3 * t ** 2 + q4 * t ** 3 + q5 * t ** 4) * t
        ra = 2.0 * np.sqrt(1 - pw_ * pw_ - qw_ * qw_)
        pwqw, pw2, qw2 = 2.0 * pw_ * qw_, 1.0 - 2.0 * pw_ * pw_, 1.0 - 2.0 * qw_ * qw_
        pwra, qwra = pw_ * ra, qw_ * ra
        xyz = np.array([pw2 * x1 + pwqw * x2 + pwra * x3,
                        pwqw * x1 + qw2 * x2 - qwra * x3,
                        -pwra * x1 + qwra * x2 + (pw2 + qw2 - 1) * x3])
        ppw = p1 + (2.0 * p2 + 3.0 * p3 * t + 4.0 * p4 * t ** 2 + 5.0 * p5 * t ** 3) * t
        qpw = q1 + (2.0 * q2 + 3.0 * q3 * t + 4.0 * q4 * t ** 2 + 5.0 * q5 * t ** 3) * t
        ppw2, qpw2 = -4.0 * pw_ * ppw, -4.0 * qw_ * qpw
        ppwqpw = 2.0 * (ppw * qw_ + pw_ * qpw)
        rap = (ppw2 + qpw2) / ra
        ppwra, qpwra = ppw * ra + pw_ * rap, qpw * ra + qw_ * rap
        vel = np.array([
            (pw2 * xp1 + pwqw * xp2 + pwra * xp3 + ppw2 * x1 + ppwqpw * x2 + ppwra * x3) / SC,
            (pwqw * xp1 + qw2 * xp2 - qwra * xp3 + ppwqpw * x1 + qpw2 * x2 - qpwra * x3) / SC,
            (-pwra * xp1 + qwra * xp2 + (pw2 + qw2 - 1.0) * xp3 - ppwra * x1 + qpwra * x2
             + (ppw2 + qpw2) * x3) / SC,
        ])
        return xyz, vel


def laskar_to_j2000(t, x1, x2, x3):
    """Laskar's P, Q: inertial mean ecliptic of date -> that of J2000 (EVALUATE)."""
    p1, p2, p3, p4, p5 = P_COEF
    q1, q2, q3, q4, q5 = Q_COEF
    pw = (p1 + p2 * t + p3 * t ** 2 + p4 * t ** 3 + p5 * t ** 4) * t
    qw = (q1 + q2 * t + q3 * t ** 2 + q4 * t ** 3 + q5 * t ** 4) * t
    ra = 2.0 * np.sqrt(1 - pw * pw - qw * qw)
    pwqw, pw2, qw2 = 2.0 * pw * qw, 1.0 - 2.0 * pw * pw, 1.0 - 2.0 * qw * qw
    pwra, qwra = pw * ra, qw * ra
    return np.array([pw2 * x1 + pwqw * x2 + pwra * x3,
                     pwqw * x1 + qw2 * x2 - qwra * x3,
                     -pwra * x1 + qwra * x2 + (pw2 + qw2 - 1) * x3])


def rot1(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]])


def rot3(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])


def ecliptic_to_equator(frame="JPL405"):
    """The note's Table 7: inertial mean ecliptic and equinox of J2000 -> frame R,
    `R3(-phi) R1(-epsilon)` (frame rotations; phi is the arc from R's origin of right
    ascension to the ecliptic's node, epsilon the inclination)."""
    de, phi = TABLE7[frame]
    eps = (23.0 * 3600.0 + 26.0 * 60.0 + 21.0 + de) / RAD
    return rot3(-phi / RAD) @ rot1(-eps)


def self_test(source=DEFAULT_SOURCE):
    """Reproduce the note's Table 8 for both constant sets; returns the worst
    position and velocity differences (km, km/day)."""
    worst = [0.0, 0.0]
    for icor, rows in TABLE8.items():
        s = Series(source, icor)
        for jd, xyz, vel in rows:
            p, v = s.state_j2000(np.array([(jd - 2451545.0) / SC]))
            worst[0] = max(worst[0], float(np.abs(p[:, 0] - xyz).max()))
            worst[1] = max(worst[1], float(np.abs(v[:, 0] - vel).max()))
    return worst


if __name__ == "__main__":
    import sys

    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    print("Table 8 check values, worst |position| km, |velocity| km/day:", self_test(src))
