# Completion report

Three parts, newest first. **Part 1** is the expansion programme of 2026-09-24/25 (deep
time, accuracy, astronomy and navigation features). **Part 2** is the explorer redesign of
2026-09-24 (the SunCalc-style site). **Part 3** is the original sprint of 2026-09-23/24 (the
workbench, now at `/classic/`). Each part was written by the planner at the end of its
programme from the agents' reports and the merged tree, and each names its verifier's
report. The site is https://holdthedoorhoid.github.io/skyfix-lab/.

## Part 1 — The expansion programme (2026-09-24 to 2026-09-25)

Status: **complete. Every package is merged, verified on main and live**. Written by the planner (the main session, Claude Fable 5.1) from the
agents' final reports, the verifier's `VERIFICATION_2.md`, and the merged tree at
`b21fce1`. The site is live at https://holdthedoorhoid.github.io/skyfix-lab/.

### 1. What the owner asked for, and what was decided

> "Further expand and improve on this project. … The Moon sights ignore the Earth's slight
> flattening: is that worth improving? Can we make it more accurate? … I want to calculate out
> farther than 2060. Review the project and website and analyze for any features that are
> missing: useful to users, not only celestial navigation, but people interested in astronomy
> and similar events. Use Fable 5.1 for project management and Opus 5.5 for agent tasks."

| Question | Decision (interview, 2026-09-24) | Outcome |
|---|---|---|
| How far in time | 2000 BC to AD 3000; full accuracy 1550–2650 validated against JPL DE440; a labelled band outside it with its uncertainty on screen; Julian calendar before 1582-10-15 | Done. Validated tier 1550-01-01 to 2650-01-22; labelled tier 2001 BC to AD 3000, display only; both in the core module, no download |
| Astronomy features | all four bundles: Tonight and deep sky; Moon and planets in detail; photography and Sun tools; calendar, export and sharing | Done |
| Navigation features | all four bundles: tides; compass and variation; sailings and passage planning; sight extras | Done |
| Extra data | optional packs, small core; the first visit stays about 1 MB | Packs for tides (345 KB) and the lunar limb (2.2 MB); the core module is 1.15 MB gzipped (it was 0.85 MB before the programme and 1.29 MB at its peak) |
| Data credit | credit-free preferred; documentation acknowledgement when nothing credit-free exists; on-screen credit only as a last resort | Nothing on screen but OpenStreetMap's credit while the street layer is on; every source in THIRD_PARTY |
| Models | Fable plans and integrates; Opus builds; Sonnet documents | As done: 25 agent packages |

The planner's own accuracy decisions (the owner asked "is it worth it?"): the Earth's shape
in Moon sight reduction (yes: the term reaches 0.2′), DUT1 no longer assumed zero, a ΔT model
with an uncertainty, a refraction uncertainty term near the horizon, and the eclipse lunar
limb as an optional pack. All five are built.

### 2. What exists now

