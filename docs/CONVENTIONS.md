# SkyFix Lab conventions — the contract every crate follows

This file is normative. If code and this file disagree, the code is wrong until
this file is amended in the same change. Every numerical module must cite the
section it implements.

## 1. Units and angles

- **Internal Rust APIs use radians (`f64`).** Field and parameter names carry the
  unit: `*_rad`, `*_deg`, `*_arcmin`, `*_m`, `*_nm`, `*_s`.
- **Every I/O boundary uses degrees** (JSON, CSV, CLI flags, UI). Small angles such as
  corrections, residuals and uncertainties are reported in **arcminutes** and named
  `*_arcmin`. Radians never appear in JSON or on screen.
- Normalisation ranges:
  - latitude, declination, altitude: `[-90, +90]`; exception: a `sextant_hs` reading taken
    with `horizon = artificial_reflected` is the double angle and may reach `180`
  - longitude: `(-180, +180]`
  - GHA, LHA, SHA, azimuth `Zn`: `[0, 360)`
- Angular distance to length on the reference sphere: **1 arcminute of great-circle
  arc = 1 nautical mile (NM) = 1852 m exactly.** Therefore the sphere radius used for
  all metre conversions is `EARTH_RADIUS_M = 1852 * 10800 / pi = 6 366 707.02 m`
  (`skyfix_core::units::EARTH_RADIUS_M`). The model is a sphere; no ellipsoid
  correction is applied anywhere in sight reduction, the solver, uncertainty or the
  simulator. This is the documented "spherical Earth model". **One exception, for
  display only:** the explorer's topocentric altitudes and azimuths (`alt_deg`,
  `az_deg`, rise/set/twilight, eclipse local circumstances; section 13) place the
  observer on the WGS84 ellipsoid, because the Moon's parallax and eclipse timing need
  it. Those values never feed the navigation chain. **One exception for a time
  method:** clearing a lunar distance (`skyfix_core::sights::lunar`) places the observer
  on the WGS84 ellipsoid at the DR position, because a lunar's time needs the Moon's
  parallax to 0.03' and the sphere is up to 0.22' out for the Moon. **A third exception,
  in the model altitude of the Moon (section 15.4):** `Hc` of a Moon sight is the
  sphere's plus the Earth-shape term, the WGS84 geometry at the trial position minus the
  sphere's, wherever a model altitude is evaluated (the solver, the intercept, predicted
  readings, the noon and averaging methods, the planner and the misfit grid). `Ho`, the
  correction chain, 1' = 1 NM and every other body stay on the sphere.

## 2. Coordinates and sign conventions

- **Latitude** `phi`: north positive.
- **Longitude** `lambda`: **east positive**, everywhere (JSON, CSV, CLI, UI, Rust).
  West longitudes are negative. Philadelphia City Hall is `39.9526, -75.1652`.
- **GHA** (Greenwich hour angle): **west positive**, `[0, 360)`, as tabulated in the
  Nautical Almanac. **LHA = GHA + lambda_east**, normalised to `[0, 360)`.
- **Declination** `delta`: north positive.
- **Geographic position (GP)** of a body: `lat_gp = delta`, `lon_gp_east = normalise(-GHA)`.
- **SHA** (sidereal hour angle) of a star: `GHA_star = GHA_Aries + SHA`; `RA_deg = 360 - SHA`.
- **Azimuth** `Zn`: true bearing from the observer to the body's GP, clockwise from
  north, `[0, 360)`.

## 3. Sight reduction on the sphere (skyfix-core `geometry`)

```
sin Hc = sin(phi) sin(delta) + cos(phi) cos(delta) cos(LHA)

N = cos(phi) sin(delta) - sin(phi) cos(delta) cos(LHA)   (north component of the body direction)
E = -cos(delta) sin(LHA)                                (east component)
Zn = atan2(E, N)  normalised to [0, 360)
```

- **Intercept** `a = Ho - Hc`, **positive toward the body** ("Ho Mo To": Ho more, toward).
- **Zenith distance** `z = 90 deg - Hc`; the circle of position is every point at angular
  distance `z` from the GP.
- **Partial derivatives** (radians, exact on the sphere):
  `dh/dphi = cos(Zn)`, `dh/dlambda = cos(phi) sin(Zn)`.
  In tangent-plane displacements `dN` (north) and `dE` (east), both in radians of arc:
  `dh = cos(Zn) dN + sin(Zn) dE`. Moving toward the body by one arcminute raises it by
  one arcminute. This is the Jacobian row for every solver in the workspace.

## 4. Altitude kinds — corrections can never run twice

Every observation carries an `altitude_kind`:

| kind | meaning |
|---|---|
| `sextant_hs` | raw instrument reading. With `horizon = artificial_reflected` this is the **double** angle. |
| `apparent_ha` | after index correction, dip (sea horizon only) and halving (artificial horizon). |
| `observed_ho` | fully corrected: refraction, semidiameter, parallax applied. The solver consumes only this. |

The reducer applies **only the steps after the declared kind** and records every step
it ran, skipped, or found inapplicable. Re-reducing an `observed_ho` record is a no-op
with an explicit "already corrected" note, never a second subtraction.

## 5. Correction chain, order and signs (skyfix-core `corrections`)

Order for `sextant_hs`:

