"""Reference data for the lunar limb (development-time only; never from Rust output).

    tools/reference/.venv/bin/python -m tools.limb.reference [svs] [skyfield]

Writes into `fixtures/reference/`:

* `eclipse_limb_svs2024.json` (`svs`) - NASA Scientific Visualization Studio's
  limb-corrected times of second and third contact for named cities in the path of the
  total solar eclipse of 2024 April 8 (SVS item 5073, `cities-eclipse-2024.json`: UTC,
  whole seconds, computed with LRO/SELENE lunar topography, SRTM terrain heights and JPL
  DE421), stored verbatim for the cities chosen below, each with the ground height this
  project assigns it (the file carries none).
* `eclipse_limb_skyfield.json` (`skyfield`) - an independent implementation of the
  engine's definitions (docs/CONVENTIONS.md 15.7), for the same cities: the Sun and the
  Moon from Skyfield with JPL DE440s on Skyfield's own IERS time scale, the Moon's
  orientation from NAIF's DE440 lunar PCK in the MOON_ME_DE440_ME421 frame, and the
  profile from the **raw LDEM_16 grid** (not the pack's ring): mean-limb contacts
  (NASA's k1, k2) and limb-corrected ones, and the profile at the instant of maximum.

Both need the network only for the SVS file (`svs`); `skyfield` needs
`tools/reference/data/{de440s.bsp, moon_pa_de440_200625.bpc, moon_de440_250416.tf}` and
`tools/limb/data/ldem_16.img` (`python3 -m tools.limb.fetch`).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
import os
import sys
import urllib.request

import numpy as np

from tools.reference import common as c

from . import ring

REPO = c.REPO
FIXTURES = c.FIX_REFERENCE
SVS_URL = "https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005073/cities-eclipse-2024.json"
SVS_PAGE = "https://svs.gsfc.nasa.gov/5073"

ARCSEC = math.pi / 648000.0
WGS84_A_KM = 6378.137
K1 = 0.272488
K2 = 0.272281
AU_KM = 149_597_870.700
SUN_RADIUS_KM = AU_KM * math.sin(959.63 * ARCSEC)

#: Cities in the path of totality of 2024 April 8 and of annularity of 2023 October 14,
#: as SVS names them, with a ground height (metres above sea level; the engine takes it
#: as the height above the ellipsoid, a difference of about 30 m that moves second and
#: third contact by under 0.05 s). (SVS name, state, height)
CITIES = {
    "2024-04-08-solar": [
        ("Eagle Pass", "TX", 222.0),
        ("Kerrville", "TX", 500.0),
        ("San Antonio", "TX", 198.0),
        ("Austin", "TX", 149.0),
        ("Waco", "TX", 143.0),
        ("Fort Worth", "TX", 198.0),
        ("Dallas", "TX", 131.0),
        ("Texarkana", "TX", 102.0),
        ("Hot Springs", "AR", 180.0),
        ("Little Rock", "AR", 102.0),
        ("Jonesboro", "AR", 97.0),
        ("Poplar Bluff", "MO", 105.0),
        ("Cape Girardeau", "MO", 107.0),
        ("Carbondale", "IL", 126.0),
        ("Evansville", "IN", 118.0),
        ("Bloomington", "IN", 235.0),
        ("Indianapolis city (balance)", "IN", 218.0),
        ("Muncie", "IN", 290.0),
        ("Dayton", "OH", 225.0),
        ("Lima", "OH", 265.0),
        ("Toledo", "OH", 187.0),
        ("Akron", "OH", 306.0),
        ("Cleveland", "OH", 199.0),
        ("Erie", "PA", 199.0),
        ("Buffalo", "NY", 183.0),
        ("Rochester", "NY", 154.0),
        ("Watertown", "NY", 142.0),
        ("Plattsburgh", "NY", 50.0),
        ("Burlington", "VT", 61.0),
        ("Lancaster", "NH", 263.0),
        ("Houlton", "ME", 110.0),
        ("Presque Isle", "ME", 180.0),
    ],
    "2023-10-14-solar": [
        ("Eugene", "OR", 130.0),
        ("Roseburg", "OR", 140.0),
        ("Klamath Falls", "OR", 1250.0),
        ("Winnemucca", "NV", 1310.0),
        ("Elko", "NV", 1545.0),
        ("Richfield", "UT", 1620.0),
        ("Cortez", "CO", 1880.0),
        ("Farmington", "NM", 1640.0),
        ("Albuquerque", "NM", 1520.0),
        ("Santa Fe", "NM", 2130.0),
        ("Roswell", "NM", 1100.0),
        ("Midland", "TX", 870.0),
        ("Odessa", "TX", 890.0),
        ("San Angelo", "TX", 560.0),
        ("Kerrville", "TX", 500.0),
        ("San Antonio", "TX", 198.0),
        ("Corpus Christi", "TX", 10.0),
        ("Alice", "TX", 62.0),
        ("Kingsville", "TX", 20.0),
    ],
}

SVS_FILES = {
    "2024-04-08-solar": "cities-eclipse-2024.json",
    "2023-10-14-solar": "cities-eclipse-2023.json",
}
SVS_BASE = "https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005073/"


# ---------------------------------------------------------------------------
# NASA SVS
# ---------------------------------------------------------------------------


def fetch_svs(file: str) -> bytes:
    path = os.path.join(ring.DATA, file)
    if not os.path.exists(path):
        os.makedirs(ring.DATA, exist_ok=True)
        req = urllib.request.Request(SVS_BASE + file, headers={"User-Agent": "skyfix-lab-limb/1"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    return open(path, "rb").read()


def svs_cities(eid: str) -> tuple[list[dict], dict]:
    file = SVS_FILES[eid]
    raw = fetch_svs(file)
    rows = json.loads(raw)
    by = {(r["NAME"], r["STATE"]): r for r in rows}
    out = []
    for name, state, h in CITIES[eid]:
        r = by.get((name, state))
        if r is None:
            raise SystemExit("SVS has no %s, %s" % (name, state))
        if len(r["ECLIPSE"]) != 6:
            raise SystemExit("%s, %s is not in the central path in SVS's file" % (name, state))
        out.append({"name": name, "state": state, "lat_deg": r["LAT"], "lon_deg": r["LON"],
                    "height_m": h, "svs": r})
    return out, {
        "url": SVS_BASE + file,
        "size_bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "rows": len(rows),
        "rows_in_central_path": sum(1 for r in rows if len(r["ECLIPSE"]) == 6),
    }


def wrap_city(city: dict) -> dict:
    """The fixture's form of an SVS row: SVS's six-decimal coordinates kept as printed."""
    r = city["svs"]
    return {
        "name": city["name"], "state": city["state"],
        "lat_deg": c.Num(city["lat_deg"], 6), "lon_deg": c.Num(city["lon_deg"], 6),
        "height_m": c.Num(city["height_m"], 1),
        "svs": {"NAME": r["NAME"], "STATE": r["STATE"], "LAT": c.Num(r["LAT"], 6),
                "LON": c.Num(r["LON"], 6), "ECLIPSE": c.Inline(list(r["ECLIPSE"]))},
    }


def build_svs():
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    eclipses = []
    for eid in CITIES:
        cities, facts = svs_cities(eid)
        eclipses.append({"id": eid, "source": facts, "cities": [wrap_city(x) for x in cities]})
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "script": "tools/limb/reference.py svs",
            "generated_utc": now,
            "page": SVS_PAGE,
            "description": (
                "NASA Scientific Visualization Studio, 'The 2023 and 2024 Solar Eclipses: "
                "Map and Data' (item 5073): for each city 'An array of UTC times for the "
                "[0.01%, 50%, 100%, 50%, 0.01%] points of coverage (normalized with respect "
                "to the maximum coverage achieved)'; in the central path the two 100% "
                "entries are the start and end of totality or annularity (second and third "
                "contact), to the whole second, computed by Ernie Wright with the lunar limb "
                "from LRO LOLA and SELENE (SLDEM2015), SRTM terrain and JPL DE421. Rows "
                "stored verbatim; height_m is this project's (the file has none)."
            ),
            "licence": "U.S. Government work (NASA); credit requested: NASA's Scientific "
                       "Visualization Studio. A test oracle only; nothing shipped.",
            "never_a_runtime_dependency": "Development-time reference only.",
        },
        "eclipses": eclipses,
    }
    path = os.path.join(FIXTURES, "eclipse_limb_svs.json")
    c.write_json(path, doc)


# ---------------------------------------------------------------------------
# Skyfield: an independent limb
# ---------------------------------------------------------------------------


class Sky:
    """Skyfield with DE440s, the IERS time scale bundled with Skyfield, and the DE440
    lunar orientation (MOON_ME_DE440_ME421)."""

    def __init__(self):
        from skyfield.api import load, load_file

        from tools.moon.gen_reference import LunarFrames

        self.eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
        self.earth, self.sun, self.moon = self.eph["earth"], self.eph["sun"], self.eph["moon"]
        self.ts = load.timescale()  # Skyfield 1.55's bundled IERS finals: real UT1
        self.frames = LunarFrames()
        self.dem = ring.read_dem().astype(np.float64)

    def time(self, jd_utc: float):
        """A Time at a UTC Julian date (the engine's `jd_utc`: 86 400 s per day counted
        from the UTC calendar)."""
        dt = _dt.datetime(2000, 1, 1) + _dt.timedelta(days=jd_utc - 2451544.5)
        sec = dt.second + dt.microsecond / 1e6
        return self.ts.utc(dt.year, dt.month, dt.day, dt.hour, dt.minute, sec)

    def site(self, lat, lon, h):
        from skyfield.api import wgs84

        return self.earth + wgs84.latlon(lat, lon, elevation_m=h)

    def state(self, site, t):
        """Observer->Moon and observer->Sun apparent vectors (GCRS, km), the lunar
        orientation (ICRF -> ME) at the light's departure, and the true pole of date."""
        a = site.at(t)
        am = a.observe(self.moon)
        v = np.asarray(am.apparent().position.km, dtype=float).ravel()
        w = np.asarray(a.observe(self.sun).apparent().position.km, dtype=float).ravel()
        tau = float(np.ravel(am.light_time)[0])
        t_emit = self.ts.tdb_jd(float(np.ravel(t.tdb)[0]) - tau)
        r = self.frames.rotation(t_emit)
        pole = np.asarray(t.M, dtype=float)[2]  # ICRS components of the true pole of date
        return v, w, r, pole


