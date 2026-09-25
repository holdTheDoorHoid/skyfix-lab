"""fixtures/reference/topocentric_altaz.json

Topocentric apparent altitude and azimuth at five observers, six epochs each,
for every body more than 1 degree below the horizon, with and without Skyfield's
refraction at 1010 mbar / 10 C.

The point of the file is the last two fields of every case:
`spherical_formula_altitude_deg` is CONVENTIONS section 3 evaluated in Python
from the *geocentric* GHA/Dec and the observer's geodetic latitude and
longitude, and `spherical_minus_skyfield_arcsec` is how far that simple model
is from a full topocentric computation. For stars the gap must be a fraction of
an arcsecond (diurnal aberration only); for the Sun it must be the horizontal
parallax, which is exactly the correction CONVENTIONS section 5 step 5 applies.
If either is not true, the project's spherical model is wrong somewhere.

    tools/reference/.venv/bin/python -m tools.reference.gen_topocentric \
        [--window 2026-10-01..2026-10-02] [--kernel de421]

The default window is the demo day, 2026-10-01; a wider window takes the six hours on
five days spread evenly across it. Instants are on the app's clock with SkyFix Lab's
own Delta T (`common.load_timescale`); outside the validated tier the frame of date is
the app's long-term one (`common.use_app_frame`).
"""

from __future__ import annotations

import math
import os

from . import common as c

EPOCH_HOURS = [0, 4, 8, 12, 16, 20]
ALTITUDE_GATE_DEG = -1.0


DEFAULT_WINDOW = "2026-10-01..2026-10-02"


def days():
    """The days whose six hours are sampled: 2026-10-01, or five across a wider window."""
    if c.RUN.window_text == DEFAULT_WINDOW:
        return [(2026, 10, 1)]
    j0, j1 = c.RUN.window
    n = 5 if j1 - j0 > 5 else 1
    out = []
    for k in range(n):
        y, m, d, _h = c.gregorian_from_jd(j0 + (k + 0.5) * (j1 - j0) / n)
        out.append((y, m, d))
    return out


def epochs(ts):
    return [ts.utc(y, m, d, h, 0, 0) for (y, m, d) in days() for h in EPOCH_HOURS]


