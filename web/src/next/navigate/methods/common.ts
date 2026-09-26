/**
 * Pieces the method panels share: the panel frame (heading, explanation, inputs, status,
 * results and the chart), a runner that recomputes a moment after the inputs change and
 * never shows a stale answer, and the inputs several methods take (the DR's uncertainty,
 * the vessel's course and speed, the run's body, an optional instant, the solve options,
 * GPX export). OWNER: navigate agent.
 */

import { h } from '../../../dom.js';
import { disposer, type Mounted } from '../../component.js';
import type { ExplorerState } from '../../state.js';
import { jdFromIso } from '../../time.js';
import { CLOCK, dtChip, setUncertaintyChip, uncertaintyChip } from '../../time/chip.js';
import { scaleLabel } from '../../time/scale.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import { chartPanel, type ChartPanel } from '../chart-panel.js';
import { fmtInstant, fmtPosition, utcInputText } from '../format.js';
import { fileStem, gpxDocument, type GpxPlan } from '../gpx.js';
import { bodyCounts, type SolveForm, type VesselForm, type Working } from '../model.js';
import { clearOverlays, publishOverlays, type OverlayData } from '../overlays.js';
import { parseNumber, parseOptionalNumber, parseUtcInput, type Parsed } from '../parse.js';
import { METHODS, type MethodId } from '../text.js';
import { btn, card, checkbox, debounce, download, errorText, field, notice, para, parsedField, selectInput, type ParsedField } from '../ui.js';

export interface MethodFrame extends Mounted {
  inputs: HTMLElement;
  status: HTMLElement;
  /** The headline answer, right under the inputs. */
  results: HTMLElement;
  chart: ChartPanel;
  /** The workings behind the answer (tables, residuals, warnings), under the chart. */
  details: HTMLElement;
  /** Show "working it out", an error, or nothing. */
  setStatus(state: 'idle' | 'busy' | { error: string } | { missing: string }): void;
  /** Run `fn` when the panel is destroyed (subscriptions). */
  track(fn: () => void): void;
}

export type Track = (fn: () => void) => void;

/** The method's card (heading, plain explanation, inputs) and its results and chart. */
export function methodFrame(host: HTMLElement, nc: NavCtx, id: MethodId): MethodFrame {
  const d = disposer();
  const text = METHODS.find((m) => m.id === id)!;
  const c = card(text.title, { class: `sfn-method sfn-method--${id}`, iconName: 'sextant' });
  c.body.append(para(text.explain, 'sfn-plain sfn-method__explain'));
  const inputs = h('div', { class: 'sfn-method__inputs' });
  const status = h('div', { class: 'sfn-method__status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'sfn-method__results' });
  c.body.append(inputs, status, results);
  const chart = chartPanel(nc);
  const detailsCard = card('How it was worked out', { class: 'sfn-details', iconName: 'list' });
  const details = detailsCard.body;
  // The details card shows only when it has something in it.
  const observer = new MutationObserver(() => {
    detailsCard.el.hidden = details.childElementCount === 0;
  });
  observer.observe(details, { childList: true });
  detailsCard.el.hidden = true;
  host.append(c.el, chart.el, detailsCard.el);
  d.add(() => observer.disconnect());
  d.add(() => c.el.remove());
  d.add(() => chart.destroy());
  d.add(() => detailsCard.el.remove());
  return {
    inputs,
    status,
    results,
    chart,
    details,
    setStatus(state) {
      if (state === 'idle') status.replaceChildren();
      else if (state === 'busy') status.replaceChildren(h('span', { class: 'sfn-busy' }, 'Working it out…'));
      else if ('error' in state) status.replaceChildren(notice('error', h('strong', {}, 'The core could not do this: '), state.error));
      else status.replaceChildren(notice('info', state.missing));
    },
    track: (fn) => d.add(fn),
    destroy: () => d.dispose(),
  };
}

/**
 * Run `compute` now and again `delayMs` after any of `deps` changes. A run that finishes
 * after a newer one started is dropped, so a slow answer never replaces a newer one.
 */
export function autoRun(
  nc: NavCtx,
  deps: (w: Working) => readonly unknown[],
  compute: (isCurrent: () => boolean) => Promise<void> | void,
  delayMs = 200,
  explorerDeps?: (s: ExplorerState) => unknown,
): () => void {
  let seq = 0;
  const run = debounce(() => {
    const my = ++seq;
    void Promise.resolve()
      .then(() => compute(() => my === seq))
      .catch((error: unknown) => console.error('navigate method failed', errorText(error)));
  }, delayMs);
  const stop = nc.working.store.select(deps, () => run.run(), {
    equals: (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i])),
  });
  const stopFormat = nc.ctx.store.select(
    (s) => [s.settings.angleFormat, s.settings.timeDisplay, s.observer.zone] as const,
    () => run.run(),
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
  );
  const stopExplorer = explorerDeps ? nc.ctx.store.select(explorerDeps, () => run.run()) : () => undefined;
  run.now();
  return () => {
    stop();
    stopFormat();
    stopExplorer();
    run.cancel();
    seq += 1;
  };
}

