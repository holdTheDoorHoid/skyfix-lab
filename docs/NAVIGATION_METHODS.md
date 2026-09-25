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

---

## 9. The sailings: passage planning and dead reckoning (expansion programme)

*Sailings agent, 2026-09-24. Code: `crates/skyfix-core/src/sailings/`; WASM:
`crates/skyfix-wasm/src/sailings.rs` (`sailing`, `dr_advance`, `route_positions`); wire
shapes: `docs/EXPLORER_API.md`, "Expansion programme — sailings". Normative for that code.*

### 9.1 What is offered

| sailing | what goes in | what comes out |
|---|---|---|
| **Great circle** (Bowditch 2019 vol. 1 ch. 12 §1208–1211) | departure, destination | distance, initial and final course, vertex, the latitude farthest from the equator, the equator crossing, waypoints |
| **Rhumb line** — Mercator sailing (§1219) | the same | course, distance, difference of latitude and longitude, departure, meridional difference |
| **Mid-latitude sailing** (§1218) | the same (one hemisphere) | course, distance, mean latitude, departure |
| **Composite sailing** (§1205, §1213) | the same and a limiting latitude | the great circle to the limit, the run along it, the great circle on; each leg |
| **Plane, parallel and traverse sailing** (§1215–1217) | courses and distances | difference of latitude and departure, course and distance made good |
| **Forward dead reckoning** | position, course, speed, hours, method | position, arrival time, the course on arrival |
| **Route** | start, legs `{start_utc, course_deg, speed_kn}`, instants | the position at every instant, each leg's end, course and distance made good |

Everything is on the sphere of CONVENTIONS section 1 (1′ of arc = 1 NM = 1852 m), with one
option: Mercator sailing may use the **WGS84 meridional parts** (§9.3). Distances are
given in nautical miles and kilometres.

### 9.2 The great circle

With the unit vectors `p1`, `p2` of the ends and the circle's pole `n = p1 × p2 / |p1 × p2|`,
the track is `p(s) = p1 cos s + (n × p1) sin s` for `s` radians run. That form is exact
everywhere the textbook trigonometry is not (short legs, legs along a meridian, a
departure on the equator). The initial and final courses are the bearings of the track's
direction at `s = 0` and `s = D`; the **vertices** are `±(ẑ − n_z n)/|…|`, at latitude
`acos |n_z|` (Clairaut: `cos φ sin C` is the same all along a great circle). Bowditch's
vertex is the one in the departure's hemisphere, reported with its signed distance along
the track (negative: behind the departure) and whether it lies between the ends.
Antipodal ends are refused (every great circle through them is 10 800 NM); coincident ends
give a distance of zero and no course.

**Waypoints** are placed either every *N* nautical miles from the departure or where the
track crosses every meridian that is a whole multiple of *M* degrees (`tan φ = −(n_x cos λ
+ n_y sin λ)/n_z`), as Bowditch recommends ("5° of longitude is a convenient length"); at
most 2000. Each carries the direction of the track there and the **rhumb line to the next
waypoint** — the course a navigator steers — and the running total of those rhumb legs,
which is what the vessel sails (slightly more than the great circle; the passage's notes
say how much). With a speed and a departure time every waypoint and the arrival get an
ETA, measured along those rhumb legs.

### 9.3 The rhumb line (Mercator sailing), on the sphere or with WGS84 meridional parts

`tan C = DLo / m`, `m = M(φ2) − M(φ1)`, `D = l sec C` (§1219), with the meridional parts
`M(φ) = (10800/π) · ψ(φ)` in minutes of equatorial arc and the isometric latitude

```
sphere (default):  ψ = atanh(sin φ)
wgs84:             ψ = atanh(sin φ) − e · atanh(e sin φ)          e² = 0.00669438
```

The formulas are arranged so that courses near due east or west stay exact: the distance
is `hypot(Δφ, q · DLo)` with `q = Δφ/Δψ` (which tends to `cos φ` on the sphere, so a
course of 090° is parallel sailing), and `Δψ` comes from the difference formula for
`atanh`, never from two large numbers subtracted. Going the other way, `DLo = D sin C / q`.
A rhumb line never reaches a pole (it spirals round it): a run that would is refused.

