"""Shared helpers for SkyFix Lab reference-fixture generation.

Development-time only. Nothing in `tools/` is ever a runtime dependency of the
Rust workspace (docs/CONVENTIONS.md section 11).

Everything here exists to make the generated fixtures *independent* of the Rust
implementation: the astronomy comes from Skyfield + JPL DE421 + the Hipparcos
catalogue, and the only formulas re-implemented in Python are the two that the
fixtures are meant to test the Rust code *against* (CONVENTIONS section 3
spherical sight reduction, and CONVENTIONS section 5 Bennett refraction), coded
directly from the text of CONVENTIONS.md and never from Rust source.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import subprocess
import sys

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(HERE, "data")
FIX_REFERENCE = os.path.join(REPO, "fixtures", "reference")
FIX_SESSIONS = os.path.join(REPO, "fixtures", "sessions")
FIX_EXPECTED = os.path.join(REPO, "fixtures", "expected")

EPHEMERIS_FILE = os.path.join(DATA, "de421.bsp")
EPHEMERIS_CROSSCHECK_FILE = os.path.join(DATA, "de440s.bsp")
HIPPARCOS_FILE = os.path.join(DATA, "hip_main.dat")

EPHEMERIS_URL = (
    "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/"
    "a_old_versions/de421.bsp"
)
EPHEMERIS_CROSSCHECK_URL = (
    "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp"
)
HIPPARCOS_URL = "https://cdsarc.cds.unistra.fr/ftp/cats/I/239/hip_main.dat"

# ---------------------------------------------------------------------------
# Constants used by the fixtures (all from CONVENTIONS.md or the Almanac)
# ---------------------------------------------------------------------------

#: Earth's rotation rate, arcseconds of hour angle per second of UT1.
EARTH_ROTATION_ARCSEC_PER_SECOND = 15.041_068_6

#: Solar semidiameter at 1 au, arcseconds (Nautical Almanac / IAU 1976 value).
SUN_SEMIDIAMETER_ARCSEC_AT_1AU = 959.63

#: Solar equatorial horizontal parallax at 1 au, arcseconds (IAU 1976).
SUN_HORIZONTAL_PARALLAX_ARCSEC_AT_1AU = 8.794

#: CONVENTIONS section 1: 1 arcminute of arc == 1 NM == 1852 m exactly.
EARTH_RADIUS_M = 1852.0 * 10800.0 / math.pi

STANDARD_PRESSURE_HPA = 1010.0
STANDARD_TEMPERATURE_C = 10.0

# ---------------------------------------------------------------------------
# Deterministic JSON output
# ---------------------------------------------------------------------------


class Num:
    """A float rendered with a fixed number of decimals, so output is stable."""

    __slots__ = ("v", "d")

    def __init__(self, value, decimals):
        self.v = float(value)
        self.d = int(decimals)


class Inline:
    """A dict/list rendered on a single line (keeps big fixtures readable)."""

    __slots__ = ("o",)

    def __init__(self, obj):
        self.o = obj


def deg(v):
    """Degrees: 9 decimals (~3.6 microarcsec)."""
    return Num(v, 9)


def arcmin(v):
    """Arcminutes: 4 decimals (~0.006 arcsec)."""
    return Num(v, 4)


def arcsec(v):
    """Arcseconds: 4 decimals."""
    return Num(v, 4)


def secs(v):
    """Seconds of time: 6 decimals (so gha_deg_dut1_zero can be re-derived)."""
    return Num(v, 6)


def jd(v):
    """Julian date: 9 decimals (~0.09 ms)."""
    return Num(v, 9)


def metres(v):
    return Num(v, 4)


def _fmt_num(n: Num) -> str:
    s = f"{n.v:.{n.d}f}"
    if s.startswith("-") and float(s) == 0.0:
        s = s[1:]
    return s


def _render(o, level, ind=2, inline=False):
    sp = "" if inline else " " * (ind * level)
    sp2 = "" if inline else " " * (ind * (level + 1))
    nl = "" if inline else "\n"
    sep = ", " if inline else ",\n"

    if isinstance(o, Num):
        return _fmt_num(o)
    if isinstance(o, Inline):
        return _render(o.o, level, ind, inline=True)
    if o is None:
        return "null"
    if o is True:
        return "true"
    if o is False:
        return "false"
    if isinstance(o, str):
        return json.dumps(o, ensure_ascii=False)
    if isinstance(o, int):
        return str(o)
    if isinstance(o, float):
        raise TypeError(
            "bare float %r: wrap every float in deg()/arcmin()/arcsec()/jd() so "
            "the output is byte-for-byte reproducible" % (o,)
        )
    if isinstance(o, dict):
        if not o:
            return "{}"
        items = sorted(o.items(), key=lambda kv: kv[0])
        body = sep.join(
            "%s%s: %s"
            % (sp2, json.dumps(k, ensure_ascii=False), _render(v, level + 1, ind, inline))
            for k, v in items
        )
        return "{" + nl + body + nl + sp + "}"
    if isinstance(o, (list, tuple)):
        if not o:
            return "[]"
        body = sep.join(
            "%s%s" % (sp2, _render(v, level + 1, ind, inline)) for v in o
        )
        return "[" + nl + body + nl + sp + "]"
    raise TypeError("cannot serialise %r" % (type(o),))


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = _render(obj, 0) + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %-58s %8.1f KiB" % (os.path.relpath(path, REPO), len(text) / 1024.0))
    return text


# ---------------------------------------------------------------------------
# Angles
# ---------------------------------------------------------------------------


def norm360(x):
    x = math.fmod(x, 360.0)
    return x + 360.0 if x < 0.0 else x


def norm180(x):
    """Longitude normalisation: (-180, +180] (CONVENTIONS section 1)."""
    x = math.fmod(x, 360.0)
    if x <= -180.0:
        x += 360.0
    elif x > 180.0:
        x -= 360.0
    return x


def wrap_diff_deg(a, b):
    """Signed a - b, wrapped into [-180, 180)."""
    d = math.fmod(a - b + 540.0, 360.0) - 180.0
    return d


# ---------------------------------------------------------------------------
# CONVENTIONS section 3: spherical sight reduction, coded from the text
# ---------------------------------------------------------------------------


def spherical_altitude_azimuth_deg(lat_deg, lon_east_deg, gha_deg, dec_deg):
    """Return (Hc_deg, Zn_deg) from CONVENTIONS section 3.

        sin Hc = sin(phi) sin(dec) + cos(phi) cos(dec) cos(LHA)
        N      = cos(phi) sin(dec) - sin(phi) cos(dec) cos(LHA)
        E      = -cos(dec) sin(LHA)
        Zn     = atan2(E, N) normalised to [0, 360)

    with LHA = GHA + lambda_east (GHA west-positive, longitude east-positive).
    """
    phi = math.radians(lat_deg)
    dec = math.radians(dec_deg)
    lha = math.radians(norm360(gha_deg + lon_east_deg))
    sin_hc = math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(lha)
    sin_hc = max(-1.0, min(1.0, sin_hc))
    hc = math.degrees(math.asin(sin_hc))
    n = math.cos(phi) * math.sin(dec) - math.sin(phi) * math.cos(dec) * math.cos(lha)
    e = -math.cos(dec) * math.sin(lha)
    zn = norm360(math.degrees(math.atan2(e, n)))
    return hc, zn


def gp_of(gha_deg, dec_deg):
    """Geographic position of a body (CONVENTIONS section 2): (lat, lon_east)."""
    return dec_deg, norm180(-gha_deg)


def _unit(lat_deg, lon_deg):
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    return (
        math.cos(la) * math.cos(lo),
        math.cos(la) * math.sin(lo),
        math.sin(la),
    )


def _latlon_of(v):
    x, y, z = v
    r = math.sqrt(x * x + y * y + z * z)
    return math.degrees(math.asin(z / r)), norm180(math.degrees(math.atan2(y, x)))


def two_circle_intersections(gp1, z1_deg, gp2, z2_deg):
    """Both intersections of two circles of position, or [] if they miss.

    gp = (lat_deg, lon_east_deg); z = zenith distance in degrees. Used only to
    fill the two-sight ambiguity fixture with independently computed answers.
    """
    u1 = _unit(*gp1)
    u2 = _unit(*gp2)
    c1 = math.cos(math.radians(z1_deg))
    c2 = math.cos(math.radians(z2_deg))
    dot = sum(a * b for a, b in zip(u1, u2))
    denom = 1.0 - dot * dot
    if abs(denom) < 1e-15:
        return []
    a = (c1 - c2 * dot) / denom
    b = (c2 - c1 * dot) / denom
    p0 = tuple(a * x + b * y for x, y in zip(u1, u2))
    n = (
        u1[1] * u2[2] - u1[2] * u2[1],
        u1[2] * u2[0] - u1[0] * u2[2],
        u1[0] * u2[1] - u1[1] * u2[0],
    )
    n2 = sum(x * x for x in n)
    rem = 1.0 - sum(x * x for x in p0)
    if rem < 0.0 or n2 <= 0.0:
        return []
    s = math.sqrt(rem / n2)
    return [
        _latlon_of(tuple(p + s * q for p, q in zip(p0, n))),
        _latlon_of(tuple(p - s * q for p, q in zip(p0, n))),
    ]


def great_circle_m(lat1, lon1, lat2, lon2):
    """Great-circle distance on the project's sphere (CONVENTIONS section 1)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    c_ = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return math.acos(max(-1.0, min(1.0, c_))) * EARTH_RADIUS_M


