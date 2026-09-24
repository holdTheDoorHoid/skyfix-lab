# Motion and independent navigation checks (module C)

This file is normative for `crates/skyfix-motion`. Where it and the code disagree, the
code is wrong until this file is amended in the same change. `docs/CONVENTIONS.md`
remains normative for units, signs, time and the solver; this file only adds what motion
brings.

Module C does three things:

1. **Running fixes.** Sights taken while under way are converted to equivalent
   stationary sights at one reference instant, with the dead-reckoning uncertainty folded
   into their sigmas, and handed unchanged to `skyfix_core::solver::solve`.
2. **Disagreement checks.** Two navigation estimates are compared, and the output says
   *"these two disagree beyond their modelled uncertainty"* — never *why*.
3. **Three distinct measurement types.** Relative motion, absolute heading and absolute
   position are separate Rust types, and nothing converts one into another silently.

The crate depends only on `skyfix-core` plus `serde`. It builds for
`wasm32-unknown-unknown`.

---

## 1. The dead-reckoning model

A `Track` is a list of `Leg { start_utc_jd, course_deg, speed_kn }`. Each leg holds its
course and speed until the next leg begins, or until the track's optional end. **Before
the first leg the vessel is treated as stationary** — `Track::covers` exists so a caller
can find out, and `running_fix` emits a warning when a sight falls outside the track.

### Displacement

`Track::position_offset(from, to)` integrates the velocity and returns the flat
tangent-plane displacement in nautical miles:

```
north = sum_i  v_i T_i cos(c_i)
east  = sum_i  v_i T_i sin(c_i)
```

with `T_i` in hours and `v_i` in knots, so `d_i = v_i T_i` is nautical miles. Three hours
at ten knots on course 045 gives 21.2132 NM north and 21.2132 NM east.

`Track::advance(point, from, to)` applies the same run to a real position, one leg at a
time, as a great-circle step. A leg is therefore modelled as a **great-circle segment on
its initial course**, not as a rhumb line. Over the tens of miles a running fix spans the
two differ by far less than the dead-reckoning uncertainty itself; the choice is recorded
rather than assumed.

Running the interval backwards is **not** a walk on reciprocal courses. On a sphere the
back-azimuth of a great-circle leg differs from `course + 180` by the convergence of the
meridians, and a reciprocal-bearing walk back along a 30 NM leg at 40 N misses its start
by about 200 m. `advance` inverts the forward walk numerically instead — a few fixed-point
steps from the reciprocal-bearing guess, converging because the forward walk is very
nearly an isometry — so `advance(advance(p, a, b), b, a) == p` to machine precision. A
test pins the size of the naive error so it cannot be re-introduced.

### Time resolution

Times are `jd_utc` as `f64`. Near 2026 one ulp is about 4.7e-10 days, so a difference of
two Julian dates resolves about 40 microseconds; at 12 knots that is a quarter of a
millimetre of run. Every distance in this module carries that sub-millimetre jitter, which
is a property of the time representation and not of the model.

### Displacement uncertainty

`MotionUncertainty { speed_sigma_kn, course_sigma_deg, random_walk_nm_per_sqrt_hour }`.

The first two terms are **biases held for the whole run**. A speed-log scale error and a
compass or steering error do not resample themselves every leg. This is BRIEF
"non-negotiable physical distinctions" item 6 applied to motion: repeating a measurement
does not average away a common bias. The third term is a genuine random walk (set,
current, steering wander).

For segments `i` with duration `T_i` (hours), distance `d_i` (NM), along-track unit vector
`u_i = (cos c_i, sin c_i)` and cross-track unit vector `n_i = (-sin c_i, cos c_i)`, both in
`(north, east)`:

```
A = sum_i T_i u_i          NM per knot of speed error    (along-track sensitivity)
B = sum_i d_i n_i          NM per radian of course error (cross-track sensitivity)

C = sigma_v^2 A A^T  +  sigma_c^2 B B^T  +  q^2 T_total I
```

`C` is the 2x2 covariance of the displacement, NM^2, rows and columns `(north, east)`.
`displacement_covariance_rad2` and `_m2` are the same matrix in the other two units.

For a single leg this reduces to the textbook form: along-track standard deviation
`sigma_v T`, cross-track standard deviation `d sigma_c`, ellipse oriented along and across
the course. Because `A` and `B` are **sums of vectors**, two legs on reciprocal courses
cancel the bias terms exactly — an out-and-back run at one speed has no net along-track
speed error. An independent-per-leg model would instead report `sqrt(2)` times one leg's
error, which is wrong in the direction that matters.

