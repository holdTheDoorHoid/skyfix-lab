/**
 * Navigate view: shaping data. GPX export, the working model (editing a session, building
 * each method's request), autosave, the map overlays, the plot's framing, and the example
 * sessions. No DOM, no engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromCsv, toCsv } from '../../src/csv.js';
import type { FixResult, Session } from '../../src/types.js';
import { CHI2_95_2DOF } from '../../src/types.js';
import type { NoonSightResult } from '../../src/next/engine/types.js';
import { MapServiceImpl } from '../../src/next/map/overlays.js';
import { AUTOSAVE_KEY, forgetWorking, loadWorking, sanitizeSession, sanitizeWorking, saveWorking } from '../../src/next/navigate/autosave.js';
import { EXAMPLES } from '../../src/next/navigate/examples.js';
import { escapeXml, fileStem, fixWaypoints, gpxDocument, noonWaypoints } from '../../src/next/navigate/gpx.js';
import {
  bodyCounts,
  defaultWorking,
  emptySession,
  fixSession,
  hasOwnData,
  lunarInputFor,
  nextObservationId,
  noonOptionsFor,
  noonSession,
  patchSession,
  polarisSession,
  runBody,
  runningRequestFor,
  solveOptionsFor,
  withObservation,
  withoutObservation,
  type Working,
} from '../../src/next/navigate/model.js';
import { clearOverlays, emptyOverlayData, OVERLAY_PREFIX, overlayLayers, publishOverlays } from '../../src/next/navigate/overlays.js';
import { assumedIsNear, emptyPlotSpec, plotAnchors } from '../../src/next/navigate/plot.js';
import { createStore } from '../../src/next/state.js';
import { createWorking } from '../../src/next/navigate/working.js';
import { MemoryStorage, ThrowingStorage } from './helpers.js';

const obs = (id: string, body: string, utc = '2026-10-01T01:30:00Z', altitude = 40) => ({
  id,
  body,
  utc,
  altitude_deg: altitude,
  altitude_kind: 'sextant_hs' as const,
  sigma_arcmin: 1,
  limb: 'center' as const,
  horizon: null,
  geocentric: null,
  notes: '',
});

function uniqueFix(): FixResult {
  return {
    kind: 'unique',
    fix: {
      position: { lat_deg: 39.95283, lon_deg: -75.16319 },
      shared_bias_arcmin: null,
      covariance_ne_m2: [
        [584 ** 2, 0],
        [0, 588 ** 2],
      ],
      sigma_north_m: 584,
      sigma_east_m: 588,
      clock_sigma_east_m: 0,
      ellipse95: { semi_major_m: 1440, semi_minor_m: 1420, orientation_deg: 119, confidence: 0.95, model: 'nominal 95 %, independent-noise model' },
      ellipse_suppressed_reason: null,
      posterior_scaled: null,
      residuals: [],
      chi2: 1.48,
      dof: 3,
      conditioning: { singular_values: [1, 1], condition_number: 1.01, rank: 2, geometric_dilution_m_per_arcmin: 1660, max_azimuth_gap_deg: 86, columns: 'position (north, east)' },
      iterations: 5,
      converged: true,
      prior: null,
      robust: null,
    },
    alternatives: [],
    circles: [],
    warnings: [],
  };
}

describe('GPX export', () => {
  const ctx = { sessionName: 'Five stars <dusk> & "friends"', sessionKind: 'simulated' as const, time: '2026-09-24T23:36:00Z', sights: 5 };

  it('writes a unique fix as one waypoint with its uncertainty in words', () => {
    const plan = fixWaypoints(uniqueFix(), ctx);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [w] = plan.waypoints;
    expect(w!.lat_deg).toBe(39.95283);
    expect(w!.lon_deg).toBe(-75.16319);
    expect(w!.desc).toMatch(/north 584 m \(0\.32 NM\), east 588 m \(0\.32 NM\)/);
    expect(w!.desc).toContain('95 % ellipse (nominal 95 %, independent-noise model): 1.44 km by 1.42 km, major axis 119 deg');
    expect(w!.desc).toContain('SIMULATED session');
    expect(w!.desc).toContain('Not a navigation instrument.');
    const xml = gpxDocument({ name: ctx.sessionName, desc: 'd', time: '2026-09-24T23:40:00Z', waypoints: plan.waypoints });
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<gpx version="1.1"/);
    expect(xml).toContain('<wpt lat="39.9528300" lon="-75.1631900">');
    expect(xml).toContain('<time>2026-09-24T23:36:00Z</time>');
    expect(xml).toContain('Five stars &lt;dusk&gt; &amp; &quot;friends&quot;');
    expect(xml).not.toMatch(/<dusk>/);
    // Every element opened is closed.
    for (const tag of ['gpx', 'metadata', 'wpt', 'name', 'desc', 'time', 'sym', 'type']) {
      expect((xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length).toBe((xml.match(new RegExp(`</${tag}>`, 'g')) ?? []).length);
    }
  });

  it('says when the ellipse is suppressed, and names the prior and the clock', () => {
    const r = uniqueFix();
    if (r.kind !== 'unique') throw new Error('unique');
    r.fix.ellipse95 = null;
    r.fix.ellipse_suppressed_reason = 'the solver did not converge';
    r.fix.clock_sigma_east_m = 120;
    r.fix.prior = { center: { lat_deg: 40, lon_deg: -75 }, sigma_nm: 5, fix_without_prior: null, shift_m: 250 };
    const plan = fixWaypoints(r, ctx);
    if (!plan.ok) throw new Error('expected waypoints');
    expect(plan.waypoints[0]!.desc).toContain('No 95 % ellipse: the solver did not converge.');
    expect(plan.waypoints[0]!.desc).toContain('120 m comes from the stated clock uncertainty');
    expect(plan.waypoints[0]!.desc).toContain('A prior of 5 NM influenced this fix');
  });

  it('writes every ambiguous candidate, none preferred, and refuses results with no position', () => {
    const amb: FixResult = {
      kind: 'ambiguous',
      candidates: [
        { position: { lat_deg: 39.95, lon_deg: -75.17 }, chi2: 0, delta_chi2_from_best: 0, converged: true, iterations: 4, shared_bias_arcmin: null },
        { position: { lat_deg: 14.18, lon_deg: -130.04 }, chi2: 0, delta_chi2_from_best: 0, converged: true, iterations: 1, shared_bias_arcmin: null },
      ],
      circles: [],
      warnings: [],
    };
    const plan = fixWaypoints(amb, { ...ctx, sights: 2 });
    if (!plan.ok) throw new Error('expected waypoints');
    expect(plan.waypoints.map((w) => w.name)).toEqual(['Ambiguous fix, candidate A', 'Ambiguous fix, candidate B']);
    expect(plan.waypoints[1]!.desc).toContain('No candidate is preferred');
    const under = fixWaypoints({ kind: 'underdetermined', circles: [], reason: '1 usable sight', warnings: [] }, ctx);
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).toContain('underdetermined');
    expect(fixWaypoints({ kind: 'failed', reason: 'no sights', warnings: [] }, ctx).ok).toBe(false);
  });

  it('exports a noon position only with a longitude, and says how weak it is', () => {
    const base = { body: 'Sun', method: 'curve_fit', n_sights: 21, latitude: { lat_deg: 39.9526, sigma_arcmin: 0.11 }, meridian_passage: { utc: '2026-09-23T16:52:57.689Z', jd_utc: 1, sigma_s: 7 }, longitude: { lon_deg: -75.1652, sigma_arcmin: 1.75, sigma_nm: 1.34, clock_sigma_arcmin: 0 } } as unknown as NoonSightResult;
    const plan = noonWaypoints(base, ctx);
    if (!plan.ok) throw new Error('expected a waypoint');
    expect(plan.waypoints[0]!.time).toBe('2026-09-23T16:52:57.689Z');
    expect(plan.waypoints[0]!.desc).toContain('far weaker than the latitude');
    expect(noonWaypoints({ ...base, longitude: null, meridian_passage: null }, ctx).ok).toBe(false);
  });

  it('escapes XML and makes safe file names', () => {
    expect(escapeXml(`a<b>&"c"'d\u0001`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;d');
    expect(fileStem('Five stars at dusk, Philadelphia (simulated)')).toBe('five-stars-at-dusk-philadelphia-simulated');
    expect(fileStem('Tromsø ✦')).toBe('troms');
    expect(fileStem('***')).toBe('session');
  });
});

describe('the working model', () => {
  it('numbers new sights after the largest obs-N, and edits without mutating', () => {
    let s = emptySession();
    expect(nextObservationId(s)).toBe('obs-1');
    s = withObservation(s, obs('obs-1', 'Vega'));
    s = withObservation(s, obs('obs-7', 'Deneb'));
    expect(nextObservationId(s)).toBe('obs-8');
    const before = s;
    const replaced = withObservation(s, { ...obs('obs-1', 'Altair') }, 'obs-1');
    expect(replaced.observations.map((o) => o.body)).toEqual(['Altair', 'Deneb']);
    expect(before.observations[0]!.body).toBe('Vega');
    expect(withoutObservation(replaced, 'obs-7').observations.map((o) => o.id)).toEqual(['obs-1']);
    const patched = patchSession(s, { instrument: { index_correction_arcmin: -1.2 } });
    expect(patched.instrument.index_correction_arcmin).toBe(-1.2);
    expect(s.instrument.index_correction_arcmin).toBe(0);
    expect(patched.observations).toBe(s.observations);
  });

  it('chooses each method’s sights', () => {
    const w: Working = {
      ...defaultWorking(),
      session: {
        ...emptySession(),
        observations: [obs('a', 'Sun'), obs('b', 'sun'), obs('c', 'Vega'), obs('d', 'Polaris'), obs('e', 'Sun')],
      },
      excluded: ['c'],
    };
    expect(bodyCounts(w.session)).toEqual([
      { body: 'Sun', count: 3 },
      { body: 'Polaris', count: 1 },
      { body: 'Vega', count: 1 },
    ]);
    expect(fixSession(w).observations.map((o) => o.id)).toEqual(['a', 'b', 'd', 'e']);
    expect(noonSession(w).observations.map((o) => o.id)).toEqual(['a', 'b', 'e']);
    expect(runBody(w.session, 'VEGA')).toBe('Vega');
    expect(runBody(w.session, 'Mars')).toBe('Sun');
    expect(polarisSession(w).observations.map((o) => o.id)).toEqual(['d']);
  });

  it('builds the solve options as the old workbench did: an initializer is never a prior', () => {
    const w = defaultWorking({ position: { lat_deg: 40, lon_deg: -75 } });
    let o = solveOptionsFor(w);
    expect(o.initializer).toEqual({ lat_deg: 40, lon_deg: -75 });
    expect(o.prior).toBeNull();
    const prior = { ...w, session: patchSession(w.session, { observer: { assumed_position_role: { role: 'prior', sigma_nm: 5 } }, clock: { uncertainty_s: 2 } }) };
    o = solveOptionsFor({ ...prior, solve: { ...prior.solve, robust: true, multistart: false, estimate_shared_bias: true, max_iterations: 12.4 } });
    expect(o.initializer).toBeNull();
    expect(o.prior).toEqual({ center: { lat_deg: 40, lon_deg: -75 }, sigma_nm: 5 });
    expect(o.clock_uncertainty_s).toBe(2);
    expect(o.robust).toEqual({ huber_k: 1.5, max_reweight_iterations: 10 });
    expect(o.multistart.enabled).toBe(false);
    expect(o.multistart.ambiguity_delta_chi2).toBeCloseTo(CHI2_95_2DOF, 9);
    expect(o.max_iterations).toBe(12);
    expect(o.estimate_shared_bias).toBe(true);
    const off = { ...w, session: patchSession(w.session, { observer: { assumed_position_role: { role: 'disabled' } } }) };
    expect(solveOptionsFor(off).initializer).toBeNull();
  });

  it('builds method requests: vessel only when stated, DR sigma never guessed, first leg may start at the first sight', () => {
    const w = defaultWorking({ position: { lat_deg: 39.8, lon_deg: -44.6 } });
    expect(noonOptionsFor(w)).toEqual({ dr: { lat_deg: 39.8, lon_deg: -44.6, sigma_nm: null }, body_bearing: 'auto', curvature: 'predicted', single_altitude: 'maximum' });
    const moving = { ...w, noon: { ...w.noon, drSigmaNm: 10, vessel: { course_deg: 45, speed_kn: 10 } } };
    expect(noonOptionsFor(moving).vessel).toEqual({ course_deg: 45, speed_kn: 10 });
    expect(noonOptionsFor(moving).dr?.sigma_nm).toBe(10);
    expect(noonOptionsFor({ ...w, noon: { ...w.noon, vessel: { course_deg: 45, speed_kn: null } } }).vessel).toBeUndefined();
    const req = runningRequestFor({ ...w, running: { ...w.running, legs: [{ start_utc: null, course_deg: 45, speed_kn: 12 }, { start_utc: '2026-10-01T02:00:00Z', course_deg: 90, speed_kn: 10 }], referenceUtc: '2026-10-01T03:00:00Z' } });
    expect(req.legs).toEqual([{ course_deg: 45, speed_kn: 12 }, { start_utc: '2026-10-01T02:00:00Z', course_deg: 90, speed_kn: 10 }]);
    expect(req.reference_utc).toBe('2026-10-01T03:00:00Z');
    expect(req.motion_uncertainty).toEqual({ speed_sigma_kn: 0, course_sigma_deg: 0, random_walk_nm_per_sqrt_hour: 0 });
  });

  it('builds the lunar distance request, or says what is missing', () => {
    const w = defaultWorking();
    const place = { lat_deg: 23.1443, lon_deg: -103.1079 };
    const missing = lunarInputFor(w, place);
    expect('missing' in missing && missing.missing).toMatch(/measured distance/);
    const ready = lunarInputFor({ ...w, lunar: { ...w.lunar, body: 'Venus', bodyLimb: 'near', distanceDeg: 74.24, watchUtc: '2029-10-17T01:05:43Z', moonAltitude: { deg: 49.27, kind: 'sextant_hs', limb: 'lower' } } }, place);
    if (!('input' in ready)) throw new Error('expected an input');
    expect(ready.input.observer.lat_deg).toBe(23.1443);
    expect(ready.input.body_limb).toBe('center');
    expect(ready.input.moon_altitude).toEqual({ altitude_deg: 49.27, altitude_kind: 'sextant_hs', limb: 'lower', sigma_arcmin: 1 });
    expect(ready.input.body_altitude).toBeNull();
    expect(ready.input.dr_uncertainty_nm).toBe(0);
  });
});

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('round-trips the working state through storage', () => {
    const storage = new MemoryStorage();
    const w = EXAMPLES.find((e) => e.id === 'noon-run')!.build(null);
    expect(saveWorking(storage, w, '2026-09-24T12:00:00.000Z')).toBe(true);
    const loaded = loadWorking(storage);
    expect(loaded.autosave).toBe(true);
    expect(loaded.savedUtc).toBe('2026-09-24T12:00:00.000Z');
    expect(loaded.working).toEqual(w);
  });

  it('drops what is malformed and keeps the rest', () => {
    const raw = {
      session: {
        meta: { kind: 'nonsense' },
        observer: { assumed_position: { lat_deg: 95, lon_deg: 0 }, assumed_position_role: { role: 'prior', sigma_nm: -3 } },
        instrument: { horizon: 'mirror' },
        observations: [obs('a', 'Vega'), { ...obs('b', 'Deneb'), sigma_arcmin: 0 }, obs('a', 'Altair'), { id: 'c', body: 'Mars', utc: 'x', altitude_deg: 'high' }],
      },
      excluded: ['a', 'zzz', 3],
      method: 'dowsing',
      solve: { max_iterations: 1e9 },
    };
    const w = sanitizeWorking(raw)!;
    expect(w.session.observations.map((o) => o.id)).toEqual(['a']);
    expect(w.session.meta.kind).toBe('real');
    expect(w.session.observer.assumed_position).toBeNull();
    expect(w.session.observer.assumed_position_role).toEqual({ role: 'initializer' });
    expect(w.session.instrument.horizon).toBe('sea');
    expect(w.excluded).toEqual(['a']);
    expect(w.method).toBe('fix');
    expect(w.solve.max_iterations).toBe(500);
    expect(sanitizeWorking({ session: { observations: 'no' } })).toBeNull();
    expect(sanitizeSession(null)).toBeNull();
  });

  it('never throws on blocked storage, and remembers only the choice when told to forget', () => {
    expect(loadWorking(new ThrowingStorage())).toEqual({ working: null, autosave: true, savedUtc: null });
    expect(saveWorking(new ThrowingStorage(), defaultWorking(), 'x')).toBe(false);
    const storage = new MemoryStorage();
    saveWorking(storage, defaultWorking({ position: { lat_deg: 39.9, lon_deg: -75.1 } }), 'x');
    forgetWorking(storage, true);
    const left = JSON.parse(storage.getItem(AUTOSAVE_KEY)!);
    expect(left).toEqual({ v: 1, saved_utc: null, autosave: false, working: null });
    expect(storage.dump()).not.toMatch(/39\.9|75\.1/);
  });

  it('saves a moment after a change while on, and stops and forgets when turned off', () => {
    const storage = new MemoryStorage();
    const explorer = createStore({
      observer: { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0, label: '', zone: { kind: 'utc' } },
      settings: { height_of_eye_m: 3, index_correction_arcmin: -1.2 },
    }) as never;
    const handle = createWorking(explorer, { storage, delayMs: 100, now: () => Date.UTC(2026, 8, 24, 12) });
    expect(handle.store.get().session.observer.height_of_eye_m).toBe(3);
    expect(handle.store.get().session.instrument.index_correction_arcmin).toBe(-1.2);
    const addSight = (): void => handle.store.patch({ session: withObservation(handle.store.get().session, obs('obs-1', 'Vega')) });
    addSight();
    expect(storage.getItem(AUTOSAVE_KEY)).toBeNull();
    vi.advanceTimersByTime(150);
    expect(JSON.parse(storage.getItem(AUTOSAVE_KEY)!).working.session.observations).toHaveLength(1);
    expect(handle.autosave.get().savedUtc).toBe('2026-09-24T12:00:00.000Z');
    handle.setAutosave(false);
    expect(JSON.parse(storage.getItem(AUTOSAVE_KEY)!).working).toBeNull();
    handle.store.patch({ method: 'noon' });
    vi.advanceTimersByTime(500);
    expect(JSON.parse(storage.getItem(AUTOSAVE_KEY)!).working).toBeNull();
    handle.dispose();
    const none = createWorking(explorer, { storage: null });
    expect(none.autosave.get()).toMatchObject({ enabled: false, available: false });
    none.dispose();
  });

  it('keeps nothing, not even the place it copied, until the session holds something the person entered', () => {
    const storage = new MemoryStorage();
    const explorer = createStore({
      observer: { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0, label: '', zone: { kind: 'utc' } },
      settings: { height_of_eye_m: 3, index_correction_arcmin: -1.2 },
    }) as never;
    const handle = createWorking(explorer, { storage, delayMs: 100, now: () => Date.UTC(2026, 8, 24, 12) });
    // The new session's assumed position is the map's place: switching methods or taking
    // tonight's bodies to shoot stores nothing.
    expect(handle.store.get().session.observer.assumed_position).toEqual({ lat_deg: 39.9526, lon_deg: -75.1652 });
    handle.store.patch({ method: 'noon' });
    handle.store.patch({ planned: [{ body: 'Vega', kind: 'star', limb: 'center', utc: '2026-09-24T23:30:00Z', hs_deg: 60, hc_deg: 60, zn_deg: 270, from: 'plan' }] });
    vi.advanceTimersByTime(500);
    expect(storage.dump()).not.toMatch(/39\.9526|75\.1652/);
    expect(handle.autosave.get().savedUtc).toBeNull();
    // A sight is the person's own: now the session (with its assumed position) is kept.
    handle.store.patch({ session: withObservation(handle.store.get().session, obs('obs-1', 'Vega')) });
    vi.advanceTimersByTime(150);
    expect(JSON.parse(storage.getItem(AUTOSAVE_KEY)!).working.method).toBe('noon');
    expect(storage.dump()).toMatch(/39\.9526/);
    // Deleting the last sight takes the saved copy away again.
    handle.store.patch({ session: withoutObservation(handle.store.get().session, 'obs-1') });
    vi.advanceTimersByTime(150);
    expect(storage.getItem(AUTOSAVE_KEY)).toBeNull();
    expect(handle.autosave.get().savedUtc).toBeNull();
    handle.dispose();
  });

  it('counts sights, lunar readings, running-fix legs and notes as the person’s own', () => {
    const base = defaultWorking({ position: { lat_deg: 10, lon_deg: 20 } });
    expect(hasOwnData(base)).toBe(false);
    expect(hasOwnData({ ...base, method: 'lunar', planned: [] })).toBe(false);
    expect(hasOwnData({ ...base, session: withObservation(base.session, obs('obs-1', 'Vega')) })).toBe(true);
    expect(hasOwnData({ ...base, lunar: { ...base.lunar, distanceDeg: 45.5 } })).toBe(true);
    expect(hasOwnData({ ...base, running: { ...base.running, legs: [{ start_utc: null, course_deg: 45, speed_kn: 6 }] } })).toBe(true);
    expect(hasOwnData({ ...base, session: { ...base.session, meta: { ...base.session.meta, notes: 'Log p. 12' } } })).toBe(true);
  });
});

describe('map overlays', () => {
  const data = {
    ...emptyOverlayData(),
    circles: [
      { id: 'obs-1', body: 'Vega', kind: 'star' as const, gp: { lat_deg: 38.8, lon_deg: -112.8 }, zenith_distance_deg: 28.9 },
      { id: 'obs-2', body: 'Moon', kind: 'moon' as const, gp: { lat_deg: 27, lon_deg: 91.6 }, zenith_distance_deg: 53 },
    ],
    fix: { lat_deg: 39.95, lon_deg: -75.16 },
    ellipse: { centre: { lat_deg: 39.95, lon_deg: -75.16 }, semi_major_m: 1440, semi_minor_m: 1420, orientation_deg: 119 },
    alternatives: [{ position: { lat_deg: 10, lon_deg: -120 }, delta_chi2: 42.5 }],
  };

  it('builds one labelled, dash-dotted layer per circle, then the ellipse, alternatives and the fix', () => {
    const layers = overlayLayers(data);
    expect(layers.map((l) => l.id)).toEqual(['navigate-cop-1', 'navigate-cop-2', 'navigate-ellipse', 'navigate-alternatives', 'navigate-fix']);
    expect(layers[0]!.style).toMatchObject({ color: '--body-star', dash: '--dash-circle', labelProperty: 'label' });
    expect(layers[1]!.style.color).toBe('--body-moon');
    expect(layers[0]!.data.features[0]!.properties).toMatchObject({ label: 'Vega (circle of position)', sight: 'obs-1' });
    expect(layers[3]!.data.features[0]!.properties).toMatchObject({ label: 'Rejected alternative (Δχ² 42.5)' });
    expect(layers.every((l) => l.id.startsWith(OVERLAY_PREFIX))).toBe(true);
    const ellipse = layers[2]!.data.features[0]!.geometry;
    expect(ellipse.type).toBe('MultiPolygon');
  });

  it('replaces only its own overlays on the map service, and clears them', () => {
    const service = new MapServiceImpl();
    service.addOverlay('events-eclipse', { type: 'FeatureCollection', features: [] });
    publishOverlays(service, data);
    expect(service.overlays().map((o) => o.id)).toContain('navigate-cop-2');
    publishOverlays(service, { ...emptyOverlayData(), candidates: [{ lat_deg: 1, lon_deg: 2 }, { lat_deg: 3, lon_deg: 4 }] });
    const ids = service.overlays().map((o) => o.id);
    expect(ids).toContain('events-eclipse');
    expect(ids).toContain('navigate-candidates');
    expect(ids).not.toContain('navigate-cop-1');
    clearOverlays(service);
    expect(service.overlays().map((o) => o.id)).toEqual(['events-eclipse']);
    expect(publishOverlays(null, data)).toEqual([]);
  });
});

describe('the plot’s framing', () => {
  it('centres a fix and leaves a far assumed position to an arrow', () => {
    const spec = emptyPlotSpec();
    spec.fix = { lat_deg: 39.95, lon_deg: -75.16 };
    spec.ellipse = { centre: spec.fix, ellipse: { semi_major_m: 1440, semi_minor_m: 1420, orientation_deg: 119, confidence: 0.95, model: 'nominal 95 %, independent-noise model' } };
    spec.assumed = { position: { lat_deg: 40.0833, lon_deg: -75.4167 }, role: 'assumed position' };
    expect(assumedIsNear(spec)).toBe(false);
    expect(plotAnchors(spec).some((p) => p.lat_deg === 40.0833)).toBe(false);
    spec.assumed = { position: { lat_deg: 40.0, lon_deg: -75.2 }, role: 'assumed position' };
    expect(assumedIsNear(spec)).toBe(true);
    expect(plotAnchors(spec).some((p) => p.lat_deg === 40.0)).toBe(true);
  });

  it('frames every ambiguous candidate however far apart, and a bare circle by itself', () => {
    const spec = emptyPlotSpec();
    spec.candidates = [{ lat_deg: 39.95, lon_deg: -75.17 }, { lat_deg: 14.18, lon_deg: -130.04 }];
    expect(plotAnchors(spec)).toEqual(spec.candidates);
    const circle = emptyPlotSpec();
    circle.circles = [{ id: 'a', body: 'Vega', points: [{ lat_deg: 1, lon_deg: 2 }, { lat_deg: 3, lon_deg: 4 }] }];
    expect(plotAnchors(circle)).toEqual(circle.circles[0]!.points);
  });
});

describe('example sessions', () => {
  const needsEngine = new Set(['dusk-stars']);

  it('are simulated, say where their numbers come from, and use valid times and unique ids', () => {
    for (const e of EXAMPLES) {
      if (needsEngine.has(e.id)) {
        expect(() => e.build(null)).toThrow(/predicted readings/);
        continue;
      }
      const w = e.build(null);
      expect(w.method).toBe(e.method);
      expect(w.session.meta.kind).toBe('simulated');
      expect(w.session.meta.notes.length).toBeGreaterThan(40);
      const ids = w.session.observations.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of w.session.observations) expect(o.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Every example survives the autosave checks unchanged.
      expect(sanitizeWorking(JSON.parse(JSON.stringify(w)))).toEqual(w);
    }
  });

  it('round-trip through the browser’s CSV (session fields and every sight)', () => {
    for (const e of EXAMPLES) {
      if (needsEngine.has(e.id)) continue;
      const session: Session = e.build(null).session;
      const back = fromCsv(toCsv(session), emptySession());
      expect(back.messages).toEqual([]);
      expect(back.session).toEqual(session);
    }
  });
});