def ne_offset_m(lat_ref, lon_ref, lat, lon):
    """Tangent-plane (north, east) offset in metres, CONVENTIONS section 1 sphere."""
    dn = math.radians(lat - lat_ref) * EARTH_RADIUS_M
    de = (
        math.radians(wrap_diff_deg(lon, lon_ref))
        * math.cos(math.radians(lat_ref))
        * EARTH_RADIUS_M
    )
    return dn, de


# ---------------------------------------------------------------------------
# CONVENTIONS section 5: the correction chain, coded from the text
# ---------------------------------------------------------------------------


def bennett_refraction_arcmin(
    ha_deg, pressure_hpa=STANDARD_PRESSURE_HPA, temperature_c=STANDARD_TEMPERATURE_C
):
    """CONVENTIONS section 5 step 3, verbatim.

        R' = cot(Ha_deg + 7.31 / (Ha_deg + 4.4))  arcmin
        scaled by (P / 1010) * (283 / (273 + T))

    `ha_deg` is the *apparent* altitude. Valid for Ha >= 0.
    """
    if ha_deg < 0.0:
        raise ValueError("RefractionOutOfRange: Ha = %r deg < 0" % (ha_deg,))
    arg = math.radians(ha_deg + 7.31 / (ha_deg + 4.4))
    r = 1.0 / math.tan(arg)
    return r * (pressure_hpa / 1010.0) * (283.0 / (273.0 + temperature_c))


