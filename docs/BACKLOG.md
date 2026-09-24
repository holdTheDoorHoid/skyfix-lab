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
| Corrections: stars + Sun path, horizon modes, refraction validity | completed | Sun SD/HP from the ephemeris; Moon/planets deferred by design |
| Offline astronomy: Sun + stars, fixture-pack fallback | completed | stars 0.0011', Sun 0.0026' vs Skyfield; pack says "limited-date operation" |
| Interface: CLI + browser workbench, bundled assets | completed | CLI: 10 subcommands (`validate reduce solve catalog coverage convert demos simulate experiment plan`), 98 tests (`cargo test -p skyfix-cli`); WASM adapter: 10 tests, every export backed by real code, no feature gates, no stubs (`cargo test -p skyfix-wasm`); browser: 98 vitest tests across 6 files (`npm test --prefix web`), production build 108 kB JS / 11 kB CSS / 822 kB WebAssembly with no CDN fonts, scripts or map tiles (`npm run build --prefix web`) |
| Simulator: seeded, truth separate, six error scenarios | completed | ten scenarios; experiment summaries in CSV/JSON |
| Observation planner | completed | geometry-driven greedy ranking with disclosures |

## Follow-up modules

| item | status | notes |
|---|---|---|
| A. Stationary camera sextant (synthetic images) | partial | attitude and position kept apart by type; full render-to-fix chain proven end to end, 69 tests (`cargo test -p skyfix-camera`) — but only on synthetic images. The module's own gap: the 58-star closed-world catalogue identifies on an 80-degree lens but fails a plausible 40-degree one at the briefed pointing (CAMERA.md section 4), and "nothing in this crate has met a real lens, a real sensor or a real sky" (CAMERA.md section 9) |
| B. Polarization compass laboratory | completed | 180-degree ambiguity always returned, never guessed; 76 tests (`cargo test -p skyfix-polar`). Scoped to heading estimation from a stated sky model, as designed — see "Polarization geolocation" below, which is the deliberately deferred remainder |
| Navigation methods (explorer wave 1): noon sight, latitude by Polaris, averaging a run, running fix in the browser | completed | `crates/skyfix-core/src/methods/`, WASM exports in `crates/skyfix-wasm/src/nav.rs`; validated against Skyfield truth, Bowditch's worked examples and seeded coverage (`docs/NAVIGATION_METHODS.md` section 6). The documented gap: the Polaris sigma under-covers (89.8 %) within 1.5° of the pole when the DR's longitude is uncertain by tens of degrees. Moon and planet sights and lunar distance are wave 2 |
| C. Motion and independent navigation checks | partial | disagreement statements, never a diagnosis; 58 tests (`cargo test -p skyfix-motion`). The module's own gap: a running fix's nominal 95 % ellipse is a documented lower bound, measured at 92.3 % coverage over 300 seeded repetitions, because the dead-reckoning error behind every sight in one fix shares the same speed and course bias and the solver is never told so (MOTION.md section 3) |

## Unstarted, with the reasoning

| item | status | notes |
|---|---|---|
| Deeper star catalogue for the camera module | unstarted | Real cameras see thousands of stars; the 58-star closed world works only in simulation. Plan: a magnitude-limited catalogue (about 9 000 to 15 000 stars, magnitude 6.5 to 7) from a permissively licensed source such as the Yale Bright Star Catalogue, stored in a compact binary form, with an indexed pair-angle search (k-vector or geometric hashing). Not the full 118 218-entry Hipparcos catalogue: that would reopen the CDS non-commercial licence question and add megabytes to the browser build for no benefit to sextant work. Owner decision 2026-09-24. |
| Moon and planets | unstarted | Needs an independently validated ephemeris path; the fixture-pack provider is the intended vehicle (Skyfield-generated packs with declared coverage). |
| Moving observer in the core solver | unstarted | Module C provides running fixes by advancing geographic positions; a first-class moving-observer model in the solver would treat DR error as correlated across sights instead of inflating sigmas. |
| Real sextant sights | unstarted | No hardware yet; the artificial-horizon path is implemented and tested on synthetic logs. |
| Camera on real imagery | unstarted | Lens calibration, a real local vertical, timing, rolling shutter. |
| Polarization geolocation | unstarted | Deferred by design; heading first. |
| Map background (coastlines) | unstarted | A graticule is acceptable per the brief; a bundled public-domain coastline would be a cosmetic improvement. |
