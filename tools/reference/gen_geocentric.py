"""fixtures/reference/geocentric_sun_stars.json

Apparent geocentric of-date GHA / Dec / SHA for the Sun and all 58 stars, plus
GHA of Aries, at 58 epochs:

  * every 2 years, 1 January 00:00, 1995 through 2055 (31 epochs; --window) --
    a 60-year span to exercise precession, nutation and proper motion;
  * hourly through 2026-10-01T00:00Z .. 2026-10-02T00:00Z (25 epochs) --
    a dense day around the project's demo date, so an interpolating provider
    can be checked against a real diurnal cycle including the 0h/24h wrap;
  * 2026-09-23T12:00Z (the project's start date) and 2028-02-29T00:00Z
    (a leap day).

CONVENTIONS section 7 frame: true equator and equinox of date, with precession,
nutation, annual aberration and light-time; no polar motion, no diurnal
aberration, no topocentric parallax, no refraction.

    tools/reference/.venv/bin/python -m tools.reference.gen_geocentric \
        [--window 1995..2055] [--kernel de421]

`--window` keeps the fixed epochs inside it and lays the two-yearly 1 January grid
across it; `--kernel` names the primary kernel (DE440s answers where DE421 does not
reach). Instants are on the app's clock with SkyFix Lab's own Delta T
(`common.load_timescale`), and outside the validated tier the frame is the app's
long-term one (`common.use_app_frame`).
"""

from __future__ import annotations

import os

from . import common as c


def epochs(ts):
    """The two-yearly 1 January grid (odd years, 1995 .. 2055 by default) across the
    window, and the fixed epochs that fall inside it."""
    out = []
    y0, y1 = c.window_years()
    for year in range(y0 + (1 - y0 % 2), y1 + 1, 2):
        if c.in_window(c.jd_from_gregorian(year, 1, 1)):
            out.append(ts.utc(year, 1, 1, 0, 0, 0))
    for hour in range(0, 25):
        if c.in_window(c.jd_from_gregorian(2026, 10, 1, hour)):
            out.append(ts.utc(2026, 10, 1, hour, 0, 0))
    for fixed in ((2026, 9, 23, 12), (2028, 2, 29, 0)):
        if c.in_window(c.jd_from_gregorian(*fixed)):
            out.append(ts.utc(*fixed, 0, 0))
    return out


def crosscheck(ts, ts_list, stars, eph_a, eph_b):
    """Max DE421-vs-DE440s disagreement, arcsec, over the epochs both cover."""
    from skyfield.api import load

    earth_a, sun_a = eph_a["earth"], eph_a["sun"]
    earth_b, sun_b = eph_b["earth"], eph_b["sun"]
    lo, hi = _span(eph_a)
    worst_sun = 0.0
    worst_star = 0.0
    n = 0
    for t in ts_list:
        if not (lo < float(t.tt) < hi):
            continue
        n += 1
        ga, da, _, _ = c.geocentric_of(earth_a, t, sun_a)
        gb, db, _, _ = c.geocentric_of(earth_b, t, sun_b)
        worst_sun = max(worst_sun, _sep_arcsec(ga, da, gb, db))
        for name in ("Vega", "Sirius", "Polaris", "Rigil Kentaurus", "Canopus"):
            ga, da, _, _ = c.geocentric_of(earth_a, t, stars[name])
            gb, db, _, _ = c.geocentric_of(earth_b, t, stars[name])
            worst_star = max(worst_star, _sep_arcsec(ga, da, gb, db))
    return worst_sun, worst_star, n


def _sep_arcsec(gha1, dec1, gha2, dec2):
    import math

    d1, d2 = math.radians(dec1), math.radians(dec2)
    dh = math.radians(c.wrap_diff_deg(gha1, gha2))
    cos_sep = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(dh)
    return math.degrees(math.acos(max(-1.0, min(1.0, cos_sep)))) * 3600.0


def _span(eph):
    """(start, end) TDB Julian dates a kernel covers."""
    files = getattr(eph, "files", [eph])
    return (float(files[0].spk.segments[0].start_jd), float(files[-1].spk.segments[0].end_jd))


