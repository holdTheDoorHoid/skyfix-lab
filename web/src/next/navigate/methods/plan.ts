/**
 * Planning sights: tonight's twilight windows with the bodies to shoot (`plan_sights`),
 * and the old workbench's planner, which ranks the bodies up at any moment by what each
 * adds to the geometry (`plan`, docs/PLANNER.md). Both work from an approximate position
 * that is used to predict and never becomes a prior; both say which position they used.
 * OWNER: navigate agent.
 */

import { OBJECTIVES, type Objective, type Plan, type PlanMetrics } from '../../../api/adapter.js';
import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import { isoUtc, jdFromIso } from '../../time.js';
import { angleFormat, kindOf, zone, type NavCtx } from '../context.js';
import { fmtAngle, fmtBearing, fmtInstant, fmtMagnitude, fmtMetres, fmtPosition, positionInputText } from '../format.js';
import { plannerOptionsFor, type PlannedSight, type PlannerForm, type Working } from '../model.js';
import { parsePosition, type Parsed } from '../parse.js';
import { PLANNER_DISCLOSURES } from '../text.js';
import { tonightSights } from '../tonight.js';
import { btn, card, errorText, field, kids, notice, para, parsedField, selectInput } from '../ui.js';
import { autoRun, methodFrame, numberField, optionalUtcField } from './common.js';

function metricsRow(label: string, m: PlanMetrics): HTMLElement {
  return h(
    'tr',
    {},
    h('th', { scope: 'row' }, label),
    h('td', {}, String(m.sight_count)),
    h('td', {}, m.sigma_north_m === null || m.sigma_east_m === null ? 'singular (no finite value)' : `${fmtMetres(m.sigma_north_m)} / ${fmtMetres(m.sigma_east_m)}`),
    h(
      'td',
      {},
      m.semi_major_sigma_m === null || m.semi_minor_sigma_m === null
        ? 'singular (no finite value)'
        : `${fmtMetres(m.semi_major_sigma_m)} × ${fmtMetres(m.semi_minor_sigma_m)}${m.semi_major_azimuth_deg === null ? '' : ` at ${m.semi_major_azimuth_deg.toFixed(0)}°`}`,
    ),
    h('td', {}, fmtMagnitude(m.condition_number)),
    h('td', {}, `${m.max_azimuth_gap_deg.toFixed(0)}°`),
  );
}

