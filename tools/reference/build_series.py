"""crates/skyfix-ephemeris/data/series.bin -- the Sun, planet and Moon series, both tiers.

Development-time only (CONVENTIONS section 11): the Rust providers read the binary this
writes and nothing else. Run from the repository root:

    tools/reference/.venv/bin/python -m tools.reference.build_series \
        [--window -2000..3000] [--validated 1550-01-01..2650-01-22] [--quick]

What goes in (EXPANSION_PLAN 4.2, CONVENTIONS 15.1; the measurements behind every
choice are in docs/ACCURACY.md, "Historical accuracy"):

* **VSOP87A** (CDS VI/81) for the Earth and the seven planets, one Earth for both the
  Sun and the planets. Truncated by measured error: the Earth to 0.05" of the Sun's
  direction, each planet to 1" of geocentric direction at its closest approach to the
  Earth, separately for the validated tier (1550-2650) and the labelled tier
  (-2000..3000). Within each (body, coordinate, power) group the terms are sorted by
  amplitude, so each tier's set is a prefix: the file stores the union and, per group,
  how many terms the validated tier uses.
* **Corrections to VSOP87A** fitted by this project, because VSOP87 (fitted to DE200 in
  1988) drifts from the modern ephemerides by up to 10" inside 1550-2650 (Mars, Uranus,
  Neptune) and 110" at 2000 BC (Saturn): per body, the heliocentric ecliptic longitude,
  latitude and log-radius receive a small linear model (polynomial in time, the
  heliocentric longitude's harmonics times low powers of time, and for Jupiter and
  Saturn the great inequality) fitted twice: to JPL DE440 over 1500-2700 (DE441 outside
  DE440's span) for the validated tier, and to DE441 over the whole labelled span. The
  Rust side uses the first inside the validated band and blends to the second over 50
  years beyond each edge.
* **ELP/MPP02** (Chapront & Francou 2003) with the constants fitted to DE405 (icor = 1,
  including the note's additive secular corrections), plus additive corrections to the
  secular polynomials of W1, W2 and W3 fitted by this project to DE441 over the labelled
  span and DE440 over the validated one (the same kind of correction as the note's
  Table 6, which was fitted to DE406). Truncated by amplitude thresholds, prefix per
  group as for VSOP87.

The file uses the pack container of EXPLORER_API "Packs" (magic SKYFIXPK, format 1,
name "series", CRC-32 of the payload); the payload layout (schema skyfix.series/2) is
documented in EXPLORER_API "Series payload (deeptime agent)" and parsed by
crates/skyfix-ephemeris/src/series.rs. It is compact on purpose (the module's download
budget): each body's VSOP87 frequencies are stored once and referenced by a 16-bit
index; amplitudes are f32 below 3e-3 au (f64 above) and phases a 32-bit fraction of a
turn, and a term under 2e-6 au takes a 16-bit amplitude (fixed point on its group's
scale) and a 16-bit phase; the lunar main-problem amplitudes are f32 below 100 (arcsec or
km), the perturbation terms f32 pairs, or 16-bit amplitude and phase under 0.05; the
correction coefficients are f32. Everything is quantised before the corrections are
fitted and the checkpoints computed, so both describe exactly the stored numbers.

The checkpoints the Rust tests re-evaluate and the generator's own measurements go to
crates/skyfix-ephemeris/data/series_checks.json, which is not embedded.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import time
import zlib

import numpy as np

from . import common as c
from . import elpmpp02 as E
from . import vsop87 as V

ARC = math.pi / 648000.0
OUT = os.path.join(c.REPO, "crates", "skyfix-ephemeris", "data", "series.bin")
CHECKS_OUT = os.path.join(c.REPO, "crates", "skyfix-ephemeris", "data", "series_checks.json")
SCHEMA = "skyfix.series/2"
PACK_NAME = "series"

#: Validated tier (DE440's span, CONVENTIONS 15.1) and labelled tier, in the app's
#: clock; the series are cut with a margin of a few days (light-time, Delta T).
VALIDATED = ("1550-01-01T00:00:00Z", "2650-01-22T00:00:00Z")
LABELLED = ("-2000-01-01T00:00:00Z", "3000-12-31T23:59:59Z")
#: Years of blend between the two correction fits beyond each edge of the band.
BLEND_YEARS = 50.0
#: Days added either side of a tier when truncating and measuring.
MARGIN_DAYS = 2.0

#: Truncation budgets: the Earth for the Sun's direction, the planets at closest
#: approach, both in arcseconds; a 10 % margin is kept when choosing.
SUN_BUDGET_ARCSEC = 0.05
PLANET_BUDGET_ARCSEC = 1.0
SELECT_MARGIN = 0.9
#: ELP/MPP02 amplitude thresholds for longitude and latitude (arcsec) and distance
#: (km), applied to |A| * tau^n with tau the tier's largest |t| in centuries.
ELP_THRESHOLDS = (0.002, 0.002, 0.02)

#: Correction basis per tier: (polynomial degree, degree of the time factor on the
#: orbital harmonics, number of harmonics of the heliocentric longitude, great
#: inequality harmonics and their time degree for Jupiter and Saturn).
BASIS = {
    "validated": (3, 2, 3, 2, 2),
    "labelled": (4, 3, 3, 2, 2),
}
#: VSOP87 mean longitudes of Jupiter and Saturn (vsop87.txt): radians and radians per
#: thousand years. The great inequality argument is 2 lambda_J - 5 lambda_S.
LAMBDA_J = (0.59954649739, 529.69096509460)
LAMBDA_S = (0.87401675650, 213.29909543800)

BODY_INDEX = {name: i for i, (name, _, _) in enumerate(V.BODIES)}
DE_KEYS = {"Earth": "earth", "Mercury": "mercury", "Venus": "venus",
           "Mars": "mars barycenter", "Jupiter": "jupiter barycenter",
           "Saturn": "saturn barycenter", "Uranus": "uranus barycenter",
           "Neptune": "neptune barycenter"}


def jd_of(iso):
    s = iso.rstrip("Z")
    date, clock = s.split("T")
    sign = -1 if date.startswith("-") else 1
    y, m, d = date.lstrip("+-").split("-")
    hh, mm, ss = clock.split(":")
    return c.jd_from_gregorian(sign * int(y), int(m), int(d),
                               int(hh) + int(mm) / 60.0 + float(ss) / 3600.0)


# ---------------------------------------------------------------------------
# Reference positions from the JPL kernels
# ---------------------------------------------------------------------------


class Reference:
    """Heliocentric planet and geocentric Moon positions from DE440 inside its span and
    DE441 outside, at TDB Julian dates."""

    def __init__(self):
        from skyfield.api import load

        self.ts = load.timescale(builtin=True)
        self.de440 = c.load_kernel("de440")
        self.de441 = c.load_kernel("de441")
        self.lo = c.jd_from_gregorian(1550, 1, 1)
        self.hi = c.jd_from_gregorian(2650, 1, 22)

    def _split(self, jd, fn):
        jd = np.atleast_1d(np.asarray(jd, dtype=float))
        out = np.zeros((3, jd.size))
        inside = (jd >= self.lo) & (jd <= self.hi)
        if inside.any():
            out[:, inside] = fn(self.de440, jd[inside])
        if (~inside).any():
            out[:, ~inside] = fn(self.de441, jd[~inside])
        return out

    def helio_au(self, body, jd, kernel=None):
        key = DE_KEYS[body]
        f = (lambda k, j: k.position_km(self.ts, key, j, "sun") / 149597870.700)
        if kernel == "de441":
            return f(self.de441, np.atleast_1d(jd))
        return self._split(jd, f)

    def moon_km(self, jd, kernel=None):
        f = (lambda k, j: k.position_km(self.ts, "moon", j, "earth"))
        if kernel == "de441":
            return f(self.de441, np.atleast_1d(jd))
        return self._split(jd, f)


# ---------------------------------------------------------------------------
# VSOP87A: truncation
# ---------------------------------------------------------------------------


def epochs(j0, j1, n, seed):
    rng = np.random.default_rng(seed)
    return np.sort(np.concatenate([np.linspace(j0, j1, n // 2), rng.uniform(j0, j1, n - n // 2)]))


def keep_by_budget(terms, T, budget_au, tabs):
    """Drop terms in increasing |A| tabs^n until the vector sum of the dropped ones
    first exceeds the budget on the grid T; keep the rest (a global threshold)."""
    imp = np.abs(terms.A) * tabs ** terms.power
    order = np.argsort(imp, kind="stable")
    acc = np.zeros((3, T.size))
    ndrop = 0
    chunk = 32
    for s in range(0, len(order), chunk):
        j = order[s:s + chunk]
        a = terms.power[j][:, None]
        val = terms.A[j][:, None] * np.cos(terms.B[j][:, None] + terms.C[j][:, None] * T[None, :]) * T[None, :] ** a
        trial = acc.copy()
        for k in range(3):
            sel = terms.coord[j] == k
            if sel.any():
                trial[k] += val[sel].sum(0)
        if np.sqrt((trial ** 2).sum(0)).max() > budget_au:
            for jj in range(len(j)):
                acc2 = acc.copy()
                acc2[terms.coord[j[jj]]] += val[jj]
                if np.sqrt((acc2 ** 2).sum(0)).max() > budget_au:
                    break
                acc = acc2
                ndrop += 1
            break
        acc = trial
        ndrop += len(j)
    keep = np.ones(len(terms), bool)
    keep[order[:ndrop]] = False
    return keep


def truncate_vsop(series, tier_jd, n_grid):
    """{body: keep mask} for one tier, and the budgets used."""
    j0, j1 = tier_jd[0] - MARGIN_DAYS, tier_jd[1] + MARGIN_DAYS
    jd = epochs(j0, j1, n_grid, 11)
    T = V.tjy(jd)
    tabs = float(np.abs(T).max())
    full = {n: s.xyz(T) for n, s in series.items()}
    E_ = full["Earth"]
    closest = {n: float(np.linalg.norm(full[n] - E_, axis=0).min()) for n in series if n != "Earth"}
    closest["Earth"] = float(np.linalg.norm(E_, axis=0).min())
    keep, budget = {}, {}
    for name, s in series.items():
        arc = SUN_BUDGET_ARCSEC if name == "Earth" else PLANET_BUDGET_ARCSEC
        budget[name] = arc * ARC * closest[name]
        keep[name] = keep_by_budget(s, T, SELECT_MARGIN * budget[name], tabs)
    return keep, budget, closest


# ---------------------------------------------------------------------------
# VSOP87A: corrections
# ---------------------------------------------------------------------------


def corr_basis(body, T, lam, spec):
    """Columns of the correction model; t in centuries, lam the uncorrected
    heliocentric ecliptic longitude (rad). The Rust side builds the same columns in
    the same order (crates/skyfix-ephemeris/src/series.rs, `correction_basis`)."""
    kpoly, korb, harm, gih, gik = spec
    t = T * 10.0
    cols = [t ** k for k in range(kpoly + 1)]
    for h in range(1, harm + 1):
        sh, ch = np.sin(h * lam), np.cos(h * lam)
        for k in range(korb + 1):
            cols += [t ** k * sh, t ** k * ch]
    if body in ("Jupiter", "Saturn"):
        g = 2.0 * (LAMBDA_J[0] + LAMBDA_J[1] * T) - 5.0 * (LAMBDA_S[0] + LAMBDA_S[1] * T)
        for m in range(1, gih + 1):
            sg, cg = np.sin(m * g), np.cos(m * g)
            for k in range(gik + 1):
                cols += [t ** k * sg, t ** k * cg]
    return np.vstack(cols).T


def spherical(x):
    r = np.linalg.norm(x, axis=0)
    return np.arctan2(x[1], x[0]), np.arcsin(x[2] / r), r


def fit_corrections(series, keep, ref, jd, spec, kernel=None):
    """Least-squares corrections (arcsec; log-radius in arcsec units) per body, with the
    truncated series, so truncation and theory error are fitted together."""
    T = V.tjy(jd)
    rot = V.ROTATION_TO_EQUATOR
    out = {}
    for name, s in series.items():
        vs = s.xyz(T, keep[name])
        de = rot.T @ ref.helio_au(name, jd, kernel)
        lv, bv, rv = spherical(vs)
        ld, bd, rd = spherical(de)
        y = {
            "lon": np.angle(np.exp(1j * (ld - lv))) / ARC,
            "lat": (bd - bv) / ARC,
            "rad": (rd - rv) / rv / ARC,
        }
        A = corr_basis(name, T, lv, spec)
        scale = np.abs(A).max(0)
        scale[scale == 0] = 1.0
        coef = {}
        for k, v in y.items():
            x, *_ = np.linalg.lstsq(A / scale, v, rcond=None)
            # Stored as f32: round here so the checkpoints and measurements use them.
            coef[k] = (x / scale).astype(np.float32).astype(np.float64)
        out[name] = coef
    return out


def apply_corrections(name, T, xyz, coef, spec):
    lv, bv, rv = spherical(xyz)
    A = corr_basis(name, T, lv, spec)
    l = lv + (A @ coef["lon"]) * ARC
    b = bv + (A @ coef["lat"]) * ARC
    r = rv * (1.0 + (A @ coef["rad"]) * ARC)
    return np.array([r * np.cos(b) * np.cos(l), r * np.cos(b) * np.sin(l), r * np.sin(b)])


def blend_weight(jd, validated_jd):
    """1 inside the validated band, 0 beyond BLEND_YEARS outside it, smoothstep between
    (the Rust side uses the same function)."""
    span = BLEND_YEARS * 365.25
    lo, hi = validated_jd
    x = np.where(jd < lo, (jd - (lo - span)) / span, np.where(jd > hi, ((hi + span) - jd) / span, 1.0))
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


# ---------------------------------------------------------------------------
# ELP/MPP02: secular fit and truncation
# ---------------------------------------------------------------------------


def elp_effective_multipliers(S):
    """Each term's multiplier of W1, W2 and W3 in its argument."""
    m = S.mult
    isper = S.kind == 1
    mz = np.where(isper, m[:, 12], 0)
    c1 = (m[:, 0] + m[:, 1] + m[:, 2] + mz).astype(float)
    return c1, (-m[:, 2]).astype(float), (-m[:, 1]).astype(float)


