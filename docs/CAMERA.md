# The camera sextant (module A)

`crates/skyfix-camera` runs the whole chain from a synthetic star image to a position
fix: centroids, star identification, attitude, and — **only with an independently
measured local vertical** — altitudes that the core solver consumes.

This document is normative for module A in the same way `CONVENTIONS.md` is normative
for the core: if the code and this file disagree, the code is wrong until this file is
amended in the same change. Every number quoted below is printed by a test; the command
is at the end of section 8.

---

## 1. The one sentence this module exists to make unavoidable

**Identifying stars in a camera frame yields orientation. It does not yield location.**

The BRIEF lists that as non-negotiable item 2, and this crate enforces it with types
rather than with warnings:

- `attitude::solve_attitude` returns an `Attitude`. That struct has no latitude,
  longitude or altitude field. Two tests serialise it and assert that no such key
  exists — one in the module, one in `tests/end_to_end.rs`.
- The only route to an altitude is `sights::altitudes_from_camera`, whose signature
  takes `&LocalVertical`. Not an `Option`, not a defaulted parameter. Without one there
  is no call to make.
- No constructor of `LocalVertical` accepts an image, a star field, an `Identification`
  or an `Attitude`. The three ways to build one are an inclinometer reading, a fitted
  sea horizon, and a value the caller supplies from an instrument this crate knows
  nothing about.

There is a second, less obvious half to the same fact, and the tests found it rather
than assuming it: **the sky does not tell you which way is up even for the purpose of
correcting itself.** See section 6.

---

## 2. Frames

Three frames, named `<to>_from_<in>` throughout. `frames.rs` is the single definition;
every claim below has a test.

### Frame C — Earth-fixed of date

The reference frame for star directions.

```text
x  through (lat 0, lon 0)     the Greenwich meridian on the equator
y  through (lat 0, lon 90E)
z  through the north celestial pole
```

A body with apparent geocentric `GHA`/`Dec` of date (CONVENTIONS section 7) has its
geographic position at `lat = Dec`, `lon_east = -GHA` (section 2), and that point's unit
vector *is* the unit vector toward the body. So frame C is
`skyfix_core::geometry::Point::to_unit` applied to `geographic_position`, and module A
cannot disagree with the core solver about where a star is.

**Frame C rotates with the Earth.** Its x axis is tied to the Greenwich meridian, so a
star's coordinates in it change by 15.04 degrees an hour. An attitude expressed in frame
C is meaningless without the instant it belongs to, which is why `Attitude::frame` is a
string like `"earth-fixed of date at 2026-10-01T01:30:00Z"` rather than just a frame
name. Two attitudes an hour apart in the same physical orientation differ by 15 degrees
in this frame, and that is correct.

The alternative — an equinox-of-date frame with x toward the equinox — differs by a
rotation of `GAST` about z. Frame C was chosen because the whole workspace already
speaks GHA/Dec and a second convention would buy a sign error and nothing else.

### Frame E — local ENU at the observer

```text
East  = (-sin lambda,           cos lambda,          0      )
North = (-sin phi cos lambda,  -sin phi sin lambda,  cos phi)
Up    = ( cos phi cos lambda,   cos phi sin lambda,  sin phi)
```

A direction at altitude `h` and true azimuth `Zn` is `(cos h sin Zn, cos h cos Zn,
sin h)`. `frames::tests::enu_of_a_star_reproduces_the_core_altitude_azimuth` applies
these rows to five star vectors and asserts agreement with
`skyfix_core::geometry::altitude_azimuth` to 1e-12 rad. That test is the seam between
module A and the rest of the workspace; if it ever fails, every camera altitude is
wrong.

### Frame K — camera, OpenCV convention

```text
x  right across the image  (+u)
y  down the image          (+v)
z  along the optical axis, out of the lens
```

Right-handed; a direction behind the camera has `z < 0` and does not project. Pixel
`(i, j)` has its **centre** at `(u, v) = (i, j)`, so the sensor spans
`u in [-0.5, width - 0.5]` and a centred principal point is `cx = (width - 1) / 2`.

`camera_from_enu(alt, az, roll)` builds a pointing. At `roll = 0` the image's `+y` is
the direction of steepest descent in altitude, so the horizon is level and below centre.
Positive roll turns the image content counter-clockwise on screen.

---

## 3. The chain

