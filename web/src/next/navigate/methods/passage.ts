/**
 * The Passage tab (expansion programme, navigate2 agent): a route of waypoints, each leg on
 * a great circle or a rhumb line, with its distance, courses and, at a speed from a
 * departure, the time of every waypoint; the dead-reckoning position at any time; the route
 * on the map and as GPX; the legs handed to the running fix; and the forward dead-reckoning
 * calculator. Engines: `sailing`, `route_positions`, `dr_advance` (EXPLORER_API
 * "sailings"; docs/NAVIGATION_METHODS.md section 9). The arithmetic is passage/route.ts.
 */

import { h } from '../../../dom.js';
import type { LatLon } from '../../../types.js';
import type { Mounted } from '../../component.js';
import { isSailingsEngine, type DrMethod, type DrReport, type MeridionalParts, type SailingsEngine } from '../../engine/types.js';
import { isoUtc, jdFromIso } from '../../time.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import { fmtBearing, fmtInstant, fmtNm, fmtPosition, fmtSeconds, positionInputText } from '../format.js';
import { fileStem } from '../gpx.js';
import { watchCorrectionAt } from '../logs.js';
import { fixSession, patchSession, type DrForm, type LegKind, type PassageForm, type RouteWaypoint, type Working } from '../model.js';
import { parseOptionalNumber, parsePosition, type Parsed } from '../parse.js';
import { fitRoute, publishRoute } from '../passage/overlay.js';
import { installPassage, newWaypointId, planFor, routeData, tickLabel } from '../passage/page.js';
import { legAt, legKindText, positionsAt, routeGpx, runningFixLegs, waypointName, type LegPlan, type PassagePlan } from '../passage/route.js';
import { btn, card, checkbox, download, errorText, facts, field, kids, notice, para, parsedField, selectInput, textInput } from '../ui.js';
import { autoRun, methodFrame, optionalUtcField } from './common.js';

const course3 = (v: number | null): string => (v === null ? '—' : fmtBearing(v));

/** Hours as the navigator reads a passage: `6 h 42 min`, `3 d 04 h`. */
export function hoursText(hours: number): string {
  if (!Number.isFinite(hours)) return '—';
  if (hours < 48) return fmtSeconds(hours * 3600);
  const d = Math.floor(hours / 24);
  const hh = Math.round(hours - d * 24);
  return hh === 24 ? `${d + 1} d 00 h` : `${d} d ${String(hh).padStart(2, '0')} h`;
}

/** A duration typed as hours: `4.5`, `4:30`, `4 h 30 min`, `-2` (where the vessel was). */
export function parseHours(text: string): Parsed<number | null> {
  const t = text.trim().replace(/−/g, '-');
  if (!t) return { ok: true, value: null };
  let m = /^([+-]?)(\d+):(\d{1,2})$/.exec(t);
  if (m) {
    const v = Number(m[2]) + Number(m[3]) / 60;
    return Number(m[3]) < 60 ? { ok: true, value: m[1] === '-' ? -v : v } : { ok: false, error: 'Minutes must be under 60 (4:30 is four and a half hours).' };
  }
  m = /^([+-]?)\s*(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+(?:[.,]\d+)?)\s*min)?$/i.exec(t);
  if (m && (m[2] || m[3])) {
    const v = Number((m[2] ?? '0').replace(',', '.')) + Number((m[3] ?? '0').replace(',', '.')) / 60;
    return { ok: true, value: m[1] === '-' ? -v : v };
  }
  const r = parseOptionalNumber(t, { what: 'The time run', min: -1000, max: 1000, unit: 'h' });
  return r.ok ? r : { ok: false, error: 'Type the hours run: 4.5, 4:30 or 4 h 30 min (negative: where the vessel was).' };
}

