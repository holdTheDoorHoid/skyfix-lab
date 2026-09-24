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
| Dev server (http://localhost:5173: the explorer at `/`, the original workbench at `/classic/`) | `npm run dev --prefix web` |
| Type check (must pass) | `npm run typecheck --prefix web` |
| Unit tests | `npm test --prefix web` |
| Rebuild the WebAssembly package | `npm run wasm --prefix web` |
| Production build into `web/dist` | `npm run build --prefix web` |
| Preview the production build | `npm run preview --prefix web` |
| Build the Pages site into `site/`, as the workflow does | `web/scripts/pages-site.sh` |
| Check the site offline in headless Chrome | `node web/scripts/offline-check.mjs` |
| Build the site as it was at an older commit (for the upgrade check) | `web/scripts/site-at.sh <ref> <dir>` |
| Check every view in every theme, on a desktop and a phone, in headless Chrome | `node web/scripts/ui-check.mjs` |
| Redraw the app icons after changing their SVG | `node web/scripts/render-icons.mjs` |

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

## Pages

Since the switch-over on 2026-09-24 (`docs/EXPLORER_PLAN.md`, section 1):

| Address | Source | What it is |
|---|---|---|
| `/` | `index.html` → `src/next/main.ts` | the explorer, the site's home page |
| `/classic/` | `classic/index.html` → `src/main.ts` | the original workbench, kept for reference for a transition period, with a notice pointing to the home page |
| `/next/` | `next/index.html` | forwards to `/`, keeping the query and the fragment (share links carry the place in it); the explorer's address while it was built |
| `/next/dev-*.html`, `/next/mockup.html` | the same folder | developer pages, served by `npm run dev` only |
| `/docs/` | `docs/` (mdBook) | the documentation, added by the Pages workflow |

## Offline and installable

Once someone has opened the site, it works with no connection, and it can be installed
as an app ("SkyFix Lab", short name "SkyFix", opening at the home page). OWNER: release
agent.

**How.** At the end of `vite build`, `plugins/pwa.ts` starts from the two app pages
(`index.html`, the explorer, and `classic/index.html`, the original workbench), follows
every file they can load (scripts, lazy views, stylesheets, fonts, the map's worker, the
WebAssembly module) and adds the files listed in `vite.config.ts`: the basemap files its
`manifest.json` lists, the gazetteer, the web app manifest and the icons. It compiles
`src/sw/sw.ts` into `dist/sw.js` with that list and a hash of it inlined, and prints the
size (today 91 files, 11.8 MB, 4.1 MB gzipped). The worker stores those files in a
cache named by the hash and answers them from it. No service-worker library is used.

| File | Does |
|---|---|
| `plugins/pwa.ts`, `plugins/precache.ts` | the build step above; refuses developer pages in a production build |
| `src/sw/sw.ts`, `src/sw/policy.ts` | the service worker and its decisions (type-checked against the WebWorker library) |
| `src/pwa/register.ts` | registration and update detection, for both pages |
| `src/next/pwa/` | the explorer's Offline chip and update prompt (design-system primitives) |
| `src/pwa/workbench-prompt.ts` | the original workbench's update prompt, in its own style |
| `public/manifest.webmanifest`, `public/icons/` | the web app manifest and icons (drawn from the logo mark) |

**Rules it keeps.**

- Another origin is never touched: the optional OpenStreetMap street layer is never
  stored by the worker (the OSMF tile usage policy forbids bulk caching); it only works
  online, and only the browser's normal HTTP cache sees its tiles.
- A new version never takes over by itself. The page shows "New version available" with
  **Reload**; nothing reloads until that is pressed, or until every tab of the site has
  been closed. Only the changed files are downloaded.
- Addresses are stored without their query; the explorer keeps a shared place in the
  fragment, which never reaches the worker.
- Pages that moved (`REDIRECT_PAGES` in `vite.config.ts`: `/next/`) are forwarded by the
  worker itself, offline too, with their query; the browser keeps the fragment across the
  redirect, so an old share link opens the home page at the shared place. The page at the
  old address does the same for a visitor who has no worker yet. Neither is precached.
- Everything else on the site (the docs) is fetched from the network first and kept for
  offline use once visited. An address never visited shows a small offline page.
- Developer pages (`next/dev-*.html`, `next/mockup.html`) are served by `npm run dev`
  only; production builds leave them out, and the build fails if one slips in.
  `SKYFIX_DEV_PAGES=1 npm run build` includes them in a local build (never precached).
  `?engine=mock` and `?harness` on the explorer need a connection: their chunks are not
  precached either.

**Adding a data file** the app loads from `public/`: add its path to `extra` in
`vite.config.ts`, or it will not work offline. The build warns about any file in the site
that is neither precached nor a build asset.

**Checking it.** `web/scripts/pages-site.sh` builds `site/` exactly as the Pages workflow
does; `node web/scripts/offline-check.mjs` serves it under `/skyfix-lab/` and drives
headless Chrome through a first visit (through an old share link at `/next/`), an offline
reload with the server stopped (every file must come from the worker), every view,
`/classic/`, old addresses, the docs, an update on both pages and a check that no cache
holds another origin's files. Screenshots go to `docs/design/local/pwa-*.png`.
`SITE=web/dist PREFIX=/` checks the layout `vite preview` serves.

**Upgrades.** `web/scripts/site-at.sh <ref> <dir>` builds the site as it was at any
commit; with `OLD_SITE=<dir>`, the check installs that version, deploys the new one and
comes back three ways (Reload in the old explorer, Reload in the old workbench, closing
and reopening the app), each of which must land on the explorer at the home page with the
old copy deleted and no unchanged file downloaded again. For the switch-over the old
version is `1688cd8`, the last commit with the explorer at `/next/`.

**Installed copies.** An app installed before the switch-over keeps its id
(`skyfix-lab/`), so it is the same app. Until the browser refreshes its copy of the
manifest it still starts at `/next/`, which forwards to the home page, and may show the
home page with a thin address bar, as a page outside its old scope (`/next/`). Chrome
refreshes an installed app's manifest from any page that links a manifest with the same
id (Chromium's `ManifestUpdateManager::OnManifestSeenOnPrimaryPage`), at most once a day
or per browser start; web.dev puts it at "within a day or two" of the app being launched
(<https://web.dev/articles/manifest-updates>), and `start_url` may change only because the
manifest has an `id`. Headless Chrome here cannot install an app (no `PWA` protocol
domain), so this last step is documented, not tested.

**If a broken version is ever deployed**, deploying a fixed one is enough: browsers
look for a new `sw.js` on every visit and offer it. To switch offline support off
altogether, deploy this as `sw.js` (for example from `public/`, with the plugin removed
from `vite.config.ts` and `startPwa()`/`startWorkbenchPwa()` taken out of the two
`main.ts` files); each browser drops the stored copies on its next visit, and pages
already open keep running until they are next loaded:

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('skyfix-lab-')) await caches.delete(name);
      await self.registration.unregister();
    })(),
  );
});
```

## Layout

```
index.html        the explorer's page (/); classic/index.html the original workbench's
                  (/classic/); next/index.html forwards /next/ to / (see "Pages")
src/
  next/           the explorer: docs/EXPLORER_PLAN.md section 4 lists its modules
  main.ts         the original workbench's entry; the files below are its own
  sw/, pwa/       the service worker and its registration (see "Offline and installable")
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
