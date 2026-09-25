/**
 * The Sky view's search box (a combobox over the deep-sky engine's `sky_search`, through
 * find.ts). OWNER: sky2 agent (expansion Q3). The engine answers in a few milliseconds;
 * the box asks after typing pauses (80 ms).
 */

import { h } from '../../dom.js';
import type { ExplorerEngine, Observer, SearchHit } from '../engine/types.js';
import { icon } from '../theme/icons.js';
import { bodyGlyph } from '../theme/glyphs.js';
import type { DsoShape } from './deepsky.js';
import { hitWhere, runSkySearch } from './find.js';
import { kindSymbol } from './symbols.js';

export { hitWhere, KIND_WORDS, panelSkyOptions, runSkySearch, targetOfHit, type PanelSkyOption, type SkySearchResult } from './find.js';

/** The symbol a list shows for a hit (a body's glyph, or the chart's own mark). */
export function hitSymbol(hit: Pick<SearchHit, 'kind' | 'label'>, shape?: DsoShape): Element {
  if (hit.kind === 'sun' || hit.kind === 'moon' || hit.kind === 'planet') {
    return bodyGlyph(hit.label, { kind: hit.kind === 'planet' ? 'planet' : hit.kind, size: 16 });
  }
  return kindSymbol(hit.kind, shape);
}

// ---------------------------------------------------------------------------------
// The Sky view's search box: a combobox (role="combobox" + listbox), keyboard first
// ---------------------------------------------------------------------------------

export interface SearchBoxOptions {
  engine: ExplorerEngine;
  /** The observer and instant to place hits at (null: names only). */
  where(): { observer: Observer; jd: number } | null;
  /** A deep-sky hit's chart symbol. */
  shapeOf(id: string): DsoShape | undefined;
  onChoose(hit: SearchHit): void;
  /** Called with the query and the time the engine took, ms (statistics). */
  onSearched?(query: string, ms: number): void;
}

export interface SearchBox {
  el: HTMLElement;
  input: HTMLInputElement;
  /** Run a query now (tests, the developer page). */
  search(query: string): SearchHit[];
  clear(): void;
  destroy(): void;
}

let seq = 0;

export function skySearchBox(options: SearchBoxOptions): SearchBox {
  const id = `sky-search-${++seq}`;
  const input = h('input', {
    class: 'sf-input',
    type: 'search',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': `${id}-list`,
    'aria-label': 'Find a star, planet, deep-sky object, constellation or meteor shower',
    placeholder: 'Vega, M31, Orion, Perseids…',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  const list = h('ul', { class: 'sky-search__list', id: `${id}-list`, role: 'listbox', 'aria-label': 'Sky objects', hidden: true });
  const status = h('p', { class: 'sky-sr', role: 'status', 'aria-live': 'polite' });
  const note = h('p', { class: 'sky-search__note' }, 'Names, designations (alpha CMa, 61 Cyg), HR and HIP numbers, Messier and NGC numbers.');
  const el = h('div', { class: 'sky-search', role: 'search' }, h('div', { class: 'sf-field' }, icon('search'), input), list, note, status);

  let hits: SearchHit[] = [];
  let active = -1;
  let timer = 0;
  let message = '';

  const render = (): void => {
    const rows: HTMLElement[] = hits.map((hit, i) => {
      const where = hitWhere(hit);
      const li = h(
        'li',
        { class: 'sky-search__opt', id: `${id}-opt-${i}`, role: 'option', 'aria-selected': String(i === active) },
        h('span', { class: 'sky-search__sym' }, hitSymbol(hit, hit.kind === 'deep_sky' ? options.shapeOf(hit.id) : undefined)),
        h(
          'span',
          { class: 'sky-search__text' },
          h('span', { class: 'sky-search__name' }, hit.label),
          h('span', { class: 'sky-search__detail' }, hit.detail),
        ),
        where ? h('span', { class: `sky-search__where${hit.above_horizon ? '' : ' sky-search__where--below'}` }, where) : null,
      );
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        choose(i);
      });
      return li;
    });
    if (!hits.length && message) rows.push(h('li', { class: 'sky-search__opt sky-search__opt--msg', role: 'option', 'aria-disabled': 'true' }, message));
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  };

  const run = (): SearchHit[] => {
    timer = 0;
    const q = input.value.trim();
    if (!q) {
      hits = [];
      message = '';
      active = -1;
      render();
      return hits;
    }
    const at = options.where();
    const t0 = performance.now();
    const result = runSkySearch(options.engine, q, at?.observer ?? null, at?.jd ?? null, 12);
    options.onSearched?.(q, performance.now() - t0);
    hits = result.hits;
    message = result.error ?? (hits.length ? '' : `Nothing in the sky is called “${q}”.`);
    active = hits.length ? 0 : -1;
    status.textContent = hits.length ? `${hits.length} found. The first is ${hits[0]!.label}.` : message;
    render();
    return hits;
  };

  const choose = (i: number): void => {
    const hit = hits[i];
    if (!hit) return;
    options.onChoose(hit);
    status.textContent = `Showing ${hit.label}.`;
  };

  const onInput = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 80);
  };
  const onKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (timer) {
          window.clearTimeout(timer);
          run();
        }
        if (!hits.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + hits.length) % hits.length;
        render();
        return;
      }
      case 'Enter':
        if (timer) {
          window.clearTimeout(timer);
          run();
        }
        if (active >= 0) {
          e.preventDefault();
          choose(active);
        }
        return;
      case 'Escape':
        if (input.value) {
          e.preventDefault();
          e.stopPropagation();
          input.value = '';
          run();
        }
        return;
      default:
    }
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);

  return {
    el,
    input,
    search(query) {
      input.value = query;
      return run();
    },
    clear() {
      input.value = '';
      run();
    },
    destroy() {
      window.clearTimeout(timer);
      el.remove();
    },
  };
}

