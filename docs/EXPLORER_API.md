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

## Expansion programme — sun tools (`suntools.rs`, suntools agent)

Work package P7 (EXPANSION_PLAN §5), 2026-09-24. Engine: `skyfix_almanac::sun_tools`;
definitions CONVENTIONS 13.10; validation `docs/ACCURACY.md` section 14. TypeScript: the
`SunToolsEngine` interface, `isSunToolsEngine` and the `Sun*`, `Alignment*`, `Analemma*`,
`RiseSet*`, `Eot*`, `Solar*` and `Galactic*` types at the end of `types.ts`; the mock is
`web/src/next/engine/mock-suntools.ts`. Every export throws a string for malformed input
and when the Sun (or the body asked about) cannot be computed; the window rules are the
event finder's (finite, ordered, at most 400 days). Every altitude and azimuth is the
topocentric one of CONVENTIONS 13.2 and equals `sky_state`'s at the same instant.
Timings are native release builds on a shared machine; WebAssembly runs about four times
slower.

### `sun_hours(observer_json, jd_start, jd_end) -> SunHours`

Golden and blue hours over a window (the UI passes one local day), with the Sun's
`day_events` (rise, set, transits, twilight) and the sky phases of the same window, in
one object. About 1 ms.

```json
{"jd_start": 2461307.6667, "jd_end": 2461308.6667,
 "windows": [
   {"kind": "blue", "period": "morning", "jd_start": 2461307.932812, "utc_start": "2026-09-24T10:23:14.924Z",
    "jd_end": 2461307.940077, "utc_end": "2026-09-24T10:33:42.679Z", "duration_min": 10.5,
    "open_start": false, "open_end": false},
   {"kind": "golden", "period": "morning", "utc_start": "2026-09-24T10:33:42.679Z", "utc_end": "2026-09-24T11:25:59.592Z", …},
   {"kind": "golden", "period": "evening", "utc_start": "2026-09-24T22:18:37.868Z", "utc_end": "2026-09-24T23:10:49.475Z", …},
   {"kind": "blue", "period": "evening", "utc_start": "2026-09-24T23:10:49.475Z", "utc_end": "2026-09-24T23:21:15.916Z", …}],
 "boundaries": [
   {"altitude_deg": -6, "crossings": [AltitudeCrossing], "always_above": false, "always_below": false},
   {"altitude_deg": -4, …},
   {"altitude_deg": 6, "crossings": [{"jd_utc": 2461307.976384, "utc": "2026-09-24T11:25:59.592Z",
                                      "alt_deg": 6, "az_deg": 95.81, "rising": true}, …], …}],
 "sun": BodyEvents, "phases": [PhaseSegment]}
```

- `kind`: `golden` (Sun's centre above −4° and not above +6°, geometric) or `blue` (above
  −6°, not above −4°). Blue hour ends exactly at civil dusk.
- `period`: `morning` / `evening` (the Sun climbs / sinks through the band), `midday` (it
  culminates inside it: high-latitude winter), `midnight` (its lower culmination is inside
  it: high-latitude summer), `all_day` (in the band the whole window).
- `open_start` / `open_end`: the band was entered before / left after the window; the
  instant is the window's edge, not a crossing.
- `boundaries`: every crossing of −6, −4 and +6 degrees (in that order) with twilight's
  polar vocabulary: a threshold never crossed is `always_above` or `always_below`.

### `find_azimuth(observer_json, body, jd_start, jd_end, azimuth_deg, band_json) -> AzimuthCrossing[]`

The sibling of `find_altitude`: every instant the body's topocentric azimuth crosses
`azimuth_deg` while the body is inside an altitude band, time-ordered. `band_json` is
`{"min_deg": 10, "max_deg": 30}` on the **apparent** altitude of the centre; empty,
`null` or a missing `min_deg` means "above the horizon" exactly as `above_horizon` says
(upper limb above the sea-level horizon); a missing `max_deg` means no upper limit.
Under 1 ms a day; a year for the Sun about 50 ms.

```json
[{"jd_utc": 2461310.594616, "utc": "2026-09-27T02:16:14.844Z", "az_deg": 120,
  "alt_deg": 38.914, "alt_apparent_deg": 38.935, "rising": true, "clockwise": true}]
```

`rising`: the altitude is increasing; `clockwise`: the azimuth is increasing. A body
passing exactly through the zenith has no azimuth there and crosses no bearing.

### `alignment_days(observer_json, request_json) -> AlignmentResult`

The days of a year a body rises or sets along a bearing, or stands at an apparent
altitude on it (Manhattanhenge, a window, a stone row). One search over the local year
(about 60 ms for the Sun, 0.3 s for the Moon).

```json
{"body": "Sun", "year": 2026, "azimuth_deg": 299.0, "tolerance_deg": 0.3,
 "event": {"kind": "set"}, "utc_offset_hours": -4}
```

- `body` (default `Sun`), `tolerance_deg` (default 0.5, at most 90), `utc_offset_hours`
  (the clock the dates are on; default local mean time), `options` (`EventOptions`, rise
  and set only).
- `event`: `{"kind": "rise"}` or `{"kind": "set"}` — the event finder's rise and set
  (upper limb on the sea-level horizon, CONVENTIONS 13.3); or
  `{"kind": "at_altitude", "altitude_deg": h}` — the centre at apparent altitude `h`,
  rising and setting.

```json
{"body": "Sun", "year": 2026, "azimuth_deg": 299, "tolerance_deg": 0.3, "event": {"kind": "set"},
 "utc_offset_hours": -4, "jd_start": 2461041.666667, "jd_end": 2461406.666667, "truncated": false,
 "events_considered": 365,
 "matches": [
   {"date": "2026-05-24", "kind": "set", "jd_utc": 2461185.510246, "utc": "2026-05-25T00:14:45.243Z",
    "az_deg": 298.936, "offset_deg": -0.064, "alt_deg": -0.833, "best": true},
   {"date": "2026-05-25", "kind": "set", "utc": "2026-05-26T00:15:36.741Z", "az_deg": 299.187, "offset_deg": 0.187, "best": false, …},
   {"date": "2026-07-17", …, "best": false}, {"date": "2026-07-18", …, "best": true}],
 "closest": AlignmentMatch}
```

`kind` is `rise`, `set`, `rising` or `setting`; `date` is the local date on the request's
clock; `best` marks the closest day of each run of consecutive matches; `closest` is the
year's nearest event whether or not it matches (`null` when the body never has one), so
"never" can say by how much. A local year reaching outside the coverage is clipped
(`truncated`).

### `analemma(observer_json, request_json) -> Analemma`

The Sun at one clock time on every day of a year. `{"year": 2026, "time_h": 12, "clock":
"lmt"}` (local mean time at the observer's longitude) or `{"clock": "zone",
"utc_offset_hours": -5}` (a fixed offset all year, no daylight saving). About 10 ms.

```json
{"year": 2026, "time_h": 12, "clock": "lmt", "utc_offset_hours": -5.011013,
 "points": [{"date": "2026-01-01", "jd_utc": 2461042.208792, "utc": "2026-01-01T17:00:39.648Z",
             "alt_deg": 27.081, "alt_apparent_deg": 27.114, "az_deg": 179.053, "dec_deg": -22.958,
             "eot_s": -219.8}, …],
 "errors": []}
```

`dec_deg` and `eot_s` are the analemma's own axes (declination against the equation of
time). Days outside the coverage are left out and counted in `errors`.

### `sun_path(observer_json, jd_start, jd_end, step_minutes) -> SunPath`

The Sun's path over a window (at most two days; the UI passes one local day) every
`step_minutes` (1 to 60; the TypeScript default is 10), and the envelope: the same local
day shifted by whole days to the year's March equinox, June solstice, September equinox
and December solstice. About 4 ms.

```json
{"step_minutes": 10,
 "path": {"day": "day", "jd_start": 2461307.6667, "jd_end": 2461308.6667, "season_jd_utc": null,
          "points": [{"jd_utc": 2461308.2222, "alt_deg": 48.898, "alt_apparent_deg": 48.913, "az_deg": 190.451}, …]},
 "envelope": [{"day": "march_equinox", "jd_start": 2461119.6667, "season_jd_utc": 2461120.115231, "points": […], …},
              {"day": "june_solstice", …}, {"day": "september_equinox", …}, {"day": "december_solstice", …}],
 "errors": []}
```

### `rise_set_azimuths(observer_json, request_json) -> RiseSetAzimuths`

Azimuth through the year: `{"body": "Sun", "year": 2026, "utc_offset_hours": -5,
"options": EventOptions}` (body default `Sun`, clock default local mean time). One
`day_events` over the local year, split into local days. About 60 ms for the Sun, 0.3 s
for the Moon.

```json
{"body": "Sun", "year": 2026, "utc_offset_hours": -5, "jd_start": 2461041.7083, "jd_end": 2461406.7083,
 "truncated": false,
 "days": [{"date": "2026-06-21", "jd_start": 2461212.7083, "jd_end": 2461213.7083,
           "rises": [{"jd_utc": 2461212.89735, "utc": "2026-06-21T09:32:11.038Z", "az_deg": 57.922, "alt_deg": -0.833}],
           "sets": [{"utc": "2026-06-22T00:32:51.423Z", "az_deg": 302.076, …}],
           "transit": {"utc": "2026-06-21T17:02:31.439Z", "az_deg": 180.0, "alt_deg": 73.484, …},
           "always_above": false, "always_below": false}, …]}
```

`rises` and `sets` are usually one each; none when the body does not cross its rise/set
altitude that day (`always_above` / `always_below` then say which), two on rare days for
the Moon at high latitude.

### `equation_of_time(year, utc_hour) -> EquationOfTime`

Apparent minus mean solar time (seconds; positive: the sundial is fast) and the Sun's
apparent declination on every UTC date of `year`, evaluated at `utc_hour` (the TypeScript
default is 12, the almanac page's `eot_12h`). The same for every observer. About 12 ms.

```json
{"year": 2026, "utc_hour": 12,
 "points": [{"date": "2026-01-01", "jd_utc": 2461042.0, "utc": "2026-01-01T12:00:00.000Z",
             "eot_s": -213.9, "dec_deg": -22.976}, …],
 "extremes": [{"kind": "minimum", "date": "2026-02-11", "jd_utc": 2461083.0, "eot_s": -850.5},
              {"kind": "maximum", "date": "2026-05-13", "eot_s": 220.5, …},
              {"kind": "minimum", "date": "2026-07-26", "eot_s": -393.9, …},
              {"kind": "maximum", "date": "2026-11-03", "eot_s": 986.8, …}],
 "errors": []}
```

`extremes` are to the day (the day of the largest or smallest value).

### `solar_day(observer_json, jd_start, jd_end, panel_json, step_minutes) -> SolarDay`

A **clear-sky estimate** of the irradiance on a panel through a window (at most two
days) every `step_minutes` (1 to 60; TypeScript default 10), and the window's energy.
`panel_json`: `{"tilt_deg": 30, "azimuth_deg": 180, "albedo": 0.2}`; empty or `null` is a
flat panel; `azimuth_deg` defaults to facing the equator, `albedo` to 0.2. Under 1 ms.

```json
{"jd_start": 2461307.6667, "jd_end": 2461308.6667, "step_minutes": 10,
 "panel": {"tilt_deg": 30, "azimuth_deg": 180, "albedo": 0.2},
 "samples": [{"jd_utc": 2461308.292, "sun_alt_apparent_deg": 40.055, "sun_az_deg": 223.572,
              "ghi_w_m2": 646.7, "dni_w_m2": 836.2, "dhi_w_m2": 108.5, "poa_w_m2": 807.9,
              "incidence_deg": 33.43}, …],
 "poa_kwh_m2": 7.032, "ghi_kwh_m2": 5.668, "dni_kwh_m2": 8.181, "peak_poa_w_m2": 973.4,
 "model": SolarModel}
```

`incidence_deg` is `null` with the Sun down (then every irradiance is 0). `model` says
what the numbers are, always to be shown with them: `{"label": "clear-sky estimate",
"clear_sky", "diffuse_split", "transposition", "typical_error", "not_modelled"}` (plain
sentences; CONVENTIONS 13.10).

### `solar_year(observer_json, request_json) -> SolarYear`

Clear-sky energy for every local day of a year, by month and in total, and optionally
the tilt that collects the most for the panel's azimuth.
`{"year": 2026, "panel": {"tilt_deg": 30}, "utc_offset_hours": -5, "step_minutes": 10,
"optimise_tilt": true}` (defaults: flat panel, local mean time, 10 minutes, no search).
About 60 ms with the search.

```json
{"year": 2026, "utc_offset_hours": -5, "step_minutes": 10,
 "panel": {"tilt_deg": 30, "azimuth_deg": 180, "albedo": 0.2},
 "jd_start": 2461041.7083, "jd_end": 2461406.7083, "truncated": false,
 "days": [{"date": "2026-01-01", "jd_start": 2461041.7083, "poa_kwh_m2": 4.362, "ghi_kwh_m2": 2.513}, …],
 "months": [{"month": 1, "days": 31, "poa_kwh_m2": 146.5, "ghi_kwh_m2": 88.1}, …],
 "poa_kwh_m2": 2448.2, "ghi_kwh_m2": 2098.8,
 "optimal": {"tilt_deg": 34.7, "azimuth_deg": 180, "poa_kwh_m2": 2454.9},
 "model": SolarModel}
```

`optimal` is `null` unless asked for. Days outside the coverage are left out
(`truncated`).

### `galactic_centre_windows(observer_json, jd_start, jd_end, options_json) -> GalacticCentreWindows`

For the Milky Way planner: the stretches of a window (the UI passes a night, noon to
noon, or a month of them; at most 400 days) during which the galactic centre's apparent
altitude is at least `min_altitude_deg` (default 10) and the Sun's geometric altitude at
most `sun_max_altitude_deg` (default −18, astronomical night), split where the Moon rises
or sets. `options_json`: `{"min_altitude_deg": 15, "sun_max_altitude_deg": -15}`, or
empty / `null` for the defaults. About 1 ms a night, 40 ms a month.

```json
{"jd_start": 2461206.5833, "jd_end": 2461207.5833, "min_altitude_deg": 10, "sun_max_altitude_deg": -18,
 "galactic_centre": {"ra_j2000_deg": 266.416833, "dec_j2000_deg": -29.007806},
 "galactic_pole": {"ra_j2000_deg": 192.8595, "dec_j2000_deg": 27.128333},
 "windows": [{"jd_start": 2461206.857322, "utc_start": "2026-06-15T08:34:32.610Z",
              "jd_end": 2461207.315313, "utc_end": "2026-06-15T19:34:03.068Z", "duration_h": 10.99,
              "moon_up": false, "moon_illuminated_fraction": 0.005,
              "best": {"jd_utc": 2461207.09, "utc": "2026-06-15T14:15:36.979Z",
                       "alt_deg": 87.75, "alt_apparent_deg": 87.75, "az_deg": 359.99,
                       "arch_top_alt_deg": 88.78, "arch_top_az_deg": 301.21,
                       "arch_ends_az_deg": [31.21, 211.21]}}]}
```

- `moon_up`: the Moon is above its rise/set altitude throughout the window;
  `moon_illuminated_fraction` is at the window's middle, given either way.
- `best`: the galactic centre at its highest in the window; there, `arch_top_*` is the
  highest point of the galactic equator (the Milky Way's arch) and `arch_ends_az_deg`
  where the galactic equator meets the horizon. Geometric directions (no refraction).

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

## Expansion programme — magnetic field and compass error (`geomag.rs`, geomag agent)

Normative definitions: CONVENTIONS 14.1-14.2 and `docs/NAVIGATION_METHODS.md` section 9.
The Rust is `skyfix_geomag` (the models) and `skyfix_core::methods::compass` (the method);
the exports are `crates/skyfix-wasm/src/geomag.rs`. TypeScript: `GeomagEngine`, behind
`isGeomagEngine`, in `web/src/next/engine/types.ts` (search "Expansion programme —
magnetic field"). All three exports are optional: a build without them has no
`magneticField`, and the UI checks with the guard.

### `magnetic_field(lat_deg, lon_deg, height_m, jd_utc, model?) -> MagneticField`

The Earth's main field at a WGS84 point (`height_m` above the ellipsoid, as an observer's)
and instant. `model` is optional: `"auto"` (default: WMM2025 from 2025.0 to 2030.0,
IGRF-14 from 1900.0 up to 2025.0), `"wmm2025"` or `"igrf14"`. Philadelphia, 24 September
2026:

```json
{"available": true, "jd_utc": 2461308.0, "utc": "2026-09-24T12:00:00.000Z",
 "model": "WMM2025", "decimal_year": 2026.7301,
 "lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12.0,
 "declination_deg": -11.8053, "inclination_deg": 65.1704,
 "horizontal_nt": 21219.2, "north_nt": 20770.4, "east_nt": -4341.2, "down_nt": 45860.4,
 "total_nt": 50531.5,
 "annual_change": {"declination_deg_per_year": 0.0267, "inclination_deg_per_year": -0.1039,
                   "horizontal_nt_per_year": 36.0, "north_nt_per_year": 37.3,
                   "east_nt_per_year": 2.3, "down_nt_per_year": -140.4,
                   "total_nt_per_year": -112.3},
 "uncertainty": {"declination_deg": 0.364, "inclination_deg": 0.2, "horizontal_nt": 133.0,
                 "north_nt": 137.0, "east_nt": 89.0, "down_nt": 141.0, "total_nt": 138.0,
                 "basis": "WMM2025 error model (NOAA NCEI): …"},
 "zone": "normal", "forecast": true, "notes": [],
 "variation_text": "11.8° W", "annual_change_text": "1.6′ E a year",
 "sentence": "Variation 11.8° W ±0.4° (WMM2025), changing 1.6′ E a year."}