def north_east(u, pole):
    e = np.cross(pole, u)
    e /= np.linalg.norm(e)
    n = np.cross(u, e)
    return n, e


def profile(sky: Sky, v, r, pole, n_bins=5760, half_deg=8.0, step_deg=1.0 / 16.0, bins=None):
    """Crest per position-angle bin from the raw LDEM_16: (a, b) km with the angle
    atan(a / (D + b)); slices through the sub-observer point, bilinear heights every
    `step_deg` for |eps| <= half_deg."""
    D = float(np.linalg.norm(v))
    u = v / D
    n, e = north_east(u, pole)
    s = r @ (-u)
    nn = r @ n
    ee = r @ e
    k = np.arange(n_bins) if bins is None else np.asarray(bins)
    psi = k * (2 * math.pi / n_bins)
    q = np.cos(psi)[:, None] * nn[None, :] + np.sin(psi)[:, None] * ee[None, :]
    eps = np.radians(np.arange(-half_deg, half_deg + 1e-9, step_deg))
    ce, se = np.cos(eps), np.sin(eps)
    # P = cos eps q - sin eps s
    px = ce[None, :] * q[:, 0:1] - se[None, :] * s[0]
    py = ce[None, :] * q[:, 1:2] - se[None, :] * s[1]
    pz = ce[None, :] * q[:, 2:3] - se[None, :] * s[2]
    lat = np.degrees(np.arcsin(np.clip(pz, -1, 1)))
    lon = np.degrees(np.arctan2(py, px))
    h = ring.dem_height_m(sky.dem, lat, lon)
    rr = ring.REFERENCE_RADIUS_KM + h / 1000.0
    a = rr * ce[None, :]
    b = rr * se[None, :]
    ratio = a / (D + b)
    m = np.argmax(ratio, axis=1)
    idx = np.arange(len(k))
    return k, a[idx, m], b[idx, m], np.degrees(eps[m]), D