`MotionUncertainty::default()` is all zeros, deliberately. An unstated dead-reckoning
uncertainty must not quietly become a plausible-looking one.

---

## 2. Advancing the geographic position

An altitude depends only on the angular distance between the observer and the body's
geographic position: `Hc = 90 deg - dist(P, G)`. So moving the observer by `D` is the same
as moving the GP by `-D`:

```
h(P + D, G)  ==  h(P, G - D)
```

Let `D_i` be the vessel's displacement **from the reference instant to the sight instant**,
so the observer at the sight was at `P_ref + D_i`. The equivalent stationary sight at
`P_ref` keeps the measured `Ho` and moves the GP by `-D_i`. When the sight is older than
the fix, `-D_i` points the way the vessel is going, which is the classic "advance the line
of position along the run".

### Why the components cannot simply be reused at the GP

`-D_i` is a (north, east) pair in the observer's local frame. The GP is tens of degrees
away, and between the two the meridians converge: the bearing from the GP back to the
observer is *not* the observer's azimuth plus 180. Applying `-D_i`'s components at the GP
as if it were a plane errs by **23 439 m** on a 30 NM run at 40 N with the body due east
(pinned in `naive_component_move_is_catastrophically_wrong`). That is not an
approximation; it is a mistake.

### What this module does instead

The run is applied as a **rigid rotation of the sphere**. `R` is the rotation carrying the
estimated reference position to the estimated sight position — axis `P_ref x P_sight`,
angle `dist(P_ref, P_sight)` — and the GP is moved by `R^-1` (Rodrigues). Because a
rotation is an isometry,

```
dist(P, R^-1 G)  ==  dist(R P, G)      exactly, for every P
```

so the advanced sight is **exact** at the position the rotation was built from, and the
entire approximation collapses to one statement:

> The run is treated as the same rigid rotation wherever the vessel actually was.

The true run — "course 045 for 30 NM" — is not a rotation, because the direction "045"
itself turns as you move east or west. So `R P` and the true advanced position drift apart
as `P` leaves the linearisation point.

### The measured error

`running_fix::approximation_error_m` compares the advanced-GP altitude at a true position
against the exact altitude at the moved observer. Swept over latitudes 25/40/55 N, courses
000/045/135/225, runs of 10 and 30 NM, body altitudes 15/45/75 deg, four azimuths and four
offset directions:

| error of the reference estimate | max error over the sweep | closed form |
|---|---|---|
| 0 NM (at the linearisation point) | **0.000 m** | 0 |
| 1 NM | **23.010 m** | 23.081 m |
| 5 NM | **115.052 m** | 115.407 m |
| 10 NM | **230.103 m** | 230.814 m |

The closed form is the meridian convergence over the run:

```
error_m  =  run_NM * offset_NM * tan(latitude) * NM_M^2 / EARTH_RADIUS_M
         =  0.5388 * run_NM * offset_NM * tan(latitude)   metres
```

(`tan 55 deg = 1.428` at the worst latitude in the sweep). Measurement and closed form
agree to better than 0.5 %, so the test asserts against the formula rather than against a
magic constant.

**Headline number:** for runs up to 30 NM at mid-latitudes the advance-the-GP error is
**zero at the linearisation point and below 24 m once the reference estimate is within
1 NM of the truth** — smaller than the sight noise, and far smaller than the
dead-reckoning uncertainty it sits alongside. It is why `prepare` re-linearises (up to
`MAX_PASSES = 3` passes) whenever a solve moves the reference estimate more than
`RELINEARISE_THRESHOLD_NM = 1.0`.

Two limits worth naming: the error grows linearly in latitude's tangent, so a polar
running fix needs a closer initial estimate; and the model says nothing about a vessel
that did not actually hold the course and speed the track claims — that error is the
dead-reckoning uncertainty of section 1, not this one.

---

## 3. Folding the dead-reckoning uncertainty into the sigmas

A sight's Jacobian row in tangent-plane displacement is `[cos Zn, sin Zn]` (CONVENTIONS
section 3), so a run with covariance `C_i` (radians of arc squared) adds

```
sigma_motion_i^2 = [cos Zn_i, sin Zn_i] C_i [cos Zn_i, sin Zn_i]^T
sigma_i'^2       = sigma_i^2 + sigma_motion_i^2
```