def dip_arcmin(height_of_eye_m):
    """CONVENTIONS section 5 step 2, sea horizon: 1.76' * sqrt(h_m)."""
    if height_of_eye_m < 0.0:
        raise ValueError("height_of_eye_m must be >= 0")
    return 1.76 * math.sqrt(height_of_eye_m)


def parallax_in_altitude_arcmin(hp_arcmin, ha_deg):
    """CONVENTIONS section 5 step 5: PA = HP * cos(Ha)."""
    return hp_arcmin * math.cos(math.radians(ha_deg))


def ho_from_hs(
    hs_deg,
    index_correction_arcmin,
    height_of_eye_m,
    semidiameter_arcmin,
    horizontal_parallax_arcmin,
    limb,
    pressure_hpa=STANDARD_PRESSURE_HPA,
    temperature_c=STANDARD_TEMPERATURE_C,
):
    """Forward CONVENTIONS section 5 chain for a sea horizon. Returns a dict."""
    limb_sign = {"lower": +1.0, "upper": -1.0, "center": 0.0}[limb]
    after_ic = hs_deg + index_correction_arcmin / 60.0
    dip = dip_arcmin(height_of_eye_m)
    ha = after_ic - dip / 60.0
    r = bennett_refraction_arcmin(ha, pressure_hpa, temperature_c)
    sd = limb_sign * semidiameter_arcmin
    pa = parallax_in_altitude_arcmin(horizontal_parallax_arcmin, ha)
    ho = ha + (-r + sd + pa) / 60.0
    return {
        "hs_deg": hs_deg,
        "after_index_correction_deg": after_ic,
        "dip_arcmin": dip,
        "ha_deg": ha,
        "refraction_arcmin": r,
        "semidiameter_applied_arcmin": sd,
        "parallax_in_altitude_arcmin": pa,
        "ho_deg": ho,
    }


