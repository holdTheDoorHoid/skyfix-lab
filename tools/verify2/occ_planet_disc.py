"""How long a planet takes to disappear behind the Moon (verify2): for each planet event of
fixtures/reference/moon_occultations.json, the instants its near edge touches the Moon's mean
limb, its centre crosses it (the fixture's and the engine's contact) and its far edge is hidden
(Skyfield, DE440s, the fixture's site and conventions; the globe's equatorial radius, Saturn's
rings left out).

    python occ_planet_disc.py
"""
import json, math
import numpy as np
from skyfield.api import load, wgs84
from v2 import WT, kernel

FIX = json.load(open(WT + "/fixtures/reference/moon_occultations.json"))
SITES = {"philadelphia": (39.9526, -75.1652, 10.0), "los_angeles": (34.0522, -118.2437, 90.0),
         "london": (51.5074, -0.1278, 20.0), "sydney": (-33.8688, 151.2093, 40.0),
         "tokyo": (35.6762, 139.6503, 40.0), "johannesburg": (-26.2041, 28.0473, 1750.0),
         "buenos_aires": (-34.6037, -58.3816, 25.0), "mumbai": (19.0760, 72.8777, 10.0),
         "honolulu": (21.3069, -157.8583, 5.0), "reykjavik": (64.1466, -21.9426, 30.0),
         "cairo": (30.0444, 31.2357, 23.0), "santiago": (-33.4489, -70.6693, 570.0)}
KEY = {"Venus": "venus", "Mars": "mars barycenter", "Jupiter": "jupiter barycenter", "Saturn": "saturn barycenter"}
R_EQ = {"Venus": 6051.8, "Mars": 3396.19, "Jupiter": 71492.0, "Saturn": 60268.0}
MOON_R = 0.2725076 * 6378.14
eph = kernel("de440s.bsp")
earth, moon = eph["earth"], eph["moon"]
ts = load.timescale(delta_t=32.184 + 37.0)

def t_of(jd):
    return ts.tt_jd(jd + 69.184 / 86400.0)

def limb(site, target, rp, jd, offset):
    """limb distance of the planet's point `offset` (+1 near edge, 0 centre, -1 far edge), arcsec."""
    t = t_of(jd)
    o = site.at(t)
    m = o.observe(moon).apparent()
    b = o.observe(target).apparent()
    dm = np.linalg.norm(moon.at(t).position.km - o.position.km)
    sd_m = math.degrees(math.asin(MOON_R / dm)) * 3600
    sd_p = math.degrees(math.asin(rp / b.distance().km)) * 3600
    return m.separation_from(b).degrees * 3600 - sd_m - offset * sd_p, sd_p

def root(f, a, b):
    fa = f(a)
    for _ in range(60):
        mid = 0.5 * (a + b); fm = f(mid)
        if (fm < 0) == (fa < 0): a, fa = mid, fm
        else: b = mid
    return 0.5 * (a + b)

for ev in FIX["events"]:
    if ev.get("kind") != "planet":
        continue
    lat, lon, h = SITES[ev["site"]]
    site = earth + wgs84.latlon(lat, lon, elevation_m=h)
    target = eph[KEY[ev["body"]]]
    rp = R_EQ[ev["body"]]
    out = []
    for c in ev["contacts"]:
        jc = c["jd_utc"]
        sign = 1 if c["kind"] == "disappearance" else -1
        # near edge touches before the centre on disappearance; after it on reappearance
        spans = []
        for off in (1, -1):
            f = lambda jd, off=off: limb(site, target, rp, jd, off)[0]
            a, b = (jc - 600 / 86400, jc) if (off == 1) == (sign == 1) else (jc, jc + 600 / 86400)
            try:
                spans.append((root(f, a, b) - jc) * 86400)
            except Exception:
                spans.append(float("nan"))
        sd_p = limb(site, target, rp, jc, 0)[1]
        out.append(f"{c['kind'][:4]} {c['utc'][11:19]}: edge {spans[0]:+.1f} s, far edge {spans[1]:+.1f} s (disc {2*sd_p:.1f}\")")
    print(f"{ev['body']:8s} {ev['contacts'][0]['utc'][:10]} {ev['site']:12s} " + "; ".join(out))
