"""Long-term precession of Vondrak, Capitaine & Wallace (2011, A&A 534, A22; erratum 2012,
A&A 541, C1), as ERFA implements it (eraLtpecl, eraLtpequ, eraLtp, eraLtpb).

Development-time only (CONVENTIONS section 11): the validation generators use it to
build the reference frame of the labelled tier (outside 1550-2650, where the IAU 2006
P03 polynomials that Skyfield uses stop being a good model of the precession), and
`self_test()` pins it to ERFA's published test values. The Rust implementation in
`crates/skyfix-ephemeris/src/frames.rs` is checked against the same values.

Also here: the long-term Greenwich mean sidereal time consistent with that precession,
`gmst_minus_era_arcsec(t)`, obtained by integrating the kinematic definition of the
celestial intermediate origin along the precessing mean pole (see `cio_s_series`).
"""

from __future__ import annotations

import math

import numpy as np

DAS2R = math.pi / 648000.0
D2PI = 2.0 * math.pi

#: eraLtpecl: P_A, Q_A polynomial (arcsec, t^0..t^3) and periodic terms
#: (period in centuries, P cos, Q cos, P sin, Q sin).
PQPOL = [(5851.607687, -0.1189000, -0.00028913, 0.000000101),
         (-1600.886300, 1.1689818, -0.00000020, -0.000000437)]
PQPER = [
    (708.15, -5486.751211, -684.661560, 667.666730, -5523.863691),
    (2309.00, -17.127623, 2446.283880, -2354.886252, -549.747450),
    (1620.00, -617.517403, 399.671049, -428.152441, -310.998056),
    (492.20, 413.442940, -356.652376, 376.202861, 421.535876),
    (1183.00, 78.614193, -186.387003, 184.778874, -36.776172),
    (622.00, -180.732815, -316.800070, 335.321713, -145.278396),
    (882.00, -87.676083, 198.296701, -185.138669, -34.744450),
    (547.00, 46.140315, 101.135679, -120.972830, 22.885731),
]
#: eraLtpequ: X, Y polynomial and periodic terms (period, X cos, Y cos, X sin, Y sin).
XYPOL = [(5453.282155, 0.4252841, -0.00037173, -0.000000152),
         (-73750.930350, -0.7675452, -0.00018725, 0.000000231)]
XYPER = [
    (256.75, -819.940624, 75004.344875, 81491.287984, 1558.515853),
    (708.15, -8444.676815, 624.033993, 787.163481, 7774.939698),
    (274.20, 2600.009459, 1251.136893, 1251.296102, -2219.534038),
    (241.45, 2755.175630, -1102.212834, -1257.950837, -2523.969396),
    (2309.00, -167.659835, -2660.664980, -2966.799730, 247.850422),
    (492.20, 871.855056, 699.291817, 639.744522, -846.485643),
    (396.10, 44.769698, 153.167220, 131.600209, -1393.124055),
    (288.90, -512.313065, -950.865637, -445.040117, 368.526116),
    (231.10, -819.415595, 499.754645, 584.522874, 749.045012),
    (1610.00, -538.071099, -145.188210, -89.756563, 444.704518),
    (620.00, -189.793622, 558.116553, 524.429630, 235.934465),
    (157.87, -402.922932, -23.923029, -13.549067, 374.049623),
    (220.30, 179.516345, -165.405086, -210.157124, -171.330180),
    (1200.00, -9.814756, 9.344131, -44.919798, -22.899655),
]
EPS0 = 84381.406 * DAS2R


def ltpecl(epj):
    """Ecliptic pole unit vector (mean equator and equinox of J2000 axes)."""
    t = (epj - 2000.0) / 100.0
    p = q = 0.0
    w = D2PI * t
    for per, pc, qc, ps, qs in PQPER:
        a = w / per
        s, c = math.sin(a), math.cos(a)
        p += c * pc + s * ps
        q += c * qc + s * qs
    w = 1.0
    for i in range(4):
        p += PQPOL[0][i] * w
        q += PQPOL[1][i] * w
        w *= t
    p *= DAS2R
    q *= DAS2R
    w = 1.0 - p * p - q * q
    w = 0.0 if w < 0.0 else math.sqrt(w)
    s, c = math.sin(EPS0), math.cos(EPS0)
    return np.array([p, -q * c - w * s, -q * s + w * c])


