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

## Explorer events: rise, set, twilight, seasons, Moon phases

Owner: events agent (`crates/skyfix-almanac/src/{events,sky}.rs`,
`tools/reference/gen_events.py`, `fixtures/reference/events_*.json`). Retrieved
2026-09-24. Development-time reference data only: nothing here is linked into or
shipped with any binary.

### Skyfield + JPL DE440s — `events_{sun,stars,moon_planets,seasons,moon_phases}.json`

Generated by `tools/reference/gen_events.py` from the same Skyfield 1.55, JPL DE440s
(DE421 as a cross-check for seasons and Moon phases up to 2052) and Hipparcos
`hip_main.dat` already listed under "Reference data (development-time only)" above,
with the same licences. No new external data: the files are Skyfield's output for the
project's own definitions (CONVENTIONS 13.3 to 13.5), with UT1 = UTC.

### US Naval Observatory API — `events_usno.json`

| Endpoint | Used for |
|---|---|
| `https://aa.usno.navy.mil/api/rstt/oneday?date=YYYY-MM-DD&coords=LAT,LON&tz=0` | Sun and Moon rise, set, upper transit and civil twilight for 14 site-days |
| `https://aa.usno.navy.mil/api/moon/phases/year?year=YYYY` | Moon phases for 1990, 2000, 2026, 2045, 2060 |
| `https://aa.usno.navy.mil/api/seasons?year=YYYY` | Equinoxes and solstices for the same years |

Same terms and the same caveat as the `celnav` endpoint above: produced by the US Naval
Observatory, a US Government agency, and not subject to copyright in the United States
(17 U.S.C. § 105); no machine-readable terms of use could be retrieved. The file keeps
USNO's own values (to the minute) in the parts the tests use, with the query URL for
each site-day. `gen_events.py` fetches with `curl` (the service resets unfamiliar
`User-Agent` strings), waits a second between requests, and leaves the file untouched
if the service cannot be reached.

### Meeus, *Astronomical Algorithms*, 2nd edition, chapter 47 (test code only)

The synthetic test Moon in `crates/skyfix-almanac/tests/common/mod.rs` uses the mean
arguments and the largest periodic terms (14 in longitude, 7 in latitude, 5 in
distance) of Meeus's lunar theory, as published numbers. It exercises the Moon code
paths in tests independently of the real Moon provider (it was written while that was a
stub); it is never compiled into the library and makes no accuracy claim. No code was
copied.

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

## Navigation methods — worked examples and the Polaris table formula

Owner: navigation agent (`crates/skyfix-core/src/methods/`,
`fixtures/reference/bowditch_worked_examples.json`, `tools/reference/gen_nav_methods.py`).

### The American Practical Navigator (Bowditch), NGA Pub. No. 9