// ---------------------------------------------------------------------------------------
// Inputs several methods take
// ---------------------------------------------------------------------------------------

export function drSigmaField(read: () => number | null, commit: (v: number | null) => void): ParsedField {
  return parsedField<number | null>('How far off the DR could be (NM, 1 sigma)', {
    term: 'DR uncertainty',
    help: 'Leave empty if you do not know: nothing will guess it for you, and the result says what that leaves out.',
    inputmode: 'decimal',
    size: 6,
    parse: (t) => parseOptionalNumber(t, { what: 'The DR uncertainty', min: 0, exclusiveMin: true, unit: 'NM' }),
    format: (v) => (v === null ? '' : String(v)),
    read,
    commit,
  });
}

/** The session's DR as a sentence, with where to change it. */
export function drLine(nc: NavCtx, track: Track): HTMLElement {
  const out = h('p', { class: 'sfn-note' });
  const render = (): void => {
    const ap = nc.working.store.get().session.observer.assumed_position;
    out.replaceChildren(
      ap
        ? h('span', {}, 'DR (your assumed position): ', h('strong', { class: 'sfn-num' }, fmtPosition(ap, angleFormat(nc))), '. Change it in the session settings. It is used to choose and to predict, never as a prior.')
        : h('span', {}, 'This method needs a DR: set an assumed position in the session settings.'),
    );
  };
  render();
  track(nc.working.store.select((w) => w.session.observer.assumed_position, render));
  track(nc.ctx.store.select((st) => st.settings.angleFormat, render));
  return out;
}

export function vesselFields(read: () => VesselForm, commit: (v: VesselForm) => void): { el: HTMLElement; fields: ParsedField[] } {
  const course = parsedField<number | null>('Course (° true)', {
    inputmode: 'decimal',
    size: 5,
    parse: (t) => parseOptionalNumber(t, { what: 'The course', min: 0, max: 360, unit: '°' }),
    format: (v) => (v === null ? '' : String(v)),
    read: () => read().course_deg,
    commit: (v) => commit({ ...read(), course_deg: v }),
  });
  const speed = parsedField<number | null>('Speed (knots)', {
    inputmode: 'decimal',
    size: 5,
    parse: (t) => parseOptionalNumber(t, { what: 'The speed', min: 0, max: 60, unit: 'kn' }),
    format: (v) => (v === null ? '' : String(v)),
    read: () => read().speed_kn,
    commit: (v) => commit({ ...read(), speed_kn: v }),
  });
  const v = read();
  const el = h(
    'details',
    { class: 'sfn-advanced', open: v.course_deg !== null || v.speed_kn !== null },
    h('summary', {}, 'Under way? The vessel’s course and speed during the sights'),
    para('Constant course and speed over the ground during the run. Leave both empty when stationary.', 'sfn-note sfn-muted'),
    h('div', { class: 'sfn-grid-2' }, course.el, speed.el),
  );
  return { el, fields: [course, speed] };
}

