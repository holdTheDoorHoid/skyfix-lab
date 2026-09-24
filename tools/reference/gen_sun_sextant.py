"""fixtures/sessions/reference-sun-sextant.json and its truth/expected files.

A synthetic Sun lower-limb sight sequence: five sights spread over an hour
around local apparent noon at Philadelphia on 2026-10-01, given as RAW sextant
altitudes (`altitude_kind: sextant_hs`) with a sea horizon, height of eye 3 m
and index correction -1.5 arcmin.

The whole point is the reversal. The CONVENTIONS section 5 chain is run
BACKWARDS in Python from a known Ho to the Hs that must produce it, using the
project's own formulas coded from the text of CONVENTIONS.md (never from Rust),
so that running the Rust chain forwards on `altitude_deg` has to land back on
`expected.observations[].ho_deg`. Every reversed step is written out in the
expected file, so a failure says which step is wrong rather than just that the
answer is wrong.

Skyfield's own refraction is deliberately NOT used here. Skyfield implements
the same Bennett formula but with a constant of 0.016667 deg (1.00002 arcmin)
and a scale factor 0.28*P/(T+273) which is 0.999293 of the CONVENTIONS factor
at standard conditions. Mixing the two would put a 0.07 % refraction error into
a fixture whose job is to test the chain to 0.02 arcmin.
"""

from __future__ import annotations

import math
import os

from . import common as c

DATE = (2026, 10, 1)
OFFSET_MINUTES = [-30, -15, 0, 15, 30]
SIGHT_UTC = [
    "2026-10-01T16:20:00Z",
    "2026-10-01T16:35:00Z",
    "2026-10-01T16:50:00Z",
    "2026-10-01T17:05:00Z",
    "2026-10-01T17:20:00Z",
]
SIGHT_TIME = [(16, 20), (16, 35), (16, 50), (17, 5), (17, 20)]

HEIGHT_OF_EYE_M = 3.0
INDEX_CORRECTION_ARCMIN = -1.5
LIMB = "lower"
SIGMA_ARCMIN = 0.2
SEED = 0

TRUTH_LAT, TRUTH_LON, TRUTH_ELEV = c.PHILADELPHIA[1], c.PHILADELPHIA[2], c.PHILADELPHIA[3]
ASSUMED = (40.5, -74.5)

SESSION_NAME = "reference-sun-sextant"


def build():
    ts = c.load_timescale()
    eph = c.load_ephemeris()
    earth, sun = eph["earth"], eph["sun"]
    site = earth + c.topos(TRUTH_LAT, TRUTH_LON, TRUTH_ELEV)

    sights = []
    worst_roundtrip = 0.0
    for i, (hh, mm) in enumerate(SIGHT_TIME):
        t = ts.utc(DATE[0], DATE[1], DATE[2], hh, mm, 0)
        gha, dec, _ra, dist = c.geocentric_of(earth, t, sun)
        sd, hp = c.sun_disc(dist)

        # Ho is GEOCENTRIC by CONVENTIONS section 7: the altitude of the Sun's
        # centre seen from the Earth's centre, which is what the section 3
        # spherical formula predicts from gha/dec. The topocentric altitude
        # Skyfield reports is lower by the parallax; that is exactly what
        # section 5 step 5 adds back, and both numbers are recorded so the
        # identity can be checked.
        ho, zn = c.spherical_altitude_azimuth_deg(TRUTH_LAT, TRUTH_LON, gha, dec)
        app = site.at(t).observe(sun).apparent()
        alt_topo, az_sky, _ = app.altaz()
        alt_topo = float(alt_topo.degrees)

        rev = c.hs_from_ho(
            ho_deg=ho,
            index_correction_arcmin=INDEX_CORRECTION_ARCMIN,
            height_of_eye_m=HEIGHT_OF_EYE_M,
            semidiameter_arcmin=sd,
            horizontal_parallax_arcmin=hp,
            limb=LIMB,
        )
        fwd = c.ho_from_hs(
            hs_deg=rev["hs_deg"],
            index_correction_arcmin=INDEX_CORRECTION_ARCMIN,
            height_of_eye_m=HEIGHT_OF_EYE_M,
            semidiameter_arcmin=sd,
            horizontal_parallax_arcmin=hp,
            limb=LIMB,
        )
        rt = abs(fwd["ho_deg"] - ho) * 60.0
        worst_roundtrip = max(worst_roundtrip, rt)

        sights.append(
            {
                "index": i,
                "id": "obs-%d" % (i + 1),
                "utc": SIGHT_UTC[i],
                "gha_deg": gha,
                "dec_deg": dec,
                "distance_au": dist,
                "semidiameter_arcmin": sd,
                "horizontal_parallax_arcmin": hp,
                "ho_deg": ho,
                "zn_deg": zn,
                "alt_topocentric_unrefracted_deg": alt_topo,
                "azimuth_skyfield_deg": float(az_sky.degrees),
                "rev": rev,
                "fwd": fwd,
                "roundtrip_arcmin": rt,
            }
        )
    return sights, worst_roundtrip


