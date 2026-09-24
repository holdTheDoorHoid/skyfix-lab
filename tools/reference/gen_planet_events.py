"""fixtures/reference/planet_events_*.json — planet events reference (development-time only).

Two files, each independent of the Rust code:

* ``planet_events_skyfield.json`` — every opposition, conjunction with the Sun,
  greatest elongation (Mercury, Venus) and closest approach (a local minimum of the
  geocentric distance) of Mercury to Neptune in 1990-2060, from Skyfield + JPL DE440s:
  ``almanac.oppositions_conjunctions`` (apparent ecliptic longitude of date, planet
  minus Sun, through 0 or 180 degrees), and ``searchlib.find_maxima`` /
  ``find_minima`` on the apparent elongation and the apparent (light-time) distance.
  Inferior conjunctions carry whether the planet crosses the Sun's disc (least apparent
  separation within a day under the sum of the semidiameters; the Sun's 959.63" at
  1 au, the planet's IAU equatorial radius).
* ``planet_events_nasa_skycal.json`` — the same kinds of events (no perigees) from
  NASA's SKYCAL, "Sky Events Calendar by Fred Espenak and Sumit Dutta (NASA's GSFC)"
  (the acknowledgment the page asks for; a U.S. Government work),
  whose decade files ``jcYYYY.js`` list Julian dates of conjunctions, oppositions and
  greatest elongations. Parsed verbatim for 1990-2060. Needs network (``--offline``
  keeps the file already there; ``--network-only`` refreshes just this file).

Never regenerated from Rust output (CONVENTIONS section 11).

    tools/reference/.venv/bin/python -m tools.reference.gen_planet_events [--offline | --network-only]
"""

from __future__ import annotations

import argparse
import hashlib
import math
import os
import re
import subprocess

import numpy as np

from . import common as c

SKYCAL = "https://eclipse.gsfc.nasa.gov/SKYCAL"
DECADES = [1981, 1991, 2001, 2011, 2021, 2031, 2041, 2051]
SKYCAL_TYPES = {
    31: ("Mercury", "inferior_conjunction"),
    32: ("Venus", "inferior_conjunction"),
    33: ("Mercury", "superior_conjunction"),
    34: ("Venus", "superior_conjunction"),
    35: ("Mercury", "greatest_elongation_east"),
    36: ("Mercury", "greatest_elongation_west"),
    37: ("Venus", "greatest_elongation_east"),
    38: ("Venus", "greatest_elongation_west"),
    41: ("Mars", "opposition"),
    42: ("Jupiter", "opposition"),
    43: ("Saturn", "opposition"),
    44: ("Uranus", "opposition"),
    45: ("Neptune", "opposition"),
    46: ("Mars", "conjunction"),
    47: ("Jupiter", "conjunction"),
    48: ("Saturn", "conjunction"),
    49: ("Uranus", "conjunction"),
    50: ("Neptune", "conjunction"),
}

PLANETS = [
    ("Mercury", "mercury", 2440.53),
    ("Venus", "venus", 6051.8),
    ("Mars", "mars barycenter", 3396.19),
    ("Jupiter", "jupiter barycenter", 71492.0),
    ("Saturn", "saturn barycenter", 60268.0),
    ("Uranus", "uranus barycenter", 25559.0),
    ("Neptune", "neptune barycenter", 24764.0),
]

AU_KM = 149_597_870.700
ARCSEC = math.pi / 648000.0


def fetch(url):
    return subprocess.run(
        ["curl", "-sS", "-f", "-m", "120", "-L", url], check=True, capture_output=True
    ).stdout


# ---------------------------------------------------------------------------
# NASA SKYCAL
# ---------------------------------------------------------------------------


