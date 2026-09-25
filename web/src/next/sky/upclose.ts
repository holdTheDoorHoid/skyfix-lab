/**
 * "Up close": the Moon or a planet as a pair of binoculars or a telescope shows it, in a
 * panel over the Sky view. OWNER: sky2 agent (expansion Q3).
 *
 * - The Moon (moondetail engine: `moon_orientation`, `moon_features`): its phase with the
 *   terminator where the Sun is rising or setting over the surface, the maria, the named
 *   features near the terminator (the ones in best relief now), the Moon's axis and its
 *   equator and central meridian (whose offset from the disc's centre is the libration).
 * - Jupiter (planetdetail: `galilean_moons`, `planet_disc`): the four large moons on a
 *   line with their names, any moon crossing the disc or hidden by it or in its shadow, and
 *   the shadows on the cloud tops; the central meridians.
 * - Saturn (`saturn_rings`, `planet_disc`): the rings at their true tilt and size.
 * - Mercury, Venus, Mars, Uranus, Neptune (`planet_disc`): phase and apparent size.
 *
 * Orientation: as seen (the zenith up, with the place's parallactic angle), north up (the
 * sky as the eye and binoculars show it), south up (an astronomical telescope), each
 * optionally mirrored (a star diagonal). The engines take a few tenths of a millisecond;
 * while time runs the panel redraws at most ten times a second, and once more when it
 * stops.
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import {
  isMoonDetailEngine,
  isPlanetDetailEngine,
  type MoonFeatures,
  type MoonOrientation,
  type Observer,
  type PlanetDisc,
} from '../engine/types.js';
import { button, iconButton, segmented, setPressed } from '../theme/primitives.js';
import { formatAngle, formatBearing } from './format.js';
import type { BodyKey, SkyPalette } from './palette.js';
import { drawJupiterInset, drawMoonInset, drawPlanetInset, drawSaturnInset, type InsetFrame } from './upclose-draw.js';
import { galileanAccuracyWords, librationWords, skyBasis, type UpCloseOrientation } from './upclose-geometry.js';

export const UP_CLOSE_BODIES = ['Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;

export function upCloseSupported(body: string | null | undefined): boolean {
  return (UP_CLOSE_BODIES as readonly string[]).includes(body ?? '');
}

export interface UpCloseSettings {
  orientation: UpCloseOrientation;
  mirror: boolean;
}

export interface UpCloseInput {
  jd: number;
  observer: Observer;
  /** The body's parallactic angle now (sky_state), for the "as seen" orientation. */
  parallacticDeg: number | null;
  palette: SkyPalette;
  /** True while the time runs: redraw at most ten times a second. */
  moving: boolean;
}

export interface UpClosePanel {
  el: HTMLElement;
  body(): string | null;
  /** Open for a body; for the Moon, `features` are marked on the disc (the Selected card's list). */
  open(body: string, options?: { features?: readonly string[] }): void;
  close(): void;
  update(input: UpCloseInput): void;
  /** The facts on show, as text (tests and screen readers). */
  summary(): string;
  destroy(): void;
}

const MOVING_MS = 100;

function dpr(): number {
  return Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
}

function pct(k: number): string {
  return `${Math.round(k * 100)} %`;
}

function arcsec(v: number): string {
  return v >= 100 ? `${(v / 60).toFixed(1)}′` : `${v.toFixed(1)}″`;
}

