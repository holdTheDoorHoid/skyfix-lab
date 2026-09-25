"""fixtures/reference/sun_tools_skyfield.json -- the independent reference for
`skyfix_almanac::sun_tools` (CONVENTIONS 13.10), from Skyfield + JPL DE440s.

Development-time only (docs/CONVENTIONS.md section 11): nothing here is a runtime
dependency, and no fixture is ever regenerated from Rust output. Every definition is
coded from the text of CONVENTIONS 13.9-13.10 and the published formulas, never from
the Rust source.

* **Time**: UT1 = UTC (DUT1 = 0, CONVENTIONS 6) by construction, through
  `gen_events.dut1_zero_timescale` (Skyfield's Delta-T set to 32.184 s + TAI - UTC).
  Julian dates are `jd_utc` (the UTC calendar, 86 400 s per day).
* **Positions**: `(earth + wgs84.latlon(lat, lon, elevation_m)).at(t).observe(body)
  .apparent().altaz()`: topocentric, no refraction, with Skyfield's diurnal aberration
  (at most 0.32", which CONVENTIONS 13.2 leaves out). Geocentric apparent places of date
  from `earth.at(t).observe(body).apparent().radec(epoch='date')`.

Sections:

* `equation_of_time`: `(GHA_Sun - 15 deg (UT - 12 h)) / (15 deg / h)` in seconds, GHA of
  the apparent Sun (GAST * 15 - RA of date, UT1 = UTC), at 1990-2060 instants (the 1st
  and 15th of every month of every fifth year at 12h UTC, plus seeded random instants),
  with the Sun's apparent declination.
* `galactic`: Sgr A* (RA 17h45m40.04s, Dec -29d00m28.1s) and the north galactic pole
  (RA 12h51m26.28s, Dec +27d07m42.0s), J2000/ICRS, as Skyfield `Star`s without proper
  motion: apparent RA/Dec of date and topocentric altitude/azimuth at six sites and
  twelve instants each; plus the Milky Way arch's highest point found by **brute force**
  (the highest of 3600 points along the galactic equator, built in Skyfield's own
  `galactic_frame`, then refined by golden section) -- an independent route to the
  formula the Rust code uses.
* `azimuth_crossings`: instants when the Sun or the Moon crosses a bearing (the signed
  azimuth difference wrapped to (-180, 180] changing sign continuously), found on a
  2-minute grid and refined by bisection to 1 ms, with the altitude there.
* `sunset_azimuths`: Manhattan (40.7580 N, 73.9855 W), 2026-05-20..06-02 and
  07-08..07-21: the Sun's setting (centre at -50', CONVENTIONS 13.3) and its azimuth.
* `analemma`: the Sun at 12:00 local mean time at Philadelphia on 24 dates of 2026.
* `solar_formulas`: the clear-sky formulas of Reno, Hansen & Stein (2012, SAND2012-2389)
  eqs. 18 (Haurwitz GHI) and 22-23 (Meinel DNI), and the isotropic-sky plane of array,
  evaluated in Python from their printed form at a grid of cases.

    tools/reference/.venv/bin/python -m tools.reference.gen_sun_tools \
        [--window 1990..2060] [--kernel de440s]

`--window` sets the years of the equation-of-time sample (the other sections are at
fixed 2026 dates and are kept only if the window contains them); `--kernel` names the
ephemeris.
"""

from __future__ import annotations

import math
import os
import random

import numpy as np

from . import common as c
from .gen_events import dut1_zero_timescale

OUT = "sun_tools_skyfield.json"

SGR_A = ((17.0 + 45.0 / 60.0 + 40.04 / 3600.0), -(29.0 + 28.1 / 3600.0))  # hours, degrees
NGP = ((12.0 + 51.0 / 60.0 + 26.28 / 3600.0), 27.0 + 7.0 / 60.0 + 42.0 / 3600.0)

