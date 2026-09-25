"""Reference fixtures for the Moon in detail (development-time only).

    tools/reference/.venv/bin/python -m tools.moon.gen_reference [libration] [apsides] [occultations]

Writes, independently of the Rust code (CONVENTIONS section 11: never from Rust output):

* ``fixtures/reference/moon_libration.json`` — the Moon's orientation from Skyfield with
  JPL's DE440 lunar orientation: NAIF's binary PCK ``moon_pa_de440_200625.bpc`` (the
  principal-axes frame integrated with DE440, 1550-2650) and frame kernel
  ``moon_de440_250416.tf`` (the constant rotation to the mean Earth/polar axis frame
  ``MOON_ME_DE440_ME421``, aligned with DE421's). Two kinds of case:

  - ``frame_cases`` (1550-2650, DE440): the Moon's and the Sun's apparent geocentric
    places of date as Skyfield gives them, and the sub-Earth point, the sub-solar point
    and the position angle of the Moon's north pole they imply. A test feeds the same
    places to the Rust orientation model, so these test the model alone, over the whole
    validated span, whatever the ephemeris coverage of the build;
  - ``observer_cases`` (1990-2060, DE440s): the whole chain for observers on the WGS84
    ellipsoid and for the Earth's centre, on a timescale with UT1 = UTC exactly (the
    explorer's DUT1 = 0, CONVENTIONS 13.2): the sub-observer point (topocentric
    libration), the sub-solar point, the pole's position angle as the observer sees it,
    the colongitude and the topocentric distance.

  Convention: the sub-observer point is where the line from the Moon's centre to the
  observer meets the surface, with the Moon where the observer sees it (light-time and
  aberration, SPICE's ``LT+S``), its orientation at the moment the light left it; the
  sub-solar point is where the Sun's apparent direction seen from the Moon meets it.

* ``fixtures/reference/moon_apsides.json`` — every perigee and apogee of 1990-2060 (the
  least and greatest geometric Earth-Moon centre distance, Skyfield + DE440s,
  ``searchlib.find_minima``/``find_maxima``, in TT) with its distance; every new and full
  Moon of the same span with the distance at that instant; the supermoon and micromoon
  classification those numbers give under the definition in CONVENTIONS 13.10; and the
  apogee of 1988 October of Meeus's example 50.a.

* ``fixtures/reference/moon_occultations.json`` — lunar occultations of bright stars and
  planets for observers on the WGS84 ellipsoid: disappearance and reappearance when the
  topocentric separation of the Moon's centre and the body equals the Moon's topocentric
  semidiameter (mean limb, radius 0.2725076 x 6378.14 km), from Skyfield's apparent
  topocentric places (UT1 = UTC), with the position angle on the limb and the Moon's and
  the Sun's altitudes. See ``build_occultations`` for how the events were chosen.

Needs ``tools/reference/data/{de440s.bsp, de440.bsp, hip_main.dat,
moon_pa_de440_200625.bpc, moon_de440_250416.tf}``; the last two come from
https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ (``pck/`` and ``fk/satellites/``).
"""

from __future__ import annotations

import math
import os
import sys

import numpy as np

from tools.reference import common as c

DATA = c.DATA
DE440 = os.path.join(DATA, "de440.bsp")
PCK = os.path.join(DATA, "moon_pa_de440_200625.bpc")
FK = os.path.join(DATA, "moon_de440_250416.tf")
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"

#: The Moon's radius the engine uses for its semidiameter: k a, k = 0.2725076 (IAU 1982),
#: a = 6378.14 km (the value ELP 2000-82B was built with).
MOON_RADIUS_KM = 0.2725076 * 6378.14
ARCSEC = math.pi / 648000.0


