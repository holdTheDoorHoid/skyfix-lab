import json, subprocess, concurrent.futures as cf
from v2 import CLI, jd_from_greg
def ti(jd):
    r = subprocess.run([CLI, "time-info", "--jd", repr(jd), "--json"], capture_output=True, text=True)
    d = json.loads(r.stdout); return jd, d["delta_t_s"], d["delta_t_sigma_s"], d["delta_t_source"], d["scale"], d["tier"], d.get("dut1_s"), d.get("tt_minus_clock_s")
jds = [jd_from_greg(y, 1, 1) for y in range(-2000, 3001, 5)]
# fine sampling around joins and boundaries
for (y, m, d) in [(-1520,1,1),(-720,1,1),(1972,1,1),(1973,1,2),(2026,9,24),(2027,9,28),(2035,12,31),(2036,1,1),(2800,1,1),(1550,1,1),(2650,1,22)]:
    base = jd_from_greg(y, m, d)
    jds += [base + k for k in (-3, -1, -0.5, -1/1440, 0, 1/1440, 0.5, 1, 3)]
jds = sorted(set(jds))
with cf.ThreadPoolExecutor(4) as ex:
    rows = list(ex.map(ti, jds))
json.dump(rows, open("dt_scan.json", "w"))
# jumps: compare consecutive samples' dT slope vs neighbours; report sigma ratio jumps
prev = None
for r in rows:
    if prev:
        dj = r[0] - prev[0]
        ddt = r[1] - prev[1]
        rate = ddt / dj  # s per day
        if prev[3] != r[3] or prev[4] != r[4] or (prev[2] > 0 and (r[2] / prev[2] > 1.5 or r[2] / prev[2] < 0.67)):
            print(f"{prev[0]:.4f}->{r[0]:.4f} ({dj:.5f} d): dT {prev[1]:.4f}->{r[1]:.4f} (d={ddt:+.4f}), sigma {prev[2]:.4f}->{r[2]:.4f}, src {prev[3]}->{r[3]}, scale {prev[4]}->{r[4]}, tt-clock {prev[7]}->{r[7]}")
    prev = r
