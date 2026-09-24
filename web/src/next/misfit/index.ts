/**
 * The residual heat map ("misfit grid"): how badly every nearby position fits the sights.
 * OWNER: misfit agent. See README.md in this folder for the API; the numbers come from
 * `engine.misfit.misfitGrid` (docs/EXPLORER_API.md, "Misfit grid").
 */

export { MISFIT_CAPTION, misfitCaption, type CaptionOptions } from './caption.js';
export {
  isoRings,
  misfitContours,
  polygons,
  ringLines,
  type Field,
  type IsoRing,
  type LevelProperties,
  type MisfitContours,
} from './contours.js';
export {
  columnLon,
  DEFAULT_LEVELS,
  gridIndex,
  levelOf,
  rowLat,
  sampleMisfit,
  wrap180,
  type MisfitField,
} from './grid.js';
export {
  drawMisfitHeat,
  drawMisfitLines,
  heatPixels,
  LEVEL_LINE,
  mercatorHeat,
  MERCATOR_MAX_LAT,
  misfitHeatDataUrl,
  misfitLinePaths,
  type HeatOptions,
  type HeatProjection,
  type ImageCorners,
  type LineOptions,
  type MercatorHeat,
  type Rect,
} from './heat.js';
export { MAP_LINE, publishMisfit, publishMisfitTo, type MisfitOverlay, type MisfitOverlayOptions } from './overlay.js';
export {
  heatScale,
  MIN_SCALE_DELTA,
  misfitRamp,
  oklchToRgb,
  parseRgb,
  RAMP_LIGHTNESS,
  rampGradient,
  rgbToOklab,
  themeRamp,
  TOKEN_ANCHORS,
  type HeatRamp,
  type HeatScale,
  type RampAnchors,
  type Rgb,
} from './ramp.js';
