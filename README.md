# SkyFix Lab

SkyFix Lab is an offline celestial-navigation workbench in Rust: a digital-sextant sight
reducer, a weighted least-squares position solver with honest uncertainty, and a
deterministic error simulator, sharing one numerical core between a command-line tool and
a browser workbench (Rust compiled to WebAssembly). It answers one question throughout:
*where do these sky observations place me, and how much should I trust the answer?*

**This is a simulation and analysis tool, not a navigation instrument.** Numerical
agreement with reference data is not field accuracy — see
[`docs/ACCURACY.md`](docs/ACCURACY.md).

**Live workbench:** <https://holdthedoorhoid.github.io/skyfix-lab/>
**Documentation:** <https://holdthedoorhoid.github.io/skyfix-lab/docs/>

## Quick start: build and run the CLI

```console
$ cargo build --release -p skyfix-cli
   Compiling skyfix-cli v0.1.0 (.../crates/skyfix-cli)
    Finished `release` profile [optimized] target(s)
```

Three real runs, from the repository root, output trimmed to the essentials.

### 1. Solve a five-star Philadelphia fix from supplied directions

```console
$ cargo run -p skyfix-cli --release -- solve fixtures/sessions/reference-philadelphia-5star.json
UNIQUE FIX
Position     39.952599, -75.165273
             39 57.16' N, 075 09.92' W
Uncertainty  sigma north 118.9 m (0.064 NM), sigma east 115.4 m (0.062 NM)
Ellipse 95%  semi-major 291.1 m, semi-minor 282.5 m, orientation 1.2 deg clockwise from north
Fit          chi2 0.0000 on 3 degree(s) of freedom, converged after 5 iteration(s)
```

This fixture's truth is 39.9526, -75.1652 — the fix agrees to the last printed digit. The
fixture's own target is 10 m on clean, well-conditioned synthetic geometry
(`docs/ACCURACY.md` section 3): a numerical regression target, not a field-accuracy claim.

### 2. A shared clock offset moves a fix that looks perfect

```console
$ cargo run -p skyfix-cli --release -- simulate --demo clock-offset \
      --out-session clock.session.json --out-truth clock.truth.json
$ cargo run -p skyfix-cli --release -- solve clock.session.json
UNIQUE FIX
Position     39.952600, -75.415884
             39 57.16' N, 075 24.95' W
Fit          chi2 0.0000 on 3 degree(s) of freedom, converged after 3 iteration(s)

Residuals
  obs-1 .. obs-5   resid ' 0.00 (every one)
```

A watch one minute fast moves this fix 0.2507 degrees (about 21.3 km) west of the truth
(39.9526, -75.1652), and **every residual is exactly zero**: clock error and longitude are
the same unknown for star sights, so the solver never estimates one. See
[`docs/DEMOS.md`](docs/DEMOS.md), demo 4, for what to declare instead.

### 3. Plan which stars to shoot, from Philadelphia

```console
$ cargo run -p skyfix-cli --release -- plan --position 39.9526,-75.1652 --utc 2026-10-01T01:30:00Z
OBSERVATION PLAN
Position   39 57.16' N, 075 09.91' W (39.952600, -75.165200)
Shoot in this order
  #   body                  alt      Zn    mag  sigma '       score
  1   Vega                 61.1   280.1   0.03     1.00        21.8
  2   Polaris              40.0     0.8   1.97     1.00        21.8
  3   Mirfak               27.0    46.0   1.79     1.00       457.1
```

Ranked by what each sight does to the fix's conditioning, never by brightness — Vega wins
the first slot for altitude, and Polaris is picked second because it is the only body that
constrains the otherwise-unconstrained north-south axis. See `docs/PLANNER.md`.

## Run the tests

```console
$ cargo test --workspace
...
test result: ok. 675 passed; 0 failed; ...
```

**675 tests passed, 0 failed**, summed across every crate's unit, integration and doc
tests, run in this worktree. Run one crate's suite with `cargo test -p <crate>`.

