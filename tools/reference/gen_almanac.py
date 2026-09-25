"""fixtures/reference/almanac_days.json -- daily almanac pages from Skyfield + DE440s,
and fixtures/reference/almanac_usno.json -- US Naval Observatory spot checks.

Development-time only (docs/CONVENTIONS.md section 11): nothing here is a runtime
dependency, and no fixture is ever regenerated from Rust output.

For each date in DATES this computes every quantity a daily page tabulates
(crates/skyfix-almanac/src/pages.rs, CONVENTIONS 13.9), coded from the text of
those definitions with Skyfield supplying the astronomy:

* **Time**: the app's clock (CONVENTIONS 15.2: UTC 1972-2035, UT outside) with UT1 = UTC
  on the UTC scale (DUT1 = 0, CONVENTIONS 6) and SkyFix Lab's own Delta T
  (`common.load_timescale(dut1_zero=True)`). Julian dates are jd_utc, the clock's.
* **Hourly** (00h to 24h, the 25th only for v and d): GHA Aries = GAST; apparent
  geocentric GHA = GAST - RA and Dec of date for the Sun, the Moon, Venus, Mars,
  Jupiter and Saturn (DE440s; Mars to Saturn are their system barycentres, as in
  gen_planets.py); the Moon's HP = asin(6378.14 km / distance).
* **v**: the mean hourly increase of GHA minus 15 deg (planets, over 00h-24h) or
  14 deg 19.0' (Moon, from each hour to the next), arcminutes. **d**: the change of
  declination per hour, over the same intervals, signed.
* **At 12h UT**: SD of the Sun (959.63" / r) and of the Moon (asin(0.2725076 x
  6378.14 km / distance)); the planets' SHA = 360 - RA and magnitude (Mallama &
  Hilton 2018 with the real Sun, gen_planets.heliocentric_magnitude); the stars'
  SHA and Dec (Hipparcos, common.build_stars); the Moon's illuminated fraction
  (skyfield.almanac.fraction_illuminated) and age (time since the preceding new
  moon: the Moon's apparent ecliptic longitude minus the Sun's passing 0, as in
  gen_events).
* **Equation of time** at 00h and 12h: (GHA Sun - 15 deg x (UT - 12 h)) x 240 s/deg.
* **Meridian passages** at Greenwich: GHA = 0 (Moon's lower: 180) found with
  find_discrete on a one-minute grid (gen_events.transits at 0 N 0 E); Aries: the
  instant GAST passes 0 h.
* **Rise, set and twilight** at the 31 standard latitudes on the Greenwich meridian,
  sea level: gen_events' Sun and Moon searches (Sun's centre at -50', -6, -12 deg;
  Moon's centre at -34' - SD, topocentric, no refraction), then the cell rules of
  pages.rs coded again here from their description: morning = rising between the
  lower meridian passage before the date's noon and that noon, evening = setting
  between noon and the next lower passage; without a crossing, above all day (box),
  below (filled box) or twilight all night by the Sun's altitude at the passages;
  moonrise/moonset the first on the date, else the next date's, else a box by the
  Moon's state, else "later".

The USNO part (network; `--usno` or `--usno-only`) stores verbatim Celestial
Navigation Data answers for a few whole hours, queried at each body's own ground
point so that it is above the horizon, and one-day rise/set/twilight answers at the
Greenwich meridian.

    tools/reference/.venv/bin/python -m tools.reference.gen_almanac [--usno | --usno-only] \
        [--window 1990..2060] [--kernel de440s]

`--window` keeps the DATES inside it; `--kernel` names the ephemeris (outside the
validated tier the frame of date is the app's long-term one, `common.use_app_frame`).
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
import time as _time

import numpy as np

from . import common as c
from . import gen_events as ge
from . import gen_planets as gp
from . import gen_usno as gu

OUT = "almanac_days.json"
OUT_USNO = "almanac_usno.json"

#: 17 dates across 1990-2060: both solstices (midnight sun, polar night, twilight all
#: night), an equinox, a leap day, the 2016-12-31 leap second, eclipse days (new and
#: full moons: the Moon's age and phase), Venus at superior conjunction (negative v),
#: and the last days the coverage allows a full page for.
DATES = [
    (1990, 3, 15), (1992, 6, 21), (1995, 12, 22), (1997, 9, 1), (2000, 2, 29),
    (2004, 6, 8), (2009, 12, 31), (2012, 11, 13), (2016, 6, 6), (2016, 12, 31),
    (2020, 3, 20), (2026, 9, 24), (2031, 5, 21), (2038, 1, 19), (2044, 8, 23),
    (2051, 11, 5), (2060, 12, 28),
]

LATITUDES = [72, 70, 68, 66, 64, 62, 60, 58, 56, 54, 52, 50, 45, 40, 35, 30, 20, 10, 0,
             -10, -20, -30, -35, -40, -45, -50, -52, -54, -56, -58, -60]

PLANETS = [("Venus", "venus"), ("Mars", "mars barycenter"),
           ("Jupiter", "jupiter barycenter"), ("Saturn", "saturn barycenter")]

EARTH_RADIUS_KM = 6378.14  # the Moon's HP and SD, as the Astronomical Almanac defines them
MOON_K = 0.2725076
MOON_ADOPTED_DEG_PER_H = 14.0 + 19.0 / 60.0
PLANET_ADOPTED_DEG_PER_H = 15.0


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def civil_jd(y, m, d):
    return ge._civil_jd(y, m, d)


def time_of(ts, jd_utc):
    """A Skyfield Time at the project's jd_utc (UTC calendar, 86 400 s a day)."""
    import datetime as dt

    day = math.floor(jd_utc + 0.5) - 0.5
    base = dt.datetime(2000, 1, 1) + dt.timedelta(days=round(day - 2451544.5))
    return ts.utc(base.year, base.month, base.day, 0, 0, (jd_utc - day) * 86400.0)


