# Explorer engine — wire contract

**Status:** normative. The Rust side is `crates/skyfix-wasm/src/{explorer,starfield,nav,almanac,eclipses}.rs`;
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
| `constellation` | IAU abbreviation (e.g. `"Leo"`), from `skyfix-starfield`; `null` until that crate lands |

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

### `find_altitude(observer_json, body, jd_start, jd_end, altitude_deg) -> TimeEvent[]`

Every instant in the window when the body's **apparent** topocentric altitude crosses
`altitude_deg`, each `{"jd_utc", "utc", "alt_deg", "az_deg", "rising": bool}`. SunCalc's
"reverse calculation" in navigator form: "when is the Sun at 30° this afternoon?"
`alt_deg` here is, like everywhere else, the **geometric** altitude at that instant
(the requested apparent altitude minus the display refraction). Throws when the body
cannot be computed over the window (at most 400 days).

### `moon_phases(jd_start, jd_end) -> PhaseEvent[]`

`[{"kind": "new_moon" | "first_quarter" | "full_moon" | "last_quarter", "jd_utc", "utc"}]`.
Throws when the Moon (or the Sun) cannot be computed over the window — today, until the
Moon provider lands.

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
("Navigation methods") except the running fix's, which live in `skyfix_wasm::nav`.

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
- `VesselMotion` is `{"course_deg", "speed_kn"}`, constant over the run.
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
`solve`; it carries a `geocentric` direction only when the run's own were supplied.

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

## Wave 2 — Moon and planet sights, predicted sextant readings, lunar distance (`nav.rs`)

Specified by the navigation-Moon agent.

## Wave 2 — almanac pages (`almanac.rs`)

Specified by the almanac agent.

## Wave 2 — eclipses (`eclipses.rs`)

Specified by the eclipse agent.
