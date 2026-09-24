# Third-party sources, data and licences

Every external algorithm, coefficient table and data file used by SkyFix Lab is
recorded here with its URL, retrieval date and licence terms. Nothing in this list is
a runtime dependency: all of it is either embedded in the binary with `include_str!`
or transcribed into source. The build and the tests run with no network.

Each agent owns its own section. Do not edit another section; add a new one.

## Star catalogue and frame models

Owner: ephemeris agent (`crates/skyfix-ephemeris/src/{sidereal,frames,catalog,stars}.rs`,
`fixtures/reference/navigational_stars_hip.json`).

### ERFA — Essential Routines for Fundamental Astronomy

- **What is used:** numerical *models*, not code. Specifically: the 77-term luni-solar
  coefficient table of the IAU 2000B nutation model and its fixed planetary offsets
  (`src/nut00b.c`); the 10 largest terms of the equation-of-the-equinoxes complementary
  series (`src/eect00.c`); the IAU 2006 polynomial coefficients for the mean obliquity
  (`src/obl06.c`), the Fukushima-Williams bias-and-precession angles (`src/pfw06.c`),
  the Earth rotation angle (`src/era00.c`) and Greenwich mean sidereal time
  (`src/gmst06.c`); the P03 adjustment factors applied to a 2000-series nutation
  (`src/nut06a.c`); and the published validation values in `src/t_erfa_c.c`, which are
  used as expected values in `crates/skyfix-ephemeris/tests/sidereal_reference.rs`.
- **URL:** <https://github.com/liberfa/erfa> (files fetched from
  `https://raw.githubusercontent.com/liberfa/erfa/master/src/`)
- **Retrieved:** 2026-09-23
- **Licence:** BSD 3-clause. Copyright (C) 2013-2021, NumFOCUS Foundation. All rights
  reserved. ERFA is derived, with permission, from the IAU's SOFA library
  (<http://www.iausofa.org>). Compatible with this workspace's MIT OR Apache-2.0.
- **Attribution required by the licence, reproduced here:** redistributions must retain
  the ERFA copyright notice and disclaimer, and must not use the names of the Standards
  of Fundamental Astronomy Board, the International Astronomical Union or its
  contributors to endorse or promote this software. SkyFix Lab is **not** SOFA and is
  not endorsed by the IAU, the SOFA Board or NumFOCUS; it merely implements the same
  published IAU models and is checked against ERFA's published test values.
- **Note:** no ERFA source code was copied. The Rust in `frames.rs` and `sidereal.rs`
  is an independent implementation; what is shared is the IAU model definition — the
  same numbers published in the IERS Conventions (2010), IERS Technical Note 36 — and
  the published test values.

### Underlying published models

Cited in the source; no licence attaches to a published scientific model.

- IAU 2006 precession (P03): Capitaine, Wallace & Chapront (2003), *A&A* **412**, 567;
  Wallace & Capitaine (2006), *A&A* **459**, 981 (the P03 adjustment to a 2000-series
  nutation, their Eqs. 5).
- IAU 2000B nutation: McCarthy & Luzum (2003), *Celest. Mech. Dyn. Astr.* **85**, 37.
  Stated accuracy: 1 mas against the full IAU 2000A model over 1995-2050.
- Earth rotation angle: Capitaine, Guinot & McCarthy (2000), *A&A* **355**, 398.
- Delaunay fundamental arguments: Simon et al. (1994), *A&A* **282**, 663.
- USNO/SOFA reference figure: Greenwich mean sidereal time at 2000-01-01 12:00 UT1 is
  18h 41m 50.548s (280.46061837 deg), the IAU 1982 GMST expression at `T = 0`.

### Meeus, *Astronomical Algorithms*, 2nd edition (Willmann-Bell, 1998)

- **What is used:** the low-accuracy solar model of chapter 25 (geometric mean
  longitude, mean anomaly, equation of the centre, radius vector; 0.01 deg in
  longitude), the longitude of perihelion of the Earth's orbit from chapter 23, and
  worked example 23.a (the apparent place of theta Persei on 2028 November 13.19 TD)
  as a test case.
- **Licence:** the book is copyrighted; the formulae and the worked example's published
  numbers are facts used as a reference, not reproduced text. No code was copied.
- **Cross-check for example 23.a** (the intermediate mean place 2h46m11.331s,
  +49d20'54.54" and the final apparent place 2h46m14.390s, +49d21'07.45"):
  <https://github.com/soniakeys/meeus> `v3/apparent/apparent_test.go`, retrieved
  2026-09-23, MIT licence. Used only to confirm the published values were transcribed
  correctly; none of its code is used.

### Hipparcos catalogue — `fixtures/reference/navigational_stars_hip.json`

- **What is used:** ICRS position, proper motion, parallax and V magnitude for the 57
  Nautical Almanac navigational stars plus Polaris.
- **Source:** Hipparcos main catalogue (ESA 1997, ESA SP-1200), VizieR catalogue
  `I/239/hip_main`, columns `HIP RAICRS DEICRS pmRA pmDE Plx Vmag`.
- **URL / exact query:** `https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync`,
  ADQL `SELECT HIP,RAICRS,DEICRS,pmRA,pmDE,Plx,Vmag FROM "I/239/hip_main" WHERE HIP IN
  (13847, 7588, 60718, 33579, 21421, 62956, 67301, 109268, 26311, 46390, 76267, 677,
  97649, 2081, 80763, 69673, 82273, 41037, 25336, 27989, 30438, 24608, 102098, 57632,
  3419, 54061, 25428, 87833, 107315, 113368, 61084, 59803, 68702, 9884, 90185, 72607,
  113963, 14135, 68933, 45238, 15863, 92855, 100751, 37826, 37279, 86032, 49669, 24436,
  71683, 84012, 3179, 85927, 32349, 65474, 44816, 91262, 72622, 11767)`
- **Retrieved:** 2026-09-23
- **Licence:** CDS/VizieR data are freely usable with acknowledgement of the Centre de
  Données astronomiques de Strasbourg and of ESA 1997, *The Hipparcos and Tycho
  Catalogues*, ESA SP-1200. The identification of HIP numbers with Nautical Almanac
  star names is this project's own.
- **Processing applied:** catalogue positions are given at epoch **J1991.25**. They were
  propagated to epoch **J2000.0** with the tabulated proper motions by the unit-vector
  method (no radial velocity, so no perspective acceleration). Proper motions,
  parallaxes and magnitudes are the catalogue values, unchanged. Spot check: the
  resulting Vega position, 279.23473511 deg / +38.78369180 deg, agrees with the
  published J2000 place 18h36m56.336s / +38d47'01.28" to better than 0.01".
- **Status: PROVISIONAL.** `generator.provisional` is `true`. This file is a stand-in
  until the reference-fixtures agent delivers the authoritative Skyfield-generated
  file. The loader accepts either: same schema, same field names. **If the replacement
  carries positions at the Hipparcos epoch rather than J2000.0, it must say so in
  `generator.epoch` (`"J1991.25"`, a Julian year such as `1991.25`, or a Julian date);
  the loader propagates to J2000.0 itself.** When `generator.epoch` is absent the
  loader assumes J2000.0, which is what this file provides.
