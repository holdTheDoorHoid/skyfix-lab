/**
 * The star finder in Navigate's Plan tab: the base plate for the DR's hemisphere with the
 * template for its latitude band laid over it and turned to LHA ♈, following the time bar
 * (or turned by hand), and "Print" for the two sheets (the base, and the template to print
 * on transparency). OWNER: navigate2 agent (expansion programme).
 *
 * The geometry comes once per latitude band and day (`star_finder_geometry`, apparent places
 * of that date; memoised by the engine wrapper); while the time bar moves only the template's
 * turn changes (one SVG attribute per frame, drawn in the scheduler's frame).
 */

import { h } from '../../../dom.js';
import { disposer, watch, type Mounted } from '../../component.js';
import { isSailingsEngine, type StarFinderGeometry } from '../../engine/types.js';
import { formatDate, UTC_ZONE } from '../../time.js';
import { angleFormat, zone, type NavCtx } from '../context.js';
import { fmtInstant, fmtLatitude } from '../format.js';
import { openPrintPreview, sheet } from '../print/preview.js';
import { btn, card, checkbox, notice, para } from '../ui.js';
import { lhaAries, printedDisc, starFinderSvg } from './draw.js';

interface Where {
  lat: number;
  lon: number;
  label: string;
}

function where(nc: NavCtx): Where {
  const ap = nc.working.store.get().session.observer.assumed_position;
  if (ap) return { lat: ap.lat_deg, lon: ap.lon_deg, label: 'the session’s DR' };
  const o = nc.ctx.store.get().observer;
  return { lat: o.lat_deg, lon: o.lon_deg, label: o.label || 'the map’s place' };
}

/** The two printed sheets: the base plate and the template, the same size to lay one on the other. */
export function starFinderSheets(g: StarFinderGeometry, kind: 'simulated' | 'real' | null, dateText: string): HTMLElement[] {
  const band = `${Math.abs(g.template_latitude_deg)}° ${g.side === 'north' ? 'N' : 'S'}`;
  return [
    sheet(
      'Star finder: base plate',
      `${g.side === 'north' ? 'North' : 'South'} side · the 58 navigational stars, places of ${dateText}`,
      kind,
      h('div', { class: 'sfn-sheet__figure sfn-sheet__figure--disc' }, printedDisc(g, 'base')),
      h(
        'p',
        { class: 'sfn-sheet__note' },
        'Print both sheets at the same size (no scaling). Pin the template over this plate through the two centres, turn it until its arrow points at LHA ♈\uFE0E on the rim (LHA ♈\uFE0E = GHA ♈\uFE0E + your longitude east, − west), and read each star’s altitude and azimuth under the template’s grid.',
      ),
    ),
    sheet(
      `Star finder: template for ${band}`,
      `For latitudes ${Math.abs(g.template_latitude_deg) - 5}° to ${Math.abs(g.template_latitude_deg) + 5}° ${g.side === 'north' ? 'N' : 'S'} · print on transparency or thin paper`,
      kind,
      h('div', { class: 'sfn-sheet__figure sfn-sheet__figure--disc' }, printedDisc(g, 'template')),
      h(
        'p',
        { class: 'sfn-sheet__note' },
        'Altitude circles every 5° (figured every 10°) from the horizon to the zenith (+); azimuth lines every 10° (figured every 30°, true). ' + g.notes.join(' '),
      ),
    ),
  ];
}

