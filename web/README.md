# SkyFix Lab — browser workbench

The thin UI from `docs/BRIEF.md` ("Interface"): Vite + TypeScript, no framework, no
runtime dependencies in the shipped bundle. Rust does the arithmetic through
`crates/skyfix-wasm`; this package draws it and refuses to overstate it.

**Nothing is fetched from a network at runtime.** No CDN fonts, scripts, styles or map
tiles; the system font stack only; the WebAssembly module is emitted as a local asset
next to the page. `npm install` is the only step that touches the network.

## Commands

Run from the repository root, or from `web/` without the `--prefix`.

| What | Command |
|---|---|
| Install | `npm install --prefix web` |
| Dev server (http://localhost:5173) | `npm run dev --prefix web` |
| Type check (must pass) | `npm run typecheck --prefix web` |
| Unit tests | `npm test --prefix web` |
| Production build into `web/dist` | `npm run build --prefix web` |
| Preview the production build | `npm run preview --prefix web` |
| Rebuild the WebAssembly package | `npm run wasm --prefix web` |

`vite.config.ts` sets `base: './'`, so `web/dist` works from any subdirectory — it is
served under `/skyfix-lab/` on GitHub Pages.

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

### Cargo features: turning the real core on

`crates/skyfix-wasm` is compiled against a workspace whose numerical core is still being
written. Exports whose Rust is `todo!()` would *abort* the WebAssembly module if called
(wasm32 panics abort; there is no `catch_unwind`), so they are compiled out behind cargo
features and return `Err("not implemented: <name>")` instead. Each is a one-line flip of
`default` in `crates/skyfix-wasm/Cargo.toml`:

| feature | switches on | owned by |
|---|---|---|
| `core-ready` | `parse_session`, `reduce`, `solve` | core-reduce + core-solver |
| `ephemeris-ready` | ephemeris-backed `reduce`, real `catalog()` and `coverage()` | ephemeris |
| `sim-ready` | `simulate` | sim |

`version()`, `circle_points()` and `catalog()` are real in every build; `circle_points`
calls `skyfix_core::geometry::circle_of_position`, which is not stubbed.

`cargo check -p skyfix-wasm --features core-ready` **passes today** — that path is
written against the current `skyfix-core` signatures and only needs the `todo!()`s
filled. The other two features additionally need symbols that do not exist yet:

- `sim-ready`: `skyfix_sim::simulate(&Scenario) -> Result<(Session, Truth), E>` where
  `E: Display`. `Scenario` is defined in `crates/skyfix-wasm/src/lib.rs` and mirrored in
  `web/src/api/adapter.ts`; it is a **proposal**, so change both together if the sim
  agent wants a different shape.
- `ephemeris-ready`: `skyfix_ephemeris::catalog::body_names() -> &[&str]`,
  `skyfix_ephemeris::fixture_pack::default_provider() -> impl AstroProvider`, and
  `skyfix_ephemeris::providers() -> &[&dyn AstroProvider]`.

Always run `cargo check -p skyfix-wasm --features <feature>` before switching a default
on.

## The adapter switch — the one file to change

`web/src/api/index.ts` is the only place an implementation is chosen. Everything else
talks to the `SkyfixApi` interface in `web/src/api/adapter.ts`.

- **Default**: the WebAssembly package when `web/src/wasm-pkg/` exists, the mock otherwise.
- **`?api=mock`**: force the mock.
- **`?api=wasm`**: force the WebAssembly package; falls back with an explicit message
  if it is missing or fails to load.

At startup `selectApi()` **probes** the package by calling `parse_session` and
`simulate` once. If they answer `not implemented`, it builds a `HybridApi`: the real
WASM for what works, the mock for what does not, and a `mockedCalls` list that the
header badge and the About view print. So the interface is fully usable today and
becomes fully real the moment the cargo features go on — with no edit here.

Which implementation is running is **never hidden**: the header badge reads
`■ WASM core`, `◨ WASM core, partly mocked`, or `△ MOCK adapter`, and a caution notice
says what is illustrative.

## What is mocked

`web/src/api/mock.ts` and `web/src/api/fixtures.ts`. The mock is honest about being a
stand-in, and it is the only place in `web/` that does navigation arithmetic.

Genuinely computed (spherical geometry, CONVENTIONS sections 2-3, ported in
`src/geometry.ts` and pinned to the Rust by `test/geometry.test.ts`):

- circles of position and two-circle intersections;
- the six-step correction chain (`src/corrections.ts`: dip, Bennett refraction,
  artificial-horizon halving, semidiameter, parallax) — a simplified port, not the core's;
- a plain weighted Gauss-Newton fit with its a priori covariance, 95 % ellipse,
  conditioning and residuals;
- a seeded simulator (mulberry32 + Box-Muller) that generates sights from a truth
  position and writes the truth to a **separate** document.

Invented or canned:

- everything needing an ephemeris — the mock has none, so every observation must carry
  its own `geocentric` GHA/declination (the brief's "first numerical slice");
- the `failed` result (`src/api/fixtures.ts`), reachable by putting `mock:failed` in the
  session notes;
- `version()` returns `0.1.0-mock`;
- shared-bias estimation, robust weighting and priors are **not** implemented in the
  mock: it says so in a warning rather than pretending.

`src/api/fixtures.ts` also holds a hand-written `unique` fix with a 95 % ellipse and
five residuals, an `ambiguous` result with two candidates and two circles, an
`underdetermined` result with one circle, a full six-step `CorrectionBreakdown` with
skipped steps, and one example of every `Warning` variant.

## Layout

```
src/
  types.ts        mirror of crates/skyfix-core/src/types.rs, plus warningSentence()
  format.ts       degrees as decimal AND deg + arcmin; metres, NM, arcminutes
  geometry.ts     the part of skyfix_core::geometry the drawing needs
  corrections.ts  CONVENTIONS section 5, for the mock only
  projection.ts   equirectangular projection, graticule steps, Liang-Barsky clipping
  csv.ts          convenience CSV (the core owns the canonical parser)
  demos.ts        the six packaged demos from the brief
  store.ts        state and a subscribe/notify store
  app.ts          header banner, tabs, notices
  api/            adapter.ts (interface), mock.ts, wasm.ts, index.ts (the switch)
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

Production bundle: about 90 kB of JavaScript (30 kB gzipped), 10 kB of CSS, and a 41 kB
WebAssembly module (19 kB gzipped). No runtime dependencies.
