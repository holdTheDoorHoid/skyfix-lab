/**
 * The Sky view's drawing of the astronomy layers (sky2 agent, expansion Q3), with a
 * recording 2D context in place of a canvas: deep-sky symbols and labels, radiants, added
 * bodies, the field of view, a named direction, the RA/Dec grid, the Milky Way's raster,
 * extinction thinning the stars near the horizon, and the night theme's red-only promise;
 * the "Up close" geometry and drawings; the picture's caption.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import { inspectWasmModule, type WasmLoad } from '../../src/next/engine/wasm.js';
import {
  isMoonDetailEngine,
  type DeepSkyEngine,
  type MoonDetailEngine,
  type PlanetDetailEngine,
} from '../../src/next/engine/types.js';
import { PICTURE_FOOTER } from '../../src/next/export/png.js';
import { DEFAULT_LAYERS, type Layers } from '../../src/next/state.js';
import { DEG, limitingMagnitude } from '../../src/next/sky/astro.js';
import { relativeExtinction } from '../../src/next/sky/conditions.js';
import { fovLabel, fovOutline } from '../../src/next/sky/fov.js';
import { readPalette, skyColours, type Rgb, type SkyTheme } from '../../src/next/sky/palette.js';
import { DomeProjector } from '../../src/next/sky/projection.js';
import { pointKey, radiantKey, SkyRenderer, type Frame } from '../../src/next/sky/render.js';
import { SkyScene } from '../../src/next/sky/scene.js';
import { composeSnapshot } from '../../src/next/sky/snapshot.js';
import { drawJupiterInset, drawMoonInset, drawPlanetInset, drawSaturnInset, type InsetFrame } from '../../src/next/sky/upclose-draw.js';
import { globePoint, librationWords, litFraction, litRegion, nearSide, paDirection, skyBasis, toScreen } from '../../src/next/sky/upclose-geometry.js';

const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const T0 = 2_461_308.5 + 2 / 24; // 2026-09-25T02:00Z: a dark evening in Philadelphia

// ---------------------------------------------------------------------------------
// A recording 2D context
// ---------------------------------------------------------------------------------

interface Recorder {
  ctx: CanvasRenderingContext2D;
  calls: { name: string; args: unknown[] }[];
  texts: string[];
  styles: string[];
  count(name: string): number;
}

function recorder(): Recorder {
  const calls: { name: string; args: unknown[] }[] = [];
  const texts: string[] = [];
  const styles: string[] = [];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    letterSpacing: '0px',
  };
  const own: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  const ctx = new Proxy(
    {},
    {
      has: (_t, p) => typeof p === 'string' && (p in state || p in own),
      get(_t, p) {
        if (typeof p !== 'string') return undefined;
        if (p in own) return own[p];
        if (p in state) return state[p];
        return (...args: unknown[]) => {
          calls.push({ name: p, args });
          if (p === 'fillText') texts.push(String(args[0]));
        };
      },
      set(_t, p, v) {
        if (typeof p === 'string') {
          state[p] = v;
          if ((p === 'fillStyle' || p === 'strokeStyle') && typeof v === 'string') styles.push(v);
        }
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, calls, texts, styles, count: (name) => calls.filter((c) => c.name === name).length };
}

// ---------------------------------------------------------------------------------
// The design tokens, as the palette test reads them
// ---------------------------------------------------------------------------------

const CSS = readFileSync(resolve(import.meta.dirname, '../../src/next/theme/tokens.css'), 'utf8');

function readVarFor(theme: SkyTheme): (name: string) => string {
  const shared = new Map<string, string>();
  const own = new Map<string, string>();
  const text = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1]!.trim();
    const t = /data-theme='(\w+)'/.exec(selector)?.[1] ?? (selector.startsWith(':root') ? 'shared' : null);
    const target = t === 'shared' ? shared : t === theme ? own : null;
    if (!target) continue;
    for (const d of m[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) target.set(d[1]!, d[2]!.trim().replace(/\s+/g, ' '));
  }
  const tokens = new Map([...shared, ...own]);
  return (name) => tokens.get(name) ?? '';
}

function parseRgb(css: string): Rgb | null {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(css);
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
}

const nightSafe = (c: Rgb): boolean => c.b === 0 && c.g <= 0x50 && c.g <= c.r;

// ---------------------------------------------------------------------------------
// A frame over the mock engine
// ---------------------------------------------------------------------------------

function frameFor(theme: SkyTheme, layers: Partial<Layers>, extras: Partial<Frame> = {}, extinction = false): { frame: Frame; scene: SkyScene } {
  const engine = new MockEngine({ syntheticStars: 1500 }) as MockEngine & DeepSkyEngine;
  const scene = new SkyScene();
  scene.setCatalog(engine.starfieldCatalog(), engine.constellationBoundaries());
  const all = { ...DEFAULT_LAYERS, ...layers };
  scene.update(engine, PHILLY, T0, {
    boundaries: all.constellationBoundaries,
    constellationLabels: all.constellationNames,
    equator: all.equator,
    ecliptic: all.ecliptic,
    raDecGrid: all.raDecGrid,
    deepSky: all.deepSky,
  });
  const dome = new DomeProjector();
  dome.configure(450, 420, 390, false);
  const ext = extinction ? relativeExtinction(engine.extinction()) : null;
  scene.project(dome, 900, 840, 24, ext);
  if (all.deepSky) scene.dso.project(dome, 900, 840, 8.5, ext);
  const palette = readPalette(theme, readVarFor(theme));
  const sky = engine.skyState(PHILLY, T0, 'solar_system');
  const frame: Frame = {
    width: 900,
    height: 840,
    projector: dome,
    scene,
    sky,
    layers: all,
    palette,
    colours: skyColours(sky.sun_altitude_deg, palette),
    limitMag: limitingMagnitude(sky.sun_altitude_deg),
    zoom: 1,
    selectedKey: null,
    highlightKeys: new Set(),
    focusKey: null,
    hoverKey: null,
    path: null,
    dso: all.deepSky ? scene.dso : null,
    ...extras,
  };
  return { frame, scene };
}

describe('drawing the astronomy layers', () => {
  it('draws deep-sky symbols with their labels, radiants, added bodies, the field of view, a named point and the RA/Dec grid', () => {
    const out = new Float64Array(3 * 200);
    const d = [0, Math.cos(40 * DEG), Math.sin(40 * DEG)];
    const count = fovOutline(d, { diameterDeg: 7.1 }, out);
    const { frame } = frameFor('dark', { deepSky: true, raDecGrid: true }, {
      radiants: [{ key: radiantKey('PER'), code: 'PER', name: 'Perseids', alt: 30 * DEG, az: 45 * DEG, rate: 'about 40 an hour', strength: 1, x: 0, y: 0, drawn: false }],
      custom: [
        { key: 'c:(1) Ceres', name: '(1) Ceres', kind: 'asteroid', alt: 50 * DEG, az: 200 * DEG, magnitude: 8, sunward: null, x: 0, y: 0, drawn: false },
        { key: 'c:C/2026 A1', name: 'C/2026 A1', kind: 'comet', alt: 25 * DEG, az: 280 * DEG, magnitude: 9, sunward: { alt: 24 * DEG, az: 281 * DEG }, x: 0, y: 0, drawn: false },
      ],
      fov: { points: out, count, label: fovLabel({ preset: 'bino7x50', focalMm: 50, sensorId: 'ff', anchor: 'target' }) },
      point: { key: pointKey, label: 'Galactic centre', alt: 20 * DEG, az: 190 * DEG },
      milkyWay: { source: {} as CanvasImageSource, width: 100, height: 90, cell: 9 },
    });
    const r = recorder();
    const renderer = new SkyRenderer(r.ctx);
    renderer.draw(frame);
    expect(frame.dso!.catalog.length).toBeGreaterThan(10);
    const shown = frame.dso!.catalog.filter((_, i) => frame.dso!.on[i] === 1);
    expect(shown.length).toBeGreaterThan(3);
    // Galaxies are ellipses; the labels are the catalogue's ("M31").
    expect(r.count('ellipse')).toBeGreaterThan(0);
    const labelled = shown.filter((o) => r.texts.includes(o.label));
    expect(labelled.length).toBeGreaterThan(0);
    expect(r.texts).toContain('Perseids · about 40 an hour');
    expect(r.texts).toContain('(1) Ceres');
    expect(r.texts).toContain('C/2026 A1');
    expect(r.texts).toContain('Binoculars 7×50 · 7.1°');
    expect(r.texts).toContain('Galactic centre');
    expect(r.texts.some((t) => /^\d{1,2}h$/.test(t))).toBe(true); // hours on the equator
    expect(r.texts.some((t) => /^[+−]\d0°$/.test(t))).toBe(true); // declinations up the meridian
    // The Milky Way's raster is drawn scaled up, once, before the stars.
    const draws = r.calls.filter((c) => c.name === 'drawImage');
    expect(draws.length).toBeGreaterThanOrEqual(1);
    expect(draws[0]!.args.slice(5)).toEqual([0, 0, 900, 810]);
    // Marks are where the renderer says.
    expect(frame.radiants![0]!.drawn).toBe(true);
    expect(renderer.locate(frame, radiantKey('PER'))).not.toBeNull();
    expect(renderer.locate(frame, pointKey)?.alt).toBeCloseTo(20 * DEG, 9);
    expect(renderer.locate(frame, 'd:0')).not.toBeNull();
  });

  it('thins the stars near the horizon when extinction is on', () => {
    const drawn = (extinction: boolean): number => {
      const { frame } = frameFor('dark', { deepSky: false, constellations: false, starNames: false }, {}, extinction);
      const r = recorder();
      new SkyRenderer(r.ctx).draw(frame);
      return r.count('rect') + r.count('arc');
    };
    const plain = drawn(false);
    const dimmed = drawn(true);
    expect(dimmed).toBeLessThan(plain);
    expect(dimmed).toBeGreaterThan(plain * 0.5);
  });

  it('keeps the night theme red: every colour the new layers draw with has no blue and little green', () => {
    const p = readPalette('night', readVarFor('night'));
    for (const c of [p.dso.galaxy, p.dso.nebula, p.dso.cluster, p.dso.other, p.raDec, p.milkyWay, p.radiant, p.custom]) {
      expect(nightSafe({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) })).toBe(true);
    }
    const { frame } = frameFor('night', { deepSky: true, raDecGrid: true }, {
      radiants: [{ key: radiantKey('ORI'), code: 'ORI', name: 'Orionids', alt: 30 * DEG, az: 80 * DEG, rate: '', strength: 0.5, x: 0, y: 0, drawn: false }],
      custom: [{ key: 'c:x', name: 'x', kind: 'comet', alt: 30 * DEG, az: 100 * DEG, magnitude: null, sunward: { alt: 29 * DEG, az: 101 * DEG }, x: 0, y: 0, drawn: false }],
      point: { key: pointKey, label: 'Galactic centre', alt: 20 * DEG, az: 190 * DEG },
    });
    const r = recorder();
    new SkyRenderer(r.ctx).draw(frame);
    const colours = r.styles.map(parseRgb).filter((c): c is Rgb => c !== null);
    expect(colours.length).toBeGreaterThan(20);
    for (const c of colours) expect(nightSafe(c)).toBe(true);
  });

  it('gives each theme distinct layer colours derived from the tokens', () => {
    for (const theme of ['light', 'dark'] as const) {
      const p = readPalette(theme, readVarFor(theme));
      const key = (c: Rgb): string => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;
      const set = new Set([p.dso.galaxy, p.dso.nebula, p.dso.cluster, p.raDec, p.radiant].map(key));
      expect(set.size).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------------
// Up close
// ---------------------------------------------------------------------------------

describe('up-close geometry (upclose-geometry.ts)', () => {
  it('lays the sky out north up, south up, mirrored and as seen', () => {
    const north = skyBasis('north', false, null);
    expect(toScreen(north, 1, 0)).toEqual({ x: -1, y: 0 }); // east to the left
    expect(toScreen(north, 0, 1)).toEqual({ x: 0, y: -1 }); // north up
    const south = skyBasis('south', false, null);
    expect(toScreen(south, 1, 0)).toEqual({ x: 1, y: 0 });
    expect(toScreen(south, 0, 1)).toEqual({ x: 0, y: 1 });
    const mirrored = skyBasis('north', true, null);
    expect(toScreen(mirrored, 1, 0)).toEqual({ x: 1, y: 0 });
    expect(toScreen(mirrored, 0, 1).y).toBe(-1);
    // As seen with the zenith at position angle 90° (east): east is up.
    const seen = skyBasis('seen', false, 90);
    const e = toScreen(seen, 1, 0);
    expect(e.x).toBeCloseTo(0, 12);
    expect(e.y).toBeCloseTo(-1, 12);
    // Without a parallactic angle, "as seen" is north up.
    expect(skyBasis('seen', false, null)).toEqual(north);
    const pa = paDirection(north, 90);
    expect(pa.x).toBeCloseTo(-1, 12);
  });

  it('puts a globe’s points on its disc: the centre, the pole, Mare Crisium’s side on the sky’s west', () => {
    expect(globePoint(3, -7, 3, -7, 20)).toMatchObject({ visible: true });
    const c = globePoint(3, -7, 3, -7, 20);
    expect(Math.hypot(c.east, c.north)).toBeCloseTo(0, 12);
    const pole = globePoint(90, 0, 0, 0, 0);
    expect(pole.north).toBeCloseTo(1, 12);
    const crisium = globePoint(0, 90, 0, 0, 0, true);
    expect(crisium.east).toBeCloseTo(-1, 12);
    const planet = globePoint(0, 90, 0, 0, 0, false);
    expect(planet.east).toBeCloseTo(1, 12);
    expect(globePoint(0, 180, 0, 0, 0).visible).toBe(false);
  });

  it('lights the disc from the sub-solar point', () => {
    const b = skyBasis('north', false, null);
    expect(litRegion(b, { east: 0, north: 0 }, true).xt).toBe(-1);
    expect(litFraction(litRegion(b, { east: 0, north: 0 }, false).xt)).toBe(0);
    const half = litRegion(b, { east: 1, north: 0 }, true);
    expect(half.xt).toBeCloseTo(0, 12);
    expect(half.dirX).toBeCloseTo(-1, 12); // lit toward the east, the left
    const gibbous = litRegion(b, { east: 0.6, north: 0 }, true);
    expect(litFraction(gibbous.xt)).toBeCloseTo(0.9, 9);
    expect(nearSide(-7.8)).toBe(1);
    expect(nearSide(12)).toBe(-1);
    expect(librationWords(0.1, -0.2)).toMatch(/squarely/);
    expect(librationWords(-5, -0.7)).toBe('Tipped to show more of its western edge (the Grimaldi side), by 5.0°, and of its south pole, by 0.7°.');
  });
});

function inset(theme: SkyTheme, w = 280, h = 280): { f: InsetFrame; r: Recorder } {
  const r = recorder();
  return { r, f: { ctx: r.ctx, width: w, height: h, basis: skyBasis('north', false, null), palette: readPalette(theme, readVarFor(theme)) } };
}

describe('up-close drawings (upclose-draw.ts) on the mock engine', () => {
  const engine = new MockEngine({ syntheticStars: 10 }) as unknown as MoonDetailEngine & PlanetDetailEngine;

  it('draws the Moon with the features near the terminator, the requested ones first', () => {
    const jd = 2_461_315.2; // a waxing gibbous Moon
    const o = engine.moonOrientation(PHILLY, jd);
    const feats = engine.moonFeatures(PHILLY, jd);
    const { f, r } = inset('dark');
    const plain = drawMoonInset(f, o, feats);
    expect(plain.labelled.length).toBeGreaterThan(0);
    for (const n of plain.labelled) expect(r.texts).toContain(n);
    const visible = feats.features.filter((x) => x.disc.visible).map((x) => x.name);
    const wanted = visible[visible.length - 1]!;
    const { f: f2 } = inset('dark');
    const marked = drawMoonInset(f2, o, feats, { highlight: [wanted] });
    expect(marked.labelled[0]).toBe(wanted);
    expect(r.texts).toContain('N');
    expect(r.texts).toContain('E');
  });

  it('draws Jupiter’s four moons by name, and Saturn’s rings, and a planet’s phase', () => {
    const jd = 2_461_309.9;
    const { f, r } = inset('dark', 300, 270);
    const res = drawJupiterInset(f, engine.galileanMoons(jd));
    for (const m of ['Io', 'Europa', 'Ganymede', 'Callisto']) expect(r.texts).toContain(m);
    expect(Array.isArray(res.words)).toBe(true);
    const { f: fs, r: rs } = inset('light', 300, 190);
    drawSaturnInset(fs, engine.saturnRings(jd), engine.planetDisc('Saturn', jd));
    expect(rs.count('ellipse')).toBeGreaterThan(5);
    expect(rs.texts).toContain('10″');
    const { f: fv, r: rv } = inset('night', 240, 220);
    drawPlanetInset(fv, engine.planetDisc('Venus', jd), 'venus');
    expect(rv.count('arc')).toBeGreaterThan(1);
    for (const c of rv.styles.map(parseRgb).filter((x): x is Rgb => x !== null)) expect(nightSafe(c)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------------

describe('the picture (snapshot.ts)', () => {
  it('adds the caption under the sky: what, where, when, and the site’s line', () => {
    const recorders: Recorder[] = [];
    const make = (w: number, h: number): HTMLCanvasElement => {
      const r = recorder();
      recorders.push(r);
      return { width: w, height: h, getContext: () => r.ctx } as unknown as HTMLCanvasElement;
    };
    const source = { width: 1800, height: 1000 } as unknown as HTMLCanvasElement;
    const pal = readPalette('dark', readVarFor('dark'));
    const out = composeSnapshot(source, 2, { title: 'The sky from Philadelphia City Hall', lines: ['Fri 25 Sep 2026 22:00 EDT · 02:00 UTC', 'The whole sky, north at the top'] }, pal, make);
    expect(out.width).toBe(1800);
    expect(out.height).toBeGreaterThan(1000 + 2 * 60);
    const drawn = recorders[recorders.length - 1]!;
    expect(drawn.calls[0]!.name).toBe('drawImage');
    expect(drawn.texts).toContain('The sky from Philadelphia City Hall');
    expect(drawn.texts.join(' ')).toContain('02:00 UTC');
    expect(drawn.texts.join(' ').replace(/\s+/g, ' ')).toContain(PICTURE_FOOTER.split(' · ')[0]!);
  });
});

// ---------------------------------------------------------------------------------
// The built WebAssembly package: the close-up's projection is the engine's own
// ---------------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');

describe.skipIf(!(existsSync(WASM_FILE) && existsSync(GLUE_FILE)))('the close-up on the built WebAssembly package', () => {
  let load: WasmLoad;
  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as { initSync: (i: { module: BufferSource }) => unknown; init?: () => void };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    load = inspectWasmModule(glue);
  });

  it('places every named feature where moon_features does (1e-9 disc radii), and turns it as the engine does', ({ skip }) => {
    if (load.status !== 'ready' || !isMoonDetailEngine(load.engine)) return skip();
    const engine = load.engine;
    for (const jd of [2_461_308.5, 2_461_315.2, 2_461_330.9]) {
      for (const observer of [null, PHILLY]) {
        const o = engine.moonOrientation(observer, jd);
        const feats = engine.moonFeatures(observer, jd);
        const basis = observer ? skyBasis('seen', false, o.parallactic_angle_deg) : skyBasis('north', false, null);
        for (const x of feats.features) {
          const g = globePoint(x.lat_deg, x.lon_deg, o.sub_observer.lat_deg, o.sub_observer.lon_deg, o.axis_position_angle_deg, true);
          expect(Math.hypot(g.east - x.disc.east, g.north - x.disc.north)).toBeLessThan(1e-9);
          const s = toScreen(basis, x.disc.east, x.disc.north);
          // DiscPoint x/y: x right, y up.
          expect(Math.hypot(s.x - x.disc.x, -s.y - x.disc.y)).toBeLessThan(1e-9);
        }
      }
    }
  });
});
