"""Moon and planet sights, end-to-end sessions and lunar distances, from Skyfield.

Produces
    fixtures/reference/moon_planet_sights.json
    fixtures/reference/lunar_distances.json
    fixtures/reference/nautical_twilight.json
    fixtures/sessions/reference-moon-planets-atlantic.json          (+ -sphere)
    fixtures/sessions/reference-moon-venus-timor.json               (+ -sphere)
    fixtures/expected/<each of the four>.truth.json and .expected.json

Development-time only (CONVENTIONS section 11): Skyfield 1.55 with JPL DE440s. The
Rust workspace reads the JSON and nothing else, and no number here ever comes from
Rust output.

    tools/reference/.venv/bin/python -m tools.reference.gen_moon_sights \
        [--window 2020..2039] [--kernel de440s]

`--window` is where the random sights are drawn (2020-2039 by default; the lunar
distances keep 2022-2035 then) and which fixed sessions and twilight days are kept;
years 1-9999 (Python datetime). Instants are on the app's clock with SkyFix Lab's own
Delta T and UT1 = UTC on the UTC scale (`common.load_timescale(dut1_zero=True)`).

What a sextant would read
-------------------------
Every sight is built the way the sky makes it, not by running the project's own
chain backwards:

1. Skyfield places the observer on the Earth and returns the body's **topocentric
   airless** altitude and distance (`site.at(t).observe(body).apparent().altaz()`,
   no refraction). The instant is on the app's clock with **UT1 = UTC** on the UTC
   scale (and the clock's UT outside it), so the whole horizon frame carries the
   DUT1 = 0 of CONVENTIONS 6.
2. A limb is the centre moved by the body's **topocentric** semidiameter,
   asin(R / topocentric distance), with R = 0.2725076 x 6378.14 km for the Moon (the
   Moon provider's k) and 959.63" at 1 au for the Sun. The lowest point of a small
   circle is exactly its centre's altitude less its radius.
3. Venus is sighted at its **centre of light**: its topocentric direction moved
   toward the Sun by 0.44 (1 - cos i) SD (the Nautical Almanac convention, measured
   against USNO in gen_usno_sights.py). Mars, Jupiter and Saturn are sighted at
   their centres.
4. Refraction is added with the CONVENTIONS section 5 Bennett formula (common.py,
   coded from the text), solved for the apparent altitude that refracts down to the
   true one. Skyfield's own refraction is not used (see common.py's notes: it differs
   by 0.07 % of the refraction).
5. Dip, the reflected-horizon doubling or nothing, then the index correction,
   exactly as a sextant would record them.

Two Earths
----------
`sphere`: the observer stands on a sphere of radius 6378.14 km, the radius the Moon's
horizontal parallax refers to. CONVENTIONS section 1 reduces sights on a sphere, so
on this Earth a correct chain recovers the geocentric altitude to the diurnal
aberration Skyfield includes (0.3") -- an arithmetic test of the chain.

`wgs84`: the real Earth. The observer's geocentric radius is shorter than 6378.14 km
and the plumb line does not point at the Earth's centre, so the Moon's real parallax
differs from the sphere's by up to about 0.2'. That residual is measured here and
recorded; it is what CONVENTIONS section 5 leaves out.
"""

from __future__ import annotations

import datetime as _dt
import math
import os

import numpy as np

from . import common as c

# ---------------------------------------------------------------------------
# Constants (each one the value the Rust providers use, cited)
# ---------------------------------------------------------------------------

MOON_K = 0.2725076  # IAU 1982, skyfix_ephemeris::moon::MOON_RADIUS_RATIO_K
MOON_HP_RADIUS_KM = 6378.14  # IAU 1976, the Moon provider's HP radius
PLANET_HP_RADIUS_KM = 6378.137  # WGS84, the planet provider's HP radius
MOON_RADIUS_KM = MOON_K * MOON_HP_RADIUS_KM
AU_KM = 149_597_870.700
SUN_RADIUS_KM = AU_KM * math.sin(math.radians(c.SUN_SEMIDIAMETER_ARCSEC_AT_1AU / 3600.0))
PLANET_RADIUS_KM = {  # IAU WGCCRE 2015, skyfix_ephemeris::planets::Planet
    "Venus": 6051.8,
    "Mars": 3396.19,
    "Jupiter": 71492.0,
    "Saturn": 60268.0,
}
VENUS_CENTRE_OF_LIGHT_K = 0.44  # skyfix_ephemeris::sights::VENUS_CENTRE_OF_LIGHT_K
SPHERE_RADIUS_M = MOON_HP_RADIUS_KM * 1000.0

PLANETS = ["Venus", "Mars", "Jupiter", "Saturn"]
LUNAR_STARS = [
    "Aldebaran", "Regulus", "Spica", "Antares", "Pollux", "Altair", "Hamal",
    "Markab", "Fomalhaut", "Nunki",
]

#: Tolerances the Rust tests apply (arcminutes). Arithmetic: the Rust chain against
#: the Python transcription of the CONVENTIONS text. Sphere: against Skyfield's sky on
#: the sphere of section 1.
TOLERANCE_ARITHMETIC_ARCMIN = 1e-6
TOLERANCE_SPHERE_ARCMIN = 0.01


# ---------------------------------------------------------------------------
# Skyfield set-up
# ---------------------------------------------------------------------------

