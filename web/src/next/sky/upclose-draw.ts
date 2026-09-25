/**
 * Drawing the "Up close" insets on a canvas: the Moon (its phase, maria, the named
 * features along the terminator, its axis and the lunar grid that shows the libration),
 * Jupiter with its four large moons (and their shadows), Saturn with its rings to scale,
 * and any other planet's phase and size. OWNER: sky2 agent (expansion Q3).
 *
 * Every position comes from the engines (EXPLORER_API "Moon in detail", "planet
 * detail"); this module only lays them out with upclose-geometry.ts. Colours come from the
 * Sky view's palette (so the night theme stays red). A drawing is schematic where the
 * engines give no picture: the maria are ellipses of each mare's size, Jupiter's belts and
 * Saturn's bands are drawn where they usually are, and shadows cast by a globe on its
 * rings are left out.
 */

import type { GalileanMoons, LunarFeatureState, MoonFeatures, MoonOrientation, PlanetDisc, SaturnRings } from '../engine/types.js';
import { css, mix, type Rgb, type SkyPalette } from './palette.js';
import { globePoint, litRegion, nearSide, paDirection, toScreen, type SkyBasis } from './upclose-geometry.js';

type Ctx2D = CanvasRenderingContext2D;
const TAU = 2 * Math.PI;
const MOON_RADIUS_KM = 1737.4;

export interface InsetFrame {
  ctx: Ctx2D;
  width: number;
  height: number;
  basis: SkyBasis;
  palette: SkyPalette;
}

/** Labels placed so far (to keep them apart): x, y, w, h. */
class Placer {
  private rects: number[] = [];
  place(x: number, y: number, w: number, h: number): boolean {
    const r = this.rects;
    for (let k = 0; k < r.length; k += 4) {
      if (x < r[k]! + r[k + 2]! && x + w > r[k]! && y < r[k + 1]! + r[k + 3]! && y + h > r[k + 1]!) return false;
    }
    r.push(x, y, w, h);
    return true;
  }
}

function background(f: InsetFrame): Rgb {
  return f.palette.phase.night;
}

function haloText(f: InsetFrame, text: string, x: number, y: number, fill: string, align: CanvasTextAlign = 'left'): void {
  const ctx = f.ctx;
  ctx.textAlign = align;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css(background(f), 0.85);
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** The lit part of a disc as a path: the bright-limb half plus or minus half the terminator ellipse. */
function litPath(ctx: Ctx2D, cx: number, cy: number, r: number, dirX: number, dirY: number, xt: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(dirY, dirX));
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.max(0.001, Math.abs(xt) * r), r, 0, Math.PI / 2, -Math.PI / 2, xt > 0);
  ctx.closePath();
  ctx.restore();
}

/**
 * North and east ticks outside a drawing, so the orientation reads at a glance. `r` is
 * the drawing's extent: a radius, or the distance to its edge in a screen direction.
 */
function compassTicks(f: InsetFrame, cx: number, cy: number, extent: number | ((dx: number, dy: number) => number)): void {
  const ctx = f.ctx;
  const ink = css(f.palette.inkOnDark, 0.8);
  ctx.font = `600 10.5px ${f.palette.fontUi}`;
  ctx.textBaseline = 'middle';
  for (const [pa, text] of [
    [0, 'N'],
    [90, 'E'],
  ] as const) {
    const d = paDirection(f.basis, pa);
    const r = typeof extent === 'number' ? extent : extent(d.x, d.y);
    ctx.beginPath();
    ctx.moveTo(cx + d.x * (r + 4), cy + d.y * (r + 4));
    ctx.lineTo(cx + d.x * (r + 11), cy + d.y * (r + 11));
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    haloText(f, text, cx + d.x * (r + 19), cy + d.y * (r + 19), ink, 'center');
  }
  ctx.textBaseline = 'alphabetic';
}

/** A scale bar under a drawing: `px` pixels stand for `label`. */
function scaleBar(f: InsetFrame, x: number, y: number, px: number, label: string): void {
  const ctx = f.ctx;
  const ink = css(f.palette.inkOnDark, 0.75);
  ctx.beginPath();
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 3);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.font = `500 10px ${f.palette.fontNum}`;
  haloText(f, label, x + px + 5, y + 1, ink);
}

