"""fixtures/reference/planetdetail_*.json — planet detail references (development-time only).

The planetdetail package (docs/EXPANSION_PLAN.md section 5, P9) is checked against these
files, each independent of the Rust code (CONVENTIONS section 11: never regenerate a
fixture from Rust output):

* ``planetdetail_horizons.json`` — JPL Horizons observer quantities for Mercury to Neptune
  (disc diameter, illumination, defect, sub-observer and sub-solar points, north-pole
  position angle, pole direction) at 34 epochs each, 1601-2499, and Saturn's rings through
  its sub-observer latitudes. **Needs network.**
* ``planetdetail_galilean.json`` — Io, Europa, Ganymede and Callisto relative to Jupiter's
  centre from Skyfield with JPL's ``jup365.bsp`` satellite ephemeris (small excerpts cut
  over HTTP with ``python -m jplephem excerpt``) and DE440, at a dozen instants, plus the
  times of their transits, shadow transits, occultations and eclipses over a few weeks.
  **Needs network** for the excerpts the first time.
* ``planetdetail_transits.json`` — NASA's transit catalogues (Espenak: Venus 2000 BCE-4000
  CE, Mercury 1601-2300 CE), the 2004 and 2012 geocentric contact tables to the second,
  and local contact times for named cities. **Needs network.**
* ``planetdetail_conjunctions.json`` — planet-planet, Moon-planet, planet-star and
  Moon-star closest approaches and the stations of Mercury to Neptune from Skyfield +
  DE440s.
* ``planetdetail_apsides.json`` — the Earth's perihelion and aphelion from USNO's API
  (network), Meeus's Table 38.C and Skyfield + DE440s.
* ``planetdetail_orbits.json`` — a few MPC orbit lines (comets and minor planets, source
  stated) and Skyfield's two-body positions from them (``skyfield.data.mpc``).

    tools/reference/.venv/bin/python -m tools.reference.gen_planetdetail [--part NAME] [--offline]

``--offline`` keeps every network-derived file already present and rebuilds only the
Skyfield parts that need no network.
"""

from __future__ import annotations

import argparse
import hashlib
import html as _html
import json
import math
import os
import re
import subprocess
import time

import numpy as np

from . import common as c

FIXTURES = c.FIX_REFERENCE
DATA_PD = os.path.join(c.DATA, "planetdetail")
TOOL = "tools/reference/gen_planetdetail.py"
NEVER = (
    "Development-time reference. CONVENTIONS section 11: never regenerate a fixture from "
    "Rust output."
)
AU_KM = 149_597_870.700
C_KM_S = 299_792.458
D2R = math.pi / 180.0