def build():
    ts = c.load_timescale()
    eph421 = c.run_ephemeris()
    eph440 = c.load_kernel("de440s" if c.RUN.kernel != "de440s" else "de440")
    lo421, hi421 = _span(eph421)
    primary = c.RUN.kernel
    fallback = eph440.name

    df = c.load_hipparcos_frame()
    stars, _rows, problems = c.build_stars(df)

    ts_list = epochs(ts)
    worst_sun, worst_star, n_cross = crosscheck(ts, ts_list, stars, eph421, eph440)

    cases = []
    n_bodies = 0
    dut1_min = 1e9
    dut1_max = -1e9
    used_440 = []

    for t in ts_list:
        in_421 = lo421 < float(t.tt) < hi421
        eph = eph421 if in_421 else eph440
        eph_name = (primary if in_421 else fallback) + ".bsp"
        if not in_421:
            used_440.append(t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"))
        earth, sun = eph["earth"], eph["sun"]

        head = c.epoch_header(t)
        head["ephemeris"] = eph_name
        dut1 = float(t.dut1)
        dut1_min = min(dut1_min, dut1)
        dut1_max = max(dut1_max, dut1)

        bodies = {}

        gha, dec, ra, dist = c.geocentric_of(earth, t, sun)
        sd, hp = c.sun_disc(dist)
        bodies["Sun"] = c.Inline(
            {
                "gha_deg": c.deg(gha),
                "gha_deg_dut1_zero": c.deg(c.gha_dut1_zero_deg(gha, dut1)),
                "dec_deg": c.deg(dec),
                "sha_deg": c.deg(c.norm360(360.0 - ra)),
                "ra_deg": c.deg(ra),
                "distance_au": c.Num(dist, 9),
                "semidiameter_arcmin": c.arcmin(sd),
                "horizontal_parallax_arcmin": c.arcmin(hp),
            }
        )
        n_bodies += 1

        for name in c.STAR_NAMES:
            gha, dec, ra, _dist = c.geocentric_of(earth, t, stars[name])
            bodies[name] = c.Inline(
                {
                    "gha_deg": c.deg(gha),
                    "gha_deg_dut1_zero": c.deg(c.gha_dut1_zero_deg(gha, dut1)),
                    "dec_deg": c.deg(dec),
                    "sha_deg": c.deg(c.norm360(360.0 - ra)),
                    "ra_deg": c.deg(ra),
                }
            )
            n_bodies += 1

        head["bodies"] = bodies
        cases.append(head)

    dut1_extreme = dut1_min if abs(dut1_min) > abs(dut1_max) else dut1_max

    tolerance_note = (
        "0.05 arcmin (3 arcsec) for both the Sun and the stars. In the order the "
        "error budget matters: (1) the project's best sextant sigma is 0.1 arcmin "
        "and a realistic one is 1 arcmin, so a 0.05 arcmin ephemeris error adds "
        "under 3 %% to the smallest position variance in quadrature and is "
        "invisible at 1 arcmin; (2) 0.05 arcmin is 93 m of great-circle arc, an "
        "order of magnitude below any accuracy a sextant fix claims; (3) it is "
        "loose enough that a low-cost analytic model (truncated VSOP87 Sun, IAU "
        "1980 nutation, catalogue proper motion) can plausibly meet it, and tight "
        "enough that a wrong frame fails at once: omitting nutation costs up to "
        "17 arcsec (0.28 arcmin), omitting annual aberration 20 arcsec (0.33 "
        "arcmin), omitting proper motion over 30 years costs Rigil Kentaurus 111 "
        "arcsec (1.85 arcmin). The reference data itself is far inside the "
        "tolerance: over the %d epochs both DE421 and DE440 cover, the two "
        "ephemerides disagree by at most %.4f arcsec on the Sun and %.4f arcsec "
        "on the stars, i.e. %.1f times smaller than the tolerance."
        % (n_cross, worst_sun, worst_star, 3.0 / max(worst_sun, 1e-6))
    )

    notes = [
        "GHA = normalise(t.gast * 15 - RA_of_date) into [0, 360), west-positive, "
        "exactly as CONVENTIONS section 2 defines it. SHA = 360 - RA_of_date, so "
        "GHA_star = GHA_Aries + SHA holds to rounding in every case here.",
        "The frame is the TRUE equator and equinox of DATE. Polar motion is not "
        "applied. Diurnal aberration is not applied and cannot be: this is a "
        "geocentric frame with no observer in it. Topocentric parallax is not "
        "applied; CONVENTIONS section 5 step 5 applies it as an altitude "
        "correction instead. There is no refraction here.",
        "Two GHA columns are given for every body. `gha_deg` uses the timescale's UT1, "
        "i.e. it applies the epoch's DUT1 (SkyFix Lab's IERS table on the UTC scale, "
        "Bulletin A's prediction beyond it, the Delta T model where the table ends). "
        "`gha_deg_dut1_zero` is the same GHA recomputed with UT1 = UTC, which is the "
        "assumption CONVENTIONS section 6 makes for a navigator without a time signal. "
        "An implementation that assumes DUT1 = 0 must be compared against "
        "`gha_deg_dut1_zero`; comparing it against `gha_deg` will fail by "
        "15.0410686 arcsec per second of DUT1. Over these epochs DUT1 runs from "
        "%.4f s to %.4f s, i.e. up to %.3f arcmin of GHA. After 2035 the app's clock is "
        "UT1 itself (CONVENTIONS 15.2): DUT1 is 0 there by definition and the two "
        "columns coincide."
        % (
            dut1_min,
            dut1_max,
            abs(dut1_extreme) * c.EARTH_ROTATION_ARCSEC_PER_SECOND / 60.0,
        ),
        "Solar semidiameter is %.2f arcsec / distance_au and horizontal parallax "
        "is %.3f arcsec / distance_au, the Nautical Almanac / IAU 1976 constants. "
        "distance_au is the light-time-corrected geocentric distance taken from "
        "the apparent position, which is the distance the Almanac's semidiameter "
        "refers to."
        % (c.SUN_SEMIDIAMETER_ARCSEC_AT_1AU, c.SUN_HORIZONTAL_PARALLAX_ARCSEC_AT_1AU),
        "Star positions carry Hipparcos proper motion and annual parallax "
        "propagated from the catalogue epoch J1991.25 to each epoch by Skyfield's "
        "rigorous space motion, with each star's SIMBAD radial velocity "
        "(navigational_stars_hip.json); Rigil Kentaurus (alpha Cen A) follows its "
        "orbit about the A-B barycentre (tools/reference/acen_orbit.py, ORB6).",
        "Instants are on the app's clock (CONVENTIONS 15.2: UTC to 2035, UT after) with "
        "SkyFix Lab's own Delta T (tools/timescales/skyfield_timescale.py); every case "
        "records its jd_tt and jd_ut1. After 2035 the clock is UT1, so dut1_s is 0 there "
        "and the two GHA columns agree.",
        "The primary kernel (%s) is used where it covers the epoch; the %d epoch(s) "
        "outside it (%s) use %s instead; each case records which kernel produced it. "
        "Over the %d epochs both cover, the two kernels agree to %.4f arcsec on the Sun "
        "and %.4f arcsec on the stars, so the switch is far below the tolerance."
        % (
            primary,
            len(used_440),
            ", ".join(used_440) if used_440 else "none",
            fallback,
            n_cross,
            worst_sun,
            worst_star,
        ),
    ]
    if problems:
        notes.append("STAR IDENTITY DOUBTS: " + " | ".join(problems))

    doc = {
        "schema": "skyfix.reference/1",
        "name": "geocentric_sun_stars",
        "generator": c.generator_block(
            tool="tools/reference/gen_geocentric.py",
            description=(
                "Apparent geocentric of-date GHA/Dec/SHA for the Sun and 58 stars "
                "at %d epochs in %s." % (len(cases), c.RUN.window_text)
            ),
            tolerance_arcmin=c.Num(0.05, 4),
            tolerance_justification=tolerance_note,
            frame_notes=c.GEOCENTRIC_FRAME_NOTES,
            refraction="none; these are geocentric directions, not altitudes",
            timescale=c.project_timescale_facts(),
            extra={
                "run": c.RUN.facts(),
                "frame_of_date": c.app_frame_facts(),
                "ephemeris": c.run_kernel_facts(),
                "ephemeris_crosscheck": {
                    "file": eph440.facts(),
                    "epochs_compared": n_cross,
                    "max_sun_difference_arcsec": c.arcsec(worst_sun),
                    "max_star_difference_arcsec": c.arcsec(worst_star),
                    "used_for_epochs": used_440,
                },
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "epoch_count": len(cases),
                "body_count": len(c.BODY_NAMES),
                "case_count": n_bodies,
                "dut1_range_s": c.Inline(
                    {"min": c.secs(dut1_min), "max": c.secs(dut1_max)}
                ),
                "epoch_sets": [
                    "1 January 00:00 on the app's clock, odd years across the window "
                    "(1995 to 2055 by default)",
                    "hourly 2026-10-01T00:00Z through 2026-10-02T00:00Z",
                    "2026-09-23T12:00Z",
                    "2028-02-29T00:00Z (leap day)",
                ],
            },
        ),
        "notes": notes,
        "cases": cases,
    }
    print(
        "   %d epochs x %d bodies = %d cases; DE421 vs DE440s max %.4f\" (Sun) "
        "%.4f\" (stars) over %d epochs"
        % (len(cases), len(c.BODY_NAMES), n_bodies, worst_sun, worst_star, n_cross)
    )
    return doc


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "1995..2055", "de421")
    doc = build()
    c.write_json(os.path.join(c.FIX_REFERENCE, "geocentric_sun_stars.json"), doc)


if __name__ == "__main__":
    main()
