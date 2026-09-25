/**
 * The Sky view (EXPLORER_PLAN §2, work package G; expansion Q3). OWNER: sky agent, sky2
 * agent.
 *
 * - `sky`: the view as a component (`Component = (host, ctx) => {destroy}`); `mountSky`
 *   returns the richer `SkyMounted` handle.
 * - `highlightBodies(ctx, names)`: ring bodies in the Sky view from anywhere (the hook for
 *   "tonight's star sights"); `ringWhileShown` rings them only while a panel shows them.
 * - `showInSky(ctx, target)` and `openUpClose(ctx, body)` (requests.ts, importable on
 *   their own without loading the view): open the Sky view on an object, or on the Moon's
 *   or a planet's close-up.
 * - `skyConditions(settings)`: the sky the Sky view draws, as the deep-sky engine's
 *   `conditions` (for Tonight and anything else that estimates visibility).
 */

export { mountSky, sky, skyViewSettings, type SkyInfo, type SkyMounted, type SkyViewSettings } from './view.js';
export { highlightBodies, ringWhileShown, skyHighlights, type SkyHighlights } from './highlight.js';
export { openUpClose, showInSky, skyRequests, type SkyRequest, type SkyTarget } from './requests.js';
export { skyConditions } from './conditions.js';
export type { SkyMode, PanoramaView } from './projection.js';
export type { FrameStats } from './perf.js';
