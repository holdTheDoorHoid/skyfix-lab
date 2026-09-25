/**
 * The sight-reduction worksheet: one sight worked in the six classic steps, the navigator's
 * terms beside plain words, SkyFix Lab's figures in one column and an empty one for the
 * navigator's own reduction (with the Nautical Almanac and Pub. 229, say), so the two can be
 * compared line by line. Printed by the preview (preview.ts). OWNER: navigate2 agent.
 *
 *   1  Time            watch time W, watch correction, UTC
 *   2  Altitude        Hs, IC, dip, Ha, refraction, semidiameter, parallax, Ho
 *   3  Almanac         GHA (for a star GHA♈ + SHA), declination, HP and SD
 *   4  Hour angle      assumed position (the DR itself), LHA = GHA + longitude east
 *   5  Computed        Hc and Zn at the assumed position
 *   6  Intercept       a = Ho − Hc, toward or away, along Zn
 *
 * Every figure is the core's (`reduce`: the correction chain, the direction, Hc, Zn and the
 * intercept at the assumed position). The only arithmetic here is presentation: LHA from
 * GHA and the assumed longitude, and a star's SHA as its GHA less the explorer's GHA ♈ at
 * the same instant brought to the session's UT1 (print/open.ts), so GHA ♈ + SHA = GHA.
 */

import { h } from '../../../dom.js';
import type { CorrectionKind, Observation, ReducedSight, Session } from '../../../types.js';
import type { AngleFormat } from '../../state.js';
import { isoUtc } from '../../time.js';
import { fmtAngle, fmtArcmin, fmtLatitude, fmtLongitude, fmtNm, utcInputText } from '../format.js';
import { horizonSummary, KIND_TEXT, LIMB_TEXT, STEP_TEXT } from '../text.js';
import { sheet } from './preview.js';

export interface WorksheetInput {
  session: Session;
  obs: Observation;
  sight: ReducedSight;
  /** GHA of Aries at the sight's instant on the sight's UT1 (stars only), or null. */
  ghaAriesDeg: number | null;
  format?: AngleFormat;
}

export interface WorksheetRow {
  step: number;
  plain: string;
  term: string;
  value: string;
  note?: string;
}

const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** A bearing to a tenth of a degree, as a worksheet carries it: `149.3°`. */
function bearing1(deg: number): string {
  const v = Math.round(norm360(deg) * 10) / 10;
  return `${(v >= 360 ? 0 : v).toFixed(1).padStart(5, '0')}°`;
}

/** Local hour angle from GHA and east-positive longitude, [0, 360). */
export function lhaDeg(ghaDeg: number, lonDeg: number): number {
  const x = norm360(ghaDeg + lonDeg);
  return x >= 360 - 1e-12 ? 0 : x;
}