class Sky:
    """DE440s, the Hipparcos stars and two Earths."""

    def __init__(self):
        from skyfield.api import load, wgs84
        from skyfield.toposlib import Geoid

        self.load = load
        self.eph = c.run_ephemeris()  # --kernel, DE440s by default
        self.earth = self.eph["earth"]
        self.sun = self.eph["sun"]
        self.moon = self.eph["moon"]
        stars, _rows, problems = c.build_stars(c.load_hipparcos_frame())
        assert not problems, problems
        self.targets = {
            "Sun": self.sun,
            "Moon": self.moon,
            "Venus": self.eph["venus barycenter"],
            "Mars": self.eph["mars barycenter"],
            "Jupiter": self.eph["jupiter barycenter"],
            "Saturn": self.eph["saturn barycenter"],
        }
        self.targets.update(stars)
        self.ts0 = c.load_timescale(dut1_zero=True)
        # A sphere: Skyfield's Geoid with a flattening of 1e-15.
        self.earths = {
            "sphere": Geoid("sphere_6378140m", SPHERE_RADIUS_M, 1e15),
            "wgs84": wgs84,
        }

    def time(self, when):
        """The app's clock instant `when`, with UT1 = UTC on the UTC scale."""
        t = self.ts0.from_datetime(when)
        assert abs(float(t.dut1)) < 1e-6, (when, float(t.dut1))
        return t

    def site(self, earth_model, lat, lon, height_m=0.0):
        return self.earth + self.earths[earth_model].latlon(lat, lon, elevation_m=height_m)


def body_kind(name):
    if name == "Sun":
        return "sun"
    if name == "Moon":
        return "moon"
    if name in PLANETS:
        return "planet"
    return "star"


# ---------------------------------------------------------------------------
# Vector helpers (ENU horizon frame: east, north, up)
# ---------------------------------------------------------------------------

def unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def enu(alt_deg, az_deg):
    a, z = math.radians(alt_deg), math.radians(az_deg)
    return np.array([math.cos(a) * math.sin(z), math.cos(a) * math.cos(z), math.sin(a)])


def alt_az(v):
    v = unit(v)
    return math.degrees(math.asin(max(-1.0, min(1.0, v[2])))), c.norm360(
        math.degrees(math.atan2(v[0], v[1]))
    )


def angle(u, v):
    u, v = unit(u), unit(v)
    return math.atan2(np.linalg.norm(np.cross(u, v)), float(np.dot(u, v)))


def toward(u, w, rho):
    """Move unit vector u by rho radians along the great circle toward w."""
    u, w = unit(u), unit(w)
    p = w - np.dot(u, w) * u
    n = np.linalg.norm(p)
    if n == 0.0 or rho == 0.0:
        return u
    return math.cos(rho) * u + math.sin(rho) * (p / n)


def radec_unit(ra_deg, dec_deg):
    r, d = math.radians(ra_deg), math.radians(dec_deg)
    return np.array([math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d)])


def radec_of(v):
    v = unit(v)
    return c.norm360(math.degrees(math.atan2(v[1], v[0]))), math.degrees(math.asin(v[2]))


# ---------------------------------------------------------------------------
# Geocentric (almanac) quantities, CONVENTIONS section 7
# ---------------------------------------------------------------------------

def phase_angle_deg(sky, t, name):
    return float(sky.earth.at(t).observe(sky.targets[name]).phase_angle(sky.sun).degrees)


def geocentric(sky, t, name):
    """Apparent geocentric GHA (UT1 = UTC), Dec, SD, HP and distance of a body.

    Venus is returned at its centre of light (module doc). SD and HP follow the Rust
    providers: the Moon from its geometric distance, the planets from the light-time
    distance, the Sun from 959.63" and 8.794" at 1 au.
    """
    target = sky.targets[name]
    app = sky.earth.at(t).observe(target).apparent()
    ra, dec, dist = app.radec(epoch="date")
    ra_deg, dec_deg = float(ra._degrees), float(dec.degrees)
    sd = hp = 0.0
    dist_km = None
    if name == "Moon":
        dist_km = float((sky.moon - sky.earth).at(t).distance().km)
        hp = math.degrees(math.asin(MOON_HP_RADIUS_KM / dist_km)) * 60.0
        sd = math.degrees(math.asin(MOON_RADIUS_KM / dist_km)) * 60.0
    elif name == "Sun":
        dist_km = float(dist.km)
        sd, hp = c.sun_disc(float(dist.au))
    elif name in PLANETS:
        dist_km = float(dist.km)
        hp = math.degrees(math.asin(PLANET_HP_RADIUS_KM / dist_km)) * 60.0
        sd = math.degrees(math.asin(PLANET_RADIUS_KM[name] / dist_km)) * 60.0
    if name == "Venus":
        sra, sdec, _ = sky.earth.at(t).observe(sky.sun).apparent().radec(epoch="date")
        i = phase_angle_deg(sky, t, name)
        rho = math.radians(VENUS_CENTRE_OF_LIGHT_K * (1 - math.cos(math.radians(i))) * sd / 60.0)
        moved = toward(radec_unit(ra_deg, dec_deg), radec_unit(float(sra._degrees), float(sdec.degrees)), rho)
        ra_deg, dec_deg = radec_of(moved)
    gha = c.norm360(float(t.gast) * 15.0 - ra_deg)
    return {
        "gha_deg": gha,
        "dec_deg": dec_deg,
        "ra_deg": ra_deg,
        "semidiameter_arcmin": sd,
        "horizontal_parallax_arcmin": hp,
        "distance_km": dist_km,
    }


# ---------------------------------------------------------------------------
# Topocentric truth
# ---------------------------------------------------------------------------

def topocentric(sky, t, site, name):
    """Airless topocentric altitude, azimuth, ENU vector, distance and SD of a body's
    centre (Venus: centre of light) as Skyfield sees it from `site`."""
    app = site.at(t).observe(sky.targets[name]).apparent()
    alt, az, dist = app.altaz()
    v = enu(float(alt.degrees), float(az.degrees))
    dist_km = float(dist.km) if name not in sky.targets or body_kind(name) != "star" else None
    sd = 0.0
    if name == "Moon":
        sd = math.degrees(math.asin(MOON_RADIUS_KM / dist_km)) * 60.0
    elif name == "Sun":
        sd = math.degrees(math.asin(SUN_RADIUS_KM / dist_km)) * 60.0
    elif name in PLANETS:
        sd = math.degrees(math.asin(PLANET_RADIUS_KM[name] / dist_km)) * 60.0
    if name == "Venus":
        s_alt, s_az, _ = site.at(t).observe(sky.sun).apparent().altaz()
        i = phase_angle_deg(sky, t, name)
        rho = math.radians(VENUS_CENTRE_OF_LIGHT_K * (1 - math.cos(math.radians(i))) * sd / 60.0)
        v = toward(v, enu(float(s_alt.degrees), float(s_az.degrees)), rho)
    a, z = alt_az(v)
    return {"alt_deg": a, "az_deg": z, "vec": v, "distance_km": dist_km, "sd_arcmin": sd}


