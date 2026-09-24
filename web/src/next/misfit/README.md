# Residual heat map (`web/src/next/misfit/`)

Owner: misfit agent. How badly every nearby position fits the sights, as a picture:
ambiguity basins and weak geometry at a glance (the Celestial Navigator app's "residual heat
map"). The numbers come from the core, `engine.misfit.misfitGrid` (`skyfix_core::misfit`,
wire format in docs/EXPLORER_API.md, "Misfit grid"); this folder only contours, colours and
publishes them. Developer page: `/next/dev-misfit.html` (every packaged demo); screenshots
`docs/design/misfit-*.png`.

## 1. Get a grid

```ts
const misfit = ctx.engine.misfit;            // undefined if the core predates the exports
if (misfit) {
  const grid = misfit.misfitGrid(session, 'auto', solveOptions, null, 200, 200);
}
```

- Pass **the same session, mode and `SolveOptions` you pass to `solve`**: the map is of that
  solve (its shared bias, its final robust weights, its minima). `bounds = null` frames the
  answer automatically (`misfitDefaultBounds` says how and why); give a
  `{south_deg, north_deg, west_deg, east_deg}` to map what your chart shows (it may cross the
  antimeridian: `east_deg` below `west_deg`, or above 180).
- 2 to 1024 nodes per axis. 200 x 200 is plenty for a chart panel: about 15 ms of grid in
  WebAssembly for 10 sights, plus the solve the call makes (about 29 ms for 10 sights).
  Call it when the result changes, never per frame.
- `grid.chi2` is a `Float64Array`, row-major, **south row first**. `grid.min` is the best
  point (polished, so exact even on a coarse grid); `grid.levels` are the 1-sigma, 95 % and
  3-sigma lines as absolute chi-square values; `grid.basins` the distinct minima;
  `grid.notes` plain-language caveats to show with the map.

## 2. Draw it on a chart panel (canvas or SVG)

A chart hands over its projection as `{ project(p): [x, y] | null, unproject?(x, y): p | null }`
in the drawing's CSS pixels. With `unproject` the heat is drawn per pixel (smooth, any
projection); without it, as projected cells.

```ts
import { drawMisfitHeat, drawMisfitLines, misfitCaption, misfitContours } from '../misfit/index.js';

drawMisfitHeat(ctx2d, grid, projection, { rect: { x: 0, y: 0, width, height } });
drawMisfitLines(ctx2d, misfitContours(grid), projection);   // 95 % solid, 3 sigma dashed
caption.textContent = misfitCaption(grid);
```

