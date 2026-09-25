"""fixtures/reference/nav_methods.json

Independent truth for the navigation methods (docs/NAVIGATION_METHODS.md): the noon
sight, latitude by Polaris, averaging a run of sights, and the running fix.

Every altitude here is what a perfect instrument would give after the CONVENTIONS
section 5 chain: the CONVENTIONS section 3 spherical altitude of the body's apparent
geocentric direction (Skyfield + JPL DE421 + Hipparcos, GHA with UT1 = UTC as
CONVENTIONS section 6 assumes) at the true position of the observer at that instant.
Sextant readings (`hs_deg`) are the same altitudes run backwards through the chain with
`common.hs_from_ho`, coded from the text of CONVENTIONS.md, never from Rust.

Truth that the Rust methods must recover, computed here independently:

* noon: the instant of meridian passage (the geocentric apparent LHA = 0, found by
  Newton iteration on Skyfield's GHA), the latitude and longitude at that instant, the
  declination there, and the meridian altitude;
* polaris: the observer's latitude, plus GHA Aries and Polaris' SHA/Dec for the
  teaching terms;
* averaging: the true altitude at the reference instant and the true rate of change
  at the DR position (a Skyfield finite difference);
* running_fix: the vessel's position at the reference instant. One case steers due
  north, where a rhumb line and a great circle are the same curve, so the truth is
  exact under any dead-reckoning model; the other steers 045 along a RHUMB line (what
  a vessel holding a compass course really does), so it measures the running fix's
  great-circle-leg approximation (docs/MOTION.md) as well.

Moving vessels in the noon and averaging cases follow the great circle through the
reference position with the stated course there, which is the model those methods
state (docs/NAVIGATION_METHODS.md, "Moving vessel").

    tools/reference/.venv/bin/python -m tools.reference.gen_nav_methods \
        [--window 1900..2100] [--kernel de421]

`--window` keeps the cases whose first instant is inside it; `--kernel` names the
ephemeris.
"""

from __future__ import annotations

import math
import os

from . import common as c

OUT = os.path.join(c.FIX_REFERENCE, "nav_methods.json")

# Observer settings for every sextant reading in this file.
HEIGHT_OF_EYE_M = 3.0
INDEX_CORRECTION_ARCMIN = -1.2
PRESSURE_HPA = 1010.0
TEMPERATURE_C = 10.0


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------


def jd_to_calendar(jd):
    """(year, month, day, seconds of day) of a UTC Julian date (Meeus ch. 7)."""
    z = math.floor(jd + 0.5)
    f = jd + 0.5 - z
    alpha = math.floor((z - 1867216.25) / 36524.25)
    a = z + 1 + alpha - math.floor(alpha / 4)
    b = a + 1524
    cc = math.floor((b - 122.1) / 365.25)
    d = math.floor(365.25 * cc)
    e = math.floor((b - d) / 30.6001)
    day = int(b - d - math.floor(30.6001 * e))
    month = int(e - 1 if e < 14 else e - 13)
    year = int(cc - 4716 if month > 2 else cc - 4715)
    return year, month, day, f * 86400.0


def calendar_to_jd(year, month, day, seconds=0.0):
    y, m = year, month
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    jd0 = math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + day + b - 1524.5
    return jd0 + seconds / 86400.0


def round_to_ms(jd):
    y, mo, d, s = jd_to_calendar(jd)
    return calendar_to_jd(y, mo, d, round(s * 1000.0) / 1000.0)


def round_to_s(jd):
    y, mo, d, s = jd_to_calendar(jd)
    return calendar_to_jd(y, mo, d, float(round(s)))


def utc_string(jd):
    """RFC 3339 with milliseconds and a Z (CONVENTIONS 6)."""
    y, mo, d, s = jd_to_calendar(jd)
    ms = int(round(s * 1000.0))
    if ms >= 86_400_000:  # rounding reached midnight
        return utc_string(calendar_to_jd(y, mo, d, 86400.0))
    hh, rem = divmod(ms, 3_600_000)
    mm, rem = divmod(rem, 60_000)
    ss, milli = divmod(rem, 1000)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, mo, d, hh, mm, ss, milli)


# ---------------------------------------------------------------------------
# Motion on the project's sphere (1 NM = 1 arcmin of arc, CONVENTIONS 1)
# ---------------------------------------------------------------------------


