# Expansion programme — deep time, accuracy, astronomy and navigation features

## Outcome

All twelve wave-1 engines, all nine wave-2 interface packages and the wave-3 packages
(`verify2`, `docs3`, `polish2`, and `chip2` for the ± chip rule) are done (§5 below has each
one's status; two deviated from the plan by a recorded decision — no `deep-time` pack, and
P10's own object list rather than the official Caldwell catalogue). `verify2`'s adversarial
pass found 28 issues and fixed 21 on its own branch; the seven left for the planner are
recorded in §3 ("Verifier decisions 2026-09-25"). The planner's completion report, the full
account of what shipped against the owner's request in §1, is **Part 1 of
`docs/COMPLETION_REPORT.md`** (the redesign's report is its Part 2 and the original sprint's
its Part 3); `docs/BACKLOG.md`'s consolidated table records what is left.

Status: **plan, 2026-09-24**. Written by the planner (the main session, Claude Fable 5.1)
from the owner's interview of 2026-09-24 and three audits (accuracy and coverage, feature
inventory, data sources; the audits live in the planner's scratchpad and their findings are
folded into this document). Agents run on Claude Opus 5.5; documentation agents on Claude
Sonnet 5. The explorer redesign that this programme builds on is described in
`EXPLORER_PLAN.md`; the wire contract stays `EXPLORER_API.md`.

## 1. What the owner asked for

> "Further expand and improve on this project. … The Moon sights ignore the Earth's slight
> flattening: is that worth improving? Can we make it more accurate? We're fairly accurate
> so far, but what can we do to improve accuracy? I want to calculate out farther than 2060.
> Review the project and website and analyze for any features that are missing: useful to
> users, not only celestial navigation, but people interested in astronomy and similar
> events. Use Fable 5.1 for project management and Opus 5.5 for agent tasks."

### Decisions (interview, 2026-09-24)

| Question | Decision |
|---|---|
| How far in time | **2001 BC to AD 3000.** Full accuracy over 1550–2650, validated against JPL DE440 (which covers exactly that span). Outside it, a labelled *historical / far-future* band whose uncertainty (mainly the Earth's rotation, ΔT) is shown on screen and validated against NASA's Five Millennium Canons. Julian calendar before 1582-10-15. |
| Astronomy features | **All four bundles:** Tonight dashboard and deep sky; Moon and planets in detail; photography and Sun tools; calendar, export and sharing. |
| Navigation features | **All four bundles:** tides (US stations, NOAA); compass and magnetic variation; sailings and passage planning; sight extras. |
| Extra data | **Optional packs, small core.** The first visit stays about 1 MB. Each extra dataset downloads once when it is turned on (or needed) and is kept offline, like the street map today. |
| Models | Fable 5.1 plans and integrates; Opus 5.5 agents build; Sonnet 5 writes documentation. |
| Data credit | Unchanged from the redesign: credit-free data preferred (public domain, U.S. Government works, facts compiled by this project); a documentation-only acknowledgement when nothing credit-free exists; on-screen credit only as a last resort and only while the data is shown. |

### Accuracy decisions made by the planner (the owner asked "is it worth it?")

1. **The Earth's shape in Moon sight reduction: yes.** The term reaches 0.2′ (0.2 nautical
   miles), is systematic in latitude, and the exact WGS84 calculation already exists in the
   display path, validated to 0.7″. Sight reduction will use the exact topocentric position
   for the Moon (and, at no extra cost, the planets). See §4.
2. **DUT1 stops being assumed zero.** For past dates the true UT1−UTC is known (IERS) and
   ships with the core; for future dates a navigator can enter the value from the time
   signal, and the ±0.9 s of not knowing it is shown as ±0.2′ of longitude.
3. **ΔT gets a model with an uncertainty**, so that far dates carry an honest band instead
   of a fixed 69.184 s.
4. **Refraction near the horizon gets an uncertainty term**, since it is the one error a
   model cannot remove; it enters the sight weights and the planner's advice.
