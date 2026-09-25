# Backlog

Status labels: **completed** (merged, tested, verified against independent data where
that applies), **partial** (merged but with a documented gap), **unstarted**.
This file is the single list; the completion report links here.

## Required first release (from the brief)

| item | status | notes |
|---|---|---|
| Observation input: versioned JSON, CSV, validation | completed | `skyfix.session/1`; CSV round-trips; rejects invalid angles, non-finite values, bad timestamps, unknown bodies without a supplied direction |
| First numerical slice (supplied GHA/Dec, corrected altitude) | completed | `reference-philadelphia-5star-geocentric` recovers truth to 0.000 m |
| Sight reduction with per-step corrections | completed | six steps always reported; artificial-horizon halving tested; low-altitude refraction flagged/rejected |
| Position solver (weighted NLLS, multistart, ambiguity, conditioning) | completed | one sight -> circle; two sights -> both intersections; disjoint circles -> no fake point |
| Quality output (a-priori covariance, nominal 95 % ellipse, suppression rules) | completed | Monte Carlo: 95.1 % coverage under independent noise; 42 % under a shared bias |
| Corrections: stars + Sun path, horizon modes, refraction validity | completed | Sun SD/HP from the ephemeris; the Moon (augmented SD, rigorous parallax) and the four navigational planets (Venus at its centre of light) followed in the explorer redesign — see "Explorer redesign" below |
| Offline astronomy: Sun + stars, fixture-pack fallback | completed | stars 0.0011', Sun 0.0026' vs Skyfield; pack says "limited-date operation" |
| Interface: CLI + browser workbench, bundled assets | completed | CLI has grown to 25 subcommands with the explorer redesign (`skyfix --help`: the original `validate reduce solve catalog coverage convert demos simulate experiment plan`, plus `sky events phases seasons noon polaris average running-fix predict lunar plan-sights almanac eclipses eclipse planet-events`); every export backed by real code, no feature gates, no stubs; browser now ships two UIs from one build, bundled with no CDN fonts, scripts or map tiles — the explorer at `/`, the site's home page since the switch-over on 2026-09-24 (`/next/`, its address while it was built, forwards there), and the original workbench, kept for reference, at `/classic/` (`docs/EXPLORER_GUIDE.md`) |
| Simulator: seeded, truth separate, six error scenarios | completed | ten scenarios; experiment summaries in CSV/JSON |
| Observation planner | completed | geometry-driven greedy ranking with disclosures |

## Follow-up modules

| item | status | notes |
|---|---|---|
| A. Stationary camera sextant (synthetic images) | partial | attitude and position kept apart by type; full render-to-fix chain proven end to end, 69 tests (`cargo test -p skyfix-camera`) — but only on synthetic images. The module's own gap: the 58-star closed-world catalogue identifies on an 80-degree lens but fails a plausible 40-degree one at the briefed pointing (CAMERA.md section 4), and "nothing in this crate has met a real lens, a real sensor or a real sky" (CAMERA.md section 9) |
| B. Polarization compass laboratory | completed | 180-degree ambiguity always returned, never guessed; 76 tests (`cargo test -p skyfix-polar`). Scoped to heading estimation from a stated sky model, as designed — see "Polarization geolocation" below, which is the deliberately deferred remainder |
| Navigation methods: noon sight, latitude by Polaris, averaging a run, running fix, and (wave 2) Moon and planet sights and lunar distance | completed | `crates/skyfix-core/src/methods/` and `sights::lunar`, WASM exports in `crates/skyfix-wasm/src/{nav,navsky}.rs`; validated against Skyfield truth, Bowditch's worked examples and seeded coverage (`docs/NAVIGATION_METHODS.md` section 6, `docs/NAVIGATION_SKY.md`). Reachable two ways: the explorer's **Navigate** view (every method, live corrections, GPX/CSV/JSON, browser-local autosave) and the `skyfix` CLI (`noon polaris average running-fix lunar plan-sights`). The documented gap: the Polaris sigma under-covers (89.8 %) within 1.5° of the pole when the DR's longitude is uncertain by tens of degrees |
| C. Motion and independent navigation checks | partial | disagreement statements, never a diagnosis; 58 tests (`cargo test -p skyfix-motion`). The module's own gap: a running fix's nominal 95 % ellipse is a documented lower bound, measured at 92.3 % coverage over 300 seeded repetitions, because the dead-reckoning error behind every sight in one fix shares the same speed and course bias and the solver is never told so (MOTION.md section 3) |

## Explorer redesign

