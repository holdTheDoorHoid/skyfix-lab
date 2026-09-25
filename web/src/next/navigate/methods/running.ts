/**
 * Running fix: the sights advanced along the dead-reckoning legs to one instant and
 * solved (skyfix-motion, docs/MOTION.md), reported exactly as a fix is, with each sight's
 * sigma inflation by the run's uncertainty. OWNER: navigate agent.
 */

import { h } from '../../../dom.js';
import type { Mounted } from '../../component.js';
import type { RunningFixOutput } from '../../engine/types.js';
import { jdFromIso } from '../../time.js';
import { scaleLabel } from '../../time/scale.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import { fmtBearing, fmtInstant, fmtNm, fmtNum, fmtSigma, utcInputText, utcTimeText } from '../format.js';
import { fixWaypoints } from '../gpx.js';
import { fixSession, runningRequestFor, type LegForm, type RunningForm, type Working } from '../model.js';
import { parseNumber, parseUtcInput } from '../parse.js';
import { fixSummary } from '../results.js';
import { btn, errorText, facts, field, para, textInput } from '../ui.js';
import { autoRun, gpxButton, methodFrame, numberField, optionalUtcField, publish, solveOptionsForm } from './common.js';
import { fixDetails, fixPictures } from './fix.js';

export function runningMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'running');
  const store = nc.working.store;
  const set = (patch: Partial<RunningForm>): void => store.patch({ running: { ...store.get().running, ...patch } });

  // --- Legs ----------------------------------------------------------------------------------
  const legsBox = h('div', { class: 'sfn-legs' });
  const renderLegs = (): void => {
    const legs = store.get().running.legs;
    const setLeg = (i: number, patch: Partial<LegForm>): void => set({ legs: store.get().running.legs.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
    legsBox.replaceChildren(
      h('h4', {}, 'The vessel’s run ', h('span', { class: 'sfn-term' }, '· dead-reckoning legs')),
      ...legs.map((leg, i) => {
        const start = textInput({ value: leg.start_utc ? utcInputText(leg.start_utc) : '', placeholder: i === 0 ? 'at the first sight' : 'yyyy-mm-dd hh:mm:ss', size: 19 });
        const course = textInput({ value: String(leg.course_deg), inputmode: 'decimal', size: 5 });
        const speed = textInput({ value: String(leg.speed_kn), inputmode: 'decimal', size: 5 });
        // The clock's word of the leg's time, or of the time bar's (UT outside 1972-2035; polish2).
        const word = scaleLabel((leg.start_utc ? jdFromIso(leg.start_utc) : null) ?? nc.ctx.store.get().time.jd_utc);
        const fs = field(`Leg ${i + 1} starts (${word})`, start, { help: i === 0 ? 'Empty: at the first sight.' : null });
        const fc = field('Course (° true)', course);
        const fv = field('Speed (knots)', speed);
        start.addEventListener('change', () => {
          if (i === 0 && !start.value.trim()) {
            fs.setError(null);
            return setLeg(i, { start_utc: null });
          }
          const r = parseUtcInput(start.value);
          fs.setError(r.ok ? null : r.error);
          if (r.ok) setLeg(i, { start_utc: r.value });
        });
        course.addEventListener('change', () => {
          const r = parseNumber(course.value, { what: 'The course', min: 0, max: 360, unit: '°' });
          fc.setError(r.ok ? null : r.error);
          if (r.ok) setLeg(i, { course_deg: r.value });
        });
        speed.addEventListener('change', () => {
          const r = parseNumber(speed.value, { what: 'The speed', min: 0, max: 60, unit: 'kn' });
          fv.setError(r.ok ? null : r.error);
          if (r.ok) setLeg(i, { speed_kn: r.value });
        });
        const remove = i > 0 ? btn('', () => set({ legs: store.get().running.legs.filter((_, k) => k !== i) }), { icon: 'close', variant: 'ghost', ariaLabel: `Remove leg ${i + 1}` }) : null;
        return h('div', { class: 'sfn-leg' }, fs.el, fc.el, fv.el, remove);
      }),
      btn('Add a leg (a change of course or speed)', () => {
        const last = store.get().running.legs.at(-1)!;
        const times = store.get().session.observations.map((o) => o.utc).sort();
        set({ legs: [...store.get().running.legs, { start_utc: times.at(-1) ?? null, course_deg: last.course_deg, speed_kn: last.speed_kn }] });
      }, { icon: 'plus', variant: 'outline' }),
    );
  };
  f.track(store.select((w) => w.running.legs, renderLegs));
  renderLegs();

  const reference = optionalUtcField(nc, 'Fix for the moment (UTC)', 'the time of the last sight', () => store.get().running.referenceUtc, (v) => set({ referenceUtc: v }));
  const end = optionalUtcField(nc, 'The run ends (UTC)', 'it goes on past the last sight', () => store.get().running.endUtc, (v) => set({ endUtc: v }));
  const speedSigma = numberField('Speed uncertainty (knots, 1 sigma)', { min: 0 }, () => store.get().running.speedSigmaKn, (v) => set({ speedSigmaKn: v }));
  const courseSigma = numberField('Course uncertainty (°, 1 sigma)', { min: 0 }, () => store.get().running.courseSigmaDeg, (v) => set({ courseSigmaDeg: v }));
  const walk = numberField('Random drift (NM per √hour)', { min: 0 }, () => store.get().running.walkNmPerSqrtHour, (v) => set({ walkNmPerSqrtHour: v }));
  f.inputs.append(
    legsBox,
    h('div', { class: 'sfn-grid-2' }, reference.el, end.el),
    h(
      'fieldset',
      { class: 'sfn-group' },
      h('legend', {}, 'How well you know the run'),
      para('All zero means “not stated”: the run is then taken as exact, and the result says so rather than inventing a value.', 'sfn-note sfn-muted'),
      h('div', { class: 'sfn-grid-3' }, speedSigma.el, courseSigma.el, walk.el),
    ),
    solveOptionsForm(nc, f.track),
  );

  f.track(
    autoRun(nc, (w: Working) => [w.session, w.excluded, w.mode, w.solve, w.running] as const, async (isCurrent) => {
      const w = store.get();
      for (const x of [reference, end, speedSigma, courseSigma, walk]) x.refresh();
      if (!nc.nav) {
        f.setStatus({ missing: nc.navMissing ?? 'No navigation tools.' });
        return;
      }
      const session = fixSession(w);
      if (session.observations.length === 0) {
        f.setStatus({ missing: 'Enter sights taken at different times while under way, and the course and speed between them.' });
        f.results.replaceChildren();
        f.details.replaceChildren();
        f.chart.showNothing('The advanced circles of position and the running fix will be drawn here.');
        publish(nc, null);
        return;
      }
      f.setStatus('busy');
      let out: RunningFixOutput;
      try {
        out = nc.nav.runningFix(session, runningRequestFor(w), w.mode);
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
      const z = zone(nc, jdFromIso(out.reference_utc));
      const pictures = await fixPictures(nc, out.result, session, 'Running fix');
      // The clock to the minute with its word (UT outside 1972-2035: time-ui `scaleLabel`).
      const ref = utcTimeText(out.reference_utc).split(' ');
      pictures.overlay.fixLabel = `Running fix, ${ref[0]!.slice(0, 5)} ${ref[1] ?? 'UTC'}`;
      if (!isCurrent()) return;
      f.setStatus('idle');
      const result = out.result;
      const count = result.kind === 'unique' ? result.fix.residuals.length : session.observations.length;
      const inflation = h('table', { class: 'sf-table sfn-table' });
      inflation.appendChild(h('thead', {}, h('tr', {}, ...['Sight', 'Hours to the fix', 'Run', 'Bearing · Zn', 'Sight sigma', 'Run’s sigma', 'Total'].map((t) => h('th', { scope: 'col' }, t)))));
      inflation.appendChild(
        h(
          'tbody',
          {},
          ...out.inflations.map((x) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, x.id),
              h('td', {}, fmtNum(x.hours_to_reference, 2)),
              h('td', {}, fmtNm(x.run_nm, 1)),
              h('td', {}, fmtBearing(x.zn_deg)),
              h('td', {}, fmtSigma(x.sigma_sight_arcmin)),
              h('td', {}, fmtSigma(x.sigma_motion_arcmin)),
              h('td', {}, fmtSigma(x.sigma_total_arcmin)),
            ),
          ),
        ),
      );
      f.results.replaceChildren(
        fixSummary(result, angleFormat(nc)),
        facts([
          ['For the moment', fmtInstant(out.reference_jd_utc, z)],
          ['Advanced along the run', out.applied ? `yes, in ${out.passes} pass${out.passes === 1 ? '' : 'es'}` : 'NO: no linearisation point was found, so the sights were solved as if stationary'],
        ]),
        gpxButton(nc, fixWaypoints(result, { sessionName: w.session.meta.name, sessionKind: w.session.meta.kind, time: out.reference_utc, sights: count }), 'running fix'),
      );
      f.details.replaceChildren(
        h(
          'section',
          { class: 'sfn-sub sfn-sub--first' },
          h('h3', {}, 'What the run adds to each sight ', h('span', { class: 'sfn-term' }, '· sigma inflation')),
          para('Each sight is moved along the run to the fix’s moment; how well the run is known widens its sigma along its own bearing. These are correlated across sights and treated as independent, so the covariance is optimistic.', 'sfn-note'),
          h('div', { class: 'sfn-table-scroll' }, inflation),
        ),
        ...fixDetails(nc, result),
      );
      if (result.kind === 'failed') f.chart.showNothing('The solve failed: there is no position to draw.');
      else f.chart.showPlot(pictures.plot, pictures.overlay);
      publish(nc, result.kind === 'failed' ? null : pictures.overlay);
    }),
  );
  return { destroy: () => f.destroy() };
}
