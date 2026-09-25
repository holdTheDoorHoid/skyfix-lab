/**
 * CONVENIENCE CSV, for the browser only.
 *
 * `skyfix_core::session::{to_csv, from_csv}` is the canonical parser and the one the
 * CLI and the fixtures use. This copy exists so the Observations view can import and
 * export a spreadsheet without a round trip through the core, and it deliberately
 * accepts less: unknown columns are ignored, and anything it cannot make sense of is
 * reported as a message rather than guessed at. Always re-import through the core
 * before trusting a file.
 *
 * Shape: `#`-prefixed `key,value` lines carry the session-level fields; then one header
 * row and one row per observation.
 */

import type { AltitudeKind, IndexErrorLogEntry, Limb, Observation, Session, WatchLogEntry } from './types.js';
import { horizonLabel, parseHorizonLabel, SESSION_SCHEMA } from './types.js';

export const CSV_COLUMNS = [
  'id',
  'body',
  'utc',
  'altitude_deg',
  'altitude_kind',
  'sigma_arcmin',
  'limb',
  'horizon',
  'gha_deg',
  'dec_deg',
  'semidiameter_arcmin',
  'horizontal_parallax_arcmin',
  'notes',
] as const;

function quote(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Split one CSV line, honouring double-quoted fields with embedded commas. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = false;
      } else current += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out;
}

