# SkyFix Lab — browser workbench

The thin UI from `docs/BRIEF.md` ("Interface"): Vite + TypeScript, no framework, no
runtime dependencies in the shipped bundle. Rust does the arithmetic through
`crates/skyfix-wasm`; this package draws it and refuses to overstate it.

**Nothing is mocked and nothing is fetched from a network at runtime.** `skyfix-core`,
`skyfix-ephemeris` and `skyfix-sim` are compiled to WebAssembly and do all the
arithmetic, including the offline Sun and star astronomy. No CDN fonts, scripts, styles
or map tiles; the system font stack only. `npm install` is the only step that touches
the network.

## Commands

Run from the repository root, or from `web/` without the `--prefix`.

| What | Command |
|---|---|
| Install | `npm install --prefix web` |
| Dev server (http://localhost:5173) | `npm run dev --prefix web` |
| Type check (must pass) | `npm run typecheck --prefix web` |
| Unit tests | `npm test --prefix web` |
| Rebuild the WebAssembly package | `npm run wasm --prefix web` |
| Production build into `web/dist` | `npm run build --prefix web` |
| Preview the production build | `npm run preview --prefix web` |

A full build from a clean checkout is two commands, in this order:

```sh
npm install --prefix web
npm run wasm  --prefix web    # compiles the Rust into web/src/wasm-pkg
npm run build --prefix web    # emits web/dist
```

`vite.config.ts` sets `base: './'`, so `web/dist` works from any subdirectory — it is
served under `/skyfix-lab/` on GitHub Pages. **A production build with no WebAssembly
package fails, loudly**: `vite build` stops with the command to run, rather than
shipping a page with nothing to compute with.

The planner can also start the dev server from `.claude/launch.json` (entry `web`).

## Rebuilding the WebAssembly package

`npm run wasm` is exactly:

```sh
wasm-pack build crates/skyfix-wasm --target web \
  --out-dir ../../web/src/wasm-pkg --out-name skyfix_wasm --release
```

The output lands in `web/src/wasm-pkg/` and is **git-ignored**: it is a build artefact.
Add `--dev` for a fast unoptimised build. If `wasm-pack` is unavailable the equivalent is

```sh
cargo build -p skyfix-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir web/src/wasm-pkg --out-name skyfix_wasm \
  target/wasm32-unknown-unknown/release/skyfix_wasm.wasm
```

Vite discovers the package with `import.meta.glob`, so the site still builds when the
directory is absent — it just runs the mock.

### What the package exports

`crates/skyfix-wasm/src/lib.rs` is thin: JSON in, the owning crate's function, JSON out.
There are no feature gates and no stubs left.

| export | backed by |
|---|---|
| `version` | `skyfix_core::VERSION` |
| `parse_session` | `skyfix_core::session::{parse_session, validate}` |
| `reduce` | `skyfix_core::reduce::reduce_session` |
| `solve` | `reduce_session_partitioned` + `to_sights` + `skyfix_core::solver::solve` |
| `circle_points` | `skyfix_core::geometry::circle_of_position` |
| `simulate` | `skyfix_sim::generate::simulate` |
| `demos` | `skyfix_sim::demos` (all ten scenarios, with their own descriptions) |
| `experiment` | `skyfix_sim::experiment::run` |
| `plan` | `skyfix_ephemeris::visibility::plan_at` |
| `catalog` | `"Sun"` + `skyfix_ephemeris::catalog::names()` |
| `coverage` | each provider's `Coverage`, verbatim |

**Astronomy.** `ephemeris_mode = "supplied"` honours only the direction written into an
observation — the brief's "first numerical slice". `"auto"` still prefers a supplied
direction and otherwise asks a `skyfix_ephemeris::fixture_pack::CompositeProvider`
holding `SunProvider` then `StarProvider`.

**Positions and priors.** `SolveOptions.prior` wins over the session's
`assumed_position_role = prior`; when the options leave both unset, the adapter derives
them from the session and an `initializer` is never promoted to a prior. The Fix view
derives the same thing, so the two agree.

**Repetitions.** `experiment` refuses more than 1000: the solver runs on the page's own
thread, and an unbounded count would freeze the tab instead of producing a result.

## The adapter switch — the one file to change

`web/src/api/index.ts` is the only place an implementation is chosen. Everything else
talks to the `SkyfixApi` interface in `web/src/api/adapter.ts`.

- **Default**: the WebAssembly package. The header badge reads `■ WASM core` and there
  is no notice, because nothing is mocked.
- **`?api=mock`**: the mock adapter, for interface work. It announces itself in the
  header (`△ MOCK adapter`) and in a caution notice that stays up.
- **No package built**: `npm run dev` falls back to the mock *with a loud message*, so
  the interface can be worked on before the first `npm run wasm`. A production build
  never gets that far — see the build guard above.

The mock is never substituted silently, and a WebAssembly package that fails to load is
reported as a fault on a full-page error screen rather than quietly downgraded.

## What the mock adapter is for

`web/src/api/mock.ts`, `mockDemos.ts` and `fixtures.ts` exist for one purpose: working
on the interface with no WebAssembly build to hand. Reach them with `?api=mock`.

It understands the real `skyfix_sim::scenario::Scenario`, but only the parts the
packaged demos use, and it refuses rather than approximates anything it cannot do:

- `BodySource::Named` is refused — the mock has no star catalogue;
- `plan()` is refused, for the same reason;
- shared-bias estimation, robust weighting and priors are reported as unsupported.

What it genuinely computes: circles of position, two-circle intersections, the six-step
correction chain, a weighted Gauss-Newton fit with its a priori covariance, a seeded
simulator, and a coverage experiment with a Wilson interval. Three demo scenarios of its
own stand in for the ten real ones. None of it is a result, and the interface says so
the whole time it is running.

## Layout

```
src/
  types.ts        mirror of crates/skyfix-core/src/types.rs, plus warningSentence()
  format.ts       degrees as decimal AND deg + arcmin; metres, NM, arcminutes
  geometry.ts     the part of skyfix_core::geometry the drawing needs
  corrections.ts  CONVENTIONS section 5, for the mock only
  projection.ts   equirectangular projection, graticule steps, Liang-Barsky clipping
  csv.ts          convenience CSV (the core owns the canonical parser)
  store.ts        state and a subscribe/notify store
  app.ts          header banner, tabs, notices
  api/            adapter.ts (interface), wasm.ts, mock.ts + mockDemos.ts, index.ts (the switch)
  plot/           graticule.ts (SVG position plot), residuals.ts (bar chart)
  views/          observations, corrections, fix, simulator, planner, about
test/             vitest: format, projection/clipping, warnings, csv, geometry, mock
```

## House rules this interface follows

- Name things by what they do. The assumed-position selector reads "Initializer only
  (does not influence the answer)" / "Prior (influences the answer; reported)".
- Never hide a control that has an effect. Solver options are on the Fix view, not in a
  settings drawer.
- Warnings sit next to what they modify, as sentences, each tagged *Caution* or *Note*.
- Colour-blind-safe (Okabe-Ito) and **never colour alone**: every circle of position has
  its own dash pattern, every marker its own shape, every state its own word.
- Units in every label; angles shown as `39.9526° (39° 57.2′)`.
- The word **accuracy** appears nowhere. What is reported is a *nominal uncertainty*
  under a stated model.
- Every number that came from a simulation is marked, and the truth position is drawn on
  the Simulator view only. "Send session to Observations" copies the session and not the
  truth.
- The banner "Simulation and analysis workbench. Not a navigation instrument." is always
  visible and cannot be dismissed.

## Accessibility and size

Tabs are a keyboard-navigable `tablist` (arrow keys, Home, End) with visible focus
rings. Tables reflow into labelled cards below 760 px. Layout is tested at 1024 px and
in phone portrait.

Production bundle: 108 kB of JavaScript (36 kB gzipped), 11 kB of CSS (3 kB gzipped) and
a 822 kB WebAssembly module (304 kB gzipped). The WebAssembly is the offline astronomy —
VSOP87D, the IAU 2006/2000B frame chain and the Hipparcos navigational star catalogue —
and it is the price of working with no network. No runtime JavaScript dependencies.