def great_circle_destination(lat, lon, course_deg, dist_nm):
    """Point `dist_nm` from (lat, lon) on the great circle with initial course."""
    phi1 = math.radians(lat)
    lam1 = math.radians(lon)
    th = math.radians(course_deg)
    d = math.radians(dist_nm / 60.0)
    phi2 = math.asin(
        math.sin(phi1) * math.cos(d) + math.cos(phi1) * math.sin(d) * math.cos(th)
    )
    lam2 = lam1 + math.atan2(
        math.sin(th) * math.sin(d) * math.cos(phi1),
        math.cos(d) - math.sin(phi1) * math.sin(phi2),
    )
    return math.degrees(phi2), c.norm180(math.degrees(lam2))


def rhumb_destination(lat, lon, course_deg, dist_nm):
    """Point `dist_nm` from (lat, lon) along the loxodrome of constant course."""
    phi1 = math.radians(lat)
    th = math.radians(course_deg)
    d = math.radians(dist_nm / 60.0)
    dphi = d * math.cos(th)
    phi2 = phi1 + dphi
    dpsi = math.log(math.tan(math.pi / 4 + phi2 / 2) / math.tan(math.pi / 4 + phi1 / 2))
    q = dphi / dpsi if abs(dpsi) > 1e-12 else math.cos(phi1)
    dlam = d * math.sin(th) / q
    return math.degrees(phi2), c.norm180(lon + math.degrees(dlam))


def move(lat, lon, vessel, hours):
    if vessel is None or vessel["speed_kn"] == 0.0 or hours == 0.0:
        return lat, lon
    return great_circle_destination(lat, lon, vessel["course_deg"], vessel["speed_kn"] * hours)


def offset_position(lat, lon, bearing_deg, dist_nm):
    return great_circle_destination(lat, lon, bearing_deg, dist_nm)


# ---------------------------------------------------------------------------
# The sky, from Skyfield
# ---------------------------------------------------------------------------


class Sky:
    def __init__(self):
        self.ts = c.load_timescale()
        self.eph = c.run_ephemeris()  # --kernel, DE421 by default
        self.earth = self.eph["earth"]
        self.sun = self.eph["sun"]
        df = c.load_hipparcos_frame()
        self.stars, _rows, problems = c.build_stars(df)
        if problems:
            raise RuntimeError("star identity check failed: %s" % problems)

    def time(self, jd_utc):
        y, mo, d, s = jd_to_calendar(jd_utc)
        return self.ts.utc(y, mo, d, 0, 0, s)

    def direction(self, body, jd_utc):
        """(gha_deg with UT1 = UTC, dec_deg, semidiameter_arcmin, hp_arcmin)."""
        t = self.time(jd_utc)
        target = self.sun if body == "Sun" else self.stars[body]
        gha, dec, _ra, dist = c.geocentric_of(self.earth, t, target)
        gha0 = c.gha_dut1_zero_deg(gha, float(t.dut1))
        if body == "Sun":
            sd, hp = c.sun_disc(dist)
        else:
            sd, hp = 0.0, 0.0
        return gha0, dec, sd, hp

    def gha_aries(self, jd_utc):
        t = self.time(jd_utc)
        return c.gha_dut1_zero_deg(c.norm360(float(t.gast) * 15.0), float(t.dut1))

    def altitude(self, body, jd_utc, lat, lon):
        gha, dec, _, _ = self.direction(body, jd_utc)
        return c.spherical_altitude_azimuth_deg(lat, lon, gha, dec)


def sight_record(sky, ident, body, jd, lat, lon, limb):
    gha, dec, sd, hp = sky.direction(body, jd)
    ho, zn = c.spherical_altitude_azimuth_deg(lat, lon, gha, dec)
    hs = c.hs_from_ho(
        ho,
        INDEX_CORRECTION_ARCMIN,
        HEIGHT_OF_EYE_M,
        sd,
        hp,
        limb,
        PRESSURE_HPA,
        TEMPERATURE_C,
    )["hs_deg"]
    return c.Inline(
        {
            "id": ident,
            "utc": utc_string(jd),
            "jd_utc": c.jd(jd),
            "ho_deg": c.deg(ho),
            "hs_deg": c.deg(hs),
            "limb": limb,
            "zn_deg": c.deg(zn),
            "gha_deg": c.deg(gha),
            "dec_deg": c.deg(dec),
            "semidiameter_arcmin": c.arcmin(sd),
            "horizontal_parallax_arcmin": c.arcmin(hp),
            "true_lat_deg": c.deg(lat),
            "true_lon_deg": c.deg(lon),
        }
    )