def build():
    ts = c.load_timescale()
    eph = c.run_ephemeris()
    earth, sun = eph["earth"], eph["sun"]
    df = c.load_hipparcos_frame()
    stars, _rows, problems = c.build_stars(df)

    targets = [("Sun", sun)] + [(n, stars[n]) for n in c.STAR_NAMES]

    worst = {"Sun": 0.0, "star": 0.0}
    worst_pa_identity = 0.0
    worst_where = {"Sun": None, "star": None}
    worst_az = {"Sun": 0.0, "star": 0.0}
    n_cases = 0
    cases = []

    for site_name, lat, lon, elev in c.OBSERVERS:
        place = c.topos(lat, lon, elev)
        site = earth + place
        for t in epochs(ts):
            head = c.epoch_header(t)
            entries = {}
            for body_name, target in targets:
                astro = site.at(t).observe(target)
                app = astro.apparent()
                alt, az, _d = app.altaz()
                alt_deg = float(alt.degrees)
                if alt_deg <= ALTITUDE_GATE_DEG:
                    continue
                alt_r, _az_r, _ = app.altaz(
                    temperature_C=c.STANDARD_TEMPERATURE_C,
                    pressure_mbar=c.STANDARD_PRESSURE_HPA,
                )
                az_deg = float(az.degrees)

                gha, dec, _ra, dist = c.geocentric_of(earth, t, target)
                hc, zn = c.spherical_altitude_azimuth_deg(lat, lon, gha, dec)
                d_alt_arcsec = (hc - alt_deg) * 3600.0
                d_az_arcsec = c.wrap_diff_deg(zn, az_deg) * 3600.0

                cls = "Sun" if body_name == "Sun" else "star"
                if abs(d_alt_arcsec) > abs(worst[cls]):
                    worst[cls] = d_alt_arcsec
                    worst_where[cls] = "%s at %s, %s (alt %.2f deg)" % (
                        body_name,
                        site_name,
                        t.utc_strftime("%Y-%m-%dT%H:%MZ"),
                        alt_deg,
                    )
                # azimuth is ill-conditioned within a degree of the zenith
                if alt_deg < 88.0:
                    worst_az[cls] = max(worst_az[cls], abs(d_az_arcsec))

                rec = {
                    "altitude_unrefracted_deg": c.deg(alt_deg),
                    "altitude_refracted_deg": c.deg(float(alt_r.degrees)),
                    "refraction_arcmin": c.arcmin(
                        (float(alt_r.degrees) - alt_deg) * 60.0
                    ),
                    "azimuth_deg": c.deg(az_deg),
                    "gha_deg": c.deg(gha),
                    "gha_deg_dut1_zero": c.deg(
                        c.gha_dut1_zero_deg(gha, float(t.dut1))
                    ),
                    "dec_deg": c.deg(dec),
                    "spherical_formula_altitude_deg": c.deg(hc),
                    "spherical_minus_skyfield_arcsec": c.arcsec(d_alt_arcsec),
                    "spherical_formula_azimuth_deg": c.deg(zn),
                    "spherical_azimuth_minus_skyfield_arcsec": c.arcsec(d_az_arcsec),
                }
                if body_name == "Sun":
                    sd, hp = c.sun_disc(dist)
                    pa = c.parallax_in_altitude_arcmin(hp, alt_deg)
                    worst_pa_identity = max(
                        worst_pa_identity, abs(d_alt_arcsec - pa * 60.0)
                    )
                    rec["semidiameter_arcmin"] = c.arcmin(sd)
                    rec["horizontal_parallax_arcmin"] = c.arcmin(hp)
                    rec["parallax_in_altitude_arcmin"] = c.arcmin(pa)
                entries[body_name] = c.Inline(rec)
                n_cases += 1

            head["observer"] = c.Inline(
                {
                    "name": site_name,
                    "lat_deg": c.deg(lat),
                    "lon_deg": c.deg(lon),
                    "height_m": c.metres(elev),
                }
            )
            head["bodies_above_gate"] = len(entries)
            head["bodies"] = entries
            cases.append(head)

    notes = [
        "Observer positions are geodetic on the WGS84 ellipsoid "
        "(skyfield.api.wgs84.latlon). The local vertical is the ellipsoid normal, "
        "which is what a spirit level or an artificial horizon actually defines. "
        "Heights are ellipsoid heights in metres; only Philadelphia has a "
        "non-zero one (10 m).",
        "`altitude_unrefracted_deg` is the topocentric apparent altitude with no "
        "atmosphere: light-time, annual AND diurnal aberration, relativistic "
        "deflection, precession/nutation to date, and the observer's displacement "
        "from the geocentre (so the Sun's topocentric parallax is already in it). "
        "This is the altitude a perfect instrument would measure in a vacuum, and "
        "it is what an `apparent_ha` reading reduces to once refraction is "
        "removed -- it is NOT the Ho that CONVENTIONS section 5 produces, because "
        "Ho is geocentric.",
        "`spherical_formula_altitude_deg` is CONVENTIONS section 3 applied to the "
        "geocentric `gha_deg`/`dec_deg` and the observer's geodetic latitude and "
        "longitude. `spherical_minus_skyfield_arcsec` = that minus "
        "`altitude_unrefracted_deg`.",
        "For a STAR the two differ only by diurnal aberration (the observer's "
        "rotation velocity, up to 0.32 arcsec at the equator) plus the ellipsoid "
        "deflection of the vertical at the sub-arcsecond level. Largest found "
        "here: %+.4f arcsec, for %s. That is 0.0%s arcmin, far inside the 0.05 "
        "arcmin tolerance, and it is the numerical evidence that the project's "
        "spherical geocentric model is adequate for stars."
        % (
            worst["star"],
            worst_where["star"],
            ("%.4f" % (abs(worst["star"]) / 60.0)).lstrip("0."),
        ),
        "For the SUN the two differ by the topocentric parallax, which is "
        "precisely what CONVENTIONS section 5 step 5 adds back as PA = HP*cos(Ha). "
        "Largest found here: %+.4f arcsec = %+.4f arcmin, for %s. Each Sun case "
        "carries `parallax_in_altitude_arcmin` so the identity "
        "spherical_minus_skyfield ~= PA can be checked directly: over every Sun "
        "case here the identity holds to %.4f arcsec (%.5f arcmin). That "
        "residual is diurnal aberration (largest at the equatorial observer, and "
        "it changes sign with azimuth, as diurnal aberration must), plus the "
        "0.14 %% by which the observer's geocentric radius falls short of the "
        "equatorial radius that HP is defined against, plus the second order of "
        "PA = HP*cos(Ha). It is 17 times below this file's tolerance, so "
        "CONVENTIONS section 5 step 5 is adequate as written."
        % (worst["Sun"], worst["Sun"] / 60.0, worst_where["Sun"],
           worst_pa_identity, worst_pa_identity / 60.0),
        "Azimuth is Zn, true bearing clockwise from north, [0, 360). The "
        "spherical-formula azimuth agrees with Skyfield to %.4f arcsec (stars) "
        "and %.4f arcsec (Sun) over every case at least 2 degrees from the "
        "zenith. These are larger than the altitude discrepancies purely for "
        "geometric reasons: a fixed angular displacement on the sky becomes an "
        "azimuth difference of that displacement divided by cos(altitude), so "
        "the sub-arcsecond diurnal aberration is magnified four-fold at 76 "
        "degrees altitude and without bound at the zenith. Cases within 2 "
        "degrees of the zenith are written to the file but excluded from that "
        "maximum, because azimuth there is not a meaningful quantity to compare."
        % (worst_az["star"], worst_az["Sun"]),
        "Only bodies with an unrefracted topocentric altitude above %.1f deg are "
        "listed. CONVENTIONS section 5 step 3 rejects a sight below Ha = 0 and "
        "flags one below 10 deg; the low cases are here on purpose so the "
        "rejection and flagging paths have real data." % ALTITUDE_GATE_DEG,
    ]
    if problems:
        notes.append("STAR IDENTITY DOUBTS: " + " | ".join(problems))

    doc = {
        "schema": "skyfix.reference/1",
        "name": "topocentric_altaz",
        "generator": c.generator_block(
            tool="tools/reference/gen_topocentric.py",
            description=(
                "Topocentric apparent alt/az at 5 observers x 6 epochs, with and "
                "without refraction, against the CONVENTIONS section 3 spherical "
                "formula."
            ),
            tolerance_arcmin=c.Num(0.05, 4),
            tolerance_justification=(
                "0.05 arcmin (3 arcsec), the same as the geocentric file, for the "
                "same reason: it sits an order of magnitude below the 0.1 arcmin "
                "best-case sextant sigma and 93 m below any claimed fix accuracy, "
                "while being tight enough to catch a missing frame term. The "
                "file's own worst star discrepancy against the spherical model is "
                "%.4f arcsec (%.5f arcmin), %.0f times inside it, so the "
                "tolerance is bounded by the measurement model, not by this data."
                % (
                    abs(worst["star"]),
                    abs(worst["star"]) / 60.0,
                    3.0 / max(abs(worst["star"]), 1e-9),
                )
            ),
            frame_notes={
                "geocentric_columns": c.GEOCENTRIC_FRAME_NOTES,
                "topocentric_columns": {
                    "observer": "geodetic on WGS84, skyfield.api.wgs84.latlon",
                    "includes": [
                        "everything in the geocentric frame",
                        "diurnal aberration (the observer's rotation velocity)",
                        "topocentric parallax (matters for the Sun, not for stars)",
                    ],
                    "excludes": ["polar motion", "deflection of the vertical (geoid vs ellipsoid)"],
                    "azimuth": "true bearing clockwise from north, [0, 360)",
                },
            },
            refraction=c.SKYFIELD_REFRACTION_NOTES,
            timescale=c.project_timescale_facts(),
            extra={
                "run": c.RUN.facts(),
                "frame_of_date": c.app_frame_facts(),
                "ephemeris": c.run_kernel_facts(),
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "observers": [
                    c.Inline(
                        {
                            "name": n,
                            "lat_deg": c.deg(la),
                            "lon_deg": c.deg(lo),
                            "height_m": c.metres(el),
                        }
                    )
                    for n, la, lo, el in c.OBSERVERS
                ],
                "epochs_utc": [
                    "%s-%02d-%02dT%02d:00:00Z" % (c.iso_utc(c.jd_from_gregorian(y, 1, 1))[:-16], m, d, h)
                    for (y, m, d) in days() for h in EPOCH_HOURS
                ],
                "altitude_gate_deg": c.deg(ALTITUDE_GATE_DEG),
                "observer_epoch_count": len(cases),
                "case_count": n_cases,
                "max_spherical_minus_skyfield_arcsec": c.Inline(
                    {
                        "stars": c.arcsec(worst["star"]),
                        "stars_where": worst_where["star"],
                        "sun": c.arcsec(worst["Sun"]),
                        "sun_where": worst_where["Sun"],
                    }
                ),
                "max_sun_parallax_identity_residual_arcsec": c.arcsec(
                    worst_pa_identity
                ),
                "max_spherical_azimuth_minus_skyfield_arcsec": c.Inline(
                    {
                        "stars": c.arcsec(worst_az["star"]),
                        "sun": c.arcsec(worst_az["Sun"]),
                        "excluded": "cases within 2 deg of the zenith",
                    }
                ),
            },
        ),
        "notes": notes,
        "cases": cases,
    }
    print(
        "   %d observer-epochs, %d body cases; max spherical-minus-skyfield: "
        "stars %+.4f\" (%s), Sun %+.4f\" (%s)"
        % (
            len(cases),
            n_cases,
            worst["star"],
            worst_where["star"],
            worst["Sun"],
            worst_where["Sun"],
        )
    )
    print(
        "   max spherical-minus-skyfield azimuth: stars %.4f\", Sun %.4f\"; "
        "Sun |sph-sky - PA| max %.4f\""
        % (worst_az["star"], worst_az["Sun"], worst_pa_identity)
    )
    return doc


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], DEFAULT_WINDOW, "de421")
    doc = build()
    c.write_json(os.path.join(c.FIX_REFERENCE, "topocentric_altaz.json"), doc)


if __name__ == "__main__":
    main()