N_BINS = 5760


class Instant:
    """The Sun and the Moon as one site sees them at one UTC Julian date: the Sun's centre
    from the Moon's on the sky (azimuthal equidistant about the Moon's centre, east and
    north, radians), the semidiameters, and on request the Moon's outline from the raw
    LDEM_16 over some position-angle bins."""

    def __init__(self, sky: Sky, site, jd: float):
        t = sky.time(jd)
        v, w, r, pole = sky.state(site, t)
        self.jd = jd
        self.v, self.r, self.pole = v, r, pole
        self.D = float(np.linalg.norm(v))
        u = v / self.D
        us = w / np.linalg.norm(w)
        n, e = north_east(u, pole)
        self.sep = math.atan2(float(np.linalg.norm(np.cross(u, us))), float(u @ us))
        ce, cn = float(us @ e), float(us @ n)
        h = math.hypot(ce, cn)
        self.c = np.array([self.sep * ce / h, self.sep * cn / h])
        self.s = math.asin(SUN_RADIUS_KM / float(np.linalg.norm(w)))
        self.rho1 = math.asin(K1 * WGS84_A_KM / self.D)
        self.rho2 = math.asin(K2 * WGS84_A_KM / self.D)
        self.sky = sky
        self._outline = {}

    def outline(self, bins):
        key = (int(bins[0]), len(bins))
        if key not in self._outline:
            k, a, b, eps, D = profile(self.sky, self.v, self.r, self.pole, bins=bins)
            psi = k * (2 * math.pi / N_BINS)
            self._outline[key] = (k, psi, np.arctan(a / (D + b)), eps)
        return self._outline[key]


