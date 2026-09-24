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

### Verification against the Skyfield reference fixture

`crates/skyfix-ephemeris/tests/reference_fixtures_sun.rs` compares `SunProvider`
against `fixtures/reference/geocentric_sun_stars.json` (Skyfield + JPL DE421, with
DE440s for the one epoch outside DE421's coverage) at all 58 epochs, judged at the
`generator.tolerance_arcmin` of 0.05' the file records. Worst deviation over those
epochs:

| quantity | worst | where |
|---|---|---|
| GHA, DUT1 = 0, vs `gha_deg_dut1_zero` | 0.0026' = 0.16" | 2055-01-01 |
| GHA, the epoch's DUT1 supplied, vs `gha_deg` | 0.0026' = 0.16" | 2055-01-01 |
| Dec | 0.0012' = 0.07" | 2028-02-29 |
| RA of date | 0.0026' = 0.16" | 2055-01-01 |
| semidiameter | 0.00005' | 2027-01-01 |
| horizontal parallax | 0.00005' | 2003-01-01 |
| radius vector (VSOP87D vs the JPL kernel) | 6.2e-8 au | 2023-01-01 |

This is an independent check in every sense that matters: a different ephemeris
(JPL numerical integration rather than the VSOP87 analytical fit), a different
implementation, a different language. The file's DUT1 runs to -3.52 s, worth 0.88'
of GHA, so the DUT1 = 0 column is the one a CONVENTIONS section 6 implementation
must be judged on; the second row above additionally feeds each epoch's own DUT1 to
`SunProvider::with_dut1_s` and checks the other column, which is what proves the
DUT1 input is applied rather than ignored.

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

## Moon model

Owner: Moon agent (`crates/skyfix-ephemeris/src/moon.rs`,
`crates/skyfix-ephemeris/data/elp82b_moon_terms.json`,
`tools/reference/build_moon_series.py`, `tools/reference/gen_moon.py`,
`fixtures/reference/moon_geocentric.json`, `fixtures/reference/moon_topocentric.json`).

### ELP 2000-82B — the lunar theory

- **What is used:** the series of the semi-analytical lunar theory ELP 2000-82B with the
  constants its authors fitted to JPL DE200/LE200: the 36 files `ELP1` … `ELP36` (main
  problem; Earth-figure, planetary (tables 1 and 2), tidal, Moon-figure, relativistic
  and solar-eccentricity perturbations), truncated for 1990-2060 and embedded in
  `crates/skyfix-ephemeris/data/elp82b_moon_terms.json`. Every embedded record is a
  verbatim copy of a record of the CDS file (the informative period column is dropped).
  Also used, as published facts: the notice `elp82b.ps` — record formats (sect. 2), the
  arguments and constants (sect. 4-7, including the corrections fitted to DE200/LE200),
  the coordinate systems and the ecliptic-to-FK5 matrix (sect. 8: `ε_I = 23°26′21.40883″`,
  arc `γ_I γ_FK5 = 0.09845″`) and the check values of Table H — and the reference
  subroutine `elp82b.f`, whose evaluation order `moon.rs` follows. No code was copied;
  `moon.rs` and `build_moon_series.py` are independent implementations of the published
  model and reproduce all five Table H values (the complete series, in the builder) to
  0.005 m.
- **Source:** CDS catalogue **VI/79**, *Lunar Solution ELP 2000-82B*, Chapront-Touzé M.,
  Chapront J., Bureau des Longitudes: *A&A* **124**, 50 (1983, 1983A&A...124...50C) and
  *A&A* **190**, 342 (1988, 1988A&A...190..342C).
- **URL:** <https://cdsarc.cds.unistra.fr/ftp/cats/VI/79/> — `ELP1` … `ELP36`, `ReadMe`,
  `elp82b.f.gz`, `elp82b.ps.gz`. The SHA-256 of every file is pinned in
  `tools/reference/build_moon_series.py` and repeated in the data file's
  `source.sha256` (e.g. `ELP1` `ae30cbffb83a7bd4582a83a32a322d08a48ba057a4df7bf9dd5df9f06b1688fa`,
  `ELP10` `dbd82ddc6064e4cc7b4f08fa27b2fcb48f82456ad36a850a0d3ddae098c3e2e6`).
- **Retrieved:** 2026-09-24.
- **Licence / terms:** the CDS declares **no catalogue-specific licence** for VI/79
  (checked 2026-09-24 in the catalogue page's metadata, which for comparison declares
  `CC-BY-NC-3.0 IGO` for the Hipparcos catalogue I/239), and the VI/79 `ReadMe` carries no
  copyright statement. The VizieR rules of usage
  (<https://cds.unistra.fr/vizier-org/licences_vizier.html>) apply: the data are free of
  usage in a scientific context provided the authors, the original articles and VizieR
  are cited; commercial usage is "subject to rules depending of the origin" (the
  `ReadMe`, then the originating journal's policy — here *A&A*). This is exactly the
  standing of VSOP87 (VI/81, same institute, same journal, also without a declared
  licence), which the project already embeds. The embedded file is 5 % of the theory's
  terms, and the terms are the numerical results of a published scientific theory.
  **Attribution carried here and in the data file:** Chapront-Touzé & Chapront (1983,
  1988), ELP 2000-82B, obtained from the CDS, Strasbourg (VizieR catalogue VI/79,
  DOI 10.26093/cds/vizier). If the project ever needs a formal clearance for commercial
  redistribution, one request to the IMCCE / CDS would cover both VSOP87 and ELP 2000-82B.
- **Truncation applied, and the rule:** a term is kept when its peak contribution over
  1990-2060, `|A| · |t|max^p` (`|t|max` = 0.61 Julian centuries, `p` the power of `t`
  multiplying its series), reaches **0.002″** in longitude or latitude or **0.01 km** in
  distance. **2023 of 37 872 terms are kept** (786 of the main problem). Measured against
  the complete theory at 20 000 random epochs: **0.134″ in longitude, 0.113″ in latitude,
  0.35 km in distance, 0.134″ in direction.** The sum of the peak contributions of every
  dropped term, a bound that assumes they all align, is 1.94″, 1.04″ and 3.4 km. The
  builder records the rule, the thresholds and all these figures in the data file's
  `truncation` block, plus checkpoints of both the complete theory (Table H) and the
  truncated series, which `skyfix_ephemeris::moon::elp82b_self_check` re-evaluates in a
  unit test. Size: 125 kB of JSON.
- **Why ELP 2000-82B and not ELP/MPP02:** ELP/MPP02 (Chapront & Francou 2003) was the
  first choice, but its only official distribution, `cyrano-se.obspm.fr` (Observatoire de
  Paris), refused FTP, HTTP and HTTPS connections from this machine on 2026-09-24; the
  IMCCE FTP server (`ftp.imcce.fr/pub/ephem/moon/`) carries ELP 2000-82B but not
  ELP/MPP02, and the Internet Archive holds only the directory listing (2025-05-27), not
  the files. Unofficial copies on GitHub exist but were not used. ELP 2000-82B turned out
  to be ample: the complete theory, run through this project's frame chain, stays within
  0.72″ of DE440s over 1990-2061 (a secular drift of its DE200-fitted mean longitude,
  about `0.37″ t + 0.99″ t²`, t in centuries from J2000), against a 6″ target.

### Constants and formulae around the theory

Cited in the source; no licence attaches to a published constant or formula.

- Earth's equatorial radius **6378.14 km** (IAU 1976, the value ELP 2000-82B uses) for the
  horizontal parallax `HP = asin(6378.14 km / d)`.
- Lunar radius ratio **k = 0.2725076** (IAU 1982; the value of the *Explanatory
  Supplement* and of the NASA eclipse canons for the mean lunar limb) for the
  semidiameter `SD = asin(k · 6378.14 km / d)`.
- IAU 2006 frame bias from the Fukushima-Williams angles already in `frames.rs` (ERFA
  `pfw06`, see above), used to take the theory's J2000 frame to the GCRS.
- Meeus, *Astronomical Algorithms*, 2nd ed., eq. 48.3 (phase angle from elongation and
  the two distances) and eq. 48.5 (position angle of the bright limb). Formulae only.
- Lunar magnitude, **approximate**: `V = −12.73 + 0.026 |i| + 4×10⁻⁹ i⁴` (i the phase angle
  in degrees) at mean distance, Krisciunas K., Schaefer B. E., 1991, *PASP* **103**, 1033,
  after Allen's *Astrophysical Quantities*; the same law appears as eq. 15 of Noll S. et
  al., 2012, *A&A* **543**, A92, which is where the coefficients were confirmed on
  2026-09-24. Scaled here by the inverse-square law to the actual Earth-Moon distance
  (mean 384 400 km) and Sun-Moon distance (1 au).

### Reference fixtures for the Moon

`fixtures/reference/moon_geocentric.json` and `moon_topocentric.json` are generated by
`tools/reference/gen_moon.py` from Skyfield and the JPL kernels listed under "Reference
data" below, with **DE440s as the primary ephemeris and DE421 as the cross-check** (the
reverse of the older files; DE421 ends in 2053). The two kernels agree on the Moon's
apparent direction to 0.0061″ and on its distance to 0.9 m over the 1515 instants both
cover. The topocentric file is built with UT1 = UTC by giving each leap-second era its own
Skyfield timescale with a constant ΔT of `32.184 s + (TAI − UTC)`
(`load.timescale(delta_t=…)`). The Moon record already stored in the USNO response
(`usno_celnav_2026-10-01T0130Z.json`, see "US Naval Observatory API" below) is used as a
second, independent check by `tests/moon_reference.rs`; see `docs/ACCURACY.md`, "Moon",
for what it showed.

## Planet model

Owner: planets agent (`crates/skyfix-ephemeris/src/planets.rs`,
`crates/skyfix-ephemeris/data/vsop87a_planets.json`, `tools/reference/gen_vsop87a.py`,
`tools/reference/gen_planets.py`, `fixtures/reference/planets_*.json`). Added
2026-09-24.

### VSOP87A — heliocentric Mercury to Neptune, and the Earth

- **What is used:** the coefficients of the VSOP87 version A series (heliocentric
  rectangular X, Y, Z in au, dynamical ecliptic and equinox J2000, argument TT) for the
  **Earth** and the seven planets, truncated for 1990-2060 and embedded in
  `crates/skyfix-ephemeris/data/vsop87a_planets.json` (schema
  `skyfix.vsop87a_trunc/1`, 277.5 kB). Also the ecliptic-to-equator rotation and the
  time-scale statement in `vsop87.txt`, and the VSOP87A check values in `vsop87.chk`.
  The Earth series is `VSOP87A.ear`, **not** the Earth-Moon barycentre `VSOP87A.emb`,
  which is up to 4 700 km from the Earth (several arcseconds of Venus near inferior
  conjunction). The Sun keeps its own VSOP87D Earth series (previous section); the two
  are the same theory of the same body.
- **Source:** CDS catalogue **VI/81**, *Planetary Solutions VSOP87*, Bretagnon P.,
  Francou G. (1988), *A&A* **202**, 309 (1988A&A...202..309B). Bureau des Longitudes /
  CNRS. The same catalogue as the Sun's series.
- **URL:** <https://cdsarc.cds.unistra.fr/ftp/cats/VI/81/>
- **Retrieved:** 2026-09-24. Stored for regeneration in `tools/reference/data/vsop87/`
  (git-ignored); `gen_vsop87a.py` refuses files with other checksums:

  | file | bytes | SHA-256 |
  |---|---|---|
  | `VSOP87A.ear` | 472 948 | `69d0b4c7525f094a03099e64558321eb64f2402a478472ee537239bcc59b7cb6` |
  | `VSOP87A.mer` | 848 141 | `01f6f82af31f347fc50affaa920d653e441fc74f2b4738166528adc4c78fa870` |
  | `VSOP87A.ven` | 315 875 | `ecaeceff071db6692820d962ffabfdb7de438db44145bfe0cbcda70f8dbed2a8` |
  | `VSOP87A.mar` | 943 103 | `2c1e9b5cd68276138c2f99506d348e626abe0a5c600b4e50bb588d568b0d13fe` |
  | `VSOP87A.jup` | 592 116 | `212bcea552e759fa0a9d732680c05120de2c15d36049b2f6d115ceb25b03d405` |
  | `VSOP87A.sat` | 1 001 490 | `2e72d18684246e2ecd143e35736b45b101cdd06bbcaf2f2502e348c233abff29` |
  | `VSOP87A.ura` | 705 299 | `6fb9626c770eb9972a86050e151cc866e703f503261c79ba0691160e727bf0b9` |
  | `VSOP87A.nep` | 352 450 | `4ad09bd799336d8f76dcf6f98be57c45d7289db134556c204f098d6bbf888f3a` |
  | `vsop87.chk` | 104 341 | `f8fa52449262be05a22a96840c1acbad0b35c8999e00b5c0477ba8a91a67a51a` |
  | `vsop87.txt` | 14 046 | `8e2067276413f2feffde70a4292d8b3dc70b8c0355ff5d00a7ccdf4c3af5f121` |

- **Licence:** as for the Sun's series: CDS/VizieR data, freely usable with
  acknowledgement of the Centre de Données astronomiques de Strasbourg and citation of
  Bretagnon & Francou (1988). Compatible with this workspace's MIT OR Apache-2.0.
- **Stated accuracy (`vsop87.txt`):** 1" over 4000 years around J2000 for Mercury to
  Mars, 2000 years for Jupiter and Saturn, 6000 years for Uranus and Neptune; the
  series were fitted to JPL DE200. Against DE440s over 1990-2060 the full series are
  0.08-0.12" (geocentric) for Mercury to Mars, 0.3-0.4" for Jupiter and Saturn, and
  1.5" and 2.2" for Uranus and Neptune: DE200's outer-planet orbits, not a flaw of the
  series expansion. `docs/ACCURACY.md`, "Planets", has the measured figures.
- **Frame:** `vsop87.txt` gives the rotation from the VSOP87A ecliptic to "FK5" J2000.
  The frame it produces is DE200's; fitting it against DE440s gives per-planet
  residual rotations of 1-28 mas that are not a common frame offset, and applying the
  FK5-to-ICRS bias of Mignard & Froeschlé (2000) makes the fit worse, so no further
  rotation is applied and the result is treated as ICRS-aligned.
- **Truncation, and the rule:** `tools/reference/gen_vsop87a.py`. A term
  `A T^n cos(B + C T)` is kept when its peak contribution over the window,
  `|A| T_abs^n` (window 1989-12-31 to 2061-01-02 TT, the coverage plus a day either
  side for light-time), exceeds a per-body threshold. The threshold is the largest for
  which the vector sum of every dropped term, evaluated every day of the window, stays
  within 90 % of the body's budget; the result is then re-measured every 6 hours and
  must stay within the budget. The budget is 0.2" of geocentric direction at the
  body's closest approach to the Earth in the window (for the Earth itself, the
  closest approach of any planet, Venus at 0.264 au). Unlike the Sun's file, the rule
  judges the *measured* error rather than the sum of the dropped amplitudes: that sum
  is about ten times the error that actually occurs and would have needed two to three
  times as many terms.

  | body | terms kept | of | measured heliocentric error | geocentric, worst |
  |---|---|---|---|---|
  | Earth | 679 | 3 538 | 2.25e-7 au | (in each planet's figure) |
  | Mercury | 389 | 6 359 | 4.78e-7 au | 0.128" |
  | Venus | 395 | 2 357 | 2.28e-7 au | 0.226" |
  | Mars | 1 525 | 7 073 | 3.25e-7 au | 0.173" |
  | Jupiter | 840 | 4 434 | 3.36e-6 au | 0.163" |
  | Saturn | 1 108 | 7 512 | 7.00e-6 au | 0.160" |
  | Uranus | 691 | 5 289 | 1.48e-5 au | 0.146" |
  | Neptune | 215 | 2 636 | 2.42e-5 au | 0.166" |
  | **total** | **5 842** | **39 198** | | |

  The geocentric column combines the planet's and the Earth's truncation at the actual
  geometry, every 6 hours over the window (103 741 epochs). The Earth's velocity, used
  for aberration, is within 2.8e-8 au/day of the full series (5 cm/s, 0.00003" of
  aberration).
- **Verification that the transcription is right:** the full series reproduce every
  `vsop87.chk` value at J2000 (position and velocity) to its printed 10 decimals before
  truncation, or the generator stops. The data file carries 72 checkpoints — the
  catalogue's own J2000 value and eight full-series values across the window for each
  body — and `planets::vsop87a_self_check` re-evaluates the embedded series at all of
  them in a unit test. The generator also compares the embedded series with DE440s
  every day of the window and records the result in the file (`dense_vs_de440s`).

### Planetary magnitudes — Mallama & Hilton (2018)

- **What is used:** the apparent-magnitude formulas (equations 2-4, 6-12 and 14-17) of
  A. Mallama and J. L. Hilton, "Computing apparent planetary magnitudes for The
  Astronomical Almanac", *Astronomy and Computing* **25**, 10-24 (2018),
  arXiv:1808.01973, with the branch limits that `skyfield.magnitudelib` (Skyfield 1.55,
  MIT) applies. Published formulas and coefficients are facts; the Rust is written from
  the paper and checked against Skyfield, not copied.
- **Test values:** the paper's own test data (`Ap_Mag_Output_V3.txt` of its
  supplementary code, as reproduced in Skyfield's `test_magnitudes_raw.py`) are used as
  unit-test inputs in `planets.rs`: published r, delta, phase angle and V for each
  planet. Numbers, not code.
- **Where this differs from Skyfield:** Skyfield's `planetary_magnitude` treats the
  solar-system barycentre as the Sun (its source says so); this crate uses the Sun, as
  the paper defines r and the phase angle. `docs/ACCURACY.md` quantifies the
  difference (up to 0.21 mag at the fixture epochs, for Mercury as a thin crescent).

### Physical constants

Cited in the source; no licence attaches to a published constant.

- **Planet equatorial radii** for semidiameters: IAU WGCCRE 2015, B. A. Archinal et al.,
  "Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements:
  2015", *Celest. Mech. Dyn. Astron.* **130**:22 (2018), table 1: Mercury 2440.53 km,
  Venus 6051.8, Mars 3396.19, Jupiter 71 492, Saturn 60 268, Uranus 25 559, Neptune
  24 764 km.
- **Saturn and Uranus pole directions** (ring tilt and sub-latitude terms of the
  magnitude): the same report, J2000 values (Saturn 40.589 deg, +83.537 deg; Uranus
  257.311 deg, -15.175 deg), the same unit vectors Skyfield's `magnitudelib` uses.
- **Earth equatorial radius** for horizontal parallax: WGS84, 6378.137 km (as
  `topocentric::WGS84_A_KM`).
- **Solar radius** for the behind-the-Sun deflection cap: IAU 2015 Resolution B3 nominal
  value, 695 700 km.
- **GM of the Sun, c, au:** IAU 2009 `GM_sun` 1.32712440041e20 m^3 s^-2, exact `c`,
  IAU 2012 au (the same values `frames.rs` uses).

### Algorithms

- **Gravitational light deflection for a source at finite distance:** the formula of
  NOVAS `grav_vec` (US Naval Observatory; public domain as a US Government work), in
  the form Skyfield writes it (`skyfield.relativity._compute_deflection`, MIT).
  Re-implemented in Rust from the formula, not translated line by line.
- **Bright-limb position angle:** Meeus, *Astronomical Algorithms*, 2nd ed.,
  equation 48.5 (a published formula).
- **Annual aberration, bias-precession-nutation and sidereal time:** this crate's
  `frames` and `sidereal` modules (see "Star catalogue and frame models").

### Reference fixtures

`fixtures/reference/planets_<planet>.json` are generated by
`tools/reference/gen_planets.py` from Skyfield 1.55 with **JPL DE440s as the primary
ephemeris** (the explorer's reference, `docs/EXPLORER_PLAN.md`) and DE421 as the
cross-check, both the files listed under "Downloaded data files" below. Nothing new is
downloaded for them.

## Reference data (development-time only)

Sources used by `tools/reference/` to generate `fixtures/reference/*.json` and
the `reference-*` files in `fixtures/sessions/` and `fixtures/expected/`.

**None of this is a runtime dependency.** No SkyFix Lab binary links, loads,
downloads or ships any of it. The Rust workspace reads the generated JSON only.
Retrieval date for everything below: **2026-09-23**.

### Downloaded data files — git-ignored, never committed

Stored in `tools/reference/data/`, which is in `.gitignore`. About 100 MB.

| File | URL | Size (bytes) | SHA-256 | Publisher / licence |
|---|---|---|---|---|
| `de421.bsp` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/a_old_versions/de421.bsp` | 16 790 528 | `08b20db2ae22488650641c5a9033e5bfda4b1c4b440cfeaf20f621cfa18ecdb3` | NASA JPL / NAIF. Work of the US Government; NAIF generic kernels are distributed for unrestricted use. Coverage 1899-07-28 to 2053-10-08. |
| `de440s.bsp` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp` | 32 726 016 | `c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2` | NASA JPL / NAIF, same terms. The cross-check of DE421 for the Sun and stars, and the **primary** reference for the Moon, the planets and the explorer's events (DE421 is the cross-check there); also covers the epochs DE421 does not. Coverage 1849-12-25 to 2150-01-21. |
| `hip_main.dat` | `https://cdsarc.cds.unistra.fr/ftp/cats/I/239/hip_main.dat` | 53 316 318 | `58ceabb104d647160d9437ce6e513a02a036bb4ad9f8879a5a22fd52943616e0` | ESA (1997), *The Hipparcos and Tycho Catalogues*, ESA SP-1200. Served by CDS/VizieR as catalogue I/239. **VizieR declares its licence as `CC-BY-NC-3.0 IGO`** — see the open question below. |

`de421.bsp` is the primary ephemeris, as the project brief specifies. It is no
longer in NAIF's current `spk/planets/` directory and now lives under
`a_old_versions/`; the URL above is the working one as of the retrieval date.

### Python packages

Pinned in `tools/reference/requirements.txt`. Installed into
`tools/reference/.venv/`, which is git-ignored.

| Package | Version | Licence | Role |
|---|---|---|---|
| `skyfield` | 1.55 | MIT | apparent places, timescale, refraction, alt/az |
| `numpy` | 2.5.3 | BSD-3-Clause (with 0BSD, MIT, Zlib, CC0-1.0 components) | Skyfield's array backend |
| `pandas` | 3.0.6 | BSD-3-Clause | required only by `skyfield.data.hipparcos.load_dataframe()` |
| `jplephem` | 2.24 | MIT | reads the `.bsp` kernels |
| `certifi` | 2026.7.22 | MPL-2.0 | transitive |
| `python-dateutil` | 2.9.0.post0 | Apache-2.0 / BSD-3-Clause (dual) | transitive |
| `sgp4` | 2.27 | MIT | transitive via Skyfield; unused here |
| `six` | 1.17.0 | MIT | transitive |

Generated under CPython 3.12.3, Linux x86_64.

### Earth-orientation data (bundled inside Skyfield)

`load.timescale(builtin=True)` uses `skyfield/data/iers.npz`, shipped inside the
Skyfield 1.55 wheel under Skyfield's MIT licence. It is a daily ΔT table derived
from the IERS `finals2000A.all` series; in this build it spans **1973-01-01 to
2027-01-23**, and outside that range Skyfield extrapolates with its long-term
ΔT model. No polar-motion table is installed. Nothing is downloaded at
generation time for timescales.

### US Naval Observatory API

| Item | Value |
|---|---|
| Endpoint | `https://aa.usno.navy.mil/api/celnav?date=2026-10-01&time=01:30:00&coords=39.9526,-75.1652` |
| Documentation | `https://aa.usno.navy.mil/data/api` |
| `apiversion` returned | `4.0.1` |
| Retrieved | 2026-09-23 |
| Stored as | `fixtures/reference/usno_celnav_2026-10-01T0130Z.json` (verbatim response plus our comparison) |

Produced by the US Naval Observatory, Astronomical Applications Department, a US
Government agency; works of the US Government are not subject to copyright
protection in the United States (17 U.S.C. § 105), which is the basis on which
the response is stored in this repository.

**Not verified:** the documentation page is rendered client-side and no
machine-readable terms-of-use or licence statement could be retrieved on the
date above. Confirm with USNO before redistributing this file outside the
project. Note also that `aa.usno.navy.mil` resets connections from unfamiliar
`User-Agent` strings, which is why `tools/reference/gen_usno.py` shells out to
`curl` rather than using `urllib` directly.

A second set of responses from the same API checks the Moon and planet sights
(`docs/NAVIGATION_SKY.md`):

| Item | Value |
|---|---|
| Endpoint | `https://aa.usno.navy.mil/api/celnav?date=…&time=…&coords=…`, 25 queries: 12 for Venus (2026-02-20 to 2027-01-03), 5 for Mars, 8 for the Moon |
| Documentation | `https://aa.usno.navy.mil/data/celnav` (states that Venus is corrected for phase to its centre of light, and that the Moon's SD includes augmentation) |
| Retrieved | 2026-09-24 |
| Stored as | `fixtures/reference/usno_celnav_venus_phase.json`: the Venus, Mars and Moon entries of each response (GHA, Dec, and for the Moon Hc, Zn and the altitude corrections) verbatim, beside Skyfield + DE440s values and the fit, by `tools/reference/gen_usno_sights.py` |

Same basis and the same caveat as above. The Nautical Almanac's explanation is quoted
(one sentence, on Venus's phase and the Venus and Mars additional corrections) as
reported on NavList, "Additional altitude correction for Venus" (May 2015,
`navlist.net`); the Almanac itself was not consulted directly.

### Hipparcos licence vs the project's MIT/Apache-2.0 licence — DECIDED

**Decision by the project owner, 2026-09-24: keep the 58-row extract, with the
attribution below.** The reasoning: the rows are individual astrometric measurements
(facts), the extract is 58 of 118 218 entries and six of 78 fields, the raw catalogue is
never redistributed, and ESA and CDS are credited wherever the data appear. Expanding to
a substantial part of the catalogue would reopen this question and would need either
ESA/CDS confirmation of the terms or a permissively licensed source.

**Attribution:** This product uses data from the Hipparcos catalogue, ESA (1997), *The
Hipparcos and Tycho Catalogues*, ESA SP-1200, as served by the Centre de Données
astronomiques de Strasbourg (CDS/VizieR, catalogue I/239).

The original analysis, kept for the record:

`fixtures/reference/navigational_stars_hip.json` **is committed** and contains
58 rows copied verbatim out of `hip_main.dat`: for each star, `ra_deg`,
`dec_deg`, `pm_ra_cosdec_mas_yr`, `pm_dec_mas_yr`, `parallax_mas` and `mag`.
That is 58 of the catalogue's 118 218 entries and six of its 78 fields.

CDS/VizieR declares catalogue I/239 as **`CC-BY-NC-3.0 IGO`** (Creative Commons
Attribution-NonCommercial 3.0 IGO). SkyFix Lab is dual MIT / Apache-2.0. A
non-commercial restriction is not compatible with either.

The considerations, stated without pretending to a legal opinion:

* The underlying catalogue is an ESA science product (ESA SP-1200, 1997). The
  `CC-BY-NC-3.0 IGO` tag is CDS/VizieR's declaration for the catalogue as
  *served by VizieR*; it is not obviously ESA's own condition on the Hipparcos
  results, and the two may differ.
* Individual astrometric measurements are facts. Whether a 58-row, six-field
  extract is a protected part of a database — and whether an EU *sui generis*
  database right applies at all — is a question for a person, not for this
  generator.
* The raw catalogue itself is git-ignored and is never redistributed.

Options, cheapest first:

1. Keep the extract, attribute ESA and CDS prominently, and record the NC tag.
   Acceptable only if the project accepts the restriction or concludes the
   extract is not protected.
2. Replace the six catalogue columns with a source whose terms are
   unambiguously permissive. The Nautical Almanac's own SHA/Dec tables are a US
   Government work; Gaia DR3 is published by ESA under CC BY 4.0 (but does not
   contain most of these stars, which are too bright for Gaia). The cost is that
   proper motion and parallax would have to come from somewhere too, and the
   `name → HIP` mapping is itself the useful part of the file.
3. Keep the file for development, and strip or replace it at release.

Attribution to carry in any case: *ESA (1997), The Hipparcos and Tycho
Catalogues, ESA SP-1200*, obtained from the VizieR catalogue access tool, CDS,
Strasbourg, France (DOI: 10.26093/cds/vizier).

## Explorer (browser) dependencies

Added 2026-09-24 for the explorer redesign (`docs/EXPLORER_PLAN.md`). Bundled into the
site by Vite; nothing is loaded from a CDN.

| Package | Version | Licence | Use | Obligation |
|---|---|---|---|---|
| `maplibre-gl` | 6.11.2 | BSD-3-Clause | Map and globe rendering | Keep the copyright notice and licence text with redistributions (in the bundle's licence comment and this file); no on-screen credit required |
| `@fontsource-variable/inter` | 5.3.0 | SIL Open Font License 1.1 | Interface typeface (Inter, Rasmus Andersson) | Ship the licence with the font files; the font may not be sold on its own |
| `@fontsource-variable/jetbrains-mono` | 5.3.0 | SIL Open Font License 1.1 | Figures and coordinates (JetBrains Mono) | As above |

### Data that needs no credit, by the owner's preference (2026-09-24)

The owner asked for star and constellation data that needs no credit where possible.
The plan (details recorded by the star-field and map-data agents as they land):

- **Stars:** NASA HEASARC's `BSC5P` table (Yale Bright Star Catalogue, 5th revised
  edition, as served by HEASARC). NASA's open-data catalogue lists this dataset with the
  licence *U.S. Government Works* (<https://catalog.data.gov/dataset/bright-star-catalog>,
  checked 2026-09-24). Star positions and magnitudes are also measurements, which are
  facts. The compilers (Hoffleit & Warren, 1991) are cited in the documentation as a
  courtesy, not as a licence obligation.
- **Constellation figures:** drawn by this project, so they are covered by the project's
  own MIT OR Apache-2.0 licence.
- **Constellation boundaries:** the IAU definitions of Delporte (1930), which are
  published definitions (facts) and in the public domain by age.
- **Offline basemap and gazetteer:** Natural Earth, public domain; Natural Earth states
  that crediting it is unnecessary.
- **Optional street layer:** OpenStreetMap tiles are ODbL data and **do** require the
  on-map credit "© OpenStreetMap contributors" whenever that layer is shown. It is off
  by default.

## Mock explorer engine (interface development only)

Owner: shell-core agent (`web/src/next/engine/mock.ts`, `web/src/next/engine/mock/`).
Added 2026-09-24. The mock is reachable only with `?engine=mock`, or on a development
server whose WebAssembly build lacks the explorer; it says on screen that its numbers
are illustrative and is never a source of results (EXPLORER_PLAN 3.1). It ships as a
separate chunk that a normal page load never downloads. Nothing below is a runtime
dependency of the real engine, and no third-party code was copied.

- **Published formulas, used as algorithms (no data files):** the Astronomical
  Almanac's low-precision formulas for the Sun (section C) and the Moon (section D);
  from Meeus, *Astronomical Algorithms* (already listed above), the IAU 1976
  precession angles (21.2-21.4), Greenwich mean sidereal time (12.4), the planetary
  magnitude formulas (chapter 41), the parallactic angle (14.1) and the position angle
  of the bright limb (48.5); Saemundsson's refraction as CONVENTIONS 13.2 states it.
- **JPL approximate planetary elements:** E. M. Standish, "Keplerian Elements for
  Approximate Positions of the Major Planets", Table 1 (valid 1800-2050),
  <https://ssd.jpl.nasa.gov/planets/approx_pos.html>. The 48 element values and rates
  are transcribed as published (facts); no download is involved. Checked during
  development against Skyfield with DE421 on four dates: planets within 5', Sun 0.4',
  Moon 7' (the mock's coverage table claims 10', 1' and 30').
- **The 58 navigational stars:** no new data. The existing Hipparcos extract
  (`fixtures/reference/navigational_stars_hip.json`; attribution and the owner's
  decision in the Hipparcos sections above) propagated from J1991.25 to J2000.0 with
  its proper motions and rounded to 0.0001 deg; `web/test/next/mock-engine.test.ts`
  pins the table to the fixture. B-V colours are approximate and illustrative.
- **Fourteen more bright stars** (Mintaka, Alnitak, Saiph, Meissa, Merak, Phecda,
  Megrez, Mizar, Mimosa, Imai, Caph, Navi, Ruchbah, Segin), so four figures can be
  drawn: approximate J2000 positions rounded to 0.01 deg and magnitudes, written from
  general reference knowledge (facts), not copied from a catalogue file. Illustrative.
- **Synthetic stars:** generated with a seeded pseudo-random generator; no source.
- **Constellation figures** (Orion, the Plough in Ursa Major, Crux, Cassiopeia): drawn
  by this project. The zodiac look-up uses approximate ecliptic longitudes (0.1 deg)
  where the IAU boundaries cross the ecliptic, from general reference knowledge;
  illustrative only.