export function passageMethod(host: HTMLElement, nc: NavCtx): Mounted {
  const f = methodFrame(host, nc, 'passage');
  f.chart.el.hidden = true;
  const store = nc.working.store;
  const passage = (): PassageForm => store.get().passage;
  const set = (patch: Partial<PassageForm>): void => store.patch({ passage: { ...passage(), ...patch } });
  const engine = nc.ctx.engine;
  if (!isSailingsEngine(engine)) {
    f.inputs.append(notice('caution', 'This build’s engine has no sailings (sailing, route_positions, dr_advance). Rebuild the WebAssembly package (npm run wasm --prefix web) to plan a passage.'));
    return { destroy: () => f.destroy() };
  }
  installPassage(nc.ctx);
  const sail: SailingsEngine = engine;

  // --- The route ---------------------------------------------------------------------------
  const routeBox = h('div', { class: 'sfn-route' });
  const statusLine = h('p', { class: 'sfn-status', role: 'status' });
  const setWaypoints = (list: RouteWaypoint[], say?: string): void => {
    const before = passage().waypoints;
    set({ waypoints: list });
    if (say) {
      const undo = btn('Undo', () => set({ waypoints: before }), { variant: 'outline' });
      statusLine.replaceChildren(say, ' ', undo);
    }
  };
  const move = (i: number, by: number): void => {
    const list = [...passage().waypoints];
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setWaypoints(list);
    requestAnimationFrame(() => (routeBox.querySelector<HTMLElement>(`[data-wp="${list[j]!.id}"] input`) ?? null)?.focus());
  };
  const renderRoute = (): void => {
    const list = passage().waypoints;
    const format = angleFormat(nc);
    const rows = list.map((w, i) => {
      const name = textInput({ value: w.name, placeholder: `WP ${i + 1}`, size: 14 });
      name.setAttribute('aria-label', `Name of waypoint ${i + 1}`);
      name.addEventListener('change', () => setWaypoints(passage().waypoints.map((x) => (x.id === w.id ? { ...x, name: name.value.trim() } : x))));
      const pos = parsedField<LatLon>(`Waypoint ${i + 1}`, {
        placeholder: '36 55.6 N, 076 00.2 W',
        parse: parsePosition,
        format: (p) => positionInputText(p),
        read: () => {
          const x = passage().waypoints.find((y) => y.id === w.id) ?? w;
          return { lat_deg: x.lat_deg, lon_deg: x.lon_deg };
        },
        commit: (p) => setWaypoints(passage().waypoints.map((x) => (x.id === w.id ? { ...x, ...p } : x))),
      });
      // The field shows degrees and minutes; another chosen format is shown beside it.
      pos.parts.setHelp(format === 'dm' ? null : fmtPosition(w, format));
      const leg =
        i === 0
          ? h('span', { class: 'sfn-route__start sfn-muted' }, 'departure')
          : (() => {
              const s = selectInput<LegKind>(
                [
                  { value: 'great_circle', label: 'by great circle' },
                  { value: 'rhumb', label: 'by rhumb line' },
                ],
                w.leg,
              );
              s.setAttribute('aria-label', `How leg ${i} to waypoint ${i + 1} is sailed`);
              s.addEventListener('change', () => setWaypoints(passage().waypoints.map((x) => (x.id === w.id ? { ...x, leg: s.value as LegKind } : x))));
              return s;
            })();
      return h(
        'li',
        { class: 'sfn-route__row', 'data-wp': w.id },
        h('span', { class: 'sfn-route__n sfn-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('div', { class: 'sfn-route__fields' }, name, pos.el),
        h('div', { class: 'sfn-route__leg' }, leg),
        h(
          'div',
          { class: 'sfn-route__actions' },
          btn('', () => move(i, -1), { icon: 'chevron-up', variant: 'ghost', ariaLabel: `Move waypoint ${i + 1} up` }),
          btn('', () => move(i, 1), { icon: 'chevron-down', variant: 'ghost', ariaLabel: `Move waypoint ${i + 1} down` }),
          btn('', () => setWaypoints(passage().waypoints.filter((x) => x.id !== w.id), `Removed ${waypointName(w, i)}.`), { icon: 'close', variant: 'ghost', ariaLabel: `Remove waypoint ${i + 1}` }),
        ),
      );
    });
    routeBox.replaceChildren(
      list.length
        ? h('ol', { class: 'sfn-route__list', 'aria-label': 'Waypoints, in order' }, ...rows)
        : para('No waypoints yet. Type the first below, add the DR or the map’s place, or measure on the map and choose “Add as a leg of the passage”.', 'sfn-note sfn-muted'),
    );
  };

  const addPos = parsedField<LatLon | null>('Add a waypoint', {
    term: 'latitude then longitude',
    placeholder: '32 22.8 N, 064 40.8 W',
    help: 'Any usual form: 32 22.8 N 064 40.8 W, or 32.38, −64.68.',
    parse: (t): Parsed<LatLon | null> => (t.trim() ? parsePosition(t) : { ok: true, value: null }),
    format: () => '',
    read: () => null,
    commit: () => undefined,
  });
  const addName = textInput({ placeholder: 'Optional', size: 12 });
  const addNameField = field('Its name', addName);
  const append = (p: LatLon, name: string): void => {
    const list = passage().waypoints;
    setWaypoints([...list, { id: newWaypointId(list), name, lat_deg: p.lat_deg, lon_deg: p.lon_deg, leg: 'great_circle' }]);
  };
  const addButton = btn('Add', () => {
    const r = addPos.input.value.trim() ? parsePosition(addPos.input.value) : null;
    if (!r) {
      addPos.parts.setError('Type the waypoint’s position.');
      return;
    }
    if (!r.ok) {
      addPos.parts.setError(r.error);
      return;
    }
    addPos.parts.setError(null);
    append(r.value, addName.value.trim());
    addPos.input.value = '';
    addName.value = '';
    addPos.input.focus();
  }, { icon: 'plus', variant: 'outline' });
  addPos.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addButton.click();
  });
  const addDr = btn('Add the DR', () => {
    const ap = store.get().session.observer.assumed_position;
    if (ap) append(ap, 'DR');
    else statusLine.textContent = 'The session has no assumed position (DR): set one in the session settings.';
  }, { variant: 'ghost', icon: 'target', tip: 'The session’s assumed position' });
  const addPlace = btn('Add the map’s place', () => {
    const o = nc.ctx.store.get().observer;
    append({ lat_deg: o.lat_deg, lon_deg: o.lon_deg }, o.label);
  }, { variant: 'ghost', icon: 'pin', tip: 'The place set on the map and in the side panel' });
  const reverse = btn('Reverse the route', () => {
    const list = [...passage().waypoints].reverse();
    // Each leg keeps its kind: the leg arriving at a waypoint becomes the one leaving it.
    const kinds = passage().waypoints.map((w) => w.leg);
    setWaypoints(list.map((w, i) => ({ ...w, leg: i === 0 ? 'great_circle' : kinds[kinds.length - i]! })), 'Reversed the route.');
  }, { variant: 'ghost' });
  const clear = btn('Clear the route', () => setWaypoints([], 'Cleared the route.'), { variant: 'ghost' });

  // --- Speed, departure, how -----------------------------------------------------------------
  const speed = parsedField<number | null>('Speed (knots)', {
    term: 'over the ground',
    inputmode: 'decimal',
    size: 6,
    help: 'For the times. Empty: distances and courses only.',
    parse: (t) => parseOptionalNumber(t, { what: 'The speed', min: 0, exclusiveMin: true, max: 1000, unit: 'kn' }),
    format: (v) => (v === null ? '' : String(v)),
    read: () => passage().speedKn,
    commit: (v) => set({ speedKn: v }),
  });
  const departure = optionalUtcField(nc, 'Departure (UTC)', 'no times, only hours under way', () => passage().departureUtc, (v) => set({ departureUtc: v }));
  const fromBar = btn('Time bar', () => set({ departureUtc: isoUtc(nc.ctx.store.get().time.jd_utc).replace(/\.\d+Z$/, 'Z') }), { variant: 'ghost', tip: 'Depart at the time on the time bar' });
  const parts = selectInput<MeridionalParts>(
    [
      { value: 'sphere', label: 'On the sphere (1′ = 1 NM everywhere)' },
      { value: 'wgs84', label: 'WGS84 meridional parts (Mercator chart, Bowditch Table 6)' },
    ],
    passage().parts,
  );
  parts.addEventListener('change', () => set({ parts: parts.value as MeridionalParts }));
  const partsField = field('Rhumb lines worked', parts, { help: 'The WGS84 parts give the course a Mercator chart on WGS84 shows (up to 0.16° different); the distance is the chart’s latitude scale. Great circles are on the sphere either way.' });
  const ticks = selectInput<string>(
    ['0', '1', '2', '3', '4', '6', '12', '24'].map((v) => ({ value: v, label: v === '0' ? 'None' : `Every ${v} h` })),
    String(passage().tickHours),
  );
  ticks.addEventListener('change', () => set({ tickHours: Number(ticks.value) }));
  const ticksField = field('Dead-reckoning marks on the map', ticks);
  const onMap = checkbox('Draw the route on the map', passage().showOnMap, (v) => set({ showOnMap: v }), 'Solid: great circle. Dashed: rhumb line.');

  f.inputs.append(
    h('section', { class: 'sfn-sub sfn-sub--first' }, h('h3', {}, 'The route ', h('span', { class: 'sfn-term' }, '· waypoints and legs')), routeBox),
    h('div', { class: 'sfn-route__add' }, addPos.el, addNameField.el, h('div', { class: 'sfn-route__add-actions' }, addButton)),
    h('div', { class: 'sfn-inline' }, addDr, addPlace, reverse, clear),
    statusLine,
    h(
      'fieldset',
      { class: 'sfn-group' },
      h('legend', {}, 'Under way'),
      h('div', { class: 'sfn-grid-2' }, speed.el, h('div', { class: 'sfn-entry__time' }, departure.el, h('div', { class: 'sfn-entry__time-buttons' }, fromBar))),
      h('div', { class: 'sfn-grid-2' }, partsField.el, ticksField.el),
      onMap.el,
    ),
  );

  // --- The forward DR calculator (its own card, under the results) -----------------------------
  const calc = drCalculator(nc, sail);
  host.append(calc.el);
  f.track(() => calc.destroy());

  // --- Results --------------------------------------------------------------------------------
  const legRow = (leg: LegPlan, plan: PassagePlan): HTMLElement => {
    const z = zone(nc, plan.departureJd);
    const eta = plan.departureJd !== null && leg.endHours !== null ? fmtInstant(plan.departureJd + leg.endHours / 24, z) : leg.endHours !== null ? `${hoursText(leg.endHours)} after leaving` : '—';
    const other = leg.otherNm - leg.distanceNm;
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, `${leg.index + 1}. ${waypointName(leg.from, leg.index)} → ${waypointName(leg.to, leg.index + 1)}`),
      h('td', {}, legKindText(leg.kind)),
      h('td', { class: 'sfn-num' }, `${leg.distanceNm.toFixed(1)} NM`, h('span', { class: 'sfn-muted' }, ` (${leg.distanceKm.toFixed(0)} km)`)),
      h('td', { class: 'sfn-num' }, course3(leg.initialCourseDeg), leg.kind === 'great_circle' && leg.finalCourseDeg !== null ? h('span', { class: 'sfn-muted' }, ` → ${course3(leg.finalCourseDeg)}`) : null),
      h('td', { class: 'sfn-num' }, leg.startHours !== null && leg.endHours !== null ? hoursText(leg.endHours - leg.startHours) : '—'),
      h('td', { class: 'sfn-num' }, eta),
      h('td', { class: 'sfn-muted' }, Math.abs(other) < 0.05 ? 'the same either way' : leg.kind === 'great_circle' ? `${other.toFixed(1)} NM shorter than the rhumb line` : `${(-other).toFixed(1)} NM longer than the great circle`),
    );
  };

  const steeringBlock = (leg: LegPlan): HTMLElement | null => {
    if (leg.kind !== 'great_circle' || leg.steering.length < 3) return null;
    const extra = leg.report.great_circle.waypoint_route_nm - leg.distanceNm;
    const format = angleFormat(nc);
    return h(
      'details',
      { class: 'sfn-advanced' },
      h('summary', {}, `Leg ${leg.index + 1}: steering the great circle, a rhumb line every 5° of longitude (${leg.steering.length - 2} points)`),
      para(
        `A great circle’s course changes all the time, so it is sailed as short rhumb lines between points on it (Bowditch). These ${leg.steering.length - 2} points sail ${extra.toFixed(1)} NM more than the great circle itself.` +
          (leg.vertex ? ` The track reaches its highest latitude, ${fmtPosition(leg.vertex, format)}, on this leg.` : ''),
        'sfn-note',
      ),
      h(
        'div',
        { class: 'sfn-table-scroll' },
        h(
          'table',
          { class: 'sf-table sfn-table' },
          h('thead', {}, h('tr', {}, ...['Point', 'Position', 'Along the great circle', 'Steer', 'To the next'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            {},
            ...leg.steering.map((s) =>
              h(
                'tr',
                {},
                h('th', { scope: 'row' }, s.index === 0 ? 'start' : s.leg_course_deg === null ? 'end' : String(s.index)),
                h('td', { class: 'sfn-num' }, fmtPosition(s, format)),
                h('td', { class: 'sfn-num' }, `${s.distance_from_start_nm.toFixed(1)} NM`),
                h('td', { class: 'sfn-num' }, course3(s.leg_course_deg)),
                h('td', { class: 'sfn-num' }, s.leg_distance_nm === null ? '—' : `${s.leg_distance_nm.toFixed(1)} NM`),
              ),
            ),
          ),
        ),
      ),
    );
  };

  /** The legs for the running fix over the sights' hours, or why none. */
  const useInRunningFix = (plan: PassagePlan): void => {
    const w = store.get();
    const session = fixSession(w);
    const times = session.observations
      .map((o) => jdFromIso(o.utc))
      .filter((jd): jd is number => jd !== null)
      .map((jd, i) => jd + watchCorrectionAt(session, session.observations[i]!.utc) / 86_400);
    if (!times.length) return;
    const ref = w.running.referenceUtc ? jdFromIso(w.running.referenceUtc) : null;
    const lo = Math.min(...times);
    const hi = Math.max(...times, ref ?? -Infinity);
    const out = runningFixLegs(sail, plan, lo, hi);
    if (!out) {
      nc.say('The sights’ hours are not on the passage (check its departure and speed).', 'caution');
      return;
    }
    const before = w.running;
    store.patch({
      running: { ...w.running, legs: out.legs.map((l) => ({ start_utc: l.start_utc ?? null, course_deg: l.course_deg, speed_kn: l.speed_kn })), endUtc: out.endUtc },
      method: 'running',
    });
    nc.say(out.note, 'info', () => store.patch({ running: before, method: 'passage' }));
  };

  f.track(
    autoRun(
      nc,
      (w: Working) => [w.passage, w.session.observations, w.excluded, w.session.observer.assumed_position] as const,
      (isCurrent) => {
        for (const x of [speed, departure]) x.refresh();
        parts.value = passage().parts;
        ticks.value = String(passage().tickHours);
        onMap.input.checked = passage().showOnMap;
        renderRoute();
        const p = passage();
        if (p.waypoints.length < 2) {
          f.setStatus({ missing: 'A passage needs two waypoints or more: the departure, and where you are going.' });
          f.results.replaceChildren();
          f.details.replaceChildren();
          return;
        }
        f.setStatus('busy');
        const plan = planFor(sail, p);
        if (!isCurrent()) return;
        f.setStatus('idle');
        const z = zone(nc);
        const format = angleFormat(nc);
        const table = h(
          'table',
          { class: 'sf-table sfn-table sfn-legs-table' },
          h('caption', { class: 'sf-sr' }, 'The legs of the passage'),
          h('thead', {}, h('tr', {}, ...['Leg', 'By', 'Distance', 'Course', 'Time', 'Arrive', 'The other way'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, ...plan.legs.map((l) => legRow(l, plan))),
        );
        const failures = plan.failures.map((x) => notice('error', h('strong', {}, `Leg ${x.index + 1} (${waypointName(x.from, x.index)} → ${waypointName(x.to, x.index + 1)}): `), x.error));
        // The DR at the time bar's time.
        const jdNow = nc.ctx.store.get().time.jd_utc;
        let nowLine: HTMLElement | null = null;
        if (plan.departureJd !== null && plan.speedKn !== null && plan.arrivalJd !== null) {
          const hoursNow = (jdNow - plan.departureJd) * 24;
          const at = legAt(plan, hoursNow);
          if (at) {
            try {
              const [pt] = positionsAt(sail, plan, [jdNow]);
              if (pt) {
                const useIt = btn('Use as the session’s DR', () => {
                  const before = store.get().session.observer.assumed_position;
                  store.patch({ session: patchSession(store.get().session, { observer: { assumed_position: { lat_deg: pt.lat_deg, lon_deg: pt.lon_deg } } }) });
                  nc.say('The session’s assumed position is now the DR on the passage at the time bar’s time.', 'info', () =>
                    store.patch({ session: patchSession(store.get().session, { observer: { assumed_position: before } }) }),
                  );
                }, { variant: 'outline', icon: 'target' });
                nowLine = h(
                  'div',
                  { class: 'sfn-export' },
                  h(
                    'p',
                    { class: 'sfn-note' },
                    h('strong', {}, 'DR now: '),
                    `${fmtPosition(pt, format)} at ${fmtInstant(jdNow, z)} (the time bar), ${at.alongNm.toFixed(1)} NM along leg ${at.leg.index + 1}, ${(plan.speedKn * hoursNow).toFixed(1)} NM from the departure.`,
                  ),
                  useIt,
                );
              }
            } catch (error) {
              nowLine = notice('caution', errorText(error));
            }
          } else {
            nowLine = para(
              jdNow < plan.departureJd ? `DR now: not yet under way (departure ${fmtInstant(plan.departureJd, z)}).` : `DR now: arrived (${fmtInstant(plan.arrivalJd, z)}).`,
              'sfn-note sfn-muted',
            );
          }
        }
        const sights = fixSession(store.get()).observations.length;
        const canRun = plan.departureJd !== null && plan.speedKn !== null && plan.legs.length > 0 && sights > 0;
        const runButton = btn('Use in the running fix', () => useInRunningFix(plan), { variant: 'outline', icon: 'sextant', tip: 'The passage’s legs over the hours of your sights become the running fix’s dead-reckoning run' });
        runButton.disabled = !canRun;
        const gpx = btn('Save as GPX', () => {
          const s = store.get().session;
          const name = `${s.meta.name || 'SkyFix Lab'} — passage`;
          download(`${fileStem(s.meta.name)}-passage.gpx`, routeGpx(plan, p, { name, sessionKind: s.meta.kind, time: new Date().toISOString() }), 'application/gpx+xml');
        }, { variant: 'outline', icon: 'pin', tip: 'The route as a GPX route, with each great circle’s 5° steering points' });
        gpx.disabled = plan.legs.length === 0;
        const show = btn('Show on the map', () => {
          set({ showOnMap: true });
          const data = routeData(sail, passage(), planFor(sail, passage()), nc.ctx.store.get().time.jd_utc, (t) => tickLabel(t, z));
          publishRoute(nc.overlays, data);
          fitRoute(nc.overlays);
          nc.ctx.store.patch({ view: 'map' });
        }, { variant: 'outline', icon: 'map' });
        const gcSaving = plan.legs.reduce((s, l) => s + (l.kind === 'great_circle' ? l.otherNm - l.distanceNm : 0), 0);
        f.results.replaceChildren(
          ...kids(
            ...failures,
            plan.legs.length
              ? h(
                  'p',
                  { class: 'sfn-compass__sentence' },
                  `${plan.totalNm.toFixed(1)} NM in ${plan.legs.length} leg${plan.legs.length === 1 ? '' : 's'}` +
                    (plan.totalHours !== null ? `, ${hoursText(plan.totalHours)} at ${plan.speedKn} kn` : '') +
                    (plan.arrivalJd !== null ? `: arriving ${fmtInstant(plan.arrivalJd, z)}` : '') +
                    '.',
                )
              : null,
            plan.legs.length ? h('div', { class: 'sfn-table-scroll' }, table) : null,
            gcSaving > 0.05 ? para(`The great-circle legs save ${gcSaving.toFixed(1)} NM over rhumb lines between the same waypoints.`, 'sfn-note') : null,
            nowLine,
            h(
              'div',
              { class: 'sfn-export' },
              show,
              gpx,
              runButton,
              h(
                'span',
                { class: 'sfn-note sfn-muted' },
                canRun
                  ? ` The running fix gets the passage’s legs over the hours of your ${sights} sight${sights === 1 ? '' : 's'}.`
                  : plan.departureJd === null || plan.speedKn === null
                    ? ' The running fix needs a departure time and a speed.'
                    : ' The running fix needs sights: enter them first.',
              ),
            ),
          ),
        );
        f.details.replaceChildren(
          ...kids(
            h('section', { class: 'sfn-sub sfn-sub--first' }, h('h3', {}, 'How the legs were worked'), h('ul', { class: 'sfn-list' }, ...plan.notes.map((n) => h('li', {}, n)), h('li', {}, 'Every course is true. Times are at a steady speed over the ground: no current, leeway or stops.'))),
            ...plan.legs.map(steeringBlock).filter((x): x is HTMLElement => x !== null),
          ),
        );
      },
      200,
      (s) => Math.round(s.time.jd_utc * 1440),
    ),
  );
  return { destroy: () => f.destroy() };
}

// ---------------------------------------------------------------------------------------
// The forward dead-reckoning calculator (`dr_advance`)

function drCalculator(nc: NavCtx, sail: SailingsEngine): { el: HTMLElement; destroy(): void } {
  const store = nc.working.store;
  const dr = (): DrForm => store.get().passage.dr;
  const set = (patch: Partial<DrForm>): void => store.patch({ passage: { ...store.get().passage, dr: { ...dr(), ...patch } } });
  const c = card('Where will I be?', { term: 'forward dead reckoning', iconName: 'target', class: 'sfn-drcalc' });
  c.body.append(para('From a position, a course and a speed, where the vessel is after a time (or, with a negative time, where she was). A steered course is a rhumb line.', 'sfn-plain'));
  const from = parsedField<LatLon | null>('From', {
    term: 'latitude then longitude',
    placeholder: 'the DR, or the map’s place',
    help: 'Empty: the session’s assumed position (DR), or without one the map’s place.',
    parse: (t): Parsed<LatLon | null> => (t.trim() ? parsePosition(t) : { ok: true, value: null }),
    format: (p) => (p ? positionInputText(p) : ''),
    read: () => dr().from,
    commit: (p) => set({ from: p }),
  });
  const courseF = parsedField<number | null>('Course (° true)', {
    inputmode: 'decimal',
    size: 6,
    parse: (t) => parseOptionalNumber(t, { what: 'The course', min: 0, max: 360, unit: '°' }),
    format: (v) => (v === null ? '' : String(v)),
    read: () => dr().courseDeg,
    commit: (v) => set({ courseDeg: v === 360 ? 0 : v }),
  });
  const speedF = parsedField<number | null>('Speed (knots)', {
    inputmode: 'decimal',
    size: 6,
    parse: (t) => parseOptionalNumber(t, { what: 'The speed', min: 0, max: 1000, unit: 'kn' }),
    format: (v) => (v === null ? '' : String(v)),
    read: () => dr().speedKn,
    commit: (v) => set({ speedKn: v }),
  });
  const hoursF = parsedField<number | null>('Time run (hours)', {
    inputmode: 'decimal',
    size: 8,
    help: '4.5, 4:30 or 4 h 30 min; negative for where she was.',
    parse: parseHours,
    format: (v) => (v === null ? '' : String(Number(v.toFixed(4)))),
    read: () => dr().hours,
    commit: (v) => set({ hours: v }),
  });
  const start = optionalUtcField(nc, 'Starting at (UTC, optional)', 'no arrival time', () => dr().startUtc, (v) => set({ startUtc: v }));
  const method = selectInput<DrMethod>(
    [
      { value: 'rhumb', label: 'Rhumb line: a steered course (Mercator sailing)' },
      { value: 'mid_latitude', label: 'Mid-latitude sailing (Bowditch’s approximation)' },
      { value: 'great_circle', label: 'Great circle on the initial course (the running fix’s model)' },
    ],
    dr().method,
  );
  method.addEventListener('change', () => set({ method: method.value as DrMethod }));
  const methodField = field('Worked as', method);
  const out = h('div', { class: 'sfn-method__results', 'aria-live': 'polite' });
  c.body.append(from.el, h('div', { class: 'sfn-grid-3' }, courseF.el, speedF.el, hoursF.el), h('div', { class: 'sfn-grid-2' }, start.el, methodField.el), out);

  const origin = (w: Working): { p: LatLon; label: string } => {
    if (w.passage.dr.from) return { p: w.passage.dr.from, label: 'the position typed' };
    const ap = w.session.observer.assumed_position;
    if (ap) return { p: ap, label: 'the session’s assumed position (DR)' };
    const o = nc.ctx.store.get().observer;
    return { p: { lat_deg: o.lat_deg, lon_deg: o.lon_deg }, label: o.label || 'the map’s place' };
  };

  let last: DrReport | null = null;
  const run = (): void => {
    for (const x of [from, courseF, speedF, hoursF, start]) x.refresh();
    method.value = dr().method;
    const w = store.get();
    const d = w.passage.dr;
    if (d.courseDeg === null || d.speedKn === null || d.hours === null) {
      last = null;
      out.replaceChildren(para('Type the course, the speed and the time run.', 'sfn-note sfn-muted'));
      return;
    }
    const o = origin(w);
    try {
      last = sail.drAdvance({ from: o.p, course_deg: d.courseDeg, speed_kn: d.speedKn, hours: d.hours, method: d.method, meridional_parts: w.passage.parts, start_utc: d.startUtc });
    } catch (error) {
      last = null;
      out.replaceChildren(notice('error', errorText(error)));
      return;
    }
    const r = last;
    const format = angleFormat(nc);
    const z = zone(nc);
    const asDr = btn('Use as the session’s DR', () => {
      const before = store.get().session.observer.assumed_position;
      store.patch({ session: patchSession(store.get().session, { observer: { assumed_position: { ...r.to } } }) });
      nc.say('The session’s assumed position is now this dead-reckoning position.', 'info', () =>
        store.patch({ session: patchSession(store.get().session, { observer: { assumed_position: before } }) }),
      );
    }, { variant: 'outline', icon: 'target' });
    const asWp = btn('Add to the route', () => {
      const list = store.get().passage.waypoints;
      store.patch({ passage: { ...store.get().passage, waypoints: [...list, { id: newWaypointId(list), name: 'DR', lat_deg: r.to.lat_deg, lon_deg: r.to.lon_deg, leg: d.method === 'great_circle' ? 'great_circle' : 'rhumb' }] } });
      nc.say('Added the dead-reckoning position to the route.');
    }, { variant: 'ghost', icon: 'plus' });
    out.replaceChildren(
      h('p', { class: 'sfn-compass__sentence' }, `${fmtPosition(r.to, format)}`),
      facts([
        ['From', `${fmtPosition(r.from, format)} (${o.label})`],
        ['Run', `${fmtNm(Math.abs(r.distance_nm), 1)} on ${course3(r.course_deg)} at ${r.speed_kn} kn for ${hoursText(Math.abs(r.hours))}${r.hours < 0 ? ', backwards: where she was' : ''}`],
        ['Worked as', `${r.method === 'rhumb' ? 'a rhumb line' : r.method === 'mid_latitude' ? 'mid-latitude sailing' : 'a great circle on the initial course'}${r.method === 'rhumb' ? ` (${r.meridional_parts === 'wgs84' ? 'WGS84 meridional parts' : 'on the sphere'})` : ''}`],
        r.method === 'great_circle' ? ['Course on arrival', course3(r.final_course_deg)] : null,
        r.arrival_jd_utc !== null ? [r.hours < 0 ? 'Was there at' : 'Arrives', fmtInstant(r.arrival_jd_utc, z)] : null,
      ]),
      h('div', { class: 'sfn-export' }, asDr, asWp),
    );
  };
  const stop = store.select((w) => [w.passage.dr, w.passage.parts, w.session.observer.assumed_position] as const, run, {
    equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
  });
  const stopFormat = nc.ctx.store.select((s) => [s.settings.angleFormat, s.observer.zone, s.settings.timeDisplay] as const, run, {
    equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
  });
  run();
  return {
    el: c.el,
    destroy: () => {
      stop();
      stopFormat();
      c.el.remove();
    },
  };
}