def build_skycal(ts):
    rows, sources = [], []
    lo = c.jd_utc_of(ts.utc(1990, 1, 1))
    hi = c.jd_utc_of(ts.utc(2061, 1, 1))
    for d in DECADES:
        url = "%s/jc%04d.js" % (SKYCAL, d)
        raw = fetch(url)
        sources.append({"url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        for m in re.finditer(r"new Array\(([0-9.]+),\s*([0-9]+),\s*(-?[0-9]+)\)", raw.decode("latin-1")):
            jd, typ, value = float(m.group(1)), int(m.group(2)), int(m.group(3))
            if typ not in SKYCAL_TYPES or not lo <= jd < hi:
                continue
            body, kind = SKYCAL_TYPES[typ]
            row = {"body": body, "kind": kind, "jd": c.Num(jd, 4), "type": typ}
            if kind.startswith("greatest_elongation"):
                row["elongation_deg"] = c.Num(abs(value) / 10.0, 1)
            rows.append(c.Inline(row))
    rows.sort(key=lambda r: r.o["jd"].v)
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/reference/gen_planet_events.py",
            "description": (
                "Conjunctions, oppositions and greatest elongations of Mercury to Neptune in "
                "1990-2060 from NASA's SKYCAL Sky Events Calendar decade files, parsed verbatim: "
                "the Julian date (4 decimals) and SKYCAL's type code; greatest elongations carry "
                "SKYCAL's elongation in tenths of a degree."
            ),
            "generated_utc": c.generated_utc(),
            "retrieved": c.generated_utc()[:10],
            "sources": sources,
            "licence": (
                "U.S. Government work (NASA Goddard Space Flight Center, eclipse.gsfc.nasa.gov, "
                "archived pages). The page grants reproduction with this acknowledgment: "
                "\"Sky Events Calendar by Fred Espenak and Sumit Dutta (NASA's GSFC)\"."
            ),
            "conventions": {
                "jd": (
                    "SKYCAL converts these Julian dates to a chosen zone's civil time, so they are "
                    "taken as UT; the comparison in tests/planet_events.rs measures what they are."
                ),
                "type_codes": "31-34 conjunctions of Mercury and Venus, 35-38 elongations, 41-45 oppositions, 46-50 conjunctions of Mars to Neptune",
            },
            "never_a_runtime_dependency": (
                "Development-time reference. CONVENTIONS section 11: never regenerate a fixture "
                "from Rust output."
            ),
        },
        "events": rows,
    }


# ---------------------------------------------------------------------------
# Skyfield + DE440s
# ---------------------------------------------------------------------------