- **What is used:** the numbers of three worked examples, as test data only — volume 1
  (2019 edition), chapter 19 "Sight Reduction", section 1910 (latitude at local apparent
  noon, with its strip form, figure 1910), section 1912 (latitude by Polaris, with figure
  1912b) and figure 1912c (the Nautical Almanac 2016 Polaris-table page it reproduces,
  whose "ILLUSTRATION" block is the Almanac's own worked example). No text or figure is
  reproduced; the values are typed, with the book's rounding, into
  `fixtures/reference/bowditch_worked_examples.json` and cited in
  `docs/NAVIGATION_METHODS.md` section 6.2.
- **URL:** <https://msi.nga.mil/Publications/APN>; the chapter was read from the copy at
  <https://thenauticalalmanac.com/2019_Bowditch-_American_Practical_Navigator/Volume-_1/05-%20Part%203-%20Celestial%20Navigation/Chapter%2019-%20Sight%20Reductions.pdf>.
- **Retrieved:** 2026-09-24.
- **Licence:** a work of the U.S. Government (National Geospatial-Intelligence Agency),
  not subject to copyright in the United States (17 U.S.C. 105). No credit is required;
  it is cited as a source.

### The Nautical Almanac's Polaris-table formula

- **What is used:** the published formula behind the Almanac's Polaris tables —
  `Latitude − Ho = −p cos h + (1/2) p sin p sin² h tan(Latitude)` — and its split into
  `a0` (constant 58.8′, mean SHA and declination of Polaris, latitude 50°), `a1`
  (constant 0.6′, the latitude correction) and `a2` (constant 0.6′, the correction for
  the date), with `Latitude = Ho − 1° + a0 + a1 + a2`. A formula and its constants are
  facts; nothing is copied. Used only for the teaching terms `PolarisAlmanacTerms` in
  `crates/skyfix-core/src/methods/polaris.rs`; the latitude itself is solved rigorously.
- **Source:** the explanation of the Polaris tables in the Nautical Almanac (HM Nautical
  Almanac Office and the U.S. Naval Observatory), as quoted in the NavList thread
  "Latitude by Polaris" (<https://navlist.net/Latitude-Polaris-RonJones-mar-2016-g34952>),
  retrieved 2026-09-24. Checked against the 2016 table page in Bowditch figure 1912c:
  the formula with that year's mean position (computed from `skyfix-ephemeris`)
  reproduces the printed a0, a1 and a2 of both worked examples to 0.03′.

### Skyfield-generated truth for the methods

`tools/reference/gen_nav_methods.py` uses exactly the development-time inputs recorded
under "Reference data (development-time only)" above (Skyfield, JPL DE421, Hipparcos);
it adds no new data source.

## Basemap and gazetteer

Owner: map-data agent (`tools/mapdata/**`, `web/public/data/**`, `web/src/next/geo/**`,
`web/test/next/geo-*.test.ts`). Everything here is **display-only** (CONVENTIONS 13.6): the
map, the place search, the "near ..." label and the time-zone guess never feed `reduce`,
`solve`, the planner or any accuracy claim.

**No OpenStreetMap, GeoNames or time-zone-boundary data** (the common
timezone-boundary-builder polygons are ODbL) is used. Both sources below are public domain,
so the offline map needs no credit on screen. The optional online street layer is the
map agent's and carries its own OSM credit.

### Sources

| Source | Version | URL | Retrieved | Licence |
|---|---|---|---|---|
| Natural Earth vector data (GeoJSON, from the official repository) | 5.1.2 | <https://github.com/nvkelso/natural-earth-vector/releases/tag/v5.1.2>, files from `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/` | 2026-09-24 | Public domain. Terms: <https://www.naturalearthdata.com/about/terms-of-use/> (read 2026-09-24): all Natural Earth data are in the public domain, no permission is needed to use them, and crediting the authors is unnecessary. |
| IANA time zone database (tzdata) | 2026d | <https://data.iana.org/time-zones/releases/tzdata2026d.tar.gz> | 2026-09-24 | Public domain (the archive's `LICENSE`: all tz code and data files used here are in the public domain) |

Every input file, with its SHA-256 and size, is pinned in `tools/mapdata/sources.json`. The
Natural Earth layers used: `ne_110m_land`, `ne_50m_land`, `ne_50m_lakes`,
`ne_50m_rivers_lake_centerlines`, `ne_50m_admin_0_boundary_lines_land`,
`ne_50m_admin_0_countries`, `ne_50m_admin_1_states_provinces`,
`ne_50m_geography_marine_polys`, `ne_50m_geography_regions_points`,
`ne_50m_geographic_lines`, `ne_50m_urban_areas`, `ne_50m_glaciated_areas`,
`ne_50m_antarctic_ice_shelves_polys`, `ne_10m_populated_places`. From tzdata: `zone.tab`
(each country's zones with the coordinates of each zone's principal location),
`iso3166.tab`, and the `Link` lines (old and alternative zone names).

### Reproducing

Development time only, Node 20 or later, network for the first command:

```sh
node tools/mapdata/fetch.mjs   # download into tools/mapdata/cache/ (git-ignored), verify SHA-256
node tools/mapdata/build.mjs   # rewrite web/public/data/basemap/* and web/public/data/gazetteer.json
```

The build is deterministic (two runs give byte-identical files). It checks the cleaned time
zones against the running Node's ICU data; the manifest records the version used
(Node 24.20.0, ICU 78.3, tz 2026c). No npm dependency was added.

### What was built

| File | Features | Vertices | Raw | Gzip | Precision (deg) | Simplified (deg) |
|---|---|---|---|---|---|---|
| `basemap/land-110m.geojson` | 127 | 5 384 | 88 KB | 28 KB | 0.01 | none |
| `basemap/coastline-110m.geojson` | 128 | 5 120 | 85 KB | 27 KB | 0.01 | none |
| `basemap/land-50m.geojson` | 1 419 | 55 242 | 1 022 KB | 310 KB | 0.001 | 0.005 |
| `basemap/coastline-50m.geojson` | 1 420 | 54 876 | 1 017 KB | 309 KB | 0.001 | 0.005 |
| `basemap/lakes-50m.geojson` | 411 | 11 196 | 237 KB | 68 KB | 0.001 | 0.01 |
| `basemap/rivers-50m.geojson` | 358 | 19 810 | 364 KB | 121 KB | 0.001 | 0.01 |
| `basemap/boundaries-50m.geojson` | 390 | 15 321 | 280 KB | 87 KB | 0.001 | 0.005 |
| `basemap/countries-50m.geojson` | 241 | 68 372 | 1 004 KB | 307 KB | 0.01 | 0.01 |
| `basemap/admin1-50m.geojson` | 249 | 46 557 | 702 KB | 194 KB | 0.01 | 0.01 |
| `basemap/urban-50m.geojson` | 2 143 | 22 000 | 547 KB | 117 KB | 0.001 | 0.01 |
| `basemap/glaciers-50m.geojson` | 376 | 11 539 | 223 KB | 66 KB | 0.001 | 0.01 |
| `basemap/ice-shelves-50m.geojson` | 64 | 3 785 | 71 KB | 22 KB | 0.001 | 0.01 |
| `basemap/marine-labels.geojson` | 118 | points | 17 KB | 2 KB | 0.01 | |
| `basemap/physical-labels.geojson` | 162 | points | 24 KB | 3 KB | 0.001 | |
| `basemap/geolines-50m.geojson` | 6 | 2 395 | 35 KB | 7 KB | 0.001 | none |
| `gazetteer.json` | 7 342 places | | 670 KB | 262 KB | 0.0001 | |
| **Total** | | | **6.54 MB** | **1.98 MB** (budget 3 MB) | | |

`basemap/manifest.json` lists the same with SHA-256s, sources and each layer's properties;
a test fails if a file and the manifest disagree or the budget is exceeded.

### Processing of the basemap

- **Precision and simplification.** Coordinates rounded (0.001 deg is 111 m); Douglas-Peucker
  with longitude scaled by cos(latitude), so a tolerance of 0.005 deg is about 550 m, one
  pixel at MapLibre zoom 7, where 1:50m data are already coarse. Consecutive duplicate
  vertices removed; rings that collapse at this scale dropped (one country, the Vatican,
  which lookups then treat as part of Italy).
- **Shared borders stay shared.** In `countries-50m` and `admin1-50m` every vertex where
  the set of polygons sharing it changes is kept, so each border is simplified identically
  on both sides: no slivers, no gaps (checked by rendering state fills).
- **Antimeridian.** Natural Earth splits polygons at +/-180; so does the output (RFC 7946
  section 3.1.9). Seam vertices at 179.999219 or -179.999951 are snapped to exactly +/-180
  and never simplified away, so the two halves of Fiji, Chukotka and the Ross Ice Shelf
  meet exactly. Longitudes are clamped to [-180, 180] (glaciated areas reach -180.000015);
  the 110m Antarctica's closing edge along the South Pole, one 360-degree segment, is
  divided into 1.40625-degree steps. No segment of any file spans more than 180 degrees
  (tested). The civil date line in `geolines-50m` (up to 180.003 in the source) is wrapped
  and split at the seam.
- **Coastlines are derived, not separate data.** `coastline-*` is the land rings minus
  their artificial edges along the seam and the pole, so strokes align exactly with the
  fill and show no vertical line at 180 degrees. Natural Earth's own coastline layer is not
  used.
- **Winding** is RFC 7946: exterior rings counter-clockwise, holes clockwise.
- **Rivers** exclude Natural Earth's "Lake Centerline" features (lines drawn through lakes).
- **Marine label points** are computed: the pole of inaccessibility (an independent
  implementation of Agafonkin's 2016 quadtree search) of each sea's largest part, kept
  within 78 degrees of the equator so polar oceans are labelled where Mercator can show them.
  All-capital names ("SOUTHERN OCEAN") are title-cased.
- **Properties** are cut down to what a style needs: `name`, `kind`, `rank` (Natural Earth
  scalerank), `minzoom` (Natural Earth's, defined for 256-pixel tiles). Boundaries carry
  `kind` = international, disputed, indefinite or line-of-control (Natural Earth's de facto
  view; draw the last three dashed).
- **Country and state polygons** exist for lookups (and optional fills), at 0.01 deg.
  States only for the seven large multi-zone countries (United States, Canada, Russia,
  Brazil, Australia, Indonesia, China); Natural Earth's 1:50m states layer also covers
  India and South Africa, one zone each, which are left out.

### Processing of the gazetteer

- **Places:** all 7 342 of `ne_10m_populated_places`, largest first. Positions come from
  the geometry, not the LATITUDE/LONGITUDE attributes, which are stale for about 300 places
  (Karlskrona 18 km off, Lisburn 40 km, Juina 80 km). Whitespace collapsed ("St.  Petersburg").
- **Other names for search:** Natural Earth's Wikidata names in English, German, Spanish,
  French, Italian, Portuguese, Dutch, Polish, Swedish, Turkish, Indonesian, Vietnamese and
  Hungarian (München, Wien, Den Haag, Lisboa); NAMEPAR (Bombay) except for Antarctic
  stations, where it holds the operating country; NAMEALT with its encoding-damaged
  fragments dropped ("Ciudad de M", "F-s"). MEGANAME and LS_NAME are not used (damaged).
- **States:** Natural Earth's ADM1NAME, with 14 damaged names repaired where the original
  is obvious (Guinaa -> Guyane, HuRnuco -> Huánuco, "Los R" -> Los Ríos, ...) and 34 left
  blank (Vietnamese and Azerbaijani names with "?" for letters; 38 places), so a label
  leaves the state out rather than show garbage.
- **Countries:** named by the shortest of Natural Earth's NAME_EN, ADMIN, NAME_LONG and NAME
  that is not abbreviated ("United States", "China", "Czechia"). ISO codes from ISO_A2_EH.
- **Zone anchors:** every place with a zone plus the 418 principal locations of IANA
  `zone.tab`, each assigned to its country (by ISO code, or by the polygon it lies in:
  French Guiana, Réunion and Svalbard are inside France's and Norway's polygons).

### Time zones: source, cleaning and measured quality

Natural Earth's populated places carry an IANA `TIMEZONE` for 6 159 of 7 342 places. It is
the only time-zone information used; nothing is inferred from boundary data. It needed
cleaning, at build time, by three documented rules (`cleanZone` in `build.mjs`):

- **A. Old names** not in `zone.tab` become the `zone.tab` name they link to
  (Asia/Chongqing -> Asia/Shanghai, Europe/Zaporozhye -> Europe/Kyiv, Asia/Rangoon ->
  Asia/Yangon, ...); and a place within 30 km of a `zone.tab` principal location of its own
  country that shows the same clock takes the better name when it is the zone's namesake or
  its zone belongs to another country (Anchorage was filed under America/Juneau, Andorra
  under Europe/Madrid). 319 places renamed in all; no clock changes.
- **B. Wrong country.** A zone that belongs to none of the place's countries (by `zone.tab`)
  is kept only if it shows the same clock today as that country's nearest zone, or if its
  own principal location is nearer than any of the country's (overseas territories, border
  towns); otherwise it is replaced by the country's nearest zone. 21 fixes, including
  capitals: Prague was in America/Chicago, Santiago and Colombo in America/Sao_Paulo,
  Montevideo in America/Chicago, Lagos in Europe/Athens, Cardiff in Australia/Sydney.
- **C. Newer zones.** A place within 30 km of a `zone.tab` principal location of its own
  country takes that zone when the clocks differ today. 20 fixes where Natural Earth
  predates a change: Saratov, Ulyanovsk, Astrakhan (2016), Barnaul, Punta Arenas (2017),
  Khandyga, Bougainville, Chatham Islands (+12:45), Coyhaique (2025), Matamoros, Ojinaga and
  Ciudad Juárez (Mexican border towns on US daylight saving).

All 41 corrections are listed in `gazetteer.json` under `zone_corrections`, and flagged
on the place. "Same clock today" means the same UTC offset on the 1st and 15th of every
month of 2025-2026. For browsers whose Intl data predate a zone (America/Coyhaique), the
gazetteer lists same-clock alternatives, and `timezone.ts` also knows renamed zones'
old names.

**The guess** (`guessZone` in `web/src/next/geo/timezone.ts`), implementing CONVENTIONS 13.8:
on land or within 12 NM of it (the territorial sea; also absorbs the 1:50m coastline error),
the zone of the nearest anchor in the same country (in the seven large countries, among
zones used in the same state); Antarctica counts as sea; at sea, a place within 12 NM lends
its zone (small islands); otherwise the nautical zone, ZD = round(lon / -15). Every answer
carries a one-sentence reason, and the user can override it.

**Measured quality** (`web/test/next/geo-zone-holdout.test.ts`, run in the test suite): for
each of the 6 159 zoned places, guess at its position with that place left out, and
compare with its (cleaned) zone.

| | places | exact zone id | same clock today |
|---|---|---|---|
| **All** | 6 159 | **97.3 %** | **99.0 %** |
| country has one zone | 2 713 | 99.5 % | 100 % |
| state has one zone | 1 555 | 98.9 % | 99.2 % |
| nearest place in country/state | 1 886 | 93.1 % | 97.7 % |
| nautical (counted as misses) | 4 | | |
| Before the polygons load (nearest place within 150 NM, measured once) | 6 159 | 88.4 % | 94.5 % |
| For comparison: plain nearest place, uncleaned Natural Earth zones (a prototype, clock compared over 2024-2026) | 6 159 | 87.4 % | 94.1 % |

The remaining misses sit on zone borders (United States 13, Russia 10, Indonesia 8,
Canada 7, Mexico 4), and some are Natural Earth's errors rather than the guess's (Bali is
filed under Asia/Jakarta but keeps Asia/Makassar time), so the true accuracy is somewhat
higher than measured. A hold-out is harder than real use: a click on a city finds the city.

**Known limits.** Zone assignments are only as current as Natural Earth's (about 2012-2018)
plus the rule-C fixes; states are known only in the seven large countries, so a click near
a zone border elsewhere (Mexico, Kazakhstan, DR Congo) takes the nearest town's zone; the
guess never looks at the date (a position's zone is today's, while the browser's Intl data
supply each zone's historical rules for the date shown).

## Star field and constellations

Owner: star-field agent (`crates/skyfix-starfield/`, `crates/skyfix-wasm/src/starfield.rs`,
`tools/starfield/`, `fixtures/reference/starfield_*.json`). Display-only data
(CONVENTIONS 13.6): none of it reaches `reduce`, `solve`, the planner's navigation
candidates or an accuracy claim, and a test (`crates/skyfix-starfield/tests/crate_boundary.rs`)
keeps it out of every navigation crate.

**Nothing below needs on-screen credit.** The stars are a U.S. Government Work, the
figures are this project's own, and the boundaries and star names are facts. The
courtesy citations are kept here, in the documentation.

### Stars: the Yale Bright Star Catalogue as served by NASA HEASARC

- **What is used:** every stellar row of HEASARC's `bsc5p` table (the Bright Star
  Catalogue, 5th revised edition, preliminary version; Hoffleit & Warren 1991): HR
  number, the catalogue's own sexagesimal J2000 position (`cra`, `cdec`: RA to 0.1 s of
  time, Dec to 1″), proper motions (`pmra` = μα·cos δ and `pmdec`, ″/yr), parallax,
  V magnitude, B−V and the Bayer/Flamsteed name field (`alt_name`). Radial velocities
  are read only by the validation fixture.
- **Source:** NASA's High Energy Astrophysics Science Archive Research Center (HEASARC),
  table description <https://heasarc.gsfc.nasa.gov/W3Browse/all/bsc5p.html>, fetched
  through HEASARC's TAP service:
  `https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=text/plain&MAXREC=20000&QUERY=…`
  with ADQL `SELECT hr, name, alt_name, cra, cdec, ra, dec, vmag, vmag_uncert, vmag_code,
  bv_color, bv_uncert, pmra, pmdec, parallax, par_code, radvel, var_id, multiple, m_cnt,
  m_id, m_sep, m_mdiff, hd, spect_type, note FROM bsc5p ORDER BY hr`
  (`tools/starfield/fetch.py` has the exact URL).
- **Retrieved:** 2026-09-24T14:19:53Z. 9 110 rows, 2 086 467 bytes, SHA-256
  `c411cb86ae371a89175b6d7d6246a657e604803398e63e6ce58e0025b2d6543a`. The raw download is
  git-ignored (`tools/starfield/data/`); `python3 -m tools.starfield.fetch` repeats it.
- **Licence evidence.** NASA's open-data listing on data.gov,
  <https://catalog.data.gov/dataset/bright-star-catalog> ("Bright Star Catalog",
  published by the High Energy Astrophysics Science Archive Research Center, National
  Aeronautics and Space Administration), checked 2026-09-24. Its machine-readable
  harvest record
  (<https://catalog.data.gov/harvest_record/1e27ef96-47f7-4dfb-9271-2e4f04ffa57f/raw>,
  2 597 bytes, SHA-256 `58aee48827b3608a55a0ddcb810631babf83b7b15d1a7504cfc1b81b36939c26`)
  reads, verbatim: `"identifier": "ivo://nasa.heasarc/bsc5p"`,
  `"accessLevel": "public"`, `"license": "https://www.usa.gov/government-works"`,
  `"publisher": {"name": "High Energy Astrophysics Science Archive Research Center"}`,
  `"modified": "2026-09-22"`. The licence URL now redirects to
  <https://www.usa.gov/government-copyright>, USAGov's page on U.S. Government Works
  (17 U.S.C. § 105).
- **Caveats, recorded rather than hidden:**
  - HEASARC's own provenance note says the table "was created by the HEASARC in 1995
    based upon a file obtained from either the ADC or the CDS", with later HEASARC
    corrections. The underlying numbers are astrometric and photometric measurements,
    which are facts; the U.S. Government Work listing is NASA's statement about the
    table it serves.
  - USAGov notes that U.S. copyright law may not protect U.S. government works outside
    the United States, and that not everything on a federal site is a government work.
    For this table the data.gov listing is explicit, and the content is factual data.
  - HEASARC asks research publications to acknowledge its services. That is a courtesy
    request, not a licence condition; this section is where the project acknowledges
    it: *This product uses the Bright Star Catalogue (Hoffleit, D. and Warren, Jr.,
    W.H., 1991, 5th Revised Edition, Preliminary Version) as provided by NASA's High
    Energy Astrophysics Science Archive Research Center (HEASARC).*
- **Processing (`tools/starfield/build.py`):** positions converted exactly from the
  sexagesimal strings to integers (0.1 s of time, 1″) and cross-checked against
  HEASARC's decimal copies; proper motions and parallaxes to whole mas (the catalogue's
  precision); negative published parallaxes stored as 0 (Skyfield treats them the same
  way). Left out: the **14 non-stellar entries** that received HR numbers (novae,
  clusters, and the historical supernovae S And and Tycho's and Kepler's stars; HR 92,
  95, 182, 1057, 1841, 2472, 2496, 3515, 3671, 6309, 6515, 7189, 7539, 8296), which have
  no catalogue position, magnitude or proper motion, and **HR 5958, T CrB**, a recurrent
  nova catalogued at its 1866 outburst peak (V 2.0) that normally sits near V 10.
  **9 095 stars** remain, written to `crates/skyfix-starfield/data/stars.bin` (227 391
  bytes, 25-byte records, layout in `crates/skyfix-starfield/src/catalog.rs`, SHA-256
  `2773f90c570317fb1fd4c98ccbf4f13c29c4bc379a34e151714602b0426663c3`).
  `crates/skyfix-starfield/data/manifest.json` records every count, exclusion and check.

