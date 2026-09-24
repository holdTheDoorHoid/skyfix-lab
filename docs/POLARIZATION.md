# Module B — polarization compass laboratory (`skyfix-polar`)

**Simulation only. Every photon in this module is synthetic.**

This module asks one question and answers it honestly: given an ideal sky model
and a stated set of instrument defects, how well can *heading* be recovered, and
what remains ambiguous? It says nothing about real atmospheres, nothing about
all-weather accuracy, and — by design — nothing about **position**.

It implements the brief's section B and honours "Non-negotiable physical
distinctions" item 5: *polarization measurements have angular ambiguities and
depend on geometry and calibration; a modeled sky pattern does not prove
all-weather compass accuracy or independent global positioning.*

---

## 1. The model

### 1.1 Ideal single-scattering Rayleigh sky

One scattering event off molecules in a non-absorbing, horizontally uniform
atmosphere. With the Sun at unit vector `s` and a sky point at unit vector `v`:

```
gamma = angle(s, v)                                     scattering angle
DoLP  = d_max * sin^2(gamma) / (1 + cos^2(gamma))
E-vector along  n = s x v                               perpendicular to the
                                                        scattering plane
```

`d_max` is configurable and defaults to `1.0`, the ideal value. **A clear real
sky reaches roughly 0.75** (`sky::TYPICAL_CLEAR_SKY_D_MAX`) and a hazy one much
less; the default is the ideal, not a measurement.

**What the model does not contain:** multiple scattering, aerosol, ground
albedo, ozone, cloud, wavelength dependence, or any radiance model worth the
name. Real skies deviate from it everywhere and most strongly near the horizon,
near the Sun, and in haze. Anything computed here is a statement about *this
model*.

### 1.2 The symmetries, as callable facts

Each of these is a function in `sky.rs` with a test, not a comment.

| Fact | Where | Test |
|---|---|---|
| `DoLP(gamma) == DoLP(180 - gamma)` | `RayleighSky::dolp` | `dolp_is_symmetric_about_ninety_degrees` |
| Mirror symmetry about the solar meridian: DoLP invariant, AoLP negated (mod 180) | `mirror_symmetry_check` | `pattern_is_mirror_symmetric_about_the_solar_meridian` |
| The field is **exactly** invariant under Sun ↔ anti-Sun | `sun_antisun_degenerate` | `sun_and_antisun_give_an_identical_field` (agrees to < 1e-12 in DoLP, < 1e-9 rad in AoLP) |
| The only neutral points are the Sun and the anti-Sun | `is_neutral` | `the_only_neutral_points_are_the_sun_and_the_antisun` (65 160-point full-sky scan) |

**The Babinet, Brewster and Arago neutral points do not exist in this model.**
Real skies show them; they are produced by multiple scattering and ground
reflection, which this model omits entirely. Finding exactly two neutral points
is a property of the model, not a finding about the sky. Anyone comparing this
module against a real sky photograph should expect the discrepancy there first.

---

## 2. Conventions

`docs/CONVENTIONS.md` section 1 governs units: **radians inside** (`*_rad`),
**degrees at every serde and reporting boundary** (`*_deg`). `sky::Dir` stores
radians and serialises as `{"alt_deg": …, "az_deg": …}` so that radians never
appear in JSON.

### 2.1 World frame

Right-handed `(east, north, up)`. A direction is altitude up from the horizon
and azimuth clockwise from north, matching CONVENTIONS section 2 (`Zn`):

```
v = [cos(alt) sin(az), cos(alt) cos(az), sin(alt)]
```

### 2.2 World-frame AoLP

Measured at the sky point, in its local tangent basis `(e_alt, e_az)`:

* **zero** is `e_alt`, the local meridian direction pointing toward the zenith
  along the vertical circle through the point;
* **increasing** toward `e_az`, the direction of increasing azimuth;
* taken **modulo 180 degrees**, because the E-vector is an axis, not an arrow.

`(e_alt, e_az, v)` is right-handed and the observer looks outward along `+v`, so
increasing AoLP appears **clockwise to an observer facing that patch of sky**.

