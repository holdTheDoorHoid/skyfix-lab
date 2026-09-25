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

## At a glance

Every headline number below is a *numerical* result — Rust against an independent
reference (Skyfield, ERFA, USNO, NASA, Bowditch) or against a noise-free synthetic truth
— never a field measurement (section 1). Full figures, every case count and how to
reproduce each row are in the numbered section named.

| what | headline result | target | section |
|---|---|---|---|
| Sun (GHA/Dec vs Skyfield + JPL DE421/DE440s, 58 epochs) | worst GHA 0.0026′, Dec 0.0012′ | 0.05′ | 2 |
| Stars, 58 navigational (vs Skyfield, 3364 cases) | worst 0.0011′ separation | 0.05′ | 2 |
| Moon (geocentric, vs Skyfield + DE440s, 1757 instants) | worst GHA 0.0149′, Dec 0.0064′, HP 0.00009′ | 0.1′ GHA/Dec, 0.05′ HP | 7 |
| Planets, all seven (vs Skyfield + DE440s) | worst GHA 0.040′ (Neptune); the navigational four inside target by 15× or more | 0.1′ | 2, "Planets" |
| Topocentric altitude/azimuth (any body, WGS84 site) | stars worst 0.0052′; the Sun's larger figure is the parallax itself being restored, residual 0.0034′ | 0.1′ | 2, "Spherical model…" |
| Events: rise, set, twilight, transits (vs Skyfield, same threshold / vs USNO) | worst 0.420 s vs Skyfield; worst 29.4 s vs USNO's own 1-minute rounding | 10 s / 1 min | 9 |
| Star field, display only (9,095 stars, apparent places vs Skyfield) | worst 0.307″ = 0.0051′; separately, BSC5P vs Hipparcos catalogue positions can disagree by up to 8.6″ = 0.14′ (Rigil Kentaurus, proper motion, at the edges of 1990-2060) | 0.1′ (exceeded for this one star; display only, never reaches a sight) | 8 |
| Moon and planet sights (raw sextant readings vs Skyfield) | on the real (WGS84) Earth every reduced Ho within 0.0064′ of its model altitude, the Moon's with its Earth-shape term (0.22′ in this sample, median 0.09′; CONVENTIONS 15.4); WGS84 Moon sessions fix 2.6 m and 5.1 m from the truth; the Moon's parallax through the model within 0.0004′ of USNO's | matches ephemeris tolerance | 10 |
| Lunar distance (UTC recovered, vs Skyfield) | within 0.74 s (altitudes computed from the DR) / 0.63 s (observed) / 2.1 s (one observed, one computed) | 5 s | 10 |
| Almanac pages, tabulated values (vs Skyfield) | 99.2 % of printed values exact to the last digit; worst raw value 0.0197′ (a star's SHA) | 0.1′ angles/v/d/HP/SD, 1 min times | 11 |
| Eclipses (vs NASA's canon / vs USNO local circumstances) | greatest eclipse worst 1.4 s (solar) / 11.3 s (lunar) vs NASA; local contacts within 2.0 s vs USNO | 2 min / 1 min | 12 |
| Planet events: oppositions, conjunctions, greatest elongations, closest approaches (vs Skyfield + DE440s, all 2266 of 1990-2060; list vs NASA SKYCAL) | every event matched one for one; conjunctions and oppositions within 55 s (Neptune's slow motion), elongations and closest approaches within 68 s; the 12 transits are NASA's | 1 min / 10 min | 13 |
| Navigation methods: noon sight, Polaris, averaging, running fix (noise-free vs Skyfield truth; Bowditch's worked examples) | within 0.0001–0.0013′ of truth; running fix within 0.4–36 m; Bowditch reproduced to 0.02–0.19′ | — (numerical regression) | 3, "Navigation methods" |
| Navigation methods: seeded-coverage of the stated sigma | 93.8–96.0 % (Polaris very near the pole with a poor DR: 89.8 %, a documented limit, `polaris_near_pole`) | ≈95 % | 3, "Navigation methods" |
| Sun tools: equation of time, bearing crossings, galactic centre, analemma (vs Skyfield + DE440s; EoT vs Meeus 28.a) | EoT within 0.012 s (Meeus 0.18 s); bearing crossings 0.21″ on the sky; galactic centre 0.31″; golden/blue hour at their thresholds to 1e-6°; solar energy a labelled clear-sky estimate (model RMSE 6.6 %) | 1 s / 0.01° | 14 |
| Magnetic variation, WMM2025 (vs NOAA NCEI's 100 official test values, the technical report's Table 6 and numerical example) | declination and inclination within half their 0.01° printing (worst 0.005°); X, Y, Z within 0.0007 nT; the numerical example to 1e-6 nT | 0.01° | 15 |
| Magnetic variation, IGRF-14, 1900–2030 (vs IAGA's 12 test values; the BGS calculator at 25 points; NOAA's Geomag 7.0 sample) | IAGA within their 0.01 nT printing; BGS declination and inclination within 0.0005° (their printing), intensities 0.5 nT | 0.1° | 15 |
| Compass error by azimuth and amplitude (vs Bowditch ch. 15; vs the engine's own azimuth) | Bowditch's five examples within 0.013–0.066° (its tables print 0.1°); the azimuth equals `sky_state`'s to 0.00001° (Venus 0.006°: centre of light) | 0.1° / 0.01° | 15 |
| Sailings: great-circle, rhumb-line, mid-latitude, composite, plane, traverse and parallel sailing (Bowditch 2019 ch. 12, every worked example: 26 cases, 77 quantities) | all to the printed precision, or to the book's own four-decimal rounding carried through (worst such 0.62′ of longitude, §1213); two errata found and recorded | printed precision | 14 |
| Sailings: the sphere of 1′ = 1 NM against WGS84 (Vincenty geodesic, WGS84 loxodrome; 19 806 random pairs) | worst 0.502 % (great circle and rhumb line), 0.514 % on 10 NM legs | a stated bound | 14 |
| Dip short of the horizon (Bowditch 2019 vol. 2 Table 14, 28 entries, 5–100 ft, 0.2–10 NM) | worst 0.046′ (the table prints 0.1′) | 0.1′ | 14 |
| Star identification (each of the 58 stars from its own predicted Hs and Zn, 5 random places and times each; 400 sights with 1′, 1.5° and 10 NM of error) | 290/290 ranked first (worst separation < 0.00001°); with errors 400/400 within tolerance, 400/400 first | every star recovered | 14 |
| Star finder geometry (a set template against section 3, 20 000 random cases) | every star on its altitude and azimuth to 1e-9 of the disc's radius | exact | 14 |
| Moon in detail: libration, sub-solar point, axis (vs Skyfield + JPL's DE440 lunar orientation; Meeus 53.a) | 0.0052° / 0.0060° / 0.0061° over 1550–2650 (model), 0.0058° end to end for observers; Meeus 53.a to every printed digit | 0.05° | 14 |
| Moon in detail: perigee, apogee, supermoons (vs Skyfield + DE440s) | instants within 11.2 s, distances 0.22 km; every supermoon/micromoon flag agrees | 2 min, 10 km | 14 |
| Moon in detail: lunar occultations, mean limb (vs Skyfield's topocentric geometry; vs published predictions) | 48 contacts within 1.42 s, position angle 0.033°; BAA and IOTA city predictions within 5–48 s; a year at one place in 76 ms of CPU | 30 s; 200 ms | 14 |
| Tides, `tides-us` pack (vs NOAA's own predictions: 20 harmonic stations × 30 days, 6 subordinate, and a 3-day sweep of all 3 492 predictable stations) | high and low water within 1.10 min and 1.08 cm (20 stations, 2 087 extremes; Anchorage the 1.08 cm, the others ≤ 0.12 cm); curve within 1.38 cm (others ≤ 0.29 cm); sweep 39 120 extremes within 1.36 min and 0.99 cm | 2 min, 5 cm | 16 |
| Selected card: a bearing picked on the map (Vincenty on WGS84 vs Geoscience Australia's worked example); the card's own cost per time step | 54 972.271 m within 1 mm, azimuths within 0.5″ both ways; the card renders in 1.7 ms (median; 95 % within 2.6 ms) with the Moon and every drawer open | 1 mm, 1″; 5 ms | 18 |
| Lunar limb, `lunar-limb` pack: limb-corrected eclipse contacts (vs NASA SVS, 48 cities of 2024 and 2023 away from grazes; vs an independent Skyfield + NAIF + raw-LOLA implementation) | second contact within 1.2 s of SVS, third 1.4 s early on average (the same in the independent code: SVS's definition), both within 2 s at 45 of 48; scatter about SVS 0.3–0.6 s against the mean limb's 1.2–3.2 s; the profile within 0.027″ rms, the corrections within 0.34 s of the independent ones | 2 s; 1 s | 19 |

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

USNO also returned the Moon and Saturn. The Moon is now differenced in section 7
(in 2026 USNO's Moon runs 10.36 s late, worth 0.11′ of GHA; the lag varies with
the epoch, see the almanac section); the planets are differenced in their own section.

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

### Navigation methods: noon sight, Polaris, averaging, running fix

`docs/NAVIGATION_METHODS.md` section 6 holds these numbers in full. From raw sextant
readings of `fixtures/reference/nav_methods.json` (Skyfield truth, noise-free): noon
latitude and longitude within 0.0013′ and meridian passage within 0.001 s over five
runs (one near the zenith, one from a vessel making 15 knots); Polaris latitude within
0.0001′ at ten latitudes from 1° to 89.8° N; averaged altitudes within 0.0001′ of the
truth; a 36 NM running fix within 0.4 m (36 m on a true rhumb line, the great-circle-leg
model of `docs/MOTION.md`). Bowditch's worked examples reproduce to 0.07′ (Polaris,
§1912), 0.02′ (the Almanac's Polaris illustration) and 0.19′ (LAN, §1910, every tenth of
it accounted for). The stated sigmas cover 93.8-96.0 % in seeded Monte Carlo, except
Polaris within 1.5° of the pole with a DR good only to 30 NM (19° of longitude): 89.8 %,
documented as a limit and flagged by `polaris_near_pole`.

## 4. Error budget

Every term below that this project models is either applied in the correction
chain or reported as an explicit uncertainty; every term it does not model is
listed here with its size, so it can be weighed against whichever of those two
categories a real error would have fallen into.

| term | size | modelled? | source |
|---|---|---|---|
| sextant sigma (realistic instrument, independent noise) | 1.0′ per sight (0.1′ is the tightest anywhere in this project's fixtures) | yes — the solver's whole uncertainty model is built on a declared per-sight sigma | this document, section 2, "Why 0.05′ for the ephemeris"; `docs/CONVENTIONS.md` section 10 example session |
| refraction model (Bennett 1982) | own residual against the standard atmosphere ≤ 0.07′ | yes, as the correction chain's step 3 | `docs/CONVENTIONS.md` section 5 |
| DUT1 (UT1 − UTC) | up to 0.23′ of GHA (a quarter of a mile of longitude) when unknown, for the everyday case (\|DUT1\| < 0.9 s); up to 0.88′ in Skyfield's extrapolated worst case at 2055 | **an input** (expansion programme): the session's `clock.dut1_s`, the CLI's `--dut1`, the Navigate field "UT1 − UTC from the time signal"; each moves every GHA by 15.04″ per second, whatever the body (`crates/skyfix-cli/tests/dut1.rs`, `crates/skyfix-wasm/src/nav.rs` tests). Without one the engine uses 0 until the IERS history lands (timescales work), and the Navigate field says "Unknown: ±0.9 s, up to ±0.23′ of longitude" | `docs/CONVENTIONS.md` sections 6 and 15.2; this document, section 2, "ΔT and DUT1" |
| a sight time typed without seconds | a whole minute of time is 15′ of GHA; `HH:MM` means `:00` | guarded: the Navigate sight form says "Seconds omitted: :00 assumed; each second is 0.25′ of longitude" and takes the time (`web/src/next/navigate/parse.ts`) | `web/test/next/navigate-input.test.ts` |
| diurnal aberration | up to 0.32″ (0.0052′) for an equatorial observer, worst case measured; 0.21″ across the five `reference-philadelphia-5star` sights specifically | no — CONVENTIONS section 7 defines the frame as geocentric of date, with diurnal aberration explicitly excluded | this document, section 2, "Spherical model vs full topocentric computation", and section 3, "The session fixtures"; measured from `fixtures/reference/topocentric_altaz.json` |
| ephemeris (Sun and stars vs the independent Skyfield/JPL/USNO reference) | declared 0.01′ (Sun) / 0.02′ (stars); worst measured 0.0026′ (Sun GHA) / 0.0011′ (star separation) | yes, to the tolerance shown — this is what section 2 measures in full | `skyfix coverage` (command run in this worktree); this document, section 2 |
| sphere vs ellipsoid | Earth's flattening is about 0.3 %, "irrelevant at the tens-of-metres level" against this project's targets | no — the model is a sphere (1′ = 1 NM, geodetic coordinates), with the three exceptions of CONVENTIONS section 1: the display's topocentric values, the lunar-distance clearing and the Moon's model altitude (next row) | `docs/CONVENTIONS.md` section 1; `docs/ARCHITECTURE.md`, "Why these choices" |
| the Earth's shape in the Moon's parallax | up to 0.24′ (median 0.09′ over 104 Skyfield sights, 0.05′ over random observable sights); at most 0.0021′ for a planet (Venus at inferior conjunction), 0.0006′ for the Sun | **yes** for the Moon (expansion programme): in its model altitude wherever one is evaluated (CONVENTIONS 15.4), leaving a perfect WGS84 Moon sight within 0.0064′ of it; and in the lunar-distance clearing. Not applied to the planets or the Sun | section 10; `crates/skyfix-core/tests/moon_earth_shape.rs`; `docs/CONVENTIONS.md` section 15.4 |
| dip anomaly (the air–sea temperature difference bending the line to the horizon) | 1–2′ is common, more in extremes (looming, a mirage at the horizon) | no — physical, and no model of the air over the sea is worth having. The remedy is the shared-bias estimate: `SolveOptions.estimate_shared_bias` (CLI `solve --bias`) solves a common altitude error as a third unknown, which a dip error is, given three or more sights spread round the horizon (the sight planner picks them that way). Section 3 measures it: coverage stays 95.5 % with a shared 2′ bias estimated, and falls to 42 % when it is not | `docs/CONVENTIONS.md` sections 5 step 2 and 8; section 3, "The Monte Carlo coverage results" |
| anomalous refraction near the horizon | several ′ below 5° of altitude, about 0.1–0.2′ at 10° | flagged below 10°, 1′ added to the sigma below 5°, refused below 0° (CONVENTIONS section 5 step 3); the anomaly itself is physical and not modelled. Its common part is absorbed by the shared-bias estimate as above; the rest is avoided by sights above 10–15° (the planner's floor is 15°) | `docs/CONVENTIONS.md` section 5 step 3; `docs/PLANNER.md` |
| Venus's centre of light | up to 0.41′ between the disc's centre and its light; the model agrees with USNO to 0.003′ | yes — Venus's sight direction is its centre of light, as in the Nautical Almanac | section 10; `docs/CONVENTIONS.md` section 7 |

Two of these rows are worth reading together: DUT1 and diurnal aberration are
both frame choices this project states and then deliberately does not correct
for, and both are small enough to sit inside the 10 m regression target
(section 3) while still being far larger than the ephemeris error itself
(section 2). Neither is hidden; both are the reason the regression target is
stated as a target on *clean synthetic geometry*, not a field-accuracy number.

## 5. Known limitations and things deliberately not modelled

* **Moon and planet sights reduce on the spherical Earth, the Moon's model altitude
  on the real one.** The Moon, Venus, Mars, Jupiter and Saturn are offered for sights
  (section 10, `docs/NAVIGATION_SKY.md`): the Moon's augmented semidiameter and rigorous
  parallax, the planets' parallax, Venus at its centre of light, and each body's own GHA
  rate for the clock term. The Earth's shape in the Moon's parallax (up to 0.24′) is in
  its model altitude (CONVENTIONS 15.4). Left out: the observer's height in that term
  (30 m is 0.0003′) and the planets' term (at most 0.0021′). Mercury, Uranus and Neptune
  are shown but never offered for sights.
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
  the horizon is far larger than either and is not represented in any fixture;
  section 4 gives its size, and the dip anomaly's, with the shared-bias estimate as
  the remedy for the part the sights share.

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
- **Navigation methods (section 3):** `cargo test -p skyfix-core --test
  nav_methods_reference --test nav_methods_worked_examples --test
  nav_methods_coverage -- --nocapture`, and `cargo test -p skyfix-wasm nav --
  --nocapture` for the running fix; `tools/reference/.venv/bin/python -m
  tools.reference.gen_nav_methods` regenerates their fixture.
- **Everything at once:** `cargo test --workspace`.

## 7. Moon

Owner: Moon agent. The provider is `skyfix_ephemeris::moon::MoonProvider`: ELP 2000-82B
(CDS VI/79, 2023 of 37 872 terms) through the project's IAU 2006/2000B frame chain; see
the module documentation for the model and `docs/THIRD_PARTY.md`, "Moon model", for the
data. It declares **`accuracy_arcmin` = 0.02′**, excluding (like the Sun and the stars)
the DUT1 of CONVENTIONS section 6 (0 unless the session or the caller gives it), which
is worth up to 0.23′ of GHA when unknown.

### Geocentric, against Skyfield + JPL DE440s

`fixtures/reference/moon_geocentric.json`: 1757 instants over 1990-2060 — 1200 random,
100 perigees, 100 apogees, 353 declination extremes (every northern and southern extreme
beyond 28.3°, i.e. the major standstills around 2006, 2024-25 and 2043, plus 100 of
each spread over the window) and 4 fixed instants. DE421 and DE440s agree on the Moon to 0.0061″ in
direction and 0.9 m in distance over the 1515 instants both cover, so the reference is
not a limiting factor. GHA is compared with the DUT1 = 0 column.

| quantity | worst | target (CONVENTIONS 13.7) | where |
|---|---|---|---|
| GHA (DUT1 = 0) | **0.0149′** (0.89″) | 0.1′ | 2060-12-08, northern declination extreme |
| GHA × cos Dec (on the sky) | 0.0131′ (0.79″) | | same |
| Dec | **0.0064′** (0.38″) | 0.1′ | 2060-12-31 |
| RA of date | 0.0149′ | | 2060-12-08 |
| apparent ecliptic longitude / latitude of date | 0.0133′ / 0.0026′ | | 2060 |
| horizontal parallax | **0.00009′** (0.005″) | 0.05′ | a perigee, 2039 |
| semidiameter | 0.00006′ | | |
| geocentric distance | 0.31 km | | |
| illuminated fraction | **0.00007** | 0.001 | |
| elongation | 0.00018° (0.63″) | | |
| bright-limb position angle (elongation 5°-175°) | 0.0013° (4.6″) | | |
| phase angle | 0.0115° (41.5″) | | definition, see below |
| GHA with each instant's own DUT1 (176 instants) | 0.0149′ | | |

Worst on-sky error by instant set: random 0.76″, perigees 0.80″, apogees 0.57″,
northern extremes 0.79″, southern extremes 0.77″. Every worst case falls in 2060. To
check that the samples do not miss a larger error between them, a dense development-time
scan of the last 121 days of 2060 at 3-hour steps (968 instants against Skyfield +
DE440s, not committed) found worst GHA 0.90″ and worst Dec 0.42″: the declared 0.02′
(1.2″) holds with a quarter of it to spare.

**Where the error comes from**, largest first:

| source | size |
|---|---|
| ELP 2000-82B itself: its mean longitude was fitted to DE200 in the 1980s and drifts from DE440 by about `+0.02″ + 0.37″ t + 0.99″ t²` (t in centuries from J2000; measured with the complete theory, geometric, 4000 epochs) | 0.72″ by 2061, 0.1″ in the 2020s |
| truncation to 2023 terms (measured over 20 000 epochs) | 0.13″ |
| frame tie of the theory's J2000 ecliptic to the GCRS | ~0.02″ |
| IAU 2000B instead of 2000A nutation; TT used for TDB | ~0.001″ each |
| light-time applied as `p − τ ṗ` | < 0.0001″ |

The pitfall this avoids: applying the stars' 20.5″ annual aberration to the Moon. For a
geocentric body Skyfield's barycentric light-time (−v⊕τ) and its aberration (+v⊕τ)
cancel to about 1 mas, leaving only the Moon's own motion over `τ = r/c ≈ 1.28 s`
(about 0.7″). Adding the aberration would have cost up to 20″, a third of the budget.

**The phase angle** is computed from the apparent directions of the Moon and the Sun
(Meeus 48.3). Skyfield builds it from astrometric directions, which differ from the
apparent ones by the aberration; the two definitions can differ by up to twice the
constant of aberration (41″), which is what the table shows. It moves the illuminated
fraction by at most 1e-4.

**The magnitude** is an approximate phase law (Krisciunas & Schaefer 1991) with no
opposition surge and no eclipse model; it has no reference and is not validated.

### Topocentric altitude and azimuth

`fixtures/reference/moon_topocentric.json`: 600 Moon cases at 12 sites (equator,
tropics, 2000 m, 60°+ north and south, both hemispheres, the antimeridian), plus 307 Sun
and 1322 star cases at the same instants, all built with UT1 = UTC so the comparison
carries no DUT1 term. `topocentric::horizontal` (WGS84 site, geometric altitude, no
refraction) against Skyfield's `altaz()` without refraction:

| body | cases | worst altitude | worst azimuth × cos(alt) | worst raw azimuth below 70° |
|---|---|---|---|---|
| Moon | 600 | 0.0105′ (0.63″) | 0.0117′ (0.70″) | 0.0142′ (0.85″) |
| Sun | 307 | 0.0050′ (0.30″) | 0.0060′ (0.36″) | 0.0147′ (0.88″) |
| stars | 1322 | 0.0040′ (0.24″) | 0.0055′ (0.33″) | 0.0121′ (0.73″) |

Target: 0.1′. The Sun and star residuals are diurnal aberration (0.32″ at most), which
Skyfield applies and the display model does not; the Moon's add its geocentric error.
`topocentric.rs` needed no change.

### USNO: an independent check, and a finding about it

The USNO Celestial Navigation Data response stored for 2026-10-01T01:30Z also carries
the Moon. Against it this provider is **+0.108′ in GHA and −0.017′ in Dec** off, and
Skyfield + DE440s is +0.112′ and −0.018′ off: USNO disagrees with both by the same
amount. The whole difference is the Moon's own motion over **10.36 s**: Skyfield's
apparent Moon with its time argument 10.36 s later (sidereal time unchanged) reproduces
USNO's GHA and Dec to **0.003″**. USNO's API therefore evaluates the lunar ephemeris
about 10 s late; the stars and GHA Aries, which agree with USNO to 0.006″, cannot show
it because 10 s moves them by microarcseconds. Allowing for it, this provider and USNO
agree to −0.004′ in GHA and +0.001′ in Dec (`tests/moon_reference.rs` pins both
numbers). Only one instant is available, so whether the offset is constant is unknown;
**anyone validating a Moon against USNO's API should allow for about 0.1′ of GHA.**

### Speed

Release build, x86-64, measured on a shared 8-core machine under load
(`cargo test --release -p skyfix-ephemeris --test moon_reference -- --ignored --nocapture`):
**43 µs per `MoonProvider::position`**, 74 µs per `apparent_state` (which adds the Sun
for the illumination quantities), plus about 2 ms once per process to parse the
embedded series. The main problem's arguments are built from tabulated multiples of the
four Delaunay angles, so only the 1237 perturbation terms cost a sine each. The embedded
data is 125 kB of the release WASM module's 1.55 MB.

### Reproduce

- `tools/reference/.venv/bin/python -m tools.reference.gen_moon` (about a minute)
  regenerates both fixtures; `tools/reference/.venv/bin/python -m
  tools.reference.build_moon_series --fetch` rebuilds the embedded series from the CDS.
- `cargo test -p skyfix-ephemeris --test moon_reference --test topocentric_reference
  -- --nocapture` prints every number above.

## 8. Star field (display only)

Owner: star-field agent (`crates/skyfix-starfield/`). Everything here describes what the
explorer's Sky view draws. The star field is display-only (CONVENTIONS 13.6): none of
these numbers is an accuracy claim for a sight, and no navigation crate can reach the
data. Measured by `crates/skyfix-starfield/tests/` against the fixtures that
`tools/starfield/gen_fixtures.py` generates with Skyfield; provenance and licences are
in `docs/THIRD_PARTY.md`, "Star field and constellations".

### Apparent places versus Skyfield

| check | cases | result | target |
|---|---|---|---|
| `apparent_radec_all` vs Skyfield 1.55 + DE440s, 1990–2060 (`starfield_apparent.json`) | 420 stars × 9 epochs = 3 780 | worst **0.307″ (0.0051′)**, RMS 0.016″ | 0.1′ (CONVENTIONS 13.7) |
| same chain as `skyfix_ephemeris::frames::apparent_radec_of_date` (what `sky_state` uses) | 9 095 stars × 5 dates, 1800–2200 | worst 1.6 × 10⁻⁹″ | floating point |
| the reference itself: DE421 against DE440s | the epochs DE421 covers | 0.004″ | — |

The 420 stars are the 58 navigational stars, the 25 largest proper motions, the 12
nearest each pole, 10 straddling 0h, the 3 nearest the Sun (at least 1° away) at each
epoch, and a seeded random sample. The worst case per epoch is at most 0.04″ from 1990
to 2026 and grows to 0.31″ at the end of 2060, and that growth is one term: Skyfield is
given each star's catalogued
radial velocity, and the Rust chain, like `skyfix-ephemeris`, has no radial-velocity
(perspective acceleration) term. The worst star is 61 Cygni B (HR 8086). The regression
guard in the test is 0.5″, far inside the 6″ target, so a broken deflection or parallax
step would fail it.

What this comparison does not measure is the catalogue. Both sides start from the same
Bright Star Catalogue values: FK5 J2000 positions to 0.1 s of RA and 1″ of Dec (so up
to about 1″ from modern positions at J2000), proper motions printed to 1 mas/yr but, for
some stars, tens of mas/yr from Hipparcos's. Against the Hipparcos places
`skyfix-ephemeris` uses, the 58 navigational stars agree to 0.9″ or better at J2000,
except Rigil Kentaurus (6.4″ at J2000, 3.6″ in 2026: the catalogues place α Cen A
differently along its 80-year orbit about B). Away from J2000 the proper motions tell
(the verifier's check, apparent places of both at 1990.0, J2000, 2026.0 and the end of
2060): Rigil Kentaurus reaches **8.6″ (0.14′) at the end of 2060** and 8.3″ in 1990,
beyond the 0.1′ that CONVENTIONS 13.7 sets for star-field places; Ankaa 3.8″ and Dubhe
2.9″ in 2060 (their catalogue proper motions are 52 and 36 mas/yr from Hipparcos's);
every other navigational star stays under 1.5″. At display scale none of this is
visible, and none of it reaches a sight (CONVENTIONS 13.6).

### Navigational stars

All 58 are found by position (within 1′) and V magnitude (within 1.0), never by name:
largest separation 6.40″ (Rigil Kentaurus; the next is 0.90″), largest magnitude
difference 0.56 (Acrux, where Hipparcos gives the combined light of α¹ and α² Crucis and
the catalogue lists α¹ alone). The name list's 58 Almanac names land on the same
entries.

### Constellation lookup

| check | result |
|---|---|
| our B1875 polygons against Skyfield's map (Roman 1987), the centre of every cell of its grid | **47 200 of 47 200 agree**; the two use the identical set of boundary RA and Dec values |
| `constellation_at` vs Skyfield, 25 000 pseudo-random apparent-of-date directions at pseudo-random instants 1990–2060 | **25 000 of 25 000 agree** |
| the same 25 000 against `load_constellation_map()` exactly as shipped | 25 000 of 25 000 agree |
| every combination of a boundary RA and a boundary Dec (46 964 points, all on boundary lines) | each in exactly one constellation |
| a half-degree grid over the whole sky (259 200 points) | each in exactly one constellation |

Two frame details, both measured rather than assumed. Skyfield's shipped
`load_constellation_map()` rotates into the *true* equinox of B1875 (its `Time.M`
includes the 1875 nutation, 10.1″), while the IAU boundaries are defined in the *mean*
equinox, which is what `constellation_at` uses; the two can disagree only within about
10″ of a boundary, and none of the 25 000 samples fell there. And `constellation_at` is a
rotation: annual aberration (up to 20.5″) is not removed, so a body within 20″ of a
boundary may be named after its neighbour.

### Speed and size

| | native, release | WebAssembly (Node 24, V8) | budget |
|---|---|---|---|
| apparent places of all 9 095 stars | 1.2–1.5 ms (fastest of 100 calls; a heavily loaded machine) | 1.0–1.1 ms fastest, 1.1–1.2 ms median | 5 ms (EXPLORER_PLAN §3.7) |
| `constellation_at`, same instant as the previous call | 1.4 µs | 1.3 µs | — |
| `constellation_at`, new instant (the nutation series runs once) | 9 µs | 5 µs | — |
| `starfield_catalog()`, once per session | — | 8 ms | — |

The embedded data is 259 KB (stars 227 KB, boundaries 18 KB, figures 10 KB, names
4 KB). The star field adds 305 KB to the release WebAssembly module (1 129 446 bytes
against 824 836 for the commit before it, both built with `wasm-pack --release`), which
stays under the 2 MB budget.

### Known limitations

- **No radial velocity**, as above: at most 0.31″ by 2060 among the stars checked.
- **Catalogue precision and age**: positions to about 1″, magnitudes from one epoch.
  Variable stars are drawn at the catalogue's magnitude (Betelgeuse 0.50, Mira 3.04);
  η Carinae appears at the catalogue's V 6.21 although it has since brightened to
  about fourth magnitude.
- **Close doubles are separate entries** where the catalogue lists components
  separately (α¹ and α² Centauri, α¹ and α² Crucis, Castor A and B, and others), so the
  dome draws two stars a few arcseconds apart.
- **310 stars have no B−V** (NaN on the wire); the Sky view must choose a neutral colour.
- **Completeness**: the catalogue reaches about V 6.5, with some fainter entries.
- **Range**: the functions answer for 1800–2200 and are validated for 1990–2060. Outside
  the validated window the models (IAU 2006 precession, IAU 2000B nutation, linear proper
  motion) are still good to about an arcsecond for most stars.
- **Label positions** are a heuristic (the figure's centre, moved at least 1.5° inside
  the boundary where the centre is outside or too close, as for Eridanus and Serpens).

### Reproducing these numbers

```
python3 -m tools.starfield.fetch                                  # network: raw inputs
tools/reference/.venv/bin/python -m tools.starfield.build         # embedded data and its checks
tools/reference/.venv/bin/python -m tools.starfield.gen_fixtures  # Skyfield fixtures
cargo test -p skyfix-starfield -- --nocapture
cargo test --release -p skyfix-starfield --test timing -- --nocapture
```

## 9. Events: rise, set, twilight, transits, seasons and Moon phases

Owner: events agent (`crates/skyfix-almanac/src/{events,sky}.rs`). Definitions are
CONVENTIONS 13.3 to 13.5; the targets are CONVENTIONS 13.7. Every number below is printed
by the tests named with it (run them with `-- --nocapture`), against real providers for
the Sun, Moon, planets and stars.

### How events are found

A body's apparent geocentric state is evaluated exactly at nodes 3 h apart (the Moon),
4 h (planets) or 8 h (the Sun and stars) and interpolated between them with a 4-point
Lagrange cubic; the topocentric step (Earth rotation, WGS84 parallax, refraction) is
exact at every evaluation. The altitude is bracketed on a 10-minute grid, every
altitude extremum is located and added to the brackets (so a body grazing its
threshold for a minute is caught on both sides), and each crossing is refined with
Brent's method to 1 ms.

| check (test) | measured |
|---|---|
| interpolation vs exact, real Moon / Mercury / other planets / Sun and stars (`track_interpolation`) | 0.0054″ / 0.0011″ / ≤ 0.0007″ / < 0.00001″ |
| event instants vs a dense (20 s) exact scan with linear interpolation, Sun / synthetic Moon (`events_logic`) | 0.021 s / 0.001 s |
| event `alt_deg`/`az_deg` vs an exact `sky_state` at the same instant (`events_logic`) | 0.0012″ |
| Sun grazing its rise/set altitude by 0.0003° (below it for 2.4 minutes) | both crossings found, within 0.01 s of a 1-s exact scan |

### Against Skyfield + JPL DE440s, the same `h0` (target 10 s)

`fixtures/reference/events_*.json`, from `tools/reference/gen_events.py`: Skyfield's
topocentric unrefracted altitude of the body's centre, UT1 = UTC, `find_discrete` on a
one-minute grid (IAU 2000B nutation for the searches; against 2000A it moves no event by
more than 0.0023 s). Test: `events_reference`.

| bodies | windows | events | worst | where |
|---|---|---|---|---|
| Sun: rise, set, transit, lower transit, civil/nautical/astronomical dawn and dusk; 34 sites × 21 dates, 1990–2060, 14 sites at 60–70° N and S | 714 | 6242 | **0.215 s** | set at Kiruna (67.9° N), 2017-01-01, a Sun that barely rises |
| 10 stars × 12 sites × 6 dates | 720 | 2174 | **0.108 s** | Polaris setting at Quito, where it skims the horizon |
| Moon, 20 sites × 21 dates | 420 | 1548 | **0.420 s** | set at Rothera (67.6° S) |
| Mercury to Neptune, 10 sites × 6 dates | 420 | 1679 | **0.256 s** | Neptune rising at Casey (66.3° S) |

In every window the sky-phase sequence, the day length (within 20 s), and the
`always_above`/`always_below` classification (midnight sun, polar night, circumpolar
stars) agree with the reference; no grazing pair was missing on either side. Transits
agree to 0.011 s (Sun), 0.043 s (Moon) and 0.15 s (planets): each provider's GHA error
divided by the hour-angle rate. Rise and set errors are those GHA and declination
errors, plus Skyfield's diurnal aberration (≤ 0.32″, which CONVENTIONS 13.2 leaves out),
divided by the altitude rate, which is small where the path meets the horizon at a
shallow angle — hence the high-latitude worst cases.

### Against USNO (target 1 min, USNO rounds to the minute)

`fixtures/reference/events_usno.json` (`rstt/oneday`, UTC days, 14 site-days including
polar night and midnight sun). Test: `usno_reference`.

| quantity | events | worst |
|---|---|---|
| Sun: civil dawn, rise, upper transit, set, civil dusk | 59 | 29.4 s |
| Moon: rise, upper transit, set | 38 | 29.1 s |

Both are inside the ±30 s of USNO's own rounding. USNO lists an upper transit only while
the body is up; ours below the horizon (polar night) are left out of the comparison.

### Equinoxes, solstices and Moon phases (target 1 min)

Apparent geocentric ecliptic longitudes of date, from the providers' RA/Dec and the true
obliquity. Tests: `seasons_moon_phases`, `usno_reference`.

| quantity | events | vs Skyfield/DE440s | vs USNO |
|---|---|---|---|
| equinoxes and solstices 1990–2060 | 284 | **4.0 s** | ≤ 29.4 s for 1990, 2000, 2026 (12 events) |
| Moon phases 1990–2060 | 3513 | **1.1 s** | ≤ 41 s for 1990, 2000, 2026 (149 events) |

DE421 and DE440s agree on these instants to 0.003 s and 0.012 s. **A finding about
USNO:** for future years its seasons and phases drift from ours by a growing offset —
the band centre is about +20 s in 2045 and +30 s in 2060, with the individual
differences spread over one minute around it, as rounding predicts. USNO states future
instants in predicted UT (TT minus a predicted ΔT), while this project counts UTC with no
leap seconds after 2017 (TT − UTC = 69.184 s, CONVENTIONS 6); the instant is fixed in TT,
so the two clocks disagree by the difference of the ΔT assumptions. Skyfield with the
project's convention agrees with us to seconds, and rise and set (fixed by the Earth's
rotation) show no such drift. The test asserts the 1-minute bound through 2026 and, for
later years, that the differences sit in a one-minute band around a constant offset,
which it prints.

### What these numbers are not

They compare definitions and arithmetic. Real rise and set times depend on refraction at
the horizon, which varies by several arcminutes with the weather (a minute or more of
time), on the height of the observer and the terrain, and on DUT1 (up to 0.9 s of Earth
rotation, which moves every event by up to about 0.9 s). The 34′ standard refraction is a
convention, not a prediction.

### Speed (EXPLORER_PLAN 3.7)

Native release (`cargo test --release -p skyfix-almanac --test perf -- --ignored
--nocapture`) and WASM under Node 24 (`wasm-pack --release`, real providers):

| call | native | WASM |
|---|---|---|
| `sky_state`, all 67 bodies (WASM: with constellations) | 0.52 ms | 1.03 ms (budget 2 ms) |
| `day_events_batch`, Sun, 365 days | 74 ms | 94 ms |
| `day_events`, one day, all 67 bodies | 7.2 ms | 9.2 ms |
| `sample_bodies`, 64 navigational bodies, one day at 5 min | 8.2 ms | 12.2 ms |
| `seasons`, one year | 3.8 ms | 4.5 ms |
| `sidereal` | — | 0.004 ms |

The star provider builds its precession-nutation matrix and Earth state once per instant
(`StarFrame`, bit-for-bit identical to the unbatched chain), which is what keeps 58 stars
at about 0.18 ms.

## 10. Moon and planet sights

Owner: navigation-Moon agent. Methods, decisions and the full tables are in
`docs/NAVIGATION_SKY.md`; the rules in `docs/CONVENTIONS.md` sections 1, 5, 7 and 13.1.

**Sights against Skyfield** (`fixtures/reference/moon_planet_sights.json`, 178 raw
sextant readings on each of two Earths, built from Skyfield + DE440s topocentric
positions with the CONVENTIONS refraction, dip and index error;
`crates/skyfix-ephemeris/tests/moon_planet_sights.rs`):

| check | Moon | planets | stars | Sun |
|---|---|---|---|---|
| Rust chain vs the chain transcribed in Python from the text | 1.1e-10′ (all bodies) | | | |
| sphere Earth, supplied DE440s directions | 0.0059′ | 0.0048′ | 0.0038′ | 0.0039′ |
| sphere Earth, the providers' own directions | 0.0063′ | 0.0053′ | 0.0041′ | 0.0035′ |
| WGS84 Earth, Ho against the sphere's geocentric altitude | 0.2202′ (median 0.088′) | 0.0048′ | 0.0023′ | 0.0045′ |
| **WGS84 Earth, Ho against the model altitude** (CONVENTIONS 15.4) | **0.0064′** | 0.0048′ | 0.0023′ | 0.0045′ |

The sphere residuals are the diurnal aberration Skyfield includes; the WGS84 Moon
residual against the sphere is the Earth's shape, which the Moon's model altitude now
carries (the expansion programme's Earth-shape term: its size over these 104 Moon sights,
median 0.088′, worst 0.222′).

**End to end** (`fixtures/sessions/reference-moon-*.json`, ephemeris `auto`, raw sextant
readings): the WGS84 sessions fix **2.6 m** and **5.1 m** from the truth (17.9 m and 34.9 m
on the sphere alone; the test bound, 60 m and 80 m before, is now 15 m). The `*-sphere`
sessions, built on a sphere of radius 6378.14 km, recover their truth to 2.7 m and 5.2 m
solved with the term switched off, the model they were built for, and miss by 22.7 m and
30.4 m with it on.

**The term itself** (`crates/skyfix-core/src/sights/wgs84.rs` and
`tests/moon_earth_shape.rs`): the component form the solver uses equals the explicit
vector form to 1.5e-12′ and an independent Python computation to 1e-11′; the first-order
formula `HP f (sin²φ cos h − sin 2φ sin h cos Z)` with the observed altitude matches it to
0.00018′ below 84°; worst case 0.2382′ (φ 54.9°, the Moon toward the equator at 55°,
HP 61.5′). A Moon and three stars on the real Earth fix to 0.00 m (137 m on the sphere
alone); a Moon noon latitude (term +0.22′ there) to 1e-6′, single maximum 0.001′,
ex-meridian 4e-6′; a running fix with a Moon sight to 0.03 m (266 m without the term).
The solver keeps the sphere's Jacobian row: measured, the term's own slope is 0.9e-4 of
the main term's below 45°, 1.8e-4 below 70° and 7e-4 at 85°.

**Against USNO** (`fixtures/reference/usno_celnav_venus_phase.json`,
`tests/usno_venus_phase.rs`, USNO's 10.36 s lag allowed for): Venus's centre of light
within 0.0031′ at twelve phase angles from 15° to 157° (the geometric centre misses by up
to 0.41′; fitted coefficient 0.4403 against the 0.44 used); Mars within 0.0007′ (no phase
correction, as in USNO); the Moon's parallax implied by the sight model (the sphere's
less the Earth-shape term) within **0.0004′** of USNO's at eight positions, the WGS84
display within 0.004′, and the sphere's alone up to 0.22′ from it; the Moon's
semidiameter 0.006′ larger than USNO's (k).

**Lunar distances** (`fixtures/reference/lunar_distances.json`, 22 cases to the Sun, ten
stars and four planets, measured between refracted limbs found numerically on the WGS84
Earth; `tests/lunar_distance_reference.rs`): from exact inputs the UTC comes back within
**0.74 s** with altitudes computed from the DR, **0.63 s** with altitudes observed and
**2.1 s** with one observed and the other computed
(target 5 s); the cleared distance within 0.007′. With altitudes computed from a DR 30 NM
in error the time moves 5 s to 2 minutes, as the reported sensitivity predicts.

**Twilight** for the sight planner (`fixtures/reference/nautical_twilight.json`,
`tests/sight_plan.rs`): within 0.15 s of Skyfield at eight sites.

**Reproduce:** `tools/reference/.venv/bin/python -m tools.reference.gen_moon_sights`
(about 30 s) and `-m tools.reference.gen_usno_sights` (needs network), then
`cargo test -p skyfix-ephemeris --test moon_planet_sights --test usno_venus_phase
--test lunar_distance_reference --test sight_plan -- --nocapture`.

## 11. Almanac pages

Owner: almanac agent (`crates/skyfix-almanac/src/pages.rs`, definitions CONVENTIONS 13.9).
A daily page is built from the providers and the event finder already measured above
(sections 2, 7, 9 and "Planets"), so these checks are about the page itself: that every
tabulated quantity, computed and rounded the way the page does, is within the page's own
precision of an independent computation. Target (EXPLORER_PLAN work package J): 0.1′ for
every angle, v, d, HP and SD; 0.1 for magnitudes; 1 minute for every time (0.1 minute
for Aries' meridian passage); 1 s for the equation of time.

### Against Skyfield + JPL DE440s

`fixtures/reference/almanac_days.json` (`tools/reference/gen_almanac.py`): 17 dates from
1990-03-15 to 2060-12-28 — both solstices (midnight sun, polar night, twilight all
night), an equinox, a leap day, the 2016-12-31 leap second, new- and full-moon eclipse
days, Venus at superior conjunction (negative v) — with UT1 = UTC and every definition of
CONVENTIONS 13.9 coded again in Python from its text; the rise/set cells come from
Skyfield's own searches (`gen_events.py`) and the same cell rules. Test:
`crates/skyfix-almanac/tests/almanac_reference.rs`.

| quantity | values | worst |
|---|---|---|
| GHA Aries | 408 | 0.0000′ |
| Sun GHA / Dec | 408 | 0.0029′ / 0.0015′ |
| Moon GHA / Dec / HP | 408 | 0.0092′ / 0.0057′ / 0.0056′ |
| Moon v / d | 408 | 0.0001′ / 0.0001′ |
| Venus, Mars, Jupiter, Saturn GHA / Dec | 1621 | 0.0056′ / 0.0022′ |
| Venus behind the Sun (2016-06-06), against the undeflected place | 11 | 0.031′ / 0.026′ |
| planets v / d / SHA / magnitude | 68 | 0.0045′ / 0.0001′ / 0.0056′ / 0.0001 |
| Sun SD / d; Moon SD | 17 | 0.0000′ / 0.0001′; 0.0015′ |
| stars SHA / Dec (Polaris the worst SHA) | 986 | 0.0197′ / 0.0009′ |
| equation of time, 00h and 12h | 34 | 0.012 s |
| meridian passages: Aries, Sun, Moon upper and lower, planets | 136 | 0.0004 s, 0.011 s, 0.037 s, 0.022 s |
| twilight, sunrise, sunset (31 latitudes) | 2957 | 0.16 s |
| moonrise, moonset (31 latitudes, two dates) | 2050 | 1.8 s (N 68, 2038-01-19) |
| Moon's age; principal phase instants; illuminated | 17; 6; 17 | 1.0 s; 0.55 s; 0.006 % |

Every cell has the same kind on both sides — 5007 times, 102 `□`, 52 `■`, 107 `////`,
2 `--` — with no grazing case to excuse. Printed angles: each is checked to be its raw
value correctly rounded, and 7283 of 7344 (99.2 %) are character for character the
reference's rounded value; the rest differ by one unit in the last digit where a rounding
boundary falls between two raw values a few thousandths of an arcminute apart.

Two things the fixture had to get right, recorded here because they are easy to get
wrong. Skyfield's `ts.utc(2016, 12, 31, 24)` lands inside that day's leap second, while
the project's `jd_utc` (86 400 s per UTC calendar day) puts 24h at 2017-01-01 00:00:00;
the first fixture differed from the page by 0.12′ in the Moon's v at 23h for exactly that
reason, and the generator now builds the 25th hour as the next date's 00h. And Venus
behind the Sun: Skyfield applies the light-deflection formula without bound there (0.48′
on 2016-06-06), the provider caps it at the solar limb (section 2, "Planets hidden behind
the Sun"), so those hours are judged against the undeflected place, within the cap.

### Against USNO

`fixtures/reference/almanac_usno.json` (`gen_almanac.py --usno-only`, network): the
Celestial Navigation Data API at four whole hours of pages (2000-02-29 06h, 2016-12-31
18h, 2026-09-24 00h and 12h), each queried at the ground point of the Sun, the Moon and
the four planets so that every one is above the horizon; and one-day rise, set, transit
and civil twilight at the Greenwich meridian for six latitude-dates. Test:
`crates/skyfix-almanac/tests/almanac_usno.rs`.

| quantity | values | worst |
|---|---|---|
| twilight, sunrise, sunset, moonrise, moonset, meridian passages | 48 | 0.47 min (USNO rounds to the minute) |
| GHA Aries | 24 | 0.0000′ |
| Sun GHA / Dec | 20 | 0.006′ / 0.002′ |
| Mars, Jupiter, Saturn GHA / Dec | 47 | 0.005′ / 0.002′ |
| stars GHA (GHA Aries + the page's SHA at 12h) / Dec | 655 | 0.008′ / 0.003′ |
| Moon GHA / Dec as USNO gives it | 12 | 0.081′ / 0.040′ |

Three findings:

- **USNO's Moon lag is not constant.** Section 7 found USNO's Moon 10.36 s late at one
  instant in 2026. Fitting the lag at each of these instants (Skyfield + DE440s, sidereal
  time held fixed) gives **−2.4 s (2000-02-29), +4.9 s (2016-12-31), +10.3 s
  (2026-09-24)**, with residuals of 0.0000′ to 0.0001′ after the fit: USNO evaluates the
  Moon on a time scale that drifts from UTC + ΔAT + 32.184 s by several seconds a decade.
  Allowing a fixed 10.36 s would put the 2000 page 0.11′ from USNO; taken as USNO gives
  it, every Moon value here is within 0.085′. Anyone comparing a Moon with USNO should fit
  the lag per epoch rather than assume one.
- **Venus.** USNO gives Venus's centre of light, the page (like the printed almanac's
  tables and JPL's apparent place) the centre of the disc — up to 0.23′ of GHA and 0.12′
  of Dec in September 2026, when Venus was a 20 % crescent 0.3 AU away, always toward the
  Sun (section 10 measures USNO's phase correction). The page and Skyfield agree about
  USNO's Venus to 0.005′.
- **Polaris moves fast in SHA.** Near the pole annual aberration and nutation change its
  SHA by up to **0.79′ a day** (1990-2060); the page's 12h value is up to 0.40′ off at 00h
  or 24h (0.19′ against USNO at 2026-09-24 00h). The other 57 stars stay within 0.012′ of
  their 12h row all day. The printed almanac tabulates Polaris separately for this
  reason; the page lists it after the 57 stars and says so in its notes.

### Where the page differs from the printed Nautical Almanac

One date per page (the printed almanac has three) and moonrise/moonset for two dates
(it has four); UTC with DUT1 = 0 as the argument instead of UT1 (up to 0.23′ of GHA and
1 s of time); once-a-day values at 12h UT of the date instead of the middle of three
days; rise and set for an observer on the WGS84 ellipsoid (CONVENTIONS 13.2; seconds of
time at most); the `n/a`, `--` and `-00 mm` notations; the project's star spellings
(`Zubenelgenubi`) and Polaris among the stars. The printed almanac's own conventions for
the edge cases (a phenomenon on the following date, twilight all night) were followed as
far as they are documented; where they are not, CONVENTIONS 13.9 states the rule used.

### Speed

`almanac_day` is about 30 `day_events` calls (one per latitude over 3.5 days) plus 150
hourly evaluations. A per-page memo of the provider (`pages::Memo`) computes each track
node once for all latitudes, bit-for-bit the same as without it. About 35-40 ms per page
native (release, x86-64) and 45-55 ms in WebAssembly under Node 24 (`wasm-release`
profile); the first call of a session takes about 90 ms because it also parses the
embedded series. Measured on a shared machine under load (load average 11).

### Reproduce

`tools/reference/.venv/bin/python -m tools.reference.gen_almanac` (about 6 minutes) and
`... gen_almanac --usno-only` (network, about a minute), then
`cargo test -p skyfix-almanac --release --test almanac_reference --test almanac_usno
-- --nocapture`, which prints every figure above.

## 12. Eclipses

Owner: eclipse agent. The engine is `skyfix_almanac::eclipses` (model and conventions in
its module documentation; sources in `docs/THIRD_PARTY.md`, "Eclipses"; wire format in
`docs/EXPLORER_API.md`, "Wave 2 — eclipses"). It uses the project's own Sun and Moon
(sections 2 and 7) — the same two theories, VSOP87 and ELP 2000-82, that NASA's *Five
Millennium Canon* was computed with — reduced to Besselian elements interpolated at 9
Chebyshev nodes over 12 hours. The interpolation error is at the floor set by the
resolution of an `f64` Julian date (6e-9 Earth radii, 4 cm; 3e-9 rad in the angles).

**Conventions, stated because they move numbers.** Moon radius `k1 = 0.272488` Earth
radii for external contacts and the penumbra, `k2 = 0.272281` for internal contacts and
the umbra (NASA's values); the Sun's radius subtends 959.63″ at 1 au; lunar shadow by
Danjon's rule (`1.01 × π☾ ∓ s☉ + π☉`), NASA's, not the Astronomical Almanac's 1/50;
maximum eclipse at a place is the greatest magnitude. The lunar limb profile is not
modelled (NASA: it moves limits by 1-3 km and totality by 1-3 s). Refraction is not
applied to contacts or altitudes (CONVENTIONS 13.2 geometric values).

**How Delta-T is handled.** The engine's TT − UT1 is 32.184 s + (TAI − UTC), DUT1 = 0:
within 0.9 s of the truth for the past, frozen at 69.184 s for the future. NASA's canon
uses its own Delta-T (74 s for 2024, about 113 s for 2060, extrapolated) and USNO its
own (72.8 s for 2024). Global quantities — the instant of greatest eclipse, gamma,
magnitudes, types — are geocentric and do not depend on Earth rotation, so they are
compared in TT, where Delta-T cancels. Anything tied to the ground is compared after
adopting the source's Delta-T through `Eclipses::with_dut1_s(32.184 + 37 − ΔT)`, or,
for the canon's positions, by rotating our longitude by `15.04″ × (ΔT_NASA − ΔT_ours)`,
exact for a pure clock difference. Every eclipse reports the `delta_t_s` its ground
track assumed. For future eclipses the true Delta-T will differ from 69.184 s by an
unknown amount: each second is 15″ of longitude (460 m at the equator) on the path and
up to about a second on a local contact time.

### Every eclipse of 1990-2060 against NASA's canon

`tests/eclipse_canon.rs` against `fixtures/reference/eclipses_nasa_canon.json` (320
rows parsed verbatim). **All 158 solar eclipses (47 total, 51 annular, 6 hybrid, 54
partial) and all 162 lunar eclipses are found, none extra, with the same type, the same
central or non-central class, and the same saros and lunation numbers** — including the
borderline cases the conventions decide: 2014-04-29 (non-central annular, γ −1.0000),
2043-04-09 (non-central total, γ 1.0031), the six hybrids, 2042-09-29 (penumbral by
Danjon's rule, partial by the Almanac's) and 2016-08-18 and 2042-10-28 (no eclipse by
Danjon's rule, faint penumbral by the Almanac's).

| quantity | target | worst | where |
|---|---|---|---|
| solar greatest eclipse, TT vs TD | 2 min | **1.4 s** (median 0.4 s) | 2059-05-11 |
| solar gamma | 0.001 | **7e-5** | 2013-11-03 |
| solar magnitude | 0.01 | **9e-5** | 2047-01-26 |
| lunar greatest eclipse, TT vs TD | 2 min | **11.3 s**; total 1.7 s, partial 5.4 s | 2002-06-24 (penumbral, γ −1.44) |
| lunar gamma | 0.001 | **1.2e-4** | 2060-11-08 |
| lunar umbral / penumbral magnitude | 0.01 | **3.1e-4 / 3.3e-4** | 2013-05-25 |
| lunar durations, total / partial / penumbral | | 0.05 / 0.11 / 1.0 min | the last 2027-07-18, penumbral magnitude 0.0014 |
| point of greatest eclipse (NASA rounds to 1°) | | 0.58° | 2052-03-30 |
| Moon's zenith point at greatest eclipse (rounded to 1°) | | 0.66° | 2004-05-04 |
| Sun's altitude at greatest eclipse (rounded to 1°) | | 0.50° | 2055-07-24 |
| central duration (NASA rounds to 1 s) | | 0.67 s | 2045-02-16 |
| path width, Sun ≥ 20° (NASA rounds to 1 km) | | 1.25 km per 300 km | 1997-03-09 |
| path width, Sun below 20° | | 4.6 % | 2033-03-30 (γ 0.978, Sun 11°) |

The lunar timing residual grows with the shallowness of the eclipse: the Moon's closest
approach to the shadow axis is flat in time when it passes far from it. The widths of
the most grazing paths differ by definition (NASA's width of a strongly curved path
low in the sky is not the sum of the distances to the two limits used here).

### Besselian elements against NASA's polynomials

Unit test `eclipses::bessel::tests::elements_match_nasas_polynomials` against the
polynomial elements of six eclipses 2017-2026 (78 instants over each table's six-hour
window, NASA's `μ` converted from the ephemeris meridian): `x`, `y` within **9.7e-5
Earth radii (620 m)**, 4.5e-5 to 9.7e-5 by eclipse; `d` 2.5e-5°; `μ` 4.2e-5°; `l1`,
`l2` 1.5e-6; `tan f` 2.1e-7. NASA's lunar theory is ELP-2000/85, ours ELP 2000-82B;
its tables are cubic fits printed to six decimals. The largest difference is for
2021-12-04 (see paths below).

### Paths against NASA's path tables and Skyfield

`tests/eclipse_paths.rs`. NASA's tables (six eclipses, 1428 points on the central line
and the umbral limits, every two minutes) are compared at NASA's Delta-T, point by
point, as a map needs it: the distance of NASA's point from our curve, and the
difference between our curve's time at the foot of that perpendicular and the table's.
Comparing positions at equal times instead mixes the two: near sunrise and sunset the
shadow crosses the ground at hundreds of km/s.

| eclipse | off our lines (Sun ≥ 5°) | along them | ends of the path | greatest eclipse | width, duration |
|---|---|---|---|---|---|
| 2017-08-21 T | 0.32 km | 0.8 s | 0.8 km | −0.2 s, 0.08 km | +0.04 km, −0.04 s |
| 2021-12-04 T (Antarctica) | 2.3 km | 2.2 s | 2.3 km | −0.4 s, 1.70 km | −0.59 km, 0.00 s |
| 2023-04-20 H | 0.44 km | 1.4 s | 0.4 km | +0.6 s, 0.26 km | −0.04 km, −0.07 s |
| 2023-10-14 A | 0.43 km | 0.8 s | 0.7 km | +0.3 s, 0.41 km | +0.08 km, −0.16 s |
| 2024-04-08 T | 0.59 km | 0.8 s | 0.5 km | +0.3 s, 0.31 km | +0.00 km, −0.11 s |
| 2026-08-12 T (over the pole) | 0.35 km | 0.4 s | 0.3 km | +0.3 s, 0.16 km | −0.44 km, −0.02 s |

The 2021 Antarctic eclipse is the outlier because its path is low in the sky (the Sun at
most 17° up): there a shift of the shadow axis on the fundamental plane is stretched by
`1 / sin(altitude)` on the ground, and 2021-12-04 is also where our elements and NASA's
differ most (620 m on the plane, 2.3 km on the ice). Skyfield decides between them: at
100° W and 80° W our umbral limits are within 0.08-0.16 km of where Skyfield + DE440s
puts them, so the 2.3 km are NASA's (its ELP-2000/85 against DE440s), not ours. The test
holds that eclipse to 3 km against NASA and the others to 1 km.

**The ends of the path.** Where the limits reach the horizon they do not simply stop:
the time of the grazing maximum folds back (the southern limit of 2024-04-08 turns at the
Sun 0.5° high and runs 50 km on to the horizon in 0.07 s), and the path of totality is
closed by the small loops where totality is under way at sunrise or sunset
(`umbra_horizon`). NASA's "Limits" rows are the extremes of those loops; ours reach
them within 0.8 km (2.3 km for 2021). The penumbral limits fold more strongly: the
southern penumbral limit of 2017-08-21 turns back with the Sun about 4° up, and its
second branch reaches the horizon at an instant some 25 s earlier, 600 km further on.

**Labels.** North and south are the sides left and right of the shadow's motion, as in
NASA's tables; for a path running west (Antarctica, 2021) "north" is the geographic
south. NASA's hybrid table labels by the sign of `L2` instead, so in the total part of
2023-04-20 its "northern limit" is the geographic southern one; the test compares that
eclipse's limits without labels.

**Limits against Skyfield + DE440s.** `fixtures/reference/eclipses_skyfield.json`
finds, independently of any Besselian formalism, where each limit crosses a meridian:
the latitude at which the eclipse is exactly grazing at maximum, from the topocentric
Sun-Moon separation alone, keeping only crossings with the Sun up. 21 crossings on 13
meridians (2017-08-21, 2021-12-04, 2023-10-14, 2024-04-08): **umbral limits within 0.59
km** (0.004-0.16 km for 2017 and 2021, up to 0.59 km for 2024, where the contact times
also put our Moon 0.4 s from DE440s), **penumbral limits within 0.40 km** — including
the southern penumbral limit of 2017 at 40° W with the Sun 1.7° up, on the branch that
folds back to the horizon — and the times at the crossings within 1.1 s. Target 0.01°
of latitude (1.1 km).

### Local circumstances against USNO and Skyfield

`tests/eclipse_local.rs`, 22 sites for 2017-08-21 (total), 2023-10-14 (annular) and
2024-04-08 (total): U.S. cities in and out of the paths, Mazatlán, Honolulu (the Sun
rises eclipsed in 2017), Dakar (it sets eclipsed), Reykjavík (it sets 26 minutes after
the eclipse ends) and Sydney (not visible).

**USNO's Solar Eclipse Computer**, at USNO's Delta-T: all contacts within **2.0 s**
(target 1 min); maximum within 0.8 s at 19 sites, 4.7 and 5.4 s at Honolulu where the
Sun is 5 to 12° up and the instant of maximum is flat (its magnitude changes by a
millionth in five seconds; Skyfield with our definition agrees with us there to 0.4 s,
so USNO's definition differs); sunrise and sunset within 2.1 s of USNO's minute; magnitude within
0.0007, obscuration within 0.11 %; the Sun's altitude and azimuth within 0.05° and
0.06°; the contact position angles within 0.05° at first and fourth contact and 1.0° at
second and third (USNO gives an annular eclipse's second and third contact on the
opposite side of the Sun's disc; ours is where the limbs meet); vertex angles within
1.1°, the parallactic angle being taken with the geodetic vertical. **As shipped**
(DUT1 = 0, our own Delta-T): contacts within 5.7 s, maxima within 9.3 s. Every visibility
class agrees, and Sydney, which USNO reports as not visible, is `below_horizon` here: it
is inside the penumbra's cone, on the night side.

**Skyfield + DE440s** (UT1 = UTC, the same radii): the 72 contact instants agree within
**0.44 s**, which at our instants is a separation residual of at most **0.16″** — at
every contact the topocentric Sun-Moon separation from DE440s equals the sum or the
difference of the semidiameters to 0.16″ (target 5 s). The Sun's altitude and azimuth at
the contacts agree within 0.002°, the Moon's position angle at first and fourth contact
within 0.004°, the magnitude at maximum within 5e-5, and the instant of maximum (the
greatest magnitude on both sides) within 0.43 s.

**Lunar eclipses against Skyfield + DE440s**: the contacts of 2022-11-08 and 2025-03-14
within 0.66 s, gamma and magnitudes within 5e-4, and the Moon's altitude at each contact
within 0.0023° at six sites; the visibility classes (visible at Honolulu, Tokyo and
Philadelphia in 2025; setting during the eclipse at Philadelphia in 2022 and at London
in 2025; rising at Sydney) follow.

### Speed

Release build, x86-64, on a shared 8-core machine (load average 5-6 while measured):
all eclipses of 1990-2060 in **0.26-0.28 s** (best of three; `cargo test --release -p
skyfix-almanac --test eclipse_canon -- --ignored --nocapture`); one eclipse by id in
0.9 ms; `eclipse_path` in **7-24 ms** for each of the 22 solar eclipses of 2017-2026
(best of five; `--test eclipse_paths -- --ignored`), against a budget of 50 ms; single
runs under heavier load reached 50 ms. Most of the scan is the ephemeris: 9 Sun and Moon
evaluations per eclipse at 66 µs each. The unoptimised test build scans 1990-2060 in
1.6 s.

### Reproduce

- `tools/reference/.venv/bin/python -m tools.reference.gen_eclipses` regenerates all four
  fixtures (NASA and USNO need the network; `--offline` rebuilds only the Skyfield file,
  about four minutes).
- `cargo test -p skyfix-almanac --test eclipse_canon --test eclipse_paths --test
  eclipse_local -- --nocapture` and `cargo test -p skyfix-almanac --lib bessel --
  --nocapture` print every number above.

## 13. Planet events

Owner: eclipse agent. The engine is `skyfix_almanac::planet_events` (definitions in its
module documentation; wire format in `docs/EXPLORER_API.md`, "Wave 2 — planet events").
It follows the planet provider's apparent places (section 2, "Planets"), so its accuracy
is that provider's, converted into time by how fast each configuration changes.

**Definitions.** Conjunction and opposition: the apparent geocentric ecliptic longitude
of date of the planet minus the Sun's is 0 or 180 degrees (as the Moon's phases,
CONVENTIONS 13.5); a conjunction of Mercury or Venus is inferior when the phase angle is
over 90 degrees. Greatest elongation: a local maximum of the apparent planet-Sun angle,
east when the planet is east of the Sun in longitude. Closest approach: a local minimum
of the light-time distance. Transit: the least separation near an inferior conjunction
is under the sum of the semidiameters (the Sun's 959.63″ at 1 au). The search samples
each planet every 3 days (Mercury) to 16 days (Jupiter to Neptune) and refines each
sign change or extremum with Brent's method.

### Against Skyfield + JPL DE440s

`tests/planet_events.rs` against `fixtures/reference/planet_events_skyfield.json`, built
with Skyfield's own `almanac.oppositions_conjunctions`, `find_maxima` and `find_minima`.
**All 2266 events of 1990-2060 are found, one for one, none extra, of the same kind**:
537 inferior and superior conjunctions of Mercury and Venus, 308 conjunctions and 308
oppositions of Mars to Neptune, 536 greatest elongations, 577 closest approaches. **All
12 transits are identified** (Mercury 1993, 1999, 2003, 2006, 2016, 2019, 2032, 2039,
2049, 2052; Venus 2004, 2012), and no other inferior conjunction is called one; the same
twelve, on the same dates, as NASA's transit catalogues (Espenak; test
`the_transits_are_those_of_nasas_catalogues`).

| quantity | target | median | worst | where |
|---|---|---|---|---|
| conjunctions of Mercury and Venus | 1 min | 0.3 s | **3.0 s** | Venus |
| conjunctions of Mars to Neptune | 1 min | 6.2 s | **55.4 s** | Neptune, 2059-06-06 |
| oppositions | 1 min | 6.3 s | **52.7 s** | Neptune |
| greatest elongations, instant | 10 min | 0.9 s | **13.3 s** | |
| greatest elongations, angle | 0.001° | | **0.00001°** | |
| closest approaches, instant | 10 min | 2.1 s | **68.4 s** | Neptune, 2059-12-08 |
| closest approaches, distance | 1e-5 | | **3.7e-6** (11 148 km) | Neptune |

The time residuals grow with the planet's distance because the configurations change
slowly: at a conjunction of Neptune the longitude difference changes by about a degree
a day, so 55 s is 2.2″ of combined Sun and Neptune error, well inside the planets'
0.1′ target (a 0.1′ error there would be 2.4 min). Neptune's conjunctions and
oppositions have a median of 35 s, Uranus's 15 s, Saturn's and Jupiter's 4-5 s, Mars's
0.7 s. Greatest elongations and closest approaches are flat maxima and minima: Venus's
elongation changes by under 0.001° in the 12 hours either side of its greatest, so the
instant is loosely defined and the angle is what matters.

### Against NASA's SKYCAL (a published U.S. Government source)

`fixtures/reference/planet_events_nasa_skycal.json`, NASA's *Sky Events Calendar*
(Espenak and Dutta, GSFC), parsed verbatim for 1990-2060. **Its 1689 conjunctions,
oppositions and greatest elongations are exactly our list less the closest approaches**
(SKYCAL has none): every event matched, of the same kind, none missing, none extra. Its
instants are approximate: median 18 min from ours, 95 % within 1.9 h, worst 4.4 h (a
conjunction of Jupiter), with the Mercury events closest (median 10 min) and those of
Jupiter and Uranus furthest (median 73 and 83 min). Ours are 0.3 to 55 s from DE440s, so
the differences are SKYCAL's; its calendar is meant to the day. Its greatest
elongations, printed to 0.1°, agree with ours within **0.05°**.

### Speed

Release build, x86-64, on the shared 8-core machine: one year of events in 29 ms (70 ms
under heavy load), 1990-2060 in 1.8-3.0 s. Most of it is the planet provider: about 590
evaluations a year for the seven planets (the grid, then 18 per event refined), 28 µs
each.

### Reproduce

- `tools/reference/.venv/bin/python -m tools.reference.gen_planet_events` regenerates
  both fixtures (SKYCAL needs the network; `--offline` rebuilds only the Skyfield file,
  about five minutes).
- `cargo test --release -p skyfix-almanac --test planet_events -- --include-ignored
  --nocapture` prints the numbers for 2019-2026 and 1990-2060.

## 14. Sun tools

Owner: suntools agent (expansion programme P7). The engine is `skyfix_almanac::sun_tools`
(definitions CONVENTIONS 13.10; wire format `docs/EXPLORER_API.md`, "Expansion programme —
sun tools"). It is built on the event finder and `sky_state` (sections 2 and 9), so its
positions are theirs; what is new is checked here: the searches, the clocks, the formulas.
Reference fixture: `fixtures/reference/sun_tools_skyfield.json` (Skyfield 1.55 + JPL
DE440s, UT1 = UTC by construction), tests `crates/skyfix-almanac/tests/sun_tools_*.rs`.

### Against Skyfield + JPL DE440s

`tests/sun_tools_reference.rs` (`--nocapture` prints every figure).

| quantity | cases | target | worst |
|---|---|---|---|
| equation of time | 480 instants, 1990-2060 | 1 s | **0.012 s** |
| the Sun's declination beside it | same | 0.01° | 0.108″ |
| galactic centre, apparent RA/Dec of date | 72 (6 sites, 1995-2055) | 0.01° | 0.020″ |
| galactic centre, topocentric altitude / azimuth | same | 0.01° | 0.262″ / 0.310″ |
| the arch's highest point, against a brute-force search along Skyfield's galactic equator | same | 0.01° | 28.6″ altitude, 31.0″ azimuth |
| bearing crossings of the Sun and the Moon, error on the sky | 11 crossings, 6 sites | 0.01° | **0.21″** |
| bearing crossings, instant, where the bearing is swept faster than 1°/h | 10 | 1 s | 0.015 s |
| Manhattan's sunsets (h0 = −50′), instant / azimuth | 26 evenings, May and July 2026 | 1 s / 0.01° | 0.005 s / 0.21″ |
| analemma at 12:00 local mean time (Philadelphia) | 24 dates of 2026 | 0.01° | 0.218″ |

The arch's 29″ is not an error of either side: the formula (CONVENTIONS 13.10) takes the
great circle 90° from the *aberrated* pole, while the fixture aberrates each point of the
band; annual aberration (20.5″) moves the two differently, by at most √2 × 20.5″ = 29″.
Both are far inside what a Milky Way band 10-20° wide can show. One bearing crossing is
ill-conditioned: at Quito at the equinox the Sun climbs almost straight up at azimuth 90°
(the bearing is swept at 0.06°/h), so its instant differs from Skyfield's by 1.0 s while
the direction differs by 0.063″; the test judges every crossing by its error on the sky
and the instant only where the sweep exceeds 1°/h.

### Against published values

- **Meeus, *Astronomical Algorithms* example 28.a** (1992 October 13.0 TD): the book gives
  the equation of time as +13m 42.6s (3.427351° = 822.564 s); this engine gives 822.385 s
  (**−0.18 s**). The difference is the definition of the mean sun: the engine uses the
  almanac page's `GHA − 15° (UT − 12 h)` (CONVENTIONS 13.9), Meeus the Sun's mean
  longitude, which runs 0.21 s ahead (`skyfix_ephemeris::sun::equation_of_time_min`
  follows Meeus and reproduces the book within 0.1 s). The yearly series equals the
  almanac pages' `eot_12h` exactly.
- **Manhattanhenge** (the American Museum of Natural History's published dates for 2026:
  half sun 28 May, full sun 29 May, full sun 11 July, half sun 12 July), with Manhattan's
  grid at azimuth 299.0° and the engine's clock EDT (`tests/sun_tools_logic.rs`,
  `manhattanhenge_as_the_engine_sees_it`):

  | definition | May | July |
  |---|---|---|
  | the engine's sunset: upper limb on a sea-level horizon, standard refraction | 24 May | 18 July |
  | "half sun", the centre at 0° apparent | 25 May | 16 July |
  | "half sun", the centre at 0° **geometric** (no refraction) | **28 May** | 14 July |
  | "full sun", the lower limb at 0° geometric | **29 May** | 13 July |

  AMNH's May dates are reproduced exactly when refraction is left out; its July dates
  are two days earlier than the engine's. The engine's May and July dates have the same
  solar declination (checked: within 0.15°), as they must for the same azimuth at the same
  altitude and latitude, so the difference is in the published July computation or its
  horizon, not in the Sun's position. Real streets end at a raised horizon (buildings, New
  Jersey), which the sea-level model does not know; `at_altitude` lets a user give it.
- **The clear-sky model** is a labelled estimate, not a validated number: the formulas are
  checked against their printed form (Reno, Hansen & Stein 2012, SAND2012-2389, eqs. 18
  and 22-23, and the isotropic plane of array; 67 cases to 1e-5 W/m²), and its typical
  error is the report's: **RMSE 6.6 %** of measured clear-sky global irradiance averaged
  over 30 U.S. sites (about 300 site-years) with a small mean bias, underestimating at
  high-elevation sites and varying with season and time of day. Clouds are not modelled.
  Sanity: a clear day at Philadelphia (40° N) gives 8.8 kWh/m² on the ground at
  midsummer and 2.4 kWh/m² at midwinter; Philadelphia's
  clear-sky year is 2099 kWh/m² flat, 2448 kWh/m² at 30° facing south, best tilt 34.7°
  (2455 kWh/m²).

### Consistency with the rest of the engine

`tests/sun_tools_logic.rs`, by dense brute-force sampling of `sky_state`:

- golden and blue hours at ten place-days (Philadelphia at the solstices and an equinox,
  Tromsø at midwinter, midsummer, January and November, Quito, Sydney, 89.9° N): every
  crossing at its threshold to **9e-7°**; the band of the Sun sampled every 2 minutes
  agrees with the windows everywhere; the −6° crossings are `day_events`' civil dawn and
  dusk within 5 ms; morning windows climb and evening windows sink;
- a bearing of 180° is the meridian passage of the Sun, the Moon and Jupiter within 5 ms;
  every crossing of five bodies at eight bearings is on its bearing in `sky_state` to
  1e-4°;
- the analemma, the sun path and rise and set azimuths are `sky_state`, `sample_bodies`
  and `day_events` at the same instants (to 1e-5° and 10 ms);
- the Milky Way windows hold their conditions at every 5-minute sample, are maximal
  (10 s outside each edge a condition fails or the Moon rises or sets), and their best
  moment is the highest sample.

### Speed

Release build, x86-64, on the shared 8-core machine under heavy load from the other
agents (load average about 20), `cargo test --release -p skyfix-almanac --test
sun_tools_perf -- --ignored --nocapture`:

| call | native |
|---|---|
| `sun_hours`, one day | 0.7 ms |
| `find_azimuth`, the Sun, a year | 47 ms |
| `alignment_days`, sunsets of a year / the Sun at 5° | 60 ms / 56 ms |
| `analemma`, `equation_of_time`, a year | 10 ms / 12 ms |
| `sun_path` with its envelope | 4 ms |
| `rise_set_azimuths`, the Sun, a year | 58 ms |
| `solar_year`, with the best-tilt search | 52-90 ms |
| `galactic_centre_windows`, a night / 30 nights | 1.3 ms / 41 ms |
| the Moon's year series (`rise_set_azimuths`, moonrise alignments) | 0.27-0.33 s |

Every year-long series of the Sun is under the 200 ms budget. The Moon's are dominated by
the provider: a year of the event finder's 3-hour track nodes is about 2900 exact
evaluations of ELP 2000-82B at about 0.1 ms each. WebAssembly (Node, the same shared
machine) ran the Sun's year series in 0.15-0.6 s, about four times native, the same ratio
as the existing `day_events`.

### Reproduce

- `tools/reference/.venv/bin/python -m tools.reference.gen_sun_tools` regenerates the
  fixture (offline, about 10 s).
- `cargo test --release -p skyfix-almanac --test sun_tools_reference --test
  sun_tools_logic -- --nocapture` prints every figure above.

## 15. Magnetic variation and compass error

Owner: geomag agent (expansion programme). The models are `crates/skyfix-geomag`
(CONVENTIONS 14.1), the method `crates/skyfix-core/src/methods/compass.rs`
(CONVENTIONS 14.2, NAVIGATION_METHODS 9), the exports `crates/skyfix-wasm/src/geomag.rs`.

**Two different accuracies.** The numbers below say how exactly SkyFix evaluates the
published models: to a millionth of a degree. How well the models describe the real field
is a different, much larger number, and it is the one the interface shows beside every
variation (`uncertainty.declination_deg`): for WMM2025, NCEI's error model, 0.29° where
the horizontal field is strongest, about 0.36° at Philadelphia, growing like `5417/H`
toward the magnetic poles (2.7° at H = 2000 nT, the edge of the blackout zone); for
IGRF-14, Beggan (2022)'s 0.39° global standard deviation for 1980-2020, widened for less
certain eras (×1.49 in 1945). Local magnetic anomalies of a few degrees are common over
small areas and are in no global model.

### WMM2025 against its official test values

`crates/skyfix-geomag/tests/wmm2025_official.rs`, against
`fixtures/reference/geomag_wmm2025.json` (NOAA NCEI's `WMM2025_TestValues.txt` and the
technical report's tables; `tools/geomag/gen_fixtures.py`):

| quantity | 100 official test values (2025.0-2029.5, 0-98 km) | Table 6 (12 rows) |
|---|---|---|
| declination, as printed (0.01°) | **0.0050°** | 0.0046° |
| inclination, as printed (0.01°) | **0.0050°** | 0.0050° |
| declination from the file's own X, Y (6 decimals) | 1.4e-6° | — |
| X (north) | 7.2e-4 nT | 0.048 nT (printed 0.1) |
| Y (east), Z (down) | 5.0e-7 nT, 2.2e-6 nT | 0.044, 0.049 nT |
| H, F | 7.0e-4, 4.3e-4 nT | 0.050, 0.045 nT |
| rates of X, Y, Z, H, F | ≤ 1.5e-6 nT/yr | ≤ 0.050 nT/yr |
| rates of D, I | 5.0e-7 °/yr | 0.0049 °/yr |

The X differences, and only they (Z moves by `sin psi` of them), are the file's: its X′
carries noise of about 1e-8 of the field, while its Y′ and Z′, and the report's
high-precision numerical example (Tables 3a-3b, reproduced step by step to 1e-6 nT,
`src/reference_tests.rs`), agree with SkyFix to a few micro-nT; SkyFix's Legendre
derivatives satisfy the exact identity to 1e-12. The WMM's licence to use its name asks
for 0.1 nT and 0.1 nT/yr. At the report's dip poles (Table 4, 2025.0) the horizontal
field is under 30 nT, as the rounding of their positions to 0.01° allows.

### IGRF-14 against IAGA, BGS and NOAA

`crates/skyfix-geomag/tests/igrf14_reference.rs` and `src/reference_tests.rs`, against
`fixtures/reference/geomag_igrf14.json`:

- **IAGA's own test values** (the twelve cases of its `pyIGRF14` package, geocentric, one
  every 15 years from 1900 and at 2010-2030): every X, Y, Z within 0.0099 nT; the package
  prints to 0.01 nT, rounding before 2010 and cutting off from 2010 (17529.4899 is printed
  17529.48).
- **The British Geological Survey's IGRF-14 calculator** at 25 points from 1900 to
  2029-12-31: London, Philadelphia, Cape Town, Tokyo, Buenos Aires, Anchorage, Reykjavik,
  Honolulu, Singapore, Svalbard, McMurdo, Mumbai, Moscow, Lima, Nairobi at 1.7 km (during the
  1995-2000 change of degree), Nova Scotia, New Zealand, the Canadian Arctic (H 3500 nT),
  the Gulf of Mexico, the Southern Ocean, Paris, Mauritius, the mid-Atlantic at 10 km in
  2027 (forecast) and 85° N in 2029. Worst **declination 0.0005°, inclination 0.0005°**
  (the service prints 0.001°), intensities 0.50 nT (printed 1 nT), rates 0.05 nT/yr and
  0.05′/yr (printed 0.1). The brief's target is 0.1°. The service reads a date as its
  middle (it reports 2030-01-01 as 2030.001), so each case is compared at 12:00 UTC.
  NOAA's own calculator answers only with a registered key and was not used.
- **NOAA's Geomag 7.0 sample output** at 2015 (+1/365), where IGRF-13 and IGRF-14 share the
  definitive 2015 field: declination within 0.48′ (printed to 1′), inclination 0.25′,
  intensities 0.04 nT (printed 0.1).
- The coefficient tables are the published files, number for number
  (`models::tests::the_tables_are_the_published_files`).
- The automatic switch from IGRF-14 to WMM2025 at 2025.0 moves the declination by at most
  0.014° at four mid-latitude cities, a twentieth of either model's uncertainty.

### Compass error

`crates/skyfix-core/tests/compass_reference.rs` and `crates/skyfix-wasm/src/geomag.rs`:
Bowditch's five worked examples of chapter 15 (1501 Sun's azimuth 123.187° against the
book's 123.2°; 1502 Polaris through the engine 359.250° against the Almanac table's
359.2°; 1504 amplitude 32.666° against 32.6°; 1505 Table 23's correction +1.219° against
+1.2° and the gyro error 0.633° E against 0.6° E; 1506 99.133° against 99.1°), all within
the 0.1° its tables print; the azimuth method equals the explorer's topocentric `az_deg`
to 0.00001° for the Sun, the Moon, Jupiter and three stars at 16 place-dates (Venus
0.006°, by design: its centre of light); amplitude bearings equal the topocentric azimuth
at the crossing to 0.0000° (Sun) and 0.003° (Moon). The full table is in
`docs/NAVIGATION_METHODS.md` section 9.4.

### Speed and size

Release build, x86-64, on the shared 8-core machine: 9-12 µs for one full `field` (with
rates, uncertainty and notes); a 1-degree global grid of declination (65 341 points) in
71 ms, 1.1 µs a point. The
coefficients add about 11 KB to the binary (integer tables; the IGRF-14 epochs before 2000
are whole nanotesla and fit in 16 bits). Against the programme's base commit (3030e4f) the core
WASM module (`npm run wasm`) grows from 2 060 798 to 2 130 258 bytes, 849 019 to 878 239
gzipped (-9): +69 KB and +29 KB, the rest being the code of the models, the compass method
and their wire formats. With the sun tools merged as well it is 2 249 383 bytes, 923 851
gzipped, against the 2.5 MB / 1 MB budget.

## 14. Sailings, dip short, star identification, star finder (expansion programme)

*Sailings agent, 2026-09-24. Methods: `docs/NAVIGATION_METHODS.md` sections 9–13.*

### Sailings against Bowditch

`fixtures/reference/bowditch_sailings.json` types every numbered worked example of Bowditch
2019 vol. 1 ch. 12 "The Sailings" (26 cases, 77 compared quantities), and
`crates/skyfix-core/tests/sailings_worked_examples.rs` runs each through
`skyfix_core::sailings`. Everything agrees to the printed precision (0.1′, 0.1 NM, 0.1° of
course; 0.01° where the book prints it) except where the book's own arithmetic moves the
printed number: it rounds trigonometric values to four decimals (up to 0.43′ on a vertex
longitude from a ratio of two such values, 0.62′ where an arc-cosine near 1 magnifies one),
and it rounds a course to 0.1° before taking the distance from it (up to 1.5 NM at the
courses of its examples). Each such tolerance is that rounding carried through, and each
case says why. Two errata: §1208 example 3's final course (printed 287.4°; the book's own
formula with its own inputs gives 289.35°, which SkyFix matches to 0.0014°), and Table
1209b's last column (its arc and distance should be 70° and 4200 NM, as its declination
entry says, and its longitude east, not west). The Mercator examples use the WGS84
meridional parts, as the book's Table 6 does; on the sphere their courses move by 0.12° and
0.16°. The full table is in `docs/NAVIGATION_METHODS.md` section 9.9.

### The sphere against WGS84

`crates/skyfix-core/tests/sailings_wgs84.rs`: Vincenty's inverse (checked against the
Geocentric Datum of Australia's worked example, 54 972.271 m to 1 mm, and the WGS84 quarter
meridian, 10 001 965.729 m) and the WGS84 loxodrome (isometric latitude and meridian arc)
against the sphere's great-circle and rhumb-line distances over 19 806 random pairs
(latitudes within 80°, up to 170° apart): worst **0.502 %** for both; on 10 NM legs at
latitudes 0°–89°, **0.514 %**. A minute of latitude is 1842.9 m at the equator and 1861.6 m
at the poles against the sphere's 1852 m. The passage's notes state the bound.

### Dip short of the horizon

`crates/skyfix-core/tests/dip_short.rs` against 28 entries of Bowditch 2019 vol. 2 Table 14
(`fixtures/reference/bowditch_dip_short.json`), 5 to 100 ft and 0.2 to 10 NM, four of them
beyond the sea horizon where the table repeats the sea dip: worst **0.046′**, inside the
table's own 0.05′ rounding. The arctangent form is needed at the table's corner (100 ft,
0.2 NM: 282.3′ printed; the linear form's 282.97′ would miss by 0.67′). Predicted readings to
a shore horizon reduce back to their `Hc` exactly; the shore horizon round-trips through
JSON and CSV.

### Star identification

`crates/skyfix-wasm/src/sailings.rs` tests, with the explorer's sky (58 stars, Mercury to
Saturn, the Moon): each of the 58 stars, from its own predicted sextant reading and azimuth
(`predict_sextant`, height of eye 3 m, index correction −1.2′) at five random places and
times each, 10° to 80° high, is ranked first: **290 of 290**, worst separation under
0.00001°. With 1′ of altitude error, 1.5° of bearing error and a DR 10 NM out (1 sigma each),
the true star is within the default tolerances in **400 of 400** sights and first in all
400. The Moon is found from its own lower-limb reading. The brightness rule
(`limiting_magnitude`) is a labelled heuristic, equal to the planner's in nautical twilight
by test; it is not validated against observations.

### Star finder

`crates/skyfix-core/src/methods/starfinder.rs` tests: at 20 000 random template latitudes,
hour angles of Aries and stars, the template set on the Aries index places each star above
the horizon at its CONVENTIONS section 3 altitude and azimuth to **1e-9** of the disc's
radius; the same holds for the real 58 stars at a real time. The grid is geometric (no
refraction, no dip), like the printed 2102-D, and a template serves ±5° of latitude, where
readings are good to a few degrees: that is the instrument's accuracy, stated, not tested.

### Index-error and watch logs

`crates/skyfix-core/tests/error_logs.rs`: the interpolated values, the held values and their
warning, the reduced sight's record of the value used, JSON and CSV round trips, a
predicted reading that reduces back to its `Hc` with a logged index correction, and an
averaged sight written on the logged watch that reduces back to its own instant (to 1 ms).
Sessions without logs reduce byte-identically.

### Reproduce

```console
python3 -m tools.geomag.gen_fixtures            # the two fixtures (BGS needs the network)
python3 -m tools.geomag.gen_coeffs              # crates/skyfix-geomag/src/coeffs.rs
cargo test -p skyfix-geomag -- --nocapture
cargo test -p skyfix-core --test compass_reference -- --nocapture
cargo test -p skyfix-wasm geomag -- --nocapture
```

## 14. Time scales: Delta-T, UT1 and calendars

Model and definitions: CONVENTIONS 15.2-15.3 and `skyfix_core::{time, deltat, calendar}`
(timescales agent, 2026-09-24; UT1 − UTC from IERS `finals2000A.all` of 2026-09-25). Tests: `crates/skyfix-core/tests/timescales_reference.rs`
against `fixtures/reference/timescales.json` (`tools/timescales/gen_timescales.py`,
Skyfield 1.55), the unit tests of those modules, and `web/test/next/timescale.test.ts`.

**What changed, and what it is worth.** Before, TT − UTC was 32.184 s + ΔAT everywhere
(42.184 s for any date before 1972, 69.184 s for any date after 2016) and UT1 was UTC. That
made ΔT 153 s wrong in 1550 (the Moon 1.4′), 13 hours wrong at 2000 BC, and ignored UT1 −
UTC, up to 0.9 s (0.23′ of GHA) on every date. Now the clock is UT outside 1972-2035 with
TT = UT + ΔT from the model below, and inside it UT1 = UTC + DUT1 from the IERS history.

### Delta-T against Skyfield (targets from the brief)

Three references, all Skyfield 1.55: its `build_delta_t` run on this project's weekly table
(the Python twin), its timescale built from the same `finals2000A.all` at daily resolution
(`skyfield.data.iers`, as `load.timescale(builtin=False)` does), and its shipped timescale,
whose bundled table is an earlier `finals2000A.all` (it matches this one to 0.05 ms
through 2026-01-16 and is Skyfield's own January-2026 prediction after that).

| span | compared with | worst difference | target |
|---|---|---|---|
| −2000 to 3000, 1 075 epochs | the Python twin | **5 × 10⁻¹⁰ s** | 1 µs |
| 1973-01-02 to 2026-09-24, IERS observed | Skyfield from the same `finals2000A.all` | **1.5 ms** (the weekly table's interpolation) | 0.01 s |
| 2026-09-25 to 2027-09-28, IERS Bulletin A's prediction | the same | **1.2 ms** | 0.01 s |
| 1973-01-02 to 2026-01-16, where the bundle is observed | Skyfield's shipped timescale | **1.5 ms** | 0.01 s |
| −720 to 1972, the SMH 2016 splines (2020 revision) | both | **0** (identical tables; under 10⁻⁴ s in 1971-1973 from the adjusted last segment) | 1 s |
| −2000 to −720 and after 2800, the parabola and the left join | both | **0** | equal |
| 2026-01-17 to 2026-09-24 | Skyfield's shipped timescale, whose table is its January prediction there | 0.10 s | none: the bundle's own prediction error (0.4 ms by 01-23, 5.6 ms by 02-28, 0.11 s by 09-24) |
| 2026-09-25 to 2027-09-28 | the same | 0.31 s (2027.4) | none: two predictions eight months apart |
| 2027-09-28 to 2800, the join to the parabola | Skyfield from the same file | 0.21 s at 2290 | inside σ (230 s there): the joins start six days apart (ours at the last weekly sample) |
| the same | Skyfield's shipped timescale | 16 s at 2280 (5 s in 2060) | inside σ (220 s at 2280, 10 s in 2060): its join starts from its January prediction |

UT → TT inverts ΔT(TT) exactly as Skyfield's `ut1_jd` does; the round trip is exact to
10⁻⁵ s over −2000..3000. Reference fixtures built with `tools/timescales/skyfield_timescale.py`
share this ΔT to 5 × 10⁻¹⁰ s, so ΔT never counts as ephemeris error in them.

### The standard uncertainty of Delta-T

| epoch | ΔT | σ | source of σ |
|---|---|---|---|
| −2000 | 13 h 07 min | 1.04 h (3 732 s) | Huber (2000) from −500, NASA's rule; NASA's Table 3 value to 1 s |
| −1000 | 7 h 02 min | 622 s | the same (NASA: 622 s) |
| −500 | 4 h 42 min | 150 s | Stephenson, Morrison & Hohenkerk's published error |
| 0 | 2 h 54 min | 90 s | the same |
| 1000 | 1 650 s | 15 s | the same |
| 1600 | 109 s | 15 s | the same |
| 1900 | −2.0 s | 0.11 s | the splines' measured rms against IERS 1973-2019 (their published 0.05 s is the observations' error; the spline itself is off by up to 0.27 s) |
| 1990-2026 | IERS | 0.001 s | the weekly table (at most 1.9 ms, 0.5 ms rms) |
| 2030 | 69.6 s | 0.30 s | Huber from 2026-09-24 (Bulletin A's own formula for the first 112 days) |
| 2060 | 78.7 s | 9.8 s | the same |
| 2100 | 104.5 s | 32 s | the same |
| 2650 | 31 min | 15 min | the same |
| 3000 | 69 min | 30 min | the same |

The future curve is a model, not a forecast: Stephenson, Morrison & Hohenkerk's own
extrapolation gives 70 ± 6 s for 2050 and 80 ± 10 s for 2100, Skyfield's 97 s for 2100,
Espenak & Meeus's 204 s. All lie inside this model's 2100 band (104.5 ± 32 s) but for
Espenak & Meeus. The data audit suggested SMH's own errors until 2500 (±10 s in 2100);
they describe SMH's extrapolated curve, which already misses 2026 by 1.3 s, not this one,
and would jump to Huber's 570 s at 2500, so Huber is used throughout the future. For the
display, a σ above 30 s is shown beside every time ("±m min"); 15″ of longitude per second.

### UT1 − UTC: the IERS history

The table is IERS `finals2000A.all` of 2026-09-25 (observed, flag `I`, to 2026-09-24;
IERS Bulletin A of 2026-09-24's prediction, flag `P`, to 2027-10-02), sampled weekly.

| check | result |
|---|---|
| weekly samples (i16, 0.1 ms) against the daily series they come from, 343 dates 1973-2027 | worst **1.6 ms**; interpolation linear in UT1 − TAI, so leap seconds do not smear (the 2016-12-31 step is +1 s to 2 ms) |
| the IERS formal errors of the observed values | at most 1.5 ms (1973-1984), 0.27 ms (1985-1989), 0.06 ms since 1990: σ = 1 ms stands |
| the text of IERS Bulletin A of 2026-09-24 | its observed week to 0.4 µs, its year of predictions to 5 µs (its printed rounding) |
| the leap seconds implied by the file's +1 s steps | exactly the 25 of `skyfix_core::time` from 1974 on |
| Bulletin A's predictions to 2027-09-28 | σ = max(0.00025 n^0.75 s, Huber): 3 ms after 30 days, 0.05 s after a year |

With the history the DUT1 term of a GHA is 1 ms (0.015″) up to 2026-09-24 and a few
hundredths of a second in the predicted year, against up to 0.9 s (0.23′) before. After
2027-09-28 and in 1972 it is unknown again (0 ± 0.9 s) unless the navigator enters the
time signal's value. The section 4 row "DUT1 (UT1 − UTC) assumed zero" is superseded by
this (the moonshape agent owns that row).

Before this refresh (the first version of this section) the table was Skyfield 1.55's
bundle to 2026-01-23 and Bulletin A's observed week, with the bundle's January prediction
corrected to meet both between them. Against the observations now in hand that corrected
span was off by at most 20 ms (11 ms rms), inside the standard uncertainty it claimed
(0.052 s at mid-span) on every day; the refresh changed no CLI golden and no other test.
1962-1972 is still missing (`finals2000A.all` starts in 1973; IERS EOP 20 C04 would fill it).

### What changed in the other checks

- **The canon, USNO and Skyfield eclipse comparisons are unchanged**: they compare TT
  quantities or adopt the reference's ΔT. Three CLI goldens moved by the real UT1 − UTC
  (2024-04-08: ΔT 69.201 s, not 69.184; greatest eclipse 0.00007° of longitude; one
  moonset now rounds to :55 not :56).
- **The Moon, planet, topocentric and almanac-page fixtures** were generated with TT = UTC
  + 69.184 s and UT1 = UTC after 2035; the clock is UT there now, with TT 1.5 s later in
  2036 and 10 s later by 2060 (the Moon up to 6″). Those tests evaluate the fixture's own TT and UT1
  (`time::legacy_fixture_instant`): every residual they print is unchanged to the last
  digit. The four almanac pages after 2035 are left out until `almanac_days.json` is
  regenerated on the new scale.
- **Saros numbers** agree with the old rule for every eclipse of AD 1 to 3000 and follow
  each series through −1999..3000 (solar series −14 to 190, lunar −20 to 183), where the
  old rule gave the earliest series numbers 223 too high. NASA's canon over −1999..3000 is
  not yet a fixture; the deeptime agent's canon fixtures will check the numbers.

### Calendars and timestamps

- Julian day numbers in both calendars match Skyfield's `compute_calendar_date` at 210
  days over −7450..17190; every day of −5000..5000 round-trips in both calendars; Meeus's
  chapter 7 examples reproduce; the mock's calendars agree with JavaScript's proleptic
  Gregorian `Date` over −9999..9999.
- `parse_utc`/`format_utc` round-trip every year −2000..3000 (five dates each, awkward
  times, every Gregorian leap day) and give the same bits as the old chrono parser for
  0000-9999.

### Speed

`time_info` takes about 7 µs natively (release, 2 000 calls over −2000..3000, notes
included); the interface's budget is 50 µs. `jd_tt` on the UTC scale costs what it did (a
binary search of the leap-second table); on the UT scale two ΔT evaluations.

### Reproduce

- `tools/reference/.venv/bin/python tools/timescales/gen_timescales.py` rebuilds
  `crates/skyfix-core/src/deltat/data.rs` and `fixtures/reference/timescales.json`,
  byte-identical, from the committed sources (the full `finals2000A.all` is not needed:
  `tools/timescales/sources/finals2000A-ut1-2026-09-25.txt` holds the columns used).
- `tools/reference/.venv/bin/python tools/timescales/skyfield_timescale.py` checks the
  Python twin against the fixture.
- `cargo test --release -p skyfix-core --test timescales_reference -- --nocapture` prints
  every worst case above.
cargo test -p skyfix-core --test sailings_worked_examples -- --nocapture
cargo test -p skyfix-core --test sailings_wgs84 -- --nocapture
cargo test -p skyfix-core --test dip_short -- --nocapture
cargo test -p skyfix-core --test error_logs
cargo test -p skyfix-wasm sailings -- --nocapture
```

## 14. Moon in detail: libration, named features, apsides and supermoons, occultations

Owner: moondetail agent (expansion programme P8, 2026-09-25). Engines
`skyfix_almanac::{libration, lunar_features, apsides, occultations}` (definitions in
CONVENTIONS 13.10; wire format in `docs/EXPLORER_API.md`, "Expansion programme P8 — the
Moon in detail"). Everything here is display: none of it enters a sight.

### Libration and orientation (target 0.05°)

The model is Meeus's chapter 53 (Eckhardt's physical libration with every term of
0.0001°, the IAU `I = 1°32′32.7″`) built as one rotation matrix, plus the published
78.6944″ tilt from the figure pole to the mean rotation pole (CONVENTIONS 13.10). The
reference is **Skyfield with JPL's own lunar orientation**: NAIF's binary PCK
`moon_pa_de440_200625.bpc` (the principal-axes frame integrated with DE440, 1550–2650) and
frame kernel `moon_de440_250416.tf` (to `MOON_ME_DE440_ME421`), whose worked example the
generator reproduces to a millimetre. `tests/moon_libration.rs` against
`fixtures/reference/moon_libration.json`:

| check | cases | sub-observer point | sub-solar point | axis position angle |
|---|---|---|---|---|
| the model alone, Skyfield's apparent places in, 1550–2650 (DE440) | 330 | **0.0052°** (longitude 0.0024°, latitude 0.0052°) | **0.0060°** | **0.0061°** |
| the whole chain, the geocentre and six observers (equator to 70° N and 60° S, one at 4000 m), 1990–2060, UT1 = UTC | 300 | **0.0052°** | **0.0054°** (colongitude 0.0021°) | **0.0058°** |

The topocentric distance agrees to 0.24 km and the semidiameter to 0.00005′; the largest
diurnal libration in the sample is 1.008°. Before the figure-to-mean-pole tilt was applied
the sub-Earth latitude carried a steady +0.0223° (measured, and within 1.7″ of the tilt
DE440 publishes); the tilt removes it, and what is left (0.0024° rms in latitude, 0.0007°
in longitude) is the difference between Eckhardt's analytic theory and DE440's integrated
librations.

**Meeus's example 53.a** (1992 April 12, 0h TD): with his own λ, β and Δψ the closed
formulas reproduce his printed `l′ = −1.206°`, `b′ = +4.194°`, `l″ = −0.025°`,
`b″ = +0.006°`, `ρ = −0.01042°`, `σ = −0.01574°`, `τ = +0.02673°` to their last digit; from
this project's own Moon and Sun (whose λ differs from his chapter-47 value by 0.0005°) the
figure-frame totals `l = −1.23°`, `b = +4.20°`, `P = 15.08°` and the Sun's `l0 = 67.89°`,
`b0 = +1.46°`, `c0 = 22.11°` all agree to their printed rounding.

### Named features

Positions, diameters and names are the USGS/IAU gazetteer's (0.01° precision; `docs/
THIRD_PARTY.md`); the Sun's altitude over each is exact geometry on the frame above, so
its error is the orientation's (0.006°, about 0.2 km on the ground). What the numbers do
not include: the Sun's radius (0.27°: the terminator is a band, not a line), the local
slope and the height of the feature (a peak catches the light before the plain around
it), and irregular outlines (a mare's "centre" and "diameter" are the gazetteer's
nominal figures). `lunar_features` tests: the table's integrity (150 unique rows, ranges,
the Apollo sites), every near-side feature lit at full Moon and dark at new Moon, and the
central features on the terminator at first quarter.

### Perigee, apogee and supermoons (target 2 min, 10 km)

`tests/moon_apsides.rs` against `fixtures/reference/moon_apsides.json` (every perigee
and apogee of 1990–2060 from Skyfield + DE440s by the generator's own sampling and
golden-section search — Skyfield's `find_maxima` returned a spurious duplicate apogee in
2022 and was not used — and every new and full Moon with its distance):

| quantity | cases (1990–93, 2024–27, 2057–60) | worst |
|---|---|---|
| perigee and apogee instants (in TT) | 317 | **11.2 s** |
| distances at the extremes | 317 | **0.22 km** |
| distance at new and full Moon | 296 | **0.25 km** |
| perigee fraction (Nolle's measure) | 296 | **0.00001** |
| supermoon, micromoon, largest and smallest of the year | 296 | every flag agrees |

Every fixture event inside the three windows is found, and nothing else. **Meeus's
example 50.a** (the apogee of 1988 October 7, searched on the embedded ELP series since
1988 is outside this build's coverage): **−0.8 s and −0.18 km** from Skyfield, and 8.7 s
from Meeus's own chapter-50 series (JDE 2447442.3543, 20h30m TD).

The supermoon count is a consequence of the definition, not a property of the sky:
Nolle's rule with the orbit's own extremes flags 568 of the 1756 new and full Moons of
1990–2060 (32 %); a rule against a fixed distance or "within 24 h of perigee" flags fewer.
The result carries both distances so the interface can say what it means.

### Lunar occultations (target 30 s against Skyfield's own geometry)

`tests/moon_occultations.rs` against `fixtures/reference/moon_occultations.json`: 27
events chosen by the generator (the first close approaches from 2017 of Aldebaran,
Regulus, Spica, Antares, Alcyone, Venus, Mars, Jupiter and Saturn, at most one a year, at
the first of twelve places worldwide that sees both contacts with the Moon 5° up),
Skyfield's topocentric apparent places (DE440s, Hipparcos, UT1 = UTC), mean limb:

| quantity | worst over 48 contacts (24 events) |
|---|---|
| contact time | **1.42 s** |
| position angle on the limb | **0.033°** |
| Moon's altitude | **0.0018°** |
| Sun's altitude | **0.0034°** |

Three of the 27 are shallow (the body passes 0.24′, 0.54′ and 0.63′ inside the limb):
flagged as grazes, their least limb distance matches, and their contacts agree within 1 s
too, though near a graze a contact moves by tens of seconds per arcsecond of position.
Alcyone is searched from its catalogue place (the path the Bright Star Catalogue stars
take), the others through the engine's own providers.

**Against published predictions** (`fixtures/reference/moon_occultations_published.json`,
transcribed by hand, retrieved 2026-09-25; the sources give city names, not the exact
points, so each place is the city's usual centre):

| event | source | places | our contacts minus theirs |
|---|---|---|---|
| Saturn, 2024-08-21 | British Astronomical Association (Foulkes), UT to 0.1 min | Greenwich, Edinburgh | −5 to +5 s |
| Aldebaran, 2017-12-31 | EarthSky (McClure), from IOTA, UT to the second | London, Reykjavik | −4 to +18 s |
| Mars, 2025-01-14 | Astronomy magazine (Bakich) and J. L. Hunt, from IOTA, local times to the minute | New York, Chicago | −5 to +48 s |

Everything is inside the rounding of the published time plus a minute for the unstated
observing point and the prediction's own limb and ephemeris.

**What the numbers are not.** They are the mean limb's. The real limb's mountains and
valleys (±2 km, about ±1″) shift a contact by seconds where the body meets the limb
squarely and by up to a minute where it meets it obliquely, near the Moon's poles; a
graze's very existence depends on the real profile. The result says so beside every
list (`limb_note`). A lunar-limb pack (programme item P12) would be the remedy.

### Speed

Release build natively, CPU time on the shared machine (400 bare Moon positions cost
30 ms there; `tests/perf.rs`, `moon_detail_budget`): a year of occultations at one place
with the default bodies (the 58 navigational stars, the Bright Star Catalogue to
magnitude 3.5 and the 7 planets, 36 bodies within the Moon's reach at Philadelphia)
**76 ms** (budget 200 ms), of which 30 ms is the Moon's daily track; to magnitude 6.5
(965 bodies) 0.50 s; a year of apsides with supermoons 120 ms (mostly the phase
search); `moon_orientation` and `moon_features` about 0.5 ms each. The Moon is evaluated
once a day for the occultation search and interpolated (within 0.1 km, 0.06″); the
planets every 4 (Mercury), 8 (Venus) or 16 days (the rest), measured to 0.02°, 0.005° and
0.01°.

### Reproduce

- `tools/reference/.venv/bin/python -m tools.moon.gen_reference [libration] [apsides]
  [occultations]` regenerates the three Skyfield fixtures (about 1, 3 and 10 minutes;
  needs `de440.bsp`, `de440s.bsp`, `hip_main.dat` and the two NAIF lunar kernels in
  `tools/reference/data/`).
- `cargo test -p skyfix-almanac --test moon_libration --test moon_apsides --test
  moon_occultations -- --nocapture` prints every number above.

## Deep sky (display only; expansion programme, deepsky agent, 2026-09-24)

Owner: deepsky agent (`crates/skyfix-starfield/src/{dso,showers,milkyway,names,search,
extinction,tonight,observe}.rs`, wire format `docs/EXPLORER_API.md`, "Expansion programme —
deep sky"). Everything here is display-only (CONVENTIONS 13.6): none of it is a direction
for a sight or an accuracy claim for navigation. What can be checked against a reference is
checked below; the rest (meteor rates, limiting magnitudes, the instrument guide, the
rankings, the Milky Way picture) is a **labelled estimate** from stated rules, and the wire
says so. Sources and licences: `docs/THIRD_PARTY.md`, "Expansion programme — deep sky".

### Apparent places: the same chain as `sky_state`

A deep-sky object, a meteor radiant and the galactic centre are carried to the apparent
place of date and to altitude and azimuth by `observe::Frame` and `observe::SiteFrame`,
which compute the per-instant quantities once. `tests/observe_matches_sky_state.rs` pushes
the 58 navigational stars (with their proper motion and parallax) through the same code at
4 sites and 3 instants: **696 of 696 altitudes and azimuths identical to `sky_state`'s**
(difference 0.0″). So an object's place is as good as its catalogue position; the chain
adds nothing measurable.

### Deep-sky object positions against two references

`tests/dso_reference.rs` re-checks the shipped table (`data/dso.txt`, 213 objects)
against `fixtures/reference/dso_positions.json`, written by `tools/starfield/dso.py`
from SIMBAD and Corwin's (2004) NGC/IC positions (VizieR VII/239A). Each object has a
tolerance of `max(1′, 0.25 × major axis)`, `0.5 × major axis` for open clusters,
asterisms, star clouds and nebulae 30′ or larger, whose centres are a matter of
definition.

| check | objects | median | 90 % | worst |
|---|---|---|---|---|
| table vs the adopted Wikidata value | 213 | — | — | < 0.01′ (rounding) |
| vs SIMBAD | 213 | 0.003′ | 2.8′ | 77′ (the Hyades, 330′ across; tolerance 165′) |
| vs Corwin (2004) | 203 (10 have none) | 0.035′ | 3.1′ | 58′ (IC 2118, the Witch Head, 180′ across) |
| vs Corwin, well-centred objects (globulars, planetary nebulae, galaxies under 20′) | 108 | — | — | **0.37′** |

Wikidata's positions are largely SIMBAD's (hence the 0.003′ median), so Corwin is the
independent check. Where Wikidata held two positions for one object the build takes the
one nearer SIMBAD (recorded per object in `data/deepsky_manifest.json`); one candidate,
the Lobster Nebula (NGC 6357), was left out because Wikidata's position is 22′ from both
references.

**Magnitudes and sizes are labelled, not validated.** Wikidata's V is sometimes a
nucleus or a planetary nebula's central star, so the build adopts integrated V from
Harris's globular-cluster catalogue (43 objects), RC3's V_T for galaxies (61; five more
from B_T less the median B−V of 0.81), Wikidata for 72, and authored visual magnitudes
for all 19 planetary nebulae (IC 418's from SIMBAD) and one open cluster (NGC 2451); 12
nebulae have none (`null`). Sizes are
SIMBAD's rounded (156) or authored where SIMBAD gives a cluster's full extent (57).
Integrated magnitudes of extended objects say little about how easy they are to see;
the instrument guide's size term is there for that, and it is a rule of thumb.

### Meteor-shower dates against the IMO calendars

`tests/showers_reference.rs` computes every shower's start, peak and end from this
project's Sun (the instant the J2000 solar longitude reaches the table's value, Newton's
method to 0.01 s) and compares the UTC dates with Table 5 of the IMO's calendars
(`fixtures/reference/showers_reference.json`):

| year | peaks | starts and ends |
|---|---|---|
| 2026 | **32 of 32 on the IMO's date** | every one within 1 day (the acceptance) |
| 2027 | 32 of 32 on the IMO's date | printed, not asserted: the 2027 calendar revised two limits, the η Lyrids' start (3 May ours, 5 May IMO) and the Phoenicids' (30 Nov ours, 20 Nov IMO) |

The solar longitude itself: at the 2026 March equinox it is −0.366°, the precession since
J2000, within 0.01° (`showers::tests::the_solar_longitude_is_zero_at_the_march_equinox`).
Radiants are compiled values: `tools/starfield/showers.py` holds every peak radiant within
2° of the IMO's (the κ Cygnids excepted, 5.1°: the IMO's own Table 6 and the MDC put the
drifting radiant elsewhere on the peak date) and within 7.6° of the MDC's median radiant
moved along its drift to our peak; the three places where the sources disagree are
recorded in the manifest (the κ Cygnids' radiant, the Phoenicids' radiant and peak).

**Rates are estimates**, not validated: the activity profile (exponential from the peak
to `min(2, ZHR/2)` at the limits) is a rough shape, and `ZHR × sin(h) × r^(LM − 6.5)` is
the standard conversion from a zenithal hourly rate. Real rates vary from year to year;
showers the table flags `variable` can be far above or below their ZHR.

### Extinction, limiting magnitude and moonlight: published models, checked by hand

- Pickering's (2002) air mass: 1 at the zenith, 1.995 at 30°, 38.7 at the horizon,
  monotonic (`extinction::tests::pickering_air_mass_…`).
- Schaefer's (1990) NELM–sky-brightness relation: 21.0 mag/arcsec² gives 6.12 and 19.0
  gives 4.77 by hand; the inverse round-trips; the sky is capped at 22.0 mag/arcsec².
- Krisciunas & Schaefer (1991) moonlight: a full Moon 60° up, a target 30° away at 45°,
  k = 0.172, a 21.587 mag/arcsec² zenith: **3 189 nL added to 103.0 nL, 3.76 mag**, the
  value of a hand evaluation of their equations
  (`moonlight_matches_a_hand_evaluation_of_the_published_equations`).
- Bortle classes stand for the middle of each class's naked-eye range (Bortle 2001).

These check the implementation, not the sky: a real sky's extinction coefficient,
light domes and airglow vary, and the limiting magnitude is a person's, not a
measurement. The Sky view and the rankings use them as guides.

### The Milky Way outline

A picture, not a measurement: four isophotes of NASA COBE/DIRBE's 1.25 µm starlight,
weakened by the 100 µm dust so the dark lanes show, smoothed 1.5°, simplified on the
sphere to 0.2° (processing in `docs/THIRD_PARTY.md`). The build checks its galactic
coordinates against DIRBE's own pixel file (0.0006°). `milkyway::tests` hold the rings
closed and within range, and the glow where it belongs: the faintest level covers Cygnus,
the anticentre, Crux, Carina and the Sagittarius Star Cloud, and not the galactic poles,
Leo or the (masked) Large Magellanic Cloud; south of the dust lane toward the centre
(Baade's window) the glow reaches level 2. **Known limitation:** the dust screen darkens
the whole plane where the 100 µm emission is strong, so low-dust windows on the plane,
such as the Sagittarius Star Cloud (M24), come out darker in the brighter levels than the
eye sees them; 1.25 µm is not the visual band either.

### Star names

`tools/starfield/wgsn.py` joins the IAU WGSN list (641 names, 459 with an HR designation)
to the display catalogue by HR number and accepts a join only when the position (the live
table's or the 2022 file's) or the designation agrees: **458 joined** (the 459th, the
Blaze Star T CrB, is not in the display catalogue). **237 of the star field's 252 names
agree** with the WGSN (Al Na'ir, the Almanac's spelling, only as a spelling of Alnair), one
differs (Navi for γ Cas, which the WGSN calls Tiansi), and the other 14 are on stars the
WGSN has not named; ours are kept in every case. **220 names are added** (`names::tests`,
`tests/catalog.rs`).

### Speed and size

Release build, native, the fastest of repeated calls on the shared 8-core machine under a
load of about 34 (`tests/deepsky_timing.rs`): `tonight` **14.8 ms** (budget 50 ms),
`dso_list` 0.13 ms, `dso_visibility` 5.4 ms, `sky_search` 2.5 ms, `meteor_showers` 45 ms
for a year, 181 ms with an observer (32 nights).

The release WebAssembly module (`npm run wasm`) is **2 225 532 bytes raw, 922 137
gzipped** (`gzip -9`), against 2 060 798 and 849 019 for `main` at 28131c5: **+164 734
bytes raw (+161 KiB), +73 118 gzipped**, over the package's 80 KB budget and inside the
module's limits (2.5 MB, 1 MB gzipped). Embedded data is 31 931 bytes (`dso.txt` 19 017,
`names_wgsn.txt` 7 169, `milkyway.bin` 3 236, `showers.txt` 2 509); the rest is code,
largest first: search, showers, `tonight`, the night and place machinery, the DSO calls,
the adapter and the serialisation of the results.

### Reproduce

```
python3 -m tools.starfield.deepsky_fetch                  # network: raw inputs (git-ignored)
python3 -m tools.starfield.dso                            # table, fixture and checks
python3 -m tools.starfield.showers                        # table, fixture and checks
tools/reference/.venv/bin/python -m tools.starfield.milkyway
python3 -m tools.starfield.wgsn
cargo test -p skyfix-starfield -- --nocapture
cargo test --release -p skyfix-starfield --test deepsky_timing -- --nocapture
```

## 16. Tides

Owner: tides agent (expansion programme, work package P5). The engine is
`skyfix_tides` over the optional `tides-us` pack; the definitions are CONVENTIONS 13.11;
the wire format is EXPLORER_API "Expansion programme — tides"; the pipeline and what it
found are `tools/tides/README.md`. **These are predictions of the astronomical tide:
weather, storm surge and river flow change the real water level by more than every
number below, and NOAA's datums are those of the 1983-2001 epoch (sea level has risen
since at most stations).** The comparison is with NOAA's own predictions made from the
same published constants, so it measures the reproduction of NOAA's method, not the
tide.

### Against NOAA's own predictions, 20 harmonic stations × 30 days

`tests/noaa_fixtures.rs` against `fixtures/reference/tides_noaa.json` (NOAA CO-OPS
predictions API: high and low water and the hourly curve on MLLW, GMT, metres), built
from the constants NOAA publishes, embedded in the fixture as NOAA served them. Five
30-day windows from 2025-12-17 to 2027-12-19, including one across a new year and
one at each end of a year. NOAA rounds times to the minute and heights to the millimetre.

| station | tide | extremes | time worst | height worst | curve worst |
|---|---|---|---|---|---|
| Eastport, ME | semidiurnal, 5.5 m range | 116 | 0.57 min | 0.09 cm | 0.29 cm |
| Boston, MA | semidiurnal | 116 | 0.57 min | 0.08 cm | 0.16 cm |
| The Battery, NY | semidiurnal | 116 | 0.55 min | 0.06 cm | 0.11 cm |
| Sewells Point, VA | semidiurnal | 116 | 0.56 min | 0.05 cm | 0.08 cm |
| Wilmington, NC | semidiurnal, river | 116 | 0.59 min | 0.06 cm | 0.12 cm |
| Key West, FL | mixed | 116 | 0.60 min | 0.06 cm | 0.07 cm |
| Pensacola, FL | diurnal (F = 11) | 64 | 0.65 min | 0.06 cm | 0.07 cm |
| Grand Isle, LA | diurnal | 60 | 1.10 min | 0.05 cm | 0.06 cm |
| Galveston, TX | mixed, mainly diurnal | 90 | 0.60 min | 0.05 cm | 0.07 cm |
| Charlotte Amalie, VI | mixed, mainly diurnal | 74 | 0.77 min | 0.05 cm | 0.06 cm |
| San Diego, CA | mixed | 116 | 0.59 min | 0.07 cm | 0.12 cm |
| San Francisco, CA | mixed | 116 | 0.67 min | 0.07 cm | 0.12 cm |
| Astoria, OR | mixed, Columbia River | 116 | 0.59 min | 0.08 cm | 0.14 cm |
| Seattle, WA | mixed | 116 | 0.61 min | 0.08 cm | 0.20 cm |
| Juneau, AK | mixed, mainly semidiurnal | 116 | 0.61 min | 0.12 cm | 0.26 cm |
| Anchorage, AK | 9 m range, NOAA's 120 constituents | 116 | 0.67 min | **1.08 cm** | **1.38 cm** |
| Adak, AK | diurnal | 82 | 0.66 min | 0.07 cm | 0.10 cm |
| Unalaska, AK | mixed, mainly diurnal | 92 | 0.90 min | 0.07 cm | 0.10 cm |
| Honolulu, HI | mixed | 117 | 0.56 min | 0.06 cm | 0.07 cm |
| Apra Harbor, Guam | mixed | 116 | 0.56 min | 0.06 cm | 0.07 cm |

**All 2 087 extremes within 1.10 min (target 2 min) and 1.08 cm (target 5 cm); the
curve within 1.38 cm (target 5 cm).** Every extreme is paired both ways (none missing,
none extra). Outside Anchorage the agreement is at NOAA's own rounding (heights ≤ 0.12
cm, curves ≤ 0.29 cm). Anchorage's residual, 0.7 cm rms, sits in the diurnal band near
σ1 and 2Q1; no convention for those two (or for any other of the 83 extended
constituents tried) reduces it further.

The validation rules (`skyfix_tides::validation`) also allow, at a flat turn of the
tide, three times the time uncertainty that the rounding of NOAA's published constants
(1 mm, 0.1°) alone implies there; **no extreme needed that allowance**.

**Node factors: at mid-year, not at each instant.** With f and u evaluated at the
instant instead (`NodalMode::Instant`), the same comparison gives times up to 21.2 min
(Charlotte Amalie), heights up to 11.3 cm and curves up to 18.0 cm (Anchorage; 0.1-7.3
cm elsewhere). NOAA's predictions follow the mid-year convention (the test asserts the
difference).

### Six subordinate stations × 30 days

Hell Gate and Hudson, NY (ratio, from The Battery, +3 h and +7 h), Farmdale, FL (ratio,
from diurnal Pensacola), Haleiwa, HI (ratio), Security Cove, AK (additive, from Sitka),
Christmas Island (additive, from Honolulu): **644 extremes within 0.80 min and 0.57 cm.**
The curve between them is NOAA's cosine interpolation, an estimate labelled as such; NOAA
publishes no curve to compare it with.

### Every station: a 3-day sweep

`tests/pack_real.rs` against `fixtures/reference/tides_noaa_sweep.json` (NOAA's high and
low water for 2026-02-01 to 2026-02-03 at every station of its list): **3 492 stations,
39 120 extremes, all within 1.36 min and 0.99 cm**, every extreme paired both ways but
one: at Clear Lake, TX (8770933), a double high whose peaks differ by 1 mm, where NOAA's
table keeps one peak and ours the other (counted as a stand). NOAA refuses predictions
for 7 stations: 6 that the pack also cannot predict on MLLW (no constants, or no datums)
and 8661558, Holly Grove Plantation, which it lists with usable offsets; that one is
flagged `noaa_differs`. A debug build checks every 7th station (`TIDES_FULL_SWEEP=1` for
all).

### Schureman's printed tables

`tests/schureman_tables.rs`: I, ν, ξ, ν′, 2ν″ within 0.011° of Table 6; the speeds of
Tables 2 and 2a within 5 × 10⁻⁷ °/h; node factors within 0.0011 of Table 14 for
1990-1999 (0.004 for K2, L2 and OO1, 0.009 for M1, whose tabulated values were
interpolated from tables per 0.1° of I: under 0.2 mm of height at any station);
V0 + u within 0.16° of Table 15 for 1990-1997 (M1 within 0.5°).

### Speed

Release build, x86-64, natively (WASM is typically 1.5-3 times slower): a month of high
and low water 4.5 ms at Boston (34 constituents), 11 ms at Anchorage (120), 4.5 ms at a
subordinate station; a week's curve at 6 minutes 0.3-0.7 ms; the tide now 1.4 ms; the ten
nearest stations 1.3-3 ms; decoding the pack 18-22 ms (once). Target: a month in under
20 ms.

### Size

The pack: 344 543 bytes (0.34 MB, target ≤ 0.5 MB), 234 KB deflated. The tides code in
the core module (`npm run wasm`): +88 KB raw, +35 KB gzipped, measured on the programme's
base commit 28131c5 (2.06 MB / 849 KB before, 2.15 MB / 885 KB with tides).

### Reproduce

- `cargo test -p skyfix-tides -- --nocapture` (the sweep in full with
  `TIDES_FULL_SWEEP=1` or `--release`); `cargo test --release -p skyfix-tides --test
  perf -- --ignored --nocapture` for the timings.
- The data and fixtures: `tools/tides/README.md` (NOAA's API, about 4 800 requests,
  cached).

## 17. Planet detail

Owner: planetdetail agent (expansion programme P9). Engines:
`skyfix_almanac::{discs, rings, satellites, transits, conjunctions, earth_apsides,
orbits}` (definitions: CONVENTIONS 13.12; wire format: EXPLORER_API.md, "Expansion
programme — planet detail"). Every reference below is independent of the Rust code: JPL
Horizons, JPL's satellite ephemeris, NASA's transit catalogues and tables, USNO, Meeus's
worked examples and tables, and Skyfield 1.55 with JPL DE440/DE440s, all fetched and
computed by `tools/reference/gen_planetdetail.py` into
`fixtures/reference/planetdetail_*.json`. Everything here follows the planet provider's
apparent places (section 2, "Planets"): where a residual grows for Uranus and Neptune, it
is that provider's 2-3″, not the new code.

For the at-a-glance table: *Planet detail (discs and rings vs Horizons; Galilean moons vs
JPL; transits vs NASA and Skyfield; conjunctions and stations vs Skyfield, 1990-2060):
sub-points within 0.0005°, moons within 0.33″, transit contacts within 4.4 s of Skyfield
and within NASA's minute, 3 223 conjunctions and 2 300 stations one for one (stations
within 96 s) — targets 1″ (moons), 1 min (transits), 5 min (conjunctions, stations).*

### Discs and Saturn's rings against JPL Horizons

`tests/planetdetail_discs.rs`, 26 epochs per planet inside the coverage (33 for Saturn,
with its ring-plane crossings), Horizons' observer quantities for the Earth's centre.
Horizons evaluates a planet's rotation when the light left the sub-Earth point (the
light-time instant plus `R / c`); the engine does the same (without it Jupiter's
longitudes are 8.7″ off).

| quantity | Mercury-Mars | Jupiter, Saturn | Uranus, Neptune | test tolerance |
|---|---|---|---|---|
| sub-Earth longitude and latitude | 0.00003° | 0.00009° | **0.00047°** | 0.0003° / 0.001° |
| sub-solar longitude and latitude | 0.00006° | 0.00009° | 0.00045° | same |
| pole position angle | 0.00006° | 0.00005° | **0.0026°** (Uranus) | 0.001° / 0.005° |
| equatorial diameter | 1.1e-6 | 6e-7 | 4.1e-6 (relative) | 1e-5 |
| illuminated fraction | 0.0096 % | 0.0004 % | 0.0001 % | 0.015 % |
| defect of illumination | 0.0019″ (Venus) | 0.0002″ | 0.0001″ | 0.005″ |
| phase angle | 0.0089° | 0.0076° | 0.0068° | 0.012° |

Uranus and Neptune inherit the planet provider's 2.1″ and 2.7″ (a 2″ error in the planet's
direction moves the sub-Earth point by 0.0006°); Uranus's pole position angle is the
largest in 2028, near its solstice, when its north pole is 8° from the line of sight
(0.27″ from the disc's centre) and a small error in direction swings the angle. The
phase angle differs systematically by up to 0.009° because Horizons' Sun-target-observer
angle and ours treat aberration differently; illumination and defect follow it.

Saturn's rings (`saturns_rings_match_horizons`): `B` within **0.00003°**, `B′` within
**0.00002°**, `P` within **0.00005°** (tolerances 0.0003° and 0.001°). Meeus's example 45.a
(1992 Dec 16) is reproduced within 0.004° in `B`, `B′` and `ΔU` and 0.026° in `P` (his ring
pole is the 1980s', ours the IAU 2015; Horizons sides with ours), and his axes 35.87″ and
10.15″ exactly once his outer radius (136 117 km, NSSDCA's 136 780) is used.

Jupiter's central meridians (`jupiters_central_meridians_reproduce_meeus_example_43a`):
Meeus's example 43.a gives `DE` = −2.48° and `P` = 24.80°, ours −2.482° and 24.797°; his
System I and II values (268.06°, 72.74°) are for the illuminated disc and ours plus his
phase correction (0.43°) give 268.07° and 72.69°. System III is Horizons' (above).

Saturn's magnitude: `magnitude` is the explorer's (Mallama & Hilton 2018, as the planet
provider), `magnitude_aa1984` the 1984 Astronomical Almanac formula (Meeus 41) for
comparison with printed almanacs. Over 1990-2060 (every 10 days) the explorer's minus the
1984 formula runs from −0.13 to +0.07.

### Galilean moons against JPL's satellite ephemeris

`tests/planetdetail_galilean.rs` against Skyfield with excerpts of JPL's `jup365.bsp` on
DE440 (target 1″).

| moon | offset from Jupiter, worst (15 instants, 1995-2058) | phenomena, worst (2026) | edges |
|---|---|---|---|
| Io | **0.096″** | **23 s** | 183 |
| Europa | **0.237″** | **46 s** | 88 |
| Ganymede | **0.270″** | **97 s** | 45 |
| Callisto | **0.323″** | **68 s** | 20 |

The phenomena are every start and end of the moons' transits, shadow transits,
occultations and eclipses in two 20-day windows of 2026 (January, around opposition, and
April): **all 336 found one for one**, none extra. Jupiter's pole position angle agrees
within 0.00003°, its apparent radius within 9e-6, the Earth's jovicentric latitude within
0.00003°, and every flag (in transit, occulted, eclipsed, shadow on the disc) at every
instant except within 3 % of a limb. The times are E5's own error along each orbit: a
moon's 0.1-0.3″ is 20 s to 1.5 min at the speed it crosses a limb, and Ganymede runs 70-97 s
early throughout 2026 (a steady offset, not noise). Tolerances in the test: 45 s, 60 s,
120 s, 120 s.

### Transits of Mercury and Venus

`tests/planetdetail_transits.rs`.

- **Against Skyfield + DE440s with the same definitions** (the Sun's 959.63″ at 1 au,
  IAU radii): the 12 transits of 1990-2060, 60 contacts, worst **4.4 s** (contact II of
  Mercury's near-grazing transit of 1999, where the timing is ill-conditioned; **0.049″**
  as a separation error); least separations within **0.041″**.
- **Against NASA's catalogues** (Espenak): the same 12 transits, none missing or extra.
  Contacts within 82 s, **53 s** after removing the difference between NASA's
  extrapolated ΔT and ours (the catalogue prints UT to the minute, so up to 30 s is its
  rounding); durations within 40 s; least separations within 0.08″ (target 1 min).
- **NASA's 2004 and 2012 contacts to the second**: within **5.1 s**, position angles
  within 0.43° (NASA's Venus is slightly larger than the IAU radius).
- **Local circumstances**, NASA's city tables (13 cities in 2004, 11 in 2012): 101
  contacts within **5.7 s**, the Sun's altitude within 0.52° of the tables' whole
  degrees (target 30 s).

### Conjunctions and stations

`tests/planetdetail_conjunctions.rs` against Skyfield + DE440s: every local minimum of the
apparent separation under 6° of the 21 planet pairs and 28 planet-star pairs over
1990-2060 and of the Moon with the planets and the four stars over 2020-2030, and every
station of Mercury to Neptune in both coordinates over 1990-2060. Closest approaches with
either body within 1° of the Sun are left out on both sides: Skyfield applies the formula
for light passing the Sun to a body behind it, where it diverges (3″ for Uranus on
2028-05-30, a spurious minimum against Aldebaran).

- **3 223 closest approaches matched one for one, none missing or extra.** Timing within
  **295 s** (target 5 min), separations within 0.00043° (1.5″, Mercury-Neptune) and the
  position angle within 2.3″ sideways, each inside the two bodies' own accuracy (the Moon
  1.2″, Mercury to Mars 0.3″, Jupiter and Saturn 0.6″, Uranus 2.1″, Neptune 2.7″, stars
  0.1″). 24 slow pairs are more than 5 minutes out, all explained by those accuracies: a
  pair closing at 160″ a day (Jupiter and Uranus in 2038) moves its minimum by 18 minutes
  for Uranus's 2″, so the test converts such a difference into position along the track
  (worst 2.2″, Neptune-Aldebaran in 2060, 27 minutes).
- **2 300 stations matched one for one**: Mercury within **4.6 s**, Venus 13 s, Mars 18 s,
  Jupiter 13 s, Saturn 17 s, Uranus 48 s, Neptune **96 s** (target 5 min). A planet near
  a station barely moves, so its position error becomes time: 96 s is Neptune's 2.7″.
- The interpolants (Chebyshev fits of each body's ICRS direction, precession-nutation
  put back exactly at every evaluation) follow the providers within 1e-5″ in position and
  6e-5″/day in the longitude's rate (`fits_follow_the_providers`); they are why a year's
  search is fast.

### The Earth's perihelion and aphelion

`tests/planetdetail_apsides.rs` (target 10 min): against Skyfield + DE440s (149 events,
1990-2060) within **1.06 min** and 2.3e-8 au; against USNO's seasons tables (142 events,
to the minute) within **1.6 min**; against Meeus's table 38.C (40 events, 1991-2010,
from the complete VSOP87) within **0.51 min** and 4.8e-7 au. The Earth's centre, not the
Earth-Moon barycentre, as USNO and Meeus give it, from the Sun provider's series: the
minimum is flat (740 km a day squared), so a 1e-8 au wobble moves it by a minute, and the
planet provider's more deeply truncated Earth put it up to 5 minutes out.

### User-supplied orbits

`tests/planetdetail_orbits.rs` against Skyfield's `mpc` module (the same two-body model):
six minor planets (Ceres, Vesta, Eros, Icarus, Apophis, Bennu) and six comets (2P, 12P,
29P, C/2023 A3, C/2024 G3 with e = 1.000009, C/1995 O1) at the epoch −60, 0, +30 and +200
days: **48 positions within 0.058″** on the sky and 2.3e-7 in distance (target 1′). This
checks the parser and the propagator, not the physics: unperturbed elements drift from the
real orbit within weeks to months (more for near-Earth objects and comets passing
Jupiter), which is why every result past 30 days from its epoch carries a warning
(`stale_elements_are_flagged`). The MPC's packed numbers, designations and dates are read
as its documentation's own examples say (unit tests in `orbits.rs`).

### Speed

Release build, x86-64, the shared 8-core machine, thread CPU time: `galilean_moons`,
`saturn_rings`, `planet_disc` and one custom body under a millisecond; a month of Galilean
phenomena 85 ms (at a load average of 25); transits of 1990-2060 0.24 s (0.31 s with an observer); a year of
conjunctions with the default bodies **216 ms** at a load average of 4 (251 ms with an
observer; target 300 ms, `a_years_search_is_fast`, which fails with the load named when
the machine is busy: 372 ms at a load of 30); a year of stations about 150 ms; the
Earth's apsides for a year 18 ms. Most of it is the providers (a planet 40 µs, the Moon
42 µs, the Sun 23 µs).

### Size

The package adds **191 KB raw and 77 KB gzipped** to the core module (`npm run wasm`),
measured by building with and without `skyfix_wasm::planetdetail` on main as of 3f4fe4e
(2 806 595 / 1 154 399 bytes without, **2 997 407 / 1 231 646 with**: inside the revised
budget of 3 MB / 1.25 MB, with 2.6 KB of raw headroom). It is code: E5, the searches, the
MPC parser and the serialisation of eleven calls. The fits and Brent's searches are
compiled once each through `dyn` calls rather than once per closure (18.8 KB raw, 8.2 KB
gzipped saved; each call costs an ephemeris evaluation, so the dynamic dispatch is free);
on the base commit 28131c5 the package measured 214 KB / 87 KB before that.

### Reproduce

- `tools/reference/.venv/bin/python -m tools.reference.gen_planetdetail --part all`
  regenerates the six fixtures (`--part horizons|galilean|transits|conjunctions|apsides|
  orbits` for one; Horizons, NASA, USNO, the MPC and NAIF need the network; the jup365
  excerpts are cached in `tools/reference/data/planetdetail/`; the conjunctions take about
  nine minutes).
- `cargo test --release -p skyfix-almanac --test planetdetail_discs --test
  planetdetail_galilean --test planetdetail_transits --test planetdetail_conjunctions
  --test planetdetail_apsides --test planetdetail_orbits -- --include-ignored --nocapture`
  prints every number above (the 1990-2060 conjunction and station runs and the timing
  are `--ignored` in the default run, which covers 2024-2026 and 2019-2030).

## Charts: what the Sun, Tides and Moon charts compute themselves (charts2 agent, expansion programme Q5)

Every number on the Sun, Tides and Moon charts is an engine's (sections 9, 14, 16 and "Moon in
detail"): `sun_path`, `analemma`, `rise_set_azimuths`, `equation_of_time`, `solar_day`,
`solar_year`, `day_events`, `sky_state`, `sample_bodies`, `moon_apsides`, `tide_predict`,
`tide_extremes` and `tide_stations_near`. The charts compute only these on top of them,
checked against the engine in `web/test/next/charts-real-engine.test.ts` (runs when the
WebAssembly package and the `tides-us` pack are built; `--reporter=verbose` prints the
figures) and with the mock engine in `charts-sun.test.ts` and `charts-tides-moon.test.ts`:

| what the chart does | against | worst |
|---|---|---|
| the tide height under the moving cursor, read off the 6-minute predicted curve (the cubic through the four nearest samples) instead of calling `tide_now` every frame | `tide_now` at 97 instants of a day and 157 of a week, at Anchorage (9455920, range about 9 m), Boston and San Francisco, 2026-09-24 | **0.02 mm** (Anchorage), under 0.01 mm elsewhere |
| the rate of rise under the cursor, the same cubic's slope | `tide_now`'s rate | **0.09 cm/h** (Anchorage) |
| the Moon at one hour through the year: `sample_bodies`, one exact sample a day, in two or three runs a year (a clock change starts a run) | `sky_state` at the same instants (Philadelphia, 21:00, 2026) | **0.72″**: a run takes the Earth's rotation (DUT1) at its middle (EXPLORER_API `set_dut1`); displayed to 0.1′ |
| the sun path's whole hours on the local clock | the engine's own samples (identical values) | exact |
| sunrise and sunset bearings through the year, drawn from the Year chart's shared `day_events_batch` (one computation for both charts) | `rise_set_azimuths` for the same year, event by event (Philadelphia, 2026) | **0.014 s, 0.005″**: the year-long call takes one DUT1 for the year, the batch each day's |

Drawn but never shown as a number: the sun path's crossing of the horizon between two
10-minute samples (linear; the rise and set shown are the event finder's), and the
analemma's sky projection (stereographic, a picture only). The solar panel's energy is the
engine's clear-sky estimate and is labelled as one everywhere, with the model's typical
error (section 14); the tides are labelled "predicted, not observed" everywhere.

Speed: the developer page's bench (`web/src/next/charts/dev/screenshots.mjs bench`,
headless Chrome, WebAssembly, the median of six warm runs after a cold first one). The
shared machine was under a load average of about 40 on 8 cores, so the numbers are
comparable with each other and with the existing Year chart in the same run, not in
absolute terms:

| chart (engine work) | warm median (first) |
|---|---|
| Year chart, for comparison (`day_events_batch`, 365 days) | 420 ms (657) |
| Sun path (`sun_path`, `day_events`, `sky_state`) | 67 ms (77) |
| Analemma (`analemma`, a year) | 188 ms (242) |
| Sunrise bearings | shared with the Year chart: nothing more once it is drawn |
| Equation of time (a year) | 141 ms (65) |
| Solar panel (`solar_year` with the best-tilt search) | 273 ms (377) |
| Moon through the year (`sample_bodies`, 365 exact samples) | 157 ms (126) |
| Perigee and apogee of a month (`moon_apsides`) | 213 ms (305) |
| Tides, a day / a week | 20 ms / 35 ms |

Every year chart is at or under the Year chart's own cost (the solar panel at about 0.65 of
it), computes once per place, year and setting, runs after the time settles while the time
bar is dragged, and is kept for the page's lifetime; nothing heavier than a cursor moves per
frame.

## Interface: calendars, the clock's scale and the ΔT chip (time-ui agent, wave 2)

The explorer's own calendar arithmetic (`web/src/next/time/civil.ts`, used by every date on
screen) is exact integer arithmetic, held to the engine rather than to JavaScript's `Date`:

- `web/test/next/time-civil.test.ts`: the Julian and Gregorian day numbers of the built
  package's `calendar_convert` agree on 1 821 days over −2000..3000 (every 1 009th day, the
  seven days around the 1582 reform, 29 February of 1 BC and of 1600, 28 May 585 BC; both
  ways, both calendars); every
  day of 2000 BC to AD 3000 round-trips in both calendars; JavaScript's proleptic Gregorian
  `Date` agrees on every 97th day of the years 0-9999; the mock engine's calendars agree on
  every 211th day. The years −584, 0, 99, 1066 and 12345 go wall clock → wire string → back
  unchanged (the `Date.UTC` traps of the accuracy audit).
- `web/test/next/time-tiers.test.ts`: the clock's scale (UTC 1972-2035, UT outside) and the
  display calendar agree with the built package's `time_info` at 231 instants over
  −2000..3000 and at the four instants either side of the scale's boundaries.

What the chip shows is the engine's `time_info.delta_t_sigma_s` (section 14 above), rounded
for reading (±s below 90 s, ±min below an hour, ±h above); it is not a new estimate.

## 18. The Selected card's tools for photographers and astronomers (photo agent, expansion programme Q8)

The card shows the engines' numbers and formats them; each is validated in its engine's
own section: golden and blue hour, bearing crossings, alignments and the galactic centre
(section 14, "Sun tools"), the Moon's libration, size, apsides and named features (section
14, "Moon in detail"), the magnetic variation (section 15), tides (section 16), the
predicted sextant reading (section 10), right ascension and declination (`sky_state`,
section 2). What is new here is checked below. Tests: `web/test/next/photo-tools.test.ts`
(logic, with the mock engine) and the `photo` set of `web/scripts/ui-check.mjs` (the built
site in Chrome, with the real core).

### A bearing picked on the map

The direction from the place to a clicked point is the initial azimuth of the geodesic on
WGS84 (CONVENTIONS 13.13), by Vincenty's inverse formula. Against Geoscience Australia's
worked example of that formula (GDA technical manual: Flinders Peak to Buninyong, GRS80,
whose flattening differs from WGS84's by 5 × 10⁻¹²): distance 54 972.271 m reproduced
within 1 mm, forward azimuth 306° 52′ 05.37″ and reverse azimuth 127° 10′ 25.07″ each
within 0.5″ ("reproduces Geoscience Australia's worked example"). Points almost antipodal,
where the iteration does not converge, fall back to the sphere's great circle (up to about
0.2° off), and the code says which it used. The ray drawn on the map is the sphere's great
circle leaving on the bearing: display only.

### End to end: Manhattanhenge

The alignment finder in the built site, with the real core, gives the days the engine's
own tests give (section 14): at 42nd Street and Fifth Avenue, bearing 299°, sunset
(upper limb on a sea-level horizon), 0.5° either side, 2026: 23-26 May and 16-19 July,
closest 24 May and 18 July (`ui-check.mjs`, "the alignment finder gives Manhattanhenge
2026"). With the centre at an apparent 0.5° (the centre at 0° without refraction, to 1′)
the closest days are 28 May and 14 July, the first the American Museum of Natural History's
"half Sun" date.

### Speed

Measured in headless Chrome on the development build of this branch after the merge of
time-ui, charts2 and planetdetail (a temporary timer around the card's render, since
removed), every drawer open, 200 steps of the time shown by 2 minutes, each run three times
over the same steps and the fastest of the three kept for each step (the machine is shared
by several agents; this removes the moments the page was not scheduled at all, which
single runs showed as 95th percentiles of 15-40 ms even for a star with nothing heavy to
do). The card's render: the Moon 1.7 ms at the median, 2.6 ms at the 95th percentile,
3.8 ms at worst (1.4 / 2.0 / 4.6 ms with 30-minute steps); the Sun 0.8 / 0.9 / 1.1 ms;
Jupiter, with its disc, 0.8 / 1.1 / 2.4 ms; Sirius 0.5 / 0.8 / 6.0 ms. Inside the 5 ms budget
of a time-bar frame. What costs more is asked once per span and, while the time is dragged
or playing, only once it settles (`Motion`, `Settler` in `panel/photo.ts`): `sun_hours`
about 3 ms a day, `moon_features` 4 ms an hour, `moon_orientation` 1 ms a quarter-hour,
`planet_disc` under a millisecond a quarter-hour, `moon_apsides` 22 ms plus 1 ms a day (a
fortnight's list), a month of `galactic_centre_windows` about 0.1 s, `alignment_days`
0.2 s (the Sun) and 0.9 s (the Moon) only when Find is pressed (WebAssembly in Node, V8).
In the built site, before the merge and on a quiet machine, the open drawers added 0.3 to
1 ms of script to a time-bar frame (the least of three drags each); `ui-check.mjs` judges
this only when a star's frame alone stays under 16 ms, since other work on a shared machine
otherwise sets the numbers.

### Labels

Golden and blue hour are photographers' conventions and say so; tide heights say
"predicted, not observed" and carry NOAA's label; the magnetic bearing's tooltip gives the
model and its own one-sigma uncertainty, and there is none before 1900 or after 2030; the
predicted sextant reading is offered only for the bodies and years sights are offered for,
and assumes the standard 10 °C and 1010 hPa for refraction.

## 19. Lunar limb: limb-corrected eclipse contacts (expansion programme P12)

Owner: eclipselimb agent. The engine is `skyfix_almanac::eclipses::limb` (definitions in
CONVENTIONS 15.7), fed by the optional `lunar-limb` pack (LRO LOLA LDEM_16, 1/16°, about
1.9 km; `docs/THIRD_PARTY.md`, "Lunar limb profile"); wire format in EXPLORER_API
"Expansion programme P12 — the lunar limb". Without the pack every eclipse result is the
mean limb's (section 12), unchanged. The tests are `crates/skyfix-almanac/tests/eclipse_limb.rs`
(numbers below with `-- --nocapture`), `crates/skyfix-wasm/src/limb.rs` and
`web/test/next/limb-engine.test.ts`.

**What the correction does.** The mean limb (NASA's `k2 = 0.272281`, a radius chosen to
stand for the limb's valleys) gets second and third contact of a total eclipse within a
few seconds; the real limb decides them through the particular valley where the last
sunlight goes out. For an annular eclipse the error of a smooth Moon is larger, because
the highest peaks end and begin annularity: the mean limb's annularity was 7 to 18 s too
long at the 19 cities of 2023-10-14, the corrected one within 1.5 s of NASA's.

### The profile against one built from the raw grid with NAIF's orientation

`tools/limb/reference.py` rebuilds the outline independently: Skyfield 1.55 with DE440s
and its IERS time scale, the Moon's orientation from NAIF's DE440 lunar kernel
(`MOON_ME_DE440_ME421`) at the light's departure, heights bilinear from the raw LDEM_16
grid (not the pack's ring). At the maxima of three eclipses (Dallas and Burlington 2024,
Albuquerque 2023), over all 5 760 position angles: **rms 0.022-0.027″ (42-45 m), mean
−0.015 to −0.018″ (−29 m: the ring's second interpolation rounds the sharpest crests
off), worst 0.11-0.17″**. This checks the geometry, the frame (the model's orientation
against DE440's, 0.005° per section 14), the ring and its decoder at once.

### Contacts against the independent implementation

The same 51 sites (below), every contact the independent code finds (204):

| | 2024-04-08 (total, 32 sites) | 2023-10-14 (annular, 19 sites) |
|---|---|---|
| contacts, away from grazes | within 0.29 / 0.72 / 0.66 / 0.40 s (c1 / c2 / c3 / c4) | within 0.35 / 0.61 / 0.41 / 0.55 s |
| limb minus mean-limb correction, same | within 0.21 / 0.34 / 0.12 / 0.11 s | within 0.16 / 0.20 / 0.22 / 0.11 s |
| near grazes (over 8 s per ″ of limb) | 4 contacts (San Antonio, Toledo, Lancaster) within 0.13″ of limb | none |

The absolute differences are the engine's Moon (ELP 2000-82B) against DE440s, 0.2-0.7 s
at a contact (section 12); the correction cancels most of it. San Antonio in 2024 is at
the southern edge of the path: the mean limb misses totality there, both implementations
find it with the limb (14.6 s here, 11.8 s independently, 18 s by NASA).

### Second and third contact against NASA's Scientific Visualization Studio

NASA SVS published limb-corrected times of the start and end of the central phase, to the
second, for U.S. cities (item 5073; LOLA and SELENE topography at 60 m, SRTM terrain,
DE421). 32 cities in the path of totality of 2024-04-08 (Eagle Pass to Presque Isle) and
19 in the path of annularity of 2023-10-14 (Eugene to Kingsville), with the engine as
shipped (DUT1 from the IERS history). Corrected minus SVS, sites away from grazes:

| | 2024 (29 cities) | 2023 (19 cities) |
|---|---|---|
| second contact | mean −0.10 s, worst 1.08 s | mean −0.44 s, worst 1.16 s |
| third contact | mean −1.35 s, worst 3.22 s (Fort Worth; Dallas 2.45 s) | mean −1.47 s, worst 2.06 s |
| both within 2 s | 27 of 29 | 18 of 19 |
| central phase | −1.25 s on average, worst 4.3 s | −1.03 s, worst 1.54 s |
| scatter about SVS, c2 / c3: corrected | 0.44 / 0.57 s | 0.33 / 0.35 s |
| the same for the mean limb | 1.54 / 1.22 s | 1.16 / 3.16 s |

Near grazes (the edge of the path, where a contact moves by more than 8 s per ″ of limb
height): San Antonio 2024, second contact −1.2 s and third −4.6 s (a 15 s totality
against SVS's 18 s); Toledo, third −3.3 s; Lancaster NH, third −7.2 s (39 s against
SVS's 46 s). Each contact reports this sensitivity (`seconds_per_arcsec`) so the
interface can say so.

**Third contact is systematically early against SVS, and it is not our limb.** The
independent implementation shows the same: second contact +0.26 s and +0.04 s from SVS,
third −1.38 s and −1.16 s (2024, 2023). SVS's central phases are 1.0-1.6 s longer than
the geometric ones for the total eclipse *and* the annular one; a larger Moon or a smaller
Sun would lengthen one and shorten the other, and a higher-resolution limb (SVS's 60 m)
has deeper valleys and higher peaks, which would shorten both. What remains is SVS's own
definition, not published: its times are "100 % points of coverage", to the whole second
(its umbra shapes are computed at one-second steps), with a Delta-T it does not state. If
its central phase is rounded outward to whole seconds and its times run 0.6-1.0 s later
than ours throughout (half a second of Delta-T would do that), both eclipses fit to about
0.3 s; we cannot confirm it. So the brief's criteria — second and third contact within
2 s, the corrections within 1 s — hold for second contact everywhere and for third
contact at 45 of 48 sites away from grazes, with a 1.4 s mean offset in third contact
that we attribute to SVS's definition; the scatter about SVS after the correction is
0.3-0.6 s, between a half and a ninth of the mean limb's.

### Baily's beads

Approximate by construction (CONVENTIONS 15.7): the valleys of a 1.9 km model, at most 8
per contact within 15 s, the last before second contact and the first after third being
the contact's own valley (tested). At Indianapolis in 2024 the model gives eight beads in
the last 1.5 s before totality, between position angles 27° and 40° on the Sun, and
eight in the first 0.6 s after it, between 247° and 254°. Real beads come through
valleys a few hundred metres wide that LDEM_16 does not resolve, and they last longer
than the model's (which go out within a second or two, the smoothed valleys being
shallow): the times and places are those of the main valleys, not bead-level
predictions, and the output says so.

### Speed and size

Measured on the development machine while other agents' builds kept it busy (load
average 15-40 on 8 cores throughout): the plain `eclipse_local`, 1.2-1.7 ms natively and
3-5 ms in WebAssembly on a quiet machine (section 12), took 1.8-4.3 ms and 6-8 ms. Thread
CPU time:

- **Natively** (release build): decoding the pack 10-25 ms; one eclipse with the limb
  25-58 ms (about 5 500 slices of about 42 samples: the outline at maximum every 1/8°,
  the windows around the four contacts every 1/16°); `profile_at` (5 760 slices) 20-52 ms.
- **WebAssembly** in Node 24 (V8, Chrome's engine; `web/test/next/limb-engine.test.ts`
  and the scripts beside it), three builds: the first `load_pack("lunar-limb", …)` 84-111
  ms, run in the engine's baseline code (42-56 ms once compiled; loading the same file
  again, which only checks its header and CRC-32, 8-9 ms); the first corrected eclipse
  90-98 ms, later ones 63-75 ms; `lunar_limb_profile` 53-63 ms.

Scaled by the plain `eclipse_local`'s slowdown on that machine (1.4-2 times), a quiet
machine takes 45-80 ms for the first load and 45-70 ms for the first corrected eclipse,
35-55 ms for each one after: each within the brief's 100 ms, the two together about 100-
150 ms the first time a page corrects an eclipse. The pack is loaded once per page
session (CONVENTIONS 15.5) and a view asks for a corrected eclipse once per place (the
memoised engine keeps it). Not yet measured on a quiet machine or in a browser.

**Size.** The pack: 2 212 290 bytes (2.21 MB), 1 659 278 gzipped (1.66 MB; the target
was 3 MB gzipped, and the brief's estimate of 4.4 MB raw for int16 heights came down with
the byte code); decoded, 4.4 MB of heights and 1.1 MB of block maxima in memory. The
core module (`npm run wasm`): +45.3 KB raw, +20.7 KB gzipped against main at ab8f55c
(2 997 407 → 3 042 660 bytes, 1 231 646 → 1 252 306 gzipped). Main alone is 2.6 KB under
the 3 MB raw budget, so with the lunar limb the module is **42.7 KB over it, and 2.3 KB
over the 1.25 MB gzipped one**: a decision for the planner (EXPANSION_PLAN §3 lists the
measured levers; `opt-level = "z"` alone saves about 5 %).

### Reproduce

- `cargo test --release -p skyfix-almanac --test eclipse_limb -- --nocapture` prints
  every number above; `-- --ignored timing` the native timings.
- `cd web && npm run wasm && npx vitest run test/next/limb-engine.test.ts` loads the
  shipped pack into the built core and times it.
- The pack: `python3 -m tools.limb.fetch && tools/reference/.venv/bin/python -m
  tools.limb.build` (bit-identical). The references: `tools/reference/.venv/bin/python -m
  tools.limb.reference svs skyfield` (about 20 minutes).

## 20. The Sky view's astronomy layers (sky2 agent, expansion programme Q3)

Display only (CONVENTIONS 13.6): nothing on the Sky view reaches a sight, and every
estimate it shows (the magnitude limit, extinction, a deep-sky object's best time and
instrument, meteor rates, the ranking) is the deep-sky engine's, labelled on screen as an
estimate (the "Deep sky" section). What the view computes itself is geometry, and each piece is held
to the engine that it rests on by a test in `web/test/next/sky2-layers.test.ts` and
`sky2-render.test.ts`:

| what the view computes | held to | how close | test |
|---|---|---|---|
| deep-sky objects' places | `dso_list`'s apparent places of date (the engine's), carried to the horizon by the stars' own rotation and refraction | the same numbers (1e-9°) | "places the catalogue by the engine" |
| the Moon close-up: every named feature on the disc | `moon_features`' `DiscPoint` (east, north and the zenith-up x, y) | 1e-9 disc radii, 150 features, 3 dates, geocentric and from Philadelphia | "places every named feature where moon_features does" |
| when a star, deep-sky object, radiant or marked point rises (the card) | a brute-force rotation of the sky; the engine's `day_events` rise for Vega | 10 s; 1 min | "matches the rotating sky", "agrees with the engine's rise times" |
| extinction toward the horizon | the engine's `extinction_table`, relative to the zenith: `k (X − 1)` with Pickering's (2002) air mass | 1e-4 mag at 10° | "dims by the engine's air mass" |
| the Milky Way's glow | the engine's isophote rings, filled on a 0.5° grid in galactic longitude and latitude and blurred with σ = 1° | the rings' edges are straight in (l, b): within 0.1° of the great-circle arcs, every ring lying within 28° of the galactic equator; the engine's dust lane (0.25) and Sagittarius cloud (above 0.9) come out where they are | "fills the engine's Milky Way", "fills a band … whichever way the rings run" |
| a meteor radiant between its start, peak and end | the engine's instants and its drift per degree of solar longitude | λ☉ interpolated linearly in time: within 0.05°, so the radiant within 0.1° | "interpolates the solar longitude", "drifts the radiant" |
| a camera's field | `2 atan(w / 2f)` (a rectilinear lens) | exact; 50 mm on full frame is 39.6° × 27.0° | "works out a camera's field" |

Left out on purpose, and said where it matters: the Milky Way raster is not refracted (0.6°
at most, on the horizon, under one texel); the view's star limit does not include the
Moon's light (the estimates on the cards do); galaxies are drawn level because the
catalogue has no position angles; Saturn's shadows on its rings and the rings' on it are
not drawn, and Jupiter's belts are drawn where they usually are (the Great Red Spot is not
tracked: section 17).

### Speed

The budget (brief Q3): 9 000 stars plus the deep-sky objects and the Milky Way in 10 ms a
frame; a search under 5 ms. What costs what, per frame: the stars' dimmed magnitudes and
the per-frame grouping by them (a counting sort over the stars on screen), the 213
deep-sky objects' rotation and projection, and the Milky Way's raster, remade only when
the sky has turned half a degree to a degree (under one of its texels; every second to
fourth frame while time plays at an hour a second; at most ten times a second faster than
a week a second) and drawn scaled up in one `drawImage`. The Milky Way's grid is filled once per page, away from the frame (about 10 ms).

Measured on 2026-09-25 on a machine running seven other agents' builds (load average 28
on 8 cores), so the figures are upper bounds: with the WebAssembly core in Node (V8, the
browser's JavaScript engine), a frame's JavaScript — the engine's calls, every star's
place, extinction and grouping, the deep-sky pass, the raster and building every path
the canvas fills, against a context that paints nothing — takes 5.55 ms for the view
without the new layers and 7.08 ms with all of them, the raster remade every frame (the
fastest frame of 80, in eight interleaved runs of ten; 9 095 stars, a 1 440 × 840 dome);
the raster alone 0.83 ms. In the browser pane (a real GPU, the same loaded machine) the
whole frame, painting included, was 9.7 ms at the median without the new layers and
11.2 ms with them. So the layers add about 1.5 ms to a frame; the view before them was
built to draw 9 000 stars in 8 ms (EXPLORER_PLAN §3.7), which with the layers is 9.5 ms,
inside the 10 ms budget, but that absolute figure could not be measured on this loaded
machine and is in the backlog to confirm on a quiet one. `sky_search`, the fastest of 20:
5.3 ms in Node and 6.4 ms in the browser under that load; the engine's own native timing
is 2.5 ms (the "Deep sky" section, "Speed and size"), and the search box asks after
typing pauses (80 ms), never during a frame.

