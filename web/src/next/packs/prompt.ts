/**
 * The prompt a view's `ctx.packs.ensure(name, reason)` shows: one small card at the bottom
 * of the view (above the connection and update dock), never over the page and never taking
 * the keyboard away from what the person was doing. OWNER: packs agent.
 *
 *   Positions before 1550 need the Deep time pack.
 *   Deep time: positions from 2000 BC to AD 3000.
 *   0.4 MB, downloaded once and saved on this device.           [Not now] [Get]
 *
 * then the download's progress with Stop, then "saved" for a moment. Offline, the second
 * line says the pack is not saved on this device yet, and Get reads "Try again". Esc, ×
 * and Not now dismiss it (remembered for the page session by the service). It is a live
 * region, so a screen reader hears it when it appears.
 */

import './packs.css';
import { h } from '../../dom.js';
import { icon } from '../theme/icons.js';
import { button, iconButton } from '../theme/primitives.js';
import { formatBytes } from './manifest.js';
import type { PromptAnswer, PromptHandle, Prompter, PromptRequest } from './service.js';

/** The shell's view area (shell/shell.ts); the window when there is none. */
const STAGE_ID = 'sf-stage';
/** How long "saved on this device" stays. */
const DONE_MS = 4000;

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** The prompter the explorer uses: one card at a time; a second request waits its turn. */
export function domPrompter(doc: Document = document): Prompter {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    ask(request: PromptRequest): PromptHandle {
      let resolveAnswer: (a: PromptAnswer) => void = () => undefined;
      const answer = new Promise<PromptAnswer>((r) => (resolveAnswer = r));
      let finished: () => void = () => undefined;
      const turn = new Promise<void>((r) => (finished = r));
      const previous = queue;
      queue = queue.then(() => turn);

      // The lead line is the live region: it changes once per step (ask, downloading, saved
      // or failed), never with the progress, so a screen reader hears each step once.
      const lead = h('p', { class: 'sf-packs-prompt__lead', role: 'status' });
      const detail = h('p', { class: 'sf-packs-prompt__detail' });
      const bar = h('span', { class: 'sf-packs-prompt__bar-fill' });
      const meter = h('div', { class: 'sf-packs-prompt__bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, hidden: true }, bar);
      const actions = h('div', { class: 'sf-packs-prompt__actions' });
      // No tooltips on this card: its buttons are replaced under the pointer as the steps go
      // by, and every one of them says what it does.
      const close = iconButton('close', 'Not now', { size: 'sm', class: 'sf-packs-prompt__close' });
      const card = h(
        'div',
        { class: 'sf-notice sf-packs-prompt__card', 'data-state': 'ask' },
        icon('info'),
        h('div', { class: 'sf-packs-prompt__body' }, lead, detail, meter, actions),
        close,
      );
      const el = h('div', { class: 'sf-packs-prompt sf-on-chrome', role: 'region', 'aria-label': `The ${request.label} data pack` }, card);

      let onDismiss: (() => void) | null = () => resolveAnswer('dismiss');
      const dismiss = (): void => onDismiss?.();
      close.addEventListener('click', dismiss);
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          dismiss();
        }
      });

      const size = formatBytes(request.bytes);
      const describe = (offline: boolean): void => {
        detail.replaceChildren(
          request.description ? `${request.label}: ${sentence(request.description.charAt(0).toLowerCase() + request.description.slice(1))} ` : '',
          offline
            ? `${size}. You are offline, and it is not saved on this device yet.`
            : `${size}, downloaded once and saved on this device.`,
        );
      };
      const ask = (getLabel: string, resolve: (a: PromptAnswer) => void): void => {
        card.dataset.state = 'ask';
        meter.hidden = true;
        onDismiss = () => resolve('dismiss');
        actions.replaceChildren(
          button({ label: 'Not now', variant: 'ghost', size: 'sm', onClick: () => resolve('dismiss') }),
          button({ label: getLabel, variant: 'primary', size: 'sm', onClick: () => resolve('get') }),
        );
      };

      describe(request.offline);
      ask(request.offline ? 'Try again' : `Get · ${size}`, resolveAnswer);

      let doneTimer = 0;
      const remove = (): void => {
        window.clearTimeout(doneTimer);
        el.remove();
        finished();
      };

      // Show it when the cards before it are gone. The live region goes into the page empty
      // and is filled a moment later, so it is announced.
      void previous.then(() => {
        const stage = doc.getElementById(STAGE_ID);
        el.dataset.home = stage ? 'stage' : 'window';
        (stage ?? doc.body).appendChild(el);
        window.setTimeout(() => {
          if (!lead.textContent) lead.textContent = sentence(request.reason);
        }, 50);
      });

      return {
        answer,
        downloading(onStop) {
          card.dataset.state = 'loading';
          lead.textContent = `Downloading the ${request.label} pack…`;
          detail.textContent = `0 of ${size}`;
          meter.hidden = false;
          bar.style.width = '0%';
          meter.setAttribute('aria-valuenow', '0');
          onDismiss = onStop;
          actions.replaceChildren(button({ label: 'Stop', variant: 'ghost', size: 'sm', onClick: onStop }));
        },
        progress(received, total) {
          const pct = total > 0 ? Math.min(100, Math.round((100 * received) / total)) : 0;
          bar.style.width = `${pct}%`;
          meter.setAttribute('aria-valuenow', String(pct));
          detail.textContent = `${formatBytes(received)} of ${formatBytes(total)}`;
        },
        failed(message) {
          card.dataset.state = 'failed';
          card.classList.add('sf-notice--caution');
          lead.textContent = sentence(message);
          describe(globalThis.navigator?.onLine === false);
          return new Promise<PromptAnswer>((resolve) => {
            ask('Try again', (a) => {
              card.classList.remove('sf-notice--caution');
              resolve(a);
            });
          });
        },
        done(message) {
          card.dataset.state = 'done';
          lead.textContent = message;
          detail.textContent = 'Settings → Data packs lists it, and removes it.';
          meter.hidden = true;
          actions.replaceChildren();
          onDismiss = remove;
          doneTimer = window.setTimeout(() => {
            if (card.matches(':hover, :focus-within')) doneTimer = window.setTimeout(remove, DONE_MS);
            else remove();
          }, DONE_MS);
        },
        close: remove,
      };
    },
  };
}
