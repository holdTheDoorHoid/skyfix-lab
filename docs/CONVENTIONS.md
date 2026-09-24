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
  correction is applied anywhere. This is the documented "spherical Earth model".

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
4. **Semidiameter** (Sun only): lower limb `+SD`, upper limb `-SD`, centre `0`. SD comes
   from the ephemeris record (`semidiameter_arcmin`), never a constant.
5. **Parallax in altitude** (Sun only), added: `PA = HP * cos(Ha)`, `HP` from the
   ephemeris record (`horizontal_parallax_arcmin`, ~0.146'). Stars: 0.
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
  the build date). `jd_ut1 = jd_utc + dut1 / 86400` with **DUT1 assumed 0** unless the
  provider is given one. |DUT1| < 0.9 s, so GHA carries up to 0.23' of unmodelled
  error from this assumption; it is listed in the error budget, not hidden.
- **Clock offset**: a shared offset `dt` makes every recorded time wrong by the same
  amount. It shifts every GHA by `omega * dt` (`omega = 15.041 07 deg/h` sidereal for
  stars, 15.000 deg/h for the Sun to first order). For star-only sessions this is
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
  "clock": { "uncertainty_s": 0.0, "correction_s": 0.0 },
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
- `horizon` on an observation overrides the instrument's mode for that sight only.
- `geocentric` supplies the body direction directly ("first numerical slice"). When
  present it wins over any ephemeris provider and the report says so. When absent, an
  ephemeris provider must be able to supply the body at that time or the sight is
  rejected with the provider's coverage in the message.
- Body names: `"Sun"`, the 57 navigational stars and `"Polaris"` by Nautical Almanac
  spelling (`"Vega"`, `"Rigil Kentaurus"`, ...), or `"HIP <number>"`.
- Validation rejects: non-finite numbers, angles outside their ranges, `sigma_arcmin <= 0`,
  timestamps not in RFC 3339 `Z` form, unknown bodies, unknown enum values, duplicate ids,
  `limb != center` for a star, and (`observed_ho` with any correction parameter that
  would have to be ignored) — the last is a warning, not an error.

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
