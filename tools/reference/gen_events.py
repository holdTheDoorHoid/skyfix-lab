"""fixtures/reference/events_*.json -- rise, set, transit, twilight, sky phases,
equinoxes, solstices and Moon phases, from Skyfield + JPL DE440s.

Development-time only (docs/CONVENTIONS.md section 11): nothing here is a
runtime dependency, and no fixture is ever regenerated from Rust output.

Every definition is CONVENTIONS section 13 coded from its text, with Skyfield
supplying the astronomy:

* **Altitude**: the topocentric altitude of the body's centre without
  refraction, `(earth + wgs84.latlon(lat, lon, h)).at(t).observe(body)
  .apparent().altaz()`. Skyfield's topocentric apparent place also contains
  diurnal aberration (at most 0.32", i.e. a few hundredths of a second at the
  horizon), which CONVENTIONS 13.2 leaves out; that is the only intended
  difference from the project's `alt_deg`.
* **Thresholds** (13.3): Sun -50'; Moon -34' - SD with SD = asin(1737.4 km /
  geocentric distance) (the IAU mean lunar radius); planets and stars -34';
  twilight -6, -12, -18 degrees for the Sun's centre.
* **Transit** (13.3): LHA = 0 (upper) and 180 (lower) from the apparent
  geocentric GHA = GAST - RA of date.
* **Sky phases** (13.4): day > -50' >= civil > -6 >= nautical > -12 >=
  astronomical > -18 >= night.
* **Equinoxes and solstices, Moon phases** (13.5): the Sun's apparent
  geocentric ecliptic longitude, and the Moon's minus the Sun's, on the true
  ecliptic and equinox of date (Skyfield's `ecliptic_frame`), at multiples of
  90 degrees, with IAU 2000A nutation. The rise/set/transit searches use IAU
  2000B (within 1 mas of 2000A, under 0.0001 s of any event), as Skyfield's own
  almanac searches do, because it is about twenty times cheaper on their
  one-minute grids.
* **Time**: the app's clock (CONVENTIONS 15.2: UTC 1972-2035, UT outside) with UT1
  = UTC on the UTC scale (DUT1 = 0, CONVENTIONS 6) and SkyFix Lab's own Delta T
  (`common.load_timescale(dut1_zero=True)`; before the expansion programme this was
  TT = UTC + 32.184 s + (TAI - UTC) with UTC continued past 2035). Every Julian date
  written is `jd_utc`, the clock's (86 400 s per day).
* **Search**: `skyfield.searchlib.find_discrete` on a one-minute grid,
  refined to Skyfield's 1 ms epsilon. A body that dips below (or climbs above)
  its threshold for less than about a minute can therefore be missed here;
  `crates/skyfix-almanac/tests/events_reference.rs` handles that as a grazing
  case and says so.

Windows run from local mean midnight (UTC midnight minus longitude / 15 h) for
one day, like the explorer's day view.

Independent check: `events_usno.json` stores US Naval Observatory API
responses (rise/set/transit/civil twilight for one UTC day, Moon phases and
seasons for a year), differenced against this file's Skyfield values. USNO
rounds to the minute. Network is needed for that part; with --offline it is
skipped and an existing file is left alone.

    tools/reference/.venv/bin/python -m tools.reference.gen_events [--offline | --usno-only] \
        [--window 1990..2060] [--kernel de440s]

`--window` keeps the dates inside it and sets the span of the seasons and Moon phases;
`--kernel` names the ephemeris.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time as _time

import numpy as np

from . import common as c

OUT_SUN = "events_sun.json"
OUT_STARS = "events_stars.json"
OUT_MOON_PLANETS = "events_moon_planets.json"
OUT_SEASONS = "events_seasons.json"
OUT_MOON_PHASES = "events_moon_phases.json"
OUT_USNO = "events_usno.json"

MOON_RADIUS_KM = 1737.4
SUN_H0 = -50.0 / 60.0
STAR_H0 = -34.0 / 60.0
STEP_DAYS = 1.0 / 1440.0

# name, lat, lon east, height above the ellipsoid (m). 34 sites: every
# continent, both hemispheres, the equator, both sides of the antimeridian,
# nine sites between 60 and 70 N and five between 60 and 70 S (midnight sun,
# polar night, white nights), plus 71-78 N and 78 S for full polar seasons.
SITES = [
    ("philadelphia", 39.9526, -75.1652, 12.0),
    ("greenwich", 51.4769, -0.0005, 46.0),
    ("reykjavik", 64.1466, -21.9426, 0.0),
    ("tromso", 69.6496, 18.9560, 0.0),
    ("murmansk", 68.9585, 33.0827, 50.0),
    ("kiruna", 67.8558, 20.2253, 530.0),
    ("rovaniemi", 66.5039, 25.7294, 80.0),
    ("fairbanks", 64.8378, -147.7164, 136.0),
    ("nuuk", 64.1814, -51.6941, 0.0),
    ("anchorage", 61.2181, -149.9003, 30.0),
    ("helsinki", 60.1699, 24.9384, 10.0),
    ("longyearbyen", 78.2232, 15.6267, 0.0),
    ("utqiagvik", 71.2906, -156.7887, 0.0),
    ("mcmurdo", -77.8419, 166.6863, 0.0),
    ("casey", -66.2821, 110.5285, 0.0),
    ("mawson", -67.6027, 62.8738, 0.0),
    ("rothera", -67.5680, -68.1290, 0.0),
    ("palmer", -64.7743, -64.0538, 0.0),
    ("signy", -60.7078, -45.5953, 0.0),
    ("ushuaia", -54.8019, -68.3030, 0.0),
    ("sydney", -33.8688, 151.2093, 0.0),
    ("cape_town", -33.9249, 18.4241, 0.0),
    ("buenos_aires", -34.6037, -58.3816, 25.0),
    ("wellington", -41.2865, 174.7762, 0.0),
    ("quito", -0.1807, -78.4678, 2850.0),
    ("singapore", 1.3521, 103.8198, 0.0),
    ("nairobi", -1.2921, 36.8219, 1795.0),
    ("honolulu", 21.3069, -157.8583, 0.0),
    ("tokyo", 35.6762, 139.6503, 40.0),
    ("suva", -18.1416, 178.4419, 0.0),
    ("apia", -13.8333, -171.7500, 0.0),
    ("mumbai", 19.0760, 72.8777, 10.0),
    ("denver", 39.7392, -104.9903, 1609.0),
    ("cairo", 30.0444, 31.2357, 23.0),
]

# 21 dates, 1990-2060: solstices and equinoxes for the polar cases, a leap
# day, the 2016-12-31 leap second, and ordinary days.
DATES = [
    (1990, 1, 15), (1992, 6, 21), (1994, 3, 20), (1996, 9, 22), (1998, 12, 21),
    (2000, 2, 29), (2003, 5, 20), (2005, 7, 4), (2008, 10, 15), (2011, 12, 22),
    (2014, 6, 20), (2017, 1, 1), (2019, 8, 8), (2022, 11, 11), (2026, 9, 24),
    (2030, 4, 15), (2035, 12, 21), (2041, 6, 21), (2048, 3, 1), (2055, 9, 23),
    (2060, 12, 30),
]

STARS = ["Sirius", "Canopus", "Arcturus", "Vega", "Capella", "Rigil Kentaurus",
         "Achernar", "Polaris", "Acrux", "Deneb"]
STAR_SITES = ["philadelphia", "greenwich", "tromso", "longyearbyen", "sydney",
              "quito", "mcmurdo", "casey", "honolulu", "suva", "apia", "cape_town"]
STAR_DATES = [(1991, 3, 3), (2002, 8, 17), (2017, 1, 1), (2026, 9, 24),
              (2044, 5, 30), (2059, 11, 2)]

MOON_SITES = ["philadelphia", "greenwich", "reykjavik", "tromso", "kiruna",
              "fairbanks", "anchorage", "longyearbyen", "casey", "rothera",
              "ushuaia", "sydney", "cape_town", "wellington", "quito",
              "singapore", "honolulu", "tokyo", "suva", "apia"]

PLANETS = [("Mercury", "mercury"), ("Venus", "venus"), ("Mars", "mars barycenter"),
           ("Jupiter", "jupiter barycenter"), ("Saturn", "saturn barycenter"),
           ("Uranus", "uranus barycenter"), ("Neptune", "neptune barycenter")]
PLANET_SITES = ["philadelphia", "tromso", "sydney", "quito", "casey", "tokyo",
                "cape_town", "anchorage", "apia", "helsinki"]
PLANET_DATES = [(1993, 1, 9), (2004, 6, 8), (2012, 6, 6), (2026, 9, 24),
                (2039, 2, 14), (2057, 7, 20)]

SITE = {s[0]: s for s in SITES}

SUN_KINDS = {  # threshold index -> (upward kind, downward kind)
    0: ("astronomical_dawn", "astronomical_dusk"),
    1: ("nautical_dawn", "nautical_dusk"),
    2: ("civil_dawn", "civil_dusk"),
    3: ("rise", "set"),
}
PHASES = ["night", "astronomical", "nautical", "civil", "day"]


# ---------------------------------------------------------------------------
# Skyfield set-up
# ---------------------------------------------------------------------------


def dut1_zero_timescale():
    """The app's clock with UT1 = UTC on the UTC scale (CONVENTIONS sections 6 and
    15.2): `common.load_timescale(dut1_zero=True)`. On the UT part of the clock (before
    1972, after 2035) the clock is UT1 itself and TT follows from SkyFix Lab's Delta T."""
    return c.load_timescale(dut1_zero=True)


