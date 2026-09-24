/**
 * The explorer's design system. OWNER: shell-design agent.
 *
 * Importing this module loads the fonts (self-hosted from npm, never a CDN) and the
 * stylesheets, in order: tokens -> base -> components -> layout. Views import their own
 * CSS after it and use only tokens (`var(--…)`), never literal colours.
 *
 *   tokens.css      colours per theme, type, spacing, radii, shadows, motion, dashes
 *   base.css        reset, typography, focus, scrollbars, reduced motion
 *   components.css  buttons, chips, segmented controls, inputs, badges, popovers, …
 *   layout.css      the frame: app strip, time bar, panel (bottom sheet on phones), stage
 *   icons.ts        the icon set          glyphs.ts   body glyphs, Moon phase disc
 *   primitives.ts   DOM builders          theme.ts    applying and following themes
 *   tokens.ts       reading tokens from script (for WebGL and canvas views)
 */

import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './tokens.css';
import './base.css';
import './components.css';
import './layout.css';

export * from './glyphs.js';
export * from './icons.js';
export * from './primitives.js';
export * from './theme.js';
export * from './tokens.js';
