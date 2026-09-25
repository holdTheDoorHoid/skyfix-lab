"""fixtures/reference/almanac_tables.json -- the Nautical Almanac's tables beyond the
daily pages, computed independently of the Rust (crates/skyfix-almanac/src/tables/).

Development-time only (docs/CONVENTIONS.md section 11): nothing here is a runtime
dependency, and no fixture is ever regenerated from Rust output.

Coded from the definitions in CONVENTIONS 13.9.1 and the module docs of tables/, with
different algorithms wherever there is a choice, so that agreement means something:

* **Increments** (minutes 0, 1, 18, 27, 44, 58, 59): exact rational arithmetic
  (fractions.Fraction) for every column, the sidereal rate taken as the exact decimal
  360.98564736629 deg a day; rounding half up on exact fractions. The Rust uses integers
  for the Sun and the Moon and f64 for Aries.
* **v or d**: v (m + 1/2) / 60 as a Fraction, half up.
* **Arc to time**: 4 minutes of time a degree, 4 seconds an arcminute.
* **Critical tables** (Sun, stars and planets 10-90 deg, dip, the Venus and Mars
  corrections): each boundary found by bisection on the exact crossing of the rounding
  threshold (dip and parallax in closed form), then the last argument at the printed
  precision that still keeps the correction above it. The Rust scans a grid.
* **0-10 deg table, non-standard conditions, the Moon**: the chain of CONVENTIONS 5
  coded again from its text: Bennett's refraction (common.bennett_refraction_arcmin),
  the Moon's semidiameter asin(0.2725076 sin HP) augmented for altitude (solved by
  bisection for the centre, not by fixed point), the parallax asin(sin HP cos h).
* **Polaris** (2016, 2026): Polaris' apparent place from Skyfield (Hipparcos + JPL
  DE440s, IAU 2000A nutation), the adopted mean position the mean of 73 places every 5
  days from January 1, a1, a2 and the azimuth at mid-column, a2 at mid-month.
* **Venus and Mars** (2024): horizontal parallax asin(6378.137 km / distance) at 0h UT
  of every day, runs of the same 0.1', and each run's critical table.

    tools/reference/.venv/bin/python -m tools.reference.gen_almanac_tables
"""

from __future__ import annotations

import math
import os
from fractions import Fraction as F

from . import common as c

OUT = "almanac_tables.json"

INCREMENT_MINUTES = [0, 1, 18, 27, 44, 58, 59]
SIDEREAL_DEG_PER_DAY = F("360.98564736629")
SUN_SD = {"oct_mar": 16.15, "apr_sep": 15.9}
SUN_HP = 8.794 / 60.0
MOON_K = 0.2725076
HP0 = 57.7
ZONES = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N"]
ADDITIONAL_ALTS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0,
                   9.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0]
A1_LATS = [0, 10, 20, 30, 40, 45, 50, 55, 60, 62, 64, 66, 68]
AZ_LATS = [0, 20, 40, 50, 55, 60, 65]
POLARIS_YEARS = [2016, 2026]
PLANET_YEAR = 2024
M_PER_FT = 0.3048


# ---------------------------------------------------------------------------
# Rounding and printing (half up, on exact values where they are exact)
# ---------------------------------------------------------------------------


def tenths_half_up(x):
    """x (a Fraction or a float) in tenths, rounded half toward +infinity."""
    if isinstance(x, F):
        return math.floor(x * 10 + F(1, 2))
    return math.floor(x * 10 + 0.5)