export function upClosePanel(ctx: Ctx, settings: UpCloseSettings, onClose: () => void): UpClosePanel {
  const { engine } = ctx;
  const titleId = `sky-upclose-${Math.random().toString(36).slice(2, 8)}`;
  const title = h('h2', { class: 'sky-upclose__title', id: titleId });
  const sub = h('p', { class: 'sky-upclose__sub' });
  const close = iconButton('close', 'Close the close-up', { class: 'sky-upclose__close', onClick: () => onClose() });
  const canvas = h('canvas', { class: 'sky-upclose__canvas', role: 'img' });
  const orientation = segmented<UpCloseOrientation>({
    label: 'Which way up',
    value: settings.orientation,
    size: 'sm',
    onChange: (v) => {
      settings.orientation = v;
      redraw(true);
    },
    options: [
      { value: 'seen', label: 'As seen', tip: 'The way it hangs in the sky from here: the zenith up' },
      { value: 'north', label: 'North up', tip: 'North up and east to the left, as the eye and binoculars show it' },
      { value: 'south', label: 'South up', tip: 'Turned half way round, as a telescope without a diagonal shows it' },
    ],
  });
  const mirror = button({
    label: 'Mirrored',
    size: 'sm',
    pressed: settings.mirror,
    tip: 'Left and right swapped, as a telescope with a star diagonal shows it',
    onClick: () => {
      settings.mirror = !settings.mirror;
      setPressed(mirror, settings.mirror);
      redraw(true);
    },
  });
  const facts = h('dl', { class: 'sky-upclose__facts' });
  const note = h('p', { class: 'sky-upclose__note' });
  const el = h(
    'section',
    { class: 'sky-upclose sf-on-stage', role: 'dialog', 'aria-labelledby': titleId, hidden: true },
    h('header', { class: 'sky-upclose__head' }, h('div', { class: 'sky-upclose__titles' }, title, sub), close),
    canvas,
    h('div', { class: 'sky-upclose__controls' }, orientation.el, mirror),
    facts,
    note,
  );
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  });

  let body: string | null = null;
  let marked: readonly string[] = [];
  let last: UpCloseInput | null = null;
  let drawnKey = '';
  let lastDraw = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let summaryText = '';

  const setFacts = (rows: [string, string][]): void => {
    facts.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  };

  const frame = (w: number, hgt: number, input: UpCloseInput, parallactic: number | null): InsetFrame | null => {
    const d = dpr();
    if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(hgt * d)) {
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(hgt * d);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.setTransform(d, 0, 0, d, 0, 0);
    return { ctx: g, width: w, height: hgt, basis: skyBasis(settings.orientation, settings.mirror, parallactic), palette: input.palette };
  };

  const unavailable = (what: string): void => {
    canvas.hidden = true;
    setFacts([]);
    note.textContent = `${what} is not available in this engine.`;
    summaryText = note.textContent;
  };

  function draw(input: UpCloseInput): void {
    if (!body) return;
    canvas.hidden = false;
    note.textContent = '';
    const fmt = ctx.store.get().settings.angleFormat;
    try {
      if (body === 'Moon') {
        if (!isMoonDetailEngine(engine)) return unavailable('The Moon in detail');
        const o: MoonOrientation = engine.moonOrientation(input.observer, input.jd);
        let features: MoonFeatures | null = null;
        try {
          features = engine.moonFeatures(input.observer, input.jd);
        } catch {
          features = null;
        }
        const f = frame(280, 280, input, o.parallactic_angle_deg);
        if (!f) return;
        const result = drawMoonInset(f, o, features, { highlight: marked });
        title.textContent = 'The Moon up close';
        sub.textContent = `${pct(o.illuminated_fraction)} lit, ${o.waxing ? 'waxing' : 'waning'} · ${o.apparent_diameter_arcmin.toFixed(1)}′ across`;
        const sizeWords = `${o.apparent_diameter_arcmin.toFixed(1)}′, ${Math.abs(o.diameter_vs_mean_percent).toFixed(1)} % ${o.diameter_vs_mean_percent >= 0 ? 'larger' : 'smaller'} than at its mean distance`;
        setFacts([
          ['Size in the sky', sizeWords],
          ['Libration', librationWords(o.libration.lon_deg, o.libration.lat_deg)],
          ['The Moon’s north pole', `at ${formatBearing(o.axis_position_angle_deg, fmt)} from celestial north (position angle)`],
          ['Bright edge faces', `${formatBearing(o.bright_limb_angle_deg, fmt)} from celestial north`],
          ['Along the shadow line', result.labelled.length ? result.labelled.join(', ') : 'no named feature in good relief now'],
        ]);
        note.textContent = 'Maria are drawn as ellipses of their size; the dashed lines are the Moon’s equator and central meridian, offset by the libration. Feature positions: USGS/IAU Gazetteer of Planetary Nomenclature (public domain).';
        summaryText = `The Moon, ${sub.textContent}. ${librationWords(o.libration.lon_deg, o.libration.lat_deg)} Features along the shadow line: ${result.labelled.join(', ') || 'none'}.`;
        canvas.setAttribute('aria-label', summaryText);
        return;
      }
      if (!isPlanetDetailEngine(engine)) return unavailable('Planet detail');
      let disc: PlanetDisc | null = null;
      try {
        disc = engine.planetDisc(body, input.jd);
      } catch {
        disc = null;
      }
      if (body === 'Jupiter') {
        const g = engine.galileanMoons(input.jd);
        const f = frame(300, 270, input, input.parallacticDeg);
        if (!f) return;
        const result = drawJupiterInset(f, g);
        title.textContent = 'Jupiter and its moons';
        sub.textContent = `${arcsec(g.jupiter.equatorial_radius_arcsec * 2)} across${disc?.magnitude !== null && disc?.magnitude !== undefined ? ` · magnitude ${disc.magnitude.toFixed(1)}` : ''}`;
        const moonRows: [string, string][] = [...g.moons]
          .sort((a, b) => a.offset_east_arcsec - b.offset_east_arcsec)
          .map((m) => {
            const dist = Math.hypot(m.offset_east_arcsec, m.offset_north_arcsec);
            const side = m.offset_east_arcsec >= 0 ? 'east' : 'west';
            const state = m.in_transit ? 'crossing the disc' : m.occulted ? 'behind Jupiter' : m.eclipsed ? 'in Jupiter’s shadow' : `${arcsec(dist)} ${side}`;
            return [m.name, `${state}${m.shadow_on_disc ? '; its shadow is on Jupiter' : ''}`];
          });
        const cms = disc?.central_meridians.map((c) => `System ${c.system} ${c.longitude_deg.toFixed(1)}°`).join(', ');
        setFacts([...moonRows, ...(cms ? [['Central meridian', cms] as [string, string]] : [])]);
        note.textContent = [
          `Moon positions: ${g.theory.split('.')[0]}, ${galileanAccuracyWords(g.accuracy_arcsec, input.jd)}.`,
          ...(disc?.notes ?? []),
          'The belts are drawn where they usually are.',
        ].join(' ');
        summaryText = `Jupiter, ${sub.textContent}. ${moonRows.map(([k, v]) => `${k} ${v}`).join('; ')}.${result.words.length ? ` ${result.words.join('. ')}.` : ''}`;
        canvas.setAttribute('aria-label', summaryText);
        return;
      }
      if (body === 'Saturn') {
        const rings = engine.saturnRings(input.jd);
        const f = frame(300, 190, input, input.parallacticDeg);
        if (!f) return;
        drawSaturnInset(f, rings, disc);
        const face = rings.earth_latitude_deg >= 0 ? 'north' : 'south';
        title.textContent = 'Saturn and its rings';
        sub.textContent = `Rings tilted ${Math.abs(rings.earth_latitude_deg).toFixed(1)}° toward us · ${arcsec(rings.major_axis_arcsec)} across`;
        setFacts([
          ['Rings seen from', `the ${face} side, tipped ${formatAngle(Math.abs(rings.earth_latitude_deg), fmt)}`],
          ['Rings across', `${arcsec(rings.major_axis_arcsec)} by ${arcsec(rings.minor_axis_arcsec)}`],
          ...(disc ? ([['Globe across', arcsec(disc.equatorial_diameter_arcsec)]] as [string, string][]) : []),
          ['Sunlit side of the rings', rings.lit_face_visible ? 'the side we see' : 'the far side: we see the rings’ dark face'],
          ...(rings.magnitude !== null ? ([['Magnitude', rings.magnitude.toFixed(1)]] as [string, string][]) : []),
        ]);
        note.textContent = 'Drawn to scale from the engine’s ring edges (A, B and C rings, the Cassini Division between A and B). The shadows of the globe and rings on each other are not drawn.';
        summaryText = `Saturn: ${sub.textContent}; seen from the ${face} side.`;
        canvas.setAttribute('aria-label', summaryText);
        return;
      }
      if (!disc) {
        note.textContent = `No close-up of ${body} at this time.`;
        summaryText = note.textContent;
        return;
      }
      const f = frame(240, 220, input, input.parallacticDeg);
      if (!f) return;
      drawPlanetInset(f, disc, body.toLowerCase() as BodyKey);
      title.textContent = `${body} up close`;
      sub.textContent = `${arcsec(disc.equatorial_diameter_arcsec)} across · ${pct(disc.illuminated_fraction)} lit`;
      setFacts([
        ['Size in the sky', `${arcsec(disc.equatorial_diameter_arcsec)} across (the Moon is about 1 800″)`],
        ['Lit', pct(disc.illuminated_fraction)],
        ...(disc.magnitude !== null ? ([['Magnitude', disc.magnitude.toFixed(1)]] as [string, string][]) : []),
        ['Distance', `${disc.distance_au.toFixed(3)} AU, light ${Math.round(disc.light_time_s / 60)} min on the way`],
      ]);
      note.textContent = [...disc.notes, 'Surface markings are not drawn.'].join(' ');
      summaryText = `${body}: ${sub.textContent}.`;
      canvas.setAttribute('aria-label', summaryText);
    } catch (error) {
      canvas.hidden = true;
      setFacts([]);
      note.textContent = `No close-up now: ${error instanceof Error ? error.message : String(error)}`;
      summaryText = note.textContent;
    }
  }

  function redraw(force: boolean): void {
    if (!last || !body) return;
    const input = last;
    const key = `${body}|${input.jd}|${input.observer.lat_deg}|${input.observer.lon_deg}|${settings.orientation}|${settings.mirror}|${input.palette.theme}|${input.parallacticDeg?.toFixed(3)}`;
    if (!force && key === drawnKey) return;
    const now = performance.now();
    if (!force && input.moving && now - lastDraw < MOVING_MS) {
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          redraw(false);
        }, MOVING_MS - (now - lastDraw));
      }
      return;
    }
    drawnKey = key;
    lastDraw = now;
    draw(input);
  }

  return {
    el,
    body: () => body,
    open(next, options = {}) {
      body = next;
      marked = options.features ?? [];
      drawnKey = '';
      el.hidden = false;
      orientation.set(settings.orientation);
      setPressed(mirror, settings.mirror);
      redraw(true);
    },
    close() {
      body = null;
      marked = [];
      el.hidden = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    update(input) {
      last = input;
      if (body) redraw(false);
    },
    summary: () => summaryText,
    destroy() {
      if (timer) clearTimeout(timer);
      el.remove();
    },
  };
}
