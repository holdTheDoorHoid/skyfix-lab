"""Sweep closest approaches (Mars oppositions, Venus inferior conjunctions, Mercury,
Jupiter, Saturn) across the labelled tier and report per-century worst vs the
historical table and the published tier figure."""
import json, math, sys, concurrent.futures as cf
import numpy as np
from labelled_cut import closest_approaches, ref_radec, unit, cli, jd_to_iso
from v2 import jd_from_greg

PUBLISHED_LABELLED_ARCMIN = {"Mercury": 0.02, "Venus": 0.06, "Mars": 0.15, "Jupiter": 0.25, "Saturn": 0.7}
def one(args):
    b, jd_tt_guess = args
    ti = cli("time-info", "--jd", repr(jd_tt_guess), "--json")
    jd_clock = jd_tt_guess - ti["delta_t_s"] / 86400.0
    s = cli("sky", "--lat", "0", "--lon", "0", "--utc=" + jd_to_iso(jd_clock), "--bodies", b, "--json")
    ti = cli("time-info", "--jd", repr(s["jd_utc"]), "--json")
    if ti["tier"] != "labelled":
        return None
    jd_tt = s["jd_utc"] + ti["tt_minus_clock_s"] / 86400.0
    st = s["bodies"][0]
    ra, dec, w = ref_radec(b, jd_tt)
    e = unit(st["ra_deg"], st["dec_deg"])
    sep = math.degrees(math.acos(max(-1, min(1, float(e @ w))))) * 3600
    dra = ((st["ra_deg"] - ra + 180) % 360 - 180) * 60
    ddec = (st["dec_deg"] - dec) * 60
    return (b, s["utc"], jd_tt, sep, dra, ddec)

bodies = sys.argv[1].split(",")
step = int(sys.argv[2])  # take every step-th closest approach
cases = []
for b in bodies:
    for (y0, y1) in [(-2000, -1000), (-1000, 0), (0, 1000), (1000, 1550), (2650, 3001)]:
        ca = closest_approaches(b, y0, y1)
        cases += [(b, j) for j in ca[::step]]
print(len(cases), "cases", file=sys.stderr)
with cf.ThreadPoolExecutor(3) as ex:
    res = [r for r in ex.map(one, cases) if r]
json.dump(res, open(f"sweep_{'_'.join(bodies)}.json", "w"))
for b in bodies:
    rs = [r for r in res if r[0] == b]
    worst = max(rs, key=lambda r: r[3])
    wg = max(rs, key=lambda r: max(abs(r[4]), abs(r[5])))
    print(f"{b}: {len(rs)} closest approaches; worst on sky {worst[3]:.2f}\" at {worst[1]}; worst of RA/Dec {max(abs(wg[4]),abs(wg[5])):.4f}' at {wg[1]} (published {PUBLISHED_LABELLED_ARCMIN.get(b)}')")
    # per-century worst
    cent = {}
    for r in rs:
        y = int(r[1][:5]) if r[1][0] == '-' else int(r[1][:4])
        c = (y // 100) * 100
        cent[c] = max(cent.get(c, 0), r[3])
    print("   per century (on sky, arcsec):", " ".join(f"{c}:{v:.2f}" for c, v in sorted(cent.items())))