def fetch(url, timeout=120, attempts=4):
    for k in range(attempts):
        try:
            return subprocess.run(
                ["curl", "-sS", "-f", "-m", str(timeout), "-L", url], check=True,
                capture_output=True,
            ).stdout
        except subprocess.CalledProcessError:
            if k == attempts - 1:
                raise
            time.sleep(2.0 * (k + 1))


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def jd_to_iso(jd):
    """Proleptic Gregorian calendar string of a Julian date (any sign of year)."""
    z = math.floor(jd + 0.5)
    f = jd + 0.5 - z
    alpha = math.floor((z - 1867216.25) / 36524.25)
    a = z + 1 + alpha - math.floor(alpha / 4)
    b = a + 1524
    cc = math.floor((b - 122.1) / 365.25)
    d = math.floor(365.25 * cc)
    e = math.floor((b - d) / 30.6001)
    day = b - d - math.floor(30.6001 * e)
    month = e - 1 if e < 14 else e - 13
    year = cc - 4716 if month > 2 else cc - 4715
    secs = round(f * 86400.0, 3)
    hh = int(secs // 3600)
    mm = int((secs - hh * 3600) // 60)
    ss = secs - hh * 3600 - mm * 60
    y = "%04d" % year if 0 <= year <= 9999 else "%+05d" % year
    return "%s-%02d-%02dT%02d:%02d:%06.3fZ" % (y, month, day, hh, mm, ss)


# ---------------------------------------------------------------------------
# IAU WGCCRE 2015 rotation elements (Archinal et al. 2018), as NAIF's pck00011.tpc
# encodes them. Coded here from that file's text, independently of the Rust tables.
# ---------------------------------------------------------------------------

PCK_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"

RADII_KM = {
    "Mercury": (2440.53, 2438.26),
    "Venus": (6051.8, 6051.8),
    "Mars": (3396.19, 3376.20),
    "Jupiter": (71492.0, 66854.0),
    "Saturn": (60268.0, 54364.0),
    "Uranus": (25559.0, 24973.0),
    "Neptune": (24764.0, 24341.0),
}


def iau_orientation(body, jd_tdb):
    """(pole RA, pole Dec, W) in degrees, ICRF, for barycentric dynamical time jd_tdb."""
    d = jd_tdb - 2451545.0
    T = d / 36525.0

    def s(a, r):
        return math.sin((a + r * T) * D2R)

    def co(a, r):
        return math.cos((a + r * T) * D2R)

    if body == "Mercury":
        ra, dec = 281.0103 - 0.0328 * T, 61.4155 - 0.0049 * T
        m = [(174.7910857, 4.092335), (349.5821714, 8.184670), (164.3732571, 12.277005),
             (339.1643429, 16.369340), (153.9554286, 20.461675)]
        k = [0.01067257, -0.00112309, -0.00011040, -0.00002539, -0.00000571]
        w = 329.5988 + 6.1385108 * d + sum(
            ki * math.sin((a + r * d) * D2R) for ki, (a, r) in zip(k, m)
        )
        return ra, dec, w
    if body == "Venus":
        return 272.76, 67.16, 160.20 - 1.4813688 * d
    if body == "Mars":
        ra = (317.269202 - 0.10927547 * T + 0.000068 * s(198.991226, 19139.4819985)
              + 0.000238 * s(226.292679, 38280.8511281) + 0.000052 * s(249.663391, 57420.7251593)
              + 0.000009 * s(266.183510, 76560.6367950) + 0.419057 * s(79.398797, 0.5042615))
        dec = (54.432516 - 0.05827105 * T + 0.000051 * co(122.433576, 19139.9407476)
               + 0.000141 * co(43.058401, 38280.8753272) + 0.000031 * co(57.663379, 57420.7517205)
               + 0.000005 * co(79.476401, 76560.6495004) + 1.591274 * co(166.325722, 0.5042615))
        w = (176.049863 + 350.891982443297 * d + 0.000145 * s(129.071773, 19140.0328244)
             + 0.000157 * s(36.352167, 38281.0473591) + 0.000040 * s(56.668646, 57420.9295360)
             + 0.000001 * s(67.364003, 76560.2552215) + 0.000001 * s(104.792680, 95700.4387578)
             + 0.584542 * s(95.391654, 0.5042615))
        return ra, dec, w
    if body == "Jupiter":
        ja, jb, jc, jdd, je = ((99.360714, 4850.4046), (175.895369, 1191.9605),
                               (300.323162, 262.5475), (114.012305, 6070.2476),
                               (49.511251, 64.3000))
        ra = (268.056595 - 0.006499 * T + 0.000117 * s(*ja) + 0.000938 * s(*jb)
              + 0.001432 * s(*jc) + 0.000030 * s(*jdd) + 0.002150 * s(*je))
        dec = (64.495303 + 0.002413 * T + 0.000050 * co(*ja) + 0.000404 * co(*jb)
               + 0.000617 * co(*jc) - 0.000013 * co(*jdd) + 0.000926 * co(*je))
        return ra, dec, 284.95 + 870.5360000 * d
    if body == "Saturn":
        return 40.589 - 0.036 * T, 83.537 - 0.004 * T, 38.90 + 810.7939024 * d
    if body == "Uranus":
        return 257.311, -15.175, 203.81 - 501.1600928 * d
    if body == "Neptune":
        n = (357.85 + 52.316 * T) * D2R
        return (299.36 + 0.70 * math.sin(n), 43.46 - 0.51 * math.cos(n),
                249.978 + 541.1397757 * d - 0.48 * math.sin(n))
    raise ValueError(body)


def pole_vector(ra, dec):
    return np.array([
        math.cos(dec * D2R) * math.cos(ra * D2R),
        math.cos(dec * D2R) * math.sin(ra * D2R),
        math.sin(dec * D2R),
    ])


# ---------------------------------------------------------------------------
# Part 1: JPL Horizons observer quantities (discs and rings)
# ---------------------------------------------------------------------------

HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_IDS = {
    "Mercury": "199", "Venus": "299", "Mars": "499", "Jupiter": "599",
    "Saturn": "699", "Uranus": "799", "Neptune": "899",
}
HORIZONS_QUANTITIES = "2,9,10,11,13,14,15,17,19,20,24,32"


def disc_epochs(planet_index):
    """34 TT Julian dates: 26 spread over 1990-2060 (shifted per planet so the geometry
    differs) and 8 far from it (1601-2499) for the deep-time tiers. Horizons' satellite
    ephemerides (which place each planet's centre) stop at 1600 and 2600."""
    out = []
    base = 2447893.25 + 37.0 * planet_index
    for k in range(26):
        out.append(round(base + k * 999.37, 5))
    for jd in (2306000.5, 2341972.5, 2378496.5, 2415020.5, 2488069.5, 2524593.5,
               2597641.5, 2633800.5):
        out.append(jd + 0.25 * planet_index)
    return out


SATURN_EXTRA = [
    2449859.5,  # 1995-05-22, Earth crosses the ring plane
    2449940.5,  # 1995-08-11
    2450125.5,  # 1996-02-12
    2455053.5,  # 2009-08-10, Sun crosses the ring plane
    2455078.5,  # 2009-09-04, Earth crosses the ring plane
    2460757.5,  # 2025-03-23, Earth crosses the ring plane
    2460801.5,  # 2025-05-06, Sun crosses the ring plane
]


def horizons_query(body_id, jds):
    tlist = ",".join("'%.5f'" % jd for jd in jds)
    params = {
        "format": "text",
        "COMMAND": "'%s'" % body_id,
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'500@399'",
        "TLIST": tlist,
        "TLIST_TYPE": "'JD'",
        "TIME_TYPE": "'TT'",
        "QUANTITIES": "'%s'" % HORIZONS_QUANTITIES,
        "ANG_FORMAT": "'DEG'",
        "EXTRA_PREC": "'YES'",
        "CSV_FORMAT": "'YES'",
        "CAL_TYPE": "'GREGORIAN'",
    }
    query = "&".join("%s=%s" % (k, v) for k, v in params.items())
    url = HORIZONS_API + "?" + query
    raw = fetch(url, timeout=180)
    return url, raw


def parse_horizons(text):
    lines = text.splitlines()
    try:
        i0 = lines.index("$$SOE")
        i1 = lines.index("$$EOE")
    except ValueError:
        raise RuntimeError("Horizons reply has no $$SOE/$$EOE block:\n" + text[:3000])
    header = None
    for j in range(i0 - 1, -1, -1):
        if "Date__" in lines[j]:
            header = [h.strip() for h in lines[j].split(",")]
            break
    if header is None:
        raise RuntimeError("no header line")
    rows = []
    for ln in lines[i0 + 1:i1]:
        vals = [v.strip() for v in ln.split(",")]
        rows.append(dict(zip(header, vals)))
    meta = {}
    for ln in lines:
        for key in ("Target pole/equ", "Target radii", "Target body name"):
            if ln.startswith(key):
                meta[key] = ln.split(":", 1)[1].strip()
    return rows, meta


def num(v):
    v = v.strip()
    if v in ("n.a.", ""):
        return None
    return float(v)


def build_horizons(offline):
    path = os.path.join(FIXTURES, "planetdetail_horizons.json")
    if offline and os.path.exists(path):
        print("keeping", os.path.relpath(path, c.REPO))
        return
    planets = {}
    sources = []
    for idx, (name, body_id) in enumerate(HORIZONS_IDS.items()):
        jds = disc_epochs(idx)
        if name == "Saturn":
            jds += SATURN_EXTRA
        jds = sorted(jds)
        # Horizons places each planet's centre with its satellite ephemeris, whose span
        # differs per planet (Jupiter's stops at 2200): drop the far epochs it refuses.
        for _ in range(4):
            url, raw = horizons_query(body_id, jds)
            text = raw.decode("utf-8", "replace")
            limit = re.search(r"No ephemeris for target .* (after|prior to) (?:A\.D\. |B\.C\. )?(\d{4})-", text)
            if not limit:
                break
            year = int(limit.group(2))
            jd_limit = 1721058.5 + 365.2425 * year
            before = len(jds)
            jds = [jd for jd in jds if (jd < jd_limit if limit.group(1) == "after" else jd > jd_limit + 366)]
            print("  Horizons %s: no ephemeris %s %d; %d epochs dropped" % (name, limit.group(1), year, before - len(jds)))
            time.sleep(1.0)
        rows, meta = parse_horizons(text)
        if len(rows) != len(jds):
            raise RuntimeError("%s: %d rows for %d epochs" % (name, len(rows), len(jds)))
        sources.append({"body": name, "url": url, "sha256": sha256(raw), "bytes": len(raw),
                        "target_pole": meta.get("Target pole/equ"),
                        "target_radii": meta.get("Target radii")})
        out_rows = []
        for jd, r in zip(jds, rows):
            row = {
                "jd_tt": c.jd(jd),
                "utc_like": r[next(k for k in r if k.startswith("Date__"))],
                "ra_deg": c.deg(num(r["R.A.__(a-app)"])),
                "dec_deg": c.deg(num(r["DEC___(a-app)"])),
                "illuminated_percent": c.Num(num(r["Illu%"]), 5),
                "defect_arcsec": c.Num(num(r["Def_illu"]), 4),
                "angular_diameter_arcsec": c.Num(num(r["Ang-diam"]), 5),
                "obs_sub_lon_deg": c.Num(num(r["ObsSub-LON"]), 6),
                "obs_sub_lat_graphic_deg": c.Num(num(r["ObsSub-LAT"]), 6),
                "sun_sub_lon_deg": c.Num(num(r["SunSub-LON"]), 6),
                "sun_sub_lat_graphic_deg": c.Num(num(r["SunSub-LAT"]), 6),
                "np_ang_deg": c.Num(num(r["NP.ang"]), 4),
                "np_dist_arcsec": c.Num(num(r["NP.dist"]), 3),
                "r_au": c.Num(num(r["r"]), 12),
                "delta_au": c.Num(num(r["delta"]), 14),
                "phase_angle_deg": c.Num(num(r["S-T-O"]), 4),
                "pole_ra_deg": c.Num(num(r["N.Pole-RA"]), 5),
                "pole_dec_deg": c.Num(num(r["N.Pole-DC"]), 5),
            }
            mag = num(r.get("APmag", "n.a."))
            row["apmag"] = None if mag is None else c.Num(mag, 3)
            out_rows.append(c.Inline(row))
        a, cc = RADII_KM[name]
        planets[name] = {
            "horizons_id": body_id,
            "radii_km": [c.Num(a, 2), c.Num(cc, 2)],
            "rows": out_rows,
        }
        print("  Horizons %-8s %d rows" % (name, len(out_rows)))
        time.sleep(1.0)
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": TOOL,
            "description": (
                "JPL Horizons observer quantities for Mercury to Neptune, geocentric "
                "(CENTER 500@399), TT instants, quantities %s: apparent RA/Dec of date, "
                "APmag, illuminated percentage, defect of illumination, equatorial angular "
                "diameter, sub-observer and sub-solar planetodetic longitude and latitude, "
                "north-pole position angle and distance, r, delta, Sun-target-observer "
                "angle, and the pole's ICRF RA/Dec." % HORIZONS_QUANTITIES
            ),
            "generated_utc": c.generated_utc(),
            "retrieved": c.generated_utc()[:10],
            "sources": sources,
            "licence": (
                "JPL Horizons (NASA/JPL-Caltech) states no terms for its output; used as a "
                "development-time reference only, never shipped (docs/THIRD_PARTY.md)."
            ),
            "conventions": {
                "latitudes": (
                    "Horizons gives planetodetic latitudes on the reference ellipsoid of the "
                    "header (radii_km: equatorial, polar); tan(graphic) = tan(centric) / "
                    "(1 - f)^2 converts them."
                ),
                "longitudes": (
                    "IAU 2015 prime meridians (System III for Jupiter, Saturn and Uranus), "
                    "west-positive for Mercury, Mars, Jupiter, Saturn and Neptune, east-positive "
                    "for Venus and Uranus. Horizons evaluates the rotation at the light time of "
                    "the sub-observer surface point, (delta - R) / c, which a probe against "
                    "Skyfield + DE440s confirmed (offsets of R / c of rotation otherwise)."
                ),
                "np_ang": "position angle of the north pole from the true-of-date celestial north, through east",
                "time": "TT; epochs outside 1990-2060 are for the deep-time tiers and are skipped by tests while the providers do not cover them",
            },
            "never_a_runtime_dependency": NEVER,
        },
        "planets": planets,
    }
    c.write_json(path, doc)


# ---------------------------------------------------------------------------
# Part 2: the Galilean moons from JPL's jup365 satellite ephemeris
# ---------------------------------------------------------------------------

JUP365_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup365.bsp"
DE440_FILE = os.path.join(c.DATA, "de440.bsp")
DE440_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440.bsp"
MOONS = [("Io", 501), ("Europa", 502), ("Ganymede", 503), ("Callisto", 504)]
JUPITER_RADII_KM = RADII_KM["Jupiter"]

