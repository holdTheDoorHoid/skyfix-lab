/**
 * The Fix: every sight not left out, solved by the core's weighted least squares with the
 * old workbench's options, reported with its result kind, uncertainty, residuals,
 * geometry and warnings, drawn on the chart and published on the map. OWNER: navigate agent.
 */

import { h } from '../../../dom.js';
import type { CircleOfPosition, FixResult, LatLon, Session } from '../../../types.js';
import type { Mounted } from '../../component.js';
import { angleFormat, kindOf, type NavCtx } from '../context.js';
import { fixWaypoints } from '../gpx.js';
import { fixSession, solveOptionsFor, type Working } from '../model.js';
import { emptyOverlayData, type OverlayData } from '../overlays.js';
import { emptyPlotSpec, type PlotSpec } from '../plot.js';
import { conditioningBlock, fixSummary, residualChart, residualTable, warningsBlock } from '../results.js';
import { btn, errorText, para } from '../ui.js';
import { openFixPrintables } from '../print/open.js';
import { autoRun, gpxButton, methodFrame, publish, solveOptionsForm } from './common.js';

/** Plot and map data for any fix result (the Fix and the Running fix share it). */
export async function fixPictures(
  nc: NavCtx,
  result: FixResult,
  session: Session,
  fixLabel: string,
): Promise<{ plot: PlotSpec; overlay: OverlayData }> {
  const circles: CircleOfPosition[] = result.kind === 'failed' ? [] : result.circles;
  const points = await Promise.all(circles.map((c) => nc.api.circlePoints(c.gp.lat_deg, c.gp.lon_deg, c.zenith_distance_deg, 720)));
  const plot = emptyPlotSpec();
  const overlay = emptyOverlayData();
  plot.fixLabel = fixLabel;
  overlay.fixLabel = fixLabel;
  circles.forEach((c, i) => {
    const kind = kindOf(nc, c.body);
    plot.circles.push({ id: c.id, body: c.body, kind, points: points[i]!.map(([lat_deg, lon_deg]) => ({ lat_deg, lon_deg })) });
    overlay.circles.push({ id: c.id, body: c.body, kind, gp: c.gp, zenith_distance_deg: c.zenith_distance_deg });
  });
  if (result.kind === 'unique') {
    plot.fix = result.fix.position;
    overlay.fix = result.fix.position;
    if (result.fix.ellipse95) {
      plot.ellipse = { centre: result.fix.position, ellipse: result.fix.ellipse95 };
      overlay.ellipse = { centre: result.fix.position, ...result.fix.ellipse95 };
    }
    plot.alternatives = result.alternatives.map((a) => ({ position: a.position, delta_chi2: a.delta_chi2_from_best }));
    overlay.alternatives = plot.alternatives;
  } else if (result.kind === 'ambiguous') {
    plot.candidates = result.candidates.map((c) => c.position);
    overlay.candidates = plot.candidates;
  }
  const role = session.observer.assumed_position_role;
  const ap: LatLon | null = session.observer.assumed_position;
  if (ap && role.role !== 'disabled') {
    plot.assumed = { position: ap, role: role.role === 'prior' ? `assumed position (prior, ${role.sigma_nm} NM)` : 'assumed position (starting point)' };
  }
  return { plot, overlay };
}

/** Sigmas of the sights, from the live reductions (for the residual bands). */
export function sightSigmas(nc: NavCtx): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, e] of nc.reductions.get().byId) if (e.status === 'ok') out.set(id, e.sight.sigma_arcmin);
  return out;
}

