/**
 * Scales and ticks for the hand-built SVG charts. OWNER: charts agent. Pure functions.
 */

export interface LinearScale {
  (value: number): number;
  invert(pixel: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

/** Map `domain` linearly onto `range` (either may be reversed). A zero-width domain maps to the range start. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const scale = ((v: number) => r0 + (v - d0) * k) as LinearScale;
  scale.invert = (p: number) => (k === 0 ? d0 : d0 + (p - r0) / k);
  Object.defineProperty(scale, 'domain', { value: [d0, d1] as const });
  Object.defineProperty(scale, 'range', { value: [r0, r1] as const });
  return scale;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The step from `candidates` (ascending) that gives at most `maxTicks` intervals over
 * `span`; the largest candidate when none does.
 */
export function pickStep(span: number, maxTicks: number, candidates: readonly number[]): number {
  for (const step of candidates) if (span / step <= maxTicks) return step;
  return candidates[candidates.length - 1] ?? span;
}

/** Multiples of `step` from `min` to `max` inclusive (with a little tolerance for rounding). */
export function ticks(min: number, max: number, step: number): number[] {
  if (!(step > 0) || !(max >= min)) return [];
  const eps = step * 1e-9;
  const out: number[] = [];
  const first = Math.ceil((min - eps) / step);
  for (let k = first; k * step <= max + eps; k += 1) {
    const v = Number((k * step).toPrecision(12));
    out.push(v === 0 ? 0 : v);
  }
  return out;
}

/** Hour steps that read well on a clock axis. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 12] as const;

/** Round to 0.01 px: keeps path strings short without visible error. */
export function px(value: number): number {
  return Math.round(value * 100) / 100;
}
