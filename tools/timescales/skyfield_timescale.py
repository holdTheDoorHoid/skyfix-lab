#!/usr/bin/env python3
"""A Skyfield timescale whose Delta-T is SkyFix Lab's, for fixture generators.

CONVENTIONS 15.2 makes the app's clock UTC from 1972-01-01 to 2035-12-31 and UT (UT1)
outside, with TT = UT + Delta-T there. A reference fixture must build its geometry from
the same TT and UT1 as the Rust side, or Delta-T counts as ephemeris error (5 s of
Delta-T is 2.7" of the Moon). ``skyfix_core::deltat`` is Skyfield 1.55's own
``build_delta_t`` run on the project's weekly IERS table, so handing Skyfield that
table reproduces the Rust model to a microsecond (``tests/timescales_reference.rs``).

    import sys; sys.path.insert(0, "tools/timescales")
    from skyfield_timescale import timescale, clock_time, dut1_zero_timescale
    ts = timescale()
    t = clock_time(ts, jd_clock)       # the app's clock instant as a Skyfield Time
    ts0 = dut1_zero_timescale()        # the old "DUT1 = 0" columns: UT1 = UTC, 1972-2035
    t0 = clock_time(ts0, jd_clock)

The table is read from ``crates/skyfix-core/src/deltat/data.rs`` (what is compiled),
not rebuilt, so a fixture always matches the module it tests.

``python3 tools/timescales/skyfield_timescale.py`` checks itself against
``fixtures/reference/timescales.json``.
"""

from __future__ import annotations

import json
import os
import re

import numpy as np
from skyfield.api import load
from skyfield.timelib import Timescale

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA_RS = os.path.join(REPO, "crates", "skyfix-core", "src", "deltat", "data.rs")
MJD0 = 2_400_000.5
#: First instant of the UTC scale (1972-01-01) and the first after it (2036-01-01).
UTC_SCALE = (2_441_317.5, 2_464_693.5)


def _table():
    text = open(DATA_RS, encoding="ascii").read()
    first = int(re.search(r"EOP_FIRST_MJD: i32 = (\d+);", text).group(1))
    step = int(re.search(r"EOP_STEP_DAYS: i32 = (\d+);", text).group(1))
    body = re.search(r"DUT1_E4: \[i16; (\d+)\] = \[(.*?)\];", text, re.S)
    values = [int(v) for v in re.findall(r"-?\d+", body.group(2))]
    assert len(values) == int(body.group(1))
    mjd = first + step * np.arange(len(values))
    return mjd, np.array(values) * 1e-4


def _tai_minus_utc(mjd, leap_dates, leap_offsets):
    i = np.searchsorted(leap_dates, mjd + MJD0, side="right") - 1
    return np.where(i >= 0, leap_offsets[np.maximum(i, 0)], 10.0)


def timescale() -> Timescale:
    """Skyfield 1.55's timescale with SkyFix's IERS table in place of its bundled one."""
    builtin = load.timescale(builtin=True)
    leap_dates, leap_offsets = builtin.leap_dates, builtin.leap_offsets
    mjd_w, dut1_w = _table()
    u_w = dut1_w - _tai_minus_utc(mjd_w, leap_dates, leap_offsets)  # UT1 - TAI
    days = np.arange(mjd_w[0], mjd_w[-1] + 1)
    u = np.interp(days, mjd_w, u_w)
    tt = days + MJD0 + (32.184 + _tai_minus_utc(days, leap_dates, leap_offsets)) / 86400
    return Timescale((tt, 32.184 - u), leap_dates, leap_offsets)


def dut1_zero_timescale() -> Timescale:
    """SkyFix's timescale with UT1 = UTC on the UTC scale (1972-2035): the "DUT1 = 0"
    convention of the older fixtures and of a navigator without a time signal. Outside
    the UTC scale it is :func:`timescale`'s Delta-T (the clock is UT1 there)."""
    base = timescale()
    leap_dates, leap_offsets = base.leap_dates, base.leap_offsets
    model = base.delta_t_function

    def delta_t(tt):
        tt = np.asarray(tt, dtype=float)
        utc = tt - 69.184 / 86400
        leap = _tai_minus_utc(utc - MJD0, leap_dates, leap_offsets)
        utc = tt - (32.184 + leap) / 86400
        inside = (utc >= UTC_SCALE[0]) & (utc < UTC_SCALE[1])
        return np.where(inside, 32.184 + leap, model(tt))

    return Timescale(delta_t, leap_dates, leap_offsets)


def clock_time(ts: Timescale, jd_clock):
    """The Skyfield ``Time`` of an instant on the app's clock (``jd_utc`` on the wire).

    On the UTC scale TT = clock + 32.184 s + (TAI - UTC), and UT1 follows from the
    timescale's Delta-T (IERS UT1 - UTC with :func:`timescale`, none with
    :func:`dut1_zero_timescale`); on the UT scale the clock is UT1 and TT = UT1 + Delta-T.
    """
    jd = float(jd_clock)
    if UTC_SCALE[0] <= jd < UTC_SCALE[1]:
        leap = float(_tai_minus_utc(np.array([jd - MJD0]), ts.leap_dates, ts.leap_offsets)[0])
        return ts.tt_jd(jd + (32.184 + leap) / 86400)
    return ts.ut1_jd(jd)


def _self_check() -> None:
    ts = timescale()
    fx = json.load(open(os.path.join(REPO, "fixtures", "reference", "timescales.json")))
    worst = 0.0
    for c in fx["delta_t"]:
        worst = max(worst, abs(float(ts.delta_t_function(c["jd_tt"])) - c["delta_t_s"]))
    assert worst < 1e-6, worst
    for c in fx["ut1_to_tt"]:
        assert abs((ts.ut1_jd(c["jd_ut1"]).tt - c["jd_tt"]) * 86400) < 1e-6
    t = clock_time(ts, 2_461_308.0)  # 2026-09-24T12:00Z: UTC scale
    # A single-float JD resolves about 40 microseconds here.
    assert abs((t.tt - 2_461_308.0) * 86400 - 69.184) < 1e-4
    t = clock_time(ts, 1_507_900.0)  # 585 BC: UT scale
    assert abs(t.ut1 - 1_507_900.0) < 1e-9
    # 2026-09-24 12h: UT1 - UTC = -0.0135 s from the table, 0 with the DUT1 = 0 scale.
    dut1 = (clock_time(ts, 2_461_308.0).ut1 - 2_461_308.0) * 86400
    assert abs(dut1 + 0.0135) < 0.002, dut1
    ts0 = dut1_zero_timescale()
    assert abs((clock_time(ts0, 2_461_308.0).ut1 - 2_461_308.0) * 86400) < 1e-4
    assert abs(clock_time(ts0, 1_507_900.0).tt - clock_time(ts, 1_507_900.0).tt) < 1e-12
    print("skyfield_timescale: matches fixtures/reference/timescales.json (worst %.1e s)" % worst)


if __name__ == "__main__":
    _self_check()