5. **The eclipse lunar-limb profile ships as an optional pack** if the data audit finds a
   credit-free, compact source (see §4); otherwise it stays in the backlog with the reason.

## 2. Gap analysis: what the site does today and what it lacks

The inventory (858 lines, in the scratchpad) found no feature that exists only half-way in a
way a visitor would notice, and a long list of things that do not exist at all. Grouped by
who would use them:

### 2.1 Anyone looking up

| Missing today | Where it goes |
|---|---|
| A "what is up tonight" summary: darkness window, Moon phase and its interference, planets, best deep-sky objects, meteor showers, the Milky Way, events soon | new **Tonight** view |
| Deep-sky objects (Messier and Caldwell) in the sky view and on lists, with when each is best placed | Sky view, Tonight |
| Milky Way in the sky view | Sky view |
| Search for any star or object by name; centre on it | Sky view, side panel |
| Right ascension and declination anywhere; an RA/Dec grid | Selected card, Sky view |
| Field-of-view circles (binoculars, telescope, camera), a magnitude limit / light-pollution control, atmospheric extinction | Sky view |
| Meteor showers (calendar, radiant, ZHR, Moon interference) | Events, Tonight, Sky |
| Lunar perigee and apogee, supermoons; Earth's perihelion and aphelion; planetary stations and retrograde periods; conjunctions of planets with each other and with the Moon | Events |
| Lunar occultations of bright stars and planets, with local disappearance and reappearance times | Events, Selected card |
| Transits of Mercury and Venus with local circumstances (today they are only flagged) | Events |
| The Moon in detail: libration, position angle, the terminator and named features on it tonight, distance and apparent size | Selected card, Sky inset |
| Jupiter's moons and Saturn's rings (an "eyepiece" inset), apparent diameters, central meridians | Selected card, Sky inset |
| Save the sky or a chart as an image; export tables as CSV; add events to a calendar (ICS) | Sky, Charts, Events |
| Dates before 1990 and after 2060; BC dates in the Julian calendar; the sky of antiquity with its uncertainty stated | everywhere (time bar, coverage) |
| Link to the manual and the source code from the site | About, Help |

### 2.2 Photographers and the Sun-minded

| Missing today | Where it goes |
|---|---|
| Golden hour and blue hour, on the time bar and the Sun card | time bar, Selected card |
| Alignment finder: on which days does the Sun (or Moon) rise or set at a given bearing, or stand at a given bearing and height | Sun tools |
| Milky Way planner: when the galactic core is up in darkness, its arch direction | Tonight, Sky |
| Analemma and sun-path diagrams, an azimuth-through-the-year chart, the equation of time | Charts → Sun |
| Solar-panel helper: clear-sky energy for a tilt and orientation, best tilt | Charts → Sun |
| "When is it at" for a bearing, not only a height | Selected card |

### 2.3 Navigators

| Missing today | Where it goes |
|---|---|
| Tides: next high and low water, a tide curve, printable tables (US stations) | Tides (Charts tab, map layer, Tonight line) |
| Magnetic variation anywhere, and compass error by the Sun's azimuth or amplitude | Selected card, Navigate → Compass, map |
| Sailings: great-circle and rhumb-line course and distance with waypoints, forward dead reckoning (course, speed, time), ETA, a DR track that feeds the running fix | Navigate → Passage, map |
| DUT1 and site elevation inputs; a control for the stored index correction | Navigate session, Place editor, Settings |
| Dip short (a shoreline closer than the horizon) | Navigate sight form |
| Star identification from a sextant altitude and bearing | Navigate |
| Almanac tables beyond the daily pages: increments and corrections, altitude corrections, Polaris, arc to time | Almanac |
| Printable sight-reduction worksheets and plotting sheets; a rotating star finder | Navigate, Almanac |
| An index-error and watch-error log | Navigate session |

### 2.4 Site and shell