**For anyone looking up.** A **Tonight** tab: the night's timeline (twilight, golden and blue
hour, Moon up, Milky Way core, moonless darkness), the Moon, the planets with Jupiter's moon
events and Saturn's ring tilt, the best deep-sky objects for the sky quality you choose, meteor
showers, the Milky Way, the next fortnight's events from eleven sources, tides and photography
hours, on one printable page. The **Sky** view draws 213 deep-sky objects, the Milky Way, an
RA/Dec grid, fields of view for binoculars, telescopes and cameras, meteor radiants, and close-
ups of the Moon (with tonight's terminator features named), Jupiter with its moons, Saturn with
its rings and the other planets; it searches any star or object by name, takes comets and
asteroids from orbital elements, zooms to 12×, and saves a picture. **Events** adds lunar
perigee and apogee with supermoons, Earth's perihelion and aphelion, planetary stations and
retrogrades, conjunctions, lunar occultations seen from your place, transits of Mercury and
Venus with local circumstances, meteor showers and Galilean events, with calendar (ICS) and
CSV export; the eclipse card can correct its contact times for the Moon's mountains and
valleys and show approximate Baily's beads. The time bar goes from 2001 BC to AD 3000, in the
Julian calendar before 1582, at up to ten years a second, with a ± chip stating the Earth's
rotation uncertainty where it matters.

**For photographers and the Sun-minded.** Golden and blue hour, "when is it at" a bearing, an
alignment finder (pick a bearing on the map; get the days the Sun or Moon rises or sets along
it), a Milky Way planner, and a Charts → Sun tab with sun path, analemma, sunrise and sunset
bearings, the equation of time and a clear-sky solar-panel helper; every chart saves as PNG,
CSV and print.

**For navigators.** Tides for 3 499 NOAA stations (high and low water, curves, tables, datums)
behind a 345 KB pack; magnetic variation anywhere and compass error by the Sun's azimuth or
amplitude; great-circle and rhumb-line passages on the map with dead reckoning feeding the
running fix; DUT1, site elevation, air pressure and temperature, an index-error log and a
watch log; shoreline horizon; star identification from a sextant altitude and bearing;
printable sight worksheets, a plotting sheet and a rotating star finder; the Nautical
Almanac's three-day openings and its Increments and Corrections, altitude-correction, Polaris
and arc-to-time tables, for any year. The Moon's sight reduction now uses the exact
topocentric position, which removed a systematic error of up to 0.2 nautical miles.

**Everywhere.** 84 command-line subcommands reproduce every number the site shows, as JSON
identical to the WASM exports. Three themes, phone layouts, offline after the first visit.

### 3. How closely it was checked

The full table is `ACCURACY.md` (At-a-glance). Headlines, every one backed by a test file:

| Engine | Reference | Result | Target |
|---|---|---|---|
| Sun, Moon, planets, 1550–2650 | JPL DE440 | Sun 0.01″, Moon 0.36″, Mars 0.71″, Uranus 0.91″ | 0.02′ (1.2″) per body |
| Sun, Moon, planets, 2001 BC–3000 (labelled) | JPL DE441 | Sun 0.48″, Moon 1.43″; planets within 5″ (Mars 0.15′) | labelled, shown with its ± |
| ΔT (Earth's rotation) | NASA Five Millennium Canon | within the stated σ at −2000 and 2999; the SMH 2016 revision explains 1000 and −500 | honest σ |
| Moon sights | own topocentric model, WGS84 | Moon sessions 2.6 / 5.1 m fix error (18 / 35 m before) | remove the 0.2′ term |
| Tides, 3 499 stations | NOAA's own predictions | 1.36 min and 0.99 cm worst over 39 120 extremes; Anchorage 0.19 cm | 2 min, 5 cm |
| Eclipse contacts with the lunar limb | NASA SVS, 48 cities; an independent implementation | second contact 1.2 s; third contact 1.1 s earlier than SVS (their definition); 0.44 s vs the independent code | 2 s |
| Planet discs, rings, Galilean moons | JPL Horizons | 0.0005°, 0.00005°, 0.33″; 336 moon events within 23–97 s | 1″ |
| Transits of Mercury and Venus | Skyfield, NASA | 4.4 s; 2004/2012 contacts 5.1 s; 101 city contacts 5.7 s | 30 s |
| Conjunctions and stations, 1990–2060 | Skyfield | 3 223 and 2 300 matched one for one; stations within 96 s | 5 min |
| Deep-sky positions (213) | SIMBAD; Corwin | median 0.003′; all within 0.37′ | size-based |
| Meteor showers (32) | IMO calendar | every 2026 and 2027 peak on the IMO's date | 1 day |
| Almanac tables | independent Python; Bowditch | 6 274 values identical; 36 of 46 book values identical, 10 within 0.1′ (the book's own formulas) | 0.1′ |
| Alignment finder geometry | Geoscience Australia's Vincenty example | 1 mm, 0.5″ | — |
| Rigil Kentaurus (α Cen A's orbit) | ALMA (Akeson 2021) | 0.10–0.12″ (the Almanac's straight line: 4.4–4.6″) | — |
| Sky view vs engine | the engine | positions to 1e-9° | — |

### 4. The verifier's findings

An independent adversarial pass (`VERIFICATION_2.md`) found **28 problems: 6 high, 8 medium,
14 low**, fixed 21 on its branch and left 7 decisions to the planner (all now taken, §7).
Nothing found would have given a navigator a wrong fix without warning. The ones worth knowing:
NOAA treats the σ1 tide constituent as a compound of O1 and P1 (Anchorage went from 1.08 cm to
0.19 cm); BC eclipse ids lost their day; the occultation track near a coverage end was wrong by
up to 1.9 km; every view kept asking the engine for positions it did not draw during
ten-years-a-second playback (50–78 % of busy time, now zero); the memoised engine had two
latent faults; Jupiter's close-up printed a raw engine message at far dates; the Selected card
claimed "offered for sights" at 585 BC. It also settled the planner's questions: the eclipse
third-contact offset is NASA SVS's contact definition, not ours (their stated ΔT would move it
the other way); the ± chip on rise and set times overstated ΔT's effect while the Moon's
shown position carried none (the rule was changed, §7).

### 5. Discoveries worth knowing
Things the programme learned that are true of the outside world, not of this code:

- **NASA's eclipse visualisation (SVS) uses its own third-contact definition.** Its second
  contact agrees with ours and with an independent implementation to 0.2 s, but its third
  contact is 1.1–1.2 s later for both the 2024 total and the 2023 annular eclipse, and NASA's
  stated ΔT would move it the other way. Its 2021 Antarctic path table was already known to be
  2.3 km off. Two rows of NASA's transit catalogue are misprinted.
- **NOAA's tide conventions, recovered from its own predictions:** node factors at mid-year and
  V0 at 1 January; M1 as Schureman's formula 201 advanced at formula 194's speed; σ1 treated as
  a compound of O1 and P1; subordinate offsets in feet; a high and a low less than two hours and
  0.1 ft apart are both dropped from the tables. With these, 3 499 stations reproduce to about a
  minute and a centimetre.
- **The mean-limb annular eclipse is too long.** For 2023 the smooth Moon made annularity 7–18 s
  longer than the real limb; San Antonio gained 15 s of totality in 2024 from the limb (NASA: 18 s).
- **Rigil Kentaurus is not where a straight-line proper motion puts it.** α Cen A orbits the
  pair's barycentre; the Nautical Almanac's linear motion is already 4.4–4.6″ from ALMA's
  measured positions and drifts to 17″ by 2060. The engine follows the USNO orbit (0.1″).
- **The Moon's secular acceleration** in the current ΔT literature is −25.82″/cy², not the
  −25.85 some sources still quote; and the SMH 2016 ΔT revision differs from NASA's Five
  Millennium Canon by 88 s at AD 1000 and 186 s at 500 BC.
- **The Galilean-moon theory (E5 as given by Meeus) drifts to 0.9″ by 1650**; its accuracy is now
  stated by era. Jupiter's Great Red Spot cannot be tracked from a stored longitude: it drifts
  tens of degrees a year.
- **Wikidata's deep-sky data needs checking:** NGC 6357's position is 22′ off both references,
  and its V magnitude is sometimes a galaxy's nucleus or a nebula's central star, so magnitudes
  came from the HEASARC catalogues where they exist.
- **Skyfield's `PlanetaryConstants.read_binary` keeps only the last kernel segment per body**,
  which matters when a lunar-orientation kernel spans several segments.
- **The IMO's meteor calendar revises activity dates between years** (two 2027 start dates
  changed); the table follows the published values at retrieval and says so.

### 6. Data and licences
Everything shipped is listed in `THIRD_PARTY.md` with its URL, retrieval date, hash, licence
basis and processing. The policy held: **nothing on screen credits anything but OpenStreetMap**,
and only while the street layer is on; a source-scan test fails if a credit string returns.

| Shipped data | Basis |
|---|---|
| NOAA tide constants, datums and offsets (3 499 stations) | public domain; NOAA requests attribution, given in the documentation |
| LRO LOLA LDEM_16 heights (the lunar-limb pack) | U.S. Government work |
| IGRF-14 and WMM2025 coefficients | free with documentation credit (IAGA); U.S. Government work (NOAA/NCEI, USGS) |
| IERS EOP tables (DUT1, ΔT history) | free |
| Wikidata deep-sky objects | CC0 |
| HEASARC globular-cluster and RC3 galaxy tables | U.S. Government works |
| SIMBAD sizes and one magnitude | documentation acknowledgement |
| IAU Meteor Data Center and IMO calendar values (32 showers) | published facts compiled and restated in our own form; documentation acknowledgement; the residual risk (EU database right on a substantial extraction; ours is not) is recorded |
| NASA COBE/DIRBE (the Milky Way isophotes) | NASA data, documentation acknowledgement |
| IAU WGSN star names (220 added) | facts |
| ELP/MPP02 lunar series (re-fitted, re-truncated, binary) | a published scientific solution (Chapront & Francou 2003) distributed by its authors without a licence statement, mirrored byte-identically with pinned hashes; documentation acknowledgement; the residual risk is recorded |
| VSOP87A planetary series (with DE-fitted corrections) | CDS VI/81, free with acknowledgement |
| JPL Small-Body Database elements for Ceres (the paste-box example) | facts; JPL asks no credit |
| IAU 2015 rotation models, NASA fact-sheet ring radii, Schureman SP 98, Bowditch, Vincenty | facts and public-domain works |
| Inter and JetBrains Mono | SIL OFL; the licence texts now ship beside the fonts as the OFL requires |

Development-time only, never shipped: JPL DE440/DE441, Horizons, the JPL satellite ephemeris,
NASA's eclipse and transit pages, NASA SVS city times, USNO, NOAA's predictions, the Minor
Planet Center, Corwin's NGC/IC positions, ALMA positions from Akeson et al. 2021, Skyfield
(MIT), pyerfa and fontTools (private tools).

### 7. Deviations from the plan and decisions taken
- **The labelled tier is cut more coarsely than planned** (5″ per planet, Earth 0.3″) so that
  both tiers fit in the core module; it is display only and its published figures say so.
  There is **no deep-time pack**.
- **The module budget** was raised from 1 MB / 2.5 MB to 1.25 MB gzipped / 3 MB raw when nine
  engines had landed (peak 1.29 MB / 3.12 MB), then brought back to **1.15 MB / 2.55 MB** by the
  binary ephemeris tables and `opt-level = "z"`. A first visit downloads 4.1 MB gzipped in all
  (the map, fonts and code); the offline copy is 4.6 MB.
- **The ± chip rule changed** after the verifier showed the whole ΔT uncertainty on rise and set
  times overstated ΔT's effect a hundredfold while the Moon's shown position carried none: the
  chip now scales with each quantity's real sensitivity (`chip2`; CONVENTIONS 15.1–15.2).
- **Eclipses and planet events still cover 1990–2060** although the Moon and planets now reach
  1550–2650; widening the searches is in the backlog, and the views say so in words (the eclipse
  of 585 BC is not listed).
- **Third contact against NASA SVS** misses the 2 s target at three of 48 cities for the reason
  in §5; against an independent implementation the engine is within 0.44 s.
- **The almanac tables follow the project's own correction chain**, so ten of 46 values differ
  from the printed book by 0.1′ (the book's refraction formula, Moon radius and temperature
  tables); the pages say which chain they use.
- **Names:** three deep-sky exports were renamed from the plan's sketch (`meteor_showers`,
  `sky_search`, `extinction_table`) because every export shares one namespace; `tide_now` takes
  a datum; `dso_visibility` takes an instant.
