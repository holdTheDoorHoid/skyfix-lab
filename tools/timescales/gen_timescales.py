#!/usr/bin/env python3
"""Generate SkyFix Lab's time-scale tables and their reference fixture.

Development-time only (CONVENTIONS section 11): nothing here runs in the app, and the
Rust side never reads these sources. Run from the repository root with the reference
virtualenv (Skyfield 1.55, numpy):

    tools/reference/.venv/bin/python tools/timescales/gen_timescales.py

Outputs
-------
``crates/skyfix-core/src/deltat/data.rs``
    Rust constants compiled into the core: the Stephenson-Morrison-Hohenkerk spline
    coefficients, their published standard errors, and the weekly UT1 - UTC table.
``fixtures/reference/timescales.json``
    ``skyfix.reference/1`` fixture for ``crates/skyfix-core/tests/timescales_reference.rs``.

Inputs (all on disk; nothing is downloaded)
-------------------------------------------
``sources/Table-S15.2020.txt``
    Morrison, Stephenson, Hohenkerk & Zawilski 2021 (Addendum 2020 to Stephenson,
    Morrison & Hohenkerk 2016): 58 cubic segments giving Delta-T for -720.0..2019.0.
    figshare doi:10.6084/m9.figshare.29920388, CC BY 4.0. Identical to the copy Skyfield
    1.55 bundles (checked below).
``sources/Table-DT-lod4500yrs.2020.txt``
    The same authors' Delta-T with error estimates, -2000..+2500.
    figshare doi:10.6084/m9.figshare.30111661, CC BY 4.0.
``sources/iers-bulletin-a-2026-09-24.txt``
    IERS Bulletin A Vol. XXXIX No. 039 (IERS Rapid Service/Prediction Center, USNO):
    observed UT1 - UTC for 2026-09-18..24 and daily predictions to 2027-09-24.
    U.S. Government work, "approved for public release: distribution unlimited".
Skyfield 1.55 ``skyfield/data/iers.npz``
    Daily Delta-T 1973-01-02..2027-01-23 built by Skyfield from IERS ``finals2000A.all``
    (Bulletin A rapid values, then a year of predictions). The file carries no
    observed/predicted flag; its last date minus Bulletin A's one-year prediction span
    puts the last observed value at about 2026-01-23 (``BUNDLE_LAST_OBSERVED_MJD``).

The merged UT1 - UTC series
---------------------------
1. 1973-01-02 .. 2026-01-23: Skyfield's bundle (observed).
2. 2026-01-24 .. 2026-09-17: the bundle's January-2026 predictions, which by 2026-09-18
   had drifted 0.105 s from the observed value, corrected by a cubic Hermite term that is
   zero (value and slope) on 2026-01-23 and meets the observed value and slope of
   Bulletin A on 2026-09-18. Standard uncertainty: a Brownian bridge pinned at both ends,
   ``sqrt(0.001^2 + M^2 s (1 - s))`` with ``M`` the 0.105 s miss.
3. 2026-09-18 .. 2026-09-24: Bulletin A observed.
4. 2026-09-25 .. 2027-09-24: Bulletin A predictions (sigma: the bulletin's own
   ``0.00025 (MJD - 61307)^0.75`` s, or Huber's random walk when larger).

Sampled every 7 days from MJD 41684 (1973-01-02) and stored as i16 in units of 0.1 ms.
Interpolation is linear in UT1 - TAI, which has no leap-second steps. Weekly sampling
costs at most 1.9 ms (0.5 ms rms) against the daily values; the 0.1 ms unit adds at most
0.05 ms. (Hundredths of a second, as first planned, would add up to 5 ms for the same
6 KB.)

Refreshing: a current ``finals2000A.all`` (maia.usno.navy.mil/ser7, parsed with
``skyfield.data.iers.parse_x_y_dut1_from_finals_all``) or EOP 20 C04 would replace
sources 1-3 with observed values to the build date and remove the corrected span.
Fetching them needs the owner's approval, so this generator uses what is on disk.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys

import numpy as np
import skyfield
from skyfield.api import load
from skyfield.timelib import Timescale, julian_day, compute_calendar_date

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SOURCES = os.path.join(HERE, "sources")
S15_PATH = os.path.join(SOURCES, "Table-S15.2020.txt")
DT4500_PATH = os.path.join(SOURCES, "Table-DT-lod4500yrs.2020.txt")
BULA_PATH = os.path.join(SOURCES, "iers-bulletin-a-2026-09-24.txt")
OUT_RUST = os.path.join(REPO, "crates", "skyfix-core", "src", "deltat", "data.rs")
OUT_FIXTURE = os.path.join(REPO, "fixtures", "reference", "timescales.json")

RETRIEVED = "2026-09-24"
MJD0 = 2_400_000.5
FIRST_MJD = 41_684  # 1973-01-02, the first day of Skyfield's IERS table
STEP_DAYS = 7
BUNDLE_LAST_OBSERVED_MJD = 61_063  # 2026-01-23 (see the module docstring)
UNIT_S = 1e-4  # the i16 table is in units of 0.1 ms
SIGMA_OBSERVED_S = 0.001  # weekly sampling: max 1.9 ms, rms 0.5 ms
SPLINE_SIGMA_FLOOR_S = 0.11  # measured rms of the S15 spline against IERS, 1973-2019
HUBER_Q = 0.058  # ms^2/yr
HUBER_M = 2500.0  # yr


def sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


def parse_s15(path: str) -> list[tuple[float, float, float, float, float, float]]:
    """Rows ``(K_i, K_{i+1}, a0, a1, a2, a3)`` of Table S15.2020."""
    row = re.compile(r"^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)" + r"\s+(-?\d+\.\d+)" * 4 + r"\s*$")
    rows = []
    for line in open(path, encoding="ascii"):
        m = row.match(line)
        if m:
            n = int(m.group(1))
            assert n == len(rows) + 1, f"S15 row {n} out of order"
            rows.append(tuple(float(x) for x in m.groups()[1:]))
    assert len(rows) == 58, len(rows)
    for a, b in zip(rows, rows[1:]):
        assert a[1] == b[0], "S15 segments must be contiguous"
    return rows


def parse_dt4500(path: str) -> list[tuple[float, float, float]]:
    """Rows ``(year, delta_t_s, error_s)`` of Table DT-lod4500yrs.2020."""
    row = re.compile(r"^\s*(-?\d+\.\d)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$")
    out = []
    for line in open(path, encoding="ascii"):
        m = row.match(line)
        if m:
            out.append((float(m.group(1)), float(m.group(2)), float(m.group(3))))
    assert out[0][0] == -2000.0 and out[-1][0] == 2500.0, (out[0], out[-1])
    return out


def parse_bulletin_a(path: str):
    """Observed and predicted UT1 - UTC (seconds) by MJD, and the bulletin's metadata."""
    text = open(path, encoding="latin-1").read()
    issue = re.search(r"(\d{1,2}) (\w+) (\d{4})\s+Vol\. (\w+) No\. (\d+)", text)
    assert issue, "no issue line"
    # "TAI-UTC = 37.000 000 seconds": the digits are grouped in threes.
    tai_utc = float(re.search(r"TAI-UTC = (\d+\.\d+)(?: \d+)? seconds", text).group(1))
    assert "There will NOT be a leap second" in text
    observed, predicted = {}, {}
    obs_block = text.split("COMBINED EARTH ORIENTATION PARAMETERS:")[1].split("PREDICTIONS:")[0]
    for m in re.finditer(r"^\s+\d\d\s+\d+\s+\d+\s+(\d{5})\s+\S+\s+\S+\s+\S+\s+\S+\s+(-?\d+\.\d+)\s+(\d?\.\d+)\s*$", obs_block, re.M):
        observed[int(m.group(1))] = (float(m.group(2)), float(m.group(3)))
    pred_block = text.split("PREDICTIONS:")[1].split("These predictions are based")[0]
    for m in re.finditer(r"^\s+(\d{4})\s+(\d+)\s+(\d+)\s+(\d{5})\s+(-?\d\.\d+)\s+(-?\d\.\d+)\s+(-?\d\.\d+)\s*$", pred_block, re.M):
        predicted[int(m.group(4))] = float(m.group(7))
    err = re.search(r"S t = ([\d.]+) \(MJD-(\d+)\)\*\*([\d.]+)", text)
    assert err and float(err.group(1)) == 0.00025 and float(err.group(3)) == 0.75
    last_obs = max(observed)
    assert int(err.group(2)) == last_obs
    assert min(predicted) == last_obs + 1 and len(predicted) == max(predicted) - min(predicted) + 1
    return {
        "issue": f"{issue.group(1)} {issue.group(2)} {issue.group(3)}, Vol. {issue.group(4)} No. {issue.group(5)}",
        "tai_utc": tai_utc,
        "observed": observed,
        "predicted": predicted,
        "last_observed_mjd": last_obs,
    }


