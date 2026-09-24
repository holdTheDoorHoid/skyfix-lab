# `skyfix` — the command line

`skyfix` is the whole engine with a terminal in front of it. Every number it prints is
computed by `skyfix-core`, `skyfix-ephemeris` and `skyfix-sim`; this crate owns the
argument parsing, the files and the words.

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
| 2 | one or more sights were rejected; whatever could be reduced was still printed |
| 3 | the solve failed, or `--require-unique` was given and the result was not a unique fix **with a reported 95 % ellipse** |
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
| `--date YYYY-MM-DD` | the UT date, 1990-01-01 to 2060-12-31. Required |
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
