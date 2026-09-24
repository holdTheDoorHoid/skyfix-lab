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
  (`src/nut06a.c`); the gravitational light-deflection formulation for a source at
  infinity (`src/ld.c`, `src/ldsun.c`) and the relativistic aberration formulation
  (`src/ab.c`); and the published validation values in `src/t_erfa_c.c`, used as
  expected values in `crates/skyfix-ephemeris/tests/sidereal_reference.rs` (`t_era00`,
  `t_gmst06`, `t_gst06a`, `t_nut00b`, `t_obl06`, `t_pfw06`, `t_eect00`) and in
  `tests/apparent_place_reference.rs` (`t_atci13`, a whole-chain apparent place).
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

## Sun model and fixture packs

Owner: ephemeris agent (`crates/skyfix-ephemeris/src/{sun,fixture_pack}.rs`,
`crates/skyfix-ephemeris/data/vsop87_sun_terms.json`).

### VSOP87D — the Earth's heliocentric motion

- **What is used:** the coefficients of the VSOP87 version D series for the Earth
  (heliocentric spherical `L`, `B`, `R`, referred to the mean dynamical ecliptic and
  equinox *of date*), truncated for the 1990-2060 coverage window and embedded in
  `crates/skyfix-ephemeris/data/vsop87_sun_terms.json`. Also the published check values
  in `vsop87.chk` and the record format and time-scale statement in `vsop87.txt`.
- **Source:** CDS catalogue **VI/81**, *Planetary Solutions VSOP87*, Bretagnon P.,
  Francou G. (1988), *A&A* **202**, 309 (1988A&A...202..309B). Bureau des Longitudes /
  CNRS.
- **URL:** <https://cdsarc.cds.unistra.fr/ftp/cats/VI/81/> — files `VSOP87D.ear`
  (SHA-256 `8b160c859136d467f2be7fc29efa8a9652e95516dfbde00e4c739d7ddc90ca91`),
  `vsop87.chk`, `vsop87.txt`, `ReadMe`.
- **Retrieved:** 2026-09-23
- **Licence:** CDS/VizieR data are freely usable with acknowledgement of the Centre de
  Données astronomiques de Strasbourg and citation of Bretagnon & Francou (1988).
  Compatible with this workspace's MIT OR Apache-2.0.
- **Stated accuracy (from `vsop87.txt`):** relative precision `p0 = 0.6e-8` for the
  Earth, about 0.0012 arcseconds, with 1 arcsecond held for 4000 years either side of
  J2000. The time argument is dynamical time, which the notice states may be taken as
  TT; `skyfix_core::time::jd_tt` supplies it.
- **Truncation applied, and the rule:** a term `A tau^n cos(B + C tau)` is kept when its
  peak contribution over the coverage window, `|A| * tau_abs^n` with
  `tau_abs = 0.061001` (2061-01-01), exceeds a per-variable threshold. The thresholds
  were chosen so that the **sum of the peak contributions of every dropped term** — a
  worst case that assumes they all align, not an RMS estimate — stays inside a budget of
  0.05" for `L` and `B` and 1e-7 au for `R`.

  | | threshold | dropped, worst case | measured max error, 1990-2060 |
  |---|---|---|---|
  | `L` | 1.5625e-9 rad | 0.0441" | **0.0073"** |
  | `B` | 4.7684e-9 rad | 0.0452" | **0.0135"** |
  | `R` | 7.4506e-10 au | 9.0e-8 au | **1.6e-8 au** (1.5e-5" of semidiameter) |

  **1020 of 2425 terms are kept.** The generator is a development-time Python script;
  it is not in the repository because it is not reproducible without the 317 kB source
  file, and re-running it is a matter of re-fetching `VSOP87D.ear` and applying the rule
  above. The embedded file records the rule, the thresholds and both error figures in
  its `truncation` block.
- **Verification that the transcription is right:** the data file ships nine
  `checkpoints`, the first of which is the value published in the catalogue's own
  `vsop87.chk` (`VSOP87D EARTH JD2451545.0`: `l 1.7519238681`, `b -.0000039656`,
  `r .9833276819`). `skyfix_ephemeris::sun::vsop87_self_check` re-evaluates the embedded
  series at all nine and is asserted in two tests. The full untruncated series reproduces
  the published check value to 0.00001".

### Solar constants

Cited in the source; no licence attaches to a published constant.

- Semidiameter at unit distance **959.63"** and equatorial horizontal parallax at unit
  distance **8.794"** — the Astronomical Almanac / IAU values, applied as `959.63"/R`
  and `8.794"/R` (CONVENTIONS section 5, steps 4 and 5).
- Aberration applied as **-20.4898"/R** in longitude, which to this order also carries
  the Sun's light-time (CONVENTIONS section 7).

### Meeus, *Astronomical Algorithms*, 2nd edition (Willmann-Bell, 1998)

- **What is used:** the VSOP87-to-FK5 rotation of chapter 25 (equation 25.9:
  `-0.09033"` in longitude, `+0.03916" (cos L' - sin L')` in latitude), the equation of
  time of chapter 28 (equation 28.1, with the Sun's mean longitude from 28.2), and four
  worked examples used as test cases:
  - **25.b** (1992 October 13.0 TD, the high-accuracy method): apparent longitude
    `199d 54' 21".56`, apparent RA `13h 13m 30s.749`, apparent Dec `-7d 47' 01".74`,
    radius vector `0.99760853 au`, `dpsi = +15".908`, `deps = -0".308`. This crate
    reproduces the RA and Dec to better than 0.1".
  - **25.a** (the same instant by the low-accuracy method, stated good to 0.01 deg):
    apparent longitude `199.90895 deg`, RA `13h13m31.4s`, Dec `-7d47'06"`. Used only to
    pin how far the two methods are apart (10.7" in longitude, 4.3" in declination).
  - **28.b**: equation of time `+13m 42s.6`.
  - **22.a** (1987 April 10.0 TD): `dpsi = -3".788`, `deps = +9".443`, mean obliquity
    `23d 26' 27".407`, true obliquity `23d 26' 36".850`.
- **Licence:** the book is copyrighted; the formulae and the published numbers of the
  worked examples are facts used as a reference, not reproduced text. No code was
  copied.

### Season instants used as sanity checks

`crates/skyfix-ephemeris/tests/sun_seasons.rs` uses the published 2026 equinox and
solstice instants (March 20 14:46 UTC, June 21 08:24 UTC, September 23 00:05 UTC,
December 21 20:50 UTC). They are *inputs*: the test asserts that the Sun's apparent
longitude is 0/90/180/270 deg at those instants, so an error in either the instants or
the model would show. No licence attaches to a published astronomical instant.

### Fixture packs — no third-party data

`fixture_pack.rs` carries no embedded data at all. It loads a `skyfix.almanac_pack/1`
document handed to it by the caller, and every pack must record its own `generator`
block (tool, ephemeris, Earth-orientation assumptions). The interpolation error the
provider adds on top of whatever the pack's source achieved is measured in
`crates/skyfix-ephemeris/tests/fixture_pack_interpolation.rs` and recorded in the
`fixture_pack` module documentation. The synthetic lunar signal in that test is built
from the classical main terms of the lunar theory (equation of the centre 6.289 deg,
evection 1.274 deg, variation 0.658 deg, and smaller terms) purely to give the
interpolator realistic curvature; **it is not an ephemeris and is not used as one.**