```text
render      -> (Image, RenderTruth)   truth returned SEPARATELY, never passed on
centroid    -> Vec<Centroid>          background, threshold, components, sub-pixel
identify    -> Identification         closed world: 58 stars, 1653 pair angles
attitude    -> Attitude               Wahba / Davenport q-method. ORIENTATION ONLY.
vertical    -> LocalVertical          inclinometer, horizon line, or supplied
sights      -> Vec<Observation>       apparent_ha + electronic_vertical
core        -> reduce + solve         position, with its own uncertainty
```

Two things about the shape of that list matter.

**The attitude is not a step toward the position.** `altitudes_from_camera` does not
take an `Attitude` and does not need one: a star's altitude is the angle between its
camera-frame direction and the local vertical in the same frame, both available before
any rotation is solved. Attitude and altitude are two independent products of one image.
A camera-only attitude demo is a complete deliverable that never mentions latitude.

**The truth flows one way.** `render` returns `(Image, RenderTruth)` as two values. No
estimator function in the crate takes a `RenderTruth` parameter. The single exception is
`vertical::simulated_inclinometer`, which takes the true vertical as an explicit
argument because that is what a simulator does, and which is named so a call site cannot
be mistaken for an estimator.

### What module A hands the core

| field | value | why |
|---|---|---|
| `altitude_kind` | `apparent_ha` | the camera sees the **refracted** sky, so the angle from the vertical is `Ha`. The core then subtracts Bennett refraction (CONVENTIONS section 5 step 3) to reach `Ho`. Declaring `observed_ho` would skip refraction and bias every fix by 1 to 3 arcminutes. |
| `horizon` | `electronic_vertical` | no sea horizon in the measurement, therefore **no dip**. This holds even when the vertical was *derived* from a horizon line: the horizon found which way is up, it is not the reference the altitude was measured from, and applying dip again would subtract it twice. |
| `geocentric` | `null` | the ephemeris provider fills GHA/Dec at reduction time. |
| `limb` | `center` | a star is a point source. |
| `sigma_arcmin` | centroid and vertical in quadrature | section 7. |

A test round-trips the produced session through JSON, checks
`skyfix_core::session::validate` accepts it with no warnings, and asserts the truth
position does not appear anywhere in the text.

---

## 4. What is simulated, and what is simplified

### The renderer uses the truth, openly

`render` takes the true observer position, the true camera attitude and the true time,
exactly as `skyfix-sim` does for sextant sessions. A simulator that had to estimate its
own inputs would not be a simulator. The honesty is in the return type, not in the
inputs.

Modelled: apparent geocentric star directions from `StarProvider`; Bennett refraction
applied **forward** so the image shows apparent directions (default on); a circular
Gaussian PSF; `flux = flux_scale * 10^(-0.4 m)`; a flat sky background; Poisson shot
noise; Gaussian read noise; single-pixel hot pixels; hard saturation; and an optional
sea horizon drawn at altitude `-dip` as an exact box-filtered step.

Not modelled: vignetting, flat field, dark current gradient, cosmic rays,
scintillation, seeing beyond a fixed Gaussian, star colour, airmass extinction, rolling
shutter, motion blur, lens ghosts. None of them change the *structure* of the chain,
which is what this module exists to prove.

### Identification is closed world, and that is the binding limit

The reference set is the 58 stars of `skyfix_ephemeris::catalog` — the 57 Nautical
Almanac navigational stars plus Polaris — and their `58 * 57 / 2 = 1653` pair angles.
Nothing else exists.

What it does *not* do is cheat: no position prior, no attitude prior, no "stars that
could be in the field" filter derived from the truth. All 1653 pairs are candidates for
every measured pair, which is the honest lost-in-space problem for this catalogue.

**The finding that shaped the whole end-to-end test.** At Philadelphia on
2026-10-01T01:30:00Z, a 40-degree field pointed at altitude 45, azimuth 250 — the
geometry the task specifies — contains **exactly one** of the 58 stars: Rasalhague, 9.7
degrees off the boresight. Vega is 23.8 degrees away and Altair 24.8, both outside the
frame. Identification needs three. Measured, printed by
`the_briefed_forty_degree_lens_sees_one_star`:

| horizontal FOV | diagonal | catalogue stars in frame |
|---:|---:|---:|
| 40 | 48.9 | 1 |
| 50 | 60.5 | 2 |
| 60 | 71.6 | 3 |
| 70 | 82.4 | 4 |
| **80** | **92.7** | **6** |
| 90 | 102.7 | 7 |