```

| field | meaning |
|---|---|
| `available` | `true` here; see below for `false` |
| `model` | `"WMM2025"` or `"IGRF-14"` |
| `decimal_year` | `Y + (jd - JD(Y-01-01T00:00)) / days in Y` (CONVENTIONS 14.1) |
| `lon_deg` | normalised to (-180, 180] |
| `declination_deg` | **magnetic variation**, true north to magnetic north, east positive |
| `inclination_deg` | dip below the horizontal, down positive |
| `north_nt`, `east_nt`, `down_nt` | X, Y, Z in the geodetic frame; `horizontal_nt` H, `total_nt` F |
| `annual_change` | rate of each element per year (declination and inclination in degrees) |
| `uncertainty` | one standard deviation of each element, with `basis` saying where the numbers come from: WMM2025's published error model (declination `sqrt(0.26² + (5417/H)²)` degrees, so it grows near the magnetic poles), or for IGRF-14 Beggan (2022)'s figures widened for the model's own error in that era (CONVENTIONS 14.1) |
| `zone` | `"normal"`, `"caution"` (H < 6000 nT: compass accuracy may be degraded) or `"blackout"` (H < 2000 nT: compass unreliable, the variation can be wrong by tens of degrees), WMM2025 technical report 1.8 |
| `forecast` | the date is after 2025.0: the value extrapolates a forecast rate of change (always for WMM2025; IGRF-14 after 2025.0) |
| `notes` | plain sentences: the zone, a less certain era (IGRF-14 before 1965), a forecast |
| `variation_text`, `annual_change_text`, `sentence` | the words to show beside the numbers |

A date or height no model covers is **not an error**; the answer says why and carries no
field values (the UI shows the reason and no variation):

```json
{"available": false, "jd_utc": 2396758.5, "utc": "1850-01-01T00:00:00.000Z",
 "decimal_year": 1850.0, "lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12.0,
 "reason": "No magnetic variation for 1850.0: the models start in 1900 (IGRF-14), and the field's earlier changes are not known well enough to show one."}
```

Before 1900.0 and after 2030.0 there is never a value (the brief's rule: variation is not
predictable for deep time and is not shown there); `"wmm2025"` outside 2025.0-2030.0 is
unavailable too; heights outside -1 km to 850 km are unavailable. Malformed input throws a
string: a non-finite number, a latitude beyond ±90, an unknown `model`.

### `magnetic_grid(jd_utc, lat_min, lat_max, n_lat, lon_min, lon_max, n_lon, height_m) -> MagneticGrid | null`

Declination and horizontal intensity on an evenly spaced grid, for isogonic lines and the
blackout zone on the map (the auto model). `n_lat` rows from `lat_min` to `lat_max`,
`n_lon` columns from `lon_min` to `lon_max`, both ends included (a count of 1 gives the
minimum only); at most 70 000 points. About 1 µs a point natively (a 1-degree global grid
in 70 ms).

```ts
{ model: 'WMM2025' | 'IGRF-14', decimal_year: number,
  lat_deg: Float64Array,          // n_lat
  lon_deg: Float64Array,          // n_lon
  declination_deg: Float64Array,  // n_lat * n_lon, row by row from lat_min, west to east
  horizontal_nt: Float64Array }   // same layout; < 2000 blackout, < 6000 caution
```

`null` when no model covers the date. Throws a string for non-finite numbers, a latitude
beyond ±90, `lat_max < lat_min`, `lon_max < lon_min` or too many points.

### `compass_error(request_json) -> CompassError`

Compass error by the azimuth of a body, or by its amplitude as it rises or sets, and for a
magnetic compass its split into variation and deviation (CONVENTIONS 14.2). The Sun from
Philadelphia, a magnetic compass reading 272.0°:

```json
{"method": "azimuth", "body": "Sun", "utc": "2026-09-24T21:40:00Z",
 "observer": {"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12},
 "compass_bearing_deg": 272.0, "compass": "magnetic"}
```

gives (abridged) `true_bearing_deg` 257.552, `compass_error_deg` −14.448,
`variation.deg` −11.805 (WMM2025, `sigma_deg` 0.364), `deviation_deg` −2.642 and

> Compass error 14.4° W; variation 11.8° W; deviation 2.6° W.

Request fields (only `body`, a time, `observer` and `compass_bearing_deg` are required):

| field | meaning |
|---|---|
| `method` | `"azimuth"` (default) or `"amplitude"` |
| `body` | a body `auto` ephemeris mode can place: Sun, Moon, Venus, Mars, Jupiter, Saturn, the 58 stars (any case) |
| `utc` or `jd_utc` | when the bearing was taken (one of them). For an amplitude, roughly: the crossing nearest it within 12 hours is used |
| `observer` | `{lat_deg, lon_deg, height_m?}` (WGS84; height above the ellipsoid, default 0) |
| `compass_bearing_deg` | what the compass read, [0, 360) |
| `compass` | `"magnetic"` (default) or `"gyro"` (no variation; the sentence says "Gyro error") |
| `variation_deg`, `variation_sigma_deg` | a chart's variation (east positive) and its sigma; `null` (default): the model's at the observer and the instant |
| `magnetic_model` | which model fills a missing variation: `"auto"` (default), `"wmm2025"`, `"igrf14"` |
| `bearing_sigma_deg` | 1-sigma of the compass reading, when the navigator states it |
| `horizon` | amplitude: `"visible"` (default: the chosen limb on the sea horizon) or `"celestial"` (the centre at geocentric altitude 0) |
| `height_of_eye_m` | amplitude on the visible horizon: for the dip (default 0) |
| `limb` | amplitude on the visible horizon: `"center"` (default), `"lower"`, `"upper"` |
| `event` | amplitude: `"rising"` or `"setting"`; `null` (default): from the body's side of the meridian at the given time |
| `pressure_hpa`, `temperature_c` | refraction on the visible horizon (defaults 1010, 10) |

Result:

| field | meaning |
|---|---|
| `method`, `body` (canonical), `compass` | as requested |
| `jd_utc`, `utc` | the instant of the true bearing: the bearing's (azimuth) or the horizon crossing's (amplitude) |
| `true_bearing_deg` | azimuth: the topocentric azimuth of the centre on the WGS84 ellipsoid; amplitude: the exact bearing at the crossing |
| `compass_bearing_deg` | as given |
| `compass_error_deg`, `compass_error_text` | true minus compass, (-180, 180], east positive ("compass least, error east"); `"14.4° W"` |
| `compass_error_sigma_deg` | the stated bearing sigma, else `null` |
| `variation` | magnetic compass only: `{deg, sigma_deg, source: "WMM2025" \| "IGRF-14" \| "given", text, notes}`; `null` for a gyro, or when no model covers the date (a note says why) |
| `deviation_deg`, `deviation_sigma_deg`, `deviation_text` | compass error minus variation, east positive; its sigma is the variation's combined with the bearing's when stated; `null` without a variation |
| `sentence` | `"Compass error 14.4° W; variation 11.8° W; deviation 2.6° W."`, or `"Compass error 3.2° W."` without a variation, or `"Gyro error 0.8° W."` |
| `explanation` | `"The Sun bore 257.6° true at 21:40:00 UTC, 13.3° high; the compass read 272.0°."` |
| `azimuth` | azimuth only: `{gha_deg, dec_deg, altitude_deg, zn_spherical_deg, azimuth_rate_deg_per_min}` (`zn_spherical_deg` is CONVENTIONS 3's Zn, what the tables give; equal to `true_bearing_deg` within 0.001° for the Sun and the stars) |
| `amplitude` | amplitude only: `{event, horizon, dec_deg, amplitude_deg (north positive; null if the body never reaches the celestial horizon), amplitude_text ("W 1.0° S"), celestial_bearing_deg, altitude_deg (geocentric, of the centre, when the bearing was taken), visible_horizon_correction_deg (visible minus celestial bearing; Bowditch's Table 23 correction is its negative, applied to the observed bearing), dip_arcmin, refraction_arcmin, semidiameter_arcmin, parallax_arcmin, bearing_per_altitude, minutes_from_given_time}` |
| `direction_source` | the provider that placed the body |
| `notes` | plain sentences: a body below the horizon, a fast-changing bearing, a crossing far from the given time, a shallow crossing at high latitude, the variation model's own notes |

Throws a string for malformed JSON, a missing or double time, a non-finite number, a
latitude beyond ±90, a compass bearing outside [0, 360), a negative height of eye, a sigma
of 0 or less, an unknown body, a body the ephemeris cannot place at that time, or an
amplitude when the body does not rise or set within 12 hours of the given time.

### Packs — the mechanism as built (packs agent, 2026-09-24)

Implements "Packs" above. **Contract changes, all additive or clarifying:**

1. **Producers register with one table entry, not a match arm.** `skyfix_wasm::packs::PRODUCERS`
   holds one `Producer { name, label, description, provides, install }` per pack; `install`
   is the producer's `install_<pack>(payload: &[u8]) -> Result<PackInfo, String>`. The
   contract's `install(name, payload)` exists and dispatches through the table, so `packs()`
   and the "no such pack" sentence come from the same list. Each producer adds its entry
   between the `producer entries start` / `end` comments; nothing else in `packs.rs` changes.
2. **`packs()`**: `version` and `bytes` describe the *loaded* pack (`""` and `0` before
   one is loaded); `label`, `description` and `provides` come from the registry. The version
   and size of the file the site offers are the manifest's (below).
3. **`PackInfo.bytes`** is the size of the whole pack file, header included; the dispatcher
   sets it, whatever the producer reported.
4. **`PackService`** (TypeScript) gains `get(name)` (Settings → Get: download and load with no
   prompt), `subscribe(listener)` and `refresh()`; `status()` returns `PackState[]`, which
   extends `PackStatus` with `offered`, `supported`, `saved`, `savedBytes`, `stale`,
   `removedInUse`, `progress` and `error`.

**The file.** Header as above; the name is `[a-z0-9][a-z0-9-]*`, at most 64 bytes; the
format version is 1; nothing may follow the checksum; the CRC is CRC-32/ISO-HDLC (zlib's
`crc32`: reflected polynomial 0xEDB88320, initial value and final XOR 0xFFFFFFFF; check
value `crc32("123456789") = 0xCBF43926`). `load_pack(name, bytes)` refuses, each with its
own sentence: a file that does not start with `SKYFIXPK`, is cut short, has another format
version, a malformed name, a payload length that does not fit the file, trailing bytes, a
checksum that does not hold, a header naming another pack than `name`, a name no producer
registered ("no pack called "x" in this build: it can install …"), or a payload the
producer refuses ("the deep-time pack: …"). It is idempotent: the same pack again (same
name, CRC and payload length) returns the first `PackInfo` without running the producer;
different bytes for the same name run it again, and the producer must replace what it
installed (a newer revision). A refused file changes nothing. `skyfix_wasm::packs::encode`
writes the layout for Rust generators; `web/plugins/packs.ts` `encodePack` does the same
in Node.

**The site's list: `data/packs/manifest.json`, schema `skyfix.packs/1`.**

```json
{"schema": "skyfix.packs/1",
 "packs": [{"name": "deep-time", "version": "2026-09-24", "rev": "0123456789abcdef",
            "file": "deep-time-0123456789abcdef.bin", "bytes": 412000, "label": "Deep time",
            "description": "Positions from 2000 BC to AD 3000",
            "provides": ["ephemeris:-2000..3000"]}]}
```

Written at build time by `web/plugins/packs.ts` from the producers' files in
`web/public/data/packs/`: `<name>-<rev>.bin` (rev = the first 16 hex digits of the file's
SHA-256, as the precache names revisions) and a sidecar `<name>.json` with `{name, version,
bytes, label, description, provides}`. The build refuses a sidecar without exactly one
file, a file without a sidecar, a file whose hash is not its name's rev, whose size is not
the sidecar's `bytes`, whose header names another pack or whose CRC fails, a committed
`manifest.json`, and anything else in the folder. The sidecars are not deployed. The
manifest is precached; with no packs it is `{"schema": "skyfix.packs/1", "packs": []}`.
The development server answers the same file, built on each request.
`cargo test -p skyfix-wasm` (`every_pack_committed_to_the_site_installs`) installs every
committed pack into the core, and the Pages workflow runs it before building.

**The service worker** leaves `data/packs/*.bin` to the network (`SwBuild.networkOnly`:
no precache, no runtime copy) and never deletes the page's packs cache (`isStaleCache`).

**The page** (`web/src/next/packs/`, reached as `ctx.packs`):

- Saved packs live in the Cache API cache `skyfix-lab-packs-1@<site path>`
  (`packsCacheName`), keyed by the file's absolute address, so name and revision are read
  back from the key; `content-length` is kept. Older packs-cache schemas of the same site
  are deleted at start-up.
- **Start-up:** before the first view mounts (at most 3 s), every saved pack the site still
  offers is loaded into the engine; a saved pack the site no longer offers is deleted; a
  saved copy the engine refuses is deleted and the reason shown in Settings. A visitor with
  nothing saved pays one cache lookup and no manifest fetch. Chosen over loading lazily so
  that `explorer_coverage()` and every view are right from the first frame, and because a
  pack loads in milliseconds.
- **`ensure(name, reason)`:** loaded → true (and, if the site now offers a newer revision,
  it is fetched in the background, loaded, saved, and the old copy deleted); saved → loaded,
  true; declined this page session → false; the site does not offer it, or the core cannot
  install it → false, no prompt. Otherwise one prompt: `reason` (a sentence), the pack's
  label and description, its size, "downloaded once and saved on this device", **Get** /
  **Not now** (offline: "You are offline, and it is not saved on this device yet", **Try
  again**). Get downloads with progress and **Stop**, checks the size and the SHA-256
  revision against the manifest, calls `loadPack`, and only then saves the file. A failure
  is shown in words with **Try again**. Not now, Stop, Esc, × and closing after a failure
  are all remembered for the page session. Concurrent calls share one prompt.
- **`remove(name)`** deletes the saved copy; a loaded pack stays in the engine (there is no
  unloading) until the page is reloaded, and Settings says so.
- After every load the explorer's memoised engine forgets its results
  (`memoEngine(...).invalidate()`), the WASM wrapper asks `explorer_coverage()` again, and
  every view draws again once (`redrawEverything()` in `component.ts`: each live `watch`
  re-renders with its current value), so nothing keeps saying "not computed" for what the
  engine now answers. `ctx.packs.subscribe` hears every change (progress included).
- Developer harnesses pass `NO_PACKS`; the mock engine lists `deep-time`, `tides-us` and
  `lunar-limb` and accepts any bytes (`engine/mock/packs.ts`).

### Time scales, Delta-T and calendars (timescales agent)

Implemented 2026-09-24 in `crates/skyfix-wasm/src/timescale.rs` over
`skyfix_core::{time, deltat, calendar}`; definitions in CONVENTIONS 15.2-15.3; TypeScript:
`TimeEngine` (implemented by `WasmEngine` and the mock) and the additive
`delta_t_sigma_s` fields at the end of `types.ts`.

**`time_info(jd_utc) -> TimeInfo`**, the shape above, about 5 µs natively (debug build;
the interface may call it every frame). Throws for a non-finite `jd_utc`.

- `delta_t_s`/`delta_t_sigma_s`/`delta_t_source` are the ΔT **model** at the instant: its
  best estimate of TT − UT1. On the UT scale it is exactly `tt_minus_clock_s`. On the UTC
  scale the engine does not use it: TT − UTC is `tt_minus_clock_s` (exact) and UT1 − UTC
  is `dut1_s`, so the TT − UT1 the engine uses is `tt_minus_clock_s − dut1_s`, which equals
  `delta_t_s` (to 2 ms) while `dut1_source` is `iers`. Between the table's end and 2035
  the two differ by the model's own prediction of DUT1 (−0.5 s in 2030, −1.6 s at the end
  of 2035, by when a leap second would have intervened), which the engine does not use:
  it assumes 0 ± 0.9 s there.
- `delta_t_source`: `iers` 1973-01-02 to 2026-09-24 (observed), `prediction` from then to
  2800 (IERS Bulletin A's year, then the join to the parabola), `smh2016` −720 to 1973,
  `parabola` before −720 and after 2800. `delta_t_sigma_s`: 0.001 s observed, 0.3 s in
  2030, 10 s in 2060, 32 s in 2100, 15 min in 2650, 30 min in 3000; 0.11 s to 15 s on the
  splines back to 1000, 90 s at year 0, 180 s at −720, an hour at −2000.
- `dut1_source`: `iers` (the table; past 2026-09-24 its values are Bulletin A's
  prediction, with the growing `dut1_sigma_s`), `user` (`set_dut1`, σ 0.05 s), `assumed`
  (UTC scale, no value: 0 ± 0.9 s; 1972, and 2027-09-29 to 2035), `model` (UT scale).
- `tier`: until the deeptime agent's `coverage::tier_at` is merged (one line, marked
  `MERGE` in `timescale.rs`), `validated` inside the providers' coverage and `outside`
  elsewhere; the mock does the same over its 1990-2060.
- `notes`: plain sentences for the interface — the clock is UT and why; leap seconds after
  June 2027 not yet announced; DUT1 unknown or a prediction; a user DUT1 that does not
  apply on the UT scale; ΔT uncertain by more than 30 s ("±m min"); the Julian calendar;
  the BC year.

**`set_dut1(seconds | null)`**: the explorer-wide UT1 − UTC, |value| ≤ 1 s (throws
otherwise; a refused value changes nothing). It applies on the UTC scale only. It is read
by `sky_state`, `sample_bodies`, `day_events`, `day_events_batch`, `find_altitude` and
`sidereal` (a window takes the DUT1 of its middle; across a leap second one side is off
by up to 1 s of UT1, 15″) and by `eclipses`, `eclipse_local`, `eclipse_path`. Without it
they use the IERS history, and with neither 0. Not read by `almanac_day`, whose argument
is UT1 as in the printed almanac (CONVENTIONS 15.2), nor by `moon_phases` and `seasons`,
which do not depend on the Earth's rotation. A session's `clock.dut1_s` overrides it for
that session (the navigation exports).

**`calendar_convert(request_json) -> CalendarConversion`**: `{"jd_utc": 2461308.0}` or
`{"civil": {"calendar": "julian"|"gregorian", "year", "month", "day", "hour"?, "minute"?,
"second"?, "era_year"?, "era"?}}`, exactly one of the two. `year` is astronomical; when
`era_year` and `era` are given they must name the same year. Throws for an impossible date
(`1500-02-29` Gregorian), a time of day out of range, both or neither key, or an unknown
key. The result carries `jd_utc` and the civil date in both calendars (the `CivilDate` of
`time_info`), rounded to the millisecond.

**Wire strings** from every export now use ISO expanded years outside 0000-9999
(`-0584-05-22T12:00:00.000Z`, `+12345-…`) and are always proleptic Gregorian;
`parse_utc` accepts both forms and any year, and the four-digit form exactly as before.

**Eclipses**: `delta_t_s` is TT − UT1 as the engine used it: on the UTC scale 32.184 s +
ΔAT − DUT1 with DUT1 from `set_dut1`, else the IERS history, else 0 (so 69.201 s for
2024-04-08, not the 69.184 s of the section above); on the UT scale the ΔT model. Every
`SolarEclipse`, `LunarEclipse`, `SolarLocal`, `LunarLocal`, `SolarPath` and `LunarPath`
gains **`delta_t_sigma_s`**: DUT1's standard uncertainty on the UTC scale (0.001 s from the
history), the ΔT model's on the UT scale. `conventions.delta_t` says so. Saros numbers
follow each series for any epoch (CONVENTIONS 15.3).

**For the interface agents** (from the data audit): the browser's `Intl` time zones work
offline, but zones merged in tzdata (Oslo, Amsterdam, Reykjavik, …) can be off by up to an
hour before 1970, and before standard time a zone's offset is its city's local mean time,
not the observer's. `Date` and `Intl` are proleptic Gregorian only, and `Date.UTC` maps
years 0-99 to 1900-1999 (`setUTCFullYear` does not). Show Julian dates and years BC from
`time_info.civil` and `calendar_convert`, and compute an observer's local mean time from
the longitude (CONVENTIONS 15.3), rather than through `Date`/`Intl`.

## Expansion programme — sailings, dead reckoning, star identification, star finder (sailings agent)

Rust: `crates/skyfix-core/src/sailings/`, `crates/skyfix-core/src/methods/{starid,starfinder}.rs`,
`crates/skyfix-core/src/error_logs.rs`; WASM: `crates/skyfix-wasm/src/sailings.rs`. TypeScript:
`SailingsEngine` and `isSailingsEngine` at the end of `web/src/next/engine/types.ts`; the
WASM wrapper's methods are on `WasmEngine` (`web/src/next/engine/wasm.ts`), the mock's in
`web/src/next/engine/mock-sailings.ts`, and the memoised engine forwards them. Methods and
validation: `docs/NAVIGATION_METHODS.md` sections 9–13. Every request is a JSON document;
malformed input throws a string naming the field. Angles in degrees, distances in nautical
miles (with kilometres beside the main ones), times as `jd_utc` and RFC 3339 `utc`.

| export | TypeScript | takes | returns |
|---|---|---|---|
| `sailing(request_json)` | `sailing(request)` | `PassageRequest` | `PassageReport` |
| `dr_advance(request_json)` | `drAdvance(request)` | `DrRequest` | `DrReport` |
| `route_positions(request_json)` | `routePositions(request)` | `RouteRequest` | `RouteReport` |
| `star_identify(request_json)` | `starIdentify(request)` | `StarIdRequest` | `StarIdResult` |
| `star_finder_geometry(lat_band, jd_utc?)` | `starFinderGeometry(latBand, jdUtc?)` | a latitude (snapped to its template band), an optional date | `StarFinderGeometry` |

### `sailing(request_json) -> PassageReport`

```json
{"from": {"lat_deg": 36.9617, "lon_deg": -75.7033}, "to": {"lat_deg": 45.6517, "lon_deg": -1.4967},
 "waypoints": {"every_deg_lon": 10}, "limiting_latitude_deg": 47,
 "meridional_parts": "sphere", "speed_kn": 12, "departure_utc": "2026-10-01T12:00:00Z"}
```

Only `from` and `to` are required. `waypoints` is `{"every_nm": N}` or
`{"every_deg_lon": M}` (at most 2000); `limiting_latitude_deg` asks for composite sailing
(north positive); `meridional_parts` is `"sphere"` (default) or `"wgs84"` (Bowditch's
Table 6, for the rhumb line only); `speed_kn` (0 to 1000) gives hours under way, and with
`departure_utc` ETAs. The answer (abbreviated):

```json
{"from": {...}, "to": {...},
 "great_circle": {"distance_nm": 3264.54, "distance_km": 6045.92, "distance_deg": 54.409,
   "initial_course_deg": 55.807, "final_course_deg": 109.003,
   "vertex": {"lat_deg": 48.6297, "lon_deg": -27.2117, "distance_from_start_nm": 2205.18, "on_route": true},
   "highest_latitude_deg": 48.6297, "equator_crossing": null,
   "waypoints": [{"index": 0, "lat_deg": 36.9617, "lon_deg": -75.7033, "distance_from_start_nm": 0.0,
                  "track_course_deg": 55.807, "leg_course_deg": 57.549, "leg_distance_nm": 317.81,
                  "sailed_nm": 0.0, "eta_utc": "2026-10-01T12:00:00.000Z", "eta_jd_utc": 2461315.0},
                 {"index": 1, "lat_deg": 39.8038, "lon_deg": -70.0, "...": "..."}, "...",
                 {"index": 8, "...": "...", "leg_course_deg": null, "leg_distance_nm": null}],
   "waypoint_route_nm": 3266.47, "track": [{"lat_deg": ..., "lon_deg": ...}, "..."],
   "arrival": {"hours": 272.206, "utc": "2026-10-12T20:12:21.898Z", "jd_utc": 2461326.3419}},
 "rhumb_line": {"course_deg": 81.118, "distance_nm": 3376.90, "distance_km": 6254.02,
   "dlat_arcmin": 521.4, "dlo_arcmin": 4452.396, "departure_nm": 3336.41,
   "meridional_difference_arcmin": 695.80, "meridional_parts": "sphere", "track": [...], "arrival": {...}},
 "mid_latitude": {"course_deg": 81.139, "distance_nm": 3384.98, "mean_latitude_deg": 41.3067,
   "dlat_arcmin": 521.4, "dlo_arcmin": 4452.396, "departure_nm": 3344.58, "arrival": {...}},
 "composite": {"limiting_latitude_deg": 47.0, "applies": true, "distance_nm": 3271.27,
   "distance_km": 6058.39, "extra_distance_nm": 6.73,
   "legs": [{"kind": "great_circle", "from": {...}, "to": {"lat_deg": 47.0, "lon_deg": -30.2688},
             "distance_nm": 2081.98, "initial_course_deg": 58.597, "final_course_deg": 90.0},
            {"kind": "parallel", "...": "...", "distance_nm": 463.25},
            {"kind": "great_circle", "...": "...", "distance_nm": 726.04}],
   "waypoints": [...], "waypoint_route_nm": 3272.87, "track": [...], "arrival": {...},
   "note": "the great circle would reach 48.6297°; the composite track follows ..."},
 "great_circle_saving_nm": 112.37, "speed_kn": 12.0, "departure_utc": "2026-10-01T12:00:00.000Z",
 "notes": ["Distances are on the sphere of 1′ = 1 NM. On the WGS84 ellipsoid ... at most 0.52 % ...",
           "Steering the rhumb lines between the waypoints sails 3266.5 NM, 1.9 NM more than ..."]}
```

- `great_circle.vertex` is Bowditch's vertex (the departure's hemisphere; the one ahead
  for a departure on the equator), `null` for a track along the equator;
  `distance_from_start_nm` is negative when it lies behind the departure.
