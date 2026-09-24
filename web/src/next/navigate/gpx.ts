/**
 * GPX export of a result: the fix as a waypoint (GPX 1.1, topografix.com/GPX/1/1), with its
 * uncertainty written in plain words in the description, so the number never travels
 * without its caveat. OWNER: navigate agent.
 *
 * - A unique fix is one waypoint; its description gives the 1-sigma north and east
 *   uncertainty and the nominal 95 % ellipse (or why there is none).
 * - An ambiguous result is one waypoint per candidate, each saying it is one of several
 *   equally good answers. None is promoted, here as on screen.
 * - Underdetermined and failed results have no position, so there is no GPX; the reason
 *   is returned instead.
 * - A noon sight exports a waypoint only when it has a longitude, and says how weak it is.
 * - Latitude by Polaris has no longitude: no waypoint.
 * Every description ends with the honesty line and says whether the session is simulated.
 */

import type { FixResult, SessionKind } from '../../types.js';
import type { NoonSightResult } from '../engine/types.js';
import { ELLIPSE_MODEL, HONESTY } from './text.js';

export interface GpxWaypoint {
  lat_deg: number;
  /** East-positive, (-180, 180] (CONVENTIONS section 2; GPX uses the same sign). */
  lon_deg: number;
  name: string;
  desc: string;
  /** RFC 3339 UTC, or null when the result has no single instant. */
  time: string | null;
  type: string;
}

export interface GpxDocument {
  name: string;
  desc: string;
  /** When the file was made (RFC 3339 UTC). */
  time: string;
  waypoints: GpxWaypoint[];
}

export type GpxPlan = { ok: true; waypoints: GpxWaypoint[] } | { ok: false; reason: string };

export interface GpxContext {
  sessionName: string;
  sessionKind: SessionKind;
  /** The instant the result refers to (the last sight, a running fix's reference, noon). */
  time: string | null;
  /** How many sights the result used. */
  sights: number;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Characters XML 1.0 does not allow at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const coord = (v: number): string => (Math.abs(v) < 5e-8 ? '0.0000000' : v.toFixed(7));
const m = (metres: number): string => (metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(0)} m`);
const nm = (metres: number): string => `${(metres / 1852).toFixed(2)} NM`;

function tail(ctx: GpxContext): string {
  const kind = ctx.sessionKind === 'simulated' ? 'SIMULATED session (generated, not measured).' : 'REAL session (measured).';
  return ` Session: ${ctx.sessionName || 'untitled'}. ${kind} ${HONESTY}`;
}

/** The waypoints for a fix (or running fix), or why there are none. */
export function fixWaypoints(result: FixResult, ctx: GpxContext): GpxPlan {
  switch (result.kind) {
    case 'unique': {
      const f = result.fix;
      const parts = [
        `Celestial fix from ${ctx.sights} sight${ctx.sights === 1 ? '' : 's'}, solved by SkyFix Lab (unique fix).`,
        `Position uncertainty, 1 sigma: north ${m(f.sigma_north_m)} (${nm(f.sigma_north_m)}), east ${m(f.sigma_east_m)} (${nm(f.sigma_east_m)}).`,
        f.ellipse95
          ? `95 % ellipse (${ELLIPSE_MODEL}): ${m(f.ellipse95.semi_major_m)} by ${m(f.ellipse95.semi_minor_m)}, major axis ${f.ellipse95.orientation_deg.toFixed(0)} deg from true north.`
          : `No 95 % ellipse: ${f.ellipse_suppressed_reason ?? 'suppressed'}.`,
      ];
      if (f.clock_sigma_east_m > 0) parts.push(`Of the east uncertainty, ${m(f.clock_sigma_east_m)} comes from the stated clock uncertainty.`);
      if (f.prior) parts.push(`A prior of ${f.prior.sigma_nm} NM influenced this fix: it moved it ${m(f.prior.shift_m)}.`);
      if (f.shared_bias_arcmin !== null) parts.push(`A shared altitude bias of ${f.shared_bias_arcmin.toFixed(2)}' was estimated.`);
      if (!f.converged) parts.push('The solver did not converge: treat the position as provisional.');
      parts.push(`Chi-square ${f.chi2.toFixed(2)} with ${f.dof} degree${f.dof === 1 ? '' : 's'} of freedom.`);
      if (result.alternatives.length) {
        parts.push(`${result.alternatives.length} other minimum${result.alternatives.length === 1 ? ' was' : 'a were'} rejected (nearest by a chi-square gap of ${result.alternatives[0]!.delta_chi2_from_best.toFixed(1)}).`);
      }
      return {
        ok: true,
        waypoints: [
          {
            lat_deg: f.position.lat_deg,
            lon_deg: f.position.lon_deg,
            name: 'Celestial fix',
            desc: parts.join(' ') + tail(ctx),
            time: ctx.time,
            type: 'celestial fix',
          },
        ],
      };
    }
    case 'ambiguous': {
      const n = result.candidates.length;
      return {
        ok: true,
        waypoints: result.candidates.map((c, i) => ({
          lat_deg: c.position.lat_deg,
          lon_deg: c.position.lon_deg,
          name: `Ambiguous fix, candidate ${String.fromCharCode(65 + i)}`,
          desc:
            `Candidate ${String.fromCharCode(65 + i)} of ${n}: the ${ctx.sights} sights fit it and the other candidate${n > 2 ? 's' : ''} equally well ` +
            `(chi-square ${c.chi2.toFixed(2)}, ${c.delta_chi2_from_best.toFixed(2)} from the best). No candidate is preferred and no uncertainty ellipse exists.` +
            tail(ctx),
          time: ctx.time,
          type: 'ambiguous celestial fix candidate',
        })),
      };
    }
    case 'underdetermined':
      return { ok: false, reason: `No position to export: the result is underdetermined (${result.reason}).` };
    case 'failed':
      return { ok: false, reason: `No position to export: the solve failed (${result.reason}).` };
  }
}