# ---------------------------------------------------------------------------
# Refraction, the CONVENTIONS section 5 Bennett formula, both directions
# ---------------------------------------------------------------------------

def refraction(h_app_deg, p, t):
    return c.bennett_refraction_arcmin(h_app_deg, p, t)


def apparent_from_true(h_true_deg, p, t):
    """The apparent altitude H with H - R(H) = h (fixed point; R' contracts)."""
    h_app = h_true_deg + refraction(max(h_true_deg, 0.0), p, t) / 60.0
    for _ in range(500):
        nxt = h_true_deg + refraction(h_app, p, t) / 60.0
        if abs(nxt - h_app) < 1e-14:
            return nxt
        h_app = nxt
    raise RuntimeError("refraction inverse did not converge at %r" % h_true_deg)


# ---------------------------------------------------------------------------
# The amended CONVENTIONS section 5 chain, transcribed from the text
# ---------------------------------------------------------------------------

def topocentric_sd_arcmin(sd, hp, h_deg):
    """Section 5 step 4 (Moon): sin SD' = sin SD / (sqrt(1 - sin^2 HP cos^2 h) - sin HP sin h)."""
    s_hp = math.sin(math.radians(hp / 60.0))
    s_h, c_h = math.sin(math.radians(h_deg)), math.cos(math.radians(h_deg))
    ratio = math.sqrt(1.0 - s_hp * s_hp * c_h * c_h) - s_hp * s_h
    return math.degrees(math.asin(math.sin(math.radians(sd / 60.0)) / ratio)) * 60.0


def rigorous_parallax_arcmin(hp, h_deg):
    """Section 5 step 5 (Moon, planets): p = asin(sin HP cos h)."""
    return math.degrees(
        math.asin(math.sin(math.radians(hp / 60.0)) * math.cos(math.radians(h_deg)))
    ) * 60.0


def chain(hs, kind, limb, horizon, ic, hoe, p, t, sd, hp):
    """Section 5 from a raw sextant reading to Ho, as the amended text states it."""
    h = hs + ic / 60.0
    if horizon == "sea":
        h -= c.dip_arcmin(hoe) / 60.0
    elif horizon == "artificial_reflected":
        h /= 2.0
    ha = h
    h -= refraction(ha, p, t) / 60.0
    sign = {"lower": 1.0, "upper": -1.0, "center": 0.0}[limb]
    if kind == "sun":
        h += sign * sd / 60.0
        h += hp * math.cos(math.radians(ha)) / 60.0
    elif kind == "moon":
        if sign != 0.0:
            h_limb = h
            s = topocentric_sd_arcmin(sd, hp, h_limb)
            h = h_limb + sign * s / 60.0
            for _ in range(4):
                s = topocentric_sd_arcmin(sd, hp, h)
                h = h_limb + sign * s / 60.0
        h += rigorous_parallax_arcmin(hp, h) / 60.0
    elif kind == "planet":
        h += rigorous_parallax_arcmin(hp, h) / 60.0
    return h, ha


# ---------------------------------------------------------------------------
# One sight
# ---------------------------------------------------------------------------

def sextant_reading(sky, when, earth_model, lat, lon, name, limb, horizon, hoe, ic, p, t_c):
    """The raw sextant reading of `name` and everything needed to judge its reduction."""
    t = sky.time(when)
    site = sky.site(earth_model, lat, lon)
    topo = topocentric(sky, t, site, name)
    sign = {"lower": -1.0, "upper": 1.0, "center": 0.0}[limb]
    h_limb_true = topo["alt_deg"] + sign * topo["sd_arcmin"] / 60.0
    ha = apparent_from_true(h_limb_true, p, t_c)
    if horizon == "sea":
        hs = ha + c.dip_arcmin(hoe) / 60.0 - ic / 60.0
    elif horizon == "artificial_reflected":
        hs = 2.0 * ha - ic / 60.0
    else:
        hs = ha - ic / 60.0
    geo = geocentric(sky, t, name)
    hc, zn = c.spherical_altitude_azimuth_deg(lat, lon, geo["gha_deg"], geo["dec_deg"])
    ho_chain, ha_chain = chain(
        hs, body_kind(name), limb, horizon, ic, hoe, p, t_c,
        geo["semidiameter_arcmin"], geo["horizontal_parallax_arcmin"],
    )
    return {
        "t": t,
        "hs_deg": hs,
        "ha_deg": ha,
        "topo": topo,
        "geo": geo,
        "hc_deg": hc,
        "zn_deg": zn,
        "chain_ho_deg": ho_chain,
        "chain_residual_arcmin": (ho_chain - hc) * 60.0,
        "roundtrip_ha_arcmin": (ha_chain - ha) * 60.0,
    }


# ---------------------------------------------------------------------------
# moon_planet_sights.json
# ---------------------------------------------------------------------------

def random_instant(rng, lo, hi):
    return _dt.datetime.fromtimestamp(int(rng.integers(lo, hi)), _dt.timezone.utc)


def window_timestamps():
    """This run's --window as POSIX seconds (Python datetime: years 1-9999)."""
    out = []
    for jd in c.RUN.window:
        y, mo, d, h = c.gregorian_from_jd(jd)
        if not 1 <= y <= 9999:
            raise SystemExit("gen_moon_sights draws instants with Python datetime: "
                             "keep --window within years 1-9999")
        out.append(int(round((jd - 2440587.5) * 86400.0)))
    return out


