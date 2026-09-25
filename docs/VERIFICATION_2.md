# Verification of the expansion programme

The `verify2` agent's report (2026-09-25): an independent, adversarial check of everything
the expansion programme added, the eleven engines and the interface built on them. The
standard is the previous verifier's (`COMPLETION_REPORT.md`, "Adversarial verification"):
find what is wrong, fix it with a test that would have caught it, and record every
finding with its evidence. Branch `agent/verify2`, from main at the cli3 merge (1bff16e),
merged with polish2 before the interface pass.

Everything re-derived here can be re-run: the scripts are in `tools/verify2/` (each says
what it checks; run them from a scratch directory with the shared venv and the release
CLI), the references are listed in `THIRD_PARTY.md` under "Verification (verify2 agent)",
and every fix carries its test.

## 1. Summary

Every question the planner asked is answered in section 2. Twenty-eight findings (section 3):
21 fixed on this branch, each with a test that fails on the old code or a browser check, and
7 left for the planner: the web tests in CI, which clock times the ± chip belongs to, two
licence decisions and three documentation items. The interface pass ran on this branch merged
with polish2: polish2's 1 146 browser checks (UICHECK-FINAL), the verifier's own 75
(`web/scripts/verify2-check.mjs`), 105 web test files (1 611 tests), the Rust workspace
(1 548 tests, 14 ignored), clippy, fmt, the wasm32 build and the typecheck, all passing.

| severity | found | fixed in this branch | left for the planner |
|---|---|---|---|
| critical | 0 | 0 | 0 |
| high | 6 | 3 (V1, V14, V16) | 3 (V13, V24, V25) |
| medium | 8 | 6 (V2, V3, V4, V10, V11, V17) | 2 (V18, V26) |
| low | 14 | 12 (V5-V9, V12, V15, V19-V23) | 2 (V27, V28) |

Nothing found would give a navigator a wrong fix without warning: every sight path stayed
inside its published accuracy wherever it was re-derived. The high findings are a
published accuracy that was wrong over most of its dates (Jupiter's moons), every view
keeping the engine busy during fast playback, on-screen credits the programme's rules
forbid, the web test suite never running in CI, and two shipped data sets whose licence
basis awaits a recorded decision.

## 2. The planner's questions

### 2.1 Eclipse third contact: the offset is SVS's, not ours

Re-derived with a third implementation that shares only the lunar-limb pack's data:
Skyfield 1.55 with DE440s, the Moon's orientation from NAIF's DE440 lunar kernels
(`MOON_ME_DE440_ME421`, at the light's departure), the ring decoded by a separate Python
reader from EXPLORER_API's format, every node projected gnomonically about the Moon's
centre, the silhouette as the largest radius in each 1/16° of position angle, and second
and third contact as the zeros of "the Moon's radius minus the Sun's farthest point" over
all position angles (its negative for annularity). `tools/verify2/eclipse_contacts.py`.

| | 2024-04-08, 29 cities | 2023-10-14, 19 cities |
|---|---|---|
| this implementation minus the engine, c2 / c3 | mean −0.15 / −0.14 s, worst 0.44 / 0.40 s | mean +0.10 / −0.09 s, worst 0.33 / 0.25 s |
| this implementation minus SVS, c2 | **+0.21 s** (sd 0.45) | **+0.05 s** (sd 0.37) |
| this implementation minus SVS, c3 | **−1.07 s** (sd 0.49) | **−1.19 s** (sd 0.35) |
| the same with Delta T 1 s larger, c2 / c3 | −0.22 / −1.34 s | −0.30 / −1.42 s |

The eclipselimb agent's own independent code (Skyfield + the raw LDEM_16 grid) found
−1.38 s and −1.16 s for third contact. Three implementations agree on the geometric
contacts to half a second, and all three put SVS's third contact about 1.1 s later and its
second contact where ours is. That pattern, the same in the total and the annular eclipse,
rules out the candidates one by one:

- **Delta T.** A second of Delta T moves both contacts together, by 0.35-0.45 s, and the
  central phase by only 0.15 s. SVS item 5073 states no Delta T. NASA's eclipse pages state
  Delta T = 74 s (2024) and 73.7 s (2023) for their Besselian elements, the Canon's
  extrapolation; with those, SVS's contacts would be about 1.9 s *earlier* than ours at
  both contacts, and they are later. SVS's mean time is 0.43-0.57 s later than ours:
  whole seconds taken at or after each event give that, or a Delta T about a second below
  the observed 69.2 s.
- **A radius.** A smaller Sun or a larger Moon lengthens totality but shortens annularity;
  SVS's central phases are longer in both.
- **The limb's resolution.** SVS's 60 m topography has deeper valleys and higher peaks than
  LDEM_16's 1.9 km, which shortens both central phases; SVS's are longer.

What remains is SVS's own definition: "the 100 % points of coverage (normalized with
respect to the maximum coverage achieved)", to the whole second, from umbra shapes at
one-second steps. A threshold on coverage near one part in 10⁵ of the Sun's area, or a
whole-second convention, lengthens the central phase at its ends. It cannot be confirmed
without SVS's code; ACCURACY 19 now says so with these figures.

### 2.2 Tides at Anchorage: a convention, now fixed

NOAA's hourly predictions for all of 2026 and 2027 (the CO-OPS API) against the engine:
7.3 mm rms, and a least-squares fit at the 120 constituents' speeds puts **all of it at
σ1's speed** (10.0 mm, 21 % of σ1's 47 mm), leaving 0.29 mm, NOAA's millimetre rounding.
Solving for NOAA's own σ1 term: f = 1.3616 and u = −8.03° in 2026, 1.2927 and −13.24° in
2027, which are f(O1)² and 2u(O1) to 0.0002 and 0.07°. NOAA treats σ1 as the compound
**2O1 − P1**, whose V (T − 4s + 3h + 90°) and speed are exactly Schureman's A20; only the
nodal factor and angle differ. Fixed in `schureman.rs` (b04cc32): Anchorage's high and low
waters now within **0.19 cm** of NOAA's (1.08 before), the curve within **0.45 cm** (1.38),
the year's residual 1.9 mm rms; the 3-day sweep of 3 492 stations within 0.59 cm (0.99).
What is left, about 0.1 % of M2, N2, M4 and M6, is a steady +0.039° on M2 in both years:
NOAA predicting from its unrounded constants while publishing phases to 0.1°.
`tools/verify2/tides_year.py`, `sigma1.py`, `m2_round.py`.

### 2.3 Deep-time tiers: the band against the Five Millennium Canon

Engine against the Canon (Espenak & Meeus 2006: NASA's polynomials, corrected to the
Canon's −25.858″/cy²; σ as NASA's "Uncertainty in ΔT" page gives it),
`tools/verify2/dt_canon.py`:

