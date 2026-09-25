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
| Interface: CLI + browser workbench, bundled assets | completed | CLI has grown to 25 subcommands with the explorer redesign (`skyfix --help`: the original `validate reduce solve catalog coverage convert demos simulate experiment plan`, plus `sky events phases seasons noon polaris average running-fix predict lunar plan-sights almanac eclipses eclipse planet-events`); every export backed by real code, no feature gates, no stubs; the browser ships the explorer, bundled with no CDN fonts, scripts or map tiles, at `/`, the site's home page since the switch-over on 2026-09-24 (`/next/`, its address while it was built, forwards there); the original workbench, kept for reference at `/classic/` after the switch-over, was retired in the expansion programme and its address now forwards to the explorer's views (`docs/EXPLORER_GUIDE.md`) |
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
| Retire the original workbench at `/classic/` | completed | Retired in the expansion programme (2026-09-24, packs agent): its page code (`web/src/main.ts` and the modules only it used, `web/src/pwa/workbench-prompt.ts`) is deleted and nothing precaches it. `/classic/` now forwards to the home page, keeping the query and mapping the old views' fragments (`#observations`, `#corrections`, `#fix`, `#planner` → `#navigate`, `#simulator` → `#learn`, `#about` → `#about`): a static page for a first visit, and the service worker's own forwarding page offline (`REDIRECT_PAGES` in `web/vite.config.ts`, `forwardPageHtml` in `web/src/sw/policy.ts`); `web/scripts/offline-check.mjs` checks both. Navigate and Learn carry everything it did |
| Deeper star catalogue for the camera module | unstarted | Real cameras see thousands of stars; the 58-star closed world works only in simulation. The explorer redesign has since built exactly the kind of catalogue this needed for a different purpose — `skyfix-starfield`'s BSC5P table (9,095 stars, permissively licensed, no credit required) — but only for display: it is kept out of every navigation and camera crate by design (crate-boundary test), and the camera module's own closed-world identification still uses the original 58 stars. Reusing BSC5P's data for the camera's pair-angle search is now a much smaller task than sourcing a new catalogue, but the search structure (k-vector or geometric hashing) and the camera-specific wiring are still unstarted. |
| First-class moving observer inside the solver | unstarted | The running fix (Module C, completed, and now reachable through the explorer's Navigate view and the CLI — see "Explorer redesign" above) advances each sight's position along the dead-reckoning track and inflates its sigma, which treats the DR error as independent per sight. A first-class model would instead treat the DR error as *correlated* across every sight in one fix (the same speed-and-course bias sits behind all of them), which needs it built into the solver's Jacobian rather than added to each sigma afterwards. This is a different, larger project than the running fix, not a subset of it. |
| Real sextant sights | unstarted | No hardware yet; the artificial-horizon path is implemented and tested on synthetic logs. |
| Camera on real imagery | unstarted | Lens calibration, a real local vertical, timing, rolling shutter. |
| Polarization geolocation | unstarted | Deferred by design; heading first. |
| Satellites | considered, not planned | Raised and set aside, not merely not yet started. SkyFix Lab's navigational bodies (CONVENTIONS section 10, 13.1) are the Sun, Moon, planets and fixed stars: bodies an offline analytic or semi-analytic theory predicts accurately for decades, matching the project's offline-first design. A satellite's position instead needs orbital elements (a TLE or similar) that go stale within days to weeks, which would either need a network fetch (breaking "no network, ever") or a bundled set that silently ages out of date — a different kind of staleness than anything else in this project, and a different kind of navigation than sextant celestial navigation. |
| The lunar limb profile in eclipse contacts | unstarted | The eclipse engine (`skyfix_almanac::eclipses`) treats the Moon's limb as a perfect circle; NASA's own canon notes this moves an eclipse's limits by 1-3 km and totality by 1-3 seconds (`docs/ACCURACY.md` section 12, "Conventions, stated because they move numbers"). A real limb profile (Watts' data or similar) would need its own source and licence entry in `docs/THIRD_PARTY.md`. |

