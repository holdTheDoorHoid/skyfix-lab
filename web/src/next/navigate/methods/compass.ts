/**
 * The Compass tab (expansion programme, navigate2 agent): the magnetic variation at the
 * place and date, compass error by a body's azimuth or amplitude with its split into
 * variation and deviation, and the deviation table. Engines: `magnetic_field` and
 * `compass_error` (EXPLORER_API "magnetic field and compass error"; CONVENTIONS 14.1-14.2;
 * docs/NAVIGATION_METHODS.md section 9). Every number is the engine's; the words beside
 * them are the engine's own sentences where it gives one.
 */

import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import {
  isGeomagEngine,
  type AmplitudeHorizon,
  type CompassError,
  type CompassKind,
  type CompassMethod,
  type MagneticField,
  type RiseSet,
  type SightBodyInfo,
  type SightLimb,
} from '../../engine/types.js';
import { segmented } from '../../theme/primitives.js';
import { isoUtc, jdFromIso, jdNow, wallClock } from '../../time.js';
import { uncertaintyChip } from '../../time/chip.js';
import { compassPlace, compassRequest, compassUtc } from '../compass/request.js';
import { deviationTableCard } from '../compass/table.js';
import { eastWest, parseEastWest } from '../compass/deviation.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import { fmtAngle, fmtInstant, fmtPosition, fmtSeconds } from '../format.js';
import type { CompassForm, DeviationEntry, Working } from '../model.js';
import { parseOptionalNumber, type Parsed } from '../parse.js';
import { sightTierAt } from '../tier.js';
import { btn, errorText, facts, field, kids, notice, para, parsedField, selectInput } from '../ui.js';
import { autoRun, methodFrame, optionalUtcField } from './common.js';
import { formatYear } from '../../time/format.js';

