/**
 * Publishing a misfit grid on the explorer's map through the map service
 * (`mapServiceFor(ctx)`, map/README.md): the level lines, a faint fill inside the 95 %
 * line, and optionally the heat itself as a raster (an image overlay). OWNER: misfit agent.
 *
 * Overlay ids (with the default prefix `misfit`): `misfit-fill` (the 95 % region, drawn
 * under everything else), `misfit-heat` (the raster, when asked for), and one
 * `misfit-line-<level>` per level drawn. The lines use the `--accent` token, so they
 * follow the theme on their own; they differ by dash and width as well as by label
 * (colour never works alone). The raster's colours are in its pixels, so while it is
 * shown the helper redraws it whenever the document's theme changes.
 */

import type { Ctx } from '../component.js';
import type { MisfitGrid, MisfitLevelName } from '../engine/types.js';
import { type MapService, mapServiceFor } from '../map/overlays.js';
import { onThemeChange } from '../theme/theme.js';
import { misfitContours } from './contours.js';
import { DEFAULT_LEVELS } from './grid.js';
import { mercatorHeat } from './heat.js';
import { type HeatRamp, heatScale, themeRamp } from './ramp.js';

export interface MisfitOverlayOptions {
  /** Prefix of every overlay id. Default `misfit`. */
  prefix?: string;
  /** Levels drawn as lines. Default the 95 % and 3-sigma lines. */
  levels?: readonly MisfitLevelName[];
  /** Fill inside the 95 % line, faintly (default true). */
  fill?: boolean;
  /** Also lay the heat on the map as a raster (default false). */
  heat?: boolean;
  /** The raster's opacity, 0-1. Default 0.6. */
  heatOpacity?: number;
  /** Stacking: the overlays take `z` to `z + 2`. Default 0. */
  z?: number;
}

export interface MisfitOverlay {
  /** Every overlay id this helper may publish. */
  readonly ids: readonly string[];
  /** Replace the grid (a new solve, a new frame). */
  update(grid: MisfitGrid): void;
  /** Take every overlay off the map and stop following the theme. */
  remove(): void;
}

/** The dash of each level's line on the map (the canvas uses the same pattern). */
export const MAP_LINE: Record<MisfitLevelName, { width: number; dash: readonly number[] | 'solid' }> = {
  p95: { width: 2.5, dash: 'solid' },
  one_sigma: { width: 1.5, dash: [1, 3] },
  three_sigma: { width: 1.5, dash: [5, 3] },
};

/**
 * Publish `grid` on the map of the page `ctx` belongs to. The map need not be on screen:
 * the service keeps overlays until it mounts.
 */
export function publishMisfit(ctx: Pick<Ctx, 'store'>, grid: MisfitGrid, options: MisfitOverlayOptions = {}): MisfitOverlay {
  return publishMisfitTo(mapServiceFor(ctx), grid, options);
}

/**
 * The same on a given map service. `ramp` is for tests and workers; in a page the raster
 * uses the document theme's ramp.
 */
export function publishMisfitTo(
  service: MapService,
  grid: MisfitGrid,
  options: MisfitOverlayOptions = {},
  ramp?: () => HeatRamp,
): MisfitOverlay {
  const prefix = options.prefix ?? 'misfit';
  const levels = options.levels ?? DEFAULT_LEVELS;
  const z = options.z ?? 0;
  const fillId = `${prefix}-fill`;
  const heatId = `${prefix}-heat`;
  const lineId = (level: MisfitLevelName): string => `${prefix}-line-${level}`;
  const ids = [fillId, heatId, ...(['three_sigma', 'p95', 'one_sigma'] as const).map(lineId)];
  let current = grid;
  let stopTheme: (() => void) | null = null;

  const drawHeat = (): void => {
    const heat = mercatorHeat(current, (ramp ?? themeRamp)(), { opacity: 1, scale: heatScale(current) });
    const canvas = document.createElement('canvas');
    canvas.width = heat.width;
    canvas.height = heat.height;
    canvas.getContext('2d')!.putImageData(new ImageData(heat.data, heat.width, heat.height), 0, 0);
    service.addImageOverlay(
      heatId,
      { url: canvas.toDataURL('image/png'), coordinates: heat.coordinates, opacity: options.heatOpacity ?? 0.6 },
      { z },
    );
  };

  const draw = (): void => {
    const contours = misfitContours(current, ['three_sigma', 'p95', 'one_sigma']);
    const region95 = contours.regions.features.find((f) => f.properties.level === 'p95');
    if (options.fill !== false && region95) {
      service.addOverlay(fillId, { type: 'FeatureCollection', features: [region95] }, {
        color: '--accent',
        fillOpacity: 0.14,
        width: 0,
        casing: false,
        z,
      });
    } else {
      service.removeOverlay(fillId);
    }
    if (options.heat) drawHeat();
    else service.removeOverlay(heatId);
    for (const feature of contours.lines.features) {
      const level = feature.properties.level;
      if (!levels.includes(level)) {
        service.removeOverlay(lineId(level));
        continue;
      }
      const line = MAP_LINE[level];
      service.addOverlay(lineId(level), { type: 'FeatureCollection', features: [feature] }, {
        color: '--accent',
        width: line.width,
        dash: line.dash,
        labelProperty: 'label',
        z: z + 2,
      });
    }
  };

  draw();
  if (options.heat && typeof document !== 'undefined') {
    stopTheme = onThemeChange(() => drawHeat());
  }
  return {
    ids,
    update(next: MisfitGrid) {
      current = next;
      draw();
    },
    remove() {
      stopTheme?.();
      stopTheme = null;
      for (const id of ids) service.removeOverlay(id);
    },
  };
}