with `Zn_i` computed at the current reference-position estimate using the **advanced** GP
— the same row the solver will use. Only the run uncertainty *along the line of sight*
matters: a run error at right angles to the body slides the observer along its own line of
position and changes no altitude. A sight taken at the reference instant has zero
displacement and is not inflated at all.

### The caveat that rides on every running fix

`C_i` for different sights share the same speed bias and the same course bias, so the
inflated sigmas are **correlated across sights**. `skyfix_core::solver::solve` models sight
errors as independent and no off-diagonal term is passed to it. Every `FixResult` from
`running_fix` therefore carries two `Warning::Other` entries:

- one naming the reference instant, the longest run, the linearisation point, the number
  of passes, and the fact that **the sigmas behind this fix are not the instrument
  sigmas**;
- one saying the covariance is **optimistic — a lower bound** — because the correlation is
  not modelled.

That warning is measurably true, not decorative. Over 300 seeded repetitions of scenario
(a), with the vessel's true speed and course drawn from exactly the modelled sigmas,
**92.3 %** of running fixes land inside their own nominal 95 % ellipse (binomial 1-sigma on
300 samples is 1.3 %, so this is a real shortfall, not noise). Mean Mahalanobis distance is
1.29.

---

## 4. The disagreement statistic

Two absolute positions with covariances `Ca` and `Cb`, separated by `d` metres on the
tangent plane:

```
chi2 = d^T (Ca + Cb)^-1 d          2 degrees of freedom
k    = sqrt(chi2)                  "times their combined modelled uncertainty"
p    = exp(-chi2 / 2)              exact survival function, chi-square with 2 dof
beyond_modelled_uncertainty = p < 0.01     (equivalently k > 3.035)
```

Headings use the 1-dof analogue, `p = erfc(k / sqrt 2)` with a Chebyshev fit for `erfc`
(fractional error below 1.2e-7, four orders inside the 0.01 threshold), and differences are
taken modulo 360 so 359 deg and 1 deg are two degrees apart.

Adding the covariances assumes the two estimates are **independent**. A sextant and a GNSS
receiver usually are; a celestial fix compared against a GNSS-aided dead-reckoning track is
not, and then `Ca + Cb` is too large and the test too forgiving. A combined covariance that
is not positive definite claims zero variance in some direction, so any separation along it
reports `k = inf`, `p = 0`.

### The statement

Always this sentence, with different numbers:

> Estimate A (*source*) and estimate B (*source*) at *utc* disagree by *m* m, *k* times
> their combined modelled uncertainty.

followed verbatim by `compare::INDISTINGUISHABLE_CAUSES`:

> This check cannot tell these causes apart: clock error, instrument bias,
> ephemeris/almanac error, dead-reckoning error, a wrong or spoofed reference, or an
> underestimated covariance. It reports a disagreement, not a diagnosis.

The word **"spoofing" never appears as a conclusion** anywhere in this crate. "A wrong or
spoofed reference" appears only as one of six equally-ranked entries in that list, and a
test asserts both facts.

Scenarios (c) and (d) below are the demonstration: a displaced GNSS and a 30-second
chronometer error produce statements whose skeletons — the sentence with every number
replaced — are **byte-for-byte identical**. The check cannot tell them apart, and it does
not pretend to.

---

## 5. Why relative motion needs a scale source

`ScaleKnowledge` is part of `RelativeDisplacement`, not an afterthought:

- `Metric` — the displacement really is in metres.
- `UnknownScale { nominal_scale, scale_sigma }` — the displacement is in *some* consistent
  unit.

A monocular camera measures direction and *relative* distance. Nothing in the image says
how big anything is: double every distance in the scene and double the camera's motion and
every pixel is unchanged. Optic flow therefore yields a direction and a shape, not a number
of metres, until a scale source is supplied — a stereo baseline, a known object size, a
speed log, or a pair of absolute positions bracketing the legs.

`integrate_odometry(start, legs)` succeeds only when **every** leg is `Metric`. Otherwise
it returns `ScaleError::NoMetricScale` naming the offending sources and saying so. The
`nominal_scale` a pipeline carries is recorded for provenance and is **not** promoted to a
measurement — it is a guess, and a guess is not a scale source.

`integrate_odometry_with_anchor(start, legs, anchor)` estimates one common scale for the
non-metric legs from the anchor pair:

```
s     = ((d_anchor - d_metric) . d_unscaled) / (d_unscaled . d_unscaled)
var s = u^T (C_start + C_end + C_metric + s^2 C_unscaled) u / |d_unscaled|^2
```

