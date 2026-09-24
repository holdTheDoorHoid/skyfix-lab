# Reference fixture generation (development-time only)

Python + Skyfield scripts that produce the independent numbers every claim in
SkyFix Lab is tested against.

**These tools are never a runtime dependency.** Nothing here is linked into any
binary, invoked by `cargo build` or `cargo test`, run in CI on the hot path, or
needed to use SkyFix Lab. The Rust workspace reads the generated JSON and
nothing else. CONVENTIONS section 11 also forbids the reverse direction: never
regenerate a fixture from Rust output — that would turn an independent check
into a round-trip test of the project's own mistakes.

## Regenerate everything with one command

```
make -C tools/reference            # creates the venv, downloads data, regenerates all
make -C tools/reference offline    # same, but skips the USNO network query
```

The Makefile is a convenience wrapper. The generator itself is:

```
tools/reference/.venv/bin/python -m tools.reference.generate_all [--offline]
```

run from the repository root. A full run takes about three and a half minutes
once the input data is present, most of it the planet and Moon fixtures.

Set `SOURCE_DATE_EPOCH` to a fixed Unix time for byte-for-byte reproducible
output:

```
SOURCE_DATE_EPOCH=1774310400 make -C tools/reference offline
```

Without it the only field that changes between runs is each file's
`generator.generated_utc`; every numeric value is already stable (sorted keys,
degrees to 9 decimals, arcminutes and arcseconds to 4, seconds of time to 6).

## Setup by hand

```
python3 -m venv tools/reference/.venv
tools/reference/.venv/bin/pip install -r tools/reference/requirements.txt
mkdir -p tools/reference/data
curl -fsSL -o tools/reference/data/de421.bsp   https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/a_old_versions/de421.bsp
curl -fsSL -o tools/reference/data/de440s.bsp  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp
curl -fsSL -o tools/reference/data/hip_main.dat https://cdsarc.cds.unistra.fr/ftp/cats/I/239/hip_main.dat
```

`tools/reference/data/` and `tools/reference/.venv/` are git-ignored. The
ephemeris kernels and the raw Hipparcos catalogue are about 100 MB together and
are never committed; see `docs/THIRD_PARTY.md`, "Reference data
(development-time only)", for their URLs, sizes, checksums and licences.

## What each script produces

| script | output | what it is |
|---|---|---|
| `gen_stars.py` | `fixtures/reference/navigational_stars_hip.json` | the 57 Nautical Almanac navigational stars plus Polaris, from Hipparcos, at the catalogue epoch **J1991.25** |
| `gen_geocentric.py` | `fixtures/reference/geocentric_sun_stars.json` | apparent geocentric of-date GHA/Dec/SHA for 59 bodies at 58 epochs, 1995–2055 |
| `gen_topocentric.py` | `fixtures/reference/topocentric_altaz.json` | topocentric alt/az at 5 observers × 6 epochs, with and without refraction, against the CONVENTIONS section 3 spherical formula |
| `gen_sessions.py` | `fixtures/sessions/reference-philadelphia-*.json` and their `truth`/`expected` files | the "first numerical slice": 5-, 2- and 1-sight sessions |
| `gen_sun_sextant.py` | `fixtures/sessions/reference-sun-sextant.json` and its `truth`/`expected` files | the CONVENTIONS section 5 chain run backwards from a known Ho to raw `sextant_hs` |
| `gen_planets.py` | `fixtures/reference/planets_<planet>.json` | apparent geocentric Mercury to Neptune from DE440s (DE421 cross-check), 322-338 epochs each over 1990-2060 including conjunctions, oppositions, greatest elongations, stations and Saturn's ring-plane crossings; distance, phase, elongation, bright-limb angle and two magnitude columns |
| `gen_usno.py` | `fixtures/reference/usno_celnav_2026-10-01T0130Z.json` | a verbatim US Naval Observatory API response, differenced against ours. **Needs network** |
| `gen_moon.py` | `fixtures/reference/moon_geocentric.json`, `fixtures/reference/moon_topocentric.json` | the apparent geocentric Moon at 1757 instants over 1990–2060 from **DE440s** (DE421 cross-check), and topocentric alt/az at 12 sites with **UT1 = UTC by construction** (a constant-ΔT timescale per leap-second era), for the Moon, the Sun and four stars |
| `gen_moon_sights.py` | `fixtures/reference/moon_planet_sights.json`, `fixtures/reference/lunar_distances.json`, `fixtures/reference/nautical_twilight.json`, `fixtures/sessions/reference-moon-*.json` and their `truth`/`expected` files | raw sextant readings of the Moon, the four navigational planets, the Sun and stars built from Skyfield's topocentric sky (DE440s, UT1 = UTC) on a spherical and on the WGS84 Earth, with the amended CONVENTIONS section 5 chain transcribed from the text beside each; four end-to-end Moon and planet sessions; 22 lunar distances measured between refracted limbs found numerically; nautical twilight instants at eight sites |
| `gen_usno_sights.py` | `fixtures/reference/usno_celnav_venus_phase.json` | USNO celnav responses for Venus (centre of light), Mars and the Moon (altitude corrections) beside Skyfield. **Needs network** |
| `build_moon_series.py` | `crates/skyfix-ephemeris/data/elp82b_moon_terms.json` | **not a fixture**: the truncated ELP 2000-82B series the Moon provider embeds, built from CDS VI/79 (`--fetch` downloads the 36 files; SHA-256 pinned). Asserts the notice's Table H check values and measures the truncation error. Not run by `generate_all.py` |
| `common.py` | — | shared helpers: the deterministic JSON writer, the CONVENTIONS sections 3 and 5 formulas coded from the text of `CONVENTIONS.md`, star identity verification, loaders |