Found by the inventory, worth fixing in passing: the About tab promises "the manual" but
nothing links to `/docs/`; no link to the repository; no 12-hour clock option; no Web Share
or install button; leftover "coming soon" machinery; `web/README.md` describes the old
bundle; the Sky view's highlight hook for tonight's stars is never called; the heat raster
stays off (contours remain). `/classic/` is retired in this programme: every capability it
had is in the explorer, and the redirect keeps old links working.

## 3. Principles, extended

The seven principles of `EXPLORER_PLAN.md` §3 stand. Three are extended:

- **Validated or labelled → tiers of coverage.** Every provider reports a *tier* for a date:
  `validated` (1550–2650: the accuracy figures in `ACCURACY.md` hold), `labelled`
  (2001 BC–1549 and 2651–3000: the figures in the historical table hold and the on-screen
  band says so), or `outside`. The UI never shows a number from the labelled band without
  the band's uncertainty beside it. Sights are offered only in the validated tier.
- **Module size (budget revised 2026-09-25).** The core module's budget is ≤ 1.25 MB
  gzipped and ≤ 3 MB raw (it was 1 MB / 2.5 MB). Nine of the eleven wave-1 engines took it
  from 849 KB to 1.13 MB gzipped (2.72 MB raw: 1.71 MB code, 1.01 MB embedded data). The
  levers measured on 2026-09-25: `panic = "abort"` and fat LTO save nothing, `wasm-opt -Oz`
  6 KB, `opt-level = "z"` about 5 % (130 KB raw, 46 KB gzipped); moving data out of the
  module does not reduce what a visitor downloads. The polish agent applies `opt-level =
  "z"` if the performance budgets hold and profiles the code with twiggy for cheap wins;
  the owner is told that the first visit is about 1.2 MB rather than 1 MB.
- **Decision 2026-09-25 (deep time landed).** Both tiers ship in the core, so there is no
  deep-time pack: the labelled tier (2001 BC–AD 3000, display only) is cut to 5″ per planet
  (Earth 0.3″) so the module fits the budget (2.78 MB raw / 1.24 MB gzipped after the merge,
  down from 3.12 MB / 1.28 MB, because the ephemeris tables became one 128 KB binary). The
  looser cut only affects the labelled tier's published figures (Venus 0.06′, Mars 0.15′,
  Neptune 0.06′) and is stated in ACCURACY. If the module grows past the budget again, the
  order of remedies is `opt-level = "z"` (polish), then moving the labelled tier into a pack.
- **Verifier decisions 2026-09-25 (VERIFICATION_2, findings left to the planner).**
  V13: a CI job now runs the web typecheck and tests against the built core. V24: the
  ELP/MPP02 lunar series stays: it is a published scientific solution (Chapront & Francou
  2003, A&A 404, 735) distributed by its authors without a licence statement, mirrored
  byte-identically with pinned hashes, and shipped as our own re-fitted, re-truncated binary;
  the acknowledgement is in the documentation, as the credit policy allows, and the residual
  risk (no explicit licence) is recorded in THIRD_PARTY. V25: the meteor-shower table stays:
  32 rows of published facts (IAU Meteor Data Center working list, IMO calendar) compiled and
  restated in our own form (solar longitude), acknowledged in the documentation; the residual
  risk (EU database right on a substantial extraction; ours is not substantial) is recorded.
  V18: adopted. The ± chip follows the quantity's real sensitivity to ΔT (VERIFICATION_2 §8):
  Sun rise, set, transit and twilight times carry no chip when ΔT moves them by under a
  second, the Moon's times carry the scaled value, phases, seasons and conjunctions carry the
  full σ, and the Moon's shown position at far dates gains a chip; CONVENTIONS 15.1–15.2 and
  every chip placement change accordingly (work package `chip2`). V26–V28 go to the
  documentation pass.
