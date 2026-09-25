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

On your first visit a short tour — five cards beside the parts they explain: the place,
the time bar, the views, the Tonight tab, and what the numbers are — points the way. It
never blocks the page; skip it, or close it, and it stays closed on that device. **Show the
tour** in the **?** Help menu, or on the About view, brings it back.

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
- **The date**, clicked, opens a calendar for picking any day directly. Under the month
  there is a **year field** for any year — type `1066`, or `585` with **BC** chosen beside
  it (or `585 BC`, or `−584`) and press **Go** — and buttons that move the time by 10, 100
  or 1000 years either way, keeping the day and the time of day.
- **The clock**, clicked, lets you type a time of day.
- **Now** jumps to the current moment and starts following the real clock (a small dot
  shows it is "live"); moving the time by hand turns this off again.
- **Play** runs time forward (or backward — there is a direction switch beside the speed)
  at a chosen speed, from real time up to ten years per second:

  | speed |  | speed |
  |---|---|---|
  | Real time | | 1 day per second |
  | 1 minute per second | | 1 week per second |
  | 10 minutes per second | | 1 month per second |
  | 1 hour per second | | 1 year per second |
  | 6 hours per second | | 10 years per second |

  Faster than about a week per second the rising and setting times and the ribbon's
  colours are left out while time runs (they would change every frame); they come back
  the moment you pause or slow down.

Along the top edge of the ribbon a thin strip marks the Sun's **golden hour** (the Sun
between 6° above and 4° below the horizon: warm, low light) and **blue hour** (4° to 6°
below: a deep blue sky); hover over it for the times.

**Far from today.** The explorer is built for 2000 BC to AD 3000 (how much of that your
copy covers is in About), and the time bar says what changes as you go back or forward:

- **Dates** before 15 October 1582 are in the **Julian calendar**, as people then wrote
  them, marked *Julian* beside the date; Thursday 4 October 1582 was followed by Friday
  15 October. Years before AD 1 are written "585 BC" (astronomers call that year −584).
  Settings can show the Gregorian calendar carried back instead, and years in the
  astronomers' or ISO style.
- **The clock** beside your local time is **UTC** from 1972 to 2035 and **UT** (Universal
  Time, the time scale of the almanacs) outside those years: UTC did not exist before
  1972, and leap seconds are to end in 2035.
- **Before 1850** the local clock is **local mean time** (LMT) at your place's longitude —
  the Sun's time there, which clocks kept before time zones — unless you pinned a zone.
- **A ± chip** such as `±12 min` beside the clock means the Earth's rotation at that date is
  known only that well, so every clock time carries that uncertainty (the positions of the
  bodies among the stars do not). It appears when the uncertainty passes 30 seconds —
  before about AD 700 and after about 2100 — and always on estimated years.
- **Outside the checked years** a message says so: dates outside 2000 BC to AD 3000 show
  nothing, with the years the copy you are using covers; years only estimated — outside
  1550 to 2650, no download needed — say *Historical estimate* or *Far-future estimate*,
  and sights are offered only in the checked years, 1550 to 2650. Messages take their own
  strip above the view, never covering its buttons; on a phone each is folded to its first
  line, and its arrow shows the rest. Eclipses and the planets' oppositions, conjunctions,
  elongations and transits (Events) still search 1990 to 2060 only, narrower than the rest
  of the site: a search past those years says so and stops there, in both directions.

**Keyboard shortcuts**, usable anywhere on the page (they are also listed under the
**?** Help button in the top bar):

| keys | what it does |
|---|---|
| `←` / `→` | 10 minutes back or on |
| `Shift` + `←` / `→` | 1 hour |
| `Alt` + `←` / `→` | 1 day |
| `Page Up` / `Page Down` | 1 month (with `Shift`, 1 year) |
| `Ctrl` + `Page Up` / `Page Down` | 100 years (with `Shift`, 1000 years); browsers with tabs may keep these keys for themselves, so the calendar's ±100 and ±1000 buttons do the same |
| `Space` | play or pause |
| `N` | now: follow the clock |
| `Esc` | close a menu |

## The selected body

The panel's **Selected** card gives the chosen body's height above the horizon and its
direction in large type, and its rise, highest point and set for the pass it is on. Under
the direction is the same bearing on a magnetic compass ("257° magnetic"); its tooltip
gives the magnetic variation at your place, the model it comes from (the World Magnetic
Model 2025, or the International Geomagnetic Reference Field before 2025) and how far it
can be trusted. There is none before 1900 or after 2030, which the models do not reach.
**Sky position** gives the body's right ascension and declination, its place among the
stars in astronomers' coordinates: the apparent place of the date seen from the Earth's
centre, as an almanac gives it (star atlases and telescope catalogues use the axes of the
year 2000, which precession has since moved by a fraction of a degree). With Navigator's
terms on, the navigator's sidereal hour angle (SHA) is beside it.

For the **Sun** the card adds the twilight times, **golden hour** and **blue hour** for the
morning and the evening (photographers' conventions, not physical boundaries: the Sun
between 6° above and 4° below the horizon, then between 4° and 6° below it; press a time to
go there), the length of the day, and the length of the shadow of an object of any height
you type.

For a **planet** it adds how much of it is lit, its angle from the Sun, its distance and
its size in the sky (its apparent diameter across the equator, in seconds of arc).