- **Small omissions by decision:** the Lobster Nebula (bad reference position), two revised IMO
  2027 dates, the double-star bonus, star charts beside the star list, the Great Red Spot.
- **The labelled tier starts at astronomical year −2000, which is 2001 BC**; the plan's
  "2000 BC" was corrected in every on-screen and documentary mention.

### 8. Known gaps and backlog
`BACKLOG.md` has the full table. The items a user would notice first:

- Eclipses and planet events beyond 1990–2060; the star field, Tonight's deep sky and showers at
  labelled-tier dates (each refuses in words today).
- Speed: a year of meteor showers with an observer (0.2 s), the Moon's year series (0.3–0.5 s),
  an almanac opening (0.2 s, with a "working out" state); Events searches and the year-long
  charts could move to a worker thread; the Sky view's slowest draws exceed 10 ms under load
  (median 4.6–5.1 ms on a quiet machine).
- The alignment finder covers the Sun and Moon only; added comets and asteroids are not kept
  between visits (owner's call); the pack prompt covers the Tides controls on a phone.
- Two size levers not pulled because they change contracts: serde code (738 KB) and repeated
  sort copies (115 KB).
- Navigation extras not built: composite sailing, automatic deviation from the table, a plotting
  sheet for the running fix, a printed passage plan, GPX import, `--zone lmt` and `--request
  FILE` on the command line.
- Drawing limits: galaxies drawn level, the Milky Way not refracted, Saturn's ring shadows and
  Jupiter's markings not drawn, the Moon's seas as ellipses, no limb drawing on the eclipse card.
- **Two behaviours for the owner to confirm:** the rise and set cards go blank while playing
  faster than a month per second; the phone time bar is two lines at a fixed height.

### 9. How it was built
25 agent packages ran in their own git worktrees on their own branches, never pushing;
the planner merged each into main, ran the full Rust and web suites on main before every push,
watched every Pages deploy, and smoke-checked the live site in a browser. Wave 1 built twelve
engines in parallel (sun tools, the Moon's shape and DUT1, geomagnetism, data packs, time scales,
sailings, Moon detail, deep sky, planet detail, tides, the lunar limb, deep time); wave 2 built
eight interface packages (time and calendars, Charts, the Selected card, Almanac, Navigate,
Tonight, Sky, Events) as the engines landed; then command-line parity, the polish pass, the
verifier, the documentation pass (Claude Sonnet 5; everything else Claude Opus 5.5) and the
chip rule. Engineers wrote their own validation against independent references before
reporting; the verifier re-derived a sample of every claim with its own code.

What went wrong, and the rule each incident left: the account's usage limit stopped eight
agents mid-task (they resumed from their transcripts with nothing lost); the Claude Code process
exited twice, once when seven parallel builds exhausted the machine's 15 GB (agents now build
with `-j 3` and test with two workers, never both suites at once); the session's scratch
directory was wiped, taking the briefs with it (they now live outside `/tmp`); an agent's
`run:` line ending in `::` made the Pages workflow invalid YAML, so four pushes deployed nothing
while CI passed (CI now parses every workflow file); one agent's `pkill` killed other agents'
test runs (stop only your own processes); one agent's browser script ran in another session's
tab (own headless browser only); and every merge of a file that several agents had appended to
lost a closing brace at the seam at least once (typecheck and `node --check` after every merge).

