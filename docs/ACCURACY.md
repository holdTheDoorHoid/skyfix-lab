# SkyFix Lab — accuracy and limitations

What this project's numbers are worth, and where they stop being worth
anything. Sections are owned by the agent that produced the measurement; add
yours rather than editing someone else's.

Throughout: **numerical accuracy is not field accuracy.** A synthetic fixture
recovering its truth to a metre says the arithmetic is right. It says nothing
about what a sextant, a horizon and a wristwatch will do.

---

## Reference data and tolerances

All figures below are *measured* by `tools/reference/`, not asserted. Each one
is reproducible with `make -C tools/reference`. See
`tools/reference/README.md` for how, and `docs/THIRD_PARTY.md` for provenance
and licences.

### What was generated

| File | Cases | Tolerance |
|---|---|---|
| `fixtures/reference/navigational_stars_hip.json` | 58 stars | 0.05′ |
| `fixtures/reference/geocentric_sun_stars.json` | 58 epochs × 59 bodies = 3422 | 0.05′ (Sun and stars alike) |
| `fixtures/reference/topocentric_altaz.json` | 30 observer-epochs, 897 body cases | 0.05′ |
| `fixtures/reference/usno_celnav_2026-10-01T0130Z.json` | 26 stars + Aries | evidence, not a target |
| `fixtures/expected/reference-philadelphia-*.expected.json` | 5, 2 and 1 sight | 0.1′ per sight, 10 m position |
| `fixtures/expected/reference-sun-sextant.expected.json` | 5 Sun sights | 0.02′ on Ho; no position tolerance |

Generated with Skyfield 1.55, numpy 2.5.3, pandas 3.0.6, jplephem 2.24 under
CPython 3.12.3; ephemeris JPL DE421 (DE440s as cross-check); star catalogue
Hipparcos I/239 `hip_main.dat`, **epoch J1991.25, not J2000.0**.

### Why 0.05′ for the ephemeris

0.05 arcminutes is 3 arcseconds, or 93 m of great-circle arc. The reasoning, in
the order it matters:

1. **It is small against the measurement.** The tightest sigma anywhere in this
   project is 0.1′, and a realistic sextant sigma is 1′. An ephemeris error of
   0.05′ adds under 3 % to the position variance in the best case and is
   invisible in the realistic one.
2. **It is small against any claim we make.** 93 m is an order of magnitude
   below the accuracy any sextant fix asserts.
3. **It is achievable by a cheap model.** A truncated VSOP87 Sun, IAU 1980
   nutation and catalogue proper motion can plausibly meet 3″, so the tolerance
   does not force a full ephemeris into the Rust side.
4. **It still fails loudly on a wrong frame.** Omitting nutation costs up to
   17″ (0.28′); omitting annual aberration 20″ (0.33′); omitting proper motion
   over 30 years costs Rigil Kentaurus 111″ (1.85′). All are 5 to 37 times the
   tolerance.

The reference data is nowhere near being the limiting factor. Over the 57
epochs both kernels cover, **DE421 and DE440s disagree by at most 0.0031″** on
the Sun and 0.0031″ on the stars — about 1000 times inside the tolerance. DE421's
SPK ends 2053-10-08, so the single 2055 epoch is generated from DE440s and each
case records which kernel produced it.

### ΔT and DUT1 — the one place the fixtures do not match CONVENTIONS

`load.timescale(builtin=True)` uses Skyfield's bundled `iers.npz`, a daily ΔT
table derived from IERS `finals2000A.all`. In Skyfield 1.55 that table spans
**1973-01-01 to 2027-01-23**; outside it, ΔT is extrapolated by Skyfield's
long-term model. No polar motion is applied anywhere.

Values at the epochs that matter:

| Epoch | ΔT (s) | DUT1 (s) | GHA effect |
|---|---|---|---|
| 1995-01-01T00:00Z | 60.785348 | +0.398652 | +0.100′ |
| 2026-10-01T00:00Z | 69.090621 | +0.093379 | +0.023′ |
| 2026-10-01T01:30Z | 69.090615 | +0.093385 | +0.023′ |
| 2028-02-29T00:00Z | 69.073649 | +0.110351 | +0.028′ |
| 2055-01-01T00:00Z | 72.704009 | −3.520009 | −0.882′ |