def ltpequ(epj):
    """Equator pole unit vector (mean equator and equinox of J2000 axes)."""
    t = (epj - 2000.0) / 100.0
    x = y = 0.0
    w = D2PI * t
    for per, xc, yc, xs, ys in XYPER:
        a = w / per
        s, c = math.sin(a), math.cos(a)
        x += c * xc + s * xs
        y += c * yc + s * ys
    w = 1.0
    for i in range(4):
        x += XYPOL[0][i] * w
        y += XYPOL[1][i] * w
        w *= t
    x *= DAS2R
    y *= DAS2R
    w = 1.0 - x * x - y * y
    return np.array([x, y, 0.0 if w < 0.0 else math.sqrt(w)])


def ltp(epj):
    """Precession matrix, mean J2000 -> mean of date (rows: equinox, y, pole)."""
    peqr = ltpequ(epj)
    pecl = ltpecl(epj)
    v = np.cross(peqr, pecl)
    eqx = v / np.linalg.norm(v)
    v = np.cross(peqr, eqx)
    return np.array([eqx, v, peqr])


#: IERS 2010 frame bias (eraLtpb): dx, de, dr in radians.
BIAS_DX = -0.016617 * DAS2R
BIAS_DE = -0.0068192 * DAS2R
BIAS_DR = -0.0146 * DAS2R


def ltpb(epj):
    """Precession-bias matrix, GCRS -> mean of date (eraLtpb)."""
    rp = ltp(epj)
    rpb = np.zeros((3, 3))
    for i in range(3):
        rpb[i][0] = rp[i][0] - rp[i][1] * BIAS_DR + rp[i][2] * BIAS_DX
        rpb[i][1] = rp[i][0] * BIAS_DR + rp[i][1] + rp[i][2] * BIAS_DE
        rpb[i][2] = -rp[i][0] * BIAS_DX - rp[i][1] * BIAS_DE + rp[i][2]
    return rpb


def self_test():
    """ERFA t_erfa_c.c values; returns the worst absolute difference."""
    want_ltp = [[0.9967044141159213819, 0.7437801893193210840e-1, 0.3237624409345603401e-1],
                [-0.7437802731819618167e-1, 0.9972293894454533070, -0.1205768842723593346e-2],
                [-0.3237622482766575399e-1, -0.1206286039697609008e-2, 0.9994750246704010914]]
    want_ltpb = [[0.9967044167723271851, 0.7437794731203340345e-1, 0.3237632684841625547e-1],
                 [-0.7437795663437177152e-1, 0.9972293947500013666, -0.1205741865911243235e-2],
                 [-0.3237630543224664992e-1, -0.1206316791076485295e-2, 0.9994750220222438819]]
    worst = 0.0
    worst = max(worst, float(np.abs(ltp(1666.666) - np.array(want_ltp)).max()))
    worst = max(worst, float(np.abs(ltpb(1666.666) - np.array(want_ltpb)).max()))
    worst = max(worst, float(np.abs(ltpecl(-1500.0) - np.array(
        [0.4768625676477096525e-3, -0.4052259533091875112, 0.9142164401096448012])).max()))
    worst = max(worst, float(np.abs(ltpequ(-2500.0) - np.array(
        [-0.3586652560237326659, -0.1996978910771128475, 0.9118552442250819624])).max()))
    return worst


