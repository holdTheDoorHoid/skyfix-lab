# Observation planner — what it optimises and what it cannot tell you

Implements the "Observation planner, if time permits" item of `BRIEF.md`. Code:
`skyfix_core::planner` (the ranking) and `skyfix_ephemeris::visibility` (the sky and the
twilight flag). This document is descriptive; `CONVENTIONS.md` remains normative, and the
planner cites sections 3, 5 and 9 of it.

The planner answers one question: **given roughly where I am and roughly when, which
bodies should I shoot, and in what order, so the fix comes out as small as possible?**

It does not answer "which stars can I see". That would need weather.

---

## 1. What the ranking optimises

A sight of a body at true azimuth `Zn`, with altitude standard deviation `sigma`,
contributes exactly one row to the tangent-plane Jacobian (CONVENTIONS section 3):

```text
dh = cos(Zn) dN + sin(Zn) dE          row = [cos Zn, sin Zn]
```

Weighting each row by `1 / sigma` and stacking them gives the a-priori position
information matrix and its covariance (CONVENTIONS section 9):

```text
M   = J^T W J = sum_i [cos Zn_i, sin Zn_i]^T [cos Zn_i, sin Zn_i] / sigma_i^2
Cov = M^-1                            2 x 2, (north, east)
```

Everything is in **metres**, using the project's exact identity
`1 arcminute of arc = 1 NM = 1852 m` (`units::NM_M`), so `M` is in `m^-2` and `Cov` in
`m^2` with no further scaling.

The crucial property is that **`M` depends only on the azimuths and the sigmas**. It does
not depend on the measured altitudes, on the residuals, or on anything that only exists
after the sight is taken. That is what makes a plan possible at all — and it is also the
limit of what a plan can promise: the predicted sigma is a statement about *geometry*, not
about whether your sextant, your horizon or your chronometer are any good.

Selection is **greedy forward**: start from whatever is already taken, and repeatedly add
the single candidate that most improves the objective at that step. The reported `score`
is that improvement, measured at the step the body was chosen — not its marginal value in
the finished set, and not a proof that the chosen five are the best five. Greedy
A-optimal selection is a heuristic. For five bodies out of twenty it is a very good one;
it is not an optimum.

### Why brightness is not the criterion

A first-magnitude star adds nothing you do not already have if its azimuth duplicates a
sight you have taken: the new row is parallel to the old one, `M` stays effectively rank
1, and position remains undetermined along the perpendicular no matter how many more you
shoot. A third-magnitude star in the one open direction can halve the error ellipse.

Brightness survives in the output as `Candidate::magnitude`, is quoted in each rationale,
and is used nowhere in the arithmetic. Every plan says so in its notes.

### Why not "equally spaced azimuths" either

Equal spacing is a decent rule of thumb and a bad objective. It ignores the sigmas
entirely — three equally spaced sights at 6 degrees altitude are worse than two
perpendicular ones at 45 — and it ignores the sights you have already taken. It also
mishandles the basic fact that a line of position is **undirected**: a body at azimuth 100
and a body at azimuth 280 produce the *same* row up to sign and therefore exactly the same
information. The planner works on axes (`azimuth mod 180`), which is why
`max_azimuth_gap_deg` can read 209 degrees on a plan whose condition number is 1.15. That
diagnostic comes from `uncertainty::conditioning` and is reported unchanged; read it as
"where the bodies are", not "how good the geometry is".

---

## 2. The three objectives

All three minimise a scalar function of `Cov`. `MinTrace` is the default.

### `min_trace` — A-optimal, the default

Minimise `trace(Cov) = sigma_north^2 + sigma_east^2`, reported as its square root so the
cost is in metres. This is the average variance over all directions: it makes the fix
small **on the whole**. It is the right default because a navigator asks "how big is my
error" before asking "in which direction".

