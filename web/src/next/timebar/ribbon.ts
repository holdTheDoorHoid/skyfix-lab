/**
 * The time bar's 24-hour ribbon, drawn from plain data: the sky phases of the local day
 * (`day_events(...).phases`), hour ticks in the display zone, the selected body's rise,
 * transit and set, the wall clock's "now", and the handle. OWNER: shell-design agent.
 *
 * Positions are proportional to time inside `[jd_start, jd_end)`, so a 23- or 25-hour
 * day (a daylight-saving change) draws correctly as long as the hour list carries the
 * real instants. Moving the handle only changes one style property (cheap enough for
 * 60 fps dragging); everything else is redrawn when the day or the selected body changes.
 */

import { h } from '../../dom.js';
import type { PhaseSegment, SkyPhase } from '../engine/types.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';

export type RibbonMarkKind = 'rise' | 'transit' | 'set';

export interface RibbonMark {
  kind: RibbonMarkKind;
  jd: number;
  /** Shown above the bar, e.g. "06:50". */
  label: string;
  /** Tooltip, e.g. "Sunrise 06:50 EDT (10:50 UTC), direction 090°". */
  tip?: string;
}

export interface RibbonHour {
  jd: number;
  /** "0", "3", … in the display zone; empty for an unlabelled tick. */
  label: string;
  major: boolean;
}

export interface RibbonModel {
  /** Local midnight to local midnight in the display zone. */
  window: readonly [number, number];
  phases: readonly PhaseSegment[];
  hours: readonly RibbonHour[];
  marks: readonly RibbonMark[];
  /** The instant shown. */
  jd: number;
  /** Glyph on the handle: the Sun by day, the Moon by night (EXPLORER_PLAN). */
  glyph: 'sun' | 'moon';
  /** For assistive technology and the drag bubble: "16:30 EDT, Thursday 24 September". */
  valueText: string;
  bubbleText: string;
  /** The wall clock, when it falls inside the window. */
  nowJd?: number | null;
  /** Tooltip per phase segment. */
  phaseTip?: (segment: PhaseSegment) => string;
}

/** Full and short names for segment labels; the short one is used when space is tight. */
export const PHASE_NAMES: Record<SkyPhase, { full: string; short: string; letter: string }> = {
  night: { full: 'Night', short: 'Night', letter: '' },
  astronomical: { full: 'Astronomical', short: 'Astro', letter: 'A' },
  nautical: { full: 'Nautical', short: 'Naut', letter: 'N' },
  civil: { full: 'Civil', short: 'Civil', letter: 'C' },
  day: { full: 'Day', short: 'Day', letter: '' },
};

export interface Ribbon {
  el: HTMLElement;
  handle: HTMLElement;
  bar: HTMLElement;
  /** Redraw everything. */
  update(model: RibbonModel): void;
  /** Move only the handle (and its texts). */
  setHandle(jd: number, valueText: string, bubbleText: string, glyph: 'sun' | 'moon'): void;
  /** Show the wall clock's "now" marker at `jd`, or hide it (null, or outside the day). */
  setNow(jd: number | null): void;
  /** The day shown, `[jd_start, jd_end)`. */
  window(): readonly [number, number];
  /** The instant under a horizontal client coordinate (for pointer dragging). */
  jdAtClientX(clientX: number): number;
  destroy(): void;
}

function pct(x: number): string {
  return `${(Math.min(1, Math.max(0, x)) * 100).toFixed(3)}%`;
}