def jd_list(t):
    return [c.jd_utc_of(x) for x in t] if t.shape else [c.jd_utc_of(t)]


def window(ts, date, lon):
    """Local mean midnight to local mean midnight, as Skyfield Times."""
    y, m, d = date
    t0 = ts.utc(y, m, d, 0, 0, -lon * 240.0)
    t1 = ts.utc(y, m, d + 1, 0, 0, -lon * 240.0)
    return t0, t1


def discrete(f, step=STEP_DAYS):
    f.step_days = step
    return f


def fast_nutation(t):
    """Use IAU 2000B nutation for this Time, as Skyfield's own almanac searches do.

    2000B is within 1 mas of the full 2000A series (McCarthy & Luzum 2003), i.e.
    under 0.0001 s of any event here, and it is about twenty times cheaper over the
    one-minute search grids. Set before anything else reads the nutation.
    """
    from skyfield.nutationlib import iau2000b_radians

    if "_nutation_angles_radians" not in t.__dict__:
        t._nutation_angles_radians = iau2000b_radians(t)
    return t


class Body:
    """Vectorised topocentric altitude and geocentric LHA of one target."""

    def __init__(self, eph, target, topos, lon, h0):
        self.earth = eph["earth"]
        self.obs = self.earth + topos
        self.target = target
        self.lon = lon
        self.h0 = h0  # a number, or a function of the geocentric distance (km)

    def alt(self, t):
        fast_nutation(t)
        return self.obs.at(t).observe(self.target).apparent().altaz()[0].degrees

    def threshold(self, t):
        if callable(self.h0):
            fast_nutation(t)
            dist = self.earth.at(t).observe(self.target).apparent().distance().km
            return self.h0(dist)
        return self.h0

    def lha(self, t):
        fast_nutation(t)
        ra, _, _ = self.earth.at(t).observe(self.target).apparent().radec(epoch="date")
        return (t.gast * 15.0 - ra.hours * 15.0 + self.lon) % 360.0