It will accept a slightly more elongated ellipse in exchange for a large reduction in
overall size. In the worked example below it does exactly that at step 3, where the
condition number rises from 1.18 to 1.26 while the 1-sigma radius falls from 2654 m to
2196 m.

### `min_max_eigenvalue` — E-optimal

Minimise the largest eigenvalue of `Cov`, reported as its square root: the 1-sigma
semi-major axis, in metres. The pessimist's objective — it improves the *worst* direction
and cares about nothing else, so it drives hard toward a circular ellipse and will reject
a body that only sharpens the already-good axis.

Choose it when one direction matters: closing a coast, running a line of soundings, or
when you simply distrust the weakest axis of the fix.

### `min_condition_number` — shape only

Minimise the condition number of `W^(1/2) J`, which is the **aspect ratio of the error
ellipse**, `semi_major / semi_minor`. Dimensionless, never below 1.

CONVENTIONS section 9 defines the reported condition number on the Jacobian, so the
eigenvalue ratio of `Cov` is its square. This objective uses the Jacobian convention so
that its cost and `PlanMetrics::condition_number` are the same number.

It optimises shape and is blind to size: three weak sights at 120 degrees score better
than two excellent sights 80 degrees apart. Use it to diagnose or repair geometry, not to
minimise error — a plan built on it can finish with a *larger* ellipse than one built on
`min_trace`.

### When the covariance does not exist

With fewer than two independent azimuths, `M` is singular and `Cov` does not exist, so
none of the three costs is defined. Those steps are scored instead on the growth of

```text
ln det(M + ridge * I)          ridge = 1 / (1e8 m)^2
```

in nats, where the ridge is one isotropic pseudo-sight at a standard deviation of
100 000 km — about 16 Earth radii, i.e. no navigational information whatsoever. It exists
only so the determinant is finite; it is **not** a prior on position and it does not
survive into the reported covariance.

Every step says which basis it used (`PlannedBody::score_basis`, `score_units`), and any
plan that used the ridge says so in `Plan.notes`. Nat-valued and metre-valued scores are
not comparable with each other, which is why they are labelled rather than blended.

This is not a workaround for a numerical problem. It is the honest statement that with one
sight there is no position error to minimise, only a line, and the useful question becomes
"which second body opens the widest angle", which is what `ln det` measures.

---

## 3. Assumptions

1. **An approximate position is required and is disclosed on every plan.** The azimuths
   come from it. It is a planning input only; it is never a prior on the fix that follows
   (CONVENTIONS section 8 — an assumed position used as an initializer must not silently
   become a probabilistic prior). A plan built on a position 60 NM out will still be
   roughly right, because azimuths change slowly with position; a plan built on the wrong
   *hemisphere* will be nonsense.
2. **Visibility is geometric.** A body is a candidate when its computed altitude clears
   the floor. No cloud, haze, headland, rigging, Moon glare, or knowledge of what is
   actually on your horizon.
3. **Altitudes are geometric, not refracted.** They come from the apparent geocentric
   direction (CONVENTIONS section 7) and the approximate position. Refraction would raise
   a real body by about 0.06 degrees at the 15-degree floor — far inside the uncertainty
   of the approximate position the whole plan rests on — so it is deliberately not
   applied.
4. **Noise is independent between sights.** `Cov = (J^T W J)^-1` assumes it. A shared
   instrument bias or a chronometer error is a *common* error, and no amount of
   well-spread geometry removes it (BRIEF, non-negotiable distinction 6). The planner
   cannot see such a bias and does not model it. A plan predicting 1.2 NM of 1-sigma is
   saying "if your errors are independent and 1.0 arcminute each"; it is not saying your
   fix will be within 1.2 NM.
5. **The Sun's altitude is supplied by the caller.** The Sun provider is a separate
   deliverable. `sun_altitude_deg: Option<f64>`; `None` produces the note
   "Sun altitude unknown" and nothing is assumed.