1. **Index correction** `IC` (arcmin, signed, *added*): `Hs + IC`. Index error "on the
   arc" (positive reading with the mirrors parallel) gives a **negative** IC.
   Example: index error 2.0' on the arc -> `IC = -2.0'`. This is the only sign convention
   for IC in the project; the UI labels the field "index correction (added)".
2. **Horizon step**, by horizon mode:
   - `sea`: subtract **dip** `= 1.76' * sqrt(height_of_eye_m)` (Nautical Almanac /
     Bowditch; equals 0.97' sqrt(height_ft)). Requires `height_of_eye_m >= 0`.
   - `artificial_reflected`: **halve after IC**: `Ha = (Hs + IC) / 2`. **No dip.** The
     sight's `sigma_arcmin` describes the recorded double angle, so it is halved too.
   - `electronic_vertical`: `Ha = Hs + IC` where IC is the instrument zero offset. No dip.
3. **Refraction** (Bennett 1982, standard conditions 1010 hPa, 10 C), subtracted:
   `R' = cot(Ha_deg + 7.31 / (Ha_deg + 4.4))` arcmin, scaled by
   `(P_hPa / 1010) * (283 / (273 + T_C))`.
   Validity: `Ha >= 0 deg`. Below 0 deg the sight is **rejected** (`RefractionOutOfRange`).
   For `0 <= Ha < 5 deg` the sight is **flagged** `LowAltitudeRefraction` and 1.0' is
   added in quadrature to its sigma; for `5 <= Ha < 10 deg` it is flagged only.
   Bennett's own residual (<= 0.07') is inside the sigma floor and not modelled.
4. **Semidiameter**, by body (`skyfix_core::corrections::SightBody`, from the name):
   - **Sun**: lower limb `+SD`, upper limb `-SD`, centre `0`.
   - **Moon**: the **topocentric** ("augmented") semidiameter `SD'`, lower `+SD'`, upper
     `-SD'`. The observer is nearer the Moon than the Earth's centre is:
     `sin SD' = sin SD / (sqrt(1 - sin^2 HP cos^2 h) - sin HP sin h)`, with `h` the
     topocentric airless altitude of the centre (after refraction), found together with
     `SD'` from the limb by fixed point (`corrections::limb_to_centre`). The augmentation
     is 0.28' at the zenith, 0.002' on the horizon.
   - **Planets**: none. A planet is observed at its **centre of light**. Venus's phase is
     carried in its direction, as the Nautical Almanac carries it (section 7); the phases
     of Mars, Jupiter and Saturn move their light by under 0.01' and are ignored, as the
     Almanac ignores them. A lower or upper limb on a planet is ignored with the
     `LimbIgnoredForStar` warning, exactly as for a star.
   - **Stars**: none.
   SD comes from the ephemeris record (`semidiameter_arcmin`), never a constant; `0.0`
   with a limb means "unknown" and is warned about, not applied.
