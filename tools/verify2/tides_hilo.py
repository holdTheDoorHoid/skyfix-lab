"""A year of NOAA's high and low waters (the CO-OPS API, interval=hilo, 2026-09-25) against the
engine's tide-extremes, at diurnal and mixed stations: every NOAA extreme matched to the
engine's nearest of the same kind, the unmatched on both sides listed (verify2).

    VERIFY2_REF=<downloads> python tides_hilo.py 8729840 8771450
"""
import json, os, sys, glob
from datetime import datetime, timezone
from v2 import cli, WT, REF

PACK = sorted(glob.glob(WT + "/web/public/data/packs/tides-us-*.bin"))[-1]

def jd_of(s):
    t = datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    return t.timestamp() / 86400 + 2440587.5

for sid in sys.argv[1:] or ["8729840"]:
    noaa = json.load(open(os.path.join(REF, f"noaa_hilo_{sid}_2026.json")))["predictions"]
    N = [(jd_of(p["t"]), float(p["v"]), p["type"]) for p in noaa]
    E = []
    for m in range(1, 13):
        a = f"2026-{m:02d}-01T00:00:00Z"
        b = f"2026-{m+1:02d}-01T00:00:00Z" if m < 12 else "2027-01-01T00:00:00Z"
        r = cli("tide-extremes", sid, "--from", a, "--to", b, "--datum", "MLLW", "--json", packs=[PACK])
        for e in r["extremes"]:
            E.append((e["jd_utc"], e["height_m"], "H" if e["kind"] in ("high", "H") else "L"))
    E = sorted(set(E))
    used = set()
    worst_t = worst_h = 0.0
    unmatched_n = []
    for jn, hn, kn in N:
        best = None
        for i, (je, he, ke) in enumerate(E):
            if ke != kn or i in used:
                continue
            dt = abs(je - jn) * 1440
            if dt < 60 and (best is None or dt < best[0]):
                best = (dt, i, he)
        if best is None:
            unmatched_n.append((jn, hn, kn))
            continue
        used.add(best[1])
        # NOAA prints whole minutes: up to 0.5 min of the difference is its rounding
        worst_t = max(worst_t, best[0])
        worst_h = max(worst_h, abs(best[2] - hn) * 100)
    unmatched_e = [E[i] for i in range(len(E)) if i not in used]
    print(f"{sid}: NOAA {len(N)} extremes, engine {len(E)}; matched {len(N) - len(unmatched_n)}; worst {worst_t:.2f} min, {worst_h:.2f} cm")
    for jn, hn, kn in unmatched_n[:12]:
        print(f"   NOAA only: {kn} {hn:+.3f} m at JD {jn:.4f}")
    for je, he, ke in unmatched_e[:12]:
        print(f"   engine only: {ke} {he:+.3f} m at JD {je:.4f}")
