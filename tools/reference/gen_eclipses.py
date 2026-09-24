"""fixtures/reference/eclipses_*.json — eclipse reference data (development-time only).

Four files, each independent of the Rust code:

* ``eclipses_nasa_canon.json`` — every solar and lunar eclipse of 1990-2060 from
  NASA's *Five Millennium Catalog* pages (Espenak & Meeus; eclipse.gsfc.nasa.gov,
  a U.S. Government work), parsed verbatim: TD of greatest eclipse, Delta-T, lunation,
  saros, type, gamma, magnitudes, the point of greatest eclipse, path width,
  durations.
* ``eclipses_nasa_paths.json`` — NASA's path tables (central line and limits every
  two minutes, in UT with the stated Delta-T) and polynomial Besselian elements for
  six eclipses: 2017-08-21 T, 2021-12-04 T (Antarctica), 2023-04-20 H, 2023-10-14 A,
  2024-04-08 T, 2026-08-12 T.
* ``eclipses_usno_local.json`` — the US Naval Observatory's Solar Eclipse Computer
  (aa.usno.navy.mil/api/eclipses/solar) for 22 sites: contact times, altitudes,
  position and vertex angles, magnitude, obscuration. Stored verbatim.
* ``eclipses_skyfield.json`` — Skyfield + JPL DE440s: local contact times at the same
  22 sites, computed by root finding on the *topocentric* Sun-Moon separation against
  the sum or difference of the semidiameters, with the radii the engine uses (Moon
  k1 = 0.272488 and k2 = 0.272281 WGS84 equatorial radii, Sun 959.63" at 1 au);
  lunar-eclipse contacts (Danjon's shadow) with the Moon's altitude at three sites;
  and where the umbral and penumbral limits cross chosen meridians, found by
  bisection on "grazing at maximum". Built on a timescale with UT1 = UTC exactly
  (Delta-T = 32.184 s + TAI - UTC), the CONVENTIONS section 6 assumption, so it is
  directly comparable with the engine's DUT1 = 0 output.

Network is needed for the first three (``--offline`` keeps the files already there).
Never regenerated from Rust output (CONVENTIONS section 11).

    tools/reference/.venv/bin/python -m tools.reference.gen_eclipses [--offline]
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import re
import subprocess

import numpy as np

from . import common as c

NASA = "https://eclipse.gsfc.nasa.gov"
CANON_PAGES = {
    "solar": ["SEcat5/SE1901-2000.html", "SEcat5/SE2001-2100.html"],
    "lunar": ["LEcat5/LE1901-2000.html", "LEcat5/LE2001-2100.html"],
}
DETAIL_ECLIPSES = [
    "2017Aug21T",
    "2021Dec04T",
    "2023Apr20H",
    "2023Oct14A",
    "2024Apr08T",
    "2026Aug12T",
]
ACKNOWLEDGMENT = "Eclipse Predictions by Fred Espenak and Jean Meeus (NASA's GSFC)"
USNO_URL = "https://aa.usno.navy.mil/api/eclipses/solar/date?date={date}&coords={lat},{lon}&height={h:.0f}"

#: (eclipse id, site name, lat, lon, height m). Heights are approximate ground heights.
SOLAR_SITES = [
    ("2017-08-21-solar", "salem_or", 44.9429, -123.0351, 60.0),
    ("2017-08-21-solar", "casper_wy", 42.8666, -106.3131, 1560.0),
    ("2017-08-21-solar", "carbondale_il", 37.7273, -89.2168, 120.0),
    ("2017-08-21-solar", "nashville_tn", 36.1627, -86.7816, 170.0),
    ("2017-08-21-solar", "columbia_sc", 34.0007, -81.0348, 90.0),
    ("2017-08-21-solar", "philadelphia_pa", 39.9526, -75.1652, 12.0),
    ("2017-08-21-solar", "honolulu_hi", 21.3069, -157.8583, 5.0),
    ("2017-08-21-solar", "dakar_sn", 14.7167, -17.4677, 20.0),
    ("2023-10-14-solar", "eugene_or", 44.0521, -123.0868, 130.0),
    ("2023-10-14-solar", "albuquerque_nm", 35.0844, -106.6504, 1500.0),
    ("2023-10-14-solar", "san_antonio_tx", 29.4241, -98.4936, 200.0),
    ("2023-10-14-solar", "philadelphia_pa", 39.9526, -75.1652, 12.0),
    ("2024-04-08-solar", "mazatlan_mx", 23.2494, -106.4111, 10.0),
    ("2024-04-08-solar", "dallas_tx", 32.7767, -96.7970, 150.0),
    ("2024-04-08-solar", "indianapolis_in", 39.7684, -86.1581, 220.0),
    ("2024-04-08-solar", "cleveland_oh", 41.4993, -81.6944, 200.0),
    ("2024-04-08-solar", "buffalo_ny", 42.8864, -78.8784, 180.0),
    ("2024-04-08-solar", "burlington_vt", 44.4759, -73.2121, 60.0),
    ("2024-04-08-solar", "philadelphia_pa", 39.9526, -75.1652, 12.0),
    ("2024-04-08-solar", "honolulu_hi", 21.3069, -157.8583, 5.0),
    ("2024-04-08-solar", "reykjavik_is", 64.1466, -21.9426, 20.0),
    ("2024-04-08-solar", "sydney_au", -33.8688, 151.2093, 20.0),
]

#: Lunar eclipses and sites for the local-visibility check.
LUNAR_SITES = [
    ("2022-11-08-lunar", "philadelphia_pa", 39.9526, -75.1652, 12.0),
    ("2022-11-08-lunar", "honolulu_hi", 21.3069, -157.8583, 5.0),
    ("2022-11-08-lunar", "tokyo_jp", 35.6762, 139.6503, 40.0),
    ("2025-03-14-lunar", "philadelphia_pa", 39.9526, -75.1652, 12.0),
    ("2025-03-14-lunar", "london_uk", 51.5074, -0.1278, 20.0),
    ("2025-03-14-lunar", "sydney_au", -33.8688, 151.2093, 20.0),
]

#: Meridians where the limits' crossing latitudes are found (eclipse, cone, lon).
LIMIT_MERIDIANS = [
    ("2017-08-21-solar", "umbra", -110.0),
    ("2017-08-21-solar", "umbra", -90.0),
    ("2017-08-21-solar", "penumbra", -100.0),
    ("2017-08-21-solar", "penumbra", -40.0),
    ("2023-10-14-solar", "umbra", -110.0),
    ("2023-10-14-solar", "umbra", -75.0),
    ("2023-10-14-solar", "penumbra", -100.0),
    ("2024-04-08-solar", "umbra", -100.0),
    ("2024-04-08-solar", "umbra", -80.0),
    ("2024-04-08-solar", "penumbra", -120.0),
    ("2024-04-08-solar", "penumbra", -60.0),
    ("2021-12-04-solar", "umbra", -100.0),
    ("2021-12-04-solar", "umbra", -80.0),
]

# Geometry the engine uses (crates/skyfix-almanac/src/eclipses/bessel.rs, lunar.rs).
WGS84_A_KM = 6378.137
K1 = 0.272488
K2 = 0.272281
AU_KM = 149_597_870.700
SUN_SD_1AU_ARCSEC = 959.63
SUN_HP_1AU_ARCSEC = 8.794
ELP_A_KM = 6378.14
DANJON = 1.01
ARCSEC = math.pi / 648000.0
SUN_RADIUS_KM = AU_KM * math.sin(SUN_SD_1AU_ARCSEC * ARCSEC)

MON = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def fetch(url):
    """Bytes of `url` via curl (aa.usno.navy.mil resets unfamiliar user agents)."""
    out = subprocess.run(
        ["curl", "-sS", "-f", "-m", "120", "-L", url], check=True, capture_output=True
    ).stdout
    return out


def fetch_json_or_error(url):
    """USNO answers 400 with a JSON body for a site with no eclipse: keep it."""
    out = subprocess.run(["curl", "-sS", "-m", "120", "-L", url], check=True, capture_output=True).stdout
    return json.loads(out.decode("utf-8"))


def page_text(raw):
    """Visible text of a page. The pages are UTF-8 with a few stray Mac Roman bytes
    (apostrophes in the lunar key), which become U+FFFD harmlessly."""
    t = raw.decode("utf-8", errors="replace")
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t)


def verbatim(o):
    """A JSON value with every float wrapped so it prints exactly as received."""
    if isinstance(o, float):
        r = repr(o)
        decimals = len(r.split(".")[1]) if "." in r and "e" not in r else 6
        return c.Num(o, decimals)
    if isinstance(o, dict):
        return {k: verbatim(v) for k, v in o.items()}
    if isinstance(o, list):
        return [verbatim(v) for v in o]
    return o


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def retrieved():
    return c.generated_utc()[:10]


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------


def jd_of(y, m, d, hh=0, mm=0, ss=0.0):
    """Julian date of a proleptic Gregorian calendar instant (any time scale)."""
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return (
        math.floor(365.25 * (y + 4716))
        + math.floor(30.6001 * (m + 1))
        + d
        + b
        - 1524.5
        + (hh + mm / 60.0 + ss / 3600.0) / 24.0
    )


def tai_minus_utc(y):
    """37 s from 2017; the only era the local fixtures need (asserted)."""
    assert y >= 2017, y
    return 37.0


# ---------------------------------------------------------------------------
# NASA canon
# ---------------------------------------------------------------------------

SE_ROW = re.compile(
    r"^(\d{5})\s+(-?\d+)\s+(\w{3})\s+(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+"
    r"(\S+)\s+(\S+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(\d+)([NS])\s+(\d+)([EW])\s+(\d+)\s*(\d+|-)?\s*(\d+m\d+s|-)?\s*$"
)
LE_ROW = re.compile(
    r"^(\d{5})\s+(-?\d+)\s+(\w{3})\s+(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+"
    r"(\S+)\s+(\S+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+|-)\s+(\d+\.\d+|-)\s+"
    r"(\d+)([NS])\s+(\d+)([EW])\s*$"
)


def parse_solar(text):
    out = []
    for line in text.splitlines():
        m = SE_ROW.match(line.strip())
        if not m:
            continue
        g = m.groups()
        y, mo, d = int(g[1]), MON[g[2]], int(g[3])
        if not 1990 <= y <= 2060:
            continue
        hh, mi, ss = int(g[4]), int(g[5]), int(g[6])
        dur = None
        if g[20] and g[20] != "-":
            a, b = g[20].rstrip("s").split("m")
            dur = int(a) * 60 + int(b)
        out.append(
            {
                "catalog": g[0],
                "date": "%04d-%02d-%02d" % (y, mo, d),
                "td": "%04d-%02d-%02dT%02d:%02d:%02d" % (y, mo, d, hh, mi, ss),
                "jd_td": c.jd(jd_of(y, mo, d, hh, mi, ss)),
                "delta_t_s": int(g[7]),
                "lunation": int(g[8]),
                "saros": int(g[9]),
                "type": g[10],
                "qle": g[11],
                "gamma": c.Num(float(g[12]), 4),
                "magnitude": c.Num(float(g[13]), 4),
                "lat_deg": int(g[14]) * (1 if g[15] == "N" else -1),
                "lon_deg": int(g[16]) * (1 if g[17] == "E" else -1),
                "sun_alt_deg": int(g[18]),
                "path_width_km": None if g[19] in (None, "-") else int(g[19]),
                "central_duration_s": dur,
            }
        )
    return out


def parse_lunar(text):
    out = []
    for line in text.splitlines():
        m = LE_ROW.match(line.strip())
        if not m:
            continue
        g = m.groups()
        y, mo, d = int(g[1]), MON[g[2]], int(g[3])
        if not 1990 <= y <= 2060:
            continue
        hh, mi, ss = int(g[4]), int(g[5]), int(g[6])

        def minutes(v):
            return None if v == "-" else c.Num(float(v), 1)

        out.append(
            {
                "catalog": g[0],
                "date": "%04d-%02d-%02d" % (y, mo, d),
                "td": "%04d-%02d-%02dT%02d:%02d:%02d" % (y, mo, d, hh, mi, ss),
                "jd_td": c.jd(jd_of(y, mo, d, hh, mi, ss)),
                "delta_t_s": int(g[7]),
                "lunation": int(g[8]),
                "saros": int(g[9]),
                "type": g[10],
                "qse": g[11],
                "gamma": c.Num(float(g[12]), 4),
                "penumbral_magnitude": c.Num(float(g[13]), 4),
                "umbral_magnitude": c.Num(float(g[14]), 4),
                "penumbral_duration_min": minutes(g[15]),
                "partial_duration_min": minutes(g[16]),
                "total_duration_min": minutes(g[17]),
                "zenith_lat_deg": int(g[18]) * (1 if g[19] == "N" else -1),
                "zenith_lon_deg": int(g[20]) * (1 if g[21] == "E" else -1),
            }
        )
    return out


def build_canon():
    sources, solar, lunar = [], [], []
    for kind, pages in CANON_PAGES.items():
        for p in pages:
            url = "%s/%s" % (NASA, p)
            raw = fetch(url)
            sources.append({"url": url, "sha256": sha256(raw), "bytes": len(raw)})
            rows = parse_solar(page_text(raw)) if kind == "solar" else parse_lunar(page_text(raw))
            (solar if kind == "solar" else lunar).extend(rows)
    assert len(solar) == 158 and len(lunar) == 162, (len(solar), len(lunar))
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/reference/gen_eclipses.py",
            "description": (
                "Every solar and lunar eclipse with greatest eclipse in 1990-2060 from NASA's "
                "Five Millennium Catalogs of Solar and Lunar Eclipses (Espenak & Meeus, NASA "
                "TP-2006-214141 and TP-2009-214173), rows parsed verbatim from the catalogue pages."
            ),
            "generated_utc": c.generated_utc(),
            "retrieved": retrieved(),
            "sources": sources,
            "licence": (
                "U.S. Government work (NASA Goddard Space Flight Center). The pages ask that the "
                "data carry the acknowledgment below."
            ),
            "acknowledgment": ACKNOWLEDGMENT,
            "conventions": {
                "time": "td is Terrestrial Dynamical Time of greatest eclipse; UT = TD - delta_t_s.",
                "delta_t": (
                    "delta_t_s is NASA's adopted Delta-T, integer seconds: observed values to "
                    "~2006, extrapolated after (74 s in 2024, 90 s in 2040, about 113 s in 2060)."
                ),
                "ephemerides": "VSOP87 (Sun) and ELP-2000/82 (Moon), lunar secular acceleration -25.858\"/cy^2.",
                "solar_greatest": (
                    "Greatest eclipse: the shadow axis passes closest to Earth's centre. gamma "
                    "in Earth equatorial radii. magnitude: Moon/Sun diameter ratio for central "
                    "eclipses, else fraction of the Sun's diameter covered at the point nearest "
                    "the axis. lat/lon/sun_alt rounded to whole degrees."
                ),
                "lunar_shadow": "Danjon's enlargement: umbra 1.01 Pm - Ss + Ps, penumbra 1.01 Pm + Ss + Ps.",
                "type_codes": (
                    "First letter: T total, A annular, H hybrid, P partial (solar); T total, P "
                    "partial, N penumbral (lunar). Second: m middle of saros, n/s central with no "
                    "northern/southern limit, +/- non-central (solar) or central north/south of "
                    "axis (lunar), 2/3 hybrid begins total/annular, b/e saros begins/ends, x/* "
                    "total penumbral."
                ),
                "lunar_durations": "Minutes, one decimal: penumbral P4-P1, partial U4-U1, total U3-U2.",
            },
            "tolerances": {
                "greatest_eclipse_td_s": c.Num(120.0, 1),
                "gamma": c.Num(0.001, 3),
                "magnitude": c.Num(0.01, 2),
            },
            "never_a_runtime_dependency": (
                "Development-time reference. CONVENTIONS section 11: never regenerate a fixture "
                "from Rust output."
            ),
        },
        "solar": solar,
        "lunar": lunar,
    }


# ---------------------------------------------------------------------------
# NASA path tables and Besselian elements
# ---------------------------------------------------------------------------


def dm(deg, minute_hemi):
    hemi = minute_hemi[-1]
    v = int(deg) + float(minute_hemi[:-1]) / 60.0
    return -v if hemi in "SW" else v


def parse_path(text):
    rows, limits = [], None
    for line in text.splitlines():
        tok = line.split()
        if not tok:
            continue
        head = tok[0]
        if not (re.match(r"^\d\d:\d\d$", head) or head == "Limits"):
            continue
        i, fields = 1, []
        try:
            while len(fields) < 3:
                if tok[i] == "-":
                    fields.append(None)
                    i += 2
                else:
                    lat = dm(tok[i], tok[i + 1])
                    lon = dm(tok[i + 2], tok[i + 3])
                    fields.append({"lat_deg": c.Num(lat, 5), "lon_deg": c.Num(lon, 5)})
                    i += 4
            ratio = float(tok[i])
            alt = int(tok[i + 1])
            az = None if tok[i + 2] == "-" else int(tok[i + 2])
            width = int(tok[i + 3])
            mm, ss = tok[i + 4].rstrip("s").split("m")
            dur = int(mm) * 60 + float(ss)
        except (IndexError, ValueError):
            continue
        rec = {
            "north": fields[0],
            "south": fields[1],
            "central": fields[2],
            "diameter_ratio": c.Num(ratio, 3),
            "sun_alt_deg": alt,
            "sun_az_deg": az,
            "path_width_km": width,
            "central_duration_s": c.Num(dur, 1),
        }
        if head == "Limits":
            if limits is None:
                limits = {"start": rec}
            else:
                limits["end"] = rec
        else:
            rec["ut"] = head
            rows.append(rec)
    t = re.sub(r"\s+", " ", text)
    m = re.search(r"ΔT = ([\d.]+) seconds", t)
    delta_t = float(m.group(1))
    m = re.search(
        r"Greatest Eclipse: Time = (\d\d):(\d\d):([\d.]+) UT Lat = (\d+)°([\d.]+)'([NS]) Long = (\d+)°([\d.]+)'([EW])"
        r" \(GE\) Sun Altitude = ([\d.]+)° Path Width = ([\d.]+) km Sun Azimuth = ([\d.]+)° Central Duration = (\d+)m([\d.]+)s",
        t,
    )
    g = m.groups()
    ge = {
        "ut": "%s:%s:%s" % (g[0], g[1], g[2]),
        "lat_deg": c.Num((int(g[3]) + float(g[4]) / 60.0) * (1 if g[5] == "N" else -1), 5),
        "lon_deg": c.Num((int(g[6]) + float(g[7]) / 60.0) * (1 if g[8] == "E" else -1), 5),
        "sun_alt_deg": c.Num(float(g[9]), 1),
        "path_width_km": c.Num(float(g[10]), 1),
        "sun_az_deg": c.Num(float(g[11]), 1),
        "central_duration_s": c.Num(int(g[12]) * 60 + float(g[13]), 1),
    }
    return rows, limits, delta_t, ge


def parse_besselian(text):
    t = text
    m = re.search(
        r"Polynomial Besselian Elements for:\s+(\d{4})\s+(\w{3})\s+(\d\d)\s+(\d\d):(\d\d):([\d.]+)\s+TDT", t
    )
    y, mo, d = int(m.group(1)), MON[m.group(2)], int(m.group(3))
    t0 = int(m.group(4)) + int(m.group(5)) / 60.0 + float(m.group(6)) / 3600.0
    coeffs = {k: [] for k in ["x", "y", "d", "l1", "l2", "mu"]}
    for line in t.splitlines():
        tok = line.split()
        if tok and tok[0] in ("0", "1", "2", "3") and len(tok) >= 3:
            n = int(tok[0])
            vals = [float(v) for v in tok[1:]]
            names = ["x", "y", "d", "l1", "l2", "mu"][: len(vals)]
            for name, v in zip(names, vals):
                while len(coeffs[name]) < n:
                    coeffs[name].append(0.0)
                coeffs[name].append(v)
    tan_f1 = float(re.search(r"Tan ƒ1 = ([\d.]+)", t).group(1))
    tan_f2 = float(re.search(r"Tan ƒ2 = ([\d.]+)", t).group(1))
    k1 = float(re.search(r"k1 = ([\d.]+)", t).group(1))
    k2 = float(re.search(r"k2 = ([\d.]+)", t).group(1))
    delta_t = float(re.search(r"ΔT =\s+([\d.]+) s", t).group(1))
    valid = re.search(r"valid over the period\s+([\d.]+)\s+≤\s+t0\s+≤\s+([\d.]+)\s+TDT", t)
    return {
        "date": "%04d-%02d-%02d" % (y, mo, d),
        "t0_tdt_hours": c.Num(t0, 6),
        "jd_tdt_t0": c.jd(jd_of(y, mo, d) + t0 / 24.0),
        "valid_tdt_hours": [c.Num(float(valid.group(1)), 3), c.Num(float(valid.group(2)), 3)],
        "coefficients": {k: [c.Num(v, 7) for v in vs] for k, vs in coeffs.items()},
        "tan_f1": c.Num(tan_f1, 7),
        "tan_f2": c.Num(tan_f2, 7),
        "k1": c.Num(k1, 6),
        "k2": c.Num(k2, 6),
        "delta_t_s": c.Num(delta_t, 1),
    }


ID_OF = {
    "2017Aug21T": "2017-08-21-solar",
    "2021Dec04T": "2021-12-04-solar",
    "2023Apr20H": "2023-04-20-solar",
    "2023Oct14A": "2023-10-14-solar",
    "2024Apr08T": "2024-04-08-solar",
    "2026Aug12T": "2026-08-12-solar",
}


def build_paths():
    sources, eclipses = [], []
    for e in DETAIL_ECLIPSES:
        purl = "%s/SEpath/SEpath2001/SE%spath.html" % (NASA, e)
        burl = "%s/SEbeselm/SEbeselm2001/SE%sbeselm.html" % (NASA, e)
        praw, braw = fetch(purl), fetch(burl)
        sources += [
            {"url": purl, "sha256": sha256(praw), "bytes": len(praw)},
            {"url": burl, "sha256": sha256(braw), "bytes": len(braw)},
        ]
        rows, limits, delta_t, ge = parse_path(page_text(praw))
        bes = parse_besselian(page_text(braw))
        assert rows, e
        eclipses.append(
            {
                "id": ID_OF[e],
                "delta_t_s": c.Num(delta_t, 1),
                "greatest": ge,
                "limits": limits,
                "rows": [c.Inline(r) for r in rows],
                "besselian": bes,
            }
        )
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/reference/gen_eclipses.py",
            "description": (
                "NASA path tables (northern and southern limits of the umbra or antumbra and "
                "the central line every 120 s, WGS84, UT with the page's Delta-T) and "
                "polynomial Besselian elements for six solar eclipses, parsed verbatim."
            ),
            "generated_utc": c.generated_utc(),
            "retrieved": retrieved(),
            "sources": sources,
            "licence": "U.S. Government work (NASA GSFC); acknowledgment requested.",
            "acknowledgment": "Eclipse Predictions by Fred Espenak, NASA's GSFC",
            "conventions": {
                "ut": "UT of each row; TD = UT + delta_t_s (the path page's value).",
                "limits": (
                    "'limits.start' and 'limits.end' are the extreme points of the path at "
                    "sunrise and sunset (NASA's 'Limits' rows)."
                ),
                "besselian": (
                    "a = sum a_n t^n, t = hours of TDT from t0; x, y, l1, l2 in Earth equatorial "
                    "radii, d and mu in degrees. mu is the ephemeris hour angle: the Greenwich hour "
                    "angle plus 1.002738 * 15 deg/h * Delta-T."
                ),
                "lunar_limb": "Mean lunar limb (k2 for the umbra); limb profile not included (1-3 km).",
            },
            "never_a_runtime_dependency": (
                "Development-time reference. CONVENTIONS section 11: never regenerate a fixture "
                "from Rust output."
            ),
        },
        "eclipses": eclipses,
    }


# ---------------------------------------------------------------------------
# USNO local circumstances
# ---------------------------------------------------------------------------


def build_usno():
    cases = []
    for eid, name, lat, lon, h in SOLAR_SITES:
        url = USNO_URL.format(date=eid[:10], lat=lat, lon=lon, h=h)
        resp = fetch_json_or_error(url)
        cases.append(
            {
                "id": eid,
                "site": c.Inline(
                    {
                        "name": name,
                        "lat_deg": c.Num(lat, 4),
                        "lon_deg": c.Num(lon, 4),
                        "height_m": c.Num(h, 1),
                    }
                ),
                "url": url,
                "response": verbatim(resp),
            }
        )
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/reference/gen_eclipses.py",
            "description": (
                "US Naval Observatory Astronomical Applications API, Solar Eclipse Computer "
                "(local circumstances, 2017-2024), stored verbatim. Times are UT computed with "
                "the response's own delta_t."
            ),
            "generated_utc": c.generated_utc(),
            "retrieved": retrieved(),
            "api_documentation": "https://aa.usno.navy.mil/data/api",
            "licence": "U.S. Government work (U.S. Naval Observatory).",
            "tolerances": {"contact_time_s": c.Num(60.0, 1)},
            "never_a_runtime_dependency": (
                "Development-time reference. CONVENTIONS section 11: never regenerate a fixture "
                "from Rust output."
            ),
        },
        "cases": cases,
    }


# ---------------------------------------------------------------------------
# Skyfield + DE440s
# ---------------------------------------------------------------------------


class Sky:
    def __init__(self):
        from skyfield.api import load, load_file

        self.eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)
        self.earth, self.sun, self.moon = self.eph["earth"], self.eph["sun"], self.eph["moon"]
        # UT1 = UTC exactly for every instant from 2017 (TAI - UTC = 37 s).
        self.ts = load.timescale(delta_t=32.184 + 37.0)

    def t(self, jd_utc):
        """A Time at UTC-based Julian date(s); with this timescale UT1 = UTC."""
        jd = np.atleast_1d(np.asarray(jd_utc, dtype=float))
        return self.ts.tt_jd(jd + 69.184 / 86400.0)

    def topo(self, lat, lon, h):
        from skyfield.api import wgs84

        return self.earth + wgs84.latlon(lat, lon, elevation_m=h)


def solar_quantities(sky, site, jd):
    """Separation and semidiameters (radians) of the topocentric apparent Sun and Moon."""
    t = sky.t(jd)
    a = site.at(t)
    s = a.observe(sky.sun).apparent()
    m = a.observe(sky.moon).apparent()
    sep = s.separation_from(m).radians
    ds, dmoon = s.distance().km, m.distance().km
    sd_s = np.arcsin(SUN_RADIUS_KM / ds)
    sd_m1 = np.arcsin(K1 * WGS84_A_KM / dmoon)
    sd_m2 = np.arcsin(K2 * WGS84_A_KM / dmoon)
    return sep, sd_s, sd_m1, sd_m2, s, m, a


#: Tolerance on a Julian date, days (0.17 ms). An f64 Julian date near 2.46e6 resolves
#: only 4.7e-10 day, so nothing finer can be asked of a search in it.
JD_TOL = 2e-9


def golden_min(f, a, b, tol=JD_TOL):
    g = (math.sqrt(5) - 1) / 2
    x1, x2 = b - g * (b - a), a + g * (b - a)
    f1, f2 = f(x1), f(x2)
    for _ in range(200):
        if b - a <= tol:
            break
        if f1 < f2:
            b, x2, f2 = x2, x1, f1
            x1 = b - g * (b - a)
            f1 = f(x1)
        else:
            a, x1, f1 = x1, x2, f2
            x2 = a + g * (b - a)
            f2 = f(x2)
    return 0.5 * (a + b)


def bisect(f, a, b, tol=JD_TOL):
    fa, fb = f(a), f(b)
    assert fa * fb <= 0, (a, b, fa, fb)
    for _ in range(200):
        if b - a <= tol:
            break
        m = 0.5 * (a + b)
        fm = f(m)
        if fa * fm <= 0:
            b, fb = m, fm
        else:
            a, fa = m, fm
    return 0.5 * (a + b)


def illinois(f, a, b, tol):
    """Regula falsi with the Illinois modification: a bracketed root of a smooth `f`."""
    fa, fb = f(a), f(b)
    assert fa * fb <= 0, (a, b, fa, fb)
    side = 0
    for _ in range(100):
        c = (a * fb - b * fa) / (fb - fa)
        fc = f(c)
        if fc * fb > 0:
            b, fb = c, fc
            if side == -1:
                fa /= 2
            side = -1
        else:
            a, fa = c, fc
            if side == 1:
                fb /= 2
            side = 1
        if abs(b - a) <= tol or fc == 0:
            return c
    return 0.5 * (a + b)


def altaz(site, jd, sky, body):
    t = sky.t(jd)
    app = site.at(t).observe(body).apparent()
    alt, az, _ = app.altaz()
    return float(alt.degrees[0]), float(az.degrees[0])


def position_angle(s, m):
    """Of the Moon's centre from the Sun's, north through east, degrees."""
    ra_s, dec_s, _ = s.radec(epoch="date")
    ra_m, dec_m, _ = m.radec(epoch="date")
    a1, d1 = ra_s.radians[0], dec_s.radians[0]
    a2, d2 = ra_m.radians[0], dec_m.radians[0]
    da = a2 - a1
    pa = math.atan2(math.sin(da) * math.cos(d2), math.cos(d1) * math.sin(d2) - math.sin(d1) * math.cos(d2) * math.cos(da))
    return math.degrees(pa) % 360.0


GREATEST_TD = {
    "2017-08-21-solar": jd_of(2017, 8, 21, 18, 26, 40),
    "2021-12-04-solar": jd_of(2021, 12, 4, 7, 34, 38),
    "2023-10-14-solar": jd_of(2023, 10, 14, 18, 0, 41),
    "2024-04-08-solar": jd_of(2024, 4, 8, 18, 18, 29),
    "2022-11-08-lunar": jd_of(2022, 11, 8, 11, 0, 22),
    "2025-03-14-lunar": jd_of(2025, 3, 14, 6, 59, 56),
}


def solar_local(sky, eid, name, lat, lon, h):
    site = sky.topo(lat, lon, h)
    jd_ge = GREATEST_TD[eid] - 69.184 / 86400.0
    lo, hi = jd_ge - 4.0 / 24.0, jd_ge + 4.0 / 24.0

    def ext(jd):
        sep, sd_s, sd_m1, _, _, _, _ = solar_quantities(sky, site, jd)
        return float((sep - (sd_s + sd_m1))[0])

    def inner(jd):
        sep, sd_s, _, sd_m2, _, _, _ = solar_quantities(sky, site, jd)
        return float((sep - np.abs(sd_m2 - sd_s))[0])

    # Maximum: greatest magnitude, the fraction of the Sun's diameter covered,
    # (SD_sun + SD_moon_k1 - sep) / (2 SD_sun + SD_moon_k1 - SD_moon_k2) with the
    # engine's two lunar radii; bracketed on a 2-minute grid.
    def neg_magnitude(jd):
        sep, sd_s, sd_m1, sd_m2, *_ = solar_quantities(sky, site, jd)
        return -(sd_s + sd_m1 - sep) / (2 * sd_s + sd_m1 - sd_m2)

    grid = np.linspace(lo, hi, 241)
    i = int(np.argmin(neg_magnitude(grid)))
    jmax = golden_min(
        lambda j: float(neg_magnitude(j)[0]), grid[max(i - 1, 0)], grid[min(i + 1, 240)]
    )
    case = {"id": eid, "site": c.Inline({"name": name, "lat_deg": c.Num(lat, 4), "lon_deg": c.Num(lon, 4), "height_m": c.Num(h, 1)})}
    if ext(jmax) >= 0:
        case["eclipse"] = False
        return case
    case["eclipse"] = True
    contacts = []

    def record(kind, jd, f):
        sep, sd_s, sd_m1, sd_m2, s, m, _ = solar_quantities(sky, site, jd)
        rate = (f(jd + 1.0 / 86400.0) - f(jd - 1.0 / 86400.0)) / 2.0 / ARCSEC
        alt, az = altaz(site, jd, sky, sky.sun)
        return {
            "kind": kind,
            "jd_utc": c.jd(jd),
            "utc": sky.t(jd).utc_strftime("%Y-%m-%dT%H:%M:%S")[0],
            "residual_rate_arcsec_per_s": c.Num(rate, 5),
            "sun_alt_deg": c.Num(alt, 4),
            "sun_az_deg": c.Num(az, 4),
            "moon_position_angle_deg": c.Num(position_angle(s, m), 3),
        }

    c1 = bisect(ext, lo, jmax)
    c4 = bisect(ext, jmax, hi)
    contacts.append(record("c1", c1, ext))
    if inner(jmax) < 0:
        c2 = bisect(inner, c1, jmax)
        c3 = bisect(inner, jmax, c4)
        contacts.append(record("c2", c2, inner))
        contacts.append(record("c3", c3, inner))
    contacts.append(record("c4", c4, ext))
    sep, sd_s, sd_m1, sd_m2, _, _, _ = solar_quantities(sky, site, jmax)
    alt, az = altaz(site, jmax, sky, sky.sun)
    case["max"] = {
        "jd_utc": c.jd(jmax),
        "separation_arcsec": c.Num(float(sep[0]) / ARCSEC, 4),
        "sun_sd_arcsec": c.Num(float(sd_s[0]) / ARCSEC, 4),
        "moon_sd_k1_arcsec": c.Num(float(sd_m1[0]) / ARCSEC, 4),
        "moon_sd_k2_arcsec": c.Num(float(sd_m2[0]) / ARCSEC, 4),
        "sun_alt_deg": c.Num(alt, 4),
        "sun_az_deg": c.Num(az, 4),
    }
    case["contacts"] = contacts
    return case


def lunar_quantities(sky, jd):
    """Geocentric: angle Moon-shadow axis, Danjon radii, Moon SD (radians), distance."""
    t = sky.t(jd)
    e = sky.earth.at(t)
    s = e.observe(sky.sun).apparent()
    m = e.observe(sky.moon).apparent()
    theta = math.pi - s.separation_from(m).radians
    r_au = s.distance().au
    dmoon = m.distance().km
    pi_m = np.arcsin(ELP_A_KM / dmoon)
    s_s = SUN_SD_1AU_ARCSEC * ARCSEC / r_au
    pi_s = SUN_HP_1AU_ARCSEC * ARCSEC / r_au
    s_m = np.arcsin(K1 * np.sin(pi_m))
    ru = DANJON * pi_m - s_s + pi_s
    rp = DANJON * pi_m + s_s + pi_s
    return theta, ru, rp, s_m, dmoon


def lunar_case(sky, eid, sites):
    jd_ge = GREATEST_TD[eid] - 69.184 / 86400.0
    lo, hi = jd_ge - 5.0 / 24.0, jd_ge + 5.0 / 24.0
    grid = np.linspace(lo, hi, 301)
    th, *_ = lunar_quantities(sky, grid)
    i = int(np.argmin(th))

    def dist(jd):
        theta, *_ = lunar_quantities(sky, jd)
        return float(theta[0]) if np.ndim(theta) else float(theta)

    jmax = golden_min(dist, grid[i - 1], grid[i + 1])
    theta, ru, rp, s_m, dmoon = lunar_quantities(sky, jmax)
    theta, ru, rp, s_m, dmoon = [float(np.atleast_1d(v)[0]) for v in (theta, ru, rp, s_m, dmoon)]
    out = {
        "id": eid,
        "greatest_jd_utc": c.jd(jmax),
        "gamma": c.Num(dmoon * math.sin(theta) / WGS84_A_KM, 5),
        "umbral_magnitude": c.Num((ru + s_m - theta) / (2 * s_m), 5),
        "penumbral_magnitude": c.Num((rp + s_m - theta) / (2 * s_m), 5),
    }

    def f_of(which):
        def f(jd):
            th, ru_, rp_, sm_, _ = [float(np.atleast_1d(v)[0]) for v in lunar_quantities(sky, jd)]
            return {"p": th - (rp_ + sm_), "u": th - (ru_ + sm_), "i": th - (ru_ - sm_)}[which]

        return f

    contacts = []
    for kinds, which in ((("p1", "p4"), "p"), (("u1", "u4"), "u"), (("u2", "u3"), "i")):
        f = f_of(which)
        if f(jmax) >= 0:
            continue
        contacts.append((kinds[0], bisect(f, lo, jmax)))
        contacts.append((kinds[1], bisect(f, jmax, hi)))
    contacts.append(("max", jmax))
    contacts.sort(key=lambda kv: kv[1])
    out["contacts"] = [c.Inline({"kind": k, "jd_utc": c.jd(j)}) for k, j in contacts]
    local = []
    for sid, name, lat, lon, h in sites:
        if sid != eid:
            continue
        site = sky.topo(lat, lon, h)
        rows = []
        for k, j in contacts:
            alt, az = altaz(site, j, sky, sky.moon)
            rows.append(c.Inline({"kind": k, "moon_alt_deg": c.Num(alt, 4), "moon_az_deg": c.Num(az, 4)}))
        local.append(
            {
                "site": c.Inline({"name": name, "lat_deg": c.Num(lat, 4), "lon_deg": c.Num(lon, 4), "height_m": c.Num(h, 1)}),
                "events": rows,
            }
        )
    out["local"] = local
    return out


def limit_crossing(sky, eid, cone, lon):
    """Latitudes where the limits of `cone` cross meridian `lon` (sea level).

    At a point, g = min over time of (separation - (SD_sun + SD_moon_k1)) for the
    penumbra, or of (separation - |SD_moon_k2 - SD_sun|) for the umbra; the limit is
    where g = 0 (grazing at maximum). A 1-degree scan finds the sign changes, with each
    latitude's minimum located on a 4-minute grid and then a 20-second one around it
    (a short totality near a limit would slip between 4-minute samples). Each change
    is solved to 1e-6 degree by regula falsi, with the minimum refined by a
    golden-section search in time. Only crossings with the Sun above the horizon at
    that maximum are kept: the cones go on through the Earth, but a map limit does not.
    ``inside`` says on which side of the crossing the eclipse region lies.
    """
    jd_ge = GREATEST_TD[eid] - 69.184 / 86400.0
    lo, hi = jd_ge - 4.0 / 24.0, jd_ge + 4.0 / 24.0
    grid = np.linspace(lo, hi, 121)

    def f_of(site, jd):
        sep, sd_s, sd_m1, sd_m2, *_ = solar_quantities(sky, site, jd)
        return sep - (sd_s + sd_m1) if cone == "penumbra" else sep - np.abs(sd_m2 - sd_s)

    def coarse(lat):
        site = sky.topo(lat, lon, 0.0)
        f = f_of(site, grid)
        i = int(np.argmin(f))
        fine = np.linspace(grid[max(i - 1, 0)], grid[min(i + 1, len(grid) - 1)], 25)
        return float(np.min(f_of(site, fine)))

    def g_and_time(lat):
        site = sky.topo(lat, lon, 0.0)
        f = f_of(site, grid)
        i = int(np.argmin(f))
        if i == 0 or i == len(grid) - 1:
            return float(f[i]), float(grid[i])
        jm = golden_min(lambda j: float(f_of(site, j)[0]), grid[i - 1], grid[i + 1], 1e-8)
        return float(f_of(site, jm)[0]), jm

    def g(lat):
        return g_and_time(lat)[0]

    lats = np.arange(-89.5, 90.0, 1.0)
    vals = [coarse(float(la)) for la in lats]
    out = []
    for k in range(len(lats) - 1):
        if vals[k] * vals[k + 1] >= 0:
            continue
        a, b = float(lats[k]), float(lats[k + 1])
        ga, gb = g(a), g(b)
        if ga * gb >= 0:
            continue
        la = illinois(g, a, b, 1e-6)
        _, jm = g_and_time(la)
        alt, _ = altaz(sky.topo(la, lon, 0.0), jm, sky, sky.sun)
        if alt <= 0.0:
            continue
        out.append(
            {
                "lat_deg": c.Num(la, 6),
                "inside": "north" if gb < 0 else "south",
                "jd_utc": c.jd(jm),
                "sun_alt_deg": c.Num(alt, 3),
            }
        )
    return {"id": eid, "cone": cone, "lon_deg": c.Num(lon, 3), "crossings": out}


def build_skyfield():
    sky = Sky()
    solar = [solar_local(sky, *s) for s in SOLAR_SITES]
    lunar = [lunar_case(sky, eid, LUNAR_SITES) for eid in ("2022-11-08-lunar", "2025-03-14-lunar")]
    limits = [limit_crossing(sky, *m) for m in LIMIT_MERIDIANS]
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/reference/gen_eclipses.py",
            "description": (
                "Skyfield + JPL DE440s: solar-eclipse contacts at 22 sites (roots of the topocentric "
                "apparent Sun-Moon separation minus the sum, or the difference, of the "
                "semidiameters), lunar-eclipse contacts with the Moon's altitude at 3 sites each, "
                "and the latitudes where the umbral and penumbral limits of four eclipses cross "
                "chosen meridians."
            ),
            "generated_utc": c.generated_utc(),
            "versions": c.versions(),
            "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
            "timescale": (
                "load.timescale(delta_t=69.184): UT1 = UTC exactly (TAI - UTC = 37 s for every "
                "instant here), the CONVENTIONS section 6 assumption; jd_utc is UTC-based."
            ),
            "geometry": {
                "earth_equatorial_radius_km": c.Num(WGS84_A_KM, 3),
                "moon_radius_k1": c.Num(K1, 6),
                "moon_radius_k2": c.Num(K2, 6),
                "sun_radius_km": c.Num(SUN_RADIUS_KM, 3),
                "semidiameters": "asin(radius / topocentric distance)",
                "external_contacts": "separation = SD_sun + SD_moon(k1)",
                "internal_contacts": "separation = |SD_moon(k2) - SD_sun|",
                "maximum": (
                    "greatest magnitude (SD_sun + SD_moon(k1) - separation) / "
                    "(2 SD_sun + SD_moon(k1) - SD_moon(k2))"
                ),
                "lunar": (
                    "geocentric; theta = 180 deg - elongation of the Moon from the Sun; umbra "
                    "1.01 pi_M - s_S + pi_S, penumbra 1.01 pi_M + s_S + pi_S (Danjon), pi_M = "
                    "asin(6378.14 km / d), s_S = 959.63\"/R, pi_S = 8.794\"/R, s_M = asin(k1 sin pi_M)"
                ),
                "altitudes": "Skyfield altaz() without refraction: topocentric, geometric, centre.",
            },
            "residual_rate": (
                "residual_rate_arcsec_per_s is d/dt of (separation - radii sum or difference) at the "
                "contact: a time error dt at a contact is a separation residual rate * dt."
            ),
            "tolerances": {"contact_time_s": c.Num(5.0, 1), "limit_latitude_deg": c.Num(0.01, 2)},
            "never_a_runtime_dependency": (
                "Development-time reference. CONVENTIONS section 11: never regenerate a fixture "
                "from Rust output."
            ),
        },
        "solar_local": solar,
        "lunar": lunar,
        "limit_crossings": limits,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="skip NASA and USNO (keep existing files)")
    ap.add_argument("--network-only", action="store_true", help="only NASA and USNO, not Skyfield")
    args = ap.parse_args(argv)
    ref = c.FIX_REFERENCE
    if not args.offline:
        c.write_json(os.path.join(ref, "eclipses_nasa_canon.json"), build_canon())
        c.write_json(os.path.join(ref, "eclipses_nasa_paths.json"), build_paths())
        c.write_json(os.path.join(ref, "eclipses_usno_local.json"), build_usno())
    if not args.network_only:
        c.write_json(os.path.join(ref, "eclipses_skyfield.json"), build_skyfield())


if __name__ == "__main__":
    main()