def hs_from_ho(
    ho_deg,
    index_correction_arcmin,
    height_of_eye_m,
    semidiameter_arcmin,
    horizontal_parallax_arcmin,
    limb,
    pressure_hpa=STANDARD_PRESSURE_HPA,
    temperature_c=STANDARD_TEMPERATURE_C,
    tol_deg=1e-13,
    max_iter=100,
):
    """Exact inverse of `ho_from_hs`, solved for Ha by fixed-point iteration.

    Forward:  Ho = Ha - R(Ha) + limb_sign*SD + HP*cos(Ha)
    Inverse:  Ha = Ho + R(Ha) - limb_sign*SD - HP*cos(Ha)   (iterate)
    then      Hs = Ha + dip - IC
    """
    limb_sign = {"lower": +1.0, "upper": -1.0, "center": 0.0}[limb]
    dip = dip_arcmin(height_of_eye_m)
    ha = ho_deg
    for _ in range(max_iter):
        r = bennett_refraction_arcmin(ha, pressure_hpa, temperature_c)
        pa = parallax_in_altitude_arcmin(horizontal_parallax_arcmin, ha)
        ha_new = ho_deg + (r - limb_sign * semidiameter_arcmin - pa) / 60.0
        if abs(ha_new - ha) < tol_deg:
            ha = ha_new
            break
        ha = ha_new
    else:
        raise RuntimeError("hs_from_ho did not converge for Ho=%r" % (ho_deg,))
    hs = ha + dip / 60.0 - index_correction_arcmin / 60.0
    return {
        "hs_deg": hs,
        "ha_deg": ha,
        "dip_arcmin": dip,
        "refraction_arcmin": bennett_refraction_arcmin(ha, pressure_hpa, temperature_c),
        "semidiameter_applied_arcmin": limb_sign * semidiameter_arcmin,
        "parallax_in_altitude_arcmin": parallax_in_altitude_arcmin(
            horizontal_parallax_arcmin, ha
        ),
    }


# ---------------------------------------------------------------------------
# Skyfield loading
# ---------------------------------------------------------------------------


def versions():
    import numpy
    import pandas
    import skyfield
    import jplephem

    return {
        "python": sys.version.split()[0],
        "skyfield": skyfield.__version__,
        "numpy": numpy.__version__,
        "pandas": pandas.__version__,
        "jplephem": getattr(jplephem, "__version__", "2.24"),
    }


def file_facts(path, url):
    st = os.stat(path)
    return {
        "file": os.path.basename(path),
        "url": url,
        "size_bytes": st.st_size,
        "sha256": _sha256(path),
    }


def _sha256(path):
    out = subprocess.run(
        ["sha256sum", path], check=True, capture_output=True, text=True
    ).stdout
    return out.split()[0]


def load_timescale():
    from skyfield.api import load

    return load.timescale(builtin=True)


def load_ephemeris(path=None):
    from skyfield.api import load_file

    return load_file(path or EPHEMERIS_FILE)


def load_hipparcos_frame():
    from skyfield.data import hipparcos

    with open(HIPPARCOS_FILE, "rb") as f:
        return hipparcos.load_dataframe(f)


def timescale_facts():
    """What `load.timescale(builtin=True)` implies, measured, not asserted."""
    import numpy as np
    from skyfield.iokit import load_bundled_npy

    ts = load_timescale()
    a = load_bundled_npy("iers.npz")
    tt = a["tt_jd_minus_arange"] + np.arange(len(a["tt_jd_minus_arange"]))
    t0 = ts.tt_jd(float(tt[0]))
    t1 = ts.tt_jd(float(tt[-1]))
    return {
        "call": "skyfield.api.load.timescale(builtin=True)",
        "delta_t_source": (
            "Skyfield's bundled skyfield/data/iers.npz, a daily Delta-T table built "
            "from the IERS finals2000A.all series at the time the Skyfield wheel was "
            "released. Outside the table Skyfield extrapolates with its long-term "
            "Delta-T model (Morrison & Stephenson / Espenak & Meeus)."
        ),
        "delta_t_table_utc_span": [
            t0.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
            t1.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
        ],
        "leap_second_table": "bundled in the same iers.npz; latest offset 37 s from 2017-01-01",
        "dut1_definition": "DUT1 = UT1 - UTC = 32.184 + Delta_AT - Delta_T, as Skyfield derives it",
        "polar_motion": "not applied (no polar-motion table installed)",
        "warning_dut1": (
            "CONVENTIONS section 6 assumes DUT1 = 0. Skyfield does not: every GHA in "
            "these fixtures uses Skyfield's UT1. The per-epoch dut1_s is recorded, and "
            "gha_deg_dut1_zero gives the same GHA recomputed with UT1 = UTC so a "
            "DUT1 = 0 implementation has a directly comparable number. "
            "1 s of DUT1 = %.7f arcsec of GHA. Beyond the Delta-T table's end the "
            "extrapolated Delta-T implies |DUT1| far above the 0.9 s that real leap "
            "seconds enforce (about -3.5 s at 2055), so gha_deg alone is not a "
            "physically meaningful prediction for far-future epochs; "
            "gha_deg_dut1_zero is."
        )
        % EARTH_ROTATION_ARCSEC_PER_SECOND,
    }


