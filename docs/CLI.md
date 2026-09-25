# `skyfix` — the command line

`skyfix` is the whole engine with a terminal in front of it. Every number it prints is
computed by `skyfix-core`, `skyfix-ephemeris`, `skyfix-sim`, `skyfix-almanac`,
`skyfix-motion`, `skyfix-geomag` and `skyfix-tides` (and the display-only
`skyfix-starfield`: the constellation labels of `skyfix sky` and the deep sky); the
expansion programme's commands reach them through the WASM adapter's native layer, so
they print what the site's exports return (see "The expansion programme's engines").
This crate owns the argument parsing, the files and the words.

Two rules hold everywhere:

- **Results go to stdout, diagnostics go to stderr.** `skyfix reduce s.json --csv > out.csv`
  gives you a clean CSV whatever warnings were raised; the warnings are still on your
  terminal.
- **Degrees and arcminutes, never radians** (CONVENTIONS section 1). Longitude is
  east-positive everywhere, on the command line as in the files (section 2). There is no
  colour and there are no terminal escapes, so output can be diffed, piped and pasted
  into an issue.

---

## Exit codes

| code | meaning |
|---|---|
| 0 | everything asked for was done |
| 1 | usage error, unreadable file, parse failure, or a validation error |
| 2 | one or more sights were rejected (or, for `sky` and `events`, a requested body could not be computed); whatever could be was still printed |
| 3 | the solve failed (`solve`, `running-fix`), or `--require-unique` was given and the result was not a unique fix **with a reported 95 % ellipse** |
| 4 | reserved: a subcommand that exists but is not wired up |

Codes compose by taking the worst one a run earned, so a session with a rejected sight
that then fails to solve reports 3, not 2. Code 4 is currently **unreachable** — every
subcommand has been wired since the planner landed — and is kept so that a future
subcommand arriving ahead of its engine reuses it rather than inventing a sixth number.

Two of these are worth stating plainly:

- **An ambiguous or underdetermined result is exit 0**, not a failure. Two sights really
  do cross in two places, and one sight really is a circle. Reporting that is the
  correct answer to the question asked. Pass `--require-unique` when your script needs a
  single position and should stop otherwise.
- **`--require-unique` requires an ellipse as well as a unique fix.** CONVENTIONS
  section 9 withholds the 95 % ellipse exactly when the geometry is rank-deficient,
  effectively singular, or the iteration did not converge. A position from one of those
  is a latitude and longitude with no stated uncertainty, which is not something a script
  may act on, so the flag exits 3 and stderr names the suppression reason. Without the
  flag such a result is still exit 0: the report says plainly what it does and does not
  know, and reading it is the point.
- **`skyfix` maps clap's own usage errors onto 1.** Clap exits 2 by default, which here
  means "some sights were rejected", so the parse is handled explicitly instead.
  `--help` and `--version` print to stdout and exit 0.

---

## Where body directions come from

Every observation may carry its own `geocentric` block (GHA, declination, and for the
Sun semidiameter and horizontal parallax). **A supplied block always wins over any
provider**, and the report says so for each sight it applies to. That rule lives in
`skyfix_core::reduce`, not here, so it is the same in the CLI, the WASM adapter and the
UI.

`--ephemeris` decides only what happens when a block is *absent*:

| value | behaviour |
|---|---|
| `auto` (default) | ask every provider in this build, in order: the Sun provider, then the star provider |
| `supplied` | refuse the sight. This is how the brief's "first numerical slice" fixtures are tested: no astronomy implementation can influence the answer |

`auto` is a `CompositeProvider`, so `direction_source` in the output reads `skyfix-auto`
rather than naming the member that answered. That is a real limitation of the
`DirectionSource` trait, which is asked for its name without being told which body: per
body attribution lives in `skyfix catalog`, where it belongs.

Be careful not to conflate two different things:

- a body **name** being legal — `validate` accepts `"Sun"`, the 57 navigational stars,
  `"Polaris"` and any `"HIP <number>"`, whether or not a provider can compute it, because
  a supplied `geocentric` block makes any name usable (CONVENTIONS section 10);
- a body being **answerable** — whether a provider in this build will return a direction
  for it. That is what `skyfix catalog` reports.

### UT1 − UTC: `--dut1 SECONDS`

The Earth's rotation runs on UT1, a clock is UTC, and the difference (DUT1, within 0.9 s
while leap seconds last) turns every Greenwich hour angle by 15.04″ per second — up to
0.23′, a quarter of a mile of longitude. `--dut1` gives it, from a time signal or IERS
Bulletin A, on every command that reduces, predicts or plans: `reduce`, `solve`,
`predict`, `noon`, `polaris`, `average`, `running-fix`, `lunar`, `plan-sights` and
`plan`. It overrides a session's `clock.dut1_s` (for `lunar`, the input document's
`observer.dut1_s`); without either the engine's own value is used: the IERS history
(observed, then Bulletin A's prediction) where it reaches, else 0 s, and then the error
above is unknown (CONVENTIONS 15.2). A value beyond 0.9 s is used with a warning on
standard error; beyond 60 s it is refused as not being in seconds. The display commands
`sky`, `events`, `eclipses`, `eclipse`, `compass-error`, `limb-profile` and `time-info`
take it too, as the site's DUT1 field (below, "DUT1: `--dut1 SECONDS`").

```console
$ skyfix predict --lat 39.9526 --lon -75.1652 --utc 2026-10-01T03:00:00Z --body Vega \
      --dut1 -0.3
```

The providers are built once per session, with the value at its earliest sight
(CONVENTIONS section 6).

---

## Commands

### `skyfix validate <file>`

Parse and check a session. The format is taken from the `.json` / `.csv` extension, and
from the content when the extension says nothing (a leading `{` is JSON; our CSV dialect
starts with its `# schema=` header block).

| flag | meaning |
|---|---|
| `--json` | print `{"ok":bool,"errors":[...],"warnings":[...]}` instead of sentences |

Errors are fatal to the session (exit 1). Warnings are not (exit 0): each one describes
something legal but worth knowing, such as an `observed_ho` record that also carries an
index correction which will be ignored rather than applied twice.

### `skyfix reduce <file>`

Reduce every observation: where its direction came from, all six correction steps with
before, after, delta and a note, the resulting `Ho` and its sigma, and — only when the
session carries an assumed position — `Hc`, `Zn` and the intercept with its toward/away
letter.

| flag | meaning |
|---|---|
| `--ephemeris auto\|supplied` | see above; default `auto` |
| `--json` | the `Vec<ReducedSight>` as serde emits it. A rejected sight appears as `{"id": ..., "error": ...}` in the same position, so the array stays aligned with the session |
| `--csv` | one row per sight: `id,body,utc,direction_source,gha_deg,dec_deg,ho_deg,sigma_arcmin,hc_deg,zn_deg,intercept_nm` |
| `--dut1 SECONDS` | UT1 − UTC, over the session's `clock.dut1_s` (above) |

For a Moon sight `Hc` and the intercept include the Earth-shape term (CONVENTIONS
15.4), and the text says how much: `Hc includes the Moon's Earth-shape term, +0.057'`.
The JSON carries it as `earth_shape_arcmin`; the CSV's `hc_deg` includes it. When the
session carries an index-error log or a watch log (CONVENTIONS section 10), the text
names the value each sight took from it, in the core's sentence (`index-error log: …`,
`watch log: …`), and the JSON carries it as `index_correction_from_log` and
`clock_correction_from_log`.

A rejected sight never discards the others. The rest are reduced and printed, the
rejections are named, and the exit code is 2.

The `note` column is free text from the core and may run past 80 columns. Every other
column is fixed width.

### `skyfix solve <file>`

Reduce, then solve for position. The report leads with the result kind in capitals on its
own line: `UNIQUE FIX`, `AMBIGUOUS: N CANDIDATES`, `UNDERDETERMINED` or `FAILED`.

| flag | meaning |
|---|---|
| `--ephemeris auto\|supplied` | as for `reduce` |
| `--dut1 SECONDS` | as for `reduce` |
| `--json` | the `FixResult` exactly as serde emits it |
| `--init LAT,LON` | start the iteration here. A starting point only; it never weights a converged fix |
| `--no-init` | ignore the session's assumed position and rely on multistart |
| `--prior LAT,LON,SIGMA_NM` | a genuine Gaussian prior. Its effect on the answer is reported, including the fix without it |
| `--bias` | estimate a shared altitude bias as a third unknown |
| `--robust [K]` | Huber IRLS, `K` defaulting to 1.5. Downweighted sights are named and the covariance is labelled approximate |
| `--clock-sigma SECONDS` | 1-sigma clock uncertainty, propagated east-west. Never estimated |
| `--posterior-scaling` | additionally report the `chi2/dof`-scaled covariance, when there are 3 or more degrees of freedom |
| `--no-multistart` | refine from the initializer only; do not search the globe |
| `--grid-step DEGREES` | coarse multistart grid spacing |
| `--require-unique` | exit 3 unless the result is a single unique fix that also carries a 95 % ellipse |

**How the options are built.** The session contributes first, then the flags override it:

| in the session | becomes |
|---|---|
| `assumed_position` with role `initializer` | `SolveOptions::initializer` — a starting point, never a prior |
| `assumed_position` with role `prior` and its `sigma_nm` | `SolveOptions::prior`, and *not* an initializer, so one position can never act as both |
| `assumed_position` with role `disabled` | nothing |
| `clock.uncertainty_s` | `SolveOptions::clock_uncertainty_s` |

This is CONVENTIONS section 8 taken literally: "an assumed position used only as an
initializer must not silently become a probabilistic prior".

**What the report contains.** For a unique fix: the position in decimal degrees and in
degrees + arcminutes with hemisphere letters; sigma north and east in metres and
nautical miles, with the clock's own contribution to east called out; the 95 % ellipse
with its model string printed verbatim, or the reason it was suppressed; the shared bias
when one was estimated; the residual table; the conditioning numbers with one plain
sentence saying what they mean; the prior and robust reports when either is in use; the
circles of position; and every warning as a sentence.

For an ambiguous result: every candidate formatted exactly like a fix, and a statement
that the observations cannot separate them together with what would — another body 60 to
120 degrees away in azimuth, or independent position knowledge declared as a prior.

For an underdetermined result: each circle with its body, geographic position, zenith
distance and radius in nautical miles, and the sentence *one sight constrains you to a
circle, not a point*.

### `skyfix catalog [--json]`

Every body name a session may use, and which provider answers for it. `"HIP <number>"`
is accepted as a name too and resolves through the star catalogue.

### `skyfix coverage [--json]`

Each provider's own declaration: dates, documented accuracy in arcminutes, how many
bodies, and its provenance notes printed verbatim. Nothing here paraphrases a provider.
Read it before trusting a fix: the star provider assumes DUT1 = 0, which is worth up to
0.23' of GHA, and says so.

### `skyfix convert <in> <out>`

JSON to CSV and back through the core codec, which is defined to round-trip without
loss. The output format comes from the output extension; `-` means stdout and converts
to the other format. The input is validated on the way through, so a file `skyfix
validate` would reject is not quietly rewritten in the other format.

### `skyfix demos [--json]`

The ten packaged simulator scenarios with the description each one carries, written for
someone who does not read Rust.

### `skyfix simulate`

Generate a session and its truth, as two separate documents (docs/SIMULATOR.md
section 1).

| flag | meaning |
|---|---|
| `--demo NAME` | a packaged scenario; see `skyfix demos` |
| `--scenario FILE` | a scenario JSON document |
| `--out-session FILE` | where the session goes. `.csv` writes CSV. Omitted, the session is printed to stdout |
| `--out-truth FILE` | where the truth goes. Omitted, the truth is discarded and stderr says so |
| `--show-truth` | also print the truth. **Off by default**, so a demo in a terminal recording or a pipe cannot leak the answer |

The summary always states what the session legitimately discloses: its assumed position,
and in what role.

### `skyfix experiment`

Run a scenario many times with fresh seeds and score the errors against the uncertainty
the solver predicted.

| flag | meaning |
|---|---|
| `--demo NAME` / `--scenario FILE` | what to run |
| `--repetitions N` | how many seeded repetitions; default 100 |
| `--out FILE` | the per-repetition table, `.json` or `.csv` |
| the `solve` option flags | `--ephemeris`, `--init`, `--no-init`, `--prior`, `--bias`, `--robust`, `--clock-sigma`, `--posterior-scaling`, `--no-multistart`, `--grid-step` |

The solver options are built from one sample generated session's own assumed position
and then the flags, so the solver is set up exactly as `skyfix solve` would set it up for
one of those sessions. `Experiment::check()` then refuses outright if that initializer or
a prior turns out to be the truth position — an experiment started at the answer measures
nothing — and the CLI reports the refusal as exit 1.

Exit 3 when no repetition produced a unique fix with a usable covariance, which is what
`--demo single-sight` does and is a correct result rather than a failure.

### `skyfix plan`

Rank the bodies worth shooting from an approximate position at an instant, by what each
one does to the **conditioning** of the fix rather than by how bright it is
(docs/PLANNER.md).

| flag | meaning |
|---|---|
| `--position LAT,LON` | approximate position, degrees, east-positive longitude. Required, and disclosed in the output |
| `--utc RFC3339` | the instant, UTC with a trailing `Z`. Required |
| `--min-alt DEG` | ignore bodies below this altitude; default 15 |
| `--max-alt DEG` | ignore bodies above this altitude; default 75 |
| `--select N` | how many to recommend; default 5 |
| `--objective min-trace \| min-max-eigen \| min-condition` | what the greedy selection minimises; default `min-trace` |
| `--taken SESSION` | sights already made. They fix the starting geometry, so the answer is what to shoot **next** |
| `--json` | the `Plan` exactly as serde emits it |

The three objectives answer different questions, and the plan prints the core's own
one-line description of whichever you chose:

- **`min-trace`** (A-optimal) minimises the overall size of the fix, in metres. The right
  default: a navigator asks "how big is my error" before "in which direction".
- **`min-max-eigen`** (E-optimal) minimises the *worst* direction — the semi-major axis —
  and drives hard toward a round ellipse. Use it when one direction matters, such as
  closing a coast.
- **`min-condition`** minimises the ellipse's **aspect ratio**. It optimises shape and is
  blind to size, so a plan built on it can end with a *larger* ellipse than one built on
  `min-trace`. Use it to diagnose or repair geometry, not to minimise error.

Three things the command discloses rather than hides:

- **The position is an input.** A planner is allowed an approximate position where a
  solver is not, and the notes say which one it rested on.
- **Visibility is geometric only.** Nothing here knows about cloud, haze, a building or
  the Moon. The Sun's altitude is computed with `SunProvider` and only attaches the
  twilight sentence — it never removes a body.
- **Every note is printed verbatim, one per line, unwrapped**, so the text report and
  `--json` carry byte-identical disclosures.

`--taken` reduces the session first, so a record that supplies its own direction and one
the provider resolves are handled identically, and the sigma used is the *reduced* sigma
— the one an artificial-horizon halving or a low-altitude inflation has already adjusted.
The azimuths are recomputed at the plan's own `--position`, not at the session's assumed
position, so every azimuth in the report is measured from the same place and a session
with no assumed position still works.

An instant outside a provider's coverage is refused (exit 1) rather than answered with
half a sky.

### `skyfix almanac --date YYYY-MM-DD [--format text|json]`

The daily pages of a nautical almanac for one UT date (definitions: CONVENTIONS 13.9;
accuracy: docs/ACCURACY.md section 11), laid out in plain text the way the printed
Nautical Almanac lays them out:

- **left page:** GHA of Aries and GHA/Dec of Venus, Mars, Jupiter and Saturn for every
  hour 00h-23h, with each planet's magnitude, v, d, SHA and meridian passage; Aries'
  meridian passage; SHA and Dec of the 57 navigational stars and Polaris at 12h UT;
- **right page:** GHA/Dec of the Sun and GHA, v, Dec, d, HP of the Moon for every hour,
  the Sun's SD and d, the Moon's SD; twilight, sunrise, sunset, moonrise and moonset for
  the 31 standard latitudes 72 N to 60 S at the Greenwich meridian; the equation of time
  at 00h and 12h, the Sun's and the Moon's meridian passages, the Moon's age and
  percentage illuminated; and the notes that say what every column means.

| flag | meaning |
|---|---|
| `--date YYYY-MM-DD` | the UT date, inside the ephemeris coverage (the help names it, from the engine). Typed like every CLI date: any year (`--date -0584-05-28` needs no `=`), Julian before 1582-10-15 unless `--calendar` says otherwise. Required |
| `--format text \| json` | `text` (default): the two pages in columns; `json`: the `AlmanacDay` document of `docs/EXPLORER_API.md`, raw and printed values |

Every number is exactly the `printed` value of the JSON: rounded as the printed almanac
rounds (0.1′, times to the minute). Symbols: `□` above the horizon all day, `■` below it
(or below the twilight altitude) all day, `////` twilight all night, `24 hh mm` on the
following date, `--` not on the date nor the next. The printed almanac shades a negative
equation of time; plain text cannot, so it prints a minus sign. A malformed date or one
outside the coverage exits 1.

```
$ skyfix almanac --date 2026-09-24 | sed -n '/^RIGHT PAGE/,/^01 /p'
RIGHT PAGE: SUN, MOON, TWILIGHT, SUNRISE, MOONRISE

UT          SUN                             MOON
          GHA        Dec        GHA     v        Dec     d    HP
00   181 57.1  S  0 23.3    32 25.8  14.1  S 12 13.1  13.7  56.0
01   196 57.3  S  0 24.2    46 58.9  14.1  S 11 59.4  13.8  56.1
```

---

## Worked examples

Real output, pasted. Run from the repository root; `$D` is
`crates/skyfix-cli/tests/data`.

### 1. A four-star fix from supplied directions

The fixture is a real Philadelphia sky at 2026-10-01T01:30:00Z with the directions
supplied on each record, so nothing in the astronomy can influence the answer. The
altitudes are the exact altitudes at Philadelphia City Hall and the assumed position is
45 NM away.