def geocentric(eph, t, target):
    """(GHA, Dec, RA, distance km) arrays, apparent geocentric of date, GHA = GAST - RA."""
    app = eph["earth"].at(t).observe(target).apparent()
    ra, dec, dist = app.radec(epoch="date")
    ra_deg = np.asarray(ra.hours) * 15.0
    gha = (np.asarray(t.gast) * 15.0 - ra_deg) % 360.0
    return gha, np.asarray(dec.degrees), ra_deg, np.asarray(dist.km)


def unwrap_change(a, b, dt_h):
    """GHA change b - a over dt_h hours, unwrapped around the sidereal rotation."""
    guess = 15.041068640 * dt_h
    return guess + ((b - a - guess + 180.0) % 360.0 - 180.0)


def cell_time(jd):
    return c.Inline(["time", c.jd(jd)])


def cell(kind):
    return c.Inline([kind])


def first(events, kind, a, b):
    for k, t in events:
        if k == kind and a <= t < b:
            return t
    return None


# ---------------------------------------------------------------------------
# One date
# ---------------------------------------------------------------------------


def hour_times(ts, y, m, d):
    """00h..23h of the date and 00h of the next, as one Time.

    The 25th instant is built as the next date's 00h, not as hour 24 of this one: on a
    day that ends with a leap second (2016-12-31) Skyfield puts hour 24 inside the leap
    second, while the project's jd_utc (86 400 s per UTC calendar day) puts it at
    00:00:00 of the next date.
    """
    import datetime as dt

    nd = dt.date(y, m, d) + dt.timedelta(days=1)
    return ts.utc([y] * 24 + [nd.year], [m] * 24 + [nd.month], [d] * 24 + [nd.day],
                  list(range(24)) + [0])


def behind_the_sun(eph, t, target):
    """Per instant: the undeflected (GHA, Dec) where Skyfield's solar deflection exceeds
    the limb value (the planet is behind the solar disc), else None. Skyfield applies the
    deflection formula without bound there; the project's provider caps it at the limb
    (docs/ACCURACY.md, "Planets hidden behind the Sun")."""
    ast = eph["earth"].at(t).observe(target)
    und = ast.apparent(deflectors=())
    sun_only = ast.apparent(deflectors=(10,))
    defl = np.atleast_1d(np.asarray(sun_only.separation_from(und).arcseconds()))
    ra, dec, _ = und.radec(epoch="date")
    gha = (np.asarray(t.gast) * 15.0 - np.asarray(ra.hours) * 15.0) % 360.0
    gha, dec = np.atleast_1d(gha), np.atleast_1d(np.asarray(dec.degrees))
    return [
        (float(gha[i]), float(dec[i])) if defl[i] > gp.LIMB_DEFLECTION_ARCSEC else None
        for i in range(len(defl))
    ]