- **Offline first → optional packs.** Data beyond the core ships as packs under
  `web/public/data/packs/`, content-hashed, listed in a precached manifest, stored by the
  app in its own cache (`skyfix-lab-packs-<schema>@<site>`), never in the precache and never
  in the service worker's runtime cache. A pack is fetched when the person turns it on or
  when a view needs it (with a one-line prompt stating the size), kept until removed in
  Settings → Data packs, and versioned by the manifest. Every pack has a `load_pack` entry in
  WASM and a mock. Packs planned: `deep-time` (extra ephemeris terms outside the core band,
  if the audit shows they are needed), `tides-us`, `lunar-limb`, `deep-sky` (only if it
  outgrows the core; Messier and Caldwell are small enough to ship in it).
- **Honest uncertainty → time itself.** ΔT and UT1−UTC carry uncertainties; they propagate
  to event times, eclipse paths and longitudes and are displayed when they exceed the
  display precision.

New principle:

- **Plain words for new audiences.** An astronomy visitor sees "the Moon is 3 days from
  full and rises at 21:14", a photographer "golden hour 18:40–19:22", a navigator "variation
  11.5° W"; the navigator's-terms switch keeps working. Every new number has a sentence.

## 4. The accuracy and coverage programme

The accuracy audit (2026-09-24, in the planner's scratchpad as `audit-accuracy.md`, with its
measurement scripts under `audit/`) measured every limit against JPL DE440s and the complete
VSOP87 and ELP 2000-82B theories. Its numbers drive this section.

### 4.1 Why 2060 today, and what changes

The 1990–2060 window is written in about 15 places in Rust (provider constants, series
truncation thresholds, a stub ΔT), in every fixture generator, and in dozens of TypeScript
and CLI sites. The series tables themselves are not the obstacle: today's Sun and Moon
tables already hold 0.23″ and 0.57″ over 1550–2650. Three things are:

1. **The Moon theory's secular drift.** ELP 2000-82B was fitted to DE200; against DE440 it
   drifts as 0.12 + 0.39 t + 0.96 t² arcseconds (t in centuries from 2000): 18″ in 1550,
   43″ in 2650, 25′ at 2001 BC. Its mean-longitude polynomial (W1) is refitted to DE440 and
   DE441, or replaced by ELP/MPP02 if the data audit finds it reachable.
2. **No ΔT model.** TT − UT is frozen at 42.184 s before 1972 and at 69.184 s after 2026,
   so 1550 is 153 s wrong (the Moon by 1.4′) and 2001 BC by 13 hours.
3. **Calendars and time labels.** Julian dates before 1582-10-15, years before 1 AD and
   after 9999, "UT" instead of "UTC" outside 1972–2035, and year entry in the UI.

### 4.2 Tiers and what ships where