with `u` the unit vector along the unscaled displacement. The scale is reported with its
sigma, and that sigma enters the integrated position's covariance as a rank-1 term along
the unscaled displacement. Two refusals are built in: an anchor that does not bracket the
legs in time constrains a different stretch of motion, and an out-and-back track whose net
unscaled displacement is no larger than the anchor's own uncertainty carries no scale
information at all.

---

## 6. Replay

`replay(celestial_fixes, reference_track)` interpolates the reference track to each fix
instant and returns one `Disagreement` per comparable fix. `replay_detailed` adds the
interpolated reference, the skipped fixes and `Summary { n, n_beyond, worst }`; `to_csv`
and `to_json` export.

Between reference samples `A` at `t0` and `B` at `t1`, with `w = (t - t0) / (t1 - t0)`:

- **Position**: linear on the tangent plane, exact at the samples.
- **Covariance**: `(1 - w) Ca + w Cb`, plus an isotropic term with 1-sigma
  `k w (1 - w) L`, where `L` is the samples' separation in metres and `k` is
  `ReplayOptions::interpolation_sag_coefficient` (default 1.0).

Both are deliberately conservative. The linear blend is what perfectly correlated endpoint
errors give — the right assumption for consecutive samples of one receiver sharing one bias
— and never drops below the smaller endpoint. Independent-error interpolation would give
`(1-w)^2 Ca + w^2 Cb`, which is *smaller* in the middle of a gap and would make the replay
flag disagreements it has no business flagging. The sag term encodes what linear
interpolation cannot know — what the vessel did between samples. It is zero at the samples,
peaks at `L / 4` mid-gap, is negligible for a 1 Hz track and correctly enormous for an
hourly one.

**Extrapolation is refused.** A fix outside the track's span is listed in
`ReplayResult::skipped`, never compared against the nearest endpoint. `to_csv` emits the
skips as `#` comment rows and ends with a summary row, so a short file cannot read as a
clean one.

---

## 7. Results

Produced by `cargo test -p skyfix-motion -- --nocapture`. Seeds are fixed; every number
below is reproducible.

### (a) Three star sights taken under way

A vessel making 10 knots on course 045 takes sights at T-3 h, T-1.5 h and T from azimuths
045, 165 and 285. The vessel's *true* speed and course are drawn from the modelled sigmas,
so the navigator's dead reckoning is wrong by exactly as much as the model allows; each
altitude carries independent 1-arcminute noise.

| quantity | stationary solve on the raw sights | running fix at T |
|---|---|---|
| residual RMS | **7.01 arcmin** | **0.54 arcmin** |
| distance from truth | **24.31 NM** | **3265 m (1.76 NM)** |
| Mahalanobis from truth | — | **1.56** |

Noise-free and with the true track equal to the dead-reckoning track, the running fix
recovers the truth to **0.000 m** — the advance-the-GP construction contributes nothing
measurable of its own.

Coverage over 300 seeds: **92.3 %** inside the nominal 95 % ellipse, mean Mahalanobis
**1.29**. See section 3.

### (b) What the motion uncertainty does to the sigmas

3 hours at 10 knots on 045 (a 30 NM run), speed sigma 0.5 kn, course sigma 2 deg, no random
walk, against a 1.000-arcminute sight:

| line of position | sigma_motion | sigma_total |
|---|---|---|
| along track (Zn 045) | **1.5000'** | **1.8028'** |
| cross track (Zn 135) | **1.0472'** | **1.4480'** |
| due north (Zn 000) | **1.2936'** | **1.6350'** |
| astern (Zn 225) | **1.5000'** | **1.8028'** |

Along track the speed error alone: `sigma_v T = 0.5 x 3 = 1.5` NM. Across it the course
error alone: `d sigma_c = 30 x 2 deg = 1.0472` NM. Due north, at 45 degrees to both:
`sqrt((1.5^2 + 1.0472^2) / 2) = 1.2936` NM. Astern is the same line of position as ahead.

### (c) and (d): two causes, one statement

| | (c) GNSS displaced 2 NM | (d) chronometer 30 s fast |
|---|---|---|
| separation | **3704.0 m** | **10 669.5 m** |
| closed form | 2 NM = 3704 m | `cos(40) x 15.041 deg/h x 30 s` = 10 669.5 m |
| `k` | **4.00** | **11.52** |
| `p` | 3.357e-4 | 1.494e-29 |
| beyond modelled uncertainty | **yes** | **yes** |
| statement skeleton | identical | identical |