This basis is **singular at the zenith and the nadir** (azimuth is undefined
there) and `aolp_local_rad` returns `None`. The camera path never touches it:
`camera.rs` projects the E-vector straight into the pixel frame, which has no
such singularity at the image centre.

### 2.3 Camera body frame and image plane

Right-handed `(x, y, z) = (image right, image up, optical axis)`, the optical
axis pointing out of the lens at the sky. A pixel at column `c`, row `r` has

```
x_img = c - center_x        (to the right)
y_img = center_y - r        (upward; row 0 is the TOP row)
phi   = atan2(x_img, y_img) (from image up toward image right)
```

`phi` is measured in the same sense as azimuth is measured from north toward
east. That is what makes a levelled camera at heading 0 map image-up to north
and image-right to east — which is correct for an upward-looking view: lying on
your back with your head to the north, your right hand points east.

### 2.4 Analyzer angles and pixel-frame AoLP

Analyzer angles use the **same zero and the same sense as `phi`**: 0 deg
transmits light polarized along image up, 90 deg along image right. Pixel-frame
AoLP uses that zero too, so the forward model is simply

```
I(t) = I0/2 * (1 + DoLP * cos(2 (t - psi_pixel)))
```

The transform from the world E-vector into the pixel frame collapses to one
line, derived in `camera.rs`:

```
psi_pixel = phi + atan2(n . t_phi, n . t_theta)     (mod 180 deg)
```

with `n = s_body x dir` the E-vector in the body frame, and
`(t_theta, t_phi)` the body-frame tangents along increasing `theta` (outward
radial in the image) and increasing `phi` (tangential).

**This is where most real polarization-compass bugs live.** Three tests pin it
down: `pixel_frame_aolp_agrees_with_the_world_frame_at_zero_tilt`,
`a_synthetic_field_of_known_aolp_survives_the_whole_pipeline` (an AoLP field
chosen by hand, never touching the sky model), and the signed rotation test
below.

### 2.5 Projection and extrinsics

Equidistant fisheye, `r_px = f * theta` with `f = radius_px / (fov/2)`, so the
angle from the optical axis is linear in image radius. Field of view is
configurable up to 180 degrees. Pixels outside the image circle are not sky.

**Rotation order — tilt first, then heading:**

```
v_world = R_yaw(heading) * R_pitch(pitch) * R_roll(roll) * v_body
```

| factor | axis | sign |
|---|---|---|
| `R_roll(roll)` | optical axis `z` | positive roll turns the body counter-clockwise about its own line of sight, so the scene appears to rotate clockwise in the image |
| `R_pitch(pitch)` | body `x` (image right) | **positive pitch tips the optical axis toward image up**, i.e. toward the heading direction. Pitch `p` at heading `h` puts the optical axis at altitude `90 - p`, azimuth `h` |
| `R_yaw(heading)` | world vertical | heading clockwise from north; image up points at azimuth `heading` |

Tested by `zero_tilt_centre_is_the_zenith_and_image_up_is_north` (image centre →
zenith; image up → north; right → east; down → south; left → west) and
`heading_turns_the_image_and_pitch_tips_the_axis`.

### 2.6 The signed rotation identity

Because a rotation commutes with the cross product,

```
n_body = R^T (s x R c) = (R^T s) x c
```

so **the whole camera-frame field depends on the heading only through the Sun
direction expressed in the body frame**. One trial heading costs one 3x3
multiply plus one cross product per sample. It also gives the sign-checked
statement that `rotating_the_camera_30_degrees_rotates_the_aolp_field_by_minus_30`
verifies over 165 directions:

```
psi_pixel(heading h, phi) = psi_pixel(heading 0, phi + h) - h      (mod 180 deg)
```

Turning the camera **+30 deg** moves a given sky point **-30 deg** in image
polar angle and lowers its measured AoLP by **30 deg**. The test also confirms
that the opposite sign would fail on more than half the sampled directions, so
it is not a tautology.

---

## 3. Stokes recovery

