/**
 * DEVELOPER PAGE for the residual heat map (`/next/dev-misfit.html`). OWNER: misfit agent.
 * Nothing outside `misfit/dev/` imports this.
 *
 * Every packaged demo is simulated, solved and mapped with `engine.misfit.misfitGrid`, then
 * drawn with the pieces the Navigate and Learn views will use (web/src/next/misfit/): the
 * heat under a simple chart projection, the level lines, the caption; plus, from the solve,
 * the circles of position and the fix or the candidates, and the simulated truth. Two extra
 * cards solve the bias demo with the bias estimated and the bad-sight demo with robust
 * weighting. Everything is settable from the address fragment, for screenshots:
 *
 *   #theme=dark&demo=two-sight-ambiguous&levels=all&n=200&path=cells&compact
 *
 * `?engine=mock` runs the mock engine on the workbench mock's demos.
 */

import '../../theme/index.js';
import './dev-misfit.css';
import type { DemoEntry, SkyfixApi } from '../../../api/adapter.js';
import { MockApi } from '../../../api/mock.js';
import { WasmApi } from '../../../api/wasm.js';
import { circleOfPosition } from '../../../geometry.js';
import type { FixResult, LatLon, Session, SolveOptions, Truth } from '../../../types.js';
import { defaultSolveOptions } from '../../../types.js';
import { selectEngine } from '../../engine/index.js';
import type { ExplorerEngine, LatLonDeg, MisfitGrid, MisfitLevelName } from '../../engine/types.js';
import { applyTheme, type ThemeName } from '../../theme/theme.js';
import { tokenColor } from '../../theme/tokens.js';
import { misfitCaption } from '../caption.js';
import { misfitContours } from '../contours.js';
import { DEFAULT_LEVELS, wrap180 } from '../grid.js';
import { drawMisfitHeat, drawMisfitLines, type HeatProjection } from '../heat.js';
import { heatScale, rampGradient, themeRamp } from '../ramp.js';

interface Case {
  id: string;
  demo: string;
  title: string;
  options: Partial<SolveOptions>;
}

interface Computed {
  c: Case;
  truth: Truth | null;
  fix: FixResult | null;
  grid: MisfitGrid | null;
  error: string | null;
  ms: number;
}

const THEMES: ThemeName[] = ['light', 'dark', 'night'];
const LEVEL_TEXT: Record<MisfitLevelName, string> = { one_sigma: '1σ', p95: '95 %', three_sigma: '3σ' };

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

function setParam(name: string, value: string | null): void {
  const p = params();
  if (value === null) p.delete(name);
  else p.set(name, value);
  location.hash = p.toString();
}

/** The cards: every packaged demo, and the two that change the model. */
function cases(demos: DemoEntry[]): Case[] {
  const out: Case[] = [];
  for (const d of demos) {
    out.push({ id: d.name, demo: d.name, title: d.name, options: {} });
    if (d.name === 'one-bad-sight') {
      out.push({ id: 'one-bad-sight+robust', demo: d.name, title: 'one-bad-sight, robust', options: { robust: { huber_k: 1.5, max_reweight_iterations: 10 } } });
    }
    if (d.name === 'shared-bias') {
      out.push({ id: 'shared-bias+bias', demo: d.name, title: 'shared-bias, bias estimated', options: { estimate_shared_bias: true } });
    }
  }
  return out;
}

/** The overview leaves out the two variants of demo 1 (same geometry as philadelphia-stars). */
const OVERVIEW_SKIP = new Set(['philadelphia-stars-real', 'philadelphia-stars-sextant']);

/**
 * A plain chart projection fitted to the grid's box: equirectangular with east-west
 * shortened by cos(latitude) at the middle of the box, so circles look round there.
 */
