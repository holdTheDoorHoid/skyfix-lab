# Architecture

SkyFix Lab answers one question: *where do these sky observations place me, and how
much should I trust the answer?* Everything is arranged so that the numerical core is
small, pure and shared, and so that the physical limits of celestial navigation are
visible in the API rather than papered over.

## Crate map and data flow

```
 session JSON / CSV                     camera image (synthetic)
        |                                       |
        |                                       v
        |                      skyfix-camera: centroid -> identify -> attitude
        |                                (Wahba/Davenport -- ORIENTATION ONLY)
        |                                       |
        |                      + vertical: inclinometer, horizon line, or supplied
        |                                (never derived from the star field)
        |                                       v
        |                      Vec<Observation> (apparent_ha, electronic_vertical)
        |                                       |
        +---------------------------------------+
        v
 skyfix-core::session  -- validate, normalise            (no I/O anywhere in core)
        |
        v
 skyfix-core::reduce   -- for each observation:
        |                  direction  <-- supplied in the record, or
        |                                 skyfix-ephemeris (Sun, stars, fixture pack)
        |                  corrections <-- skyfix-core::corrections (six explicit steps)
        |                  Hc, Zn, intercept at the assumed position (if any)
        v
 skyfix-motion::running_fix -- under way only: advance each sight's geographic
        |                position to one reference instant by a rigid rotation of the
        |                sphere, inflate its sigma by the dead-reckoning term along the
        |                line of sight, then hand the result to the solver unchanged
        v
 skyfix-core::solver   -- weighted least squares on the sphere, multistart,
        |                  ambiguity classification, optional shared bias / robust / prior
        v
 skyfix-core::uncertainty -- a-priori covariance, nominal 95 % ellipse, conditioning
        |
        v
 FixResult { underdetermined | ambiguous | unique | failed }
        |
   +----+-----------------------------+
   v                                  v
 skyfix-cli (files, tables, JSON)   skyfix-wasm -> web/ (TypeScript workbench:
                                     observations, corrections, fix, simulator,
                                     planner, about -- WASM core, no network)

 skyfix-sim -- seeded scenarios -> (Session, Truth) kept in separate documents;
               experiment runner compares true error with predicted uncertainty.

 skyfix-motion::compare -- separate from the pipeline above: compares two already-
               computed estimates (a celestial fix, a GNSS position, a heading) and
               reports a disagreement statistic, never a diagnosis.

 skyfix-polar -- a standalone laboratory, sharing only skyfix-core::geometry (the
               Sun's altitude/azimuth) and skyfix-core::linalg (the few-channel
               sensor's least squares): ideal Rayleigh sky -> synthetic analyzer
               images -> Stokes recovery -> heading candidates. Never a position.
```

- `skyfix-core` owns units, time, the altitude model and its derivatives
  (`geometry`), the correction chain, validation, the solver and uncertainty. It does no
  file or network I/O and builds for `wasm32-unknown-unknown`.
- `skyfix-ephemeris` provides apparent geocentric directions of date behind the
  `AstroProvider` trait. Providers declare coverage and refuse out-of-range queries.
- `skyfix-sim` generates observations from a hidden truth using the same `geometry`
  kernel, injects independent noise, shared bias, clock offset, missing and wrong sights,
  and evaluates the solver against the truth.

### The three module crates

- **`skyfix-camera`** runs a synthetic star image through centroiding, closed-world star
  identification (the 58-star navigational catalogue and its 1653 pair angles), and
  Wahba/Davenport attitude solving, then turns that attitude plus an independently
  obtained local vertical — a simulated inclinometer, a fitted sea-horizon line, or a
  caller-supplied value, but never the star field itself — into `apparent_ha` /
  `electronic_vertical` observations that feed `skyfix-core::reduce` unchanged. Its
  honesty rule is enforced by types, not warnings: `Attitude` has no latitude, longitude
  or altitude field, and the only function that produces an altitude requires a
  `LocalVertical` argument with no default, no `Option`, and no "estimate it from the
  stars" path — identifying stars yields orientation, never location (CAMERA.md
  section 1). Star identification is a closed world of 58 stars, which CAMERA.md section
  4 measures fails on a plausible 40-degree lens at Philadelphia; that is the module's
  own stated limit, not a hidden one.
- **`skyfix-polar`** is a self-contained simulation laboratory: an ideal
  single-scattering Rayleigh sky model, synthetic four-channel or few-channel analyzer
  images with seeded instrument defects (gain mismatch, misalignment, a missing-sky mask,
  a depolarization patch), Stokes recovery, and a heading search. It shares only
  `skyfix-core::geometry` and `skyfix-core::linalg` and never calls the solver. Its
  honesty rule: a heading estimate always returns the exact `best + 180` candidate
  alongside the best one, because the model's Sun/anti-Sun symmetry can make them
  genuinely indistinguishable, and the crate does not attempt position at all —
  geolocation from polarization is deferred by design (POLARIZATION.md sections 1 and 5).
