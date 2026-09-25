import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, fromCsv, splitCsvLine, toCsv } from '../src/csv.js';
import { emptySession } from '../src/api/mock.js';
import type { Session } from '../src/types.js';

function sample(): Session {
  const session = emptySession('Philadelphia three-star');
  session.meta.kind = 'real';
  session.meta.notes = 'hand-held, calm sea';
  session.observer.height_of_eye_m = 2.5;
  session.observer.assumed_position = { lat_deg: 40, lon_deg: -75 };
  session.observer.assumed_position_role = { role: 'prior', sigma_nm: 20 };
  session.instrument = { name: 'Astra IIIB', index_correction_arcmin: -2, horizon: 'sea' };
  session.clock = { uncertainty_s: 1.5, correction_s: -0.4 };
  session.observations = [
    {
      id: 'obs-1',
      body: 'Vega',
      utc: '2026-10-01T01:30:00Z',
      altitude_deg: 61.2345,
      altitude_kind: 'sextant_hs',
      sigma_arcmin: 1,
      limb: 'center',
      horizon: null,
      geocentric: {
        gha_deg: 123.4567,
        dec_deg: 38.789,
        semidiameter_arcmin: 0,
        horizontal_parallax_arcmin: 0,
      },
      notes: 'steady, clear',
    },
    {
      id: 'obs-2',
      body: 'Sun',
      utc: '2026-10-01T01:34:00Z',
      altitude_deg: 43.887,
      altitude_kind: 'observed_ho',
      sigma_arcmin: 0.8,
      limb: 'lower',
      horizon: 'artificial_reflected',
      geocentric: null,
      notes: 'note, with a comma',
    },
  ];
  return session;
}

describe('CSV line splitting', () => {
  it('handles quoted fields with commas and doubled quotes', () => {
    expect(splitCsvLine('a,"b,c","say ""hi""",d')).toEqual(['a', 'b,c', 'say "hi"', 'd']);
  });

  it('keeps empty trailing fields', () => {
    expect(splitCsvLine('a,,')).toEqual(['a', '', '']);
  });
});

describe('CSV round trip', () => {
  it('writes a # header block and one row per observation', () => {
    const csv = toCsv(sample());
    const lines = csv.trim().split('\n');
    expect(lines.filter((l) => l.startsWith('#')).length).toBeGreaterThan(10);
    const headerRow = lines.find((l) => !l.startsWith('#'))!;
    expect(headerRow).toBe(CSV_COLUMNS.join(','));
    expect(lines[lines.length - 1]).toContain('obs-2');
  });

  it('quotes a field that contains a comma', () => {
    expect(toCsv(sample())).toContain('"note, with a comma"');
  });

  it('recovers the session it wrote', () => {
    const original = sample();
    const { session, messages } = fromCsv(toCsv(original), emptySession());
    expect(messages).toEqual([]);
    expect(session.meta).toEqual(original.meta);
    expect(session.observer).toEqual(original.observer);
    expect(session.instrument).toEqual(original.instrument);
    expect(session.clock).toEqual(original.clock);
    expect(session.observations).toEqual(original.observations);
  });

  it('keeps a missing geocentric direction missing rather than inventing zeros', () => {
    const { session } = fromCsv(toCsv(sample()), emptySession());
    expect(session.observations[1]!.geocentric).toBeNull();
    expect(session.observations[0]!.geocentric?.gha_deg).toBeCloseTo(123.4567, 9);
  });

  it('preserves a per-sight horizon override and the inherit case', () => {
    const { session } = fromCsv(toCsv(sample()), emptySession());
    expect(session.observations[0]!.horizon).toBeNull();
    expect(session.observations[1]!.horizon).toBe('artificial_reflected');
  });
});

describe('CSV convenience parsing of imperfect input', () => {
  it('reports unknown columns instead of failing', () => {
    const csv = ['id,body,altitude_deg,phase_of_moon', 'obs-1,Vega,61.2,waxing'].join('\n');
    const { session, messages } = fromCsv(csv, emptySession());
    expect(messages.join(' ')).toContain('phase_of_moon');
    expect(session.observations).toHaveLength(1);
    expect(session.observations[0]!.altitude_deg).toBeCloseTo(61.2, 9);
  });

  it('falls back to a default for an unknown enum value and says so', () => {
    const csv = ['id,body,altitude_deg,altitude_kind', 'obs-1,Vega,61.2,corrected'].join('\n');
    const { session, messages } = fromCsv(csv, emptySession());
    expect(session.observations[0]!.altitude_kind).toBe('sextant_hs');
    expect(messages.join(' ')).toContain('corrected');
  });

  it('supplies ids for rows that have none', () => {
    const csv = ['body,altitude_deg', 'Vega,61.2', 'Altair,43.9'].join('\n');
    const { session } = fromCsv(csv, emptySession());
    expect(session.observations.map((o) => o.id)).toEqual(['obs-1', 'obs-2']);
  });

  it('reports an empty file rather than producing a broken session', () => {
    const { session, messages } = fromCsv('# schema,skyfix.session/1\n', emptySession());
    expect(session.observations).toEqual([]);
    expect(messages).toContain('no observation rows found');
  });

  it('defaults a non-numeric altitude to zero instead of NaN', () => {
    const csv = ['id,altitude_deg', 'obs-1,not-a-number'].join('\n');
    const { session } = fromCsv(csv, emptySession());
    expect(session.observations[0]!.altitude_deg).toBe(0);
  });
});

describe('clock.dut1_s (expansion programme)', () => {
  it('is written only when given and round-trips; empty means automatic', () => {
    const plain = sample();
    expect(toCsv(plain)).not.toMatch(/dut1_s/);
    const { session: back } = fromCsv(toCsv(plain), emptySession(''));
    expect(back.clock.dut1_s).toBeUndefined();
    const given = sample();
    given.clock = { ...given.clock, dut1_s: -0.2 };
    const csv = toCsv(given);
    expect(csv).toMatch(/# clock\.dut1_s,-0\.2/);
    expect(fromCsv(csv, emptySession('')).session.clock.dut1_s).toBe(-0.2);
    expect(fromCsv(csv.replace('# clock.dut1_s,-0.2', '# clock.dut1_s,'), emptySession('')).session.clock.dut1_s).toBeNull();
  });
});
