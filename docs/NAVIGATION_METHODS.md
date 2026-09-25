# Navigation methods: noon sight, Polaris, averaging, running fix

**Status:** normative for `crates/skyfix-core/src/methods/` and the navigation exports in
`crates/skyfix-wasm/src/nav.rs`. Where this file and the code disagree, the code is wrong
until this file is amended in the same change. `docs/CONVENTIONS.md` stays normative for
units, signs, time, the correction chain and the solver (its section 14 points here);
`docs/MOTION.md` stays normative for the running fix. The wire shapes are in
`docs/EXPLORER_API.md`, "Wave 1 — navigation methods".

A position fix from several bodies is `solve`. These are the other things a navigator
does with a sextant, the ones the owner asked for from the Celestial Navigator app:

| method | what goes in | what comes out |
|---|---|---|
| **Noon sight** (§2) | a run of altitudes of one body around its meridian passage — or one altitude | latitude; the time of meridian passage and a (weak) longitude |
| **Polaris** (§3) | one or more altitudes of Polaris and a DR longitude | latitude, and the Nautical Almanac's a0/a1/a2 for teaching |
| **Averaging** (§4) | a run of altitudes of one body over a few minutes | one averaged sight, ready for a fix |
| **Running fix** (§5) | sights taken while under way, the course and speed | a fix at one instant, the same shape `solve` returns |

Everything here is a simulation and analysis workbench, not a navigation instrument.

---

## 1. Rules every method follows

**One reduction, once.** Every observation goes through `reduce::reduce_observation`,
so the CONVENTIONS section 5 chain runs exactly as it does for a fix and the declared
`altitude_kind` decides which steps run (CONVENTIONS 4: never twice). A sight the
reducer rejects becomes a `Warning::Other` naming it; the method goes on with the rest.
Every result returns its reduced sights (`sights`), so the correction workings are
always visible. Per-sight caveats (low altitude, supplied direction, already corrected)
stay on those sights; the result's own `warnings` carry what the method adds.

