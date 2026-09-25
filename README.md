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

- A time bar for moving through time — drag, step, play at up to a month a second — over a
  map, a globe, or the sky itself, with day/night/twilight shading and a SunCalc-style
  compass at your place.
- The Sun, the Moon and the four navigational planets, plus a naked-eye star field of
  about 9,000 stars and all 88 constellations, for display; the Sun, Moon, Venus, Mars,
  Jupiter, Saturn and 58 navigational stars are independently validated and usable for
  real sight reduction.
- Sight reduction with every correction reported, a position solver with a nominal 95 %
  ellipse, conditioning diagnostics and explicit ambiguity — never a false point where the
  geometry does not support one.
- Noon sight, latitude by Polaris, averaging a run of sights, a running fix under way, and
  lunar distance (Greenwich time from the Moon, with no chronometer).
- Printable nautical-almanac daily pages, and eclipses, Moon phases, equinoxes and
  solstices computed from the same Sun and Moon models.
- A seeded simulator and ten packaged demonstrations that check whether the reported
  uncertainty actually covers the true error — see [`docs/DEMOS.md`](docs/DEMOS.md).
- Works offline once loaded, on a phone or a desktop, in light, dark or a red night-vision
  theme.

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
| `crates/skyfix-core` | units, conventions, sight reduction, corrections, solver, uncertainty, navigation methods (no I/O) |
| `crates/skyfix-ephemeris` | offline Sun, Moon, planet and navigational-star providers, fixture packs, coverage metadata |
| `crates/skyfix-almanac` | rise/set/twilight/seasons/Moon phases, printable almanac pages, eclipses |
| `crates/skyfix-starfield` | the display-only star field and constellations (never a source for a fix) |
| `crates/skyfix-motion` | running fixes and independent-estimate disagreement checks |
| `crates/skyfix-sim` | seeded simulator, error experiments, Monte Carlo coverage checks |
| `crates/skyfix-cli` | the `skyfix` command line |
| `crates/skyfix-wasm` | wasm-bindgen adapter for the browser |
| `crates/skyfix-camera` | synthetic camera star-sextant (simulation only) |
| `crates/skyfix-polar` | polarization compass heading laboratory (simulation only) |
| `web/src/next/` | the explorer (map, sky, charts, navigate, almanac, events, learn), `web/README.md` |
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