## Expansion programme — sun tools (suntools agent, 2026-09-24)

| item | status | notes |
|---|---|---|
| Sun tools engine: golden/blue hour, azimuth search, alignments, analemma, sun path, rise/set azimuths, equation of time, clear-sky energy, Milky Way windows | completed (engine, WASM, TypeScript, mock) | `skyfix_almanac::sun_tools`; validated in `docs/ACCURACY.md` section 14. The interface is wave 2 (`photo`, `charts2`); the CLI is `cli3` |
| Forward the sun tools through the memoising engine | completed (planner, 2026-09-25) | `memoEngine` in `web/src/next/component.ts` now passes every other capability of the engine through, bound to the engine, so the type guards of every expansion engine see it on the wrapper; the ten named methods keep their memo |
| A raised horizon for alignments | unstarted | rise and set are on the sea-level horizon; a street, a ridge or a skyline raises it. `at_altitude` covers a single known horizon altitude today; a horizon profile (altitude by azimuth) would be the full answer |
| An elevation term in the clear-sky estimate | unstarted | Haurwitz has none and underestimates at high sites (Reno, Hansen & Stein 2012). Ineichen-Perez needs a Linke-turbidity climatology whose licence would have to be checked; the Bird model (a U.S. Government work) needs aerosol and water-vapour defaults |
| Faster Moon year series | unstarted | a year of the Moon's rise and set (or moonrise alignments) costs about 0.3 s natively, almost all of it the event finder's 2900 exact ELP evaluations |
| `events::roots` visible to the crate | unstarted | `sun_tools` compiles the event finder's Brent routines from the same file (`#[path]`, with a lint allowance) because `events::roots` is private; making it `pub(crate)` lets `sun_tools` use it directly |

## Expansion programme — moonshape (P1, 2026-09-24)