def pq_inverse(t, x):
    p = E.P_COEF
    q = E.Q_COEF
    pw = (p[0] + p[1] * t + p[2] * t ** 2 + p[3] * t ** 3 + p[4] * t ** 4) * t
    qw = (q[0] + q[1] * t + q[2] * t ** 2 + q[3] * t ** 3 + q[4] * t ** 4) * t
    ra = 2.0 * np.sqrt(1 - pw * pw - qw * qw)
    pwqw, pw2, qw2 = 2 * pw * qw, 1 - 2 * pw * pw, 1 - 2 * qw * qw
    R = np.array([[pw2, pwqw, pw * ra], [pwqw, qw2, -qw * ra], [-pw * ra, qw * ra, pw2 + qw2 - 1]])
    return np.einsum("jin,jn->in", R, x)


def elp_model(S, cmult, t, dW, mask=None, partials=False):
    """V, U (rad), r (km) with additive secular corrections dW (3x5 arcsec/cy^k), and
    optionally the partial sums needed for the fit."""
    c1, c2, c3 = cmult
    tp = np.vstack([t ** k for k in range(5)])
    dpoly = (dW / E.RAD) @ tp
    idx = np.arange(len(S)) if mask is None else np.flatnonzero(mask)
    out = np.zeros((3, t.size))
    part = np.zeros((3, 3, t.size))
    for s in range(0, len(idx), 400):
        j = idx[s:s + 400]
        arg = S.fk[j] @ tp + c1[j][:, None] * dpoly[0] + c2[j][:, None] * dpoly[1] + c3[j][:, None] * dpoly[2]
        a = S.amp[j][:, None] * tp[S.power[j]]
        val = a * np.sin(arg)
        dv = a * np.cos(arg) if partials else None
        for iv in range(3):
            sel = S.coord[j] == iv
            if not sel.any():
                continue
            out[iv] += val[sel].sum(0)
            if partials:
                for cj, cc in enumerate((c1, c2, c3)):
                    part[iv, cj] += (dv[sel] * cc[j][sel][:, None]).sum(0)
    w = S.k.w[0]
    V_ = out[0] / E.RAD + (w @ tp) + dpoly[0]
    U_ = out[1] / E.RAD
    r_ = out[2] * E.A405 / E.AELP
    part[0] /= E.RAD
    part[1] /= E.RAD
    part[2] *= E.A405 / E.AELP
    part[0, 0] += 1.0
    return V_, U_, r_, part