/** The worksheet's rows: pure, so the figures can be tested without a page. */
export function worksheetRows(input: WorksheetInput): WorksheetRow[] {
  const { session, obs, sight } = input;
  const f = input.format ?? 'dm';
  // To 0.01′ (a hundredth of a minute) so the sheet's own sums close — GHA ♈ + SHA = GHA,
  // Ho − Hc = a — which figures rounded one by one to 0.1′ need not do.
  const ang = (v: number): string => fmtAngle(v, f, f === 'dm' ? 2 : undefined);
  const arc = (v: number): string => fmtArcmin(v, 2);
  const rows: WorksheetRow[] = [];
  const push = (step: number, plain: string, term: string, value: string, note?: string): void => {
    rows.push({ step, plain, term, value, ...(note ? { note } : {}) });
  };

  // 1. Time.
  const corrected = utcInputText(isoUtc(sight.jd_utc).replace(/\.000Z$/, 'Z'));
  push(1, 'Watch time, as written down', 'W', `${utcInputText(obs.utc)} UTC`);
  const clockLog = sight.clock_correction_from_log;
  const watchAdded = clockLog ? clockLog.value : session.clock.correction_s;
  push(1, 'Watch correction, added', 'WE', `${watchAdded >= 0 ? '+' : '−'}${Math.abs(watchAdded).toFixed(1)} s`, clockLog ? 'from the watch log' : 'the known correction');
  push(1, 'Time of the sight', 'UTC', `${corrected} UTC`);

  // 2. Altitude.
  const kind = KIND_TEXT[obs.altitude_kind];
  const disc = sight.body === 'Sun' || sight.body === 'Moon';
  push(2, kind.plain, kind.term, ang(sight.corrections.input_deg), disc ? LIMB_TEXT[obs.limb].toLowerCase() : undefined);
  const byKind = new Map(sight.corrections.steps.map((s) => [s.kind, s]));
  const stepRow = (k: CorrectionKind, term: string, note?: string): void => {
    const s = byKind.get(k);
    const t = STEP_TEXT[k];
    if (!s) return;
    push(2, t.plain, term, s.applied ? arc(s.delta_arcmin) : '—', s.applied ? note : 'not applied');
  };
  stepRow('index_correction', 'IC', sight.index_correction_from_log ? 'from the index-error log' : undefined);
  const horizon = obs.horizon ?? session.instrument.horizon;
  if (byKind.get('artificial_horizon_halving')?.applied) stepRow('artificial_horizon_halving', '÷ 2', 'reflected artificial horizon');
  else stepRow('dip', 'D', `${horizonSummary(horizon)}, eye ${session.observer.height_of_eye_m} m`);
  const afterHorizon = byKind.get('artificial_horizon_halving')?.applied ? byKind.get('artificial_horizon_halving')! : byKind.get('dip');
  if (afterHorizon) push(2, 'Apparent altitude', 'Ha', ang(afterHorizon.after_deg));
  stepRow('refraction', 'R', `${session.observer.pressure_hpa} hPa, ${session.observer.temperature_c} °C`);
  stepRow('semidiameter', 'SD');
  stepRow('parallax', 'PA', sight.horizontal_parallax_arcmin > 0 ? `HP ${sight.horizontal_parallax_arcmin.toFixed(1)}′` : undefined);
  push(2, 'Observed altitude', 'Ho', ang(sight.ho_deg), `±${sight.sigma_arcmin.toFixed(1)}′ (1 sigma)`);

  // 3. Almanac.
  if (input.ghaAriesDeg !== null) {
    const sha = norm360(sight.gha_deg - input.ghaAriesDeg);
    push(3, 'Greenwich hour angle of Aries', 'GHA ♈\uFE0E', ang(norm360(input.ghaAriesDeg)));
    push(3, `Sidereal hour angle of ${sight.body}`, 'SHA', ang(sha));
  }
  push(3, `Greenwich hour angle of ${sight.body}`, 'GHA', ang(sight.gha_deg), input.ghaAriesDeg !== null ? 'GHA ♈\uFE0E + SHA' : undefined);
  push(3, 'Declination', 'Dec', ang(sight.dec_deg));
  if (sight.horizontal_parallax_arcmin > 0) push(3, 'Horizontal parallax', 'HP', `${sight.horizontal_parallax_arcmin.toFixed(1)}′`);
  push(3, 'From', '', sight.direction_source === 'supplied' ? 'the values typed into this sight' : sight.direction_source);

  // 4. Assumed position and LHA.
  const ap = session.observer.assumed_position;
  if (ap) {
    push(4, 'Assumed latitude', 'aLat', fmtLatitude(ap.lat_deg, f, f === 'dm' ? 2 : undefined), 'the DR itself');
    push(4, 'Assumed longitude', 'aLon', fmtLongitude(ap.lon_deg, f, f === 'dm' ? 2 : undefined), 'the DR itself');
    push(4, 'Local hour angle', 'LHA', ang(lhaDeg(sight.gha_deg, ap.lon_deg)), 'GHA + longitude east (− west)');
  } else {
    push(4, 'Assumed position', 'AP', '—', 'none in the session: steps 4 to 6 need one');
  }

  // 5. Computed altitude and azimuth.
  if (sight.hc_deg !== null && sight.zn_deg !== null) {
    push(5, 'Computed altitude', 'Hc', ang(sight.hc_deg), typeof sight.earth_shape_arcmin === 'number' ? `includes ${arc(sight.earth_shape_arcmin)} for the Earth’s shape (the Moon)` : undefined);
    push(5, 'True azimuth', 'Zn', bearing1(sight.zn_deg));
  }

  // 6. Intercept.
  if (sight.intercept_nm !== null && sight.zn_deg !== null) {
    const a = sight.intercept_nm;
    push(6, 'Intercept', 'a = Ho − Hc', `${Math.abs(a).toFixed(2)}′ = ${fmtNm(Math.abs(a), 2)} ${a >= 0 ? 'Toward' : 'Away'}`, a >= 0 ? 'Ho greater: toward the body' : 'Ho less: away from the body');
    push(6, 'Plot', '', `from the AP, ${fmtNm(Math.abs(a), 2)} along ${bearing1(a >= 0 ? sight.zn_deg : sight.zn_deg + 180)}; the line of position at right angles`);
  }
  return rows;
}

