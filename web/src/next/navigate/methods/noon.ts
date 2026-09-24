/**
 * Noon sight: latitude from a run of altitudes of one body around meridian passage (or
 * one altitude), the time of passage and a weak longitude, with the flat-peak caveat in
 * full (docs/NAVIGATION_METHODS.md section 2). OWNER: navigate agent.
 */

import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import type { NoonSightResult } from '../../engine/types.js';
import { readout } from '../../theme/primitives.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import type { CurveSpec } from '../curve.js';
import { fmtAngle, fmtArcmin, fmtInstant, fmtLatitude, fmtLongitude, fmtNum, fmtSeconds, fmtSigma } from '../format.js';
import { noonWaypoints } from '../gpx.js';
import { noonOptionsFor, noonSession, type NoonForm, type Working } from '../model.js';
import { emptyOverlayData } from '../overlays.js';
import { errorText, facts, field, notice, para, selectInput, warningList } from '../ui.js';
import { autoRun, drLine, drSigmaField, gpxButton, methodFrame, publish, runBodySelect, vesselFields } from './common.js';

const METHOD_TEXT: Record<NoonSightResult['method'], string> = {
  curve_fit: 'the exact curve fitted to the run (curvature predicted)',
  curve_fit_free_curvature: 'a free parabola fitted to the run (curvature fitted)',
  ex_meridian: 'one altitude at its recorded time, reduced to the meridian',
  maximum_altitude: 'one altitude read as the peak',
};

export function runTable(result: { residuals: NoonSightResult['residuals'] }, format: ReturnType<typeof angleFormat>, zeroLabel: string, showLoo = false): HTMLElement {
  const table = h('table', { class: 'sf-table sfn-table' });
  table.appendChild(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['Sight', `Minutes from ${zeroLabel}`, 'Observed · Ho', 'Model', 'Residual', 'Normalised', ...(showLoo ? ['Leave-one-out'] : []), 'Used'].map((t) => h('th', { scope: 'col' }, t)),
      ),
    ),
  );
  const body = h('tbody', {});
  for (const r of result.residuals) {
    body.appendChild(
      h(
        'tr',
        { class: r.outlier ? 'sfn-row--outlier' : undefined },
        h('th', { scope: 'row' }, r.id),
        h('td', {}, fmtNum(r.minutes, 2)),
        h('td', {}, fmtAngle(r.ho_deg, format)),
        h('td', {}, fmtAngle(r.model_deg, format)),
        h('td', {}, fmtArcmin(r.residual_arcmin, 2)),
        h('td', {}, `${fmtNum(r.normalized, 2)} σ`),
        ...(showLoo ? [h('td', {}, r.normalized_loo === null ? '—' : `${fmtNum(r.normalized_loo, 2)} σ`)] : []),
        h('td', {}, r.used ? 'yes' : r.outlier ? 'no — outlier' : 'no'),
      ),
    );
  }
  table.appendChild(body);
  return h('div', { class: 'sfn-table-scroll' }, table);
}