def hourly(ts, eph, y, m, d):
    t = hour_times(ts, y, m, d)
    jds = [civil_jd(y, m, d) + h / 24.0 for h in range(25)]
    aries = (np.asarray(t.gast) * 15.0) % 360.0
    out = {"aries": aries}
    out["Sun"] = geocentric(eph, t, eph["sun"])
    out["Moon"] = geocentric(eph, t, eph["moon"])
    for name, key in PLANETS:
        out[name] = geocentric(eph, t, eph[key])
        out[name + " hidden"] = behind_the_sun(eph, t, eph[key])
    return jds, out


def sun_cells(events, alt_at, day0):
    """The six Sun cells from the Sun's events (kind, jd) over [day0 - 0.5, day0 + 1.5]."""
    noon = first(events, "transit", day0, day0 + 1.0)
    before = [t for k, t in events if k == "lower_transit" and t < noon]
    after = [t for k, t in events if k == "lower_transit" and t > noon]
    before = before[-1] if before else None
    after = after[0] if after else None
    frm = before if before is not None else -math.inf
    to = after if after is not None else math.inf
    hi = alt_at(noon)
    lo_m = alt_at(before) if before is not None else None
    lo_e = alt_at(after) if after is not None else None
    out = {}
    specs = [
        ("nautical_dawn", -12.0, "nautical_dawn", True),
        ("civil_dawn", -6.0, "civil_dawn", True),
        ("sunrise", ge.SUN_H0, "rise", True),
        ("sunset", ge.SUN_H0, "set", False),
        ("civil_dusk", -6.0, "civil_dusk", False),
        ("nautical_dusk", -12.0, "nautical_dusk", False),
    ]
    for name, h, kind, morning in specs:
        if morning:
            hits = [t for k, t in events if k == kind and frm < t <= noon]
            hit = hits[0] if hits else None
        else:
            hits = [t for k, t in events if k == kind and noon < t <= to]
            hit = hits[-1] if hits else None
        if hit is not None:
            out[name] = cell_time(hit)
            continue
        lo = lo_m if morning else lo_e
        twilight = h != ge.SUN_H0
        if hi < h:
            out[name] = cell("below")
        elif lo is not None and lo > h:
            out[name] = cell("all_night" if twilight and lo <= ge.SUN_H0 else "above")
        else:
            out[name] = cell("unavailable")
    margins = {
        "upper_deg": c.deg(hi),
        "lower_before_deg": None if lo_m is None else c.deg(lo_m),
        "lower_after_deg": None if lo_e is None else c.deg(lo_e),
    }
    return out, margins


def moon_cells(events, above_at_start, x0, kind):
    """Moonrise (kind 'rise') or moonset cell for the UT date starting at x0."""
    t = first(events, kind, x0, x0 + 1.0)
    if t is not None:
        return cell_time(t)
    in_day = [e for e in events if e[0] in ("rise", "set") and x0 <= e[1] < x0 + 1.0]
    if not in_day:
        prior = [e for e in events if e[0] in ("rise", "set") and e[1] <= x0]
        later = [e for e in events if e[0] in ("rise", "set") and e[1] > x0]
        if prior:
            above = prior[-1][0] == "rise"
        elif later:
            above = later[0][0] == "set"
        else:
            above = above_at_start
        return cell("above" if above else "below")
    t = first(events, kind, x0 + 1.0, x0 + 2.0)
    return cell_time(t) if t is not None else cell("later")


def passage_cell(events, kind, day0):
    t = first(events, kind, day0, day0 + 1.0)
    if t is None:
        t = first(events, kind, day0 + 1.0, day0 + 2.0)
    return cell_time(t) if t is not None else cell("later")


def aries_mer_pass(ts, y, m, d):
    from skyfield.searchlib import find_discrete

    f = ge.discrete(lambda t: ((np.asarray(t.gast) * 15.0) % 360.0) < 180.0)
    times, values = find_discrete(ts.utc(y, m, d), ts.utc(y, m, d + 1), f)
    for t, v in zip(ge.jd_list(times), values):
        if v:
            return t
    raise RuntimeError("no Aries meridian passage on %04d-%02d-%02d" % (y, m, d))


