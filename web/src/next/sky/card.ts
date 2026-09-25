/**
 * The Sky view's info card: what the pinned object is, where it is, and what to do with
 * it (see it up close, show tonight's ranking, put a field of view round it). OWNER:
 * sky2 agent (expansion Q3).
 *
 * The hover tooltip (view.ts) is for a glance and cannot hold a button; this card stays
 * until closed (×, Escape inside it, or a click on empty sky). It floats on the stage
 * (bottom left; across the bottom on a phone) and redraws only when its text changes.
 */

import { h } from '../../dom.js';
import type { IconName } from '../theme/icons.js';
import { button, iconButton } from '../theme/primitives.js';
import { setUncertaintyChip, uncertaintyChip, type DtChip } from '../time/chip.js';

export interface CardLine {
  /** Plain words ("Height above horizon"), with the navigator's term after " · " when shown. */
  label: string;
  /** The value, in the number font; '' makes the line a note. */
  value: string;
  /** Put the ± chip after the value (a clock time or a place: time/chip.ts `dtChip`). */
  chip?: DtChip | null;
  tip?: string;
}

export interface CardAction {
  id: string;
  label: string;
  icon?: IconName;
  primary?: boolean;
  tip?: string;
}

export interface CardContent {
  /** What the card describes (the pinned key): a new key rebuilds it. */
  key: string;
  title: string;
  /** A small symbol before the title (the chart's mark). */
  symbol?: () => Element;
  sub: string;
  lines: CardLine[];
  /** Sentences under the lines (estimates say they are). */
  notes: string[];
  actions: CardAction[];
  /** The source line in small type ("Source: Minor Planet Center"). */
  source?: string;
}

export interface InfoCard {
  el: HTMLElement;
  show(content: CardContent | null): void;
  /** The content on show, or null. */
  current(): CardContent | null;
  destroy(): void;
}

export function infoCard(onAction: (id: string, content: CardContent) => void, onClose: () => void): InfoCard {
  const titleId = `sky-card-${Math.random().toString(36).slice(2, 8)}`;
  const el = h('section', { class: 'sky-card sf-on-stage', 'aria-labelledby': titleId, hidden: true });
  const close = iconButton('close', 'Close this card', { class: 'sky-card__close', onClick: () => onClose() });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  });
  let content: CardContent | null = null;
  let rendered = '';
  const chips: { el: HTMLElement; info: DtChip | null }[] = [];

  const render = (c: CardContent): void => {
    chips.length = 0;
    const lines = c.lines.map((l) => {
      const row = h('div', { class: `sky-card__line${l.value ? '' : ' sky-card__line--note'}`, 'data-tip': l.tip });
      row.append(h('span', { class: 'sky-card__k' }, l.label));
      if (l.value) {
        const v = h('span', { class: 'sky-card__v' }, l.value);
        if (l.chip !== undefined) {
          const chip = uncertaintyChip(l.chip);
          chips.push({ el: chip, info: l.chip });
          v.append(' ', chip);
        }
        row.append(v);
      }
      return row;
    });
    const parts: (Node | null)[] = [
      h(
        'header',
        { class: 'sky-card__head' },
        c.symbol ? h('span', { class: 'sky-card__sym', 'aria-hidden': 'true' }, c.symbol()) : null,
        h('div', { class: 'sky-card__titles' }, h('h2', { class: 'sky-card__title', id: titleId }, c.title), c.sub ? h('p', { class: 'sky-card__sub' }, c.sub) : null),
        close,
      ),
      h('div', { class: 'sky-card__lines' }, ...lines),
      ...c.notes.map((n) => h('p', { class: 'sky-card__note' }, n)),
      c.actions.length
        ? h(
            'div',
            { class: 'sky-card__actions' },
            ...c.actions.map((a) =>
              button({
                label: a.label,
                ...(a.icon ? { icon: a.icon } : {}),
                size: 'sm',
                variant: a.primary ? 'primary' : 'secondary',
                ...(a.tip ? { tip: a.tip } : {}),
                attrs: { 'data-action': a.id },
                onClick: () => {
                  if (content) onAction(a.id, content);
                },
              }),
            ),
          )
        : null,
      // The source: one short line; a long catalogue description folds away.
      c.source
        ? c.source.length <= 60
          ? h('p', { class: 'sky-card__source' }, c.source)
          : h('details', { class: 'sky-card__source' }, h('summary', {}, 'Source'), h('p', {}, c.source))
        : null,
    ];
    el.replaceChildren(...parts.filter((p): p is Node => p !== null));
  };

  return {
    el,
    show(next) {
      content = next;
      if (!next) {
        if (!el.hidden) el.hidden = true;
        rendered = '';
        return;
      }
      const key = JSON.stringify([next.key, next.title, next.sub, next.lines.map((l) => [l.label, l.value, l.chip?.text ?? null, l.chip?.tip ?? null, l.chip?.tier ?? null]), next.notes, next.actions.map((a) => a.id + a.label), next.source]);
      if (key !== rendered) {
        // Keep the focus on the same action across a redraw (the time moved under it).
        const focused = (document.activeElement as HTMLElement | null)?.dataset?.action;
        render(next);
        rendered = key;
        if (focused) el.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
      } else {
        for (const c of chips) setUncertaintyChip(c.el, c.info);
      }
      if (el.hidden) el.hidden = false;
    },
    current: () => content,
    destroy() {
      el.remove();
    },
  };
}