- Each waypoint carries the rhumb line to the next (`leg_course_deg`, `leg_distance_nm`,
  `null` at the destination) and `sailed_nm`, the sum of those legs to it; ETAs are along
  them. `waypoints` is empty when none were asked for (then `waypoint_route_nm` is the
  great circle's own length).
- `track` arrays are for drawing, at most 60 NM apart.
- `mid_latitude` is `null` across the equator; `composite` is `null` unless a limit was
  given, and `applies: false` (with the great circle as its one leg) when the great circle
  stays within the limit. An end beyond the limit, antipodal ends, a rhumb line through a
  pole and a spacing that is not positive throw.

### `dr_advance(request_json) -> DrReport`

```json
{"from": {"lat_deg": 44.605, "lon_deg": -31.305}, "course_deg": 270, "speed_kn": 17, "hours": 4.5,
 "method": "rhumb", "meridional_parts": "sphere", "start_utc": "2026-10-01T15:30:00Z"}
```

`method` is `"rhumb"` (default), `"mid_latitude"` or `"great_circle"` (the running fix's
leg model); negative `hours` give where the vessel was. Returns

```json
{"from": {...}, "to": {"lat_deg": 44.605, "lon_deg": -33.095819}, "course_deg": 270.0,
 "speed_kn": 17.0, "hours": 4.5, "distance_nm": 76.5, "method": "rhumb", "meridional_parts": "sphere",
 "final_course_deg": 270.0, "arrival_utc": "2026-10-01T20:00:00.000Z", "arrival_jd_utc": 2461315.3333}
```

(`final_course_deg` is the direction of travel on arrival: the course itself, except on a
great-circle leg, where it turns.)

### `route_positions(request_json) -> RouteReport`

```json
{"start": {"lat_deg": 40.0, "lon_deg": -70.0}, "start_utc": "2026-10-01T00:00:00Z",
 "legs": [{"course_deg": 90, "speed_kn": 10},
          {"start_utc": "2026-10-01T03:00:00Z", "course_deg": 0, "speed_kn": 10}],
 "end_utc": "2026-10-01T06:00:00Z", "method": "rhumb",
 "times_utc": ["2026-10-01T02:00:00Z", "2026-10-01T07:00:00Z"], "step_minutes": null}
```

The legs are the running fix's `RunningFixLeg` shape, so `request.legs` can be passed to
`running_fix` as they are. The first leg's `start_utc` may be omitted (it starts with the
route); later legs need one, in increasing order. `step_minutes` adds a position every so
many minutes from the start to `end_utc` (required then); at most 20 000 positions.
Returns

```json
{"method": "rhumb", "meridional_parts": "sphere",
 "legs": [{"index": 0, "start_utc": "2026-10-01T00:00:00.000Z", "start_jd_utc": 2461314.5,
           "end_utc": "2026-10-01T03:00:00.000Z", "end_jd_utc": 2461314.625,
           "from": {"lat_deg": 40.0, "lon_deg": -70.0}, "to": {"lat_deg": 40.0, "lon_deg": -69.347296},
           "course_deg": 90.0, "speed_kn": 10.0, "distance_nm": 30.0}, {...}],
 "points": [{"utc": "2026-10-01T02:00:00.000Z", "jd_utc": 2461314.5833, "lat_deg": 40.0,
             "lon_deg": -69.564864, "leg": 0, "status": "under_way", "distance_run_nm": 20.0},
            {"utc": "2026-10-01T07:00:00.000Z", "...": "...", "leg": null, "status": "after_end",
             "distance_run_nm": 60.0}],
 "made_good": {"course_deg": 44.894, "distance_nm": 42.348, "hours": 7.0, "speed_kn": 6.05},
 "notes": ["Some instants are after the route's end: the vessel is taken to have stopped there."]}
```

`status` is `under_way`, `waiting` (at the start before a later first leg), `before_start`
(the start position is reported, not extrapolated) or `after_end`. A leg with no end (the
last, when the route has none) has `end_utc`, `to` and `distance_nm` `null`.

### `star_identify(request_json) -> StarIdResult`

```json
{"utc": "2026-10-01T00:30:00Z",
 "observer": {"lat_deg": 39.95, "lon_deg": -75.17, "height_of_eye_m": 2.5},
 "instrument": {"index_correction_arcmin": -1.2},
 "altitude_deg": 72.59, "altitude_kind": "sextant_hs",
 "bearing_deg": 286, "bearing_kind": "compass", "variation_deg": -12.5, "deviation_deg": 0,
 "altitude_tolerance_deg": 2, "bearing_tolerance_deg": 5}
```

`observer` and `instrument` are the `predict_sextant` shapes (the instrument's
`index_error_log` and `horizon`, a shore horizon included, apply). `altitude_kind` is
`sextant_hs` (default), `apparent_ha` or `observed_ho` (corrected as for a star);
`bearing_kind` is `true` (default), `magnetic` (the variation is added) or `compass` (the
deviation and the variation). The tolerances default to 2° and 5°. Returns

```json
{"utc": "2026-10-01T00:30:00.000Z", "jd_utc": 2461314.5208,
 "observed_altitude_deg": 72.5184, "observed_bearing_deg": 273.5,
 "corrections": {"input_kind": "sextant_hs", "input_deg": 72.59, "steps": [...], "ho_deg": 72.5184, ...},
 "altitude_tolerance_deg": 2.0, "bearing_tolerance_deg": 5.0,
 "sun_altitude_deg": -20.91, "sky": "night", "limiting_magnitude": 4.5,
 "candidates": [{"rank": 1, "body": "Vega", "kind": "star", "navigational": true,
                 "altitude_deg": 72.5162, "azimuth_deg": 273.566, "delta_altitude_deg": 0.0023,
                 "delta_bearing_deg": -0.066, "separation_deg": 0.020, "score": 0.0100,
                 "within_tolerance": true, "magnitude": 0.03, "bright_enough": true},
                {"rank": 2, "body": "Eltanin", "...": "...", "within_tolerance": false}, "..."],
 "best": "Vega", "ambiguous": false,
 "message": "Vega (1.2′ away: the sight is 0.1′ higher and its bearing 4.0′ less).",
 "source": "skyfix-sky (Sun, Moon, planets, stars)", "warnings": [], "notes": ["Brightness: ..."]}
```