# Instants for positions (TT calendar), spread over 1995-2058 plus three far from it
# (jup365 spans 1600-2200) for the deep-time tiers.
GALILEAN_INSTANTS = [
    (1995, 6, 15, 3.2), (1998, 9, 16, 21.5), (2002, 1, 1, 12.0), (2005, 4, 3, 6.7),
    (2008, 7, 9, 18.1), (2011, 10, 29, 1.4), (2015, 2, 6, 23.9), (2018, 5, 9, 10.0),
    (2021, 8, 20, 14.6), (2024, 12, 7, 4.3), (2026, 1, 10, 8.0), (2032, 3, 18, 20.2),
    (2039, 7, 1, 2.5), (2047, 11, 22, 16.0), (2058, 4, 4, 9.9),
    (1650, 3, 1, 0.0), (1850, 9, 12, 12.0), (2150, 12, 25, 6.0),
]
# Windows for phenomena (UTC calendar dates): near opposition (shadows and moons almost
# together) and near eastern quadrature (well separated).
GALILEAN_EVENT_WINDOWS = [((2026, 1, 5), (2026, 1, 25)), ((2026, 4, 1), (2026, 4, 21))]


def jup365_excerpt(start, end):
    """Cut [start, end] (calendar dates) out of jup365.bsp over HTTP; cached."""
    os.makedirs(DATA_PD, exist_ok=True)
    name = "jup365_%04d%02d%02d_%04d%02d%02d.bsp" % (start + end)
    path = os.path.join(DATA_PD, name)
    if not os.path.exists(path):
        cmd = [
            os.path.join(c.HERE, ".venv", "bin", "python"), "-m", "jplephem", "excerpt",
            "--targets", "501,502,503,504,599",
            "%04d/%02d/%02d" % start, "%04d/%02d/%02d" % end, JUP365_URL, path,
        ]
        print("  excerpt", name)
        subprocess.run(cmd, check=True, capture_output=True)
    return path


def _unit(v):
    return v / np.linalg.norm(v, axis=0)


def _mxv(m, v):
    return np.einsum("ij...,j...->i...", m, v)


def _tangent(dirs, centre):
    """Gnomonic (east, north) coordinates of unit vectors `dirs` about `centre`, both
    (3, N) in the same equatorial frame, radians."""
    x, y, z = centre
    east = np.array([-y, x, np.zeros_like(x)])
    east = east / np.linalg.norm(east, axis=0)
    north = np.cross(centre.T, east.T).T
    w = np.sum(dirs * centre, axis=0)
    return np.sum(dirs * east, axis=0) / w, np.sum(dirs * north, axis=0) / w, east, north


class JupiterSystem:
    """Skyfield views of Jupiter's centre and the four moons, from the Earth and from the Sun,
    with exactly the definitions docs/CONVENTIONS.md section 13.10 states."""

    def __init__(self, ts, eph, excerpt_path):
        from skyfield.api import load_file

        self.ts = ts
        self.eph = eph
        self.kernel = load_file(excerpt_path)
        seg = {s.target: s for s in self.kernel.segments}
        bary = eph["jupiter barycenter"]
        self.centre = bary + seg[599]
        self.moons = {name: bary + seg[code] for name, code in MOONS}
        self.earth, self.sun = eph["earth"], eph["sun"]

    def pole(self, jd_tdb):
        ra, dec, _ = np.vectorize(lambda j: iau_orientation("Jupiter", j))(jd_tdb)
        return pole_vector_array(ra, dec)

    def earth_view(self, t, name):
        e = self.earth.at(t)
        jc = e.observe(self.centre)
        mo = e.observe(self.moons[name])
        a_j = _mxv(t.M, _unit(jc.apparent().position.km))
        a_m = _mxv(t.M, _unit(mo.apparent().position.km))
        xi, eta, east, north = _tangent(a_m, a_j)
        p_icrf = self.pole(t.tdb - jc.light_time)
        p = _mxv(t.M, p_icrf)
        pa = np.arctan2(np.sum(p * east, axis=0), np.sum(p * north, axis=0))
        x = -xi * np.cos(pa) + eta * np.sin(pa)
        y = xi * np.sin(pa) + eta * np.cos(pa)
        rj = jc.position.km
        dist = np.linalg.norm(rj, axis=0)
        uj = rj / dist
        depth = np.sum((mo.position.km - rj) * uj, axis=0)
        a = np.arcsin(JUPITER_RADII_KM[0] / dist)
        d_e = np.arcsin(np.clip(-np.sum(uj * p_icrf, axis=0), -1, 1))
        e2 = 1.0 - (JUPITER_RADII_KM[1] / JUPITER_RADII_KM[0]) ** 2
        b = a * np.sqrt(1.0 - e2 * np.cos(d_e) ** 2)
        inside = (x / a) ** 2 + (y / b) ** 2 < 1.0
        return {
            "xi": xi, "eta": eta, "x": x, "y": y, "pa": pa, "a": a, "b": b, "depth": depth,
            "inside": inside, "lt_moon": mo.light_time, "lt_centre": jc.light_time,
            "d_e": d_e,
        }

    def _bary(self, body, jd_tdb):
        return body.at(self.ts.tdb_jd(jd_tdb)).position.km

    def sun_view(self, jd_tdb_moon, jd_tdb_jupiter, name, moon_first):
        """Whether the Sun's centre -> moon ray meets Jupiter's disc, and on which side.

        eclipse (moon_first=False): the moon at jd_tdb_moon, Jupiter when the ray passed it.
        shadow (moon_first=True): Jupiter at jd_tdb_jupiter, the moon when the ray passed it.
        """
        moon = self.moons[name]
        if moon_first:
            j = self._bary(self.centre, jd_tdb_jupiter)
            t_m = jd_tdb_jupiter
            for _ in range(3):
                m = self._bary(moon, t_m)
                s = self._bary(self.sun, t_m - np.linalg.norm(m - self._bary(self.sun, t_m), axis=0) / C_KM_S / 86400.0)
                jhat = _unit(j - s)
                delta = np.sum((j - m) * jhat, axis=0) / C_KM_S / 86400.0
                t_m = jd_tdb_jupiter - delta
            t_j = jd_tdb_jupiter
        else:
            m = self._bary(moon, jd_tdb_moon)
            s = self._bary(self.sun, jd_tdb_moon - np.linalg.norm(m - self._bary(self.sun, jd_tdb_moon), axis=0) / C_KM_S / 86400.0)
            t_j = jd_tdb_moon
            for _ in range(3):
                j = self._bary(self.centre, t_j)
                jhat = _unit(j - s)
                delta = np.sum((m - j) * jhat, axis=0) / C_KM_S / 86400.0
                t_j = jd_tdb_moon - delta
        mhat = _unit(m - s)
        xi, eta, east, north = _tangent(mhat, jhat)
        p = self.pole(t_j)
        pa = np.arctan2(np.sum(p * east, axis=0), np.sum(p * north, axis=0))
        x = -xi * np.cos(pa) + eta * np.sin(pa)
        y = xi * np.sin(pa) + eta * np.cos(pa)
        dist = np.linalg.norm(j - s, axis=0)
        a = np.arcsin(JUPITER_RADII_KM[0] / dist)
        d_s = np.arcsin(np.clip(-np.sum(jhat * p, axis=0), -1, 1))
        e2 = 1.0 - (JUPITER_RADII_KM[1] / JUPITER_RADII_KM[0]) ** 2
        b = a * np.sqrt(1.0 - e2 * np.cos(d_s) ** 2)
        inside = (x / a) ** 2 + (y / b) ** 2 < 1.0
        front = np.sum((m - j) * jhat, axis=0) < 0.0
        return inside, front

    def flags(self, t, name):
        ev = self.earth_view(t, name)
        transit = ev["inside"] & (ev["depth"] < 0)
        occult = ev["inside"] & (ev["depth"] > 0)
        tdb = t.tdb
        inside_e, front_e = self.sun_view(tdb - ev["lt_moon"], None, name, False)
        eclipse = inside_e & ~front_e
        inside_s, front_s = self.sun_view(None, tdb - ev["lt_centre"], name, True)
        shadow = inside_s & front_s
        return {"transit": transit, "occultation": occult, "eclipse": eclipse,
                "shadow_transit": shadow}, ev


def pole_vector_array(ra, dec):
    ra, dec = np.asarray(ra) * D2R, np.asarray(dec) * D2R
    return np.array([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])


