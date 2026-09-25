# Explorer engine — wire contract

**Status:** normative. The Rust side is `crates/skyfix-wasm/src/{explorer,starfield,nav,navsky,almanac,eclipses,planet_events,misfit}.rs`;
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
  arrives quoted: `["Sun","Moon"]` or `"all"` (what `JSON.stringify` produces). A
  bare group name (`all`) and a single body name (`"Moon"`) are accepted too.
  Duplicates are dropped; an unknown name throws.
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
topocentric geometric altitude (CONVENTIONS §13.4). Because `sun_altitude_deg` and
`sky_phase` are defined by the Sun, `sky_state` **throws** when the Sun itself cannot be
computed at `jd_utc` (outside its coverage); the UI keeps time inside
`explorer_coverage()`'s range. `gha_aries_deg` is taken from the Sun's own state
(`GHA + RA`), so it is consistent with every GHA in the same response.

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
| `constellation` | IAU abbreviation (e.g. `"Leo"`) of the constellation containing the body's apparent direction, from `skyfix-starfield`'s display-only boundaries (joined in the WASM layer, CONVENTIONS §13.6); `null` only if the boundaries cannot place it |

### `sample_bodies(observer_json, bodies_json, jd_start, jd_end, step_minutes) -> Sampled`

For paths on the map and charts. At most 20 000 samples per body. Samples are at
`jd_start + k·step` for `k = 0, 1, …` while not after `jd_end`. Long requests are
interpolated between exact evaluations (every 3 h for the Moon, 4 h for the planets,
8 h for the Sun and stars) and agree with `sky_state` at the same instant to under
0.01″.

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
- An event's `alt_deg`/`az_deg` are those of the body at that instant (within 0.01″ of
  `sky_state`); at a rise or set `alt_deg` is the `h0` used.
- The window is at most 400 days. `phases` need the Sun, so `day_events` **throws** when
  the Sun cannot be computed over the whole window; any other body that cannot be goes
  to `errors`.

### `day_events_batch(observer_json, windows_json, bodies_json, options_json) -> DayEvents[]`

