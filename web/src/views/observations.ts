/**
 * Observations view: the editable sight table and the session panel.
 *
 * Nothing that affects the answer is hidden. The assumed-position role selector spells
 * out its own consequence, the index-correction sign convention is on the label, and
 * each horizon mode carries a one-line explanation.
 */

import {
  button,
  checkbox,
  clear,
  field,
  h,
  numberInput,
  select,
  textInput,
} from '../dom.js';
import { degMin } from '../format.js';
import { fromCsv, toCsv } from '../csv.js';
import { emptySession } from '../api/mock.js';
import type { Store } from '../store.js';
import type {
  AltitudeKind,
  HorizonMode,
  Limb,
  Observation,
  SessionKind,
} from '../types.js';
import { SESSION_SCHEMA } from '../types.js';
import { note, panel, pickFile, downloadText, subPanel, toolbar, warningList } from './common.js';

const ALTITUDE_KIND_OPTIONS: { value: AltitudeKind; label: string }[] = [
  { value: 'sextant_hs', label: 'Sextant reading Hs (raw)' },
  { value: 'apparent_ha', label: 'Apparent Ha (index, dip, halving done)' },
  { value: 'observed_ho', label: 'Observed Ho (fully corrected)' },
];

const LIMB_OPTIONS: { value: Limb; label: string }[] = [
  { value: 'center', label: 'Centre' },
  { value: 'lower', label: 'Lower limb' },
  { value: 'upper', label: 'Upper limb' },
];

const HORIZON_OPTIONS: { value: HorizonMode; label: string }[] = [
  { value: 'sea', label: 'Natural sea horizon' },
  { value: 'artificial_reflected', label: 'Reflected artificial horizon' },
  { value: 'electronic_vertical', label: 'Electronic local vertical' },
];

export const HORIZON_EXPLANATION: Record<HorizonMode, string> = {
  sea: 'Dip applies: the visible horizon is below true level by 1.76′ × √(height of eye in metres).',
  artificial_reflected:
    'The reading is the double angle. It is halved after the index correction, and no dip applies.',
  electronic_vertical:
    'An inclinometer or camera attitude supplies level directly. No dip; the index correction is the instrument zero offset.',
};

const ROLE_OPTIONS = [
  { value: 'initializer' as const, label: 'Initializer only (does not influence the answer)' },
  { value: 'prior' as const, label: 'Prior (influences the answer; reported)' },
  { value: 'disabled' as const, label: 'Disabled' },
];

function observationRow(store: Store, obs: Observation, onStructuralChange: () => void): HTMLElement {
  const tr = h('tr', {});
  const cell = (control: HTMLElement, label: string): HTMLElement => {
    const td = h('td', { 'data-label': label });
    td.appendChild(control);
    return td;
  };

  tr.appendChild(
    cell(
      textInput(obs.id, (v) => store.editSession(() => { obs.id = v; }, { quiet: true })),
      'id',
    ),
  );
  tr.appendChild(
    cell(
      textInput(obs.body, (v) => store.editSession(() => { obs.body = v; }, { quiet: true }), {
        list: 'body-catalog',
        placeholder: 'Vega',
      }),
      'body',
    ),
  );
  tr.appendChild(
    cell(
      textInput(obs.utc, (v) => store.editSession(() => { obs.utc = v; }, { quiet: true }), {
        placeholder: '2026-10-01T01:30:00Z',
      }),
      'UTC',
    ),
  );
  const altitude = numberInput(
    obs.altitude_deg,
    (v) => {
      store.editSession(() => { obs.altitude_deg = v; }, { quiet: true });
      readout.textContent = degMin(v, 1);
    },
    { step: '0.0001', min: '-90', max: '90' },
  );
  const readout = h('span', { class: 'readout' }, degMin(obs.altitude_deg, 1));
  const altitudeCell = h('td', { 'data-label': 'altitude, degrees' }, altitude, readout);
  tr.appendChild(altitudeCell);
  tr.appendChild(
    cell(
      select(obs.altitude_kind, ALTITUDE_KIND_OPTIONS, (v) =>
        store.editSession(() => { obs.altitude_kind = v; }),
      ),
      'altitude kind',
    ),
  );
  tr.appendChild(
    cell(
      numberInput(obs.sigma_arcmin, (v) => store.editSession(() => { obs.sigma_arcmin = v; }, { quiet: true }), {
        step: '0.1',
        min: '0.01',
      }),
      'sigma, arcmin',
    ),
  );
  tr.appendChild(
    cell(
      select(obs.limb, LIMB_OPTIONS, (v) => store.editSession(() => { obs.limb = v; })),
      'limb',
    ),
  );
  tr.appendChild(
    cell(
      select(
        obs.horizon ?? 'inherit',
        [{ value: 'inherit' as const, label: 'Use instrument setting' }, ...HORIZON_OPTIONS],
        (v) =>
          store.editSession(() => {
            obs.horizon = v === 'inherit' ? null : (v as HorizonMode);
          }),
      ),
      'horizon override',
    ),
  );
  tr.appendChild(
    cell(
      numberInput(
        obs.geocentric?.gha_deg ?? 0,
        (v) =>
          store.editSession(() => {
            obs.geocentric = {
              gha_deg: v,
              dec_deg: obs.geocentric?.dec_deg ?? 0,
              semidiameter_arcmin: obs.geocentric?.semidiameter_arcmin ?? 0,
              horizontal_parallax_arcmin: obs.geocentric?.horizontal_parallax_arcmin ?? 0,
            };
          }, { quiet: true }),
        { step: '0.0001' },
      ),
      'GHA, degrees (west +)',
    ),
  );
  tr.appendChild(
    cell(
      numberInput(
        obs.geocentric?.dec_deg ?? 0,
        (v) =>
          store.editSession(() => {
            obs.geocentric = {
              gha_deg: obs.geocentric?.gha_deg ?? 0,
              dec_deg: v,
              semidiameter_arcmin: obs.geocentric?.semidiameter_arcmin ?? 0,
              horizontal_parallax_arcmin: obs.geocentric?.horizontal_parallax_arcmin ?? 0,
            };
          }, { quiet: true }),
        { step: '0.0001', min: '-90', max: '90' },
      ),
      'Dec, degrees (north +)',
    ),
  );
  tr.appendChild(
    h(
      'td',
      { 'data-label': '' },
      button('Remove', () => {
        store.editSession((session) => {
          session.observations = session.observations.filter((o) => o !== obs);
        });
        onStructuralChange();
      }, { class: 'danger', title: `Remove sight ${obs.id}` }),
    ),
  );
  return tr;
}

