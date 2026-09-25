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

# The long-span kernels (expansion programme, deeptime agent). All four JPL kernels
# live in tools/reference/data/ (git-ignored); KERNELS maps the --kernel names to them.
NAIF_PLANETS = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/"
KERNELS = {
    "de421": {"files": ["de421.bsp"], "url": NAIF_PLANETS + "a_old_versions/de421.bsp",
              "span": "1899-07-29 .. 2053-10-09"},
    "de440s": {"files": ["de440s.bsp"], "url": NAIF_PLANETS + "de440s.bsp",
               "span": "1849-12-26 .. 2150-01-22"},
    "de440": {"files": ["de440.bsp"], "url": NAIF_PLANETS + "de440.bsp",
              "span": "1549-12-31 .. 2650-01-25"},
    # NAIF splits DE441 at 1969: part 1 is -13200 .. 1969-07-30, part 2 1969-06-28 .. 17191.
    "de441": {"files": ["de441_part-1.bsp", "de441_part-2.bsp"],
              "url": NAIF_PLANETS + "de441_part-1.bsp and de441_part-2.bsp",
              "span": "-13200 .. 17191"},
}
#: Where DE441 changes file: dates before this Julian date (TDB) use part 1.
DE441_SPLIT_JD = 2440400.5

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


def load_builtin_timescale():
    """Skyfield's own bundled timescale: what every fixture generated before the
    expansion programme used (their generator blocks say so)."""
    from skyfield.api import load

    return load.timescale(builtin=True)


def load_timescale(dut1_zero=False):
    """The app's clock as a Skyfield timescale (`ClockTimescale`): SkyFix Lab's own Delta T
    and IERS table (tools/timescales/skyfield_timescale.py), with `ts.utc(...)` read as
    an instant on the app's clock (CONVENTIONS 15.2: UTC 1972-2035, UT outside) and a
    Time's UTC labels, `t.utc`, `utc_strftime()` and `dut1` read back on that clock.
    `dut1_zero=True` gives UT1 = UTC on the UTC scale (the "DUT1 = 0" columns)."""
    return _clock_timescale(dut1_zero)


def project_timescales():
    """``(ts, ts_dut1_zero, clock_time)``: `load_timescale()` both ways and
    tools/timescales/skyfield_timescale.py's `clock_time(ts, jd_clock)`."""
    mod = _skyfield_timescale_module()
    return load_timescale(), load_timescale(dut1_zero=True), mod.clock_time


_TS_MODULE = []