def session(sights):
    return {
        "schema": "skyfix.session/1",
        "meta": {
            "name": "Philadelphia Sun lower-limb sequence (raw sextant)",
            "notes": (
                "Five synthetic lower-limb Sun sights over an hour around local "
                "apparent noon (Sun transit 2026-10-01T16:50:15Z) at "
                "Philadelphia City Hall. Zero noise. Given as RAW sextant "
                "readings so the whole CONVENTIONS section 5 chain has to run: "
                "index correction, dip, refraction, semidiameter and parallax. "
                "The azimuth spread is only about 22 deg by design, so this "
                "sequence is a correction-chain fixture and a deliberately "
                "ill-conditioned-geometry demo, NOT a good fix."
            ),
            "kind": "simulated",
        },
        "observer": {
            "height_of_eye_m": c.metres(HEIGHT_OF_EYE_M),
            "pressure_hpa": c.Num(c.STANDARD_PRESSURE_HPA, 2),
            "temperature_c": c.Num(c.STANDARD_TEMPERATURE_C, 2),
            "assumed_position": c.Inline(
                {"lat_deg": c.deg(ASSUMED[0]), "lon_deg": c.deg(ASSUMED[1])}
            ),
            "assumed_position_role": c.Inline({"role": "initializer"}),
        },
        "instrument": {
            "name": "synthetic sextant, index error 1.5' on the arc",
            "index_correction_arcmin": c.arcmin(INDEX_CORRECTION_ARCMIN),
            "horizon": "sea",
        },
        "clock": {"uncertainty_s": c.secs(0.0), "correction_s": c.secs(0.0)},
        "observations": [
            {
                "id": s["id"],
                "body": "Sun",
                "utc": s["utc"],
                "altitude_deg": c.deg(s["rev"]["hs_deg"]),
                "altitude_kind": "sextant_hs",
                "sigma_arcmin": c.arcmin(SIGMA_ARCMIN),
                "limb": LIMB,
                "horizon": None,
                "geocentric": c.Inline(
                    {
                        "gha_deg": c.deg(s["gha_deg"]),
                        "dec_deg": c.deg(s["dec_deg"]),
                        "semidiameter_arcmin": c.arcmin(s["semidiameter_arcmin"]),
                        "horizontal_parallax_arcmin": c.arcmin(
                            s["horizontal_parallax_arcmin"]
                        ),
                    }
                ),
                "notes": (
                    "Synthetic, zero noise. Raw sextant reading produced by "
                    "running the CONVENTIONS section 5 chain backwards from the "
                    "geocentric Ho; see the expected file for every reversed step."
                ),
            }
            for s in sights
        ],
    }


def truth():
    return {
        "schema": "skyfix.truth/1",
        "session_name": SESSION_NAME,
        "position": c.Inline(
            {"lat_deg": c.deg(TRUTH_LAT), "lon_deg": c.deg(TRUTH_LON)}
        ),
        "seed": SEED,
        "clock_offset_s": c.secs(0.0),
        "shared_altitude_bias_arcmin": c.arcmin(0.0),
        "wrong_sight_ids": [],
        "notes": (
            "Philadelphia City Hall. Synthetic, zero noise, no clock offset and "
            "no shared bias, so `seed` is unused and recorded as 0. A Sun-only "
            "sequence over one hour around local noon cannot produce a good fix: "
            "the azimuths span about 22 deg, so latitude is well determined and "
            "longitude is not. The file exists to test the correction chain and "
            "to demonstrate poor geometry honestly, not to recover this position "
            "accurately."
        ),
    }