### 10. Size and counts
| Measure | Value |
|---|---|
| Commits on main since the redesign's report | 397 (before this report) |
| Agent packages / merges | 25 / 26 |
| Rust | 114 718 source and 39 211 test lines across 12 crates |
| TypeScript | 104 653 source and 26 006 test lines |
| Python (development-time reference tools) | 24 645 lines |
| Documentation | 21 334 lines across `docs/*.md` |
| Rust tests | 1 548 passed, 0 failed, 14 ignored, across 129 test binaries (606 at the end of the original sprint, 1 066 after the redesign) |
| Web tests | 1 631 passed in 106 files (991 after the redesign) |
| Browser checks | 1 190 in `ui-check.mjs`, 79 in `verify2-check.mjs`, 53 offline checks |
| Command-line subcommands | 84 (26 before the programme) |
| Core module | 2 551 154 bytes raw, 1 152 888 gzipped (`opt-level = "z"`); 851 KB gzipped before the programme |
| Optional packs | `tides-us` 345 KB; `lunar-limb` 2.2 MB |
| A first visit / the offline copy | 4.1 MB / 4.6 MB gzipped, all files |

### 11. Reproduce
```
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cargo test --release -p skyfix-ephemeris --test deeptime_reference -- --nocapture
cargo test --release -p skyfix-almanac --test eclipse_limb --test planetdetail_galilean --test planetdetail_transits -- --nocapture
TIDES_FULL_SWEEP=1 cargo test -p skyfix-tides -- --nocapture
cargo test -p skyfix-starfield --test dso_reference --test showers_reference
cargo test -p skyfix-cli --test parity --test explorer_golden
cd web && npm run wasm && npm run typecheck && npx vitest run --maxWorkers=2
npm run build && node scripts/ui-check.mjs && node scripts/verify2-check.mjs && node scripts/core-bench.mjs
cd .. && SKIP_WASM=1 SKIP_INSTALL=1 web/scripts/pages-site.sh && node web/scripts/offline-check.mjs
tools/reference/.venv/bin/python -m tools.reference.generate_all --list
```