#: Which secular coefficients the fit adjusts: (angle index 0..2 for W1..W3, power).
ELP_FIT_PARAMS = [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (1, 1), (1, 2), (1, 3), (1, 4),
                  (2, 1), (2, 2), (2, 3), (2, 4)]


def fit_elp(S, ref, jd441, jd440, w440=3.0, iterations=3):
    M = E.ecliptic_to_equator("JPL405")
    cmult = elp_effective_multipliers(S)

    def de_vur(jd, kernel):
        t = (jd - 2451545.0) / 36525.0
        de = ref.moon_km(jd, kernel)
        e = pq_inverse(t, M.T @ de)
        r = np.linalg.norm(e, axis=0)
        return np.arctan2(e[1], e[0]), np.arcsin(e[2] / r), r

    Va, Ua, ra = de_vur(jd441, "de441")
    Vb, Ub, rb = de_vur(jd440, None)
    T = np.concatenate([(jd441 - 2451545.0) / 36525.0, (jd440 - 2451545.0) / 36525.0])
    Vd, Ud, rd = np.concatenate([Va, Vb]), np.concatenate([Ua, Ub]), np.concatenate([ra, rb])
    wt = np.concatenate([np.ones(jd441.size), w440 * np.ones(jd440.size)])
    km2as = E.RAD / 384400.0
    dW = np.zeros((3, 5))
    for it in range(iterations):
        V_, U_, r_, part = elp_model(S, cmult, T, dW, partials=True)
        res = np.concatenate([np.angle(np.exp(1j * (Vd - V_))) * E.RAD, (Ud - U_) * E.RAD, (rd - r_) * km2as])
        ts_ = T / 20.0
        cols = []
        for (j, k) in ELP_FIT_PARAMS:
            cols.append(np.concatenate([part[0, j] * ts_ ** k, part[1, j] * ts_ ** k,
                                        part[2, j] * ts_ ** k * km2as / E.RAD]))
        A = np.array(cols).T
        sw = np.sqrt(np.concatenate([wt, wt, wt]))
        x, *_ = np.linalg.lstsq(A * sw[:, None], res * sw, rcond=None)
        for (j, k), xv in zip(ELP_FIT_PARAMS, x):
            dW[j, k] += xv / 20.0 ** k
        print("   ELP secular fit, iteration %d: rms longitude residual %.3f\"" %
              (it, math.sqrt(np.mean((res[:T.size]) ** 2))), flush=True)
    return dW