const STEP_TITLES: Record<number, [string, string]> = {
  1: ['Time', 'when the sight was taken'],
  2: ['Altitude', 'sextant reading to observed altitude, Hs to Ho'],
  3: ['Almanac', 'where the body was: GHA and declination'],
  4: ['Hour angle', 'assumed position and LHA'],
  5: ['Computed', 'Hc and Zn at the assumed position'],
  6: ['Intercept', 'Ho − Hc, and the line of position'],
};

/** The printed worksheet of one sight. */
export function worksheetSheet(input: WorksheetInput): HTMLElement {
  const rows = worksheetRows(input);
  const body = h('tbody', {});
  for (let step = 1; step <= 6; step += 1) {
    const mine = rows.filter((r) => r.step === step);
    if (!mine.length) continue;
    const [title, what] = STEP_TITLES[step]!;
    body.append(
      h('tr', { class: 'sfn-ws__step' }, h('th', { colspan: 4, scope: 'rowgroup' }, h('span', { class: 'sfn-ws__n' }, String(step)), ` ${title} `, h('span', { class: 'sfn-ws__what' }, `· ${what}`))),
      ...mine.map((r) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, r.plain, r.note ? h('span', { class: 'sfn-ws__note' }, r.note) : null),
          h('td', { class: 'sfn-ws__term' }, r.term),
          h('td', { class: 'sfn-ws__value' }, r.value),
          h('td', { class: 'sfn-ws__yours' }, ''),
        ),
      ),
    );
  }
  const { session, obs, sight } = input;
  const table = h(
    'table',
    { class: 'sfn-ws sfn-ws--sheet' },
    h('caption', { class: 'sf-sr' }, `Sight reduction worksheet for ${sight.id}, ${sight.body}`),
    h('colgroup', {}, h('col', { class: 'sfn-ws__c-step' }), h('col', { class: 'sfn-ws__c-term' }), h('col', { class: 'sfn-ws__c-value' }), h('col', { class: 'sfn-ws__c-yours' })),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Step'), h('th', { scope: 'col' }, 'Term'), h('th', { scope: 'col' }, 'SkyFix Lab'), h('th', { scope: 'col' }, 'Yours'))),
    body,
  );
  return sheet(
    `Sight reduction: ${sight.body}`,
    `${session.meta.name || 'Untitled session'} · sight ${sight.id} · ${utcInputText(obs.utc)} UTC`,
    session.meta.kind,
    table,
    h('p', { class: 'sfn-sheet__note' }, 'The assumed position is the DR itself: the core computes Hc exactly, so no rounding is needed. With Pub. 229, choose the assumed latitude and longitude to make them and the LHA whole degrees, and the intercept changes with them; the line of position does not. Figures are carried to 0.01′ so the sheet’s sums close; a navigator writes 0.1′.'),
  );
}