`windows_json` is `[[jd_start, jd_end], …]`, at most 400 windows (a year of days).
A window the Sun cannot cover (outside the providers' coverage) does not fail the batch:
its entry has empty `phases` and `bodies` and the reason in `errors`. Malformed input
still throws.

### `find_altitude(observer_json, body, jd_start, jd_end, altitude_deg) -> TimeEvent[]`

Every instant in the window when the body's **apparent** topocentric altitude crosses
`altitude_deg`, each `{"jd_utc", "utc", "alt_deg", "az_deg", "rising": bool}`. SunCalc's
"reverse calculation" in navigator form: "when is the Sun at 30° this afternoon?"
`alt_deg` here is, like everywhere else, the **geometric** altitude at that instant
(the requested apparent altitude minus the display refraction). Throws when the body
cannot be computed over the window (at most 400 days).

### `moon_phases(jd_start, jd_end) -> PhaseEvent[]`

`[{"kind": "new_moon" | "first_quarter" | "full_moon" | "last_quarter", "jd_utc", "utc"}]`.
Throws when the Moon (or the Sun) cannot be computed over the whole window (outside
1990–2060).

### `seasons(year) -> SeasonEvent[]`

`[{"kind": "march_equinox" | "june_solstice" | "september_equinox" | "december_solstice", "jd_utc", "utc"}]`.
`year` must be a whole number inside the Sun's coverage (1990–2060), or it throws.

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

As delivered (star-field agent, 2026-09-24):

- 9 095 stars in HR order: every stellar entry of the Bright Star Catalogue (to about
  V 6.5, some to V 8) except the recurrent nova T CrB, which the catalogue lists at its
  outburst peak. Indices are positions in these arrays and are stable for a build.
- `names`: 252 entries sorted by `index`. The 58 navigational stars carry the Nautical
  Almanac spelling used everywhere else ("Al Na'ir", "Rigil Kentaurus").
- `designations`: a Bayer letter wins over a Flamsteed number; superscripts are
  Unicode (`"α¹ Cru"`). About two thirds of the stars have neither and get `""`
  (show `"HR " + hr` instead).
- `navigational`: in `explorer_bodies()` star order, matched by position and magnitude
  (not by name), so it is the star the ephemeris means.
- `constellations`: 88 entries in IAU order. `lines` index the star arrays (this
  project's own figures). `label_ra_deg` / `label_dec_deg` are an **ICRS (J2000)**
  direction inside the boundary; carry it into the frame of date with
  `starfield_frame_matrix`, like the boundaries.

### `starfield_apparent(jd_utc) -> Float64Array`

Length `2 × count`: `[ra_rad, dec_rad, …]`, apparent geocentric of date, the same frame
as `sky_state`. The UI recomputes at most once per simulated hour and does the
alt/az rotation itself from `sidereal()`.

RA is `[0, 2π)`. The chain is exactly `sky_state`'s for the navigational stars (proper
motion, bias-precession-nutation, parallax, solar deflection, aberration). Answers for
1800–2200 (validated 1990–2060); throws for a non-finite time or one outside that range.
About 1.1 ms in WebAssembly.

### `constellation_at(ra_deg, dec_deg, jd_utc) -> string`

IAU abbreviation of the constellation containing an apparent-of-date direction.

The direction is rotated into the mean equator and equinox of B1875.0 (the frame of the
IAU boundaries) and looked up there; aberration is not removed, so the answer is the
region the direction points into. RA outside `[0, 360)` is wrapped; throws for
non-finite input or `|dec_deg| > 90`. Cheap after the first call at a given `jd_utc`
(about 1.3 µs in WebAssembly; 5 µs for a new instant), so `sky_state` can label every
body.

### `constellation_boundaries() -> { abbr: string, ra_deg: Float64Array, dec_deg: Float64Array }[]`

Boundary polylines at J2000, for drawing. Optional in wave 1.

As delivered: 89 closed polylines (the last point repeats the first; Serpens has two,
Caput and Cauda, both `"Ser"`), ICRS degrees, RA `[0, 360)`, consecutive points at most
1° apart (about 9 800 points in all). An edge shared by two constellations appears in
both. RA jumps across 0°/360° are the caller's to handle when projecting.

### `starfield_frame_matrix(jd_utc) -> Float64Array` (addition, star-field agent)

Length 9, row-major: the rotation from ICRS (J2000) to the true equator and equinox of
date (frame bias, precession, nutation), `v_date[i] = Σ_j m[3i + j] · v_icrs[j]`. It
carries `constellation_boundaries()` and the label positions into the frame of
`starfield_apparent`, so the Sky view needs no precession of its own (EXPLORER_PLAN
§3.1). It leaves out annual aberration (at most 20.5″), which moves each star's light
rather than rotating the sky. Same time range and errors as `starfield_apparent`.
Optional in the TypeScript interface (`starfieldFrameMatrix?`), so existing engine
implementations keep compiling.

## Wave 1 — navigation methods (`nav.rs`, navigation agent)

What each method computes, and why, is `docs/NAVIGATION_METHODS.md`; this section is the
wire. TypeScript: the `NavEngine` interface and the types after it in
`web/src/next/engine/types.ts`. Rust: the shapes live in `skyfix_core::types`
("Navigation methods") except the running fix's, which live in `skyfix_motion::request`
(re-exported unchanged by `skyfix_wasm::nav`).

**Common to all four.**

- Signature `(session_json, method_json, ephemeris_mode) -> Result`. `session_json` is a
  `skyfix.session/1` document (CONVENTIONS §10) holding the sights; it is validated
  exactly as `solve` validates it. `ephemeris_mode` is `"auto"` (a supplied `geocentric`
  wins, otherwise the bundled Sun and star providers) or `"supplied"`, exactly as `reduce`
  and `solve` take it. `method_json` may be `""` or `"{}"` for all defaults (the running
  fix needs its legs).
- **These are not `jd_utc` exports.** Instants are RFC 3339 `utc` strings, as in the
  session; results carry both `utc` (milliseconds, `Z`) and `jd_utc`. Every instant in a
  result, and every `reference_utc` in a request, is on the same scale as the sights
  after the session's `clock.correction_s`.
- Every result carries `sights: ReducedSight[]` (the correction workings, one per
  observation used) and `warnings: Warning[]` (CONVENTIONS §12; the codes added for these
  methods are listed in `docs/NAVIGATION_METHODS.md` §1). A rejected observation is a
  `{"code": "other"}` warning, not an error; an error is thrown only when nothing usable
  is left or an input is malformed.
- `DrPosition` is `{"lat_deg", "lon_deg", "sigma_nm": number | null}` — `sigma_nm` the
  1-sigma DR error in each of north and east, `null`/absent meaning not stated. Every
  method's `dr` defaults to the session's `observer.assumed_position` (and its prior
  `sigma_nm` when `assumed_position_role` is `prior`). The DR is never a prior on the
  answer.
- `VesselMotion` is `{"course_deg", "speed_kn"}`, constant over the run; a speed beyond
  1000 kn either way throws.
- Shared result pieces: `LatitudeEstimate {lat_deg, sigma_arcmin}`;
  `LongitudeEstimate {lon_deg, sigma_arcmin, sigma_nm, clock_sigma_arcmin}` (sigma in
  arcminutes *of longitude* and as nautical miles east–west, clock term included);
  `TimeEstimate {utc, jd_utc, sigma_s}`;
  `RunResidual {id, utc, jd_utc, minutes, ho_deg, model_deg, residual_arcmin, normalized,
  normalized_loo, used, outlier}` (`minutes` from the method's reference instant;
  `normalized_loo` is `null` except in averaging);
  `CurvePoint {jd_utc, minutes, altitude_deg}` for drawing the fitted curve.

### `noon_sight(session_json, options_json, ephemeris_mode) -> NoonSightResult`

All observations must be of one body (else it throws). `options_json`:

```json
{"dr": {"lat_deg": 39.8, "lon_deg": -44.6, "sigma_nm": 10},
 "vessel": {"course_deg": 45, "speed_kn": 10},
 "body_bearing": "auto",
 "curvature": "predicted",
 "single_altitude": "maximum"}
```

`body_bearing`: `"auto" | "north" | "south"` (which side of the zenith the body crossed;
`auto` decides from the DR). `curvature`: `"predicted"` (exact curve, default) or
`"fitted"` (free parabola, three or more sights). `single_altitude` (one observation):
`"maximum"` (the recorded peak, default) or `"ex_meridian"` (an altitude at the recorded
time, reduced on the DR meridian). A DR is required.

```json
{
  "body": "Sun", "method": "curve_fit", "n_sights": 21, "side": "south",
  "latitude": {"lat_deg": 39.952583, "sigma_arcmin": 0.109},
  "meridian_altitude_deg": 49.775097, "declination_deg": -0.272320, "zenith_distance_deg": 40.224903,
  "latitude_rule": "The Sun crossed your meridian SOUTH of the zenith, so latitude = declination + zenith distance, counting north as positive: −0°16.3′ + 40°13.5′ = +39°57.2′ (39°57.2′ N). Zenith distance = 90° − meridian altitude 49°46.5′.",
  "meridian_passage": {"utc": "2026-09-23T16:52:57.689Z", "jd_utc": 2461307.2034455, "sigma_s": 6.98},
  "longitude": {"lon_deg": -75.165190, "sigma_arcmin": 1.747, "sigma_nm": 1.339, "clock_sigma_arcmin": 0},
  "longitude_caveat": "Near noon the Sun's height hardly changes: for about 5 minutes either side of the peak it is within 1′ of its highest. …",
  "longitude_sensitivity_arcmin_per_nm": null,
  "maximum": {"utc": "2026-09-23T16:52:45.172Z", "jd_utc": 2461307.2033006, "altitude_deg": 49.775125,
              "seconds_after_passage": -12.5},
  "curvature": {"predicted_arcmin_per_min2": 0.03886, "rate_at_passage_arcmin_per_min": -0.0162,
                "max_minus_meridian_arcmin": 0.0017, "fitted_arcmin_per_min2": 0.03886,
                "fitted_sigma_arcmin_per_min2": 0.00083, "z": 0.0, "consistent": true},
  "alternative": {"method": "curve_fit_free_curvature",
                  "latitude": {"lat_deg": 39.952583, "sigma_arcmin": 0.164},
                  "meridian_altitude_deg": 49.775097,
                  "meridian_passage": {"utc": "2026-09-23T16:52:57.689Z", "jd_utc": 2461307.2034455, "sigma_s": 6.95},
                  "longitude": {"lon_deg": -75.165190, "sigma_arcmin": 1.739, "sigma_nm": 1.333, "clock_sigma_arcmin": 0},
                  "chi2": 0.0, "dof": 18},
  "dr_check": {"predicted_passage_utc": "2026-09-23T16:53:28.912Z", "predicted_passage_jd_utc": 2461307.2038069,
               "predicted_passage_sigma_s": 52.0, "latitude_difference_arcmin": 10.40,
               "longitude_difference_arcmin": 7.81},
  "chi2": 0.0, "dof": 19,
  "residuals": [RunResidual], "model_curve": [CurvePoint],
  "sights": [ReducedSight],
  "warnings": [{"code": "flat_peak_longitude", "body": "Sun", "sigma_time_s": 6.98,
                "sigma_lon_arcmin": 1.747, "sigma_east_nm": 1.339}]
}
```

(The Philadelphia equinox run of `fixtures/reference/nav_methods.json`: 21 noise-free
lower-limb sextant readings of sigma 0.5′, DR 12 NM off with `sigma_nm` 10; the Sun's
declination falling 1′ an hour puts the peak 12.5 s before passage.)

`method`: `"curve_fit" | "curve_fit_free_curvature" | "ex_meridian" | "maximum_altitude"`.
`meridian_passage`, `longitude` and `maximum` are `null` for the single-altitude and
ex-meridian methods, which cannot time the peak; `longitude_caveat` then says why.
`longitude_sensitivity_arcmin_per_nm` is set only for `ex_meridian`. The `curvature`
block's `fitted_*`, `z` and `consistent` are `null` with fewer than three sights.
`alternative` is the computation not chosen (the free-curvature one by default), `null`
when there is none.

### `polaris_latitude(session_json, options_json, ephemeris_mode) -> PolarisResult`

Uses the session's Polaris observations and ignores the rest with a warning.
`options_json`: `{"dr": DrPosition, "vessel": VesselMotion, "reference_utc": "…"}` — the
DR longitude is required; `reference_utc` (default: the last sight) is the instant a
combined latitude refers to.

```json
{
  "latitude": {"lat_deg": 40.807792, "sigma_arcmin": 0.252},
  "reference_utc": "2016-03-22T23:18:56.000Z", "reference_jd_utc": 2457470.4714815,
  "polaris": [{
    "id": "p", "utc": "2016-03-22T23:18:56.000Z", "jd_utc": 2457470.4714815, "ho_deg": 40.868333,
    "gha_deg": 127.861658, "dec_deg": 89.334398, "dr_lon_deg": -43.366667, "lha_deg": 84.494991,
    "azimuth_deg": 359.124,
    "latitude": {"lat_deg": 40.807792, "sigma_arcmin": 0.252},
    "sigma_from_altitude_arcmin": 0.200, "sigma_from_longitude_arcmin": 0.153,
    "sigma_from_clock_arcmin": 0, "longitude_sensitivity_arcmin_per_nm": 0.0153,
    "correction_arcmin": -3.632, "normalized_residual": null,
    "almanac": {"lha_aries_deg": 127.251981, "a0_arcmin": 54.932, "a1_arcmin": 0.524,
                "a2_arcmin": 0.913, "latitude_deg": 40.807803, "difference_arcmin": -0.001,
                "table_latitude_deg": 40.766667, "mean_sha_deg": 316.815, "mean_dec_deg": 89.33185,
                "within_printed_table": true, "note": "Unrounded Nautical Almanac Polaris-table terms: …"}
  }],
  "chi2": null, "dof": 0,
  "sights": [ReducedSight], "warnings": []
}
```

(Bowditch §1912: Ho 40°52.1′ at 2016-03-22T23:18:56Z, DR 40°46.0′ N 43°22.0′ W with
`sigma_nm` 10; the book's answer is 40°48.4′.)

`sigma_from_longitude_arcmin` is `null` when the DR's `sigma_nm` was not stated (a
warning says so). `chi2` and each `normalized_residual` are set when there are several
sights. `almanac` is the Nautical Almanac's `Latitude = Ho − 1° + a0 + a1 + a2`,
unrounded, for teaching; the answer is always the rigorous `latitude`.

### `average_sights(session_json, options_json, ephemeris_mode) -> AveragedSight`

All observations must be of one body. `options_json`:
`{"reference_utc": "…", "dr": DrPosition, "vessel": VesselMotion,
"reject_outliers": true, "outlier_threshold": 3}` — `reference_utc` defaults to the
weighted mean time of the sights used; a DR is required.

```json
{
  "body": "Vega", "utc": "2026-10-01T01:30:00.000Z", "jd_utc": 2461314.5625,
  "ho_deg": 61.072473, "sigma_arcmin": 0.189, "n_used": 7, "n_total": 7,
  "predicted_slope_arcmin_per_min": -11.336, "predicted_slope_sigma_arcmin_per_min": 0.018,
  "predicted_curvature_arcmin_per_min2": 0.0035,
  "chi2": 0.008, "dof": 6,
  "free_slope": {"slope_arcmin_per_min": -11.353, "slope_sigma_arcmin_per_min": 0.189,
                 "ho_deg": 61.072473, "sigma_arcmin": 0.189, "z": -0.09, "consistent": true,
                 "chi2": 0.0, "dof": 5},
  "outliers": [],
  "residuals": [RunResidual], "model_curve": [CurvePoint],
  "observation": {"id": "avg-vega-013000", "body": "Vega", "utc": "2026-10-01T01:30:00.000Z",
                  "altitude_deg": 61.072473, "altitude_kind": "observed_ho", "sigma_arcmin": 0.189,
                  "limb": "center", "horizon": null, "geocentric": null,
                  "notes": "Average of 7 sights (a00, …, a06) at a predicted slope of -11.336′/min; …"},
  "sights": [ReducedSight], "warnings": []
}
```

(Seven noise-free sextant readings of Vega over three minutes, sigma 0.5′, DR 15 NM off
with `sigma_nm` 10.)

`free_slope` is `null` with fewer than four sights in use.
`predicted_slope_sigma_arcmin_per_min` is `null` when the DR's `sigma_nm` was not stated.
`observation` is a session `Observation`, fully corrected, ready to add to a session for
`solve`; it carries a `geocentric` direction only when the run's own were supplied. Its
`utc` is the one instant in a result on the session's chronometer rather than the
corrected scale, like the observations it replaces: the averaged instant minus the
session's `clock.correction_s`, so the reducer, which adds that correction to every
recorded time, brings it back to `utc`/`jd_utc` above exactly once.

### `running_fix(session_json, request_json, ephemeris_mode) -> RunningFixOutput`

The session's sights, advanced along the dead-reckoning track to one instant and solved
(`skyfix-motion`, `docs/MOTION.md`). `request_json`:

```json
{"reference_utc": "2026-10-01T03:00:00Z",
 "legs": [{"start_utc": "2026-10-01T00:00:00Z", "course_deg": 45, "speed_kn": 12},
          {"start_utc": "2026-10-01T02:00:00Z", "course_deg": 90, "speed_kn": 10}],
 "end_utc": null,
 "motion_uncertainty": {"speed_sigma_kn": 0.5, "course_sigma_deg": 2, "random_walk_nm_per_sqrt_hour": 0},
 "options": {}}
```

`legs` is required and non-empty; only the first leg may omit `start_utc` (it then starts
at the earliest sight). Before the first leg and after `end_utc` the vessel is stationary
(the result warns when a sight falls outside the track). `motion_uncertainty` defaults to
all zeros, meaning *not stated*: the fix then treats the run as exact and says so.
`options` is a `SolveOptions` document exactly as `solve` takes it; the session's assumed
position and clock uncertainty fill it as they do for `solve`.

```json
{
  "result": {"kind": "unique", "fix": {"position": {"lat_deg": 40.423957, "lon_deg": -69.444554},
             "sigma_north_m": 1447, "sigma_east_m": 1088, "ellipse95": {…}, …},
             "alternatives": [], "circles": [CircleOfPosition], "warnings": [{"code": "other", …}, …]},
  "reference_utc": "2026-10-01T03:00:00.000Z", "reference_jd_utc": 2461314.625,
  "applied": true, "passes": 2,
  "reference_estimate": {"lat_deg": 40.423161, "lon_deg": -69.444863},
  "inflations": [
    {"id": "r0", "hours_to_reference": 3.0, "run_nm": 36.0, "zn_deg": 45.07,
     "sigma_sight_arcmin": 0.5, "sigma_motion_arcmin": 1.500, "sigma_total_arcmin": 1.581},
    {"id": "r1", "hours_to_reference": 1.5, "run_nm": 18.0, "zn_deg": 172.77,
     "sigma_sight_arcmin": 0.5, "sigma_motion_arcmin": 0.677, "sigma_total_arcmin": 0.841},
    {"id": "r2", "hours_to_reference": 0.0, "run_nm": 0.0, "zn_deg": 290.87,
     "sigma_sight_arcmin": 0.5, "sigma_motion_arcmin": 0.0, "sigma_total_arcmin": 0.5}],
  "sights": [ReducedSight]
}
```

(The rhumb-line case of `fixtures/reference/nav_methods.json`: Schedar, Enif and Vega
taken three hours apart from a vessel making 12 knots on 045, one leg starting at
00:00Z, speed sigma 0.5 kn, course sigma 2°. The truth is 36 m from `position`.)

`result` is the same `FixResult` `solve` returns (unique, ambiguous, underdetermined or
failed), with the running fix's two standing warnings: the sigmas behind it are not the
instrument's, and its covariance is optimistic because the dead-reckoning error is shared
by every sight. `applied` is `false` when no linearisation point could be found and the
sights were solved as if stationary (a warning says so).

## Misfit grid (`misfit.rs`, misfit agent)

The residual heat map: how badly every position in a latitude/longitude box fits the
sights, so ambiguity basins and weak geometry show at a glance. Rust:
`crates/skyfix-wasm/src/misfit.rs` over `skyfix_core::misfit` (CONVENTIONS sections 8-9);
TypeScript: the `MisfitEngine` interface and the `Misfit*` types at the end of `types.ts`,
reached as `engine.misfit`; drawing: `web/src/next/misfit/` (its README).

- **Inputs** are exactly `solve`'s: the session, `ephemeris_mode` and a `SolveOptions`
  document (`"{}"` for defaults), with the session's assumed position and clock
  uncertainty filling the options the same way. Each call reduces and solves once and maps
  that solve.
- **What is mapped** at every node is the solver's own misfit,
  `chi2 = sum w_i ((Ho_i - Hc_i - b) / sigma_i)^2`: the same sights, the same altitude
  components (a node's value agrees with the solver's evaluation there to about 1e-16
  rad). With `estimate_shared_bias` the bias `b` is profiled out at every node (the bias
  that fits that point best). When the solver reweighted (robust weighting and a unique
  fix), its **final** Huber weights `w_i` are held fixed, so the minimum is the robust fix;
  otherwise `w_i = 1`. **A prior is never part of the map** (with a prior the fix is pulled
  toward its centre; the fix without it is the map's best point). The clock uncertainty
  and posterior scaling do not change residuals, so they do not change the map.
- **The best point** `min` is the lowest of the grid's local minima and the solver's
  answers, each polished with the solver's damped Gauss-Newton step; the `levels` are
  measured up from it, even when the grid is too coarse to land a node in the basin or the
  view does not contain it (`min.inside_grid` says which). `grid_min` is the lowest node.
- **Levels**: chi-square quantiles at 68.27 % (1 sigma), 95 % and 99.73 % (3 sigma): 2.30,
  5.99, 11.83 for two unknowns; with the bias estimated, 3.53, 7.81, 14.16 for three (the
  joint region of position and bias seen on the map, wider than the solver's position-only
  95 % ellipse). Nominal, under the independent-noise model.
- **Grid**: nodes from edge to edge, `n_lat` and `n_lon` each 2 to 1024; `chi2` row-major,
  **south row first**. Boxes may cross the antimeridian (`east_deg` below `west_deg`, or
  above 180) and reach the poles (a pole row is one point, one value).
- **Errors** throw a string: a malformed session, options or bounds document, an unknown
  mode, node counts out of range, a session with no usable sight. A sight the reducer
  rejects is left out and named in `notes`.
- **Cost**: natively about 13 ms for 200 x 200 nodes and 10 sights (budget 30 ms); in
  WebAssembly under node about 15 ms, plus the solve each call makes (29 ms for those 10
  sights).

### `misfit_grid(session_json, ephemeris_mode, options_json, bounds_json, n_lat, n_lon) -> MisfitGrid`

`bounds_json` is `{"south_deg", "north_deg", "west_deg", "east_deg"}`, or `""` / `"null"`
for the frame `misfit_default_bounds` gives. The Philadelphia demo at 200 x 200 (arrays
shortened):

```json
{
  "bounds": {"south_deg": 39.86147, "north_deg": 40.04479, "west_deg": -75.27546, "east_deg": -75.03631},
  "crosses_antimeridian": false,
  "n_lat": 200, "n_lon": 200, "lat_step_deg": 0.00092123, "lon_step_deg": 0.00120175,
  "lat_deg": [39.86147, 39.86239, …], "lon_deg": [-75.27546, …],
  "chi2": Float64Array(40000),
  "min": {"lat_deg": 39.953130, "lon_deg": -75.155885, "chi2": 2.2305, "delta_chi2": 0,
          "shared_bias_arcmin": null, "inside_grid": true, "well_determined": true, "converged": true},
  "grid_min": {"i": 100, "j": 100, "lat_deg": 39.953591, "lon_deg": -75.155284, "chi2": 2.2365, "delta_chi2": 0.0059},
  "basins": [MisfitPoint],
  "unknowns": 2, "dof": 3,
  "levels": [{"name": "one_sigma", "label": "68.3 % (1 sigma)", "confidence": 0.682689, "delta_chi2": 2.29575, "chi2": 4.52628},
             {"name": "p95", "label": "95 %", "confidence": 0.95, "delta_chi2": 5.99146, "chi2": 8.22200},
             {"name": "three_sigma", "label": "99.7 % (3 sigma)", "confidence": 0.997300, "delta_chi2": 11.82916, "chi2": 14.05969}],
  "bias_profiled": false, "weighted": false,
  "sights": [{"id": "obs-1", "body": "sim-Alpha", "sigma_arcmin": 0.8, "weight": 1}, …],
  "notes": [],
  "solve_kind": "unique"
}
```

| field | meaning |
|---|---|
| `bounds` | the box used, normalised: `west_deg` in [-180, 180), `east_deg = west_deg + span` (so above 180 across the antimeridian) |
| `lat_deg`, `lon_deg` | node positions; longitudes normalised to (-180, 180], so they jump by -360 across the antimeridian (`bounds.west_deg + j * lon_step_deg` does not) |
| `chi2` | `Float64Array`, `chi2[i * n_lon + j]` at `(lat_deg[i], lon_deg[j])` |
| `min` | the best point; `delta_chi2` of every point and node is measured from it |
| `basins` | distinct polished minima (closer than the solver's `cluster_radius_nm` are one), best first, at most 8. `well_determined` is false along a valley, where the sights fix a line, not a point (one sight, degenerate geometry) |
| `unknowns`, `dof` | 2 (3 with the bias); `dof` = usable sights − unknowns, zero or negative when nothing is redundant |
| `sights[].weight` | multiplier on 1/sigma²: below 1 for a sight the robust fit downweighted |
| `notes` | plain-language caveats for this map: the bias levels, fixed robust weights, a prior left out, the clock, a best point off the grid, a valley, several basins inside the 95 % level, no redundancy, a 95 % region smaller than a cell, rejected sights |
| `solve_kind` | what `solve` returned for the same inputs |

### `misfit_default_bounds(session_json, ephemeris_mode, options_json) -> MisfitDefaultBounds`

The frame `misfit_grid` uses when given none:

```json
{"bounds": {…}, "centre": {"lat_deg": 39.953130, "lon_deg": -75.155885}, "centred_on": "fix",
 "radius_nm": 5.50,
 "reason": "centred on the fix, 5.50 NM each way: 1.6 times the largest of the 3-sigma extent of its covariance (1.79 NM), the cocked hat (3.44 NM) and 3 sigma of the noisiest sight (2.40 NM)",
 "solve_kind": "unique"}
```

- `fix` (unique): 1.6 times the largest of the covariance's 3-sigma extent (without the
  clock's east-west term, which the map does not show), the cocked hat (the farthest
  pairwise crossing of the circles near the fix, counting only circles that cross at 10°
  or more) and 3 sigma of the noisiest sight.
- `candidates` (ambiguous): every candidate within the 95 % margin, with that sigma
  allowance round each and 15 % of the span added on each side (the two-sight demo's frame
  is 2641 NM tall, both basins in it).
- `initializer` (no point fix): round the initializer, 1.5 times past the nearest point of
  the farthest circle; `circle` with no initializer: the whole first circle.
- A frame that reaches a pole takes every longitude.

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
| `hc_deg`, `zn_deg` | computed altitude and true azimuth at the observer (CONVENTIONS §3; the Moon's altitude includes `earth_shape_arcmin`, §15.4) |
| `earth_shape_arcmin` | the Moon's Earth-shape term included in `hc_deg`, arcminutes; 0 for every other body (expansion programme) |
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

Specified by the almanac agent. Definitions: CONVENTIONS 13.9 (and 13.3 for rise, set,
twilight and meridian passage); Rust: `skyfix_almanac::pages`; TypeScript: the
`AlmanacEngine` interface and the `Almanac*` types at the end of
`web/src/next/engine/types.ts`, implemented by the WASM engine and the mock. The
existing interfaces are unchanged; the memoised engine (`component.ts`) forwards
`almanacDay` when the engine has it, keeping four dates.

### `almanac_day(date) -> AlmanacDay`

`date` is a **UT calendar date** `"YYYY-MM-DD"`, not an instant — the one export that takes
a date rather than a `jd_utc`, because a daily page is a date. Accepted from 1990-01-01 to
2060-12-31 (the ephemeris coverage); throws for anything else, or a malformed date. About
35-40 ms native and 45-55 ms in WebAssembly (the first call of a session about 90 ms: it
also parses the embedded series).

Every tabulated quantity comes twice: the raw value, with its unit in the field name, and
under `printed` the text the page prints, rounded as the printed Nautical Almanac rounds
(CONVENTIONS 13.9). Views show `printed` and never round raw values themselves. Printed
formats: GHA/SHA `"183 12.4"`; Dec `"N 12 34.5"` / `"S 0 42.3"`; v, d, HP, SD `"14.1"`
(`d` without sign, `v` with `-` when negative); magnitude `"-4.0"` / `"+1.3"`; times
`"06 42"`, `"24 05"` (the next date), `"-00 02"` (before 00h); Aries' passage
`"23 44.7"`; equation of time `"07 48"` (the sign is the raw value's).

```ts
AlmanacDay {
  date: "2026-09-24", weekday: "Thursday",
  jd_utc,          // 00h UT of the date
  noon_jd_utc,     // 12h UT: the instant of every once-a-day value
  hours: [{        // 24 rows, 00h..23h
    hour, jd_utc, utc,
    aries:   { gha_deg, printed: { gha } },
    sun:     { body, gha_deg, dec_deg, printed: { gha, dec } },
    moon:    { gha_deg, dec_deg, v_arcmin, d_arcmin, hp_arcmin,     // v, d: this hour to the next
               printed: { gha, v, dec, d, hp } } | null,
    planets: [{ body, gha_deg, dec_deg, printed: { gha, dec } }]    // order of `planets`
  }],
  aries:  { mer_pass: TableTime },                                  // printed to 0.1 min
  sun:    { sd_arcmin, d_arcmin, eot_00h_s, eot_12h_s, mer_pass: TableTime,
            printed: { sd, d, eot_00h, eot_12h } },
  moon:   { sd_arcmin, mer_pass_upper: TableTime, mer_pass_lower: TableTime,
            age_days: number | null, illuminated_fraction: number | null,
            phase: PhaseEvent | null,                               // a principal phase on the date
            printed: { sd, age, illuminated } } | null,
  planets: [{ body, magnitude, v_arcmin, d_arcmin, sha_deg, mer_pass: TableTime,
              printed: { magnitude, v, d, sha } }],                 // Venus, Mars, Jupiter, Saturn
  stars:   [{ body, sha_deg, dec_deg, magnitude, printed: { sha, dec } }],  // 57 + Polaris
  rise_set: {
    moon_dates: ["2026-09-24", "2026-09-25"],
    rows: [{ lat_deg, label: "N 72",                                // 72 N .. 60 S, 31 rows
             nautical_dawn, civil_dawn, sunrise, sunset, civil_dusk, nautical_dusk: TableTime,
             moonrise: TableTime[2], moonset: TableTime[2] }]
  },
  notes: string[],        // what the page prints under its tables
  errors: BodyError[]     // bodies or phenomena not computed, with the reason
}

TableTime {
  kind: "time" | "above" | "below" | "all_night" | "later" | "unavailable",
  jd_utc: number | null, utc: string | null,
  hours: number | null,   // after 00h UT of the column's date; may be < 0 or >= 24
  printed: string         // "06 42", "24 05", "-00 02", "□", "■", "////", "--", "n/a"
}
```

`age_days` is `null` (printed `"--"`) before the first new moon of the coverage (January
1990). On the last date of the coverage the next date's moonrise and moonset are `n/a`,
and the last hour's `v` and `d` span 23 h 59 min 59 s; `errors` says so.

## Wave 2 — eclipses (`eclipses.rs`)

Specified by the eclipse agent (2026-09-24). Engine: `skyfix_almanac::eclipses`; model,
conventions and validation in `docs/ACCURACY.md`, "Eclipses". TypeScript: the
`EclipseEngine` interface and the `Eclipse*` types at the end of `types.ts`.

- **Ids.** Every eclipse is named by the UTC date of its greatest eclipse and its kind:
  `"2024-04-08-solar"`, `"2025-03-14-lunar"`. Ids are stable (the same date and kind
  never name two eclipses) and are what `eclipse_local` and `eclipse_path` take.
- **Coverage.** The Moon provider's: `1990-01-01T00:00:00Z` to `2060-12-31T23:59:59Z`.
  `eclipses` clips its window to it and says so (`truncated`); an id outside it, or a
  date with no eclipse of that kind, throws `"there is no solar eclipse with greatest
  eclipse on 2024-04-09 (UTC)"`. A malformed id throws too.
- **Time.** Every instant is `jd_utc` + `utc`. Greatest eclipse also carries `jd_tt`, and
  every result its `delta_t_s` (TT − UT1: 69.184 s since 2017, from the leap-second table
  with DUT1 = 0). Gamma, magnitudes, types and TT instants do not depend on it; ground
  positions and local UTC times do (15″ of longitude per second of Delta-T).
- **Conventions** (repeated in `EclipseList.conventions` for the About view): Moon radius
  `k1 = 0.272488` Earth radii for the penumbra and `k2 = 0.272281` for the umbra (NASA's
  values), the Sun's radius 959.63″ at 1 au, lunar shadow by Danjon's rule (NASA's lunar
  canon; the Astronomical Almanac's 1/50 rule gives slightly larger magnitudes).
  Altitudes are CONVENTIONS §13.2 (topocentric, geometric, centre); an event is
  `visible` when the body is above its §13.3 rise/set altitude (Sun −50′, Moon
  −(34′ + SD)).

### `eclipses(jd_start, jd_end) -> EclipseList`

Every solar and lunar eclipse whose greatest eclipse falls in the window, sorted by time.
About 0.3 s for all of 1990–2060 natively (320 eclipses); ask for the years on screen.

```json
{
  "jd_start": 2460310.5, "jd_end": 2460676.5, "truncated": false,
  "coverage_start_utc": "1990-01-01T00:00:00Z", "coverage_end_utc": "2060-12-31T23:59:59Z",
  "eclipses": [SolarEclipse | LunarEclipse],
  "conventions": {"moon_radius_k_penumbra": 0.272488, "moon_radius_k_umbra": 0.272281,
                  "lunar_shadow": "Danjon: …", "delta_t": "…", "sources": "…"}
}
```

`SolarEclipse`:

```json
{
  "kind": "solar", "id": "2024-04-08-solar", "type": "total", "central": true,
  "greatest": {"jd_utc": 2460409.262037, "utc": "2024-04-08T18:17:19.972Z", "jd_tt": 2460409.262837,
               "lat_deg": 25.289, "lon_deg": -104.146, "sun_alt_deg": 69.79, "sun_az_deg": 149.39},
  "magnitude": 1.05656, "gamma": 0.34312, "saros": 139, "lunation": 300,
  "contacts": [{"kind": "p1", "jd_utc": 2460409.154328, "utc": "2024-04-08T15:42:13.968Z"},
               {"kind": "u1", "jd_utc": …, "utc": "2024-04-08T16:38:51.279Z"},
               {"kind": "u4", "jd_utc": …, "utc": "2024-04-08T19:55:36.202Z"},
               {"kind": "p4", "jd_utc": …, "utc": "2024-04-08T20:52:20.867Z"}],
  "path_width_km": 197.5, "central_duration_s": 268.0, "delta_t_s": 69.184
}
```

| field | meaning |
|---|---|
| `type` | `"total" \| "annular" \| "hybrid" \| "partial"` (NASA's classification) |
| `central` | the shadow axis meets the Earth. A total or annular eclipse can be non-central (only the edge of the umbra touches, near a pole) |
| `greatest` | the instant the shadow axis passes closest to the Earth's centre; the place is on the central line, or for partial and non-central eclipses the point of the Earth's limb nearest the axis (the Sun is on the horizon there) |
| `magnitude` | central eclipses: Moon/Sun diameter ratio at greatest eclipse; others: fraction of the Sun's diameter covered there |
| `gamma` | axis distance from the Earth's centre at greatest eclipse, Earth equatorial radii, positive north |
| `saros`, `lunation` | NASA's numbering (lunation 0 = the new moon of 2000-01-06) |
| `contacts` | global: `p1`/`p4` the penumbra first/last touches the Earth, `u1`/`u4` the umbra (absent when it never does) |
| `path_width_km`, `central_duration_s` | at the point of greatest eclipse; `null` unless central |

`LunarEclipse`:

```json
{
  "kind": "lunar", "id": "2025-03-14-lunar", "type": "total",
  "greatest": {"jd_utc": 2460748.790814, "utc": "2025-03-14T06:58:46.368Z", "jd_tt": 2460748.791615,
               "lat_deg": 2.682, "lon_deg": -102.251},
  "umbral_magnitude": 1.17843, "penumbral_magnitude": 2.25950, "gamma": 0.34843,
  "saros": 123, "lunation": 311,
  "contacts": [{"kind": "p1", "jd_utc": …, "utc": "2025-03-14T03:57:28.366Z"}, {"kind": "u1", …},
               {"kind": "u2", …}, {"kind": "u3", …}, {"kind": "u4", …}, {"kind": "p4", …}],
  "penumbral_duration_s": 21760.2, "partial_duration_s": 13095.7, "total_duration_s": 3924.1,
  "delta_t_s": 69.184
}
```

`type` is `"total" | "partial" | "penumbral"`; `greatest.lat_deg`/`lon_deg` is where the Moon
is overhead; magnitudes are the fraction of the Moon's diameter inside the umbra or
penumbra (negative umbral magnitude: the Moon misses the umbra); gamma is the Moon's
distance from the shadow axis in Earth radii, positive north. Contacts and durations are
the same everywhere on Earth; `null` durations mean that phase does not happen.

### `eclipse_local(id, observer_json) -> EclipseLocal`

What one observer sees (`observer_json` as in "Common rules"; `height_m` counts).

Solar:

```json
{
  "kind": "solar", "id": "2024-04-08-solar",
  "observer": {"lat_deg": 32.78, "lon_deg": -96.8, "height_m": 150},
  "visibility": "visible", "local_type": "total",
  "magnitude": 1.01471, "obscuration": 1.0,
  "duration_s": 9562.5, "central_duration_s": 230.5,
  "events": [
    {"kind": "c1", "jd_utc": 2460409.224520, "utc": "2024-04-08T17:23:18.533Z", "alt_deg": 60.570,
     "az_deg": 145.316, "visible": true, "position_angle_deg": 226.22, "vertex_angle_deg": 255.08,
     "magnitude": null, "obscuration": null},
    {"kind": "c2", "utc": "2024-04-08T18:40:43.429Z", …},
    {"kind": "max", "utc": "2024-04-08T18:42:38.708Z", …, "magnitude": 1.01471, "obscuration": 1.0},
    {"kind": "c3", "utc": "2024-04-08T18:44:33.976Z", …}, {"kind": "c4", …}
  ],
  "visible_max": {"kind": "max", …},
  "delta_t_s": 69.184
}
```

- `visibility`: `"visible"` (the whole eclipse with the Sun up), `"partly_below_horizon"`
  (the Sun rises or sets during it; the `sunrise`/`sunset` event is in `events`, with the
  magnitude at that moment), `"below_horizon"` (it happens here, but with the Sun down
  throughout), `"none"` (outside the penumbra: `events` empty, magnitude 0).
- `local_type`: `"total" | "annular" | "partial" | "none"`. `c2`/`c3` exist only for
  total and annular.
- `magnitude` is the fraction of the Sun's diameter covered at the geometric maximum
  (above 1 inside a total eclipse's path); `obscuration` the fraction of its area.
- `position_angle_deg` / `vertex_angle_deg`: where the limbs touch on the Sun's disc,
  measured from celestial north through east, and from the direction of the zenith in
  the same sense (`vertex = position − parallactic angle`). USNO gives an annular
  eclipse's second and third contacts on the opposite side of the disc; ours is where
  the limbs meet.
- `visible_max`: the most of the eclipse the observer can see — the maximum when the
  Sun is up there, else the sunrise or sunset nearest to it; `null` when nothing is
  visible.

Lunar:

```json
{
  "kind": "lunar", "id": "2025-03-14-lunar",
  "observer": {"lat_deg": 51.5074, "lon_deg": -0.1278, "height_m": 0},
  "visibility": "partly_below_horizon",
  "events": [{"kind": "p1", "utc": "2025-03-14T03:57:28.366Z", "alt_deg": 21.22, "az_deg": 246.01, "visible": true, …},
             {"kind": "u1", …, "alt_deg": 10.50, "visible": true},
             {"kind": "moonset", "utc": "2025-03-14T06:22:57.140Z", "alt_deg": -0.81, …},
             {"kind": "u2", …, "alt_deg": -1.29, "visible": false}, …],
  "delta_t_s": 69.184
}
```

Events are `p1`, `u1`, `u2`, `max`, `u3`, `u4`, `p4` (those that occur), plus `moonrise` /
`moonset` inside the eclipse, sorted by time; `alt_deg`/`az_deg` are the Moon's.

### `eclipse_path(id) -> EclipsePath`

Solar: every line needed to draw the eclipse on the map, each a polyline split at the
antimeridian into GeoJSON-ready segments of `[lon_deg, lat_deg]` pairs, with the UTC
Julian date of every vertex (on the central line that is when greatest eclipse happens
there; on a limit, when it is grazing there). Sampled every two minutes and refined until
the curve is within 0.2 km of every chord and no chord exceeds 150 km. Budget 50 ms;
7–24 ms measured natively for every solar eclipse of 2017–2026.

```json
{
  "kind": "solar", "id": "2024-04-08-solar", "type": "total", "central": true,
  "greatest": {…as in SolarEclipse},
  "central_line":    {"segments": [[[-158.538, -7.822], …]], "jd_utc": [[2460409.194443, …]]},
  "umbra_north":     {…}, "umbra_south": {…},
  "umbra_horizon":   {…},
  "penumbra_north":  {…}, "penumbra_south": {…},
  "penumbra_horizon": {…},
  "delta_t_s": 69.184
}
```

| line | what it is |
|---|---|
| `central_line` | where the shadow axis meets the ground; empty for partial and non-central eclipses |
| `umbra_north`, `umbra_south` | limits of totality (or annularity): the eclipse is just grazing total there at maximum. North is the side to the left of the shadow's motion. A non-central eclipse has one |
| `umbra_horizon` | small closed loops at the sunrise and sunset ends where totality is in progress with the Sun on the horizon; with the limits they enclose the path |
| `penumbra_north`, `penumbra_south` | limits of the partial eclipse |
| `penumbra_horizon` | closed loops where the partial eclipse begins or ends at sunrise or sunset; with the penumbral limits they bound the region that sees any eclipse |

Lunar: the point under the Moon at each contact, so the map can shade the hemisphere
that sees it (the Moon is up within about 89° of that point):

```json
{"kind": "lunar", "id": "2025-03-14-lunar", "type": "total",
 "sublunar": [{"kind": "p1", "jd_utc": 2460748.664912, "utc": "2025-03-14T03:57:28.366Z",
               "lat_deg": 3.413, "lon_deg": -58.145}, …, {"kind": "max", …}, …, {"kind": "p4", …}],
 "delta_t_s": 69.184}
```

## Wave 2 — planet events (`planet_events.rs`)

Specified by the eclipse agent (2026-09-24). Engine: `skyfix_almanac::planet_events`;
definitions and validation in `docs/ACCURACY.md`, "Planet events". TypeScript: the
`PlanetEventsEngine` interface and the `PlanetEvent*` types at the end of `types.ts`.

### `planet_events(jd_start, jd_end) -> PlanetEventList`

Every opposition, conjunction with the Sun, greatest elongation (Mercury and Venus) and
closest approach of Mercury to Neptune whose instant falls in the window, sorted by
time. Geocentric, so the same for every observer. About 30 ms a year natively; ask for
the months on screen. A window that is not finite or ends before it starts throws; one
that reaches outside the coverage (`1990-01-01T00:00:00Z` to `2060-12-31T23:59:59Z`, the
planet provider's) is clipped and says so (`truncated`).

```json
{
  "jd_start": 2461041.5, "jd_end": 2461406.5, "truncated": false,
  "coverage_start_utc": "1990-01-01T00:00:00Z", "coverage_end_utc": "2060-12-31T23:59:59Z",
  "events": [
    {"kind": "superior_conjunction", "body": "Venus", "jd_utc": 2461047.191674,
     "utc": "2026-01-06T16:36:00.648Z", "elongation_deg": 0.711, "distance_au": 1.710911,
     "distance_km": 255948672.7, "magnitude": -3.91, "ra_deg": 287.844, "dec_deg": -23.141,
     "transit": false},
    {"kind": "opposition", "body": "Jupiter", "utc": "2026-01-10T08:42:…Z", "elongation_deg": 179.74, …},
    {"kind": "greatest_elongation_east", "body": "Mercury", "utc": "2026-02-19T17:41:…Z", "elongation_deg": 18.12, …}
  ]
}
```

| `kind` | bodies | the instant when |
|---|---|---|
| `opposition` | Mars to Neptune | the planet's apparent ecliptic longitude of date is the Sun's + 180° (up all night, near its brightest) |
| `conjunction` | Mars to Neptune | it equals the Sun's (behind the Sun, not observable) |
| `inferior_conjunction` | Mercury, Venus | it equals the Sun's with the planet between the Earth and the Sun (phase angle over 90°) |
| `superior_conjunction` | Mercury, Venus | it equals the Sun's with the planet beyond the Sun |
| `greatest_elongation_east` / `_west` | Mercury, Venus | the angle from the Sun is greatest; east = evening sky, west = morning sky |
| `perigee` | all seven | the geocentric (light-time) distance is least: the closest approach |

| field | meaning |
|---|---|
| `elongation_deg` | apparent angle between the planet and the Sun from the Earth's centre at that instant (at a conjunction it is the planet's distance from the Sun's centre: 0.37° is close, a transit needs about 0.27° or less) |
| `distance_au`, `distance_km` | geocentric light-time distance |
| `magnitude` | apparent visual magnitude (Mallama & Hilton 2018, as the planet provider); `null` where that model does not cover the geometry (Saturn beyond phase angle 6.5° or ring tilt 27°). At a conjunction the planet is lost in the Sun's glare whatever its magnitude |
| `ra_deg`, `dec_deg` | apparent geocentric right ascension and declination of date |
| `transit` | inferior conjunctions only: the planet crosses the Sun's disc as seen from the Earth's centre (Mercury 2016-05-09, 2019-11-11, 2032-11-13, …; Venus 2004-06-08, 2012-06-06). Always `false` for other kinds; the local circumstances of a transit are not computed |

Several kinds can fall close together: an outer planet's closest approach is within a
day or two of its opposition (Mars: up to 8.4 days in 1990-2060), and Mercury's and
Venus's within 3.4 and 1 days of their inferior conjunctions. They are separate events
with separate instants.

## Expansion programme — shared contract (planner, 2026-09-24)

Read `EXPANSION_PLAN.md` first. This section fixes the shapes every wave-1 agent builds
against; each agent appends its own section below it, as before. Status: **contract only,
not yet implemented**; the TypeScript mirror is `web/src/next/engine/types.ts` (search for
"Expansion programme"). Owners are named per item; a change to a shape here is made in
the owner's branch and reported prominently.

### Dates and years on the wire (timescales agent)

- Every instant is still `jd_utc` (f64) plus an RFC 3339-style string. Years outside
  0000–9999 use ISO 8601 expanded years, a sign and at least four digits
  (`-0584-05-28T12:00:00Z`, `+12345-01-01T00:00:00Z`); years 0000–9999 stay four digits
  without a sign. Astronomical numbering: year 0 = 1 BC, −584 = 585 BC.
- Wire strings are always **proleptic Gregorian** and always in the app's clock scale named
  by `time_info` (`utc` inside 1972–2035, `ut` outside); the suffix stays `Z`. The Julian
  calendar is a display and input convention of the UI and CLI (`calendar_convert`), never
  the wire format.
- `parse_utc` and `format_utc` in `skyfix_core::time` are the single implementation and
  accept both forms for any year; every other crate calls them. `jd_utc` keeps its name
  even when the scale is UT: it is the instant on the app's clock.

### `explorer_coverage()` — tiers (deeptime agent)

Additive fields; the existing `accuracy_arcmin` and `validated` keep describing the
validated tier, so today's UI keeps working.

```json
{"start_utc": "-2000-01-01T00:00:00Z", "end_utc": "3000-12-31T23:59:59Z",
 "validated_start_utc": "1550-01-01T00:00:00Z", "validated_end_utc": "2650-01-22T00:00:00Z",
 "packs_loaded": ["deep-time"],
 "groups": [{"name": "Moon", "provider": "…", "accuracy_arcmin": 0.05, "validated": true,
             "notes": "…", "bodies": ["Moon"],
             "tiers": [{"tier": "validated", "start_utc": "1550-01-01T00:00:00Z",
                        "end_utc": "2650-01-22T00:00:00Z", "accuracy_arcmin": 0.05},
                       {"tier": "labelled", "start_utc": "-2000-01-01T00:00:00Z",
                        "end_utc": "3000-12-31T23:59:59Z", "accuracy_arcmin": 0.5,
                        "notes": "with the deep-time pack; ΔT uncertainty applies"}]}]}
```

- `start_utc`/`end_utc` are the outermost instants any provider answers **with the packs
  currently loaded** (without `deep-time` they equal the validated band).
- `tier_at(jd_utc) -> "validated" | "labelled" | "outside"` is a cheap query for the UI.
- Sights, the planner and predicted readings refuse the labelled tier with the warning
  `outside_validated_tier` (CONVENTIONS §12 vocabulary).

### `time_info(jd_utc) -> TimeInfo` (timescales agent)

```json
{"jd_utc": 2461308.0, "utc": "2026-09-24T12:00:00.000Z",
 "scale": "utc",
 "tier": "validated",
 "delta_t_s": 69.18, "delta_t_sigma_s": 0.0, "delta_t_source": "iers",
 "tt_minus_clock_s": 69.184,
 "dut1_s": -0.009, "dut1_sigma_s": 0.001, "dut1_source": "iers",
 "calendar": "gregorian",
 "civil": {"calendar": "gregorian", "year": 2026, "month": 9, "day": 24,
           "hour": 12, "minute": 0, "second": 0.0, "era_year": 2026, "era": "AD"},
 "julian_civil": {"calendar": "julian", "year": 2026, "month": 9, "day": 11,
                  "hour": 12, "minute": 0, "second": 0.0, "era_year": 2026, "era": "AD"},
 "notes": []}
```

- `scale`: `"utc"` (1972-01-01 to 2035-12-31) or `"ut"` (outside; UT ≈ UT1).
- `delta_t_source`: `"iers"` (observed), `"smh2016"` (historical splines), `"parabola"`
  (long-term), `"prediction"` (near future). `delta_t_sigma_s` is the standard uncertainty;
  the UI shows "±m min" beside any time when it exceeds 30 s.
- `dut1_source`: `"iers"` (history table), `"user"` (set with `set_dut1`), `"model"` (scale
  `ut`: DUT1 is by definition 0 and UT comes from ΔT), `"assumed"` (0, unknown future).
- `calendar`: the calendar the UI should display for this date (`julian` before
  1582-10-15). `civil` is in that calendar; `julian_civil` is always given so the UI can
  offer both.
- `set_dut1(seconds | null)`: the explorer-wide user value (a session's `clock.dut1_s`
  overrides it for that session). `calendar_convert(request_json) -> CalendarConversion`
  converts between JD and civil dates in either calendar for any year.

### Packs (packs agent owns the mechanism; each producer appends its pack's payload format)

- `packs() -> PackStatus[]`: the registry compiled into the module, e.g.
  `[{"name": "deep-time", "version": "2026-09-24", "label": "Deep time", "description":
  "Positions from 2000 BC to AD 3000", "bytes": 412000, "provides": ["ephemeris:-2000..3000"],
  "loaded": false}]`. `loaded` flips after `load_pack`.
- `load_pack(name, bytes: Uint8Array) -> PackInfo` parses, verifies and installs; throws a
  string when the magic, version, name or checksum is wrong. Idempotent.
- Files: `web/public/data/packs/<name>-<rev>.bin` (content hash in the name), listed in the
  precached `web/public/data/packs/manifest.json` with `{name, version, rev, bytes, label,
  description}`. The app stores a fetched pack in its own cache
  (`skyfix-lab-packs-<schema>@<site>`), never in the precache or the runtime cache, and
  reloads every stored pack into the engine at start-up.
- Binary layout, common header, little-endian: magic `SKYFIXPK` (8 bytes), u16 format
  version (1), u16 name length, name (UTF-8), u32 payload length, payload, u32 CRC-32 of the
  payload. Payload formats are per pack and documented by the producer in its own section.
  No alignment assumptions: readers use byte slices.
- Rust: `skyfix_wasm::packs::install(name, payload) -> Result<PackInfo, String>` dispatches
  to one `install_<pack>` function per producer crate; each producer adds one match arm.
- Mock engine: `packs()` lists the same registry; `load_pack` accepts any bytes.
- Component context: `Ctx` gains `packs: PackService` with `ensure(name, reason) ->
  Promise<boolean>` (prompts once, fetches, stores, loads), `status()`, `remove(name)`.

### Session schema (moonshape agent)

`skyfix.session/1` `clock` gains `dut1_s: number | null` (serde default `null` = the
engine's history or model). Additive; older files still load. Rust:
`skyfix_core::time::dut1_s(jd_utc: f64, user: Option<f64>) -> f64` is the single lookup
(moonshape adds it returning `user.unwrap_or(0.0)`; timescales replaces the fallback with
the IERS history and the model).

## Expansion programme — moonshape (P1): the Moon's Earth-shape term and DUT1

Implemented 2026-09-24 in `agent/moonshape`. Additive throughout: no field was renamed or
removed, and a document without the new fields reads as before.

### The Moon's Earth-shape term (CONVENTIONS §15.4)

- **`ReducedSight`** (`reduce` entries, every method's `sights`) gains
  `horizontal_parallax_arcmin: number` (the direction's HP, 0 for a star) and
  `earth_shape_arcmin: number | null` — the Moon's Earth-shape term included in `hc_deg`
  and `intercept_nm` at the assumed position; `null` for every other body, without an
  assumed position, and for a Moon direction without HP (the reduction then warns, a
  `{"code": "other"}` naming the term). `corrections` and `ho_deg` never include it.
- **`PredictedSight`** (`predict_sextant`, every `plan_sights` recommendation) gains
  `earth_shape_arcmin: number` (0 for every body but the Moon); `hc_deg` includes it, so
  the predicted reading is the real (WGS84) Earth's and `corrections.ho_deg` still equals
  `hc_deg` to 1e-9°.
- **`FixResult`**: every `Residual.hc_deg` and `intercept_nm` of a Moon sight is the model
  altitude with the term at the fix; a Moon `CircleOfPosition.zenith_distance_deg` is
  `90 − (Ho − term)` with the term at the fix (the best candidate when ambiguous, the
  initializer when there is no point fix, none without one), so the plotted circle passes
  through the fix.
- **`NoonSightResult`** for the Moon: `meridian_altitude_deg` is an `Ho` (the sphere's
  plus the term), `zenith_distance_deg` is `90 − (meridian altitude − term)` (so
  `latitude = declination ± zenith distance` still holds exactly), and `latitude_rule`
  states the term. `AveragedSight.observation` of an all-supplied Moon run keeps the
  Moon's HP in its `geocentric` direction.
- **Misfit grid**: the mapped misfit includes the term at every node, exactly as the
  solver evaluates it. **Planner** (`plan`, `plan_sights`): the Moon's candidate altitude
  includes it.

### DUT1 (UT1 − UTC)

- **Session**: `clock.dut1_s: number | null`, seconds, optional (contract above). Omitted
  from a session the core writes when absent; CSV header `# clock.dut1_s=` (empty =
  automatic). `parse_session` refuses a non-finite value or one beyond 60 s, and warns
  beyond 0.9 s.
- **Every session export** — `reduce`, `solve`, `misfit_grid`, `misfit_default_bounds`,
  `noon_sight`, `polaris_latitude`, `average_sights`, `running_fix` — builds its `auto`
  providers once per call with `time::dut1_s(earliest sight, clock.dut1_s)`
  (`skyfix_wasm::nav::session_source`). A GHA moves by 15.04″ per second of DUT1,
  whatever the body.
- **`predict_sextant`, `plan_sights`, `lunar_distance`** take no session: the observer
  document (for `lunar_distance`, the input's `observer`) may carry
  `"dut1_s": number | null`, read at the boundary (it is not a field of the Rust
  `SightObserver`, and a plan does not echo it); `plan_sights` takes one value for its
  whole span, at `jd_start`. Refused like the session's.
- **TypeScript**: `Clock.dut1_s?`, `ReducedSight.horizontal_parallax_arcmin` and
  `earth_shape_arcmin`, `PredictedSight.earth_shape_arcmin`, `SightObserver.dut1_s?`
  (`web/src/types.ts`, `web/src/next/engine/types.ts`); `sightObserverJson` passes
  `dut1_s` on.