export function createRibbon(model: RibbonModel, options: { label?: string } = {}): Ribbon {
  let current = model;
  const bar = h('div', { class: 'sf-ribbon__bar', 'aria-hidden': 'true' });
  const labels = h('div', { class: 'sf-ribbon__labels', 'aria-hidden': 'true' });
  const hours = h('div', { class: 'sf-ribbon__hours', 'aria-hidden': 'true' });
  const nowEl = h('span', { class: 'sf-ribbon__now', hidden: true, 'data-tip': 'Now, by this device’s clock' });
  const knob = h('span', { class: 'sf-ribbon__knob' });
  const bubble = h('span', { class: 'sf-ribbon__bubble' });
  const handle = h(
    'div',
    {
      class: 'sf-ribbon__handle',
      role: 'slider',
      tabindex: 0,
      'aria-label': 'Time of day',
      'aria-orientation': 'horizontal',
      'data-own-keys': '',
    },
    knob,
    bubble,
  );
  const el = h(
    'div',
    { class: 'sf-ribbon', role: 'group', 'aria-label': options.label ?? 'Day at this place: sky phases and time' },
    labels,
    bar,
    hours,
    handle,
  );

  const span = (): number => current.window[1] - current.window[0];
  const frac = (jd: number): number => (jd - current.window[0]) / span();

  const fitLabels = (): void => {
    const width = bar.clientWidth;
    if (!width) return;
    for (const seg of bar.querySelectorAll<HTMLElement>('.sf-ribbon__seg')) {
      const phase = seg.dataset.phase as SkyPhase;
      const px = (Number(seg.dataset.width) || 0) * width;
      const names = PHASE_NAMES[phase];
      // Rough text widths at 10.5 px: ~6.2 px per character plus padding.
      const text =
        px >= names.full.length * 6.2 + 16 ? names.full : px >= names.short.length * 6.2 + 12 ? names.short : px >= 13 ? names.letter : '';
      seg.textContent = text;
      seg.dataset.fit = text === names.letter ? 'letter' : text ? 'full' : 'none';
    }
  };

  const draw = (): void => {
    const m = current;
    bar.replaceChildren(
      ...m.phases.map((p) => {
        const x0 = frac(p.jd_start);
        const x1 = frac(p.jd_end);
        return h('div', {
          class: 'sf-ribbon__seg',
          'data-phase': p.phase,
          'data-width': String(x1 - x0),
          style: `left:${pct(x0)};width:${pct(x1 - x0)}`,
          'data-tip': m.phaseTip?.(p),
        });
      }),
      h(
        'div',
        { class: 'sf-ribbon__ticks' },
        ...m.hours.map((hr) =>
          h('span', { class: 'sf-ribbon__tick', 'data-major': hr.major ? '' : undefined, style: `left:${pct(frac(hr.jd))}` }),
        ),
      ),
      ...m.marks.map((mark) => h('span', { class: 'sf-ribbon__mark', 'data-kind': mark.kind, style: `left:${pct(frac(mark.jd))}` })),
    );
    labels.replaceChildren(
      ...m.marks.map((mark) => {
        const x = frac(mark.jd);
        // Near either end a label is aligned inward so it never runs off the ribbon.
        const align = x > 0.95 ? 'end' : x < 0.05 ? 'start' : undefined;
        return h(
          'span',
          { class: 'sf-ribbon__label', 'data-kind': mark.kind, 'data-align': align, style: `left:${pct(x)}`, 'data-tip': mark.tip },
          icon(mark.kind === 'rise' ? 'chevron-up' : mark.kind === 'set' ? 'chevron-down' : 'transit'),
          mark.label,
        );
      }),
      nowEl,
    );
    api.setNow(m.nowJd ?? null);
    hours.replaceChildren(
      ...m.hours
        .filter((hr) => hr.label)
        .map((hr) => h('span', { class: 'sf-ribbon__hour', style: `left:${pct(frac(hr.jd))}` }, hr.label)),
    );
    api.setHandle(m.jd, m.valueText, m.bubbleText, m.glyph);
    fitLabels();
  };

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitLabels()) : null;
  resize?.observe(bar);

  const api: Ribbon = {
    el,
    handle,
    bar,
    update(next) {
      current = next;
      draw();
    },
    setHandle(jd, valueText, bubbleText, glyph) {
      handle.style.left = pct(frac(jd));
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', '1440');
      handle.setAttribute('aria-valuenow', String(Math.round(frac(jd) * 1440)));
      handle.setAttribute('aria-valuetext', valueText);
      bubble.textContent = bubbleText;
      if (handle.dataset.glyph !== glyph) {
        handle.dataset.glyph = glyph;
        knob.replaceChildren(bodyGlyph(glyph === 'sun' ? 'Sun' : 'Moon'));
      }
    },
    setNow(jd) {
      const inside = jd !== null && jd >= current.window[0] && jd < current.window[1];
      nowEl.hidden = !inside;
      if (inside) nowEl.style.left = pct(frac(jd));
    },
    window: () => current.window,
    jdAtClientX(clientX) {
      const r = bar.getBoundingClientRect();
      const x = r.width ? (clientX - r.left) / r.width : 0;
      return current.window[0] + Math.min(1, Math.max(0, x)) * span();
    },
    destroy() {
      resize?.disconnect();
      el.remove();
    },
  };
  draw();
  return api;
}