def moon_h0(dist_km):
    sd_arcmin = np.degrees(np.arcsin(MOON_RADIUS_KM / dist_km)) * 60.0
    return -(34.0 + sd_arcmin) / 60.0


def transits(body, t0, t1):
    from skyfield.searchlib import find_discrete

    f = discrete(lambda t: body.lha(t) < 180.0)
    times, values = find_discrete(t0, t1, f)
    out = []
    for t, v in zip(jd_list(times), values):
        out.append(("transit" if v else "lower_transit", t))
    return out


def rise_set(body, t0, t1):
    """(events, above_at_start)."""
    from skyfield.searchlib import find_discrete

    f = discrete(lambda t: body.alt(t) > body.threshold(t))
    times, values = find_discrete(t0, t1, f)
    events = [("rise" if v else "set", t) for t, v in zip(jd_list(times), values)]
    return events, bool(f(t0))


def sun_window(body, t0, t1):
    """Every Sun event, the phases and the day length over one window."""
    from skyfield.searchlib import find_discrete

    thresholds = np.array([-18.0, -12.0, -6.0, SUN_H0])

    def band(t):
        a = body.alt(t)
        return (a[..., None] > thresholds).sum(axis=-1) if np.ndim(a) else int(
            (a > thresholds).sum()
        )

    f = discrete(band)
    times, values = find_discrete(t0, t1, f)
    start_band = int(f(t0))
    jds = jd_list(times)
    events = []
    prev = start_band
    for t, v in zip(jds, values):
        v = int(v)
        if v > prev:
            for k in range(prev, v):
                events.append((SUN_KINDS[k][0], t))
        else:
            for k in range(prev - 1, v - 1, -1):
                events.append((SUN_KINDS[k][1], t))
        prev = v
    j0, j1 = c.jd_utc_of(t0), c.jd_utc_of(t1)
    bounds = [j0] + jds + [j1]
    bands = [start_band] + [int(v) for v in values]
    phases = []
    day = 0.0
    for a, b, v in zip(bounds[:-1], bounds[1:], bands):
        if b <= a:
            continue
        if phases and phases[-1][0] == PHASES[v]:
            phases[-1][2] = b
        else:
            phases.append([PHASES[v], a, b])
        if v == 4:
            day += b - a
    events += transits(body, t0, t1)
    rs = [e for e in events if e[0] in ("rise", "set")]
    return {
        "events": sorted(events, key=lambda e: e[1]),
        "always_above": not rs and start_band == 4,
        "always_below": not rs and start_band < 4,
        "day_length_h": day * 24.0,
        "phases": phases,
    }