def build_day(ts, eph, stars, date):
    from skyfield import almanac
    from skyfield.api import wgs84

    y, m, d = date
    day0 = civil_jd(y, m, d)
    jds, hv = hourly(ts, eph, y, m, d)

    hours = []
    for h in range(25):
        row = {"hour": h, "jd_utc": c.jd(jds[h]), "gha_aries_deg": c.deg(hv["aries"][h])}
        for name in ["Sun", "Moon"] + [p for p, _ in PLANETS]:
            gha, dec, _ra, dist = hv[name]
            entry = [c.deg(gha[h]), c.deg(dec[h])]
            if name == "Moon":
                hp = math.degrees(math.asin(EARTH_RADIUS_KM / dist[h])) * 60.0
                entry.append(c.arcmin(hp))
                if h < 24:
                    dgha = unwrap_change(gha[h], gha[h + 1], 1.0)
                    entry.append(c.arcmin((dgha - MOON_ADOPTED_DEG_PER_H) * 60.0))
                    entry.append(c.arcmin((dec[h + 1] - dec[h]) * 60.0))
            row[name.lower()] = c.Inline(entry)
            hidden = hv.get(name + " hidden")
            if hidden and hidden[h] is not None:
                row[name.lower() + "_no_deflection"] = c.Inline(
                    [c.deg(hidden[h][0]), c.deg(hidden[h][1])])
        hours.append(c.Inline(row))

    t12 = ts.utc(y, m, d, 12)
    noon = day0 + 0.5
    e12 = eph["earth"].at(t12)
    sun_app = e12.observe(eph["sun"]).apparent()
    sun_sd, _ = c.sun_disc(float(sun_app.distance().au))
    moon_app = e12.observe(eph["moon"]).apparent()
    moon_sd = math.degrees(math.asin(MOON_K * EARTH_RADIUS_KM / float(moon_app.distance().km))) * 60.0

    # Greenwich meridian passages (0 N 0 E), and every rise/set search.
    topo0 = wgs84.latlon(0.0, 0.0)
    sgha = hv["Sun"][0]
    sun_ev0 = ge.transits(ge.Body(eph, eph["sun"], topo0, 0.0, ge.SUN_H0), ts.utc(y, m, d), ts.utc(y, m, d + 2))
    moon_ev0 = ge.transits(ge.Body(eph, eph["moon"], topo0, 0.0, ge.moon_h0), ts.utc(y, m, d), ts.utc(y, m, d + 2))

    planets = []
    for name, key in PLANETS:
        gha, dec = hv[name][0], hv[name][1]
        v = (unwrap_change(gha[0], gha[24], 24.0) / 24.0 - PLANET_ADOPTED_DEG_PER_H) * 60.0
        dd = (dec[24] - dec[0]) / 24.0 * 60.0
        ast = e12.observe(eph[key])
        ra12, _dec12, _ = ast.apparent().radec(epoch="date")
        mag, _r, _ph = gp.heliocentric_magnitude(ts, eph, key, t12, ast)
        ev = ge.transits(ge.Body(eph, eph[key], topo0, 0.0, ge.STAR_H0), ts.utc(y, m, d), ts.utc(y, m, d + 2))
        entry = {
            "body": name,
            "v_arcmin": c.arcmin(v),
            "d_arcmin": c.arcmin(dd),
            "sha_deg": c.deg((360.0 - float(ra12.hours) * 15.0) % 360.0),
            "magnitude": None if mag is None else c.Num(mag, 4),
            "mer_pass": passage_cell(ev, "transit", day0),
        }
        hidden = behind_the_sun(eph, t12, eph[key])[0]
        if hidden is not None:
            ura = (float(t12.gast) * 15.0 - hidden[0]) % 360.0
            entry["sha_deg_no_deflection"] = c.deg((360.0 - ura) % 360.0)
        planets.append(c.Inline(entry))

    # Moon age and phase: quarters of (Moon - Sun) ecliptic longitude.
    q = ge.quarters(ts, eph, ge.moon_minus_sun, (y, m, d - 31), (y, m, d + 1), 1.0)
    new_moons = [t for t, k in q if k == 0 and t <= noon]
    phase = [(ge.PHASE_KINDS[k], t) for t, k in q if day0 <= t < day0 + 1.0]
    frac = float(almanac.fraction_illuminated(eph, "moon", t12))

    eot = [
        ((sgha[0] - 15.0 * (0 - 12.0) + 180.0) % 360.0 - 180.0) * 240.0,
        ((sgha[12] - 15.0 * (12 - 12.0) + 180.0) % 360.0 - 180.0) * 240.0,
    ]
    sdec = hv["Sun"][1]

    stars_out = []
    for name in c.STAR_NAMES:
        app = e12.observe(stars[name]).apparent()
        ra, dec, _ = app.radec(epoch="date")
        stars_out.append(c.Inline([name, c.deg((360.0 - float(ra.hours) * 15.0) % 360.0),
                                   c.deg(float(dec.degrees))]))

    # The rise, set and twilight tables.
    rows = []
    for lat in LATITUDES:
        topo = wgs84.latlon(float(lat), 0.0)
        sun_body = ge.Body(eph, eph["sun"], topo, 0.0, ge.SUN_H0)
        w = ge.sun_window(sun_body, time_of(ts, day0 - 0.5), time_of(ts, day0 + 1.5))

        def alt_at(jd, body=sun_body):
            return float(body.alt(time_of(ts, jd)))

        sun_cells_, margins = sun_cells(w["events"], alt_at, day0)
        moon_body = ge.Body(eph, eph["moon"], topo, 0.0, ge.moon_h0)
        t_start = time_of(ts, day0 - 0.5)
        rs, above = ge.rise_set(moon_body, t_start, time_of(ts, day0 + 3.0))
        row = {"lat_deg": lat}
        row.update(sun_cells_)
        row["moonrise"] = [moon_cells(rs, above, day0 + k, "rise") for k in (0, 1)]
        row["moonset"] = [moon_cells(rs, above, day0 + k, "set") for k in (0, 1)]
        row["sun_alt_at_passages"] = c.Inline(margins)
        rows.append(c.Inline(row))

    return {
        "date": "%04d-%02d-%02d" % date,
        "jd_utc": c.jd(day0),
        "hours": hours,
        "aries_mer_pass": cell_time(aries_mer_pass(ts, y, m, d)),
        "sun": c.Inline({
            "sd_arcmin": c.arcmin(sun_sd),
            "d_arcmin": c.arcmin((sdec[24] - sdec[0]) / 24.0 * 60.0),
            "eot_00h_s": c.secs(eot[0]),
            "eot_12h_s": c.secs(eot[1]),
            "mer_pass": passage_cell(sun_ev0, "transit", day0),
        }),
        "moon": c.Inline({
            "sd_arcmin": c.arcmin(moon_sd),
            "illuminated_fraction": c.Num(frac, 7),
            "age_days": c.Num(noon - new_moons[-1], 6),
            "phase": None if not phase else c.Inline([phase[0][0], c.jd(phase[0][1])]),
            "mer_pass_upper": passage_cell(moon_ev0, "transit", day0),
            "mer_pass_lower": passage_cell(moon_ev0, "lower_transit", day0),
        }),
        "planets": planets,
        "stars": stars_out,
        "rise_set": rows,
    }


