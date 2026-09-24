# SkyFix Lab — accuracy and limitations

What this project's numbers are worth, and where they stop being worth
anything. Sections below are owned by the agent that produced each
measurement; add yours rather than editing someone else's.

Throughout: **numerical accuracy is not field accuracy.** A synthetic fixture
recovering its truth to a metre says the arithmetic is right. It says nothing
about what a sextant, a horizon and a wristwatch will do. This is also the
one place in the project where the word "accuracy" is used loosely in
headings for readability; everywhere else — the CLI, the browser workbench,
`skyfix coverage` — it is deliberately avoided in favour of *nominal
uncertainty under a stated model*, and the browser's About view says so in
those words.

## 1. What accuracy means here

Two different questions get asked of this project, and they have different
answers:

- **Numerical agreement.** Does the Rust arithmetic match an independent
  implementation of the same published model (Skyfield, ERFA, USNO), and does
  the solver recover a known synthetic truth? This is what sections 2 and 3
  below measure, and it is checkable to fractions of an arcsecond or metres
  of position.
- **Field accuracy.** Would a real sextant sight, taken from a real horizon,
  with a real chronometer, actually land where this tool says it would? This
  project does not measure that, because it has taken no real sights (see
  section 5). Every number anywhere in this document, `fixtures/`, or the
  test suite comes from a simulation, an independently generated reference
  fixture, or a synthetic session — never an instrument.

Reading a small number in this document (0.05 arcminutes of ephemeris error,
10 metres of solver regression, 95 % coverage of a nominal ellipse) as a
promise about a real fix in the field is the one mistake every section here
is written to prevent.

## 2. Ephemeris versus the Skyfield reference

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

The last two rows are session and solver-regression fixtures, not pure
ephemeris comparisons; their numbers are discussed in section 3.

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
because leap seconds that have not been announced cannot be modelled. Section 4
below carries the everyday-case figure (|DUT1| < 0.9 s, up to 0.23′ of GHA)
into the error budget; this section is where the extrapolated worst case
(0.88′) comes from.

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

USNO also returned the Moon and Saturn. Those are deferred bodies (section 5)
and are not differenced, but the response stores them, so a future Moon or
planet provider already has an independent check waiting.

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

### Ephemeris providers versus the Skyfield reference (measured at integration)

Both offline providers were compared with `fixtures/reference/geocentric_sun_stars.json`
(Skyfield 1.55, JPL DE421 with a DE440s cross-check, 58 epochs from 1995 to 2055 plus
every hour of 2026-10-01). The fixture's tolerance is 0.05'. The project convention is
DUT1 = 0, so the comparison column is `gha_deg_dut1_zero`; the USNO almanac service agrees
with that column to 1e-8 degrees.