```console
$ skyfix solve $D/phl_four_star.session.json
Session    Philadelphia four-star, supplied directions (simulated)
Ephemeris  auto -> supplied directions only
Assumed    40 30.00' N, 075 48.00' W (40.500000, -75.800000), role initializer (starting point only)

UNIQUE FIX
Position     39.952600, -75.165200
             39 57.16' N, 075 09.91' W
Uncertainty  sigma north 1361.0 m (0.735 NM), sigma east 1263.7 m (0.682 NM)
             clock contribution to east 0.0 m (0.000 NM)
Ellipse 95%  semi-major 3332.1 m, semi-minor 3092.3 m, orientation 176.7 deg clockwise from north
             model: nominal 95 %, independent-noise model
Fit          chi2 0.0000 on 2 degree(s) of freedom, converged after 7 iteration(s)

Residuals
  id        body                    Hc deg   Zn deg  resid '    norm  weight  intercept NM
  obs-1     Schedar              51.978993     45.7    -0.00   -0.00    1.00         -0.00
  obs-2     Markab               54.498882    125.4    -0.00   -0.00    1.00         -0.00
  obs-3     Altair               54.618783    214.0    -0.00   -0.00    1.00         -0.00
  obs-4     Eltanin              55.375176    305.7    -0.00   -0.00    1.00         -0.00

Conditioning
  condition number 1.08, rank 2 of 2 (position (north, east)), max azimuth gap 100.0 deg, dilution 1857.2 m per arcminute
  Each arcminute of altitude error moves this fix about 1857 m, and the largest gap
  between sight azimuths is 100 degrees, which is a usable spread.

Circles of position
  obs-1  Schedar  GP 56 41.16' N, 021 47.23' W (56.686056, -21.787119)  zenith distance 38.0210 deg, radius 2281.3 NM
  obs-2  Markab  GP 15 21.16' N, 045 46.56' W (15.352701, -45.776047)  zenith distance 35.5011 deg, radius 2130.1 NM
  obs-3  Altair  GP 08 56.53' N, 094 16.85' W (8.942169, -94.280905)  zenith distance 35.3812 deg, radius 2122.9 NM
  obs-4  Eltanin  GP 51 29.39' N, 122 59.98' W (51.489850, -122.999743)  zenith distance 34.6248 deg, radius 2077.5 NM
$ echo $?
0
```

The recovered position is the truth to the last printed digit; a test asserts it is
within 10 metres, which is the brief's numerical regression target and not a claim about
field accuracy.

Note what the sigma is saying. Four sights at 1.0' each give a 1361 m north sigma and a
3.3 km ellipse — because one arcminute of altitude *is* one nautical mile of position.
The fix is numerically exact and its honest uncertainty is still kilometres wide. Those
are different statements and the report keeps them apart.

### 2. The correction chain, one row per step

`phl_sextant.session.json` is the same sky recorded as raw sextant readings: 2.0' of
index error on the arc, 2.5 m height of eye, 1013.25 hPa and 7.5 C. Each reading is the
value that reduces to the exact `Ho`, so reducing it forwards has to land back on the
truth — and solving it reaches the same position as example 1.

```console
$ skyfix reduce $D/phl_sextant.session.json
Session    Philadelphia four-star, raw sextant readings (simulated)
Ephemeris  auto -> supplied directions only
Assumed    40 30.00' N, 075 48.00' W (40.500000, -75.800000), role initializer (starting point only)

obs-1  Schedar  2026-10-01T01:30:00Z  direction: supplied
  GHA 21.7871 deg   Dec +56.6861 deg
  step                        applied   before deg   after deg  delta '  note
  index_correction            yes        52.071828   52.038495    -2.00  index correction -2.000' added to the sextant reading
  dip                         yes        52.038495   51.992115    -2.78  sea horizon, height of eye 2.500 m: dip 2.783' subtracted
  artificial_horizon_halving  no         51.992115   51.992115     0.00  not applicable: the sea horizon reading is a single angle
  refraction                  yes        51.992115   51.978993    -0.79  Bennett 1982 at Ha 51.9921 deg, 1013.2 hPa, 7.5 C: 0.787' subtracted
  semidiameter                no         51.978993   51.978993     0.00  not applicable: semidiameter is applied for the Sun only
  parallax                    no         51.978993   51.978993     0.00  not applicable: parallax in altitude is modelled for the Sun only (stars: 0.000')
  Ho 51.978993 deg   sigma 1.00'
  Hc 52.011130 deg   Zn 46.2 deg   intercept 1.93 NM A (away)
    - Sight obs-1 carries its own geocentric direction, which was used instead of any
      ephemeris provider.
```

`obs-4` in the same file was taken with a reflected artificial horizon, so its reading is
the double angle. Halving happens after the index correction, there is no dip, and the
sigma is halved with the angle:

```console
obs-4  Eltanin  2026-10-01T01:30:00Z  direction: supplied
  GHA 122.9997 deg   Dec +51.4898 deg
  step                        applied   before deg   after deg  delta '  note
  index_correction            yes       110.806865  110.773531    -2.00  index correction -2.000' added to the sextant reading
  dip                         no        110.773531  110.773531     0.00  not applicable: the artificial_reflected horizon has no dip
  artificial_horizon_halving  yes       110.773531   55.386766 -3323.21  reflected artificial horizon: the reading is the double angle, halved after IC; sigma halved with it (2.000' -> 1.000')
  refraction                  yes        55.386766   55.375176    -0.70  Bennett 1982 at Ha 55.3868 deg, 1013.2 hPa, 7.5 C: 0.695' subtracted
  semidiameter                no         55.375176   55.375176     0.00  not applicable: semidiameter is applied for the Sun only
  parallax                    no         55.375176   55.375176     0.00  not applicable: parallax in altitude is modelled for the Sun only (stars: 0.000')
  Ho 55.375176 deg   sigma 1.00'
```

A record already marked `observed_ho` shows every step as `no` with the note "already in
the reading", never a second subtraction (CONVENTIONS section 4).

### 3. A clock error that leaves no trace

The most instructive demo. Five perfect sights taken with a watch one minute fast: no
noise, no bias, no blunder.

```console
$ skyfix simulate --demo clock-offset --out-session clock.session.json --out-truth clock.truth.json
Scenario   clock-offset
About      Five perfect sights, taken with a watch that is one minute fast. Nothing
           else is wrong: no noise, no bias, no blunder. The sky turns 15.04 degrees an
           hour, so a minute of clock error moves every star's tabulated position
           ...
Session    5 observation(s), first at 2026-10-01T01:31:00.000Z
Disclosure the session carries an assumed position of 40 09.60' N, 075 38.24' W as an INITIALIZER, which starts the iteration and never weights the answer
Session written to clock.session.json
Truth written to   clock.truth.json

$ skyfix solve clock.session.json
...
UNIQUE FIX
Position     39.952600, -75.415884
             39 57.16' N, 075 24.95' W
Uncertainty  sigma north 1205.4 m (0.651 NM), sigma east 1139.9 m (0.616 NM)
             clock contribution to east 0.0 m (0.000 NM)
Ellipse 95%  semi-major 2950.8 m, semi-minor 2790.1 m, orientation 2.2 deg clockwise from north
             model: nominal 95 %, independent-noise model
Fit          chi2 0.0000 on 3 degree(s) of freedom, converged after 3 iteration(s)

Residuals
  id        body                    Hc deg   Zn deg  resid '    norm  weight  intercept NM
  obs-1     sim-Alpha            58.000000     35.0     0.00    0.00    1.00          0.00
  obs-2     sim-Bravo            44.185529    105.2     0.00    0.00    1.00          0.00
  obs-3     sim-Charlie          27.065037    170.5     0.00    0.00    1.00          0.00
  obs-4     sim-Delta            38.498950    240.7    -0.00   -0.00    1.00         -0.00
  obs-5     sim-Echo             61.409973    309.7     0.00    0.00    1.00          0.00
```

The truth is 39.9526, -75.1652. Longitude came out 0.2507 degrees west of it, about
21.3 km, and latitude is untouched to six decimals. **Every residual is zero.** There is
nothing in the data to notice, because clock error and longitude are the same unknown for
star sights (CONVENTIONS section 6) and the solver therefore does not offer to estimate
both.

Declaring what you actually know about the clock is the honest response, and it widens
the answer rather than moving it:

```console
$ skyfix solve clock.session.json --clock-sigma 60
UNIQUE FIX
Position     39.952600, -75.415884
             39 57.16' N, 075 24.95' W
Uncertainty  sigma north 1205.4 m (0.651 NM), sigma east 21384.2 m (11.547 NM)
             clock contribution to east 21353.8 m (11.530 NM)
Ellipse 95%  semi-major 52343.1 m, semi-minor 2950.6 m, orientation 90.0 deg clockwise from north
             model: nominal 95 %, independent-noise model
...
Warnings
  - Clock error and longitude are the same quantity for these sights, so the clock offset
    was not estimated; the stated uncertainty was propagated instead as 21354 metres of
    extra east-west uncertainty.
```

The ellipse is now 52 km along its major axis, oriented due east-west, and it covers the
truth. The position did not improve; the claim about it became true.


### 4. What to shoot, and what to shoot next

The planner ranks by geometry, not brightness. Same place and instant as the fixtures.

```console
$ skyfix plan --position 39.9526,-75.1652 --utc 2026-10-01T01:30:00Z
OBSERVATION PLAN
Position   39 57.16' N, 075 09.91' W (39.952600, -75.165200)
Time       2026-10-01T01:30:00Z
Sun        altitude -31.7 deg, so dark: stars visible, natural horizon likely not (artificial horizon or electronic vertical needed)
Objective  objective min_trace (A-optimal): minimise sqrt(trace of the position covariance), i.e. the overall size of the fix, in metres

Shoot in this order
  #   body                  alt      Zn    mag  sigma '       score
  1   Vega                 61.1   280.1   0.03     1.00        21.8
  2   Polaris              40.0     0.8   1.97     1.00        21.8
  3   Mirfak               27.0    46.0   1.79     1.00       457.1
  4   Alkaid               18.3   319.7   1.85     1.00       337.1
  5   Rasalhague           36.1   254.9   2.08     1.00       186.1

  1.   no sights yet, so position is unconstrained in every direction; this body's azimuth
       280 opens the first line of position. Magnitude 0.03, which did not enter the
       ranking. dark: stars visible, natural horizon likely not (artificial horizon or
       electronic vertical needed).
  2.   current geometry is weak along the N-S axis (no constraint at all on that axis yet);
       this body's azimuth 1 adds constraint there. Magnitude 1.97, which did not enter the
       ranking. dark: stars visible, natural horizon likely not (artificial horizon or
       electronic vertical needed).
  (rationales for 3, 4 and 5 elided)
  score is in nats (growth in ln det of the information matrix; the covariance was still
  singular at this step)
  score is in metres (reduction in sqrt(trace of position covariance))

Predicted quality, sight by sight
  step      sights   sigma N m   sigma E m  semi-maj m  semi-min m      axis    cond gap deg
  before         0           -           -           -           -         -       -   360.0
  +1             1           -           -           -           -         -       -   360.0
  +2             2      1847.7      1904.5      2021.4      1719.1     NE-SW    1.18   279.2
  +3             3      1546.8      1559.4      1721.2      1364.5     NW-SE    1.26   234.0
  +4             4      1283.7      1345.2      1372.0      1254.9   ENE-WSW    1.09   234.0
  +5             5      1260.9      1100.0      1264.0      1096.4       N-S    1.15   208.9

Before these sights there is no position at all — fewer than two independent azimuths,
so no covariance exists. Afterwards the predicted fix is about 1673 m overall.

Excluded
  Deneb             alt  82.7  Zn 320.6  altitude 82.7 deg is above the 75.0 deg maximum: near the zenith the azimuth of the
        line of position is poorly defined (a small altitude error swings it a long way) and
        the sextant is hard to hold and swing

Notes
  - approximate position supplied: 39.9526, -75.1652: ranking is only as good as it
  - geometric visibility only: no weather, no twilight model beyond the Sun-altitude flag
  - brightness is secondary to geometry in this ranking
  - objective min_trace (A-optimal): minimise sqrt(trace of the position covariance), i.e. the overall size of the fix, in metres
  - excluded Deneb: altitude 82.7 deg is above the 75.0 deg maximum: near the zenith the azimuth of the line of position is poorly defined (a small altitude error swings it a long way) and the sextant is hard to hold and swing
  - fewer than two sights were available at the start, so the covariance did not exist: those steps were scored on the growth of ln det(J^T W J) with a ridge of one isotropic pseudo-sight at sigma 1e8 m (about 16 Earth radii, i.e. no navigational information). Their scores are in nats and are not comparable with the later metre-valued scores
  - selected 5 of 17 eligible candidates (1 excluded), starting from 0 sight(s) already taken
  - 18 of 59 bodies offered by skyfix-auto are at or above the 15.0 deg minimum altitude at this place and time; the rest were never ranked
  - twilight flag from the supplied Sun altitude: dark: stars visible, natural horizon likely not (artificial horizon or electronic vertical needed)
```

Read the order, not the magnitudes. It is tempting to conclude that Vega was picked
first because it is magnitude 0.03 and the brightest thing up. It was not: brightness
never enters the arithmetic. With no sights yet, *every* candidate scores identically —
one line of position is one line of position wherever it points, which is why steps 1 and
2 both score 21.8 — and the planner breaks that tie on **altitude**, so Vega wins at 61.1
degrees for being the highest body inside the window. Polaris then follows at magnitude
1.97, and the rationale says exactly why: the geometry is unconstrained north-south and
Polaris is due north, across Vega's westerly line.

The first two scores are in nats rather than metres, and the notes say so. Until there
are two independent azimuths there is no covariance to reduce, so those steps are scored
on the growth of `ln det` of the information matrix instead. That is the same fact the
progression table shows from the other side: the `before` and `+1` rows have no sigma at
all, because one altitude is a circle and a circle is not a position.

Deneb is excluded at 82.7 degrees. Near the zenith a small altitude error swings the
azimuth of the line of position a long way, and the sextant is awkward to swing, so the
default window stops at 75.

Now suppose two sights are already in the book, both in the north-east 0.3 degrees apart
in azimuth — the classic mistake of shooting whatever was in the one clear patch of sky:

```console
$ skyfix plan --position 39.9526,-75.1652 --utc 2026-10-01T01:30:00Z \
      --taken $D/phl_clustered.session.json --select 2
Shoot in this order
  #   body                  alt      Zn    mag  sigma '       score
  1   Alkaid               18.3   319.7   1.85     1.00    443364.5
  2   Eltanin              55.4   305.7   2.24     1.00       418.3

  1.   current geometry is weak along the NW-SE axis (information ratio 115798.9); this
       body's azimuth 320 adds constraint there. Magnitude 1.85, which did not enter the
       ranking. dark: stars visible, natural horizon likely not (artificial horizon or
       electronic vertical needed).
  2.   current geometry is weak along the NW-SE axis (information ratio 2.0); this body's
       azimuth 306 adds constraint there. Magnitude 2.24, which did not enter the ranking.
       dark: stars visible, natural horizon likely not (artificial horizon or electronic
       vertical needed).
  score is in metres (reduction in sqrt(trace of position covariance))

Predicted quality, sight by sight
  step      sights   sigma N m   sigma E m  semi-maj m  semi-min m      axis    cond gap deg
  before         2    319832.6    310322.6    445635.8      1309.6     NW-SE  340.29   359.7
  +1             3      1579.8      1634.6      1860.1      1306.7     NW-SE    1.42   273.6
  +2             4      1346.8      1275.5      1348.3      1273.9       N-S    1.06   259.7
```

The `before` row is what those two sights alone predict: a semi-major axis of **446 km**
against a semi-minor of 1310 m, a condition number of 340, and 359.7 degrees of azimuth
gap. Two nearly parallel circles of position tell you almost exactly where you are along
one line and almost nothing about where you are across it.

One crossing sight fixes it. Alkaid is magnitude 1.85, low at 18 degrees, and nothing
about it is impressive — but its azimuth of 320 is very nearly perpendicular to the pair
already taken, and it brings the semi-major axis from 446 km to 1860 m. That is the
planner's whole argument in one row: a dim body in the right direction beats a bright one
in a direction you already have.

---

## The sky, almanac events and the navigation methods

The explorer redesign gave the engine a model of the whole sky, almanac events, four
navigation methods and Moon and planet sights, and the browser reaches them through WASM
(`docs/EXPLORER_API.md`). These commands reach the same functions, offline:

| command | the question | the engine function |
|---|---|---|
| `sky` | where is everything right now? | `skyfix_almanac::sky::sky_state` |
| `events` | when does it rise, set and transit, and when is twilight? | `skyfix_almanac::events::day_events` |
| `phases`, `seasons` | when are the Moon's phases, the equinoxes and the solstices? | `skyfix_almanac::events::{moon_phases, seasons}` |
| `eclipses` | which eclipses fall in these years, and which can I see? | `skyfix_almanac::eclipses::Eclipses::{find, local}` |
| `eclipse` | what does this eclipse look like from here, and where is its path? | `skyfix_almanac::eclipses::Eclipses::{by_id, local, path}` |
| `planet-events` | when are the planets at opposition, conjunction, greatest elongation or closest? | `skyfix_almanac::planet_events::planet_events` |
| `noon` | what is my latitude from a noon run (and, weakly, my longitude)? | `skyfix_core::methods::noon::noon_sight` |
| `polaris` | what is my latitude from Polaris? | `skyfix_core::methods::polaris::polaris_latitude` |
| `average` | what one sight does a run of rough ones make? | `skyfix_core::methods::averaging::average_sights` |
| `running-fix` | where am I, from sights taken while under way? | `skyfix_motion::request::running_fix_session` |
| `predict` | what will the sextant read, and where do I look? | `skyfix_core::sights::predict::predict_sextant` |
| `lunar` | what time is it, from the Moon? | `skyfix_core::sights::lunar::lunar_distance` |
| `plan-sights` | what should I shoot at tonight's twilights? | `skyfix_ephemeris::visibility::plan_sights` |

Rules every one of them keeps:

- **`--format text|json`**, and `--json` as the older commands spell it. Text prints
  angles in navigator style — whole degrees and decimal minutes to 0.1' (185 m), `183 12.4`
  for an hour angle or a bearing, `N 38 47.1` for a declination, and a sign on every
  altitude so a body below the horizon cannot be read as one above it — and instants to
  the second: RFC 3339 UTC with `Z` from 1972 to 2035, `UT` outside those years (the
  clock is Universal Time there), and a date before 1582-10-15 in the Julian calendar,
  labelled `(Julian)` (CONVENTIONS 15.2-15.3; see *Dates, years and calendars* below).
  A value that rounds to zero never carries a sign.
  JSON is the engine's own result exactly as serde emits it, milliseconds included: the
  wire shapes of `docs/EXPLORER_API.md`. A test calls each engine function directly and
  compares its result with the command's JSON, number by number. `skyfix almanac` takes
  the same `--format text|json` (one type in the code, `crate::cli::OutputFormat`), and
  `skyfix eclipse --path` alone adds `--format geojson`, since only a path is a map.
- **`--lat` and `--lon`** are decimal degrees, longitude east-positive, and a leading
  minus sign needs no `=`: `--lat -33.87 --lon 151.21`.
- **`--bodies`** takes `all`, `solar_system` (or `solar-system`), `navigational`, or a
  comma-separated list of names and groups. Names match without regard to case, stars
  also as `HIP <number>`, and the order given is kept. An unknown name exits 1.
- **A time window** takes a date or an instant at each end. As a start, `2026-10-01`
  means 00:00 UTC that day; as an end it means the END of that day, so `--from 2026-10-01
  --to 2026-10-31` is the whole of October.