function chartProjection(grid: MisfitGrid, width: number, height: number, pad = 8): HeatProjection & { nmPerPx: number } {
  const b = grid.bounds;
  const lat0 = (b.south_deg + b.north_deg) / 2;
  const lon0 = (b.west_deg + b.east_deg) / 2;
  const k = Math.max(0.05, Math.cos((lat0 * Math.PI) / 180));
  const s = Math.min((width - 2 * pad) / ((b.east_deg - b.west_deg) * k), (height - 2 * pad) / (b.north_deg - b.south_deg));
  return {
    nmPerPx: 60 / s,
    project(p: LatLonDeg) {
      const dLon = wrap180(p.lon_deg - lon0);
      return [width / 2 + dLon * k * s, height / 2 - (p.lat_deg - lat0) * s] as const;
    },
    unproject(x: number, y: number) {
      const lat = lat0 - (y - height / 2) / s;
      if (lat < -90 || lat > 90) return null;
      return { lat_deg: lat, lon_deg: wrap180(lon0 + (x - width / 2) / (k * s)) };
    },
  };
}

function niceNm(maxNm: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  return steps.filter((v) => v <= maxNm).at(-1) ?? steps[0]!;
}

function draw(canvas: HTMLCanvasElement, r: Computed, levels: readonly MisfitLevelName[], cells: boolean): void {
  const grid = r.grid!;
  const ratio = globalThis.devicePixelRatio || 1;
  const width = canvas.clientWidth || 340;
  const height = canvas.clientHeight || 280;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = tokenColor('--stage-surface-2', '#f2f5f7');
  ctx.fillRect(0, 0, width, height);
  const chart = chartProjection(grid, width, height);
  const projection: HeatProjection = cells ? { project: chart.project } : chart;
  drawMisfitHeat(ctx, grid, projection, { ramp: themeRamp(), rect: { x: 0, y: 0, width, height }, pixelRatio: ratio });

  // Circles of position: thin and dash-dotted, with a light casing, so a session of 24
  // sights does not bury the heat.
  const circles = r.fix && r.fix.kind !== 'failed' ? r.fix.circles : [];
  ctx.save();
  ctx.lineJoin = 'round';
  for (const [stroke, lw, dash, alpha] of [
    [tokenColor('--line-halo', 'rgba(0,0,0,0.8)'), 2.2, [] as number[], 0.35],
    [tokenColor('--stage-line-strong', '#7c8894'), 1, [10, 4, 2, 4], 0.95],
  ] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.globalAlpha = alpha;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (const c of circles) {
      let prev: readonly [number, number] | null = null;
      for (const p of circleOfPosition(c.gp, c.zenith_distance_deg, 2880).map((q) => chart.project(q))) {
        if (!p) continue;
        if (prev && Math.abs(p[0] - prev[0]) < width / 2) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
        prev = p;
      }
    }
    ctx.stroke();
  }
  ctx.restore();

  drawMisfitLines(ctx, misfitContours(grid, levels), chart);

  // The fix (ringed dot), ambiguous candidates (diamonds), the simulated truth (a cross).
  const ink = tokenColor('--observer', '#17202a');
  const ring = tokenColor('--observer-ring', '#ffffff');
  const mark = (p: LatLon, shape: 'fix' | 'candidate' | 'truth'): void => {
    const at = chart.project(p);
    if (!at || at[0] < 0 || at[1] < 0 || at[0] > width || at[1] > height) return;
    const [x, y] = at;
    ctx.save();
    ctx.lineWidth = 2;
    if (shape === 'fix') {
      ctx.fillStyle = ink;
      ctx.strokeStyle = ring;
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, 2 * Math.PI);
      ctx.fillStyle = ring;
      ctx.fill();
    } else if (shape === 'candidate') {
      ctx.fillStyle = ink;
      ctx.strokeStyle = ring;
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      for (const [stroke, lw] of [
        [ring, 4],
        [ink, 2],
      ] as const) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 5);
        ctx.lineTo(x + 5, y + 5);
        ctx.moveTo(x + 5, y - 5);
        ctx.lineTo(x - 5, y + 5);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  if (r.truth) {
    const at = chart.project(r.truth.position);
    if (at && at[0] >= 0 && at[1] >= 0 && at[0] <= width && at[1] <= height) mark(r.truth.position, 'truth');
    else if (at) offFrame(ctx, at, width, height, r.truth.position, grid);
  }
  if (r.fix?.kind === 'unique') mark(r.fix.fix.position, 'fix');
  if (r.fix?.kind === 'ambiguous') for (const c of r.fix.candidates) if (c.delta_chi2_from_best <= 5.99) mark(c.position, 'candidate');

  // Scale bar.
  const nm = niceNm(0.3 * width * chart.nmPerPx);
  const px = nm / chart.nmPerPx;
  ctx.save();
  ctx.fillStyle = tokenColor('--stage-surface', '#ffffff');
  ctx.globalAlpha = 0.85;
  ctx.fillRect(6, height - 26, px + 16, 20);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tokenColor('--stage-ink', '#17202a');
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(14, height - 12);
  ctx.lineTo(14 + px, height - 12);
  ctx.stroke();
  ctx.font = `600 10px ${getComputedStyle(document.body).fontFamily}`;
  ctx.fillText(`${nm} NM`, 14, height - 16);
  ctx.restore();
}