def expected(sights, worst_roundtrip):
    rows = []
    for s in sights:
        rev = s["rev"]
        gp_lat, gp_lon = c.gp_of(s["gha_deg"], s["dec_deg"])
        rows.append(
            {
                "id": s["id"],
                "body": "Sun",
                "utc": s["utc"],
                "limb": LIMB,
                "sextant_hs_deg": c.deg(rev["hs_deg"]),
                "index_correction_arcmin": c.arcmin(INDEX_CORRECTION_ARCMIN),
                "after_index_correction_deg": c.deg(
                    rev["hs_deg"] + INDEX_CORRECTION_ARCMIN / 60.0
                ),
                "dip_arcmin": c.arcmin(rev["dip_arcmin"]),
                "apparent_ha_deg": c.deg(rev["ha_deg"]),
                "refraction_arcmin": c.arcmin(rev["refraction_arcmin"]),
                "semidiameter_arcmin": c.arcmin(s["semidiameter_arcmin"]),
                "semidiameter_applied_arcmin": c.arcmin(
                    rev["semidiameter_applied_arcmin"]
                ),
                "horizontal_parallax_arcmin": c.arcmin(
                    s["horizontal_parallax_arcmin"]
                ),
                "parallax_in_altitude_arcmin": c.arcmin(
                    rev["parallax_in_altitude_arcmin"]
                ),
                "observed_ho_deg": c.deg(s["ho_deg"]),
                "total_correction_arcmin": c.arcmin(
                    (s["ho_deg"] - rev["hs_deg"]) * 60.0
                ),
                "forward_chain_ho_deg": c.deg(s["fwd"]["ho_deg"]),
                "forward_minus_target_arcmin": c.arcmin(s["roundtrip_arcmin"]),
                "gha_deg": c.deg(s["gha_deg"]),
                "dec_deg": c.deg(s["dec_deg"]),
                "gp_lat_deg": c.deg(gp_lat),
                "gp_lon_deg": c.deg(gp_lon),
                "zenith_distance_deg": c.deg(90.0 - s["ho_deg"]),
                "hc_at_truth_deg": c.deg(s["ho_deg"]),
                "zn_at_truth_deg": c.deg(s["zn_deg"]),
                "skyfield_topocentric_unrefracted_deg": c.deg(
                    s["alt_topocentric_unrefracted_deg"]
                ),
                "ho_minus_skyfield_topocentric_arcsec": c.arcsec(
                    (s["ho_deg"] - s["alt_topocentric_unrefracted_deg"]) * 3600.0
                ),
                "skyfield_azimuth_deg": c.deg(s["azimuth_skyfield_deg"]),
            }
        )

    reversal = [
        "Step 0 -- the target. Ho is the GEOCENTRIC apparent altitude of the "
        "Sun's CENTRE, computed with the CONVENTIONS section 3 spherical formula "
        "from this sight's own gha_deg/dec_deg at the truth position. This is "
        "what Ho means in CONVENTIONS section 7, and it is why step 5 of the "
        "chain exists: `parallax_in_altitude` is precisely the difference "
        "between the topocentric altitude an observer measures and the "
        "geocentric altitude the almanac's GHA/Dec predicts. Each row records "
        "`skyfield_topocentric_unrefracted_deg` and "
        "`ho_minus_skyfield_topocentric_arcsec` so that identity is visible: "
        "the difference is PA, about %.2f arcsec at this altitude."
        % (sights[0]["rev"]["parallax_in_altitude_arcmin"] * 60.0),
        "Step 1 reversed -- parallax and semidiameter. Forward, section 5 gives "
        "Ho = Ha - R(Ha) + SD + HP*cos(Ha) for a lower limb. Reversed, "
        "Ha = Ho + R(Ha) - SD - HP*cos(Ha). R and PA both depend on Ha, so this "
        "is solved by fixed-point iteration to 1e-13 deg (about 4e-7 arcmin), "
        "which converges in a handful of steps at these altitudes. "
        "tools/reference/common.py:hs_from_ho.",
        "Step 2 reversed -- refraction. R' = cot(Ha + 7.31/(Ha + 4.4)) arcmin "
        "scaled by (P/1010)*(283/(273+T)), evaluated at the APPARENT altitude "
        "Ha, exactly as CONVENTIONS section 5 step 3 writes it and exactly as "
        "Bennett defined it. P = %.1f hPa, T = %.1f C, so the scale factor is "
        "1.000000 and the refraction here is about %.4f arcmin. Skyfield's own "
        "refraction is NOT used in this file: it implements the same formula "
        "with a constant of 0.016667 deg (1.00002 arcmin) and a scale factor "
        "0.28*P/(T+273) = 0.999293 of the CONVENTIONS factor at standard "
        "conditions, a 0.07 %% difference that would be 70 %% of this file's "
        "0.02 arcmin budget if it were mixed in."
        % (
            c.STANDARD_PRESSURE_HPA,
            c.STANDARD_TEMPERATURE_C,
            sights[0]["rev"]["refraction_arcmin"],
        ),
        "Step 3 reversed -- the horizon step. Sea horizon, so dip = 1.76' * "
        "sqrt(height_of_eye_m) = 1.76 * sqrt(%.1f) = %.4f arcmin, and it is "
        "ADDED back: Hs + IC = Ha + dip. No halving, because this is not an "
        "artificial horizon."
        % (HEIGHT_OF_EYE_M, sights[0]["rev"]["dip_arcmin"]),
        "Step 4 reversed -- index correction. IC is signed and ADDED forwards, "
        "so it is SUBTRACTED backwards: Hs = (Ha + dip) - IC. Here IC = %+.1f "
        "arcmin, which per CONVENTIONS section 5 step 1 means an index error of "
        "%.1f arcmin ON THE ARC: the instrument reads %.1f arcmin too high, so "
        "Hs ends up %.1f arcmin above (Ha + dip). Getting this sign backwards "
        "moves every Ho by %.1f arcmin, which is %.0f times this file's "
        "tolerance and %.0f m of position -- it is the single easiest sign to "
        "get wrong in the whole project, which is why the fixture uses a "
        "non-zero IC."
        % (
            INDEX_CORRECTION_ARCMIN,
            abs(INDEX_CORRECTION_ARCMIN),
            abs(INDEX_CORRECTION_ARCMIN),
            abs(INDEX_CORRECTION_ARCMIN),
            2 * abs(INDEX_CORRECTION_ARCMIN),
            2 * abs(INDEX_CORRECTION_ARCMIN) / 0.02,
            2 * abs(INDEX_CORRECTION_ARCMIN) * 1852.0,
        ),
        "Verification. Each row's `forward_chain_ho_deg` is the result of "
        "running the section 5 chain FORWARDS in Python on the `sextant_hs_deg` "
        "this file publishes, and `forward_minus_target_arcmin` is how far that "
        "lands from `observed_ho_deg`. The largest over all five sights is "
        "%.2e arcmin, so the published Hs values are exact to far below the "
        "0.02 arcmin the Rust chain has to meet; any failure is the Rust "
        "implementation, not the fixture." % worst_roundtrip,
    ]

    notes = [
        "Five lower-limb Sun sights over an hour around local apparent noon; "
        "the Sun transits at Philadelphia at 2026-10-01T16:50:15Z at an "
        "altitude of about 46.66 deg. `altitude_deg` in the session is the RAW "
        "sextant reading Hs, so the full CONVENTIONS section 5 chain must run.",
        "Geometry is deliberately poor: five sights over one hour around noon "
        "span only about %.1f deg of azimuth. Latitude comes out well, longitude "
        "badly, and the 95 %% ellipse should be a long thin east-west sliver "
        "with a large condition number. This is one of the required 'clustered "
        "observation geometry' demonstrations, not a good fix. Do not set a "
        "tight position tolerance on this file."
        % abs(
            c.wrap_diff_deg(
                sights[-1]["azimuth_skyfield_deg"], sights[0]["azimuth_skyfield_deg"]
            )
        ),
        "Semidiameter and horizontal parallax are supplied per observation in "
        "`geocentric`, as CONVENTIONS section 5 steps 4 and 5 require ('SD comes "
        "from the ephemeris record, never a constant'). They vary by less than "
        "0.0002 arcmin across the hour, but they are per-sight values, not one "
        "shared constant.",
        "Every apparent altitude here is near 46 deg, so no low-altitude "
        "refraction flag applies and no sigma inflation is warranted. "
        "CONVENTIONS section 5 step 3's LowAltitudeRefraction path is exercised "
        "by fixtures/reference/topocentric_altaz.json instead, which contains "
        "bodies down to -1 deg.",
        "sigma_arcmin is %.1f, a plausible figure for a careful sea-horizon Sun "
        "sight, but the data carries zero noise: residuals at the truth position "
        "are zero to floating point. sigma is here so the covariance machinery "
        "has something to propagate." % SIGMA_ARCMIN,
    ]

    return {
        "schema": "skyfix.expected/1",
        "name": SESSION_NAME,
        "session": "fixtures/sessions/%s.json" % SESSION_NAME,
        "truth": "fixtures/expected/%s.truth.json" % SESSION_NAME,
        "generator": c.generator_block(
            tool="tools/reference/gen_sun_sextant.py",
            description=(
                "Reversed CONVENTIONS section 5 correction chain for five "
                "synthetic lower-limb Sun sights at Philadelphia."
            ),
            tolerance_arcmin=c.arcmin(0.02),
            tolerance_justification=(
                "0.02 arcmin (1.2 arcsec) on Ho after running the chain forwards "
                "from the published Hs. That is a pure arithmetic tolerance: the "
                "reversal is exact to %.2e arcmin, so anything the Rust chain "
                "loses is its own. 0.02 arcmin is a fifth of the tightest sigma "
                "in the project and 37 m of position, small enough to catch a "
                "wrong constant (Bennett's 7.31/4.4 mistyped, dip 1.76 vs 0.97, "
                "SD from a constant instead of the ephemeris) and loose enough "
                "not to fail on f64 rounding or on a slightly different "
                "fixed-point convergence threshold. The POSITION recovered from "
                "this session has no tolerance attached at all, because its "
                "geometry is deliberately bad." % worst_roundtrip
            ),
            frame_notes=c.GEOCENTRIC_FRAME_NOTES,
            refraction={
                "used_here": (
                    "the CONVENTIONS section 5 step 3 formula reimplemented in "
                    "tools/reference/common.py:bennett_refraction_arcmin, coded "
                    "from the text of CONVENTIONS.md. Skyfield's refraction is "
                    "NOT used in this file."
                ),
                "formula": (
                    "R' = cot(Ha_deg + 7.31 / (Ha_deg + 4.4)) arcmin, scaled by "
                    "(P_hPa / 1010) * (283 / (273 + T_C)), Ha the apparent "
                    "altitude"
                ),
                "conditions": "P = 1010.0 hPa, T = 10.0 C (scale factor exactly 1)",
                "skyfield_comparison": c.SKYFIELD_REFRACTION_NOTES[
                    "difference_from_conventions_section_5"
                ],
            },
            extra={
                "ephemeris": c.file_facts(c.EPHEMERIS_FILE, c.EPHEMERIS_URL),
                "observation_count": len(rows),
                "height_of_eye_m": c.metres(HEIGHT_OF_EYE_M),
                "index_correction_arcmin": c.arcmin(INDEX_CORRECTION_ARCMIN),
                "limb": LIMB,
                "horizon": "sea",
                "max_forward_reverse_roundtrip_arcmin": c.Num(worst_roundtrip, 12),
            },
        ),
        "expected_fix": c.Inline(
            {"lat_deg": c.deg(TRUTH_LAT), "lon_deg": c.deg(TRUTH_LON)}
        ),
        "position_tolerance_m": None,
        "ho_tolerance_arcmin": c.arcmin(0.02),
        "reversal_steps": reversal,
        "observations": rows,
        "notes": notes,
    }