SITES = [
    ("philadelphia", 39.9526, -75.1652, 12.0),
    ("siding_spring", -31.2733, 149.0617, 1165.0),
    ("la_palma", 28.7606, -17.8816, 2396.0),
    ("tromso", 69.6496, 18.9560, 0.0),
    ("quito", -0.1807, -78.4678, 2850.0),
    ("wellington", -41.2866, 174.7756, 0.0),
]

JD_UNIX = 2440587.5


def civil_of(jd):
    """(year, month, day, seconds of day) of a UTC-calendar Julian date (Gregorian)."""
    jdn = math.floor(jd + 0.5)
    sec = (jd + 0.5 - jdn) * 86400.0
    l = jdn + 68569
    n = 4 * l // 146097
    l = l - (146097 * n + 3) // 4
    i = 4000 * (l + 1) // 1461001
    l = l - 1461 * i // 4 + 31
    j = 80 * l // 2447
    d = l - 2447 * j // 80
    l = j // 11
    m = j + 2 - 12 * l
    y = 100 * (n - 49) + i + l
    return y, m, d, sec


def times(ts, jd_utc):
    """Skyfield Time(s) at UTC-calendar Julian date(s): UT1 = UTC on this timescale.

    Built from the calendar date and the seconds of that day, so Skyfield applies the
    leap-second offset of the instant itself (seconds counted from a far earlier date
    would carry that date's offset instead).
    """
    scalar = np.ndim(jd_utc) == 0
    parts = [civil_of(float(x)) for x in np.atleast_1d(np.asarray(jd_utc, dtype=float))]
    y, m, d, s = (np.array(v) for v in zip(*parts))
    if scalar:
        return ts.utc(int(y[0]), int(m[0]), int(d[0]), 0, 0, float(s[0]))
    return ts.utc(y, m, d, 0, 0, s)