def gha_dut1_zero_deg(gha_deg, dut1_s):
    """The same GHA recomputed with UT1 == UTC.

    Only GAST depends on UT1; d(GAST)/d(UT1) is constant to 1e-12 over the few
    seconds involved, so subtracting the rotation angle is exact to far better
    than a microarcsecond.
    """
    return norm360(gha_deg - EARTH_ROTATION_ARCSEC_PER_SECOND * dut1_s / 3600.0)


def generated_utc():
    """Build timestamp, overridable for byte-for-byte reproducibility.

    Set SOURCE_DATE_EPOCH (the reproducible-builds convention) to pin it. With
    it set, two runs on the same inputs produce byte-identical files; without
    it, `generated_utc` is the only field in any fixture that changes between
    runs, and every numeric value is already stable.
    """
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    when = (
        _dt.datetime.fromtimestamp(int(sde), _dt.timezone.utc)
        if sde
        else _dt.datetime.now(_dt.timezone.utc)
    )
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def generator_block(
    tool,
    description,
    tolerance_arcmin,
    tolerance_justification,
    frame_notes=None,
    refraction=None,
    extra=None,
):
    block = {
        "tool": tool,
        "description": description,
        "generated_utc": generated_utc(),
        "versions": versions(),
        "timescale": timescale_facts(),
        "tolerance_arcmin": tolerance_arcmin,
        "tolerance_justification": tolerance_justification,
        "never_a_runtime_dependency": (
            "Generated by tools/reference/ (Python + Skyfield). CONVENTIONS section 11: "
            "never regenerate a fixture from Rust output."
        ),
    }
    if frame_notes is not None:
        block["frame"] = frame_notes
    if refraction is not None:
        block["refraction"] = refraction
    if extra:
        block.update(extra)
    return block


GEOCENTRIC_FRAME_NOTES = {
    "definition": (
        "Apparent geocentric of date (CONVENTIONS section 7): true equator and "
        "equinox of date."
    ),
    "computed_as": (
        "earth.at(t).observe(body).apparent().radec(epoch='date'); "
        "GHA = normalise(t.gast * 15 - RA_deg) into [0, 360)."
    ),
    "includes": [
        "precession and nutation to the true equator and equinox of date (Skyfield's IAU 2000A/2006 model)",
        "annual aberration (Earth's barycentric velocity)",
        "relativistic light deflection by the Sun",
        "light-time (Sun and planets)",
        "stellar proper motion and annual parallax from the Hipparcos catalogue (stars)",
    ],
    "excludes": [
        "polar motion",
        "diurnal aberration (this is a geocentric frame; the observer is not moving in it)",
        "topocentric parallax (CONVENTIONS section 5 applies it as an altitude correction)",
        "atmospheric refraction",
    ],
    "gha_sign": "west-positive, [0, 360), as tabulated in the Nautical Almanac",
    "sha": "SHA = 360 - RA_deg; GHA_star = GHA_Aries + SHA",
}

