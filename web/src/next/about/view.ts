/**
 * The About view: what this page is and is not, where each number comes from and how
 * far it can be trusted (the engine's own coverage table), and what happens to the
 * person's place. Mounted through the view registry like every view (shell/registry.ts).
 * OWNER: shell-design agent (a first version; the documentation agent may extend it).
 */

import './about.css';
import { h } from '../../dom.js';
import type { Component } from '../component.js';
import { installControl, manualLink, repositoryLink } from '../shell/links.js';
import { hasTour, openTour } from '../shell/tour.js';
import { badge, button } from '../theme/primitives.js';

const view: Component = (host, ctx) => {
  const { engine } = ctx;
  let coverageRows: HTMLElement[] = [];
  let span = '';
  try {
    const coverage = engine.coverage();
    span = `${coverage.start_utc.slice(0, 10)} to ${coverage.end_utc.slice(0, 10)}`;
    coverageRows = coverage.groups.map((g) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, g.name),
        h('td', {}, g.provider),
        h('td', { class: 'sf-num-r' }, g.accuracy_arcmin === null ? '—' : `${g.accuracy_arcmin}′`),
        h('td', {}, g.validated ? badge('real', { text: 'Validated' }) : badge('soon', { text: 'Not validated' })),
      ),
    );
  } catch (error) {
    coverageRows = [h('tr', {}, h('td', { colspan: 4 }, `The engine did not say: ${error instanceof Error ? error.message : String(error)}`))];
  }

  const install = installControl();
  const el = h(
    'article',
    { class: 'sf-about sf-on-stage' },
    h(
      'div',
      { class: 'sf-about__inner' },
      h('p', { class: 'sf-about__kicker' }, 'About'),
      h('h1', {}, 'SkyFix Lab explorer'),
      h('p', { class: 'sf-about__honesty', role: 'note' }, 'Simulation and analysis workbench. Not a navigation instrument.'),
      h(
        'p',
        { class: 'sf-about__lead' },
        'Choose a place and a moment, and see where the Sun, the Moon, the planets and the navigational stars are from there: how high, in which direction, and when they rise and set. It works offline once loaded.',
      ),
      hasTour(ctx)
        ? h(
            'p',
            { class: 'sf-about__tour' },
            button({ label: 'Show the tour', icon: 'info', variant: 'secondary', size: 'sm', onClick: () => openTour(ctx) }),
            ' Four short steps: the place, the time, the views, and what the numbers are.',
          )
        : null,
      h('h2', {}, 'Where the numbers come from'),
      h(
        'p',
        {},
        engine.kind === 'wasm'
          ? 'Every position and time on these pages comes from the SkyFix Lab numerical core, written in Rust and running inside this page as WebAssembly. Nothing is fetched from a server to compute them.'
          : 'This page is running the MOCK engine, a stand-in used while the interface is built. Its numbers are illustrative only and come from low-precision formulas, not from the SkyFix Lab core.',
      ),
      h('p', {}, `How closely each part has been checked against the reference ephemeris (JPL DE440s through Skyfield), over ${span || 'its coverage'}:`),
      h(
        'div',
        { class: 'sf-about__table' },
        h(
          'table',
          { class: 'sf-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Bodies'), h('th', {}, 'Source'), h('th', { class: 'sf-num-r' }, 'Within'), h('th', {}, 'Status'))),
          h('tbody', {}, ...coverageRows),
        ),
      ),
      h(
        'p',
        { class: 'sf-about__small' },
        'A body is offered for sights only when its source is validated. Mercury, Uranus and Neptune are shown but never offered: navigators do not use them. The star field and the maps are for display only and never enter a fix.',
      ),
      h('h2', {}, 'Your place stays with you'),
      h(
        'p',
        {},
        'The place you choose is never saved and never sent anywhere. It goes into a link only when you press Share, and then only into the link you are shown. Your settings (theme, units, angle format, the map’s layers) and whether you have seen the tour are remembered on this device. Sights you enter in Navigate are kept on this device, with their assumed position, only while its “Keep my sights in this browser” is on. Data packs you choose to get (Settings → Data packs) are saved in this browser until you remove them; getting one sends nothing about you.',
      ),
      h('h2', {}, 'Also here'),
      h(
        'ul',
        {},
        h('li', {}, manualLink(), ': how to use every view, how far each number can be trusted, the command-line tool, and where every piece of data comes from. Pages you have read stay readable offline.'),
        h('li', {}, repositoryLink(), ' (MIT or Apache-2.0): the Rust core that does every calculation, this page, and the command-line tool.'),
        h('li', {}, 'Map data: Natural Earth (public domain). Stars: the Yale Bright Star Catalogue from NASA HEASARC. Fonts: Inter and JetBrains Mono (SIL Open Font License).'),
      ),
      install.el,
    ),
  );
  host.replaceChildren(el);
  return {
    destroy: () => {
      install.destroy();
      el.remove();
    },
  };
};

export default view;