def build_sight_cases(sky):
    rng = np.random.default_rng(20260925)
    lo, hi = window_timestamps()
    plan = (
        [("Moon", "lower")] * 60
        + [("Moon", "upper")] * 40
        + [("Moon", "center")] * 4
        + [("Venus", "center")] * 24
        + [(p, "center") for p in ("Mars", "Jupiter", "Saturn") for _ in range(10)]
        + [("Sun", "lower")] * 10
        + [("Sun", "upper")] * 4
        + [(s, "center") for s in ("Sirius", "Vega", "Canopus", "Arcturus", "Rigil Kentaurus", "Capella")]
    )
    horizons = ["sea"] * 6 + ["artificial_reflected", "electronic_vertical"]
    cases = []
    worst = {}
    n = 0
    for earth_model in ("sphere", "wgs84"):
        for body, limb in plan:
            while True:
                when = random_instant(rng, lo, hi)
                lat = float(rng.uniform(-70.0, 72.0))
                lon = float(rng.uniform(-180.0, 180.0))
                t = sky.time(when)
                topo = topocentric(sky, t, sky.site(earth_model, lat, lon), body)
                # 2 to 88 degrees; Venus only when it is at least 15 deg from the Sun.
                if not (2.0 <= topo["alt_deg"] <= 88.0):
                    continue
                if body == "Venus":
                    sun = topocentric(sky, t, sky.site(earth_model, lat, lon), "Sun")
                    if math.degrees(angle(topo["vec"], sun["vec"])) < 15.0:
                        continue
                break
            horizon = horizons[int(rng.integers(0, len(horizons)))]
            hoe = float(rng.choice([0.0, 2.0, 3.5, 12.0, 25.0])) if horizon == "sea" else 0.0
            ic = float(np.round(rng.uniform(-3.0, 3.0), 1))
            p, t_c = (1010.0, 10.0) if rng.uniform() < 0.7 else (
                float(np.round(rng.uniform(980.0, 1040.0), 1)),
                float(np.round(rng.uniform(-10.0, 35.0), 1)),
            )
            # A reflected horizon cannot show a body below about 5 degrees or above 60.
            if horizon == "artificial_reflected" and not (5.0 <= topo["alt_deg"] <= 60.0):
                horizon, hoe = "sea", 2.0
            r = sextant_reading(sky, when, earth_model, lat, lon, body, limb, horizon, hoe, ic, p, t_c)
            n += 1
            key = (earth_model, body_kind(body))
            worst[key] = max(worst.get(key, 0.0), abs(r["chain_residual_arcmin"]))
            g = r["geo"]
            cases.append(c.Inline({
                "id": "sight-%03d" % n,
                "earth": earth_model,
                "utc": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "jd_utc": c.jd(c.jd_utc_of(r["t"])),
                "site": c.Inline({"lat_deg": c.deg(lat), "lon_deg": c.deg(lon)}),
                "body": body,
                "kind": body_kind(body),
                "limb": limb,
                "horizon": horizon,
                "height_of_eye_m": c.metres(hoe),
                "index_correction_arcmin": c.arcmin(ic),
                "pressure_hpa": c.Num(p, 2),
                "temperature_c": c.Num(t_c, 2),
                "altitude_kind": "sextant_hs",
                "hs_deg": c.Num(r["hs_deg"], 12),
                "geocentric": c.Inline({
                    "gha_deg": c.Num(g["gha_deg"], 12),
                    "dec_deg": c.Num(g["dec_deg"], 12),
                    "semidiameter_arcmin": c.Num(g["semidiameter_arcmin"], 10),
                    "horizontal_parallax_arcmin": c.Num(g["horizontal_parallax_arcmin"], 10),
                }),
                "expected_ho_deg": c.Num(r["hc_deg"], 12),
                "expected_zn_deg": c.deg(r["zn_deg"]),
                "chain_ho_deg": c.Num(r["chain_ho_deg"], 12),
                "chain_minus_expected_arcmin": c.Num(r["chain_residual_arcmin"], 6),
                "topocentric_alt_deg": c.deg(r["topo"]["alt_deg"]),
                "topocentric_sd_arcmin": c.Num(r["topo"]["sd_arcmin"], 6),
                "apparent_altitude_deg": c.deg(r["ha_deg"]),
            }))
    return cases, worst


# ---------------------------------------------------------------------------
# End-to-end sessions
# ---------------------------------------------------------------------------

SESSIONS = [
    {
        "name": "reference-moon-planets-atlantic",
        "title": "Moon and four planets, evening twilight off Cape May",
        "site": (38.90, -74.80),
        "assumed": (39.40, -74.10),
        "height_of_eye_m": 3.0,
        "index_correction_arcmin": -1.2,
        "sigma_arcmin": 0.2,
        "about": (
            "The planet parade of February 2025 seen from a ship at anchor off Cape May, "
            "New Jersey, in evening nautical twilight: the Moon's lower limb, Venus, "
            "Mars, Jupiter and Saturn, with Polaris and Capella to close the northern "
            "sky."
        ),
        "sights": [
            ("2025-02-10T23:02:00Z", "Venus", "center"),
            ("2025-02-10T23:04:00Z", "Saturn", "center"),
            ("2025-02-10T23:06:00Z", "Moon", "lower"),
            ("2025-02-10T23:08:00Z", "Mars", "center"),
            ("2025-02-10T23:10:00Z", "Jupiter", "center"),
            ("2025-02-10T23:12:00Z", "Polaris", "center"),
            ("2025-02-10T23:14:00Z", "Capella", "center"),
        ],
    },
    {
        "name": "reference-moon-venus-timor",
        "title": "Crescent Venus, the Moon and Mars, morning twilight in the Timor Sea",
        "site": (-12.20, 128.50),
        "assumed": (-11.70, 129.30),
        "height_of_eye_m": 4.5,
        "index_correction_arcmin": 0.8,
        "sigma_arcmin": 0.2,
        "about": (
            "Morning nautical twilight in the Timor Sea, a month after Venus's inferior "
            "conjunction of October 2026: Venus is a 25 per cent crescent whose light "
            "sits about 0.2' from the centre of its disc. The Moon's upper limb, Venus, "
            "Mars and Jupiter, with Canopus and Acrux to the south."
        ),
        "sights": [
            ("2026-11-26T19:52:00Z", "Canopus", "center"),
            ("2026-11-26T19:54:00Z", "Acrux", "center"),
            ("2026-11-26T19:56:00Z", "Moon", "upper"),
            ("2026-11-26T19:58:00Z", "Jupiter", "center"),
            ("2026-11-26T20:00:00Z", "Mars", "center"),
            ("2026-11-26T20:02:00Z", "Venus", "center"),
        ],
    },
]