export function starFinderCard(nc: NavCtx): Mounted & { el: HTMLElement } {
  const d = disposer();
  const c = card('Star finder', { term: '2102-D style, turned to LHA ♈\uFE0E', iconName: 'sky', class: 'sfn-sfcard' });
  const engine = nc.ctx.engine;
  if (!isSailingsEngine(engine)) {
    c.body.append(notice('caution', 'This build’s engine has no star finder (star_finder_geometry). Rebuild the WebAssembly package to use it.'));
    return { el: c.el, destroy: () => c.el.remove() };
  }
  c.body.append(
    para(
      'Which star is where: the navigational stars on a disc round the pole, and over them a grid of altitude and azimuth for your latitude. Turned to the local hour angle of Aries, the grid shows every star’s height and bearing, as the plastic star finder does.',
      'sfn-plain',
    ),
  );
  const figure = h('div', { class: 'sfn-figure sfn-sf__figure' });
  const readout = h('p', { class: 'sfn-note sfn-sf__readout', 'aria-live': 'polite' });
  const follow = checkbox('Follow the time bar', true, (on) => {
    manual.disabled = on;
    if (on) turnFromTime();
  }, 'Off: turn the template by hand.');
  const manual = h('input', { type: 'range', min: 0, max: 360, step: 0.5, value: 0, class: 'sfn-sf__slider', 'aria-label': 'LHA of Aries, degrees', disabled: true });
  const printButton = btn('Print the base and template', () => {
    if (!geom) return;
    // The star finder is the sky's, not the session's: no SIMULATED or REAL badge.
    openPrintPreview('Star finder', starFinderSheets(geom.g, null, geom.dateText), 'Two sheets: the base plate, and the template for your latitude band (print it on transparency). Print both at 100 %.');
  }, { variant: 'outline' });
  const notes = h('ul', { class: 'sfn-list sfn-muted' });
  c.body.append(figure, readout, h('div', { class: 'sfn-sf__controls' }, follow.el, manual, printButton), notes);

  let geom: { key: string; g: StarFinderGeometry; dateText: string; setLha: (l: number) => void } | null = null;
  let lha = 0;

  const build = (): void => {
    const w = where(nc);
    const jd = nc.ctx.store.get().time.jd_utc;
    const day = Math.round(jd); // noon UT of the day: the stars' apparent places change far less in a day than a drawing shows
    // The engine snaps a latitude to its 10° band's template (5° to 85°, signed): one key per band.
    const band = (w.lat >= 0 ? 1 : -1) * Math.min(85, Math.floor(Math.abs(w.lat) / 10) * 10 + 5);
    const key = `${band}|${day}`;
    if (geom && geom.key === key) return;
    let g: StarFinderGeometry;
    let dateText = formatDate(day, UTC_ZONE);
    let placesNote = `Star places of ${dateText} (apparent).`;
    try {
      g = engine.starFinderGeometry(band, day);
    } catch {
      // A date the almanac does not place stars for: the catalogue (J2000.0) places, said so.
      try {
        g = engine.starFinderGeometry(band);
        dateText = 'J2000.0 (catalogue)';
        placesNote = `The time bar’s date is outside this build’s star places, so the stars are drawn at their J2000.0 catalogue places: close enough for a finder over a few decades, not over centuries (precession moves them about 1.4° a century).`;
      } catch (error) {
        figure.replaceChildren(notice('error', String(error)));
        geom = null;
        return;
      }
    }
    const { svg, setLha } = starFinderSvg(g, 600, lha);
    figure.replaceChildren(svg);
    geom = { key, g, dateText, setLha };
    notes.replaceChildren(...g.notes.map((n) => h('li', {}, n)), h('li', {}, placesNote));
    turnFromTime();
  };

  const say = (source: string): void => {
    if (!geom) return;
    const w = where(nc);
    const g = geom.g;
    readout.textContent = `LHA ♈\uFE0E ${lha.toFixed(1)}° ${source}, for ${fmtLatitude(w.lat, angleFormat(nc))} (${w.label}): the template for ${Math.abs(g.template_latitude_deg)}° ${g.side === 'north' ? 'N' : 'S'}.`;
  };

  const turnFromTime = (): void => {
    if (!geom || !follow.input.checked) return;
    const jd = nc.ctx.store.get().time.jd_utc;
    const w = where(nc);
    lha = lhaAries(engine.sidereal(jd).gha_aries_deg, w.lon);
    manual.value = String(lha);
    geom.setLha(lha);
    say(`at ${fmtInstant(jd, zone(nc))}`);
  };

  manual.addEventListener('input', () => {
    lha = Number(manual.value);
    geom?.setLha(lha);
    say('set by hand');
  });

  // Per frame while the time bar moves: only the turn. The geometry (a new day's star
  // places) is fetched when the time has settled, never in the middle of a drag.
  let settle: ReturnType<typeof setTimeout> | null = null;
  d.add(() => {
    if (settle !== null) clearTimeout(settle);
  });
  d.add(
    watch(nc.ctx, (s) => s.time.jd_utc, () => {
      turnFromTime();
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        build();
      }, 300);
    }),
  );
  d.add(nc.working.store.select((w) => w.session.observer.assumed_position, () => {
    geom = null;
    build();
  }));
  d.add(nc.ctx.store.select((s) => [s.observer.lat_deg, s.observer.lon_deg] as const, () => {
    geom = null;
    build();
  }, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] }));
  build();
  return {
    el: c.el,
    destroy: () => {
      d.dispose();
      c.el.remove();
    },
  };
}