def ut1_equals_utc(cache, ts_builtin, y, mo, d, h=0, mi=0, s=0.0):
    """A Time for this UTC calendar instant on a timescale where UT1 = UTC exactly."""
    from skyfield.api import load

    t = ts_builtin.utc(y, mo, d, h, mi, s)
    jd_utc = c.jd_utc_of(t)
    tai_minus_utc = round((float(t.tai) - jd_utc) * 86400.0)
    if tai_minus_utc not in cache:
        cache[tai_minus_utc] = load.timescale(delta_t=32.184 + tai_minus_utc)
    t_eq = cache[tai_minus_utc].utc(y, mo, d, h, mi, s)
    assert abs(float(t_eq.dut1)) < 1e-6, (y, mo, d, float(t_eq.dut1))
    return t_eq, jd_utc


class LunarFrames:
    """The DE440 mean-Earth frame, one Skyfield frame per PCK segment."""

    def __init__(self):
        from skyfield.api import load
        from skyfield.planetarylib import PlanetaryConstants

        pc = PlanetaryConstants()
        pc.read_text(load.open(FK))
        pc.read_binary(load.open(PCK))
        code = pc._get_assignment("FRAME_MOON_ME_DE440_ME421")
        self.frames = []
        for seg in pc._segment_list:
            frame = pc.build_frame(code, _segment=seg)
            self.frames.append((seg.initial_jd, seg.final_jd, frame))

    def rotation(self, t):
        """ICRF -> MOON_ME_DE440_ME421 at the TDB of `t` (a scalar Time)."""
        jd = float(t.tdb)
        for a, b, frame in self.frames:
            if a <= jd <= b:
                return np.asarray(frame.rotation_at(t))
        raise ValueError("no lunar orientation for JD %s" % jd)


def latlon(v):
    v = np.asarray(v, dtype=float)
    r = math.sqrt(float(v @ v))
    return math.degrees(math.asin(v[2] / r)), c.norm180(math.degrees(math.atan2(v[1], v[0])))


def position_angle(u, p):
    """Position angle of direction p seen at unit vector u, north through east, degrees."""
    e = np.array([-u[1], u[0], 0.0])
    e /= np.linalg.norm(e)
    n = np.cross(u, e)
    return c.norm360(math.degrees(math.atan2(float(p @ e), float(p @ n))))


def unit_radec(ra_deg, dec_deg):
    a, d = math.radians(ra_deg), math.radians(dec_deg)
    return np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])


def orientation_case(ts, eph, frames, t, observer):
    """Everything one case records, for `observer` (a Skyfield position; the Earth or a
    topos on it) at Time `t`."""
    moon, sun = eph["moon"], eph["sun"]
    astrometric = observer.at(t).observe(moon)
    app = astrometric.apparent()
    v = np.asarray(app.position.km, dtype=float)  # observer -> Moon, GCRS axes
    tau = float(astrometric.light_time)
    t_emit = ts.tdb_jd(float(t.tdb) - tau)
    r = frames.rotation(t_emit)
    sub_obs = latlon(r @ (-v))
    sun_from_moon = np.asarray(moon.at(t_emit).observe(sun).apparent().position.km, dtype=float)
    sub_sol = latlon(r @ sun_from_moon)
    pole_icrf = r.T @ np.array([0.0, 0.0, 1.0])
    pole_date = np.asarray(t.M) @ pole_icrf
    ra, dec, dist = app.radec(epoch="date")
    u = unit_radec(ra._degrees, dec.degrees)
    pa = position_angle(u, pole_date)
    # The geometric observer-Moon distance at t (the apparent vector's length is a
    # barycentric light-time length that includes the Earth's own motion over tau,
    # up to 39 km).
    geometric_km = float(np.linalg.norm(
        np.asarray(moon.at(t).position.km) - np.asarray(observer.at(t).position.km)
    ))
    return {
        "sub_observer": (sub_obs[0], sub_obs[1]),
        "sub_solar": (sub_sol[0], sub_sol[1]),
        "pole_pa": pa,
        "distance_km": geometric_km,
        "apparent_distance_km": float(dist.km),
        "moon_radec_date": (float(ra._degrees), float(dec.degrees)),
        "light_time_days": tau,
    }


# ---------------------------------------------------------------------------
# Libration
# ---------------------------------------------------------------------------