### Star names — facts

`tools/starfield/names.txt` lists 252 proper names by designation (for example
`Alp CMa = Sirius`), written for this project from the names in common use, which for
most stars are the ones the IAU Working Group on Star Names has catalogued. Names are
facts; no list was copied. The 57 Nautical Almanac navigational stars and Polaris use
the Almanac's spelling, the spelling used everywhere else in SkyFix Lab; the build checks
each against `fixtures/reference/navigational_stars_hip.json` (within 1′ and 1 mag).

### Constellation figures — this project's own work

`tools/starfield/figures.txt` draws all 88 constellations as chains of stars, by
designation, following the traditional modern Western stick figures. They were drawn
for this project from the shape of each constellation and the catalogue positions of
its stars; **no existing figure dataset (Stellarium, d3-celestial, the IAU / Sky &
Telescope charts or any other) was copied or consulted.** They are covered by the
project's own MIT OR Apache-2.0 licence. The build resolves every designation to an HR
number (670 segments in `crates/skyfix-starfield/data/figures.txt`) and refuses a
figure whose star is missing, lies more than 2° outside its constellation's boundary,
or makes a segment longer than 25°. Only two figure stars lie outside their own
constellation, both by tradition: Alpheratz (α And) closes the Square of Pegasus and
Elnath (β Tau) closes the pentagon of Auriga.