# ---------------------------------------------------------------------------
# Noon
# ---------------------------------------------------------------------------


def meridian_passage(sky, body, guess_jd, lon_at):
    """Newton on the wrapped geocentric apparent LHA; lon_at(jd) is the observer's."""

    def lha(jd):
        gha, _, _, _ = sky.direction(body, jd)
        return c.norm180(gha + lon_at(jd))

    h = 20.0 / 86400.0
    jd = guess_jd
    for _ in range(30):
        f = lha(jd)
        rate = c.wrap_diff_deg(lha(jd + h), lha(jd - h)) / (2 * h)
        step = -f / rate
        jd += step
        # A float Julian date resolves about 40 microseconds; 0.1 ms is converged.
        if abs(step) * 86400.0 < 1e-4:
            return jd
    raise RuntimeError("meridian passage did not converge for %s" % body)


def noon_case(sky, name, body, lat, lon, guess_jd, vessel, offsets_min, dr, notes):
    # Find the passage with the vessel's track pinned at the guess, then re-pin the
    # track at the passage itself, so the track is the great circle through the
    # position at T with the stated course there (the model the method states).
    ref_jd, ref_lat, ref_lon = guess_jd, lat, lon
    for _ in range(4):
        def lon_at(jd, ref_jd=ref_jd, ref_lat=ref_lat, ref_lon=ref_lon):
            return move(ref_lat, ref_lon, vessel, (jd - ref_jd) * 24.0)[1]

        t_pass = meridian_passage(sky, body, ref_jd, lon_at)
        ref_lat, ref_lon = move(ref_lat, ref_lon, vessel, (t_pass - ref_jd) * 24.0)
        ref_jd = t_pass
    gha, dec, _, _ = sky.direction(body, t_pass)
    h0, zn0 = c.spherical_altitude_azimuth_deg(ref_lat, ref_lon, gha, dec)
    limb = "lower" if body == "Sun" else "center"
    sights = []
    for k, off in enumerate(offsets_min):
        jd = round_to_s(t_pass + off / 1440.0)
        plat, plon = move(ref_lat, ref_lon, vessel, (jd - t_pass) * 24.0)
        sights.append(sight_record(sky, "n%02d" % k, body, jd, plat, plon, limb))
    return {
        "name": name,
        "body": body,
        "notes": notes,
        "vessel": c.Inline(
            {"course_deg": c.deg(vessel["course_deg"]), "speed_kn": c.deg(vessel["speed_kn"])}
        )
        if vessel
        else None,
        "dr": c.Inline({"lat_deg": c.deg(dr[0]), "lon_deg": c.deg(dr[1])}),
        "truth": c.Inline(
            {
                "passage_utc": utc_string(t_pass),
                "passage_jd_utc": c.jd(t_pass),
                "lat_deg": c.deg(ref_lat),
                "lon_deg": c.deg(ref_lon),
                "declination_deg": c.deg(dec),
                "meridian_altitude_deg": c.deg(h0),
                "azimuth_at_passage_deg": c.deg(zn0),
            }
        ),
        "sights": sights,
    }


