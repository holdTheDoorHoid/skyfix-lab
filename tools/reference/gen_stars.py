"""fixtures/reference/navigational_stars_hip.json

The 57 Nautical Almanac navigational stars plus Polaris, straight out of the
Hipparcos catalogue (CDS I/239, hip_main.dat), at the catalogue's own epoch
J1991.25 in the ICRS.

Every HIP number is verified against an independently known position and
magnitude for the star the name promises (see common.NAV_STARS); a mismatch is
recorded in the file's `notes` and printed, it is never silently accepted.

    tools/reference/.venv/bin/python -m tools.reference.gen_stars [--window ..] [--kernel ..]

`--window` and `--kernel` are accepted like every generator's and change nothing: the
catalogue is the epoch-J1991.25 extract, with radial velocities and alpha Centauri A's
orbit, for any date.
"""

from __future__ import annotations

import os

from . import common as c

#: Radial velocities (km/s, positive receding), their uncertainty (km/s), SIMBAD's
#: quality grade and the source bibcode: SIMBAD's `basic.rvz_radvel` for each HIP
#: number, fetched with its TAP service on 2026-09-25 (query in
#: tools/reference/README.md, "Radial velocities"). Facts compiled from the
#: literature; SIMBAD and the original authors are credited in docs/THIRD_PARTY.md.
#: Rigil Kentaurus is the exception: SIMBAD's value for alpha Cen A (-15.252 km/s,
#: 2021MNRAS.506..150B) is one epoch's velocity, which includes A's orbital motion
#: about the A-B barycentre; the space motion needs the barycentre's, so the entry
#: below is SIMBAD's for the system "* alf Cen" (-22.3 +/- 0.9, 1979IAUS...30...57E).
RADIAL_VELOCITIES = {
    677: (-10.1, 0.2, 'A', '2004A&A...424..727P'),  # * alf And
    2081: (74.6, 0.9, 'A', '1979IAUS...30...57E'),  # * alf Phe
    3179: (-4.204, 0.0006, 'A', '2018A&A...616A...7S'),  # * alf Cas
    3419: (13.257, 0.0002, 'A', '2018A&A...616A...7S'),  # * bet Cet
    7588: (8.47, 2.16, 'C', '2023ApJS..266...11B'),  # * alf Eri
    9884: (-14.412, 0.0005, 'A', '2018A&A...616A...7S'),  # * alf Ari
    11767: (-16.42, 0.03, 'A', '2004A&A...424..727P'),  # * alf UMi
    13847: (11.9, 2.6, 'C', '2006AstL...32..759G'),  # * tet Eri
    14135: (-25.47, 0.1, 'A', '2023A&A...676A.129H'),  # * alf Cet
    15863: (-2.158, 0.0036, 'A', '2018A&A...616A...7S'),  # * alf Per
    21421: (54.398, 0.0008, 'A', '2018A&A...616A...7S'),  # * alf Tau
    24436: (17.8, 0.4, 'A', '2006AstL...32..759G'),  # * bet Ori
    24608: (29.19, 0.07, 'A', '2004MNRAS.349.1069K'),  # * alf Aur
    25336: (17.31, 0.45, 'A', '2023ApJS..266...11B'),  # * gam Ori
    25428: (9.2, 2.0, 'B', '1979IAUS...30...57E'),  # * bet Tau
    26311: (27.3, 0.8, 'A', '2006AstL...32..759G'),  # * eps Ori
    27989: (21.91, 0.51, 'A', '2005A&A...430..165F'),  # * alf Ori
    30438: (20.3, 0.5, 'A', '2006AstL...32..759G'),  # * alf Car
    32349: (-5.5, 0.4, 'A', '2006AstL...32..759G'),  # * alf CMa
    33579: (27.3, 0.4, 'A', '2006AstL...32..759G'),  # * eps CMa
    37279: (-4.50528, 0.020786, 'A', '2020AJ....160..120J'),  # * alf CMi
    37826: (3.391, 0.0003, 'A', '2018A&A...616A...7S'),  # * bet Gem
    41037: (11.6, 0.5, 'A', '2006AstL...32..759G'),  # * eps Car
    44816: (17.6, 0.3, 'A', '2006AstL...32..759G'),  # * lam Vel
    45238: (-5.1, 2.3, 'C', '2006AstL...32..759G'),  # * bet Car
    46390: (-4.561, 0.0001, 'A', '2018A&A...616A...7S'),  # * alf Hya
    49669: (0.719522, 0.614515, 'A', '2020AJ....160..120J'),  # * alf Leo
    54061: (-9.4, 0.3, 'A', '2006AstL...32..759G'),  # * alf UMa
    57632: (-0.2, 0.5, 'A', '2006AstL...32..759G'),  # * bet Leo
    59803: (-4.2, 2.0, 'E', '1953GCRV..C......0W'),  # * gam Crv
    60718: (11.9, 2.4, 'C', '2006AstL...32..759G'),  # * alf Cru
    61084: (21.0, 0.1, 'A', '2006AstL...32..759G'),  # * gam Cru
    62956: (-12.7, 0.2, 'A', '2006AstL...32..759G'),  # * eps UMa
    65474: (-3.31, 0.78, 'A', '2023ApJS..266...11B'),  # * alf Vir
    67301: (-13.4, 0.6, 'A', '2006AstL...32..759G'),  # * eta UMa
    68702: (2.52, 2.96, 'C', '2023ApJS..266...11B'),  # * bet Cen
    68933: (1.3, 0.5, 'A', '2006AstL...32..759G'),  # * tet Cen
    69673: (-5.229, 0.0002, 'A', '2018A&A...616A...7S'),  # * alf Boo
    71683: (-15.252, 0.167, 'A', '2021MNRAS.506..150B'),  # * alf Cen A
    72607: (16.96, 0.19, 'A', '2005A&A...430..165F'),  # * bet UMi
    72622: (-10.0, 5.0, 'E', '1953GCRV..C......0W'),  # * alf02 Lib
    76267: (1.7, 0.9, 'E', '1953GCRV..C......0W'),  # * alf CrB
    80763: (-3.5, 0.8, 'A', '2006AstL...32..759G'),  # * alf Sco
    82273: (-3.0, 0.1, 'A', '2006AstL...32..759G'),  # * alf TrA
    84012: (-2.4, 0.3, 'A', '2007AN....328..889K'),  # * eta Oph
    85927: (-3.0, 2.8, 'C', '2006AstL...32..759G'),  # * lam Sco
    86032: (11.7, 1.0, 'B', '2006AstL...32..759G'),  # * alf Oph
    87833: (-27.91, 0.19, 'A', '2005A&A...430..165F'),  # * gam Dra
    90185: (-15.0, 3.7, 'C', '2007AN....328..889K'),  # * eps Sgr
    91262: (-13.5, 0.4, 'C', '2004A&A...420..183A'),  # * alf Lyr
    92855: (-11.2, 2.0, 'B', '1979IAUS...30...57E'),  # * sig Sgr
    97649: (-26.6, 0.4, 'A', '2006AstL...32..759G'),  # * alf Aql
    100751: (2.0, 0.9, 'E', '1953GCRV..C......0W'),  # * alf Pav
    102098: (-4.9, 0.3, 'A', '2006AstL...32..759G'),  # * alf Cyg
    107315: (3.39, 0.06, 'A', '2005A&A...430..165F'),  # * eps Peg
    109268: (10.9, 1.7, 'B', '2006AstL...32..759G'),  # * alf Gru
    113368: (6.5, 0.5, 'A', '2006AstL...32..759G'),  # * alf PsA
    113963: (-2.7, 0.8, 'A', '2006AstL...32..759G'),  # * alf Peg
}
RADIAL_VELOCITIES[71683] = (-22.3, 0.9, 'A', '1979IAUS...30...57E')
RV_RETRIEVED = "2026-09-25"
RV_SOURCE = ("SIMBAD (CDS, Strasbourg), TAP service https://simbad.cds.unistra.fr/simbad/sim-tap, "
             "table basic, columns rvz_radvel, rvz_err, rvz_qual, rvz_bibcode")