def elp_constants(S, dW):
    """The constants the Rust evaluator needs, with the secular corrections applied the
    way INITIAL applies the note's Table 6: to W1..W3 before the Delaunay arguments and
    zeta are formed."""
    k = S.k
    w = k.w.copy() + dW / E.RAD
    dl = np.zeros((4, 5))
    dl[0] = w[0] - k.eart
    dl[1] = w[0] - w[2]
    dl[2] = w[0] - w[1]
    dl[3] = k.eart - k.peri
    dl[0, 0] += E.CPI
    zeta = w[0].copy()
    zeta[1] = w[0, 1] + (5029.0966 - 0.29965) / E.RAD
    return w, dl, zeta


def elp_args(S, dl, zeta):
    """Per-term argument polynomials fk (5 coefficients), exactly READFILE's."""
    k = S.k
    fk = np.zeros((len(S), 5))
    m = S.mult
    main = S.kind == 0
    for kk in range(5):
        v = np.zeros(len(S))
        for i in range(4):
            v += m[:, i] * dl[i, kk]
        per = ~main
        pl = np.zeros(len(S))
        for i in range(4, 12):
            pl += m[:, i] * k.p[i - 4, kk]
        v = np.where(per, v + pl + m[:, 12] * zeta[kk], v)
        fk[:, kk] = v
    phase = np.zeros(len(S))
    s_, c_ = S.raw[:, 0], S.raw[:, 1]
    pha = np.arctan2(c_, s_)
    pha = np.where(pha < 0.0, pha + 2 * E.CPI, pha)
    phase = np.where(main, np.where(S.coord == 2, E.CPI / 2.0, 0.0), pha)
    fk[:, 0] += phase
    return fk


def elp_keep(S, tabs):
    thr = np.array(ELP_THRESHOLDS)[S.coord]
    return np.abs(S.amp) * tabs ** S.power > thr


# ---------------------------------------------------------------------------
# Binary writer
# ---------------------------------------------------------------------------


def f32_round(x):
    return float(np.float32(x))


def turns_u32(b):
    """Phase B (rad) as a fraction of a turn in 32 bits (resolution 1.5e-9 rad)."""
    f = (b / (2.0 * math.pi)) % 1.0
    v = int(round(f * 4294967296.0)) % 4294967296
    return v


def u32_turns_to_rad(v):
    return v / 4294967296.0 * 2.0 * math.pi


def turns_u16(b):
    """Phase B (rad) as a fraction of a turn in 16 bits (resolution 9.6e-5 rad)."""
    f = (b / (2.0 * math.pi)) % 1.0
    return int(round(f * 65536.0)) % 65536


def u16_turns_to_rad(v):
    return v / 65536.0 * 2.0 * math.pi


#: A VSOP term's amplitude and phase are stored as f64 ("wide" record, 18 B) when
#: |A| tabs^n exceeds this (au): the f32 rounding of anything smaller is under 1e-10 au.
WIDE_AU = 3.0e-3
#: Below this |A| tabs^n (au) a term is "coarse" (6 B): its amplitude is a 16-bit
#: fixed-point fraction of its group's largest coarse amplitude (rounding under 1.6e-11
#: au) and its phase 16 bits of a turn (rounding at most 4.8e-5 rad, under 1e-10 au).
#: Between the two the amplitude is f32 and the phase 32 bits ("fine", 10 B).
COARSE_AU = 2.0e-6
#: Lunar main-problem amplitudes below this (arcsec, or km for the distance) are f32:
#: the rounding is under 6e-6 of either.
ELP_WIDE_AMP = 100.0
#: Lunar perturbation terms with |A| tau^n below this (arcsec or km) are coarse: a
#: 16-bit amplitude on the group's scale and a 16-bit phase (errors under 3e-6).
ELP_COARSE_AMP = 0.05


def fixed_u16(values):
    """(scale, [q]): non-negative values as q * scale, q in 0..65535."""
    top = max(values) if len(values) else 0.0
    scale = top / 65535.0 if top > 0 else 1.0
    return scale, [int(round(v / scale)) for v in values]


def vsop_groups(series, keep_v, keep_l, tabs_l):
    """Per body, coordinate and power: the stored terms (sorted by |A|), the count
    each tier uses and how many leading terms are wide."""
    out = {}
    for name, s in series.items():
        groups = []
        for coord in range(3):
            powers = []
            pmax = int(s.power[s.coord == coord].max()) if (s.coord == coord).any() else -1
            for p in range(pmax + 1):
                sel = (s.coord == coord) & (s.power == p)
                idx = np.flatnonzero(sel)
                order = idx[np.argsort(-np.abs(s.A[idx]), kind="stable")]
                kv = keep_v[name][order]
                kl = keep_l[name][order]
                n_v = int(np.flatnonzero(kv).max() + 1) if kv.any() else 0
                n_l = int(np.flatnonzero(kl).max() + 1) if kl.any() else 0
                n = max(n_v, n_l)
                chosen = order[:n]
                wide = np.abs(s.A[chosen]) * tabs_l ** p > WIDE_AU
                n_wide = int(np.flatnonzero(wide).max() + 1) if wide.any() else 0
                fine = np.abs(s.A[chosen]) * tabs_l ** p > COARSE_AU
                n_fine = max(n_wide, int(np.flatnonzero(fine).max() + 1) if fine.any() else 0)
                powers.append((chosen, n_v, n_wide, n_fine))
            # drop trailing empty powers
            while powers and len(powers[-1][0]) == 0:
                powers.pop()
            groups.append(powers)
        out[name] = groups
    return out