6. **Errors are exclusions, not omissions.** A body the provider does not know, or a time
   outside its coverage, is an `EphemerisError`. A plan that quietly dropped half the sky
   would be worse than no plan.

### The altitude window

Default `[15, 75]` degrees. Both bounds are options, not laws.

**Below 15 degrees** refraction is large and increasingly dependent on the real
temperature profile rather than the standard atmosphere, and the sea horizon under a low
body is the most likely to be obscured. The expected sigma is inflated before the cut ever
applies:

```text
altitude < 5 deg         sigma^2 = base^2 + 1.0'^2    CONVENTIONS section 5; the reducer applies this too
5 <= altitude < 10 deg   sigma^2 = base^2 + 0.3'^2    planning only: MODERATE_ALTITUDE_SIGMA_ARCMIN
altitude >= 10 deg       sigma   = base
```

The 0.3' term is this module's own. Between 5 and 10 degrees refraction is still 5 to 10
arcminutes and its dependence on the temperature profile is already several percent, so a
sight there is genuinely worse than the same sight at 40. On a 1.0' instrument it costs
4 % (1.00' becomes 1.04'), enough to break a tie in favour of the higher body and never
enough to outrank geometry. It is a *planning* term and is deliberately not applied by
`corrections`: it must never silently change a reduced sight's weight.

**Above 75 degrees** the azimuth of the line of position is poorly defined — near the
zenith a small altitude error swings it a long way — and the sextant is awkward to hold
and swing. Deneb is excluded on exactly this ground in the worked example below, despite
being the highest body in the sky at that moment.

`already_taken` sights are **not** subject to the window. They are facts, not choices.

### Determinism and tie-breaks

Ties happen constantly and are usually exact: azimuth 135 and azimuth 315 are the same
line of position and carry identical information. The order is therefore fixed by rule:

1. strictly better score wins;
2. within `1e-12` relative, the **higher altitude** wins;
3. otherwise the earlier candidate in the input order wins.

For this to mean anything, the arithmetic has to produce exact ties. It does:
`det(M)` is formed by Cauchy-Binet as a sum of squares,
`sum_{i<j} (r_i[0] r_j[1] - r_i[1] r_j[0])^2`, not as `M00 M11 - M01^2`. The textbook
expression is a difference of two nearly equal numbers exactly where a planner is used —
clustered azimuths — and for a single sight it returns rounding noise of order
`1e-16 * trace^2` where the answer is zero, which is large enough to decide a comparison
that ought to tie.

The same stability is why `rank` and `condition_number` in `PlanMetrics` come from `Info`
rather than from `uncertainty::conditioning`: that function derives them from the Gram
matrix, which squares the condition number and floors the smaller singular value at about
`sqrt(eps)`, so it cannot see a one-sight Jacobian as rank 1. Its geometry-only dilution
and azimuth gap are reused unchanged.

### One property worth knowing before you trust the ordering

**After two perpendicular equal-sigma sights, the azimuth of the third does not matter.**
For an isotropic `M`, adding one unit-weight row leaves `trace(Cov)`, the largest
eigenvalue and the condition number all *exactly* unchanged, whatever its azimuth. All
three objectives are indifferent; only the third sight's sigma can separate the
candidates, and the tie-break decides. This is a real property of the criteria, it is
pinned by a test, and it is the reason the rationale for such a step says "already
balanced" rather than claiming a geometric argument it did not make.

---

## 4. Disclosures

Every `Plan` carries these three strings in `notes`, unconditionally:

- `approximate position supplied: <lat>, <lon>: ranking is only as good as it`
- `geometric visibility only: no weather, no twilight model beyond the Sun-altitude flag`
- `brightness is secondary to geometry in this ranking`

Plus, as they apply: the objective's description; the ridge disclosure when any step was
scored on log-determinant growth; one line per excluded candidate with its reason; the
selected/eligible/excluded counts; and from `plan_at`, how many catalogue bodies cleared
the altitude floor and what the twilight flag was.

