# Using the explorer

The explorer is the map-first way to use SkyFix Lab: pick a place, pick a moment, and see
where the Sun, the Moon, the planets and the navigational stars are from there — how high,
in which direction, and when each one rises and sets. It lives at
<https://holdthedoorhoid.github.io/skyfix-lab/next/>, alongside the original workbench
(sights, corrections, the fix and the simulator) at
<https://holdthedoorhoid.github.io/skyfix-lab/>. Nothing the original workbench can do is
gone — see [Navigate](#navigate-and-events-still-being-built) below for how to reach it
today.

**Simulation and analysis workbench. Not a navigation instrument.** Every position and
time on the page comes from the same offline calculation engine as the command line
(`skyfix`, [Command line](CLI.md)), compiled to run inside your browser. Numerical
agreement with reference data is not field accuracy — see
[Accuracy and limitations](ACCURACY.md).

![The explorer's Map view: a compass centred on the observer, the time ribbon across the top, and the side panel showing the place, the Sun's height and direction, and today's sunrise and sunset.](design/app-light.png)

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

## The views

The tabs along the top of the side panel (or, on a phone, along the top of the bottom
sheet — see below) switch between eight views. The place, the time and the selected body
are shared across all of them.

### Map and Globe

The home view: a full offline world map (public-domain Natural Earth data — see
[Third-party sources](THIRD_PARTY.md)) with an optional online street-map layer you can
switch on in Layers. At your place, a compass dial shows the horizon, where the selected
body rises, sets and is right now, and its path for the day; the solstice band shows the
Sun's extreme paths at midsummer and midwinter. Day, night and the three twilights are
shaded across the whole map, along with the ground point of each body — the spot on Earth
directly beneath it — and, for the selected body, the circle you would get by measuring
its height with a sextant right now. **Chart** and **Globe** (top right) switch between a
flat map and a spinning globe of the same data; a ruler tool measures a distance and
bearing between two points.

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

### Navigate and Events: still being built

Two tabs currently say **Coming soon**: **Navigate** (sights, corrections, the fix with
its uncertainty, noon sight, Polaris, a running fix, averaging a run of sights, lunar
distance and planning tonight's sights) and **Events** (eclipses, Moon phases, equinoxes
and solstices, and when planets pass close together). The underlying calculations all
exist and are documented and tested — see [Navigation methods](NAVIGATION_METHODS.md) and
[Moon and planet sights](NAVIGATION_SKY.md) — but their screens in the explorer have not
been built yet.

Until they are, everything Navigate will offer is already in **the current workbench**
(the link on each "coming soon" page, and at the site's front page): enter sights, see
every correction worked out, get the fix on a plot with its ellipse, and run the planner.
If you are comfortable with a terminal, every navigation method, plus events, eclipses,
Moon phases and seasons, is also available from the command line — see
[Command line](CLI.md), sections "The sky, almanac events and the navigation methods".

### Learn

Ten guided demonstrations of what a fix is worth and is not, an illustrated primer on how
celestial navigation works, and the coverage simulator — see
["Celestial navigation in five minutes"](#celestial-navigation-in-five-minutes) below.

### About

What the page is, where every number comes from, and a table of how closely each part
(the Sun, the Moon, the planets, the stars) has been checked against an independent
reference ephemeris, with which are validated for real sights. It also explains, in one
place, what happens to your chosen place (nothing, unless you press Share) and credits the
map, star and font data.

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
local time or UTC first; how angles are written (`26° 02.3′`, `26° 02′ 17″`, or
`26.038°`); units (metric, nautical, or imperial); whether rise and set are figured for a
sea-level horizon or dipped for your own height of eye; and a **Navigator's terms** switch
that shows the navigator's word beside the plain one everywhere on the page ("Height above
horizon · altitude"). All of these are remembered on your own device. Your chosen place
never is.

## Sharing a link

Press **Share** in the top bar. Nothing is sent anywhere by opening this panel — a link is
only *built*, there, when you ask for it, and it opens exactly this place, this time and
this selected body for whoever you send it to. Two checkboxes let you leave the place or
the time out of the link before you copy it. Outside of pressing Share, your position is
never written into the address bar and never leaves your browser.

## Working offline

Load the page once while you have a connection. After that, everything it needs — the
calculation engine, the offline map, the star catalogue and the fonts — is already in your
browser, and nothing further is fetched from the network to compute anything (the one
exception is the optional street-map layer under Layers, which is off by default and only
ever asked for while it is switched on). Leaving the tab open, you can lose your
connection entirely — at sea, in the air — and keep using it exactly as before.

Reopening the page later with *no* connection at all is not yet guaranteed to work — that
needs one more piece (an "install this page" step) the team has planned but not shipped.
If you might need it with genuinely zero signal, load it again shortly before you expect
to lose connection, or leave the tab open throughout.

## Celestial navigation in five minutes

New to this? Open **Learn**, which starts on **How it works**: five short illustrated
steps from "a star is straight overhead somewhere" to a plotted position with its honest
uncertainty, each one linked straight to a real demonstration with real numbers so you can
see the idea actually working rather than just read about it.

<https://holdthedoorhoid.github.io/skyfix-lab/next/#learn>

![The Learn primer: "How celestial navigation works", five numbered steps, the first three shown — the ground point, the circle of position, and two circles crossing in two places — each with a diagram and a link to a live demonstration.](design/learn-primer.png)

From there, **Demonstrations** walks through ten packaged scenarios — a healthy fix, poor
sight geometry, one bad sight, a clock that is wrong, an instrument with a hidden bias,
and the two ways a fix can be ambiguous — narrated against the same numbers as
[Demos](DEMOS.md). **Simulator** lets you build your own scenario and run it many times to
see whether the reported uncertainty actually covers the true error, which is the honest
question behind every number this project produces.
