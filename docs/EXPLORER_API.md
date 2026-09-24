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

## Wave 2 — Moon and planet sights, predicted sextant readings, lunar distance (`nav.rs`)

Specified by the navigation-Moon agent.

## Wave 2 — almanac pages (`almanac.rs`)

Specified by the almanac agent.

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
the curve is within 0.2 km of every chord and no chord exceeds 150 km. Under 50 ms
(10–30 ms measured natively on a loaded machine).

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