### The twilight flag

The one piece of sky condition modelled, and it is geometry, not weather. Given the Sun's
altitude:

| Sun altitude | note attached to every star candidate |
|---|---|
| above -6 deg | `sky likely too bright for stars (civil twilight or day)` |
| -12 to -6 deg | `nautical twilight: horizon and stars both visible (sea horizon)` |
| below -12 deg | `dark: stars visible, natural horizon likely not (artificial horizon or electronic vertical needed)` |
| not supplied | `Sun altitude unknown` |

The middle band is why star sights are taken at twilight: the stars are out and the sea
horizon is still a sharp line. In full dark the stars are better and the horizon is gone —
a statement about the *horizon reference*, not about the stars, hence the pointer to an
artificial horizon or an electronic vertical (CONVENTIONS section 5). The note is attached
to stars only; telling a Sun sight that the sky is too bright for stars would be nonsense.

---

## 5. Worked example — Philadelphia, 2026-10-01T01:30:00Z

Philadelphia City Hall, `39.9526, -75.1652` (CONVENTIONS section 2), at 01:30 UTC on
1 October 2026 — about 21:30 local, well after dark. Instrument sigma 1.0 arcminute,
default options (`select = 5`, altitude window `[15, 75]`, `min_trace`), Sun altitude
supplied as -15 degrees. Bodies from `StarProvider` (IAU 2006/2000B, Hipparcos).

```rust
let provider = StarProvider::new();
let names: Vec<String> = provider.bodies().iter().map(|s| s.to_string()).collect();
let plan = plan_at(
    &provider,
    &names,
    LatLon { lat_deg: 39.9526, lon_deg: -75.1652 },
    "2026-10-01T01:30:00Z",
    &PlanOptions::default(),
    Some(-15.0),
)?;
```

Eighteen of the 58 catalogue bodies are above 15 degrees. One, Deneb, is above 75.

### The five bodies, in shooting order

| step | body | altitude | `Zn` | sigma | magnitude | score | units |
|---|---|---|---|---|---|---|---|
| 1 | Vega | 61.1 | 280.1 | 1.00' | 0.03 | 21.8 | nats |
| 2 | Polaris | 40.0 | 0.8 | 1.00' | 1.97 | 21.8 | nats |
| 3 | Mirfak | 27.0 | 46.0 | 1.00' | 1.79 | 457.1 | m |
| 4 | Alkaid | 18.3 | 319.7 | 1.00' | 1.85 | 337.1 | m |
| 5 | Rasalhague | 36.1 | 254.9 | 1.00' | 2.08 | 186.1 | m |

Read the list, not the magnitudes. Vega (0.03) is first because with nothing taken every
azimuth is equivalent and the tie-break takes the highest eligible body. Capella, at
magnitude 0.08 the second-brightest thing available, is never selected: it is at 10.1
degrees, below the floor. Rasalhague at magnitude 2.08 is selected, because it is where
the geometry wanted a sight.

### Rationales, verbatim

> **Vega** — no sights yet, so position is unconstrained in every direction; this body's
> azimuth 280 opens the first line of position. Magnitude 0.03, which did not enter the
> ranking. dark: stars visible, natural horizon likely not (artificial horizon or
> electronic vertical needed).
>
> **Polaris** — current geometry is weak along the N-S axis (no constraint at all on that
> axis yet); this body's azimuth 1 adds constraint there. Magnitude 1.97, which did not
> enter the ranking. dark: stars visible, natural horizon likely not (artificial horizon
> or electronic vertical needed).
>
> **Mirfak** — current geometry is already balanced (information ratio 1.38); this body's
> azimuth 46 sharpens it without changing its shape much. Magnitude 1.79, which did not
> enter the ranking. dark: [...]
>
> **Alkaid** — current geometry is weak along the NW-SE axis (information ratio 1.6); this
> body's azimuth 320 adds constraint there. Magnitude 1.85, which did not enter the
> ranking. dark: [...]
>
> **Rasalhague** — current geometry is already balanced (information ratio 1.20); this
> body's azimuth 255 sharpens it without changing its shape much. Magnitude 2.08, which
> did not enter the ranking. dark: [...]

