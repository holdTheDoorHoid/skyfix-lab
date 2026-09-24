/**
 * Numbers as the map shows them. OWNER: map agent. Pure; tested in map-format.test.ts.
 */

import type { AngleFormat } from '../state.js';

const DEG = '°';
const PRIME = '′';
const DOUBLE_PRIME = '″';

/** An angle in the chosen style: `41° 17.3′`, `41° 17′ 18″` or `41.29°`. Negative values get a minus sign. */
export function formatAngle(value: number, format: AngleFormat): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '−' : '';
  const abs = Math.abs(value);
  switch (format) {
    case 'decimal':
      return `${sign}${abs.toFixed(2)}${DEG}`;
    case 'dms': {
      let d = Math.floor(abs);
      let m = Math.floor((abs - d) * 60);
      let s = Math.round(((abs - d) * 60 - m) * 60);
      if (s === 60) {
        s = 0;
        m += 1;
      }
      if (m === 60) {
        m = 0;
        d += 1;
      }
      return `${sign}${d}${DEG} ${String(m).padStart(2, '0')}${PRIME} ${String(s).padStart(2, '0')}${DOUBLE_PRIME}`;
    }
    case 'dm': {
      let d = Math.floor(abs);
      let m = Math.round((abs - d) * 600) / 10;
      if (m >= 60) {
        m -= 60;
        d += 1;
      }
      return `${sign}${d}${DEG} ${m.toFixed(1).padStart(4, '0')}${PRIME}`;
    }
  }
}

/** A true bearing as navigators write it: three digits, `051°` (`051.3°` with `digits`). */
export function formatBearing(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  let v = ((value % 360) + 360) % 360;
  if (Number(v.toFixed(digits)) >= 360) v = 0;
  const [i, f] = v.toFixed(digits).split('.');
  return `${(i ?? '0').padStart(3, '0')}${f ? `.${f}` : ''}${DEG}`;
}

/** A distance with a sensible number of digits: `0.42`, `8.4`, `312`, `3 012`. */
export function formatDistance(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs < 1 ? 2 : abs < 100 ? 1 : 0;
  const text = abs.toFixed(digits);
  const [i, f] = text.split('.');
  // A thin space groups thousands (unambiguous in every locale).
  const grouped = (i ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value < 0 ? '−' : ''}${grouped}${f ? `.${f}` : ''}`;
}

export const NM_TO_KM = 1.852;
export const NM_TO_MI = 1.852 / 1.609344;