def build_galilean(offline):
    from skyfield.api import load_file
    from skyfield.searchlib import find_discrete

    path = os.path.join(FIXTURES, "planetdetail_galilean.json")
    ts = c.load_timescale()
    eph = load_file(DE440_FILE)
    positions = []
    excerpts = []
    for (y, mo, d, h) in GALILEAN_INSTANTS:
        t = ts.tt(y, mo, d, h)
        lo = ts.tt_jd(t.tt - 2.0).tt_calendar()[:3]
        hi = ts.tt_jd(t.tt + 2.0).tt_calendar()[:3]
        kpath = jup365_excerpt(tuple(int(v) for v in lo), tuple(int(v) for v in hi))
        excerpts.append(os.path.basename(kpath))
        js = JupiterSystem(ts, eph, kpath)
        tt = ts.tt_jd(np.array([t.tt]))
        moons = []
        for name, _ in MOONS:
            f, ev = js.flags(tt, name)
            arc = 180.0 / math.pi * 3600.0
            moons.append(c.Inline({
                "name": name,
                "east_arcsec": c.Num(float(ev["xi"][0]) * arc, 5),
                "north_arcsec": c.Num(float(ev["eta"][0]) * arc, 5),
                "x_rj": c.Num(float(ev["x"][0] / ev["a"][0]), 6),
                "y_rj": c.Num(float(ev["y"][0] / ev["a"][0]), 6),
                "depth_km": c.Num(float(ev["depth"][0]), 1),
                "transit": bool(f["transit"][0]),
                "occultation": bool(f["occultation"][0]),
                "eclipse": bool(f["eclipse"][0]),
                "shadow_transit": bool(f["shadow_transit"][0]),
            }))
        positions.append({
            "jd_tt": c.jd(t.tt),
            "tt": jd_to_iso(t.tt),
            "jupiter_pole_pa_deg": c.Num(math.degrees(float(ev["pa"][0])) % 360.0, 6),
            "jupiter_radius_arcsec": c.Num(float(ev["a"][0]) * 180.0 / math.pi * 3600.0, 5),
            "sub_earth_lat_deg": c.Num(math.degrees(float(ev["d_e"][0])), 6),
            "moons": moons,
        })
        print("  positions", jd_to_iso(t.tt))

    events = []
    for (start, end) in GALILEAN_EVENT_WINDOWS:
        t0, t1 = ts.utc(*start), ts.utc(*end)
        kstart = tuple(int(v) for v in ts.tt_jd(t0.tt - 1.5).tt_calendar()[:3])
        kend = tuple(int(v) for v in ts.tt_jd(t1.tt + 1.5).tt_calendar()[:3])
        kpath = jup365_excerpt(kstart, kend)
        excerpts.append(os.path.basename(kpath))
        js = JupiterSystem(ts, eph, kpath)
        for name, _ in MOONS:
            for kind in ("transit", "occultation", "eclipse", "shadow_transit"):
                def f(t, name=name, kind=kind):
                    fl, _ = js.flags(t, name)
                    return fl[kind].astype(int)

                f.step_days = 1.0 / 720.0
                times, values = find_discrete(t0, t1, f, epsilon=0.05 / 86400.0)
                for tv, v in zip(times, values):
                    events.append(c.Inline({
                        "moon": name, "kind": kind, "edge": "start" if v == 1 else "end",
                        "jd_tt": c.jd(tv.tt), "jd_utc": c.jd(c.jd_utc_of(tv)),
                        "utc": tv.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
                    }))
        print("  events", start, end, len(events))
    events.sort(key=lambda r: r.o["jd_tt"].v)
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": TOOL,
            "description": (
                "Io, Europa, Ganymede and Callisto seen from the Earth's centre, relative to "
                "Jupiter's centre, from Skyfield with JPL's jup365 satellite ephemeris "
                "(excerpts) on DE440; and the starts and ends of their transits, occultations, "
                "eclipses and shadow transits over two 20-day windows of 2026."
            ),
            "generated_utc": c.generated_utc(),
            "versions": c.versions(),
            "ephemerides": {
                "planets": c.file_facts(DE440_FILE, DE440_URL),
                "satellites": {"url": JUP365_URL, "excerpts": sorted(set(excerpts)),
                               "cut_with": "python -m jplephem excerpt --targets 501,502,503,504,599"},
            },
            "definitions": {
                "offsets": (
                    "gnomonic east/north offsets of the moon's apparent geocentric direction "
                    "(light-time, aberration, deflection: observe().apparent()) from Jupiter's "
                    "centre (599), in the true equator and equinox of date"
                ),
                "x_y": (
                    "the offsets rotated so y points to the projection of Jupiter's IAU 2015 "
                    "north pole (evaluated at Jupiter's light-time instant) and x is positive "
                    "to the west, divided by Jupiter's apparent equatorial radius asin(71492 km "
                    "/ distance)"
                ),
                "depth_km": "the moon's position minus Jupiter's, projected on the line of sight (astrometric); positive = farther than Jupiter",
                "disc": (
                    "an ellipse of semi-axes a = asin(71492 km / distance) and a sqrt(1 - e^2 "
                    "cos^2 D), e^2 = 1 - (66854/71492)^2, D the planetocentric latitude of the "
                    "viewer; the moon's centre inside it"
                ),
                "transit_occultation": "moon centre inside the Earth-view disc, in front of / behind Jupiter's centre",
                "eclipse": (
                    "at the moon's own light-time instant: the ray from the Sun's centre to the "
                    "moon passes inside Jupiter's disc as seen from the Sun, Jupiter taken when "
                    "the ray passed it, the moon beyond Jupiter"
                ),
                "shadow_transit": (
                    "at Jupiter's light-time instant: the ray from the Sun's centre past the "
                    "moon (taken when the ray passed it) meets Jupiter's disc as seen from the "
                    "Sun, the moon between the Sun and Jupiter"
                ),
                "time": "jd_tt is TT; jd_utc from Skyfield's UTC (builtin leap seconds)",
            },
            "never_a_runtime_dependency": NEVER,
        },
        "positions": positions,
        "events": events,
    }
    c.write_json(path, doc)


# ---------------------------------------------------------------------------
# Part 3: transits of Mercury and Venus (NASA, Espenak)
# ---------------------------------------------------------------------------

NASA_TRANSIT = "https://eclipse.gsfc.nasa.gov/transit"
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def calendar_to_jd(year, month, day, hour=0.0):
    """Julian date of a civil date: Julian calendar before 1582-10-15, Gregorian from it
    (NASA's catalogues' convention); astronomical year numbering."""
    y, m = year, month
    if m <= 2:
        y -= 1
        m += 12
    gregorian = (year, month, day) >= (1582, 10, 15)
    b = 0
    if gregorian:
        a = math.floor(y / 100)
        b = 2 - a + math.floor(a / 4)
    return (math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + day + b
            - 1524.5 + hour / 24.0)


def nasa_delta_t(y):
    """NASA's polynomial expressions for Delta-T (Espenak & Meeus, the Five Millennium
    Canon), seconds, for a decimal year. Used only to put an approximate TT beside the
    transit catalogues' UT (their own Delta-T is Stephenson 1997 before 1600, observed
    values to 2003, extrapolated after)."""
    if y < -500:
        u = (y - 1820) / 100
        return -20 + 32 * u * u
    if y < 500:
        u = y / 100
        return (10583.6 - 1014.41 * u + 33.78311 * u**2 - 5.952053 * u**3
                - 0.1798452 * u**4 + 0.022174192 * u**5 + 0.0090316521 * u**6)
    if y < 1600:
        u = (y - 1000) / 100
        return (1574.2 - 556.01 * u + 71.23472 * u**2 + 0.319781 * u**3
                - 0.8503463 * u**4 - 0.005050998 * u**5 + 0.0083572073 * u**6)
    if y < 1700:
        t = y - 1600
        return 120 - 0.9808 * t - 0.01532 * t**2 + t**3 / 7129
    if y < 1800:
        t = y - 1700
        return 8.83 + 0.1603 * t - 0.0059285 * t**2 + 0.00013336 * t**3 - t**4 / 1174000
    if y < 1860:
        t = y - 1800
        return (13.72 - 0.332447 * t + 0.0068612 * t**2 + 0.0041116 * t**3 - 0.00037436 * t**4
                + 0.0000121272 * t**5 - 0.0000001699 * t**6 + 0.000000000875 * t**7)
    if y < 1900:
        t = y - 1860
        return 7.62 + 0.5737 * t - 0.251754 * t**2 + 0.01680668 * t**3 - 0.0004473624 * t**4 + t**5 / 233174
    if y < 1920:
        t = y - 1900
        return -2.79 + 1.494119 * t - 0.0598939 * t**2 + 0.0061966 * t**3 - 0.000197 * t**4
    if y < 1941:
        t = y - 1920
        return 21.20 + 0.84493 * t - 0.076100 * t**2 + 0.0020936 * t**3
    if y < 1961:
        t = y - 1950
        return 29.07 + 0.407 * t - t**2 / 233 + t**3 / 2547
    if y < 1986:
        t = y - 1975
        return 45.45 + 1.067 * t - t**2 / 260 - t**3 / 718
    if y < 2005:
        t = y - 2000
        return (63.86 + 0.3345 * t - 0.060374 * t**2 + 0.0017275 * t**3 + 0.000651814 * t**4
                + 0.00002373599 * t**5)
    if y < 2050:
        t = y - 2000
        return 62.92 + 0.32217 * t + 0.005589 * t**2
    if y < 2150:
        return -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y)
    u = (y - 1820) / 100
    return -20 + 32 * u * u