/** A select of the bodies in the session, most sights first. */
export function runBodySelect(nc: NavCtx, track: Track, read: () => string | null, commit: (v: string | null) => void, label = 'Body of the run'): { el: HTMLElement; refresh(): void } {
  const select = selectInput<string>([], '');
  const f = field(label, select, { help: null });
  const refresh = (): void => {
    const counts = bodyCounts(nc.working.store.get().session);
    select.replaceChildren(...counts.map((c) => h('option', { value: c.body }, `${c.body} (${c.count} sight${c.count === 1 ? '' : 's'})`)));
    const wanted = read();
    const hit = counts.find((c) => c.body.toLowerCase() === (wanted ?? '').toLowerCase()) ?? counts[0];
    if (hit) select.value = hit.body;
    select.disabled = counts.length === 0;
    f.setHelp(counts.length ? null : 'No sights yet.');
  };
  select.addEventListener('change', () => commit(select.value || null));
  refresh();
  track(nc.working.store.select((w) => w.session.observations, refresh));
  return { el: f.el, refresh };
}

/**
 * An optional instant on the app's clock ("empty: the default"). The label's "(UTC)" and the
 * help follow the clock's scale (UT outside 1972-2035, time-ui's `scaleLabel`) of the typed
 * time, or of the time bar's while the field is empty, and the ±ΔT chip stands beside it
 * when that time carries an uncertainty (polish2, list item 33: the running fix, noon,
 * lunar, Polaris, average, plan, compass and passage fields said "(UTC)" in any year).
 */
export function optionalUtcField(
  nc: NavCtx,
  label: string,
  emptyMeans: string,
  read: () => string | null,
  commit: (v: string | null) => void,
  note = '',
): ParsedField {
  // `label` is the words alone ("Fix for the moment"); the clock's word, and `note`
  // ("optional"), go in brackets after it.
  const labelAt = (jd: number): string => `${label} (${scaleLabel(jd)}${note ? `, ${note}` : ''})`;
  const chip = uncertaintyChip(null);
  const f = parsedField<string | null>(labelAt(nc.ctx.store.get().time.jd_utc), {
    help: `Empty: ${emptyMeans}.`,
    placeholder: 'yyyy-mm-dd hh:mm:ss',
    size: 20,
    aside: chip,
    parse: (t): Parsed<string | null> => (t.trim() ? parseUtcInput(t) : { ok: true, value: null }),
    format: (v) => (v ? utcInputText(v) : ''),
    read,
    commit,
  });
  let shown = '';
  const update = (): void => {
    const v = read();
    const typed = v ? jdFromIso(v) : null;
    const jd = typed ?? nc.ctx.store.get().time.jd_utc;
    const word = scaleLabel(jd);
    const text = labelAt(jd);
    if (text !== shown) {
      shown = text;
      f.parts.setLabel(text);
    }
    f.parts.setHelp(typed !== null ? `= ${fmtInstant(typed, zone(nc, typed))}` : `${word}. Empty: ${emptyMeans}.`);
    setUncertaintyChip(chip, dtChip(nc.ctx, jd, CLOCK));
  };
  f.input.addEventListener('change', update);
  // While the field is empty it means the time bar's time: follow that instant's scale and
  // uncertainty (a day at a time). The subscription ends with the field (the next change
  // after the view is gone finds it disconnected).
  const stop = nc.ctx.store.select(
    (s) => (read() ? '' : `${scaleLabel(s.time.jd_utc)}|${Math.round(s.time.jd_utc)}`),
    () => {
      if (!f.el.isConnected) stop();
      else update();
    },
  );
  update();
  return f;
}

export function numberField(label: string, options: { term?: string; help?: string; min?: number; max?: number; unit?: string; exclusiveMin?: boolean }, read: () => number, commit: (v: number) => void): ParsedField {
  return parsedField<number>(label, {
    term: options.term,
    help: options.help,
    inputmode: 'decimal',
    size: 6,
    parse: (t) => parseNumber(t, { what: label.replace(/ \(.*\)$/, ''), min: options.min, max: options.max, unit: options.unit, exclusiveMin: options.exclusiveMin }),
    format: (v) => String(v),
    read,
    commit,
  });
}

