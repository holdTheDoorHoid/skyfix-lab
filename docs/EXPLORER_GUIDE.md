# Using the explorer

The explorer is the map-first way to use SkyFix Lab: pick a place, pick a moment, and see
where the Sun, the Moon, the planets and the navigational stars are from there — how high,
in which direction, and when each one rises and sets. It is the site's home page,
<https://holdthedoorhoid.github.io/skyfix-lab/>. Nothing the original workbench could do is
gone: the [Navigate](#navigate) view below now does everything it did (sights,
corrections, the fix, the planner) and more, and [Learn](#celestial-navigation-in-five-minutes)
has its simulator and demonstrations. The original workbench itself was retired in
September 2026; its old address, `/classic/`, now opens the explorer instead — its
Observations, Corrections, Fix and Planner links on Navigate, its Simulator link on
Learn — online or offline. Links to the explorer's old address, `/next/`, share links
included, still work too: they open the home page with the same place and time.

**Simulation and analysis workbench. Not a navigation instrument.** Every position and
time on the page comes from the same offline calculation engine as the command line
(`skyfix`, [Command line](CLI.md)), compiled to run inside your browser. Numerical
agreement with reference data is not field accuracy — see
[Accuracy and limitations](ACCURACY.md).

![The explorer's Map view: a compass centred on the observer, the time ribbon across the top, and the side panel showing the place, the Sun's height and direction, and today's sunrise and sunset.](design/app-light.png)

On your first visit a short tour — four cards beside the parts they explain: the place,
the time bar, the views, and what the numbers are — points the way. It never blocks the
page; skip it, or close it, and it stays closed on that device. **Show the tour** in the
**?** Help menu, or on the About view, brings it back.

## Setting a place

The explorer always has one place selected. Four ways to change it, all in the search box
at the top of the side panel or the map itself:

- **Click the map** (press and hold, on a touchscreen). Click again to fine-tune.
- **Type a place name** into the search box — "Manila", "Cape Horn" — and choose from the
  list. Place names come from an offline gazetteer of about 7,300 towns and cities
  ([Third-party sources](THIRD_PARTY.md), "Basemap and gazetteer"), so this works with no
  connection.
- **Type coordinates** into the same box — `39 57.2 N 75 09.9 W`, or plain decimal degrees
  `39.9526, -75.1652` both work. The box accepts the usual forms a navigator or a chart
  would use.
- **"Use my location"**, the target-shaped button beside the search box. Your browser will
  ask permission first. The position it finds is used only in this page — it is never
  saved and never sent anywhere (see [Sharing a link](#sharing-a-link) below for the one
  exception, which you control).

Press **Edit** at the top of the Place panel for exact entry: coordinates, an optional
name, the time zone, and your **height of eye** — how high above the sea your own eyes
are, which sets the dip of the horizon for sights and for rise/set times if you turn on
"dipped" horizon in Settings.

A place's **time zone** normally follows the place (guessed from where it is, with the
reason shown underneath). Press the pin beside the time zone to keep your own choice —
UTC, "nautical zone time" (the whole-hour zone a vessel at sea would keep), or a specific
zone — even as you move the place around.

## Moving through time

The ribbon across the top of the page is the explorer's clock. It is coloured by the
Sun's phase at your place — night, the three twilights (astronomical, nautical, civil)
and day — with rise, highest point and set marked for whichever body is selected below.
Drag the handle, or use any of these:

- **The day arrows** beside the date step one calendar day at a time.
- **The date**, clicked, opens a calendar for picking any day directly.
- **The clock**, clicked, lets you type a time of day.
- **Now** jumps to the current moment and starts following the real clock (a small dot
  shows it is "live"); moving the time by hand turns this off again.
- **Play** runs time forward (or backward — there is a direction switch beside the speed)
  at a chosen speed, from real time up to a month per second:

  | speed |  | speed |
  |---|---|---|
  | Real time | | 6 hours per second |
  | 1 minute per second | | 1 day per second |
  | 10 minutes per second | | 1 week per second |
  | 1 hour per second | | 1 month per second |

**Keyboard shortcuts**, usable anywhere on the page (they are also listed under the
**?** Help button in the top bar):

| keys | what it does |
|---|---|
| `←` / `→` | 10 minutes back or on |
| `Shift` + `←` / `→` | 1 hour |
| `Alt` + `←` / `→` | 1 day |
| `Page Up` / `Page Down` | 1 month (with `Shift`, 1 year) |
| `Space` | play or pause |
| `N` | now: follow the clock |
| `Esc` | close a menu |

## The selected body

The panel's **Selected** card gives the chosen body's height above the horizon and its
direction in large type, and its rise, highest point and set for the pass it is on. For
the Sun it adds the twilight times, the length of the day, and the length of the shadow of
an object of any height you type. **When is it at…?**, for any body, lists the times on the
day shown when it passes a height you type — 30°, say, or −6° for the Sun at the end of
civil twilight — and pressing one moves the clock there. **Navigator's details** add the
GHA, the declination, and Hc and Zn as sight-reduction tables give them: seen from the
Earth's centre, with no refraction or parallax, so for the Moon they differ from its height
above your horizon by up to a degree.

## The views

The tabs along the top of the side panel (or, on a phone, along the top of the bottom
sheet — see below) switch between eight views. The place, the time and the selected body
are shared across all of them.

### Map and Globe

The home view: a full offline world map (public-domain Natural Earth data — see
[Third-party sources](THIRD_PARTY.md)) with an optional online street-map layer you can
switch on in Layers. At your place, a compass dial shows the horizon, where the selected
body rises, sets and is right now, and its path across the sky on its current pass —
from its rise through its highest point to its set, the same pass the panel's Selected
card shows (so the Moon's "Moonset 05:37 Fri" is the same on both; a time on another day
carries its weekday). The solstice band shows the Sun's extreme paths at midsummer and
midwinter. Day, night and the three twilights are
shaded across the whole map, along with the ground point of each body — the spot on Earth
directly beneath it — and, for the selected body, the circle you would get by measuring
its height with a sextant right now. **Chart** and **Globe** (top right) switch between a
flat map and a spinning globe of the same data; a ruler tool measures a distance and
bearing between two points. What other views draw on the map — Navigate's fix, an eclipse
from Events, a Learn demonstration — is listed at the bottom of **Layers**, each with a
**Remove** button; while such a drawing is on the map, the compass dial turns see-through
so the fix under it stays readable.

![The Globe projection at night, showing the Moon's ground point, its rise and set, and the twilight shading over North America.](design/map-view-globe-dark.png)

### Sky

What you would actually see, looking up: a **Dome** (the whole sky at once, zenith in the
middle) or a **Panorama** (drag to turn toward any compass point, scroll to zoom), with
roughly 9,000 stars sized by brightness and tinted by colour, the 88 constellation
figures, the planets, the Moon with its correct phase, and the sky's own colour following
the Sun. A **South up** switch flips the dome for the southern hemisphere. The star field
is for display only — see [Third-party sources](THIRD_PARTY.md), "Star field and
constellations" — and never affects a fix.

![The Sky dome at night over Philadelphia: stars, constellation figures, the ecliptic, and the Sun's position well below the horizon.](design/sky-night-philadelphia-dome.png)

### Charts

Four charts, each also available as a plain table (**View as** → **Table**, top right):
**Day** (the height of each body through the day, over the twilight bands), **Year**
(sunrise, sunset and twilight for every day of the year, with the Moon's phase along the
top), **Moon** (a monthly phase calendar with moonrise and moonset), and **Planets** (when
each is up in the dark, through the year).

![The Year chart: a whole year of sunrise, sunset and twilight bands for Philadelphia, with the solstices, equinoxes and Moon phases marked.](design/charts-year-light.png)

### Almanac

Daily pages laid out the way a printed nautical almanac's are: GHA and declination for
Aries, the Sun, the Moon and the four navigational planets at every hour, the 57
navigational stars plus Polaris, meridian passages, and the rise/set/twilight table across
31 standard latitudes. Step a day at a time or jump to **Today**; **Print** produces a
clean printable page. This is the same computation as `skyfix almanac` on the command
line ([Command line](CLI.md)) and is normative in
[Accuracy and limitations](ACCURACY.md), "Almanac pages".

![A daily almanac page: GHA and declination for Aries, the four navigational planets and every navigational star, at every hour of the day.](design/almanac-screen.png)

### Navigate

Where you actually work out a position, the way the whole project is really about. Enter
sights body-first — pick the body, which edge of the disc you brought to the horizon, the
time, the sextant reading and how sure you are — and every correction (index error, dip,
refraction, semidiameter, parallax) is worked out live beside it, never hidden. Nine
tabs, each explained in plain words as you open it:

| tab | what it gives you |
|---|---|
| **Fix** | your position from several sights, by weighted least squares, with the honest 95 % ellipse, conditioning and every result kind (unique, ambiguous, underdetermined, failed) |
| **Noon sight** | latitude from a body's highest point, and a weak longitude from when it happened |
| **Polaris** | latitude from the Pole Star, with the Nautical Almanac's a0/a1/a2 shown beside the rigorous answer |
| **Running fix** | sights taken on the move, brought to one instant along your course and speed |
| **Average a run** | several quick sights of one body turned into one good one |
| **Lunar distance** | Greenwich time — and so longitude — from the angle between the Moon and another body, with no chronometer |
| **Plan sights** | tonight's evening and morning twilight windows, which bodies to shoot and in what order, predicted readings included, and the **star finder** |
| **Compass** | the magnetic variation here and today, and your compass's error from a bearing of the Sun, the Moon, a planet or a star, split into variation and deviation; a deviation table |
| **Passage** | a route of waypoints sailed by great circle or rhumb line, with distances, courses and arrival times, drawn on the map; where you will be (dead reckoning) |

The Fix's chart has a **Fit map** switch: it shades every nearby position by how well it
fits your sights — darker is worse — with the 95 % and 3-sigma lines drawn on it and a
caption saying what the shading can and cannot show (a biased sextant or a wrong clock
moves the whole picture without widening it). It is off to start; with it on, **Show on
the map** takes those lines to the map too.

**The session's settings** hold what stays the same from sight to sight. Leave **UT1 −
UTC** blank and the view says what it uses instead: the IERS value for the date, a
prediction, or 0 with its ±0.9 s (up to 0.23′ of longitude) where nothing is known; type
your time signal's value to replace it. If your index error or your watch drifts, log them:
the **index-error log** and the **watch log** take a value at each check, and every sight
then uses the value at its own time (in between two checks, the straight line between
them; outside the log, the nearest check held, never extrapolated), and its workings say
which. The **horizon** can be a shoreline nearer than the sea horizon: give its distance and
the dip of the sea short of the horizon is used (Bowditch's Table 14), with a sentence
saying how much it is — and, when the shore is beyond the sea horizon and so hidden, that
the ordinary dip applies.

**What did I shoot?** Under the sight form, give a rough bearing (true, magnetic or by
compass) and the time and reading you typed are enough to list the bodies that fit, closest
first, with how far each is from your sight; **Use** puts one in the form.

**Compass.** The variation (declination) comes from the WMM2025 or IGRF-14 model with its
uncertainty and yearly change; before 1900 and after 2030 no model is good enough, and the
view says so instead of guessing. Take the bearing of a body **by azimuth** (any time — note
the time to the second) or **by amplitude** (as it rises or sets, on the visible or the
celestial horizon), and the view gives "Compass error 14.4° W; variation 11.8° W; deviation
2.6° W" with every figure behind it. Give the ship's heading and the deviation goes into the
**deviation table**; with headings all round (a swing takes eight), the table fits the
classic deviation curve (coefficients A to E) and prints a card every 15°.

**Passage.** Type waypoints, add the DR or the map's place, or measure on the map and choose
**Add as a leg of the passage**. Each leg is sailed by great circle (shortest, its course
turning — with points every 5° of longitude to steer between) or by rhumb line (one course).
With a speed and a departure time you get the time of every waypoint, the dead-reckoning
position at the time bar's time (**DR now**, which can become your session's DR), marks every
few hours on the map, and a GPX route. **Use in the running fix** hands the passage's legs,
over the hours of your sights, to the running fix. **Where will I be?** works one leg of
dead reckoning forward (or back) from any position.

**Printing.** **Print worksheets and plotting sheet** in the Fix tab gives a universal
plotting sheet centred on your DR, with each sight's intercept and line of position and the
fix, and one worksheet per sight in the six classic steps (time, altitude, almanac, hour
angle, computed altitude, intercept), with an empty column for your own figures; each sight's
workings print its worksheet alone. The **star finder** in Plan sights is a 2102-D-style
disc of the navigational stars with the altitude-azimuth template for your latitude laid over
it, turned to LHA ♈ as the time bar moves; it prints on two sheets (the template on
transparency). Everything prints black on white; on screen the night theme stays red.

Sights are offered only between 1990 and 2060 today, the span the almanac is validated for
(1550–2650 once the deep-time work is merged); outside it the sight form says why and does
not add the sight.

The fix (and the circles of position behind it) draws directly on the Map view, and so does
a passage. Sessions save automatically **in this browser only** — nothing is kept until you
enter something of your own, and nothing is ever sent anywhere or written into the address
bar — and you can import or export a session as JSON or CSV, save a fix as a GPX waypoint or
a passage as a GPX route. A handful of worked examples are built in if you want to see a
method with real numbers before typing your own.

**Settings → Sights** holds the index correction used by tonight's sights and by new
sessions; the **Place** editor holds your site's elevation (it barely matters: at 1000 m the
Moon stands 0.5″ lower) as well as your height of eye (which sets the dip).

![The Navigate view's Fix method: five star sights with their corrections, tonight's recommended bodies in the side panel, the solved position with its 95% ellipse, and the circles of position plotted on a chart.](design/navigate-fix-light.png)

### Events

Eclipses, Moon phases, equinoxes and solstices, and the planets' big moments, as lists
you can click.

- **Eclipses** — every solar and lunar eclipse of the next (or last) ten years, with a
  switch for "seen from here". Pick one to read, in plain words, what you would see from
  your place: whether you are inside the path of totality, when it starts and ends, how
  much of the Sun is covered, and how high it stands. **Show on the map** draws the path
  of totality (or annularity), its central line and the limits of the partial eclipse;
  **Go there** moves your place and time to the point of greatest eclipse. Solar eclipse
  cards carry an eye-safety note.
- **Moon phases** for the coming months, with links to any eclipse they bring.
- **Seasons** — the equinoxes and solstices, worded for your hemisphere.
- **Planets** — oppositions, conjunctions with the Sun (and the rare transits of Mercury
  and Venus across it), greatest elongations of Mercury and Venus, and closest approaches.

Clicking any event moves the explorer's time to it. The eclipse list agrees with NASA's
eclipse canon for every eclipse of 1990–2060 (see [Accuracy and limitations](ACCURACY.md),
"Eclipses" and "Planet events"). From a terminal, `skyfix events`, `skyfix phases` and
`skyfix seasons` give the day's events, the Moon's phases and the seasons;
`skyfix eclipses` lists the eclipses and what your place sees of each, `skyfix eclipse`
gives one eclipse's contacts from your place and its path (as GeoJSON for any map tool),
and `skyfix planet-events` the planets' oppositions, conjunctions, elongations and
closest approaches (see [Command line](CLI.md)).

![The Events view: the total solar eclipse of 8 April 2024 as seen from Dallas, with its timeline and contact times.](design/events-eclipse-light.png)

### Learn

Ten guided demonstrations of what a fix is worth and is not, an illustrated primer on how
celestial navigation works, and the coverage simulator — see
["Celestial navigation in five minutes"](#celestial-navigation-in-five-minutes) below.

### About

What the page is, where every number comes from, and a table of how closely each part
(the Sun, the Moon, the planets, the stars) has been checked against an independent
reference ephemeris, with which are validated for real sights. It also explains, in one
place, what happens to your chosen place (nothing, unless you press Share), links this
manual and the source code, and credits the map, star and font data. The **?** Help menu
has the same two links.

## Themes, including night vision

The **Theme** control in the top bar (or, on a phone, under **Settings**) offers four
choices:

- **Auto** — light or dark, following your device's own setting.
- **Light** — a light map with a dark panel.
- **Dark** — a navy map and panel.
- **Night vision** — red on black everywhere, including the map. This is the traditional
  chart-table trick of using only red light so your eyes stay adjusted to the dark; use it
  on deck at night, whether or not you are actually taking sights.

![The Map view in the night-vision theme: everything, including the map itself, rendered in shades of red.](design/app-night.png)

**Settings** (the sliders icon beside Theme) also controls: whether the clock shows your
local time or UTC first; a 24-hour or 12-hour clock for local times (`18:40` or
`6:40 PM`; UTC always stays on the 24-hour clock, as navigators write it); how angles are
written (`26° 02.3′`, `26° 02′ 17″`, or `26.038°`); units (metric, nautical, or
imperial); whether rise and set are figured for a sea-level horizon or dipped for your own
height of eye; and a **Navigator's terms** switch that shows the navigator's word beside
the plain one everywhere on the page ("Height above horizon · altitude"). All of these are
remembered on your own device. Your chosen place never is. **Data packs**, at the bottom,
lists the optional data this site offers (see [Working offline](#working-offline)).

## Sharing a link

Press **Share** in the top bar. Nothing is sent anywhere by opening this panel — a link is
only *built*, there, when you ask for it, and it opens exactly this place, this time and
this selected body for whoever you send it to. Two checkboxes let you leave the place or
the time out of the link before you copy it. On a phone or tablet (anywhere the device has
a share sheet) **Share…** beside **Copy** hands the same link to it. Outside of pressing
Share, your position is never written into the address bar and never leaves your browser.

## Working offline

Load the page once while you have a connection. It saves itself on your device — you will
see **"Saved on this device: SkyFix Lab now works offline"** the first time — and after
that everything it needs (the calculation engine, the offline map, the star catalogue, the
fonts) runs from your device with no network at all: not just in the tab you loaded it in,
but the next time you open it too, connection or none. The one exception is the optional
street-map layer under Layers, which is off by default and only ever asked for while it is
switched on; it does not work offline.

Lose your connection while using the page and an **Offline** chip appears at the bottom
of the view to say so — a reassurance, not a warning, since nothing else changes. When a
new version of the site is published, a card there offers to reload into it; your work is
never lost or reloaded without your say so.

Some data is too large, or too specialised, for everyone to download on a first visit, so
it comes as an optional **data pack**: the positions of the Sun, Moon and planets far
outside 1550–2650, tide stations, the Moon's detailed edge for eclipses. When a view needs
one, a small card says so, gives its size, and offers **Get** or **Not now**; a pack you
get is downloaded once and saved in this browser, then works offline like everything else.
**Settings → Data packs** lists what the site offers and what is saved on your device,
with **Get** and **Remove**. Nothing about you is sent when a pack is downloaded.

You can also **install** SkyFix Lab as an app — **Install SkyFix Lab** in the **?** Help
menu or on the About view, when your browser offers it; "Install" in the address bar of
Chrome or Edge; "Add to Home Screen" from the Share menu on an iPhone or iPad. It opens in
its own window at the explorer, and works offline in the same way. A copy installed before
the switch-over (when the explorer was at `/next/`) is the same app and opens the home
page.

## Celestial navigation in five minutes

New to this? Open **Learn**, which starts on **How it works**: five short illustrated
steps from "a star is straight overhead somewhere" to a plotted position with its honest
uncertainty, each one linked straight to a real demonstration with real numbers so you can
see the idea actually working rather than just read about it.

<https://holdthedoorhoid.github.io/skyfix-lab/#learn>

![The Learn primer: "How celestial navigation works", five numbered steps, the first three shown — the ground point, the circle of position, and two circles crossing in two places — each with a diagram and a link to a live demonstration.](design/learn-primer.png)

From there, **Demonstrations** walks through ten packaged scenarios — a healthy fix, poor
sight geometry, one bad sight, a clock that is wrong, an instrument with a hidden bias,
and the two ways a fix can be ambiguous — narrated against the same numbers as
[Demos](DEMOS.md). **Simulator** lets you build your own scenario and run it many times to
see whether the reported uncertainty actually covers the true error, which is the honest
question behind every number this project produces. A simulated run can be downloaded as a
session file, or opened straight in **Navigate** with **Open in Navigate**: the sights come
across exactly as the solver received them, marked SIMULATED, and the answer key stays in
Learn. Every demonstration's chart has the same **Fit map** switch as Navigate's; it starts
on for "Stars bunched together" and "Two sights", where the shape of the fit says the most.
