/**
 * The panel's Now section: the sky phase at the time shown, in plain words, with what it
 * means for a navigator ("Nautical twilight: horizon and stars both visible: the time for
 * star sights"). OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import type { PhaseSegment, SkyPhase } from '../engine/types.js';
import { aroundToday, dayOf, setAttr, setText, skySelected } from '../shell/derived.js';
import { dateShort, eventTime, otherDay, relative } from '../shell/format.js';
import { PHASE_LABEL, PHASE_MEANING, skyFacts, type SkyFacts } from '../shell/sky.js';
import { displayZone, eventOptions, shallowEqual } from '../state.js';
import { icon, type IconName } from '../theme/icons.js';
import { section } from '../theme/primitives.js';
import type { Zone } from '../time.js';

const PHASE_ICON: Record<SkyPhase, IconName> = {
  day: 'sun',
  civil: 'dusk',
  nautical: 'sextant',
  astronomical: 'moon',
  night: 'moon',
};

/** "19:21–19:53", with the weekday when it is not the day shown. */
function span(seg: PhaseSegment, ref: number, zone: Zone): string {
  const day = otherDay(seg.jd_start, ref, zone);
  return `${day ? `${day} ` : ''}${eventTime(seg.jd_start, zone)}–${eventTime(seg.jd_end, zone)}`;
}

/** The sentence under the phase: what it means, and when star sights come. */
export function meaning(f: SkyFacts, jd: number, zone: Zone): (string | Node)[] {
  const strong = (text: string): Node => h('strong', {}, text);
  const nautical = f.nautical;
  switch (f.phase) {
    case 'day':
      if (!nautical) return ['The Sun is up: Sun sights are possible now. There is no nautical twilight in the next day or two here, so no star sights.'];
      return ['The Sun is up: Sun sights are possible now. Stars stay hidden until ', strong(`nautical twilight, ${span(nautical, jd, zone)}`), ', the time for star sights.'];
    case 'civil':
      if (f.brightening && f.endsAt !== null) {
        return [`${PHASE_MEANING.civil} Sunrise at `, strong(eventTime(f.endsAt, zone)), ` (${relative(jd, f.endsAt)}).`];
      }
      return nautical
        ? [`${PHASE_MEANING.civil} Star sights begin with nautical twilight at `, strong(eventTime(nautical.jd_start, zone)), ` (${relative(jd, nautical.jd_start)}).`]
        : [PHASE_MEANING.civil];
    case 'nautical':
      return f.endsAt !== null
        ? [strong(PHASE_MEANING.nautical), ` Nautical twilight ends at ${eventTime(f.endsAt, zone)}, ${relative(jd, f.endsAt)}.`]
        : [strong(PHASE_MEANING.nautical)];
    case 'astronomical':
      if (f.brightening && nautical) {
        return [`${PHASE_MEANING.astronomical} Star sights begin with nautical twilight at `, strong(eventTime(nautical.jd_start, zone)), ` (${relative(jd, nautical.jd_start)}).`];
      }
      return nautical ? [`${PHASE_MEANING.astronomical} Next star sights: `, strong(`nautical twilight, ${span(nautical, jd, zone)}`), '.'] : [PHASE_MEANING.astronomical];
    case 'night':
      return nautical
        ? [`${PHASE_MEANING.night} Sights need a horizon, so they wait for `, strong(`nautical twilight, ${span(nautical, jd, zone)}`), '.']
        : [`${PHASE_MEANING.night} Sights need a horizon.`];
  }
}

export function nowSection(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  const meta = h('span', { class: 'sf-section__meta' });
  const sec = section('Now', { class: 'sf-now', aside: meta });
  const chipIcon = h('span', { class: 'sf-now__icon' });
  const chipText = h('span', {});
  const chip = h('span', { class: 'sf-phase-chip', 'data-phase': 'day' }, chipIcon, chipText);
  const text = h('p', { class: 'sf-now__meaning' });
  sec.body.append(h('div', { class: 'sf-now__phase' }, chip), text);

  let lastIcon = '';
  const render = (): void => {
    const s = store.get();
    const zone = displayZone(s);
    const jd = s.time.jd_utc;
    setText(meta, dateShort(jd, zone));
    const sky = skySelected(ctx, s);
    if (!sky) {
      setAttr(chip, 'data-phase', 'none');
      setText(chipText, 'Not computed');
      if (lastIcon !== 'none') {
        chipIcon.replaceChildren(icon('info'));
        lastIcon = 'none';
      }
      text.dataset.key = 'none';
      text.replaceChildren('Nothing can be computed for this moment: it is outside the years the core covers.');
      return;
    }
    const around = aroundToday(ctx, s, 'Sun');
    const facts = skyFacts(around?.phases ?? [], jd, sky.sky_phase);
    setAttr(chip, 'data-phase', facts.phase);
    setText(chipText, PHASE_LABEL[facts.phase]);
    if (lastIcon !== facts.phase) {
      chipIcon.replaceChildren(icon(PHASE_ICON[facts.phase]));
      lastIcon = facts.phase;
    }
    const parts = meaning(facts, jd, zone);
    const key = parts.map((p) => (typeof p === 'string' ? p : `<${p.textContent ?? ''}>`)).join('');
    if (text.dataset.key !== key) {
      text.dataset.key = key;
      text.replaceChildren(...parts);
    }
  };
  // Minutes are enough for the words; the phase itself changes at most a few times a day.
  d.add(
    watch(
      ctx,
      (s) => {
        const [a] = dayOf(s);
        return [
          Math.floor(s.time.jd_utc * 1440),
          a,
          s.observer.lat_deg,
          s.observer.lon_deg,
          s.observer.height_m,
          s.observer.zone,
          s.settings.timeDisplay,
          eventOptions(s).horizon,
        ] as const;
      },
      render,
      { equals: shallowEqual },
    ),
  );
  return { el: sec.el, destroy: () => d.dispose() };
}