`generate_all.py` runs them in that order and reports which steps failed
without stopping at the first one.

One more script produces **embedded data**, not a fixture, and is not part of
`generate_all.py`:

| script | output | what it is |
|---|---|---|
| `gen_vsop87a.py` | `crates/skyfix-ephemeris/data/vsop87a_planets.json` | the VSOP87A series of the Earth and the seven planets, truncated for 1990-2060 by measured error, with checkpoints and a daily comparison against DE440s |

It reads the CDS VI/81 files from `tools/reference/data/vsop87/` (git-ignored;
`make -C tools/reference vsop87` fetches them, and the script refuses files whose
SHA-256 differs from the recorded ones). `make -C tools/reference planet-series`
runs it; it takes about 9 minutes. The truncation is judged against the full
series, and DE440s is used only for the recorded comparison, so the series stay a
product of VSOP87 alone.

## What is re-implemented in Python, and why

Almost nothing. The astronomy comes from Skyfield, JPL DE421 and Hipparcos.
Only two things are coded by hand in `common.py`, both from the text of
`docs/CONVENTIONS.md` and never from Rust source:

* `spherical_altitude_azimuth_deg` — CONVENTIONS section 3. It has to be here,
  because `topocentric_altaz.json` exists precisely to measure how far that
  formula is from a full topocentric computation.
* `bennett_refraction_arcmin`, `dip_arcmin`, `parallax_in_altitude_arcmin`,
  `ho_from_hs`, `hs_from_ho` — CONVENTIONS section 5. Skyfield's own refraction
  is *not* used for `reference-sun-sextant`: it implements the same Bennett
  formula with a constant of 0.016667 deg (1.00002′) and a scale factor
  `0.28·P/(T+273)` that is 0.999293 of the CONVENTIONS factor at 1010 hPa /
  10 °C, a 0.07 % difference that would eat 70 % of that fixture's 0.02′
  budget.

`gen_sessions.py` also contains a small Gauss-Newton solver, used only to
measure how far the published sessions can actually be solved from truth. That
number goes into the `expected` files as evidence; it is not a substitute for
the Rust solver.

## Earth-orientation assumptions

Every script uses `load.timescale(builtin=True)`: Skyfield's bundled
`skyfield/data/iers.npz`, a daily ΔT table derived from IERS `finals2000A.all`
as of the Skyfield 1.55 release. In this build the table spans **1973-01-01 to
2027-01-23**; beyond it Skyfield extrapolates with its long-term ΔT model. No
polar-motion table is installed, so polar motion is never applied.

Skyfield derives DUT1 = UT1 − UTC from ΔT. CONVENTIONS section 6 assumes
DUT1 = 0. These disagree by up to 0.5 s over the recent epochs and by −3.5 s at
2055 (where ΔT is extrapolated and leap seconds are unknowable), which is up to
0.88′ of GHA — far outside the 0.05′ tolerance. Every GHA in the reference
files is therefore published **twice**: `gha_deg` on Skyfield's UT1 and
`gha_deg_dut1_zero` with UT1 = UTC.

The USNO cross-check settles which one to test against: USNO's Celestial
Navigation Data API reproduces `gha_deg_dut1_zero` to 10⁻⁶ deg, so **USNO's
celnav takes the supplied UTC as UT1 exactly as CONVENTIONS section 6 does**.
Test Rust output against `gha_deg_dut1_zero`.

See `docs/ACCURACY.md`, "Reference data and tolerances", for the measured
numbers and the tolerance justifications.
