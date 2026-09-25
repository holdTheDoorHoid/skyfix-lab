import math, numpy as np
from v2 import cli, ts, kernel, jd_to_iso
from skyfield.api import wgs84
eph = kernel("de440s.bsp"); earth, sun = eph["earth"], eph["sun"]
cases = [(-89.9, 0.0, "2026-03-18"), (-89.9, 0.0, "2026-09-24"), (78.22, 15.65, "2026-04-15"), (78.22, 15.65, "2026-04-19"),
         (69.65, 18.96, "2026-11-25"), (0.0, 179.99, "2026-06-21"), (0.0, -179.99, "2026-06-21"), (-45.0, 179.9, "2026-12-21"), (89.9, -120.0, "2026-03-20")]
for lat, lon, date in cases:
    d = cli("sun-hours", "--lat", repr(lat), "--lon", repr(lon), "--date", date, "--json")
    site = earth + wgs84.latlon(lat, lon)
    ja, jb = d["jd_start"], d["jd_end"]
    # Skyfield: geometric (astrometric? the engine's alt is topocentric geometric: apparent place, no refraction)
    n = int((jb - ja) * 1440 / 1) + 1
    jds = np.linspace(ja, jb, n)
    ti = cli("time-info", "--jd", repr(0.5 * (ja + jb)), "--json")
    t = ts().tt_jd(jds + ti["tt_minus_clock_s"] / 86400)
    alt = site.at(t).observe(sun).apparent().altaz()[0].degrees
    worst, counts = 0.0, []
    for bd in d["boundaries"]:
        h = bd["altitude_deg"]
        sky_n = int(np.sum(np.diff(np.sign(alt - h)) != 0))
        eng_n = len(bd["crossings"])
        counts.append((h, eng_n, sky_n, bd["always_above"], bd["always_below"]))
        for c in bd["crossings"]:
            tc = ts().tt_jd(c["jd_utc"] + ti["tt_minus_clock_s"] / 86400)
            a = site.at(tc).observe(sun).apparent().altaz()[0].degrees
            worst = max(worst, abs(a - h))
    print(f"{lat:7.2f} {lon:8.2f} {date}: windows {[(w['kind'], w['period']) for w in d['windows']]}")
    print(f"     crossings (threshold, engine, skyfield-by-minute, always_above, always_below): {counts}; worst altitude at a crossing {worst*3600:.2f}\"")