5. **Parallax in altitude**, added, by body:
   - **Sun**: `PA = HP * cos(Ha)`, `HP` from the ephemeris record
     (`horizontal_parallax_arcmin`, ~0.146'). (The rigorous form below differs by under
     0.001' for the Sun; this one is kept so Sun results never change.)
   - **Moon and planets**: `p = asin(sin HP * cos h)`, `h` the topocentric airless
     altitude of the centre (after refraction and, for the Moon's limb, step 4). This is
     exact on the sphere of section 1 for an observer at the radius HP refers to. Using
     `Ha` instead of `h`, or `HP cos h`, would be up to 0.2' and 0.001' wrong for the Moon.
     The Moon's HP is required: a `sextant_hs` or `apparent_ha` Moon record whose
     direction has `horizontal_parallax_arcmin = 0` is **rejected** (the Moon's parallax
     reaches 61'). For Venus and Mars this step is the Nautical Almanac's "additional
     correction", which its explanation says "allow[s] for parallax" (Venus's phase being
     in the tabulated GHA and Dec); for Jupiter and Saturn it is under 0.04', which the
     Almanac omits and this chain applies.
   - **Stars**: 0.
   - **The Earth's figure is not in this step; it is in the Moon's model altitude.**
     On the real (WGS84) Earth the observer's geocentric radius is shorter than the
     equatorial radius and the plumb line does not point at the Earth's centre, so the
     Moon's true parallax in altitude differs from the sphere's by up to **0.24'**
     (median 0.09' over 104 Skyfield sights). The difference depends on the observer's
     latitude and the Moon's azimuth, which a reduction does not know, so this step keeps
     the sphere of section 1 and `Ho` stays the sphere's geocentric altitude; the term is
     added to `Hc` at every trial position instead (section 15.4), which leaves a perfect
     Moon sight on the WGS84 Earth within 0.0064' of its model altitude, and the Moon's
     parallax implied by the model within 0.0004' of USNO's. Planets: at most 0.0021'
     (Venus at inferior conjunction), not applied.
6. `Ho = Ha - R (+/- SD) + PA`.

Limb with an artificial horizon: halving first, then the limb rule above, is correct.
Bringing the direct image's lower limb to the reflected image's upper limb measures
`2h - 2SD`; halving gives `h - SD`, which is exactly a lower-limb altitude.

Sigma propagation: `sigma_ho^2 = sigma_after_horizon_step^2 + sigma_extra^2`, where the
horizon step halves sigma for `artificial_reflected` and `sigma_extra` is the
low-altitude term above.

## 6. Time

- Timestamps are **UTC, RFC 3339, with a trailing `Z`** (`2026-10-01T01:30:00Z`).
  Fractional seconds allowed. Anything else is rejected.
- Internally: `jd_utc: f64` (Julian date). Derived:
  `jd_tt = jd_utc + (delta_at + 32.184) / 86400` with `delta_at` from the leap-second
  table in `skyfix_core::time` (37 s from 2017-01-01; no later leap second exists as of
  the build date). `jd_ut1 = jd_utc + dut1 / 86400`, with DUT1 from the single lookup
  `skyfix_core::time::dut1_s(jd_utc, user)`: the session's `clock.dut1_s` (or the CLI's
  `--dut1`, or an observer document's `dut1_s` at the WASM boundary) when given,
  otherwise the engine's value (0 until the timescales work adds the IERS history and
  the model of section 15.2). A session's providers are built once, at its earliest
  sight. |DUT1| < 0.9 s, so an unknown DUT1 leaves up to 0.23' in every GHA; it is
  listed in the error budget, not hidden.
- **Clock offset**: a shared offset `dt` makes every recorded time wrong by the same
  amount. It shifts every GHA by `omega * dt` (`omega = 15.041 07 deg/h` sidereal for
  stars, 15.000 deg/h for the Sun to first order, and the body's own rate for the Moon
  and the planets, section 13.1). For star-only sessions this is
  **exactly degenerate with longitude**. The solver never estimates it. Instead
  `clock.uncertainty_s` is propagated: a rank-1 east-west term
  `(cos(phi) * omega * sigma_t)^2` is added to the position covariance and reported
  separately as `clock_sigma_east_m`. `clock.correction_s` is a *known* chronometer
  correction, added to every recorded time before use.

## 7. Frames

- Supplied or computed `gha_deg` / `dec_deg` are **apparent geocentric of date**: true
  equator and equinox of date, including precession, nutation, annual aberration and
  (Sun) light-time. No diurnal aberration, no topocentric parallax: parallax is an
  altitude correction (section 5). This is the Nautical Almanac convention.
- **The Moon** is observed the way Skyfield observes it: light-time with barycentric
  positions, then aberration with the Earth's barycentric velocity. The two nearly
  cancel for a body that travels with the Earth, leaving about 0.7″ from the Moon's own
  motion over the 1.28 s light-time. Applying the stars' 20.5″ annual aberration to the
  Moon would be wrong by that much.
- **Venus for sights is its centre of light.** The Nautical Almanac "incorporate[s]" the
  phase correction for Venus "in the tabulations for GHA and Dec", and USNO's celnav
  data does the same. `skyfix_ephemeris::sights::SightPlanetProvider` (the planets in
  ephemeris mode `auto`) therefore returns Venus moved toward the bright limb by
  `0.44 (1 - cos i) SD` (`i` the phase angle): the uniformly lit disc's centroid form
  with the coefficient measured against twelve USNO responses (0.003'). A supplied
  Venus direction typed from the Almanac means the same thing. The explorer's
  `sky_state` shows the geometric centre (display only).
- A topocentric direction vector is never mixed with a geocentric corrected altitude.
  Camera/attitude code (module A) produces *topocentric apparent* directions and must
  convert through the horizon frame explicitly.

## 8. Solver (skyfix-core `solver`)

- Unknowns: `(phi, lambda)`; optionally a shared altitude bias `b` (off by default).
  Model: `Ho_i = Hc_i(phi, lambda) + b + e_i`, `e_i ~ N(0, sigma_i^2)`, independent.
- Weighted Gauss-Newton with Levenberg-Marquardt damping, parametrised in the local
  tangent plane `(dN, dE)` about the current estimate, re-linearised each iteration
  with the exact spherical model. Converged when the step is `< 1e-9 rad` (about 6 mm)
  or after 50 iterations (then `converged = false`).
- **Initialisation** (in this order, all attempted, results clustered):
  1. supplied assumed position when its role is `initializer` (it is *never* a prior);
  2. for exactly two sights: both analytic circle intersections
     (`geometry::two_circle_intersections`);
  3. a coarse global grid (default 10 deg x 10 deg) refined locally.
  Distinct minima are those more than 10 NM apart.
- **Result kinds** (`FixResult`):
  - `underdetermined`: fewer than two usable sights or Jacobian rank < 2. Returns the
    circle(s) of position and no point.
  - `ambiguous`: another minimum has `chi2` within `5.991` (chi-square, 2 dof, 95 %) of
    the best. All candidates returned, none promoted.
  - `unique`: one fix plus any rejected alternatives with their `delta_chi2`.
  - `failed`: no convergence anywhere, with the reason.
- **Priors**: none by default. `assumed_position_role = prior` with `sigma_nm` adds a
  proper quadratic prior term, and the result reports the fix **with and without** it.
- **Robust weighting** (Huber, `k = 1.5`, IRLS) is opt-in. When on, every sight's final
  weight is reported and the covariance is labelled approximate.

## 9. Uncertainty (skyfix-core `uncertainty`)

- `Cov = (J^T W J)^-1`, `W = diag(1 / sigma_i^2)`, in tangent-plane metres (north, east).
  This is the **a priori** covariance and is never rescaled by the residual variance by
  default. Two or three sights cannot establish their own noise level.
  `posterior_scaling = true` additionally reports `s^2 = chi2 / dof` scaling **only when
  dof >= 3**, clearly labelled.
- **95 % ellipse**: eigen-decomposition of the 2 x 2 covariance; semi-axes
  `sqrt(5.991 * eigenvalue)`; `orientation_deg` is the azimuth of the major axis,
  clockwise from north. Emitted only when the result is `unique`, converged, rank 2 and
  condition number `< 1e6`. Otherwise `ellipse95 = null` with
  `ellipse_suppressed_reason`. The ellipse's `model` string is always
  `"nominal 95 %, independent-noise model"`.
- **Conditioning**: singular values of `W^(1/2) J`, condition number, rank, and the
  geometric dilution `sqrt(trace((J^T J)^-1))` (metres of position per arcminute of
  altitude noise, geometry only), plus the azimuth spread of the sights.
- **Residuals**: `r_i = Ho_i - Hc_i(fix) - b` in arcmin, and `r_i / sigma_i`.

## 10. Session JSON, schema `skyfix.session/1`

```json
{
  "schema": "skyfix.session/1",
  "meta": { "name": "Philadelphia three-star", "notes": "", "kind": "simulated" },
  "observer": {
    "height_of_eye_m": 2.0,
    "pressure_hpa": 1010.0,
    "temperature_c": 10.0,
    "assumed_position": { "lat_deg": 40.0, "lon_deg": -75.0 },
    "assumed_position_role": { "role": "initializer" }
  },
  "instrument": { "name": "simulated", "index_correction_arcmin": 0.0, "horizon": "sea" },
  "clock": { "uncertainty_s": 0.0, "correction_s": 0.0, "dut1_s": -0.1 },
  "observations": [
    {
      "id": "obs-1",
      "body": "Vega",
      "utc": "2026-10-01T01:30:00Z",
      "altitude_deg": 61.2345,
      "altitude_kind": "sextant_hs",
      "sigma_arcmin": 1.0,
      "limb": "center",
      "horizon": null,
      "geocentric": { "gha_deg": 123.4567, "dec_deg": 38.7890,
                      "semidiameter_arcmin": 0.0, "horizontal_parallax_arcmin": 0.0 },
      "notes": ""
    }
  ]
}
```

- `kind` is `simulated` or `real`; the UI shows it on every view.
- `assumed_position_role.role` is `initializer` (default), `prior` (with `sigma_nm`) or
  `disabled`.
- `clock.dut1_s` (expansion programme): UT1 − UTC in seconds from the time signal or
  IERS Bulletin A, optional. Absent or `null` means automatic (section 6); a session
  without it is written without it, in JSON and in CSV (`# clock.dut1_s=...`, empty =
  automatic). Validation: finite; beyond the IERS bound of 0.9 s a warning; beyond 60 s
  refused as not seconds.
- `horizon` on an observation overrides the instrument's mode for that sight only.
- `geocentric` supplies the body direction directly ("first numerical slice"). When
  present it wins over any ephemeris provider and the report says so. When absent, an
  ephemeris provider must be able to supply the body at that time or the sight is
  rejected with the provider's coverage in the message.
- Body names: `"Sun"`, `"Moon"`, `"Venus"`, `"Mars"`, `"Jupiter"`, `"Saturn"`, the 57
  navigational stars and `"Polaris"` by Nautical Almanac spelling (`"Vega"`,
  `"Rigil Kentaurus"`, ...), or `"HIP <number>"`. Mercury, Uranus and Neptune are not
  offered for sights (section 13.1); with a supplied direction any name is accepted and
  reduced by its class (section 5).
- Validation rejects: non-finite numbers, angles outside their ranges, `sigma_arcmin <= 0`,
  timestamps not in RFC 3339 `Z` form, unknown bodies, unknown enum values, duplicate ids,
  `limb != center` for a star or a planet, and (`observed_ho` with any correction
  parameter that would have to be ignored). The last two are warnings, not errors
  (`LimbIgnoredForStar`, `AlreadyCorrected`).

CSV import/export carries the same fields with one observation per row; the session-level
fields ride in a `#`-prefixed header block. The CSV path must round-trip through JSON
without loss.

## 11. Reference fixtures, schema `skyfix.reference/1`

`fixtures/reference/*.json` are generated by `tools/reference/` (Python + Skyfield,
development-time only) or typed from an independent published source. Each file records
`generator` (tool, version, ephemeris file, EOP assumptions, refraction convention,
tolerances) and `cases`. Never regenerate a fixture from Rust output.

`fixtures/sessions/*.json` are session files. When a session is simulated, the truth
lives in a **separate** file `fixtures/expected/<name>.truth.json` and is never read by
the solver or the CLI `solve` command.

## 12. Warnings vocabulary

`skyfix_core::types::Warning` is the single enum for machine-readable caveats. Add
variants there, never ad-hoc strings, so the CLI, WASM adapter and UI show them the same way.

## 13. Explorer: bodies, topocentric display values, events and display-only data

Wire formats are in `docs/EXPLORER_API.md`; the program plan is `docs/EXPLORER_PLAN.md`.

### 13.1 Bodies

- Canonical names: `Sun`, `Moon`, `Mercury`, `Venus`, `Mars`, `Jupiter`, `Saturn`,
  `Uranus`, `Neptune`, and the 58 star names of section 10. Input matches
  case-insensitively after trimming; output always uses the canonical spelling.
- Kinds: `sun`, `moon`, `planet`, `star`. **Navigational bodies** (offered for sights
  once their provider is validated): Sun, Moon, Venus, Mars, Jupiter, Saturn and the 58
  stars. Mercury, Uranus and Neptune are shown but never offered for sights.
- `GeocentricDirection` (section 7) stays the navigation interface. `ApparentState`
  (`skyfix_ephemeris::body`) adds distance, magnitude and phase for display and
  planning.
- The GHA rate used for clock propagation (section 6) is per body: sidereal for stars,
  solar for the Sun, and for the Moon and planets a numerical derivative of the
  provider's GHA over +/-60 s. Never assume the sidereal rate for the Moon (it runs about
  14.5 deg/h). The reducer asks `DirectionSource::gha_rate_deg_per_hour_at(body, jd_utc)`
  for each sight's own instant; its default returns the older instant-free
  `gha_rate_deg_per_hour(body)`, which for the Moon is the mean lunar rate 14.492 deg/h
  (never the sidereal) when no ephemeris can be asked.

### 13.2 Topocentric display altitude and azimuth

- Site: WGS84 geodetic latitude, east longitude and height above the ellipsoid. Earth
  rotation by GAST with DUT1 = 0 (section 6) and no polar motion.
- `alt_deg` / `az_deg`: the body centre seen from the site, **geometric** (parallax from
  the geocentric distance applied, no refraction), altitude measured from the plane
  perpendicular to the ellipsoid normal. Stars have no parallax.
- `alt_apparent_deg = alt_deg + R`, with Saemundsson's true-to-apparent refraction
  `R[arcmin] = 1.02 / tan(h + 10.3 / (h + 5.11))` (h in degrees), evaluated at
  `h = max(alt_deg, -1)`, scaled by `(pressure_hpa / 1010) * (283 / (273 + temperature_c))`.
  It is the approximate inverse of the Bennett correction of section 5 and is used for
  display only; sight reduction still uses section 5.
- `hc_deg` / `zn_deg` in the explorer are exactly section 3 from the apparent
  geocentric GHA/Dec: what a navigator's tables give. The UI labels the two families
  differently and never subtracts one from the other as if they were comparable. (For
  the Moon this display `hc_deg` is the tables' sphere, without the Earth-shape term the
  navigation paths add to its model altitude, section 15.4.)

### 13.3 Rise, set, transit and twilight

All events are instants in UTC computed from the topocentric geometric altitude of the
body's centre, `alt_deg`, crossing a threshold `h0`:

| body | `h0` (sea-level horizon, `horizon = "standard"`) |
|---|---|
| Sun | `-50'` (34' standard refraction + 16' standard semidiameter) |
| Moon | `-34' - SD`, SD = the Moon's geocentric semidiameter at that instant |
| planets, stars | `-34'` |

- `horizon = "dip"`: `h0` is lowered further by the dip of section 5,
  `1.76' * sqrt(height_of_eye_m)` — the body rises earlier and sets later for an
  observer above the sea.
- Twilight: the Sun's centre at `alt_deg = -6, -12, -18` degrees (civil, nautical,
  astronomical); dawn crosses upward, dusk downward. Twilight never uses dip.
- Transit: upper transit when `LHA = 0` computed from the apparent geocentric GHA
  (the Nautical Almanac's meridian passage); lower transit when `LHA = 180`.
- A body that does not cross `h0` inside the window is `always_above` or
  `always_below`; the window's edges never create events.
- Root finding brackets sign changes on a grid no coarser than 10 minutes (Moon) or 20
  minutes (others) and refines to 1 second or better.

### 13.4 Sky phases

From the Sun's `alt_deg = h`: `day` when `h > -50'`; `civil` when `-6 < h <= -50'`;
`nautical` when `-12 < h <= -6`; `astronomical` when `-18 < h <= -12`; `night` when
`h <= -18` degrees. The time bar and the map's twilight shading use exactly these bands.

### 13.5 Moon phases, illumination and seasons

- New moon, first quarter, full moon and last quarter are the instants when the
  apparent geocentric ecliptic longitude of the Moon minus that of the Sun (ecliptic and
  equinox of date) is 0, 90, 180 and 270 degrees.
- Illuminated fraction `k = (1 + cos i) / 2`, `i` the phase angle (Sun-body-Earth).
  Moon age is the time since the preceding new moon.
- Equinoxes and solstices: the Sun's apparent geocentric ecliptic longitude is 0, 90,
  180 and 270 degrees.

### 13.6 Display-only data

The star field (NASA HEASARC BSC5P), constellation figures (this project's own
drawing), constellation boundaries (IAU 1930 definitions), the offline basemap and the
gazetteer (Natural Earth) are **display-only**. They never enter `reduce`, `solve`, the
planner's navigation candidates or any accuracy claim. Enforced by crate boundaries:
`skyfix-starfield` is not a dependency of `skyfix-core`, `skyfix-ephemeris`,
`skyfix-sim` or `skyfix-almanac`; only the adapters join it with the engine, to label a
body's constellation: `skyfix-wasm` (the `sky_state` export) and `skyfix-cli` (the
constellation column of `skyfix sky`).

### 13.7 Accuracy targets and validation

Reference: Skyfield with JPL DE440s (DE421 as a cross-check), DUT1 = 0 columns as in
section 11, over 1990-2060.

| quantity | target (worst case) |
|---|---|
| Moon GHA and Dec | 0.1' |
| Moon HP | 0.05' |
| Planets GHA and Dec | 0.1' |
| Topocentric `alt_deg` / `az_deg` (any body) | 0.1' |
| Rise, set, twilight vs Skyfield with the same `h0` | 10 s |
| Rise, set, twilight vs USNO (rounded to the minute) | 1 min |
| Moon phases, equinoxes and solstices | 1 min |
| Star-field apparent places | 0.1' |

A provider that misses its target is shipped only with `validated: false` in
`explorer_coverage` and is not offered for sights.

### 13.8 Displayed time

The engine works only in UTC. The UI displays one chosen zone and always shows UTC
beside it: an IANA zone (formatted with the browser's `Intl`), guessed from the
gazetteer and overridable; the nautical zone time for positions at sea
(`ZD = round(lon_east / -15)`, so zone time + ZD = UTC; 75 W is ZD +5); or UTC itself.

### 13.9 Daily almanac pages

`skyfix_almanac::pages` gives, for one UT calendar date, what the Nautical Almanac's two
facing daily pages give (wire format: EXPLORER_API.md "Wave 2 — almanac pages").

- **Argument.** UT is UTC with DUT1 = 0 (section 6); the printed almanac's is UT1.
- **Hourly values**, 00h to 23h: exact evaluations. GHA Aries is the Sun's `GHA + RA`.
- **v** (arcmin) = mean hourly increase of GHA minus the adopted rate: 15° for the planets
  (mean over 00h to 24h), 14° 19.0' for the Moon (from each hour to the next). **d** =
  hourly change of declination over the same intervals; raw values signed (north
  positive), printed without sign as the printed almanac prints them.
- **Once-a-day values** are for 12h UT: the stars' SHA and Dec, the planets' SHA and
  magnitude, the Sun's and the Moon's SD, the Moon's age and illuminated percentage.
- **Equation of time** at 00h and 12h = apparent minus mean solar time at Greenwich,
  `(GHA_Sun - 15° (UT - 12 h)) / 15°/h`; negative when the Sun crosses the meridian after
  12h (shaded on the page).
- **Meridian passage**: the UT of `GHA = 0` (the Moon's lower: `GHA = 180°`) on the date,
  from section 13.3 at 0° N 0° E; Aries' is the root of `GHA Aries = 0`. None on the date:
  the next, printed `24 hh mm`.
- **Moon's age**: time since the preceding new moon (13.5) at 12h, printed in whole days
  elapsed; **illuminated** `100 k`, `k` as in 13.5.
- **Rise, set and twilight table**: section 13.3 exactly, at the 31 standard latitudes
  72 N to 60 S on the Greenwich meridian, sea level, standard horizon; LMT = UT. The
  morning columns hold the Sun's rising through −12°, −6°, −50′ between the lower passage
  before the date's noon and that noon; the evening columns its setting between noon and
  the next lower passage (so `24 hh mm` after midnight, `-00 mm` before it). Without a
  crossing that half-day: `□` the Sun above the horizon all day (every column), `■` below
  that altitude, `////` it sets but twilight lasts all night. Moonrise and moonset for the
  date and the next: the first on the date; else `□`/`■` if the Moon is above/below all
  that date; else the next on the following date as `24 hh mm`; else `--`. `n/a`: the
  phenomenon needs instants outside the ephemeris coverage.
- **Rounding** (printed values only; raw values are carried beside them): angles, v, d,
  HP and SD to 0.1′, magnitudes to 0.1, times to the nearest minute (Aries' meridian
  passage to 0.1 minute), the equation of time to the second.

### 13.10 Sun tools (expansion programme, suntools agent, 2026-09-24)

`skyfix_almanac::sun_tools`; wire formats in EXPLORER_API.md, "Expansion programme — sun
tools"; validation in ACCURACY.md section 14. Display and planning only: nothing here
feeds sight reduction. Every altitude and azimuth is 13.2's, the one `sky_state` gives at
the same instant.

- **Golden hour and blue hour** are photographers' conventions, not physical boundaries,
  and the UI says so: golden hour while the Sun's centre is above −4° and not above +6°,
  blue hour while it is above −6° and not above −4°, morning and evening. The thresholds
  are on the **geometric** altitude of the centre (`alt_deg`), like twilight (13.3), so
  blue hour ends exactly at civil dusk. (An "apparent −4°" is not used: below the horizon
  the display refraction of 13.2 is a formula held constant under −1° with no physical
  meaning; at +6° refraction would move the instant by under a minute.) Polar cases use
  twilight's vocabulary: a threshold never crossed inside the window is `always_above` or
  `always_below`; a golden or blue hour cut by the window's edge says so (`open_start`,
  `open_end`) and invents no instant; `period` says when it falls: `morning`, `evening`,
  `midday` (the Sun culminates inside the band), `midnight` (its lower culmination is
  inside it) or `all_day`.
- **Azimuth search** (`find_azimuth`): the instants the body's `az_deg` crosses a bearing,
  found like 13.3's events (10-minute grid, subdivided while the azimuth turns by more than
  20° between samples, refined to 1 ms). A crossing counts only inside an altitude band:
  by default `above_horizon` (upper limb above the sea-level horizon); a given band bounds
  the apparent altitude of the centre, as `find_altitude` does.
- **Alignments** (`alignment_days`): `rise` and `set` are 13.3's (upper limb on the
  sea-level horizon, or the dipped one); `at_altitude` is the centre at an apparent
  altitude. The azimuth compared with the bearing is the centre's at that instant. A day
  matches within the tolerance; the closest day of each run of consecutive matching days
  is `best`.
