/**
 * The shell's entry for the Navigate view. OWNER: navigate agent.
 *
 * The shell finds a view by file name (`src/next/<folder>/view.ts`, default export a
 * Component; shell/registry.ts), so this file is all the wiring Navigate needs and no line
 * in the registry is required. The view itself is `navigate` in index.ts.
 */

export { navigate as default } from './index.js';
