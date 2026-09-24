# The simulator and the experiment runner

`crates/skyfix-sim` generates observation sessions with known answers, and scores a
solver against them. It exists to answer one question the real world cannot answer
cheaply: **when the tool says it is confident, is it right to be?**

This document is normative for the simulator in the same way `CONVENTIONS.md` is
normative for the core: if the code and this file disagree, the code is wrong until this
file is amended in the same change.

---

## 1. Two documents, not one

Every run produces two things:

| document | what it holds | who may read it |
|---|---|---|
| `Session` (`skyfix.session/1`) | what a navigator would have written down: timestamps, altitudes, body directions, stated uncertainties | the reducer, the solver, the CLI, the UI |
| `Truth` (`skyfix.truth/1`) | the observer's real position, the seed, the size of every error injected, the ids of any deliberate blunders | simulator and evaluation code only |

The separation is structural, not a matter of discipline:

- `simulate()` returns `(Session, Truth)` as separate values. There is no field on the
  session that could hold a truth.
- The truth position is written in exactly one place in the crate, into `Truth::position`.
- Nothing in the crate passes a truth value into `SolveOptions`. `Experiment::check()`
  refuses to run an experiment whose `initializer` or `prior` has been pointed at the
  answer, and `run()` reports the refusal instead of producing numbers.
- A test serialises every packaged session to JSON and asserts that the strings
  `39.9526`, `75.1652` and the scenario's seed do not appear anywhere in it.
- On disk the two live apart: `fixtures/sessions/<name>.json` and
  `fixtures/expected/<name>.truth.json` (CONVENTIONS section 11).

### The one deliberate leak: the assumed position

