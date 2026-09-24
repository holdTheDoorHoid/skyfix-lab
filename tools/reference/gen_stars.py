"""fixtures/reference/navigational_stars_hip.json

The 57 Nautical Almanac navigational stars plus Polaris, straight out of the
Hipparcos catalogue (CDS I/239, hip_main.dat), at the catalogue's own epoch
J1991.25 in the ICRS.

Every HIP number is verified against an independently known position and
magnitude for the star the name promises (see common.NAV_STARS); a mismatch is
recorded in the file's `notes` and printed, it is never silently accepted.
"""

from __future__ import annotations

import os

from . import common as c


def build():
    df = c.load_hipparcos_frame()
    stars, rows, problems = c.build_stars(df)

    cases = []
    max_sep = 0.0
    max_dmag = 0.0
    for name, hip, designation, exp_mag, exp_ra, exp_dec in c.NAV_STARS:
        row, sep, dmag = rows[name]
        max_sep = max(max_sep, sep)
        max_dmag = max(max_dmag, abs(dmag))
        rec = {
            "name": name,
            "hip": int(hip),
            "designation": designation,
            "ra_deg": c.deg(float(row.ra_degrees)),
            "dec_deg": c.deg(float(row.dec_degrees)),
            "pm_ra_cosdec_mas_yr": c.Num(float(row.ra_mas_per_year), 4),
            "pm_dec_mas_yr": c.Num(float(row.dec_mas_per_year), 4),
            "parallax_mas": c.Num(float(row.parallax_mas), 4),
            "mag": c.Num(float(row.magnitude), 4),
            "identity_check": c.Inline(
                {
                    "expected_ra_deg": c.Num(exp_ra, 4),
                    "expected_dec_deg": c.Num(exp_dec, 4),
                    "separation_arcsec": c.arcsec(sep * 3600.0),
                    "expected_mag": c.Num(exp_mag, 3),
                    "mag_difference": c.Num(dmag, 3),
                }
            ),
        }
        if name in c.STAR_NOTES:
            rec["notes"] = c.STAR_NOTES[name]
        cases.append(rec)

    notes = [
        "The 57 navigational stars of the Nautical Almanac, in the Almanac's own "
        "spelling, plus Polaris. The spelling of `name` is the project's contract: "
        "session files refer to bodies by exactly these strings.",
        "Positions and proper motions are ICRS at the Hipparcos catalogue epoch "
        "J1991.25 (epoch_year = 1991.25), NOT J2000.0. A consumer must propagate "
        "proper motion from 1991.25 to the epoch of observation; over 35 years "
        "Rigil Kentaurus moves 129 arcsec and Sirius 12 arcsec, so this is not "
        "optional.",
        "`ra_deg`/`dec_deg` are the catalogue's RAdeg/DEdeg (fields H8/H9). "
        "`pm_ra_cosdec_mas_yr` is the catalogue's pmRA (field H12), which is "
        "already mu_alpha * cos(delta); it is NOT d(RA)/dt.",
        "`parallax_mas` is the catalogue's Plx (field H11). It can be negative for "
        "distant stars where the measurement noise exceeded the parallax; that is "
        "the published value and is left as published.",
        "Radial velocity is not in hip_main.dat and is taken as zero, so these "
        "positions carry no radial-velocity (perspective acceleration) term. For "
        "the fast, nearby Rigil Kentaurus that is a real approximation: its true "
        "radial velocity of -22 km/s changes its proper motion measurably over "
        "decades.",
        "Each entry carries an `identity_check` comparing the catalogue entry with "
        "an independently known position and V magnitude for the star the name "
        "promises. Largest separation found: %.2f arcsec. Largest magnitude "
        "difference: %.3f mag." % (max_sep * 3600.0, max_dmag),
    ]
    if problems:
        notes.append("UNRESOLVED IDENTITY DOUBTS: " + " | ".join(problems))
    else:
        notes.append(
            "All %d names resolved to a catalogue entry within 0.2 deg and 0.5 mag "
            "of the independently expected star. No HIP mapping is in doubt."
            % len(cases)
        )

    doc = {
        "schema": "skyfix.reference/1",
        "name": "navigational_stars_hip",
        "generator": c.generator_block(
            tool="tools/reference/gen_stars.py",
            description=(
                "Hipparcos catalogue entries for the 57 Nautical Almanac "
                "navigational stars plus Polaris."
            ),
            tolerance_arcmin=c.Num(0.05, 4),
            tolerance_justification=(
                "This file is a catalogue transcription, not a computation: the "
                "numbers are exact copies of hip_main.dat. The 0.05 arcmin (3 "
                "arcsec) tolerance applies to a consumer that reconstructs an "
                "apparent place from these elements; it is set by the identity "
                "margin of the double stars (Acrux, Rigil Kentaurus), which is "
                "several arcsec, and it is an order of magnitude below the 0.1 "
                "arcmin sextant sigma used everywhere in the project."
            ),
            frame_notes={
                "frame": "ICRS (equivalent to FK5 J2000 to within 0.02 arcsec)",
                "epoch": "J1991.25, the Hipparcos catalogue epoch",
                "not_j2000": (
                    "These are catalogue elements at 1991.25, not J2000.0 apparent "
                    "places. Do not use ra_deg/dec_deg as a J2000 position without "
                    "applying proper motion."
                ),
            },
            extra={
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "catalogue_reference": (
                    "ESA (1997), The Hipparcos and Tycho Catalogues, ESA SP-1200; "
                    "CDS catalogue I/239, table hip_main.dat, loaded with "
                    "skyfield.data.hipparcos.load_dataframe()."
                ),
                "count": len(cases),
            },
        ),
        "notes": notes,
        "cases": cases,
    }
    return doc, problems


def main():
    doc, problems = build()
    c.write_json(os.path.join(c.FIX_REFERENCE, "navigational_stars_hip.json"), doc)
    if problems:
        print("\n!! IDENTITY PROBLEMS (recorded in the fixture's notes):")
        for p in problems:
            print("   -", p)
    else:
        print("   all 58 HIP mappings verified against independent positions/magnitudes")


if __name__ == "__main__":
    main()