Over all 58 epochs DUT1 runs from **−3.520 s to +0.717 s**.

CONVENTIONS section 6 assumes DUT1 = 0. Skyfield does not. One second of DUT1
is 15.0410686″ of hour angle, so **the assumption alone puts up to 0.88′ into
GHA — 17 times the 0.05′ tolerance.** That is far too large to leave implicit,
and it is not a rounding detail: at 2055 Skyfield's extrapolated ΔT implies a
DUT1 of −3.5 s, well outside the ±0.9 s that real leap seconds enforce, simply
because leap seconds that have not been announced cannot be modelled.

Every GHA in `geocentric_sun_stars.json` and `topocentric_altaz.json` is
therefore published twice:

* `gha_deg` — Skyfield's UT1, DUT1 applied. Physically the better number.
* `gha_deg_dut1_zero` — recomputed with UT1 = UTC, which is the CONVENTIONS
  section 6 assumption.

Declination and RA are unaffected: ΔT reaches them only through TT, where
several seconds moves the Sun by under 0.2″ and a star not at all.

**Test Rust output against `gha_deg_dut1_zero`.** The USNO cross-check below
establishes why.

### Independent confirmation: USNO

The US Naval Observatory's Celestial Navigation Data API (`apiversion 4.0.1`)
was queried for the same instant and position as the Philadelphia sessions —
2026-10-01T01:30:00Z at 39.9526, −75.1652. It is an entirely separate code
path, ephemeris and star catalogue, from the institution that publishes the
Nautical Almanac.

GHA of Aries:

| Source | Value (deg) |
|---|---|
| USNO | 32.306285051 |
| ours, `gha_deg_dut1_zero` | 32.306285045 |
| ours, `gha_deg` (Skyfield UT1) | 32.306675214 |

USNO matches the DUT1-zero column to 6 × 10⁻⁹ deg and differs from the
Skyfield-UT1 column by exactly −1.4046″ = 15.0410686 × 0.0934 s. **USNO's
celnav takes the supplied UTC as UT1, exactly as CONVENTIONS section 6 does.**
That settles which column is the Nautical Almanac convention.

On that convention, over 26 navigational stars:

| Quantity | Worst disagreement |
|---|---|
| GHA | 0.0001′ (0.006″) |
| Declination | 0.0002′ (0.012″) |
| Hc, CONVENTIONS section 3 spherical formula | 0.0002′ (0.012″) |
| Zn | 0.0001′ (0.006″) |

Two independent implementations of apparent place *and* of spherical sight
reduction, agreeing to 12 milliarcseconds. Against Skyfield's UT1 instead, the
same comparison gives 0.0235′ in GHA and 0.0179′ in Hc — still inside
tolerance, and entirely explained by DUT1.

USNO also returned the Moon and Saturn. Those are deferred bodies and are not
differenced, but the response stores them, so a future Moon or planet provider
already has an independent check waiting.

### Spherical model vs full topocentric computation

`topocentric_altaz.json` measures the gap between CONVENTIONS section 3
evaluated on the geocentric GHA/Dec, and Skyfield's full topocentric
computation, across 897 cases at five observers from the equator to 78° N.

**Stars: worst discrepancy +0.3093″** (Alnilam, equatorial observer at 179.99°
E, altitude 75.95°). That is 0.0052′, a tenth of the tolerance and a twentieth
of the tightest sextant sigma. It is diurnal aberration — the observer's own
rotation velocity, 0.32″ at the equator, which CONVENTIONS section 7 explicitly
excludes. The largest values appear at low-latitude sites for high stars near
the east-west vertical, and the sign flips with azimuth, exactly as diurnal
aberration must. **The project's spherical geocentric model is adequate for
stars, and this is the number that says so.**

**Sun: worst discrepancy +8.7643″** (Sydney, altitude 5.08°). That is not an
error: it is the topocentric parallax, precisely what CONVENTIONS section 5
step 5 restores as `PA = HP·cos(Ha)`. Every Sun case carries
`parallax_in_altitude_arcmin`, and the identity
`spherical − skyfield ≈ PA` **holds to 0.2018″** across all cases. The residual
is diurnal aberration again, plus the 0.14 % by which an observer's geocentric
radius falls short of the equatorial radius HP is defined against, plus the
second order of `HP·cos(Ha)`. 0.2018″ is 17 times inside the tolerance, so
section 5 step 5 is adequate as written.

