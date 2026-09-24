/**
 * About: what this is, what it is not, and the exact limits of the numbers on screen.
 * The planner agent will replace most of this with links into docs/.
 */

import { clear, h } from '../dom.js';
import type { Store } from '../store.js';
import { ALL_WARNING_EXAMPLES } from '../api/fixtures.js';
import { warningSentence, WARNING_SEVERITY } from '../types.js';
import { note, panel } from './common.js';

export function renderAbout(store: Store, root: HTMLElement): void {
  clear(root);
  const state = store.state;

  root.appendChild(
    panel(
      'What this is',
      h(
        'p',
        { class: 'plain' },
        'SkyFix Lab is a simulation and analysis workbench for celestial navigation. It reduces sights, solves a position by weighted least squares, and shows how much of the answer is geometry and how much is measurement. It is not a navigation instrument, and it has no connection to any positioning system.',
      ),
      h(
        'dl',
        { class: 'facts' },
        h('div', { class: 'kv' }, h('dt', {}, 'Core version'), h('dd', {}, state.coreVersion)),
        h('div', { class: 'kv' }, h('dt', {}, 'Computation'), h('dd', {}, `${store.api.kind} — ${store.api.description}`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Network'), h('dd', {}, 'None. Every asset, font and script is served from this page.')),
      ),
      state.apiNotice ? h('p', { class: 'caution' }, state.apiNotice) : null,
    ),
  );

  root.appendChild(
    panel(
      'Limitations you should read before trusting a number',
      h(
        'ol',
        { class: 'explain' },
        h('li', {}, h('strong', {}, 'One altitude is a circle, not a position. '), 'Two circles usually meet at two points. This tool reports that as an ambiguity rather than picking one.'),
        h('li', {}, h('strong', {}, 'Clock error and longitude are the same unknown for star sights. '), 'The solver never estimates a clock offset. It propagates a clock uncertainty you declare into an east-west term, and says so.'),
        h('li', {}, h('strong', {}, 'The ellipse is nominal, not empirical. '), 'It is built from the sigmas you supplied under an independent-noise model. It is not an observed error distribution, and it cannot see a bias that is shared by every sight.'),
        h('li', {}, h('strong', {}, 'Repeating a measurement does not average away a common error. '), 'Independent noise and a shared instrument or time bias are different things, and the second one leaves the residuals looking excellent.'),
        h('li', {}, h('strong', {}, 'The Earth model is a sphere. '), 'One arcminute of arc is one nautical mile exactly; no ellipsoid correction is applied anywhere.'),
        h('li', {}, h('strong', {}, 'Numerical agreement is not field accuracy. '), 'A clean synthetic case recovering its truth to within metres says the arithmetic is right. It says nothing about what a sextant on a moving deck will give you.'),
      ),
      note('The word "accuracy" is deliberately absent from this interface. What is reported is a nominal uncertainty under a stated model.'),
    ),
  );

  const coveragePanel = h('div', {});
  root.appendChild(panel('Offline astronomy coverage', coveragePanel));
  void store.api
    .coverage()
    .then((report) => {
      clear(coveragePanel);
      for (const provider of report.providers) {
        coveragePanel.appendChild(
          h(
            'div',
            { class: 'kv' },
            h('dt', {}, provider.provider),
            h(
              'dd',
              {},
              provider.start_utc ? `${provider.start_utc} to ${provider.end_utc}. ` : '',
              provider.notes,
              provider.accuracy_arcmin > 0
                ? ` Documented agreement with the reference: ${provider.accuracy_arcmin}′.`
                : '',
            ),
          ),
        );
      }
      coveragePanel.appendChild(
        h('p', { class: 'note' }, `Direction sources this build accepts: ${report.modes.join(', ')}.`),
      );
    })
    .catch((error: unknown) => {
      clear(coveragePanel);
      coveragePanel.appendChild(h('p', { class: 'error' }, String(error)));
    });

  const vocabulary = h('dl', { class: 'facts' });
  for (const example of ALL_WARNING_EXAMPLES) {
    vocabulary.appendChild(
      h(
        'div',
        { class: 'kv' },
        h('dt', {}, h('span', { class: `warning-tag warning-${WARNING_SEVERITY[example.code]}` }, example.code)),
        h('dd', {}, warningSentence(example)),
      ),
    );
  }
  root.appendChild(
    panel(
      'Every warning this tool can raise',
      note('One example of each code, with the sentence the interface prints for it.'),
      vocabulary,
    ),
  );
}