**The DR is never a prior.** A method takes a `DrPosition {lat_deg, lon_deg, sigma_nm}`
(default: the session's assumed position, with the prior's `sigma_nm` if its role is
`prior`). It is used to *choose* (which side of the zenith, which root), to *predict*
(when noon should be, how fast an altitude changes) and to *propagate* (a latitude that
depends on the longitude carries the longitude's uncertainty). It never pulls an answer
towards itself (CONVENTIONS 8). `sigma_nm` is the 1-sigma error in each of north and
east; when it is not stated nothing replaces it with a plausible guess, and every result
that would have used it says what is missing.

**A moving vessel.** `VesselMotion {course_deg, speed_kn}` (speed at most 1000 kn either
way, which admits an aircraft's bubble sextant) is constant over the run and
the track is the great circle through the method's reference position with that course
there. Over the minutes of a noon or averaging run this is the dead-reckoning track to
well under a metre; the running fix (§5) has its own leg model (`docs/MOTION.md`).

**Body directions and rates.** Each method builds a `BodyTrack`: the direction provider
when any sight uses it, otherwise a straight line through the run's own supplied
directions (the user's almanac wins, CONVENTIONS 10). Every rate — GHA rate, altitude
rate, curvature — is taken *numerically* from that track, never assumed, so a body with
its own motion is handled like the Sun and the stars (CONVENTIONS 13.1).

**Time.** Sight instants are `jd_utc` after the session's chronometer correction. A
reference instant given in options (`reference_utc`) is on the same corrected scale as
every time a result reports. The session's `clock.uncertainty_s` is propagated wherever
it matters (a noon longitude, a latitude that depends on hour angle).

**Units.** Degrees on the wire; small angles and every latitude sigma in arcminutes
(= nautical miles); longitude sigmas both in arcminutes *of longitude* and in nautical
miles east–west; times in seconds; rates in arcminutes per minute (CONVENTIONS 1).

**Three sigma.** Outlier flags and consistency checks use 3 standard deviations: about
one false alarm in 370 when everything is as stated.

**Warnings** (CONVENTIONS 12), added for these methods:

| code | raised when |
|---|---|
| `flat_peak_longitude` | a noon longitude is reported (always — it is the caveat) |
| `meridian_near_zenith` | the meridian altitude is above 85° |
| `meridian_side_ambiguous` | the DR does not clearly say which side of the zenith the body passed |
| `not_at_meridian_passage` | a single "maximum" was recorded more than 15 min (+3 sigma of the DR's prediction) from the DR's noon |
| `one_sided_run` | every noon sight is before, or every one after, meridian passage |
| `curvature_inconsistent` | the free-curvature fit disagrees with the predicted curvature by more than 3 sigma |
| `slope_inconsistent` | the free-slope fit disagrees with the predicted slope by more than 3 sigma |
| `run_outlier` | a sight's leave-one-out normalised residual exceeds the threshold (with `rejected`) |
| `polaris_near_pole` | the Polaris latitude is above 88° N or Polaris bears more than 20° from north |

---

## 2. Noon sight

### 2.1 What it computes

From a run of altitudes of one body around its **upper meridian passage** `T` — the
instant `LHA = 0` of the apparent geocentric GHA, the Almanac's "meridian passage"
(CONVENTIONS 13.3) — the method gives:

- the **latitude** at `T`, from the meridian altitude `H0`: on the sphere, at `LHA = 0`
  exactly, `sin H0 = cos(phi − dec)`, so `phi = dec + (90° − H0)` when the body is south
  of the zenith and `phi = dec − (90° − H0)` when it is north. The result states the
  rule it used, with the numbers, in `latitude_rule`;
- the **time of meridian passage** `T`, with its sigma;
- the **longitude** `−GHA(T)`, with its (large) sigma and the plain-language
  `longitude_caveat` (§2.5).

The DR is required: it picks the side of the zenith (unless `body_bearing` says
`north` or `south`) and predicts when noon should be (`dr_check`).

### 2.2 The curve, and the default fit

Near `T` the altitude follows

```
h(t) = H0 + a (t − T) − k (t − T)^2 + (higher order)
k    = (1/2) w^2 cos(phi) cos(dec) / cos(H0)       w = d(LHA)/dt
a    = dH0/dt                                      declination change, the vessel's run north or south
```

For the Sun at 40° N at the equinox (`H0` about 50°) `k` is 0.039′/min²: the Sun is
within 1′ of its highest for about five minutes either side of noon. At `H0 = 79.6°`
`k` is 0.14′/min²; within 2° of the zenith it is 0.77′/min² and the top of the curve is
not a parabola at all but a V.

**The default (`curvature: "predicted"`) does not approximate the curve.** The unknowns
are the observer's latitude and longitude at the reference instant; the model altitude
of every sight is the exact CONVENTIONS 3 altitude from that sight's own direction, with
the observer moved along the DR track if the vessel is under way; the fit is weighted
Gauss–Newton in the tangent plane, re-centred until the reference instant *is* `T`
(Newton on the wrapped LHA). `k`, `a`, the peak and the curve drawn in `model_curve` are
then *read off* the exact curve. This is right in the cases a parabola gets wrong: sights
far from noon, a moving vessel, and the V-shaped peak near the zenith.

The covariance is `(J^T W J)^-1` (CONVENTIONS 9), in tangent-plane radians: latitude
sigma from the north term, longitude sigma from the east term divided by `cos(phi)`,
`sigma_T = sigma_lon / w`. The clock adds `w_GHA · sigma_t` to the longitude and
`sigma_t` to `T`, in quadrature, and `clock_sigma_arcmin` reports that part.

If the run cannot time the peak at all (a condition number above 10^6, CONVENTIONS 9's
limit — two sights a minute apart, say) the method falls back to §2.4's latitude-only
solution on the DR meridian and says so.

### 2.3 Fitted curvature (`curvature: "fitted"`, three or more sights)

The navigator's classic method: a free parabola through the sights, `k` not trusted to
the geometry. To set *only* the curvature free, the exact curve's non-parabolic
remainder `e_i = h_exact(t_i) − (H0 + a τ_i − k τ_i²)` (taken at the §2.2 solution) is
removed first, and `y_i = Ho_i − e_i` is fitted with `c0 + c1 τ + c2 τ²`
(`τ` in minutes from the §2.2 passage, weights `1/sigma²`). Then, with `k_fit = −c2`
and the geometry's `a`,

```
T  - T_exact = (c1 − a) / (2 k_fit)          (minutes)
H0           = c0 + (c1² − a²) / (4 k_fit)
```

and their sigmas follow from the 3 × 3 covariance by the delta method. The latitude is
`H0` read on the same side; the longitude is `−GHA(T)`. Whichever computation is not
chosen is reported in `alternative`. Either way `curvature` compares the two:
`z = (k_fit − k) / sigma(k_fit)`, `consistent = |z| <= 3`, and `|z| > 3` raises
`curvature_inconsistent` — a wrong time, a wrong body, or course and speed not entered
(20 knots east unreported makes the LHA run 2 % fast and the curve 4.5 % sharp, which
31 sights of 0.1′ see at many sigma).

### 2.4 One altitude

`single_altitude: "maximum"` (the default) reads the one altitude as the **peak** the
navigator watched for. On a vessel running north or south, or with the declination
changing, the peak is `a²/4k` above the meridian altitude, so `H0 = Ho − a²/4k`
(`max_minus_meridian_arcmin`; 0.07′ for Bowditch's 10 knots on 045). `H0` belongs to
the instant of meridian passage, so the declination is taken there too: at the passage
the DR longitude predicts (`dr_check.predicted_passage_utc`), as a navigator takes the
Almanac declination for the time of meridian passage. The recorded time is the peak's,
`a/2k` from passage; for the Moon, whose declination moves up to 0.27′ a minute, that is
minutes, and the declination at the recorded time would put the latitude out by `a²/2k`
(1.3′ at 55° N in the verifier's noise-free check). When the DR's `sigma_nm` is stated,
the passage time's own uncertainty moves the declination, and that is in the latitude's
sigma. There is no longitude, and `longitude_caveat` says why. If the recorded time is
more than 15 minutes (plus three sigma of the DR's own prediction) from the DR's noon,
`not_at_meridian_passage` asks whether this really was the peak.

`single_altitude: "ex_meridian"` reads it as an altitude **at the recorded time** and
reduces it to the meridian by solving the altitude equation for latitude on the DR
meridian — exactly, not with the classical `k t²` table. The same latitude-only solution
serves any number of sights (and is the §2.2 fallback). Its sigma adds the DR
longitude's term `|d(phi)/dE| sigma_E`, where `d(phi)/dE = −Σ w cos Zn sin Zn / Σ w cos²
Zn` is reported as `longitude_sensitivity_arcmin_per_nm`; at the meridian it is zero,
twenty minutes after noon at 30° N it is about 0.2′ per NM.

### 2.5 Why the longitude is weak: the flat peak

The longitude is nothing but the time of the peak, and the peak is flat. With `N` sights
of sigma `sigma_h` spread over `±D` minutes, the peak time is known to about
`sigma_h / (2 k · rms(τ) · sqrt(N))`: for 21 Sun sights of 0.5′ over ±20 minutes at
Philadelphia's equinox noon that is **7.0 s**, i.e. 1.7′ of longitude, 1.3 NM
east–west — while the latitude from the same sights is good to 0.11′. Every
4 seconds of timing error move the longitude 1′. Every result with a longitude carries
`flat_peak_longitude` and a `longitude_caveat` with its own numbers — for that run,
verbatim:

> Near noon the Sun's height hardly changes: for about 5 minutes either side of the peak
> it is within 1′ of its highest. The time of the peak — and the longitude, which is
> nothing but that time — is therefore uncertain by ±7 s (1 sigma): ±1.7′ of longitude,
> ±1.3 NM east–west. The latitude does not suffer from this: it comes from how HIGH the
> peak is, not WHEN it happened. Every 4 seconds of timing error move the longitude 1′.

### 2.6 A moving vessel: the peak is not the passage

A vessel running away from the body lowers the meridian altitude as it goes (`a < 0`),
and the peak comes `a / 2k` *before* meridian passage. At 15 knots on 010 from 45° N in
June the peak comes **126.5 s** early. Give `vessel` and the method models it exactly.
Leave it out and the method takes the peak for the passage: in that fixture case the
longitude comes out **32′** wrong (its sigma 1.2′) while the latitude moves only 0.19′ —
the peak's *height* hardly changes, its *time* does.

### 2.7 Other honest limits

- **Near the zenith** (`H0 > 85°`): the bearing swings fast, the altitude is hard to take
  with a sextant, and the side decides the latitude by twice the zenith distance.
  `meridian_near_zenith`. The exact curve still fits the V-shaped peak.
- **Which side?** When the DR sits closer to the other side's answer, or (with
  `body_bearing: "auto"`) more than a third of the way towards it, or within three of its
  stated `sigma_nm` of it, `meridian_side_ambiguous` gives both latitudes.
  `body_bearing` settles it. (The third rule matters near the zenith, where the two
  answers are a few tens of miles apart: a DR 24 NM off can sit right on the wrong one.)
- **One-sided runs**: every sight before (or after) `T` means the peak time is an
  extrapolation. `one_sided_run`.
- **Upper transit only.** Lower transit of circumpolar stars is not a noon sight here.

---

## 3. Latitude by Polaris

### 3.1 The rigorous solution

No table. With `Ho` of Polaris, its apparent GHA and declination at the sight (from the
ephemeris, through the same direction-source plumbing a fix uses) and the DR longitude,

```
sin Ho = sin(phi) sin(dec) + cos(phi) cos(dec) cos(LHA),    LHA = GHA + lon_DR
```

is solved for `phi` exactly: with `A = sin dec`, `B = cos dec cos LHA`, `R = hypot(A,B)`,
`psi = atan2(B, A)`, the roots are `asin(sin Ho / R) − psi` and `pi − asin(sin Ho / R) −
psi`; the one nearest the DR latitude is taken. No root means no latitude on that meridian
sees Polaris that high, and the sight is set aside with a warning.

### 3.2 Its sigma

Three terms in quadrature, each reported separately:

- **altitude:** `sigma_Ho / |cos Zn|`;
- **DR longitude:** to first order `|tan Zn| · sigma_E` (`d(phi)/dE = −tan Zn`, reported
  as `longitude_sensitivity_arcmin_per_nm`). It is evaluated by 3-point Gauss–Hermite
  quadrature — the latitude solved again on meridians `sqrt(3) sigma_E` east and west, and
  the root-mean-square change taken — which equals the first-order term when the
  dependence is linear (to under 1 % at 45° N) and follows it where it is not;
- **clock:** `|cos(phi) tan Zn| · w · sigma_t`.

At ordinary latitudes Polaris bears within a degree or two of north: across the
fixture's cases from 1° to 75° N a 10 NM error in the DR longitude moves the latitude by
0.02′ to 0.25′, depending on Polaris' hour angle. **Several sights** are combined with
weights `1 / sigma_alt²`; the DR-longitude and clock terms are shared by every sight and
are carried through the combination whole (they do not average down), and each sight's
normalised residual against the combination is reported.

### 3.3 Near the pole

Polaris' polar distance is about 0.64°. Within a couple of degrees of the pole it is
nearly overhead, its bearing can be anywhere, and the latitude depends strongly on the
longitude: a DR good to 30 NM at 88.5° N is 19° of longitude, and the latitude's error
becomes bounded and lopsided (−10.7′ at −20° of longitude, +7.7′ at +20°) rather than
Gaussian. No single sigma evaluated at the (wrong) DR can cover that exactly: measured,
the stated sigma covers **89.8 %** of cases where it should cover 95 %. With a DR good to
5 NM there it covers 96.0 %. `polaris_near_pole` (above 88° N, or Polaris more than 20°
from north) says the latitude depends on the longitude and the sigma is approximate.

### 3.4 The Nautical Almanac's a0, a1, a2 (for teaching)

The printed Polaris table gives `Latitude = Ho − 1° + a0 + a1 + a2`, computed (Nautical
Almanac, explanation of the Polaris tables) from

```
Latitude − Ho = − p cos h + (1/2) p sin p sin² h tan(Latitude)
a0 = 58.8′ − p0 cos h0 + (1/2) p0 sin p0 sin² h0 tan 50°      (LHA Aries only)
a1 =  0.6′ + (1/2) p0 sin p0 sin² h0 (tan phi − tan 50°)        (LHA Aries and latitude)
a2 =  0.6′ − p cos h + p0 cos h0                                (LHA Aries and date)
```

with `p = 90° − dec` Polaris' polar distance, `h = LHA Aries + SHA` its hour angle, and
`p0`, `h0` using the year's mean SHA and declination (the table's "adopted mean
position", computed here as the mean of 73 samples, every five days through the calendar
year). The three constants add to 1°, so each term is positive. Every Polaris sight
carries these terms **unrounded** (`almanac`), the latitude they give, and its difference
from the rigorous answer (0.001′ in Bowditch's example and within 0.001′ everywhere
inside the table's range in §6.1; the printed table rounds each term to 0.1′). The printed a1 table runs
from 0° to 68° N; beyond it `within_printed_table` is false and the note says only the
rigorous latitude applies. The latitude a1 is entered with is the DR latitude, as the
navigator would enter it. The terms need the GHA of Aries, which the core does not
compute: the caller supplies a `PolarisTableSource`
(`skyfix_ephemeris::stars::EphemerisPolarisTable`, which the WASM adapter and
`skyfix polaris` both pass).

---

## 4. Averaging a run of sights

### 4.1 The model

A plain mean of altitudes at the mean time is only right if the altitude changes in a
straight line. Here the *shape* is predicted and only the *level* is fitted:

```
p(t)  = Hc(DR(t), body(t))       the altitude the ephemeris predicts at the DR (and the vessel's run)
Ho_i  = p(t_i) + b + e_i         one unknown, b, weighted least squares
Ho(t) = p(t) + b                 the averaged sight at any chosen instant
```

`p` goes through the ordinary geometry and the body's own ephemeris, so its slope is the
real rate at the DR (−11.34′/min for Vega setting over Philadelphia; +13.16′/min for a
morning Sun from a vessel making 12 knots towards it) and its small curvature comes
along. The DR's error enters only through the slope, and weakly: 15 NM off changed
Vega's predicted rate by 0.15 %. `predicted_slope_arcmin_per_min`
and `predicted_curvature_arcmin_per_min2` (the second derivative) report the shape.

### 4.2 The instant, and the sigma

`reference_utc` defaults to the weighted mean time of the sights used; there the sigma
is exactly `sqrt(1 / Σ w)` (`sigma / sqrt(N)` for equal sigmas) and the slope's own
error cancels. At any other instant `Δt` minutes away the slope's error
`sigma_slope · Δt` is added in quadrature, where `sigma_slope` is the slope's gradient
over one NM times the DR's stated sigma. With no DR sigma stated that term is left out
and the result says so.

### 4.3 Outliers

Each sight's residual is also taken against the line through the *other* sights and
divided by its own standard deviation:
`normalized_loo = r_i / (sigma_i sqrt(1 − w_i / Σ w))` for a sight in the fit, and
`r_i / sqrt(sigma_i² + 1 / Σ w)` for one already left out. Both are standard normal when
the sight is as good as its sigma says, which the plain `r / sigma` (CONVENTIONS 9, also
reported as `normalized`) is not: a blunder drags the fit towards itself. Above the
threshold (3) the sight is flagged, `run_outlier`, and by default left out — one at a
time, worst first, while three or more remain. Two sights that disagree are both flagged
and both kept: nothing can say which is wrong.

Before dropping a sight the method asks which explanation is better: dropping the worst
sight removes exactly `z_loo²` of chi-square, freeing the slope removes exactly
`z_slope²`. When the slope explains the misfit better, the run is not "good sights and
one bad one" — the times, the body, the DR or the course and speed are wrong — so nothing
is dropped and the result says so.

### 4.4 The free slope

With four or more sights the slope is also fitted freely,
`Ho_i = p(t_i) + b + c (t_i − t_mean)`. `z = c / sqrt(sigma_c² + sigma_slope²)` tests the
predicted slope; `|z| > 3` raises `slope_inconsistent`. The free line's own averaged
altitude and sigma are in `free_slope` for comparison. On clean runs `z` is standard
normal (measured, §6.3).

### 4.5 The averaged observation

`observation` is the averaged sight as a session `Observation`: `observed_ho`, so the
chain never runs on it again (CONVENTIONS 4), sigma as above, notes naming the sights
used. A run of supplied directions supplies one here too, read off the same line; a run
the provider answered leaves it to the provider. Put into a session that declares an
index correction or a height of eye, it draws the ordinary `already_corrected` note —
which is right: those corrections are already inside it. The chronometer correction
draws no such note, because the reducer applies it to every recorded time, so the
observation's `utc` is written on the session's chronometer like the sights it averages
(the averaged instant minus `clock.correction_s`): reduced in that session it lands on
the averaged instant. Written on the corrected scale it would be corrected twice (a
verifier's check: 30 s of correction moved a Vega line of position 5.7′).

---

## 5. Running fix

The running fix already exists in `skyfix-motion` and `docs/MOTION.md` is normative for
it: each sight's geographic position is advanced along the dead-reckoning run by a rigid
rotation of the sphere, the run's uncertainty is folded into each sight's sigma along its
line of sight, and the equivalent stationary sights go to `solve` unchanged. This module
only exposes it:

- `running_fix(session, request)` reduces the session, builds the `Track` from the
  request's legs (`{start_utc, course_deg, speed_kn}`; the first leg's start may be left
  out and then starts at the earliest sight), the `MotionUncertainty` from its three
  sigmas, and returns the same `FixResult` `solve` does, with the workings: the reference
  instant, the linearisation point, the passes and each sight's sigma inflation.
- `skyfix_motion::running_fix::running_fix_report` was added so the workings come from the
  same call as the fix; `running_fix` itself now delegates to it and is unchanged.
- The request itself — reducing the session, building the track and the motion sigmas,
  the warnings for rejected sights and unstated sigmas — is
  `skyfix_motion::request::running_fix_session`, so the WASM export and `skyfix
  running-fix` run the same code. Each fills the solver options from the session by its
  own `solve` rules first.
- Motion sigmas all zero (the default) mean "not stated": the fix then treats the run as
  exact, and the result says so rather than inventing values.
- The caveat from `docs/MOTION.md` travels with every result: the inflated sigmas are
  correlated across sights and the solver treats them as independent, so the covariance
  is **optimistic** (measured 92.3 % coverage of the nominal 95 % ellipse there).

---

## 6. Validation

### 6.1 Against independent truth (Skyfield)

`tools/reference/gen_nav_methods.py` (Skyfield 1.55 + JPL DE421 + Hipparcos, GHA with
UT1 = UTC as CONVENTIONS 6 assumes) writes `fixtures/reference/nav_methods.json`:
noise-free sights whose truth is computed there and nowhere else — meridian passage by
Newton iteration on Skyfield's geocentric LHA, altitudes by the CONVENTIONS 3 formula at
the true position, sextant readings by running the CONVENTIONS 5 chain backwards in
Python. `crates/skyfix-core/tests/nav_methods_reference.rs` feeds the **raw sextant
readings** through our ephemeris, corrections and method, with the DR 5–12 NM off:

| noon case | latitude | longitude | passage | notes |
|---|---|---|---|---|
| Philadelphia, equinox, 21 Sun sights ±20 min | −0.0010′ | +0.0006′ | 0.000 s | `k` 0.0389′/min² |
| Sydney, December solstice (Sun bears north) | +0.0006′ | +0.0009′ | 0.000 s | `H0` 79.6° |
| 15 kn on 010 from 45° N | −0.0005′ | +0.0013′ | 0.000 s | peak 126.5 s before passage |
| Sun 2.1° from the zenith, 21 sights ±10 min | −0.0004′ | +0.0012′ | 0.000 s | V-shaped peak, `k` 0.77′/min²; warns |
| Altair's upper transit | +0.0001′ | −0.0001′ | 0.000 s | any body |

Every case also passes with `curvature: "fitted"`, and the fitted curvature agrees with
the predicted one. **Polaris** at ten latitudes from 1° to 89.8° N recovers the latitude
to within **0.0001′** (the ephemeris limit), LHA Aries to 0.00001′ against Skyfield's
sidereal time, and raises `polaris_near_pole` exactly at 88.5° and 89.8°. The Almanac
formula stays within 0.001′ of the rigorous answer inside the printed table's range and
drifts to 0.08′ at 85°, 0.8′ at 88.5° and 16′ at 89.8°, which is why only the rigorous
answer is ever used. **Averaging** three runs — Vega over Philadelphia, a morning Sun from
a vessel making 12 knots, Sirius rising through 8° (refraction in play) — gives the true
altitude at the mean instant to **0.0000′** and the predicted slope to the Skyfield rate
within 0.0001′/min. The **running fix** (`crates/skyfix-wasm/src/nav.rs` tests) recovers
a 36 NM run due north to **0.4 m**; on 045 held as a true rhumb line it is **36 m** off,
which is skyfix-motion's great-circle-leg model (`docs/MOTION.md`) against a real
compass course.

### 6.2 Against the published worked examples

*The American Practical Navigator* (Bowditch), NGA Pub. No. 9, 2019 edition, volume 1,
chapter 19 "Sight Reduction", sections 1910 and 1912, and figure 1912c (the Nautical
Almanac 2016 Polaris table page with its own illustration) — a U.S. Government work in the
public domain; the numbers are typed with provenance into
`fixtures/reference/bowditch_worked_examples.json`, and
`crates/skyfix-core/tests/nav_methods_worked_examples.rs` reproduces them. The book works to
0.1′ with the Almanac's rounded tables.

**§1910, latitude at local apparent noon** (9 March 2016, 12-08-04 ZT, DR 39°49.0′ N
044°33.0′ W, 10 kn on 045; Hs 45°54.0′ lower limb, IC +0.2′, height of eye 68 ft):

| | Bowditch | SkyFix | difference |
|---|---|---|---|
| dip | −8.0′ | −8.013′ | −0.013′ |
| declination | S 4°09.9′ | S 4°09.858′ | +0.042′ |
| Ho | 46°01.5′ | 46°01.427′ | −0.073′ |
| latitude | N 39°48.6′ | N 39°48.785′ | +0.185′ |

The +0.19′ is three tenths-level pieces, each accounted for: the Almanac's combined
altitude correction is printed as +15.3′ where the unrounded chain gives +15.24′ (0.07′);
the declination (0.04′): the Almanac's is rounded, and SkyFix takes it at the meridian
passage the DR predicts, 0.008′ from its value at the book's observed LAN (§2.4); and
the method reads one altitude as the *peak*, which on a vessel
making 7 knots north is 0.070′ above the meridian altitude, while the book takes its
altitude *at* LAN. Read as an altitude at 15:08:04 reduced on
the DR meridian (`ex_meridian`) the latitude is +0.157′ from the book.

**§1912, latitude by Polaris** (22 March 2016, 23-18-56 UT, DR 40°46.0′ N 043°22.0′ W,
Ho 40°52.1′):

| | Bowditch | SkyFix | difference |
|---|---|---|---|
| LHA Aries | 127°15.1′ | 127°15.119′ | +0.019′ |
| a0 | 54.9′ | 54.932′ | +0.032′ |
| a1 | 0.5′ | 0.524′ | +0.024′ |
| a2 | 0.9′ | 0.913′ | +0.013′ |
| latitude | N 40°48.4′ | N 40°48.468′ | +0.068′ |

**The Almanac's own illustration** (21 April 2016, 23h 18m 56s UT, W 37°14′,
Ho 49°31.6′): LHA Aries 162°57′ (SkyFix 162°57.26′), a0 1°18.9′ (78.914′), a1 0.6′
(0.600′), a2 0.9′ (0.910′), latitude 49°52.0′ (49°52.019′, +0.019′).

### 6.3 Do the sigmas mean what they say?

`crates/skyfix-core/tests/nav_methods_coverage.rs`: seeded Monte Carlo on the fixture's
independent sights, noise of the stated sigma, errors against the fixture's truth divided
by the sigma each method reported. Honest sigmas put 95 % inside 1.96 and make the mean
square 1; the test allows three binomial / chi-square standard deviations.

| check | runs | inside 1.96 sigma | mean (e/sigma)² |
|---|---|---|---|
| noon latitude (predicted curvature) | 400 | 95.8 % | 0.990 |
| noon passage time / longitude (predicted) | 400 | 96.0 % | 0.929 |
| noon latitude (fitted curvature) | 400 | 95.0 % | 1.032 |
| noon passage time / longitude (fitted) | 400 | 96.0 % | 0.936 |
| Polaris, 55° N, DR ±30 NM, clock ±5 s | 400 | 94.5 % | 1.061 |
| Polaris, 75° N, DR ±30 NM, clock ±5 s | 400 | 93.8 % | 1.049 |
| Polaris, 88.5° N, DR ±5 NM | 400 | 96.0 % | 0.976 |
| **Polaris, 88.5° N, DR ±30 NM (19° of longitude)** | 400 | **89.8 %** | **1.377** — the §3.3 limit, asserted as such |
| averaging, at the mean instant | 400 | 94.8 % | 1.053 |
| averaging, 3 min from the mean (DR drawn from its sigma) | 400 | 95.2 % | 1.036 |
| free-slope `z` on clean runs | 500 | 94.8 % | 1.051 |

Outliers on the same seven-sight Vega run: **1.6 %** of clean runs have a false alarm
(about 2 % expected at 3 sigma); a 6-sigma blunder is found in **99.4 %** of runs and is
the only sight flagged in 97.8 %.

### 6.4 Reproducing every number here

```console
tools/reference/.venv/bin/python -m tools.reference.gen_nav_methods     # the fixture
cargo test -p skyfix-core --test nav_methods_reference -- --nocapture
cargo test -p skyfix-core --test nav_methods_worked_examples -- --nocapture
cargo test -p skyfix-core --test nav_methods_coverage -- --nocapture
cargo test -p skyfix-wasm nav -- --nocapture                              # running fix
```

---

## 7. What these methods do not do

- A noon longitude is weak by nature (§2.5); nothing here makes it strong.
- The noon sight handles upper transit only.
- The Polaris sigma is approximate within a couple of degrees of the pole when the DR's
  longitude uncertainty is a large angle (§3.3).
- A moving vessel is a constant course and speed for noon and averaging runs; a vessel
  that did not hold it is outside the model, and the curvature and slope checks are the
  only place it shows.
- The running fix's covariance is optimistic (`docs/MOTION.md` §3).
- Clock error is exactly longitude for a noon sight, as for star fixes (CONVENTIONS 6):
  it is propagated, never estimated.
- Sun and stars only in this wave; the Moon and planets come with wave 2 (§8).

---

## 8. For the Moon and planet sights (wave 2)

The methods are body-agnostic by construction — every rate comes from the body's own
track — so a validated Moon or planet provider makes them work without changes here,
provided:

- **The provider is in the direction source.** The WASM exports use `auto_provider()`
  (`crates/skyfix-wasm/src/lib.rs`); the Moon and planet providers must join it.
- **The correction chain learns the new bodies.** `corrections.rs` applies semidiameter
  and parallax only when `is_sun`; the Moon needs its SD (with augmentation), its large
  `HP cos Ha` parallax, and the planets their parallax and phase. The methods inherit
  whatever the chain does.
- **The solver's clock rate.** `ProviderSource::gha_rate_deg_per_hour` (skyfix-ephemeris)
  returns only the solar or the sidereal rate, and `reduce::to_sights` hands that to the
  solver's clock term; CONVENTIONS 13.1 requires the Moon's numerical rate (about
  14.5°/h). `BodyEphemeris::gha_rate_deg_per_hour` already computes it. These methods do
  not use that trait method except as a last resort for a single supplied direction.
- **The Moon's noon is not the Sun's.** Its declination changes up to about 1° an hour,
  so `a` is large, the peak can be minutes from the passage and `a²/4k` is no longer
  negligible for a single "maximum" — all of which the exact curve already models. The
  straight-line track through supplied directions is fine over minutes, not hours.
- **Lunar distance** is a new method with its own clearing of the distance; nothing here
  covers it.
- **The Moon's Earth-shape term** (expansion programme, CONVENTIONS 15.4). The Moon's
  model altitude is the sphere's plus the part of its parallax the sphere leaves out, up
  to 0.24′, and on the meridian that term is the whole error of a latitude reduced on
  the sphere. The noon method's exact curve, its free parabola, the single maximum and
  the ex-meridian latitude all use the model altitude, the meridian altitude it reports
  is an `Ho` (the sphere's plus the term), and the rule it states reads
  `latitude = declination ± (90° − (meridian altitude − term))`, with the term's value in
  the sentence. The averaging method predicts the Moon's altitude the same way, and an
  averaged Moon sight keeps the Moon's horizontal parallax in its direction so a fix made
  from it keeps the term. A running fix takes the term at the estimated position at each
  sight. `crates/skyfix-core/tests/moon_earth_shape.rs`: a noise-free Moon run on the real
  Earth (term +0.22′ at 50° N) gives the latitude to 1e-6′ by the curve, 0.001′ by a
  single maximum and 4e-6′ ex-meridian.

---

## 9. Compass error: by azimuth and by amplitude (expansion programme, geomag agent)

**Status:** normative for `crates/skyfix-core/src/methods/compass.rs` and the export
`compass_error` in `crates/skyfix-wasm/src/geomag.rs` (wire format: `docs/EXPLORER_API.md`,
"Expansion programme — magnetic field and compass error"; conventions: CONVENTIONS 14.1-14.2).

The sky is the navigator's one independent check of a compass. Take the compass bearing of
a body, work out its true bearing, and the difference is the **compass error**. For a
magnetic compass that error has two parts: the **variation** (the Earth's field, the same
for every compass at that place, from the chart or a magnetic model) and the
**deviation** (this compass's own error, from the ship's steel and electrics, which
changes with the heading). A gyrocompass has only gyro error.

| what goes in | what comes out |
|---|---|
| a body, the time of the bearing, the position, the compass bearing; magnetic or gyro | true bearing, compass error (E/W), variation and deviation, in one sentence: "Compass error 14.4° W; variation 11.8° W; deviation 2.6° W." |

### 9.1 By azimuth (Bowditch 1501-1502)

The true bearing is the body's azimuth at the moment of the bearing: the topocentric
azimuth of its centre with the observer on the WGS84 ellipsoid, from the same apparent
geocentric GHA and declination that sights use (so a bearing and a sight never disagree
about where the body is). Refraction lifts a body but does not turn it, so the bearing
needs none. For the Sun and the stars this is the Zn of CONVENTIONS 3 (the tables' Zn) to
under 0.001°, and the result gives both; for the Moon the ellipsoid moves it by a few
thousandths of a degree.

Time matters when the bearing turns fast: the result gives the bearing's rate
(`azimuth_rate_deg_per_min`) and a note when 10 seconds of time moves it more than 0.05°.
Low bodies are easier to take a bearing of and turn slowly; a body far below the horizon at
the given time gets a note (wrong time, date or body). Polaris is the classic body: its
bearing changes by under a degree all night at mid-latitudes.

### 9.2 By amplitude (Bowditch 1503-1506)

An amplitude is the bearing of a body as it rises or sets, and needs no accurate time: at
the horizon the bearing depends only on the latitude and the declination.

- **Celestial horizon**: the body's centre at geocentric altitude 0 — for the Sun, its
  lower limb about two thirds of a diameter above the sea horizon; for the Moon, its upper
  limb on it. The amplitude is `sin A = sin dec / cos lat`, named E rising or W setting and
  N or S with the declination ("W 32.6° N" is 32.6° north of west).
- **Visible horizon** (the default, and Bowditch's advice at higher latitudes, where a
  misjudged celestial horizon costs most): the chosen limb or the centre on the sea
  horizon. SkyFix runs the correction chain of CONVENTIONS 5 for that moment — dip from the
  height of eye, refraction at the resulting slightly negative apparent altitude, the
  semidiameter, the parallax — to get the geocentric altitude `h` of the centre (about
  -0.7° for the Sun's centre from a ship's bridge, Bowditch's own figure; about +0.25° for
  the Moon, whose parallax more than makes up for refraction), then the exact bearing
  `cos Z = (sin dec - sin lat sin h) / (cos lat cos h)`. The difference from the
  celestial-horizon bearing is what Bowditch's Table 23 tabulates; here it is computed for
  the actual latitude, declination, height of eye and body. The Moon's opposite sign is why
  Bowditch tells the navigator to apply "one half of the correction toward the elevated
  pole" for the Moon.
- **The moment**: SkyFix finds the crossing of `h` nearest the time given (within 12
  hours), rising or setting as asked or as the body's side of the meridian says, and uses
  the declination at that moment. A crossing more than 30 minutes from the given time gets
  a note. The result reports how many degrees the bearing moves per degree of misjudged
  altitude (`bearing_per_altitude`); where the body meets the horizon at a shallow angle
  (high latitudes) that factor is large, and a note says what 0.1° of misjudgement costs.

### 9.3 Variation and deviation

A magnetic compass needs the variation to split its error. The navigator can give the
chart's (`variation_deg`, which wins); otherwise the model's is used at the observer and the
moment: WMM2025 for 2025-2030, IGRF-14 for 1900-2024 (CONVENTIONS 14.1). The model's
uncertainty comes with it and becomes the deviation's (±0.36° at Philadelphia; much more
near the magnetic poles, where the result carries the model's caution or blackout note).
After 2030 no model answers: the compass error is still found, the sentence stops there,
and a note says why. `deviation = compass error - variation`, east positive.

### 9.4 Validation

*The American Practical Navigator* (Bowditch), NGA Pub. No. 9, 2019 edition, vol. 1,
chapter 15 "Azimuths and Amplitudes" (a U.S. Government work); the numbers are in
`fixtures/reference/bowditch_compass_examples.json` and
`crates/skyfix-core/tests/compass_reference.rs` reproduces them. The book works to 0.1°
with Pub. No. 229, the Nautical Almanac's Polaris table and Bowditch Tables 22-23.

| example | Bowditch | SkyFix | difference |
|---|---|---|---|
| 1501, Sun's azimuth (Pub. 229 triple interpolation) | Zn 123.2°, gyro error 0.8° W | 123.187°, 0.813° W | 0.013° |
| 1502, Polaris 2016-02-23 04:21:15 UT (through the engine) | 359.2° (Almanac table), 0.7° W | 359.250°, 0.650° W | 0.050° (the table's rounding) |
| 1504, amplitude on the celestial horizon | W 32.6° N, 302.6°, 0.4° W | 32.666°, 302.666°, 0.334° W | 0.066° |
| 1505, Table 23 on the visible horizon | 10.3° S, 100.3°, correction +1.2°, 0.6° E | 10.351°, 100.351°, +1.219°, 0.633° E | 0.051° |
| 1506, the formula at Hc = -0.7° | 99.1°, 0.6° E | 99.133°, 0.633° E | 0.033° |

Against the engine's own geometry (`crates/skyfix-wasm/src/geomag.rs`): the azimuth method
equals `sky_state`'s `az_deg` to under 0.00001° for the Sun, the Moon, Jupiter, Vega,
Sirius and Polaris at four places and four dates between 1995 and 2049; Venus differs by up
to 0.006° by design (a bearing, like a sight, is of Venus's centre of light; `sky_state`
draws its geometric centre). An amplitude's bearing equals the body's topocentric azimuth
at the crossing to 0.0000° (Sun) and 0.003° (Moon, the ellipsoid), and the crossing is at
the chain's altitude to 0.00001°.

Reproduce:

```console
cargo test -p skyfix-core --test compass_reference -- --nocapture
cargo test -p skyfix-wasm geomag -- --nocapture
```

### 9.5 What it does not do

- **No deviation card yet.** Deviation changes with the ship's heading; a compass is
  "swung" by taking the error on many headings and tabulating it. Each result here is one
  heading's deviation; collecting them into a card is a later tool.
- **Local anomalies are not in any model.** WMM2025 and IGRF-14 are the core field;
  magnetised rock can move the local variation by degrees (NCEI: anomalies of 3-4° are not
  uncommon, some exceed 10°). A chart's local note wins over the model, and the stated
  uncertainty is a global average, not a guarantee at a point.
- **Heeling error, a compass that is not level, a misread card**: the compass's own
  problems are what the method measures, not what it corrects.
