/**
 * On phones the panel is a bottom sheet over the stage with three rests: `min` (the grab
 * bar, the view tabs and the search), `peek` (about half the screen) and `full`. Drag the
 * bar, tap it, or use the arrow keys on it. OWNER: shell-design agent.
 *
 * The view's host ends where the sheet begins (`--stage-view-inset` on the stage, px), so no
 * view has anything under the sheet: a map centres its place in what is visible, its
 * credits stay in sight, and a page scrolls to its end. Under the full sheet the view is
 * hidden; it keeps its peek size rather than shrinking to nothing.
 */

export type SheetState = 'min' | 'peek' | 'full';

const ORDER: SheetState[] = ['min', 'peek', 'full'];
const MIN_PX = 148;
const PEEK_FRACTION = 0.46;

export interface Sheet {
  set(state: SheetState): void;
  state(): SheetState;
  destroy(): void;
}

export function bottomSheet(app: HTMLElement, panel: HTMLElement, grab: HTMLElement, stage: HTMLElement): Sheet {
  const phone = matchMedia('(max-width: 767px)');
  let state: SheetState = (app.dataset.sheet as SheetState) || 'peek';

  const top = (): number => {
    const bar = app.querySelector<HTMLElement>('.sf-timebar');
    return bar ? bar.getBoundingClientRect().bottom : 0;
  };
  const heightOf = (s: SheetState): number => {
    const full = innerHeight - top();
    return s === 'min' ? Math.min(MIN_PX, full) : s === 'peek' ? Math.min(Math.round(innerHeight * PEEK_FRACTION), full) : full;
  };

  const publish = (): void => {
    const covered = phone.matches ? heightOf(state === 'full' ? 'peek' : state) : 0;
    const next = `${Math.round(covered)}px`;
    app.style.setProperty('--sheet-top', `${Math.round(top())}px`);
    if (stage.style.getPropertyValue('--stage-view-inset') !== next) stage.style.setProperty('--stage-view-inset', next);
  };

  const describe = (): void => {
    grab.setAttribute(
      'aria-label',
      state === 'full' ? 'Panel: full screen. Press to make it smaller' : state === 'peek' ? 'Panel: half the screen. Press to make it bigger' : 'Panel: small. Press to make it bigger',
    );
  };

  const set = (next: SheetState): void => {
    state = next;
    app.dataset.sheet = next;
    describe();
    publish();
  };

  // --- dragging -------------------------------------------------------------------------
  let startY = 0;
  let startVisible = 0;
  let dragging = false;
  let moved = false;

  const onDown = (e: PointerEvent): void => {
    if (!phone.matches) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startVisible = innerHeight - panel.getBoundingClientRect().top;
    grab.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const visible = Math.max(heightOf('min') - 40, Math.min(heightOf('full'), startVisible - dy));
    panel.style.transition = 'none';
    panel.style.transform = `translateY(calc(100% - ${visible}px))`;
  };
  const onUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    grab.releasePointerCapture?.(e.pointerId);
    panel.style.transition = '';
    panel.style.transform = '';
    if (!moved) {
      set(state === 'full' ? 'peek' : state === 'peek' ? 'full' : 'peek');
      return;
    }
    const visible = startVisible - (e.clientY - startY);
    let best: SheetState = state;
    for (const s of ORDER) if (Math.abs(heightOf(s) - visible) < Math.abs(heightOf(best) - visible)) best = s;
    set(best);
  };
  const onKey = (e: KeyboardEvent): void => {
    const i = ORDER.indexOf(state);
    if (e.key === 'ArrowUp') set(ORDER[Math.min(ORDER.length - 1, i + 1)]!);
    else if (e.key === 'ArrowDown') set(ORDER[Math.max(0, i - 1)]!);
    else if (e.key === 'Enter' || e.key === ' ') set(state === 'full' ? 'peek' : 'full');
    else return;
    e.preventDefault();
  };

  grab.addEventListener('pointerdown', onDown);
  grab.addEventListener('pointermove', onMove);
  grab.addEventListener('pointerup', onUp);
  grab.addEventListener('pointercancel', onUp);
  grab.addEventListener('keydown', onKey);
  const onResize = (): void => publish();
  addEventListener('resize', onResize);
  phone.addEventListener('change', onResize);
  set(state);

  return {
    set,
    state: () => state,
    destroy() {
      grab.removeEventListener('pointerdown', onDown);
      grab.removeEventListener('pointermove', onMove);
      grab.removeEventListener('pointerup', onUp);
      grab.removeEventListener('pointercancel', onUp);
      grab.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      phone.removeEventListener('change', onResize);
    },
  };
}
