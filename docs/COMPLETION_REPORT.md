# Completion report

This report has two parts. **Part 1** is the explorer redesign of 2026-09-24. **Part 2**
is the original sprint of 2026-09-23/24, kept as it was written. Every number can be
reproduced with a command listed in `ACCURACY.md`, `DEMOS.md` or "Reproduce" below.

**Everything in this repository is a simulation and analysis tool. No real sextant sight
has been taken with it. Numerical agreement with reference data is not field accuracy.**

## Part 1 — The explorer redesign (2026-09-24)

### What the owner asked for

A prettier site that is easier to use and understand, in the look and feel of
suncalc.org, with features from suncalc.org, mooncalc.org, planetscalc.org and the
Celestial Navigator app: go backward and forward in time, set a location, see where
everything is from there, and see it drawn. The interview settled four questions: both
an offline built-in map and an optional OpenStreetMap street layer; all four feature
bundles (Moon and planets validated for fixes; noon sight, Polaris, running fix,
averaging and lunar distance; printable almanac pages; eclipses and sky events); and a
naked-eye star field with constellation figures, from data that needs no credit.

### What exists now

The site's home page is the **explorer** (<https://holdthedoorhoid.github.io/skyfix-lab/>).
It works offline after the first visit and can be installed as an app. The original
workbench is kept at `/classic/`. The user guide is `EXPLORER_GUIDE.md`.

- **Map and globe.** Click anywhere to set your place; a SunCalc-style compass at your
  place shows where the selected body rises, sets and stands now, and its path today.
  Day, night and twilight shading; the ground point under each body; the circle of
  equal altitude through you; a great-circle and rhumb-line measuring tool; an optional
  street map.
- **Time bar.** A 24-hour ribbon coloured by twilight, a draggable handle, date stepping,
  Now, and Play from real time to a month per second.
- **Side panel.** Place search over 7,342 places, typed coordinates and "use my
  location"; the time zone guessed from the place (right 97 % of the time in a hold-out
  test; the nautical zone at sea); the selected body with rise, transit and set; shadow
  length; "when is it at…"; what is in the sky now; tonight's recommended star sights.
- **Sky.** A planetarium dome and a horizon panorama with 9,095 stars, 88 constellation
  figures drawn for this project, the planets and a correctly phased Moon.
- **Charts.** Height through the day, a year of sunrise, sunset and twilight, a Moon
  calendar and planet visibility.
- **Navigate.** Sights entered by body and sextant reading with live workings; least-squares
  fixes (with shared-bias, robust and multistart options), noon sight, Polaris latitude,
  running fix, averaging a run of sights, lunar distance; a residual heat map; GPX export.
  Every capability of the original workbench is here.
- **Almanac.** Daily pages in the Nautical Almanac's layout, printable on A4 and Letter.
- **Events.** Eclipses with local circumstances and paths on the map, Moon phases,
  equinoxes and solstices, and planet events.
- **Learn.** The ten packaged demonstrations as guided stories, the simulator and its
  coverage experiments, and an illustrated primer.
- **Command line.** 25 subcommands; the new ones (`sky`, `events`, `phases`, `seasons`,
  `noon`, `polaris`, `average`, `running-fix`, `predict`, `lunar`, `plan-sights`,
  `almanac`, `eclipses`, `eclipse`, `planet-events`) give the same numbers as the site.
- **Themes.** Light (SunCalc-like), dark, and red night vision with no blue or white
  light anywhere; phone layouts; keyboard operation throughout.

### Test results

At the final commit: **1,066 Rust tests and 991 web tests, 0 failures**; 191 scripted
browser checks of the built site (every view, three themes, desktop and phone, keyboard,
privacy, memory over 300 view switches) and 64 offline checks, including the upgrade path
from the old site layout; `mdbook build` with no warnings; CI (format, tests, the wasm32
build, the offline smoke test, clippy with warnings denied) green on `main`.

### Validation that matters, with the numbers

References: Skyfield with JPL DE440s (DE421 as a cross-check), the US Naval Observatory,
NASA's eclipse canon and sky-events calendar, Bowditch's worked examples. Full figures in
`ACCURACY.md`, whose first table lists every row below against its target.