### Constellation boundaries — IAU definitions, Delporte (1930)

- **What is used:** the corners of the 88 constellation boundaries in the mean equator
  and equinox of B1875.0, as defined for the IAU by Delporte, E. (1930), *Délimitation
  scientifique des constellations* (Cambridge University Press).
- **Public-domain basis:** the boundaries are an official definition, published facts
  (numbers fixing a line on the sky), and not protected expression. The 1930
  publication itself entered the U.S. public domain on 2026-01-01 (95 years after
  publication), and Delporte died in 1955, so it is also out of copyright wherever the
  term is the author's life plus 70 years.
- **Digital transcription used:** Davenhall, A.C. & Leggett, S.K. (1989), *A Catalogue
  of Constellation Boundary Data*, the "original" B1875 vertex file `bound_18.dat`,
  <https://cdsarc.cds.unistra.fr/ftp/cats/VI/49/bound_18.dat>, retrieved
  2026-09-24T14:19:53Z, 40 690 bytes, 1 565 records, SHA-256
  `3f563d0e3002a410afbc551791db6297cbfc3d291a20deb18f1fd7b4df60d7b8`. It is a mechanical
  transcription of Delporte's lists; CDS asks users of its service to acknowledge it,
  which this line does as a courtesy.
- **Processing:** every corner snapped back to the grid Delporte used (whole seconds of
  time, whole arcminutes; the file's 5-decimal rendering is off by at most 0.012 s and
  0.024″, so the snap is exact), and Octans' three plotting points at the south pole
  (added by the transcription, not boundary corners) removed. Result:
  `crates/skyfix-starfield/data/boundaries.txt`, 89 polygons (Serpens in two), 1 562
  corners, as integers.