## Build the browser workbench

Full instructions: [`web/README.md`](web/README.md). The short version, from the
repository root:

```console
$ npm install --prefix web
$ npm run wasm  --prefix web     # compiles crates/skyfix-wasm to WebAssembly
$ npm run build --prefix web     # emits web/dist
dist/assets/skyfix_wasm_bg-*.wasm  822.28 kB │ gzip: 304.38 kB
dist/assets/index-*.css             11.04 kB │ gzip:   3.17 kB
dist/assets/index-*.js             108.48 kB │ gzip:  35.56 kB
```

No CDN fonts, scripts or map tiles: every asset is bundled. `npm run dev --prefix web`
starts a local dev server at <http://localhost:5173>; `npm test --prefix web` runs the
TypeScript unit tests (98 passing, across 6 files, at the time of writing).

## Layout

| path | what |
|---|---|
| `crates/skyfix-core` | units, conventions, sight reduction, corrections, solver, uncertainty (no I/O) |
| `crates/skyfix-ephemeris` | offline Sun and navigational-star providers, fixture packs, coverage metadata |
| `crates/skyfix-sim` | seeded simulator, error experiments, Monte Carlo coverage checks |
| `crates/skyfix-cli` | `skyfix validate\|reduce\|solve\|catalog\|coverage\|convert\|demos\|simulate\|experiment\|plan`, and the explorer engine's `sky\|events\|phases\|seasons\|noon\|polaris\|average\|running-fix\|predict\|lunar\|plan-sights` |
| `crates/skyfix-wasm` | wasm-bindgen adapter for the browser |
| `crates/skyfix-camera` | module A: stationary camera star-sextant on synthetic images |
| `crates/skyfix-polar` | module B: polarization compass heading laboratory (simulation only) |
| `crates/skyfix-motion` | module C: running fixes and independent-estimate disagreement checks |
| `web/` | TypeScript + Vite workbench, all assets bundled |
| `fixtures/` | sessions, separate truth files, independent reference cases |
| `tools/reference/` | Python + Skyfield fixture generators (development-time only) |
| `docs/` | brief, conventions, architecture, demos, accuracy, third-party inventory, backlog |

`docs/CONVENTIONS.md` is normative for every sign, unit and frame in the project.

## Documentation

- [`docs/README.md`](docs/README.md) — the documentation book's front page and quick start
- [`docs/BRIEF.md`](docs/BRIEF.md) — the original design brief and proposal
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — every sign, unit, frame and file format (normative)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — crate map, data flow, why these choices
- [`docs/DEMOS.md`](docs/DEMOS.md) — the six required demos, with commands and headline numbers
- [`docs/CLI.md`](docs/CLI.md) — every `skyfix` subcommand, with worked examples
- [`docs/PLANNER.md`](docs/PLANNER.md) — what the observation planner optimises
- [`docs/SIMULATOR.md`](docs/SIMULATOR.md) — the seeded simulator and its sign conventions
- [`docs/CAMERA.md`](docs/CAMERA.md) — the synthetic camera sextant
- [`docs/POLARIZATION.md`](docs/POLARIZATION.md) — the polarization compass laboratory
- [`docs/MOTION.md`](docs/MOTION.md) — running fixes and disagreement checks
- [`docs/ACCURACY.md`](docs/ACCURACY.md) — what every number is worth, and how to reproduce it
- [`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md) — every external algorithm, data file and licence
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — completed, partial and unstarted, with reasons
- [`docs/COMPLETION_REPORT.md`](docs/COMPLETION_REPORT.md) — the sprint's final honest-state report

Or read the whole book at once: `mdbook build docs` (needs
[mdBook](https://rust-lang.github.io/mdBook/)), then open `docs/book/index.html` — this is
what the documentation URL above serves.

## License

MIT OR Apache-2.0, at your option. See `LICENSE-MIT` and `LICENSE-APACHE`.
