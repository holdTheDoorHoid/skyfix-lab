/**
 * "What did I shoot?": which body a sight was of, from its time, its altitude and a rough
 * bearing (`star_identify`, docs/NAVIGATION_METHODS.md section 10). The sight form hands
 * over what is typed in it; the panel adds the bearing, works the candidates out with the
 * engine, and "Use" puts the chosen body into the form. OWNER: navigate2 agent (expansion
 * programme).
 *
 * The request is the session's: the DR (its assumed position, or the map's place), the
 * height of eye, pressure and temperature, DUT1, the index correction or its log, and the
 * horizon the form has (a shore horizon included). The time is corrected for the watch as
 * the core corrects a sight (the watch log at the recorded time, else the known correction).
 * A magnetic or compass bearing gets the model's variation at the DR, which the result
 * names; with none (before 1900 or after 2030) the engine uses the bearing as if true and
 * says so.
 */

import { h } from '../../dom.js';
import type { AltitudeKind, HorizonMode, LatLon } from '../../types.js';
import { disposer } from '../component.js';
import {
  isGeomagEngine,
  isSailingsEngine,
  type BearingKind,
  type ExplorerEngine,
  type StarIdMatch,
  type StarIdRequest,
  type StarIdResult,
} from '../engine/types.js';
import type { ExplorerState } from '../state.js';
import { isoUtc, jdFromIso } from '../time.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { eastWest } from './compass/deviation.js';
import type { NavCtx } from './context.js';
import { fmtArcmin, fmtBearing, fmtPosition } from './format.js';
import { watchCorrectionAt } from './logs.js';
import type { Working } from './model.js';
import { parseNumber } from './parse.js';
import { btn, debounce, errorText, field, kids, notice, para, selectInput, textInput } from './ui.js';

/** What the sight form holds when the panel runs. */
export interface StarIdFormInputs {
  /** The watch's time as typed (RFC 3339 UTC), or null. */
  utc: string | null;
  altitudeDeg: number | null;
  altitudeKind: AltitudeKind;
  horizon: HorizonMode;
}

export interface StarIdBearing {
  deg: number;
  kind: BearingKind;
  /** East positive; a compass bearing's deviation (null: none known). */
  deviationDeg: number | null;
  /** East positive; null: none (the engine then uses the bearing as if true). */
  variationDeg: number | null;
  toleranceDeg: number;
}

/** The DR the identification works from, and where it came from. */
export function starIdPlace(w: Working, explorer: ExplorerState): LatLon & { label: string } {
  const ap = w.session.observer.assumed_position;
  if (ap) return { ...ap, label: 'the DR, the session’s assumed position' };
  return { lat_deg: explorer.observer.lat_deg, lon_deg: explorer.observer.lon_deg, label: explorer.observer.label || 'the map’s place' };
}

/** Add seconds to an RFC 3339 instant. */
function plusSeconds(utc: string, seconds: number): string {
  const jd = jdFromIso(utc);
  return jd === null || seconds === 0 ? utc : isoUtc(jd + seconds / 86_400);
}

/** The engine's request, or what is still missing. Pure; tested. */
export function starIdRequestFor(
  w: Working,
  explorer: ExplorerState,
  form: StarIdFormInputs,
  bearing: StarIdBearing,
): { request: StarIdRequest } | { missing: string } {
  if (!form.utc) return { missing: 'Type the time of the sight first (above).' };
  if (form.altitudeDeg === null) return { missing: 'Type the sextant reading first (above).' };
  const place = starIdPlace(w, explorer);
  const s = w.session;
  const request: StarIdRequest = {
    utc: plusSeconds(form.utc, watchCorrectionAt(s, form.utc)),
    observer: {
      lat_deg: place.lat_deg,
      lon_deg: place.lon_deg,
      height_of_eye_m: s.observer.height_of_eye_m,
      pressure_hpa: s.observer.pressure_hpa,
      temperature_c: s.observer.temperature_c,
      dut1_s: s.clock.dut1_s ?? null,
    },
    instrument: {
      index_correction_arcmin: s.instrument.index_correction_arcmin,
      horizon: form.horizon,
      ...(s.instrument.index_error_log?.length ? { index_error_log: s.instrument.index_error_log } : {}),
    },
    altitude_deg: form.altitudeDeg,
    altitude_kind: form.altitudeKind,
    bearing_deg: bearing.deg,
    bearing_kind: bearing.kind,
    bearing_tolerance_deg: bearing.toleranceDeg,
  };
  if (bearing.kind !== 'true' && bearing.variationDeg !== null) request.variation_deg = bearing.variationDeg;
  if (bearing.kind === 'compass' && bearing.deviationDeg !== null) request.deviation_deg = bearing.deviationDeg;
  return { request };
}