`candidates` lists every body within the tolerances, best first, then (when fewer than
three match) the nearest others with `within_tolerance: false`; `best` is `null` when
nothing matches and `message` then names the nearest. `altitude_deg` is the body's airless
topocentric altitude at the DR (the Moon's parallax removed); `delta_*` are observed minus
the body's. The candidates are the 58 stars, Mercury to Saturn and the Moon; `kind` is
`star`, `planet` or `moon`. `sky` is the CONVENTIONS 13.4 phase at the DR. Outside the
ephemeris coverage the call throws the provider's sentence.

### `star_finder_geometry(lat_band, jd_utc?) -> StarFinderGeometry`

`lat_band` is any latitude (degrees, south negative); it picks the template of its 10°
band (5° to 85°, signed; 0 counts as north). `jd_utc`, when given, plots apparent places
of that date; otherwise the J2000.0 catalogue places. Every point is on the unit disc,
`x` right, `y` up, the base seen from outside the celestial sphere (about 100 kB).

```json
{"requested_latitude_deg": 39.95, "template_latitude_deg": 35.0, "side": "north",
 "rotation_sign": 1.0, "equator_radius": 0.5, "epoch": "J2000.0 catalogue place",
 "stars": [{"name": "Acamar", "sha_deg": 315.4347, "dec_deg": -40.3047, "magnitude": 2.88,
            "north": [0.515754, 0.507987], "south": [0.196697, -0.193735]}, "..."],
 "aries_index": [{"lha_aries_deg": 0.0, "north": [1.0, 0.0], "south": [1.0, -0.0], "kind": "label"},
                 {"lha_aries_deg": 1.0, "north": [0.999848, 0.017452], "south": [0.999848, -0.017452],
                  "kind": "minor"}, "..."],
 "template": {"latitude_deg": 35.0, "side": "north", "zenith": [0.305556, 0.0],
              "horizon": [[x, y], ...],
              "altitude_circles": [{"value_deg": 5.0, "points": [[x, y], ...]}, "... every 5° to 85°"],
              "azimuth_lines": [{"value_deg": 0.0, "points": [[x, y], ...]}, "... every 10°"]},
 "notes": ["Azimuthal equidistant projection centred on the celestial pole ...", "..."]}
```

To set the finder: draw the base side `side` (the stars' `north` or `south` points and
the `aries_index`), then draw the template rotated anticlockwise by
`rotation_sign × LHA ♈` degrees about the centre; the template's arrow is its `+x` axis
through `zenith`. The 58 stars are the 57 and Polaris. Template circles are closed (73
points, every 5° of azimuth); azimuth lines run from the horizon to the zenith (37
points). `kind` of an index graduation is `label` every 10°, `major` every 5°, `minor`
every degree.

### Session and reduction additions (additive; older files load unchanged)

- **Shore horizon.** `instrument.horizon` and an observation's `horizon` may be
  `{"shore": {"distance_nm": 1.2}}` besides the three strings (TypeScript `ShoreHorizon`;
  `HorizonName` and `horizonName()` give its kind as a string). CSV cells write it
  `shore:1.2`. The distance must be positive.
- **Error logs.** `instrument.index_error_log: [{"utc", "ic_arcmin", "note"}]` and
  `clock.watch_log: [{"utc", "correction_s", "note"}]`, absent when empty (so older
  outputs are byte-identical). In CSV each rides in the header block as one JSON array
  (`# instrument.index_error_log=[...]` in the Rust dialect).
- **Reduced sight.** `ReducedSight` gains `index_correction_from_log` and
  `clock_correction_from_log` when a log was used:
  `{"value", "method": "interpolated"|"at_entry"|"only_entry"|"held_before_first"|"held_after_last", "from": {"utc", "value"}|null, "to": {...}|null, "hours_outside", "note"}`;
  absent otherwise.
- **Warnings** (appended to `Warning`): `shore_beyond_sea_horizon {id, distance_nm,
  sea_horizon_nm}` (a note: the sea dip was used) and `error_log_outside_span {id, log,
  held_value, hours_outside}` (a caution: a logged value was held, not extrapolated).
- `SightHorizon` (the `predict_sextant` and `plan_sights` instrument's horizon) is now the
  session's `HorizonMode`, a shore horizon included.

## Expansion programme P8 — the Moon in detail (`moondetail.rs`, moondetail agent)

Specified by the moondetail agent (2026-09-25). Engines: `skyfix_almanac::{libration,
lunar_features, apsides, occultations}`; definitions in CONVENTIONS 13.10; validation in
`docs/ACCURACY.md`, "Moon in detail". TypeScript: `MoonDetailEngine` and
`isMoonDetailEngine` at the end of `types.ts`, implemented by the WASM engine, the mock and
the memoised wrapper. Every export throws a string for malformed input or an instant the
Moon or the Sun cannot be computed at; the astronomy is the explorer's (DUT1 = 0,
CONVENTIONS 13.2). `observer_json` is as in "Common rules"; where it may be `null` (or
empty), the answer is for the Earth's centre.

Selenographic places are latitude north-positive and **east** longitude (toward Mare
Crisium, IAU), `(-180, 180]`, in the mean Earth/polar axis frame of IAU coordinates and of
the named features. `DiscPoint` is where a point of the Moon appears on its disc, in disc
radii: `{east, north, x, y, visible}` — `east`/`north` along celestial east (position angle
90°) and north; `x`/`y` as the observer sees the Moon with the zenith up (`x` right, `y`
up), or with celestial north up and east to the left when there is no observer; `visible`
when the point faces the observer.

### `moon_orientation(observer_json | null, jd_utc) -> MoonOrientation`

How the Moon is turned and lit (about 0.5 ms natively):

```ts
{ jd_utc, utc, topocentric: boolean,
  libration: { lon_deg, lat_deg,                        // total, as the observer sees it
               optical_lon_deg, optical_lat_deg,         // Meeus l', b' (geocentric)
               physical_lon_deg, physical_lat_deg,       // Meeus l'', b'' (geocentric)
               diurnal_lon_deg, diurnal_lat_deg },       // observer minus geocentre; 0 without one
  sub_observer: Selenographic,  // = libration lon/lat: the point at the disc's centre
  sub_earth: Selenographic,     // the same from the Earth's centre
  sub_solar: Selenographic,     // where the Sun is overhead
  colongitude_deg,              // 90 − sub_solar.lon_deg, [0, 360): ~270 new, 0 first quarter, 90 full, 180 last
  axis_position_angle_deg,      // the Moon's north pole on the sky, north through east (observer)
  geocentric_axis_position_angle_deg,
  bright_limb_angle_deg,        // the ephemeris's (geocentric, CONVENTIONS 13.5)
  illuminated_fraction, phase_angle_deg, waxing: boolean,
  terminator: { pole: Selenographic,                    // the sub-solar point
                morning_lon_deg, evening_lon_deg,        // where the sunrise/sunset terminators cross the equator
                points: [lat_deg, lon_deg][],            // the great circle every 5°, 72 points
                disc: [x, y][] },                        // the visible half, cusp to cusp, 1° steps
  distance_km, semidiameter_arcmin, apparent_diameter_arcmin,   // observer to Moon
  diameter_vs_mean_percent,     // against the mean distance 384 400 km
  geocentric_distance_km, geocentric_semidiameter_arcmin,
  alt_deg | null, az_deg | null,           // topocentric geometric (CONVENTIONS 13.2)
  parallactic_angle_deg | null,            // position angle of the zenith at the Moon, (-180, 180]
  north_pole_disc: DiscPoint, sub_solar_disc: DiscPoint }
```

`optical + physical + diurnal` differs from the total by the fixed 78.7″ between the pole
of Meeus's figure frame and the mean rotation pole (at most 0.022°; CONVENTIONS 13.10).

### `moon_features(observer_json | null, jd_utc) -> MoonFeatures`

The 150 named features (maria, craters, ranges, rilles, valleys, capes, one albedo swirl,
the six Apollo sites) at an instant, about 0.5 ms natively:

```ts
{ jd_utc, utc, topocentric, colongitude_deg, sub_solar, sub_observer,
  axis_position_angle_deg, parallactic_angle_deg | null, illuminated_fraction, waxing,
  terminator_band_deg: 10,
  tonight: string[],        // visible relief features near the terminator: rank 1 first, then lowest Sun
  features: [{ name, kind, lat_deg, lon_deg, diameter_km, rank: 1 | 2 | 3, description,
               sun_altitude_deg,            // the Sun's altitude over the feature (negative: night)
               lit, morning,                // lunar morning: the Sun is climbing there
               near_terminator,             // faces the observer, Sun between −r and 10° + r (r its angular radius)
               visible, angle_from_disc_centre_deg, disc: DiscPoint }],   // 150, table order
  source: string }          // "USGS/IAU Gazetteer … (U.S. Public Domain); selection … SkyFix Lab"
```

`kind`: `mare | oceanus | lacus | sinus | palus | mons | montes | rupes | rima | vallis |
dorsum | promontorium | albedo | crater | landing_site`. `diameter_km` is the gazetteer's
(the length for rilles, valleys and ranges), 0 for a landing site. Rank: 1 a showpiece,
2 notable, 3 more to find. An albedo marking has no relief and is never in `tonight`.

### `moon_apsides(jd_start, jd_end) -> MoonApsides`

Perigees, apogees, new and full Moons with supermoon flags, instants in the window clipped
to the Moon's coverage (`truncated` says so). At most a century; about 0.1 s of CPU a year
natively (most of it the phase search). Throws for a non-finite or reversed window.

```ts
{ jd_start, jd_end, truncated, coverage_start_utc, coverage_end_utc,
  apsides: [{ kind: 'perigee' | 'apogee', jd_utc, utc, distance_km,   // centre to centre, geometric
              semidiameter_arcmin, diameter_arcmin, diameter_vs_mean_percent }],
  syzygies: [{ kind: 'new_moon' | 'full_moon', jd_utc, utc, distance_km, diameter_arcmin,
               diameter_vs_mean_percent,
               perigee: { jd_utc, utc, distance_km },   // the perigee and apogee on either side of it in time
               apogee: { jd_utc, utc, distance_km },
               hours_from_perigee, perigee_fraction,    // 0 at apogee, 1 at perigee
               supermoon, micromoon,                    // fraction >= 0.9 / <= 0.1 (Nolle)
               largest_of_year, smallest_of_year }],    // full Moons of the UTC calendar year
  definitions: { apsis, supermoon, micromoon, largest_of_year, mean_distance_km } }
```

The new and full Moons are exactly `moon_phases`'s instants.

### `occultations(observer_json, jd_start, jd_end, options_json) -> OccultationList`

Lunar occultations of stars and planets seen from one place, contacts at the Moon's
**mean limb**, the window at most 400 days (clipped to the coverage). A year with the
default bodies takes about 0.1 s natively (76 ms of CPU); down to magnitude 6.5 about
0.5 s. `options_json` (all optional, `{}` or `null` for the defaults; an unknown key
throws):

| key | default | meaning |
|---|---|---|
| `max_magnitude` | 3.5 | Bright Star Catalogue stars brighter than this join the 58 navigational stars; −2 .. 6.5 |
| `stars`, `planets` | true | search them |
| `include_below_horizon` | false | keep events with the Moon below the horizon at every contact |
| `include_near_misses` | true | keep bodies that pass outside the mean limb within 1′ |
| `bodies` | null | only these names (as results spell them; an unknown name throws) |

```ts
{ jd_start, jd_end, truncated, coverage_start_utc, coverage_end_utc,
  limb_note: string,        // show it beside the times: mean limb, real limb differs by seconds, up to a minute near the Moon's poles
  bodies_searched,          // after the ecliptic filter (stars within 7° of the ecliptic)
  events: [{ body, kind: 'star' | 'planet', designation | null, hr | null, magnitude | null,
             navigational, occulted,        // false: a near miss
             graze,                         // passes within 1′ of the mean limb, inside or out
             disappearance: Contact | null, reappearance: Contact | null,
             closest: { jd_utc, utc, limb_distance_arcmin,   // negative inside the disc
                        position_angle_deg, moon_alt_deg },
             duration_s | null, body_semidiameter_arcsec,    // 0 for a star
             moon_illuminated_fraction, waxing,
             visible }],                    // the Moon is up at a contact (at closest approach for a near miss)
  errors: BodyError[] }

Contact = { kind: 'disappearance' | 'reappearance', jd_utc, utc,
            position_angle_deg,   // on the limb, from celestial north through east
            vertex_angle_deg,     // the same from the zenith
            cusp_angle_deg,       // from the nearer cusp, positive on the dark limb, negative on the bright
            cusp: 'N' | 'S', limb: 'dark' | 'bright',
            moon_alt_deg, moon_az_deg, moon_above_horizon,
            sun_alt_deg, sky_phase,   // CONVENTIONS 13.4
            crossing_s }              // planets: seconds for the disc to cross the limb; 0 for a star
```

Events are sorted by their first contact. A planet's contacts are those of its centre. A
star's name is its proper name, else its designation, else `"HR n"`.

## Expansion programme — deep sky (`deepsky.rs`, deepsky agent)

Rust: `crates/skyfix-wasm/src/deepsky.rs` (a `native` layer, tested natively, and the
exports) over `skyfix_starfield::{dso, showers, milkyway, names, search, extinction,
tonight, observe}`. TypeScript: `DeepSkyEngine` in `web/src/next/engine/types.ts` (search
"Expansion programme — deep sky"), implemented by `WasmEngine`, the mock
(`engine/mock/deepsky.ts`, illustrative: 24 objects, 7 showers, two bands for the Milky
Way) and forwarded by `memoEngine`; views check `isDeepSkyEngine(engine)`. The exports are
optional: a package built before them still loads, and a call then throws
"`<export>`: … Rebuild it with: npm run wasm".

**Display only** (CONVENTIONS 13.6): nothing here reaches `reduce`, `solve`, the planner or
an accuracy claim. Rankings, meteor rates, limiting magnitudes and the instrument guide are
**estimates from the stated rules below**, and the wire says so (`notes`, `rate_model`,
`model`).

**Names against the brief's sketch.** The module's exports share one flat namespace, so
the generic names are prefixed by subject, as `starfield_*`, `planet_events` and
`eclipse_path` are; the static table is its own call, as `starfield_catalog` is beside
`starfield_apparent`; the sky's conditions are an argument wherever they change a number.

| brief | export | `DeepSkyEngine` |
|---|---|---|
| — (added) | `dso_catalog()` | `dsoCatalog()` |
| `dso_list(observer, jd, options)` | `dso_list(observer_json, jd_utc, options_json)` | `dsoList(observer \| null, jd, options?)` |
| `dso_visibility(id, observer, night)` | `dso_visibility(id, observer_json, jd_utc, conditions_json)` | `dsoVisibility(id, observer, jd, conditions?)` |
| `showers(year, observer?)` | `meteor_showers(year, observer_json, conditions_json)` | `meteorShowers(year, observer?, conditions?)` |
| `milky_way_outline()` | `milky_way_outline()` | `milkyWayOutline()` |
| `search(query, observer?, jd?)` | `sky_search(query, observer_json, jd_utc?, limit?)` | `skySearch(query, observer?, jd?, limit?)` |
| `tonight(observer, jd)` | `tonight(observer_json, jd_utc, options_json)` | `tonight(observer, jd, options?)` |
| `extinction(...)` | `extinction_table(conditions_json)` | `extinction(conditions?)` |

### Common arguments

- `observer_json`: the common observer. Where it is optional, `""`, `"null"` or
  `"undefined"` mean none (the TypeScript wrapper sends `""`).
- `conditions_json`: the observer's sky, `{"bortle": 1..9, "nelm": 1..8, "k": 0.2..0.4}`,
  every field optional, `""` for all defaults. `nelm` (naked-eye limiting magnitude at the
  zenith) wins over `bortle`; with neither, Bortle 5. `k` is the V extinction coefficient in
  magnitudes per air mass (default 0.25). Unknown fields and out-of-range values throw
  (`"conditions: …"`). Results echo the resolved sky as `conditions: {bortle, nelm, k,
  sky_brightness_mpsas, source: "nelm" | "bortle" | "default"}`; a Bortle class stands for
  the middle of its naked-eye range (1: 7.8, 2: 7.3, 3: 6.8, 4: 6.3, 5: 5.8, 6: 5.3,
  7: 4.8, 8: 4.3, 9: 4.0).
- Instants out are `{jd_utc, utc}`. A *sighting* is `{jd_utc, utc, alt_deg, az_deg,
  direction}`: apparent (refracted) altitude, azimuth, and a 16-point compass word
  (`"NNE"`).
- **The night** (`NightSummary`, shared by `dso_visibility`, `meteor_showers` with an
  observer, and `tonight`): the 24 hours from local mean noon to local mean noon at the
  observer's longitude. A time belongs to the night starting at the local mean noon at or
  before it, or to the next one once the Sun has risen that morning (asked at 10:00, the
  coming night; at 02:00, the current one). `darkness` is the **observing window**: the Sun
  below −18° (`kind: "night"`), or where it never gets there the darkest stretch
  (`"astronomical_twilight"`: below −12°; `"nautical_twilight"`: below −6°); `null` when the
  Sun never goes below −6°. "In darkness" below always means inside that window. `sun`
  holds the night's set, dusks, dawns and rise, `moon` its rise, set, the phase at the
  window's middle (`illuminated_fraction`, `phase_angle_deg`, `phase` in eight words,
  `waxing`) and `up_hours`/`down_hours` of the window. Events are the events crate's
  (CONVENTIONS 13.3).

### `dso_catalog() -> DsoCatalog`

Called once (the wrapper caches it). `{objects: Dso[], source}`, 213 objects in a fixed
order (indices are stable for a build): the 110 Messier objects, then 103 others chosen by
a stated rule (open clusters V ≤ 5.0, globulars V ≤ 7.5, galaxies V ≤ 9.5 and the
Magellanic Clouds, planetary nebulae V ≤ 9.5, named emission or reflection nebulae and
supernova remnants at least 30′ across, and the Hyades, α Persei Cluster, Coma Star
Cluster and Coathanger).

```ts
{ id: "M31",                 // stable: M1..M110, NGC869, IC2602, Mel25, Mel20, Mel111, Cr399, LMC, SMC
  label: "M31",              // as printed: "NGC 869"
  name: "Andromeda Galaxy" | null,
  type: "spiral_galaxy",     // open_cluster, globular_cluster, cluster_with_nebula, planetary_nebula,
                             // emission_nebula, reflection_nebula, supernova_remnant, spiral_galaxy,
                             // elliptical_galaxy, lenticular_galaxy, irregular_galaxy, double_star,
                             // asterism, star_cloud
  category: "galaxy",        // cluster | nebula | galaxy | other: what the Sky view draws
  constellation: "And",      // IAU abbreviation: the constellation the J2000 place lies in
  ra_j2000_deg, dec_j2000_deg,   // ICRS
  magnitude: 3.4 | null,     // integrated V; null for 12 nebulae without a meaningful one
  major_arcmin, minor_arcmin,    // rounded apparent size (display)
  description: "…",          // one line in our own words
  cross_ids: ["NGC 224"] }
```

### `dso_list(observer_json, jd_utc, options_json) -> DsoPositions`