| epoch | engine Delta T ± σ | Canon | difference | in σ |
|---|---|---|---|---|
| −2000 | 47 228 ± 3 732 s | 46 472 ± 3 732 s | +755 s | 0.20 |
| −500 | 16 939 ± 150 s | 17 125 ± 431 s | −186 s | 1.24 (engine's), 0.43 (Canon's) |
| 1000 | 1 650 ± 15 s | 1 562 ± 54 s | +88 s | 5.9 (engine's), 1.6 (Canon's) |
| 2999 | 4 159 ± 1 815 s | 4 414 ± 1 882 s | −255 s | 0.14 |

- At the ends the engine's σ is Huber's, as NASA computes it (3 732 s at −2000; 1 815 s at
  2999, counted from 2026 rather than 2005), and the two Delta Ts agree to a fifth of it.
- Between −720 and 1600 the engine's σ is SMH 2016's published error, three times smaller
  than Morrison & Stephenson (2004)'s that the Canon used, and the two curves differ by up
  to 186 s (AD 1200, 12 of SMH's σ): a revision in the literature, not an error here. But
  the ±15 s of AD 1000-1600 is SMH's formal error, and below 30 s the interface shows no
  chip; a reader comparing with NASA's eclipse pages for those centuries will find
  differences of one to three minutes.
- Before −720 the value is the long-term parabola (as Skyfield's), not SMH 2020's own
  table (46 000 ± 1 000 s at −2000): 1 228 s apart, inside the σ shown (3 732 s, larger than
  that table's).
- Delta T and σ are continuous across every join (−1520, −720, 1973, 2027-09-28, 2800);
  TT − clock steps by −0.04 s at 1972-01-01 and +1.54 s at 2036-01-01 (CONVENTIONS 15.2).
- **The Moon's secular acceleration.** SMH (2016, §2) adopt −25.82″/cy², the value implicit
  in DE430, and say their Delta T "should be used in conjunction with" DE430; the docs said
  −25.85″/cy². The pairing still holds because the engine's Moon is refitted to
  DE440/DE441; a Δṅ of 0.03″/cy² is 43 s of Delta T at 2000 BC (1 % of σ) and 2.5 s at AD
  1000. Corrected in ACCURACY 21 and THIRD_PARTY.
- **The ± chip** shows the engine's σ, re-checked on the merged build (verify2-check, chip group,
against `skyfix time-info`): ±1 h at 2001 BC (σ 3 729.9 s), ±2 min at 501 BC (149.9 s), ±15 s
at AD 1000 (15.0 s, shown because the date is in the labelled tier), none at 1600 (15.0 s,
validated, under the 30 s the chip waits for) or in 2026, ±30 min at AD 2999 (1 815.7 s).
Every labelled date carries it. Which clock times should carry it is another matter
(section 8, V18).

### 2.4 Playback at 10 years a second

Not before this pass: every view kept the engine busy while time ran faster than eight days
a second. `web/scripts/verify2-check.mjs` (its playback group) profiles each view for four
seconds at an hour and at ten years a second in its own headless Chrome, and counts every
call into the core by export: the glue's instance exports are wrapped in counters before
any page script runs, and an unminified build names the callers in the profile.

On main at 1bff16e (minified) 50-78 % of each view's busy time went into WebAssembly at ten
years a second, 25-360 ms of engine a frame. The profile named the callers: the side panel
first, on every view (the Selected card's Moon asked 64 days of phases for every new day, a
new day every frame; its tools' settle timers fired between two slow frames and asked the
Moon's apsides, orientation and features; tonight's sights made a plan every five
seconds), then the views of their own (Tonight chose a night every frame, asking the day's
events, and remade it every four seconds; the day chart sampled every new day and the charts
on the chart shell recomputed every 0.7 s; the Almanac made an opening every few seconds and
its yearly tables ten times a second; the Map and the Sky view, which polish2 fixed in its
list item 18). Each now keeps what it shows, dimmed where it is a tool, while
`fastPlayback` is true, and catches up once time slows, as the Events lists already did
(892c359, eaa7719, 902e51a).

After, on this branch merged with polish2 (unminified, 2026-09-25, a quiet machine, headless
Chrome drawing in software), four seconds of each view at ten years a second:

| view | frames | median / p95 frame, ms | calls into the core in 4 s | engine a frame, ms |
|---|---:|---|---|---:|
| Map | 75 | 33.4 / 133 | time_info 152, sky_state 91, tier_at 76, tide_pack_info 76, packs 76 | 0.73 |
| Sky | 11 | 150 / 667 | sky_state 32, time_info 24, tier_at 12, tide_pack_info 12, packs 12, sidereal 12 | 2.45 |
| Tonight | 129 | 33.3 / 33.4 | time_info 260, sky_state 146, tier_at 130, tide_pack_info 130, packs 130 | 0.61 |
| Charts | 71 | 50.1 / 83.3 | sky_state 158, time_info 144, tier_at 72, tide_pack_info 72, packs 72 | 1.36 |
| Events | 122 | 33.3 / 50 | time_info 246, sky_state 139, tier_at 123, tide_pack_info 123, packs 123 | 0.57 |
| Almanac | 127 | 33.3 / 33.4 | time_info 256, sky_state 144, tier_at 128, tide_pack_info 128, packs 128 | 0.61 |
| Navigate | 128 | 33.3 / 33.4 | time_info 258, sky_state 145, tier_at 129, tide_pack_info 129, packs 129 | 0.63 |

Every view now asks only for the positions it draws and the clock's chip, tier and pack
status, a microsecond or two each apart from `sky_state` (about 1 ms, section 9); before,
the same four seconds held 1.4-2.4 s of engine work. The frame times are the headless
browser's: it paints canvas and WebGL in software (30 frames a second at best here, and the
Sky view's full-screen canvas 150 ms a frame whatever the speed, where its draw itself takes
5 ms, section 9); on a screen with a GPU they are set by the draw.

At an hour a second (not fast playback) tonight's sights were planned every second, 100-150 ms
each, because the plan's settle timer was armed only when the hour changed; on slow frames
the same at any speed. Now at most one plan in five seconds while time plays (2b60961,
902e51a); the check counts none in the four seconds profiled on every view.

### 2.5 The memoised engine

`memoEngine` (`web/src/next/component.ts`) is sound as used. Every mutation the engine has
(`setDut1`; `loadPack`) clears the caches: `setDut1` by the prefix rule, pack loads through
`main.ts`'s `onLoaded` (packs go into the unwrapped engine, then `invalidate()`), and the
charts' developer harness likewise. No view mutates the engine any other way. Two latent
faults, fixed in the interface pass: the wrapper's own `loadPack` does not clear the caches
although the comment beside the prefix rule says it does (the rule skips names already on
the wrapper), so a future caller of `ctx.engine.loadPack` would read stale answers; and the
pass-through key is `JSON.stringify` of the arguments, which writes NaN, Infinity and
−Infinity as `null`, so `f(NaN)` could be served `f(null)`'s cached answer instead of the
engine's error. Both fixed (f86ca4b): the wrapper's `loadPack` clears the caches, and
non-finite numbers (and BigInts, which `JSON.stringify` cannot write) get keys of their
own; the two tests fail on the old code.

### 2.6 Almanac tables against the printed book

Each of the ten differences was recomputed independently (`tools/verify2/almanac10.py`,
`moon_table.py`), first with the project's chain (Bennett's refraction, the book's two
semidiameters, the Moon's upper part at HP 57.7′: all ten of the project's values
reproduced, so the tables compute what CONVENTIONS 13.9.1 defines), then with a rigorous
refraction (a ray trace through a standard atmosphere at 10 °C and 1010 hPa, dry air at
0.574 µm, `refraction.py`, which matches ERFA's `refco` to 0.001′ from 10° to 67° and
Bowditch's quoted 5.3′ at 10° and 2.6′ at 20°).

- **Refraction explains four, and a fifth goes the right way:** the stars at 27° 48.1′
  (rigorous −1.825′: printed −1.8), the Sun October-March at 6° 29.7′ (+8.431′: +8.4), the
  stars at 4° 02.1′ (−11.600′: −11.6) and the temperature-and-pressure correction at
  1° 19.7′ (+1.542′: +1.5); the Sun April-September at 1° 19.7′ moves from −5.94′ to
  −5.73′, past the printed −5.8′. Bennett's formula reads 0.04-0.07′ higher than a rigorous
  refraction between 5° and 30° (EXPANSION_PLAN 4.5 leaves it as "Bennett's residual").
- **The five Moon entries are not refraction.** A rigorous refraction moves every upper
  part further from the book (56.26, 62.67, 33.17, 52.38 against 56.1, 62.5, 33.1, 52.2);
  a Moon radius of 0.2724 moves them by 0.006′. The printed upper part runs 0.05-0.16′
  below the project's at every altitude checked, 2° 30′ to 66° 40′, and its lower part
  mostly agrees; an upper part at HP 57.6′ reproduces all four printed upper parts but
  misses three of the four printed L and U. The printed table splits the correction its
  own way, which Bowditch does not document; what a navigator adds up (upper plus lower
  part) is within 0.13′ of the exact chain in the project and within 0.08′ in print.

None is a bug. The stated reason for the Moon rows was not borne out and is corrected in
ACCURACY; the comparison test now pins exactly these ten and the 36 identical values
(it asserted "at least 70 % identical").

### 2.7 BC eclipse ids, and every other id

`eclipses::date_of` took the first ten characters of the wire timestamp (`-0584-05-2`),
and the id parser refused any signed year. Both fixed (33643f0): the date part is taken up
to the `T`, and ids parse with `time::parse_date_in`, keeping the canonical-spelling check.
Transit ids had the same `[..10]` cut and now use `sun_tools::local_date`. Both engines
answer only inside 1990-2060 and 1550-2650 today, so this was latent. The other id builders
were checked for negative years: the interface's (`events/link.ts`, `moon-model.ts`,
`planet-model.ts`, `items.ts::utcDate`) already cut at the `T`; occultations, showers,
stations and conjunctions build no date-string ids in Rust. The mock's transit id
(`mock/planetdetail.ts`) still slices ten characters (mock only). Test:
`eclipses::verify2_ids` (fails on the old code with `-0584-05-2`).