This is a limit of the closed world, not of the sky. A camera that can centroid a
magnitude-2 star reaches magnitude 6 or fainter and would see well over a hundred stars
in that same 40-degree frame. The 58-star catalogue is a list of stars a human can name
from a deck at night; it is far too sparse to identify from a narrow field. The
end-to-end test therefore keeps the briefed place, time and pointing and widens the lens
to 80 degrees, which is the narrowest that holds five. The 40-degree case is kept as a
test of its own and returns the explicit failure
`IdentifyStatus::TooFewCentroids { have: 1, need: 3 }`.

A production system needs a catalogue to the sensor's limiting magnitude and a real
geometric index — a k-vector over pair angles, or a triangle/pyramid hash — not a linear
scan of 1653 pairs. See the backlog.

### Other simplifications

- Two radial distortion coefficients, no tangential or thin-prism terms.
- `min_pixels = 1` by default, so a single hot pixel *does* reach the identifier as an
  unmatched centroid. That is deliberate: the identifier has to reject it rather than
  having it filtered out upstream. It also means the detection threshold carries the
  whole false-alarm budget, which is why the default is 6 sigma rather than 5.
- The simulated inclinometer models a **stationary calibrated instrument** (BRIEF item
  4). An accelerometer measures specific force, not gravity; on a moving platform the
  two are indistinguishable in one sample, and one milli-g of horizontal acceleration is
  3.4 arcminutes of apparent tilt, or three and a half nautical miles. Nothing here
  models that, and nothing here claims to.

---

## 5. Star identification and attitude

Identification: unproject every centroid, measure every centroid pair's angle (angles
are frame-independent, so no attitude is assumed), binary-search the sorted catalogue
pair table within a tolerance derived from the centroid accuracy, vote on
`(centroid, star)` assignments, assign greedily, then **verify**: keep only a set in
which *every* pair of identified stars has the catalogue angle between them. Offenders
are dropped one at a time, worst first. Three mutually consistent stars is a verified
triangle and the same rule extends upward.

Fewer than three survivors is an explicit result — `TooFewCentroids` or
`NoConsistentSet` with a reason — never an empty success. Two stars share exactly one
angle, and every rotation about their bisector preserves it, so a two-star
"identification" is not one.

Attitude: Wahba's problem by the Davenport q-method, with the 4x4 eigenproblem solved by
`skyfix_core::linalg::jacobi_eigen_sym` so the workspace has one symmetric eigensolver
and not two.

One trap worth recording. Davenport's eigenvector is a quaternion in the
**attitude-matrix** convention, `A(q) = (w^2 - |v|^2) I + 2 v v^T - 2 w [v x]`, whose
cross-product term carries a *minus*. The Hamilton convention that `Rotation` uses
carries a plus. Getting it wrong yields the transpose, which is orthonormal, has
determinant +1, and is wrong by up to 180 degrees.
`the_q_method_recovers_a_known_rotation_exactly` — synthetic vectors, exact rotation, no
imaging — is what caught it.

---

## 6. Refraction biases a camera-only attitude, and you need a vertical to remove it

A camera under the atmosphere measures **apparent** directions; the catalogue gives
geometric ones. Refraction lifts every star toward the zenith by an altitude-dependent
amount — 2.0 arcminutes at 25 degrees, 1.0 at 45 — so fitting apparent measurements to
geometric references absorbs that lift into the attitude. Measured on the six-star
40-degree Orion field, all three runs noiseless and identical apart from the atmosphere:

| case | attitude error |
|---|---:|
| vacuum (spacecraft star tracker) | 0.0003' |
| through air, no vertical available | **2.8241'** |
| through air, vertical good to 0.5' | 0.0012' |

The bias is systematic: more stars do not reduce it, and the post-fit residual RMS stays
small while the answer is nearly three arcminutes wrong. Removing it means knowing each
star's apparent altitude, which means knowing which way is down.
`AttitudeOptions::derefract` takes a `Derefraction` carrying a local vertical for exactly
that, and `Attitude::refraction_removed` records which of the two cases a result is.

So: in vacuum, camera-only attitude is exact. Under the atmosphere it carries an
unremovable bias unless something outside the camera says where the vertical is. That is
BRIEF item 2 from the other direction — not only does orientation fail to give a
location, the sky on its own does not even tell you which way is up.

Note that the *sights* path is different and must not be "corrected": the camera
measures `Ha`, declares `apparent_ha`, and the core removes refraction once. Removing it
twice would be the classic double-correction CONVENTIONS section 4 exists to prevent.

---

## 7. The error budget of one camera sight

```text
sigma^2 = (centroid_sigma_px * angular_scale_at(u, v))^2   per-star, RANDOM
        + (vertical.sigma_arcmin)^2                        COMMON to every star
```