def dequantized(series, groups):
    """{body: Terms} exactly as the Rust side will read them back, plus the validated
    prefix mask, so checkpoints are computed from the stored numbers."""
    out = {}
    for name, s in series.items():
        coord, power, A, B, C, valid = [], [], [], [], [], []
        for ci, powers in enumerate(groups[name]):
            for p, (chosen, n_v, n_wide, n_fine) in enumerate(powers):
                scale, q = fixed_u16([float(s.A[j]) for j in chosen[n_fine:]])
                for i, j in enumerate(chosen):
                    coord.append(ci)
                    power.append(p)
                    if i < n_wide:
                        A.append(s.A[j]); B.append(s.B[j])
                    elif i < n_fine:
                        A.append(f32_round(s.A[j])); B.append(u32_turns_to_rad(turns_u32(s.B[j])))
                    else:
                        A.append(q[i - n_fine] * scale); B.append(u16_turns_to_rad(turns_u16(s.B[j])))
                    C.append(s.C[j])
                    valid.append(i < n_v)
        out[name] = (V.Terms(coord, power, A, B, C), np.array(valid, bool))
    return out


def pack_vsop(series, groups):
    """Per body: its frequency dictionary (the distinct C of the stored terms, sorted,
    f64), then per coordinate and power the counts and the records, each naming its
    frequency by a u16 index."""
    b = bytearray()
    b += struct.pack("<B", len(series))
    for name, s in series.items():
        b += struct.pack("<B", BODY_INDEX[name])
        used = sorted({float(s.C[j]) for powers in groups[name] for chosen, *_ in powers for j in chosen})
        assert len(used) < 65536
        index = {v: k for k, v in enumerate(used)}
        b += struct.pack("<H", len(used)) + struct.pack("<%dd" % len(used), *used)
        for powers in groups[name]:
            b += struct.pack("<B", len(powers))
            for chosen, n_v, n_wide, n_fine in powers:
                scale, q = fixed_u16([float(s.A[j]) for j in chosen[n_fine:]])
                b += struct.pack("<IIIId", len(chosen), n_v, n_wide, n_fine, scale)
                for i, j in enumerate(chosen):
                    f = index[float(s.C[j])]
                    if i < n_wide:
                        b += struct.pack("<ddH", s.A[j], s.B[j], f)
                    elif i < n_fine:
                        b += struct.pack("<fIH", s.A[j], turns_u32(s.B[j]), f)
                    else:
                        b += struct.pack("<HHH", q[i - n_fine], turns_u16(s.B[j]), f)
    return bytes(b)


def pack_vcor(coefs, validated_jd):
    b = bytearray()
    b += struct.pack("<dddd", LAMBDA_J[0], LAMBDA_J[1], LAMBDA_S[0], LAMBDA_S[1])
    b += struct.pack("<ddd", validated_jd[0], validated_jd[1], BLEND_YEARS * 365.25)
    b += struct.pack("<B", len(coefs["validated"]))
    for name in coefs["validated"]:
        b += struct.pack("<B", BODY_INDEX[name])
        for tier in ("validated", "labelled"):
            spec = BASIS[tier]
            b += struct.pack("<BBBBB", *spec)
            for comp in ("lon", "lat", "rad"):
                v = coefs[tier][name][comp]
                b += struct.pack("<H", len(v))
                b += struct.pack("<%df" % len(v), *v)
    return bytes(b)


def pack_elp_constants(S, w, dl, zeta, M):
    k = S.k
    vals = list(w.ravel()) + list(dl.ravel()) + list(k.p[:, :2].ravel()) + list(zeta)
    vals += list(E.P_COEF) + list(E.Q_COEF) + [E.A405 / E.AELP] + list(M.ravel())
    return struct.pack("<H", len(vals)) + struct.pack("<%dd" % len(vals), *vals)


def pack_elp_series(S, keep_v, keep_l, tabs_l):
    """Main problem per coordinate, then perturbations per coordinate and power; each
    group sorted by |amplitude| with the validated count first."""
    b = bytearray()
    groups = []
    for kind in (0, 1):
        for iv in range(3):
            powers = [0] if kind == 0 else [0, 1, 2, 3]
            for p in powers:
                sel = (S.kind == kind) & (S.coord == iv) & (S.power == p)
                idx = np.flatnonzero(sel)
                order = idx[np.argsort(-np.abs(S.amp[idx]), kind="stable")]
                kv, kl = keep_v[order], keep_l[order]
                n_v = int(np.flatnonzero(kv).max() + 1) if kv.any() else 0
                n_l = int(np.flatnonzero(kl).max() + 1) if kl.any() else 0
                n = max(n_v, n_l)
                chosen = order[:n]
                if kind == 0:
                    big = np.abs(S.amp[chosen]) >= ELP_WIDE_AMP
                else:
                    big = np.abs(S.amp[chosen]) * tabs_l ** p >= ELP_COARSE_AMP
                n_wide = int(np.flatnonzero(big).max() + 1) if big.any() else 0
                groups.append((kind, iv, p, chosen, n_v, n_wide))
    b += struct.pack("<H", len(groups))
    for kind, iv, p, chosen, n_v, n_wide in groups:
        scale = elp_coarse(S, chosen, n_wide)[0] if kind == 1 else 1.0
        b += struct.pack("<BBBIIId", kind, iv, p, len(chosen), n_v, n_wide, scale)
        _, q, ph = elp_coarse(S, chosen, n_wide) if kind == 1 else (1.0, [], [])
        for i, j in enumerate(chosen):
            if kind == 0:
                mult = [int(x) for x in S.mult[j][:4]]
                if i < n_wide:
                    b += struct.pack("<4bd", *mult, S.amp[j])
                else:
                    b += struct.pack("<4bf", *mult, S.amp[j])
            else:
                mult = [int(x) for x in S.mult[j][:13]]
                if i < n_wide:
                    s_, c_ = S.raw[j]
                    b += struct.pack("<13bff", *mult, s_, c_)
                else:
                    b += struct.pack("<13bHH", *mult, q[i - n_wide], ph[i - n_wide])
    return bytes(b), groups


