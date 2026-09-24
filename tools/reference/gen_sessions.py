"""The Philadelphia star sessions: the project's "first numerical slice".

Produces
    fixtures/sessions/reference-philadelphia-5star.json
    fixtures/sessions/reference-philadelphia-5star-geocentric.json
    fixtures/sessions/reference-philadelphia-2star.json
    fixtures/sessions/reference-philadelphia-1star.json
    fixtures/expected/reference-philadelphia-5star.truth.json
    fixtures/expected/reference-philadelphia-5star-geocentric.truth.json
    fixtures/expected/reference-philadelphia-2star.truth.json
    fixtures/expected/reference-philadelphia-1star.truth.json
    fixtures/expected/reference-philadelphia-5star.expected.json
    fixtures/expected/reference-philadelphia-5star-geocentric.expected.json
    fixtures/expected/reference-philadelphia-2star.expected.json
    fixtures/expected/reference-philadelphia-1star.expected.json

The observations carry `geocentric` directly, so no ephemeris provider is
exercised: this isolates the solver, which is the point of the slice.

Two 5-star sessions exist on purpose, and the difference between them is the
most useful number in this directory:

  * `reference-philadelphia-5star` uses Skyfield's topocentric apparent
    altitude without refraction -- what a perfect instrument in a vacuum would
    actually read. It carries diurnal aberration, which CONVENTIONS section 7
    deliberately excludes from the project's model, so solving it with the
    CONVENTIONS section 3 spherical model lands a measured distance from truth
    that has nothing to do with solver correctness.
  * `reference-philadelphia-5star-geocentric` uses the geocentric altitude
    implied by the supplied GHA/Dec under that same spherical model, so a
    correct solver recovers the truth to floating-point precision and any
    error at all is a solver bug.

Both are generated, both measured, and the expected files say which is which.
"""

from __future__ import annotations

import math
import os

from . import common as c

SESSION_UTC = "2026-10-01T01:30:00Z"
SESSION_TIME = (2026, 10, 1, 1, 30, 0)
ALTITUDE_FLOOR_DEG = 15.0

#: Chosen from the 18 navigational stars above 15 deg at this place and time,
#: for azimuth spread and for altitudes clear of both the low-altitude
#: refraction flag and the near-zenith azimuth singularity.
CHOSEN = ["Schedar", "Markab", "Altair", "Vega", "Kochab"]

#: Two of the five, for the ambiguity test.
TWO = ["Altair", "Vega"]

#: One of the five, for the underdetermined test.
ONE = ["Vega"]

#: Deliberately wrong by about 80 km, so a solver that leaks its initializer
#: into the answer is caught (BRIEF: "an assumed position used only as an
#: initializer must not silently become a probabilistic prior").
ASSUMED = (40.5, -74.5)

SIGMA_ARCMIN = 0.1
SEED = 0

TRUTH_LAT, TRUTH_LON, TRUTH_ELEV = c.PHILADELPHIA[1], c.PHILADELPHIA[2], c.PHILADELPHIA[3]


def survey():
    """Everything the four sessions need, computed once."""
    ts = c.load_timescale()
    eph = c.load_ephemeris()
    earth = eph["earth"]
    df = c.load_hipparcos_frame()
    stars, _rows, problems = c.build_stars(df)

    t = ts.utc(*SESSION_TIME)
    site = earth + c.topos(TRUTH_LAT, TRUTH_LON, TRUTH_ELEV)

    above = []
    data = {}
    for name in c.STAR_NAMES:
        app = site.at(t).observe(stars[name]).apparent()
        alt, az, _ = app.altaz()
        alt_deg = float(alt.degrees)
        gha, dec, _ra, _d = c.geocentric_of(earth, t, stars[name])
        hc, zn = c.spherical_altitude_azimuth_deg(TRUTH_LAT, TRUTH_LON, gha, dec)
        data[name] = {
            "alt_topocentric_unrefracted_deg": alt_deg,
            "alt_geocentric_spherical_deg": hc,
            "azimuth_skyfield_deg": float(az.degrees),
            "azimuth_spherical_deg": zn,
            "gha_deg": gha,
            "dec_deg": dec,
            "diff_arcsec": (hc - alt_deg) * 3600.0,
        }
        if alt_deg > ALTITUDE_FLOOR_DEG:
            above.append(name)
    return t, data, above, problems