/** The solver's options (the old Fix view's), shared by the fix and the running fix. */
export function solveOptionsForm(nc: NavCtx, track: Track): HTMLElement {
  const store = nc.working.store;
  const set = (patch: Partial<SolveForm>): void => store.patch({ solve: { ...store.get().solve, ...patch } });
  const w = store.get().solve;
  const bias = checkbox('Estimate a shared altitude bias as a third unknown', w.estimate_shared_bias, (v) => set({ estimate_shared_bias: v }), 'For a dip, index or refraction error common to every sight. Needs sights spread round the horizon.');
  const robust = checkbox('Robust (Huber) weighting', w.robust, (v) => set({ robust: v }), 'Downweights a sight that does not fit; the covariance is then approximate.');
  const posterior = checkbox('Also report the residual-scaled covariance', w.posterior_scaling, (v) => set({ posterior_scaling: v }), 'Only with 3 or more degrees of freedom; two or three sights cannot establish their own noise level.');
  const multistart = checkbox('Search the whole globe for other answers (multistart)', w.multistart, (v) => set({ multistart: v }), 'How an ambiguous pair of fixes is found.');
  const iterations = numberField('Maximum iterations', { min: 1, max: 500 }, () => store.get().solve.max_iterations, (v) => set({ max_iterations: Math.round(v) }));
  const note = para('', 'sfn-note sfn-muted');
  const render = (): void => {
    const s = store.get();
    const role = s.session.observer.assumed_position_role.role;
    note.textContent = `The starting point and any prior come from the assumed position in the session settings (now: ${role === 'prior' ? 'a prior' : role === 'disabled' ? 'not used' : 'starting point only'}). The clock's uncertainty (${s.session.clock.uncertainty_s} s) comes from the session.`;
    bias.input.checked = s.solve.estimate_shared_bias;
    robust.input.checked = s.solve.robust;
    posterior.input.checked = s.solve.posterior_scaling;
    multistart.input.checked = s.solve.multistart;
    iterations.refresh();
  };
  track(
    store.select((x) => [x.solve, x.session.observer.assumed_position_role, x.session.clock] as const, render, {
      equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
    }),
  );
  render();
  return h(
    'details',
    { class: 'sfn-advanced' },
    h('summary', {}, 'Solve options: shared bias, robust weighting, residual scaling, multistart, iterations'),
    h('div', { class: 'sfn-checks' }, bias.el, robust.el, posterior.el, multistart.el),
    iterations.el,
    note,
  );
}

/** Publish (or clear) this result on the map, unless the person turned that off. */
export function publish(nc: NavCtx, data: OverlayData | null): void {
  if (!nc.overlays) return;
  if (data) publishOverlays(nc.overlays, data);
  else clearOverlays(nc.overlays);
}

/** A "Save as GPX" button for a result, or the reason there is none. */
export function gpxButton(nc: NavCtx, plan: GpxPlan, title: string): HTMLElement {
  if (!plan.ok) return para(plan.reason, 'sfn-note sfn-muted');
  const session = nc.working.store.get().session;
  const b = btn('Save as GPX', () => {
    const now = new Date().toISOString();
    download(
      `${fileStem(session.meta.name)}-${fileStem(title, 'fix')}.gpx`,
      gpxDocument({ name: `${session.meta.name || 'SkyFix Lab session'} — ${title}`, desc: 'Exported from SkyFix Lab. Simulation and analysis workbench. Not a navigation instrument.', time: now, waypoints: plan.waypoints }),
      'application/gpx+xml',
    );
  }, { variant: 'outline', icon: 'pin', tip: 'The position as a GPX waypoint, with its uncertainty written in its description' });
  return h('div', { class: 'sfn-export' }, b, h('span', { class: 'sfn-note sfn-muted' }, ` ${plan.waypoints.length} waypoint${plan.waypoints.length === 1 ? '' : 's'}; the uncertainty travels in the description.`));
}

export { card };