A session usually carries an assumed position, because a real navigator has a
dead-reckoning position. The simulator's default is `OffsetFromTruth { distance_nm: 25
or 30, bearing_deg }`, which is derived from the truth and therefore discloses that the
answer lies within that radius.

This is disclosed rather than hidden. The session's `meta.notes` says so in words, and
the truth document repeats it. The alternatives, and when to use them:

| mode | what the session gets | use it when |
|---|---|---|
| `OffsetFromTruth` | a DR position a stated distance from the answer | the default: realistic, and its disclosure is bounded and stated |
| `Explicit(LatLon)` | a position the author chose | you want a specific starting point with no relation to the truth |
| `None` | no assumed position | you want to test multistart with no help at all |
| `Truth` | the answer itself | only to study initialisation. The session's notes then say, in capitals, that it is not a blind experiment |

The role is always `initializer` in the packaged demos. CONVENTIONS section 8 is explicit
that an initializer must never quietly become a prior, and a test asserts it for every
demo.

---

## 2. Sign conventions

These are the two things easiest to get backwards, so they are stated once here and
tested directly.

### Clock offset

```
clock_offset_s = recorded_time - true_time
```

A **positive** `clock_offset_s` means the clock runs **fast**: the timestamps written
into the session are **later** than the instants the sights were really taken at.

What follows from that, for star sights:

- The estimator looks the body up in the almanac at the time it believes, which is the
  recorded time. The tabulated GHA is therefore `omega * dt` too large, with
  `omega = 15.041 07 deg/h` for stars.
- Only `LHA = GHA + lon_east` enters the altitude, so the only way to reproduce the
  measured altitudes is with a longitude that is smaller by the same amount.
- **A fast clock moves the fix west.** Latitude is untouched. The residuals are zero.

The displacement is exact, not an approximation:

```
delta_lon_deg = -omega * clock_offset_s / 3600
```

`experiment::clock_longitude_shift_deg` computes it, and
`experiment::clock_shift_east_m` converts it to metres at a given latitude. The packaged
`clock-offset` demo uses `clock_offset_s = 60`, giving **-0.250 684 477 degrees of
longitude**, which at 39.9526 N is **-21 353.8 m** (-11.53 NM).

The scenario knob `almanac_lookup` controls whether the emitted body direction is
evaluated at the recorded time (`recorded_time`, the default, and the point of the
experiment) or at the true time (`true_time`, a control case in which a clock offset has
no effect at all).

`reported_clock_uncertainty_s` is a separate, *reported* knob: it is what the session
tells the estimator about its clock, and it need not match `clock_offset_s`. That is the
honest response to a clock you do not trust: declare the uncertainty and let the solver
widen the east-west part of the covariance (CONVENTIONS section 6).

### Shared altitude bias

```
Ho_emitted = Ho_true + shared_altitude_bias_arcmin / 60 + noise + blunder    (degrees)
```

A **positive** bias means **every** sight reads **too high**. It is added to every sight
identically; repeating a sight does not average it away.

### Where the errors are applied

Every error knob is applied in `Ho` space, to the fully corrected altitude. The altitude
the estimator reconstructs is therefore exactly

```
Ho_true + bias + noise + blunder
```

with no dependence on the correction chain. When the session emits raw sextant readings,
that `Ho` is then run *backwards* through the chain (section 4 below). This choice makes
every experiment exactly predictable; the alternative, injecting the blunder into the raw
reading, would make the resulting `Ho` error depend on the refraction slope at that
altitude.

### Missing sights

`missing_fraction` drops an **exact count**: `round(count * missing_fraction)` sights,
chosen by shuffling the schedule indices. Asking for 20 % of 20 sights drops exactly 4,
not "about 4". Dropping all of them is an error, not an empty session.

### The blunder index

`wrong_sight.index` counts the **emitted** sights, after `missing_fraction` has dropped
any. "The third sight in the file" is therefore unambiguous. An index past the end is an
error, never a silent no-op.

---

## 3. Determinism

`rng.rs` is a hand-written generator, not `rand`. Two reasons, both load-bearing:
`rand` pulls in `getrandom`, which does not build for `wasm32-unknown-unknown` without
extra cfg flags; and a generator written here guarantees a bit-identical stream on native
and WASM, so a session generated in the browser matches one generated by the CLI.

- Seeding: **splitmix64** expands the 64-bit seed into the 256-bit state, so seeds 0, 1
  and 2 give well-separated streams.
- Stream: **xoshiro256\*\***, period 2^256 - 1.
- Normals: **Box-Muller**, two deviates per pair of uniforms, the second cached.

The stream values for a fixed seed are pinned as regression constants in the tests. They
are not taken from an external reference: the contract they protect is "the stream never
changes", because changing it changes every packaged session file.

### The draw order is part of the contract

For each run, in this order:

1. One normal per **scheduled** sight, in schedule order, multiplied by
   `altitude_noise_arcmin`. Drawn unconditionally, even when the noise is zero.
2. The drop permutation, only when `missing_fraction` actually drops something.

Drawing the noise first and unconditionally means a sight's noise value does not move
when you change the bias, the clock offset, or the missing fraction. Only the seed and
the sight count change it. That is what makes `good-geometry` and `clustered-geometry` a
controlled comparison: same seed, same noise values, different geometry.

Repetition `r` of an experiment uses seed `scenario.seed + r`, which splitmix64 then
diffuses, so consecutive repetitions are not correlated streams.

### Timestamps

`time::format_utc` truncates to the millisecond, and a Julian date only resolves about
40 microseconds around 2026, so a whole-second instant can format as `...:59.999Z`. The
simulator snaps to the nearest millisecond before formatting. The adjustment is under
half a millisecond, which is 0.000 002 degrees of GHA.

One consequence: a recorded timestamp reproduces its intended offset to about a
microsecond, not to the bit. Tests compare clock offsets to a millisecond and GHA shifts
to 1e-6 degrees.

---

## 4. The reverse correction chain

By default a session carries `observed_ho`: already corrected, so the reducer has nothing
to do. Set `altitude_kind` to `sextant_hs` and the simulator emits the raw reading a
navigator would have written down, over a natural **sea** horizon, for a **star** at
**centre** limb. That is the only instrument configuration the simulator produces;
artificial-horizon doubling and the Sun's semidiameter and parallax are not simulated.

The forward chain (CONVENTIONS section 5, with the steps that do not apply to a star over
a sea horizon left out):

```
Ha = Hs + IC - D            index correction added, dip subtracted
Ho = Ha - R(Ha)             refraction subtracted
```

The simulator runs it backwards:

```
Ha = Ho + R(Ha)             fixed point, because R depends on Ha
Hs = Ha - IC + D
```

with

- `D = 1.76' * sqrt(height_of_eye_m)`
- `R' = cot(Ha_deg + 7.31 / (Ha_deg + 4.4))` (Bennett 1982), scaled by
  `(P / 1010 hPa) * (283 / (273 + T_C))`

