/**
 * The Sky view's Layers menu: what is drawn, how dark the sky is, and the comets and
 * asteroids the person added. OWNER: sky2 agent (expansion Q3; the switches were the sky
 * agent's, in view.ts).
 *
 * "How dark is the sky" sets `settings.skyQuality` (state.ts): Automatic (a dark site,
 * dimmed only by twilight, as the Sky view always drew), a Bortle class, or the faintest
 * star the person sees overhead; the line under it says what the Sky view draws down to
 * now, at the zenith and 20° up, as an estimate. Comets and asteroids are read by the
 * planet-detail engine's `parse_orbits` and kept for the page session (custom.ts).
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import { isPlanetDetailEngine, type OrbitalElements } from '../engine/types.js';
import type { Layers, SkyQuality } from '../state.js';
import { button, segmented, switchRow, type Segmented } from '../theme/primitives.js';
import { BORTLE_NELM, BORTLE_WORDS } from './conditions.js';
import { CUSTOM_EXAMPLE, CUSTOM_EXAMPLE_CREDIT, customBodies, MAX_CUSTOM_BODIES, MPC_CREDIT } from './custom.js';

export interface LayerOption {
  key: keyof Layers;
  label: string;
  note?: string;
  group: 'sky' | 'lines' | 'dark';
}

export interface LayersMenuInfo {
  /** Faintest magnitude drawn at the zenith now, and 20° up (with extinction). */
  zenith: number;
  at20: number;
  /** The Milky Way's visibility now, 0–1. */
  milkyWay: number;
  /** Why the engine could not give the sky's conditions, or null. */
  error: string | null;
  /** Deep-sky objects drawn now, and why none are (''). */
  dsoShown: number;
  dsoNote: string;
}

export interface LayersMenu {
  el: HTMLElement;
  sync(info: LayersMenuInfo): void;
  destroy(): void;
}