function clear(f: InsetFrame): void {
  f.ctx.fillStyle = css(background(f));
  f.ctx.fillRect(0, 0, f.width, f.height);
}

// ---------------------------------------------------------------------------------
// The Moon
// ---------------------------------------------------------------------------------

const DARK_KINDS = new Set(['mare', 'oceanus', 'lacus', 'sinus', 'palus']);

export interface MoonInsetResult {
  /** Features labelled, in the order drawn. */
  labelled: string[];
}

/**
 * The Moon's disc as seen now: lit part, maria, the lunar equator and central meridian
 * (dashed: the libration shows as their offset from the disc's centre), the Moon's own
 * north pole, and the named features near the terminator (the engine's `tonight` order).
 */
export function drawMoonInset(f: InsetFrame, o: MoonOrientation, features: MoonFeatures | null, options: { maxLabels?: number } = {}): MoonInsetResult {
  const ctx = f.ctx;
  clear(f);
  const r = Math.min(f.width, f.height) / 2 - 26;
  const cx = f.width / 2;
  const cy = f.height / 2;
  const p = f.palette;
  const lit = p.moonDisc;
  const dark = mix(lit, background(f), 0.8);
  // Earthshine side, then the lit part.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = css(dark);
  ctx.fill();
  const reg = litRegion(f.basis, o.sub_solar_disc, o.sub_solar_disc.visible);
  if (reg.xt < 0.999) {
    litPath(ctx, cx, cy, r, reg.dirX, reg.dirY, reg.xt);
    ctx.fillStyle = css(lit);
    ctx.fill();
    // The maria, inside the lit part only.
    ctx.save();
    litPath(ctx, cx, cy, r, reg.dirX, reg.dirY, reg.xt);
    ctx.clip();
    const mare = css(mix(lit, background(f), 0.38), 0.55);
    for (const feat of features?.features ?? []) {
      if (!DARK_KINDS.has(feat.kind) || !feat.disc.visible) continue;
      maria(ctx, cx, cy, r, f.basis, feat, mare);
    }
    ctx.restore();
  }
  // The lunar equator and central meridian: where the Moon's own grid is tipped.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = css(mix(lit, background(f), 0.6), 0.9);
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  const lat0 = o.sub_observer.lat_deg;
  const lon0 = o.sub_observer.lon_deg;
  const P = o.axis_position_angle_deg;
  let pen = false;
  for (let lon = -180; lon <= 180; lon += 3) {
    const g = globePoint(0, lon, lat0, lon0, P, true);
    const s = toScreen(f.basis, g.east, g.north);
    if (!g.visible) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(cx + s.x * r, cy + s.y * r);
    else ctx.moveTo(cx + s.x * r, cy + s.y * r);
    pen = true;
  }
  pen = false;
  for (let lat = -90; lat <= 90; lat += 3) {
    const g = globePoint(lat, 0, lat0, lon0, P, true);
    const s = toScreen(f.basis, g.east, g.north);
    if (!g.visible) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(cx + s.x * r, cy + s.y * r);
    else ctx.moveTo(cx + s.x * r, cy + s.y * r);
    pen = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  // The limb, and the Moon's north pole on it.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.strokeStyle = css(lit, 0.6);
  ctx.lineWidth = 1;
  ctx.stroke();
  const np = toScreen(f.basis, o.north_pole_disc.east, o.north_pole_disc.north);
  const npLen = Math.hypot(np.x, np.y) || 1;
  if (o.north_pole_disc.visible || npLen > 0.9) {
    const ux = np.x / npLen;
    const uy = np.y / npLen;
    ctx.beginPath();
    ctx.moveTo(cx + np.x * r, cy + np.y * r);
    ctx.lineTo(cx + ux * (r + 7), cy + uy * (r + 7));
    ctx.strokeStyle = css(p.accent, 0.9);
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  compassTicks(f, cx, cy, r);
  // Features near the terminator, best first.
  const placer = new Placer();
  const labelled: string[] = [];
  if (features) {
    const byName = new Map(features.features.map((feat) => [feat.name, feat]));
    const order = features.tonight.map((n) => byName.get(n)).filter((x): x is LunarFeatureState => Boolean(x));
    ctx.font = `600 10.5px ${p.fontUi}`;
    const max = options.maxLabels ?? 8;
    for (const feat of order) {
      if (labelled.length >= max) break;
      const s = toScreen(f.basis, feat.disc.east, feat.disc.north);
      const x = cx + s.x * r;
      const y = cy + s.y * r;
      const text = feat.name;
      const w = ctx.measureText(text).width;
      const right = x <= cx;
      const lx = right ? x + 6 : x - 6 - w;
      if (!placer.place(lx - 1, y - 9, w + 2, 12)) continue;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, TAU);
      ctx.fillStyle = css(p.accent);
      ctx.fill();
      haloText(f, text, lx, y + 3.5, css(p.inkOnDark, 0.95));
      labelled.push(text);
    }
  }
  return { labelled };
}

function maria(ctx: Ctx2D, cx: number, cy: number, r: number, b: SkyBasis, feat: LunarFeatureState, fill: string): void {
  const rho = Math.min(0.75, feat.diameter_km / 2 / MOON_RADIUS_KM);
  const s = toScreen(b, feat.disc.east, feat.disc.north);
  const x = cx + s.x * r;
  const y = cy + s.y * r;
  const fromCentre = Math.min(1, Math.hypot(feat.disc.east, feat.disc.north));
  const cosT = Math.sqrt(Math.max(0.05, 1 - fromCentre * fromCentre));
  const a = Math.sin(rho) * r;
  ctx.beginPath();
  ctx.ellipse(x, y, a, Math.max(1.5, a * cosT), Math.atan2(s.y, s.x) + Math.PI / 2, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
}

// ---------------------------------------------------------------------------------
// Jupiter and its moons
// ---------------------------------------------------------------------------------

export interface JupiterInsetResult {
  /** Moons drawn beside the disc, behind it, or in its shadow, in words. */
  words: string[];
}

/**
 * Two panels: the whole system on one line (the moons' offsets to scale, named), and the
 * disc close up with any moon crossing it and any shadow on it.
 */
export function drawJupiterInset(f: InsetFrame, g: GalileanMoons): JupiterInsetResult {
  const ctx = f.ctx;
  clear(f);
  const p = f.palette;
  const colour = p.body.jupiter;
  const req = g.jupiter.equatorial_radius_arcsec;
  const rpol = g.jupiter.polar_radius_arcsec;
  const P = g.jupiter.pole_position_angle_deg;
  const pole = paDirection(f.basis, P);
  const eq = paDirection(f.basis, P - 90);
  const words: string[] = [];
  // --- the system strip -------------------------------------------------------------
  const stripH = Math.round(f.height * 0.42);
  const cy = stripH / 2 + 2;
  const cx = f.width / 2;
  // The farthest moon near the edge; never so close in that Jupiter looks bigger than a disc.
  let reach = 8;
  for (const m of g.moons) reach = Math.max(reach, Math.hypot(m.offset_east_arcsec, m.offset_north_arcsec) / req + 1.5);
  const s = (f.width / 2 - 16) / reach; // px per Jupiter radius
  // The moons' line: Jupiter's equator, across the strip.
  ctx.beginPath();
  ctx.moveTo(cx - eq.x * f.width, cy - eq.y * f.width);
  ctx.lineTo(cx + eq.x * f.width, cy + eq.y * f.width);
  ctx.strokeStyle = css(p.inkOnDark, 0.14);
  ctx.lineWidth = 1;
  ctx.stroke();
  disc(ctx, cx, cy, s, s * (rpol / req), pole, eq, colour, p, false);
  const placer = new Placer();
  placer.place(cx - s - 2, cy - s - 2, 2 * s + 4, 2 * s + 4);
  ctx.font = `600 10px ${p.fontUi}`;
  // Nearest the planet first: they get the places nearest their dots.
  const placed = g.moons
    .map((m) => {
      const o = toScreen(f.basis, m.offset_east_arcsec / req, m.offset_north_arcsec / req);
      return { m, x: cx + o.x * s, y: cy + o.y * s, d: Math.hypot(o.x, o.y) };
    })
    .sort((a, b) => a.d - b.d);
  for (const { x, y, m } of placed) {
    const dim = m.eclipsed || m.occulted;
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, TAU);
    if (dim) {
      ctx.strokeStyle = css(p.inkOnDark, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = css(p.inkOnDark);
      ctx.fill();
    }
    placer.place(x - 3, y - 3, 6, 6);
  }
  for (const { x, y, m } of placed) {
    const dim = m.eclipsed || m.occulted;
    const text = m.name;
    const w = ctx.measureText(text).width;
    // Below, above, then further out, then beside: the first place that is free.
    const spots: [number, number][] = [
      [0, 15],
      [0, -7],
      [0, 27],
      [0, -19],
      [w / 2 + 6, 4],
      [-w / 2 - 6, 4],
    ];
    let done = false;
    for (const [dx, dy] of spots) {
      const lx = x + dx;
      const ly = y + dy;
      if (lx - w / 2 < 2 || lx + w / 2 > f.width - 2 || ly - 9 < 1 || ly > stripH) continue;
      if (placer.place(lx - w / 2 - 1, ly - 9, w + 2, 11)) {
        if (Math.abs(dy) > 16) {
          // A short leader from the name to a moon it is far from.
          ctx.beginPath();
          ctx.moveTo(x, y + Math.sign(dy) * 4);
          ctx.lineTo(lx, ly - (dy > 0 ? 9 : -2));
          ctx.strokeStyle = css(p.inkOnDark, 0.35);
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        haloText(f, text, lx, ly, css(p.inkOnDark, dim ? 0.6 : 0.95), 'center');
        done = true;
        break;
      }
    }
    if (!done) haloText(f, text, x, y + 15, css(p.inkOnDark, dim ? 0.6 : 0.95), 'center');
    if (m.in_transit) words.push(`${m.name} is crossing Jupiter’s face`);
    else if (m.occulted) words.push(`${m.name} is behind Jupiter`);
    else if (m.eclipsed) words.push(`${m.name} is in Jupiter’s shadow`);
    if (m.shadow_on_disc) words.push(`${m.name}’s shadow is on Jupiter`);
  }
  // A scale of one arcminute when it fits.
  const arcminPx = (60 / req) * s;
  if (arcminPx > 12 && arcminPx < f.width / 3) scaleBar(f, 12, stripH - 4, arcminPx, '1′');
  // --- the disc close up ---------------------------------------------------------------
  const top = stripH + 8;
  const h2 = f.height - top;
  const cy2 = top + h2 / 2;
  const s2 = Math.min(h2 / 2 - 22, f.width / 2 - 30) / 1.0; // disc radius in px
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, f.width, h2);
  ctx.clip();
  disc(ctx, cx, cy2, s2, s2 * (rpol / req), pole, eq, colour, p, true);
  for (const m of g.moons) {
    const o = toScreen(f.basis, m.offset_east_arcsec / req, m.offset_north_arcsec / req);
    const x = cx + o.x * s2;
    const y = cy2 + o.y * s2;
    if (m.shadow_on_disc && m.shadow_x_rj !== null && m.shadow_y_rj !== null) {
      // x_rj is along the equator, positive west (`eq`, position angle P − 90°); y_rj toward the pole.
      const sx = cx + (m.shadow_x_rj * eq.x + m.shadow_y_rj * pole.x) * s2;
      const sy = cy2 + (m.shadow_x_rj * eq.y + m.shadow_y_rj * pole.y) * s2;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2.5, s2 * 0.045), 0, TAU);
      ctx.fillStyle = css(mix(background(f), { r: 0, g: 0, b: 0 }, 0.5));
      ctx.fill();
    }
    if (Math.abs(o.x) * s2 > f.width / 2 + 10 || Math.abs(o.y) * s2 > h2) continue;
    if (m.occulted) continue;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, s2 * 0.04), 0, TAU);
    ctx.fillStyle = css(m.eclipsed ? mix(p.inkOnDark, background(f), 0.6) : p.inkOnDark);
    ctx.strokeStyle = css(background(f), 0.8);
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.font = `600 10px ${p.fontUi}`;
    haloText(f, m.name, x + 6, y - 5, css(p.inkOnDark, 0.95));
  }
  ctx.restore();
  compassTicks(f, cx, cy2, s2);
  return { words };
}