def _hm(tok):
    if tok.strip() in ("-", "--", ""):
        return None
    h, m = tok.split(":")
    return int(h) + int(m) / 60.0


def parse_catalogue(text, planet):
    rows = []
    t = re.sub(r"<[^>]+>", "", text)
    t = _html.unescape(t)
    pat = re.compile(
        r"^\s*(-?\d{4})\s+([A-Z][a-z]{2})\s+(\d{2})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)"
        r"\s+([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+(\d+)\s*$")
    for ln in t.splitlines():
        m = pat.match(ln)
        if not m:
            continue
        year, mon, day = int(m.group(1)), MONTHS[m.group(2)], int(m.group(3))
        greatest_h = _hm(m.group(6))
        jd_g = calendar_to_jd(year, mon, day, greatest_h)
        contacts = {}
        for key, tok in (("c1", m.group(4)), ("c2", m.group(5)), ("c3", m.group(7)), ("c4", m.group(8))):
            h = _hm(tok)
            if h is None:
                contacts[key] = None
                continue
            day0 = calendar_to_jd(year, mon, day, 0.0)
            best = min((day0 + dd + h / 24.0 for dd in (-1, 0, 1)), key=lambda j: abs(j - jd_g))
            contacts[key] = best
        dec_year = year + (mon - 0.5) / 12.0
        dt = nasa_delta_t(dec_year)
        row = {
            "planet": planet,
            "date": "%s %s %02d" % (m.group(1), m.group(2), day),
            "calendar": "gregorian" if (year, mon, day) >= (1582, 10, 15) else "julian",
            "greatest_jd_ut": c.jd(jd_g),
            "min_separation_arcsec": c.Num(float(m.group(9)), 1),
            "sun_ra_hours": c.Num(float(m.group(10)), 3),
            "sun_dec_deg": c.Num(float(m.group(11)), 2),
            "series": int(m.group(13)),
            "nasa_polynomial_delta_t_s": c.Num(dt, 1),
        }
        for key in ("c1", "c2", "c3", "c4"):
            row[key + "_jd_ut"] = None if contacts[key] is None else c.jd(contacts[key])
        rows.append(c.Inline(row))
    return rows


# The geocentric contacts of 2004 and 2012 to the second, with position angles, from
# Espenak's articles in the RASC Observer's Handbook (reproduced on NASA's pages).
GEOCENTRIC_TO_THE_SECOND = [
    {
        "id": "2004-06-08-venus", "source": NASA_TRANSIT.replace("/transit", "/OH/transit04.html"),
        "date": (2004, 6, 8), "min_separation_arcsec": 627.0,
        "contacts": [("c1", (2004, 6, 8, 5, 13, 29), 116), ("c2", (2004, 6, 8, 5, 32, 55), 119),
                     ("greatest", (2004, 6, 8, 8, 19, 44), 166), ("c3", (2004, 6, 8, 11, 6, 33), 213),
                     ("c4", (2004, 6, 8, 11, 25, 59), 216)],
    },
    {
        "id": "2012-06-06-venus", "source": NASA_TRANSIT.replace("/transit", "/OH/transit12.html"),
        "date": (2012, 6, 6), "min_separation_arcsec": 554.0,
        "contacts": [("c1", (2012, 6, 5, 22, 9, 38), 41), ("c2", (2012, 6, 5, 22, 27, 34), 38),
                     ("greatest", (2012, 6, 6, 1, 29, 36), 345), ("c3", (2012, 6, 6, 4, 31, 39), 293),
                     ("c4", (2012, 6, 6, 4, 49, 35), 290)],
    },
]

# Cities from NASA's local-circumstance tables: coordinates are city centres (the
# tables do not print theirs; a contact moves by under 0.07 s per km of site).
CITIES_2004 = [
    ("Brussels", 50.8503, 4.3517, "city-EU1"), ("Wien (Vienna)", 48.2082, 16.3738, "city-EU1"),
    ("Helsinki", 60.1699, 24.9384, "city-EU1"), ("Paris", 48.8566, 2.3522, "city-EU1"),
    ("Athens", 37.9838, 23.7275, "city-EU2"), ("Cairo", 30.0444, 31.2357, "city-AFR"),
    ("Nairobi", -1.2921, 36.8219, "city-AFR"), ("Johannesburg", -26.2041, 28.0473, "city-AFR"),
    ("Beijing (Peking)", 39.9042, 116.4074, "city-EAS"), ("Tokyo", 35.6895, 139.6917, "city-EAS"),
    ("New Delhi", 28.6139, 77.2090, "city-CAS"), ("Washington", 38.9072, -77.0369, "city-USA1"),
    ("Boston", 42.3601, -71.0589, "city-USA1"),
]
CITIES_2012 = [
    ("Tokyo", 35.6895, 139.6917, "TOV2012-Tab04"), ("Beijing", 39.9042, 116.4074, "TOV2012-Tab04"),
    ("Sydney", -33.8688, 151.2093, "TOV2012-Tab04"), ("Moscow", 55.7558, 37.6173, "TOV2012-Tab04"),
    ("Manila", 14.5995, 120.9842, "TOV2012-Tab04"), ("Bombay", 19.0760, 72.8777, "TOV2012-Tab04"),
    ("Honolulu, HI", 21.3069, -157.8583, "TOV2012-Tab03"), ("Anchorage, AK", 61.2181, -149.9003, "TOV2012-Tab03"),
    ("Philadelphia, PA", 39.9526, -75.1652, "TOV2012-Tab03"), ("Seattle, WA", 47.6062, -122.3321, "TOV2012-Tab03"),
    ("Denver, CO", 39.7392, -104.9903, "TOV2012-Tab03"),
]


def _city_line(text, name):
    for ln in text.splitlines():
        if ln.strip().startswith(name) and re.search(r"\d\d:\d\d", ln):
            return ln
    raise RuntimeError("no line for %s" % name)


def _hms_tokens(rest):
    """Five (time, altitude) pairs from the tail of a table line; '--' when absent."""
    toks = rest.split()
    out = []
    i = 0
    while i < len(toks) and len(out) < 5:
        t = toks[i]
        if t.startswith("--"):
            out.append((None, None))
            i += 2
        elif re.match(r"\d\d:\d\d:\d\d", t):
            alt = int(toks[i + 1]) if i + 1 < len(toks) and re.match(r"-?\d+$", toks[i + 1]) else None
            out.append((t, alt))
            i += 2
        else:
            i += 1
    return out


