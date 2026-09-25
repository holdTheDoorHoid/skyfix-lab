/**
 * Lunar distance: Greenwich time from the Moon's distance to the Sun, a star or a planet,
 * cleared of semidiameters, refraction and parallax, with the time's uncertainty broken
 * down term by term (docs/NAVIGATION_SKY.md section 4). OWNER: navigate agent.
 */

import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import type { LunarDistanceResult, SightLimb } from '../../engine/types.js';
import { bodyGlyph } from '../../theme/glyphs.js';
import { readout } from '../../theme/primitives.js';
import { angleFormat, kindOf, zone, type NavCtx } from '../context.js';
import { angleInputText, fmtAngle, fmtArcmin, fmtBearing, fmtInstant, fmtNum, fmtSeconds, fmtUtcClock } from '../format.js';
import { lunarInputFor, type LunarAltitudeForm, type LunarForm, type Working } from '../model.js';
import { parseAngle, type Parsed } from '../parse.js';
import { LIMB_TEXT, LUNAR_STEP_TEXT } from '../text.js';
import { errorText, facts, field, kids, notice, para, parsedField, selectInput, warningList } from '../ui.js';
import { autoRun, drSigmaField, methodFrame, numberField, optionalUtcField, publish } from './common.js';

export function lunarMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'lunar');
  // A lunar distance's answer is a time: there is nothing to draw.
  f.chart.el.hidden = true;
  const store = nc.working.store;
  const set = (patch: Partial<LunarForm>): void => store.patch({ lunar: { ...store.get().lunar, ...patch } });
  const lunar = (): LunarForm => store.get().lunar;

  const others = nc.bodies.filter((b) => b.kind !== 'moon');
  const body = selectInput<string>(
    others.map((b) => ({ value: b.body, label: b.body, group: b.kind === 'sun' ? 'The Sun' : b.kind === 'planet' ? 'Planets' : 'Stars (A–Z)' })).sort((a, b) => (a.group === b.group ? (a.group === 'Stars (A–Z)' ? a.label.localeCompare(b.label) : 0) : 0)),
    lunar().body,
  );
  body.addEventListener('change', () => set({ body: body.value }));
  const glyph = h('span', { class: 'sfn-entry__glyph', 'aria-hidden': 'true' });
  const watch = optionalUtcField(nc, 'Your watch when you measured (UTC)', 'enter it', () => lunar().watchUtc, (v) => set({ watchUtc: v }));
  const distance = parsedField<number | null>('Measured distance', {
    term: 'sextant reading, degrees and minutes',
    placeholder: '74 14.4',
    inputmode: 'decimal',
    size: 10,
    help: 'Moon’s edge to the other body, as the sextant read it.',
    parse: (t): Parsed<number | null> => (t.trim() ? parseAngle(t, { min: 0, max: 180, what: 'The distance', example: '74 14.4' }) : { ok: true, value: null }),
    format: (v) => (v === null ? '' : angleInputText(v, 2)),
    read: () => lunar().distanceDeg,
    commit: (v) => set({ distanceDeg: v }),
  });
  const moonLimb = selectInput<'near' | 'far'>(
    [
      { value: 'near', label: 'Near edge (towards the other body)' },
      { value: 'far', label: 'Far edge' },
    ],
    lunar().moonLimb,
  );
  moonLimb.addEventListener('change', () => set({ moonLimb: moonLimb.value as 'near' | 'far' }));
  const bodyLimb = selectInput<'near' | 'far' | 'center'>(
    [
      { value: 'near', label: 'Sun’s near edge' },
      { value: 'far', label: 'Sun’s far edge' },
      { value: 'center', label: 'Sun’s centre' },
    ],
    lunar().bodyLimb,
  );
  bodyLimb.addEventListener('change', () => set({ bodyLimb: bodyLimb.value as 'near' | 'far' | 'center' }));
  const bodyLimbField = field('Which edge of the Sun', bodyLimb);

  const altitudeField = (label: string, which: 'moonAltitude' | 'bodyAltitude', withLimb: boolean) => {
    const a = (): LunarAltitudeForm => lunar()[which];
    const input = parsedField<number | null>(label, {
      term: 'Hs, optional',
      placeholder: 'computed from the DR',
      inputmode: 'decimal',
      size: 10,
      help: 'Observed altitudes are better; empty: computed from the DR at each trial time.',
      parse: (t): Parsed<number | null> => (t.trim() ? parseAngle(t, { min: -1, max: 90, what: 'The altitude' }) : { ok: true, value: null }),
      format: (v) => (v === null ? '' : angleInputText(v, 2)),
      read: () => a().deg,
      commit: (v) => set({ [which]: { ...a(), deg: v } } as Partial<LunarForm>),
    });
    const limb = selectInput<SightLimb>((['lower', 'center', 'upper'] as SightLimb[]).map((l) => ({ value: l, label: LIMB_TEXT[l] })), a().limb);
    limb.addEventListener('change', () => set({ [which]: { ...a(), limb: limb.value as SightLimb } } as Partial<LunarForm>));
    const limbField = field('Edge measured for the altitude', limb);
    limbField.el.hidden = !withLimb;
    return { el: h('div', { class: 'sfn-grid-2' }, input.el, limbField.el), input, limb, limbField };
  };
  const moonAlt = altitudeField('Moon’s altitude', 'moonAltitude', true);
  const bodyAlt = altitudeField('Other body’s altitude', 'bodyAltitude', true);
  const sigma = numberField('Distance uncertainty (′, 1 sigma)', { min: 0, exclusiveMin: true }, () => lunar().sigmaArcmin, (v) => set({ sigmaArcmin: v }));
  const hours = numberField('Search either side of the watch (hours)', { min: 1, max: 48 }, () => lunar().searchHours, (v) => set({ searchHours: v }));
  const drSigma = drSigmaField(() => lunar().drSigmaNm, (v) => set({ drSigmaNm: v }));
  const where = para('', 'sfn-note');

  f.inputs.append(
    h('div', { class: 'sfn-entry__body' }, glyph, field('The other body', body, { help: 'The Sun, a planet or one of the stars near the Moon’s path.' }).el),
    h('div', { class: 'sfn-grid-2' }, distance.el, watch.el),
    h('div', { class: 'sfn-grid-2' }, field('Which edge of the Moon', moonLimb, { term: 'Moon’s limb' }).el, bodyLimbField.el),
    h('fieldset', { class: 'sfn-group' }, h('legend', {}, 'Altitudes (optional)'), moonAlt.el, bodyAlt.el),
    h('div', { class: 'sfn-grid-3' }, sigma.el, hours.el, drSigma.el),
    where,
  );

  const syncUi = (): void => {
    const w = store.get();
    const kind = kindOf(nc, w.lunar.body);
    glyph.replaceChildren(bodyGlyph(w.lunar.body, { kind, size: 20 }));
    body.value = w.lunar.body;
    moonLimb.value = w.lunar.moonLimb;
    bodyLimb.value = w.lunar.bodyLimb;
    bodyLimbField.el.hidden = kind !== 'sun';
    bodyAlt.limbField.el.hidden = kind !== 'sun';
    moonAlt.limb.value = w.lunar.moonAltitude.limb;
    bodyAlt.limb.value = w.lunar.bodyAltitude.limb;
    for (const x of [watch, distance, moonAlt.input, bodyAlt.input, sigma, hours, drSigma]) x.refresh();
    const ap = w.session.observer.assumed_position;
    const place = nc.ctx.store.get().observer;
    where.textContent = ap
      ? `DR: the session’s assumed position. Height of eye ${w.session.observer.height_of_eye_m} m, index correction ${fmtArcmin(w.session.instrument.index_correction_arcmin, 1)} and the horizon come from the session settings.`
      : `DR: no assumed position in the session, so the map’s place (${place.label || 'the place set on the map'}) is used. Height of eye and index correction come from the session settings.`;
  };

  f.track(
    autoRun(nc, (w: Working) => [w.lunar, w.session.observer, w.session.instrument] as const, async (isCurrent) => {
      syncUi();
      publish(nc, null);
      if (!nc.nav) {
        f.setStatus({ missing: nc.navMissing ?? 'No navigation tools.' });
        return;
      }
      const o = nc.ctx.store.get().observer;
      const made = lunarInputFor(store.get(), { lat_deg: o.lat_deg, lon_deg: o.lon_deg });
      if ('missing' in made) {
        f.setStatus({ missing: made.missing });
        f.results.replaceChildren();
        f.details.replaceChildren();

        return;
      }
      f.setStatus('busy');
      let r: LunarDistanceResult;
      try {
        r = nc.nav.lunarDistance(made.input);
      } catch (error) {
        if (!isCurrent()) return;
        f.setStatus({ error: errorText(error) });
        f.results.replaceChildren();
        f.details.replaceChildren();
        return;
      }
      if (!isCurrent()) return;
      f.setStatus('idle');
      const format = angleFormat(nc);
      const z = zone(nc, r.jd_utc);
      const slow = r.utc_minus_estimate_s >= 0;
      const steps = h('table', { class: 'sf-table sfn-table' });
      steps.appendChild(h('thead', {}, h('tr', {}, ...['Step', 'Change', 'Distance after'].map((t) => h('th', { scope: 'col' }, t)))));
      steps.appendChild(
        h(
          'tbody',
          {},
          h('tr', {}, h('th', { scope: 'row' }, 'Sextant reading'), h('td', {}, ''), h('td', {}, fmtAngle(made.input.distance_deg, format))),
          ...r.clearing.map((c) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, LUNAR_STEP_TEXT[c.kind].plain, ' ', h('span', { class: 'sfn-term' }, `· ${LUNAR_STEP_TEXT[c.kind].term}`), h('span', { class: 'sfn-workings__note' }, c.note)),
              h('td', {}, fmtArcmin(c.delta_arcmin, 2)),
              h('td', {}, fmtAngle(c.after_deg, format)),
            ),
          ),
        ),
      );
      const budget = h('table', { class: 'sf-table sfn-table' });
      budget.appendChild(h('thead', {}, h('tr', {}, ...['Source', 'In the distance', 'In the time'].map((t) => h('th', { scope: 'col' }, t)))));
      budget.appendChild(h('tbody', {}, ...r.error_budget.map((e) => h('tr', {}, h('th', { scope: 'row' }, e.name), h('td', {}, `${fmtNum(e.distance_arcmin, 3)}′`), h('td', {}, fmtSeconds(e.time_s))))));
      f.results.replaceChildren(...kids(
        h(
          'div',
          { class: 'sf-readouts sfn-readouts' },
          readout({ value: fmtUtcClock(r.jd_utc), label: `Greenwich time ± ${fmtSeconds(r.sigma_s)} (1 sigma)`, term: `${fmtInstant(r.jd_utc, z)}` }),
          readout({ value: fmtSeconds(Math.abs(r.utc_minus_estimate_s)), label: `Your watch is ${slow ? 'SLOW' : 'FAST'}: ${slow ? 'add' : 'take off'} this`, term: 'watch error' }),
        ),
        para(
          `That time is good to about ${fmtNum(r.longitude_sigma_arcmin, 1)}′ of longitude (${fmtNum(r.longitude_sigma_nm, 1)} NM east–west): the distance changes ${fmtNum(Math.abs(r.distance_rate_arcmin_per_min), 3)}′ a minute, so every 0.1′ of distance is ${fmtSeconds((0.1 / Math.max(Math.abs(r.distance_rate_arcmin_per_min), 1e-6)) * 60)} of time.`,
          'sfn-plain',
        ),
        r.alternatives.length ? notice('caution', `The same distance also occurs at ${r.alternatives.map((a) => fmtInstant(a.jd_utc, z)).join('; ')}. The instant nearest your watch is given.`) : null,
        facts([
          ['Apparent distance, centre to centre', fmtAngle(r.apparent_distance_deg, format)],
          ['Cleared (from the Earth’s centre)', fmtAngle(r.cleared_distance_deg, format)],
          ['Moon', `${r.altitudes.moon_source} altitude ${fmtAngle(r.altitudes.moon_apparent_deg, format)} apparent, ${fmtAngle(r.altitudes.moon_true_deg, format)} true, bearing ${fmtBearing(r.altitudes.moon_azimuth_deg)}; computed from the DR: ${fmtAngle(r.altitudes.moon_computed_apparent_deg, format)}`],
          [r.body, `${r.altitudes.body_source} altitude ${fmtAngle(r.altitudes.body_apparent_deg, format)} apparent, ${fmtAngle(r.altitudes.body_true_deg, format)} true, bearing ${fmtBearing(r.altitudes.body_azimuth_deg)}; computed from the DR: ${fmtAngle(r.altitudes.body_computed_apparent_deg, format)}`],
          ['If the DR is 10 NM off', `the cleared distance moves ${fmtNum(r.dr_sensitivity_arcmin_per_10nm[0], 3)}′ (north) and ${fmtNum(r.dr_sensitivity_arcmin_per_10nm[1], 3)}′ (east)`],
        ]),
      ));
      f.details.replaceChildren(
        h('section', { class: 'sfn-sub sfn-sub--first' }, h('h3', {}, 'Clearing the distance, step by step'), h('div', { class: 'sfn-table-scroll' }, steps)),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Where the time’s uncertainty comes from'), h('div', { class: 'sfn-table-scroll' }, budget)),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Notes'), h('ul', { class: 'sfn-list' }, ...r.notes.map((n) => h('li', {}, n)))),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Warnings'), warningList(r.warnings, 'No warnings.')),
      );
    }),
  );
  return { destroy: () => f.destroy() };
}