| Band | Tier | Where the tables live | Accuracy target |
|---|---|---|---|
| 1550-01-01 to 2650-01-22 (DE440's span) | `validated` | the core module | as today: Sun ≤ 0.3″, planets ≤ 2″, Moon ≤ 5″ (a few ″ after the W1 refit), stars ≤ 1″; sights offered |
| 2001 BC to 1549 and 2650 to AD 3000 | `labelled` | the `deep-time` pack | measured per century against DE441 and tabulated in `ACCURACY.md`; every time shown carries the ΔT uncertainty; no sights |
| outside | `outside` | — | refused, as today |

Core series after re-truncation over 1550–2650 (the audit's measured counts): Sun VSOP87D
1 454 terms (+32 KB raw), planets VSOP87A at a 1″ geocentric budget 3 949 terms (−88 KB),
Moon ELP 2 246 terms (+14 KB). The core module therefore gets slightly **smaller**. The
`deep-time` pack carries the wider truncations (Sun 1 944, planets 8 350, Moon 3 240 or the
ELP/MPP02 equivalent), the Vondrák-Capitaine-Wallace 2011 long-term precession, and nothing
else: about 300–600 KB raw in a binary encoding (24 bytes per term), fetched on demand the
first time the time bar leaves the validated band.

Two in-window corrections come with the series work: IAU 2000B nutation gets the full
polynomial fundamental arguments (its linear arguments err by 29 mas over 1550–2650 and
950 mas at 2001 BC; 3 mas after the change), and the navigational stars get radial
velocities (the perspective term reaches 26″ for Rigil Kentaurus by 2650).

### 4.3 Time scales

- **ΔT** = Stephenson, Morrison & Hohenkerk 2016 splines (−720 to 2016) joined to the IERS
  observed values (1962 onward, monthly) and, beyond both, to the long-term parabola
  −320 + 32.5 ((y − 1825)/100)² s, with a standard uncertainty: the published historical
  one where the splines apply, and the Huber/NASA growth law for the future (about 10 s in
  2060, 33 s in 2100, ±15 min in 2650, ±30 min in 3000; ±1 h at 2001 BC). The tables cost
  under 6 KB and live in the core.
- **The clock the app shows** is UTC between 1972 and 2035 (the last year leap seconds can
  occur), and **UT** (Universal Time, ≈ UT1) outside that span, labelled as such; TT follows
  from ΔT. Before 1961 UTC did not exist; after 2035 UT1 − UTC is unbounded.
- **DUT1** (UT1 − UTC) is no longer assumed zero: the IERS history ships in the core (weekly
  samples, 1973 to the build date, about 6 KB); for later dates a navigator enters the
  value from the time signal (session `clock.dut1_s`, CLI `--dut1`, a Navigate field), and
  the ±0.9 s of not knowing it is shown as ±0.23′ of longitude.
- **Calendars.** Julian calendar before 1582-10-15 for display and input, Gregorian after,
  labelled; a proleptic-Gregorian (ISO 8601) option in Settings; years shown as "585 BC"
  with the astronomical number (−584) in the tooltip; the wire format and the CLI use
  astronomical numbering with ISO expanded years (`-0584-05-28T…`). JD stays the internal
  scale. Before 1850 the default display zone is local mean time at the observer's
  longitude ("LMT"), because civil zones did not exist.
- **Saros numbering** is corrected for series below 28 (solar) and 12 (lunar), which the
  current modular rule misnumbers before about 1000 BC.

### 4.4 The Moon's Earth-shape term (decided: fix it)

Today `Ho` is reduced to the geocentric altitude on a sphere and the solver's `Hc` is
geocentric, so the flattening enters nowhere. Exact WGS84 geometry gives the omitted term
as `OB = HP·f·(sin 2φ·sin h·cos Z − sin²φ·cos h)` (f = 1/298.257), which the audit matched
to 0.0002′. Worst case 0.238′ at latitude 54.7° with the Moon on the meridian toward the
equator at 55°; median 0.05′ over random observable sights; Venus and Mars under 0.002′.

The fix goes into the **model Hc**, not the correction chain: `Sight` gains an optional
`moon_hp_arcmin`; the solver, `reduce_observation`'s intercept, `predict_sextant`, the noon
and Polaris methods, the planner and the misfit grid add the exact WGS84 term computed at
the trial position through `sights::wgs84`. The analytic Jacobian stays `[cos Zn, sin Zn]`
(the term moves by 1.2 × 10⁻⁴ of the main term per arcminute of position). `Ho` keeps its
meaning and the 1′ = 1 NM slope. The Nautical Almanac's own "OB" correction has the same
form with HP frozen at its mean; the docs quote it only after checking a printed copy.

### 4.5 Other limiters (ranked by the audit)

| Verdict | Item | Effect |
|---|---|---|
| fix | Rigil Kentaurus: Hipparcos' proper motion includes α Cen A's orbital motion (0.22″/yr), so linear extrapolation is about 6″ off now and 17″ (0.29′) by 2060 — invisible to Skyfield fixtures built from the same catalogue | verify against an orbit-aware reference (USNO API at a southern site, or a published orbit), then model A about the A–B barycentre |
| fix | DUT1 = 0 | ≤ 0.23′ on every body; unbounded after 2035 |
| fix | ΔT stub | see 4.3 |
| label | dip anomaly (air–sea temperature difference), anomalous refraction below 10°, deflection of the vertical, personal error | physical; the error budget in `ACCURACY.md` §4 gains rows, and the docs point to the shared-bias estimate as the remedy |
| guard | a sight time typed as `HH:MM` silently means `:00` (up to 15′ of GHA) | warn when seconds are omitted |
| leave | ellipsoidal distances (≤ 0.5 %), diurnal aberration (0.005′), polar motion (0.3″), IAU 2000A nutation, tighter in-window truncation, Bennett's residual (0.07′) | below sextant noise or physically limited |

### 4.6 Validation

- Generators take `--window` and `--kernel`; DE440s inside 1849–2150, DE440 over 1550–2650,
  DE441 (two parts, −13200 to +17191) outside. All three kernels are on disk.
- Fixtures record the ΔT model and calendar they assume, and build geometry in TT and UT1
  through the same ΔT function, so ΔT never counts as ephemeris error.
- Independent references over the full span: NASA's Five Millennium Canons of solar and
  lunar eclipses (−1999 to +3000, compared in TT), the Six Millennium catalogues of Moon
  phases and of transits of Mercury and Venus, Meeus's season formulas, USNO's services
  where they reach, Horizons (DE441) for spot checks.
- `ACCURACY.md` gains a historical table: worst error per century per body, validated
  band and labelled band separately, and the ΔT uncertainty per century.

## 5. Work packages

Same process as the redesign: every agent works in its own worktree and branch, commits,
never pushes; the planner merges. Agents run on Opus 5.5 unless marked Sonnet. Each Rust
agent owns its own crate or module and its own `skyfix-wasm/src/<name>.rs`, so parallel
work never collides in `lib.rs`; each adds one line to the pack registry or the CLI
dispatch, which the planner union-merges.

### Wave 1 — engines, data and the pack mechanism

Status column added by the documentation pass (docs3, 2026-09-25) from `docs/BACKLOG.md`'s
consolidated table and `docs/VERIFICATION_2.md`; every `done` package still carries open
enhancement rows of its own in the backlog, which this column does not repeat.

| # | Agent | Owns | Delivers | Acceptance | Status |
|---|---|---|---|---|---|
| P1 | `moonshape` | `skyfix-core` (types, reduce, solver, `sights/wgs84`, predict, methods), CLI `--dut1`, `skyfix-wasm::nav` | The Moon Earth-shape term in the model Hc everywhere (4.4); DUT1 through session, CLI, WASM and the TS session type; the seconds-omitted warning; error-budget rows | WGS84 Moon sessions within 15 m (from 60–80 m); Moon parallax vs USNO 0.004′; every existing test passes; goldens regenerated with review | done |
| P2 | `timescales` | `skyfix-core::{time, deltat, calendar}`, `skyfix-almanac::eclipses` ΔT hook, `skyfix-wasm::timescale`, CLI date parsing | ΔT model with σ; leap seconds and the DUT1 history; UT/UTC semantics; `time_info`; Julian/Gregorian/ISO calendars and BC years in core, CLI and the wire format; saros fix | ΔT within 1 s of Skyfield over 1973–2027 and within the published σ elsewhere; parse/format round-trips over −2000..3000; eclipse `delta_t_s` carries σ | done |
| P3 | `deeptime` | `skyfix-ephemeris` (series tables, frames, moon, planets, sun, stars), `tools/reference` generators, `skyfix-wasm::coverage` | Core re-truncation over 1550–2650; W1 refit (or ELP/MPP02); nutation arguments; star radial velocities and the α Cen orbit; long-term precession; the `deep-time` pack (binary format, loader, tables); coverage tiers in `explorer_coverage`; generators parameterised; fixtures per half-century; the historical accuracy table | per 4.2; core WASM no larger than today; the pack ≤ 600 KB raw | done, revised (§3): no `deep-time` pack — both tiers ship in the core module instead, a smaller total than the one-tier data it replaced |
| P4 | `geomag` | new crate `skyfix-geomag`, `skyfix-wasm::geomag` | WMM2025 and IGRF-14: declination (variation), inclination, intensity and annual change anywhere, 1900–2030; compass error by the Sun's (any body's) azimuth and by amplitude | within 0.01° of NOAA's and BGS's published test values; IGRF within 0.1° of NOAA's calculator | done |
| P5 | `tides` | new crate `skyfix-tides`, `tools/tides`, the `tides-us` pack, `skyfix-wasm::tides` | NOAA harmonic constants for every US tide-prediction station; harmonic prediction with nodal corrections; high and low water search; station index by distance | within 2 min and 5 cm of NOAA's own predictions for 20 stations over 30 days each; the pack ≤ 2 MB gzipped | done |
| P6 | `sailings` | `skyfix-core::{sailings, methods::starid}`, `corrections` horizon mode, `skyfix-wasm::sailings` | Great-circle, rhumb-line and composite sailings with waypoints; forward dead reckoning and ETA; dip short; star identification from altitude and bearing; star-finder chart data; index- and watch-error log in the session schema | Bowditch worked examples reproduce; identification recovers each of the 58 stars from its own Hs and Zn | done |
| P7 | `suntools` | `skyfix-almanac::{sun_tools, azimuth}`, `skyfix-wasm::suntools` | Golden and blue hour; `find_azimuth`; alignment finder; analemma, sun-path and azimuth-through-the-year series; equation of time; clear-sky irradiance and panel energy (labelled estimate); galactic-centre visibility windows | matches `sky_state` to 0.01°; the solar model within its stated bounds of a published clear-sky reference | done |
| P8 | `moondetail` | `skyfix-almanac::{libration, apsides, occultations}`, `skyfix-wasm::moondetail` | Libration and position angles; terminator geometry and named features on it (USGS gazetteer subset); perigee, apogee and supermoons; lunar occultations of planets and bright stars with local times | libration within 0.05° of Skyfield; occultation contacts within 30 s of Skyfield's topocentric geometry (mean limb, labelled); apsides within 2 min | done |
| P9 | `planetdetail` | `skyfix-almanac::{satellites, rings, transits, conjunctions}`, `skyfix-wasm::planetdetail` | Galilean moons; Saturn's rings; apparent diameters and central meridians; transits of Mercury and Venus with local circumstances; planet–planet and Moon–planet conjunctions; stations; Earth's perihelion and aphelion | moons within 1″ of Skyfield/Horizons; transits within 1 min of NASA's catalogue; conjunctions within 5 min of Skyfield | done; verify2 found the published 1″ held only near the present and made it a figure by era (0.5″ to 2040, 3″ outside 1600–2200) |
| P10 | `deepsky` | `skyfix-starfield::{dso, showers, milkyway, search, tonight}`, `skyfix-wasm::deepsky` | Messier and Caldwell (compiled facts, no credit); meteor showers; a Milky Way outline (per the data audit); the "tonight" ranking (darkness window, Moon interference, best-placed objects); a search index over stars and objects; extinction | coordinates cross-checked against two sources; visibility agrees with `sky_state` | done, revised: 110 Messier plus 103 others by the agent's own stated rule, not the official 109-object Caldwell catalogue |
| P11 | `packs` | `web/src/next/packs`, `web/src/sw`, `web/plugins`, `skyfix-wasm::packs`, `shell` fixes | The pack mechanism (manifest, app cache, worker route, Settings → Data packs, on-demand prompt); `load_pack` plumbing and mock; CI build of packs; links to the manual and the repository; install button; Web Share; 12-hour clock option; "coming soon" cleanup; `/classic/` retired behind a redirect | offline check passes; packs survive a worker update; the old share links still open | done |
| P12 | `eclipselimb` | `skyfix-almanac::eclipses::limb`, the `lunar-limb` pack | Lunar limb profile from a public-domain DEM ring; Baily's beads; contact-time corrections | only if the data audit finds a credit-free, compact source; otherwise recorded in the backlog with the reason | done: LRO LOLA LDEM_16 (NASA, public domain) found and shipped as the pack |

### Wave 2 — the interface

| # | Agent | Delivers | Status |
|---|---|---|---|
| Q1 | `time-ui` | Year entry and jumps, century and millennium steps, BC and Julian dates, UT/UTC labels, LMT before 1850, tier chips and ΔT uncertainty bands wherever a time is shown, the deep-time pack prompt, the About coverage table with tiers | done, revised: no deep-time pack to prompt for (P3); the tier notice and pack prompts work from the pack registry instead |
| Q2 | `tonight` | The **Tonight** view (a tab; About moves into Help): darkness window, Moon, planets, meteor showers, best-placed objects, the Milky Way, events soon, next tide where a station is near | done |
| Q3 | `sky2` | Search and centre; Messier and Caldwell symbols with click-to-identify; the Milky Way; RA/Dec grid; field-of-view circles; magnitude-limit and light-pollution control; extinction; meteor radiants; Moon and planet "eyepiece" insets (libration, terminator and features; Jupiter's moons; Saturn's rings); tonight's stars ringed; save as image | done |
| Q4 | `events2` | Apsides and supermoons, stations, conjunctions, occultations with local times, transits with local circumstances, meteor showers, ΔT uncertainty on far dates, ICS export | done |
| Q5 | `charts2` | A Sun tab (sun path, analemma, azimuth through the year, equation of time, solar panel); a Tides tab; Moon altitude and azimuth through the year; PNG, CSV and print for every chart | done |
| Q6 | `navigate2` | DUT1, site elevation and the index-correction control; a Compass tab (variation, compass error by azimuth and amplitude); a Passage tab (sailings, waypoints on the map, DR track feeding the running fix, ETA); dip short; star identification; printable worksheets and plotting sheets; the star finder; the error log | done |
| Q7 | `almanac2` | Increments and corrections, altitude corrections, Polaris and arc-to-time tables; multi-day pages; any year | done |
| Q8 | `photo` | Golden and blue hour on the time bar and the Sun card; the alignment finder; the Milky Way planner; "when is it at" a bearing; RA/Dec, variation and the next tide on the Selected card | done |
| Q9 | `cli3` | Command-line parity for every wave-1 engine | done |

### Wave 3 — release

`verify2` (adversarial verification of every new numeric path) — **done**: 28 findings (6
high, 8 medium, 14 low), 21 fixed on its branch, 7 left for the planner (§3 above records
the licence and CI decisions; V26–V28 went to `docs3`). `docs3` (Sonnet: guide, accuracy,
sources, backlog) — **done**: this pass. `polish2` (integration polish from the planner's
list) — **done**: 1 146 of 1 146 browser checks on the final build. The planner's
completion report is the one item here still to write, after this pass is merged.

## 6. Process rules

The rules of `EXPLORER_PLAN.md` §6 apply unchanged (worktrees under
`~/Desktop/skyfix-lab-wt/<name>` on `agent/<name>`, no pushes, fmt/clippy/tests, wasm32 build,
`npm run typecheck && npm test`, incremental compilation never re-enabled, Python only at
development time, every data source recorded in `THIRD_PARTY.md`). Two additions:

- Commit trailers: agents on Opus end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  Sonnet agents with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; the planner's
  own commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Reference ephemerides for validation live in `tools/reference/data/` (git-ignored):
  `de440s.bsp` (1849–2150), `de440.bsp` (1550–2650), `de441.bsp` (−13200 to +17191). Agents
  symlink that directory and the prepared `.venv` rather than downloading again.