def main():
    sights, worst = build()
    print(
        "   Sun transit 16:50:15Z; five sights %s; azimuths %.2f to %.2f deg"
        % (
            ", ".join(s["utc"][11:16] for s in sights),
            sights[0]["azimuth_skyfield_deg"],
            sights[-1]["azimuth_skyfield_deg"],
        )
    )
    for s in sights:
        print(
            "     %s Hs=%.6f -> Ha=%.6f R=%.4f' SD=%.4f' PA=%.4f' Ho=%.6f "
            "(round trip %.2e')"
            % (
                s["utc"][11:16],
                s["rev"]["hs_deg"],
                s["rev"]["ha_deg"],
                s["rev"]["refraction_arcmin"],
                s["semidiameter_arcmin"],
                s["rev"]["parallax_in_altitude_arcmin"],
                s["ho_deg"],
                s["roundtrip_arcmin"],
            )
        )
    c.write_json(
        os.path.join(c.FIX_SESSIONS, "%s.json" % SESSION_NAME), session(sights)
    )
    c.write_json(
        os.path.join(c.FIX_EXPECTED, "%s.truth.json" % SESSION_NAME), truth()
    )
    c.write_json(
        os.path.join(c.FIX_EXPECTED, "%s.expected.json" % SESSION_NAME),
        expected(sights, worst),
    )


if __name__ == "__main__":
    main()