OBSERVER_SITES = [
    # name, lat, lon, height_m
    ("equator_0e", 0.0, 0.0, 0.0),
    ("philadelphia", 39.9526, -75.1652, 10.0),
    ("tokyo", 35.6762, 139.6503, 40.0),
    ("south_60s", -60.0, -45.0, 0.0),
    ("north_70n", 70.0, 25.0, 0.0),
    ("altiplano_4000m", -16.5, -68.15, 4000.0),
]
OBSERVER_CASES_PER_SITE = 40
GEOCENTRIC_CASES = 60
FRAME_CASES = 330


def build_libration():
    from skyfield.api import load, load_file, wgs84

    ts = c.load_timescale()
    frames = LunarFrames()
    eph440 = load_file(DE440)
    eph440s = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    rng = np.random.default_rng(20260925)

    # Frame cases over 1550-2650 (TT): Skyfield's places in, the orientation out.
    frame_cases = []
    lo = ts.tt(1550, 1, 3).tt
    hi = ts.tt(2650, 1, 20).tt
    earth440 = eph440["earth"]
    for k in range(FRAME_CASES):
        jd_tt = float(lo + (hi - lo) * (k + rng.random()) / FRAME_CASES)
        t = ts.tt_jd(jd_tt)
        o = orientation_case(ts, eph440, frames, t, earth440)
        s_app = earth440.at(t).observe(eph440["sun"]).apparent()
        sra, sdec, sdist = s_app.radec(epoch="date")
        frame_cases.append(
            c.Inline(
                {
                    "jd_tt": c.jd(jd_tt),
                    "moon_ra_deg": c.deg(o["moon_radec_date"][0]),
                    "moon_dec_deg": c.deg(o["moon_radec_date"][1]),
                    "moon_distance_km": c.Num(o["apparent_distance_km"], 4),
                    "moon_light_time_s": c.Num(o["light_time_days"] * 86400.0, 6),
                    "sun_ra_deg": c.deg(float(sra._degrees)),
                    "sun_dec_deg": c.deg(float(sdec.degrees)),
                    "sun_distance_km": c.Num(float(sdist.km), 1),
                    "sub_earth_lat_deg": c.deg(o["sub_observer"][0]),
                    "sub_earth_lon_deg": c.deg(o["sub_observer"][1]),
                    "sub_solar_lat_deg": c.deg(o["sub_solar"][0]),
                    "sub_solar_lon_deg": c.deg(o["sub_solar"][1]),
                    "pole_position_angle_deg": c.deg(o["pole_pa"]),
                }
            )
        )

    # Observer cases over 1990-2060 (UTC, UT1 = UTC), the whole chain.
    cache = {}
    observer_cases = []
    earth = eph440s["earth"]

    def random_instant():
        y = int(rng.integers(1990, 2061))
        mo = int(rng.integers(1, 13))
        d = int(rng.integers(1, 29))
        return y, mo, d, int(rng.integers(0, 24)), int(rng.integers(0, 60)), float(rng.integers(0, 60))

    sites = [("geocentre", None, None, None)] + OBSERVER_SITES
    for name, lat, lon, h in sites:
        n = GEOCENTRIC_CASES if lat is None else OBSERVER_CASES_PER_SITE
        observer = earth if lat is None else earth + wgs84.latlon(lat, lon, elevation_m=h)
        for _ in range(n):
            y, mo, d, hh, mi, ss = random_instant()
            t, jd_utc = ut1_equals_utc(cache, ts, y, mo, d, hh, mi, ss)
            o = orientation_case(ts, eph440s, frames, t, observer)
            rec = {
                "utc": t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
                "jd_utc": c.jd(jd_utc),
                "sub_observer_lat_deg": c.deg(o["sub_observer"][0]),
                "sub_observer_lon_deg": c.deg(o["sub_observer"][1]),
                "sub_solar_lat_deg": c.deg(o["sub_solar"][0]),
                "sub_solar_lon_deg": c.deg(o["sub_solar"][1]),
                "colongitude_deg": c.deg(c.norm360(90.0 - o["sub_solar"][1])),
                "pole_position_angle_deg": c.deg(o["pole_pa"]),
                "distance_km": c.Num(o["distance_km"], 4),
                "semidiameter_arcmin": c.arcmin(
                    math.degrees(math.asin(MOON_RADIUS_KM / o["distance_km"])) * 60.0
                ),
            }
            if lat is None:
                rec["observer"] = None
            else:
                rec["observer"] = c.Inline(
                    {"name": name, "lat_deg": c.deg(lat), "lon_deg": c.deg(lon), "height_m": c.metres(h)}
                )
                alt, _az, _ = observer.at(t).observe(eph440s["moon"]).apparent().altaz()
                rec["moon_alt_deg"] = c.deg(float(alt.degrees))
            observer_cases.append(c.Inline(rec))

    obj = {
        "schema": "skyfix.reference/1",
        "generator": c.generator_block(
            "tools/moon/gen_reference.py libration",
            "The Moon's orientation (libration, sub-solar point, position angle of the "
            "axis) from Skyfield with JPL's DE440 lunar orientation, mean Earth/polar "
            "axis frame MOON_ME_DE440_ME421.",
            c.arcmin(0.05 * 60.0),
            "EXPANSION_PLAN P8: libration within 0.05 degrees of Skyfield.",
            extra={
                "kernels": {
                    "orientation": c.file_facts(PCK, NAIF + "pck/moon_pa_de440_200625.bpc"),
                    "frames": c.file_facts(FK, NAIF + "fk/satellites/moon_de440_250416.tf"),
                    "ephemeris_frame_cases": c.file_facts(
                        DE440, NAIF + "spk/planets/de440.bsp"
                    ),
                    "ephemeris_observer_cases": c.file_facts(
                        c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL
                    ),
                },
                "frame_check": (
                    "moon_de440_250416.tf's own example (Earth relative to the Moon at "
                    "2022 SEP 30 TDB, geometric) is reproduced to 1 mm in MOON_ME and "
                    "MOON_PA by this Skyfield setup."
                ),
                "convention": (
                    "Sub-observer point: the line from the Moon's centre to the observer, "
                    "the Moon at its apparent place (light-time and aberration, SPICE "
                    "LT+S), its orientation at the emission time. Sub-solar point: the "
                    "Sun's apparent direction seen from the Moon at the emission time. "
                    "Position angle: of the lunar north pole projected on the sky at the "
                    "Moon's apparent direction, true equator and equinox of date, north "
                    "through east. Selenographic longitude east-positive, (-180, 180]."
                ),
                "ut1": (
                    "observer_cases: UT1 = UTC exactly (load.timescale(delta_t = 32.184 "
                    "+ TAI-UTC) per leap-second era), so the Earth's rotation carries "
                    "DUT1 = 0 as the explorer does. frame_cases are in TT and need no UT1."
                ),
            },
        ),
        "frame_cases": frame_cases,
        "observer_cases": observer_cases,
        "meeus_53a": {
            "source": (
                "Meeus, Astronomical Algorithms, 2nd ed. (1998), example 53.a: the Moon "
                "on 1992 April 12 at 0h TD (JDE 2448724.5), the printed results"
            ),
            "jd_tt": c.jd(2448724.5),
            "lambda_deg": c.deg(133.167265),
            "beta_deg": c.deg(-3.229126),
            "dpsi_deg": c.deg(0.004610),
            "optical_lon_deg": c.Num(-1.206, 3),
            "optical_lat_deg": c.Num(4.194, 3),
            "physical_lon_deg": c.Num(-0.025, 3),
            "physical_lat_deg": c.Num(0.006, 3),
            "total_lon_deg": c.Num(-1.23, 2),
            "total_lat_deg": c.Num(4.20, 2),
            "axis_position_angle_deg": c.Num(15.08, 2),
            "sub_solar_lon_deg": c.Num(67.89, 2),
            "sub_solar_lat_deg": c.Num(1.46, 2),
            "colongitude_deg": c.Num(22.11, 2),
            "rho_deg": c.Num(-0.01042, 5),
            "sigma_deg": c.Num(-0.01574, 5),
            "tau_deg": c.Num(0.02673, 5),
        },
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "moon_libration.json"), obj)


