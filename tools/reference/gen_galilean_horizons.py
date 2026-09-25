"""fixtures/reference/galilean_horizons.json -- the Galilean moons against JPL, 1600-2200.

Development-time only (CONVENTIONS section 11; never regenerated from Rust output).
Written by the verify2 agent (2026-09-25) to measure Lieske's E5 theory, which the
engine uses for Jupiter's moons, across the whole span JPL's satellite ephemeris
reaches, not only near the present (planetdetail_galilean.json holds 15 instants of
1995-2058 and three far excerpts).

What it records: 400 instants in TT, seeded so the file is reproducible (240 spread over
1600-02-01 to 2199-11-01, the span of JPL's jup365 satellite ephemeris that Horizons
serves, and 160 more over 1990-2060), and at each the offset of Io, Europa, Ganymede and
Callisto from Jupiter's centre as the Earth's centre sees them: Horizons' apparent RA and
Dec of date (quantity 2: airless, the true equator and equinox of date), projected on
the gnomonic tangent plane at Jupiter's direction, east and north, arcseconds. That is
the definition of the engine's `offset_east_arcsec` and `offset_north_arcsec`
(`skyfix_almanac::satellites`, `planet_geometry::tangent_plane`).

    python3 -m tools.reference.gen_galilean_horizons      # needs the network (Horizons)

JPL Horizons: https://ssd.jpl.nasa.gov/api/horizons.api (NASA/JPL, U.S. Government
work). About 60 requests of 40 instants each; about two minutes.
"""

from __future__ import annotations

import json
import math
import os
import random
import time
import urllib.parse
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO, "fixtures", "reference", "galilean_horizons.json")
API = "https://ssd.jpl.nasa.gov/api/horizons.api"
MOONS = (("Io", "501"), ("Europa", "502"), ("Ganymede", "503"), ("Callisto", "504"))
RAD_TO_ARCSEC = 180.0 / math.pi * 3600.0


def jd_from_gregorian(y, m, d):
    a = (14 - m) // 12
    yy, mm = y + 4800 - a, m + 12 * a - 3
    return d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045 - 0.5


def epochs():
    rng = random.Random(20260925)
    wide = [rng.uniform(jd_from_gregorian(1600, 2, 1), jd_from_gregorian(2199, 11, 1)) for _ in range(240)]
    near = [rng.uniform(jd_from_gregorian(1990, 1, 1), jd_from_gregorian(2060, 12, 31)) for _ in range(160)]
    return sorted(round(j, 6) for j in wide + near)


def horizons(command, jds):
    """Apparent RA and Dec of date (degrees) of `command` from the geocentre at each TT JD."""
    out = []
    for i in range(0, len(jds), 40):
        chunk = jds[i : i + 40]
        q = {
            "format": "json",
            "COMMAND": f"'{command}'",
            "CENTER": "'500@399'",
            "MAKE_EPHEM": "'YES'",
            "EPHEM_TYPE": "'OBSERVER'",
            "TLIST": " ".join(f"'{j:.6f}'" for j in chunk),
            "TLIST_TYPE": "'JD'",
            "TIME_TYPE": "'TT'",
            "QUANTITIES": "'2'",
            "ANG_FORMAT": "'DEG'",
            "EXTRA_PREC": "'YES'",
            "CSV_FORMAT": "'YES'",
        }
        url = API + "?" + urllib.parse.urlencode(q, safe="'@")
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    txt = json.load(r)["result"]
                break
            except Exception:  # network trouble: back off and retry
                time.sleep(10 * (attempt + 1))
        else:
            raise RuntimeError(f"Horizons did not answer for {command}")
        if "$$SOE" not in txt:
            raise RuntimeError(txt[:2000])
        rows = txt.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
        if len(rows) != len(chunk):
            raise RuntimeError(f"{command}: {len(rows)} rows for {len(chunk)} instants")
        out += [(float(f.split(",")[3]), float(f.split(",")[4])) for f in rows]
    return out


def unit(ra_deg, dec_deg):
    r, d = math.radians(ra_deg), math.radians(dec_deg)
    return (math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d))


def tangent_plane(u, v):
    """Gnomonic (east, north) of direction v about direction u, radians."""
    e = (-u[1], u[0], 0.0)
    n_e = math.hypot(e[0], e[1])
    e = (e[0] / n_e, e[1] / n_e, 0.0)
    n = (u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0])
    w = sum(a * b for a, b in zip(u, v))
    return (sum(a * b for a, b in zip(v, e)) / w, sum(a * b for a, b in zip(v, n)) / w)


def main():
    jds = epochs()
    jupiter = horizons("599", jds)
    moons = {name: horizons(cmd, jds) for name, cmd in MOONS}
    cases = []
    for k, jd in enumerate(jds):
        uj = unit(*jupiter[k])
        offs = {}
        for name, _ in MOONS:
            e, n = tangent_plane(uj, unit(*moons[name][k]))
            offs[name] = [round(e * RAD_TO_ARCSEC, 4), round(n * RAD_TO_ARCSEC, 4)]
        cases.append({"jd_tt": jd, "offsets_arcsec": offs})
    doc = {
        "schema": "skyfix.reference/1",
        "generator": {
            "script": "tools/reference/gen_galilean_horizons.py",
            "source": "JPL Horizons API (ssd.jpl.nasa.gov/api/horizons.api), observer tables, "
            "quantity 2 (apparent RA and Dec of date, airless), centre 500@399, TT",
            "retrieved_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "licence": "NASA/JPL, U.S. Government work",
            "never_a_runtime_dependency": "Development-time reference. CONVENTIONS section 11: "
            "never regenerate a fixture from Rust output.",
            "definition": "offsets of each moon from Jupiter's centre, east and north on the "
            "gnomonic tangent plane at Jupiter's apparent direction of date, arcseconds",
        },
        "cases": cases,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print(f"wrote {OUT}: {len(cases)} instants")


if __name__ == "__main__":
    main()
