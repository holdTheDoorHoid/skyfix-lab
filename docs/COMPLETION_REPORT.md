# Completion report

Sprint of 2026-09-23/24, planned and integrated by Claude Fable 5.1 with parallel Opus
engineering agents and one Sonnet documentation agent, from the brief in `BRIEF.md`.
This report is written to be checked: every number here can be reproduced with a command
listed in `ACCURACY.md` or `DEMOS.md`.

**Everything in this repository is a simulation and analysis tool. No real sextant sight
has been taken with it. Numerical agreement with reference data is not field accuracy.**

## What exists and works

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

## Test results

`cargo test --workspace` at the final commit: **687 tests, 0 failures** (native), plus
98 TypeScript unit tests in `web/` and a WebAssembly build of every numerical crate. CI runs
formatting, tests, the wasm32 build, an offline smoke test of the release binary inside an
empty network namespace, and clippy with warnings denied; it is green on `main`.

## Validation that matters, with the numbers

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

## The six required demos (all simulations)

Numbers from `skyfix experiment --demo <name> --repetitions 100`; details in `DEMOS.md`.

| brief item | scenario | what it shows |
|---|---|---|
| 1. Philadelphia star simulation with bodies above the horizon | `philadelphia-stars`, `philadelphia-stars-real` | coverage 0.97, error/sigma 0.96; real catalogue stars resolved by the ephemeris |
| 2. Good versus clustered geometry | `good-geometry`, `clustered-geometry` | the ellipse changes shape, not just size: 3.2 x 2.3 km at condition 1.4 becomes 9.3 x 1.9 km at condition 4.9 with a PoorGeometry warning |
| 3. One bad observation | `one-bad-sight` | the wrong sight stands out at 5 arcminutes normalised residual; robust weighting moves the fix from 6.6 km to 0.9 km of the truth and says the covariance is now approximate |
| 4. Shared clock offset | `clock-offset` | 60 s of clock error moves the fix 0.2507 degrees west with residuals of exactly zero |
| 5. Shared altitude bias | `shared-bias` | 24 sights, 3' bias: error 7.0 km against a predicted 231 m, ratio 30; coverage 0 % |
| 6. Single sight and two-sight ambiguity | `single-sight`, `two-sight-ambiguous` | a circle with no point; two candidates with equal weight and no promotion |

## Adversarial verification

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

## Findings the agents made along the way

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

## Deviations from the brief, stated

- The brief said not to deploy externally; the owner asked for a public GitHub site, so the
  workbench is published with a permanent "not a navigation instrument" banner.
- The `rand` crate was dropped because its random-source dependency does not build for
  WebAssembly without extra configuration; the simulator carries its own seeded generator.
- The camera experiment uses an 80-degree field instead of 40 (above).
- The brief's Meeus solar example numbers were from the low-accuracy method (25.a); the Sun
  provider is tested tightly against the high-accuracy one (25.b) and loosely against 25.a.

## Decisions the owner made

- Keep the 58-row Hipparcos extract with attribution to ESA and CDS (`THIRD_PARTY.md`).
  A larger catalogue is a labelled backlog item, not a sprint deliverable.
- Opus for every engineering agent, Sonnet for documentation; build everything in the brief
  including the three follow-up modules; MIT OR Apache-2.0; Python + Skyfield allowed for
  development-time reference data only.

## What is simulated and what is real

Simulated: every observation in this repository, every demo, every camera image, every
polarization image, every track. Real: the astronomical models and their agreement with
independent implementations (Skyfield, ERFA, USNO), which is what the tests establish.
Nothing here has been used to fix a position from a real instrument.

## Backlog

`BACKLOG.md` lists every item as completed, partial or unstarted with the reasoning.

## Reproduce

```bash
cargo test --workspace
cargo build --release -p skyfix-cli
./target/release/skyfix solve fixtures/sessions/reference-philadelphia-5star.json
./target/release/skyfix experiment --demo shared-bias --repetitions 100 --out bias.csv
npm install --prefix web && npm run wasm --prefix web && npm run build --prefix web
mdbook build docs
```
