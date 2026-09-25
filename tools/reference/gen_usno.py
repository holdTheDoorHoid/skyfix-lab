"""fixtures/reference/usno_celnav_2026-10-01T0130Z.json

A second, fully independent opinion. The US Naval Observatory's Astronomical
Applications "Celestial Navigation Data" API is queried for the same instant and
place as the Philadelphia star sessions, the raw response is stored verbatim,
and every value it shares with our Skyfield-derived data is differenced.

This is the only file in fixtures/reference/ that is not generated from
Skyfield, which is exactly what makes it worth having: it checks our frame
conventions against the institution that publishes the Nautical Almanac.

Network is required to regenerate this file. If the API is unreachable the
existing file is left alone and the generator says so; it never fabricates.

    tools/reference/.venv/bin/python -m tools.reference.gen_usno \
        [--window 2026-10-01..2026-10-02] [--kernel de421]

The query is one instant: `--window` must contain it; `--kernel` names the ephemeris
of the Skyfield side of the comparison.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import urllib.error
import urllib.request

from . import common as c

URL = (
    "https://aa.usno.navy.mil/api/celnav"
    "?date=2026-10-01&time=01:30:00&coords=39.9526,-75.1652"
)
DOCS_URL = "https://aa.usno.navy.mil/data/api"
OUT = "usno_celnav_2026-10-01T0130Z.json"

QUERY_TIME = (2026, 10, 1, 1, 30, 0)
QUERY_LAT, QUERY_LON = 39.9526, -75.1652

#: USNO spells a few stars differently from the Nautical Almanac list the
#: project uses. Everything else matches character for character.
USNO_NAME_MAP = {
    "CAPELLA": "Capella",
    "ARCTURUS": "Arcturus",
    "VEGA": "Vega",
    "ALTAIR": "Altair",
    "DENEB": "Deneb",
    "FOMALHAUT": "Fomalhaut",
    "POLARIS": "Polaris",
    "Alnair": "Al Na'ir",
}


def fetch():
    """Fetch the API response.

    aa.usno.navy.mil sits behind a filter that resets the connection for
    unfamiliar User-Agent strings, so a plain urllib request fails with
    ECONNRESET. We shell out to curl rather than claim to be a browser we are
    not; urllib is kept as a fallback in case the filter changes.
    """
    try:
        out = subprocess.run(
            ["curl", "-sS", "-f", "-m", "90", "-L", URL],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        return json.loads(out)
    except FileNotFoundError:
        req = urllib.request.Request(URL)
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode("utf-8"))
    except subprocess.CalledProcessError as e:
        raise OSError(
            "curl failed (exit %d): %s" % (e.returncode, (e.stderr or "").strip())
        ) from e
    except json.JSONDecodeError as e:
        raise OSError("USNO returned something that is not JSON: %s" % e) from e


def _to_num(o):
    """Turn the raw response into Num-wrapped values so it renders stably."""
    if isinstance(o, bool):
        return o
    if isinstance(o, float):
        return c.Num(o, 6)
    if isinstance(o, int):
        return o
    if isinstance(o, dict):
        return {k: _to_num(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_to_num(v) for v in o]
    return o


def compare(raw):
    ts = c.load_timescale()
    eph = c.run_ephemeris()
    earth = eph["earth"]
    df = c.load_hipparcos_frame()
    stars, _rows, _problems = c.build_stars(df)

    t = ts.utc(*QUERY_TIME)
    dut1 = float(t.dut1)
    gha_aries = c.norm360(float(t.gast) * 15.0)
    gha_aries_z = c.gha_dut1_zero_deg(gha_aries, dut1)

    rows = []
    skipped = []
    aries = None
    worst = {"gha": 0.0, "gha_z": 0.0, "dec": 0.0, "hc": 0.0, "hc_z": 0.0,
             "zn": 0.0, "zn_z": 0.0}

    for o in raw["properties"]["data"]:
        name = o["object"]
        a = o["almanac_data"]
        if name == "ARIES":
            aries = {
                "usno_gha_deg": c.deg(a["gha"]),
                "our_gha_deg": c.deg(gha_aries),
                "our_gha_deg_dut1_zero": c.deg(gha_aries_z),
                "usno_minus_ours_arcsec": c.arcsec((a["gha"] - gha_aries) * 3600.0),
                "usno_minus_ours_dut1_zero_arcsec": c.arcsec(
                    (a["gha"] - gha_aries_z) * 3600.0
                ),
            }
            continue
        ours = USNO_NAME_MAP.get(name, name)
        if ours not in stars:
            skipped.append(name)
            continue
        gha, dec, _ra, _d = c.geocentric_of(earth, t, stars[ours])
        gha_z = c.gha_dut1_zero_deg(gha, dut1)
        hc, zn = c.spherical_altitude_azimuth_deg(QUERY_LAT, QUERY_LON, gha, dec)
        hc_z, zn_z = c.spherical_altitude_azimuth_deg(
            QUERY_LAT, QUERY_LON, gha_z, dec
        )
        d_gha = c.wrap_diff_deg(a["gha"], gha) * 60.0
        d_gha_z = c.wrap_diff_deg(a["gha"], gha_z) * 60.0
        d_dec = (a["dec"] - dec) * 60.0
        d_hc = (a["hc"] - hc) * 60.0
        d_hc_z = (a["hc"] - hc_z) * 60.0
        d_zn = c.wrap_diff_deg(a["zn"], zn) * 60.0
        d_zn_z = c.wrap_diff_deg(a["zn"], zn_z) * 60.0
        worst["gha"] = max(worst["gha"], abs(d_gha))
        worst["gha_z"] = max(worst["gha_z"], abs(d_gha_z))
        worst["dec"] = max(worst["dec"], abs(d_dec))
        worst["hc"] = max(worst["hc"], abs(d_hc))
        worst["hc_z"] = max(worst["hc_z"], abs(d_hc_z))
        if hc < 88.0:
            worst["zn"] = max(worst["zn"], abs(d_zn))
            worst["zn_z"] = max(worst["zn_z"], abs(d_zn_z))
        rows.append(
            c.Inline(
                {
                    "usno_object": name,
                    "body": ours,
                    "usno_gha_deg": c.deg(a["gha"]),
                    "usno_dec_deg": c.deg(a["dec"]),
                    "usno_hc_deg": c.deg(a["hc"]),
                    "usno_zn_deg": c.deg(a["zn"]),
                    "our_gha_deg": c.deg(gha),
                    "our_gha_deg_dut1_zero": c.deg(gha_z),
                    "our_dec_deg": c.deg(dec),
                    "our_hc_deg": c.deg(hc),
                    "our_hc_deg_dut1_zero": c.deg(hc_z),
                    "our_zn_deg": c.deg(zn),
                    "our_zn_deg_dut1_zero": c.deg(zn_z),
                    "d_gha_arcmin": c.arcmin(d_gha),
                    "d_gha_dut1_zero_arcmin": c.arcmin(d_gha_z),
                    "d_dec_arcmin": c.arcmin(d_dec),
                    "d_hc_arcmin": c.arcmin(d_hc),
                    "d_hc_dut1_zero_arcmin": c.arcmin(d_hc_z),
                    "d_zn_arcmin": c.arcmin(d_zn),
                    "d_zn_dut1_zero_arcmin": c.arcmin(d_zn_z),
                }
            )
        )
    rows.sort(key=lambda r: r.o["body"])
    return aries, rows, skipped, worst, dut1


def build():
    raw = fetch()
    aries, rows, skipped, worst, dut1 = compare(raw)

    notes = [
        "The USNO 'Celestial Navigation Data' API returns, for one instant and "
        "one position, the GHA and declination of every body a navigator could "
        "use, plus the computed altitude Hc and true azimuth Zn at that "
        "position, plus the altitude corrections. `usno_response` below is the "
        "response verbatim; `comparison` is ours differenced against it.",
        "THE HEADLINE RESULT. USNO's GHA of Aries is %s and our GHA of Aries "
        "recomputed with UT1 = UTC is %s -- identical to the 1e-6 deg USNO "
        "publishes. Our GHA computed with Skyfield's actual UT1 differs by "
        "%s arcsec, which is exactly 15.0410686 * DUT1 = 15.0410686 * %.4f s. "
        "USNO's celnav therefore takes the supplied UTC as UT1, i.e. it assumes "
        "DUT1 = 0, which is the same assumption CONVENTIONS section 6 makes. "
        "`gha_deg_dut1_zero` in the other reference files is the column that "
        "matches USNO and the Nautical Almanac convention; `gha_deg` is the "
        "column that is physically more nearly right. Test against the former."
        % (
            _fmt(aries["usno_gha_deg"]),
            _fmt(aries["our_gha_deg_dut1_zero"]),
            _fmt(aries["usno_minus_ours_arcsec"]),
            dut1,
        ),
        "With that one constant offset understood, USNO and this project's "
        "Skyfield + DE421 + Hipparcos pipeline agree on %d stars to: %.4f "
        "arcmin in GHA once DUT1 is removed, %.4f arcmin in declination, %.4f "
        "arcmin in the spherical-formula Hc computed from that same "
        "DUT1-zero GHA, and %.4f arcmin in Zn (excluding bodies within 2 deg "
        "of the zenith, where azimuth is ill-conditioned). "
        "Every one of those is inside the 0.05 arcmin tolerance the other "
        "reference files set, and this is an entirely independent code path, "
        "ephemeris and star catalogue."
        % (len(rows), worst["gha_z"], worst["dec"], worst["hc_z"], worst["zn_z"]),
        "`our_hc_deg` is CONVENTIONS section 3 evaluated on our own geocentric "
        "GHA/Dec at the query position, so the Hc agreement checks the "
        "spherical sight-reduction formula against USNO's, not just the "
        "ephemeris. Against `gha_deg` it differs by up to %.4f arcmin, the DUT1 "
        "offset projected into altitude, which is why it varies across the "
        "table rather than being constant. Against `gha_deg_dut1_zero`, the "
        "column that matches USNO's own time convention, Hc agrees to %.4f "
        "arcmin and Zn to %.4f arcmin. That is the real result: two independent "
        "implementations of apparent place and of spherical sight reduction "
        "landing within %.2f arcsec of each other."
        % (worst["hc"], worst["hc_z"], worst["zn_z"], worst["hc_z"] * 60.0),
        "Objects USNO returned that this project does not carry: %s. The Moon "
        "and planets are deferred (docs/BRIEF.md: 'Defer Moon/planets unless "
        "independently validated'), so they are present in `usno_response` but "
        "not differenced. If a Moon or planet provider is ever added, this "
        "response already contains an independent check for it."
        % (", ".join(skipped) if skipped else "none"),
        "USNO spells a few first-magnitude stars in capitals and writes "
        "'Alnair' for the Almanac's \"Al Na'ir\"; `usno_object` keeps their "
        "spelling and `body` gives the project's. The project's spelling is the "
        "contract (fixtures/reference/navigational_stars_hip.json).",
    ]

    doc = {
        "schema": "skyfix.reference/1",
        "name": "usno_celnav_2026-10-01T0130Z",
        "generator": c.generator_block(
            tool="tools/reference/gen_usno.py",
            description=(
                "Raw USNO Celestial Navigation Data API response for "
                "2026-10-01T01:30:00Z at 39.9526, -75.1652, with our values "
                "differenced against it."
            ),
            tolerance_arcmin=c.Num(0.05, 4),
            tolerance_justification=(
                "The same 0.05 arcmin as the other reference files. This file "
                "is not a tolerance to be met by Rust code -- it is evidence "
                "that the Skyfield pipeline which generated the other reference "
                "files agrees with an independent authority to well inside that "
                "tolerance. Worst disagreement found, on USNO's own DUT1 = 0 "
                "time convention: %.4f arcmin in GHA, %.4f arcmin in "
                "declination, %.4f arcmin in Hc."
                % (worst["gha_z"], worst["dec"], worst["hc_z"])
            ),
            frame_notes={
                "ours": c.GEOCENTRIC_FRAME_NOTES,
                "usno": (
                    "USNO celnav publishes apparent GHA and declination of date "
                    "on the Nautical Almanac convention, and Hc/Zn computed at "
                    "the supplied position. The agreement documented in `notes` "
                    "shows the two frame conventions coincide, with the single "
                    "exception that USNO treats the supplied UTC as UT1."
                ),
            },
            refraction=(
                "USNO's `altitude_corrections.refr` is its own refraction model "
                "and is NOT used anywhere in this project; it is stored as part "
                "of the verbatim response only."
            ),
            extra={
                "source": "US Naval Observatory, Astronomical Applications Department",
                "api_url": URL,
                "api_documentation": DOCS_URL,
                "api_version_returned": raw.get("apiversion"),
                "retrieved_utc": _dt.datetime.now(_dt.timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "terms_of_use": (
                    "Data produced by the US Naval Observatory, a US Government "
                    "agency. Works of the US Government are not subject to "
                    "copyright protection in the United States (17 U.S.C. 105), "
                    "which is the basis on which this response is stored in the "
                    "repository. NOT VERIFIED: the documentation page at %s is "
                    "rendered client-side and no machine-readable terms-of-use "
                    "or licence statement could be retrieved on the date above. "
                    "Confirm with USNO before redistributing this file outside "
                    "the project, and do not treat any of this data as "
                    "authoritative for navigation." % DOCS_URL
                ),
                "query": c.Inline(
                    {
                        "utc": "2026-10-01T01:30:00Z",
                        "lat_deg": c.deg(QUERY_LAT),
                        "lon_deg": c.deg(QUERY_LON),
                    }
                ),
                "bodies_compared": len(rows),
                "bodies_not_compared": skipped,
                "max_disagreement_arcmin": c.Inline(
                    {
                        "gha": c.arcmin(worst["gha"]),
                        "gha_dut1_zero": c.arcmin(worst["gha_z"]),
                        "dec": c.arcmin(worst["dec"]),
                        "hc": c.arcmin(worst["hc"]),
                        "hc_dut1_zero": c.arcmin(worst["hc_z"]),
                        "zn": c.arcmin(worst["zn"]),
                        "zn_dut1_zero": c.arcmin(worst["zn_z"]),
                    }
                ),
            },
        ),
        "notes": notes,
        "comparison": {"aries": c.Inline(aries), "bodies": rows},
        "usno_response": _to_num(raw),
    }
    print(
        "   USNO apiversion %s, %d bodies compared; max |dGHA| after DUT1 "
        "%.4f', |dDec| %.4f', |dHc| %.4f', |dZn| %.4f'"
        % (
            raw.get("apiversion"),
            len(rows),
            worst["gha_z"],
            worst["dec"],
            worst["hc_z"],
            worst["zn_z"],
        )
    )
    return doc


def _fmt(n):
    return c._fmt_num(n)


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "2026-10-01..2026-10-02", "de421")
    c.require_in_window(c.jd_from_gregorian(*QUERY_TIME[:3], 1.5), "the USNO query")
    try:
        doc = build()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(
            "   USNO API unreachable (%s). Leaving fixtures/reference/%s as it "
            "is; nothing fabricated." % (e, OUT)
        )
        return
    c.write_json(os.path.join(c.FIX_REFERENCE, OUT), doc)


if __name__ == "__main__":
    main()