def elp_coarse(S, chosen, n_wide):
    """(scale, [amplitude q], [phase turns u16]) of a perturbation group's coarse tail."""
    amps, phases = [], []
    for j in chosen[n_wide:]:
        s_, c_ = S.raw[j]
        amps.append(math.hypot(s_, c_))
        phases.append(turns_u16(S_phase(S, j)))
    scale, q = fixed_u16(amps)
    return scale, q, phases


def elp_pert_stored(S, coarse, n_wide, i, j):
    """(amplitude, phase) of perturbation term j exactly as the file stores it;
    `coarse` is its group's `elp_coarse`."""
    if i < n_wide:
        s_, c_ = f32_round(S.raw[j][0]), f32_round(S.raw[j][1])
        pha = math.atan2(c_, s_)
        return math.sqrt(s_ * s_ + c_ * c_), pha + 2 * E.CPI if pha < 0.0 else pha
    scale, q, ph = coarse
    return q[i - n_wide] * scale, u16_turns_to_rad(ph[i - n_wide])


def container(payload):
    name = PACK_NAME.encode("utf-8")
    head = b"SKYFIXPK" + struct.pack("<HH", 1, len(name)) + name + struct.pack("<I", len(payload))
    return head + payload + struct.pack("<I", zlib.crc32(payload) & 0xFFFFFFFF)