def bins_around(psi_centre: float, half_deg: float) -> np.ndarray:
    c = int(round((psi_centre % (2 * math.pi)) / (2 * math.pi) * N_BINS))
    h = int(math.ceil(half_deg / 360.0 * N_BINS))
    if 2 * h + 1 >= N_BINS:
        return np.arange(N_BINS)
    return np.mod(np.arange(c - h, c + h + 1), N_BINS)


def limb_condition(x: Instant, kind: str, bins) -> tuple[float, int]:
    """The contact function of docs/CONVENTIONS.md 15.7 (zero at the contact) and the
    deciding bin. external: min |rho e - c| - s. total: max (t_plus - rho). annular:
    max |rho e - c| - s."""
    k, psi, rho, _ = x.outline(bins)
    sp, cp = np.sin(psi), np.cos(psi)
    cx, cy = x.c
    if kind == "external":
        d = np.hypot(rho * sp - cx, rho * cp - cy) - x.s
        i = int(np.argmin(d))
    elif kind == "total":
        along = cx * sp + cy * cp
        across = cx * cp - cy * sp
        disc = x.s * x.s - across * across
        d = np.where(disc >= 0, along + np.sqrt(np.maximum(disc, 0)) - rho, -np.inf)
        i = int(np.argmax(d))
    else:
        d = np.hypot(rho * sp - cx, rho * cp - cy) - x.s
        i = int(np.argmax(d))
    return float(d[i]), int(k[i])