SKYFIELD_REFRACTION_NOTES = {
    "formula": (
        "Bennett (1982) as given by Meeus: R_deg = 0.016667 / "
        "tan(radians(h + 7.31 / (h + 4.4)))"
    ),
    "scaling": "R * (0.28 * pressure_mbar / (temperature_C + 273.0))",
    "applied_to": (
        "the topocentric *apparent* altitude: skyfield.earthlib.refract() iterates "
        "h_app = h_true + R(h_app) until the change is below 3e-5 deg (0.108 arcsec), "
        "so Bennett's formula is evaluated at the refracted altitude, which is how "
        "Bennett defined it and how CONVENTIONS section 5 step 3 uses it."
    ),
    "range": "zero refraction is returned below -1 deg and above 89.9 deg altitude",
    "difference_from_conventions_section_5": (
        "CONVENTIONS section 5 writes R' = cot(...) arcmin scaled by "
        "(P/1010)*(283/(273+T)). Skyfield's constant 0.016667 deg = 1.00002 arcmin "
        "(+2e-5 arcmin) and its scale factor 0.28*P/(T+273) is 0.999293 of the "
        "CONVENTIONS factor at 1010 hPa / 10 C. The two therefore differ by about "
        "0.07 % of the refraction: 0.0007 arcmin at R = 1 arcmin, 0.024 arcmin at "
        "R = 34 arcmin near the horizon. Fixture files that must exercise the "
        "CONVENTIONS chain exactly (reference-sun-sextant) use the Python "
        "reimplementation in tools/reference/common.py, not Skyfield's."
    ),
}


# ---------------------------------------------------------------------------
# The 58 bodies: 57 Nautical Almanac navigational stars plus Polaris
# ---------------------------------------------------------------------------
#
# name, HIP, Bayer/Flamsteed designation, expected V magnitude, expected J2000
# RA/Dec in degrees. The expected values are an INDEPENDENT identity check: they
# come from general astronomical knowledge, not from the catalogue file, and the
# generator fails loudly if a HIP number resolves to something that is not the
# star the name promises.