def build():
    ts = c.load_timescale(dut1_zero=True)
    eph = c.run_ephemeris()
    df = c.load_hipparcos_frame()
    stars, _rows, problems = c.build_stars(df)
    if problems:
        raise RuntimeError("star identity doubts: %s" % problems)
    days = []
    kinds = {}
    dates = [d for d in DATES if c.in_window(civil_jd(*d))]
    for date in dates:
        t0 = _time.time()
        day = build_day(ts, eph, stars, date)
        for row in day["rise_set"]:
            for k, v in row.o.items():
                cells = v if isinstance(v, list) else [v]
                for x in cells:
                    if isinstance(x, c.Inline) and isinstance(x.o, list) and isinstance(x.o[0], str):
                        kinds[x.o[0]] = kinds.get(x.o[0], 0) + 1
        days.append(day)
        print("   %s done in %.1f s" % (day["date"], _time.time() - t0))
    print("   cell kinds over all days: %s" % kinds)
    return {
        "schema": "skyfix.reference/1",
        "name": "almanac_days",
        "generator": c.generator_block(
            tool="tools/reference/gen_almanac.py",
            description=(
                "Every quantity of a daily almanac page (CONVENTIONS 13.9) for %d dates "
                "in %s from Skyfield + %s, UT1 = UTC on the UTC scale."
                % (len(dates), c.RUN.window_text, c.kernel_label())
            ),
            tolerance_arcmin=c.Num(0.1, 1),
            tolerance_justification=(
                "The page's own precision: 0.1' for every angle, v, d, HP and SD; 0.1 for "
                "magnitudes; 1 min for every time (Aries' meridian passage 0.1 min); 1 s "
                "for the equation of time."
            ),
            frame_notes=c.GEOCENTRIC_FRAME_NOTES,
            timescale=c.project_timescale_facts(),
            extra={
                "run": c.RUN.facts(),
                "frame_of_date": c.app_frame_facts(),
                "ephemeris": c.run_kernel_facts(),
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "stars": ("Hipparcos with SIMBAD radial velocities and rigorous space motion; "
                          "Rigil Kentaurus (alpha Cen A) on its ORB6 orbit (common.build_stars)"),
                "time": (
                    "The app's clock (CONVENTIONS 15.2): UTC 1972-2035 with UT1 = UTC (DUT1 = 0, "
                    "CONVENTIONS 6), UT (= UT1) outside, TT from SkyFix Lab's own Delta T. "
                    "Julian dates are jd_utc, the clock's (86 400 s per day)."
                ),
                "hours": (
                    "25 rows, 00h to 24h of the date; the 25th (00h of the next date, "
                    "built as such so a leap second cannot move it) only for v and d. "
                    "sun, venus ... saturn: [GHA deg, Dec deg]; moon: [GHA deg, Dec deg, "
                    "HP arcmin, v arcmin, d arcmin] (v and d from this hour to the next; "
                    "absent in the 25th row). <planet>_no_deflection: [GHA, Dec] without "
                    "light deflection, present only while the planet is behind the solar "
                    "disc (Skyfield's solar deflection above the limb value, 1.76\"), "
                    "where Skyfield applies the formula without bound and the project's "
                    "provider caps it at the limb; likewise sha_deg_no_deflection."
                ),
                "cells": (
                    "['time', jd_utc], ['above'] (box), ['below'] (filled box), "
                    "['all_night'] (////), ['later'] (--), ['unavailable']."
                ),
                "search": (
                    "skyfield.searchlib.find_discrete on a one-minute grid (gen_events): "
                    "a body grazing a threshold for under a minute may be missed; "
                    "`sun_alt_at_passages` records the Sun's altitude at the passages so "
                    "a test can recognise such a case."
                ),
                "latitudes": LATITUDES,
                "dates": ["%04d-%02d-%02d" % dd for dd in dates],
            },
        ),
        "days": days,
    }