The refraction step has no closed-form inverse, so `optics::ho_to_ha` iterates
`Ha_{k+1} = Ho + R(Ha_k) / 60` from `Ha_0 = Ho`. It converges because `|dR/dHa| < 0.22`
everywhere Bennett is valid; the contraction is worst at the horizon and negligible
above 10 degrees. The iteration stops at 1e-12 degrees, which is six microarcseconds.

Note that `Ha` is slightly **less** than `Ho + R(Ho)`: refraction is evaluated at the
apparent altitude, not the observed one. At `Ho = 45 deg` the lift is 0.9945 arcmin, not
`R(45) = 0.9948`.

The session declares everything needed to undo the chain: `observer.height_of_eye_m`,
`observer.pressure_hpa`, `observer.temperature_c`, `instrument.index_correction_arcmin`
and `instrument.horizon = sea`. Sigma is unchanged through the chain for a sea horizon
(there is no halving), so the reported `sigma_arcmin` is the same number either way.

### Why this code is not `skyfix_core::corrections`

`optics.rs` restates dip and Bennett refraction rather than calling the reducer's
implementation. That is deliberate. If the simulator used the reducer's own code, a sign
error in the chain would cancel out and the round-trip test would pass with both halves
wrong. Two independent implementations of the same published formulae can only agree when
both are right.

The pinned Bennett values (standard conditions, arcminutes) are:

| Ha (deg) | R (arcmin) | almanac |
|---|---|---|
| 0 | 34.477 534 | 34.5 |
| 5 | 9.883 144 | 9.9 |
| 10 | 5.391 505 | 5.3 |
| 20 | 2.703 411 | 2.6 |
| 45 | 0.994 848 | 1.0 |
| 60 | 0.574 712 | 0.6 |

---

## 5. Geometry presets

`GeometryPreset` decides which of a scenario's bodies the schedule may use. All three
evaluate azimuths **at the truth position and the start time**: that is a scenario
authoring decision about which stars the navigator chose to shoot, and only the resulting
body list reaches the session.

- `as_given`: the sources exactly as listed.
- `clustered { window_deg }`: keep only the bodies inside one `window_deg` window of
  azimuth, choosing the window that holds the most (ties go to the lowest source index).
  If no window holds two, the two closest in azimuth are kept, and the scenario is still
  a valid, terrible, two-body geometry rather than an error.
- `well_spread { keep }`: pick the `keep` bodies whose azimuths have the largest minimum
  circular gap, by exhaustive search over subsets (body lists are a handful of stars;
  above 20 000 combinations it falls back to greedy farthest-point). The chosen bodies
  are then ordered by greedy farthest-point, so a truncated round-robin schedule still
  walks separated bodies.

---

## 6. The experiment runner and the coverage statistic

`Experiment` = a scenario + `SolveOptions` + a repetition count. `run()` re-seeds,
simulates, reduces, solves, and records for each repetition:

- the **actual** error: great-circle distance from the truth to the fix, and its signed
  north and east components in the tangent plane at the truth;
- the **predicted** uncertainty: `sigma_north_m`, `sigma_east_m`, the 95 % ellipse, and
  the clock term;
- the **Mahalanobis distance** `d = sqrt((x - truth)^T Cov^-1 (x - truth))`, and whether
  `d <= sqrt(5.991)`, which is the nominal 95 % ellipse (chi-square, 2 dof);