The two terms are different kinds of error and the second is the dangerous one. The
centroid term is independent per star, so five stars beat one by `sqrt(5)`. The vertical
term is a single tilt shared by every sight in the frame: it moves them all the same way
and averaging does nothing (BRIEF item 6). **A camera sextant is a vertical-measuring
instrument that happens to have a lens on it.**

They are nevertheless combined into one `sigma_arcmin`, because `skyfix.session/1` has
one sigma per observation and the core's model treats sights as independent. That is a
deliberate, documented approximation: it gets the *size* of the uncertainty right and
the *correlation* wrong, which makes the reported ellipse optimistic in the direction the
vertical tilts. `CameraSights::shared_vertical_sigma_arcmin` carries the common part
separately so a caller can say so. Modelling it properly needs either the solver's
existing `estimate_shared_bias` or a full covariance the session schema does not have;
both are backlog.

### The three verticals

| source | assumes | measured accuracy |
|---|---|---|
| `SimulatedInclinometer` | stationary, calibrated | as configured; 0.5' sigma gives 0.06' to 0.42' of actual tilt in the tests |
| `HorizonLine` | clear unobstructed sea horizon, known height of eye | 0.18' actual tilt at 4 m height of eye, 0.35' reported |
| `Supplied` | the caller knows what they did | whatever they state |

The horizon fit is worth a paragraph. Per column, differentiate down the image and take
the **centroid of the derivative** over a small window; for any symmetric edge profile
that is the sub-pixel edge position exactly. Fit a line, clip outliers once, refit. Then
unproject the line to camera directions and solve `d_k . u = -sin(dip)` for a unit `u` by
Gauss-Newton on the sphere.

Doing the dip correction *inside* that constrained fit matters. The sea horizon is a
**small** circle at altitude `-dip`, not a great circle, and a plain
plane-through-the-origin fit to a 40-degree arc of it is biased by `1.02 * dip` toward
the direction the camera faces. At 25 m of height of eye that is 8.8 arcminutes, or
nearly nine nautical miles.
`vertical::tests::the_dip_correction_is_worth_its_own_size` measures it.

The horizon fit's *statistical* sigma — the one that falls out of the line's residual
scatter — under-states the real tilt error by a factor of several, because the scatter of
the edge samples says nothing about where the horizon actually was. The reported
`sigma_arcmin` therefore adds an anomalous-dip allowance (10 % of the dip by default) and
a 0.2' floor on top, and `statistical_sigma_arcmin` is reported separately so the two can
be told apart. The 10 % is a conservative token, not a validated model: real anomalous dip
depends on the air-sea temperature difference and can be far larger.

---

## 8. Results

All of these come from `tests/end_to_end.rs`. Reproduce with:

```
cargo test -p skyfix-camera -- --nocapture --test-threads=1
```

### The end-to-end fix

Philadelphia (39.9526, -75.1652) at 2026-10-01T01:30:00Z; camera at altitude 45,
azimuth 250, roll 7; 1024 x 768 sensor with an 80-degree horizontal field (93-degree
diagonal); default noise; simulated stationary inclinometer with 0.5' sigma; assumed
position 100 NM away on a 045 bearing, role `initializer`; `StarProvider` supplying
GHA/Dec through `ProviderSource`.

```
6 blobs detected, 6 identified: Vega, Altair, Nunki, Rasalhague, Alphecca, Eltanin
vertical:  reported sigma 0.50', actual tilt from truth 0.059'
attitude:  rms 37.74", error vs truth 0.466'   (plate scale 5.63'/px, spread 31.1 deg)
sights:    Ha from 17.09 to 61.08 deg, sigma 0.91' to 1.21'
fix:       39.95528, -75.16844   (truth 39.9526, -75.1652)
error:     406 m = 0.22 NM
predicted: 1648 m = 0.89 NM       ratio 0.25
geometry:  condition 1.4, largest azimuth gap 265 deg, chi2 0.92 on 4 dof
```

`FixResult::Unique`. The error is 0.25 of the predicted sigma — inside it, and non-zero,
as a simulated fix must be. A 0.5' vertical is 926 m of position on its own, so 406 m is
the right order.

The fix ends up about 100 NM from the assumed position it started at, which is the
test's check that the initializer never became a prior.

### The attitude requirement, on the briefed lens

The half-arcminute attitude requirement is met on a 40-degree lens, where the plate
scale is 2.44'/px:

```
clean 6-star 40-degree field: attitude error 0.2149', residual rms 6.73", spread 13.3 deg
```

