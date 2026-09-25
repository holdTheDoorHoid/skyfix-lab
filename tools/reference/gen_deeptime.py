"""fixtures/reference/deeptime_bodies.json -- the Sun, the Moon and the planets over both
coverage tiers, for the historical accuracy table (docs/ACCURACY.md).

Development-time only (CONVENTIONS section 11). Run from the repository root:

    tools/reference/.venv/bin/python -m tools.reference.gen_deeptime \
        [--window -2000..3001] [--kernel auto] [--per-bin 20] [--stars-per-bin 1]

What it records, per epoch: the instant on the app's clock and in UT1 and TT, and for
every body the apparent RA and Dec of date, the GHA and the distance. The first
`--stars-per-bin` epochs of each bin also carry the 58 navigational stars' apparent RA
and Dec (Hipparcos with SIMBAD radial velocities, Rigil Kentaurus on its orbit:
`common.build_stars`) and each star's formal catalogue uncertainty at that epoch
(`catalogue_sigma`, below).

* **Bins.** Every half-century of the validated tier (1550-01-01 .. 2650-01-22) and
  every century of the labelled tier outside it (2000 BC .. AD 3000), `--per-bin`
  epochs each, seeded so the file is reproducible.
* **Kernels.** JPL DE440 inside the validated tier, DE441 outside (EXPANSION_PLAN 4.6;
  JPL: DE440's lunar core-mantle damping "is not suitable for extrapolation more than
  several centuries into the past"). `--kernel` forces one kernel everywhere.
* **Delta T.** Every epoch is an instant on the app's clock (`jd_utc`: UTC 1972-2035,
  UT outside, CONVENTIONS 15.2) turned into TT and UT1 by SkyFix Lab's own Delta T
  (`tools/timescales/skyfield_timescale.py`: the table compiled into skyfix_core, run
  through Skyfield's own joins), so `jd_tt(jd_utc)` on the Rust side gives the same TT.
  The Rust test feeds `jd_tt` and `jd_ut1` to the providers' `position_at`, so Delta T
  never counts as ephemeris error either way.
* **Calendar.** Proleptic Gregorian, astronomical year numbering, ISO 8601 expanded
  years outside 0000-9999 (EXPLORER_API "Dates and years on the wire").
* **Frame.** Inside the validated tier, Skyfield's own apparent place of date
  (`observe().apparent().radec(epoch='date')`: IAU 2006 precession, IAU 2000A
  nutation) and `t.gast`. Outside it, Skyfield's apparent GCRS direction (light-time,
  deflection and aberration computed by Skyfield with DE441), rotated to the true
  equator and equinox of date by the Vondrak-Capitaine-Wallace 2011 long-term
  precession (`ltp.py`, pinned to ERFA's published test values) and Skyfield's IAU
  2000A nutation, with GAST = ERA + the long-term accumulated precession of `ltp.py` +
  Skyfield's equation of the equinoxes. Skyfield's P03 precession is a polynomial
  that drifts arcseconds from the long-term model at 2000 BC, so it cannot be the
  reference there.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np

from . import common as c
from . import ltp as L

OUT = os.path.join(c.FIX_REFERENCE, "deeptime_bodies.json")
VALIDATED = (c.jd_from_gregorian(1550, 1, 1), c.jd_from_gregorian(2650, 1, 22))
LABELLED_END = c.jd_from_gregorian(3001, 1, 1) - 1.0 / 86400.0
BODIES = [
    ("Sun", "sun"),
    ("Moon", "moon"),
    ("Mercury", "mercury"),
    ("Venus", "venus"),
    ("Mars", "mars barycenter"),
    ("Jupiter", "jupiter barycenter"),
    ("Saturn", "saturn barycenter"),
    ("Uranus", "uranus barycenter"),
    ("Neptune", "neptune barycenter"),
]
#: The accuracies the Rust providers publish, arcminutes (validated, labelled). The
#: Rust test asserts every case against the provider's own constants; these copies are
#: recorded so the file says what it was generated to check.
CLAIMED = {
    "Sun": (0.01, 0.02), "Moon": (0.02, 0.05), "Mercury": (0.02, 0.02),
    "Venus": (0.02, 0.05), "Mars": (0.02, 0.1), "Jupiter": (0.02, 0.25),
    "Saturn": (0.02, 0.7), "Uranus": (0.03, 0.2), "Neptune": (0.02, 0.05),
}


def bins(j0, j1):
    """(tier, label, start jd, end jd) for every bin inside [j0, j1]."""
    out = []
    y = 1550
    while y < 2650:
        a = max(c.jd_from_gregorian(y, 1, 1), VALIDATED[0])
        b = min(c.jd_from_gregorian(y + 50, 1, 1), VALIDATED[1])
        out.append(("validated", "%d..%d" % (y, min(y + 50, 2650)), a, b))
        y += 50
    for y in range(-2000, 3000, 100):
        a, b = c.jd_from_gregorian(y, 1, 1), c.jd_from_gregorian(y + 100, 1, 1)
        # The labelled tier ends at 3000-12-31T23:59:59: the last century stops there.
        b = min(b, LABELLED_END)
        if b <= VALIDATED[0] or a >= VALIDATED[1]:
            out.append(("labelled", "%d..%d" % (y, y + 100), a, b))
        elif a < VALIDATED[0]:
            out.append(("labelled", "%d..1550" % y, a, VALIDATED[0]))
        elif b > VALIDATED[1]:
            out.append(("labelled", "2650..%d" % (y + 100), VALIDATED[1], b))
    return [x for x in out if x[3] > j0 and x[2] < j1]


def ltp_true_of_date(jd_tt):
    """GCRS -> true equator and equinox of date under the long-term precession and
    Skyfield's IAU 2000A nutation; and the equation of the equinoxes (radians)."""
    from skyfield import nutationlib

    epj = 2000.0 + (jd_tt - 2451545.0) / 365.25
    pb = L.ltpb(epj)
    pecl, peqr = L.ltpecl(epj), L.ltpequ(epj)
    eps_a = math.atan2(np.linalg.norm(np.cross(pecl, peqr)), float(pecl @ peqr))
    dpsi, deps = nutationlib.iau2000a_radians(_tt_time(jd_tt))
    n = _rot1(-(eps_a + deps)) @ _rot3(-dpsi) @ _rot1(eps_a)
    ee = dpsi * math.cos(eps_a) + nutationlib.equation_of_the_equinoxes_complimentary_terms(jd_tt)
    return n @ pb, ee