const deg1 = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}°`;
const bearing1 = (v: number): string => `${(((Math.round(v * 10) / 10) % 360) + 360) % 360 === 0 ? '000.0' : ((((Math.round(v * 10) / 10) % 360) + 360) % 360).toFixed(1).padStart(5, '0')}°`;

function bodyOptions(bodies: readonly SightBodyInfo[]): { value: string; label: string; group: string }[] {
  const group = (k: SightBodyInfo['kind']) => (k === 'sun' || k === 'moon' ? 'Sun and Moon' : k === 'planet' ? 'Planets' : 'Stars (A–Z)');
  const order = { sun: 0, moon: 1, planet: 2, star: 3 } as const;
  return [...bodies]
    .sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === 'star' ? a.body.localeCompare(b.body) : 0))
    .map((b) => ({ value: b.body, label: b.body, group: group(b.kind) }));
}

/** The variation's block: the engine's sentence, or why there is no value. */
export function variationBlock(field0: MagneticField, where: string, format: ReturnType<typeof angleFormat>): HTMLElement {
  if (!field0.available) {
    return h(
      'div',
      { class: 'sfn-variation sfn-variation--none' },
      h('p', { class: 'sfn-variation__value' }, 'No variation'),
      notice('info', field0.reason),
    );
  }
  const f = field0;
  const zone0 =
    f.zone === 'blackout'
      ? notice('error', h('strong', {}, 'Compass blackout zone: '), 'the horizontal field here is under 2000 nT. A magnetic compass is unreliable and the variation can be wrong by tens of degrees.')
      : f.zone === 'caution'
        ? notice('caution', h('strong', {}, 'Caution zone: '), 'the horizontal field here is under 6000 nT, so a compass is sluggish and the variation less certain.')
        : null;
  return h(
    'div',
    { class: 'sfn-variation' },
    h('p', { class: 'sfn-variation__value' }, h('span', { class: 'sfn-variation__big sfn-num' }, f.variation_text), h('span', { class: 'sfn-term' }, ' · variation')),
    para(f.sentence, 'sfn-plain'),
    ...kids(zone0),
    facts([
      ['Where', `${fmtPosition({ lat_deg: f.lat_deg, lon_deg: f.lon_deg }, format)}, ${where}`],
      ['Model', `${f.model}, for ${f.decimal_year.toFixed(2)}${f.forecast ? ' (a forecast: the model extrapolates its rate of change)' : ''}`],
      ['How sure', `±${f.uncertainty.declination_deg.toFixed(2)}° (1 sigma), the model’s published error: more near the magnetic poles; local magnetic anomalies can add degrees and are in no model`],
      ['Changing', `${f.annual_change_text} (${f.annual_change.declination_deg_per_year >= 0 ? '+' : '−'}${Math.abs(f.annual_change.declination_deg_per_year * 60).toFixed(1)}′ a year)`],
      ['Dip of the field', `${deg1(Math.abs(f.inclination_deg))} ${f.inclination_deg >= 0 ? 'down' : 'up'} · inclination`],
      ['Strength', `${Math.round(f.total_nt).toLocaleString('en-US')} nT total, ${Math.round(f.horizontal_nt).toLocaleString('en-US')} nT horizontal (what turns a compass)`],
    ]),
    f.notes.length ? h('ul', { class: 'sfn-list sfn-muted' }, ...f.notes.map((n) => h('li', {}, n))) : null,
    h('details', { class: 'sfn-advanced' }, h('summary', {}, 'Where the uncertainty comes from'), para(f.uncertainty.basis, 'sfn-note')),
  );
}

/** The result's facts, by azimuth or by amplitude. */
function resultFacts(r: CompassError, z: ReturnType<typeof zone>, format: ReturnType<typeof angleFormat>): HTMLElement {
  const ang = (v: number): string => fmtAngle(v, format);
  // The whole second the engine's own sentence names (it truncates; a crossing is found to
  // a fraction of a second).
  const jd = Math.floor(r.jd_utc * 86_400 + 1e-6) / 86_400;
  const rows: (readonly [string, string] | null)[] = [
    ['True bearing', `${bearing1(r.true_bearing_deg)} (${r.method === 'azimuth' ? 'the body’s azimuth then' : 'its bearing as it crossed the horizon'})`],
    ['The compass read', bearing1(r.compass_bearing_deg)],
    ['Compass error', `${r.compass_error_text}${r.compass_error_sigma_deg !== null ? ` ±${r.compass_error_sigma_deg.toFixed(1)}°` : ''} (true minus compass: compass least, error east)`],
    r.variation
      ? ['Variation', `${r.variation.text}${r.variation.sigma_deg !== null ? ` ±${r.variation.sigma_deg.toFixed(2)}°` : ''} (${r.variation.source === 'given' ? 'the chart’s, as you typed it' : `the ${r.variation.source} model`})`]
      : r.compass === 'magnetic'
        ? ['Variation', 'none: no model covers this date (see the notes), so the error cannot be split']
        : null,
    r.deviation_text !== null && r.deviation_deg !== null
      ? ['Deviation', `${r.deviation_text}${r.deviation_sigma_deg !== null ? ` ±${r.deviation_sigma_deg.toFixed(2)}°` : ''} (compass error minus variation: this compass on this heading)`]
      : null,
    ['When', fmtInstant(jd, z)],
  ];
  if (r.azimuth) {
    const a = r.azimuth;
    rows.push(
      ['Body', `GHA ${ang(a.gha_deg)}, declination ${ang(a.dec_deg)}, ${ang(a.altitude_deg)} above the horizon (geometric)`],
      ['From the tables', `Zn ${bearing1(a.zn_spherical_deg)} (the sphere’s azimuth, as Pub. 229 gives it)`],
      ['Turning', `${Math.abs(a.azimuth_rate_deg_per_min).toFixed(2)}° a minute: ${fmtSeconds(Math.abs(0.1 / (a.azimuth_rate_deg_per_min || 1e-9)) * 60)} of time moves the bearing 0.1°`],
    );
  }
  if (r.amplitude) {
    const a = r.amplitude;
    rows.push(
      ['Amplitude', a.amplitude_text ? `${a.amplitude_text} on the celestial horizon (bearing ${a.celestial_bearing_deg !== null ? bearing1(a.celestial_bearing_deg) : '—'})` : 'none: the body never reaches the celestial horizon here'],
      [
        'Visible horizon',
        a.horizon === 'visible'
          ? `${a.visible_horizon_correction_deg >= 0 ? '+' : '−'}${Math.abs(a.visible_horizon_correction_deg).toFixed(2)}° from the celestial-horizon bearing (Bowditch’s Table 23 corrects the observed bearing by ${a.visible_horizon_correction_deg >= 0 ? '−' : '+'}${Math.abs(a.visible_horizon_correction_deg).toFixed(2)}°), for dip ${a.dip_arcmin.toFixed(1)}′, refraction ${a.refraction_arcmin.toFixed(1)}′, semidiameter ${a.semidiameter_arcmin.toFixed(1)}′ and parallax ${a.parallax_arcmin.toFixed(1)}′`
          : 'not used: the centre on the celestial horizon (geocentric altitude 0)',
      ],
      ['At the crossing', `declination ${ang(a.dec_deg)}; the centre ${ang(a.altitude_deg)} (geocentric); ${a.minutes_from_given_time >= 0 ? '' : '−'}${fmtSeconds(Math.abs(a.minutes_from_given_time) * 60)} from the time you gave`],
      ['Judging the horizon', `${a.bearing_per_altitude.toFixed(2)}° of bearing per degree of misjudged altitude`],
    );
  }
  return facts(rows);
}

export function compassMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'compass');
  f.chart.el.hidden = true;
  const store = nc.working.store;
  const form = (): CompassForm => store.get().compass;
  const set = (patch: Partial<CompassForm>): void => store.patch({ compass: { ...form(), ...patch } });
  const engine = nc.ctx.engine;

  if (!isGeomagEngine(engine)) {
    f.inputs.append(notice('caution', 'This build’s engine has no magnetic model or compass method (magnetic_field, compass_error). Rebuild the WebAssembly package (npm run wasm --prefix web) to use the Compass tab.'));
    return { destroy: () => f.destroy() };
  }

  // --- Variation here --------------------------------------------------------------------
  const variationHost = h('section', { class: 'sfn-sub sfn-sub--first', 'aria-label': 'Magnetic variation here' });

  // --- The bearing -------------------------------------------------------------------------
  const method = segmented<CompassMethod>({
    label: 'How the bearing was taken',
    size: 'sm',
    value: form().method,
    options: [
      { value: 'azimuth', label: 'By azimuth', tip: 'Any time: the body’s bearing when you took it' },
      { value: 'amplitude', label: 'By amplitude', tip: 'As it rises or sets: needs no accurate time' },
    ],
    onChange: (v) => set({ method: v }),
  });
  const methodWrap = h('div', { class: 'sfn-field' }, h('span', { class: 'sfn-label' }, 'How the bearing was taken ', h('span', { class: 'sfn-term' }, '· azimuth or amplitude')), method.el);
  const methodHelp = para('', 'sfn-help');
  methodWrap.append(methodHelp);

  const body = selectInput<string>(bodyOptions(nc.bodies), form().body);
  body.addEventListener('change', () => set({ body: body.value }));
  const bodyField = field('Body', body, { help: 'The Sun, the Moon, a planet or one of the 58 navigational stars.' });

  const time = optionalUtcField(nc, 'When the bearing was taken', 'the time on the time bar', () => form().utc, (v) => set({ utc: v }));
  const now = btn('Now', () => set({ utc: isoUtc(jdNow()).replace(/\.\d+Z$/, 'Z') }), { variant: 'outline', tip: 'This computer’s clock, now' });
  const bar = btn('Time bar', () => set({ utc: null }), { variant: 'ghost', tip: 'Follow the time bar' });

  const bearing = parsedField<number | null>('The compass read (°)', {
    term: 'compass bearing',
    inputmode: 'decimal',
    size: 7,
    placeholder: 'e.g. 272',
    help: 'The bearing of the body as your compass showed it, 0 to 360.',
    parse: (t) => angleField(t, 'The compass bearing'),
    format: (v) => (v === null ? '' : String(v)),
    read: () => form().bearingDeg,
    commit: (v) => set({ bearingDeg: v }),
  });
  const kind = selectInput<CompassKind>(
    [
      { value: 'magnetic', label: 'Magnetic (variation and deviation)' },
      { value: 'gyro', label: 'Gyrocompass (gyro error)' },
    ],
    form().compass,
  );
  kind.addEventListener('change', () => set({ compass: kind.value as CompassKind }));
  const kindField = field('Which compass', kind);

  const chartVariation = parsedField<number | null>('The chart’s variation (optional)', {
    term: 'instead of the model’s',
    inputmode: 'decimal',
    size: 8,
    placeholder: 'the model’s',
    help: 'As the chart’s compass rose gives it, brought to this year: 11.8 W, 3.5 E. Empty: the magnetic model’s.',
    parse: (t): Parsed<number | null> => {
      if (!t.trim()) return { ok: true, value: null };
      const v = parseEastWest(t);
      return v === null || Math.abs(v) > 180 ? { ok: false, error: 'Type the variation with its name, for example 11.8 W or 3.5 E.' } : { ok: true, value: v };
    },
    format: (v) => (v === null ? '' : eastWest(v, 1)),
    read: () => form().variationDeg,
    commit: (v) => set({ variationDeg: v }),
  });
  const sigma = parsedField<number | null>('How sure of the reading (°, 1 sigma, optional)', {
    inputmode: 'decimal',
    size: 5,
    help: 'A hand-bearing compass is good to 1° or 2°. Empty: not stated, and nothing guesses it.',
    parse: (t) => parseOptionalNumber(t, { what: 'The bearing uncertainty', min: 0, exclusiveMin: true, max: 45, unit: '°' }),
    format: (v) => (v === null ? '' : String(v)),
    read: () => form().bearingSigmaDeg,
    commit: (v) => set({ bearingSigmaDeg: v }),
  });
  const heading = parsedField<number | null>('The ship’s heading by this compass (°, optional)', {
    term: 'for the deviation table',
    inputmode: 'decimal',
    size: 6,
    help: 'Deviation changes with the heading: give it, and the deviation found here can go into the table.',
    parse: (t) => angleField(t, 'The heading'),
    format: (v) => (v === null ? '' : String(v)),
    read: () => form().headingDeg,
    commit: (v) => set({ headingDeg: v }),
  });

  const horizon = segmented<AmplitudeHorizon>({
    label: 'Which horizon',
    size: 'sm',
    value: form().horizon,
    options: [
      { value: 'visible', label: 'Visible (sea) horizon', tip: 'The limb or centre on the sea horizon: dip, refraction, semidiameter and parallax are worked out' },
      { value: 'celestial', label: 'Celestial horizon', tip: 'The centre at geocentric altitude 0 (the tables’ amplitude)' },
    ],
    onChange: (v) => set({ horizon: v }),
  });
  const limb = segmented<SightLimb>({
    label: 'Which part of the disc',
    size: 'sm',
    value: form().limb,
    options: [
      { value: 'lower', label: 'Lower edge' },
      { value: 'center', label: 'Centre' },
      { value: 'upper', label: 'Upper edge' },
    ],
    onChange: (v) => set({ limb: v }),
  });
  const event = selectInput<'auto' | RiseSet>(
    [
      { value: 'auto', label: 'From the time: whichever is nearest' },
      { value: 'rising', label: 'Rising' },
      { value: 'setting', label: 'Setting' },
    ],
    form().event ?? 'auto',
  );
  event.addEventListener('change', () => set({ event: event.value === 'auto' ? null : (event.value as RiseSet) }));
  const amplitudeBox = h(
    'fieldset',
    { class: 'sfn-group' },
    h('legend', {}, 'The rising or setting'),
    h('div', { class: 'sfn-field' }, h('span', { class: 'sfn-label' }, 'Horizon'), horizon.el),
    h('div', { class: 'sfn-field sfn-compass__limb' }, h('span', { class: 'sfn-label' }, 'On the horizon ', h('span', { class: 'sfn-term' }, '· limb')), limb.el),
    field('Rising or setting', event).el,
    para('Height of eye, pressure and temperature come from the session settings (dip and refraction at the horizon).', 'sfn-note sfn-muted'),
    // The charts2 agent's Sun bearings chart, opened on demand (the Charts module loads then).
    h(
      'div',
      { class: 'sfn-export' },
      btn('The Sun’s rising and setting bearings through the year', () => void import('../../charts/index.js').then((m) => m.showCharts(nc.ctx.store, 'sun', 'bearings')), {
        variant: 'ghost',
        icon: 'charts',
        tip: 'Charts → Sun → Bearings, for the place on the map',
      }),
    ),
  );

  const advanced = h(
    'details',
    { class: 'sfn-advanced', open: form().variationDeg !== null || form().bearingSigmaDeg !== null || form().headingDeg !== null },
    h('summary', {}, 'The chart’s variation, how sure you are, the ship’s heading'),
    h('div', { class: 'sfn-grid-2' }, chartVariation.el, sigma.el),
    heading.el,
  );

  const whereLine = para('', 'sfn-note');
  f.inputs.append(
    variationHost,
    h(
      'section',
      { class: 'sfn-sub' },
      h('h3', {}, 'Compass error from a bearing ', h('span', { class: 'sfn-term' }, '· azimuth or amplitude')),
      whereLine,
      methodWrap,
      h('div', { class: 'sfn-grid-2' }, bodyField.el, kindField.el),
      h('div', { class: 'sfn-entry__time' }, time.el, h('div', { class: 'sfn-entry__time-buttons' }, now, bar)),
      bearing.el,
      amplitudeBox,
      advanced,
    ),
  );

  // --- The deviation table -------------------------------------------------------------------
  const table = deviationTableCard(nc);
  host.append(table.el);
  f.track(() => table.destroy());

  let lastResult: CompassError | null = null;
  const addToTable = (): void => {
    const r = lastResult;
    const hdg = form().headingDeg;
    if (!r || r.deviation_deg === null || hdg === null) return;
    const entry: DeviationEntry = {
      id: `dev-${Date.now().toString(36)}`,
      headingDeg: hdg,
      deviationDeg: r.deviation_deg,
      utc: r.utc,
      source: `${r.body} by ${r.method}`,
      note: '',
    };
    store.patch({ deviations: [...store.get().deviations, entry] });
    nc.say(`Added to the deviation table: heading ${bearing1(hdg)}, deviation ${eastWest(r.deviation_deg)}.`);
  };

  const refreshInputs = (): void => {
    const c = form();
    method.set(c.method);
    horizon.set(c.horizon);
    limb.set(c.limb);
    body.value = c.body;
    kind.value = c.compass;
    event.value = c.event ?? 'auto';
    amplitudeBox.hidden = c.method !== 'amplitude';
    (limb.el.closest('.sfn-compass__limb') as HTMLElement | null)?.toggleAttribute('hidden', c.horizon !== 'visible');
    chartVariation.el.hidden = c.compass !== 'magnetic';
    methodHelp.textContent =
      c.method === 'azimuth'
        ? 'Take the bearing at any time and note the time to the second: the Sun’s bearing can turn a degree in a few minutes.'
        : 'Take the bearing as the body rises or sets: at the horizon its bearing depends on the latitude and the declination alone, so the time need only be rough.';
    for (const x of [time, bearing, chartVariation, sigma, heading]) x.refresh();
  };

  const deps = (w: Working) => [w.compass, w.session.observer, w.session.clock.dut1_s] as const;
  f.track(
    autoRun(
      nc,
      deps,
      (isCurrent) => {
        refreshInputs();
        const w = store.get();
        const explorer = nc.ctx.store.get();
        const place = compassPlace(w, explorer);
        const when = compassUtc(w.compass, explorer);
        const jd = jdFromIso(when.utc) ?? explorer.time.jd_utc;
        const format = angleFormat(nc);
        const z = zone(nc, jd);
        // The clock's ± chip beside the time (time-ui; chip2 `CLOCK`): shown when the Earth's
        // rotation then is uncertain by more than 30 s, and always outside the validated tier.
        const tier = sightTierAt(nc.ctx, jd);
        whereLine.replaceChildren(
          `At ${fmtPosition(place, format)} (${place.label}), ${when.fromForm ? 'at the time you gave' : 'at the time on the time bar'}: ${fmtInstant(jd, z)}.`,
          ' ',
          uncertaintyChip(tier.clock),
        );

        // Variation at the place and date.
        let mf: MagneticField | null = null;
        try {
          mf = engine.magneticField(place.lat_deg, place.lon_deg, place.height_m, jd);
          variationHost.replaceChildren(h('h3', {}, 'Magnetic variation here ', h('span', { class: 'sfn-term' }, '· declination')), variationBlock(mf, place.label, format));
        } catch (error) {
          // The model's "No magnetic variation for -583.6: …" with the year as the page
          // writes years (585 BC; polish2), and as a plain caution, not an error.
          const text = errorText(error).replace(/^(No magnetic variation for )-?\d+(?:\.\d+)?:/, (_m, lead: string) => `${lead}${formatYear(wallClock(jd, z).year)}:`);
          variationHost.replaceChildren(h('h3', {}, 'Magnetic variation here'), notice(/^No magnetic variation for /.test(text) ? 'caution' : 'error', text));
        }
        if (!isCurrent()) return;

        // A bearing of a body is a sight: none outside the validated tier (tier.ts, time-ui's
        // `tierAt` and `sightsOnlyText`). The variation above has its own model years.
        if (!tier.offered) {
          lastResult = null;
          f.setStatus('idle');
          f.results.replaceChildren(notice('caution', tier.sentence ?? 'No sights for this date.'));
          return;
        }

        const req = compassRequest(w, explorer);
        if ('missing' in req) {
          // No reading yet: say where the body is, so the person knows what to look for.
          lastResult = null;
          f.setStatus('idle');
          const probe = compassRequest(w, explorer, 0);
          if ('request' in probe) {
            try {
              const r = engine.compassError(probe.request);
              const variation = r.variation?.deg ?? null;
              f.results.replaceChildren(
                notice(
                  'info',
                  h('strong', {}, `${req.missing} `),
                  `${r.body} ${r.method === 'amplitude' ? `${r.amplitude?.event === 'rising' ? 'rises' : 'sets'} bearing ${bearing1(r.true_bearing_deg)} true at ${fmtInstant(r.jd_utc, z)}` : `bears ${bearing1(r.true_bearing_deg)} true${r.azimuth ? `, ${r.azimuth.altitude_deg >= 0 ? `${fmtAngle(r.azimuth.altitude_deg, format)} high` : `${fmtAngle(-r.azimuth.altitude_deg, format)} below the horizon`}` : ''}`}.` +
                    (w.compass.compass === 'magnetic' && variation !== null
                      ? ` With the variation (${eastWest(variation, 1)}), a magnetic compass with no deviation would read ${bearing1(r.true_bearing_deg - variation)}.`
                      : ''),
                ),
              );
            } catch (error) {
              f.results.replaceChildren(notice('info', req.missing), notice('caution', errorText(error)));
            }
          } else f.results.replaceChildren(notice('info', req.missing));
          return;
        }
        f.setStatus('busy');
        let r: CompassError;
        try {
          r = engine.compassError(req.request);
        } catch (error) {
          if (!isCurrent()) return;
          lastResult = null;
          f.setStatus({ error: errorText(error) });
          f.results.replaceChildren();
          return;
        }
        if (!isCurrent()) return;
        f.setStatus('idle');
        lastResult = r;
        const hdg = w.compass.headingDeg;
        const canAdd = r.deviation_deg !== null && hdg !== null;
        const addButton = btn('Add to the deviation table', addToTable, { icon: 'plus', variant: 'outline' });
        addButton.disabled = !canAdd;
        f.results.replaceChildren(
          ...kids(
          h('div', { class: 'sfn-readout-line' }, h('p', { class: 'sfn-compass__sentence' }, r.sentence)),
          para(r.explanation, 'sfn-plain'),
          resultFacts(r, z, format),
          r.notes.length ? h('ul', { class: 'sfn-list sfn-muted' }, ...r.notes.map((n) => h('li', {}, n))) : null,
          h(
            'div',
            { class: 'sfn-export' },
            addButton,
            h(
              'span',
              { class: 'sfn-note sfn-muted' },
              r.deviation_deg === null
                ? ' A gyrocompass, or no variation for the date: there is no deviation to log.'
                : hdg === null
                  ? ' Give the ship’s heading (above) to log this deviation against it.'
                  : ` Logs ${eastWest(r.deviation_deg)} on heading ${bearing1(hdg)}.`,
            ),
          ),
          ),
        );
      },
      200,
      (s) => [s.observer.lat_deg, s.observer.lon_deg, s.observer.height_m, Math.round(s.time.jd_utc * 1440)].join('|'),
    ),
  );
  return { destroy: () => f.destroy() };
}

/** A bearing or heading, [0, 360), or empty (not stated). */
function angleField(t: string, what: string): Parsed<number | null> {
  const r = parseOptionalNumber(t, { what, min: 0, max: 360, unit: '°' });
  if (!r.ok || r.value === null) return r;
  return { ok: true, value: r.value === 360 ? 0 : r.value };
}
