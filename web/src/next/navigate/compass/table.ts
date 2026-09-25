/**
 * The deviation table card of the Compass tab: this compass's deviation logged by the
 * ship's heading (from a bearing worked out above, or typed from a swing), what it is on
 * any heading between the logged ones, and, with headings all round, the classic
 * five-coefficient curve and a deviation card from it. OWNER: navigate2 agent (expansion
 * programme). The arithmetic is deviation.ts; this file only draws it.
 */

import { h, s } from '../../../dom.js';
import { disposer } from '../../component.js';
import type { NavCtx } from '../context.js';
import { utcText } from '../format.js';
import type { DeviationEntry } from '../model.js';
import { parseNumber } from '../parse.js';
import { btn, card, field, para, textInput } from '../ui.js';
import {
  COEFFICIENT_TEXT,
  deviationAt,
  deviationCard,
  eastWest,
  fitDeviation,
  interpolateDeviation,
  norm360,
  parseEastWest,
  sortDeviations,
  type DeviationFit,
} from './deviation.js';

const heading3 = (v: number): string => `${String(Math.round(norm360(v)) % 360).padStart(3, '0')}°`;

/** Deviation against heading: the logged points and, when there is one, the fitted curve. */
export function deviationChart(entries: readonly DeviationEntry[], fit: DeviationFit | null, width = 520): SVGSVGElement {
  const height = 190;
  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 30;
  const w = width - left - right;
  const hgt = height - top - bottom;
  const values = [...entries.map((e) => e.deviationDeg), ...(fit ? deviationCard(fit, 5).map((c) => c.deviationDeg) : [])];
  const span = Math.max(1, ...values.map((v) => Math.abs(v)));
  const max = Math.ceil(span * 1.15);
  const x = (hdg: number): number => left + (norm360(hdg) / 360) * w;
  const y = (dev: number): number => top + hgt / 2 - (dev / max) * (hgt / 2);
  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'sfn-devchart',
    role: 'img',
    'aria-label': `Deviation against heading: ${entries.length} logged value${entries.length === 1 ? '' : 's'}${fit ? ' and the fitted curve' : ''}. East is up.`,
  }) as SVGSVGElement;
  const g = s('g', { class: 'sfn-devchart__grid' });
  for (const hdg of [0, 45, 90, 135, 180, 225, 270, 315, 360]) {
    g.appendChild(s('line', { x1: x(hdg === 360 ? 359.999 : hdg), y1: top, x2: x(hdg === 360 ? 359.999 : hdg), y2: top + hgt }));
    const t = s('text', { x: x(hdg === 360 ? 359.999 : hdg), y: height - 10, 'text-anchor': 'middle', class: 'sfn-devchart__tick' });
    t.textContent = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][hdg / 45]!;
    g.appendChild(t);
  }
  for (const v of [-max, 0, max]) {
    g.appendChild(s('line', { x1: left, y1: y(v), x2: left + w, y2: y(v), class: v === 0 ? 'sfn-devchart__zero' : '' }));
    const t = s('text', { x: left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'sfn-devchart__tick' });
    t.textContent = v === 0 ? '0°' : `${Math.abs(v)}° ${v > 0 ? 'E' : 'W'}`;
    g.appendChild(t);
  }
  svg.appendChild(g);
  if (fit) {
    const pts: string[] = [];
    for (let hdg = 0; hdg <= 360; hdg += 3) pts.push(`${x(hdg === 360 ? 359.999 : hdg).toFixed(1)},${y(deviationAt(fit, hdg)).toFixed(1)}`);
    svg.appendChild(s('polyline', { points: pts.join(' '), class: 'sfn-devchart__curve' }));
  }
  for (const e of entries) {
    svg.appendChild(s('circle', { cx: x(e.headingDeg).toFixed(1), cy: y(e.deviationDeg).toFixed(1), r: 4, class: 'sfn-devchart__point' }));
  }
  return svg;
}