def main(argv):
    which = set(argv) or {"libration", "apsides", "occultations"}
    if "libration" in which:
        build_libration()
    if "apsides" in which:
        build_apsides()
    if "occultations" in which:
        build_occultations()
    return 0


# ---------------------------------------------------------------------------
# Apsides and supermoons
# ---------------------------------------------------------------------------

#: Meeus, Astronomical Algorithms (2nd ed.), example 50.a: the apogee of 1988 October,
#: by his chapter-50 series, 1988 October 7 at 20h30m TD (JDE 2447442.3543).
MEEUS_50A_JDE = 2447442.3543


def build_apsides():
    from skyfield import almanac
    from skyfield.api import load_file

    ts = c.load_timescale()
    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
    earth, moon = eph["earth"], eph["moon"]

    def distance(t):
        return (moon - earth).at(t).distance().km

    def dist_tt(jd_tt):
        return float(distance(ts.tt_jd(jd_tt)))

    def golden(f, a, b, tol=1e-7):
        g = (math.sqrt(5.0) - 1.0) / 2.0
        x1, x2 = b - g * (b - a), a + g * (b - a)
        f1, f2 = f(x1), f(x2)
        while b - a > tol:
            if f1 < f2:
                b, x2, f2 = x2, x1, f1
                x1 = b - g * (b - a)
                f1 = f(x1)
            else:
                a, x1, f1 = x1, x2, f2
                x2 = a + g * (b - a)
                f2 = f(x2)
        return 0.5 * (a + b)

    def extremes(t0, t1):
        """Every local minimum and maximum of the distance: samples every 6 hours
        (vectorised), then golden-section refinement of each on the exact distance to
        1e-7 day (skyfield's find_maxima reported a spurious duplicate apogee here)."""
        step = 0.25
        jd = np.arange(float(t0.tt), float(t1.tt), step)
        d = distance(ts.tt_jd(jd))
        out = []
        for i in range(1, len(jd) - 1):
            if d[i] <= d[i - 1] and d[i] < d[i + 1]:
                x = golden(dist_tt, jd[i - 1], jd[i + 1])
                out.append(("perigee", x, dist_tt(x)))
            elif d[i] >= d[i - 1] and d[i] > d[i + 1]:
                x = golden(lambda t: -dist_tt(t), jd[i - 1], jd[i + 1])
                out.append(("apogee", x, dist_tt(x)))
        return out

    # The search runs a month beyond each end so every syzygy has both neighbours.
    t0, t1 = ts.utc(1989, 12, 1), ts.utc(2061, 2, 1)
    events = extremes(t0, t1)
    for a, b in zip(events, events[1:]):
        assert a[0] != b[0], "perigee and apogee must alternate: %s %s" % (a, b)

    lo, hi = ts.utc(1990, 1, 1).tt, ts.utc(2061, 1, 1).tt
    apsides = [
        c.Inline([k, c.jd(t), c.Num(d, 4)]) for (k, t, d) in events if lo <= t <= hi
    ]

    tph, yph = almanac.find_discrete(ts.utc(1990, 1, 1), ts.utc(2061, 1, 1), almanac.moon_phases(eph))
    syz = []
    for t, y in zip(tph, yph):
        if int(y) not in (0, 2):
            continue
        tt = float(t.tt)
        d = float(distance(t))
        # The perigee and the apogee on either side of the syzygy in time.
        k = next(i for i, e in enumerate(events) if e[1] > tt)
        pair = (events[k - 1], events[k])
        per = next(e for e in pair if e[0] == "perigee")
        apo = next(e for e in pair if e[0] == "apogee")
        frac = (apo[2] - d) / (apo[2] - per[2])
        syz.append(
            {
                "kind": "new_moon" if int(y) == 0 else "full_moon",
                "jd_tt": tt,
                "utc_year": int(t.utc.year),
                "distance_km": d,
                "perigee_jd_tt": per[1],
                "perigee_km": per[2],
                "apogee_jd_tt": apo[1],
                "apogee_km": apo[2],
                "fraction": frac,
            }
        )
    by_year = {}
    for s_ in syz:
        if s_["kind"] == "full_moon":
            by_year.setdefault(s_["utc_year"], []).append(s_["distance_km"])
    rows = []
    for s_ in syz:
        full = s_["kind"] == "full_moon"
        year = by_year.get(s_["utc_year"], [])
        flags = ""
        flags += "S" if s_["fraction"] >= 0.9 else ""
        flags += "M" if s_["fraction"] <= 0.1 else ""
        flags += "L" if full and s_["distance_km"] == min(year) else ""
        flags += "s" if full and s_["distance_km"] == max(year) else ""
        rows.append(
            c.Inline(
                [
                    "full" if full else "new",
                    c.jd(s_["jd_tt"]),
                    c.Num(s_["distance_km"], 4),
                    c.jd(s_["perigee_jd_tt"]),
                    c.Num(s_["perigee_km"], 4),
                    c.jd(s_["apogee_jd_tt"]),
                    c.Num(s_["apogee_km"], 4),
                    c.Num(s_["fraction"], 6),
                    flags,
                ]
            )
        )

    # Meeus 50.a: the apogee of 1988 October, the whole search in TT around it.
    m = [e for e in extremes(ts.tt_jd(MEEUS_50A_JDE - 5.0), ts.tt_jd(MEEUS_50A_JDE + 5.0))
         if e[0] == "apogee"]
    assert len(m) == 1, m
    ta = ts.tt_jd([m[0][1]])
    da = [m[0][2]]
    meeus = {
        "source": (
            "Meeus, Astronomical Algorithms, 2nd ed. (1998), example 50.a: the apogee of "
            "1988 October by his chapter-50 series, 1988 October 7 at 20h30m TD"
        ),
        "meeus_jde": c.jd(MEEUS_50A_JDE),
        "skyfield_jd_tt": c.jd(float(ta.tt[0])),
        "skyfield_utc": ta[0].utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
        "skyfield_distance_km": c.Num(float(da[0]), 4),
    }

    obj = {
        "schema": "skyfix.reference/1",
        "generator": c.generator_block(
            "tools/moon/gen_reference.py apsides",
            "Perigees and apogees of the Moon 1990-2060 (least and greatest geometric "
            "Earth-Moon centre distance), new and full Moons with their distance, and "
            "the supermoon/micromoon classification of CONVENTIONS 13.10.",
            c.arcmin(0.0),
            "EXPANSION_PLAN P8: apsides within 2 minutes and 10 km of Skyfield.",
            extra={
                "method": (
                    "(moon - earth).at(t).distance().km from Skyfield + DE440s, sampled "
                    "every 6 hours in TT, each local extremum refined by golden-section "
                    "search to 1e-7 day (skyfield.searchlib.find_maxima reported a "
                    "spurious duplicate apogee in 2022 and was not used); phases from "
                    "skyfield.almanac.moon_phases; instants in TT (jd_tt), so no UT1 "
                    "assumption enters. apsides rows are [kind, jd_tt, distance_km]."
                ),
                "classification": (
                    "perigee_fraction = (d_apogee - d) / (d_apogee - d_perigee) with the "
                    "perigee and apogee on either side of the syzygy in time; supermoon "
                    ">= 0.9, micromoon "
                    "<= 0.1 (Nolle 1979); largest/smallest of the year among the full "
                    "Moons of the UTC calendar year."
                ),
                "syzygy_columns": [
                    "kind (new|full)", "jd_tt", "distance_km", "perigee_jd_tt",
                    "perigee_km", "apogee_jd_tt", "apogee_km", "perigee_fraction",
                    "flags: S supermoon, M micromoon, L largest full Moon of the year, "
                    "s smallest",
                ],
                "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
            },
        ),
        "apsides": apsides,
        "syzygies": rows,
        "meeus_50a": meeus,
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "moon_apsides.json"), obj)
    n_super = sum(1 for s_ in syz if s_["fraction"] >= 0.9)
    print("  %d apsides, %d syzygies (%d supermoons); Meeus 50.a apogee %s, %.1f km"
          % (len(apsides), len(rows), n_super, meeus["skyfield_utc"], float(da[0])))


def build_occultations():
    raise NotImplementedError


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