### 2.8 The deep-time findings

- **(i) Jupiter's moons.** The engine published `accuracy_arcsec = 0.5` for every date of
  1550-2650. Against JPL Horizons at 400 instants of 1600-2200 (new fixture
  `galilean_horizons.json`, generator `tools/reference/gen_galilean_horizons.py`), Lieske's
  E5 is within 0.40″ in 1900-2040 but 0.88″ in 2040-2100 (0.67″ by 2057; at 2047-11-20
  04:47 UT Callisto is 0.551″ off, where Skyfield with jup365 and Horizons agree to
  0.000″), 0.72″ in 1800-1900, 1.27″ in 1600-1800 and 1.20″ in 2100-2200. Twelve instants in
  each of the planetdetail agent's own jup365 excerpts give Ganymede 1.43″ at 1650, not
  0.89″: one instant per excerpt missed the worst phases. Fixed (38f99a5): the figure is
  now `satellites::accuracy_arcsec_at`, 0.5″ (1900-2040), 1″ (1800-1900, 2040-2100), 1.5″
  (1600-1800, 2100-2200) and 3″ outside 1600-2200, where no JPL satellite ephemeris exists
  and the figure is an extrapolation. `tests/galilean_horizons.rs` holds all 1 600
  moon-instants to the figure for their date. The Sky view's Jupiter close-up then said
  "within 3.0″ of JPL" for dates no JPL ephemeris of the moons reaches; it now says "to
  about 3.0″, an estimate" there, with the years JPL covers (bd0701a).
- **(ii) The NASA transit rows are misprints, confirmed.** NASA's Mercury catalogue prints
  1891 May 10 as `23:57 23:57 02:22 04:47 04:47` and 2282 Nov 15 as `23:41 23:41 … 05:02
  05:02`. Neither transit grazes. Skyfield with DE440 at the engine's Delta T gives 1891:
  I 23:54:11, II 23:59:10, III 04:44:06, IV 04:49:05 (the engine within 1 s of each) and
  2282: I 23:44:02, II 23:45:46, III 05:05:24, IV 05:07:07 (within 1 s). Each printed pair
  is the midpoint of the true pair, printed twice (for 2282 once NASA's Delta T, 250 s
  larger, is allowed for). Recorded in ACCURACY 17. `tools/verify2/transit_rows.py`.
- **(iii) The occultation track near a coverage end: fixed.** Within three days of 1550-01-01
  or 2650-01-22 the Moon's eight-point interpolation stencil cannot be centred and errs by
  0.03-1.9 km with the Moon's anomaly (about 1″, 2 s of contact), against 0.1 km elsewhere.
  `MoonTrack` now keeps its provider and takes the exact place there (88607d5); windows away
  from the ends keep their four-day margins and never take that path. The edge test held
  the old error under 2.5 km; it now holds both ends exact.
- **(iv) Rigil Kentaurus: the orbit is closer to the sky, by a factor of about 40.** ALMA
  measured α Cen A's absolute ICRS position nine times in 2018-2019, referred to quasars
  (Akeson et al. 2021, Table 2; 0.4-7 mas). With annual parallax added, the engine's orbit
  model is **0.10-0.12″** from every one; the straight line the Nautical Almanac and USNO
  extrapolate is **4.4-4.6″** off. Against Akeson et al.'s own barycentre and orbit the
  engine is 0.15″ off in 2026 and 0.39″ in 2060 (the barycentric proper motions differ by
  5 mas a year), the straight line 5.9″ and 16.4″. New test `tests/acen_alma.rs` (orbit
  within 0.25″, line beyond 4″); the guide's Almanac section now tells a navigator to expect
  about 0.1′ against the printed book in 2026 and 0.3′ by 2060, and why.
- **(v) Mars, Jupiter and Saturn inside 1990-2060:** 0.0067′, 0.0084′ and 0.0122′ (GHA,
  the regenerated fixtures), inside the 0.02′ each publishes. A sweep of every second
  closest approach of Mercury to Saturn over the whole validated tier (3 372 cases, DE441,
  `validated_sweep.py`) stays inside every published figure: Mercury 0.0011′, Venus
  0.0023′, Mars 0.0131′, Jupiter 0.0095′, Saturn 0.0122′ (worst of RA and Dec).