- **`sphere`** gives the true loxodrome on the sphere of 1′ = 1 NM, consistent with every
  other distance here.
- **`wgs84`** gives the course and difference of longitude of the loxodrome on the
  ellipsoid — what a Mercator chart on WGS84 shows and what Bowditch's Table 6 tabulates —
  and keeps Bowditch's `D = l sec C` with 1′ of latitude taken as 1 NM, as a navigator
  measures distance on the chart's latitude scale. That distance differs from the true
  length on the ellipsoid by the ratio of the local minute of latitude to 1852 m (−0.5 %
  at the equator, +0.5 % at the poles), and due east or west it is
  `DLo cos φ (1 − e² sin²φ)/(1 − e²)` rather than parallel sailing's `DLo cos φ` (at most
  0.67 % more, at the equator).

The two differ by the spheroid's stretch of the meridional parts, `e² cos²φ` of `m`: up to
0.16° of course on Bowditch's examples (§9.9). Bowditch's own Mercator examples need
`wgs84` to reproduce.

### 9.4 Mid-latitude, plane, parallel and traverse sailing

Mid-latitude sailing is Bowditch's approximation for short legs: `p = DLo cos Lm`,
`tan C = p / l`, `D = √(l² + p²)` with `Lm` the mean latitude. A leg across the equator is
run as two parts, each with its own mean latitude, when it is advanced; asked for the
course between two points on opposite sides of the equator it returns nothing (the two
parts would need two courses — the rhumb line answers instead). Plane sailing is
`l = D cos C`, `p = D sin C`; traverse sailing sums it over legs; parallel sailing is
`DLo = p sec L`, the rhumb line due east or west.

### 9.5 Composite sailing

When the great circle would carry the vessel beyond a limiting latitude `φL`, the track is
a great circle from the departure tangent to the parallel `φL`, the parallel itself, and
a great circle tangent to it on to the destination. The tangent great circles meet the
parallel at `cos DLov = tan φ / tan φL` from each end (Bowditch: `cos DLovx = tan Lx cot
Lv`), and the parallel is sailed by parallel sailing. The limit is signed (47 keeps the
track south of 47° N, −60 north of 60° S). When the great circle's vertex between the ends
is within the limit, the answer is the great circle itself and says so (`applies =
false`); an end already beyond the limit is refused. The composite track is longer than the
great circle by `extra_distance_nm` and carries waypoints like the great circle.

### 9.6 Forward dead reckoning

`dr_advance` runs one leg: the position `speed × hours` along a course, by one of three
models, and, from a start time, the arrival time.

| method | the leg is | use |
|---|---|---|
| `rhumb` (default) | the loxodrome of the course (Mercator sailing, §9.3) | a compass course held: what a vessel does |
| `mid_latitude` | Bowditch's approximation | teaching; agrees with the rhumb line to 1′ over 1253 NM in §1218's example |
| `great_circle` | a great circle on the initial course | the running fix's leg model (`docs/MOTION.md` §1) |

The rhumb and great-circle models part by the rhumb line's geodesic curvature
`sin C tan φ`: after `d` NM the ends are about `d² sin C tan φ / (2 · 3437.7)` NM apart,
across the track (249 m after 36 NM on 045° at 45° N; none on a meridian). A negative
number of hours gives where the vessel was: for a rhumb line and for mid-latitude sailing
that is the reverse run, exactly; for a great-circle leg it is the point from which the
forward leg arrives here (found numerically, as `skyfix-motion` inverts a leg — a
reciprocal-bearing walk misses by the convergence of the meridians). The result also
gives the course on arrival, which turns along a great circle.

### 9.7 Routes: the position at any time

