"""Rigil Kentaurus (alpha Cen A): the engine's orbit model and the catalogue's straight line
(the Nautical Almanac's / USNO's) against ALMA's measured ICRS positions of A (Akeson et al.
2021, AJ 162, 14, Table 2; 0.4-7 mas), and against Akeson et al.'s own barycentre + orbit."""
import math, os, subprocess
import numpy as np
from v2 import ts, kernel
from v2 import WT
EX = os.path.join(WT, "target/release/examples/v2_acen")  # a scratch example printing the engine's directions (see VERIFICATION_2.md); the committed check is crates/skyfix-ephemeris/tests/acen_alma.rs
ALMA = [  # UTC start, RA, Dec of A (deg), sigma RA cos dec, sigma Dec (arcsec)
    ((2018,10,14,13,38,19.0), 219.860763250, -60.832171539, 0.0039, 0.0035),
    ((2019,7,15,23,14,41.3), 219.858859933, -60.832264944, 0.0007, 0.0010),
    ((2019,7,16,1,15,31.1), 219.858854542, -60.832262378, 0.0019, 0.0014),
    ((2019,7,19,23,31,14.5), 219.858829571, -60.832252293, 0.0004, 0.0007),
    ((2019,7,20,1,2,29.9), 219.858827083, -60.832253354, 0.0005, 0.0005),
    ((2019,8,12,23,10,35.2), 219.858667583, -60.832185858, 0.0068, 0.0057),
    ((2019,8,13,0,44,57.6), 219.858669208, -60.832186997, 0.0049, 0.0037),
    ((2019,8,25,23,33,45.5), 219.858615833, -60.832153722, 0.0035, 0.0020),
    ((2019,8,26,20,7,30.6), 219.858613375, -60.832152358, 0.0016, 0.0016),
]
PLX_ENGINE = 742.12e-3  # arcsec, the engine's catalogue value
AU_PER_PC = 206264.806247

def engine_dirs(jd_tts):
    out = subprocess.run([EX] + [repr(j) for j in jd_tts], capture_output=True, text=True).stdout.split("\n")
    rows = [l.split() for l in out if l and not l.startswith("#")]
    return {float(r[0]): (np.array(list(map(float, r[1:4]))), np.array(list(map(float, r[4:7])))) for r in rows}

def geo(u, jd_tt, plx):
    e = kernel("de440s.bsp")["earth"].at(ts().tt_jd(jd_tt)).position.au  # barycentric
    d = AU_PER_PC / plx
    v = u * d - e
    return v / np.linalg.norm(v)

def radec(v):
    return math.degrees(math.atan2(v[1], v[0])) % 360, math.degrees(math.asin(v[2]))

def offs(ra, dec, ra0, dec0):
    return ((ra - ra0) * math.cos(math.radians(dec0)) * 3600, (dec - dec0) * 3600)

# Akeson et al. 2021's own model: barycentre at J2019.5 + PM (no perspective; 7 yr at most
# from 2019.5 here, perspective ~ 0.13 mas/yr^2 -> <10 mas) + A about it.
EL = dict(P=79.762, a=17.4930, i=79.2430, Om=205.073, T=1955.564, e=0.51947, om=231.519)
FB = 1 - 0.54266
def rel(year, el=EL):
    P, a, e = el["P"], el["a"], el["e"]
    M = 2 * math.pi * (year - el["T"]) / P; E = M
    for _ in range(60): E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
    X, Y = math.cos(E) - e, math.sqrt(1 - e * e) * math.sin(E)
    i, Om, om = (math.radians(el[k]) for k in ("i", "Om", "om"))
    A = a*(math.cos(om)*math.cos(Om)-math.sin(om)*math.sin(Om)*math.cos(i)); B = a*(math.cos(om)*math.sin(Om)+math.sin(om)*math.cos(Om)*math.cos(i))
    F = a*(-math.sin(om)*math.cos(Om)-math.cos(om)*math.sin(Om)*math.cos(i)); G = a*(-math.sin(om)*math.sin(Om)+math.cos(om)*math.cos(Om)*math.cos(i))
    return np.array([A*X+F*Y, B*X+G*Y])
def akeson_A_bary(year):
    ra0, dec0 = 219.85892215, -60.83163195
    dt = year - 2019.5
    n, e_ = -FB * rel(year)
    dec = dec0 + (700.40e-3 * dt + n) / 3600
    ra = ra0 + (-3639.95e-3 * dt + e_) / 3600 / math.cos(math.radians(dec0))
    r, d = math.radians(ra), math.radians(dec)
    return np.array([math.cos(d)*math.cos(r), math.cos(d)*math.sin(r), math.sin(d)])

jds = []
for (y, mo, d, h, mi, s), *_ in ALMA:
    t = ts().utc(y, mo, d, h, mi, s); jds.append(float(t.tt))
E = engine_dirs(jds)
print(f"{'epoch (UTC)':22s} | engine orbit - ALMA (E, N) | straight line - ALMA | Akeson model - ALMA")
for ((y, mo, d, h, mi, s), ra, dec, sra, sdec), jd in zip(ALMA, jds):
    o, l = E[jd]
    ro = radec(geo(o, jd, PLX_ENGINE)); rl = radec(geo(l, jd, PLX_ENGINE))
    ra_k = radec(geo(akeson_A_bary(2000 + (jd - 2451545) / 365.25), jd, 750.81e-3))
    fo, fl, fk = offs(*ro, ra, dec), offs(*rl, ra, dec), offs(*ra_k, ra, dec)
    print(f"{y}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}        | {fo[0]:+7.3f} {fo[1]:+7.3f} ({math.hypot(*fo):6.3f}) | {fl[0]:+7.3f} {fl[1]:+7.3f} ({math.hypot(*fl):6.3f}) | {fk[0]:+7.3f} {fk[1]:+7.3f}")

# Forward: 2026 and 2060, engine orbit vs straight line vs Akeson's model (barycentric directions)
print()
for yr in (2000.0, 2019.5, 2026.0, 2035.0, 2045.0, 2060.0):
    jd = 2451545.0 + (yr - 2000) * 365.25
    E2 = engine_dirs([jd]); o, l = E2[jd]
    k = akeson_A_bary(yr)
    so = math.degrees(math.acos(min(1, o @ k))) * 3600
    sl = math.degrees(math.acos(min(1, l @ k))) * 3600
    ol = math.degrees(math.acos(min(1, o @ l))) * 3600
    print(f"J{yr}: engine orbit vs Akeson {so:6.2f}\"   straight line vs Akeson {sl:6.2f}\"   orbit vs line {ol:6.2f}\"")
