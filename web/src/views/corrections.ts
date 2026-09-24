/**
 * Corrections view: what happened to every sight, step by step.
 *
 * A skipped step is still a row. Silence about a correction is how corrections get
 * applied twice; the reason it was skipped is printed where the step would have been.
 */

import { button, clear, h, select } from '../dom.js';
import { arcmin, degBoth, formatUtc } from '../format.js';
import type { Store } from '../store.js';
import type { CorrectionStep, ReducedSight } from '../types.js';
import { CORRECTION_LABEL, CORRECTION_ORDER } from '../types.js';
import { note, panel, toolbar, warningList } from './common.js';

/**
 * The core writes its own reason, usually starting "not applicable:" or "not applied:".
 * The row already carries that as a tag, so the stutter is trimmed rather than printed.
 */
function skippedReason(note: string): string {
  return note.replace(/^not (applicable|applied)\s*:\s*/i, '');
}

function stepRow(step: CorrectionStep): HTMLElement {
  if (!step.applied) {
    return h(
      'tr',
      { class: 'step-skipped' },
      h('th', { scope: 'row' }, CORRECTION_LABEL[step.kind]),
      h(
        'td',
        { colspan: '3' } as never,
        h('span', { class: 'skipped-tag' }, 'not applied'),
        ` ${skippedReason(step.note)}`,
      ),
    );
  }
  return h(
    'tr',
    {},
    h('th', { scope: 'row' }, CORRECTION_LABEL[step.kind]),
    h('td', {}, degBoth(step.before_deg, 4, 2)),
    h('td', {}, degBoth(step.after_deg, 4, 2)),
    h('td', {}, h('strong', {}, arcmin(step.delta_arcmin)), h('span', { class: 'muted' }, ` ${step.note}`)),
  );
}

function sightBlock(sight: ReducedSight): HTMLElement {
  const table = h('table', { class: 'corrections' });
  table.appendChild(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', {}, 'step'),
        h('th', {}, 'before'),
        h('th', {}, 'after'),
        h('th', {}, 'change'),
      ),
    ),
  );
  const body = h('tbody', {});
  const byKind = new Map(sight.corrections.steps.map((s) => [s.kind, s]));
  for (const kind of CORRECTION_ORDER) {
    const step = byKind.get(kind);
    if (step) body.appendChild(stepRow(step));
    else
      body.appendChild(
        h(
          'tr',
          { class: 'step-skipped' },
          h('th', { scope: 'row' }, CORRECTION_LABEL[kind]),
          h('td', { colspan: '3' } as never, h('span', { class: 'skipped-tag' }, 'not reported'), ' the reducer did not record this step'),
        ),
      );
  }
  table.appendChild(body);

  const warnings = [...sight.corrections.warnings, ...sight.warnings];
  return h(
    'section',
    { class: 'sight-block' },
    h(
      'h3',
      {},
      `${sight.id} · ${sight.body}`,
      h('span', { class: 'muted' }, ` · ${formatUtc(sight.utc)}`),
    ),
    h(
      'dl',
      { class: 'facts' },
      h('div', { class: 'kv' }, h('dt', {}, 'Input'), h('dd', {}, `${degBoth(sight.corrections.input_deg, 4, 2)} as ${sight.corrections.input_kind}`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Observed altitude Ho'), h('dd', {}, degBoth(sight.ho_deg, 4, 2))),
      h('div', { class: 'kv' }, h('dt', {}, 'Nominal uncertainty of Ho'), h('dd', {}, `${sight.corrections.sigma_ho_arcmin.toFixed(2)}′ (1 sigma)`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Body direction'), h('dd', {}, `GHA ${sight.gha_deg.toFixed(4)}° west-positive, Dec ${sight.dec_deg.toFixed(4)}° · source: ${sight.direction_source}`)),
      sight.hc_deg !== null
        ? h('div', { class: 'kv' }, h('dt', {}, 'At the assumed position'), h('dd', {}, `Hc ${degBoth(sight.hc_deg, 4, 2)}, Zn ${sight.zn_deg?.toFixed(1)}°, intercept ${sight.intercept_nm?.toFixed(2)} NM ${((sight.intercept_nm ?? 0) >= 0 ? 'toward' : 'away from')} the body`))
        : h('div', { class: 'kv' }, h('dt', {}, 'At the assumed position'), h('dd', { class: 'muted' }, 'no assumed position, so no intercept')),
    ),
    table,
    warnings.length > 0 ? h('div', { class: 'sight-warnings' }, warningList(warnings)) : h('p', { class: 'muted' }, 'No warnings for this sight.'),
  );
}

export function renderCorrections(store: Store, root: HTMLElement): void {
  clear(root);
  const state = store.state;

  const modeSelect = select(
    store.state.ephemerisMode,
    [
      { value: 'supplied' as const, label: 'Supplied directions only' },
      { value: 'auto' as const, label: 'Supplied, else the offline provider' },
    ],
    (v) => store.set({ ephemerisMode: v }),
  );

  const run = button('Reduce all sights', () => {
    void store.api
      .reduce(store.state.session, store.state.ephemerisMode)
      .then((entries) => {
        store.set({ reduced: entries, reduceError: null });
      })
      .catch((error: unknown) => {
        store.set({ reduced: null, reduceError: String(error) });
      });
  }, { class: 'primary' });

  root.appendChild(
    panel(
      'Sight reduction',
      note(
        'Each sight is corrected only from the point its declared altitude kind says it has reached. A step that does not apply is listed with the reason, never omitted.',
      ),
      toolbar(modeSelect, run),
    ),
  );

  if (state.reduceError) {
    root.appendChild(panel('Reduction failed', h('p', { class: 'error' }, state.reduceError)));
    return;
  }
  if (!state.reduced) {
    root.appendChild(
      panel('No reduction yet', h('p', { class: 'muted' }, 'Press “Reduce all sights”.')),
    );
    return;
  }
  if (state.reduced.length === 0) {
    root.appendChild(
      panel('Nothing to reduce', h('p', { class: 'muted' }, 'The session has no observations.')),
    );
    return;
  }

  const container = h('div', { class: 'sight-list' });
  for (const entry of state.reduced) {
    if (entry.status === 'ok') container.appendChild(sightBlock(entry.sight));
    else
      container.appendChild(
        h(
          'section',
          { class: 'sight-block rejected' },
          h('h3', {}, `${entry.id} · rejected`),
          h('p', { class: 'error' }, entry.message),
        ),
      );
  }
  root.appendChild(container);
}