Every object (or those `options_json` keeps) at one instant, as parallel typed arrays:
`{jd_utc, index: Int32Array, ra_deg, dec_deg: Float64Array, alt_deg, az_deg,
alt_apparent_deg: Float64Array | null}`. `index` points into `dso_catalog().objects`.
RA/Dec are **apparent geocentric of date in degrees**, the frame of `sky_state` and of
`starfield_apparent` (which is in radians). With an observer, the topocentric geometric
altitude, the azimuth and the apparent (refracted) altitude as in CONVENTIONS 13.2; without
one the three are `null`. `options_json`: `{"kinds": ["galaxy", "open_cluster", …]
(categories or types; empty keeps all), "max_magnitude": 8.0 (objects without a magnitude
are kept), "above_horizon": true (apparent altitude above 0; ignored without an
observer)}`; unknown fields throw. About 0.1 ms natively.

### `dso_visibility(id, observer_json, jd_utc, conditions_json) -> DsoVisibility`

One object through the night `jd_utc` belongs to. `id` matches the id or any cross
identification, ignoring case and spaces (`"m 31"`, `"NGC 224"`); an unknown id throws.

```ts
{ object: Dso, night: NightSummary, conditions,
  visibility: {
    best: Sighting | null,     // highest point in the observing window
    transit: Sighting | null,  // upper transit inside the night, dark or not
    hours_above_20: number,    // hours of the window with the apparent altitude ≥ 20°
    moon: { moon_alt_deg, separation_deg, brightening_mag } | null,   // at `best`
    limiting_mag: number | null,   // at the object at `best`: NELM − k (X − 1), less what the Moon's light takes
    instrument: "eye" | "binoculars" | "telescope" | "camera" | null },
  track: { jd_utc: number[], alt_deg: number[] } }   // apparent altitude every 10 min, noon to noon (145)
```

**The instrument guide** (a rule of thumb, stated so it can be argued with): an object
"looks like" a point of magnitude `m = V + 0.75 log10(max(size′, 1))`. Against the
limiting magnitude `LM` at the object: the eye if `m ≤ LM − 0.5`; 10×50 binoculars if
`m ≤ LM + 3`; a 100 mm telescope if `m ≤ LM + 5`; otherwise, or without a magnitude, a
camera. The Moon's light is Krisciunas & Schaefer (1991): it brightens the sky at the
object by `brightening_mag`, and the limiting magnitude drops by what Schaefer's (1990)
relation gives for that brighter sky. Extinction is Pickering's air mass (below). About
5 ms natively.

### `meteor_showers(year, observer_json, conditions_json) -> ShowerYear`

Every shower of this project's 32-shower table whose peak falls in `year` (UTC calendar
year; a whole number), in order of peak:

```ts
{ year, source, rate_model,
  showers: [{ shower: MeteorShower,
              peak, start, end,            // instants; start and end may fall in the adjacent year
              moon_illuminated_fraction,   // geocentric, at the peak
              at_site: ShowerNight | null }],
  errors: [{ code, message }] }            // a shower that could not be computed (coverage)
```

`MeteorShower`: `{iau, code, name, lambda_start_deg, lambda_peak_deg, lambda_end_deg,
ra_deg, dec_deg, dra_deg, ddec_deg, v_inf_kms, r, zhr, variable, parent}`. Activity is
stored as **solar longitude** λ☉ (the Sun's apparent geocentric longitude on the mean
ecliptic and equinox of J2000), so every year's instants come from this project's Sun
(CONVENTIONS 13.6 addition); the radiant is J2000 at the peak and drifts by `dra_deg`,
`ddec_deg` per degree of λ☉.

With an observer, `at_site` is the night starting at the local mean noon before the peak
(its local midnight is nearest the peak), `null` when the shower is not active in its
observing window. `ShowerNight`: `{code, name, lambda_deg, zhr, days_from_peak,
radiant_ra_deg, radiant_dec_deg, best: Sighting | null, expected_rate_per_hour,
limiting_mag, hours_radiant_above_20, variable, reason}`, where `lambda_deg` and `zhr` are
at the middle of the window, `best` is the moment of the highest expected rate, and
`reason` is one sentence without clock times. **Rate model (an estimate):** the ZHR falls
off exponentially from the peak to `min(2, ZHR/2)` at the activity limits; the expected
rate is `ZHR × sin(radiant altitude) × r^(LM − 6.5)`, `LM` the zenith limiting magnitude
with the Moon's light. Throws only when no shower can be computed. About 35 ms natively
without an observer, 0.2 s with one (32 nights).

### `milky_way_outline() -> MilkyWayOutline`

Called once (cached). `{levels: number[], rings: {level, ra_deg: Float64Array, dec_deg:
Float64Array}[], source}`: this project's own isophotes from NASA COBE/DIRBE, four levels
(`levels` are the thresholds in DIRBE 1.25 µm MJy/sr: level 0, the faintest glow, on the
map before the dust weighting, so it outlines the whole band; levels 1 to 3 after it, so
the dark lanes and star clouds show), 24 rings, ICRS (J2000) degrees, RA `[0, 360)`.
Every ring is **closed** (the last point repeats the first, as the constellation
boundaries do) and **oriented**: for consecutive points `a`, `b` as unit vectors the
brighter side is the one `a × b` points to. Rings of one level may nest (a darker hole
inside a brighter region); filling each level by the even-odd rule, or by the
orientation, gives the same region, and drawing the levels in order stacks them. Draw
them with the boundary machinery: rotate with `starfield_frame_matrix` into the frame of
date, and handle RA jumps across 0°/360° when projecting. The rings were simplified on the
sphere to 0.2°, so consecutive points can be up to 14° apart along a nearly straight
stretch: each step is a great-circle arc, to be interpolated where the projection would
otherwise cut the corner. 856 points in all (3.2 KB embedded).

### `sky_search(query, observer_json, jd_utc?, limit?) -> SearchResult`

`{query, hits: SearchHit[]}`, best first; `limit` defaults to 20 and is clamped to 1–100.

```ts
{ kind: "star" | "deep_sky" | "constellation" | "sun" | "moon" | "planet" | "shower",
  id: "HR 2491" | "M31" | "CMa" | "Mars" | "PER",
  label: "Sirius",            // a star's name, else its designation, else "HR n"
  detail: "α CMa · HR 2491 · HIP 32349 · V −1.46",
  magnitude: number | null,
  index: number | null,       // stars: index into starfield_catalog()
  ra_deg, dec_deg: number | null,        // with jd_utc: apparent geocentric of date
  alt_deg, az_deg, alt_apparent_deg: number | null, above_horizon: boolean | null,  // with an observer
  score: number }             // 100 exact, 80 prefix, 60 words, 40 contains
```

Matching folds case, accents, Greek letters (α and "alpha"), superscripts and
punctuation; a key scores 100 when it equals the query with spaces ignored ("alpha1 cen" is
"α¹ Cen", "alnair" is "Al Na'ir"), 80 when it starts with it, 60 when every query word
starts a word of the key (less one per key word left over), 40 when it contains it (three
letters or more). Ties go to the Sun, Moon and planets, then names, then designations,
then brightness. Keys: star names (the star field's own and the IAU WGSN's), Bayer and
Flamsteed designations with the abbreviation or the genitive ("alpha cma", "alf cma",
"alpha canis majoris", "61 cygni"), `HR n` and, where known, `HIP n`; the objects' ids,
catalogue numbers and names; constellation names, abbreviations and genitives; shower
names, codes and "… radiant". Positions: a shower hit is its radiant of date; a
constellation hit its label point. An observer without `jd_utc` throws; a body the
ephemeris cannot give at that time is returned without a position. About 2.5 ms natively.

### `tonight(observer_json, jd_utc, options_json) -> Tonight`

What the night `jd_utc` belongs to offers. `options_json`: the conditions fields plus
`"limit"`, the number of deep-sky objects (default 12, clamped to 1–60).

```ts
{ night: NightSummary, conditions,
  planets: [{ body, magnitude, best, up_from, up_until, hours_up, reason }],
  deep_sky: [{ id, label, name, type, category, constellation, magnitude,
               best: Sighting, hours_above_20, moon, instrument, score, reason }],
  showers: ShowerNight[],
  milky_way_core: { best: Sighting | null, hours_above_20, reason },
  summary: string, notes: string[], errors: string[] }
```

- **Planets**: all seven, Mercury to Neptune, sampled every 10 minutes while the Sun is
  below −6°: the highest point (`best`, `null` when the planet is not up then), the first
  and last moment 10° up, the hours up, and a reason that says which.
- **Deep sky**: every object that spends some of the observing window above 20°, scored
  `100 × base × sin(best altitude) × (0.5 + 0.5 min(1, hours above 20° / 4)) ×
  10^(−0.2 × moon brightening) × 1.2 if it has a common name`, `base` = 1.0 eye, 0.8
  binoculars, 0.5 telescope, 0.35 camera (the instrument guide above); the best `limit`.
- **Showers** active in the window, listed when the expected rate reaches 0.5 an hour or
  the shower is variable.
- **The Milky Way's core** (Sagittarius A*): its best moment and hours above 20° in
  darkness.
- **`summary`**: plain sentences in which times are tokens `{jd:2461308.517173}` (a UTC
  Julian date, six decimals) for the interface to replace in its own zone and format
  (`formatSummaryTimes(summary, format)` in types.ts). `errors` lists bodies the ephemeris
  could not give; `notes` names the models.

About 20 ms natively (`tests/deepsky_timing.rs`, budget 50 ms).

### `extinction_table(conditions_json) -> ExtinctionTable`

