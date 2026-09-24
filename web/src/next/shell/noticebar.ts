/**
 * Messages for the person (notices.ts): which engine runs, a computation that failed, a
 * place that could not be found. Shown at the top of the stage; persistent ones (the
 * mock engine) can be folded to one line but never dismissed. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import type { Notice } from '../notices.js';
import { icon } from '../theme/icons.js';
import { iconButton } from '../theme/primitives.js';

export function noticeBar(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { notices } = ctx;
  const el = h('div', { class: 'sf-notices', role: 'region', 'aria-label': 'Messages', 'aria-live': 'polite' });
  const folded = new Set<number>();

  const item = (n: Notice): HTMLElement => {
    const isFolded = n.persistent && folded.has(n.id);
    const text = h('span', { class: 'sf-notice__text' }, n.text);
    const actions: HTMLElement[] = [];
    if (n.persistent) {
      const fold = iconButton(isFolded ? 'chevron-down' : 'chevron-up', isFolded ? 'Show the whole message' : 'Fold the message to one line', { size: 'sm' });
      fold.addEventListener('click', () => {
        if (folded.has(n.id)) folded.delete(n.id);
        else folded.add(n.id);
        render(notices.list());
      });
      actions.push(fold);
    } else {
      const close = iconButton('close', 'Dismiss this message', { size: 'sm' });
      close.addEventListener('click', () => notices.dismiss(n.id));
      actions.push(close);
    }
    return h(
      'div',
      { class: `sf-notice sf-notice--${n.level}${isFolded ? ' sf-notice--folded' : ''}`, role: n.level === 'error' ? 'alert' : 'status' },
      icon(n.level === 'info' ? 'info' : 'caution'),
      text,
      h('span', { class: 'sf-notice__actions' }, ...actions),
    );
  };

  const render = (list: readonly Notice[]): void => {
    for (const id of [...folded]) if (!list.some((n) => n.id === id)) folded.delete(id);
    el.replaceChildren(...list.map(item));
    el.hidden = list.length === 0;
  };
  render(notices.list());
  const stop = notices.subscribe(render);
  return {
    el,
    destroy() {
      stop();
      el.remove();
    },
  };
}