- **Dates, years and calendars.** Every date and instant takes any year: four digits for
  0000-9999, else ISO 8601's expanded form with a sign, `-0584-05-28` or
  `+12345-01-01T00:00:00Z`. Years are astronomical: year 0 is 1 BC, -584 is 585 BC. A
  typed date is in the Julian calendar up to 1582-10-04 and the Gregorian from
  1582-10-15, as the explorer shows dates; the ten days between existed in neither where
  the reform was made, and are refused with a sentence saying so. `--calendar julian` or
  `--calendar gregorian` (proleptic, as ISO 8601; accepted by every command) makes every
  typed and printed date use that one calendar, and `--calendar auto` is the default
  rule. A leading minus needs no `=`: `--from -0584-05-01` is a date. JSON output is
  always the wire's proleptic Gregorian (`docs/EXPLORER_API.md`, "Dates and years on the
  wire"), so a `utc` string from JSON goes back in with `--calendar gregorian`. The
  engine itself answers over its ephemeris coverage, which the help of `skyfix almanac
  --date` and `skyfix seasons --year` names from the engine (`time-info` gives a date's
  tier); `skyfix calendar` and `skyfix time-info` work for any year. Table headings say
  `UT` over times printed as UT.
- **The navigation methods read sessions exactly as `solve` does** — JSON or CSV,
  validated against the body list — and take `--ephemeris auto|supplied`. A sight the
  reducer rejects becomes a warning that names it, and the exit code is 2, as for
  `reduce` and `solve`. A method that cannot run at all (no usable sight, sights of two
  bodies, no DR) exits 1 with the engine's reason.
- **A DR is not a prior.** `--dr LAT,LON[,SIGMA_NM]` (default: the session's assumed
  position, with its sigma when its role is `prior`) chooses between answers, predicts
  and propagates uncertainty; it never pulls an answer towards itself
  (`docs/NAVIGATION_METHODS.md` section 1). Leave `SIGMA_NM` out when you do not know it,
  and every result that would have used it says so rather than guessing.
- **Offline.** Nothing here opens a socket or reads a file it was not given.

The examples below are real output, run from the repository root with `$D` standing for
`crates/skyfix-cli/tests/data`, as above; `...` marks lines left out.

### Time zones: `--zone`

The engine works only in UTC, and every report prints UTC beside any zone time
(CONVENTIONS 13.8). The web UI shows a named zone such as `America/New_York` through the
browser's `Intl`, which carries the tz database: every region's offsets and every
daylight-saving rule. This tool deliberately does not carry that database. It is large,
it changes whenever a government moves its clocks, and it would be the one thing here
that goes out of date on its own. So `--zone` accepts only zones that need no database:

| `--zone` | means |
|---|---|
| `utc` (default; also `z`, `gmt`) | UTC |
| `-04:00`, `+05:30`, `+0530`, `-4`, `UTC-4` | a fixed offset from UTC; the sign is required |
| `nautical` | the nautical zone time of the longitude: `ZD = round(lon_east / -15)` hours, zone time + ZD = UTC, so 75 W is ZD +5 |

A named zone is refused with a sentence saying what to type instead — the offset that
applies on your date, such as `-04:00` for US Eastern daylight time. It is never guessed
at: a wrong guess about daylight saving would put every event an hour out, with nothing
on the screen to say so.

`events`, `phases` and `seasons` take `--zone`. `events` has an observer, whose longitude
sets the nautical zone. `phases` and `seasons` have none — the Moon's phases and the
seasons are the same instants everywhere on Earth — so there the nautical zone takes its
longitude from `--lon DEG`, which is refused with any other zone, where it would do
nothing. In all three a date is a date in the zone, from local midnight to local
midnight, and the text shows local time beside UTC; `--format json` keeps the engine's
UTC.

### `skyfix sky --lat --lon --utc [--bodies] [--height] [--pressure] [--temperature]`

The whole sky from one place at one instant: for each body the apparent altitude and the
azimuth (what the eye sees), GHA and declination (what the Almanac tabulates), magnitude,
illuminated fraction and constellation. `--format json` is `sky_state`'s `SkyState`,
which also carries SHA, RA, the ground point, the geometric altitude, the navigator's
`hc_deg`/`zn_deg` at the observer, distances, semidiameters, parallaxes, phase and
bright-limb angles.

| flag | meaning |
|---|---|
| `--lat DEG --lon DEG` | the observer. Required |
| `--utc RFC3339` | the instant. Required |
| `--bodies LIST` | default `all`: the Sun, the Moon, the seven planets and the 58 stars |
| `--height M` | the site's height above the WGS84 ellipsoid (it moves the Moon by its parallax). Not the height of eye. Default 0 |
| `--pressure HPA`, `--temperature C` | the air, for the display refraction. Defaults 1010 hPa, 10 C |
| `--dut1 SECONDS` | UT1 − UTC, the site's DUT1 field. Default: the IERS history at the instant, as the site's `sky_state` uses it |

```console
$ skyfix sky --lat 39.9526 --lon -75.1652 --utc 2026-10-01T01:30:00Z \
      --bodies Moon,Venus,Saturn,Vega,Polaris,Sirius
SKY
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Time       2026-10-01T01:30:00Z
Sky        night: the Sun's centre is at -31 44.0, geometric (CONVENTIONS 13.4)
Aries      GHA 32 18.4

  body                    alt        Az       GHA        Dec     mag   lit  con
  Moon               + 5 24.9   60 52.5  330 29.9  N 26 08.9  -11.29   77%  Tau
  Venus              -22 47.3  261 36.3  178 42.9  S 20 58.7   -4.77   15%  Vir
  Saturn             +27 54.2  112 55.2   20 36.3  N  2 04.8    0.34  100%  Cet
  Vega               +61 04.9  280 03.4  112 50.6  N 38 48.8    0.03     -  Lyr
  Polaris            +39 58.2    0 49.0  345 13.7  N 89 22.4    1.97     -  UMi
  Sirius             -50 49.1   63 21.6  290 43.4  S 16 44.9   -1.44     -  CMa

4 of 6 bodies are above the horizon (upper limb above the sea-level horizon).
...
```

Two altitudes exist and the report never mixes them (CONVENTIONS 13.2). `alt` is the
topocentric apparent altitude — WGS84 site, parallax applied, refraction added — which is
what the eye and the browser's sky view show; the sky phase is defined on the Sun's
geometric altitude, printed in the header. Below -1 degree the display refraction is held
at its -1 degree value, so a body 31 degrees down shows 39' of "refraction": there `alt`
is a display value, not a measurement. The navigator's `Hc` and `Zn` (geocentric,
CONVENTIONS 3) are in the JSON, and `skyfix predict` turns them into a sextant reading.

The constellations come from the display-only star field (CONVENTIONS 13.6): they label,
and never enter a reduction, a fix or a plan. A body that cannot be computed at that
instant is listed under "Not computed", named on stderr, and the exit code is 2; outside
the Sun's display coverage (-2000-01-01 to 3000-12-31, `skyfix explorer-coverage`) there
is no sky phase, so the command exits 1. Outside the validated tier (1550-01-01 to
2650-01-22) the sky is shown as the site shows it, with a note under the table (see "Deep
time").

### `skyfix events --lat --lon --date [--zone] [--bodies] [--horizon standard|dip --height-of-eye M]`

One day's rise, set, upper and lower transit, the Sun's three twilights, and the sky
phases, from local midnight to local midnight in `--zone` — the way the web UI takes a
day in its display zone.

| flag | meaning |
|---|---|
| `--date YYYY-MM-DD` | the day. Required |
| `--zone ZONE` | see "Time zones" above. Default `utc` |
| `--bodies LIST` | default `Sun,Moon` |
| `--horizon standard\|dip` | `standard` (default): rise and set when the centre is at -50' for the Sun, -34' - SD for the Moon, -34' for planets and stars. `dip`: all of those lowered by the dip of the sea horizon, 1.76' x sqrt(height of eye) |
| `--height-of-eye M` | required by `--horizon dip`, and refused without it: on the standard horizon it would silently do nothing |
| `--height M` | the site's height above the ellipsoid (the Moon's parallax). Default 0 |
| `--dut1 SECONDS` | UT1 − UTC, the site's DUT1 field. Default: the IERS history at the day's middle, as the site's `day_events` uses it |

```console
$ skyfix events --lat 39.9526 --lon -75.1652 --date 2026-09-24 --zone -04:00
EVENTS
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200)
Day        2026-09-24 in UTC-04:00: 2026-09-24T04:00:00Z to 2026-09-25T04:00:00Z
Horizon    standard: rise and set when the centre is at -50' for the Sun, -34' - SD for
           the Moon and -34' for planets and stars

Sky phases
  local     UTC                   phase
  00:00:00  2026-09-24T04:00:00Z  night until 05:19:36
  05:19:36  2026-09-24T09:19:36Z  astronomical twilight until 05:51:41
  ...
  20:24:44  2026-09-25T00:24:44Z  night until the end of the day

Sun   day length 12 h 04 min
  local     UTC                   event                    alt        Az
  00:52:47  2026-09-24T04:52:47Z  lower transit       -50 30.9    0 00.0
  05:19:36  2026-09-24T09:19:36Z  astronomical dawn   -18 00.0   74 58.5
  ...
  06:50:15  2026-09-24T10:50:15Z  rise                - 0 50.0   90 02.3
  12:52:37  2026-09-24T16:52:37Z  transit             +49 23.1  180 00.0
  18:54:19  2026-09-24T22:54:19Z  set                 - 0 50.0  269 42.3
  ...

Moon
  local     UTC                   event                    alt        Az
  04:30:45  2026-09-24T08:30:45Z  set                 - 0 49.3  256 29.7
  11:18:18  2026-09-24T15:18:18Z  lower transit       -59 08.2    0 00.0
  17:54:15  2026-09-24T21:54:15Z  rise                - 0 49.4   99 13.9
  23:40:19  2026-09-25T03:40:19Z  transit             +43 49.3  180 00.0
...
```

The Moon's transit at 23:40 local is 03:40Z on the next UTC date: the UTC column always
carries its date. `alt` here is the geometric altitude of the centre, so at a rise or set
it is exactly the threshold used (-50' for the Sun; -34' less the semidiameter for the
Moon). The times are the engine's to the second, but rise and set assume the standard 34'
of refraction at the horizon, and the real air moves them by a minute or more.

`--format json` is the engine's `DayEvents` for the window, with the day that was asked
for alongside: `{"date": "2026-09-24", "zone": "UTC-04:00", "utc_offset_minutes": -240,
"jd_start": ..., "jd_end": ..., "phases": [...], "bodies": [...], "errors": [...]}`.
A body that could not be computed is in `errors`, named on stderr, and the exit code is 2.

### `skyfix phases --from --to [--zone [--lon]]` and `skyfix seasons --year [--zone [--lon]]`

The instants at which the Moon's apparent geocentric ecliptic longitude minus the Sun's
is 0, 90, 180 and 270 degrees, and at which the Sun's own is (CONVENTIONS 13.5), in UTC.
`--format json` is the engine's list, `[{"kind", "jd_utc", "utc"}]`.

| flag | meaning |
|---|---|
| `--from WHEN --to WHEN` | `phases`: the window, a date or an instant at each end. Required |
| `--year YEAR` | `seasons`: the calendar year. Required |
| `--zone ZONE` | see "Time zones" above. Default `utc`, which prints exactly what it always did |
| `--lon DEG` | the longitude of `--zone nautical`, and nothing else |

```console
$ skyfix phases --from 2026-09-01 --to 2026-09-30
MOON PHASES  2026-09-01T00:00:00Z to 2026-10-01T00:00:00Z
  2026-09-04T07:51:14Z  last quarter
  2026-09-11T03:27:00Z  new moon
  2026-09-18T20:43:47Z  first quarter
  2026-09-26T16:49:02Z  full moon
...
$ skyfix seasons --year 2026
SEASONS 2026
  2026-03-20T14:45:57Z  March equinox
  2026-06-21T08:24:30Z  June solstice
  2026-09-23T00:05:13Z  September equinox
  2026-12-21T20:50:14Z  December solstice
...
```

A year or a window that reaches outside the display coverage (-2000-01-01 to
3000-12-31) exits 1. One outside the validated tier is answered, with a note under the
list (see "Deep time").

With `--zone`, a date given to `--from` or `--to` is a date in that zone, and every
instant is shown in it beside UTC. Off Sydney, in nautical zone -10, the December
solstice falls on the 22nd:

```console
$ skyfix seasons --year 2026 --zone nautical --lon 151.21
SEASONS 2026, shown in nautical ZD -10 (UTC+10:00)
  local                UTC                   season
  2026-03-21 00:45:57  2026-03-20T14:45:57Z  March equinox
  2026-06-21 18:24:30  2026-06-21T08:24:30Z  June solstice
  2026-09-23 10:05:13  2026-09-23T00:05:13Z  September equinox
  2026-12-22 06:50:14  2026-12-21T20:50:14Z  December solstice
...
$ skyfix phases --from 2026-09-01 --to 2026-09-30 --zone -04:00
MOON PHASES  2026-09-01T04:00:00Z to 2026-10-01T04:00:00Z, shown in UTC-04:00
  local                UTC                   phase
  2026-09-04 03:51:14  2026-09-04T07:51:14Z  last quarter
  2026-09-10 23:27:00  2026-09-11T03:27:00Z  new moon
...
```

September in US Eastern daylight time runs from 04:00Z on the 1st to 04:00Z on 1 October,
and the new moon of 03:27Z on the 11th is still the evening of the 10th there. The
instants are the engine's whatever the zone, and so is `--format json`: the zone moves
where a date begins and ends, and adds the local column; it never changes an instant.

### `skyfix eclipses --from --to [--kind solar|lunar|all] [--lat --lon [--height]]`

Every solar and lunar eclipse whose greatest eclipse falls in the window
(`Eclipses::find`), from an engine that finds every eclipse of NASA's *Five Millennium
Canon* for 1990-2060, none extra, with the same type and saros, and greatest eclipse
within 1.4 s (solar) and 11 s (lunar) (docs/ACCURACY.md section 12). Each eclipse is
named by its id, the UTC date of greatest eclipse and its kind — `2024-04-08-solar` —
which `skyfix eclipse` takes. With an observer, each row is followed by what that place
sees (`Eclipses::local`): whether the eclipse is seen there, and its local maximum.

| flag | meaning |
|---|---|
| `--from WHEN --to WHEN` | the window, as for `phases`: a date or an instant at each end, UTC. Required |
| `--kind solar\|lunar\|all` | which eclipses. Default `all` |
| `--lat DEG --lon DEG` | an observer. Optional, but both or neither |
| `--height M` | the observer's height above the WGS84 ellipsoid, with `--lat --lon`. Default 0 |
| `--dut1 SECONDS` | UT1 − UTC, the site's DUT1 field. Default: the IERS history |

```console
$ skyfix eclipses --from 2024-01-01 --to 2025-12-31 --lat 32.78 --lon -96.80
ECLIPSES  2024-01-01T00:00:00Z to 2026-01-01T00:00:00Z, solar and lunar
Observer  32 46.80' N, 096 48.00' W (32.780000, -96.800000), 0 m above the WGS84 ellipsoid

  id                type       greatest eclipse          mag  pen.mag    gamma  saros
  2024-03-25-lunar  penumbral  2024-03-25T07:12:53Z  -0.1325   0.9556  +1.0609    113
      here: all of it seen, with the Moon up throughout; greatest eclipse
      2024-03-25T07:12:53Z, Moon alt +54 20.0, Az 196 38.5
  2024-04-08-solar  total      2024-04-08T18:17:20Z   1.0566        -  +0.3431    139
      here: total for 3 min 51 s, with the Sun up throughout; maximum
      2024-04-08T18:42:39Z, magnitude 1.015 (100% of the Sun's area covered), Sun alt
      +64 36.8, Az 188 00.7
...
  2025-03-29-solar  partial    2025-03-29T10:47:27Z   0.9376        -  +1.0405    149
      here: not seen: the Sun is below the horizon throughout; maximum
      2025-03-29T10:14:13Z, magnitude 0.618 (53% of the Sun's area covered), Sun alt
      -26 09.1, Az 66 31.5
...
```

`mag` is a solar eclipse's magnitude — for a total, annular or hybrid one the Moon's
apparent diameter over the Sun's at greatest eclipse, for a partial one the fraction of
the Sun's diameter covered — or a lunar eclipse's umbral magnitude, negative when the
Moon misses the Earth's dark shadow, as in the penumbral eclipse of March 2024; `pen.mag`
is a lunar eclipse's penumbral magnitude. `gamma` is how far the shadow's axis passes
from the Earth's centre, or the Moon's centre from the shadow's axis, in Earth radii,
positive north. A solar eclipse's local maximum is its greatest magnitude at that place,
which is not the instant of greatest eclipse: the one of March 2025 was greatest at
10:47Z over northern Quebec, and would have been greatest from Dallas at 10:14Z, with the
Sun 26 degrees below the horizon there.

