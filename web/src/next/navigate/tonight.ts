/**
 * "Tonight's star sights": the next evening and morning nautical twilight at a place, and
 * for each the three to five bodies to shoot, with the sextant reading and the bearing to
 * expect and their spread round the horizon (`plan_sights`, docs/NAVIGATION_SKY.md
 * section 5). OWNER: navigate agent.
 *
 * Two uses:
 * - the shell's side panel mounts `tonightSights()` (compact, for the explorer's place and
 *   the instrument settings), on the chrome's colours;
 * - Navigate's Plan tab mounts `tonightSights({ compact: false, from: 'dr' })` (the
 *   session's assumed position and instrument), with every prediction's workings.
 * "Use these bodies" adds them to the Navigate view's bodies to shoot (a guide beside the
 * sight form; a prediction never becomes a sight on its own).
 *
 * The position is an approximate one, used to predict and never as a prior; the plan says
 * so. It is recomputed when the place, the instrument or the hour of the time bar changes,
 * never per frame.
 */

import { h, s } from '../../dom.js';
import { disposer, type Component, type Ctx, type Mounted } from '../component.js';
import type { SightInstrument, SightObserver, SightPlan, TwilightPlan } from '../engine/types.js';
import { displayZone } from '../state.js';
import { bodyGlyph, glyphFor } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
import { formatTime, zoneShortName, type Zone } from '../time.js';
import { fmtAngle, fmtBearing, fmtMetres, fmtPosition, fmtSeconds } from './format.js';
import type { PlannedSight } from './model.js';
import { btn, errorText, kids, para } from './ui.js';
import { workingFor } from './working.js';
import { workingsTable } from './workings.js';

export interface TonightOptions {
  /** Compact list for the side panel (default) or the full plan (Navigate's Plan tab). */
  compact?: boolean;
  /** Plan for the explorer's place (default) or the session's assumed position. */
  from?: 'place' | 'dr';
  /** After "Use these bodies": switch to the Navigate view (default: when compact). */
  openNavigate?: boolean;
}

interface Inputs {
  observer: SightObserver;
  instrument: SightInstrument;
  jdStart: number;
  label: string;
}

/** Hours ahead the search looks: long enough for the next evening and the next morning. */
export const PLAN_SPAN_DAYS = 1.5;

function inputsFor(ctx: Ctx, from: 'place' | 'dr'): Inputs {
  const s = ctx.store.get();
  if (from === 'dr') {
    const w = workingFor(ctx.store).store.get();
    const ap = w.session.observer.assumed_position;
    if (ap) {
      return {
        observer: {
          lat_deg: ap.lat_deg,
          lon_deg: ap.lon_deg,
          height_of_eye_m: w.session.observer.height_of_eye_m,
          pressure_hpa: w.session.observer.pressure_hpa,
          temperature_c: w.session.observer.temperature_c,
        },
        instrument: { index_correction_arcmin: w.session.instrument.index_correction_arcmin, horizon: w.session.instrument.horizon },
        jdStart: s.time.jd_utc,
        label: 'the session’s assumed position',
      };
    }
  }
  return {
    observer: { lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg, height_of_eye_m: s.settings.height_of_eye_m },
    instrument: { index_correction_arcmin: s.settings.index_correction_arcmin, horizon: 'sea' },
    jdStart: s.time.jd_utc,
    label: s.observer.label || 'the place on the map',
  };
}

