/**
 * Planner: a placeholder that states what the planner will and will not be able to do.
 * Nothing is wired yet, so nothing here pretends to rank anything.
 */

import { clear, h } from '../dom.js';
import type { Store } from '../store.js';
import { note, panel } from './common.js';

export function renderPlanner(store: Store, root: HTMLElement): void {
  clear(root);
  const assumed = store.state.session.observer.assumed_position;

  root.appendChild(
    panel(
      'Observation planner — not implemented yet',
      note('This view exists so its two limitations are stated before the feature arrives.'),
      h(
        'ol',
        { class: 'explain' },
        h(
          'li',
          {},
          h('strong', {}, 'It needs an approximate position, and that is disclosed. '),
          'Ranking bodies means predicting where they will be, which needs a position to predict from. The brief allows an approximate supplied position here; every plan it produces will name the position it assumed. That approximate position is a planning input only and never becomes a prior on a fix.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Visibility is geometric only. '),
          'Without weather data, "visible" can only mean "above the horizon and far enough from the Sun". A body this planner calls visible may be behind cloud, and a body it calls too low may be perfectly usable from a hilltop.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Ranking will use conditioning, not brightness. '),
          'The useful question is which body most improves the conditioning of the fix you already have, which is not the same as the brightest star or an evenly spaced azimuth.',
        ),
      ),
      h(
        'p',
        { class: 'note' },
        assumed
          ? `The assumed position currently on the Observations view is ${assumed.lat_deg.toFixed(4)}, ${assumed.lon_deg.toFixed(4)} (east-positive). The planner would disclose exactly this.`
          : 'There is no assumed position on the Observations view. The planner would refuse to rank anything without one.',
      ),
    ),
  );
}