def fmt_events(events):
    return [c.Inline([k, c.jd(t)]) for k, t in events]


# ---------------------------------------------------------------------------
# The files
# ---------------------------------------------------------------------------


def load():
    from skyfield.api import wgs84

    ts = dut1_zero_timescale()
    eph = c.run_ephemeris()
    topos = {n: wgs84.latlon(la, lo, elevation_m=h) for n, la, lo, h in SITES}
    return ts, eph, topos


def generator(description, extra=None):
    block = c.generator_block(
        tool="tools/reference/gen_events.py",
        description=description,
        tolerance_arcmin=c.Num(0.0, 1),
        tolerance_justification=(
            "Events are times, not angles: the targets are CONVENTIONS 13.7, "
            "within 10 s of this file for rise, set and twilight with the same h0, "
            "and within 1 min for Moon phases and seasons."
        ),
        timescale=c.project_timescale_facts(),
        extra={
            "run": c.RUN.facts(),
            "frame_of_date": c.app_frame_facts(),
            "ephemeris": c.run_kernel_facts(),
            "time": (
                "The app's clock (CONVENTIONS 15.2): UTC 1972-2035 with UT1 = UTC (DUT1 = 0, "
                "CONVENTIONS 6), UT (= UT1) outside, TT from SkyFix Lab's own Delta T. "
                "Julian dates are jd_utc, the clock's (86 400 s per day), 9 decimals "
                "(86 microseconds)."
            ),
            "search": (
                "skyfield.searchlib.find_discrete on a one-minute grid "
                "(epsilon 1 ms), IAU 2000B nutation (within 1 mas of 2000A). "
                "Crossings closer together than about a minute (a body grazing "
                "its threshold) may be missed. Sun `phases` list the phase names "
                "in order; each bound between two is one of the window's events."
            ),
            "altitude": (
                "(earth + wgs84.latlon(lat, lon, elevation_m=height_m)).at(t)"
                ".observe(body).apparent().altaz(): topocentric, no refraction. "
                "Includes diurnal aberration (<= 0.32\"), which CONVENTIONS 13.2 "
                "omits."
            ),
            "thresholds": {
                "sun_deg": c.Num(SUN_H0, 9),
                "moon": "-(34' + asin(1737.4 km / geocentric distance))",
                "planets_and_stars_deg": c.Num(STAR_H0, 9),
                "twilight_deg": [-6, -12, -18],
            },
            "transit": "LHA = GAST(UT1 = UTC) * 15 - RA(apparent, of date) + lon; 0 upper, 180 lower",
            "windows": "local mean midnight (UTC midnight - lon / 15 h) for one day",
            "sites": [
                c.Inline({"name": n, "lat_deg": c.deg(la), "lon_deg": c.deg(lo),
                          "height_m": c.metres(h)})
                for n, la, lo, h in SITES
            ],
            **(extra or {}),
        },
    )
    return block