- the residual RMS and the worst residual, in arcminutes;
- the result kind: `unique`, `ambiguous`, `underdetermined`, `failed`, or
  `simulation_error`.

Aggregated over repetitions:

- `coverage_fraction`: the fraction of evaluated runs whose truth fell inside the
  ellipse. Under the ellipse's own model this should be 0.95.
- `coverage_stderr`: the binomial standard error `sqrt(p (1 - p) / n)`.
- `coverage_ci95`: the Wilson score interval.
- `rms_error_m` and `rms_predicted_sigma_m`, where the predicted radial sigma of a run is
  `sqrt(sigma_north^2 + sigma_east^2)`, and their ratio `error_to_sigma_ratio`. Under a
  correct model `E[|e|^2] = sigma_north^2 + sigma_east^2`, so the ratio should be about 1.
- `mean_error_north_m` and `mean_error_east_m`, **signed**. A shared bias or a clock
  offset shows up here as a non-zero mean, where `rms_error_m` alone cannot tell a
  systematic displacement from honest scatter.

### Why both a standard error and a Wilson interval

The binomial standard error collapses to zero at `p = 0` and `p = 1`. That is exactly
where the interesting scenarios land: `shared-bias` produces coverage near 0, and
reporting "coverage 0.00 +/- 0.00" would read as certainty where there is none. For 0
successes in 20 trials the Wilson interval is roughly (0, 0.16), which is the honest
statement: the true coverage is below about 16 %, not exactly zero.

Both are reported. A reader who only wants one number should use the interval.

### The correlated-error scenarios are supposed to fail

A runner that always reports 0.95 is not testing anything. Two packaged demos are
explicit failures of the independent-noise model, and their expected numbers are stated
here so a solver can be checked against them.

**`clock-offset`** (`clock_offset_s = 60`, no noise, five supplied star directions):

- the fix moves **-0.250 684 477 degrees** of longitude, i.e. **-21 353.8 m** east at
  39.9526 N; latitude is unchanged;
- every residual is zero;
- the reported ellipse does not grow at all unless `clock_uncertainty_s` is set.

**`shared-bias`** (24 sights of 3 stars, bias +3.0', noise 0.3'):

Computed from the closed form in `experiment::bias_shift_ne_m` on this scenario's own
sight azimuths (which drift a little over the 23 minutes of the schedule, so these are
not the textbook values for azimuths of exactly 45, 95 and 145 degrees):

| quantity | value |
|---|---|
| predicted fix shift, north | **-846.45 m** |
| predicted fix shift, east | **+6 964.31 m** |
| magnitude | **7 015.56 m** (3.79 NM) |
| predicted 1-sigma north | 177.56 m |
| predicted 1-sigma east | 147.68 m |
| predicted radial 1-sigma | 230.95 m |
| error / predicted sigma | **30.4** |

Expected coverage: near zero. Expected residual RMS: the bias alone leaves 0.689 arcmin
(worst residual 0.788 arcmin); with the 0.3 arcmin noise on top, about 0.75 arcmin. That
is close enough to the noise that nothing in the output looks wrong, which is the whole
point: the fix is 7 km out and the diagnostics are clean.

The three azimuths are deliberately lopsided. Three azimuths exactly 120 degrees apart
would absorb a shared bias entirely into the residuals and leave the position untouched;
that is the special case people wrongly generalise from, and
`bias_shift_is_zero_for_a_symmetric_triangle` pins it so nobody rediscovers it by
accident.

### Closed-form predictions

`bias_shift_ne_m` and `clock_longitude_shift_deg` never call `skyfix_core::solver`. They
are predictions derived from the tangent-plane model of CONVENTIONS section 3, so the
solver can be checked **against** them rather than compared with itself.

---

## 7. What these tests do and do not prove

**The simulator and the solver share `skyfix_core::geometry`.** The simulator computes
its true altitudes with `geometry::altitude_azimuth`, and so does the solver. A round-trip
test therefore proves that the two are **consistent**, not that either is **correct**. If
the spherical altitude formula were wrong, the simulator would generate altitudes
matching the wrong formula and the solver would recover the truth perfectly.