| check | result | target |
|---|---|---|
| Moon, 1,757 instants 1990-2060 | worst GHA 0.0149′, Dec 0.0064′, HP 0.00009′ | 0.1′ |
| Planets, all seven | worst 0.040′ (Neptune); Mercury to Saturn within 0.0064′ | 0.1′ |
| Topocentric altitude and azimuth, Moon | within 0.7″ | 0.1′ |
| Rise, set, twilight and transits vs Skyfield | worst 0.22 s (Sun), 0.42 s (Moon), 0.26 s (planets) | 10 s |
| The same vs USNO (which rounds to the minute) | within 29.4 s | 1 min |
| Moon phases, equinoxes and solstices, 1990-2060 | within 1.1 s and 4.0 s | 1 min |
| Star field, 9,095 stars | apparent places within 0.0051′ of Skyfield | 0.1′ |
| Moon and planet sights, raw readings to Ho | 0.0063′ on the sphere (the Earth's-shape term, up to 0.22′ for the Moon, is not modelled) | ephemeris tolerance |
| Lunar distance, time recovered | within 2.1 s in every case | 5 s |
| Almanac pages | every angle within 0.0092′; 99.2 % of printed values exact | 0.1′, 1 min |
| Eclipses 1990-2060 | 320 of 320 found and typed as NASA's canon; greatest eclipse within 1.4 s (solar), 11 s (lunar); paths within 0.6 km; local contacts within 2.0 s of USNO | 2 min, 1 min |
| Planet events 1990-2060 | 2,266 of 2,266 matched one for one; within 55 s | 1 min |
| Navigation methods, stated sigmas | cover 92.5-97 % of seeded trials | ≈ 95 % |
| Sky view vs the engine | 58 navigational stars agree within 9″ | 0.01° |
| Speed in the browser | the whole sky (67 bodies) in about 1 ms | 2 ms |
| Download | the engine 851 KB gzipped; the offline copy 4.1 MB gzipped | 1 MB engine |

### Adversarial verification

An independent agent attacked the new engine code and fixed 17 defects, each with a
regression test. The serious ones gave confident wrong answers:

1. **Lunar distance** with only the Moon's altitude observed could lose the true root
   and return a time hours off with a sigma of seconds (7 of 22 validation cases).
2. **A noon sight from one maximum reading** took the declination at the wrong instant:
   1.29′ of latitude error for the Moon while claiming 0.10′; its sigma held 24 % of the
   time, now 96 %.
3. **Averaging a run of sights** applied a chronometer correction twice.
4. **A malformed request could panic** the WebAssembly module (72 fuzz cases).
5. **Six tests could never fail**; they now do.

A second agent verified the whole site in a browser and fixed what it found: the sight
planner re-planning twice a second while the time bar was dragged; white light leaking
into the night theme from date pickers and checkboxes; Navigate calling Hc "altitude"
where the Moon differs by 46′ from the height shown elsewhere; the Moon's rise and set
meaning different things on the map and in the panel; almanac pages printing on four
sheets instead of two; map drawings that could not be removed.

### Findings made along the way

- **The US Naval Observatory's online Moon runs late by an amount that changes with the
  epoch:** −2.4 s (2000), +4.9 s (2016), +10.3 s (2026), worth up to 0.11′ of GHA.
- **USNO and the Nautical Almanac give Venus's centre of light**, up to 0.41′ from the
  centre of its disc; the planet provider follows them.
- **Skyfield's planetary magnitudes place the Sun at the solar-system barycentre**,
  worth up to 0.21 magnitude for a thin crescent Mercury; and its light-deflection formula
  diverges for a planet behind the Sun (3.2′ at the 2029 Uranus conjunction).
- **NASA's path table for the 2021 Antarctic eclipse is 2.3 km off**; this engine is
  within 0.16 km of DE440s there.
- **Natural Earth's time-zone field had real errors** (Prague in America/Chicago); 41 are
  corrected by documented rules.
- **The Bright Star Catalogue lists the recurrent nova T CrB at its 1866 peak** (magnitude
  2.0); it is left out of the star field.
- **The official ELP/MPP02 lunar server refused every connection**, so the Moon uses
  ELP 2000-82B, which is within 0.72″ of DE440s through 2061.
- **One site deploy path broke silently:** the Pages runner's wasm-pack rejects
  `--profile`; the size-optimised build now goes through `CARGO_PROFILE_RELEASE_OPT_LEVEL`.

### Data licences

- **Stars:** NASA HEASARC's BSC5P, listed by data.nasa.gov as a U.S. Government Work; no
  credit is required. The 58 navigational stars keep their Hipparcos data and its
  acknowledgement, as decided in the first sprint.
- **Constellation figures:** drawn for this project, under its own licence.
- **Constellation boundaries:** the IAU's 1930 definitions (public domain); the digital
  copy came from CDS, which asks for an acknowledgement, given in `THIRD_PARTY.md` only.
- **Map and gazetteer:** Natural Earth, public domain, no credit needed.
- **The only on-screen credit** is "© OpenStreetMap contributors", shown only while the
  optional street layer is on, as OpenStreetMap requires.

### Decisions and deviations, stated

- The explorer replaced the old home page on 2026-09-24; the original workbench stays at
  `/classic/` until it is retired (`BACKLOG.md`).
- The WebAssembly budget is set on the download: 1 MB gzipped (851 KB now), with a
  2.5 MB ceiling uncompressed (2.06 MB now); the planned 2 MB raw budget was exceeded by
  embedded ephemeris data that compresses well.
- Sight reduction stays on the spherical Earth of CONVENTIONS section 1; the explorer's
  displayed heights and eclipse circumstances use the WGS84 ellipsoid. The Earth's-shape
  term in Moon sights (up to 0.22′) is documented, not modelled.
- Eclipse contacts ignore the Moon's limb profile (1-3 s) and assume ΔT stays at its
  current value for future eclipses.
- The residual heat map's raster layer on the live map is off; the contour lines are shown.

### How it was built

Planned and integrated by the main session (Claude Opus 5.5 after the owner switched
models from Fable 5.1), with 23 agents in separate git worktrees (26 runs, counting the
three that came back for a second phase): 22 on Opus, and the documentation agent on
Sonnet. About 260 commits. The repository now holds about 64,000
lines of Rust source and 26,000 of Rust tests, 61,000 of TypeScript and 13,000 of its
tests, 12,000 of CSS, 11,000 of Python reference tooling and 10,000 of documentation.

### Reproduce

```bash
cargo test --workspace
npm ci --prefix web && npm run wasm --prefix web && npm test --prefix web
npm run build --prefix web
web/scripts/pages-site.sh            # assemble the site exactly as the Pages workflow does
node web/scripts/ui-check.mjs        # the 191 browser checks
node web/scripts/offline-check.mjs   # the offline and upgrade checks
cargo run --release -p skyfix-cli -- eclipse 2024-04-08-solar --lat 32.78 --lon -96.80
mdbook build docs
```

## Part 2 — The original sprint (2026-09-23/24)

Sprint of 2026-09-23/24, planned and integrated by Claude Fable 5.1 with parallel Opus
engineering agents and one Sonnet documentation agent, from the brief in `BRIEF.md`.
This report is written to be checked: every number here can be reproduced with a command
listed in `ACCURACY.md` or `DEMOS.md`.

**Everything in this repository is a simulation and analysis tool. No real sextant sight
has been taken with it. Numerical agreement with reference data is not field accuracy.**

### What exists and works

- **Numerical core** (`skyfix-core`): units and conventions, sight reduction with the six
  correction steps reported individually, session validation with JSON and CSV round-trip,
  a weighted least-squares position solver with multistart and explicit ambiguity
  classification, and a-priori covariance with a nominal 95 % ellipse and conditioning.
- **Offline astronomy** (`skyfix-ephemeris`): the Sun (VSOP87D, 1020 terms) and the 57
  navigational stars plus Polaris (Hipparcos positions, IAU 2006 precession, IAU 2000B
  nutation, aberration), any date 1990-2060, no network; plus a dated fixture-pack provider
  that says "limited-date operation" in its coverage notes.
- **Simulator** (`skyfix-sim`): seeded, truth stored in a separate document, ten packaged
  scenarios covering the six required demos, and an experiment runner that compares true
  error with predicted uncertainty.
- **Command line** (`skyfix`): `validate`, `reduce`, `solve`, `simulate`, `experiment`,
  `demos`, `plan`, `catalog`, `coverage`, `convert`.
- **Browser workbench** (`web/` + `skyfix-wasm`): the same Rust core compiled to
  WebAssembly, every asset bundled, live at <https://holdthedoorhoid.github.io/skyfix-lab/>
  with the documentation book under `/docs/`. Observation editor, correction table,
  graticule plot with circles of position and the ellipse, residuals, simulator with the
  truth shown only there, and the planner.
- **Observation planner**: ranks bodies by the improvement they bring to the fix geometry,
  never by brightness, with the disclosures the brief requires.
- **Follow-up modules**, each a separate crate with its own document: the stationary camera
  sextant on synthetic images (`skyfix-camera`, `CAMERA.md`), the polarization compass
  laboratory (`skyfix-polar`, `POLARIZATION.md`), and motion with independent-estimate
  disagreement checks (`skyfix-motion`, `MOTION.md`).

### Test results

`cargo test --workspace` at the final commit: **687 tests, 0 failures** (native), plus
98 TypeScript unit tests in `web/` and a WebAssembly build of every numerical crate. CI runs
formatting, tests, the wasm32 build, an offline smoke test of the release binary inside an
empty network namespace, and clippy with warnings denied; it is green on `main`.

### Validation that matters, with the numbers

| check | result | where |
|---|---|---|
| Stars vs Skyfield (JPL DE421), 3364 cases 1995-2055 | worst 0.0011' | `ACCURACY.md` |
| Star apparent places vs ERFA/SOFA worked example | 0.016" | `THIRD_PARTY.md`, `crates/skyfix-ephemeris` tests |
| Sun vs Skyfield, 58 epochs | worst GHA 0.0026', Dec 0.0012' | `ACCURACY.md` |
| USNO celestial-navigation service cross-check | GHA/Dec agree to 0.0001' | `fixtures/reference/usno_celnav_2026-10-01T0130Z.json` |
| Clean five-star geometry recovers its truth | 0.000 m (geocentric), 6.2 m (topocentric, diurnal aberration) | `ACCURACY.md` |
| Monte Carlo coverage of the nominal 95 % ellipse, independent noise, 2000 trials | 95.1 % | `crates/skyfix-core/tests/solver_coverage.rs` |
| Same, with a shared bias on every sight | 42 % (the documented failure of the independent-noise model) | same |
| Native vs WebAssembly, 19 cases | position 1.3e-9 deg, covariance 3.2e-10 relative | verifier report, below |
| 10 000 sights, release build | solve 8.6 s (1.0 s without the global grid) | verifier report |

### The six required demos (all simulations)

Numbers from `skyfix experiment --demo <name> --repetitions 100`; details in `DEMOS.md`.

| brief item | scenario | what it shows |
|---|---|---|
| 1. Philadelphia star simulation with bodies above the horizon | `philadelphia-stars`, `philadelphia-stars-real` | coverage 0.97, error/sigma 0.96; real catalogue stars resolved by the ephemeris |
| 2. Good versus clustered geometry | `good-geometry`, `clustered-geometry` | the ellipse changes shape, not just size: 3.2 x 2.3 km at condition 1.4 becomes 9.3 x 1.9 km at condition 4.9 with a PoorGeometry warning |
| 3. One bad observation | `one-bad-sight` | the wrong sight stands out at 5 arcminutes normalised residual; robust weighting moves the fix from 6.6 km to 0.9 km of the truth and says the covariance is now approximate |
| 4. Shared clock offset | `clock-offset` | 60 s of clock error moves the fix 0.2507 degrees west with residuals of exactly zero |
| 5. Shared altitude bias | `shared-bias` | 24 sights, 3' bias: error 7.0 km against a predicted 231 m, ratio 30; coverage 0 % |
| 6. Single sight and two-sight ambiguity | `single-sight`, `two-sight-ambiguous` | a circle with no point; two candidates with equal weight and no promotion |

### Adversarial verification

An independent Opus agent was given only the instruction to break the physical-honesty
claims. It found and fixed four defects, all now on `main` with regression tests:

1. A duplicated record could defeat the two-circle guard and turn two circles that never
   meet into a "unique fix" with an absurd covariance. Fixed; the guard now counts distinct
   circles, not records.
2. A body name with trailing whitespace passed validation as the Sun but was then refused
   a direction and given the sidereal clock rate. Fixed.
3. Negative coordinates in the space-separated flag form were rejected by the argument
   parser. Fixed.
4. A lint failure on the newer compiler used by CI. Fixed.

It also reported three honesty gaps, then fixed them with tests in a follow-up: the
experiment's guard against a prior centred on the truth was exact-equality only (now a
radius of three sigma or one nautical mile); the experiment verdict had no lower bound on
the error-to-sigma ratio (now a two-sided band, and the sentence names the direction of
the miss); and `--require-unique` accepted a fix whose ellipse had been suppressed (now
exit code 3). Five message-level paper cuts were fixed at the same time. Its verdict: the physical-honesty requirements hold. One sight
is a circle; two crossing circles stay ambiguous from five initializers including the
antipode; a converged fix is bit-identical across initializers; the clock term grows the
east sigma by exactly the predicted amount and the north sigma not at all; no code path
estimates a clock offset; corrections cannot run twice; no demo session contains a truth
digit or its seed.