def skyfield_bundle():
    """Skyfield's builtin daily table as ``(mjd_utc, dut1_s)`` and its leap-second table."""
    d = np.load(os.path.join(os.path.dirname(skyfield.__file__), "data", "iers.npz"))
    tt = d["tt_jd_minus_arange"] + np.arange(len(d["tt_jd_minus_arange"]))
    dt = d["delta_t_1e7"] * 1e-7
    leap_dates, leap_offsets = d["leap_dates"], d["leap_offsets"]
    # Each sample is 0h UTC of a day: TT - UTC is under 70 s, so the nearest whole MJD
    # to TT - 69.184 s is that day, and TAI - UTC follows from the day (a leap second
    # applies from 0h of its date, as in skyfix_core::time::delta_at).
    mjd = np.round(tt - MJD0 - 69.184 / 86400).astype(int)
    tai_utc = np.array([tai_minus_utc(m, leap_dates, leap_offsets) for m in mjd])
    utc = tt - (32.184 + tai_utc) / 86400
    assert np.allclose(utc - MJD0, mjd, atol=1e-9), "bundle samples are not at 0h UTC"
    assert (np.diff(mjd) == 1).all() and mjd[0] == FIRST_MJD
    dut1 = 32.184 + tai_utc - dt
    assert np.abs(dut1).max() < 0.95, np.abs(dut1).max()
    return mjd, dut1, leap_dates, leap_offsets