**Azimuth**, excluding cases within 2° of the zenith: 2.4238″ for stars,
3.5584″ for the Sun. These exceed the altitude discrepancies purely
geometrically — a fixed displacement on the sky becomes an azimuth difference
of that displacement over cos(altitude), which grows without bound at the
zenith.

### Refraction: Skyfield's convention vs CONVENTIONS section 5

`topocentric_altaz.json` reports refracted altitudes from
`altaz(temperature_C=10, pressure_mbar=1010)`. Skyfield implements
Bennett (1982) as `R_deg = 0.016667 / tan(h + 7.31/(h + 4.4))` scaled by
`0.28·P/(T + 273)`, and `skyfield.earthlib.refract()` iterates
`h_app = h_true + R(h_app)` to 3 × 10⁻⁵ deg (0.108″), so Bennett's formula is
evaluated at the *apparent* altitude — which is how Bennett defined it and how
CONVENTIONS section 5 step 3 uses it. Skyfield returns zero refraction below
−1° and above 89.9° altitude.

The two are not identical. Skyfield's constant 0.016667 deg is 1.00002′ where
CONVENTIONS uses 1.0′, and its scale factor is 0.999293 of the CONVENTIONS
factor `(P/1010)·(283/(273+T))` at standard conditions. Net: **the two differ
by about 0.07 % of the refraction** — 0.0007′ at R = 1′, 0.024′ at R = 34′ near
the horizon.

0.024′ is larger than the 0.02′ budget of the Sun sextant fixture, so
`reference-sun-sextant` does **not** use Skyfield's refraction. It uses the
CONVENTIONS section 5 formula reimplemented in `tools/reference/common.py` from
the text of `CONVENTIONS.md`.

### The session fixtures

**`reference-sun-sextant` — tolerance 0.02′ on Ho.** Five lower-limb Sun sights
over an hour around local apparent noon at Philadelphia (transit
2026-10-01T16:50:15Z, altitude 46.66°), published as raw `sextant_hs` with a sea
horizon, height of eye 3 m and index correction −1.5′. The CONVENTIONS section
5 chain is run *backwards* in Python from a known geocentric Ho, solving for Ha
by fixed-point iteration to 10⁻¹³ deg. Running the chain forwards again on the
published Hs reproduces Ho to **0.0 arcminutes** — exact to floating point — so
the entire 0.02′ is the Rust implementation's own budget. 0.02′ is 1.2″ and
37 m: tight enough to catch a mistyped Bennett constant, dip 1.76 vs 0.97, or a
constant semidiameter instead of the ephemeris value; loose enough not to fail
on f64 rounding.

Ho here is the **geocentric** altitude of the Sun's centre, not Skyfield's
topocentric one. The two differ by exactly the parallax in altitude — that is
what step 5 exists to restore — and both are recorded per sight so the identity
is visible. The file also has **no position tolerance**: five Sun sights around
noon span 22° of azimuth, so latitude is well determined and longitude is not.
It is a correction-chain fixture and a deliberate poor-geometry demonstration.

**`reference-philadelphia-*` — 0.1′ per sight, 10 m position.** 18 navigational
stars are above 15° at 2026-10-01T01:30:00Z; five were chosen for azimuth
spread (Schedar 45.7°, Markab 125.4°, Altair 214.0°, Vega 280.1°, Kochab
340.0°; largest gap 88.5°) with altitudes 36.9° to 61.1°, clear of both the
low-altitude refraction flag and the near-zenith azimuth singularity.

There are **two** five-star sessions, and the difference between them is the
most useful number in `fixtures/`:

| Session | `altitude_deg` is | Python solve lands |
|---|---|---|
| `reference-philadelphia-5star` | Skyfield topocentric apparent, unrefracted | **6.237 m** from truth (−0.14 m N, −6.24 m E) |
| `reference-philadelphia-5star-geocentric` | the geocentric altitude implied by the same supplied GHA/Dec | **0.000 m** from truth |