def noon_cases(sky):
    out = []
    phl = (39.9526, -75.1652)
    guess = calendar_to_jd(2026, 9, 23, 16 * 3600 + 53 * 60)
    out.append(
        noon_case(
            sky,
            "philadelphia-equinox-sun",
            "Sun",
            phl[0],
            phl[1],
            guess,
            None,
            [m * 2.0 for m in range(-10, 11)],
            offset_position(phl[0], phl[1], 210.0, 12.0),
            "Stationary observer, Sun lower limb, 21 sights every 2 min over +/-20 min.",
        )
    )
    syd = (-33.8688, 151.2093)
    guess = calendar_to_jd(2026, 12, 21, 1 * 3600 + 55 * 60)
    out.append(
        noon_case(
            sky,
            "sydney-solstice-sun",
            "Sun",
            syd[0],
            syd[1],
            guess,
            None,
            [m * 3.0 for m in range(-8, 9)],
            offset_position(syd[0], syd[1], 30.0, 10.0),
            "Southern hemisphere, Sun north of the zenith (bears north at noon).",
        )
    )
    guess = calendar_to_jd(2026, 6, 15, 14 * 3600 + 40 * 60)
    out.append(
        noon_case(
            sky,
            "moving-north-15kn-sun",
            "Sun",
            45.0,
            -40.0,
            guess,
            {"course_deg": 10.0, "speed_kn": 15.0},
            [m * 2.0 for m in range(-10, 11)],
            offset_position(45.0, -40.0, 120.0, 8.0),
            "Vessel making 15 kn on 010: the peak comes well before meridian passage.",
        )
    )
    guess = calendar_to_jd(2026, 6, 10, 22 * 3600 + 30 * 60)
    out.append(
        noon_case(
            sky,
            "near-zenith-sun",
            "Sun",
            21.0,
            -157.9,
            guess,
            None,
            [m * 1.0 for m in range(-10, 11)],
            offset_position(21.0, -157.9, 300.0, 5.0),
            "Sun about 2 deg from the zenith at noon: a V-shaped peak.",
        )
    )
    guess = calendar_to_jd(2026, 8, 1, 4 * 3600 + 15 * 60)
    out.append(
        noon_case(
            sky,
            "altair-upper-transit",
            "Altair",
            phl[0],
            phl[1],
            guess,
            None,
            [m * 2.0 for m in range(-8, 9)],
            offset_position(phl[0], phl[1], 45.0, 10.0),
            "A star at meridian passage: any body works.",
        )
    )
    return out


# ---------------------------------------------------------------------------
# Polaris
# ---------------------------------------------------------------------------


def polaris_cases(sky):
    out = []
    base = calendar_to_jd(2026, 1, 15, 0.0)
    rows = [
        (1.0, -30.0, 2.0),
        (10.0, 120.0, 5.0),
        (25.0, -80.0, 8.0),
        (40.8, -43.4, 11.0),
        (55.0, 10.0, 14.0),
        (68.0, 20.0, 17.0),
        (75.0, -150.0, 20.0),
        (85.0, 60.0, 23.0),
        (88.5, 0.0, 3.5),
        (89.8, 45.0, 9.5),
    ]
    for lat, lon, hour in rows:
        jd = round_to_s(base + hour / 24.0)
        gha, dec, _, _ = sky.direction("Polaris", jd)
        ho, zn = c.spherical_altitude_azimuth_deg(lat, lon, gha, dec)
        aries = sky.gha_aries(jd)
        out.append(
            c.Inline(
                {
                    "name": "polaris-lat-%g" % lat,
                    "utc": utc_string(jd),
                    "jd_utc": c.jd(jd),
                    "true_lat_deg": c.deg(lat),
                    "true_lon_deg": c.deg(lon),
                    "ho_deg": c.deg(ho),
                    "azimuth_deg": c.deg(zn),
                    "gha_deg": c.deg(gha),
                    "dec_deg": c.deg(dec),
                    "gha_aries_deg": c.deg(aries),
                    "sha_deg": c.deg(c.norm360(gha - aries)),
                    "lha_aries_deg": c.deg(c.norm360(aries + lon)),
                }
            )
        )
    return out


# ---------------------------------------------------------------------------
# Averaging
# ---------------------------------------------------------------------------