export function planMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'plan');
  f.chart.el.hidden = true;
  const store = nc.working.store;
  const set = (patch: Partial<PlannerForm>): void => store.patch({ planner: { ...store.get().planner, ...patch } });

  // --- Tonight -----------------------------------------------------------------------------
  const tonightCard = card('Tonight’s sights', { class: 'sfn-plan-tonight', iconName: 'sextant' });
  const tonightNote = para('', 'sfn-note');
  tonightCard.body.append(tonightNote);
  f.inputs.append(tonightCard.el);
  const tonight = tonightSights({ compact: false, from: 'dr', openNavigate: false })(tonightCard.body, nc.ctx);
  f.track(() => tonight.destroy());
  const renderTonightNote = (): void => {
    const ap = store.get().session.observer.assumed_position;
    tonightNote.textContent = ap
      ? 'From the time on the time bar, for the session’s assumed position, with its height of eye and index correction. “Use these bodies” lists them beside the sight form as bodies to shoot.'
      : 'From the time on the time bar, for the map’s place (the session has no assumed position), with the instrument settings. “Use these bodies” lists them beside the sight form.';
  };
  renderTonightNote();
  f.track(store.select((w) => w.session.observer.assumed_position, renderTonightNote));

  // --- The planner at any moment --------------------------------------------------------------
  const plannerCard = card('Rank the bodies at any moment', { class: 'sfn-plan-rank', term: 'planner', iconName: 'list' });
  plannerCard.body.append(
    h('ol', { class: 'sfn-disclosures' }, ...PLANNER_DISCLOSURES.map((dsc) => h('li', {}, h('strong', {}, dsc.strong), dsc.text))),
  );
  const position = parsedField<{ lat_deg: number; lon_deg: number } | null>('Approximate position', {
    term: 'planning input only',
    placeholder: 'the DR, or the map’s place',
    help: 'Empty: the session’s assumed position, or the map’s place. It predicts where the bodies are; it is never a prior on a fix.',
    parse: (t): Parsed<{ lat_deg: number; lon_deg: number } | null> => (t.trim() ? parsePosition(t) : { ok: true, value: null }),
    format: (p) => (p ? positionInputText(p) : ''),
    read: () => store.get().planner.position,
    commit: (p) => set({ position: p }),
  });
  const utc = optionalUtcField(nc, 'For the moment (UTC)', 'the time on the time bar', () => store.get().planner.utc, (v) => set({ utc: v }));
  const count = numberField('How many sights to plan', { min: 1, max: 12 }, () => store.get().planner.select, (v) => set({ select: Math.round(v) }));
  const objective = selectInput<Objective>(OBJECTIVES.map((o) => ({ value: o.value, label: o.label })), store.get().planner.objective);
  const objectiveField = field('What to make smallest', objective, { help: OBJECTIVES.find((o) => o.value === store.get().planner.objective)?.note ?? null });
  objective.addEventListener('change', () => {
    set({ objective: objective.value as Objective });
    objectiveField.setHelp(OBJECTIVES.find((o) => o.value === objective.value)?.note ?? null);
  });
  const minAlt = numberField('Lowest altitude (°)', { min: 0, max: 89, help: 'Below about 15° the refraction model is the weak link, not the sextant.' }, () => store.get().planner.minAlt, (v) => set({ minAlt: v }));
  const maxAlt = numberField('Highest altitude (°)', { min: 1, max: 90, help: 'Near the zenith the bearing changes too fast to measure against a horizon.' }, () => store.get().planner.maxAlt, (v) => set({ maxAlt: v }));
  const sigma = numberField('Assumed sight uncertainty (′)', { min: 0, exclusiveMin: true, help: 'What the prediction assumes each sight is worth.' }, () => store.get().planner.baseSigma, (v) => set({ baseSigma: v }));
  plannerCard.body.append(
    h('div', { class: 'sfn-grid-2' }, position.el, utc.el),
    h('div', { class: 'sfn-grid-3' }, count.el, objectiveField.el, sigma.el),
    h('div', { class: 'sfn-grid-2' }, minAlt.el, maxAlt.el),
  );
  const rankStatus = h('div', { class: 'sfn-method__status', role: 'status' });
  const rankResults = h('div', { class: 'sfn-method__results' });
  plannerCard.body.append(rankStatus, rankResults);
  f.results.append(plannerCard.el);

  const inputs = (w: Working): { position: { lat_deg: number; lon_deg: number }; utc: string; source: string } => {
    const place = nc.ctx.store.get().observer;
    const p = w.planner.position ?? w.session.observer.assumed_position ?? { lat_deg: place.lat_deg, lon_deg: place.lon_deg };
    const source = w.planner.position ? 'the position you typed' : w.session.observer.assumed_position ? 'the session’s assumed position' : 'the map’s place';
    return { position: p, utc: w.planner.utc ?? isoUtc(nc.ctx.store.get().time.jd_utc).replace('.000Z', 'Z'), source };
  };

  const useRanked = (plan: Plan): void => {
    if (!nc.nav) return;
    const w = store.get();
    const jd = jdFromIso(plan.utc) ?? nc.ctx.store.get().time.jd_utc;
    const out: PlannedSight[] = [];
    for (const b of plan.bodies) {
      const kind = kindOf(nc, b.body);
      const limb = kind === 'moon' || kind === 'sun' ? 'lower' : 'center';
      try {
        const p = nc.nav.predictSextant(
          { lat_deg: plan.approximate_position.lat_deg, lon_deg: plan.approximate_position.lon_deg, height_of_eye_m: w.session.observer.height_of_eye_m, pressure_hpa: w.session.observer.pressure_hpa, temperature_c: w.session.observer.temperature_c },
          { index_correction_arcmin: w.session.instrument.index_correction_arcmin, horizon: w.session.instrument.horizon },
          b.body,
          limb,
          jd,
        );
        out.push({ body: b.body, kind, limb, utc: p.utc, hs_deg: p.hs_deg, hc_deg: p.hc_deg, zn_deg: p.zn_deg, from: 'Planner ranking' });
      } catch {
        // A body below the visible horizon for this instrument is simply not added.
      }
    }
    const keep = w.planned.filter((p) => !out.some((o) => o.body === p.body));
    store.patch({ planned: [...keep, ...out] });
    nc.say(`${out.length} bodies added to “To shoot”, with predicted readings from the engine as a guide.`);
  };

  f.track(
    autoRun(nc, (w: Working) => [w.planner, w.session.observer.assumed_position, w.session.instrument] as const, async (isCurrent) => {
      for (const x of [position, utc, count, minAlt, maxAlt, sigma]) x.refresh();
      objective.value = store.get().planner.objective;
      const w = store.get();
      const { position: p, utc: when, source } = inputs(w);
      rankStatus.replaceChildren(h('span', { class: 'sfn-busy' }, 'Ranking…'));
      let plan: Plan;
      try {
        plan = await nc.api.plan(p, when, plannerOptionsFor(w));
      } catch (error) {
        if (!isCurrent()) return;
        rankStatus.replaceChildren(notice('error', errorText(error)));
        rankResults.replaceChildren();
        return;
      }
      if (!isCurrent()) return;
      rankStatus.replaceChildren();
      const format = angleFormat(nc);
      const z = zone(nc);
      const jd = jdFromIso(plan.utc);
      const metrics = h('table', { class: 'sf-table sfn-table' });
      metrics.appendChild(h('thead', {}, h('tr', {}, ...['Stage', 'Sights', 'North / east 1 sigma', 'Ellipse axes 1 sigma', 'Condition number', 'Largest bearing gap'].map((t) => h('th', { scope: 'col' }, t)))));
      const tb = h('tbody', {}, metricsRow('Before (what you already have)', plan.baseline));
      for (const m of plan.progression) {
        const taken = m.sight_count - plan.baseline.sight_count;
        if (taken <= 0) continue;
        tb.appendChild(metricsRow(`After ${plan.bodies[taken - 1]?.body ?? `pick ${taken}`}`, m));
      }
      tb.appendChild(metricsRow('Predicted total', plan.predicted));
      metrics.appendChild(tb);
      rankResults.replaceChildren(...kids(
        notice(
          'info',
          h('strong', {}, 'The position this plan assumed: '),
          `${fmtPosition(plan.approximate_position, format)} (${source}) at ${jd !== null ? fmtInstant(jd, z) : plan.utc}. Change either and the ranking changes. This position was used for prediction only, never as a prior.`,
        ),
        plan.bodies.length
          ? h(
              'ol',
              { class: 'sfn-ranked' },
              ...plan.bodies.map((b) =>
                h(
                  'li',
                  {},
                  h('strong', {}, b.body),
                  // The planner's altitude is the tables' Hc (from the Earth's centre, no refraction,
                  // no parallax), not the height above the horizon the other views show.
                  ` — computed altitude Hc ${fmtAngle(b.altitude_deg, format)}, bearing Zn ${fmtBearing(b.azimuth_deg)}${b.magnitude === null ? '' : `, magnitude ${b.magnitude.toFixed(1)}`}`,
                  h('div', { class: 'sfn-muted' }, `score ${b.score.toFixed(3)} ${b.score_units}`),
                  h('div', {}, b.rationale),
                ),
              ),
            )
          : para('Nothing was ranked: widen the altitude range, or try another time.', 'sfn-note'),
        plan.bodies.length ? h('div', { class: 'sfn-export' }, btn('Use these bodies', () => useRanked(plan), { icon: 'plus', variant: 'outline' })) : null,
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Predicted uncertainty, sight by sight'), para('What the uncertainty becomes as each planned sight is added: predictions from the geometry and the assumed sight uncertainty, not measurements.', 'sfn-note'), h('div', { class: 'sfn-table-scroll' }, metrics)),
        plan.excluded.length
          ? h('section', { class: 'sfn-sub' }, h('h3', {}, `Considered and left out (${plan.excluded.length})`), h('ul', { class: 'sfn-list' }, ...plan.excluded.map((e) => h('li', {}, h('strong', {}, e.body), ` — Hc ${fmtAngle(e.altitude_deg, format)}, Zn ${fmtBearing(e.azimuth_deg)}: ${e.reason}`))))
          : null,
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'What this plan discloses'), h('ul', { class: 'sfn-list' }, ...plan.notes.map((n) => h('li', {}, n)))),
      ));
    }),
  );
  return { destroy: () => f.destroy() };
}
