"""fixtures/reference/moon_geocentric.json and fixtures/reference/moon_topocentric.json

The independent reference for `skyfix_ephemeris::moon` and
`skyfix_ephemeris::topocentric`: Skyfield with JPL DE440s (primary) and DE421
(cross-check). Development-time only; never regenerated from Rust output
(CONVENTIONS section 11).

moon_geocentric.json -- apparent geocentric Moon of date (CONVENTIONS section 7) at
about 1750 epochs over 1990-2060:

  * 1200 random instants, uniform in UTC, whole seconds, seeded;
  * 100 perigees and 100 apogees (distance minima and maxima found with DE440s,
    evenly spread over the window, rounded to the second);
  * 100 northern and 100 southern declination extremes, evenly spread, plus every
    extreme beyond 28.3 degrees (the major lunar standstills around 2006, 2024-2025
    and 2043);
  * a few fixed instants (the window's edges, J2000, the USNO cross-check instant).

Per instant: GHA twice (`gha_deg` on Skyfield's UT1 and `gha_deg_dut1_zero` with UT1
= UTC, common.py's convention), Dec, RA, apparent ecliptic longitude and latitude of
date, geometric and light-time distances, horizontal parallax asin(6378.14 km / d),
semidiameter asin(0.2725076 * 6378.14 km / d), phase angle and illuminated fraction
(Skyfield's `phase_angle` / `fraction_illuminated`), elongation (the separation of
the apparent Sun and Moon) and the bright-limb position angle (Skyfield's
`position_angle_of` for the apparent Sun seen from the apparent Moon).

moon_topocentric.json -- topocentric altitude and azimuth without refraction at
12 sites (tropics, 60+ degrees of latitude both north and south, one at 2000 m, both
hemispheres, the antimeridian) for 50 instants each at which the Moon is above -2
degrees, plus the Sun and four stars whenever they are above -2 degrees at the same
instant. Here **UT1 = UTC by construction** on the UTC scale: every instant is built
on SkyFix Lab's clock with UT1 = UTC (`common.load_timescale(dut1_zero=True)`), so the
whole horizon frame, not just the GHA, carries DUT1 = 0; after 2035 the clock is UT1
itself (CONVENTIONS 15.2).

    tools/reference/.venv/bin/python -m tools.reference.gen_moon \
        [--window 1990..2060] [--kernel de440s]

Every instant is on the app's clock with SkyFix Lab's own Delta T
(`common.load_timescale`), so a case's TT and UT1 are the Rust side's; outside the
validated tier the frame of date is the app's long-term one (`common.use_app_frame`).
The random instants use Python datetime (years 1-9999).
"""

from __future__ import annotations

import datetime as _dt
import math
import os

import numpy as np

from . import common as c

#: CONVENTIONS 13.7 targets, which the Rust tests enforce.
TOLERANCE_GHA_DEC_ARCMIN = 0.1
TOLERANCE_HP_ARCMIN = 0.05
TOLERANCE_ILLUMINATED_FRACTION = 0.001
TOLERANCE_TOPOCENTRIC_ARCMIN = 0.1

EARTH_EQUATORIAL_RADIUS_KM = 6378.14  # IAU 1976, as the Rust provider
MOON_RADIUS_RATIO_K = 0.2725076  # IAU 1982

RANDOM_EPOCHS = 1200
EXTREME_EPOCHS = 100
STANDSTILL_DEC_DEG = 28.3
TOPO_PER_SITE = 50
TOPO_ALT_GATE_DEG = -2.0
TOPO_STARS = ["Sirius", "Vega", "Canopus", "Polaris"]

#: The window's first and last whole seconds, set from --window by `main` (the defaults
#: are 1990-01-01T00:00:00Z and 2060-12-31T23:59:59Z).
WINDOW_START = _dt.datetime(1990, 1, 1, 0, 0, 0, tzinfo=_dt.timezone.utc)
WINDOW_END = _dt.datetime(2060, 12, 31, 23, 59, 59, tzinfo=_dt.timezone.utc)
DE421_START_JD_TT = 2415020.5  # 1899-12-31, inside DE421's span
DE421_END_JD_TT = 2469807.5  # 2053-10-09