/** An arrow on the frame's edge pointing at a simulated truth outside it, with its distance. */
function offFrame(ctx: CanvasRenderingContext2D, at: readonly [number, number], width: number, height: number, truth: LatLon, grid: MisfitGrid): void {
  const cx = width / 2;
  const cy = height / 2;
  const dx = at[0] - cx;
  const dy = at[1] - cy;
  const f = Math.min((width / 2 - 14) / Math.abs(dx || 1e-9), (height / 2 - 14) / Math.abs(dy || 1e-9));
  const x = cx + dx * f;
  const y = cy + dy * f;
  const angle = Math.atan2(dy, dx);
  const r = Math.PI / 180;
  const cosd = Math.sin(grid.min.lat_deg * r) * Math.sin(truth.lat_deg * r) + Math.cos(grid.min.lat_deg * r) * Math.cos(truth.lat_deg * r) * Math.cos((truth.lon_deg - grid.min.lon_deg) * r);
  const nm = (Math.acos(Math.min(1, Math.max(-1, cosd))) * 10800) / Math.PI;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = tokenColor('--observer', '#17202a');
  ctx.strokeStyle = tokenColor('--observer-ring', '#ffffff');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-6, -6);
  ctx.lineTo(-6, 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.font = `600 10px ${getComputedStyle(document.body).fontFamily}`;
  const text = `truth ${nm.toFixed(1)} NM`;
  const w = ctx.measureText(text).width;
  const tx = Math.min(Math.max(x - w / 2, 4), width - w - 4);
  const ty = y > height / 2 ? y - 12 : y + 20;
  ctx.fillStyle = tokenColor('--stage-surface', '#ffffff');
  ctx.globalAlpha = 0.85;
  ctx.fillRect(tx - 3, ty - 10, w + 6, 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = tokenColor('--stage-ink', '#17202a');
  ctx.fillText(text, tx, ty);
  ctx.restore();
}

function big(x: number): string {
  return x >= 1e6 ? x.toExponential(1) : Math.round(x).toLocaleString('en-US');
}

function legend(grid: MisfitGrid, levels: readonly MisfitLevelName[]): HTMLElement {
  const scale = heatScale(grid);
  const bar = document.createElement('div');
  bar.className = 'dmf-ramp';
  bar.style.background = rampGradient(themeRamp());
  let k = 0;
  for (const level of grid.levels) {
    if (!levels.includes(level.name)) continue;
    const tick = document.createElement('div');
    // Labels alternate below and above the bar, so close levels do not collide.
    tick.className = k++ % 2 === 0 ? 'dmf-tick' : 'dmf-tick dmf-tick--up';
    tick.style.left = `${(100 * scale.t(level.chi2)).toFixed(2)}%`;
    const label = document.createElement('span');
    label.textContent = LEVEL_TEXT[level.name];
    tick.append(label);
    bar.append(tick);
  }
  const wrap = document.createElement('div');
  wrap.className = 'dmf-legend';
  const left = document.createElement('span');
  left.textContent = 'best fit';
  const right = document.createElement('span');
  right.textContent = `Δχ² ≥ ${big(scale.maxDelta)}`;
  wrap.append(left, bar, right);
  return wrap;
}

function card(r: Computed, opts: { levels: readonly MisfitLevelName[]; cells: boolean; compact: boolean; single: boolean }): HTMLElement {
  const el = document.createElement('section');
  el.className = 'dmf-card';
  const head = document.createElement('div');
  head.className = 'dmf-head';
  const h2 = document.createElement('h2');
  h2.textContent = r.c.title;
  const kind = document.createElement('span');
  kind.className = 'dmf-kind';
  kind.textContent = r.grid?.solve_kind ?? r.fix?.kind ?? 'error';
  head.append(h2, kind);
  el.append(head);
  if (!r.grid) {
    const p = document.createElement('p');
    p.className = 'dmf-error';
    p.textContent = r.error ?? 'no grid';
    el.append(p);
    return el;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'dmf-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Misfit heat map of ${r.c.title}. ${misfitCaption(r.grid, { levels: opts.levels })}`);
  if (opts.single) {
    // One demo: the canvas takes the grid's own shape (within reason), at most 600 px tall.
    const b = r.grid.bounds;
    const k = Math.max(0.05, Math.cos((((b.south_deg + b.north_deg) / 2) * Math.PI) / 180));
    const aspect = Math.min(2.2, Math.max(1, ((b.east_deg - b.west_deg) * k) / (b.north_deg - b.south_deg)));
    canvas.style.aspectRatio = aspect.toFixed(3);
    canvas.style.maxWidth = `${Math.round(600 * aspect)}px`;
    canvas.style.margin = '0 auto';
  }
  el.append(canvas, legend(r.grid, opts.levels));
  const g = r.grid;
  const stats = document.createElement('p');
  stats.className = 'dmf-stats';
  stats.textContent =
    `${g.n_lat}×${g.n_lon} · ${g.sights.length} sights · dof ${g.dof} · best χ² ${g.min.chi2.toFixed(2)} · ` +
    `frame ${((g.bounds.north_deg - g.bounds.south_deg) * 60).toFixed(g.bounds.north_deg - g.bounds.south_deg < 1 ? 1 : 0)} NM tall` +
    // Headless screenshots run on virtual time, where nothing takes any time.
    (r.ms >= 0.5 ? ` · ${r.ms.toFixed(0)} ms` : '');
  if (!opts.compact) {
    const caption = document.createElement('p');
    caption.className = 'dmf-caption';
    caption.textContent = misfitCaption(g, { levels: opts.levels });
    el.append(caption, stats);
    if (g.notes.length) {
      const ul = document.createElement('ul');
      ul.className = 'dmf-notes';
      for (const n of g.notes) {
        const li = document.createElement('li');
        li.textContent = n;
        ul.append(li);
      }
      el.append(ul);
    }
  } else {
    el.append(stats);
  }
  requestAnimationFrame(() => draw(canvas, r, opts.levels, opts.cells));
  return el;
}

async function compute(engine: ExplorerEngine, api: SkyfixApi, demos: DemoEntry[], c: Case, n: number): Promise<Computed> {
  const demo = demos.find((d) => d.name === c.demo)!;
  try {
    const sim = await api.simulate(demo.scenario);
    const options = { ...defaultSolveOptions(), ...c.options };
    const fix = await api.solve(sim.session, options, 'auto');
    const t = performance.now();
    const grid = engine.misfit!.misfitGrid(sim.session as Session, 'auto', c.options, null, n, n);
    return { c, truth: sim.truth, fix, grid, error: null, ms: performance.now() - t };
  } catch (error) {
    return { c, truth: null, fix: null, grid: null, error: error instanceof Error ? error.message : String(error), ms: 0 };
  }
}

function toolbar(engine: ExplorerEngine): HTMLElement {
  const p = params();
  const bar = document.createElement('header');
  bar.className = 'dmf-bar';
  const h1 = document.createElement('h1');
  h1.textContent = 'Misfit grid · developer page';
  const engineNote = document.createElement('span');
  engineNote.className = 'dmf-engine';
  engineNote.textContent = engine.kind === 'wasm' ? 'Real core (WebAssembly). Demos are simulations.' : 'MOCK engine: illustrative only.';
  const group = (label: string, name: string, values: string[], current: string): HTMLElement => {
    const g = document.createElement('span');
    g.className = 'dmf-group';
    g.append(`${label}:`);
    for (const v of values) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v;
      b.setAttribute('aria-pressed', String(v === current));
      // The hash change redraws the page.
      b.addEventListener('click', () => setParam(name, v));
      g.append(b);
    }
    return g;
  };
  bar.append(
    h1,
    engineNote,
    group('Theme', 'theme', THEMES, p.get('theme') ?? 'light'),
    group('Lines', 'levels', ['default', 'all'], p.get('levels') === 'all' ? 'all' : 'default'),
    group('Drawing', 'path', ['pixels', 'cells'], p.get('path') === 'cells' ? 'cells' : 'pixels'),
  );
  return bar;
}

async function boot(root: HTMLElement): Promise<void> {
  const selection = await selectEngine();
  const engine = selection.engine;
  const api: SkyfixApi = engine.kind === 'wasm' ? await WasmApi.load() : new MockApi();
  const demos = await api.demos();
  const all = cases(demos);
  const results = new Map<string, Computed>();
  let computedFor = '';

  const render = async (): Promise<void> => {
    const p = params();
    const theme = (THEMES as string[]).includes(p.get('theme') ?? '') ? (p.get('theme') as ThemeName) : 'light';
    applyTheme(theme);
    const levels: readonly MisfitLevelName[] = p.get('levels') === 'all' ? ['one_sigma', 'p95', 'three_sigma'] : DEFAULT_LEVELS;
    const cells = p.get('path') === 'cells';
    const compact = p.has('compact');
    const single = p.get('demo');
    const n = Math.min(1024, Math.max(2, Number(p.get('n')) || (single ? 220 : 160)));
    const shown = single ? all.filter((c) => c.id === single) : all.filter((c) => !OVERVIEW_SKIP.has(c.id));
    if (computedFor !== `${n}`) {
      results.clear();
      computedFor = `${n}`;
    }
    for (const c of shown) if (!results.has(c.id)) results.set(c.id, await compute(engine, api, demos, c, n));
    const grid = document.createElement('main');
    grid.className = single ? 'dmf-grid dmf-single' : 'dmf-grid';
    if (compact) grid.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
    for (const c of shown) grid.append(card(results.get(c.id)!, { levels, cells, compact, single: Boolean(single) }));
    const children: HTMLElement[] = [toolbar(engine)];
    if (engine.kind !== 'wasm') {
      const warn = document.createElement('p');
      warn.className = 'dmf-mock';
      warn.textContent = selection.notices.map((x) => x.text).join(' ') || 'MOCK engine: every number is illustrative.';
      children.push(warn);
    }
    root.replaceChildren(...children, grid);
    document.body.dataset.ready = 'true';
  };
  if (!engine.misfit) {
    root.textContent = 'This build of the engine has no misfit grid (misfit_grid is not exported). Rebuild with: npm run wasm --prefix web';
    return;
  }
  window.addEventListener('hashchange', () => void render());
  await render();
}

const root = document.getElementById('app')!;
boot(root).catch((error: unknown) => {
  root.textContent = `The misfit developer page failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