### Predicted quality, step by step

`Plan.progression[0]` is the baseline (nothing taken); each later entry is the state after
that pick. All figures are 1-sigma, in metres, from the a-priori covariance.

| sights | sigma N | sigma E | sqrt(trace) | semi-major | semi-minor | major axis `Zn` | dilution m/' | cond | rank |
|---|---|---|---|---|---|---|---|---|---|
| 0 | — | — | — | — | — | — | — | — | 0 |
| 1 | — | — | — | — | — | — | — | — | 1 |
| 2 | 1847.7 | 1904.5 | 2653.5 | 2021.4 | 1719.1 | 50.4 | 2653.5 | 1.176 | 2 |
| 3 | 1546.8 | 1559.4 | 2196.4 | 1721.2 | 1364.5 | 134.0 | 2196.4 | 1.261 | 2 |
| 4 | 1283.7 | 1345.2 | 1859.4 | 1372.0 | 1254.9 | 60.9 | 1859.4 | 1.093 | 2 |
| 5 | 1260.9 | 1100.0 | 1673.3 | 1264.0 | 1096.4 | 171.8 | 1673.3 | 1.153 | 2 |

Three things to take from that table.

- **The first two rows are blank on purpose.** One sight is a line, not a position; no
  covariance exists, and the planner reports `None` rather than a number. Those two steps
  are the ones scored in nats.
- **`sqrt(trace)` falls monotonically**, 2653 to 1673 m, and that is guaranteed: adding a
  row can only increase `M` in the Loewner order. The `score` column above is exactly the
  drop at each step (457.1 = 2653.5 - 2196.4, and so on).
- **The condition number does not fall monotonically** — 1.176, 1.261, 1.093, 1.153. It is
  not what `min_trace` optimises. Step 3 buys 457 m of overall size at the cost of a
  slightly more elongated ellipse. Under `min_max_eigenvalue` the same five bodies come
  out in the same order for this sky, but the scores differ (Mirfak 300.2 m, Alkaid
  349.2 m, Rasalhague 108.0 m) because the quantity being reduced is the semi-major axis
  rather than the overall size.

The final `1673 m` is `0.90 NM` of 1-sigma radius from five one-arcminute sights, and the
geometric dilution equals `sqrt(trace)` exactly because every sigma is 1.0 arcminute — the
weighted and geometry-only measures coincide in that case, which is a useful check.

### Exclusion

> **Deneb** (82.7 deg, `Zn` 320.6) — altitude 82.7 deg is above the 75.0 deg maximum: near
> the zenith the azimuth of the line of position is poorly defined (a small altitude error
> swings it a long way) and the sextant is hard to hold and swing.

Deneb is the highest body in the sky at that instant and a perfectly bright one. It is
excluded by name, with its reason, in both `Plan.excluded` and `Plan.notes`.

---

## 6. Limitations, stated plainly

- The predicted sigma is a **geometry-and-sigma prediction**, not an accuracy claim. It
  assumes independent noise at the sigma you supplied. Shared bias and clock error are
  invisible to it.
- Greedy selection is a heuristic, not an optimum, and the `score` is a per-step figure.
- No weather, no cloud, no obstruction, no Moon.
- No motion: the plan is for a stationary observer at one instant. A body's azimuth moves
  by roughly a quarter of a degree per minute of time at mid-latitudes, so a plan is good
  for the twilight window it was made for and no longer.
- No Sun, Moon or planets unless the provider supplies them; the twilight flag is supplied
  by the caller, not computed.
- The approximate position is a planning input. It never becomes a prior on the fix.
