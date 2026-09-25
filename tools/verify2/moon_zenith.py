import math, json
from v2 import cli, ts, kernel, jd_to_iso
from skyfield.api import wgs84
eph = kernel("de440s.bsp"); earth, moon = eph["earth"], eph["moon"]
ap = cli("moon-apsides", "--from", "2026-01-01", "--to", "2026-12-31", "--json")
per = [a for a in ap.get("apsides", ap.get("events", [])) if a.get("kind") == "perigee"]
print("perigees:", len(per), "keys", list(per[0].keys())[:8])
worst = 0
for p in per[:6]:
    jd = p["jd_utc"]
    s = cli("sky", "--lat", "0", "--lon", "0", "--utc=" + jd_to_iso(jd), "--bodies", "Moon", "--json")["bodies"][0]
    for dlat, dlon in [(0.0, 0.0), (5.0, 0.0), (-3.0, 4.0), (1.0, -8.0)]:
        lat = max(-89.9, min(89.9, s["dec_deg"] + dlat)); lon = ((-s["gha_deg"] + dlon + 180) % 360) - 180
        e = cli("sky", "--lat", repr(lat), "--lon", repr(lon), "--utc=" + jd_to_iso(jd), "--bodies", "Moon", "--json")
        b = e["bodies"][0]
        ti = cli("time-info", "--jd", repr(jd), "--json")
        t = ts().utc(*[int(x) for x in jd_to_iso(jd)[:10].split("-")], 0, 0, 0)
        t = ts().tt_jd(jd + ti["tt_minus_clock_s"] / 86400)  # TT
        # UT1 for the Earth's rotation: the engine's clock + its DUT1
        tt = ts().tt_jd(jd + ti["tt_minus_clock_s"] / 86400)
        topo = (earth + wgs84.latlon(lat, lon)).at(tt).observe(moon).apparent()
        alt, az, dist = topo.altaz()
        dalt = (b["alt_deg"] - alt.degrees) * 3600
        daz = ((b["az_deg"] - az.degrees + 180) % 360 - 180) * math.cos(math.radians(alt.degrees)) * 3600
        worst = max(worst, abs(dalt), abs(daz))
        print(f"{p['utc']} lat {lat:7.3f} lon {lon:8.3f}: alt {b['alt_deg']:8.4f} vs {alt.degrees:8.4f} (d {dalt:+.2f}\"), az d {daz:+.2f}\" (on sky), HP {b['horizontal_parallax_arcmin']:.3f}'")
print("worst", worst)