def observation(idx, name, d, altitude_key, note):
    return {
        "id": "obs-%d" % idx,
        "body": name,
        "utc": SESSION_UTC,
        "altitude_deg": c.deg(d[altitude_key]),
        "altitude_kind": "observed_ho",
        "sigma_arcmin": c.arcmin(SIGMA_ARCMIN),
        "limb": "center",
        "horizon": None,
        "geocentric": c.Inline(
            {
                "gha_deg": c.deg(d["gha_deg"]),
                "dec_deg": c.deg(d["dec_deg"]),
                "semidiameter_arcmin": c.arcmin(0.0),
                "horizontal_parallax_arcmin": c.arcmin(0.0),
            }
        ),
        "notes": note,
    }


def session(name, title, bodies, data, altitude_key, notes):
    return {
        "schema": "skyfix.session/1",
        "meta": {"name": title, "notes": notes, "kind": "simulated"},
        "observer": {
            "height_of_eye_m": c.metres(0.0),
            "pressure_hpa": c.Num(c.STANDARD_PRESSURE_HPA, 2),
            "temperature_c": c.Num(c.STANDARD_TEMPERATURE_C, 2),
            "assumed_position": c.Inline(
                {"lat_deg": c.deg(ASSUMED[0]), "lon_deg": c.deg(ASSUMED[1])}
            ),
            "assumed_position_role": c.Inline({"role": "initializer"}),
        },
        "instrument": {
            "name": "synthetic (no instrument)",
            "index_correction_arcmin": c.arcmin(0.0),
            "horizon": "sea",
        },
        "clock": {"uncertainty_s": c.secs(0.0), "correction_s": c.secs(0.0)},
        "observations": [
            observation(i + 1, b, data[b], altitude_key, OBS_NOTE[altitude_key])
            for i, b in enumerate(bodies)
        ],
    }


OBS_NOTE = {
    "alt_topocentric_unrefracted_deg": (
        "Synthetic, zero noise. Skyfield apparent topocentric altitude at the "
        "truth position with no refraction applied. Already a fully corrected Ho "
        "(altitude_kind observed_ho), so no correction step runs."
    ),
    "alt_geocentric_spherical_deg": (
        "Synthetic, zero noise. The geocentric altitude implied by this "
        "observation's own gha_deg/dec_deg under CONVENTIONS section 3 at the "
        "truth position. Exactly consistent with the supplied direction by "
        "construction. Already a fully corrected Ho (altitude_kind observed_ho)."
    ),
}


def truth(session_name, notes):
    return {
        "schema": "skyfix.truth/1",
        "session_name": session_name,
        "position": c.Inline(
            {"lat_deg": c.deg(TRUTH_LAT), "lon_deg": c.deg(TRUTH_LON)}
        ),
        "seed": SEED,
        "clock_offset_s": c.secs(0.0),
        "shared_altitude_bias_arcmin": c.arcmin(0.0),
        "wrong_sight_ids": [],
        "notes": notes,
    }


def apriori_sigma_m(bodies, data, sigma_arcmin=SIGMA_ARCMIN):
    """A priori (north, east) 1-sigma from CONVENTIONS section 9, metres.

    Cov = (J^T W J)^-1 with J rows (cos Zn, sin Zn) and W = diag(1/sigma^2),
    in tangent-plane radians, scaled to metres by the section 1 sphere radius.
    """
    sig = math.radians(sigma_arcmin / 60.0)
    a = b = d = 0.0
    for body in bodies:
        z = math.radians(data[body]["azimuth_spherical_deg"])
        cz, sz = math.cos(z), math.sin(z)
        a += cz * cz / sig**2
        b += cz * sz / sig**2
        d += sz * sz / sig**2
    det = a * d - b * b
    return (
        math.sqrt(d / det) * c.EARTH_RADIUS_M,
        math.sqrt(a / det) * c.EARTH_RADIUS_M,
    )