def utc_text(jd_utc):
    import datetime as dt

    ms = round((jd_utc - JD_UNIX) * 86400000.0)
    return (dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
            + dt.timedelta(milliseconds=ms)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def civil_jd(y, m, d):
    """Julian date of a Gregorian date at 0h (Fliegel & Van Flandern)."""
    a = (14 - m) // 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    jdn = d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045
    return jdn - 0.5


# ---------------------------------------------------------------------------
# Equation of time
# ---------------------------------------------------------------------------


def eot_cases(ts, earth, sun):
    rng = random.Random(20260924)
    jds = []
    y0, y1 = c.window_years()
    for y in range(y0, y1 + 1, 5):
        for m in range(1, 13):
            for d in (1, 15):
                jds.append(civil_jd(y, m, d) + 0.5)
    lo, hi = c.RUN.window
    for _ in range(120):
        jds.append(round(lo + rng.random() * (hi - lo), 6))
    jds.sort()
    t = times(ts, jds)
    app = earth.at(t).observe(sun).apparent()
    ra, dec, _ = app.radec(epoch="date")
    out = []
    worst = 0.0
    for k, jd in enumerate(jds):
        ra_deg = float(ra.hours[k]) * 15.0
        gha = c.norm360(float(t.gast[k]) * 15.0 - ra_deg)
        day0 = math.floor(jd - 0.5) + 0.5
        ut_h = (jd - day0) * 24.0
        eot = c.norm180(gha - 15.0 * (ut_h - 12.0)) * 240.0
        worst = max(worst, abs(float(t.dut1[k])))
        out.append(c.Inline({
            "jd_utc": c.jd(jd),
            "utc": utc_text(jd),
            "eot_s": c.Num(eot, 4),
            "sun_dec_deg": c.deg(float(dec.degrees[k])),
        }))
    assert worst < 1e-6, "UT1 = UTC must hold on this timescale (DUT1 %g s)" % worst
    return out


# ---------------------------------------------------------------------------
# Galactic centre, pole and arch
# ---------------------------------------------------------------------------


def arch_top_brute(ts, earth, place, t):
    """The highest point of the galactic equator above the horizon, by brute force."""
    from skyfield.api import Star
    from skyfield.framelib import galactic_frame

    observer = (earth + place).at(t)
    rot = np.array(galactic_frame.rotation_at(t))  # ICRS -> galactic

    def alt_az(l_deg):
        l = np.radians(np.atleast_1d(l_deg))
        gal = np.array([np.cos(l), np.sin(l), np.zeros_like(l)])
        v = rot.T.dot(gal)  # galactic -> ICRS unit vectors
        ra_h = (np.degrees(np.arctan2(v[1], v[0])) % 360.0) / 15.0
        dec = np.degrees(np.arcsin(np.clip(v[2], -1.0, 1.0)))
        alt, az, _ = observer.observe(Star(ra_hours=ra_h, dec_degrees=dec)).apparent().altaz()
        return np.atleast_1d(alt.degrees), np.atleast_1d(az.degrees)

    grid = np.arange(0.0, 360.0, 0.1)
    alts, _ = alt_az(grid)
    k = int(np.argmax(alts))
    a, b = grid[k] - 0.2, grid[k] + 0.2
    g = (math.sqrt(5.0) - 1.0) / 2.0
    x1, x2 = b - g * (b - a), a + g * (b - a)
    f1, f2 = alt_az(x1)[0][0], alt_az(x2)[0][0]
    for _ in range(40):
        if f1 > f2:
            b, x2, f2 = x2, x1, f1
            x1 = b - g * (b - a)
            f1 = alt_az(x1)[0][0]
        else:
            a, x1, f1 = x1, x2, f2
            x2 = a + g * (b - a)
            f2 = alt_az(x2)[0][0]
    top_alt, top_az = alt_az(0.5 * (a + b))
    return float(top_alt[0]), float(top_az[0])


def galactic_cases(ts, earth):
    from skyfield.api import Star

    centre = Star(ra_hours=SGR_A[0], dec_degrees=SGR_A[1])
    pole = Star(ra_hours=NGP[0], dec_degrees=NGP[1])
    rng = random.Random(1742)
    out = []
    for name, lat, lon, h in SITES:
        place = c.topos(lat, lon, h)
        site = earth + place
        for _ in range(12):
            jd = round(civil_jd(1995, 1, 1) + rng.random() * 365.25 * 60.0, 6)
            t = times(ts, jd)
            gc_geo = earth.at(t).observe(centre).apparent()
            ra, dec, _ = gc_geo.radec(epoch="date")
            gc = site.at(t).observe(centre).apparent()
            alt, az, _ = gc.altaz()
            p = site.at(t).observe(pole).apparent()
            palt, paz, _ = p.altaz()
            top_alt, top_az = arch_top_brute(ts, earth, place, t)
            out.append(c.Inline({
                "site": name,
                "lat_deg": c.deg(lat),
                "lon_deg": c.deg(lon),
                "height_m": c.metres(h),
                "jd_utc": c.jd(jd),
                "utc": utc_text(jd),
                "centre_ra_deg": c.deg(float(ra.hours) * 15.0),
                "centre_dec_deg": c.deg(float(dec.degrees)),
                "centre_alt_deg": c.deg(float(alt.degrees)),
                "centre_az_deg": c.deg(float(az.degrees)),
                "pole_alt_deg": c.deg(float(palt.degrees)),
                "pole_az_deg": c.deg(float(paz.degrees)),
                "arch_top_alt_deg": c.deg(top_alt),
                "arch_top_az_deg": c.deg(top_az),
            }))
    return out


# ---------------------------------------------------------------------------
# Azimuth crossings
# ---------------------------------------------------------------------------

AZ_CASES = [
    # site, body, date (UTC day start), bearing
    ("philadelphia", "sun", (2026, 9, 24), 180.0),
    ("philadelphia", "sun", (2026, 9, 24), 250.0),
    ("philadelphia", "sun", (2026, 6, 21), 90.0),
    ("philadelphia", "moon", (2026, 9, 27), 120.0),
    ("philadelphia", "moon", (2026, 9, 27), 240.0),
    ("siding_spring", "sun", (2026, 6, 15), 0.0),
    ("siding_spring", "moon", (2026, 6, 20), 300.0),
    ("tromso", "sun", (2026, 6, 21), 0.0),
    ("tromso", "sun", (2026, 6, 21), 180.0),
    ("quito", "sun", (2026, 3, 20), 90.0),
    ("quito", "sun", (2026, 3, 21), 270.0),
    ("wellington", "moon", (2027, 1, 10), 45.0),
]


def azimuth_crossings(ts, eph):
    earth = eph["earth"]
    bodies = {"sun": eph["sun"], "moon": eph["moon"]}
    sites = {n: (la, lo, h) for n, la, lo, h in SITES}
    out = []
    for site_name, body_name, (y, m, d), bearing in AZ_CASES:
        la, lo, h = sites[site_name]
        site = earth + c.topos(la, lo, h)
        body = bodies[body_name]
        t0 = civil_jd(y, m, d)
        grid = t0 + np.arange(0, 721) * (2.0 / 1440.0)

        def at(jd):
            t = times(ts, jd)
            alt, az, _ = site.at(t).observe(body).apparent().altaz()
            return np.atleast_1d(alt.degrees), np.atleast_1d(az.degrees)

        alts, azs = at(grid)
        diff = (azs - bearing + 540.0) % 360.0 - 180.0
        for k in range(len(grid) - 1):
            da, db = diff[k], diff[k + 1]
            if (da >= 0) == (db >= 0) or abs(db - da) >= 180.0:
                continue
            a, b = grid[k], grid[k + 1]
            fa = da
            for _ in range(60):
                mid = 0.5 * (a + b)
                fm = ((at(mid)[1][0] - bearing + 540.0) % 360.0) - 180.0
                if (fm >= 0) == (fa >= 0):
                    a, fa = mid, fm
                else:
                    b = mid
                if (b - a) * 86400.0 < 0.001:
                    break
            jd = 0.5 * (a + b)
            alt, az = at(jd)
            out.append(c.Inline({
                "site": site_name,
                "lat_deg": c.deg(la),
                "lon_deg": c.deg(lo),
                "height_m": c.metres(h),
                "body": "Sun" if body_name == "sun" else "Moon",
                "bearing_deg": c.deg(bearing),
                "window": [c.jd(t0), c.jd(t0 + 1.0)],
                "jd_utc": c.jd(jd),
                "utc": utc_text(jd),
                "alt_deg": c.deg(float(alt[0])),
                "az_deg": c.deg(float(az[0])),
                "clockwise": bool(db > da),
            }))
    return out


# ---------------------------------------------------------------------------
# Manhattan sunsets and their azimuths
# ---------------------------------------------------------------------------


def sunset_azimuths(ts, eph):
    earth, sun = eph["earth"], eph["sun"]
    la, lo, h = 40.7580, -73.9855, 0.0
    site = earth + c.topos(la, lo, h)
    h0 = -50.0 / 60.0
    out = []
    dates = [(2026, 5, d) for d in range(20, 32)] + [(2026, 6, d) for d in (1, 2)]
    dates += [(2026, 7, d) for d in range(8, 22)]
    for (y, m, d) in dates:
        # Local evening: search 22:00 UTC of the date to 03:00 UTC next day.
        a = civil_jd(y, m, d) + 22.0 / 24.0
        b = a + 5.0 / 24.0

        def alt(jd):
            t = times(ts, jd)
            al, az, _ = site.at(t).observe(sun).apparent().altaz()
            return float(al.degrees) - h0, float(az.degrees)

        fa = alt(a)[0]
        assert fa > 0 and alt(b)[0] < 0, (y, m, d)
        for _ in range(60):
            mid = 0.5 * (a + b)
            fm = alt(mid)[0]
            if fm > 0:
                a, fa = mid, fm
            else:
                b = mid
            if (b - a) * 86400.0 < 0.001:
                break
        jd = 0.5 * (a + b)
        out.append(c.Inline({
            "local_date": "%04d-%02d-%02d" % (y, m, d),
            "jd_utc": c.jd(jd),
            "utc": utc_text(jd),
            "az_deg": c.deg(alt(jd)[1]),
        }))
    return {"site": {"name": "manhattan", "lat_deg": c.deg(la), "lon_deg": c.deg(lo),
                     "height_m": c.metres(h)},
            "h0_deg": c.deg(h0), "sets": out}


# ---------------------------------------------------------------------------
# Analemma
# ---------------------------------------------------------------------------


def analemma(ts, eph):
    earth, sun = eph["earth"], eph["sun"]
    la, lo, h = 39.9526, -75.1652, 12.0
    site = earth + c.topos(la, lo, h)
    out = []
    for m in range(1, 13):
        for d in (1, 15):
            jd = civil_jd(2026, m, d) + (12.0 - lo / 15.0) / 24.0
            t = times(ts, jd)
            alt, az, _ = site.at(t).observe(sun).apparent().altaz()
            out.append(c.Inline({
                "local_date": "2026-%02d-%02d" % (m, d),
                "jd_utc": c.jd(jd),
                "alt_deg": c.deg(float(alt.degrees)),
                "az_deg": c.deg(float(az.degrees)),
            }))
    return {"site": {"name": "philadelphia", "lat_deg": c.deg(la), "lon_deg": c.deg(lo),
                     "height_m": c.metres(h)},
            "time_h": c.Num(12.0, 1), "clock": "lmt", "points": out}


# ---------------------------------------------------------------------------
# Solar formulas, from their printed form
# ---------------------------------------------------------------------------


def solar_formulas():
    cases = []
    for z in (0.0, 10.0, 30.0, 45.0, 60.0, 70.0, 80.0, 85.0, 88.0):
        for r in (0.98329, 1.0, 1.01671):
            cz = math.cos(math.radians(z))
            ghi = 1098.0 * cz * math.exp(-0.057 / cz)  # Reno et al. eq. 18
            e0 = 1361.0 / (r * r)
            dni = e0 * 0.7 ** ((1.0 / cz) ** 0.678)  # eqs. 22-23
            dni = min(dni, ghi / cz)
            dhi = max(ghi - dni * cz, 0.0)
            cases.append(c.Inline({
                "apparent_zenith_deg": c.Num(z, 3), "sun_distance_au": c.Num(r, 5),
                "ghi_w_m2": c.Num(ghi, 6), "dni_w_m2": c.Num(dni, 6),
                "dhi_w_m2": c.Num(dhi, 6),
            }))
    poa = []
    rng = random.Random(61)
    for _ in range(40):
        z = rng.uniform(0.0, 89.0)
        saz = rng.uniform(0.0, 360.0)
        tilt = rng.choice([0.0, 10.0, 25.0, 40.0, 60.0, 90.0])
        paz = rng.choice([90.0, 135.0, 180.0, 225.0, 270.0, 0.0])
        albedo = rng.choice([0.0, 0.2, 0.6])
        cz = math.cos(math.radians(z))
        ghi = 1098.0 * cz * math.exp(-0.057 / cz)
        dni = min(1361.0 * 0.7 ** ((1.0 / cz) ** 0.678), ghi / cz)
        dhi = max(ghi - dni * cz, 0.0)
        b = math.radians(tilt)
        cos_t = cz * math.cos(b) + math.sin(math.radians(z)) * math.sin(b) * math.cos(
            math.radians(saz - paz))
        beam = dni * max(cos_t, 0.0)
        sky = dhi * (1.0 + math.cos(b)) / 2.0
        ground = ghi * albedo * (1.0 - math.cos(b)) / 2.0
        poa.append(c.Inline({
            "apparent_zenith_deg": c.Num(z, 6), "sun_az_deg": c.Num(saz, 6),
            "tilt_deg": c.Num(tilt, 1), "panel_az_deg": c.Num(paz, 1),
            "albedo": c.Num(albedo, 2), "sun_distance_au": c.Num(1.0, 1),
            "poa_w_m2": c.Num(beam + sky + ground, 6),
            "incidence_deg": c.Num(math.degrees(math.acos(max(-1.0, min(1.0, cos_t)))), 6),
        }))
    return {
        "source": (
            "M. J. Reno, C. W. Hansen, J. S. Stein, 'Global Horizontal Irradiance Clear "
            "Sky Models: Implementation and Analysis', Sandia National Laboratories, "
            "SAND2012-2389 (2012), eq. 18 (Haurwitz) and eqs. 22-23 (Meinel & Meinel); "
            "plane of array: isotropic sky (Liu & Jordan 1963). E0 = 1361 W/m2 / r^2 "
            "(Kopp & Lean 2011)."
        ),
        "clear_sky": cases,
        "plane_of_array": poa,
    }


def build():
    ts = dut1_zero_timescale()
    eph = c.run_ephemeris()
    earth, sun = eph["earth"], eph["sun"]
    print("   equation of time ...")
    eot = eot_cases(ts, earth, sun)
    print("   galactic centre and arch (brute force) ...")
    gal = galactic_cases(ts, earth)
    print("   azimuth crossings ...")
    az = azimuth_crossings(ts, eph)
    print("   Manhattan sunsets ...")
    sets = sunset_azimuths(ts, eph)
    print("   analemma ...")
    ana = analemma(ts, eph)
    doc = {
        "schema": "skyfix.reference/1",
        "name": "sun_tools_skyfield",
        "generator": c.generator_block(
            tool="tools/reference/gen_sun_tools.py",
            description=(
                "References for skyfix_almanac::sun_tools: equation of time, galactic "
                "centre and arch, azimuth crossings, Manhattan sunset azimuths, an "
                "analemma, and the clear-sky formulas (module docstring)."
            ),
            tolerance_arcmin=c.Num(0.6, 1),
            tolerance_justification=(
                "CONVENTIONS 13.10 targets, enforced by crates/skyfix-almanac/tests/"
                "sun_tools_reference.rs: equation of time within 1 s; directions within "
                "0.01 deg (0.6'); instants within 1 s; formulas to 1e-6."
            ),
            extra={
                "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE,
                                          c.EPHEMERIS_CROSSCHECK_URL),
                "time": (
                    "UT1 = UTC (DUT1 = 0, CONVENTIONS 6): Skyfield is given Delta-T = "
                    "32.184 s + (TAI - UTC). Julian dates are jd_utc (UTC calendar, "
                    "86 400 s per day)."
                ),
                "altitude": (
                    "(earth + wgs84.latlon(lat, lon, elevation_m=height_m)).at(t)"
                    ".observe(body).apparent().altaz(): topocentric, no refraction, "
                    "with diurnal aberration (<= 0.32\") that CONVENTIONS 13.2 omits."
                ),
                "galactic": (
                    "Sgr A* RA 17h45m40.04s Dec -29d00m28.1s and the north galactic pole "
                    "RA 12h51m26.28s Dec +27d07m42.0s (J2000), Skyfield Star, no proper "
                    "motion. The arch top is the highest of 3600 points of galactic "
                    "latitude 0 in skyfield.framelib.galactic_frame, refined by golden "
                    "section (its pole differs from the one above by under 1\")."
                ),
            },
        ),
        "equation_of_time": eot,
        "galactic": gal,
        "azimuth_crossings": az,
        "sunset_azimuths": sets,
        "analemma": ana,
        "solar_formulas": solar_formulas(),
    }
    return doc


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "1990..2060", "de440s")
    c.require_in_window(civil_jd(2026, 7, 1), "the fixed 2026 sections")
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT), build())


if __name__ == "__main__":
    main()