export function layersMenu(ctx: Ctx, options: readonly LayerOption[]): LayersMenu {
  const { store } = ctx;
  const cleanups: (() => void)[] = [];
  const switches = new Map<keyof Layers, HTMLButtonElement>();
  const switchFor = (item: LayerOption): HTMLButtonElement => {
    const sw = switchRow({
      label: item.label,
      checked: store.get().layers[item.key],
      ...(item.note ? { note: item.note } : {}),
      onChange: (on) => store.patch({ layers: { [item.key]: on } as Partial<Layers> }),
    });
    sw.dataset.layer = item.key;
    switches.set(item.key, sw);
    return sw;
  };
  const title = (text: string): HTMLElement => h('div', { class: 'sf-popover__title' }, text);

  // --- how dark the sky is ------------------------------------------------------------
  const quality: Segmented<SkyQuality> = segmented<SkyQuality>({
    label: 'How dark the sky is',
    value: store.get().settings.skyQuality,
    size: 'sm',
    class: 'sky-quality__seg',
    onChange: (v) => store.patch({ settings: { skyQuality: v } }),
    options: [
      { value: 'auto', label: 'Automatic', tip: 'A dark site: the stars fade only with twilight' },
      { value: 'bortle', label: 'Bortle class', tip: 'Light pollution by Bortle’s nine classes' },
      { value: 'nelm', label: 'Faintest star', tip: 'The faintest star you can see overhead' },
    ],
  });
  const bortleSelect = h('select', { class: 'sf-input sky-quality__input', 'aria-label': 'Bortle class' });
  BORTLE_WORDS.forEach((words, i) => {
    bortleSelect.append(h('option', { value: String(i + 1) }, `${i + 1} · ${words} (to ${BORTLE_NELM[i]!.toFixed(1)})`));
  });
  bortleSelect.value = String(store.get().settings.skyBortle);
  bortleSelect.addEventListener('change', () => store.patch({ settings: { skyBortle: Number(bortleSelect.value) } }));
  const nelmInput = h('input', {
    class: 'sf-input sky-quality__input',
    type: 'number',
    min: 1,
    max: 8,
    step: 0.1,
    inputmode: 'decimal',
    'aria-label': 'Faintest star you can see overhead, magnitude',
    value: String(store.get().settings.skyNelm),
  });
  const onNelm = (): void => {
    const v = Number(nelmInput.value);
    if (Number.isFinite(v) && v >= 1 && v <= 8) store.patch({ settings: { skyNelm: Math.round(v * 10) / 10 } });
  };
  nelmInput.addEventListener('change', onNelm);
  const bortleRow = h('label', { class: 'sky-quality__row' }, h('span', {}, 'Class'), bortleSelect);
  const nelmRow = h('label', { class: 'sky-quality__row' }, h('span', {}, 'Faintest star overhead, magnitude'), nelmInput);
  const qualityNow = h('p', { class: 'sky-quality__now', 'aria-live': 'polite' });
  const qualityBox = h('div', { class: 'sky-quality' }, quality.el, bortleRow, nelmRow, qualityNow);

  // --- comets and asteroids -----------------------------------------------------------
  const bodies = customBodies(ctx);
  const bodyList = h('ul', { class: 'sky-custom__list', 'aria-label': 'Comets and asteroids added' });
  const addButton = button({ label: 'Add from orbital elements…', icon: 'plus', size: 'sm', variant: 'outline' });
  const textarea = h('textarea', {
    class: 'sf-input sky-custom__text',
    rows: 5,
    spellcheck: 'false',
    'aria-label': 'Orbital elements: lines from the Minor Planet Center (MPCORB or comet format) or JSON',
    placeholder: 'Paste MPCORB or comet lines from the Minor Planet Center, or JSON',
  });
  const formError = h('p', { class: 'sky-custom__error', role: 'alert', hidden: true });
  const credit = h('p', { class: 'sky-custom__hint', hidden: true }, CUSTOM_EXAMPLE_CREDIT);
  const exampleButton = button({ label: 'Example', size: 'sm', variant: 'ghost', tip: 'Fill in (1) Ceres' });
  const readButton = button({ label: 'Add', size: 'sm', variant: 'primary' });
  const cancelButton = button({ label: 'Cancel', size: 'sm', variant: 'ghost' });
  const form = h(
    'div',
    { class: 'sky-custom__form', hidden: true },
    textarea,
    formError,
    credit,
    h('div', { class: 'sky-custom__buttons' }, exampleButton, cancelButton, readButton),
    h('p', { class: 'sky-custom__hint' }, 'Positions from elements follow the orbit without the planets’ pull, so they drift from the real body as the elements age (a warning shows past 30 days). Kept for this visit only.'),
  );
  const planetDetail = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  if (!planetDetail) {
    addButton.disabled = true;
    addButton.dataset.tip = 'Comets and asteroids from elements are not available in this engine';
  }
  addButton.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) textarea.focus();
  });
  cancelButton.addEventListener('click', () => {
    form.hidden = true;
    formError.hidden = true;
    addButton.focus();
  });
  exampleButton.addEventListener('click', () => {
    textarea.value = CUSTOM_EXAMPLE;
    credit.hidden = false;
    formError.hidden = true;
  });
  readButton.addEventListener('click', () => {
    if (!planetDetail) return;
    let parsed: OrbitalElements[];
    try {
      parsed = planetDetail.parseOrbits(textarea.value);
    } catch (error) {
      formError.hidden = false;
      formError.textContent = `These elements could not be read: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (!parsed.length) {
      formError.hidden = false;
      formError.textContent = 'No elements found in that text.';
      return;
    }
    // The worked example's values are the MPC's: they keep its credit.
    bodies.add(parsed, textarea.value.trim() === CUSTOM_EXAMPLE.trim() ? MPC_CREDIT : undefined);
    if (!store.get().layers.customBodies) store.patch({ layers: { customBodies: true } });
    textarea.value = '';
    formError.hidden = true;
    credit.hidden = true;
    form.hidden = true;
    addButton.focus();
  });
  const renderBodies = (list: readonly OrbitalElements[]): void => {
    bodyList.replaceChildren(
      ...list.map((b) =>
        h(
          'li',
          { class: 'sky-custom__item' },
          h('span', { class: 'sky-custom__name' }, b.name, h('span', { class: 'sky-custom__kind' }, ` · ${b.class}${bodies.creditOf(b) ? ` · ${bodies.creditOf(b)}` : ''}`)),
          button({ label: 'Remove', size: 'sm', variant: 'ghost', ariaLabel: `Remove ${b.name}`, onClick: () => bodies.remove(b.name) }),
        ),
      ),
    );
    bodyList.hidden = list.length === 0;
    addButton.hidden = list.length >= MAX_CUSTOM_BODIES;
  };
  renderBodies(bodies.get());
  cleanups.push(bodies.subscribe(renderBodies));
  const customBox = h('div', { class: 'sky-custom' }, bodyList, addButton, form);

  const dsoNote = h('p', { class: 'sky-layers__note' });

  const el = h(
    'div',
    { class: 'sf-layers sky-layers' },
    title('In the sky'),
    ...options.filter((i) => i.group === 'sky').map(switchFor),
    dsoNote,
    customBox,
    title('Lines'),
    ...options.filter((i) => i.group === 'lines').map(switchFor),
    title('How dark is your sky'),
    qualityBox,
    ...options.filter((i) => i.group === 'dark').map(switchFor),
  );

  let lastNow = '';
  return {
    el,
    sync(info) {
      const s = store.get();
      for (const [k, sw] of switches) sw.setAttribute('aria-checked', String(s.layers[k]));
      quality.set(s.settings.skyQuality);
      bortleRow.hidden = s.settings.skyQuality !== 'bortle';
      nelmRow.hidden = s.settings.skyQuality !== 'nelm';
      if (bortleSelect.value !== String(s.settings.skyBortle)) bortleSelect.value = String(s.settings.skyBortle);
      if (document.activeElement !== nelmInput && nelmInput.value !== String(s.settings.skyNelm)) nelmInput.value = String(s.settings.skyNelm);
      const mw = info.milkyWay <= 0 ? ' The Milky Way is not visible in this sky.' : info.milkyWay < 0.5 ? ' The Milky Way is faint.' : '';
      const now = info.error
        ? info.error
        : `Stars are drawn down to magnitude ${info.zenith.toFixed(1)} overhead and ${info.at20.toFixed(1)} at 20° up, an estimate.${mw}`;
      if (now !== lastNow) {
        qualityNow.textContent = now;
        lastNow = now;
      }
      const note = s.layers.deepSky ? info.dsoNote : '';
      if (dsoNote.textContent !== note) dsoNote.textContent = note;
      dsoNote.hidden = !note;
    },
    destroy() {
      while (cleanups.length) cleanups.pop()!();
    },
  };
}