- **Independent check:** Skyfield's bundled constellation map (built from Roman, N.G.
  1987, PASP 99, 695, a separate digitisation of Delporte) was compared cell by cell:
  all **47 200 cells of its grid fall in the same constellation**, and its grid lines are
  the same set of RA and Dec values. Skyfield is used for this at development time only.

### Validation fixtures (development-time only)

`fixtures/reference/starfield_apparent.json` and `starfield_constellations.json` are
generated by `tools/starfield/gen_fixtures.py` with the reference environment already
listed above (Skyfield 1.55, numpy, JPL DE440s with DE421 as a cross-check). The star
values fed to Skyfield are parsed from the raw HEASARC download by that script's own
code, independently of the build and of the Rust decoder.

## Explorer design system and design mockup

Owner: shell-design agent (`web/src/next/theme/`, `web/src/next/mockup/`,
`web/next/mockup.html`, `web/next/mockup-assets/`). Added 2026-09-24.

- **Icons, body glyphs, the logo mark and the Moon phase disc:** drawn for this project
  (`web/src/next/theme/icons.ts`, `glyphs.ts`, `primitives.ts`). No icon font or
  third-party artwork. The planets' classical symbols are public-domain signs, drawn
  here as our own strokes.
- **Fonts:** Inter and JetBrains Mono through the npm packages already listed under
  "Explorer (browser) dependencies" above; nothing new.
