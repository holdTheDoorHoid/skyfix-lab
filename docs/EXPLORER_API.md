# Explorer engine — wire contract

**Status:** normative. The Rust side is `crates/skyfix-wasm/src/{explorer,starfield,nav,navsky,almanac,eclipses}.rs`;
the TypeScript mirror is `web/src/next/engine/types.ts`. Change both together, in one
commit, and say so in your report. Numeric definitions are CONVENTIONS section 13.

## Common rules

- **Times in** are `jd_utc` numbers: the UTC-based Julian Date exactly as
  `skyfix_core::time` uses it (86 400 s per day counted from the UTC calendar;
  `jd = unix_ms / 86 400 000 + 2 440 587.5`). Times out carry both `jd_utc` and `utc`
  (RFC 3339 with `Z`, millisecond precision, CONVENTIONS §6).
- **Angles** are degrees unless the field name says otherwise. Longitude east-positive,
  GHA west-positive, azimuth from true north clockwise, `[0, 360)`.
- **Observer** (`observer_json`):
  `{"lat_deg": 39.95, "lon_deg": -75.17, "height_m": 12, "pressure_hpa": 1010, "temperature_c": 10}`.
  Only `lat_deg` and `lon_deg` are required; the defaults are `height_m = 0`,
  `pressure_hpa = 1010`, `temperature_c = 10`. `height_m` is the site's height above
  the WGS84 ellipsoid (used for topocentric parallax), not the height of eye.
- **Body lists** (`bodies_json`): a JSON array of canonical names, or one of the strings
  `"all"` (Sun, Moon, Mercury…Neptune, the 58 navigational stars), `"solar_system"`
  (Sun, Moon, Mercury…Neptune) or `"navigational"` (Sun, Moon, Venus, Mars, Jupiter,
  Saturn, the 58 stars). Names match case-insensitively after trimming; results always
  use the canonical spelling. The argument is JSON text either way, so a group name
  arrives quoted: `["Sun","Moon"]` or `"all"` (what `JSON.stringify` produces).
- **Canonical names:** `Sun`, `Moon`, `Mercury`, `Venus`, `Mars`, `Jupiter`, `Saturn`,
  `Uranus`, `Neptune`, and the star names returned by the existing `catalog()`.
- **Errors:** malformed input throws a string. A body that cannot be computed at that
  time (out of coverage, not yet implemented) does not throw: it is left out of the
  result and listed in `errors: [{"body", "message"}]`.
- Typed arrays (`Float64Array`, `Float32Array`, `Int32Array`) are real JS typed arrays,
  built with `js_sys`, never JSON arrays of numbers.

## Wave 1 — explorer core (`explorer.rs`, events agent)

### `explorer_bodies() -> BodyInfo[]`

```json
[{"body": "Moon", "kind": "moon", "navigational": true, "magnitude": null}]
```

`kind` is `"sun" | "moon" | "planet" | "star"`. `navigational` is true for the Sun, the
Moon, Venus, Mars, Jupiter, Saturn and the 58 stars. `magnitude` is the catalogue
magnitude for stars and `null` otherwise.

### `explorer_coverage() -> ExplorerCoverage`

```json
{"start_utc": "1990-01-01T00:00:00Z", "end_utc": "2060-12-31T23:59:59Z",
 "groups": [{"name": "Moon", "provider": "skyfix-moon (…)", "accuracy_arcmin": 0.05,
             "validated": true, "notes": "…", "bodies": ["Moon"]}]}
```

`validated` is true only when the group's accuracy claim is backed by a fixture test.
The UI offers a body for sights only when its group is validated.

`bodies` (optional, recommended; added 2026-09-24 by the shell-core agent) lists the
canonical names the group covers, so the UI can find a body's group without guessing
(`Sky::coverage_groups()` already carries them in `Coverage::bodies`). When it is
absent the UI falls back to matching the group name against the body's kind (a group
named like "Sun", "Moon", "Planets" or "Stars").

### `sky_state(observer_json, jd_utc, bodies_json) -> SkyState`