```
S0 = (I0 + I45 + I90 + I135) / 2
S1 = I0  - I90
S2 = I45 - I135
DoLP = sqrt(S1^2 + S2^2) / S0
AoLP = 0.5 * atan2(S2, S1)                (mod 180 deg, pixel frame)
```

`S3` (circular polarization) is not measurable with linear analyzers and is not
modelled anywhere. Round-trip accuracy is better than 1e-9 in `S0`, `DoLP` and
`AoLP` across `S0` in {0.25, 1.0, 7.5}, `DoLP` in {0, 0.137, 0.5, 0.75, 1.0} and
every AoLP.

### Modulo-180 arithmetic

All in `angles.rs`, in one place, so no two modules can disagree:

* `diff180_deg(179, 1) == -2` — the two angles differ by 2 degrees, not 178;
* `mean180_deg([179, 1]) == 0` — double-angle averaging, not 90;
* `mean180_deg([0, 90]) == None` — orthogonal pairs cancel exactly and have no
  well-defined mean, which is reported rather than papered over.

### Masking

Two configurable per-pixel thresholds, plus the lens' own image circle:

* **`min_s0`** (default 0.05 for an `I0 = 1` scene) — a pixel with too little
  total intensity carries no usable angle. **This is how a missing-sky mask is
  discovered.** The estimator is never handed the mask.
* **`min_dolp`** (default **0.10**) — the consequential one. Propagating
  additive noise `sigma` through the inversion gives
  `sigma_psi ≈ 0.81 / DoLP` degrees at `sigma = 0.02`, `S0 = 1`. At
  `DoLP = 0.02` that is about 40 degrees: such a pixel is not a weak
  measurement, it is noise. Admitting it does not *bias* the estimate, but it
  inflates the variance by about an order of magnitude and makes the
  curvature-derived `sigma_deg` optimistic, because the residuals are then
  wildly non-identically distributed. The threshold costs sky — 10.9 % of the
  in-lens field at Sun altitude 10, 9.5 % at 30, 8.5 % at 50, 8.0 % at 70 — and
  buys a usable uncertainty.

---

## 4. Degradations — what they represent and what they do not

All optional, all seeded, all off by default. The RNG is splitmix64 +
Box-Muller, written into the crate so every experiment is reproducible from its
seed alone.

| Degradation | Represents | Explicitly does **not** represent |
|---|---|---|
| Additive Gaussian noise | read noise and shot noise lumped into one term | photon statistics (which are Poisson and signal-dependent), fixed-pattern noise, dark current |
| Per-channel gain, e.g. `[1.0, 1.03, 0.98, 1.01]` | radiometric calibration error between the four analyzer channels | spectral response mismatch, non-linearity, vignetting |
| Analyzer misalignment, per channel in degrees | mechanical or lithographic error in the polarizer axes | finite extinction ratio, angular dependence of the polarizer, crosstalk between neighbouring micro-polarizers |
| Missing-sky mask (circle or rectangle) | an obstruction or an opaque cloud in front of part of the field | **cloud physics.** It is a stress model: a hole in the data, nothing more |
| Depolarization region (DoLP scaled by a factor) | a patch that loses polarization signal | **cloud physics.** A real cloud changes radiance, spectrum, the angular distribution of scattered light *and the direction* of the residual polarization; none of that is modelled |
| Unmodelled tilt | an inclinometer or IMU that is wrong | anything about *why* it is wrong, and nothing about an accelerating platform (brief item 4) |

The mask and the depolarization region are the two most likely to be
misread. They exist to ask "what does the estimator do when it loses a patch of
the field", and they answer nothing else.

**The few-channel sensor has no mask field at all.** It has no image plane, so
an image-plane mask is not representable for it: missing sky is all-or-nothing
per photodiode, and it cannot report what fraction of sky it lost. That is
structural, and the test `the_few_channel_sensor_cannot_represent_an_image_mask`
verifies that applying an image mask leaves every few-channel row bit-identical.

---

## 5. The 180-degree ambiguity — stated precisely

Two separate facts get conflated in the literature. This module keeps them
apart, and the distinction turned out to be the most interesting finding here.