- **Natural Earth 1:110 m land, lakes and land boundary lines** (the design mockup's map
  only; the explorer's real basemap is the map-data agent's).
  - **URL:** <https://github.com/nvkelso/natural-earth-vector>, files
    `geojson/ne_110m_land.geojson`, `geojson/ne_110m_lakes.geojson` and
    `geojson/ne_110m_admin_0_boundary_lines_land.geojson` at commit
    `ca96624a56bd078437bca8184e78163e5039ad19` (release v5.1.2 data).
  - **Retrieved:** 2026-09-24.
  - **Licence:** public domain. The repository's `LICENSE.md` at that commit (and
    <https://www.naturalearthdata.com/about/terms-of-use/>, checked 2026-09-24): "All
    versions of Natural Earth raster + vector map data found on this website are in the
    public domain", and "Crediting the authors is unnecessary." The mockup shows "Map
    data: Natural Earth" as a courtesy.
  - **Processing:** geometry kept, every property, `bbox` and `crs` member dropped, and
    coordinates rounded to 0.001 degree (about 100 m, far finer than the 1:110 m data).
    Result: 96 kB, 10 kB and 77 kB. SHA-256 of the downloaded originals:
    land `9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`,
    lakes `eb02ecc86c82004fccbf979058bfabbbd6c2d07968c7844d38eb1c9152d2ffc9`,
    boundary lines `d42479fd79552cca4eec7f85fcdca717a790d29ff06be7676f1af0568c6d3f7c`.