def build_sun(ts, eph, topos):
    sun = eph["sun"]
    windows = []
    n_events = 0
    for name, lat, lon, h in SITES:
        for date in DATES:
            t0, t1 = window(ts, date, lon)
            body = Body(eph, sun, topos[name], lon, SUN_H0)
            w = sun_window(body, t0, t1)
            n_events += len(w["events"])
            windows.append(c.Inline({
                "site": name,
                "date": "%04d-%02d-%02d" % date,
                "jd_start": c.jd(c.jd_utc_of(t0)),
                "jd_end": c.jd(c.jd_utc_of(t1)),
                "events": fmt_events(w["events"]),
                "always_above": w["always_above"],
                "always_below": w["always_below"],
                "day_length_h": c.Num(w["day_length_h"], 6),
                # Names only: every bound between two phases is one of this
                # window's Sun events (rise/set or a twilight), already listed.
                "phases": [p for p, _a, _b in w["phases"]],
            }))
    print("   Sun: %d windows, %d events" % (len(windows), n_events))
    return {
        "schema": "skyfix.reference/1",
        "name": "events_sun",
        "generator": generator(
            "Sun rise, set, transit, lower transit, civil/nautical/astronomical "
            "twilight, sky phases and day length at %d sites x %d dates."
            % (len(SITES), len(DATES)),
            {"dates": ["%04d-%02d-%02d" % d for d in DATES]},
        ),
        "windows": windows,
    }


def build_bodies(ts, eph, topos, targets, sites, dates, name):
    windows = []
    n_events = 0
    for body_name, target, h0 in targets:
        for site in sites:
            _, lat, lon, h = SITE[site]
            for date in dates:
                t0, t1 = window(ts, date, lon)
                body = Body(eph, target, topos[site], lon, h0)
                rs, above = rise_set(body, t0, t1)
                events = sorted(rs + transits(body, t0, t1), key=lambda e: e[1])
                n_events += len(events)
                windows.append(c.Inline({
                    "body": body_name,
                    "site": site,
                    "date": "%04d-%02d-%02d" % date,
                    "jd_start": c.jd(c.jd_utc_of(t0)),
                    "jd_end": c.jd(c.jd_utc_of(t1)),
                    "events": fmt_events(events),
                    "always_above": not rs and above,
                    "always_below": not rs and not above,
                }))
    print("   %s: %d windows, %d events" % (name, len(windows), n_events))
    return windows


def build_stars(ts, eph, topos):
    df = c.load_hipparcos_frame()
    stars, _rows, problems = c.build_stars(df)
    if problems:
        raise RuntimeError("star identity doubts: %s" % problems)
    targets = [(n, stars[n], STAR_H0) for n in STARS]
    windows = build_bodies(ts, eph, topos, targets, STAR_SITES, STAR_DATES, "stars")
    return {
        "schema": "skyfix.reference/1",
        "name": "events_stars",
        "generator": generator(
            "Rise, set, transit and lower transit of %d stars at %d sites x %d dates."
            % (len(STARS), len(STAR_SITES), len(STAR_DATES)),
            {"catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
             "dates": ["%04d-%02d-%02d" % d for d in STAR_DATES]},
        ),
        "windows": windows,
    }


