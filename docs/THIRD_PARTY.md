# Third-party sources, data and licences

Everything SkyFix Lab depends on, uses at development time, or derives data
from. Per `docs/BRIEF.md`: a repository being public is not sufficient
permission to copy it, and licences are recorded from the actual licence text
or the publisher's own declaration, not from memory.

Sections are owned by the agent that introduced the dependency. Add yours
rather than editing someone else's.

---

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

### OPEN QUESTION — Hipparcos licence vs the project's MIT/Apache-2.0 licence

**This needs a human decision before any public release. Flagging, not
resolving.**

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
