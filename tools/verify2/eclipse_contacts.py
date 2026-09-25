"""Independent limb-corrected second and third contacts (verify2).

Skyfield 1.55 + JPL DE440s: astrometric (light-time corrected) Sun and Moon from a WGS84
site; the Moon's orientation from NAIF's DE440 lunar kernels (MOON_ME_DE440_ME421, the
frame of LOLA's grids, at the light's departure); the limb from the lunar-limb pack's
ring, decoded in ring.py (not by the engine). Aberration is left out: it moves the Sun and
the Moon alike, to 1e-4 of their 0.5 deg separation.

Silhouette: every ring node projected gnomonically on the sky plane about the Moon's
centre; the largest angular radius in each position-angle bin (NBINS, default 5760 =
1/16 deg). Totality margin = min over PA of (the Moon's radius there - the distance of the
Sun's farthest point there); annularity margin = min of (the Sun's farthest point - the
Moon's radius). Contacts are the zeros of the margin, bisected to 1 ms. The Sun's radius
is 959.63"/r (NASA's value, also the engine's).

    python eclipse_contacts.py [delta_t_offset_s ...]
"""
import json, math, os, sys
import numpy as np
from skyfield.api import load, wgs84
from skyfield.planetarylib import PlanetaryConstants
import ring as ringmod

_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DATA = os.path.join(_ROOT, "tools/reference/data")
FIX = os.path.join(_ROOT, "fixtures/reference/eclipse_limb_svs.json")
AU_KM = 149597870.7
C_KM_S = 299792.458
NBINS = int(os.environ.get("NBINS", "5760"))
ts = load.timescale(builtin=True)
eph = load(os.path.join(DATA, "de440s.bsp"))
earth, sun, moon = eph["earth"], eph["sun"], eph["moon"]

pc = PlanetaryConstants()
pc.read_text(load.open(os.path.join(DATA, "moon_de440_250416.tf")))
pc.read_binary(load.open(os.path.join(DATA, "moon_pa_de440_200625.bpc")))
_code = pc._get_assignment("FRAME_MOON_ME_DE440_ME421")
FRAMES = [(s.initial_jd, s.final_jd, pc.build_frame(_code, _segment=s)) for s in pc._segment_list]

def lunar_rotation(t):
    jd = float(t.tdb)
    for a, b, f in FRAMES:
        if a <= jd <= b:
            return np.asarray(f.rotation_at(t))
    raise ValueError(jd)

RING = ringmod.load()
A, Dl = np.meshgrid(np.radians(RING["alpha"]), np.radians(RING["delta"]), indexing="ij")
UNIT = np.stack([np.sin(Dl), -np.sin(A) * np.cos(Dl), np.cos(A) * np.cos(Dl)], axis=-1).reshape(-1, 3)
PTS = UNIT * (RING["r_km"] + RING["h_km"].reshape(-1, 1))   # km, ME frame, from the Moon's centre of mass

def geometry(obs, t):
    """(silhouette radius per PA bin [rad], Sun offset c [rad, east/north], Sun radius [rad])."""
    o = obs.at(t)
    m = o.observe(moon)                     # astrometric: light-time, no aberration
    s = o.observe(sun)
    mv, sv = m.position.km, s.position.km
    D = np.linalg.norm(mv); mh = mv / D; sh = sv / np.linalg.norm(sv)
    ez = np.array([0.0, 0.0, 1.0])
    ee = np.cross(ez, mh); ee /= np.linalg.norm(ee); en = np.cross(mh, ee)
    # Sun's centre on the tangent plane at the Moon's centre (gnomonic), east and north
    w = sh @ mh
    c = np.array([sh @ ee, sh @ en]) / w
    rs = math.radians(959.63 / 3600.0) / (np.linalg.norm(sv) / AU_KM)
    # the Moon at the light's departure
    tm = ts.tt_jd(t.tt - D / C_KM_S / 86400.0)
    R = lunar_rotation(tm)                  # ICRF -> ME
    u = R @ (-mh); e_me = R @ ee; n_me = R @ en
    par = PTS @ u
    den = D - par
    x = (PTS @ e_me) / den; y = (PTS @ n_me) / den
    rho = np.hypot(x, y)
    th = np.arctan2(x, y) % (2 * np.pi)      # PA from north through east
    k = np.minimum((th / (2 * np.pi) * NBINS).astype(np.int64), NBINS - 1)
    r = np.zeros(NBINS)
    np.maximum.at(r, k, rho)
    return r, c, rs

