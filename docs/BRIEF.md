# SkyFix Lab — Rust celestial navigation workbench

Prepared 24 September 2026. This is a project proposal and implementation brief, not a code audit or verified navigation product.

## Recommendation

Build an offline Rust celestial-navigation engine, a usable digital-sextant interface, and a deterministic experiment runner. The central question is: **Where do these sky observations place me, and how much should I trust the answer?**

The first demo should work without hardware. Load a simulated observation session near Philadelphia, solve a position, inspect sight corrections and residuals, and vary observation noise, clock offset, and shared instrument bias. Show what happens when stars cluster in one direction or one observation is wrong. Follow with real manual sextant observations when available.

This is a useful foundation for a future camera + inclinometer/IMU instrument, and for polarization-compass research. Make those extensions separately testable. A 12-hour sprint is a prioritization budget, not a promise that every research feature can be delivered.

## Alternatives considered

| Idea | Appeal | Main obstacle | Decision |
|---|---|---|---|
| Offline digital sextant | Useful immediately; straightforward manual input | Existing tools already cover much of this | Build as the reliable core |
| Celestial navigation error workbench | Hardware-free experiments; exposes real engineering tradeoffs | Needs careful uncertainty modeling | Primary differentiator |
| Camera star tracker | Compelling visual demo; path to an instrument | Calibration, star identification, local vertical, test imagery | Next milestone |
| Polarization compass simulator | Distinctive, inspired by SkyPASS and insect navigation | Ambiguity, calibration, simplified atmosphere | First optional research module |
| Learned image-to-location model | Interesting ML experiment | Dataset assumptions and sim-to-real validation | Defer |

## Source assessment

This assessment used accessible project documentation and research, not builds or source-level correctness verification. Pin upstream revisions and inspect actual implementation and licenses before reuse. A README feature or accuracy claim is not independent validation.

