"""E5 (the engine's Galilean moons) against JPL's jup365 at the excerpted far epochs."""
import math, numpy as np, glob, os
from skyfield.api import load_file
from v2 import cli, ts, kernel, jd_to_iso, DATA
de = kernel("de440.bsp")
names = {"Io": 501, "Europa": 502, "Ganymede": 503, "Callisto": 504}
for path in sorted(glob.glob(os.path.join(DATA, "planetdetail", "jup365_*.bsp"))):
    sat = load_file(path)
    seg = sat.segments[0]
    by = {x.target: x for x in sat.segments}
    j0, j1 = seg.spk_segment.start_jd, seg.spk_segment.end_jd
    earth = de["earth"]
    jup_bary = de["jupiter barycenter"]
    worst = {}
    for k in range(12):
        jd_tt_guess = j0 + 0.2 + (j1 - j0 - 0.4) * k / 11
        ti = cli("time-info", "--jd", repr(jd_tt_guess), "--json")
        jd_clock = jd_tt_guess - ti["tt_minus_clock_s"] / 86400
        g = cli("galilean-moons", "--utc", jd_to_iso(jd_clock), "--json")
        ti = cli("time-info", "--jd", repr(g["jd_utc"]), "--json")
        t = ts().tt_jd(g["jd_utc"] + ti["tt_minus_clock_s"] / 86400)
        jc = earth.at(t).observe(jup_bary + by[599]).apparent()
        def unit_of_date(a):
            ra, dec, _ = a.radec(epoch="date")
            r, d = ra.radians, dec.radians
            return np.array([math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d)])
        u = unit_of_date(jc)
        e_ax = np.array([-u[1], u[0], 0.0]); e_ax /= np.linalg.norm(e_ax)
        n_ax = np.cross(u, e_ax)
        for m in g["moons"]:
            mc = earth.at(t).observe(jup_bary + by[names[m["name"]]]).apparent()
            v = unit_of_date(mc)
            w = v @ u
            e_ref = (v @ e_ax) / w * 206264.806
            n_ref = (v @ n_ax) / w * 206264.806
            d = math.hypot(m["offset_east_arcsec"] - e_ref, m["offset_north_arcsec"] - n_ref)
            worst[m["name"]] = max(worst.get(m["name"], 0), d)
    print(os.path.basename(path), " ".join(f"{k} {v:.3f}\"" for k, v in worst.items()))
