# Map and Globe views (`web/src/next/map/`)

Owner: map agent. The explorer's home view (EXPLORER_PLAN §2): an offline world map where
a click (a long press on touch) sets the observer, with a SunCalc-style compass dial
centred exactly on the observer, day/night and twilight shading, ground points, circles of
equal altitude, a graticule, a measuring tool, and overlays drawn by other views. The look
is the approved design (`docs/design/map-light.png`); screenshots of this implementation are
`docs/design/map-*.png` (`web/scripts/map-screenshots.mjs`).

## Mounting

```ts
import { mapView } from '../map/index.js';
const mounted = mapView(host, ctx); // for view === 'map' and view === 'globe'
```

One component serves both views: `view === 'globe'` switches MapLibre to its globe
projection, `'map'` to Mercator, any other view leaves it alone (so it may stay mounted
behind another view). The page must load the design system first (`theme/index.ts`).
`createMapView({ controls: false })` leaves out the map's own stage controls (projection,
layers, zoom, "your place", measuring, legend) if the shell draws its own; the data credit
(and the OpenStreetMap credit while street tiles are shown) always stays.

What the map reads from the store: `observer`, `time.jd_utc`, `selection.body`, `view`,
`layers.*`, `settings.{units, angleFormat, horizon, height_of_eye_m, timeDisplay}`. What it
writes: `observer` (click, drag, "set to the map centre"), `selection.body` (a click on a
ground point), `view` (Chart/Globe), `layers.*` (its layer list).

Setting the observer names the place from the gazetteer ("near Philadelphia, Pennsylvania,
United States", "At sea, 32 NM SE of …") and guesses the time zone, **unless the zone is
the person's own choice**: `{kind: 'utc'}` or `{kind: 'iana', zone, guessed: false}`
(`place.ts`, `zonePinned`). A zone that came with a place (the default, a share link, a
place search) is re-guessed when the observer moves. **Panel authors: write
`guessed: false` when the person picks a zone by hand**, and `guessed: true` for
"automatic".

## The map service (for Navigate, Events and others)

```ts
import { mapServiceFor, circleOfPositionFeature, ellipseFeature } from '../map/index.js';

const map = mapServiceFor(ctx);               // one per page (per store); exists without a map
map.addOverlay('fix-cops', {
  type: 'FeatureCollection',
  features: cops.map((c) => circleOfPositionFeature(c.gp, c.zenith_distance_deg, { label: c.body })),
}, { color: '--body-sun', dash: '--dash-circle', labelProperty: 'label' });
map.addOverlay('fix-ellipse', ellipseFeature(fix, e.semi_major_m / 1852, e.semi_minor_m / 1852, e.orientation_deg),
  { color: '--accent', fillOpacity: 0.18, z: 1 });
map.fitOverlay('fix-cops');                   // camera: applied now, or when the map mounts
map.removeOverlay('fix-ellipse');
```

- `addOverlay(id, geojson, style?)` draws or replaces an overlay. `id`: 1-64 letters,
  digits, `-`, `_`. Any GeoJSON object (collection, feature or bare geometry), `[lon, lat]`,
  within ±180; polygons fill, lines and polygon outlines stroke, points get dots.
- `OverlayStyle`: `color` and `fill` (a token such as `'--body-moon'` or `'var(--event-set)'`,
  which follows the theme, or any CSS colour; default `--accent`), `width` (px, 2),
  `dash` (`'--dash-circle'`-style token, pixel lengths, or `'solid'`), `fillOpacity`
  (0.15; 0 = outline only), `pointRadius` (5), `labelProperty` (a feature property shown
  along lines and beside points), `casing` (dark outline, true), `z` (stacking among
  overlays). Overlays draw above the basemap, shading and circles, under the measuring
  lines; ground points and the dial are above them.
- `removeOverlay(id)`, `hasOverlay(id)`, `overlays()`, `subscribe(listener)`.
- Camera: `fitOverlay(id, {padding, maxZoom})`, `flyTo(position, zoom?)`.

Geometry that is safe across the antimeridian and round the poles (`overlays.ts` over
`geometry.ts`): `circleOfPositionFeature(gp, zenithDistanceDeg)`, `capFeature(center,
radiusDeg)` (a filled cap: "where the Moon is up now"), `areaFeature(ring)` (an eclipse
path's outline; must not enclose a pole), `pathFeature(points)` (densify great circles
first, e.g. `geo/greatcircle.ts`), `ellipseFeature(center, semiMajorNm, semiMinorNm,
orientationDeg)`, `pointFeature(position)`. Lower level: `geometry.ts` (`smallCircle`,
`capPolygon`, `circleLine`, `splitLine`, `polygonPieces`, …).

## Files

| File | What |
|---|---|
| `map-view.ts` | The component: MapLibre map, store wiring, observer marker, picking, measuring, camera, layers, per-frame redraw |
| `style.ts` | The MapLibre style built in code from the Natural Earth files and the theme; the optional OpenStreetMap layer |
| `style-tokens.ts` | The one place theme tokens are read as values (for WebGL paint) |
| `fonts.ts` | Map label fonts: the site's own Inter files, drawn locally by MapLibre (no glyph server, no PBFs) |
| `compass.ts`, `skyproj.ts` | The dial (DOM/SVG) and its pure geometry: orthographic sky projection, paths above the horizon, the solstice band, the Moon's bright limb |
| `geometry.ts` | Pure spherical geometry: small circles, caps across the antimeridian and poles, twilight bands, graticule |
| `world.ts` | Shading, terminator, circle of equal altitude and altitude rings from one `sky_state` |
| `groundpoints.ts` | Ground-point markers with the design system's glyphs |
| `measure.ts`, `format.ts` | Great circle and rhumb line; number formats |
| `place.ts` | Naming a position and guessing its zone |
| `overlays.ts`, `overlay-layers.ts` | The map service and how overlays become MapLibre layers |
| `controls.ts`, `map.css` | Stage controls (design-system primitives) and the dial's styles |
| `dev/` | The developer page `web/next/dev-map.html` (address options in `dev-map.ts`) |

## Honesty and data rules

- Every position is the engine's (EXPLORER_PLAN §3.1): the dial uses `sample_bodies`
  (apparent altitude, 5-minute steps) and `day_events`; the ground points and the shading
  come from `sky_state` `gp`; the circle of equal altitude uses `hc_deg`, so it passes
  exactly through the observer on the reference sphere. The map only projects.
- Offline: the basemap, gazetteer and fonts ship with the site. The only network use is
  the optional OpenStreetMap layer: off by default, credited while shown, maximum zoom 19,
  no prefetching (OSMF tile policy). A service worker must not cache those tiles.
- Night theme: every map colour is a red token; with the street layer on, the whole map
  canvas goes through a red-only colour filter.

## Performance

Per frame while time is scrubbed: one `sky_state` (shared through the memoised engine),
the four shading caps (180 vertices each), the terminator, circle and ring lines when those
layers are on, ten ground-point markers and the dial's "now". `sample_bodies` and
`day_events` run only when the local day, the observer, the selection or the zone change;
the solstice paths once per year and place. Measured numbers are in the map agent's report.