| item | status | notes |
|---|---|---|
| Moon and planets (ephemeris) | completed | `skyfix_ephemeris::moon` (ELP 2000-82B) and `::planets` (VSOP87A), apparent geocentric of date, 1990-2060; every navigational body (Sun, Moon, Venus, Mars, Jupiter, Saturn, 58 stars) validated against Skyfield/JPL DE440s well inside the 0.1′ target — see `docs/ACCURACY.md`, "At a glance" and sections 2 ("Planets") and 7 |
| Deeper star catalogue, for display | completed | `skyfix-starfield`: 9,095 stars (NASA HEASARC's BSC5P, no credit required), 88 constellation figures drawn for this project, IAU boundaries; feeds the explorer's Sky view and map ground points only — kept out of `skyfix-core`/`skyfix-ephemeris`/`skyfix-sim`/`skyfix-almanac` by a crate-boundary test, so it can never reach a fix. Not the same catalogue as the camera module's (below) |
| Moving observer, reached through the running fix | completed | `skyfix-motion::running_fix` (advances each sight along the dead-reckoning track, inflates its sigma) is now reachable end to end: the explorer's Navigate view, the WASM export, and `skyfix running-fix`. Its own documented gap is unchanged — see Module C above, and "First-class moving observer inside the solver" below for the different, larger project this does not replace |
| Explorer browser UI: Map/Globe, Sky, Charts, Almanac, Navigate, Learn, About | completed | see `docs/EXPLORER_GUIDE.md`; the site's home page since the switch-over on 2026-09-24; offline after the first visit and installable (service worker, manifest, icons: `web/README.md`, "Offline and installable") |
| Explorer browser UI: Events (eclipses, Moon phases, equinoxes, solstices, planet events) | completed | the Events view (eclipse cards with local circumstances and map paths, Moon phases, seasons, oppositions, conjunctions, elongations, closest approaches); engine validated against NASA's canon and SKYCAL and Skyfield (`docs/ACCURACY.md` sections 12 and 13); CLI `skyfix eclipses`, `eclipse <id>`, `planet-events` |

## Unstarted, with the reasoning

| item | status | notes |
|---|---|---|
| Retire the original workbench at `/classic/` | unstarted | Deliberately not yet: kept for reference for a transition period after the switch-over (2026-09-24); Navigate and Learn carry everything it did. Retiring it: delete `web/classic/`, `web/src/main.ts` and the modules only it uses, and `web/src/pwa/workbench-prompt.ts`; drop `classic` from `APP_PAGES` in `web/vite.config.ts`; and forward `/classic/` to the home page the way `/next/` is (`REDIRECT_PAGES`, answered offline by the service worker) |
| Deeper star catalogue for the camera module | unstarted | Real cameras see thousands of stars; the 58-star closed world works only in simulation. The explorer redesign has since built exactly the kind of catalogue this needed for a different purpose — `skyfix-starfield`'s BSC5P table (9,095 stars, permissively licensed, no credit required) — but only for display: it is kept out of every navigation and camera crate by design (crate-boundary test), and the camera module's own closed-world identification still uses the original 58 stars. Reusing BSC5P's data for the camera's pair-angle search is now a much smaller task than sourcing a new catalogue, but the search structure (k-vector or geometric hashing) and the camera-specific wiring are still unstarted. |
| First-class moving observer inside the solver | unstarted | The running fix (Module C, completed, and now reachable through the explorer's Navigate view and the CLI — see "Explorer redesign" above) advances each sight's position along the dead-reckoning track and inflates its sigma, which treats the DR error as independent per sight. A first-class model would instead treat the DR error as *correlated* across every sight in one fix (the same speed-and-course bias sits behind all of them), which needs it built into the solver's Jacobian rather than added to each sigma afterwards. This is a different, larger project than the running fix, not a subset of it. |
| Real sextant sights | unstarted | No hardware yet; the artificial-horizon path is implemented and tested on synthetic logs. |
| Camera on real imagery | unstarted | Lens calibration, a real local vertical, timing, rolling shutter. |
| Polarization geolocation | unstarted | Deferred by design; heading first. |
| Satellites | considered, not planned | Raised and set aside, not merely not yet started. SkyFix Lab's navigational bodies (CONVENTIONS section 10, 13.1) are the Sun, Moon, planets and fixed stars: bodies an offline analytic or semi-analytic theory predicts accurately for decades, matching the project's offline-first design. A satellite's position instead needs orbital elements (a TLE or similar) that go stale within days to weeks, which would either need a network fetch (breaking "no network, ever") or a bundled set that silently ages out of date — a different kind of staleness than anything else in this project, and a different kind of navigation than sextant celestial navigation. |
| The Earth's shape in Moon sight reduction | unstarted | Sight reduction, predicted readings and the sight planner all use the spherical Earth of CONVENTIONS section 1; on the real (WGS84) Earth the Moon's parallax differs by up to 0.22′ (median 0.09′), a few tens of metres in a fix (`docs/ACCURACY.md` section 10, `docs/NAVIGATION_SKY.md` section 6). Lunar distance already makes this exception (WGS84, CONVENTIONS section 1 records it) because a lunar's timing needs the Moon's parallax to 0.03′; extending it to ordinary Moon sights would need the observer's position inside the reduction itself, and the Skyfield WGS84 fixtures already in `crates/skyfix-ephemeris/tests/moon_planet_sights.rs` are in place to validate it. |
| The lunar limb profile in eclipse contacts | unstarted | The eclipse engine (`skyfix_almanac::eclipses`) treats the Moon's limb as a perfect circle; NASA's own canon notes this moves an eclipse's limits by 1-3 km and totality by 1-3 seconds (`docs/ACCURACY.md` section 12, "Conventions, stated because they move numbers"). A real limb profile (Watts' data or similar) would need its own source and licence entry in `docs/THIRD_PARTY.md`. |

## Expansion programme — sun tools (suntools agent, 2026-09-24)

| item | status | notes |
|---|---|---|
| Sun tools engine: golden/blue hour, azimuth search, alignments, analemma, sun path, rise/set azimuths, equation of time, clear-sky energy, Milky Way windows | completed (engine, WASM, TypeScript, mock) | `skyfix_almanac::sun_tools`; validated in `docs/ACCURACY.md` section 14. The interface is wave 2 (`photo`, `charts2`); the CLI is `cli3` |
| Forward the sun tools through the memoising engine | unstarted | `memoEngine` in `web/src/next/component.ts` copies only the methods it knows, so `isSunToolsEngine(ctx.engine)` is false until it forwards the ten methods (as it does `planetEvents`); not the suntools agent's file |
| A raised horizon for alignments | unstarted | rise and set are on the sea-level horizon; a street, a ridge or a skyline raises it. `at_altitude` covers a single known horizon altitude today; a horizon profile (altitude by azimuth) would be the full answer |
| An elevation term in the clear-sky estimate | unstarted | Haurwitz has none and underestimates at high sites (Reno, Hansen & Stein 2012). Ineichen-Perez needs a Linke-turbidity climatology whose licence would have to be checked; the Bird model (a U.S. Government work) needs aerosol and water-vapour defaults |
| Faster Moon year series | unstarted | a year of the Moon's rise and set (or moonrise alignments) costs about 0.3 s natively, almost all of it the event finder's 2900 exact ELP evaluations |
| `events::roots` visible to the crate | unstarted | `sun_tools` compiles the event finder's Brent routines from the same file (`#[path]`, with a lint allowance) because `events::roots` is private; making it `pub(crate)` lets `sun_tools` use it directly |

## Expansion programme: magnetic variation and compass error (geomag agent, 2026-09-24)

| item | status | notes |
|---|---|---|
| Magnetic variation anywhere, 1900-2030 (WMM2025, IGRF-14), with the model's uncertainty, zones and a grid for isogonic lines | completed (engine) | `crates/skyfix-geomag`, exports `magnetic_field`, `magnetic_grid` (`crates/skyfix-wasm/src/geomag.rs`); validated against NCEI's, IAGA's, BGS's and NOAA's values (`docs/ACCURACY.md` section 15). The interface (Selected card, Navigate → Compass, map layer) is wave 2 |
| Compass error by azimuth and by amplitude, with variation and deviation | completed (engine) | `skyfix_core::methods::compass`, export `compass_error`; Bowditch ch. 15 reproduced (`docs/NAVIGATION_METHODS.md` section 9). CLI `skyfix variation` / `skyfix compass-error` left to the `cli3` agent |
| A deviation card (swinging the compass) | unstarted | Collect compass errors on many headings into a deviation table and curve; each `compass_error` result is one heading's deviation already |
| WMMHR2025 (degree 133, crustal field) | unstarted | NCEI recommends it where systems can take the coefficients; about 18 000 of them (a pack, not the core). WMM2025 meets the navigation specification, and its uncertainty is stated beside every value |
| Grid variation for polar navigation (GV) | unstarted | Declination relative to a polar-stereographic grid north; only meaningful with a polar chart grid, which the map does not draw |
| Magnetic variation before 1900 | not planned | No standard model reaches before 1900 with a stated uncertainty (historical field models such as gufm1 exist, with their own licences and far larger errors); the programme's rule is that variation is not shown for deep time |
