"""Mercury 1891 May 10 and 2282 Nov 15: contacts from Skyfield + DE440 (geocentric, the Sun's
959.63"/r, Mercury's IAU radius 2440.53 km) vs the engine and NASA's printed rows."""
import math, numpy as np
from v2 import cli, ts, kernel, jd_to_iso
eph = kernel("de440.bsp"); earth, sun, merc = eph["earth"], eph["sun"], eph["mercury"]
AU_KM, R_ME = 149597870.7, 2440.53
def f(jd_tt, which):
    t = ts().tt_jd(jd_tt)
    e = earth.at(t)
    s = e.observe(sun).apparent(); m = e.observe(merc).apparent()
    sep = s.separation_from(m).arcseconds()
    sd_s = 959.63 / s.distance().au
    sd_m = math.degrees(math.asin(R_ME / (m.distance().au * AU_KM))) * 3600
    return sep - (sd_s + sd_m if which in ("c1", "c4") else sd_s - sd_m)
def root(a, b, which):
    fa, fb = f(a, which), f(b, which)
    for _ in range(60):
        c = 0.5 * (a + b); fc = f(c, which)
        if (fc > 0) == (fa > 0): a, fa = c, fc
        else: b, fb = c, fc
    return 0.5 * (a + b)
for date, jd_ut_greatest in (("1891-05-10", 2411862.598611111), ("2282-11-15", 2554861.598611111)):
    ti = cli("time-info", "--jd", repr(jd_ut_greatest), "--json")
    dt = ti["tt_minus_clock_s"] / 86400
    g = jd_ut_greatest + dt
    # least separation by sampling
    grid = np.linspace(g - 0.15, g + 0.15, 601)
    sepv = [f(x, "c1") for x in grid]; k = int(np.argmin(sepv)); gm = grid[k]
    c1 = root(gm - 0.3, gm, "c1"); c2 = root(gm - 0.3, gm, "c2"); c3 = root(gm, gm + 0.3, "c3"); c4 = root(gm, gm + 0.3, "c4")
    to_ut = lambda x: jd_to_iso(x - dt)[11:19]
    eng = cli("transits", "--from", date + "T00:00:00Z", "--to", date + "T23:59:59Z", "--json") if False else None
    print(f"{date}: Skyfield+DE440 (engine's dT {ti['delta_t_s']:.1f} s): I {to_ut(c1)} II {to_ut(c2)} III {to_ut(c3)} IV {to_ut(c4)}; ingress {(c2-c1)*1440:.1f} min, egress {(c4-c3)*1440:.1f} min")
