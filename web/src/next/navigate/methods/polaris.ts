/**
 * Latitude by Polaris: the rigorous latitude on the DR meridian with its three sigma terms,
 * and the Nautical Almanac's a0, a1, a2 beside it for teaching (docs/NAVIGATION_METHODS.md
 * section 3). OWNER: navigate agent.
 */

import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import type { PolarisResult } from '../../engine/types.js';
import { readout } from '../../theme/primitives.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import { fmtAngle, fmtArcmin, fmtBearing, fmtInstant, fmtLatitude, fmtNum, fmtSigma } from '../format.js';
import { polarisOptionsFor, polarisSession, type PolarisForm, type Working } from '../model.js';
import { emptyOverlayData } from '../overlays.js';
import { emptyPlotSpec } from '../plot.js';
import { errorText, facts, para, warningList } from '../ui.js';
import { autoRun, drLine, drSigmaField, methodFrame, optionalUtcField, publish, vesselFields } from './common.js';

function almanacTable(r: PolarisResult, format: ReturnType<typeof angleFormat>): HTMLElement {
  const table = h('table', { class: 'sf-table sfn-table' });
  table.appendChild(h('thead', {}, h('tr', {}, ...['Sight', 'LHA Aries', 'a0', 'a1', 'a2', 'Ho − 1° + a0 + a1 + a2', 'Minus the rigorous answer', 'In the printed table'].map((t) => h('th', { scope: 'col' }, t)))));
  const body = h('tbody', {});
  for (const p of r.polaris) {
    const a = p.almanac;
    body.appendChild(
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, p.id),
        ...(a
          ? [
              h('td', {}, fmtAngle(a.lha_aries_deg, format)),
              h('td', {}, `${fmtNum(a.a0_arcmin, 2)}′`),
              h('td', {}, `${fmtNum(a.a1_arcmin, 2)}′`),
              h('td', {}, `${fmtNum(a.a2_arcmin, 2)}′`),
              h('td', {}, fmtLatitude(a.latitude_deg, format)),
              h('td', {}, fmtArcmin(a.difference_arcmin, 3)),
              h('td', {}, a.within_printed_table ? 'yes' : 'no: use the rigorous latitude'),
            ]
          : [h('td', { colspan: '7' } as never, 'No table terms for this sight.')]),
      ),
    );
  }
  table.appendChild(body);
  return h('div', { class: 'sfn-table-scroll' }, table);
}