# ---------------------------------------------------------------------------
# Leap seconds (must equal skyfix_core::time::LEAP_SECONDS)
# ---------------------------------------------------------------------------


def tai_minus_utc(mjd: float, leap_dates, leap_offsets) -> float:
    jd = mjd + MJD0
    i = np.searchsorted(leap_dates, jd, side="right") - 1
    return float(leap_offsets[i]) if i >= 0 else 10.0


# ---------------------------------------------------------------------------
# The merged daily UT1 - UTC series and the weekly table
# ---------------------------------------------------------------------------


def hermite(t, y0, d0, y1, d1, width):
    """Cubic with value/slope (per unit x) ``y0, d0`` at t=0 and ``y1, d1`` at t=1."""
    h00 = 2 * t**3 - 3 * t**2 + 1
    h10 = t**3 - 2 * t**2 + t
    h01 = -2 * t**3 + 3 * t**2
    h11 = t**3 - t**2
    return h00 * y0 + h10 * width * d0 + h01 * y1 + h11 * width * d1


def merged_series(bundle, bula):
    mjd_b, dut1_b, leap_dates, leap_offsets = bundle
    by_mjd = dict(zip(mjd_b.tolist(), dut1_b.tolist()))
    t0 = BUNDLE_LAST_OBSERVED_MJD
    t1 = min(bula["observed"])
    last_obs = bula["last_observed_mjd"]
    obs = {m: v for m, (v, _e) in bula["observed"].items()}
    # UT1 - TAI of both sources (no leap second between 2026-01 and 2027-09).
    for m in range(t0, max(bula["predicted"]) + 1):
        assert tai_minus_utc(m, leap_dates, leap_offsets) == 37.0
    pred_t1 = by_mjd[t1]
    miss = obs[t1] - pred_t1
    slope_obs = (obs[last_obs] - obs[t1]) / (last_obs - t1)
    slope_pred = (by_mjd[last_obs] - by_mjd[t1]) / (last_obs - t1)
    series = {}
    for m in range(FIRST_MJD, t0 + 1):
        series[m] = by_mjd[m]
    width = t1 - t0
    for m in range(t0 + 1, t1):
        s = (m - t0) / width
        series[m] = by_mjd[m] + hermite(s, 0.0, 0.0, miss, slope_obs - slope_pred, width)
    for m, v in obs.items():
        series[m] = v
    for m, v in bula["predicted"].items():
        series[m] = v
    days = np.array(sorted(series))
    assert (np.diff(days) == 1).all()
    values = np.array([series[m] for m in days])
    info = {
        "gap_first_mjd": t0 + 1,
        "gap_last_mjd": t1 - 1,
        "gap_miss_s": miss,
        "bundle_pred_minus_obs_at_t1_s": -miss,
        "slope_obs_s_per_day": slope_obs,
        "slope_pred_s_per_day": slope_pred,
    }
    return days, values, info