### Findings the agents made along the way

- **Advancing a line of position must be a rotation of the sphere.** Reusing the run's
  north/east components at the body's geographic position is wrong by 23 km; the motion
  module applies the run as a rigid rotation, exact at the linearisation point
  (`MOTION.md`).
- **The polarization 180-degree ambiguity is exact only for a zenith-only sensor.** A wide
  field genuinely separates the two headings except near Sun altitudes of 0 and 90; the
  module returns both candidates with a chi-square separation test and says which regime
  applies (`POLARIZATION.md`).
- **Refraction biases a camera-only attitude by about 2.8 arcminutes**, and more stars do not
  help; a local vertical is needed even to correct the sky for itself (`CAMERA.md`).
- **The 58-star catalogue holds one star in a 40-degree field** at the briefed pointing, so
  the camera experiment uses an 80-degree lens and records the deviation (`CAMERA.md`).
- **The USNO almanac service treats UTC as UT1**, which settles the project's DUT1 = 0
  convention; the up-to-0.23' it costs is reported as an external term, not hidden.

### Deviations from the brief, stated

- The brief said not to deploy externally; the owner asked for a public GitHub site, so the
  workbench is published with a permanent "not a navigation instrument" banner.
- The `rand` crate was dropped because its random-source dependency does not build for
  WebAssembly without extra configuration; the simulator carries its own seeded generator.