def mean_condition(x: Instant, kind: str) -> float:
    if kind == "external":
        return x.sep - (x.s + x.rho1)
    if kind == "total":
        return x.sep + x.s - x.rho2
    return x.sep + x.rho2 - x.s


def brent(f, a, b, tol):
    """Brent's root finder on a bracket (the classical algorithm, as in Numerical Recipes)."""
    fa, fb = f(a), f(b)
    if fa * fb > 0:
        return None
    if fa == 0:
        return a
    if fb == 0:
        return b
    c, fc = a, fa
    d = e = b - a
    for _ in range(100):
        if fb * fc > 0:
            c, fc = a, fa
            d = e = b - a
        if abs(fc) < abs(fb):
            a, b, c = b, c, b
            fa, fb, fc = fb, fc, fb
        tol1 = 2e-16 * abs(b) + 0.5 * tol
        xm = 0.5 * (c - b)
        if abs(xm) <= tol1 or fb == 0:
            return b
        if abs(e) >= tol1 and abs(fa) > abs(fb):
            s = fb / fa
            if a == c:
                p, q = 2 * xm * s, 1 - s
            else:
                q0, r0 = fa / fc, fb / fc
                p = s * (2 * xm * q0 * (q0 - r0) - (b - a) * (r0 - 1))
                q = (q0 - 1) * (r0 - 1) * (s - 1)
            if p > 0:
                q = -q
            p = abs(p)
            if 2 * p < min(3 * xm * q - abs(tol1 * q), abs(e * q)):
                e, d = d, p / q
            else:
                d = e = xm
        else:
            d = e = xm
        a, fa = b, fb
        b += d if abs(d) > tol1 else math.copysign(tol1, xm)
        fb = f(b)
    return b


SECOND = 1.0 / 86400.0
JD_TOL = 1e-8  # 0.86 ms