/** A small compass rose with each chosen body's bearing: the spread at a glance. */
export function azimuthRose(window: TwilightPlan, size = 132): SVGSVGElement {
  const r = size / 2 - 22;
  const c = size / 2;
  const svg = s('svg', {
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    class: 'sfn-rose',
    role: 'img',
    'aria-label': `Bearings: ${window.sights.map((b) => `${b.body} ${Math.round(b.zn_deg)} degrees`).join(', ')}.`,
  }) as SVGSVGElement;
  svg.appendChild(s('circle', { cx: c, cy: c, r, class: 'sfn-rose__ring' }));
  for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
    const a = (az * Math.PI) / 180;
    const t = s('text', { x: (c + (r + 11) * Math.sin(a)).toFixed(1), y: (c - (r + 11) * Math.cos(a) + 4).toFixed(1), 'text-anchor': 'middle', class: 'sfn-rose__cardinal' });
    t.textContent = label;
    svg.appendChild(t);
  }
  for (const b of window.sights) {
    const a = (b.zn_deg * Math.PI) / 180;
    const x = c + r * Math.sin(a);
    const y = c - r * Math.cos(a);
    const cls = `sfn-b-${glyphFor(b.body, b.kind)}`;
    svg.appendChild(s('line', { x1: c, y1: c, x2: x.toFixed(1), y2: y.toFixed(1), class: `sfn-rose__ray ${cls}` }));
    svg.appendChild(s('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 4, class: `sfn-rose__dot ${cls}` }));
  }
  svg.appendChild(s('circle', { cx: c, cy: c, r: 2.5, class: 'sfn-rose__centre' }));
  return svg;
}

function windowTitle(w: TwilightPlan, z: Zone, jdNow: number): { title: string; when: string } {
  const title = w.kind === 'evening' ? 'Evening twilight' : 'Morning twilight';
  const range = `${formatTime(w.jd_start, z)}–${formatTime(w.jd_end, z)} ${zoneShortName(w.jd_start, z)}`;
  const inSeconds = (w.jd_start - jdNow) * 86_400;
  const when = w.jd_start <= jdNow && w.jd_end >= jdNow ? `${range} · now` : inSeconds > 0 ? `${range} · in ${fmtSeconds(inSeconds)}` : range;
  return { title, when };
}

export function plannedFrom(w: TwilightPlan): PlannedSight[] {
  return w.sights.map((b) => ({
    body: b.body,
    kind: b.kind,
    limb: b.limb,
    utc: w.utc_predicted,
    hs_deg: b.hs_deg,
    hc_deg: b.hc_deg,
    zn_deg: b.zn_deg,
    from: `${w.kind === 'evening' ? 'Evening' : 'Morning'} twilight plan`,
  }));
}

/** Render a plan into `host` (used by the component and by tests of shape). */
export function renderPlan(
  host: HTMLElement,
  plan: SightPlan,
  ctx: Ctx,
  options: { compact: boolean; label: string; onUse: (w: TwilightPlan) => void },
): void {
  const z = displayZone(ctx.store.get());
  const format = ctx.store.get().settings.angleFormat;
  const jdNow = ctx.store.get().time.jd_utc;
  host.replaceChildren();
  if (plan.windows.length === 0) {
    host.append(para('No nautical twilight in the next day and a half here: the Sun stays too high or too low (polar day or night). Stars and a sea horizon are never both visible.', 'sfn-note'));
    return;
  }
  for (const w of plan.windows) {
    const { title, when } = windowTitle(w, z, jdNow);
    const rows = w.sights.map((b) =>
      h(
        'li',
        { class: 'sfn-tonight__body' },
        bodyGlyph(b.body, { kind: b.kind, size: 16 }),
        h('span', { class: 'sfn-tonight__name' }, b.body, b.kind === 'moon' ? h('span', { class: 'sfn-muted' }, ` ${b.limb} limb`) : null),
        h('span', { class: 'sfn-tonight__hs sfn-num', title: 'Predicted sextant reading' }, `Hs ${fmtAngle(b.hs_deg, format)}`),
        h('span', { class: 'sfn-tonight__zn sfn-num', title: 'True bearing' }, fmtBearing(b.zn_deg)),
      ),
    );
    // Two windows each have this button: the name says which (a screen reader lists them apart).
    const use = btn('Use these bodies', () => options.onUse(w), { variant: options.compact ? 'outline' : 'primary', icon: 'plus', tip: 'Add them to the sights to take, in Navigate', ariaLabel: `Use these bodies: ${title}` });
    const block = h(
      'section',
      { class: 'sfn-tonight__window' },
      h('div', { class: 'sfn-tonight__head' }, h('strong', {}, title), h('span', { class: 'sfn-tonight__when sfn-num' }, when)),
      h('div', { class: 'sfn-tonight__grid' }, h('ol', { class: 'sfn-tonight__list' }, ...rows), azimuthRose(w, options.compact ? 112 : 150)),
      h('div', { class: 'sfn-tonight__actions' }, use),
    );
    if (!options.compact) {
      const m = w.plan.predicted;
      block.append(...kids(
        para(
          `Predicted for ${formatTime(w.jd_predicted, z)} ${zoneShortName(w.jd_predicted, z)} (the Sun ${Math.abs(w.sun_altitude_deg).toFixed(1)}° below the horizon), for bodies brighter than magnitude ${w.limiting_magnitude.toFixed(1)}. ` +
            (m.semi_major_sigma_m !== null && m.semi_minor_sigma_m !== null
              ? `With 1′ sights, the fix would be good to about ${fmtMetres(m.semi_major_sigma_m)} × ${fmtMetres(m.semi_minor_sigma_m)} (1 sigma); the largest gap between bearings is ${m.max_azimuth_gap_deg.toFixed(0)}°.`
              : ''),
          'sfn-note',
        ),
        h(
          'ol',
          { class: 'sfn-tonight__why' },
          ...w.sights.map((b) =>
            h(
              'li',
              {},
              h('strong', {}, `${b.step}. ${b.body}`),
              ` — computed altitude ${fmtAngle(b.hc_deg, format)}, bearing ${fmtBearing(b.zn_deg)}${b.magnitude !== null ? `, magnitude ${b.magnitude.toFixed(1)}` : ''}. `,
              h('span', { class: 'sfn-muted' }, b.rationale),
              h('details', { class: 'sfn-advanced' }, h('summary', {}, `What the sextant will read for ${b.body}, worked backwards`), workingsTable(b.prediction.corrections, format, `Predicted reading for ${b.body}`)),
            ),
          ),
        ),
        w.also_eligible.length ? para(`Also bright and high enough: ${w.also_eligible.join(', ')}.`, 'sfn-note sfn-muted') : null,
        h('ul', { class: 'sfn-list sfn-muted' }, ...w.notes.map((n) => h('li', {}, n))),
      ));
    }
    host.append(block);
  }
  host.append(
    para(
      `For ${options.label}${options.compact ? '' : ` (${fmtPosition(plan.observer, format)})`}: an approximate position, used to predict and never as a prior. Predictions are for the start of each window; the bodies move up to 15° an hour.`,
      'sfn-note sfn-muted sfn-tonight__foot',
    ),
  );
}

/** How long the time must be still before tonight's plan is made again, ms. */
const SETTLE_MS = 300;
/** While the time keeps moving, a new plan at least this often, ms. */
const MAX_WAIT_MS = 5000;

export function tonightSights(options: TonightOptions = {}): Component {
  const compact = options.compact ?? true;
  const from = options.from ?? 'place';
  const openNavigate = options.openNavigate ?? compact;
  return (host: HTMLElement, ctx: Ctx): Mounted => {
    const d = disposer();
    const root = h('div', { class: `sfn-tonight${compact ? ' sfn-tonight--compact' : ''}` });
    const body = h('div', { class: 'sfn-tonight__body-wrap', 'aria-live': 'polite' });
    const status = h('p', { class: 'sfn-note sfn-muted', role: 'status' });
    root.append(body, status);
    host.append(root);
    d.add(() => root.remove());
    const nav = ctx.engine.nav;
    if (!nav) {
      body.append(para('This build’s engine has no sight planner (plan_sights). Rebuild the WebAssembly package to see tonight’s bodies.', 'sfn-note'));
      return { destroy: () => d.dispose() };
    }
    let lastKey = '';
    let lastRun = 0;
    let firstPending = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const compute = (): void => {
      timer = null;
      lastRun = Date.now();
      const inputs = inputsFor(ctx, from);
      try {
        const plan = nav.planSights(inputs.observer, inputs.jdStart, inputs.jdStart + PLAN_SPAN_DAYS, inputs.instrument);
        renderPlan(body, plan, ctx, {
          compact,
          label: inputs.label,
          onUse: (w) => {
            const working = workingFor(ctx.store);
            const add = plannedFrom(w);
            const keep = working.store.get().planned.filter((p) => !add.some((a) => a.body === p.body));
            working.store.patch({ planned: [...keep, ...add] });
            status.textContent = `${add.length} bodies added to “To shoot” in Navigate, with their predicted readings as a guide.`;
            if (openNavigate) ctx.store.patch({ view: 'navigate' });
          },
        });
      } catch (error) {
        body.replaceChildren(para(`No plan: ${errorText(error)}`, 'sfn-note'));
      }
    };
    const request = (): void => {
      const inputs = inputsFor(ctx, from);
      const key = JSON.stringify([inputs.observer, inputs.instrument, Math.floor(inputs.jdStart * 24), ctx.store.get().settings.angleFormat, ctx.store.get().settings.timeDisplay, ctx.store.get().observer.zone]);
      if (key === lastKey) return;
      lastKey = key;
      // A plan takes tens of milliseconds of the page's time. While the time keeps moving
      // (the time bar dragged, or playing) it waits for the time to settle, so it never makes
      // the frames of a drag late: once the time has been still for SETTLE_MS, and at least
      // every MAX_WAIT_MS while it keeps moving. The first plan is made at once.
      const now = Date.now();
      if (timer === null) firstPending = now;
      else clearTimeout(timer);
      const wait = lastRun === 0 || now - firstPending >= MAX_WAIT_MS ? 0 : SETTLE_MS;
      timer = setTimeout(compute, wait);
    };
    d.add(ctx.store.subscribe(request));
    if (from === 'dr') d.add(workingFor(ctx.store).store.select((w) => w.session.observer, request));
    d.add(() => {
      if (timer !== null) clearTimeout(timer);
    });
    body.append(h('p', { class: 'sfn-note sfn-muted' }, icon('clock'), ' Finding tonight’s twilight…'));
    request();
    return { destroy: () => d.dispose() };
  };
}

/** The side panel's section body: tonight's bodies for the explorer's place. */
export const tonight: Component = tonightSights();