def least_squares_fix(rows, start):
    """Independent Python fix (CONVENTIONS sections 3 and 8, Gauss-Newton)."""
    phi, lam = start
    for _ in range(100):
        jtj = np.zeros((2, 2))
        jtr = np.zeros(2)
        for r in rows:
            h, z = c.spherical_altitude_azimuth_deg(phi, lam, r["gha_deg"], r["dec_deg"])
            res = math.radians(r["ho_deg"] - h)
            j = np.array([math.cos(math.radians(z)), math.sin(math.radians(z))])
            jtj += np.outer(j, j)
            jtr += j * res
        dn, de = np.linalg.solve(jtj, jtr)
        phi += math.degrees(dn)
        lam += math.degrees(de / math.cos(math.radians(phi)))
        if math.hypot(dn, de) < 1e-14:
            break
    return phi, lam


def build_session(sky, spec, earth_model):
    lat, lon = spec["site"]
    name = spec["name"] + ("-sphere" if earth_model == "sphere" else "")
    obs, rows, detail = [], [], []
    for i, (utc, body, limb) in enumerate(spec["sights"]):
        when = _dt.datetime.strptime(utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_dt.timezone.utc)
        r = sextant_reading(
            sky, when, earth_model, lat, lon, body, limb, "sea",
            spec["height_of_eye_m"], spec["index_correction_arcmin"], 1010.0, 10.0,
        )
        oid = "obs-%d" % (i + 1)
        alt = r["topo"]["alt_deg"]
        assert 8.0 <= alt <= 80.0, "%s %s at %.1f deg is not a useful sight" % (name, body, alt)
        print("     %s %-8s alt %5.1f az %5.1f" % (utc, body, alt, r["topo"]["az_deg"]))
        obs.append({
            "id": oid,
            "body": body,
            "utc": utc,
            "altitude_deg": c.Num(r["hs_deg"], 10),
            "altitude_kind": "sextant_hs",
            "sigma_arcmin": c.arcmin(spec["sigma_arcmin"]),
            "limb": limb,
            "horizon": None,
            "notes": "synthetic, zero noise: a raw sextant reading built from Skyfield's sky",
        })
        g = r["geo"]
        rows.append({"ho_deg": r["chain_ho_deg"], "gha_deg": g["gha_deg"], "dec_deg": g["dec_deg"]})
        detail.append(c.Inline({
            "id": oid,
            "body": body,
            "limb": limb,
            "hs_deg": c.Num(r["hs_deg"], 10),
            "topocentric_alt_deg": c.deg(r["topo"]["alt_deg"]),
            "topocentric_az_deg": c.deg(r["topo"]["az_deg"]),
            "gha_deg": c.Num(g["gha_deg"], 10),
            "dec_deg": c.Num(g["dec_deg"], 10),
            "semidiameter_arcmin": c.arcmin(g["semidiameter_arcmin"]),
            "horizontal_parallax_arcmin": c.arcmin(g["horizontal_parallax_arcmin"]),
            "ho_by_the_text_deg": c.Num(r["chain_ho_deg"], 10),
            "hc_at_truth_deg": c.Num(r["hc_deg"], 10),
            "zn_at_truth_deg": c.deg(r["zn_deg"]),
            "intercept_at_truth_arcmin": c.Num(r["chain_residual_arcmin"], 5),
        }))
    phi, lam = least_squares_fix(rows, spec["assumed"])
    dn, de = c.ne_offset_m(lat, lon, phi, lam)
    session = {
        "schema": "skyfix.session/1",
        "meta": {
            "name": spec["title"] + (" (spherical Earth)" if earth_model == "sphere" else ""),
            "notes": (
                spec["about"] + " Synthetic, zero noise; raw sextant readings built by "
                "tools/reference/gen_moon_sights.py from Skyfield + JPL %s on " % c.kernel_label()
                + ("a spherical Earth of radius 6378.14 km, the Earth CONVENTIONS "
                   "section 1 reduces sights on." if earth_model == "sphere" else
                   "the WGS84 Earth.")
                + " No observation carries a geocentric block: every direction comes "
                "from the ephemeris (ephemeris mode auto)."
            ),
            "kind": "simulated",
        },
        "observer": {
            "height_of_eye_m": c.metres(spec["height_of_eye_m"]),
            "pressure_hpa": c.Num(1010.0, 2),
            "temperature_c": c.Num(10.0, 2),
            "assumed_position": c.Inline({"lat_deg": c.deg(spec["assumed"][0]), "lon_deg": c.deg(spec["assumed"][1])}),
            "assumed_position_role": c.Inline({"role": "initializer"}),
        },
        "instrument": {
            "name": "synthetic sextant",
            "index_correction_arcmin": c.arcmin(spec["index_correction_arcmin"]),
            "horizon": "sea",
        },
        "clock": {"uncertainty_s": c.secs(0.0), "correction_s": c.secs(0.0)},
        "observations": obs,
    }
    truth = {
        "schema": "skyfix.truth/1",
        "session_name": name,
        "position": c.Inline({"lat_deg": c.deg(lat), "lon_deg": c.deg(lon)}),
        "seed": 0,
        "clock_offset_s": c.secs(0.0),
        "shared_altitude_bias_arcmin": c.arcmin(0.0),
        "wrong_sight_ids": [],
        "notes": "Synthetic, zero noise, no clock offset, no shared bias.",
    }
    worst = max(abs(d.o["intercept_at_truth_arcmin"].v) for d in detail)
    expected = {
        "schema": "skyfix.expected/1",
        "name": name,
        "session": "fixtures/sessions/%s.json" % name,
        "truth": "fixtures/expected/%s.truth.json" % name,
        "earth": earth_model,
        "observations": detail,
        "worst_intercept_at_truth_arcmin": c.Num(worst, 5),
        "independent_python_solution": {
            "method": "Gauss-Newton on the CONVENTIONS section 3 sphere with the Ho of the amended section 5 text (Python transcription), directions from %s" % c.kernel_label(),
            "position": c.Inline({"lat_deg": c.deg(phi), "lon_deg": c.deg(lam)}),
            "offset_from_truth_m": c.Inline({"north": c.metres(dn), "east": c.metres(de), "distance": c.metres(math.hypot(dn, de))}),
        },
    }
    return name, session, truth, expected, math.hypot(dn, de)