def _set_window():
    global WINDOW_START, WINDOW_END
    edges = []
    for jd in c.RUN.window:
        y, mo, d, h = c.gregorian_from_jd(jd)
        if not 1 <= y <= 9999:
            raise SystemExit("gen_moon uses Python datetime: keep --window within years 1-9999")
        edges.append(_dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)
                     + _dt.timedelta(seconds=round((jd - 2440587.5) * 86400.0)))
    WINDOW_START, WINDOW_END = edges[0], edges[1] - _dt.timedelta(seconds=1)

#: name, geodetic latitude, east longitude, height above the WGS84 ellipsoid (m)
TOPO_SITES = [
    ("equator_pacific", 0.0, -160.0, 0.0),
    ("singapore", 1.3521, 103.8198, 15.0),
    ("honolulu", 21.3069, -157.8583, 5.0),
    ("mexico_2000m", 19.4326, -99.1332, 2000.0),
    ("philadelphia", 39.9526, -75.1652, 12.0),
    ("cape_town", -33.9249, 18.4241, 0.0),
    ("sydney", -33.8688, 151.2093, 0.0),
    ("ushuaia", -54.8019, -68.3030, 0.0),
    ("reykjavik", 64.1466, -21.9426, 0.0),
    ("longyearbyen", 78.2232, 15.6267, 0.0),
    ("mcmurdo", -77.8463, 166.6682, 10.0),
    ("antimeridian_equator", 0.0, 179.99, 0.0),
]


def km(v):
    return c.Num(v, 4)


def frac(v):
    return c.Num(v, 7)


def _unix(dt):
    return int(round(dt.timestamp()))


def _from_unix(s):
    return _dt.datetime.fromtimestamp(int(s), _dt.timezone.utc)


def _round_to_second(t):
    """UTC instant of a Skyfield Time, rounded to the nearest whole second."""
    return _from_unix(round(t.utc_datetime().timestamp()))


def _spread(items, n):
    """n items evenly spread through a time-ordered list."""
    if len(items) <= n:
        return list(items)
    idx = np.linspace(0, len(items) - 1, n).round().astype(int)
    return [items[i] for i in sorted(set(idx))]


def geocentric_epochs(ts, eph):
    from skyfield.searchlib import find_maxima, find_minima

    earth, moon = eph["earth"], eph["moon"]
    rng = np.random.default_rng(20260924)
    out = []
    lo, hi = _unix(WINDOW_START), _unix(WINDOW_END)
    for s in sorted(rng.integers(lo, hi + 1, RANDOM_EPOCHS)):
        out.append((_from_unix(s), "random"))

    t0 = ts.from_datetime(WINDOW_START)
    t1 = ts.from_datetime(WINDOW_END)

    def distance(t):
        return (moon - earth).at(t).distance().km

    distance.step_days = 1.0

    def declination(t):
        return earth.at(t).observe(moon).apparent().radec(epoch="date")[1].degrees

    declination.step_days = 1.0

    tmin, _ = find_minima(t0, t1, distance)
    tmax, _ = find_maxima(t0, t1, distance)
    dmax_t, dmax_v = find_maxima(t0, t1, declination)
    dmin_t, dmin_v = find_minima(t0, t1, declination)
    for t in _spread(list(tmin), EXTREME_EPOCHS):
        out.append((_round_to_second(t), "perigee"))
    for t in _spread(list(tmax), EXTREME_EPOCHS):
        out.append((_round_to_second(t), "apogee"))
    north = _spread(list(dmax_t), EXTREME_EPOCHS)
    south = _spread(list(dmin_t), EXTREME_EPOCHS)
    north += [t for t, v in zip(dmax_t, dmax_v) if v > STANDSTILL_DEC_DEG]
    south += [t for t, v in zip(dmin_t, dmin_v) if v < -STANDSTILL_DEC_DEG]
    for t in north:
        out.append((_round_to_second(t), "dec_max"))
    for t in south:
        out.append((_round_to_second(t), "dec_min"))
    for when in (
        WINDOW_START,
        _dt.datetime(2000, 1, 1, 12, 0, 0, tzinfo=_dt.timezone.utc),
        _dt.datetime(2026, 10, 1, 1, 30, 0, tzinfo=_dt.timezone.utc),
        WINDOW_END,
    ):
        out.append((when, "fixed"))
    # One case per instant, first label wins, time order.
    seen = {}
    for when, label in out:
        if WINDOW_START <= when <= WINDOW_END:
            seen.setdefault(when, label)
    counts = {}
    for label in seen.values():
        counts[label] = counts.get(label, 0) + 1
    extremes = {
        "perigees_found": len(tmin),
        "apogees_found": len(tmax),
        "dec_maxima_found": len(dmax_t),
        "dec_minima_found": len(dmin_t),
        "max_dec_deg": float(np.max(dmax_v)),
        "min_dec_deg": float(np.min(dmin_v)),
        "min_distance_km": float(np.min(distance(tmin))),
        "max_distance_km": float(np.max(distance(tmax))),
    }
    return sorted(seen.items()), counts, extremes