_TS = None


def _tt_time(jd_tt):
    return _TS.tt_jd(jd_tt)


def _rot1(a):
    ca, sa = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, ca, sa], [0.0, -sa, ca]])


def _rot3(a):
    ca, sa = math.cos(a), math.sin(a)
    return np.array([[ca, sa, 0.0], [-sa, ca, 0.0], [0.0, 0.0, 1.0]])


def catalogue_sigma():
    """{name: f(years since J1991.25) -> 1-sigma arcsec}: the Hipparcos formal errors of
    the proper motion (hip_main.dat fields e_pmRA, e_pmDE) times the interval, and the
    radial velocity's and the parallax's errors through the perspective acceleration
    (mu * v_r / d * t^2), added in quadrature. What the catalogue itself allows, not a
    model error; Rigil Kentaurus's barycentric proper motion is uncertain beyond this
    (ACCURACY "Rigil Kentaurus")."""
    from .gen_stars import RADIAL_VELOCITIES

    rows = {}
    with open(c.HIPPARCOS_FILE) as f:
        for line in f:
            p = line.split("|")
            try:
                rows[int(p[1])] = p
            except ValueError:
                continue
    out = {}
    for name, hip, *_ in c.NAV_STARS:
        p = rows[hip]
        plx, pmra, pmde = float(p[11]), float(p[12]), float(p[13])
        eplx, epmra, epmde = float(p[16]), float(p[17]), float(p[18])
        rv, erv = RADIAL_VELOCITIES[hip][0], RADIAL_VELOCITIES[hip][1]
        mu = math.hypot(pmra, pmde) / 1000.0
        d_au = 206264.806 * 1000.0 / plx

        def f(dt, mu=mu, d_au=d_au, epm=math.hypot(epmra, epmde) / 1000.0, rv=rv, erv=erv,
              rel=eplx / plx):
            s_pm = abs(dt) * epm
            s_rv = mu * (erv / 4.740470 / d_au) * dt * dt
            s_px = mu * (abs(rv) / 4.740470 / d_au) * dt * dt * rel
            return math.sqrt(s_pm ** 2 + s_rv ** 2 + s_px ** 2)

        out[name] = f
    return out


