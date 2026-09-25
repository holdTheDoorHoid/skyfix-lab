# SkyFix Lab

SkyFix Lab is an offline celestial-navigation workbench in Rust: where the Sun, the Moon,
the planets and the navigational stars are from any place at any time, a digital-sextant
sight reducer, a weighted least-squares position solver that reports its own honest
uncertainty, and a deterministic error simulator — one numerical core shared between a
command-line tool and a browser app (Rust compiled to WebAssembly).

**Simulation and analysis workbench. Not a navigation instrument.** Numerical agreement
with reference data is not field accuracy — see [`docs/ACCURACY.md`](docs/ACCURACY.md).

**Live site:** <https://holdthedoorhoid.github.io/skyfix-lab/> · **Documentation:**
<https://holdthedoorhoid.github.io/skyfix-lab/docs/>

> The map-first **explorer** is the site's home page (since 2026-09-24; it was at `/next/`,
> which now forwards there). The original workbench has been retired: its old address,
> `/classic/`, opens the explorer's Navigate and Learn views, which do everything it did.
> New user? Start with [`docs/EXPLORER_GUIDE.md`](docs/EXPLORER_GUIDE.md).

## What it does

- A time bar for moving through time — drag, step, play at up to ten years a second — over
  a map, a globe, or the sky itself, with day/night/twilight shading and a SunCalc-style
  compass at your place, from 2000 BC to AD 3000: full accuracy over 1550–2650, a labelled
  historical or far-future estimate outside it, with the Earth's rotation's own uncertainty
  shown beside every clock time that it moves.
- The Sun, the Moon, the planets, a naked-eye star field of about 9,000 stars, all 88
  constellations, the Milky Way and 213 deep-sky objects, for display; the Sun, Moon,
  Venus, Mars, Jupiter, Saturn and 58 navigational stars are independently validated and
  usable for real sight reduction over 1550–2650.
- A **Tonight** page for anyone going out to look — darkness, the Moon, the planets, the
  best deep-sky objects, meteor showers, the Milky Way's core, the next tide — and an
  **Events** view for eclipses, occultations, transits, conjunctions, meteor showers and
  the seasons, every list exportable as a calendar file or a table.
- Sight reduction with every correction reported, a position solver with a nominal 95 %
  ellipse, conditioning diagnostics and explicit ambiguity — never a false point where the
  geometry does not support one.
- Noon sight, latitude by Polaris, averaging a run of sights, a running fix under way,
  lunar distance (Greenwich time from the Moon, with no chronometer), great-circle and
  rhumb-line sailings with dead reckoning, star identification from an altitude and a
  bearing, and magnetic variation and compass error anywhere from 1900 to 2030.
- Printable nautical-almanac daily pages and the book's other tables (increments,
  altitude corrections, Polaris, arc to time), for any date the core covers; US tide
  predictions (NOAA's harmonic constants, an optional download); photographers' tools —
  golden and blue hour, an alignment finder for a Sun or Moon line down a street or over a
  skyline, a Milky Way planner, sun-path and solar-panel charts.
- A seeded simulator and ten packaged demonstrations that check whether the reported
  uncertainty actually covers the true error — see [`docs/DEMOS.md`](docs/DEMOS.md).
- Works offline once loaded, on a phone or a desktop, in light, dark or a red night-vision
  theme; the deep-time tables ship in the core module (about 1.2 MB gzipped on a first
  visit), while US tide stations and the Moon's eclipse-limb detail are optional
  downloads, fetched only when turned on.

Three follow-on, simulation-only modules go further: a synthetic camera star-sextant
(`docs/CAMERA.md`), a polarization heading compass (`docs/POLARIZATION.md`), and running
fixes with independent-estimate disagreement checks (`docs/MOTION.md`).

## Quick start: the web app

```console
$ npm install --prefix web
$ npm run wasm  --prefix web     # compiles crates/skyfix-wasm to WebAssembly
$ npm run build --prefix web     # emits web/dist
```

`npm run dev --prefix web` starts a local server at <http://localhost:5173> (the explorer
at `/`); `npm test --prefix web` runs the
TypeScript unit tests. No CDN fonts,
scripts or map tiles: every asset is bundled, so the built site needs no network once
loaded (the one exception is an optional online street-map layer, off by default).

