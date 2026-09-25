/**
 * Messages for the person (notices.ts): which engine runs, a computation that failed, a
 * place that could not be found. Shown at the top of the stage; persistent ones (the
 * mock engine) can be folded to one line but never dismissed. OWNER: shell-design agent.
 *
 * polish2 (expansion programme): the messages take their own band at the top of the stage
 * and the view begins under it (`--stage-notice-inset` on the stage, px), so a message never
 * covers a view's own controls: the Historical-estimate notice stays up for every date
 * before 1550, and it hid the tabs of Events, Navigate and Learn and the Sky view's
 * switches; on a phone a date outside the coverage hid the map's Layers button.
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import type { Notice } from '../notices.js';
import { icon } from '../theme/icons.js';
import { iconButton } from '../theme/primitives.js';

/** Space between the messages and the view under them, px. */
const NOTICE_GAP_PX = 8;

export function noticeBar(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { notices } = ctx;
  const el = h('div', { class: 'sf-notices', role: 'region', 'aria-label': 'Messages', 'aria-live': 'polite' });
  const folded = new Set<number>();

  const item = (n: Notice): HTMLElement => {
    const isFolded = folded.has(n.id);
    const text = h('span', { class: 'sf-notice__text' }, n.text);
    const actions: HTMLElement[] = [];
    // A persistent message can be folded to one line; on a phone every message starts folded
    // and can be unfolded (polish2), since the view begins under them.
    if (n.persistent || isFolded || foldable.has(n.id)) {
      foldable.add(n.id);
      const fold = iconButton(isFolded ? 'chevron-down' : 'chevron-up', isFolded ? 'Show the whole message' : 'Fold the message to one line', { size: 'sm' });
      fold.addEventListener('click', () => {
        if (folded.has(n.id)) folded.delete(n.id);
        else folded.add(n.id);
        render(notices.list());
      });
      actions.push(fold);
    }
    if (!n.persistent) {
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

  // The band the messages take at the top of the stage: their height, the gap above them
  // (their `top`) and one below. Written on the stage only when it changes.
  let inset = '';
  const publish = (): void => {
    const stageEl = el.parentElement;
    if (!stageEl) return;
    const next = el.hidden ? '0px' : `${Math.ceil(el.offsetTop + el.offsetHeight + NOTICE_GAP_PX)}px`;
    if (next === inset) return;
    inset = next;
    stageEl.style.setProperty('--stage-notice-inset', next);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => publish()) : null;
  resize?.observe(el);

  // On a phone a message starts folded to its first line (the notices would take half the
  // stage otherwise); its chevron shows the rest. Each is folded once, when it first appears.
  const seen = new Set<number>();
  const foldable = new Set<number>();
  const narrow = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;

  const render = (list: readonly Notice[]): void => {
    for (const id of [...folded]) if (!list.some((n) => n.id === id)) folded.delete(id);
    for (const id of [...seen]) if (!list.some((n) => n.id === id)) seen.delete(id);
    for (const id of [...foldable]) if (!list.some((n) => n.id === id)) foldable.delete(id);
    for (const n of list) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (narrow()) folded.add(n.id);
    }
    el.replaceChildren(...list.map(item));
    el.hidden = list.length === 0;
    publish();
  };
  render(notices.list());
  const stop = notices.subscribe(render);
  return {
    el,
    destroy() {
      stop();
      resize?.disconnect();
      el.parentElement?.style.removeProperty('--stage-notice-inset');
      el.remove();
    },
  };
}