| Source | What was established | Proposed use |
|---|---|---|
| [alejandrozarco/celestial-navigator](https://github.com/alejandrozarco/celestial-navigator) | Browser tool documenting sight reduction, direct circle fixes, corrections, planning, offline operation and export; MIT shown | Main workflow reference; selected license-compatible algorithms after verification |
| [alinnman/celestial-navigation](https://github.com/alinnman/celestial-navigation) | Python toolkit with stationary/moving observer workflows, examples, calibration and chronometer material; MIT shown, separate other-license file | Navigation examples and comparison cases; inspect data provenance separately |
| [ms8r/celnav](https://github.com/ms8r/celnav) | Older Python/Tkinter and PyEphem implementation; GPL noted in README | Almanac and moving-observer workflow reference |
| [aendie/SkyAlmanac-Py3](https://github.com/aendie/SkyAlmanac-Py3) | Nautical almanac generation using Skyfield and Hipparcos data | Reference fixture generation; do not port the PDF system |
| [linuskmr/sextant-rs, published documentation](https://docs.rs/crate/sextant/latest) | Published sextant 0.2.1 documentation emphasizes solar culmination measurements | Evaluate a narrow Rust reference; not assumed to be a general multi-body solver |
| [nav-solutions/celestial-nav](https://github.com/nav-solutions/celestial-nav) | Rust camera + IMU library, documented no_std goal, MPL-2.0 shown | Inspect before considering camera-oriented reuse; functionality not build-verified |
| [DaniilGalahov/celnav](https://github.com/DaniilGalahov/celnav) | Python navigation algorithms, internal/AstroPy ephemeris choices; README flags lunar and spherical-model limits | Secondary comparison source, not numerical truth |
| [gregtozzi/deep_learning_celnav](https://github.com/gregtozzi/deep_learning_celnav) | Synthetic sky images, time input, learned regression, Jetson TX2 experiment | Experimental dataset ideas; inspect camera-orientation assumptions |
| [celestialheroes/celestial-tracker](https://github.com/celestialheroes/celestial-tracker) | Arduino-based tracking/prediction project | Peripheral future pointing hardware inspiration |
| [rsasaki0109/astro_navigation](https://github.com/rsasaki0109/astro_navigation) | Repository describes space navigation including star tracking, lunar terrain navigation and visual odometry | Broader future reference; exclude its full scope from this sprint |
| [SkyPASS](https://www.polarissensor.com/skypass/) | Vendor describes Sun/Moon, stars and polarization; published heading specification requires position within 1 km and time within 1 s | Sensor architecture inspiration; do not infer cold-start location performance from heading specifications |
| [Digital Sextant DS-10](https://www.bluewatersuperyacht.com/digital-sextant) | Product workflow automates calculations after a sight | UX inspiration; marketing statements are not validation evidence |
| [Passive Polarized Vision for Autonomous Vehicles](https://pmc.ncbi.nlm.nih.gov/articles/PMC11174665/) | Review of sensing, heading/geolocation approaches, calibration and atmospheric-model limits | Research map for a later polarization module |
| [Biomimetic Polarized Light Navigation Sensor](https://www.mdpi.com/1424-8220/23/13/5848) | Review comparing polarization sensor architectures and challenges | Research map for future hardware choices |
| [Honey Bee Dead Reckoning](https://tomrearick.substack.com/p/honey-bee-dead-reckoning) and [author's Reddit post](https://www.reddit.com/r/drones/comments/1nl3pe0/drone_simulates_honey_bee_navigation/) | Author describes low-resolution monocular optic-flow mapping | Later relative-motion input; not an absolute celestial fix |
| [OpenCPN plugin documentation](https://opencpn-manuals.github.io/main/opencpn-plugins/misc/celestial-nav.html) | Page retrieved; detailed plugin capabilities were not established in this review | Revisit for future interoperability |

Unverified during this review because content could not be retrieved: osresearch/sunwheel; alejandrozarco/starsight; kevinveenbirkenbach/celestial-navigation; linuskmr/web-sextant; Chershi-319/celestial-navigation; cropsgg/TARA; the Toorcamp ZFEDDB talk; the Inside GNSS article; the three supplied YouTube videos. The hosted celestial-navigator pages also failed retrieval, but their repository documentation was available. The pasted PNG filename was not an actual supplied image. Do not invent capabilities for these references. Fetch them only if they can change implementation choices; time-box retrieval.

## Agent instructions — implement this project

Create a new Rust project called `skyfix-lab`. Deliver working software, tests, demo data and a clear completion report. Favor a complete vertical slice over a wide collection of placeholders. Make routine implementation choices autonomously; record significant assumptions. Do not deploy externally as part of this brief.

### Non-negotiable physical distinctions

1. A measured altitude relative to a known horizon/local vertical constrains position to a circle. One arbitrary altitude does not yield a unique latitude/longitude. Two circles can have two intersections; report ambiguity or clearly identify the prior used to resolve it.
2. Identifying stars in a camera frame yields camera orientation relative to the sky. It does not by itself yield terrestrial location: a calibrated horizon/local vertical or another sufficient constraint is required. Separate attitude results from position results in APIs and UI.
3. Clock error and longitude are strongly coupled for stellar observations. Do not offer unconstrained simultaneous clock-offset and longitude estimation and claim a unique answer. Initially inject clock error as an experiment, or propagate an externally supplied clock uncertainty.
4. Gravity sensing on an accelerating platform is not a perfect local-vertical measurement. The first camera follow-up should assume a stationary calibrated instrument.
5. Polarization measurements have angular ambiguities and depend on geometry and calibration. A modeled sky pattern does not prove all-weather compass accuracy or independent global positioning.
6. Independent random observation noise and a shared instrument/time bias are different. Repeating measurements does not average away a common bias.

### Required first release

**Observation input:** Versioned JSON sessions, CSV import/export, explicit UTC timestamps, body IDs, altitude, altitude kind, uncertainty, horizon mode and applicable correction parameters. Distinguish raw sextant altitude from corrected altitude so corrections cannot silently run twice. Reject invalid angles, non-finite values and inconsistent fields.

**First numerical slice:** Accept apparent geocentric GHA/declination supplied in an observation fixture for stars, corrected geocentric altitude and a documented spherical Earth model. This isolates solver correctness from astronomy-provider implementation. Never mix topocentric directions and geocentric corrected altitudes.

**Sight reduction:** Compute predicted altitude, azimuth and intercept at an assumed position. Show correction components individually. Use explicit east-positive longitude internally and convert west-positive GHA consistently. For the simple spherical model, `sin(h) = sin(phi) sin(delta) + cos(phi) cos(delta) cos(GHA + lambda_east)`.

**Position solver:** Weighted nonlinear least squares for stationary observations with known time; report convergence, per-sight residuals, numerical rank/conditioning and alternative solutions where applicable. Use multistart/coarse initialization for ambiguous cases rather than returning the first local solution. An assumed position used only as an initializer must not silently become a probabilistic prior. Report priors and their effect explicitly.

**Quality output:** Tangent-plane position covariance and a clearly labeled nominal 95% ellipse when locally justified; no ellipse for singular or grossly nonlinear/ambiguous cases. With known input variances, compute covariance without blindly rescaling by zero residual degrees of freedom. Two measurements cannot independently establish noise variance. Robust weighting and outlier removal must be visible, optional and accompanied by appropriate uncertainty caveats.

**Corrections:** Start with stars plus a validated Sun path. Specify the sign of index correction; distinguish natural sea horizon, reflected artificial horizon and electronic local vertical. A reflected artificial-horizon angle is approximately twice altitude; specify and test the correction order. Apply dip only for the applicable horizon. Document refraction validity range and reject or flag low-altitude use outside it. For the Sun, handle limb/semidiameter and parallax consistently with the ephemeris convention. Defer Moon/planets unless independently validated.

**Offline astronomy:** Place ephemeris access behind an interface. Evaluate existing Rust options by accuracy, supported bodies, license and native/WASM build support before choosing one. Do not rewrite a complete ephemeris engine merely to consume tokens. Ship a useful validated Sun/star provider if feasible. Fallback: bundle a dated fixture/almanac pack with explicit coverage and provenance, interpolate angles correctly across wrapping, and refuse out-of-range queries. Label the fallback honestly as limited-date operation. No runtime network requirement.

**Interface:** Rust calculations shared by CLI and a thin local UI. Prefer Rust/WASM + TypeScript for an offline browser interface if toolchain setup is quick. A local native Rust service with bundled browser assets is an acceptable documented fallback. Provide observation editor, correction table, map/graticule or position plot, circles/lines of position, residuals and uncertainty. Assets must be bundled: no CDN fonts, scripts or mandatory map tiles. A simple graticule is acceptable; do not block on a map SDK.

**Simulator:** Deterministic seeded generation with truth stored separately from estimator inputs. Include independent altitude noise, common altitude bias, shared clock offset, missing observations, one wrong sight and poor azimuth geometry. Display truth only in simulator/evaluation views. Compare estimated error with predicted uncertainty; produce CSV/JSON experiment summaries. Do not expose hidden truth to solver initialization.

**Observation planner, if time permits:** Rank visible bodies using measurement sensitivity/conditioning and expected uncertainty, not only brightness or equally spaced azimuths. An approximate supplied position is allowed here and must be disclosed. Visibility without weather data is geometric visibility only.

### Suggested structure

- `skyfix-core`: units, coordinate/time conventions, sight reduction, corrections, solver and uncertainty.
- `skyfix-ephemeris`: offline astronomy-provider adapters and data coverage metadata.
- `skyfix-cli`: `reduce`, `solve`, `simulate`, `validate`, optional `plan` commands.
- `skyfix-web`: thin UI and WASM adapter if feasible.
- `fixtures/`: input observations and independently generated expected outputs.
- `tools/reference/`: optional Python/Skyfield fixture-generation scripts; never a runtime dependency.

Use `f64` for navigation calculations. Keep I/O out of the numerical core. Choose a small number of maintained dependencies and pin them. Record source revisions and data licenses in `THIRD_PARTY.md`. Do not combine code under incompatible licenses; inspect actual license texts and file-level notices before copying. Preserve applicable attribution. A repository being public is not sufficient permission to copy it.

### Validation that matters

- Analytic spherical-geometry cases with independently specified body vectors, known locations and expected altitudes.
- Independent Skyfield-generated apparent-direction/altitude fixtures with matching time/frame/refraction conventions. Store generator version, ephemeris identifier, Earth-orientation assumptions and expected tolerances.
- Longitude wraparound, negative hemisphere coordinates, high latitudes, near-zenith cases, poor conditioning and duplicate observations.
- One-sight underdetermination and two-sight ambiguity must produce explicit results, not false precision.
- Clean, well-conditioned synthetic geometry should recover its truth within 10 metres; this is a numerical regression target, not a real-world accuracy claim.
- Set and justify ephemeris tolerances separately. If a chosen low-cost model cannot meet the intended angular tolerance, document the limit and include its error in the budget rather than weakening tests silently.
- Shared-bias tests must demonstrate that many repeated sights can still yield an inaccurate position despite small residuals.
- Seeded Monte Carlo coverage checks for nominal ellipses under the stated independent-noise model; report sample count and uncertainty. Add correlated-error scenarios as explicit failures of that simpler model.
- Offline smoke test with network unavailable and no runtime data downloads.
- Native/WASM numerical parity where both targets exist.

Do not use only round-trip tests where the simulator and solver share the same mistaken formula. Do not treat agreement with another hobby repository as ground truth. Do not add volume tests that merely mirror implementation.

### Twelve-hour priority budget

| Time | Deliverable | Gate |
|---|---|---|
| 0–1 h | Scope, source/license inventory, conventions, minimal workspace | Record provider decision; time-box inaccessible references |
| 1–4 h | CLI vertical slice with supplied GHA/declination, fix solver, analytic tests | Real working solve with residuals and ambiguity handling |
| 4–6 h | Sun/star data path, applicable corrections, independent fixtures | Documented accuracy and coverage; offline data present |
| 6–8 h | Thin UI, observation editor and position/uncertainty plot | One end-to-end user flow |
| 8–10 h | Seeded simulator and error experiments | Clock, bias and geometry scenarios produce interpretable results |
| 10–12 h | Edge cases, packaging, offline check, documentation | Reproducible demo and honest completion report |

If behind schedule, cut planner, Moon/planets, moving observer, camera processing and polarization in that order. Preserve solver correctness, offline operation and a working interface. Reserve the final two hours for completion; do not start a major new subsystem then. Spend excess capacity on independent references, numerical edge cases and reproducible experiments.

### Required packaged demos

1. A stationary Philadelphia-area star-observation simulation with time and observations chosen so the bodies are actually above the horizon.
2. Good versus clustered observation geometry.
3. One bad observation and visible residual diagnostics.
4. A shared clock offset changing the recovered location.
5. A shared altitude bias that cannot be eliminated by averaging repeated measurements.
6. A single-sight and ambiguous two-sight case.

Deliver README quick start, architecture/conventions document, source and license inventory, accuracy/limitations document, demo commands, test results and a backlog with completed/partial/unstarted labels. Clearly distinguish simulations from real measurements and numerical accuracy from field accuracy.

## Follow-up modules

### A. Stationary camera sextant

Start with a calibrated camera, timestamp and independently measured local vertical or horizon. Import images, extract star centroids, identify stars, solve attitude, transform into measured altitudes and reuse the core. A horizon line, calibration board or known star IDs can simplify the initial experiment. Prove the full chain with real recorded data before promising automatic global fixes. A camera-only attitude demo is a legitimate separate deliverable.

### B. Polarization compass laboratory

Implement an ideal single-scattering Rayleigh sky model and synthetic analyzer images at 0/45/90/135 degrees. Under an explicitly calibrated ideal measurement convention, recover Stokes values, degree of linear polarization and angle of linear polarization. Account for modulo-180-degree angle representation and mask low-signal samples. Compare a few-channel sensor against an image sensor; inject gain mismatch, angular misalignment, tilt and missing sky regions. Return unresolved heading candidates rather than guessing. Simple masking or depolarization is a stress model, not validated cloud physics. Given location/time and tilt, study heading estimation first; defer geolocation inference.

### C. Motion and independent navigation checks

Add running fixes with explicit motion uncertainty, then replay celestial observations alongside independently sourced GNSS and odometry. First output should say that two navigation estimates disagree beyond modeled uncertainty, not diagnose spoofing. Clock and calibration errors can create the same disagreement. Monocular optic flow requires a scale source or assumptions before it supplies metric displacement. Keep relative motion, absolute heading and absolute position as distinct measurement types.

## Ready-to-paste launch instruction

Read this brief and implement SkyFix Lab in a new Rust workspace. Work through the required first release and twelve-hour priority budget. First produce a validated CLI position fix from supplied celestial directions, then add the offline astronomy path, thin UI and error simulator. Keep the physical observability limits explicit. Do not begin with ML, a full astronomy rewrite or camera hardware. Make routine decisions autonomously, time-box blocked dependencies, and finish with runnable demos, meaningful independent tests, documented limitations and a precise completion report. Stop adding scope when it would jeopardize packaging the working result.