def least_squares_fix(bodies, data, altitude_key, start=ASSUMED, max_iter=80):
    """Solve the session in Python, independently of any Rust code.

    Weighted Gauss-Newton in the tangent plane, re-linearised with the exact
    spherical model each step -- CONVENTIONS section 8 without the damping,
    which noiseless data does not need. Returns (lat, lon, iterations, residuals).
    """
    phi, lam = start
    it = 0
    for it in range(1, max_iter + 1):
        jt_j = [[0.0, 0.0], [0.0, 0.0]]
        jt_r = [0.0, 0.0]
        for b in bodies:
            d = data[b]
            h, z = c.spherical_altitude_azimuth_deg(phi, lam, d["gha_deg"], d["dec_deg"])
            r = math.radians(d[altitude_key] - h)
            zr = math.radians(z)
            j = (math.cos(zr), math.sin(zr))
            for a in range(2):
                jt_r[a] += j[a] * r
                for bb in range(2):
                    jt_j[a][bb] += j[a] * j[bb]
        det = jt_j[0][0] * jt_j[1][1] - jt_j[0][1] * jt_j[1][0]
        if abs(det) < 1e-18:
            break
        dn = (jt_j[1][1] * jt_r[0] - jt_j[0][1] * jt_r[1]) / det
        de = (-jt_j[1][0] * jt_r[0] + jt_j[0][0] * jt_r[1]) / det
        phi += math.degrees(dn)
        lam += math.degrees(de / math.cos(math.radians(phi)))
        if math.hypot(dn, de) < 1e-13:
            break
    residuals = []
    for b in bodies:
        d = data[b]
        h, z = c.spherical_altitude_azimuth_deg(phi, lam, d["gha_deg"], d["dec_deg"])
        residuals.append((b, (d[altitude_key] - h) * 60.0, h, z))
    return phi, lam, it, residuals


def expected_doc(
    session_name, bodies, data, altitude_key, extra_notes, extra=None, solve=True
):
    body_rows = []
    for i, b in enumerate(bodies):
        d = data[b]
        gp_lat, gp_lon = c.gp_of(d["gha_deg"], d["dec_deg"])
        body_rows.append(
            {
                "id": "obs-%d" % (i + 1),
                "body": b,
                "ho_deg": c.deg(d[altitude_key]),
                "gha_deg": c.deg(d["gha_deg"]),
                "dec_deg": c.deg(d["dec_deg"]),
                "gp_lat_deg": c.deg(gp_lat),
                "gp_lon_deg": c.deg(gp_lon),
                "zenith_distance_deg": c.deg(90.0 - d[altitude_key]),
                "hc_at_truth_deg": c.deg(d["alt_geocentric_spherical_deg"]),
                "zn_at_truth_deg": c.deg(d["azimuth_spherical_deg"]),
                "intercept_at_truth_arcmin": c.arcmin(
                    (d[altitude_key] - d["alt_geocentric_spherical_deg"]) * 60.0
                ),
                "skyfield_topocentric_unrefracted_deg": c.deg(
                    d["alt_topocentric_unrefracted_deg"]
                ),
                "skyfield_azimuth_deg": c.deg(d["azimuth_skyfield_deg"]),
                "spherical_minus_skyfield_arcsec": c.arcsec(d["diff_arcsec"]),
            }
        )

    doc = {
        "schema": "skyfix.expected/1",
        "name": session_name,
        "session": "fixtures/sessions/%s.json" % session_name,
        "truth": "fixtures/expected/%s.truth.json" % session_name,
        "generator": c.generator_block(
            tool="tools/reference/gen_sessions.py",
            description="Expected reduction and fix for %s." % session_name,
            tolerance_arcmin=c.arcmin(SIGMA_ARCMIN),
            tolerance_justification=(
                "The per-sight tolerance is the session's own sigma, 0.1 arcmin. "
                "The position tolerance is 10 m (see position_tolerance_m) and is "
                "a numerical regression target on clean, well-conditioned "
                "synthetic geometry, exactly as docs/BRIEF.md 'Validation that "
                "matters' states. It is NOT a claim about field accuracy: no real "
                "sextant, horizon or clock is involved anywhere in this file."
            ),
            frame_notes=c.GEOCENTRIC_FRAME_NOTES,
            refraction=(
                "none. Every altitude here is already Ho (altitude_kind "
                "observed_ho), so the CONVENTIONS section 5 chain runs no steps."
            ),
            extra={
                "ephemeris": c.file_facts(c.EPHEMERIS_FILE, c.EPHEMERIS_URL),
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "position_tolerance_m": c.metres(10.0),
                "observation_count": len(bodies),
            },
        ),
        "expected_fix": c.Inline(
            {"lat_deg": c.deg(TRUTH_LAT), "lon_deg": c.deg(TRUTH_LON)}
        ),
        "position_tolerance_m": c.metres(10.0),
        "observations": body_rows,
        "notes": extra_notes,
    }
    if solve:
        phi, lam, iters, residuals = least_squares_fix(bodies, data, altitude_key)
        dn, de = c.ne_offset_m(TRUTH_LAT, TRUTH_LON, phi, lam)
        doc["independent_python_solution"] = {
            "method": (
                "Gauss-Newton in the tangent plane, re-linearised with the exact "
                "CONVENTIONS section 3 spherical model each iteration, started "
                "from the session's assumed position. Written in Python in "
                "tools/reference/gen_sessions.py, never derived from Rust."
            ),
            "start": c.Inline(
                {"lat_deg": c.deg(ASSUMED[0]), "lon_deg": c.deg(ASSUMED[1])}
            ),
            "iterations": iters,
            "position": c.Inline({"lat_deg": c.deg(phi), "lon_deg": c.deg(lam)}),
            "offset_from_truth": c.Inline(
                {
                    "north_m": c.metres(dn),
                    "east_m": c.metres(de),
                    "distance_m": c.metres(math.hypot(dn, de)),
                }
            ),
            "residuals_at_solution_arcmin": [
                c.Inline(
                    {
                        "id": "obs-%d" % (i + 1),
                        "body": b,
                        "residual_arcmin": c.arcmin(r),
                        "hc_deg": c.deg(h),
                        "zn_deg": c.deg(z),
                    }
                )
                for i, (b, r, h, z) in enumerate(residuals)
            ],
        }
    if extra:
        doc.update(extra)
    return doc


