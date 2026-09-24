/**
 * Offline support for the original workbench at `/classic/`: registers the same service
 * worker as the explorer and, when a new version waits, offers it in the workbench's own
 * style (styles.css `.sw-prompt`). Never reloads unless Reload is pressed. OWNER: release
 * agent. Goes when /classic/ does, at the end of the transition period.
 */

import { startServiceWorker } from './register.js';

let current: HTMLElement | null = null;

function prompt(text: string, onReload: () => void): void {
  current?.remove();
  const box = document.createElement('div');
  box.className = 'sw-prompt notice notice-info';
  box.setAttribute('role', 'status');
  const message = document.createElement('span');
  message.textContent = text;
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'primary small';
  reload.textContent = 'Reload';
  reload.addEventListener('click', onReload);
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'small';
  later.textContent = 'Later';
  later.addEventListener('click', () => box.remove());
  box.append(message, reload, later);
  document.body.appendChild(box);
  current = box;
}

export function startWorkbenchPwa(): void {
  startServiceWorker({
    onUpdateReady: (update) => prompt('A new version of SkyFix Lab is available.', () => update.apply()),
    onUpdatedElsewhere: (reload) => prompt('SkyFix Lab was updated in another tab.', reload),
  });
}