def city_contacts(sky: Sky, lat, lon, h, jd_guess: float, total: bool = True) -> dict:
    """Mean-limb (k1, k2) and limb-corrected contacts for one site, UTC Julian dates."""
    site = sky.site(lat, lon, h)
    cache = {}

    def at(jd):
        if jd not in cache:
            cache[jd] = Instant(sky, site, jd)
        return cache[jd]

    # Maximum: least separation, golden section on a +-3 h bracket found by scanning.
    grid = jd_guess + np.arange(-180, 181, 2) / 1440.0
    seps = [at(j).sep for j in grid]
    j0 = grid[int(np.argmin(seps))]
    a, b = j0 - 2 / 1440.0, j0 + 2 / 1440.0
    g = (math.sqrt(5) - 1) / 2
    x1, x2 = b - g * (b - a), a + g * (b - a)
    f1, f2 = at(x1).sep, at(x2).sep
    while b - a > JD_TOL:
        if f1 < f2:
            b, x2, f2 = x2, x1, f1
            x1 = b - g * (b - a)
            f1 = at(x1).sep
        else:
            a, x1, f1 = x1, x2, f2
            x2 = a + g * (b - a)
            f2 = at(x2).sep
    jd_max = 0.5 * (a + b)
    central = "total" if total else "annular"
    out = {"max_jd_utc": jd_max, "mean": {}, "limb": {}}

    def mean_root(kind, lo, hi):
        return brent(lambda j: mean_condition(at(j), kind), lo, hi, JD_TOL)

    out["mean"]["c1"] = mean_root("external", jd_max - 3 / 24.0, jd_max)
    out["mean"]["c4"] = mean_root("external", jd_max, jd_max + 3 / 24.0)
    out["mean"]["c2"] = mean_root(central, jd_max - 10 / 1440.0, jd_max)
    out["mean"]["c3"] = mean_root(central, jd_max, jd_max + 10 / 1440.0)

    # Without a mean-limb central phase (a site at the edge of the path), the limb's can
    # still exist: look for it second by second around the maximum.
    if out["mean"]["c2"] is None or out["mean"]["c3"] is None:
        x0 = at(jd_max)
        toward = math.atan2(x0.c[0], x0.c[1])
        bins_all = np.arange(N_BINS)
        grid = jd_max + np.arange(-90, 91) * SECOND
        vals = [limb_condition(at(j), central, bins_all)[0] for j in grid]
        inside = [i for i, v in enumerate(vals) if v < 0]
        if inside:
            i0, i1 = inside[0], inside[-1]
            out["_seed"] = {"c2": grid[i0], "c3": grid[i1]}

    for name, kind in (("c1", "external"), ("c2", central), ("c3", central), ("c4", "external")):
        tm = out["mean"][name]
        if tm is None:
            tm = out.get("_seed", {}).get(name)
        if tm is None:
            out["limb"][name] = None
            continue
        x0 = at(tm)
        toward = math.atan2(x0.c[0], x0.c[1])
        centre = toward + (math.pi if kind == "annular" else 0.0)
        half = 180.0 if (kind != "external" and float(np.hypot(*x0.c)) < 12 * ARCSEC) else 90.0
        bins = bins_around(centre, half)

        def f(j, bins=bins, kind=kind):
            return limb_condition(at(j), kind, bins)[0]

        root = None
        for w in (15.0, 45.0, 120.0):
            lo, hi = tm - w * SECOND, tm + w * SECOND
            flo, fm, fhi = f(lo), f(tm), f(hi)
            cands = []
            if flo * fm <= 0:
                cands.append(brent(f, lo, tm, JD_TOL))
            if fm * fhi <= 0:
                cands.append(brent(f, tm, hi, JD_TOL))
            cands = [c_ for c_ in cands if c_ is not None]
            if cands:
                root = min(cands, key=lambda c_: abs(c_ - tm))
                break
        if root is None:
            out["limb"][name] = None
            continue
        v, kbin = limb_condition(at(root), kind, bins)
        k_all, psi, rho, eps = at(root).outline(bins)
        i = int(np.flatnonzero(k_all == kbin)[0])
        ref = math.asin(ring.REFERENCE_RADIUS_KM / at(root).D)
        out["limb"][name] = {
            "jd_utc": root,
            "limb_position_angle_deg": kbin * 360.0 / N_BINS,
            "limb_height_arcsec": (float(rho[i]) - ref) / ARCSEC,
            "crest_eps_deg": float(eps[i]),
        }
    out.pop("_seed", None)
    return out


def utc_jd_of_hms(eid: str, hms: str) -> float:
    y, m, d = (int(x) for x in eid[:10].split("-"))
    h, mi, sec = (int(x) for x in hms.split(":"))
    jd0 = (_dt.date(y, m, d) - _dt.date(2000, 1, 1)).days + 2451544.5
    return jd0 + (h * 3600 + mi * 60 + sec) / 86400.0


#: Cities whose whole profile at maximum goes into the fixture (the drawing check).
PROFILE_CITIES = {("2024-04-08-solar", "Dallas"), ("2024-04-08-solar", "Burlington"),
                  ("2023-10-14-solar", "Albuquerque")}