A route is a start position and instant and a list of legs in the running fix's own shape
(`{start_utc, course_deg, speed_kn}`, `RunningFixLeg`), so the legs of a DR track drawn
here go to `running_fix` unchanged. The first leg may omit its start (it then starts with
the route); every later leg needs one; starts must increase. `route_positions` reports the
position at any list of instants and every so many minutes to the route's end, each with
its leg, the distance run and a status: `under_way`, `waiting` (at the start before a later
first leg), `before_start` (the start position is given, not extrapolated) or `after_end`
(the vessel is taken to have stopped). It also reports each leg's end and the course and
distance made good from the start (the rhumb line joining them). With `method =
great_circle` the positions are those of `skyfix_motion::track::Track::advance`, the
running fix's DR, to within a millimetre (test `a_great_circle_route_is_the_running_fixs_track`).

### 9.8 The sphere against WGS84

The sphere of 1′ = 1 NM is not the Earth: a minute of latitude is 1842.9 m at the equator
and 1861.6 m at the poles, a minute of longitude on the equator 1855.3 m. Measured in
`crates/skyfix-core/tests/sailings_wgs84.rs` against Vincenty's geodesic on WGS84 (whose
implementation reproduces the Geocentric Datum of Australia's worked example, Flinders
Peak to Buninyong, to 1 mm, and the WGS84 quarter meridian, 10 001 965.729 m) and against
the WGS84 loxodrome:

| comparison | worst over 19 806 random pairs (latitudes within 80°, up to 170° apart) |
|---|---|
| great-circle distance on the sphere vs the WGS84 geodesic | 0.502 % |
| rhumb-line distance on the sphere vs the WGS84 loxodrome | 0.502 % |
| 10 NM legs at latitudes 0° to 89° | 0.514 % |

So **distances here are within 0.52 % of the ellipsoid's** — about 5 NM on a 1000 NM
passage, far inside what currents, leeway and steering do to a passage, and the reason
Bowditch (§1200) calls the sphere adequate.

### 9.9 Validation against Bowditch's worked examples

`fixtures/reference/bowditch_sailings.json` types every numbered worked example of
Bowditch 2019 vol. 1 ch. 12 (26 cases, 77 compared quantities: the chapter the 2002
edition numbered 24); `crates/skyfix-core/tests/sailings_worked_examples.rs` runs each
through the library and prints the whole table (`-- --nocapture`). Every quantity agrees
to the printed precision (0.1′, 0.1 NM, 0.1° or 0.01° where the book prints it), except
where the book's own four-decimal arithmetic or a rounding carried forward moves the
printed number further; there the tolerance is that rounding carried through, and the
case says why. A selection:

| example | quantity | Bowditch | SkyFix | why they differ |
|---|---|---|---|---|
| §1208 ex. 1, 22° S 116° E → 20° S 31° E | distance | 4693.5 NM (Pub. 229; 4693.8 by computation) | 4693.53 NM | the computation multiplies the arc rounded to 78.23° by 60 |
| | initial course | S 72.99° W | 252.987° | — |
| §1208 ex. 2, 28° N 122° W → 24° S 151° E | distance, course | 5913.2 NM, 247.3° | 5913.22 NM, 247.303° | — |
| §1208 ex. 3, final course | final course | 287.4° | **289.351°** | **erratum**: the book's formula with its own inputs gives cos C = 0.3314, not the printed .2988; SkyFix agrees with that formula to 0.0014° |
| §1209 ex. 2, 600 NM from the vertex | latitude, longitudes | 40°35.7′ N, 173°47.3′ W, 147°21.5′ W | 40°35.50′, 173°47.54′, 147°21.26′ | four-decimal sines (.6507, .2286): 0.2′ |
| §1209 ex. 3 and §1211, the vertex from 28° N 125° W | vertex longitude | 085°44.1′ W / 164°15.9′ W | 085°43.73′ / 164°16.27′ | sin DLov = −.3584/.5662 in four decimals: 0.41′ |
| Tables 1209a/b (Pub. 229) | latitudes, DLo | to 0.1′ and 0.1° | within 0.05′ and 0.04° | — ; **erratum** in 1209b's last column: its D (110°, 6600 NM) should be 70° (4200 NM), as its declination entry (20°) says, and its longitude 154.3° W is 154.3° E |
| §1213 composite, limit 47° N | where the limit is reached / left | 030°16.0′ W / 018°57.5′ W | 030°16.12′ / 018°56.87′ | cos DLov2 = 1.0230/1.0724 printed as .9539 (the ratio is .95397): the arc-cosine multiplies it to 0.6′ |
| §1215–1217 plane, traverse, parallel sailing | l, p, C, D, DLo | to 0.1 | within 0.06 (traverse within 0.17 NM) | the traverse table's legs are rounded to 0.1 NM each before summing |
| §1218 mid-latitude, ex. 1 | arrival | 22°25.6′ N, 172°21.2′ E | 22°25.55′, 172°21.20′ | — |
| §1218 ex. 2 | course, distance | 240.4°, 1008.3 NM | 240.365°, 1007.14 NM | the book takes D from the course rounded to 60.4° (1.5 NM per 0.05° at this course) |
| §1219 ex. 1 (WGS84 parts) | m, course, distance | 343.7′, 301.8°, 538.9 NM | 343.69′, 301.847°, 538.23 NM | D from the course rounded to 58.2° (0.76 NM per 0.05°) |
| §1219 ex. 2 (Baffin Bay, WGS84 parts) | arrival | 71°32.9′ N, 072°34.1′ W | 71°32.89′, 072°34.03′ | m printed to 0.1′ |
| §1220 Cape Town → Ambrose (WGS84 parts) | course, distance | 310.9°, 6811.5 NM | 310.908°, 6811.33 NM | Table 6's hand-interpolated, older-spheroid parts: 0.2 NM over 4794′ |
| §1220 parallel sailing, 17 kn for 4.5 h on 270° | arrival | 033°05.7′ W | 033°05.75′ | — |