def main():
    t, data, above, problems = survey()
    print(
        "   %d navigational stars above %.0f deg at Philadelphia %s"
        % (len(above), ALTITUDE_FLOOR_DEG, SESSION_UTC)
    )
    for b in sorted(above, key=lambda n: data[n]["azimuth_skyfield_deg"]):
        mark = " <-- chosen" if b in CHOSEN else ""
        print(
            "     %-18s alt %6.2f  az %7.2f%s"
            % (b, data[b]["alt_topocentric_unrefracted_deg"], data[b]["azimuth_skyfield_deg"], mark)
        )
    assert len(above) >= 5, "fewer than five stars above the floor"
    for b in CHOSEN:
        assert b in above, b

    azs = sorted(data[b]["azimuth_spherical_deg"] for b in CHOSEN)
    gaps = [azs[(i + 1) % len(azs)] - azs[i] for i in range(len(azs) - 1)]
    gaps.append(azs[0] + 360.0 - azs[-1])
    max_gap = max(gaps)

    selection_note = (
        "At %s, %d of the 58 navigational stars are above %.0f deg at the truth "
        "position. The five used here were chosen for azimuth spread (largest "
        "gap %.1f deg) with every altitude between %.1f and %.1f deg, clear of "
        "both the CONVENTIONS section 5 low-altitude refraction flag at 10 deg "
        "and the near-zenith azimuth singularity. Full list of candidates, "
        "sorted by azimuth: %s."
        % (
            SESSION_UTC,
            len(above),
            ALTITUDE_FLOOR_DEG,
            max_gap,
            min(data[b]["alt_topocentric_unrefracted_deg"] for b in CHOSEN),
            max(data[b]["alt_topocentric_unrefracted_deg"] for b in CHOSEN),
            "; ".join(
                "%s (alt %.2f, az %.2f)"
                % (b, data[b]["alt_topocentric_unrefracted_deg"], data[b]["azimuth_skyfield_deg"])
                for b in sorted(above, key=lambda n: data[n]["azimuth_skyfield_deg"])
            ),
        )
    )

    common_notes = [
        selection_note,
        "Every observation supplies `geocentric` directly, so no ephemeris "
        "provider runs and the session tests the solver alone (docs/BRIEF.md, "
        "'First numerical slice'). The reducer must emit "
        "Warning::SuppliedDirectionUsed for each sight.",
        "`altitude_kind` is `observed_ho`: the CONVENTIONS section 5 chain must "
        "run no steps at all. Index correction, height of eye, semidiameter and "
        "horizontal parallax are all zero, so nothing has to be ignored and no "
        "AlreadyCorrected warning is warranted -- but re-reducing must still be "
        "a no-op, never a second subtraction.",
        "The assumed position (%.4f, %.4f) is deliberately about %.0f km from "
        "the truth, with role `initializer`. A converged fix must be independent "
        "of it. If the reported position moves toward the assumed position, the "
        "initializer has leaked in as a prior."
        % (
            ASSUMED[0],
            ASSUMED[1],
            c.great_circle_m(TRUTH_LAT, TRUTH_LON, *ASSUMED) / 1000.0,
        ),
        "`gha_deg` here is Skyfield's, computed with its own UT1 (DUT1 = "
        "%+.4f s at this instant). That does not matter for this session, "
        "because the direction is supplied rather than computed: the altitudes "
        "were generated from these same GHA values, so the session is "
        "internally consistent whatever an ephemeris provider would have said. "
        "A session that omitted `geocentric` would expose the CONVENTIONS "
        "section 6 DUT1 = 0 assumption; this one does not."
        % float(t.dut1),
        "kind is `simulated` and there is zero added noise. The truth lives in "
        "fixtures/expected/<name>.truth.json and must never be read by the "
        "solver or by the CLI `solve` command.",
    ]
    if problems:
        common_notes.append("STAR IDENTITY DOUBTS: " + " | ".join(problems))

    # -- the two five-star sessions -----------------------------------------
    variants = [
        (
            "reference-philadelphia-5star",
            "Philadelphia five-star (topocentric synthetic)",
            "alt_topocentric_unrefracted_deg",
        ),
        (
            "reference-philadelphia-5star-geocentric",
            "Philadelphia five-star (geocentric, model-exact)",
            "alt_geocentric_spherical_deg",
        ),
    ]
    solved = {}
    for sname, title, key in variants:
        phi, lam, iters, _res = least_squares_fix(CHOSEN, data, key)
        dn, de = c.ne_offset_m(TRUTH_LAT, TRUTH_LON, phi, lam)
        solved[sname] = math.hypot(dn, de)
        print(
            "   %-42s independent Python fix is %.3f m from truth "
            "(dN %+.3f, dE %+.3f) after %d iterations"
            % (sname, math.hypot(dn, de), dn, de, iters)
        )

    mismatch_note = (
        "THE DIFFERENCE BETWEEN THE TWO FIVE-STAR SESSIONS. "
        "`reference-philadelphia-5star` uses Skyfield's topocentric apparent "
        "altitude without refraction. That altitude includes diurnal aberration, "
        "which CONVENTIONS section 7 deliberately leaves out of the project's "
        "geocentric model, so the altitudes and the supplied directions are "
        "inconsistent by up to %.3f arcsec here. Solved with the CONVENTIONS "
        "section 3 model, it recovers the truth to %.2f m -- inside the 10 m "
        "regression target, but %.0f %% of the budget is spent on a known model "
        "mismatch rather than on solver error. "
        "`reference-philadelphia-5star-geocentric` uses the geocentric altitude "
        "implied by the same supplied directions, recovers the truth to %.3f m, "
        "and is therefore the file to regress the solver against: any error at "
        "all in it is a solver error. Use the topocentric one to show that a "
        "physically realistic synthetic sight still lands inside 10 m."
        % (
            max(abs(data[b]["diff_arcsec"]) for b in CHOSEN),
            solved["reference-philadelphia-5star"],
            100.0 * solved["reference-philadelphia-5star"] / 10.0,
            solved["reference-philadelphia-5star-geocentric"],
        )
    )

    for sname, title, key in variants:
        c.write_json(
            os.path.join(c.FIX_SESSIONS, "%s.json" % sname),
            session(sname, title, CHOSEN, data, key, "; ".join(CHOSEN)),
        )
        c.write_json(
            os.path.join(c.FIX_EXPECTED, "%s.truth.json" % sname),
            truth(
                sname,
                "Philadelphia City Hall. Synthetic, zero noise, no clock offset "
                "and no shared bias, so `seed` is unused and recorded as 0. "
                "Height above the WGS84 ellipsoid 10 m, which affects nothing "
                "for stars.",
            ),
        )
        c.write_json(
            os.path.join(c.FIX_EXPECTED, "%s.expected.json" % sname),
            expected_doc(
                sname,
                CHOSEN,
                data,
                key,
                common_notes
                + [
                    mismatch_note,
                    "Expected result kind: `unique`. Five sights, two unknowns, "
                    "dof = 3. With zero noise every residual is zero to "
                    "floating-point precision in the geocentric variant; in the "
                    "topocentric variant the residuals are the diurnal "
                    "aberration, a fraction of an arcsecond.",
                    "Largest azimuth gap %.1f deg, so the geometry is "
                    "well-conditioned and a 95 %% ellipse is justified. With "
                    "sigma = %.1f arcmin on these five azimuths the CONVENTIONS "
                    "section 9 a priori covariance gives sigma_north = %.1f m "
                    "and sigma_east = %.1f m. Note that this is an order of "
                    "magnitude LARGER than the 10 m regression target, and that "
                    "is deliberate: the target tests arithmetic on noiseless "
                    "data, the ellipse describes noise this fixture does not "
                    "contain. A solver that reports a 10 m ellipse here is "
                    "wrong even though its position is right."
                    % ((max_gap, SIGMA_ARCMIN) + apriori_sigma_m(CHOSEN, data)),
                ],
            ),
        )

    # -- two-sight ambiguity -------------------------------------------------
    key = "alt_topocentric_unrefracted_deg"
    gp1 = c.gp_of(data[TWO[0]]["gha_deg"], data[TWO[0]]["dec_deg"])
    gp2 = c.gp_of(data[TWO[1]]["gha_deg"], data[TWO[1]]["dec_deg"])
    z1 = 90.0 - data[TWO[0]][key]
    z2 = 90.0 - data[TWO[1]][key]
    inter = c.two_circle_intersections(gp1, z1, gp2, z2)
    inter.sort(key=lambda p: c.great_circle_m(TRUTH_LAT, TRUTH_LON, p[0], p[1]))
    near, far = inter[0], inter[1]
    near_m = c.great_circle_m(TRUTH_LAT, TRUTH_LON, *near)
    sep_m = c.great_circle_m(near[0], near[1], far[0], far[1])
    print(
        "   two-sight intersections: %.6f %.6f (%.2f m from truth) and "
        "%.6f %.6f (%.0f km away)"
        % (near[0], near[1], near_m, far[0], far[1], sep_m / 1000.0)
    )

    c.write_json(
        os.path.join(c.FIX_SESSIONS, "reference-philadelphia-2star.json"),
        session(
            "reference-philadelphia-2star",
            "Philadelphia two-star (ambiguous)",
            TWO,
            data,
            key,
            "Two of the five sights of reference-philadelphia-5star, unchanged.",
        ),
    )
    c.write_json(
        os.path.join(c.FIX_EXPECTED, "reference-philadelphia-2star.truth.json"),
        truth(
            "reference-philadelphia-2star",
            "Philadelphia City Hall. The same two sights as in the five-star "
            "session. Two circles of position intersect twice; the truth is one "
            "of the two intersections and nothing in the data distinguishes it "
            "from the other.",
        ),
    )
    c.write_json(
        os.path.join(c.FIX_EXPECTED, "reference-philadelphia-2star.expected.json"),
        expected_doc(
            "reference-philadelphia-2star",
            TWO,
            data,
            key,
            common_notes
            + [
                "Expected result kind: `ambiguous`. Two sights and two unknowns: "
                "dof = 0, both intersections fit exactly, and neither may be "
                "promoted. CONVENTIONS section 8 requires all candidates "
                "returned and no ellipse (dof = 0 cannot support one).",
                "The two intersections are %.0f km apart. Both are listed in "
                "`circle_intersections`, computed analytically in Python from "
                "the two circles of position, independently of the solver. The "
                "solver's multistart must find both; finding only the one near "
                "the initializer is the failure this fixture exists to catch, "
                "and the assumed position is deliberately near the truth-side "
                "intersection to make that failure look like success."
                % (sep_m / 1000.0),
                "Both sights are in the western half of the sky (azimuths %.1f "
                "and %.1f deg, %.1f deg apart), which is also why the geometry "
                "is poor: a wide azimuth gap is what makes the second "
                "intersection close enough to matter."
                % (
                    data[TWO[0]]["azimuth_spherical_deg"],
                    data[TWO[1]]["azimuth_spherical_deg"],
                    abs(
                        c.wrap_diff_deg(
                            data[TWO[0]]["azimuth_spherical_deg"],
                            data[TWO[1]]["azimuth_spherical_deg"],
                        )
                    ),
                ),
            ],
            extra={
                "expected_result_kind": "ambiguous",
                "circle_intersections": [
                    c.Inline(
                        {
                            "lat_deg": c.deg(p[0]),
                            "lon_deg": c.deg(p[1]),
                            "distance_from_truth_m": c.metres(
                                c.great_circle_m(TRUTH_LAT, TRUTH_LON, p[0], p[1])
                            ),
                        }
                    )
                    for p in (near, far)
                ],
                "intersection_separation_m": c.metres(sep_m),
            },
            solve=False,
        ),
    )

    # -- one sight -----------------------------------------------------------
    c.write_json(
        os.path.join(c.FIX_SESSIONS, "reference-philadelphia-1star.json"),
        session(
            "reference-philadelphia-1star",
            "Philadelphia one-star (underdetermined)",
            ONE,
            data,
            key,
            "One of the five sights of reference-philadelphia-5star, unchanged.",
        ),
    )
    c.write_json(
        os.path.join(c.FIX_EXPECTED, "reference-philadelphia-1star.truth.json"),
        truth(
            "reference-philadelphia-1star",
            "Philadelphia City Hall. One altitude constrains position to a "
            "circle and nothing more; the truth is a point on that circle and "
            "the data cannot say which one.",
        ),
    )
    d1 = data[ONE[0]]
    gp_lat, gp_lon = c.gp_of(d1["gha_deg"], d1["dec_deg"])
    c.write_json(
        os.path.join(c.FIX_EXPECTED, "reference-philadelphia-1star.expected.json"),
        expected_doc(
            "reference-philadelphia-1star",
            ONE,
            data,
            key,
            common_notes
            + [
                "Expected result kind: `underdetermined`. One sight cannot give a "
                "position (docs/BRIEF.md non-negotiable 1). CONVENTIONS section 8 "
                "requires the circle of position to be returned and no point, no "
                "covariance and no ellipse. Returning the assumed position, or "
                "any point at all, is the failure this fixture exists to catch.",
                "The circle of position has its centre at the body's geographic "
                "position (%.6f, %.6f) and angular radius %.6f deg = %.1f NM. "
                "The truth lies on it: its great-circle distance from the GP is "
                "%.6f deg, which differs from the zenith distance by %.4f arcsec."
                % (
                    gp_lat,
                    gp_lon,
                    90.0 - d1[key],
                    (90.0 - d1[key]) * 60.0,
                    c.great_circle_m(TRUTH_LAT, TRUTH_LON, gp_lat, gp_lon)
                    / c.EARTH_RADIUS_M
                    * 180.0
                    / math.pi,
                    (
                        c.great_circle_m(TRUTH_LAT, TRUTH_LON, gp_lat, gp_lon)
                        / c.EARTH_RADIUS_M
                        * 180.0
                        / math.pi
                        - (90.0 - d1[key])
                    )
                    * 3600.0,
                ),
            ],
            extra={
                "expected_result_kind": "underdetermined",
                "circle_of_position": c.Inline(
                    {
                        "body": ONE[0],
                        "gp_lat_deg": c.deg(gp_lat),
                        "gp_lon_deg": c.deg(gp_lon),
                        "zenith_distance_deg": c.deg(90.0 - d1[key]),
                        "radius_nm": c.Num((90.0 - d1[key]) * 60.0, 4),
                    }
                ),
            },
            solve=False,
        ),
    )


if __name__ == "__main__":
    main()