## Part 2 — The explorer redesign (2026-09-24)

### What the owner asked for

A prettier site that is easier to use and understand, in the look and feel of
suncalc.org, with features from suncalc.org, mooncalc.org, planetscalc.org and the
Celestial Navigator app: go backward and forward in time, set a location, see where
everything is from there, and see it drawn. The interview settled four questions: both
an offline built-in map and an optional OpenStreetMap street layer; all four feature
bundles (Moon and planets validated for fixes; noon sight, Polaris, running fix,
averaging and lunar distance; printable almanac pages; eclipses and sky events); and a
naked-eye star field with constellation figures, from data that needs no credit.

### What exists now

The site's home page is the **explorer** (<https://holdthedoorhoid.github.io/skyfix-lab/>).
It works offline after the first visit and can be installed as an app. The original
workbench is kept at `/classic/`. The user guide is `EXPLORER_GUIDE.md`.

- **Map and globe.** Click anywhere to set your place; a SunCalc-style compass at your
  place shows where the selected body rises, sets and stands now, and its path today.
  Day, night and twilight shading; the ground point under each body; the circle of
  equal altitude through you; a great-circle and rhumb-line measuring tool; an optional
  street map.
- **Time bar.** A 24-hour ribbon coloured by twilight, a draggable handle, date stepping,
  Now, and Play from real time to a month per second.
- **Side panel.** Place search over 7,342 places, typed coordinates and "use my
  location"; the time zone guessed from the place (right 97 % of the time in a hold-out
  test; the nautical zone at sea); the selected body with rise, transit and set; shadow
  length; "when is it at…"; what is in the sky now; tonight's recommended star sights.
- **Sky.** A planetarium dome and a horizon panorama with 9,095 stars, 88 constellation
  figures drawn for this project, the planets and a correctly phased Moon.
- **Charts.** Height through the day, a year of sunrise, sunset and twilight, a Moon
  calendar and planet visibility.
- **Navigate.** Sights entered by body and sextant reading with live workings; least-squares
  fixes (with shared-bias, robust and multistart options), noon sight, Polaris latitude,
  running fix, averaging a run of sights, lunar distance; a residual heat map; GPX export.
  Every capability of the original workbench is here.
- **Almanac.** Daily pages in the Nautical Almanac's layout, printable on A4 and Letter.
- **Events.** Eclipses with local circumstances and paths on the map, Moon phases,
  equinoxes and solstices, and planet events.
- **Learn.** The ten packaged demonstrations as guided stories, the simulator and its
  coverage experiments, and an illustrated primer.
- **Command line.** 25 subcommands; the new ones (`sky`, `events`, `phases`, `seasons`,
  `noon`, `polaris`, `average`, `running-fix`, `predict`, `lunar`, `plan-sights`,
  `almanac`, `eclipses`, `eclipse`, `planet-events`) give the same numbers as the site.
- **Themes.** Light (SunCalc-like), dark, and red night vision with no blue or white
  light anywhere; phone layouts; keyboard operation throughout.

### Test results

At the final commit: **1,066 Rust tests and 991 web tests, 0 failures**; 191 scripted
browser checks of the built site (every view, three themes, desktop and phone, keyboard,
privacy, memory over 300 view switches) and 64 offline checks, including the upgrade path
from the old site layout; `mdbook build` with no warnings; CI (format, tests, the wasm32
build, the offline smoke test, clippy with warnings denied) green on `main`.

### Validation that matters, with the numbers

References: Skyfield with JPL DE440s (DE421 as a cross-check), the US Naval Observatory,
NASA's eclipse canon and sky-events calendar, Bowditch's worked examples. Full figures in
`ACCURACY.md`, whose first table lists every row below against its target.