def moon_record(eph, t, jd_utc):
    """Everything the Rust provider reports, from Skyfield, at one instant."""
    from skyfield.framelib import ecliptic_frame
    from skyfield.trigonometry import position_angle_of

    earth, moon, sun = eph["earth"], eph["moon"], eph["sun"]
    e = earth.at(t)
    astro = e.observe(moon)
    app = astro.apparent()
    ra, dec, dist_app = app.radec(epoch="date")
    ra_deg = float(ra._degrees)
    gha = c.norm360(float(t.gast) * 15.0 - ra_deg)
    lat, lon, _ = app.frame_latlon(ecliptic_frame)
    geometric_km = float((moon - earth).at(t).distance().km)
    sun_app = e.observe(sun).apparent()
    sra, sdec, _ = sun_app.radec(epoch="date")
    elong = float(app.separation_from(sun_app).degrees)
    limb = float(position_angle_of((dec, ra), (sdec, sra)).degrees)
    phase = float(astro.phase_angle(sun).degrees)
    fraction = float(astro.fraction_illuminated(sun))
    hp = math.degrees(math.asin(EARTH_EQUATORIAL_RADIUS_KM / geometric_km)) * 60.0
    sd = math.degrees(math.asin(MOON_RADIUS_RATIO_K * EARTH_EQUATORIAL_RADIUS_KM / geometric_km)) * 60.0
    rec = {
        "gha_deg": c.deg(gha),
        "gha_deg_dut1_zero": c.deg(c.gha_dut1_zero_deg(gha, float(t.dut1))),
        "dec_deg": c.deg(float(dec.degrees)),
        "ra_deg": c.deg(ra_deg),
        "ecliptic_longitude_deg": c.deg(float(lon.degrees)),
        "ecliptic_latitude_deg": c.deg(float(lat.degrees)),
        "distance_km": km(geometric_km),
        "distance_km_light_time": km(float(dist_app.km)),
        "horizontal_parallax_arcmin": c.arcmin(hp),
        "semidiameter_arcmin": c.arcmin(sd),
        "phase_angle_deg": c.deg(phase),
        "illuminated_fraction": frac(fraction),
        "elongation_deg": c.deg(elong),
        "bright_limb_angle_deg": c.deg(limb),
    }
    return rec, (gha, float(dec.degrees), ra_deg)


def _sep_arcsec(ra1, dec1, ra2, dec2):
    d1, d2 = math.radians(dec1), math.radians(dec2)
    dh = math.radians(c.wrap_diff_deg(ra1, ra2))
    cs = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(dh)
    return math.degrees(math.acos(max(-1.0, min(1.0, cs)))) * 3600.0


