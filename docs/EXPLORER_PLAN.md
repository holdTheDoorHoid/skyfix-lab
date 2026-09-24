# Explorer redesign — program plan

**Status:** normative for every agent working on the redesign. Owner: the planning
session. Started 2026-09-24. The wire contract between Rust and the browser is
[`EXPLORER_API.md`](EXPLORER_API.md). Numeric rules stay in [`CONVENTIONS.md`](CONVENTIONS.md)
(section 13 covers the explorer).

## 1. What the owner asked for

A prettier site that is easier to use and understand, in the look and feel of
suncalc.org, with the feature set expanded from suncalc.org, mooncalc.org,
planetscalc.org and alejandrozarco/celestial-navigator. The owner wants to go backward
and forward in time, set a location, see where everything in the sky is from there, and
see that data drawn.

### Decisions (interview, 2026-09-24)

| Question | Answer |
|---|---|
| Map source | **Both**: a built-in offline world map (Natural Earth, public domain) that always works, plus an optional online OpenStreetMap street layer |
| Feature bundles | **All four**: Moon and planets (validated for fixes); more navigation methods (noon sight, Polaris, running fix, averaging a run of sights, lunar distance); printable nautical almanac pages; eclipses and sky events |
| Star field | **Add naked-eye stars and constellation figures**, display only. Follow-up from the owner: **prefer data that needs no credit**. Use NASA HEASARC's copy of the Yale Bright Star Catalogue (BSC5P, listed on data.nasa.gov as a U.S. Government Work) and constellation figures this project draws itself. A credit-requiring source is a fallback that needs the owner's approval first |

### Design calls made by the planner (the owner delegates human-factors design)

- The explorer becomes the home page. The existing workbench's features move into
  **Navigate** and **Learn**; nothing it can do today is lost.
- Plain words first, navigator terms beside them ("Height above horizon · altitude").
- Themes: **light** (SunCalc-like), **dark**, and **red night-vision** (preserves dark
  adaptation on deck).
- Works on a phone (the side panel becomes a bottom sheet) and offline once visited.
- The new UI was built at **`/next/`** on the Pages site while the old one stayed at `/`,
  until it was feature-complete and verified; they were **switched over on 2026-09-24**.
  The explorer is the home page; the original workbench is kept for reference at
  **`/classic/`** for a transition period; `/next/` forwards to the home page, keeping a
  share link's fragment.
- SunCalc is an inspiration for layout and interaction only. No assets, names, text or
  styling are copied from it. Celestial Navigator (MIT) is a feature reference; no code
  is copied from it either.
- Location in a shareable link is written only when the user presses **Share**; the
  address bar never silently carries someone's position.

## 2. Information architecture

One page, one shared **place + time + selection** state, several views.

| View | What it shows |
|---|---|
| **Map** (home) | Full-screen map. Click to set the observer. At the observer: a SunCalc-style compass overlay (horizon ring, rise and set directions, the body's current direction, today's path, the solstice band for the Sun). World layers: day/night and twilight shading, ground points (GPs) of the bodies, circles of position ("the circle you'd get by measuring this body now"), graticule, great-circle measuring tool. Toggle **flat chart / globe** |
| **Sky** | What you would see: a zenith-centred dome and a horizon panorama. Stars sized by brightness and tinted by colour, constellation figures, planets, the Moon with its phase, the Sun, horizon and compass points, altitude rings, ecliptic, equator, meridian. Sky colour follows the Sun's altitude |
| **Charts** | Height of each body through the day with twilight bands; sunrise, sunset and twilight across the year; Moon phase calendar; planet visibility across the year |
| **Navigate** | Sights entered by body and sextant reading, corrections with workings, the fix on the map with its ellipse, noon sight, Polaris latitude, running fix, averaging a run of sights, lunar distance, planning tonight's sights (recommended bodies with predicted sextant readings and bearings), import/export (JSON, CSV, GPX) |
| **Almanac** | Printable daily pages in the layout navigators use |
| **Events** | Eclipses (list, local circumstances, paths on the map), Moon phases, equinoxes and solstices, planets' closest approaches |
| **Learn** | The packaged demonstrations as guided stories, the simulator and the coverage experiments |
| **About / Docs** | Accuracy, sources, the mdBook |

Shared chrome, SunCalc-style:

- **Time bar** across the top: a 24-hour ribbon coloured by the Sun's phase at the
  observer (night, astronomical, nautical and civil twilight, day), a draggable handle,
  rise/set ticks for the selected body, date stepping (day, month, year), a calendar,
  **Now**, **Play** with speeds from real time to a month per second. Keyboard: `←/→`
  ±10 min, `Shift` ±1 h, `Alt` ±1 day, `PgUp/PgDn` ±1 month, `Space` play/pause, `N` now.
- **Side panel**: the place (name, coordinates in navigator format, time zone, height of
  eye), the selected body (altitude and bearing in large type, rise / transit / set with
  colours matching the map lines, details), "in the sky now", "tonight's star sights".
