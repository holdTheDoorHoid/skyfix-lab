/**
 * The view in the address bar: `#map`, `#sky`, … OWNER: shell-design agent.
 *
 * Only the view's name is written, never a position or a time (EXPLORER_PLAN §1: the
 * place goes into a link only through Share). Share links (`#v=1&…`) are left to
 * `listenForShareLinks` in state.ts, which applies and removes them.
 */

import { VIEW_IDS, type ExplorerStore, type ViewId } from '../state.js';

/** The view named by a fragment such as `#sky`; null for anything else (share links included). */
export function viewFromHash(hash: string): ViewId | null {
  const name = hash.replace(/^#/, '').trim().toLowerCase();
  return (VIEW_IDS as readonly string[]).includes(name) ? (name as ViewId) : null;
}

export function hashForView(view: ViewId): string {
  return `#${view}`;
}

export interface RouterWindow {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  addEventListener: Window['addEventListener'];
  removeEventListener: Window['removeEventListener'];
}

/**
 * Keep `state.view` and the fragment in step: a `#view` in the address (typed, bookmarked,
 * or Back) selects the view, and choosing a view updates the fragment in place (no new
 * history entry per tab). Returns the stop function.
 */
export function startRouter(store: ExplorerStore, win: RouterWindow = window): () => void {
  const fromLocation = (): void => {
    const view = viewFromHash(win.location.hash);
    if (view && view !== store.get().view) store.patch({ view });
  };
  const write = (view: ViewId): void => {
    if (viewFromHash(win.location.hash) === view) return;
    // A share link still in the address is being consumed; leave it alone.
    if (/^#v=/.test(win.location.hash)) return;
    try {
      win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}${hashForView(view)}`);
    } catch {
      // A sandboxed frame may refuse; the view is shown either way.
    }
  };
  fromLocation();
  write(store.get().view);
  const stopSelect = store.select((s) => s.view, write);
  // After a pasted share link has been applied and removed, name the view again.
  const onHash = (): void => {
    fromLocation();
    write(store.get().view);
  };
  win.addEventListener('hashchange', onHash);
  return () => {
    stopSelect();
    win.removeEventListener('hashchange', onHash);
  };
}
