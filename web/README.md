# SkyFix Lab — the explorer (web)

The site at <https://holdthedoorhoid.github.io/skyfix-lab/>: the map-first **explorer**
(`docs/EXPLORER_PLAN.md`, `docs/EXPLORER_GUIDE.md`). Vite + TypeScript, no framework; Rust
does every calculation through `crates/skyfix-wasm`, compiled to WebAssembly, and this
package draws it and refuses to overstate it.

**Nothing is fetched from a network to compute anything.** The numerical core, the offline
world map (Natural Earth), the place gazetteer, the star catalogue and the fonts are all
bundled and precached, so the site works offline once loaded. Three things use the
network, and only when asked: the optional "Street map (online)" layer (OpenStreetMap,
never stored), the manual at `docs/` (kept once read), and the optional data packs (see
"Data packs" below). `npm install` is the only build step that touches the network.

## Commands

Run from the repository root, or from `web/` without the `--prefix`.

| What | Command |
|---|---|
| Install | `npm install --prefix web` |
| Dev server (http://localhost:5173: the explorer at `/`, the developer pages under `/next/`) | `npm run dev --prefix web` |
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

A full build from a clean checkout is three commands, in this order:

```sh
npm install --prefix web
npm run wasm  --prefix web    # compiles the Rust into web/src/wasm-pkg
npm run build --prefix web    # emits web/dist
```

`vite.config.ts` sets `base: './'`, so `web/dist` works from any subdirectory — it is
served under `/skyfix-lab/` on GitHub Pages. **A production build with no WebAssembly
package fails, loudly**: `vite build` stops with the command to run, rather than shipping a
page with nothing to compute with. The planner can also start the dev server from
`.claude/launch.json` (entry `web`).

## Rebuilding the WebAssembly package

`npm run wasm` is exactly:

```sh
CARGO_PROFILE_RELEASE_OPT_LEVEL=s wasm-pack build crates/skyfix-wasm --target web \
  --out-dir ../../web/src/wasm-pkg --out-name skyfix_wasm --release
```

The output lands in `web/src/wasm-pkg/` and is **git-ignored**: it is a build artefact.
Vite finds it with `import.meta.glob`, so the site still builds for development when the
directory is absent (the development server then runs the mock engine, loudly). The core
module must stay under 1 MB gzipped and 2.5 MB raw (2026-09-24: 2.07 MB, about 850 KB gzipped).

The package's exports are the wire contract in `docs/EXPLORER_API.md`: one Rust module per
feature (`explorer.rs`, `starfield.rs`, `nav.rs`, `navsky.rs`, `almanac.rs`, `eclipses.rs`,
`planet_events.rs`, `misfit.rs`, `packs.rs`), plus the session exports in `lib.rs`
(`parse_session`, `reduce`, `solve`, `simulate`, `demos`, `experiment`, `plan`, `catalog`,
`coverage`) that Navigate and Learn reach through `src/api/` (the `SkyfixApi` session
adapter, kept from the original workbench). Every export is backed by real code; none is
stubbed.

## The engine switch — the one place it is chosen

`src/next/engine/index.ts` chooses the engine; everything else talks to the
`ExplorerEngine` interface in `src/next/engine/types.ts` (the TypeScript mirror of the
wire contract).

- **Default**: the WebAssembly core (`engine/wasm.ts`, `wasm-nav.ts`, `wasm-misfit.ts`).
  The app strip's badge reads `■ WASM core`.
- **`?engine=mock`**: the mock engine (`engine/mock.ts` and `mock/`), for interface work.
  It says so in the badge and in a notice that stays up; its numbers are illustrative.
- **No package built**: `npm run dev` falls back to the mock with a message that says
  exactly what is missing; a production build stops instead (above). A package that is
  present but fails to load is a fault, reported on a full-page error, never downgraded.
- **`?harness`**: a developer page of raw engine output (`src/next/harness/`).

`?engine=mock` and `?harness` work on the live site but need a connection: their chunks are
not precached.

## Pages

| Address | Source | What it is |
|---|---|---|
| `/` | `index.html` → `src/next/main.ts` | the explorer, the site's home page |
| `/next/` | `next/index.html` | forwards to `/`, keeping the query and the fragment (share links carry the place in it); the explorer's address while it was built |
| `/classic/` | `classic/index.html` | forwards to `/`, keeping the query and mapping the retired workbench's views: `#observations`, `#corrections`, `#fix`, `#planner` → `#navigate`, `#simulator` → `#learn`, `#about` → `#about`, anything else → `#navigate` |
| `/next/dev-*.html`, `/next/mockup.html` | the same folder | developer pages, served by `npm run dev` only |
| `/docs/` | `docs/` (mdBook) | the manual, added by the Pages workflow |

The original workbench that lived at `/classic/` was retired in the expansion programme
(`docs/EXPANSION_PLAN.md` §2.4): Navigate and Learn do everything it did. Its page code is
gone; `src/api/`, `types.ts`, `format.ts`, `geometry.ts`, `corrections.ts`, `csv.ts`,
`dom.ts`, `projection.ts` and `plot/graticule.ts` stay because the explorer uses them.

## Offline and installable

Once someone has opened the site, it works with no connection, and it can be installed as
an app ("SkyFix Lab", short name "SkyFix", opening at the home page). Help and About offer
**Install SkyFix Lab** when the browser has offered to install the page (its own install
entry keeps working), and tell iPhone and iPad users to use Share → Add to Home Screen.

**How.** At the end of `vite build`, `plugins/pwa.ts` starts from the app's page
(`index.html`), follows every file it can load (scripts, lazy views, stylesheets, fonts,
the map's worker, the WebAssembly module) and adds the files listed in `vite.config.ts`:
the basemap files its manifest lists, the gazetteer, the data packs' manifest, the web app
manifest and the icons. It compiles `src/sw/sw.ts` into `dist/sw.js` with that list and a
hash of it inlined, and prints the size (2026-09-24: 86 files, 11.7 MB, 4.1 MB gzipped).
The worker stores those files in a cache named by the hash and answers them from it. No
service-worker library is used.

| File | Does |
|---|---|
| `plugins/pwa.ts`, `plugins/precache.ts` | the build step above; refuses developer pages in a production build |
| `plugins/packs.ts` | the data packs' manifest (below) |
| `src/sw/sw.ts`, `src/sw/policy.ts` | the service worker and its decisions (type-checked against the WebWorker library) |
| `src/pwa/register.ts` | registration and update detection |
| `src/next/pwa/` | the Offline chip and the update prompt |
| `src/next/shell/install.ts`, `links.ts` | the Install offer, and the links to the manual and the repository |
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
- Pages that moved (`REDIRECT_PAGES` in `vite.config.ts`) are forwarded by the worker
  itself, offline too, with their query: `/next/` by a redirect (the browser keeps the
  fragment, so an old share link opens the home page at the shared place), `/classic/` by
  a small page that maps the old views' fragments (`forwardPageHtml`: the worker never sees
  a fragment). The pages at the old addresses do the same for a visitor with no worker yet.
  Neither is precached.
- Data packs are never precached and never go through the worker's caches (below).
- Everything else on the site (the docs) is fetched from the network first and kept for
  offline use once visited. An address never visited shows a small offline page that links
  the explorer and the manual.
- Developer pages (`next/dev-*.html`, `next/mockup.html`) are served by `npm run dev`
  only; production builds leave them out, and the build fails if one slips in.
  `SKYFIX_DEV_PAGES=1 npm run build` includes them in a local build (never precached).

**Adding a data file** the app loads from `public/`: add its path to `extra` in
`vite.config.ts`, or it will not work offline. The build warns about any file in the site
that is neither precached nor a build asset (the data packs excepted).

**Checking it.** `web/scripts/pages-site.sh` builds `site/` exactly as the Pages workflow
does; `node web/scripts/offline-check.mjs` serves it under `/skyfix-lab/` and drives
headless Chrome through a first visit (through an old share link at `/next/`), the retired
workbench's addresses online and offline, an offline reload with the server stopped (every
file must come from the worker), every view, the docs, an update, a data pack that must
survive a new worker and load offline, and a check that no cache holds another origin's
files. Screenshots go to `docs/design/local/pwa-*.png`. `SITE=web/dist PREFIX=/` checks
the layout `vite preview` serves.