| item | status | notes |
|---|---|---|
| The Earth's shape in Moon sight reduction | completed | Moved here from "Unstarted". The Moon's model altitude carries the exact WGS84 Earth-shape term (up to 0.24′) wherever a model altitude is evaluated — the solver at every trial position, the intercept at the assumed position, predicted readings, the noon and averaging methods, the planner, the misfit grid, the running fix and the Moon's circle of position — while the correction chain and `Ho` stay on the sphere (CONVENTIONS 15.4, `skyfix_core::sights::wgs84::EarthShape`). WGS84 Moon sights reduce to within 0.0064′ of the model; the WGS84 Moon sessions fix 2.6 m and 5.1 m from the truth (17.9 m and 34.9 m before); the Moon's parallax through the model agrees with USNO's to 0.0004′ (`docs/ACCURACY.md` section 10). Not applied to the planets (at most 0.0021′) |
| DUT1 (UT1 − UTC) as an input | partial | The session's `clock.dut1_s`, the CLI's `--dut1` on every command that reduces, predicts or plans, the WASM methods, `reduce`, `solve`, the misfit grid and the navsky exports (an observer document's `dut1_s`), and the Navigate field "UT1 − UTC from the time signal". The remaining part belongs to the timescales work: the automatic value is still 0 s (`skyfix_core::time::dut1_s`, the single lookup it replaces with the IERS history and the model of CONVENTIONS 15.2) |
| Seconds omitted from a sight time | completed | The Navigate sight form takes `HH:MM` as `:00` and says "Seconds omitted: :00 assumed; each second is 0.25′ of longitude" (`web/src/next/navigate/parse.ts`) |
| Error-budget rows for the dip anomaly and anomalous refraction | completed | `docs/ACCURACY.md` section 4, each pointing to the shared-bias estimate (`SolveOptions.estimate_shared_bias`, `skyfix solve --bias`) as the remedy for the part the sights share |
| Simulated Moon sights | unstarted | `skyfix-sim` still generates altitudes on the sphere and its reverse chain knows no Moon semidiameter or parallax (`docs/NAVIGATION_SKY.md` section 6), so a simulated Moon sight would now carry the Earth-shape term as an error of up to 0.24′. The Skyfield fixtures remain the test material for Moon sights |

## Expansion programme: magnetic variation and compass error (geomag agent, 2026-09-24)

| item | status | notes |
|---|---|---|
| Magnetic variation anywhere, 1900-2030 (WMM2025, IGRF-14), with the model's uncertainty, zones and a grid for isogonic lines | completed (engine) | `crates/skyfix-geomag`, exports `magnetic_field`, `magnetic_grid` (`crates/skyfix-wasm/src/geomag.rs`); validated against NCEI's, IAGA's, BGS's and NOAA's values (`docs/ACCURACY.md` section 15). The interface (Selected card, Navigate → Compass, map layer) is wave 2 |
| Compass error by azimuth and by amplitude, with variation and deviation | completed (engine) | `skyfix_core::methods::compass`, export `compass_error`; Bowditch ch. 15 reproduced (`docs/NAVIGATION_METHODS.md` section 9). CLI `skyfix variation` / `skyfix compass-error` left to the `cli3` agent |
| A deviation card (swinging the compass) | unstarted | Collect compass errors on many headings into a deviation table and curve; each `compass_error` result is one heading's deviation already |
| WMMHR2025 (degree 133, crustal field) | unstarted | NCEI recommends it where systems can take the coefficients; about 18 000 of them (a pack, not the core). WMM2025 meets the navigation specification, and its uncertainty is stated beside every value |
| Grid variation for polar navigation (GV) | unstarted | Declination relative to a polar-stereographic grid north; only meaningful with a polar chart grid, which the map does not draw |
| Magnetic variation before 1900 | not planned | No standard model reaches before 1900 with a stated uncertainty (historical field models such as gufm1 exist, with their own licences and far larger errors); the programme's rule is that variation is not shown for deep time |

## Time scales (expansion programme, timescales agent, 2026-09-24)

| item | status | notes |
|---|---|---|
| ΔT model with uncertainty, UTC/UT clock, IERS DUT1 history, Julian/Gregorian calendars, expanded years, `time_info`, `set_dut1`, `calendar_convert`, `skyfix calendar`, saros for any epoch | completed | CONVENTIONS 15.2-15.3; `docs/ACCURACY.md` section 14; `docs/EXPLORER_API.md`, "Time scales, Delta-T and calendars" |
| Refresh the IERS UT1 − UTC table from a current `finals2000A.all` | completed | 2026-09-25: observed to 2026-09-24, IERS Bulletin A's prediction to 2027-09-28; the columns used are committed as `tools/timescales/sources/finals2000A-ut1-2026-09-25.txt`. Refresh again (download, `gen_timescales.py`, review) before 2027-09-28, when DUT1 becomes unknown (0 ± 0.9 s) again |
| UT1 − UTC for 1962-1972 | unstarted | `finals2000A.all` starts in 1973; the splines stand there (σ 0.11 s, 1972 DUT1 `assumed`). IERS EOP 20 C04 (from 1962) would fill it, and needs the owner's approval to download |
| Regenerate the Moon, planet, topocentric and almanac-page fixtures on the CONVENTIONS 15.2 scale | unstarted | Generated with TT = UTC + 69.184 s after 2035; their tests evaluate the fixtures' own TT and UT1 through `time::legacy_fixture_instant` and leave out the four almanac pages after 2035. Regenerate with `tools/timescales/skyfield_timescale.py`, then drop the shim (deeptime agent's generators) |
| Almanac page exactly at UT1 hours | considered | The page keeps DUT1 = 0 so each row's instant is its UT1, as printed; TT is then off by DUT1 (≤ 0.5″ of the Moon). Exact would need `pages.rs` to evaluate at UTC = hour − DUT1 |
| CLI polish for far dates | unstarted | The eclipse text prints ΔT without its σ; `--format geojson` lacks `delta_t_sigma_s`; `skyfix almanac --date` takes four-digit years only (its parser is `pages::UtDate`); table headers still say "UTC" where rows now say "UT" (cli3) |