- The honesty banner stays on every view: *Simulation and analysis workbench. Not a
  navigation instrument.*

## 3. Principles every agent follows

1. **One source of astronomical truth.** Every position, time and event comes from the
   Rust core through WASM. TypeScript does presentation, projection of already-computed
   alt/az onto a screen, and conversions of UTC for display. The mock engine exists only
   for UI development (`?engine=mock`) and never ships as a source of results.
2. **Display-only data never reaches navigation.** The star field, constellation figures
   and boundaries (crate `skyfix-starfield`) are never a direction source for `reduce`,
   `solve`, the planner's navigation candidates or any accuracy claim.
3. **Validated or labelled.** A body is offered for sights only when its provider's
   documented accuracy is validated against the reference (Skyfield + JPL DE440s, USNO
   where available). Anything else says what it is.
4. **Offline first.** No CDN. Fonts, map data and the WASM module ship with the site. The
   only network use is the optional street layer, off by default, attributed
   ("© OpenStreetMap contributors") while shown, and never cached in bulk (OSMF tile
   usage policy).
5. **Honest uncertainty stays visible.** The existing result kinds (unique, ambiguous,
   underdetermined, failed), the suppressed ellipse and the nominal-95 % wording keep
   their meaning in the new UI.
6. **Accessible.** WCAG AA contrast in every theme, full keyboard operation, visible
   focus, colour never the only carrier of meaning (map lines also differ in dash
   pattern and carry labels), `prefers-reduced-motion` respected.
7. **Performance budget.** Scrubbing time redraws at 60 fps on a mid-range laptop:
   `sky_state` for all solar-system bodies plus 58 stars ≤ 2 ms; star-field apparent
   places ≤ 5 ms and recomputed at most once per simulated hour; the Sky view draws 9 000
   stars in ≤ 8 ms. The WASM module stays ≤ 1 MB gzipped, which is what a visitor downloads, and ≤ 2.5 MB uncompressed (raised from 2 MB on 2026-09-24: with the Moon, planet, star-field and almanac code it measured 1.87 MB, and most of it is embedded ephemeris data that compresses well; `wasm-opt -Oz` saved only 6 KB).

## 4. Architecture

### Rust

| Crate / module | Owner | Contents |
|---|---|---|
| `skyfix-ephemeris::body` | planner (contract) | Canonical body names, `BodyKind`, `ApparentState`, `BodyEphemeris`, `Sky` registry |
| `skyfix-ephemeris::moon` | Moon agent | Lunar theory, apparent geocentric Moon, distance, HP, SD, phase, bright-limb angle |
| `skyfix-ephemeris::planets` | Planets agent | Mercury…Neptune: apparent geocentric positions, distance, HP, SD, magnitude, phase |
| `skyfix-ephemeris::topocentric` | Moon agent | WGS84 site, topocentric alt/az with parallax, refraction for display |
| `skyfix-almanac` (new) | Events agent (`events`, `sky`), Almanac agent (`pages`), Eclipse agent (`eclipses`) | Rise/set/transit/twilight, sky phases, Moon phases, seasons, sky state; daily pages; eclipses |
| `skyfix-starfield` (new) | Star-field agent | Display catalogue (BSC5P), constellation figures, boundaries, apparent places for display |
| `skyfix-core` | Navigation agents | Noon sight, Polaris latitude, averaging, Moon/planet corrections, lunar distance, predicted sextant readings |
| `skyfix-motion` | (existing) | Running fix — already implemented; the navigation agent exposes it |
| `skyfix-wasm::{explorer,starfield,nav,almanac,eclipses}` | per feature | One module per feature so parallel work never collides in `lib.rs` |

### Browser

A Vite entry, `web/index.html` → `web/src/next/` (it was `web/next/index.html` until the
switch-over), reusing `web/src/api`, `types.ts`, `format.ts` and `geometry.ts` where they fit.

| Module | Owner |
|---|---|
| `src/next/engine/` — `ExplorerEngine` types (contract), WASM engine, mock engine | contract: planner; implementation: shell-core agent |
| `src/next/state.ts`, `src/next/component.ts` — store and component contract | shell-core agent |
| `src/next/shell/`, `src/next/timebar/`, `src/next/panel/`, `src/next/theme/` | shell-design agent |
| `src/next/geo/` — gazetteer search, time-zone guess, coordinate formats | map-data agent |
| `src/next/map/` — MapLibre map, globe, compass overlay, layers | map agent |
| `src/next/sky/` — dome and panorama | sky agent |
| `src/next/charts/` | charts agent |
| `src/next/navigate/`, `src/next/learn/`, `src/next/almanac/`, `src/next/events/` | their feature agents |
| `web/public/data/` — basemap, gazetteer | map-data agent |

Map library: **MapLibre GL JS** (BSD-3-Clause), flat Mercator and globe projections,
GeoJSON sources for the offline basemap, a raster source for the optional OSM layer.

## 5. Work packages