def weekly_table(days, dut1, leap_dates, leap_offsets):
    """Samples every STEP_DAYS from FIRST_MJD, quantized to UNIT_S, and the error check."""
    idx = np.arange(0, len(days), STEP_DAYS)
    mjd_w = days[idx]
    q = np.round(dut1[idx] / UNIT_S).astype(int)
    assert np.abs(q).max() < 32767
    dut1_q = q * UNIT_S
    # Interpolation error against the daily series, in UT1 - TAI.
    tai = np.array([tai_minus_utc(m, leap_dates, leap_offsets) for m in days])
    u_daily = dut1 - tai
    u_week = dut1_q - np.array([tai_minus_utc(m, leap_dates, leap_offsets) for m in mjd_w])
    covered = days <= mjd_w[-1]
    err = np.interp(days[covered], mjd_w, u_week) - u_daily[covered]
    return mjd_w, q, float(np.abs(err).max()), float(np.sqrt((err**2).mean()))


# ---------------------------------------------------------------------------
# The Delta-T model in Python: Skyfield's own construction on our table
# ---------------------------------------------------------------------------


def our_timescale(mjd_w, q, leap_dates, leap_offsets) -> Timescale:
    """A Skyfield Timescale whose Delta-T is SkyFix's: our weekly table, interpolated to
    whole days, handed to Skyfield's ``build_delta_t`` (the S15.2020 splines, the
    long-term parabola and the 800-year joins are Skyfield's code)."""
    days = np.arange(mjd_w[0], mjd_w[-1] + 1)
    u_w = q * UNIT_S - np.array([tai_minus_utc(m, leap_dates, leap_offsets) for m in mjd_w])
    u = np.interp(days, mjd_w, u_w)
    tai = np.array([tai_minus_utc(m, leap_dates, leap_offsets) for m in days])
    tt = days + MJD0 + (32.184 + tai) / 86400
    return Timescale((tt, 32.184 - u), leap_dates, leap_offsets)


def huber_sigma_s(n_years: float) -> float:
    n = abs(n_years)
    return 365.25 * n * math.sqrt((n * HUBER_Q / 3.0) * (1.0 + n / HUBER_M)) / 1000.0


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def rust_float(x: float) -> str:
    s = repr(float(x))
    return s if ("." in s or "e" in s) else s + ".0"


def sigma_knots(dt4500):
    """(year, sigma) change points of SMH's error column over the spline span -720..2019."""
    rows = [(y, e) for (y, _d, e) in dt4500 if -720.0 <= y <= 2019.0]
    keep = []
    for i, (y, e) in enumerate(rows):
        prev_e = rows[i - 1][1] if i > 0 else None
        next_e = rows[i + 1][1] if i + 1 < len(rows) else None
        if i == 0 or i == len(rows) - 1 or e != prev_e or e != next_e:
            keep.append((y, e))
    return keep