### 5.1 Sun ↔ anti-Sun is an exact symmetry, always

For any sky point, replacing the Sun by the anti-Sun leaves DoLP and AoLP
unchanged: `gamma → 180 - gamma` leaves `DoLP` alone because it depends on
`gamma` only through `sin^2` and `cos^2`, and `(-s) x v = -(s x v)` is the same
*axis*. **No polarization measurement anywhere in the sky can break this.**

### 5.2 That does not automatically make heading ambiguous by 180 degrees

Turning the instrument 180 degrees about the **vertical** maps the Sun to
`(altitude, azimuth + 180)`. That is the anti-Sun **only when the Sun is on the
horizon**. Consequently:

* a **zenith-only** sensor is ambiguous by exactly 180 degrees at any Sun
  altitude, because the zenith E-vector is perpendicular to the solar meridian
  and a meridian is a *line*. Its cost curve is 180-periodic to floating-point
  precision (verified to 1e-11 relative), and
  `heading::heading_from_zenith_aolp` gives the closed form
  `heading = sun_azimuth + 90 - psi (mod 180)` with both roots;
* a **wide-field** sensor sees a field that is genuinely different at `h + 180`.
  The separation is real *within this ideal model* — but it is produced by the
  model's own Sun-above-horizon asymmetry, and it **vanishes at both ends**.

### 5.3 Measured separation, 81 x 81 hemispherical image, noiseless

Residual RMS of the exact `best + 180` hypothesis (degrees; larger means better
separated):

| Sun altitude | 1 | 2 | 5 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 84 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anti-hypothesis residual RMS (deg) | 1.9 | 3.8 | 9.6 | 19.7 | 40.8 | 55.9 | 65.7 | 64.3 | 53.0 | 37.7 | 18.2 | 10.8 |

It peaks near 40 degrees of Sun altitude and collapses toward **both** the
horizon (where a 180-degree turn *is* the exact Sun/anti-Sun symmetry) and the
zenith (where heading does not enter the pattern at all). Narrowing the field of
view walks the sensor back toward the exact ambiguity too: at Sun altitude 40,
shrinking the field of view from 180 to 20 degrees drops the separation by more
than a factor of five (`a_narrow_field_loses_the_separation_the_wide_field_had`).

**Read that table as a property of the ideal model, not as a capability.** A
2-degree residual at a low Sun is swamped by any real noise, and the whole
effect rests on an atmosphere model with no aerosol in it.

### 5.4 What the estimator therefore does

`HeadingEstimate` **always returns the `best + 180` candidate with its cost**,
alongside every refined local minimum of the cost curve, and the full 360-point
cost curve. It never silently drops the alternative. The `ambiguity` string is
one of:

* `unobservable: …` — the Sun is within 5 degrees of the zenith (configurable).
  The pattern is rotationally symmetric about the vertical, heading does not
  enter the measurement, and **no candidates are returned**. Also emitted when
  every sample was rejected.
* `unresolved-180: …` — the alternative fits as well as the best. Both
  candidates returned; resolving them needs an independent input.
* `180-separated-by-field-asymmetry: …` — with the delta chi-square that says
  so, and the caveat that the separation is a model property.
* `180-preferred-by-radiance-hint: …` — only when the caller opted in.

The separation test is a delta chi-square against the best candidate's own
residual variance with one degree of freedom (default threshold 3.841, the
chi-square 95 % point), mirroring `docs/CONVENTIONS.md` section 8's use of
5.991 for a two-parameter position fix. A residual-RMS floor of 0.1 degrees
stops a synthetic zero-residual case from declaring every alternative infinitely
well separated.

### 5.5 The optional radiance disambiguator

Off by default. When enabled it correlates the measured `S0` against a
simplified brightness proxy `1 + k (1 + cos gamma)/2` and prefers the candidate
that correlates better. Every note it emits carries:

> radiance hint: uses a simplified radiance model, not validated. The true
> Rayleigh phase function is symmetric about 90 degrees of scattering angle and
> would resolve nothing; this hint stands in for aerosol forward scattering and
> is not a measurement of it.

