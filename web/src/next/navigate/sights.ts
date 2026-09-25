/**
 * "Your sights": the list of observations with each one's live correction workings, and
 * the form that enters a sight body first (body, time, sextant reading in degrees and
 * decimal minutes, limb for the Sun and the Moon, index correction, height of eye and
 * horizon; the altitude kind, a horizon override and your own almanac GHA and declination
 * under "Advanced"). OWNER: navigate agent.
 *
 * Bodies to shoot from the planner are listed above the sights as guides: "Enter reading"
 * fills the form with the body, limb and time, and shows the predicted reading as a hint;
 * the reading itself is always typed by the person. A prediction never becomes an
 * observation on its own.
 */

import type { ReduceEntry } from '../../api/adapter.js';
import { h } from '../../dom.js';
import type { AltitudeKind, HorizonMode, HorizonName, Limb, Observation, Warning } from '../../types.js';
import { horizonName, isShoreHorizon, WARNING_SEVERITY } from '../../types.js';
import { disposer, type Mounted } from '../component.js';
import type { SightBodyInfo, SightLimb } from '../engine/types.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
import { segmented, type Segmented } from '../theme/primitives.js';
import { formatDate, isoUtc, jdFromIso, jdNow, zoneShortName } from '../time.js';
import { angleFormat, hasDisc, kindOf, zone, type NavCtx } from './context.js';
import {
  angleInputText,
  fmtAngle,
  fmtBearing,
  fmtNm,
  fmtSigma,
  fmtZoneClock,
  utcInputText,
} from './format.js';
import { nextObservationId, patchSession, sortedByTime, withObservation, withoutObservation, type PlannedSight } from './model.js';
import { parseAngle, parseNumber, parseUtcInput } from './parse.js';
import { shoreDistanceField } from './shore.js';
import { starIdPanel } from './starid.js';
import { DEFAULT_SHORE_NM, horizonFromSelect, horizonOptions, horizonText, KIND_TEXT, LIMB_TEXT } from './text.js';
import { sightTierAt } from './tier.js';
import { btn, card, checkbox, debounce, errorText, field, notice, para, selectInput, textInput, uid, warningList, type FieldParts } from './ui.js';
import { openSightWorksheet } from './print/open.js';
import { sightWorkings } from './workings.js';

const OTHER = '__other__';

function bodyOptions(bodies: readonly SightBodyInfo[]) {
  const group = (k: SightBodyInfo['kind']) => (k === 'sun' || k === 'moon' ? 'Sun and Moon' : k === 'planet' ? 'Planets' : 'Stars (A–Z)');
  const order = { sun: 0, moon: 1, planet: 2, star: 3 } as const;
  const sorted = [...bodies].sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === 'star' ? a.body.localeCompare(b.body) : 0));
  return [
    ...sorted.map((b) => ({ value: b.body, label: b.body, group: group(b.kind) })),
    { value: OTHER, label: 'Another body (give its GHA and declination under Advanced)', group: 'Other' },
  ];
}

export interface SightsPanel extends Mounted {
  /** Open the form on a new sight of this planned body. */
  enterPlanned(p: PlannedSight): void;
}