- **Navigate** (`navigate/plot.ts`, SVG over `src/projection.ts`'s `Projection`): wrap it,
  `{ project: (p) => proj.projectPoint(p), unproject: (x, y) => proj.unproject(x, y) }`, draw the
  heat into an `<image href={misfitHeatDataUrl(grid, projection, rect)}>` under the circles,
  and the lines as `<path d>` from `misfitLinePaths(misfitContours(grid), projection)`.
  Frame it with the plot's own view: pass the plot's visible box as `bounds`, or use
  `null` and let the default frame (it holds the 3-sigma region, the cocked hat and every
  ambiguous candidate).
- **Learn** (`learn/project.ts`): `SheetProjection` already has `project(p)` and
  `unproject(x, y)`, so pass it as it is. For the globe (`Ortho`), wrap
  `project: (p) => { const g = ortho.project(p); return g.z > 0 ? [g.x, g.y] : null; }`
  (no `unproject`: cells are drawn, the far side left out).
- Both views already draw the circles, the fix and the candidates; draw the heat first,
  then those, then the lines.

## 3. Put it on the map

```ts
import { publishMisfit } from '../misfit/index.js';

const overlay = publishMisfit(ctx, grid, { heat: true });   // lines + faint 95 % fill (+ raster)
overlay.update(nextGrid);                                   // after a new solve
overlay.remove();
```

Through `mapServiceFor(ctx)`: `misfit-fill` (the 95 % region, faint), `misfit-line-p95`
(solid) and `misfit-line-three_sigma` (dashed), both in `--accent` with labels, and with
`heat: true` the heat itself as `misfit-heat`, an image overlay (a raster whose rows are
evenly spaced in Web Mercator, redrawn when the theme changes). The map service's
`addImageOverlay` was added for it (data: and blob: URLs only; the map is offline). Options:
`prefix`, `levels`, `fill`, `heatOpacity`, `z`.

## 4. Say what it shows

`misfitCaption(grid, { levels })` gives the agreed sentence:

> Darker = worse fit. The inner line is where the fit is within the 95 % level of the best
> point, under the independent-noise model; shared errors (a biased sextant, a wrong clock)
> move the whole picture without widening it.

It names the line by what else is drawn ("the solid line" when the 1-sigma line is drawn
too), says so when the shared bias is estimated (every point judged with its best bias; a
wrong clock still moves the picture), when robust weights are held fixed (the far field is
approximate) and when the best point is off the view. Show `grid.notes` beside it.

## What the map is, and is not

- **The solver's own misfit** at every node, `sum w (Ho - Hc - b)^2 / sigma^2`: its best
  point is the solver's fix (tested on every packaged demo: the lowest node is within one
  grid cell of `solve`'s fix, the polished best point within 5 cm).
- **Shared bias estimated**: profiled out at every node; the lines are the levels for three
  unknowns (7.81 at 95 %), the joint region of position and bias, so they are wider than
  the solver's position-only ellipse (5.99).
- **Robust weighting**: the solver's final Huber weights, held fixed; exact near the fix,
  approximate far from it.
- **A prior is never in the map**: it shows the sights alone. With a prior the fix is pulled
  toward its centre and the map's best point is the fix without it.
- **Not in the map**: the clock's stated uncertainty (it widens the ellipse east-west but
  is not a residual) and any shared error the model does not estimate. That is what the
  caption's last clause is for: such an error moves the whole picture and does not widen it.
- **Nominal levels** under the independent-noise model (CONVENTIONS section 9).

## Colours

`misfitRamp(theme)` / `themeRamp()`: darker = worse in every theme. OKLab lightness falls
linearly along the ramp (perceptually uniform), from the theme's `--accent` (the best fit)
to its `--map-shade` (the worst), the long way round the hue circle (gold, green, teal,
navy, as viridis does); chroma is only ever reduced to stay inside sRGB. **Night is red
only**: pure red channel, black at the worst fit. `heatScale(grid)` maps chi-square to the
ramp logarithmically in delta chi-square, from the best point to the grid's largest value
(at least 30), so the levels near the best point spread out and a far field of millions
still fits; `rampGradient(ramp)` is a CSS gradient for a legend.

## Files

| File | What |
|---|---|
| `grid.ts` | Node positions without the antimeridian jump, bilinear sampling, levels by name |
| `contours.ts` | Marching squares (saddles by the centre, padded so regions close); GeoJSON regions and lines, cut at 180° |
| `ramp.ts` | OKLab ramps per theme from the tokens, the chi-square scale, legend gradient |
| `heat.ts` | Canvas heat (per pixel or per cell), canvas lines, SVG paths, a data URL for SVG, the Mercator raster |
| `overlay.ts` | Publishing on the map service |
| `caption.ts` | The caption |
| `index.ts` | The public API |
| `dev/` | The developer page `web/next/dev-misfit.html` (`#theme`, `#demo`, `#levels=all`, `#n`, `#path=cells`, `#compact`) |

Tests: `web/test/next/misfit-*.test.ts` (contours on known fields, antimeridian and pole,
ramps in every theme, the map overlay, the engine wrappers and, when a package is built,
the real exports); Rust: `crates/skyfix-core/tests/misfit.rs` and the tests in
`crates/skyfix-wasm/src/misfit.rs` (every packaged demo).