NAV_STARS = [
    # name,              hip,    designation,        mag,    ra_deg,   dec_deg
    ("Acamar",           13847, "theta-1 Eridani",   2.88,   44.565,  -40.305),
    ("Achernar",          7588, "alpha Eridani",     0.45,   24.429,  -57.237),
    ("Acrux",            60718, "alpha-1 Crucis",    0.77,  186.650,  -63.099),
    ("Adhara",           33579, "epsilon Canis Majoris", 1.50, 104.656, -28.972),
    ("Aldebaran",        21421, "alpha Tauri",       0.87,   68.980,   16.509),
    ("Alioth",           62956, "epsilon Ursae Majoris", 1.76, 193.507, 55.960),
    ("Alkaid",           67301, "eta Ursae Majoris", 1.85,  206.885,   49.313),
    ("Al Na'ir",        109268, "alpha Gruis",       1.74,  332.058,  -46.961),
    ("Alnilam",          26311, "epsilon Orionis",   1.69,   84.053,   -1.202),
    ("Alphard",          46390, "alpha Hydrae",      1.99,  141.897,   -8.659),
    ("Alphecca",         76267, "alpha Coronae Borealis", 2.23, 233.672, 26.715),
    ("Alpheratz",          677, "alpha Andromedae",  2.07,    2.097,   29.090),
    ("Altair",           97649, "alpha Aquilae",     0.76,  297.696,    8.868),
    ("Ankaa",             2081, "alpha Phoenicis",   2.40,    6.571,  -42.306),
    ("Antares",          80763, "alpha Scorpii",     1.06,  247.352,  -26.432),
    ("Arcturus",         69673, "alpha Bootis",     -0.05,  213.915,   19.182),
    ("Atria",            82273, "alpha Trianguli Australis", 1.91, 252.166, -69.028),
    ("Avior",            41037, "epsilon Carinae",   1.86,  125.628,  -59.510),
    ("Bellatrix",        25336, "gamma Orionis",     1.64,   81.283,    6.350),
    ("Betelgeuse",       27989, "alpha Orionis",     0.45,   88.793,    7.407),
    ("Canopus",          30438, "alpha Carinae",    -0.62,   95.988,  -52.696),
    ("Capella",          24608, "alpha Aurigae",     0.08,   79.172,   45.998),
    ("Deneb",           102098, "alpha Cygni",       1.25,  310.358,   45.280),
    ("Denebola",         57632, "beta Leonis",       2.14,  177.265,   14.572),
    ("Diphda",            3419, "beta Ceti",         2.04,   10.897,  -17.987),
    ("Dubhe",            54061, "alpha Ursae Majoris", 1.81, 165.932,   61.751),
    ("Elnath",           25428, "beta Tauri",        1.65,   81.573,   28.608),
    ("Eltanin",          87833, "gamma Draconis",    2.23,  269.152,   51.489),
    ("Enif",            107315, "epsilon Pegasi",    2.38,  326.046,    9.875),
    ("Fomalhaut",       113368, "alpha Piscis Austrini", 1.16, 344.413, -29.622),
    ("Gacrux",           61084, "gamma Crucis",      1.59,  187.791,  -57.113),
    ("Gienah",           59803, "gamma Corvi",       2.59,  183.952,  -17.542),
    ("Hadar",            68702, "beta Centauri",     0.61,  210.956,  -60.373),
    ("Hamal",             9884, "alpha Arietis",     2.00,   31.793,   23.463),
    ("Kaus Australis",   90185, "epsilon Sagittarii", 1.85, 276.043,  -34.385),
    ("Kochab",           72607, "beta Ursae Minoris", 2.07, 222.676,   74.156),
    ("Markab",          113963, "alpha Pegasi",      2.49,  346.190,   15.205),
    ("Menkar",           14135, "alpha Ceti",        2.53,   45.570,    4.090),
    ("Menkent",          68933, "theta Centauri",    2.06,  211.671,  -36.370),
    ("Miaplacidus",      45238, "beta Carinae",      1.67,  138.300,  -69.717),
    ("Mirfak",           15863, "alpha Persei",      1.79,   51.081,   49.861),
    ("Nunki",            92855, "sigma Sagittarii",  2.02,  283.816,  -26.297),
    ("Peacock",         100751, "alpha Pavonis",     1.94,  306.412,  -56.735),
    ("Pollux",           37826, "beta Geminorum",    1.16,  116.329,   28.026),
    ("Procyon",          37279, "alpha Canis Minoris", 0.40, 114.826,    5.225),
    ("Rasalhague",       86032, "alpha Ophiuchi",    2.08,  263.734,   12.560),
    ("Regulus",          49669, "alpha Leonis",      1.36,  152.093,   11.967),
    ("Rigel",            24436, "beta Orionis",      0.18,   78.634,   -8.202),
    ("Rigil Kentaurus",  71683, "alpha-1 Centauri",  -0.01, 219.902,  -60.835),
    ("Sabik",            84012, "eta Ophiuchi",      2.43,  257.595,  -15.725),
    ("Schedar",           3179, "alpha Cassiopeiae", 2.24,   10.127,   56.537),
    ("Shaula",           85927, "lambda Scorpii",    1.63,  263.402,  -37.104),
    ("Sirius",           32349, "alpha Canis Majoris", -1.44, 101.287, -16.716),
    ("Spica",            65474, "alpha Virginis",    0.98,  201.298,  -11.161),
    ("Suhail",           44816, "lambda Velorum",    2.21,  136.999,  -43.433),
    ("Vega",             91262, "alpha Lyrae",       0.03,  279.234,   38.784),
    ("Zubenelgenubi",    72622, "alpha-2 Librae",    2.75,  222.720,  -16.042),
    ("Polaris",          11767, "alpha Ursae Minoris", 1.97,  37.955,   89.264),
]

#: Caveats worth carrying into the fixture file.
STAR_NOTES = {
    "Acrux": (
        "HIP 60718 is alpha-1 Crucis, the brighter component of a close visual pair "
        "(alpha-2 is HIP 60719, V 1.73). The Nautical Almanac tabulates the combined "
        "image. Using alpha-1 alone displaces the position by about 4 arcsec, well "
        "inside this file's tolerance."
    ),
    "Rigil Kentaurus": (
        "HIP 71683 is alpha Centauri A. The Almanac's Rigil Kentaurus is the combined "
        "A+B image, which orbits with a period of 80 years; the A-only position can "
        "differ from the photocentre by several arcseconds, and the 3.7 arcsec/yr "
        "proper motion makes the epoch matter."
    ),
    "Zubenelgenubi": (
        "HIP 72622 is alpha-2 Librae, the brighter (V 2.75) of the wide alpha Librae "
        "pair; this is the star the Almanac tabulates."
    ),
    "Gienah": (
        "Gienah here is gamma Corvi (HIP 59803), the Nautical Almanac's Gienah. The "
        "IAU confirmed the name for gamma Corvi in 2016 and named epsilon Cygni "
        "Aljanah, so older sources that call epsilon Cygni 'Gienah' mean a "
        "different star."
    ),
    "Betelgeuse": (
        "Semiregular variable, V roughly 0.0 to 1.3. The catalogue magnitude is a "
        "single epoch and is not a prediction."
    ),
    "Polaris": (
        "Not one of the 57 tabulated navigational stars; the Almanac gives Polaris "
        "its own tables. Included here because the project needs it."
    ),
    "Acamar": (
        "theta-1 Eridani, the brighter component of the theta Eridani pair."
    ),
}