| check | result | target |
|---|---|---|
| Moon, 1,757 instants 1990-2060 | worst GHA 0.0149′, Dec 0.0064′, HP 0.00009′ | 0.1′ |
| Planets, all seven | worst 0.040′ (Neptune); Mercury to Saturn within 0.0064′ | 0.1′ |
| Topocentric altitude and azimuth, Moon | within 0.7″ | 0.1′ |
| Rise, set, twilight and transits vs Skyfield | worst 0.22 s (Sun), 0.42 s (Moon), 0.26 s (planets) | 10 s |
| The same vs USNO (which rounds to the minute) | within 29.4 s | 1 min |
| Moon phases, equinoxes and solstices, 1990-2060 | within 1.1 s and 4.0 s | 1 min |
| Star field, 9,095 stars | apparent places within 0.0051′ of Skyfield | 0.1′ |
| Moon and planet sights, raw readings to Ho | 0.0063′ on the sphere (the Earth's-shape term, up to 0.22′ for the Moon, is not modelled) | ephemeris tolerance |
| Lunar distance, time recovered | within 2.1 s in every case | 5 s |
| Almanac pages | every angle within 0.0092′; 99.2 % of printed values exact | 0.1′, 1 min |
| Eclipses 1990-2060 | 320 of 320 found and typed as NASA's canon; greatest eclipse within 1.4 s (solar), 11 s (lunar); paths within 0.6 km; local contacts within 2.0 s of USNO | 2 min, 1 min |
| Planet events 1990-2060 | 2,266 of 2,266 matched one for one; within 55 s | 1 min |
| Navigation methods, stated sigmas | cover 92.5-97 % of seeded trials | ≈ 95 % |
| Sky view vs the engine | 58 navigational stars agree within 9″ | 0.01° |
| Speed in the browser | the whole sky (67 bodies) in about 1 ms | 2 ms |
| Download | the engine 851 KB gzipped; the offline copy 4.1 MB gzipped | 1 MB engine |

### Adversarial verification

An independent agent attacked the new engine code and fixed 17 defects, each with a
regression test. The serious ones gave confident wrong answers:

1. **Lunar distance** with only the Moon's altitude observed could lose the true root
   and return a time hours off with a sigma of seconds (7 of 22 validation cases).
2. **A noon sight from one maximum reading** took the declination at the wrong instant:
   1.29′ of latitude error for the Moon while claiming 0.10′; its sigma held 24 % of the
   time, now 96 %.
3. **Averaging a run of sights** applied a chronometer correction twice.
4. **A malformed request could panic** the WebAssembly module (72 fuzz cases).
5. **Six tests could never fail**; they now do.

A second agent verified the whole site in a browser and fixed what it found: the sight
planner re-planning twice a second while the time bar was dragged; white light leaking
into the night theme from date pickers and checkboxes; Navigate calling Hc "altitude"
where the Moon differs by 46′ from the height shown elsewhere; the Moon's rise and set
meaning different things on the map and in the panel; almanac pages printing on four
sheets instead of two; map drawings that could not be removed.

### Findings made along the way

- **The US Naval Observatory's online Moon runs late by an amount that changes with the
  epoch:** −2.4 s (2000), +4.9 s (2016), +10.3 s (2026), worth up to 0.11′ of GHA.
- **USNO and the Nautical Almanac give Venus's centre of light**, up to 0.41′ from the
  centre of its disc; the planet provider follows them.
- **Skyfield's planetary magnitudes place the Sun at the solar-system barycentre**,
  worth up to 0.21 magnitude for a thin crescent Mercury; and its light-deflection formula
  diverges for a planet behind the Sun (3.2′ at the 2029 Uranus conjunction).
- **NASA's path table for the 2021 Antarctic eclipse is 2.3 km off**; this engine is
  within 0.16 km of DE440s there.
- **Natural Earth's time-zone field had real errors** (Prague in America/Chicago); 41 are
  corrected by documented rules.
- **The Bright Star Catalogue lists the recurrent nova T CrB at its 1866 peak** (magnitude
  2.0); it is left out of the star field.
- **The official ELP/MPP02 lunar server refused every connection**, so the Moon uses
  ELP 2000-82B, which is within 0.72″ of DE440s through 2061.
- **One site deploy path broke silently:** the Pages runner's wasm-pack rejects
  `--profile`; the size-optimised build now goes through `CARGO_PROFILE_RELEASE_OPT_LEVEL`.

### Data licences

- **Stars:** NASA HEASARC's BSC5P, listed by data.nasa.gov as a U.S. Government Work; no
  credit is required. The 58 navigational stars keep their Hipparcos data and its
  acknowledgement, as decided in the first sprint.
- **Constellation figures:** drawn for this project, under its own licence.
- **Constellation boundaries:** the IAU's 1930 definitions (public domain); the digital
  copy came from CDS, which asks for an acknowledgement, given in `THIRD_PARTY.md` only.
- **Map and gazetteer:** Natural Earth, public domain, no credit needed.
- **The only on-screen credit** is "© OpenStreetMap contributors", shown only while the
  optional street layer is on, as OpenStreetMap requires.

### Decisions and deviations, stated

- The explorer replaced the old home page on 2026-09-24; the original workbench stays at
  `/classic/` until it is retired (`BACKLOG.md`).
- The WebAssembly budget is set on the download: 1 MB gzipped (851 KB now), with a
  2.5 MB ceiling uncompressed (2.06 MB now); the planned 2 MB raw budget was exceeded by
  embedded ephemeris data that compresses well.
- Sight reduction stays on the spherical Earth of CONVENTIONS section 1; the explorer's
  displayed heights and eclipse circumstances use the WGS84 ellipsoid. The Earth's-shape
  term in Moon sights (up to 0.22′) is documented, not modelled.
- Eclipse contacts ignore the Moon's limb profile (1-3 s) and assume ΔT stays at its
  current value for future eclipses.
- The residual heat map's raster layer on the live map is off; the contour lines are shown.

### How it was built

Planned and integrated by the main session (Claude Opus 5.5 after the owner switched
models from Fable 5.1), with 23 agents in separate git worktrees (26 runs, counting the
three that came back for a second phase): 22 on Opus, and the documentation agent on
Sonnet. About 260 commits. The repository now holds about 64,000
lines of Rust source and 26,000 of Rust tests, 61,000 of TypeScript and 13,000 of its
tests, 12,000 of CSS, 11,000 of Python reference tooling and 10,000 of documentation.

### Reproduce

```bash
cargo test --workspace
npm ci --prefix web && npm run wasm --prefix web && npm test --prefix web
npm run build --prefix web
web/scripts/pages-site.sh            # assemble the site exactly as the Pages workflow does
node web/scripts/ui-check.mjs        # the 191 browser checks
node web/scripts/offline-check.mjs   # the offline and upgrade checks
cargo run --release -p skyfix-cli -- eclipse 2024-04-08-solar --lat 32.78 --lon -96.80
mdbook build docs
```

## Part 3 — The original sprint (2026-09-23/24)

Sprint of 2026-09-23/24, planned and integrated by Claude Fable 5.1 with parallel Opus
engineering agents and one Sonnet documentation agent, from the brief in `BRIEF.md`.
This report is written to be checked: every number here can be reproduced with a command
listed in `ACCURACY.md` or `DEMOS.md`.

**Everything in this repository is a simulation and analysis tool. No real sextant sight
has been taken with it. Numerical agreement with reference data is not field accuracy.**

### What exists and works

- **Numerical core** (`skyfix-core`): units and conventions, sight reduction with the six
  correction steps reported individually, session validation with JSON and CSV round-trip,
  a weighted least-squares position solver with multistart and explicit ambiguity
  classification, and a-priori covariance with a nominal 95 % ellipse and conditioning.
- **Offline astronomy** (`skyfix-ephemeris`): the Sun (VSOP87D, 1020 terms) and the 57
  navigational stars plus Polaris (Hipparcos positions, IAU 2006 precession, IAU 2000B
  nutation, aberration), any date 1990-2060, no network; plus a dated fixture-pack provider
  that says "limited-date operation" in its coverage notes.
- **Simulator** (`skyfix-sim`): seeded, truth stored in a separate document, ten packaged
  scenarios covering the six required demos, and an experiment runner that compares true
  error with predicted uncertainty.
- **Command line** (`skyfix`): `validate`, `reduce`, `solve`, `simulate`, `experiment`,
  `demos`, `plan`, `catalog`, `coverage`, `convert`.
- **Browser workbench** (`web/` + `skyfix-wasm`): the same Rust core compiled to
  WebAssembly, every asset bundled, live at <https://holdthedoorhoid.github.io/skyfix-lab/>
  with the documentation book under `/docs/`. Observation editor, correction table,
  graticule plot with circles of position and the ellipse, residuals, simulator with the
  truth shown only there, and the planner.
- **Observation planner**: ranks bodies by the improvement they bring to the fix geometry,
  never by brightness, with the disclosures the brief requires.
- **Follow-up modules**, each a separate crate with its own document: the stationary camera
  sextant on synthetic images (`skyfix-camera`, `CAMERA.md`), the polarization compass
  laboratory (`skyfix-polar`, `POLARIZATION.md`), and motion with independent-estimate
  disagreement checks (`skyfix-motion`, `MOTION.md`).

### Test results

`cargo test --workspace` at the final commit: **687 tests, 0 failures** (native), plus
98 TypeScript unit tests in `web/` and a WebAssembly build of every numerical crate. CI runs
formatting, tests, the wasm32 build, an offline smoke test of the release binary inside an
empty network namespace, and clippy with warnings denied; it is green on `main`.

### Validation that matters, with the numbers

| check | result | where |
|---|---|---|
| Stars vs Skyfield (JPL DE421), 3364 cases 1995-2055 | worst 0.0011' | `ACCURACY.md` |
| Star apparent places vs ERFA/SOFA worked example | 0.016" | `THIRD_PARTY.md`, `crates/skyfix-ephemeris` tests |
| Sun vs Skyfield, 58 epochs | worst GHA 0.0026', Dec 0.0012' | `ACCURACY.md` |
| USNO celestial-navigation service cross-check | GHA/Dec agree to 0.0001' | `fixtures/reference/usno_celnav_2026-10-01T0130Z.json` |
| Clean five-star geometry recovers its truth | 0.000 m (geocentric), 6.2 m (topocentric, diurnal aberration) | `ACCURACY.md` |
| Monte Carlo coverage of the nominal 95 % ellipse, independent noise, 2000 trials | 95.1 % | `crates/skyfix-core/tests/solver_coverage.rs` |
| Same, with a shared bias on every sight | 42 % (the documented failure of the independent-noise model) | same |
| Native vs WebAssembly, 19 cases | position 1.3e-9 deg, covariance 3.2e-10 relative | verifier report, below |
| 10 000 sights, release build | solve 8.6 s (1.0 s without the global grid) | verifier report |

### The six required demos (all simulations)

Numbers from `skyfix experiment --demo <name> --repetitions 100`; details in `DEMOS.md`.

| brief item | scenario | what it shows |
|---|---|---|
| 1. Philadelphia star simulation with bodies above the horizon | `philadelphia-stars`, `philadelphia-stars-real` | coverage 0.97, error/sigma 0.96; real catalogue stars resolved by the ephemeris |
| 2. Good versus clustered geometry | `good-geometry`, `clustered-geometry` | the ellipse changes shape, not just size: 3.2 x 2.3 km at condition 1.4 becomes 9.3 x 1.9 km at condition 4.9 with a PoorGeometry warning |
| 3. One bad observation | `one-bad-sight` | the wrong sight stands out at 5 arcminutes normalised residual; robust weighting moves the fix from 6.6 km to 0.9 km of the truth and says the covariance is now approximate |
| 4. Shared clock offset | `clock-offset` | 60 s of clock error moves the fix 0.2507 degrees west with residuals of exactly zero |
| 5. Shared altitude bias | `shared-bias` | 24 sights, 3' bias: error 7.0 km against a predicted 231 m, ratio 30; coverage 0 % |
| 6. Single sight and two-sight ambiguity | `single-sight`, `two-sight-ambiguous` | a circle with no point; two candidates with equal weight and no promotion |

### Adversarial verification

An independent Opus agent was given only the instruction to break the physical-honesty
claims. It found and fixed four defects, all now on `main` with regression tests:

1. A duplicated record could defeat the two-circle guard and turn two circles that never
   meet into a "unique fix" with an absurd covariance. Fixed; the guard now counts distinct
   circles, not records.
2. A body name with trailing whitespace passed validation as the Sun but was then refused
   a direction and given the sidereal clock rate. Fixed.
3. Negative coordinates in the space-separated flag form were rejected by the argument
   parser. Fixed.
4. A lint failure on the newer compiler used by CI. Fixed.

It also reported three honesty gaps, then fixed them with tests in a follow-up: the
experiment's guard against a prior centred on the truth was exact-equality only (now a
radius of three sigma or one nautical mile); the experiment verdict had no lower bound on
the error-to-sigma ratio (now a two-sided band, and the sentence names the direction of
the miss); and `--require-unique` accepted a fix whose ellipse had been suppressed (now
exit code 3). Five message-level paper cuts were fixed at the same time. Its verdict: the physical-honesty requirements hold. One sight
is a circle; two crossing circles stay ambiguous from five initializers including the
antipode; a converged fix is bit-identical across initializers; the clock term grows the
east sigma by exactly the predicted amount and the north sigma not at all; no code path
estimates a clock offset; corrections cannot run twice; no demo session contains a truth
digit or its seed.