def sections(items):
    b = bytearray(struct.pack("<I", len(items)))
    for tag, data in items:
        assert len(tag) == 4
        b += tag.encode("ascii") + struct.pack("<I", len(data)) + data
    return bytes(b)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    c.add_window_kernel_args(ap, "-2000-01-01..3001-01-01", "auto")
    ap.add_argument("--validated", default="1550-01-01..2650-01-22",
                    help="the validated band (default %(default)s)")
    ap.add_argument("--vsop-source", default=None, help="directory of the CDS VI/81 files")
    ap.add_argument("--elp-source", default=E.DEFAULT_SOURCE,
                    help="directory of the ELP/MPP02 files (default %(default)s)")
    ap.add_argument("--quick", action="store_true", help="smaller grids (for development)")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--checks-out", default=CHECKS_OUT)
    args = ap.parse_args(argv)
    t_start = time.time()
    lab = c.parse_window(args.window)
    val = c.parse_window(args.validated)
    n_grid = 4000 if args.quick else 12000

    print("-- reading VSOP87A and ELP/MPP02", flush=True)
    series, vprov, vsrc = V.load_all(args.vsop_source)
    elp_prov = E.verify_files(args.elp_source)
    S = E.Series(args.elp_source, icor=1, verify=False)
    worst_t8 = E.self_test(args.elp_source)
    if worst_t8[0] > 2e-5:
        raise SystemExit("ELP/MPP02 port disagrees with the note's Table 8: %r" % (worst_t8,))
    ref = Reference()

    print("-- VSOP87A truncation, validated tier", flush=True)
    keep_v, budget_v, closest_v = truncate_vsop(series, val, n_grid)
    print("-- VSOP87A truncation, labelled tier", flush=True)
    keep_l, budget_l, closest_l = truncate_vsop(series, lab, n_grid)
    tabs_l = float(np.abs(V.tjy(np.array([lab[0] - MARGIN_DAYS, lab[1] + MARGIN_DAYS]))).max())
    groups = vsop_groups(series, keep_v, keep_l, tabs_l)
    deq = dequantized(series, groups)

    print("-- VSOP87A corrections", flush=True)
    span = BLEND_YEARS * 365.25 + 30.0
    jd_fit_v = epochs(val[0] - span, val[1] + span, n_grid, 21)
    jd_fit_l = epochs(lab[0] - span, lab[1] + span, n_grid, 22)
    # Fit on exactly the stored terms of each tier.
    keep_deq_v = {n: deq[n][1] for n in series}
    keep_deq_l = {n: np.ones(len(deq[n][0]), bool) for n in series}
    deq_terms = {n: deq[n][0] for n in series}
    coefs = {
        "validated": fit_corrections(deq_terms, keep_deq_v, ref, jd_fit_v, BASIS["validated"]),
        "labelled": fit_corrections(deq_terms, keep_deq_l, ref, jd_fit_l, BASIS["labelled"], "de441"),
    }

    print("-- ELP/MPP02 secular fit", flush=True)
    rng = np.random.default_rng(42)
    jd441 = np.sort(rng.uniform(lab[0] - 30, lab[1] + 30, 3000 if args.quick else 8000))
    jd440 = np.sort(rng.uniform(val[0] + 1, val[1] - 1, 1500 if args.quick else 4000))
    dW = fit_elp(S, ref, jd441, jd440)
    w, dl, zeta = elp_constants(S, dW)
    fk_corr = elp_args(S, dl, zeta)
    # The corrected constants must reproduce "original arguments + the fitted secular
    # corrections through each term's W1, W2, W3 multipliers" (what the fit modelled).
    c1, c2, c3 = elp_effective_multipliers(S)
    expect = S.fk + (np.outer(c1, dW[0]) + np.outer(c2, dW[1]) + np.outer(c3, dW[2])) / E.RAD
    if np.abs(fk_corr - expect).max() > 1e-9:
        raise SystemExit("corrected ELP arguments disagree with the fitted model")
    tabs_v_cy = float(np.abs((np.array(val) - 2451545.0) / 36525.0).max())
    tabs_l_cy = float(np.abs((np.array(lab) - 2451545.0) / 36525.0).max())
    elp_keep_v = elp_keep(S, tabs_v_cy)
    elp_keep_l = elp_keep(S, tabs_l_cy)
    M405 = E.ecliptic_to_equator("JPL405")

    print("-- measuring", flush=True)
    measured = measure(series, deq, coefs, S, dW, elp_keep_v, elp_keep_l, M405, ref, val, lab, args.quick)

    print("-- writing", flush=True)
    vsop_bin = pack_vsop(series, groups)
    vcor_bin = pack_vcor(coefs, val)
    elpk_bin = pack_elp_constants(S, w, dl, zeta, M405)
    elps_bin, elp_groups = pack_elp_series(S, elp_keep_v, elp_keep_l, tabs_l_cy)

    checkpoints = make_checkpoints(deq, coefs, S, fk_corr, elp_groups, M405, val, lab)
    checks = {
        "schema": SCHEMA,
        "about": ("Not embedded. What tools/reference/build_series.py computed from the stored "
                  "numbers of series.bin (checkpoints, which crates/skyfix-ephemeris re-evaluates "
                  "in its tests) and its own measurement of the stored model against JPL DE440 "
                  "and DE441 (geometric directions, per bin)."),
        "series_crc32": None,
        "checkpoints": checkpoints,
        "measured": measured,
    }
    meta = {
        "schema": SCHEMA,
        "generator": "tools/reference/build_series.py",
        "generated_utc": c.generated_utc(),
        "validated": {"start_utc": VALIDATED[0], "end_utc": VALIDATED[1], "jd": list(val)},
        "labelled": {"start_utc": LABELLED[0], "end_utc": LABELLED[1], "jd": list(lab)},
        "vsop87a": {
            "catalogue": "VI/81 Planetary Solutions VSOP87 (Bretagnon & Francou 1988)",
            "files": vprov,
            "rule": ("per body, keep the terms whose peak |A| tau^n exceeds a threshold chosen "
                     "so the dropped terms' vector sum stays inside %.0f%% of the budget on a "
                     "%d-epoch grid: the Earth %.2f\" of the Sun's direction, each planet %.1f\" "
                     "at its closest approach; separately per tier, stored as the union, each "
                     "group sorted by |A|, the validated count first"
                     % (SELECT_MARGIN * 100, n_grid, SUN_BUDGET_ARCSEC, PLANET_BUDGET_ARCSEC)),
            "terms_total": int(sum(len(s) for s in series.values())),
            "terms_stored": int(sum(len(deq[n][0]) for n in series)),
            "terms_validated": int(sum(deq[n][1].sum() for n in series)),
            "per_body": {n: {"stored": int(len(deq[n][0])), "validated": int(deq[n][1].sum()),
                             "total": int(len(series[n])),
                             "closest_au_validated": closest_v[n], "closest_au_labelled": closest_l[n]}
                         for n in series},
            "wide_record_threshold_au": WIDE_AU,
            "coarse_phase_threshold_au": COARSE_AU,
        },
        "vsop87a_corrections": {
            "what": ("delta longitude, delta latitude and delta r / r (arcsec units) of the "
                     "heliocentric ecliptic J2000 position, linear in the basis of "
                     "build_series.corr_basis; validated fit to DE440 over the band +/- %g "
                     "years (DE441 outside DE440), labelled fit to DE441 over the labelled "
                     "span; smoothstep blend over %g years beyond each edge"
                     % (BLEND_YEARS, BLEND_YEARS)),
            "basis": {k: list(v) for k, v in BASIS.items()},
        },
        "elpmpp02": {
            "reference": "Chapront J., Francou G., 2003, A&A 404, 735 (ELP/MPP02)",
            "files": elp_prov,
            "constants": "DE405 fit (icor = 1) with the note's Table 6, plus this project's secular corrections",
            "secular_corrections_arcsec_per_cy_k": {"W1": list(dW[0]), "W2": list(dW[1]), "W3": list(dW[2])},
            "thresholds": {"longitude_arcsec": ELP_THRESHOLDS[0], "latitude_arcsec": ELP_THRESHOLDS[1],
                           "distance_km": ELP_THRESHOLDS[2]},
            "terms_total": int(len(S)),
            "terms_stored": int(sum(len(g[3]) for g in elp_groups)),
            "terms_validated": int(sum(g[4] for g in elp_groups)),
            "table8_worst_km": worst_t8[0],
            "frame": "note Table 7, JPL405: epsilon 23 26' 21.40960\", phi -0.05028\"",
            "main_amplitude_f64_from": ELP_WIDE_AMP,
            "perturbation_coarse_below": ELP_COARSE_AMP,
        },
        "checks": "crates/skyfix-ephemeris/data/series_checks.json (not embedded)",
    }
    meta_bin = json.dumps(meta, sort_keys=True, separators=(",", ":")).encode("utf-8")
    payload = sections([("META", meta_bin), ("VSOP", vsop_bin), ("VCOR", vcor_bin),
                        ("ELPK", elpk_bin), ("ELPS", elps_bin)])
    blob = container(payload)
    with open(args.out, "wb") as f:
        f.write(blob)
    checks["series_crc32"] = "%08x" % (zlib.crc32(payload) & 0xFFFFFFFF)
    # Plain json: the checkpoints need every bit (repr floats round-trip exactly).
    with open(args.checks_out, "w", encoding="utf-8") as f:
        f.write(json.dumps(checks, indent=1, sort_keys=True) + "\n")
    print("wrote %s: %d B (VSOP %d, VCOR %d, ELPK %d, ELPS %d, META %d); gzip -9 %d B; %.0f s"
          % (os.path.relpath(args.out, c.REPO), len(blob), len(vsop_bin), len(vcor_bin), len(elpk_bin),
             len(elps_bin), len(meta_bin), len(zlib.compress(blob, 9)), time.time() - t_start))
    return 0


def corrected_xyz(name, T, xyz, coefs, jd, val):
    w = blend_weight(jd, val)
    xv = apply_corrections(name, T, xyz, coefs["validated"][name], BASIS["validated"])
    xl = apply_corrections(name, T, xyz, coefs["labelled"][name], BASIS["labelled"])
    # Blend the corrections (not the positions): interpolate longitude, latitude, r.
    lv, bv, rv = spherical(xv)
    ll, bl, rl = spherical(xl)
    dlon = np.angle(np.exp(1j * (lv - ll)))
    l = ll + w * dlon
    b = bl + w * (bv - bl)
    r = rl + w * (rv - rl)
    return np.array([r * np.cos(b) * np.cos(l), r * np.cos(b) * np.sin(l), r * np.sin(b)])


