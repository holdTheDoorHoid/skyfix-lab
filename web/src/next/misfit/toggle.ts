/**
 * The "Fit map" switch that the Navigate and Learn charts share: a toggle button, the grid
 * computed only while it is on and only when the solve's inputs change (never per frame:
 * about 44 ms in WebAssembly), and the honest words under the chart (the caption, the
 * grid's own notes, and a key to the shading). OWNER: misfit agent (added by the polish
 * pass, which wired the heat map into the two views).
 *
 * Each chart draws the heat and the lines itself, in its own projection (README §2); this
 * only holds the grid and says when to redraw: after the switch, a new grid, or a theme
 * change (the heat's colours are in its pixels).
 */

import { h } from '../../dom.js';
import type { SolveOptions, Session } from '../../types.js';
import type { EphemerisMode, ExplorerEngine, MisfitBounds, MisfitGrid } from '../engine/types.js';
import { onThemeChange } from '../theme/theme.js';
import { button, setPressed } from '../theme/primitives.js';
import { misfitCaption } from './caption.js';
import { misfitContours, type MisfitContours } from './contours.js';
import { rampGradient, themeRamp } from './ramp.js';

/** Exactly what the chart's solve was given, and the frame to map. */
export interface MisfitInput {
  session: Session;
  mode: EphemerisMode;
  options: Partial<SolveOptions> | null;
  /** The chart's own frame, so the heat fills it; null: the grid's default frame. */
  bounds?: MisfitBounds | null;
}

export interface FitMapPicture {
  grid: MisfitGrid;
  contours: MisfitContours;
}

export interface FitMap {
  /** The switch, for the chart's toolbar. */
  button: HTMLButtonElement;
  /** The words for under the chart; hidden while the switch is off. */
  caption: HTMLElement;
  isOn(): boolean;
  set(on: boolean): void;
  /** The solve the chart now shows (the same object again means nothing changed). */
  setInput(input: MisfitInput | null): void;
  /** The grid to draw, or null (off, nothing to map, or it failed: the caption says why). */
  picture(): FitMapPicture | null;
  destroy(): void;
}

export interface FitMapOptions {
  /** On from the start (Learn turns it on where it teaches most). Default false. */
  on?: boolean;
  /** Called when the chart must redraw. */
  onChange: () => void;
  /** Nodes along each axis. Default 200. */
  nodes?: number;
}

/** The switch and its grid, or null when this engine has no misfit exports. */
export function fitMap(engine: Pick<ExplorerEngine, 'misfit'>, options: FitMapOptions): FitMap | null {
  const misfit = engine.misfit;
  if (!misfit) return null;
  const nodes = options.nodes ?? 200;
  let on = options.on ?? false;
  let input: MisfitInput | null = null;
  let computedFor: MisfitInput | null = null;
  let picture: FitMapPicture | null = null;
  let failure: string | null = null;

  const btn = button({
    label: 'Fit map',
    icon: 'layers',
    size: 'sm',
    variant: 'outline',
    pressed: on,
    tip: 'Shade every nearby position by how well it fits the sights (the residual heat map)',
  });
  const key = h('div', { class: 'sf-fitmap__key', 'aria-hidden': 'true' }, h('span', {}, 'best fit'), h('span', { class: 'sf-fitmap__ramp' }), h('span', {}, 'worse'));
  const text = h('p', { class: 'sf-fitmap__caption' });
  const notes = h('ul', { class: 'sf-fitmap__notes' });
  const caption = h('div', { class: 'sf-fitmap', hidden: true }, key, text, notes);

  const compute = (): void => {
    if (!on || !input || computedFor === input) return;
    computedFor = input;
    try {
      const grid = misfit.misfitGrid(input.session, input.mode, input.options, input.bounds ?? null, nodes, nodes);
      picture = { grid, contours: misfitContours(grid) };
      failure = null;
    } catch (error) {
      picture = null;
      failure = error instanceof Error ? error.message : String(error);
    }
  };

  const fill = (): void => {
    caption.hidden = !on;
    if (!on) return;
    const ramp = key.querySelector<HTMLElement>('.sf-fitmap__ramp')!;
    ramp.style.background = rampGradient(themeRamp());
    if (picture) {
      text.textContent = misfitCaption(picture.grid);
      notes.replaceChildren(...picture.grid.notes.map((n) => h('li', {}, n)));
      key.hidden = false;
    } else {
      text.textContent = failure ? `The fit map could not be computed: ${failure}` : 'No fix to map yet.';
      notes.replaceChildren();
      key.hidden = true;
    }
  };

  const changed = (): void => {
    compute();
    fill();
    options.onChange();
  };

  btn.addEventListener('click', () => api.set(!on));
  const stopTheme = onThemeChange(() => {
    if (on) changed();
  });

  const api: FitMap = {
    button: btn,
    caption,
    isOn: () => on,
    set(next) {
      if (next === on) return;
      on = next;
      setPressed(btn, on);
      changed();
    },
    setInput(next) {
      if (next === input) return;
      input = next;
      if (!next) {
        picture = null;
        computedFor = null;
        failure = null;
      }
      if (on) changed();
    },
    picture: () => (on ? picture : null),
    destroy() {
      stopTheme();
    },
  };
  fill();
  return api;
}
