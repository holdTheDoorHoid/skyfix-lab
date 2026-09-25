/**
 * Navigate's entry points for the shell (src/next/shell/registry.ts): the view is found as
 * `navigate/view.ts` and the side panel's "Tonight's star sights" slot as
 * `navigate/slots/star-sights.ts`, each with a default-exported Component. The shell loads
 * both lazily by file name, so a renamed file or export would only show as a "coming soon"
 * page; the names are pinned here. (Static imports: the view's module graph is large, and
 * loading it at collection time keeps it out of the per-test timeout on a busy machine.)
 */
import { describe, expect, it } from 'vitest';
import { navigate } from '../../src/next/navigate/index.js';
import starSights from '../../src/next/navigate/slots/star-sights.js';
import { tonight } from '../../src/next/navigate/tonight.js';
import view from '../../src/next/navigate/view.js';

describe('Navigate entry points for the shell', () => {
  it('view.ts default-exports the Navigate view', () => {
    expect(typeof view).toBe('function');
    expect(view).toBe(navigate);
  });

  it('slots/star-sights.ts default-exports a component: the compact tonight list (navigate2: it also installs the passage’s page-level pieces)', () => {
    expect(typeof starSights).toBe('function');
    expect(starSights.length).toBe(tonight.length);
  });
});
