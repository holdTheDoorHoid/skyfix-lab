/**
 * The place search at the top of the panel: a combobox over the offline gazetteer that
 * also takes typed coordinates, and "use my location". OWNER: shell-design agent.
 *
 * Choosing a place moves the observer. A named place brings its own time zone (it
 * follows the place); a typed position or "my location" gets a guessed zone from the place
 * service. A pinned zone is never touched. The position is never stored or sent.
 */

import { h } from '../../dom.js';
import { disposer, type Ctx } from '../component.js';
import { placeLabel, type PlaceMatch } from '../geo/index.js';
import { formatLat, formatLon } from '../shell/format.js';
import { zoneChoiceForPlace, type PlaceService } from '../shell/place.js';
import { zonePinned, type ObserverState } from '../state.js';
import { icon } from '../theme/icons.js';
import { iconButton } from '../theme/primitives.js';
// sky2 agent: the "Sky objects" group (stars, deep-sky objects, planets, showers) below the places.
import { engineObserver } from '../state.js';
import type { SearchHit } from '../engine/types.js';
import { panelSkyOptions, targetOfHit } from '../sky/find.js';
import { showInSky } from '../sky/requests.js';

export interface SearchOptions {
  place: PlaceService;
  /** Called after a place is chosen (the phone sheet steps aside to show the map). */
  onChosen?: (label: string) => void;
}

type Option =
  | { kind: 'place'; match: PlaceMatch; label: string; where: string }
  | { kind: 'position'; lat: number; lon: number; label: string }
  | { kind: 'message'; label: string }
  // sky2 agent
  | { kind: 'group'; label: string }
  | { kind: 'sky'; hit: SearchHit; label: string; where: string };

let seq = 0;