# ---------------------------------------------------------------------------
# Greenwich mean sidereal time consistent with the long-term precession
# ---------------------------------------------------------------------------
#
# GMST = ERA + g(t), where g = -EO_mean is minus the equation of the origins of the
# mean pole: EO = s - atan2(q, p) (ERFA eraEors) with the precession-bias matrix of
# ltpb() and the CIO locator s. s is the kinematic integral along the mean pole,
# ds/dt = -(X dY/dt - Y dX/dt) / (1 + Z), from s(J2000) = 94 microarcseconds, plus the
# secular term the nutation contributes to s in IAU 2006 (3808.65 microarcseconds per
# century: the mean pole alone does not produce it, and GMST06 includes it). Near J2000
# the result reproduces the IAU 2006 GMST polynomial to 0.03 mas at 2050 and 0.3 mas at
# 1900 (the rest is VCW minus P03); at the edges of 1550-2650 the two differ by 7 and
# 3 mas.

#: Chebyshev domain of the fitted g(t), Julian centuries of TT from J2000 (2100 BC
#: to AD 3100) and its degree.
GMST_DOMAIN = (-41.0, 11.0)
GMST_DEGREE = 12
S06_NUTATION_RATE_UAS = 3808.65


def _s_and_eo(step_years=0.25, y0=-2150.0, y1=3150.0):
    ys = np.arange(y0, y1 + 1e-9, step_years)
    P = np.array([ltpb(y)[2] for y in ys])
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    Xd = np.gradient(X, step_years, edge_order=2)
    Yd = np.gradient(Y, step_years, edge_order=2)
    f = -(X * Yd - Y * Xd) / (1.0 + Z)
    s = np.concatenate([[0.0], np.cumsum((f[1:] + f[:-1]) / 2.0 * step_years)])
    i0 = int(np.argmin(np.abs(ys - 2000.0)))
    s = s - s[i0] + 94e-6 * DAS2R
    eo = np.zeros(ys.size)
    for i, (y, sv) in enumerate(zip(ys, s)):
        r = ltpb(y)
        x = r[2][0]
        ax = x / (1.0 + r[2][2])
        xs, ysv, zs = 1.0 - ax * x, -ax * r[2][1], -x
        p = r[0][0] * xs + r[0][1] * ysv + r[0][2] * zs
        q = r[1][0] * xs + r[1][1] * ysv + r[1][2] * zs
        eo[i] = sv - math.atan2(q, p)
    return ys, s, eo


def gmst_minus_era_samples():
    """(t centuries, g arcsec) on a quarter-year grid over the Chebyshev domain."""
    ys, s, eo = _s_and_eo()
    t = (ys - 2000.0) / 100.0
    g = np.unwrap(-eo) / DAS2R - S06_NUTATION_RATE_UAS * 1e-6 * t
    return t, g


def gmst_chebyshev():
    """Chebyshev coefficients of g(t) in arcseconds over GMST_DOMAIN, and the worst
    fit residual in mas."""
    from numpy.polynomial import chebyshev as C

    t, g = gmst_minus_era_samples()
    lo, hi = GMST_DOMAIN
    sel = (t >= lo) & (t <= hi)
    x = (2.0 * t[sel] - (lo + hi)) / (hi - lo)
    coef = C.chebfit(x, g[sel], GMST_DEGREE)
    resid = np.abs(g[sel] - C.chebval(x, coef)).max() * 1000.0
    return coef, resid


def gmst_minus_era_arcsec(t_centuries):
    from numpy.polynomial import chebyshev as C

    coef, _ = gmst_chebyshev()
    lo, hi = GMST_DOMAIN
    return C.chebval((2.0 * np.asarray(t_centuries) - (lo + hi)) / (hi - lo), coef)


if __name__ == "__main__":
    import sys

    print("worst difference from ERFA's published test values:", self_test())
    if "--gmst" in sys.argv:
        coef, resid = gmst_chebyshev()
        print("// GMST - ERA under VCW 2011, Chebyshev over t in [%g, %g] cy, degree %d;"
              " fit residual %.2e mas" % (GMST_DOMAIN[0], GMST_DOMAIN[1], GMST_DEGREE, resid))
        print("const LTP_GMST_CHEBYSHEV_ARCSEC: [f64; %d] = [" % len(coef))
        for v in coef:
            print("    %r," % float(v))
        print("];")