Both pass the 10 m target. But the topocentric session's 6.24 m is not solver
error: it is diurnal aberration, up to 0.21″ across these five sights, which
CONVENTIONS section 7 deliberately excludes from the model. It is almost purely
east-west, because diurnal aberration displaces the apparent sky toward the
east point of the horizon. **62 % of the 10 m budget is spent before the solver
does anything wrong.**

So: regress the solver against `reference-philadelphia-5star-geocentric`, where
any error at all is a solver error. Use `reference-philadelphia-5star` to show
that a physically realistic synthetic sight still lands inside 10 m. The 10 m
figure is a numerical regression target on clean, well-conditioned synthetic
geometry, exactly as `docs/BRIEF.md` frames it — **not a field accuracy
claim.** No sextant, horizon, atmosphere or clock is involved anywhere in these
files.

Note the deliberate inversion. With σ = 0.1′ on these five azimuths the *a
priori* covariance gives σ<sub>north</sub> = 118.9 m, σ<sub>east</sub> =
115.4 m and a 95 % ellipse of 291 m × 282 m — an order of magnitude *larger*
than the 10 m target. That is correct and intended, and a useful check on the
uncertainty module: the target tests arithmetic on noiseless data, while the
ellipse describes noise these fixtures do not contain. A solver that reports a
10 m ellipse here is wrong even though its position is right.

The two-sight fixture's circles intersect at 6.60 m from truth and at
14.178° N, 130.036° W — **6023 km away**, in the Pacific. Both intersections are
computed analytically in Python and written into the expected file. The assumed
position sits near the truth-side intersection on purpose, so that a solver
which finds only the nearby minimum looks like it succeeded.

The assumed position in every star session is (40.5, −74.5), about 83 km from
truth, with role `initializer`. A converged fix must be independent of it.

### Star catalogue: what is and is not verified

Every one of the 58 `name → HIP` mappings was checked against an independently
known position and V magnitude for the star the name promises. All 58 resolved
within 0.2° and 0.5 mag; no mapping is in doubt. The three largest position
residuals are **Rigil Kentaurus 32.30″, Arcturus 21.73″, Sirius 11.58″** —
exactly their proper motion over the 8.75 years from the catalogue epoch
J1991.25 to J2000.0, which independently confirms both the identities and the
epoch.

Caveats recorded in the file itself:

* **Positions are at J1991.25, not J2000.0.** The `generator` block declares
  `"epoch": "J1991.25"`. A consumer that assumes J2000 is wrong by 32″ for
  Rigil Kentaurus.
* `pm_ra_cosdec_mas_yr` is the catalogue's `pmRA`, already μ<sub>α</sub>·cos δ,
  not dRA/dt.
* `parallax_mas` can be negative where measurement noise exceeded the parallax;
  published values are left as published.
* Radial velocity is not in `hip_main.dat` and is taken as zero, so there is no
  perspective-acceleration term. For the fast, nearby Rigil Kentaurus
  (−22 km/s) that is a real approximation over decades.
* **Acrux** (HIP 60718) is α¹ Crucis; the Almanac tabulates the combined image
  of a close pair, a difference of about 4″. **Rigil Kentaurus** (HIP 71683) is
  α Centauri A; the Almanac's is the A+B photocentre, which orbits with an
  80-year period and can differ by several arcseconds. These two are the reason
  the star file's tolerance is 0.05′ rather than something tighter.
* **Betelgeuse** is a semiregular variable (V ≈ 0.0 to 1.3); its catalogue
  magnitude is one epoch, not a prediction.

### What none of this covers

* **Polar motion** is never applied, by Skyfield or by the project. It reaches
  0.3″ of station displacement, about 9 m — below the ephemeris tolerance but
  not below the 10 m regression target. It is not in any fixture.
* **Deflection of the vertical** (geoid minus ellipsoid) can reach tens of
  arcseconds in mountainous terrain and is not modelled anywhere. A real
  artificial horizon measures the *geoid* normal; every fixture assumes the
  WGS84 ellipsoid normal.
* **The Moon and planets** are not covered. The USNO response contains an
  independent check for them if they are ever added.
* **Refraction below Ha = 0** is rejected, and Bennett's own residual (≤ 0.07′)
  is inside the sigma floor and not modelled. Real anomalous refraction near
  the horizon is far larger than either and is not represented in any fixture.
* **Everything here is synthetic.** Not one number in `fixtures/` came from an
  instrument.