- **Clocks for year-long series**: local days and dates are laid out on a fixed offset
  from UTC, all year, with no daylight saving: the offset given, or local mean time
  (`lon_east / 15` hours). A local year that reaches outside the coverage is clipped and
  says so (`truncated`).
- **Analemma**: the Sun at one clock time on every day of a year, on local mean time or a
  zone time (the caller says which), with its declination and the equation of time.
- **Sun path**: the Sun's `sample_bodies` samples; the envelope is the same local day
  shifted by whole days to the days holding the year's equinoxes and solstices (13.5).
- **Equation of time**: 13.9's definition, `(GHA_Sun − 15° (UT − 12 h)) / (15°/h)`, UT = UTC
  (DUT1 = 0), in seconds; positive when the sundial is ahead of mean time. Meeus's
  mean-longitude route (eq. 28.1) defines the mean sun slightly differently and runs
  0.21 s ahead.
- **Clear-sky solar energy**, always labelled "clear-sky estimate" with its typical error
  and "clouds are not modelled":
  - global horizontal irradiance, Haurwitz as Reno, Hansen & Stein (2012) give it (eq. 18):
    `GHI = 1098 cos z exp(−0.057 / cos z)` W/m², `z` the Sun's **apparent** zenith angle;
  - direct normal, Meinel & Meinel (ibid., eqs. 22–23): `DNI = E0 · 0.7^(AM^0.678)`,
    `AM = 1 / cos z`, `E0 = 1361 W/m² / r²` with `r` the Sun's distance in au; capped so
    that `DNI cos z ≤ GHI`; diffuse `DHI = GHI − DNI cos z`;
  - plane of array, isotropic sky: `DNI max(cos θ, 0) + DHI (1 + cos β)/2 +
    GHI ρ (1 − cos β)/2`, `cos θ = cos z cos β + sin z sin β cos(A_sun − A_panel)`, tilt
    `β`, albedo `ρ` (default 0.2), the panel facing the equator by default;
  - energy: irradiance integrated over time (trapezoids between a day's samples, the
    midpoint rule on each local day of a year), kWh/m²; the best tilt is the one that
    collects the most in the year for the panel's azimuth (Brent's search on
    [0°, 90°], both ends checked).
  - Typical error: RMSE 6.6 % of measured clear-sky irradiance over 30 U.S. sites, small
    mean bias, larger at high-elevation sites (no elevation term). Clouds, haze beyond
    the model's average, snow, shading, soiling, temperature and inverter losses are not
    modelled.