def averaging_case(sky, name, body, lat, lon, start_jd, spacing_s, count, vessel, dr, notes):
    jds = [round_to_s(start_jd + k * spacing_s / 86400.0) for k in range(count)]
    t_mid = sum(jds) / len(jds)
    limb = "lower" if body == "Sun" else "center"
    sights = []
    for k, jd in enumerate(jds):
        plat, plon = move(lat, lon, vessel, (jd - t_mid) * 24.0)
        sights.append(sight_record(sky, "a%02d" % k, body, jd, plat, plon, limb))
    # Truth at the mid instant, and the altitude's rate there (arcmin per minute) at
    # the true position and at the DR, both moving with the vessel.
    def alt_at(jd, p_lat, p_lon):
        q_lat, q_lon = move(p_lat, p_lon, vessel, (jd - t_mid) * 24.0)
        return sky.altitude(body, jd, q_lat, q_lon)[0]

    h = 30.0 / 86400.0
    rate_truth = (alt_at(t_mid + h, lat, lon) - alt_at(t_mid - h, lat, lon)) * 60.0
    rate_dr = (alt_at(t_mid + h, dr[0], dr[1]) - alt_at(t_mid - h, dr[0], dr[1])) * 60.0
    return {
        "name": name,
        "body": body,
        "notes": notes,
        "vessel": c.Inline(
            {"course_deg": c.deg(vessel["course_deg"]), "speed_kn": c.deg(vessel["speed_kn"])}
        )
        if vessel
        else None,
        "dr": c.Inline({"lat_deg": c.deg(dr[0]), "lon_deg": c.deg(dr[1])}),
        "truth": c.Inline(
            {
                "reference_utc": utc_string(t_mid),
                "reference_jd_utc": c.jd(t_mid),
                "lat_deg": c.deg(lat),
                "lon_deg": c.deg(lon),
                "ho_at_reference_deg": c.deg(alt_at(t_mid, lat, lon)),
                "rate_at_truth_arcmin_per_min": c.arcmin(rate_truth),
                "rate_at_dr_arcmin_per_min": c.arcmin(rate_dr),
            }
        ),
        "sights": sights,
    }


def rising_through(sky, body, lat, lon, day_jd, altitude_deg):
    """First instant of the UTC day `day_jd` at which `body` rises through the altitude."""
    step = 5.0 / 1440.0
    prev = sky.altitude(body, day_jd, lat, lon)[0]
    jd = day_jd
    while jd < day_jd + 1.0:
        nxt = sky.altitude(body, jd + step, lat, lon)[0]
        if prev < altitude_deg <= nxt:
            lo, hi = jd, jd + step
            for _ in range(40):
                mid = 0.5 * (lo + hi)
                if sky.altitude(body, mid, lat, lon)[0] < altitude_deg:
                    lo = mid
                else:
                    hi = mid
            return round_to_s(hi)
        prev = nxt
        jd += step
    raise RuntimeError("%s does not rise through %g deg on that day" % (body, altitude_deg))


def averaging_cases(sky):
    phl = (39.9526, -75.1652)
    return [
        averaging_case(
            sky,
            "vega-run-philadelphia",
            "Vega",
            phl[0],
            phl[1],
            calendar_to_jd(2026, 10, 1, 1 * 3600 + 28 * 60 + 30),
            30.0,
            7,
            None,
            offset_position(phl[0], phl[1], 60.0, 15.0),
            "Seven sights of Vega over three minutes, stationary.",
        ),
        averaging_case(
            sky,
            "sun-morning-run-moving",
            "Sun",
            30.0,
            -40.0,
            calendar_to_jd(2026, 6, 15, 11 * 3600 + 30 * 60),
            40.0,
            6,
            {"course_deg": 90.0, "speed_kn": 12.0},
            offset_position(30.0, -40.0, 330.0, 6.0),
            "A morning Sun run from a vessel making 12 kn east (toward the Sun).",
        ),
        averaging_case(
            sky,
            "sirius-low-rising-run",
            "Sirius",
            phl[0],
            phl[1],
            rising_through(sky, "Sirius", phl[0], phl[1], calendar_to_jd(2026, 10, 1), 8.0),
            45.0,
            5,
            None,
            offset_position(phl[0], phl[1], 180.0, 10.0),
            "Sirius rising through 8 deg: refraction matters in the sextant readings.",
        ),
    ]


# ---------------------------------------------------------------------------
# Running fix
# ---------------------------------------------------------------------------


def pick_star(sky, jd, lat, lon, target_az, used):
    best = None
    for name in c.STAR_NAMES:
        if name in used or name == "Polaris":
            continue
        h, zn = sky.altitude(name, jd, lat, lon)
        if not (25.0 <= h <= 65.0):
            continue
        dz = abs(c.wrap_diff_deg(zn, target_az))
        if best is None or dz < best[0]:
            best = (dz, name)
    return best[1]