`{conditions, alt_deg, airmass, extinction_mag, limiting_mag: Float64Array, model}`, one
row per degree of apparent altitude, 0 to 90 (91 rows). Air mass
`X = 1 / sin(h + 244 / (165 + 47 h^1.1))` (Pickering 2002; 38.7 at the horizon);
`extinction_mag = k X`; `limiting_mag = NELM − k (X − 1)` (extinction only: light domes
and the sky's own brightening toward the horizon are not modelled). The zenith sky
brightness `sky_brightness_mpsas` comes from NELM by Schaefer's (1990) relation,
`NELM = 7.93 − 5 log10(10^(4.316 − B/5) + 1)`, capped at 22.0 mag/arcsec². For the Sky
view's magnitude cut and the rankings.

### Additive change to `starfield_catalog()`

`names` grows from 252 to **472** entries: the IAU WGSN names of 220 more catalogue stars
(joined by HR number, checked by position or designation). The star field's 252 names are
unchanged, including the Almanac spellings (Navi, not the WGSN's Tiansi; Al Na'ir). Still
sorted by `index`; no name is used twice.

## Expansion programme — tides (`tides.rs`, tides agent)

Tide predictions for NOAA's 3 499 tide stations, from the optional **`tides-us`** pack
(CONVENTIONS 13.11 for the definitions, `docs/ACCURACY.md` section 16 for the measured
agreement with NOAA's own predictions). The engine is `skyfix_tides`; the exports are in
`crates/skyfix-wasm/src/tides.rs`; the TypeScript mirror is `TidesEngine` and
`isTidesEngine` in `web/src/next/engine/types.ts` ("Expansion programme — tides"); the
memoised engine forwards the methods (`component.ts`). Every result carries
`label: "US stations (NOAA); predictions, not observations; weather and surge not
included"` and `notes`, plain sentences for the interface.

**Errors** are strings beginning with a code and a colon: `pack_not_loaded` (every call
until the pack is installed; `isTidePackNotLoaded(error)` in `types.ts`),
`unknown_station`, `datum_unavailable` (lists the datums the station has),
`no_prediction` (a station NOAA lists but gives no constants for, or a subordinate one
whose reference cannot be predicted), `outside_range` (instants from 1900-01-01 to
2100-12-31 only), `bad_request`. The WASM wrapper prefixes the export's name
(`tide_extremes: pack_not_loaded: …`).

**`datum`** arguments are `"MLLW"`, `"MLW"`, `"MSL"`, `"MTL"`, `"MHW"`, `"MHHW"`,
`"LAT"`, `"HAT"` or `"NAVD88"` (case-insensitive; `"NAVD"` accepted), or `""` for the
station's `default_datum` (MLLW; MSL where NOAA publishes no datums). Subordinate
stations have MLLW only, as NOAA predicts them.

### `tide_stations_near(lat_deg, lon_deg, n) -> TideStationNear[]`

The `n` stations nearest to a place (`n` clamped to 1..100), nearest first, harmonic and
subordinate alike: each `TideStation` below plus `distance_km`, `distance_nm` (1852 m)
and `bearing_deg` (initial great-circle bearing from the place, degrees true), on the
sphere of mean radius 6371.0088 km. 1-3 ms natively.

### `tide_station(station_id) -> TideStation`

```ts
{ id: "9414290", name: "San Francisco (Golden Gate)", state: "CA" | null,
  lat_deg: 37.806305, lon_deg: -122.46589,
  kind: "harmonic" | "subordinate",
  reference_id: null | "8518750", reference_name: null | "New York (The Battery)",
  tide_type: "semidiurnal" | "mixed_semidiurnal" | "mixed_diurnal" | "diurnal" | null,
  form_number: 0.84 | null,            // (K1 + O1)/(M2 + S2); a subordinate station's is its reference's
  datums: ["HAT", "MHHW", "MHW", "MTL", "MSL", "MLW", "MLLW", "LAT", "NAVD88"],
  default_datum: "MLLW",
  curve: "harmonic" | "interpolated" | "none",
  flags: ("noaa_differs" | "no_datums" | "no_constants" | "reference_unusable" | "non_navigational")[],
  notes: string[] }
```

`state` is NOAA's two-letter code; NOAA leaves it empty for foreign ports and for many
U.S. stations too, so `null` does not mean "outside the United States". `curve` says
what `tide_predict` can give: `harmonic` a true curve, `interpolated` (subordinate
stations) the cosine curve between high and low water, an estimate, `none` nothing.

### `tide_extremes(station_id, jd_start, jd_end, datum) -> TideExtremes`

High and low water with instants in `[jd_start, jd_end]` (at most 400 days), sorted:

```ts
{ station: TideStation, datum: "MLLW", method: "harmonic" | "subordinate_offsets",
  jd_start: number, jd_end: number,
  extremes: [{ kind: "high" | "low", jd_utc: number, utc: "2026-09-24T05:07:12.345Z", height_m: number }],
  label: string, notes: string[] }
```

The tide table's rule applies: a high and a low less than 2 hours apart and less than
0.1 ft apart in height are left out, as in NOAA's tables (CONVENTIONS 13.11). A month
takes 4-11 ms natively.

### `tide_predict(station_id, jd_start, jd_end, step_min, datum) -> TideCurve`

Heights at `jd_start + k·step_min` for `k = 0, 1, …` while not after `jd_end`;
`step_min` from 0.5 to 1440, at most 20 000 samples:

```ts
{ station: TideStation, datum: "MLLW", method: "harmonic" | "interpolated",
  jd_start: number, jd_end: number, step_min: number,
  jd_utc: Float64Array, height_m: Float64Array,
  label: string, notes: string[] }
```

For a subordinate station (`method: "interpolated"`) the curve is the cosine
interpolation between its high and low waters (NOAA Tide Tables, Table 3) and the notes
say so; samples before its first or after its last extreme in reach are left out, so the
arrays can be shorter than the step implies.

### `tide_now(station_id, jd_utc, datum) -> TideNow`

```ts
{ station: TideStation, datum: "MLLW", method: "harmonic" | "interpolated",
  jd_utc: number, utc: string, height_m: number,
  rate_m_per_h: number,                // negative when falling
  state: "rising" | "falling",
  previous: TideEvent | null, next: TideEvent | null,
  next_high: TideEvent | null, next_low: TideEvent | null,
  label: string, notes: string[] }
```

The extremes are the tide table's (above), searched 1.5 days back and 3 days ahead.
About 1.5 ms.

### Loading the pack

- Through the pack mechanism: `load_pack("tides-us", bytes)` (EXPLORER_API "Packs")
  checks the common header and the CRC-32 and calls the producer
  `skyfix_wasm::tides::install_tides_us(payload)` (the `tides-us` entry of
  `packs::PRODUCERS`: label "US tides", provides `["tides:us"]`), which decodes the
  payload and installs the stations; a malformed payload changes nothing, a second
  install replaces the first. `packs()` then reports `tides-us` loaded.
- `tide_pack_info() -> TidesPackInfo | null`: the installed pack's summary, `{name:
  "tides-us", version, bytes (payload), provides: ["tides:us"], stations, harmonic,
  subordinate}`.
- The mock engine answers for its synthetic station from the start
  (`MockEngineOptions.tidesLoaded: false` makes it wait for `loadPack("tides-us", …)`).

### The `tides-us` pack: file and payload

File `web/public/data/packs/tides-us-<rev>.bin` (rev = the first 16 hex digits of the
file's SHA-256), with the sidecar `web/public/data/packs/tides-us.json` (`name`,
`version`, `rev`, `file`, `bytes`, `sha256`, `label`, `description`, `provides`, station
counts, source). The file is the common pack header with name `tides-us`; 344 543 bytes
(0.34 MB), 234 KB deflated. Built by `tools/tides/build.py`; decoded (and re-encoded, in
the tests) by `skyfix_tides::pack`. The payload, little-endian and byte-packed (`str8`
is a u8 length then bytes):

```text
"TIDE"                      4 bytes
u16                         payload format (1)
str8                        data version: the NOAA retrieval date, YYYY-MM-DD
u8 K, K × str8              constituent names: NOAA's 37 standard ones in NOAA's order,
                            then NOAA's extended set (120 in all)
u8 B                        how many leading names the per-station bitmap covers (37)
u32 S                       station count, then S records sorted by id:
  str8 id, str8 name (UTF-8), str8 state (may be empty)
  i32 latitude, i32 longitude          microdegrees, east positive
  u8 kind                              0 harmonic, 1 subordinate
  u8 flags                             1 noaa_differs, 2 no_datums, 4 no_constants,
                                       8 reference_unusable, 16 non_navigational
  harmonic:
    8 × i16                            MHHW, MHW, MTL, MLW, MLLW, LAT, HAT, NAVD88 in mm
                                       relative to MSL; -32768 = not published
    ceil(B/8) bytes                    bitmap of names 0..B (name k: bit k%8 of byte k/8)
    per set bit, in order:             u16 amplitude (mm), u16 Greenwich phase (0.01°)
    u8 E, then E × (u8 name index ≥ B, u16 amplitude, u16 phase)
  subordinate:
    u16 reference                      index of the reference station in this list
    i16 high, i16 low                  time differences, minutes
    u8 height type                     0 ratio, 1 additive
    i16 high, i16 low                  ratio × 1000, or additive difference in mm
```

A reader maps constituent names to its own table and refuses an unknown one; nothing
may follow the last station.

## Expansion programme — planet detail (`planetdetail.rs`, planetdetail agent)

Jupiter's moons, Saturn's rings, every planet's disc, transits of Mercury and Venus with
local circumstances, conjunctions and stations, the Earth's perihelion and aphelion, and
comets and asteroids from elements the person supplies. Engines:
`skyfix_almanac::{satellites, rings, discs, transits, conjunctions, earth_apsides,
orbits}`; exports: `crates/skyfix-wasm/src/planetdetail.rs`; definitions: CONVENTIONS
13.12; measured accuracy: `docs/ACCURACY.md` section 17. TypeScript: `PlanetDetailEngine`
and `isPlanetDetailEngine` ("Expansion programme — planet detail" in `types.ts`), where
the generic names carry a prefix (`PlanetTransit…`, `PlanetStation…`, `GalileanInstant`,
`SaturnRingEdge`, `EarthApsisEvent`, `OrbitMagnitudeModel`, `ManualOrbitalElements`) so
they cannot merge with another package's declarations. The WASM wrapper and the mock
(`engine/mock/planetdetail.ts`) implement all of it; the memoised engine passes the calls
through.

**Common rules.** Instants are `jd_utc` plus the `utc` string, as everywhere. Every
position is apparent and geocentric unless an observer is given. A window that is not
finite, ends before it starts or is longer than the call's limit throws; one reaching
outside the coverage (the Sun and planet providers', `coverage_start_utc` ..
`coverage_end_utc`) is clipped and says so (`truncated`). A single instant outside it
throws. Errors are strings; the WASM wrapper prefixes the export's name
(`planet_disc: "Pluto" is not a planet …`).

### `galilean_moons(jd_utc) -> GalileanMoons`

The four moons around Jupiter as the Earth sees them (Lieske's E5 theory; within 0.33″ of
JPL's satellite ephemeris). Under a millisecond.

```json
{"jd_utc": 2461050.5, "utc": "2026-01-10T00:00:00.000Z",
 "jupiter": {"distance_au": 4.231754, "light_time_s": 2111.67, "equatorial_radius_arcsec": 23.2936,
             "polar_radius_arcsec": 21.7834, "pole_position_angle_deg": 9.9953, "sub_earth_lat_deg": 1.3894,
             "ra_deg": 111.8471, "dec_deg": 22.1829, "elongation_deg": 179.51},
 "moons": [{"name": "Io", "x_rj": 5.4915, "y_rj": -0.0558, "z_rj": -2.2034,
            "offset_east_arcsec": -126.20, "offset_north_arcsec": 20.92, "ra_deg": 111.8093, "dec_deg": 22.1887,
            "in_front": true, "in_transit": false, "occulted": false, "eclipsed": false,
            "shadow_on_disc": false, "shadow_x_rj": null, "shadow_y_rj": null}, …],
 "theory": "Lieske E5 (Meeus, Astronomical Algorithms, chapter 44, higher accuracy), …",
 "accuracy_arcsec": 0.5}
```

| field | meaning |
|---|---|
| `x_rj`, `y_rj` | on the sky, along Jupiter's equator (positive **west**) and toward its projected north pole, in Jupiter's apparent equatorial radius: draw the diagram from these |
| `z_rj` | along the line of sight, positive **away** from the Earth (`in_front` = negative) |
| `offset_east_arcsec`, `offset_north_arcsec` | the same offset in celestial east and north (true equator of date) |
| `in_transit` / `occulted` | in front of / behind the oblate disc |
| `eclipsed` | in Jupiter's shadow (the Sun's centre hidden) |
| `shadow_on_disc`, `shadow_x_rj`, `shadow_y_rj` | the moon's shadow falls on Jupiter, and where (same axes); `null` otherwise |
| `jupiter.sub_earth_lat_deg` | planetocentric latitude of the Earth seen from Jupiter (the tilt of the moons' paths) |
| `accuracy_arcsec` | the worst offset error measured against JPL (ACCURACY 17) |

### `galilean_events(jd_start, jd_end) -> GalileanEvents`

Every transit, shadow transit, occultation and eclipse of the four moons overlapping the
window (at most 400 days), sorted by start. Under 0.1 s for a month natively.

```json
{"jd_start": 2461050.5, "jd_end": 2461051.5, "truncated": false,
 "phenomena": [
   {"moon": "Europa", "kind": "eclipse",
    "start": {"jd_utc": 2461050.449425, "utc": "2026-01-09T22:47:10.304Z", "observable": true},
    "end": {"jd_utc": 2461050.567944, "utc": "2026-01-10T01:37:50.383Z", "observable": false},
    "jupiter_elongation_deg": 179.47},
   {"moon": "Europa", "kind": "occultation",
    "start": {"jd_utc": 2461050.450206, "utc": "2026-01-09T22:48:17.792Z", "observable": false},
    "end": {"jd_utc": 2461050.568696, "utc": "2026-01-10T01:38:55.360Z", "observable": true}, …}, …],
 "conventions": "Times when the Earth sees them (UTC). …"}
```

- `kind`: `transit` (the moon crosses the disc), `shadow_transit` (its shadow does),
  `occultation` (hidden behind the planet), `eclipse` (in Jupiter's shadow).
- `observable: false` marks a moment the Earth cannot see happen: above, Europa goes into
  eclipse in view, then behind the planet a minute later, and leaves the shadow while
  still hidden.
- `jupiter_elongation_deg`: nothing is observable within about 15° of the Sun; the UI
  should grey such events rather than hide them.
- Accuracy: 23 s (Io) to 97 s (Ganymede) against JPL, E5's own drift (ACCURACY 17).

### `saturn_rings(jd_utc) -> SaturnRings`

```json
{"jd_utc": 2461307.5, "utc": "2026-09-24T00:00:00.000Z",
 "earth_latitude_deg": -7.8128, "sun_latitude_deg": -7.5468, "delta_u_deg": 1.1928, "position_angle_deg": 3.1594,
 "major_axis_arcsec": 44.630, "minor_axis_arcsec": 6.067,
 "edges": [{"name": "A outer", "radius_km": 136780.0, "major_axis_arcsec": 44.630, "minor_axis_arcsec": 6.067},
           {"name": "A inner", …}, {"name": "B outer", …}, {"name": "B inner", …}, {"name": "C inner", …}],
 "north_face_visible": false, "lit_face_visible": true,
 "distance_au": 8.451384, "heliocentric_distance_au": 9.436799,
 "magnitude_aa1984": 0.351, "magnitude": 0.379}
```

| field | meaning |
|---|---|
| `earth_latitude_deg` (B), `sun_latitude_deg` (B′) | saturnicentric latitudes of the Earth and the Sun above the ring plane; positive = north face |
| `delta_u_deg` (ΔU) | difference of their saturnicentric longitudes in the ring plane |
| `position_angle_deg` (P) | of the ring's northern semi-minor axis (Saturn's pole), celestial north through east |
| `major_axis_arcsec`, `minor_axis_arcsec` | the outer edge of the A ring; `edges` gives every edge's ellipse |
| `lit_face_visible` | false when the Earth sees the unlit face (between the Earth's and the Sun's crossings of the ring plane, as from March to May 2025) |
| `magnitude` | the explorer's planet magnitude (Mallama & Hilton 2018, rings included); `magnitude_aa1984` the Astronomical Almanac's 1984 formula (Meeus 41) that printed almanacs used, for comparison: they differ by −0.13 to +0.07 over 1990-2060 |

### `planet_disc(body, jd_utc) -> PlanetDisc`

Any of the seven planets (case-insensitive). Under a millisecond.

```json
{"body": "Jupiter", "jd_utc": 2461050.5, "utc": "2026-01-10T00:00:00.000Z",
 "distance_au": 4.231754, "light_time_s": 2111.67,
 "equatorial_diameter_arcsec": 46.5872, "polar_diameter_arcsec": 43.5667,
 "phase_angle_deg": 0.0911, "illuminated_fraction": 0.999999, "defect_of_illumination_arcsec": 0.00003,
 "bright_limb_angle_deg": 66.62, "pole_position_angle_deg": 9.9953,
 "sub_earth_lat_deg": 1.3894, "sub_earth_lat_graphic_deg": 1.5888, "sub_earth_lon_deg": 252.7525,
 "sub_solar_lat_deg": 1.4406, "sub_solar_lat_graphic_deg": 1.6473, "sub_solar_lon_deg": 252.8305,
 "longitude_positive": "west",
 "central_meridians": [{"system": "I", "longitude_deg": 193.2305}, {"system": "II", "longitude_deg": 2.6458},
                       {"system": "III", "longitude_deg": 252.7525}],
 "magnitude": -2.68,
 "rotation_model": "IAU WGCCRE 2015 (Archinal et al. 2018); Jupiter Systems I and II IAU 1976",
 "notes": ["The Great Red Spot is not tracked: …"]}
```

- Latitudes are planetocentric; `_graphic` ones are on the IAU ellipsoid. Longitudes are
  planetographic in the sense `longitude_positive` names (east for Venus and Uranus).
- `central_meridians`: Jupiter's Systems I, II and III; `III` for Saturn and Uranus;
  `IAU` for the others. The centre of the geometric disc (CONVENTIONS 13.12 for the
  phase-corrected value some handbooks print).
- `polar_diameter_arcsec` is the apparent one (it grows toward the equatorial as the
  pole tilts toward us); `defect_of_illumination_arcsec` is the width of the dark part.
- `notes`: plain sentences for the interface (why the Great Red Spot is not given,
  Venus's clouds, the uncertain rotation of Uranus and Neptune).

### `transits(jd_start, jd_end, observer_json) -> PlanetTransitList`

Every transit of Mercury or Venus whose greatest transit falls in the window (at most
1 200 years; clipped to the coverage). `observer_json` is an observer object, or `""` /
`"null"` for the geocentric circumstances only; with one, each transit gains `local`.
About 0.25 s for 1990-2060 natively.

```json
{"jd_start": 2456082.5, "jd_end": 2456085.5, "truncated": false,
 "coverage_start_utc": "1990-01-01T00:00:00.000Z", "coverage_end_utc": "2060-12-31T23:59:59.000Z",
 "transits": [{"id": "2012-06-06-venus", "planet": "Venus",
   "contacts": [{"kind": "c1", "jd_utc": 2456084.423394, "utc": "2012-06-05T22:09:41.262Z", "jd_tt": 2456084.42416,
                 "position_angle_deg": 40.70, "separation_arcsec": 974.59},
                {"kind": "c2", …}, {"kind": "greatest", "utc": "2012-06-06T01:29:36.017Z", "separation_arcsec": 554.37, …},
                {"kind": "c3", …}, {"kind": "c4", "utc": "2012-06-06T04:49:31.086Z", …}],
   "min_separation_arcsec": 554.37, "sun_semidiameter_arcsec": 945.69, "planet_semidiameter_arcsec": 28.90,
   "grazing": false, "duration_s": 23989.8,
   "path": [{"jd_utc": 2456084.423394, "east_arcsec": 635.59, "north_arcsec": 738.83}, …],
   "tt_minus_utc_s": 66.184,
   "local": {"observer": {"lat_deg": 39.9526, "lon_deg": -75.1652, "height_m": 12.0},
             "visibility": "partly_below_horizon",
             "events": [{"kind": "c1", "utc": "2012-06-05T22:03:54.011Z", "sun_alt_deg": 24.63, "sun_az_deg": 279.72,
                         "visible": true, "position_angle_deg": 41.19, "vertex_angle_deg": 346.22,
                         "separation_arcsec": 974.61, …},
                        {"kind": "c2", …}, {"kind": "sunset", "utc": "2012-06-06T00:26:17.012Z", "sun_alt_deg": -0.833, …},
                        {"kind": "greatest", "visible": false, …}, {"kind": "c3", …}, {"kind": "c4", …}],
             "path": […]}}],
 "conventions": "Contacts I and IV: the discs externally tangent; …"}
```

| field | meaning |
|---|---|
| `id` | UTC date of greatest transit and the planet, as the eclipses' ids |
| `contacts` | geocentric (the Earth's centre), in time order: `c1`, `c2`, `greatest`, `c3`, `c4`; a `grazing` transit has no `c2`/`c3` |
| `position_angle_deg` | where the planet is on the Sun's disc, from the Sun's north point through east |
| `path` | 25 points from `c1` to `c4`: the planet's centre relative to the Sun's, east and north (arcsec), to draw the chord |
| `local.events` | the contacts for the observer, plus `sunrise`/`sunset` when the Sun crosses −50′ during the transit; `visible` = the Sun is above −50′; `vertex_angle_deg` from the point of the Sun's limb nearest the zenith |
| `local.visibility` | `visible` (Sun up throughout), `partly_below_horizon`, `below_horizon`, or `none` (seen from here the planet misses the Sun: only near a geocentric graze) |

### `conjunctions(jd_start, jd_end, options_json) -> ConjunctionList`

Closest approaches in apparent separation (CONVENTIONS 13.12), sorted by time, window at
most ten years. A year with the default bodies: about 0.22 s natively (0.25 s with an
observer). `options_json` is `ConjunctionOptions`, `""`/`"null"`/`{}` for every default;
an unknown field throws.

| option | default | meaning |
|---|---|---|
| `planets` | all seven | names; `body` is always the inner of two, whatever the order given |
| `moon` | `true` | include the Moon with the planets and the stars |
| `stars` | Aldebaran, Regulus, Spica, Antares | any of the 58 navigational stars (the four are those the Moon and planets pass) |
| `max_separation_deg` | 5 | 0.1 to 20 |
| `min_sun_elongation_deg` | 15 | the Sun distance below which `visible` is false |
| `observer` | none | an observer object: each event gains `local` |

```json
{"jd_start": 2459184.5, "jd_end": 2459215.5, "truncated": false,
 "coverage_start_utc": "1990-01-01T00:00:00.000Z", "coverage_end_utc": "2060-12-31T23:59:59.000Z",
 "conjunctions": [{"kind": "planet_planet", "body": "Jupiter", "other": "Saturn",
   "jd_utc": 2459205.264782, "utc": "2020-12-21T18:21:17.135Z", "separation_deg": 0.101751,
   "position_angle_deg": 167.55, "ra_deg": 302.7968, "dec_deg": -20.5137,
   "body_elongation_deg": 30.14, "other_elongation_deg": 30.14, "body_magnitude": -1.98, "other_magnitude": 0.68,
   "visible": true,
   "local": {"body_alt_deg": 28.56, "other_alt_deg": 28.66, "sun_alt_deg": 23.77,
             "best": {"jd_utc": 2459205.431448, "utc": "2020-12-21T22:21:17.135Z",
                      "body_alt_deg": 14.72, "other_alt_deg": 14.77, "sun_alt_deg": -8.03}}}]}
```

- `kind`: `planet_planet`, `moon_planet`, `planet_star`, `moon_star`. `body` is the Moon,
  else the inner planet, else the planet; `ra_deg`/`dec_deg` are `body`'s.
- `position_angle_deg`: `body` seen from `other`, north through east ("Jupiter 0.1° south
  of Saturn" is near 180°).
- `local`: apparent (refracted) topocentric altitudes at closest approach, and `best`,
  the moment within 12 hours when the lower of the two stands highest with both above
  the horizon and the Sun below −6°, or `null` when there is none (in the example the
  closest approach is in daylight in Philadelphia; the evening view four hours later is
  what to show).

### `stations(jd_start, jd_end) -> PlanetStationList`

The stations of Mercury to Neptune in the window (at most 80 years), in both ecliptic
longitude and right ascension of date, sorted by time. About 0.15 s a year natively.

```json
{"jd_start": 2460615.5, "jd_end": 2460735.5, "truncated": false, …,
 "stations": [{"body": "Saturn", "kind": "retrograde_ends", "coordinate": "ecliptic_longitude",
               "jd_utc": 2460630.097389, "utc": "2024-11-15T14:20:14.428Z", "angle_deg": 342.6927,
               "ra_deg": 344.8578, "dec_deg": -8.7364, "ecliptic_longitude_deg": 342.6927,
               "elongation_deg": 108.97, "magnitude": 0.87},
              {"body": "Saturn", "kind": "retrograde_ends", "coordinate": "right_ascension",
               "utc": "2024-11-16T05:56:53.757Z", "angle_deg": 344.8575, …}, …],
 "ui_coordinate": "ecliptic_longitude"}
```

`kind`: `retrograde_begins` (the coordinate starts to decrease) or `retrograde_ends`.
`angle_deg` is the coordinate's value at the station. The explorer shows the stations in
`ui_coordinate` (ecliptic longitude, the definition of retrograde motion).

### `earth_apsides(year) -> EarthApsides`

The Earth's perihelion and aphelion in a calendar year (UTC), `year` a whole number inside
the coverage. About 20 ms.

```json
{"year": 2026, "events": [
  {"kind": "perihelion", "jd_utc": 2461044.2192, "utc": "2026-01-03T17:15:38.855Z",
   "distance_au": 0.983302, "distance_km": 147099895.1},
  {"kind": "aphelion", "jd_utc": 2461228.229381, "utc": "2026-07-06T17:30:18.550Z",
   "distance_au": 1.016644, "distance_km": 152087774.1}]}
```

### `parse_orbits(text) -> OrbitalElements[]`

Reads lines in the Minor Planet Center's formats (MPCORB, and the comet format of
`CometEls.txt`, packed designations and dates included; header lines skipped) or JSON: one
object or an array, each either an `OrbitalElements` or a `ManualOrbitalElements`. Throws
on the first line that is neither (`line 3: …`) or on a bad JSON field
(`elements JSON: …`). No dataset ships: the person pastes elements (from the MPC, JPL or a
circular); the MPC asks that "Source: Minor Planet Center" accompany its data.

```json
[{"name": "(1) Ceres", "designation": "(1)", "class": "asteroid", "epoch_jd_tt": 2461200.5,
  "perihelion_distance_au": 2.545159, "eccentricity": 0.079692, "inclination_deg": 10.58803,
  "ascending_node_deg": 80.24863, "argument_of_perihelion_deg": 73.2942, "perihelion_jd_tt": 2459919.988326,
  "magnitude": {"model": "hg", "h": 3.34, "g": 0.15}, "source": "mpcorb"}]
```

Elements typed in by hand (`ManualOrbitalElements`): `name`, `e`, `i_deg`, `node_deg`,
`peri_deg` (J2000 ecliptic), `q_au` or `a_au`, the perihelion time (`tp_jd_tt` or `tp_tt`,
RFC 3339 read on the TT scale) or a `mean_anomaly_deg` at the epoch (`epoch_jd_tt` or
`epoch_tt`), optional `class`, `h`/`g` (asteroids) or `m1`/`k1` (comets). `magnitude` is
`{"model": "hg", h, g}`, `{"model": "comet", m1, k1}` (the MPC's slope `k` read as
`k1 = 2.5 k`) or `{"model": "none"}`.

### `custom_body_states(observer_json, jd_utc, custom_bodies_json) -> CustomBodyStates`

`sky_state` for custom bodies: `custom_bodies_json` is an array of elements as
`parse_orbits` returns them (or typed-in ones). Each body comes back as a `BodyState`
(the same fields and CONVENTIONS 13.2 display values) with `kind` `"comet"` or
`"asteroid"`, `custom: true` and the orbit's own fields; a body the engine cannot place
goes to `errors`, as in `sky_state`.

```json
{"jd_utc": 2461308.0, "utc": "2026-09-24T12:00:00.000Z",
 "bodies": [{"body": "(1) Ceres", "kind": "asteroid", "custom": true,
             "ra_deg": 105.5638, "dec_deg": 23.0870, "gha_deg": 77.7744, "alt_deg": 72.9904, "az_deg": 188.2304,
             "alt_apparent_deg": 72.9955, "magnitude": 8.69, "phase_angle_deg": 21.42, "elongation_deg": 77.17,
             "illuminated_fraction": null, "bright_limb_angle_deg": null, "semidiameter_arcmin": 0.0,
             "constellation": "Gem", …,
             "distance_au": 2.716137, "heliocentric_distance_au": 2.678522, "elements_age_days": 107.5,
             "warnings": ["These elements are 108 days from their epoch. An unperturbed orbit drifts …"]}],
 "errors": []}
```

`elements_age_days` is measured from the epoch (or the perihelion time when no epoch is
given); past 30 days a warning says the unperturbed orbit is drifting from the real one.

### `sample_custom_bodies(observer_json, custom_bodies_json, jd_start, jd_end, step_minutes) -> Sampled`

`sample_bodies` for custom bodies: the same shape, real `Float64Array`s, at most 5 000
samples per body.

## Expansion programme P12 — the lunar limb (`limb.rs`, eclipselimb agent)

Solar-eclipse contacts corrected for the mountains and valleys at the Moon's edge, the
limb profile for drawing, and approximate Baily's beads, from the optional
**`lunar-limb`** pack (LRO LOLA topography). Definitions: CONVENTIONS 15.7; measured
agreement: `docs/ACCURACY.md`, "Lunar limb"; the engine is
`skyfix_almanac::eclipses::limb`, the exports `crates/skyfix-wasm/src/limb.rs`; the
TypeScript mirror is `EclipseLocalOptions`, `SolarEclipseLimb`, `LimbContact`,
`LimbBead`, `LimbProfile`, `LimbPackInfo`, `LimbEngine` and `isLimbEngine` in
`web/src/next/engine/types.ts` ("Expansion programme P12"). Display only, like every
eclipse number.

**Additive.** `eclipse_local(id, observer_json)` is unchanged (its results carry no
`limb` field, so every existing fixture and view is untouched). The limb comes through a
new export and, in TypeScript, an option:

- `eclipse_local_limb(id, observer_json) -> EclipseLocal`: exactly `eclipse_local`'s
  result, plus, for a solar eclipse, `limb: SolarEclipseLimb` (a lunar eclipse has none:
  the limb does not change its contacts). In TypeScript: `engine.eclipseLocal(id,
  observer, { limb: true })` (the WASM wrapper routes to this export; the memoised engine
  keys on the option; an older core throws "eclipse_local_limb: this build of the
  numerical core has no lunar limb. Rebuild it with: npm run wasm --prefix web").
- Without the pack, `limb` is `{loaded: false, note: "Mean limb: the Moon is taken as a
  smooth sphere, so second and third contact can be a few seconds off. Get the Lunar limb
  data pack (Settings → Data packs) to correct them for the Moon's mountains and
  valleys.", contacts: [], profile: null, beads: [], …}` and the mean-limb fields beside
  it are the results to show.

About 25 ms of CPU natively for one eclipse and place, 60-75 ms in WebAssembly, both
measured on a busy machine (about 5 500 slices through the Moon's outline: every 1/8° at
maximum, every 1/16° near each contact); ACCURACY section 19 has the figures.

### `SolarEclipseLimb`

```ts
{ loaded: boolean, pack_version: "2026-09-25" | null,
  note: string,                    // show beside the times (mean limb, or corrected and how well)
  resolution_km: 1.896 | null,     // the terrain's grid, LDEM_16
  local_type: "total" | "annular" | "partial" | "none" | null,   // limb-corrected
  contacts: LimbContact[],         // c1, c2, c3, c4 as they occur, in time order
  duration_s: number | null,       // c1 to c4
  central_duration_s: number | null,             // c2 to c3
  central_duration_correction_s: number | null,  // minus the mean limb's
  interrupted: boolean,            // sunlight returns through a valley between c2 and c3 (a graze)
  profile: LimbProfile | null,     // at the instant of maximum eclipse, every 1/8°
  beads: LimbBead[] }              // approximate, before c2 and after c3, in time order

LimbContact = { kind: "c1" | "c2" | "c3" | "c4", jd_utc, utc,
  mean_jd_utc: number | null,      // the mean-limb contact it corrects (null: gained at the edge)
  correction_s: number | null,     // limb minus mean
  position_angle_deg, vertex_angle_deg,   // where the limbs meet, on the Sun's disc, as the mean-limb events
  limb_position_angle_deg,         // the same point from the Moon's centre: an index into the profile
  limb_height_arcsec,              // the profile's height there
  alt_deg, az_deg, visible,        // the Sun (CONVENTIONS 13.2, 13.3)
  sun_offset_east_arcsec, sun_offset_north_arcsec, sun_radius_arcsec,   // the Sun's disc against the profile
  seconds_per_arcsec }             // how far 1" of limb height moves it: 2-3 s inside the path, > 8 s for a near graze

LimbBead = { contact: "c2" | "c3", jd_utc, utc,
  seconds_from_contact,            // <= 0 before second contact, >= 0 after third
  position_angle_deg, vertex_angle_deg, limb_position_angle_deg, limb_height_arcsec }
```

`local_type` can differ from the mean limb's near the edge of the path: at San Antonio in
2024 the smooth Moon misses totality and the real one gives 15 s of it
(`mean_jd_utc: null` on c2 and c3); where the mean limb says total but light gets
through a valley throughout, the corrected type is `partial`. With the pack loaded but no
eclipse at the place (`visibility: "none"`), `limb.local_type` is `"none"` and the lists
are empty. The beads are approximate (CONVENTIONS 15.7): at most 8 per contact, the
valleys at least 0.1" deep, within 15 s of the contact.

### `lunar_limb_profile(observer_json, jd_utc) -> LimbProfile`

The Moon's outline as the observer sees it at any instant (for drawing the Moon, a graze
or an occultation), with the Sun's place from the ephemeris. Throws `pack_not_loaded: the
lunar limb profile needs the lunar-limb pack (LRO LOLA topography), which is not loaded`
without the pack. About 20 ms natively, 55-65 ms in WebAssembly (a busy machine). In
TypeScript: `LimbEngine.lunarLimbProfile`.

```ts
LimbProfile = { jd_utc, utc,
  start_deg: 0,
  step_deg: 0.0625 | 0.125,        // bin k at position angle start + k step, from the Moon's centre, north through east:
                                   // 1/16° from lunar_limb_profile, 1/8° in an eclipse's limb block
  height_arcsec: (number | null)[],// 5 760 (or 2 880) heights above the 1737.4 km sphere, 0.001"; null where the ring does not reach
  reference_radius_km: 1737.4, reference_radius_arcsec,     // the sphere as seen from here
  mean_limb_k1_arcsec, mean_limb_k2_arcsec,                  // NASA's k1, k2 Moon against it (about +0.3", -0.45")
  sun_radius_arcsec, sun_offset_east_arcsec, sun_offset_north_arcsec,
  axis_position_angle_deg,         // the Moon's north pole on the sky
  parallactic_angle_deg,           // the zenith at the Moon, (-180, 180]
  libration_lon_deg, libration_lat_deg,   // the topocentric libration (the disc's centre)
  moon_distance_km,
  ring_truncated: boolean }        // ground beyond the ring's ±12° might have stood out (never seen)
```

To draw it: radius `reference_radius_arcsec + height_arcsec[k]` at position angle `k ×
step_deg` (exaggerate the heights 50-100 times to see them), north up and east to the
left, or rotate by the parallactic angle for the zenith up.

### `lunar_limb_info() -> LimbPackInfo | null`

`{name: "lunar-limb", version, source, step_deg: 0.0625, resolution_km: 1.896,
reference_radius_km: 1737.4, delta_min_deg: -12, delta_max_deg: 12, min_height_m: -7305,
max_height_m: 6905}` for the installed ring, `null` before. In TypeScript:
`LimbEngine.lunarLimbInfo()`; the WASM wrapper returns `null` from an older core too.

### Loading the pack

`load_pack("lunar-limb", bytes)` (EXPLORER_API "Packs") checks the common header and the
CRC-32 and calls the producer `skyfix_wasm::limb::install_lunar_limb(payload)` (the
`lunar-limb` entry of `packs::PRODUCERS`: label "Lunar limb", description "The mountains
and valleys at the Moon's edge, for eclipse contact times and Baily's beads", provides
`["eclipses:lunar-limb"]`), which decodes the payload (10-25 ms natively, 45-110 ms in
WebAssembly the first time) and keeps it for the page session; a malformed payload
changes nothing, a second install replaces the first. The mock engine's synthetic limb answers from the start
(`MockEngineOptions.limbLoaded: false` makes it wait for `loadPack("lunar-limb", …)`); the
mock has no eclipses, so `eclipseLocal` with the option exists only in the WASM engine.

### The `lunar-limb` pack: file and payload

File `web/public/data/packs/lunar-limb-<rev>.bin` with the sidecar `lunar-limb.json`
(`name`, `version`, `bytes`, `label`, `description`, `provides`, `rev`, `file`,
`sha256`, `gzip_bytes`, `source`, `ring`, `built_by`): 2 212 290 bytes (2.21 MB), 1.66
MB gzipped (GitHub Pages serves it gzipped). Built by `tools/limb/build.py` from LDEM_16
(`tools/limb/fetch.py`); decoded by `skyfix_almanac::eclipses::limb::LimbRing::parse`.
The payload, little-endian (`str8` is a u8 length then UTF-8 bytes):

```text
"LIMB"          4 bytes
u16             payload format (1)
str8            data version (the build date of the ring)
str8            source ("LRO LOLA LDEM_16 V3.1 (LRO-L-LOLA-4-GDR-V1.0), NASA PDS Geosciences Node")
f64             reference radius, km (1737.4: heights are above it)
f64             height quantum, m (5)
f64             grid step, degrees (1/16)
f64             delta_min, degrees (-12)
u16 n_alpha     5760 columns: axis angle alpha_j = (j + 1/2) step
u16 n_delta     384 rows: distance from the mean limb delta_i = delta_min + (i + 1/2) step
u32             body length, bytes
body            the heights in quanta, column after column (all rows of alpha_0, then alpha_1,
                ...), each as the residual from the planar prediction
                p = q[j][i-1] + q[j-1][i] - q[j-1][i-1] (missing neighbours 0): one signed
                byte for -127..127, else the byte 0x80 and the residual as an i16
```

The ring's node `(alpha, delta)` is the unit vector `(sin delta, -sin alpha cos delta,
cos alpha cos delta)` of the mean Earth/polar axis frame (x toward the mean sub-Earth
point, z north): `alpha` is Watts's axis angle, from the north pole toward the side that
appears in the east of the sky; `delta` is positive toward the Earth. Nothing may follow
the body.
## Expansion programme — almanac tables and three-day pages (`almanac_tables.rs`, almanac2 agent)

The rest of the printed Nautical Almanac beside its daily pages: three dates on two
facing pages, Increments and Corrections, the Altitude Correction Tables (Sun, stars and
planets, dip, non-standard conditions, the Moon's two-part table), the additional
corrections for Venus and Mars, the Polaris tables and Conversion of Arc to Time.
Engines: `skyfix_almanac::{opening, tables}`; exports: `crates/skyfix-wasm/src/almanac_tables.rs`;
definitions: CONVENTIONS 13.9.1; measured accuracy: `docs/ACCURACY.md`, "Almanac tables
and three-day pages". TypeScript: `AlmanacTablesEngine` and `isAlmanacTablesEngine`
("Expansion programme Q7" in `types.ts`); the WASM wrapper and the mock
(`engine/mock/almanac-tables.ts`, illustrative numbers from the same formulas) implement
it, and the memoised engine passes the calls through. Display and teaching only: sight
reduction never reads these tables.

**Common rules.** As on the daily pages, every tabulated quantity comes twice: the number
(`arcmin`, `deg`, …) and, under `printed`, the text the table prints, rounded half up as
the printed tables round (CONVENTIONS 13.9.1). Views show `printed`. Cells:

```ts
ArcminCell { arcmin: number, printed: string }   // "+15.3", "-0.8", "0.0", "14 39.2", "62.5"
DegCell    { deg: number, printed: string }      // the Polaris azimuth, "1.2"
CriticalTable {
  argument: "apparent altitude" | "height of eye",
  unit: "deg_min" | "deg" | "m" | "ft",
  columns: string[],                              // ["Lower limb", "Upper limb"], ["Corr"], ["Dip"]
  boundaries: { value: number, printed: string }[],   // "9 53" (deg_min), "42" (deg), "2.4" (m)
  values: ArcminCell[][]                          // values[k] holds between boundaries[k] and [k + 1]
}
```

A critical table is read as printed: an argument above `boundaries[k].value` and at most
`boundaries[k + 1].value` takes `values[k]`; exactly on a boundary, the value above it.
`boundaries.length == values.length + 1`. Errors are strings, prefixed by the WASM
wrapper with the export's name. Calendars: `""` or `"auto"` is the display calendar
(Julian before 1582-10-15, Gregorian from then), `"julian"` and `"gregorian"` name one.

### `almanac_opening(date, calendar) -> AlmanacOpening`

The two facing pages for the three UT dates containing `date` (a wire date as for
`almanac_day`: proleptic Gregorian `YYYY-MM-DD`, with a sign outside 0000-9999: `-0584-05-22`),
grouped from January 1 in `calendar`. Three `almanac_day` pages, unchanged, plus what the
printed opening adds. About 0.2 s native (three daily pages); the view computes it only
once the time has settled.

```json
{"date": "2016-03-08", "calendar": "gregorian", "index": 1,
 "dates": [{"date": "2016-03-07", "calendar": "gregorian", "year": 2016, "month": 3, "day": 7,
            "era_year": 2016, "era": "AD", "weekday": "Monday"}, …3],
 "days": [AlmanacDay, AlmanacDay, AlmanacDay],
 "moon_dates": ["2016-03-07", "2016-03-08", "2016-03-09", "2016-03-10"],
 "moon_days": [OpeningDay × 4],
 "moon_rows": [{"lat_deg": 72, "label": "N 72",
                "moonrise": [TableTime × 4], "moonset": [TableTime × 4]}, …31],
 "planet_sha_00h": [{"body": "Venus", "sha_deg": 32.869128, "printed": {"gha": "32 52.1"}}, …4],
 "notes": ["UT is UT1, as in the printed almanac: enter the tables with UTC + DUT1 …", …, "Three dates per opening, grouped from January 1 …"],
 "errors": []}
```

`index` is the position of `date` among the three. `dates` and `moon_days` are in the
opening's calendar (`year` astronomical, `era_year` and `era` as people write it:
585 BC is `year` −584). Once-per-opening values are `days[1]`'s: the stars, the planets'
magnitudes, v, d and meridian passages, Aries' passage, the Sun's SD and d and the
twilight and sunrise table. `moon_rows` holds moonrise and moonset for the three dates
and the next, at the daily pages' 31 latitudes. Before 1767 `notes` also says the first
Nautical Almanac was for 1767. Throws for a malformed date or calendar, and for a date
outside the coverage (`… is outside the ephemeris coverage (… to …)`).

**Additive change to `almanac_day(date)`:** it now also accepts expanded years
(`-0584-05-22`, `+12026-01-01`) wherever the providers answer; `AlmanacDay.date` is written
the same way. Four-digit dates are unchanged.

### `almanac_increments(minute) -> IncrementsMinute`

One minute's table, `minute` 0 to 59 (else throws). Microseconds.

```json
{"minute": 58,
 "rows": [{"second": 0, "sun_planets": {"arcmin": 870.0, "printed": "14 30.0"},
           "aries": {"arcmin": 872.381981, "printed": "14 32.4"},
           "moon": {"arcmin": 830.366667, "printed": "13 50.4"}}, …61],     // seconds 00..60
 "corrections": [{"v_arcmin": 0.0, "v_printed": "0.0",
                  "correction": {"arcmin": 0.0, "printed": "0.0"}}, …181],  // v or d 0.0..18.0
 "how_to_use": "Take GHA for the whole hour before the time from the daily page. …",
 "example": "Deneb at 08h 58m 27s UT, 9 March 2016 (Bowditch §1906): …",
 "notes": ["Sun and planets: 15° an hour. Aries: 15° 02.464′ an hour. Moon: 14° 19.0′ an hour. …", …]}
```

### `almanac_arc_to_time() -> ArcToTime`

```json
{"degrees": [{"deg": 0, "minutes": 0, "printed": "0 00"}, …360],               // "h m"
 "arcminutes": [{"arcmin": 0, "seconds": [0, 1, 2, 3], "printed": ["0 00", "0 01", "0 02", "0 03"]}, …60],
 "how_to_use": "…", "example": "Longitude 44° 27′ W: …", "notes": ["Exact: 360° of arc = 24 hours of time.", …]}
```

`arcminutes[m].printed[q]` is `m + q/4` minutes of arc in minutes and seconds of time.

### `almanac_altitude_tables(conditions_json) -> AltitudeTables`

`conditions_json` is `""`, `"null"`, or `{"temperature_c": number, "pressure_hpa":
number}`; with conditions the result adds the exact additional corrections for them
(`additional.conditions`). A few milliseconds.

```json
{"refraction": {"model": "Bennett (1982), CONVENTIONS 5", "pressure_hpa": 1010, "temperature_c": 10},
 "sun_sd_oct_mar_arcmin": 16.15, "sun_sd_apr_sep_arcmin": 15.9, "sun_hp_arcmin": 0.146567,
 "sun_oct_mar": CriticalTable,        // columns ["Lower limb", "Upper limb"], from under 10° to 90° 00′
 "sun_apr_sep": CriticalTable,
 "stars_planets": CriticalTable,      // columns ["Corr"]
 "low": [{"alt_deg": 0.0, "printed_alt": "0 00",
          "sun_oct_mar": [{"arcmin": -18.181, "printed": "-18.2"}, {"arcmin": -50.481, "printed": "-50.5"}],
          "sun_apr_sep": [ArcminCell, ArcminCell], "stars_planets": {"arcmin": -34.478, "printed": "-34.5"}}, …109],
 "dip": {"metres": CriticalTable, "feet": CriticalTable,        // 2.2-21.4 m, 7.4-70.5 ft
         "more_metres": [{"height": 1, "printed_height": "1", "dip": {"arcmin": -1.76, "printed": "-1.8"}}, …13],
         "more_feet": [DipRow, …15]},
 "additional": {
   "zones": [{"letter": "A", "factor": 1.12, "factor_low": 1.11, "factor_high": 1.13}, …13],   // A..N, no I
   "rows": [{"alt_deg": 0.0, "printed_alt": "0 00", "standard_refraction_arcmin": 34.478,
             "corrections": [ArcminCell × 13]}, …26],                                        // 0° to 50°
   "chart": {"temperature_c": [-20, 40], "pressure_hpa": [970, 1050]},
   "conditions": {"temperature_c": 31.1, "pressure_hpa": 982.0, "factor": 0.904816, "zone": "M",
                  "corrections": [ArcminCell × 26]} | null},
 "moon": {"hp0_arcmin": 57.7, "hp_rows": [54.0, 54.3, …, 61.5],
          "columns": [{"from_deg": 0, "upper": [ArcminCell × 30],         // every 10′ of the 5° column
                       "lower_alt_deg": 2.5,
                       "lower_limb": [ArcminCell × 26], "upper_limb": [ArcminCell × 26]}, …18],
          "how_to_use": "…", "notes": […]},
 "how_to_use": ["First correct the sextant altitude for index error and dip …", …],
 "examples": [{"title": "A star", "text": "Deneb, apparent altitude 50° 26.6′ (Bowditch §1906): …"}, …],
 "notes": ["Refraction: Bennett (1982) at 1010 hPa and 10 °C …", …]}
```

`zone` is null when the density falls outside A to N. Throws for conditions that are not
that object.

### `almanac_planet_corrections(year, calendar) -> PlanetCorrections`

Venus and Mars through a calendar year (a whole number; `calendar` as above, the Julian
calendar up to 1582 with `""`). About 0.1 s native (the planets' parallax every day).

```json
{"year": 2016, "calendar": "gregorian",
 "venus": [{"from": {"year": 2016, "month": 1, "day": 1}, "to": {"year": 2016, "month": 12, "day": 3},
            "from_jd_utc": 2457388.5, "to_jd_utc": 2457725.5, "hp_arcmin": 0.1,
            "table": CriticalTable}, …],        // unit "deg": whole degrees of Ha, 0 to 90
 "mars": [ParallaxPeriod, …],
 "how_to_use": "…", "notes": […], "errors": []}
```

A day the provider cannot place ends that planet's runs there, with the reason in `errors`
(a year wholly outside the coverage gives two empty lists and two errors).

### `almanac_polaris(year, calendar) -> PolarisTable`

The Polaris tables for a calendar year. A few milliseconds native.

```json
{"year": 2016, "calendar": "gregorian",
 "mean_sha_deg": 316.814769, "mean_dec_deg": 89.331849,
 "printed_mean": {"sha": "316 48.9", "dec": "N 89 19.9"},
 "polar_distance_arcmin": 40.089, "formula_error_arcmin": 0.0068,
 "a1_latitudes": [0, 10, 20, 30, 40, 45, 50, 55, 60, 62, 64, 66, 68],
 "azimuth_latitudes": [0, 20, 40, 50, 55, 60, 65],
 "months": [{"month": 1, "jd_utc": 2457404.0, "sha_deg": 316.770838, "dec_deg": 89.335583}, …12],
 "columns": [{"from_deg": 0,                                      // LHA Aries 0°-9°
              "a0": [{"arcmin": 29.6997, "printed": "0 29.7"}, …11],   // rows 0..10 degrees
              "a1": [ArcminCell × 13], "a2": [ArcminCell × 12],
              "azimuth": [{"deg": 0.4131, "printed": "0.4"}, …7]}, …36],
 "how_to_use": "…",
 "example": {"text": "On April 21 at 23h 18m 56s UT …", "lha_aries_deg": 162.954289,
             "a0_arcmin": 78.8726, "a1_arcmin": 0.6, "a2_arcmin": 0.9,
             "latitude_deg": 49.866210, "rigorous_latitude_deg": 49.866987} | null,
 "notes": […], "warnings": []}
```

`Latitude = Ho − 1° + a0 + a1 + a2`. `example` is the Nautical Almanac 2016's illustration
worked with this year's table (null when the year's table cannot place it); `warnings`
says when the formula's own error passes 0.1′. Throws for a year that is not whole or
whose Polaris place the providers cannot give (the message names the coverage).
## Expansion programme — navigate2 (wave 2): notes for the interface

Additive; no export changed.

- **The instrument of `predict_sextant`, `plan_sights` and `lunar_distance` carries the
  index-error log.** Their `instrument_json` is the Rust `Instrument`, which already took
  `index_error_log` (sailings agent, "Session and reduction additions" above); the web's
  `instrumentJson` (`web/src/next/engine/wasm-nav.ts`) now sends it when it has entries, and
  `SightInstrument` gains `index_error_log?` by declaration merging at the end of
  `web/src/next/engine/types.ts`. Navigate passes the session's log, so a predicted reading
  uses the logged index correction as the sight's reduction does.
- **Actions on the map's measurement** are a page-level registry in
  `web/src/next/map/measure.ts` (`registerMeasureAction`, `measureActions`), not an engine
  call; `web/src/next/map/README.md` describes it.

## Expansion programme — coverage tiers as built (`coverage.rs`, deeptime agent, 2026-09-25)

**Both tiers ship in the core module; there is no `deep-time` pack.** The planner's rule
was to keep both tiers in the core if the module stayed inside its budget: the two-tier
series file is 127 958 bytes (99 276 gzipped), smaller than the three one-tier JSON
files it replaced (477 494 bytes), and the module ends smaller than before: 2 781 402
bytes raw and 1 238 604 gzipped, against main's 3 124 878 and 1 284 157 at f2a1a07
(ACCURACY.md section 21). The packs mechanism is unchanged and serves `tides-us` (and later
`lunar-limb`); no `deep-time` producer is registered, so `packs_loaded` never lists it.

### `explorer_coverage()` — as built

The shape of "`explorer_coverage()` — tiers" above, with these values:

```json
{"start_utc": "-2000-01-01T00:00:00Z", "end_utc": "3000-12-31T23:59:59Z",
 "validated_start_utc": "1550-01-01T00:00:00Z", "validated_end_utc": "2650-01-22T00:00:00Z",
 "packs_loaded": [],
 "groups": [{"name": "Moon", "provider": "skyfix-moon (ELP/MPP02, IAU 2006/2000B)",
             "accuracy_arcmin": 0.02, "validated": true, "notes": "…", "bodies": ["Moon"],
             "tiers": [{"tier": "validated", "start_utc": "1550-01-01T00:00:00Z",
                        "end_utc": "2650-01-22T00:00:00Z", "accuracy_arcmin": 0.02},
                       {"tier": "labelled", "start_utc": "-2000-01-01T00:00:00Z",
                        "end_utc": "3000-12-31T23:59:59Z", "accuracy_arcmin": 0.05,
                        "notes": "outside the validated tier: accuracy measured per century against JPL DE441 (docs/ACCURACY.md, \"Historical accuracy\"); every time shown carries the Delta T uncertainty; display only, not offered for sights"}]},
            …]}
```

- `start_utc`/`end_utc` are the labelled tier's ends (every group answers them);
  `accuracy_arcmin` and `validated` keep describing the validated tier, as before.
- Published figures per group and tier (arcminutes, worst of GHA and Dec, from the
  historical table, ACCURACY.md section 21):

  | group | validated 1550–2650 | labelled 2000 BC–AD 3000 |
  |---|---|---|
  | Sun | 0.01 | 0.02 |
  | Moon | 0.02 | 0.05 |
  | Planets | 0.03 (group); per planet 0.02, Mercury and Venus 0.005, Uranus 0.03 | 0.7 (group); Mercury 0.02, Venus 0.06, Mars 0.15, Jupiter 0.25, Saturn 0.7, Uranus 0.2, Neptune 0.06 |
  | Stars | 0.03 | 0.2 (the catalogue's own proper-motion errors; Rigil Kentaurus apart, see its notes) |

- The Sun, Moon, planet and star groups report their own tiers
  (`skyfix_ephemeris::AstroProvider::tiers`, `Sky::tiered_coverage_groups`).

### `tier_at(jd_utc) -> "validated" | "labelled" | "outside"`

A `#[wasm_bindgen]` export (`crate::coverage::tier_at`) and `WasmEngine.tierAt`: the tier
of an instant on the app's clock, validated 1550-01-01T00:00:00Z ..= 2650-01-22T00:00:00Z,
labelled -2000-01-01T00:00:00Z ..= 3000-12-31T23:59:59Z, otherwise (and for NaN)
`outside`. `time_info().tier` is the same function (the timescales agent's fallback in
`timescale.rs` now calls it). The mock engine answers `validated` over its own
1990–2060 window and `outside` elsewhere, so a tier never promises a position the mock
would refuse.

### Which calls answer the labelled tier

- **The explorer's display path** (`sky_state`, `sample_bodies`, `day_events`,
  `day_events_batch`, `find_altitude`, `moon_phases`, `seasons`, `sidereal`) and the sun
  tools, which share its sky (`suntools.rs`), answer 2000 BC to AD 3000
  (`explorer::native::sky()` is built with `TierPolicy::WithLabelled`).