def build_geocentric(ts, eph440, eph421):
    epochs, counts, extremes = geocentric_epochs(ts, eph440)
    cases = []
    worst_421 = {"direction_arcsec": 0.0, "distance_km": 0.0, "fraction": 0.0, "n": 0}
    dut1_lo, dut1_hi = 1e9, -1e9
    for when, label in epochs:
        t = ts.from_datetime(when)
        jd_utc = c.jd_utc_of(t)
        rec, (gha, dec, ra) = moon_record(eph440, t, jd_utc)
        head = {
            "utc": t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
            "jd_utc": c.jd(jd_utc),
            "jd_tt": c.jd(float(t.tt)),
            "jd_ut1": c.jd(float(t.ut1)),
            "dut1_s": c.secs(float(t.dut1)),
            "set": label,
            "moon": rec,
        }
        dut1 = float(t.dut1)
        dut1_lo, dut1_hi = min(dut1_lo, dut1), max(dut1_hi, dut1)
        if eph421 is not None and DE421_START_JD_TT < float(t.tt) < DE421_END_JD_TT:
            rec421, (_g, dec421, ra421) = moon_record(eph421, t, jd_utc)
            worst_421["n"] += 1
            worst_421["direction_arcsec"] = max(
                worst_421["direction_arcsec"], _sep_arcsec(ra, dec, ra421, dec421)
            )
            worst_421["distance_km"] = max(
                worst_421["distance_km"], abs(rec["distance_km"].v - rec421["distance_km"].v)
            )
            worst_421["fraction"] = max(
                worst_421["fraction"],
                abs(rec["illuminated_fraction"].v - rec421["illuminated_fraction"].v),
            )
        cases.append(c.Inline(head))
    return cases, counts, extremes, worst_421, (dut1_lo, dut1_hi)


def ut1_equals_utc_time(ts, ts0, when):
    """The instant on the app's clock twice: with the IERS DUT1 (`ts`) and with UT1 = UTC
    on the UTC scale (`ts0`; the clock is UT1 after 2035 either way), and TAI - UTC there
    (None on the UT part of the clock)."""
    t = ts.from_datetime(when)
    t_eq = ts0.from_datetime(when)
    assert abs(float(t_eq.dut1)) < 1e-6, (when, float(t_eq.dut1))
    assert abs(float(t_eq.tt) - float(t.tt)) * 86400.0 < 1e-6
    jd_utc = c.jd_utc_of(t)
    on_utc = c.UTC_SCALE_JD[0] <= jd_utc < c.UTC_SCALE_JD[1]
    tai_minus_utc = round((float(t.tai) - jd_utc) * 86400.0) if on_utc else None
    return t, t_eq, tai_minus_utc


def build_topocentric(ts, eph, stars):
    from skyfield.api import wgs84

    earth, moon, sun = eph["earth"], eph["moon"], eph["sun"]
    targets = [("Moon", moon), ("Sun", sun)] + [(n, stars[n]) for n in TOPO_STARS]
    rng = np.random.default_rng(20260925)
    lo, hi = _unix(WINDOW_START), _unix(WINDOW_END)
    ts0 = c.load_timescale(dut1_zero=True)
    eras = set()
    cases = []
    counts = {"Moon": 0, "Sun": 0, "star": 0}
    worst_gha_consistency = 0.0
    for name, lat, lon, h in TOPO_SITES:
        place = wgs84.latlon(lat, lon, elevation_m=h)
        site = earth + place
        n = 0
        while n < TOPO_PER_SITE:
            when = _from_unix(int(rng.integers(lo, hi + 1)))
            t_builtin, t, era = ut1_equals_utc_time(ts, ts0, when)
            alt, _az, _d = site.at(t).observe(moon).apparent().altaz()
            if float(alt.degrees) <= TOPO_ALT_GATE_DEG:
                continue
            n += 1
            eras.add(era if era is not None else "ut")
            head = {
                "utc": t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
                "jd_utc": c.jd(c.jd_utc_of(t)),
                "jd_tt": c.jd(float(t.tt)),
                "jd_ut1": c.jd(float(t.ut1)),
                "tai_minus_utc_s": era,
                "site": {"name": name, "lat_deg": c.deg(lat), "lon_deg": c.deg(lon), "height_m": c.metres(h)},
            }
            bodies = {}
            for body, target in targets:
                app = site.at(t).observe(target).apparent()
                alt, az, dist = app.altaz()
                if float(alt.degrees) <= TOPO_ALT_GATE_DEG:
                    continue
                gha, dec, _ra, _d = c.geocentric_of(earth, t, target)
                # The DUT1 = 0 GHA two ways: on this UT1 = UTC timescale directly, and
                # as common.py derives it from the builtin timescale. They must agree.
                gha_b, _dec_b, _ra_b, _ = c.geocentric_of(earth, t_builtin, target)
                worst_gha_consistency = max(
                    worst_gha_consistency,
                    abs(c.wrap_diff_deg(gha, c.gha_dut1_zero_deg(gha_b, float(t_builtin.dut1)))) * 3600.0,
                )
                rec = {
                    "alt_deg": c.deg(float(alt.degrees)),
                    "az_deg": c.deg(float(az.degrees)),
                    "gha_deg_dut1_zero": c.deg(gha),
                    "dec_deg": c.deg(dec),
                }
                if body in ("Moon", "Sun"):
                    rec["distance_km_topocentric"] = km(float(dist.km))
                bodies[body] = rec
                counts[body if body in ("Moon", "Sun") else "star"] += 1
            head["bodies"] = bodies
            cases.append(c.Inline(head))
    return cases, counts, sorted(eras, key=str), worst_gha_consistency