**Upgrades.** `web/scripts/site-at.sh <ref> <dir>` builds the site as it was at any commit;
with `OLD_SITE=<dir>`, the check installs that version, deploys the new one and comes back
three ways (Reload in the old explorer, Reload in the old workbench, closing and reopening
the app), each of which must land on the explorer at the home page with the old copy
deleted and no unchanged file downloaded again. For the switch-over the old version is
`1688cd8`, the last commit with the explorer at `/next/`.

**Installed copies.** An app installed before the switch-over keeps its id
(`skyfix-lab/`), so it is the same app. Until the browser refreshes its copy of the
manifest it still starts at `/next/`, which forwards to the home page. Chrome refreshes an
installed app's manifest from any page that links a manifest with the same id, at most once
a day or per browser start (<https://web.dev/articles/manifest-updates>). Headless Chrome
here cannot install an app, so this last step is documented, not tested.

**If a broken version is ever deployed**, deploying a fixed one is enough: browsers look
for a new `sw.js` on every visit and offer it. To switch offline support off altogether,
deploy this as `sw.js` (for example from `public/`, with the plugin removed from
`vite.config.ts` and `startPwa()` taken out of `src/next/main.ts`); each browser drops the
stored copies on its next visit (the data packs' cache too), and pages already open keep
running until they are next loaded:

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

## Data packs

Data beyond the core — the `deep-time` series outside 1550–2650, US tide stations, the
Moon's limb profile — ships as optional packs (`docs/EXPANSION_PLAN.md` §3, contract in
`docs/EXPLORER_API.md` "Packs", rules in `docs/CONVENTIONS.md` §15.5). The first visit
stays about 1 MB; a pack downloads once, when a person turns it on or a view needs it.

- **Producing one.** The producer's generator writes `public/data/packs/<name>-<rev>.bin`
  (the common header of the contract around its payload; `rev` = the first 16 hex digits
  of the file's SHA-256) and a sidecar `public/data/packs/<name>.json` with `{name,
  version, bytes, label, description, provides}`, and adds one entry to `PRODUCERS` in
  `crates/skyfix-wasm/src/packs.rs`. Commit both files; delete the previous revision's.
- **At build time** `plugins/packs.ts` checks every pair (name, hash, size, header, CRC;
  one file per sidecar; nothing else in the folder) and writes
  `data/packs/manifest.json` (schema `skyfix.packs/1`), which is precached, so the page
  knows offline what exists. The sidecars are not deployed. `cargo test -p skyfix-wasm`
  installs every committed pack into the core, and so does the Pages workflow before it
  builds, so a pack the core cannot read never ships.
- **In the page** `src/next/packs/` is `ctx.packs`: `ensure(name, reason)` for a view that
  needs a pack (one prompt with the size, Get / Not now, remembered for the session),
  `get`, `remove`, `status`. A fetched pack is checked against the manifest, loaded into
  the engine, and only then saved in the app's own cache, `skyfix-lab-packs-1@<site>` —
  never the precache, never the runtime cache, so a new version of the site leaves it
  alone. Saved packs are loaded before the first view mounts. Settings → Data packs lists
  them with Get and Remove.
- **The worker** leaves `data/packs/*.bin` to the network (`networkOnly`) and never
  deletes the packs' cache.

## Layout

```
index.html          the explorer's page (/); next/index.html and classic/index.html only
                    forward to it (see "Pages")
src/
  next/             the explorer: docs/EXPLORER_PLAN.md section 4 lists its modules
    engine/         the engine switch, the WASM wrappers, the mock engine
    shell/          app strip, settings, share, install, links, router, stage, formats
    packs/          optional data packs (ctx.packs)
    map/ sky/ charts/ navigate/ almanac/ events/ learn/ about/ panel/ timebar/ theme/ …
  sw/, pwa/         the service worker and its registration (see "Offline and installable")
  api/              the session adapter (SkyfixApi) Navigate and Learn use: wasm.ts, mock.ts
  types.ts          mirror of crates/skyfix-core/src/types.rs, plus warningSentence()
  format.ts, geometry.ts, corrections.ts, csv.ts, projection.ts, dom.ts, plot/graticule.ts
                    helpers the explorer shares
plugins/            the build steps: pwa.ts, precache.ts, packs.ts
scripts/            offline, UI and screenshot checks; the Pages site builder
test/               vitest (node): the build steps, the worker's policy, the session adapter,
                    and test/next/ for the explorer
```

## House rules this interface follows

- The banner "Simulation and analysis workbench. Not a navigation instrument." is always
  visible and cannot be dismissed.
- Validated or labelled: every number is either checked against a reference or says what
  it is. The word **accuracy** is used only with a stated reference.
- Plain words first; the navigator's term beside them when Settings → Navigator's terms is
  on.
- Never colour alone: every line and marker has its own dash pattern, shape or word.
- The place is never stored and never sent anywhere; it goes into a link only on Share.
- Every number that came from a simulation is marked SIMULATED.

## Accessibility and size

Keyboard: every control is reachable; the time keys are listed under Help. Popovers,
tooltips and the tour return focus; screen readers get live regions for place changes,
notices, the data-pack prompt and the sky focus. Reduced motion is honoured. Checked in
the light, dark and night themes at 1440 × 900 and 390 × 844 by `scripts/ui-check.mjs`.

Production build, 2026-09-24: 2.45 MB of JavaScript (741 KB gzipped, most of it MapLibre's
1.1 MB map chunk, loaded with the Map view), 246 KB of CSS (48 KB gzipped), 459 KB of
fonts, and the 2.07 MB WebAssembly core (about 850 KB gzipped). The core is the offline
astronomy — VSOP87, ELP 2000-82B, the IAU 2006/2000B frame chain, the star catalogues —
and the navigation methods; it is the price of working with no network.