On the 80-degree lens the same 1024-pixel sensor gives 5.63'/px, and the same tenth of a
pixel of centroid noise is over half an arcminute of direction (0.466' measured, against
a roll-limited prediction of 0.497'). Widening the lens to find stars costs attitude
accuracy; a real build would spend pixels to get it back.

### Vertical quality drives the fix: one arcminute, one nautical mile

Same image, same stars, same identification; only the inclinometer changes.

| vertical sigma | actual tilt | fix error | predicted |
|---:|---:|---:|---:|
| 0.1' | 0.08' | 0.18 NM | 0.77 NM |
| 0.5' | 0.42' | 0.44 NM | 0.89 NM |
| 2.0' | 1.69' | 1.67 NM | 1.92 NM |
| 5.0' | 4.22' | 4.20 NM | 4.44 NM |

A tenfold worse vertical gives a fivefold worse predicted sigma here (the centroid term
still contributes at the low end) and a twenty-threefold worse actual error from 0.1' to
5.0'. With a *perfect* supplied vertical the fix error is 0.166 NM against a predicted
0.802 NM — the floor set by centroid noise alone.

### Sub-pixel accuracy

| quantity | measured |
|---|---|
| centroid, noiseless rendered Gaussian, swept over 121 sub-pixel phases | **< 0.002 px** (requirement 0.05) |
| centroid, rendered star field with noise | < 0.05 px worst of 6 |
| project / unproject round trip, with and without distortion | < 1e-9 px |
| altitude from pixel, noiseless, perfect vertical | < 0.1 arcsec |
| altitude from pixel, default noise, perfect vertical | worst 23", inside the 29" sigma reported (test bound 40") |

The centroid is taken over a fixed window around the blob's peak, not over the
thresholded pixels: thresholding is non-linear and clips the PSF asymmetrically whenever
the star is not at a pixel centre, which is exactly the sub-pixel information being
measured. The flux is the plain background-subtracted sum with negatives included;
clamping it at zero biased an empty 13 x 13 window on an 11-count sky upward by 750
counts, enough to push blank sky past any flux cut. The centroid *weights* are clamped,
because a negative weight can drag a position outside its own window.

---

## 9. Backlog for real imagery

Nothing in this crate has met a real lens, a real sensor or a real sky. In rough order
of how much each one would change the answer:

1. **A deeper catalogue and a real index.** Section 4 shows the 58-star closed world
   fails at 40 degrees at a perfectly ordinary pointing. A real system needs a catalogue
   to the sensor's limiting magnitude (thousands of stars), a k-vector or
   triangle/pyramid index instead of a linear scan of 1653 pairs, and a false-match
   probability that accounts for the larger population.
2. **A real vertical.** Everything in section 7 says the vertical is the budget. A real
   instrument needs a calibrated inclinometer with a characterised bias and a stated
   temperature coefficient, or a horizon fit validated against real sea horizons
   including anomalous dip — and a way to know the platform was actually stationary.
   Gravity sensing on an accelerating platform is a different problem and needs an IMU
   and a filter.
3. **Lens calibration.** Intrinsics, both radial terms, tangential terms, and the
   principal point, from images of a target, with their own covariance. A half-pixel
   error in `cx` is 1.2 arcminutes of altitude on the 40-degree lens and 2.8 on the
   80-degree one.
4. **Timing.** This crate assumes the timestamp is the instant the sky was at. Real
   cameras have shutter latency, exposure length (a star moves 15"/s of arc), and
   rolling shutter, which makes the effective time a function of the row a star landed
   on. CONVENTIONS section 6 already notes clock offset is degenerate with longitude for
   stars, so timing error goes straight into the fix.
5. **The shared-vertical correlation.** Feed the common tilt in as a shared bias
   (`SolveOptions::estimate_shared_bias`) or extend the session schema to carry a
   covariance, so the reported ellipse stops being optimistic in one direction.
6. **A real attitude covariance.** The q-method gives none; `Attitude::covariance_note`
   quotes an order of magnitude from the post-fit residuals and says so. QUEST's
   covariance formula with per-star centroid weights is the standard answer.
7. **PSF-shaped detection.** `min_pixels = 1` lets hot pixels through on purpose. A real
   pipeline fits the PSF and rejects anything too sharp to be a star, which also lets the
   threshold drop back to 5 sigma.
8. **Photometry and star colour.** Refraction is chromatic, extinction depends on
   airmass and on the star's spectrum, and a broadband sensor's effective wavelength
   shifts with colour. All are sub-arcminute but none are zero.
9. **Real recorded data.** The BRIEF asks for the chain to be proven on real imagery
   before promising automatic global fixes. It has not been.