export function deviationTableCard(nc: NavCtx): { el: HTMLElement; destroy(): void } {
  const d = disposer();
  const store = nc.working.store;
  const c = card('Deviation table', { term: 'this compass, heading by heading', iconName: 'compass', class: 'sfn-devtable' });
  c.body.append(
    para(
      'Deviation is this compass’s own error, from the ship’s steel and electrics, and it changes with her heading. Log it on as many headings as you can (a “swing” takes eight, every 45°): the table then gives the deviation on any heading, and with headings all round, the classic curve that fits them.',
      'sfn-plain',
    ),
  );
  const tableHost = h('div', { class: 'sfn-table-scroll' });
  const empty = para('Nothing logged yet. Work out a deviation above with the ship’s heading given, then “Add to the deviation table”, or type one below.', 'sfn-note sfn-muted');
  const status = h('p', { class: 'sfn-status', role: 'status' });

  // Typing one in (from a swing, or an old card).
  const hdgInput = textInput({ inputmode: 'decimal', size: 6, placeholder: '045' });
  const devInput = textInput({ size: 8, placeholder: '2.5 W' });
  const hdgField = field('Heading by this compass (°)', hdgInput);
  const devField = field('Deviation', devInput, { help: 'With its name: 2.5 W, 1.0 E.' });
  const add = btn('Add', () => {
    const hd = parseNumber(hdgInput.value, { what: 'The heading', min: 0, max: 360, unit: '°' });
    hdgField.setError(hd.ok ? null : hd.error);
    const dv = parseEastWest(devInput.value);
    devField.setError(dv === null || Math.abs(dv) > 90 ? 'Type the deviation with its name, for example 2.5 W.' : null);
    if (!hd.ok || dv === null || Math.abs(dv) > 90) return;
    const entry: DeviationEntry = { id: `dev-${Date.now().toString(36)}`, headingDeg: hd.value === 360 ? 0 : hd.value, deviationDeg: dv, utc: null, source: 'typed', note: '' };
    store.patch({ deviations: [...store.get().deviations, entry] });
    hdgInput.value = '';
    devInput.value = '';
    status.textContent = `Added heading ${heading3(entry.headingDeg)}, deviation ${eastWest(entry.deviationDeg)}.`;
  }, { icon: 'plus', variant: 'outline' });
  const clear = btn('Clear the table', () => {
    const before = store.get().deviations;
    if (!before.length) return;
    store.patch({ deviations: [] });
    const undo = btn('Undo', () => store.patch({ deviations: before }), { variant: 'outline' });
    status.replaceChildren(`Cleared ${before.length} entr${before.length === 1 ? 'y' : 'ies'}. `, undo);
  }, { variant: 'ghost' });

  // Reading the table on any heading.
  const lookup = textInput({ inputmode: 'decimal', size: 6, placeholder: '100' });
  const lookupField = field('Deviation on heading (°)', lookup, { class: 'sfn-devlookup' });
  const lookupOut = h('p', { class: 'sfn-note', 'aria-live': 'polite' });
  const readLookup = (): void => {
    const hd = parseNumber(lookup.value, { what: 'The heading', min: 0, max: 360, unit: '°' });
    if (!lookup.value.trim()) {
      lookupOut.textContent = '';
      return;
    }
    if (!hd.ok) {
      lookupOut.textContent = hd.error;
      return;
    }
    const entries = store.get().deviations;
    const i = interpolateDeviation(entries, hd.value);
    const fitted = fitDeviation(entries);
    if (!i) {
      lookupOut.textContent = 'The table needs deviations on at least two headings.';
      return;
    }
    const between =
      i.gapDeg === 0
        ? `logged on that heading (${i.from.source})`
        : `interpolated between ${heading3(i.from.headingDeg)} (${eastWest(i.from.deviationDeg)}) and ${heading3(i.to.headingDeg)} (${eastWest(i.to.deviationDeg)}), ${i.gapDeg.toFixed(0)}° apart${i.gapDeg > 90 ? ': a wide gap, so treat it as rough' : ''}`;
    lookupOut.textContent =
      `On ${heading3(hd.value)}: ${eastWest(i.deviationDeg)}, ${between}.` +
      (fitted.ok ? ` The fitted curve gives ${eastWest(deviationAt(fitted.fit, hd.value))}.` : '');
  };
  lookup.addEventListener('input', readLookup);

  const fitHost = h('div', { class: 'sfn-devfit' });
  c.body.append(
    tableHost,
    empty,
    h('div', { class: 'sfn-log__add' }, hdgField.el, devField.el, h('div', { class: 'sfn-log__actions' }, add, clear)),
    status,
    h('div', { class: 'sfn-log__add' }, lookupField.el),
    lookupOut,
    fitHost,
  );

  const render = (): void => {
    const entries = sortDeviations(store.get().deviations);
    empty.hidden = entries.length > 0;
    clear.hidden = entries.length === 0;
    tableHost.hidden = entries.length === 0;
    const table = h('table', { class: 'sf-table sfn-table' });
    table.append(
      h('caption', { class: 'sf-sr' }, 'Deviation by heading'),
      h('thead', {}, h('tr', {}, ...['Heading', 'Deviation', 'From', 'When', ''].map((t, i) => h('th', { scope: 'col', class: i < 2 ? 'sfn-num' : '' }, t || h('span', { class: 'sf-sr' }, 'Remove'))))),
      h(
        'tbody',
        {},
        ...entries.map((e) =>
          h(
            'tr',
            {},
            h('td', { class: 'sfn-num' }, heading3(e.headingDeg)),
            h('td', { class: 'sfn-num' }, eastWest(e.deviationDeg)),
            h('td', {}, e.source),
            h('td', { class: 'sfn-num' }, e.utc ? utcText(e.utc.replace(/\.\d+Z$/, 'Z')) : '—'),
            h(
              'td',
              {},
              btn('', () => {
                const before = store.get().deviations;
                store.patch({ deviations: before.filter((x) => x.id !== e.id) });
                const undo = btn('Undo', () => store.patch({ deviations: before }), { variant: 'outline' });
                status.replaceChildren(`Removed heading ${heading3(e.headingDeg)}. `, undo);
              }, { icon: 'close', variant: 'ghost', ariaLabel: `Remove the deviation on heading ${heading3(e.headingDeg)}` }),
            ),
          ),
        ),
      ),
    );
    tableHost.replaceChildren(table);

    const fitted = fitDeviation(entries);
    fitHost.replaceChildren();
    if (entries.length === 0) return;
    const chart = h('div', { class: 'sfn-figure sfn-devchart-wrap' }, deviationChart(entries, fitted.ok ? fitted.fit : null));
    if (!fitted.ok) {
      fitHost.append(chart, para(fitted.reason, 'sfn-note'));
      return;
    }
    const f0 = fitted.fit;
    const coef = (key: 'a' | 'b' | 'c' | 'd' | 'e', v: number) => h('li', {}, h('strong', { class: 'sfn-num' }, `${key.toUpperCase()} = ${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}°`), ` — ${COEFFICIENT_TEXT[key]}`);
    const cardRows = deviationCard(f0, 15);
    const cardTable = h(
      'table',
      { class: 'sf-table sfn-table sfn-devcard' },
      h('caption', { class: 'sf-sr' }, 'Deviation card from the fitted curve'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Heading'), h('th', { scope: 'col', class: 'sfn-num' }, 'Deviation'), h('th', { scope: 'col' }, 'Heading'), h('th', { scope: 'col', class: 'sfn-num' }, 'Deviation'))),
      h(
        'tbody',
        {},
        ...cardRows.slice(0, 12).map((r, i) => {
          const r2 = cardRows[i + 12]!;
          return h('tr', {}, h('td', { class: 'sfn-num' }, heading3(r.headingDeg)), h('td', { class: 'sfn-num' }, eastWest(r.deviationDeg)), h('td', { class: 'sfn-num' }, heading3(r2.headingDeg)), h('td', { class: 'sfn-num' }, eastWest(r2.deviationDeg)));
        }),
      ),
    );
    fitHost.append(
      h('h4', {}, 'The fitted curve ', h('span', { class: 'sfn-term' }, '· approximate coefficients A to E')),
      chart,
      para(
        `Deviation = A + B sin(heading) + C cos(heading) + D sin(2 × heading) + E cos(2 × heading), fitted to ${f0.n} logged values on headings no more than ${f0.maxGapDeg.toFixed(0)}° apart. ` +
          `It misses them by ${f0.rmsDeg.toFixed(2)}° (RMS)${f0.dof === 0 ? ': with exactly five values it passes through them all, so the misfit says nothing yet' : ''}. The curve models the ship; a compass adjuster uses these coefficients to place the correctors.`,
        'sfn-note',
      ),
      h('ul', { class: 'sfn-list sfn-devcoef' }, coef('a', f0.a), coef('b', f0.b), coef('c', f0.c), coef('d', f0.d), coef('e', f0.e)),
      h('details', { class: 'sfn-advanced' }, h('summary', {}, 'Deviation card from the curve, every 15°'), h('div', { class: 'sfn-table-scroll' }, cardTable)),
    );
    readLookup();
  };
  d.add(store.select((w) => w.deviations, render));
  render();
  return {
    el: c.el,
    destroy: () => {
      d.dispose();
      c.el.remove();
    },
  };
}
