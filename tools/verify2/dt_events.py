"""Which clock times does the uncertainty of Delta T move? (verify2)

At a far date the explorer's clock is UT (UT1, the Earth's rotation) and Delta T = TT - UT1
is uncertain by sigma. Skyfield with DE441 and a fixed Delta T, then Delta T + sigma: the UT1
of sunrise, sunset, the Moon's rise and transit (set by the Earth's turning, the bodies'
places moving only by what they move in sigma seconds) against the UT1 of a first-quarter
Moon and a solstice (instants of TT, whose UT1 moves by the whole sigma).

    python dt_events.py [year month day lat lon delta_t sigma]
"""
import sys
from skyfield import almanac
from skyfield.api import load, wgs84
from v2 import kernel

args = sys.argv[1:]
Y, M, D = (int(a) for a in args[:3]) if args else (-584, 5, 28)
LAT, LON = (float(a) for a in args[3:5]) if args else (39.9526, -75.1652)
DT, SIG = (float(a) for a in args[5:7]) if args else (18213.0, 150.0)
eph = kernel("de441_part-1.bsp")
earth, sun, moon = eph["earth"], eph["sun"], eph["moon"]
site = wgs84.latlon(LAT, LON)

def ut1_of(t, dt):
    return t.tt - dt / 86400.0

def run(dt):
    ts = load.timescale(delta_t=dt)
    t0 = ts.tt_jd(ts.tt(Y, M, D).tt + dt / 86400.0 - 0.3)   # local morning onwards, UT1 about Y-M-D 00h
    t1 = ts.tt_jd(t0.tt + 1.2)
    out = {}
    for name, body in (("Sun", sun), ("Moon", moon)):
        r, _ = almanac.find_risings(earth + site, body, t0, t1)
        s, _ = almanac.find_settings(earth + site, body, t0, t1)
        out[f"{name} rise"] = ut1_of(r[0], dt)
        out[f"{name} set"] = ut1_of(s[0], dt)
    tr = almanac.find_transits(earth + site, moon, t0, t1)
    out["Moon transit"] = ut1_of(tr[0], dt)
    tp, yp = almanac.find_discrete(ts.tt_jd(t0.tt - 10), ts.tt_jd(t0.tt + 20), almanac.moon_phases(eph))
    fq = [t for t, y in zip(tp, yp) if y == 1][0]
    out["first quarter"] = ut1_of(fq, dt)
    ts_, ys = almanac.find_discrete(ts.tt_jd(t0.tt - 20), ts.tt_jd(t0.tt + 60), almanac.seasons(eph))
    out["June solstice"] = ut1_of([t for t, y in zip(ts_, ys) if y == 1][0], dt)
    return out

a, b = run(DT), run(DT + SIG)
print(f"{Y}-{M:02d}-{D:02d} at {LAT}, {LON}: Delta T {DT:.0f} s against {DT + SIG:.0f} s (sigma {SIG:.0f} s)")
for k in a:
    print(f"  {k:14s} UT1 moves {(b[k] - a[k]) * 86400:+8.2f} s")