```json
{
  "jd_utc": 2461308.0, "utc": "2026-09-24T12:00:00.000Z",
  "gha_aries_deg": 183.2,
  "sun_altitude_deg": 41.3,
  "sky_phase": "day",
  "bodies": [BodyState],
  "errors": []
}
```

`sky_phase` is `"day" | "civil" | "nautical" | "astronomical" | "night"` from the Sun's
topocentric geometric altitude (CONVENTIONS §13.4).

`BodyState`:

| field | meaning |
|---|---|
| `body`, `kind` | as in `explorer_bodies` |
| `gha_deg`, `dec_deg`, `sha_deg`, `ra_deg` | apparent geocentric of date (CONVENTIONS §7) |
| `gp` | ground point `{"lat_deg": dec, "lon_deg": -GHA wrapped to (-180, 180]}` |
| `alt_deg`, `az_deg` | topocentric **geometric** altitude and azimuth of the centre (WGS84 site, parallax applied, no refraction) |
| `alt_apparent_deg` | `alt_deg` plus display refraction (§13.2) — what the eye sees |
| `hc_deg`, `zn_deg` | the navigation computed altitude and azimuth at the observer from `gha_deg`/`dec_deg` (CONVENTIONS §3, geocentric, no parallax) |
| `above_horizon` | `alt_apparent_deg + semidiameter > 0` (upper limb above the sea-level horizon) |
| `distance_km` | geocentric distance; `null` for stars |
| `semidiameter_arcmin`, `horizontal_parallax_arcmin` | geocentric; `0` for stars |
| `magnitude` | apparent visual magnitude; `null` if not modelled |
| `phase_angle_deg`, `illuminated_fraction`, `elongation_deg` | Moon and planets; `null` otherwise. Elongation is the Sun–body angle seen from Earth |
| `bright_limb_angle_deg` | position angle of the midpoint of the bright limb, from celestial north through east (Moon and planets; `null` otherwise) |
| `parallactic_angle_deg` | parallactic angle at the observer, so the UI can rotate the phase into the horizon frame (`bright_limb_angle_deg − parallactic_angle_deg` is measured from the zenith) |
| `constellation` | IAU abbreviation (e.g. `"Leo"`), from `skyfix-starfield`; `null` until that crate lands |

### `sample_bodies(observer_json, bodies_json, jd_start, jd_end, step_minutes) -> Sampled`

For paths on the map and charts. At most 20 000 samples per body.

```ts
{ jd_utc: Float64Array,
  bodies: [{ body: string, alt_deg: Float64Array, alt_apparent_deg: Float64Array,
             az_deg: Float64Array, gha_deg: Float64Array, dec_deg: Float64Array }],
  errors: [{ body: string, message: string }] }
```

### `day_events(observer_json, jd_start, jd_end, bodies_json, options_json) -> DayEvents`

The caller chooses the window (the UI uses local midnight to local midnight in the
display time zone). `options_json`: `{"horizon": "standard" | "dip", "height_of_eye_m": 0}`
(CONVENTIONS §13.3).

```json
{
  "jd_start": 2461307.7, "jd_end": 2461308.7,
  "phases": [{"jd_start": 2461307.7, "jd_end": 2461307.9, "phase": "night"}],
  "bodies": [{
    "body": "Sun",
    "events": [{"kind": "rise", "jd_utc": 2461307.96, "utc": "…", "alt_deg": -0.83, "az_deg": 89.6}],
    "always_above": false, "always_below": false,
    "day_length_h": 12.08
  }],
  "errors": []
}
```

- `phases` is a contiguous, time-ordered cover of the whole window.
- Event `kind` for the Sun: `astronomical_dawn`, `nautical_dawn`, `civil_dawn`, `rise`,
  `transit`, `set`, `civil_dusk`, `nautical_dusk`, `astronomical_dusk`, `lower_transit`.
  For every other body: `rise`, `transit`, `set`, `lower_transit`. Events are sorted by
  time; a kind may occur zero, one or two times in a window.