- **Everything that feeds a sight, a fix or a plan** (sessions, reductions, the planner,
  predicted readings, lunar distances) and the other engines (almanac pages, eclipses,
  planet events, the Moon in detail, deep sky, sailings) keep the validated tier: their
  providers are built with the default `TierPolicy::ValidatedOnly` and refuse the
  labelled tier with `OutOfCoverage`, exactly as they refused dates outside 1990–2060
  before. Their own ranges are unchanged where they had one (eclipses 1990–2060, planet
  events 1990–2060). Opening an engine to the labelled tier is one line
  (`.with_policy(TierPolicy::WithLabelled)`) and its owner's decision.
- The star field (`starfield_apparent`, display only) answers the validated tier
  (1550-01-01 to 2650-01-22; it was 1800–2200).

### Series payload (`crates/skyfix-ephemeris/data/series.bin`)

Not a pack but the same container: magic `SKYFIXPK`, format 1, name `series`, CRC-32 of
the payload (`skyfix_ephemeris::pack`). The payload is `u32` section count, then per
section a 4-byte ASCII tag, `u32` length and the bytes; little-endian throughout; schema
`skyfix.series/2` (in `META`). Every count is checked against the bytes left, every
float must be finite, and a file whose CRC, tags, counts or schema are wrong is refused
with a sentence (a unit test cuts and flips the payload at a hundred places).