def build_skyfield(only=None):
    import time

    sky = Sky()
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    eclipses = []
    for eid in CITIES:
        cities, _ = svs_cities(eid)
        total = eid.startswith("2024")
        rows = []
        dut1 = None
        for city in cities:
            if only and city["name"] not in only:
                continue
            t0 = time.time()
            guess = utc_jd_of_hms(eid, city["svs"]["ECLIPSE"][2])
            res = city_contacts(sky, city["lat_deg"], city["lon_deg"], city["height_m"], guess,
                                total=total)
            limb = {}
            for k_, v_ in res["limb"].items():
                limb[k_] = None if v_ is None else {
                    "jd_utc": c.jd(v_["jd_utc"]),
                    "limb_position_angle_deg": c.Num(v_["limb_position_angle_deg"], 4),
                    "limb_height_arcsec": c.arcsec(v_["limb_height_arcsec"]),
                    "crest_eps_deg": c.Num(v_["crest_eps_deg"], 4),
                }
            row = {"name": city["name"], "state": city["state"],
                   "lat_deg": c.Num(city["lat_deg"], 6), "lon_deg": c.Num(city["lon_deg"], 6),
                   "height_m": c.Num(city["height_m"], 1),
                   "max_jd_utc": c.jd(res["max_jd_utc"]),
                   "mean": {k_: (None if v_ is None else c.jd(v_)) for k_, v_ in res["mean"].items()},
                   "limb": limb}
            if (eid, city["name"]) in PROFILE_CITIES:
                site = sky.site(city["lat_deg"], city["lon_deg"], city["height_m"])
                x = Instant(sky, site, res["max_jd_utc"])
                k, psi, rho, eps = x.outline(np.arange(N_BINS))
                ref = math.asin(ring.REFERENCE_RADIUS_KM / x.D)
                row["profile_at_max"] = {
                    "jd_utc": c.jd(res["max_jd_utc"]),
                    "moon_distance_km": c.Num(x.D, 3),
                    "sun_offset_arcsec": c.Inline([c.arcsec(float(x.c[0] / ARCSEC)),
                                                   c.arcsec(float(x.c[1] / ARCSEC))]),
                    "sun_radius_arcsec": c.arcsec(x.s / ARCSEC),
                    "height_arcsec": c.Inline([c.Num(float(v), 3) for v in (rho - ref) / ARCSEC]),
                }
            t = sky.time(res["max_jd_utc"])
            dut1 = float(t.dut1)
            rows.append(row)
            def corr(k):
                lk, mk = res["limb"][k], res["mean"][k]
                return (lk["jd_utc"] - mk) * 86400 if (lk and mk) else float("nan")

            print("%s %-28s %5.1f s  c2 %+.3f s  c3 %+.3f s" % (
                eid[:10], city["name"], time.time() - t0, corr("c2"), corr("c3")), flush=True)
        eclipses.append({"id": eid, "central": "total" if total else "annular",
                         "dut1_s": c.secs(dut1), "cities": rows})
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "script": "tools/limb/reference.py skyfield",
            "generated_utc": now,
            "description": (
                "An independent implementation of the limb-corrected contacts of "
                "docs/CONVENTIONS.md 15.7 for the SVS cities: the topocentric apparent Sun "
                "and Moon from Skyfield 1.55 with JPL DE440s on Skyfield's IERS time scale "
                "(dut1_s is its UT1 - UTC); the Moon's orientation from NAIF's DE440 lunar "
                "PCK in MOON_ME_DE440_ME421 at the instant the light left it; the profile "
                "from the raw LDEM_16 grid (bilinear), every 1/16 degree of position angle, "
                "slices sampled every 1/16 degree to 8 degrees either side of the plane of "
                "the sky; Sun 959.63 arcsec at 1 au; mean-limb contacts with NASA's k1 = "
                "0.272488 and k2 = 0.272281 (WGS84 equatorial radii). Contacts are UTC "
                "Julian dates found by Brent's method to 1e-8 day."
            ),
            "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
            "never_a_runtime_dependency": "Development-time reference only.",
        },
        "eclipses": eclipses,
    }
    path = os.path.join(FIXTURES, "eclipse_limb_skyfield.json")
    c.write_json(path, doc)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    what = [a for a in argv if not a.startswith("--")] or ["svs", "skyfield"]
    if "svs" in what:
        build_svs()
    if "skyfield" in what:
        build_skyfield()
    return 0


if __name__ == "__main__":
    sys.exit(main())