- **`skyfix-motion`** adds a moving observer without changing the position solver's
  model: `running_fix` advances each sight's geographic position to one reference
  instant by a rigid rotation of the sphere (measured to be exact at the linearisation
  point and wrong by tens of kilometres if done as a flat-plane move instead) and
  inflates its sigma by the dead-reckoning uncertainty along the line of sight, then
  hands the result to `skyfix_core::solver::solve` unchanged; `compare` separately
  checks whether two already-computed estimates — a celestial fix, a GNSS position, a
  heading — agree within their combined modelled uncertainty. Its honesty rule: the
  first and only output of a disagreement is the sentence "*these two disagree beyond
  their modelled uncertainty*", followed verbatim by a fixed list of six equally-ranked,
  indistinguishable causes that includes "a wrong or spoofed reference" as one entry
  among six — the word "spoofing" never appears as a conclusion (MOTION.md section 4).

### The CLI, the WASM adapter and the browser

- **`skyfix-cli`** is the whole engine behind a terminal: `validate`, `reduce`, `solve`,
  `catalog`, `coverage`, `convert`, `demos`, `simulate`, `experiment` and `plan`, all
  thin wrappers that parse arguments, call the core crates, and print. Its honesty rule
  lives in the exit codes: an ambiguous or underdetermined result exits 0, because that
  is the correct answer to an under-constrained question and not a failure, while
  `--require-unique` exists for a script that genuinely needs one point (CLI.md,
  "Exit codes"). The CLI computes nothing itself; every number in its output comes from
  `skyfix-core`, `skyfix-ephemeris` or `skyfix-sim`.
- **`skyfix-wasm`** is a `wasm-bindgen` adapter, JSON in and JSON out, exposing
  `skyfix-core`, `skyfix-ephemeris` and `skyfix-sim` to the browser with no feature gates
  and no stubs. Its honesty rule: every export is backed by real code, so a call that
  cannot be answered returns the core's own error message rather than an approximation,
  and JSON crossing the boundary uses `Serializer::json_compatible` specifically so a
  suppressed ellipse (`null`) can never be confused with a field the adapter forgot to
  set (`undefined`) (`crates/skyfix-wasm/src/lib.rs`).
- **`web/`** is a Vite + TypeScript workbench with every asset bundled — no CDN fonts,
  scripts or map tiles — built around one `SkyfixApi` interface with exactly one
  production implementation (the WebAssembly core) and one clearly self-announcing mock
  for interface work (`?api=mock`), never substituted silently. Its honesty rule: the
  word "accuracy" appears nowhere in the interface — what is reported is a nominal
  uncertainty under a stated model — the banner "Simulation and analysis workbench. Not
  a navigation instrument." cannot be dismissed, and a simulation's truth is drawn only
  on the Simulator view (web/README.md).

## Why these choices

**One geometry kernel.** The solver, the simulator, the planner and the reducer all call
`geometry::altitude_azimuth` and `geometry::tangent_row`. Round-trip agreement between
simulator and solver therefore proves consistency only; correctness is established
separately by fixtures generated with Skyfield (`fixtures/reference/`), which never touch
Rust output.

**Result kinds instead of a number.** One sight gives a circle. Two give two points.
`FixResult` makes the caller handle `underdetermined` and `ambiguous` explicitly; there is
no way to get a lat/lon out of the solver without choosing to ignore the kind.

**No hidden prior.** An assumed position is an initializer unless the session says
`role = prior` with a sigma, in which case the result reports the fix with and without it.

**A-priori covariance.** With two or three sights the residuals cannot estimate their own
noise, so the covariance uses the declared sigmas. Posterior scaling is opt-in and only
reported with at least three degrees of freedom.

**Clock is propagated, not estimated.** For stars, a shared clock error is exactly a
longitude shift, so estimating both is meaningless. The declared clock uncertainty becomes
an east-west covariance term that is reported separately.

**Compact ephemeris.** The Sun (VSOP87-based) and the 57 navigational stars plus Polaris
(Hipparcos positions with IAU 2006/2000 precession, nutation and aberration) fit in a few
hundred kilobytes and cover 1990-2060 with documented accuracy, so the browser build needs
no multi-megabyte planetary ephemeris. Other bodies use a dated fixture pack that says
"limited-date operation" in its coverage notes.

**Own random generator.** The `rand` stack pulls in `getrandom`, which does not build for
`wasm32-unknown-unknown` without extra configuration. A 60-line splitmix64/xoshiro256**
generator with Box-Muller normals is deterministic and bit-identical on native and WASM.

**Spherical Earth, 1' = 1 NM.** Star altitudes depend only on direction, so the spherical
altitude formula with geodetic latitude is exact for stars; the sphere only enters the
conversion of angular position error to metres, where a 0.3 % radius difference is
irrelevant at the tens-of-metres level.

## Conventions

`docs/CONVENTIONS.md` is normative for every sign, unit, frame and schema. Each numerical
module cites the section it implements.

## Development process

The project was built by a planning model coordinating parallel engineering agents, each in
its own git worktree and branch (`agent/<name>`), with `docs/CONVENTIONS.md` and
`skyfix-core::types` fixed first as the shared contract. Reference fixtures were generated
by a separate agent with an independent toolchain (Python + Skyfield). Integration,
review and the completion report are the planner's.