| tag | contents |
|---|---|
| `META` | JSON: schema, generator, the tiers' spans, the VSOP87A and ELP/MPP02 sources with their SHA-256, the truncation rules, the secular corrections |
| `VSOP` | `u8` body count (8: Earth, Mercury … Neptune), then per body `u8` index, `u16` n and n `f64` frequencies (the distinct C of its stored terms), and per coordinate (X, Y, Z) `u8` powers, per power `u32` total, `u32` validated, `u32` wide, `u32` fine, `f64` coarse scale, then the terms sorted by amplitude: wide `f64 A, f64 B, u16 k`; fine `f32 A, u32 B, u16 k`; coarse `u16 A, u16 B, u16 k` (B a fraction of a turn in 32 or 16 bits, a coarse A times the scale, k the index of C). The validated tier sums the first `validated` terms of each group, the labelled tier all of them |
| `VCOR` | the corrections to VSOP87A: `f64` mean longitudes of Jupiter and Saturn (the great inequality), the validated band and the blend (days), then per body and tier the basis (`u8` × 5) and per component (longitude, latitude, log-radius) `u16` n and n `f32` coefficients |
| `ELPK` | `u16` 76 and 76 `f64`: ELP/MPP02's constants with this project's secular corrections, and the rotation to the ICRS |
| `ELPS` | `u16` 15 groups; per group `u8` kind (main or perturbation), coordinate, power, `u32` total, validated, wide, `f64` coarse scale, then the terms: main `i8 × 4` multipliers and `f64` (wide) or `f32` amplitude; perturbation `i8 × 13` multipliers and `f32 S, f32 C` (wide) or `u16` amplitude (× scale) and `u16` phase (fine turns) |

`data/series_checks.json` (tests only, not embedded) holds the generator's checkpoints
for the same CRC and its measurement per bin. `tools/reference/build_series.py` writes
both; `make -C tools/reference series`.