#: alpha Centauri A about the A-B barycentre (the Almanac's Rigil Kentaurus is A,
#: HIP 71683; see docs/ACCURACY.md, "Rigil Kentaurus"). Elements of B relative to A
#: from the USNO Sixth Catalog of Orbits of Visual Binary Stars (ORB6), WDS
#: 14396-6050 RHD 1AB, reference Akeson et al. 2021 (AJ 162, 14), grade 2, fetched
#: 2026-09-25; the implementation reproduces ORB6's own published ephemeris for
#: 2025-2029 to 0.001" in separation (tools/reference/acen_orbit.py). The mass
#: fraction of B is from the same paper's masses, 1.0788 and 0.9092 solar masses.
ALPHA_CEN_ORBIT = {
    "companion": "alpha Centauri B (HIP 71681)",
    "source": ("USNO Sixth Catalog of Orbits of Visual Binary Stars (ORB6), "
               "https://crf.usno.navy.mil/data_products/WDS/orb6/orb6orbits.txt, retrieved "
               "2026-09-25: WDS 14396-6050 RHD 1AB, Akeson et al. 2021, AJ 162, 14 (grade 2)"),
    "period_yr": 79.762,
    "semi_major_arcsec": 17.4930,
    "inclination_deg": 79.2430,
    "node_deg": 205.073,
    "periastron_epoch_yr": 1955.564,
    "eccentricity": 0.51947,
    "periastron_arg_deg": 231.519,
    "secondary_mass_fraction": 0.9092 / (1.0788 + 0.9092),
    "mass_source": "Akeson et al. 2021: M_A = 1.0788, M_B = 0.9092 solar masses",
    "model": ("A = barycentre + (-f_B) x (B relative to A); the barycentre moves linearly from "
              "the catalogue's position of A at J1991.25 with A's catalogue proper motion minus "
              "A's orbital velocity at that epoch, and the system radial velocity: at J1991.25 "
              "the model is the catalogue (and USNO's celnav) exactly, and elsewhere it follows "
              "the orbit instead of the tangent line"),
}


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
            "rv_km_s": c.Num(RADIAL_VELOCITIES[hip][0], 4),
            "rv_source": c.Inline({
                "err_km_s": c.Num(RADIAL_VELOCITIES[hip][1], 4),
                "quality": RADIAL_VELOCITIES[hip][2],
                "bibcode": RADIAL_VELOCITIES[hip][3],
            }),
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
        if hip == 71683:
            rec["orbit"] = {k: (c.Num(v, 6) if isinstance(v, float) else v)
                            for k, v in ALPHA_CEN_ORBIT.items()}
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
        "Radial velocity is not in hip_main.dat. `rv_km_s` is SIMBAD's (retrieved %s; "
        "`rv_source` gives the error, SIMBAD's quality grade and the bibcode), so a "
        "consumer can apply rigorous space motion with its perspective acceleration: "
        "26 arcsec for Rigil Kentaurus by 2650, 15 arcmin by 2000 BC." % RV_RETRIEVED,
        "Rigil Kentaurus is alpha Centauri A, the body the Nautical Almanac and USNO's "
        "celnav tabulate (verified: USNO reproduces this entry, linear space motion with "
        "a radial velocity, to 0.2 arcsec from 1800 to 2050). Its Hipparcos proper motion "
        "is A's instantaneous one, which includes A's orbital motion about the A-B "
        "barycentre (0.22 arcsec/yr in 1991), so `orbit` carries the ORB6 elements and "
        "the mass fraction a consumer needs to follow A's real path: it leaves the "
        "tangent line by 5.8 arcsec by 2026 and 17 arcsec by 2060.",
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
                # Read by the Rust star-catalogue loader. `ra_deg`/`dec_deg`/
                # `pm_*`/`parallax_mas` are the Hipparcos catalogue values as
                # published, at the catalogue epoch, NOT propagated to J2000.0.
                # A loader that defaults to J2000.0 in the absence of this field
                # would be wrong by 32 arcsec for Rigil Kentaurus.
                "epoch": "J1991.25",
                "catalogue": c.file_facts(c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
                "catalogue_reference": (
                    "ESA (1997), The Hipparcos and Tycho Catalogues, ESA SP-1200; "
                    "CDS catalogue I/239, table hip_main.dat, loaded with "
                    "skyfield.data.hipparcos.load_dataframe()."
                ),
                "radial_velocities": {"source": RV_SOURCE, "retrieved": RV_RETRIEVED},
                "count": len(cases),
            },
        ),
        "notes": notes,
        "cases": cases,
    }
    return doc, problems


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "1990..2060", "de440s")
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
