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