def main(argv=None):
    global _TS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    c.add_window_kernel_args(ap, "-2000..3000", "auto")
    ap.add_argument("--per-bin", type=int, default=20, help="epochs per bin (default %(default)s)")
    ap.add_argument("--stars-per-bin", type=int, default=1,
                    help="epochs per bin that also carry the 58 stars (default %(default)s)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args(argv)
    j0, j1 = c.parse_window(args.window)
    from skyfield.api import load
    from skyfield.earthlib import earth_rotation_angle

    ts, _ts0, clock_time = c.project_timescales()
    _TS = ts
    kernels = {}

    def kernel_for(jd):
        name = args.kernel if args.kernel != "auto" else (
            "de440" if VALIDATED[0] <= jd <= VALIDATED[1] else "de441")
        if name not in kernels:
            kernels[name] = c.load_kernel(name)
        return name, kernels[name]

    rng = np.random.default_rng(20260924)
    cases = []
    t_ltp = L.gmst_minus_era_samples()  # (t centuries, g arcsec) on a quarter-year grid
    stars, _rows, problems = c.build_stars(c.load_hipparcos_frame())
    assert not problems, problems
    sigma = catalogue_sigma()
    for tier, label, a, b in bins(j0, j1):
        n = args.per_bin
        # Stratified in the bin: one random clock instant in each of n equal slices.
        edges = np.linspace(a, b, n + 1)
        clocks = np.sort(edges[:-1] + rng.uniform(0.0, 1.0, n) * np.diff(edges))
        for i_case, jd_clock in enumerate(clocks):
            jd_clock = float(jd_clock)
            kname, k = kernel_for(jd_clock)
            in_utc = c.jd_from_gregorian(1972, 1, 1) <= jd_clock < c.jd_from_gregorian(2036, 1, 1)
            t = clock_time(ts, jd_clock)
            eph = k.segment(float(t.tdb))
            earth = eph["earth"]
            case = {
                "tier": tier,
                "bin": label,
                "kernel": kname,
                "clock": "utc" if in_utc else "ut",
                "utc": c.iso_utc(jd_clock),
                "jd_utc": c.jd(jd_clock),
                "jd_ut1": c.jd(float(t.ut1)),
                "jd_tt": c.jd(float(t.tt)),
                "delta_t_s": c.secs(float(t.delta_t)),
                "bodies": {},
            }
            if tier == "labelled":
                m, ee = ltp_true_of_date(float(t.tt))
                tc = (float(t.tt) - 2451545.0) / 36525.0
                g = float(np.interp(tc, t_ltp[0], t_ltp[1]))
                gast = (earth_rotation_angle(float(t.ut1)) * 360.0 + g / 3600.0
                        + math.degrees(ee)) % 360.0
            for name, key in BODIES:
                app = earth.at(t).observe(eph[key]).apparent()
                if tier == "validated":
                    ra, dec, dist = app.radec(epoch="date")
                    ra_deg, dec_deg = float(ra._degrees), float(dec.degrees)
                    gast_deg = float(t.gast) * 15.0
                    dist_km = float(dist.km)
                else:
                    v = m @ app.position.au
                    ra_deg = math.degrees(math.atan2(v[1], v[0])) % 360.0
                    dec_deg = math.degrees(math.asin(v[2] / np.linalg.norm(v)))
                    gast_deg = gast
                    dist_km = float(app.distance().km)
                body = {
                    "ra_deg": c.deg(ra_deg),
                    "dec_deg": c.deg(dec_deg),
                    "gha_deg": c.deg(c.norm360(gast_deg - ra_deg)),
                    "distance_km": c.Num(dist_km, 3),
                }
                if name == "Moon":
                    geo = (eph["moon"] - eph["earth"]).at(t)
                    body["geometric_distance_km"] = c.Num(float(geo.distance().km), 3)
                case["bodies"][name] = c.Inline(body)
            if i_case < args.stars_per_bin:
                dt_years = (float(t.tt) - 2448349.0625) / 365.25  # from J1991.25
                case["stars"] = {}
                for name in c.STAR_NAMES:
                    app = earth.at(t).observe(stars[name]).apparent()
                    if tier == "validated":
                        ra, dec, _ = app.radec(epoch="date")
                        ra_deg, dec_deg = float(ra._degrees), float(dec.degrees)
                    else:
                        v = m @ app.position.au
                        ra_deg = math.degrees(math.atan2(v[1], v[0])) % 360.0
                        dec_deg = math.degrees(math.asin(v[2] / np.linalg.norm(v)))
                    case["stars"][name] = c.Inline(
                        [c.deg(ra_deg), c.deg(dec_deg), c.Num(sigma[name](dt_years), 3)])
            cases.append(case)
        print("   %-9s %-12s %d epochs (%s)" % (tier, label, len(clocks), kname), flush=True)

    doc = {
        "schema": "skyfix.reference/1",
        "generator": c.generator_block(
            "tools/reference/gen_deeptime.py",
            "Apparent geocentric Sun, Moon and planets per half-century of the validated tier "
            "and per century of the labelled tier, for the historical accuracy table.",
            None,
            "The Rust test (crates/skyfix-ephemeris/tests/deeptime_reference.rs) asserts every "
            "case against each provider's published accuracy for the case's tier; `claimed` "
            "records the values this file was generated to check.",
            frame_notes={
                "validated": ("Skyfield observe().apparent().radec(epoch='date') and t.gast: IAU "
                              "2006 precession, IAU 2000A nutation, DE440."),
                "labelled": ("Skyfield's apparent GCRS direction with DE441, rotated by the "
                             "Vondrak-Capitaine-Wallace 2011 long-term precession with the IERS "
                             "2010 frame bias (tools/reference/ltp.py, ERFA eraLtpb) and Skyfield's "
                             "IAU 2000A nutation on the long-term mean obliquity; GAST = ERA(UT1) + "
                             "the long-term accumulated precession of ltp.gmst_minus_era_samples + "
                             "dpsi cos(eps_A) + the complementary terms."),
            },
            extra={
                "window": args.window,
                "kernel_choice": args.kernel,
                "kernels": {name: k.facts() for name, k in kernels.items()},
                "delta_t_note": ("jd_tt and jd_ut1 are given per case and the Rust test uses them "
                                 "directly, so Delta T is not part of the comparison"),
                "calendar": "proleptic Gregorian, astronomical year numbering, ISO 8601 expanded years",
                "per_bin": args.per_bin,
                "stars_per_bin": args.stars_per_bin,
                "stars": ("the first stars_per_bin epochs of each bin: {name: [apparent RA of "
                          "date deg, Dec deg, catalogue_sigma arcsec]} (Hipparcos + SIMBAD radial "
                          "velocities, rigorous space motion, Rigil Kentaurus on its ORB6 orbit); "
                          "catalogue_sigma is the 1-sigma position uncertainty the catalogue's "
                          "own formal errors allow at that epoch (proper motion x interval, "
                          "radial velocity and parallax through the perspective acceleration)"),
                "claimed_arcmin": {k: c.Inline([c.Num(v[0], 3), c.Num(v[1], 3)]) for k, v in CLAIMED.items()},
            },
            timescale=c.project_timescale_facts(),
        ),
        "cases": cases,
    }
    c.write_json(args.out, doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