- `always_above` / `always_below`: the body never crosses its rise/set altitude inside
  the window. `day_length_h` is the Sun's time above its rise/set altitude inside the
  window, `null` for other bodies.

### `day_events_batch(observer_json, windows_json, bodies_json, options_json) -> DayEvents[]`

`windows_json` is `[[jd_start, jd_end], …]`, at most 400 windows (a year of days).

### `find_altitude(observer_json, body, jd_start, jd_end, altitude_deg) -> TimeEvent[]`

Every instant in the window when the body's **apparent** topocentric altitude crosses
`altitude_deg`, each `{"jd_utc", "utc", "alt_deg", "az_deg", "rising": bool}`. SunCalc's
"reverse calculation" in navigator form: "when is the Sun at 30° this afternoon?"

### `moon_phases(jd_start, jd_end) -> PhaseEvent[]`

`[{"kind": "new_moon" | "first_quarter" | "full_moon" | "last_quarter", "jd_utc", "utc"}]`.

### `seasons(year) -> SeasonEvent[]`

`[{"kind": "march_equinox" | "june_solstice" | "september_equinox" | "december_solstice", "jd_utc", "utc"}]`.

### `sidereal(jd_utc) -> {"gha_aries_deg": number}`

Cheap; the Sky view calls it every frame. Local sidereal angle = `gha_aries + lon_east`.

## Wave 1 — star field (`starfield.rs`, star-field agent)

### `starfield_catalog() -> StarfieldCatalog`

Called once. Display-only data (CONVENTIONS §13.6).

```ts
{
  count: number,
  hr: Int32Array,          // Bright Star Catalogue number per star
  vmag: Float32Array,      // visual magnitude
  bv: Float32Array,        // B−V colour index (NaN when unknown)
  names: { index: number, name: string }[],        // proper names for the brighter stars
  designations: string[],  // e.g. "α Ori", "58 Ori", "" when none — one per star
  navigational: { name: string, index: number }[], // the 58 stars' indices in this catalogue
  constellations: { abbr: string, name: string, lines: [number, number][],
                    label_ra_deg: number, label_dec_deg: number }[],
  source: string,          // provenance, one sentence
  licence: string          // e.g. "U.S. Government Work (public domain)"
}
```

### `starfield_apparent(jd_utc) -> Float64Array`

Length `2 × count`: `[ra_rad, dec_rad, …]`, apparent geocentric of date, the same frame
as `sky_state`. The UI recomputes at most once per simulated hour and does the
alt/az rotation itself from `sidereal()`.

### `constellation_at(ra_deg, dec_deg, jd_utc) -> string`

IAU abbreviation of the constellation containing an apparent-of-date direction.

### `constellation_boundaries() -> { abbr: string, ra_deg: Float64Array, dec_deg: Float64Array }[]`

Boundary polylines at J2000, for drawing. Optional in wave 1.

## Wave 1 — navigation methods (`nav.rs`, navigation agent)

Specified by the navigation agent in this section: noon sight, Polaris latitude,
averaging a run of sights, running fix. Inputs reuse the session JSON types.

## Wave 2 — Moon and planet sights (`navsky.rs`, navigation-Moon agent)

Predicted sextant readings, lunar distance and tonight's sights. TypeScript mirror:
`NavSkyEngine` in `web/src/next/engine/types.ts`. Methods and validation:
`docs/NAVIGATION_SKY.md`; numeric rules: CONVENTIONS sections 1, 5, 7 and 13.1.

Common to all four:

- Every direction comes from the same astronomy `reduce`/`solve` use with
  `ephemeris_mode = "auto"`: the Sun, the Moon, Venus, Mars, Jupiter and Saturn (Venus at
  its **centre of light**, CONVENTIONS section 7) and the stars. Mercury, Uranus and
  Neptune throw "… is not offered for sights …".
- **Sight observer** (`observer_json`, Rust `SightObserver`):
  `{"lat_deg": 38.9, "lon_deg": -74.8, "height_of_eye_m": 3, "pressure_hpa": 1010, "temperature_c": 10}`.
  Only `lat_deg`/`lon_deg` are required (defaults 0 m, 1010 hPa, 10 °C).
  `height_of_eye_m` is the **height of eye** (dip), not the site's height; an explorer
  `height_m` field is ignored.
