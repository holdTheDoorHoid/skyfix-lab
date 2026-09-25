# tools/tides — the `tides-us` pack and its NOAA fixtures

Development-time only: nothing here runs in the app, and nothing needs anything beyond
the Python 3 standard library and `cargo`. The runtime is `crates/skyfix-tides` (the
predictions) and `crates/skyfix-wasm/src/tides.rs` (the browser exports); the pack is
data they load. Definitions: `docs/CONVENTIONS.md` 13.11; wire format and pack payload:
`docs/EXPLORER_API.md`, "Tides"; measured accuracy: `docs/ACCURACY.md` section 16;
sources and licence: `docs/THIRD_PARTY.md`, "Tides".

## The pipeline

`make -C tools/tides` runs it all (`make -C tools/tides offline` from the cache only,
which reproduces the committed fixtures and pack byte for byte); the steps, run from the
repository root, are below. Everything NOAA serves is cached byte for byte under
`tools/tides/cache/` (git-ignored), with its URL, retrieval time and SHA-256 in
`cache/manifest.json`; a re-run asks NOAA only for what is missing.

| step | command | what it does | requests |
|---|---|---|---|
| 1 | `python3 -m tools.tides.fetch` | the tide-prediction station list with every subordinate station's offsets (one request, `expand=tidepredoffsets`), then each harmonic station's constants, datums, disclaimers and notices (`expand=harcon,datums,disclaimers,notices`) | 1 258 |
| 2 | `python3 -m tools.tides.fixtures` | NOAA's own predictions: 20 harmonic stations x 30 days (high/low and hourly) and 6 subordinate stations x 30 days (`fixtures/reference/tides_noaa.json`); 3 days of high and low water at every station (`fixtures/reference/tides_noaa_sweep.json`) | 46 + 3 499 |
| 3 | `python3 -m tools.tides.build` | the pack `web/public/data/packs/tides-us-<rev>.bin` and its sidecar `tides-us.json`, flagging the stations listed in `noaa_differs.json` | none |
| 4 | `cargo run --release -p skyfix-tides --example noaa_sweep -- web/public/data/packs/tides-us-*.bin fixtures/reference/tides_noaa_sweep.json --write tools/tides/noaa_differs.json` | checks every station of the pack against NOAA's sweep with the rules of `skyfix_tides::validation` and writes the stations that fail | none |
| 5 | `python3 -m tools.tides.build` again | rebuilds the pack with the flags of step 4 (the flags do not change any prediction, so one pass of step 4 is enough) | none |

Then `cargo test -p skyfix-tides` checks it all: `tests/pack_real.rs` re-encodes the
shipped pack byte for byte from its decoding, compares its constants with the fixture's
NOAA records, and runs the sweep (every 7th station in a debug build,
`TIDES_FULL_SWEEP=1` for all; all of them in a release build).

`fixtures.py --offline` and `build.py` never touch the network. `fetch.py --refresh`
asks NOAA again for everything. The first full run takes about 50 minutes, almost all of
it the sweep at the client's pace.

## Politeness

`noaa.py` is the only code that talks to NOAA: one request at a time, at least 0.6 s
between the starts of two requests, a descriptive User-Agent and `application=
skyfix-lab-tides` on the data API (NOAA asks callers to name themselves), exponential
back-off (10, 20, 40, 80 s) on HTTP 429, 5xx and network errors, and a stop after five
failures in a row. The 2026-09-25 run met two HTTP 504s, both recovered after one
back-off.

## What was retrieved (2026-09-25 UTC)

- **3 499 stations** that NOAA predicts tides for: 1 256 harmonic ("R") stations, whose
  records hold up to 37 constituents (NOAA's standard set) — Anchorage, 9455920, holds
  120 (NOAA's extended set) — and 2 243 subordinate ("S") stations, with a reference
  station, time differences for high and low water (minutes) and height differences
  (a ratio, "R", or an additive difference in feet, "F").
- Datums relative to each station's datum, epoch 1983-2001 at 1 156 stations (2012-2016
  at 68, 2002-2006 at 13, "Special" at 13, no epoch given at 5); LAT and HAT beside them.
- One subordinate station, 1841275 (Malakal Harbor), names itself as its reference and
  has no constants (flag `reference_unusable`); `fetch.py` asks for its record anyway,
  as it does for every station a subordinate station refers to.
- 4 harmonic stations of the list with no constants (Carolina Forest, I-10 Bonnet Carre
  Floodway, Big Salt Lake, Fish Bay) and 2 without datums (Eugene Island; Big Salt Lake):
  flagged `no_constants` / `no_datums` in the pack. NOAA itself serves no predictions
  for the first four either.
- Disclaimers NOAA attaches to 52 stations (data from the Texas Coastal Ocean
  Observation Network, the Florida Department of Environmental Protection, the Puerto
  Rico Seismic Network; the Columbia River Datum): about the observations' provenance and
  leveling, none restricting use. 10 stations are marked non-navigational
  (`non_navigational` flag).

## What was found (and is now built in)

These are NOAA's conventions, recovered from its own predictions, where the published
documents leave a choice:

1. **Node factors and angles at mid-year, V0 at 1 January** (Schureman p. 157). With f
   and u at each instant instead, the curve differs from NOAA's by up to 18 cm
   (Anchorage) and times by up to 21 minutes (a diurnal port).
2. **M1**: V0 + u of Schureman's formula 201 (V = T − s + h − 90°, u = ξ − ν + Q; the
   form his Table 15 prints) advanced at formula 194's speed, 14.4966939°/h (which NOAA
   publishes). Neither pure form matches; this mixture brings every station's curve
   from up to 1.2 cm to NOAA's millimetre rounding.
3. **MSf** is the compound S2 − M2 (Table 15 prints its V0 + u equal to 2SM2's).
4. In the extended set, **TK1, RP1, KP1** are Schureman's solar terms π1, ψ1, φ1 (f = 1,
   u = 0) and **MP1, SO1** the compounds M2 − P1 and S2 − O1; the rest are the compounds
   their names say (Anchorage: 4.4 cm → 1.4 cm). The subordinate additive differences are
   in **feet**.
5. **The tide table's rule for ripples.** NOAA's lists of high and low water leave out a
   high and a low that are less than 2 hours apart (instants rounded to the minute) and
   less than 0.1 ft (3.05 cm) apart in height, scanning from the earliest extreme; for a
   subordinate station the rule applies to its own list, after the differences. Found
   from the sweep: without the rule 166 of our extremes were not in NOAA's lists; with
   it, one pair at one station (a double high whose peaks differ by 1 mm, where NOAA and
   we keep different peaks).
6. NOAA serves no predictions for one station it lists with usable offsets, **8661558
   Holly Grove Plantation**: the only station flagged `noaa_differs`.

## Refreshing

NOAA revises constants and datums from time to time. To refresh: `fetch.py --refresh`,
delete `tools/tides/cache/pred/` (NOAA's predictions are cached too), then
`make -C tools/tides`. The fixture windows are fixed in `fixtures.py`, so a refresh after
NOAA changes something shows up as a diff of the fixtures and, if the method no longer
reproduces NOAA, as a failing test. Never regenerate a fixture from Rust output
(`fixtures/README.md`).
