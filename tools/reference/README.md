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

run from the repository root. A full run takes about eleven minutes once the input
data is present: about seven for the event fixtures (`gen_events.py`, one-minute
searches over 2 300 site-days), most of the rest the planet and Moon fixtures.

Every generator takes `--window START..END` and `--kernel NAME` (expansion programme):
the defaults are the ones its committed file was written with, so a plain run reproduces
it, and a different window or kernel writes the same kind of file for other dates.
Windows are proleptic Gregorian dates or bare years in astronomical numbering
(`1990..2060`, `1550-01-01..2650-01-22`, `-2000..3000`); the kernel is `auto` (DE440s
inside 1849-2150, DE440 inside 1550-2650, DE441 outside: EXPANSION_PLAN 4.6) or one of
`de421`, `de440s`, `de440`, `de441`. Generators built around one fixed instant (the
Philadelphia sessions, the Sun sequence, the USNO query) refuse a window that does not
contain it.

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
make -C tools/reference kernels    # DE440 and DE441 (3.2 GB), for the series and the deep-time fixture
```

`tools/reference/data/` and `tools/reference/.venv/` are git-ignored. The
ephemeris kernels and the raw Hipparcos catalogue are never committed; see
`docs/THIRD_PARTY.md`, "Reference data (development-time only)" and "Expansion
programme — deep time", for their URLs, sizes, checksums and licences.

### Kernels

| `--kernel` | files | span | used by default for |
|---|---|---|---|
| `de421` | `de421.bsp` | 1899-2053 | the stars' geocentric and topocentric files, the sessions, nav methods |
| `de440s` | `de440s.bsp` | 1849-2150 | Moon, planets, events, almanac, eclipses, sights |
| `de440` | `de440.bsp` | 1550-2650 | the validated tier (`gen_deeptime`, `build_series`) |
| `de441` | `de441_part-1.bsp`, `de441_part-2.bsp` | -13200..17191 | the labelled tier; `common.KernelSet` answers across the two files |

### Radial velocities

`gen_stars.RADIAL_VELOCITIES` is SIMBAD's `basic.rvz_radvel` for the 58 HIP numbers,
fetched with its TAP service on 2026-09-25:

```
curl -s https://simbad.cds.unistra.fr/simbad/sim-tap/sync -d REQUEST=doQuery -d LANG=ADQL \
  -d FORMAT=json --data-urlencode "QUERY=SELECT i.id, b.rvz_radvel, b.rvz_err, b.rvz_qual, \
  b.rvz_bibcode FROM basic AS b JOIN ident AS i ON i.oidref = b.oid WHERE i.id IN \
  ('HIP 677', 'HIP 2081', ...)"