/** A noon sight's waypoint when it has a longitude. */
export function noonWaypoints(result: NoonSightResult, ctx: GpxContext): GpxPlan {
  if (!result.longitude) {
    return {
      ok: false,
      reason: 'No waypoint: this noon sight gives a latitude only (one altitude cannot time the peak), and a waypoint needs a longitude.',
    };
  }
  const lat = result.latitude;
  const lon = result.longitude;
  const desc =
    `Noon sight of the ${result.body} from ${result.n_sights} sight${result.n_sights === 1 ? '' : 's'} (${result.method.replace(/_/g, ' ')}). ` +
    `Latitude uncertainty ${lat.sigma_arcmin.toFixed(2)}' (${lat.sigma_arcmin.toFixed(2)} NM), 1 sigma. ` +
    `Longitude uncertainty ${lon.sigma_arcmin.toFixed(2)}' of longitude (${lon.sigma_nm.toFixed(2)} NM east-west), 1 sigma: ` +
    'the longitude rests on the time of a flat-topped peak and is far weaker than the latitude.' +
    tail(ctx);
  return {
    ok: true,
    waypoints: [
      {
        lat_deg: lat.lat_deg,
        lon_deg: lon.lon_deg,
        name: `Noon position (${result.body})`,
        desc,
        time: result.meridian_passage?.utc ?? ctx.time,
        type: 'noon sight',
      },
    ],
  };
}

/** A GPX 1.1 document. */
export function gpxDocument(doc: GpxDocument): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SkyFix Lab (simulation and analysis workbench; not a navigation instrument)" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    `    <name>${escapeXml(doc.name)}</name>`,
    `    <desc>${escapeXml(doc.desc)}</desc>`,
    `    <time>${escapeXml(doc.time)}</time>`,
    '  </metadata>',
  ];
  for (const w of doc.waypoints) {
    lines.push(`  <wpt lat="${coord(w.lat_deg)}" lon="${coord(w.lon_deg)}">`);
    if (w.time) lines.push(`    <time>${escapeXml(w.time)}</time>`);
    lines.push(`    <name>${escapeXml(w.name)}</name>`);
    lines.push(`    <desc>${escapeXml(w.desc)}</desc>`);
    lines.push('    <sym>Waypoint</sym>');
    lines.push(`    <type>${escapeXml(w.type)}</type>`);
    lines.push('  </wpt>');
  }
  lines.push('</gpx>');
  return `${lines.join('\n')}\n`;
}

/** A file name from a session name: letters, digits and dashes only. */
export function fileStem(name: string, fallback = 'session'): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return stem || fallback;
}