def build_transits(offline):
    path = os.path.join(FIXTURES, "planetdetail_transits.json")
    if offline and os.path.exists(path):
        print("keeping", os.path.relpath(path, c.REPO))
        return
    sources = []

    def get(url):
        raw = fetch(url)
        sources.append({"url": url, "sha256": sha256(raw), "bytes": len(raw)})
        return raw

    catalogue = []
    for planet, name in (("Venus", "VenusCatalog"), ("Mercury", "MercuryCatalog")):
        raw = get("%s/catalog/%s.html" % (NASA_TRANSIT, name))
        rows = parse_catalogue(raw.decode("latin-1"), planet)
        print("  %s catalogue: %d transits" % (planet, len(rows)))
        catalogue += rows

    to_the_second = []
    for t in GEOCENTRIC_TO_THE_SECOND:
        get(t["source"])
        contacts = []
        for kind, (y, mo, d, h, mi, s), pa in t["contacts"]:
            contacts.append(c.Inline({"kind": kind, "jd_ut": c.jd(calendar_to_jd(y, mo, d, h + mi / 60 + s / 3600)),
                                      "position_angle_deg": pa}))
        to_the_second.append({"id": t["id"], "source": t["source"],
                              "min_separation_arcsec": c.Num(t["min_separation_arcsec"], 1),
                              "contacts": contacts})

    cities = []
    pages = {}
    for name, lat, lon, page in CITIES_2004:
        if page not in pages:
            raw = get("%s/TV2004/%s.html" % (NASA_TRANSIT, page))
            pages[page] = _html.unescape(re.sub(r"<[^>]+>", "", raw.decode("latin-1")))
        ln = _city_line(pages[page], name)
        # Columns after the name: sunrise and sunset (h:m), then the five contacts.
        toks = ln[len(name):].split()
        pairs = _hms_tokens(" ".join(toks[2:]))
        cities.append(city_row("2004-06-08-venus", name, lat, lon, page, (2004, 6, 8), pairs, 0.0))
    geo_2012 = [calendar_to_jd(2012, 6, 5, 22 + 9 / 60), calendar_to_jd(2012, 6, 5, 22 + 27 / 60),
                calendar_to_jd(2012, 6, 6, 1 + 29 / 60), calendar_to_jd(2012, 6, 6, 4 + 31 / 60),
                calendar_to_jd(2012, 6, 6, 4 + 49 / 60)]
    for name, lat, lon, page in CITIES_2012:
        if page not in pages:
            raw = get("https://eclipse.gsfc.nasa.gov/OH/tran/%s.pdf" % page)
            tmp = os.path.join(DATA_PD, page + ".pdf")
            os.makedirs(DATA_PD, exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(raw)
            pages[page] = subprocess.run(["pdftotext", "-layout", tmp, "-"], check=True,
                                         capture_output=True).stdout.decode("utf-8")
        ln = _city_line(pages[page], name)
        pairs = _hms_tokens(ln.strip()[len(name):])
        # Local times: infer the zone offset (to the half hour) from the geocentric times.
        offs = []
        for k, (tm, _) in enumerate(pairs):
            if tm is None:
                continue
            h, mi, s = (int(v) for v in tm.split(":"))
            local_h = h + mi / 60 + s / 3600
            geo_h = ((geo_2012[k] + 0.5) % 1.0) * 24.0
            offs.append(round(((local_h - geo_h + 12.0) % 24.0 - 12.0) * 2) / 2)
        offset = max(set(offs), key=offs.count)
        cities.append(city_row("2012-06-06-venus", name, lat, lon, page, None, pairs, offset,
                               geo=geo_2012))
    print("  cities:", len(cities))
    skyfield_rows = skyfield_transits(catalogue)
    print("  Skyfield contacts:", len(skyfield_rows))

    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": TOOL,
            "description": (
                "Transits of Venus (2000 BCE-4000 CE) and Mercury (1601-2300 CE) from NASA's "
                "catalogues by Fred Espenak (geocentric UT to the minute, least separation "
                "to 0.1\"), the 2004 and 2012 transits' geocentric contacts to the second with "
                "their position angles, and local contact times with the Sun's altitude for "
                "named cities from NASA's tables of 2004 (UT) and 2012 (local time, "
                "converted with the zone offset inferred to the half hour)."
            ),
            "generated_utc": c.generated_utc(),
            "retrieved": c.generated_utc()[:10],
            "sources": sources,
            "licence": (
                "U.S. Government work (NASA GSFC). The pages grant reproduction with the "
                "acknowledgment \"Transit Predictions by Fred Espenak, NASA/GSFC\"."
            ),
            "conventions": {
                "time": (
                    "jd_ut: the catalogues' Universal Time, Julian calendar before 1582-10-15 "
                    "as the catalogue prints it, converted to a Julian date. Espenak's Delta-T "
                    "is Stephenson (1997) before 1600, observed values to 2003 and an "
                    "extrapolation after; nasa_polynomial_delta_t_s is NASA's later polynomial "
                    "(Espenak & Meeus 2006), recorded only as an approximate TT for epochs far "
                    "from today."
                ),
                "contacts": "I and IV external, II and III internal tangency of the discs seen from the Earth's centre; greatest = least separation",
                "cities": (
                    "coordinates are city centres chosen for this fixture (the tables do not "
                    "print theirs); a contact moves by at most 0.07 s per km of site. Height 0."
                ),
                "sun_alt_deg": "the tables' whole-degree solar altitude at each contact",
            },
            "never_a_runtime_dependency": NEVER,
        },
        "catalogue": catalogue,
        "geocentric_to_the_second": to_the_second,
        "cities": cities,
        "skyfield": skyfield_rows,
    }
    c.write_json(path, doc)


def skyfield_transits(catalogue):
    """Geocentric contacts of the catalogued transits inside DE440s's span, from Skyfield
    with exactly the definitions of CONVENTIONS 13.10: apparent geocentric places, the
    Sun's semidiameter 959.63" at 1 au, the planet's IAU 2015 equatorial radius."""
    from skyfield.api import load_file
    from skyfield.searchlib import find_minima

    ts = c.load_timescale()
    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    earth, sun = eph["earth"], eph["sun"]
    radius = {"Mercury": 2440.53, "Venus": 6051.8}
    rows = []
    for r in catalogue:
        row = r.o
        jd_g = row["greatest_jd_ut"].v
        if not 2396758.5 + 400 < jd_g < 2506331.5 - 400:
            continue
        planet = eph[row["planet"].lower()]

        def geo(t):
            e = earth.at(t)
            p = e.observe(planet).apparent()
            s = e.observe(sun).apparent()
            sep = p.separation_from(s).arcseconds()
            sd_s = c.SUN_SEMIDIAMETER_ARCSEC_AT_1AU / s.distance().au
            sd_p = np.degrees(np.arcsin(radius[row["planet"]] / p.distance().km)) * 3600.0
            return sep, sd_s, sd_p

        t0 = ts.tt_jd(jd_g - 0.3)
        t1 = ts.tt_jd(jd_g + 0.3)

        def sep_only(t):
            return geo(t)[0]

        sep_only.step_days = 0.01
        tm, _ = find_minima(t0, t1, sep_only, epsilon=0.01 / 86400.0)
        tm = tm[0]
        out = {"planet": row["planet"], "date": row["date"], "greatest_jd_tt": c.jd(tm.tt),
               "min_separation_arcsec": c.Num(float(geo(tm)[0]), 4)}
        for name, sign, lo, hi in (("c1", 1, tm.tt - 0.4, tm.tt), ("c2", -1, tm.tt - 0.4, tm.tt),
                                   ("c3", -1, tm.tt, tm.tt + 0.4), ("c4", 1, tm.tt, tm.tt + 0.4)):
            def f(jd, sign=sign):
                sep, sd_s, sd_p = geo(ts.tt_jd(jd))
                return float(sep - (sd_s + sign * sd_p))
            a_, b_ = lo, hi
            fa, fb = f(a_), f(b_)
            if fa * fb > 0:
                out[name + "_jd_tt"] = None
                continue
            for _ in range(60):
                m = 0.5 * (a_ + b_)
                fm = f(m)
                if fa * fm <= 0:
                    b_, fb = m, fm
                else:
                    a_, fa = m, fm
            out[name + "_jd_tt"] = c.jd(0.5 * (a_ + b_))
        rows.append(c.Inline(out))
    return rows


def city_row(transit_id, name, lat, lon, page, date, pairs, offset_h, geo=None):
    kinds = ["c1", "c2", "greatest", "c3", "c4"]
    out = {"transit": transit_id, "city": name, "lat_deg": c.Num(lat, 4), "lon_deg": c.Num(lon, 4),
           "table": page, "utc_offset_hours": c.Num(offset_h, 1)}
    events = []
    for k, (tm, alt) in enumerate(pairs):
        if tm is None:
            continue
        h, mi, s = (int(v) for v in tm.split(":"))
        ut_h = h + mi / 60 + s / 3600 - offset_h
        if geo is None:
            y, mo, d = date
            jd = calendar_to_jd(y, mo, d, ut_h)
        else:
            base = math.floor(geo[k] - 0.5) + 0.5
            jd = min((base + dd + ut_h / 24.0 for dd in (-1, 0, 1)), key=lambda j: abs(j - geo[k]))
        events.append(c.Inline({"kind": kinds[k], "jd_ut": c.jd(jd), "sun_alt_deg": alt}))
    out["contacts"] = events
    return out


# ---------------------------------------------------------------------------
# Part 4: conjunctions and stations (Skyfield + DE440s)
# ---------------------------------------------------------------------------

PLANET_KEYS = [
    ("Mercury", "mercury"), ("Venus", "venus"), ("Mars", "mars barycenter"),
    ("Jupiter", "jupiter barycenter"), ("Saturn", "saturn barycenter"),
    ("Uranus", "uranus barycenter"), ("Neptune", "neptune barycenter"),
]
CONJ_STARS = ["Aldebaran", "Regulus", "Spica", "Antares"]
CONJ_MAX_SEP_DEG = 6.0


