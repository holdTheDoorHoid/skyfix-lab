# SkyFix Lab

An offline celestial-navigation workbench in Rust: a digital-sextant sight reducer, a
weighted least-squares position solver with honest uncertainty, and a deterministic
error simulator, sharing one numerical core between a command-line tool and a
browser workbench (Rust compiled to WebAssembly).

**This is a simulation and analysis tool, not a navigation instrument.** Numerical
agreement with reference data is not field accuracy. See `docs/ACCURACY.md`.

The central question it answers: *where do these sky observations place me, and how
much should I trust the answer?*

## Status

Under construction. See `docs/BACKLOG.md` for what is done, partial and unstarted, and
`docs/COMPLETION_REPORT.md` for the current honest state.

## Layout

| path | what |
|---|---|
| `crates/skyfix-core` | units, conventions, sight reduction, corrections, solver, uncertainty (no I/O) |
| `crates/skyfix-ephemeris` | offline Sun and navigational-star providers, fixture packs, coverage metadata |
| `crates/skyfix-sim` | seeded simulator, error experiments, Monte Carlo coverage checks |
| `crates/skyfix-cli` | `skyfix reduce | solve | simulate | validate | plan` |
| `crates/skyfix-wasm` | wasm-bindgen adapter for the browser |
| `web/` | TypeScript + Vite workbench, all assets bundled |
| `fixtures/` | sessions, separate truth files, independent reference cases |
| `tools/reference/` | Python + Skyfield fixture generators (development-time only) |
| `docs/` | brief, conventions, architecture, accuracy, third-party inventory, backlog |

`docs/CONVENTIONS.md` is normative for every sign, unit and frame in the project.

## License

MIT OR Apache-2.0, at your option. See `LICENSE-MIT` and `LICENSE-APACHE`.