/** The model's variation at the DR and time, or null (no geomag engine, or no model then). */
export function modelVariation(engine: ExplorerEngine, place: LatLon, utc: string): { deg: number; text: string } | null {
  if (!isGeomagEngine(engine)) return null;
  const jd = jdFromIso(utc);
  if (jd === null) return null;
  try {
    const f = engine.magneticField(place.lat_deg, place.lon_deg, 0, jd);
    return f.available ? { deg: f.declination_deg, text: `${f.variation_text} (${f.model})` } : null;
  } catch {
    return null;
  }
}

/** `11.6′ lower`, `7.6° higher`: arcminutes under a degree, degrees above. */
function offsetWords(deg: number, more: string, less: string): string {
  const a = Math.abs(deg);
  const text = a < 1 ? `${(a * 60).toFixed(1)}′` : `${a.toFixed(1)}°`;
  return `${text} ${deg >= 0 ? more : less}`;
}

function candidateRow(c: StarIdMatch, offered: boolean, onUse: () => void): HTMLElement {
  const use = btn(`Use ${c.body}`, onUse, { variant: c.rank === 1 && c.within_tolerance ? 'primary' : 'outline', tip: offered ? `Put ${c.body} in the sight form` : `${c.body} is not offered for sights` });
  use.disabled = !offered;
  const sep = c.separation_deg < 1 ? fmtArcmin(c.separation_deg * 60, 1).replace(/^\+/, '') : `${c.separation_deg.toFixed(1)}°`;
  return h(
    'li',
    { class: `sfn-starid__cand${c.within_tolerance ? '' : ' sfn-starid__cand--out'}` },
    h('span', { class: 'sfn-glyph-tile' }, bodyGlyph(c.body, { kind: c.kind, size: 16 })),
    h(
      'span',
      { class: 'sfn-starid__text' },
      h('strong', {}, `${c.rank}. ${c.body}`),
      c.within_tolerance ? null : h('span', { class: 'sfn-tag' }, 'outside the tolerance'),
      h(
        'span',
        { class: 'sfn-muted' },
        ` · ${sep} away: the sight is ${offsetWords(c.delta_altitude_deg, 'higher', 'lower')} and its bearing ${offsetWords(c.delta_bearing_deg, 'more', 'less')} (${c.body} stands ${c.altitude_deg.toFixed(1)}° high, bearing ${fmtBearing(c.azimuth_deg)})` +
          (c.magnitude !== null ? `, magnitude ${c.magnitude.toFixed(1)}` : '') +
          (c.bright_enough === false ? ', probably too faint for this sky' : ''),
      ),
      offered ? null : h('span', { class: 'sfn-muted' }, ' · not offered for sights'),
    ),
    use,
  );
}

export interface StarIdPanel {
  el: HTMLElement;
  /** Work it out again (the form's time or reading changed). */
  run(): void;
  destroy(): void;
}

/**
 * The panel inside the sight form. `read` gives what the form holds; `pick` puts the body
 * into the form.
 */
