/**
 * The Sky view (EXPLORER_PLAN §2, work package G). OWNER: sky agent.
 *
 * - `sky`: the view as a component (`Component = (host, ctx) => {destroy}`); `mountSky`
 *   returns the richer `SkyMounted` handle.
 * - `highlightBodies(ctx, names)`: ring bodies in the Sky view from anywhere (the hook for
 *   "tonight's star sights").
 */

export { mountSky, sky, type SkyMounted, type SkyViewSettings } from './view.js';
export { highlightBodies, skyHighlights, type SkyHighlights } from './highlight.js';
export type { SkyMode, PanoramaView } from './projection.js';
export type { FrameStats } from './perf.js';