export function placeSearch(ctx: Ctx, options: SearchOptions): { el: HTMLElement; destroy(): void } {
  const { store, notices } = ctx;
  const d = disposer();
  const id = `sf-search-${++seq}`;
  const input = h('input', {
    class: 'sf-input',
    type: 'search',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': `${id}-list`,
    'aria-label': 'Search a place, or type coordinates such as 39 57.2 N 75 09.9 W',
    placeholder: 'Place name or coordinates',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  const list = h('ul', { class: 'sf-search__list', id: `${id}-list`, role: 'listbox', 'aria-label': 'Places', hidden: true });
  const status = h('p', { class: 'sf-sr', role: 'status', 'aria-live': 'polite' });
  const locate = iconButton('locate', 'Use my location', {
    variant: 'outline',
    tip: 'Use my location: asked from your browser, used only in this page, never saved or sent',
  });
  const el = h(
    'div',
    { class: 'sf-search', role: 'search' },
    h('div', { class: 'sf-field' }, icon('search'), input),
    locate,
    list,
    status,
  );

  let items: Option[] = [];
  let active = -1;
  let timer = 0;

  const close = (): void => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const render = (): void => {
    list.replaceChildren(
      ...items.map((item, i) => {
        if (item.kind === 'group') return h('li', { class: 'sf-search__group', role: 'presentation' }, item.label); // sky2 agent
        const selectable = item.kind !== 'message';
        const li = h(
          'li',
          {
            class: `sf-search__opt${selectable ? '' : ' sf-search__opt--msg'}`,
            id: `${id}-opt-${i}`,
            role: 'option',
            'aria-selected': String(i === active),
            'aria-disabled': selectable ? undefined : 'true',
          },
          item.kind === 'message' ? icon('info') : icon(item.kind === 'place' ? 'pin' : item.kind === 'sky' ? 'sky' : 'target'),
          h(
            'span',
            { class: 'sf-search__text' },
            h('span', { class: 'sf-search__name' }, item.label),
            (item.kind === 'place' || item.kind === 'sky') && item.where ? h('span', { class: 'sf-search__where' }, item.where) : null,
          ),
        );
        if (selectable) {
          // pointerdown, not click: the input keeps the focus.
          li.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            choose(i);
          });
        }
        return li;
      }),
    );
    list.hidden = items.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  const run = (): void => {
    const text = input.value.trim();
    if (!text) {
      items = [];
      close();
      list.replaceChildren();
      return;
    }
    const o = store.get().observer;
    const result = options.place.search(text, { lat_deg: o.lat_deg, lon_deg: o.lon_deg });
    const g = options.place.data().gazetteer;
    const format = store.get().settings.angleFormat;
    if (!result) {
      items = [
        {
          kind: 'message',
          label: options.place.data().error ? 'Place names are not available offline right now; type coordinates instead.' : 'Loading place names…',
        },
      ];
    } else if (result.kind === 'position') {
      const { lat_deg: lat, lon_deg: lon } = result.position;
      items = [{ kind: 'position', lat, lon, label: `Go to ${formatLat(lat, format)}, ${formatLon(lon, format)}` }];
    } else if (result.kind === 'places') {
      items = result.matches.map((match) => {
        const full = g ? placeLabel(g, match.place) : match.place.name;
        const where = full.startsWith(`${match.place.name}, `) ? full.slice(match.place.name.length + 2) : '';
        return { kind: 'place', match, label: match.place.name, where };
      });
    } else {
      items = [{ kind: 'message', label: result.message }];
    }
    // sky2 agent: sky objects by that name, after the places (a typed position has none).
    if (result?.kind !== 'position') {
      const state = store.get();
      const sky = panelSkyOptions(ctx.engine, text, engineObserver(state), state.time.jd_utc, 4);
      if (sky.length) {
        items = items.filter((i) => i.kind !== 'message' || result?.kind === 'places');
        items.push({ kind: 'group', label: 'Sky objects' }, ...sky.map((o) => ({ kind: 'sky' as const, hit: o.hit, label: o.label, where: o.where })));
      }
    }
    active = items.findIndex((i) => i.kind !== 'message' && i.kind !== 'group');
    render();
  };

  const moveTo = (o: Partial<ObserverState> & { lat_deg: number; lon_deg: number }, announce: string): void => {
    const current = store.get().observer;
    // A pinned zone stays; otherwise a zone given here (a named place's own) is used, or the service guesses.
    const zone = zonePinned(current.zone) ? undefined : o.zone;
    const { zone: _given, ...place } = o;
    void _given;
    store.patch({ observer: { height_m: 0, label: '', ...place, ...(zone ? { zone } : {}) } });
    status.textContent = `Place set: ${announce}.`;
    options.onChosen?.(announce);
  };

  const choose = (i: number): void => {
    const item = items[i];
    if (!item || item.kind === 'message' || item.kind === 'group') return;
    if (item.kind === 'sky') {
      // sky2 agent: open the Sky view on it (the place stays).
      showInSky(ctx, targetOfHit(item.hit));
      status.textContent = `Showing ${item.label} in the Sky view.`;
      input.value = '';
      items = [];
      close();
      return;
    }
    const g = options.place.data().gazetteer;
    if (item.kind === 'place') {
      const p = item.match.place;
      const label = g ? placeLabel(g, p) : p.name;
      const zone = zoneChoiceForPlace(p.zone);
      moveTo({ lat_deg: p.lat_deg, lon_deg: p.lon_deg, label, ...(zone ? { zone } : {}) }, label);
    } else {
      moveTo({ lat_deg: item.lat, lon_deg: item.lon, label: '' }, item.label.replace(/^Go to /, ''));
    }
    input.value = '';
    items = [];
    close();
  };

  const onInput = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 70);
  };
  const onKey = (e: KeyboardEvent): void => {
    const selectable = items.map((it, i) => (it.kind === 'message' || it.kind === 'group' ? -1 : i)).filter((i) => i >= 0);
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (list.hidden) {
          run();
          e.preventDefault();
          return;
        }
        if (!selectable.length) return;
        e.preventDefault();
        const pos = selectable.indexOf(active);
        const next = e.key === 'ArrowDown' ? (pos + 1) % selectable.length : (pos - 1 + selectable.length) % selectable.length;
        active = selectable[next] ?? -1;
        render();
        return;
      }
      case 'Enter':
        if (timer) {
          window.clearTimeout(timer);
          timer = 0;
          run();
        }
        if (active >= 0) {
          e.preventDefault();
          choose(active);
        }
        return;
      case 'Escape':
        if (!list.hidden) {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (input.value) {
          e.preventDefault();
          input.value = '';
        }
        return;
      case 'Tab':
        close();
        return;
      default:
        return;
    }
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', () => window.setTimeout(close, 120));
  input.addEventListener('focus', () => {
    if (input.value.trim()) run();
  });
  d.add(() => window.clearTimeout(timer));
  // Results depend on the place data; refresh an open list when it arrives.
  d.add(
    options.place.subscribe(() => {
      if (input.value.trim() && document.activeElement === input) run();
    }),
  );

  // --- my location ------------------------------------------------------------------
  locate.addEventListener('click', () => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) {
      notices.push('caution', 'This browser cannot tell its location. Search for a place or type coordinates instead.', { key: 'locate' });
      return;
    }
    locate.setAttribute('aria-busy', 'true');
    locate.classList.add('sf-busy');
    geo.getCurrentPosition(
      (pos) => {
        locate.removeAttribute('aria-busy');
        locate.classList.remove('sf-busy');
        const { latitude, longitude, altitude, accuracy } = pos.coords;
        moveTo(
          { lat_deg: latitude, lon_deg: longitude, height_m: altitude ?? 0, label: '' },
          `${formatLat(latitude, 'dm')}, ${formatLon(longitude, 'dm')}`,
        );
        notices.push(
          'info',
          `Using your location (to within about ${Math.max(1, Math.round(accuracy))} m). It stays in this page: it is not saved, and nothing is sent.`,
          { key: 'locate' },
        );
      },
      (error) => {
        locate.removeAttribute('aria-busy');
        locate.classList.remove('sf-busy');
        const why =
          error.code === error.PERMISSION_DENIED
            ? 'the browser was not allowed to share it'
            : error.code === error.TIMEOUT
              ? 'the browser took too long to find it'
              : 'the browser could not find it';
        notices.push('caution', `Could not use your location: ${why}. Search for a place or type coordinates instead.`, { key: 'locate' });
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 },
    );
  });

  return { el, destroy: () => d.dispose() };
}