export function starIdPanel(nc: NavCtx, read: () => StarIdFormInputs, pick: (body: string) => void): StarIdPanel {
  const d = disposer();
  const engine = nc.ctx.engine;
  const bearing = textInput({ inputmode: 'decimal', size: 6, placeholder: 'e.g. 286' });
  const bearingField = field('Rough bearing of the body (°)', bearing, { help: 'From a hand-bearing compass, or the ship’s head and a guess.' });
  const kind = selectInput<BearingKind>(
    [
      { value: 'compass', label: 'By compass' },
      { value: 'magnetic', label: 'Magnetic' },
      { value: 'true', label: 'True' },
    ],
    'compass',
  );
  const kindField = field('The bearing is', kind, { help: 'By compass: the deviation and the variation are applied; magnetic: the variation only.' });
  const deviation = textInput({ size: 7, placeholder: '0' });
  const deviationField = field('Deviation (optional)', deviation, { help: 'With its name: 2.5 W. Empty: none.' });
  const tolerance = selectInput<'5' | '10' | '20'>(
    [
      { value: '5', label: '±5° (a hand-bearing compass)' },
      { value: '10', label: '±10° (a rough guess)' },
      { value: '20', label: '±20° (only the side of the sky)' },
    ],
    '5',
  );
  const toleranceField = field('How rough the bearing is', tolerance, { help: 'The altitude is compared within 2°.' });
  const out = h('div', { class: 'sfn-starid__out', 'aria-live': 'polite' });
  const el = h(
    'details',
    { class: 'sfn-advanced sfn-starid' },
    h('summary', {}, 'What did I shoot? ', h('span', { class: 'sfn-term' }, '· identify the body from the reading and a bearing')),
    para('Took a sight of a bright body without being sure which? From the time and the reading above, and a rough bearing here, the engine lists the bodies that fit, closest first.', 'sfn-note'),
    h('div', { class: 'sfn-grid-2' }, bearingField.el, kindField.el),
    h('div', { class: 'sfn-grid-2' }, deviationField.el, toleranceField.el),
    out,
  );

  const parseDeviation = (): number | null => {
    const t = deviation.value.trim();
    if (!t) return null;
    const m = /^\s*(\d+(?:[.,]\d*)?)\s*°?\s*([EeWw])\s*$/.exec(t) ?? /^\s*([+\-−]?\d+(?:[.,]\d*)?)\s*$/.exec(t);
    if (!m) return Number.NaN;
    const v = Number(m[1]!.replace(',', '.').replace('−', '-'));
    return m[2] ? (/[Ww]/.test(m[2]) ? -v : v) : v;
  };

  const run = debounce(() => {
    if (!(el as HTMLDetailsElement).open) return;
    if (!isSailingsEngine(engine)) {
      out.replaceChildren(notice('caution', 'This build’s engine has no star identification (star_identify). Rebuild the WebAssembly package to use it.'));
      return;
    }
    const w = nc.working.store.get();
    const explorer = nc.ctx.store.get();
    const b = parseNumber(bearing.value, { what: 'The bearing', min: 0, max: 360, unit: '°' });
    bearingField.setError(bearing.value.trim() && !b.ok ? b.error : null);
    const dev = parseDeviation();
    deviationField.setError(dev !== null && !Number.isFinite(dev) ? 'Type the deviation with its name, for example 2.5 W.' : null);
    deviationField.el.hidden = kind.value !== 'compass';
    if (!bearing.value.trim() || !b.ok) {
      out.replaceChildren(para('Type the bearing to see which bodies fit.', 'sfn-note sfn-muted'));
      return;
    }
    const form = read();
    const place = starIdPlace(w, explorer);
    const variation = kind.value === 'true' || !form.utc ? null : modelVariation(engine, place, form.utc);
    const req = starIdRequestFor(w, explorer, form, {
      deg: b.value === 360 ? 0 : b.value,
      kind: kind.value as BearingKind,
      deviationDeg: dev !== null && Number.isFinite(dev) ? dev : null,
      variationDeg: variation?.deg ?? null,
      toleranceDeg: Number(tolerance.value),
    });
    if ('missing' in req) {
      out.replaceChildren(para(req.missing, 'sfn-note'));
      return;
    }
    let r: StarIdResult;
    try {
      r = engine.starIdentify(req.request);
    } catch (error) {
      out.replaceChildren(notice('error', h('strong', {}, 'No identification: '), errorText(error)));
      return;
    }
    const format = nc.ctx.store.get().settings.angleFormat;
    const offered = (body: string) => nc.bodies.some((x) => x.body.toLowerCase() === body.toLowerCase());
    out.replaceChildren(
      ...kids(
      h('p', { class: 'sfn-starid__message' }, r.best ? h('strong', {}, 'Best match: ') : h('strong', {}, 'Nothing fits: '), r.message),
      r.ambiguous ? notice('caution', 'More than one body fits: check the bearing, or take a second sight a few minutes later and compare how the height changes.') : null,
      h('ol', { class: 'sfn-starid__list' }, ...r.candidates.map((c) => candidateRow(c, offered(c.body), () => {
        pick(c.body);
        (el as HTMLDetailsElement).open = false;
        nc.say(`${c.body} put in the sight form (identified ${c.separation_deg < 1 ? `${(c.separation_deg * 60).toFixed(1)}′` : `${c.separation_deg.toFixed(1)}°`} from the sight).`);
      }))),
      para(
        `From ${fmtPosition(place, format)}, ${place.label}. Observed: ${r.observed_altitude_deg.toFixed(2)}° high (corrected as a star), bearing ${fmtBearing(r.observed_bearing_deg)} true` +
          (variation && kind.value !== 'true' ? ` after the variation ${eastWest(variation.deg)} (${variation.text.replace(/^[^(]*\(/, '').replace(/\)$/, '')})` : '') +
          `. The sky: ${r.sky}, the Sun ${Math.abs(r.sun_altitude_deg).toFixed(0)}° ${r.sun_altitude_deg < 0 ? 'below' : 'above'} the horizon; bodies to magnitude ${r.limiting_magnitude.toFixed(1)} counted as visible.`,
        'sfn-note sfn-muted',
      ),
      ...r.notes.map((n) => para(n, 'sfn-note sfn-muted')),
      ),
    );
  }, 250);
  d.add(() => run.cancel());
  for (const x of [bearing, deviation]) x.addEventListener('input', () => run.run());
  for (const x of [kind, tolerance]) x.addEventListener('change', () => run.run());
  el.addEventListener('toggle', () => run.run());
  deviationField.el.hidden = false;
  return { el, run: () => run.run(), destroy: () => d.dispose() };
}
