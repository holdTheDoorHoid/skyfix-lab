/**
 * The page a view shows until its folder is merged: what it will do, in plain words, and
 * something useful to do meanwhile. Friendly, never an error. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import type { Mounted } from '../component.js';
import { icon } from '../theme/icons.js';
import { badge } from '../theme/primitives.js';
import type { ViewMeta } from './views.js';

export function placeholder(host: HTMLElement, meta: ViewMeta, options: { error?: string } = {}): Mounted {
  const el = h(
    'div',
    { class: 'sf-placeholder sf-on-stage' },
    h(
      'div',
      { class: 'sf-placeholder__card' },
      h('div', { class: 'sf-placeholder__icon' }, icon(meta.icon)),
      h(
        'h1',
        { class: 'sf-placeholder__title' },
        meta.title,
        options.error ? null : badge('soon', { text: 'Coming soon' }),
      ),
      options.error
        ? h('p', { class: 'sf-placeholder__lead' }, `This view could not be loaded: ${options.error}`)
        : h('p', { class: 'sf-placeholder__lead' }, 'This view is being built. It will show:'),
      h('ul', { class: 'sf-placeholder__list' }, ...meta.promise.map((p) => h('li', {}, p))),
      meta.meanwhile
        ? h(
            'p',
            { class: 'sf-placeholder__meanwhile' },
            `${meta.meanwhile} `,
            h('a', { href: '../' }, 'Open the current workbench'),
            '.',
          )
        : null,
      h('p', { class: 'sf-placeholder__note' }, 'The panel beside this works on every view: choose a place, a time and a body there.'),
    ),
  );
  host.replaceChildren(el);
  return { destroy: () => el.remove() };
}