- **(vi) The labelled tier's 5″ cut.** Against DE441 in a frame independent of the
  project's `ltp.py` (ERFA's long-term precession and IAU 2000A nutation), Venus, Mars and
  Neptune at −1500 and 2900, closest approaches and random instants: 1.38″, 4.25″, 1.04″
  and 0.30″, 2.61″, 0.56″ (`labelled_cut.py`). Then every second closest approach of
  Mercury to Saturn over the whole labelled tier, 11 955 cases (`labelled_sweep.py`):
  Mercury 0.0171′, Venus 0.0466′, Mars 0.1090′, Jupiter 0.2153′, Saturn 0.5925′, each inside
  the published 0.02′, 0.06′, 0.15′, 0.25′, 0.7′. The historical table's 20 random epochs
  per bin miss closest approaches, where a heliocentric error shows largest (Venus 2.25″ in
  1800-1700 BC against the table's 0.67″; Mars 5.93″ in 1100-1200 against 4.14″): the
  per-bin figures are a sample, not a bound, and ACCURACY 21 now says so.

## 3. Findings

Severity: **high**, a published figure or rule broken where a user sees it, or a gap that
lets a claim go unchecked; **medium**, a wrong or unverified figure a user would rarely meet,
or a licence condition; **low**, latent, wording, or documentation. "Fixed" commits are on
`agent/verify2`, each with a test that fails on the old code (or a browser check where the
behaviour is the page's).

| # | sev. | finding | where | evidence | fix, or why not |
|---|---|---|---|---|---|
| V1 | high | Jupiter's moons published 0.5″ for every date; E5 is 0.88″ off by 2100, 1.27″ in the 1600s (Ganymede 1.43″ at 1650), and the close-up said "within 3.0″ of JPL" where no JPL ephemeris of the moons exists | `skyfix-almanac/src/satellites.rs`; `web/src/next/sky/upclose.ts` | JPL Horizons, 400 instants 1600-2200 (2.8 (i)) | fixed 38f99a5 (the figure by era, test against Horizons), bd0701a (the close-up's words) |
| V2 | medium | Tides: σ1 taken as an elementary constituent; NOAA's is the compound 2O1 − P1 | `skyfix-tides/src/schureman.rs` | Anchorage 1.08 → 0.19 cm, curve 1.38 → 0.45 cm; sweep 0.99 → 0.59 cm (2.2) | fixed b04cc32 |
| V3 | medium | A meteor radiant's solar longitude interpolated in a straight line between the engine's instants: 0.146° off for the Southern Taurids, published "within 0.05°" | `web/src/next/sky/meteors.ts` | Meeus ch. 25 λ☉ | fixed fc26f59 (a parabola through three, within 0.003°) |
| V4 | medium | The navigation exports ignored the explorer-wide DUT1 (`set_dut1`) that the contract and Navigate's own note promise to a session without its own | `skyfix-wasm/src/nav.rs`, `navsky.rs` | contract audit A | fixed 68804cf (latent: no view sets it today) |
| V5 | low | The occultation search's Moon track within three days of a coverage end: an off-centre stencil, 0.03-1.9 km (1″, 2 s of contact) | `skyfix-almanac/src/occultations.rs` | the edge test's own figures | fixed 88607d5 (the exact place there) |
| V6 | low | BC eclipse and transit ids cut to `-0584-05-2`; eclipse ids with a signed year refused | `eclipses.rs`, `transits.rs` | 2.7 | fixed 33643f0 (latent: both engines answer 1990-2060 and 1550-2650) |
| V7 | low | `almanac_increments` read 58.7 as 58 and NaN as 0; the altitude tables' conditions took unknown keys | `skyfix-wasm/src/almanac_tables.rs`, `tables/altitude.rs` | contract audit B | fixed 9f54859 |
| V8 | low | ACCURACY: the Moon's secular acceleration (SMH adopt −25.82″/cy², not −25.85); the historical table's per-bin figures are a sample, not a bound; Moon-in-detail figures stale on the two-tier Moon; the reason given for the Moon rows of the almanac tables' ten differences; the NASA transit misprints; third contact against SVS | `docs/ACCURACY.md` 17, 19, 21, "Moon in detail", "Almanac tables" | 2.1, 2.3, 2.6, 2.8 | fixed 5c87684, c3fc665 (verify2 blocks) |
| V9 | low | Rigil Kentaurus follows α Cen A's orbit and differs from the printed Almanac by 0.1′ (2026) to 0.3′ (2060); the guide did not say so | `docs/EXPLORER_GUIDE.md` | ALMA (Akeson et al. 2021): the orbit 0.10-0.12″, the Almanac's line 4.4-4.6″ | fixed 4b14100 (guide, `acen_alma` test) |
| V10 | medium | Tests far looser than the figures ACCURACY publishes, or unable to fail: star identification (1000× the claim), shower dates (a day either side), the conjunction timing assertion (dead), the tides' flat-turn allowance and a self-written exclusion list, occultations (30 s), apsides (2 min, 10 km), libration (0.05°), the sun tools (36″), the compass (0.001°), the almanac tables (a comparison that switched itself off), the lunar limb's graze count | 14 test files in `crates/` | the test audit (section 5) | fixed d8d127c, 79c7c7b, b04cc32 |
| V11 | medium | Seven web tests on the built core returned early, and so passed, when the package lacked the export they check | `web/test/next/navigate-*.test.ts`, `sailings-engine`, `sky2-layers` | the test audit | fixed 386964f (`skip()`) |
| V12 | low | ACCURACY 20's Milky Way figures were asserted as "under the 32° grid" and not measured | `web/test/next/sky2-layers.test.ts` | measured: \|b\| ≤ 27.81°, straight edges within 0.0575° of their arcs | fixed 136a1af (the claims hold) |
| V13 | high | No workflow runs the web tests: the real-engine checks behind a dozen ACCURACY rows run only on agents' machines | `.github/workflows/` | `ci.yml` runs `cargo test`; `pages.yml` one Rust filter | left for the planner (a CI job; section 5) |
| V14 | high | Fast playback: at 10 years a second every view spent 50-78 % of its busy time in the engine. The Selected card asked 64 days of Moon phases for every new day and its tools' settle timers fired between slow frames (apsides, orientation, features); tonight's sights planned every 5 s; Tonight chose a night every frame and remade it every 4 s; the day chart sampled every new day and the other charts recomputed every 0.7 s; the Almanac made an opening every few seconds and its yearly tables ten times a second (Map and Sky: polish2) | `panel/selected.ts`, `navigate/tonight.ts`, `tonight/view.ts`, `charts/*`, `almanac/almanac.ts` | CPU profiles and exact call counts (2.4) | fixed 892c359, eaa7719, 902e51a: every view now asks only for the positions it draws |
| V15 | low | At an hour a second tonight's sights (100-150 ms) were planned every second, and on slow frames at any speed | `navigate/tonight.ts` | call counts | fixed 2b60961, 902e51a (at most one plan in 5 s while playing) |
| V16 | high | On-screen credits the programme forbids: "Source: Minor Planet Center" on the example (whose values were the MPC's) and on every pasted MPC body; the deep-sky card's Source section; "Shower table: …"; the gazetteer under the Moon close-up; the Bright Star Catalogue in the saved picture; "Map data: Natural Earth"; About's credits line | `sky/custom.ts`, `layers-menu.ts`, `sky/view.ts`, `upclose.ts`, `events/showers.ts`, `map/controls.ts`, `about/view.ts` | the licence audit (section 10) | fixed be7670e (the example now JPL SBDB's), a9c85c8 (a source scan) |
| V17 | medium | The typefaces' SIL OFL text did not ship with the fonts (the woff2 files keep the copyright and a licence URL, not the licence) | `web/public/`, `vite.config.ts` | name tables read with fontTools | fixed 40dcb18 |
| V18 | medium | The ± chip at far dates marks rise, set, transit and twilight times with the whole Delta T uncertainty, which moves them by under a second (Sun) or a few seconds (Moon); positions at the time shown (the Moon's, 1.4′ at 585 BC, 34′ at 2000 BC) carry none | CONVENTIONS 15.1-15.2; every chip | Skyfield, DE441 (section 8) | left for the planner (a rule to change, not a line) |
| V19 | low | Far-date words: the Now section said "Sun sights are possible now" at 585 BC; Tonight's Moon note denied the distance its card showed; Jupiter's close-up printed the engine's message (ISO dates and a Julian day) | `panel/now.ts`, `tonight/data.ts`, `sky/upclose.ts` | the farlook group | fixed aeb6575, 95c5ca2 |
| V20 | low | A planet's occultation times are its centre's; the sentence gave the disc's crossing for the disappearance only and did not say so | `events/moon-model.ts` | Skyfield: the engine's crossing times to 0.1 s | fixed 0e7d377 |
| V21 | low | Settings → Air reached every refraction but the Almanac's Table A4 form | `almanac/almanac.ts` | the air group; engine side 0.944′ / 0.915′ / −0.943′ | fixed 0de4cd5 |
| V22 | low | `memoEngine`: its own `loadPack` kept the caches; NaN, ±Infinity and null shared a key | `web/src/next/component.ts` | 2.5 | fixed f86ca4b (latent) |
| V23 | low | The adapter doubled planet detail's and geomag's error prefix (a test pinned it); `conditionsJson` sent tonight's `limit` to exports that refuse unknown keys | `web/src/next/engine/wasm.ts` | contract audit B | fixed 79fb982 |
| V24 | high | ELP/MPP02 ships in `series.bin` with no licence stated, from a third-party mirror (THRASTRO/ephem.js) checked against SYRTE by file size only | `docs/THIRD_PARTY.md` | the licence audit | left for the owner and the planner (a licence decision) |
| V25 | high | The meteor-shower table ships IMO and IAU MDC values with no licence stated; the "facts compiled by this project" basis is not recorded as a decision | `docs/THIRD_PARTY.md` | the licence audit | left for the owner and the planner |
| V26 | medium | SIMBAD's conditions not recorded (58 radial velocities, 156 sizes ship); hashes missing for the tides pack, ORB6, Schureman's SP-98, `pck00011`; BGS's terms for the committed geomag fixture | `docs/THIRD_PARTY.md` | the licence audit | left for docs3 |
| V27 | low | THIRD_PARTY: CC BY 4.0 entries without the licence URI, an incomplete at-a-glance table, stale text (VSOP87D and ELP 2000-82B, the Hipparcos processing, the MPC paragraph) | `docs/THIRD_PARTY.md` | the licence audit | left for docs3 (the MPC paragraph is superseded by verify2's block) |
| V28 | low | Contract doc drift: a `deep-time` pack and an `outside_validated_tier` warning that do not exist; a stale MERGE note; `sky_search`'s example; `ShowerNight.limiting_mag` nullable; `NightSummary`; geomag gaps; stale section titles; the mocks' gaps; no compile-time `implements` checks for two engines | `docs/EXPLORER_API.md`, `engine/*` | contract audits A and B | left for docs3 (section 6) |

## 4. Claims re-derived

Each with the agent's figure and this report's, from the reference named.

| claim | the agent | here | reference, method |
|---|---|---|---|
| Delta T σ at −2000 | 3 732 s | 3 731.6 s (Canon's Huber 3 731.8 s) | NASA "Uncertainty in ΔT" |
| Delta T at −2000 / 2999 against the Canon | not compared | +755 s (0.20 σ) / −255 s (0.14 σ) | NASA polynomials |
| Delta T across 1972, 1973, 2027, 2036, 2800 | continuous, steps −0.04 / +1.5 s | continuous; −0.04 s and +1.54 s | 2 000 epochs, `dt_scan.py` |
| Delta T at the 2016 leap second | continuous | continuous; 68.5932 s against Skyfield's 68.5927 s | Skyfield IERS |
| calendars (reform, year 0, BC leap days, tier edges) | 210 days vs Skyfield | 17 edge days identical in both calendars | Skyfield `compute_calendar_date` |
| labelled tier, Venus / Mars / Neptune | 0.06′ / 0.15′ / 0.06′ published | worst 0.0466′ / 0.1090′ / (1.04″ at −1500) | DE441 + ERFA |
| validated tier, planets | ≤ 0.02′ (Mercury, Venus 0.005′) | ≤ 0.0131′ (Mercury, Venus ≤ 0.0023′) at closest approaches | DE441 + ERFA |
| Rigil Kentaurus off the Almanac's line | 5.8″ (2026), 17″ (2060) | 5.77″, 16.81″; ALMA: orbit 0.10-0.12″, line 4.4-4.6″ | Akeson et al. 2021 |
| Galilean moons | 0.5″ (0.33″ worst 1995-2058; 0.89″ at 1650) | 0.40″ to 2040, 0.88″ to 2100, 1.27″ in the 1600s; 1.43″ at 1650 | JPL Horizons, 400 instants |
| Anchorage tides | 1.08 cm / 1.38 cm, 0.7 cm rms | the same before the fix; 0.19 cm / 0.45 cm after | NOAA API, two whole years |
| tides sweep | 0.99 cm | 0.59 cm after the fix | NOAA sweep fixture |
| third contact against SVS | −0.93 / −1.10 s (two-tier series) | −1.07 / −1.19 s, a third implementation | Skyfield + NAIF + the ring |
| the NASA transit rows | contact I printed equal to II | the midpoints of the true pairs, printed twice | NASA page, Skyfield + DE440 |
| almanac tables, 10 of 46 | "refraction; the smaller Moon radius" | 4 refraction (5th nearly); Moon rows: not refraction | ray trace, ERFA |
| perigee and apogee | 11.2 s, 0.22 km | 23.9 s, 0.36 km (the two-tier Moon) | the Skyfield fixture |
| the Moon's topocentric distance (libration) | 0.24 km | 0.71 km (the two-tier Moon) | the NAIF fixture |
| occultation contacts | 1.42 s | 1.17 s | the Skyfield fixture |
| topocentric Moon at perigee near the zenith | 0.7″ (anywhere) | 0.45″ (24 cases, 82.4°-90°) | Skyfield, `moon_zenith.py` |
| a transit at sunrise (Mercury 2032, Paris) | 4.4-6.1 s geocentric | 0.2 s local, the Sun's altitude 0.001°, sunrise to the second | Skyfield, `transit_sunrise.py` |
| golden and blue hour at the poles and the date line | 9e-7° | the same crossings at every threshold; 0.8″ (DUT1 = 0 here) | Skyfield, `sunhours_edges.py` |
| star identification | 290/290 first, separation < 0.00001°; 400/400 | 2.0e-6°; 400/400 (now asserted) | the test |
| meteor-shower peaks | 32 of 32 on the IMO's date | 32 of 32 in 2026 and 2027 (now asserted) | the test |
| conjunctions | 3 223 matched, timing 295 s, 24 slow pairs | every pair within 0.68 of its position budget; 2 slow | the test, 1990-2060 |

## 5. Tests that could not fail

An audit of every test the programme added, for bounds far looser than the figures
ACCURACY publishes, fixtures made by the code under test, silent skips and assertions that
cannot fail; then each finding re-measured before its bound was changed.

- **Fixed (d8d127c, 79c7c7b, b04cc32):** star identification (0.01° against a claimed
  0.00001°; 90 % first against 400/400); meteor-shower peaks (a day either side; the exact
  count printed only); sun tools (0.01°, i.e. 36″, against 0.02-0.31″, looser than
  aberration or nutation; golden-hour thresholds 1e-4 against 9e-7); occultations (30 s,
  which a spherical-Earth parallax passes; grazes printed only); apsides (2 min and 10 km,
  which a TT/UTC mix-up passes); libration (0.05°, which the model without the
  figure-to-mean-pole tilt passes; cases allowed to drop out); the lunar limb's near-graze
  count (decided by the code under test); compass azimuth (0.001° against 0.00001°); the
  almanac tables (HP to 0.001′ against 0.00001′, a comparison that switched itself off when
  days straddled a rounding, and "at least 70 % identical"); the conjunction timing
  assertion, which could not fail because every larger difference went to another bucket;
  the tides tests (only the brief's 2 min and 5 cm, the flat-turn allowance never checked,
  and a `noaa_differs` list written from the predictor's own failures that could flag a
  failing station out of the sweep). Each new bound is a few times the measured value and
  fails on the regression it names.
- **Open, for the planner:** no workflow runs the web tests (`ci.yml` runs `cargo test`;
  `pages.yml` builds the WASM core and runs only `cargo test -p skyfix-wasm --lib packs::`).
  The real-engine checks behind a dozen ACCURACY rows (charts, calendars, the Sky view's
  layers, Navigate, Events, Tonight, the GDA azimuths) run only on agents' machines. A job
  that installs wasm-pack as `pages.yml` does, then runs `npm ci`, `npm run wasm`,
  `npm run typecheck` and `npx vitest run --maxWorkers=2` in `web/`, would close it.
- **Fixed in the web tests:** seven real-engine tests returned early, and so reported a pass,
  when the built package lacked the export they check (Bowditch 1208's 3 264.54 NM, the
  running fix's 5 m handover, the star finder's template, GHA ♈ + SHA, the watch log and
  Vega, the Philadelphia compass error, the sailings shapes); they now skip (386964f).
  ACCURACY 20's Milky Way figures were asserted as "under the 32° grid" and nowhere: now
  measured on the engine's rings, |b| at most 27.81° and every straight (l, b) edge within
  0.0575° of its great-circle arc (136a1af). The meteor radiant's solar longitude, claimed
  within 0.05°, was a straight line between the engine's instants that erred by 0.146°
  for the Southern Taurids; now a parabola through three, within 0.003°, tested against
  Meeus's Sun (fc26f59).

## 6. Contract drift

Two read-only audits compared EXPLORER_API.md, `types.ts`, the Rust serde structs, the
adapters and the mocks for every expansion section. Every export's name, argument order,
field names, null-versus-absent and enum spellings agree. Found:

- **Fixed:** the navigation exports ignored the page-wide DUT1 (`set_dut1`) that the contract
  and Navigate's own note say a session without `clock.dut1_s` takes; `sidereal` (the
  worksheet's GHA ♈) did read it (68804cf; latent, no view sets it). `almanac_increments`
  turned 58.7 into 58 and NaN into 0 through a `u32` argument; the altitude tables accepted
  unknown condition keys (9f54859).
- **Documented** (EXPLORER_API verify2 block): who reads `set_dut1` as built; the sun tools,
  the Moon in detail, `star_identify` and the almanac tables turn the Earth with DUT1 = 0
  (up to 0.9 s of UT1, 13.5″, from `sky_state`'s IERS value; 0.6-0.8″ at the edge cases
  of section 4 in 2026).
- **Fixed in the adapter** (79fb982): planet detail's and geomag's Rust messages already
  begin with the export's name and `call()` added it again (`planet_disc: planet_disc:
  "Pluto" …`, which a test pinned, against EXPLORER_API's one prefix and the mock's);
  `conditionsJson` sent `tonight`'s `limit` to `dso_visibility`, `meteor_showers` and
  `extinction_table`, which refuse unknown fields (latent: a `TonightOptions` type-checks
  where conditions are asked).
- **Left as doc drift** (low; for docs3): the shared-contract section still describes a
  `deep-time` pack and an `outside_validated_tier` warning that do not exist (refusals are
  `OutOfCoverage`); the timescales section's `MERGE` note is stale; `sky_search`'s example
  detail line, `ShowerNight.limiting_mag` being nullable and `NightSummary` are
  undocumented or wrong; the geomag section omits `magnetic_grid`'s height limit and two
  nullable fields; stale section titles in code comments; the deep-sky mock never produces
  twilight darkness, transits, planets or a Milky Way best time; the mock accepts
  `alignment_days` with `at_altitude` and `options`, which Rust refuses; `WasmEngine` and
  `MockEngine` lack compile-time `implements` checks for `SunToolsEngine` and
  `GeomagEngine`.

## 7. The interface

The interface pass ran after the polish2 merge (0c186c0), on the built site, in headless
Chrome driven over the DevTools protocol (never the shared browser pane).

- **polish2's ui-check** (1 146 checks, `web/scripts/ui-check.mjs`): every view in the light,
  dark and night themes at 1 440 × 900 and 390 × 844, the night theme's light, leaks over 50
  view switches, the time keys, privacy, scrubbing, every chart, the deep-time clock and
  calendar, every Almanac tab with its printed sheets on A4 and Letter, Navigate's tabs and
  print previews, the photographers' tools, Tonight and its printed sheet, the Sky view's
  layers and close-ups, every Events list with its saved files, and every view and tab at
  585 BC and AD 2999. The run during the pass: 1 145 of 1 146; the one failure was the
  verifier's own rebuild of `web/dist` while the run read it (404s on one chart's console).
  The final run on the final build: UICHECK-FINAL.
- **verify2-check** (this branch, `web/scripts/verify2-check.mjs`, 75 checks, all passing on
  the final build): the ± chip beside the clock at six dates against `skyfix time-info`
  (section 2.3); fast playback's calls on eight views (2.4); Settings → Air in the Almanac's
  Table A4 form; every view at 585 BC and AD 2999 with every folded tool open, no engine
  message as it came and every refusal in words (section 8); the Events calendar files of
  four lists read by Python's icalendar 7.3 (15, 32, 65 and 46 events, every one whole), the
  table read by Python's csv (every row as wide as its header), the Sky view's saved picture
  opened by Pillow 12.3 (a 1 100 × 903 PNG); the tides pack's prompt declined (nothing
  fetched, the prompt gone) and got with the connection lost ("The US tides pack could not
  be downloaded: you are offline.", Try again, no exception); a sight typed at AD 1000 in
  Navigate refused with the reason, the validated years and the chip.
- **The verifier's interface changes** (V14-V16, V19-V21) touch words, when the engine is
  asked and what the side panel dims during fast playback; they add no colour, control or
  layout, and the final ui-check covers every view they touch. Pack prompts' Get paths are
  ui-check's (the tides pack got and removed in Settings, the lunar-limb pack offered once on
  a solar eclipse).
- **Print previews, keyboard and phone layouts** were not re-derived beyond ui-check's blocks:
  its checks are specific (sheet counts and black on white for the Almanac, one page of
  Letter and A4 for Tonight, the worksheets' paper at night; the time keys never moving the
  time while typing; the phone's sheet).

## 8. Honesty

EXPANSION_PLAN §3 asks that the labelled band never show a number without its uncertainty,
that sights be offered only in the validated tier, and that every new number have a
sentence. Checked in the browser at 585 BC and AD 2999 (verify2-check's farlook group, every
view with every folded tool open) and in the code:

- **The planner's list of labelled-tier gaps: honest, not silent.** The Sky view says "Stars
  are drawn only for 1550 to 2650; the Sun, the Moon and the planets are shown." Tonight says
  "Planets, deep sky and meteor showers: worked out only for 1550 to 2650.", and the same for
  its coming-up showers and perihelion. The Events eclipse list says "Eclipses are computed
  for 1990 to 2060: move the explorer's time inside that span." The Selected card's Moon and
  planet tools say their years (polish2's `rangeWords`). Each is a refusal in plain words;
  none is a blank. They are capability gaps, not breaches of the principle: the eclipse of
  585 BC, the star field and Tonight's planets at far dates would each need its engine
  widened (the navigational stars, and the planets' places, rising and setting, already
  answer the labelled tier through `sky_state` and `day_events`).
- **Fixed:** the one engine message shown as it came (Jupiter's close-up: ISO dates and a
  Julian day), the Now section's "Sun sights are possible now" at 585 BC (it now adds the
  tier's own sentence), Tonight's note denying the Moon distance its card showed, the Jupiter
  close-up's "within 3.0″ of JPL" where no JPL ephemeris of the moons reaches, and a planet
  occultation's times that did not say they are the planet's centre (V1, V19, V20).
- **Left for the planner: which clock times the ± chip belongs to (V18).** At a far date the
  clock is UT1, the Earth's own rotation, and Delta T = TT − UT1 is what is uncertain. An
  instant defined in TT (a Moon phase, a solstice, a conjunction, an eclipse's greatest
  phase) moves by the whole σ when written in UT1, and the chip is right there. A time set by
  the Earth's turning does not: Skyfield with DE441 at Philadelphia on 28 May 585 BC, Delta T
  18 213 s against 18 363 s (the engine's σ, 150 s), moves sunrise and sunset by 0.3-0.5 s,
  the Moon's rise, set and transit by 4-8 s, and the first quarter and the June solstice by
  −150.00 s (`tools/verify2/dt_events.py`). On 1 June 2000 BC with the engine's σ of 3 732 s:
  sunrise and sunset 9-12 s, the Moon's rise, set and transit 1.4-3.1 min, the TT instants
  −3 732 s. Yet the explorer writes "±3 min" after every rise,
  set, transit, twilight and golden hour at 585 BC, and "±1 h" at 2000 BC, and
  `time_info`'s note says "times and Earth-fixed positions carry it". Conversely what does
  move with Delta T at the time shown, the Moon's place (0.55″ for each second: 1.4′ at
  585 BC, 34′ at 2000 BC, shown to the arcminute in the Selected card and the charts' readout),
  carries no chip. Proposed rule: the chip at σ for TT instants and for anything placed on the
  Earth from a TT instant (eclipse paths and local contacts, occultations); at σ times the
  body's share of the sky's turning (the Sun 0.3 %, the Moon 3.7 %, the planets under 1 %) for
  rise, set, transit and twilight, which hides it for the Sun everywhere in the tier; and on
  the Moon's position at σ × 0.55″/s. This changes CONVENTIONS 15.1-15.2 and every chip's
  call site, a design decision rather than a fix. Navigate's refusal of a sight at AD 1000
  gives the same reason ("the Earth's rotation is known only roughly (±15 s of time, 3.8′ of
  longitude)"), though a sight taken at a given UT1 is not moved by it; the reason that
  stands is the one beside it, that positions in the labelled tier are estimates.
- **Sound:** every labelled-tier clock time carries a chip (polish2's check; the ± chip beside
  the clock shows the engine's σ, section 2.3); the navigational sights are refused outside
  the validated tier with the reason (section 11); the Galilean accuracy and the Rigil
  Kentaurus difference are now stated where a user reads them.

## 9. Budgets

Measured on 2026-09-25 on the shared 8-core machine once the other agents had stopped
(load average 1.2-1.6 at the start of each run; a headless Chrome's software rendering
raises it while it runs).

| budget | measured | how |
|---|---|---|
| module ≤ 3 MB raw, ≤ 1.25 MB gzipped | 2 551 154 bytes raw, 1 151 178 gzipped (`gzip -9`; 1 152 888 at `gzip -6`) | `stat`, `gzip -c` on `web/src/wasm-pkg/skyfix_wasm_bg.wasm` after `npm run wasm` (opt-level "z") |
| `sky_state` ≤ 2 ms | 1.02 ms fastest, 1.12 median, 1.60 p95 (2026); 1.07 / 1.10 at 585 BC; 1.00 / 1.01 at AD 2999 | `node web/scripts/core-bench.mjs` (100 runs after 30; load 1.6, judged) |
| star field ≤ 5 ms | 1.08 ms fastest, 1.09 median (`starfield_apparent`) | the same |
| Sky draw ≤ 10 ms | median 4.6, 4.8 and 5.1 ms, p95 7.4-8.5 ms, in three runs of 200 draws (1 440 × 839); main at bc4319f in the runs between, 6.9 and 6.5 ms, p95 11 and 10.5 ms, at the same loads | `dev-sky.html?syncbench=200`, a build with developer pages, verify2-check's probe |
| first paint unchanged | first contentful paint 40 and 44 ms, the explorer ready in 1 117 and 1 129 ms (medians of five cold first visits); main, with the same module, 52 and 40 ms, 1 075 and 1 105 ms | verify2-check's paint group, alternating the two builds |

Also measured: a year of the planets' conjunctions in 213 ms and of their stations in 138 ms
(`planetdetail_conjunctions::a_years_search_is_fast`, release, against its 300 ms; the 482 ms
of V29 was the load of 11); a day of events for every body 9.7 ms, a year of meteor showers
at a place 150 ms, the Moon's year of rising and setting bearings 467 ms (core-bench).

## 10. Data licences

A read-only audit of every THIRD_PARTY.md entry against the brief's rules (URL, retrieval
date, licence basis, hash and processing; nothing on screen but OpenStreetMap; no
share-alike data shipped), with every recorded hash recomputed where the file is in the
repository (all matched).

- **Fixed:** the on-screen credits (V16): seven places named a source on screen; they are
  gone, with a source scan that fails on any of them returning. The add dialog's worked
  example carried the Minor Planet Center's values, which the MPC asks to be credited: it now
  holds JPL Small-Body Database elements for (1) Ceres, which ask for no credit, fetched at
  development time and recorded with their hash (they agree with the MPC's to every digit
  shown but the perihelion passage and G). The map's credit box shows OpenStreetMap's credit
  exactly while its tiles are drawn, and nothing else. The typefaces' OFL text now ships with
  the fonts (V17).
- **No share-alike data ships.** The CC BY 4.0 items (IGRF-14, the Delta T tables, WGSN
  names) are credited in the documentation; Hipparcos's CC BY-NC extract was the owner's
  earlier decision.
- **Left for the owner and the planner:** ELP/MPP02 (no licence stated, a third-party
  mirror; V24) and the shower table (IMO and MDC values with no licence; V25) each need a
  recorded decision, as Hipparcos has; SIMBAD's conditions and five missing hashes (V26); the
  CC BY URIs, the at-a-glance table and stale text (V27). The BGS calculator's outputs are
  committed as a test fixture under terms that restrict commercial reuse: the same kind of
  question as Hipparcos.
- **On screen by design, and allowed as information rather than credit:** the tides' "NOAA
  station …" and "NOAA's page ↗", the magnetic model's name, "IERS" beside DUT1, "checked
  against JPL's …" on the coverage table, and the paste box's hint naming the MPC's one-line
  formats.

## 11. What was checked and found sound

- Sight refusal at the tier edges: predicted readings one second outside 1550-01-01 and
  2650-01-22 are refused, one second inside answered.
- The 2035/2036 clock switch: a local day spanning it (zone −05:00) gives continuous
  events, no errors, and each side's notes explain its scale.
- Packs absent: the tide commands fail with `pack_not_loaded` and the way to load it (exit
  status 1); an eclipse asked for the limb without the pack answers on the mean limb with
  a note offering the pack.
- The magnetic field near the dip poles: blackout and caution zones labelled, σ widening
  (33° at 162 nT, 15.5° at 349 nT, 2.5° at 2 166 nT).
- Every committed data file whose hash THIRD_PARTY records matched (the licence audit's
  computation).
- The contract for deep sky, tides, planet detail, the lunar limb and the almanac tables:
  consistent in every field (section 6).
- The tier edges, one second either side in the proleptic Gregorian calendar: −2000-01-01
  00:00:00 labelled and a second before outside; 3000-12-31 23:59:59 labelled and the next
  second outside; 1549-12-31 23:59:59 labelled, 1550-01-01 validated; 2650-01-22 00:00:01
  outside the validated tier (`skyfix tier-at`, `skyfix sky`). In the Julian calendar the
  explorer shows before 1582 the lower bound is 18 January 2001 BC (17 January 23:59:59
  outside), as the CLI's `tier-at` says in both calendars.
- Diurnal tides: a whole year of NOAA's high and low waters at Pensacola (diurnal, 765) and
  Galveston Pier 21 (mixed, 1 059), every one matched, worst 1.38 and 1.81 min and 0.06 cm
  (`tools/verify2/tides_hilo.py`).
- Showers across the year's end: the Quadrantids of 2026 start on 27 December 2025 and the
  December Leonis Minorids of 2026 end on 30 January 2027; the Sky view asks both years near
  the turn (`yearsFor`, tested).
- A planet's occultation: the engine's crossing times, first touch to hidden, are Skyfield's
  to 0.1 s (Jupiter from Mumbai, 2019-11-28: 103.7 and 91.9 s; every planet event of the
  fixture, 2 × 5-79 s, `tools/verify2/occ_planet_disc.py`).
- Settings → Air: the height shown, the predicted sextant reading and Table A4 move alike
  (1030 hPa, −10 °C, the Sun 5° up: +0.944′, +0.915′, −0.943′; the reading takes refraction
  at the higher apparent height it predicts); Navigate's reductions use each session's own
  air, as the guide says.
- The interface: the ± chip beside the clock shows the engine's σ at six dates; the four
  Events calendar files, the table and the Sky picture read by independent readers; the pack
  prompt declined and offline; Navigate's refusal at AD 1000; every view at 585 BC and
  AD 2999 without an engine message as it came (after the close-up's fix); Settings → Air in
  every refraction; the first paint and the Sky draw no slower than main's.

## 12. Reproduce

```console
cargo build --release -p skyfix-cli
cargo test --workspace
cargo test --release -p skyfix-tides --test noaa_fixtures -- --nocapture
cargo test --release -p skyfix-almanac --test galilean_horizons --test planetdetail_conjunctions -- --include-ignored --nocapture
cargo test -p skyfix-ephemeris --test acen_alma -- --nocapture
# the re-derivations, from a scratch directory (VERIFY2_PYLIB: a directory with pyerfa)
REPO/tools/reference/.venv/bin/python REPO/tools/verify2/dt_canon.py
REPO/tools/reference/.venv/bin/python REPO/tools/verify2/eclipse_contacts.py 0 1
REPO/tools/reference/.venv/bin/python REPO/tools/verify2/labelled_sweep.py Mars,Venus,Mercury,Jupiter,Saturn 2
REPO/tools/reference/.venv/bin/python REPO/tools/verify2/dt_events.py            # which clock times Delta T moves
VERIFY2_REF=DIR REPO/tools/reference/.venv/bin/python REPO/tools/verify2/tides_hilo.py 8729840 8771450
# the interface (web/): the unit and real-engine tests, then the browser checks
npm run wasm && npm run typecheck && npx vitest run --maxWorkers=2
npm run build && node scripts/ui-check.mjs                    # polish2's 1 146 checks
npx vite build --minify false --outDir /tmp/site-nomin        # exports named in profiles
SITE=/tmp/site-nomin ONLY=playback node scripts/verify2-check.mjs
ONLY=chip,air,farlook,exports,packs,tiers node scripts/verify2-check.mjs
FAR_T=2999-06-20T02:00:00Z ONLY=farlook node scripts/verify2-check.mjs
node scripts/core-bench.mjs                                   # sky_state and the star field
```