# ---------------------------------------------------------------------------
# Lunar distances
# ---------------------------------------------------------------------------

def disc_point(u, s_rad, theta):
    """A point on the small circle of radius s about unit u, theta from the upward
    tangent through east-ish (any fixed orientation will do)."""
    zen = np.array([0.0, 0.0, 1.0])
    e1 = zen - np.dot(zen, u) * u
    e1 = unit(e1)
    e2 = np.cross(u, e1)
    return math.cos(s_rad) * u + math.sin(s_rad) * (math.cos(theta) * e1 + math.sin(theta) * e2)


def refracted(v, p, t_c):
    a, z = alt_az(v)
    return enu(apparent_from_true(a, p, t_c), z)


def golden(f, a, b, tol=1e-12, maximize=False):
    g = (math.sqrt(5.0) - 1.0) / 2.0
    sgn = -1.0 if maximize else 1.0
    c1, d1 = b - g * (b - a), a + g * (b - a)
    fc, fd = sgn * f(c1), sgn * f(d1)
    while abs(b - a) > tol:
        if fc < fd:
            b, d1, fd = d1, c1, fc
            c1 = b - g * (b - a)
            fc = sgn * f(c1)
        else:
            a, c1, fc = c1, d1, fd
            d1 = a + g * (b - a)
            fd = sgn * f(d1)
    x = 0.5 * (a + b)
    return x, f(x)


def best_theta(u, s, target_dir, p, t_c, far):
    """The disc angle whose refracted limb point is nearest (or farthest from) a point."""
    grid = np.linspace(0.0, 2.0 * math.pi, 721)
    vals = [angle(refracted(disc_point(u, s, th), p, t_c), target_dir) for th in grid]
    k = int(np.argmax(vals) if far else np.argmin(vals))
    step = grid[1] - grid[0]
    return golden(
        lambda th: angle(refracted(disc_point(u, s, th), p, t_c), target_dir),
        grid[k] - step, grid[k] + step, maximize=far,
    )


def apparent_limb_distance(u_m, s_m, u_b, s_b, moon_limb, body_limb, p, t_c):
    """The angle a sextant measures, from the refracted discs, numerically.

    The Moon's limb point and the body's limb point are found by alternating 1-D
    searches around each disc (the body's is a point when it has no limb)."""
    far = moon_limb == "far"
    b_point = refracted(u_b, p, t_c)
    th_b = None
    th_m = 0.0
    for _ in range(12):
        th_m, _ = best_theta(u_m, s_m, b_point, p, t_c, far)
        m_point = refracted(disc_point(u_m, s_m, th_m), p, t_c)
        if body_limb == "center":
            break
        th_b, _ = best_theta(u_b, s_b, m_point, p, t_c, body_limb == "far")
        b_point = refracted(disc_point(u_b, s_b, th_b), p, t_c)
    m_point = refracted(disc_point(u_m, s_m, th_m), p, t_c)
    return angle(m_point, b_point)


def geocentric_distance_deg(sky, t, body):
    m = geocentric(sky, t, "Moon")
    b = geocentric(sky, t, body)
    return math.degrees(angle(radec_unit(m["ra_deg"], m["dec_deg"]), radec_unit(b["ra_deg"], b["dec_deg"])))


def lunar_case(sky, n, when, lat, lon, body, hoe, ic, p, t_c, offset_s):
    t = sky.time(when)
    site = sky.site("wgs84", lat, lon)
    m = topocentric(sky, t, site, "Moon")
    b = topocentric(sky, t, site, body)
    sun = topocentric(sky, t, site, "Sun")
    # Which Moon limb is bright toward the body: the near limb when the body lies on
    # the Sun's side of the Moon (within 90 degrees of the bright limb), else the far.
    def tangent(u, w):
        d = w - np.dot(u, w) * u
        return d / np.linalg.norm(d)
    bright = tangent(m["vec"], sun["vec"])
    to_body = tangent(m["vec"], b["vec"])
    moon_limb = "near" if (body == "Sun" or float(np.dot(bright, to_body)) > 0.0) else "far"
    body_limb = "near" if body == "Sun" else "center"
    d_app = apparent_limb_distance(
        m["vec"], math.radians(m["sd_arcmin"] / 60.0), b["vec"],
        math.radians(b["sd_arcmin"] / 60.0), moon_limb, body_limb, p, t_c,
    )
    d_app_deg = math.degrees(d_app)
    # Observed altitudes: the Moon's lower limb, the Sun's lower limb, a star's centre.
    moon_ha = apparent_from_true(m["alt_deg"] - m["sd_arcmin"] / 60.0, p, t_c)
    body_ha = apparent_from_true(b["alt_deg"] - (b["sd_arcmin"] / 60.0 if body == "Sun" else 0.0), p, t_c)
    dip = c.dip_arcmin(hoe) / 60.0
    watch = when + _dt.timedelta(seconds=offset_s)
    t1 = sky.time(when + _dt.timedelta(seconds=60))
    t0 = sky.time(when - _dt.timedelta(seconds=60))
    rate = (geocentric_distance_deg(sky, t1, body) - geocentric_distance_deg(sky, t0, body)) * 60.0 / 2.0
    return c.Inline({
        "id": "lunar-%02d" % n,
        "utc": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "jd_utc": c.jd(c.jd_utc_of(t)),
        "watch_utc": watch.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": c.Inline({"lat_deg": c.deg(lat), "lon_deg": c.deg(lon)}),
        "body": body,
        "moon_limb": moon_limb,
        "body_limb": body_limb,
        "height_of_eye_m": c.metres(hoe),
        "index_correction_arcmin": c.arcmin(ic),
        "pressure_hpa": c.Num(p, 2),
        "temperature_c": c.Num(t_c, 2),
        "sextant_distance_deg": c.Num(d_app_deg - ic / 60.0, 12),
        "moon_altitude": c.Inline({"altitude_deg": c.Num(moon_ha + dip - ic / 60.0, 12), "limb": "lower"}),
        "body_altitude": c.Inline({"altitude_deg": c.Num(body_ha + dip - ic / 60.0, 12), "limb": "lower" if body == "Sun" else "center"}),
        "truth": c.Inline({
            "geocentric_distance_deg": c.Num(geocentric_distance_deg(sky, t, body), 12),
            "distance_rate_arcmin_per_min": c.Num(rate, 6),
            "apparent_limb_distance_deg": c.Num(d_app_deg, 12),
            "moon_topocentric_alt_deg": c.deg(m["alt_deg"]),
            "body_topocentric_alt_deg": c.deg(b["alt_deg"]),
            "moon_topocentric_sd_arcmin": c.Num(m["sd_arcmin"], 6),
        }),
    })


