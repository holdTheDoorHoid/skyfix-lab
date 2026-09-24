/**
 * The view's own chart panel: the position plot (or a method's altitude curve), sized to
 * its container, with zoom, pan and fit from buttons, the pointer and the keyboard, and a
 * link to the explorer's map, where the same result is published as overlays. OWNER:
 * navigate agent.
 */

import { h } from '../../dom.js';
import { disposer } from '../component.js';
import { angleFormat, type NavCtx } from './context.js';
import { renderCurve, type CurveSpec } from './curve.js';
import { fitOverlays, type OverlayData } from './overlays.js';
import { defaultPlotView, renderPositionPlot, type PlotSpec, type PlotView } from './plot.js';
import { btn, card, para } from './ui.js';

export interface ChartPanel {
  el: HTMLElement;
  showPlot(spec: PlotSpec, overlay?: OverlayData | null): void;
  showCurve(spec: CurveSpec): void;
  showNothing(text: string): void;
  destroy(): void;
}

export function chartPanel(nc: NavCtx, title = 'On the chart'): ChartPanel {
  const d = disposer();
  let view: PlotView = defaultPlotView();
  let plot: PlotSpec | null = null;
  let curve: CurveSpec | null = null;
  let overlay: OverlayData | null = null;

  const zoomIn = btn('', () => zoom(1.6), { icon: 'plus', variant: 'ghost', ariaLabel: 'Zoom in' });
  const zoomOut = btn('', () => zoom(1 / 1.6), { icon: 'minus', variant: 'ghost', ariaLabel: 'Zoom out' });
  const fit = btn('Fit', () => {
    view = defaultPlotView();
    draw();
  }, { variant: 'ghost', tip: 'Frame the result again' });
  const onMap = btn('Show on the map', () => {
    if (overlay) fitOverlays(nc.overlays, overlay);
    nc.ctx.store.patch({ view: 'map' });
  }, { variant: 'outline', icon: 'map', tip: 'The circles, the fix and its ellipse are also drawn on the explorer’s map' });
  const tools = h('div', { class: 'sfn-chart__tools' }, zoomIn, zoomOut, fit, onMap);
  const c = card(title, { class: 'sfn-chart', aside: tools, iconName: 'charts' });
  const stage = h('div', {
    class: 'sfn-chart__stage',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Chart. Arrow keys move it, plus and minus zoom, 0 frames the result again.',
  });
  const legend = h('p', { class: 'sfn-note sfn-muted sfn-chart__legend' });
  c.body.append(stage, legend);

  const size = (): { width: number; height: number } => {
    const width = Math.max(260, stage.clientWidth || 520);
    return { width, height: Math.round(Math.min(520, Math.max(260, width * 0.68))) };
  };

  function draw(): void {
    const format = angleFormat(nc);
    if (plot) {
      stage.replaceChildren(renderPositionPlot(plot, view, size(), format));
      legend.textContent =
        'Grid: latitude and longitude. East-west distances are drawn shortened by cos(latitude) so circles look round near the middle. Each circle of position is dash-dotted and named; the shaded shape is the nominal 95 % ellipse.';
    } else if (curve) {
      stage.replaceChildren(renderCurve(curve, size(), format));
      legend.textContent = 'Each dot is a sight’s observed altitude Ho with its ±1 sigma bar; the line is the engine’s model of the run.';
    }
    const isPlot = plot !== null;
    zoomIn.hidden = zoomOut.hidden = fit.hidden = !isPlot;
    onMap.hidden = !(isPlot && overlay && nc.overlays);
  }

  function zoom(factor: number): void {
    view = { ...view, zoom: Math.min(5000, Math.max(0.05, view.zoom * factor)) };
    draw();
  }

  function pan(dxPx: number, dyPx: number): void {
    const svg = stage.querySelector<SVGSVGElement>('svg.sfn-plot');
    if (!svg || !plot) return;
    const scale = Number(svg.dataset.scale) || 1;
    const scaleLon = Number(svg.dataset.scaleLon) || scale;
    // The drawing is in its own pixels; the element may be scaled by CSS.
    const k = svg.viewBox.baseVal.width / Math.max(svg.getBoundingClientRect().width, 1);
    view = { ...view, offsetLat: view.offsetLat + (dyPx * k) / scale, offsetLon: view.offsetLon - (dxPx * k) / scaleLon };
    draw();
  }

  let dragging: { x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!plot) return;
    dragging = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    dragging = { x: e.clientX, y: e.clientY };
    pan(dx, dy);
  });
  const end = (e: PointerEvent) => {
    dragging = null;
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('keydown', (e) => {
    if (!plot) return;
    const step = 40;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => pan(step, 0),
      ArrowRight: () => pan(-step, 0),
      ArrowUp: () => pan(0, step),
      ArrowDown: () => pan(0, -step),
      '+': () => zoom(1.6),
      '=': () => zoom(1.6),
      '-': () => zoom(1 / 1.6),
      '0': () => {
        view = defaultPlotView();
        draw();
      },
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      action();
    }
  });

  if (typeof ResizeObserver === 'function') {
    let last = 0;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      // Redraw in the next frame, not inside the observer (a redraw changes the height,
      // which would otherwise re-enter the observer in the same frame).
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = stage.clientWidth;
        if (Math.abs(w - last) > 4) {
          last = w;
          draw();
        }
      });
    });
    d.add(() => cancelAnimationFrame(frame));
    ro.observe(stage);
    d.add(() => ro.disconnect());
  }
  d.add(nc.ctx.store.select((s) => s.settings.angleFormat, draw));

  return {
    el: c.el,
    showPlot(spec, data = null) {
      const changed = plot === null || spec.fix?.lat_deg !== plot.fix?.lat_deg || spec.candidates.length !== plot.candidates.length;
      plot = spec;
      curve = null;
      overlay = data;
      if (changed) view = defaultPlotView();
      c.el.hidden = false;
      draw();
    },
    showCurve(spec) {
      curve = spec;
      plot = null;
      overlay = null;
      c.el.hidden = false;
      draw();
    },
    showNothing(text) {
      plot = null;
      curve = null;
      overlay = null;
      stage.replaceChildren(para(text, 'sfn-note sfn-muted sfn-chart__empty'));
      legend.textContent = '';
      zoomIn.hidden = zoomOut.hidden = fit.hidden = onMap.hidden = true;
    },
    destroy() {
      d.dispose();
      c.el.remove();
    },
  };
}
