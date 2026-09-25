# SkyFix Lab documentation

SkyFix Lab is an offline celestial-navigation workbench: where the Sun, the Moon, the
planets and the navigational stars are from any place at any time, a digital-sextant
sight reducer, a weighted least-squares position solver that reports its own uncertainty
and its own ambiguities, and a seeded error simulator, sharing one Rust core between a
command-line tool and a browser app.

**It is a simulation and analysis tool, not a navigation instrument.** Numerical agreement
with reference data is not field accuracy — see [Accuracy and limitations](ACCURACY.md).

Live site: <https://holdthedoorhoid.github.io/skyfix-lab/> — this book:
<https://holdthedoorhoid.github.io/skyfix-lab/docs/>.

> The map-first **explorer** is the site's home page (since 2026-09-24; it was at `/next/`,
> which now forwards there). The original workbench has been retired: its old address,
> `/classic/`, opens the explorer's Navigate and Learn views, which do everything it did.
> New to the site? Start with [Using the explorer](EXPLORER_GUIDE.md).

## Quick start

The repository's top-level `README.md` is the canonical quick start, with real commands
and their trimmed output. The essentials, duplicated here so this page stands on its own:

```console
cargo build --release -p skyfix-cli
./target/release/skyfix solve fixtures/sessions/reference-philadelphia-5star.json
cargo test --workspace
npm install --prefix web && npm run wasm --prefix web && npm run build --prefix web
```

The first line builds the CLI; the second solves a real five-star Philadelphia session;
the third runs the whole workspace's test suite; the fourth builds the browser workbench
(WebAssembly core plus the TypeScript UI) into `web/dist`. See
[Demos](DEMOS.md) for the six scenarios the brief asks for, each with commands to run and
what to look at, and [Command line](CLI.md) for every subcommand.

The original design brief lives in the repository at `docs/BRIEF.md`. It is background —
the proposal this project was built from — and is deliberately not a chapter of this
book; the chapters below are the current, maintained record.

## In this book

- [Using the explorer](EXPLORER_GUIDE.md) is the friendly walkthrough: setting a place,
  moving through time, each view, themes, sharing a link, and a five-minute primer on
  celestial navigation.
- [Demos](DEMOS.md) — the six required demonstrations from the brief, with commands,
  what to look at in the browser, and measured coverage numbers.
- [Conventions](CONVENTIONS.md) fix every sign, unit, frame and file format. Normative:
  where code and this file disagree, the code is wrong until the file is amended.
- [Architecture](ARCHITECTURE.md) explains the crate layout, the data flow, and the
  reasons behind the choices that shape it.
- [Command line](CLI.md) documents every `skyfix` subcommand with real worked examples.
- [Observation planner](PLANNER.md) explains what `skyfix plan` optimises and what it
  cannot tell you.
- [Simulator](SIMULATOR.md) is normative for the seeded generator, the sign conventions
  of its error knobs, and the coverage statistic.
- [Camera sextant (synthetic)](CAMERA.md), [Polarization compass laboratory](POLARIZATION.md)
  and [Motion and independent checks](MOTION.md) are three follow-on modules: a
  stationary camera star-sextant, a polarization heading laboratory, and running fixes
  with independent disagreement checks. All three are simulation-only so far.
- [Navigation methods](NAVIGATION_METHODS.md) — noon sight, latitude by Polaris, averaging
  a run of sights, and the running fix. [Moon and planet sights](NAVIGATION_SKY.md) extends
  all of it to the Moon and the four navigational planets, and adds lunar distance and a
  twilight sight planner.
- [Accuracy and limitations](ACCURACY.md) is where every measured number in the project
  lives, with its provenance and how to reproduce it.
- [Third-party sources and licences](THIRD_PARTY.md) records every external algorithm,
  coefficient table and data file, with its URL, retrieval date and licence.
- [Backlog](BACKLOG.md) lists what is completed, partial and unstarted, and why.
- [Completion report](COMPLETION_REPORT.md) is the sprint's final honest-state summary.

For developers: [the explorer's program plan](EXPLORER_PLAN.md) and
[its wire contract between Rust and the browser](EXPLORER_API.md).