def build_lunar_cases(sky):
    rng = np.random.default_rng(20260926)
    if c.RUN.facts()["window_is_default"]:
        lo = int(_dt.datetime(2022, 1, 1, tzinfo=_dt.timezone.utc).timestamp())
        hi = int(_dt.datetime(2036, 1, 1, tzinfo=_dt.timezone.utc).timestamp())
    else:
        lo, hi = window_timestamps()
    wanted = ["Sun"] * 8 + LUNAR_STARS + ["Venus", "Jupiter", "Saturn", "Mars"]
    cases = []
    for n, body in enumerate(wanted, start=1):
        while True:
            when = random_instant(rng, lo, hi)
            lat = float(rng.uniform(-55.0, 60.0))
            lon = float(rng.uniform(-180.0, 180.0))
            t = sky.time(when)
            site = sky.site("wgs84", lat, lon)
            m = topocentric(sky, t, site, "Moon")
            b = topocentric(sky, t, site, body)
            sep = math.degrees(angle(m["vec"], b["vec"]))
            if not (8.0 <= m["alt_deg"] <= 80.0 and 8.0 <= b["alt_deg"] <= 80.0):
                continue
            if not (20.0 <= sep <= 110.0):
                continue
            if body != "Sun":
                sun = topocentric(sky, t, site, "Sun")
                if sun["alt_deg"] > -6.0:
                    continue  # a star or planet lunar is taken in twilight or at night
            # The distance must change usefully: at least 0.25' per minute.
            t1 = sky.time(when + _dt.timedelta(seconds=60))
            t0 = sky.time(when - _dt.timedelta(seconds=60))
            rate = abs(geocentric_distance_deg(sky, t1, body) - geocentric_distance_deg(sky, t0, body)) * 30.0
            if rate < 0.25:
                continue
            break
        hoe = float(rng.choice([2.0, 4.0, 10.0]))
        ic = float(np.round(rng.uniform(-2.0, 2.0), 1))
        p, t_c = (1010.0, 10.0) if n % 3 else (1025.0, -2.0)
        offset_s = int(rng.integers(-2700, 2700))
        cases.append(lunar_case(sky, n, when, lat, lon, body, hoe, ic, p, t_c, offset_s))
    return cases


# ---------------------------------------------------------------------------
# Nautical twilight instants (for the twilight sight planner)
# ---------------------------------------------------------------------------

TWILIGHT_SITES = [
    ("philadelphia", 39.9526, -75.1652, "2026-10-01"),
    ("off_cape_may", 38.90, -74.80, "2025-02-10"),
    ("timor_sea", -12.20, 128.50, "2026-11-26"),
    ("equator_pacific", 0.0, -160.0, "2027-03-20"),
    ("cape_horn", -56.0, -67.3, "2026-12-21"),
    ("north_sea", 57.0, 3.0, "2026-06-10"),
    ("reykjavik", 64.15, -21.94, "2026-01-15"),
    ("sydney", -33.87, 151.21, "2028-07-04"),
]