def build_moon_planets(ts, eph, topos):
    moon = [("Moon", eph["moon"], moon_h0)]
    planets = [(n, eph[k], STAR_H0) for n, k in PLANETS]
    w_moon = build_bodies(ts, eph, topos, moon, MOON_SITES, DATES, "Moon")
    w_planets = build_bodies(ts, eph, topos, planets, PLANET_SITES, PLANET_DATES, "planets")
    return {
        "schema": "skyfix.reference/1",
        "name": "events_moon_planets",
        "generator": generator(
            "Moon (%d sites x %d dates) and planet (%d sites x %d dates) rise, set, "
            "transit and lower transit. Mars to Neptune are their system barycentres "
            "in DE440s (under 0.03\" from the planet centre)."
            % (len(MOON_SITES), len(DATES), len(PLANET_SITES), len(PLANET_DATES)),
            {"moon_radius_km": c.Num(MOON_RADIUS_KM, 1),
             "planet_dates": ["%04d-%02d-%02d" % d for d in PLANET_DATES]},
        ),
        "windows": w_moon + w_planets,
    }


def ecliptic_lon_deg(e, target, t):
    from skyfield.framelib import ecliptic_frame

    _, lon, _ = e.observe(target).apparent().frame_latlon(ecliptic_frame)
    return lon.degrees


def quarters(ts, eph, f_deg, start, end, step):
    """Instants the increasing angle f passes a multiple of 90 degrees."""
    from skyfield.searchlib import find_discrete

    f = discrete(lambda t: (np.floor(f_deg(eph, t) / 90.0) % 4).astype(int), step)
    times, values = find_discrete(ts.utc(*start), ts.utc(*end), f)
    return list(zip(jd_list(times), [int(v) for v in values]))


def sun_lon(eph, t):
    return ecliptic_lon_deg(eph["earth"].at(t), eph["sun"], t) % 360.0


def moon_minus_sun(eph, t):
    e = eph["earth"].at(t)
    return (ecliptic_lon_deg(e, eph["moon"], t) - ecliptic_lon_deg(e, eph["sun"], t)) % 360.0


SEASON_KINDS = ["march_equinox", "june_solstice", "september_equinox", "december_solstice"]
PHASE_KINDS = ["new_moon", "first_quarter", "full_moon", "last_quarter"]


def cross_check(ts, a, b):
    """Worst |difference| in seconds between two event lists of the same kinds."""
    worst = 0.0
    for (ta, ka), (tb, kb) in zip(a, b):
        assert ka == kb
        worst = max(worst, abs(ta - tb) * 86400.0)
    return worst


def build_seasons_phases(ts, eph):
    eph421 = c.load_ephemeris(c.EPHEMERIS_FILE)
    y0, y1 = c.window_years()
    seasons = quarters(ts, eph, sun_lon, (y0, 1, 1), (y1 + 1, 1, 1), 20.0)
    phases = quarters(ts, eph, moon_minus_sun, (y0, 1, 1), (y1 + 1, 1, 1), 1.0)
    # DE421 (ends 2053-10-08) as an independent cross-check of the ephemeris.
    s421 = quarters(ts, eph421, sun_lon, (1990, 1, 1), (2053, 1, 1), 20.0)
    p421 = quarters(ts, eph421, moon_minus_sun, (1990, 1, 1), (2053, 1, 1), 1.0)
    ds = cross_check(ts, seasons[: len(s421)], s421)
    dp = cross_check(ts, phases[: len(p421)], p421)
    print("   seasons %d, Moon phases %d; DE421 vs DE440s worst %.3f s / %.3f s"
          % (len(seasons), len(phases), ds, dp))

    def doc(name, desc, events, kinds, worst):
        return {
            "schema": "skyfix.reference/1",
            "name": name,
            "generator": generator(desc, {
                "de421_vs_de440s_worst_s_1990_2052": c.Num(worst, 3),
                "frame": "Skyfield ecliptic_frame: true ecliptic and equinox of date, IAU 2000A nutation",
            }),
            "events": [c.Inline([kinds[q], c.jd(t), _utc(t)]) for t, q in events],
        }

    return (
        doc("events_seasons",
            "Equinoxes and solstices 1990-2060: the Sun's apparent geocentric ecliptic "
            "longitude of date at 0, 90, 180, 270 deg.", seasons, SEASON_KINDS, ds),
        doc("events_moon_phases",
            "Moon phases 1990-2060: apparent geocentric ecliptic longitude of the Moon "
            "minus the Sun's, of date, at 0, 90, 180, 270 deg.", phases, PHASE_KINDS, dp),
    )