export function noonMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'noon');
  const store = nc.working.store;
  const set = (patch: Partial<NoonForm>): void => store.patch({ noon: { ...store.get().noon, ...patch } });

  const body = runBodySelect(nc, f.track, () => store.get().noon.body, (v) => set({ body: v }), 'Body of the run');
  const bearing = selectInput<NoonForm['bearing']>(
    [
      { value: 'auto', label: 'Decide from the DR (automatic)' },
      { value: 'south', label: 'South of me (I faced south)' },
      { value: 'north', label: 'North of me (I faced north)' },
    ],
    store.get().noon.bearing,
  );
  bearing.addEventListener('change', () => set({ bearing: bearing.value as NoonForm['bearing'] }));
  const curvature = selectInput<NoonForm['curvature']>(
    [
      { value: 'predicted', label: 'Predicted exactly from the almanac (recommended)' },
      { value: 'fitted', label: 'Fitted freely to the sights (3 or more)' },
    ],
    store.get().noon.curvature,
  );
  curvature.addEventListener('change', () => set({ curvature: curvature.value as NoonForm['curvature'] }));
  const single = selectInput<NoonForm['single']>(
    [
      { value: 'maximum', label: 'The highest reading I saw (the peak)' },
      { value: 'ex_meridian', label: 'A reading at the time I wrote down' },
    ],
    store.get().noon.single,
  );
  single.addEventListener('change', () => set({ single: single.value as NoonForm['single'] }));
  const drSigma = drSigmaField(() => store.get().noon.drSigmaNm, (v) => set({ drSigmaNm: v }));
  const vessel = vesselFields(() => store.get().noon.vessel, (v) => set({ vessel: v }));
  f.inputs.append(
    h('div', { class: 'sfn-grid-2' }, body.el, field('Where it crossed your meridian', bearing, { help: 'The body’s bearing at noon: south of you in the northern mid-latitudes, north in the southern.' }).el),
    drLine(nc, f.track),
    h('div', { class: 'sfn-grid-2' }, drSigma.el, field('Shape of the curve', curvature, { term: 'curvature' }).el),
    field('With one sight, it is', single, { term: 'single altitude', help: 'Only matters when the run has one sight.' }).el,
    vessel.el,
  );

  f.track(
    autoRun(nc, (w: Working) => [w.session, w.mode, w.noon] as const, async (isCurrent) => {
      const w = store.get();
      for (const x of [drSigma, ...vessel.fields]) x.refresh();
      const session = noonSession(w);
      if (!nc.nav) {
        f.setStatus({ missing: nc.navMissing ?? 'No navigation tools.' });
        return;
      }
      if (session.observations.length === 0) {
        f.setStatus({ missing: 'Enter a run of sights of one body around its highest point: the Sun around local noon, every minute or two for a quarter of an hour either side.' });
        f.results.replaceChildren();
        f.details.replaceChildren();
        f.chart.showNothing('The run of sights and the curve through them will be drawn here.');
        publish(nc, null);
        return;
      }
      f.setStatus('busy');
      let r: NoonSightResult;
      try {
        r = nc.nav.noonSight(session, noonOptionsFor(w), w.mode);
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
      const z = zone(nc);
      const lat = r.latitude;
      const lon = r.longitude;
      const passage = r.meridian_passage;
      f.results.replaceChildren(
        h(
          'div',
          { class: 'sf-readouts sfn-readouts' },
          readout({ value: fmtLatitude(lat.lat_deg, format), label: `Latitude ${fmtSigma(lat.sigma_arcmin)} (1 sigma)`, term: 'from how HIGH the peak was: strong' }),
          lon
            ? readout({ value: fmtLongitude(lon.lon_deg, format), label: `Longitude ${fmtSigma(lon.sigma_arcmin, 1)} of longitude, ${fmtNum(lon.sigma_nm, 1)} NM`, term: 'from WHEN the peak came: weak' })
            : readout({ value: '—', label: 'No longitude', term: 'one altitude cannot time the peak' }),
        ),
        notice('caution', h('strong', {}, 'About the longitude. '), r.longitude_caveat),
        para(r.latitude_rule, 'sfn-plain'),
        gpxButton(nc, noonWaypoints(r, { sessionName: w.session.meta.name, sessionKind: w.session.meta.kind, time: passage?.utc ?? null, sights: r.n_sights }), 'noon'),
      );
      f.details.replaceChildren(
        facts([
          ['Method', `${METHOD_TEXT[r.method]}, ${r.n_sights} sight${r.n_sights === 1 ? '' : 's'} of the ${r.body}`],
          ['Meridian altitude', `${fmtAngle(r.meridian_altitude_deg, format)} (zenith distance ${fmtAngle(r.zenith_distance_deg, format)})`],
          ['Declination at passage', fmtAngle(r.declination_deg, format)],
          passage ? ['Meridian passage', `${fmtInstant(passage.jd_utc, z)} ± ${fmtSeconds(passage.sigma_s)}`] : null,
          r.maximum ? ['The peak itself', `${fmtInstant(r.maximum.jd_utc, z)} at ${fmtAngle(r.maximum.altitude_deg, format)}, ${fmtSeconds(Math.abs(r.maximum.seconds_after_passage))} ${r.maximum.seconds_after_passage < 0 ? 'before' : 'after'} passage`] : null,
          r.longitude_sensitivity_arcmin_per_nm !== null ? ['Depends on the DR longitude', `${fmtNum(r.longitude_sensitivity_arcmin_per_nm, 3)}′ of latitude per NM east-west`] : null,
          ['Curvature', `predicted ${fmtNum(r.curvature.predicted_arcmin_per_min2, 4)}′/min²` + (r.curvature.fitted_arcmin_per_min2 !== null ? `, fitted ${fmtNum(r.curvature.fitted_arcmin_per_min2, 4)} ± ${fmtNum(r.curvature.fitted_sigma_arcmin_per_min2, 4)} (z = ${fmtNum(r.curvature.z, 1)}, ${r.curvature.consistent ? 'consistent' : 'NOT consistent'})` : '')],
          ['Peak above the meridian altitude', `${fmtArcmin(r.curvature.max_minus_meridian_arcmin, 3)} (rate at passage ${fmtNum(r.curvature.rate_at_passage_arcmin_per_min, 4)}′/min)`],
          r.alternative
            ? ['The other computation', `${METHOD_TEXT[r.alternative.method]}: latitude ${fmtLatitude(r.alternative.latitude.lat_deg, format)} ${fmtSigma(r.alternative.latitude.sigma_arcmin)}` + (r.alternative.longitude ? `, longitude ${fmtLongitude(r.alternative.longitude.lon_deg, format)} ${fmtSigma(r.alternative.longitude.sigma_arcmin, 1)}` : '')]
            : null,
          ['Against the DR', `noon predicted at ${fmtInstant(r.dr_check.predicted_passage_jd_utc, z)}${r.dr_check.predicted_passage_sigma_s !== null ? ` ± ${fmtSeconds(r.dr_check.predicted_passage_sigma_s)}` : ''}; the latitude is ${fmtArcmin(r.dr_check.latitude_difference_arcmin, 1)} from the DR${r.dr_check.longitude_difference_arcmin !== null ? `, the longitude ${fmtArcmin(r.dr_check.longitude_difference_arcmin, 1)}` : ''}`],
          ['Fit', `chi-square ${fmtNum(r.chi2, 2)} with ${r.dof} degree${r.dof === 1 ? '' : 's'} of freedom`],
        ]),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'The run, sight by sight'), runTable(r, format, 'meridian passage')),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Warnings'), warningList(r.warnings, 'No warnings.')),
      );
      const curve: CurveSpec = {
        body: r.body,
        zeroLabel: 'meridian passage',
        points: r.residuals.map((x) => ({ minutes: x.minutes, altitude_deg: x.ho_deg, sigma_arcmin: r.sights.find((s) => s.id === x.id)?.sigma_arcmin ?? 1, used: x.used, label: x.id })),
        model: r.model_curve.map((p) => ({ minutes: p.minutes, altitude_deg: p.altitude_deg })),
        marks: passage ? [{ minutes: 0, label: 'meridian passage' }] : [],
        levels: [{ altitude_deg: r.meridian_altitude_deg, label: `meridian altitude ${fmtAngle(r.meridian_altitude_deg, format)}` }],
        result: null,
      };
      f.chart.showCurve(curve);
      // The map gets the latitude line and, with a longitude, the noon position.
      const overlay = emptyOverlayData();
      overlay.parallels.push({ lat_deg: lat.lat_deg, label: `Noon latitude ${fmtLatitude(lat.lat_deg, 'dm')}`, body: r.body });
      if (lon) {
        overlay.fix = { lat_deg: lat.lat_deg, lon_deg: lon.lon_deg };
        overlay.fixLabel = 'Noon position (weak longitude)';
      }
      publish(nc, overlay);
    }),
  );
  return { destroy: () => f.destroy() };
}