THETA = (np.arange(NBINS) + 0.5) / NBINS * 2 * np.pi
E_TH = np.stack([np.sin(THETA), np.cos(THETA)], axis=-1)

def margin(obs, t, kind):
    r, c, rs = geometry(obs, t)
    ce = E_TH @ c
    cx = E_TH[:, 0] * c[1] - E_TH[:, 1] * c[0]
    far = ce + np.sqrt(np.maximum(rs * rs - cx * cx, 0.0))
    ok = r > 0
    d = (r - far) if kind == "total" else (far - r)
    return float(np.min(d[ok])) * 206264.806   # arcsec

def contact(obs, t0_utc_jd, kind, rising):
    """The zero of the margin near t0 (UTC JD): rising=True for c2 (the margin turns +)."""
    f = lambda jd: margin(obs, ts.utc(*jd_to_utc_tuple(jd)), kind)
    good = (lambda v: v >= 0) if rising else (lambda v: v < 0)
    for half in (6.0, 20.0, 60.0):
        a, b = t0_utc_jd - half / 86400.0, t0_utc_jd + half / 86400.0
        fa, fb = f(a), f(b)
        if not good(fa) and good(fb):
            break
    else:
        return None
    lo, hi = a, b
    for _ in range(26):
        mid = 0.5 * (lo + hi)
        if good(f(mid)):
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)

def jd_to_utc_tuple(jd):
    z = jd + 0.5; Z = math.floor(z); F = z - Z
    a = Z + 32044; b = (4 * a + 3) // 146097; c = a - 146097 * b // 4
    d = (4 * c + 3) // 1461; e = c - 1461 * d // 4; m = (5 * e + 2) // 153
    day = e - (153 * m + 2) // 5 + 1; month = m + 3 - 12 * (m // 10); year = 100 * b + d - 4800 + m // 10
    sec = F * 86400.0
    return (year, month, day, 0, 0, sec)

def hms(jd):
    s = ((jd + 0.5) % 1.0) * 86400.0
    return f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{s % 60:06.3f}"

def svs_jd(ymd, hhmmss):
    y, mo, d = map(int, ymd.split("-")); h, mi, s = map(int, hhmmss.split(":"))
    a = (14 - mo) // 12; yy = y + 4800 - a; mm = mo + 12 * a - 3
    jdn = d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045
    return jdn - 0.5 + (h * 3600 + mi * 60 + s) / 86400.0

OMEGA_DEG_PER_S = 15.041067 / 3600.0   # the Earth's rotation

def one(args):
    eclipse_id, cty, offsets = args
    kind = "total" if eclipse_id.startswith("2024") else "annular"
    ymd = eclipse_id[:10]
    ev = cty["svs"]["ECLIPSE"]
    c2s, c3s = svs_jd(ymd, ev[2]), svs_jd(ymd, ev[3])
    row = {"eclipse": eclipse_id, "name": cty["name"], "svs_c2": c2s, "svs_c3": c3s}
    for off in offsets:
        # Delta T larger by `off` seconds = the Earth turned `off` seconds less at a given
        # TT = the site that much further west under the same shadow.
        lon = cty["lon_deg"] - OMEGA_DEG_PER_S * off
        obs = earth + wgs84.latlon(cty["lat_deg"], lon, elevation_m=cty["height_m"])
        row[f"c2_{off}"] = contact(obs, c2s, kind, True)
        row[f"c3_{off}"] = contact(obs, c3s, kind, False)
    return row

if __name__ == "__main__":
    import multiprocessing as mp
    offsets = [float(x) for x in sys.argv[1:]] or [0.0]
    fx = json.load(open(FIX))
    jobs = [(e["id"], c, offsets) for e in fx["eclipses"] for c in e["cities"] if len(c["svs"]["ECLIPSE"]) >= 6]
    with mp.get_context("spawn").Pool(4) as pool:
        out = pool.map(one, jobs)
    json.dump(out, open(f"eclipse_contacts_{NBINS}.json", "w"), indent=0)
    for row in out:
        print(row["eclipse"], row["name"], " ".join(
            f"[{off:+.1f}] c2 {((row[f'c2_{off}'] or float('nan')) - row['svs_c2']) * 86400:+.2f} c3 {((row[f'c3_{off}'] or float('nan')) - row['svs_c3']) * 86400:+.2f}"
            for off in offsets))
