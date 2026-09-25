"""Anchorage (9455920), a year of NOAA's hourly predictions (API, 2026-09-25) vs the engine,
and the residual decomposed onto the 120 constituents' speeds."""
import json, math, sys
import numpy as np
from v2 import cli, WT
import glob, os
from v2 import REF
PACK = sorted(glob.glob(WT + "/web/public/data/packs/tides-us-*.bin"))[-1]
FIX = json.load(open(WT + "/fixtures/reference/tides_noaa.json"))
sid = "9455920"
year = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
cons = [s for s in FIX["harmonic"] if s["id"] == sid][0]["constants"]["constituents"]
# NOAA CO-OPS predictions API, hourly, MLLW, GMT, metric (network; saved under REF):
# https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&begin_date=YYYY0101&end_date=YYYY1231&datum=MLLW&station=9455920&time_zone=gmt&units=metric&interval=h&format=json
noaa = json.load(open(os.path.join(REF, f"noaa_{sid}_{year}.json")))["predictions"]
N = np.array([float(p["v"]) for p in noaa]) * 1000
eng_h = []
for m in range(1, 13):
    a = f"{year}-{m:02d}-01T00:00:00Z"
    b = f"{year}-{m+1:02d}-01T00:00:00Z" if m < 12 else f"{year+1}-01-01T00:00:00Z"
    c = cli("tide-predict", sid, "--from", a, "--to", b, "--step", "60", "--datum", "MLLW", "--json", packs=[PACK])
    h = c["height_m"][:-1]  # drop the end point (next month's first hour)
    eng_h += h
E = np.array(eng_h) * 1000
assert len(E) == len(N), (len(E), len(N))
r = E - N
print(f"{year}: residual engine - NOAA over {len(r)} h: rms {r.std():.2f} mm, mean {r.mean():+.2f}, max {abs(r).max():.1f} mm")
t_h = np.arange(len(r), dtype=float)
cols, names = [np.ones_like(t_h)], ["Z0"]
for name, amp, ph, spd in cons:
    w = math.radians(spd)
    cols += [np.cos(w * t_h), np.sin(w * t_h)]; names.append(name)
A = np.array(cols).T
x, *_ = np.linalg.lstsq(A, r, rcond=None)
fit = A @ x
print(f"  constituent speeds explain rms {fit.std():.2f} mm; leftover {np.std(r - fit):.2f} mm (NOAA's 1 mm rounding alone: 0.29)")
amps = sorted(((math.hypot(x[1+2*i], x[2+2*i]), math.degrees(math.atan2(x[2+2*i], x[1+2*i])), c[0], c[3], c[1]) for i, c in enumerate(cons)), reverse=True)
for a, ang, name, spd, amp in amps[:12]:
    print(f"  {name:8s} {spd:11.6f} deg/h  residual {a:6.2f} mm (phase {ang:+7.1f})  constituent {amp*1000:5.0f} mm -> {a/(amp*1000)*100 if amp else 0:5.1f} %")
# the residual's amplitude (mm) and phase (deg, r = A cos(w t - phase), t in hours from
# 1 January 00:00 GMT) at every constituent's speed, for sigma1.py and m2_round.py
json.dump({name: [a, ang] for a, ang, name, spd, amp in amps}, open(f"tides_resid_{year}.json", "w"))