def fmt_tenths(t):
    s = "-" if t < 0 else ""
    return "%s%d.%d" % (s, abs(t) // 10, abs(t) % 10)


def fmt_signed(t):
    return ("+" + fmt_tenths(t)) if t > 0 else fmt_tenths(t)


def fmt_deg_min_tenths(t):
    s = "-" if t < 0 else ""
    a = abs(t)
    return "%s%d %02d.%d" % (s, a // 600, (a % 600) // 10, a % 10)


def fmt_deg_min_whole(m):
    return "%d %02d" % (m // 60, m % 60)


# ---------------------------------------------------------------------------
# Increments, v or d, arc to time
# ---------------------------------------------------------------------------


def increments(minute):
    rows = []
    for s in range(61):
        secs = 60 * minute + s
        sun = F(15, 60) * secs  # 15' a minute
        aries = SIDEREAL_DEG_PER_DAY / 24 * 60 * secs / 3600
        moon = F(859, 3600) * secs
        rows.append([fmt_deg_min_tenths(tenths_half_up(v)) for v in (sun, aries, moon)])
    corr = [fmt_tenths(tenths_half_up(F(v, 10) * (minute + F(1, 2)) / 60)) for v in range(181)]
    return {"minute": minute, "rows": rows, "corrections": corr}


def arc_to_time():
    return {
        "degrees": ["%d %02d" % divmod(4 * d, 60) for d in range(360)],
        "arcminutes": [["%d %02d" % divmod(4 * m + q, 60) for q in range(4)] for m in range(60)],
    }


# ---------------------------------------------------------------------------
# The correction chain, from CONVENTIONS 5
# ---------------------------------------------------------------------------


def refraction(ha):
    return c.bennett_refraction_arcmin(ha)


def star_corr(ha):
    return -refraction(ha)


def sun_centre(ha):
    return -refraction(ha) + SUN_HP * math.cos(math.radians(ha))


def moon_corr(ha, hp, limb):
    """Ho - Ha for the Moon's limb at apparent altitude ha, arcminutes."""
    sign = 1.0 if limb == "lower" else -1.0
    airless = ha - refraction(ha) / 60.0
    sin_hp = math.sin(math.radians(hp / 60.0))
    sd = math.degrees(math.asin(MOON_K * sin_hp)) * 60.0

    def sd_topo(h):
        ratio = math.sqrt(1 - sin_hp ** 2 * math.cos(math.radians(h)) ** 2) - sin_hp * math.sin(math.radians(h))
        return math.degrees(math.asin(math.sin(math.radians(sd / 60.0)) / ratio)) * 60.0

    # The centre h solves h = airless + sign SD'(h) / 60: bisection.
    lo, hi = airless - 0.5, airless + 0.5
    g = lambda h: h - airless - sign * sd_topo(h) / 60.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if g(lo) * g(mid) <= 0:
            hi = mid
        else:
            lo = mid
    centre = 0.5 * (lo + hi)
    p = math.degrees(math.asin(sin_hp * math.cos(math.radians(centre)))) * 60.0
    return (centre + p / 60.0 - ha) * 60.0


def dip(h_m):
    return 1.76 * math.sqrt(h_m)


# ---------------------------------------------------------------------------
# Critical tables by root-finding
# ---------------------------------------------------------------------------


def crossing(f, target, lo, hi):
    """x in [lo, hi] where the monotone f crosses target (bisection to 1e-12)."""
    flo = f(lo) - target
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        fm = f(mid) - target
        if (fm < 0) == (flo < 0):
            lo, flo = mid, fm
        else:
            hi = mid
        if hi - lo < 1e-12:
            break
    return 0.5 * (lo + hi)


def critical_increasing(value_tenths, exact, start, end, step, lookback):
    """A critical table for a correction that increases with its argument.

    value_tenths(x): the rounded correction at x; exact(x): the exact correction. Grid
    points are multiples of `step` from `start` to `end` (in units of step: integers).
    Returns (boundaries as grid integers, values in tenths).
    """
    v_start = value_tenths(start * step)
    # The first boundary: the last grid point below start with another value.
    first = start
    for i in range(start - 1, start - lookback - 1, -1):
        if value_tenths(i * step) != v_start:
            first = i
            break
    bounds = [first]
    values = []
    current = value_tenths((first + 1) * step)
    last = value_tenths(end * step)
    x = (first + 1) * step
    while current != last:
        # The correction rounds to `current` up to where it crosses current + 0.05.
        target = (current + 0.5) / 10.0
        xc = crossing(exact, target, x, end * step)
        g = math.floor(xc / step + 1e-9)
        # The last grid point that still rounds to `current`.
        while value_tenths((g + 1) * step) == current:
            g += 1
        while value_tenths(g * step) != current:
            g -= 1
        bounds.append(g)
        values.append(current)
        current = value_tenths((g + 1) * step)
        x = (g + 1) * step
    bounds.append(end)
    values.append(current)
    return bounds, values


def sun_limbs(ha, sd):
    upper = tenths_half_up(sun_centre(ha) - sd)
    return upper + round(2 * sd * 10), upper


def altitude_critical(kind):
    step = 1.0 / 60.0
    if kind == "stars_planets":
        val = lambda x: tenths_half_up(star_corr(x))
        exact = star_corr
    else:
        sd = SUN_SD[kind[4:]]
        val = lambda x: sun_limbs(x, sd)[1]
        exact = lambda x: sun_centre(x) - sd
    bounds, values = critical_increasing(val, exact, 600, 5400, step, 120)
    out_values = []
    for v in values:
        if kind == "stars_planets":
            out_values.append([fmt_signed(v)])
        else:
            sd = SUN_SD[kind[4:]]
            out_values.append([fmt_signed(v + round(2 * sd * 10)), fmt_signed(v)])
    return {"boundaries": [fmt_deg_min_whole(b) for b in bounds], "values": out_values}


def dip_critical(start, end, to_m):
    # dip is monotone decreasing as a correction (-dip); boundaries in closed form.
    val = lambda i: tenths_half_up(-dip(i / 10.0 * to_m))
    first = start
    for i in range(start - 1, start - 21, -1):
        if val(i) != val(start):
            first = i
            break
    bounds = [first]
    values = []
    current = val(first + 1)
    last = val(end)
    while current != last:
        # -dip rounds to current (tenths) while dip < -(current) / 10 + 0.05 exactly:
        # the crossing is h_m = ((-current / 10 + 0.05) / 1.76)^2.
        h_units = ((-current / 10.0 + 0.05) / 1.76) ** 2 / to_m * 10.0
        g = math.floor(h_units + 1e-9)
        while val(g + 1) == current:
            g += 1
        while val(g) != current:
            g -= 1
        bounds.append(g)
        values.append(current)
        current = val(g + 1)
    bounds.append(end)
    values.append(current)
    return {"boundaries": ["%d.%d" % divmod(b, 10) for b in bounds], "values": [[fmt_signed(v)] for v in values]}


def parallax_critical(hp):
    """Critical table of asin(sin HP cos Ha) over whole degrees, closed-form crossings."""
    val = lambda d: tenths_half_up(math.degrees(math.asin(math.sin(math.radians(hp / 60)) * math.cos(math.radians(d)))) * 60)
    bounds = [0]
    values = []
    current = val(1)
    last = val(90)
    while current != last:
        # decreasing: rounds to current while p >= (current - 0.5) / 10.
        target = (current - 0.5) / 10.0
        x = math.degrees(math.acos(math.sin(math.radians(target / 60)) / math.sin(math.radians(hp / 60))))
        g = math.floor(x + 1e-9)
        while val(g + 1) == current:
            g += 1
        while val(g) != current:
            g -= 1
        bounds.append(g)
        values.append(current)
        current = val(g + 1)
    bounds.append(90)
    values.append(current)
    return {"boundaries": [str(b) for b in bounds], "values": [[fmt_signed(v)] for v in values]}


# ---------------------------------------------------------------------------
# Direct tables
# ---------------------------------------------------------------------------


def low_table():
    minutes = list(range(0, 91, 3)) + list(range(95, 361, 5)) + list(range(370, 601, 10))
    rows = []
    for m in minutes:
        ha = m / 60.0
        row = [fmt_deg_min_whole(m)]
        for sd in (SUN_SD["oct_mar"], SUN_SD["apr_sep"]):
            lo, up = sun_limbs(ha, sd)
            row += [fmt_signed(lo), fmt_signed(up)]
        row.append(fmt_signed(tenths_half_up(star_corr(ha))))
        rows.append(row)
    return rows


def additional_table():
    rows = []
    for ha in ADDITIONAL_ALTS:
        r0 = refraction(ha)
        rows.append([fmt_signed(tenths_half_up(r0 * (1 - (1 + (6 - k) * 0.02)))) for k in range(13)])
    return rows


def moon_table():
    hps = [54.0 + 0.3 * k for k in range(26)]
    cols = []
    for col in range(18):
        start = 5 * col
        upper = [fmt_tenths(tenths_half_up(moon_corr(start + r / 6.0, HP0, "lower") - 5.0)) for r in range(30)]
        mid = start + 2.5
        base = moon_corr(mid, HP0, "lower")
        lower = [fmt_tenths(tenths_half_up(moon_corr(mid, hp, "lower") - base + 5.0)) for hp in hps]
        upper_limb = [fmt_tenths(tenths_half_up(moon_corr(mid, hp, "upper") - base + 35.0)) for hp in hps]
        cols.append({"from_deg": start, "upper": upper, "lower_limb": lower, "upper_limb": upper_limb})
    return cols


# ---------------------------------------------------------------------------
# Polaris and the planets (Skyfield)
# ---------------------------------------------------------------------------


def polaris_tables(ts, eph):
    df = c.load_hipparcos_frame()
    stars, _, problems = c.build_stars(df)
    if problems:
        raise SystemExit("\n".join(problems))
    pol = stars["Polaris"]
    earth = eph["earth"]

    def place(t):
        ra, dec, _ = earth.at(t).observe(pol).apparent().radec(epoch="date")
        return (360.0 - ra.hours * 15.0) % 360.0, dec.degrees

    tan50 = math.tan(math.radians(50))
    out = {}
    for year in POLARIS_YEARS:
        samples = [place(ts.utc(year, 1, 1 + 5 * k)) for k in range(73)]
        s_first = samples[0][0]
        sha0 = (s_first + sum(((s - s_first + 180) % 360) - 180 for s, _ in samples) / 73.0) % 360
        dec0 = sum(d for _, d in samples) / 73.0
        p0 = (90 - dec0) * 60
        months = []
        import calendar as _cal

        for m in range(1, 13):
            nd = _cal.monthrange(year, m)[1]
            months.append(place(ts.utc(year, m, 1 + nd / 2.0)))

        def second(h0):
            return 0.5 * p0 * math.sin(math.radians(p0 / 60)) * math.sin(math.radians(h0)) ** 2

        def a0(lha):
            h0 = lha + sha0
            return 58.8 - p0 * math.cos(math.radians(h0)) + second(h0) * tan50

        cols = []
        for k in range(36):
            frm = 10 * k
            mid = frm + 5
            h0 = mid + sha0
            az = []
            for lat in AZ_LATS:
                phi = math.radians(lat)
                z = math.degrees(math.atan2(-math.sin(math.radians(h0)),
                                            math.cos(phi) * math.tan(math.radians(dec0)) - math.sin(phi) * math.cos(math.radians(h0)))) % 360
                t = tenths_half_up(z) % 3600
                az.append("%d.%d" % divmod(t, 10))
            cols.append({
                "from_deg": frm,
                "a0": [fmt_deg_min_tenths(tenths_half_up(a0(frm + r))) for r in range(11)],
                "a1": [fmt_tenths(tenths_half_up(0.6 + second(h0) * (math.tan(math.radians(lat)) - tan50))) for lat in A1_LATS],
                "a2": [fmt_tenths(tenths_half_up(0.6 - (90 - d) * 60 * math.cos(math.radians(mid + s)) + p0 * math.cos(math.radians(h0)))) for s, d in months],
                "azimuth": az,
            })
        out[str(year)] = {
            "mean_sha_deg": c.deg(sha0),
            "mean_dec_deg": c.deg(dec0),
            "columns": cols,
        }
    return out


def planet_periods(ts, eph):
    earth = eph["earth"]
    out = {}
    for name, target in (("Venus", "venus"), ("Mars", "mars barycenter")):
        import datetime as dt

        start = dt.date(PLANET_YEAR, 1, 1)
        days = (dt.date(PLANET_YEAR + 1, 1, 1) - start).days
        t = ts.utc(PLANET_YEAR, 1, [1 + k for k in range(days)])
        dist = earth.at(t).observe(eph[target]).apparent().distance().km
        hps = [math.degrees(math.asin(6378.137 / d)) * 60 for d in dist]
        periods = []
        run = None
        for k, hp in enumerate(hps):
            tt = tenths_half_up(hp)
            day = (start + dt.timedelta(days=k)).isoformat()
            if run and run[2] == tt:
                run[1] = day
            else:
                if run:
                    periods.append(run)
                run = [day, day, tt]
        periods.append(run)
        out[name] = [
            {"from": a, "to": b, "hp": fmt_tenths(t), "table": parallax_critical(t / 10.0)}
            for a, b, t in periods
        ]
        out[name + "_daily_hp_arcmin"] = [c.Num(h, 5) for h in hps]
    return out


def main():
    ts = c.load_timescale()
    eph = c.load_ephemeris(c.EPHEMERIS_CROSSCHECK_FILE)  # DE440s
    doc = {
        "schema": "skyfix.reference/1",
        "generator": c.generator_block(
            tool="tools/reference/gen_almanac_tables.py",
            description=(
                "The Nautical Almanac's increments and corrections, altitude corrections "
                "(Sun, stars and planets, the Moon, dip, non-standard conditions, Venus and "
                "Mars) and Polaris tables, computed from the definitions of CONVENTIONS 13.9.1 "
                "independently of crates/skyfix-almanac/src/tables/ (see this script's "
                "docstring for the algorithms)."
            ),
            tolerance_arcmin=c.arcmin(0.1),
            tolerance_justification=(
                "Every printed value is compared as text. The formula-only tables must be "
                "identical; the ones that need an ephemeris (Polaris, Venus and Mars) may "
                "differ by one unit of the last place where the two ephemerides straddle a "
                "rounding threshold."
            ),
        ),
        "increments": [increments(m) for m in INCREMENT_MINUTES],
        "arc_to_time": arc_to_time(),
        "altitude": {
            "sun_oct_mar": altitude_critical("sun_oct_mar"),
            "sun_apr_sep": altitude_critical("sun_apr_sep"),
            "stars_planets": altitude_critical("stars_planets"),
            "low": low_table(),
            "dip_metres": dip_critical(24, 214, 1.0),
            "dip_feet": dip_critical(80, 705, M_PER_FT),
            "additional": additional_table(),
            "moon": moon_table(),
        },
        "polaris": polaris_tables(ts, eph),
        "planets": {"year": PLANET_YEAR, **planet_periods(ts, eph)},
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT), doc)


if __name__ == "__main__":
    main()
