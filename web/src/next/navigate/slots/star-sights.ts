/**
 * The side panel's "Tonight's star sights" slot. OWNER: navigate agent.
 *
 * The shell mounts `src/next/<folder>/slots/star-sights.ts` (default export a Component)
 * into the body of its own "Tonight's star sights" section (panel/sights.ts), so the
 * component brings no heading. It is the compact list for the explorer's place and the
 * instrument settings; "Use these bodies" hands them to Navigate and opens it.
 *
 * The stylesheet comes with it: the panel shows this before Navigate has ever been opened.
 *
 * navigate2 (expansion programme): the panel is on every page, so it also installs the
 * passage's page-level pieces (passage/page.ts): the map measuring tool's "Add as a leg of
 * the passage" and the route drawn on the map from the working session.
 */

import '../../theme/index.js';
import '../navigate.css';
import type { Component } from '../../component.js';
import { tonight } from '../tonight.js';

const starSights: Component = (host, ctx) => {
  // Loaded after the panel, in its own chunk: nothing of it is needed for the first frame.
  void import('../passage/page.js')
    .then((m) => m.installPassage(ctx))
    .catch((error: unknown) => console.error('the passage could not be installed', error));
  return tonight(host, ctx);
};

export default starSights;