## Expansion programme — sailings agent (wave 1, 2026-09-24)

| item | status | notes |
|---|---|---|
| Sailings: great-circle, rhumb-line (sphere or WGS84 meridional parts), mid-latitude, plane, traverse, parallel and composite sailing; waypoints; ETA | completed (engine) | `skyfix_core::sailings`, WASM `sailing`; every Bowditch 2019 ch. 12 worked example reproduces (`docs/NAVIGATION_METHODS.md` section 9.9); the Navigate → Passage tab and the map drawing are wave 2 (navigate2) |
| Forward dead reckoning and routes (legs in the running fix's shape) | completed (engine) | `dr_advance`, `route_positions`; a great-circle route equals the running fix's DR to 1 mm; feeding a drawn DR track into the running fix is navigate2's |
| Dip short of the horizon (`shore` horizon) | completed (engine) | Bowditch Table 14 to 0.046′; the TS types, CSV, autosave, the classic and Navigate horizon selects keep a shore horizon, but no form can yet *set* its distance (navigate2: a distance field beside the horizon select) |
| Star identification from altitude and bearing | completed (engine) | `star_identify`; 58/58 stars recovered; the UI is navigate2's. Variation is not looked up: it is the caller's (the geomag agent's WMM value can be passed as `variation_deg`) |
| Star finder (2102-D equivalent) geometry | completed (engine) | `star_finder_geometry`; drawing it is almanac2's or navigate2's |
| Index-error and watch logs | completed (engine) | session schema, interpolation, the reduced sight's record; the Navigate view's `instrumentJson` (web/src/next/engine/wasm-nav.ts) still sends only the single index correction to `predict_sextant` and `plan_sights`, so a UI with a log must pass the log too (navigate2); no form edits the logs yet |
| Command line for the sailings exports | unstarted | cli3 (wave 2) |

## Expansion programme P8 — the Moon in detail (moondetail agent, 2026-09-25)

| item | status | notes |
|---|---|---|
| Libration, axis position angle, terminator, sub-solar point, disc geometry | completed (engine) | `skyfix_almanac::libration`, WASM `moon_orientation`; within 0.006° of JPL's DE440 lunar orientation 1550–2650 (`docs/ACCURACY.md` section 14). The Sky inset that draws it is wave 2 (Q3) |
| Named features on the terminator | completed (engine) | 150 features from the USGS/IAU gazetteer (public domain), `moon_features`; the list and the inset are wave 2 (Q3, Q2) |
| Perigee, apogee, supermoons, the year's largest and smallest full Moon | completed (engine) | `moon_apsides`, within 11 s and 0.22 km of DE440s; the Events list is wave 2 (Q4) |
| Lunar occultations of bright stars and planets with local times | completed (engine), mean limb | `occultations`, within 1.4 s of Skyfield's geometry; the Events list and Selected card are wave 2 (Q4). Contacts are for the mean limb, labelled; correcting them (and deciding grazes) with the real limb profile waits on the lunar-limb pack (P12) |
| Occultations of fainter stars and the Pleiades beyond Alcyone | available, not default | `max_magnitude` up to 6.5 (about 0.5 s a year natively); the default is 3.5 |

## Expansion programme: deep sky (deepsky agent, 2026-09-24)

| item | status | notes |
|---|---|---|
| Deep-sky objects (110 Messier + 103 by a stated rule), meteor showers (32, dates from our Sun), Milky Way outline (COBE/DIRBE isophotes), IAU WGSN star names (+220), search, extinction and limiting magnitude, the "tonight" ranking | completed (engine) | `skyfix-starfield` (`dso`, `showers`, `milkyway`, `names`, `search`, `extinction`, `tonight`, `observe`), exports in `crates/skyfix-wasm/src/deepsky.rs`, `DeepSkyEngine` in types.ts with the mock; display-only (CONVENTIONS 13.6); checks in `docs/ACCURACY.md`, "Deep sky". The views that show them belong to the Sky and Tonight packages |
| Core-module size | partial | The package adds 164 734 bytes raw (73 118 gzipped) against an 80 KB budget; the module stays inside its 2.5 MB / 1 MB limits. About 32 KB is data, the rest code (search, showers, tonight, the night machinery, serialisation) |
| Double stars tonight (a curated 50-100 pairs from the USNO Washington Double Star and Sixth Orbit catalogues) | unstarted | The brief's optional bonus. U.S. Government works; position angle and separation from ORB6 orbits |
| `meteor_showers(year, observer)` speed | unstarted | 0.2 s natively (one night per shower, 32 nights); computing a shower's night only when the view asks for it would make the year view instant |
| Milky Way outline: windows in the dust | unstarted | The 100 µm dust screen darkens the whole plane, so the Sagittarius Star Cloud (M24) and similar windows come out darker than the eye sees them; a visual-band dust model or hand-set windows would fix it |
| Visibility from surface brightness | unstarted | The instrument guide uses integrated magnitude with a size term; a surface-brightness model (with the sky's brightness) would rank faint large galaxies and nebulae better |
| CLI access to deep sky | unstarted | No `skyfix` subcommand yet (`tonight`, `showers`, `dso`); the engine calls are ready |

## Expansion programme — tides (tides agent)

| item | status | notes |
|---|---|---|
| Tide predictions engine and the `tides-us` pack | completed (engine) | `skyfix-tides` + `skyfix-wasm::tides`: NOAA's 3 499 stations, harmonic prediction with Schureman node factors in NOAA's conventions, high and low water with NOAA's tide-table rule, subordinate stations, datums, nearest stations; within 1.36 min and 1.08 cm of NOAA's own predictions at every station tested (`docs/ACCURACY.md` section 16). The interface (Charts → Tides, map layer, Tonight line) is wave 2 |
| Tide pack loading through the pack mechanism | completed | `tides-us` is an entry of `packs::PRODUCERS`; `load_pack("tides-us", bytes)` installs it (the temporary loader of the first draft is gone) |
| Tides outside NOAA's list | unstarted | Other agencies' constants are licensed (UKHO, SHOM, CHS, BoM: not usable) or mixed-provenance CC BY (TICON-4); only a per-agency open source (Rijkswaterstaat CC0, a few CC BY) could add stations, each needing its own licence check (data audit, section 6) |
| Tidal currents | unstarted | NOAA publishes current predictions (a separate harmonic product) the same way; not in this programme |
| Anchorage's last centimetre | unstarted | 0.7 cm rms from NOAA in the diurnal band near σ1/2Q1 at the one station with NOAA's 120-constituent set; no constituent convention tried removes it (`tools/tides/README.md`) |

## Expansion programme — planet detail (planetdetail agent, 2026-09-25)

| item | status | notes |
|---|---|---|
| Galilean moons, Saturn's rings, planet discs, transits of Mercury and Venus with local circumstances, conjunctions and stations, the Earth's apsides, comets and asteroids from supplied elements | completed (engine) | `skyfix_almanac::{satellites, rings, discs, transits, conjunctions, earth_apsides, orbits}`, exports in `crates/skyfix-wasm/src/planetdetail.rs`, `PlanetDetailEngine` in types.ts with the mock; `docs/ACCURACY.md` section 17. The eyepiece insets are wave 2 (Q3), the lists wave 2 (Q4) |
| The Great Red Spot's longitude | unstarted, by decision | It drifts in System II by tens of degrees a year, irregularly, so no compiled value stays right; a value the person types in (from ALPO's or the BAA's current reports) would place it |
| Galilean phenomena to seconds | unstarted | E5 puts them 23 s (Io) to 97 s (Ganymede) from JPL; a steady per-moon along-track correction fitted to jup365, or JPL's own satellite series in a pack, would bring them under 10 s |
| Transit contacts as seen (black drop, irradiation) | unstarted | Contacts are geometric (the discs' tangencies); what an observer times differs by several seconds, and no published model is simple enough to be worth it |
| Perturbed orbits for supplied elements | unstarted | Two-body only; a numerical integration with the planets would keep near-Earth objects and Jupiter-passing comets right for months after their epoch |
| Core-module size | noted | The package adds 191 KB raw and 77 KB gzipped on main 3f4fe4e, taking the module to 2 997 407 / 1 231 646 bytes, 2.6 KB under the 3 MB raw budget (mostly code: E5, the searches, the MPC parser, the serialisation of eleven calls). `opt-level = "z"` (the polish agent's lever) or a lazily loaded second module would restore headroom |

## Expansion programme Q5 — Charts: Sun, Tides, the Moon through the year, Save (charts2 agent)

| item | status | notes |
|---|---|---|
| Sun tab: sun path (from above, along the horizon), analemma, sunrise and sunset bearings, equation of time and declination, solar panel (clear-sky estimate) | completed | `web/src/next/charts/{sun-path,analemma,sun-bearings,eot,solar}.ts` over the suntools engine; `EXPLORER_GUIDE.md` "Charts" |
| Tides tab: nearest stations, day or week curve with the app's time, high and low water, datums, the pack's Get state, "Show on the map" | completed | `charts/tides.ts`; the cursor's readout is read off the curve (`docs/ACCURACY.md`, "Charts") |
| Moon tab: the Moon at one hour through the year; perigee, apogee, supermoons and micromoons on the month grid | completed | `charts/moon-year.ts`, `moon-calendar.ts` |
| Save menu on every chart: PNG with a caption strip (light colours), CSV of the Table view, print one chart per page, Web Share | completed | `web/src/next/export/{png,csv}.ts` (shared), `charts/export-menu.ts`, `charts/print.ts` |
| Tier chips on chart tables and captions | waiting | `// time-ui:` comments mark the places (the chart shell's tables, the tides table); merged when time-ui's helpers land |
| Sun path hour lines (the figure-8 of each clock hour through the year) | unstarted | the classic architect's diagram; needs the analemma at each hour (24 calls of about 10 ms natively), best computed once per place and year |
| Tides map layer (stations on the map, the nearest highlighted) | unstarted | EXPANSION_PLAN names a map layer; this package only marks the chosen station ("Show on the map") |
| Moon's rise and set bearings through the year | unstarted | `rise_set_azimuths` with `body: "Moon"` is ready (0.3 s natively a year); a panel beside the Moon through the year |
| Print from the browser's own menu (Ctrl+P) | partial | Save → Print prints one chart; the browser's own print prints the whole app |

## Expansion programme — deep time in the interface (time-ui agent, wave 2 Q1)

| item | status | notes |
|---|---|---|
| Calendars, years, UT/UTC, LMT, tiers and the ±ΔT chip in the time bar, Settings and About | completed | `web/src/next/time/` (helpers every view uses: CONVENTIONS 15.6), `timebar/`, `playback.ts`; checks in `web/scripts/ui-check.mjs` (group `time`) |
| Views that still write a literal "UTC" beside times that may be UT | unstarted (owners) | `events/`, `almanac/`, `navigate/`, `panel/selected.ts`, `panel/place.ts` (`formatOffset(…)` without the instant: "UTC−5:00:40" in 585 BC): use `scaleLabel(jd)` and `formatOffset(ms, jd)` |
| The panel's zone reason before 1850 | unstarted (navigate2) | `panel/place.ts` says "From the place: America/New_York…" while the clock is local mean time; `lmtReason` and `zoneTooltip` give the words |
| "1990–2060" and "1990 to 2060" in the interface | unstarted (owners) | `navigate/session-panel.ts:140`, `events/lists.ts:137, 263, 424, 425`, `events/eclipses.ts:749, 758`, `almanac/almanac.ts:557` (the date input's range), `panel/when.ts:82`; `tierNotice`, `sightsOnlyText` and `outsideCoverage` name the real bounds |
| Navigate's sight-time field and expanded years | unstarted (navigate2) | `navigate/parse.ts` `UTC_PATTERN` takes four-digit years only; a `-0584-…` time gets a format error instead of "Sights are offered only between 1550 and 2650" |
| The CLI's help text | unstarted (cli3) | `crates/skyfix-cli/src/cli.rs:193` says "from 1990-01-01 to 2060-12-31" |
| Phone bottom sheet and the time bar's height | open | `panel/sheet.ts` measures the time bar only on window resize; the time bar now keeps one height on phones for every date, but a ResizeObserver there would make it robust |
| Ctrl+Page Up / Page Down in tabbed browsers | known | Chrome and Firefox keep these keys for switching tabs; the calendar's ±100 and ±1000 buttons (and the grid's Ctrl+PgUp/PgDn, which the grid receives) do the same |
| Phone Map outside the coverage: notices over the map's controls | unstarted (shell, map) | On a phone, a date outside the coverage shows two notices (the coverage one, and the Map's own "positions could not be computed" error), which cover the map's floating Layers button (ui-check's layout check, any date outside the years, e.g. 2080: it predates the deep-time work). The Map should not raise an error where `covered()`/`tierAt` already say nothing is computed, and the notice bar could leave the floating controls clear |
| Views with their own per-day work during fast playback | open (owners) | above 8 days a second `sunToday`/`aroundToday` pause; the Map (`seasons` per year, `sampleBodies` per day), Sky (`sampleBodies` per day) and panel Place (`guessZone` each hour) views still work per frame; `fastPlayback(state)` is the switch |

## Expansion programme — photo (Q8): the Selected card's tools (photo agent, 2026-09-25)

| item | status | notes |
|---|---|---|
| Golden and blue hour, the alignment finder with the map picker, "When is it at…?" by bearing, the Milky Way planner, the Moon in detail, RA/Dec and the magnetic bearing on every body, the predicted sextant reading, the tides line in Place | completed | `web/src/next/panel/{photo,moon-tools,alignment,when,selected}.ts`, `web/src/next/map/pick.ts`; `docs/ACCURACY.md` section 18 |
| The planets' apparent size | completed | planetdetail's `planet_disc` (the equatorial diameter, and the polar one in the tooltip), a quarter-hour at a time |
| The ±ΔT chip and the tier helper | completed | time-ui's `uncertaintyText` after every time (`deltaTNote`), the chip beside each tool's heading, `sightsOffered` / `sightsOnlyText` for the predicted reading, `scaleLabel` on the cards' second clock |
| Opening Charts on its Tides tab | completed | "Tides chart" and "The Sun's bearings through the year" call charts2's `showCharts` through a dynamic import (the Charts module stays lazily loaded) |
| time-ui's rows on a literal "UTC" and on "1990–2060" | completed for the photo agent's files | `panel/selected.ts` writes the second clock with `scaleLabel`; `panel/when.ts`, the finder, the planner and golden hour name the real bounds (`outsideWords`, from `coverageBounds`). `panel/place.ts` (its `formatOffset` without the instant) is navigate2's |
| Aiming the Sky view | waiting | "Show in Sky" (Milky Way) and "See it up close" (the Moon) open the Sky view at the moment; pointing it at the galactic centre and the Moon's close-up inset are the sky2 agent's (`// sky2:`) |
| Alignments for the planets and a horizon profile | unstarted | the engine takes any body; the finder offers the Sun and the Moon. A skyline's height per bearing (the real horizon) would replace the single "At a height" |
| Alignment dates across a daylight-saving change | known limit | `alignment_days` lays a year on one fixed UTC offset (the one at the time shown); the list writes each day in the real zone, so only the grouping into runs of an event within an hour of local midnight could differ |
| Offering the tides pack from the Place section | decided against | the line appears only when the pack is on the device; offering it everywhere would put a US-only download in front of every visitor, and knowing that a place is near a US station needs the pack itself |