- **Instrument** (`instrument_json`, Rust `Instrument`):
  `{"index_correction_arcmin": -1.2, "horizon": "sea" | "artificial_reflected" | "electronic_vertical", "name": ""}`.
  Every field defaults (0, `"sea"`), and an empty string means all defaults.
- Malformed input and a body that cannot be computed **throw** a string (these are
  single-body calls, unlike `sky_state`).

### `sight_bodies() -> SightBodyInfo[]`

`[{"body": "Sun", "kind": "sun"}, {"body": "Moon", "kind": "moon"}, {"body": "Venus", "kind": "planet"}, …, {"body": "Acamar", "kind": "star"}, …]`
— every body offered for sights: navigational and with a validated provider
(`accuracy_arcmin ≤ 0.1`, CONVENTIONS 13.7), Sun, Moon, the four planets, then the stars
in catalogue order.

### `predict_sextant(observer_json, instrument_json, body, limb, jd_utc) -> PredictedSight`

What the sextant will read: the correction chain run in reverse from the computed
altitude. `limb` is `"lower" | "upper" | "center"` (a limb on a planet or star is
ignored with a `limb_ignored_for_star` warning).

| field | meaning |
|---|---|
| `body`, `jd_utc`, `utc`, `limb`, `horizon` | as asked (canonical name) |
| `direction_source` | the provider that gave the direction |
| `gha_deg`, `dec_deg`, `semidiameter_arcmin`, `horizontal_parallax_arcmin` | apparent geocentric (Venus: centre of light) |
| `hc_deg`, `zn_deg` | computed altitude and true azimuth at the observer (CONVENTIONS §3) |
| `hs_deg` | **the sextant reading** (the double angle with a reflected artificial horizon) |
| `ha_deg` | apparent altitude after index correction and dip (or halving) |
| `corrections` | a `CorrectionBreakdown` (the existing session type): the forward chain from `hs_deg`, six steps, `ho_deg` equal to `hc_deg` to 1e-9 deg |
| `warnings` | `Warning[]` (low altitude, limb ignored, …) |

Throws when the body is below the lowest altitude the horizon lets a sextant show
("… is below the visible horizon here …").

### `lunar_distance(input_json) -> LunarDistanceResult`

`input_json` (Rust `LunarDistanceInput`):

```json
{
  "observer": {"lat_deg": 23.1443, "lon_deg": -103.1079, "height_of_eye_m": 10},
  "instrument": {"index_correction_arcmin": -1.5, "horizon": "sea"},
  "body": "Venus",
  "utc_estimate": "2029-10-17T01:05:43Z",
  "distance_deg": 74.240349,
  "moon_limb": "near",
  "body_limb": null,
  "moon_altitude": {"altitude_deg": 49.267192, "altitude_kind": "sextant_hs", "limb": "lower", "sigma_arcmin": 1.0},
  "body_altitude": null,
  "sigma_arcmin": 0.2,
  "search_hours": 12,
  "dr_uncertainty_nm": 0
}
```