- **The mockup's numbers:** produced once by this project's MOCK engine (section above)
  for Philadelphia City Hall on 2026-09-24 and typed in; illustrative, never results.

## Explorer map view

Owner: map agent (`web/src/next/map/`). Added 2026-09-24. No new package and no bundled
data: the map draws the basemap and gazetteer recorded above (Natural Earth, public domain)
with `maplibre-gl` (listed above).

- **Map labels:** drawn by MapLibre itself on a canvas (TinySDF) from the same
  `@fontsource-variable/inter` files the interface ships (SIL OFL 1.1, listed above),
  registered under the map's own family names (`web/src/next/map/fonts.ts`). No glyph
  (PBF) files are generated or committed, and no glyph server is used.
- **Optional street layer (runtime, online, never bundled):** the OpenStreetMap standard
  tile layer, `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, operated by the
  OpenStreetMap Foundation. Data © OpenStreetMap contributors, ODbL 1.0; the tile images
  are shown with the credit "© OpenStreetMap contributors" linked to
  <https://www.openstreetmap.org/copyright>, visible on the map exactly while the layer
  is on. Use follows the OSMF Tile Usage Policy (<https://operations.osmfoundation.org/policies/tiles/>,
  read 2026-09-24): off by default and requested only for what is on screen while the
  person has it switched on; maximum zoom 19; no prefetching or bulk download; tiles are
  cached only by the browser's normal HTTP cache (the release agent's service worker must
  not store them).
