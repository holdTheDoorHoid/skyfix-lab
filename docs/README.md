# SkyFix Lab documentation

SkyFix Lab is an offline celestial-navigation workbench: a digital-sextant sight reducer,
a weighted least-squares position solver that reports its own uncertainty and its own
ambiguities, and a seeded error simulator, sharing one Rust core between a command-line
tool and a browser workbench.

**It is a simulation and analysis tool, not a navigation instrument.** Numerical agreement
with reference data is not field accuracy.

- The [design brief](BRIEF.md) is the original proposal.
- [Conventions](CONVENTIONS.md) fix every sign, unit, frame and file format.
- [Architecture](ARCHITECTURE.md) explains the crate layout and the reasons behind it.