def write_rust(s15, knots, mjd_w, q, meta):
    lines = []
    w = lines.append
    w("//! GENERATED by `tools/timescales/gen_timescales.py` on %s. Do not edit by hand." % meta["generated"])
    w("//!")
    w("//! Sources (docs/THIRD_PARTY.md, \"Time scales\"):")
    w("//! - `S15`: Morrison, Stephenson, Hohenkerk & Zawilski 2021, Table S15.2020")
    w("//!   (figshare doi:10.6084/m9.figshare.29920388, CC BY 4.0), sha256 %s." % meta["sha_s15"][:16])
    w("//! - `SMH_SIGMA`: the error column of the same authors' Table DT-lod4500yrs.2020")
    w("//!   (doi:10.6084/m9.figshare.30111661, CC BY 4.0), sha256 %s: the change points" % meta["sha_dt4500"][:16])
    w("//!   over -720..2019, linearly interpolated between them.")
    w("//! - `DUT1_E4`: UT1 - UTC at 0h UTC every %d days from MJD %d, in units of 0.1 ms, from" % (STEP_DAYS, FIRST_MJD))
    w("//!   IERS Bulletin A data: finals2000A as bundled by Skyfield 1.55 (observed to MJD %d)," % BUNDLE_LAST_OBSERVED_MJD)
    w("//!   a corrected prediction over MJD %d..%d, and %s" % (meta["gap_first_mjd"], meta["gap_last_mjd"], meta["bula_issue"]))
    w("//!   (observed to MJD %d, predicted to MJD %d). Weekly sampling: max %.2f ms, rms %.2f ms." % (meta["last_observed_mjd"], meta["last_predicted_mjd"], meta["interp_max_ms"], meta["interp_rms_ms"]))
    w("")
    w("/// Rows `[K_i, K_{i+1}, a0, a1, a2, a3]`: Delta-T = a0 + a1 t + a2 t^2 + a3 t^3 seconds,")
    w("/// t = (Y - K_i) / (K_{i+1} - K_i), for Y (Julian epoch, TT) in `[K_i, K_{i+1})`.")
    w("#[rustfmt::skip]")
    w("pub(super) const S15: [[f64; 6]; %d] = [" % len(s15))
    for r in s15:
        w("    [%s]," % ", ".join(rust_float(x) for x in r))
    w("];")
    w("")
    w("/// `(year, standard error in seconds)` published with the splines, -720..2019.")
    w("#[rustfmt::skip]")
    w("pub(super) const SMH_SIGMA: [(f64, f64); %d] = [" % len(knots))
    for y, e in knots:
        w("    (%s, %s)," % (rust_float(y), rust_float(e)))
    w("];")
    w("")
    w("/// MJD (UTC) of `DUT1_E4[0]`.")
    w("pub(super) const EOP_FIRST_MJD: i32 = %d;" % FIRST_MJD)
    w("/// Days between samples.")
    w("pub(super) const EOP_STEP_DAYS: i32 = %d;" % STEP_DAYS)
    w("/// Last day of the observed values in Skyfield 1.55's bundle (2026-01-23, inferred).")
    w("pub(super) const EOP_BUNDLE_LAST_OBSERVED_MJD: i32 = %d;" % BUNDLE_LAST_OBSERVED_MJD)
    w("/// First day of IERS Bulletin A's observed week (2026-09-18).")
    w("pub(super) const EOP_BULLETIN_FIRST_OBSERVED_MJD: i32 = %d;" % meta["first_bula_observed_mjd"])
    w("/// Last observed day of the table: the build date's Bulletin A (2026-09-24). Later")
    w("/// samples are the bulletin's predictions.")
    w("pub(super) const EOP_LAST_OBSERVED_MJD: i32 = %d;" % meta["last_observed_mjd"])
    w("/// How far the bundle's January-2026 prediction had drifted by 2026-09-18, seconds:")
    w("/// the scale of the corrected span's uncertainty.")
    w("pub(super) const EOP_GAP_MISS_S: f64 = %s;" % rust_float(round(abs(meta["gap_miss_s"]), 6)))
    w("/// Date of the sources (the build date).")
    w("pub const EOP_RETRIEVED: &str = \"%s\";" % RETRIEVED)
    w("")
    w("/// UT1 - UTC at 0h UTC on MJD `EOP_FIRST_MJD + EOP_STEP_DAYS * i`, units of 0.1 ms.")
    w("#[rustfmt::skip]")
    w("pub(super) const DUT1_E4: [i16; %d] = [" % len(q))
    per = 12
    for i in range(0, len(q), per):
        w("    " + ", ".join("%d" % v for v in q[i:i + per]) + ",")
    w("];")
    w("")
    os.makedirs(os.path.dirname(OUT_RUST), exist_ok=True)
    with open(OUT_RUST, "w", encoding="ascii") as f:
        f.write("\n".join(lines))