export function polarisMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'polaris');
  const store = nc.working.store;
  const set = (patch: Partial<PolarisForm>): void => store.patch({ polaris: { ...store.get().polaris, ...patch } });
  const drSigma = drSigmaField(() => store.get().polaris.drSigmaNm, (v) => set({ drSigmaNm: v }));
  const vessel = vesselFields(() => store.get().polaris.vessel, (v) => set({ vessel: v }));
  const reference = optionalUtcField(nc, 'Latitude for the moment (UTC)', 'the time of the last Polaris sight', () => store.get().polaris.referenceUtc, (v) => set({ referenceUtc: v }));
  f.inputs.append(
    drLine(nc, f.track),
    para('Polaris sights only: the DR’s LONGITUDE matters here, because it sets where Polaris is in its small circle round the pole.', 'sfn-note'),
    h('div', { class: 'sfn-grid-2' }, drSigma.el, reference.el),
    vessel.el,
  );

  f.track(
    autoRun(nc, (w: Working) => [w.session, w.mode, w.polaris] as const, async (isCurrent) => {
      const w = store.get();
      for (const x of [drSigma, reference, ...vessel.fields]) x.refresh();
      if (!nc.nav) {
        f.setStatus({ missing: nc.navMissing ?? 'No navigation tools.' });
        return;
      }
      const session = polarisSession(w);
      if (session.observations.length === 0) {
        f.setStatus({ missing: 'Enter one or more sights of Polaris (choose it in the body list; it is with the stars).' });
        f.results.replaceChildren();
        f.details.replaceChildren();
        f.chart.showNothing('Your latitude line will be drawn here.');
        publish(nc, null);
        return;
      }
      f.setStatus('busy');
      let r: PolarisResult;
      try {
        r = nc.nav.polarisLatitude(session, polarisOptionsFor(w), w.mode);
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
      const perSight = h('table', { class: 'sf-table sfn-table' });
      perSight.appendChild(
        h('thead', {}, h('tr', {}, ...['Sight', 'Time', 'Observed · Ho', 'Bearing · Zn', 'Latitude', 'From the altitude', 'From the DR longitude', 'From the clock', 'Ho to latitude'].map((t) => h('th', { scope: 'col' }, t)))),
      );
      const tb = h('tbody', {});
      for (const p of r.polaris) {
        tb.appendChild(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, p.id),
            h('td', {}, fmtInstant(p.jd_utc, z)),
            h('td', {}, fmtAngle(p.ho_deg, format)),
            h('td', {}, fmtBearing(p.azimuth_deg)),
            h('td', {}, `${fmtLatitude(p.latitude.lat_deg, format)} ${fmtSigma(p.latitude.sigma_arcmin)}`),
            h('td', {}, fmtSigma(p.sigma_from_altitude_arcmin)),
            h('td', {}, p.sigma_from_longitude_arcmin === null ? 'not stated' : fmtSigma(p.sigma_from_longitude_arcmin)),
            h('td', {}, fmtSigma(p.sigma_from_clock_arcmin)),
            h('td', {}, fmtArcmin(p.correction_arcmin, 2)),
          ),
        );
      }
      perSight.appendChild(tb);
      f.results.replaceChildren(
        h(
          'div',
          { class: 'sf-readouts sfn-readouts' },
          readout({ value: fmtLatitude(r.latitude.lat_deg, format), label: `Latitude ${fmtSigma(r.latitude.sigma_arcmin)} (1 sigma)`, term: `at ${fmtInstant(r.reference_jd_utc, z)}` }),
        ),
        facts([
          ['Sights combined', `${r.polaris.length}${r.chi2 !== null ? `, chi-square ${fmtNum(r.chi2, 2)} with ${r.dof} degree${r.dof === 1 ? '' : 's'} of freedom` : ''}`],
          ['Polaris’ bearing', r.polaris.map((p) => fmtBearing(p.azimuth_deg)).join(', ')],
          ['A 1 NM error in the DR longitude moves the latitude', `${fmtNum(r.polaris[0]?.longitude_sensitivity_arcmin_per_nm ?? 0, 3)}′`],
        ]),
      );
      f.details.replaceChildren(
        h('section', { class: 'sfn-sub sfn-sub--first' }, h('h3', {}, 'Sight by sight'), h('div', { class: 'sfn-table-scroll' }, perSight)),
        h(
          'section',
          { class: 'sfn-sub' },
          h('h3', {}, 'The Nautical Almanac’s way ', h('span', { class: 'sfn-term' }, '· a0, a1, a2, unrounded')),
          para('Latitude = Ho − 1° + a0 + a1 + a2, from the Almanac’s Polaris table. Shown for teaching: the answer above is always the rigorous one.', 'sfn-note'),
          almanacTable(r, format),
          ...r.polaris.slice(0, 1).map((p) => (p.almanac ? para(p.almanac.note, 'sfn-note sfn-muted') : null)).filter((x): x is HTMLElement => x !== null),
        ),
        h('section', { class: 'sfn-sub' }, h('h3', {}, 'Warnings'), warningList(r.warnings, 'No warnings.')),
      );
      const ap = w.session.observer.assumed_position;
      const plot = emptyPlotSpec();
      plot.parallels.push({ lat_deg: r.latitude.lat_deg, sigma_arcmin: r.latitude.sigma_arcmin, label: `Latitude by Polaris ${fmtLatitude(r.latitude.lat_deg, format)}`, body: 'Polaris' });
      if (ap) plot.assumed = { position: ap, role: 'DR (assumed position)' };
      const overlay = emptyOverlayData();
      overlay.parallels.push({ lat_deg: r.latitude.lat_deg, label: `Latitude by Polaris ${fmtLatitude(r.latitude.lat_deg, 'dm')}`, body: 'Polaris' });
      if (ap) overlay.focus = { lat_deg: r.latitude.lat_deg, lon_deg: ap.lon_deg };
      f.chart.showPlot(plot, overlay);
      publish(nc, overlay);
    }),
  );
  return { destroy: () => f.destroy() };
}