| provider | cases | worst GHA | worst Dec | tolerance |
|---|---|---|---|---|
| stars (IAU 2006/2000B, Hipparcos) | 3364 | 0.0011' (0.07") separation | included in separation | 0.05' |
| Sun (VSOP87D, 1020 terms) | 58 | 0.0026' (0.16") | 0.0012' (0.07") | 0.05' |

With the fixture's own DUT1 applied through `StarProvider::with_dut1`, the star GHA agrees
with the DUT1-inclusive column to 0.027' worst case; the difference from the DUT1 = 0
comparison is the DUT1 handling itself, which the project reports as an external error
term (up to 0.23' for |DUT1| < 0.9 s) rather than folding into the model accuracy.

Each provider also declares its own, rounder, documented figure through
`skyfix coverage` — the number a caller sees without reading this document:
**0.01 arcminutes for the Sun, 0.02 arcminutes for the stars**, explicitly
*not* including the DUT1 term. Section 4 uses the more conservative, measured
worst cases above.

What these numbers are not: field accuracy. They say the Rust astronomy reproduces an
independent implementation of the same IAU models to well under an arcsecond; sextant
sights are a hundred to a thousand times noisier than that.

### Planets

Owner: planets agent. `skyfix_ephemeris::planets::PlanetProvider`, Mercury to Neptune,
apparent geocentric of date (CONVENTIONS section 7): truncated VSOP87A heliocentric
positions of the planet and the Earth, light-time, deflection by the Sun, relativistic
annual aberration, then the same IAU 2006/2000B frame rotation and sidereal time as
the Sun and the stars. Provenance of the series is in `docs/THIRD_PARTY.md`, "Planet
model".

**The reference.** `fixtures/reference/planets_<planet>.json`, generated by
`tools/reference/gen_planets.py` from Skyfield 1.55 with JPL **DE440s** (DE421 as a
cross-check where it covers, to 2053-10-08). Each file has 322-338 epochs over
1990-2060: a regular grid with the time of day varying, plus the events where a model
is most easily wrong — every inferior conjunction of Venus and every other one of
Mercury, superior conjunctions, greatest elongations, every opposition and conjunction
of Mars to Neptune, stations, and Saturn's 11 ring-plane crossings.
`crates/skyfix-ephemeris/tests/planets_reference.rs` asserts every epoch.

**Between the fixture epochs.** `tools/reference/gen_vsop87a.py` also compares the
embedded series with DE440s **every day** of the window (25 936 epochs), as geometric
geocentric directions. The rest of the chain agrees with Skyfield to about 0.001", so
this daily figure is the provider's error between fixture epochs. It matters: Venus's
worst day (0.0041') falls between fixture epochs (0.0031'). The published figures are
the larger of the two, rounded up.

GHA with DUT1 = 0 against `gha_deg_dut1_zero`, and Dec, arcminutes:

| planet | epochs | worst GHA | worst Dec | daily RA / Dec | published | vs DE421 GHA / Dec |
|---|---|---|---|---|---|---|
| Mercury | 330 | 0.0022 | 0.0010 | 0.0023 / 0.0014 | 0.005 | 0.0021 / 0.0011 |
| Venus | 329 | 0.0031 | 0.0024 | 0.0041 / 0.0024 | 0.005 | 0.0031 / 0.0024 |
| Mars | 322 | 0.0032 | 0.0016 | 0.0034 / 0.0017 | 0.005 | 0.0032 / 0.0016 |
| Jupiter | 325 | 0.0063 | 0.0040 | 0.0064 / 0.0041 | 0.01 | 0.0063 / 0.0042 |
| Saturn | 338 | 0.0061 | 0.0016 | 0.0061 / 0.0016 | 0.01 | 0.0061 / 0.0016 |
| Uranus | 330 | 0.029 | 0.0055 | 0.029 / 0.0055 | 0.035 | 0.032 / 0.0072 |
| Neptune | 333 | 0.040 | 0.012 | 0.040 / 0.012 | 0.045 | 0.041 / 0.013 |

**Every planet meets the 0.1' target of CONVENTIONS 13.7**, the navigational four
(Venus, Mars, Jupiter, Saturn) by a factor of 15 or more. The provider reports
`accuracy_arcmin = 0.05` (Neptune, rounded up), so the explorer marks the planets
validated. With each epoch's own DUT1 supplied, GHA agrees with the DUT1-inclusive
column to the same figures, which checks that `with_dut1_s` is applied.

**Where the error comes from.**

| source | size | notes |
|---|---|---|
| VSOP87 itself | 0.08-0.12" Mercury to Mars, 0.3-0.4" Jupiter and Saturn, 1.5" Uranus, 2.2" Neptune | the series were fitted to DE200 (1988); DE200's outer-planet orbits are that far from DE440's. Measured with the full, untruncated series |
| truncation | at most 0.23" (Venus at inferior conjunction), measured every 6 hours | the planet's and the Earth's dropped terms together |
| frame tie | about 0.03" | VSOP87's J2000 frame is DE200's, used as the ICRS |
| deflection by Jupiter and Saturn | under 0.0003" | Skyfield applies it; this provider does not |
| nutation IAU 2000B vs 2000A | about 0.001" | shared with the Sun and stars |
| system barycentre vs centre of the disc | up to 0.08" (Jupiter), 0.05" (Saturn) | in both VSOP87 and DE440s for Mars to Neptune, so not in the table; real, and not modelled |
| DUT1 = 0 | up to 0.23' of GHA | CONVENTIONS section 6; not in `accuracy_arcmin`, stated in the coverage notes |

The reference itself is not the limit, except for Uranus: **DE421 and DE440s disagree
by up to 2.84" on Uranus** over these epochs (0.20" on Neptune, 0.02" on Jupiter, under
0.01" elsewhere). JPL's own Uranus moved between the two releases by more than this
provider's Uranus error.

**Planets hidden behind the Sun.** 42 of the 2 307 epochs (mostly conjunctions) put the
planet behind the solar disc. There the deflection formula, which describes a ray
passing outside the Sun, grows without bound toward the Sun's centre, and Skyfield
applies it anyway: 195" for Uranus on 2029-06-04, when it passed 8" from the centre.
This provider caps the deflection at its limb value (1.75") instead, so it differs
from Skyfield by up to 3.2' at those epochs — for a planet nobody can see. The test
judges them against the fixture's undeflected place instead (`no_deflection`), and
they agree to within the published figure plus the 1.75" cap (worst 0.033').

**Other quantities** (worst over all seven planets, assert in brackets):

| quantity | worst | asserted |
|---|---|---|
| illuminated fraction | 1e-6 | 0.001 |
| phase angle | 0.00007 deg | 0.01 deg |
| elongation | 0.037' (Neptune) | 0.1' |
| bright-limb angle | 37 % of what a 0.1' position error allows at that elongation | 100 % |
| distance, semidiameter, horizontal parallax | 4e-6 relative (Uranus) | 1e-5 |
| magnitude vs the same formulas with the true Sun | 0.0001 | 0.01 |

**Magnitudes.** Mallama & Hilton (2018), the formulas Skyfield's
`planetary_magnitude` implements, evaluated with the Sun where the paper puts it.
Skyfield's function puts the Sun at the solar-system barycentre instead (its source
says so), up to 0.01 au away; the fixtures carry both, and the difference is Skyfield's
choice, not this provider's error:

| planet | vs Skyfield `planetary_magnitude`, worst | epochs beyond 0.1 |
|---|---|---|
| Mercury | 0.21 | 6, all with Mercury a thin crescent within 16 deg of the Sun (phase angle 137-180 deg, magnitude +1.8 to +7.0) |
| Venus | 0.053 | 0 |
| Mars, Jupiter, Saturn, Uranus, Neptune | 0.014, 0.004, 0.012, 0.022, 0.016 | 0 |

So the 0.1 magnitude target is met for six planets everywhere and for Mercury except
as a thin crescent, where the whole difference is the barycentre shortcut (the test
checks that for each such epoch: Skyfield's two columns differ by at least as much). Formula limits, all from the paper: Mars's
rotational and seasonal terms are not applied (as in Skyfield; up to about 0.06 mag);
Mercury beyond its observed 169.5 deg phase angle and Venus beyond 179 deg are
extrapolations; Saturn has no magnitude outside phase angle 6.5 deg or ring tilt
27 deg (never reached from the Earth); for Neptune before 2000 above 1.9 deg of phase,
where Skyfield returns NaN, the paper's own geocentric formula (eq. 16, no phase term,
at most 0.015 mag) is used.

**Speed.** One planet, release build, x86-64: 32 µs (Neptune) to 64 µs (Mars). All seven
at one instant: 206 µs, because the Earth's series and the precession-nutation matrix
are computed once per instant and each planet's series is summed once (the light-time
is estimated from its leading terms and finished with a linear step, held by a unit
test to 1e-5" of the full iteration). `cargo test --release -p skyfix-ephemeris --test
planets_provider -- --ignored --nocapture` prints the timings.

**Reproduce.** `tools/reference/.venv/bin/python -m tools.reference.gen_planets`
regenerates the fixtures (about 2 minutes), and
`python -m tools.reference.gen_vsop87a --source DIR` the series and the daily DE440s
comparison (about 9 minutes, needs the VI/81 files; see `tools/reference/README.md`).
`cargo test -p skyfix-ephemeris --test planets_reference -- --nocapture` prints every
figure in this section.

## 3. Solver regression targets and the Monte Carlo coverage results

### The session fixtures: a 10 m numerical regression target

`docs/BRIEF.md` states the target plainly: *"clean, well-conditioned synthetic
geometry should recover its truth within 10 metres; this is a numerical
regression target, not a real-world accuracy claim."* These fixtures are
where that target is measured.

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
CONVENTIONS section 7 deliberately excludes from the model (compare the more
general, worst-case 0.32″ at the equator measured in section 2 above). It is
almost purely east-west, because diurnal aberration displaces the apparent sky
toward the east point of the horizon. **62 % of the 10 m budget is spent before
the solver does anything wrong.**

So: regress the solver against `reference-philadelphia-5star-geocentric`, where
any error at all is a solver error. Use `reference-philadelphia-5star` to show
that a physically realistic synthetic sight still lands inside 10 m. The 10 m
figure is a numerical regression target on clean, well-conditioned synthetic
geometry — **not a field accuracy claim.** No sextant, horizon, atmosphere or
clock is involved anywhere in these files.

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

### The Monte Carlo coverage results

`docs/BRIEF.md`'s "Validation that matters" asks for "seeded Monte Carlo
coverage checks for nominal ellipses under the stated independent-noise model
... [and] correlated-error scenarios as explicit failures of that simpler
model." `crates/skyfix-core/tests/solver_coverage.rs` is that check. Every
number below is printed by

```console
cargo test -p skyfix-core --test solver_coverage -- --nocapture
```

run in this worktree. The scenario: four stars at azimuth/altitude (0°, 42°),
(70°, 28°), (140°, 55°) and (210°, 33°) — deliberately not a symmetric layout,
so that a shared bias cannot simply cancel out in the residuals and hide the
correlated-error failure — with a fixed initializer away from the truth and
multistart disabled, over 2000 seeded trials (`TRIALS = 2000`):

| trial | setup | result | assertion |
|---|---|---|---|
| independent noise | 1.0′ sigma, drawn fresh per trial | **1902/2000 inside the nominal 95 % ellipse = 0.9510** (binomial standard error 0.0049) | `0.93..=0.97` |
| shared bias estimated as a third unknown | 1.0′ sigma plus a bias of sigma 2.0′, `estimate_shared_bias = true` | **1910/2000 = 0.9550**; 2000/2000 bias estimates within 3 sigma | `0.93..=0.97` |
| shared bias, *not* estimated (the correlated-error failure) | six rounds of the same four stars (24 sights), one shared bias of sigma 2.0′ drawn per trial and left for the independent-noise model to misinterpret | **845/2000 = 0.4225** | must be `< 0.80` |

The first two rows confirm the nominal 95 % ellipse means what it says under
the model it assumes — both with and without a bias term explicitly estimated.
The third is deliberate: exactly as the shared-bias demo in `docs/DEMOS.md`
shows at the CLI level, an uncorrected shared error collapses the ellipse's
coverage to well under half, because repeating an observation under a shared
bias narrows the reported covariance without correcting the position. The
0.4225 measured here and the 42 % figure `docs/BACKLOG.md` quotes for the same
test are the same number, rounded.

## 4. Error budget

Every term below that this project models is either applied in the correction
chain or reported as an explicit uncertainty; every term it does not model is
listed here with its size, so it can be weighed against whichever of those two
categories a real error would have fallen into.

| term | size | modelled? | source |
|---|---|---|---|
| sextant sigma (realistic instrument, independent noise) | 1.0′ per sight (0.1′ is the tightest anywhere in this project's fixtures) | yes — the solver's whole uncertainty model is built on a declared per-sight sigma | this document, section 2, "Why 0.05′ for the ephemeris"; `docs/CONVENTIONS.md` section 10 example session |
| refraction model (Bennett 1982) | own residual against the standard atmosphere ≤ 0.07′ | yes, as the correction chain's step 3 | `docs/CONVENTIONS.md` section 5 |
| DUT1 (UT1 − UTC) assumed zero | up to 0.23′ of GHA for the everyday case (\|DUT1\| < 0.9 s); up to 0.88′ in Skyfield's extrapolated worst case at 2055 | no — DUT1 is assumed 0 everywhere unless a provider is given one | `docs/CONVENTIONS.md` section 6; this document, section 2, "ΔT and DUT1" |
| diurnal aberration | up to 0.32″ (0.0052′) for an equatorial observer, worst case measured; 0.21″ across the five `reference-philadelphia-5star` sights specifically | no — CONVENTIONS section 7 defines the frame as geocentric of date, with diurnal aberration explicitly excluded | this document, section 2, "Spherical model vs full topocentric computation", and section 3, "The session fixtures"; measured from `fixtures/reference/topocentric_altaz.json` |
| ephemeris (Sun and stars vs the independent Skyfield/JPL/USNO reference) | declared 0.01′ (Sun) / 0.02′ (stars); worst measured 0.0026′ (Sun GHA) / 0.0011′ (star separation) | yes, to the tolerance shown — this is what section 2 measures in full | `skyfix coverage` (command run in this worktree); this document, section 2 |
| sphere vs ellipsoid | Earth's flattening is about 0.3 %, "irrelevant at the tens-of-metres level" against this project's targets | no — the model is a sphere everywhere, no ellipsoid correction | `docs/CONVENTIONS.md` section 1 ("the model is a sphere; no ellipsoid correction is applied anywhere"); `docs/ARCHITECTURE.md`, "Why these choices" |

Two of these rows are worth reading together: DUT1 and diurnal aberration are
both frame choices this project states and then deliberately does not correct
for, and both are small enough to sit inside the 10 m regression target
(section 3) while still being far larger than the ephemeris error itself
(section 2). Neither is hidden; both are the reason the regression target is
stated as a target on *clean synthetic geometry*, not a field-accuracy number.

## 5. Known limitations and things deliberately not modelled

* **The Moon and planets are not covered.** Deferred by `docs/BRIEF.md`
  ("Defer Moon/planets unless independently validated") and by
  `docs/BACKLOG.md`. The offline ephemeris covers the Sun and the 57
  Nautical Almanac stars plus Polaris only. The USNO response used for the
  cross-check in section 2 also returned the Moon and Saturn; those values
  are stored but not differenced, so a future Moon or planet provider already
  has an independent check waiting.
* **The core solver assumes a stationary observer.** `skyfix-core::solver`
  has no motion model. `skyfix-motion::running_fix` (see `docs/MOTION.md`)
  handles a moving observer by advancing each sight's geographic position to
  a common reference instant and inflating its sigma, entirely outside the
  core; `docs/BACKLOG.md` lists a first-class moving-observer treatment
  *inside* the solver itself as unstarted, because that would require
  treating dead-reckoning error as correlated across sights rather than as
  independently inflated sigmas — the next limitation.
* **Correlated errors are not represented in the nominal ellipse, and this is
  measured, not assumed.** The solver's covariance model treats every sight's
  error as independent (`docs/CONVENTIONS.md` section 9). Three independent
  measurements say so at different points in the project:
  - the Monte Carlo test in section 3 above shows coverage collapsing from
    95.1 % to 42.25 % once a bias shared across repeated sights is left for
    the independent-noise model to misread;
  - `docs/MOTION.md` section 3 measures a running fix's own nominal 95 %
    ellipse covering the truth only **92.3 %** of the time over 300 seeded
    repetitions, because the dead-reckoning error behind every sight in one
    fix shares the same speed and course bias, and the solver is never told
    so;
  - `docs/CAMERA.md` section 7 combines a camera sight's independent
    centroid noise and its shared local-vertical error into one
    `sigma_arcmin`, which "gets the *size* of the uncertainty right and the
    *correlation* wrong, which makes the reported ellipse optimistic in the
    direction the vertical tilts" — by the module's own description.
* **Nothing here has touched real hardware.** Every number in this project —
  the CLI's worked examples, every packaged demo, the camera, polarization
  and motion modules — comes from a simulation, a synthetic session, or an
  independently generated reference fixture (`docs/DEMOS.md` states this for
  every demo). `docs/CAMERA.md` section 9: "Nothing in this crate has met a
  real lens, a real sensor or a real sky." `docs/POLARIZATION.md`: "Every
  photon in this module is synthetic." `docs/MOTION.md` section 8: its
  scenarios "build their own sky ... so no ephemeris is involved and the
  truth is exact by construction." `docs/BACKLOG.md` lists real sextant
  sights and camera work on real imagery as unstarted for the same reason.
* **Visibility is geometric only; there is no weather.** The observation
  planner (`docs/PLANNER.md`, `skyfix plan`) ranks bodies by measurement
  geometry alone and states in its own output notes that there is "no
  weather, no twilight model beyond the Sun-altitude flag." The polarization
  laboratory's sky has "no cloud, no haze and no aerosol" (`docs/POLARIZATION.md`
  section 8); its missing-sky mask and depolarization degradations are
  explicitly a stress model for "a hole in the data," never cloud physics.
* **Polar motion** is never applied, by Skyfield or by the project. It reaches
  0.3″ of station displacement, about 9 m — below the ephemeris tolerance but
  not below the 10 m regression target. It is not in any fixture.
* **Deflection of the vertical** (geoid minus ellipsoid) can reach tens of
  arcseconds in mountainous terrain and is not modelled anywhere. A real
  artificial horizon measures the *geoid* normal; every fixture assumes the
  WGS84 ellipsoid normal.
* **Refraction below Ha = 0** is rejected, and Bennett's own residual (≤ 0.07′)
  is inside the sigma floor and not modelled. Real anomalous refraction near
  the horizon is far larger than either and is not represented in any fixture.

## 6. How to reproduce every number here

- **Ephemeris vs Skyfield/USNO (section 2):** `make -C tools/reference`
  regenerates every file under `fixtures/reference/` and `fixtures/expected/`
  from Skyfield, JPL DE421/DE440s, Hipparcos and (network permitting) the
  USNO API; see `tools/reference/README.md`. `cargo test -p skyfix-ephemeris`
  compares the Rust providers against the regenerated fixtures.
- **Each provider's declared accuracy:** `skyfix coverage` (or
  `cargo run -p skyfix-cli --release -- coverage`).
- **Solver regression targets (section 3):** `cargo test -p skyfix-cli --test
  fixtures`, and the worked example in `docs/CLI.md` section "A four-star fix
  from supplied directions".
- **Monte Carlo coverage (section 3):** `cargo test -p skyfix-core --test
  solver_coverage -- --nocapture`.
- **The packaged-demo coverage numbers in `docs/DEMOS.md`:** `skyfix
  experiment --demo <name> --repetitions 50` for any of the ten scenario
  names `skyfix demos` lists.
- **Everything at once:** `cargo test --workspace`.