# ---------------------------------------------------------------------------
# USNO
# ---------------------------------------------------------------------------

#: Whole hours of pages in DATES (so each is a row of the page): past and present only,
#: where USNO's clock agrees with UTC + leap seconds (docs/ACCURACY.md section 9).
USNO_INSTANTS = [(2000, 2, 29, 6), (2016, 12, 31, 18), (2026, 9, 24, 0), (2026, 9, 24, 12)]
USNO_BODIES = [("Sun", "sun"), ("Moon", "moon")] + PLANETS
#: Latitude, UT date: one-day rise, set and civil twilight at the Greenwich meridian.
USNO_ONEDAY = [(50.0, (2026, 9, 24)), (0.0, (2026, 9, 24)), (-40.0, (2026, 9, 24)),
               (60.0, (2000, 2, 29)), (-35.0, (2000, 2, 29)), (40.0, (2016, 12, 31))]


def build_usno():
    ts = c.load_timescale(dut1_zero=True)
    eph = c.run_ephemeris()
    celnav = []
    for y, m, d, h in USNO_INSTANTS:
        t = ts.utc(y, m, d, h)
        for name, key in USNO_BODIES:
            gha, dec, _ra, _dist = geocentric(eph, t, eph[key])
            lat = round(float(dec), 4)
            lon = round(((-float(gha) + 180.0) % 360.0) - 180.0, 4)
            url = ("https://aa.usno.navy.mil/api/celnav?date=%04d-%02d-%02d&time=%02d:00:00"
                   "&coords=%.4f,%.4f" % (y, m, d, h, lat, lon))
            raw = ge.fetch(url)
            celnav.append({
                "utc": "%04d-%02d-%02dT%02d:00:00Z" % (y, m, d, h),
                "query_at_ground_point_of": name,
                "url": url,
                "response": c.Inline(gu._to_num(raw["properties"])),
            })
            print("   USNO celnav %04d-%02d-%02d %02dh at %s's ground point: %d objects"
                  % (y, m, d, h, name, len(raw["properties"]["data"])))
    oneday = []
    for lat, (y, m, d) in USNO_ONEDAY:
        url = ("https://aa.usno.navy.mil/api/rstt/oneday?date=%04d-%02d-%02d"
               "&coords=%.4f,%.4f&tz=0" % (y, m, d, lat, 0.0))
        raw = ge.fetch(url)["properties"]["data"]
        oneday.append(c.Inline({
            "lat_deg": c.deg(lat), "date": "%04d-%02d-%02d" % (y, m, d), "url": url,
            "sundata": raw.get("sundata", []), "moondata": raw.get("moondata", []),
        }))
        print("   USNO rstt %04d-%02d-%02d at %+.0f: %s / %s"
              % (y, m, d, lat, raw.get("sundata"), raw.get("moondata")))
    return {
        "schema": "skyfix.reference/1",
        "name": "almanac_usno",
        "generator": c.generator_block(
            tool="tools/reference/gen_almanac.py",
            description=(
                "US Naval Observatory API answers for spot checks of the daily almanac "
                "pages: Celestial Navigation Data at %d whole hours, each queried at the "
                "ground point of the Sun, the Moon, Venus, Mars, Jupiter and Saturn so "
                "that body is above the horizon; one-day rise/set/civil twilight at the "
                "Greenwich meridian for %d latitude-dates. Responses verbatim."
                % (len(USNO_INSTANTS), len(USNO_ONEDAY))
            ),
            tolerance_arcmin=c.Num(0.1, 1),
            tolerance_justification=(
                "The page's precision: 0.1' for GHA and Dec, 1 min for times (USNO rounds "
                "to the minute). USNO's Moon runs about 10.36 s late (docs/ACCURACY.md "
                "section 7): the Moon is compared at the instant plus 10.36 s, with the "
                "same sidereal time."
            ),
            extra={
                "source": "US Naval Observatory, Astronomical Applications Department",
                "api_documentation": "https://aa.usno.navy.mil/data/api",
                "retrieved_utc": c.generated_utc(),
                "terms_of_use": (
                    "Produced by the US Naval Observatory, a US Government agency; works "
                    "of the US Government are not subject to copyright in the United "
                    "States (17 U.S.C. 105). See docs/THIRD_PARTY.md."
                ),
                "why_these_instants": (
                    "Past and present only: for future dates USNO's predicted clock "
                    "moves the Moon by its motion over tens of seconds "
                    "(docs/ACCURACY.md section 9)."
                ),
            },
        ),
        "celnav": celnav,
        "oneday": oneday,
    }


def main_usno_only():
    if c.RUN.kernel is None:
        c.setup([], None, "1990..2060", "de440s")
    try:
        doc = build_usno()
    except (OSError, subprocess.CalledProcessError, KeyError, ValueError) as e:
        print("   USNO API unreachable or changed (%s); %s left as it is, nothing "
              "fabricated." % (e, OUT_USNO))
        return
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT_USNO), doc)


def main_offline():
    main([])


def main(argv=None):
    import argparse

    argv = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--usno", action="store_true", help="also query USNO (network)")
    ap.add_argument("--usno-only", action="store_true", help="only query USNO (network)")
    c.setup(argv, None, "1990..2060", "de440s", parser=ap)
    if "--usno-only" not in argv:
        t = _time.time()
        c.write_json(os.path.join(c.FIX_REFERENCE, OUT), build())
        print("   Skyfield part done in %.0f s" % (_time.time() - t))
    if "--usno" in argv or "--usno-only" in argv:
        main_usno_only()


if __name__ == "__main__":
    main()
