/**
 * The panel's "In the sky now": what is above the horizon, highest first, and a word on
 * what is below. Stars are listed once the sky is dark enough to see them (the brightest
 * few, or all on request); in daylight they are counted, not listed. Clicking a row
 * selects the body. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import type { BodyState } from '../engine/types.js';
import { setAttr, setText, skyNow } from '../shell/derived.js';
import { bearing3, compassPoint, compassWords, formatMagnitude } from '../shell/format.js';
import { shallowEqual } from '../state.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import { section } from '../theme/primitives.js';

/** Stars listed before "Show all". */
const BRIGHTEST = 6;

interface Row {
  li: HTMLElement;
  button: HTMLButtonElement;
  lead: HTMLElement;
  alt: HTMLElement;
  dir: HTMLElement;
  mag: HTMLElement;
}

export function skyNowSection(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  const meta = h('span', { class: 'sf-section__meta' });
  const sec = section('In the sky now', { class: 'sf-skynow', aside: meta });
  const head = h(
    'div',
    { class: 'sf-bodylist__head', 'aria-hidden': 'true' },
    h('span', {}),
    h('span', {}, 'Body'),
    h('span', {}, 'Height'),
    h('span', {}, 'Direction'),
    h('span', { 'data-tip': 'Brightness (magnitude): lower is brighter' }, 'Mag.'),
  );
  const list = h('ul', { class: 'sf-bodylist', 'aria-label': 'Above the horizon, highest first' });
  const stars = h('p', { class: 'sf-skynow__foot' });
  const more = h('button', { type: 'button', class: 'sf-link' });
  const below = h('p', { class: 'sf-skynow__foot' });
  const empty = h('p', { class: 'sf-skynow__foot', hidden: true }, 'Nothing is computed for this time.');
  sec.body.append(head, list, stars, below, empty);

  let showAll = false;
  more.addEventListener('click', () => {
    showAll = !showAll;
    render();
  });

  const rows = new Map<string, Row>();
  const rowFor = (b: BodyState): Row => {
    let r = rows.get(b.body);
    if (r) return r;
    const lead = h('span', { class: 'sf-bodyrow__lead' });
    const alt = h('span', { class: 'sf-bodyrow__alt' });
    const dir = h('span', { class: 'sf-bodyrow__dir' });
    const mag = h('span', { class: 'sf-bodyrow__mag' });
    const button = h(
      'button',
      { type: 'button', class: 'sf-bodyrow', 'data-kind': b.kind },
      lead,
      h('span', { class: 'sf-bodyrow__name' }, b.body),
      alt,
      dir,
      mag,
    );
    button.addEventListener('click', () => store.patch({ selection: { body: b.body } }));
    if (b.kind !== 'moon') lead.append(bodyGlyph(b.body, { kind: b.kind }));
    r = { li: h('li', {}, button), button, lead, alt, dir, mag };
    rows.set(b.body, r);
    return r;
  };

  let lastMoonKey = '';
  const render = (): void => {
    const s = store.get();
    const sky = skyNow(ctx, s);
    if (!sky || sky.bodies.length === 0) {
      list.replaceChildren();
      head.hidden = true;
      stars.hidden = true;
      below.hidden = true;
      empty.hidden = false;
      setText(meta, '');
      return;
    }
    head.hidden = false;
    empty.hidden = true;
    const up = sky.bodies.filter((b) => b.above_horizon);
    const solar = up.filter((b) => b.kind !== 'star');
    const starsUp = up.filter((b) => b.kind === 'star').sort((a, b) => (a.magnitude ?? 9) - (b.magnitude ?? 9));
    const dark = sky.sky_phase !== 'day';
    const listedStars = dark ? (showAll ? starsUp : starsUp.slice(0, BRIGHTEST)) : [];
    const shown = [...solar, ...listedStars].sort((a, b) => b.alt_apparent_deg - a.alt_apparent_deg);

    setText(meta, `${solar.length} ${solar.length === 1 ? 'body' : 'bodies'} · ${starsUp.length} stars`);
    const children: HTMLElement[] = [];
    for (const b of shown) {
      const r = rowFor(b);
      if (b.kind === 'moon') {
        const k = b.illuminated_fraction ?? 0;
        const limb = b.bright_limb_angle_deg === null ? 270 : b.bright_limb_angle_deg - b.parallactic_angle_deg;
        const key = `${k.toFixed(2)}|${Math.round(limb / 5)}`;
        if (key !== lastMoonKey) {
          lastMoonKey = key;
          r.lead.replaceChildren(phaseDisc({ illuminated: k, limbFromUpDeg: limb, size: 18 }));
        }
      }
      setText(r.alt, `${Math.round(b.alt_apparent_deg)}°`);
      setText(r.dir, `${bearing3(b.az_deg)} ${compassPoint(b.az_deg)}`);
      setText(r.mag, formatMagnitude(b.magnitude));
      setAttr(r.button, 'aria-pressed', String(b.body === s.selection.body));
      setAttr(
        r.button,
        'aria-label',
        `${b.body}: ${Math.round(b.alt_apparent_deg)} degrees up, ${compassWords(b.az_deg)}, magnitude ${formatMagnitude(b.magnitude)}`,
      );
      children.push(r.li);
    }
    // Reorder only when the order changed (keeps focus and hover steady while time runs).
    const current = [...list.children];
    if (current.length !== children.length || current.some((c, i) => c !== children[i])) list.replaceChildren(...children);

    // Stars
    stars.hidden = starsUp.length === 0;
    if (!dark) {
      stars.replaceChildren(
        bodyGlyph('Star', { kind: 'star' }),
        h('span', {}, `${starsUp.length} of the 58 navigational stars are above the horizon, hidden by daylight.`),
      );
    } else if (starsUp.length > BRIGHTEST) {
      setText(more, showAll ? 'Show the brightest only' : `Show all ${starsUp.length}`);
      stars.replaceChildren(
        bodyGlyph('Star', { kind: 'star' }),
        h(
          'span',
          {},
          showAll ? `All ${starsUp.length} navigational stars above the horizon. ` : `The ${BRIGHTEST} brightest of ${starsUp.length} navigational stars above the horizon. `,
          more,
        ),
      );
    } else {
      stars.replaceChildren(bodyGlyph('Star', { kind: 'star' }), h('span', {}, `${starsUp.length} navigational stars above the horizon.`));
    }

    // Below the horizon: the solar system only
    const down = sky.bodies.filter((b) => !b.above_horizon && b.kind !== 'star');
    below.hidden = down.length === 0;
    if (down.length) {
      const moon = down.find((b) => b.kind === 'moon');
      below.replaceChildren(
        moon
          ? phaseDisc({
              illuminated: moon.illuminated_fraction ?? 0,
              limbFromUpDeg: moon.bright_limb_angle_deg === null ? 270 : moon.bright_limb_angle_deg - moon.parallactic_angle_deg,
              size: 16,
            })
          : h('span', { class: 'sf-skynow__spacer' }),
        h(
          'span',
          {},
          'Below the horizon: ',
          ...down.flatMap((b, i) => [
            i ? ', ' : '',
            b.kind === 'moon' ? h('span', {}, h('strong', {}, 'Moon'), ` (${Math.round((b.illuminated_fraction ?? 0) * 100)}% lit)`) : b.body,
          ]),
          '.',
        ),
      );
    }
  };

  // Every body is the costliest question the panel asks, so while time runs (playing or a
  // dragged handle) the list follows at most four times a second; a single change, and the
  // last of a run, show at once.
  let last = 0;
  let trailing = 0;
  const throttled = (): void => {
    const now = performance.now();
    const wait = 250 - (now - last);
    if (wait > 0) {
      if (!trailing) trailing = window.setTimeout(() => {
        trailing = 0;
        ctx.scheduler.schedule(throttled);
      }, wait);
      return;
    }
    last = now;
    render();
  };
  d.add(() => window.clearTimeout(trailing));
  d.add(
    watch(ctx, (s) => [s.time.jd_utc, s.observer, s.selection.body] as const, throttled, { equals: shallowEqual }),
  );
  return { el: sec.el, destroy: () => d.dispose() };
}