def _skyfield_timescale_module():
    if not _TS_MODULE:
        import importlib.util

        path = os.path.join(REPO, "tools", "timescales", "skyfield_timescale.py")
        spec = importlib.util.spec_from_file_location("skyfield_timescale", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _TS_MODULE.append(mod)
    return _TS_MODULE[0]


# ---------------------------------------------------------------------------
# The app's clock inside Skyfield (expansion programme)
# ---------------------------------------------------------------------------
#
# CONVENTIONS 15.2: the app's clock reads UTC from 1972-01-01 to 2035-12-31 and UT (UT1)
# outside, where TT = UT1 + Delta T. Skyfield's `ts.utc()` would instead continue UTC past
# 2035 with the leap seconds frozen (TT = UTC + 69.184 s), which puts an instant labelled
# 2055-01-01T00:00:00Z about 6 s of UT1 away from the app's. `ClockTimescale` reads every
# calendar date it is given on the app's clock, and a Time made by it reports its UTC
# fields (`t.utc`, `utc_strftime()`, `utc_iso()`, `utc_datetime()`) and `dut1` on that
# clock too: the UT reading and DUT1 = 0 outside the UTC scale. Inside 1972-2035 it is
# exactly Skyfield's UTC.

#: [start, end) of the UTC scale on the app's clock, Julian dates (1972-01-01, 2036-01-01).
UTC_SCALE_JD = (2_441_317.5, 2_464_693.5)

_CLOCK_CLASS = []


def _clock_class():
    if _CLOCK_CLASS:
        return _CLOCK_CLASS[0]
    import numpy as np
    from skyfield import timelib
    from skyfield.descriptorlib import reify
    from skyfield.timelib import Time, Timescale, calendar_tuple

    class ClockTimescale(Timescale):
        """A Skyfield Timescale whose calendar dates are the app's clock (see above)."""

        def _utc(self, tup):
            year, month, day, hour, minute, second = tup
            whole, fraction = self._jd(year, month, day, hour, minute, second)
            jd = np.asarray(whole + fraction, dtype=float)
            on_utc = (jd >= UTC_SCALE_JD[0]) & (jd < UTC_SCALE_JD[1])
            if np.all(on_utc):
                return Timescale._utc(self, tup)
            t_ut = self.ut1_jd(jd if jd.ndim else float(jd))
            if not np.any(on_utc):
                return t_ut
            t_utc = Timescale._utc(self, tup)
            return self.tt_jd(np.where(on_utc, t_utc.whole, t_ut.whole),
                              np.where(on_utc, t_utc.tt_fraction, t_ut.tt_fraction))

    def on_utc_scale(t):
        """True where a Time of a ClockTimescale falls on the UTC part of the clock."""
        utc = t.whole - 0.5 + (t.tt_fraction + 0.5) - (32.184 + t._leap_seconds()) / 86400.0
        return (utc >= UTC_SCALE_JD[0]) & (utc < UTC_SCALE_JD[1])

    base_utc_tuple = Time._utc_tuple

    def _utc_tuple(self, offset, return_jd=False):
        out = base_utc_tuple(self, offset, return_jd)
        if not isinstance(self.ts, ClockTimescale):
            return out
        on_utc = on_utc_scale(self)
        if np.all(on_utc):
            return out
        whole = self.whole
        fraction = self.ut1_fraction + offset / 86400.0
        ut = calendar_tuple(whole, fraction, self.ts.julian_calendar_cutoff)
        ut = list(ut)
        if return_jd:
            ut.append(np.floor(whole + fraction + 0.5).astype(np.int64))
        if not np.any(on_utc):
            return tuple(ut)
        return tuple(np.where(on_utc, a, b) for a, b in zip(out, ut))

    def dut1(self):
        value = 32.184 + self._leap_seconds() - self.delta_t
        if isinstance(self.ts, ClockTimescale):
            value = np.where(on_utc_scale(self), value, 0.0)
            if np.ndim(value) == 0:
                value = float(value)
        return value

    Time._utc_tuple = _utc_tuple
    Time.dut1 = reify(dut1)
    timelib._skyfix_clock = True
    _CLOCK_CLASS.append(ClockTimescale)
    return ClockTimescale


def _clock_timescale(dut1_zero=False):
    mod = _skyfield_timescale_module()
    base = mod.dut1_zero_timescale() if dut1_zero else mod.timescale()
    cls = _clock_class()
    ts = cls.__new__(cls)
    ts.__dict__.update(base.__dict__)
    return ts


def clock_jd(t):
    """The app's clock reading of a Skyfield Time, as a Julian date (float or array)."""
    import numpy as np

    y, mo, d, h, mi, s = t.utc
    frac = (np.asarray(h) * 3600.0 + np.asarray(mi) * 60.0 + np.asarray(s)) / 86400.0
    jd0 = np.vectorize(lambda a, b, cc: jd_from_gregorian(int(a), int(b), int(cc)))(y, mo, d)
    out = jd0 + frac
    return float(out) if np.ndim(out) == 0 else out


def clock_time(ts, jd_clock):
    """The Skyfield Time of an instant on the app's clock (scalar)."""
    return _skyfield_timescale_module().clock_time(ts, jd_clock)


def project_timescale_facts():
    return {
        "call": "tools/timescales/skyfield_timescale.py timescale() and dut1_zero_timescale()",
        "delta_t_source": (
            "SkyFix Lab's own Delta T (crates/skyfix-core/src/deltat/data.rs): Stephenson, "
            "Morrison & Hohenkerk 2016/2020 splines, the IERS weekly table 1973 on, the "
            "long-term parabola beyond, joined as Skyfield 1.55 joins them"
        ),
        "clock": (
            "the app's clock (CONVENTIONS 15.2): UTC 1972-01-01 .. 2035-12-31, UT (= UT1) "
            "outside; clock_time() turns a clock instant into TT and UT1"
        ),
        "dut1_zero": (
            "gha_deg_dut1_zero columns use dut1_zero_timescale(): UT1 = UTC on the UTC scale "
            "(the Nautical Almanac's and USNO's convention), the model's UT1 outside"
        ),
    }


def load_ephemeris(path=None):
    """A kernel file by path (`EPHEMERIS_FILE`, DE421, when none is given)."""
    from skyfield.api import load_file

    return load_file(path or EPHEMERIS_FILE)


# ---------------------------------------------------------------------------
# --window and --kernel (expansion programme): every generator takes both
# ---------------------------------------------------------------------------
#
# A window is written `START..END` with proleptic-Gregorian dates or bare years in
# astronomical numbering (year 0 = 1 BC): `1990..2060`, `1550-01-01..2650-01-22`,
# `-2000..3000`. A bare START year means January 1 of it; a bare END year means the
# end of December 31 of it. The kernel is `auto` (the choice of EXPANSION_PLAN 4.6:
# DE440s inside 1849-2150, DE440 inside 1550-2650, DE441 outside) or one of KERNELS.


def jd_from_gregorian(year, month=1, day=1, hour=0.0):
    """Julian date of a proleptic-Gregorian civil date, any integer year
    (astronomical numbering). Fliegel & Van Flandern with floor division."""
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    jdn = day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    return jdn - 0.5 + hour / 24.0


def gregorian_from_jd(jd):
    """(year, month, day, hour) of a Julian date, proleptic Gregorian, any year."""
    z = math.floor(jd + 0.5)
    frac = jd + 0.5 - z
    a = z + 32044
    b = (4 * a + 3) // 146097
    cc = a - 146097 * b // 4
    d = (4 * cc + 3) // 1461
    e = cc - 1461 * d // 4
    m = (5 * e + 2) // 153
    day = e - (153 * m + 2) // 5 + 1
    month = m + 3 - 12 * (m // 10)
    year = 100 * b + d - 4800 + m // 10
    return int(year), int(month), int(day), frac * 24.0


def iso_utc(jd):
    """ISO 8601 text of a Julian date: four-digit years inside 0000-9999, a sign and
    at least four digits outside (EXPLORER_API "Dates and years on the wire")."""
    y, mo, d, h = gregorian_from_jd(jd)
    secs = round(h * 3600.0)
    if secs >= 86400:
        y, mo, d, _ = gregorian_from_jd(math.floor(jd + 0.5) + 0.5)
        secs = 0
    hh, rem = divmod(secs, 3600)
    mm, ss = divmod(rem, 60)
    year = "%04d" % y if 0 <= y <= 9999 else ("%+05d" % y)
    return "%s-%02d-%02dT%02d:%02d:%02dZ" % (year, mo, d, hh, mm, ss)


def _parse_window_end(text, end):
    text = text.strip()
    sign = -1 if text.startswith("-") else 1
    body = text[1:] if text[:1] in "+-" else text
    parts = body.split("-")
    year = sign * int(parts[0])
    if len(parts) == 1:
        return jd_from_gregorian(year + 1, 1, 1) if end else jd_from_gregorian(year, 1, 1)
    month = int(parts[1])
    day = int(parts[2]) if len(parts) > 2 else 1
    return jd_from_gregorian(year, month, day)


def parse_window(text):
    """`START..END` -> (jd_start, jd_end)."""
    if ".." not in text:
        raise ValueError("a window is START..END, e.g. 1550..2650 or -2000..3000: %r" % text)
    a, b = text.split("..", 1)
    j0, j1 = _parse_window_end(a, False), _parse_window_end(b, True)
    if not j1 > j0:
        raise ValueError("window %r is empty" % text)
    return j0, j1


def kernel_for_window(jd_start, jd_end):
    """EXPANSION_PLAN 4.6: DE440s inside 1849-2150, DE440 inside 1550-2650, else DE441."""
    if jd_start >= jd_from_gregorian(1849, 12, 27) and jd_end <= jd_from_gregorian(2150, 1, 21):
        return "de440s"
    if jd_start >= jd_from_gregorian(1550, 1, 1) and jd_end <= jd_from_gregorian(2650, 1, 22):
        return "de440"
    return "de441"


class KernelSet:
    """One JPL kernel, possibly split over several files (DE441), behind one lookup.

    It behaves like a Skyfield ephemeris: `k["earth"]`, `k["moon"] - k["earth"]`,
    `k["earth"].at(t).observe(k["mars barycenter"]).apparent()` work across DE441's
    two files for scalar and array times alike (each instant is answered by the file
    that covers it), and so does Skyfield's light deflection, which looks deflectors up
    by name. `segment(jd_tdb)` returns the file object itself;
    `position_km(target, jd_tdb, center)` evaluates arrays across the split."""

    def __init__(self, name):
        from skyfield.api import load_file

        if name not in KERNELS:
            raise ValueError("unknown kernel %r (known: %s)" % (name, ", ".join(KERNELS)))
        self.name = name
        self.paths = [os.path.join(DATA, f) for f in KERNELS[name]["files"]]
        for p in self.paths:
            if not os.path.exists(p):
                raise SystemExit("missing %s -- see tools/reference/README.md, 'Kernels'" % p)
        self.files = [load_file(p) for p in self.paths]
        self.filename = "+".join(KERNELS[name]["files"])
        self._bodies = {}

    def segment(self, jd_tdb):
        if len(self.files) == 1:
            return self.files[0]
        return self.files[0] if jd_tdb < DE441_SPLIT_JD else self.files[1]

    def __getitem__(self, key):
        if len(self.files) == 1:
            return self.files[0][key]
        if key not in self._bodies:
            self._bodies[key] = _split_body(self, [f[key] for f in self.files])
        return self._bodies[key]

    def __contains__(self, key):
        return key in self.files[0]

    def names(self):
        return self.files[0].names()

    def decode(self, name):
        return self.files[0].decode(name)

    def position_km(self, ts, target, jd_tdb, center="earth"):
        import numpy as np

        jd = np.atleast_1d(np.asarray(jd_tdb, dtype=float))
        out = np.zeros((3, jd.size))
        groups = [np.ones(jd.size, bool)] if len(self.files) == 1 else [
            jd < DE441_SPLIT_JD, jd >= DE441_SPLIT_JD]
        for eph, sel in zip(self.files if len(self.files) > 1 else self.files, groups):
            if sel.any():
                t = ts.tdb_jd(jd[sel])
                out[:, sel] = (eph[target] - eph[center]).at(t).position.km
        return out

    def facts(self):
        return {"kernel": self.name, "span": KERNELS[self.name]["span"],
                "files": [file_facts(p, KERNELS[self.name]["url"]) for p in self.paths]}


def _split_body(kernel, parts):
    """A Skyfield VectorFunction answering from DE441 part 1 before `DE441_SPLIT_JD`
    (TDB) and part 2 from it on."""
    import numpy as np
    from skyfield.vectorlib import VectorFunction

    class SplitBody(VectorFunction):
        def __init__(self):
            self.center = parts[0].center
            self.target = parts[0].target
            self.ephemeris = kernel

        @property
        def vector_name(self):
            return "DE441 " + parts[0].vector_name

        def _at(self, t):
            tdb = t.tdb
            if np.ndim(tdb) == 0:
                return (parts[0] if tdb < DE441_SPLIT_JD else parts[1])._at(t)
            early = tdb < DE441_SPLIT_JD
            if early.all() or not early.any():
                return (parts[0] if early.all() else parts[1])._at(t)
            p = np.zeros((3,) + tdb.shape)
            v = np.zeros((3,) + tdb.shape)
            message = None
            for part, sel in ((parts[0], early), (parts[1], ~early)):
                pp, vv, _, message = part._at(t[sel])
                p[:, sel], v[:, sel] = pp, vv
            return p, v, None, message

    return SplitBody()


_KERNEL_CACHE = {}


def load_kernel(name):
    """A `KernelSet` by `--kernel` name (cached: the files are large)."""
    if name not in _KERNEL_CACHE:
        _KERNEL_CACHE[name] = KernelSet(name)
    return _KERNEL_CACHE[name]


def add_window_kernel_args(parser, default_window, default_kernel="auto"):
    """The two arguments every generator takes (tools/reference/README.md)."""
    parser.add_argument("--window", default=default_window,
                        help="START..END, proleptic Gregorian or years (default %(default)s)")
    parser.add_argument("--kernel", default=default_kernel,
                        choices=["auto"] + sorted(KERNELS),
                        help="JPL kernel; auto picks by window (default %(default)s)")
    return parser


def resolve_window_kernel(args):
    """(jd_start, jd_end, kernel name) from parsed --window/--kernel."""
    j0, j1 = parse_window(args.window)
    k = kernel_for_window(j0, j1) if args.kernel == "auto" else args.kernel
    return j0, j1, k


class Run:
    """What one generator run was asked for: its `--window` (on the app's clock) and
    `--kernel`. `setup()` fills `RUN`; generators read it through `in_window()`,
    `window_years()` and `run_ephemeris()`."""

    def __init__(self):
        self.window_text = None
        self.window = None
        self.kernel = None
        self.default_window = None

    def facts(self):
        return {"window": self.window_text, "kernel": self.kernel,
                "window_is_default": self.window_text == self.default_window}


RUN = Run()


def setup(argv, description, default_window, default_kernel, parser=None):
    """Parse `--window` and `--kernel` (and whatever `parser` already defines) for one
    generator, record them in `RUN`, and put Skyfield on the app's frame of date
    (`use_app_frame`). The defaults are the generator's own: with no arguments it
    reproduces the fixture it has always written. `argv=None` reads `sys.argv[1:]`;
    `generate_all` passes its own list."""
    import argparse

    ap = parser or argparse.ArgumentParser(description=description)
    add_window_kernel_args(ap, default_window, default_kernel)
    args = ap.parse_args(argv)
    j0, j1, k = resolve_window_kernel(args)
    RUN.window_text, RUN.window, RUN.kernel = args.window, (j0, j1), k
    RUN.default_window = default_window
    use_app_frame()
    return args


def in_window(jd_clock):
    """Whether an instant on the app's clock is inside this run's `--window`."""
    if RUN.window is None:
        return True
    return RUN.window[0] <= jd_clock < RUN.window[1]


def require_in_window(jd_clock, what):
    """For a generator built around one fixed instant: refuse a `--window` that does not
    contain it, saying which instant (the file would otherwise be empty)."""
    if not in_window(jd_clock):
        raise SystemExit("%s is at %s, outside --window %s; this generator has nothing "
                         "else to write" % (what, iso_utc(jd_clock), RUN.window_text))


def window_years():
    """(first year, last year) of this run's window, whole years touched."""
    y0 = gregorian_from_jd(RUN.window[0])[0]
    y1 = gregorian_from_jd(RUN.window[1] - 1e-9)[0]
    return y0, y1


def run_ephemeris():
    """This run's `--kernel` as a Skyfield ephemeris: the SpiceKernel itself for a
    one-file kernel, the `KernelSet` for DE441's two files."""
    k = load_kernel(RUN.kernel)
    return k.files[0] if len(k.files) == 1 else k


def run_kernel_facts():
    return load_kernel(RUN.kernel).facts()


def kernel_label(name=None):
    """"DE440s" and the like, for prose."""
    name = name or RUN.kernel
    return "DE" + name[2:]


# ---------------------------------------------------------------------------
# The app's frame of date inside Skyfield (expansion programme)
# ---------------------------------------------------------------------------
#
# Inside the validated tier, 1550-01-01 .. 2650-01-22 (by TT, as the Rust side switches),
# SkyFix Lab's frame of date is Skyfield's own: IAU 2006 precession, IAU 2006 mean
# obliquity and GMST. Outside it the app uses the Vondrak-Capitaine-Wallace 2011
# long-term precession (ltp.py, pinned to ERFA's test values), its mean obliquity (the
# angle between its ecliptic and equator poles) and the GMST consistent with it (ERA plus
# the accumulated precession, ltp.gmst_minus_era_samples). `use_app_frame()` hands
# Skyfield those three outside the tier, so `radec(epoch='date')`, `gast`, `altaz()`
# and the ITRS rotation of every generator are the app's model at any date; inside the
# tier it changes nothing. Nutation stays Skyfield's IAU 2000A throughout.

#: The validated tier's bounds as Julian dates, crates/skyfix-ephemeris/src/tiers.rs, and
#: how far outside them (days of TT) the models switch (`MODEL_SWITCH_MARGIN_DAYS`), so
#: that no switch falls inside the tier on the app's clock.
JD_VALIDATED = (2_287_185.5, 2_688_973.5)
MODEL_SWITCH_MARGIN_DAYS = 1.0


def outside_validated(jd_tt):
    """Where the app uses its labelled-tier frame: TT more than a day outside the tier."""
    import numpy as np

    jd = np.asarray(jd_tt, dtype=float)
    return ((jd < JD_VALIDATED[0] - MODEL_SWITCH_MARGIN_DAYS)
            | (jd > JD_VALIDATED[1] + MODEL_SWITCH_MARGIN_DAYS))


def use_app_frame():
    """Patch Skyfield (idempotently) to the app's frame of date outside the validated
    tier. See the section comment above."""
    import numpy as np
    from skyfield import timelib
    from skyfield.framelib import ICRS_to_J2000

    if getattr(timelib, "_skyfix_app_frame", False):
        return
    from . import ltp as L

    base_precession = timelib.compute_precession
    base_obliquity = timelib.mean_obliquity
    base_sidereal = timelib.sidereal_time
    samples = []

    def epj(jd):
        return 2000.0 + (jd - 2451545.0) / 365.25

    def compute_precession(jd_tdb):
        out = base_precession(jd_tdb)
        far = outside_validated(jd_tdb)
        if not np.any(far):
            return out
        if np.ndim(jd_tdb) == 0:
            return L.ltpb(epj(float(jd_tdb))) @ ICRS_to_J2000.T
        out = np.array(out, dtype=float)
        for k in np.flatnonzero(far):
            out[:, :, k] = L.ltpb(epj(float(jd_tdb[k]))) @ ICRS_to_J2000.T
        return out

    def ltp_obliquity_arcsec(jd):
        pecl, peqr = L.ltpecl(epj(jd)), L.ltpequ(epj(jd))
        return math.atan2(np.linalg.norm(np.cross(pecl, peqr)), float(pecl @ peqr)) / L.DAS2R

    def mean_obliquity(jd_tdb):
        out = base_obliquity(jd_tdb)
        far = outside_validated(jd_tdb)
        if not np.any(far):
            return out
        if np.ndim(jd_tdb) == 0:
            return ltp_obliquity_arcsec(float(jd_tdb))
        out = np.array(out, dtype=float)
        for k in np.flatnonzero(far):
            out[k] = ltp_obliquity_arcsec(float(jd_tdb[k]))
        return out

    def sidereal_time(t):
        out = base_sidereal(t)
        tdb = t.tdb
        far = outside_validated(tdb)
        if not np.any(far):
            return out
        if not samples:
            samples.append(L.gmst_minus_era_samples())
        tc, g = samples[0]
        theta = timelib.earth_rotation_angle(t.whole, t.ut1_fraction)
        ltp = (np.interp((tdb - 2451545.0) / 36525.0, tc, g) / 54000.0 + theta * 24.0) % 24.0
        return np.where(far, ltp, out) if np.ndim(out) else float(ltp)

    timelib.compute_precession = compute_precession
    timelib.mean_obliquity = mean_obliquity
    timelib.sidereal_time = sidereal_time
    timelib._skyfix_app_frame = True


def app_frame_facts():
    return {
        "inside_validated_tier": ("Skyfield's own frame of date: IAU 2006 precession (P03), "
                                  "IAU 2006 mean obliquity and GMST, IAU 2000A nutation"),
        "outside_validated_tier": ("common.use_app_frame(): the Vondrak-Capitaine-Wallace "
                                   "2011 long-term precession with the IERS 2010 frame bias "
                                   "(ltp.ltpb, ERFA eraLtpb), its mean obliquity, and GMST = "
                                   "ERA + the long-term accumulated precession "
                                   "(ltp.gmst_minus_era_samples); IAU 2000A nutation"),
        "switch": ("by TT one day outside 1550-01-01 and 2650-01-22 (JD 2287184.5 and "
                   "2688974.5), as the Rust side (tiers::MODEL_SWITCH_MARGIN_DAYS)"),
    }


def load_hipparcos_frame():
    from skyfield.data import hipparcos

    with open(HIPPARCOS_FILE, "rb") as f:
        return hipparcos.load_dataframe(f)


def timescale_facts():
    """The timescale block of a fixture generated with `load_timescale()`."""
    return project_timescale_facts()


def builtin_timescale_facts():
    """What `load.timescale(builtin=True)` implies, measured, not asserted."""
    import numpy as np
    from skyfield.iokit import load_bundled_npy

    ts = load_builtin_timescale()
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
    timescale=None,
):
    block = {
        "tool": tool,
        "description": description,
        "generated_utc": generated_utc(),
        "versions": versions(),
        "timescale": timescale if timescale is not None else timescale_facts(),
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
        "HIP 71683 is alpha Centauri A, the body the Nautical Almanac and USNO's celnav "
        "tabulate (checked against USNO at 15 dates 1800-2050: USNO is this entry with "
        "linear space motion and a radial velocity, to 0.2 arcsec). A orbits B every "
        "80 years, so its Hipparcos proper motion is the tangent to a curve: `orbit` "
        "gives the ORB6 elements to follow the curve (5.8 arcsec from the tangent in 2026, "
        "17 in 2060). A sextant sees the A+B light centre, 0.23 of the separation from A "
        "toward B (about 2 arcsec in 2026)."
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


def build_stars(df, space_motion=True):
    """Return {name: skyfield Star} and the verification report.

    With `space_motion` (the default since the expansion programme) every star carries
    its SIMBAD radial velocity (gen_stars.RADIAL_VELOCITIES), so Skyfield applies the
    perspective acceleration, and Rigil Kentaurus (alpha Cen A) follows its orbit about
    the A-B barycentre (acen_orbit.py). `space_motion=False` gives the plain Hipparcos
    stars of the fixtures generated before it."""
    from skyfield.api import Star

    from . import acen_orbit
    from .gen_stars import RADIAL_VELOCITIES

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
        if not space_motion:
            stars[name] = Star.from_dataframe(row)
        elif hip == acen_orbit.HIP:
            stars[name] = acen_orbit.orbiting_star(row, RADIAL_VELOCITIES[hip][0])
        else:
            base = Star.from_dataframe(row)
            stars[name] = Star(
                ra_hours=base.ra.hours,
                dec_degrees=base.dec.degrees,
                ra_mas_per_year=base.ra_mas_per_year,
                dec_mas_per_year=base.dec_mas_per_year,
                parallax_mas=base.parallax_mas,
                radial_km_per_s=RADIAL_VELOCITIES[hip][0],
                epoch=base.epoch,
            )
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
    """Julian date of a Time's reading on the app's clock (`t.utc`: UTC 1972-2035 and UT
    outside for a `ClockTimescale` Time), proleptic Gregorian."""
    y, m, d, hh, mm, ss = t.utc
    if not 1583 <= y <= 9999:
        return jd_from_gregorian(y, m, d, hh + mm / 60.0 + ss / 3600.0)
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
    """The instant: its clock label and Julian date, its TT and UT1 (so a test can put a
    provider at exactly the fixture's instants), Delta T, DUT1 and the sidereal time."""
    return {
        "utc": iso_utc(jd_utc_of(t)),
        "jd_utc": jd(jd_utc_of(t)),
        "jd_tt": jd(float(t.tt)),
        "jd_ut1": jd(float(t.ut1)),
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