def sep_arcsec(a, b):
    ua = a / np.linalg.norm(a, axis=0)
    ub = b / np.linalg.norm(b, axis=0)
    return np.arctan2(np.linalg.norm(np.cross(ua.T, ub.T), axis=1), (ua * ub).sum(0)) / ARC


def measure(series, deq, coefs, S, dW, elp_keep_v, elp_keep_l, M405, ref, val, lab, quick):
    """Geometric geocentric directions of the stored model against DE440/DE441, per
    half-century in the validated band and per century outside. The authoritative
    numbers are the Rust tests against the apparent-place fixtures; these are the
    generator's own record."""
    out = {"sun_and_planets": {}, "moon": {}}
    rot = V.ROTATION_TO_EQUATOR
    bins = []
    y = 1550
    while y < 2650:
        bins.append(("validated", y, min(y + 50, 2650)))
        y += 50
    for y in range(-2000, 3000, 100):
        if y + 100 <= 1550 or y >= 2650:
            bins.append(("labelled", y, y + 100))
    n = 150 if quick else 500
    cm = elp_effective_multipliers(S)
    for tier, y0, y1 in bins:
        j0 = max(c.jd_from_gregorian(y0, 1, 1), lab[0])
        j1 = min(c.jd_from_gregorian(y1, 1, 1), lab[1])
        if tier == "validated":
            j0, j1 = max(j0, val[0]), min(j1, val[1])
        jd = epochs(j0, j1, n, y0 + 5000)
        T = V.tjy(jd)
        use_valid = tier == "validated"
        pos = {}
        for name in series:
            terms, vmask = deq[name]
            mask = vmask if use_valid else None
            pos[name] = rot @ corrected_xyz(name, T, terms.xyz(T, mask), coefs, jd, val)
        de_e = ref.helio_au("Earth", jd)
        key = "%d..%d" % (y0, y1)
        row = {"sun": float(sep_arcsec(-pos["Earth"], -de_e).max())}
        for name in series:
            if name == "Earth":
                continue
            row[name.lower()] = float(sep_arcsec(pos[name] - pos["Earth"], ref.helio_au(name, jd) - de_e).max())
        out["sun_and_planets"][key] = row
        t = (jd - 2451545.0) / 36525.0
        mask = elp_keep_v if use_valid else (elp_keep_v | elp_keep_l)
        V_, U_, r_, _ = elp_model(S, cm, t, dW, mask=mask)
        x = M405 @ E.laskar_to_j2000(t, r_ * np.cos(U_) * np.cos(V_), r_ * np.cos(U_) * np.sin(V_), r_ * np.sin(U_))
        de = ref.moon_km(jd)
        out["moon"][key] = {"direction_arcsec": float(sep_arcsec(x, de).max()),
                            "distance_km": float(np.abs(np.linalg.norm(x, axis=0) - np.linalg.norm(de, axis=0)).max())}
        print("   %-9s %-11s Sun %.3f\"  Moon %.3f\"  %s" % (
            tier, key, row["sun"], out["moon"][key]["direction_arcsec"],
            " ".join("%s %.2f\"" % (k[:3], v) for k, v in row.items() if k != "sun")), flush=True)
    return out


def make_checkpoints(deq, coefs, S, fk_corr, elp_groups, M405, val, lab):
    """Values the Rust side must reproduce from the stored numbers: heliocentric
    uncorrected and corrected positions (au, VSOP87A ecliptic), and the Moon's
    geocentric position (km, ICRS) -- at epochs in both tiers."""
    cps = []
    jds = [2451545.0, 2461310.5, c.jd_from_gregorian(1600, 7, 1), c.jd_from_gregorian(2600, 3, 1),
           c.jd_from_gregorian(1520, 1, 1), c.jd_from_gregorian(2680, 6, 1),
           c.jd_from_gregorian(-1500, 3, 21), c.jd_from_gregorian(2950, 9, 1)]
    for jd in jds:
        in_band = val[0] <= jd <= val[1]
        T = V.tjy(np.array([jd]))
        for name, (terms, vmask) in deq.items():
            raw = terms.xyz(T, vmask if in_band else None)
            cor = corrected_xyz(name, T, raw, coefs, np.array([jd]), val)
            cps.append({"kind": "vsop", "body": name, "jd_tt": jd, "tier": "validated" if in_band else "labelled",
                        "xyz_au": [float(v) for v in raw[:, 0]], "corrected_xyz_au": [float(v) for v in cor[:, 0]]})
        # The Moon from exactly the stored ELP terms (dequantised S and C).
        t = np.array([(jd - 2451545.0) / 36525.0])
        tot = np.zeros(3)
        for kind, iv, p, chosen, n_v, n_wide in elp_groups:
            use = chosen[:n_v] if in_band else chosen
            coarse = elp_coarse(S, chosen, n_wide) if kind == 1 else None
            for i, j in enumerate(use):
                if kind == 0:
                    amp = S.amp[j] if i < n_wide else f32_round(S.amp[j])
                    f = fk_corr[j]
                else:
                    amp, pha = elp_pert_stored(S, coarse, n_wide, i, j)
                    f = fk_corr[j].copy()
                    f[0] = f[0] - S_phase(S, j) + pha
                arg = f[0] + f[1] * t[0] + f[2] * t[0] ** 2 + f[3] * t[0] ** 3 + f[4] * t[0] ** 4
                tot[iv] += amp * t[0] ** p * math.sin(arg)
        cps.append({"kind": "elp_sums", "jd_tt": jd, "tier": "validated" if in_band else "labelled",
                    "sums": [float(v) for v in tot]})
    return cps


def S_phase(S, j):
    s_, c_ = S.raw[j]
    pha = math.atan2(c_, s_)
    return pha + 2 * E.CPI if pha < 0.0 else pha


if __name__ == "__main__":
    sys.exit(main())