/** An oblate disc with a few belts (drawn where Jupiter's and Saturn's usually are). */
function disc(ctx: Ctx2D, cx: number, cy: number, req: number, rpol: number, pole: { x: number; y: number }, eq: { x: number; y: number }, colour: Rgb, p: SkyPalette, belts: boolean): void {
  const angle = Math.atan2(eq.y, eq.x);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.ellipse(0, 0, req, rpol, 0, 0, TAU);
  ctx.fillStyle = css(colour);
  ctx.fill();
  if (belts && req > 12) {
    ctx.clip();
    // In the rotated frame +y is 90° clockwise from the equator's direction on screen;
    // the pole is on one side of it: find which.
    const poleSide = Math.sign(-Math.sin(angle) * pole.x + Math.cos(angle) * pole.y) || 1;
    ctx.fillStyle = css(mix(colour, p.phase.night, 0.35), 0.8);
    for (const [a, b] of [
      [0.08, 0.3],
      [-0.34, -0.12],
    ] as const) {
      ctx.fillRect(-req, poleSide * a * rpol, 2 * req, poleSide * (b - a) * rpol);
    }
  }
  ctx.restore();
  ctx.beginPath();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.ellipse(0, 0, req, rpol, 0, 0, TAU);
  ctx.restore();
  ctx.strokeStyle = css(p.halo, p.haloAlpha * 0.7);
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---------------------------------------------------------------------------------
// Saturn and its rings
// ---------------------------------------------------------------------------------

/**
 * Saturn's rings at their true tilt and size, the far half behind the globe and the near
 * half in front of it: the A and B rings with the Cassini Division between them and the
 * faint C ring inside. Dimmed when the Earth sees their unlit face.
 */
export function drawSaturnInset(f: InsetFrame, rings: SaturnRings, discInfo: PlanetDisc | null): void {
  const ctx = f.ctx;
  clear(f);
  const p = f.palette;
  const colour = p.body.saturn;
  const cx = f.width / 2;
  const cy = f.height / 2;
  const outer = rings.edges.find((e) => /A outer/i.test(e.name)) ?? rings.edges[0];
  if (!outer) return;
  const s = (f.width * 0.78) / outer.major_axis_arcsec; // px per arcsecond
  const pole = paDirection(f.basis, rings.position_angle_deg);
  const eq = paDirection(f.basis, rings.position_angle_deg - 90);
  const angle = Math.atan2(eq.y, eq.x);
  const poleSide = Math.sign(-Math.sin(angle) * pole.x + Math.cos(angle) * pole.y) || 1;
  const near = nearSide(rings.earth_latitude_deg) * poleSide; // +1: the near half is at +y in the rotated frame
  const edge = (name: RegExp): { a: number; b: number } | null => {
    const e = rings.edges.find((x) => name.test(x.name));
    return e ? { a: (e.major_axis_arcsec / 2) * s, b: (e.minor_axis_arcsec / 2) * s } : null;
  };
  const aOut = edge(/A outer/i);
  const aIn = edge(/A inner/i);
  const bOut = edge(/B outer/i);
  const bIn = edge(/B inner/i);
  const cIn = edge(/C inner/i);
  const litFace = rings.lit_face_visible;
  // The B ring is brighter and whiter than the globe, the A ring a little dimmer, the C ring faint.
  const ringB = mix(p.inkOnDark, colour, 0.2);
  const ringA = mix(mix(p.inkOnDark, colour, 0.4), background(f), 0.18);
  const ringC = mix(colour, background(f), 0.62);
  const dimmed = (c: Rgb): string => css(litFace ? c : mix(c, background(f), 0.6));
  const annulus = (o: { a: number; b: number } | null, i: { a: number; b: number } | null, fill: string): void => {
    if (!o || !i) return;
    ctx.beginPath();
    ctx.ellipse(0, 0, o.a, o.b, 0, 0, TAU);
    ctx.ellipse(0, 0, i.a, i.b, 0, 0, TAU, true);
    ctx.fillStyle = fill;
    ctx.fill('evenodd');
  };
  const drawRings = (half: 1 | -1, front: boolean): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    const big = f.width;
    ctx.rect(-big, half > 0 ? 0 : -big, 2 * big, big);
    ctx.clip();
    annulus(aOut, aIn, dimmed(ringA));
    annulus(bOut, bIn, dimmed(ringB));
    annulus(bIn, cIn, dimmed(ringC));
    if (front) {
      // The near half's edges, so it reads where it crosses the globe.
      ctx.strokeStyle = css(background(f), 0.55);
      ctx.lineWidth = 0.8;
      for (const e of [aOut, bIn]) {
        if (!e) continue;
        ctx.beginPath();
        ctx.ellipse(0, 0, e.a, e.b, 0, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  // The far half, the globe, the near half.
  drawRings(near > 0 ? -1 : 1, false);
  // Without the disc, the ratio of the A ring's outer edge to Saturn's equatorial radius (136 780 / 60 268 km).
  const req = ((discInfo?.equatorial_diameter_arcsec ?? outer.major_axis_arcsec / 2.2696) / 2) * s;
  const rpol = discInfo ? (discInfo.polar_diameter_arcsec / 2) * s : req * 0.9;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.ellipse(0, 0, req, rpol, 0, 0, TAU);
  ctx.fillStyle = css(colour);
  ctx.fill();
  ctx.clip();
  // A darker band on the hemisphere away from the rings' near half, where it shows.
  ctx.fillStyle = css(mix(colour, p.phase.night, 0.25), 0.7);
  ctx.fillRect(-req, -near * 0.3 * rpol, 2 * req, -near * 0.16 * rpol);
  ctx.restore();
  drawRings(near > 0 ? 1 : -1, true);
  // The rings' ellipse (or the globe, where it stands out beyond them) in that direction.
  const ringA2 = aOut?.a ?? req;
  const ringB2 = aOut?.b ?? rpol;
  compassTicks(f, cx, cy, (dx, dy) => {
    const along = dx * eq.x + dy * eq.y;
    const across = dx * pole.x + dy * pole.y;
    const ring = Math.hypot(ringA2 * along, ringB2 * across);
    const globe = Math.hypot(req * along, rpol * across);
    return Math.max(ring, globe) + 2;
  });
  const tenArcsec = 10 * s;
  if (tenArcsec > 8) scaleBar(f, 12, f.height - 10, tenArcsec, '10″');
}

// ---------------------------------------------------------------------------------
// Any other planet: its phase and size
// ---------------------------------------------------------------------------------

export function drawPlanetInset(f: InsetFrame, d: PlanetDisc, colourKey: keyof SkyPalette['body']): void {
  const ctx = f.ctx;
  clear(f);
  const p = f.palette;
  const colour = p.body[colourKey];
  const cx = f.width / 2;
  const cy = f.height / 2;
  const r = Math.min(f.width, f.height) / 2 - 34;
  const s = r / (d.equatorial_diameter_arcsec / 2); // px per arcsecond
  // Dark side, then the lit part (the bright limb from the engine, the terminator by k).
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = css(mix(colour, background(f), 0.82));
  ctx.fill();
  const dir = paDirection(f.basis, d.bright_limb_angle_deg);
  const xt = 1 - 2 * d.illuminated_fraction;
  if (xt < 0.999) {
    litPath(ctx, cx, cy, r, dir.x, dir.y, xt);
    ctx.fillStyle = css(colour);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.strokeStyle = css(colour, 0.5);
  ctx.lineWidth = 1;
  ctx.stroke();
  compassTicks(f, cx, cy, r);
  const bar = d.equatorial_diameter_arcsec >= 20 ? 10 : d.equatorial_diameter_arcsec >= 4 ? 1 : 0.5;
  scaleBar(f, 12, f.height - 10, bar * s, `${bar}″`);
}