The book also prints the vertex latitude of §1209 example 3 as 34°29.9′ N, a typo for the
34°28.9′ N it prints for the same computation in §1211. On the sphere instead of
`wgs84`, the Mercator examples' courses move by 0.12° and 0.16° and their distances by
1.8 NM and 22.4 NM (test `mercator_examples_on_the_sphere_differ_by_the_spheroid`).

### 9.10 Reproducing

```console
cargo test -p skyfix-core --test sailings_worked_examples -- --nocapture
cargo test -p skyfix-core --test sailings_wgs84 -- --nocapture
cargo test -p skyfix-core --lib sailings
cargo test -p skyfix-wasm sailings
```

---

## 10. Star identification (expansion programme)

*Sailings agent. Code: `crates/skyfix-core/src/methods/starid.rs`; WASM:
`star_identify`. Normative for that code.*

**The question:** a navigator took a sight of a bright body without knowing which it was.
From the time, the DR position, the altitude and a rough bearing, which is it?

**Like with like.** The observation goes through the correction chain as a star
(CONVENTIONS section 5: the index correction or its log, the dip, the shore dip or the
artificial horizon's halving, refraction) to the **airless topocentric altitude** of
whatever was observed; a sextant reading, an apparent altitude and an observed altitude
are all accepted (`altitude_kind`). Every candidate — the 58 navigational stars, the
naked-eye planets Mercury to Saturn, and the Moon — is placed at the DR by CONVENTIONS
section 3 and brought to the same quantity by removing its parallax in altitude,
`h + asin(sin HP cos h) = Hc` (up to a degree for the Moon). A limb of the Moon is taken as
its centre: 16′, well inside the tolerance. The bearing is made true: a magnetic bearing
gains the variation, a compass bearing the deviation and the variation (east positive);
without a variation the bearing is used as if true and the result says so.

**The distance.** The offset of each candidate from the observed direction is measured in
the observed direction's own tangent plane (azimuthal equidistant, exact at any altitude):
`y` along the vertical, `x` along the horizontal. A candidate **matches** when
`|y| ≤ 2°` and `|x| ≤ max(5° cos h, 2°)` (the tolerances are request fields; the bearing
tolerance becomes arc at the observed altitude, never tighter than the altitude's, so near
the zenith, where azimuth means little, the test becomes a 2° circle). Candidates are
ranked by `hypot(y / tol_alt, x / tol_x)`, which weighs each direction by how well it was
measured — a sextant altitude to a minute, a hand-bearing compass to a few degrees — and
the plain angular separation is reported beside it. All matches are listed, best first,
with the nearest others when fewer than three match; when nothing matches the result says
so and names the nearest ("check the time, the DR, whether the altitude is a sextant
reading or corrected, and whether the bearing is true or by compass"). More than one match
is flagged `ambiguous`.

**Seen or not.** Each candidate says whether it is bright enough for the sky at that moment
(`bright_enough`), from the Sun's altitude at the DR: the faintest magnitude is −3.0 in
daylight (Venus near its brightest), rising 0.75 a degree through civil twilight to 1.5
with the Sun at −6°, then the observation planner's 0.25 a degree to 3.0 at −12°
(`skyfix_ephemeris::visibility::twilight_limiting_magnitude`, equal to it there by test),
and on to 4.5 at −18°. A heuristic for a clear sky at sea, stated with every result; it
makes no allowance for moonlight, haze or a body low in the horizon's murk.

**Validated** (`crates/skyfix-wasm/src/sailings.rs` tests):

- every one of the 58 stars is ranked first from its own predicted sextant reading and
  azimuth (`predict_sextant`: height of eye 3 m, index correction −1.2′) at five random
  places (latitudes ±65°) and times (2026–2029) each, where it stands 10° to 80° high:
  290 identifications, the worst separation under 0.00001°;
- with an altitude error of 1′, a bearing error of 1.5° and a DR 10 NM out (1 sigma each),
  the true star is within the tolerances in 400 of 400 sights and ranked first in all 400;
- the Moon is found from its own predicted lower-limb reading.

---

## 11. The star finder (2102-D equivalent)

*Sailings agent. Code: `crates/skyfix-core/src/methods/starfinder.rs`; WASM:
`star_finder_geometry(lat_band, jd_utc?)`. Normative for that code.*

The Star Finder and Identifier No. 2102-D is a plastic base with the navigational stars on
it and a transparent altitude–azimuth template for each band of latitude; set the template
on the local hour angle of Aries and read every star's altitude and azimuth. This is its
geometry, for the interface to draw (no bitmap), on the unit disc (`x` right, `y` up):

- **The base.** Each side is a polar **azimuthal equidistant** projection centred on a
  celestial pole and extending to the opposite pole at the rim, seen from outside the
  celestial sphere like a globe: `r = (90° − δ)/180°` on the north side,
  `r = (90° + δ)/180°` on the south, at angle `α` (the right ascension, `360° − SHA`)
  anticlockwise on the north side and clockwise on the south. The equator is the circle of
  radius ½. The 58 stars (the 57 and Polaris) are given on both sides, with their SHA,
  declination and magnitude: J2000.0 catalogue places, or with `jd_utc` their apparent
  places of that date.
- **The Aries index** on the rim: a graduation every degree (`label` every 10°, `major`
  every 5°), graduation `L` at angle `L` on the north side and `−L` on the south, so the
  graduation beside a star is its right ascension.
- **The template** for the latitude band (5° to 85° every 10°, either hemisphere; any
  latitude is snapped to its band's centre): altitude circles every 5° (the horizon closed
  at 0°), azimuth lines every 10° from the horizon to the zenith, the zenith itself, all in
  the same projection with the observer's meridian (the arrow, from the pole through the
  zenith) along `+x`. The point at altitude `h`, azimuth `A` has declination and hour
  angle from the altitude–azimuth relations (`sin δ = sin φ sin h + cos φ cos h cos A`,
  `cos δ sin t = −cos h sin A`, `cos δ cos t = cos φ sin h − sin φ cos h cos A`) and sits at
  `r (cos t, −sin t)` on a north template, `r (cos t, sin t)` on a south one.
- **Setting it:** turn the template anticlockwise by `rotation_sign × LHA ♈` degrees
  (`+1` north, `−1` south). Every star then stands at its altitude and azimuth on the grid.

Like the printed finder, the grid is geometric (no refraction, no dip) and a band's
template serves ±5° of latitude, where altitudes and azimuths are good to a few degrees.
**Validated:** at 20 000 random template latitudes, hour angles of Aries and stars, the set
template places each star above the horizon at its CONVENTIONS section 3 altitude and
azimuth to 1e-9 of the disc's radius; the same holds for the 58 real stars at a real time
(`the_star_finder_places_stars_where_the_template_reads_them`). The whole payload is about
100 kB of JSON.

---

## 12. Dip short of the horizon

*Sailings agent. Code: `crates/skyfix-core/src/corrections.rs` (`dip_short_arcmin`,
`horizon_dip`); CONVENTIONS section 5, step 2, horizon `shore`.*

When the waterline under the body — a shore, a jetty, another vessel — is nearer than the
sea horizon, the altitude is measured from that waterline, which lies further below the
horizontal than the sea horizon does. Bowditch (2019 vol. 2 §402 and Table 14; the 2002
edition's Table 22) gives

```
Ds = 60 tan⁻¹( h_ft / (6076.1 d) + d / 8268 )        minutes; h_ft feet, d NM
```

**Derivation.** A point on the sea surface `d` NM away lies `d²/(2R')` below the observer's
horizontal plane, where `R'` is the Earth's radius as terrestrial refraction makes it look;
seen from height `h` its depression is `(h + d²/2R')/d = h/d + d/(2R')`. Bowditch's `8268`
is `2R'` with `R'` = 4134 NM (a refraction coefficient of 0.17 on a 3440 NM Earth), the
same refraction that gives the sea dip `0.97′ √h_ft`: the formula is least at
`d = √(8268 h_ft/6076.1)` = `1.17 √h_ft` NM, Bowditch's distance of the sea horizon, where
it equals exactly that dip. For small angles it is `0.4158′ d + 1.8562′ h_m / d` (the
constants 3437.75/8268 and 3437.75/(0.3048 × 6076.1)); the arctangent matters only for a
waterline a few cables from a high eye: at 100 ft and 0.2 NM Table 14 prints 282.3′, the
arctangent gives 282.34′ and the linear form 282.97′.

**In the chain.** The session's horizon (or a sight's) is `{"shore": {"distance_nm": d}}`.
Step 2 subtracts the dip short of the horizon while the waterline is nearer than the sea
horizon — never less than the chain's sea dip `1.76′ √h_m`, which Bowditch's constants put
0.18 % above the formula's minimum, so for a shoreline within a few per cent of the horizon
distance the sea dip is used — and at or beyond the sea horizon the sea dip itself with the
warning `shore_beyond_sea_horizon` (the waterline is hidden: the sea horizon is what the
observer sees). The step's note names the distance, the dip and the horizon distance. The
predicted reading (`predict_sextant`) and the lunar distance take the same dip.

**Validated** (`crates/skyfix-core/tests/dip_short.rs`): 28 entries of Table 14 from 5 to
100 ft and 0.2 to 10 NM, including four beyond the sea horizon, agree with the printed
tenth, worst 0.046′.

---

## 13. Index-error and watch logs

*Sailings agent. Code: `crates/skyfix-core/src/error_logs.rs`; CONVENTIONS section 10.*

A navigator measures the index error and checks the watch against a time signal every so
often. A session may carry both logs: `instrument.index_error_log` of
`{utc, ic_arcmin, note}` (the index correction, added, as `index_correction_arcmin`) and
`clock.watch_log` of `{utc, correction_s, note}` (added to the watch, as `correction_s`).
When a log has entries, a sight's value is read from it instead of the single one:
linearly interpolated between the entries either side (the watch's rate is steady between
comparisons), the entry itself at its instant, a one-entry log as a constant, and outside
the log's span the nearest entry **held, not extrapolated**, with the warning
`error_log_outside_span` saying how many hours outside (a watch gaining two seconds a day,
last checked five days ago, is ten seconds out; the navigator should see that rather than
have it guessed). The watch log is read at the sight's recorded time, the index log at the
corrected time. The reduced sight records the value used and how
(`index_correction_from_log`, `clock_correction_from_log`), and the index-correction
step's note says which entries it came from. Averaged sights are written on the logged
watch, and predicted readings and lunar distances use the logged index correction, so
everything agrees. Older files, with no logs, load and reduce unchanged, byte for byte
(`crates/skyfix-core/tests/error_logs.rs`).