def running_fix_case(sky, name, start_lat, start_lon, start_jd, course, speed, along, notes):
    hours = [0.0, 1.5, 3.0]
    targets = [45.0, 165.0, 285.0]
    jds = [round_to_s(start_jd + h / 24.0) for h in hours]

    def pos(jd):
        run = speed * (jd - jds[0]) * 24.0
        if along == "rhumb":
            return rhumb_destination(start_lat, start_lon, course, run)
        return great_circle_destination(start_lat, start_lon, course, run)

    sights = []
    used = []
    for k, jd in enumerate(jds):
        plat, plon = pos(jd)
        star = pick_star(sky, jd, plat, plon, targets[k], used)
        used.append(star)
        sights.append(sight_record(sky, "r%d" % k, star, jd, plat, plon, "center"))
    ref_lat, ref_lon = pos(jds[-1])
    return {
        "name": name,
        "notes": notes,
        "track": c.Inline(
            {
                "start_utc": utc_string(jds[0]),
                "course_deg": c.deg(course),
                "speed_kn": c.deg(speed),
                "along": along,
            }
        ),
        "truth": c.Inline(
            {
                "reference_utc": utc_string(jds[-1]),
                "reference_jd_utc": c.jd(jds[-1]),
                "lat_deg": c.deg(ref_lat),
                "lon_deg": c.deg(ref_lon),
            }
        ),
        "sights": sights,
    }


def running_fix_cases(sky):
    start = calendar_to_jd(2026, 10, 1, 0.0)
    return [
        running_fix_case(
            sky,
            "due-north-12kn",
            40.0,
            -70.0,
            start,
            0.0,
            12.0,
            "great_circle",
            "Due north: rhumb line and great circle coincide, so the truth is exact.",
        ),
        running_fix_case(
            sky,
            "northeast-12kn-rhumb",
            40.0,
            -70.0,
            start,
            45.0,
            12.0,
            "rhumb",
            "Course 045 held as a rhumb line for 36 NM: includes the great-circle-leg "
            "approximation of skyfix-motion's dead reckoning (docs/MOTION.md).",
        ),
    ]


# ---------------------------------------------------------------------------


def _first_jd(case):
    """The instant of a case: its own jd_utc, or its first sight's."""
    if "jd_utc" in case:
        return float(case["jd_utc"].v if hasattr(case["jd_utc"], "v") else case["jd_utc"])
    s = case["sights"][0]
    s = s.o if hasattr(s, "o") else s
    v = s.get("jd_utc")
    return float(v.v if hasattr(v, "v") else v)


def _in_window(cases):
    """--window keeps the cases whose (first) instant is inside it."""
    return [k for k in cases if c.in_window(_first_jd(k.o if hasattr(k, "o") else k))]


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "1900..2100", "de421")
    sky = Sky()
    doc = {
        "schema": "skyfix.reference/1",
        "generator": c.generator_block(
            "tools/reference/gen_nav_methods.py",
            "Noise-free sights with known truth for the navigation methods: noon sight, "
            "latitude by Polaris, averaging a run, running fix.",
            c.arcmin(0.01),
            "The truth is exact by construction: every altitude is the CONVENTIONS "
            "section 3 spherical altitude of Skyfield's apparent geocentric direction "
            "(DE421, UT1 = UTC) at the stated true position. A Rust method that recovers "
            "it to 0.01 arcmin (18.5 m) is limited by its own ephemeris (Sun 0.003', "
            "stars 0.001' against this same reference, docs/ACCURACY.md), not by the "
            "method. The sextant readings add only the CONVENTIONS section 5 chain, "
            "which the Rust reducer implements from the same text.",
            frame_notes=c.GEOCENTRIC_FRAME_NOTES,
            extra={
                "observer_for_sextant_readings": {
                    "height_of_eye_m": c.Num(HEIGHT_OF_EYE_M, 3),
                    "index_correction_arcmin": c.arcmin(INDEX_CORRECTION_ARCMIN),
                    "pressure_hpa": c.Num(PRESSURE_HPA, 1),
                    "temperature_c": c.Num(TEMPERATURE_C, 1),
                    "horizon": "sea",
                },
                "motion_model": (
                    "noon and averaging: the great circle through the reference position "
                    "with the stated course there; running_fix: from the first sight, a "
                    "great circle (due north) or a rhumb line (045)."
                ),
            },
        ),
        "noon": _in_window(noon_cases(sky)),
        "polaris": _in_window(polaris_cases(sky)),
        "averaging": _in_window(averaging_cases(sky)),
        "running_fix": _in_window(running_fix_cases(sky)),
    }
    doc["generator"]["run"] = c.RUN.facts()
    c.write_json(OUT, doc)


if __name__ == "__main__":
    main()