def build_conjunctions(offline):
    from skyfield.api import Star, load_file
    from skyfield.framelib import ecliptic_frame
    from skyfield.searchlib import find_discrete, find_minima

    path = os.path.join(FIXTURES, "planetdetail_conjunctions.json")
    ts = c.load_timescale()
    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    earth, sun, moon = eph["earth"], eph["sun"], eph["moon"]
    hip = c.load_hipparcos_frame()
    stars = {}
    for name, hipno, *_ in c.NAV_STARS:
        if name in CONJ_STARS:
            stars[name] = Star.from_dataframe(hip.loc[hipno])
    bodies = {name: eph[key] for name, key in PLANET_KEYS}

    def pos(t, obj):
        return earth.at(t).observe(obj).apparent()

    rows = []

    def search(name_a, a, name_b, b, t0, t1, step, kind):
        def sep(t):
            return pos(t, a).separation_from(pos(t, b)).degrees

        sep.step_days = step
        times, values = find_minima(t0, t1, sep, epsilon=1.0 / 86400.0)
        # find_minima can return one flat minimum several times, a few seconds apart
        # (Uranus against Aldebaran): keep the lowest of any within half a day.
        keep = []
        for t, v in zip(times, values):
            if keep and t.tt - keep[-1][0].tt < 0.5:
                if v < keep[-1][1]:
                    keep[-1] = (t, v)
                continue
            keep.append((t, v))
        for t, v in keep:
            if v > CONJ_MAX_SEP_DEG or t.tt - t0.tt < 2 * step or t1.tt - t.tt < 2 * step:
                continue
            pa_ = pos(t, a)
            pb_ = pos(t, b)
            ra_a, dec_a, _ = pa_.radec(epoch="date")
            ra_b, dec_b, _ = pb_.radec(epoch="date")
            # Position angle of A seen from B, north through east (of date).
            da = ra_a.radians - ra_b.radians
            pa = math.degrees(math.atan2(
                math.sin(da) * math.cos(dec_a.radians),
                math.cos(dec_b.radians) * math.sin(dec_a.radians)
                - math.sin(dec_b.radians) * math.cos(dec_a.radians) * math.cos(da))) % 360.0
            rows.append(c.Inline([name_a, name_b, c.jd(t.tt), c.Num(float(v), 6), c.Num(pa, 3)]))

    # Planet-planet and planet-star over 1990-2060; the Moon over 2020-2030.
    t0, t1 = ts.utc(1990, 1, 1), ts.utc(2061, 1, 1)
    names = [n for n, _ in PLANET_KEYS]
    for i, na in enumerate(names):
        for nb in names[i + 1:]:
            step = 0.5 if "Mercury" in (na, nb) else 1.0
            search(na, bodies[na], nb, bodies[nb], t0, t1, step, "planet_planet")
        for ns in CONJ_STARS:
            search(na, bodies[na], ns, stars[ns], t0, t1, 0.5 if na == "Mercury" else 1.0, "planet_star")
        print("  planet", na, len(rows))
    m0, m1 = ts.utc(2020, 1, 1), ts.utc(2031, 1, 1)
    for na in names:
        search("Moon", moon, na, bodies[na], m0, m1, 0.1, "moon_planet")
    for ns in CONJ_STARS:
        search("Moon", moon, ns, stars[ns], m0, m1, 0.1, "moon_star")
    print("  moon", len(rows))
    rows.sort(key=lambda r: r.o[2].v)

    stations = []
    for name, key in PLANET_KEYS:
        target = eph[key]
        step = {"Mercury": 2.0, "Venus": 5.0, "Mars": 5.0}.get(name, 10.0)
        h = 0.01
        for coord in ("ecliptic_longitude", "right_ascension"):
            def angle_of(t):
                p = pos(t, target)
                if coord == "ecliptic_longitude":
                    return p.frame_latlon(ecliptic_frame)[1].degrees
                return p.radec(epoch="date")[0]._degrees

            def direct(t):
                a = angle_of(ts.tt_jd(t.tt - h))
                b = angle_of(ts.tt_jd(t.tt + h))
                return (((b - a + 540.0) % 360.0) - 180.0 > 0).astype(int)

            direct.step_days = step
            times, values = find_discrete(t0, t1, direct, epsilon=1.0 / 86400.0)
            for t, v in zip(times, values):
                stations.append(c.Inline([
                    name, coord, "retrograde_ends" if v == 1 else "retrograde_begins",
                    c.jd(t.tt), c.Num(float(angle_of(t)) % 360.0, 6),
                ]))
        print("  stations", name, len(stations))
    stations.sort(key=lambda r: r.o[3].v)
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": TOOL,
            "description": (
                "Closest approaches in apparent geocentric separation (every local minimum "
                "under %.0f degrees) of planet pairs and of the planets with Aldebaran, "
                "Regulus, Spica and Antares over 1990-2060, of the Moon with the planets and "
                "those stars over 2020-2030; and the stations of Mercury to Neptune in "
                "apparent ecliptic longitude (true ecliptic and equinox of date) and in "
                "right ascension of date over 1990-2060. Skyfield + JPL DE440s; the stars "
                "from Hipparcos." % CONJ_MAX_SEP_DEG
            ),
            "generated_utc": c.generated_utc(),
            "versions": c.versions(),
            "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
            "definitions": {
                "separation": "earth.at(t).observe(X).apparent() for both bodies, separation_from",
                "position_angle": "of `body` seen from `other`, from north through east, true equator of date",
                "stations": (
                    "the sign change of the rate of the apparent longitude (or RA) of date, "
                    "the rate a central difference over +/-0.01 day; retrograde_begins when "
                    "the rate turns negative"
                ),
                "time": "jd_tt: TT",
            },
            "never_a_runtime_dependency": NEVER,
        },
        "conjunction_columns": ["body", "other", "jd_tt", "separation_deg", "position_angle_deg"],
        "conjunctions": rows,
        "station_columns": ["body", "coordinate", "kind", "jd_tt", "angle_deg"],
        "stations": stations,
    }
    c.write_json(path, doc)


# ---------------------------------------------------------------------------
# Part 5: the Earth's perihelion and aphelion
# ---------------------------------------------------------------------------

USNO_SEASONS = "https://aa.usno.navy.mil/api/seasons?year=%d"

# Meeus, Astronomical Algorithms (2nd ed.), table 38.C: the Earth's (not the Earth-Moon
# barycentre's) passages through perihelion and aphelion computed with the complete
# VSOP87, 1991-2010, TD hours and radius vector (as transcribed and tested in the MIT
# licensed soniakeys/meeus, perihelion/pp_test.go).
MEEUS_38C_PERIHELION = [
    (1991, 1, 3, 3.00, .983281), (1992, 1, 3, 15.06, .983324), (1993, 1, 4, 3.08, .983283),
    (1994, 1, 2, 5.92, .983301), (1995, 1, 4, 11.10, .983302), (1996, 1, 4, 7.43, .983223),
    (1997, 1, 1, 23.29, .983267), (1998, 1, 4, 21.27, .983300), (1999, 1, 3, 13.02, .983281),
    (2000, 1, 3, 5.31, .983321), (2001, 1, 4, 8.89, .983286), (2002, 1, 2, 14.17, .983290),
    (2003, 1, 4, 5.04, .983320), (2004, 1, 4, 17.72, .983265), (2005, 1, 2, 0.61, .983297),
    (2006, 1, 4, 15.52, .983327), (2007, 1, 3, 19.74, .983260), (2008, 1, 2, 23.87, .983280),
    (2009, 1, 4, 15.51, .983273), (2010, 1, 3, 0.18, .983290),
]
MEEUS_38C_APHELION = [
    (1991, 7, 6, 15.46, 1.016703), (1992, 7, 3, 12.14, 1.016740), (1993, 7, 4, 22.37, 1.016666),
    (1994, 7, 5, 19.30, 1.016724), (1995, 7, 4, 2.29, 1.016742), (1996, 7, 5, 19.02, 1.016717),
    (1997, 7, 4, 19.34, 1.016754), (1998, 7, 3, 23.86, 1.016696), (1999, 7, 6, 22.86, 1.016718),
    (2000, 7, 3, 23.84, 1.016741), (2001, 7, 4, 13.65, 1.016643), (2002, 7, 6, 3.80, 1.016688),
    (2003, 7, 4, 5.67, 1.016728), (2004, 7, 5, 10.90, 1.016694), (2005, 7, 5, 4.98, 1.016742),
    (2006, 7, 3, 23.18, 1.016697), (2007, 7, 6, 23.89, 1.016706), (2008, 7, 4, 7.71, 1.016754),
    (2009, 7, 4, 1.69, 1.016666), (2010, 7, 6, 11.52, 1.016702),
]