MOON_FRAME_NOTES = {
    "definition": (
        "Apparent geocentric of date (CONVENTIONS section 7): true equator and equinox of date."
    ),
    "computed_as": (
        "earth.at(t).observe(moon).apparent().radec(epoch='date'); GHA = normalise(t.gast * 15 - RA) "
        "into [0, 360). The light-time solution uses barycentric positions and aberration uses the "
        "Earth's barycentric velocity, which for the Moon cancel to about 1 mas and leave the "
        "geocentric position at the retarded time t - r/c (about 0.7 arcsec from the geometric one)."
    ),
    "gha_columns": (
        "gha_deg uses the UT1 of SkyFix Lab's own timescale (the IERS table on the UTC scale); "
        "gha_deg_dut1_zero is the same GHA with UT1 = UTC (common.gha_dut1_zero_deg), the "
        "CONVENTIONS section 6 convention. After 2035 the clock is UT1 and they coincide. Test "
        "DUT1 = 0 implementations against gha_deg_dut1_zero."
    ),
    "ecliptic": "frame_latlon(skyfield.framelib.ecliptic_frame): true ecliptic and equinox of date",
    "distance_km": "geometric geocentric distance at t, (moon - earth).at(t)",
    "distance_km_light_time": "length of the apparent position vector (light-time distance)",
    "horizontal_parallax_arcmin": "asin(6378.14 km / distance_km) (IAU 1976 equatorial radius)",
    "semidiameter_arcmin": "asin(0.2725076 * 6378.14 km / distance_km) (IAU 1982 k)",
    "phase_angle_deg": "Skyfield ICRF.phase_angle(sun) on the astrometric Moon: Sun-Moon-Earth angle with light-time",
    "illuminated_fraction": "Skyfield ICRF.fraction_illuminated(sun) = (1 + cos(phase angle)) / 2",
    "elongation_deg": "separation of the apparent Moon and the apparent Sun seen from the geocentre",
    "bright_limb_angle_deg": (
        "skyfield.trigonometry.position_angle_of((dec, ra) of the Moon, (dec, ra) of the Sun), both "
        "apparent of date: the position angle of the Sun from the Moon's centre, north through east, "
        "which is the position angle of the bright limb's midpoint (Meeus eq. 48.5). Ill-defined "
        "within a few degrees of new or full moon."
    ),
}


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "1990..2060", "de440s")
    _set_window()
    ts = c.load_timescale()
    eph440 = c.run_ephemeris()
    eph421 = c.load_kernel("de421") if c.RUN.kernel != "de421" else None

    cases, counts, extremes, worst_421, dut1_range = build_geocentric(ts, eph440, eph421)
    print(
        "   geocentric: %d instants %s; DE421 vs DE440s over %d: direction %.4f\" distance %.4f km"
        % (len(cases), counts, worst_421["n"], worst_421["direction_arcsec"], worst_421["distance_km"])
    )
    geo = {
        "schema": "skyfix.reference/1",
        "name": "moon_geocentric",
        "generator": c.generator_block(
            tool="tools/reference/gen_moon.py",
            description=(
                "Apparent geocentric Moon of date at %d instants over %s from Skyfield + JPL "
                "%s, with DE421 as a cross-check." % (len(cases), c.RUN.window_text, c.kernel_label())
            ),
            tolerance_arcmin=c.Num(TOLERANCE_GHA_DEC_ARCMIN, 4),
            tolerance_justification=(
                "The CONVENTIONS 13.7 targets: Moon GHA and Dec worst 0.1 arcmin, HP worst 0.05 "
                "arcmin, illuminated fraction worst 0.001. The reference is far inside them: DE421 "
                "and DE440s agree on the Moon's apparent direction to %.4f arcsec and on its distance "
                "to %.4f km over the %d instants both cover."
                % (worst_421["direction_arcsec"], worst_421["distance_km"], worst_421["n"])
            ),
            frame_notes=MOON_FRAME_NOTES,
            refraction="none; geocentric directions",
            timescale=c.project_timescale_facts(),
            extra={
                "run": c.RUN.facts(),
                "frame_of_date": c.app_frame_facts(),
                "tolerances": c.Inline(
                    {
                        "gha_dec_arcmin": c.Num(TOLERANCE_GHA_DEC_ARCMIN, 4),
                        "horizontal_parallax_arcmin": c.Num(TOLERANCE_HP_ARCMIN, 4),
                        "illuminated_fraction": c.Num(TOLERANCE_ILLUMINATED_FRACTION, 4),
                    }
                ),
                "ephemeris": c.run_kernel_facts(),
                "ephemeris_crosscheck": {
                    "file": c.file_facts(c.EPHEMERIS_FILE, c.EPHEMERIS_URL),
                    "instants_compared": worst_421["n"],
                    "max_direction_difference_arcsec": c.arcsec(worst_421["direction_arcsec"]),
                    "max_distance_difference_km": km(worst_421["distance_km"]),
                    "max_illuminated_fraction_difference": frac(worst_421["fraction"]),
                    "note": "DE421 ends 2053-10-09; later instants are DE440s only",
                },
                "instant_count": len(cases),
                "instant_sets": counts,
                "extremes_found_with_de440s": {k: c.Num(v, 4) if isinstance(v, float) else v for k, v in extremes.items()},
                "dut1_range_s": c.Inline({"min": c.secs(dut1_range[0]), "max": c.secs(dut1_range[1])}),
                "constants": c.Inline(
                    {
                        "earth_equatorial_radius_km": c.Num(EARTH_EQUATORIAL_RADIUS_KM, 3),
                        "moon_radius_ratio_k": c.Num(MOON_RADIUS_RATIO_K, 7),
                    }
                ),
            },
        ),
        "notes": [
            "Instants are whole seconds on the app's clock. Random instants are uniform over "
            "%s .. %s; extremes are found with %s "
            "(skyfield.searchlib, 1-day steps) and rounded to the nearest second, so each is "
            "within a second of the true extreme."
            % (WINDOW_START.strftime("%Y-%m-%dT%H:%M:%SZ"), WINDOW_END.strftime("%Y-%m-%dT%H:%M:%SZ"),
               c.kernel_label()),
            "The clock is UTC 1972-2035 and UT outside it (CONVENTIONS 15.2), with SkyFix Lab's own "
            "Delta T; jd_tt and jd_ut1 give each case's TT and UT1. dut1_s is UT1 - UTC from SkyFix "
            "Lab's IERS table (Bulletin A's prediction, then the Delta T model, past its end) and 0 "
            "on the UT part of the clock; gha_deg carries it and gha_deg_dut1_zero does not.",
        ],
        "cases": cases,
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "moon_geocentric.json"), geo)

    df = c.load_hipparcos_frame()
    stars, _rows, problems = c.build_stars(df)
    tcases, tcounts, eras, worst_cons = build_topocentric(ts, eph440, stars)
    print(
        "   topocentric: %d site-instants, %s; GHA consistency of the two DUT1 = 0 routes %.2e\""
        % (len(tcases), tcounts, worst_cons)
    )
    topo = {
        "schema": "skyfix.reference/1",
        "name": "moon_topocentric",
        "generator": c.generator_block(
            tool="tools/reference/gen_moon.py",
            description=(
                "Topocentric altitude and azimuth without refraction, UT1 = UTC, at %d sites x %d "
                "instants with the Moon above %.0f degrees, plus the Sun and %s when above it; "
                "Skyfield + JPL %s."
                % (len(TOPO_SITES), TOPO_PER_SITE, TOPO_ALT_GATE_DEG, ", ".join(TOPO_STARS),
                   c.kernel_label())
            ),
            tolerance_arcmin=c.Num(TOLERANCE_TOPOCENTRIC_ARCMIN, 4),
            tolerance_justification=(
                "CONVENTIONS 13.7: topocentric alt_deg / az_deg (any body) worst 0.1 arcmin. "
                "Skyfield's topocentric place includes diurnal aberration (up to 0.32 arcsec) and "
                "the observer's own light-time; skyfix_ephemeris::topocentric models neither, and "
                "both are far below the tolerance."
            ),
            frame_notes={
                "observer": "skyfield.api.wgs84.latlon(lat, lon, elevation_m=height): geodetic, WGS84 ellipsoid",
                "computed_as": "(earth + site).at(t).observe(body).apparent().altaz() with no refraction arguments",
                "altitude": "topocentric, from the plane normal to the ellipsoid normal, no refraction",
                "azimuth": "true bearing from north through east, [0, 360)",
                "ut1": (
                    "UT1 = UTC by construction on the UTC scale: each instant is built on "
                    "common.load_timescale(dut1_zero=True), SkyFix Lab's clock with UT1 = UTC "
                    "there, so t.dut1 = 0 exactly (asserted per instant); after 2035 the clock is "
                    "UT1 itself. TT, and so the positions of the bodies, are those of the app's "
                    "clock. The GHA recorded with each body comes from the same timescale and "
                    "agrees with common.gha_dut1_zero_deg applied to the IERS-DUT1 timescale to "
                    "%.1e arcsec." % worst_cons
                ),
                "polar_motion": "not applied",
            },
            refraction="none",
            timescale=c.project_timescale_facts(),
            extra={
                "run": c.RUN.facts(),
                "frame_of_date": c.app_frame_facts(),
                "ephemeris": c.run_kernel_facts(),
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "sites": [
                    c.Inline({"name": n, "lat_deg": c.deg(la), "lon_deg": c.deg(lo), "height_m": c.metres(h)})
                    for n, la, lo, h in TOPO_SITES
                ],
                "tai_minus_utc_eras_s": eras,
                "altitude_gate_deg": c.deg(TOPO_ALT_GATE_DEG),
                "case_counts": tcounts,
                "site_instant_count": len(tcases),
            },
        ),
        "notes": [
            "Each instant is chosen at random in %s and kept only if the Moon's topocentric "
            "altitude is above %.0f degrees; the Sun and the stars are listed when they are above "
            "it at the same instant." % (c.RUN.window_text, TOPO_ALT_GATE_DEG),
            "Azimuth is ill-conditioned near the zenith: an on-sky error e appears as e / cos(alt) "
            "of azimuth. Compare azimuth scaled by cos(alt), or away from the zenith.",
        ]
        + (["STAR IDENTITY DOUBTS: " + " | ".join(problems)] if problems else []),
        "cases": tcases,
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "moon_topocentric.json"), topo)


if __name__ == "__main__":
    main()