The clock error is *exactly* a longitude error for a star-only session (CONVENTIONS section
6): the fix slides west by `omega dt` with **residuals still at the noise level**. Nothing
in the sights reveals it, and the disagreement check reports it in the same words as a
displaced reference. At 120 s the separation is 42 677.9 m against a closed form of
42 678.0 m.

A related result worth stating: folding the dead reckoning into the sigmas **costs
sensitivity**. The same 2 NM offset that is 4.00 sigma against a 0.5 NM stationary fix is
only **0.86 sigma** against a running fix with its honest covariance; 4 NM gives 2.77 and
6 NM gives 4.68. That is the price of an honest uncertainty, and it should be stated rather
than engineered away.

### (e) Monocular odometry with unknown scale

Five optic-flow legs, true scale 37.5 m per sensor unit, pipeline nominal 30.0 (20 % low),
GNSS anchor pair with 5 m sigma perturbed by its own noise.

| | result |
|---|---|
| `integrate_odometry` without an anchor | **`ScaleError::NoMetricScale`**, naming all five leg sources |
| scale from the anchor pair | **37.685 +/- 0.857 m/unit** (truth 37.5) |
| error | **0.22 sigma** |
| nominal used as a prior? | **no**, reported only |
| 2-sigma coverage over 200 seeds | **100 %** |

With a noise-free anchor the scale comes back exact to 1e-9.

### (f) Heading across the 0/360 wrap

| A | B | separation | `k` (1 dof) | beyond |
|---|---|---|---|---|
| 359.2 (sigma 1.0) | 1.4 (sigma 0.8) | **2.20 deg** | 1.72 | no |
| 719.2 | -358.6 | **2.20 deg** | 1.72 | no |
| 10.0 | 190.0 | **180.00 deg** | 140.56 | yes |
| 0.0 (sigma 0.5) | 3.5 (sigma 0.5) | **3.50 deg** | 4.95 | yes |

The same angles written with different representatives give the same answer, and the
statement carries the same causes list as a position disagreement.

### Replay

Seven hourly celestial fixes against a 30-minute GNSS track over a six-hour passage, with
the celestial chronometer going 30 s fast from the fourth fix onward:

```
2026-10-01T00:00:00.000Z  separation      0.0 m  k =  0.00  beyond = false
2026-10-01T01:00:00.000Z  separation      0.0 m  k =  0.00  beyond = false
2026-10-01T02:00:00.000Z  separation      0.0 m  k =  0.00  beyond = false
2026-10-01T03:00:00.000Z  separation  10669.5 m  k = 11.52  beyond = true
2026-10-01T04:00:00.000Z  separation  10669.5 m  k = 11.52  beyond = true
2026-10-01T05:00:00.000Z  separation  10669.5 m  k = 11.52  beyond = true
2026-10-01T06:00:00.000Z  separation  10669.5 m  k = 11.52  beyond = true
summary: n = 7, n_beyond = 4, worst k = 11.52
```

---

## 8. What these scenarios do not prove

The scenarios build their own sky: a body placed at a chosen altitude and azimuth from a
chosen observer fixes its geographic position exactly, so no ephemeris is involved and the
truth is exact by construction. But that generator and the solver both use
`skyfix_core::geometry`, so a round trip shows they are **consistent**, not that either is
**correct**. Correctness of the geometry and the astronomy is established by the
independent Skyfield fixtures in `fixtures/reference/`, never from Rust output.

What these scenarios do establish is the motion layer on top: that a stationary solve on
sights taken under way is wrong by the size of the run; that the running fix removes that
error; that the advance-the-GP construction contributes nothing measurable at the
linearisation point and a known, closed-form amount away from it; that the reported
covariance under-covers by a measured amount because the correlation is not modelled; and
that the disagreement check fires identically for a cause it cannot see.

Further limitations, stated rather than discovered later:

- The sigma correlation across sights is **reported, not modelled**. Passing a full
  correlated covariance would need a solver change, which is out of this module's scope.
- The disagreement check assumes the two estimates are independent. Comparing a celestial
  fix against a GNSS-aided dead-reckoning track violates that and makes the check too
  forgiving.
- Leg covariances in `integrate_odometry` are summed in the starting frame; the frame's
  rotation along the path is not modelled. Over a track short enough for this integration
  to be meaningful it is far below the covariance itself.
- A leg is a great-circle segment on its initial course. A vessel steering a compass course
  follows a rhumb line; the difference is below the dead-reckoning uncertainty at these
  distances but grows with leg length and latitude.
- Nothing here detects spoofing, and nothing here should be read as claiming to.