`--format json` is the engine's `EclipseList` — the window actually searched, `truncated`,
the coverage, the eclipses and the conventions behind them — with its `eclipses` kept to
`--kind`, `kinds` naming the kinds kept, and, with an observer, `local`: the
`EclipseLocal` of each listed eclipse, in the same order (`docs/EXPLORER_API.md`, "Wave 2
— eclipses"). A window that reaches past the coverage (1990-01-01 to 2060-12-31) is
clipped, and the report and stderr say so; one wholly outside it exits 1.

### `skyfix eclipse <id> [--lat --lon [--height]] [--path] [--format text|json|geojson]`

One eclipse (`Eclipses::by_id`): greatest eclipse and where it happens, the magnitude,
gamma, saros, the path's width and the central duration there, and the contacts of the
shadow with the Earth. With an observer, the local circumstances (`Eclipses::local`):
what kind of eclipse the place sees and whether the Sun or the Moon is up for it, the
duration of totality or annularity, the maximum with its magnitude and obscuration, and
every contact with its UTC and the body's altitude and azimuth. A solar eclipse always
carries an eye-safety line, fitted to what the place sees.

| flag | meaning |
|---|---|
| `ID` | as `skyfix eclipses` lists it: `YYYY-MM-DD-solar` or `YYYY-MM-DD-lunar`, the UTC date of greatest eclipse. Required |
| `--lat DEG --lon DEG [--height M]` | an observer, as for `eclipses` |
| `--path` | print the lines on the map instead (`Eclipses::path`); not with an observer, since the path is the same for everyone |
| `--limb` | with an observer, a solar eclipse's contacts corrected for the Moon's real limb (the `lunar-limb` pack: `--pack web/public/data/packs/lunar-limb`); see "The lunar limb" below |
| `--dut1 SECONDS` | UT1 − UTC, the site's DUT1 field. Default: the IERS history |
| `--format text\|json\|geojson` | `text` (default); `json`; `geojson` only with `--path`, whose default is `json` |

```console
$ skyfix eclipse 2024-04-08-solar --lat 32.78 --lon -96.80
TOTAL SOLAR ECLIPSE  2024-04-08-solar
Greatest   2024-04-08T18:17:20Z at 25 17.32' N, 104 08.85' W (25.288639, -104.147515),
           the Sun at altitude +69 47.6, azimuth 149 23.3 there
Magnitude  1.0566: the Moon's apparent diameter over the Sun's at greatest eclipse
...
Path       197.5 km wide at greatest eclipse, where totality lasts 4 min 28 s
...
SEEN FROM  32 46.80' N, 096 48.00' W (32.780000, -96.800000), 0 m above the WGS84 ellipsoid
Here       total: inside the path of totality, with the Sun up from first contact to
           last
Totality   2024-04-08T18:40:44Z to 2024-04-08T18:44:34Z, 3 min 51 s
Maximum    2024-04-08T18:42:39Z: magnitude 1.015, 100% of the Sun's area covered, Sun
           alt +64 36.8, Az 188 00.7
Eclipse    2024-04-08T17:23:19Z to 2024-04-08T20:02:41Z, 2 h 39 min 22 s from first
           contact to last

  UTC                   event                           Sun alt        Az     P     V
  2024-04-08T17:23:19Z  c1   partial eclipse begins    +60 34.3  145 19.1   226   255
  2024-04-08T18:40:44Z  c2   totality begins           +64 39.9  186 54.4    19    13
  2024-04-08T18:42:39Z  max  greatest eclipse          +64 36.8  188 00.7     -     -
  2024-04-08T18:44:34Z  c3   totality ends             +64 33.2  189 06.8   255   248
  2024-04-08T20:02:41Z  c4   partial eclipse ends      +56 44.2  226 01.9    49    12

Eye safety: never look at the Sun, even when it is mostly covered, without certified
eclipse glasses (ISO 12312-2) or a pinhole projector. Only during totality itself, here
from 2024-04-08T18:40:44Z to 2024-04-08T18:44:34Z, is it safe to look with the naked
eye; the glasses go back on as the first bright point reappears.
...
```

Dallas is inside the path, with 3 min 51 s of totality. USNO's Solar Eclipse Computer
gives 3 min 52.5 s for Dallas at 32.7767 N, 96.797 W and 150 m (with USNO's own Delta-T
of 72.8 s against the 69.201 s here: TT - UTC 69.184 s less the IERS UT1 - UTC of
-0.017 s that day), and every contact of that case agrees with USNO's
within 2 s once the Delta-T is the same (docs/ACCURACY.md section 12). `alt` and `Az`
are the Sun's centre, geometric, from the WGS84 site (CONVENTIONS 13.2); a contact with
the Sun below its rise and set altitude, -50', is marked `Sun down`, and a sunrise or
sunset during the eclipse is a row of its own with the fraction of the Sun covered then.
`P` and `V` say where on the Sun's disc the limbs touch, from its north point and from
its top. A lunar eclipse lists its contacts p1 to p4 with the Moon's altitude at each,
since those instants are the same everywhere and only the Moon's height differs; the
eye-safety line is for solar eclipses only. The Delta-T line gives its standard
uncertainty: DUT1's on the UTC scale (1972 to 2035), the Delta-T model's outside it,
where an ancient eclipse's contacts carry minutes of it. For a future eclipse the true
Delta-T will differ from the value assumed, and each second of difference moves a local
contact by up to about a second.

`--format json` is `{"eclipse": Eclipse, "local": EclipseLocal}`, each exactly as the
engine returns it; `local` is there only with an observer. `--path` prints the engine's
`EclipsePath`: for a solar eclipse the central line, the northern and southern limits of
totality or annularity and of the partial eclipse, and the loops that close them at
sunrise and sunset, each a list of segments of `[lon, lat]` pairs with the UTC Julian
date of every vertex; for a lunar eclipse the point under the Moon at each contact. It
has no text form. `--format geojson` writes the same lines as an RFC 7946
FeatureCollection that a map tool (QGIS, geojson.io, a web map) opens as it is, with the
engine's coordinates unrounded:

```console
$ skyfix eclipse 2024-04-08-solar --path --format geojson
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
...
      "properties": {
        "eclipse": "2024-04-08-solar",
        "eclipse_type": "total",
        "feature": "greatest_eclipse",
...
        "type": "MultiLineString",
...
        "feature": "central_line",
...
```

Every feature's `properties.feature` is the engine's name for it (`greatest_eclipse`,
`central_line`, `umbra_north`, `umbra_south`, `umbra_horizon`, `penumbra_north`,
`penumbra_south`, `penumbra_horizon`, or `sublunar_point` with its `contact`), with a
one-line `description`, the vertex times in `jd_utc`, and the `delta_t_s` the ground
positions assume with its standard uncertainty `delta_t_sigma_s`. Empty lines — a partial eclipse has no central line — are left out. An
id that is malformed or names no eclipse exits 1, and so do `--format geojson` without
`--path`, `--format text` with it, and an observer with it.

### `skyfix planet-events --from --to [--body NAME,...]`

Every opposition, conjunction with the Sun, greatest elongation of Mercury and Venus and
closest approach of Mercury to Neptune in the window (`planet_events`): geocentric, so
the same instants for every observer. All 2266 of 1990-2060 agree one for one with
Skyfield and JPL DE440s, of the same kind, within 3 s for the conjunctions of Mercury and
Venus and 68 s at worst, for a closest approach of Neptune, whose configurations change
slowest (docs/ACCURACY.md section 13).

| flag | meaning |
|---|---|
| `--from WHEN --to WHEN` | the window, a date or an instant at each end, UTC. Required |
| `--body NAME,...` | the planets, Mercury to Neptune, in any case; `all` (default) is the seven. `--bodies` is accepted too |

```console
$ skyfix planet-events --from 2026-01-01 --to 2026-12-31
PLANET EVENTS  2026-01-01T00:00:00Z to 2027-01-01T00:00:00Z
Planets        Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune
               geocentric: the same instants for every observer

  UTC                   planet   event                      elong.    mag  dist au  transit
  2026-01-06T16:36:01Z  Venus    superior conjunction       0 42.6  -3.91   1.7109        -
  2026-01-09T08:05:46Z  Jupiter  closest approach         178 47.3  -2.68   4.2317        -
  2026-01-09T11:41:16Z  Mars     conjunction                0 56.5   1.08   2.4034        -
  2026-01-10T08:42:12Z  Jupiter  opposition               179 44.3  -2.68   4.2319        -
...
  2026-08-15T06:31:35Z  Venus    greatest elongation east  45 53.5  -4.43   0.6860        -
...
  2026-10-24T03:44:08Z  Venus    inferior conjunction       6 30.8  -4.19   0.2729       no
...
32 events in the window.
...
$ skyfix planet-events --from 2032-11-01 --to 2032-11-30 --body Mercury
...
  2032-11-13T09:08:20Z  Mercury  inferior conjunction       0 09.6   6.93   0.6764      yes
...
3 events in the window, with a transit across the Sun's disc: Mercury on 2032-11-13.
...
```

`elong.` is the angle between the planet and the Sun from the Earth's centre: at a
conjunction, how far the planet passes from the Sun's centre (Venus 6.5 degrees in
October 2026, lost in the glare); at a greatest elongation east the planet is an evening
star, west a morning one. `transit` is the engine's flag, meaningful on an inferior
conjunction only: the planet crosses the Sun's disc as seen from the Earth's centre, as
Mercury does on 2032-11-13. Whether and when a transit can be seen from a given place is
not computed. A closest approach is its own event, within days of the opposition or the
inferior conjunction it goes with. `--format json` is the engine's `PlanetEventList` with
its `events` kept to `--body` and `bodies` naming the planets kept; a window that reaches
past the coverage is clipped and says so, and one wholly outside it exits 1.

### `skyfix noon <session>`

Latitude at meridian passage, the time of passage, and a longitude that the command
calls weak because it is (`docs/NAVIGATION_METHODS.md` section 2). The session holds a
run of altitudes of one body around its meridian passage, or a single altitude.

| flag | meaning |
|---|---|
| `--dr LAT,LON[,SIGMA_NM]` | the DR. It picks the side of the zenith and predicts when noon should be. Default: the session's assumed position |
| `--vessel COURSE,SPEED` | course and speed over the ground during the run, degrees true and knots. Leave it out on a moving vessel and the peak is taken for the passage: 32' of longitude wrong in the 15-knot case of section 2.6 |
| `--body-bearing auto\|north\|south` | which side of the zenith the body crossed; `auto` decides from the DR |
| `--curvature predicted\|fitted` | `predicted` (default): the exact curve from the geometry; `fitted`: a free parabola, three or more sights |
| `--single-altitude maximum\|ex-meridian` | one sight: the recorded peak (default), or an altitude at its recorded time reduced to the meridian on the DR longitude |
| `--ephemeris auto\|supplied` | as for `reduce` |

```console
$ skyfix noon $D/noon_equinox_sun.session.json --dr 39.779322089,-75.295321012,10
NOON SIGHT
Session    Philadelphia equinox noon, 21 Sun sights (simulated)
Ephemeris  auto -> skyfix-auto
DR         39 46.76' N, 075 17.72' W (39.779322, -75.295321), sigma 10 NM, from --dr

Sun, 21 sight(s): curve fit, curvature predicted; the Sun crossed the meridian SOUTH of
the zenith

Latitude   39 57.16' N (39.952600) sigma 0.11'
           The Sun crossed your meridian SOUTH of the zenith, so latitude = declination +
           zenith distance, counting north as positive: −0°16.3′ + 40°13.5′ = +39°57.2′
           (39°57.2′ N). Zenith distance = 90° − meridian altitude 49°46.5′.
Meridian   altitude +49 46.5 (Ho of the centre at passage), declination S 0 16.3, zenith
           distance 40 13.5
Passage    2026-09-23T16:52:58Z sigma 7.0 s
Longitude  075 09.91' W (-75.165200) sigma 1.75' of longitude, 1.34 NM east-west (of
           which the clock 0.00')
           Near noon the Sun's height hardly changes: for about 5 minutes either side of
           the peak it is within 1′ of its highest. The time of the peak — and the
           longitude, which is nothing but that time — is therefore uncertain by ±7 s (1
           sigma): ±1.7′ of longitude, ±1.3 NM east–west. The latitude does not suffer
           from this: it comes from how HIGH the peak is, not WHEN it happened. Every 4
           seconds of timing error move the longitude 1′.
Peak       2026-09-23T16:52:45Z at +49 46.5, 12.5 s before passage
...
DR check   the DR predicts passage at 2026-09-23T16:53:29Z (sigma 52 s); answer minus DR:
           latitude +10.40', longitude +7.81'
...
```

The session is the Skyfield case `philadelphia-equinox-sun` of
`fixtures/reference/nav_methods.json`: 21 noise-free lower-limb sextant readings. The
truth is 39.9526 N, 75.1652 W with passage at 16:52:57.689Z, and the answer is within
0.001' and 0.1 s of it. Note the two sigmas: 0.11' of latitude from the height of the
peak, 1.75' of longitude from its time. That is not a weakness of the method; it is
the flat top of the curve, and the report says so in words.

`noon_bowditch_1910.session.json` is Bowditch's own example (section 1910), a single
altitude on a vessel making 10 knots on 045: `skyfix noon
$D/noon_bowditch_1910.session.json --vessel 45,10` gives 39 48.78' N against the book's
39 48.6', a difference `docs/NAVIGATION_METHODS.md` section 6.2 accounts for piece by piece.

### `skyfix polaris <session>`

Latitude from one or more sights of Polaris, solved exactly on the DR meridian, with the
Nautical Almanac's a0, a1, a2 terms beside it for teaching (section 3). Other bodies in
the session are ignored, with a warning naming them.