That caveat is load-bearing. The actual Rayleigh phase function `(1 + cos^2
gamma)` is symmetric about 90 degrees, so it is equally bright toward the Sun
and the anti-Sun and **cannot** break the degeneracy. Real skies are brighter
toward the Sun because of aerosol forward scattering, which this module does not
model. The hint also refuses to act when the measured radiance varies by less
than 1e-4 relative — otherwise it would "resolve" the ambiguity out of
floating-point rounding noise, which it demonstrably did before that guard was
added.

Both candidates stay in the list even when the hint expresses a preference.

---

## 6. Heading estimation

Cost over trial headings, on the samples that survived the thresholds:

```
C(h) = sum_i w_i * diff180(psi_pred_i(h), psi_obs_i)^2      [deg^2]
```

1-degree grid over `[0, 360)`, every strict local minimum refined by golden
section to 1e-4 degrees. Weights are 1 by default (the brief's plain sum);
DoLP weighting is available and off.

`sigma_deg` is **nominal**: `sigma^2 = 2 s^2 / C''(h*)` with
`s^2 = C(h*) / (n - 1)`, the curvature of this cost function under an
independent-residual assumption. It is not a validated field accuracy, and it
is optimistic whenever the residuals are not identically distributed — which is
exactly what a low `min_dolp` produces.

### Tilt sensitivity

`heading::tilt_sensitivity` reports `d(heading)/d(pitch)` and
`d(heading)/d(roll)` by central differences of the estimator's own solution
against its **assumed** tilt, following the candidate nearest the unperturbed
solution so a branch jump cannot masquerade as a huge sensitivity.

Measured at 81 x 81, Sun altitude 30, levelled:

```
d(heading)/d(pitch) = 0.120 deg/deg
d(heading)/d(roll)  = 1.000 deg/deg
```

Roll is **exactly unity**, and that is not a coincidence: rolling a camera that
looks straight up is indistinguishable from turning it. An inclinometer's roll
error therefore enters the heading one-for-one, while its pitch error is
attenuated by about eight. A 2-degree unmodelled pitch produced 0.2525 degrees
of heading error against a predicted 0.2392 (ratio 1.06); a 2-degree unmodelled
roll produced 2.0000 against a predicted 2.0000. The test asserts agreement
within a factor of two.

`d(heading)/d(pitch)` grows with Sun altitude: the 2-degree tilt error costs
0.087 degrees at Sun altitude 10 and 1.28 degrees at altitude 70.

---

## 7. Experiment results

`experiments::compare_sensors` with `ExperimentConfig::default()`, seed
20 260 923. Sun azimuth 135, true heading 123, `d_max = 1`, levelled truth,
81 x 81 hemispherical image (about 4 700 valid pixels), few-channel sensor =
zenith plus a ring of four lines of sight at 45 degrees altitude, four analyzer
angles each. `tilt_err` is the pitch the estimator was told **wrongly**.
`err_deg` is the error of the candidate nearest the truth.

```
sensor        sun_alt  noise  tilt_err  n_samp  err_deg   sigma_deg
image            10.0  0.000      0.00    4607   0.0000    0.00000
few-channel      10.0  0.000      0.00       5   0.0000    0.00000
image            10.0  0.000      2.00    4607   0.0874    0.03158
few-channel      10.0  0.000      2.00       5   0.1761    0.44744
image            10.0  0.010      0.00    4613   0.0051    0.02073
few-channel      10.0  0.010      0.00       5   0.1048    0.38142
image            10.0  0.010      2.00    4613   0.0898    0.03829
few-channel      10.0  0.010      2.00       5   1.3079    0.67782
image            10.0  0.020      0.00    4617   0.0158    0.04252
few-channel      10.0  0.020      0.00       5   0.2120    0.29292
image            10.0  0.020      2.00    4646   0.0551    0.05497
few-channel      10.0  0.020      2.00       5   0.5233    0.40221
image            30.0  0.000      0.00    4677   0.0000    0.00000
few-channel      30.0  0.000      0.00       4   0.0000    0.00000
image            30.0  0.000      2.00    4677   0.2525    0.03459
few-channel      30.0  0.000      2.00       4   0.0614    0.81861
image            30.0  0.010      0.00    4672   0.0463    0.02274
few-channel      30.0  0.010      0.00       4   0.5311    0.53382
image            30.0  0.010      2.00    4666   0.1895    0.04137
few-channel      30.0  0.010      2.00       4   0.3876    0.54041
image            30.0  0.020      0.00    4683   0.0321    0.04729
few-channel      30.0  0.020      0.00       4   0.5194    0.75298
image            30.0  0.020      2.00    4695   0.2013    0.05747
few-channel      30.0  0.020      2.00       4   0.1255    1.26642
image            50.0  0.000      0.00    4730   0.0000    0.00000
few-channel      50.0  0.000      0.00       4   0.0000    0.00000
image            50.0  0.000      2.00    4730   0.5221    0.04573
few-channel      50.0  0.000      2.00       4   0.3398    1.25359
image            50.0  0.010      0.00    4731   0.0603    0.02986
few-channel      50.0  0.010      0.00       4   0.8056    0.42660
image            50.0  0.010      2.00    4740   0.3886    0.05557
few-channel      50.0  0.010      2.00       4   0.8932    1.49013
image            50.0  0.020      0.00    4732   0.0040    0.06072
few-channel      50.0  0.020      0.00       4   0.4448    1.44624
image            50.0  0.020      2.00    4760   0.5742    0.07428
few-channel      50.0  0.020      2.00       4   0.8596    1.50289
image            70.0  0.000      0.00    4754   0.0000    0.00000
few-channel      70.0  0.000      0.00       4   0.0000    0.00000
image            70.0  0.000      2.00    4754   1.2770    0.08722
few-channel      70.0  0.000      2.00       4   0.3435    2.35356
image            70.0  0.010      0.00    4763   0.0770    0.05630
few-channel      70.0  0.010      0.00       4   6.4550    2.72896
image            70.0  0.010      2.00    4760   1.3732    0.10317
few-channel      70.0  0.010      2.00       3   2.6262    5.90384
image            70.0  0.020      0.00    4764   0.1270    0.11183
few-channel      70.0  0.020      0.00       4   6.7940    4.78150
image            70.0  0.020      2.00    4773   1.2167    0.14009
few-channel      70.0  0.020      2.00       4  11.4869    4.65675
```

Reproduce with `experiments::compare_sensors(&ExperimentConfig::default())`;
`to_csv()` adds the candidate headings, the alternative's cost, the ambiguity
flag, the rejected fraction and the full ambiguity prose.

### What the table says

* **Noise.** At Sun altitude 30 with the image sensor, heading error over eight
  seeds averaged 0.0121 deg at `sigma = 0.005`, 0.0298 at 0.01, **0.0616 at
  0.02** (worst of eight: 0.154), and 0.433 at 0.05. Error scales roughly
  linearly in `sigma` until the low-DoLP tail starts to dominate.
* **`sigma_deg` is optimistic by about 1.3x** against the observed spread at
  `sigma = 0.02`, and by about 4x at `sigma = 0.05`. The residuals are not
  identically distributed across the field, which is exactly what the curvature
  formula assumes. Treat it as a scale, not a confidence interval.
* **Tilt dominates noise.** A 2-degree unmodelled pitch costs the image sensor
  more than 2 % noise does at every Sun altitude, and the cost grows with Sun
  altitude (0.087 deg at 10, 1.28 deg at 70). An unmodelled **roll** costs a
  full degree per degree.
* **Image versus few-channel.** Worst case across the sweep: **image 1.373 deg,
  few-channel 11.487 deg**, both at Sun altitude 70 with the 2-degree tilt
  error. The image sensor's nominal sigma is smaller in every matched pair —
  0.045-0.047 deg against 0.24-0.88 deg at `sigma = 0.02`, a ratio above 3 in
  every seed tested, from about 4 700 samples against 4.
* **The few-channel sensor's geometry matters more than its noise.** With the
  Sun at 70 degrees its ring at 45 degrees altitude sits in the weakly polarized
  part of the pattern, one line of sight routinely falls below the DoLP
  threshold, and the estimate degrades by an order of magnitude. That is a
  sensor-design finding, not a noise finding.
* **Masking.** Rows removed from the top of the frame: 20.6 % masked → error
  0.00000 deg; 38.3 % → 0.00000; 50.8 % → 0.00000; 63.2 % → 0.00000 in the
  noiseless case. With 42 % masked and 1 % noise the error stays below 1 degree.
  The estimator discovers the loss through its own `S0` threshold: the reported
  rejected fraction tracks the true masked fraction to within the low-DoLP
  margin.
* **Gain mismatch is a bias, not noise.** Gains `[1.0, 1.03, 0.98, 1.01]` with
  no noise at all produce **0.114 degrees** of heading error and a residual RMS
  of 0.835 degrees. Quadrupling the pixel count changes the bias by less than
  0.05 degrees. This is brief item 6 in miniature: repeating a measurement does
  not average away a common bias. A larger mismatch `[1.0, 1.1, 0.9, 1.0]`
  gives 0.905 degrees.

---

## 8. What this module does not tell you

* **Nothing about all-weather accuracy.** The sky here has no cloud, no haze and
  no aerosol. The mask and depolarization degradations are holes in the data,
  not cloud physics. No number in section 7 is a field accuracy.
* **Nothing about position.** Geolocation from polarization is **deferred by
  design**, per the brief. This module estimates *heading* given the Sun's
  altitude and azimuth as an input, which the caller must obtain from time and
  an approximate position. Heading is an orientation; it is not a fix, and
  combining it with anything to produce a position is out of scope here.
* **Nothing validated about the Sun's position.** `ephem.rs` adapts any
  `AstroProvider` to a Sun direction, reusing `skyfix_core::geometry` so the
  altitude formula cannot diverge from the rest of the workspace. The
  workspace's Sun provider is owned by another module and was a stub while this
  was written, so the adapter is exercised only against a synthetic provider.
  It returns **apparent geocentric** directions (CONVENTIONS section 7): no
  refraction, no topocentric parallax. That is the right choice for scattering
  geometry, but note a low Sun *appears* up to about 0.5 degrees higher than it
  is, and that is not modelled here.
* **Nothing about an accelerating platform.** Tilt is a parameter the caller
  supplies. Brief item 4 stands: gravity sensing on an accelerating platform is
  not a perfect local vertical, and this module assumes a stationary calibrated
  instrument.
* **`sigma_deg` is not a confidence interval.** See section 6.

---

## 9. Module map and how to run it

| file | owns |
|---|---|
| `sky.rs` | the Rayleigh model, its symmetries, the two neutral points, the world-frame AoLP convention |
| `camera.rs` | fisheye projection, extrinsics, the pixel-frame AoLP transform, image synthesis, degradations |
| `stokes.rs` | four-image Stokes recovery, DoLP/AoLP, threshold masking |
| `sensor.rs` | few-channel photodiode model, least-squares recovery (reusing `skyfix_core::linalg`) |
| `heading.rs` | the search, the candidates, the ambiguity, tilt sensitivity |
| `experiments.rs` | the seeded sweep and its CSV |
| `ephem.rs` | `AstroProvider` → Sun direction |
| `angles.rs` | modulo-180 arithmetic |
| `rng.rs` | splitmix64 + Box-Muller |
| `vec3.rs` | 3-vector and 3x3 helpers |

```
cargo test  -p skyfix-polar                                   # 58 unit + 17 integration + 1 doc
cargo clippy -p skyfix-polar --all-targets -- -D warnings
cargo build -p skyfix-polar --target wasm32-unknown-unknown
```

No dependencies beyond `serde`, `serde_json` and the workspace's own crates; no
`std::fs`, no threads, no image crates. Images are plain `Vec<f64>` with a width
and a height, which is what lets the whole module run in a browser.