export function renderObservations(store: Store, root: HTMLElement): void {
  clear(root);
  const session = store.state.session;

  // --- demos ---------------------------------------------------------------
  const demos = store.state.demos;
  const demoSelect = h('select', { id: 'demo-select' }) as HTMLSelectElement;
  if (demos.length === 0) {
    demoSelect.appendChild(h('option', { value: '' }, 'Loading the packaged demos…'));
    demoSelect.disabled = true;
  } else {
    demoSelect.appendChild(h('option', { value: '' }, 'Choose a packaged demo…'));
    for (const demo of demos) {
      demoSelect.appendChild(
        h(
          'option',
          { value: demo.name },
          demo.requires_provider ? `${demo.name} (needs the star catalogue)` : demo.name,
        ),
      );
    }
  }
  const demoBlurb = h(
    'p',
    { class: 'note' },
    'Each demo is a simulated session generated by the core. Its truth is shown only on the Simulator view.',
  );
  demoSelect.value = store.state.loadedDemo ?? '';
  const describe = (): void => {
    const demo = demos.find((d) => d.name === demoSelect.value);
    demoBlurb.textContent =
      demo?.description ??
      'Each demo is a simulated session generated by the core. Its truth is shown only on the Simulator view.';
  };
  demoSelect.addEventListener('change', describe);
  describe();

  const loadDemo = button('Load demo', () => {
    const demo = demos.find((d) => d.name === demoSelect.value);
    if (!demo) {
      store.notice('caution', 'Choose a demo from the menu first.');
      return;
    }
    void loadScenario(store, demo.name).then(() => renderObservations(store, root));
  });

  // --- table ---------------------------------------------------------------
  const table = h('table', { class: 'sights' });
  const head = h(
    'tr',
    {},
    ...[
      'id',
      'body',
      'UTC',
      'altitude, degrees',
      'altitude kind',
      'sigma, arcmin',
      'limb',
      'horizon override',
      'GHA, degrees (west +)',
      'Dec, degrees (north +)',
      '',
    ].map((t) => h('th', {}, t)),
  );
  table.appendChild(h('thead', {}, head));
  const tbody = h('tbody', {});
  const rerender = () => renderObservations(store, root);
  for (const obs of session.observations) tbody.appendChild(observationRow(store, obs, rerender));
  table.appendChild(tbody);

  const datalist = h('datalist', { id: 'body-catalog' });
  for (const name of store.state.bodyCatalog) datalist.appendChild(h('option', { value: name }));

  const addSight = button('Add sight', () => {
    store.editSession((s) => {
      const n = s.observations.length + 1;
      s.observations.push({
        id: `obs-${n}`,
        body: '',
        utc: s.observations[s.observations.length - 1]?.utc ?? '',
        altitude_deg: 0,
        altitude_kind: 'sextant_hs',
        sigma_arcmin: 1,
        limb: 'center',
        horizon: null,
        geocentric: null,
        notes: '',
      });
    });
    rerender();
  });

  // --- import / export -----------------------------------------------------
  const io = toolbar(
    button('Export JSON', () =>
      downloadText(
        `${session.meta.name || 'session'}.json`,
        JSON.stringify(session, null, 2),
        'application/json',
      ),
    ),
    button('Import JSON', () =>
      pickFile('.json,application/json', (name, text) => {
        void store.api
          .parseSession(text)
          .then((parsed) => {
            store.replaceSession(parsed.session);
            store.notice('info', `Loaded ${name}.`);
            if (parsed.warnings.length > 0) {
              store.notice('caution', `${parsed.warnings.length} warning(s) — see below.`);
            }
            store.set({ reduced: null });
            rerender();
          })
          .catch((error: unknown) => {
            store.notice('error', `Could not load ${name}: ${String(error)}`);
          });
      }),
    ),
    button('Export CSV', () =>
      downloadText(`${session.meta.name || 'session'}.csv`, toCsv(session), 'text/csv'),
    ),
    button('Import CSV', () =>
      pickFile('.csv,text/csv', (name, text) => {
        const result = fromCsv(text, emptySession());
        store.replaceSession(result.session);
        store.notice(
          'info',
          `Loaded ${name} with the browser's convenience CSV reader. The core owns the canonical parser; re-import through it before trusting the file.`,
        );
        for (const message of result.messages) store.notice('caution', message);
        rerender();
      }),
    ),
    button('Clear session', () => {
      store.replaceSession(emptySession('New session'));
      rerender();
    }, { class: 'danger' }),
  );

  // --- session panel -------------------------------------------------------
  const role = session.observer.assumed_position_role;
  const assumed = session.observer.assumed_position ?? { lat_deg: 0, lon_deg: 0 };

  const observerPanel = subPanel(
    'Observer',
    field(
      'Height of eye, metres',
      numberInput(session.observer.height_of_eye_m, (v) =>
        store.editSession((s) => { s.observer.height_of_eye_m = v; }, { quiet: true }), { step: '0.1', min: '0' }),
      'Enters the dip of the sea horizon only.',
    ),
    field(
      'Pressure, hPa',
      numberInput(session.observer.pressure_hpa, (v) =>
        store.editSession((s) => { s.observer.pressure_hpa = v; }, { quiet: true }), { step: '1' }),
      'Scales refraction. Standard is 1010 hPa.',
    ),
    field(
      'Temperature, °C',
      numberInput(session.observer.temperature_c, (v) =>
        store.editSession((s) => { s.observer.temperature_c = v; }, { quiet: true }), { step: '1' }),
      'Scales refraction. Standard is 10 °C.',
    ),
    field(
      'Assumed position latitude, degrees (north +)',
      numberInput(assumed.lat_deg, (v) =>
        store.editSession((s) => {
          s.observer.assumed_position = { lat_deg: v, lon_deg: s.observer.assumed_position?.lon_deg ?? 0 };
        }, { quiet: true }), { step: '0.0001', min: '-90', max: '90' }),
    ),
    field(
      'Assumed position longitude, degrees (east +)',
      numberInput(assumed.lon_deg, (v) =>
        store.editSession((s) => {
          s.observer.assumed_position = { lat_deg: s.observer.assumed_position?.lat_deg ?? 0, lon_deg: v };
        }, { quiet: true }), { step: '0.0001', min: '-180', max: '180' }),
      'West longitudes are negative everywhere in this project.',
    ),
    field(
      'What the assumed position is allowed to do',
      select(role.role, ROLE_OPTIONS, (v) => {
        store.editSession((s) => {
          s.observer.assumed_position_role =
            v === 'prior'
              ? { role: 'prior', sigma_nm: role.role === 'prior' ? role.sigma_nm : 20 }
              : v === 'disabled'
                ? { role: 'disabled' }
                : { role: 'initializer' };
        });
        rerender();
      }),
    ),
    role.role === 'prior'
      ? field(
          'Prior 1-sigma radius, nautical miles',
          numberInput(role.sigma_nm, (v) =>
            store.editSession((s) => { s.observer.assumed_position_role = { role: 'prior', sigma_nm: v }; }, { quiet: true }), { step: '1', min: '0.1' }),
          'A prior changes the answer. The fix is reported with and without it.',
        )
      : null,
  );

  const instrumentPanel = subPanel(
    'Instrument',
    field(
      'Name',
      textInput(session.instrument.name, (v) =>
        store.editSession((s) => { s.instrument.name = v; }, { quiet: true })),
    ),
    field(
      'Index correction, arcminutes (added to the reading; on the arc = negative)',
      numberInput(session.instrument.index_correction_arcmin, (v) =>
        store.editSession((s) => { s.instrument.index_correction_arcmin = v; }, { quiet: true }), { step: '0.1' }),
      'Index error of 2.0′ on the arc means an index correction of −2.0′.',
    ),
    field(
      'Horizon mode',
      select(session.instrument.horizon, HORIZON_OPTIONS, (v) => {
        store.editSession((s) => { s.instrument.horizon = v; });
        rerender();
      }),
      HORIZON_EXPLANATION[session.instrument.horizon],
    ),
    h(
      'ul',
      { class: 'explain' },
      ...HORIZON_OPTIONS.map((o) =>
        h('li', {}, h('strong', {}, `${o.label}: `), HORIZON_EXPLANATION[o.value]),
      ),
    ),
  );

  const clockPanel = subPanel(
    'Clock',
    field(
      'Time uncertainty, seconds (1 sigma)',
      numberInput(session.clock.uncertainty_s, (v) =>
        store.editSession((s) => { s.clock.uncertainty_s = v; }, { quiet: true }), { step: '0.1', min: '0' }),
      'Propagated into an east-west term of the position uncertainty. It is never estimated: for star sights clock error and longitude are the same unknown.',
    ),
    field(
      'Known chronometer correction, seconds (added to every recorded time)',
      numberInput(session.clock.correction_s, (v) =>
        store.editSession((s) => { s.clock.correction_s = v; }, { quiet: true }), { step: '0.1' }),
    ),
  );

  const metaPanel = subPanel(
    'Session',
    field(
      'Name',
      textInput(session.meta.name, (v) => store.editSession((s) => { s.meta.name = v; }, { quiet: true })),
    ),
    field(
      'Kind',
      select(
        session.meta.kind,
        [
          { value: 'simulated' as SessionKind, label: 'SIMULATED — generated, not measured' },
          { value: 'real' as SessionKind, label: 'REAL — measured with an instrument' },
        ],
        (v) => {
          store.editSession((s) => { s.meta.kind = v; });
          rerender();
        },
      ),
      'Shown in the header banner on every view.',
    ),
    field(
      'Notes',
      (() => {
        const area = h('textarea', { rows: 3 }) as HTMLTextAreaElement;
        area.value = session.meta.notes;
        area.addEventListener('change', () =>
          store.editSession((s) => { s.meta.notes = area.value; }, { quiet: true }),
        );
        return area;
      })(),
    ),
    field(
      'Schema',
      textInput(session.schema, (v) => store.editSession((s) => { s.schema = v; }, { quiet: true })),
      `Expected ${SESSION_SCHEMA}.`,
    ),
  );

  const ephemerisMode = checkbox(
    store.state.solveOptions.posterior_scaling,
    'Also report residual-scaled covariance when there are 3 or more degrees of freedom',
    (v) => store.set({ solveOptions: { ...store.state.solveOptions, posterior_scaling: v } }),
  );

  root.appendChild(
    panel(
      'Packaged demos',
      note(
        'The packaged demonstrations from the brief, generated by the simulator in the core. Loading one replaces the session below with a freshly simulated one.',
      ),
      toolbar(demoSelect, loadDemo),
      demoBlurb,
    ),
  );
  root.appendChild(
    panel(
      'Sights',
      note(
        'One row per observation. Supply the apparent geocentric GHA and declination for each body: that is the "first numerical slice" the brief describes, and it isolates the solver from the astronomy provider.',
      ),
      io,
      h('div', { class: 'table-scroll' }, table),
      datalist,
      toolbar(addSight),
    ),
  );
  root.appendChild(panel('Session settings', metaPanel, observerPanel, instrumentPanel, clockPanel, ephemerisMode));

  if (store.state.reduceError) {
    root.appendChild(panel('Problems', h('p', { class: 'error' }, store.state.reduceError)));
  }
  const warnings = (store.state.reduced ?? [])
    .flatMap((e) => (e.status === 'ok' ? [...e.sight.warnings, ...e.sight.corrections.warnings] : []));
  if (warnings.length > 0) {
    root.appendChild(panel('Warnings from the last reduction', warningList(warnings)));
  }
}

/**
 * Run a packaged demo through the API and put the result on the Observations view.
 * The scenario is also loaded into the Simulator, where its truth is visible; nothing
 * about the truth travels with the session.
 */
export async function loadScenario(store: Store, demoName: string): Promise<void> {
  const demo = store.state.demos.find((d) => d.name === demoName);
  if (!demo) return;
  try {
    const output = await store.api.simulate(demo.scenario);
    store.replaceSession(output.session, { demo: demo.name });
    store.set({
      simulation: {
        ...store.state.simulation,
        scenario: structuredClone(demo.scenario),
        session: output.session,
        truth: output.truth,
        fix: null,
        summary: null,
        error: null,
      },
    });
    store.notice('info', `Loaded ${demo.name}.`);
  } catch (error) {
    store.notice('error', `Could not generate ${demo.name}: ${String(error)}`);
  }
}
