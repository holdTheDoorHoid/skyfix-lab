import math, numpy as np
from v2 import cli, ts, kernel, jd_to_iso
from skyfield.api import wgs84
eph = kernel("de440s.bsp"); earth, sun, merc = eph["earth"], eph["sun"], eph["mercury"]
AU, RM = 149597870.7, 2440.53
site = (48.85, 2.35)
obs = earth + wgs84.latlon(*site)
def f(jd_utc, which):
    t = ts().utc(2032, 11, 13, 0, 0, (jd_utc - 2463549.5) * 86400)
    o = obs.at(t); s = o.observe(sun).apparent(); m = o.observe(merc).apparent()
    sep = s.separation_from(m).arcseconds()
    sds = 959.63 / s.distance().au; sdm = math.degrees(math.asin(RM / (m.distance().au * AU))) * 3600
    return sep - (sds + sdm if which in ("c1", "c4") else sds - sdm), t, s
def root(a, b, which):
    fa = f(a, which)[0]
    for _ in range(50):
        c = 0.5 * (a + b); fc = f(c, which)[0]
        if (fc > 0) == (fa > 0): a, fa = c, fc
        else: b = c
    return 0.5 * (a + b)
d = cli("transits", "--from", "2032-11-12", "--to", "2032-11-14", "--lat", str(site[0]), "--lon", str(site[1]), "--json")
ev = {e["kind"]: e for e in d["transits"][0]["local"]["events"]}
for k in ("c1", "c2", "c3", "c4"):
    e = ev[k]; jd = e["jd_utc"]
    r = root(jd - 0.002, jd + 0.002, k)
    if k in ("c1", "c2"):
        # entering: separation decreasing through the threshold
        pass
    _, t, s = f(r, k)
    alt, az, _ = obs.at(t).observe(sun).apparent().altaz()   # airless apparent
    print(f"{k}: engine {e['utc'][11:23]}  Skyfield {jd_to_iso(r)[11:23]}  dt {(e['jd_utc'] - r) * 86400:+.2f} s; Sun alt engine {e['sun_alt_deg']:.3f} Skyfield {alt.degrees:.3f}; visible {e['visible']}")
sr = ev["sunrise"]
print("sunrise engine", sr["utc"][11:23], "Sun alt", round(sr["sun_alt_deg"], 4))
from skyfield import almanac
t0, t1 = ts().utc(2032, 11, 13, 5), ts().utc(2032, 11, 13, 9)
tt, yy = almanac.find_discrete(t0, t1, almanac.sunrise_sunset(eph, wgs84.latlon(*site)))
print("Skyfield sunrise", [x.utc_iso() for x, y in zip(tt, yy) if y])
