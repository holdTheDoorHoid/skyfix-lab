"""fixtures/reference/usno_celnav_venus_phase.json

USNO's opinion on the two conventions the Moon and planet sights rest on, from the
same "Celestial Navigation Data" API gen_usno.py queries:

* **Venus's centre of light.** The Nautical Almanac tabulates Venus at the centre of
  its light, not of its disc ("The phase correction for Venus has been incorporated in
  the tabulations for GHA and Dec"), and USNO says its data does the same. Twelve
  responses from a 15-degree to a 157-degree phase angle are compared here with
  Skyfield's geometric Venus (JPL DE440s): the whole difference lies along the bright
  limb, and it is K (1 - cos i) SD with K fitted below. Five Mars responses show that
  USNO applies no phase to Mars.
* **The Moon's altitude corrections.** USNO's semidiameter (with augmentation) and
  parallax in altitude for eight Moon positions, beside the spherical-Earth parallax
  of CONVENTIONS section 5 and the rigorous WGS84 value from Skyfield: USNO computes the
  parallax for the real Earth at the assumed position, which is the up-to-0.2' term the
  sphere leaves out.

USNO's API evaluates Solar System positions about 10 s late (ACCURACY.md, Moon: 10.36 s
from the Moon, which moves fastest); the fit below recovers the same lag from Venus and
Mars, and the Rust test evaluates the providers at t + 10.36 s before comparing.

Network is required. If the API is unreachable the existing file is left alone; the
generator never fabricates a response.

    tools/reference/.venv/bin/python -m tools.reference.gen_usno_sights \
        [--window 2026-02-01..2027-07-01] [--kernel de440s]

`--window` keeps the instants inside it; `--kernel` names the Skyfield side's ephemeris.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import subprocess

import numpy as np

from . import common as c
from . import gen_moon_sights as m

OUT = "usno_celnav_venus_phase.json"
API = "https://aa.usno.navy.mil/api/celnav"

#: The Moon's lag in USNO's API, measured in ACCURACY.md section 7.
USNO_LAG_S = 10.36

VENUS_INSTANTS = [
    "2026-02-20T12:00:00", "2026-03-20T12:00:00", "2026-05-15T12:00:00",
    "2026-07-01T12:00:00", "2026-08-15T12:00:00", "2026-09-10T12:00:00",
    "2026-09-24T12:00:00", "2026-10-05T12:00:00", "2026-10-14T12:00:00",
    "2026-11-03T12:00:00", "2026-11-15T12:00:00", "2027-01-03T12:00:00",
]
MARS_INSTANTS = [
    "2026-03-01T12:00:00", "2026-06-01T12:00:00", "2026-09-24T12:00:00",
    "2027-02-19T12:00:00", "2027-06-01T12:00:00",
]
#: Moon: (instant, offset of the site from the Moon's ground point: north deg, east deg)
MOON_CASES = [
    ("2026-10-01T01:30:00", (40.0, 0.0)),
    ("2026-10-03T06:00:00", (-40.0, 0.0)),
    ("2026-10-05T12:00:00", (20.0, 35.0)),
    ("2026-10-07T18:00:00", (-25.0, -30.0)),
    ("2026-10-10T00:00:00", (50.0, 20.0)),
    ("2026-10-12T06:00:00", (-55.0, 15.0)),
    ("2026-10-14T12:00:00", (5.0, 60.0)),
    ("2026-10-16T18:00:00", (30.0, -45.0)),
]


def query(when, lat, lon):
    url = "%s?date=%s&time=%s&coords=%.4f,%.4f" % (
        API, when.strftime("%Y-%m-%d"), when.strftime("%H:%M:%S"), lat, lon,
    )
    out = subprocess.run(
        ["curl", "-sS", "-f", "-m", "90", "-L", url],
        check=True, capture_output=True, text=True,
    ).stdout
    return url, json.loads(out)


def body_of(resp, name):
    for o in resp["properties"]["data"]:
        if o["object"].lower() == name.lower():
            return o
    return None


def num6(v):
    return c.Num(v, 6)


def planet_case(sky, name, stamp):
    when = _dt.datetime.fromisoformat(stamp).replace(tzinfo=_dt.timezone.utc)
    t = sky.time(when)
    target = sky.targets[name]
    e = sky.earth.at(t)
    astro = e.observe(target)
    ra, dec, dist = astro.apparent().radec(epoch="date")
    ra_deg, dec_deg = float(ra._degrees), float(dec.degrees)
    gha = c.norm360(float(t.gast) * 15.0 - ra_deg)
    sra, sdec, _ = e.observe(sky.sun).apparent().radec(epoch="date")
    from skyfield.trigonometry import position_angle_of

    chi = float(position_angle_of((dec, ra), (sdec, sra)).degrees)
    i = float(astro.phase_angle(sky.sun).degrees)
    sd = math.degrees(math.asin(m.PLANET_RADIUS_KM[name] / float(dist.km))) * 60.0
    later = sky.time(when + _dt.timedelta(seconds=60))
    ra2, dec2, _ = sky.earth.at(later).observe(target).apparent().radec(epoch="date")
    motion = (
        c.wrap_diff_deg(float(ra2._degrees), ra_deg) * 60.0 / 60.0 * math.cos(math.radians(dec_deg)),
        (float(dec2.degrees) - dec_deg) * 60.0 / 60.0,
    )
    # Observe from 30 degrees of latitude away from the ground point.
    lat = max(-60.0, min(60.0, dec_deg + (30.0 if dec_deg < 30.0 else -30.0)))
    lon = c.norm180(-gha)
    url, resp = query(when, lat, lon)
    o = body_of(resp, name)
    if o is None:
        raise RuntimeError("USNO returned no %s for %s" % (name, url))
    a = o["almanac_data"]
    d_dec = (a["dec"] - dec_deg) * 60.0
    d_ra = -c.wrap_diff_deg(a["gha"], gha) * 60.0 * math.cos(math.radians(dec_deg))
    return {
        "utc": stamp + "Z",
        "url": url,
        "usno": {"gha_deg": num6(a["gha"]), "dec_deg": num6(a["dec"])},
        "skyfield": {
            "gast_deg": c.deg(c.norm360(float(t.gast) * 15.0)),
            "ra_deg": c.deg(ra_deg),
            "dec_deg": c.deg(dec_deg),
            "gha_deg": c.deg(gha),
            "semidiameter_arcmin": c.Num(sd, 6),
            "phase_angle_deg": c.deg(i),
            "bright_limb_angle_deg": c.deg(chi),
            "motion_arcmin_per_s": c.Inline({"ra_cos_dec": c.Num(motion[0], 8), "dec": c.Num(motion[1], 8)}),
        },
        "usno_minus_skyfield_arcmin": c.Inline({"ra_cos_dec": c.Num(d_ra, 5), "dec": c.Num(d_dec, 5)}),
        "_fit": (i, chi, sd, d_ra, d_dec, motion),
    }


def fit(rows):
    """[d_ra, d_dec] = K (1 - cos i) SD [sin chi, cos chi] + tau [ra rate, dec rate]."""
    a, y = [], []
    for (i, chi, sd, d_ra, d_dec, motion) in rows:
        f = (1.0 - math.cos(math.radians(i))) * sd
        ch = math.radians(chi)
        a.append([f * math.sin(ch), motion[0]])
        y.append(d_ra)
        a.append([f * math.cos(ch), motion[1]])
        y.append(d_dec)
    a, y = np.array(a), np.array(y)
    sol, *_ = np.linalg.lstsq(a, y, rcond=None)
    r = y - a @ sol
    # The same with the lag fixed at the Moon's 10.36 s.
    y2 = y - USNO_LAG_S * a[:, 1]
    k2 = float(np.dot(a[:, 0], y2) / np.dot(a[:, 0], a[:, 0]))
    r2 = y2 - k2 * a[:, 0]
    return {
        "k": float(sol[0]),
        "lag_s": float(sol[1]),
        "rms_arcmin": float(np.sqrt(np.mean(r * r))),
        "max_arcmin": float(np.max(np.abs(r))),
        "k_with_lag_10_36_s": k2,
        "rms_with_lag_10_36_s_arcmin": float(np.sqrt(np.mean(r2 * r2))),
        "max_with_lag_10_36_s_arcmin": float(np.max(np.abs(r2))),
    }


def wgs84_topocentric_altitude_deg(lat, lon, gha, dec, distance_km):
    """Altitude above the geodetic horizon of a body at geocentric (GHA, Dec, distance),
    for an observer at sea level on the WGS84 ellipsoid. Plain vector geometry."""
    a_km, f = 6378.137, 1.0 / 298.257223563
    e2 = f * (2.0 - f)
    phi, lam = math.radians(lat), math.radians(lon)
    n = a_km / math.sqrt(1.0 - e2 * math.sin(phi) ** 2)
    obs = np.array([n * math.cos(phi) * math.cos(lam), n * math.cos(phi) * math.sin(lam), n * (1.0 - e2) * math.sin(phi)])
    g, d = math.radians(-gha), math.radians(dec)
    body = distance_km * np.array([math.cos(d) * math.cos(g), math.cos(d) * math.sin(g), math.sin(d)])
    v = body - obs
    up = np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])
    return math.degrees(math.asin(float(np.dot(v, up)) / float(np.linalg.norm(v))))


def moon_case(sky, stamp, offset):
    when = _dt.datetime.fromisoformat(stamp).replace(tzinfo=_dt.timezone.utc)
    t = sky.time(when)
    geo = m.geocentric(sky, t, "Moon")
    lat = geo["dec_deg"] + offset[0]
    lon = c.norm180(-geo["gha_deg"] + offset[1])
    url, resp = query(when, lat, lon)
    o = body_of(resp, "Moon")
    if o is None:
        raise RuntimeError("USNO returned no Moon for %s" % url)
    a, corr = o["almanac_data"], o["altitude_corrections"]
    # The Moon where USNO evaluated it (t + lag), in the Earth's orientation at t:
    # GHA = GAST(t) - RA(t + lag).
    t_lag = sky.time(when + _dt.timedelta(seconds=USNO_LAG_S))
    geo_lag = m.geocentric(sky, t_lag, "Moon")
    gha = c.norm360(float(t.gast) * 15.0 - geo_lag["ra_deg"])
    hc, _zn = c.spherical_altitude_azimuth_deg(lat, lon, gha, geo_lag["dec_deg"])
    alt_topo = wgs84_topocentric_altitude_deg(lat, lon, gha, geo_lag["dec_deg"], geo_lag["distance_km"])
    # USNO's own lower-limb apparent altitude: Ha = Hc - sum.
    ha = a["hc"] - corr["sum"]
    # The spherical parallax of CONVENTIONS section 5 at the centre's topocentric
    # altitude USNO implies (Hc - PA), and the WGS84 geocentric-minus-topocentric.
    h_topo = a["hc"] - corr["pa"]
    pa_sphere = m.rigorous_parallax_arcmin(geo_lag["horizontal_parallax_arcmin"], h_topo)
    pa_wgs84 = (hc - alt_topo) * 60.0
    return {
        "utc": stamp + "Z",
        "url": url,
        "site": c.Inline({"lat_deg": c.deg(lat), "lon_deg": c.deg(lon)}),
        "usno": {
            "hc_deg": num6(a["hc"]),
            "zn_deg": num6(a["zn"]),
            "pa_deg": num6(corr["pa"]),
            "sd_deg": num6(corr["sd"]),
            "refr_deg": num6(corr["refr"]),
            "sum_deg": num6(corr["sum"]),
            "implied_lower_limb_ha_deg": num6(ha),
        },
        "skyfield_at_t_plus_lag": {
            "horizontal_parallax_arcmin": c.Num(geo_lag["horizontal_parallax_arcmin"], 6),
            "semidiameter_arcmin": c.Num(geo_lag["semidiameter_arcmin"], 6),
            "hc_deg": c.deg(hc),
            "parallax_sphere_arcmin": c.Num(pa_sphere, 5),
            "parallax_wgs84_arcmin": c.Num(pa_wgs84, 5),
        },
        "usno_hc_minus_skyfield_arcmin": c.Num((a["hc"] - hc) * 60.0, 5),
        "usno_pa_minus_sphere_arcmin": c.Num(corr["pa"] * 60.0 - pa_sphere, 5),
        "usno_pa_minus_wgs84_arcmin": c.Num(corr["pa"] * 60.0 - pa_wgs84, 5),
    }


def _inside(stamp):
    y, mo, d = int(stamp[:4]), int(stamp[5:7]), int(stamp[8:10])
    return c.in_window(c.jd_from_gregorian(y, mo, d, int(stamp[11:13])))


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "2026-02-01..2027-07-01", "de440s")
    sky = m.Sky()
    try:
        venus = [planet_case(sky, "Venus", s) for s in VENUS_INSTANTS if _inside(s)]
        mars = [planet_case(sky, "Mars", s) for s in MARS_INSTANTS if _inside(s)]
        moon = [moon_case(sky, s, off) for s, off in MOON_CASES if _inside(s)]
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, RuntimeError) as exc:
        print("   USNO unreachable or unexpected (%s); %s left as it was" % (exc, OUT))
        return
    venus_fit = fit([v.pop("_fit") for v in venus])
    mars_fit = fit([v.pop("_fit") for v in mars])
    print("   Venus: K %.4f lag %.2f s rms %.5f'; with lag 10.36 s K %.4f rms %.5f'" % (
        venus_fit["k"], venus_fit["lag_s"], venus_fit["rms_arcmin"],
        venus_fit["k_with_lag_10_36_s"], venus_fit["rms_with_lag_10_36_s_arcmin"]))
    print("   Mars:  K %.4f lag %.2f s rms %.5f'" % (mars_fit["k"], mars_fit["lag_s"], mars_fit["rms_arcmin"]))
    for mc in moon:
        print("   Moon %s: USNO Hc - ours %+.4f'; USNO PA - sphere %+.4f', - WGS84 %+.4f'" % (
            mc["utc"], mc["usno_hc_minus_skyfield_arcmin"].v, mc["usno_pa_minus_sphere_arcmin"].v,
            mc["usno_pa_minus_wgs84_arcmin"].v))

    def fit_block(f):
        return {k: c.Num(v, 5) for k, v in f.items()}

    doc = {
        "schema": "skyfix.reference/1",
        "name": "usno_celnav_venus_phase",
        "generator": c.generator_block(
            tool="tools/reference/gen_usno_sights.py",
            description="USNO Celestial Navigation Data responses for Venus, Mars and the Moon, beside Skyfield + DE440s (UT1 = UTC).",
            tolerance_arcmin=c.Num(0.004, 4),
            tolerance_justification=(
                "Venus's centre of light from the provider, evaluated at t + 10.36 s (USNO's "
                "lag), must match USNO's to 0.004 arcmin: the fit's residual is 0.0013 rms "
                "and 0.0027 at worst, most of it the difference between USNO's ephemeris and "
                "DE440s. The geometric centre misses by up to 0.41 arcmin."
            ),
            extra={
                "api": API,
                "documentation": "https://aa.usno.navy.mil/data/celnav",
                "retrieved_utc": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "run": c.RUN.facts(),
                "ephemeris": c.run_kernel_facts(),
                "usno_lag_s": c.Num(USNO_LAG_S, 2),
                "venus_fit": fit_block(venus_fit),
                "mars_fit": fit_block(mars_fit),
            },
        ),
        "notes": [
            "USNO says of its Venus data: 'The data for Venus has been corrected for phase, as in the Nautical Almanac, assuming the center of light is observed.' The Nautical Almanac's explanation: 'The phase correction for Venus has been incorporated in the tabulations for GHA and Dec, and no correction for phase is required.'",
            "Fit: USNO minus Skyfield's geometric centre = K (1 - cos i) SD along the bright-limb position angle + (lag) x (Venus's apparent motion). The perpendicular component is under 0.003 arcmin at every instant.",
            "The uniformly bright disc's centroid gives K = 4/(3 pi) = 0.4244; USNO's convention is about 4 per cent larger. skyfix_ephemeris::sights uses K = 0.44.",
            "Mars: the fitted K is zero within its noise; USNO applies no phase correction to Mars, and neither does the project.",
            "Moon: USNO's parallax in altitude matches the rigorous WGS84 value and differs from the spherical-Earth parallax of CONVENTIONS section 5 by the oblateness term (usno_pa_minus_sphere_arcmin).",
        ],
        "venus": [c.Inline(v) for v in venus],
        "mars": [c.Inline(v) for v in mars],
        "moon": [c.Inline(v) for v in moon],
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT), doc)


if __name__ == "__main__":
    main()
