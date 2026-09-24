/**
 * The side panel's "Tonight's star sights" slot. OWNER: navigate agent.
 *
 * The shell mounts `src/next/<folder>/slots/star-sights.ts` (default export a Component)
 * into the body of its own "Tonight's star sights" section (panel/sights.ts), so the
 * component brings no heading. It is the compact list for the explorer's place and the
 * instrument settings; "Use these bodies" hands them to Navigate and opens it.
 *
 * The stylesheet comes with it: the panel shows this before Navigate has ever been opened.
 */

import '../../theme/index.js';
import '../navigate.css';

export { tonight as default } from '../tonight.js';