### Findings the agents made along the way

- **Advancing a line of position must be a rotation of the sphere.** Reusing the run's
  north/east components at the body's geographic position is wrong by 23 km; the motion
  module applies the run as a rigid rotation, exact at the linearisation point
  (`MOTION.md`).
- **The polarization 180-degree ambiguity is exact only for a zenith-only sensor.** A wide
  field genuinely separates the two headings except near Sun altitudes of 0 and 90; the
  module returns both candidates with a chi-square separation test and says which regime
  applies (`POLARIZATION.md`).
- **Refraction biases a camera-only attitude by about 2.8 arcminutes**, and more stars do not
  help; a local vertical is needed even to correct the sky for itself (`CAMERA.md`).
- **The 58-star catalogue holds one star in a 40-degree field** at the briefed pointing, so
  the camera experiment uses an 80-degree lens and records the deviation (`CAMERA.md`).
- **The USNO almanac service treats UTC as UT1**, which settles the project's DUT1 = 0
  convention; the up-to-0.23' it costs is reported as an external term, not hidden.

### Deviations from the brief, stated

- The brief said not to deploy externally; the owner asked for a public GitHub site, so the
  workbench is published with a permanent "not a navigation instrument" banner.
- The `rand` crate was dropped because its random-source dependency does not build for
  WebAssembly without extra configuration; the simulator carries its own seeded generator.