| flag | meaning |
|---|---|
| `--dr LAT,LON[,SIGMA_NM]` | the DR; its longitude is required (Polaris' correction depends on its hour angle), and its sigma enters the latitude's. Default: the session's assumed position |
| `--vessel COURSE,SPEED` | the run between several sights |
| `--reference-utc RFC3339` | the instant a combined latitude refers to; default the last sight |
| `--ephemeris auto\|supplied` | as for `reduce` |

```console
$ skyfix polaris $D/polaris_bowditch_1912.session.json --dr 40.766666667,-43.366666667,10
LATITUDE BY POLARIS
Session    Bowditch 1912: latitude by Polaris (real)
Ephemeris  auto -> skyfix-auto
DR         40 46.00' N, 043 22.00' W (40.766667, -43.366667), sigma 10 NM, from --dr

Latitude   40 48.47' N (40.807792) sigma 0.25' at 2016-03-22T23:18:56Z

Sights
  id        UTC                         Ho       LHA        Zn  latitude     sigma '
  polaris   2016-03-22T23:18:56Z  +40 52.1   84 29.7  359 07.4  40 48.47' N     0.25
    correction (latitude - Ho) -3.63'; sigma parts: altitude 0.20', DR longitude 0.15
    (+0.0153' per NM east), clock 0.00'

Almanac Polaris table, unrounded (teaching only; the rigorous latitude is above)
  id         LHA Aries    a0 '    a1 '    a2 '  Ho - 1 + a0 + a1 + a2   rigorous minus '
  polaris     127 15.1   54.93    0.52    0.91  40 48.47' N                       -0.001
...
```

Bowditch works this example to 40 48.4' N with LHA Aries 127 15.1 and a0, a1, a2 of
54.9', 0.5' and 0.9'. The table's own formula agrees with the rigorous answer to 0.001'
here; the command never uses it for the answer, because near the pole it drifts (0.8' at
88.5 N, 16' at 89.8 N).

### `skyfix average <session>`

A run of sights of one body, taken over a few minutes, averaged into one sight whose
level is fitted while its shape — the body's real rate of climb or fall at the DR — is
predicted (section 4). The text ends with the averaged sight as one line of session
JSON, ready to paste into a session for `skyfix solve`.

| flag | meaning |
|---|---|
| `--dr LAT,LON[,SIGMA_NM]` | where the slope is predicted. Default: the session's assumed position |
| `--reference-utc RFC3339` | the instant of the averaged sight; default the weighted mean time, where its sigma is smallest |
| `--vessel COURSE,SPEED` | the run during the sights |
| `--keep-outliers` | flag outliers but keep them in the average (they are left out by default) |
| `--outlier-threshold SIGMAS` | default 3 |
| `--ephemeris auto\|supplied` | as for `reduce` |

```console
$ skyfix average $D/average_vega.session.json --dr 40.077256408,-74.882250386,10
AVERAGED SIGHT
Session    Vega, seven sights over three minutes (simulated)
Ephemeris  auto -> skyfix-auto
DR         40 04.64' N, 074 52.94' W (40.077256, -74.882250), sigma 10 NM, from --dr

Vega       at 2026-10-01T01:30:00Z: Ho +61 04.3 (61.072473 deg) sigma 0.19'
           7 of 7 sight(s) used; outliers left out: none
Slope      -11.336'/min predicted at the DR (sigma 0.018'/min), curvature +0.0035'/min^2
Free line  slope -11.353 +/- 0.189'/min, Ho 61.072473 deg sigma 0.19', z -0.09:
           consistent with the predicted slope
...
```

Vega was falling eleven arcminutes a minute; Skyfield's altitude at 01:30:00Z is
61.072473 degrees, and so is the average.

### `skyfix running-fix <session> --leg [START,]COURSE,SPEED ...`

A fix from sights taken while under way: each sight's geographic position is advanced
along the dead-reckoning track to one instant, the track's own uncertainty is folded into
each sight's sigma along its line of sight, and the ordinary solver does the rest
(`docs/MOTION.md`; section 5). The result is the same report `skyfix solve` prints, after
the workings of the advance.

| flag | meaning |
|---|---|
| `--leg [START_UTC,]COURSE,SPEED` | a dead-reckoning leg, repeated for each leg in time order. Only the first may leave out its start, which is then the first sight. Required |
| `--end-utc RFC3339` | when the track stops; the vessel is stationary after it |
| `--reference-utc RFC3339` | the instant the fix is for; default the last sight |
| `--speed-sigma KN`, `--course-sigma DEG`, `--random-walk NM_PER_SQRT_H` | the dead reckoning's 1-sigma errors. All zero (the default) means *not stated*: the run is then treated as exact, and the report says so |
| the `solve` flags | `--ephemeris`, `--init`, `--no-init`, `--prior`, `--bias`, `--robust`, `--clock-sigma`, `--posterior-scaling`, `--no-multistart`, `--grid-step`, `--require-unique` |

The solver options are built exactly as `skyfix solve` builds them: the session's assumed
position in its declared role, its clock uncertainty, then the flags. So a running fix of
sights taken at one place is the fix `solve` gives.

```console
$ skyfix running-fix $D/running_fix_north.session.json --leg 0,12 \
      --speed-sigma 0.5 --course-sigma 2
RUNNING FIX
Session    Running fix, three stars an hour and a half apart, 12 kn due north (simulated)
Ephemeris  auto -> skyfix-auto
Assumed    none: Hc, Zn and the intercept need an assumed position
Reference  2026-10-01T03:00:00Z (the last sight)
Track      from the first sight: course 000 at 12 kn
Motion     1-sigma speed 0.5 kn, course 2 deg, random walk 0 NM per sqrt(hour)
Advance    applied in 2 pass(es), linearised at 40 36.01' N, 069 59.99' W (40.600232,
           -69.999771)

What the dead reckoning adds to each sight's sigma
  id         h to ref   run NM        Zn   sight '  motion '   total '
  r0            +3.00     36.0   44 42.5      0.50      1.38      1.47
  r1            +1.50     18.0  172 04.8      0.50      0.75      0.90
  r2             0.00      0.0  290 29.8      0.50      0.00      0.50

UNIQUE FIX
Position     40.600001, -70.000004
             40 36.00' N, 070 00.00' W
Uncertainty  sigma north 1502.1 m (0.811 NM), sigma east 1077.5 m (0.582 NM)
...
Warnings
  - RUNNING FIX at 2026-10-01T03:00:00.000Z: 3 sight(s) were converted to equivalent
    stationary sights ...
  - RUNNING FIX uncertainty is OPTIMISTIC: every sight's inflated sigma carries the same
    speed and course error, so those inflations are correlated across sights, ...
```

The Skyfield truth (`due-north-12kn`) is 40.6 N, 70.0 W: the fix is 0.4 m from it. The
first sight's own 0.50' becomes 1.47' after three hours of dead reckoning, and the second
warning is the one to read twice: the ellipse is a lower bound, because the solver treats
the inflated sigmas as independent and they are not. `--format json` is the engine's
`RunningFixOutput`, whose `result` is the `FixResult` `solve --json` prints. Exit codes
are `solve`'s: 3 when the fix failed, or under `--require-unique` when it is not a single
fix with an ellipse.

### `skyfix predict --lat --lon --utc --body [--limb] [--height-of-eye] [--ic] [--horizon]`

What the sextant will read, and where to look: the computed altitude `Hc` run backwards
through the very correction chain `reduce` runs forwards, so reducing the predicted
reading gives `Hc` back to 1e-9 degrees (`docs/NAVIGATION_SKY.md` section 3). The Sun,
the Moon, Venus (at its centre of light), Mars, Jupiter, Saturn and the stars; Mercury,
Uranus and Neptune are refused, as they are for sights.

| flag | meaning |
|---|---|
| `--body NAME` | Required |
| `--limb lower\|upper\|center` | for the Sun and the Moon; ignored with a warning on a planet or star. Default `center` |
| `--height-of-eye M` | the dip of the sea horizon. Default 0 |
| `--ic ARCMIN` | index correction, ADDED to the reading (index error on the arc is negative). Default 0 |
| `--horizon sea\|artificial\|electronic` | a reflected artificial horizon reads the double angle. Default `sea` |
| `--shore NM`, `--ic-log UTC,ARCMIN` | a shoreline nearer than the sea horizon, and an index-error log (see "The sight optics" under `star-id` below) |
| `--pressure HPA`, `--temperature C` | the air, for refraction. Defaults 1010 hPa, 10 C |

```console
$ skyfix predict --lat 39.9526 --lon -75.1652 --utc 2026-10-01T03:00:00Z \
      --body Moon --limb lower --height-of-eye 2.5 --ic -2.0
PREDICTED SEXTANT READING
Body        Moon, lower limb
Observer    39 57.16' N, 075 09.91' W (39.952600, -75.165200)
            height of eye 2.5 m, 1010 hPa, 10 C
Instrument  sea horizon, index correction -2.0' (added to the reading)
Time        2026-10-01T03:00:00Z
Direction   GHA 352 05.0, Dec N 26 18.3, SD 16.17', HP 59.34' (from skyfix-auto)

Hs  +20 28.8   the sextant reading: set this on the arc
Zn   73 06.1   the true bearing to look along
Hc  +21 33.2   the computed altitude here; reducing Hs gives it back
         including the Moon's Earth-shape term, +0.057' (CONVENTIONS 15.4)
Ha  +20 24.0   the apparent altitude after the index correction and the horizon step
...
```

The Moon reads more than a degree below its computed altitude: 55.5' of parallax and
16.3' of semidiameter, less 2.7' of refraction, 2.8' of dip and the 2.0' index correction.
That is exactly why presetting `Hc` on the arc would not bring it into the telescope. For
the Moon `Hc` also carries the Earth-shape term (CONVENTIONS 15.4): the part of its
parallax that the spherical Earth leaves out, here +0.057', so the reading is what a
perfect sextant shows on the real Earth. A body below the lowest altitude the horizon
lets a sextant show exits 1 and says so.

### `skyfix lunar <input.json>`

Clear a lunar distance and find the UTC it was taken at (`docs/NAVIGATION_SKY.md`
section 4). The input is the WASM export's own document, a `LunarDistanceInput`
(`docs/EXPLORER_API.md`): the DR, the instrument, the body, the watch's time, the sextant
reading of the distance, and optionally the observed altitudes. `-` reads it from
standard input.

```console
$ skyfix lunar $D/lunar_19.input.json
LUNAR DISTANCE: the Moon to Venus
DR         23 08.66' N, 103 06.47' W (23.144300, -103.107900)
           height of eye 10 m, 1010 hPa, 10 C
Reading    74 14.4 (74.240349 deg), the Moon's near limb to Venus's centre, index
           correction -1.5'
Watch      2029-10-17T01:05:43Z

UTC        2029-10-17T01:15:25Z sigma 41.7 s
Watch      +9 min 42 s: add this to the watch's time
Longitude  sigma 10.45' of longitude, 9.61 NM at the DR latitude, from the time's sigma
Distance   apparent between the centres 74 28.3, cleared (geocentric) 74 22.9, changing
           +0.476'/min
...
```

The input is the Skyfield case `lunar-19`, whose answer is 2029-10-17T01:15:25Z. Every
clearing step, the altitudes used, the error budget term by term and any other instant
in the window with the same distance follow. A distance no instant in the window
matches exits 1 with the engine's sentence.

### `skyfix plan-sights --lat --lon --from --to [--height-of-eye] [--ic] [--horizon]`

Tonight's sights: the next evening and the next morning nautical twilight in the window
(the Sun's centre between -6 and -12 degrees; at most 7 days), and for each the three to
five bodies with the best spread round the horizon, bright enough for that twilight,
with their predicted sextant readings at the start of the window (section 5). Not to be
confused with `skyfix plan`, which ranks what is up at one instant.

```console
$ skyfix plan-sights --lat 39.9526 --lon -75.1652 --from 2026-10-01T12:00:00Z \
      --to 2026-10-02T12:00:00Z --height-of-eye 2.5
TONIGHT'S SIGHTS
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200)
           height of eye 2.5 m, 1010 hPa, 10 C
Instrument sea horizon, index correction +0.0' (added)
Window     2026-10-01T12:00:00Z to 2026-10-02T12:00:00Z

EVENING NAUTICAL TWILIGHT  2026-10-01T23:09:48Z to 2026-10-01T23:41:08Z
  predicted for 2026-10-01T23:09:48Z, the Sun at -6 00.0; limiting magnitude 1.5
  #   body                mag  limb          Hs        Zn        Hc
  1   Deneb              1.25  centre  +69 09.2   65 50.9  +69 06.0
  2   Altair             0.76  centre  +56 16.3  152 32.6  +56 12.8
  3   Antares            1.06  centre  +16 00.5  212 27.6  +15 54.4
  4   Arcturus          -0.05  centre  +28 14.5  271 58.1  +28 09.9
...
```

The evening's four run from 66 to 272 degrees of azimuth and the morning's five right
round the horizon: the spread that cancels an unknown shared altitude error (dip, index
error, refraction) as well as fixing the position. The brightness limit is a stated rule
of thumb, not a model of the twilight sky, and the plan says so in its notes.

### `skyfix calendar <DATE> | --jd JD [--calendar julian|gregorian]`

A date or an instant in both calendars, with its Julian date, weekday, and what the clock
is then: UTC from 1972 to 2035 and UT (UT1) outside, TT minus the clock, Delta-T with its
standard uncertainty and source, and UT1 - UTC (CONVENTIONS 15.2-15.3). The engine
functions are `skyfix_core::calendar::calendar_convert` and `skyfix_core::time::time_info`;
`--format json` prints the first's `CalendarConversion` with `weekday` and `time_info`
beside it (`docs/EXPLORER_API.md`). A date means 00:00 that day.

| flag | meaning |
|---|---|
| `DATE` | `2026-09-24`, `-0584-05-28`, or an instant `2026-09-24T12:00:00Z`; Julian up to 1582-10-04 and Gregorian from 1582-10-15 unless `--calendar` says otherwise |
| `--jd JD` | a Julian date on the app's clock instead |

```console
$ skyfix calendar -0584-05-28T12:00:00Z
CALENDAR
Julian date  1507900.000000  (MJD -892100.500000); a Wednesday
Julian       -0584-05-28  28 May 585 BC, astronomical year -0584  12:00:00.000
Gregorian    -0584-05-22  22 May 585 BC, astronomical year -0584  12:00:00.000 (proleptic)
Shown as     Julian: the Julian calendar before 1582-10-15, the Gregorian from it
Wire         -0584-05-22T12:00:00.000Z (proleptic Gregorian)
Clock        UT (Universal Time, UT1: outside the UTC years 1972-2035)
TT - clock   18213.2 s (5 h 03 min 33 s)
Delta-T      18213.2 s (5 h 03 min 33 s), standard uncertainty 3 min: Stephenson, Morrison & Hohenkerk 2016, 2020 revision
UT1 - UTC    none: the clock is UT1
...
```

The eclipse Thales is said to have foretold fell on this day. Delta-T, five hours then,
comes from the historical record of eclipses and occultations, and its three minutes of
standard uncertainty are 45' of longitude on the ground: why an ancient eclipse path is
drawn as a band (docs/ACCURACY.md, "Delta-T"). Britain and its colonies kept the Julian
calendar until 1752, so dates in their records before then need `--calendar julian`:
there Wednesday 2 September 1752 (Julian) was followed by Thursday 14 September
(Gregorian), and `skyfix calendar 1752-09-03 --calendar julian` shows that the two name
the same day.

---

## The expansion programme's engines

The expansion programme (`docs/EXPANSION_PLAN.md`) gave the engine the sun tools, the
magnetic field, sailings, time scales and calendars, optional data packs, the Moon and
the planets in detail, deep sky, tides and the lunar limb. Each is reachable from the
command line with the JSON its WASM export returns, so a number on the site can be
reproduced, and scripted, without a browser:

| family | commands | the exports (`docs/EXPLORER_API.md`) |
|---|---|---|
| sun tools | `sun-hours`, `find-azimuth`, `alignment-days`, `rise-set-azimuths`, `analemma`, `sun-path`, `equation-of-time`, `solar-day`, `solar-year`, `galactic-centre` | `sun_hours`, `find_azimuth`, `alignment_days`, `rise_set_azimuths`, `analemma`, `sun_path`, `equation_of_time`, `solar_day`, `solar_year`, `galactic_centre_windows` |
| magnetic field | `variation`, `magnetic-grid`, `compass-error` | `magnetic_field`, `magnetic_grid`, `compass_error` |
| passage and sights | `sailing`, `dr-advance`, `route-positions`, `star-id`, `star-finder` | `sailing`, `dr_advance`, `route_positions`, `star_identify`, `star_finder_geometry` |
| time | `time-info`, `calendar-convert` | `time_info`, `calendar_convert` |
| deep time | `explorer-coverage`, `tier-at` | `explorer_coverage`, `tier_at` |
| packs | `packs`, and `--pack FILE` on every command | `packs`, `load_pack` |
| the Moon | `moon-orientation`, `moon-features`, `moon-apsides`, `occultations` | `moon_orientation`, `moon_features`, `moon_apsides`, `occultations` |
| deep sky | `dso-catalog`, `dso-list`, `dso`, `showers`, `milky-way`, `search`, `tonight`, `extinction` | `dso_catalog`, `dso_list`, `dso_visibility`, `meteor_showers`, `milky_way_outline`, `sky_search`, `tonight`, `extinction_table` |
| planets | `galilean-moons`, `galilean-events`, `saturn-rings`, `planet-disc`, `transits`, `conjunctions`, `stations`, `earth-apsides`, `orbit` | `galilean_moons`, `galilean_events`, `saturn_rings`, `planet_disc`, `transits`, `conjunctions`, `stations`, `earth_apsides`, `parse_orbits`, `custom_body_states`, `sample_custom_bodies` |
| tides | `tide-stations`, `tide-station`, `tide-predict`, `tide-extremes`, `tide-now`, `tide-pack` | `tide_stations_near`, `tide_station`, `tide_predict`, `tide_extremes`, `tide_now`, `tide_pack_info` |
| lunar limb | `eclipse --limb`, `limb-profile`, `limb-pack` | `eclipse_local_limb`, `lunar_limb_profile`, `lunar_limb_info` |
| almanac tables | `almanac-opening`, `almanac-increments`, `almanac-arc-to-time`, `almanac-altitude`, `almanac-planets`, `almanac-polaris` | `almanac_opening`, `almanac_increments`, `almanac_arc_to_time`, `almanac_altitude_tables`, `almanac_planet_corrections`, `almanac_polaris` |

**How they answer.** These commands call the WASM adapter's native layer
(`skyfix_wasm::<module>::native`): the function each export calls, with the export's own
arguments, returning what the export serialises. The flags build those arguments (the
observer document, the request document, the Julian dates), and `--format json` prints
the result as it is, so the JSON is the browser's by construction; the six exports that
hand the page typed arrays (`dso_list`, `dso_catalog`, `milky_way_outline`,
`extinction_table`, `magnetic_grid`, `sample_custom_bodies`) are rebuilt key for key,
with the arrays as JSON arrays. `crates/skyfix-cli/tests/parity.rs` compares every
command's JSON, to 1e-9, with the library call its export makes, computed there
independently of the adapter, and most of them with the export's own answer too. The
text is for a person: a header that says what was asked, a table, and the notes that
say what the numbers are and are not.

**The observer** is `--lat --lon [--height M]`, and `--pressure HPA --temperature C`
where an answer has an apparent (refracted) altitude in it; where an observer is
optional (the Moon's orientation, a list of objects, the transits), leaving `--lat
--lon` out answers for the Earth's centre or without local circumstances, as the export
does with `null`. **A day** is `--date` in `--zone` (as for `events`); **a window** is
`--from --to` (as for `phases`); **a year** takes `--year`, and its dates are on
`--zone` when given, else on local mean time at the observer's longitude, as the engine's
default is. Errors are the engine's sentences, and exit 1.

### Dates, years and calendars: `--calendar julian|gregorian|auto`

Every date and instant takes any year, and a leading minus needs no `=`: `--date
-0584-05-28` and `--from -0584-05-01` read as dates, not as options (so does `skyfix
almanac --date -0584-05-28`). A typed date is in the Julian calendar up to 1582-10-04 and
the Gregorian from 1582-10-15 (`auto`, the default), unless `--calendar julian` or
`--calendar gregorian` names one; the ten days between are refused without it. The JSON
is always the wire's proleptic Gregorian. `time-info` and `calendar-convert` print the
engine's own documents for an instant: its clock (UTC from 1972 to 2035, UT outside),
coverage tier, Delta-T and DUT1 with their standard uncertainties, and the date in both
calendars.

### DUT1: `--dut1 SECONDS`

On the navigation commands `--dut1` is the session's UT1 − UTC (above, "UT1 − UTC").
On the commands whose export reads the site's own DUT1 field (`set_dut1`) — `sky`,
`events`, `eclipses`, `eclipse`, `compass-error`, `limb-profile`, `time-info` — it is
that field: without it the IERS history applies, as on the site with the field empty. It
turns every Greenwich hour angle by 15.04″ a second; beyond 1 s it is refused there, as
the site refuses it.

### Packs: `--pack FILE` and `skyfix packs`

The tide commands need the `tides-us` pack, and `eclipse --limb` and `limb-profile` use
the `lunar-limb` pack. `--pack FILE`, on any command and repeatable, loads a pack for the
run as the site loads a saved one: the file's header and CRC-32 are checked and its
payload handed to its producer (`skyfix_wasm::packs::load`), so a file the site would
refuse is refused with the same sentence (exit 1). The committed copies are in
`web/public/data/packs/`; `--pack DIR/NAME` loads the one `NAME-<rev>.bin` in `DIR`, so
a script keeps working when a pack is rebuilt and its revision changes. `skyfix packs`
lists what this build can install and what is loaded. The examples below run from the
repository root with `$P` standing for `web/public/data/packs`.

```console
$ skyfix packs --pack $P/tides-us
DATA PACKS

  pack        loaded  version      bytes  provides
  tides-us    yes     2026-09-25  344543  tides:us             US tides: Tide predictions for NOAA's tide stations, mostly in the United States
  lunar-limb  no      -                -  eclipses:lunar-limb  Lunar limb: The mountains and valleys at the Moon's edge, for eclipse contact times and Baily's beads
...
```

A pack changes what the engine can answer, never how (CONVENTIONS 15.5): without it a
tide command says `pack_not_loaded: …` and how to load it, and `eclipse --limb` gives the
mean limb with a note.

## Sun tools

`skyfix_almanac::sun_tools` (CONVENTIONS 13.10; validated in `docs/ACCURACY.md` section
14), on the explorer's astronomy with DUT1 = 0, as the site's sun tools use it. Every
altitude and azimuth is the topocentric one of CONVENTIONS 13.2.

### `skyfix sun-hours --lat --lon --date [--zone] [--height]`

Golden hour (the Sun's centre between −4 and +6 degrees, geometric) and blue hour (−6 to
−4) on one local day, with the Sun's events and the sky phases.

```console
$ skyfix sun-hours --lat 39.9526 --lon -75.1652 --height 12 --date 2026-09-24 \
      --zone -04:00
GOLDEN AND BLUE HOUR
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 12 m above the WGS84 ellipsoid
Day        2026-09-24 in UTC-04:00: 2026-09-24T04:00:00Z to 2026-09-25T04:00:00Z

  light        period   from      from UTC              until           lasts
  blue hour    morning  06:23:15  2026-09-24T10:23:15Z  06:33:43  10 min 28 s
  golden hour  morning  06:33:43  2026-09-24T10:33:43Z  07:26:00  52 min 17 s
  golden hour  evening  18:18:38  2026-09-24T22:18:38Z  19:10:49  52 min 12 s
  blue hour    evening  19:10:49  2026-09-24T23:10:49Z  19:21:16  10 min 26 s
...
```

Blue hour ends exactly at civil dusk. A window cut by the day's edge runs to midnight,
and `--format json` says so (`open_start`, `open_end`) and has every crossing of the
three altitudes.

### `skyfix find-azimuth --lat --lon --body --azimuth --from --to [--min-alt] [--max-alt] [--zone]`

The instants a body stands on a bearing inside a band of apparent altitude (default:
above the horizon): "when is it at…?".

```console
$ skyfix find-azimuth --lat 39.9526 --lon -75.1652 --body Moon --azimuth 120 \
      --from 2026-09-24 --to 2026-09-27 --min-alt 5 --max-alt 60 --zone -04:00
WHEN IS IT AT 120 00.0
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Body       Moon
Window     2026-09-24T04:00:00Z to 2026-09-28T04:00:00Z, shown in UTC-04:00
Band       apparent altitude 5 to 60 degrees

  local                UTC                         Az       alt  app. alt
  2026-09-24 19:58:27  2026-09-24T23:58:27Z  120 00.0  +21 17.0  +21 19.6  rising, moving clockwise
  2026-09-25 21:06:27  2026-09-26T01:06:27Z  120 00.0  +29 58.8  +30 00.6  rising, moving clockwise
...
```

### `skyfix alignment-days --lat --lon --year --azimuth --event rise|set|at-altitude [--altitude] [--tolerance] [--body] [--zone] [--horizon dip --height-of-eye]`

The days of a year a body rises, sets, or stands at an apparent altitude along a bearing
(within `--tolerance`, default 0.5 degree): Manhattanhenge, a window, a stone row.

```console
$ skyfix alignment-days --lat 40.758 --lon -73.9855 --year 2026 --azimuth 299 \
      --tolerance 0.3 --event set --zone -04:00
ALIGNMENT DAYS 2026
Observer   40 45.48' N, 073 59.13' W (40.758000, -73.985500), 0 m above the WGS84 ellipsoid
Question   the days Sun sets within 0.3 degrees of 299 00.0 true
Clock      UTC-04:00
Searched   365 set(s) from 2026-01-01T04:00:00Z to 2027-01-01T04:00:00Z

  date        event  local     UTC                         Az  off deg       alt
  2026-05-24  set    20:14:45  2026-05-25T00:14:45Z  298 56.2    -0.06  - 0 50.0  best of its run
  2026-05-25  set    20:15:37  2026-05-26T00:15:37Z  299 11.2    +0.19  - 0 50.0
  2026-07-17  set    20:24:41  2026-07-18T00:24:41Z  299 07.7    +0.13  - 0 50.0
  2026-07-18  set    20:24:00  2026-07-19T00:24:00Z  298 52.7    -0.12  - 0 50.0  best of its run
...
```

The best day of each run is marked, and `Closest of the year` follows, matching or not,
so "never" can say by how much. `--horizon dip --height-of-eye M` lowers rise and set by
the dip, as for `events`.

### `skyfix rise-set-azimuths --lat --lon --year [--body] [--zone] [--horizon]`

A body's rise and set bearings and its transit on every day of a year.

```console
$ skyfix rise-set-azimuths --lat 39.9526 --lon -75.1652 --year 2026 --zone -05:00
RISE AND SET BEARINGS SUN 2026
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Clock      UTC-05:00

  date        rise            Az  transit        alt  set             Az
  2026-01-01  07:22:25  119 48.4  12:04:19  +27 05.2  16:46:22  240 14.4
...
  2026-06-21  04:32:11   57 55.3  12:02:31  +73 29.1  19:32:51  302 04.6
...
  2026-12-21  07:18:51  120 26.9  11:58:50  +26 36.5  16:38:48  239 33.1
...
```

### `skyfix analemma --lat --lon --year [--time HH:MM] [--zone]`

The Sun at one clock time every day of a year, local mean time by default or a fixed
`--zone`: its altitude and azimuth, and the analemma's own axes, the declination and the
equation of time.

```console
$ skyfix analemma --lat 39.9526 --lon -75.1652 --year 2026
ANALEMMA 2026
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Time       12:00:00 every day on local mean time at the longitude (UTC-05:00:40)

  date        UTC                        alt  app. alt        Az        Dec       EoT
  2026-01-01  2026-01-01T17:00:40Z  +27 04.9  +27 06.8  179 03.2  S 22 57.5   -3m 40s
  2026-01-02  2026-01-02T17:00:40Z  +27 10.2  +27 12.1  178 55.9  S 22 52.1   -4m 08s
...
  2026-06-21  2026-06-21T17:00:40Z  +73 28.8  +73 29.1  178 29.8  N 23 26.2   -1m 52s
...
```

### `skyfix sun-path --lat --lon --date [--zone] [--step MIN]`

The Sun's path across one day, and the envelope: the same local day moved to the
year's equinoxes and solstices.

```console
$ skyfix sun-path --lat 39.9526 --lon -75.1652 --date 2026-12-21 --zone -05:00 \
      --step 60
SUN PATH
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Day        2026-12-21 in UTC-05:00, every 60 min

  local     UTC                        alt  app. alt        Az
  08:00:00  2026-12-21T13:00:00Z  + 5 42.8  + 5 51.5  127 14.9
...
  12:00:00  2026-12-21T17:00:00Z  +26 36.4  +26 38.4  180 18.0
...
The year's envelope: the same local day moved to the equinoxes and solstices
  day                date         highest  Az at rise  Az at set
  March equinox      2026-03-20  +50 02.4     98 27.1   278 33.5
  June solstice      2026-06-21  +73 28.5     62 19.3   306 35.3
  September equinox  2026-09-22  +50 07.9     90 53.8   271 06.1
  December solstice  2026-12-21  +26 36.4    127 14.9   242 51.9
...
```

### `skyfix equation-of-time --year [--hour H]`

Apparent minus mean solar time and the Sun's declination on every UTC date of a year,
at `--hour` (the almanac page's 12 by default), with the year's extremes.

```console
$ skyfix equation-of-time --year 2026
EQUATION OF TIME 2026
Time       12.00 h UT each date; the same for every observer

Extremes
  date                                                           EoT
  2026-02-11  least: the sundial furthest behind the clock  -14m 10s
  2026-05-13  greatest: the sundial furthest ahead           +3m 40s
  2026-07-26  least: the sundial furthest behind the clock   -6m 34s
  2026-11-03  greatest: the sundial furthest ahead          +16m 27s
...
```

### `skyfix solar-day` and `skyfix solar-year --lat --lon [--tilt] [--panel-azimuth] [--albedo]`

A **clear-sky estimate** of the sunlight on a panel: through one day (`solar-day --date
[--zone] [--step]`), or by month through a year with the tilt that collects the most
(`solar-year --year [--zone] [--optimise-tilt]`). The panel faces the equator unless
`--panel-azimuth` says otherwise. Every report prints the model's own words: an upper
bound, no clouds, no haze.

```console
$ skyfix solar-day --lat 39.9526 --lon -75.1652 --date 2026-09-24 --zone -04:00 \
      --tilt 30 --step 60
CLEAR-SKY SOLAR ESTIMATE, ONE DAY
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Day        2026-09-24 in UTC-04:00
Panel      tilt 30 deg, facing 180 deg true, albedo 0.2
Energy     7.028 kWh/m2 on the panel (peak 972.9 W/m2), 5.664 on the ground (GHI) and
           8.143 toward the Sun (DNI)

  local     UTC                   Sun app. alt        Az    GHI    DNI    DHI  panel  incidence
  07:00:00  2026-09-24T11:00:00Z      + 1 23.6   91 36.4    2.6   16.0    2.2    2.6       88.0
...
  13:00:00  2026-09-24T17:00:00Z      +49 21.7  182 50.2  772.9  879.8  105.3  972.9       10.8
...
```

```console
$ skyfix solar-year --lat 39.9526 --lon -75.1652 --year 2026 --tilt 30 \
      --optimise-tilt --zone -05:00
CLEAR-SKY SOLAR ESTIMATE 2026
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84 ellipsoid
Panel      tilt 30 deg, facing 180 deg true, albedo 0.2
Clock      UTC-05:00, every 10 min
Energy     2448.2 kWh/m2 on the panel in the year, 2098.8 on the ground (GHI)
Best tilt  34.7 deg facing 180 deg: 2454.9 kWh/m2

  month      days  panel kWh/m2  GHI kWh/m2  panel a day
  January      31         146.5        88.1         4.73
...
  June         30         245.9       263.5         8.20
...
```

### `skyfix galactic-centre --lat --lon --from --to [--min-alt] [--sun-max-alt] [--zone]`

The Milky Way planner: the stretches of each night with the galactic centre at least
`--min-alt` up (apparent, default 10 degrees) and the Sun at most `--sun-max-alt`
(geometric, default −18), split where the Moon rises or sets.

```console
$ skyfix galactic-centre --lat -31.2733 --lon 149.0617 --height 1165 \
      --from 2026-06-15 --to 2026-06-16 --zone +10:00
THE GALACTIC CENTRE IN A DARK SKY
Observer   31 16.40' S, 149 03.70' E (-31.273300, 149.061700), 1165 m above the WGS84 ellipsoid
Window     2026-06-14T14:00:00Z to 2026-06-16T14:00:00Z, shown in UTC+10:00
Rule       the centre at least 10 deg up (apparent), the Sun at most -18 deg (geometric)

  from                 from UTC              hours  Moon     best           alt        Az  arch top Az
  2026-06-15 00:00:00  2026-06-14T14:00:00Z   5.56  down 0%  00:19:33  +87 44.8    0 00.1     301 12.3
  2026-06-15 18:34:33  2026-06-15T08:34:33Z  10.99  down 0%  00:15:37  +87 44.8    0 00.0     301 12.3
  2026-06-16 18:34:41  2026-06-16T08:34:41Z   5.42  down 3%  00:00:00  +86 36.6   49 04.3     122 43.3

...
```

## Magnetic variation and compass error

`skyfix_geomag` (WMM2025 from 2025.0 to 2030.0, IGRF-14 from 1900.0) and
`skyfix_core::methods::compass` (CONVENTIONS 14.1-14.2; `docs/NAVIGATION_METHODS.md`
section 9).

### `skyfix variation --lat --lon --utc [--height] [--model auto|wmm2025|igrf14]`

The Earth's field at a place and instant: the declination (the navigator's variation,
east positive), the inclination and the intensities, each with its rate of change and
its standard uncertainty.

```console
$ skyfix variation --lat 39.9526 --lon -75.1652 --height 12 \
      --utc 2026-09-24T12:00:00Z
MAGNETIC VARIATION
Place      39 57.16' N, 075 09.91' W (39.952600, -75.165200), 12 m above the WGS84 ellipsoid
Time       2026-09-24T12:00:00Z
Model      WMM2025, decimal year 2026.7301, a forecast (after 2025.0)

Variation 11.8° W ±0.4° (WMM2025), changing 1.6′ E a year.

  element                         value      sigma  change a year
  declination (variation)  -11.8053 deg  0.364 deg    +0.0267 deg
  inclination (dip)         65.1704 deg  0.200 deg    -0.1039 deg
  horizontal H               21219.2 nT     133 nT       +36.0 nT
  north X                    20770.4 nT     137 nT       +37.3 nT
  east Y                     -4341.2 nT      89 nT        +2.3 nT
  down Z                     45860.4 nT     141 nT      -140.4 nT
  total F                    50531.5 nT     138 nT      -112.3 nT
...
Zone       normal
...
```

A date no model covers is an answer, not an error: before 1900 or after 2030 the report
(and the JSON, `available: false`) says why, and the exit code is 0.

### `skyfix magnetic-grid --utc --lat-range MIN,MAX --lon-range MIN,MAX --rows N --cols M [--height]`

Declination and horizontal intensity on a grid, for isogonic lines; the JSON is the
export's object with its arrays, row by row from the southern edge, or `null` when no
model covers the date.

```console
$ skyfix magnetic-grid --utc 2026-09-24T12:00:00Z --lat-range 30,40 \
      --lon-range -80,-70 --rows 2 --cols 2
MAGNETIC GRID
Time       2026-09-24T12:00:00Z (decimal year 2026.7301), WMM2025
Grid       2 rows x 2 columns, 0 m above the ellipsoid

      lat       lon  declination   H nT  zone
  30.0000  -80.0000       -7.956  24249
  30.0000  -70.0000      -12.790  25081
  40.0000  -80.0000       -9.162  20722
  40.0000  -70.0000      -13.888  21808
...
```

### `skyfix compass-error --lat --lon --utc --body --bearing [--method azimuth|amplitude] [--compass magnetic|gyro] [--variation DEG [--variation-sigma]] [--bearing-sigma]`

Compass error from a body's true bearing: by its azimuth at the instant, or by its
amplitude as it rises or sets (`--method amplitude`, with `--horizon visible|celestial`,
`--height-of-eye`, `--limb`, `--event rising|setting`, `--pressure`, `--temperature`).
A magnetic compass's error splits into the variation (the model's unless `--variation`
gives the chart's) and the deviation.

```console
$ skyfix compass-error --lat 39.9526 --lon -75.1652 --height 12 \
      --utc 2026-09-24T21:40:00Z --body Sun --bearing 272
COMPASS ERROR BY AZIMUTH
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 12 m above the WGS84 ellipsoid
Time       2026-09-24T21:40:00Z

Compass error 14.4° W; variation 11.8° W; deviation 2.6° W.
The Sun bore 257.6° true at 21:40:00 UTC, 13.3° high; the compass read 272.0°.

                       deg  sigma
  true bearing     257.552      -  from skyfix-auto (Sun, Moon, planets, stars)
  compass bearing  272.000      -  as read
  compass error    -14.448      -  14.4° W
  variation        -11.805  0.364  11.8° W (WMM2025)
  deviation         -2.642  0.364  2.6° W
...
```

## Passage planning and sight extras

`skyfix_core::sailings`, `methods::starid` and `methods::starfinder`
(`docs/NAVIGATION_METHODS.md` sections 9-11). Positions are `LAT,LON` in degrees.

### `skyfix sailing --from --to [--every-nm N | --every-deg-lon M] [--limiting-lat] [--meridional-parts sphere|wgs84] [--speed KN [--departure]]`

Every sailing between two points: the great circle with its vertex and waypoints, the
rhumb line, mid-latitude sailing, and composite sailing below a limiting parallel; with a
speed the hours under way, and with a departure time the ETAs.

```console
$ skyfix sailing --from 36.9617,-75.7033 --to 45.6517,-1.4967 --every-deg-lon 10 \
      --limiting-lat 47 --speed 12 --departure 2026-10-01T12:00:00Z
SAILINGS
From       36 57.70' N, 075 42.20' W (36.961700, -75.703300)
To         45 39.10' N, 001 29.80' W (45.651700, -1.496700)
Speed      12 kn, departing 2026-10-01T12:00:00.000Z

  sailing                                      course      NM      km  under way
  great circle              55.8 initial, 109.0 final  3264.5  6045.9  272.2 h, arriving 2026-10-12T20:12:22Z
  rhumb line (sphere)                            81.1  3376.9  6254.0  281.4 h, arriving 2026-10-13T05:24:31Z
  mid-latitude                                   81.1  3385.0       -  282.1 h, arriving 2026-10-13T06:04:54Z
  composite (limit 47 deg)                     3 legs  3271.3  6058.4  272.7 h, arriving 2026-10-12T20:44:22Z

Saving     the great circle is 112.4 NM shorter than the rhumb line
Vertex     48 37.78' N, 027 12.70' W (48.629720, -27.211739), 2205.2 NM from the
...
```

The waypoints of each track follow, with the rhumb line to steer to the next.

### `skyfix dr-advance --from --course --speed --hours [--method rhumb|mid-latitude|great-circle] [--start]`

Forward (or, with negative hours, backward) dead reckoning.

```console
$ skyfix dr-advance --from 44.605,-31.305 --course 270 --speed 17 --hours 4.5 \
      --start 2026-10-01T15:30:00Z
DEAD RECKONING
From       44 36.30' N, 031 18.30' W (44.605000, -31.305000)
Run        course 270 at 17 kn for 4.5 h: 76.50 NM, rhumb sailing (sphere meridional parts)
DR         44 36.30' N, 033 05.75' W (44.605000, -33.095819)
Heading    270 on arrival
Time       2026-10-01T20:00:00Z
```

### `skyfix route-positions --start --start-utc --leg [START,]COURSE,SPEED ... [--end-utc] [--at T ...] [--step MIN]`

Positions along a route of legs, in the running fix's leg shape (`--leg` as for
`running-fix`), at given instants and every `--step` minutes.

```console
$ skyfix route-positions --start 40,-70 --start-utc 2026-10-01T00:00:00Z --leg 90,10 \
      --leg 2026-10-01T03:00:00Z,0,10 --end-utc 2026-10-01T06:00:00Z \
      --at 2026-10-01T02:00:00Z --at 2026-10-01T07:00:00Z
ROUTE
Method     rhumb sailing (sphere meridional parts)

Legs
  #  from UTC              to UTC                course  kn    NM  ends at
  0  2026-10-01T00:00:00Z  2026-10-01T03:00:00Z     090  10  30.0  40 00.00' N, 069 20.84' W
  1  2026-10-01T03:00:00Z  2026-10-01T06:00:00Z     000  10  30.0  40 30.00' N, 069 20.84' W

Positions
  UTC                   lat          lon           leg  run NM
  2026-10-01T02:00:00Z  40 00.00' N  069 33.89' W    0   20.00  under way
  2026-10-01T07:00:00Z  40 30.00' N  069 20.84' W    -   60.00  after the end
...
Made good  42.35 NM in 7.00 h, course 44.9, 6.05 kn
...
```

### `skyfix star-id --lat --lon --utc --altitude --bearing [--altitude-kind] [--bearing-kind true|magnetic|compass] [--variation] [--deviation]`

Which body was shot, from its altitude and bearing: the reading is corrected as a sight
is (the sight optics below), and every star, planet and the Moon within the tolerances
(2 degrees of altitude, 5 of bearing by default) is ranked.

```console
$ skyfix star-id --lat 39.95 --lon -75.17 --height-of-eye 2.5 --ic -1.2 \
      --utc 2026-10-01T00:30:00Z --altitude 72.59 --bearing 286 \
      --bearing-kind compass --variation -12.5 --deviation 0
WHAT DID I SHOOT?
DR         39 57.00' N, 075 10.20' W (39.950000, -75.170000)
Time       2026-10-01T00:30:00Z
Observed   altitude +72 31.1 (after the corrections, airless topocentric), true bearing
           273 30.0
Sky        night, the Sun at -20 54.7: stars to magnitude 4.5 are visible

Vega (1.2′ away: the sight is 0.1′ higher and its bearing 4.0′ less).
...
  #  body     kind   mag       alt        Az  d alt '  d brg '  within
  1  Vega     star  0.03  +72 31.0  273 34.0     +0.1     -4.0  yes
...
```

**The sight optics** of `predict`, `plan-sights` and `star-id` are `--height-of-eye`,
`--ic`, `--horizon`, `--pressure` and `--temperature`, and two more from the programme:
`--shore NM`, the waterline of a shore that near, nearer than the sea horizon (the dip
short of the horizon, Bowditch Table 14), and `--ic-log UTC,ARCMIN`, repeated, an
index-error log: the index correction at the sight's time is then interpolated from it,
as a session's `instrument.index_error_log` is (CONVENTIONS section 10). `skyfix reduce`
prints which value a log gave each sight.

### `skyfix star-finder --lat [--utc]`

A rotating star finder (2102-D) for a latitude: the template of its 10-degree band, and
the stars' places on the base (J2000.0, or the apparent places of `--utc`). The JSON has
both sides of the base, the Aries index and the template's lines for drawing.

```console
$ skyfix star-finder --lat 39.95
STAR FINDER
Template   for 35 deg N (latitude 39.95 asked), the north side of the base; stars at
           their J2000.0 catalogue place
Setting    turn the template anticlockwise by LHA Aries degrees about the centre and
           read each star's altitude and azimuth off its grid

  star                  SHA        Dec    mag        x        y
  Acamar           315 26.1  S 40 18.3   2.88  +0.5158  +0.5080
  Achernar         335 34.3  S 57 14.2   0.45  +0.7448  +0.3383
...
```

## Time scales

`skyfix_core::{time, deltat, calendar}` (CONVENTIONS 15.2-15.3). `skyfix calendar` (above)
prints both documents for a person in one report; these print each export's own.

### `skyfix time-info <DATE> | --jd JD [--dut1]`

```console
$ skyfix time-info -0584-05-28T12:00:00Z
TIME
Instant      -0584-05-28T12:00:00 UT (Julian) (JD 1507900.000000 on the app's clock)
Wire         -0584-05-22T12:00:00.000Z (proleptic Gregorian, as JSON carries it)
Clock        UT, Universal Time (UT1): outside the UTC years 1972-2035
Tier         labelled
Delta-T      18213.2 s (5 h 03 min 33 s), standard uncertainty 3 min: Stephenson,
             Morrison & Hohenkerk 2016, 2020 revision (TT - UT1)
TT - clock   18213.2 s (5 h 03 min 33 s)
UT1 - UTC    none: the clock is UT1
Calendar     Julian (the calendar the explorer shows for this date)
Date         -0584-05-28  28 May 585 BC, astronomical year -0584  12:00:00.000
Julian       -0584-05-28  28 May 585 BC, astronomical year -0584  12:00:00.000
...
```

### `skyfix calendar-convert <DATE> | --jd JD`

The date as typed goes to the engine as the site's date entry sends it, a civil date in
its calendar; `--jd` sends the Julian date.

```console
$ skyfix calendar-convert 1752-09-03 --calendar julian
CALENDAR CONVERSION
Julian date  2361221.500000  (MJD -38779.000000)
Gregorian    1752-09-14  14 September 1752  00:00:00.000
Julian       1752-09-03  3 September 1752  00:00:00.000
```

## Deep time

Since the deep-time work the core covers 2000 BC to AD 3000 in two tiers (CONVENTIONS
15.1; `docs/ACCURACY.md`, "Historical accuracy"; the first day is -2000-01-01 in the
astronomical years the CLI prints, 1 January 2001 BC): the **validated** tier, 1550-01-01
to 2650-01-22, where the accuracy figures hold and bodies are offered for sights; and the
**labelled** tier around it, display only, measured per century against JPL DE441, every
time in it carrying Delta-T's uncertainty. As on the site, the display commands (`sky`,
`events`, `phases`, `seasons` and the sun tools) answer both tiers. Everything that feeds
a sight, a fix or a plan keeps the validated tier and refuses the rest, and so do the
other engines, some over a narrower span of their own: the eclipse and planet-event
searches 1990 to 2060, the years they were checked over against NASA's canon and
Skyfield; the tide predictions 1900 to 2100; and the magnetic models 1900 to 2030,
outside which `variation` says there is no variation to give. A report whose times fall
in the labelled tier says so under its table, with Delta-T's standard uncertainty there.
`skyfix coverage` remains the sight providers' own coverage.

### `skyfix explorer-coverage`

The explorer's coverage, per provider group and tier, with the worst error measured over
each (the export `explorer_coverage`).

```console
$ skyfix explorer-coverage
THE EXPLORER'S COVERAGE
Display    -2000-01-01T00:00:00Z to 3000-12-31T23:59:59Z: the sky, the day's events, the
           Moon's phases, the seasons and the sun tools answer both tiers
Validated  1550-01-01T00:00:00Z to 2650-01-22T00:00:00Z: sights, predicted readings, the
           planner and the other engines answer this tier only
Packs      none loaded (no pack is needed for either tier)

  group    tier       from                   to                    worst '  sights
  Sun      validated  1550-01-01T00:00:00Z   2650-01-22T00:00:00Z     0.01  offered
           labelled   -2000-01-01T00:00:00Z  3000-12-31T23:59:59Z     0.02  no
  Moon     validated  1550-01-01T00:00:00Z   2650-01-22T00:00:00Z     0.02  offered
           labelled   -2000-01-01T00:00:00Z  3000-12-31T23:59:59Z     0.05  no
...
```

### `skyfix tier-at <DATE> | --jd JD`

The tier of an instant (the export `tier_at`): `validated`, `labelled` or `outside`; its
JSON is the name alone. The tiers' bounds are proleptic Gregorian dates, as JSON writes
them, while a date is typed and shown in the Julian calendar before 1582-10-15 (above,
"Dates, years and calendars"): so an instant shown as Julian is given in the Gregorian
calendar too, and `skyfix tier-at 1549-12-25` is validated, being 1550-01-04 there.

```console
$ skyfix tier-at -0584-05-28T12:00:00Z
COVERAGE TIER
Instant    -0584-05-28T12:00:00 UT (Julian)
Gregorian  -0584-05-22T12:00:00Z (proleptic, as are the bounds below)
Tier       labelled: a historical or far-future estimate (-2000-01-01T00:00:00Z to
           3000-12-31T23:59:59Z): positions for display, each time with its Delta-T
           uncertainty (skyfix time-info); no sights, predicted readings or plans
```

The seasons of 585 BC, in the labelled tier, on the UT clock and in the Julian calendar:

```console
$ skyfix seasons --year -584
SEASONS -584
  -0584-03-27T04:49:57 UT (Julian)  March equinox
  -0584-06-29T08:31:08 UT (Julian)  June solstice
  -0584-09-29T08:00:36 UT (Julian)  September equinox
  -0584-12-26T20:19:21 UT (Julian)  December solstice
...
A historical or far-future estimate (the labelled tier, CONVENTIONS 15.1): every time
...
```

---

## The Moon in detail

`skyfix_almanac::{libration, lunar_features, apsides, occultations}` (CONVENTIONS 13.10;
`docs/ACCURACY.md` section 14). Selenographic longitudes are east positive, toward Mare
Crisium.

### `skyfix moon-orientation [--lat --lon [--height]] --utc`

How the Moon is turned and lit: libration (and its optical, physical and diurnal parts),
the sub-solar point, colongitude and terminator, the axis's position angle, distance and
apparent size. Without an observer, for the Earth's centre.

```console
$ skyfix moon-orientation --lat 39.9526 --lon -75.1652 --height 10 \
      --utc 2026-09-25T02:24:00Z
THE MOON'S ORIENTATION
Seen from  39 57.16' N, 075 09.91' W (39.952600, -75.165200), 10 m above the WGS84
           ellipsoid
Time       2026-09-25T02:24:00Z

Libration  longitude -5.096 deg, latitude -0.785 deg (optical -5.087, -1.531; physical
           +0.016, +0.050; diurnal -0.024, +0.717): the point at the disc's centre
Phase      97.1% lit, waxing, phase angle 19.69 deg; colongitude 75.39 deg (the morning
           terminator at selenographic longitude -75.39, the evening one at +104.61)
Sun over   selenographic latitude -0.840, longitude +14.614 (the sub-solar point)
Axis       the Moon's north pole at position angle 339.08 deg (north through east;
           339.10 from the Earth's centre); the bright limb at 250.81 deg
Size       382095 km away, 31.28' across (+0.6% against its size at the mean distance);
           from the Earth's centre 386267 km
In the sky altitude +40 23.3 (geometric), azimuth 155 12.9, parallactic angle -18.87 deg
...
```

### `skyfix moon-features [--lat --lon] --utc [--all]`

The 150 named features at an instant: which are lit, and which are near the terminator
tonight, where the relief shows.

```console
$ skyfix moon-features --lat 39.9526 --lon -75.1652 --utc 2026-09-20T01:00:00Z
THE MOON'S NAMED FEATURES
Seen from  39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84
           ellipsoid
Time       2026-09-20T01:00:00Z
Phase      61.2% lit, waxing, colongitude 13.78 deg
...
Tonight    Oceanus Procellarum, Mare Imbrium, Clavius, Plato, Tycho, Rupes Recta, Montes
...
  feature              kind     rank    lat    lon    km  Sun alt
  Oceanus Procellarum  oceanus     1  +20.7  -56.7  2592    -39.9  dark, morning, near the terminator
  Mare Imbrium         mare        1  +34.7  -14.9  1146     -1.3  dark, morning, near the terminator
...
```

### `skyfix moon-apsides --from --to [--zone]`

Perigees and apogees, and the new and full Moons with supermoons and micromoons.

```console
$ skyfix moon-apsides --from 2026-01-01 --to 2026-03-31
PERIGEE, APOGEE AND SUPERMOONS  2026-01-01T00:00:00Z to 2026-04-01T00:00:00Z

Perigees and apogees
  UTC                                km  diameter '  vs mean
  2026-01-01T21:44:26Z  perigee  360348       33.16    +6.7%
  2026-01-13T20:47:08Z  apogee   405438       29.47    -5.2%
  2026-01-29T21:46:00Z  perigee  365871       32.66    +5.1%
...
New and full Moons
  UTC                                  km  diameter '  to perigee
  2026-01-03T10:02:55Z  full moon  362312       32.98         96%  supermoon
...
```

### `skyfix occultations --lat --lon --from --to [--max-magnitude] [--no-stars] [--no-planets] [--below-horizon] [--no-near-misses] [--body NAME ...] [--zone]`

Lunar occultations of the 58 navigational stars, the catalogue's stars brighter than
`--max-magnitude` (3.5) and the planets, seen from one place, with each contact's
position angle on the limb; at the Moon's mean limb, as the note says.

```console
$ skyfix occultations --lat 39.9526 --lon -75.1652 --from 2026-01-01 --to 2026-06-30 \
      --zone -05:00
LUNAR OCCULTATIONS
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84
           ellipsoid
Window     2026-01-01T05:00:00Z to 2026-07-01T05:00:00Z, shown in UTC-05:00
Searched   36 bodies near the Moon's path (stars within 7 deg of the ecliptic)

  body       mag  disappears           disappears UTC        PA, limb    reappears  PA, limb
  τ Sgr     3.32  2026-01-17 13:03:25  2026-01-17T18:03:25Z  120 bright  13:54:10   198 dark    day
  Regulus   1.36  2026-02-02 20:53:17  2026-02-03T01:53:17Z  149 bright  21:51:06   266 dark    night
  τ Sgr     3.32  2026-03-13 03:52:47  2026-03-13T08:52:47Z   94 bright  05:11:32   259 dark    night
  Fang      2.89  -                    -                     -           -          -           near miss, 0.87' outside the limb, graze
  Regulus   1.36  2026-04-25 19:52:53  2026-04-26T00:52:53Z   54 dark    20:14:47    23 dark    graze, nautical twilight
  Venus    -4.01  2026-06-17 14:51:31  2026-06-17T19:51:31Z  101 dark    16:11:16   320 bright  day
  Fang      2.89  -                    -                     -           -          -           near miss, 0.54' outside the limb, graze
...
```

## Deep sky

`skyfix_starfield::{dso, showers, milkyway, search, tonight, extinction}`: display only
(CONVENTIONS 13.6). Rankings, meteor rates, limiting magnitudes and the instrument guide
are estimates from stated rules, and the reports say so. The observer's sky is
`--bortle N` (1 to 9, default 5) or `--nelm MAG`, and `--extinction K`.

### `skyfix dso-catalog`

The 213 objects: Messier's 110 and 103 others by a stated rule.

```console
$ skyfix dso-catalog
DEEP-SKY OBJECTS: 213

  id        name                         type                 con  RA J2000  Dec J2000   mag       size '
  M1        Crab Nebula                  supernova remnant    Tau   83.6331   +22.0145   8.4        7 x 5
...
  M31       Andromeda Galaxy             spiral galaxy        And   10.6847   +41.2687   3.4     200 x 71
...
  M45       Pleiades                     open cluster         Tau   56.7500   +24.1167   1.6    110 x 110
...
```

### `skyfix dso-list [--lat --lon] --utc [--kind KINDS] [--max-magnitude] [--above-horizon]`

Every object's place at an instant (RA and Dec of date; with an observer, altitude and
azimuth), filtered.

```console
$ skyfix dso-list --lat 39.9526 --lon -75.1652 --utc 2026-09-25T02:00:00Z \
      --kind galaxy --max-magnitude 7 --above-horizon
DEEP-SKY OBJECTS AT AN INSTANT
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84
           ellipsoid
Time       2026-09-25T02:00:00Z

  id   name               mag        RA       Dec  app. alt        Az
  M31  Andromeda Galaxy   3.4   11.0591  +41.4175  +50 56.0   70 16.8
  M33  Triangulum Galaxy  5.7   23.8469  +30.7993  +37 19.6   78 22.6
  M81  Bode's Galaxy      6.9  149.4261  +68.9360  +19 13.5  355 57.4

...
```

### `skyfix dso <ID> --lat --lon --utc [--bortle | --nelm] [--zone]`

One object through the night the instant belongs to (local mean noon to noon): when it is
best placed, how long it is high, the Moon's light on it, and what shows it.

```console
$ skyfix dso M31 --lat 39.9526 --lon -75.1652 --utc 2026-09-24T22:00:00Z \
      --zone -04:00 --bortle 4
M31, Andromeda Galaxy
Object     spiral galaxy in And, magnitude 3.4, 200' x 71'; RA 10.6847, Dec +41.2687
...
Best       01:28 at +88 32.1, 0 00.0 N (highest in the dark window)
Transit    01:28 at +88 32.1, 0 00.0 N
High       8 h 56 min above 20 deg in the dark window
Moonlight  the Moon 52.3 deg away at altitude +38 08.9, brightening the sky there by
...
Limit      stars to magnitude 4.5 at the object at its best
See it     with binoculars (10x50) (a rule of thumb)
...
```

### `skyfix showers --year [--lat --lon] [--bortle | --nelm] [--zone]`

The year's meteor showers from this project's table, their dates from our Sun, and with
an observer the expected rate on the night nearest each peak.

```console
$ skyfix showers --year 2026 --lat 39.9526 --lon -75.1652 --zone -04:00
METEOR SHOWERS 2026
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84
           ellipsoid

  shower                      code  peak                 ZHR  active                    Moon  rate/h here  best
...
  Perseids                    PER   2026-08-12 22:08     100  2026-07-16 to 2026-08-24    0%         48.4  04:27 at +61 14.7, 39 06.2 NE
...
  Geminids                    GEM   2026-12-14 09:49     150  2026-12-03 to 2026-12-21   25%         66.0  02:59 at +83 02.6, 183 46.8 S
...
```

### `skyfix milky-way`

The Milky Way's outline for drawing: closed rings at four brightness levels; the JSON
has every point.

```console
$ skyfix milky-way
THE MILKY WAY'S OUTLINE

  level  threshold MJy/sr  rings  points
      0              0.32      4     328
      1              0.50     10     363
      2              0.80      8     155
      3              1.30      2      34

...
```

### `skyfix search <QUERY> [--lat --lon] [--utc] [--limit N]`

Find a star, object, constellation, planet or shower by name, Bayer or Flamsteed
designation or catalogue number, best first.

```console
$ skyfix search andromeda --lat 39.9526 --lon -75.1652 --utc 2026-09-25T02:00:00Z \
      --limit 3
SEARCH "andromeda"
Time       2026-09-25T02:00:00Z

  kind           label             detail                                                                                  score       RA      Dec  app. alt        Az
  constellation  Andromeda         Constellation · And · genitive Andromedae                                                 100   8.2096  39.1548  +52 22.2   74 46.5
  deep sky       Andromeda Galaxy  M31 · NGC 224 · The nearest large galaxy, 2.5 million light-years away · magnitude 3.4     80  11.0591  41.4175  +50 56.0   70 16.8
  star           Alpheratz         α And · HR 15 · HIP 677 · magnitude 2.1                                                    59   2.4509  29.2411  +52 52.8   92 54.4
...
```

### `skyfix tonight --lat --lon --utc [--bortle | --nelm] [--limit N] [--zone]`

What a night offers: its darkness, the Moon, the planets, the best-placed deep-sky
objects, meteor showers and the Milky Way's core. The engine's summary writes its times
as tokens; the text writes them in `--zone`.

```console
$ skyfix tonight --lat 39.9526 --lon -75.1652 --height 12 --utc 2026-09-24T22:00:00Z \
      --zone -04:00 --limit 6
TONIGHT
...
Darkness   night (the Sun below -18 deg) from 20:24 to 05:20, 8 h 56 min
...
Moon       full, 97% lit, rises 17:54, sets 05:36; up 8 h 56 min of the dark window,
...
Dark from 20:24 to 05:20 (8.9 hours). The Moon is full, 97% lit, and up all through the
...
Planets
  planet    mag  best                             up
...
  Saturn    0.4  01:31 at +52 19.2, 179 20.0 S    20:21 to 06:21  Saturn, magnitude 0.4, in the south (52° at best)
...
Deep sky, best first
  object                       type          mag  best                             h > 20  with        score
  Mel 25 Hyades                open cluster  0.5  05:12 at +65 59.0, 180 00.0 S       5.3  eye          68.9
...
```

### `skyfix extinction [--bortle | --nelm] [--extinction K]`

Air mass, extinction and the limiting magnitude by altitude.

```console
$ skyfix extinction --bortle 3
EXTINCTION AND THE LIMITING MAGNITUDE
Sky        naked-eye limit 6.8 at the zenith (Bortle 3), extinction k = 0.25 mag per air
           mass, sky 22.00 mag/arcsec2 (from --bortle)

  app. alt  air mass  extinction mag  limiting mag
         0     38.75            9.69         -2.64
         1     26.64            6.66          0.39
...
        20      2.90            0.73          6.32
...
        45      1.41            0.35          6.70
...
        90      1.00            0.25          6.80
...
```

## Planets in detail

`skyfix_almanac::{satellites, rings, discs, transits, conjunctions, earth_apsides,
orbits}` (CONVENTIONS 13.12; `docs/ACCURACY.md` section 17).

### `skyfix galilean-moons --utc` and `skyfix galilean-events --from --to [--zone]`

Jupiter's four moons as the Earth sees them, and their transits, shadow transits,
occultations and eclipses.

```console
$ skyfix galilean-moons --utc 2026-01-10T00:00:00Z
JUPITER'S GALILEAN MOONS
Time       2026-01-10T00:00:00Z
Jupiter    4.2318 au away (light 2112 s), disc 46.59" x 43.57", pole at PA 10.00 deg,
           179.5 deg from the Sun

  moon        x Rj    y Rj  east "  north "
  Io        +5.492  -0.056  -126.2    +20.9  in front
  Europa    +0.157  +0.166    -2.9     +4.4  behind, hidden behind Jupiter, in Jupiter's shadow
  Ganymede  +8.956  +0.324  -204.1    +43.6  behind
  Callisto  -3.740  -0.522   +83.7    -27.1  in front
...
```

```console
$ skyfix galilean-events --from 2026-01-10 --to 2026-01-10
JUPITER'S MOONS: TRANSITS, SHADOWS, OCCULTATIONS, ECLIPSES
Window     2026-01-10T00:00:00Z to 2026-01-11T00:00:00Z

  moon      event           UTC                   ends      seen   from Sun
  Europa    eclipse         2026-01-09T22:47:10Z  01:37:50  start       179
  Europa    occultation     2026-01-09T22:48:18Z  01:38:55  end         179
  Callisto  transit         2026-01-10T07:01:36Z  10:57:17  both        180
...
```

### `skyfix saturn-rings --utc`

```console
$ skyfix saturn-rings --utc 2026-09-24T00:00:00Z
SATURN'S RINGS
Time       2026-09-24T00:00:00Z
Tilt       B = -7.8127 deg (the Earth's latitude on Saturn over the ring plane: the
           south face is seen), B' = -7.5468 deg (the Sun's), dU = 1.1928 deg; the lit
           face is toward us
Rings      44.630" x 6.067" (outer edge of ring A), the northern semi-minor axis at PA
           3.16 deg
Saturn     8.4514 au away (9.4368 au from the Sun), magnitude 0.38 (Mallama & Hilton
           2018; 0.35 by the 1984 formula)
...
```

### `skyfix planet-disc --body --utc`

Any planet's disc: its size, phase, pole, the points under the Earth and the Sun, and the
central meridians (Jupiter's Systems I, II and III).

```console
$ skyfix planet-disc --body Jupiter --utc 2026-01-10T00:00:00Z
JUPITER'S DISC
Time       2026-01-10T00:00:00Z
Size       46.587" x 43.567" (equatorial x polar, as seen), 4.231756 au away (light
           2111.7 s)
Phase      100.00% lit, phase angle 0.091 deg, defect 0.000", bright limb at PA 66.62
           deg
Pole       north pole at PA 9.995 deg
Earth over latitude +1.389 (planetographic +1.589), longitude 252.753 (west positive)
Sun over   latitude +1.441 (planetographic +1.647), longitude 252.830
Central    meridian: System I 193.230, System II 2.646, System III 252.753
Magnitude  -2.68

The Great Red Spot is not tracked: its System II longitude drifts by tens of degrees a
...
```

### `skyfix transits --from --to [--lat --lon [--height]] [--zone]`

Transits of Mercury and Venus: the contacts from the Earth's centre, and with an observer
what that place sees.

```console
$ skyfix transits --from 2012-06-05 --to 2012-06-07 --lat 39.9526 --lon -75.1652 \
      --height 12
TRANSITS OF MERCURY AND VENUS
Window     2012-06-05T00:00:00Z to 2012-06-08T00:00:00Z
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 12 m above the WGS84
           ellipsoid

2012-06-06-venus  Venus: least separation 554.3" (the Sun's radius 945.7"), 6 h 39 min 51 s
  from the Earth's centre
  contact   UTC                      PA  sep "
  c1        2012-06-05T22:09:42Z   40.7  974.6
  c2        2012-06-05T22:27:30Z   38.2  916.8
  greatest  2012-06-06T01:29:37Z  345.4  554.3
  c3        2012-06-06T04:31:44Z  292.7  916.8
...
  from here: partly below horizon
  event     UTC                    Sun alt        Az     PA  seen
  c1        2012-06-05T22:03:54Z  +24 37.5  279 43.3   41.2  yes
  c2        2012-06-05T22:21:26Z  +21 19.9  282 15.9   38.7  yes
  sunset    2012-06-06T00:26:17Z  - 0 50.0  300 59.9    8.8  yes
...
```

### `skyfix conjunctions --from --to [--planets] [--no-moon] [--stars] [--max-separation] [--lat --lon] [--zone]`

Closest approaches of planets to each other, to the Moon and to bright stars; with an
observer, the best moment within 12 hours to see the pair in a dark sky.

```console
$ skyfix conjunctions --from 2020-12-01 --to 2020-12-31 --lat 39.9526 --lon -75.1652 \
      --zone -05:00
CONJUNCTIONS
Window     2020-12-01T05:00:00Z to 2021-01-01T05:00:00Z, shown in UTC-05:00
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 0 m above the WGS84
           ellipsoid

  local                UTC                   pair               sep deg   PA  from Sun  mags        best seen here
  2020-12-06 14:43:39  2020-12-06T19:43:39Z  Moon - Regulus       4.513   19       105  - / 1.4     2020-12-06 05:13 +67 01.6 / +61 53.3
...
  2020-12-21 13:21:22  2020-12-21T18:21:22Z  Jupiter - Saturn     0.102  168        30  -2.0 / 0.7  2020-12-21 17:21 +14 42.5 / +14 45.7
...
```

### `skyfix stations --from --to [--zone]` and `skyfix earth-apsides --year`

```console
$ skyfix stations --from 2024-11-01 --to 2025-02-28
PLANETARY STATIONS
Window     2024-11-01T00:00:00Z to 2025-03-01T00:00:00Z

  UTC                   planet                      in                    at deg  from Sun    mag
  2024-11-15T14:20:19Z  Saturn   retrograde ends    ecliptic longitude  342.6927     109.0   0.87
  2024-11-16T05:57:00Z  Saturn   retrograde ends    right ascension     344.8575     108.3   0.88
  2024-11-26T02:42:21Z  Mercury  retrograde begins  ecliptic longitude  262.6717      18.4   0.33
  2024-11-26T04:26:15Z  Mercury  retrograde begins  right ascension     261.9238      18.3   0.35
...
```

```console
$ skyfix earth-apsides --year 2026
THE EARTH'S PERIHELION AND APHELION 2026

  UTC                                     au         km
  2026-01-03T17:15:40Z  perihelion  0.983302  147099893
  2026-07-06T17:30:19Z  aphelion    1.016644  152087774
```

### `skyfix orbit <FILE> [--lat --lon (--utc | --from --to [--step])]`

Comets and asteroids from orbital elements (lines in the Minor Planet Center's formats,
or JSON; `-` reads standard input): the elements read, where the bodies are at `--utc`,
or their tracks from `--from` to `--to`. `$D/ceres.elements.json` is the API's example,
the Minor Planet Center's elements of (1) Ceres (Source: Minor Planet Center).

```console
$ skyfix orbit $D/ceres.elements.json --lat 39.9526 --lon -75.1652 --height 12 \
      --utc 2026-09-24T12:00:00Z
CUSTOM BODIES
Observer   39 57.16' N, 075 09.91' W (39.952600, -75.165200), 12 m above the WGS84
           ellipsoid
Time       2026-09-24T12:00:00Z

  body       kind      app. alt        Az        RA      Dec   mag      au  con
  (1) Ceres  asteroid  +72 59.7  188 13.8  105.5640  23.0870  8.69  2.7161  Gem
...
```

## Tides

`skyfix_tides` on the `tides-us` pack (CONVENTIONS 13.11; `docs/ACCURACY.md` section 16):
NOAA's 3499 US stations. Predictions, not observations: weather and surge are not
included, and every report says so. Heights are metres and feet above `--datum` (the
station's own, MLLW, by default).

### `skyfix tide-stations --lat --lon [--count N]` and `skyfix tide-station <ID>`

```console
$ skyfix tide-stations --lat 37.8 --lon -122.4 --count 3 --pack $P/tides-us
TIDE STATIONS NEAR 37 48.00' N, 122 24.00' W (37.800000, -122.400000)

  id       station                              state   NM   km  bearing  kind         curve
  9414305  San Francisco, North Point, Pier 41  CA     0.9  1.6      314  subordinate  interpolated
  9414317  Rincon Point, Pier 22 1/2            CA     0.9  1.6      134  harmonic     harmonic
  9414792  Alcatraz Island                      CA     1.8  3.3      333  subordinate  interpolated
...
```

```console
$ skyfix tide-station 9414290 --pack $P/tides-us
TIDE STATION
Station    San Francisco (Golden Gate), CA, NOAA 9414290
Place      37 48.38' N, 122 27.95' W (37.806306, -122.465889)
Kind       harmonic; mixed semidiurnal tide (form number 0.84)
Datums     HAT, MHHW, MHW, MTL, MSL, MLW, MLLW, LAT, NAVD88 (default MLLW)
Curve      harmonic
```

### `skyfix tide-extremes <ID> --from --to [--datum] [--zone]`

High and low water: a tide table. With `--zone nautical` the zone is the station's.

```console
$ skyfix tide-extremes 9414290 --from 2026-09-24 --to 2026-09-25 --zone -07:00 \
      --pack $P/tides-us
HIGH AND LOW WATER
Station    San Francisco (Golden Gate), CA, NOAA 9414290
Place      37 48.38' N, 122 27.95' W (37.806306, -122.465889)
Kind       harmonic; mixed semidiurnal tide (form number 0.84)
Datums     HAT, MHHW, MHW, MTL, MSL, MLW, MLLW, LAT, NAVD88 (default MLLW)
Window     2026-09-24T07:00:00Z to 2026-09-26T07:00:00Z, shown in UTC-07:00; harmonic
           prediction

  local                UTC                   tide      m    ft
  2026-09-24 04:25:49  2026-09-24T11:25:49Z  low   0.101  0.33
  2026-09-24 11:11:56  2026-09-24T18:11:56Z  high  1.574  5.16
  2026-09-24 16:41:43  2026-09-24T23:41:43Z  low   0.526  1.73
  2026-09-24 22:47:35  2026-09-25T05:47:35Z  high  1.684  5.52
...
```

### `skyfix tide-predict <ID> --from --to [--step MIN] [--datum] [--zone]`

```console
$ skyfix tide-predict 9414290 --from 2026-09-24T18:00:00Z --to 2026-09-24T20:00:00Z \
      --step 30 --pack $P/tides-us
TIDE CURVE
Station    San Francisco (Golden Gate), CA, NOAA 9414290
Place      37 48.38' N, 122 27.95' W (37.806306, -122.465889)
Kind       harmonic; mixed semidiurnal tide (form number 0.84)
Datums     HAT, MHHW, MHW, MTL, MSL, MLW, MLLW, LAT, NAVD88 (default MLLW)
Window     2026-09-24T18:00:00Z to 2026-09-24T20:00:00Z, every 30 min; harmonic
           prediction

  UTC                       m    ft
  2026-09-24T18:00:00Z  1.570  5.15
  2026-09-24T18:30:00Z  1.566  5.14
  2026-09-24T19:00:00Z  1.518  4.98
  2026-09-24T19:30:00Z  1.431  4.69
  2026-09-24T20:00:00Z  1.312  4.30
...
```

### `skyfix tide-now <ID> --utc [--datum]` and `skyfix tide-pack`

```console
$ skyfix tide-now 9414290 --utc 2026-09-24T19:00:00Z --pack $P/tides-us
THE TIDE NOW
Station    San Francisco (Golden Gate), CA, NOAA 9414290
Place      37 48.38' N, 122 27.95' W (37.806306, -122.465889)
Kind       harmonic; mixed semidiurnal tide (form number 0.84)
Datums     HAT, MHHW, MHW, MTL, MSL, MLW, MLLW, LAT, NAVD88 (default MLLW)
Time       2026-09-24T19:00:00Z
Tide       1.518 m (4.98 ft) above MLLW, falling at -0.137 m an hour

  UTC                   tide      m    ft
  2026-09-24T18:11:56Z  high  1.574  5.16
  2026-09-24T23:41:43Z  low   0.526  1.73
  2026-09-25T05:47:35Z  high  1.684  5.52
...
```

```console
$ skyfix tide-pack --pack $P/tides-us
TIDES PACK
Pack       tides-us 2026-09-25, 344515 bytes of data, provides tides:us
Stations   3499 (1256 harmonic, 2243 subordinate)
```

## The lunar limb

`skyfix_almanac::eclipses::limb` on the `lunar-limb` pack (CONVENTIONS 15.7;
`docs/ACCURACY.md` section 19): the Moon's mountains and valleys at its edge, from LRO
LOLA topography.

### `skyfix eclipse <ID> --lat --lon --limb`

The eclipse's local circumstances with the limb-corrected contacts, the central duration
against the mean limb's, and approximate Baily's beads (the JSON's `local.limb`, the
site's `eclipse_local_limb`). With the pack loaded the eye-safety line quotes the real
limb's totality, never the longer of the two.

```console
$ skyfix eclipse 2024-04-08-solar --lat 32.7767 --lon -96.797 --height 150 --limb \
      --pack $P/lunar-limb
SEEN FROM  32 46.60' N, 096 47.82' W (32.776700, -96.797000), 150 m above the WGS84 ellipsoid
...
Totality   2024-04-08T18:40:43Z to 2024-04-08T18:44:35Z, 3 min 51 s
...
Lunar limb
...
Here       total with the real limb
Central    3 min 48 s (-3 s against the mean limb)
  UTC                   contact     change   mean limb     PA  height  s per "
...
  2024-04-08T18:40:43Z  c2            -1 s    18:40:43   21.9  -0.17"      2.7
  2024-04-08T18:44:31Z  c3            -4 s    18:44:35  253.4  -1.83"      2.7
...
Eye safety: never look at the Sun, even when it is mostly covered, without certified
eclipse glasses (ISO 12312-2) or a pinhole projector. Only during totality itself, here
from 2024-04-08T18:40:43Z to 2024-04-08T18:44:31Z with the Moon's real limb, is it safe
...
```

### `skyfix limb-profile --lat --lon --utc [--every DEG]` and `skyfix limb-pack`

The Moon's outline as a place sees it at an instant: heights above the 1737.4 km sphere
by position angle (the JSON has every 1/16 degree).

```console
$ skyfix limb-profile --lat 32.7767 --lon -96.797 --height 150 \
      --utc 2024-04-08T18:42:39Z --every 45 --pack $P/lunar-limb
THE MOON'S LIMB
Observer   32 46.60' N, 096 47.82' W (32.776700, -96.797000), 150 m above the WGS84
           ellipsoid
Time       2024-04-08T18:42:39Z
Moon       354061 km away; the 1737.4 km sphere is 1012.160" in radius here; libration
           +1.798, -0.107 deg; its north pole at PA 339.28 deg, the zenith at 6.79 deg
Sun        radius 958.218", centre -16.915" east and +18.420" north of the Moon's
Mean limb  NASA's k1 Moon +0.330", k2 Moon -0.440" against the sphere

  PA deg  height "
...
```

```console
$ skyfix limb-pack --pack $P/lunar-limb
LUNAR LIMB PACK
Pack       lunar-limb 2026-09-25: LRO LOLA LDEM_16 V3.1 (LRO-L-LOLA-4-GDR-V1.0), NASA PDS Geosciences Node
Ring       every 0.0625 deg (1.895 km), -12 to 12 deg from the mean limb, heights -7305 m to 6905 m above 1737.4 km
```

---

## The almanac's other tables

The rest of the printed Nautical Almanac beside its daily pages (`skyfix almanac`):
three-date openings, Increments and Corrections, the Altitude Correction Tables, the
additional corrections for Venus and Mars, the Polaris tables and Conversion of Arc to
Time (`skyfix_almanac::{opening, tables}`; CONVENTIONS 13.9.1; `docs/ACCURACY.md`,
"Almanac tables and three-day pages"). Display and teaching only: sight reduction never
reads them. The text prints each table's `printed` values, rounded as the printed tables
round; `--format json` is the export's document, with the numbers beside them.

### `skyfix almanac-opening --date`

The two facing pages for the three UT dates of an opening: the three daily pages as
`skyfix almanac` prints them, then moonrise and moonset for the three dates and the
next, and the planets' SHA. The dates are grouped from 1 January in the date's calendar
(`--calendar`, as for every date).

```console
$ skyfix almanac-opening --date 2016-03-08
THE NAUTICAL ALMANAC'S OPENING  2016-03-08
Dates      2016-03-07 Monday, 2016-03-08 Tuesday, 2016-03-09 Wednesday (Gregorian
           calendar)

...
MOONRISE AND MOONSET  2016-03-07 to 2016-03-10, by day of the month
  Lat   rise 07  set 07  rise 08  set 08  rise 09  set 09  rise 10  set 10
  N 72    07 13   14 32    07 08   16 33    07 03   18 34    06 58   20 34
...
```

### `skyfix almanac-increments --minute M`

```console
$ skyfix almanac-increments --minute 58
INCREMENTS AND CORRECTIONS  58m

   s  Sun and planets    Aries     Moon
  00          14 30.0  14 32.4  13 50.4
  01          14 30.3  14 32.6  13 50.6
  02          14 30.5  14 32.9  13 50.8
...
```

### `skyfix almanac-arc-to-time`

```console
$ skyfix almanac-arc-to-time
CONVERSION OF ARC TO TIME

Degrees (h m)
  deg   h m  deg   h m  deg    h m  deg    h m  deg    h m  deg    h m
    0  0 00   60  4 00  120   8 00  180  12 00  240  16 00  300  20 00
    1  0 04   61  4 04  121   8 04  181  12 04  241  16 04  301  20 04
...
```

### `skyfix almanac-altitude [--temperature C --pressure HPA]`

The Sun's, the stars' and planets' and the dip's critical tables; with the air's
temperature and pressure, the exact additional corrections for them (and their zone).
The JSON adds the Moon's two-part table and every zone's corrections.

```console
$ skyfix almanac-altitude --temperature 31.1 --pressure 982
ALTITUDE CORRECTION TABLES
Refraction Bennett (1982), CONVENTIONS 5 at 1010 hPa and 10 C; the Sun's SD 16.15'
(October to March) and 15.9' (April to September), HP 0.147'.

Sun, October to March (apparent altitude)
  apparent altitude  Lower limb  Upper limb
  9 53 to 10 05           +10.9       -21.4
  10 05 to 10 17          +11.0       -21.3
...
Additional corrections for 31.1 C and 982 hPa (factor 0.9048, zone M)
  app. alt  corr
  0 00      +3.3
...
```

### `skyfix almanac-planets --year` and `skyfix almanac-polaris --year`

```console
$ skyfix almanac-planets --year 2016
ADDITIONAL CORRECTIONS FOR VENUS AND MARS 2016

Venus, 2016-01-01 to 2016-12-03: HP 0.1'
  apparent altitude  Corr
  0 to 59            +0.1
  59 to 90            0.0

...
```

```console
$ skyfix almanac-polaris --year 2016
POLARIS (POLE STAR) TABLES 2016
Mean place SHA 316 48.9, Dec N 89 19.9; polar distance 40.089'; the formula's own error up to 0.0068'

LHA Aries
                  0-9   10-19   20-29   30-39   40-49   50-59
  a0 0         0 29.7  0 25.3  0 22.0  0 19.8  0 18.8  0 19.0
  a0 1         0 29.2  0 25.0  0 21.7  0 19.6  0 18.7  0 19.1
...
  a1 lat 0        0.5     0.5     0.6     0.6     0.6     0.6
...
```

---

## Other things worth running

```console
# The uncertainty model working, and then failing on a correlated error.
skyfix experiment --demo philadelphia-stars --repetitions 100
skyfix experiment --demo shared-bias --repetitions 100 --out bias.csv

# Two sights cross twice; one sight is a circle.
skyfix solve $D/phl_two_star.session.json
skyfix solve $D/phl_one_star.session.json

# Good against clustered geometry: same stars, same seed, same noise.
skyfix experiment --demo good-geometry --repetitions 100
skyfix experiment --demo clustered-geometry --repetitions 100

# The same plan optimised for shape rather than size.
skyfix plan --position 39.9526,-75.1652 --utc 2026-10-01T01:30:00Z --objective min-condition
```

`shared-bias` is *supposed* to report a coverage of 0.000 with an error thirty times the
predicted sigma. Twenty-four sights shrink the ellipse and do not touch an error that is
identical on every one of them. A runner that reported 0.95 there would be measuring
nothing.

---

## Fixtures and how they are made

The sessions under `crates/skyfix-cli/tests/data/` are derived, not typed. Each is built
from a truth position and a real sky: the directions come from the star provider at
2026-10-01T01:30:00Z, and every altitude is the exact altitude an observer at
Philadelphia City Hall would measure. The `sextant_hs` session runs the correction chain
*backwards*, so its recorded readings reduce forwards onto that same `Ho`.

The truth lives in its own document, `phl.truth.json`, and no command reads it.

`tests/fixtures.rs` rebuilds each one and compares it with the committed file, allowing
numbers to differ by 1e-8 degrees — 0.04 milliarcseconds, under a tenth of a millimetre
of position. That is far below anything meaningful and far above the floating-point
floor, so a genuine change in the sky model fails the test while a rebuild does not. To
regenerate after a deliberate change:

```console
SKYFIX_WRITE_FIXTURES=1 cargo test -p skyfix-cli --test fixtures
```

If that changes anything, every worked example above needs re-running.

The inputs of the explorer commands' examples are transcriptions, not computations:
`noon_equinox_sun`, `average_vega` and `running_fix_north` are raw sextant readings from
the Skyfield cases of `fixtures/reference/nav_methods.json`, the two `bowditch` sessions
are typed from Bowditch's sections 1910 and 1912 via
`fixtures/reference/bowditch_worked_examples.json`, and `lunar_19.input.json` is the
`lunar_distance` example of `docs/EXPLORER_API.md`. `tests/explorer_fixtures.rs` rebuilds
them from those sources (`SKYFIX_WRITE_FIXTURES=1 cargo test -p skyfix-cli --test
explorer_fixtures`), and `tests/explorer_golden.rs` holds thirty-three text reports, most
of them the examples above, to the byte against `tests/golden/` (`SKYFIX_WRITE_GOLDEN=1`
to regenerate after a deliberate change, then read the diff). Every example in this
document between "The sky, almanac events and the navigation methods" and "Other things
worth running" is run by the same test file, and its quoted lines must appear in its
output in order. `tests/parity.rs` holds the expansion commands to their library calls
and their WASM exports (above, "How they answer"); `ceres.elements.json` is the
`parse_orbits` example of `docs/EXPLORER_API.md`.
