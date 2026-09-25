/**
 * The session's own settings: name, kind (SIMULATED or REAL, with its badge), notes, the
 * observer (height of eye, pressure, temperature), the assumed position and what it is
 * allowed to do (a starting point, a prior, or nothing), the instrument and the clock.
 * A one-line summary stays visible when the panel is closed. OWNER: navigate agent.
 */

import { h } from '../../dom.js';
import type { AssumedPositionRole, HorizonName, Session, SessionKind } from '../../types.js';
import { horizonName } from '../../types.js';
import { disposer, type Mounted } from '../component.js';
import { badge } from '../theme/primitives.js';
import { angleFormat, type NavCtx } from './context.js';
import { fmtArcmin, fmtPosition, positionInputText } from './format.js';
import { patchSession, type SessionPatch } from './model.js';
import { parseNumber, parsePosition, type Parsed } from './parse.js';
import { horizonFromSelect, horizonOptions, horizonSummary, horizonText, ROLE_TEXT } from './text.js';
import { btn, field, onChange, para, parsedField, selectInput, textInput, type ParsedField } from './ui.js';

export function sessionPanel(host: HTMLElement, nc: NavCtx): Mounted {
  const d = disposer();
  const { store } = nc.working;
  const session = (): Session => store.get().session;
  const patch = (p: SessionPatch): void => store.patch({ session: patchSession(session(), p) });

  const summary = h('summary', { class: 'sfn-session__summary' });
  const details = h('details', { class: 'sf-card sfn-card sfn-session' }, summary);
  host.append(details);
  d.add(() => details.remove());

  const body = h('div', { class: 'sfn-card__body sfn-session__body' });
  details.append(body);

  // --- Session ----------------------------------------------------------------------------
  const name = textInput({ value: session().meta.name });
  name.addEventListener('change', () => patch({ meta: { name: name.value.trim() } }));
  const kind = selectInput<SessionKind>(
    [
      { value: 'real', label: 'REAL — measured with an instrument' },
      { value: 'simulated', label: 'SIMULATED — generated, not measured' },
    ],
    session().meta.kind,
  );
  kind.addEventListener('change', () => patch({ meta: { kind: kind.value as SessionKind } }));
  const notes = h('textarea', { class: 'sf-input sfn-textarea', rows: 2 });
  notes.value = session().meta.notes;
  notes.addEventListener('change', () => patch({ meta: { notes: notes.value } }));
  const schema = h('output', { class: 'sfn-muted' });

  // --- Assumed position --------------------------------------------------------------------
  const position: ParsedField = parsedField('Assumed position', {
    term: 'DR, latitude then longitude',
    placeholder: '39 57.2 N, 075 09.9 W',
    help: 'Where you think you are. Leave empty for none: the fix then searches the whole globe.',
    parse: (text): Parsed<{ lat_deg: number; lon_deg: number } | null> => (text.trim() ? parsePosition(text) : { ok: true, value: null }),
    format: (p) => (p ? positionInputText(p) : ''),
    read: () => session().observer.assumed_position,
    commit: (p) => patch({ observer: { assumed_position: p } }),
  });
  const usePlace = btn('Use the map’s place', () => {
    const o = nc.ctx.store.get().observer;
    patch({ observer: { assumed_position: { lat_deg: o.lat_deg, lon_deg: o.lon_deg } } });
    position.refresh(true);
  }, { variant: 'outline', icon: 'pin', tip: 'The place set on the map and in the side panel' });
  const role = selectInput<AssumedPositionRole['role']>(
    (['initializer', 'prior', 'disabled'] as const).map((r) => ({ value: r, label: ROLE_TEXT[r].label })),
    session().observer.assumed_position_role.role,
  );
  const roleField = field('What it may do', role, { term: 'initializer, prior or not used', help: ROLE_TEXT[session().observer.assumed_position_role.role].explain });
  const priorSigma = parsedField<number>('Prior 1-sigma radius (NM)', {
    help: 'How far off it could be. A prior changes the answer; the fix is reported with and without it.',
    parse: (t) => parseNumber(t, { what: 'The prior radius', min: 0, exclusiveMin: true, unit: 'NM' }),
    format: (v) => String(v),
    read: () => {
      const r = session().observer.assumed_position_role;
      return r.role === 'prior' ? r.sigma_nm : 20;
    },
    commit: (v) => patch({ observer: { assumed_position_role: { role: 'prior', sigma_nm: v } } }),
  });
  role.addEventListener('change', () => {
    const current = session().observer.assumed_position_role;
    const next: AssumedPositionRole =
      role.value === 'prior'
        ? { role: 'prior', sigma_nm: current.role === 'prior' ? current.sigma_nm : 20 }
        : role.value === 'disabled'
          ? { role: 'disabled' }
          : { role: 'initializer' };
    patch({ observer: { assumed_position_role: next } });
  });

  // --- Observer, instrument, clock ---------------------------------------------------------------
  const num = (label: string, term: string | undefined, help: string, read: () => number, commit: (v: number) => void, min?: number, unit?: string) =>
    parsedField<number>(label, {
      term,
      help,
      inputmode: 'decimal',
      size: 8,
      parse: (t) => parseNumber(t, { what: label.replace(/ \(.*\)$/, ''), min, unit }),
      format: (v) => String(v),
      read,
      commit,
    });
  const hoe = num('Height of eye (m)', 'dip', 'Your eye above the sea. Enters the dip of the sea horizon only.', () => session().observer.height_of_eye_m, (v) => patch({ observer: { height_of_eye_m: v } }), 0, 'm');
  const pressure = num('Air pressure (hPa)', undefined, 'Scales refraction. Standard is 1010 hPa.', () => session().observer.pressure_hpa, (v) => patch({ observer: { pressure_hpa: v } }), 0, 'hPa');
  const temperature = num('Air temperature (°C)', undefined, 'Scales refraction. Standard is 10 °C.', () => session().observer.temperature_c, (v) => patch({ observer: { temperature_c: v } }), -80);
  const instrumentName = textInput({ value: session().instrument.name, placeholder: 'Optional' });
  instrumentName.addEventListener('change', () => patch({ instrument: { name: instrumentName.value.trim() } }));
  const ic = num('Index correction to add (′)', 'IC', 'Index error 2.0′ on the arc means an index correction of −2.0′.', () => session().instrument.index_correction_arcmin, (v) => patch({ instrument: { index_correction_arcmin: v } }));
  const horizon = selectInput<HorizonName>(horizonOptions(session().instrument.horizon), horizonName(session().instrument.horizon));
  const horizonField = field('Horizon', horizon, { help: horizonText(session().instrument.horizon).explain });
  horizon.addEventListener('change', () => {
    const chosen = horizonFromSelect(horizon.value, session().instrument.horizon);
    if (chosen) patch({ instrument: { horizon: chosen } });
  });
  const clockSigma = num('Clock uncertainty (s, 1 sigma)', undefined, 'Propagated into an east-west term of the position uncertainty, never estimated: for star sights a clock error and a longitude error are the same unknown.', () => session().clock.uncertainty_s, (v) => patch({ clock: { uncertainty_s: v } }), 0, 's');
  const clockCorrection = num('Known watch correction (s)', 'chronometer correction, added', 'Added to every recorded time before use.', () => session().clock.correction_s, (v) => patch({ clock: { correction_s: v } }));

  const mode = selectInput<'auto' | 'supplied'>(
    [
      { value: 'auto', label: 'The built-in almanac, unless a sight gives its own' },
      { value: 'supplied', label: 'Only the values typed into each sight' },
    ],
    store.get().mode,
  );
  mode.addEventListener('change', () => store.patch({ mode: mode.value as 'auto' | 'supplied' }));
  const modeField = field('Body directions come from', mode, {
    term: 'ephemeris mode, auto or supplied',
    help: 'The built-in almanac covers the Sun, the Moon, Venus, Mars, Jupiter, Saturn and the 58 navigational stars, 1990–2060. A GHA and declination typed into a sight always win and the workings say so. “Only typed values” isolates the solver from the astronomy.',
  });

  const group = (title: string, ...children: (HTMLElement | null)[]) =>
    h('fieldset', { class: 'sfn-group' }, h('legend', {}, title), ...children.filter((c): c is HTMLElement => c !== null));

  body.append(
    group(
      'Session',
      h('div', { class: 'sfn-grid-2' }, field('Name', name).el, field('Kind', kind, { help: 'Shown on every result, and written into exports.' }).el),
      field('Notes', notes).el,
      h('p', { class: 'sfn-note sfn-muted' }, 'Schema ', schema),
    ),
    group('Assumed position', position.el, h('div', { class: 'sfn-inline' }, usePlace), h('div', { class: 'sfn-grid-2' }, roleField.el, priorSigma.el)),
    group('Observer', h('div', { class: 'sfn-grid-3' }, hoe.el, pressure.el, temperature.el)),
    group('Instrument', h('div', { class: 'sfn-grid-3' }, field('Name', instrumentName).el, ic.el, horizonField.el)),
    group('Clock', h('div', { class: 'sfn-grid-2' }, clockSigma.el, clockCorrection.el)),
    group('Almanac', modeField.el),
  );

  const fields: ParsedField[] = [position, priorSigma, hoe, pressure, temperature, ic, clockSigma, clockCorrection];

  function render(): void {
    const s = session();
    const r = s.observer.assumed_position_role;
    const f = angleFormat(nc);
    summary.replaceChildren(
      h('span', { class: 'sfn-session__title' }, h('strong', {}, s.meta.name || 'Untitled session'), ' '),
      badge(s.meta.kind === 'simulated' ? 'simulated' : 'real', { text: s.meta.kind === 'simulated' ? 'SIMULATED' : 'REAL' }),
      h(
        'span',
        { class: 'sfn-session__facts' },
        s.observer.assumed_position
          ? `DR ${fmtPosition(s.observer.assumed_position, f)} (${r.role === 'prior' ? `prior, ${r.sigma_nm} NM` : r.role === 'disabled' ? 'not used' : 'starting point only'})`
          : 'No assumed position',
        ` · eye ${s.observer.height_of_eye_m} m · IC ${fmtArcmin(s.instrument.index_correction_arcmin, 1)} · ${horizonSummary(s.instrument.horizon)}` +
          (s.clock.uncertainty_s ? ` · clock ±${s.clock.uncertainty_s} s` : '') +
          (store.get().mode === 'supplied' ? ' · typed directions only' : ''),
      ),
      h('span', { class: 'sfn-session__edit' }, 'Session settings'),
    );
    if (document.activeElement !== name) name.value = s.meta.name;
    if (document.activeElement !== notes) notes.value = s.meta.notes;
    if (document.activeElement !== instrumentName) instrumentName.value = s.instrument.name;
    kind.value = s.meta.kind;
    role.value = r.role;
    roleField.setHelp(ROLE_TEXT[r.role].explain);
    priorSigma.el.hidden = r.role !== 'prior';
    // A session loaded with a shore horizon needs that option in the list.
    const options = horizonOptions(s.instrument.horizon);
    if (options.length !== horizon.options.length) {
      horizon.replaceChildren(...options.map((o) => h('option', { value: o.value }, o.label)));
    }
    horizon.value = horizonName(s.instrument.horizon);
    horizonField.setHelp(horizonText(s.instrument.horizon).explain);
    schema.textContent = s.schema;
    mode.value = store.get().mode;
    for (const f2 of fields) f2.refresh();
  }

  d.add(onChange(store, (w) => w.session, render));
  d.add(onChange(store, (w) => w.mode, render));
  d.add(onChange(nc.ctx.store, (s) => s.settings.angleFormat, render));
  render();
  if (!session().observer.assumed_position) details.open = true;
  body.append(para('Nothing here leaves this browser. The assumed position is used as the method says above, and never written into the address bar.', 'sfn-note sfn-muted'));
  return { destroy: () => d.dispose() };
}