def _utc(jd_utc):
    import datetime as dt

    ms = round((jd_utc - 2440587.5) * 86400000.0)
    return (dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
            + dt.timedelta(milliseconds=ms)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------------------
# USNO
# ---------------------------------------------------------------------------

USNO_ONEDAY = [  # site, UTC date
    ("philadelphia", (2026, 9, 24)), ("sydney", (2026, 6, 21)),
    ("tromso", (2026, 12, 21)), ("tromso", (2026, 6, 21)),
    ("reykjavik", (2000, 2, 29)), ("quito", (2030, 3, 20)),
    ("cape_town", (1998, 12, 21)), ("tokyo", (2019, 8, 8)),
    ("honolulu", (2011, 12, 22)), ("buenos_aires", (1994, 3, 20)),
    ("anchorage", (1990, 1, 15)), ("helsinki", (2055, 6, 21)),
    ("casey", (2035, 12, 21)), ("denver", (2048, 3, 1)),
]
USNO_YEARS = [1990, 2000, 2026, 2045, 2060]
USNO_PHEN = {"Begin Civil Twilight": "civil_dawn", "Rise": "rise",
             "Upper Transit": "transit", "Set": "set", "End Civil Twilight": "civil_dusk"}
USNO_PHASE = {"New Moon": "new_moon", "First Quarter": "first_quarter",
              "Full Moon": "full_moon", "Last Quarter": "last_quarter"}


def fetch(url):
    out = subprocess.run(["curl", "-sS", "-f", "-m", "90", "-L", url],
                         check=True, capture_output=True, text=True).stdout
    _time.sleep(1.0)  # be polite to a public service
    return json.loads(out)


def _civil_jd(y, m, d):
    a = (14 - m) // 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    return d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045 - 0.5


def build_usno():
    oneday = []
    for site, (y, m, d) in USNO_ONEDAY:
        _, lat, lon, _h = SITE[site]
        url = ("https://aa.usno.navy.mil/api/rstt/oneday?date=%04d-%02d-%02d"
               "&coords=%.4f,%.4f&tz=0" % (y, m, d, lat, lon))
        raw = fetch(url)["properties"]["data"]
        sun = [[USNO_PHEN[p["phen"]], p["time"]] for p in raw.get("sundata", [])
               if p["phen"] in USNO_PHEN]
        moon = [[USNO_PHEN[p["phen"]], p["time"]] for p in raw.get("moondata", [])
                if p["phen"] in USNO_PHEN]
        oneday.append(c.Inline({
            "site": site, "date": "%04d-%02d-%02d" % (y, m, d), "url": url,
            "jd_start": c.jd(_civil_jd(y, m, d)),
            "sun": sun, "moon": moon,
            "notes": [str(raw[k]) for k in sorted(raw) if k.endswith("note") or k == "curphase"],
        }))
        print("   USNO %s %04d-%02d-%02d: Sun %s; Moon %s" % (site, y, m, d, sun, moon))
    phases, seasons = [], []
    for year in USNO_YEARS:
        url = "https://aa.usno.navy.mil/api/moon/phases/year?year=%d" % year
        for p in fetch(url)["phasedata"]:
            phases.append(c.Inline([USNO_PHASE[p["phase"]], "%04d-%02d-%02dT%sZ" % (
                p["year"], p["month"], p["day"], p["time"])]))
        url = "https://aa.usno.navy.mil/api/seasons?year=%d" % year
        for s in fetch(url)["data"]:
            if s["phenom"] in ("Equinox", "Solstice"):
                kind = {3: "march_equinox", 6: "june_solstice", 9: "september_equinox",
                        12: "december_solstice"}[s["month"]]
                seasons.append(c.Inline([kind, "%04d-%02d-%02dT%sZ" % (
                    s["year"], s["month"], s["day"], s["time"])]))
    return {
        "schema": "skyfix.reference/1",
        "name": "events_usno",
        "generator": c.generator_block(
            tool="tools/reference/gen_events.py",
            description=(
                "US Naval Observatory API: Sun and Moon rise, set, upper transit and "
                "civil twilight for %d site-days (UTC days, tz=0), Moon phases and "
                "equinoxes/solstices for %s. Times are USNO's, rounded to the minute."
                % (len(oneday), ", ".join(str(y) for y in USNO_YEARS))
            ),
            tolerance_arcmin=c.Num(0.0, 1),
            tolerance_justification=(
                "Times, not angles. CONVENTIONS 13.7: rise, set and twilight within "
                "1 min of USNO (rounded to the minute); Moon phases and seasons within "
                "1 min."
            ),
            extra={
                "source": "US Naval Observatory, Astronomical Applications Department",
                "api_documentation": "https://aa.usno.navy.mil/data/api",
                "retrieved_utc": c.generated_utc(),
                "terms_of_use": (
                    "Produced by the US Naval Observatory, a US Government agency; "
                    "works of the US Government are not subject to copyright in the "
                    "United States (17 U.S.C. 105). See docs/THIRD_PARTY.md."
                ),
                "usno_definitions": (
                    "USNO's rise and set are the upper limb on the sea-level horizon "
                    "with 34' of refraction (Sun: centre at -50'), topocentric, for the "
                    "Moon as well; civil twilight is the Sun's centre at -6 deg. The "
                    "same definitions as CONVENTIONS 13.3."
                ),
            },
        ),
        "oneday": oneday,
        "moon_phases": phases,
        "seasons": seasons,
    }


def main(argv=None):
    import argparse

    argv = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="skip the USNO query")
    ap.add_argument("--usno-only", action="store_true", help="only the USNO query (network)")
    c.setup(argv, None, "1990..2060", "de440s", parser=ap)
    if "--usno-only" in argv:
        main_usno_only()
        return
    for dates in (DATES, STAR_DATES, PLANET_DATES):
        dates[:] = [d for d in dates if c.in_window(_civil_jd(*d))]
    ts, eph, topos = load()
    t = _time.time()
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_SUN), build_sun(ts, eph, topos))
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_STARS), build_stars(ts, eph, topos))
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_MOON_PLANETS),
                 build_moon_planets(ts, eph, topos))
    seasons, phases = build_seasons_phases(ts, eph)
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_SEASONS), seasons)
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_MOON_PHASES), phases)
    print("   Skyfield part done in %.0f s" % (_time.time() - t))
    if "--offline" in argv:
        print("   USNO cross-check skipped (--offline); %s left as it is" % OUT_USNO)
        return
    main_usno_only()


def main_offline():
    main(["--offline"])


def main_usno_only():
    """Query USNO and rewrite events_usno.json; on failure leave it alone."""
    if c.RUN.kernel is None:
        c.setup([], None, "1990..2060", "de440s")
    try:
        doc = build_usno()
    except (OSError, subprocess.CalledProcessError, KeyError, ValueError) as e:
        print("   USNO API unreachable or changed (%s); %s left as it is, nothing "
              "fabricated." % (e, OUT_USNO))
        return
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_USNO), doc)


if __name__ == "__main__":
    main()