For the **Moon** it adds the phase; the distance and how big the Moon looks, each against
its average ("30.9′, 0.7 % smaller than average"); which of its edges is tipped toward you
by libration ("more of its western edge, the Grimaldi side, by 4.8°"); how its axis leans;
when it is next nearest (perigee) and farthest (apogee), with a note when the coming full
Moon is a supermoon; and the named craters, mountains and valleys along its shadow line
now, where low sunlight shows their relief best. **See it up close** opens the Sky view on
the Moon.

Four tools fold out below the card:

- **When is it at…?** lists the times on the day shown when the body passes a **Height**
  you type — 30°, say, or −6° for the Sun at the end of civil twilight — or crosses a
  **Bearing**: degrees from true north, a compass point such as WNW, or a direction picked
  on the map. Pressing a time moves the clock there.
- **Sunrise or sunset along a line** (on the Sun and Moon cards) finds the days of a year
  when the Sun or the Moon sets, rises, or stands at a height you choose, along a bearing:
  down a street, through a window, over a landmark. Type the bearing, or press **Pick on the
  map** and click the point the line should run to, such as a street corner a few blocks
  away or a peak on the skyline: the bearing becomes the direction from your place to that
  point, measured on the Earth's true, slightly flattened shape, and the line is drawn on
  the map (**Layers** lists it, with **Remove**). Choose **Sets**, **Rises** or **At a
  height**, how far off the line still counts, and the year, and press **Find the days**.
  The closest day of each run is marked **best**; pressing a day moves the clock there. A
  search takes a moment (about a second for the Moon). For the Sun, **The Sun's bearings
  through the year** opens the chart of its rising and setting directions on every day
  ([Charts](#charts), Sun).
- **Milky Way planner** says when the bright core of the Milky Way (the direction of the
  galaxy's centre, in Sagittarius) is at least 10° up in a fully dark sky tonight, where it
  stands at its best and how the band arches across the sky, whether the Moon is up, and
  the best Moon-free nights of the coming month. **Show in Sky** opens the Sky view at the
  best moment.
- **Navigator's details** add the GHA, the declination, and Hc and Zn as sight-reduction
  tables give them: seen from the Earth's centre, with no refraction or parallax, so for the
  Moon they differ from its height above your horizon by up to a degree. They also give what
  **your sextant would read** now (Hs), for the height of eye and index correction in
  Settings on a sea horizon, for the bodies offered for sights; its tooltip lists the
  corrections that turn it into Hc.

When the US tide predictions are on your device (**Settings → Data packs**, "US tides"),
the **Place** section also gives the next high and low water at the nearest NOAA tide
station within 50 nautical miles, with **Tides chart**, which opens the Tides tab of
Charts. They are predictions, not observations: wind, storm surge and river flow are not in
them.

Far from today, where the Earth's rotation is known only roughly, every time on the card
carries its uncertainty ("20:15 ±12 min"), and the tools show the ± chip with its
explanation beside their headings (see [Moving through time](#moving-through-time)).

### Worked example: Manhattanhenge

Twice a year the setting Sun lines up with Manhattan's cross streets, which run about 29°
north of west (a bearing of 299°).

1. Put your place on a cross street with a view west: type `40.7527, -73.9772` (42nd
   Street at Fifth Avenue) in the search box.
2. With the Sun selected, open **Sunrise or sunset along a line** and type **299**, or press
   **Pick on the map**, zoom in, and click far down 42nd Street toward the Hudson.
3. Keep **Sets** and **0.5**°, and press **Find the days**.

For 2026 the list gives 23–26 May and 16–19 July, with **24 May** and **18 July** marked
best: the top of the Sun touches the horizon down the street at about 20:15 EDT in May and
20:23 in July. Press a day to see it on the map and the time bar.

Published dates differ by a few days because they mean other moments. The American Museum
of Natural History's "half Sun" is the Sun's centre on the horizon without the bending of
its light by the air: choose **At a height** and type **0.5** (that bending lifts the Sun
about half a degree near the horizon) and the best days become 28 May, the museum's date,
and 14 July. The real horizon at the end of a street is New Jersey's skyline, not a sea
level one; type its height instead. [Accuracy and limitations](ACCURACY.md), section 14,
compares the definitions.

## The views

The tabs along the top of the side panel (or, on a phone, along the top of the bottom
sheet — see below) switch between eight views: Map, Sky, Tonight, Charts, Navigate,
Almanac, Events and Learn. The place, the time and the selected body are shared across all
of them. [About](#about) has no tab: it opens from the **?** Help menu.

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
the Sun. A **South up** switch flips the dome for the southern hemisphere. **Zoom the dome**
with the mouse wheel, a pinch, the **+** and **−** buttons or keys, and drag to move around
a zoomed chart; fainter stars get their names and fainter deep-sky objects appear as you
zoom in, and **Whole sky** (or the 0 key) goes back. The stars are drawn only for 1550 to
2650; further from today the dome shows the Sun, the Moon and the planets against a bare
sky and says why. Everything on
this view is for looking and finding — see [Third-party sources](THIRD_PARTY.md), "Star
field and constellations" and "Deep sky" — and none of it ever affects a fix.

![The Sky dome at night over Philadelphia: stars, constellation figures, the ecliptic, and the Sun's position well below the horizon.](design/sky-night-philadelphia-dome.png)

**In a dark sky** the view also shows:

- **The Milky Way**, as a soft glow behind the stars: its brighter star clouds and its
  darker lanes follow NASA's COBE maps of the galaxy's light. It fades out as the sky
  brightens — in twilight, under a bright town sky — just as the real one does.
- **Deep-sky objects**: the 110 Messier objects and about a hundred of the brightest others
  (NGC and IC objects, the Hyades, the Magellanic Clouds), each labelled ("M31",
  "NGC 869") and drawn with the usual atlas mark, sized by how big the object looks:

  | mark | kind |
  |---|---|
  | ellipse | galaxy |
  | dotted circle | open star cluster |
  | circle with a cross | globular star cluster |
  | square | nebula (bright gas or dust, or a supernova's remains) |
  | circle with four spikes | planetary nebula |
  | dotted circle in a square | star cluster in a nebula |
  | diamond | star cloud, double star or asterism |

  How many are drawn follows the sky and the chart: on a laptop's whole-sky chart, those a
  pair of binoculars shows; zoomed in (the panorama narrowed), telescope objects too; on a
  phone's small chart, only the showpieces.
- **Meteor radiants**, while a shower is active: the point its meteors seem to come from,
  with the shower's name and how many meteors an hour to expect at best tonight (an
  estimate for your sky; meteors appear all over the sky, not only near the radiant).
- **Comets and asteroids you add** (below).

**Click anything** — a star, a planet, a deep-sky object, a radiant — for a card: what it
is, where it is now (height, bearing, and its right ascension and declination, the sky's
own coordinates), when it rises if it is below the horizon, and, for a deep-sky object, its
size, the **best time tonight** to see it and **what shows it** (the naked eye, binoculars,
a small telescope, or only a camera). These are estimates for the sky you set under
**Layers**, with the Moon's light taken into account, and the card says so. **Tonight's
ranking** lists the best-placed deep-sky objects of the night; choose one to see it on the
chart. Escape, or the card's ×, closes it.

**Find** (the magnifier on the left) takes any name or designation: "Vega", "alpha Lyrae",
"HR 7001", "M31", "NGC 224", "Andromeda", "Orion", "Perseids", "Jupiter". The first match
is shown on the chart — ringed on the dome, turned to in the panorama — with its card. The
search box at the top of the side panel finds the same things under **Sky objects**, below
the places, and opens this view on the one you choose.

**Show in Sky** elsewhere — on the **Tonight** page (a planet, a deep-sky object, a meteor
shower's radiant, the Milky Way's core), on the side panel's Selected card (the Milky Way
planner), and from the side panel's search — opens this view on it: the dome zooms in
three times if it showed the whole sky and centres on it, the panorama turns to face it,
and its card opens; from Tonight, at the moment it is best seen. Tonight's and the Moon
card's **See it up close** open the Moon's close-up the same way. **Whole sky** (or 0)
goes back to the whole dome.

**See it up close.** The card of the Moon or a planet has **See it up close** (so does a
second click on the selected Moon or planet, and the Moon card in the side panel):

- **The Moon**: its phase, its seas, and the craters, mountains and valleys along the
  shadow line, where the low Sun shows their relief best (the side panel's list is ringed).
  The Moon rocks a little as it orbits (libration): the dashed lines are its equator and
  central meridian, and how far they sit from the middle of the disc shows which edge is
  tipped toward you.
- **Jupiter**: its four large moons on a line, named, with any moon crossing Jupiter's face,
  hidden behind it or in its shadow, and the moons' shadows on its clouds.
- **Saturn**: its rings at their true tilt and size, the near side of the rings passing in
  front of the globe.
- **Mercury, Venus, Mars, Uranus, Neptune**: their phase and size.

Turn the picture **as seen** from here (the zenith up), **north up** (the sky as the eye and
binoculars show it), or **south up** (an astronomical telescope), and **Mirrored** for a
telescope with a star diagonal.

**Field of view** (the circle with a star) draws how much of the sky a naked eye (about
50°), binoculars (7×50: 7.1°; 10×50: 6.5°), a small telescope (about 1°) or a camera takes
in: for a camera, type the lens's focal length and choose the sensor ("Camera 50 mm ·
40° × 27°", held level). It sits round the selected object and follows it, or in the
middle of the view. The fields are typical figures: the one printed on your binoculars or
eyepiece is the one to trust.

**Layers** (top right) switches the figures, names, boundaries, the Milky Way, deep-sky
objects, meteor radiants and added bodies on and off, and the lines: the height-and-bearing
grid, the **right ascension and declination grid** (hours along the celestial equator,
declinations up the meridian), the meridian, the celestial equator and the ecliptic. Under
**How dark is your sky**:

- **Automatic** — a dark site, where only twilight hides the stars (the view as it always
  was);
- **Bortle class** — Bortle's nine classes, from 1 (an excellent dark site, stars to about
  magnitude 7.8 overhead) to 9 (an inner-city sky, about 4);
- **Faintest star** — the faintest star you can see overhead, if you know it.

The line underneath says what the view draws down to now, overhead and 20° up.
**Dimmer toward the horizon** fades stars, deep-sky objects and the Milky Way low in the
sky, where their light crosses much more air (about a magnitude at 10° up). The deep-sky
card, tonight's ranking and the meteor rates use the same sky.

**Comets and asteroids.** In **Layers**, **Add from orbital elements…** takes lines copied
from the Minor Planet Center (its MPCORB and comet formats) or elements typed as JSON
(**Example** fills in Ceres). They are drawn with their names, followed as time moves, and
described by their card, with the credit "Source: Minor Planet Center" where it applies.
Their places follow the orbit alone, without the planets' pull, so they drift from the real
body as the elements age (the card warns past 30 days); good for finding one, not for
timing it. They are kept for this visit only.

**Tonight's star sights**: while the side panel shows its list of tonight's bodies to
shoot, the Sky view rings them with a dashed circle, so you can find them before twilight.

**Save the sky as a picture** (the arrow into a tray) saves the chart as it is on screen —
its layers, its theme, night vision included — with a caption: the place, the time, what
the view shows, and the site's line. It stays on your device.

### Tonight

One page for the night at your place, for anyone going out to look: when it gets dark,
the Moon, the planets, the best deep-sky objects, meteor showers, the Milky Way, the next
two weeks' events, the nearest tide station and the photographers' golden and blue hours.
The darkness window and the Moon work for the full 2000 BC to AD 3000; the planets, the
deep-sky ranking, meteor showers and the Milky Way's best moment are worked out only for
1550 to 2650, and the page says so plainly rather than leaving those lines blank when you
are further from today than that.

**Which night.** A night runs from one local noon to the next (noon by the Sun at your
longitude, as the deep-sky engine counts it). The page shows the night the explorer's time
belongs to: in the afternoon and evening, the night ahead; after midnight, the night still
going on while it is dark, and the coming one as soon as its darkness is over — at
astronomical dawn, when the Sun climbs back above 18° below the horizon. Where the Sun
never gets that low (summer at high latitudes) the switch comes when the darkest stretch
ends, with no darkness at all at sunrise, and in the midnight sun at local midnight.
(The deep-sky engine on its own switches at sunrise; the page chooses the night itself and
asks the engine about that night.) A moment chosen on the page keeps its night: a planet
best seen "as dawn comes" takes you past astronomical dawn, and coming back you still see
the night you chose it from, until the time is moved some other way. **◀ ▶** step a night — they move the explorer's time,
so every other view follows — and **Tonight** comes back to the real night, following the
clock. The heading says "Tonight", "Tomorrow night" or "Last night" against the real date,
and "The night of" otherwise.

- **The summary** under the date says it in sentences: "Clear-sky darkness 20:25–05:21
  (8 h 56 min). The Moon, a day before full (97% lit), sets at 05:37. Planets: Mars and
  Jupiter in the morning; Saturn from 20:21." An eclipse seen from your place is named
  with what you would see of it (a partial solar eclipse "7% of the Sun covered here").
  "Clear-sky" because the weather is not known here.
- **The night** is a bar from an hour before sunset to an hour after sunrise: the sky's
  twilight bands, golden and blue hour, when the Moon is up, when the Milky Way's core is
  10° or more up in full darkness, and the moonless darkness best for faint objects.
  Click anywhere on it to move the explorer's time there; **Every moment of the night**
  lists sunset, each twilight, moonrise and moonset, the core's best moment and the rest
  as times you can press (the way to use the bar from the keyboard).
- **Moon**: its phase drawn as it looks from your place (south up south of the equator),
  how much of it is lit and how far from the nearest quarter, its rise and set, its
  distance, the moonless part of the darkness, a note when the nearest new or full Moon is
  a supermoon or a micromoon, and, while it is up at night, the named craters and ranges
  best seen along the line between lunar day and night. **See it up close** opens the Sky
  view on it.
- **Planets**: each planet 10° or more up while the Sun is 6° down, where to look and
  when — "Jupiter, east, rises 22:10, highest 03:40 at 61°, magnitude −2.7" — with the
  moments of Jupiter's moons you can watch (a moon passing behind the planet or into its
  shadow) and how far Saturn's rings are open. Press one to see it in the Sky view.
- **Deep sky**: the eight best-placed clusters, nebulae and galaxies tonight, then eight
  more at a time, each with its type, brightness, constellation, best time and height,
  what to see it with (naked eye, binoculars, a small telescope, a camera), a line about
  it and how much the Moon washes it out. **Your sky** sets how dark your sky is, from a
  dark site (Bortle 1) to a city centre (Bortle 9), and the ranking follows. It is the same
  setting as Settings → Sky, the Sky view's **How dark is your sky** and the meteor
  showers' in Events, and it is remembered on your device. **Show in Sky** opens the Sky
  view at the object's best moment.
- **Meteor showers** active tonight: the rate you might see under your sky (an estimate:
  the shower's ZHR, cut by the radiant's height and by the faint meteors your sky and the
  Moon hide), the best time, where the radiant is, and whether the Moon is up then.
- **Milky Way**: when the core is up in full darkness, its best moment and where the arch
  of the Milky Way runs across the sky then. **Plan a photo** goes to that moment and
  opens the Milky Way planner on the panel's Selected card (the best nights of the month).
- **Coming up**: the next fourteen days — Moon phases (and supermoons), the Moon at its
  closest and farthest, eclipses and what your place sees of them, the Moon and planets
  passing close to each other or to bright stars (the moment they are best seen from your
  place), the Moon hiding a star or a planet, meteor-shower peaks, oppositions, a planet
  standing still before or after its backward loop, equinoxes and solstices, the Earth
  closest to or farthest from the Sun, transits of Mercury and Venus. Press one to open
  Events at that moment.
- **Tides**: where a NOAA tide station may be within 100 nautical miles, the nearest
  station's high and low water through the night — predicted, not observed. The stations
  come in the optional US tides data pack; the card offers it with its size, and nothing
  is downloaded unless you ask (see [Working offline](#working-offline)). **Tides chart**
  opens the station's curve in Charts.
- **Photography**: golden hour and blue hour this evening and tomorrow morning.

**Print** makes a one-page sheet of the night (the explanations and buttons stay on the
screen). Every time on the page is on your display clock with UTC in its tooltip; for dates
whose clock time is uncertain (far in the past or future) the ± chip beside a time says by
how much. Rankings, meteor rates and limiting magnitudes are estimates from stated rules,
and the page says so where it shows them.

### Charts

Six tabs of charts, each also available as a plain table (**View as** → **Table**, top
right), and each with a **Save** menu (see [Saving, printing and sharing a
chart](#saving-printing-and-sharing-a-chart) below). The place and the time are the
explorer's own: clicking a time or a day on any chart moves the whole explorer there.

- **Day**: the height of each body through the day, over the twilight bands.
- **Year**: sunrise, sunset and twilight for every day of the year, with the Moon's phase
  along the top.
- **Sun**: five charts of the Sun, chosen from the second row of tabs.
  - **Sun path**: the Sun's path across the sky today, with its hours marked, between its
    paths on the June and December solstices and at the equinoxes; every day's path lies
    between the two solstices. **From above** shows the sky dome as a map does, north up,
    the zenith in the middle and the horizon round the edge; **Along the horizon** shows
    bearing across and height up, as you see it facing the equator. Sunrise and sunset are
    marked with their times; click the path to go to that moment.
  - **Analemma**: where the Sun stands at one clock time — 12:00 unless you choose another
    — on every day of the year: the figure-8 a camera fixed to one spot would record.
    **Local mean time** is the clock of your longitude (at 12:00 the figure sits on the
    meridian); **Zone time** is your zone's standard time all year, what a watch without
    daylight saving reads. The first of each month is marked, and the explorer's date.
  - **Sunrise bearings**: where on the horizon the Sun rises and sets on every day of the
    year (north up in both panels), and how high it stands at solar noon.
  - **Equation of time**: how far a sundial runs ahead of or behind the clock through the
    year (up to about 16 minutes either way), and how far north or south of the equator
    the Sun is overhead (its declination). The navigator knows both from the almanac.
  - **Solar panel**: a **clear-sky estimate** of the sunlight reaching a panel, day by day
    through the year and hour by hour on the explorer's day, for a tilt and a direction
    you choose (it starts tilted at your latitude, facing the equator). It gives the year's
    total, the same on flat ground, and the tilt that would collect the most, with a
    button to use it. Clouds are not modelled, nor haze, snow, shading, dirt, heat or the
    panel's own efficiency: the numbers are the ceiling on a clear day, not a forecast, and
    the page says so beside every one, with the model's typical error.
- **Moon**: **Phases** is a monthly calendar with each day's Moon, moonrise and moonset,
  and the days the Moon is **nearest** (perigee) and **farthest** (apogee), with the
  distance; supermoons and micromoons are marked on their full Moons. **Through the
  year** shows how high the Moon stands, and in which direction, at one hour of the
  evening (21:00 unless you choose another) on every day of the year: it comes back to
  the same part of the sky only about once a month.
- **Planets**: when each planet is up in the dark, through the year.
- **Tides**: predicted high and low water and the tide curve for the day or the week at
  the US tide station nearest your place, or another of the twelve nearest, with the
  explorer's time as a moving cursor and night shown along the bottom. Heights are above a
  datum you choose — mean lower low water (MLLW, the chart datum of US charts) unless you
  choose another the station has. **Show on the map** marks the station on the map; a link
  opens NOAA's own page for it. Tides are **predictions, not observations**: weather,
  surge and river flow are not included, and the page says so. They come from NOAA's
  harmonic constants for its 3 499 US stations, an optional data pack of 0.34 MB that the
  tab offers to download the first time (see [Working offline](#working-offline)); some
  stations give only high and low water, and the curve between is then an estimate,
  drawn dashed. Predictions are offered for 1900 to 2100.

![The Year chart: a whole year of sunrise, sunset and twilight bands for Philadelphia, with the solstices, equinoxes and Moon phases marked.](design/charts-year-light.png)

#### Saving, printing and sharing a chart

Every chart's **Save** menu offers:

- **Save picture (PNG)**: the chart as you see it, always in the light colours so it
  prints and reads anywhere, with a caption underneath saying what it shows, for where and
  when, what the numbers are and how far to trust them.
- **Save table (CSV)**: the chart's Table view as a spreadsheet file. Angles are decimal
  degrees and heights plain numbers (the column headings give the units); the first lines,
  starting with `#`, say what the file is.
- **Print**: this chart alone, as wide as the page (across the page when the chart is wide).
- **Share picture…**, on phones and tablets that have a share sheet.

Files are made in your browser and saved or shared only when you choose; nothing is sent
anywhere.

### Almanac

The printed Nautical Almanac, computed for any date the explorer covers and laid out the
way the book lays it out. Five tabs:

- **Daily pages.** **Three dates** shows an *opening* of the printed almanac: two facing
  pages covering three days (7, 8 and 9 March; the book groups each year in threes from
  1 January). The left page has GHA and declination for Aries and the four navigational
  planets at every hour of the three days, the 57 navigational stars plus Polaris, and
  the planets' SHA; the right page the Sun and the Moon every hour (with the Moon's v, d
  and HP), twilight, sunrise and sunset for the middle day and moonrise and moonset for
  four days across 31 standard latitudes, and the equation of time, meridian passages and
  the Moon's age and phase for each day. **One date** shows a single day on two pages,
  larger on screen. The row of the explorer's current hour is marked. The date box takes
  any year: type `1066`, or `585` with **BC** chosen (or `585 BC`, `−584`); dates before
  15 October 1582 are in the Julian calendar, as in the time bar, and the calendar box
  can force either calendar. Before 1767, the year of the first Nautical Almanac, the page
  says it shows what the book *would* have printed. On estimated years the ± chip beside
  the heading gives the uncertainty of every clock time on the page.
- **Increments.** Increments and Corrections, two minutes to a page as printed: what to
  add to the hour's GHA for the minutes and seconds after it (Sun and planets, Aries, the
  Moon), and the v and d corrections. **Look up** takes a time such as `58:27` and a v or
  d and gives the numbers a navigator would read.
- **Altitude corrections.** The book's inside-cover tables: the Sun (October–March and
  April–September), stars and planets, and dip for 10° to 90°; the table for 0° to 10°;
  the extra correction for unusual temperature and pressure with its zone chart (type a
  temperature and pressure for your zone and the exact corrections); Venus and Mars for
  the year shown; and the Moon's two-part table.
- **Polaris.** The Pole Star tables for the year shown: a0, a1, a2 and Polaris' bearing.
  **Look up** takes LHA Aries, your latitude and the month and adds the three terms:
  latitude = observed altitude − 1° + a0 + a1 + a2.
- **Arc to time.** Degrees and minutes of arc as hours, minutes and seconds.

Every table has a sentence on how to use it and a worked example, most of them the
examples in *The American Practical Navigator* (Bowditch). **Print** prints the tab's
pages black on white, one page to a sheet, on A4 or US Letter, whatever the theme; on the
Increments tab **Print all 30 pages** prints the whole table. The tables are computed with
the project's own corrections, so a navigator using them gets what Navigate gets; where
the printed book's own formulas differ, an entry can differ from the book's by 0.1′
([Accuracy and limitations](ACCURACY.md), "Almanac pages" and "Almanac tables and
three-day pages"). The daily pages are the same computation as `skyfix almanac` on the
command line ([Command line](CLI.md)).

<!-- verify2 -->
**One star differs from the printed book on purpose: Rigil Kentaurus.** It is α Centauri A,
which circles its companion every 80 years. The printed Nautical Almanac and USNO's online
almanac carry A along the straight line of its 1991 motion; the explorer follows the orbit.
Radio positions of A measured by ALMA in 2018 and 2019 agree with the explorer's to 0.1″ and
are 4.6″ from the straight line. So Rigil Kentaurus's SHA and declination here differ from
the book's by about 0.1′ in 2026, growing to about 0.3′ by 2060: that much on a line of
position if you work the same sight both ways. The difference is the book's, and it is the
only star where the two disagree by more than a few hundredths of an arcminute. Neither
models what a sextant sees, the combined light of A and B, about 2″ from A in 2026
([Accuracy and limitations](ACCURACY.md), "Rigil Kentaurus").

When **Settings → Sights → Air** is not the standard 1010 hPa and 10 °C, the Altitude
corrections tab starts its temperature and pressure from it, so the extra correction's zone
and exact values are for the same air as the heights, the predicted reading and tonight's
sights; the printed tables stay at the standard air, as the book's do.
<!-- /verify2 -->

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

Sights are offered only between 1550 and 2650, the span the almanac is validated for;
outside it the sight form says why and does not add the sight, and Tonight's sights, the
planner and the Compass tab's bearings say the same. Between 2000 BC and 1550, and
between 2650 and AD 3000, positions are shown — labelled as historical or far-future
estimates — but a sight cannot be worked from them. Type a sight's date in the calendar
the page shows: before 15 October 1582 that is the
Julian calendar (unless Settings → Calendar says ISO). Times read **UTC** from 1972 to 2035
and **UT** outside, and a **± chip** beside a sight's time means the Earth's rotation then is
known only that well: every fix's longitude moves with it, 15″ for each second.

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

What happens in the sky and when, as lists you can click. Five tabs:

- **Eclipses** — every solar and lunar eclipse of the next (or last) ten, hundred or
  thousand years, with a switch for "seen from here"; a long list fills in as it is found
  and shows its rows a page at a time. Pick one to read, in plain words, what you would see from
  your place: whether you are inside the path of totality, when it starts and ends, how
  much of the Sun is covered, and how high it stands. **Show on the map** draws the path
  of totality (or annularity), its central line and the limits of the partial eclipse;
  **Go there** moves your place and time to the point of greatest eclipse. Solar eclipse
  cards carry an eye-safety note. The times are for a smooth Moon unless the **Lunar limb**
  data pack is on your device (2.2 MB; offered once, the first time you open a solar eclipse
  seen from your place, and in Settings → Data packs): then the card's times are
  corrected for the mountains and valleys at the Moon's edge and marked **limb-corrected**,
  with how far each moved — a second or a few, more at the edge of the path — and when and
  where on the Sun's edge **Baily's beads**, the last and first sunlight through the
  Moon's valleys, should show. The beads are approximate, and the list keeps the smooth
  Moon's times.
- **Moon** — three lists.
  - **Phases** for the coming months, with links to any eclipse they bring.
  - **Perigee and supermoons**: the Moon at its closest and farthest on each orbit, every
    full Moon with how much larger or smaller than average it looks, the supermoons and
    micromoons, and the year's largest and smallest full Moon. A supermoon here is a new or
    full Moon at least 90% of the way from apogee to perigee (Nolle's rule): about a third
    of them are, so stricter lists elsewhere are shorter.
  - **Occultations**: the bright stars (to magnitude 3.5) and the planets the Moon passes
    in front of as seen from your place — when each disappears and reappears, at which edge
    of the Moon (a star winks out at once at the dark edge, the easiest to time), how high
    the Moon stands and whether the sky is dark. Grazes, where a star runs along the Moon's
    edge and may blink among its mountains, and near misses are marked. Pick one to see the
    Moon drawn as you will see it, with the points of its edge where the star goes in and
    comes out, and the times to the second. **Also not seen from here** adds those that
    happen with the Moon below your horizon and those seen only elsewhere on Earth, with the
    part of the Earth that sees them. Times are for the Moon's mean edge: its mountains move a
    contact by seconds, and by up to a minute near its poles.
- **Planets** — five lists.
  - **Highlights**: oppositions, conjunctions with the Sun, greatest elongations of Mercury
    and Venus, and closest approaches.
  - **Close approaches**: planets passing each other, the Moon passing the planets and the
    bright stars on its path, and planets passing those stars, within 5°: how close, which
    way, whether they are far enough from the Sun to be seen, and when they are best seen
    from your place (both up and the sky dark). A pass marked **Hidden from some places** is
    an occultation for part of the Earth.
  - **Retrograde**: when each planet seems to stop against the stars and turn back (a
    station), and when it turns forward again, with a timeline of the year's retrograde loops
    and the ones under way.
  - **Transits**: Mercury and Venus crossing the Sun's face in the next (or last) hundred
    years. Pick one for its path across the Sun, drawn as the Sun appears with north up, the
    contact times at your place with the Sun's height at each, and the eye-safety note.
  - **Jupiter's moons**: the transits, shadows, eclipses and disappearances of Io, Europa,
    Ganymede and Callisto, night by night for a week, with Jupiter's rising and setting and
    the hours of darkness, and for each event whether you can see it from your place
    (Jupiter at least 5° up, the Sun at least 6° down) and why not when you cannot.
- **Meteors** — the year's meteor showers as a calendar: when each is active and peaks, its
  zenithal hourly rate (ZHR, the rate under a perfect sky with the radiant overhead), how
  bright the Moon is at the peak, and the rate to expect at your place on the peak night,
  with the hour it is best; above the list, what the night of the time shown offers.
  **Your sky** chooses how dark your sky is, from a dark site to a city: the same setting as
  Tonight's and the Sky view's. The rates are estimates from a simple model and say so: real
  showers vary from year to year.
- **Seasons** — the equinoxes and solstices, worded for your hemisphere, and the Earth's
  perihelion and aphelion (closest to and farthest from the Sun, about 3% apart: the
  seasons come from the tilt of the Earth's axis, not from the distance).

Clicking any event moves the explorer's time to it and selects the body concerned.

**Saving events.** Every list has a **Save** menu. **Add to a calendar** makes a calendar
file (`.ics`, the iCalendar standard every calendar program imports) of the events listed,
each with a sentence saying what it is, and for times that hold only at your place, the place
— unless you untick **Name the place in the files**. **Save as a table** makes a CSV file
for a spreadsheet, every row with its time in UTC (or UT) beside your local time. The small
calendar button beside each event saves that one alone. Where your device's share sheet
takes calendar files, **Share to a calendar…** hands the file to it. The files are made in
the page; nothing is sent anywhere. Saving an event again, from any place, replaces its
entry in your calendar rather than adding a second one. A calendar file cannot hold a date
before AD 1.

**Far dates.** The lists say which years the engine covers now, and a list that reaches its
edge says where it stops and, when the site offers one, has a button for the data pack that
extends it. Far from the present the Earth's rotation is known only roughly, so a clock time
then carries its uncertainty (the ± chip, see [Moving through time](#moving-through-time))
and the list says why. Lists that take the engine a while — a year of close approaches is
about a second — fill in as they are found, with a progress line, and wait while you drag
the time bar.

The eclipse list agrees with NASA's eclipse canon for every eclipse of 1990–2060;
occultation contacts agree with Skyfield's within 1.4 s at the mean limb, transit contacts
with NASA's within 5 s, close approaches within 5 minutes and perigees within 11 s; the
"seen elsewhere" rule for occultations is checked against the engine's own local search
(see [Accuracy and limitations](ACCURACY.md), "Eclipses", "Planet events", "Moon in detail",
"Planet detail" and "Events view"). From a terminal, `skyfix events`, `skyfix phases` and `skyfix seasons` give the day's events, the
Moon's phases and the seasons; `skyfix eclipses` lists the eclipses and what your place sees
of each, `skyfix eclipse` gives one eclipse's contacts from your place and its path (as
GeoJSON for any map tool), and `skyfix planet-events` the planets' oppositions, conjunctions,
elongations and closest approaches (see [Command line](CLI.md)).

![The Events view: the total solar eclipse of 8 April 2024 as seen from Dallas, with its timeline and contact times.](design/events-eclipse-light.png)

### Learn

Ten guided demonstrations of what a fix is worth and is not, an illustrated primer on how
celestial navigation works, and the coverage simulator — see
["Celestial navigation in five minutes"](#celestial-navigation-in-five-minutes) below.

### About

What the page is, where every number comes from, and a table of how closely each part
(the Sun, the Moon, the planets, the stars) has been checked against an independent
reference ephemeris, and for which years — the checked years and the estimated ones — with
which are validated for real sights, and a short table of how far a clock time can be
trusted in each age (the uncertainty in the Earth's rotation, from an hour at 2000 BC to
under a second today). It also explains, in one
place, what happens to your chosen place (nothing, unless you press Share), links this
manual and the source code, and credits the map, star and font data. It also links the
manual's page of every data source and its licence. The **?** Help menu has the same links
to the manual and the source code. About has no tab of its own: **About SkyFix Lab** in the **?** Help
menu opens it, and so does the address `#about`.

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
`6:40 PM`; UTC always stays on the 24-hour clock, as navigators write it); the
**calendar** for dates before 15 October 1582 (the Julian calendar people then used, or
the Gregorian calendar carried back, as ISO 8601 has it) and how **years** are written
(`585 BC`, the astronomers' `−584`, or ISO's `-0584`); how angles are
written (`26° 02.3′`, `26° 02′ 17″`, or `26.038°`); units (metric, nautical, or
imperial); whether rise and set are figured for a sea-level horizon or dipped for your own
height of eye; and a **Navigator's terms** switch that shows the navigator's word beside
the plain one everywhere on the page ("Height above horizon · altitude"). Under **Sights**,
beside the height of eye and the index correction, **Air** takes the air pressure and
temperature (1010 hPa and 10 °C unless you change them): they scale the bending of light
near the horizon in every height the page shows, the predicted sextant reading, tonight's
sights and a new Navigate session. Under **Sky**, **Your sky** says how dark your sky is
(automatic, meaning a dark site, or one of Bortle's nine classes): the Sky view draws the
stars you could see, and Tonight's ranking and the meteor rates assume the same sky. All of
these are remembered on your own device. Your chosen place never is. **Data packs**, at the
bottom, lists the optional data this site offers, its size, where the page uses it, and a
**Get** or **Remove** button (see [Working offline](#working-offline)).

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

## For astronomers, in five minutes

New to the site, and here for the sky rather than the sextant? Five stops:

1. Open **Tonight** (see [Tonight](#tonight)) for your place. It reads like a page written
   for you this evening: when it gets properly dark, the Moon, which planets are up and
   when, the night's best deep-sky objects for the sky you actually have, any meteor
   shower active, and whether the Milky Way's core clears your horizon in the dark.
2. Press **Show in Sky** on anything there to see it on the chart (see [Sky](#sky)): the
   real stars and constellation figures, the Milky Way as a soft glow, and the deep-sky
   objects sized and marked the way a star atlas marks them. **Find** (the magnifier) takes
   any name — a star, "M31", "Perseids" — and **Layers** turns on the RA/Dec grid, a
   field-of-view circle for your own binoculars or telescope, and how dark a sky to assume.
3. Click a planet or the Moon and press **See it up close** for Jupiter's moons and belts,
   Saturn's rings at their true tilt, or the Moon's terminator and named features — the
   same inset the Moon and planet cards in the side panel open.
4. Open **Events** (see [Events](#events)) for what is coming: eclipses, occultations,
   conjunctions, meteor-shower peaks, transits. Everything there can be saved to your own
   calendar or as a table.
5. **Charts → Sun** and **Charts → Moon** (see [Charts](#charts)) turn a year of positions
   into one picture: the analemma, the Sun's path, how high the Moon stands through the
   year.

Nothing here is a sight or a fix — it is all for looking and finding, never for steering by
— so none of it needs the navigator's vocabulary at all; **Navigator's terms**, in
Settings, is off by default for exactly that reason.

## For photographers, in five minutes

Here for golden light and the right alignment, not the numbers behind them? Five stops:

1. Set your place (see [Setting a place](#setting-a-place)), then look at the thin strip
   along the time ribbon's top edge: it marks **golden hour** and **blue hour** for today
   (see [Moving through time](#moving-through-time)). Select the Sun and the side panel's
   card gives both, morning and evening, with the length of the day.
2. **Sunrise or sunset along a line**, folded out under the Selected card (see [The
   selected body](#the-selected-body)), finds the days of the year the Sun (or the Moon)
   rises, sets, or stands at a height you choose, along a bearing you type or pick on the
   map — down a street, over a skyline. The worked example is exactly this: [Manhattanhenge](#worked-example-manhattanhenge).
3. **Milky Way planner**, on the Moon or a dark-sky night, gives the best moment the
   galactic core clears your horizon in full darkness, which way its arch runs, and the
   best Moon-free nights of the month; **Tonight**'s own Milky Way line does the same for
   this evening with **Plan a photo**.
4. **Charts → Sun** (see [Charts](#charts)) has the sun path, the analemma (the figure-8 a
   fixed camera would record at one clock time all year), sunrise and sunset bearings
   through the year, and the equation of time; **Charts → Moon**'s "Through the year" shows
   where the full Moon sits at one evening hour across the seasons.
5. **Save the sky as a picture** on the Sky view keeps the chart itself, with a caption
   saying what it shows and when; every chart's own **Save** menu makes a captioned PNG the
   same way (see [Saving, printing and sharing a chart](#saving-printing-and-sharing-a-chart)).

Bearings here are the true ones a compass rose or a chart gives; a place picked on the map
uses the real, slightly flattened Earth, not a sphere, so a line aimed at a landmark a few
blocks or a few miles off points where that landmark actually is.

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
