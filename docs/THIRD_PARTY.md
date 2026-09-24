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
| `de440s.bsp` | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp` | 32 726 016 | `c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2` | NASA JPL / NAIF, same terms. Used only as an independent cross-check of DE421 and for the one epoch DE421 does not cover. Coverage 1849-12-25 to 2150-01-21. |
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