STAR_NAMES = [s[0] for s in NAV_STARS]
BODY_NAMES = ["Sun"] + STAR_NAMES


def build_stars(df):
    """Return {name: skyfield Star} and the verification report."""
    from skyfield.api import Star

    stars = {}
    problems = []
    rows = {}
    for name, hip, designation, exp_mag, exp_ra, exp_dec in NAV_STARS:
        row = df.loc[hip]
        ra = float(row.ra_degrees)
        dec = float(row.dec_degrees)
        mag = float(row.magnitude)
        sep = _angular_sep_deg(ra, dec, exp_ra, exp_dec)
        if sep > 0.2:
            problems.append(
                "%s (HIP %d): catalogue position %.4f %+.4f is %.3f deg from the "
                "expected %s position %.4f %+.4f"
                % (name, hip, ra, dec, sep, designation, exp_ra, exp_dec)
            )
        if abs(mag - exp_mag) > 0.5:
            problems.append(
                "%s (HIP %d): catalogue V %.2f differs from the expected %.2f by %.2f"
                % (name, hip, mag, exp_mag, abs(mag - exp_mag))
            )
        rows[name] = (row, sep, mag - exp_mag)
        stars[name] = Star.from_dataframe(row)
    return stars, rows, problems


def _angular_sep_deg(ra1, dec1, ra2, dec2):
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(r1 - r2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


# ---------------------------------------------------------------------------
# Observers
# ---------------------------------------------------------------------------

PHILADELPHIA = ("philadelphia_city_hall", 39.9526, -75.1652, 10.0)

OBSERVERS = [
    PHILADELPHIA,
    ("sydney", -33.8688, 151.2093, 0.0),
    ("longyearbyen", 78.2232, 15.6267, 0.0),
    ("suva_fiji", -18.1416, 178.4419, 0.0),
    ("antimeridian_equator", 0.0, 179.99, 0.0),
]


def topos(lat_deg, lon_deg, elevation_m):
    from skyfield.api import wgs84

    return wgs84.latlon(lat_deg, lon_deg, elevation_m=elevation_m)


# ---------------------------------------------------------------------------
# Per-epoch geocentric computation, shared by several generators
# ---------------------------------------------------------------------------


def jd_utc_of(t):
    """Exact Julian date of the UTC calendar instant (Gregorian, 1995-2055)."""
    y, m, d, hh, mm, ss = t.utc
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    jd0 = (
        math.floor(365.25 * (y + 4716))
        + math.floor(30.6001 * (m + 1))
        + d
        + b
        - 1524.5
    )
    return jd0 + (hh + mm / 60.0 + ss / 3600.0) / 24.0


def epoch_header(t):
    return {
        "utc": t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
        "jd_utc": jd(jd_utc_of(t)),
        "delta_t_s": secs(float(t.delta_t)),
        "dut1_s": secs(float(t.dut1)),
        "gast_hours": Num(float(t.gast), 12),
        "gha_aries_deg": deg(norm360(float(t.gast) * 15.0)),
        "gha_aries_deg_dut1_zero": deg(
            gha_dut1_zero_deg(norm360(float(t.gast) * 15.0), float(t.dut1))
        ),
    }


def geocentric_of(earth, t, target):
    """Apparent geocentric of date. Returns (gha_deg, dec_deg, ra_deg, distance_au)."""
    app = earth.at(t).observe(target).apparent()
    ra, dec, dist = app.radec(epoch="date")
    ra_deg = ra._degrees if hasattr(ra, "_degrees") else ra.hours * 15.0
    dec_deg = dec.degrees
    gha = norm360(float(t.gast) * 15.0 - ra_deg)
    return gha, float(dec_deg), float(ra_deg), float(dist.au)


def sun_disc(distance_au):
    """Semidiameter and horizontal parallax in arcminutes at a given distance."""
    return (
        SUN_SEMIDIAMETER_ARCSEC_AT_1AU / distance_au / 60.0,
        SUN_HORIZONTAL_PARALLAX_ARCSEC_AT_1AU / distance_au / 60.0,
    )