(Case `lunar-19` of `fixtures/reference/lunar_distances.json`: the answer is
2029-10-17T01:15:25Z, 9 min 42 s after the watch's estimate.)

`observer` is the DR position. `distance_deg` is the sextant reading of the distance
(the index correction is added). `moon_limb` is `"near"` (default) or `"far"`;
`body_limb` defaults to `"near"` for the Sun and `"center"` otherwise. Observed
altitudes are optional, per body; without one the altitude is computed from the DR
position at every trial instant (then the answer depends on the DR, as
`dr_sensitivity_arcmin_per_10nm` reports). `sigma_arcmin` (default 0.2′) is the
distance's measurement sigma; `search_hours` (default 12, at most 48) is the half-width
of the search around `utc_estimate`; `dr_uncertainty_nm` (default 0) adds the DR's
effect to the budget.

| field | meaning |
|---|---|
| `body`, `jd_utc`, `utc` | the instant at which the cleared distance equals the geocentric one |
| `utc_minus_estimate_s` | found UTC minus `utc_estimate`: the correction to add to the watch |
| `sigma_s` | 1-sigma of the UTC, seconds (all of `error_budget` in quadrature over the rate) |
| `longitude_sigma_arcmin`, `longitude_sigma_nm` | the longitude uncertainty that implies (15′ of longitude per minute of time; NM at the DR latitude) |
| `apparent_distance_deg` | reading + IC + semidiameters: apparent distance between the centres |
| `cleared_distance_deg` | the geocentric distance after refraction and parallax |
| `distance_rate_arcmin_per_min` | how fast the geocentric distance changes (±0.3 to 0.6) |
| `clearing` | `[{kind, before_deg, after_deg, delta_arcmin, note}]`, kinds `index_correction`, `moon_semidiameter`, `body_semidiameter`, `refraction`, `parallax` |
| `altitudes` | `{moon_source, body_source ("observed" \| "computed"), moon_apparent_deg, body_apparent_deg, moon_true_deg, body_true_deg, moon_azimuth_deg, body_azimuth_deg, moon_computed_apparent_deg, body_computed_apparent_deg}` |
| `error_budget` | `[{name, distance_arcmin, time_s}]`: measurement, ephemeris, refraction model, low altitude, observed altitudes, DR position |
| `dr_sensitivity_arcmin_per_10nm` | `[north, east]`: how far the cleared distance moves per 10 NM of DR error |
| `alternatives` | `[{jd_utc, utc}]` other instants in the window with the same distance (a warning says so) |
| `warnings`, `notes` | `Warning[]` and plain sentences |

Throws when no instant in the window gives the distance ("… never equals …"), and for
the Moon as the body or the Moon's centre as its limb.

### `plan_sights(observer_json, jd_start, jd_end, instrument_json) -> SightPlan`

Tonight's sights: the next evening and the next morning nautical twilight in
`[jd_start, jd_end]` (at most 7 days), and for each the 3 to 5 bodies to shoot.

```ts
{ observer, jd_start, utc_start, jd_end, utc_end,
  windows: TwilightPlan[],          // time order; empty in polar day or night
  notes: string[] }
```

`TwilightPlan`:

| field | meaning |
|---|---|
| `kind` | `"evening"` (Sun from −6° down to −12°) or `"morning"` (−12° up to −6°), the Sun's centre, topocentric, geometric (CONVENTIONS 13.3) |
| `jd_start`, `utc_start`, `jd_end`, `utc_end` | the window; when the Sun never reaches −12° it ends (evening) or begins (morning) at the Sun's lowest point, with a note |
| `jd_predicted`, `utc_predicted` | the instant the predictions refer to: the window's start (or `jd_start` when the twilight had begun) |
| `sun_altitude_deg` | the Sun's altitude then |
| `limiting_magnitude` | 1.5 at −6°, 3.0 at −12°, linear between; relaxed to 3.0 when fewer than three bodies qualify |
| `sights` | `RecommendedSight[]` in shooting order: `{body, kind ("moon" \| "planet" \| "star"), magnitude, step, limb (the Moon's lit limb; "center" otherwise), hc_deg, zn_deg, hs_deg, rationale, prediction: PredictedSight}` |
| `also_eligible` | bright and high enough, not chosen |
| `plan` | the planner's `Plan` for the chosen bodies (shooting order, predicted fix quality, disclosures) |
| `notes` | plain sentences (brightness rule, exclusions, the choice) |

The bodies are the subset (of those between 15° and 75° and bright enough) with the best
spread round the horizon — the smallest fix error when a shared altitude error (dip,
index error, refraction) is unknown too (`planner::best_spread_subset`).

## Wave 2 — almanac pages (`almanac.rs`)

Specified by the almanac agent.

## Wave 2 — eclipses (`eclipses.rs`)

Specified by the eclipse agent.