Every agent works in its own git worktree `~/Desktop/skyfix-lab-wt/<name>` on branch
`agent/<name>`, commits there, never pushes, never opens a PR. The planner merges.

| # | Agent | Wave | Depends on | Delivers | Acceptance |
|---|---|---|---|---|---|
| A | `moon` | 1 | contract | `moon.rs`, `topocentric.rs`, Moon fixtures | Moon GHA and Dec within **0.1′** of DE440s (DUT1 = 0) over 1990–2060; HP within 0.05′; topocentric alt/az within 0.1′ of Skyfield; phase fraction within 0.001 |
| B | `planets` | 1 | contract | `planets.rs`, planet fixtures | Mercury–Neptune GHA and Dec within **0.1′** of DE440s over 1990–2060; magnitudes within 0.1 of Skyfield's `planetary_magnitude` where it applies |
| C | `events` | 1 | contract | `skyfix-almanac::{events,sky}`, `skyfix-wasm::explorer` | Rise/set within 10 s of Skyfield with the same definitions and within 1 min of USNO; twilight likewise; polar cases classified; Moon phases and seasons within 1 min |
| D1 | `starfield` | 1 | contract | `skyfix-starfield`, `skyfix-wasm::starfield`, data provenance | ~9 000 stars to V 6.5 from BSC5P; our own figures for all 88 constellations; constellation lookup agrees with Skyfield's map; apparent places within 0.1′ of Skyfield |
| D2 | `mapdata` | 1 | — | Natural Earth basemap files, gazetteer, `src/next/geo/*` | Offline files ≤ 3 MB gzipped total; search, time-zone guess and coordinate parsing unit-tested |
| E1 | `shell-core` | 1 | contract | engine types implemented (WASM + mock), store, component contract, `/next/` entry, a harness page | `npm test` green; mock covers every engine call; `/next/` builds |
| I1 | `navcore` | 1 | — | Noon sight, Polaris latitude, averaging, running fix exposed, `skyfix-wasm::nav` | Each method validated against simulated truth and a published worked example |
| E2 | `shell-design` | 2 | E1 | Design system, themes, layout, time bar, side panel | Visual review by the planner; keyboard and contrast checks |
| F | `map` | 2 | E1, D2 | Map and globe views with all layers | Lines and circles agree with the engine; offline without the street layer |
| G | `sky` | 2 | E1, D1 | Dome and panorama | 9 000 stars at 60 fps; positions match `sky_state` for the navigation bodies |
| H | `charts` | 2 | E1 | Day, year, Moon-calendar and planet-visibility charts | Values match `day_events` |
| I2 | `navmoon` | 2 | A, B, I1 | Moon/planet sight corrections, predicted sextant readings, lunar distance, planner candidates including planets | Validated against Skyfield-generated sights |
| J | `almanac` | 2 | A, B, C | `skyfix-almanac::pages`, WASM, printable page | Spot values match Skyfield to the tabulated precision |
| K | `eclipses` | 2 | A, C | `skyfix-almanac::eclipses`, WASM, Events view | 1990–2060 eclipse list, types and greatest-eclipse times match NASA's Five Millennium Canon within 2 min |
| M | `navigate` | 3 | E2, F, I1, I2 | Navigate view replacing Observations/Corrections/Fix/Planner | Every existing workbench capability is reachable |
| N | `learn` | 3 | E2, F | Learn view: demos as stories, simulator, experiments | The six required demonstrations still reproduce |
| O | `release` | 3 | all UI | PWA (service worker, manifest), switchover of `/` to the new UI, CLI parity commands | Works offline after first visit; old UI retired |
| V | `verify` | 3 | all | Adversarial verification | Findings fixed or recorded |
| S | `docs` (Sonnet) | 3 | all | User guide, accuracy, sources, backlog, completion report | `mdbook build` has zero warnings |

## 6. Process rules

- Read `docs/CONVENTIONS.md`, this file and `docs/EXPLORER_API.md` before writing code.
- Stay inside your owned files. If a contract must change, change it in your branch,
  say so prominently in your final report, and keep the change minimal.
- Rust: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test -p <your crates>`; everything must build for `wasm32-unknown-unknown`
  (`cargo build -p skyfix-wasm --target wasm32-unknown-unknown`).
- Web: `npm run typecheck`, `npm test` in `web/`.
- Never re-enable incremental compilation. Each worktree has its own `target/`; sccache
  is shared.
- Development-time Python reference tools: symlink the planner's prepared environment
  into your worktree instead of downloading again:
  `ln -s ~/Desktop/skyfix-lab/tools/reference/.venv tools/reference/.venv` and
  `ln -s ~/Desktop/skyfix-lab/tools/reference/data tools/reference/data`
  (both paths are git-ignored). Python is never a runtime dependency (CONVENTIONS §11).
- Record every new data source in `docs/THIRD_PARTY.md` with URL, retrieval date,
  licence or public-domain basis, and processing.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (Sonnet agents: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`).