def build_skyfield(ts):
    from skyfield import almanac
    from skyfield.api import load_file
    from skyfield.framelib import ecliptic_frame
    from skyfield.searchlib import find_maxima, find_minima

    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    earth, sun = eph["earth"], eph["sun"]
    t0, t1 = ts.utc(1990, 1, 1), ts.utc(2060, 12, 31, 23, 59, 59)
    events = []

    def state(t, target):
        e = earth.at(t)
        p = e.observe(target).apparent()
        s = e.observe(sun).apparent()
        lp = p.frame_latlon(ecliptic_frame)[1].degrees
        ls = s.frame_latlon(ecliptic_frame)[1].degrees
        return p, s, lp, ls

    for name, key, radius_km in PLANETS:
        target = eph[key]
        inner = name in ("Mercury", "Venus")

        def record(t, kind):
            p, s, lp, ls = state(t, target)
            elong = float(p.separation_from(s).degrees)
            row = {
                "body": name,
                "kind": kind,
                "jd_utc": c.jd(c.jd_utc_of(t)),
                "elongation_deg": c.Num(elong, 6),
                "distance_au": c.Num(float(p.distance().au), 9),
            }
            return row

        # Conjunctions and oppositions. The function's value is which half of the
        # circle the longitude difference is in, so for Mercury and Venus, which never
        # reach 180 degrees, every change is a conjunction (the value alternates with the
        # direction of crossing); inferior when the planet is nearer than the Sun.
        f = almanac.oppositions_conjunctions(eph, target)
        times, ys = almanac.find_discrete(t0, t1, f)
        for t, y in zip(times, ys):
            if inner:
                p, s, _, _ = state(t, target)
                kind = "inferior_conjunction" if p.distance().au < s.distance().au else "superior_conjunction"
            elif y == 1:
                kind = "opposition"
            else:
                kind = "conjunction"
            row = record(t, kind)
            if kind == "inferior_conjunction":
                row["transit"] = transit(ts, t, earth, sun, target, radius_km)
            events.append(c.Inline(row))

        # Greatest elongations.
        if inner:
            def elongation(t):
                e = earth.at(t)
                return e.observe(target).apparent().separation_from(e.observe(sun).apparent()).degrees

            elongation.step_days = 5.0
            times, _ = find_maxima(t0, t1, elongation, epsilon=1.0 / 86400.0)
            for t in times:
                _, _, lp, ls = state(t, target)
                east = ((lp - ls + 540.0) % 360.0) - 180.0 > 0
                events.append(c.Inline(record(t, "greatest_elongation_east" if east else "greatest_elongation_west")))

        # Closest approaches.
        def distance(t):
            return earth.at(t).observe(target).apparent().distance().au

        distance.step_days = 3.0 if inner else 8.0
        times, _ = find_minima(t0, t1, distance, epsilon=1.0 / 86400.0)
        for t in times:
            events.append(c.Inline(record(t, "perigee")))

    events.sort(key=lambda r: r.o["jd_utc"].v)
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/reference/gen_planet_events.py",
            "description": (
                "Oppositions, conjunctions with the Sun, greatest elongations of Mercury and "
                "Venus and closest approaches of Mercury to Neptune, 1990-2060, from Skyfield + "
                "JPL DE440s."
            ),
            "generated_utc": c.generated_utc(),
            "versions": c.versions(),
            "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
            "definitions": {
                "conjunction_opposition": (
                    "skyfield.almanac.oppositions_conjunctions: apparent ecliptic longitude of "
                    "date (ecliptic_frame), planet minus Sun, through 0 or 180 degrees; inferior "
                    "when the planet is nearer than the Sun"
                ),
                "greatest_elongation": "find_maxima of the apparent Sun-planet separation; east when the planet's longitude is greater",
                "perigee": "find_minima of the apparent (light-time) distance",
                "transit": "least apparent separation within a day of an inferior conjunction under SD_sun + SD_planet",
                "time": "jd_utc from Skyfield's own UTC (builtin leap-second table); no UT1 is involved",
            },
            "tolerances": {
                "conjunction_opposition_s": c.Num(60.0, 1),
                "extremum_s": c.Num(600.0, 1),
            },
            "never_a_runtime_dependency": (
                "Development-time reference. CONVENTIONS section 11: never regenerate a fixture "
                "from Rust output."
            ),
        },
        "events": events,
    }


def transit(ts, t, earth, sun, target, radius_km):
    """Least separation within a day of `t` under the sum of the semidiameters."""
    jd = t.tt
    grid = ts.tt_jd(np.linspace(jd - 1.0, jd + 1.0, 2881))
    e = earth.at(grid)
    p = e.observe(target).apparent()
    s = e.observe(sun).apparent()
    sep = p.separation_from(s).radians
    i = int(np.argmin(sep))
    sd_sun = 959.63 * ARCSEC / s.distance().au[i]
    sd_planet = math.asin(radius_km / (p.distance().au[i] * AU_KM))
    return bool(sep[i] < sd_sun + sd_planet)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--offline", action="store_true", help="skip NASA SKYCAL (keep the file)")
    mode.add_argument("--network-only", action="store_true", help="refresh only the NASA SKYCAL file")
    args = ap.parse_args(argv)
    ts = c.load_timescale()
    ref = c.FIX_REFERENCE
    if not args.offline:
        c.write_json(os.path.join(ref, "planet_events_nasa_skycal.json"), build_skycal(ts))
    if not args.network_only:
        c.write_json(os.path.join(ref, "planet_events_skyfield.json"), build_skyfield(ts))


if __name__ == "__main__":
    main()
