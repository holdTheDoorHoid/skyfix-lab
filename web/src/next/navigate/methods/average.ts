/**
 * Averaging a run of sights of one body: the predicted shape at the DR, one fitted level,
 * a leave-one-out outlier test, the free-slope check, and the averaged sight, which can be
 * added to the sights for a fix (docs/NAVIGATION_METHODS.md section 4). OWNER: navigate
 * agent.
 */

import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import type { AveragedSight } from '../../engine/types.js';
import { readout } from '../../theme/primitives.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import type { CurveSpec } from '../curve.js';
import { fmtAngle, fmtInstant, fmtNum, fmtSigma } from '../format.js';
import { averageOptionsFor, averageSession, nextObservationId, withObservation, type AverageForm, type Working } from '../model.js';
import { btn, checkbox, errorText, facts, para, warningList } from '../ui.js';
import { autoRun, drLine, drSigmaField, methodFrame, numberField, optionalUtcField, publish, runBodySelect, vesselFields } from './common.js';
import { runTable } from './noon.js';

export function averageMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'average');
  const store = nc.working.store;
  const set = (patch: Partial<AverageForm>): void => store.patch({ average: { ...store.get().average, ...patch } });
  const body = runBodySelect(nc, f.track, () => store.get().average.body, (v) => set({ body: v }), 'Body of the run');
  const reference = optionalUtcField(nc, 'Average for the moment (UTC)', 'the middle of the run, where the average is best', () => store.get().average.referenceUtc, (v) => set({ referenceUtc: v }));
  const drSigma = drSigmaField(() => store.get().average.drSigmaNm, (v) => set({ drSigmaNm: v }));
  const vessel = vesselFields(() => store.get().average.vessel, (v) => set({ vessel: v }));
  const reject = checkbox('Leave out a sight that does not fit', store.get().average.rejectOutliers, (v) => set({ rejectOutliers: v }), 'One at a time, worst first, while three or more remain.');
  const threshold = numberField('Outlier threshold (sigma)', { min: 1, max: 10 }, () => store.get().average.threshold, (v) => set({ threshold: v }));
  f.inputs.append(
    h('div', { class: 'sfn-grid-2' }, body.el, reference.el),
    drLine(nc, f.track),
    h('div', { class: 'sfn-grid-2' }, drSigma.el, threshold.el),
    reject.el,
    vessel.el,
  );

  f.track(
    autoRun(nc, (w: Working) => [w.session, w.mode, w.average] as const, async (isCurrent) => {
      const w = store.get();
      for (const x of [reference, drSigma, threshold, ...vessel.fields]) x.refresh();
      reject.input.checked = w.average.rejectOutliers;
      if (!nc.nav) {
        f.setStatus({ missing: nc.navMissing ?? 'No navigation tools.' });
        return;
      }
      const session = averageSession(w);
      if (session.observations.length === 0) {
        f.setStatus({ missing: 'Enter several sights of one body taken over a few minutes.' });
        f.results.replaceChildren();
        f.details.replaceChildren();
        f.chart.showNothing('The run and the line through it will be drawn here.');
        publish(nc, null);
        return;
      }
      f.setStatus('busy');
      let r: AveragedSight;
      try {
        r = nc.nav.averageSights(session, averageOptionsFor(w), w.mode);
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
      f.setStatus('idle');
      const format = angleFormat(nc);
      const z = zone(nc, r.jd_utc);
      const add = btn('Add this averaged sight to my sights', () => {
        const now = store.get();
        const obs = { ...r.observation };
        if (now.session.observations.some((o) => o.id === obs.id)) obs.id = nextObservationId(now.session);
        const runIds = r.residuals.map((x) => x.id);
        store.patch({
          session: withObservation(now.session, obs),
          excluded: [...new Set([...now.excluded, ...runIds])],
          method: 'fix',
        });
        nc.say(`Added ${obs.id}, the average of ${r.n_used} ${r.body} sights. Those ${r.n_total} sights are now left out of the fix, so they are not counted twice; tick them to use them again.`);
      }, { variant: 'primary', icon: 'plus' });
      f.results.replaceChildren(
        h(
          'div',
          { class: 'sf-readouts sfn-readouts' },
          readout({ value: fmtAngle(r.ho_deg, format), label: `Averaged altitude ${fmtSigma(r.sigma_arcmin)} (1 sigma)`, term: `Ho of the ${r.body} at ${fmtInstant(r.jd_utc, z)}` }),
        ),
        h('div', { class: 'sfn-export' }, add, para(' It is fully corrected (observed_ho), so no correction runs on it again.', 'sfn-note sfn-muted')),
        facts([
          ['Sights used', `${r.n_used} of ${r.n_total}${r.outliers.length ? `; left out: ${r.outliers.join(', ')}` : ''}`],
          ['Predicted slope', `${fmtNum(r.predicted_slope_arcmin_per_min, 3)}′ per minute${r.predicted_slope_sigma_arcmin_per_min !== null ? ` ± ${fmtNum(r.predicted_slope_sigma_arcmin_per_min, 3)}` : ' (its uncertainty needs the DR’s)'}; curvature ${fmtNum(r.predicted_curvature_arcmin_per_min2, 4)}′/min²`],
          r.free_slope
            ? ['Slope fitted freely', `${fmtNum(r.free_slope.slope_arcmin_per_min, 3)} ± ${fmtNum(r.free_slope.slope_sigma_arcmin_per_min, 3)}′ per minute (z = ${fmtNum(r.free_slope.z, 1)}: ${r.free_slope.consistent ? 'consistent with the prediction' : 'NOT consistent: check the times, the body, the DR, course and speed'}); its average ${fmtAngle(r.free_slope.ho_deg, format)} ${fmtSigma(r.free_slope.sigma_arcmin)}`]
            : ['Slope fitted freely', 'needs four or more sights in use'],
          ['Fit', `chi-square ${fmtNum(r.chi2, 2)} with ${r.dof} degree${r.dof === 1 ? '' : 's'} of freedom`],
        ]),
      );
      f.details.replaceChildren(
        h('section', { class: 'sfn-sub sfn-sub--first' }, h('h3', {}, 'The run, sight by sight'), runTable(r, format, 'the averaged time', true)),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Warnings'), warningList(r.warnings, 'No warnings.')),
      );
      const curve: CurveSpec = {
        body: r.body,
        zeroLabel: 'the averaged sight’s time',
        points: r.residuals.map((x) => ({ minutes: x.minutes, altitude_deg: x.ho_deg, sigma_arcmin: r.sights.find((s) => s.id === x.id)?.sigma_arcmin ?? 1, used: x.used, label: x.id })),
        model: r.model_curve.map((p) => ({ minutes: p.minutes, altitude_deg: p.altitude_deg })),
        marks: [],
        levels: [],
        result: { minutes: 0, altitude_deg: r.ho_deg, sigma_arcmin: r.sigma_arcmin, label: `average ${fmtAngle(r.ho_deg, format)}` },
      };
      f.chart.showCurve(curve);
      publish(nc, null);
    }),
  );
  return { destroy: () => f.destroy() };
}