```

Rigil Kentaurus takes the system's value ("* alf Cen", -22.3 +/- 0.9 km/s) rather than
alpha Cen A's single-epoch one, which contains A's orbital motion (`acen_orbit.py`).

## What each script produces

| script | output | what it is |
|---|---|---|
| `gen_stars.py` | `fixtures/reference/navigational_stars_hip.json` | the 57 Nautical Almanac navigational stars plus Polaris, from Hipparcos, at the catalogue epoch **J1991.25**, with SIMBAD radial velocities and alpha Centauri A's orbit (`acen_orbit.py`, ORB6) |
| `gen_geocentric.py` | `fixtures/reference/geocentric_sun_stars.json` | apparent geocentric of-date GHA/Dec/SHA for 59 bodies at 58 epochs, 1995–2055 |
| `gen_deeptime.py` | `fixtures/reference/deeptime_bodies.json` | the Sun, the Moon and the planets at 20 epochs per half-century of the validated tier (DE440) and per century of the labelled tier (DE441, 2000 BC to AD 3000), the long-term frame outside 1550-2650; the 58 stars at the first epoch of each bin with their catalogue uncertainty. `make -C tools/reference deeptime`; not run by `generate_all.py` |
| `gen_topocentric.py` | `fixtures/reference/topocentric_altaz.json` | topocentric alt/az at 5 observers × 6 epochs, with and without refraction, against the CONVENTIONS section 3 spherical formula |
| `gen_sessions.py` | `fixtures/sessions/reference-philadelphia-*.json` and their `truth`/`expected` files | the "first numerical slice": 5-, 2- and 1-sight sessions |
| `gen_sun_sextant.py` | `fixtures/sessions/reference-sun-sextant.json` and its `truth`/`expected` files | the CONVENTIONS section 5 chain run backwards from a known Ho to raw `sextant_hs` |
| `gen_planets.py` | `fixtures/reference/planets_<planet>.json` | apparent geocentric Mercury to Neptune from DE440s (DE421 cross-check), 322-338 epochs each over 1990-2060 including conjunctions, oppositions, greatest elongations, stations and Saturn's ring-plane crossings; distance, phase, elongation, bright-limb angle and two magnitude columns |
| `gen_nav_methods.py` | `fixtures/reference/nav_methods.json` | noise-free sights with known truth for the navigation methods: noon runs (meridian passage by Newton on the geocentric LHA), Polaris at 1-89.8 N, averaging runs, running-fix tracks (docs/NAVIGATION_METHODS.md) |
| `gen_usno.py` | `fixtures/reference/usno_celnav_2026-10-01T0130Z.json` | a verbatim US Naval Observatory API response, differenced against ours. **Needs network** |
| `gen_moon.py` | `fixtures/reference/moon_geocentric.json`, `fixtures/reference/moon_topocentric.json` | the apparent geocentric Moon at 1757 instants over 1990–2060 from **DE440s** (DE421 cross-check), and topocentric alt/az at 12 sites with **UT1 = UTC on the UTC scale** (`common.load_timescale(dut1_zero=True)`), for the Moon, the Sun and four stars |
| `gen_moon_sights.py` | `fixtures/reference/moon_planet_sights.json`, `fixtures/reference/lunar_distances.json`, `fixtures/reference/nautical_twilight.json`, `fixtures/sessions/reference-moon-*.json` and their `truth`/`expected` files | raw sextant readings of the Moon, the four navigational planets, the Sun and stars built from Skyfield's topocentric sky (DE440s, UT1 = UTC) on a spherical and on the WGS84 Earth, with the amended CONVENTIONS section 5 chain transcribed from the text beside each; four end-to-end Moon and planet sessions; 22 lunar distances measured between refracted limbs found numerically; nautical twilight instants at eight sites |
| `gen_usno_sights.py` | `fixtures/reference/usno_celnav_venus_phase.json` | USNO celnav responses for Venus (centre of light), Mars and the Moon (altitude corrections) beside Skyfield. **Needs network** |
| `gen_eclipses.py` | `fixtures/reference/eclipses_nasa_canon.json`, `eclipses_nasa_paths.json`, `eclipses_usno_local.json`, `eclipses_skyfield.json` | NASA's Five Millennium Canon rows for 1990-2060, six NASA path tables with their Besselian elements and 22 USNO Solar Eclipse Computer responses, all parsed or stored verbatim (**needs network**; `--offline` keeps them), plus Skyfield + **DE440s** local contacts, lunar contacts and limit crossings on a UT1 = UTC timescale (a few minutes) |
| `gen_planet_events.py` | `fixtures/reference/planet_events_skyfield.json`, `planet_events_nasa_skycal.json` | every opposition, conjunction with the Sun (inferior and superior, with transits of Mercury and Venus), greatest elongation of Mercury and Venus and closest approach of Mercury to Neptune in 1990-2060 from Skyfield + **DE440s** (2266 events); and the same kinds of events, perigees aside, parsed verbatim from NASA's SKYCAL Sky Events Calendar decade files (1689 events; **needs network**, `--offline` keeps the file, `--network-only` refreshes just it) |
| `gen_events.py` | `fixtures/reference/events_{sun,stars,moon_planets,seasons,moon_phases}.json` | rise, set, transit, twilight, sky phases (34 sites × 21 dates for the Sun), star, Moon and planet events, equinoxes/solstices and Moon phases 1990–2060, from Skyfield + **DE440s** with UT1 = UTC and exactly the definitions of CONVENTIONS 13.3–13.5 |
| `gen_events.py` (USNO part) | `fixtures/reference/events_usno.json` | USNO rise/set/transit/civil twilight for 14 site-days, Moon phases and seasons for five years. **Needs network**; `--usno-only` refreshes just this file |
| `gen_almanac.py` | `fixtures/reference/almanac_days.json` | every quantity of a daily almanac page (CONVENTIONS 13.9) for 17 dates 1990-2060 from Skyfield + **DE440s**, UT1 = UTC: hourly GHA/Dec of Aries, Sun, Moon (with HP, v, d) and the four navigational planets, the stars' SHA/Dec at 12h, meridian passages, equation of time, the Moon's age and phase, and the twilight/sunrise/moonrise cells for the 31 standard latitudes on the Greenwich meridian |
| `gen_almanac.py` (USNO part) | `fixtures/reference/almanac_usno.json` | USNO Celestial Navigation Data at four whole hours (queried at each body's ground point) and one-day rise/set/civil twilight at the Greenwich meridian for six latitude-dates, verbatim. **Needs network**; `--usno-only` refreshes just this file |
| `gen_sun_tools.py` | `fixtures/reference/sun_tools_skyfield.json` | equation of time, the galactic centre and the Milky Way arch, bearing crossings, sunset azimuths, the analemma and the clear-sky solar formulas (CONVENTIONS 13.10) |
| `common.py` | — | shared helpers: the deterministic JSON writer, the CONVENTIONS sections 3 and 5 formulas coded from the text of `CONVENTIONS.md`, star identity verification, loaders; the app's clock (`load_timescale`), the app's frame outside the validated tier (`use_app_frame`), `KernelSet` and `setup()` for `--window`/`--kernel` |
| `acen_orbit.py`, `ltp.py`, `vsop87.py`, `elpmpp02.py` | — | alpha Centauri A about the A-B barycentre (ORB6); the Vondrak-Capitaine-Wallace long-term precession pinned to ERFA's test values, with the GMST consistent with it; VSOP87A and ELP/MPP02 readers and evaluators (each checks its source files by SHA-256 and the authors' own check values) |

`generate_all.py` runs them in that order and reports which steps failed
without stopping at the first one.

One more script produces **embedded data**, not a fixture, and is not part of
`generate_all.py`:

| script | output | what it is |
|---|---|---|
| `build_series.py` | `crates/skyfix-ephemeris/data/series.bin` (embedded) and `series_checks.json` (tests only) | the Sun, planet and Moon series of both coverage tiers: VSOP87A for the Earth and the seven planets, truncated per tier by measured error, with corrections fitted to DE440 (validated) and DE441 (labelled); ELP/MPP02 with its secular terms refitted to DE441 and DE440. Compact binary (EXPLORER_API "Series payload") |

It reads the CDS VI/81 files from `tools/reference/data/vsop87/` and the ELP/MPP02
files from `tools/reference/data/series/elpmpp02/` (git-ignored; `make -C
tools/reference vsop87 elpmpp02` fetches them, and the script refuses files whose
SHA-256 differs from the recorded ones), and needs DE440 and DE441 (`make -C
tools/reference kernels`). `make -C tools/reference series` runs it; about ten
minutes (`--quick` for smaller grids while developing). Every stored number is
quantised before the corrections are fitted and the checkpoints computed, and
`series_checks.json` records the checkpoints and the measurement per bin.

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

Since the expansion programme every script builds its instants on **the app's clock**
(CONVENTIONS 15.2: UTC 1972-2035, UT = UT1 outside) with **SkyFix Lab's own ΔT**:
`common.load_timescale()` wraps `tools/timescales/skyfield_timescale.py`, which hands
Skyfield the IERS table compiled into `skyfix_core::deltat`, so a fixture's TT and UT1
are the Rust side's to a microsecond. `ts.utc(...)` there reads a calendar date on the
app's clock and `t.utc`, `utc_strftime()` read it back the same way; fixtures record
`jd_tt` and `jd_ut1` per case where the Rust tests use them. Files written before the
programme say `skyfield.api.load.timescale(builtin=True)` in their `timescale` block
and were made with Skyfield's bundled table instead; they are regenerated on the new
clock as their generators are re-run. No polar-motion table is installed, so polar
motion is never applied. Outside the validated tier (1550-2650) `common.use_app_frame()`
gives Skyfield the app's long-term precession, obliquity and sidereal time.

DUT1 = UT1 − UTC comes from the IERS table on the UTC scale and is 0 by definition on
the UT scale. CONVENTIONS section 6 assumes DUT1 = 0 for a navigator without a time
signal, so every GHA in the reference files is published **twice**: `gha_deg` with the
timescale's UT1 and `gha_deg_dut1_zero` with UT1 = UTC (identical after 2035).

The USNO cross-check settles which one to test against: USNO's Celestial
Navigation Data API reproduces `gha_deg_dut1_zero` to 10⁻⁶ deg, so **USNO's
celnav takes the supplied UTC as UT1 exactly as CONVENTIONS section 6 does**.
Test Rust output against `gha_deg_dut1_zero`.

See `docs/ACCURACY.md`, "Reference data and tolerances", for the measured
numbers and the tolerance justifications.