export function sightsPanel(host: HTMLElement, nc: NavCtx): SightsPanel {
  const d = disposer();
  const { store } = nc.working;
  const fmt = () => angleFormat(nc);

  // In "supplied" mode a sight without its own GHA and declination cannot be reduced, so the
  // list says which mode is on (the switch itself is in the session settings).
  const modeLine = h('p', { class: 'sfn-note sfn-mode-line' });

  const c = card('Your sights', { class: 'sfn-sights', iconName: 'sextant' });
  const count = h('span', { class: 'sfn-count', 'aria-live': 'polite' });
  c.head.querySelector('h2')?.append(count);
  host.append(c.el);
  d.add(() => c.el.remove());

  const planned = h('div', { class: 'sfn-planned' });
  const list = h('ol', { class: 'sfn-sight-list', 'aria-label': 'Sights, in time order' });
  const empty = para('No sights yet. Enter your first one below: choose the body, the time, and what the sextant read.', 'sfn-empty');
  const status = h('p', { class: 'sfn-status', role: 'status' });
  c.body.append(modeLine, planned, list, empty, status);

  // --- The entry form ---------------------------------------------------------------------
  const form = h('form', { class: 'sfn-entry', novalidate: true, 'aria-labelledby': uid('sfn-entry') });
  const formTitle = h('h3', { class: 'sfn-entry__title', id: form.getAttribute('aria-labelledby')! }, 'Add a sight');
  c.body.append(form);

  let editing: string | null = null;
  let plannedHint: PlannedSight | null = null;
  /** Values loaded for editing, kept at full precision while their text is unchanged. */
  const originals = new Map<HTMLInputElement, { text: string; value: number }>();
  const remember = (input: HTMLInputElement, text: string, value: number): void => {
    input.value = text;
    originals.set(input, { text, value });
  };
  const exact = <T extends { ok: boolean }>(input: HTMLInputElement, parsed: T): T => {
    const o = originals.get(input);
    return o && o.text === input.value ? ({ ok: true, value: o.value } as unknown as T) : parsed;
  };

  const bodySelect = selectInput(bodyOptions(nc.bodies), nc.bodies[0]?.body ?? OTHER);
  const bodyGlyphHolder = h('span', { class: 'sfn-entry__glyph', 'aria-hidden': 'true' });
  const otherBody = textInput({ placeholder: 'Name, for example HIP 21421' });
  const bodyField = field('Body', bodySelect, { help: null });
  const otherField = field('Name of the other body', otherBody, { help: 'Any name works when you give its GHA and declination under Advanced.' });
  const bodyRow = h('div', { class: 'sfn-entry__body' }, bodyGlyphHolder, bodyField.el);

  const limbSeg: Segmented<Limb> = segmented<Limb>({
    label: 'Which edge of the disc',
    size: 'sm',
    value: 'lower',
    options: (['lower', 'center', 'upper'] as Limb[]).map((l) => ({ value: l, label: LIMB_TEXT[l] })),
    onChange: () => preview.run(),
  });
  const limbWrap = h('div', { class: 'sfn-field' }, h('span', { class: 'sfn-label', id: uid('sfn-limb') }, 'Edge of the disc ', h('span', { class: 'sfn-term' }, '· limb')), limbSeg.el);
  limbSeg.el.setAttribute('aria-labelledby', limbWrap.firstElementChild!.id);

  const timeInput = textInput({ placeholder: 'yyyy-mm-dd hh:mm:ss', inputmode: 'numeric', size: 20 });
  const timeField = field('Time of the sight (UTC)', timeInput, { help: null });
  const nowBtn = btn('Now', () => setTime(isoUtc(jdNow())), { tip: 'The time on this computer’s clock, now', variant: 'outline' });
  const barBtn = btn('Time bar', () => setTime(isoUtc(nc.ctx.store.get().time.jd_utc)), { tip: 'The time shown on the explorer’s time bar', variant: 'ghost' });
  const timeRow = h('div', { class: 'sfn-entry__time' }, timeField.el, h('div', { class: 'sfn-entry__time-buttons' }, nowBtn, barBtn));

  const hsInput = textInput({ placeholder: 'degrees minutes', inputmode: 'decimal', size: 12 });
  const hsField = field('Sextant reading', hsInput, { term: 'Hs, degrees and minutes', help: 'Degrees, a space, then minutes: 45 54.0 means 45° 54.0′.' });
  const sigmaInput = textInput({ value: '1.0', inputmode: 'decimal', size: 6 });
  const sigmaField = field('How sure (±, arcminutes)', sigmaInput, { term: '1 sigma', help: 'About 1′ at sea; 0.2′ from a steady platform.' });

  const icInput = textInput({ inputmode: 'decimal', size: 6 });
  const icField = field('Instrument error to add', icInput, { term: 'index correction, IC (′)', help: 'Index error “on the arc” is a minus correction: on the arc 2.0′ → −2.0.' });
  const hoeInput = textInput({ inputmode: 'decimal', size: 6 });
  const hoeField = field('Height of eye (m)', hoeInput, { term: 'dip', help: 'Your eye above the sea.' });
  const horizonSelect = selectInput<HorizonName>(
    horizonOptions(store.get().session.instrument.horizon),
    horizonName(store.get().session.instrument.horizon),
  );
  const horizonField = field('Horizon', horizonSelect, { help: horizonText(store.get().session.instrument.horizon).explain });
  /** Rebuild a horizon select's options (a shore horizon brings its own). */
  const setHorizonOptions = (select: HTMLSelectElement, options: { value: string; label: string }[]): void => {
    select.replaceChildren(...options.map((o) => h('option', { value: o.value }, o.label)));
  };
  /** The horizon of the sight being edited: a shore horizon is kept as it is. */
  let editingHorizon: HorizonMode | null = null;
  // navigate2: a shoreline nearer than the sea horizon needs its distance (dip short).
  const instrumentShore = shoreDistanceField({
    read: () => store.get().session.instrument.horizon,
    heightOfEyeM: () => store.get().session.observer.height_of_eye_m,
    commit: (hz) => store.patch({ session: patchSession(store.get().session, { instrument: { horizon: hz } }) }),
  });
  instrumentShore.el.classList.add('sfn-entry__shore');
  const instrument = h(
    'fieldset',
    { class: 'sfn-entry__instrument' },
    h('legend', {}, 'Your instrument (the same for every sight)'),
    icField.el,
    hoeField.el,
    horizonField.el,
    instrumentShore.el,
  );

  // Advanced
  const kindSelect = selectInput<AltitudeKind>(
    (Object.keys(KIND_TEXT) as AltitudeKind[]).map((k) => ({ value: k, label: KIND_TEXT[k].option })),
    'sextant_hs',
  );
  const kindField = field('What the number is', kindSelect, { term: 'altitude kind', help: 'Corrections run only from this point on, never twice (CONVENTIONS 4).' });
  const inheritOption = { value: 'inherit' as const, label: 'Same as the instrument' };
  const overrideSelect = selectInput<HorizonName | 'inherit'>([inheritOption, ...horizonOptions(null)], 'inherit');
  const overrideField = field('Horizon for this sight only', overrideSelect, { term: 'horizon override' });
  // navigate2: this sight's own shoreline distance, when its horizon is a shore.
  const overrideShore = shoreDistanceField({
    read: () => (overrideSelect.value === 'shore' ? (isShoreHorizon(editingHorizon) ? editingHorizon : { shore: { distance_nm: DEFAULT_SHORE_NM } }) : null),
    heightOfEyeM: () => store.get().session.observer.height_of_eye_m,
    commit: (hz) => {
      editingHorizon = hz;
      overrideShore.refresh(true);
      preview.run();
    },
    label: 'Distance to the waterline for this sight (NM)',
  });
  const supplied = checkbox('Use my own almanac values for this sight', false, () => {
    suppliedBox.hidden = !supplied.input.checked;
    preview.run();
  }, 'They win over the built-in almanac.');
  const ghaInput = textInput({ placeholder: '123 27.4', inputmode: 'decimal', size: 10 });
  const decInput = textInput({ placeholder: '38 47.3 or -16 43.2', inputmode: 'decimal', size: 10 });
  const sdInput = textInput({ placeholder: '0', inputmode: 'decimal', size: 6 });
  const hpInput = textInput({ placeholder: '0', inputmode: 'decimal', size: 6 });
  const ghaField = field('Greenwich hour angle', ghaInput, { term: 'GHA, west-positive' });
  const decField = field('Declination', decInput, { term: 'Dec, north-positive' });
  const sdField = field('Semidiameter (′)', sdInput, { term: 'SD' });
  const hpField = field('Horizontal parallax (′)', hpInput, { term: 'HP' });
  const suppliedBox = h('div', { class: 'sfn-grid-2', hidden: true }, ghaField.el, decField.el, sdField.el, hpField.el);
  const notesInput = textInput({ placeholder: 'Optional' });
  const notesField = field('Notes', notesInput);
  const idInput = textInput({ size: 10 });
  const idField = field('Label', idInput, { term: 'id', help: 'Warnings name sights by this label.' });
  const advanced = h(
    'details',
    { class: 'sfn-advanced' },
    h('summary', {}, 'Advanced: altitude kind, horizon for this sight, your own GHA and declination'),
    h('div', { class: 'sfn-grid-2' }, kindField.el, overrideField.el),
    overrideShore.el,
    supplied.el,
    suppliedBox,
    h('div', { class: 'sfn-grid-2' }, notesField.el, idField.el),
  );

  // navigate2: "What did I shoot?" (star identification) from the form's time and reading.
  const starId = starIdPanel(
    nc,
    () => {
      const utc = parseUtcInput(timeInput.value);
      const kind = kindSelect.value as AltitudeKind;
      const hs = exact(hsInput, parseAngle(hsInput.value, { ...hsRule(), what: 'The reading' }));
      const horizon = overrideSelect.value === 'inherit' ? store.get().session.instrument.horizon : (horizonFromSelect(overrideSelect.value, editingHorizon) ?? store.get().session.instrument.horizon);
      return { utc: utc.ok ? utc.value : null, altitudeDeg: hs.ok ? hs.value : null, altitudeKind: kind, horizon };
    },
    (body) => {
      const known = nc.bodies.find((b) => b.body.toLowerCase() === body.toLowerCase());
      bodySelect.value = known ? known.body : OTHER;
      otherBody.value = known ? '' : body;
      syncBodyUi();
      preview.run();
      bodySelect.focus({ preventScroll: true });
    },
  );
  d.add(() => starId.destroy());
  // navigate2: sights only in the validated tier (CONVENTIONS 15.1).
  const tierBox = h('div', { class: 'sfn-entry__tier', 'aria-live': 'polite' });
  const previewBox = h('div', { class: 'sfn-entry__preview', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'sf-btn sf-btn--primary' }, icon('plus'), h('span', { class: 'sf-btn__label' }, 'Add sight'));
  const cancel = btn('Cancel', () => resetForm(), { variant: 'ghost' });
  const clear = btn('Clear the form', () => resetForm(true), { variant: 'ghost' });
  form.append(
    formTitle,
    h('div', { class: 'sfn-entry__grid' }, bodyRow, limbWrap, otherField.el, timeRow, h('div', { class: 'sfn-entry__reading' }, hsField.el, sigmaField.el)),
    tierBox,
    starId.el,
    instrument,
    advanced,
    h('div', { class: 'sfn-entry__preview-wrap' }, h('h4', {}, 'This sight, worked out'), previewBox),
    h('div', { class: 'sfn-entry__actions' }, submit, cancel, clear),
  );

  // --- Form state ---------------------------------------------------------------------------
  const currentBody = (): string => (bodySelect.value === OTHER ? otherBody.value.trim() : bodySelect.value);

  function syncBodyUi(): void {
    const body = currentBody();
    const kind = kindOf(nc, body || 'star');
    bodyGlyphHolder.replaceChildren(bodyGlyph(body || 'star', { kind, size: 20 }));
    otherField.el.hidden = bodySelect.value !== OTHER;
    // A star or a planet is a point of light: a limb means nothing for it (the core would
    // ignore one with a warning), so the choice is shown for the Sun and the Moon only.
    limbWrap.hidden = !hasDisc(kind);
    if (!hasDisc(kind)) limbSeg.set('center');
    else if (limbSeg.value() === 'center' && editing === null && !plannedHint) limbSeg.set('lower');
  }

  function setTime(utc: string): void {
    timeInput.value = utcInputText(utc);
    timeInput.dispatchEvent(new Event('input'));
    timeField.setError(null);
    updateTimeHelp();
  }

  /** navigate2: no sight outside the validated tier; the form says why (tier.ts). */
  function updateTier(jd: number | null): void {
    const t0 = jd === null ? null : sightTierAt(nc.ctx.engine, jd);
    const blocked = t0 !== null && !t0.offered;
    tierBox.replaceChildren(...(blocked ? [notice('caution', t0!.sentence ?? 'No sights for this date.')] : []));
    submit.disabled = blocked;
    // time-ui: the labelled-tier chip (±ΔT) belongs beside the time here once web/src/next/time/ lands.
  }

  function updateTimeHelp(): void {
    const parsed = parseUtcInput(timeInput.value);
    if (!parsed.ok) {
      updateTier(null);
      timeField.setHelp(timeInput.value.trim() ? null : 'Year-month-day hours:minutes:seconds, in UTC. “Now” fills in this computer’s clock.');
      return;
    }
    const jd = jdFromIso(parsed.value)!;
    updateTier(jd);
    const z = zone(nc);
    // A time typed without seconds is taken, not refused, and the help says what that
    // assumed (parse.ts, SECONDS_OMITTED_WARNING).
    timeField.setHelp(`= ${fmtZoneClock(jd, z)} on ${formatDate(jd, z)} (${z.kind === 'iana' ? z.zone : z.name})${parsed.warning ? `. ${parsed.warning}` : ''}`);
  }

  function hsRule(): { min: number; max: number } {
    const horizon = overrideSelect.value === 'inherit' ? store.get().session.instrument.horizon : horizonFromSelect(overrideSelect.value, editingHorizon);
    return kindSelect.value === 'sextant_hs' && horizon === 'artificial_reflected' ? { min: 0, max: 180 } : { min: -90, max: 90 };
  }

  /** The observation the form describes, or the errors by field. */
  function readForm(forPreview: boolean): { obs: Observation } | { errors: Map<FieldParts, string> } {
    const errors = new Map<FieldParts, string>();
    const body = currentBody();
    if (!body) errors.set(bodySelect.value === OTHER ? otherField : bodyField, 'Choose a body, or name the other body.');
    const utc = parseUtcInput(timeInput.value);
    if (!utc.ok) errors.set(timeField, utc.error);
    const rule = hsRule();
    const kind = kindSelect.value as AltitudeKind;
    const hs = exact(hsInput, parseAngle(hsInput.value, { ...rule, what: `The ${KIND_TEXT[kind].plain.toLowerCase()}`, example: '45 54.0' }));
    if (!hs.ok) errors.set(hsField, hs.error);
    const sigma = exact(sigmaInput, parseNumber(sigmaInput.value, { what: 'The uncertainty', min: 0, exclusiveMin: true, unit: '′' }));
    if (!sigma.ok) errors.set(sigmaField, sigma.error);
    let geocentric: Observation['geocentric'] = null;
    if (supplied.input.checked) {
      const gha = exact(ghaInput, parseAngle(ghaInput.value, { min: 0, max: 360, what: 'The GHA', example: '123 27.4' }));
      const dec = exact(decInput, parseAngle(decInput.value, { min: -90, max: 90, what: 'The declination', example: '-16 43.2' }));
      const sd = exact(sdInput, sdInput.value.trim() ? parseNumber(sdInput.value, { what: 'The semidiameter', min: 0, unit: '′' }) : { ok: true as const, value: 0 });
      const hp = exact(hpInput, hpInput.value.trim() ? parseNumber(hpInput.value, { what: 'The horizontal parallax', min: 0, unit: '′' }) : { ok: true as const, value: 0 });
      if (!gha.ok) errors.set(ghaField, gha.error);
      if (!dec.ok) errors.set(decField, dec.error);
      if (!sd.ok) errors.set(sdField, sd.error);
      if (!hp.ok) errors.set(hpField, hp.error);
      if (gha.ok && dec.ok && sd.ok && hp.ok) {
        geocentric = { gha_deg: gha.value >= 360 ? 0 : gha.value, dec_deg: dec.value, semidiameter_arcmin: sd.value, horizontal_parallax_arcmin: hp.value };
      }
    }
    const id = idInput.value.trim() || (editing ?? nextObservationId(store.get().session));
    if (!forPreview && store.get().session.observations.some((o) => o.id === id && o.id !== editing)) {
      errors.set(idField, `Another sight already has the label ${id}.`);
    }
    if (errors.size) return { errors };
    const kindOfBody = kindOf(nc, body);
    return {
      obs: {
        id,
        body,
        utc: (utc as { value: string }).value,
        altitude_deg: (hs as { value: number }).value,
        altitude_kind: kind,
        sigma_arcmin: (sigma as { value: number }).value,
        limb: hasDisc(kindOfBody) ? limbSeg.value() : 'center',
        horizon: overrideSelect.value === 'inherit' ? null : horizonFromSelect(overrideSelect.value, editingHorizon),
        geocentric,
        notes: notesInput.value.trim(),
      },
    };
  }

  const allFields = [bodyField, otherField, timeField, hsField, sigmaField, ghaField, decField, sdField, hpField, idField];

  function showErrors(errors: Map<FieldParts, string>): void {
    for (const f of allFields) f.setError(errors.get(f) ?? null);
  }

  function resetForm(everything = false): void {
    const wasEditing = editing !== null;
    editing = null;
    plannedHint = null;
    formTitle.textContent = 'Add a sight';
    submit.querySelector('.sf-btn__label')!.textContent = 'Add sight';
    cancel.hidden = true;
    originals.clear();
    hsInput.value = '';
    notesInput.value = '';
    idInput.value = '';
    idInput.placeholder = nextObservationId(store.get().session);
    supplied.input.checked = false;
    suppliedBox.hidden = true;
    for (const i of [ghaInput, decInput, sdInput, hpInput]) i.value = '';
    if (everything || wasEditing) {
      kindSelect.value = 'sextant_hs';
      editingHorizon = null;
      setHorizonOptions(overrideSelect, [inheritOption, ...horizonOptions(null)]);
      overrideSelect.value = 'inherit';
    }
    overrideShore.refresh(true);
    if (everything) timeInput.value = '';
    hsField.setHelp('Degrees, a space, then minutes: 45 54.0 means 45° 54.0′.');
    showErrors(new Map());
    updateTimeHelp();
    syncBodyUi();
    preview.run();
  }

  function loadIntoForm(obs: Observation): void {
    editing = obs.id;
    plannedHint = null;
    formTitle.textContent = `Edit sight ${obs.id}`;
    submit.querySelector('.sf-btn__label')!.textContent = 'Save changes';
    cancel.hidden = false;
    const known = nc.bodies.find((b) => b.body.toLowerCase() === obs.body.trim().toLowerCase());
    bodySelect.value = known ? known.body : OTHER;
    otherBody.value = known ? '' : obs.body;
    timeInput.value = utcInputText(obs.utc);
    originals.clear();
    remember(hsInput, angleInputText(obs.altitude_deg, 2), obs.altitude_deg);
    remember(sigmaInput, String(obs.sigma_arcmin), obs.sigma_arcmin);
    limbSeg.set(obs.limb);
    kindSelect.value = obs.altitude_kind;
    editingHorizon = obs.horizon;
    setHorizonOptions(overrideSelect, [inheritOption, ...horizonOptions(obs.horizon)]);
    overrideSelect.value = obs.horizon ? horizonName(obs.horizon) : 'inherit';
    overrideShore.refresh(true);
    supplied.input.checked = obs.geocentric !== null;
    suppliedBox.hidden = obs.geocentric === null;
    for (const i of [ghaInput, decInput, sdInput, hpInput]) i.value = '';
    if (obs.geocentric) {
      remember(ghaInput, angleInputText(obs.geocentric.gha_deg, 2), obs.geocentric.gha_deg);
      remember(decInput, angleInputText(obs.geocentric.dec_deg, 2), obs.geocentric.dec_deg);
      remember(sdInput, String(obs.geocentric.semidiameter_arcmin), obs.geocentric.semidiameter_arcmin);
      remember(hpInput, String(obs.geocentric.horizontal_parallax_arcmin), obs.geocentric.horizontal_parallax_arcmin);
    }
    notesInput.value = obs.notes;
    idInput.value = obs.id;
    if (obs.geocentric || obs.altitude_kind !== 'sextant_hs' || obs.horizon) (advanced as HTMLDetailsElement).open = true;
    showErrors(new Map());
    updateTimeHelp();
    syncBodyUi();
    preview.run();
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    bodySelect.focus({ preventScroll: true });
  }

  function enterPlanned(p: PlannedSight): void {
    resetForm();
    plannedHint = p;
    const known = nc.bodies.find((b) => b.body === p.body);
    bodySelect.value = known ? known.body : OTHER;
    otherBody.value = known ? '' : p.body;
    limbSeg.set(p.limb);
    timeInput.value = utcInputText(p.utc.replace(/\.\d+Z$/, 'Z'));
    formTitle.textContent = `Add your sight of ${p.kind === 'sun' || p.kind === 'moon' ? 'the ' : ''}${p.body}`;
    hsField.setHelp(`Predicted about ${fmtAngle(p.hs_deg, 'dm')} at ${utcInputText(p.utc.replace(/\.\d+Z$/, 'Z'))} UTC, bearing ${fmtBearing(p.zn_deg)}. Type what YOUR sextant reads; the time too.`);
    updateTimeHelp();
    syncBodyUi();
    preview.run();
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    hsInput.focus({ preventScroll: true });
  }

  // Live workings of the sight being entered.
  let previewSeq = 0;
  const preview = debounce(() => {
    const my = ++previewSeq;
    const read = readForm(true);
    if ('errors' in read) {
      previewBox.replaceChildren(para('Fill in the body, the time and the reading to see the corrections worked out here, step by step.', 'sfn-note sfn-muted'));
      return;
    }
    const session = { ...store.get().session, observations: [{ ...read.obs, id: read.obs.id || 'draft' }] };
    void nc.api
      .reduce(session, store.get().mode)
      .then((entries) => {
        if (my !== previewSeq) return;
        const e = entries[0];
        if (!e) return;
        if (e.status === 'error') {
          previewBox.replaceChildren(notice('error', h('strong', {}, 'The core cannot reduce this sight: '), e.message));
          return;
        }
        previewBox.replaceChildren(sightWorkings(e.sight, fmt()));
      })
      .catch((error: unknown) => {
        if (my === previewSeq) previewBox.replaceChildren(notice('error', errorText(error)));
      });
  }, 150);
  d.add(() => preview.cancel());

  for (const el of [timeInput, hsInput, sigmaInput, otherBody, ghaInput, decInput, sdInput, hpInput]) {
    el.addEventListener('input', () => preview.run());
  }
  timeInput.addEventListener('input', updateTimeHelp);
  timeInput.addEventListener('change', () => {
    const r = parseUtcInput(timeInput.value);
    timeField.setError(r.ok || !timeInput.value.trim() ? null : r.error);
  });
  hsInput.addEventListener('change', () => {
    if (!hsInput.value.trim()) return hsField.setError(null);
    const r = parseAngle(hsInput.value, { ...hsRule(), what: 'The reading' });
    hsField.setError(r.ok ? null : r.error);
  });
  overrideSelect.addEventListener('change', () => {
    if (overrideSelect.value === 'shore' && !isShoreHorizon(editingHorizon)) editingHorizon = { shore: { distance_nm: DEFAULT_SHORE_NM } };
    overrideShore.refresh(true);
  });
  for (const el of [bodySelect, kindSelect, overrideSelect]) {
    el.addEventListener('change', () => {
      syncBodyUi();
      preview.run();
      starId.run();
    });
  }
  for (const el of [timeInput, hsInput]) el.addEventListener('input', () => starId.run());
  otherBody.addEventListener('input', syncBodyUi);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const read = readForm(false);
    if ('errors' in read) {
      showErrors(read.errors);
      const first = allFields.find((f) => read.errors.has(f));
      first?.el.querySelector<HTMLElement>('input, select')?.focus();
      return;
    }
    showErrors(new Map());
    const w = store.get();
    const replacing = editing;
    store.batch(() => {
      store.patch({ session: withObservation(w.session, read.obs, replacing) });
      if (replacing && replacing !== read.obs.id) {
        store.patch({ excluded: w.excluded.map((x) => (x === replacing ? read.obs.id : x)) });
      }
      if (plannedHint) {
        const hint = plannedHint;
        store.patch({ planned: store.get().planned.filter((p) => p !== hint) });
      }
    });
    status.textContent = replacing ? `Saved ${read.obs.id} (${read.obs.body}).` : `Added ${read.obs.id} (${read.obs.body}).`;
    resetForm();
    timeInput.focus();
  });

  // Session-level instrument fields, kept in step with the session card.
  const commitNumber = (input: HTMLInputElement, f: FieldParts, what: string, min: number | undefined, apply: (v: number) => void) => {
    input.addEventListener('change', () => {
      const r = parseNumber(input.value, { what, min });
      f.setError(r.ok ? null : r.error);
      if (r.ok) apply(r.value);
    });
  };
  commitNumber(icInput, icField, 'The index correction', undefined, (v) =>
    store.patch({ session: patchSession(store.get().session, { instrument: { index_correction_arcmin: v } }) }),
  );
  commitNumber(hoeInput, hoeField, 'The height of eye', 0, (v) =>
    store.patch({ session: patchSession(store.get().session, { observer: { height_of_eye_m: v } }) }),
  );
  horizonSelect.addEventListener('change', () => {
    const chosen = horizonFromSelect(horizonSelect.value, store.get().session.instrument.horizon);
    if (chosen) store.patch({ session: patchSession(store.get().session, { instrument: { horizon: chosen } }) });
  });
  const syncInstrument = (): void => {
    const s = store.get().session;
    if (document.activeElement !== icInput) icInput.value = String(s.instrument.index_correction_arcmin);
    if (document.activeElement !== hoeInput) hoeInput.value = String(s.observer.height_of_eye_m);
    const options = horizonOptions(s.instrument.horizon);
    if (options.length !== horizonSelect.options.length) setHorizonOptions(horizonSelect, options);
    horizonSelect.value = horizonName(s.instrument.horizon);
    horizonField.setHelp(horizonText(s.instrument.horizon).explain);
    instrumentShore.refresh();
    overrideShore.refresh();
    const supplied = store.get().mode === 'supplied';
    modeLine.hidden = !supplied;
    modeLine.textContent = supplied
      ? 'Body directions: only the GHA and declination typed into each sight (ephemeris “supplied”). A sight without them cannot be reduced; switch to the built-in almanac in the session settings.'
      : '';
  };

  // --- The list ---------------------------------------------------------------------------------
  const open = new Set<string>();

  function renderPlanned(items: readonly PlannedSight[]): void {
    planned.replaceChildren();
    planned.hidden = items.length === 0;
    if (!items.length) return;
    const z = zone(nc);
    planned.append(
      h('h3', { class: 'sfn-planned__title' }, 'To shoot ', h('span', { class: 'sfn-muted' }, `· ${items.length} from the planner (predictions, not sights)`)),
      h(
        'ul',
        { class: 'sfn-planned__list' },
        ...items.map((p) => {
          const jd = jdFromIso(p.utc) ?? jdFromIso(p.utc.replace(/\.\d+Z$/, 'Z'));
          return h(
            'li',
            { class: 'sfn-planned__item' },
            bodyGlyph(p.body, { kind: p.kind, size: 18 }),
            h(
              'span',
              { class: 'sfn-planned__text' },
              h('strong', {}, p.body),
              p.kind === 'moon' || p.kind === 'sun' ? ` (${LIMB_TEXT[p.limb].toLowerCase()})` : '',
              h('span', { class: 'sfn-muted' }, ` · expect Hs ≈ ${fmtAngle(p.hs_deg, fmt())}, bearing ${fmtBearing(p.zn_deg)}${jd ? ` at ${fmtZoneClock(jd, z)}` : ''}`),
            ),
            btn('Enter reading', () => enterPlanned(p), { variant: 'outline', tip: `Open the form for ${p.body}` }),
            btn('', () => store.patch({ planned: store.get().planned.filter((x) => x !== p) }), {
              icon: 'close',
              variant: 'ghost',
              ariaLabel: `Remove ${p.body} from the bodies to shoot`,
            }),
          );
        }),
      ),
    );
  }

  /** Runs of this many consecutive sights of one body fold into a group. */
  const RUN_MIN = 6;
  const openRuns = new Set<string>();

  function warningTags(ws: readonly Warning[]): (HTMLElement | null)[] {
    const unique = [...new Map(ws.map((x) => [JSON.stringify(x), x])).values()];
    const cautions = unique.filter((x) => WARNING_SEVERITY[x.code] === 'caution').length;
    const notes = unique.length - cautions;
    return [
      cautions ? h('span', { class: 'sfn-tag sfn-tag--caution' }, icon('caution'), ` ${cautions} caution${cautions === 1 ? '' : 's'}`) : null,
      notes ? h('span', { class: 'sfn-tag' }, `${notes} note${notes === 1 ? '' : 's'}`) : null,
    ];
  }

  function sightItem(o: Observation): HTMLElement {
    const w = store.get();
    const red = nc.reductions.get();
    const entry: ReduceEntry | undefined = red.session === w.session ? red.byId.get(o.id) : undefined;
    const kind = kindOf(nc, o.body);
    const jd = jdFromIso(o.utc);
    const z = zone(nc);
    const f = fmt();
    const used = !w.excluded.includes(o.id);
    const useBox = h('input', { type: 'checkbox', checked: used, 'aria-label': `Use ${o.id} (${o.body}) in the fix` });
    useBox.addEventListener('change', () => {
      const ex = store.get().excluded.filter((x) => x !== o.id);
      store.patch({ excluded: useBox.checked ? ex : [...ex, o.id] });
    });
    const reading = h(
      'span',
      { class: 'sfn-sight__reading' },
      h('span', { class: 'sfn-term' }, KIND_TEXT[o.altitude_kind].term, ' '),
      h('span', { class: 'sfn-num' }, fmtAngle(o.altitude_deg, f)),
      hasDisc(kind) ? h('span', { class: 'sfn-muted' }, ` ${LIMB_TEXT[o.limb].toLowerCase()}`) : null,
      o.geocentric ? h('span', { class: 'sfn-tag' }, 'own GHA/Dec') : null,
    );
    let outcome: HTMLElement;
    if (!entry) outcome = h('span', { class: 'sfn-muted' }, red.pending ? 'working it out…' : '—');
    else if (entry.status === 'error') outcome = h('span', { class: 'sfn-sight__rejected' }, icon('caution'), ` Not usable: ${entry.message}`);
    else {
      const r = entry.sight;
      outcome = h(
        'span',
        { class: 'sfn-sight__outcome' },
        '→ ',
        h('span', { class: 'sfn-term' }, 'Ho '),
        h('strong', { class: 'sfn-num' }, fmtAngle(r.ho_deg, f)),
        h('span', { class: 'sfn-muted' }, ` ${fmtSigma(r.sigma_arcmin, 1)}`),
        r.intercept_nm !== null && r.zn_deg !== null
          ? h('span', { class: 'sfn-sight__intercept' }, ` · ${fmtBearing(r.zn_deg)}, ${fmtNm(Math.abs(r.intercept_nm), 1)} ${r.intercept_nm >= 0 ? 'toward' : 'away'}`)
          : null,
        ...warningTags([...r.warnings, ...r.corrections.warnings]),
      );
    }
    const expanded = open.has(o.id);
    const detailsId = `sfn-w-${o.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const toggle = btn(expanded ? 'Hide workings' : 'Workings', () => {
      if (open.has(o.id)) open.delete(o.id);
      else open.add(o.id);
      renderList();
      (list.querySelector(`[data-toggle="${CSS.escape(o.id)}"]`) as HTMLElement | null)?.focus();
    }, { variant: 'ghost', iconAfter: expanded ? 'chevron-up' : 'chevron-down', attrs: { 'aria-expanded': String(expanded), 'aria-controls': detailsId, 'data-toggle': o.id } });
    const edit = btn('Edit', () => loadIntoForm(o), { variant: 'ghost', icon: 'edit', attrs: { 'aria-label': `Edit ${o.id} (${o.body})` } });
    const del = btn('', () => removeSight(o), { variant: 'ghost', icon: 'close', ariaLabel: `Delete ${o.id} (${o.body})` });
    return h(
      'li',
      { class: `sfn-sight${used ? '' : ' sfn-sight--unused'}${editing === o.id ? ' sfn-sight--editing' : ''}` },
      h(
        'div',
        { class: 'sfn-sight__row' },
        h('label', { class: 'sfn-sight__use', title: 'Use in the fix' }, useBox),
        h('span', { class: 'sfn-sight__glyph' }, bodyGlyph(o.body, { kind, size: 18 })),
        h(
          'span',
          { class: 'sfn-sight__body' },
          h('strong', {}, o.body || '(no body)'),
          h('span', { class: 'sfn-sight__id' }, o.id),
          jd
            ? h('span', { class: 'sfn-sight__time' }, h('span', { class: 'sfn-num' }, `${utcInputText(o.utc).slice(11)} UTC`), h('span', { class: 'sfn-muted' }, ` ${fmtZoneClock(jd, z)}`))
            : h('span', { class: 'sfn-sight__rejected' }, o.utc || 'no time'),
        ),
        h('span', { class: 'sfn-sight__actions' }, toggle, edit, del),
      ),
      h('div', { class: 'sfn-sight__line' }, reading, ' ', outcome),
      expanded
        ? h(
            'div',
            { class: 'sfn-sight__details', id: detailsId },
            entry?.status === 'ok' ? sightWorkings(entry.sight, f) : entry?.status === 'error' ? notice('error', entry.message) : para('Working it out…'),
            // navigate2: the worksheet of this sight, print-clean (print/worksheet.ts).
            entry?.status === 'ok'
              ? h('div', { class: 'sfn-export' }, btn('Print the worksheet', () => openSightWorksheet(nc, o, entry.sight), { variant: 'outline', icon: 'list', tip: 'This sight in the six classic steps, with a column for your own figures' }))
              : null,
          )
        : null,
    );
  }

  function runItem(run: Observation[]): HTMLElement {
    const key = run[0]!.id;
    const openRun = openRuns.has(key) || run.some((o) => o.id === editing);
    const f = fmt();
    const w = store.get();
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const used = run.filter((o) => !w.excluded.includes(o.id)).length;
    const hs = run.map((o) => o.altitude_deg);
    const kind = kindOf(nc, first.body);
    const groupId = `sfn-run-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const toggle = btn(openRun ? 'Fold the run' : `Show the ${run.length} sights`, () => {
      if (openRuns.has(key)) openRuns.delete(key);
      else openRuns.add(key);
      renderList();
      (list.querySelector(`[data-run="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus();
    }, { variant: 'ghost', iconAfter: openRun ? 'chevron-up' : 'chevron-down', attrs: { 'aria-expanded': String(openRun), 'aria-controls': groupId, 'data-run': key } });
    const useAll = h('input', { type: 'checkbox', checked: used === run.length, 'aria-label': `Use all ${run.length} ${first.body} sights in the fix` });
    useAll.indeterminate = used > 0 && used < run.length;
    useAll.addEventListener('change', () => {
      const ids = new Set(run.map((o) => o.id));
      const rest = store.get().excluded.filter((x) => !ids.has(x));
      store.patch({ excluded: useAll.checked ? rest : [...rest, ...ids] });
    });
    return h(
      'li',
      { class: 'sfn-run' },
      h(
        'div',
        { class: 'sfn-sight__row' },
        h('label', { class: 'sfn-sight__use', title: 'Use the whole run in the fix' }, useAll),
        h('span', { class: 'sfn-sight__glyph' }, bodyGlyph(first.body, { kind, size: 18 })),
        h(
          'span',
          { class: 'sfn-sight__body' },
          h('strong', {}, `${first.body} · a run of ${run.length}`),
          h('span', { class: 'sfn-sight__time sfn-num' }, `${utcInputText(first.utc).slice(11)}–${utcInputText(last.utc).slice(11)} UTC`),
        ),
        h('span', { class: 'sfn-sight__actions' }, toggle),
      ),
      h(
        'div',
        { class: 'sfn-sight__line' },
        h('span', { class: 'sfn-term' }, `${KIND_TEXT[first.altitude_kind].term} `),
        h('span', { class: 'sfn-num' }, `${fmtAngle(Math.min(...hs), f)} to ${fmtAngle(Math.max(...hs), f)}`),
        h('span', { class: 'sfn-muted' }, ` · ${used} of ${run.length} used in the fix`),
      ),
      openRun ? h('ol', { class: 'sfn-sight-list sfn-run__list', id: groupId }, ...run.map(sightItem)) : null,
    );
  }

  function renderList(): void {
    const w = store.get();
    const sights = sortedByTime(w.session.observations);
    count.textContent = ` ${sights.length}`;
    empty.hidden = sights.length > 0;
    const z = zone(nc);
    const items: HTMLElement[] = [];
    let lastDate = '';
    for (let i = 0; i < sights.length; ) {
      const o = sights[i]!;
      let j = i + 1;
      while (j < sights.length && sights[j]!.body.trim().toLowerCase() === o.body.trim().toLowerCase()) j += 1;
      const jd = jdFromIso(o.utc);
      const date = jd !== null ? formatDate(jd, z) : '';
      if (date && date !== lastDate) {
        items.push(h('li', { class: 'sfn-sight-date', 'aria-hidden': 'true' }, `${date} (${z.kind === 'iana' ? zoneShortName(jd!, z) : z.name})`));
        lastDate = date;
      }
      if (j - i >= RUN_MIN) {
        items.push(runItem(sights.slice(i, j)));
        i = j;
      } else {
        items.push(sightItem(o));
        i += 1;
      }
    }
    list.replaceChildren(...items);
  }

  function removeSight(o: Observation): void {
    const before = store.get();
    store.patch({ session: withoutObservation(before.session, o.id), excluded: before.excluded.filter((x) => x !== o.id) });
    if (editing === o.id) resetForm();
    const undo = btn('Undo', () => {
      store.patch({ session: withObservation(store.get().session, o), excluded: before.excluded });
      status.textContent = `Restored ${o.id}.`;
    }, { variant: 'outline' });
    status.replaceChildren(`Deleted ${o.id} (${o.body}). `, undo);
    undo.focus();
  }

  // --- Wiring -----------------------------------------------------------------------------------
  d.add(store.select((w) => w.session.observations, renderList));
  d.add(store.select((w) => w.excluded, renderList));
  d.add(nc.reductions.select((r) => r, renderList));
  d.add(store.select((w) => w.planned, renderPlanned));
  d.add(store.select((w) => [w.session.instrument, w.session.observer, w.mode] as const, syncInstrument, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }));
  d.add(store.select((w) => w.session, () => preview.run()));
  d.add(nc.ctx.store.select((s) => [s.settings.angleFormat, s.settings.timeDisplay, s.observer.zone] as const, () => {
    renderList();
    renderPlanned(store.get().planned);
    updateTimeHelp();
  }, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }));

  syncInstrument();
  renderPlanned(store.get().planned);
  renderList();
  resetForm(true);
  cancel.hidden = true;
  bodySelect.addEventListener('change', syncBodyUi);
  // A new session starts on the Sun with its lower limb, the commonest sight.
  if (nc.bodies.some((b) => b.body === 'Sun')) bodySelect.value = 'Sun';
  syncBodyUi();
  updateTimeHelp();

  return {
    destroy: () => d.dispose(),
    enterPlanned,
  };
}

/** For the method panels: pre-fill sights for planned bodies (no readings). */
export function plannedFromPrediction(
  p: { body: string; kind: SightBodyInfo['kind']; limb: SightLimb; hs_deg: number; hc_deg: number; zn_deg: number },
  utc: string,
  from: string,
): PlannedSight {
  return { body: p.body, kind: p.kind, limb: p.limb, utc, hs_deg: p.hs_deg, hc_deg: p.hc_deg, zn_deg: p.zn_deg, from };
}

export { warningList };