export function toCsv(session: Session): string {
  const ap = session.observer.assumed_position;
  const role = session.observer.assumed_position_role;
  const header = [
    ['schema', session.schema],
    ['meta.name', session.meta.name],
    ['meta.notes', session.meta.notes],
    ['meta.kind', session.meta.kind],
    ['observer.height_of_eye_m', String(session.observer.height_of_eye_m)],
    ['observer.pressure_hpa', String(session.observer.pressure_hpa)],
    ['observer.temperature_c', String(session.observer.temperature_c)],
    ['observer.assumed_position_lat_deg', ap ? String(ap.lat_deg) : ''],
    ['observer.assumed_position_lon_deg', ap ? String(ap.lon_deg) : ''],
    ['observer.assumed_position_role', role.role],
    ['observer.assumed_position_sigma_nm', role.role === 'prior' ? String(role.sigma_nm) : ''],
    ['instrument.name', session.instrument.name],
    ['instrument.index_correction_arcmin', String(session.instrument.index_correction_arcmin)],
    ['instrument.horizon', horizonLabel(session.instrument.horizon)],
    ['clock.uncertainty_s', String(session.clock.uncertainty_s)],
    ['clock.correction_s', String(session.clock.correction_s)],
    // UT1 − UTC (expansion programme): written only when given, as the core does.
    ...(typeof session.clock.dut1_s === 'number' ? [['clock.dut1_s', String(session.clock.dut1_s)]] : []),
    // The error logs (CONVENTIONS 10), one JSON array each, only when they have entries.
    ...(session.instrument.index_error_log?.length
      ? [['instrument.index_error_log', JSON.stringify(session.instrument.index_error_log)]]
      : []),
    ...(session.clock.watch_log?.length ? [['clock.watch_log', JSON.stringify(session.clock.watch_log)]] : []),
  ]
    .map(([k, v]) => `# ${quote(k!)},${quote(v!)}`)
    .join('\n');

  const rows = session.observations.map((o) =>
    [
      o.id,
      o.body,
      o.utc,
      String(o.altitude_deg),
      o.altitude_kind,
      String(o.sigma_arcmin),
      o.limb,
      o.horizon ? horizonLabel(o.horizon) : '',
      o.geocentric ? String(o.geocentric.gha_deg) : '',
      o.geocentric ? String(o.geocentric.dec_deg) : '',
      o.geocentric ? String(o.geocentric.semidiameter_arcmin) : '',
      o.geocentric ? String(o.geocentric.horizontal_parallax_arcmin) : '',
      o.notes,
    ]
      .map(quote)
      .join(','),
  );

  return [header, CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

const ALTITUDE_KINDS: AltitudeKind[] = ['sextant_hs', 'apparent_ha', 'observed_ho'];
const LIMBS: Limb[] = ['center', 'lower', 'upper'];

/** `clock.dut1_s`: a number, or absent/empty for "automatic" (the base's value, if any). */
function dut1Of(value: string | undefined, base: number | null | undefined): { dut1_s?: number | null } {
  if (value === undefined) return base === undefined ? {} : { dut1_s: base };
  const t = value.trim();
  if (t === '') return { dut1_s: null };
  const v = Number(t);
  return Number.isFinite(v) ? { dut1_s: v } : { dut1_s: null };
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface CsvParseResult {
  session: Session;
  /** Plain-language notes about anything that was defaulted or ignored. */
  messages: string[];
}

export function fromCsv(text: string, base: Session): CsvParseResult {
  const messages: string[] = [];
  const meta = new Map<string, string>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('#')) {
      const parts = splitCsvLine(line.trimStart().replace(/^#\s*/, ''));
      if (parts.length >= 1) meta.set(parts[0]!.trim(), (parts[1] ?? '').trim());
    } else dataLines.push(line);
  }
  if (dataLines.length === 0) {
    return { session: { ...base, observations: [] }, messages: ['no observation rows found'] };
  }

  const header = splitCsvLine(dataLines[0]!).map((h) => h.trim());
  const index = (name: string): number => header.indexOf(name);
  for (const column of header) {
    if (!(CSV_COLUMNS as readonly string[]).includes(column)) {
      messages.push(`ignored unknown column "${column}"`);
    }
  }
  if (index('altitude_deg') < 0) messages.push('no altitude_deg column: altitudes default to 0');

  const observations: Observation[] = [];
  for (let r = 1; r < dataLines.length; r++) {
    const cells = splitCsvLine(dataLines[r]!);
    const get = (name: string): string | undefined => {
      const i = index(name);
      return i < 0 ? undefined : cells[i];
    };
    const kindRaw = (get('altitude_kind') ?? '').trim();
    const kind = ALTITUDE_KINDS.includes(kindRaw as AltitudeKind)
      ? (kindRaw as AltitudeKind)
      : 'sextant_hs';
    if (kindRaw && kind !== kindRaw) messages.push(`row ${r}: unknown altitude_kind "${kindRaw}"`);
    const limbRaw = (get('limb') ?? '').trim();
    const limb = LIMBS.includes(limbRaw as Limb) ? (limbRaw as Limb) : 'center';
    const horizonRaw = (get('horizon') ?? '').trim();
    const horizon = parseHorizonLabel(horizonRaw);
    const gha = get('gha_deg');
    const dec = get('dec_deg');
    const hasDirection = gha !== undefined && gha.trim() !== '' && dec !== undefined && dec.trim() !== '';
    observations.push({
      id: (get('id') ?? `obs-${r}`).trim() || `obs-${r}`,
      body: (get('body') ?? '').trim(),
      utc: (get('utc') ?? '').trim(),
      altitude_deg: num(get('altitude_deg'), 0),
      altitude_kind: kind,
      sigma_arcmin: num(get('sigma_arcmin'), 1),
      limb,
      horizon,
      geocentric: hasDirection
        ? {
            gha_deg: num(gha, 0),
            dec_deg: num(dec, 0),
            semidiameter_arcmin: num(get('semidiameter_arcmin'), 0),
            horizontal_parallax_arcmin: num(get('horizontal_parallax_arcmin'), 0),
          }
        : null,
      notes: (get('notes') ?? '').trim(),
    });
  }

  /** An error log from its JSON header line, else the base session's; absent when empty. */
  function logField<T>(key: string, name: string, fallback: T[] | undefined): Record<string, T[]> {
    const raw = meta.get(key);
    let log = fallback;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) log = parsed as T[];
        else messages.push(`${key} is not a JSON array; ignored`);
      } catch {
        messages.push(`${key} is not valid JSON; ignored`);
      }
    }
    return log && log.length > 0 ? { [name]: log } : {};
  }

  const roleName = meta.get('observer.assumed_position_role') ?? base.observer.assumed_position_role.role;
  const sigmaNm = num(meta.get('observer.assumed_position_sigma_nm'), 20);
  const apLat = meta.get('observer.assumed_position_lat_deg');
  const apLon = meta.get('observer.assumed_position_lon_deg');
  const kindRaw = meta.get('meta.kind');
  if (kindRaw && kindRaw !== 'simulated' && kindRaw !== 'real') {
    messages.push(`unknown meta.kind "${kindRaw}"; kept ${base.meta.kind}`);
  }

  const session: Session = {
    schema: meta.get('schema') || SESSION_SCHEMA,
    meta: {
      name: meta.get('meta.name') ?? base.meta.name,
      notes: meta.get('meta.notes') ?? base.meta.notes,
      kind: kindRaw === 'real' ? 'real' : kindRaw === 'simulated' ? 'simulated' : base.meta.kind,
    },
    observer: {
      height_of_eye_m: num(meta.get('observer.height_of_eye_m'), base.observer.height_of_eye_m),
      pressure_hpa: num(meta.get('observer.pressure_hpa'), base.observer.pressure_hpa),
      temperature_c: num(meta.get('observer.temperature_c'), base.observer.temperature_c),
      assumed_position:
        apLat && apLon ? { lat_deg: num(apLat, 0), lon_deg: num(apLon, 0) } : base.observer.assumed_position,
      assumed_position_role:
        roleName === 'prior'
          ? { role: 'prior', sigma_nm: sigmaNm }
          : roleName === 'disabled'
            ? { role: 'disabled' }
            : { role: 'initializer' },
    },
    instrument: {
      name: meta.get('instrument.name') ?? base.instrument.name,
      index_correction_arcmin: num(
        meta.get('instrument.index_correction_arcmin'),
        base.instrument.index_correction_arcmin,
      ),
      horizon: parseHorizonLabel(meta.get('instrument.horizon') ?? '') ?? base.instrument.horizon,
      ...logField<IndexErrorLogEntry>('instrument.index_error_log', 'index_error_log', base.instrument.index_error_log),
    },
    clock: {
      uncertainty_s: num(meta.get('clock.uncertainty_s'), base.clock.uncertainty_s),
      correction_s: num(meta.get('clock.correction_s'), base.clock.correction_s),
      ...dut1Of(meta.get('clock.dut1_s'), base.clock.dut1_s),
      ...logField<WatchLogEntry>('clock.watch_log', 'watch_log', base.clock.watch_log),
    },
    observations,
  };

  return { session, messages };
}