/** The residuals, geometry and warnings sections of a fix result. */
export function fixDetails(nc: NavCtx, result: FixResult): HTMLElement[] {
  const format = angleFormat(nc);
  const out: HTMLElement[] = [];
  if (result.kind === 'unique') {
    out.push(
      h(
        'section',
        { class: 'sfn-sub sfn-sub--first' },
        h('h3', {}, 'How well each sight fits ', h('span', { class: 'sfn-term' }, '· residuals')),
        para('Observed minus computed altitude at the fix. The shaded band is that sight’s own ±1 sigma; beyond 3 sigma a sight is marked as an outlier.', 'sfn-note'),
        h('div', { class: 'sfn-figure' }, residualChart(result.fix.residuals, sightSigmas(nc))),
        residualTable(result.fix.residuals, format),
      ),
      h('section', { class: 'sfn-sub' }, h('h3', {}, 'The geometry ', h('span', { class: 'sfn-term' }, '· conditioning')), conditioningBlock(result.fix.conditioning)),
    );
  }
  out.push(h('section', { class: `sfn-sub${out.length ? '' : ' sfn-sub--first'}` }, h('h3', {}, 'Warnings'), warningsBlock(result)));
  return out;
}

export function lastTime(session: Session): string | null {
  const times = session.observations.map((o) => o.utc).filter(Boolean).sort();
  return times.at(-1) ?? null;
}

export function fixMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'fix');
  const used = para('', 'sfn-note');
  f.inputs.append(used, solveOptionsForm(nc, f.track));

  const deps = (w: Working) => [w.session, w.excluded, w.mode, w.solve] as const;
  f.track(
    autoRun(nc, deps, async (isCurrent) => {
      const w = nc.working.store.get();
      const session = fixSession(w);
      const n = session.observations.length;
      const left = w.session.observations.length - n;
      used.textContent = `Using ${n} sight${n === 1 ? '' : 's'}${left ? ` (${left} left out: tick “use in fix” to bring ${left === 1 ? 'it' : 'them'} back)` : ''}.`;
      if (n === 0) {
        f.setStatus({ missing: 'Add sights of two or more bodies in different directions. One sight gives a circle, not a point.' });
        f.results.replaceChildren();
        f.details.replaceChildren();
        f.chart.showNothing('The circles of position and the fix will be drawn here.');
        publish(nc, null);
        return;
      }
      f.setStatus('busy');
      const options = solveOptionsFor(w);
      let result: FixResult;
      try {
        result = await nc.api.solve(session, options, w.mode);
      } catch (error) {
        if (!isCurrent()) return;
        f.setStatus({ error: errorText(error) });
        f.results.replaceChildren();
        f.details.replaceChildren();
        f.chart.showNothing('No result to draw.');
        publish(nc, null);
        return;
      }
      if (!isCurrent()) return;
      const pictures = await fixPictures(nc, result, session, 'Fix');
      if (!isCurrent()) return;
      f.setStatus('idle');
      const count = result.kind === 'unique' ? result.fix.residuals.length : result.kind === 'failed' ? 0 : result.circles.length;
      // navigate2: the plotting sheet and a worksheet per sight, print-clean (print/).
      const printButton = btn('Print worksheets and plotting sheet', () => openFixPrintables(nc, session, result), {
        variant: 'outline',
        icon: 'list',
        tip: 'Each sight worked in the six classic steps, and the lines of position on a universal plotting sheet centred on the DR',
      });
      printButton.disabled = !session.observer.assumed_position;
      f.results.replaceChildren(
        fixSummary(result, angleFormat(nc)),
        gpxButton(nc, fixWaypoints(result, { sessionName: w.session.meta.name, sessionKind: w.session.meta.kind, time: lastTime(session), sights: count }), 'fix'),
        h('div', { class: 'sfn-export' }, printButton, h('span', { class: 'sfn-note sfn-muted' }, session.observer.assumed_position ? ' Black on white, one sheet to a page.' : ' The plotting sheet needs an assumed position (DR).')),
      );
      f.details.replaceChildren(...fixDetails(nc, result));
      if (result.kind === 'failed') f.chart.showNothing('The solve failed: there is no position to draw.');
      else f.chart.showPlot(pictures.plot, pictures.overlay);
      // The fit map maps exactly this solve (misfit/README: the same session, mode and options).
      f.chart.setMisfitInput(result.kind === 'failed' ? null : { session, mode: w.mode, options });
      publish(nc, result.kind === 'failed' ? null : pictures.overlay);
    }),
  );
  return { destroy: () => f.destroy() };
}