- The camera experiment uses an 80-degree field instead of 40 (above).
- The brief's Meeus solar example numbers were from the low-accuracy method (25.a); the Sun
  provider is tested tightly against the high-accuracy one (25.b) and loosely against 25.a.

### Decisions the owner made

- Keep the 58-row Hipparcos extract with attribution to ESA and CDS (`THIRD_PARTY.md`).
  A larger catalogue is a labelled backlog item, not a sprint deliverable.
- Opus for every engineering agent, Sonnet for documentation; build everything in the brief
  including the three follow-up modules; MIT OR Apache-2.0; Python + Skyfield allowed for
  development-time reference data only.

### What is simulated and what is real

Simulated: every observation in this repository, every demo, every camera image, every
polarization image, every track. Real: the astronomical models and their agreement with
independent implementations (Skyfield, ERFA, USNO), which is what the tests establish.
Nothing here has been used to fix a position from a real instrument.

### Backlog

`BACKLOG.md` lists every item as completed, partial or unstarted with the reasoning.

### Reproduce

```bash
cargo test --workspace
cargo build --release -p skyfix-cli
./target/release/skyfix solve fixtures/sessions/reference-philadelphia-5star.json
./target/release/skyfix experiment --demo shared-bias --repetitions 100 --out bias.csv
npm install --prefix web && npm run wasm --prefix web && npm run build --prefix web
mdbook build docs
```