- The camera experiment uses an 80-degree field instead of 40 (above).
- The brief's Meeus solar example numbers were from the low-accuracy method (25.a); the Sun
  provider is tested tightly against the high-accuracy one (25.b) and loosely against 25.a.

### Decisions the owner made

- Keep the 58-row Hipparcos extract with attribution to ESA and CDS (`THIRD_PARTY.md`).
  A larger catalogue is a labelled backlog item, not a sprint deliverable.
- Opus for every engineering agent, Sonnet for documentation; build everything in the brief
  including the three follow-up modules; MIT OR Apache-2.0; Python + Skyfield allowed for
  development-time reference data only.

### What is simulated and what is real

Simulated: every observation in this repository, every demo, every camera image, every
polarization image, every track. Real: the astronomical models and their agreement with
independent implementations (Skyfield, ERFA, USNO), which is what the tests establish.
Nothing here has been used to fix a position from a real instrument.

### Backlog

`BACKLOG.md` lists every item as completed, partial or unstarted with the reasoning.

### Reproduce

```bash
cargo test --workspace
cargo build --release -p skyfix-cli
./target/release/skyfix solve fixtures/sessions/reference-philadelphia-5star.json
./target/release/skyfix experiment --demo shared-bias --repetitions 100 --out bias.csv
npm install --prefix web && npm run wasm --prefix web && npm run build --prefix web
mdbook build docs
```
