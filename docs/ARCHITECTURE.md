# Architecture

SkyFix Lab answers one question: *where do these sky observations place me, and how
much should I trust the answer?* Everything is arranged so that the numerical core is
small, pure and shared, and so that the physical limits of celestial navigation are
visible in the API rather than papered over.

## Crate map and data flow

```
 session JSON / CSV
        |
        v
 skyfix-core::session  -- validate, normalise            (no I/O anywhere in core)
        |
        v
 skyfix-core::reduce   -- for each observation:
        |                  direction  <-- supplied in the record, or
        |                                 skyfix-ephemeris (Sun, stars, fixture pack)
        |                  corrections <-- skyfix-core::corrections (six explicit steps)
        |                  Hc, Zn, intercept at the assumed position (if any)
        v
 skyfix-core::solver   -- weighted least squares on the sphere, multistart,
        |                  ambiguity classification, optional shared bias / robust / prior
        v
 skyfix-core::uncertainty -- a-priori covariance, nominal 95 % ellipse, conditioning
        |
        v
 FixResult { underdetermined | ambiguous | unique | failed }
        |
   +----+-----------------------------+
   v                                  v
 skyfix-cli (files, tables, JSON)   skyfix-wasm -> web/ (TypeScript workbench)

 skyfix-sim -- seeded scenarios -> (Session, Truth) kept in separate documents;
               experiment runner compares true error with predicted uncertainty.
```

- `skyfix-core` owns units, time, the altitude model and its derivatives
  (`geometry`), the correction chain, validation, the solver and uncertainty. It does no
  file or network I/O and builds for `wasm32-unknown-unknown`.
- `skyfix-ephemeris` provides apparent geocentric directions of date behind the
  `AstroProvider` trait. Providers declare coverage and refuse out-of-range queries.
- `skyfix-sim` generates observations from a hidden truth using the same `geometry`
  kernel, injects independent noise, shared bias, clock offset, missing and wrong sights,
  and evaluates the solver against the truth.
- `skyfix-cli` and `skyfix-wasm` are thin: parse, call core, print.
- `web/` is a Vite + TypeScript workbench with every asset bundled. Truth appears only in
  its simulator view.

## Why these choices

**One geometry kernel.** The solver, the simulator, the planner and the reducer all call
`geometry::altitude_azimuth` and `geometry::tangent_row`. Round-trip agreement between
simulator and solver therefore proves consistency only; correctness is established
separately by fixtures generated with Skyfield (`fixtures/reference/`), which never touch
Rust output.

**Result kinds instead of a number.** One sight gives a circle. Two give two points.
`FixResult` makes the caller handle `underdetermined` and `ambiguous` explicitly; there is
no way to get a lat/lon out of the solver without choosing to ignore the kind.

**No hidden prior.** An assumed position is an initializer unless the session says
`role = prior` with a sigma, in which case the result reports the fix with and without it.

**A-priori covariance.** With two or three sights the residuals cannot estimate their own
noise, so the covariance uses the declared sigmas. Posterior scaling is opt-in and only
reported with at least three degrees of freedom.

**Clock is propagated, not estimated.** For stars, a shared clock error is exactly a
longitude shift, so estimating both is meaningless. The declared clock uncertainty becomes
an east-west covariance term that is reported separately.

**Compact ephemeris.** The Sun (VSOP87-based) and the 57 navigational stars plus Polaris
(Hipparcos positions with IAU 2006/2000 precession, nutation and aberration) fit in a few
hundred kilobytes and cover 1990-2060 with documented accuracy, so the browser build needs
no multi-megabyte planetary ephemeris. Other bodies use a dated fixture pack that says
"limited-date operation" in its coverage notes.

**Own random generator.** The `rand` stack pulls in `getrandom`, which does not build for
`wasm32-unknown-unknown` without extra configuration. A 60-line splitmix64/xoshiro256**
generator with Box-Muller normals is deterministic and bit-identical on native and WASM.

**Spherical Earth, 1' = 1 NM.** Star altitudes depend only on direction, so the spherical
altitude formula with geodetic latitude is exact for stars; the sphere only enters the
conversion of angular position error to metres, where a 0.3 % radius difference is
irrelevant at the tens-of-metres level.

## Conventions

`docs/CONVENTIONS.md` is normative for every sign, unit, frame and schema. Each numerical
module cites the section it implements.

## Development process

The project was built by a planning model coordinating parallel engineering agents, each in
its own git worktree and branch (`agent/<name>`), with `docs/CONVENTIONS.md` and
`skyfix-core::types` fixed first as the shared contract. Reference fixtures were generated
by a separate agent with an independent toolchain (Python + Skyfield). Integration,
review and the completion report are the planner's.
