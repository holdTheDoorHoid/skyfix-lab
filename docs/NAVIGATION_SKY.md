# Moon and planet sights, lunar distance and tonight's sights

**Owner:** the navigation-Moon agent (explorer wave 2, work package I2). **Status:**
implemented and validated; numbers below are from the tests named beside them. The rules
themselves are normative in [`CONVENTIONS.md`](CONVENTIONS.md) (sections 1, 5, 7 and
13.1); the wire format is [`EXPLORER_API.md`](EXPLORER_API.md), "Wave 2 — Moon and
planet sights".

This page explains, in plain words first, what the project now does with the Moon and
the four navigational planets:

1. [Sights of the Moon and the planets](#1-sights-of-the-moon-and-the-planets) — the
   corrections a sextant reading needs, and how each was checked.
2. [The clock term](#2-the-clock-term) — why a Moon sight is not a star sight when the
   watch is wrong.
3. [What the sextant will read](#3-what-the-sextant-will-read) — predicted readings.
4. [Lunar distance](#4-lunar-distance) — Greenwich time from the Moon.
5. [Tonight's sights](#5-tonights-sights) — the twilight planner.
6. [Known gaps](#6-known-gaps).

## 1. Sights of the Moon and the planets

### In plain words

A sextant measures the angle between a body and the horizon. Before that angle can be
compared with the almanac it has to be corrected for the instrument (index error), the
height of the eye (dip), the air bending the light (refraction), which edge of a disc was
used (semidiameter), and the fact that the observer stands on the Earth's surface rather
than at its centre (parallax). Stars need only the first three. The Sun needs all five,
but its parallax is tiny. **The Moon is different:** it is so close that the observer's
position shifts it by up to a whole degree — sixty nautical miles of error if ignored —
and its disc looks slightly bigger the higher it stands (it is nearer to you then). The
planets have a small parallax (Venus up to half a minute of arc) and Venus, which shows
phases like the Moon, is measured at the centre of its *light*, not the centre of its
disc.

### The rules (CONVENTIONS section 5)

| body | semidiameter | parallax in altitude |
|---|---|---|
| Sun | geocentric SD by limb | `HP cos(Ha)` (unchanged) |
| Moon | **augmented** SD by limb: `sin SD' = sin SD / (sqrt(1 − sin²HP cos²h) − sin HP sin h)` | `asin(sin HP cos h)`, `h` the topocentric altitude of the centre |
| Venus, Mars, Jupiter, Saturn | none (centre of light) | `asin(sin HP cos h)` |
| stars | none | none |

The body class comes from the name (`skyfix_core::corrections::sight_body`); a sight's
chain is `corrections::correct_sight`. The original `corrections::correct` keeps its
contract (Sun or star), so every existing result is bit-for-bit unchanged.

Decisions, and why:

- **The Moon's parallax uses the altitude of the centre after refraction and the
  semidiameter**, not the apparent altitude: the latter is up to 0.2′ wrong for the
  Moon. The sine form is exact on the project's spherical Earth; `HP cos h` would be
  0.001′ short.
- **A Moon sight without a horizontal parallax is refused**, not warned: the error would
  be up to 61′. (The Sun's missing HP stays a warning; it is worth 0.15′.)
- **Venus at its centre of light, in its direction.** The Nautical Almanac's explanation
  says: "The phase correction for Venus has been incorporated in the tabulations for GHA
  and Dec, and no correction for phase is required. The additional corrections for
  Venus and Mars allow for parallax." USNO's online data does the same ("corrected for
  phase, as in the Nautical Almanac, assuming the center of light is observed"). So the
  planet provider used for sights (`skyfix_ephemeris::sights::SightPlanetProvider`, part
  of ephemeris mode `auto`) moves Venus toward its bright limb by
  `0.44 × (1 − cos i) × SD` (`i` the phase angle, up to 0.4′ for a crescent). The
  *form* is the centroid of a uniformly bright crescent, `4/(3π) × (1 − cos i)`; the
  *coefficient* 0.44 was measured against twelve USNO responses (0.4403, see
  [section 1, validation](#validation)). A Venus direction typed from the Almanac
  therefore means exactly what the provider computes. Mars's phase moves its light by
  under 0.01′, and USNO does not apply it; neither does this project.
- **The planets' parallax is applied to all four.** It is the Almanac's "additional
  correction" for Venus and Mars; for Jupiter and Saturn it is under 0.04′, which the
  Almanac omits.
- **A limb on a planet is ignored with a warning**, exactly as for a star.
- **Mercury, Uranus and Neptune are not offered for sights** (CONVENTIONS 13.1); the
  sight provider refuses them with a sentence saying so. With a supplied direction any
  name still works, reduced by its class.
- **The Earth's shape is in the Moon's computed altitude** (expansion programme,
  CONVENTIONS 15.4). On the real Earth the observer is a little nearer the Earth's centre
  than the equatorial radius and the plumb line does not point exactly at the centre, so
  the Moon's true parallax differs from the sphere's by up to **0.24′** (median 0.09′
  over the Skyfield sights below). The difference depends on the observer's latitude and
  the Moon's bearing, which a reduction does not know, so the correction chain keeps the
  sphere and its `Ho`; instead the Moon's *computed* altitude `Hc` carries the
  difference, evaluated at every position the solver tries, at the assumed position for
  the intercept, and wherever else an `Hc` is computed. In plain words: the chain turns
  the sextant reading into "the Moon's height above the horizon as seen from the Earth's
  centre, on a round Earth", and the computed altitude it is compared with now says what
  that same quantity is on the real Earth, where you stand. The Nautical Almanac's
  direct-computation method applies the same correction, with the Moon's parallax taken
  at its mean, to the observed altitude; USNO's online service applies it at its assumed
  position. For the planets it is at most 0.0021′ (Venus at its nearest) and is not
  applied, as the Almanac does not apply it.

### Validation

`tools/reference/gen_moon_sights.py` builds raw sextant readings the way the sky makes
them, not by running this project's chain backwards: Skyfield (JPL DE440s) gives the
topocentric position of the body from the observer, the limb is moved by the body's
topocentric semidiameter, Venus by its centre-of-light shift, then refraction (the
CONVENTIONS formula), dip and index error are added as a sextant records them. It does
this on two Earths: a **sphere** of radius 6378.14 km, which is the Earth the project
reduces on, and the **WGS84** Earth. 178 sights on each: 104 of the Moon (lower, upper
and centre), 54 of the planets (Venus at every phase), 14 of the Sun and 6 of stars, in
all three horizon modes, with heights of eye from 0 to 25 m and non-standard air.
`crates/skyfix-ephemeris/tests/moon_planet_sights.rs`:

| check | worst |
|---|---|
| Rust chain against the chain transcribed in Python from the text | 1.1e-10′ |
| sphere Earth: reduced Ho against the geocentric altitude, Moon / planets / stars / Sun | 0.0059′ / 0.0048′ / 0.0038′ / 0.0039′ (the diurnal aberration Skyfield includes) |
| the same with the providers' own directions instead of DE440s | 0.0063′ / 0.0053′ / 0.0041′ / 0.0035′ |
| WGS84 Earth: Moon, against the sphere's geocentric altitude | 0.22′ (median 0.09′): the Earth's-shape term above |
| **WGS84 Earth: Moon, against its model altitude** (with the term) | **0.0064′** |
| WGS84 Earth: planets / stars / Sun | 0.0048′ / 0.0023′ / 0.0045′ |

End to end, four sessions (`fixtures/sessions/reference-moon-*.json`, ephemeris `auto`,
no supplied direction, raw sextant readings, sea horizon):

| session | bodies | fix from truth |
|---|---|---|
| `reference-moon-planets-atlantic` (WGS84) | Moon, Venus, Mars, Jupiter, Saturn, Polaris, Capella | **2.6 m** (17.9 m before the Earth-shape term was modelled) |
| `reference-moon-venus-timor` (WGS84) | Moon, crescent Venus, Mars, Jupiter, Canopus, Acrux | **5.1 m** (34.9 m before) |
| `reference-moon-planets-atlantic-sphere` | as above, built on a sphere of radius 6378.14 km | 2.7 m with the term switched off (the model it was built for), 22.7 m with it |
| `reference-moon-venus-timor-sphere` | as above, on the same sphere | 5.2 m with the term switched off, 30.4 m with it |

The `*-sphere` sessions describe an Earth that does not exist; they are kept, solved
with the term switched off, as the check of the spherical chain on the Earth it is
exact for. The Navigate view's Timor example uses the WGS84 readings.

Against USNO (`fixtures/reference/usno_celnav_venus_phase.json`,
`tools/reference/gen_usno_sights.py`, `tests/usno_venus_phase.rs`), allowing for the
10.36 s by which USNO's API evaluates Solar System bodies late (ACCURACY.md, Moon):

| check | result |
|---|---|
| Venus, centre of light, 12 phase angles 15°–157° | worst 0.0031′ (the geometric centre misses by 0.41′) |
| fitted centre-of-light coefficient | 0.4403 (the uniform disc's 0.4244 is 4 % smaller) |
| Mars, 5 epochs | worst 0.0007′; USNO applies no phase |
| Moon semidiameter, 8 positions | ours 0.006′ larger (k = 0.2725076 against USNO's 0.2724) |
| Moon parallax in altitude | the sight model (the sphere's parallax less the Earth-shape term) within **0.0004′** of USNO; the WGS84 display computation within 0.004′; the sphere alone up to 0.22′ away |

## 2. The clock term

When the watch is wrong by a few seconds every body's Greenwich hour angle is wrong by
its own rate times that error. For stars and the Sun the rate is fixed (15.041 and 15.0
degrees an hour) and a clock error is exactly a longitude error. **The Moon's rate is
only about 14.5 degrees an hour** (14.1 to 14.9), because it moves eastward among the
stars; a Moon sight therefore does not move with the others when the watch is wrong —
that difference is what a lunar distance measures.

The reducer now asks the direction source for each sight's rate **at that sight's
instant**: `DirectionSource::gha_rate_deg_per_hour_at(body, jd_utc)` (a new method with a
default that returns the old, instant-free answer, so every existing implementation
still compiles and gives the same numbers). The ephemeris adapter returns the Sun's and
the stars' constants bit for bit as before and, for the Moon and the planets, the
provider's own GHA rate from a central difference over ±60 s (CONVENTIONS 13.1). A source
with no ephemeris uses the Moon's mean rate, 14.492°/h, never the sidereal one.

## 3. What the sextant will read

`skyfix_core::sights::predict::predict_sextant` (WASM `predict_sextant`) answers "what
will the sextant show?" for a body, a place and a time: the computed altitude `Hc` at
the observer is the `Ho` a perfect sight would reduce to, and the reading `Hs` is found
by running the very same correction chain in reverse (a bracketed root search within the
readings the horizon allows). Nothing is derived twice, so a prediction and a reduction
cannot disagree: reducing the predicted reading gives `Hc` back to 1e-9°. The result
carries the bearing `Zn`, the apparent altitude, and the full list of corrections as the
chain would show them. For the Moon the reading is typically 30′ to 60′ *below* `Hc`:
parallax beats refraction and the semidiameter, which is exactly why presetting `Hc`
would not find the Moon in the telescope.

For the Moon, `Hc` includes the Earth-shape term (section 1) and the result reports it
(`earth_shape_arcmin`), so the predicted reading is what a perfect sextant reads on the
real Earth at sea level, and reducing it still lands on `Hc`.

## 4. Lunar distance

### In plain words

The Moon crosses the sky against the stars by about its own width every hour. Measure
the angle between the Moon and the Sun, a star or a planet, and you have read a clock
that is the same for everyone on Earth — Greenwich time — without a chronometer. Once the
time is known, longitude follows. The difficulty is that the measured angle is what
*you* see, bent by the air and shifted by where you stand; it must be "cleared" to what
it would be from the Earth's centre before it can be compared with the almanac.

### Method (`skyfix_core::sights::lunar`, WASM `lunar_distance`)

1. **Index correction** added to the distance reading.
2. **Semidiameters**, limb to centre, for the Moon (near or far limb) and the Sun: the
   topocentric semidiameter, and because refraction squeezes a disc low in the sky, the
   edge nearest (or farthest from) the other body is found numerically on the refracted
   outline of the disc, not with a formula.
3. **Refraction** removed. It acts straight up and down, so the difference in bearing
   between the two bodies is the same in the seen and the true sky; the true distance
   follows from the true altitudes around that bearing difference — Borda's clearing
   formula, which never needs the bearing difference itself. That matters when one
   altitude is observed and the other computed: at trial instants away from the answer
   the two no longer fit the measured distance, and forcing a closed triangle there
   (the bodies put in one vertical) used to throw the measured distance away and hide
   the true instant from the search (a verifier's check: 7 of the 22 validation lunars,
   with only the Moon's altitude observed, came back 4 minutes to 10 hours wrong).
4. **Parallax** removed with the observer on the **WGS84 ellipsoid** at the DR position:
   each true direction is extended to the body's distance from the observer's real
   position. This is the one navigation method that leaves the project's spherical Earth
   (CONVENTIONS section 1 records the exception): a lunar's time needs the Moon's
   parallax to 0.03′, and the sphere is up to 0.22′ out.
5. **The time**: the cleared distance is compared with the Moon-to-body distance from the
   ephemeris over a window around the watch's time (sampled every 10 minutes, refined to
   a millisecond). The instant nearest the watch's estimate is the answer; any other
   instant with the same distance is listed and warned about, never hidden. An instant
   at which a body would be below the horizon is not a candidate.

The altitudes come from the navigator's own observations when given (they are reduced
through index correction and dip), otherwise they are computed from the DR position at
every trial instant. **Observed altitudes are better.** With computed altitudes the
answer depends on the DR position: 30 NM of DR error moved the time by 5 s to 2 minutes
in the tests, and the result reports exactly how much (`dr_sensitivity_arcmin_per_10nm`,
and a budget term when `dr_uncertainty_nm` is given).

### How good the time is

`sigma_s` = the distance's uncertainty divided by how fast the distance changes. The
distance changes about half an arcminute per minute of time, so **1′ of distance ≈ 2
minutes of time ≈ 30′ of longitude**. The distance's uncertainty combines, in
quadrature: the measurement (default 0.2′), the ephemeris (0.028′), the refraction model
(1 % of each refraction, plus the extra 1′ CONVENTIONS section 5 adds below 5° of
altitude, projected onto the distance), the observed altitudes' own sigmas through the
clearing's sensitivity to them, and the DR if its uncertainty is given. Every term is
reported in arcminutes and seconds. The result also gives the implied longitude
uncertainty in arcminutes and nautical miles. A distance changing slower than 0.25′ per
minute is warned about: a body far from the Moon's path makes a poor clock.

### Validation

`fixtures/reference/lunar_distances.json` (gen_moon_sights.py): 22 lunar distances on the
WGS84 Earth — 8 to the Sun, 10 to the classical lunar stars (Aldebaran, Regulus, Spica,
Antares, Pollux, Altair, Hamal, Markab, Fomalhaut, Nunki; near and far limbs), 4 to
planets — with heights of eye, index errors and air that vary, and the watch off by up
to 45 minutes. The measured angle is computed in Python by searching the refracted disc
outlines point by point, independently of the Rust clearing. From exact inputs
(`tests/lunar_distance_reference.rs`):

| altitudes | worst UTC error | worst cleared distance error | target |
|---|---|---|---|
| computed from the (true) DR position | **0.74 s** | 0.007′ | 5 s |
| observed | **0.63 s** | 0.005′ | 5 s |
| one observed, the other computed (either way round) | **2.1 s** | | 5 s |

The reported sigmas were 20 s to 48 s for a 0.2′ measurement, as they should be.

## 5. Tonight's sights

`skyfix_ephemeris::visibility::plan_sights` (WASM `plan_sights`): for a place, a span of
time, the height of eye and the sextant's index error, it finds **the next evening and
the next morning nautical twilight** — the Sun's centre between 6° and 12° below the
horizon, when both the stars and a sharp sea horizon are visible (CONVENTIONS 13.3) —
and for each recommends **three to five bodies** with their predicted sextant readings
and bearings at the start of the twilight.

How the bodies are chosen:

1. **Candidates**: every body offered for sights — the stars, the four planets and the
   Moon — whose provider is validated, between 15° and 75° of altitude at the start of
   the window.
2. **Bright enough for the twilight**: magnitude 1.5 or brighter with the Sun at −6°
   (only the brightest stars and the planets show against the bright horizon), up to 3.0
   with the Sun at −12° (every navigational star), linear between. This is a stated rule
   of thumb, not a model of the sky's brightness; if fewer than three bodies pass, every
   navigational body is considered and the plan says so.
3. **The best spread round the horizon**: of those, the three to five whose fix would
   be most precise **if a shared altitude error were also unknown** — a dip, index or
   refraction error moves every line of position the same way, and only bodies on all
   sides of the observer cancel it (`skyfix_core::planner::best_spread_subset`, which
   examines every subset). This is the navigator's rule "three stars 120° apart, four
   90° apart" made exact, and it still weighs each body's altitude-dependent sigma. The
   planner's existing ranking then orders the chosen bodies and explains each choice.
4. **The Moon's lit limb**: when the Moon is chosen, the limb facing the Sun is the one
   recommended (upper or lower, from the bright limb's angle and the parallactic angle).

Every plan says what it assumed, lists the bodies too faint and the ones also eligible,
and gives the whole prediction (direction and corrections) for each body. Twilight
instants agree with Skyfield to **0.15 s** at eight sites including the equator and
nights when the Sun never reaches −12° (`fixtures/reference/nautical_twilight.json`,
`tests/sight_plan.rs`); in polar day or night there is no window and the plan says so.

## 6. Known gaps

- **The Earth's shape in sight reduction** is modelled for the Moon (section 1,
  CONVENTIONS 15.4) and not for the planets (at most 0.0021′). The observer's height
  above the sea is left out of it (30 m changes the Moon's parallax by 0.0003′).
- **Venus's centre of light** follows USNO's convention to 0.003′; how the eye really
  judges a crescent's light (irradiation) is not modelled beyond that.
- **The Moon's semidiameter** uses the IAU k = 0.2725076; the Almanac's tables use
  0.2724, 0.006′ smaller.
- **Lunar distances**: the Moon's limb is assumed to be the one measured (a partly lit
  limb is the navigator's responsibility); the search window is at most ±48 hours; the
  refraction uncertainty is a stated 1 %.
- **The sight planner** uses a rule of thumb for twilight brightness, and predicts for
  the start of each window only (bodies move up to 15° an hour); it knows nothing about
  cloud or the Moon washing out faint stars. Its twilight search is its own (the events
  module of the almanac crate was not merged when it was written); both follow
  CONVENTIONS 13.3.
- **The simulator** (`skyfix-sim`) does not generate Moon or planet sights; the Skyfield
  fixtures above are the test material.