def build_apsides(offline):
    from skyfield.api import load_file
    from skyfield.searchlib import find_maxima, find_minima

    path = os.path.join(FIXTURES, "planetdetail_apsides.json")
    usno = []
    sources = []
    if offline and os.path.exists(path):
        old = json.load(open(path))
        usno = [c.Inline({k: (c.jd(v) if k == "jd_ut" else v) for k, v in r.items()}) for r in old["usno"]]
        sources = old["generator"]["sources"]
    else:
        for year in range(1990, 2061):
            raw = fetch(USNO_SEASONS % year)
            sources.append({"url": USNO_SEASONS % year, "sha256": sha256(raw), "bytes": len(raw)})
            for d in json.loads(raw)["data"]:
                if d["phenom"] not in ("Perihelion", "Aphelion"):
                    continue
                hh, mm = (int(v) for v in d["time"].split(":"))
                jd = calendar_to_jd(d["year"], d["month"], d["day"], hh + mm / 60.0)
                usno.append(c.Inline({"kind": d["phenom"].lower(), "year": d["year"],
                                      "jd_ut": c.jd(jd), "time": "%04d-%02d-%02dT%s" % (
                                          d["year"], d["month"], d["day"], d["time"])}))
            time.sleep(0.2)
    ts = c.load_timescale()
    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    earth, sun = eph["earth"], eph["sun"]

    def dist(t):
        return (earth.at(t) - sun.at(t)).distance().au

    dist.step_days = 5.0
    t0, t1 = ts.utc(1989, 12, 1), ts.utc(2061, 2, 1)
    sky = []
    for kind, fn in (("perihelion", find_minima), ("aphelion", find_maxima)):
        times, values = fn(t0, t1, dist, epsilon=1.0 / 86400.0)
        for t, v in zip(times, values):
            sky.append(c.Inline({"kind": kind, "jd_tt": c.jd(t.tt), "jd_utc": c.jd(c.jd_utc_of(t)),
                                 "distance_au": c.Num(float(v), 10)}))
    sky.sort(key=lambda r: r.o["jd_tt"].v)
    meeus = []
    for kind, table in (("perihelion", MEEUS_38C_PERIHELION), ("aphelion", MEEUS_38C_APHELION)):
        for y, mo, d, h, r in table:
            meeus.append(c.Inline({"kind": kind, "jd_tt": c.jd(calendar_to_jd(y, mo, d, h)),
                                   "td_hours": c.Num(h, 2), "distance_au": c.Num(r, 6)}))
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": TOOL,
            "description": (
                "The Earth's perihelion and aphelion: USNO's seasons API 1990-2060 (UT to the "
                "minute), Meeus's table 38.C 1991-2010 (TD to 0.01 h, radius vector to 1e-6 "
                "au; computed by Meeus with the complete VSOP87) and Skyfield + DE440s "
                "(distance of the Earth's centre from the Sun's, 1990-2060)."
            ),
            "generated_utc": c.generated_utc(),
            "versions": c.versions(),
            "sources": sources,
            "meeus": "J. Meeus, Astronomical Algorithms, 2nd ed. (1998), table 38.C; values as transcribed in soniakeys/meeus (MIT)",
            "licence": "USNO API: U.S. Government work. Meeus: facts from a published table. DE440s: development-time reference.",
            "never_a_runtime_dependency": NEVER,
        },
        "usno": usno,
        "meeus_38c": meeus,
        "skyfield": sky,
    }
    c.write_json(path, doc)


# ---------------------------------------------------------------------------
# Part 6: orbits from MPC elements
# ---------------------------------------------------------------------------

MPCORB_URL = "https://minorplanetcenter.net/iau/MPCORB/MPCORB.DAT"
COMETELS_URL = "https://minorplanetcenter.net/iau/MPCORB/CometEls.txt"
ORBIT_ASTEROIDS = ["00001", "00004", "00433", "01566", "99942", "A1955"]
ORBIT_COMETS = ["2P/Encke", "12P/Pons-Brooks", "29P/Schwassmann-Wachmann", "C/2023 A3",
                "C/2024 G3", "C/1995 O1"]
ORBIT_OFFSETS_DAYS = [-60.0, 0.0, 30.0, 200.0]


def _mpcorb_line(number):
    """One numbered minor planet's MPCORB line, fetched by byte range (the file is 318
    MB; its numbered lines are 203 bytes each after a 43-line header)."""
    head = fetch_range(MPCORB_URL, 0, 4000)
    header_len = len(b"\n".join(head.split(b"\n")[:43])) + 1
    n = unpack_number(number)
    off = header_len + (n - 1) * 203
    chunk = fetch_range(MPCORB_URL, max(0, off - 2030), off + 2030)
    for ln in chunk.split(b"\n"):
        if ln.startswith(number.encode() + b" "):
            return ln.decode("ascii")
    raise RuntimeError("no MPCORB line for %s" % number)


def fetch_range(url, a, b):
    return subprocess.run(["curl", "-sS", "-f", "-m", "120", "-r", "%d-%d" % (a, b), url],
                          check=True, capture_output=True).stdout


def unpack_number(packed):
    first = packed[0]
    if first.isdigit():
        return int(packed)
    base = ord(first) - (ord("A") - 10) if first.isupper() else ord(first) - (ord("a") - 36)
    return base * 10000 + int(packed[1:])


def build_orbits(offline):
    from skyfield.api import load_file
    from skyfield.constants import GM_SUN_Pitjeva_2005_km3_s2 as GM_SUN
    from skyfield.data import mpc
    import io

    path = os.path.join(FIXTURES, "planetdetail_orbits.json")
    if offline and os.path.exists(path):
        old = json.load(open(path))
        asteroid_lines = old["mpcorb_lines"]
        comet_lines = old["comet_lines"]
        sources = old["generator"]["sources"]
    else:
        asteroid_lines = [_mpcorb_line(n) for n in ORBIT_ASTEROIDS]
        raw = fetch(COMETELS_URL)
        text = raw.decode("ascii", "replace")
        comet_lines = []
        for name in ORBIT_COMETS:
            ln = next(l for l in text.splitlines() if name in l[102:160])
            comet_lines.append(ln.rstrip())
        sources = [{"url": MPCORB_URL, "note": "six lines by HTTP byte range"},
                   {"url": COMETELS_URL, "sha256": sha256(raw), "bytes": len(raw)}]
    ts = c.load_timescale()
    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    earth, sun = eph["earth"], eph["sun"]
    cases = []
    adf = mpc.load_mpcorb_dataframe(io.BytesIO(("\n".join(asteroid_lines) + "\n").encode()))
    for i, ln in enumerate(asteroid_lines):
        row = adf.iloc[i]
        body = sun + mpc.mpcorb_orbit(row, ts, GM_SUN)
        epoch_jd = _packed_epoch_jd(row["epoch_packed"])
        cases.append(orbit_case(ts, earth, body, "mpcorb", ln, row["designation"], epoch_jd))
    cdf = mpc.load_comets_dataframe(io.BytesIO(("\n".join(comet_lines) + "\n").encode()))
    for i, ln in enumerate(comet_lines):
        row = cdf.iloc[i]
        body = sun + mpc.comet_orbit(row, ts, GM_SUN)
        # Comet lines carry an epoch (YYYYMMDD, columns 82-89) the two-body orbit ignores.
        e = ln[81:89]
        epoch_jd = calendar_to_jd(int(e[:4]), int(e[4:6]), int(e[6:8]), 0.0)
        cases.append(orbit_case(ts, earth, body, "mpc_comet", ln, row["designation"], epoch_jd))
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": TOOL,
            "description": (
                "Two-body positions of six minor planets (MPCORB lines) and six comets "
                "(CometEls.txt lines) from Skyfield's skyfield.data.mpc orbits (heliocentric "
                "Kepler orbits, GM_sun Pitjeva 2005), observed from the Earth with DE440s "
                "(light-time, aberration, deflection), apparent RA/Dec of date and distance, "
                "at the elements' epoch -60, 0, +30 and +200 days."
            ),
            "generated_utc": c.generated_utc(),
            "versions": c.versions(),
            "sources": sources,
            "licence": (
                "Source: Minor Planet Center (MPCORB.DAT, CometEls.txt). The MPC permits "
                "redistribution of these freely available files with the source clearly "
                "stated; twelve lines are kept here as test input."
            ),
            "never_a_runtime_dependency": NEVER,
        },
        "mpcorb_lines": asteroid_lines,
        "comet_lines": comet_lines,
        "cases": cases,
    }
    c.write_json(path, doc)


def _packed_epoch_jd(packed):
    century = {"I": 18, "J": 19, "K": 20}[packed[0]]
    year = century * 100 + int(packed[1:3])
    code = "123456789ABCDEFGHIJKLMNOPQRSTUV"
    month = code.index(packed[3]) + 1
    day = code.index(packed[4]) + 1
    return calendar_to_jd(year, month, day, 0.0)


def orbit_case(ts, earth, body, source, line, name, epoch_jd_tt):
    out = []
    for dd in ORBIT_OFFSETS_DAYS:
        t = ts.tt_jd(epoch_jd_tt + dd)
        a = earth.at(t).observe(body)
        ap = a.apparent()
        ra, dec, dist = ap.radec(epoch="date")
        out.append(c.Inline({"jd_tt": c.jd(t.tt), "ra_deg": c.deg(ra._degrees),
                             "dec_deg": c.deg(dec.degrees), "distance_au": c.Num(dist.au, 10),
                             "light_time_s": c.Num(float(a.light_time) * 86400.0, 4)}))
    return {"source": source, "name": name, "line": line, "epoch_jd_tt": c.jd(epoch_jd_tt),
            "positions": out}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

PARTS = ["horizons", "galilean", "transits", "conjunctions", "apsides", "orbits"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--part", choices=PARTS + ["all"], default="all")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    parts = PARTS if args.part == "all" else [args.part]
    for p in parts:
        print("[%s]" % p)
        globals()["build_" + p](args.offline)


if __name__ == "__main__":
    main()