def dump_compact(doc: dict) -> str:
    """The generator block indented; every case on one line (keeps the file small)."""
    out = ["{"]
    keys = list(doc)
    for n, k in enumerate(keys):
        v = doc[k]
        comma = "," if n + 1 < len(keys) else ""
        if isinstance(v, list):
            out.append("  %s: [" % json.dumps(k))
            for i, item in enumerate(v):
                out.append("    " + json.dumps(item, separators=(", ", ": ")) + ("," if i + 1 < len(v) else ""))
            out.append("  ]" + comma)
        else:
            body = json.dumps(v, indent=2).replace("\n", "\n  ")
            out.append("  %s: %s%s" % (json.dumps(k), body, comma))
    out.append("}")
    return "\n".join(out) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.parse_args(argv)

    s15 = parse_s15(S15_PATH)
    sk15 = np.load(os.path.join(os.path.dirname(skyfield.__file__), "data", "delta_t.npz"))["Table-S15.2020.txt"]
    mine = np.array([[r[0] for r in s15], [r[1] for r in s15], [r[5] for r in s15], [r[4] for r in s15], [r[3] for r in s15], [r[2] for r in s15]])
    assert np.array_equal(mine, sk15), "Table-S15.2020.txt differs from Skyfield's bundled copy"
    dt4500 = parse_dt4500(DT4500_PATH)
    bula = parse_bulletin_a(BULA_PATH)
    assert bula["tai_utc"] == 37.0
    bundle = skyfield_bundle()
    mjd_b, dut1_b, leap_dates, leap_offsets = bundle
    days, dut1, gap = merged_series(bundle, bula)
    mjd_w, q, err_max, err_rms = weekly_table(days, dut1, leap_dates, leap_offsets)
    assert err_max < 0.0025, err_max
    knots = sigma_knots(dt4500)

    ts_ours = our_timescale(mjd_w, q, leap_dates, leap_offsets)
    ts_sky = load.timescale(builtin=True)

    meta = {
        "generated": RETRIEVED,
        "sha_s15": sha256(S15_PATH),
        "sha_dt4500": sha256(DT4500_PATH),
        "bula_issue": "IERS Bulletin A of " + bula["issue"],
        "gap_first_mjd": gap["gap_first_mjd"],
        "gap_last_mjd": gap["gap_last_mjd"],
        "gap_miss_s": gap["gap_miss_s"],
        "first_bula_observed_mjd": min(bula["observed"]),
        "last_observed_mjd": bula["last_observed_mjd"],
        "last_predicted_mjd": max(bula["predicted"]),
        "interp_max_ms": err_max * 1e3,
        "interp_rms_ms": err_rms * 1e3,
    }
    table_last_mjd = int(mjd_w[-1])

    # ---- fixture cases -------------------------------------------------------------
    def tt_of_mjd_utc(m):
        return m + MJD0 + (32.184 + tai_minus_utc(m, leap_dates, leap_offsets)) / 86400

    def jd_tt_of_year(y):
        return 2451545.0 + (y - 2000.0) * 365.25

    delta_t_cases = []

    def add_dt(jd_tt, band):
        ours = float(ts_ours.delta_t_function(jd_tt))
        sky = float(ts_sky.delta_t_function(jd_tt))
        delta_t_cases.append({"jd_tt": jd_tt, "band": band, "delta_t_s": round(ours, 9), "skyfield_builtin_s": round(sky, 9)})

    for m in range(FIRST_MJD + 3, BUNDLE_LAST_OBSERVED_MJD + 1, 43):
        add_dt(tt_of_mjd_utc(m) + 0.37, "iers_observed")
    for m in range(BUNDLE_LAST_OBSERVED_MJD + 1, table_last_mjd, 11):
        add_dt(tt_of_mjd_utc(m) + 0.61, "iers_2026_on")
    for y in np.arange(-2000.0, -720.0, 13.1):
        add_dt(jd_tt_of_year(float(y)), "parabola_and_join")
    for y in np.arange(-720.0, 1973.0, 7.3):
        add_dt(jd_tt_of_year(float(y)), "smh2016")
    for y in np.arange(2028.0, 3000.5, 9.7):
        add_dt(jd_tt_of_year(float(y)), "future")
    for y in (-2000.0, -1620.0, -1520.0, -1519.99, -720.01, -720.0, -719.99, 1970.99, 1971.0, 1972.0, 1972.99, 2799.99, 2800.0, 2800.01, 3000.0, 3000.99):
        add_dt(jd_tt_of_year(y), "edges")

    ut1_cases = []
    for y in (-2000.0, -1000.5, -584.4, 0.0, 1000.0, 1550.0, 1900.0, 1971.9, 2036.1, 2100.0, 2650.0, 3000.9):
        jd_ut1 = jd_tt_of_year(y) - 0.3
        t = ts_ours.ut1_jd(jd_ut1)
        ut1_cases.append({"jd_ut1": jd_ut1, "jd_tt": float(t.tt), "delta_t_s": float(t.delta_t)})

    dut1_cases = []
    for m in list(range(FIRST_MJD, table_last_mjd + 1, 61)) + [41684, 42048, 42049, 57753, 57754, 57755, 61300, 61301, 61304, 61307, 61400, 61669]:
        dut1_cases.append({"mjd_utc": m, "dut1_s": round(float(dut1[m - FIRST_MJD]), 7)})
    bula_observed = [{"mjd_utc": m, "dut1_s": v, "sigma_s": e} for m, (v, e) in sorted(bula["observed"].items())]

    sigma_cases = []
    t0, t1 = BUNDLE_LAST_OBSERVED_MJD, min(bula["observed"])
    last_obs = bula["last_observed_mjd"]
    sigma_knot_years = np.array([k[0] for k in knots])
    sigma_knot_values = np.array([k[1] for k in knots])
    table_start_year = (tt_of_mjd_utc(FIRST_MJD) - 1721045.0) / 365.25

    def sigma_expected(jd_tt):
        y = (jd_tt - 1721045.0) / 365.25
        mjd = jd_tt - MJD0 - 69.184 / 86400  # UTC to well within a minute
        if y < table_start_year:
            if y >= -720.0:
                return max(float(np.interp(y, sigma_knot_years, sigma_knot_values)), SPLINE_SIGMA_FLOOR_S)
            return max(sigma_knot_values[0], huber_sigma_s(-500.0 - y))
        if mjd <= t0 or t1 <= mjd <= last_obs:
            return SIGMA_OBSERVED_S
        if mjd < t1:
            s = (mjd - t0) / (t1 - t0)
            return math.sqrt(SIGMA_OBSERVED_S**2 + gap["gap_miss_s"] ** 2 * s * (1.0 - s))
        n = mjd - last_obs
        return max(SIGMA_OBSERVED_S, 0.00025 * n**0.75, huber_sigma_s(n / 365.25))

    for y in list(np.arange(-2000.0, 3000.5, 23.9)) + [-720.0, -719.0, 1600.0, 1615.0, 1972.9, 2026.1, 2026.5, 2026.9, 2027.5, 2060.0, 2100.0, 2650.0, 3000.0]:
        jd_tt = jd_tt_of_year(float(y))
        sigma_cases.append({"jd_tt": jd_tt, "sigma_s": round(sigma_expected(jd_tt), 9)})

    calendar_cases = []
    rng = np.random.default_rng(20260924)
    for jdn in np.concatenate([rng.integers(-1_000_000, 8_000_000, 200), [0, 1721424, 1721425, 1721058, 1721059, 2299159, 2299160, 2299161, 2440588, 2451545]]):
        jdn = int(jdn)
        gy, gm, gd = compute_calendar_date(jdn, julian_before=None)
        jy, jm, jd_ = compute_calendar_date(jdn, julian_before=10**12)
        assert julian_day(int(gy), int(gm), int(gd)) == jdn
        assert julian_day(int(jy), int(jm), int(jd_), julian_before=10**12) == jdn
        calendar_cases.append({"jdn": jdn, "gregorian": [int(gy), int(gm), int(gd)], "julian": [int(jy), int(jm), int(jd_)]})

    fixture = {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/timescales/gen_timescales.py",
            "skyfield": skyfield.__version__,
            "numpy": np.__version__,
            "generated_utc": RETRIEVED + "T00:00:00Z",
            "never_a_runtime_dependency": "Development-time reference. CONVENTIONS section 11: never regenerate a fixture from Rust output.",
            "description": "Delta-T, UT1 and calendar reference values for skyfix_core::{deltat, time, calendar}.",
            "model": "delta_t_s: Skyfield 1.55's build_delta_t (the Table-S15.2020 splines, the long-term parabola -320 + 32.5 ((y - 1825)/100)^2 s and its 800-year joins) run on SkyFix's weekly IERS table interpolated to whole days. skyfield_builtin_s: Skyfield 1.55's own timescale (its bundled table ends 2027-01-23 and is a prediction after about 2026-01-23).",
            "sources": [
                {"file": "tools/timescales/sources/Table-S15.2020.txt", "sha256": meta["sha_s15"], "doi": "10.6084/m9.figshare.29920388"},
                {"file": "tools/timescales/sources/Table-DT-lod4500yrs.2020.txt", "sha256": meta["sha_dt4500"], "doi": "10.6084/m9.figshare.30111661"},
                {"file": "tools/timescales/sources/iers-bulletin-a-2026-09-24.txt", "sha256": sha256(BULA_PATH), "issue": bula["issue"]},
                {"file": "skyfield/data/iers.npz (Skyfield 1.55)", "sha256": sha256(os.path.join(os.path.dirname(skyfield.__file__), "data", "iers.npz"))},
            ],
            "table": {
                "first_mjd": FIRST_MJD, "step_days": STEP_DAYS, "last_mjd": table_last_mjd,
                "unit_s": UNIT_S, "samples": int(len(q)),
                "interp_max_s": err_max, "interp_rms_s": err_rms,
                "bundle_last_observed_mjd": BUNDLE_LAST_OBSERVED_MJD,
                "gap": gap,
                "bulletin_a_last_observed_mjd": bula["last_observed_mjd"],
                "bulletin_a_last_predicted_mjd": max(bula["predicted"]),
            },
            "tolerances": {
                "delta_t_vs_python_model_s": 1e-6,
                "delta_t_vs_skyfield_iers_observed_s": 0.01,
                "delta_t_vs_skyfield_smh2016_s": 1.0,
                "dut1_vs_daily_s": 0.0025,
                "ut1_to_tt_s": 1e-6,
                "sigma_relative": 1e-6,
            },
            "sigma_rules": {
                "iers_observed_s": SIGMA_OBSERVED_S,
                "smh2016": "max(SMH's published error, linearly interpolated between its change points, 0.11 s: the measured rms of the S15 spline against IERS over 1973-2019)",
                "before_-720": "max(180 s, Huber(N)) with N = -500 - year (NASA's calibration year for dates before 500 BC)",
                "corrected_span": "sqrt(0.001^2 + M^2 s (1 - s)), M the 0.105 s miss, s the fraction of the span",
                "after_last_observation": "max(0.001 s, 0.00025 n^0.75 s (IERS Bulletin A), Huber(n / 365.25)) with n days since the last observed value",
                "huber": "sigma = 365.25 N sqrt((N Q / 3)(1 + N / M)) / 1000 s, Q = 0.058 ms^2/yr, M = 2500 yr (Huber 2000, as quoted on NASA's Delta-T uncertainty page)",
            },
        },
        "delta_t": delta_t_cases,
        "ut1_to_tt": ut1_cases,
        "dut1_daily": dut1_cases,
        "bulletin_a_observed": bula_observed,
        "delta_t_sigma": sigma_cases,
        "calendar": calendar_cases,
    }

    write_rust(s15, knots, mjd_w, q, meta)
    os.makedirs(os.path.dirname(OUT_FIXTURE), exist_ok=True)
    with open(OUT_FIXTURE, "w", encoding="utf-8") as f:
        f.write(dump_compact(fixture))
    print("wrote", OUT_RUST, "(%d samples, %.1f KB as i16)" % (len(q), len(q) * 2 / 1024))
    print("wrote", OUT_FIXTURE, "(%d delta_t cases)" % len(delta_t_cases))
    print("gap miss %.4f s; interp max %.2f ms rms %.2f ms" % (gap["gap_miss_s"], err_max * 1e3, err_rms * 1e3))
    return 0


if __name__ == "__main__":
    sys.exit(main())