## Quick start: the command line

```console
$ cargo build --release -p skyfix-cli
$ ./target/release/skyfix solve fixtures/sessions/reference-philadelphia-5star.json
UNIQUE FIX
Position     39.952599, -75.165273
             39 57.16' N, 075 09.92' W
Uncertainty  sigma north 118.9 m (0.064 NM), sigma east 115.4 m (0.062 NM)
Ellipse 95%  semi-major 291.1 m, semi-minor 282.5 m, orientation 1.2 deg clockwise from north
Fit          chi2 0.0000 on 3 degree(s) of freedom, converged after 5 iteration(s)
```

That fixture's truth is 39.9526, -75.1652 — the fix agrees to the last printed digit; the
target is 10 m on clean, well-conditioned synthetic geometry, a numerical regression
target rather than a field-accuracy claim (`docs/ACCURACY.md`, section 3). The CLI also
answers `sky`, `events`, `phases`, `seasons`, `almanac`, and every navigation method the
explorer will eventually expose on screen — see [`docs/CLI.md`](docs/CLI.md) for every
subcommand with worked examples, and run `cargo test --workspace` for the full test suite.

## Layout

| path | what |
|---|---|
| `crates/skyfix-core` | units, conventions, sight reduction, corrections, solver, uncertainty, navigation methods, sailings and star identification (no I/O) |
| `crates/skyfix-ephemeris` | offline Sun, Moon, planet and navigational-star providers over 2000 BC to AD 3000, coverage tiers, fixture packs |
| `crates/skyfix-almanac` | rise/set/twilight/seasons/Moon phases, printable almanac pages and their extra tables, eclipses (with an optional lunar-limb pack), sun tools, the Moon and planets in detail |
| `crates/skyfix-starfield` | the display-only star field, constellations, deep-sky objects, meteor showers and the Milky Way (never a source for a fix) |
| `crates/skyfix-geomag` | WMM2025 and IGRF-14 magnetic variation, inclination and intensity, 1900–2030 |
| `crates/skyfix-tides` | NOAA harmonic tide predictions for US stations (an optional pack) |
| `crates/skyfix-motion` | running fixes and independent-estimate disagreement checks |
| `crates/skyfix-sim` | seeded simulator, error experiments, Monte Carlo coverage checks |
| `crates/skyfix-cli` | the `skyfix` command line |
| `crates/skyfix-wasm` | wasm-bindgen adapter for the browser |
| `crates/skyfix-camera` | synthetic camera star-sextant (simulation only) |
| `crates/skyfix-polar` | polarization compass heading laboratory (simulation only) |
| `web/src/next/` | the explorer (map, sky, tonight, charts, navigate, almanac, events, learn), `web/README.md` |
| `fixtures/` | sessions, separate truth files, independent reference cases |
| `tools/reference/`, `tools/starfield/`, `tools/mapdata/` | development-time generators (Python + Skyfield, or Node); never a runtime dependency |
| `docs/` | this book: guide, conventions, architecture, demos, accuracy, third-party inventory, backlog |

`docs/CONVENTIONS.md` is normative for every sign, unit and frame in the project.

## Documentation

Read the whole book at <https://holdthedoorhoid.github.io/skyfix-lab/docs/>, or build it
locally with [mdBook](https://rust-lang.github.io/mdBook/): `mdbook build docs`, then open
`docs/book/index.html`. Start with [`docs/EXPLORER_GUIDE.md`](docs/EXPLORER_GUIDE.md) if
you are new; [`docs/SUMMARY.md`](docs/SUMMARY.md) lists every chapter, including
conventions, architecture, the CLI, accuracy and limitations, third-party sources and
licences, and the backlog.

## License

MIT OR Apache-2.0, at your option. See `LICENSE-MIT` and `LICENSE-APACHE`.