- **Galactic centre**: Sgr A*, RA 17h 45m 40.04s, Dec −29° 00′ 28.1″ (J2000); the
  galactic equator's north pole RA 12h 51m 26.28s, Dec +27° 07′ 42.0″ (J2000); both
  carried to the date by the star chain of `skyfix_ephemeris::frames` (frame bias,
  precession, nutation, light deflection, annual aberration; no proper motion) and seen
  from the site as stars (13.2). A **dark-sky window** is a stretch during which the
  galactic centre's apparent altitude is at least `min_altitude_deg` (default 10°) and the
  Sun's geometric altitude at most `sun_max_altitude_deg` (default −18°, 13.4's night),
  split where the Moon rises or sets (13.3), with whether it is up and its illuminated
  fraction. The **best moment** is the galactic centre's highest in the window; there the
  **arch** (the galactic equator) has its highest point at `90° − h` in the azimuth
  opposite the galactic pole that is above the horizon (`h` that pole's altitude) and
  meets the horizon 90° either side of that pole's azimuth. Geometric directions.

## 14. Navigation methods: noon sight, Polaris, averaging, running fix

`docs/NAVIGATION_METHODS.md` is normative for these methods (`skyfix_core::methods`,
`skyfix_wasm::nav`); their wire shapes are in `docs/EXPLORER_API.md`. What binds them to
the rest of this file:

- Every method reduces its observations with `reduce::reduce_observation` (sections
  4-5): the chain runs once per sight, and a rejected sight becomes a warning naming it,
  never a silent drop. Results carry the reduced sights.
- A DR position given to a method (default: the session's assumed position) chooses
  between answers, predicts and propagates uncertainty. It is never a prior (section 8),
  and an unstated DR uncertainty is never replaced by a guess.
- Meridian passage is `LHA = 0` of the apparent geocentric GHA (section 13.3). The noon
  latitude at that instant is `dec + (90° − H0)` with the body south of the zenith and
  `dec − (90° − H0)` with it north, exact on the sphere.
- Rates — GHA, altitude, curvature — come numerically from the body's own direction
  track, never from an assumed rate (section 13.1).
- Outlier flags and consistency checks use 3 standard deviations.
- A vessel's motion over a noon or averaging run is a constant course and speed along the
  great circle through the method's reference position; the running fix keeps
  `docs/MOTION.md`'s leg model.

## 15. Deep time: coverage tiers, time scales and calendars (expansion programme, 2026-09-24)

Normative for every crate. Decisions from `EXPANSION_PLAN.md` §4; agents refine the
subsections they own and say so in their reports.

### 15.1 Tiers

- **validated**: 1550-01-01 to 2650-01-22 (the span of JPL DE440). The accuracy figures in
  `ACCURACY.md` hold; bodies are offered for sights as today.
- **labelled**: −2000-01-01 to 3000-12-31, only with the `deep-time` pack loaded. Accuracy
  is measured per century against DE441 and tabulated; every displayed time carries the ΔT
  uncertainty when it exceeds the display precision; no sights, no predicted readings, no
  planner (`outside_validated_tier`).
- **outside**: refused, with the same wording as today.

### 15.2 Time scales

- The app's clock (`jd_utc` on the wire) is **UTC from 1972-01-01 to 2035-12-31** and
  **UT (≈ UT1) outside** that span. TT − UTC = 32.184 s + ΔAT inside; TT − UT = ΔT(model)
  outside. UT1 = UTC + DUT1 inside; UT1 = UT outside.
- **ΔT model**: Stephenson, Morrison & Hohenkerk 2016 splines (−720 to 2016), IERS observed
  values (1962 on, monthly), the long-term parabola −320 + 32.5 ((y − 1825)/100)² s beyond
  both, joined smoothly. Its standard uncertainty is part of the model: the published
  historical values where the splines apply, the Huber/NASA growth law for the future.
- **DUT1**: the IERS history (weekly samples, 1973 to the build date) inside the UTC span;
  a user value when given (explorer-wide `set_dut1`, or a session's `clock.dut1_s`);
  otherwise 0 with σ = 0.9 s, shown as ±0.23′ of longitude. Never assumed silently after
  2035.
- The words: "UTC" inside the span, "UT" outside, "TT" only in developer output.

### 15.3 Calendars and years

- Internal scale: JD, as today. Astronomical year numbering everywhere in code and on the
  wire (year 0 = 1 BC); ISO expanded years outside 0000–9999.
- Display and input: the **Julian calendar before 1582-10-15**, Gregorian from that day,
  each labelled; a proleptic-Gregorian (ISO) option in Settings for people who want it.
  Years before 1 AD are shown as "585 BC" with the astronomical number in the tooltip.
- Local time before 1850: local mean time at the observer's longitude ("LMT"), because
  civil zones did not exist; nautical zones and IANA zones stay selectable.
- The Saros series number is computed from the epoch's expected series, not from
  `lunation mod 223` alone (which misnumbers series below 28 solar / 12 lunar).

### 15.4 The Moon's Earth-shape term (exception to §1 and §5)

Sight reduction stays on the sphere (1′ = 1 NM, geocentric `Ho`) **except** that the model
altitude `Hc` of the Moon includes the exact WGS84 term
`OB = HP·f·(sin 2φ·sin h·cos Z − sin²φ·cos h)` (computed as the difference between the
WGS84 topocentric geometry at the trial position and the spherical one, f = 1/298.257),
in the solver, the intercept, predicted readings, the noon and Polaris methods, the
planner and the misfit grid. `Ho` and the six-step correction chain are unchanged. The
term is under 0.002′ for Venus and Mars and is not applied to them.

Implementation (moonshape, 2026-09-24; `skyfix_core::sights::wgs84::EarthShape`):

- **Definition.** For a Moon sight whose direction carries its horizontal parallax,
  `term = [h_t + asin(sin HP cos h_t)] − Hc_sphere`: `h_t` is the altitude, above the
  geodetic horizon of a sea-level WGS84 site at the trial position, of the Moon placed at
  `6378.14 km / sin HP` along its apparent geocentric direction, and `Hc_sphere` is
  section 3 at the same geodetic latitude and longitude. Both altitudes are taken with
  `atan2`, so the term is exact to the zenith. The model altitude is `Hc_sphere + term`;
  `Ho − Hc` is then zero for a perfect sight on the real Earth. `OB` above is minus this
  term to first order, with `h` and `Z` the altitude and azimuth the observer sees
  (0.00018′ from the exact value below 84°; 0.004′ if `h` is taken as the geocentric
  altitude). Worst case 0.2382′ (φ = 54.9°, the Moon toward the equator at 55°, HP
  61.5′); Venus 0.0021′, Mars 0.0015′, the Sun 0.0006′.
- **Where.** `Sight.moon_hp_arcmin` (set by `reduce::to_sights` for the Moon) brings the
  term into the solver at every trial position; `ReducedSight.hc_deg` and the intercept
  at the assumed position include it and `ReducedSight.earth_shape_arcmin` reports it;
  `PredictedSight.hc_deg` includes it and `earth_shape_arcmin` reports it (so a
  predicted reading is the real Earth's); the noon method's curve, meridian altitude
  and latitude rule (`lat = dec ± (90° − (H0 − term))`), the averaging method's
  predicted altitude, the planner's Moon altitude and the misfit grid use it. Polaris
  sights have no Moon. A running fix takes the term at the estimated position at each
  sight and removes it from that sight's `Ho` before advancing it. A Moon circle of
  position carries the term evaluated at the fix (at the best candidate, or the
  initializer, when there is no fix).
- **Jacobian.** The solver's row stays `[cos Zn, sin Zn]`. The term's own slope is at
  most 0.9e-4 of the main term's below 45° of altitude and 1.8e-4 below 70°, growing as
  `tan h` toward the zenith (7e-4 at 85°): it changes the iteration's path, not where it
  stops, and the covariance by under 0.04 % below 70°.
- **Without HP.** An `observed_ho` Moon record whose supplied direction has no
  horizontal parallax cannot have the term; it is modelled on the sphere and the
  reduction says so (a warning).
- **Not modelled with it:** the observer's height (30 m changes the parallax by
  0.0003′), polar motion, and the deflection of the vertical.

### 15.5 Packs

A pack changes what the engine can answer, never how it answers: the `deep-time` pack
installs wider series tables and the long-term precession; the `tides-us` pack installs
station constants; the `lunar-limb` pack installs a limb profile. `explorer_coverage()`
reflects loaded packs. A pack is loaded per page session from the app's own cache; the
core module never depends on one.
