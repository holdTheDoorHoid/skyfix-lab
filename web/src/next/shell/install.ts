/**
 * "Install SkyFix Lab": the browser's own install offer, kept so Help and About can show an
 * Install button (only once the browser has said the page can be installed), and a one-line
 * hint for iPhones and iPads, whose browsers have no such offer (Share, then Add to Home
 * Screen). OWNER: packs agent (the shell fixes of the expansion programme).
 *
 * The browser's own install entry (the address bar icon, the phone's menu or its small
 * banner) keeps working: the event is kept, never cancelled, so nothing the browser would
 * show is hidden, and nothing is logged about a prompt that was held back.
 */

/** Chromium's `beforeinstallprompt` event (not in the DOM library). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  /** The browser offered to install the page: `install()` asks it to. */
  | 'available'
  /** An iPhone or iPad not yet installed: say how. */
  | 'ios'
  /** Running as the installed app. */
  | 'installed'
  /** Nothing to offer (a browser that has not offered, or cannot). */
  | 'none';

export interface InstallOffer {
  state(): InstallState;
  /** Ask the browser to install; resolves with what the person chose. */
  install(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
  subscribe(listener: () => void): () => void;
}

export const IOS_HINT = 'On an iPhone or iPad: tap Share, then Add to Home Screen.';

interface InstallWindow {
  addEventListener: Window['addEventListener'];
  matchMedia?: Window['matchMedia'];
  navigator: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { standalone?: boolean; platform?: string };
}

/** An iPhone, an iPad, or an iPad that says it is a Mac (iPadOS 13 and later). */
export function isIosDevice(nav: InstallWindow['navigator']): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

function runningInstalled(win: InstallWindow): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    // An old browser without display-mode queries.
  }
  return win.navigator.standalone === true;
}

let current: InstallOffer | null = null;

/** Start listening (once per page, as early as possible); later calls return the same offer. */
export function startInstallOffer(win: InstallWindow = window): InstallOffer {
  if (current) return current;
  let saved: InstallPromptEvent | null = null;
  let installed = runningInstalled(win);
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());

  win.addEventListener('beforeinstallprompt', (event) => {
    saved = event as InstallPromptEvent;
    notify();
  });
  win.addEventListener('appinstalled', () => {
    saved = null;
    installed = true;
    notify();
  });

  current = {
    state() {
      if (installed) return 'installed';
      if (saved) return 'available';
      return isIosDevice(win.navigator) ? 'ios' : 'none';
    },
    async install() {
      const event = saved;
      if (!event) return 'unavailable';
      // An offer can be used once.
      saved = null;
      notify();
      try {
        await event.prompt();
        const { outcome } = await event.userChoice;
        return outcome;
      } catch {
        return 'unavailable';
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return current;
}

/** The page's offer (started by main.ts); a fresh one where main.ts did not run (developer pages). */
export function installOffer(): InstallOffer {
  return current ?? startInstallOffer();
}