def build_twilights(sky):
    """The Sun's centre, topocentric and geometric on the WGS84 Earth at sea level,
    crossing -6 and -12 degrees (CONVENTIONS 13.3), found with Skyfield's
    find_discrete over two days from the given date."""
    from skyfield.searchlib import find_discrete

    cases = []
    for name, lat, lon, day in TWILIGHT_SITES:
        start = _dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
        t0 = sky.time(start)
        if not c.in_window(c.jd_utc_of(t0)):
            continue
        t1 = sky.time(start + _dt.timedelta(days=2))
        ts = sky.ts0
        site = sky.site("wgs84", lat, lon)
        events = []
        for level in (-6.0, -12.0):
            def above(t, level=level):
                alt, _, _ = site.at(t).observe(sky.sun).apparent().altaz()
                return alt.degrees > level
            above.step_days = 1.0 / 48.0
            times, values = find_discrete(ts.tt_jd(t0.tt), ts.tt_jd(t1.tt), above)
            for t, v in zip(times, values):
                events.append((c.jd_utc_of(t), level, bool(v), t.utc_strftime("%Y-%m-%dT%H:%M:%SZ")))
        events.sort()
        cases.append(c.Inline({
            "site": name,
            "lat_deg": c.deg(lat),
            "lon_deg": c.deg(lon),
            "from_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "jd_from": c.jd(c.jd_utc_of(t0)),
            "crossings": [
                c.Inline({"jd_utc": c.jd(j), "utc": u, "level_deg": c.Num(lv, 1), "rising": r})
                for (j, lv, r, u) in events
            ],
        }))
    return cases


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def generator(description, tolerance, justification, extra=None):
    block = c.generator_block(
        tool="tools/reference/gen_moon_sights.py",
        description=description,
        tolerance_arcmin=c.Num(tolerance, 6),
        tolerance_justification=justification,
        frame_notes=c.GEOCENTRIC_FRAME_NOTES,
        refraction={
            "formula": "CONVENTIONS section 5 step 3 (Bennett 1982), common.py:bennett_refraction_arcmin, coded from the text",
            "applied_as": "true -> apparent by solving H - R(H) = h for the apparent altitude H",
            "skyfield_refraction": "not used (it differs from CONVENTIONS by 0.07 % of the refraction)",
        },
        timescale=c.project_timescale_facts(),
        extra={
            "run": c.RUN.facts(),
            "ephemeris": c.run_kernel_facts(),
            "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
            "stars": "Hipparcos with SIMBAD radial velocities and rigorous space motion; Rigil Kentaurus (alpha Cen A) on its ORB6 orbit (common.build_stars)",
            "ut1": "Every instant is on the app's clock with UT1 = UTC on the UTC scale (common.load_timescale(dut1_zero=True); the clock is UT1 after 2035), so GHA and the horizon frame carry DUT1 = 0 (CONVENTIONS section 6).",
            "semidiameters": "Moon asin(0.2725076 x 6378.14 km / d); Sun 959.63 arcsec at 1 au; planets asin(IAU 2015 equatorial radius / d); topocentric d for the sights, geocentric d for the supplied directions",
            "horizontal_parallax": "Moon asin(6378.14 km / geometric distance); planets asin(6378.137 km / light-time distance); Sun 8.794 arcsec at 1 au",
            "venus": "centre of light: moved toward the Sun by 0.44 (1 - cos i) SD (the Nautical Almanac convention, skyfix_ephemeris::sights)",
            **(extra or {}),
        },
    )
    return block


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "2020..2039", "de440s")
    sky = Sky()

    cases, worst = build_sight_cases(sky)
    worst_rows = {
        "%s/%s" % k: c.Num(v, 5) for k, v in sorted(worst.items())
    }
    doc = {
        "schema": "skyfix.reference/1",
        "name": "moon_planet_sights",
        "generator": generator(
            "Raw sextant readings of the Moon, Venus, Mars, Jupiter, Saturn, the Sun and six stars from Skyfield's sky on a spherical and on the WGS84 Earth, with the geocentric altitude a correct reduction must return.",
            TOLERANCE_SPHERE_ARCMIN,
            (
                "Each case carries three numbers. `chain_ho_deg` is the amended CONVENTIONS section 5 "
                "chain transcribed in Python from the text: the Rust chain must reproduce it to "
                "1e-6 arcmin (arithmetic). `expected_ho_deg` is the geocentric altitude at the site "
                "from DE440s (CONVENTIONS section 3): on the `sphere` Earth the chain lands within "
                "0.01 arcmin of it, the residual being the 0.3-arcsec diurnal aberration Skyfield "
                "applies and the project does not. On the `wgs84` Earth the residual is what the "
                "spherical Earth of CONVENTIONS section 1 leaves out, recorded per body class in "
                "`worst_chain_minus_expected_arcmin`; the Rust test holds each case to its class's "
                "recorded worst plus 0.002 arcmin."
            ),
            extra={"worst_chain_minus_expected_arcmin": worst_rows,
                   "arithmetic_tolerance_arcmin": c.Num(TOLERANCE_ARITHMETIC_ARCMIN, 9)},
        ),
        "cases": cases,
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "moon_planet_sights.json"), doc)
    for k, v in sorted(worst.items()):
        print("   worst chain - expected, %-6s %-6s %.4f'" % (k[0], k[1], v))

    for spec in SESSIONS:
        first = _dt.datetime.strptime(spec["sights"][0][0], "%Y-%m-%dT%H:%M:%SZ")
        if not c.in_window(c.jd_from_gregorian(first.year, first.month, first.day)):
            continue
        for earth_model in ("wgs84", "sphere"):
            name, session, truth, expected, miss = build_session(sky, spec, earth_model)
            expected["generator"] = generator(
                "Expected reduction and fix for %s." % name, 0.0,
                "Reference values only; the Rust tests state their tolerances.",
            )
            c.write_json(os.path.join(c.FIX_SESSIONS, name + ".json"), session)
            c.write_json(os.path.join(c.FIX_EXPECTED, name + ".truth.json"), truth)
            c.write_json(os.path.join(c.FIX_EXPECTED, name + ".expected.json"), expected)
            print("   %s: Python fix %.1f m from truth" % (name, miss))

    lunar = build_lunar_cases(sky)
    doc = {
        "schema": "skyfix.reference/1",
        "name": "lunar_distances",
        "generator": generator(
            "Lunar distances as a sextant would measure them on the WGS84 Earth: the angle between the refracted limbs, found numerically, with the observed altitudes and the true UTC.",
            0.0,
            (
                "A lunar distance is solved for the UTC. 1 arcmin of distance is about 2 minutes "
                "of time, so the Rust test asks for the true UTC within 5 s from exact inputs "
                "(about 0.04 arcmin of distance), with altitudes observed or computed from the "
                "true position. The limb distance is computed here by searching the refracted "
                "disc outlines point by point, not with the linear semidiameter formulas the "
                "Rust clearing uses, so the two are independent."
            ),
            extra={"time_tolerance_s": c.Num(5.0, 1)},
        ),
        "cases": lunar,
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "lunar_distances.json"), doc)

    doc = {
        "schema": "skyfix.reference/1",
        "name": "nautical_twilight",
        "generator": generator(
            "Instants at which the Sun's centre (topocentric, geometric, WGS84 sea level) crosses -6 and -12 degrees over two days at eight sites.",
            0.0,
            "CONVENTIONS 13.7: twilight within 10 s of Skyfield with the same definition.",
            extra={"time_tolerance_s": c.Num(10.0, 1)},
        ),
        "cases": build_twilights(sky),
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "nautical_twilight.json"), doc)


if __name__ == "__main__":
    main()