This is on purpose. Sharing the geometry is what makes the solver's numerical behaviour —
convergence, conditioning, ambiguity, covariance — testable in isolation from any
question about astronomy. But it means the round-trip tests must never be described as
validation of the physics.

Correctness of the geometry and the astronomy is established elsewhere, by evidence that
does not come from this crate:

- analytic spherical-triangle cases in `skyfix_core::geometry`'s own tests, worked by hand
  from the published formula;
- **independent Skyfield-generated fixtures** in `fixtures/reference/`, produced by
  `tools/reference/` with recorded generator version, ephemeris identifier, Earth
  orientation assumptions and tolerances (CONVENTIONS section 11). Those are the ground
  truth. A fixture must never be regenerated from Rust output.

What this crate's tests *do* establish, on their own:

- the random stream is reproducible and has the distribution it claims;
- the truth does not reach the estimator;
- the sign conventions are what this document says;
- the reverse correction chain and an independent forward chain agree;
- the injected errors are exactly the size requested;
- a shared bias does not average away, demonstrated over 4 000 sights with no solver
  involved at all;
- once the solver lands, whether its reported uncertainty means what it says.

### Other limitations

- The simulator models a **stationary** observer. No motion, no running fix.
- Supplied body directions advance **linearly** in GHA at a constant rate with a constant
  declination. Over the minutes a demo schedule spans, that is indistinguishable from the
  real thing; over hours it is not. Use named bodies and a provider for long schedules.
- Only a sea horizon is simulated for raw readings, and only stars: no artificial-horizon
  doubling, no semidiameter, no parallax.
- The Earth is a sphere everywhere (CONVENTIONS section 1). There is no ellipsoid
  correction, in the simulator or anywhere else in the project.
- `serde_json` in this workspace does not enable its `float_roundtrip` feature, so
  parsing a serialised `f64` can land one unit in the last place away from the original.
  One ULP of a GHA is about 1e-14 degrees, roughly a nanometre of position, so it changes
  nothing numerically. It does mean `assert_eq!` on a round-tripped struct is the wrong
  test to write.

---

## 8. The packaged demos

Six demonstrations, as ten scenario functions (eight of which need no astronomy
provider). Each carries a `description` written for someone
who does not read Rust, saying what it shows and what to look at.

| # | scenario | shows |
|---|---|---|
| 1 | `philadelphia-stars` | five star sights near Philadelphia, independent sub-arcminute noise: what healthy output looks like |
| 1 | `philadelphia-stars-real` | the same with six real navigational stars; needs an `AstroProvider` |
| 1 | `philadelphia-stars-sextant` | the same emitted as raw sextant readings, exercising the correction chain |
| 2 | `good-geometry` | six sights spread around the compass |
| 2 | `clustered-geometry` | the same six stars, same seed, same noise, restricted to a 30 degree window |
| 3 | `one-bad-sight` | five sights, the third 8 arcminutes high |
| 4 | `clock-offset` | every timestamp 60 seconds late, noise free |
| 5 | `shared-bias` | 24 sights of 3 stars, every one 3 arcminutes high |
| 6 | `single-sight` | one sight: a circle, not a position |
| 6 | `two-sight-ambiguous` | two sights: two intersections, neither promoted |

`demos::all()` returns the eight that need no provider, in demo order;
`demos::by_name()` also finds `philadelphia-stars-real`.

All demos except the named-star one use **supplied** body directions: synthetic bodies
placed at chosen altitudes and azimuths by inverting the geometry
(`scenario::body_at`, `scenario::gha_dec_for`, which invert
`geometry::altitude_azimuth` through `geometry::destination` and round-trip to 1e-9
radians). This is the brief's "first numerical slice": the demos exercise the reducer,
the solver and the uncertainty model without depending on any astronomy implementation,
so a failure has one possible cause instead of two.
