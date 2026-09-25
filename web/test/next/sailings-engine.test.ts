/**
 * The sailings engine (expansion programme, sailings agent): the type guard, the WASM
 * wrapper's serialisation and rebuild errors, the memoised engine's forwarding, the
 * mock's shapes, and the session-format helpers for the shore horizon and the error
 * logs. Numbers from the real core are checked in Rust (docs/NAVIGATION_METHODS.md 9-11);
 * the last block runs against the built package when there is one (`npm run wasm`).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { horizonDipArcmin, dipShortArcmin, dipArcmin, seaHorizonNm } from '../../src/corrections.js';
import { fromCsv, toCsv } from '../../src/csv.js';
import { emptySession } from '../../src/api/mock.js';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import { isSailingsEngine } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import { sanitizeSession } from '../../src/next/navigate/autosave.js';
import { horizonFromSelect, horizonOptions, horizonText } from '../../src/next/navigate/text.js';
import { asHorizon, horizonLabel, parseHorizonLabel, type Session } from '../../src/types.js';

const EXPORTS = ['sailing', 'dr_advance', 'route_positions', 'star_identify', 'star_finder_geometry'];

describe('the sailings engine contract', () => {
  it('the mock is one, and the memoised engine forwards it', () => {
    const mock = new MockEngine();
    expect(isSailingsEngine(mock)).toBe(true);
    const memo = memoEngine(mock);
    expect(isSailingsEngine(memo)).toBe(true);
    if (!isSailingsEngine(memo)) return;
    const a = memo.starFinderGeometry(40);
    const b = memo.starFinderGeometry(40);
    expect(a).toBe(b);
    expect(isSailingsEngine({ sailing: () => 0 })).toBe(false);
  });

  it('the WASM wrapper sends JSON documents and passes results through', () => {
    const calls: Record<string, unknown[][]> = {};
    const module: Record<string, unknown> = { version: () => '9.9.9' };
    for (const name of EXPORTS) {
      module[name] = (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        return { from: name };
      };
    }
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    const from = { lat_deg: 40, lon_deg: -70 };
    expect(engine.sailing({ from, to: { lat_deg: 50, lon_deg: -5 }, waypoints: { every_nm: 300 } })).toEqual({ from: 'sailing' });
    engine.drAdvance({ from, course_deg: 90, speed_kn: 6, hours: 2 });
    engine.routePositions({ start: from, start_utc: '2026-10-01T00:00:00Z', legs: [{ course_deg: 45, speed_kn: 10 }] });
    engine.starIdentify({ utc: '2026-10-01T00:00:00Z', observer: from, altitude_deg: 30, bearing_deg: 200 });
    engine.starFinderGeometry(-33.9, 2461300.5);
    expect(JSON.parse(calls.sailing![0]![0] as string)).toEqual({ from, to: { lat_deg: 50, lon_deg: -5 }, waypoints: { every_nm: 300 } });
    expect(JSON.parse(calls.dr_advance![0]![0] as string).course_deg).toBe(90);
    expect(calls.star_finder_geometry).toEqual([[-33.9, 2461300.5]]);
  });

  it('a package without the exports says to rebuild', () => {
    const engine = new WasmEngine({ version: () => '0' } as unknown as ExplorerWasmExports);
    expect(() => engine.sailing({ from: { lat_deg: 0, lon_deg: 0 }, to: { lat_deg: 1, lon_deg: 1 } })).toThrow(
      /sailing: .*no sailings\. Rebuild it with: npm run wasm/,
    );
    expect(() => engine.starFinderGeometry(40)).toThrow(/^star_finder_geometry: /);
  });
});

describe('the mock (illustrative, but the right shapes and the textbook numbers)', () => {
  const mock = new MockEngine();

  it('works a Bowditch great-circle example and gives every sailing', () => {
    // Bowditch 2019 ch. 12 section 1208 example 1: 4,693.5 NM, initial course 253.0.
    const r = mock.sailing({ from: { lat_deg: -22, lon_deg: 116 }, to: { lat_deg: -20, lon_deg: 31 }, waypoints: { every_deg_lon: 5 } });
    expect(r.great_circle.distance_nm).toBeCloseTo(4693.53, 1);
    expect(r.great_circle.initial_course_deg!).toBeCloseTo(252.99, 1);
    expect(r.great_circle.waypoints.length).toBeGreaterThan(10);
    expect(r.rhumb_line.distance_nm).toBeGreaterThan(r.great_circle.distance_nm);
    expect(r.mid_latitude).not.toBeNull();
    expect(r.notes.join(' ')).toContain('MOCK');
  });

  it('runs dead reckoning and routes', () => {
    // Bowditch section 1220: 76.5 NM due west at 44 36.3 N gives 33 05.7 W.
    const d = mock.drAdvance({ from: { lat_deg: 44.605, lon_deg: -31.305 }, course_deg: 270, speed_kn: 17, hours: 4.5, start_utc: '2026-10-01T15:30:00Z' });
    expect(-d.to.lon_deg * 60).toBeCloseTo(33 * 60 + 5.7, 0);
    expect(d.arrival_utc).toBe('2026-10-01T20:00:00.000Z');
    const r = mock.routePositions({
      start: { lat_deg: 40, lon_deg: -70 },
      start_utc: '2026-10-01T00:00:00Z',
      legs: [{ course_deg: 90, speed_kn: 10 }, { start_utc: '2026-10-01T03:00:00Z', course_deg: 0, speed_kn: 10 }],
      end_utc: '2026-10-01T06:00:00Z',
      step_minutes: 60,
    });
    expect(r.points).toHaveLength(7);
    expect(r.points[6]!.distance_run_nm).toBeCloseTo(60, 6);
  });

  it('identifies a body from its own direction and draws a star finder', () => {
    const sky = mock.skyState({ lat_deg: 40, lon_deg: -70 }, 2461314.5, 'navigational');
    const star = sky.bodies.find((b) => b.kind === 'star' && b.hc_deg > 20 && b.hc_deg < 70)!;
    const r = mock.starIdentify({
      utc: sky.utc,
      observer: { lat_deg: 40, lon_deg: -70 },
      altitude_deg: star.hc_deg,
      altitude_kind: 'observed_ho',
      bearing_deg: star.zn_deg,
    });
    expect(r.best).toBe(star.body);
    const g = mock.starFinderGeometry(-40);
    expect(g.side).toBe('south');
    expect(g.template_latitude_deg).toBe(-45);
    expect(g.template.altitude_circles).toHaveLength(17);
    expect(g.aries_index).toHaveLength(360);
  });
});

describe('the shore horizon and the error logs in the session format', () => {
  it('labels and parses a shore horizon as the Rust CSV does', () => {
    expect(horizonLabel({ shore: { distance_nm: 1.25 } })).toBe('shore:1.25');
    expect(parseHorizonLabel('shore:1.25')).toEqual({ shore: { distance_nm: 1.25 } });
    expect(parseHorizonLabel('shore:0')).toBeNull();
    expect(parseHorizonLabel('sea')).toBe('sea');
    expect(asHorizon({ shore: { distance_nm: 2 } })).toEqual({ shore: { distance_nm: 2 } });
    expect(asHorizon({ shore: { distance_nm: -2 } })).toBeNull();
  });

  it('keeps a shore horizon and the logs through CSV and autosave', () => {
    const base = emptySession();
    const session: Session = {
      ...base,
      instrument: {
        ...base.instrument,
        horizon: { shore: { distance_nm: 0.8 } },
        index_error_log: [{ utc: '2026-09-01T00:00:00Z', ic_arcmin: -1.2, note: 'before, "cold"' }],
      },
      clock: { ...base.clock, watch_log: [{ utc: '2026-09-01T00:00:00Z', correction_s: 3, note: '' }] },
    };
    const back = fromCsv(toCsv(session), emptySession()).session;
    expect(back.instrument.horizon).toEqual({ shore: { distance_nm: 0.8 } });
    expect(back.instrument.index_error_log).toEqual(session.instrument.index_error_log);
    expect(back.clock.watch_log).toEqual(session.clock.watch_log);
    const saved = sanitizeSession(JSON.parse(JSON.stringify(session)))!;
    expect(saved.instrument.horizon).toEqual({ shore: { distance_nm: 0.8 } });
    expect(saved.instrument.index_error_log).toEqual(session.instrument.index_error_log);
    expect(saved.clock.watch_log).toEqual(session.clock.watch_log);
    // Older sessions carry no logs and gain none.
    const plain = sanitizeSession(JSON.parse(JSON.stringify(base)))!;
    expect('index_error_log' in plain.instrument).toBe(false);
  });

  it('offers a shore horizon only when the session has one, and keeps it', () => {
    const shore = { shore: { distance_nm: 1.5 } };
    expect(horizonOptions('sea').map((o) => o.value)).toEqual(['sea', 'artificial_reflected', 'electronic_vertical']);
    expect(horizonOptions(shore).map((o) => o.value)).toContain('shore');
    expect(horizonFromSelect('shore', shore)).toBe(shore);
    expect(horizonFromSelect('shore', 'sea')).toBeNull();
    expect(horizonText(shore).label).toContain('1.5 NM');
  });

  it('the mock chain uses the dip short as the core does (Bowditch Table 14)', () => {
    // 100 ft (30.48 m) and 0.2 NM: 282.3'. 5 ft (1.524 m) beyond the horizon: the sea dip.
    expect(dipShortArcmin(30.48, 0.2)).toBeCloseTo(282.3, 1);
    expect(seaHorizonNm(1.524)).toBeCloseTo(2.61, 2);
    expect(horizonDipArcmin({ shore: { distance_nm: 5 } }, 1.524)).toBe(dipArcmin(1.524));
    expect(horizonDipArcmin('artificial_reflected', 3)).toBe(0);
  });
});

const PKG = resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm.js');
const hasPkg = existsSync(PKG);

describe.skipIf(!hasPkg)('the built core (npm run wasm)', () => {
  it('answers every sailings export with the documented shapes', async () => {
    const mod = (await import(pathToFileURL(PKG).href)) as Record<string, unknown> & { initSync: (o: { module: Buffer }) => void };
    const { readFileSync } = await import('node:fs');
    mod.initSync({ module: readFileSync(resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm_bg.wasm')) });
    if (typeof mod.sailing !== 'function') return; // a package built before this work
    const engine = new WasmEngine(mod as unknown as ExplorerWasmExports);
    const p = engine.sailing({ from: { lat_deg: -22, lon_deg: 116 }, to: { lat_deg: -20, lon_deg: 31 } });
    expect(p.great_circle.distance_nm).toBeCloseTo(4693.53, 1);
    const g = engine.starFinderGeometry(35);
    expect(g.stars).toHaveLength(58);
    const id = engine.starIdentify({
      utc: '2026-10-01T01:30:00Z',
      observer: { lat_deg: 39.95, lon_deg: -75.17 },
      altitude_deg: 60,
      altitude_kind: 'observed_ho',
      bearing_deg: 270,
    });
    expect(id.candidates.length).toBeGreaterThan(0);
  });
});
